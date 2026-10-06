/**
 * reflection-engine.ts — 质量反思引擎（闭环"反思"环节深度优化）
 *
 * 职责：在执行完成后进行深度质量反思，超越简单的阈值比较
 *
 * 能力矩阵：
 * 1. LLM-as-judge 质量评审：调用评审模型对节点输出打分（多维度：
 *    完整性 / 正确性 / 可维护性），替代单一启发式质量分
 * 2. 失败教训提取：从失败执行中提炼结构化教训（根因分类 + 改进建议），
 *    写入长期记忆供后续计划生成引用
 * 3. 质量趋势追踪：滑动窗口统计各任务类型的质量走势，
 *    连续下滑触发告警事件
 * 4. 阈值自校准：依据历史质量分布动态调整 qualityThreshold
 *    （质量普遍偏高 → 收紧阈值追求卓越；普遍偏低 → 适度放宽避免无效重试风暴）
 * 5. 重试策略优化：依据教训库判断重试是否有意义
 *    （如"模型能力不足"类根因 → 直接换模型而非原模型重试）
 *
 * 升级点（相对固定阈值重试的质的提升）：
 * - 反思从"事后统计"进化为"主动诊断"，每次失败都产出可复用的教训
 * - 阈值不再是静态配置，而是随系统能力演化的活参数
 * - 评审模型可注入，冒烟测试可离线模拟
 *
 * 第四轮 R4-A6 新增维度（opt-in，未挂载零漂移）：
 * - 反思深度分级：轻反思（统计快检 / z 检验）与重反思（全链归因）按
 *   失败代价分级路由；轻反思检出统计异常 → 同事件升级触发重反思
 *   （attachDepthGrading → gradedReflect / depthStats）
 */

import type { NodeResult, PlanExecutionResult, ExecutionPlan } from './types.js';
import type { Signal } from './sentinel.js';
import { decayFactor } from './core/evidence.js';
import type { CausalKernel } from './core/causal-kernel.js';
import { selectRiskControlledThreshold, type RiskControlResult } from './core/conformal.js';

// 第二轮创世纪 81.0：论证内核（深思/反思的裁决语义——辩护链存在性）
import { conflictAdjudication, type ConflictAdjudicationView } from './engines-frontier/autonomy25.js';

/** 评审模型签名（可注入） */
export type JudgeModel = (params: {
  taskDescription: string;
  output: string;
  taskType: string;
}) => Promise<{ score: number; completeness: number; correctness: number; maintainability: number; comment: string }>;

/** 教训提取器签名（可注入，通常由 strategist 模型承担） */
export type LessonExtractor = (params: {
  signalDescription: string;
  taskType: string;
  errorMessage: string;
  failedNodeId: string;
  failedModelId: string;
}) => Promise<{ rootCause: RootCauseCategory; lesson: string; suggestion: string }>;

/** 根因分类 */
export type RootCauseCategory =
  | 'model-capability' // 模型能力不足（应换模型）
  | 'timeout' // 超时（应加大超时或拆分任务）
  | 'dependency' // 上游依赖产出质量问题
  | 'prompt-ambiguity' // 任务描述模糊（应要求澄清）
  | 'transient' // 瞬时故障（重试有意义）
  | 'unknown';

/** 结构化教训 */
export interface Lesson {
  id: string;
  timestamp: number;
  taskType: string;
  rootCause: RootCauseCategory;
  lesson: string;
  suggestion: string;
  signalDescription: string;
  /** 5.0：反事实教训（失败 → 「若选 B」的因果估计） */
  counterfactual?: CounterfactualInsight;
}

/**
 * 5.0：反事实洞察 ——「若当时选 B」的因果区间估计。
 *
 * 质变点：传统教训只回答「为什么失败」（归因过去）；
 * 反事实教训回答「怎样会成功」（指导未来的反事实推理）。
 */
export interface CounterfactualInsight {
  /** 实际采用的模型 */
  actualModel: string;
  /** 反事实最优替代 */
  bestAlternative: string;
  /** 替代模型的估计成功概率（因果口径，非相关） */
  estimatedProb: number;
  /** 区间下界 */
  lower: number;
  /** 区间上界 */
  upper: number;
  /** 可读结论 */
  verdict: string;
  /** 证据样本量（不足时建议先做实验而非直接切换） */
  evidenceSamples: number;
}

/** 质量趋势记录 */
export interface QualityTrendPoint {
  timestamp: number;
  taskType: string;
  avgQuality: number;
  success: boolean;
}

/** 质量趋势摘要（按任务类型聚合） */
export interface TrendSummary {
  threshold: number;
  windowSize: number;
  byType: Record<
    string,
    {
      samples: number;
      avgQuality: number;
      successRate: number;
      trending: 'rising' | 'falling' | 'stable';
    }
  >;
  /** 13.0：当前阈值的风险依据（挂载风险控制器后输出） */
  basis?: RiskControlResult;
}

/** 反思引擎配置 */
export interface ReflectionEngineConfig {
  /** 初始质量阈值 */
  qualityThreshold: number;
  /** 阈值自校准的最小样本数 */
  calibrationMinSamples: number;
  /** 阈值自校准步长 */
  calibrationStep: number;
  /** 阈值允许的范围 */
  thresholdRange: [number, number];
  /** 质量趋势滑动窗口大小 */
  trendWindowSize: number;
  /** 连续下滑触发告警的次数 */
  declineAlertCount: number;
  /** 评审模型（缺省则使用执行器自带质量分） */
  judge?: JudgeModel;
  /** 教训提取器（缺省则使用规则化提取） */
  lessonExtractor?: LessonExtractor;
}

/** 反思结论 */
export interface ReflectionVerdict {
  /** 综合质量分（评审模型 or 执行器质量分） */
  quality: number;
  /** 是否达标 */
  passed: boolean;
  /** 重试建议：retry-same / retry-switch / no-retry */
  retryAdvice: 'retry-same' | 'retry-switch' | 'no-retry';
  /** 建议理由 */
  reason: string;
  /** 评审明细（judge 可用时） */
  dimensions?: { completeness: number; correctness: number; maintainability: number; comment: string };
}

// ───────────────────── 第三轮模块域升级 A6：重试策略 bandit 化 ─────────────────────

/** A6 升级 3：bandit 臂（重试同模型 / 换模型重试） */
export type RetryBanditArm = 'retry-same' | 'retry-switch';

/**
 * A6 升级 3：重试 bandit 决策读数
 *
 * ε 递减 ε-greedy：以 ε 概率探索另一臂、1-ε 贪心选「历史平均失败成本
 * 更低」的臂；ε 随拉动总数指数衰减（ε = max(εmin, ε0·decay^n)）——
 * 早期多试（收集两臂成本证据）、后期少试（吃收敛红利）。
 */
export interface RetryBanditDecision {
  /** 选中的臂 */
  arm: RetryBanditArm;
  /** 本次决策的探索率 */
  epsilon: number;
  /** 本次是否探索（true = 随机臂；false = 贪心臂 / 冷启动初始化拉） */
  explored: boolean;
  /** 两臂累计拉动数 */
  pulls: Record<RetryBanditArm, number>;
  /** 两臂平均失败成本（未拉动为 0） */
  avgCost: Record<RetryBanditArm, number>;
  /** 当前贪心最优臂（平均成本更低者；无数据时 retry-same） */
  greedyArm: RetryBanditArm;
}

/** A6 升级 3：重试 bandit 状态总览（失败成本账本） */
export interface RetryBanditStatus {
  /** 当前探索率 */
  epsilon: number;
  /** 两臂拉动数 */
  pulls: Record<RetryBanditArm, number>;
  /** 总拉动数 */
  totalPulls: number;
  /** 两臂平均失败成本 */
  avgCost: Record<RetryBanditArm, number>;
  /** 入账总失败成本（对照固定规则的结算口径） */
  totalCost: number;
  /** 当前贪心最优臂 */
  greedyArm: RetryBanditArm;
}

// ───────────────────── 第四轮模块域升级 R4-A6：反思深度分级（轻 / 重按代价路由） ─────────────────────

/** R4-A6 升级 2：反思深度（轻 = 统计快检 / 重 = 全链归因） */
export type ReflectionDepth = 'light' | 'heavy';

/**
 * R4-A6 升级 2：轻反思快检（统计口径——不逐节点归因，代价 1 单位）
 *
 * 对失败质量在近窗历史上做 z 检验：z ≤ escalationZ 判「异常」
 * （该失败显著偏离该任务类型的常态分布——不是噪声，值得深挖）。
 */
export interface LightReflectionCheck {
  /** 快检窗口样本量（< 3 时基线不足，z 置 0 不判异常——诚实降级） */
  windowSamples: number;
  /** 近窗质量均值 */
  recentMean: number;
  /** 近窗质量标准差（std < 0.05 时以 0.05 为尺度下限——零方差窗口仍有区分度） */
  stdDev: number;
  /** 本次失败质量 */
  quality: number;
  /** z 分 = (quality − mean) / max(std, 0.05) */
  zScore: number;
  /** 异常判定（z ≤ escalationZ） */
  anomaly: boolean;
  verdict: string;
}

/** R4-A6 升级 2：重反思的节点归因项 */
export interface HeavyAttributionNode {
  nodeId: string;
  type: string;
  /** 责任占比 0~1（全链合计 1——失败责任第一次被定量分摊） */
  contribution: number;
  note: string;
}

/** R4-A6 升级 2：重反思全链归因（失败节点 + 上游传导的责任分摊） */
export interface HeavyAttribution {
  failedNodeId: string;
  /** 归因链（按责任占比降序，至多 5 项） */
  chain: HeavyAttributionNode[];
  /** 根因提示（教训库最近同任务类型根因；无教训时 'unknown'） */
  rootCauseHint: RootCauseCategory;
  /** 消费的教训条数 */
  consultedLessons: number;
}

/** R4-A6 升级 2：分级反思结论（轻 / 重 + 轻→重升级链） */
export interface DepthGradedReflection {
  depth: ReflectionDepth;
  /** 触发分级的失败代价 */
  failureCost: number;
  /** 分级阈值（cost ≥ threshold → 重反思） */
  threshold: number;
  /** 轻反思快检（depth='light' 时必有） */
  quickCheck?: LightReflectionCheck;
  /** 重反思归因（depth='heavy' 或轻反思升级时有） */
  attribution?: HeavyAttribution;
  /** 轻反思检出异常 → 同事件升级触发重反思（轻→重升级链） */
  escalated: boolean;
  /** 反思代价核算（轻 lightCostUnits / 重 heavyCostUnits / 升级 = 轻 + 重） */
  costUnits: number;
}

/** R4-A6 升级 2：分级路由统计（省代价对照口径） */
export interface DepthGradingStats {
  /** 轻反思次数 */
  light: number;
  /** 重反思次数（含升级触发的重反思） */
  heavy: number;
  /** 轻→重升级次数 */
  escalations: number;
  /** 实际发生代价 */
  totalCostUnits: number;
  /** 全重反思基线代价（不分级时的旧口径） */
  allHeavyCostUnits: number;
  /** 分级省下的代价 = allHeavy − total */
  savedCostUnits: number;
}

/** 分级反思的节点输入（轻反思不需要；重反思全链归因消费） */
export interface GradedReflectionNode {
  id: string;
  type: string;
  quality: number;
  success: boolean;
  dependsOn: string[];
}

/** 默认配置 */
export const DEFAULT_REFLECTION_CONFIG: ReflectionEngineConfig = {
  qualityThreshold: 0.7,
  calibrationMinSamples: 10,
  calibrationStep: 0.02,
  thresholdRange: [0.5, 0.95],
  trendWindowSize: 20,
  declineAlertCount: 3,
};

/**
 * 质量反思引擎
 *
 * 被 index.ts 持有：executor 执行完成后调用 reflect() 进行深度反思，
 * 失败时调用 extractLesson() 沉淀教训，阈值通过 getCurrentThreshold() 动态获取。
 */
export class ReflectionEngine {
  private config: ReflectionEngineConfig;
  private lessons: Lesson[] = [];
  private trendWindow: QualityTrendPoint[] = [];
  /** 各任务类型的质量历史（用于自校准；带时间戳支持衰减均值） */
  private qualityHistory = new Map<string, Array<{ quality: number; at: number }>>();
  /** 当前动态阈值 */
  private currentThreshold: number;
  /** 告警回调（由 index.ts 桥接到进度广播） */
  private onAlert?: (alert: { type: string; message: string; taskType: string }) => void;
  private lessonCounter = 0;
  /** 5.0：因果内核（挂载后失败反思自动触发反事实分析） */
  private causal?: CausalKernel;
  /** 13.0：风险受控阈值选择配置（挂载后 ±0.02 步进启发式退役） */
  private riskControl?: { targetRisk: number; confidence: number; gridSteps: number };
  /** 13.0：最近一次阈值选择的风险依据（可观测/可审计） */
  private thresholdBasis?: RiskControlResult;

  constructor(config?: Partial<ReflectionEngineConfig>) {
    this.config = { ...DEFAULT_REFLECTION_CONFIG, ...config };
    this.currentThreshold = this.config.qualityThreshold;
  }

  /**
   * 81.0：挂载对抗论证裁决（幂等覆盖，挂载即生效——影子计算口径）。
   *
   * 辩论/多结论反思收束后的「结论 + 冲突对」编码为 ArgumentFramework
   * （每结论一条论证、每条「X 推翻 Y 的前提」一条攻击边——边须对应真实
   * 反驳记录，防攻击图投毒），groundedExtension 给无争议辩护链，
   * acceptance 逐结论回答疑信/轻信接受：疑信接受才可写入共识账本，
   * 连轻信都不可接受的结论携带致败边（拒绝第一次有了数学尸检报告）。
   * 影子计算——不改变反思主链路（零漂移）。
   */
  attachArgumentation(): void {
    this.argumentationEnabled = true;
  }

  /** 81.0：论证裁决旗标（未挂载零介入） */
  private argumentationEnabled?: boolean;

  /**
   * 81.0：冲突裁决读数（未挂载 / 结论数超枚举护栏（>16）时 undefined）。
   * @param conclusions 结论文本表（每结论一条论证）
   * @param attacks 冲突对下标表（[i, j] = i 攻击 j）
   * @param semantics 裁决语义（缺省 grounded——多项式、必存在、最保守）
   */
  argumentationVerdict(
    conclusions: ReadonlyArray<string>,
    attacks: ReadonlyArray<readonly [number, number]>,
    semantics?: 'grounded' | 'complete' | 'preferred' | 'stable',
  ): ConflictAdjudicationView | undefined {
    return this.argumentationEnabled ? conflictAdjudication(conclusions, attacks, { semantics }) : undefined;
  }

  /**
   * 13.0：挂载风险受控阈值选择器（幂等）。
   *
   * 质变点：阈值自校准从「±0.02 步进启发式」（重试率全凭运气）升级为
   * 分布无关的**带保证选择**——每轮从历史质量分布中选出「未来重试率
   * ≤ targetRisk」以 confidence 置信成立的最严格质量门槛：
   *   P(未来重试率 ≤ targetRisk) ≥ confidence
   * 质量普遍优秀 → 风险余量大 → 门槛自动收紧；能力不足 → 门槛自动
   * 让位，但重试率上界永不突破——重试风暴在数学上被封顶。
   */
  attachRiskController(options?: { targetRisk?: number; confidence?: number; gridSteps?: number }): void {
    this.riskControl = {
      targetRisk: options?.targetRisk ?? 0.1,
      confidence: options?.confidence ?? 0.95,
      gridSteps: options?.gridSteps ?? 18,
    };
  }

  // ───────────────────── 第三轮 A6 升级 3：重试策略 bandit 化 ─────────────────────

  /**
   * A6 升级 3：挂载重试 bandit（幂等覆盖，挂载即生效——咨询口径）。
   *
   * adviseRetry 的固定规则（质量差距 / 教训根因两类启发式）升级为
   * **「重试同模型 vs 换模型」双臂 ε 递减 bandit，失败成本入账**：
   * - 决策（retryBanditDecide）：ε 概率探索、1-ε 贪心选历史平均失败
   *   成本更低的臂；ε = max(εmin, ε0·decay^n) 随总拉动数 n 指数递减
   *   ——早期多试摸清两臂成本结构，后期锁定低成本臂
   * - 结算（retryBanditSettle）：每次重试失败把失败成本（重试 token /
   *   时延折算）入账对应臂，均值即该臂的期望重试代价
   * - 对照固定规则：同模型在该任务类型上根本不行时，固定规则仍会在
   *   「质量差距不够大 / 无能力教训」的中段带反复 retry-same 烧钱；
   *   bandit 从入账成本里自己学出该换就换
   *
   * 确定性：探索用注入种子的 mulberry32（同 seed 同决策序列）。
   * 未挂载零漂移（adviseRetry 固定规则原样保留，reflect 主链路不变）。
   *
   * @param options.epsilon0 初始探索率（缺省 0.3）
   * @param options.epsilonMin 探索率下限（缺省 0.02——永不完全停止探索，防世界漂移）
   * @param options.decay 每次拉动的探索率乘子（缺省 0.97）
   * @param options.seed 探索随机源种子（缺省 42）
   */
  attachRetryBandit(options?: { epsilon0?: number; epsilonMin?: number; decay?: number; seed?: number }): void {
    this.retryBandit = {
      epsilon0: Math.min(1, Math.max(0, options?.epsilon0 ?? 0.3)),
      epsilonMin: Math.min(1, Math.max(0, options?.epsilonMin ?? 0.02)),
      decay: Math.min(1, Math.max(0.5, options?.decay ?? 0.97)),
      rng: mulberry32Local(options?.seed ?? 42),
      pulls: { 'retry-same': 0, 'retry-switch': 0 },
      costSums: { 'retry-same': 0, 'retry-switch': 0 },
      totalCost: 0,
    };
  }

  /** A6 升级 3：重试 bandit 状态（未挂载零介入） */
  private retryBandit?: {
    epsilon0: number;
    epsilonMin: number;
    decay: number;
    rng: () => number;
    pulls: Record<RetryBanditArm, number>;
    costSums: Record<RetryBanditArm, number>;
    totalCost: number;
  };

  /** A6 升级 3：当前探索率 ε = max(εmin, ε0·decay^n)（n = 总拉动数） */
  private retryBanditEpsilon(): number {
    const b = this.retryBandit!;
    const n = b.pulls['retry-same'] + b.pulls['retry-switch'];
    return Math.max(b.epsilonMin, b.epsilon0 * Math.pow(b.decay, n));
  }

  /** A6 升级 3：贪心最优臂（平均失败成本更低者；两臂均无数据或平局时 retry-same——与固定规则缺省一致） */
  private retryBanditGreedyArm(): RetryBanditArm {
    const b = this.retryBandit!;
    const samePulls = b.pulls['retry-same'];
    const switchPulls = b.pulls['retry-switch'];
    if (samePulls === 0 && switchPulls === 0) return 'retry-same';
    if (switchPulls === 0) return 'retry-same'; // 另一臂未探索：先拉满信息（乐观初始化）
    if (samePulls === 0) return 'retry-switch';
    const avgSame = b.costSums['retry-same'] / samePulls;
    const avgSwitch = b.costSums['retry-switch'] / switchPulls;
    return avgSwitch < avgSame ? 'retry-switch' : 'retry-same';
  }

  /**
   * A6 升级 3：重试决策（未挂载返回 undefined——编排层回退 adviseRetry 固定规则）。
   *
   * 决策序：冷启动（两臂均无数据）→ 先拉 retry-switch 补信息（retry-same
   * 是固定规则的缺省臂，bandit 只需先看清另一臂）；单臂有数据 → 贪心臂；
   * 两臂有数据 → ε 概率随机臂 / 1-ε 贪心臂。
   */
  retryBanditDecide(): RetryBanditDecision | undefined {
    if (!this.retryBandit) return undefined;
    const b = this.retryBandit;
    const epsilon = this.retryBanditEpsilon();
    const greedyArm = this.retryBanditGreedyArm();
    let arm: RetryBanditArm;
    let explored = false;
    if (b.pulls['retry-same'] === 0 && b.pulls['retry-switch'] === 0) {
      arm = 'retry-switch'; // 冷启动初始化拉（确定性，非随机）
    } else if (b.rng() < epsilon) {
      explored = true;
      arm = greedyArm === 'retry-same' ? 'retry-switch' : 'retry-same';
    } else {
      arm = greedyArm;
    }
    const avgOf = (a: RetryBanditArm): number => (b.pulls[a] > 0 ? b.costSums[a] / b.pulls[a] : 0);
    return {
      arm,
      epsilon: Number(epsilon.toFixed(6)),
      explored,
      pulls: { ...b.pulls },
      avgCost: { 'retry-same': Number(avgOf('retry-same').toFixed(6)), 'retry-switch': Number(avgOf('retry-switch').toFixed(6)) },
      greedyArm,
    };
  }

  /**
   * A6 升级 3：失败成本入账（重试执行后由编排层回填；未挂载空操作）。
   * @param arm 本次实际执行的臂
   * @param failureCost 本次失败成本（token / 时延折算，正数；成本越低越好）
   */
  retryBanditSettle(arm: RetryBanditArm, failureCost: number): void {
    if (!this.retryBandit) return;
    const b = this.retryBandit;
    const cost = Number.isFinite(failureCost) && failureCost > 0 ? failureCost : 0;
    b.pulls[arm] += 1;
    b.costSums[arm] += cost;
    b.totalCost += cost;
  }

  /** A6 升级 3：bandit 状态总览（未挂载 undefined） */
  retryBanditStatus(): RetryBanditStatus | undefined {
    if (!this.retryBandit) return undefined;
    const b = this.retryBandit;
    const avgOf = (a: RetryBanditArm): number => (b.pulls[a] > 0 ? b.costSums[a] / b.pulls[a] : 0);
    return {
      epsilon: Number(this.retryBanditEpsilon().toFixed(6)),
      pulls: { ...b.pulls },
      totalPulls: b.pulls['retry-same'] + b.pulls['retry-switch'],
      avgCost: { 'retry-same': Number(avgOf('retry-same').toFixed(6)), 'retry-switch': Number(avgOf('retry-switch').toFixed(6)) },
      totalCost: Number(b.totalCost.toFixed(6)),
      greedyArm: this.retryBanditGreedyArm(),
    };
  }

  // ───────────────────── 第四轮模块域升级 R4-A6：反思深度分级 ─────────────────────

  /**
   * R4-A6 升级 2：挂载反思深度分级（幂等覆盖，挂载即生效）。
   *
   * 反思从「每次失败全链归因」的一刀切升级为**按失败代价分级路由**：
   * - 轻反思（失败代价 < costThreshold）：统计快检——失败质量在近窗历史上
   *   做 z 检验（代价 1 单位，不逐节点归因）。小代价失败不值得重炮。
   * - 重反思（代价 ≥ costThreshold）：全链归因——失败节点 + 上游依赖的
   *   质量亏空按权重分摊责任（合计 1），并消费教训库给根因提示。
   * - 轻→重升级：轻反思 z 检验检出**统计异常**（z ≤ escalationZ——该失败
   *   显著偏离常态，不是噪声）时，同一事件就地升级触发重反思
   *   （代价 = 轻 + 重——宁可多花，不放过系统性劣化）。
   *
   * 只读 qualityHistory（由 recordExecution 既有路径维护，零漂移）；
   * 未挂载时 gradedReflect / depthStats 均缺席。
   *
   * @param options.costThreshold 重反思的失败代价门槛（缺省 100）
   * @param options.escalationZ 轻→重升级的 z 阈值（缺省 −2）
   * @param options.windowSize 快检窗口（缺省 10）
   * @param options.lightCostUnits / heavyCostUnits 代价单位（缺省 1 / 8）
   */
  attachDepthGrading(options?: {
    costThreshold?: number;
    escalationZ?: number;
    windowSize?: number;
    lightCostUnits?: number;
    heavyCostUnits?: number;
  }): void {
    this.depthGrading = {
      costThreshold: options?.costThreshold ?? 100,
      escalationZ: options?.escalationZ ?? -2,
      windowSize: Math.max(3, options?.windowSize ?? 10),
      lightCostUnits: Math.max(0.1, options?.lightCostUnits ?? 1),
      heavyCostUnits: Math.max(1, options?.heavyCostUnits ?? 8),
      counters: { light: 0, heavy: 0, escalations: 0, totalCostUnits: 0, incidents: 0 },
    };
  }

  /** R4-A6 升级 2：分级路由状态（未挂载零介入） */
  private depthGrading?: {
    costThreshold: number;
    escalationZ: number;
    windowSize: number;
    lightCostUnits: number;
    heavyCostUnits: number;
    counters: { light: number; heavy: number; escalations: number; totalCostUnits: number; incidents: number };
  };

  /**
   * R4-A6 升级 2：分级反思（未挂载返回 undefined）。
   *
   * 只读不写——qualityHistory 由既有 recordExecution 维护（编排层在
   * reflectOnOutcome 主链路已调用）；本方法纯路由 + 纯计算，同输入同输出。
   *
   * @param params.taskType 任务类型（快检基线按类型分组）
   * @param params.quality 本次失败质量
   * @param params.failureCost 失败代价（token / 时延折算——分级依据）
   * @param params.nodes 计划节点（重反思全链归因素材；缺省仅失败节点自担）
   */
  gradedReflect(params: {
    taskType: string;
    quality: number;
    failureCost: number;
    nodes?: GradedReflectionNode[];
  }): DepthGradedReflection | undefined {
    const grading = this.depthGrading;
    if (!grading) return undefined;

    const heavy = params.failureCost >= grading.costThreshold;
    const result: DepthGradedReflection = {
      depth: heavy ? 'heavy' : 'light',
      failureCost: params.failureCost,
      threshold: grading.costThreshold,
      escalated: false,
      costUnits: heavy ? grading.heavyCostUnits : grading.lightCostUnits,
    };

    if (!heavy) {
      // ── 轻反思：统计快检（z 检验——近窗基线上的异常探测） ──
      const history = this.qualityHistory.get(params.taskType) ?? [];
      const recent = history.slice(-grading.windowSize).map((h) => h.quality);
      const n = recent.length;
      const mean = n > 0 ? recent.reduce((s, v) => s + v, 0) / n : params.quality;
      const variance = n > 1 ? recent.reduce((s, v) => s + (v - mean) ** 2, 0) / n : 0;
      const std = Math.sqrt(variance);
      const scale = Math.max(std, 0.05); // 零方差窗口仍有 5% 质量尺度区分度
      const z = n >= 3 ? (params.quality - mean) / scale : 0; // 基线不足不判异常（诚实降级）
      const anomaly = n >= 3 && z <= grading.escalationZ;
      result.quickCheck = {
        windowSamples: n,
        recentMean: Number(mean.toFixed(6)),
        stdDev: Number(std.toFixed(6)),
        quality: params.quality,
        zScore: Number(z.toFixed(6)),
        anomaly,
        verdict:
          n < 3
            ? `基线不足（${n} 样本 < 3）：不判异常，仅记录`
            : anomaly
              ? `z=${z.toFixed(2)} ≤ ${grading.escalationZ}：失败质量显著偏离近窗均值 ${mean.toFixed(2)}±${std.toFixed(2)}——升级重反思`
              : `z=${z.toFixed(2)}：失败质量在近窗常态内（均值 ${mean.toFixed(2)}±${std.toFixed(2)}），轻反思结案`,
      };
      if (anomaly) {
        // 轻→重升级链：小代价但统计异常——系统性劣化不让它溜走
        result.escalated = true;
        result.attribution = this.buildHeavyAttribution(params.taskType, params.nodes);
        result.costUnits = grading.lightCostUnits + grading.heavyCostUnits;
      }
    } else {
      // ── 重反思：全链归因（大代价失败直接深挖） ──
      result.attribution = this.buildHeavyAttribution(params.taskType, params.nodes);
    }

    // 落账（路由统计——省代价对照口径）
    const c = grading.counters;
    c.incidents += 1;
    if (heavy) c.heavy += 1;
    else c.light += 1;
    if (result.escalated) c.escalations += 1;
    if (result.escalated) c.heavy += 1; // 升级触发的重反思同样计数
    c.totalCostUnits += result.costUnits;
    return result;
  }

  /**
   * R4-A6 升级 2：重反思全链归因（私有——纯计算）。
   *
   * 责任分摊：失败节点自担「质量亏空 + 基础权重 1」；其上游依赖链中
   * 质量低于当前阈值的节点按「亏空 × 0.5」折半分责（上游供给劣化是
   * 传导性共犯，但主责在失败节点）——全部权重归一化为合计 1。
   * 根因提示消费教训库：最近一条同任务类型教训的根因。
   */
  private buildHeavyAttribution(taskType: string, nodes?: GradedReflectionNode[]): HeavyAttribution {
    const failed = (nodes ?? []).filter((n) => !n.success);
    const fallbackFailed = failed.length === 0 ? [...(nodes ?? [])].sort((a, b) => a.quality - b.quality)[0] : undefined;
    const failedNodes = failed.length > 0 ? failed : fallbackFailed ? [fallbackFailed] : [];

    const nodeById = new Map((nodes ?? []).map((n) => [n.id, n] as const));
    // 上游集合：失败节点经 dependsOn 反向可达的全部节点
    const upstream = new Set<string>();
    const queue = failedNodes.flatMap((n) => [...n.dependsOn]);
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (upstream.has(id)) continue;
      upstream.add(id);
      const node = nodeById.get(id);
      if (node) queue.push(...node.dependsOn);
    }

    // 责任权重：失败节点 = 亏空 + 1（基础权重保证非零）；劣化上游 = 亏空 × 0.5
    const weights: Array<{ node: GradedReflectionNode; weight: number; note: string }> = [];
    for (const node of failedNodes) {
      const deficit = Math.max(0, this.currentThreshold - node.quality);
      weights.push({ node, weight: 1 + deficit, note: '失败节点（直接责任）' });
    }
    for (const id of upstream) {
      const node = nodeById.get(id);
      if (!node || node.success === false) continue;
      const deficit = Math.max(0, this.currentThreshold - node.quality);
      if (deficit > 0) weights.push({ node, weight: deficit * 0.5, note: '上游质量亏空传导（共犯责任 ×0.5）' });
    }
    const totalWeight = weights.reduce((s, w) => s + w.weight, 0) || 1;

    const lessons = this.getLessons(taskType, 5);
    const rootCauseHint: RootCauseCategory = lessons.length > 0 ? lessons[lessons.length - 1]!.rootCause : 'unknown';
    return {
      failedNodeId: failedNodes[0]?.id ?? 'unknown',
      chain: weights
        .sort((a, b) => b.weight - a.weight || (a.node.id < b.node.id ? -1 : 1))
        .slice(0, 5)
        .map((w) => ({
          nodeId: w.node.id,
          type: w.node.type,
          contribution: Number((w.weight / totalWeight).toFixed(6)),
          note: w.note,
        })),
      rootCauseHint,
      consultedLessons: lessons.length,
    };
  }

  /** R4-A6 升级 2：分级路由统计（省代价对照；未挂载 undefined） */
  depthStats(): DepthGradingStats | undefined {
    const grading = this.depthGrading;
    if (!grading) return undefined;
    const c = grading.counters;
    const allHeavy = c.incidents * grading.heavyCostUnits;
    return {
      light: c.light,
      heavy: c.heavy,
      escalations: c.escalations,
      totalCostUnits: Number(c.totalCostUnits.toFixed(6)),
      allHeavyCostUnits: Number(allHeavy.toFixed(6)),
      savedCostUnits: Number((allHeavy - c.totalCostUnits).toFixed(6)),
    };
  }

  /** 13.0：最近一次阈值选择的风险依据（未挂载或未决出时 undefined） */
  getThresholdBasis(): RiskControlResult | undefined {
    return this.thresholdBasis;
  }

  /** 设置告警回调 */
  setAlertHandler(handler: (alert: { type: string; message: string; taskType: string }) => void): void {
    this.onAlert = handler;
  }

  /** 5.0：挂载因果内核（幂等） */
  attachCausalKernel(kernel: CausalKernel): void {
    this.causal = kernel;
  }

  /**
   * 5.0：反事实分析 —— 失败后的「若选 B」推理。
   *
   * 对每个候选替代模型查询因果内核：do(use:B) → task.outcome 的
   * 后验成功概率（黄金口径：仅干预证据 ≥ 3 时采信，观测证据降权），
   * 返回最优替代与可读结论。
   *
   * 质变点：教训从「A 超时了」升级为「A 超时了；若当时用 B，
   * 成功概率 0.78 [0.62, 0.91]（12 次干预证据）」——
   * 下次调度的切换决策第一次有了反事实依据。
   *
   * @param outcomeNode 因果图的结果节点（默认 'task.outcome'）
   */
  reflectCounterfactual(params: {
    failedModelId: string;
    alternativeModelIds: string[];
    actualSuccess: boolean;
    outcomeNode?: string;
  }): CounterfactualInsight | null {
    if (!this.causal || params.alternativeModelIds.length === 0) return null;
    const outcome = params.outcomeNode ?? 'task.outcome';
    let best: CounterfactualInsight | null = null;
    for (const alt of params.alternativeModelIds) {
      if (alt === params.failedModelId) continue;
      const cf = this.causal.counterfactual(outcome, params.failedModelId, alt, params.actualSuccess);
      if (!best || cf.estimatedProb > best.estimatedProb) {
        best = {
          actualModel: params.failedModelId,
          bestAlternative: alt,
          estimatedProb: cf.estimatedProb,
          lower: cf.lower,
          upper: cf.upper,
          verdict: cf.verdict,
          evidenceSamples: cf.evidenceSamples,
        };
      }
    }
    return best;
  }

  /**
   * 对单个节点输出做深度反思
   * @param params 节点输出与上下文
   * @returns 反思结论
   */
  async reflect(params: {
    node: { id: string; description: string; type: string };
    output: string;
    baseQuality: number;
    signal: Signal;
  }): Promise<ReflectionVerdict> {
    let quality = params.baseQuality;
    let dimensions: ReflectionVerdict['dimensions'];

    // LLM-as-judge 评审（可用时）
    if (this.config.judge) {
      try {
        const judged = await this.config.judge({
          taskDescription: params.node.description,
          output: params.output,
          taskType: params.node.type,
        });
        // 评审分与执行器自评分加权（评审占 70%）
        quality = judged.score * 0.7 + params.baseQuality * 0.3;
        dimensions = {
          completeness: judged.completeness,
          correctness: judged.correctness,
          maintainability: judged.maintainability,
          comment: judged.comment,
        };
      } catch {
        /* 评审失败回退基础质量分 */
      }
    }

    const passed = quality >= this.currentThreshold;
    const retryAdvice = this.adviseRetry(params.node.type, quality, passed);

    return {
      quality,
      passed,
      retryAdvice,
      reason: passed
        ? `质量 ${quality.toFixed(2)} ≥ 动态阈值 ${this.currentThreshold.toFixed(2)}`
        : `质量 ${quality.toFixed(2)} < 动态阈值 ${this.currentThreshold.toFixed(2)}，建议 ${retryAdvice}`,
      dimensions,
    };
  }

  /**
   * 从失败执行中提取教训（异步，失败不阻塞主流程）
   * @param params 失败上下文
   * @returns 提取的教训
   */
  async extractLesson(params: {
    signal: Signal;
    taskType: string;
    result: PlanExecutionResult;
    plan: ExecutionPlan;
  }): Promise<Lesson | null> {
    const failed = params.result.nodeResults.find((r) => !r.success);
    if (!failed) return null;

    let rootCause: RootCauseCategory = 'unknown';
    let lesson = '';
    let suggestion = '';

    if (this.config.lessonExtractor) {
      try {
        const extracted = await this.config.lessonExtractor({
          signalDescription: params.signal.description,
          taskType: params.taskType,
          errorMessage: failed.error ?? '',
          failedNodeId: failed.nodeId,
          failedModelId: failed.modelId,
        });
        rootCause = extracted.rootCause;
        lesson = extracted.lesson;
        suggestion = extracted.suggestion;
      } catch {
        /* 落入规则化提取 */
      }
    }

    // 规则化兜底提取
    if (!lesson) {
      const err = (failed.error ?? '').toLowerCase();
      if (err.includes('超时') || err.includes('timeout')) {
        rootCause = 'timeout';
        lesson = `任务类型 ${params.taskType} 在模型 ${failed.modelId} 上超时`;
        suggestion = '增大节点超时或拆分任务粒度';
      } else if (err.includes('质量不达标')) {
        rootCause = 'model-capability';
        lesson = `模型 ${failed.modelId} 对 ${params.taskType} 类任务质量不足（重试 ${failed.attempts} 次未达标）`;
        suggestion = '切换到该任务类型能力更强的模型';
      } else if (err.includes('依赖')) {
        rootCause = 'dependency';
        lesson = `上游依赖产出异常导致节点 ${failed.nodeId} 失败`;
        suggestion = '检查上游节点质量或增加依赖校验';
      } else {
        rootCause = 'transient';
        lesson = `节点 ${failed.nodeId} 执行失败: ${failed.error ?? '未知'}`;
        suggestion = '重试或检查瞬时故障';
      }
    }

    const record: Lesson = {
      id: `lesson-${++this.lessonCounter}`,
      timestamp: Date.now(),
      taskType: params.taskType,
      rootCause,
      lesson,
      suggestion,
      signalDescription: params.signal.description,
    };

    // 5.0：反事实反思 —— 失败不仅归因，还要推理「若选 B」。
    // 教训携带因果区间估计回流优化器：根因是 model-capability 且
    // 替代证据充分时，suggestion 升级为带概率的定向切换指令。
    if (this.causal && rootCause === 'model-capability') {
      const modelsOnPlan = [...new Set(params.result.nodeResults.map((r) => r.modelId).filter(Boolean))];
      const alternatives = modelsOnPlan.filter((m) => m && m !== failed.modelId);
      const cf = this.reflectCounterfactual({
        failedModelId: failed.modelId ?? '',
        alternativeModelIds: alternatives,
        actualSuccess: false,
      });
      if (cf) {
        record.counterfactual = cf;
        if (cf.evidenceSamples >= 4 && cf.estimatedProb >= 0.6) {
          record.suggestion = `反事实证据：切换到 ${cf.bestAlternative}（估计成功概率 ${cf.estimatedProb.toFixed(2)}，区间 [${cf.lower.toFixed(2)}, ${cf.upper.toFixed(2)}]，${cf.evidenceSamples} 证据样本）`;
        } else {
          record.suggestion = `${record.suggestion}；反事实证据不足（${cf.evidenceSamples} 样本），建议对 ${cf.bestAlternative} 安排因果实验`;
        }
      }
    }

    this.lessons.push(record);
    if (this.lessons.length > 100) this.lessons.shift();
    return record;
  }

  /**
   * 记录一次执行结果到趋势窗口并触发自校准
   * @param taskType 任务类型
   * @param quality 平均质量分
   * @param success 是否成功
   */
  recordExecution(taskType: string, quality: number, success: boolean): void {
    this.trendWindow.push({ timestamp: Date.now(), taskType, avgQuality: quality, success });
    if (this.trendWindow.length > this.config.trendWindowSize) this.trendWindow.shift();

    const history = this.qualityHistory.get(taskType) ?? [];
    history.push({ quality, at: Date.now() });
    // 13.0：风险受控路径需要样本深度（经验伯恩斯坦上界以 ~7ln(1/β)/(3n)
    // 收敛——95% 置信 × 19 候选网格认证 ≤15% 风险约需 94+ 样本），
    // 挂载后扩容至 200；未挂载维持 4.0 的 50 条轻量口径（零漂移）
    const cap = this.riskControl ? 200 : 50;
    if (history.length > cap) history.shift();
    this.qualityHistory.set(taskType, history);

    this.checkDeclineAlert(taskType, history);
    this.calibrateThreshold(taskType, history);
  }

  /** 当前动态质量阈值 */
  getCurrentThreshold(): number {
    return this.currentThreshold;
  }

  /** 设置质量阈值（元认知自调优落地入口，限制在允许范围内） */
  setQualityThreshold(value: number): void {
    const [min, max] = this.config.thresholdRange;
    this.currentThreshold = Math.max(min, Math.min(max, value));
  }

  /** 获取指定任务类型的相关教训（供计划生成引用） */
  getLessons(taskType: string, limit = 5): Lesson[] {
    return this.lessons.filter((l) => l.taskType === taskType).slice(-limit);
  }

  /** 全部教训 */
  getAllLessons(): Lesson[] {
    return [...this.lessons];
  }

  /**
   * 直接追加一条结构化教训（轻量入口，无需完整 PlanExecutionResult）。
   * 供宿主融合层等外部观测面在宿主工具连续失败时沉淀经验。
   * @param params 教训字段（id / timestamp 自动补齐）
   * @returns 追加的 Lesson
   */
  addLesson(params: {
    taskType: string;
    rootCause: RootCauseCategory;
    lesson: string;
    suggestion: string;
    signalDescription: string;
  }): Lesson {
    const record: Lesson = {
      id: `lesson-${++this.lessonCounter}`,
      timestamp: Date.now(),
      taskType: params.taskType,
      rootCause: params.rootCause,
      lesson: params.lesson,
      suggestion: params.suggestion,
      signalDescription: params.signalDescription,
    };
    this.lessons.push(record);
    if (this.lessons.length > 100) this.lessons.shift();
    return record;
  }

  /** 质量趋势摘要 */
  getTrendSummary(): TrendSummary {
    const byType = new Map<string, QualityTrendPoint[]>();
    for (const point of this.trendWindow) {
      const list = byType.get(point.taskType) ?? [];
      list.push(point);
      byType.set(point.taskType, list);
    }
    const summary: TrendSummary['byType'] = {};
    for (const [type, points] of byType) {
      const qualities = points.map((p) => p.avgQuality);
      summary[type] = {
        samples: points.length,
        avgQuality: qualities.reduce((a, b) => a + b, 0) / qualities.length,
        successRate: points.filter((p) => p.success).length / points.length,
        trending: this.trendDirection(qualities),
      };
    }
    return {
      threshold: this.currentThreshold,
      windowSize: this.trendWindow.length,
      byType: summary,
      ...(this.thresholdBasis ? { basis: this.thresholdBasis } : {}),
    };
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /**
   * 重试建议：依据教训库与根因判断（固定规则——未挂载 bandit 时的缺省口径）
   *
   * A6 升级 3：挂载 attachRetryBandit 后，编排层优先消费 retryBanditDecide
   * 的成本学习决策；本固定规则保留为未挂载缺省与 bandit 的对照基线
   * （零漂移：函数体一字未动）。
   */
  private adviseRetry(taskType: string, quality: number, passed: boolean): ReflectionVerdict['retryAdvice'] {
    if (passed) return 'no-retry';
    // 差距过大（< 阈值的 60%）：原模型重试无意义，直接换模型
    if (quality < this.currentThreshold * 0.6) return 'retry-switch';
    // 有"模型能力不足"教训：直接换模型
    const capabilityLesson = this.lessons.some((l) => l.taskType === taskType && l.rootCause === 'model-capability');
    if (capabilityLesson) return 'retry-switch';
    return 'retry-same';
  }

  /** 质量下滑告警检测 */
  private checkDeclineAlert(taskType: string, history: Array<{ quality: number; at: number }>): void {
    if (history.length < this.config.declineAlertCount + 1) return;
    const recent = history.slice(-this.config.declineAlertCount).map((h) => h.quality);
    let declining = true;
    for (let i = 1; i < recent.length; i += 1) {
      if (recent[i] >= recent[i - 1]) {
        declining = false;
        break;
      }
    }
    if (declining && this.onAlert) {
      this.onAlert({
        type: 'quality-decline',
        message: `任务类型 ${taskType} 质量连续 ${this.config.declineAlertCount} 次下滑（${recent.map((q) => q.toFixed(2)).join(' → ')}）`,
        taskType,
      });
    }
  }

  /**
   * 阈值自校准
   *
   * 13.0 质变（风险受控选择）：挂载 attachRiskController 后，校准从
   * 「时间衰减均值 ±0.02 步进」升级为分布无关的带保证选择——
   * 对候选网格逐一计算「质量 < λ 即重试」的风险上界（经验伯恩斯坦 +
   * Bonferroni 分摊），取上界 ≤ targetRisk 的最严格 λ：
   *   P(未来重试率 ≤ targetRisk) ≥ confidence
   * 重试率第一次被钉在数学上限之内；无合格候选（能力全面不足）时
   * 保持现阈值不动（宁可不调，不可越界）。
   *
   * 未挂载时维持 4.0 行为（半衰期 30 天时间加权均值 ±0.02 步进）。
   */
  private calibrateThreshold(taskType: string, history: Array<{ quality: number; at: number }>): void {
    if (history.length < this.config.calibrationMinSamples) return;
    const [min, max] = this.config.thresholdRange;

    // 13.0：风险受控路径（带数学保证）
    if (this.riskControl) {
      const grid: number[] = [];
      for (let i = 0; i <= this.riskControl.gridSteps; i += 1) {
        grid.push(Number((min + ((max - min) * i) / this.riskControl.gridSteps).toFixed(4)));
      }
      const result = selectRiskControlledThreshold(
        history.map((h) => h.quality),
        grid,
        { targetRisk: this.riskControl.targetRisk, confidence: this.riskControl.confidence },
      );
      if (result) {
        this.currentThreshold = result.threshold; // 网格值天然落在 thresholdRange 内
        this.thresholdBasis = result;
      } else {
        // 连最低门槛的风险上界都超 targetRisk：证据不足以安全收紧，
        // 保持现阈值（诚实不动优于激进越界）
        this.thresholdBasis = undefined;
      }
      return;
    }

    // 4.0 回退路径：时间衰减均值 ±0.02 步进（未挂载时的既有行为）
    const now = Date.now();
    let weighted = 0;
    let totalWeight = 0;
    for (const point of history) {
      const weight = decayFactor(Math.max(0, now - point.at));
      weighted += point.quality * weight;
      totalWeight += weight;
    }
    const avg = totalWeight > 0 ? weighted / totalWeight : 0.5;

    if (avg > this.currentThreshold + 0.15) {
      // 质量普遍优秀：收紧阈值追求卓越
      this.currentThreshold = Math.min(max, this.currentThreshold + this.config.calibrationStep);
    } else if (avg < this.currentThreshold - 0.15) {
      // 质量普遍偏低：放宽阈值避免无效重试风暴
      this.currentThreshold = Math.max(min, this.currentThreshold - this.config.calibrationStep);
    }
  }

  /** 趋势方向判断 */
  private trendDirection(qualities: number[]): 'rising' | 'falling' | 'stable' {
    if (qualities.length < 3) return 'stable';
    const half = Math.floor(qualities.length / 2);
    const firstAvg = qualities.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const secondAvg = qualities.slice(half).reduce((a, b) => a + b, 0) / (qualities.length - half);
    if (secondAvg - firstAvg > 0.05) return 'rising';
    if (firstAvg - secondAvg > 0.05) return 'falling';
    return 'stable';
  }
}

/**
 * A6 升级 3：bandit 探索的确定性随机源（文件内 mulberry32——同 seed 同
 * 决策序列，验证脚本可逐位复现；与内核文件的做法一致，零宿主依赖）。
 */
function mulberry32Local(seed: number): () => number {
  let a = Math.floor(seed) >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
