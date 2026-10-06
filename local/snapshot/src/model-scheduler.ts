/**
 * model-scheduler.ts — 模型调度组件（新架构「优化器 → 模型调度」）
 *
 * 职责（对应架构图「模型调度（原有）」框）：
 * - assignModel：为任务类型选择最优模型（能力画像 × 记忆画像成功率加权 × 成本感知）；
 *   优化器（optimizer.ts）产出的推荐模型作为 preferred 优先采纳
 * - pickFallbackModel：质量反思触发模型切换时选择次优模型
 * - computeParallelism：依据已注册模型总并发容量计算同层最大并行数
 *
 * 第三阶段升级（策略进化）：
 * - 评分函数参数化：固定权重（costWeight / memoryWeight 系列）改为从当前策略
 *   （Policy.params）注入，评分核心与沙盒共享 scoreModelWithPolicy（沙盒保真）
 * - 热切换：updatePolicy(policy) 运行时替换当前策略，无需重启系统
 * - 多模型组合：pickEnsemble 按当前策略评分返回集成候选（供执行侧编排）
 *
 * 质级升级（规则基因组）：
 * - assignModel / pickEnsemble / pickFallbackModel 增加可选任务上下文
 *   （复杂度/特征标签）；调用 resolveEffectiveParams 解析规则基因的
 *   条件覆盖（如「高复杂度任务强制集成」「特定类型降本」），调度决策
 *   从全局单一权重升级为上下文敏感的可进化规则程序
 * - 无规则或无匹配时行为与纯标量策略逐位一致（向后兼容）
 *
 * 第三轮模块域 A3 升级（世界性）：
 * - A3-1 健康感知路由：每模型 EWMA 延迟/错误率遥测 + 熔断器三态
 *       （closed/open/half-open），open 经指数退避冷却转 half-open 半开
 *       探针（单探针槽 + 探针超时），探活成功闭合、失败退避翻倍重开；
 *       熔断模型从候选剔除、EWMA 错误率折价健康乘数进利用端评分（半开
 *       态旁路——探针公平起跑防探活饿死）；推荐短路同样尊重熔断硬闸。
 *       时钟/阈值全可注入——故障序列在虚拟时钟上逐位复现（开 → 切 →
 *       探活 → 复位 → 加倍全链可证）。
 * - A3-2 两次选择幂（P2C）负载均衡：可选模式——质量门（score ≥ 门限×
 *       最高分）内的候选中随机抽两候、取负载轻者；负载读数与随机源
 *       可注入（缺省 activeRequests/maxConcurrency 运行时读数）。
 *       异构负载下最大负载期望 ≪ 纯随机（power of two choices）。
 * - A3-3 成本画像选择：任务类别绑定画像（quality/cost/balanced，
 *       '*' 兜底）；挂载 67.0 Pareto 前沿时按画像在前沿上选点
 *       （min 风险 / min 成本 / 距理想点最近），未挂载则退化既有
 *       评分路径（quality→costWeight=0 / cost→1 / balanced→原参数
 *       逐位不动）——零漂移。
 * - A3-4 每模型重试预算：滑动时间窗内每模型重试配额（admitRetry
 *       原子校验+记账），超限拒纳并计降级次数、动态选型剔除超限模型
 *       （全池超限为软闸门放行，不因预算阻断一切）。
 * - A3-5 调度审计：每次分配决策（候选集/健康快照/画像/决定因子/结论）
 *       结构化记入有界环形日志，getSchedulingAudit 导出——纯旁路记录，
 *       对决策零影响。
 *
 * 以上全部为显式挂载/绑定才生效的可选面；缺省时读数 undefined、
 * 评分与选型路径与升级前逐位一致（零漂移）。
 *
 * 第四轮模块域 R4-A3 升级（激活与深化——调度器从「选一个模型」到
 * 「运营一个模型舰队」的全生命周期）：
 * - R4-1 集成组合优化：单模型推荐升级为可选组合推荐——候选组合
 *       （k 个成员独立投票、过半正确即组合正确）在预算内枚举/贪心
 *       选优（Poisson 二项 DP 精确算多数票正确率；Condorcet 陪审团
 *       定理口径：三个 0.6 的独立投票者组合正确率 0.648 > 任一单体）。
 *       组合成本 = Σ 成员成本，预算硬约束下组合规模自动收缩。
 * - R4-2 预测性预热：任务需求流按时间桶记账 → 请求率 EWMA + 最小
 *       二乘趋势斜率 → 视野终点外推；预测负载越过阈值的任务提前给出
 *       预热建议（哪些模型可能被需要、预计何时到峰）——建议先于峰值
 *       到达（rising load 下 suggestion.etaMs < 桶宽即「还有时间」）。
 * - R4-3 冷启动准入协议：新模型接入三阶段试用（影子流量 → 金丝雀
 *       小流量 → 全量毕业），每阶段质量门槛（影子门 / 金丝雀门 /
 *       弹劾线），不达标退场（ejected 永久出局）；金丝雀按确定性
 *       1-in-period 时隙放行（可种子化复现的小流量）。未登记模型
 *       不受协议约束（零漂移）；全池被闸时软放行（永不抛新错）。
 * - R4-4 成本漂移告警：模型单价/时延遥测对冻结基线带做 EWMA 对照，
 *       显著漂移（相对偏离 ≥ 阈值）触发重画像建议（acknowledgeDrift
 *       落地 = 以当前值重立基线）——涨价/劣化不再静默入账。
 * - R4-5 模型特长画像：按「模型 × 任务类型」的历史质量矩阵自动发现
 *       「哪个模型擅长哪类任务」（EMA 均值 → 有界特长乘数），推荐
 *       评分加权——通才评分之下埋着专才结构，命中率达特长者 > 基线。
 *
 * R4 全部为显式挂载才生效的可选面；缺省时新读数 undefined、评分与
 * 选型路径与第三轮逐位一致（零漂移）。
 *
 * 兼容性：未部署进化策略时 currentPolicy = 基准策略（参数复刻原固定值），
 * 行为与第二阶段逐位一致。
 *
 * 边界：只读 LLM 客户端运行时状态与记忆库模型画像，不执行任务、不写记忆。
 */

import type { LLMClient } from './llm-client.js';
import type { BayesianEstimate, LongTermMemory } from './memory/long-term-memory.js';
import { ExecutionError } from './types.js';
import {
  BASELINE_POLICY_PARAMS,
  resolveEffectiveParams,
  scoreModelWithPolicy,
  type Policy,
  type SchedulerPolicyParams,
} from './policy/policy-types.js';
import type { EFEAction, EFEEvaluation, FreeEnergyEngine } from './core/free-energy.js';
import type { ArmIndex, GittinsSnapshot, IndexArm, IndexScheduler } from './core/index-scheduling.js';
import type { BwKRouter, BwKVerdict } from './core/bandit-knapsack.js';
import { Hedge, hedgeMultiplier, type HedgeStats } from './core/online-learning.js';
import { FeedbackController, type FeedbackControllerConfig, type ControlStep } from './core/feedback-control.js';
import { capacityFrontier, type CapacityFrontier } from './core/max-flow.js';
import { completeMatrix, completedEntry, type CompletionReport } from './core/matrix-completion.js';
// 创世纪 51.0/53.0/67.0：投机解码配对 / Whittle 指数调度 / NSGA-II 帕累托视图
import {
  SpeculativePairingAdvisor,
  whittleSchedule,
  type SpeculativeCandidate,
  type WhittleAdapterOptions,
} from './engines-frontier/genesis25.js';
import { paretoFront, crowdingDistance, hypervolume2D } from './core/nsga2-pareto.js';
import type { SpeculativeEconomyVerdict } from './core/speculative-decoding.js';

/** 模型调度配置 */
export interface ModelSchedulerConfig {
  /** 成本感知权重 0~1：模型选择时对单位成本的惩罚系数（0=纯质量导向） */
  costWeight?: number;
  /** 2.0：探索/利用权衡——UCB 探索开关（缺省开启；关闭后纯利用端评分） */
  explorationEnabled?: boolean;
  /** 2.0：探索加成系数（缺省 0.08；乘以 sqrt(log(1+Σn)/(1+n)) 不确定性项） */
  exploreBonus?: number;
  /** 2.0：探索生效的有效样本下限（缺省 5；样本充足的模型不再获得加成） */
  exploreSampleFloor?: number;
  /**
   * 2.0：冷启动探索预算——全部模型有效样本总和 ≥ 该值后探索关闭（缺省 30）
   *
   * 探索的使命是解决冷启动，不是永远与利用竞争：证据充足后纯利用端评分，
   * 避免大样本场景下 log(ΣN) 项给零样本模型过大加成、干扰稳健决策。
   */
  exploreBudget?: number;
  /**
   * 第五阶段 B 路线：能量反哺调度（缺省 false，零行为漂移）。
   * 启用后 updateEconomicSignals 注入的共生经济乘数作用于利用端评分：
   * 赚钱且信誉好的模型升权、持续亏损的模型降权——能量经济的生存压力
   * 直接反馈到调度行为。UCB 探索加成不受乘数影响（信息价值高于
   * 短期经济；冷启动重估机会不被经济惩罚剥夺）。
   */
  economicFeedbackEnabled?: boolean;
  /**
   * 6.0：主动推断调度（缺省 false，零行为漂移）。
   *
   * 启用后候选评分改用期望自由能 G(a) = 务实价值 − 认知价值：
   * - 务实价值 = 模型后验预测对成功偏好的期望惊奇（利用端，替代线性策略评分）
   * - 认知价值 = 该选择预期收缩多少不确定性（探索端，替代 UCB 加成——
   *   不确定性耗尽认知价值自动归零，探索预算不再需要手设常数）
   * 一个变分目标统一探索/利用，且逐选择输出「多少因为有用/多少
   * 因为想弄清」的可解释分解。未启用时评分路径逐位保持原逻辑。
   */
  freeEnergyEnabled?: boolean;
  /** 6.0：EFE 偏好强度（对成功的目标概率，缺省 0.9） */
  freeEnergyPreference?: number;
}

/** 调度决策洞察（2.0：预测置信度 + 探索标记，供反思器校准与反事实分析消费） */
export interface SchedulingInsight {
  taskType: string;
  modelId: string;
  /** 所选模型的贝叶斯后验均值（调度器对成功率的预测；无画像时为中性 0.5） */
  confidence: number;
  /** 本次选择是否由探索加成胜出（冷启动模型重估机会） */
  exploration: boolean;
  /** 所选模型有效样本量（0 = 无历史证据的纯探索） */
  effectiveSamples: number;
  /** 决策依据说明 */
  rationale: string;
  /** B 路线：所选模型的共生经济乘数（能量反哺调度；未启用/无信号时为 1） */
  economicMultiplier?: number;
}

/** 任务调度上下文（规则基因组的匹配输入；可选，兼容旧调用方） */
export interface SchedulerTaskContext {
  complexity?: number;
  features?: string[];
}

// ─────────────────── 第三轮 A3 升级：调度器运营面类型 ───────────────────

/** A3-1：熔断器三态（闭合供电 / 熔断拒绝 / 半开探活） */
export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

/** A3-1：健康感知路由配置（全部缺省时给出保守熔断参数） */
export interface HealthRoutingOptions {
  /** EWMA 平滑系数 α（0~1，缺省 0.3；新观测权重） */
  ewmaAlpha?: number;
  /** 连续失败跳闸阈值（缺省 3） */
  failureThreshold?: number;
  /** EWMA 错误率跳闸阈值 0~1（缺省 0.6） */
  errorThreshold?: number;
  /** EWMA 跳闸所需最小观测数（缺省 5——早期证据不熔断） */
  minObservations?: number;
  /** EWMA 延迟跳闸线（毫秒；不配置则纯延迟证据不熔断） */
  latencyTripMs?: number;
  /** open → half-open 基础冷却时长（毫秒，缺省 5_000） */
  halfOpenAfterMs?: number;
  /** 探针失败后的退避倍率（缺省 2——指数退避） */
  backoffMultiplier?: number;
  /** 退避上限（毫秒，缺省 120_000） */
  maxBackoffMs?: number;
  /** 半开探针在途超时（毫秒，缺省 30_000——超时释放探针槽可再探） */
  probeTimeoutMs?: number;
  /** EWMA 错误率的健康乘数惩罚权重 0~1（缺省 0.5；乘数 = 1 − w×错误率） */
  errorPenaltyWeight?: number;
  /** 时钟注入（缺省 Date.now；验证脚本注入虚拟时钟逐位复现） */
  clock?: () => number;
}

/** A3-1：单模型健康快照（healthView 输出项） */
export interface ModelHealthEntry {
  modelId: string;
  /** 累计健康观测数（成功/失败/延迟回报各计一次） */
  observations: number;
  /** EWMA 延迟（毫秒；从未回报延迟时为 0） */
  ewmaLatencyMs: number;
  /** EWMA 错误率 0~1 */
  ewmaErrorRate: number;
  breaker: CircuitBreakerState;
  consecutiveFailures: number;
  /** 熔断起始时刻（毫秒；closed 时 undefined） */
  openedAt?: number;
  /** 当前冷却退避（毫秒；探针失败后指数增长，复位回基准） */
  backoffMs: number;
  /** 半开探针是否在途（单探针槽——探活结果未回时不派新活） */
  probeInFlight: boolean;
  /** 健康乘数（利用端评分折价；未挂载恒 1） */
  healthMultiplier: number;
}

/** A3-2：P2C 负载均衡配置 */
export interface P2COptions {
  /** 负载读数注入（0~∞；缺省读模型运行时 activeRequests/maxConcurrency） */
  loadOf?: (modelId: string) => number;
  /** 随机源注入（缺省 Math.random；验证注入种子化 RNG 复现） */
  random?: () => number;
  /** 质量门：仅 total ≥ 门限 × 最高分的候选进入抽样池（0~1，缺省 0.8） */
  scoreGate?: number;
}

/** A3-2：最近一次 P2C 决策（可观测读数） */
export interface P2CDecision {
  aId: string;
  bId: string;
  loadA: number;
  loadB: number;
  chosenId: string;
}

/** A3-3：成本画像（任务类别可绑定的调度取向） */
export type CostProfile = 'quality' | 'cost' | 'balanced';

/** A3-4：每模型重试预算配置 */
export interface RetryBudgetOptions {
  /** 滑动时间窗（毫秒，缺省 60_000） */
  windowMs?: number;
  /** 每模型每窗重试配额（缺省 3） */
  maxRetriesPerModel?: number;
  /** 时钟注入（缺省 Date.now） */
  clock?: () => number;
}

/** A3-4：重试准入裁决（admitRetry 返回；未挂载恒放行且配额无穷） */
export interface RetryAdmission {
  allowed: boolean;
  /** 窗口内已用重试数（含本次若准许） */
  used: number;
  quota: number;
}

/** A3-4：单模型重试预算读数（retryBudgetView 输出项） */
export interface RetryBudgetEntry {
  modelId: string;
  used: number;
  quota: number;
  windowMs: number;
  /** 窗口内配额耗尽被拒纳（降级换模型）的累计次数 */
  degraded: number;
}

/** A3-5：调度审计条目（有界环形，getSchedulingAudit 导出） */
export interface SchedulingAuditEntry {
  seq: number;
  at: number;
  taskType: string;
  preferred?: string;
  /** 本次决策的实际候选集（运营闸门过滤后） */
  candidateIds: string[];
  /** 决策路径：推荐短路 / 挂载内核 / 画像前沿 / 评分 / P2C */
  path: 'preferred' | 'gittins' | 'whittle' | 'bwk' | 'profile-pareto' | 'scored' | 'p2c';
  /** 本次决策适用的成本画像（未绑定时缺席） */
  profile?: CostProfile;
  /** 候选健康快照（modelId → 熔断态；未挂载健康路由时缺席） */
  health?: Record<string, CircuitBreakerState>;
  /** 候选重试预算用量（modelId → 窗口内已用；未挂载时缺席） */
  retryUsed?: Record<string, number>;
  /** 全池熔断时被强制转半开探活的模型（降级标记） */
  forcedProbe?: string;
  /** 全池重试超限放行标记（软闸门降级） */
  relaxedRetry?: boolean;
  chosenId: string;
  rationale: string;
}

// ─────────────────── 第四轮 R4-A3 升级：调度器运营面类型 ───────────────────

/** R4-1：集成组合优化配置（挂载即生效；未挂载 composeEnsemble 诚实 undefined） */
export interface EnsembleComposerOptions {
  /** 组合规模上限（缺省 3；>1 才有「组合」语义，钳位 [1,8]） */
  maxModels?: number;
  /** 每次组合调用的成本预算（口径与 costPerCallOf 一致；不配置则无预算硬约束） */
  budgetPerCall?: number;
  /** 成本口径注入（缺省：模型运行时平均 token 消耗，无历史 600 兜底） */
  costPerCallOf?: (modelId: string) => number;
  /** 质量口径注入（缺省：贝叶斯后验均值，无画像 0.5 中性） */
  qualityOf?: (modelId: string, taskType: string) => number;
  /** 全组合枚举上限（组合数超过则转贪心增量；缺省 512） */
  enumerationLimit?: number;
}

/** R4-1：组合推荐结果（composeEnsemble 输出；成本=Σ成员、质量=多数票正确率） */
export interface EnsembleComposition {
  memberIds: string[];
  /** 组合多数票正确概率（独立投票假设下的 Poisson 二项精确值；偶数票并列按 0.5 权） */
  ensembleQuality: number;
  /** 池内最优单体质量（「组合 vs 单体」对照基线） */
  bestSingleQuality: number;
  bestSingleId: string;
  /** 组合总成本（Σ 成员每调用成本） */
  totalCost: number;
  /** 预算内最优 = true（预算收缩迫使降规模时仍保证不超支） */
  withinBudget: boolean;
  /** 实际评估的组合数（贪心口径 = 评估的增量步数） */
  searched: number;
  /** 求解口径：全枚举（最优）或贪心（规模收缩的诚实降级） */
  mode: 'enumerate' | 'greedy';
  rationale: string;
}

/** R4-2：预测性预热配置 */
export interface PrewarmOptions {
  /** 负载记账时间桶宽（毫秒，缺省 1_000） */
  bucketMs?: number;
  /** 请求率 EWMA 平滑系数（缺省 0.4） */
  ewmaAlpha?: number;
  /** 趋势回归回看桶数（缺省 8，钳位 [2,64]） */
  trendWindow?: number;
  /** 外推视野（毫秒，缺省 10_000） */
  horizonMs?: number;
  /** 触发预热建议的预测请求率阈值（缺省 2——预测将到达 ≥2 请求/桶即预热） */
  prewarmThreshold?: number;
  /** 建议预热的模型数（缺省 3） */
  suggestModels?: number;
  /** 时钟注入（缺省 Date.now；虚拟时钟上复现负载流） */
  clock?: () => number;
}

/** R4-2：预热建议（prewarmSuggestions 输出项；建议先于峰值到达） */
export interface PrewarmSuggestion {
  taskType: string;
  /** 当前 EWMA 请求率（请求/桶） */
  currentRate: number;
  /** 趋势斜率（请求率/桶；最小二乘） */
  trendPerBucket: number;
  /** 视野终点预测请求率 = EWMA + 斜率 × 视野桶数 */
  projectedRate: number;
  /** 建议预热的模型（该任务评分 top-N，已过运营闸门） */
  modelIds: string[];
  /** 预计穿越阈值的时刻（毫秒时间戳；已在阈值上则为当前时刻） */
  etaAt: number;
  /** 相对当前时刻的剩余窗口（毫秒；越大越从容） */
  etaInMs: number;
  rationale: string;
}

/** R4-3：准入阶段（影子流量 → 金丝雀小流量 → 毕业全量；退场 ejected） */
export type AdmissionStage = 'shadow' | 'canary' | 'graduated' | 'ejected';

/** R4-3：冷启动准入协议配置 */
export interface AdmissionProtocolOptions {
  /** 影子阶段最少观察数（缺省 5） */
  shadowMinSamples?: number;
  /** 影子 → 金丝雀质量门（影子期均值 ≥ 该值才晋级；缺省 0.5） */
  shadowQualityGate?: number;
  /** 金丝雀阶段最少观察数（缺省 5） */
  canaryMinSamples?: number;
  /** 金丝雀 → 毕业质量门（金丝雀期均值 ≥ 该值才全量；缺省 0.6） */
  canaryQualityGate?: number;
  /** 弹劾线：观察数达影子门即样本且均值 < 该值 → 直接退场（缺省 0.35） */
  ejectBelow?: number;
  /** 试用总样本上限（超过仍未晋级 → 退场；缺省 50，防无限试用） */
  trialMaxSamples?: number;
  /** 金丝雀小流量比例（0~1，缺省 0.2 → 确定性每 5 次选型放行 1 次） */
  canaryShare?: number;
  /** 时钟注入（缺省 Date.now；阶段转换时刻入账） */
  clock?: () => number;
}

/** R4-3：单模型准入记录（admissionView 输出项） */
export interface AdmissionRecord {
  modelId: string;
  stage: AdmissionStage;
  shadowSamples: number;
  canarySamples: number;
  /** 试用内累计质量均值（0 样本时 0.5 中性） */
  meanQuality: number;
  /** 当前是否可入常规候选（graduated 恒真；canary 按时隙；shadow/ejected 恒假） */
  selectable: boolean;
  /** 退场/毕业时刻（毫秒；未发生为 undefined） */
  settledAt?: number;
  rationale: string;
}

/** R4-4：成本漂移告警配置 */
export interface DriftSentinelOptions {
  /** 基线窗观测数（前 N 个观测的 EWMA 冻结为基线带；缺省 8） */
  baselineSamples?: number;
  /** EWMA 平滑系数（缺省 0.3） */
  ewmaAlpha?: number;
  /** 显著漂移相对阈值（|当前−基线|/基线 ≥ 该值触发；缺省 0.25） */
  driftThreshold?: number;
  /** 时钟注入（缺省 Date.now） */
  clock?: () => number;
}

/** R4-4：漂移告警（driftAlerts 输出项；显著漂移 → 重画像建议） */
export interface DriftAlert {
  modelId: string;
  /** 漂移监测口径：单位成本 / 时延 */
  metric: 'costPerCall' | 'latencyMs';
  /** 冻结基线带值（基线窗 EWMA） */
  baseline: number;
  /** 当前 EWMA 值 */
  current: number;
  /** 有符号相对漂移（(当前−基线)/基线） */
  relativeDrift: number;
  /** 建议动作（重画像：单价/时延结构已变，成本画像需重算） */
  action: 're-profile';
  /** 首次越线时刻（毫秒） */
  firstBreachedAt: number;
}

/** R4-5：模型特长画像配置 */
export interface SpecialtyMatrixOptions {
  /** 质量 EMA 平滑系数（缺省 0.2） */
  emaAlpha?: number;
  /** 特长乘数强度（乘数 = 1 + strength×(均值−0.5)；缺省 0.8） */
  strength?: number;
  /** 特长乘数上限（对称下限 = 2 − 上限；缺省 1.5 → 钳位 [0.5,1.5]） */
  multiplierCap?: number;
  /** 生效最少样本（缺省 3——不足时中性乘数 1，不因孤证改推荐） */
  minSamples?: number;
}

/** R4-5：特长矩阵单元（specialtyView 输出项） */
export interface SpecialtyEntry {
  modelId: string;
  taskType: string;
  /** 该模型在该任务类型上的历史质量 EMA 均值 */
  meanQuality: number;
  samples: number;
  /** 特长乘数（>1 擅长 / <1 不擅长；样本不足或均值 0.5 恰为 1） */
  multiplier: number;
}

/** A3-1：单模型健康追踪内部状态（EWMA 遥测 + 熔断器机内态） */
interface HealthTracker {
  observations: number;
  ewmaError: number;
  ewmaLatency: number;
  hasLatency: boolean;
  consecutiveFailures: number;
  breaker: CircuitBreakerState;
  openAt?: number;
  backoffMs: number;
  probeInFlight: boolean;
  probeStartedAt?: number;
  lastReportAt?: number;
}

/** R4-2：任务需求流追踪内部状态（时间桶计数 + EWMA 请求率 + 趋势窗） */
interface PrewarmTracker {
  bucketIndex: number;
  bucketCount: number;
  ewmaRate: number;
  hasRate: boolean;
  history: number[];
  /** 最近一次建议快照（prewarmSuggestions 输出缓存；无建议为 undefined） */
  lastSuggestion?: PrewarmSuggestion;
}

/** R4-3：准入协议内部状态（阶段机 + 分阶段质量记账 + 金丝雀时隙） */
interface AdmissionTracker {
  stage: AdmissionStage;
  shadowSamples: number;
  canarySamples: number;
  shadowQualitySum: number;
  canaryQualitySum: number;
  canaryCounter: number;
  stageSince: number;
  settledAt?: number;
}

/** R4-4：单模型 × 单口径漂移追踪内部状态（冻结基线带 vs 当前 EWMA） */
interface DriftTracker {
  metric: 'costPerCall' | 'latencyMs';
  baseline: number;
  current: number;
  count: number;
  hasValue: boolean;
  firstBreachedAt?: number;
}

/** R4-5：特长矩阵单元内部状态（质量 EMA + 样本数） */
interface SpecialtyCell {
  mean: number;
  samples: number;
}

/** 二项系数 C(n,k)（R4-1 组合枚举计数；小规模精确值） */
function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/**
 * 模型调度器
 *
 * 被任务执行器（task-executor.ts）持有：节点执行前调用 assignModel 分配模型，
 * 重试切换时调用 pickFallbackModel 选择次优模型。
 */
export class ModelScheduler {
  private llm: LLMClient;
  private memory: LongTermMemory;
  private config: ModelSchedulerConfig;
  /** 当前生效调度策略（第三阶段：评分函数参数来源；基准 = 原固定行为） */
  private currentPolicy: Policy;
  /** B 路线：共生经济乘数（modelId → 乘数；缺省空 = 全中性） */
  private economicMultipliers = new Map<string, number>();
  /** 6.0：自由能引擎（EFE 调度模式；未挂载/未启用零漂移） */
  private freeEnergy?: FreeEnergyEngine;
  /** 21.0：索引调度器（Gittins 指数口径；未挂载零漂移） */
  private indexScheduler?: IndexScheduler;
  /** 22.0：预算路由器（Bandits with Knapsacks；未挂载零漂移） */
  private bwKRouter?: BwKRouter;
  /** 22.0：预算提供器（每次选型时只读治理器剩余预算） */
  private bwKBudgetProvider?: () => { tokensRemaining: number; costRemaining: number } | undefined;
  /** 22.0：最近一次路由裁决（诊断口径；getAttachedDiagnostics 消费） */
  private lastBwKVerdict?: BwKVerdict;
  /** 31.0：对抗组合（Fixed-Share Hedge；未挂载零漂移） */
  private hedge?: Hedge;
  /** 31.0：专家下标 ↔ 模型 id 映射（挂载时刻的注册模型快照） */
  private hedgeModelIds: string[] = [];
  /** 35.0：并发反馈控制器（未挂载零漂移——静态口径） */
  private concurrencyController?: FeedbackController;
  /** 43.0：容量前沿挂载标志（未挂载零记录零介入） */
  private capacityFrontierEnabled = false;
  /** 43.0：最近一次容量前沿（max-flow 值 + min-cut 归因；诊断口径） */
  private lastCapacityFrontier?: CapacityFrontier;
  /** 50.0：潜因子挂载标志（未挂载零介入——纯诊断口径） */
  private latentFactorsEnabled = false;
  /** 50.0：最近一次矩阵补全报告（冷启动能力预测的原料） */
  private lastCompletion?: CompletionReport;
  /** 51.0：投机解码配对裁决器（未挂载零介入） */
  private speculativePairing?: SpeculativePairingAdvisor;
  /** 51.0：最近一次配对裁决（诊断口径） */
  private lastSpeculativeVerdict?: { verdict: SpeculativeEconomyVerdict; drafterId: string; verifierId: string; taskType: string };
  /** 53.0：Whittle 索数调度配置（未挂载零介入） */
  private whittleOptions?: WhittleAdapterOptions;
  /** 67.0：帕累托前沿挂载标志（未挂载零介入——只读菜单口径） */
  private paretoFrontEnabled = false;
  /** A3-1：健康感知路由（未挂载零介入——无过滤无折价零读数） */
  private healthRouting?: {
    alpha: number;
    failureThreshold: number;
    errorThreshold: number;
    minObservations: number;
    latencyTripMs?: number;
    halfOpenAfterMs: number;
    backoffMultiplier: number;
    maxBackoffMs: number;
    probeTimeoutMs: number;
    errorPenaltyWeight: number;
    clock: () => number;
    states: Map<string, HealthTracker>;
  };
  /** A3-2：P2C 负载均衡（未挂载零介入——argmax 逐位不变） */
  private p2c?: { loadOf?: (modelId: string) => number; random: () => number; scoreGate: number };
  /** A3-2：最近一次 P2C 决策（可观测读数） */
  private lastP2c?: P2CDecision;
  /** A3-3：任务类别 → 成本画像绑定（'*' = 兜底；空 = 全部走原路径） */
  private costProfiles = new Map<string, CostProfile>();
  /** A3-4：重试预算（未挂载零介入——admitRetry 恒放行） */
  private retryBudgetState?: {
    windowMs: number;
    maxRetries: number;
    clock: () => number;
    used: Map<string, number[]>;
    degraded: Map<string, number>;
  };
  /** A3-5：调度审计（未挂载零介入——纯旁路环形日志） */
  private auditLog?: { maxEntries: number; clock: () => number; entries: SchedulingAuditEntry[]; nextSeq: number };
  /** A3-5：最近一次内核选型路径（审计归因用；每次分配前重置） */
  private lastKernelPath?: SchedulingAuditEntry['path'];
  /** R4-1：集成组合优化（未挂载零介入——composeEnsemble 诚实 undefined） */
  private ensembleComposer?: {
    maxModels: number;
    budgetPerCall?: number;
    costPerCallOf?: (modelId: string) => number;
    qualityOf?: (modelId: string, taskType: string) => number;
    enumerationLimit: number;
  };
  /** R4-2：预测性预热（未挂载零介入——noteTaskDemand 无去处） */
  private prewarmState?: {
    bucketMs: number;
    alpha: number;
    trendWindow: number;
    horizonMs: number;
    threshold: number;
    suggestModels: number;
    clock: () => number;
    trackers: Map<string, PrewarmTracker>;
  };
  /** R4-3：冷启动准入协议（未挂载零介入——未登记模型不受约束） */
  private admissionState?: {
    shadowMinSamples: number;
    shadowQualityGate: number;
    canaryMinSamples: number;
    canaryQualityGate: number;
    ejectBelow: number;
    trialMaxSamples: number;
    canaryShare: number;
    clock: () => number;
    records: Map<string, AdmissionTracker>;
  };
  /** R4-4：成本漂移告警（未挂载零介入——纯遥测旁路） */
  private driftSentinel?: {
    baselineSamples: number;
    alpha: number;
    threshold: number;
    clock: () => number;
    trackers: Map<string, DriftTracker>;
  };
  /** R4-5：模型特长画像（未挂载零介入——乘数恒 1） */
  private specialtyMatrix?: {
    alpha: number;
    strength: number;
    cap: number;
    minSamples: number;
    cells: Map<string, SpecialtyCell>;
  };

  constructor(params: { llm: LLMClient; memory: LongTermMemory; config?: ModelSchedulerConfig }) {
    this.llm = params.llm;
    this.memory = params.memory;
    this.config = params.config ?? {};
    // 基准策略：costWeight 沿用构造配置（保持既有调用方行为），其余复刻原固定值
    this.currentPolicy = {
      id: 'policy-baseline',
      version: 1,
      type: 'scheduler',
      params: { ...BASELINE_POLICY_PARAMS, costWeight: this.config.costWeight ?? BASELINE_POLICY_PARAMS.costWeight },
      origin: 'baseline',
      generation: 0,
      createdAt: Date.now(),
    };
  }

  /** 运行时配置热更新（元认知自调优落地入口） */
  updateConfig(patch: Partial<ModelSchedulerConfig>): void {
    this.config = { ...this.config, ...patch };
    if (patch.costWeight !== undefined) {
      // 配置热更新同步到当前策略参数（策略部署前的兼容路径）
      this.currentPolicy = { ...this.currentPolicy, params: { ...this.currentPolicy.params, costWeight: patch.costWeight } };
    }
  }

  /**
   * B 路线：注入共生经济乘数（能量反哺调度；宿主心跳桥接调用）。
   *
   * 乘数来自 SymbiosisBridge.economicSignals()（余额 × Wilson 信誉的
   * 复合健康度），仅作用于利用端评分——赚钱的模型升权、持续亏损的
   * 模型降权。注入即生效（对后续 assignModel/pickEnsemble/pickFallback
   * 全路径一致）；信号中缺失的模型回退中性乘数 1。
   * @param signals modelId → 调度乘数（典型范围 0.5~1.5）
   */
  updateEconomicSignals(signals: Record<string, number> | Map<string, number>): void {
    const next = new Map<string, number>();
    const entries = signals instanceof Map ? signals : Object.entries(signals);
    for (const [modelId, m] of entries) {
      // 防御：非有限值 / 非正数一律忽略（外部信号不破坏评分域）
      if (Number.isFinite(m) && m > 0) next.set(modelId, m);
    }
    this.economicMultipliers = next;
  }

  /**
   * 6.0：挂载自由能引擎（幂等；需同时 freeEnergyEnabled=true 才生效）。
   *
   * @param engine 主动推断内核实例（宿主单一实例共享）
   * @param outcomeNode 因果图结果节点（缺省 'task.outcome'；模型选择即
   *   do(use:model) 干预，证据由共生结算侧登记）
   */
  attachFreeEnergy(engine: FreeEnergyEngine, outcomeNode = 'task.outcome'): void {
    this.freeEnergy = engine;
    this.efeOutcomeNode = outcomeNode;
  }

  private efeOutcomeNode = 'task.outcome';

  /**
   * 21.0：挂载索引调度器（幂等覆盖，挂载即生效）。
   *
   * 挂载后 assignModelWithInsight 的动态选型升级为 Gittins 索引口径：
   * 候选（Beta 后验臂）按 effectiveIndex = ν × availability 降序取榜首。
   * preferred 短路 / avoidModels 剔除 / 无候选抛 ExecutionError 的语义
   * 保持不变；未挂载时动态选型与原路径逐位一致（零漂移）。
   */
  attachIndexScheduler(scheduler: IndexScheduler): void {
    this.indexScheduler = scheduler;
  }

  /**
   * 22.0：挂载预算路由器与预算提供器（幂等覆盖）。
   *
   * budgetProvider 在每次选型时读取剩余预算（只读，不推进状态）；
   * 返回 undefined 或 tokensRemaining ≤ 0 时本路由不介入（走原路径）。
   */
  attachBwKRouter(
    router: BwKRouter,
    budgetProvider: () => { tokensRemaining: number; costRemaining: number } | undefined,
  ): void {
    this.bwKRouter = router;
    this.bwKBudgetProvider = budgetProvider;
  }

  /** 21.0/22.0/31.0/35.0：已挂载数学内核的诊断快照（未挂载/未裁决的键不出现） */
  getAttachedDiagnostics(): { indexScheduling?: GittinsSnapshot; lastBwK?: BwKVerdict; hedge?: HedgeStats; concurrencyControl?: ControlStep } {
    const diagnostics: { indexScheduling?: GittinsSnapshot; lastBwK?: BwKVerdict; hedge?: HedgeStats; concurrencyControl?: ControlStep } = {};
    if (this.indexScheduler) diagnostics.indexScheduling = this.indexScheduler.getTable().snapshot();
    if (this.lastBwKVerdict) diagnostics.lastBwK = this.lastBwKVerdict;
    if (this.hedge) diagnostics.hedge = this.hedge.stats();
    if (this.lastControlStep) diagnostics.concurrencyControl = this.lastControlStep;
    return diagnostics;
  }

  /**
   * 31.0：挂载对抗组合（Fixed-Share Hedge，幂等覆盖，挂载即生效）。
   *
   * 专家 = 挂载时刻的注册模型快照；执行侧每节点完成时经
   * reportHedgeOutcome(modelId, reward∈[0,1]) 回报质量。权重经
   * hedgeMultiplierOf 以有界乘数（[0.25, 4]）作用于利用端评分——
   * 统计学习口径（Wilson/UCB/Gittins）之上叠加**对抗口径**：无论世界
   * 怎么漂移（限流、静默降级），对事后最优固定模型的遗憾 ≤ √(2T lnN)。
   * 未挂载时乘数恒 1（评分逐位零漂移）。
   */
  attachHedgePortfolio(options?: { eta?: number; alpha?: number }): void {
    this.hedgeModelIds = this.llm.getModelStatuses().map((s) => s.id);
    if (this.hedgeModelIds.length === 0) {
      this.hedge = undefined;
      return;
    }
    this.hedge = new Hedge({ experts: this.hedgeModelIds.length, eta: options?.eta, alpha: options?.alpha });
  }

  /**
   * 31.0：执行结果回报（reward = 成功质量 ∈ [0,1]，失败 = 0；未挂载为空操作）。
   *
   * 部分反馈口径：本轮仅被指派模型有观测（掩码更新——未被指派的专家
   * 权重不动，只受 Fixed-Share 回灌微调）。对手把某模型打爆时，其权重
   * 以每失败一轮 e^{−η} 的速度衰减——比统计口径（Wilson 时间衰减）快
   * 一个数量级的对抗性降权。
   */
  reportHedgeOutcome(modelId: string, reward: number): void {
    if (!this.hedge) return;
    const idx = this.hedgeModelIds.indexOf(modelId);
    if (idx < 0) return;
    this.hedge.reportSingle(idx, reward);
  }

  /** 31.0：对抗组合对模型的有界评分乘数（未挂载恒 1；零漂移） */
  hedgeMultiplierOf(modelId: string): number {
    if (!this.hedge) return 1;
    const idx = this.hedgeModelIds.indexOf(modelId);
    if (idx < 0) return 1;
    return hedgeMultiplier(this.hedge.weights(), idx);
  }

  /**
   * 35.0：挂载并发反馈控制器（幂等覆盖，挂载即生效）。
   *
   * computeParallelism 从静态口径（总并发容量钳位）升级为闭环：每次
   * 被调用即一步反馈（观测当前总利用率 → LQR 增益 → 新上限），目标
   * 利用率缺省 0.75。稳定性由 DARE/Lyapunov 证书背书（35.0 内核），
   * 死区抗抖振、输出钳位即抗饱和。未挂载时与原静态口径逐位一致。
   */
  attachConcurrencyController(options?: FeedbackControllerConfig): void {
    this.concurrencyController = new FeedbackController({ target: 0.75, plantGain: 0.4, minOutput: 1, maxOutput: 16, ...options });
  }

  /** 35.0：最近一次控制步（诊断口径） */
  private lastControlStep?: ControlStep;

  /**
   * 43.0：挂载容量前沿（幂等覆盖，挂载即生效——纯诊断口径）。
   *
   * 「类型需求 × 模型容量」流网络（源→类型（需求）→模型（评分>0 可达
   * 边）→汇（maxConcurrency））上解 Edmonds-Karp 最大流 = 可立即满足
   * 的最大并发派发；最小割指认钳制者（类型在饿还是模型是独木桥）——
   * 割容量 = 流值（Ford-Fulkerson 证书）。执行器每批回写待执行需求；
   * 不改变任何派发行为（零漂移），吞吐上限与瓶颈归因经
   * getAttachedDiagnostics / query_memory capacity 可读。
   */
  attachCapacityFrontier(): void {
    this.capacityFrontierEnabled = true;
  }

  /** 43.0：执行批回写待执行需求（未挂载为空操作；类型计数 × 候选容量 → 流前沿） */
  updateCapacityFrontier(demands: ReadonlyArray<{ type: string; count: number }>): void {
    if (!this.capacityFrontierEnabled || demands.length === 0) return;
    const models = this.llm.getModelStatuses().map((s) => ({ id: s.id, capacity: s.maxConcurrency }));
    if (models.length === 0) return;
    this.lastCapacityFrontier = capacityFrontier(
      demands,
      models,
      (taskType, modelId) => {
        const status = this.llm.getModelStatuses().find((s) => s.id === modelId);
        if (!status) return false;
        const score = status.taskScores[taskType] ?? status.taskScores['general'];
        return score === undefined || score > 0;
      },
    );
  }

  /**
   * 50.0：挂载潜因子补全（幂等覆盖，挂载即生效——纯诊断口径）。
   *
   * 「模型 × 任务类型」能力矩阵经 ALS 低秩补全（rank 缺省 3）：观测
   * 条目（各模型 taskScores 已有值的部分）拟合 U·Vᵀ，未观测条目由
   * 潜因子外推——新模型的冷启动选型从零样本瞎选升级为潜维度预测
   * （Candès–Recht 恢复条件背书）。lowRankShare 读出低秩假设的成色；
   * 不改变任何评分路径（零漂移），coldStartEstimate 按需读取。
   */
  attachLatentFactors(options?: { rank?: number }): void {
    this.latentFactorsEnabled = true;
    this.latentRank = Math.max(1, Math.min(6, Math.floor(options?.rank ?? 3)));
    this.refreshLatentFactors();
  }

  private latentRank = 3;

  /** 50.0：重算能力矩阵补全（观测 = 各模型 taskScores 的非空条目，行=模型 列=任务类型并集） */
  private refreshLatentFactors(): void {
    const statuses = this.llm.getModelStatuses();
    const modelIds = statuses.map((s) => s.id);
    const taskTypes = new Set<string>();
    for (const s of statuses) for (const t of Object.keys(s.taskScores)) taskTypes.add(t);
    const types = [...taskTypes];
    const observed: Array<{ i: number; j: number; value: number }> = [];
    statuses.forEach((s, i) => {
      for (const [t, v] of Object.entries(s.taskScores)) {
        const j = types.indexOf(t);
        if (j >= 0 && Number.isFinite(v)) observed.push({ i, j, value: v });
      }
    });
    this.latentTypeIndex = new Map(types.map((t, j) => [t, j]));
    this.latentModelIndex = new Map(modelIds.map((id, i) => [id, i]));
    if (observed.length < 4 || modelIds.length < 2 || types.length < 2) {
      this.lastCompletion = undefined;
      return;
    }
    this.lastCompletion = completeMatrix(observed, modelIds.length, types.length, { rank: this.latentRank });
  }

  private latentTypeIndex = new Map<string, number>();
  private latentModelIndex = new Map<string, number>();

  /**
   * 50.0：冷启动能力预测（观测未覆盖的 model×taskType 条目由潜因子
   * 外推；未挂载/未覆盖返回 undefined——诚实降级）
   */
  coldStartEstimate(modelId: string, taskType: string): number | undefined {
    if (!this.lastCompletion) return undefined;
    const i = this.latentModelIndex.get(modelId);
    const j = this.latentTypeIndex.get(taskType) ?? this.latentTypeIndex.get('general');
    if (i === undefined || j === undefined) return undefined;
    return completedEntry(this.lastCompletion, i, j);
  }

  /** 50.0：补全报告快照（纯读取） */
  getLatentFactorReport(): { rank: number; trainRmse: number; observedRatio: number; lowRankShare: number; converged: boolean } | undefined {
    return this.lastCompletion
      ? {
          rank: this.latentRank,
          trainRmse: this.lastCompletion.trainRmse,
          observedRatio: this.lastCompletion.observedRatio,
          lowRankShare: this.lastCompletion.lowRankShare,
          converged: this.lastCompletion.converged,
        }
      : undefined;
  }

  /** 43.0：最近一次容量前沿（纯读取；未挂载/未回写返回 undefined） */
  getCapacityFrontier(): CapacityFrontier | undefined {
    return this.lastCapacityFrontier ? { ...this.lastCapacityFrontier, bindingConstraints: [...this.lastCapacityFrontier.bindingConstraints] } : undefined;
  }

  /**
   * 51.0：挂载投机解码配对裁决（幂等覆盖，挂载即生效——咨询口径）。
   *
   * 多模型并行执行的 drafter→verifier 配对有了期望收益闭式裁决：
   * speculativePairFor(taskType) 在候选池中选「最廉草稿 × 最强验证器」，
   * verdict.adopt=true 才值得开 draft-verify 通道（k* 随 γ、r 单调响应，
   * γ 跌破 break-even 一步判退直通）。不改变 assignModel 评分路径
   * （零漂移）——执行侧按需消费裁决；γ 由后验遥测估计、可经
   * options.gammaOf 注入真实「草稿接受率滑动统计」。
   */
  attachSpeculativeDecoding(options?: { maxK?: number; gammaOf?: (drafter: SpeculativeCandidate, verifier: SpeculativeCandidate) => number }): void {
    this.speculativePairing = new SpeculativePairingAdvisor(options);
  }

  /**
   * 51.0：任务类型的投机配对裁决（未挂载 / 候选 <2 时 undefined——诚实降级）。
   * 成本口径 = 平均延迟（时间成本单位，只有比值进入数学）；后验来自记忆画像。
   */
  speculativePairFor(taskType: string): { verdict: SpeculativeEconomyVerdict; drafterId: string; verifierId: string; taskType: string } | undefined {
    if (!this.speculativePairing) return undefined;
    const candidates: SpeculativeCandidate[] = this.llm.getModelStatuses().map((s) => {
      const estimate = this.memory.getBayesianEstimate(s.id, taskType);
      return {
        id: s.id,
        costPerCall: s.avgLatency > 0 ? s.avgLatency : 100,
        posteriorMean: estimate ? estimate.posteriorMean : 0.5,
      };
    });
    const result = this.speculativePairing.bestPair(candidates, taskType);
    if (result) this.lastSpeculativeVerdict = result;
    return result;
  }

  /** 51.0：最近一次配对裁决（纯读取） */
  getSpeculativeVerdict(): { verdict: SpeculativeEconomyVerdict; drafterId: string; verifierId: string; taskType: string } | undefined {
    return this.lastSpeculativeVerdict;
  }

  /**
   * 53.0：挂载 Whittle 指数调度（幂等覆盖，挂载即生效）。
   *
   * 动态选型升级为 RMAB 口径：每个候选模型是「不休眠两态臂」（good/bad
   * 由后验均值阈值化；主动修复率 = 后验、被动恶化率 = 失败率——21.0 的
   * availability 乘法折算是本内核的粗近似，两态族下此处给出精确解且恒
   * 可索引有定理保证）。挂载后 assignModelWithInsight 动态选型走
   * Whittle top-1（不可索引/未收敛时诚实回退原评分路径）。优先级低于
   * 21.0 indexScheduler（先挂先得）；preferred 短路与 avoidModels 语义
   * 不变；未挂载零漂移。
   */
  attachWhittleIndex(options?: WhittleAdapterOptions): void {
    this.whittleOptions = options ?? {};
  }

  /** 53.0：断开 Whittle 调度（诊断/回退口径） */
  detachWhittleIndex(): void {
    this.whittleOptions = undefined;
  }

  /**
   * 67.0：挂载帕累托前沿视图（幂等覆盖，挂载即生效——只读菜单口径）。
   *
   * 「质量-成本-延迟」三目标从加权拍脑袋升级为真 Pareto 前沿：
   * paretoFrontView() 输出非支配模型菜单（风险调整错误率 / 成本 / 延迟
   * 全最小化）+ 拥挤距离 + (风险,成本) 平面 2D 超体积——「多花 2 分钱
   * 省多少毫秒」直接从前沿相邻点读出。不改变任何评分路径（零漂移）。
   */
  attachParetoFront(): void {
    this.paretoFrontEnabled = true;
  }

  /**
   * 67.0：当前候选池的帕累托前沿视图（未挂载返回 undefined）。
   * 成本口径 = 平均 token 消耗；延迟口径 = 平均延迟；风险 = 1 − Wilson 下界。
   */
  paretoFrontView(taskType?: string): {
    frontIds: string[];
    points: Array<{ id: string; risk: number; cost: number; latency: number }>;
    crowding: number[];
    hypervolume: number;
  } | undefined {
    if (!this.paretoFrontEnabled) return undefined;
    const points = this.llm.getModelStatuses().map((s) => {
      const estimate = this.memory.getBayesianEstimate(s.id, taskType ?? 'general');
      return {
        id: s.id,
        risk: estimate ? 1 - estimate.wilsonLower : 0.5,
        cost: s.totalCalls > 0 ? s.totalTokensUsed / s.totalCalls : 600,
        latency: s.avgLatency > 0 ? s.avgLatency : 800,
      };
    });
    if (points.length < 2) return undefined;
    const frontIdx = paretoFront(points.map((p) => [p.risk, p.cost, p.latency]));
    const frontIds = frontIdx.map((p) => {
      const found = points.find((q) => q.risk === p[0] && q.cost === p[1] && q.latency === p[2]);
      return found ? found.id : '';
    }).filter(Boolean);
    const crowding = frontIdx.length >= 3 ? crowdingDistance(frontIdx) : frontIdx.map(() => Number.POSITIVE_INFINITY);
    // (风险, 成本) 平面 2D 超体积（参考点 = 1.25×各维最差值——前沿覆盖读数）
    const risks = points.map((p) => p.risk);
    const costs = points.map((p) => p.cost);
    const ref: [number, number] = [Math.max(...risks) * 1.25 + 1e-9, Math.max(...costs) * 1.25 + 1e-9];
    const hypervolume = hypervolume2D(points.map((p) => [p.risk, p.cost]), ref);
    return { frontIds, points, crowding, hypervolume };
  }

  // ─────────────────── A3-1：健康感知路由（EWMA + 熔断器三态） ───────────────────

  /**
   * A3-1：挂载健康感知路由（幂等覆盖 = 全新挂载，历史遥测清零）。
   *
   * 每模型维护 EWMA 延迟 / EWMA 错误率两条遥测流（reportModelHealth
   * 喂入），驱动熔断器三态机：
   * - closed（正常供电）：连续失败 ≥ failureThreshold、或观测数 ≥
   *   minObservations 且 EWMA 错误率 ≥ errorThreshold、或（配置了
   *   latencyTripMs 时）EWMA 延迟 ≥ latencyTripMs —— 任一成立即跳闸；
   * - open（熔断拒绝）：冷却 backoffMs 内从候选剔除（迟到回报不改判
   *   ——恢复只走半开探针，杜绝在途漏网调用把故障模型拉回）；
   * - half-open（半开探活）：冷却期满惰性转入；被选中即占单探针槽
   *   （探活结果未回时不再派新活，超 probeTimeoutMs 释放槽位），
   *   成功 → closed 且退避复位，失败 → open 且退避 ×backoffMultiplier
   *   （指数退避，钳位 maxBackoffMs）。
   *
   * EWMA 错误率另以健康乘数（1 − errorPenaltyWeight×错误率）折价利用端
   * 评分——未跳闸但劣化的模型先被降权、跳闸后彻底剔除；半开态乘数旁路
   * （探针公平起跑，否则劣化模型永无探活机会——探活饿死）。推荐
   * （preferred）短路同样尊重熔断硬闸。全池熔断时最早熔断者强制转半开
   * 探活（永不因健康闸门抛新错）。未挂载：无过滤、乘数恒 1、
   * healthView() 为 undefined——零漂移。
   */
  attachHealthRouting(options?: HealthRoutingOptions): void {
    const halfOpenAfterMs = Math.max(0, options?.halfOpenAfterMs ?? 5_000);
    this.healthRouting = {
      alpha: Math.min(1, Math.max(0, options?.ewmaAlpha ?? 0.3)),
      failureThreshold: Math.max(1, Math.floor(options?.failureThreshold ?? 3)),
      errorThreshold: Math.min(1, Math.max(0, options?.errorThreshold ?? 0.6)),
      minObservations: Math.max(1, Math.floor(options?.minObservations ?? 5)),
      latencyTripMs:
        options?.latencyTripMs !== undefined && Number.isFinite(options.latencyTripMs)
          ? Math.max(0, options.latencyTripMs)
          : undefined,
      halfOpenAfterMs,
      backoffMultiplier: Math.max(1, options?.backoffMultiplier ?? 2),
      maxBackoffMs: Math.max(options?.maxBackoffMs ?? 120_000, halfOpenAfterMs),
      probeTimeoutMs: Math.max(1, options?.probeTimeoutMs ?? 30_000),
      errorPenaltyWeight: Math.min(1, Math.max(0, options?.errorPenaltyWeight ?? 0.5)),
      clock: options?.clock ?? Date.now,
      states: new Map(),
    };
  }

  /** A3-1：断开健康路由（诊断/回退口径；遥测清零） */
  detachHealthRouting(): void {
    this.healthRouting = undefined;
  }

  /**
   * A3-1：健康遥测回报（成功/失败调用结局 + 本次延迟；未挂载 = 信号无
   * 去处，诚实无操作）。执行侧每次调用终态后回喂——EWMA 流与熔断器
   * 状态机按回报序列确定演化。
   */
  reportModelHealth(modelId: string, outcome: { latencyMs?: number; failed?: boolean }): void {
    const h = this.healthRouting;
    if (!h) return;
    const now = h.clock();
    let s = h.states.get(modelId);
    if (!s) {
      s = {
        observations: 0,
        ewmaError: 0,
        ewmaLatency: 0,
        hasLatency: false,
        consecutiveFailures: 0,
        breaker: 'closed',
        backoffMs: h.halfOpenAfterMs,
        probeInFlight: false,
      };
      h.states.set(modelId, s);
    }
    s.observations += 1;
    if (outcome.failed !== undefined) {
      s.ewmaError = h.alpha * (outcome.failed ? 1 : 0) + (1 - h.alpha) * s.ewmaError;
      s.consecutiveFailures = outcome.failed ? s.consecutiveFailures + 1 : 0;
    }
    if (typeof outcome.latencyMs === 'number' && Number.isFinite(outcome.latencyMs) && outcome.latencyMs >= 0) {
      s.ewmaLatency = s.hasLatency ? h.alpha * outcome.latencyMs + (1 - h.alpha) * s.ewmaLatency : outcome.latencyMs;
      s.hasLatency = true;
    }
    // 状态机：half-open 探针裁决 → closed/open 翻转；closed 跳闸检查；
    // open 冷却期内的迟到回报一律不改判（恢复只走半开探针）
    if (s.breaker === 'half-open') {
      s.probeInFlight = false;
      s.probeStartedAt = undefined;
      if (outcome.failed === true) {
        s.breaker = 'open';
        s.openAt = now;
        s.backoffMs = Math.min(h.maxBackoffMs, s.backoffMs * h.backoffMultiplier);
      } else {
        s.breaker = 'closed';
        s.openAt = undefined;
        s.consecutiveFailures = 0;
        s.backoffMs = h.halfOpenAfterMs;
      }
    } else if (s.breaker === 'closed') {
      if (this.healthShouldTrip(s)) {
        s.breaker = 'open';
        s.openAt = now;
        s.probeInFlight = false;
      }
    }
    s.lastReportAt = now;
  }

  /** A3-1：closed 态跳闸判据（连续失败 / EWMA 错误率 / EWMA 延迟三线合一） */
  private healthShouldTrip(s: HealthTracker): boolean {
    const h = this.healthRouting;
    if (!h) return false;
    if (s.consecutiveFailures >= h.failureThreshold) return true;
    if (s.observations >= h.minObservations && s.ewmaError >= h.errorThreshold) return true;
    if (
      h.latencyTripMs !== undefined &&
      s.hasLatency &&
      s.observations >= h.minObservations &&
      s.ewmaLatency >= h.latencyTripMs
    ) {
      return true;
    }
    return false;
  }

  /** A3-1：候选资格（惰性 open→half-open 转移 + 探针槽检查；未挂载恒真） */
  private healthEligible(modelId: string, now: number): boolean {
    const h = this.healthRouting;
    if (!h) return true;
    const s = h.states.get(modelId);
    if (!s) return true; // 无遥测 = 无证据不惩罚
    if (s.breaker === 'closed') return true;
    if (s.breaker === 'open') {
      if (now - (s.openAt ?? now) >= s.backoffMs) {
        s.breaker = 'half-open'; // 冷却期满惰性转半开
        s.probeInFlight = false;
        s.probeStartedAt = undefined;
        return true;
      }
      return false;
    }
    // half-open：探针在途且未超时 → 排除；超时 → 释放探针槽可再探
    if (s.probeInFlight) {
      if (now - (s.probeStartedAt ?? now) <= h.probeTimeoutMs) return false;
      s.probeInFlight = false;
      s.probeStartedAt = undefined;
    }
    return true;
  }

  /** A3-1：选中半开模型即占探针槽（探活结果未回前不再派新活） */
  private markHealthProbe(modelId: string): void {
    const h = this.healthRouting;
    if (!h) return;
    const s = h.states.get(modelId);
    if (s && s.breaker === 'half-open' && !s.probeInFlight) {
      s.probeInFlight = true;
      s.probeStartedAt = h.clock();
    }
  }

  /**
   * A3-1：健康乘数（EWMA 错误率折价；未挂载/无遥测恒 1——评分逐位零漂移）。
   *
   * 半开态恒 1（探针公平起跑）：折价若跟随进入半开期，劣化模型在候选中
   * 永远争不过干净对手 → 探针永远排不上 → 熔断永不合（探活饿死）。
   * 信誉恢复由 closed 态的 EWMA 指数衰减自然给出（连续成功数次后
   * 乘数回升、夺回榜首——惩罚有界且可恢复）。
   */
  healthMultiplierOf(modelId: string): number {
    const h = this.healthRouting;
    if (!h) return 1;
    const s = h.states.get(modelId);
    if (!s) return 1;
    if (s.breaker === 'half-open') return 1;
    return Math.max(0.05, 1 - h.errorPenaltyWeight * s.ewmaError);
  }

  /** A3-1：全模型健康快照（未挂载 undefined——诚实降级；纯读取不改状态机） */
  healthView(): ModelHealthEntry[] | undefined {
    const h = this.healthRouting;
    if (!h) return undefined;
    const entries: ModelHealthEntry[] = [];
    for (const [modelId, s] of h.states) {
      entries.push({
        modelId,
        observations: s.observations,
        ewmaLatencyMs: s.hasLatency ? s.ewmaLatency : 0,
        ewmaErrorRate: s.ewmaError,
        breaker: s.breaker,
        consecutiveFailures: s.consecutiveFailures,
        openedAt: s.breaker === 'closed' ? undefined : s.openAt,
        backoffMs: s.backoffMs,
        probeInFlight: s.probeInFlight,
        healthMultiplier: s.breaker === 'half-open' ? 1 : Math.max(0.05, 1 - h.errorPenaltyWeight * s.ewmaError),
      });
    }
    return entries;
  }

  // ─────────────────── A3-2：两次选择幂（P2C）负载均衡 ───────────────────

  /**
   * A3-2：挂载 P2C 负载均衡（幂等覆盖，挂载即生效——仅作用于评分选型路径）。
   *
   * 质量门内的候选（total ≥ scoreGate × 最高分，缺省 0.8——负载均衡
   * 不以牺牲质量为代价）中随机抽两个不同候选、取负载轻者（并列取先抽
   * 者，确定性）。负载读数缺省为模型运行时 activeRequests/maxConcurrency
   * 归一利用率；可注入 loadOf（如读外部队列深度）。抽样池 < 2 时诚实
   * 回退 argmax。挂载内核（Gittins/Whittle/BwK）或画像前沿优先于本
   * 模式（先挂先得，与既有梯次一致）。未挂载：argmax 路径逐位不变。
   */
  attachP2C(options?: P2COptions): void {
    this.p2c = {
      loadOf: options?.loadOf,
      random: options?.random ?? Math.random,
      scoreGate: Math.min(1, Math.max(0, options?.scoreGate ?? 0.8)),
    };
    this.lastP2c = undefined;
  }

  /** A3-2：断开 P2C（诊断/回退口径） */
  detachP2C(): void {
    this.p2c = undefined;
    this.lastP2c = undefined;
  }

  /** A3-2：最近一次 P2C 决策（两候 + 负载读数 + 胜者；纯读取） */
  lastP2CDecision(): P2CDecision | undefined {
    return this.lastP2c ? { ...this.lastP2c } : undefined;
  }

  /** A3-2：模型负载读数（注入优先；缺省运行时归一利用率，防御钳非负） */
  private modelLoadOf(modelId: string): number {
    if (this.p2c?.loadOf) {
      const v = this.p2c.loadOf(modelId);
      return Number.isFinite(v) && v > 0 ? v : 0;
    }
    const st = this.llm.getModelStatuses().find((s) => s.id === modelId);
    if (!st) return 0;
    return st.maxConcurrency > 0 ? st.activeRequests / st.maxConcurrency : st.activeRequests;
  }

  /** A3-2：评分候选上的两次选择幂（未挂载/池 < 2 返回 undefined → argmax） */
  private pickByP2C<T extends { id: string; total: number }>(scored: T[]): T | undefined {
    const p = this.p2c;
    if (!p || scored.length < 2) return undefined;
    this.lastP2c = undefined;
    const maxTotal = scored.reduce((m, s) => Math.max(m, s.total), Number.NEGATIVE_INFINITY);
    const pool = scored.filter((s) => s.total >= p.scoreGate * maxTotal);
    if (pool.length < 2) return undefined; // 一枝独秀 → 诚实回退 argmax
    const draw = () => Math.min(pool.length - 1, Math.floor(p.random() * pool.length));
    const i = draw();
    let j = draw();
    let guard = 0;
    while (j === i && guard < 8) {
      j = draw();
      guard += 1;
    }
    if (j === i) j = (i + 1) % pool.length; // 防御：退化随机源下确定性错开
    const a = pool[i]!;
    const b = pool[j]!;
    const loadA = this.modelLoadOf(a.id);
    const loadB = this.modelLoadOf(b.id);
    const chosen = loadA <= loadB ? a : b;
    this.lastP2c = { aId: a.id, bId: b.id, loadA, loadB, chosenId: chosen.id };
    return chosen;
  }

  // ─────────────────── A3-3：成本画像选择 ───────────────────

  /**
   * A3-3：绑定任务类别的成本画像（'*' = 兜底绑定；幂等覆盖）。
   *
   * 解析次序：精确 taskType 匹配 → '*' → 未绑定。绑定后动态选型按画像
   * 取向：挂载 67.0 Pareto 前沿时在前沿上选点（quality → min 风险、
   * cost → min 成本、balanced → 归一化风险-成本平面距理想点最近）；
   * 未挂载前沿则退化既有评分路径（quality → costWeight=0、cost → =1、
   * balanced → 原参数逐位不动）。未绑定任何画像 = 全路径零漂移。
   */
  bindCostProfile(taskType: string, profile: CostProfile): void {
    if (!taskType) return; // 防御：空类别不可绑定
    this.costProfiles.set(taskType, profile);
  }

  /** A3-3：解除画像绑定（带参 = 解除单类别；无参 = 清空全部绑定） */
  clearCostProfile(taskType?: string): void {
    if (taskType === undefined) this.costProfiles.clear();
    else this.costProfiles.delete(taskType);
  }

  /** A3-3：任务类别的生效画像（精确 → '*' 兜底 → undefined；纯读取） */
  costProfileOf(taskType: string): CostProfile | undefined {
    return this.costProfiles.get(taskType) ?? this.costProfiles.get('*');
  }

  /**
   * A3-3：画像 × Pareto 前沿选型（绑定画像且挂载 67.0 视图时生效；
   * 未绑定 / 未挂载 / 前沿不可用返回 undefined → 既有路径，零漂移）。
   */
  private selectWithCostProfile(taskType: string): SchedulingInsight | undefined {
    const profile = this.costProfileOf(taskType);
    if (!profile || !this.paretoFrontEnabled) return undefined;
    const view = this.paretoFrontView(taskType);
    if (!view) return undefined;
    const frontPts = view.frontIds
      .map((id) => view.points.find((p) => p.id === id))
      .filter((p): p is { id: string; risk: number; cost: number; latency: number } => p !== undefined);
    if (frontPts.length === 0) return undefined;
    let chosen = frontPts[0]!;
    let why = '';
    if (profile === 'quality') {
      chosen = frontPts.reduce((a, b) =>
        b.risk < a.risk - 1e-12 || (Math.abs(b.risk - a.risk) <= 1e-12 && b.cost < a.cost - 1e-12) ? b : a,
      );
      why = `min 风险 ${chosen.risk.toFixed(3)}`;
    } else if (profile === 'cost') {
      chosen = frontPts.reduce((a, b) =>
        b.cost < a.cost - 1e-12 || (Math.abs(b.cost - a.cost) <= 1e-12 && b.risk < a.risk - 1e-12) ? b : a,
      );
      why = `min 成本 ${chosen.cost.toFixed(0)} tok/次`;
    } else {
      // balanced：归一化 (风险, 成本) 平面距理想点（两维各自最小值）最近
      // ——「多花 2 分钱省多少风险」的均衡拐点（非边界点偏科）
      const minRisk = Math.min(...frontPts.map((p) => p.risk));
      const maxRisk = Math.max(...frontPts.map((p) => p.risk));
      const minCost = Math.min(...frontPts.map((p) => p.cost));
      const maxCost = Math.max(...frontPts.map((p) => p.cost));
      const rangeRisk = Math.max(1e-12, maxRisk - minRisk);
      const rangeCost = Math.max(1e-12, maxCost - minCost);
      let bestDist = Number.POSITIVE_INFINITY;
      for (const p of frontPts) {
        const nr = (p.risk - minRisk) / rangeRisk;
        const nc = (p.cost - minCost) / rangeCost;
        const dist = Math.sqrt(nr * nr + nc * nc);
        if (dist < bestDist - 1e-12) {
          bestDist = dist;
          chosen = p;
        }
      }
      why = `距理想点最近（归一化距离 ${bestDist.toFixed(3)}）`;
    }
    const estimate = this.memory.getBayesianEstimate(chosen.id, taskType);
    return {
      taskType,
      modelId: chosen.id,
      confidence: estimate ? estimate.posteriorMean : 0.5,
      exploration: false,
      effectiveSamples: estimate?.effectiveSamples ?? 0,
      rationale: `画像选择 ${chosen.id}（${profile} 画像 × Pareto 前沿 ${frontPts.length} 点：${why}；风险-成本-延迟三目标非支配菜单）`,
      economicMultiplier: this.economicMultiplierOf(chosen.id),
    };
  }

  // ─────────────────── A3-4：每模型重试预算 ───────────────────

  /**
   * A3-4：挂载重试预算（幂等覆盖 = 全新挂载，历史记账清零）。
   *
   * 滑动时间窗（windowMs）内每模型至多 maxRetriesPerModel 次重试：
   * admitRetry 原子校验并记账（窗口滑出自动失效）；超限拒纳并累计
   * 降级计数——调用方换模型。动态选型/pickFallbackModel 同步剔除
   * 窗口内配额耗尽的模型（超限降级换模型的全链落地）；全池超限为
   * 软闸门放行（预算是经济约束，不因预算阻断一切候选）。未挂载：
   * admitRetry 恒放行（旧行为）、选型零过滤——零漂移。
   */
  attachRetryBudget(options?: RetryBudgetOptions): void {
    this.retryBudgetState = {
      windowMs: Math.max(1, options?.windowMs ?? 60_000),
      maxRetries: Math.max(1, Math.floor(options?.maxRetriesPerModel ?? 3)),
      clock: options?.clock ?? Date.now,
      used: new Map(),
      degraded: new Map(),
    };
  }

  /** A3-4：断开重试预算（诊断/回退口径；记账清零） */
  detachRetryBudget(): void {
    this.retryBudgetState = undefined;
  }

  /**
   * A3-4：重试准入（原子校验 + 记账；未挂载恒放行且配额无穷——旧行为）。
   * @returns allowed= false 时窗口内配额已耗尽——降级换模型，degraded 已计数
   */
  admitRetry(modelId: string): RetryAdmission {
    const rb = this.retryBudgetState;
    if (!rb) return { allowed: true, used: 0, quota: Number.POSITIVE_INFINITY };
    const now = rb.clock();
    this.retryPrune(modelId, now);
    const list = rb.used.get(modelId) ?? [];
    if (list.length < rb.maxRetries) {
      list.push(now);
      rb.used.set(modelId, list);
      return { allowed: true, used: list.length, quota: rb.maxRetries };
    }
    rb.degraded.set(modelId, (rb.degraded.get(modelId) ?? 0) + 1);
    return { allowed: false, used: list.length, quota: rb.maxRetries };
  }

  /** A3-4：时间窗修剪（滑出窗的记账失效——内联私有，调用方已保证挂载） */
  private retryPrune(modelId: string, now: number): void {
    const rb = this.retryBudgetState;
    if (!rb) return;
    const list = rb.used.get(modelId);
    if (!list) return;
    const cutoff = now - rb.windowMs;
    const kept = list.filter((t) => t > cutoff);
    if (kept.length !== list.length) rb.used.set(modelId, kept);
  }

  /** A3-4：模型窗口内配额是否耗尽（未挂载恒 false） */
  private retryBudgetExhausted(modelId: string): boolean {
    const rb = this.retryBudgetState;
    if (!rb) return false;
    this.retryPrune(modelId, rb.clock());
    const list = rb.used.get(modelId);
    return list !== undefined && list.length >= rb.maxRetries;
  }

  /** A3-4：全模型重试预算读数（未挂载 undefined——诚实降级；含降级计数） */
  retryBudgetView(): RetryBudgetEntry[] | undefined {
    const rb = this.retryBudgetState;
    if (!rb) return undefined;
    const now = rb.clock();
    const ids = new Set<string>([
      ...this.llm.getModelStatuses().map((s) => s.id),
      ...rb.used.keys(),
      ...rb.degraded.keys(),
    ]);
    return [...ids].map((modelId) => {
      this.retryPrune(modelId, now);
      return {
        modelId,
        used: rb.used.get(modelId)?.length ?? 0,
        quota: rb.maxRetries,
        windowMs: rb.windowMs,
        degraded: rb.degraded.get(modelId) ?? 0,
      };
    });
  }

  // ─────────────────── A3-5：调度审计（旁路有界环形日志） ───────────────────

  /**
   * A3-5：挂载调度审计（幂等覆盖，环形日志清零重开）。
   *
   * 每次 assignModelWithInsight 决策（含推荐短路 / 内核选型 / 画像前沿 /
   * 评分 / P2C 路径）旁路记录：候选集（运营闸门过滤后）、健康快照、
   * 画像、决定路径与结论。纯旁路——对任何决策零影响；maxEntries 环形
   * 有界（缺省 128），内存不随决策数增长。未挂载：getSchedulingAudit()
   * undefined——零漂移。
   */
  attachSchedulingAudit(options?: { maxEntries?: number; clock?: () => number }): void {
    this.auditLog = {
      maxEntries: Math.max(1, Math.floor(options?.maxEntries ?? 128)),
      clock: options?.clock ?? Date.now,
      entries: [],
      nextSeq: 1,
    };
  }

  /** A3-5：调度审计导出（未挂载 undefined；浅拷贝防御外部篡改） */
  getSchedulingAudit(): SchedulingAuditEntry[] | undefined {
    const log = this.auditLog;
    if (!log) return undefined;
    return log.entries.map((e) => ({
      ...e,
      candidateIds: [...e.candidateIds],
      health: e.health ? { ...e.health } : undefined,
      retryUsed: e.retryUsed ? { ...e.retryUsed } : undefined,
    }));
  }

  /** A3-5：审计落账（旁路；未挂载零开销零介入） */
  private recordSchedulingAudit(
    taskType: string,
    candidateIds: string[],
    path: SchedulingAuditEntry['path'],
    chosenId: string,
    rationale: string,
    preferred?: string,
    notes?: { forcedProbeId?: string; relaxedRetry?: boolean },
    snapshotIds?: string[],
  ): void {
    const log = this.auditLog;
    if (!log) return;
    // 健康/预算快照覆盖过滤前候选全集（被运营闸门剔除的模型正是需要
    // 归因的对象——为何缺席比谁在场更重要）；候选集本体保持过滤后口径
    const snapshotOf = snapshotIds ?? candidateIds;
    let health: Record<string, CircuitBreakerState> | undefined;
    if (this.healthRouting) {
      const tracked: Record<string, CircuitBreakerState> = {};
      for (const id of snapshotOf) {
        const st = this.healthRouting.states.get(id)?.breaker;
        if (st !== undefined) tracked[id] = st;
      }
      if (Object.keys(tracked).length > 0) health = tracked;
    }
    let retryUsed: Record<string, number> | undefined;
    if (this.retryBudgetState) {
      const used: Record<string, number> = {};
      for (const id of snapshotOf) {
        this.retryPrune(id, this.retryBudgetState.clock());
        used[id] = this.retryBudgetState.used.get(id)?.length ?? 0;
      }
      retryUsed = used;
    }
    const entry: SchedulingAuditEntry = {
      seq: log.nextSeq,
      at: log.clock(),
      taskType,
      preferred,
      candidateIds: [...candidateIds],
      path,
      profile: this.costProfileOf(taskType),
      ...(health ? { health } : {}),
      ...(retryUsed ? { retryUsed } : {}),
      ...(notes?.forcedProbeId !== undefined ? { forcedProbe: notes.forcedProbeId } : {}),
      ...(notes?.relaxedRetry ? { relaxedRetry: true } : {}),
      chosenId,
      rationale,
    };
    log.nextSeq += 1;
    log.entries.push(entry);
    while (log.entries.length > log.maxEntries) log.entries.shift();
  }

  // ─────────────────── R4-1：集成组合优化（Condorcet 多数票组合选优） ───────────────────

  /**
   * R4-1：挂载集成组合优化（幂等覆盖，挂载即生效——咨询口径，不改变
   * assignModel 单模型路径；执行侧按需消费 composeEnsemble 的组合推荐）。
   *
   * 从「单模型推荐」升级为「组合推荐」：k 个成员独立投票、过半正确即
   * 组合正确的概率由 Poisson 二项分布精确给出（Condorcet 陪审团定理：
   * 三个略优于随机的独立投票者组合显著优于任一单体——0.6×3 → 0.648）。
   * 组合成本 = Σ 成员成本，budgetPerCall 为硬约束（预算收缩自动降规模）。
   * 小池全组合枚举（≤ enumerationLimit 组合数，全局最优）；大池诚实转
   * 贪心增量（结果保底不劣于最优单体）。候选过运营闸门（熔断/重试/
   * 准入），组合不会拼进一个病号。未挂载：composeEnsemble undefined。
   */
  attachEnsembleComposer(options?: EnsembleComposerOptions): void {
    this.ensembleComposer = {
      maxModels: Math.max(1, Math.min(8, Math.floor(options?.maxModels ?? 3))),
      budgetPerCall:
        options?.budgetPerCall !== undefined && Number.isFinite(options.budgetPerCall) && options.budgetPerCall > 0
          ? options.budgetPerCall
          : undefined,
      costPerCallOf: options?.costPerCallOf,
      qualityOf: options?.qualityOf,
      enumerationLimit: Math.max(8, Math.floor(options?.enumerationLimit ?? 512)),
    };
  }

  /** R4-1：断开集成组合优化（诊断/回退口径） */
  detachEnsembleComposer(): void {
    this.ensembleComposer = undefined;
  }

  /**
   * R4-1：组合推荐——预算内质量最优的成员组合（未挂载/无候选 undefined）。
   *
   * 质量口径缺省 = 贝叶斯后验均值（无画像 0.5 中性）；成本口径缺省 =
   * 运行时平均 token 消耗（无历史 600 兜底）；两者均可注入。求解：
   * Σ_{k=1..maxModels} C(n,k) ≤ enumerationLimit 时全枚举（质量降序、
   * 成本次之、id 字典序末位平局裁决——确定性）；否则贪心（最优单体
   * 起步、逐个吸纳最大质量增量成员）。返回含「组合 vs 最优单体」对照
   * （ensembleQuality ≥ bestSingleQuality 恒成立——组合选择空间包含单体）。
   */
  composeEnsemble(taskType: string, exclude: string[] = []): EnsembleComposition | undefined {
    const ec = this.ensembleComposer;
    if (!ec) return undefined;
    const exSet = new Set(exclude);
    const allStatuses = this.llm.getModelStatuses().filter((s) => !exSet.has(s.id));
    if (allStatuses.length === 0) return undefined;
    const { kept: statuses } = this.applyOperationalFilters(allStatuses);
    if (statuses.length === 0) return undefined;
    const cands = statuses
      .map((s) => ({
        id: s.id,
        q: (() => {
          if (ec.qualityOf) {
            const v = ec.qualityOf(s.id, taskType);
            return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
          }
          const est = this.memory.getBayesianEstimate(s.id, taskType);
          return est ? est.posteriorMean : 0.5;
        })(),
        c: (() => {
          if (ec.costPerCallOf) {
            const v = ec.costPerCallOf(s.id);
            return Number.isFinite(v) && v >= 0 ? v : 0;
          }
          return s.totalCalls > 0 ? s.totalTokensUsed / s.totalCalls : 600;
        })(),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // 枚举确定性序
    if (cands.length === 0) return undefined;
    const budget = ec.budgetPerCall;
    const bestSingle = cands.reduce((a, b) => (b.q > a.q + 1e-12 || (Math.abs(b.q - a.q) <= 1e-12 && b.c < a.c - 1e-12) ? b : a));
    const costOf = (ids: string[]): number => ids.reduce((sum, id) => sum + (cands.find((x) => x.id === id)?.c ?? 0), 0);
    const qualityOfCombo = (qs: number[]): number => ModelScheduler.majorityVoteQuality(qs);

    let comboCount = 0;
    for (let k = 1; k <= Math.min(ec.maxModels, cands.length); k += 1) {
      comboCount += binomial(cands.length, k);
    }
    let memberIds: string[];
    let mode: 'enumerate' | 'greedy';
    let searched: number;
    if (comboCount <= ec.enumerationLimit) {
      mode = 'enumerate';
      searched = 0;
      let bestQ = -1;
      let bestCost = Number.POSITIVE_INFINITY;
      let bestIds: string[] = [bestSingle.id];
      const current: number[] = [];
      const enumerate = (start: number): void => {
        if (current.length > 0) {
          searched += 1;
          const ids = current.map((i) => cands[i].id);
          const cost = costOf(ids);
          if (budget === undefined || cost <= budget + 1e-9) {
            const q = qualityOfCombo(current.map((i) => cands[i].q));
            if (q > bestQ + 1e-12 || (Math.abs(q - bestQ) <= 1e-12 && cost < bestCost - 1e-9)) {
              bestQ = q;
              bestCost = cost;
              bestIds = ids;
            }
          }
        }
        if (current.length >= Math.min(ec.maxModels, cands.length)) return;
        for (let i = start; i < cands.length; i += 1) {
          if (budget !== undefined && costOf([...current.map((x) => cands[x].id), cands[i].id]) > budget + 1e-9) continue;
          current.push(i);
          enumerate(i + 1);
          current.pop();
        }
      };
      enumerate(0);
      memberIds = bestIds;
    } else {
      mode = 'greedy';
      searched = 1;
      memberIds = budget !== undefined && bestSingle.c > budget ? [] : [bestSingle.id];
      let currentQ = memberIds.length > 0 ? qualityOfCombo([bestSingle.q]) : 0;
      while (memberIds.length < ec.maxModels) {
        let addId: string | undefined;
        let addQ = currentQ + 1e-12;
        let addCost = Number.POSITIVE_INFINITY;
        for (const cand of cands) {
          if (memberIds.includes(cand.id)) continue;
          if (budget !== undefined && costOf([...memberIds, cand.id]) > budget + 1e-9) continue;
          const q = qualityOfCombo([...memberIds.map((id) => cands.find((x) => x.id === id)!.q), cand.q]);
          if (q > addQ + 1e-12 || (Math.abs(q - addQ) <= 1e-12 && cand.c < addCost - 1e-9)) {
            addQ = q;
            addCost = cand.c;
            addId = cand.id;
          }
        }
        if (addId === undefined) break;
        memberIds.push(addId);
        currentQ = addQ;
        searched += 1;
      }
      if (memberIds.length === 0) memberIds = [bestSingle.id]; // 防御：预算连单体都装不下 → 单体兜底（诚实标注 withinBudget=false）
    }
    const totalCost = costOf(memberIds);
    const ensembleQuality = qualityOfCombo(memberIds.map((id) => cands.find((x) => x.id === id)!.q));
    return {
      memberIds,
      ensembleQuality,
      bestSingleQuality: bestSingle.q,
      bestSingleId: bestSingle.id,
      totalCost,
      withinBudget: budget === undefined || totalCost <= budget + 1e-9,
      searched,
      mode,
      rationale:
        `组合推荐 [${memberIds.join(', ')}]：多数票正确率 ${ensembleQuality.toFixed(4)}` +
        `（最优单体 ${bestSingle.id} ${bestSingle.q.toFixed(4)}，提升 ${(ensembleQuality - bestSingle.q >= 0 ? '+' : '') + (ensembleQuality - bestSingle.q).toFixed(4)}）；` +
        `总成本 ${totalCost.toFixed(1)}${budget !== undefined ? ` / 预算 ${budget.toFixed(1)}` : '（无预算约束）'}；` +
        `${mode === 'enumerate' ? `全枚举 ${searched} 组合` : `贪心 ${searched} 步（池超出枚举上限的诚实降级）`}`,
    };
  }

  /**
   * R4-1：多数票正确概率（Poisson 二项 DP——「正确票数」分布的精确卷积）。
   *
   * k 个独立投票者各以 p_i 正确：过半正确即组合正确；偶数票恰好并列时
   * 融合裁决按 0.5 权计（保守而对称）。三个 0.6 → 0.216+0.432 = 0.648。
   */
  private static majorityVoteQuality(qualities: number[]): number {
    let dist: number[] = [1];
    for (const q of qualities) {
      const next: number[] = new Array<number>(dist.length + 1).fill(0);
      for (let i = 0; i < dist.length; i += 1) {
        next[i] += dist[i] * (1 - q);
        next[i + 1] += dist[i] * q;
      }
      dist = next;
    }
    const k = dist.length - 1;
    let mass = 0;
    for (let i = 0; i <= k; i += 1) {
      if (i > k / 2) mass += dist[i];
      else if (k % 2 === 0 && i === k / 2) mass += 0.5 * dist[i];
    }
    return mass;
  }

  // ─────────────────── R4-2：预测性预热（负载趋势外推 → 预热建议） ───────────────────

  /**
   * R4-2：挂载预测性预热（幂等覆盖 = 全新挂载，需求流记账清零）。
   *
   * 任务需求流按时间桶记账（noteTaskDemand 每次需求到达 +1）：桶滚动
   * 时把完成的桶计数折入请求率 EWMA（空桶折 0——需求消失自然衰减）并
   * 追入趋势窗；prewarmSuggestions 对每个任务计算趋势窗最小二乘斜率，
   * 外推视野终点（horizonMs）的预测请求率——预测越线（≥ prewarmThreshold）
   * 且斜率为正的任务给出预热建议：该任务评分 top-N 模型（已过运营
   * 闸门）+ 预计穿越阈值时刻（etaAt/etaInMs）。建议先于峰值到达——
   * 执行侧可提前探活/预热连接。未挂载：noteTaskDemand 无去处、
   * prewarmSuggestions undefined——零漂移。
   */
  attachPrewarm(options?: PrewarmOptions): void {
    this.prewarmState = {
      bucketMs: Math.max(1, options?.bucketMs ?? 1_000),
      alpha: Math.min(1, Math.max(0, options?.ewmaAlpha ?? 0.4)),
      trendWindow: Math.max(2, Math.min(64, Math.floor(options?.trendWindow ?? 8))),
      horizonMs: Math.max(1, options?.horizonMs ?? 10_000),
      threshold: Math.max(0, options?.prewarmThreshold ?? 2),
      suggestModels: Math.max(1, Math.floor(options?.suggestModels ?? 3)),
      clock: options?.clock ?? Date.now,
      trackers: new Map(),
    };
  }

  /** R4-2：断开预测性预热（诊断/回退口径；记账清零） */
  detachPrewarm(): void {
    this.prewarmState = undefined;
  }

  /**
   * R4-2：需求到达记账（编排层/执行侧每次产生某类型任务时调用；未挂载
   * 诚实无操作）。时间桶跨期自动折算：跳过的空桶按 0 计入 EWMA 与趋势窗
   * （缺口封顶 trendWindow 桶，防御时钟跳跃撑爆历史数组）。
   */
  noteTaskDemand(taskType: string): void {
    const p = this.prewarmState;
    if (!p) return;
    const t = this.prewarmTrackerOf(taskType, p.clock());
    t.bucketCount += 1;
  }

  /** R4-2：需求追踪器惰性获取（跨期桶滚动：完成桶折入 EWMA + 趋势窗） */
  private prewarmTrackerOf(taskType: string, now: number): PrewarmTracker {
    const p = this.prewarmState!;
    let t = p.trackers.get(taskType);
    if (!t) {
      t = { bucketIndex: Math.floor(now / p.bucketMs), bucketCount: 0, ewmaRate: 0, hasRate: false, history: [] };
      p.trackers.set(taskType, t);
      return t;
    }
    const currentBucket = Math.floor(now / p.bucketMs);
    let guard = 0;
    while (t.bucketIndex < currentBucket && guard < p.trendWindow) {
      t.bucketIndex += 1;
      // 完成桶（含跳过的空桶）折入 EWMA 与趋势窗
      t.ewmaRate = t.hasRate ? (1 - p.alpha) * t.ewmaRate + p.alpha * t.bucketCount : t.bucketCount;
      t.hasRate = true;
      t.history.push(t.bucketCount);
      while (t.history.length > p.trendWindow) t.history.shift();
      t.bucketCount = 0;
      guard += 1;
    }
    if (t.bucketIndex < currentBucket) t.bucketIndex = currentBucket; // 时钟大跳：缺口封顶后直接对齐
    return t;
  }

  /**
   * R4-2：预热建议快照（未挂载 undefined；纯读取不改记账）。
   *
   * 对每个有需求历史的任务：趋势窗最小二乘斜率 × 视野桶数外推终点
   * 请求率；预测 ≥ 阈值且斜率 > 0 → 建议（top 模型 + 穿越时刻）。
   * 当前 EWMA 已在阈值上时 etaInMs = 0（峰值就在眼前）。
   */
  prewarmSuggestions(): PrewarmSuggestion[] | undefined {
    const p = this.prewarmState;
    if (!p) return undefined;
    const now = p.clock();
    const out: PrewarmSuggestion[] = [];
    for (const [taskType, raw] of p.trackers) {
      const t = this.prewarmTrackerOf(taskType, now); // 读前折算（惰性跨期）
      if (!t.hasRate || t.history.length < 2) continue;
      const hist = t.history.slice(-p.trendWindow);
      const n = hist.length;
      const xMean = (n - 1) / 2;
      const yMean = hist.reduce((s, v) => s + v, 0) / n;
      let num = 0;
      let den = 0;
      for (let i = 0; i < n; i += 1) {
        num += (i - xMean) * (hist[i] - yMean);
        den += (i - xMean) * (i - xMean);
      }
      const slope = den > 0 ? num / den : 0;
      const horizonBuckets = p.horizonMs / p.bucketMs;
      const projected = t.ewmaRate + slope * horizonBuckets;
      t.lastSuggestion = undefined;
      if (projected >= p.threshold && slope > 0) {
        const etaInMs = t.ewmaRate >= p.threshold ? 0 : Math.max(0, ((p.threshold - t.ewmaRate) / slope) * p.bucketMs);
        const modelIds = this.topModelIdsFor(taskType, p.suggestModels);
        const s: PrewarmSuggestion = {
          taskType,
          currentRate: t.ewmaRate,
          trendPerBucket: slope,
          projectedRate: projected,
          modelIds,
          etaAt: now + etaInMs,
          etaInMs,
          rationale:
            `负载上行：请求率 EWMA ${t.ewmaRate.toFixed(2)}/桶 + 斜率 ${slope.toFixed(2)}/桶 × ` +
            `${horizonBuckets.toFixed(0)} 桶视野 → 预测 ${projected.toFixed(2)}/桶 ≥ 阈值 ${p.threshold}` +
            `（${etaInMs <= 0 ? '峰值已在眼前' : `约 ${Math.round(etaInMs)}ms 后越线`}；建议预热 [${modelIds.join(', ')}] 探活/预热连接）`,
        };
        t.lastSuggestion = s;
        out.push(s);
      }
    }
    return out;
  }

  /** R4-2：任务类型评分 top-N 模型（运营闸门后按当前策略评分；内部口径） */
  private topModelIdsFor(taskType: string, n: number): string[] {
    const allStatuses = this.llm.getModelStatuses();
    if (allStatuses.length === 0) return [];
    const { kept: statuses } = this.applyOperationalFilters(allStatuses);
    if (statuses.length === 0) return [];
    const params = this.effectiveParams(taskType, undefined);
    return statuses
      .map((s) => ({ id: s.id, score: this.scoreModel(taskType, s, params) }))
      .sort((a, b) => (b.score - a.score !== 0 ? b.score - a.score : (a.id < b.id ? -1 : 1)))
      .slice(0, n)
      .map((r) => r.id);
  }

  // ─────────────────── R4-3：冷启动准入协议（影子 → 金丝雀 → 全量三阶段） ───────────────────

  /**
   * R4-3：挂载冷启动准入协议（幂等覆盖 = 全新挂载，在案试用清零）。
   *
   * 新模型接入必须显式 admitNewModel 登记试用，三阶段晋升：
   * - shadow（影子流量）：不进常规候选（影子请求由执行侧旁路喂），
   *   shadowMinSamples 个观察后均值 ≥ shadowQualityGate 晋级金丝雀；
   * - canary（小流量）：确定性时隙放行（canaryShare=0.2 → 每 5 次
   *   选型放行 1 次），canaryMinSamples 个观察后均值 ≥
   *   canaryQualityGate 毕业全量；
   * - graduated（全量毕业）：与既有模型同权入池。
   * 任一阶段均值 < ejectBelow（弹劾线）或试用总样本超 trialMaxSamples
   * 仍未晋级 → ejected 退场（永不入候选）。未登记模型不受协议约束
   * （既有行为逐位不动）；协议只在挂载后对已登记模型生效——零漂移。
   */
  attachAdmissionProtocol(options?: AdmissionProtocolOptions): void {
    this.admissionState = {
      shadowMinSamples: Math.max(1, Math.floor(options?.shadowMinSamples ?? 5)),
      shadowQualityGate: Math.min(1, Math.max(0, options?.shadowQualityGate ?? 0.5)),
      canaryMinSamples: Math.max(1, Math.floor(options?.canaryMinSamples ?? 5)),
      canaryQualityGate: Math.min(1, Math.max(0, options?.canaryQualityGate ?? 0.6)),
      ejectBelow: Math.min(1, Math.max(0, options?.ejectBelow ?? 0.35)),
      trialMaxSamples: Math.max(1, Math.floor(options?.trialMaxSamples ?? 50)),
      canaryShare: Math.min(1, Math.max(0.01, options?.canaryShare ?? 0.2)),
      clock: options?.clock ?? Date.now,
      records: new Map(),
    };
  }

  /** R4-3：断开准入协议（诊断/回退口径；在案试用清零） */
  detachAdmissionProtocol(): void {
    this.admissionState = undefined;
  }

  /**
   * R4-3：登记新模型进入试用期（幂等：已在案试用不重置——试用进展不可
   * 靠重复登记洗掉）。未注册模型防御性忽略。
   */
  admitNewModel(modelId: string): void {
    const a = this.admissionState;
    if (!a) return;
    if (!this.llm.getModel(modelId)) return;
    if (a.records.has(modelId)) return;
    a.records.set(modelId, {
      stage: 'shadow',
      shadowSamples: 0,
      canarySamples: 0,
      shadowQualitySum: 0,
      canaryQualitySum: 0,
      canaryCounter: 0,
      stageSince: a.clock(),
    });
  }

  /**
   * R4-3：试用结局回报（quality ∈ [0,1]，失败 = 0；影子/金丝雀流量均回
   * 喂此处；未登记/未挂载诚实无操作）。阶段机确定性推进：影子期满按
   * 均值晋级金丝雀/弹劾退场/续观察；金丝雀期满按均值毕业/退场。
   */
  reportTrialOutcome(modelId: string, quality: number): void {
    const a = this.admissionState;
    if (!a) return;
    const r = a.records.get(modelId);
    if (!r) return;
    const q = Math.min(1, Math.max(0, Number.isFinite(quality) ? quality : 0));
    const now = a.clock();
    if (r.stage === 'shadow') {
      r.shadowSamples += 1;
      r.shadowQualitySum += q;
      const mean = r.shadowQualitySum / r.shadowSamples;
      if (r.shadowSamples >= a.shadowMinSamples && mean < a.ejectBelow) {
        r.stage = 'ejected';
        r.settledAt = now;
      } else if (r.shadowSamples >= a.shadowMinSamples && mean >= a.shadowQualityGate) {
        r.stage = 'canary';
        r.stageSince = now;
      } else if (r.shadowSamples + r.canarySamples >= a.trialMaxSamples) {
        r.stage = 'ejected'; // 试用超期未晋级 → 退场（有界试用）
        r.settledAt = now;
      }
      return;
    }
    if (r.stage === 'canary') {
      r.canarySamples += 1;
      r.canaryQualitySum += q;
      const mean = r.canarySamples > 0 ? r.canaryQualitySum / r.canarySamples : 0;
      if (r.canarySamples >= a.canaryMinSamples && mean >= a.canaryQualityGate) {
        r.stage = 'graduated';
        r.settledAt = now;
      } else if (
        (r.canarySamples >= a.canaryMinSamples && mean < a.canaryQualityGate) ||
        r.shadowSamples + r.canarySamples >= a.trialMaxSamples
      ) {
        r.stage = 'ejected';
        r.settledAt = now;
      }
    }
  }

  /** R4-3：全部在案试用记录（未挂载 undefined——诚实降级；纯读取） */
  admissionView(): AdmissionRecord[] | undefined {
    const a = this.admissionState;
    if (!a) return undefined;
    const out: AdmissionRecord[] = [];
    for (const [modelId, r] of a.records) {
      const totalSamples = r.shadowSamples + r.canarySamples;
      const qualitySum = r.stage === 'shadow' ? r.shadowQualitySum : r.shadowQualitySum + r.canaryQualitySum;
      out.push({
        modelId,
        stage: r.stage,
        shadowSamples: r.shadowSamples,
        canarySamples: r.canarySamples,
        meanQuality: totalSamples > 0 ? qualitySum / totalSamples : 0.5,
        selectable: r.stage === 'graduated' || (r.stage === 'canary' && r.canaryCounter > 0 && r.canaryCounter % Math.max(1, Math.round(1 / a.canaryShare)) === 1),
        ...(r.settledAt !== undefined ? { settledAt: r.settledAt } : {}),
        rationale:
          r.stage === 'shadow'
            ? `影子期（${r.shadowSamples}/${a.shadowMinSamples} 观察，均值 ${(r.shadowSamples > 0 ? r.shadowQualitySum / r.shadowSamples : 0.5).toFixed(2)}，门 ${a.shadowQualityGate}）`
            : r.stage === 'canary'
              ? `金丝雀小流量（${r.canarySamples}/${a.canaryMinSamples} 观察，均值 ${(r.canarySamples > 0 ? r.canaryQualitySum / r.canarySamples : 0).toFixed(2)}，门 ${a.canaryQualityGate}，放行比例 ${a.canaryShare}）`
              : r.stage === 'graduated'
                ? `已毕业全量（试用 ${totalSamples} 观察）`
                : `已退场（试用 ${totalSamples} 观察未达门槛）`,
      });
    }
    return out;
  }

  /**
   * R4-3：选型资格裁决（内部口径；未挂载/未登记恒真——既有模型零约束）。
   * shadow 只吃影子流量不入候选；canary 按确定性 1-in-period 时隙放行
   * （counter 从 1 起：首查放行、此后每 period 次放行一次——可复现）；
   * graduated 恒真；ejected 恒假。
   */
  private admissionEligibleForSelection(modelId: string): boolean {
    const a = this.admissionState;
    if (!a) return true;
    const r = a.records.get(modelId);
    if (!r) return true;
    if (r.stage === 'graduated') return true;
    if (r.stage === 'ejected' || r.stage === 'shadow') return false;
    const period = Math.max(1, Math.round(1 / a.canaryShare));
    r.canaryCounter += 1;
    return r.canaryCounter % period === 1;
  }

  // ─────────────────── R4-4：成本漂移告警（基线带对照 + 重画像建议） ───────────────────

  /**
   * R4-4：挂载成本漂移哨兵（幂等覆盖 = 全新挂载，遥测清零）。
   *
   * 每模型 × 每口径（单位成本 / 时延）独立监测：前 baselineSamples 个
   * 观测的 EWMA 冻结为基线带；此后当前 EWMA 持续对照——相对偏离
   * |当前−基线|/基线 ≥ driftThreshold 即显著漂移（涨价 / 劣化），
   * driftAlerts() 输出活动告警 + 重画像建议（action='re-profile'：
   * 单价/时延结构已变，成本画像与 Pareto 视图需以新价重算）。
   * acknowledgeDrift(modelId, metric) 落地重画像：以当前值重立基线带
   * （新价成为新常态，告警自然清除）。未挂载：reportCostSample 无
   * 去处、driftAlerts undefined——零漂移。
   */
  attachDriftSentinel(options?: DriftSentinelOptions): void {
    this.driftSentinel = {
      baselineSamples: Math.max(1, Math.floor(options?.baselineSamples ?? 8)),
      alpha: Math.min(1, Math.max(0, options?.ewmaAlpha ?? 0.3)),
      threshold: Math.min(10, Math.max(0.01, options?.driftThreshold ?? 0.25)),
      clock: options?.clock ?? Date.now,
      trackers: new Map(),
    };
  }

  /** R4-4：断开成本漂移哨兵（诊断/回退口径；遥测清零） */
  detachDriftSentinel(): void {
    this.driftSentinel = undefined;
  }

  /**
   * R4-4：成本/时延遥测回报（口径任选其一或同时；未挂载诚实无操作）。
   * 成本口径 = 单位成本（如每调用 token 或货币成本），时延口径 = 毫秒。
   */
  reportCostSample(modelId: string, sample: { costPerCall?: number; latencyMs?: number }): void {
    const d = this.driftSentinel;
    if (!d) return;
    const now = d.clock();
    if (typeof sample.costPerCall === 'number' && Number.isFinite(sample.costPerCall) && sample.costPerCall > 0) {
      this.driftUpdate(`${modelId}::costPerCall`, modelId, 'costPerCall', sample.costPerCall, now);
    }
    if (typeof sample.latencyMs === 'number' && Number.isFinite(sample.latencyMs) && sample.latencyMs > 0) {
      this.driftUpdate(`${modelId}::latencyMs`, modelId, 'latencyMs', sample.latencyMs, now);
    }
  }

  /** R4-4：单追踪器更新（基线窗冻结 + 当前 EWMA + 越线时刻入账） */
  private driftUpdate(key: string, modelId: string, metric: 'costPerCall' | 'latencyMs', value: number, now: number): void {
    const d = this.driftSentinel!;
    let t = d.trackers.get(key);
    if (!t) {
      t = { metric, baseline: value, current: value, count: 0, hasValue: false };
      d.trackers.set(key, t);
    }
    t.count += 1;
    if (t.count <= d.baselineSamples) {
      t.baseline = t.count === 1 ? value : (1 - d.alpha) * t.baseline + d.alpha * value;
      t.current = t.baseline;
      t.hasValue = true;
      return;
    }
    t.current = (1 - d.alpha) * t.current + d.alpha * value;
    if (t.baseline > 0 && Math.abs(t.current - t.baseline) / t.baseline >= d.threshold && t.firstBreachedAt === undefined) {
      t.firstBreachedAt = now;
    }
  }

  /** R4-4：活动漂移告警快照（未挂载 undefined；纯读取——条件仍在则报） */
  driftAlerts(): DriftAlert[] | undefined {
    const d = this.driftSentinel;
    if (!d) return undefined;
    const out: DriftAlert[] = [];
    for (const [key, t] of d.trackers) {
      if (t.count <= d.baselineSamples || !t.hasValue || t.baseline <= 0) continue;
      const rel = (t.current - t.baseline) / t.baseline;
      if (Math.abs(rel) >= d.threshold) {
        const modelId = key.split('::')[0];
        out.push({
          modelId,
          metric: t.metric,
          baseline: t.baseline,
          current: t.current,
          relativeDrift: rel,
          action: 're-profile',
          firstBreachedAt: t.firstBreachedAt ?? d.clock(),
        });
      }
    }
    return out;
  }

  /**
   * R4-4：确认漂移并落地重画像（以当前 EWMA 重立基线带——新价/新时延
   * 成为新常态，该条告警清除；未挂载/无遥测诚实无操作）。
   */
  acknowledgeDrift(modelId: string, metric: 'costPerCall' | 'latencyMs'): void {
    const d = this.driftSentinel;
    if (!d) return;
    const t = d.trackers.get(`${modelId}::${metric}`);
    if (!t) return;
    t.baseline = t.current;
    t.firstBreachedAt = undefined;
  }

  // ─────────────────── R4-5：模型特长画像（任务维度质量矩阵加权） ───────────────────

  /**
   * R4-5：挂载模型特长画像（幂等覆盖，挂载即生效；未回报样本前全中性）。
   *
   * 「模型 × 任务类型」质量矩阵（reportSpecialtyOutcome 回喂 EMA）自动
   * 发现专长结构：单元均值 − 0.5 的偏差经 strength 放大为有界乘数
   * （[2−cap, cap]，缺省 [0.5,1.5]）作用于利用端评分——通才评分之下
   * 埋着专才结构：code 强 doc 弱的模型在 code 任务上升权、在 doc 任务
   * 上降权。样本 < minSamples 恒中性 1（孤证不改推荐）。未挂载：乘数
   * 恒 1、specialtyView undefined——评分路径逐位零漂移。
   */
  attachSpecialtyMatrix(options?: SpecialtyMatrixOptions): void {
    const cap = Math.max(1, Math.min(2, options?.multiplierCap ?? 1.5));
    this.specialtyMatrix = {
      alpha: Math.min(1, Math.max(0, options?.emaAlpha ?? 0.2)),
      strength: Math.max(0, options?.strength ?? 0.8),
      cap,
      minSamples: Math.max(1, Math.floor(options?.minSamples ?? 3)),
      cells: new Map(),
    };
  }

  /** R4-5：断开特长画像（诊断/回退口径；矩阵清零） */
  detachSpecialtyMatrix(): void {
    this.specialtyMatrix = undefined;
  }

  /**
   * R4-5：特长样本回喂（quality ∈ [0,1]，失败 = 0；未挂载诚实无操作）。
   * 执行侧每次调用终态按任务类型回喂——矩阵随证据积累长出特长结构。
   */
  reportSpecialtyOutcome(modelId: string, taskType: string, quality: number): void {
    const m = this.specialtyMatrix;
    if (!m) return;
    const q = Math.min(1, Math.max(0, Number.isFinite(quality) ? quality : 0));
    const key = `${modelId}::${taskType}`;
    let cell = m.cells.get(key);
    if (!cell) {
      cell = { mean: q, samples: 0 };
      m.cells.set(key, cell);
    }
    cell.samples += 1;
    cell.mean = cell.samples === 1 ? q : (1 - m.alpha) * cell.mean + m.alpha * q;
  }

  /**
   * R4-5：特长乘数（未挂载/样本不足恒 1——零漂移；均值 0.5 恰为 1）。
   * 乘数 = clamp(1 + strength × (均值 − 0.5), 2−cap, cap)。
   */
  specialtyMultiplierOf(modelId: string, taskType: string): number {
    const m = this.specialtyMatrix;
    if (!m) return 1;
    const cell = m.cells.get(`${modelId}::${taskType}`);
    if (!cell || cell.samples < m.minSamples) return 1;
    const raw = 1 + m.strength * (cell.mean - 0.5);
    return Math.min(m.cap, Math.max(2 - m.cap, raw));
  }

  /** R4-5：特长矩阵快照（未挂载 undefined；纯读取） */
  specialtyView(): SpecialtyEntry[] | undefined {
    const m = this.specialtyMatrix;
    if (!m) return undefined;
    const out: SpecialtyEntry[] = [];
    for (const [key, cell] of m.cells) {
      const sep = key.indexOf('::');
      out.push({
        modelId: key.slice(0, sep),
        taskType: key.slice(sep + 2),
        meanQuality: cell.mean,
        samples: cell.samples,
        multiplier: this.specialtyMultiplierOf(key.slice(0, sep), key.slice(sep + 2)),
      });
    }
    return out;
  }

  // ─────────────────── A3-1/A3-4：运营闸门（候选过滤总入口） ───────────────────

  /**
   * A3-1/A3-4：运营闸门过滤（未挂载两者时逐位透传——零漂移）。
   *
   * 健康闸门剔除熔断中模型（惰性转半开 + 探针槽检查）；全池熔断时最早
   * 熔断者强制转半开探活（冷却最久 = 最可能已恢复；永不因健康闸门
   * 抛新错）。重试闸门剔除窗口内配额耗尽模型；全池超限软放行。两类
   * 降级（forcedProbe / relaxedRetry）经审计导出可观测。
   */
  private applyOperationalFilters<T extends { id: string }>(
    items: T[],
  ): { kept: T[]; forcedProbeId?: string; relaxedRetry?: boolean } {
    if (!this.healthRouting && !this.retryBudgetState && !this.admissionState) return { kept: items };
    let afterHealth = items;
    let forcedProbeId: string | undefined;
    if (this.healthRouting) {
      const now = this.healthRouting.clock();
      afterHealth = items.filter((it) => this.healthEligible(it.id, now));
      if (afterHealth.length === 0 && items.length > 0) {
        const tracked = items.filter((it) => this.healthRouting!.states.has(it.id));
        if (tracked.length > 0) {
          // 全池熔断降级：open 态中 openAt 最早者强制转半开探活
          let earliest = tracked[0]!;
          for (const it of tracked) {
            const a = this.healthRouting!.states.get(earliest.id)!;
            const b = this.healthRouting!.states.get(it.id)!;
            const ta = a.breaker === 'open' ? a.openAt ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
            const tb = b.breaker === 'open' ? b.openAt ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
            if (tb < ta) earliest = it;
          }
          const st = this.healthRouting!.states.get(earliest.id)!;
          st.breaker = 'half-open';
          st.probeInFlight = false;
          st.probeStartedAt = undefined;
          afterHealth = [earliest];
          forcedProbeId = earliest.id;
        }
      }
    }
    // R4-3：准入闸门（影子/退场模型不入候选；金丝雀按确定性时隙放行；
    // 全池被准入闸拦空时软放行：优先影子期模型兜底（ejected 仍出局），
    // 彼此仍空则原池透传——准入协议不因闸门抛新错（与 forcedProbe/relaxedRetry 同一纪律）
    let afterAdmission = afterHealth;
    if (this.admissionState && afterHealth.length > 0) {
      const admitted = afterHealth.filter((it) => this.admissionEligibleForSelection(it.id));
      if (admitted.length > 0) {
        afterAdmission = admitted;
      } else {
        const shadowOnly = afterHealth.filter((it) => this.admissionState!.records.get(it.id)?.stage === 'shadow');
        afterAdmission = shadowOnly.length > 0 ? shadowOnly : afterHealth;
      }
    }
    let kept = afterAdmission;
    let relaxedRetry = false;
    if (this.retryBudgetState && afterAdmission.length > 0) {
      const filtered = afterAdmission.filter((it) => !this.retryBudgetExhausted(it.id));
      if (filtered.length > 0) {
        kept = filtered;
      } else {
        relaxedRetry = true; // 全池超限：软闸门放行（预算不阻断一切）
      }
    }
    return { kept, forcedProbeId, relaxedRetry };
  }

  /** 模型的当前经济乘数（无信号 = 中性 1；economicFeedbackEnabled 关闭时恒为 1） */
  economicMultiplierOf(modelId: string): number {
    if (this.config.economicFeedbackEnabled !== true) return 1;
    return this.economicMultipliers.get(modelId) ?? 1;
  }

  /**
   * 策略热切换（第三阶段：策略进化器部署入口）
   *
   * 由 PolicyEvolver.deployPolicy → onDeploy 回调调用；
   * 替换评分函数参数集，立即对后续 assignModel 生效，无需重启。
   */
  updatePolicy(policy: Policy): void {
    this.currentPolicy = { ...policy, params: { ...policy.params } };
  }

  /** 当前生效策略（供优化器标注策略版本） */
  getPolicy(): Policy {
    return { ...this.currentPolicy, params: { ...this.currentPolicy.params } };
  }

  /** 解析上下文有效参数（规则基因组匹配；无规则时即基础参数） */
  private effectiveParams(taskType: string, context?: SchedulerTaskContext): SchedulerPolicyParams {
    const params = resolveEffectiveParams(this.currentPolicy.params, {
      taskType,
      complexity: context?.complexity,
      features: context?.features,
    });
    // A3-3：画像退化路径——未挂载 Pareto 前沿（或前沿不可用）时，画像
    // 透传为既有评分的成本权重取向（balanced / 未绑定 = 原参数逐位不动）
    const profile = this.costProfileOf(taskType);
    if (profile === 'quality') return { ...params, costWeight: 0 };
    if (profile === 'cost') return { ...params, costWeight: 1 };
    return params;
  }

  /** 单模型评分（2.0：贝叶斯证据装配——Wilson 下界 + 有效样本量 + 质量 EMA） */
  private scoreModel(
    taskType: string,
    status: { id: string; taskScores: Record<string, number>; totalCalls: number; totalTokensUsed: number },
    params: SchedulerPolicyParams,
  ): number {
    const estimate = this.memory.getBayesianEstimate(status.id, taskType);
    const base = scoreModelWithPolicy(params, {
      taskScore: status.taskScores[taskType] ?? status.taskScores['general'] ?? 0.5,
      // 2.0 质变：裸成功率 → Wilson 下界（3 次全成 ≈ 0.40，300 次全成 ≈ 0.95，
      // 小样本自动保守；杜绝「3/3 成功」压过「290/300 稳健」的小数点幻觉）
      memoryScore: estimate ? estimate.wilsonLower : 0.5,
      // 2.0：memoryCalls 用有效样本量（时间衰减后的等效观测数，旧证据自然让位）
      memoryCalls: estimate ? Math.round(estimate.effectiveSamples) : 0,
      avgQuality: estimate?.emaQuality || 0.5,
      avgTokens: status.totalCalls > 0 ? status.totalTokensUsed / status.totalCalls : 0,
    });
    // B 路线：共生经济乘数作用于利用端（UCB 探索加成不乘——信息价值
    // 高于短期经济；关闭/无信号时恒为 1，评分与原逻辑逐位一致）
    // 31.0：对抗组合乘数叠加同位（有界 [0.25,4]；未挂载恒 1，零漂移）
    // A3-1：健康乘数再叠加同位（EWMA 错误率折价；未挂载恒 1，零漂移）
    // R4-5：特长乘数再叠加同位（任务类型维度的特长加权；未挂载/样本不足恒 1，零漂移）
    return (
      base *
      this.economicMultiplierOf(status.id) *
      this.hedgeMultiplierOf(status.id) *
      this.healthMultiplierOf(status.id) *
      this.specialtyMultiplierOf(status.id, taskType)
    );
  }

  /**
   * 全候选评分（2.0：利用端策略评分 + UCB 探索加成）
   *
   * 探索/利用权衡（解决裸计数调度的两个死局）：
   * - 冷启动死局：新模型 0 样本得中性分 0.5，永远竞争不过平庸但样本多的模型
   * - 埋没死局：模型早期失败后，即使能力已修复也永无翻身机会
   *
   * UCB 加成 = exploreBonus × sqrt(log(1+ΣN) / (1+n_i))：
   * 样本越少加成越大（信息价值高）；仅冷启动期（ΣN < exploreBudget）
   * 生效，且有效样本 ≥ exploreSampleFloor 的模型不加成（纯利用）。
   */
  private scoreCandidates(
    taskType: string,
    context: SchedulerTaskContext | undefined,
    statuses: Array<{ id: string; taskScores: Record<string, number>; totalCalls: number; totalTokensUsed: number }>,
  ): Array<{ id: string; base: number; bonus: number; total: number; estimate?: BayesianEstimate; efe?: EFEEvaluation }> {
    const params = this.effectiveParams(taskType, context);
    const scored: Array<{ id: string; base: number; bonus: number; total: number; estimate?: BayesianEstimate; efe?: EFEEvaluation }> = statuses.map((status) => {
      const estimate = this.memory.getBayesianEstimate(status.id, taskType);
      const base = this.scoreModel(taskType, status, params);
      return { id: status.id, base, bonus: 0, total: base, estimate };
    });

    // 6.0：主动推断模式——期望自由能统一探索/利用（启用且挂载引擎时
    // 完全替换 UCB 路径；探索预算由证据量内生，无需手设常数）。
    // total = −G(a)：G 越低（既预测有用又可能学到东西）total 越高；
    // bonus = 认知价值（nat），供洞察层标注「这次选择有多少是想弄清」。
    if (this.config.freeEnergyEnabled === true && this.freeEnergy) {
      const preference = this.config.freeEnergyPreference ?? 0.9;
      const actions: EFEAction[] = scored.map((s) => {
        const est = s.estimate;
        const mean = est ? est.posteriorMean : 0.5;
        const lower = est ? est.wilsonLower : 0;
        return {
          id: s.id,
          pSuccess: mean,
          lower,
          // 区间上界镜像估计（Wilson 上界近似：均值 + (均值 − 下界)）
          upper: Math.min(1, mean + Math.max(0, mean - lower)),
          // 调度器的刻意选型 = do 干预证据（与共生结算登记同源）
          interventionalSamples: est ? est.effectiveSamples : 0,
          observationalSamples: 0,
        };
      });
      const evals = this.freeEnergy.evaluateActions(actions, preference);
      const byId = new Map(evals.map((e) => [e.actionId, e]));
      for (const s of scored) {
        const e = byId.get(s.id);
        if (!e) continue;
        s.efe = e;
        s.total = -e.efe;
        s.bonus = e.epistemic;
      }
      return scored;
    }

    const explorationOn = this.config.explorationEnabled !== false;
    const bonusWeight = this.config.exploreBonus ?? 0.08;
    const sampleFloor = this.config.exploreSampleFloor ?? 5;
    const exploreBudget = this.config.exploreBudget ?? 30;
    if (explorationOn && bonusWeight > 0) {
      const totalN = scored.reduce((sum, s) => sum + (s.estimate?.effectiveSamples ?? 0), 0);
      // 冷启动探索期：总证据不足预算时才探索（证据充足后纯利用端决策）
      if (totalN < exploreBudget) {
        for (const s of scored) {
          const n = s.estimate?.effectiveSamples ?? 0;
          if (n >= sampleFloor) continue;
          s.bonus = bonusWeight * Math.sqrt(Math.log(1 + totalN + scored.length) / (1 + n));
          s.total = s.base + s.bonus;
        }
      }
    }
    return scored;
  }

  /** 所选模型的决策洞察（预测置信度 + 探索标记 + 依据说明） */
  private insightOf(
    taskType: string,
    chosen: { id: string; base: number; bonus: number; total: number; estimate?: BayesianEstimate; efe?: EFEEvaluation } | undefined,
    preferredUsed: boolean,
    scored?: Array<{ id: string; base: number; efe?: EFEEvaluation }>,
  ): SchedulingInsight {
    const estimate = chosen?.estimate;
    // 6.0：EFE 模式洞察——自由能分解直接进决策依据
    if (chosen?.efe && this.config.freeEnergyEnabled === true && this.freeEnergy) {
      const e = chosen.efe;
      // 探索的主动推断语义：存在「纯利用端不劣于所选」的对手（务实值 ≤ 所选，
      // 认知价值≈0 的既知者）却输给了所选的认知价值 → 这次选择是为学而选
      const pragmaticRival = (scored ?? []).find(
        (s) => s.efe && s.id !== chosen.id && s.efe.pragmatic <= e.pragmatic + 1e-9,
      );
      const exploration = e.epistemic > 0.03 && pragmaticRival !== undefined;
      return {
        taskType,
        modelId: chosen.id,
        confidence: estimate ? estimate.posteriorMean : 0.5,
        exploration,
        effectiveSamples: estimate?.effectiveSamples ?? 0,
        rationale: `主动推断选择 ${chosen.id}（EFE ${e.efe.toFixed(3)} = 务实 ${e.pragmatic.toFixed(3)} − 认知 ${e.epistemic.toFixed(3)} nat；好奇占比 ${Math.round(e.curiosityShare * 100)}%，Boltzmann ${(e.boltzmannProb * 100).toFixed(1)}%）`,
        economicMultiplier: this.economicMultiplierOf(chosen.id),
      };
    }
    // 探索胜出 = 探索加成把非利用端最优的模型推上榜首（信息价值驱动的主动重估）
    const bestBaseId = scored && scored.length > 0 ? scored.reduce((a, b) => (b.base > a.base ? b : a)).id : undefined;
    const exploration = Boolean(!preferredUsed && chosen && chosen.bonus > 0 && bestBaseId !== undefined && chosen.id !== bestBaseId);
    return {
      taskType,
      modelId: chosen?.id ?? '',
      confidence: estimate ? estimate.posteriorMean : 0.5,
      exploration,
      effectiveSamples: estimate?.effectiveSamples ?? 0,
      rationale: preferredUsed
        ? `优先采用推荐模型 ${chosen?.id}（优化器经验推荐，贝叶斯置信度 ${estimate ? estimate.posteriorMean.toFixed(2) : '0.50'}）`
        : exploration
          ? `探索性选择 ${chosen?.id}（利用分 ${chosen!.base.toFixed(3)} + UCB 加成 ${chosen!.bonus.toFixed(3)}，有效样本 ${estimate?.effectiveSamples.toFixed(1) ?? '0'} < ${this.config.exploreSampleFloor ?? 5}，收集证据中）`
          : `利用端最优 ${chosen?.id}（策略评分 ${chosen?.base.toFixed(3)}，贝叶斯下界 ${estimate ? estimate.wilsonLower.toFixed(2) : '-'}，有效样本 ${estimate?.effectiveSamples.toFixed(1) ?? '0'}）`,
      // B 路线：经济乘数进洞察（非中性时标注，供反思器归因调度偏差来源）
      economicMultiplier: this.economicMultiplierOf(chosen?.id ?? ''),
    };
  }

  /** 所选模型的贝叶斯置信度（重试切换后由执行器刷新洞察用） */
  modelInsight(taskType: string, modelId: string): SchedulingInsight {
    const estimate = this.memory.getBayesianEstimate(modelId, taskType);
    return {
      taskType,
      modelId,
      confidence: estimate ? estimate.posteriorMean : 0.5,
      exploration: false,
      effectiveSamples: estimate?.effectiveSamples ?? 0,
      rationale: `切换至 ${modelId}（贝叶斯后验 ${estimate ? estimate.posteriorMean.toFixed(2) : '0.50'}，下界 ${estimate ? estimate.wilsonLower.toFixed(2) : '-'}）`,
    };
  }

  /**
   * 21.0/22.0：已挂载数学内核的候选选型（零漂移守卫——未挂载/预算
   * 不可用时返回 undefined，调用方走原路径，行为与升级前逐位一致）。
   *
   * 优先级：indexScheduler（可证明最优的 Gittins 索引口径）>
   * bwKRouter（预算约束下的 BwK 路由）> 原评分路径。两条内核路径均
   * 保持 preferred 短路与 avoidModels 剔除之后的候选集语义。
   */
  private selectWithAttachedKernels(
    taskType: string,
    statuses: Array<{ id: string; totalCalls: number; totalTokensUsed: number; totalCost?: number }>,
  ): SchedulingInsight | undefined {
    // 21.0：Gittins 索引调度——对每个候选的 Beta(α,β) 后验精确计算
    // 折扣 bandit 最优索引（退休 MDP 三角形反向归纳），学习溢价随
    // 证据积累自动归零（探索自我终结）。熔断/健康状态此处不可得，
    // 可用性恒 1（候选集已由调用方按 avoid/注册态过滤）。
    if (this.indexScheduler) {
      const arms: IndexArm[] = statuses.map((status) => {
        const estimate = this.memory.getBayesianEstimate(status.id, taskType);
        return {
          id: status.id,
          // Beta(α,β) 含均匀先验：成功/失败计数 = α−1 / β−1（无画像即 0/0）
          successes: estimate ? estimate.alpha - 1 : 0,
          failures: estimate ? estimate.beta - 1 : 0,
          availability: 1,
        };
      });
      const ranked: ArmIndex[] = this.indexScheduler.rank(arms);
      const chosen = ranked[0];
      if (chosen) {
        const estimate = this.memory.getBayesianEstimate(chosen.id, taskType);
        // 探索语义：学习溢价显著且选中者并非后验均值最高（为学而选）
        const bestMeanId = ranked.reduce((a, b) => (b.posteriorMean > a.posteriorMean ? b : a)).id;
        const exploration = chosen.learningPremium > 0.03 && chosen.id !== bestMeanId;
        this.lastKernelPath = 'gittins';
        return {
          taskType,
          modelId: chosen.id,
          confidence: estimate ? estimate.posteriorMean : 0.5,
          exploration,
          effectiveSamples: estimate?.effectiveSamples ?? 0,
          rationale: exploration
            ? `探索性选择 ${chosen.id}（Gittins 索引 ${chosen.effectiveIndex.toFixed(3)}（学习溢价 ${chosen.learningPremium.toFixed(3)}）@${chosen.rank} 位，后验均值 ${chosen.posteriorMean.toFixed(3)} 非最高，不确定性溢价驱动重估）`
            : `索引最优 ${chosen.id}（Gittins 索引 ${chosen.effectiveIndex.toFixed(3)}（学习溢价 ${chosen.learningPremium.toFixed(3)}）@${chosen.rank} 位，后验均值 ${chosen.posteriorMean.toFixed(3)}，有效样本 ${estimate?.effectiveSamples.toFixed(1) ?? '0'}）`,
          economicMultiplier: this.economicMultiplierOf(chosen.id),
        };
      }
      return undefined; // 防御：无可排名臂时走原路径
    }

    // 53.0：Whittle 指数调度——候选模型作为不休眠两态臂（good/bad 由后验
    // 阈值化，主动修复/被动恶化由后验遥测估计，适配层显式缺省可覆盖），
    // 精确解出各态指数取榜首。不可索引 / 未收敛 / 数值防御失败时诚实
    // 回退（undefined → 原评分路径，零漂移）。优先级低于 21.0（先挂先得）。
    if (this.whittleOptions) {
      const result = whittleSchedule(
        statuses.map((status) => {
          const estimate = this.memory.getBayesianEstimate(status.id, taskType);
          return { id: status.id, posteriorMean: estimate ? estimate.posteriorMean : 0.5 };
        }),
        1,
        this.whittleOptions,
      );
      const top = result?.ranked.find((e) => e.selected);
      if (result && top && result.allConverged && result.nonIndexableIds.length === 0) {
        const estimate = this.memory.getBayesianEstimate(top.id, taskType);
        this.lastKernelPath = 'whittle';
        return {
          taskType,
          modelId: top.id,
          confidence: estimate ? estimate.posteriorMean : 0.5,
          exploration: false,
          effectiveSamples: estimate?.effectiveSamples ?? 0,
          rationale: `Whittle 指数最优 ${top.id}（W(${top.state === 1 ? 'good' : 'bad'}) = ${top.index.toFixed(3)}，后验均值 ${estimate ? estimate.posteriorMean.toFixed(3) : '0.500'}，落选臂的演化数学已进入调度口径）`,
          economicMultiplier: this.economicMultiplierOf(top.id),
        };
      }
    }

    // 22.0：预算路由——治理器预算成为调度的一等约束：乐观可行性 +
    // 预算感知贪心选臂，影子价格 λ 由「剩余预算/剩余轮数」稀缺性内生
    // 涌现；无可行臂时选最廉臂止血（cheapest-shed，非探索）。
    if (this.bwKRouter && this.bwKBudgetProvider) {
      const budget = this.bwKBudgetProvider();
      if (budget && budget.tokensRemaining > 0) {
        const arms = statuses.map((status) => {
          const estimate = this.memory.getBayesianEstimate(status.id, taskType);
          return {
            id: status.id,
            qualityMean: estimate ? estimate.posteriorMean : 0.5,
            samples: estimate ? estimate.effectiveSamples : 0,
            // 模型画像平均 token 消耗（运行时累计口径；无历史 600 兜底）
            tokensMean: status.totalCalls > 0 ? status.totalTokensUsed / status.totalCalls : 600,
            costMean: status.totalCalls > 0 && status.totalCost !== undefined ? status.totalCost / status.totalCalls : undefined,
          };
        });
        const verdict = this.bwKRouter.route(arms, {
          tokensRemaining: budget.tokensRemaining,
          costRemaining: budget.costRemaining,
          roundsRemaining: this.bwKRouter.getConfig().horizonDefault,
        });
        this.lastBwKVerdict = verdict;
        const chosenStatus = verdict.chosenId ? statuses.find((s) => s.id === verdict.chosenId) : undefined;
        if (chosenStatus) {
          const estimate = this.memory.getBayesianEstimate(chosenStatus.id, taskType);
          // 探索语义：预算卸载（cheapest-shed）是被迫止血非探索；
          // 其余情形影子价格 > 0 表示存在被预算卡住的高质臂（预算约束活跃）
          const exploration = verdict.basis === 'cheapest-shed' ? false : verdict.shadowPriceTokens > 0;
          this.lastKernelPath = 'bwk';
          return {
            taskType,
            modelId: chosenStatus.id,
            confidence: estimate ? estimate.posteriorMean : 0.5,
            exploration,
            effectiveSamples: estimate?.effectiveSamples ?? 0,
            rationale: `预算路由选择 ${chosenStatus.id}（${verdict.reason}；预算率 ${verdict.rateTokens.toFixed(0)} tok/轮，剩余 token ${Math.round(budget.tokensRemaining)}）`,
            economicMultiplier: this.economicMultiplierOf(chosenStatus.id),
          };
        }
      }
    }
    return undefined;
  }

  /**
   * 为任务类型分配最优模型（能力画像 × 贝叶斯记忆画像 × 成本感知 × 探索/利用权衡）
   *
   * 第三阶段：评分核心改用策略参数化的 scoreModelWithPolicy
   * （与安全沙盒共享同一实现，参数 = 基准策略时与原固定公式一致）。
   * 质级升级：传入 context 时按规则基因组解析上下文有效参数。
   * 2.0：记忆证据从裸成功率升级为 Wilson 下界 + 有效样本量 + UCB 探索。
   *
   * @param taskType 任务类型
   * @param preferred 优化器推荐的模型（优先）
   * @param context 任务上下文（复杂度/特征；供规则基因匹配）
   */
  assignModel(taskType: string, preferred?: string, context?: SchedulerTaskContext, options?: { avoidModels?: string[] }): string {
    return this.assignModelWithInsight(taskType, preferred, context, options).modelId;
  }

  /**
   * 带洞察的模型分配（2.0：返回预测置信度与探索标记，供反思器校准闭环）
   *
   * 与 assignModel 共享同一评分与选择逻辑；编排层用本方法收集决策洞察，
   * 在复盘时回注反思器计算 Brier 校准误差与反事实遗憾。
   * 4.0：avoidModels 负向约束——经验规避模型（历史超时/能力不足）从候选剔除，
   * 推荐模型被规避时同样降级为动态评分选型（勘察修复：升级前 avoidModels
   * 产出后无人消费，负向经验在调度端断链）。
   * 21.0/22.0：挂载索引调度器 / 预算路由器后动态选型升级为 Gittins 索引 /
   * Bandits-with-Knapsacks 口径（preferred 短路与 avoidModels 语义不变；
   * 未挂载时逐位保持原行为）。
   * A3 第三轮：决策梯次 = preferred 短路（受熔断硬闸约束）→ 运营闸门过滤
   * （A3-1 熔断三态 + A3-4 重试预算；未挂载逐位透传）→ 挂载内核（21/53/22
   * 先挂先得）→ A3-3 画像 × Pareto 前沿 → 评分选型（A3-3 画像退化权重 +
   * A3-2 P2C 负载均衡）；全程旁路落账 A3-5 审计。
   */
  assignModelWithInsight(
    taskType: string,
    preferred?: string,
    context?: SchedulerTaskContext,
    options?: { avoidModels?: string[] },
  ): SchedulingInsight {
    const avoid = new Set(options?.avoidModels ?? []);
    this.lastKernelPath = undefined;
    if (preferred && !avoid.has(preferred) && this.llm.getModel(preferred)) {
      // A3-1：推荐短路尊重熔断硬闸——熔断中的 preferred 不短路，降级动态
      // 选型（重试软预算不约束推荐：预算是经济闸，熔断是安全闸）
      if (!this.healthRouting || this.healthEligible(preferred, this.healthRouting.clock())) {
        const insight = this.insightOf(
          taskType,
          { id: preferred, base: 0, bonus: 0, total: 0, estimate: this.memory.getBayesianEstimate(preferred, taskType) },
          true,
        );
        this.markHealthProbe(insight.modelId);
        this.recordSchedulingAudit(taskType, [preferred], 'preferred', insight.modelId, insight.rationale, preferred);
        return insight;
      }
    }

    const allStatuses = this.llm.getModelStatuses().filter((s) => !avoid.has(s.id));
    if (allStatuses.length === 0) throw new ExecutionError('没有已注册的可用模型');

    // A3-1/A3-4：运营闸门（熔断剔除 + 预算剔除；未挂载逐位透传——零漂移）
    const { kept: statuses, forcedProbeId, relaxedRetry } = this.applyOperationalFilters(allStatuses);
    const auditNotes = { forcedProbeId, relaxedRetry };
    const snapshotIds = allStatuses.map((s) => s.id);

    // 21.0/22.0/53.0：挂载数学内核时动态选型升级为索引/预算口径；
    // 未挂载/预算不可用返回 undefined，原评分路径逐位保持不变（零漂移）
    const kernelInsight = this.selectWithAttachedKernels(taskType, statuses);
    if (kernelInsight) {
      this.markHealthProbe(kernelInsight.modelId);
      this.recordSchedulingAudit(
        taskType,
        statuses.map((s) => s.id),
        this.lastKernelPath ?? 'scored',
        kernelInsight.modelId,
        kernelInsight.rationale,
        preferred,
        auditNotes,
        snapshotIds,
      );
      return kernelInsight;
    }

    // A3-3：成本画像 × Pareto 前沿（绑定画像且挂载 67.0 视图；否则 undefined）
    const profileInsight = this.selectWithCostProfile(taskType);
    if (profileInsight) {
      this.markHealthProbe(profileInsight.modelId);
      this.recordSchedulingAudit(
        taskType,
        statuses.map((s) => s.id),
        'profile-pareto',
        profileInsight.modelId,
        profileInsight.rationale,
        preferred,
        auditNotes,
        snapshotIds,
      );
      return profileInsight;
    }

    const scored = this.scoreCandidates(taskType, context, statuses);
    let best = scored[0]!;
    for (const s of scored) {
      if (s.total > best.total) best = s;
    }
    // A3-2：两次选择幂负载均衡（质量门内随机两候取轻者；未挂载零漂移）
    const p2cChosen = this.pickByP2C(scored);
    const chosen = p2cChosen ?? best;
    let insight = this.insightOf(taskType, chosen, false, scored);
    if (p2cChosen && this.lastP2c) {
      const d = this.lastP2c;
      insight = {
        ...insight,
        rationale: `${insight.rationale}；P2C 两次选择幂（${d.aId} 负载 ${d.loadA.toFixed(3)} vs ${d.bId} 负载 ${d.loadB.toFixed(3)} → 取轻者）`,
      };
    }
    this.markHealthProbe(insight.modelId);
    this.recordSchedulingAudit(
      taskType,
      statuses.map((s) => s.id),
      p2cChosen ? 'p2c' : 'scored',
      insight.modelId,
      insight.rationale,
      preferred,
      auditNotes,
      snapshotIds,
    );
    return insight;
  }

  /**
   * 多模型集成候选（第三阶段：模型组合逻辑的策略落地）
   *
   * 按当前策略评分降序返回前 N 个模型（供执行侧并行执行 + 融合决策）。
   * 质级升级：传入 context 时按规则基因组解析上下文有效参数
   * （如规则强制 ensembleForce=true 的任务类型稳定给出组合候选）。
   * @param taskType 任务类型
   * @param count 集成模型数（缺省取策略 ensembleMaxModels）
   * @param exclude 排除的模型 id（如重试时排除当前模型）
   * @param context 任务上下文（复杂度/特征；供规则基因匹配）
   */
  pickEnsemble(taskType: string, count?: number, exclude: string[] = [], context?: SchedulerTaskContext): string[] {
    const allStatuses = this.llm.getModelStatuses().filter((s) => !exclude.includes(s.id));
    if (allStatuses.length === 0) return [];
    // A3-1/A3-4：运营闸门（熔断/重试超限模型不入组合；未挂载逐位透传）
    const { kept: statuses } = this.applyOperationalFilters(allStatuses);
    if (statuses.length === 0) return [];
    const params = this.effectiveParams(taskType, context);
    const ranked = statuses
      .map((status) => ({ id: status.id, score: this.scoreModel(taskType, status, params) }))
      .sort((a, b) => b.score - a.score);
    const n = Math.max(1, count ?? params.ensembleMaxModels);
    return ranked.slice(0, n).map((r) => r.id);
  }

  /**
   * 选择次优模型（排除当前模型，按策略评分；context 供规则基因匹配）
   * 4.0：excludeModels 额外排除清单（经验规避模型 / 熔断中模型），向后兼容
   * A3-1/A3-4：运营闸门——熔断中 / 窗口内重试配额耗尽的模型不入降级候选
   * （超限降级换模型的全链落地；未挂载逐位透传——零漂移）
   */
  pickFallbackModel(taskType: string, excludeModelId: string, context?: SchedulerTaskContext, excludeModels?: string[]): string | undefined {
    const exclude = new Set<string>([excludeModelId, ...(excludeModels ?? [])]);
    const allStatuses = this.llm.getModelStatuses().filter((s) => !exclude.has(s.id));
    if (allStatuses.length === 0) return undefined;
    const { kept: statuses } = this.applyOperationalFilters(allStatuses);
    if (statuses.length === 0) return undefined;
    const params = this.effectiveParams(taskType, context);
    let bestId: string | undefined;
    let bestScore = -1;
    for (const status of statuses) {
      const score = this.scoreModel(taskType, status, params);
      if (score > bestScore) {
        bestScore = score;
        bestId = status.id;
      }
    }
    return bestId;
  }

  /**
   * 动态并行度：依据已注册模型的总并发容量计算同层最大并行数
   * （避免同层节点数超过模型并发容量导致全部排队）
   *
   * 35.0：挂载反馈控制器后升级为闭环口径——每次调用即一步反馈
   * （观测总利用率 activeRequests / 总容量 → LQR 增益步 → 新上限，
   * 死区抗抖振、钳位 [1,16] 抗饱和，稳定性由 Lyapunov 证书背书）。
   * 未挂载时与原静态口径逐位一致（零漂移）。
   */
  computeParallelism(): number {
    const statuses = this.llm.getModelStatuses();
    const totalConcurrency = statuses.reduce((sum, s) => sum + s.maxConcurrency, 0);
    if (this.concurrencyController) {
      const active = statuses.reduce((sum, s) => sum + s.activeRequests, 0);
      const utilization = totalConcurrency > 0 ? active / totalConcurrency : 0;
      this.lastControlStep = this.concurrencyController.step(utilization);
      return Math.round(this.lastControlStep.output);
    }
    // 至少 1，上限 16（防止异常配置导致过度并行）
    return Math.max(1, Math.min(16, totalConcurrency || 4));
  }

  /**
   * 32.0：候选评分公开口径（批量全局指派的收益矩阵原料）。
   *
   * 与 assignModelWithInsight 同一评分路径（含 UCB/EFE 加成与经济/
   * 对抗乘数），返回 (id, total) 降序排列——供执行侧构造批内收益矩阵，
   * 匈牙利算法在「同一批节点 × 全体候选」上求全局最优指派。
   */
  rankCandidateScores(taskType: string, context?: SchedulerTaskContext, exclude: string[] = []): Array<{ id: string; score: number }> {
    const avoid = new Set(exclude);
    const allStatuses = this.llm.getModelStatuses().filter((s) => !avoid.has(s.id));
    if (allStatuses.length === 0) return [];
    // A3-1/A3-4：运营闸门（熔断/重试超限模型不进收益矩阵；未挂载逐位透传）
    const { kept: statuses } = this.applyOperationalFilters(allStatuses);
    if (statuses.length === 0) return [];
    const scored = this.scoreCandidates(taskType, context, statuses);
    return scored.map((s) => ({ id: s.id, score: s.total })).sort((a, b) => b.score - a.score);
  }
}
