/**
 * autonomy-loop.ts — 自主心跳循环（自主智能的总节拍器）
 *
 * 职责：把全部自主组件串成一个自驱心跳，让系统在无外部信号的空闲期
 * 也持续自我观察、自我改进、自我进化、主动探索，且始终运行在安全边界内。
 *
 * 每轮心跳（tick）编排：
 * 1. 元认知观察：采集 KPI → 异常检测 + 参数自调优 + 自愈洞察
 * 2. 世界模型预见：到达预测 + 趋势检测 → 上升趋势转为负载预警洞察
 * 3. 洞察汇总：元认知自愈 + 反思教训 + 负载预警 → 目标引擎生成目标
 * 4. 子任务派发：价值最高优先，每个动作先经安全治理器裁决
 * 5. 好奇心探索：扫描知识盲区，预算内派发探索任务（治理器放行后）
 * 6. 策略进化：样本达标时触发种群进化，最优基因组落地决策引擎
 * 7. 记忆维护：定期经验蒸馏 + 遗忘曲线衰减（低频后台）
 *
 * 设计要点：
 * - 心跳间隔可配置，测试可手动 tick（不依赖真实定时器）
 * - 所有依赖经接口注入，冒烟测试可完全离线模拟
 * - 单轮心跳异常隔离，任一环节失败不影响其余环节
 * - 世界模型 / 好奇心 / 治理器均为可选注入，向后兼容旧调用方
 * - 第三轮升级（缺省零漂移）：显式相位机（观察→提案→执行→固化→休整，
 *   配比可配 + 相位遥测 + 注入时钟 + 相位预算让位记账）与心跳节奏
 *   自适应（间隔按待处理目标 × 事件密度负载几何插值，上下限钳位）——
 *   两项均挂载即生效，未挂载时每拍全流程、固定间隔
 * - 第四轮升级（激活与深化，均 opt-in、缺省零漂移）：
 *   ① 自主动作安全分级门（attachActionGate）：白名单三级（observe 只读
 *      / act 低风险写 / mutate 高风险变更），mutate 级需证书 + 可选确认 +
 *      冷却 + 单拍上限——被拒动作让位给后续可选子任务（排除集派发）；
 *   ② 自主行为时段治理（attachActivityWindow）：重活（mutate 级或指定
 *      任务类型）仅允许窗口（如低峰期 2:00–5:00，支持跨午夜）内派发，
 *      窗口外排队、窗口内优先恢复；consolidate 相位重活（进化/元认知环/
 *      记忆维护）窗口外顺延补做
 */

import type { GoalEngine, GoalSubtask, Goal, Insight, ActionRiskTier } from './goal-engine.js';
import type { MetaCognitionEngine, KpiSnapshot } from './meta-cognition.js';
import type { StrategyEvolutionEngine } from './strategy-evolution.js';
import type { Lesson } from './reflection-engine.js';
import type { WorldModel } from './world-model.js';
import type { CuriosityEngine, ExplorationProposal } from './curiosity-engine.js';
import type { SafetyGovernor } from './safety-governor.js';

// 第二轮创世纪 96.0：全局工作空间（跨引擎意识总线——单步广播焦点仲裁）
import {
  ConsciousnessBus,
  type EngineBidderSpec,
  type GwtStepResult,
} from './engines-frontier/autonomy25.js';

/** KPI 采集器（由 index.ts 桥接真实引擎状态） */
export type KpiCollector = () => KpiSnapshot;

/** 子任务派发器（由 index.ts 桥接到 sentinel.ingest，返回信号 id） */
export type SubtaskDispatcher = (subtask: GoalSubtask, goal: Goal) => string;

/** 探索任务派发器（由 index.ts 桥接到 sentinel.ingest，返回信号 id） */
export type ExplorationDispatcher = (proposal: ExplorationProposal) => string;

/** 记忆维护器（由 index.ts 桥接到长期记忆） */
export interface MemoryMaintainer {
  distillExperience(): number;
  applyForgettingCurve(): { decayed: number; forgotten: number };
  /**
   * 知识蒸馏（第二阶段）：从情景记忆蒸馏出语义+程序记忆
   * @returns 蒸馏产出的语义/程序记忆条数（{ semantic, procedural }）
   */
  distillKnowledge?(): Promise<{ semantic: number; procedural: number }>;
}

/** 反思教训提供器（由 index.ts 桥接到反思引擎） */
export type LessonProvider = () => Lesson[];

/** 策略落地器（进化产物应用到决策引擎） */
export type StrategyApplier = (config: Record<string, any>) => void;

/**
 * 调度策略进化桥接器（第三阶段：由 index.ts 桥接到 PolicyEvolver + Sandbox）
 *
 * 心跳进化段调用 runEvolutionCycle 触发「变异 → 沙盒评估 → 择优 → 热切换」；
 * 沙盒离线运行，不阻塞操作环任务调度。
 */
export interface PolicyEvolutionBridge {
  runEvolutionCycle(): Promise<unknown>;
}

/**
 * 元认知环桥接器（第四阶段：由 index.ts 桥接到 SelfModel + MetaCognitiveController）
 *
 * 心跳低频段调用 runMetaCycle 触发「自我建模 → 心智报告 → 保守调整 →
 * 观察判定/回滚」——系统观察并改进自身的进化机制（双环外环）。
 */
export interface MetaCognitionBridge {
  runMetaCycle(): Promise<unknown>;
}

/**
 * 共生进化桥接器（第五阶段 Phase 2.5：由 index.ts 桥接到 SymbiosisBridge）
 *
 * 心跳每拍调用 runSymbiosisTick：宿主 KPI 注入共生运行时（能量经济 +
 * 信念市场），市场价 vs 被动统计估计的显著背离回流为漂移洞察——
 * 模型漂移的第一现场由市场先行报警，进入目标引擎的自愈链路。
 */
export interface SymbiosisBridgeHook {
  runSymbiosisTick(snapshot: KpiSnapshot): Promise<Insight[]>;
}

/**
 * 25.0 容量规划顾问（由 index.ts 桥接到 CapacityPlanner）。
 *
 * 心跳 2.5 段调用：λ̂（世界模型预测到达率）× 服务统计（稳健平均延迟）
 * 反解最小可行并发，不可行（ρ≥1）或建议并发超出当前 1.2 倍时返回
 * capacity-warning 洞察（扩容/降载）；无数据或未启用时返回空数组。
 * 失败由调用侧静默隔离，不阻断主链路。
 */
export type CapacityAdvisor = () => Insight[] | void;
/** 28.0：尾部风险顾问（心跳 2.7 段消费，缺省零改动） */
export type TailRiskAdvisor = () => Insight[] | void;
/**
 * 33.0：系统性风险顾问（心跳 2.8 段消费，缺省零改动）。
 *
 * 由 index.ts 桥接到 SystemicRiskMonitor：每轮心跳喂入各模型本期
 * 失败计数，窗口攒满后相关矩阵经 Marchenko–Pastur 清洗——伪相关被
 * 噪声带吸收（不误报），真实共同因子（λ₁ 显著超带 + 解释份额达标）
 * 产出 systemic-risk 洞察（同一上游/厂商的模型同沉浮，热备是幻觉）。
 * 失败由调用侧静默隔离，不阻断主链路。
 */
export type SystemicRiskAdvisor = () => Insight[] | void;
/**
 * 41.0：排队网络顾问（心跳 2.9 段消费，缺省零改动）。
 *
 * 由 index.ts 桥接到 tandemNetwork：各模型作为独立 M/M/c 站、到达率
 * 按当前流量份额分摊，Erlang-C 口径解出瓶颈站（ρ 最大）与端到端
 * 逗留——瓶颈站接近饱和（ρ ≥ 0.85）或不可稳定时产出 capacity-flow
 * 洞察（Jackson 乘积形式背书）。失败由调用侧静默隔离。
 */
export type QueueingNetworkAdvisor = () => Insight[] | void;
/** 自主心跳配置 */
export interface AutonomyLoopConfig {
  /** 心跳间隔（毫秒） */
  heartbeatMs: number;
  /** 单轮最多派发的子任务数（防止一次性灌入过多信号） */
  maxDispatchPerTick: number;
  /** 每 N 轮心跳触发一次记忆维护 */
  maintenanceEveryTicks: number;
  /** 第四阶段：每 N 轮心跳触发一次元认知环（自我建模 + 保守调整；缺省 7） */
  metaCognitionEveryTicks: number;
  /** 每轮最多生成的目标数 */
  maxGoalsPerTick: number;
  /** 是否启用策略进化落地 */
  enableStrategyEvolution: boolean;
  /** 是否启用好奇心探索（缺省 true，需注入好奇心引擎） */
  enableExploration: boolean;
  /** 到达预测窗口（毫秒，缺省 5 分钟） */
  predictionHorizonMs: number;
}

/** 默认配置 */
export const DEFAULT_AUTONOMY_LOOP_CONFIG: AutonomyLoopConfig = {
  heartbeatMs: 30_000,
  maxDispatchPerTick: 2,
  maintenanceEveryTicks: 10,
  metaCognitionEveryTicks: 7,
  maxGoalsPerTick: 3,
  enableStrategyEvolution: true,
  enableExploration: true,
  predictionHorizonMs: 5 * 60_000,
};

/**
 * 第三轮升级：心跳相位（显式相位机的五相位——观察 → 提案 → 执行 →
 * 固化 → 休整）。挂载后每拍只执行本相位的工作组；未挂载 → 每拍全流程
 * （行为逐位不变，零漂移）。
 */
export type HeartbeatPhase = 'observe' | 'propose' | 'execute' | 'consolidate' | 'rest';

/** 相位机配置（attachPhaseMachine） */
export interface PhaseMachineOptions {
  /**
   * 每周期各相位拍数（配比可配；缺省 { observe:1, propose:1, execute:2,
   * consolidate:1, rest:1 } = 周期 6 拍，执行加倍）。0 = 该相位退出轮转。
   */
  ratios?: Partial<Record<HeartbeatPhase, number>>;
  /**
   * 相位时间预算（毫秒）：超预算相位记「债」，后续轮转中让位（跳过
   * 自己的槽位还债，槽位顺延给下一相位）——超支相位不再挤占心跳。
   */
  budgetsMs?: Partial<Record<HeartbeatPhase, number>>;
  /** 注入时钟（相位时长计量；缺省 Date.now）——相位推进确定性的测试轴 */
  clock?: () => number;
}

/** 相位遥测（phaseView 读数） */
export interface PhaseTelemetry {
  /** 相位轮转基序列（ratios 展开后的确定性循环） */
  baseSequence: HeartbeatPhase[];
  /** 相位配比（挂载口径） */
  ratios: Record<HeartbeatPhase, number>;
  /** 基序列游标（下一次取相位的下标） */
  cursor: number;
  /** 周期序号（cursor / 周期长度，向下取整） */
  cycleIndex: number;
  /** 各相位已执行拍数 */
  counts: Record<HeartbeatPhase, number>;
  /** 各相位累计耗时（毫秒，注入时钟计量） */
  durationsMs: Record<HeartbeatPhase, number>;
  /** 各相位超预算次数 */
  overruns: Record<HeartbeatPhase, number>;
  /** 各相位让位槽位数（预算债偿还） */
  yielded: Record<HeartbeatPhase, number>;
  /** 当前未偿还预算债（槽位数） */
  debt: Record<HeartbeatPhase, number>;
  /** 最近一次执行的相位 */
  lastPhase?: HeartbeatPhase;
  /** 最近一拍相位耗时（毫秒） */
  lastDurationMs?: number;
}

/** 心跳节奏自适应配置（attachAdaptiveHeartbeat） */
export interface AdaptiveHeartbeatOptions {
  /** 间隔下限（毫秒，缺省 heartbeatMs / 4；再忙也不压垮） */
  minMs?: number;
  /** 间隔上限（毫秒，缺省 heartbeatMs × 4；再闲也不睡死） */
  maxMs?: number;
  /** 待处理子任务满载参考（缺省 8：≥8 个 pending 子任务记满载） */
  pendingRef?: number;
  /** 事件密度满载参考（缺省每拍 20 事件记满载） */
  densityRef?: number;
  /** 待处理目标负载权重（缺省 0.5） */
  pendingWeight?: number;
  /** 事件密度负载权重（缺省 0.5） */
  densityWeight?: number;
  /** 外部事件密度提供器（缺省用内部洞察数 EWMA——α=0.3） */
  eventDensity?: () => number;
}

/** 节奏自适应遥测（adaptiveHeartbeatView 读数） */
export interface AdaptiveHeartbeatTelemetry {
  /** 负载 0~1（待处理目标 × 事件密度加权；0.5 为基线中性点） */
  load: number;
  /** 待处理子任务数（负载轴一） */
  pendingGoals: number;
  /** 事件密度（负载轴二；外部提供器或内部 EWMA） */
  eventDensity: number;
  /** 当前生效心跳间隔（毫秒） */
  intervalMs: number;
  /** 已压到下限（load ≥ 1 钳位） */
  clampedLow: boolean;
  /** 已顶到上限（load ≤ 0 钳位） */
  clampedHigh: boolean;
}

// ─────────────── 第四轮升级：动作安全分级门（attachActionGate） ───────────────

/** 动作安全分级门配置 */
export interface ActionGateOptions {
  /** taskType → 风险级映射（子任务显式声明 riskTier 时以声明优先） */
  tiers?: Record<string, ActionRiskTier>;
  /** 未映射且未声明的缺省风险级（缺省 'act'——低风险写，与既有派发口径一致） */
  defaultTier?: ActionRiskTier;
  /** 高风险证书提供器（mutate 级必需；缺省 () => false——未配置证书时高风险一律拒绝，fail-closed） */
  credential?: () => boolean;
  /** 高风险人工确认回调（配置后 mutate 级额外需要其放行） */
  confirmation?: (goal: Goal, subtask: GoalSubtask) => boolean;
  /** act 级冷却（毫秒，两次 act 派发最小间隔；0 = 关闭，缺省 0） */
  actCooldownMs?: number;
  /** mutate 级冷却（毫秒；0 = 关闭，缺省 60 秒） */
  mutateCooldownMs?: number;
  /** 单拍 mutate 级派发上限（缺省 1——高风险每拍至多一次） */
  maxMutatePerTick?: number;
  /** 注入时钟（冷却计量；缺省 Date.now）——分级门的确定性测试轴 */
  clock?: () => number;
}

/** 分级门裁决（authorizeAction 返回口径） */
export interface ActionGateVerdict {
  /** 解析出的风险级（声明 riskTier > tiers 映射 > defaultTier） */
  tier: ActionRiskTier;
  allowed: boolean;
  /** 拒绝原因（mutate-no-credential / mutate-unconfirmed / mutate-cooldown / mutate-cap-per-tick / act-cooldown） */
  reasons: string[];
}

/** 分级门遥测（actionGateView 读数） */
export interface ActionGateTelemetry {
  defaultTier: ActionRiskTier;
  actCooldownMs: number;
  mutateCooldownMs: number;
  maxMutatePerTick: number;
  /** 已放行并派发的动作数（循环派发口径） */
  allowed: number;
  /** 已拒绝的动作数（循环派发口径） */
  denied: number;
  /** 已派发的 mutate 级动作数 */
  mutateDispatched: number;
  /** 本拍已派发 mutate 数（单拍上限的当前占用） */
  mutateThisTick: number;
  /** 最近一次 mutate 派发时刻（冷却起点） */
  lastMutateAt?: number;
  /** 拒绝原因计数 */
  byReason: Record<string, number>;
}

// ─────────────── 第四轮升级：行为时段治理（attachActivityWindow） ───────────────

/** 时段窗口治理配置 */
export interface ActivityWindowOptions {
  /** 允许窗口（小时口径，含小数；[startHour, endHour)——支持跨午夜如 22→6；startHour === endHour 退化为全天允许） */
  window: { startHour: number; endHour: number };
  /** 视为「重活」的风险级集合（缺省 ['mutate']） */
  heavyTiers?: ActionRiskTier[];
  /** 视为「重活」的任务类型集合（缺省空） */
  heavyTaskTypes?: string[];
  /** 注入时钟（缺省 () => new Date()）——时段判定的确定性测试轴 */
  clock?: () => Date;
  /** 窗口外排队上限（缺省 64——防无界积压，队满丢最旧） */
  maxQueue?: number;
}

/** 时段窗口治理遥测（activityWindowView 读数） */
export interface ActivityWindowTelemetry {
  window: { startHour: number; endHour: number };
  heavyTiers: ActionRiskTier[];
  heavyTaskTypes: string[];
  /** 当前是否在允许窗口内 */
  insideWindow: boolean;
  /** 当前小时（注入时钟口径，审计用） */
  currentHour: number;
  /** 当前排队中的重活数 */
  queued: number;
  /** 累计入队数 */
  totalQueued: number;
  /** 累计窗口内恢复派发数 */
  drained: number;
}

/** 单轮心跳摘要 */
export interface TickReport {
  tick: number;
  timestamp: number;
  insightsCollected: number;
  goalsCreated: number;
  subtasksDispatched: number;
  /** 本轮派发的探索任务数 */
  explorationsDispatched: number;
  /** 本轮被治理器拦截的动作数 */
  governanceBlocked: number;
  /** 世界模型预测摘要（rising 趋势类型） */
  risingTrends: string[];
  evolved: boolean;
  maintenance?: { distilled: number; decayed: number; forgotten: number; semanticDistilled?: number; proceduralDistilled?: number };
  healthScore: number;
  /** 第三轮相位机：本轮所属心跳相位（未挂载相位机时缺席） */
  phase?: HeartbeatPhase;
  /** 第三轮陈旧检测：本轮 propose 相位处置的停滞目标数（降级/合并） */
  stalledHandled?: number;
  /** 第四轮安全分级门：本轮被分级门拒绝的派发数（未挂载时缺席） */
  actionGated?: number;
  /** 第四轮时段治理：本轮因窗口外而入队的重活数（未挂载时缺席） */
  windowQueued?: number;
  /** 第四轮时段治理：本轮从窗口队列恢复派发的重活数（未挂载时缺席） */
  windowDrained?: number;
}

/**
 * 自主心跳循环
 *
 * 被 index.ts 持有：插件启动时 start()，fiber 卸载时 stop()。
 * 测试可绕过定时器直接调用 tick() 驱动单轮心跳。
 */
export class AutonomyLoop {
  private config: AutonomyLoopConfig;
  private goalEngine: GoalEngine;
  private metaCognition: MetaCognitionEngine;
  private evolution: StrategyEvolutionEngine;
  private collectKpi: KpiCollector;
  private dispatchSubtask: SubtaskDispatcher;
  private maintainer: MemoryMaintainer;
  private lessonProvider: LessonProvider;
  private strategyApplier?: StrategyApplier;
  /** 第三阶段：调度策略进化桥接（可选注入） */
  private policyEvolution?: PolicyEvolutionBridge;
  /** 第四阶段：元认知环桥接（可选注入） */
  private metaCognitionBridge?: MetaCognitionBridge;
  /** 第五阶段 Phase 2.5：共生进化桥接（可选注入，缺省不启用） */
  private symbiosis?: SymbiosisBridgeHook;
  /** 25.0：容量规划顾问（可选注入；心跳 2.5 段消费，缺省零改动） */
  private capacityAdvisor?: CapacityAdvisor;
  /** 28.0：尾部风险顾问（可选注入；心跳 2.7 段消费，缺省零改动） */
  private tailRiskAdvisor?: TailRiskAdvisor;
  /** 33.0：系统性风险顾问（可选注入；心跳 2.8 段消费，缺省零改动） */
  private systemicRiskAdvisor?: SystemicRiskAdvisor;
  /** 41.0：排队网络顾问（可选注入；心跳 2.9 段消费，缺省零改动） */
  private networkAdvisor?: QueueingNetworkAdvisor;
  // 可选自主组件（向后兼容）
  private worldModel?: WorldModel;
  private curiosity?: CuriosityEngine;
  private governor?: SafetyGovernor;
  private dispatchExploration?: ExplorationDispatcher;

  // ── 第四轮升级：动作安全分级门 / 行为时段治理（未挂载零漂移） ──
  /** 安全分级门状态（attachActionGate 挂载；未挂载 undefined → 派发零介入） */
  private actionGateState?: {
    tiers: Record<string, ActionRiskTier>;
    defaultTier: ActionRiskTier;
    credential: () => boolean;
    confirmation?: (goal: Goal, subtask: GoalSubtask) => boolean;
    actCooldownMs: number;
    mutateCooldownMs: number;
    maxMutatePerTick: number;
    clock: () => number;
    lastActAt?: number;
    lastMutateAt?: number;
    mutateThisTick: number;
    allowedCount: number;
    deniedCount: number;
    mutateDispatched: number;
    byReason: Record<string, number>;
  };
  /** 时段窗口治理状态（attachActivityWindow 挂载；未挂载 undefined → 派发零介入） */
  private activityWindowState?: {
    startHour: number;
    endHour: number;
    heavyTiers: Set<ActionRiskTier>;
    heavyTaskTypes: Set<string>;
    clock: () => Date;
    maxQueue: number;
    totalQueued: number;
    drained: number;
  };
  /** 窗口外排队的重活（goalId + subtaskId；窗口内优先恢复派发） */
  private windowQueue: Array<{ goalId: string; subtaskId: string }> = [];

  private timer: ReturnType<typeof setInterval> | null = null;
  /** 重入保护：上一轮 tick 未完成时跳过新 tick */
  private ticking = false;
  private running = false;
  private tickCount = 0;
  private reports: TickReport[] = [];
  /** 已消化过的教训 id（避免重复生成目标） */
  private consumedLessons = new Set<string>();

  constructor(params: {
    config?: Partial<AutonomyLoopConfig>;
    goalEngine: GoalEngine;
    metaCognition: MetaCognitionEngine;
    evolution: StrategyEvolutionEngine;
    collectKpi: KpiCollector;
    dispatchSubtask: SubtaskDispatcher;
    maintainer: MemoryMaintainer;
    lessonProvider: LessonProvider;
    strategyApplier?: StrategyApplier;
    /** 第三阶段：调度策略进化桥接（可选，缺省不启用） */
    policyEvolution?: PolicyEvolutionBridge;
    /** 第四阶段：元认知环桥接（可选，缺省不启用） */
    metaCognitionBridge?: MetaCognitionBridge;
    /** 第五阶段 Phase 2.5：共生进化桥接（可选，缺省不启用） */
    symbiosis?: SymbiosisBridgeHook;
    /** 25.0：容量规划顾问（可选，缺省不启用） */
    capacityAdvisor?: CapacityAdvisor;
    /** 28.0：尾部风险顾问（可选，缺省不启用） */
    tailRiskAdvisor?: TailRiskAdvisor;
    /** 33.0：系统性风险顾问（可选，缺省不启用） */
    systemicRiskAdvisor?: SystemicRiskAdvisor;
    /** 41.0：排队网络顾问（可选，缺省不启用） */
    networkAdvisor?: QueueingNetworkAdvisor;
    worldModel?: WorldModel;
    curiosity?: CuriosityEngine;
    governor?: SafetyGovernor;
    dispatchExploration?: ExplorationDispatcher;
  }) {
    this.config = { ...DEFAULT_AUTONOMY_LOOP_CONFIG, ...params.config };
    this.goalEngine = params.goalEngine;
    this.metaCognition = params.metaCognition;
    this.evolution = params.evolution;
    this.collectKpi = params.collectKpi;
    this.dispatchSubtask = params.dispatchSubtask;
    this.maintainer = params.maintainer;
    this.lessonProvider = params.lessonProvider;
    this.strategyApplier = params.strategyApplier;
    this.policyEvolution = params.policyEvolution;
    this.metaCognitionBridge = params.metaCognitionBridge;
    this.symbiosis = params.symbiosis;
    this.capacityAdvisor = params.capacityAdvisor;
    this.tailRiskAdvisor = params.tailRiskAdvisor;
    this.systemicRiskAdvisor = params.systemicRiskAdvisor;
    this.networkAdvisor = params.networkAdvisor;
    this.worldModel = params.worldModel;
    this.curiosity = params.curiosity;
    this.governor = params.governor;
    this.dispatchExploration = params.dispatchExploration;
  }

  /** 启动心跳定时器（间隔 = 当前生效值：固定 heartbeatMs 或自适应估值） */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        /* 单轮心跳异常隔离 */
      });
    }, this.currentHeartbeatMs());
    this.timer.unref?.();
  }

  /** 停止心跳 */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 是否运行中 */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * 执行一轮心跳（自主智能的核心节拍）
   *
   * 重入保护：心跳是异步长链路（目标分解 / 沙盒进化 / 元认知环都可能
   * 慢于 heartbeatMs），interval 触发的新 tick 与滞留中的旧 tick 并发
   * 会双重派发目标与探索、双重触发维护与进化——上一轮未完成时本轮
   * 直接跳过（返回空摘要，不推进计数）
   * @returns 本轮摘要
   */
  async tick(): Promise<TickReport> {
    if (this.ticking) {
      return {
        tick: this.tickCount,
        timestamp: Date.now(),
        insightsCollected: 0,
        goalsCreated: 0,
        subtasksDispatched: 0,
        explorationsDispatched: 0,
        governanceBlocked: 0,
        risingTrends: [],
        evolved: false,
        healthScore: 1,
      };
    }
    this.ticking = true;
    try {
      return await this.runTick();
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(): Promise<TickReport> {
    this.tickCount += 1;
    // 第三轮相位机：挂载时每拍只执行本相位的工作组（确定性轮转）；
    // 未挂载 → 相位 undefined，全部 inPhase 为真 → 行为与原全流程逐位一致
    const phase = this.phaseState ? this.takePhase() : undefined;
    if (this.phaseState) this.phaseState.current = phase;
    const phaseStart = this.phaseState ? this.phaseState.clock() : 0;
    const report: TickReport = {
      tick: this.tickCount,
      timestamp: Date.now(),
      insightsCollected: 0,
      goalsCreated: 0,
      subtasksDispatched: 0,
      explorationsDispatched: 0,
      governanceBlocked: 0,
      risingTrends: [],
      evolved: false,
      healthScore: 1,
    };
    if (phase) report.phase = phase;
    // 第四轮分级门：单拍 mutate 上限计数复位（新拍重新计额）
    if (this.actionGateState) this.actionGateState.mutateThisTick = 0;

    let insights: Insight[] = [];
    let kpiSnapshot: KpiSnapshot | undefined;

    // ── 1. 元认知观察：采集 KPI → 异常检测 + 自愈洞察 ──
    if (this.inPhase('observe')) {
      try {
        kpiSnapshot = this.collectKpi();
        insights = this.metaCognition.observe(kpiSnapshot);
        report.healthScore = this.metaCognition.getHealthReport().score ?? 1;
      } catch {
        /* KPI 采集失败不阻断 */
      }
    }

    // ── 1.5 共生心跳（第五阶段 Phase 2.5）：KPI 注入能量经济 + 信念市场 ──
    // 市场隐含概率 vs 被动统计估计显著背离 → 漂移洞察回流目标引擎（自愈链路）
    if (this.inPhase('observe')) {
      try {
        if (this.symbiosis && kpiSnapshot) {
          const driftInsights = await this.symbiosis.runSymbiosisTick(kpiSnapshot);
          insights.push(...driftInsights);
        }
      } catch {
        /* 共生心跳失败不阻断主链路 */
      }
    }

    // ── 2. 世界模型预见：趋势检测 → 负载预警洞察 ──
    if (this.inPhase('observe')) {
      try {
        if (this.worldModel) {
          const trends = this.worldModel.detectTrends();
          for (const trend of trends) {
            if (trend.trend !== 'rising') continue;
            report.risingTrends.push(trend.type);
            insights.push({
              source: 'meta-cognition',
              category: 'load-forecast',
              taskType: trend.type,
              severity: 0.5,
              message: `世界模型预测「${trend.type}」信号到达率上升（斜率 ${trend.slopePerMin}/min²）`,
              suggestion: `为「${trend.type}」预留执行容量并优化其处理链路`,
            });
          }
          // 预测校准对账（窗口到期的预测）
          this.worldModel.settleCalibrations();
        }
      } catch {
        /* 预见失败不阻断 */
      }
    }

    // ── 2.5 容量规划（25.0）：λ̂ × 服务统计 → 反解最小并发 ──
    // 世界模型预测到达率 + 稳健延迟估计喂入排队论规划器（Erlang-C /
    // Kingman 反解），不可行（ρ≥1）或建议并发超出当前 1.2 倍时产出
    // capacity-warning 洞察回流目标引擎。未注入顾问时零改动；
    // 失败静默（容量规划不阻断主链路）。
    if (this.inPhase('observe')) {
      try {
        if (this.capacityAdvisor) {
          const capacityInsights = this.capacityAdvisor();
          if (capacityInsights && capacityInsights.length > 0) {
            insights.push(...capacityInsights);
          }
        }
      } catch {
        /* 容量规划失败不阻断 */
      }
    }

    // ── 2.7 尾部风险评估（28.0）：延迟样本 → POT/GPD → 尾部外推洞察 ──
    // 经验 p99.9 = 样本最大值（运气）；POT/GPD 外推有 Pickands–
    // Balkema–de Haan 定理背书（含 bootstrap CI）。未注入顾问时零改动；
    // 失败静默（尾部评估不阻断主链路）。
    if (this.inPhase('observe')) {
      try {
        if (this.tailRiskAdvisor) {
          const tailInsights = this.tailRiskAdvisor();
          if (tailInsights && tailInsights.length > 0) {
            insights.push(...tailInsights);
          }
        }
      } catch {
        /* 尾部评估失败不阻断 */
      }
    }

    // ── 2.8 系统性风险评估（33.0）：失败相关性 → MP 清洗 → 共同因子洞察 ──
    // 样本相关矩阵的大多数谱结构是纯噪声（Marchenko–Pastur 带）；
    // 清洗后头号特征值仍显著超带 = 存在共同因子（同厂商/同上游）——
    // 「看起来分散」的模型冗余是统计幻觉。未注入顾问时零改动；
    // 失败静默（系统性评估不阻断主链路）。
    if (this.inPhase('observe')) {
      try {
        if (this.systemicRiskAdvisor) {
          const systemicInsights = this.systemicRiskAdvisor();
          if (systemicInsights && systemicInsights.length > 0) {
            insights.push(...systemicInsights);
          }
        }
      } catch {
        /* 系统性评估失败不阻断 */
      }
    }

    // ── 2.9 排队网络评估（41.0）：模型站 M/M/c × 流量份额 → 瓶颈站洞察 ──
    // 单站反解（25.0）只看一台排队机；串联视角下瓶颈站（ρ 最大）才是
    // 吞吐的钳制者——其他站再快也无济于事。未注入顾问时零改动；
    // 失败静默（网络评估不阻断主链路）。
    if (this.inPhase('observe')) {
      try {
        if (this.networkAdvisor) {
          const networkInsights = this.networkAdvisor();
          if (networkInsights && networkInsights.length > 0) {
            insights.push(...networkInsights);
          }
        }
      } catch {
        /* 排队网络评估失败不阻断 */
      }
    }

    // ── 3. 汇总反思教训洞察（去重已消化的教训） ──
    if (this.inPhase('observe')) {
      try {
        const lessons = this.lessonProvider();
        for (const lesson of lessons) {
          if (this.consumedLessons.has(lesson.id)) continue;
          this.consumedLessons.add(lesson.id);
          insights.push({
            source: 'reflection',
            category: lesson.rootCause,
            taskType: lesson.taskType,
            severity: lesson.rootCause === 'model-capability' || lesson.rootCause === 'timeout' ? 0.7 : 0.5,
            message: lesson.lesson,
            suggestion: lesson.suggestion,
          });
        }
      } catch {
        /* 教训读取失败不阻断 */
      }
      report.insightsCollected = insights.length;
      // 相位机：observe 拍的洞察入缓冲，等最近的 propose 拍消费
      // （未挂载相位机 → 同拍直通，行为不变）
      if (this.phaseState) this.insightBuffer.push(...insights);
    }

    // ── 4. 目标生成（限制单轮数量）──
    if (this.inPhase('propose')) {
      // 相位机：消费 observe 缓冲的洞察（未挂载 → 用本拍刚收集的）
      const effectiveInsights = this.phaseState ? this.insightBuffer.splice(0, this.insightBuffer.length) : insights;
      try {
        const created = this.goalEngine.generateGoalsFromInsights(effectiveInsights).slice(0, this.config.maxGoalsPerTick);
        report.goalsCreated = created.length;
        // 立即分解新目标，使其可执行
        for (const goal of created) {
          await this.goalEngine.decompose(goal.id);
        }
      } catch {
        /* 目标生成失败不阻断 */
      }
      // 第三轮陈旧检测：propose 拍顺带处置停滞目标（降级/合并）——
      // 只有挂载相位机的循环才在心跳里扫（未挂载零漂移，宿主可手动 sweep）
      if (this.phaseState) {
        try {
          const actions = this.goalEngine.sweepStalledGoals();
          report.stalledHandled = actions.length;
        } catch {
          /* 陈旧检测失败不阻断 */
        }
      }
    }

    // ── 5. 子任务派发（优先序最高优先 + 治理器/分级门/时段窗裁决） ──
    if (this.inPhase('execute')) {
      try {
        // 第四轮时段治理：窗口内优先恢复排队的重活（与常规派发共享单拍预算）
        if (this.activityWindowState && this.windowQueue.length > 0 && this.inActivityWindow()) {
          while (this.windowQueue.length > 0 && report.subtasksDispatched < this.config.maxDispatchPerTick) {
            const entry = this.windowQueue.shift()!;
            const goal = this.goalEngine.getGoal(entry.goalId);
            const subtask = goal?.subtasks.find((s) => s.id === entry.subtaskId && s.status === 'pending');
            if (!goal || !subtask) continue; // 陈旧排队项（目标已终态/子任务已迁移）——静默丢弃
            if (this.governor) {
              const verdict = this.governor.govern('goal-dispatch', goal.confidence);
              if (!verdict.allowed) {
                report.governanceBlocked += 1;
                this.windowQueue.unshift(entry); // 保留排队，下轮再试
                break;
              }
            }
            if (this.actionGateState) {
              const verdict = this.authorizeAction(goal, subtask);
              if (!verdict.allowed) {
                report.actionGated = (report.actionGated ?? 0) + 1;
                this.noteDeniedAction(verdict.reasons);
                this.windowQueue.unshift(entry); // 保留排队（如冷却中），下轮再试
                break;
              }
            }
            const signalId = this.dispatchSubtask(subtask, goal);
            this.goalEngine.markDispatched(goal.id, subtask.id, signalId);
            report.subtasksDispatched += 1;
            report.windowDrained = (report.windowDrained ?? 0) + 1;
            this.activityWindowState.drained += 1;
            if (this.actionGateState) this.noteDispatchedAction(this.resolveRiskTier(goal, subtask));
          }
        }
        // 常规派发：被拒/排队动作进排除集，派发机会顺延给后续可选子任务
        // （单拍预算扣掉窗口恢复已占用的份额——未挂载窗口时与原口径逐位一致）
        const excluded: string[] = [];
        const dispatchBudget = this.config.maxDispatchPerTick - report.subtasksDispatched;
        for (let i = 0; i < dispatchBudget; i += 1) {
          const picked = this.goalEngine.pickNextSubtask(excluded.length > 0 ? excluded : undefined);
          if (!picked) break;
          // 安全治理：goal-dispatch 动作需经裁决
          if (this.governor) {
            const verdict = this.governor.govern('goal-dispatch', picked.goal.confidence);
            if (!verdict.allowed) {
              report.governanceBlocked += 1;
              break; // 被拦截时停止本轮派发，避免反复撞墙
            }
          }
          // 第四轮分级门：高风险动作需证书/确认/冷却/单拍上限
          if (this.actionGateState) {
            const verdict = this.authorizeAction(picked.goal, picked.subtask);
            if (!verdict.allowed) {
              report.actionGated = (report.actionGated ?? 0) + 1;
              this.noteDeniedAction(verdict.reasons);
              excluded.push(picked.subtask.id); // 让位：不撞墙，机会顺延后续可选者
              continue;
            }
          }
          // 第四轮时段治理：窗口外的重活排队（同子任务去重，队满丢最旧）
          if (this.activityWindowState && !this.inActivityWindow() && this.isHeavyAction(picked.goal, picked.subtask)) {
            if (!this.windowQueue.some((e) => e.subtaskId === picked.subtask.id)) {
              if (this.windowQueue.length >= this.activityWindowState.maxQueue) this.windowQueue.shift();
              this.windowQueue.push({ goalId: picked.goal.id, subtaskId: picked.subtask.id });
              this.activityWindowState.totalQueued += 1;
              report.windowQueued = (report.windowQueued ?? 0) + 1;
            }
            excluded.push(picked.subtask.id); // 本轮不再选它
            continue;
          }
          const signalId = this.dispatchSubtask(picked.subtask, picked.goal);
          this.goalEngine.markDispatched(picked.goal.id, picked.subtask.id, signalId);
          report.subtasksDispatched += 1;
          if (this.actionGateState) this.noteDispatchedAction(this.resolveRiskTier(picked.goal, picked.subtask));
        }
      } catch {
        /* 派发失败不阻断 */
      }

      // ── 6. 好奇心探索（预算内 + 治理器裁决） ──
      if (this.config.enableExploration && this.curiosity && this.dispatchExploration) {
        try {
          const remainingSlots = Math.max(0, this.config.maxDispatchPerTick - report.subtasksDispatched);
          const proposals = this.curiosity.proposeExplorations(remainingSlots + 1, report.healthScore);
          for (const proposal of proposals) {
            if (this.governor) {
              const verdict = this.governor.govern('exploration', 1);
              if (!verdict.allowed) {
                report.governanceBlocked += 1;
                break;
              }
            }
            this.dispatchExploration(proposal);
            report.explorationsDispatched += 1;
          }
        } catch {
          /* 探索失败不阻断 */
        }
      }
    }

    // ── 7. 策略进化（样本达标时触发，产物落地决策引擎） ──
    if (this.inPhase('consolidate')) {
      // 第四轮时段治理：consolidate 相位的重活（进化/策略进化桥/元认知环/
      // 记忆维护）仅在允许窗口内执行——窗口外顺延（周期触发自然补做）
      const consolidateAllowed = !this.activityWindowState || this.inActivityWindow();
      if (consolidateAllowed && this.config.enableStrategyEvolution) {
        try {
          const evolutionReport = this.evolution.evolve();
          if (evolutionReport) {
            report.evolved = true;
            this.strategyApplier?.(this.evolution.bestGenesAsConfig());
          }
        } catch {
          /* 进化失败不阻断 */
        }
      }

      // ── 7.5 策略进化器（第三阶段：调度策略经沙盒验证后热切换） ──
      // 沙盒离线评估不阻塞操作环；进化失败静默（下轮再试）
      if (consolidateAllowed && this.policyEvolution) {
        try {
          await this.policyEvolution.runEvolutionCycle();
        } catch {
          /* 策略进化失败不阻断 */
        }
      }

      // ── 7.7 元认知环（第四阶段：自我建模 → 保守调整 → 观察/回滚） ──
      // 低频触发（每 metaCognitionEveryTicks 轮）：观察并改进进化机制本身；
      // 心智报告生成与参数调整均为轻量同步操作，失败静默（下轮再试）
      if (consolidateAllowed && this.metaCognitionBridge && this.tickCount % this.config.metaCognitionEveryTicks === 0) {
        try {
          await this.metaCognitionBridge.runMetaCycle();
        } catch {
          /* 元认知环失败不阻断 */
        }
      }

      // ── 8. 记忆维护（低频后台） ──
      if (consolidateAllowed && this.tickCount % this.config.maintenanceEveryTicks === 0) {
        try {
          const distilled = this.maintainer.distillExperience();
          const forgetting = this.maintainer.applyForgettingCurve();
          report.maintenance = { distilled, decayed: forgetting.decayed, forgotten: forgetting.forgotten };
          // 第二阶段：知识蒸馏（语义+程序记忆），失败不阻断主维护流程
          if (this.maintainer.distillKnowledge) {
            try {
              const knowledge = await this.maintainer.distillKnowledge();
              report.maintenance.semanticDistilled = knowledge.semantic;
              report.maintenance.proceduralDistilled = knowledge.procedural;
            } catch {
              /* 知识蒸馏失败不阻断 */
            }
          }
        } catch {
          /* 维护失败不阻断 */
        }
      }
    }

    // rest 相位：不执行任何重活——心跳的显式休整拍（只出报告与遥测）

    // ── 第三轮：相位遥测 + 预算债记账（注入时钟口径） ──
    if (this.phaseState && phase) {
      const duration = Math.max(0, this.phaseState.clock() - phaseStart);
      const state = this.phaseState;
      state.counts[phase] += 1;
      state.durationsMs[phase] += duration;
      state.lastPhase = phase;
      state.lastDurationMs = duration;
      const budget = state.budgetsMs[phase];
      if (budget !== undefined && duration > budget) {
        state.overruns[phase] += 1;
        // 让位记账：超支相位欠下槽位债（每次让位还 1），上限 +2/拍防饿死螺旋
        state.debt[phase] = Math.min(state.ratios[phase] * 2, state.debt[phase] + Math.min(2, duration / budget));
      }
    }

    // ── 第三轮：节奏自适应（负载重估 + 定时器重排） ──
    if (this.adaptive) {
      this.updateAdaptiveInterval(report.insightsCollected);
    }

    this.reports.push(report);
    if (this.reports.length > 100) this.reports.shift();
    return report;
  }

  /** 心跳历史 */
  getReports(): TickReport[] {
    return [...this.reports];
  }

  /** 最近一轮摘要 */
  getLatestReport(): TickReport | undefined {
    return this.reports[this.reports.length - 1];
  }

  /**
   * 96.0：挂载全局工作空间意识总线（幂等覆盖，挂载即生效——旁路口径）。
   *
   * 心跳每拍 consciousnessStep()：各引擎模块（Sentinel/决策/反思/进化/
   * 共生）以 novelty×relevance×confidence×urgency 投标竞争，胜者内容
   * 广播全员（「此刻全员该知道什么」由竞争仲裁，不再由代码调用顺序
   * 决定；不应期防垄断）。与 99.0 互补：96 管单步焦点，99 管持续预算。
   * 旁路挂载，不改变心跳任何阶段（零漂移）。
   */
  attachGlobalWorkspace(
    bidders: ReadonlyArray<EngineBidderSpec>,
    options?: { threshold?: number; temperature?: number; refractory?: number },
  ): void {
    this.consciousnessBus = new ConsciousnessBus(bidders, options);
  }

  /** 96.0：意识总线（未挂载零介入） */
  private consciousnessBus?: ConsciousnessBus;

  // ── 第三轮升级：相位机 / 节奏自适应（未挂载零漂移） ──

  /** 相位机状态（attachPhaseMachine 挂载；未挂载 undefined → 每拍全流程） */
  private phaseState?: {
    baseSequence: HeartbeatPhase[];
    ratios: Record<HeartbeatPhase, number>;
    cursor: number;
    counts: Record<HeartbeatPhase, number>;
    durationsMs: Record<HeartbeatPhase, number>;
    overruns: Record<HeartbeatPhase, number>;
    yielded: Record<HeartbeatPhase, number>;
    debt: Record<HeartbeatPhase, number>;
    budgetsMs: Partial<Record<HeartbeatPhase, number>>;
    clock: () => number;
    current?: HeartbeatPhase;
    lastPhase?: HeartbeatPhase;
    lastDurationMs?: number;
  };

  /** 相位机洞察缓冲（observe 拍收集 → 最近一次 propose 拍消费） */
  private insightBuffer: Insight[] = [];

  /** 节奏自适应配置（attachAdaptiveHeartbeat 挂载；未挂载 undefined → 固定间隔） */
  private adaptive?: {
    minMs: number;
    maxMs: number;
    pendingRef: number;
    densityRef: number;
    pendingWeight: number;
    densityWeight: number;
    eventDensity?: () => number;
    intervalMs: number;
    load: number;
    pendingGoals: number;
    density: number;
  };

  /** 内部事件密度估计（洞察数 EWMA，α = 0.3——缺省密度轴） */
  private insightEwma = 0;

  /** 96.0：心跳一拍的意识总线步进（挂载时由心跳循环仲裁点调用；未挂载 undefined） */
  consciousnessStep(signal?: { signals?: string[]; goal?: string }): GwtStepResult | undefined {
    return this.consciousnessBus?.step(signal);
  }

  /** 96.0：意识总线读数（点火率 = 意识负荷 KPI；胜者分布熵监控垄断；未挂载 undefined） */
  consciousnessView(): ReturnType<ConsciousnessBus['view']> | undefined {
    return this.consciousnessBus?.view();
  }

  // ─────────────── 第三轮升级：心跳相位机 · 节奏自适应（缺省零漂移） ───────────────

  /**
   * 挂载心跳相位机（幂等覆盖，挂载即生效）。
   *
   * 心跳从「每拍全流程」升级为显式五相位轮转：
   *   observe（KPI/世界模型/各顾问/教训收集）→ propose（目标生成/分解/
   *   停滞处置）→ execute（子任务派发/好奇心探索）→ consolidate（进化/
   *   元认知环/记忆维护）→ rest（休整——只出报告与遥测）。
   *
   * - 配比可配：ratios 决定每周期各相位拍数（缺省 1:1:2:1:1，执行加倍），
   *   基序列按相位次序展开后确定性循环（同 ratios + 同注入时钟 → 相位
   *   推进序列逐拍可复现）。
   * - 相位遥测：phaseView() 给出各相位拍数/耗时/超支/让位/债。
   * - 注入时钟：clock 用于相位时长计量（预算记账口径）。
   * - 相位预算：budgetsMs 超支相位记债让位（后续轮转跳过自己的槽位还债，
   *   槽位顺延下一相位——超支者不再挤占心跳）。
   * - 洞察缓冲：observe 拍收集的洞察缓冲到最近一次 propose 拍消费
   *   （相位切分不丢洞察）。
   *
   * 未挂载 → 每拍全流程（行为与原版逐位一致，零漂移）。
   */
  attachPhaseMachine(options?: PhaseMachineOptions): void {
    const PHASES: HeartbeatPhase[] = ['observe', 'propose', 'execute', 'consolidate', 'rest'];
    const ratios = { observe: 1, propose: 1, execute: 2, consolidate: 1, rest: 1, ...options?.ratios } as Record<HeartbeatPhase, number>;
    for (const phase of PHASES) {
      const raw = ratios[phase] ?? 0;
      if (!Number.isFinite(raw) || raw < 0) ratios[phase] = 0;
      else ratios[phase] = Math.floor(raw);
    }
    if (PHASES.every((p) => ratios[p] === 0)) ratios.observe = 1; // 全零 → 兜底观察相位（永不分母为零）
    const baseSequence: HeartbeatPhase[] = [];
    for (const phase of PHASES) {
      for (let i = 0; i < ratios[phase]; i += 1) baseSequence.push(phase);
    }
    const zero = (): Record<HeartbeatPhase, number> => ({ observe: 0, propose: 0, execute: 0, consolidate: 0, rest: 0 });
    this.phaseState = {
      baseSequence,
      ratios,
      cursor: 0,
      counts: zero(),
      durationsMs: zero(),
      overruns: zero(),
      yielded: zero(),
      debt: zero(),
      budgetsMs: options?.budgetsMs ?? {},
      clock: options?.clock ?? (() => Date.now()),
    };
  }

  /** 相位遥测（未挂载 undefined） */
  phaseView(): PhaseTelemetry | undefined {
    if (!this.phaseState) return undefined;
    const state = this.phaseState;
    return {
      baseSequence: [...state.baseSequence],
      ratios: { ...state.ratios },
      cursor: state.cursor,
      cycleIndex: Math.floor(state.cursor / state.baseSequence.length),
      counts: { ...state.counts },
      durationsMs: { ...state.durationsMs },
      overruns: { ...state.overruns },
      yielded: { ...state.yielded },
      debt: { ...state.debt },
      lastPhase: state.lastPhase,
      lastDurationMs: state.lastDurationMs,
    };
  }

  /**
   * 挂载心跳节奏自适应（幂等覆盖，挂载即生效）。
   *
   * 心跳间隔从固定值升级为负载自适应：间隔按（待处理目标数 × 事件密度）
   * 加权负载在 [minMs, maxMs] 间几何插值——负载 0.5 为基线中性点
   * （= heartbeatMs），忙（load → 1）压向下限、闲（load → 0）顶向上限，
   * 双侧硬钳位（再忙不压垮、再闲不睡死）。每拍重估，运行中热重排定时器。
   *
   * 事件密度缺省用内部洞察数 EWMA（α = 0.3），可用 eventDensity 提供
   * 外部口径（如哨兵信号到达率）。未挂载 → 固定 heartbeatMs（零漂移）。
   */
  attachAdaptiveHeartbeat(options?: AdaptiveHeartbeatOptions): void {
    const base = this.config.heartbeatMs;
    const minMs = Math.max(1000, Math.min(options?.minMs ?? Math.floor(base / 4), base));
    const maxMs = Math.max(base, options?.maxMs ?? base * 4);
    const pendingWeight = Math.max(0, Math.min(1, options?.pendingWeight ?? 0.5));
    const densityWeight = Math.max(0, Math.min(1, options?.densityWeight ?? 0.5));
    this.adaptive = {
      minMs,
      maxMs,
      pendingRef: Math.max(1, options?.pendingRef ?? 8),
      densityRef: Math.max(1e-9, options?.densityRef ?? 20),
      pendingWeight,
      densityWeight,
      eventDensity: options?.eventDensity,
      intervalMs: base,
      load: 0.5,
      pendingGoals: 0,
      density: 0,
    };
  }

  /** 节奏自适应遥测（未挂载 undefined） */
  adaptiveHeartbeatView(): AdaptiveHeartbeatTelemetry | undefined {
    if (!this.adaptive) return undefined;
    return {
      load: Number(this.adaptive.load.toFixed(3)),
      pendingGoals: this.adaptive.pendingGoals,
      eventDensity: Number(this.adaptive.density.toFixed(3)),
      intervalMs: Math.round(this.adaptive.intervalMs),
      clampedLow: this.adaptive.intervalMs <= this.adaptive.minMs,
      clampedHigh: this.adaptive.intervalMs >= this.adaptive.maxMs,
    };
  }

  /** 当前生效心跳间隔（未自适应 = 配置值 heartbeatMs） */
  currentHeartbeatMs(): number {
    return this.adaptive ? Math.round(this.adaptive.intervalMs) : this.config.heartbeatMs;
  }

  // ─────────────── 第四轮升级：动作安全分级门 · 行为时段治理（缺省零漂移） ───────────────

  /**
   * 挂载自主动作安全分级门（幂等覆盖，挂载即生效——execute 相位派发裁决）。
   *
   * 自主动作按白名单三级治理：
   * - observe（只读观察）：恒放行
   * - act（低风险写）：常规放行（可配 actCooldownMs 冷却）
   * - mutate（高风险变更）：需证书（credential——缺省 () => false，未配置
   *   证书提供器时高风险一律拒绝，fail-closed）+ 可选人工确认
   *   （confirmation）+ 冷却（mutateCooldownMs，缺省 60 秒）+ 单拍上限
   *   （maxMutatePerTick，缺省 1）
   *
   * 风险级解析：子任务显式声明 riskTier > tiers[taskType] 映射 >
   * defaultTier（缺省 'act'）。被拒动作不计失败——派发机会经排除集
   * 顺延给后续可选子任务（pickNextSubtask(exclude)），拒绝情况计入
   * report.actionGated 与 actionGateView 遥测。
   * 未挂载 → 派发路径逐位不变（零漂移）。
   */
  attachActionGate(options?: ActionGateOptions): void {
    this.actionGateState = {
      tiers: options?.tiers ?? {},
      defaultTier: options?.defaultTier ?? 'act',
      credential: options?.credential ?? (() => false),
      confirmation: options?.confirmation,
      actCooldownMs: Math.max(0, options?.actCooldownMs ?? 0),
      mutateCooldownMs: Math.max(0, options?.mutateCooldownMs ?? 60_000),
      maxMutatePerTick: Math.max(1, Math.floor(options?.maxMutatePerTick ?? 1)),
      clock: options?.clock ?? (() => Date.now()),
      mutateThisTick: 0,
      allowedCount: 0,
      deniedCount: 0,
      mutateDispatched: 0,
      byReason: {},
    };
  }

  /**
   * 分级门裁决（纯查询无副作用；心跳 execute 相位与宿主直询共用口径）。
   * @param goal 目标（confirmation 回调入参）
   * @param subtask 子任务（riskTier 声明 / taskType 映射的解析源）
   * @param now 裁决时刻（缺省门时钟——冷却计量确定性测试轴）
   */
  authorizeAction(goal: Goal, subtask: GoalSubtask, now?: number): ActionGateVerdict {
    const tier = this.resolveRiskTier(goal, subtask);
    const gate = this.actionGateState;
    if (!gate) return { tier, allowed: true, reasons: [] };
    const t = now ?? gate.clock();
    const reasons: string[] = [];

    if (tier === 'observe') {
      return { tier, allowed: true, reasons };
    }
    if (tier === 'act') {
      if (gate.actCooldownMs > 0 && gate.lastActAt !== undefined && t - gate.lastActAt < gate.actCooldownMs) {
        reasons.push('act-cooldown');
      }
      return { tier, allowed: reasons.length === 0, reasons };
    }
    // mutate：高风险变更——证书 / 确认 / 冷却 / 单拍上限四重门
    if (!gate.credential()) reasons.push('mutate-no-credential');
    if (gate.confirmation && !gate.confirmation(goal, subtask)) reasons.push('mutate-unconfirmed');
    if (gate.mutateCooldownMs > 0 && gate.lastMutateAt !== undefined && t - gate.lastMutateAt < gate.mutateCooldownMs) {
      reasons.push('mutate-cooldown');
    }
    if (gate.mutateThisTick >= gate.maxMutatePerTick) reasons.push('mutate-cap-per-tick');
    return { tier, allowed: reasons.length === 0, reasons };
  }

  /** 分级门遥测（未挂载 undefined） */
  actionGateView(): ActionGateTelemetry | undefined {
    const gate = this.actionGateState;
    if (!gate) return undefined;
    return {
      defaultTier: gate.defaultTier,
      actCooldownMs: gate.actCooldownMs,
      mutateCooldownMs: gate.mutateCooldownMs,
      maxMutatePerTick: gate.maxMutatePerTick,
      allowed: gate.allowedCount,
      denied: gate.deniedCount,
      mutateDispatched: gate.mutateDispatched,
      mutateThisTick: gate.mutateThisTick,
      lastMutateAt: gate.lastMutateAt,
      byReason: { ...gate.byReason },
    };
  }

  /**
   * 挂载自主行为时段治理（幂等覆盖，挂载即生效——execute/consolidate 相位）。
   *
   * 重活（heavyTiers 风险级 ∪ heavyTaskTypes 任务类型）的派发仅在允许
   * 窗口内进行（如仅低峰期 2:00–5:00 做重活；支持跨午夜窗口 22→6，
   * startHour === endHour 退化为全天允许）：
   * - execute 相位：窗口外的重活入队（同子任务去重，队满丢最旧），
   *   派发机会顺延给窗口外的轻活；窗口内优先恢复队列
   * - consolidate 相位：进化 / 策略进化桥 / 元认知环 / 记忆维护等重活
   *   窗口外顺延（周期触发自然补做，不丢拍面）
   * 未挂载 → 派发路径逐位不变（零漂移）。
   */
  attachActivityWindow(options: ActivityWindowOptions): void {
    const clampHour = (h: number) => (Number.isFinite(h) ? Math.max(0, Math.min(24, h)) : 0);
    this.activityWindowState = {
      startHour: clampHour(options.window.startHour),
      endHour: clampHour(options.window.endHour),
      heavyTiers: new Set(options.heavyTiers ?? ['mutate']),
      heavyTaskTypes: new Set(options.heavyTaskTypes ?? []),
      clock: options.clock ?? (() => new Date()),
      maxQueue: Math.max(1, Math.floor(options.maxQueue ?? 64)),
      totalQueued: 0,
      drained: 0,
    };
  }

  /** 时段窗口治理遥测（未挂载 undefined） */
  activityWindowView(): ActivityWindowTelemetry | undefined {
    const w = this.activityWindowState;
    if (!w) return undefined;
    const date = w.clock();
    const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
    return {
      window: { startHour: w.startHour, endHour: w.endHour },
      heavyTiers: [...w.heavyTiers],
      heavyTaskTypes: [...w.heavyTaskTypes],
      insideWindow: this.inActivityWindow(),
      currentHour: Number(hour.toFixed(4)),
      queued: this.windowQueue.length,
      totalQueued: w.totalQueued,
      drained: w.drained,
    };
  }

  /** 风险级解析：子任务声明 riskTier > 分级门 tiers 映射 > defaultTier（缺省 'act'） */
  private resolveRiskTier(goal: Goal, subtask: GoalSubtask): ActionRiskTier {
    return subtask.riskTier ?? this.actionGateState?.tiers[subtask.taskType] ?? this.actionGateState?.defaultTier ?? 'act';
  }

  /** 派发记账：冷却起点 / 单拍上限占用 / 遥测计数（实际派发成功后调用） */
  private noteDispatchedAction(tier: ActionRiskTier): void {
    const gate = this.actionGateState;
    if (!gate) return;
    const t = gate.clock();
    if (tier === 'act') gate.lastActAt = t;
    if (tier === 'mutate') {
      gate.lastMutateAt = t;
      gate.mutateThisTick += 1;
      gate.mutateDispatched += 1;
    }
    gate.allowedCount += 1;
  }

  /** 拒绝记账（遥测口径） */
  private noteDeniedAction(reasons: string[]): void {
    const gate = this.actionGateState;
    if (!gate) return;
    gate.deniedCount += 1;
    for (const reason of reasons) gate.byReason[reason] = (gate.byReason[reason] ?? 0) + 1;
  }

  /** 时段判定：注入时钟 → 小时口径 ∈ [startHour, endHour)（跨午夜取并集；退化窗口全天允许） */
  private inActivityWindow(): boolean {
    const w = this.activityWindowState!;
    const date = w.clock();
    const h = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
    if (w.startHour === w.endHour) return true;
    if (w.startHour < w.endHour) return h >= w.startHour && h < w.endHour;
    return h >= w.startHour || h < w.endHour;
  }

  /** 重活判定：风险级 ∈ heavyTiers 或任务类型 ∈ heavyTaskTypes */
  private isHeavyAction(goal: Goal, subtask: GoalSubtask): boolean {
    const w = this.activityWindowState!;
    const tier = this.resolveRiskTier(goal, subtask);
    return w.heavyTiers.has(tier) || w.heavyTaskTypes.has(subtask.taskType);
  }

  /** 相位取用：基序列确定性轮转 + 预算债让位（欠债相位跳过本槽，槽位顺延下一相位） */
  private takePhase(): HeartbeatPhase {
    const state = this.phaseState!;
    for (;;) {
      const phase = state.baseSequence[state.cursor % state.baseSequence.length]!;
      if (state.debt[phase] >= 1) {
        state.debt[phase] -= 1;
        state.yielded[phase] += 1;
        state.cursor += 1;
        continue; // 让位：本槽跳过，落到序列下一相位
      }
      state.cursor += 1;
      return phase;
    }
  }

  /** 相位门：未挂载相位机恒真（全流程——零漂移）；挂载后仅本相位为真 */
  private inPhase(phase: HeartbeatPhase): boolean {
    return !this.phaseState || this.phaseState.current === phase;
  }

  /** 节奏自适应重估（负载 → 间隔几何插值 → 定时器热重排） */
  private updateAdaptiveInterval(insightsThisTick: number): void {
    const adaptive = this.adaptive!;
    const pendingGoals = (() => {
      try {
        return this.goalEngine.pendingSubtaskCount();
      } catch {
        return 0;
      }
    })();
    // 事件密度：外部提供器优先，缺省内部洞察 EWMA（α = 0.3）
    const density = adaptive.eventDensity
      ? (() => {
          try {
            return adaptive.eventDensity!();
          } catch {
            return this.insightEwma;
          }
        })()
      : (this.insightEwma = 0.7 * this.insightEwma + 0.3 * insightsThisTick);

    const weightSum = adaptive.pendingWeight + adaptive.densityWeight;
    const rawLoad =
      weightSum > 0
        ? (adaptive.pendingWeight * Math.min(1, pendingGoals / adaptive.pendingRef) +
            adaptive.densityWeight * Math.min(1, density / adaptive.densityRef)) /
          weightSum
        : 0.5;
    const load = Math.max(0, Math.min(1, rawLoad));
    const base = this.config.heartbeatMs;
    // 双向几何插值：load=0.5 → base；load=1 → minMs；load=0 → maxMs（单调递减，钳位内建）
    const intervalMs =
      load >= 0.5
        ? base * Math.pow(adaptive.minMs / base, (load - 0.5) * 2)
        : base * Math.pow(adaptive.maxMs / base, (0.5 - load) * 2);

    const previous = adaptive.intervalMs;
    adaptive.load = load;
    adaptive.pendingGoals = pendingGoals;
    adaptive.density = density;
    adaptive.intervalMs = Math.max(adaptive.minMs, Math.min(adaptive.maxMs, intervalMs));

    // 运行中热重排：间隔变化即重建定时器（下一拍生效）
    if (this.running && this.timer !== null && Math.round(previous) !== Math.round(adaptive.intervalMs)) {
      clearInterval(this.timer);
      this.timer = setInterval(() => {
        void this.tick().catch(() => {
          /* 单轮心跳异常隔离 */
        });
      }, this.currentHeartbeatMs());
      this.timer.unref?.();
    }
  }

  /**
   * 自省报告（自主智能的全景自我认知）
   * 汇总心跳状态、健康度、目标进度、探索收获、治理状态、世界模型预测
   */
  introspect(): any {
    return {
      loop: this.getStatus(),
      health: this.metaCognition.getHealthReport(),
      goals: this.goalEngine.getSummary(),
      exploration: this.curiosity?.getSummary() ?? null,
      governance: this.governor?.getStatus() ?? null,
      worldModel: this.worldModel?.getSummary() ?? null,
      evolution: this.evolution.getReport(),
    };
  }

  /** 运行状态 */
  getStatus(): any {
    return {
      running: this.running,
      heartbeatMs: this.config.heartbeatMs,
      /** 第三轮：当前生效心跳间隔（未自适应 = heartbeatMs；自适应 = 负载估值） */
      effectiveHeartbeatMs: this.currentHeartbeatMs(),
      tickCount: this.tickCount,
      /** 第三轮：最近一拍相位（未挂载相位机 undefined） */
      phase: this.phaseState?.lastPhase,
      latest: this.getLatestReport(),
    };
  }
}
