/**
 * task-executor.ts — 任务执行组件（新架构「模型调度 → 任务执行」）
 *
 * 职责（对应架构图「任务执行（原有）」框）：
 * - 计划生成：strategist 输出 DAG 解析 + 离线兜底计划
 * - 并行执行：拓扑分层并行执行子任务，全局超时中止，动态并行度分批
 * - 质量反思：quality < threshold 自动重试或经模型调度切换模型（最多 maxRetries 次）
 * - 级联触发：节点完成且质量达标时触发下游信号
 *
 * 闭环边界（新架构单向数据流）：
 * - 模型分配委托模型调度器（model-scheduler.ts），优化器推荐模型经 recommendedModels 喂入
 * - 经验检索 / 快路径召回由优化器（optimizer.ts）负责
 * - 执行后反思 / 记忆更新由反思器（reflector.ts）负责，本组件不写记忆
 *
 * 升级点（相对串行执行的质的提升）：
 * 1. 拓扑分层并行：同层节点并发执行，依赖未就绪的节点自动顺延
 * 2. 质量反思闭环：重试优先原模型，重试耗尽前尝试切换到次优模型
 * 3. nodeRunner 可注入：默认走 LLMClient，冒烟测试可完全离线模拟
 * 4. 全链路进度事件广播（plan-start / node-start / node-complete /
 *    node-error / node-reflect / cascade-trigger / plan-complete）
 *
 * 第三轮·世界性升级（模块域 A4，10 步链路第 6/7 步）——六项质级升级：
 * 5. EDF 截止期感知调度（A4-1）：attachDeadlineScheduling 挂载后，同拓扑层内
 *    按「最早截止期优先」重排派发序（executePlan({ deadlines }) 提供节点级
 *    绝对截止期；无截止期 = +∞ 排队尾，缺省不挂载 = FIFO 原序，逐位零漂移）。
 * 6. 尾延迟对冲请求（A4-2）：attachHedging 挂载后，节点执行超过 P95 阈值即
 *    并行发出对冲副本，先到先得、多余副本取消，对冲次数/额外 token/节省延迟
 *    全量记账（未挂载零介入）。
 * 7. 计划级重试预算（A4-3）：config.planRetryBudget 给每份计划一个重试总配额
 *    （所有节点重试次数之和的上限），防止节点级 maxRetries 在多节点上叠加成
 *    重试风暴；超预算的节点放弃重试、向上诚实报告「部分完成 + 原因」。
 * 8. 取消传播与部分检查点（A4-4）：executePlan({ cancelSignal }) 外部取消时向
 *    在途节点传播中止，已完成节点的部分结果保留为 checkpoint；
 *    resumePlan(signal, plan, checkpoint) 续跑时复用检查点、只执行剩余节点。
 * 9. 执行审计（A4-5）：每计划一份事件流（plan/node × start/complete/retry/
 *    hedge/cancel/checkpoint），随结果返回并可 exportAuditTrail() 导出。
 * 10. 确定性模拟底座（A4-6）：attachClock(VirtualClock) 注入虚拟时钟——全局/
 *     节点超时、退避等待、时间戳全部切换到虚拟时间轴，由注入的假 nodeRunner
 *     推进（不用真定时器），种子化模拟可复现；未挂载走真实 Date.now/setTimeout。
 *
 * 第四轮·世界性升级（模块域 R4-A4，激活与深化）——五项全新维度（全部 opt-in，
 * 未挂载逐位零漂移；虚拟时钟/种子化纪律与第三轮一致）：
 * 11. 并行度自适应（R4-1）：attachAdaptiveParallelism 挂载后，同层派发批宽
 *     不再固定取调度容量，而是按「节点/ms」实测吞吐做简单爬山——收益超出
 *     边际才认提升、最优宽度的双向邻居都试过才收敛、收敛后吞吐跌破退化线
 *     才重启探索（三重迟滞防震）；批宽经 runner 参数 batchWidth 透出（可选
 *     字段，注入 runner 可据此建模吞吐环境，旧 runner 忽略无感）。
 * 12. 失败域隔离（R4-2）：attachFailureDomains 挂载后，可用性熔断的裁决粒度
 *     从「模型级」收紧为「模型×任务类型」失败域簇级——单簇连续可用性失败
 *     只熔断该簇（同模型其他任务类型簇不受影响，不再殃及池鱼）；簇熔断后
 *     先重定向健康簇的模型，全候选降温时诚实等待冷却（虚拟时钟口径）。
 * 13. 进度估计 ETA（R4-3）：attachEtaEstimator 挂载后，按任务类型的节点历史
 *     时长分布分位数（P10/P50/P90，最近邻上取整口径）给出计划级剩余时间
 *     点估计与置信区间（逐节点分位数求和的保守区间）；计划执行中逐批落
 *     检查点，报告随附中位相对误差与区间覆盖率（事后对账口径）。
 * 14. 计划压缩（R4-4）：compressPlan 纯函数（免挂载）——重复节点合并（同
 *     操作 + 同直接依赖 + 同模型/超时/级联的节点并为一）与传递依赖边简化
 *     （可由其余依赖的传递闭包到达的边删除）；语义等价口径为「节点输出 =
 *     f(操作, 输入闭包取值)」（闭包取值不变 ⇒ 输出不变），节点数与执行调用数同降。
 * 15. 失败注入演练（R4-5，加分项）：attachChaosInjection 挂载后，在 runner
 *     调用前按规则注入失败（kind = error / timeout / low-quality；按节点/
 *     任务类型/尝试次数匹配、可限次命中，确定性逐次记账）——timeout 注入
 *     在虚拟时钟下先推进挂起时长再抛（可途经对冲阈值定时器，验证对冲与
 *     注入协同），low-quality 走质量反思换模路径——用于验证重试 / 换模型 /
 *     对冲 / 检查点续跑全链路恢复路径协同工作。
 */

import crypto from 'node:crypto';
import { TimeoutError } from './errors.js';
import type { LLMClient } from './llm-client.js';
import { parseJSONLoose } from './llm-client.js';
import type { ModelScheduler } from './model-scheduler.js';
import type { ProgressBroadcaster } from './progress-ws.js';
import type { ReflectionEngine } from './reflection-engine.js';
import type { Signal } from './sentinel.js';
import { ExecutionError, type CascadeHandler, type ExecutionPlan, type NodeResult, type NodeRunner, type PlanExecutionResult, type PlanNode } from './types.js';
import { CircuitBreakerRegistry, abortableSleep, backoffDelayMs, classifyError } from './core/resilience.js';
import { assignBatch } from './core/optimal-assignment.js';
// 创世纪 52.0/54.0：测试时计算投票预算 / Lyapunov 背压账本
import { TestTimeComputePlanner, BackpressureLedger } from './engines-frontier/genesis25.js';

// 第二轮创世纪 85.0/86.0/87.0：符号求解（计划可行性静态裁决）/ 分层技能
// （SMDP 时间信用分配）/ 安全屏障（逐动作微分安全过滤）
import {
  planFeasibilityVerdict,
  optionsSkillAudit,
  quotaGuardAction,
  type CbfResult,
  type FeasibilityNodeInput,
  type OptionsSkillAuditView,
  type PlanFeasibilityView,
  type QuotaGuardState,
} from './engines-frontier/autonomy25.js';

// ═══════════════ A4-6：虚拟时钟（确定性模拟底座） ═══════════════

/** 定时器句柄（与 clearTimeout 同义的取消语义） */
export interface ExecutorTimerHandle {
  cancel(): void;
}

interface VirtualTimerEntry {
  id: number;
  at: number;
  callback: () => void;
  done: boolean;
}

/**
 * A4-6：虚拟时钟——确定性时间推进（attachClock 注入后生效）。
 *
 * 全部计时语义（全局超时 / 节点超时 / 对冲阈值 / 退避等待 / 时间戳）切换到
 * 单条虚拟时间轴：`advance(ms)` 由注入的假 nodeRunner 调用推进，途中到期的
 * 定时器按「到期时刻升序、同刻按注册序」同步触发（可安全重入——定时器回调
 * 内再次 advance 不会破坏外层推进的目标刻）。不发真定时器、不碰事件循环，
 * 同一种子 + 同一推进序列 ⇒ 逐位可复现。
 *
 * 配套契约：虚拟时钟模式下注入的 nodeRunner 应在进入函数体时同步调用
 * `clock.advance(延迟)`（而非先 await 再推进），并把 `completedAt: clock.now()`
 * 随结果返回——执行器据此裁定对冲「先到先得」的虚拟到达序。
 */
export class VirtualClock {
  private nowMs: number;
  private timers: VirtualTimerEntry[] = [];
  private seq = 0;

  constructor(startMs: number = 0) {
    this.nowMs = Math.max(0, Math.floor(startMs));
  }

  /** 当前虚拟时刻（毫秒） */
  now(): number {
    return this.nowMs;
  }

  /**
   * 推进虚拟时间：先逐步触发途中到期的定时器（触发时刻精确落位），最后落到
   * 目标时刻。定时器回调内若再次 advance（重入），内层先于外层完成，互不越界。
   */
  advance(ms: number): number {
    const target = this.nowMs + Math.max(0, Math.floor(ms));
    for (;;) {
      let pick: VirtualTimerEntry | undefined;
      for (const timer of this.timers) {
        if (timer.done || timer.at > target) continue;
        if (!pick || timer.at < pick.at || (timer.at === pick.at && timer.id < pick.id)) pick = timer;
      }
      if (!pick) break;
      pick.done = true;
      if (pick.at > this.nowMs) this.nowMs = pick.at;
      pick.callback();
    }
    if (target > this.nowMs) this.nowMs = target;
    return this.nowMs;
  }

  /** 挂一个虚拟定时器（返回取消句柄；定时器在 advance 途经时同步触发） */
  setTimeout(callback: () => void, ms: number): ExecutorTimerHandle {
    const entry: VirtualTimerEntry = { id: ++this.seq, at: this.nowMs + Math.max(0, Math.floor(ms)), callback, done: false };
    this.timers.push(entry);
    return {
      cancel: () => {
        entry.done = true;
      },
    };
  }

  /** 尚未触发且未取消的定时器数（诊断口径） */
  pendingTimers(): number {
    return this.timers.filter((t) => !t.done).length;
  }
}

// ═══════════════ A4 公开类型 ═══════════════

/** A4-2：尾延迟对冲挂载选项 */
export interface HedgingOptions {
  /** 对冲阈值（毫秒）：主请求在飞超过该值即发副本，缺省 = 节点超时的一半 */
  delayMs?: number;
  /** 每节点最大对冲副本数（缺省 1；对冲与重试独立记账，不占重试预算） */
  maxHedgesPerNode?: number;
}

// ═══════════════ R4 公开类型（第四轮·全新维度，全部 opt-in） ═══════════════

/** R4-1：并行度自适应挂载选项（爬山 + 三重迟滞） */
export interface AdaptiveParallelismOptions {
  /** 初始批宽（缺省 = 最小宽 1——最保守起步，逐级爬升） */
  initialWidth?: number;
  /** 批宽下限（缺省 1） */
  minWidth?: number;
  /** 批宽上限（缺省 = 本计划调度容量钳位值：min(computeParallelism, maxInFlightNodes)） */
  maxWidth?: number;
  /** 吞吐收益边际（相对值，缺省 0.05）：新批宽吞吐须超出最优记录 ×(1+margin) 才认提升 */
  gainMargin?: number;
  /** 退化线（相对值，缺省 0.5）：收敛后吞吐跌破最优记录 ×(1−margin) 才重启探索 */
  degradeMargin?: number;
}

/** R4-1：单次吞吐观测（一个完整批宽的批：宽度 / 节点数 / 虚拟或墙钟毫秒 / 吞吐） */
export interface AdaptiveParallelismObservation {
  width: number;
  nodes: number;
  ms: number;
  /** 吞吐（节点/ms） */
  nodesPerMs: number;
}

/** R4-1：并行度自适应账单（挂载后随报告返回） */
export interface AdaptiveParallelismReport {
  /** 爬山收敛认定的最优批宽（观测期内的最优吞吐宽度） */
  settledWidth: number;
  /** 每个被观测批的宽度序列（按观测序） */
  widthHistory: number[];
  /** 每个被观测批的吞吐账单（按观测序） */
  throughputHistory: AdaptiveParallelismObservation[];
  /** 是否已收敛（最优宽度的双向邻居都已试过 / 出界） */
  converged: boolean;
}

/** R4-2：失败域隔离挂载选项（失败域 = 模型 × 任务类型） */
export interface FailureDomainOptions {
  /** 同簇连续可用性失败阈值（缺省 3），达到即熔断该簇 */
  failureThreshold?: number;
  /** 簇熔断冷却期（毫秒，缺省 60s；虚拟时钟下为虚拟毫秒），期满放行试探 */
  cooldownMs?: number;
}

/** R4-2：失败域快照条目（failureDomainSnapshot() 读数） */
export interface FailureDomainStatus {
  state: 'closed' | 'open';
  consecutiveFailures: number;
  /** 冷却剩余毫秒（open 态在场；虚拟时钟下为虚拟毫秒） */
  cooldownRemainingMs?: number;
}

/** R4-3：ETA 挂载选项（节点历史时长分布 → 剩余时间分位数估计） */
export interface EtaEstimatorOptions {
  /** 每任务类型的历史窗口大小（缺省 64，先进先出） */
  windowSize?: number;
  /** 预置历史（任务类型 → 历史时长数组，离线校准口径；真实执行会继续追记） */
  seedHistory?: Record<string, ReadonlyArray<number>>;
  /** 无历史类型的缺省中位时长（毫秒，缺省 1000；区间按 ±50%/±100% 取） */
  defaultP50Ms?: number;
  /** 置信区间下分位（缺省 0.1） */
  lowQuantile?: number;
  /** 置信区间上分位（缺省 0.9） */
  highQuantile?: number;
}

/** R4-3：ETA 检查点（计划执行中逐批记录：时刻 / 已完成 / 剩余 / 点估计与区间） */
export interface EtaCheckpoint {
  t: number;
  completed: number;
  remaining: number;
  /** 剩余时间点估计（剩余节点 P50 之和，毫秒） */
  pointMs: number;
  /** 置信区间下界（剩余节点低分位之和——独立求和的保守区间） */
  loMs: number;
  /** 置信区间上界（剩余节点高分位之和） */
  hiMs: number;
}

/** R4-3：ETA 账单（挂载后随报告返回；误差对账字段在计划收尾时计算） */
export interface EtaReport {
  checkpoints: EtaCheckpoint[];
  /** 各检查点 |点估计 − 实际剩余| / 实际剩余 的中位数（计划收尾时在场） */
  medianRelError?: number;
  /** 实际剩余时间落入 [lo, hi] 的检查点占比（≥ 目标覆盖率即达标） */
  coverage?: number;
  /** 目标覆盖率 = highQuantile − lowQuantile（P10~P90 ⇒ 0.8） */
  targetCoverage: number;
}

/** R4-4：计划压缩账单（compressPlan 返回） */
export interface PlanCompressionStats {
  nodesBefore: number;
  nodesAfter: number;
  /** 每组：[canonical, ...被合并的重复节点 id] */
  mergedGroups: string[][];
  /** 被删除的传递依赖边（from → to 经由 via 可达） */
  transitiveEdgesRemoved: Array<{ from: string; to: string; via: string }>;
}

/** R4-5：失败注入规则（attachChaosInjection） */
export interface ChaosRule {
  /** 匹配节点 id（缺省任意） */
  nodeId?: string;
  /** 匹配任务类型（缺省任意） */
  taskType?: string;
  /** 匹配尝试序号（1 起；缺省任意） */
  attempt?: number;
  /** 注入类型：error = 未知错误（fatal，验证检查点路径）；timeout = 超时（可重试，
   * 虚拟时钟下先推进挂起时长——可途经对冲阈值定时器）；low-quality = 低质产出
   * （走质量反思换模路径） */
  kind: 'error' | 'timeout' | 'low-quality';
  /** 命中次数上限（缺省 1；用于「第 1 次失败、第 2 次成功」的演练序列） */
  hits?: number;
  /** kind = timeout 的挂起时长（毫秒，缺省 = 节点超时） */
  hangMs?: number;
}

/** R4-5：失败注入账本条目（chaosLedger() 读数） */
export interface ChaosLedgerEntry {
  /** 规则序号（attachChaosInjection 传入序） */
  rule: number;
  kind: ChaosRule['kind'];
  fired: number;
}

/** A4-5：执行审计事件（每计划一份事件流，随结果返回 / exportAuditTrail 导出） */
export interface ExecutorAuditEvent {
  /** 事件时刻（虚拟时钟模式下为虚拟毫秒，否则墙钟毫秒） */
  t: number;
  type:
    | 'plan-start'
    | 'plan-complete'
    | 'plan-cancel'
    | 'plan-checkpoint'
    | 'layer-edf'
    | 'node-start'
    | 'node-complete'
    | 'node-error'
    | 'node-retry'
    | 'node-hedge'
    | 'hedge-win'
    | 'hedge-cancel'
    | 'node-cancel'
    // 第四轮增量（未挂载对应能力时永不出现）
    | 'parallelism-adapt'
    | 'domain-open'
    | 'domain-wait'
    | 'chaos-inject';
  planId?: string;
  nodeId?: string;
  attempt?: number;
  detail?: string;
}

/** A4：executePlan / resumePlan 扩展选项（全部可选，旧调用面零漂移） */
export interface PlanExecutionOptions {
  /** 4.0：经验规避模型（调度与重试全程排除） */
  avoidModels?: string[];
  /** A4-4：外部取消信号——触发即向在途节点传播中止，已完成节点保留为检查点 */
  cancelSignal?: AbortSignal;
  /** A4-1：节点级绝对截止期（毫秒时间戳，与 signal.deadlineMs 同口径）——挂载 EDF 后参与层内排序 */
  deadlines?: Record<string, number>;
}

/** A4-4：部分检查点（取消/中止/失败时已完成节点的结果，续跑可复用） */
export interface PlanCheckpoint {
  planId: string;
  objective: string;
  savedAt: number;
  completed: NodeResult[];
}

/** A4：计划执行报告（PlanExecutionResult 的超集——旧消费面按子集读取，兼容） */
export interface PlanExecutionReport extends PlanExecutionResult {
  /** 计划终态：跑完 = 'completed'（缺席同义）；取消/中止后部分完成 = 'cancelled' */
  status?: 'completed' | 'cancelled';
  /** 同层调度口径：'edf'（挂载 EDF 且传入 deadlines）/ 'fifo'（缺省原序） */
  scheduling?: 'fifo' | 'edf';
  /** 计划未完成时的部分检查点（≥1 个成功节点即在场，续跑经 resumePlan 复用） */
  checkpoint?: PlanCheckpoint;
  /** 计划级重试预算账单（配置 planRetryBudget 时在场） */
  retryBudget?: { limit: number; used: number; exhausted: boolean };
  /** 尾延迟对冲账单（挂载 attachHedging 时在场：对冲次数 / 额外 token / 节省延迟 / 取消副本数） */
  hedging?: { count: number; extraTokens: number; savedMs: number; canceled: number };
  /** 执行审计事件流（全量在场——导出口径） */
  audit?: ExecutorAuditEvent[];
  /** resumePlan 专用：从检查点复用的节点数 */
  resumedFromCount?: number;
  /** R4-1：并行度自适应账单（挂载 attachAdaptiveParallelism 时在场） */
  adaptiveParallelism?: AdaptiveParallelismReport;
  /** R4-3：ETA 账单（挂载 attachEtaEstimator 时在场：检查点 / 中位误差 / 覆盖率） */
  eta?: EtaReport;
}

/** 计划执行上下文（每计划一份：重试预算 / 对冲账本 / 审计流 / 取消旗标 / R4 增量账本） */
interface PlanRunContext {
  audit: ExecutorAuditEvent[];
  retry: { limit: number; used: number };
  hedge: { count: number; extraTokens: number; savedMs: number; canceled: number };
  externalCancel: boolean;
  /** R4-1：当前派发批宽（透传给注入 runner 的 batchWidth——环境建模口径） */
  dispatchWidth?: number;
  /** R4-3：ETA 检查点流（挂载估计器时逐批落点） */
  etaCheckpoints: EtaCheckpoint[];
}

/** 单次尝试的运行结果（completedAt：注入 runner 自报的虚拟完成时刻，可缺席） */
interface AttemptOutcome {
  output: string;
  quality: number;
  tokensUsed?: number;
  completedAt?: number;
}

/** 对冲飞行记录（label 区分主请求 / 对冲副本；completedAt 为虚拟到达时刻） */
interface HedgeFlightRecord {
  label: 'primary' | 'hedge';
  ok: boolean;
  value?: AttemptOutcome;
  failure?: unknown;
  completedAt: number;
  settleOrder: number;
}

/** 从任意结算值中读取注入 runner 自报的 completedAt（缺席为 undefined） */
function readCompletedAt(value: unknown): number | undefined {
  const holder = value as { completedAt?: unknown } | null | undefined;
  return typeof holder?.completedAt === 'number' ? holder.completedAt : undefined;
}

// ═══════════════ R4 内部实现件（爬山控制器 / 失败域登记 / 分位数工具） ═══════════════

/**
 * R4-1：批宽爬山控制器（每计划一份，非导出——纯确定性状态机）。
 *
 * 策略（三重迟滞防震）：
 * 1. 收益边际——新批宽吞吐须超出最优记录 ×(1+gainMargin) 才认提升（微升不足信）；
 * 2. 收敛判据——最优宽度的上 / 下邻居都试过（或出界）才判收敛（单边差不算）；
 * 3. 退化线——收敛后吞吐跌破最优记录 ×(1−degradeMargin) 才重启探索（环境
 *    静止则永远停在最优宽度上，不震荡）。
 * 单峰吞吐环境下等价于带记忆的爬山：每一步只把「未试过的最优宽度邻居」
 * 作为下一个批宽，最优记录只升不降 ⇒ 每个宽度至多成为一次最优 ⇒ 必然终止。
 */
class AdaptiveParallelismController {
  private width: number;
  private readonly min: number;
  private readonly max: number;
  private readonly gainMargin: number;
  private readonly degradeMargin: number;
  private bestWidth: number;
  private bestTp = 0;
  private tried = new Set<number>();
  private settled = false;
  readonly observations: AdaptiveParallelismObservation[] = [];

  constructor(options: AdaptiveParallelismOptions | undefined, cap: number) {
    this.min = Math.max(1, Math.floor(options?.minWidth ?? 1));
    this.max = Math.max(this.min, Math.floor(options?.maxWidth ?? cap));
    this.width = Math.min(Math.max(this.min, Math.floor(options?.initialWidth ?? this.min)), this.max);
    this.bestWidth = this.width;
    this.gainMargin = Math.max(0, options?.gainMargin ?? 0.05);
    this.degradeMargin = Math.min(1, Math.max(0, options?.degradeMargin ?? 0.5));
    this.tried.add(this.width);
  }

  /** 当前派发批宽 */
  currentWidth(): number {
    return this.width;
  }

  /** 是否已收敛（收敛后吞吐稳定即停留） */
  isSettled(): boolean {
    return this.settled;
  }

  /** 上探 / 下探的下一个候选宽度（收敛后返回当前宽度） */
  private nextCandidate(fromWidth: number): number {
    const up = fromWidth + 1;
    const down = fromWidth - 1;
    const upTried = up > this.max || this.tried.has(up);
    const downTried = down < this.min || this.tried.has(down);
    if (upTried && downTried) return fromWidth; // 双向邻居都试过 → 停在 fromWidth
    return !upTried ? up : down;
  }

  /** 观测一个完整批（width = 派发宽度、nodes = 完成节点数、ms = 该批耗时） */
  observe(width: number, nodes: number, ms: number): void {
    const tp = ms > 0 ? nodes / ms : 0;
    this.observations.push({ width, nodes, ms, nodesPerMs: tp });
    this.tried.add(width);
    if (!this.settled) {
      if (this.bestTp <= 0 || tp > this.bestTp * (1 + this.gainMargin)) {
        this.bestTp = tp;
        this.bestWidth = width;
      }
      const next = this.nextCandidate(this.bestWidth);
      if (next === this.bestWidth) {
        this.settled = true;
        this.width = this.bestWidth;
      } else {
        this.width = next;
      }
      return;
    }
    // 已收敛：监测环境退化（吞吐跌破退化线 → 从当前宽度重启探索）
    if (tp < this.bestTp * (1 - this.degradeMargin)) {
      this.settled = false;
      this.tried = new Set([width]);
      this.bestTp = tp;
      this.bestWidth = width;
      const next = this.nextCandidate(width);
      this.width = next !== width ? next : width;
    }
  }

  /** 账单（settledWidth = 最优记录宽度；converged = 是否已收敛） */
  report(): AdaptiveParallelismReport {
    return {
      settledWidth: this.bestWidth,
      widthHistory: this.observations.map((o) => o.width),
      throughputHistory: this.observations,
      converged: this.settled,
    };
  }
}

/**
 * R4-2：失败域登记表（失败域 = 模型 × 任务类型；时间源由调用方注入——虚拟时钟
 * 口径下冷却期落在虚拟时间轴，可种子化复现）。
 *
 * 语义：同簇连续可用性失败达阈值 → 簇熔断（openUntil = now + cooldownMs），
 * 期间 allows = false；冷却期满全放行（首个成功清零 / 首个失败立即再熔断——
 * 无半开探测互斥，避免并发等待死锁；串行虚拟时钟下与半开语义等价）。
 */
class FailureDomainRegistry {
  private entries = new Map<string, { consecutiveFailures: number; openUntil: number }>();

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
  ) {}

  /** 失败域键：模型 × 任务类型 */
  static keyOf(modelId: string, taskType: string): string {
    return `${modelId}::${taskType}`;
  }

  /** 当前是否放行（retryInMs = open 态的冷却剩余毫秒） */
  allows(key: string, now: number): { allowed: boolean; retryInMs: number } {
    const entry = this.entries.get(key);
    if (!entry || now >= entry.openUntil) return { allowed: true, retryInMs: 0 };
    return { allowed: false, retryInMs: entry.openUntil - now };
  }

  /** 记一次可用性失败；返回是否「恰好本次触发熔断」（供审计一次性播报） */
  recordFailure(key: string, now: number): boolean {
    const entry = this.entries.get(key) ?? { consecutiveFailures: 0, openUntil: 0 };
    entry.consecutiveFailures += 1;
    let tripped = false;
    if (entry.consecutiveFailures >= this.failureThreshold && now >= entry.openUntil) {
      entry.openUntil = now + this.cooldownMs;
      tripped = true;
    }
    this.entries.set(key, entry);
    return tripped;
  }

  /** 记一次成功：连续失败清零、冷却解除（簇恢复） */
  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** 全量快照（运维可观测） */
  snapshot(now: number): Record<string, FailureDomainStatus> {
    const out: Record<string, FailureDomainStatus> = {};
    for (const [key, entry] of this.entries) {
      if (now < entry.openUntil) {
        out[key] = { state: 'open', consecutiveFailures: entry.consecutiveFailures, cooldownRemainingMs: entry.openUntil - now };
      } else {
        out[key] = { state: 'closed', consecutiveFailures: entry.consecutiveFailures };
      }
    }
    return out;
  }
}

/** R4-3：最近邻上取整分位数（输入须升序；与脚本侧 quantile 同口径） */
function quantileNearestRank(sortedAsc: ReadonlyArray<number>, q: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1));
  return sortedAsc[idx] as number;
}

/** 任务执行器配置 */
export interface TaskExecutorConfig {
  qualityThreshold: number;
  maxRetries: number;
  /** 计划级全局超时（毫秒） */
  globalTimeout: number;
  /** 单节点默认超时（毫秒） */
  nodeTimeout: number;
  /** 是否广播进度事件 */
  enableProgress: boolean;
  verbose: boolean;
  /**
   * 创世纪 G4 · 推荐反垄断：以该概率放弃优化器的历史统计推荐约束、
   * 交由调度器动态选型（UCB 探索得以覆盖新臂）。缺省 0 = 推荐语义
   * 逐位不变（零漂移）。在位者的推荐垄断会让新臂零首发流量、
   * 桶内对照断流（实测确认）。
   */
  explorationOverrideRate?: number;
  /**
   * 4.0：模型级熔断阈值（同一模型连续可用性失败次数，达到即熔断该模型）
   * 缺省 5；设为 0 关闭熔断（与升级前行为一致）
   */
  circuitFailureThreshold?: number;
  /** 4.0：熔断冷却期（毫秒，缺省 60s），期满转半开放行单次试探 */
  circuitCooldownMs?: number;
  /**
   * 4.0：重试退避基数（毫秒，缺省 0 = 不退避，与升级前紧贴重发一致）。
   * 全抖动指数退避：min(base×2^(attempt-1), retryBackoffMaxMs) 内均匀采样
   */
  retryBackoffBaseMs?: number;
  /** 4.0：重试退避上限（毫秒，缺省 8000） */
  retryBackoffMaxMs?: number;
  /**
   * A4-3：计划级重试预算——每份计划全部节点重试次数之和的上限（缺省不设防，
   * 与升级前逐节点独立重试一致）。预算耗尽后待重试节点放弃重试，错误信息
   * 如实标注「预算耗尽」，计划以「部分完成 + 原因」向上报告。
   */
  planRetryBudget?: number;
  /**
   * A4-6：同层实际派发并发上限（钳位 computeParallelism；缺省不钳位）。
   * 虚拟时钟模式下建议设 1：时钟由注入 runner 串行推进，跨节点交叠推进
   * 会使对冲阈值/完成时刻的裁定失真。
   */
  maxInFlightNodes?: number;
}

/**
 * 任务执行器
 *
 * 被 index.ts 持有：编排层完成战略决策与计划生成后，将计划交给本执行器执行。
 */
export class TaskExecutor {
  private config: TaskExecutorConfig;
  private llm: LLMClient;
  private modelScheduler: ModelScheduler;
  private broadcaster?: ProgressBroadcaster;
  private nodeRunner: NodeRunner;
  private cascadeHandler?: CascadeHandler;
  /** 反思引擎（可选，节点级质量反思） */
  private reflection?: ReflectionEngine;
  /** 4.0：模型级熔断器注册表（circuitFailureThreshold=0 时不启用） */
  private breakers?: CircuitBreakerRegistry;
  /** 2.0：最近一次计划执行的调度决策洞察（校准闭环素材，getAndClearDecisionInsights 取走） */
  private decisionInsights: Array<{
    nodeId: string;
    taskType: string;
    modelId: string;
    predictedConfidence: number;
    exploration: boolean;
    success: boolean;
  }> = [];
  /** 32.0：批内全局最优指派（匈牙利算法；未挂载时逐节点选型原样） */
  private batchAssignmentEnabled = false;
  /** 32.0：批内指派的候选池上限（每任务类型取评分前 K） */
  private batchCandidateCap = 8;
  /** 52.0：测试时计算预算规划器（未挂载零介入——咨询口径） */
  private ttcPlanner?: TestTimeComputePlanner;
  /** 54.0：背压账本（未挂载零介入——只读观测口径） */
  private backpressureLedger?: BackpressureLedger;
  /** A4-1：EDF 截止期感知调度旗标（未挂载 = FIFO 原序，零漂移） */
  private deadlineSchedulingEnabled?: boolean;
  /** A4-2：尾延迟对冲配置（未挂载零介入） */
  private hedgingOptions?: HedgingOptions;
  /** A4-6：虚拟时钟（未挂载走真实 Date.now / setTimeout，零漂移） */
  private clock?: VirtualClock;
  /** A4-5：最近一次计划的审计事件流（浅拷贝导出口径） */
  private lastAuditTrail: ExecutorAuditEvent[] = [];
  /** R4-1：并行度自适应挂载选项（未挂载 = 固定调度容量批宽，零漂移） */
  private adaptiveParallelismOptions?: AdaptiveParallelismOptions;
  /** R4-2：失败域登记表（未挂载 = 模型级熔断裁决，零漂移） */
  private failureDomains?: FailureDomainRegistry;
  /** R4-2：失败域挂载参数（审计播报口径） */
  private failureDomainConfig?: { failureThreshold: number; cooldownMs: number };
  /** R4-3：ETA 估计器状态（未挂载零介入） */
  private eta?: {
    windowSize: number;
    defaultP50Ms: number;
    lowQ: number;
    highQ: number;
    history: Map<string, number[]>;
  };
  /** R4-5：失败注入规则（未挂载零介入） */
  private chaosRules?: ChaosRule[];
  /** R4-5：失败注入逐规则命中计数（确定性逐次记账） */
  private chaosFired = new Map<number, number>();

  constructor(params: {
    config: TaskExecutorConfig;
    llm: LLMClient;
    modelScheduler: ModelScheduler;
    broadcaster?: ProgressBroadcaster;
    nodeRunner?: NodeRunner;
    cascadeHandler?: CascadeHandler;
    reflection?: ReflectionEngine;
  }) {
    this.config = params.config;
    this.llm = params.llm;
    this.modelScheduler = params.modelScheduler;
    this.broadcaster = params.broadcaster;
    this.nodeRunner = params.nodeRunner ?? this.defaultNodeRunner.bind(this);
    this.cascadeHandler = params.cascadeHandler;
    this.reflection = params.reflection;
    // 4.0：模型级熔断（阈值 0 = 显式关闭，与升级前行为逐位一致）
    const threshold = this.config.circuitFailureThreshold ?? 5;
    if (threshold > 0) {
      this.breakers = new CircuitBreakerRegistry({
        failureThreshold: threshold,
        cooldownMs: this.config.circuitCooldownMs ?? 60_000,
      });
    }
  }

  /**
   * 运行时配置热更新（元认知自调优落地入口）
   * @param patch 配置补丁（仅覆盖提供的字段）
   */
  updateConfig(patch: Partial<TaskExecutorConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /** 创世纪 G4 · 推荐反垄断概率（配置缺省 0 = 零漂移；只读便捷口径） */
  private get explorationOverrideRate(): number {
    return this.config.explorationOverrideRate ?? 0;
  }

  /**
   * A4-6：挂载虚拟时钟（幂等覆盖，挂载即生效——确定性模拟底座）。
   *
   * 挂载后本执行器全部计时语义切换到虚拟时间轴：now()/全局与节点超时/退避
   * 等待/审计时间戳均以 clock 为准，全局与节点超时经 clock.setTimeout 挂虚拟
   * 定时器（由注入 nodeRunner 的 clock.advance 触发）。未挂载逐位走真实
   * Date.now / setTimeout（零漂移）。
   */
  attachClock(clock: VirtualClock): void {
    this.clock = clock;
  }

  /** A4-6：卸载虚拟时钟（回到真实时间轴） */
  detachClock(): void {
    this.clock = undefined;
  }

  /**
   * A4-1：挂载 EDF 截止期感知调度（幂等，挂载即生效）。
   *
   * 挂载后每个拓扑层内按「最早截止期优先」重排派发序（executePlan 的
   * options.deadlines 提供节点级绝对截止期，与 signal.deadlineMs 同口径）；
   * 无截止期的节点视作 +∞ 排队尾，同键保持原相对序（稳定排序）。未挂载或
   * 未传 deadlines 时层内保持原序（FIFO，零漂移）。EDF 在单机可抢占等价模型
   * 下最小化最大延迟，是截止期满足率的上界口径。
   */
  attachDeadlineScheduling(): void {
    this.deadlineSchedulingEnabled = true;
  }

  /** A4-1：卸载 EDF 调度（回到 FIFO 原序） */
  detachDeadlineScheduling(): void {
    this.deadlineSchedulingEnabled = false;
  }

  /**
   * A4-2：挂载尾延迟对冲请求（幂等覆盖，挂载即生效）。
   *
   * 节点单次尝试在飞超过 delayMs（缺省 = 节点超时的一半，P95 口径的阈值由
   * 调用方按分布标定）即并行发出对冲副本：先到先得（虚拟时钟下按 runner
   * 自报 completedAt 裁定到达序，真实时钟下按结算序），多余副本尽力取消，
   * 对冲次数 / 额外 token / 节省延迟 / 取消数全量记账（report.hedging）。
   * 对冲与重试独立记账，不占计划级重试预算。未挂载零介入。
   */
  attachHedging(options?: HedgingOptions): void {
    this.hedgingOptions = { ...options };
  }

  /** A4-2：卸载尾延迟对冲 */
  detachHedging(): void {
    this.hedgingOptions = undefined;
  }

  /** A4-5：导出最近一次计划的执行审计事件流（浅拷贝；无执行历史时为空数组） */
  exportAuditTrail(): ExecutorAuditEvent[] {
    return [...this.lastAuditTrail];
  }

  /**
   * R4-1：挂载并行度自适应（幂等覆盖，挂载即生效）。
   *
   * 挂载后同层派发批宽按实测吞吐爬山调优：起步 initialWidth（缺省 1），每个
   * 完整批（派发数 = 批宽）观测吞吐（节点/ms），收益超出边际才认提升；最优
   * 宽度的双向邻居都试过后收敛停留（吞吐跌破退化线才重启探索——三重迟滞
   * 防震）。批宽上限缺省取本计划调度容量钳位值（min(computeParallelism,
   * maxInFlightNodes)），可经 maxWidth 显式收紧。部分批（尾批 / 检查点跳过）
   * 不参与观测（吞吐口径失真，诚实弃样）。未挂载时批宽固定 = 调度容量
   * 钳位值（逐位零漂移）。账单随报告 report.adaptiveParallelism 返回。
   */
  attachAdaptiveParallelism(options?: AdaptiveParallelismOptions): void {
    this.adaptiveParallelismOptions = { ...options };
  }

  /** R4-1：卸载并行度自适应（回到固定批宽） */
  detachAdaptiveParallelism(): void {
    this.adaptiveParallelismOptions = undefined;
  }

  /**
   * R4-2：挂载失败域隔离（幂等覆盖，挂载即生效）。
   *
   * 失败域 = 模型 × 任务类型。挂载后可用性裁决从「模型级熔断」收紧为簇级：
   * - 选型 / 重试 / 回退的可用性过滤按「该模型在该任务类型上的簇」判定；
   * - 同簇连续可用性失败（超时 / 网络 / 限流 / 服务端）达阈值 → 仅该簇熔断
   *   降温 cooldownMs（同模型其他任务类型簇、其他模型的同类型簇不受影响）；
   * - 簇熔断后的派发先重定向健康簇模型（pickHealthyFallback 同口径过滤），
   *   全候选降温时诚实等待冷却（虚拟时钟下等待落虚拟时间轴）；
   * - 挂载期间模型级熔断器不再记账 / 不再拦截（簇级是其严格细化；模型级
   *   快照仍可读，但由本执行器的运行维持在其挂载前状态）。
   * 未挂载时模型级熔断路径逐位零漂移。快照经 failureDomainSnapshot() 读取。
   */
  attachFailureDomains(options?: FailureDomainOptions): void {
    this.failureDomainConfig = {
      failureThreshold: Math.max(1, Math.floor(options?.failureThreshold ?? 3)),
      cooldownMs: Math.max(0, Math.floor(options?.cooldownMs ?? 60_000)),
    };
    this.failureDomains = new FailureDomainRegistry(this.failureDomainConfig.failureThreshold, this.failureDomainConfig.cooldownMs);
  }

  /** R4-2：卸载失败域隔离（回到模型级熔断裁决） */
  detachFailureDomains(): void {
    this.failureDomains = undefined;
    this.failureDomainConfig = undefined;
  }

  /** R4-2：失败域快照（未挂载返回空对象——与 getBreakerSnapshot 同口径） */
  failureDomainSnapshot(): Record<string, FailureDomainStatus> {
    return this.failureDomains ? this.failureDomains.snapshot(this.now()) : {};
  }

  /**
   * R4-3：挂载 ETA 估计器（幂等覆盖，挂载即生效）。
   *
   * 每任务类型一条时长历史（预置 seedHistory + 真实执行成功节点的延迟追记，
   * 先进先出窗口）；剩余时间估计 = 剩余节点逐个取该类型历史分位数（P50 点
   * 估计；P10/P90 求和为置信区间——独立和的保守区间，覆盖率不低于
   * highQuantile − lowQuantile）。计划执行中逐批落检查点（report.eta），
   * 收尾时对账中位相对误差与区间覆盖率。未挂载零介入。
   */
  attachEtaEstimator(options?: EtaEstimatorOptions): void {
    const lowQ = Math.min(0.5, Math.max(0, options?.lowQuantile ?? 0.1));
    const highQ = Math.max(0.5, Math.min(1, options?.highQuantile ?? 0.9));
    this.eta = {
      windowSize: Math.max(8, Math.floor(options?.windowSize ?? 64)),
      defaultP50Ms: Math.max(1, Math.floor(options?.defaultP50Ms ?? 1_000)),
      lowQ,
      highQ,
      history: new Map(
        Object.entries(options?.seedHistory ?? {}).map(([type, durations]) => [
          type,
          // 保持预置原序（FIFO 窗口裁最旧样本；分位数在读取时对副本排序）
          [...durations].map((d) => Math.max(0, Math.floor(d))),
        ]),
      ),
    };
  }

  /** R4-3：卸载 ETA 估计器 */
  detachEtaEstimator(): void {
    this.eta = undefined;
  }

  /**
   * R4-3：离线剩余时间估计（未挂载返回 undefined）。
   *
   * @param plan 计划
   * @param completed 已完成节点 id 列表（缺省 = 全部待执行）
   */
  estimateEta(
    plan: ExecutionPlan,
    completed?: ReadonlyArray<string>,
  ): { remainingNodes: number; pointMs: number; loMs: number; hiMs: number } | undefined {
    if (!this.eta) return undefined;
    const done = new Set(completed ?? []);
    let remaining = 0;
    let pointMs = 0;
    let loMs = 0;
    let hiMs = 0;
    for (const node of plan.nodes) {
      if (done.has(node.id)) continue;
      remaining += 1;
      const triple = this.etaTriple(node.type);
      pointMs += triple.p50;
      loMs += triple.lo;
      hiMs += triple.hi;
    }
    return { remainingNodes: remaining, pointMs, loMs, hiMs };
  }

  /**
   * R4-4：计划压缩（纯函数，免挂载；不动入参）。
   *
   * 两类化简迭代至不动点（≤4 轮保护）：
   * 1. 传递依赖边简化——依赖边 (from → to) 若可由 to 的其余依赖经传递闭包到达
   *    （存在 via 使 from ∈ closure(via)），该边删除（信息仍可经 via 到达）；
   * 2. 重复节点合并——操作（type + description 归一）与直接依赖集合完全一致、
   *    且模型 / 超时 / 级联配置一致的节点并为一（保序留首个），其余节点对
   *    重复节点的依赖重定向到 canonical。
   * 语义等价口径：节点输出 = f(操作, 输入闭包取值)——两类化简都不改变任何
   * 幸存节点的输入闭包取值（传递边删除由闭包不变性直接保证；重复合并的
   * canonical 与被合并者闭包相同），故执行产出一致、节点数与调用数同降。
   */
  compressPlan(plan: ExecutionPlan, options?: { reduceTransitive?: boolean }): { plan: ExecutionPlan; stats: PlanCompressionStats } {
    const reduceTransitive = options?.reduceTransitive !== false;
    const nodes: PlanNode[] = plan.nodes.map((n) => ({ ...n, dependsOn: [...new Set(n.dependsOn)] }));
    let byId = new Map(nodes.map((n) => [n.id, n]));
    const stats: PlanCompressionStats = {
      nodesBefore: plan.nodes.length,
      nodesAfter: plan.nodes.length,
      mergedGroups: [],
      transitiveEdgesRemoved: [],
    };

    /** 自 id 经依赖边可达的全部祖先（含间接；依当前图实时计算） */
    const ancestorsOf = (id: string, seen: Set<string> = new Set()): Set<string> => {
      for (const dep of byId.get(id)?.dependsOn ?? []) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        ancestorsOf(dep, seen);
      }
      return seen;
    };

    /** 传递依赖边简化一轮（返回删除边数） */
    const reduceOnce = (): number => {
      let removed = 0;
      for (const node of nodes) {
        if (node.dependsOn.length < 2) continue;
        const keep: string[] = [];
        const reachable = new Map<string, boolean>(); // dep → 经其余依赖可达
        for (const dep of node.dependsOn) {
          const others = node.dependsOn.filter((d) => d !== dep);
          let via: string | undefined;
          for (const other of others) {
            if (ancestorsOf(other).has(dep)) {
              via = other;
              break;
            }
          }
          if (via !== undefined) {
            reachable.set(dep, true);
            stats.transitiveEdgesRemoved.push({ from: dep, to: node.id, via });
            removed += 1;
          } else {
            keep.push(dep);
          }
        }
        node.dependsOn = keep;
      }
      return removed;
    };

    /** 重复节点合并一轮（返回合并节点数；依赖引用同步重定向） */
    const mergeOnce = (): number => {
      const sigOf = (n: PlanNode): string =>
        [
          n.type,
          n.description.trim(),
          [...n.dependsOn].sort().join(','),
          n.modelId ?? '',
          String(n.timeout ?? ''),
          JSON.stringify(n.cascade ?? null),
        ].join('\u0000');
      const canonicalOfSig = new Map<string, string>();
      const remap = new Map<string, string>();
      const kept: PlanNode[] = [];
      let merged = 0;
      for (const node of nodes) {
        if (remap.has(node.id)) continue;
        const sig = sigOf(node);
        const canonical = canonicalOfSig.get(sig);
        if (canonical === undefined) {
          canonicalOfSig.set(sig, node.id);
          kept.push(node);
          continue;
        }
        remap.set(node.id, canonical);
        merged += 1;
        const group = stats.mergedGroups.find((g) => g[0] === canonical);
        if (group) group.push(node.id);
        else stats.mergedGroups.push([canonical, node.id]);
      }
      if (merged > 0) {
        for (const node of kept) {
          node.dependsOn = [...new Set(node.dependsOn.map((d) => remap.get(d) ?? d))];
        }
        nodes.length = 0;
        nodes.push(...kept);
        byId = new Map(nodes.map((n) => [n.id, n]));
      }
      return merged;
    };

    for (let round = 0; round < 4; round += 1) {
      const removed = reduceTransitive ? reduceOnce() : 0;
      const merged = mergeOnce();
      if (removed === 0 && merged === 0) break;
    }
    stats.nodesAfter = nodes.length;
    return {
      plan: { objective: plan.objective, nodes, parallelismStrategy: plan.parallelismStrategy, source: plan.source },
      stats,
    };
  }

  /**
   * R4-5：挂载失败注入演练（幂等覆盖，挂载即生效）。
   *
   * 在 runner 调用前按规则评估注入（按序首条命中即注入，逐规则限次记账——
   * 确定性命中，不依赖派发序）：error = 未知错误（fatal 路径 → 检查点）；
   * timeout = 超时（可重试路径；虚拟时钟下先推进挂起时长再抛——推进途中
   * 可触发对冲阈值定时器，验证对冲与注入协同）；low-quality = 低质产出
   * （质量反思换模路径）。命中进入审计流（chaos-inject）；账本经
   * chaosLedger() 读取。未挂载零介入。
   */
  attachChaosInjection(options: { rules: ChaosRule[] }): void {
    this.chaosRules = options.rules.map((r) => ({ ...r }));
    this.chaosFired = new Map();
  }

  /** R4-5：卸载失败注入（清空规则与命中计数） */
  detachChaosInjection(): void {
    this.chaosRules = undefined;
    this.chaosFired = new Map();
  }

  /** R4-5：注入账本（规则序号 / 类型 / 已命中次数；未挂载为空数组） */
  chaosLedger(): ChaosLedgerEntry[] {
    if (!this.chaosRules) return [];
    return this.chaosRules.map((rule, i) => ({ rule: i, kind: rule.kind, fired: this.chaosFired.get(i) ?? 0 }));
  }

  /**
   * 32.0：挂载批内全局最优指派（幂等，挂载即生效）。
   *
   * 挂载后每个执行批（同层就绪节点 × 并发上限切片）中的**动态选型节点**
   * 不再逐个调用调度器（局部贪心），而是构造「节点 × 候选模型」收益
   * 矩阵（与逐节点路径同一评分口径），经匈牙利算法求**全局总收益最优**
   * 的一对一指派（O(n³) 精确解，携带对偶证书）——最优模型不再被同批
   * 节点重复超订，次优模型不再闲置。计划指定 / 优化器推荐的节点不受
   * 影响（约束优先，只对无约束节点做全局协调）。未挂载时逐位零漂移。
   */
  attachOptimalAssignment(options?: { candidateCap?: number }): void {
    this.batchAssignmentEnabled = true;
    if (options?.candidateCap && options.candidateCap >= 1) this.batchCandidateCap = Math.floor(options.candidateCap);
  }

  /** 32.0：批内指派断开（诊断/回退口径） */
  detachOptimalAssignment(): void {
    this.batchAssignmentEnabled = false;
  }

  /**
   * 52.0：挂载测试时计算预算规划（幂等覆盖，挂载即生效——咨询口径）。
   *
   * 高价值任务的「重推理配置」从拍脑袋升级为可达性计算：执行器以每
   * 任务类型的真实成败 EWMA 为 p̂（executeNode 结束时回填，仅挂载后
   * 记账），testTimeComputePlan(taskType, urgency) 给出最优投票路数 n
   * （optimalVoteN 闭式——p̂ ≤ 0.5 或目标超天花板时诚实拒绝升级）。
   * 不改变执行/重试路径（零漂移）；n 与早停规则由编排侧按需消费。
   */
  attachTestTimeCompute(options?: { alpha?: number }): void {
    this.ttcPlanner = new TestTimeComputePlanner(options);
  }

  /**
   * 52.0：投票路数建议（未挂载返回 undefined）。
   * @param urgency 信号紧急度（目标多数票正确率按其分层：≥0.8→0.95；≥0.5→0.9；其余 0.85）
   */
  testTimeComputePlan(taskType: string, urgency: number): ReturnType<TestTimeComputePlanner['votePlan']> | undefined {
    return this.ttcPlanner?.votePlan(taskType, urgency);
  }

  /** 52.0：推理循环早停规则（边际增益 < 算力价格即停；纯函数转发） */
  static testTimeEarlyStop(marginalGain: number, price: number) {
    return TestTimeComputePlanner.shouldStop(marginalGain, price);
  }

  /**
   * 54.0：挂载 Lyapunov 背压账本（幂等覆盖，挂载即生效——只读观测口径）。
   *
   * 每个任务类型一条在途队列：派发 acquire、完成/失败 release；对偶
   * 价格 p_i = Q_i/V 持续超阈 = 该来源到达率逼近容量域的稳定性告警
   * （backpressureView() 产出 54.0 内核的背压洞察桥，接 41.0/25.0 容量
   * 口径）。不改变任何派发顺序与执行路径（零漂移）。
   */
  attachBackpressureController(options?: { V?: number; priceThreshold?: number }): void {
    this.backpressureLedger = new BackpressureLedger(options);
  }

  /**
   * 54.0：背压读数（未挂载 / 队列全空且无洞察时 undefined）。
   * queues/当前在途，prices = Q/V，insight = 超阈时的背压瓶颈洞察。
   */
  backpressureView(): { queues: Array<{ name: string; queue: number }>; prices: Array<{ name: string; price: number }>; insight?: { message: string; suggestion: string; severity: number } } | undefined {
    if (!this.backpressureLedger) return undefined;
    const { names, queues } = this.backpressureLedger.queueVector();
    const prices = this.backpressureLedger.prices();
    const insight = this.backpressureLedger.insight();
    if (queues.length === 0 && !insight) return undefined;
    return {
      queues: names.map((name, i) => ({ name, queue: queues[i] })),
      prices,
      insight,
    };
  }

  /**
   * 85.0：挂载符号可行性裁决（幂等覆盖，挂载即生效——咨询口径）。
   *
   * DAG 计划立项前 dpllSolve 一次静态裁决（15.0 运行时验证管「执行中
   * 的时序」，本内核管「动手前的可行性」）：依赖闭包 / 资源互斥 / 预算
   * 容量子句化——UNSAT 时动手前判死并返回 conflicts/learned 账单（定位
   * 最小冲突任务集，降级/外包而非空转重试）；countModels 量化计划鲁棒性
   * （唯一解 = 脆弱）。不改变执行路径（零漂移）。
   */
  attachSymbolicFeasibility(): void {
    this.symbolicFeasibilityEnabled = true;
  }

  /** 85.0：符号裁决旗标（未挂载零介入） */
  private symbolicFeasibilityEnabled?: boolean;

  /** 85.0：计划可行性静态裁决（未挂载 / 计划超护栏时 undefined） */
  planFeasibility(
    nodes: ReadonlyArray<FeasibilityNodeInput>,
    options?: { mandatory?: string[]; capacity?: number },
  ): PlanFeasibilityView | undefined {
    return this.symbolicFeasibilityEnabled ? planFeasibilityVerdict(nodes, options) : undefined;
  }

  /**
   * 86.0：挂载分层技能体检（幂等覆盖，挂载即生效——只读基准口径）。
   *
   * DAG 计划节点即 option（I_ω = 前置满足、π_ω = 节点子程序、β_ω = 完成
   * 谓词）：corridor 走廊世界上 smdpQLearning（宏 Q，γ^k 时间信用）对照
   * flatQLearning（原步 Q）——同预算样本效率提升即「子计划值得进主计划」
   * 的宏信号基准，optionBellmanResidual 是价值表健康度账单。不改执行路径。
   */
  attachOptionsFramework(): void {
    this.optionsFrameworkEnabled = true;
  }

  /** 86.0：分层技能旗标（未挂载零介入） */
  private optionsFrameworkEnabled?: boolean;

  /** 86.0：技能宏学习体检（未挂载时 undefined） */
  optionsSkillAuditView(options?: { rooms?: number; episodes?: number; seed?: number; gamma?: number }): OptionsSkillAuditView | undefined {
    return this.optionsFrameworkEnabled ? optionsSkillAudit(options) : undefined;
  }

  /**
   * 87.0：挂载安全屏障过滤（幂等覆盖，挂载即生效——咨询口径）。
   *
   * 与安全总督两级分工：总督是熔断级（拉闸/降级/回滚），屏障是微分级
   * （逐动作连续修正）。quotaGuardAction 把期望动作（消耗速率）先过
   * cbfFilter——最小安全修改而非静默截断；infeasible + minViolation 须
   * 上报总督走熔断路径（差 5% 和差 50% 的处置不同）。缺省关闭时动作走
   * 原钳位路径（零漂移）。
   */
  attachSafetyBarrier(options?: { eta?: number }): void {
    this.safetyBarrierConfig = { eta: options?.eta ?? 0.05 };
  }

  /** 87.0：安全屏障配置（未挂载零介入） */
  private safetyBarrierConfig?: { eta: number };

  /** 87.0：动作安全过滤（未挂载 / 状态非法 / 数值防御时 undefined） */
  barrierFilterAction(state: QuotaGuardState, desiredRate: number, bounds?: { uMin?: number; uMax?: number }): CbfResult | undefined {
    return this.safetyBarrierConfig
      ? quotaGuardAction(state, desiredRate, { ...bounds, eta: this.safetyBarrierConfig.eta })
      : undefined;
  }

  /**
   * 32.0：为执行批计算全局指派（节点 id → 模型 id；无指派必要的批返回 undefined）。
   *
   * 只有批内「动态选型节点」（无计划指定模型、无可执行推荐模型）≥ 2 且
   * 候选模型 ≥ 2 时才升级为全局口径；被约束节点占用的模型从候选池剔除
   * （一对一语义）。返回的 map 缺席 = 该节点走原动态路径（诚实降级）。
   */
  private planBatchAssignment(
    chunk: PlanNode[],
    recommendedModels: Record<string, string> | undefined,
    avoidModels: string[],
  ): Map<string, string> | undefined {
    const avoidSet = new Set(avoidModels);
    const takenByConstraint = new Set<string>();
    /** 节点的约束模型（指定/推荐且可用）——有约束的节点不参与全局协调 */
    const constrained = new Map<string, string>();
    for (const node of chunk) {
      let planned = node.modelId;
      if (planned && (avoidSet.has(planned) || !this.modelExecutable(planned, node.type))) planned = undefined;
      if (planned) {
        constrained.set(node.id, planned);
        takenByConstraint.add(planned);
        continue;
      }
      let preferred = recommendedModels?.[node.type];
      if (preferred && (avoidSet.has(preferred) || !this.modelExecutable(preferred, node.type))) preferred = undefined;
      // 创世纪 G4 · 推荐反垄断：以 overrideRate 概率放弃推荐约束、
      // 交给动态选型——历史统计推荐会形成在位者垄断（实测：46 连胜的
      // glm-4.5 永久独占，新臂零首发流量，桶内对照断流）。缺省 0 =
      // 推荐语义逐位不变（零漂移）。
      if (preferred && this.explorationOverrideRate > 0 && Math.random() < this.explorationOverrideRate) preferred = undefined;
      if (preferred) {
        constrained.set(node.id, preferred);
        takenByConstraint.add(preferred);
      }
    }
    const dynamicNodes = chunk.filter((node) => !constrained.has(node.id));
    if (dynamicNodes.length < 2) return undefined;

    // 候选池：各动态节点任务类型的评分前 K 之并集，剔除被约束占用与规避
    const scoresByType = new Map<string, Map<string, number>>();
    for (const node of dynamicNodes) {
      if (scoresByType.has(node.type)) continue;
      const ranked = this.modelScheduler.rankCandidateScores(node.type, undefined, [...avoidSet]);
      const map = new Map<string, number>();
      for (const entry of ranked.slice(0, this.batchCandidateCap)) map.set(entry.id, entry.score);
      scoresByType.set(node.type, map);
    }
    const candidateIds: string[] = [];
    for (const map of scoresByType.values()) {
      for (const id of map.keys()) {
        if (!candidateIds.includes(id) && !takenByConstraint.has(id) && this.modelExecutable(id)) candidateIds.push(id);
      }
    }
    if (candidateIds.length < 2) return undefined;

    // 收益矩阵（节点 × 候选）：缺评分（该类型评分池未含此候选）给保守 0
    const profit: number[][] = dynamicNodes.map((node) =>
      candidateIds.map((id) => scoresByType.get(node.type)?.get(id) ?? 0),
    );
    const { modelOfNode } = assignBatch(profit);
    const assignment = new Map<string, string>();
    modelOfNode.forEach((candidateIdx, nodeIdx) => {
      if (candidateIdx >= 0) assignment.set(dynamicNodes[nodeIdx].id, candidateIds[candidateIdx]);
    });
    return assignment.size > 0 ? assignment : undefined;
  }

  /**
   * 取走最近一次计划执行的调度决策洞察（2.0：校准闭环桥接）
   *
   * 编排层在 executePlan 返回后调用本方法，将洞察作为
   * reflectOnOutcome({ decisionInsights }) 回注反思器，
   * 完成「调度预测 → 实际结果 → Brier 校准」闭环。
   * 取走即清空（每份洞察只消费一次）。
   */
  getAndClearDecisionInsights(): Array<{
    nodeId: string;
    taskType: string;
    modelId: string;
    predictedConfidence: number;
    exploration: boolean;
    success: boolean;
  }> {
    const insights = this.decisionInsights;
    this.decisionInsights = [];
    return insights;
  }

  /**
   * 计划生成 — 解析 strategist 输出，非法时回退离线计划
   * @param objective 任务目标
   * @param strategistOutput strategist 模型原始输出（可为空）
   * @param taskType 任务类型
   */
  buildPlan(objective: string, strategistOutput: string | undefined, taskType: string): ExecutionPlan {
    if (strategistOutput) {
      const parsed = parseJSONLoose<any>(strategistOutput);
      const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : null;
      if (nodes && nodes.length > 0 && this.validateDag(nodes)) {
        return {
          objective,
          nodes: nodes.map((n: any) => this.normalizeNode(n)),
          parallelismStrategy: typeof parsed.parallelismStrategy === 'string' ? parsed.parallelismStrategy : 'layered',
          source: 'strategist',
        };
      }
    }
    // 离线兜底：单节点计划
    return {
      objective,
      nodes: [{ id: 'node-1', description: objective, type: taskType, dependsOn: [] }],
      parallelismStrategy: 'sequential',
      source: 'fallback',
    };
  }

  /**
   * 执行完整计划
   *
   * 深度优化：
   * - 截止时间感知：signal.deadlineMs 存在时，全局超时收紧为 min(globalTimeout, deadline - now)
   * - 动态并行度：同层节点数超过模型总并发容量时分批执行，避免并发过载排队
   * - 4.0：avoidModels 负向约束贯通——优化器产出的规避模型在调度与重试切换中全局排除
   * - A4-1：挂载 EDF 后 options.deadlines 参与层内派发序（缺省 FIFO 零漂移）
   * - A4-4：options.cancelSignal 外部取消——向在途节点传播中止，部分结果保留为检查点
   *
   * @param signal 触发信号
   * @param plan 执行计划
   * @param recommendedModels 优化器产出的按节点类型推荐模型（模型调度优先采纳）
   * @param options 扩展选项（avoidModels：经验规避模型；cancelSignal：外部取消；deadlines：节点截止期）
   * @returns 计划执行报告（PlanExecutionResult 超集：status/checkpoint/retryBudget/hedging/audit）
   */
  async executePlan(
    signal: Signal,
    plan: ExecutionPlan,
    recommendedModels?: Record<string, string>,
    options?: PlanExecutionOptions,
  ): Promise<PlanExecutionReport> {
    return this.executePlanInternal(signal, plan, recommendedModels, options, undefined);
  }

  /**
   * A4-4：从部分检查点续跑计划（与 executePlan 同一套执行路径与选项面）。
   *
   * 检查点中已成功的节点直接复用其结果与产出（不重跑、计入 nodeResults 与
   * 下游 context），只执行剩余节点；与检查点失配（不在计划内 / 非成功 / 无
   * 产出）的条目诚实丢弃。返回报告携带 resumedFromCount = 实际复用节点数。
   */
  async resumePlan(
    signal: Signal,
    plan: ExecutionPlan,
    checkpoint: PlanCheckpoint,
    recommendedModels?: Record<string, string>,
    options?: PlanExecutionOptions,
  ): Promise<PlanExecutionReport> {
    return this.executePlanInternal(signal, plan, recommendedModels, options, checkpoint);
  }

  /** 计划执行主路径（executePlan / resumePlan 共用；resumeFrom 为检查点续跑来源） */
  private async executePlanInternal(
    signal: Signal,
    plan: ExecutionPlan,
    recommendedModels: Record<string, string> | undefined,
    options: PlanExecutionOptions | undefined,
    resumeFrom: PlanCheckpoint | undefined,
  ): Promise<PlanExecutionReport> {
    const planId = `plan-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const startedAt = this.now();
    // A4：计划执行上下文（重试预算 / 对冲账本 / 审计流 / 取消旗标——每计划一份）
    const ctx: PlanRunContext = {
      audit: [],
      retry: {
        limit: this.config.planRetryBudget !== undefined ? Math.max(0, Math.floor(this.config.planRetryBudget)) : Number.POSITIVE_INFINITY,
        used: 0,
      },
      hedge: { count: 0, extraTokens: 0, savedMs: 0, canceled: 0 },
      externalCancel: false,
      etaCheckpoints: [],
    };
    this.lastAuditTrail = ctx.audit;
    const nodeResults: NodeResult[] = [];
    const outputs = new Map<string, string>();

    // A4-4：检查点续跑——已成功节点复用结果与产出，剩余节点照常执行
    const resumedIds = new Set<string>();
    if (resumeFrom) {
      const planIds = new Set(plan.nodes.map((n) => n.id));
      for (const entry of resumeFrom.completed) {
        if (!planIds.has(entry.nodeId) || !entry.success || !entry.output) continue; // 失配条目诚实丢弃
        resumedIds.add(entry.nodeId);
        nodeResults.push(entry);
        outputs.set(entry.nodeId, entry.output);
      }
    }

    // 截止时间感知：收紧全局超时（A4-6：虚拟时钟模式下以虚拟时刻为准）
    let effectiveTimeout = this.config.globalTimeout;
    if (signal.deadlineMs && signal.deadlineMs > this.now()) {
      effectiveTimeout = Math.min(effectiveTimeout, signal.deadlineMs - this.now());
    }

    const scheduling: 'fifo' | 'edf' = this.deadlineSchedulingEnabled && options?.deadlines ? 'edf' : 'fifo';

    this.audit(ctx, {
      type: 'plan-start',
      planId,
      detail: `${plan.objective} · ${plan.nodes.length} 节点 · 来源 ${plan.source} · 调度 ${scheduling}${resumedIds.size > 0 ? ` · 检查点续跑复用 ${resumedIds.size} 节点` : ''}`,
    });
    this.broadcast({ type: 'plan-start', plan: { objective: plan.objective, nodeCount: plan.nodes.length, source: plan.source }, signal: { id: signal.id, type: signal.type }, effectiveTimeout });

    // 全局超时控制（A4-6：虚拟时钟模式下挂虚拟定时器）
    const controller = new AbortController();
    const globalTimer = this.armTimer(() => controller.abort(), effectiveTimeout);

    // A4-4：外部取消——触发即置旗标并中止全局控制器（向在途节点传播）
    let offExternalCancel: (() => void) | undefined;
    if (options?.cancelSignal) {
      const onCancel = () => {
        ctx.externalCancel = true;
        controller.abort();
      };
      if (options.cancelSignal.aborted) onCancel();
      else {
        options.cancelSignal.addEventListener('abort', onCancel, { once: true });
        offExternalCancel = () => options?.cancelSignal?.removeEventListener('abort', onCancel);
      }
    }

    // R4-1：并行度自适应控制器（挂载即启用；上限缺省 = 调度容量钳位值）
    let adaptiveCtrl: AdaptiveParallelismController | undefined;
    try {
      const layers = this.topologicalLayers(plan.nodes);
      const parallelism = Math.max(1, Math.min(this.modelScheduler.computeParallelism(), this.config.maxInFlightNodes ?? Number.POSITIVE_INFINITY));
      adaptiveCtrl = this.adaptiveParallelismOptions ? new AdaptiveParallelismController(this.adaptiveParallelismOptions, parallelism) : undefined;
      // 43.0：计划级待执行需求回写容量前沿（未挂载为空操作——纯诊断；
      // 计划级口径：整份待执行需求，批级会被末批小样本覆盖）
      this.modelScheduler.updateCapacityFrontier(
        plan.nodes.reduce<Array<{ type: string; count: number }>>((acc, node) => {
          const found = acc.find((a) => a.type === node.type);
          if (found) found.count += 1;
          else acc.push({ type: node.type, count: 1 });
          return acc;
        }, []),
      );
      for (const layer of layers) {
        if (controller.signal.aborted) break;
        // A4-1：EDF 截止期感知调度——层内按最早截止期重排（未挂载/无 deadlines 原序）
        const orderedLayer = this.orderLayer(layer, options?.deadlines, planId, ctx);
        // 动态并行度：分层内分批执行，每批不超过 parallelism（检查点节点跳过派发）；
        // R4-1：挂载自适应后批宽由爬山控制器给出（缺省固定 = 调度容量钳位值，零漂移）
        let cursor = 0;
        while (cursor < orderedLayer.length) {
          if (controller.signal.aborted) break;
          const width = adaptiveCtrl ? adaptiveCtrl.currentWidth() : parallelism;
          const chunk = orderedLayer.slice(cursor, cursor + width).filter((node) => !resumedIds.has(node.id));
          cursor += width;
          if (chunk.length === 0) continue;
          ctx.dispatchWidth = adaptiveCtrl ? width : undefined; // R4-1：批宽透出（仅挂载自适应时；旧 runner 契约面不变）
          const chunkStartedAt = this.now();
          // 32.0：批内动态选型节点全局最优指派（未挂载 / 无协调必要时 undefined）
          const batchAssignment = this.batchAssignmentEnabled
            ? this.planBatchAssignment(chunk, recommendedModels, options?.avoidModels ?? [])
            : undefined;
          const layerResults = await Promise.all(
            chunk.map((node) =>
              this.executeNode(
                planId,
                node,
                signal,
                outputs,
                controller.signal,
                ctx,
                recommendedModels,
                options?.avoidModels ?? [],
                batchAssignment?.get(node.id),
              ),
            ),
          );
          for (const result of layerResults) {
            nodeResults.push(result);
            if (result.success && result.output) outputs.set(result.nodeId, result.output);
          }
          // R4-1：完整批（派发数 = 批宽）观测吞吐并调宽（部分批吞吐口径失真，诚实弃样）
          if (adaptiveCtrl && chunk.length === width) {
            const before = adaptiveCtrl.currentWidth();
            const wasSettled = adaptiveCtrl.isSettled();
            adaptiveCtrl.observe(width, chunk.length, this.now() - chunkStartedAt);
            const after = adaptiveCtrl.currentWidth();
            if (!wasSettled && adaptiveCtrl.isSettled()) {
              this.audit(ctx, {
                type: 'parallelism-adapt',
                planId,
                detail: `吞吐爬山收敛：最优并发宽度 = ${after}（观测 ${adaptiveCtrl.report().throughputHistory.length} 批）`,
              });
            } else if (after !== before) {
              this.audit(ctx, {
                type: 'parallelism-adapt',
                planId,
                detail: `批宽 ${before} → ${after}（上批吞吐 ${(chunk.length / Math.max(1, this.now() - chunkStartedAt)).toFixed(5)} 节点/ms）`,
              });
            }
          }
          // R4-3：ETA 检查点（剩余 > 0 才落点；误差对账在计划收尾）
          if (this.eta) {
            const estimate = this.estimateEta(plan, nodeResults.map((r) => r.nodeId));
            if (estimate && estimate.remainingNodes > 0) {
              ctx.etaCheckpoints.push({
                t: this.now(),
                completed: nodeResults.length,
                remaining: estimate.remainingNodes,
                pointMs: estimate.pointMs,
                loMs: estimate.loMs,
                hiMs: estimate.hiMs,
              });
            }
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted && !ctx.externalCancel) {
        throw new TimeoutError(`计划执行超过全局超时（${effectiveTimeout}ms）`, { planId });
      }
      if (ctx.externalCancel) {
        // A4-4：外部取消——不抛超时，落部分完成收尾（status=cancelled + checkpoint）
      } else {
        throw err;
      }
    } finally {
      globalTimer.cancel();
      offExternalCancel?.();
    }

    const successCount = nodeResults.filter((r) => r.success).length;
    const success = successCount === plan.nodes.length && plan.nodes.length > 0;
    const totalTime = this.now() - startedAt;
    const totalTokens = nodeResults.reduce((sum, r) => sum + r.tokensUsed, 0);
    const successResults = nodeResults.filter((r) => r.success);
    const avgQuality = successResults.length > 0 ? successResults.reduce((s, r) => s + r.quality, 0) / successResults.length : 0;

    this.broadcast({ type: 'plan-complete', planId, totalTime, successCount, totalNodes: plan.nodes.length, success, avgQuality });

    // A4：报告组装（新字段全部为 PlanExecutionResult 的增量超集，旧消费面零影响）
    const report: PlanExecutionReport = {
      planId,
      success,
      nodeResults,
      totalTime,
      successCount,
      totalTokens,
      avgQuality,
      error: success ? undefined : nodeResults.find((r) => !r.success)?.error,
      scheduling,
    };
    if (controller.signal.aborted) report.status = 'cancelled';
    if (this.config.planRetryBudget !== undefined) {
      report.retryBudget = { limit: ctx.retry.limit, used: ctx.retry.used, exhausted: ctx.retry.used >= ctx.retry.limit };
    }
    if (this.hedgingOptions) report.hedging = { ...ctx.hedge };
    // R4-1：并行度自适应账单（挂载即在场——含零观测的诚实口径）
    if (adaptiveCtrl) report.adaptiveParallelism = adaptiveCtrl.report();
    // R4-3：ETA 账单 + 收尾对账（中位相对误差 / 区间覆盖率；检查点剩余 > 0 才计入）
    if (this.eta) {
      const cps = ctx.etaCheckpoints.filter((c) => c.remaining > 0);
      const relErrors = cps
        .map((c) => Math.abs(c.pointMs - (totalTime - c.t)) / Math.max(1, totalTime - c.t))
        .sort((a, b) => a - b);
      const medianRelError = relErrors.length > 0 ? relErrors[Math.floor(relErrors.length / 2)] : undefined;
      const covered = cps.filter((c) => totalTime - c.t >= c.loMs && totalTime - c.t <= c.hiMs).length;
      report.eta = {
        checkpoints: cps,
        medianRelError,
        coverage: cps.length > 0 ? covered / cps.length : undefined,
        targetCoverage: this.eta.highQ - this.eta.lowQ,
      };
    }
    const checkpointNodes = nodeResults.filter((r) => r.success && r.output);
    if (!success && checkpointNodes.length > 0) {
      report.checkpoint = { planId, objective: plan.objective, savedAt: this.now(), completed: checkpointNodes };
      this.audit(ctx, { type: 'plan-checkpoint', planId, detail: `部分检查点保留 ${checkpointNodes.length}/${plan.nodes.length} 节点（resumePlan 续跑可复用）` });
    }
    if (report.status === 'cancelled') {
      this.audit(ctx, {
        type: 'plan-cancel',
        planId,
        detail: `${ctx.externalCancel ? '外部取消' : '超时中止'}：完成 ${successCount}/${plan.nodes.length}，在途节点已传播中止`,
      });
    }
    if (resumedIds.size > 0) report.resumedFromCount = resumedIds.size;
    this.audit(ctx, {
      type: 'plan-complete',
      planId,
      detail: `${success ? '全部成功' : '失败/部分完成'}：${successCount}/${plan.nodes.length}，耗时 ${totalTime}ms，token ${totalTokens}`,
    });
    report.audit = ctx.audit;
    return report;
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 模型级熔断快照（运维可观测：哪些模型被熔断、连续失败数） */
  getBreakerSnapshot(): Record<string, { state: string; consecutiveFailures: number }> {
    return this.breakers?.snapshot() ?? {};
  }

  /** A4-6：当前时刻（虚拟时钟优先，未挂载走真实墙钟） */
  private now(): number {
    return this.clock ? this.clock.now() : Date.now();
  }

  /** A4-6：挂定时器（虚拟时钟挂虚拟定时器；否则真实 setTimeout + unref，与升级前逐位一致） */
  private armTimer(callback: () => void, ms: number): ExecutorTimerHandle {
    if (this.clock) return this.clock.setTimeout(callback, ms);
    const timer = setTimeout(callback, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  }

  /** A4-6：可中止等待（虚拟时钟经虚拟定时器；否则委托 abortableSleep，与升级前逐位一致） */
  private waitAbortable(ms: number, abortSignal?: AbortSignal): Promise<boolean> {
    if (!this.clock) return abortableSleep(ms, abortSignal);
    return new Promise<boolean>((resolve) => {
      if (abortSignal?.aborted) {
        resolve(false);
        return;
      }
      let done = false;
      const onAbort = () => finish(false);
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        abortSignal?.removeEventListener('abort', onAbort);
        timer.cancel();
        resolve(value);
      };
      const timer = this.clock!.setTimeout(() => finish(!abortSignal?.aborted), ms);
      abortSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** A4-5：追加执行审计事件（时间戳取当前时刻——虚拟时钟下为虚拟毫秒） */
  private audit(ctx: PlanRunContext, event: Omit<ExecutorAuditEvent, 't'>): void {
    ctx.audit.push({ t: this.now(), ...event });
  }

  /** A4-1：层内派发序（EDF 挂载且传入 deadlines 时按最早截止期稳定重排，否则原序） */
  private orderLayer(layer: PlanNode[], deadlines: Record<string, number> | undefined, planId: string, ctx: PlanRunContext): PlanNode[] {
    if (!this.deadlineSchedulingEnabled || !deadlines) return layer;
    const keyed = layer.map((node, index) => ({ node, index, key: deadlines[node.id] ?? Number.POSITIVE_INFINITY }));
    keyed.sort((a, b) => (a.key === b.key ? a.index - b.index : a.key - b.key));
    this.audit(ctx, {
      type: 'layer-edf',
      planId,
      detail: `层内 EDF 派发序：${keyed.map((k) => `${k.node.id}@${k.key === Number.POSITIVE_INFINITY ? '∞' : k.key}`).join(' → ')}`,
    });
    return keyed.map((k) => k.node);
  }

  /**
   * 模型当前是否可执行（无熔断器或熔断器放行；peek 纯读取不占探测名额）。
   * R4-2：挂载失败域后按「模型×任务类型」簇裁决（taskType 缺席时退模型级——
   * 批内指派候选池等无类型上下文的场合，簇级裁决由节点尝试环补位）。
   */
  private modelExecutable(modelId: string, taskType?: string): boolean {
    if (this.failureDomains && taskType !== undefined) {
      return this.failureDomains.allows(FailureDomainRegistry.keyOf(modelId, taskType), this.now()).allowed;
    }
    if (!this.breakers) return true;
    return this.breakers.peek(modelId).allowed;
  }

  /** R4-3：任务类型的历史时长分位数三元组（P50 / 低分位 / 高分位；无历史走缺省口径） */
  private etaTriple(taskType: string): { p50: number; lo: number; hi: number } {
    const eta = this.eta!;
    const sorted = [...(eta.history.get(taskType) ?? [])].sort((a, b) => a - b);
    if (sorted.length === 0) {
      return { p50: eta.defaultP50Ms, lo: Math.floor(eta.defaultP50Ms / 2), hi: eta.defaultP50Ms * 2 };
    }
    return {
      p50: quantileNearestRank(sorted, 0.5),
      lo: quantileNearestRank(sorted, eta.lowQ),
      hi: quantileNearestRank(sorted, eta.highQ),
    };
  }

  /** R4-3：成功节点延迟追记历史（挂载估计器时；先进先出窗口） */
  private etaNote(taskType: string, latencyMs: number): void {
    if (!this.eta) return;
    const hist = this.eta.history.get(taskType) ?? [];
    hist.push(Math.max(0, Math.floor(latencyMs)));
    if (hist.length > this.eta.windowSize) hist.splice(0, hist.length - this.eta.windowSize);
    this.eta.history.set(taskType, hist);
  }

  /** 选择健康的次优模型：排除当前模型、规避模型与熔断中的模型（R4-2：失败域簇级过滤） */
  private pickHealthyFallback(taskType: string, currentModelId: string, avoidModels: string[]): string | undefined {
    const excluded = new Set<string>([currentModelId, ...avoidModels]);
    const fallback = this.modelScheduler.pickFallbackModel(taskType, currentModelId, undefined, [...excluded]);
    if (fallback && this.modelExecutable(fallback, taskType)) return fallback;
    // 次优也被熔断：逐个放宽直到找到健康模型
    if (fallback && !this.modelExecutable(fallback, taskType)) {
      const ranked = this.modelScheduler.pickEnsemble(taskType, 8, [...excluded]);
      return ranked.find((id) => this.modelExecutable(id, taskType));
    }
    return fallback;
  }

  /** 单节点执行入口（54.0：背压账本 acquire/release 包装——未挂载零介入） */
  private async executeNode(
    planId: string,
    node: PlanNode,
    signal: Signal,
    outputs: Map<string, string>,
    abortSignal: AbortSignal,
    ctx: PlanRunContext,
    recommendedModels?: Record<string, string>,
    avoidModels: string[] = [],
    forcedModel?: string,
  ): Promise<NodeResult> {
    this.backpressureLedger?.acquire(node.type);
    try {
      return await this.executeNodeInner(planId, node, signal, outputs, abortSignal, ctx, recommendedModels, avoidModels, forcedModel);
    } finally {
      this.backpressureLedger?.release(node.type);
    }
  }

  /** 单节点执行（4.0：熔断感知调度 + 分型差异化退避重试 + 质量反思切换、级联触发；A4：重试预算 / 对冲 / 审计 / 取消标记） */
  private async executeNodeInner(
    planId: string,
    node: PlanNode,
    signal: Signal,
    outputs: Map<string, string>,
    abortSignal: AbortSignal,
    ctx: PlanRunContext,
    recommendedModels?: Record<string, string>,
    avoidModels: string[] = [],
    /** 32.0：批内全局指派的模型（可用且未被规避时短路动态选型） */
    forcedModel?: string,
  ): Promise<NodeResult> {
    const context: Record<string, string> = {};
    for (const dep of node.dependsOn) {
      const depOutput = outputs.get(dep);
      if (depOutput) context[dep] = depOutput;
    }

    // 经验驱动选型：优化器推荐模型（按节点类型）优先，其次计划指定，最后模型调度动态评分
    // 2.0：经带洞察入口分配（预测置信度 + 探索标记，复盘时回注反思器做校准闭环）
    // 4.0：推荐/指定模型被规避（avoidModels）或熔断中 → 交由调度器动态评分选型
    // R4-2：挂载失败域后「熔断中」按「模型×任务类型」簇口径判定
    const avoidSet = new Set<string>(avoidModels);
    let preferred = recommendedModels?.[node.type];
    if (preferred && (avoidSet.has(preferred) || !this.modelExecutable(preferred, node.type))) preferred = undefined;
    // 创世纪 G4 · 推荐反垄断（单节点路径，与批量路径同语义）：
    // 以 overrideRate 概率放弃推荐交由动态选型。缺省 0 = 零漂移。
    if (preferred && this.explorationOverrideRate > 0 && Math.random() < this.explorationOverrideRate) {
      console.info(`[G4 推荐反垄断] 放弃推荐 ${preferred}（${node.type}），交动态选型`);
      preferred = undefined;
    }
    let plannedModel = node.modelId;
    if (plannedModel && (avoidSet.has(plannedModel) || !this.modelExecutable(plannedModel, node.type))) plannedModel = undefined;
    // 32.0：批内全局指派优先于逐节点动态评分（约束（指定/推荐）仍最高）
    const forced = forcedModel && !avoidSet.has(forcedModel) && this.modelExecutable(forcedModel, node.type) ? forcedModel : undefined;
    const assignment = plannedModel
      ? this.modelScheduler.modelInsight(node.type, plannedModel)
      : forced
        ? this.modelScheduler.modelInsight(node.type, forced)
        : this.modelScheduler.assignModelWithInsight(node.type, preferred, undefined, { avoidModels });
    let modelId = assignment.modelId;
    // 2.0：决策洞察持有对象引用而非位置索引——数组是跨任务共享的，
    // 并发任务的反思步骤会清空它（getAndClearDecisionInsights），
    // 位置索引届时指向不存在的槽位，成功回填将抛错并**把成功的执行
    // 误报为失败**（毒化校准与学习信号）；对象引用在清空后依然有效。
    const nodeInsight: (typeof this.decisionInsights)[number] = {
      nodeId: node.id,
      taskType: node.type,
      modelId,
      predictedConfidence: assignment.confidence,
      exploration: assignment.exploration,
      success: false,
    };
    this.decisionInsights.push(nodeInsight);
    const maxAttempts = this.config.maxRetries + 1;
    let lastError: string | undefined;
    /** 实际执行的尝试数（预算耗尽 / 致命错误 / 取消提前 break 时 < maxAttempts——失败结果如实上报） */
    let executedAttempts = 0;
    const nodeStartedAt = this.now();

    this.broadcast({ type: 'node-start', planId, nodeId: node.id, modelId, taskType: node.type });
    this.audit(ctx, { type: 'node-start', planId, nodeId: node.id, detail: `模型 ${modelId} · 依赖 [${node.dependsOn.join(', ')}]` });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (abortSignal.aborted) {
        lastError = ctx.externalCancel ? '计划取消，节点中止' : '全局超时，节点中止';
        break;
      }

      // A4-3：计划级重试预算——重试尝试（第 2 次起）逐次扣减，耗尽即诚实放弃
      if (attempt > 1) {
        if (ctx.retry.used >= ctx.retry.limit) {
          lastError = `计划级重试预算耗尽（已用 ${ctx.retry.used}/${this.config.planRetryBudget}），节点放弃重试`;
          this.audit(ctx, { type: 'node-retry', planId, nodeId: node.id, attempt, detail: lastError });
          break;
        }
        ctx.retry.used += 1;
        this.audit(ctx, { type: 'node-retry', planId, nodeId: node.id, attempt, detail: `第 ${attempt}/${maxAttempts} 次尝试（重试，计划预算已用 ${ctx.retry.used}/${ctx.retry.limit === Number.POSITIVE_INFINITY ? '∞' : ctx.retry.limit}）` });
      }

      // 4.0：熔断感知——当前模型在重试间隙被熔断（如同层节点打爆）时切到健康次优
      // R4-2：挂载失败域后按「模型×任务类型」簇裁决（其余簇不受影响）：
      // 簇降温中先重定向健康簇模型；全候选降温时诚实等待冷却（虚拟时钟口径）
      if (this.failureDomains) {
        const domainKey = FailureDomainRegistry.keyOf(modelId, node.type);
        const gate = this.failureDomains.allows(domainKey, this.now());
        if (!gate.allowed) {
          const healthy = this.pickHealthyFallback(node.type, modelId, avoidModels);
          if (healthy) {
            this.broadcast({ type: 'node-reflect', planId, nodeId: node.id, verdict: 'switch-model', reason: `失败域 ${domainKey} 降温中 → ${healthy}` });
            modelId = healthy;
            const refreshed = this.modelScheduler.modelInsight(node.type, healthy);
            nodeInsight.modelId = healthy;
            nodeInsight.predictedConfidence = refreshed.confidence;
            nodeInsight.exploration = false;
          } else {
            this.audit(ctx, { type: 'domain-wait', planId, nodeId: node.id, attempt, detail: `失败域 ${domainKey} 全候选降温中，等待冷却 ${gate.retryInMs}ms 后试探` });
            const slept = await this.waitAbortable(gate.retryInMs, abortSignal);
            if (!slept) {
              lastError = '全局超时，失败域冷却等待中中止';
              break;
            }
          }
        }
      } else if (!this.modelExecutable(modelId)) {
        const healthy = this.pickHealthyFallback(node.type, modelId, avoidModels);
        if (!healthy) {
          lastError = `模型 ${modelId} 熔断中且无可用替代`;
          this.broadcast({ type: 'node-error', planId, nodeId: node.id, error: lastError, attempt });
          this.audit(ctx, { type: 'node-error', planId, nodeId: node.id, attempt, detail: lastError });
          break;
        }
        this.broadcast({ type: 'node-reflect', planId, nodeId: node.id, verdict: 'switch-model', reason: `${modelId} 熔断 → ${healthy}` });
        modelId = healthy;
        const refreshed = this.modelScheduler.modelInsight(node.type, healthy);
        nodeInsight.modelId = healthy;
        nodeInsight.predictedConfidence = refreshed.confidence;
        nodeInsight.exploration = false;
      }

      // 4.0：获取执行资格——half-open 态占用探测名额（须与下方 record 成对释放）
      // R4-2：挂载失败域后簇级登记无探测互斥，模型级探测让位
      if (this.breakers && !this.failureDomains) {
        const probe = this.breakers.canExecute(modelId);
        if (!probe.allowed) continue; // 并发探测互斥：本轮让位，下轮重评
      }

      executedAttempts += 1;
      try {
        // A4-2：挂载对冲后走对冲路径（先到先得 + 成本记账）；否则原超时路径（零漂移）
        const runOutcome = this.hedgingOptions
          ? await this.runWithHedging(node, modelId, context, signal, attempt, abortSignal, ctx)
          : await this.runWithTimeout(node, modelId, context, signal, attempt, abortSignal, ctx);
        const { output, quality, tokensUsed } = runOutcome;
        // A4-6：节点延迟优先取注入 runner 自报的完成时刻（虚拟时钟口径），否则当前时刻
        const finishAt = readCompletedAt(runOutcome) ?? this.now();

        // 质量反思（深度优化：反思引擎动态阈值 + LLM-as-judge + 重试建议）
        const threshold = this.reflection?.getCurrentThreshold() ?? this.config.qualityThreshold;
        let verdict = { quality, passed: quality >= threshold, retryAdvice: 'retry-same' as 'retry-same' | 'retry-switch' | 'no-retry', reason: '' };
        if (this.reflection) {
          const reflected = await this.reflection.reflect({ node, output, baseQuality: quality, signal });
          verdict = { quality: reflected.quality, passed: reflected.passed, retryAdvice: reflected.retryAdvice, reason: reflected.reason };
        }

        if (verdict.passed) {
          if (this.failureDomains) this.failureDomains.recordSuccess(FailureDomainRegistry.keyOf(modelId, node.type));
          else this.breakers?.recordSuccess(modelId); // 4.0：质量达标即可用性恢复
          this.etaNote(node.type, finishAt - nodeStartedAt); // R4-3：成功延迟追记历史
          this.broadcast({ type: 'node-complete', planId, nodeId: node.id, latency: finishAt - nodeStartedAt, quality: verdict.quality, attempt });
          this.broadcast({ type: 'node-reflect', planId, nodeId: node.id, verdict: 'pass', reason: verdict.reason || `质量 ${verdict.quality.toFixed(2)} ≥ 阈值 ${threshold.toFixed(2)}` });
          this.audit(ctx, { type: 'node-complete', planId, nodeId: node.id, attempt, detail: `模型 ${modelId} · 质量 ${verdict.quality.toFixed(2)} · 延迟 ${finishAt - nodeStartedAt}ms` });
          nodeInsight.success = true; // 2.0：校准回填（预测 vs 实际；对象引用，并发清空安全）
          this.modelScheduler.reportHedgeOutcome(modelId, verdict.quality); // 31.0：对抗组合部分反馈（未挂载为空操作）
          this.ttcPlanner?.note(node.type, true); // 52.0：p̂ 遥测回填（未挂载为空操作）

          // 级联触发（仅质量达标时）
          this.triggerCascade(node, signal, output);

          return {
            nodeId: node.id,
            modelId,
            success: true,
            output,
            quality: verdict.quality,
            latency: finishAt - nodeStartedAt,
            attempts: attempt,
            tokensUsed: tokensUsed ?? 0,
          };
        }

        // 4.0：质量不达标 ≠ 不可用（模型响应正常）——不计入熔断，走换模型路径
        // R4-2：失败域登记无探测互斥，无需释放
        if (!this.failureDomains) this.breakers?.releaseProbe(modelId);
        this.broadcast({
          type: 'node-reflect',
          planId,
          nodeId: node.id,
          verdict: 'retry',
          reason: verdict.reason || `质量 ${verdict.quality.toFixed(2)} < 阈值 ${threshold.toFixed(2)}（第 ${attempt}/${maxAttempts} 次）`,
        });
        lastError = `质量不达标: ${verdict.quality.toFixed(2)}`;

        // 重试策略：反思引擎建议 retry-switch 或最后一次机会时切换模型
        if (attempt < maxAttempts) {
          const shouldSwitch = verdict.retryAdvice === 'retry-switch' || attempt === maxAttempts - 1;
          if (shouldSwitch) {
            const fallback = this.pickHealthyFallback(node.type, modelId, avoidModels);
            if (fallback) {
              this.broadcast({ type: 'node-reflect', planId, nodeId: node.id, verdict: 'switch-model', reason: `${modelId} → ${fallback}` });
              modelId = fallback;
              // 2.0：切换后刷新该节点的决策洞察（最终实际使用的模型才是校准对象）
              const refreshed = this.modelScheduler.modelInsight(node.type, fallback);
              nodeInsight.modelId = fallback;
              nodeInsight.predictedConfidence = refreshed.confidence;
              nodeInsight.exploration = false;
            }
          }
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.broadcast({ type: 'node-error', planId, nodeId: node.id, error: lastError, attempt });
        this.audit(ctx, { type: 'node-error', planId, nodeId: node.id, attempt, detail: lastError });

        // 4.0：错误分型——差异化重试策略（取代「仅超时重试、其余放弃」的粗路径）
        // R4-2：可用性失败按「模型×任务类型」失败域记账（仅熔断该簇）
        const classification = classifyError(err);
        if (classification.kind === 'timeout' || classification.kind === 'network' || classification.kind === 'rate-limit' || classification.kind === 'server') {
          if (this.failureDomains) {
            const domainKey = FailureDomainRegistry.keyOf(modelId, node.type);
            const tripped = this.failureDomains.recordFailure(domainKey, this.now());
            if (tripped) {
              this.audit(ctx, {
                type: 'domain-open',
                planId,
                nodeId: node.id,
                attempt,
                detail: `失败域 ${domainKey} 连续 ${this.failureDomainConfig?.failureThreshold} 次可用性失败 → 熔断降温 ${this.failureDomainConfig?.cooldownMs}ms（其余簇不受影响）`,
              });
            }
          } else {
            this.breakers?.recordFailure(modelId); // 可用性失败计入熔断
          }
        } else {
          // 客户端错误：下游已应答（可用性无恙）；未知错误：不判定可用性
          // R4-2：失败域登记无探测互斥，无需释放
          if (!this.failureDomains) this.breakers?.releaseProbe(modelId);
        }

        if (attempt >= maxAttempts) break;
        if (classification.class === 'retryable-backoff') {
          const delay = backoffDelayMs(attempt, {
            baseMs: this.config.retryBackoffBaseMs ?? 0,
            maxMs: this.config.retryBackoffMaxMs ?? 8_000,
          });
          if (delay > 0) {
            const slept = await this.waitAbortable(delay, abortSignal);
            if (!slept) {
              lastError = '全局超时，退避等待中中止';
              break;
            }
          }
          continue; // 网络抖动/限流/超时：退避后原模型重试（下游可能恢复）
        }
        if (classification.class === 'retryable-immediate') continue;
        break; // fatal：保守终止（与升级前非超时错误行为一致）
      }
    }

    // A4-4：取消传播的诚实标记——节点因计划取消而中止时如实记因
    if (abortSignal.aborted && ctx.externalCancel) {
      lastError = lastError?.includes('计划取消') ? lastError : '计划取消，节点中止';
      this.audit(ctx, { type: 'node-cancel', planId, nodeId: node.id, detail: `外部取消传播：${lastError}` });
    }

    this.modelScheduler.reportHedgeOutcome(modelId, 0); // 31.0：最终失败的部分反馈（未挂载为空操作）
    this.ttcPlanner?.note(node.type, false); // 52.0：p̂ 遥测回填（未挂载为空操作）
    return {
      nodeId: node.id,
      modelId,
      success: false,
      quality: 0,
      latency: this.now() - nodeStartedAt,
      attempts: executedAttempts,
      error: lastError ?? '未知错误',
      tokensUsed: 0,
    };
  }

  /**
   * A4-2：尾延迟对冲的单次尝试（挂载 attachHedging 后替代 runWithTimeout 的调用位）。
   *
   * 语义：主请求在飞超过 delayMs 即发对冲副本（≤ maxHedgesPerNode）；先到
   * 先得——虚拟时钟下按注入 runner 自报的 completedAt 裁定到达序（同刻按
   * 结算序），真实时钟下无自报时按结算序；胜者结果进入既有质量反思路径，
   * 落败副本经独立 AbortSignal 尽力取消。结算口径：全部飞行落定后裁定
   * （真实模式下取消信号先行使副本尽快退出，不空等其自然完成）。
   * 成本诚实：token = 胜者 + 全部副本；对冲不占重试预算、不计为一次尝试。
   */
  private async runWithHedging(
    node: PlanNode,
    modelId: string,
    context: Record<string, string>,
    signal: Signal,
    attempt: number,
    abortSignal: AbortSignal | undefined,
    ctx: PlanRunContext,
  ): Promise<AttemptOutcome & { hedgeMeta: { fired: number; extraTokens: number; canceled: number; savedMs: number; winner: 'primary' | 'hedge' } }> {
    // 副本专用中止信号：节点级中止级联到副本；落败副本经它取消
    const hedgeAbort = new AbortController();
    const cascadeCancel = () => hedgeAbort.abort();
    if (abortSignal?.aborted) hedgeAbort.abort();
    else abortSignal?.addEventListener('abort', cascadeCancel, { once: true });

    const timeout = node.timeout ?? this.config.nodeTimeout;
    const delayMs = Math.max(0, this.hedgingOptions?.delayMs ?? Math.floor(timeout / 2));
    const maxHedges = Math.max(0, this.hedgingOptions?.maxHedgesPerNode ?? 1);

    const records: HedgeFlightRecord[] = [];
    const settled: Array<Promise<void>> = [];
    let settleSeq = 0;

    const launch = (label: 'primary' | 'hedge'): void => {
      const slot = records.length;
      records.push({ label, ok: false, completedAt: 0, settleOrder: 0 });
      const flightSignal = label === 'primary' ? abortSignal : hedgeAbort.signal;
      settled.push(
        this.runWithTimeout(node, modelId, context, signal, attempt, flightSignal, ctx).then(
          (value: AttemptOutcome) => {
            records[slot] = { label, ok: true, value, completedAt: readCompletedAt(value) ?? this.now(), settleOrder: settleSeq++ };
          },
          (failure: unknown) => {
            records[slot] = { label, ok: false, failure, completedAt: readCompletedAt(failure) ?? this.now(), settleOrder: settleSeq++ };
          },
        ),
      );
    };

    // 先挂对冲阈值定时器、再放主请求——虚拟时钟下主请求的同步 advance 途经
    // 阈值时刻时定时器即时触发（先挂后放保证「在飞超阈值」的语义成立）
    let hedgesFired = 0;
    const hedgeTimer = maxHedges > 0
      ? this.armTimer(() => {
          if (hedgesFired >= maxHedges) return;
          hedgesFired += 1;
          ctx.hedge.count += 1;
          this.audit(ctx, { type: 'node-hedge', nodeId: node.id, attempt, detail: `主请求在飞超 ${delayMs}ms → 并行发出第 ${hedgesFired} 份对冲副本` });
          launch('hedge');
        }, delayMs)
      : undefined;

    launch('primary');

    try {
      await settled[0]; // 主飞行先落定
      hedgeTimer?.cancel(); // 主已落定——不再发新副本（虚拟时钟下发生在任何后续推进之前）
      if (hedgesFired > 0) await Promise.all(settled.slice(1));

      const primary = records[0];
      const successes = records.filter((r) => r.ok);
      if (successes.length === 0) {
        // 全部落空：抛主请求错误——重试/熔断语义与无对冲路径逐位一致
        throw primary.failure instanceof Error ? primary.failure : new Error(String(primary.failure));
      }
      // 先到先得：completedAt 升序，同刻按结算序（真实时钟下 completedAt 同为结算时刻 → 退化为结算序）
      successes.sort((a, b) => (a.completedAt === b.completedAt ? a.settleOrder - b.settleOrder : a.completedAt - b.completedAt));
      const winner = successes[0];
      const loserHedges = records.filter((r) => r !== winner && r.label === 'hedge');
      const extraTokens = records.filter((r) => r.label === 'hedge').reduce((sum, r) => sum + (r.value?.tokensUsed ?? 0), 0);
      const savedMs = winner.label === 'hedge' && primary.ok ? Math.max(0, primary.completedAt - winner.completedAt) : 0;

      if (loserHedges.length > 0) {
        hedgeAbort.abort();
        this.audit(ctx, { type: 'hedge-cancel', nodeId: node.id, attempt, detail: `对冲副本落败 ${loserHedges.length} 份，已取消` });
      }
      if (winner.label === 'hedge') {
        this.audit(ctx, {
          type: 'hedge-win',
          nodeId: node.id,
          attempt,
          detail: `对冲副本先到（${winner.completedAt}ms < 主 ${primary.completedAt}ms${savedMs > 0 ? `，省 ${savedMs}ms` : ''}）`,
        });
      }
      ctx.hedge.extraTokens += extraTokens;
      ctx.hedge.savedMs += savedMs;
      ctx.hedge.canceled += loserHedges.length;

      return {
        output: winner.value!.output,
        quality: winner.value!.quality,
        tokensUsed: (winner.value!.tokensUsed ?? 0) + extraTokens,
        completedAt: winner.completedAt,
        hedgeMeta: { fired: hedgesFired, extraTokens, canceled: loserHedges.length, savedMs, winner: winner.label },
      };
    } finally {
      hedgeTimer?.cancel();
      hedgeAbort.abort(); // 收尾：还在飞的副本一并终止
      abortSignal?.removeEventListener('abort', cascadeCancel);
    }
  }

  /**
   * 带节点级超时的 nodeRunner 调用（A4-6：虚拟时钟模式下挂虚拟定时器；结果透传
   * runner 自报 completedAt）。
   * R4-1：ctx.dispatchWidth 经可选字段 batchWidth 透传给注入 runner（环境建模口径；
   * 旧 runner 忽略无感）。R4-5：挂载失败注入后在此评估规则——命中即替代本次
   * runner 调用（error 直接抛 / timeout 虚拟时钟下先推进挂起时长再抛——推进途中
   * 可触发在途对冲阈值定时器 / low-quality 返回低质产出走质量反思路径）。
   */
  private async runWithTimeout(
    node: PlanNode,
    modelId: string,
    context: Record<string, string>,
    signal: Signal,
    attempt: number,
    abortSignal?: AbortSignal,
    ctx?: PlanRunContext,
  ): Promise<AttemptOutcome> {
    const timeout = node.timeout ?? this.config.nodeTimeout;
    // R4-5：失败注入演练——确定性逐次记账（在挂本飞行超时定时器之前评估，
    // 注入的挂起推进不受本飞行自身超时定时器干扰）
    const chaos = this.evalChaos(node, attempt, ctx);
    if (chaos) {
      if (chaos.kind === 'timeout') {
        const hangMs = Math.max(0, Math.floor(chaos.hangMs ?? timeout));
        this.clock?.advance(hangMs); // 虚拟挂起（真实时钟下不空转墙钟，直接判超时）
        throw new TimeoutError(`chaos(注入超时): 节点 ${node.id} 挂起 ${hangMs}ms`, { nodeId: node.id });
      }
      if (chaos.kind === 'error') {
        throw new Error(`chaos(注入失败): 节点 ${node.id} 命中 error 规则`);
      }
      return { output: `chaos:${node.id}`, quality: 0.05, tokensUsed: 1, completedAt: this.now() };
    }
    let timer: ExecutorTimerHandle | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = this.armTimer(() => reject(new TimeoutError(`节点 ${node.id} 执行超时（${timeout}ms）`, { nodeId: node.id })), timeout);
    });
    // R4-1：批宽经可选字段透出（非新鲜字面量赋值——结构化兼容，不扩 NodeRunner 契约）
    const runnerParams: {
      node: PlanNode;
      modelId: string;
      context: Record<string, string>;
      signal: Signal;
      abortSignal?: AbortSignal;
      attempt: number;
      batchWidth?: number;
    } = { node, modelId, context, signal, attempt, abortSignal };
    if (ctx?.dispatchWidth !== undefined) runnerParams.batchWidth = ctx.dispatchWidth;
    const exec = this.nodeRunner(runnerParams);
    // 旁路 handler：超时先决出胜者后，执行 Promise 后续 reject 在此被吞掉，
    // 避免 unhandled rejection；race 自身仍完整感知两者的第一落点
    exec.then(() => {}, () => {});
    try {
      const raced = await Promise.race([exec, timeoutPromise]);
      // 注入 runner 可自报 completedAt（虚拟时钟口径的完成时刻）——原样透传供上层裁定
      return raced as AttemptOutcome;
    } finally {
      timer?.cancel();
    }
  }

  /** R4-5：评估失败注入规则（按序首条命中即注入；逐规则限次，确定性命中） */
  private evalChaos(node: PlanNode, attempt: number, ctx?: PlanRunContext): ChaosRule | undefined {
    if (!this.chaosRules) return undefined;
    for (let i = 0; i < this.chaosRules.length; i += 1) {
      const rule = this.chaosRules[i]!;
      if (rule.nodeId !== undefined && rule.nodeId !== node.id) continue;
      if (rule.taskType !== undefined && rule.taskType !== node.type) continue;
      if (rule.attempt !== undefined && rule.attempt !== attempt) continue;
      const fired = this.chaosFired.get(i) ?? 0;
      if (fired >= (rule.hits ?? 1)) continue;
      this.chaosFired.set(i, fired + 1);
      if (ctx) this.audit(ctx, { type: 'chaos-inject', nodeId: node.id, attempt, detail: `注入规则 #${i}（${rule.kind}）命中——命中数 ${fired + 1}/${rule.hits ?? 1}` });
      return rule;
    }
    return undefined;
  }

  /** 默认节点执行器：通过 LLMClient 调用分配模型 */
  private async defaultNodeRunner(params: {
    node: PlanNode;
    modelId: string;
    context: Record<string, string>;
    signal: Signal;
    abortSignal?: AbortSignal;
    attempt: number;
  }): Promise<{ output: string; quality: number; tokensUsed?: number }> {
    const { node, modelId, context, signal } = params;
    const contextText = Object.entries(context)
      .map(([dep, output]) => `【上游 ${dep} 产出】\n${output}`)
      .join('\n\n');

    const response = await this.llm.chat(modelId, [
      { role: 'system', content: '你是任务执行器。直接输出任务结果，不要输出多余解释。' },
      {
        role: 'user',
        content: [
          `任务目标: ${signal.description}`,
          `当前子任务: ${node.description}`,
          `任务类型: ${node.type}`,
          contextText ? `上游依赖产出:\n${contextText}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ], { signal: params.abortSignal });

    return {
      output: response.content,
      // 启发式质量自评：非空输出基线 0.75，长度充足加分（真实场景可由评审模型打分）
      quality: response.content.trim().length > 0 ? Math.min(1, 0.75 + Math.min(0.2, response.content.length / 10_000)) : 0,
      tokensUsed: response.tokensUsed,
    };
  }

  /** 级联触发：节点完成且质量达标时回注下游信号 */
  private triggerCascade(node: PlanNode, signal: Signal, output: string): void {
    if (!node.cascade || node.cascade.length === 0 || !this.cascadeHandler) return;
    for (const cascade of node.cascade) {
      const newSignal = {
        type: cascade.type,
        description: cascade.description,
        payload: { triggeredBy: signal.id, nodeId: node.id, upstreamOutputPreview: output.slice(0, 500) },
      };
      this.broadcast({ type: 'cascade-trigger', nodeId: node.id, newSignal: { type: cascade.type, description: cascade.description } });
      try {
        this.cascadeHandler(newSignal);
      } catch {
        // 级联失败不影响当前计划
      }
    }
  }

  /** 拓扑分层（Kahn 算法），检测环 */
  private topologicalLayers(nodes: PlanNode[]): PlanNode[][] {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const inDegree = new Map<string, number>();
    for (const node of nodes) {
      inDegree.set(node.id, 0);
    }
    for (const node of nodes) {
      for (const dep of new Set(node.dependsOn)) {
        if (!nodeMap.has(dep)) throw new ExecutionError(`节点 ${node.id} 依赖不存在的节点 ${dep}`);
        // 入度按去重后的依赖计数：重复依赖边只计一次（与下方「存在即减一」
        // 的出边释放口径对齐——否则重复边双计入度、单次释放，节点永不出队
        // 被误判为循环依赖）
        inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
      }
    }

    const layers: PlanNode[][] = [];
    let frontier = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
    const visited = new Set<string>();

    while (frontier.length > 0) {
      layers.push(frontier);
      const next: PlanNode[] = [];
      for (const node of frontier) {
        visited.add(node.id);
        for (const other of nodes) {
          if (visited.has(other.id) || frontier.includes(other)) continue;
          if (other.dependsOn.includes(node.id)) {
            const deg = (inDegree.get(other.id) ?? 0) - 1;
            inDegree.set(other.id, deg);
            if (deg === 0) next.push(other);
          }
        }
      }
      frontier = next;
    }

    if (visited.size !== nodes.length) throw new ExecutionError('执行计划存在循环依赖');
    return layers;
  }

  /** DAG 结构校验（节点 id 唯一、依赖存在、无环） */
  private validateDag(rawNodes: any[]): boolean {
    const ids = new Set<string>();
    for (const n of rawNodes) {
      if (typeof n?.id !== 'string' || ids.has(n.id)) return false;
      ids.add(n.id);
    }
    for (const n of rawNodes) {
      const deps = Array.isArray(n.dependsOn) ? n.dependsOn : [];
      for (const dep of deps) {
        if (!ids.has(dep)) return false;
      }
    }
    try {
      this.topologicalLayers(rawNodes.map((n) => this.normalizeNode(n)));
      return true;
    } catch {
      return false;
    }
  }

  /** 归一化 strategist 输出的节点 */
  private normalizeNode(raw: any): PlanNode {
    return {
      id: String(raw.id),
      description: typeof raw.description === 'string' ? raw.description : String(raw.id),
      type: typeof raw.type === 'string' ? raw.type : 'general',
      dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
      modelId: typeof raw.modelId === 'string' ? raw.modelId : undefined,
      timeout: typeof raw.timeout === 'number' ? raw.timeout : undefined,
      cascade: Array.isArray(raw.cascade) ? raw.cascade.filter((c: any) => c && typeof c.type === 'string') : undefined,
    };
  }

  /** 进度事件广播（enableProgress 关闭时为空操作） */
  private broadcast(event: Record<string, any>): void {
    if (!this.config.enableProgress || !this.broadcaster) return;
    this.broadcaster.broadcast({ type: event.type as string, timestamp: Date.now(), ...event });
  }
}
