/**
 * event-bus.ts — 遥测审计总线 · 结构化事件总线（基础设施之一）
 *
 * 为「全部模块世界性升级」提供统一的事件骨干：后续各模块（含 index.ts 接线）
 * 只面向本文件的事件信封与发布/订阅接口，不再各自造事件格式。
 *
 * 能力口径：
 * - 类型化事件信封 {type, source, ts, seq, payload, isFinal}
 * - 发布/订阅 + 通配订阅：模式按 `.` 分段，`*` 精确匹配一个段
 *   （`sig.*` 命中 `sig.spawn`，但不命中更深的 `sig.spawn.retry`）
 * - 总线级环形缓冲：容量可配；满时弃最旧并计数（bufferDropCount）
 * - seq 总线级单调递增（从 1 起，每发布 +1）；缺口检测基于缓冲内容
 *   扫描被环形缓冲丢弃的 seq 区间（并对「非单调」这一内部不变量违约显式 throw）
 * - 背压口径（慢订阅者，每订阅者独立有界队列）：
 *     · 队列未满 → 正常入队；
 *     · 队列满且新事件非终态 → 丢弃新事件（droppedIntermediate 计数）；
 *     · 队列满且新事件 isFinal → 逐出最旧非终态为其腾位（evictedForFinal 计数），
 *       即「终态必达、中间可丢」；仅当队列全为终态且满载时才逐出最旧终态
 *       （droppedFinal 计数——有界内存优先，显式暴露而非静默）。
 * - 注入时钟：全模块不使用 Date.now / Math.random；默认手动时钟从 0 起，
 *   同一时钟与同一调用序列产生逐位一致的输出（确定性）。
 *
 * R4 二期深化（缺省零漂移——全部为 opt-in 增量）：
 * - 确定性按率采样器 DeterministicRateSampler：缩放整数 Bresenham 均衡决策，
 *   前 n 次调用恰好保留 ⌊n·rate⌋ 条（纯整数运算可证明），估计器
 *   estimateTotal = kept/rate，误差严格 < 1/rate
 * - 采样策略 SamplingController：按事件类型的规则集（头部 headKeep 条全保留
 *   + 尾部按率采样）+ 错误事件全保留（错误必达，缺省匹配 type 某段为
 *   'error'/以 'error' 开头/为 'fatal'，可注入自定义 errorMatcher）；
 *   分层计数（错误层/头部层/尾部层）与真实计数的估计器还原（分层估计
 *   Ñ = 错误保留 + 头部保留 + 尾部保留/rate，误差有界 < Σ1/rate）
 * - 总线采样集成（TelemetryBusOptions.sampling，opt-in）：被采样丢弃的
 *   发布不占 seq、不进环形缓冲、不投递订阅（stats().samplingDropped 计数；
 *   保留事件信封带 sampled:true，丢弃信封 sampled:false 且 seq 为当时
 *   lastSeq——故 detectBufferGaps 仍只报告真实的缓冲丢弃缺口）
 * - 缓冲双门限保留（TelemetryBusOptions.bufferMaxAgeMs，opt-in）：容量
 *   弃最旧（既有 bufferDropCount）之外，按时长裁最旧（bufferExpiredCount
 *   可观测；pruneBuffer() 显式裁剪返回本次裁剪数）
 *
 * 零依赖：纯内存数据结构、零 I/O（导出只返回数据）；入参显式 throw。
 */

// ─────────────────────────── 注入时钟 ───────────────────────────

/** 注入时钟契约：全遥测模块的时间唯一来源（禁止 Date.now） */
export interface TelemetryClock {
  /** 当前时刻（毫秒数；语义由注入方定义，本模块只要求有限数） */
  now(): number;
}

/** 手动时钟：测试与确定性回放的默认实现（set/advance 显式驱动） */
export interface ManualClock extends TelemetryClock {
  now(): number;
  /** 直接设定当前时刻（必须有限） */
  set(ms: number): void;
  /** 前进 delta（必须有限，可为负以便测试乱序守卫） */
  advance(delta: number): void;
}

/** 创建手动时钟（默认从 0 起）：总线/审计/跟踪的默认时钟 */
export function createManualClock(startAt = 0): ManualClock {
  let current = startAt;
  if (!Number.isFinite(startAt)) {
    throw new TypeError(`createManualClock: startAt 必须为有限数，收到 ${String(startAt)}`);
  }
  return {
    now: () => current,
    set: (ms: number): void => {
      if (!Number.isFinite(ms)) throw new TypeError(`ManualClock.set: 必须为有限数，收到 ${String(ms)}`);
      current = ms;
    },
    advance: (delta: number): void => {
      if (!Number.isFinite(delta)) throw new TypeError(`ManualClock.advance: 必须为有限数，收到 ${String(delta)}`);
      current += delta;
    },
  };
}

// ─────────────────────────── 事件信封 ───────────────────────────

/** 结构化事件信封：全部模块统一的事件形状（字段只读，发布后不可变） */
export interface TelemetryEventEnvelope<P = unknown> {
  /** 事件类型，`.` 分段命名（如 `sig.spawn`、`plan.commit`） */
  readonly type: string;
  /** 事件来源模块名（如 `sentinel`、`goal-engine`） */
  readonly source: string;
  /** 事件时间戳（来自注入时钟） */
  readonly ts: number;
  /** 总线级单调序号（从 1 起；跨所有 type 全局递增） */
  readonly seq: number;
  /** 事件负载（任意 JSON 友好数据） */
  readonly payload: P;
  /** 终态标记：背压下必达（队列满时为终态逐出中间事件） */
  readonly isFinal: boolean;
  /**
   * 采样标记（仅当总线启用采样选项时存在）：
   * true = 保留（已分配 seq / 入缓冲 / 投递）；false = 被采样丢弃
   * （不占 seq、不入缓冲、不投递，seq 字段为当时 lastSeq，未发布过为 0）。
   * 未启用采样时本字段缺席（缺省零漂移）。
   */
  readonly sampled?: boolean;
}

/** 发布选项 */
export interface PublishOptions {
  /** 标记为终态事件（背压必达口径） */
  isFinal?: boolean;
}

// ─────────────────────────── 名称与模式校验 ───────────────────────────

/** 校验事件类型名：非空、`.` 分段且每段非空 */
function assertEventTypeName(kind: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${kind}: 必须为非空字符串，收到 ${String(value)}`);
  }
  const segments = value.split('.');
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i] === undefined || segments[i].length === 0) {
      throw new TypeError(`${kind}: 不允许空段（收到的第 ${i + 1} 段为空）：'${value}'`);
    }
  }
}

/**
 * 通配匹配：模式与事件类型按 `.` 分段逐段比较，段数必须相等；
 * `*` 匹配恰好一个段（不跨段）。纯函数，供直接测试与复用。
 */
export function eventPatternMatches(pattern: string, type: string): boolean {
  assertEventTypeName('eventPatternMatches(pattern)', pattern);
  assertEventTypeName('eventPatternMatches(type)', type);
  const p = pattern.split('.');
  const t = type.split('.');
  if (p.length !== t.length) return false;
  for (let i = 0; i < p.length; i += 1) {
    const seg = p[i];
    if (seg === undefined || seg === '*') continue;
    if (seg !== t[i]) return false;
  }
  return true;
}

/** 校验订阅/采样规则的模式：合法类型名 + '*' 只能独占一段 */
function assertPattern(pattern: string, api: string): void {
  assertEventTypeName(api, pattern);
  for (const seg of pattern.split('.')) {
    if (seg.includes('*') && seg !== '*') {
      throw new TypeError(`${api}: 通配符 '*' 只能独占一段，收到 '${pattern}'`);
    }
  }
}

// ─────────────────────────── 确定性按率采样器 ───────────────────────────

/** 采样器统计 */
export interface RateSamplerStats {
  /** 目标采样率 (0,1] */
  readonly rate: number;
  /** 已决策次数 */
  readonly seen: number;
  /** 已保留次数（恒等于 ⌊seen × rate⌉ 下取整——整数 Bresenham 可证明） */
  readonly kept: number;
}

/**
 * DeterministicRateSampler — 确定性按率采样决策器（缩放整数 Bresenham 均衡）。
 *
 * 无随机源：第 i 次决策保留 ⇔ 误差累加器跨过阈值。纯整数运算（scale=1e9），
 * 可证明不变量：任意 n 次决策后 kept = ⌊n·num/scale⌋ 恰好成立（num/scale=rate），
 * 因而在任意前缀上保留条数都均匀分布（不依赖随机数的「均衡采样」）。
 *
 * 估计器：estimateTotal() = kept × scale / num = kept / rate；
 * 与真实总数的误差 = |kept − n·rate|/rate < 1/rate（严格界，可证明）。
 */
export class DeterministicRateSampler {
  private static readonly SCALE = 1_000_000_000;
  private readonly num: number;
  private acc = 0;
  private seenCount = 0;
  private keptCount = 0;

  constructor(rate: number) {
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 1) {
      throw new RangeError(`DeterministicRateSampler: rate 必须为 (0,1] 的有限数，收到 ${String(rate)}`);
    }
    const num = Math.round(rate * DeterministicRateSampler.SCALE);
    if (num < 1 || num > DeterministicRateSampler.SCALE || Math.abs(rate - num / DeterministicRateSampler.SCALE) > 1e-12) {
      throw new RangeError(`DeterministicRateSampler: rate 精度超出 1e-9 缩放口径，收到 ${String(rate)}`);
    }
    this.num = num;
  }

  /** 只读采样率 */
  get rate(): number {
    return this.num / DeterministicRateSampler.SCALE;
  }

  /** 决策一次：true=保留。整数 Bresenham：n 次后恰保留 ⌊n·rate⌋ 条 */
  decide(): boolean {
    this.seenCount += 1;
    this.acc += this.num;
    if (this.acc >= DeterministicRateSampler.SCALE) {
      this.acc -= DeterministicRateSampler.SCALE;
      this.keptCount += 1;
      return true;
    }
    return false;
  }

  /** 估计真实总数 = kept / rate（与真实值误差严格 < 1/rate） */
  estimateTotal(): number {
    return (this.keptCount * DeterministicRateSampler.SCALE) / this.num;
  }

  /** 统计读数 */
  stats(): RateSamplerStats {
    return { rate: this.rate, seen: this.seenCount, kept: this.keptCount };
  }
}

// ─────────────────────────── 采样策略 ───────────────────────────

/** 采样决策候选：发布时的可见面（不含 ts/seq——采样先于信封定稿） */
export interface SamplingCandidate<P = unknown> {
  readonly type: string;
  readonly source: string;
  readonly payload: P;
  readonly isFinal: boolean;
}

/** 单条采样规则：命中 pattern（与订阅同语义的 `.` 分段 + 独段 `*` 通配） */
export interface SamplingRule {
  /** 事件类型模式（与 subscribe 相同的段级通配语义） */
  readonly pattern: string;
  /** 头部全保留条数（≥0 整数，缺省 0）：该类型前 headKeep 条不采样 */
  readonly headKeep?: number;
  /** 尾部采样率 (0,1]（缺省 1 = 尾部也全保留） */
  readonly rate?: number;
}

/** 采样控制器选项 */
export interface SamplingControllerOptions {
  /** 规则集（按序首条命中生效；可空——只剩 defaultRate 与错误必达） */
  readonly rules?: readonly SamplingRule[];
  /** 错误判定（返回 true → 全保留即「错误必达」）。抛错则向上传播。 */
  readonly errorMatcher?: (candidate: SamplingCandidate) => boolean;
  /** 未命中任何规则的类型采样率 (0,1]（缺省 1 = 不采样） */
  readonly defaultRate?: number;
}

/** 单类型采样计数（分层：错误层全保留 / 头部层全保留 / 尾部层按率） */
export interface TypeSamplingStats {
  readonly type: string;
  /** 命中的规则 pattern；未命中任何规则为 '(default)' */
  readonly matchedPattern: string;
  readonly rate: number;
  readonly headKeep: number;
  /** 该类型被决策（publish）总数 */
  readonly seen: number;
  /** 该类型被保留总数 = errorKept + headKept + tailKept */
  readonly kept: number;
  readonly errorSeen: number;
  readonly errorKept: number;
  readonly headSeen: number;
  readonly headKept: number;
  readonly tailSeen: number;
  readonly tailKept: number;
  /** 真实总数估计：errorKept + headKept + tailKept / rate（误差 < 1/rate） */
  readonly estimatedTotal: number;
}

/** 采样总览（跨全部类型） */
export interface SamplingSummary {
  /** 决策总数（= 全部 publish 候选） */
  readonly seen: number;
  readonly kept: number;
  readonly dropped: number;
  /** 全类型估计总数之和 */
  readonly estimatedTotal: number;
  /** 决策真实总数（控制器在源头可见，用于验证估计误差） */
  readonly trueSeen: number;
  /** 估计误差严格界：Σ（有尾部采样的类型 1/rate） */
  readonly estimateErrorBound: number;
}

/**
 * SamplingController — 高频事件采样策略（头部全保留 + 尾部按率 + 错误必达）。
 *
 * 分层决策（每事件恰好归入一层，不重复计数）：
 * ① 错误层：errorMatcher 命中 → 全保留；
 * ② 头部层：该类型（按 decide 调用序）前 headKeep 条非错误事件 → 全保留；
 * ③ 尾部层：其余非错误事件 → DeterministicRateSampler 按率确定性采样。
 *
 * 估计器还原：Ñ_type = errorKept + headKept + tailKept/rate；
 * 因尾部 Bresenham 有 tailKept = ⌊n·rate⌋，故 |Ñ_type − seen| < 1/rate。
 * 规则匹配：按 rules 顺序首条命中生效；未命中 → defaultRate（错误层仍生效）。
 */
export class SamplingController {
  private readonly rules: readonly { pattern: string; headKeep: number; rate: number }[];
  private readonly errorMatcher: (candidate: SamplingCandidate) => boolean;
  private readonly defaultRate: number;
  private readonly byType = new Map<string, TypeSamplingState>();

  constructor(options: SamplingControllerOptions = {}) {
    const rules = options.rules ?? [];
    if (!Array.isArray(rules)) {
      throw new TypeError(`SamplingController: rules 必须为数组，收到 ${String(rules)}`);
    }
    this.rules = rules.map((rule, index) => {
      if (rule === null || typeof rule !== 'object') {
        throw new TypeError(`SamplingController: rules[${index}] 必须为对象，收到 ${String(rule)}`);
      }
      assertPattern(rule.pattern, `SamplingController(rules[${index}].pattern)`);
      const headKeep = rule.headKeep ?? 0;
      if (!Number.isInteger(headKeep) || headKeep < 0) {
        throw new RangeError(`SamplingController: rules[${index}].headKeep 必须为 ≥0 的整数，收到 ${String(headKeep)}`);
      }
      const rate = rule.rate ?? 1;
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 1) {
        throw new RangeError(`SamplingController: rules[${index}].rate 必须为 (0,1] 的有限数，收到 ${String(rate)}`);
      }
      return { pattern: rule.pattern, headKeep, rate };
    });
    const defaultRate = options.defaultRate ?? 1;
    if (typeof defaultRate !== 'number' || !Number.isFinite(defaultRate) || defaultRate <= 0 || defaultRate > 1) {
      throw new RangeError(`SamplingController: defaultRate 必须为 (0,1] 的有限数，收到 ${String(defaultRate)}`);
    }
    this.defaultRate = defaultRate;
    this.errorMatcher = options.errorMatcher ?? defaultErrorMatcher;
    if (typeof this.errorMatcher !== 'function') {
      throw new TypeError('SamplingController: errorMatcher 必须为函数');
    }
  }

  /**
   * 决策一次（发布前调用）：true = 保留（继续入总线），false = 采样丢弃。
   * 错误事件（errorMatcher 命中）恒 true——错误必达。
   */
  decide(candidate: SamplingCandidate): boolean {
    assertEventTypeName('SamplingController.decide(type)', candidate.type);
    assertEventTypeName('SamplingController.decide(source)', candidate.source);
    let state = this.byType.get(candidate.type);
    if (state === undefined) {
      const matched = this.rules.find((rule) => eventPatternMatches(rule.pattern, candidate.type));
      state = {
        type: candidate.type,
        matchedPattern: matched?.pattern ?? '(default)',
        rate: matched?.rate ?? this.defaultRate,
        headKeep: matched?.headKeep ?? 0,
        sampler: new DeterministicRateSampler(matched?.rate ?? this.defaultRate),
        seen: 0,
        kept: 0,
        errorSeen: 0,
        errorKept: 0,
        headSeen: 0,
        headKept: 0,
        tailSeen: 0,
        tailKept: 0,
      };
      this.byType.set(candidate.type, state);
    }
    state.seen += 1;
    if (this.errorMatcher(candidate)) {
      state.errorSeen += 1;
      state.errorKept += 1;
      state.kept += 1;
      return true;
    }
    if (state.headSeen < state.headKeep) {
      state.headSeen += 1;
      state.headKept += 1;
      state.kept += 1;
      return true;
    }
    state.tailSeen += 1;
    if (state.sampler.decide()) {
      state.tailKept += 1;
      state.kept += 1;
      return true;
    }
    return false;
  }

  /** 分类型计数（按类型名升序，确定性） */
  typeStats(): TypeSamplingStats[] {
    return [...this.byType.keys()].sort().map((type) => {
      const state = this.byType.get(type) as TypeSamplingState;
      return {
        type: state.type,
        matchedPattern: state.matchedPattern,
        rate: state.rate,
        headKeep: state.headKeep,
        seen: state.seen,
        kept: state.kept,
        errorSeen: state.errorSeen,
        errorKept: state.errorKept,
        headSeen: state.headSeen,
        headKept: state.headKept,
        tailSeen: state.tailSeen,
        tailKept: state.tailKept,
        estimatedTotal: state.errorKept + state.headKept + state.tailKept / state.rate,
      };
    });
  }

  /** 跨类型总览：kept/dropped + 估计总数与误差界（bound 只计发生过尾部决策的类型） */
  summary(): SamplingSummary {
    let seen = 0;
    let kept = 0;
    let estimatedTotal = 0;
    let bound = 0;
    for (const state of this.byType.values()) {
      seen += state.seen;
      kept += state.kept;
      estimatedTotal += state.errorKept + state.headKept + state.tailKept / state.rate;
      if (state.rate < 1 && state.tailSeen > 0) bound += 1 / state.rate;
    }
    return { seen, kept, dropped: seen - kept, estimatedTotal, trueSeen: seen, estimateErrorBound: bound };
  }
}

interface TypeSamplingState {
  readonly type: string;
  readonly matchedPattern: string;
  readonly rate: number;
  readonly headKeep: number;
  readonly sampler: DeterministicRateSampler;
  seen: number;
  kept: number;
  errorSeen: number;
  errorKept: number;
  headSeen: number;
  headKept: number;
  tailSeen: number;
  tailKept: number;
}

/**
 * 缺省错误判定：type 的某一段为 'error' / 以 'error' 开头（如 'job.error'、
 * 'error.oom'）/ 为 'fatal' → 错误（必达）。可用 errorMatcher 覆盖。
 */
function defaultErrorMatcher(candidate: SamplingCandidate): boolean {
  for (const segment of candidate.type.split('.')) {
    if (segment === 'error' || segment.startsWith('error') || segment === 'fatal') return true;
  }
  return false;
}

// ─────────────────────────── 订阅者 ───────────────────────────

/** 订阅统计（背压口径的观测面） */
export interface SubscriptionStats {
  /** 命中该订阅模式的事件总数（入队尝试次数） */
  received: number;
  /** 当前排队未取走的事件数 */
  queued: number;
  /** 队列满时被丢弃的中间（非终态）事件数 */
  droppedIntermediate: number;
  /** 为终态事件腾位被逐出的中间事件数 */
  evictedForFinal: number;
  /** 全终态满载时被逐出的终态事件数（有界内存的最后手段，应恒为 0 除非终态洪峰） */
  droppedFinal: number;
}

/** 订阅句柄：拉取式消费（不注册回调，保证确定性——无回调时序问题） */
export interface EventSubscription {
  readonly id: number;
  readonly pattern: string;
  readonly maxQueue: number;
  /** 当前队列长度 */
  size(): number;
  /** 取出至多 maxCount 条（默认全部），从最旧开始；返回的是队列快照数组 */
  take(maxCount?: number): TelemetryEventEnvelope[];
  /** 订阅统计 */
  stats(): SubscriptionStats;
}

// ─────────────────────────── 总线 ───────────────────────────

/** seq 缺口区间（含端点） */
export interface SeqGap {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly count: number;
}

/** 总线级统计 */
export interface TelemetryBusStats {
  /** 已发布事件总数（含被采样丢弃与被环形缓冲丢弃的） */
  publishedTotal: number;
  /** 最后一次分配的 seq（未发布过为 0；采样丢弃不占 seq） */
  lastSeq: number;
  /** 环形缓冲满时弃最旧的累计次数（容量门限裁剪） */
  bufferDropCount: number;
  /** 当前活跃订阅数 */
  subscriptions: number;
  /** 时长门限裁剪的累计条数（bufferMaxAgeMs 启用时；缺省恒 0） */
  bufferExpiredCount: number;
  /** 采样保留的发布数（采样未启用恒 0） */
  samplingKept: number;
  /** 采样丢弃的发布数（采样未启用恒 0） */
  samplingDropped: number;
}

/** 总线选项 */
export interface TelemetryBusOptions {
  /** 注入时钟（缺省为 createManualClock(0)——确定性默认） */
  clock?: TelemetryClock;
  /** 总线级环形缓冲容量（≥1 整数，默认 1024） */
  bufferCapacity?: number;
  /** 订阅队列默认容量（≥1 整数，默认 128；订阅时可覆盖） */
  defaultMaxQueue?: number;
  /**
   * 缓冲时长保留门限（opt-in；>0 有限数）：发布时先把 ts < now −
   * bufferMaxAgeMs 的最旧缓冲事件裁出（bufferExpiredCount 计数）。
   * 与容量门限并存：先时长裁剪、再容量弃最旧。缺省不启用（零漂移）。
   */
  bufferMaxAgeMs?: number;
  /**
   * 采样策略（opt-in）：启用后 publish 先经 SamplingController.decide——
   * 丢弃的发布不占 seq、不入缓冲、不投递（错误必达由采样器保证）。
   * 缺省不启用（零漂移）。
   */
  sampling?: SamplingControllerOptions;
}

/**
 * TelemetryBus — 结构化事件总线。
 *
 * 消费模型：发布即写入（a）总线级环形缓冲（供任意快照/缺口检测）与
 * （b）每个匹配订阅者的有界队列；订阅者通过 take() 拉取。
 * 慢订阅者由有界队列 + 终态必达口径吸收，永不阻塞发布方。
 */
export class TelemetryBus {
  private readonly clock: TelemetryClock;
  private readonly bufferCapacityValue: number;
  private readonly defaultMaxQueueValue: number;
  private readonly maxAgeMs: number | undefined;
  private readonly sampling: SamplingController | undefined;
  private readonly ring: TelemetryEventEnvelope[] = [];
  private readonly subscribers = new Map<number, SubscriberState>();
  private nextSubscriptionId = 1;
  private seqCounter = 0;
  private publishedTotal = 0;
  private bufferDropCount = 0;
  private bufferExpiredCount = 0;
  private samplingKept = 0;
  private samplingDropped = 0;

  constructor(options: TelemetryBusOptions = {}) {
    const capacity = options.bufferCapacity ?? 1024;
    const maxQueue = options.defaultMaxQueue ?? 128;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`TelemetryBus: bufferCapacity 必须为 ≥1 的整数，收到 ${String(capacity)}`);
    }
    if (!Number.isInteger(maxQueue) || maxQueue < 1) {
      throw new RangeError(`TelemetryBus: defaultMaxQueue 必须为 ≥1 的整数，收到 ${String(maxQueue)}`);
    }
    if (options.bufferMaxAgeMs !== undefined) {
      const age = options.bufferMaxAgeMs;
      if (typeof age !== 'number' || !Number.isFinite(age) || age <= 0) {
        throw new RangeError(`TelemetryBus: bufferMaxAgeMs 必须为 >0 的有限数，收到 ${String(age)}`);
      }
    }
    this.clock = options.clock ?? createManualClock(0);
    this.bufferCapacityValue = capacity;
    this.defaultMaxQueueValue = maxQueue;
    this.maxAgeMs = options.bufferMaxAgeMs;
    this.sampling = options.sampling === undefined ? undefined : new SamplingController(options.sampling);
  }

  /**
   * 发布事件：分配单调 seq、盖注入时钟时间戳，写入环形缓冲并投递到
   * 所有匹配订阅者（应用背压口径）。返回不可写信封。
   *
   * 启用采样时：先经采样决策——保留事件照常入链（信封 sampled:true）；
   * 丢弃事件不占 seq / 不入缓冲 / 不投递（信封 sampled:false，seq 为当时
   * lastSeq），stats().samplingDropped 计数。错误事件由采样器保证必达。
   */
  publish<P>(type: string, source: string, payload: P, options?: PublishOptions): TelemetryEventEnvelope<P> {
    assertEventTypeName('publish(type)', type);
    assertEventTypeName('publish(source)', source);
    const ts = this.clock.now();
    if (!Number.isFinite(ts)) {
      throw new TypeError(`publish: 时钟返回非有限时间戳 ${String(ts)}（${type}）`);
    }
    this.publishedTotal += 1;
    // 时长保留门限：新事件入缓冲前，先裁出已过期的最旧缓冲（容量门限随后仍生效）
    if (this.maxAgeMs !== undefined) this.evictExpiredByAge(ts);
    const isFinal = options?.isFinal === true;
    if (this.sampling !== undefined) {
      const keep = this.sampling.decide({ type, source, payload, isFinal });
      if (!keep) {
        this.samplingDropped += 1;
        return { type, source, ts, seq: this.seqCounter, payload, isFinal, sampled: false };
      }
      this.samplingKept += 1;
      this.seqCounter += 1;
      const keptEnvelope: TelemetryEventEnvelope<P> = {
        type, source, ts, seq: this.seqCounter, payload, isFinal, sampled: true,
      };
      this.absorb(keptEnvelope);
      return keptEnvelope;
    }
    this.seqCounter += 1;
    const envelope: TelemetryEventEnvelope<P> = { type, source, ts, seq: this.seqCounter, payload, isFinal };
    this.absorb(envelope);
    return envelope;
  }

  /** 订阅模式；maxQueue 覆盖总线默认值（≥1 整数） */
  subscribe(pattern: string, options: { maxQueue?: number } = {}): EventSubscription {
    assertPattern(pattern, 'subscribe(pattern)');
    const maxQueue = options.maxQueue ?? this.defaultMaxQueueValue;
    if (!Number.isInteger(maxQueue) || maxQueue < 1) {
      throw new RangeError(`subscribe: maxQueue 必须为 ≥1 的整数，收到 ${String(maxQueue)}`);
    }
    const id = this.nextSubscriptionId;
    this.nextSubscriptionId += 1;
    const state: SubscriberState = {
      id,
      pattern,
      maxQueue,
      queue: [],
      received: 0,
      droppedIntermediate: 0,
      evictedForFinal: 0,
      droppedFinal: 0,
    };
    this.subscribers.set(id, state);
    return {
      id,
      pattern,
      maxQueue,
      size: () => state.queue.length,
      take: (maxCount?: number): TelemetryEventEnvelope[] => {
        if (maxCount === undefined) {
          const all = state.queue.slice();
          state.queue.length = 0;
          return all;
        }
        if (!Number.isInteger(maxCount) || maxCount < 0) {
          throw new RangeError(`take: maxCount 必须为 ≥0 的整数，收到 ${String(maxCount)}`);
        }
        const taken = state.queue.splice(0, maxCount);
        return taken;
      },
      stats: () => ({ ...snapshotStats(state) }),
    };
  }

  /** 退订：存在并删除返回 true，未知 id 返回 false */
  unsubscribe(subscriptionId: number): boolean {
    return this.subscribers.delete(subscriptionId);
  }

  /** 环形缓冲快照：最旧 → 最新（返回副本，不影响缓冲） */
  buffer(): TelemetryEventEnvelope[] {
    return this.ring.slice();
  }

  /**
   * seq 缺口检测：对当前缓冲内容自第一条已发布事件（seq=1）起扫描，
   * 返回缺失区间列表（即被环形缓冲丢弃的事件区间）。
   * 缓冲 seq 非单调（内部不变量被破坏）时显式 throw。
   */
  detectBufferGaps(): SeqGap[] {
    const gaps: SeqGap[] = [];
    let expected = 1;
    let previousSeq = 0;
    for (const envelope of this.ring) {
      if (envelope.seq <= previousSeq) {
        throw new Error(
          `detectBufferGaps: 缓冲 seq 非单调（${previousSeq} → ${envelope.seq}），内部不变量被破坏`,
        );
      }
      if (envelope.seq > expected) {
        gaps.push({ fromSeq: expected, toSeq: envelope.seq - 1, count: envelope.seq - expected });
      }
      expected = envelope.seq + 1;
      previousSeq = envelope.seq;
    }
    if (this.seqCounter >= expected) {
      gaps.push({ fromSeq: expected, toSeq: this.seqCounter, count: this.seqCounter - expected + 1 });
    }
    return gaps;
  }

  /**
   * 显式时长裁剪：按当前时钟把 ts < now − bufferMaxAgeMs 的最旧缓冲事件
   * 裁出，返回本次裁剪条数（未启用 bufferMaxAgeMs 返回 0）。发布时自动执行。
   */
  pruneBuffer(): number {
    if (this.maxAgeMs === undefined) return 0;
    const now = this.clock.now();
    if (!Number.isFinite(now)) {
      throw new TypeError(`pruneBuffer: 时钟返回非有限时间戳 ${String(now)}`);
    }
    return this.evictExpiredByAge(now);
  }

  /** 采样统计总览（未启用采样返回 undefined） */
  samplingSummary(): SamplingSummary | undefined {
    return this.sampling?.summary();
  }

  /** 采样分类型计数（未启用采样返回 undefined） */
  samplingTypeStats(): TypeSamplingStats[] | undefined {
    return this.sampling?.typeStats();
  }

  /** 总线统计 */
  stats(): TelemetryBusStats {
    return {
      publishedTotal: this.publishedTotal,
      lastSeq: this.seqCounter,
      bufferDropCount: this.bufferDropCount,
      subscriptions: this.subscribers.size,
      bufferExpiredCount: this.bufferExpiredCount,
      samplingKept: this.samplingKept,
      samplingDropped: this.samplingDropped,
    };
  }

  // ── 内部 ──

  /** 保留事件入缓冲（容量门限）并投递订阅（背压口径） */
  private absorb(envelope: TelemetryEventEnvelope): void {
    this.ring.push(envelope);
    if (this.ring.length > this.bufferCapacityValue) {
      this.ring.shift();
      this.bufferDropCount += 1;
    }
    for (const state of this.subscribers.values()) {
      if (eventPatternMatches(state.pattern, envelope.type)) {
        deliverToSubscriber(state, envelope);
      }
    }
  }

  /** 时长门限裁剪：ts < now − maxAgeMs 的最旧事件逐条裁出并计数 */
  private evictExpiredByAge(now: number): number {
    let evicted = 0;
    const threshold = now - (this.maxAgeMs as number);
    while (this.ring.length > 0 && (this.ring[0] as TelemetryEventEnvelope).ts < threshold) {
      this.ring.shift();
      evicted += 1;
    }
    this.bufferExpiredCount += evicted;
    return evicted;
  }
}

// ─────────────────────────── 内部实现 ───────────────────────────

interface SubscriberState {
  readonly id: number;
  readonly pattern: string;
  readonly maxQueue: number;
  readonly queue: TelemetryEventEnvelope[];
  received: number;
  droppedIntermediate: number;
  evictedForFinal: number;
  droppedFinal: number;
}

function snapshotStats(state: SubscriberState): SubscriptionStats {
  return {
    received: state.received,
    queued: state.queue.length,
    droppedIntermediate: state.droppedIntermediate,
    evictedForFinal: state.evictedForFinal,
    droppedFinal: state.droppedFinal,
  };
}

/** 背压口径投递：终态必达（为终态逐出最旧中间事件），中间可丢 */
function deliverToSubscriber(state: SubscriberState, envelope: TelemetryEventEnvelope): void {
  state.received += 1;
  if (state.queue.length < state.maxQueue) {
    state.queue.push(envelope);
    return;
  }
  if (!envelope.isFinal) {
    // 慢订阅者：丢弃中间事件
    state.droppedIntermediate += 1;
    return;
  }
  // 终态必达：逐出最旧非终态腾位
  const oldestIntermediateIndex = state.queue.findIndex((e) => !e.isFinal);
  if (oldestIntermediateIndex === -1) {
    // 全终态满载：有界内存优先，逐出最旧终态并显式计数
    state.queue.shift();
    state.droppedFinal += 1;
  } else {
    state.queue.splice(oldestIntermediateIndex, 1);
    state.evictedForFinal += 1;
  }
  state.queue.push(envelope);
}
