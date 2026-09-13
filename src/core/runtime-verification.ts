/**
 * runtime-verification.ts — 运行时验证内核（项目 15.0「安全有了形式语义」质变基座）
 *
 * 升级前的根本局限（安全治理的天花板）：
 * 治理器的全部约束都是**标量门控**——限流是每分钟计数、熔断是连续
 * 失败计数、预算是累计求和。它们各自为政，且只能回答「此刻过不过」：
 * - **时序性失明**：「熔断打开后 10 分钟内必须恢复」「失败风暴不得
 *   在 1 分钟内超过 5 次」「Kill Switch 不得无人认领地挂 24 小时」——
 *   这些真实的安全性质是**事件之间的时序关系**，标量门控表达不了；
 * - **不可证明**：拦截了什么、为什么拦截，只有一条条孤立审计日志；
 *   没有「违反了哪条规约、见证事件序列是什么」的证明结构；
 * - **不可扩展**：新增一条安全性质 = 新写一段门控代码；规约（想要
 *   什么）与实现（怎么检查）耦合，无法由配置声明。
 *
 * 本内核引入运行时验证（Runtime Verification；Dwyer 规约模式谱系，
 * 有限踪时序逻辑 LTLf 的可监视片段）：
 *
 * 1. **声明式规约**：安全性质写成结构化规约（模式 × 参数 × 严重级），
 *    配置即可声明，与执行逻辑彻底解耦。
 *
 * 2. **确定性监视器编译**：每条规约编译为独立 DFA 式监视器——
 *    step(event) 单步推进，O(1) 时间 O(1) 空间，无阻塞、无副作用；
 *    违规判定是确定性的（同一事件流永远同一裁决——可重放审计）。
 *
 * 3. **证明携带裁决（proof-carrying verdicts）**：违规报告携带
 *    **见证轨迹**（触发违规的那段事件序列）——「为什么违规」不再是
 *    一句人话理由，而是可机器重放的证据链。
 *
 * 4. **分级升级通道**：违规按严重级接入既有治理机制——critical
 *    → Kill Switch（冻结自主行为）、warn → 熔断器记败（推动熔断）、
 *    info → 仅审计。形式验证的裁决获得治理的牙齿，治理的牙齿获得
 *    形式的语义。
 *
 * 四类规约模式（Dwyer et al. 规约模式的时序核心）：
 * - absence(p)：p 永不发生
 * - response-deadline(p → q within T)：p 发生后 T 内必须出现 q
 * - bounded-recurrence(p ≤ k within W)：滑动窗口 W 内 p 至多 k 次
 * - precedence(p before q)：q 发生前必须发生过 p
 *
 * 与 3-14.0 的关系：治理器回答「这个动作能不能做」，本内核回答
 * 「这段历史是否满足规约」——一个管未来（门控），一个管过去
 * （监视），合起来才是完整的安全闭环：违规的历史立即关门未来。
 */

// ─────────────────────────── 事件与规约 ───────────────────────────

/** 运行时事件（治理器与宿主生命周期的最小公共语言） */
export interface RuntimeEvent {
  /** 事件类型（如 'action-failed' / 'breaker-opened' / 'kill-switch-engaged'） */
  type: string;
  /** 事件时间戳（缺省 Date.now()） */
  at: number;
  /** 附加上下文（审计用，不参与判定） */
  detail?: Record<string, unknown>;
}

/** 规约模式（Dwyer 谱系的可监视时序核心） */
export type SafetyPattern = 'absence' | 'response-deadline' | 'bounded-recurrence' | 'precedence';

/** 违规严重级（决定升级通道） */
export type ViolationSeverity = 'info' | 'warn' | 'critical';

/** 安全规约（声明式；模式 × 参数 × 严重级） */
export interface SafetySpec {
  /** 规约标识（审计引用） */
  id: string;
  /** 规约模式 */
  pattern: SafetyPattern;
  /** 触发事件类型（所有模式的第一主语） */
  trigger: string;
  /** 响应事件类型（response-deadline：trigger 后 withinMs 内必须出现） */
  responder?: string;
  /** 响应期限毫秒（response-deadline） */
  withinMs?: number;
  /** 窗口内最大次数（bounded-recurrence） */
  maxCount?: number;
  /** 滑动窗口毫秒（bounded-recurrence） */
  windowMs?: number;
  /** 严重级（缺省 warn） */
  severity?: ViolationSeverity;
  /** 人读规约文本 */
  description?: string;
}

/** 监视器状态（违规后终态，直到 reset） */
export type MonitorStatus = 'monitoring' | 'violated';

/** 违规报告（证明携带：见证轨迹 + 规约引用） */
export interface ViolationReport {
  /** 违反的规约 id */
  specId: string;
  pattern: SafetyPattern;
  severity: ViolationSeverity;
  /** 违规时刻 */
  at: number;
  /** 人读违规说明 */
  message: string;
  /** 见证轨迹（触发违规的事件序列，机器可重放） */
  witness: RuntimeEvent[];
  /** 规约原文 */
  spec: SafetySpec;
}

/**
 * 缺省安全规约集（治理器语义的形式化镜像）
 *
 * 1. failure-storm（critical）：60s 窗口失败 ≤ 5 次——熔断阈值的
 *    时序化重述，违规即风暴确证 → Kill Switch；
 * 2. breaker-stuck（warn）：熔断打开后 10 分钟内必须闭合——
 *    「卡死的熔断」比没有熔断更糟（假安全）；
 * 3. kill-switch-left-on（info）：Kill Switch 挂起 24h 内必须解除——
 *    无人认领的紧急停止本身是运维事故。
 */
export function defaultSafetySpecs(failureThreshold = 5): SafetySpec[] {
  return [
    {
      id: 'failure-storm',
      pattern: 'bounded-recurrence',
      trigger: 'action-failed',
      maxCount: failureThreshold,
      windowMs: 60_000,
      severity: 'critical',
      description: `失败风暴上限：60 秒窗口内 action-failed 至多 ${failureThreshold} 次`,
    },
    {
      id: 'breaker-stuck',
      pattern: 'response-deadline',
      trigger: 'breaker-opened',
      responder: 'breaker-closed',
      withinMs: 10 * 60_000,
      severity: 'warn',
      description: '熔断打开后 10 分钟内必须恢复闭合（卡死的熔断 = 假安全）',
    },
    {
      id: 'kill-switch-left-on',
      pattern: 'response-deadline',
      trigger: 'kill-switch-engaged',
      responder: 'kill-switch-disengaged',
      withinMs: 24 * 3_600_000,
      severity: 'info',
      description: 'Kill Switch 挂起 24 小时内必须解除或人工认领',
    },
  ];
}

// ─────────────────────────── 单规约监视器 ───────────────────────────

/**
 * 规约监视器（模式专用 DFA；违规后终态）
 *
 * 每个监视器独立持有最小状态；step() 纯事件驱动，tick() 处理
 * 期限到期（deadline 类模式的「沉默违规」——不响应也是违规）。
 */
export class SafetyMonitor {
  public readonly spec: SafetySpec;
  private status: MonitorStatus = 'monitoring';
  private pendingDeadlines: Array<{ since: number; events: RuntimeEvent[] }> = [];
  private windowEvents: RuntimeEvent[] = [];
  private sawTrigger = false;
  private recentTrace: RuntimeEvent[] = [];

  constructor(spec: SafetySpec) {
    this.spec = spec;
  }

  /** 当前状态（violated 为终态，直到 reset） */
  get monitorStatus(): MonitorStatus {
    return this.status;
  }

  /** 是否仍在监视（未违规） */
  get active(): boolean {
    return this.status === 'monitoring';
  }

  /**
   * 推进一个事件；返回该步产生的违规（至多一条）。
   * 已终态（violated）的监视器静默吞事件（违规只报一次）。
   */
  step(event: RuntimeEvent): ViolationReport | undefined {
    this.remember(event);
    if (this.status === 'violated') return undefined;
    switch (this.spec.pattern) {
      case 'absence':
        if (event.type === this.spec.trigger) return this.violate(event, `禁止事件 ${this.spec.trigger} 发生`, [event]);
        return undefined;
      case 'response-deadline':
        if (event.type === this.spec.trigger) {
          this.pendingDeadlines.push({ since: event.at, events: [event] });
        } else if (event.type === this.spec.responder) {
          this.pendingDeadlines = [];
        }
        return undefined;
      case 'bounded-recurrence':
        if (event.type === this.spec.trigger) {
          const windowMs = this.spec.windowMs ?? 60_000;
          this.windowEvents = this.windowEvents.filter((e) => e.at > event.at - windowMs);
          this.windowEvents.push(event);
          const max = this.spec.maxCount ?? 1;
          if (this.windowEvents.length > max) {
            return this.violate(
              event,
              `窗口 ${windowMs}ms 内 ${this.spec.trigger} 达 ${this.windowEvents.length} 次（上限 ${max}）`,
              [...this.windowEvents],
            );
          }
        }
        return undefined;
      case 'precedence':
        if (event.type === this.spec.trigger) {
          this.sawTrigger = true;
        } else if (event.type === this.spec.responder && !this.sawTrigger) {
          return this.violate(event, `${this.spec.responder} 出现但此前从未发生 ${this.spec.trigger}`, [event]);
        }
        return undefined;
      default:
        return undefined;
    }
  }

  /**
   * 期限检查（沉默违规）：response-deadline 的未决义务到期未响应。
   * 由 Verifier.observe 在每个事件后以当前时间调用。
   */
  tick(now: number): ViolationReport | undefined {
    if (this.status === 'violated' || this.spec.pattern !== 'response-deadline') return undefined;
    const withinMs = this.spec.withinMs ?? 60_000;
    const expired = this.pendingDeadlines.filter((d) => now - d.since > withinMs);
    if (expired.length === 0) return undefined;
    const witness = expired.flatMap((d) => d.events);
    this.pendingDeadlines = [];
    return this.violate(
      { type: 'deadline-expired', at: now },
      `${this.spec.trigger} 后 ${withinMs}ms 内未出现 ${this.spec.responder}（${expired.length} 项义务到期）`,
      witness,
    );
  }

  /** 重置监视器（运维动作：规约解除后重新武装） */
  reset(): void {
    this.status = 'monitoring';
    this.pendingDeadlines = [];
    this.windowEvents = [];
    this.sawTrigger = false;
    this.recentTrace = [];
  }

  /** 未决义务数（response-deadline 的在途压力；运维可观测） */
  get pendingObligations(): number {
    return this.pendingDeadlines.length;
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  private remember(event: RuntimeEvent): void {
    this.recentTrace.push(event);
    if (this.recentTrace.length > 16) this.recentTrace.shift();
  }

  private violate(at: RuntimeEvent, message: string, witness: RuntimeEvent[]): ViolationReport {
    this.status = 'violated';
    return {
      specId: this.spec.id,
      pattern: this.spec.pattern,
      severity: this.spec.severity ?? 'warn',
      at: at.at,
      message,
      witness,
      spec: this.spec,
    };
  }
}

// ─────────────────────────── 运行时验证器 ───────────────────────────

/** 验证器状态报告 */
export interface RuntimeVerifierStatus {
  /** 注册规约数 */
  specs: number;
  /** 仍在监视的监视器数 */
  activeMonitors: number;
  /** 已违规终态的监视器数 */
  violatedMonitors: number;
  /** 累计违规报告数 */
  totalViolations: number;
  /** 按严重级分组的违规计数 */
  bySeverity: Record<ViolationSeverity, number>;
  /** 已观察事件总数 */
  eventsObserved: number;
  /** 在途义务数（response-deadline 未决） */
  pendingObligations: number;
  /** 各规约的最近违规（id → 报告） */
  lastViolations: Array<{ specId: string; severity: ViolationSeverity; message: string }>;
  interpretation: string;
}

/**
 * 运行时验证器
 *
 * observe(event) 单口进食：内部先跑各监视器 tick（期限到期检查），
 * 再 step（事件推进）；返回本步产生的全部违规（按严重级降序）。
 * 违规的监视器进入终态（同一规约只报一次），运维可 resetMonitor
 * 重新武装。全部判定确定性可重放：同一事件流 → 同一违规集。
 */
export class RuntimeVerifier {
  private readonly monitors: SafetyMonitor[] = [];
  private readonly violations: ViolationReport[] = [];
  private eventsObserved = 0;

  constructor(specs: SafetySpec[] = defaultSafetySpecs()) {
    for (const spec of specs) this.monitors.push(new SafetyMonitor(spec));
  }

  /** 注册附加规约（动态扩展；幂等 by id） */
  register(spec: SafetySpec): void {
    if (this.monitors.some((m) => m.spec.id === spec.id)) return;
    this.monitors.push(new SafetyMonitor(spec));
  }

  /** 移除规约 */
  unregister(specId: string): boolean {
    const index = this.monitors.findIndex((m) => m.spec.id === specId);
    if (index < 0) return false;
    this.monitors.splice(index, 1);
    return true;
  }

  /** 规约清单（只读） */
  get specs(): SafetySpec[] {
    return this.monitors.map((m) => m.spec);
  }

  /**
   * 观察一个事件：期限检查 → 事件推进 → 收集违规。
   * @returns 本步产生的违规（critical 优先；通常为空）
   */
  observe(event: RuntimeEvent): ViolationReport[] {
    const enriched: RuntimeEvent = { ...event, at: event.at ?? Date.now() };
    this.eventsObserved += 1;
    const produced: ViolationReport[] = [];
    for (const monitor of this.monitors) {
      const deadlineViolation = monitor.tick(enriched.at);
      if (deadlineViolation) produced.push(deadlineViolation);
      const eventViolation = monitor.step(enriched);
      if (eventViolation) produced.push(eventViolation);
    }
    if (produced.length > 0) {
      this.violations.push(...produced);
      produced.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
    }
    return produced;
  }

  /** 重新武装一条规约（终态 → 监视） */
  resetMonitor(specId: string): boolean {
    const monitor = this.monitors.find((m) => m.spec.id === specId);
    if (!monitor) return false;
    monitor.reset();
    return true;
  }

  /** 全部违规历史（审计通道；proof-carrying） */
  get violationHistory(): ViolationReport[] {
    return [...this.violations];
  }

  /** 验证器状态 */
  status(): RuntimeVerifierStatus {
    const bySeverity: Record<ViolationSeverity, number> = { info: 0, warn: 0, critical: 0 };
    for (const v of this.violations) bySeverity[v.severity] += 1;
    const active = this.monitors.filter((m) => m.active);
    const violated = this.monitors.filter((m) => !m.active);
    const lastViolations = [...this.violations]
      .reverse()
      .slice(0, 5)
      .map((v) => ({ specId: v.specId, severity: v.severity, message: v.message }));
    const interpretation =
      this.monitors.length === 0
        ? '运行时验证器空载（register 注册安全规约）'
        : this.violations.length === 0
          ? `${this.monitors.length} 条规约全部在监（${this.eventsObserved} 事件，零违规）`
          : bySeverity.critical > 0
            ? `已确证 critical 违规 ${bySeverity.critical} 次（应触发 Kill Switch 通道）`
            : `违规 ${this.violations.length} 次（warn ${bySeverity.warn} / info ${bySeverity.info}），${active.length} 条规约在监`;
    return {
      specs: this.monitors.length,
      activeMonitors: active.length,
      violatedMonitors: violated.length,
      totalViolations: this.violations.length,
      bySeverity,
      eventsObserved: this.eventsObserved,
      pendingObligations: this.monitors.reduce((sum, m) => sum + m.pendingObligations, 0),
      lastViolations,
      interpretation,
    };
  }
}

function severityRank(severity: ViolationSeverity): number {
  return severity === 'critical' ? 3 : severity === 'warn' ? 2 : 1;
}
