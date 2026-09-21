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

/** 治理裁决 */
export interface GovernanceVerdict {
  allowed: boolean;
  /** 拦截原因（allowed=false 时） */
  reason?: string;
  /** 拦截类别 */
  blockedBy?: 'kill-switch' | 'rate-limit' | 'budget' | 'circuit-breaker' | 'confidence-gate';
}

/** 治理审计条目 */
export interface GovernanceAuditEntry {
  timestamp: number;
  action: GovernedAction;
  verdict: GovernanceVerdict;
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

    // 1. Kill Switch（最高优先级）
    if (this.killSwitchEngaged) {
      verdict = { allowed: false, reason: '紧急停止开关已启用', blockedBy: 'kill-switch' };
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

    // 3. 限流（4.0：perActionRateLimits 命中的动作走独立窗口，其余共享全局）
    const now = Date.now();
    const perActionLimit = this.config.perActionRateLimits?.[action];
    if (perActionLimit !== undefined) {
      const window = (this.perActionWindows.get(action) ?? []).filter((t) => t > now - 60_000);
      if (window.length >= perActionLimit) {
        verdict = { allowed: false, reason: `限流：动作 ${action} 每分钟最多 ${perActionLimit} 次`, blockedBy: 'rate-limit' };
        this.logAudit(action, verdict);
        return verdict;
      }
      window.push(now);
      this.perActionWindows.set(action, window);
    } else {
      this.recentActions = this.recentActions.filter((t) => t > now - 60_000);
      if (this.recentActions.length >= this.config.maxActionsPerMinute) {
        verdict = { allowed: false, reason: `限流：每分钟最多 ${this.config.maxActionsPerMinute} 个自主动作`, blockedBy: 'rate-limit' };
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
  recordOutcome(success: boolean, tokensUsed = 0, cost = 0): void {    this.totalTokensUsed += tokensUsed;
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
