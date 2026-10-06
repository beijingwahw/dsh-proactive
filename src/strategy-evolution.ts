/**
 * strategy-evolution.ts — 决策策略在线进化引擎（"彻底自主智能"核心组件 3/4）
 *
 * 职责：让决策引擎的超参数不再是人工拍定的静态值，
 * 而是一个随运行反馈持续进化的"策略基因库"。
 *
 * 能力矩阵：
 * 1. 策略基因组：每个基因组是一组决策引擎超参数
 *    （抑制窗口 / 失败升级阈值 / 低置信阈值 / 成本延迟比 / 突发判定）
 * 2. UCB1 探索-利用平衡：选择基因组时兼顾历史收益与探索不足度，
 *    避免陷入局部最优，新变异体有机会被验证
 * 3. 适应度反馈：每次决策的实际结果（outcome → reward）回写基因组，
 *    平均收益即适应度
 * 4. 锦标赛进化：累计足够样本后触发进化——精英保留 + 锦标赛选择父代 +
 *    高斯变异产生后代，淘汰最弱个体，种群整体适应度单调爬升
 * 5. 最优基因组推荐：进化产物直接落地为决策引擎的新配置
 *
 * 4.0 证据化升级：
 * - 基因组携带 MemoryEvidence（时间加权 Beta 证据，半衰期 30 天），
 *   outcome 的连续收益（0~1）经加权观测累积——旧决策结果自然让位
 * - 适应度从裸 meanReward 升级为证据后验的 Wilson 置信下界
 *   （小样本保守、防侥幸），UCB 利用项同源——探索-利用在同一统计口径下平衡
 * - 修复淘汰逻辑 bug：精英保护过滤条件错误（elites 不足额时全员成为
 *   survivors，精英可能被误淘汰）——修正为严格排除精英
 *
 * 第三轮世界性升级（谱系 × 算子治理 × 预算/停滞）：
 * - 进化谱系追踪：每个基因组的出生登记（父代 / 变异算子 / 出生时父代
 *   适应度 / 是否存活 / 是否上线），谱系回溯查询（lineageOf 祖先链 /
 *   descendantsOf 子树 / lineageReport 全树）——进化从黑箱变成可审计的
 *   版本树；被淘汰个体不消失（台账永久留痕）
 * - 变异算子组合治理：变异从单一高斯概率升级为多算子组合（高斯微调 /
 *   大步长联合跳 / 边界极值探索 / 基准回退），每种算子独立统计近期
 *   成功率（EWMA 信用），softmax 带温度选择——「某算子持续劣化」时
 *   权重自动下降、选择转移（attachOperatorGovernance 挂载，零漂移旁路）
 * - 进化预算记账：每代消耗（真实决策反馈数 + 变异后代数）入账，
 *   预算耗尽拒开新代（进化不能无限烧反馈样本）
 * - 停滞检测重启：最优适应度 N 代无进展 → 注入行为距离最大的多样化
 *   个体（最远点采样，借 91.0 新奇思想）——打破局部平台后计时复位
 *   （attachStagnationRestart 挂载，零漂移旁路）
 *
 * 第四轮升级（激活与深化——全新维度，全部 opt-in、缺省零漂移）：
 * - 多样性仪表：种群基因多样性的实时监控——成对归一化基因距离矩阵的
 *   均值/最近邻（收敛坍缩前兆）+ 行为描述子分布熵（有效 niche 数 =
 *   2^H Hill 数）；跌破阈值即预警，可自动注入多样化个体（与第三轮停滞
 *   重启共用最远点采样，但触发判据是「多样性」而非「停滞」）——每代
 *   快照入档，坍缩轨迹可审计（attachDiversityDashboard 挂载，零漂移旁路）
 * - 进化速率自适应：环境平稳（连续多代适应度无有效进展）→ 降频进化
 *   （应用门槛 ×N，省算力，被挡下的进化次数记账）；适应度地形突变
 *   （决策回报近期/前期窗口均值差 ≥ 阈）→ 立即进化（无视应用门槛）并
 *   恢复全速——两档速率切换全台账（attachAdaptiveRate 挂载，零漂移旁路）
 * - 进化冻结协议：进化暂停状态机 running → frozen（连续 N 代无后代
 *   改进 / 预算耗尽 / 外部指令）→ 冷却（以被挡下的 evolve 尝试计）→
 *   probing（一次保守试探：单点替换 + 变异强度减半）→ 依试探代后代
 *   结算裁决回到 running 或重新 frozen（attachFreezeProtocol 挂载）
 */

import type { DecisionEngineConfig } from './decision-engine.js';
import { initEvidence, observeWeightedEvidence, wilsonLowerBound, type MemoryEvidence } from './core/evidence.js';
import { AnytimeEvidenceRegistry, type AnytimeEvidenceRegistryReport, type AnytimeEvidenceView } from './core/anytime-evidence.js';
import { MapElitesArchive, STRATEGY_BEHAVIOR_SPACE, strategyBehaviorDescriptor, type QualityDiversityMetrics } from './core/quality-diversity.js';
import { FisherGeometryEngine, type InformationGeometryReport } from './core/information-geometry.js';
// 创世纪 58.0/66.0：朗之万采样诊断（变异分布健康度）/ 退火势阱深度（全局逃逸体检）
import { populationLangevinDiagnostics } from './engines-frontier/genesis25.js';
import { wellDepth } from './core/simulated-annealing.js';

// 第二轮创世纪 92.0：自我对弈（对抗压力审计——适应度高 ∧ 难以被针对）
import { adversarialPressureAudit, type AdversarialPressureView } from './engines-frontier/autonomy25.js';

/** 基因组基因（决策引擎可调超参数子集） */
export interface StrategyGenes {
  suppressionWindowMs: number;
  failureEscalationThreshold: number;
  lowConfidenceThreshold: number;
  costDeferRatio: number;
  burstOccurrences: number;
}

/** 策略基因组 */
export interface StrategyGenome {
  id: string;
  genes: StrategyGenes;
  /** 应用次数 */
  applications: number;
  /** 累计收益 */
  totalReward: number;
  /** 平均收益（适应度） */
  meanReward: number;
  /** 时间加权证据（4.0：连续收益证据化；旧数据无此字段回退 meanReward） */
  evidence?: MemoryEvidence;
  generation: number;
  createdAt: number;
  /** 第三轮升级：父代基因组 id（谱系追踪；种子/重启注入个体无父代） */
  parentId?: string;
  /** 第三轮升级：出生所经变异算子（seed / gaussian / large-step / boundary / baseline-reset / natural-gradient / restart-diversify） */
  mutationOperator?: string;
}

/** 谱系节点（版本树台账：含已淘汰与已上线的全量个体） */
export interface LineageNode {
  id: string;
  /** 父代 id（种子个体与重启注入个体为根节点，无父代） */
  parentId?: string;
  /** 出生所经变异算子 */
  operator: string;
  generation: number;
  bornAt: number;
  /** 出生时刻父代的平均收益快照（算子信用回填的比较基准——meanReward 无小样本证据惩罚，父子同口径公平比较） */
  parentFitnessAtBirth?: number;
  /** 最近一次适应度快照（进化时更新） */
  fitness?: number;
  /** 是否仍在种群中 */
  alive: boolean;
  /** 淘汰代际（存活个体为空） */
  eliminatedAtGeneration?: number;
  /** 上线时间（markDeployed 标记——「进化产物落地为决策引擎配置」的时刻） */
  deployedAt?: number;
  /** 算子信用是否已回填（每个个体只结算一次） */
  credited: boolean;
}

/** 进化报告 */
export interface EvolutionReport {
  generation: number;
  elites: string[];
  born: string[];
  eliminated: string[];
  bestMeanReward: number;
  populationMeanReward: number;
  /** 第三轮升级：本代停滞重启注入的多样化个体 id（无重启为空） */
  restarts?: string[];
  /** 第四轮升级：本代多样性仪表注入的多样化个体 id（未挂载/无注入为空） */
  diversifications?: string[];
}

/** 变异算子统计（组合治理可观测） */
export interface MutationOperatorStat {
  name: string;
  /** 近期成功率 EWMA（信用分 0~1，缺省 0.5） */
  ewma: number;
  /** softmax 选择概率（温度 τ 归一，Σ = 1） */
  probability: number;
  /** 累计被选中次数 */
  selections: number;
  /** 已结算信用的后代数 */
  credits: number;
  /** 其中适应度超过出生时父代的后代数 */
  successes: number;
}

/** 算子组合治理配置 */
export interface OperatorGovernanceOptions {
  /** softmax 温度（越小权重差异越尖锐；缺省 0.15） */
  temperature?: number;
  /** EWMA 学习率（缺省 0.25） */
  learningRate?: number;
}

/** 停滞重启配置（91.0 新奇思想的沙盒化：注入行为距离大的个体） */
export interface StagnationRestartOptions {
  /** 最优适应度连续多少代无进展触发重启（缺省 3） */
  patience?: number;
  /** 判定为「有进展」的最小适应度提升（缺省 1e-6） */
  minImprovement?: number;
  /** 每次重启注入的多样化个体数（缺省 2） */
  injectCount?: number;
  /** 热身代数（此前即使无进展也不重启；缺省 2） */
  minGenerations?: number;
  /** 最远点采样的候选池大小（缺省 8） */
  candidatePool?: number;
}

/** 停滞重启事件（审计台账） */
export interface StagnationRestartEvent {
  generation: number;
  /** 注入的多样化个体 id */
  injected: string[];
  /** 注入个体与种群的最小归一化距离²（行为距离读数） */
  minSquaredDistance: number;
  reason: string;
}

/** 进化预算报告（每代消耗记账） */
export interface EvolutionBudgetReport {
  /** 预算上限（未设置 = 无限） */
  cap?: number;
  /** 累计消耗（真实决策反馈数 + 变异后代数，逐代累加） */
  spent: number;
  /** 剩余预算（无上限为 Infinity） */
  remaining: number;
  /** 已完成进化代数 */
  generations: number;
  /** 预算是否已耗尽（此后 evolve 拒开新代） */
  exhausted: boolean;
  /** 逐代记账台账（含拒绝记录） */
  ledger: Array<{ generation: number; cost: number; cumulative: number; refused: boolean }>;
}

// ─────────────────────────── 第四轮升级：多样性仪表 ───────────────────────────

/** 种群多样性读数（基因距离矩阵 + 行为描述子分布熵） */
export interface DiversityMetrics {
  generation: number;
  populationSize: number;
  /** 成对归一化基因欧氏距离的均值（0 = 全种群克隆） */
  meanGeneDistance: number;
  /** 基因距离矩阵最小值（最近邻距离——收敛坍缩的前兆读数） */
  minGeneDistance: number;
  /** 行为描述子分布熵（bit；0 = 全种群挤在同一行为 niche） */
  behaviorEntropyBits: number;
  /** 有效行为 niche 数（2^H，Hill 数：1 = 坍缩为单一行为，n = 全散开） */
  effectiveNiches: number;
  /** 低多样性预警（均值/最近邻/熵任一跌破阈值且种群 ≥ 3） */
  warning: boolean;
}

/** 多样性仪表配置 */
export interface DiversityDashboardOptions {
  /** 均值基因距离预警阈（缺省 0.06） */
  meanDistanceFloor?: number;
  /** 最近邻基因距离预警阈（缺省 0.015） */
  minDistanceFloor?: number;
  /** 行为熵预警阈（bit；缺省 1.0 ≈ 有效 niche 不足 2 个） */
  entropyFloor?: number;
  /** 预警时自动注入多样化个体（缺省 true；false = 只预警不干预） */
  autoInject?: boolean;
  /** 每次注入的个体数（缺省 2） */
  injectCount?: number;
  /** 最远点采样候选池大小（缺省 8） */
  candidatePool?: number;
  /** 仪表历史长度（缺省 64） */
  historyLimit?: number;
}

/** 多样性事件台账（预警 + 注入留痕） */
export interface DiversityEvent {
  generation: number;
  /** 预警依据（注入前读数） */
  before: DiversityMetrics;
  /** 注入后读数（未注入为空——恢复效果可审计） */
  after?: DiversityMetrics;
  /** 注入的多样化个体 id（autoInject=false 时为空） */
  injected: string[];
  reason: string;
}

/** 多样性仪表报告 */
export interface DiversityDashboardReport {
  /** 当前种群实时读数 */
  current: DiversityMetrics;
  /** 逐代快照（坍缩/恢复轨迹） */
  history: DiversityMetrics[];
  /** 预警与注入事件台账 */
  events: DiversityEvent[];
  /** 配置回显 */
  thresholds: { meanDistanceFloor: number; minDistanceFloor: number; entropyFloor: number; autoInject: boolean };
}

// ─────────────────────────── 第四轮升级：进化速率自适应 ───────────────────────────

/** 进化速率档位 */
export type EvolutionRateMode = 'normal' | 'reduced';

/** 速率自适应配置 */
export interface AdaptiveRateOptions {
  /** 突变检测窗口（决策回报近期/前期各 w 个；缺省 12） */
  shiftWindow?: number;
  /** 突变判定阈：|近期均值 − 前期均值| ≥ 该值判为适应度地形突变（缺省 0.15） */
  shiftThreshold?: number;
  /** 平稳多少代无有效进展后降频（缺省 2） */
  stationarityPatience?: number;
  /** 降频因子：降频档应用门槛 = 原门槛 × 该值（缺省 2） */
  reducedFactor?: number;
  /** 「有效进展」的最小适应度提升（缺省 0.01——wilson 小样本虚增不算进展） */
  improvementEpsilon?: number;
}

/** 适应度地形突变事件（recordOutcome 时刻即检测，先于下一次 evolve） */
export interface RateShiftEvent {
  generation: number;
  /** 触发时累计决策回报数 */
  atApplications: number;
  /** 近期窗口均值 − 前期窗口均值（负 = 环境恶化） */
  delta: number;
}

/** 速率自适应报告 */
export interface EvolutionRateReport {
  mode: EvolutionRateMode;
  /** 当前生效的应用门槛（normal = 原值；reduced = 原值 × reducedFactor） */
  effectiveMinApplications: number;
  /** 地形突变待响应（下一次 evolve 无视应用门槛立即执行） */
  pendingShift: boolean;
  /** 连续无有效进展代数 */
  quietGenerations: number;
  /** 突变事件台账（预警先于响应） */
  shifts: RateShiftEvent[];
  /** 档位切换台账 */
  modeSwitches: Array<{ generation: number; from: EvolutionRateMode; to: EvolutionRateMode; reason: string }>;
  /** 降频档省下的进化次数（被降频门槛挡下、原门槛本会执行的 evolve 调用数） */
  savedEvolutions: number;
}

// ─────────────────────────── 第四轮升级：进化冻结协议 ───────────────────────────

/** 冻结状态机档位 */
export type EvolutionFreezeState = 'running' | 'frozen' | 'probing';

/** 冻结协议配置 */
export interface FreezeProtocolOptions {
  /** 连续多少代「无任何成熟后代改进」判为进化失败 → 冻结（缺省 3） */
  maxFailedGenerations?: number;
  /** 冻结后多少次被挡下的 evolve 尝试完成冷却 → 进入保守试探（缺省 2） */
  cooldownAttempts?: number;
  /** 预算耗尽自动冻结（缺省 true） */
  freezeOnBudgetExhaustion?: boolean;
}

/** 冻结状态机迁移台账 */
export interface FreezeEvent {
  generation: number;
  from: EvolutionFreezeState;
  to: EvolutionFreezeState;
  reason: string;
}

/** 冻结协议报告 */
export interface FreezeReport {
  state: EvolutionFreezeState;
  /** 冻结原因（state ≠ running 时非空） */
  reason?: string;
  /** 冻结生效代际 */
  frozenAtGeneration?: number;
  /** 冷却剩余尝试次数（state = frozen） */
  cooldownRemaining?: number;
  /** 保守试探代际（已执行过试探时非空） */
  probeGeneration?: number;
  /** 冻结期间被挡下的 evolve 调用数 */
  blockedAttempts: number;
  /** 状态机迁移台账 */
  events: FreezeEvent[];
}

/** 策略进化配置 */
export interface StrategyEvolutionConfig {
  /** 种群规模 */
  populationSize: number;
  /** UCB 探索常数 */
  explorationConstant: number;
  /** 变异概率（每个基因） */
  mutationRate: number;
  /** 变异强度（相对基因取值范围的比例） */
  mutationStrength: number;
  /** 精英保留数 */
  eliteCount: number;
  /** 触发进化所需的最小累计应用次数（相对上次进化） */
  minApplicationsBetweenEvolutions: number;
  /** 参与精英评定的最小应用次数（防止小样本侥幸） */
  minApplicationsForElite: number;
  /** 随机源（测试可注入确定性实现） */
  rng?: () => number;
  /**
   * 时钟源（测试可注入确定性实现；缺省 Date.now()）。
   * 时间加权证据（半衰期 30 天）按调用时刻衰减——真实时钟的毫秒边界
   * 会在并列适应度上引入 1e-7 级抖动；确定性实验注入虚拟时钟后
   * 同种子重跑位级一致（第四轮升级：注入时钟纪律）。
   */
  clock?: () => number;
  /** 第三轮升级：变异算子组合治理（挂载即启用；缺省关闭 = 原单一高斯路径，零漂移） */
  operatorGovernance?: OperatorGovernanceOptions | boolean;
  /** 第三轮升级：停滞重启配置（挂载即启用；缺省关闭，零漂移） */
  stagnation?: StagnationRestartOptions | boolean;
  /** 第三轮升级：进化预算上限（真实决策反馈 + 变异后代的累计消耗；缺省无限） */
  evolutionBudget?: number;
  /** 第四轮升级：多样性仪表（挂载即启用；缺省关闭，零漂移） */
  diversity?: DiversityDashboardOptions | boolean;
  /** 第四轮升级：进化速率自适应（挂载即启用；缺省关闭，零漂移） */
  adaptiveRate?: AdaptiveRateOptions | boolean;
  /** 第四轮升级：进化冻结协议（挂载即启用；缺省关闭，零漂移） */
  freeze?: FreezeProtocolOptions | boolean;
}

/** 默认配置 */
export const DEFAULT_STRATEGY_EVOLUTION_CONFIG: StrategyEvolutionConfig = {
  populationSize: 6,
  explorationConstant: 1.4,
  mutationRate: 0.5,
  mutationStrength: 0.2,
  eliteCount: 2,
  minApplicationsBetweenEvolutions: 12,
  minApplicationsForElite: 3,
};

/** 基因取值边界 */
const GENE_BOUNDS: Record<keyof StrategyGenes, { min: number; max: number; integer: boolean }> = {
  suppressionWindowMs: { min: 30_000, max: 15 * 60_000, integer: true },
  failureEscalationThreshold: { min: 1, max: 8, integer: true },
  lowConfidenceThreshold: { min: 0.2, max: 0.7, integer: false },
  costDeferRatio: { min: 1, max: 10, integer: false },
  burstOccurrences: { min: 2, max: 12, integer: true },
};

/** 基准基因组（决策引擎默认配置） */
const BASELINE_GENES: StrategyGenes = {
  suppressionWindowMs: 5 * 60_000,
  failureEscalationThreshold: 3,
  lowConfidenceThreshold: 0.4,
  costDeferRatio: 3,
  burstOccurrences: 5,
};

/** outcome → 收益映射 */
const OUTCOME_REWARD: Record<string, number> = {
  excellent: 1,
  good: 0.8,
  acceptable: 0.6,
  poor: 0.3,
  failed: 0,
};

/** 种群报告（运维可观测） */
export interface EvolutionStatusReport {
  generation: number;
  populationSize: number;
  applicationsSinceEvolution: number;
  populationMeanReward: number;
  genomes: Array<{ id: string; generation: number; applications: number; meanReward: number; genes: StrategyGenes }>;
  bestGenome: string;
  recentEvolutions: EvolutionReport[];
  /** 14.0：质量-多样性指标（attachQualityDiversity 后输出） */
  qd?: QualityDiversityMetrics;
  /** 12.0：任意时刻证据报告（attachAnytimeEvidence 后输出） */
  anytime?: AnytimeEvidenceRegistryReport;
  /** 18.0：搜索几何报告（attachInformationGeometry 后输出） */
  geometry?: InformationGeometryReport;
  /** 第三轮升级：进化谱系树摘要（始终输出——纯记账零漂移） */
  lineage?: { size: number; roots: string[]; depth: number; alive: number; deployed: number };
  /** 第三轮升级：变异算子组合统计（attachOperatorGovernance 后输出） */
  operators?: MutationOperatorStat[];
  /** 第三轮升级：进化预算报告（attachEvolutionBudget / 配置后输出） */
  budget?: EvolutionBudgetReport;
  /** 第三轮升级：停滞重启事件台账（attachStagnationRestart 后输出） */
  restarts?: StagnationRestartEvent[];
  /** 第四轮升级：多样性仪表（attachDiversityDashboard 后输出） */
  diversity?: DiversityDashboardReport;
  /** 第四轮升级：速率自适应（attachAdaptiveRate 后输出） */
  rate?: EvolutionRateReport;
  /** 第四轮升级：冻结协议（attachFreezeProtocol 后输出） */
  freeze?: FreezeReport;
}

/**
 * 决策策略在线进化引擎
 *
 * 被 index.ts 持有：决策引擎每次决策前通过 selectGenome() 获取当前基因组
 * （其基因作为决策引擎运行时参数），决策结果经 recordOutcome() 回写适应度，
 * autonomy-loop 定期调用 evolve() 驱动种群进化。
 *
 * 12.0 移植（attachAnytimeEvidence）：适应度从 Wilson 固定样本下界升级为
 * 任意时刻有效置信序列下界（流式统计永不夸大）；pruneProvablyDominated
 * 以 e-BH FDR 控制淘汰「证明确实低于水位线」的基因组——冤案率有数学上限。
 *
 * 14.0 移植（attachQualityDiversity）：selectGenome 的探索从纯 UCB 升级为
 * 「前沿 niche 均匀采样」——每种行为流派（敢为 × 节俭 × 警觉）获得等量
 * 试验预算；evolve 同步维护 MAP-Elites 归档，多样性可审计（coverage/QD-score）。
 * 两个移植均为并行旁路：不 attach 即零漂移。
 */
export class StrategyEvolutionEngine {
  private config: StrategyEvolutionConfig;
  private population: StrategyGenome[] = [];
  private genomeCounter = 0;
  private generation = 0;
  private applicationsSinceEvolution = 0;
  private evolutionHistory: EvolutionReport[] = [];
  private rng: () => number;
  /** 时钟源（缺省 Date.now()；确定性实验注入虚拟时钟——时间加权证据的衰减基准） */
  private clock: () => number;
  /** 12.0：任意时刻证据登记表（attach 后启用） */
  private anytime?: AnytimeEvidenceRegistry;
  /** 12.0：已淘汰基因组的 e-值台账（审计） */
  private anytimeEliminations: Array<{ id: string; eValue: number; at: number }> = [];
  /** 14.0：MAP-Elites 行为归档（attach 后启用） */
  private qdArchive?: MapElitesArchive<StrategyGenome>;
  /** 14.0：前沿 niche 采样概率（探索预算占比） */
  private qdExploreRate = 0.25;
  /** 18.0：Fisher 几何引擎（attach 后变异沿搜索流形测地方向） */
  private geometry?: FisherGeometryEngine;
  // ── 第三轮升级状态 ──
  /** 谱系台账：全量个体（含已淘汰）的版本树（纯记账，零行为漂移） */
  private lineage = new Map<string, LineageNode>();
  /** 算子组合治理配置（未挂载 = 单一高斯路径，零漂移） */
  private operatorGovernance?: { temperature: number; learningRate: number };
  /** 算子统计：name → { ewma, selections, credits, successes } */
  private operatorLedger = new Map<string, { ewma: number; selections: number; credits: number; successes: number }>();
  /** 停滞重启配置（未挂载 = 关闭，零漂移） */
  private stagnationCfg?: Required<StagnationRestartOptions>;
  /** 停滞重启事件台账 */
  private restartEvents: StagnationRestartEvent[] = [];
  /** 历史最优适应度（停滞检测基准） */
  private bestEverFitness = -Infinity;
  /** 最近一次适应度进展的代际 */
  private lastImprovementGeneration = 0;
  /** 进化预算上限（未设置 = 无限） */
  private evolutionBudgetCap?: number;
  /** 预算累计消耗 */
  private budgetSpent = 0;
  /** 预算逐代台账 */
  private budgetLedger: Array<{ generation: number; cost: number; cumulative: number; refused: boolean }> = [];
  /** 预算是否已耗尽（拒开新代后置位） */
  private budgetExhausted = false;
  // ── 第四轮升级状态 ──
  /** 多样性仪表配置（未挂载 = 关闭，零漂移） */
  private diversityCfg?: Required<DiversityDashboardOptions>;
  /** 多样性逐代快照（坍缩/恢复轨迹） */
  private diversityHistory: DiversityMetrics[] = [];
  /** 多样性预警/注入事件台账 */
  private diversityEvents: DiversityEvent[] = [];
  /** 速率自适应配置（未挂载 = 关闭，零漂移） */
  private rateCfg?: Required<AdaptiveRateOptions>;
  /** 当前速率档位 */
  private rateMode: EvolutionRateMode = 'normal';
  /** 地形突变待响应（下一次 evolve 立即执行） */
  private ratePendingShift = false;
  /** 连续无有效进展代数 */
  private rateQuietGenerations = 0;
  /** 决策回报环形窗口（近期 + 前期各 shiftWindow 个） */
  private rateRewards: number[] = [];
  /** 累计决策回报数 */
  private rateTotalOutcomes = 0;
  /** 突变事件台账 */
  private rateShifts: RateShiftEvent[] = [];
  /** 档位切换台账 */
  private rateModeSwitches: Array<{ generation: number; from: EvolutionRateMode; to: EvolutionRateMode; reason: string }> = [];
  /** 降频档省下的进化次数 */
  private rateSavedEvolutions = 0;
  /** 冻结协议配置（未挂载 = 关闭，零漂移） */
  private freezeCfg?: Required<FreezeProtocolOptions>;
  /** 冻结状态机档位 */
  private freezeState: EvolutionFreezeState = 'running';
  /** 冻结原因 */
  private freezeReason?: string;
  /** 冻结生效代际 */
  private frozenAtGeneration?: number;
  /** 冷却剩余尝试次数 */
  private freezeCooldownRemaining = 0;
  /** 冻结期间被挡下的 evolve 调用数 */
  private freezeBlockedAttempts = 0;
  /** 状态机迁移台账 */
  private freezeEvents: FreezeEvent[] = [];
  /** 连续失败代数（无任何成熟后代改进） */
  private failStreak = 0;
  /** 上一代出生的后代 id（冻结判定的结算对象） */
  private lastBornIds: string[] = [];
  /** 后代出生时刻的最优适应度基线（改进判据的比较基准） */
  private lastBornBaseline = 0;
  /** 保守试探代是否已执行、待结算裁决 */
  private probePendingVerdict = false;
  /** 最近一次保守试探代际 */
  private probeGenerationAt?: number;

  constructor(config?: Partial<StrategyEvolutionConfig>) {
    this.config = { ...DEFAULT_STRATEGY_EVOLUTION_CONFIG, ...config };
    this.rng = this.config.rng ?? Math.random;
    this.clock = this.config.clock ?? Date.now;
    this.initOperatorGovernance(this.config.operatorGovernance);
    this.initStagnation(this.config.stagnation);
    this.setEvolutionBudget(this.config.evolutionBudget);
    this.initDiversity(this.config.diversity);
    this.initAdaptiveRate(this.config.adaptiveRate);
    this.initFreeze(this.config.freeze);
    this.seedPopulation();
  }

  /**
   * 12.0：挂载任意时刻证据内核（幂等；挂载后适应度用置信序列下界，
   * recordOutcome 的收益同时喂入该基因组的 e-过程）。
   */
  attachAnytimeEvidence(options?: { alpha?: number; reference?: number }): void {
    this.anytime = new AnytimeEvidenceRegistry({ alpha: options?.alpha, reference: options?.reference });
  }

  /**
   * 14.0：挂载质量-多样性内核（幂等；挂载后 selectGenome 以
   * qdExploreRate 概率从行为归档均匀采样探索，evolve 同步维护归档）。
   */
  attachQualityDiversity(options?: { bins?: number[]; exploreRate?: number; rng?: () => number }): void {
    const bins = options?.bins ?? STRATEGY_BEHAVIOR_SPACE.defaultBins;
    this.qdExploreRate = options?.exploreRate ?? 0.25;
    this.qdArchive = new MapElitesArchive<StrategyGenome>({
      bins,
      ranges: STRATEGY_BEHAVIOR_SPACE.ranges,
      descriptor: (g) => strategyBehaviorDescriptor(g.genes),
      fitness: (g) => this.fitness(g),
      rng: options?.rng ?? this.rng,
      tieTolerance: 1e-9,
    });
    for (const genome of this.population) this.qdArchive.place(genome);
  }

  /**
   * 18.0：挂载信息几何内核（幂等；挂载后变异从坐标轴加噪升级为
   * Fisher 流形上的自然变异）。
   *
   * 变异路径变化：种群归一化协方差（Ledoit–Wolf 收缩）→ Cholesky
   * 主轴展开的**联合相关**变异（显性基因组合完整传递；各向同性
   * 加噪被结构性替代）→ KL 信任域（Mahalanobis 半径）封顶单步
   * 信息量——步长以 nat 计价，仿射重参数化下严格不变。
   * 几何每代进化前从当前种群重估。不 attach 即零漂移（原高斯路径）。
   */
  attachInformationGeometry(options?: { klBudget?: number; stepScale?: number; rng?: () => number }): void {
    this.geometry = new FisherGeometryEngine({
      klBudget: options?.klBudget,
      stepScale: options?.stepScale,
      rng: options?.rng ?? this.rng,
    });
    this.estimateGeometry();
  }

  /** 18.0：从当前种群重估搜索几何（归一化 [0,1]^d 参数空间） */
  private estimateGeometry(): void {
    if (!this.geometry) return;
    this.geometry.estimate(this.population.map((g) => normalizeGenes(g.genes)));
  }

  /** 18.0：几何诊断报告（未挂载返回 undefined） */
  geometryReport(): InformationGeometryReport | undefined {
    return this.geometry?.report();
  }

  /**
   * 58.0：挂载朗之万采样诊断（幂等覆盖，挂载即生效——只读体检口径）。
   *
   * 变异分布的健康读数：把当前种群基因向量的高斯近似（逐维均值/标准差）
   * 作为 MALA 目标后验采样，接受率（目标 0.574，Roberts–Rosenthal 最优
   * 尺度理论）与 W2（Bures 距离，样本矩 vs 真矩）即「按后验行走的采样器
   * 健康度」——接受率崩塌 = 适应度地形曲率突变信号，W2 超阈 = 采样器
   * 不健康应回退 18.0 原路径。不改变 evolve()/变异任何行为（零漂移）。
   */
  attachLangevinMutation(options?: { steps?: number; seed?: number }): void {
    this.langevinOptions = { steps: options?.steps ?? 300, seed: options?.seed ?? 7 };
  }

  /** 58.0：朗之万诊断配置（未挂载 undefined） */
  private langevinOptions?: { steps: number; seed: number };

  /** 58.0：种群朗之万诊断（未挂载 / 种群 <3 时 undefined） */
  langevinDiagnostics(): { dim: number; acceptRate: number; w2: number; samples: number } | undefined {
    if (!this.langevinOptions) return undefined;
    const vectors = this.population.map((g) => normalizeGenes(g.genes));
    return populationLangevinDiagnostics(vectors, this.langevinOptions);
  }

  /**
   * 66.0：挂载模拟退火逃逸诊断（幂等覆盖，挂载即生效——只读分析口径）。
   *
   * 全局逃逸的体检读数：种群在适应度线上的近邻格（按适应度排序的链）
   * 做 wellDepth 势阱深度估计——局部极小井深 c 与逃逸温度 T_c 的关系
   * （Metropolis 判据）第一次可计算：井越深，18.0 测地线精修越困在局部，
   * SA 才有出场价值（温度许可下接受劣化跳盆地）。不改变 evolve()
   * 任何行为（零漂移）。
   */
  attachAnnealingEscape(options?: { minDepth?: number }): void {
    this.annealingOptions = { minDepth: options?.minDepth ?? 1e-9 };
  }

  /** 66.0：退火逃逸诊断配置（未挂载 undefined） */
  private annealingOptions?: { minDepth: number };

  /**
   * 92.0：挂载自我对弈对抗审计（幂等覆盖，挂载即生效——影子计算口径）。
   *
   * 候选策略上线前先过 exploitability 审计：把「候选 vs 其余种群」建成
   * 零和矩阵博弈（收益 = 历史交互的期望得分表），可剥削度即该策略的
   * 弱点货币——QD 归档准入从「适应度高」升级为「适应度高 ∧ 难以被针对」
   * （防进化出欺负历史数据的偏科生）；leaguePlay 的 exploiter 池是可
   * 审计的失败模式档案（同一 pureIndex 反复出现 = 同一弱点未修复，应
   * 阻断晋升）。影子计算——不改变 evolve()/selectGenome()（零漂移）。
   */
  attachSelfPlay(options?: { leagueRounds?: number; seed?: number }): void {
    this.selfPlayOptions = { leagueRounds: options?.leagueRounds ?? 60, seed: options?.seed };
  }

  /** 92.0：自我对弈配置（未挂载 undefined） */
  private selfPlayOptions?: { leagueRounds: number; seed?: number };

  /**
   * 92.0：对抗压力审计（未挂载 / 收益矩阵非法时 undefined）。
   * @param payoff 行列对称的期望得分表（候选 × 对手——历史交互口径）
   * @param strategy 候选的混合策略（缺省均匀）
   */
  selfPlayAudit(
    payoff: ReadonlyArray<ReadonlyArray<number>>,
    strategy?: ReadonlyArray<number>,
  ): AdversarialPressureView | undefined {
    return this.selfPlayOptions
      ? adversarialPressureAudit(payoff, strategy ?? [], { leagueRounds: this.selfPlayOptions.leagueRounds, seed: this.selfPlayOptions.seed })
      : undefined;
  }

  /** 66.0：种群势阱深度报告（未挂载 / 种群 <3 时 undefined） */
  annealingEscapeReport(): import('./core/simulated-annealing.js').WellDepthReport | undefined {
    if (!this.annealingOptions) return undefined;
    if (this.population.length < 3) return undefined;
    const sorted = [...this.population].sort((a, b) => this.fitness(a) - this.fitness(b)); // 适应度升序链
    const energies: Record<string, number> = {};
    const adjacency: Record<string, string[]> = {};
    sorted.forEach((g, i) => {
      energies[g.id] = -this.fitness(g); // 能量 = 负适应度（井 = 局部最优谷）
      adjacency[g.id] = [
        ...(i > 0 ? [sorted[i - 1].id] : []),
        ...(i < sorted.length - 1 ? [sorted[i + 1].id] : []),
      ];
    });
    return wellDepth(energies, adjacency);
  }

  // ─────────────────────────── 第三轮升级：谱系 / 算子治理 / 预算 / 停滞 ───────────────────────────

  /**
   * 挂载变异算子组合治理（幂等覆盖，挂载即生效）。
   *
   * 变异从单一高斯概率升级为按近期成功率加权组合：gaussian（原逐基因
   * 微调）/ large-step（全基因联合大步）/ boundary（基因推向极值边界）/
   * baseline-reset（随机基因向基准回退）。每种算子独立维护信用 EWMA
   * （后代适应度是否超过出生时父代），softmax 带温度选择——某算子持续
   * 劣化时其权重自动下降，试验预算转移到近期有效的算子。
   * 不挂载 = 原高斯路径（随机数消耗序列逐位一致，零漂移）。
   */
  attachOperatorGovernance(options?: OperatorGovernanceOptions | boolean): void {
    this.initOperatorGovernance(options ?? true);
  }

  /** 算子组合统计（未挂载返回空数组；probability 为当前 softmax 权重） */
  operatorStats(): MutationOperatorStat[] {
    return [...this.operatorLedger.entries()].map(([name, s]) => ({
      name,
      ewma: Number(s.ewma.toFixed(4)),
      probability: this.operatorProbability(name),
      selections: s.selections,
      credits: s.credits,
      successes: s.successes,
    }));
  }

  /**
   * 挂载停滞重启（幂等覆盖，挂载即生效）。
   *
   * 最优适应度连续 patience 代无 > minImprovement 进展 → 判定陷入局部
   * 平台：从候选池中选与当前种群行为距离最大（最远点采样，归一化基因
   * 空间最小距离² 最大化）的个体注入，替换最弱非精英——借 91.0 新奇
   * 搜索思想用「行为距离」而非「适应度」破局；重启后停滞计时复位。
   * 不挂载 = 原进化路径（零漂移）。
   */
  attachStagnationRestart(options?: StagnationRestartOptions | boolean): void {
    this.initStagnation(options ?? true);
  }

  /** 停滞重启事件台账（未挂载返回空数组） */
  stagnationRestartEvents(): StagnationRestartEvent[] {
    return this.restartEvents.map((e) => ({ ...e, injected: [...e.injected] }));
  }

  /**
   * 设置进化预算上限（幂等覆盖）。
   *
   * 每代进化消耗 = 该代真实决策反馈数（applicationsSinceEvolution）+
   * 变异后代数（born，含重启注入）——进化花的每一份反馈样本都记账；
   * 累计消耗达上限后 evolve() 拒开新代（返回 null 并记录拒绝事件），
   * force 参数也绕不过预算（预算是硬约束，force 只免应用次数门槛）。
   */
  attachEvolutionBudget(cap: number): void {
    this.setEvolutionBudget(cap);
  }

  /** 进化预算报告（记账台账 + 耗尽状态；未设上限时 cap 为 undefined） */
  evolutionBudgetReport(): EvolutionBudgetReport {
    return {
      cap: this.evolutionBudgetCap,
      spent: this.budgetSpent,
      remaining: this.evolutionBudgetCap === undefined ? Infinity : Math.max(0, this.evolutionBudgetCap - this.budgetSpent),
      generations: this.budgetLedger.filter((e) => !e.refused).length,
      exhausted: this.budgetExhausted,
      ledger: this.budgetLedger.map((e) => ({ ...e })),
    };
  }

  /** 标记基因组上线（进化产物落地为决策引擎配置的时刻；缺省标记当前最优） */
  markDeployed(genomeId?: string): LineageNode | undefined {
    const id = genomeId ?? this.bestGenome().id;
    const node = this.lineage.get(id);
    if (!node) return undefined;
    if (node.deployedAt === undefined) node.deployedAt = this.clock();
    return { ...node };
  }

  /**
   * 谱系回溯：祖先链（根 → … → 该个体）。
   *
   * 沿 parentId 上溯至根（种子个体或重启注入个体）；环与深度上限
   * （64）防御性截断。个体不存在返回空数组。
   */
  lineageOf(genomeId: string): LineageNode[] {
    const chain: LineageNode[] = [];
    const visited = new Set<string>();
    let cursor = this.lineage.get(genomeId);
    while (cursor && !visited.has(cursor.id) && chain.length < 64) {
      visited.add(cursor.id);
      chain.unshift({ ...cursor });
      cursor = cursor.parentId ? this.lineage.get(cursor.parentId) : undefined;
    }
    return chain;
  }

  /** 谱系下探：全部后代（广度优先子树；个体不存在返回空数组） */
  descendantsOf(genomeId: string): LineageNode[] {
    if (!this.lineage.has(genomeId)) return [];
    const childrenOf = new Map<string, LineageNode[]>();
    for (const node of this.lineage.values()) {
      if (!node.parentId) continue;
      const list = childrenOf.get(node.parentId) ?? [];
      list.push(node);
      childrenOf.set(node.parentId, list);
    }
    const out: LineageNode[] = [];
    const queue = [genomeId];
    const seen = new Set<string>([genomeId]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const child of childrenOf.get(current) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push({ ...child });
        queue.push(child.id);
      }
    }
    return out.sort((a, b) => a.generation - b.generation || a.id.localeCompare(b.id));
  }

  /** 进化谱系全树报告（节点按代际排序；深度 = 最长祖先链） */
  lineageReport(): { size: number; roots: string[]; depth: number; alive: number; deployed: number; nodes: LineageNode[] } {
    const nodes = [...this.lineage.values()].sort((a, b) => a.generation - b.generation || a.id.localeCompare(b.id));
    let depth = 0;
    for (const node of nodes) depth = Math.max(depth, this.lineageOf(node.id).length);
    return {
      size: nodes.length,
      roots: nodes.filter((n) => !n.parentId).map((n) => n.id),
      depth,
      alive: nodes.filter((n) => n.alive).length,
      deployed: nodes.filter((n) => n.deployedAt !== undefined).length,
      nodes: nodes.map((n) => ({ ...n })),
    };
  }

  // ─────────────────────────── 第四轮升级：多样性仪表 / 速率自适应 / 冻结协议 ───────────────────────────

  /**
   * 挂载多样性仪表（幂等覆盖，挂载即生效）。
   *
   * 种群基因多样性的实时监控：成对归一化基因欧氏距离矩阵的均值与最近邻
   * （后者是收敛坍缩的前兆——最近的两个体先贴上），行为描述子
   * （敢为 × 节俭 × 警觉）分布的 Shannon 熵及其 Hill 数 2^H（有效行为
   * niche 数）。任一读数跌破阈值且种群 ≥ 3 → 预警事件入档；配置
   * autoInject（缺省开）时立即借停滞重启的最远点采样注入多样化个体
   * （注入前后读数都留档——恢复效果可审计）。与停滞重启的分工：停滞
   * 看「最优适应度是否还在涨」，多样性看「种群是否还在散开」——后者
   * 往往先于前者崩塌。不挂载 = 零漂移（不消耗任何随机数）。
   */
  attachDiversityDashboard(options?: DiversityDashboardOptions | boolean): void {
    this.initDiversity(options ?? true);
  }

  /** 多样性仪表报告（未挂载返回 undefined；纯计算不消耗随机数） */
  diversityReport(): DiversityDashboardReport | undefined {
    if (!this.diversityCfg) return undefined;
    return {
      current: this.computeDiversity(),
      history: this.diversityHistory.map((m) => ({ ...m })),
      events: this.diversityEvents.map((e) => ({ ...e, injected: [...e.injected] })),
      thresholds: {
        meanDistanceFloor: this.diversityCfg.meanDistanceFloor,
        minDistanceFloor: this.diversityCfg.minDistanceFloor,
        entropyFloor: this.diversityCfg.entropyFloor,
        autoInject: this.diversityCfg.autoInject,
      },
    };
  }

  /**
   * 挂载进化速率自适应（幂等覆盖，挂载即生效）。
   *
   * 两档速率：环境平稳（连续 stationarityPatience 代最优适应度无
   * > improvementEpsilon 的有效进展）→ 降频档（应用门槛 × reducedFactor
   * ——省算力，被挡下的进化次数入账 savedEvolutions）；适应度地形突变
   * （决策回报近期窗口均值 − 前期窗口均值 |Δ| ≥ shiftThreshold，在
   * recordOutcome 时刻即检测）→ pendingShift 置位，下一次 evolve() 无视
   * 应用门槛立即执行并恢复全速档。挂载不影响默认门槛与随机数序列
   * （零漂移：recordOutcome 只多记账，evolve 的门槛在 normal 档与原值相等）。
   */
  attachAdaptiveRate(options?: AdaptiveRateOptions | boolean): void {
    this.initAdaptiveRate(options ?? true);
  }

  /** 速率自适应报告（未挂载返回 undefined） */
  evolutionRateReport(): EvolutionRateReport | undefined {
    if (!this.rateCfg) return undefined;
    return {
      mode: this.rateMode,
      effectiveMinApplications: this.effectiveMinApplications(),
      pendingShift: this.ratePendingShift,
      quietGenerations: this.rateQuietGenerations,
      shifts: [...this.rateShifts],
      modeSwitches: [...this.rateModeSwitches],
      savedEvolutions: this.rateSavedEvolutions,
    };
  }

  /**
   * 挂载进化冻结协议（幂等覆盖，挂载即生效）。
   *
   * 进化暂停状态机：running →（连续 maxFailedGenerations 代无任何成熟
   * 后代改进 / 预算耗尽 / 外部指令 freezeEvolution）→ frozen（evolve
   * 全部挡下，不烧预算）→ 冷却 cooldownAttempts 次被挡下的尝试 →
   * probing（一次保守试探代：只替换最弱 1 个个体 + 变异强度减半）→
   * 依试探代后代的实际结算裁决：有改进回 running，仍无改进重新 frozen。
   * 外部 thawEvolution() 跳过剩余冷却直接进入保守试探。挂载且状态
   * running 时不改变任何进化行为（零漂移）。
   */
  attachFreezeProtocol(options?: FreezeProtocolOptions | boolean): void {
    this.initFreeze(options ?? true);
  }

  /** 外部指令：立即冻结进化（未挂载协议时自动以缺省配置挂载——外部冻结本身就是显式意图） */
  freezeEvolution(reason = '外部指令：暂停进化'): FreezeReport {
    if (!this.freezeCfg) this.initFreeze(true);
    if (this.freezeState === 'running') {
      this.enterFrozen(this.freezeState, reason);
    }
    return this.freezeReport()!;
  }

  /** 外部指令：解冻——跳过剩余冷却，直接进入一次保守试探（恢复协议 = 冷却 + 保守试探） */
  thawEvolution(): boolean {
    if (!this.freezeCfg || this.freezeState !== 'frozen') return false;
    this.freezeState = 'probing';
    this.freezeCooldownRemaining = 0;
    this.pushFreezeEvent('frozen', 'probing', '外部解冻指令：跳过剩余冷却，进入一次保守试探（单点替换 + 变异强度减半）');
    return true;
  }

  /** 冻结协议报告（未挂载返回 undefined） */
  freezeReport(): FreezeReport | undefined {
    if (!this.freezeCfg) return undefined;
    return {
      state: this.freezeState,
      reason: this.freezeState === 'running' ? undefined : this.freezeReason,
      frozenAtGeneration: this.frozenAtGeneration,
      cooldownRemaining: this.freezeState === 'frozen' ? this.freezeCooldownRemaining : undefined,
      probeGeneration: this.probeGenerationAt,
      blockedAttempts: this.freezeBlockedAttempts,
      events: [...this.freezeEvents],
    };
  }

  /**
   * UCB1 选择当前基因组（探索-利用平衡；4.0 利用项 = 证据化适应度）
   *
   * 利用项与适应度同源（Wilson 下界 × 置信折扣），探索项保持 UCB1
   * 对数置信宽度——探索与利用在同一证据口径下平衡。
   * @returns 选中的基因组
   */
  selectGenome(): StrategyGenome {
    // 14.0：前沿 niche 采样探索——以 qdExploreRate 概率从行为归档均匀
    // 抽一个「活法流派」的代表（每个流派等量试验预算；空归档自动跳过）
    if (this.qdArchive && this.qdArchive.occupiedNiches > 1 && this.rng() < this.qdExploreRate) {
      const sampled = this.qdArchive.sample();
      if (sampled && this.population.includes(sampled)) return sampled;
    }
    const totalApplications = this.population.reduce((sum, g) => sum + g.applications, 0);
    let best: StrategyGenome = this.population[0];
    let bestScore = -Infinity;
    for (const genome of this.population) {
      // 未应用过的基因组优先探索
      if (genome.applications === 0) return genome;
      const exploitation = this.fitness(genome);
      const exploration = this.config.explorationConstant * Math.sqrt(Math.log(totalApplications + 1) / genome.applications);
      const score = exploitation + exploration;
      if (score > bestScore) {
        bestScore = score;
        best = genome;
      }
    }
    return best;
  }

  /**
   * 回写决策结果（适应度反馈）
   * @param genomeId 基因组 id
   * @param outcome 决策执行后的实际结果
   */
  recordOutcome(genomeId: string, outcome: string): void {
    const genome = this.population.find((g) => g.id === genomeId);
    if (!genome) return;
    const reward = OUTCOME_REWARD[outcome] ?? 0.5;
    genome.applications += 1;
    genome.totalReward += reward;
    genome.meanReward = genome.totalReward / genome.applications;
    // 4.0 证据化：连续收益（0~1）按时间加权观测累积（惰性衰减 + 首次惰性初始化）
    const now = this.clock();
    if (!genome.evidence) genome.evidence = initEvidence(0, 0, now);
    observeWeightedEvidence(genome.evidence, reward, now);
    // 12.0：同一观测喂入任意时刻证据流（e-过程在任意停止时刻合法）
    this.anytime?.observe(genomeId, reward);
    // 第四轮升级：速率自适应的突变检测（环境剧变在回报时刻即被感知，先于下一次 evolve）
    if (this.rateCfg) this.noteRewardForRate(reward);
    this.applicationsSinceEvolution += 1;
  }

  /**
   * 触发一轮进化（精英保留 + 锦标赛选择 + 变异；第三轮升级叠加预算门 /
   * 算子信用结算 / 谱系标记 / 停滞重启）
   * @param force 强制进化（忽略最小应用次数门槛；预算门不受 force 豁免）
   * @returns 进化报告；未达门槛 / 预算耗尽时返回 null
   */
  evolve(force = false): EvolutionReport | null {
    // 第四轮升级：冻结协议门（外部指令/连续失败/预算耗尽 → 暂停进化；
    // 冷却以被挡下的 evolve 尝试计数，冷却完成自动进入保守试探。
    // force 不能绕过冻结——冻结是协议级硬约束，force 只免应用门槛）
    if (this.freezeCfg && !this.advanceFreezeGate()) return null;
    const probeActive = this.freezeCfg !== undefined && this.freezeState === 'probing';

    // 第四轮升级：速率自适应门槛（平稳降频 / 突变立即进化）。
    // 未挂载或 normal 档时门槛与原值逐位相等（零漂移）；pendingShift
    // 置位时无视应用门槛立即进化（环境剧变不能等攒样本）
    const immediate = force || this.ratePendingShift;
    if (!immediate && this.applicationsSinceEvolution < this.effectiveMinApplications()) {
      if (this.rateCfg && this.rateMode === 'reduced' && this.applicationsSinceEvolution >= this.config.minApplicationsBetweenEvolutions) {
        this.rateSavedEvolutions += 1; // 降频档省下的一次进化（原门槛本会执行）
      }
      return null;
    }

    // 第三轮升级：预算门（硬约束——进化不能无限烧反馈样本；耗尽即永久拒开新代）
    const applicationsConsumed = this.applicationsSinceEvolution;
    if (this.evolutionBudgetCap !== undefined) {
      if (this.budgetExhausted) {
        this.budgetLedger.push({ generation: this.generation + 1, cost: 0, cumulative: this.budgetSpent, refused: true });
        return null;
      }
      const estimatedBorn = Math.max(
        1,
        this.config.populationSize - Math.max(this.config.eliteCount, 1) - Math.floor(this.config.populationSize / 2),
      );
      if (this.budgetSpent + applicationsConsumed + estimatedBorn > this.evolutionBudgetCap) {
        this.budgetExhausted = true;
        this.budgetLedger.push({ generation: this.generation + 1, cost: 0, cumulative: this.budgetSpent, refused: true });
        if (this.freezeCfg?.freezeOnBudgetExhaustion) {
          this.enterFrozen('running', '进化预算耗尽，冻结进化（提高预算或 thawEvolution 后保守试探）');
        }
        return null;
      }
    }

    this.generation += 1;
    // 第四轮升级：试探代落地（进入 probing 后的第一次 evolve = 保守试探代）
    if (probeActive) {
      this.freezeState = 'running';
      this.probePendingVerdict = true;
      this.probeGenerationAt = this.generation;
      this.pushFreezeEvent(
        'probing',
        'running',
        `第 ${this.generation} 代为保守试探代（只替换最弱 1 个个体 + 变异强度减半），待其成熟后代结算裁决`,
      );
    }
    // 第四轮升级：地形突变响应记账（立即进化的同时恢复全速档）
    if (this.ratePendingShift) {
      this.ratePendingShift = false;
      this.rateQuietGenerations = 0;
      this.setRateMode('normal', `适应度地形突变响应：立即执行第 ${this.generation} 代进化并恢复全速档`);
    }
    // 18.0：进化前重估搜索几何（新一代种群 → 新协方差主轴）
    this.estimateGeometry();
    const ranked = [...this.population].sort((a, b) => this.fitness(b) - this.fitness(a));

    // 精英保留（需满足最小应用次数，防止小样本侥幸）
    const elites = ranked.filter((g) => g.applications >= this.config.minApplicationsForElite).slice(0, this.config.eliteCount);
    const report: EvolutionReport = {
      generation: this.generation,
      elites: elites.map((g) => g.id),
      born: [],
      eliminated: [],
      bestMeanReward: ranked[0]?.meanReward ?? 0,
      populationMeanReward: this.populationMeanReward(),
      ...(this.stagnationCfg ? { restarts: [] } : {}),
      ...(this.diversityCfg ? { diversifications: [] } : {}),
    };

    // 淘汰最弱个体（精英严格不淘汰——修复：原条件在精英不足额时全员入 survivors，
    // 精英保护失效），由变异后代顶替。保守试探代只替换 1 个（冻结恢复的最小步）
    const survivors = ranked.filter((g) => !elites.includes(g));
    const eliminateCount = probeActive
      ? 1
      : Math.max(1, this.config.populationSize - Math.max(elites.length, 1) - Math.floor(this.config.populationSize / 2));
    const eliminated = survivors.slice(-eliminateCount);
    report.eliminated = eliminated.map((g) => g.id);

    // 锦标赛选择父代 + 变异产生后代（保守试探代变异强度减半）
    for (const dead of eliminated) {
      const parent = this.tournamentSelect(elites.length > 0 ? elites : ranked);
      const child = this.mutate(parent, probeActive ? 0.5 : 1);
      // 原位替换
      const index = this.population.indexOf(dead);
      if (index >= 0) this.population[index] = child;
      else this.population.push(child);
      report.born.push(child.id);
    }

    // 种群规模收敛
    while (this.population.length > this.config.populationSize) this.population.pop();

    // 第三轮升级：谱系存活标记同步（被淘汰个体台账永久留痕，不随种群消失）
    const aliveIds = new Set(this.population.map((g) => g.id));
    for (const dead of eliminated) {
      const node = this.lineage.get(dead.id);
      if (node && aliveIds.has(node.id) === false && node.alive) {
        node.alive = false;
        node.eliminatedAtGeneration = this.generation;
      }
    }
    for (const node of this.lineage.values()) {
      if (aliveIds.has(node.id)) node.alive = true;
    }

    // 第三轮升级：算子信用回填（存活 + 被淘汰个体统一结算——每个个体只结算一次）
    this.settleOperatorCredits([...this.population, ...eliminated]);

    // 第三轮升级：停滞检测重启（最优适应度 N 代无进展 → 注入行为距离最大的个体）
    if (
      this.stagnationCfg &&
      this.generation >= this.stagnationCfg.minGenerations &&
      this.generation - this.lastImprovementGeneration >= this.stagnationCfg.patience
    ) {
      this.performStagnationRestart(report);
    }

    // 第四轮升级：多样性仪表（逐代快照 + 预警 + 自动注入多样化个体）
    if (this.diversityCfg) this.enforceDiversity(report);

    // 14.0：进化后同步归档——每个行为 niche 保留种群内最优代表
    // （全局平庸但本地独特的基因组获得结构性生存权）
    if (this.qdArchive) {
      for (const genome of this.population) this.qdArchive.place(genome);
    }

    // 第三轮升级：进展跟踪（停滞检测基准；本代在位最优适应度创新高才计时复位）
    // 第四轮升级：速率自适应以本代最优适应度的「有效提升」为平稳判据
    // （bestEverFitness 是本代之前的口径——进展 = 本代再创新高）
    const bestEverBefore = this.bestEverFitness;
    const bestFitness = ranked.length > 0 ? this.fitness(ranked[0]!) : 0;
    if (bestFitness > this.bestEverFitness + (this.stagnationCfg?.minImprovement ?? 1e-6)) {
      this.bestEverFitness = bestFitness;
      this.lastImprovementGeneration = this.generation;
    }

    // 第三轮升级：预算记账（实际消耗 = 真实决策反馈数 + 本代出生后代数）
    if (this.evolutionBudgetCap !== undefined) {
      const cost = applicationsConsumed + report.born.length;
      this.budgetSpent += cost;
      this.budgetLedger.push({ generation: this.generation, cost, cumulative: this.budgetSpent, refused: false });
      if (this.budgetSpent >= this.evolutionBudgetCap) {
        this.budgetExhausted = true;
        if (this.freezeCfg?.freezeOnBudgetExhaustion) {
          this.enterFrozen('running', `进化预算耗尽（spent=${this.budgetSpent}/cap=${this.evolutionBudgetCap}），冻结进化`);
        }
      }
    }

    // 第四轮升级：冻结判定素材（本代出生的后代 + 出生时刻最优适应度基线）
    this.lastBornIds = [...report.born];
    this.lastBornBaseline = this.bestEverFitness;

    // 第四轮升级：速率档位更新（平稳降频 / 改进回速）
    if (this.rateCfg) this.updateRateMode(this.bestEverFitness > bestEverBefore + this.rateCfg.improvementEpsilon);

    this.applicationsSinceEvolution = 0;
    this.evolutionHistory.push(report);
    if (this.evolutionHistory.length > 50) this.evolutionHistory.shift();
    return report;
  }

  /** 最优基因组（应用次数达标者中平均收益最高） */
  bestGenome(): StrategyGenome {
    const eligible = this.population.filter((g) => g.applications >= this.config.minApplicationsForElite);
    const pool = eligible.length > 0 ? eligible : this.population;
    return [...pool].sort((a, b) => this.fitness(b) - this.fitness(a))[0];
  }

  /** 最优基因组 → 决策引擎配置片段（进化产物落地） */
  bestGenesAsConfig(): Partial<DecisionEngineConfig> {
    return { ...this.bestGenome().genes };
  }

  /** 种群报告 */
  getReport(): EvolutionStatusReport {
    return {
      generation: this.generation,
      populationSize: this.population.length,
      applicationsSinceEvolution: this.applicationsSinceEvolution,
      populationMeanReward: Number(this.populationMeanReward().toFixed(3)),
      genomes: [...this.population]
        .sort((a, b) => this.fitness(b) - this.fitness(a))
        .map((g) => ({
          id: g.id,
          generation: g.generation,
          applications: g.applications,
          meanReward: Number(g.meanReward.toFixed(3)),
          genes: g.genes,
        })),
      bestGenome: this.bestGenome().id,
      recentEvolutions: this.evolutionHistory.slice(-5),
      qd: this.qdArchive?.metrics(),
      anytime: this.anytime?.report(),
      geometry: this.geometry?.report(),
      lineage: {
        size: this.lineage.size,
        roots: [...this.lineage.values()].filter((n) => !n.parentId && n.alive).map((n) => n.id),
        depth: this.lineageReport().depth,
        alive: [...this.lineage.values()].filter((n) => n.alive).length,
        deployed: [...this.lineage.values()].filter((n) => n.deployedAt !== undefined).length,
      },
      operators: this.operatorGovernance ? this.operatorStats() : undefined,
      budget: this.evolutionBudgetCap !== undefined ? this.evolutionBudgetReport() : undefined,
      restarts: this.stagnationCfg ? this.restartEvents.map((e) => ({ ...e, injected: [...e.injected] })) : undefined,
      diversity: this.diversityReport(),
      rate: this.evolutionRateReport(),
      freeze: this.freezeReport(),
    };
  }

  /** 进化历史 */
  getEvolutionHistory(): EvolutionReport[] {
    return [...this.evolutionHistory];
  }

  // ─────────────────────────── 12.0 任意时刻证据移植 ───────────────────────────

  /**
   * 证明性淘汰（12.0）：e-BH FDR 控制地移除「任意时刻有效证据确证
   * 收益低于水位线」的基因组。
   *
   * 语义：只删 e-过程确证（e ≥ 1/α）且通过多重校正的对象——
   * 「确实差」才淘汰，冤案率（FDR）≤ fdr；淘汰后由幸存者变异后代
   * 顶替（种群规模不缩水）。未挂载内核时返回空报告（零漂移）。
   *
   * @returns 被淘汰的基因组及定罪 e-值（审计台账）
   */
  pruneProvablyDominated(fdr = 0.1): Array<{ id: string; eValue: number; at: number }> {
    if (!this.anytime) return [];
    // 淘汰前快照各基因组 e-值（eliminate 后流被 forget，无法回查）
    const evidenceSnapshot = new Map<string, number>();
    for (const genome of this.population) {
      const view = this.anytime.viewOf(genome.id);
      if (view) evidenceSnapshot.set(genome.id, view.eBelow);
    }
    const rejected = this.anytime.eliminate(fdr);
    const eliminated: Array<{ id: string; eValue: number; at: number }> = [];
    for (const id of rejected) {
      const genome = this.population.find((g) => g.id === id);
      if (!genome) continue;
      const record = { id, eValue: evidenceSnapshot.get(id) ?? 0, at: this.clock() };
      eliminated.push(record);
      this.anytimeEliminations.push(record);
      // 从种群移除（保底 2 个——进化不能失去变异素材）
      if (this.population.length > 2) {
        const index = this.population.indexOf(genome);
        if (index >= 0) this.population.splice(index, 1);
        // 幸存者变异顶替（规模不缩水；新基因组从零积累证据）
        const parent = this.tournamentSelect(this.population);
        const child = this.mutate(parent);
        this.population.push(child);
        if (this.qdArchive) this.qdArchive.place(child);
      }
    }
    return eliminated;
  }

  /** 12.0：任意时刻证据报告（含历史淘汰台账） */
  anytimeReport(): AnytimeEvidenceRegistryReport & { eliminations: Array<{ id: string; eValue: number; at: number }> } {
    const base = this.anytime?.report() ?? {
      streams: 0,
      verdicts: { above: 0, below: 0, undecided: 0 },
      totalConfirmations: 0,
      totalEliminations: 0,
      strongestEvidence: 0,
      interpretation: '未挂载任意时刻证据内核（attachAnytimeEvidence 启用）',
    };
    return { ...base, eliminations: [...this.anytimeEliminations] };
  }

  /** 12.0：指定基因组的当前证据视图（未挂载或未观测返回 undefined） */
  anytimeViewOf(genomeId: string): AnytimeEvidenceView | undefined {
    return this.anytime?.viewOf(genomeId);
  }

  // ─────────────────────────── 14.0 质量-多样性移植 ───────────────────────────

  /** 14.0：QD 指标（未挂载返回 undefined） */
  qdMetrics(): QualityDiversityMetrics | undefined {
    return this.qdArchive?.metrics();
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 初始种群：基准基因组 + 扰动变体 */
  private seedPopulation(): void {
    this.population = [];
    // 首个个体为无扰动基准（保证系统初始行为与默认配置一致）
    this.population.push(this.registerBirth(this.createGenome({ ...BASELINE_GENES }, 0), undefined, 'seed'));
    for (let i = 1; i < this.config.populationSize; i += 1) {
      const baseline = this.registerBirth(this.createGenome({ ...BASELINE_GENES }, 0), undefined, 'seed', false);
      this.population.push(this.mutate(baseline));
    }
  }

  /** 创建新基因组 */
  private createGenome(genes: StrategyGenes, generation: number): StrategyGenome {
    return {
      id: `genome-${++this.genomeCounter}`,
      genes,
      applications: 0,
      totalReward: 0,
      meanReward: 0,
      generation,
      createdAt: this.clock(),
    };
  }

  /**
   * 适应度（4.0 证据化 → 12.0 任意时刻有效化）
   *
   * 挂载任意时刻内核且流样本 ≥ 3：置信序列下界 × 折扣（时间一致
   * 覆盖——连续监控下读适应度永不夸大）；否则回退 Wilson 下界
   * （4.0 口径，固定样本语义）；无证据回退 meanReward × 折扣。
   */
  private fitness(genome: StrategyGenome): number {
    if (genome.applications === 0) return 0;
    const confidenceFactor = Math.min(1, genome.applications / this.config.minApplicationsForElite);
    const anytimeView = this.anytime?.viewOf(genome.id);
    if (anytimeView && anytimeView.n >= 3) {
      return Math.max(0, anytimeView.cs.lower) * confidenceFactor;
    }
    if (genome.evidence) {
      return wilsonLowerBound(genome.evidence.weightedSuccesses, genome.evidence.weightedFailures) * confidenceFactor;
    }
    return genome.meanReward * confidenceFactor;
  }

  /** 锦标赛选择（3 选 1） */
  private tournamentSelect(pool: StrategyGenome[]): StrategyGenome {
    let winner = pool[Math.floor(this.rng() * pool.length)];
    for (let i = 0; i < 2; i += 1) {
      const challenger = pool[Math.floor(this.rng() * pool.length)];
      if (this.fitness(challenger) > this.fitness(winner)) winner = challenger;
    }
    return winner;
  }

  /**
   * 变异产生后代
   *
   * 18.0 挂载后：Fisher 流形上的自然变异（种群协方差主轴展开的
   * 联合相关步 + KL 信任域封顶——步长以 nat 计价，坐标不变）；
   * 未挂载几何：按算子组合治理选择算子——未挂载治理时恒为 gaussian
   * （原各基因独立近似高斯变异，随机数消耗序列与升级前逐位一致，零漂移）。
   * 所有路径统一登记谱系（父代 / 算子 / 出生时父代适应度）。
   * 第四轮升级：strengthScale 全路径缩放变异强度（保守试探代传 0.5；
   * 缺省 1 = 原强度，零漂移）。
   */
  private mutate(parent: StrategyGenome, strengthScale = 1): StrategyGenome {
    if (this.geometry) {
      const { child } = this.geometry.naturalMutate(normalizeGenes(parent.genes), this.config.mutationStrength * strengthScale);
      return this.registerBirth(this.createGenome(denormalizeGenes(child), this.generation), parent, 'natural-gradient');
    }
    const operator = this.selectMutationOperator();
    return this.registerBirth(
      this.createGenome(this.applyMutationOperator(parent.genes, operator, strengthScale), this.generation),
      parent,
      operator,
    );
  }

  /** 出生育苗：谱系登记（父代 / 算子 / 出生时父代平均收益快照——信用基准） */
  private registerBirth(child: StrategyGenome, parent: StrategyGenome | undefined, operator: string, alive = true): StrategyGenome {
    if (parent) child.parentId = parent.id;
    child.mutationOperator = operator;
    this.lineage.set(child.id, {
      id: child.id,
      parentId: parent?.id,
      operator,
      generation: child.generation,
      bornAt: this.clock(),
      parentFitnessAtBirth: parent ? parent.meanReward : undefined,
      alive,
      credited: false,
    });
    return child;
  }

  /**
   * 算子选择（组合治理核心）
   *
   * 未挂载治理：恒返回 gaussian（不消耗随机数——默认路径随机数序列
   * 与升级前逐位一致）。挂载后：各算子信用 EWMA 经 softmax(ewma/τ)
   * 归一，按概率采样；被选中算子的选择计数 +1。
   */
  private selectMutationOperator(): string {
    if (!this.operatorGovernance || this.operatorLedger.size === 0) return 'gaussian';
    const entries = [...this.operatorLedger.entries()];
    const maxExponent = Math.max(...entries.map(([, s]) => s.ewma / this.operatorGovernance!.temperature));
    const weights = entries.map(([, s]) => Math.exp(s.ewma / this.operatorGovernance!.temperature - maxExponent));
    const total = weights.reduce((sum, w) => sum + w, 0);
    let roll = this.rng() * total;
    for (let i = 0; i < entries.length; i += 1) {
      roll -= weights[i]!;
      if (roll <= 0) {
        entries[i]![1].selections += 1;
        return entries[i]![0];
      }
    }
    const last = entries[entries.length - 1]!;
    last[1].selections += 1;
    return last[0];
  }

  /** 算子当前 softmax 选择概率（未挂载治理：gaussian 恒 1） */
  private operatorProbability(name: string): number {
    if (!this.operatorGovernance || this.operatorLedger.size === 0) return name === 'gaussian' ? 1 : 0;
    const entries = [...this.operatorLedger.entries()];
    const maxExponent = Math.max(...entries.map(([, s]) => s.ewma / this.operatorGovernance!.temperature));
    const weights = entries.map(([, s]) => Math.exp(s.ewma / this.operatorGovernance!.temperature - maxExponent));
    const total = weights.reduce((sum, w) => sum + w, 0);
    const index = entries.findIndex(([n]) => n === name);
    return index >= 0 && total > 0 ? Number((weights[index]! / total).toFixed(4)) : 0;
  }

  /**
   * 变异算子实现（四种 + 高斯原路径）
   *
   * - gaussian：逐基因按概率微调（原路径，零漂移回退）
   * - large-step：全基因联合大步（跳出局部盆地；单步强度 ×2.5）
   * - boundary：基因按概率推向取值边界（探索参数空间角落）
   * - baseline-reset：随机一个基因向基准回退 70%（漂移过远的纠偏）
   *
   * 第四轮升级：strengthScale 统一缩放（保守试探代 0.5；缺省 1 零漂移）。
   */
  private applyMutationOperator(parentGenes: StrategyGenes, operator: string, strengthScale = 1): StrategyGenes {
    const genes = { ...parentGenes };
    const keys = Object.keys(GENE_BOUNDS) as Array<keyof StrategyGenes>;
    if (operator === 'large-step') {
      for (const key of keys) {
        const bounds = GENE_BOUNDS[key];
        const range = bounds.max - bounds.min;
        const noise = (this.rng() + this.rng() - 1) * this.config.mutationStrength * strengthScale * 2.5 * range;
        const value = Math.max(bounds.min, Math.min(bounds.max, Number(genes[key]) + noise));
        genes[key] = bounds.integer ? Math.round(value) : Number(value.toFixed(3));
      }
      return genes;
    }
    if (operator === 'boundary') {
      for (const key of keys) {
        if (this.rng() >= 0.4) continue;
        const bounds = GENE_BOUNDS[key];
        const value = this.rng() < 0.5 ? bounds.min : bounds.max;
        genes[key] = bounds.integer ? Math.round(value) : Number(value.toFixed(3));
      }
      return genes;
    }
    if (operator === 'baseline-reset') {
      const key = keys[Math.floor(this.rng() * keys.length)]!;
      const value = Number(genes[key]) + 0.7 * (BASELINE_GENES[key] - Number(genes[key]));
      genes[key] = GENE_BOUNDS[key].integer ? Math.round(value) : Number(value.toFixed(3));
      return genes;
    }
    // gaussian（原路径——随机数消耗序列与升级前逐位一致）
    for (const key of keys) {
      if (this.rng() > this.config.mutationRate) continue;
      const bounds = GENE_BOUNDS[key];
      const range = bounds.max - bounds.min;
      // 近似高斯：两个均匀分布叠加中心化
      const noise = (this.rng() + this.rng() - 1) * this.config.mutationStrength * strengthScale * range;
      let value = Number(genes[key]) + noise;
      value = Math.max(bounds.min, Math.min(bounds.max, value));
      genes[key] = bounds.integer ? Math.round(value) : Number(value.toFixed(3));
    }
    return genes;
  }

  /**
   * 算子信用回填：样本达标的后代按「平均收益是否超过种群水位线」结算成败
   *
   * 水位线 = 当前种群（已应用个体）平均收益的中位数——相对口径。不用
   * 「超过出生时父代」做判据：连续选择下父代是幸存者均值（冠军均值随
   * 选择棘轮上移，子代期望仍在种群均值——赢家诅咒使对称变异的后代几乎
   * 永远追不上父代快照，全部算子被系统性判负）。相对水位线的信用对
   * 种群整体水平不敏感：把基因推向极端区的算子（后代远低于中位）持续
   * 判负，围绕高分区微调的算子约半数判正——信用对比稳定可分。
   */
  private settleOperatorCredits(genomes: StrategyGenome[]): void {
    const appliedMeans = this.population.filter((g) => g.applications > 0).map((g) => g.meanReward);
    if (appliedMeans.length === 0) return;
    const sorted = [...appliedMeans].sort((a, b) => a - b);
    const watermark = sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
    for (const genome of genomes) {
      const node = this.lineage.get(genome.id);
      if (!node || node.credited || !node.parentId) continue;
      if (genome.applications < this.config.minApplicationsForElite) continue; // 样本不足不结算
      node.fitness = this.fitness(genome);
      node.credited = true;
      const stats = this.operatorLedger.get(node.operator);
      if (!stats || !this.operatorGovernance) continue;
      const success = genome.meanReward > watermark + 1e-9;
      stats.ewma += this.operatorGovernance.learningRate * ((success ? 1 : 0) - stats.ewma);
      stats.credits += 1;
      if (success) stats.successes += 1;
    }
  }

  /**
   * 停滞重启：替换最弱非精英为行为距离最大的多样化个体
   *
   * 候选池（candidatePool 个边界内随机向量）中选「与当前种群最小归一化
   * 距离²」最大者（最远点采样）——不问适应度、只问新奇的注入，打破
   * 局部平台后停滞计时复位（给注入个体积累反馈的时间窗）。
   */
  private performStagnationRestart(report: EvolutionReport): void {
    const cfg = this.stagnationCfg!;
    const { injected, minSquaredDistance } = this.injectDiversified(cfg.injectCount, cfg.candidatePool, 'restart-diversify', report);
    if (injected.length > 0) {
      report.restarts = [...(report.restarts ?? []), ...injected];
      this.restartEvents.push({
        generation: this.generation,
        injected: [...injected],
        minSquaredDistance: Number(minSquaredDistance.toFixed(4)),
        reason: `最优适应度自第 ${this.lastImprovementGeneration} 代起 ${this.generation - this.lastImprovementGeneration} 代无 > ${cfg.minImprovement} 进展，注入行为距离最大的多样化个体破局（91.0 新奇思想：行为距离优先于适应度）`,
      });
      this.lastImprovementGeneration = this.generation; // 停滞计时复位
    }
  }

  /**
   * 多样化注入（停滞重启与多样性仪表共用）：替换最弱非精英为行为距离最大的个体
   *
   * 候选池（candidatePool 个边界内随机向量）中选「与当前种群最小归一化
   * 距离²」最大者（最远点采样）——不问适应度、只问新奇的注入。第四轮
   * 抽取为共用原语（随机数消耗次序与第三轮原实现逐位一致，零漂移）。
   */
  private injectDiversified(
    injectCount: number,
    candidatePool: number,
    operator: string,
    report: EvolutionReport,
  ): { injected: string[]; minSquaredDistance: number } {
    const weakestFirst = [...this.population].sort((a, b) => this.fitness(a) - this.fitness(b));
    const protectedCount = Math.min(this.config.eliteCount, this.population.length - 1);
    const victims = weakestFirst.slice(0, Math.min(injectCount, Math.max(0, this.population.length - protectedCount)));
    const injected: string[] = [];
    let minSquaredDistance = 0;
    for (const victim of victims) {
      const { genome, minSquaredDistance: dist } = this.farthestIndividual(candidatePool, operator);
      minSquaredDistance = dist;
      const index = this.population.indexOf(victim);
      if (index < 0) continue;
      const victimNode = this.lineage.get(victim.id);
      if (victimNode) {
        victimNode.alive = false;
        victimNode.eliminatedAtGeneration = this.generation;
      }
      this.population[index] = genome;
      injected.push(genome.id);
      report.born.push(genome.id);
    }
    return { injected, minSquaredDistance };
  }

  /**
   * 最远点采样：候选池中与当前种群最小距离²最大的个体（谱系新根）。
   *
   * 候选生成是「均匀 × 边界极值」混合：一半纯均匀采样，另一半把基因
   * 推到归一化空间的低端（0.05~0.15）或高端（0.85~0.95）——行为空间的
   * 角落只在极值候选中出现，而角落恰恰是被收敛种群遗忘最深的区域；
   * 最远点选择仍然只认距离（不预设方向），角落因距离最大而胜出。
   */
  private farthestIndividual(candidatePool: number, operator = 'restart-diversify'): { genome: StrategyGenome; minSquaredDistance: number } {
    const pool = this.population.map((g) => normalizeGenes(g.genes));
    const keys = Object.keys(GENE_BOUNDS) as Array<keyof StrategyGenes>;
    const sampleGene = (): number => {
      const u = this.rng();
      if (u >= 0.5) return this.rng(); // 均匀探索
      return this.rng() < 0.5 ? 0.05 + this.rng() * 0.1 : 0.85 + this.rng() * 0.1; // 边界极值探索
    };
    let bestPoint: number[] = [];
    let bestDist = -Infinity;
    for (let k = 0; k < candidatePool; k += 1) {
      const point = keys.map(() => sampleGene());
      let minDist = Infinity;
      for (const existing of pool) {
        let sq = 0;
        for (let i = 0; i < point.length; i += 1) sq += (point[i]! - existing[i]!) ** 2;
        if (sq < minDist) minDist = sq;
      }
      if (minDist > bestDist) {
        bestDist = minDist;
        bestPoint = point;
      }
    }
    return {
      genome: this.registerBirth(this.createGenome(denormalizeGenes(bestPoint), this.generation), undefined, operator),
      minSquaredDistance: Number.isFinite(bestDist) ? bestDist : 0,
    };
  }

  /** 算子组合治理初始化（config / attach 共用） */
  private initOperatorGovernance(options?: OperatorGovernanceOptions | boolean): void {
    if (options === undefined || options === false) {
      this.operatorGovernance = undefined;
      this.operatorLedger.clear();
      return;
    }
    const opts: OperatorGovernanceOptions = options === true ? {} : options;
    this.operatorGovernance = {
      temperature: Math.max(0.01, opts.temperature ?? 0.15),
      learningRate: Math.max(0.01, Math.min(1, opts.learningRate ?? 0.25)),
    };
    this.operatorLedger.clear();
    for (const name of ['gaussian', 'large-step', 'boundary', 'baseline-reset']) {
      this.operatorLedger.set(name, { ewma: 0.5, selections: 0, credits: 0, successes: 0 });
    }
  }

  /** 停滞重启初始化（config / attach 共用） */
  private initStagnation(options?: StagnationRestartOptions | boolean): void {
    if (options === undefined || options === false) {
      this.stagnationCfg = undefined;
      return;
    }
    const opts: StagnationRestartOptions = options === true ? {} : options;
    this.stagnationCfg = {
      patience: Math.max(1, Math.floor(opts.patience ?? 3)),
      minImprovement: Math.max(0, opts.minImprovement ?? 1e-6),
      injectCount: Math.max(1, Math.floor(opts.injectCount ?? 2)),
      minGenerations: Math.max(1, Math.floor(opts.minGenerations ?? 2)),
      candidatePool: Math.max(2, Math.floor(opts.candidatePool ?? 8)),
    };
  }

  /** 进化预算初始化（config / attach 共用）。第四轮升级：设置新上限时清空耗尽标记——注入新预算即可重新开代（冻结协议的预算冻结由此解冻） */
  private setEvolutionBudget(cap?: number): void {
    const valid = typeof cap === 'number' && Number.isFinite(cap) && cap > 0;
    this.evolutionBudgetCap = valid ? cap : undefined;
    if (valid) this.budgetExhausted = false;
  }

  // ─────────────────────────── 第四轮升级：内部实现 ───────────────────────────

  /**
   * 多样性计算（纯函数，不消耗随机数）
   *
   * - 基因距离矩阵：归一化基因向量的成对欧氏距离，取均值（整体散开度）
   *   与最小值（最近邻——坍缩总是从最近的两个体贴上开始）
   * - 行为熵：行为描述子（敢为×节俭×警觉）按 4³ niche 分箱后的分布熵
   *   （bit）；有效 niche 数 = 2^H（Hill 数，1 = 单一行为流派垄断种群）
   */
  private computeDiversity(): DiversityMetrics {
    const points = this.population.map((g) => normalizeGenes(g.genes));
    const n = points.length;
    let sum = 0;
    let pairs = 0;
    let min = Infinity;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let sq = 0;
        for (let d = 0; d < points[i]!.length; d += 1) sq += (points[i]![d]! - points[j]![d]!) ** 2;
        const dist = Math.sqrt(sq);
        sum += dist;
        pairs += 1;
        if (dist < min) min = dist;
      }
    }
    // 行为 niche 分布熵（4³ 分箱；Hill 数 2^H = 有效行为流派数）
    const cells = new Map<string, number>();
    for (const genome of this.population) {
      const key = strategyBehaviorDescriptor(genome.genes)
        .map((v) => Math.min(3, Math.max(0, Math.floor(v * 4))))
        .join(',');
      cells.set(key, (cells.get(key) ?? 0) + 1);
    }
    let entropy = 0;
    for (const count of cells.values()) {
      const p = count / Math.max(1, n);
      entropy -= p * Math.log2(p);
    }
    const cfg = this.diversityCfg;
    const warning =
      cfg !== undefined &&
      n >= 3 &&
      (sum / Math.max(1, pairs) < cfg.meanDistanceFloor ||
        min < cfg.minDistanceFloor ||
        entropy < cfg.entropyFloor);
    return {
      generation: this.generation,
      populationSize: n,
      meanGeneDistance: Number((sum / Math.max(1, pairs)).toFixed(4)),
      minGeneDistance: Number((Number.isFinite(min) ? min : 0).toFixed(4)),
      behaviorEntropyBits: Number(entropy.toFixed(4)),
      effectiveNiches: Number((2 ** entropy).toFixed(4)),
      warning,
    };
  }

  /** 多样性仪表执行：逐代快照入档 + 预警 + 自动注入（注入前后读数都留档） */
  private enforceDiversity(report: EvolutionReport): void {
    const cfg = this.diversityCfg!;
    const before = this.computeDiversity();
    this.diversityHistory.push(before);
    if (this.diversityHistory.length > cfg.historyLimit) this.diversityHistory.shift();
    if (!before.warning) return;
    if (!cfg.autoInject) {
      this.diversityEvents.push({
        generation: this.generation,
        before,
        injected: [],
        reason: `低多样性预警：均值距离 ${before.meanGeneDistance} / 最近邻 ${before.minGeneDistance} / 行为熵 ${before.behaviorEntropyBits}bit（有效 niche ${before.effectiveNiches}）跌破阈值（autoInject=false 只预警不干预）`,
      });
      if (this.diversityEvents.length > cfg.historyLimit) this.diversityEvents.shift();
      return;
    }
    const { injected } = this.injectDiversified(cfg.injectCount, cfg.candidatePool, 'diversity-inject', report);
    if (injected.length > 0) {
      report.diversifications = [...(report.diversifications ?? []), ...injected];
      const after = this.computeDiversity();
      this.diversityEvents.push({
        generation: this.generation,
        before,
        after,
        injected: [...injected],
        reason: `低多样性预警触发自动注入：均值距离 ${before.meanGeneDistance} → ${after.meanGeneDistance}，最近邻 ${before.minGeneDistance} → ${after.minGeneDistance}，有效 niche ${before.effectiveNiches} → ${after.effectiveNiches}（最远点采样 ${cfg.candidatePool} 候选，替换最弱非精英 ×${injected.length}）`,
      });
      if (this.diversityEvents.length > cfg.historyLimit) this.diversityEvents.shift();
    }
  }

  /** 速率自适应：决策回报的突变检测（recordOutcome 时刻即感知，不等下一次 evolve） */
  private noteRewardForRate(reward: number): void {
    const cfg = this.rateCfg!;
    this.rateTotalOutcomes += 1;
    this.rateRewards.push(reward);
    if (this.rateRewards.length > cfg.shiftWindow * 2) this.rateRewards.shift();
    if (this.ratePendingShift || this.rateRewards.length < cfg.shiftWindow * 2) return;
    const w = cfg.shiftWindow;
    const mean = (from: number, to: number): number => {
      let s = 0;
      for (let i = from; i < to; i += 1) s += this.rateRewards[i]!;
      return s / Math.max(1, to - from);
    };
    const delta = mean(this.rateRewards.length - w, this.rateRewards.length) - mean(0, this.rateRewards.length - w);
    if (Math.abs(delta) < cfg.shiftThreshold) return;
    this.ratePendingShift = true;
    this.rateShifts.push({ generation: this.generation, atApplications: this.rateTotalOutcomes, delta: Number(delta.toFixed(4)) });
    if (this.rateShifts.length > 50) this.rateShifts.shift();
    if (this.rateMode === 'reduced') this.setRateMode('normal', `适应度地形突变（|Δ|=${Math.abs(delta).toFixed(3)} ≥ ${cfg.shiftThreshold}）：降频档立即回全速并排队即时进化`);
  }

  /** 当前生效的应用门槛（normal = 原值；reduced = 原值 × reducedFactor） */
  private effectiveMinApplications(): number {
    if (!this.rateCfg || this.rateMode === 'normal') return this.config.minApplicationsBetweenEvolutions;
    return Math.ceil(this.config.minApplicationsBetweenEvolutions * this.rateCfg.reducedFactor);
  }

  /** 速率档位更新：连续无有效进展 → 降频；降频中发现有效改进 → 回全速 */
  private updateRateMode(improved: boolean): void {
    const cfg = this.rateCfg!;
    if (improved) this.rateQuietGenerations = 0;
    else this.rateQuietGenerations += 1;
    if (this.rateMode === 'normal' && this.rateQuietGenerations >= cfg.stationarityPatience) {
      this.setRateMode(
        'reduced',
        `环境平稳：连续 ${this.rateQuietGenerations} 代最优适应度无 > ${cfg.improvementEpsilon} 的有效进展，降频进化（应用门槛 ×${cfg.reducedFactor} 省算力）`,
      );
    } else if (this.rateMode === 'reduced' && improved) {
      this.setRateMode('normal', `降频档发现有效改进（> ${cfg.improvementEpsilon}），恢复全速捕捉`);
    }
  }

  /** 速率档位切换（台账留痕） */
  private setRateMode(to: EvolutionRateMode, reason: string): void {
    if (this.rateMode === to) return;
    const from = this.rateMode;
    this.rateMode = to;
    this.rateModeSwitches.push({ generation: this.generation, from, to, reason });
    if (this.rateModeSwitches.length > 50) this.rateModeSwitches.shift();
  }

  /**
   * 冻结判定：结算上一代出生的后代（样本达标者）是否有适应度改进
   *
   * matured = 上一代出生且已积累 ≥ minApplicationsForElite 次应用的后代；
   * 无 matured → undetermined（不推进失败计数）；有 matured 且无一超过
   * 出生时刻最优基线 → failed。与算子信用结算的水位线口径不同：冻结
   * 判定问的是「进化还有没有必要烧下去」，基准是出生时的历史最优。
   */
  private judgeLastGeneration(): 'improved' | 'failed' | 'undetermined' {
    if (this.lastBornIds.length === 0) return 'undetermined';
    const matured = this.lastBornIds
      .map((id) => this.population.find((g) => g.id === id))
      .filter((g): g is StrategyGenome => g !== undefined && g.applications >= this.config.minApplicationsForElite);
    if (matured.length === 0) return 'undetermined';
    const eps = 1e-9;
    return matured.some((g) => this.fitness(g) > this.lastBornBaseline + eps) ? 'improved' : 'failed';
  }

  /**
   * 冻结状态机推进（evolve 顶部调用；返回 false = 本次 evolve 被挡下）
   *
   * frozen：挡下并倒数冷却（以被挡下的尝试计数——确定性，无需时钟）；
   *   冷却归零 → probing。
   * probing：放行（本次 evolve 即保守试探代）。
   * running：先结算上一代——试探裁决优先（failed 重新冻结），常规失败
   *   streak 连续 maxFailedGenerations 代 → 冻结。
   */
  private advanceFreezeGate(): boolean {
    const cfg = this.freezeCfg!;
    if (this.freezeState === 'frozen') {
      this.freezeBlockedAttempts += 1;
      if (this.freezeCooldownRemaining > 0) {
        this.freezeCooldownRemaining -= 1;
        if (this.freezeCooldownRemaining === 0) {
          this.freezeState = 'probing';
          this.pushFreezeEvent('frozen', 'probing', `冷却完成（${cfg.cooldownAttempts} 次被挡下的 evolve 尝试），进入一次保守试探（单点替换 + 变异强度减半）`);
        }
      }
      return false;
    }
    if (this.freezeState === 'probing') return true;
    // running：结算上一代
    const verdict = this.judgeLastGeneration();
    if (this.probePendingVerdict) {
      this.probePendingVerdict = false;
      if (verdict === 'failed') {
        this.failStreak = 1;
        this.enterFrozen('probing', `保守试探未证实有效（试探代后代无一超过出生时最优基线），重新冻结并重置冷却`);
        return false;
      }
      this.failStreak = 0;
      this.pushFreezeEvent(
        'running',
        'running',
        `保守试探${verdict === 'improved' ? '成功（试探代后代有适应度改进）' : '后代样本不足但未证实失败'}，解除冻结恢复进化`,
      );
      return true;
    }
    if (verdict === 'failed') this.failStreak += 1;
    else if (verdict === 'improved') this.failStreak = 0;
    if (this.failStreak >= cfg.maxFailedGenerations) {
      this.enterFrozen('running', `连续 ${this.failStreak} 代进化失败（成熟后代无一超过出生时最优基线），冻结进化等待冷却`);
      return false;
    }
    return true;
  }

  /** 进入冻结（统一入口：原因 + 冷却重置 + 台账） */
  private enterFrozen(from: EvolutionFreezeState, reason: string): void {
    this.freezeState = 'frozen';
    this.freezeReason = reason;
    this.frozenAtGeneration = this.generation;
    this.freezeCooldownRemaining = this.freezeCfg?.cooldownAttempts ?? 2;
    this.probePendingVerdict = false;
    this.pushFreezeEvent(from, 'frozen', reason);
  }

  /** 冻结状态机迁移台账（有界） */
  private pushFreezeEvent(from: EvolutionFreezeState, to: EvolutionFreezeState, reason: string): void {
    this.freezeEvents.push({ generation: this.generation, from, to, reason });
    if (this.freezeEvents.length > 100) this.freezeEvents.shift();
  }

  /** 多样性仪表初始化（config / attach 共用） */
  private initDiversity(options?: DiversityDashboardOptions | boolean): void {
    if (options === undefined || options === false) {
      this.diversityCfg = undefined;
      this.diversityHistory = [];
      this.diversityEvents = [];
      return;
    }
    const opts: DiversityDashboardOptions = options === true ? {} : options;
    this.diversityCfg = {
      meanDistanceFloor: Math.max(0, opts.meanDistanceFloor ?? 0.06),
      minDistanceFloor: Math.max(0, opts.minDistanceFloor ?? 0.015),
      entropyFloor: Math.max(0, opts.entropyFloor ?? 1.0),
      autoInject: opts.autoInject ?? true,
      injectCount: Math.max(1, Math.floor(opts.injectCount ?? 2)),
      candidatePool: Math.max(2, Math.floor(opts.candidatePool ?? 8)),
      historyLimit: Math.max(8, Math.floor(opts.historyLimit ?? 64)),
    };
  }

  /** 速率自适应初始化（config / attach 共用） */
  private initAdaptiveRate(options?: AdaptiveRateOptions | boolean): void {
    if (options === undefined || options === false) {
      this.rateCfg = undefined;
      return;
    }
    const opts: AdaptiveRateOptions = options === true ? {} : options;
    this.rateCfg = {
      shiftWindow: Math.max(2, Math.floor(opts.shiftWindow ?? 12)),
      shiftThreshold: Math.max(0.01, opts.shiftThreshold ?? 0.15),
      stationarityPatience: Math.max(1, Math.floor(opts.stationarityPatience ?? 2)),
      reducedFactor: Math.max(1.1, opts.reducedFactor ?? 2),
      improvementEpsilon: Math.max(0, opts.improvementEpsilon ?? 0.01),
    };
  }

  /** 冻结协议初始化（config / attach / freezeEvolution 共用） */
  private initFreeze(options?: FreezeProtocolOptions | boolean): void {
    if (options === undefined || options === false) {
      this.freezeCfg = undefined;
      return;
    }
    const opts: FreezeProtocolOptions = options === true ? {} : options;
    this.freezeCfg = {
      maxFailedGenerations: Math.max(1, Math.floor(opts.maxFailedGenerations ?? 3)),
      cooldownAttempts: Math.max(1, Math.floor(opts.cooldownAttempts ?? 2)),
      freezeOnBudgetExhaustion: opts.freezeOnBudgetExhaustion ?? true,
    };
  }

  /** 种群平均收益 */
  private populationMeanReward(): number {
    const applied = this.population.filter((g) => g.applications > 0);
    if (applied.length === 0) return 0;
    return applied.reduce((sum, g) => sum + g.meanReward, 0) / applied.length;
  }
}

// ─────────────────────────── 18.0 归一化工具 ───────────────────────────

/** 基因 → 归一化参数点 [0,1]^d（18.0：几何运算都在归一化空间，坐标不变量） */
function normalizeGenes(genes: StrategyGenes): number[] {
  return (Object.keys(GENE_BOUNDS) as Array<keyof StrategyGenes>).map((key) => {
    const bounds = GENE_BOUNDS[key];
    return Math.max(0, Math.min(1, (genes[key] - bounds.min) / (bounds.max - bounds.min)));
  });
}

/** 归一化参数点 → 基因（反弹边界 + 整数基因圆整） */
function denormalizeGenes(point: readonly number[]): StrategyGenes {
  const genes = {} as StrategyGenes;
  (Object.keys(GENE_BOUNDS) as Array<keyof StrategyGenes>).forEach((key, i) => {
    const bounds = GENE_BOUNDS[key];
    const value = bounds.min + Math.max(0, Math.min(1, point[i] ?? 0.5)) * (bounds.max - bounds.min);
    genes[key] = bounds.integer ? Math.round(value) : Number(value.toFixed(3));
  });
  return genes;
}
