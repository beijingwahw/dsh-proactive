/**
 * safety-governor.ts — 安全治理器（自主智能"边界"支柱）
 *
 * 职责：自主性越强，越需要明确的边界。安全治理器为系统的自主行为
 * 设置硬性约束，确保"自主"不演变为"失控"。
 *
 * 能力矩阵：
 * 1. 限流（Rate Limiter）：限制单位时间内的自主动作次数，
 *    防止心跳循环或探索行为在短时间内过度消耗资源
 * 2. 预算（Budget）：限制累计 token 消耗 / 成本，
 *    超出预算后拒绝新的自主动作，防止成本失控
 * 3. 熔断器（Circuit Breaker）：连续失败超过阈值时熔断，
 *    暂停自主执行进入冷却期，冷却后半开试探，成功则恢复
 * 4. 置信度门控（Confidence Gate）：低置信度的决策不放行自主执行，
 *    要求转人工确认，防止盲目行动
 * 5. Kill Switch：全局紧急停止开关，一键冻结所有自主行为
 *
 * 设计要点：
 * - 治理器是"否决权"角色：不决定做什么，只决定"能不能做"
 * - 所有约束均可配置，且提供审计日志追溯每次拦截原因
 *
 * 4.0 升级（治理闭环）：
 * - 半开探测互斥：冷却期结束后仅放行一个试探动作，其余继续拒绝——
 *   升级前半开态放行全部流量，恢复瞬间的洪峰会直接打垮刚喘息的下游
 * - 按动作限流：perActionRateLimits 为指定动作配置独立窗口
 *   （如 exploration 5/min、autonomous-execute 60/min），
 *   未配置的动作沿用共享全局窗口（与升级前行为一致）
 * - 预算/审计持久化：persistPath 配置后，token/成本累计与审计尾部
 *   落盘重启恢复——升级前纯内存，重启即预算清零、审计丢失
 *
 * 15.0 升级（形式语义闭环）：
 * - attachRuntimeVerifier() 挂载运行时验证器后，治理器把自身全部
 *   关键迁移（动作失败/熔断开闭/Kill Switch 启停）作为事件流喂给
 *   LTLf 安全规约监视器——治理器从「标量门控的集合」升级为
 *   「被形式规约监视的守卫」；
 * - 违规升级通道：critical 违规（如失败风暴）→ 自动触发 Kill Switch
 *   （形式裁决获得治理的牙齿）；warn 违规 → 记入失败压力推动熔断；
 *   info → 仅审计。规约可配置声明、违规报告携带可重放见证轨迹。
 *
 * 第三轮升级（治理域 A13）：总督行动阶梯
 * - 行动严重度单调阶梯：observe（观察）→ throttle（限流）→ breaker
 *   （熔断）→ kill（kill-switch），同因威胁逐级推进、每次至多 +1 级
 *   （绝不跳级）；
 * - 分级冷却：升级到某级后，同因重复上报在冷却期内被吸收（计数但不
 *   推进——不跳级、不抖动），冷却期满后的下一次上报才再升一级；
 * - 阶梯咬合既有机制：throttle 级把全部限流窗口的有效上限乘以
 *   throttleFactor（下限 1）；breaker 级打开既有熔断器（恢复路径仍由
 *   熔断状态机自治）；kill 级拉起 kill-switch；
 * - 行动理由结构化：裁决携带 action（级别/同因/code/生效时刻/打击
 *   次数/冷却剩余），审计同步入账；ladderView() 全量可观测。
 *   未挂载（attachEscalationLadder 前）零介入——旧行为逐位保留。
 *
 * 第四轮升级（治理域 R4-A13，全新维度）：
 * - 安全事件取证：事故（incident）按 ID 聚合的信号→行动→效果因果链
 *   记录与事后重建（reconstructIncident）——回放序列严格递增、因果
 *   引用全部可解析且指向更早事件、时间单调不减、相位覆盖核验；
 *   未挂载（attachForensics 前）零介入；
 * - 威胁评分：多信号加权综合威胁分（失败率 / 异常率 / 越权尝试，窗口
 *   计数 → 封顶归一 → 加权合成），分数驱动行动阶梯跳档——高分直达
 *   throttle / breaker / kill（越过中间级与冷却），低分仍走经典渐进
 *   （+1 步进 + 冷却吸收）；未挂载（attachThreatScorer 前）零介入，
 *   reportThreat 逐位保持第三轮行为；
 * - 安全合规摘要：securitySummary() 输出审计拦截计数（按 blockedBy
 *   分桶、稳定排序）+ 阶梯状态 + Kill Switch / 熔断快照——供
 *   TenantManager.exportComplianceReport 以结构化鸭子类型数据源消费。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  RuntimeVerifier,
  defaultSafetySpecs,
  type RuntimeVerifierStatus,
  type SafetySpec,
  type ViolationReport,
} from './core/runtime-verification.js';
import { firstPassageCooldown } from './core/first-passage.js';

/** 治理动作类型 */
export type GovernedAction = 'autonomous-execute' | 'exploration' | 'goal-dispatch' | 'strategy-evolution';

/** 第三轮：行动阶梯级别（严重度单调递增） */
export type GovernorLadderLevel = 'observe' | 'throttle' | 'breaker' | 'kill';

/** 阶梯级别序（index+1 即 levelIndex；throttle 及以上时限流折扣生效） */
export const LADDER_LEVEL_ORDER: readonly GovernorLadderLevel[] = ['observe', 'throttle', 'breaker', 'kill'];

/** 行动阶梯挂载选项 */
export interface EscalationLadderOptions {
  /** 各级冷却 ms：升级到该级后，同因上报在冷却内被吸收（不推进） */
  cooldowns?: { observe?: number; throttle?: number; breaker?: number };
  /** throttle 级限流折扣因子（有效上限 = ⌊上限 × factor⌋，下限 1；缺省 0.5） */
  throttleFactor?: number;
  /** 注入时钟（确定性验证口径；缺省 Date.now） */
  clock?: () => number;
}

/** 单因阶梯状态 */
export interface LadderCauseState {
  cause: string;
  level: GovernorLadderLevel;
  /** 级别序号 1..4（observe=1 … kill=4） */
  levelIndex: number;
  /** 当前级别生效时刻 */
  since: number;
  /** 累计上报次数 */
  strikes: number;
  /** 实际升级次数（首报算 1；冷却内吸收不计） */
  escalations: number;
  /** 冷却内被吸收的上报次数（不跳级不抖动的直接证据） */
  suppressed: number;
  /** 当前级别冷却剩余 ms */
  cooldownRemainingMs: number;
}

/** 结构化行动理由（裁决与审计携带） */
export interface GovernorLadderAction {
  level: GovernorLadderLevel;
  cause: string;
  code: `ladder-${GovernorLadderLevel}`;
  since: number;
  strikes: number;
  cooldownRemainingMs: number;
}

/** 阶梯总览读数 */
export interface LadderView {
  throttleActive: boolean;
  breakerActive: boolean;
  killActive: boolean;
  causes: LadderCauseState[];
}

/** 治理裁决 */
export interface GovernanceVerdict {
  allowed: boolean;
  /** 拦截原因（allowed=false 时） */
  reason?: string;
  /** 拦截类别 */
  blockedBy?: 'kill-switch' | 'rate-limit' | 'budget' | 'circuit-breaker' | 'confidence-gate';
  /** 第三轮：结构化行动理由（行动阶梯咬合时携带） */
  action?: GovernorLadderAction;
}

/** 治理审计条目 */
export interface GovernanceAuditEntry {
  timestamp: number;
  action: GovernedAction;
  verdict: GovernanceVerdict;
}

// ─────────────── 第四轮：安全事件取证（因果链时间线重建） ───────────────

/** 取证事件相位（信号 → 行动 → 效果） */
export type ForensicPhase = 'signal' | 'action' | 'effect';

/** 取证挂载选项 */
export interface ForensicsOptions {
  /** 注入时钟（确定性验证口径；缺省 Date.now） */
  clock?: () => number;
  /** 单事故事件上限（环形截断，缺省 1000） */
  maxEventsPerIncident?: number;
  /** 并发事故上限（超出逐出最旧，缺省 64） */
  maxIncidents?: number;
}

/** 单条取证事件（因果链节点） */
export interface ForensicEvent {
  /** 事故事件序号（从事故开启单调递增） */
  id: number;
  phase: ForensicPhase;
  name: string;
  detail?: Record<string, unknown>;
  at: number;
  /** 因果前驱事件 id（根信号 → undefined） */
  cause?: number;
}

/** 事故时间线（事后重建产物） */
export interface ForensicTimeline {
  incidentId: string;
  openedAt: number;
  closedAt?: number;
  outcome?: string;
  /** 回放序列（记录序） */
  events: ForensicEvent[];
  /** 因果链边（前驱 → 后继，null = 根），按回放序 */
  causalChain: Array<{ from: number | null; to: number }>;
  /** 链完整性：根为信号且无前驱、其余事件因果前驱全部可解析 */
  causalComplete: boolean;
  /** 相位覆盖：signal / action / effect 三相位齐备 */
  phaseComplete: boolean;
  counts: { signal: number; action: number; effect: number; total: number };
  /** 事故历时（关闭或至今） */
  durationMs: number;
  /** 重建一致性：id 严格递增 ∧ 因果引用可解析且指向更早事件 ∧ 时间单调不减 */
  consistent: boolean;
}

/** 取证台账总览条目 */
export interface ForensicsIncidentSummary {
  incidentId: string;
  openedAt: number;
  closedAt?: number;
  outcome?: string;
  events: number;
  counts: { signal: number; action: number; effect: number };
  causalComplete: boolean;
}

// ─────────────── 第四轮：威胁评分（多信号加权 + 阶梯跳档） ───────────────

/** 威胁信号种类 */
export type ThreatSignalKind = 'failure' | 'anomaly' | 'unauthorized';

/** 威胁评分挂载选项 */
export interface ThreatScorerOptions {
  /** 各信号计数封顶（达到封顶即该分量 1.0；缺省 failure 10 / anomaly 10 / unauthorized 5） */
  caps?: Partial<Record<ThreatSignalKind, number>>;
  /** 各信号权重（缺省 failure 0.4 / anomaly 0.3 / unauthorized 0.3；和会被归一化） */
  weights?: Partial<Record<ThreatSignalKind, number>>;
  /** 分数阈值：≥ throttle → 直达 throttle；≥ breaker → 直达 breaker；≥ kill → 直达 kill */
  thresholds?: { throttle?: number; breaker?: number; kill?: number };
  /** 信号计数窗口 ms（窗口外信号滑出；缺省 60_000） */
  windowMs?: number;
  /** 注入时钟（确定性验证口径；缺省 Date.now） */
  clock?: () => number;
}

/** 一次威胁评分读数 */
export interface ThreatScoreReading {
  /** 综合威胁分 ∈ [0,1] */
  score: number;
  band: 'low' | 'elevated' | 'high' | 'critical';
  /** 分量明细（failure / anomaly / unauthorized 固定序） */
  components: Array<{
    kind: ThreatSignalKind;
    count: number;
    cap: number;
    subscore: number;
    weight: number;
  }>;
  windowMs: number;
  /** 窗口内信号总数 */
  signalsInWindow: number;
  /** 分数对应的直达阶梯档位（低于 throttle 阈值 → null：走经典渐进） */
  fastTrackLevel: GovernorLadderLevel | null;
  scoredAt: number;
}

// ─────────────── 第四轮：安全合规摘要（审计拦截计数 + 阶梯快照） ───────────────

/** 安全合规摘要（TenantManager.exportComplianceReport 的数据源口径） */
export interface SecuritySummary {
  killSwitchEngaged: boolean;
  circuitState: string;
  ladder: {
    throttleActive: boolean;
    breakerActive: boolean;
    killActive: boolean;
    causes: Array<{
      cause: string;
      level: string;
      levelIndex: number;
      since: number;
      strikes: number;
      escalations: number;
      suppressed: number;
      cooldownRemainingMs: number;
    }>;
  } | null;
  incidents: {
    /** 摘要口径内的审计条目数 */
    auditEntries: number;
    allowed: number;
    blocked: number;
    /** 阶梯行动入账数（verdict.action 携带） */
    ladderActions: number;
    /** 拦截原因分桶（blocker 字典序稳定排序） */
    byBlocker: Array<{ blocker: string; count: number }>;
    /** 取证事故概要（未挂载 → 空数组） */
    forensics: Array<{
      incidentId: string;
      openedAt: number;
      closedAt?: number;
      outcome?: string;
      events: number;
      causalComplete: boolean;
    }>;
  };
}

/** 熔断器状态 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** 安全治理器配置 */
export interface SafetyGovernorConfig {
  /** 限流：每分钟最大自主动作数 */
  maxActionsPerMinute: number;
  /** 预算：累计 token 上限（0=不限制） */
  tokenBudget: number;
  /** 预算：累计成本上限（美元，0=不限制） */
  costBudget: number;
  /** 熔断：连续失败阈值 */
  circuitFailureThreshold: number;
  /** 熔断：冷却期（毫秒） */
  circuitCooldownMs: number;
  /** 置信度门控：低于该值的决策需人工确认 */
  confidenceThreshold: number;
  /** 治理审计日志上限 */
  auditLimit: number;
  /**
   * 4.0：按动作独立限流（每分钟上限；未列出的动作沿用共享全局窗口）。
   * 配置后该动作拥有自己的滑动窗口，不再与全局窗口叠加计数。
   */
  perActionRateLimits?: Partial<Record<GovernedAction, number>>;
  /**
   * 4.0：治理状态持久化路径（预算累计 + 审计尾部落盘，重启恢复）。
   * 不配置则纯内存（与升级前行为一致）。
   */
  persistPath?: string;
}

/** 默认配置 */
export const DEFAULT_SAFETY_GOVERNOR_CONFIG: SafetyGovernorConfig = {
  maxActionsPerMinute: 60,
  tokenBudget: 0,
  costBudget: 0,
  circuitFailureThreshold: 5,
  circuitCooldownMs: 60_000,
  confidenceThreshold: 0.3,
  auditLimit: 200,
};

/** 可持久化的治理状态（4.0） */
export interface GovernorPersistState {
  version: 1;
  totalTokensUsed: number;
  totalCost: number;
  circuitState: CircuitState;
  consecutiveFailures: number;
  circuitOpenedAt: number;
  killSwitchEngaged: boolean;
  auditTail: GovernanceAuditEntry[];
}

/**
 * 安全治理器
 *
 * 被 index.ts 持有：所有自主动作执行前调用 govern() 获取裁决，
 * 执行结果经 recordOutcome() 回写以驱动熔断器与预算统计。
 * 4.0：主执行路径（executeSignal）执行前同样过 govern('autonomous-execute')。
 */
export class SafetyGovernor {
  private config: SafetyGovernorConfig;
  /** 限流：最近一分钟的动作时间戳（共享全局窗口） */
  private recentActions: number[] = [];
  /** 限流：按动作独立窗口（perActionRateLimits 配置的动作） */
  private perActionWindows = new Map<GovernedAction, number[]>();
  /** 预算：累计消耗 */
  private totalTokensUsed = 0;
  private totalCost = 0;
  /** 熔断器状态 */
  private circuitState: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;
  /** 40.0：失败时间戳（attachFirstPassageAdvisor 后记录；首达定价原料） */
  private failureTimestamps: number[] = [];
  /** 40.0：首达冷却配置（未挂载 undefined——零记录零介入） */
  private firstPassage?: { targetProb: number };
  /** 40.0：最近一次首达定价读数（breaker 打开时刷新） */
  private lastFirstPassage?: { recommendedCooldownMs: number; expectedRecoverMs: number; mu: number; sigma: number; targetProb: number };
  /** 4.0：半开试探互斥（探测在途时其余动作继续拒绝） */
  private halfOpenProbeInFlight = false;
  /** Kill Switch */
  private killSwitchEngaged = false;
  /** 审计日志 */
  private audit: GovernanceAuditEntry[] = [];
  /** 4.0：持久化防抖定时器 */
  private persistTimer?: ReturnType<typeof setTimeout>;
  /** 15.0：运行时验证器（挂载后治理迁移成为被监视的事件流） */
  private verifier?: RuntimeVerifier;
  /** 15.0：形式违规升级计数（审计可观测） */
  private formalViolations = { critical: 0, warn: 0, info: 0 };
  /** 第三轮：行动阶梯（未挂载零介入；挂载后同因威胁单调逐级推进） */
  private ladder?: {
    cooldowns: { observe: number; throttle: number; breaker: number };
    throttleFactor: number;
    clock: () => number;
    causes: Map<string, {
      level: GovernorLadderLevel;
      since: number;
      strikes: number;
      escalations: number;
      suppressed: number;
    }>;
  };
  /** 第四轮：安全事件取证（未挂载零介入） */
  private forensics?: {
    clock: () => number;
    maxEventsPerIncident: number;
    maxIncidents: number;
    /** 插入序（最旧逐出口径） */
    order: string[];
    incidents: Map<string, {
      openedAt: number;
      closedAt?: number;
      outcome?: string;
      nextId: number;
      events: ForensicEvent[];
    }>;
  };
  /** 第四轮：威胁评分（未挂载零介入） */
  private threat?: {
    caps: Record<ThreatSignalKind, number>;
    weights: Record<ThreatSignalKind, number>;
    thresholds: { throttle: number; breaker: number; kill: number };
    windowMs: number;
    clock: () => number;
    signals: Array<{ kind: ThreatSignalKind; at: number }>;
  };

  constructor(config?: Partial<SafetyGovernorConfig>) {
    this.config = { ...DEFAULT_SAFETY_GOVERNOR_CONFIG, ...config };
    this.loadPersisted();
  }

  /**
   * 15.0：挂载运行时验证器（幂等；缺省规约集以治理器自身的
   * circuitFailureThreshold 参数化——失败风暴规约与熔断阈值同源）。
   *
   * 挂载后治理器的全部关键迁移自动喂入规约监视器：
   * action-failed / breaker-opened / breaker-closed /
   * kill-switch-engaged / kill-switch-disengaged。
   *
   * @param specs 安全规约集（缺省 defaultSafetySpecs(circuitFailureThreshold)）
   * @returns 挂载的验证器（可继续 register 附加规约）
   */
  attachRuntimeVerifier(specs?: SafetySpec[]): RuntimeVerifier {
    if (!this.verifier) {
      this.verifier = new RuntimeVerifier(specs ?? defaultSafetySpecs(this.config.circuitFailureThreshold));
    } else if (specs && specs.length > 0) {
      for (const spec of specs) this.verifier.register(spec);
    }
    return this.verifier;
  }

  /** 15.0：动态注册一条安全规约（需先挂载验证器） */
  registerSafetySpec(spec: SafetySpec): boolean {
    if (!this.verifier) this.attachRuntimeVerifier();
    this.verifier!.register(spec);
    return true;
  }

  /** 15.0：运行时验证状态（未挂载时 undefined） */
  getVerificationStatus(): RuntimeVerifierStatus | undefined {
    return this.verifier?.status();
  }

  /**
   * 治理裁决：判定一个自主动作能否执行
   * @param action 动作类型
   * @param confidence 决策置信度（用于置信度门控）
   * @returns 裁决结果
   */
  govern(action: GovernedAction, confidence = 1): GovernanceVerdict {
    let verdict: GovernanceVerdict;
    // 第三轮：阶梯咬合读数（未挂载/无上报 → undefined；全部分支零漂移）
    const ladderTop = this.topLadderCause();
    const throttleActive = ladderTop !== undefined && LADDER_LEVEL_ORDER.indexOf(ladderTop.level) >= 1;
    const ladderAction = ladderTop ? this.ladderActionInfo(ladderTop) : undefined;

    // 1. Kill Switch（最高优先级）
    if (this.killSwitchEngaged) {
      verdict = { allowed: false, reason: '紧急停止开关已启用', blockedBy: 'kill-switch' };
      if (ladderTop?.level === 'kill') verdict.action = ladderAction;
      this.logAudit(action, verdict);
      return verdict;
    }

    // 2. 熔断器（4.0：半开探测互斥——冷却期满后仅放行一个试探）
    //    只读判定：此处仅决定「是否被熔断拦截」；探测资格延迟到
    //    所有门控通过后的放行一刻才占用——若在限流/预算/置信度
    //    检查处提前占名额又遭拒绝，资格将无人归还（recordOutcome
    //    永不触发），half-open 互斥会把全部自主动作永久卡死
    let probeCandidate = false;
    if (this.circuitState === 'open') {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed < this.config.circuitCooldownMs) {
        verdict = { allowed: false, reason: `熔断器开启（冷却期剩余 ${Math.ceil((this.config.circuitCooldownMs - elapsed) / 1000)}s）`, blockedBy: 'circuit-breaker' };
        if (ladderTop && LADDER_LEVEL_ORDER.indexOf(ladderTop.level) >= 2) verdict.action = ladderAction;
        this.logAudit(action, verdict);
        return verdict;
      }
      probeCandidate = true; // 冷却期已满：本调用可成为试探（名额尚未占用）
    } else if (this.circuitState === 'half-open') {
      // 4.0 修复：half-open 态下的后续调用同样必须被互斥拦截——
      // 升级前互斥判断只写在 open→half-open 迁移分支内，首个试探把状态推进到
      // half-open 后，其余并发调用全部绕过熔断检查漏放进恢复期下游
      if (this.halfOpenProbeInFlight) {
        verdict = { allowed: false, reason: '半开试探进行中，其余动作暂缓', blockedBy: 'circuit-breaker' };
        this.logAudit(action, verdict);
        return verdict;
      }
      // 探测名额空闲（如持久化恢复至 half-open）：本调用接替成为试探
      probeCandidate = true;
    }

    // 3. 限流（4.0：perActionRateLimits 命中的动作走独立窗口，其余共享全局；
    //    第三轮：阶梯 throttle 级及以上时全部窗口有效上限 ×= throttleFactor，下限 1）
    const now = Date.now();
    const throttleScale = (limit: number): number =>
      throttleActive && this.ladder ? Math.max(1, Math.floor(limit * this.ladder.throttleFactor)) : limit;
    const perActionLimit = this.config.perActionRateLimits?.[action];
    if (perActionLimit !== undefined) {
      const effectiveLimit = throttleScale(perActionLimit);
      const window = (this.perActionWindows.get(action) ?? []).filter((t) => t > now - 60_000);
      if (window.length >= effectiveLimit) {
        verdict = {
          allowed: false,
          reason: throttleActive
            ? `阶梯限流（${ladderTop!.cause} → ${ladderTop!.level}）：动作 ${action} 每分钟最多 ${effectiveLimit} 次`
            : `限流：动作 ${action} 每分钟最多 ${effectiveLimit} 次`,
          blockedBy: 'rate-limit',
        };
        if (throttleActive) verdict.action = ladderAction;
        this.logAudit(action, verdict);
        return verdict;
      }
      window.push(now);
      this.perActionWindows.set(action, window);
    } else {
      const effectiveLimit = throttleScale(this.config.maxActionsPerMinute);
      this.recentActions = this.recentActions.filter((t) => t > now - 60_000);
      if (this.recentActions.length >= effectiveLimit) {
        verdict = {
          allowed: false,
          reason: throttleActive
            ? `阶梯限流（${ladderTop!.cause} → ${ladderTop!.level}）：每分钟最多 ${effectiveLimit} 个自主动作`
            : `限流：每分钟最多 ${effectiveLimit} 个自主动作`,
          blockedBy: 'rate-limit',
        };
        if (throttleActive) verdict.action = ladderAction;
        this.logAudit(action, verdict);
        return verdict;
      }
      this.recentActions.push(now);
    }

    // 4. 预算
    if (this.config.tokenBudget > 0 && this.totalTokensUsed >= this.config.tokenBudget) {
      verdict = { allowed: false, reason: `预算耗尽：token 已达上限 ${this.config.tokenBudget}`, blockedBy: 'budget' };
      this.logAudit(action, verdict);
      return verdict;
    }
    if (this.config.costBudget > 0 && this.totalCost >= this.config.costBudget) {
      verdict = { allowed: false, reason: `预算耗尽：成本已达上限 $${this.config.costBudget}`, blockedBy: 'budget' };
      this.logAudit(action, verdict);
      return verdict;
    }

    // 5. 置信度门控（探索动作豁免，探索本身允许低置信）
    if (action !== 'exploration' && confidence < this.config.confidenceThreshold) {
      verdict = { allowed: false, reason: `置信度过低（${confidence.toFixed(2)} < ${this.config.confidenceThreshold}），需人工确认`, blockedBy: 'confidence-gate' };
      this.logAudit(action, verdict);
      return verdict;
    }

    // 放行：门控全部通过，此刻才占用半开探测名额——资格必被使用，
    // recordOutcome（成功闭合/失败重开）负责归还，无泄漏路径
    if (probeCandidate) {
      this.circuitState = 'half-open';
      this.halfOpenProbeInFlight = true;
    }
    verdict = { allowed: true };
    this.logAudit(action, verdict);
    return verdict;
  }

  /**
   * 40.0：挂载首达时间冷却定价（幂等覆盖，挂载即生效）。
   *
   * 熔断打开时的冷却从配置魔数升维为概率定价：观察到的相邻失败间隔
   * （恢复方向的漂移 μ̂ 与波动 σ̂）喂入逆高斯首达模型，二分解出
   * 「P(失败强度恢复 ≤ cooldown) ≥ targetProb」的最小冷却。μ̂ ≤ 0
   * （结构性恶化）时诚实给出 undefined——再等也不会自己好。定价为
   * 建议口径（半开转换时序仍由既有状态机治理）；未挂载零记录零介入。
   */
  attachFirstPassageAdvisor(options?: { targetProb?: number }): void {
    this.firstPassage = { targetProb: Math.min(0.99, Math.max(0.5, options?.targetProb ?? 0.9)) };
  }

  /** 40.0：最近一次首达定价读数（纯读取；未挂载/未打开过熔断返回 undefined） */
  firstPassageView(): { recommendedCooldownMs: number; expectedRecoverMs: number; mu: number; sigma: number; targetProb: number } | undefined {
    return this.lastFirstPassage ? { ...this.lastFirstPassage } : undefined;
  }

  // ─────────────── 第三轮：总督行动阶梯（单调 + 分级冷却 + 结构化理由） ───────────────

  /**
   * 挂载行动阶梯（幂等：重复挂载覆盖选项、保留既有同因状态）。
   *
   * 挂载后 reportThreat(cause) 按「同因上报」驱动严重度单调阶梯：
   * observe → throttle → breaker → kill，每次至多 +1 级；升级到某级后
   * 的冷却期内同因上报被吸收（计数不推进——不跳级不抖动）。
   */
  attachEscalationLadder(options?: EscalationLadderOptions): void {
    const prev = this.ladder;
    this.ladder = {
      cooldowns: {
        observe: options?.cooldowns?.observe ?? 60_000,
        throttle: options?.cooldowns?.throttle ?? 120_000,
        breaker: options?.cooldowns?.breaker ?? 180_000,
      },
      throttleFactor:
        options?.throttleFactor !== undefined && options.throttleFactor > 0 && options.throttleFactor <= 1
          ? options.throttleFactor
          : 0.5,
      clock: options?.clock ?? (() => Date.now()),
      causes: prev?.causes ?? new Map(),
    };
  }

  /**
   * 上报一次威胁，驱动该因的阶梯推进。
   *
   * 推进规则：
   * - 首报 → observe（levelIndex 1，升级计数 1）
   * - 冷却期内再报 → 吸收（strikes++、suppressed++，级别不变）
   * - 冷却期满后首报 → 升一级（至多 +1，kill 为顶）
   * - throttle 级起限流折扣生效（govern() 有效上限 ×= throttleFactor）；
   *   breaker 级打开既有熔断器；kill 级拉起 kill-switch
   *
   * 第四轮（威胁评分挂载后的跳档通道，opt-in）：上报时先读综合威胁分，
   * 分数达某级阈值且该级高于当前级 → 直达该级（越过中间级与冷却——
   * 高危等待比跳档更危险）；分数不高或目标级不高于当前级 → 走上述经典
   * 渐进（逐位保持第三轮行为）。
   *
   * @returns 推进结果（含是否升级 / 是否被冷却吸收 / 是否跳档）
   * @throws Error 阶梯未挂载（先 attachEscalationLadder）
   */
  reportThreat(cause: string, detail?: Record<string, unknown>): {
    level: GovernorLadderLevel;
    levelIndex: number;
    escalated: boolean;
    suppressedByCooldown: boolean;
    strikes: number;
    /** 第四轮：威胁分跳档标记（直达时 true） */
    fastTracked?: boolean;
    /** 第四轮：触发跳档的综合威胁分（跳档时携带） */
    threatScore?: number;
  } {
    if (!this.ladder) {
      throw new Error('行动阶梯未挂载（先 attachEscalationLadder）');
    }
    if (!cause) {
      throw new Error('威胁因不能为空');
    }
    const now = this.ladder.clock();
    // 第四轮：跳档通道（未挂载评分器 → null，经典路径零漂移）
    const fast = this.threatFastTrack();
    const st = this.ladder.causes.get(cause);
    if (!st) {
      if (fast) {
        // 首报即高危：直达阈值档位（不经过 observe/中间级）
        const idx = LADDER_LEVEL_ORDER.indexOf(fast.level);
        this.ladder.causes.set(cause, { level: fast.level, since: now, strikes: 1, escalations: 1, suppressed: 0 });
        this.applyLadderAction(fast.level, cause, now, { ...detail, threatScore: fast.score, fastTracked: true });
        this.recordLadderAction(cause, fast.level, now, 1, fast.score);
        this.emit('ladder-escalated', { cause, to: fast.level, strikes: 1, fastTracked: true, threatScore: fast.score, ...detail });
        return { level: fast.level, levelIndex: idx + 1, escalated: true, suppressedByCooldown: false, strikes: 1, fastTracked: true, threatScore: fast.score };
      }
      this.ladder.causes.set(cause, { level: 'observe', since: now, strikes: 1, escalations: 1, suppressed: 0 });
      this.recordLadderAction(cause, 'observe', now, 1);
      this.emit('ladder-escalated', { cause, to: 'observe', strikes: 1, ...detail });
      return { level: 'observe', levelIndex: 1, escalated: true, suppressedByCooldown: false, strikes: 1 };
    }
    st.strikes += 1;
    const idx = LADDER_LEVEL_ORDER.indexOf(st.level); // 0-based
    const fastIdx = fast ? LADDER_LEVEL_ORDER.indexOf(fast.level) : -1;
    if (fastIdx > idx) {
      // 跳档：目标级严格高于当前级 → 直达（绕过 +1 与冷却）
      st.level = fast!.level;
      st.since = now;
      st.escalations += 1;
      this.applyLadderAction(st.level, cause, now, { ...detail, threatScore: fast!.score, fastTracked: true });
      this.recordLadderAction(cause, st.level, now, st.strikes, fast!.score);
      this.emit('ladder-escalated', { cause, to: st.level, strikes: st.strikes, fastTracked: true, threatScore: fast!.score, ...detail });
      return { level: st.level, levelIndex: fastIdx + 1, escalated: true, suppressedByCooldown: false, strikes: st.strikes, fastTracked: true, threatScore: fast!.score };
    }
    if (now - st.since < this.ladderCooldownMs(idx)) {
      // 冷却内吸收：同因重复触发不跳级、不抖动
      st.suppressed += 1;
      return { level: st.level, levelIndex: idx + 1, escalated: false, suppressedByCooldown: true, strikes: st.strikes };
    }
    const nextIdx = Math.min(LADDER_LEVEL_ORDER.length - 1, idx + 1);
    st.level = LADDER_LEVEL_ORDER[nextIdx];
    st.since = now;
    st.escalations += 1;
    this.applyLadderAction(st.level, cause, now, detail);
    this.recordLadderAction(cause, st.level, now, st.strikes);
    this.emit('ladder-escalated', { cause, to: st.level, strikes: st.strikes, ...detail });
    return { level: st.level, levelIndex: nextIdx + 1, escalated: true, suppressedByCooldown: false, strikes: st.strikes };
  }

  /** 阶梯总览（未挂载 → undefined 诚实降级） */
  ladderView(): LadderView | undefined {
    if (!this.ladder) return undefined;
    const now = this.ladder.clock();
    const causes: LadderCauseState[] = [];
    let maxIdx = 0;
    for (const [cause, st] of this.ladder.causes) {
      const idx = LADDER_LEVEL_ORDER.indexOf(st.level);
      maxIdx = Math.max(maxIdx, idx);
      causes.push({
        cause,
        level: st.level,
        levelIndex: idx + 1,
        since: st.since,
        strikes: st.strikes,
        escalations: st.escalations,
        suppressed: st.suppressed,
        cooldownRemainingMs: Math.max(0, this.ladderCooldownMs(idx) - (now - st.since)),
      });
    }
    causes.sort((a, b) => b.levelIndex - a.levelIndex || a.cause.localeCompare(b.cause));
    return {
      throttleActive: maxIdx >= 1, // throttle 及以上
      breakerActive: maxIdx >= 2,
      killActive: maxIdx === 3,
      causes,
    };
  }

  // ─────────────── 第四轮：安全事件取证（因果链时间线重建） ───────────────

  /**
   * 挂载取证记录器（幂等：重复挂载覆盖选项、保留既有事故）。
   * 挂载后 openIncident / recordSignal / recordAction / recordEffect /
   * closeIncident 记录「信号 → 行动 → 效果」因果链，reconstructIncident
   * 事后完整重建时间线。未挂载时上述全部结构化拒绝（零介入）。
   */
  attachForensics(options?: ForensicsOptions): void {
    const prev = this.forensics;
    this.forensics = {
      clock: options?.clock ?? (() => Date.now()),
      maxEventsPerIncident:
        Number.isInteger(options?.maxEventsPerIncident) && options!.maxEventsPerIncident! > 0
          ? options!.maxEventsPerIncident!
          : 1000,
      maxIncidents:
        Number.isInteger(options?.maxIncidents) && options!.maxIncidents! > 0 ? options!.maxIncidents! : 64,
      order: prev?.order ?? [],
      incidents: prev?.incidents ?? new Map(),
    };
  }

  /**
   * 开启一次事故记录（按事件 ID 聚合的取证容器）。
   * @throws Error 取证未挂载 / 事故 ID 已在记录中（开启或已关闭）
   */
  openIncident(incidentId: string): { opened: boolean } {
    if (!this.forensics) throw new Error('取证记录器未挂载（先 attachForensics）');
    if (!incidentId) throw new Error('事故 ID 不能为空');
    if (this.forensics.incidents.has(incidentId)) {
      throw new Error(`事故已在记录中: ${incidentId}（事故 ID 聚合不可复用）`);
    }
    this.forensics.incidents.set(incidentId, { openedAt: this.forensics.clock(), nextId: 1, events: [] });
    this.forensics.order.push(incidentId);
    while (this.forensics.order.length > this.forensics.maxIncidents) {
      const evicted = this.forensics.order.shift();
      if (evicted !== undefined) this.forensics.incidents.delete(evicted);
    }
    return { opened: true };
  }

  /** 记录一条信号事件（因果链的根——事故为何被注意到） */
  recordSignal(incidentId: string, name: string, detail?: Record<string, unknown>): ForensicEvent {
    return this.recordForensic(incidentId, 'signal', name, detail);
  }

  /** 记录一条行动事件（治理器/运维做了什么；cause 可显式指定因果前驱） */
  recordAction(incidentId: string, name: string, detail?: Record<string, unknown>, cause?: number): ForensicEvent {
    return this.recordForensic(incidentId, 'action', name, detail, cause);
  }

  /** 记录一条效果事件（行动之后系统状态的可观测变化；cause 可显式指定） */
  recordEffect(incidentId: string, name: string, detail?: Record<string, unknown>, cause?: number): ForensicEvent {
    return this.recordForensic(incidentId, 'effect', name, detail, cause);
  }

  /**
   * 关闭事故（归档口径；关闭后不可再记录事件）。
   * @param outcome 处置结论（contained / mitigated / escalated / 自定义）
   */
  closeIncident(incidentId: string, outcome = 'contained'): { closed: boolean } {
    if (!this.forensics) throw new Error('取证记录器未挂载（先 attachForensics）');
    const inc = this.forensics.incidents.get(incidentId);
    if (!inc) throw new Error(`事故不存在: ${incidentId}`);
    if (inc.closedAt !== undefined) throw new Error(`事故已关闭归档: ${incidentId}`);
    inc.closedAt = this.forensics.clock();
    inc.outcome = outcome;
    return { closed: true };
  }

  /**
   * 事后重建事故时间线：回放全部事件并做完整性核验——
   * - consistent：id 严格递增 ∧ 因果引用可解析且指向更早事件 ∧ 时间单调不减；
   * - causalComplete：根事件为 signal 且无前驱、其余事件因果前驱全部可解析；
   * - phaseComplete：signal / action / effect 三相位齐备。
   * @returns 时间线；事故不存在 → undefined
   */
  reconstructIncident(incidentId: string): ForensicTimeline | undefined {
    if (!this.forensics) return undefined;
    const inc = this.forensics.incidents.get(incidentId);
    if (!inc) return undefined;
    const events = [...inc.events].sort((a, b) => a.id - b.id);
    const counts = { signal: 0, action: 0, effect: 0 };
    let idsIncreasing = true;
    let timesMonotone = true;
    let causesResolvable = true;
    let rootIsSignal = true;
    const ids = new Set(events.map((e) => e.id));
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i]!;
      counts[e.phase] += 1;
      if (i > 0 && e.id <= events[i - 1]!.id) idsIncreasing = false;
      if (i > 0 && e.at < events[i - 1]!.at) timesMonotone = false;
      if (e.cause !== undefined && (!ids.has(e.cause) || e.cause >= e.id)) causesResolvable = false;
      if (i === 0 && (e.phase !== 'signal' || e.cause !== undefined)) rootIsSignal = false;
      if (i > 0 && e.cause === undefined) causesResolvable = false;
    }
    const causalComplete =
      events.length > 0 && rootIsSignal && causesResolvable && events.slice(1).every((e) => e.cause !== undefined && ids.has(e.cause));
    return {
      incidentId,
      openedAt: inc.openedAt,
      closedAt: inc.closedAt,
      outcome: inc.outcome,
      events,
      causalChain: events.map((e) => ({ from: e.cause ?? null, to: e.id })),
      causalComplete,
      phaseComplete: counts.signal >= 1 && counts.action >= 1 && counts.effect >= 1,
      counts: { ...counts, total: events.length },
      durationMs: (inc.closedAt ?? this.forensics.clock()) - inc.openedAt,
      consistent: idsIncreasing && timesMonotone && causesResolvable,
    };
  }

  /** 取证台账总览（按开启时刻升序、同刻按 ID 字典序；未挂载 → undefined） */
  forensicsView(): ForensicsIncidentSummary[] | undefined {
    if (!this.forensics) return undefined;
    const out: ForensicsIncidentSummary[] = [];
    for (const [incidentId, inc] of this.forensics.incidents) {
      const timeline = this.reconstructIncident(incidentId)!;
      out.push({
        incidentId,
        openedAt: inc.openedAt,
        closedAt: inc.closedAt,
        outcome: inc.outcome,
        events: inc.events.length,
        counts: { signal: timeline.counts.signal, action: timeline.counts.action, effect: timeline.counts.effect },
        causalComplete: timeline.causalComplete,
      });
    }
    return out.sort((a, b) => a.openedAt - b.openedAt || a.incidentId.localeCompare(b.incidentId));
  }

  /** 取证事件落账（相位包装的内部实现；cause 缺省链接上一事件） */
  private recordForensic(
    incidentId: string,
    phase: ForensicPhase,
    name: string,
    detail?: Record<string, unknown>,
    cause?: number,
  ): ForensicEvent {
    if (!this.forensics) throw new Error('取证记录器未挂载（先 attachForensics）');
    const inc = this.forensics.incidents.get(incidentId);
    if (!inc) throw new Error(`事故不存在: ${incidentId}`);
    if (inc.closedAt !== undefined) throw new Error(`事故已关闭归档，不可再记录: ${incidentId}`);
    if (!name) throw new Error('事件名不能为空');
    if (cause !== undefined && !inc.events.some((e) => e.id === cause)) {
      throw new Error(`因果前驱事件 ${cause} 不存在于事故 ${incidentId}`);
    }
    const id = inc.nextId;
    inc.nextId += 1;
    const event: ForensicEvent = {
      id,
      phase,
      name,
      detail: detail ? { ...detail } : undefined,
      at: this.forensics.clock(),
      cause: cause ?? inc.events[inc.events.length - 1]?.id,
    };
    inc.events.push(event);
    if (inc.events.length > this.forensics.maxEventsPerIncident) inc.events.shift();
    return { ...event };
  }

  // ─────────────── 第四轮：威胁评分（多信号加权 + 阶梯跳档） ───────────────

  /**
   * 挂载威胁评分器（幂等：重复挂载覆盖选项、保留既有信号窗口）。
   * 挂载后 reportThreatSignal 喂入窗口计数，reportThreat 上报时先读
   * 综合威胁分——达阈值且高于当前级 → 直达跳档；未挂载零介入。
   * @throws Error 配置非法（caps/weights 正值、阈值 0 < throttle < breaker < kill ≤ 1）
   */
  attachThreatScorer(options?: ThreatScorerOptions): void {
    const caps = {
      failure: options?.caps?.failure ?? 10,
      anomaly: options?.caps?.anomaly ?? 10,
      unauthorized: options?.caps?.unauthorized ?? 5,
    };
    const rawWeights = {
      failure: options?.weights?.failure ?? 0.4,
      anomaly: options?.weights?.anomaly ?? 0.3,
      unauthorized: options?.weights?.unauthorized ?? 0.3,
    };
    const thresholds = {
      throttle: options?.thresholds?.throttle ?? 0.45,
      breaker: options?.thresholds?.breaker ?? 0.65,
      kill: options?.thresholds?.kill ?? 0.85,
    };
    const kinds: ThreatSignalKind[] = ['failure', 'anomaly', 'unauthorized'];
    const badKind = kinds.find((k) => !Number.isFinite(caps[k]) || caps[k] <= 0 || !Number.isFinite(rawWeights[k]) || rawWeights[k] < 0);
    if (badKind) throw new Error(`威胁评分配置非法：${badKind} 的 cap 须 > 0、weight 须 ≥ 0`);
    if (
      !Number.isFinite(thresholds.throttle) ||
      !Number.isFinite(thresholds.breaker) ||
      !Number.isFinite(thresholds.kill) ||
      thresholds.throttle <= 0 ||
      thresholds.throttle >= thresholds.breaker ||
      thresholds.breaker >= thresholds.kill ||
      thresholds.kill > 1
    ) {
      throw new Error('威胁评分配置非法：阈值须满足 0 < throttle < breaker < kill ≤ 1');
    }
    if (!Number.isFinite(options?.windowMs ?? 60_000) || (options?.windowMs ?? 60_000) <= 0) {
      throw new Error('威胁评分配置非法：windowMs 须 > 0');
    }
    const weightSum = kinds.reduce((s, k) => s + rawWeights[k], 0);
    const weights =
      weightSum > 0
        ? { failure: rawWeights.failure / weightSum, anomaly: rawWeights.anomaly / weightSum, unauthorized: rawWeights.unauthorized / weightSum }
        : { failure: 1 / 3, anomaly: 1 / 3, unauthorized: 1 / 3 };
    this.threat = {
      caps,
      weights,
      thresholds,
      windowMs: options?.windowMs ?? 60_000,
      clock: options?.clock ?? (() => Date.now()),
      signals: this.threat?.signals ?? [],
    };
  }

  /**
   * 喂入一条威胁信号（窗口计数）。
   * @throws Error 评分器未挂载 / 信号种类未知
   */
  reportThreatSignal(kind: ThreatSignalKind, at?: number): { recorded: boolean } {
    if (!this.threat) throw new Error('威胁评分器未挂载（先 attachThreatScorer）');
    if (kind !== 'failure' && kind !== 'anomaly' && kind !== 'unauthorized') {
      throw new Error(`未知威胁信号种类: ${kind}（须为 failure / anomaly / unauthorized）`);
    }
    const now = at ?? this.threat.clock();
    this.threat.signals.push({ kind, at: now });
    this.pruneThreatSignals(now);
    return { recorded: true };
  }

  /**
   * 当前综合威胁分（只读）：窗口计数 → 封顶归一分量 → 加权合成。
   * @returns 评分读数；未挂载 → undefined（零漂移）
   */
  threatScore(): ThreatScoreReading | undefined {
    if (!this.threat) return undefined;
    return this.computeThreatScore();
  }

  /** 评分内核（reportThreat 跳档通道与 threatScore 共用口径） */
  private computeThreatScore(): ThreatScoreReading {
    const t = this.threat!;
    const now = t.clock();
    this.pruneThreatSignals(now);
    const counts: Record<ThreatSignalKind, number> = { failure: 0, anomaly: 0, unauthorized: 0 };
    for (const s of t.signals) counts[s.kind] += 1;
    const kinds: ThreatSignalKind[] = ['failure', 'anomaly', 'unauthorized'];
    const components = kinds.map((kind) => ({
      kind,
      count: counts[kind],
      cap: t.caps[kind],
      subscore: Math.min(1, counts[kind] / t.caps[kind]),
      weight: t.weights[kind],
    }));
    const score = components.reduce((s, c) => s + c.weight * c.subscore, 0);
    let fastTrackLevel: GovernorLadderLevel | null = null;
    if (score >= t.thresholds.kill) fastTrackLevel = 'kill';
    else if (score >= t.thresholds.breaker) fastTrackLevel = 'breaker';
    else if (score >= t.thresholds.throttle) fastTrackLevel = 'throttle';
    const band: ThreatScoreReading['band'] =
      fastTrackLevel === 'kill' ? 'critical' : fastTrackLevel === 'breaker' ? 'high' : fastTrackLevel === 'throttle' ? 'elevated' : 'low';
    return {
      score,
      band,
      components,
      windowMs: t.windowMs,
      signalsInWindow: t.signals.length,
      fastTrackLevel,
      scoredAt: now,
    };
  }

  /** 跳档通道读数（评分器未挂载 → null：经典路径零漂移） */
  private threatFastTrack(): { level: GovernorLadderLevel; score: number } | null {
    if (!this.threat) return null;
    const reading = this.computeThreatScore();
    return reading.fastTrackLevel ? { level: reading.fastTrackLevel, score: reading.score } : null;
  }

  /** 窗口外信号滑出（保留 (now - windowMs, now]） */
  private pruneThreatSignals(now: number): void {
    const cutoff = now - this.threat!.windowMs;
    while (this.threat!.signals.length > 0 && this.threat!.signals[0]!.at <= cutoff) {
      this.threat!.signals.shift();
    }
  }

  // ─────────────── 第四轮：安全合规摘要 ───────────────

  /**
   * 安全合规摘要：审计拦截计数（按 blockedBy 分桶、字典序稳定排序）+
   * 阶梯状态快照 + Kill Switch / 熔断状态。供合规报告导出以结构化
   * 鸭子类型消费（TenantManager.exportComplianceReport 的 governor 源）。
   */
  securitySummary(options?: { auditLimit?: number }): SecuritySummary {
    const limit = options?.auditLimit ?? this.config.auditLimit;
    const entries = this.audit.slice(-limit);
    let allowed = 0;
    let blocked = 0;
    let ladderActions = 0;
    const blockerCounts = new Map<string, number>();
    for (const e of entries) {
      if (e.verdict?.action) ladderActions += 1;
      if (e.verdict?.allowed) allowed += 1;
      else blocked += 1;
      const b = e.verdict?.blockedBy;
      if (b) blockerCounts.set(b, (blockerCounts.get(b) ?? 0) + 1);
    }
    const view = this.ladderView();
    return {
      killSwitchEngaged: this.killSwitchEngaged,
      circuitState: this.circuitState,
      ladder: view
        ? {
            throttleActive: view.throttleActive,
            breakerActive: view.breakerActive,
            killActive: view.killActive,
            causes: view.causes.map((c) => ({
              cause: c.cause,
              level: c.level,
              levelIndex: c.levelIndex,
              since: c.since,
              strikes: c.strikes,
              escalations: c.escalations,
              suppressed: c.suppressed,
              cooldownRemainingMs: c.cooldownRemainingMs,
            })),
          }
        : null,
      incidents: {
        auditEntries: entries.length,
        allowed,
        blocked,
        ladderActions,
        byBlocker: [...blockerCounts.entries()]
          .map(([blocker, count]) => ({ blocker, count }))
          .sort((a, b) => a.blocker.localeCompare(b.blocker)),
        forensics: (this.forensicsView() ?? []).map((f) => ({
          incidentId: f.incidentId,
          openedAt: f.openedAt,
          closedAt: f.closedAt,
          outcome: f.outcome,
          events: f.events,
          causalComplete: f.causalComplete,
        })),
      },
    };
  }

  /** 当前最高严重级同因（无任何上报 → undefined） */
  private topLadderCause(): { cause: string; level: GovernorLadderLevel; since: number; strikes: number } | undefined {
    if (!this.ladder || this.ladder.causes.size === 0) return undefined;
    let top: { cause: string; level: GovernorLadderLevel; since: number; strikes: number } | undefined;
    let topIdx = -1;
    for (const [cause, st] of this.ladder.causes) {
      const idx = LADDER_LEVEL_ORDER.indexOf(st.level);
      if (idx > topIdx || (idx === topIdx && top && st.since < top.since)) {
        topIdx = idx;
        top = { cause, level: st.level, since: st.since, strikes: st.strikes };
      }
    }
    return top;
  }

  /** 某级（0-based index）的冷却时长 */
  private ladderCooldownMs(levelIdx: number): number {
    const cds = this.ladder!.cooldowns;
    if (levelIdx <= 0) return cds.observe;
    if (levelIdx === 1) return cds.throttle;
    return cds.breaker;
  }

  /** 阶梯咬合：升级副作用（breaker 开路既有熔断器；kill 拉起开关） */
  private applyLadderAction(level: GovernorLadderLevel, cause: string, now: number, detail?: Record<string, unknown>): void {
    if (level === 'breaker') {
      if (this.circuitState !== 'open') {
        this.circuitState = 'open';
        this.circuitOpenedAt = now;
        this.emit('breaker-opened', { via: 'ladder', cause, ...detail });
      }
    } else if (level === 'kill') {
      this.killSwitchEngaged = true;
      this.emit('kill-switch-engaged', { via: 'ladder', cause, ...detail });
      this.schedulePersist();
    }
    // observe / throttle 无即时副作用：throttle 在 govern() 的有效限流上限中生效
  }

  /** 阶梯行动入审计（结构化理由；跳档时携带威胁分） */
  private recordLadderAction(
    cause: string,
    level: GovernorLadderLevel,
    since: number,
    strikes: number,
    fastTrackScore?: number,
  ): void {
    const idx = LADDER_LEVEL_ORDER.indexOf(level);
    const blockedBy =
      level === 'kill' ? 'kill-switch' : level === 'breaker' ? 'circuit-breaker' : level === 'throttle' ? 'rate-limit' : undefined;
    this.audit.push({
      timestamp: since,
      action: 'autonomous-execute',
      verdict: {
        allowed: level === 'observe',
        reason:
          `[ladder] ${cause} → ${level}（第 ${strikes} 次上报` +
          (fastTrackScore !== undefined ? `，威胁分 ${fastTrackScore.toFixed(2)} 直达` : '') +
          '）',
        blockedBy,
        action: {
          level,
          cause,
          code: `ladder-${level}`,
          since,
          strikes,
          cooldownRemainingMs: this.ladderCooldownMs(idx),
        },
      },
    });
    if (this.audit.length > this.config.auditLimit) {
      this.audit.splice(0, this.audit.length - this.config.auditLimit);
    }
  }

  /** 由 top 同因生成结构化行动理由（govern 裁决携带） */
  private ladderActionInfo(
    top: { cause: string; level: GovernorLadderLevel; since: number; strikes: number },
  ): GovernorLadderAction {
    const idx = LADDER_LEVEL_ORDER.indexOf(top.level);
    const now = this.ladder!.clock();
    return {
      level: top.level,
      cause: top.cause,
      code: `ladder-${top.level}`,
      since: top.since,
      strikes: top.strikes,
      cooldownRemainingMs: Math.max(0, this.ladderCooldownMs(idx) - (now - top.since)),
    };
  }

  /** 40.0：从失败间隔序列做首达定价（breaker 打开沿调用） */
  private assessFirstPassage(): void {
    if (!this.firstPassage || this.failureTimestamps.length < 4) return;
    const intervals: number[] = [];
    for (let i = 1; i < this.failureTimestamps.length; i += 1) {
      intervals.push(Math.max(1, this.failureTimestamps[i]! - this.failureTimestamps[i - 1]!));
    }
    const estimate = firstPassageCooldown(intervals, { targetProb: this.firstPassage.targetProb });
    if (!estimate || estimate.recommendedCooldown === undefined) return;
    this.lastFirstPassage = {
      recommendedCooldownMs: estimate.recommendedCooldown,
      expectedRecoverMs: estimate.expectedTime ?? estimate.recommendedCooldown,
      mu: estimate.mu,
      sigma: estimate.sigma,
      targetProb: this.firstPassage.targetProb,
    };
  }

  /**
   * 回写动作结果（驱动熔断器与预算统计）
   * @param success 动作是否成功
   * @param tokensUsed 本次消耗 token
   * @param cost 本次成本
   */
  recordOutcome(success: boolean, tokensUsed = 0, cost = 0): void {
    this.totalTokensUsed += tokensUsed;
    this.totalCost += cost;

    if (success) {
      this.consecutiveFailures = 0;
      // 半开状态下成功 → 恢复闭合，释放探测名额
      if (this.circuitState === 'half-open') {
        this.circuitState = 'closed';
        this.halfOpenProbeInFlight = false;
        this.emit('breaker-closed', { via: 'half-open-probe-success' });
      }
    } else {
      this.consecutiveFailures += 1;
      if (this.firstPassage) this.failureTimestamps.push(Date.now());
      if (this.failureTimestamps.length > 64) this.failureTimestamps.splice(0, this.failureTimestamps.length - 64);
      this.emit('action-failed', { consecutiveFailures: this.consecutiveFailures });
      // 半开试探失败 → 重新熔断；连续失败超阈值 → 熔断
      if (this.circuitState === 'half-open') {
        this.halfOpenProbeInFlight = false;
        this.circuitState = 'open';
        this.circuitOpenedAt = Date.now();
        this.emit('breaker-opened', { via: 'half-open-probe-failure' });
      } else if (this.consecutiveFailures >= this.config.circuitFailureThreshold && this.circuitState !== 'open') {
        this.circuitState = 'open';
        this.circuitOpenedAt = Date.now();
        // 40.0：熔断打开即做首达定价——冷却不再是一刀切魔数，而是
        // 「以 target 概率确信失败强度已恢复」的最小等待（逆高斯口径）
        this.assessFirstPassage();
        this.emit('breaker-opened', { via: `consecutive-failures-${this.consecutiveFailures}` });
      }
    }
    this.schedulePersist();
  }

  /**
   * 只读门控检查：不消耗限流配额、不记审计、不改变任何状态。
   * 供宿主融合层等外部治理面使用（govern() 有副作用，会推进限流窗口）。
   * @returns 当前 kill switch / 熔断器是否放行
   */
  checkGate(): { allowed: boolean; reason?: string; blockedBy?: 'kill-switch' | 'circuit-breaker' } {
    if (this.killSwitchEngaged) {
      return { allowed: false, reason: '紧急停止开关已启用', blockedBy: 'kill-switch' };
    }
    if (this.circuitState === 'open') {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed < this.config.circuitCooldownMs) {
        return { allowed: false, reason: `熔断器开启（冷却期剩余 ${Math.ceil((this.config.circuitCooldownMs - elapsed) / 1000)}s）`, blockedBy: 'circuit-breaker' };
      }
    }
    // 与 govern() 同口径：半开试探在途时其余动作暂缓（只读判定，
    // 不占名额、不推进状态）
    if (this.circuitState === 'half-open' && this.halfOpenProbeInFlight) {
      return { allowed: false, reason: '半开试探进行中，其余动作暂缓', blockedBy: 'circuit-breaker' };
    }
    return { allowed: true };
  }

  /**
   * 22.0：预算剩余快照（只读——不消耗限流配额、不记审计、不推进任何状态）。
   * 供预算路由内核（Bandits with Knapsacks）在每次模型选型时读取剩余资源；
   * tokenBudget 与 costBudget 均为 0（不限预算）时返回 undefined
   * （无预算约束即无路由依据，调度器据此走原路径）。
   */
  budgetSnapshot(): { tokensRemaining: number; costRemaining: number } | undefined {
    if (this.config.tokenBudget <= 0 && this.config.costBudget <= 0) return undefined;
    return {
      tokensRemaining: Math.max(0, this.config.tokenBudget - this.totalTokensUsed),
      costRemaining: Math.max(0, this.config.costBudget - this.totalCost),
    };
  }

  /** 启用 Kill Switch */
  engageKillSwitch(): void {
    this.killSwitchEngaged = true;
    this.emit('kill-switch-engaged');
    this.schedulePersist();
  }

  /** 解除 Kill Switch */
  disengageKillSwitch(): void {
    this.killSwitchEngaged = false;
    this.emit('kill-switch-disengaged');
    this.schedulePersist();
  }

  /** Kill Switch 状态 */
  isKillSwitchEngaged(): boolean {
    return this.killSwitchEngaged;
  }

  /** 手动重置熔断器 */
  resetCircuit(): void {
    const wasNonClosed = this.circuitState !== 'closed';
    this.circuitState = 'closed';
    this.consecutiveFailures = 0;
    this.halfOpenProbeInFlight = false;
    if (wasNonClosed) this.emit('breaker-closed', { via: 'manual-reset' });
    this.schedulePersist();
  }

  /** 熔断器状态 */
  getCircuitState(): CircuitState {
    return this.circuitState;
  }

  /** 治理状态摘要 */
  getStatus(): any {
    return {
      killSwitch: this.killSwitchEngaged,
      circuitState: this.circuitState,
      consecutiveFailures: this.consecutiveFailures,
      recentActionsPerMinute: this.recentActions.filter((t) => t > Date.now() - 60_000).length,
      budget: {
        tokensUsed: this.totalTokensUsed,
        tokenBudget: this.config.tokenBudget,
        costUsed: Number(this.totalCost.toFixed(4)),
        costBudget: this.config.costBudget,
      },
      recentAudit: this.audit.slice(-10),
      // 第三轮：行动阶梯面板（未挂载 → undefined 零漂移）
      escalationLadder: this.ladderView(),
      // 15.0：形式验证面板（挂载验证器后输出）
      verification: this.verifier
        ? { formalViolations: { ...this.formalViolations }, ...this.verifier.status() }
        : undefined,
    };
  }

  /** 审计日志 */
  getAudit(limit = 50): GovernanceAuditEntry[] {
    return this.audit.slice(-limit);
  }

  /** 导出可持久化状态（4.0：测试与外部备份通道） */
  exportState(): GovernorPersistState {
    return {
      version: 1,
      totalTokensUsed: this.totalTokensUsed,
      totalCost: this.totalCost,
      circuitState: this.circuitState,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpenedAt: this.circuitOpenedAt,
      killSwitchEngaged: this.killSwitchEngaged,
      auditTail: this.audit.slice(-this.config.auditLimit),
    };
  }

  /** 导入状态（4.0：重启恢复；忽略非法字段） */
  importState(state: Partial<GovernorPersistState>): void {
    if (typeof state.totalTokensUsed === 'number') this.totalTokensUsed = state.totalTokensUsed;
    if (typeof state.totalCost === 'number') this.totalCost = state.totalCost;
    if (state.circuitState === 'closed' || state.circuitState === 'open' || state.circuitState === 'half-open') {
      this.circuitState = state.circuitState;
    }
    if (typeof state.consecutiveFailures === 'number') this.consecutiveFailures = state.consecutiveFailures;
    if (typeof state.circuitOpenedAt === 'number') this.circuitOpenedAt = state.circuitOpenedAt;
    if (typeof state.killSwitchEngaged === 'boolean') this.killSwitchEngaged = state.killSwitchEngaged;
    if (Array.isArray(state.auditTail)) {
      this.audit = state.auditTail.filter((e) => e && typeof e.timestamp === 'number' && typeof e.action === 'string').slice(-this.config.auditLimit);
    }
  }

  /** 立即落盘（dispose 时调用） */
  flushPersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.writePersist();
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /**
   * 15.0：治理事件流出口（挂载验证器时生效）。
   *
   * 事件喂入规约监视器；产出的违规按严重级升级：
   * - critical → Kill Switch（形式裁决获得治理的牙齿）；
   * - warn → 计入失败压力（推动熔断器开路）；
   * - info → 仅计数审计。
   */
  private emit(type: string, detail?: Record<string, unknown>): void {
    if (!this.verifier) return;
    const violations = this.verifier.observe({ type, at: Date.now(), detail });
    for (const violation of violations) {
      this.escalate(violation);
    }
  }

  /** 形式违规升级通道 */
  private escalate(violation: ViolationReport): void {
    this.formalViolations[violation.severity] += 1;
    this.audit.push({
      timestamp: violation.at,
      action: 'autonomous-execute',
      verdict: {
        allowed: false,
        reason: `[formal] 规约 ${violation.specId} 违规（${violation.severity}）：${violation.message}`,
        blockedBy: violation.severity === 'critical' ? 'kill-switch' : 'circuit-breaker',
      },
    });
    if (this.audit.length > this.config.auditLimit) {
      this.audit.splice(0, this.audit.length - this.config.auditLimit);
    }
    if (violation.severity === 'critical') {
      // 形式确证的 critical 违规 → 冻结全部自主行为（证明携带裁决）
      this.killSwitchEngaged = true;
      this.schedulePersist();
    } else if (violation.severity === 'warn') {
      // warn 违规计入失败压力（可能推动熔断开路）
      this.consecutiveFailures += 1;
    }
  }

  /** 记录审计日志 */
  private logAudit(action: GovernedAction, verdict: GovernanceVerdict): void {
    this.audit.push({ timestamp: Date.now(), action, verdict });
    if (this.audit.length > this.config.auditLimit) {
      this.audit.splice(0, this.audit.length - this.config.auditLimit);
    }
  }

  /** 防抖持久化（高频 recordOutcome 不逐次落盘） */
  private schedulePersist(): void {
    if (!this.config.persistPath) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.writePersist();
    }, 1_000);
    this.persistTimer.unref?.();
  }

  /** 原子写持久化状态（失败静默——治理不能因落盘故障停摆） */
  private writePersist(): void {
    const persistPath = this.config.persistPath;
    if (!persistPath) return;
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      const tmp = `${persistPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.exportState()), 'utf-8');
      fs.renameSync(tmp, persistPath);
    } catch {
      /* 持久化失败不阻断治理主流程 */
    }
  }

  /** 启动时恢复持久化状态 */
  private loadPersisted(): void {
    const persistPath = this.config.persistPath;
    if (!persistPath) return;
    try {
      if (!fs.existsSync(persistPath)) return;
      const raw = JSON.parse(fs.readFileSync(persistPath, 'utf-8')) as GovernorPersistState;
      this.importState(raw);
    } catch {
      /* 损坏的状态文件按全新治理器启动 */
    }
  }
}
