/**
 * trace.ts — 遥测审计总线 · 轻量跟踪跨度（基础设施之四）
 *
 * 嵌套栈式 span 跟踪，零依赖、确定性：
 * - begin(name, labels?) 开 span（spanId 为跟踪器内单调递增的 s1/s2/...）；
 *   父子关系 = 开启时刻的调用栈层级（begin 时栈顶即父）
 * - end(spanId, extraLabels?) 闭 span，严格 LIFO 栈守卫：
 *   只有栈顶可以被关闭；闭非栈顶（不匹配闭-span）、未知/已关 id、空栈
 *   均显式 throw 并保持状态不变
 * - 时长 = endTime - startTime，全部来自注入时钟（缺省手动时钟从 0 起，
 *   不使用 Date.now）——注入线性时钟下时长与推进量精确相等
 * - tree() 树形导出：根按 begin 顺序、子按 begin 顺序、标签键升序；
 *   已关 span 带 endTime/duration，未关 span 带 open:true
 *
 * R4 二期深化（缺省零漂移——采样为 opt-in，未配置时行为与导出逐位不变）：
 * - 尾部跨度采样（TracerOptions.sampling）：end() 时按「错误 span 全留、
 *   慢 span（duration ≥ slowMs）全留、正常 span 按 rate 确定性采样」分层
 *   决策；被丢弃的 span 从树与索引中移除，其子 span 上提挂到被丢 span 的
 *   父（保持 begin 顺序）；end 返回快照带 sampled 标记
 * - 采样还原统计（samplingStats()）：分层计数（错误/慢/采样保留/采样丢弃）
 *   + 估计器 Ñ = 错误 + 慢 + 采样保留/rate（尾部 Bresenham 使 |Ñ − 真实|
 *   < 1/rate——误差有界）；LIFO 栈守卫不受采样影响（决策发生在合法关闭
 *   之后）
 *
 * 零依赖：纯内存、零 I/O；入参显式 throw。
 */

import { createManualClock, DeterministicRateSampler, type TelemetryClock } from './event-bus.js';

// ─────────────────────────── 类型 ───────────────────────────

/** span 标签：字符串键值对（值必须为 string，键非空） */
export type SpanLabels = Readonly<Record<string, string>>;

/** 树形导出的 span 快照（已关：含 endTime 与 duration；未关：open=true） */
export interface TraceSpanSnapshot {
  readonly spanId: string;
  readonly name: string;
  readonly startTime: number;
  readonly endTime?: number;
  /** 已关 span 的时长 = endTime - startTime（注入时钟口径） */
  readonly duration?: number;
  readonly open: boolean;
  /** 键升序的标签副本 */
  readonly labels: Readonly<Record<string, string>>;
  readonly children: ReadonlyArray<TraceSpanSnapshot>;
  /**
   * 尾部采样标记（仅当启用采样时关闭的 span 带）：true = 保留在树中；
   * false = 被采样丢弃（已从树移除，快照仅作为 end() 返回值回执）。
   * 未启用采样时缺省（零漂移）。
   */
  readonly sampled?: boolean;
}

/** 尾部跨度采样选项（opt-in） */
export interface SpanSamplingOptions {
  /** 慢阈值：duration ≥ slowMs 的 span 全保留（≥0 有限数；缺省不启用慢规则） */
  readonly slowMs?: number;
  /** 正常 span 采样率 (0,1]（缺省 1 = 不丢弃） */
  readonly rate?: number;
  /** 错误判定（对关闭快照运行）：true → 全保留。缺省见 defaultSpanErrorMatcher */
  readonly errorMatcher?: (snapshot: TraceSpanSnapshot) => boolean;
}

/** 尾部采样统计（含估计器还原） */
export interface SpanSamplingStats {
  /** 已决策（已关闭且通过栈守卫）的 span 数 */
  readonly decided: number;
  /** 保留数 = keptErrors + keptSlow + sampledKept */
  readonly kept: number;
  /** 丢弃数（= decided − kept） */
  readonly dropped: number;
  /** 错误 span 保留数（全保留层） */
  readonly keptErrors: number;
  /** 慢 span 保留数（全保留层） */
  readonly keptSlow: number;
  /** 正常 span 采样保留数 */
  readonly sampledKept: number;
  /** 正常 span 采样丢弃数 */
  readonly sampledDropped: number;
  /** 生效采样率 */
  readonly rate: number;
  /** 生效慢阈值（未启用为 undefined） */
  readonly slowMs: number | undefined;
  /** 估计器：Ñ = keptErrors + keptSlow + sampledKept / rate（误差 < 1/rate） */
  readonly estimatedTotal: number;
  /** 估计误差严格界（启用按率采样后为 1/rate，否则 0） */
  readonly estimateErrorBound: number;
}

/** 跟踪器选项 */
export interface TracerOptions {
  /** 注入时钟（缺省为 createManualClock(0)——确定性默认） */
  clock?: TelemetryClock;
  /** 尾部跨度采样（opt-in；缺省不采样——零漂移） */
  sampling?: SpanSamplingOptions;
}

interface SpanRecord {
  readonly spanId: string;
  readonly name: string;
  readonly startTime: number;
  readonly order: number;
  parent: SpanRecord | null;
  readonly children: SpanRecord[];
  readonly labels: Record<string, string>;
  endTime: number | undefined;
  closed: boolean;
}

// ─────────────────────────── 跟踪器 ───────────────────────────

/**
 * Tracer — 嵌套栈守卫的轻量跟踪器。
 *
 * begin 压栈、end 弹栈；任意时刻未关闭 span 构成一棵生长中的树，
 * tree() 输出完整快照（含仍在开放的分支）。
 */
export class Tracer {
  private readonly clock: TelemetryClock;
  private readonly samplingRate: number | undefined;
  private readonly slowThreshold: number | undefined;
  private readonly errorMatcher: ((snapshot: TraceSpanSnapshot) => boolean) | undefined;
  private readonly sampler: DeterministicRateSampler | undefined;
  private readonly stack: SpanRecord[] = [];
  private readonly roots: SpanRecord[] = [];
  private readonly byId = new Map<string, SpanRecord>();
  private nextSpanNumber = 0;
  private totalBegins = 0;
  private droppedSpans = 0;
  private decidedSpans = 0;
  private keptErrors = 0;
  private keptSlow = 0;
  private sampledKept = 0;
  private sampledDropped = 0;

  constructor(options: TracerOptions = {}) {
    this.clock = options.clock ?? createManualClock(0);
    if (options.sampling !== undefined) {
      const sampling = options.sampling;
      if (sampling === null || typeof sampling !== 'object' || Array.isArray(sampling)) {
        throw new TypeError(`Tracer: sampling 必须为对象，收到 ${String(sampling)}`);
      }
      if (sampling.slowMs !== undefined) {
        const slow = sampling.slowMs;
        if (typeof slow !== 'number' || !Number.isFinite(slow) || slow < 0) {
          throw new RangeError(`Tracer: sampling.slowMs 必须为 ≥0 的有限数，收到 ${String(slow)}`);
        }
        this.slowThreshold = slow;
      }
      const rate = sampling.rate ?? 1;
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 1) {
        throw new RangeError(`Tracer: sampling.rate 必须为 (0,1] 的有限数，收到 ${String(rate)}`);
      }
      this.samplingRate = rate;
      this.sampler = new DeterministicRateSampler(rate);
      this.errorMatcher = sampling.errorMatcher ?? defaultSpanErrorMatcher;
      if (typeof this.errorMatcher !== 'function') {
        throw new TypeError('Tracer: sampling.errorMatcher 必须为函数');
      }
    }
  }

  /** 开 span：返回确定性 spanId（s1/s2/...，按 begin 顺序单调递增） */
  begin(name: string, labels?: SpanLabels): string {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError(`begin: name 必须为非空字符串，收到 ${String(name)}`);
    }
    const normalized = normalizeSpanLabels(labels, `begin('${name}')`);
    const startTime = this.clock.now();
    if (!Number.isFinite(startTime)) {
      throw new TypeError(`begin('${name}'): 时钟返回非有限时间戳 ${String(startTime)}`);
    }
    this.nextSpanNumber += 1;
    this.totalBegins += 1;
    const spanId = `s${this.nextSpanNumber}`;
    const parent = this.stack.length === 0 ? null : (this.stack[this.stack.length - 1] as SpanRecord);
    const record: SpanRecord = {
      spanId,
      name,
      startTime,
      order: this.nextSpanNumber,
      parent,
      children: [],
      labels: normalized,
      endTime: undefined,
      closed: false,
    };
    this.byId.set(spanId, record);
    if (parent === null) this.roots.push(record);
    else parent.children.push(record);
    this.stack.push(record);
    return spanId;
  }

  /**
   * 闭 span（严格栈守卫）：spanId 必须是当前栈顶，否则拒绝（throw，状态不变）。
   * extraLabels 在关闭时并入（同名键覆盖）。返回该 span 的关闭快照。
   */
  end(spanId: string, extraLabels?: SpanLabels): TraceSpanSnapshot {
    if (this.stack.length === 0) {
      throw new Error(`end: 无打开的 span，无法关闭 '${String(spanId)}'`);
    }
    const known = this.byId.get(spanId);
    if (known === undefined) {
      throw new Error(`end: 未知 spanId '${String(spanId)}'（从未被 begin 过）`);
    }
    if (known.closed) {
      throw new Error(`end: span '${spanId}'（${known.name}）已关闭，不可重复关闭`);
    }
    const top = this.stack[this.stack.length - 1] as SpanRecord;
    if (top.spanId !== spanId) {
      throw new Error(
        `end: 闭-span 不匹配——栈顶为 '${top.spanId}'（${top.name}），试图关闭 '${spanId}'（${known.name}）；` +
          `请先关闭 '${top.spanId}'（LIFO 守卫，本次调用未改变任何状态）`,
      );
    }
    const endTime = this.clock.now();
    if (!Number.isFinite(endTime)) {
      throw new TypeError(`end('${spanId}'): 时钟返回非有限时间戳 ${String(endTime)}`);
    }
    const merged = normalizeSpanLabels(extraLabels, `end('${spanId}')`);
    for (const key of Object.keys(merged)) top.labels[key] = merged[key];
    top.endTime = endTime;
    top.closed = true;
    this.stack.pop();
    const snapshot = this.snapshotOf(top);
    if (this.sampler !== undefined) {
      return { ...snapshot, ...this.decideSampling(top, snapshot) };
    }
    return snapshot;
  }

  /** 当前栈顶 spanId（无打开 span 为 undefined） */
  currentSpanId(): string | undefined {
    return this.stack.length === 0 ? undefined : (this.stack[this.stack.length - 1] as SpanRecord).spanId;
  }

  /** 当前嵌套深度（打开中的 span 数） */
  depth(): number {
    return this.stack.length;
  }

  /** 树形导出：根按 begin 顺序；子按 begin 顺序；标签键升序；未关 span open=true */
  tree(): TraceSpanSnapshot[] {
    return this.roots.map((root) => this.snapshotOf(root));
  }

  /** 计数：open（打开中）/ closed（已关且保留）/ total（累计 begin 次数） */
  counts(): { open: number; closed: number; total: number } {
    return {
      open: this.stack.length,
      closed: this.totalBegins - this.droppedSpans - this.stack.length,
      total: this.totalBegins,
    };
  }

  /** 尾部采样统计与估计器还原（未启用采样返回 undefined） */
  samplingStats(): SpanSamplingStats | undefined {
    if (this.sampler === undefined) return undefined;
    const rate = this.samplingRate as number;
    const sampledDecided = this.sampledKept + this.sampledDropped;
    return {
      decided: this.decidedSpans,
      kept: this.keptErrors + this.keptSlow + this.sampledKept,
      dropped: this.droppedSpans,
      keptErrors: this.keptErrors,
      keptSlow: this.keptSlow,
      sampledKept: this.sampledKept,
      sampledDropped: this.sampledDropped,
      rate,
      slowMs: this.slowThreshold,
      estimatedTotal: this.keptErrors + this.keptSlow + this.sampledKept / rate,
      estimateErrorBound: rate < 1 && sampledDecided > 0 ? 1 / rate : 0,
    };
  }

  // ── 内部：尾部采样 ──

  /**
   * 关闭后的分层决策：错误（errorMatcher）→ 全留；慢（duration ≥ slowMs）
   * → 全留；否则按 rate 确定性采样。丢弃的 span 从树与索引移除（子 span
   * 上提）。返回 { sampled } 并入 end() 返回快照。
   */
  private decideSampling(record: SpanRecord, snapshot: TraceSpanSnapshot): { sampled: boolean } {
    this.decidedSpans += 1;
    const duration = (record.endTime as number) - record.startTime;
    if (this.errorMatcher !== undefined && this.errorMatcher(snapshot)) {
      this.keptErrors += 1;
      return { sampled: true };
    }
    if (this.slowThreshold !== undefined && duration >= this.slowThreshold) {
      this.keptSlow += 1;
      return { sampled: true };
    }
    if ((this.sampler as DeterministicRateSampler).decide()) {
      this.sampledKept += 1;
      return { sampled: true };
    }
    this.sampledDropped += 1;
    this.droppedSpans += 1;
    this.dropSpan(record);
    return { sampled: false };
  }

  /** 从树与索引移除：子 span 按原相对顺序上提到被丢 span 的父位（保 begin 序） */
  private dropSpan(record: SpanRecord): void {
    this.byId.delete(record.spanId);
    const siblings = record.parent === null ? this.roots : record.parent.children;
    const index = siblings.indexOf(record);
    if (index !== -1) siblings.splice(index, 1);
    for (let i = 0; i < record.children.length; i += 1) {
      const child = record.children[i] as SpanRecord;
      child.parent = record.parent;
      siblings.splice(index + i, 0, child);
    }
    record.children.length = 0;
  }

  // ── 内部 ──

  private snapshotOf(record: SpanRecord): TraceSpanSnapshot {
    const labels: Record<string, string> = {};
    for (const key of Object.keys(record.labels).sort()) labels[key] = record.labels[key];
    const children = record.children.map((child) => this.snapshotOf(child));
    if (record.closed && record.endTime !== undefined) {
      return {
        spanId: record.spanId,
        name: record.name,
        startTime: record.startTime,
        endTime: record.endTime,
        duration: record.endTime - record.startTime,
        open: false,
        labels,
        children,
      };
    }
    return {
      spanId: record.spanId,
      name: record.name,
      startTime: record.startTime,
      open: true,
      labels,
      children,
    };
  }
}

// ─────────────────────────── 内部校验 ───────────────────────────

function normalizeSpanLabels(labels: SpanLabels | undefined, api: string): Record<string, string> {
  if (labels === undefined) return {};
  if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) {
    throw new TypeError(`${api}: labels 必须为字符串键值对象，收到 ${String(labels)}`);
  }
  const normalized: Record<string, string> = {};
  for (const key of Object.keys(labels)) {
    if (key.length === 0) throw new TypeError(`${api}: 标签键不允许为空字符串`);
    const value: unknown = labels[key];
    if (typeof value !== 'string') {
      throw new TypeError(`${api}: 标签 '${key}' 的值必须为 string，收到 ${typeof value}`);
    }
    normalized[key] = value;
  }
  return normalized;
}

/**
 * 缺省 span 错误判定：labels.error 为非空字符串（任意值——错误码/错误消息）
 * 或 labels.status === 'error' → 错误（必留）。可用 errorMatcher 覆盖。
 */
function defaultSpanErrorMatcher(snapshot: TraceSpanSnapshot): boolean {
  const error = snapshot.labels.error;
  if (typeof error === 'string' && error.length > 0) return true;
  return snapshot.labels.status === 'error';
}
