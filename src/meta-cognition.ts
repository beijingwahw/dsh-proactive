/**
 * meta-cognition.ts — 元认知监控引擎（"彻底自主智能"核心组件 2/4）
 *
 * 职责：系统对"自身运行状态"的觉察与调节——监控自己的 KPI、
 * 检测退化、自主调整运行参数、为无法自愈的问题生成自愈目标。
 *
 * 能力矩阵：
 * 1. KPI 快照采集：成功率 / 平均质量 / 平均延迟 / 决策缓存命中率 /
 *    模型健康度（单模型成功率过低自动标记降级）
 * 2. 异常检测：滑动窗口 + z-score 检测 KPI 突变，连续低于目标线判定退化
 * 3. 参数自调优：检测到退化时自主调整可调参数（质量阈值 / 重试次数 /
 *    聚合窗口），调整动作经 applier 回调落地到真实引擎
 * 4. 自愈目标触发：参数调整仍无法解决的结构性问题（如某模型持续失败）
 *    产出高严重度洞察，交给目标引擎生成自愈目标
 * 5. 健康报告：综合评分 + 各 KPI 状态 + 调整历史，可查询可追溯
 * 6. 3.0：相对基线偏差带（attachRelativeKpiBand）：KPI 判定从静态目标线
 *    升级为「相对自身滚动基线的偏离」（中位数 ± 稳健 MAD 带，借 23.0
 *    稳健统计思想自实现 robustBaseline）——慢漂移在静态阈值之前暴露，
 *    平稳噪声不误报；时钟可注入（config.clock，确定性验证口径）
 * 7. 4.0：多时间尺度监控（attachMultiScaleMonitor）：同一 KPI 的短/中/长
 *    三窗并行监控——短窗灵敏（毛刺立即可见）、长窗稳态（锚定冻结基线）；
 *    报警携带尺度标签，短窗报警但长窗健康时降级为「波动」而非「退化」
 *    （单次毛刺不打扰调参），中窗先行时报「慢漂移」，三尺度同向才报
 *    「真退化」——尺度区分取代单一阈值的「一切突变都算退化」。
 * 8. 4.0：KPI 相关性图（attachKpiCorrelation）：KPI 间滚动 Pearson 相关
 *    矩阵——一个调整常同时影响多个联动 KPI（归因混淆源）；调整动作
 *    自动附注受影响 KPI 集合（TuningAction.affectedKpis），把「调 A 却
 *    动了 B」的暗耦合显式化。
 */

import type { Insight } from './goal-engine.js';
import type { CausalEffect, CausalKernel } from './core/causal-kernel.js';
import {
  AnytimeEvidenceStream,
  EProcess,
  EmpiricalBernsteinSequence,
  type AnytimeVerdict,
} from './core/anytime-evidence.js';
import { TransportDriftMonitor, type TransportDriftView } from './core/optimal-transport.js';
import { LocalLinearTrendFilter, type TrendFilterConfig, type TrendStepRead } from './core/kalman-filter.js';
import { dynamicsRegime, type DynamicsAssessment, type DynamicsRegime } from './core/nonlinear-dynamics.js';
import { multiScaleView } from './core/multiscale-wavelet.js';
// 创世纪 57.0：变分推断（平均场后验，6.0 自由能 q 分布的供给方）
import { VariationalEngine } from './core/variational-inference.js';

/** KPI 快照 */
export interface KpiSnapshot {
  timestamp: number;
  /** 执行成功率 0~1 */
  successRate: number;
  /** 平均质量分 0~1 */
  avgQuality: number;
  /** 平均延迟（毫秒） */
  avgLatency: number;
  /** 决策缓存命中率 0~1 */
  cacheHitRate: number;
  /** 各模型成功率（模型健康度） */
  modelSuccessRates: Record<string, number>;
  /** 当前活跃执行数 */
  activeExecutions: number;
}

/** KPI 异常事件 */
export interface KpiAnomaly {
  kpi: string;
  value: number;
  /** 窗口均值 */
  baseline: number;
  /** z-score（绝对值） */
  zScore: number;
  direction: 'degraded' | 'improved';
  timestamp: number;
}

/** 参数调整动作 */
export interface TuningAction {
  parameter: 'qualityThreshold' | 'maxRetries' | 'aggregationWindow';
  from: number;
  to: number;
  reason: string;
  timestamp: number;
  /** 5.0：因果依据（该旋钮对目标 KPI 的干预效应估计） */
  causalBasis?: { ate: number; lower: number; confidence: number; interventionalSamples: number };
  /**
   * 4.0：受影响 KPI 集合（挂载 attachKpiCorrelation 后自动附注）。
   *
   * 与目标 KPI 滚动相关 |r| ≥ 阈值的 KPI 一并列入——调整的影响面从
   * 「我以为只动 A」升级为「相关图说 B/C 也会被牵动」，归因时防止
   * 把联动的 B 变化误记到别的头上。
   */
  affectedKpis?: string[];
}

/** 健康报告 */
export interface HealthReport {
  healthy: boolean;
  score: number;
  message?: string;
  samples?: number;
  kpis: {
    successRate?: number;
    avgQuality?: number;
    avgLatency?: number;
    cacheHitRate?: number;
  };
  degradeStreaks?: Record<string, number>;
  recentAnomalies?: KpiAnomaly[];
  recentTuning?: TuningAction[];
  /**
   * 6.0：感知侧自由能（EMA 惊奇，nat）——统一健康度。
   *
   * 与逐项 KPI 的本质区别：KPI 各自为政（成功率降/质量降/缓存降），
   * 自由能度量的是系统生成模型对世界的「预测握力」——无论哪项
   * 漂移，惊奇都会上升。一个数字回答「系统整体还理解这个世界吗」。
   */
  freeEnergy?: { surprisalEma: number; samples: number; interpretation: string };
  /**
   * 7.0：梦校准（深思心智的想象可靠性 KPI）。
   *
   * 自由能度量「系统预测世界有多准」；梦校准度量「系统预测
   * **自己的计划**有多准」——想象推演 vs 真实执行的逐步误差。
   * 校准差 = 计划在脑内排练的成绩与现实的落差：想象不可信时，
   * 深思搜索的结论全部作废（应先修转移模型再规划）。
   */
  imagination?: { calibrationEma: number; plansSettled: number; skills: number; interpretation: string };
  /**
   * 8.0：认知经济（元认知心智 KPI——思考的价格与价值核算）。
   *
   * 自由能度量预测世界的准确度，梦校准度量预测自己计划的准确度；
   * 认知经济度量**思考本身用得值不值**——习惯命中率（摊销节省）、
   * 搜索开销（nat 计价）、模式成功率（思考价值的实测）、元遗憾
   * （本不该省的思考）。三个 KPI 层层递进：世界→计划→心智自身。
   */
  cognitiveEconomy?: import('./core/metareasoning.js').CognitiveEconomy;
  /**
   * 9.0：抽象统计（抽象心智 KPI——举一反三的实绩）。
   *
   * 认知经济度量思考用得值不值；抽象统计度量**经验是否跨域流动**：
   * 类比迁移次数、零样本应答（冷状态凭结构同构直接给出非无知
   * 估计）、后继结构继承、跨域宏技能数。KPI 第四层：世界→计划→
   * 心智→心智的泛化能力。
   */
  abstraction?: import('./core/abstraction.js').AbstractionStats;
  /**
   * 10.0：知识前沿（科学家心智 KPI——知识获取的经济学）。
   *
   * 抽象统计度量经验是否跨域流动；知识前沿度量**求知本身值不值**：
   * 因果问题的残差熵总量（知识版图的未知量）、混杂分歧数（唯有
   * 干预可裁决）、实验兑现率（承诺 EIG vs 实现信息增益——设计者
   * 诚实度的内生度量）。KPI 第五层：世界→计划→心智→泛化→求知。
   */
  knowledgeFrontier?: import('./core/scientist.js').KnowledgeFrontier;
  /**
   * 11.0：理论前沿（理论心智 KPI——知识的压缩与体系化）。
   *
   * 知识前沿度量求知值不值；理论前沿度量**知识是否成体系**：
   * 在世定律数、被压缩的边数、累计省下的描述长度（理解即压缩，
   * nat 口径）、零样本预测次数（定律泛化）、范式转移次数
   * （定律被推翻重建——科学的自我修正力）。KPI 第六层：
   * 世界→计划→心智→泛化→求知→体系化。
   */
  theoryFrontier?: import('./core/theorist.js').TheoryFrontier;
  /**
   * 12.0：KPI 保证层（任意时刻有效裁决——退化判定的数学背书）。
   *
   * z-score/连续计数是固定样本统计，反复读取会累积假阳性（偷看悖论）；
   * 保证层为关键 KPI 维护 e-过程证据流，以目标线为水位线：
   * 「KPI 真实水平低于目标」这一结论在**任意时刻**读取都有效
   * （e ≥ 1/α 才确证，否则诚实 undecided）——退化告警第一次
   * 免疫偷看，恢复确证同理。KPI 第七层：世界→计划→心智→泛化→
   * 求知→体系化→结论本身的可信度。
   */
  guarantees?: {
    streams: Array<{
      kpi: string;
      reference: number;
      verdict: AnytimeVerdict;
      /** 情节化当前状态：degraded = 确证退化中；recovered = 已确证恢复；undefined = 尚未确证过 */
      regime?: 'degraded' | 'recovered';
      eBelow: number;
      anytimeP: number;
      n: number;
      cs: { lower: number; upper: number };
    }>;
    interpretation: string;
  };
  /**
   * 27.0：卡尔曼滤波层（挂载后输出）——KPI 的去噪读数（level）、
   * 缓慢漂移的早期读数（slope）与突变门控状态（NIS 假设检验）。
   */
  kalman?: {
    streams: Array<{ kpi: string; level: number; slope: number; nis: number; threshold: number; gated: boolean }>;
    interpretation: string;
  };
  /**
   * 3.0：相对基线偏差带（挂载 attachRelativeKpiBand 后输出）。
   *
   * KPI 判定从「静态目标线」升级为「相对自身基线的偏离」：滚动中位数
   * ± 稳健 MAD 带（借 23.0 稳健统计思想自实现，见 robustBaseline）。
   * 静态线回答「还达标吗」（0.95 → 0.7 之间的一切都算健康，慢漂移
   * 全程不可见）；相对带回答「还是原来的我吗」——基线 0.95 的系统
   * 跌到 0.88 仍是静态意义上的「健康」，但相对自身已显著退化，
   * 报警比静态线早几十个批次，且对平稳噪声不误报（MAD 口径）。
   */
  relativeBands?: {
    streams: Array<{
      kpi: string;
      samples: number;
      baselineMedian: number;
      madSigma: number;
      value: number;
      robustZ: number;
      bandWidthMad: number;
      outOfBand: boolean;
      degraded: boolean;
    }>;
    interpretation: string;
  };
  /**
   * 4.0：多时间尺度监控（挂载 attachMultiScaleMonitor 后输出）。
   *
   * 同一 KPI 的短/中/长三窗读数（各窗均值 vs 冻结锚点的退化方向归一
   * 偏离 z）+ 当前报警尺度集合 + 尺度合成判级（fluctuation 波动 /
   * drift 慢漂移 / degradation 真退化）。
   */
  multiScale?: { streams: MultiScaleRead[]; interpretation: string };
  /**
   * 4.0：KPI 相关性图（挂载 attachKpiCorrelation 后输出）——滚动
   * Pearson 相关矩阵与联动对（|r| ≥ 阈值），调整的影响面据此附注。
   */
  kpiCorrelations?: {
    window: number;
    samples: number;
    threshold: number;
    pairs: Array<{ a: string; b: string; r: number; linked: boolean }>;
    interpretation: string;
  };
}

/** 元认知配置 */
export interface MetaCognitionConfig {
  /** KPI 历史窗口大小 */
  windowSize: number;
  /** z-score 异常判定阈值 */
  zScoreThreshold: number;
  /** 成功率目标线（低于该值判定退化） */
  successRateTarget: number;
  /** 质量目标线 */
  qualityTarget: number;
  /** 连续低于目标线多少次触发调优 */
  degradeStreakThreshold: number;
  /** 单模型成功率低于该值标记降级 */
  modelHealthThreshold: number;
  /** 参数调整冷却期（毫秒，防止震荡） */
  tuningCooldownMs: number;
  /** 参数调整落地回调（由 index.ts 桥接到真实引擎） */
  applier?: (action: TuningAction) => void;
  /**
   * 读取当前真实质量阈值的回调（可选注入）。
   * 提供时 successRate 退化规则的 from/to 以当前实际阈值（而非成功率
   * 目标）为基线——「放宽」才名实相符；未提供时保持旧行为（零漂移）。
   */
  getQualityThreshold?: () => number;
  /**
   * 3.0：注入时钟（确定性验证口径）。
   * 提供时异常/调参时间戳全部取自该时钟（缺省 Date.now，行为不变）。
   */
  clock?: () => number;
}

/** 默认配置 */
export const DEFAULT_META_COGNITION_CONFIG: MetaCognitionConfig = {
  windowSize: 20,
  zScoreThreshold: 2,
  successRateTarget: 0.8,
  qualityTarget: 0.7,
  degradeStreakThreshold: 3,
  modelHealthThreshold: 0.4,
  tuningCooldownMs: 30_000,
};

// ─────────────────── 3.0：相对基线偏差带（稳健统计小工具 + 挂载口径） ───────────────────

/**
 * 3.0：稳健基线估计（借 23.0 稳健统计思想自实现：中位数 + MAD×1.4826）。
 *
 * 为什么不用均值/标准差：窗口里的漂移样本会污染自己的基线（均值被
 * 拉着走，慢漂移在窗口内永远「看起来正常」）；离群点会把 σ 撑大，
 * 让后续真突变全部漏报。中位数对 50% 以下的污染不敏感，MAD（中位
 * 绝对偏差）×1.4826 是正态一致的标准差稳健估计——基线只反映「系统
 * 一直在哪」，不反映「系统最近被漂移/离群带去了哪」。
 *
 * @param samples 非空有限数样本（基线窗；不含待检的当前值）
 * @returns median 中位数；madSigma = 1.4826×MAD（退化时兜底 1e-9，
 *          此时任何偏离当前中位数的值都会满格越带——诚实退化为电平检测）
 */
export function robustBaseline(samples: number[]): { median: number; madSigma: number } {
  const n = samples.length;
  if (n === 0) return { median: Number.NaN, madSigma: Number.NaN };
  const sorted = [...samples].sort((a, b) => a - b);
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const deviations = samples.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
  const mad = n % 2 === 1 ? deviations[(n - 1) / 2] : (deviations[n / 2 - 1] + deviations[n / 2]) / 2;
  return { median, madSigma: Math.max(1.4826 * mad, 1e-9) };
}

/** 3.0：相对基线带挂载选项 */
export interface RelativeKpiBandOptions {
  /** 覆盖的 KPI（缺省全部四项） */
  kpis?: Array<'successRate' | 'avgQuality' | 'avgLatency' | 'cacheHitRate'>;
  /** 滚动窗口长度（缺省 24；当前值与基线窗合并后有界） */
  window?: number;
  /** 越带带宽（单位 = 稳健 σ；缺省 3.5） */
  bandWidthMad?: number;
  /** 基线生效的最小样本数（缺省 8） */
  minSamples?: number;
}

/** 3.0：单 KPI 的相对基线带读数（纯读取） */
export interface RelativeKpiBandRead {
  kpi: string;
  samples: number;
  baselineMedian: number;
  madSigma: number;
  value: number;
  /** 稳健 z = (value − median) / madSigma */
  robustZ: number;
  bandWidthMad: number;
  outOfBand: boolean;
  /** 退化方向（avgLatency 上升 = 退化；其余下降 = 退化） */
  degraded: boolean;
}

// ─────────────────── 4.0：多时间尺度监控 + KPI 相关性图 ───────────────────

/** 4.0：多时间尺度判级（尺度合成的报警等级） */
export type MultiScaleKind = 'healthy' | 'fluctuation' | 'drift' | 'degradation';

/** 4.0：尺度标签（报警携带） */
export type MultiScaleTag = 'short' | 'medium' | 'long';

/** 4.0：多时间尺度监控挂载选项 */
export interface MultiScaleMonitorOptions {
  /** 覆盖的 KPI（缺省全部四项） */
  kpis?: Array<'successRate' | 'avgQuality' | 'avgLatency' | 'cacheHitRate'>;
  /** 短窗长度（灵敏尺度；缺省 4） */
  shortWindow?: number;
  /** 中窗长度（慢漂移尺度；缺省 12） */
  mediumWindow?: number;
  /** 长窗长度（稳态锚定尺度；缺省 36） */
  longWindow?: number;
  /** 短窗报警阈值（退化方向归一偏离；缺省 3） */
  shortZ?: number;
  /** 中窗报警阈值（缺省 3） */
  mediumZ?: number;
  /** 长窗报警阈值（缺省 3） */
  longZ?: number;
  /**
   * σ 下限（锚点中位数的相对比例，缺省 0.02）：常序列 MAD=0 时任何
   * 偏离都是 ∞σ（电平检测退化），σ 下限给出「相对基线 2% 以内不算
   * 事」的物理底——阈值语义对任意 KPI 量纲一致。
   */
  relFloor?: number;
}

/** 4.0：单 KPI 的多时间尺度读数（纯读取） */
export interface MultiScaleRead {
  kpi: string;
  /** 长窗积累的样本数（未满 longWindow 时读数缺席） */
  samples: number;
  /** 冻结锚点中位数（清晰健康时缓慢重锚；异常期冻结） */
  anchorMedian: number;
  /** σ 下界 = max(锚点 MAD σ, relFloor×|锚点中位数|) */
  sigmaFloor: number;
  shortMean: number;
  mediumMean: number;
  longMean: number;
  /** 退化方向归一偏离（正 = 退化幅度；各窗均值 vs 锚点 / σ 下界） */
  shortZ: number;
  mediumZ: number;
  longZ: number;
  /** 当前越限报警的尺度集合 */
  scales: MultiScaleTag[];
  /** 尺度合成判级 */
  kind: MultiScaleKind;
}

/** 4.0：KPI 相关性图挂载选项 */
export interface KpiCorrelationOptions {
  /** 参与相关矩阵的 KPI（缺省全部四项） */
  kpis?: Array<'successRate' | 'avgQuality' | 'avgLatency' | 'cacheHitRate'>;
  /** 滚动窗口长度（缺省 24） */
  window?: number;
  /** 出相关读数的最小样本数（缺省 12） */
  minSamples?: number;
  /** 联动判定阈值 |r| ≥ threshold（缺省 0.7） */
  threshold?: number;
}

/**
 * 元认知监控引擎
 *
 * 被 index.ts 持有：autonomy-loop 每轮心跳采集 KPI 快照并调用 observe()，
 * 引擎自动完成异常检测、参数调优与自愈洞察产出。
 */
export class MetaCognitionEngine {
  private config: MetaCognitionConfig;
  private history: KpiSnapshot[] = [];
  private anomalies: KpiAnomaly[] = [];
  private tuningHistory: TuningAction[] = [];
  /** 各 KPI 连续低于目标线的次数 */
  private degradeStreaks = new Map<string, number>();
  private lastTuningAt = 0;
  /** 5.0：因果内核（挂载后旋钮推荐按因果效应排序） */
  private causal?: CausalKernel;
  /** 待结算的调参干预（动作 → 下一批 KPI 快照对账） */
  private pendingTuningInterventions: Array<{ action: TuningAction; kpi: string; baseline: number }> = [];

  constructor(config?: Partial<MetaCognitionConfig>) {
    this.config = { ...DEFAULT_META_COGNITION_CONFIG, ...config };
  }

  /** 3.0：统一时钟（注入时钟优先；缺省 wall-clock，行为不变） */
  private now(): number {
    return this.config.clock ? this.config.clock() : Date.now();
  }

  /** 5.0：挂载因果内核（幂等） */
  attachCausalKernel(kernel: CausalKernel): void {
    this.causal = kernel;
  }

  /** 6.0：挂载自由能引擎（幂等；健康报告开始携带统一自由能 KPI） */
  attachFreeEnergyEngine(engine: import('./core/free-energy.js').FreeEnergyEngine): void {
    this.freeEnergyEngine = engine;
  }

  /** 7.0：挂载深思内核（梦校准 KPI 数据源；幂等） */
  attachDeliberationEngine(engine: import('./core/deliberation.js').DeliberationEngine): void {
    this.deliberationEngine = engine;
  }

  /** 8.0：挂载元推理内核（认知经济 KPI 数据源；幂等） */
  attachMetareasoner(reasoner: import('./core/metareasoning.js').RationalMetareasoner): void {
    this.metareasoner = reasoner;
  }

  /** 9.0：挂载抽象内核（抽象统计 KPI 数据源；幂等） */
  attachAbstractionEngine(engine: import('./core/abstraction.js').AbstractionEngine): void {
    this.abstractionEngine = engine;
  }

  /** 10.0：挂载科学家内核（知识前沿 KPI 数据源；幂等） */
  attachScientistMind(mind: import('./core/scientist.js').ScientistMind): void {
    this.scientistMind = mind;
  }

  /** 11.0：挂载理论内核（理论前沿 KPI 数据源；幂等） */
  attachTheoristEngine(engine: import('./core/theorist.js').TheoristEngine): void {
    this.theoristEngine = engine;
  }

  /**
   * 57.0：挂载变分推断（幂等覆盖，挂载即生效——旁路咨询口径）。
   *
   * variationalPosterior() 把「点估计 + 手拍区间」升级为平均场高斯后验
   * N(m_i, s_i²)（CAVI / Armijo 回溯，ELBO 单调可审计）——为 6.0 自由能
   * 引擎的 KL(q‖p) 提供真正的 q 分布；fit().converged === false 时不采信
   * （诚实降级，不拿半收敛的后验冒充真后验）。不改变任何既有 KPI 路径
   * （零漂移）。
   */
  attachVariationalInference(options?: Partial<import('./core/variational-inference.js').VIConfig>): void {
    this.variationalConfig = options ?? {};
  }

  /** 57.0：变分推断配置（未挂载 undefined） */
  private variationalConfig?: Partial<import('./core/variational-inference.js').VIConfig>;

  /**
   * 57.0：平均场后验拟合（未挂载返回 undefined）。
   * @param problem VI 问题（linearRegression 共轭闭式 / gaussianVI 非共轭）
   */
  variationalPosterior(
    problem: import('./core/variational-inference.js').VIProblem,
    options?: import('./core/variational-inference.js').VIFitOptions,
  ): import('./core/variational-inference.js').VIFitResult | undefined {
    if (!this.variationalConfig) return undefined;
    try {
      return new VariationalEngine(problem, this.variationalConfig).fit(options);
    } catch {
      return undefined; // 问题规格非法 → 诚实降级
    }
  }

  private freeEnergyEngine?: import('./core/free-energy.js').FreeEnergyEngine;
  private theoristEngine?: import('./core/theorist.js').TheoristEngine;
  private deliberationEngine?: import('./core/deliberation.js').DeliberationEngine;
  private metareasoner?: import('./core/metareasoning.js').RationalMetareasoner;
  private abstractionEngine?: import('./core/abstraction.js').AbstractionEngine;
  private scientistMind?: import('./core/scientist.js').ScientistMind;
  /** 12.0：KPI 保证层（挂载后退化/恢复判定获得任意时刻有效背书） */
  private anytimeGuards?: Map<string, AnytimeEvidenceStream>;
  /** 17.0：形状感知传输漂移监视（挂载后分布形状变化可见） */
  private transportDrift?: Map<string, TransportDriftMonitor>;
  /** 17.0：各 KPI 的上次漂移态（翻转沿触发洞察） */
  private transportDriftState = new Map<string, boolean>();
  /** 27.0：KPI 局部线性趋势滤波器（挂载后异常判定升级为 NIS 假设检验） */
  private kalmanFilters?: Map<string, LocalLinearTrendFilter>;
  /** 38.0：KPI 动力学体质序列（attachChaosDiagnostics 后积累） */
  private chaosSeries?: Map<string, number[]>;
  /** 38.0：已确立的动力学体质（翻转沿洞察的去重状态） */
  private chaosRegimeState = new Map<string, DynamicsRegime>();
  /** 27.0：各 KPI 的上次门控态（翻转沿触发洞察） */
  private kalmanGateState = new Map<string, boolean>();
  /** 12.0：保证层显著性水平（e ≥ 1/α 才确证） */
  private guardAlpha = 0.05;
  /**
   * 12.0：KPI 情节化状态机（首次确证退化后启用）。
   *
   * 全历史 e-过程的资本是只涨难跌的累计证据——确证退化后，即使 KPI
   * 完全恢复，旧资本也会长期压住「已恢复」的事实（恢复不可检测）。
   * 状态机改以水位线两侧的**连续 run** 为情节：恢复通道只吃水位线上
   * 连续批次的证据（e-过程确证 H0: μ ≤ 水位线 被拒，或 CS 下界越过
   * 水位线）；再劣化通道对称。跨线即重置对侧通道（翻转沿语义，
   * 稳态不重复打扰）。
   *
   * 有效性口径（如实标注）：报警方向（首次确证）始终保持全历史
   * 任意时刻有效（Ville，偷看免疫）；情节化通道是「重启式监测」——
   * 每次重启都是合法的水平 α 检验，跨情节的选择效应不具全局有效性
   * （重启式监测的标准取舍：报警从严，全清从宽）。
   */
  private regimeWatches?: Map<
    string,
    {
      regime: 'degraded' | 'recovered';
      recovery: { e: EProcess; cs: EmpiricalBernsteinSequence };
      degrade: { e: EProcess; cs: EmpiricalBernsteinSequence };
    }
  >;

  /** 新建一条情节通道（e-过程 + 置信序列） */
  private newGuardChannel(reference: number, side: 'at-most' | 'at-least') {
    return { e: new EProcess(reference, side), cs: new EmpiricalBernsteinSequence(this.guardAlpha) };
  }

  /**
   * 12.0：挂载 KPI 保证层（幂等）。
   *
   * 为 successRate / avgQuality 各建一条 e-过程证据流，水位线 =
   * 各自目标线。「低于目标」的告警从此自带数学保证：任意时刻、
   * 任意频率地读取都不夸大（偷看免疫）。
   */
  attachAnytimeGuards(options?: { alpha?: number }): void {
    const alpha = options?.alpha ?? 0.05;
    this.guardAlpha = alpha;
    this.anytimeGuards = new Map([
      ['successRate', new AnytimeEvidenceStream({ alpha, reference: this.config.successRateTarget })],
      ['avgQuality', new AnytimeEvidenceStream({ alpha, reference: this.config.qualityTarget })],
    ]);
    this.regimeWatches = new Map();
  }

  /**
   * 17.0：挂载形状感知传输漂移监视（幂等；缺省覆盖 avgQuality / avgLatency）。
   *
   * 12.0 保证层盯**均值水位**（μ 是否越过目标线），本层盯**分布形状**
   * （滑动窗 vs 基准窗的 Wasserstein-1）——均值不变而形状巨变
   * （双峰化 / 尾部变厚）的「换了世界」第一次可见；13.0 保形区间的
   * 覆盖保证在漂移下失效，本层是其绊线。阈值自适应（历史 W₁ 分位），
   * 不 attach 即零漂移。
   */
  attachTransportDrift(
    options?: Partial<{ kpis: Array<'successRate' | 'avgQuality' | 'avgLatency' | 'cacheHitRate'>; windowSize: number; referenceSize: number; thresholdQuantile: number; minSamples: number }>,
  ): void {
    const kpis = options?.kpis ?? ['avgQuality', 'avgLatency'];
    // 仅传递已定义字段（显式 undefined 展开会覆盖内核缺省值）
    const monitorOptions: Record<string, number | undefined> = {};
    for (const key of ['windowSize', 'referenceSize', 'thresholdQuantile', 'minSamples'] as const) {
      const v = options?.[key];
      if (typeof v === 'number' && Number.isFinite(v)) monitorOptions[key] = v;
    }
    this.transportDrift = new Map();
    for (const kpi of kpis) {
      this.transportDrift.set(kpi, new TransportDriftMonitor(monitorOptions));
    }
  }

  /** 17.0：形状漂移检验（每批快照后调用；翻转沿产出洞察，稳态不重复打扰） */
  private checkTransportDrift(kpi: string, value: number): Insight[] {
    const monitor = this.transportDrift?.get(kpi);
    if (!monitor) return [];
    const view = monitor.observe(value);
    const last = this.transportDriftState.get(kpi) ?? false;
    this.transportDriftState.set(kpi, view.drifting);
    if (!view.drifting || last) return []; // 只在进入漂移的翻转沿打扰
    return [
      {
        source: 'meta-cognition',
        category: 'distribution-shape-drift',
        severity: Math.min(0.95, 0.5 + view.severity * 0.2),
        message: `KPI ${kpi} 分布形状漂移（${view.interpretation}）`,
        suggestion:
          view.kind === 'shape' || view.kind === 'both'
            ? '均值水位未动但分布已变形：保形区间/置信序列的口径前提正在失效，优先排查上游数据源或模型行为变化，必要时重建校准集'
            : '分布整体位移：结合因果旋钮排序实施干预，并观察 12.0 保证层的后续裁决',
      },
    ];
  }

  /** 17.0：各 KPI 的当前形状漂移视图（纯读取；未挂载返回 undefined） */
  transportDriftView(kpi: string): TransportDriftView | undefined {
    return this.transportDrift?.get(kpi)?.drift();
  }

  /**
   * 27.0：挂载 KPI 卡尔曼滤波层（幂等；缺省覆盖 successRate / avgQuality /
   * avgLatency / cacheHitRate）。
   *
   * 1 号 z-score 检查是窗口内无记忆比较；本层把整条历史压进 (level, slope)
   * 充分统计量——异常判定从启发式升级为 NIS 假设检验（新息平方和超出
   * χ²(1) 99.7% 分位才报警），缓慢漂移由滤波斜率给出早期读数。
   * 不 attach 即零漂移。
   */
  attachKalmanAnomaly(options?: Partial<TrendFilterConfig> & { kpis?: Array<'successRate' | 'avgQuality' | 'avgLatency' | 'cacheHitRate'> }): void {
    const kpis = options?.kpis ?? ['successRate', 'avgQuality', 'avgLatency', 'cacheHitRate'];
    const filterOptions: Partial<TrendFilterConfig> = {};
    for (const key of ['qLevel', 'qSlope', 'r', 'gateP', 'p0Level', 'p0Slope'] as const) {
      const v = options?.[key];
      if (typeof v === 'number' && Number.isFinite(v)) filterOptions[key] = v;
    }
    this.kalmanFilters = new Map();
    for (const kpi of kpis) {
      this.kalmanFilters.set(kpi, new LocalLinearTrendFilter(filterOptions));
    }
  }

  /** 27.0：KPI 的当前滤波读数（纯读取；未挂载返回 undefined） */
  kalmanView(kpi: string): TrendStepRead | undefined {
    return this.kalmanFilters?.get(kpi)?.lastRead;
  }

  /**
   * 38.0：挂载动力学体质诊断（幂等覆盖，挂载即生效）。
   *
   * 每个 KPI 序列积累满 minPoints（缺省 96）后做体质分类：混沌
   * （λ₁ > 0，预测视野 ~1/λ₁ 步）、持续（H > 0.5+δ，趋势自我强化）、
   * 反持续（H < 0.5−δ，均值回归）、随机漫步（无结构）。体质确立的
   * 翻转沿产出洞察——**同一份 KPI，三种读法**：混沌序列上精细预测器
   * 的置信应随视野收窄、持续序列的趋势洞察加权、反持续序列的「突破」
   * 多半回归。未挂载零漂移。
   */
  attachChaosDiagnostics(options?: {
    kpis?: Array<'successRate' | 'avgQuality' | 'avgLatency' | 'cacheHitRate'>;
    minPoints?: number;
    lambdaThreshold?: number;
    hurstDelta?: number;
  }): void {
    const kpis = options?.kpis ?? ['successRate', 'avgQuality', 'avgLatency', 'cacheHitRate'];
    this.chaosMinPoints = Math.max(64, Math.floor(options?.minPoints ?? 96));
    this.chaosOptions = { lambdaThreshold: options?.lambdaThreshold, hurstDelta: options?.hurstDelta };
    this.chaosSeries = new Map();
    this.chaosRegimeState = new Map();
    for (const kpi of kpis) this.chaosSeries.set(kpi, []);
  }

  private chaosMinPoints = 96;
  private chaosOptions: { lambdaThreshold?: number; hurstDelta?: number } = {};

  /**
   * 49.0：挂载多尺度小波视图（幂等覆盖，挂载即生效——纯读数口径）。
   *
   * KPI 序列经 Haar 小波分解为对数个正交尺度：最粗趋势（长期水平）、
   * 中尺度细节（漂移带能量）、最细细节（瞬时突发）——单尺度异常检测
   * 看不见的「慢漂移 vs 快突发」结构分离。waveletView 给出各尺度能量
   * 落位；洞察消费留给上层（零漂移：仅新增读数）。
   */
  attachWaveletView(options?: { kpis?: Array<'successRate' | 'avgQuality' | 'avgLatency' | 'cacheHitRate'>; minPoints?: number }): void {
    const kpis = options?.kpis ?? ['successRate', 'avgQuality', 'avgLatency', 'cacheHitRate'];
    this.waveletMinPoints = Math.max(32, Math.floor(options?.minPoints ?? 64));
    this.waveletSeries = new Map();
    for (const kpi of kpis) this.waveletSeries.set(kpi, []);
  }

  private waveletSeries?: Map<string, number[]>;
  private waveletMinPoints = 64;

  /** 49.0：KPI 的多尺度读数（纯读取；未挂载/未满窗返回 undefined） */
  waveletView(kpi: string): { trendLevel: number; burstShare: number; dominantScale: string; driftShare: number } | undefined {
    const series = this.waveletSeries?.get(kpi);
    if (!series || series.length < this.waveletMinPoints) return undefined;
    return multiScaleView(series);
  }

  /** 49.0：序列喂入（observe 的 0.9 段调用；未挂载零开销） */
  private feedWavelet(kpi: string, value: number): void {
    const series = this.waveletSeries?.get(kpi);
    if (!series || !Number.isFinite(value)) return;
    series.push(value);
    if (series.length > 256) series.splice(0, series.length - 256);
  }

  // ─────────────────── 3.0：相对基线偏差带 ───────────────────

  /** 3.0：相对基线带滚动窗（kpi → 含当前值的最近 window 个观测） */
  private relativeBandWindows?: Map<string, number[]>;
  /** 3.0：各 KPI 的上次退化越带态（翻转沿触发洞察，稳态不重复打扰） */
  private relativeBandState = new Map<string, boolean>();
  /** 3.0：相对基线带参数（attach 时定格） */
  private relativeBandCfg = { window: 24, bandWidthMad: 3.5, minSamples: 8 };

  // ─────────────────── 4.0：多时间尺度监控 ───────────────────

  /** 4.0：多时间尺度状态（kpi → 滚动窗 + 冻结锚点 + 上次判级） */
  private multiScaleStreams?: Map<string, { window: number[]; anchor?: { median: number; madSigma: number }; lastKind: MultiScaleKind }>;
  /** 4.0：多时间尺度参数（attach 时定格） */
  private multiScaleCfg = {
    shortWindow: 4,
    mediumWindow: 12,
    longWindow: 36,
    shortZ: 3,
    mediumZ: 3,
    longZ: 3,
    relFloor: 0.02,
  };

  /**
   * 4.0：挂载多时间尺度监控（幂等覆盖，挂载即生效）。
   *
   * 三窗分工：短窗（缺省 4）对毛刺灵敏——单批恶化立刻越限；中窗
   * （缺省 12）区分「连续几批走弱」的慢漂移早期；长窗（缺省 36）锚定
   * 系统稳态（首个满窗的中位数±MAD 冻结为锚点，清晰健康时缓慢重锚，
   * 异常期冻结——锚点不被正在发生的退化拉走）。报警按尺度合成判级：
   * 仅短窗越限 = fluctuation（波动，不打扰调参）；中窗越限 = drift
   * （慢漂移早期）；长窗越限 = degradation（稳态已破，真退化）。
   * 未挂载零漂移。
   */
  attachMultiScaleMonitor(options?: MultiScaleMonitorOptions): void {
    const kpis = options?.kpis ?? ['successRate', 'avgQuality', 'avgLatency', 'cacheHitRate'];
    const long = Math.max(12, Math.floor(options?.longWindow ?? 36));
    const medium = Math.min(Math.max(4, Math.floor(options?.mediumWindow ?? 12)), long - 4);
    const short = Math.min(Math.max(2, Math.floor(options?.shortWindow ?? 4)), medium - 1);
    this.multiScaleCfg = {
      shortWindow: short,
      mediumWindow: medium,
      longWindow: long,
      shortZ: Number.isFinite(options?.shortZ) ? options!.shortZ! : 3,
      mediumZ: Number.isFinite(options?.mediumZ) ? options!.mediumZ! : 3,
      longZ: Number.isFinite(options?.longZ) ? options!.longZ! : 3,
      relFloor: Number.isFinite(options?.relFloor) ? options!.relFloor! : 0.02,
    };
    this.multiScaleStreams = new Map();
    for (const kpi of kpis) this.multiScaleStreams.set(kpi, { window: [], lastKind: 'healthy' });
  }

  /** 4.0：KPI 的多时间尺度读数（纯读取；未挂载/长窗未满返回 undefined） */
  multiScaleView(kpi: string): MultiScaleRead | undefined {
    const st = this.multiScaleStreams?.get(kpi);
    if (!st || st.window.length < this.multiScaleCfg.longWindow || !st.anchor) return undefined;
    return this.computeMultiScale(kpi, { window: st.window, anchor: st.anchor });
  }

  /** 4.0：尺度读数计算（纯函数：窗 + 锚点 → 三窗 z + 判级） */
  private computeMultiScale(
    kpi: string,
    st: { window: number[]; anchor: { median: number; madSigma: number } },
  ): MultiScaleRead {
    const cfg = this.multiScaleCfg;
    const { median, madSigma } = st.anchor;
    const sigmaFloor = Math.max(madSigma, cfg.relFloor * Math.abs(median), 1e-9);
    // 退化方向归一偏离：avgLatency 上升 = 退化；其余下降 = 退化
    const degradedShift = (mean: number) => (kpi === 'avgLatency' ? mean - median : median - mean);
    const meanOf = (n: number) => {
      const slice = st.window.slice(-n);
      return slice.reduce((s, v) => s + v, 0) / slice.length;
    };
    const shortZ = degradedShift(meanOf(cfg.shortWindow)) / sigmaFloor;
    const mediumZ = degradedShift(meanOf(cfg.mediumWindow)) / sigmaFloor;
    const longZ = degradedShift(meanOf(cfg.longWindow)) / sigmaFloor;
    const scales: MultiScaleTag[] = [];
    if (shortZ >= cfg.shortZ) scales.push('short');
    if (mediumZ >= cfg.mediumZ) scales.push('medium');
    if (longZ >= cfg.longZ) scales.push('long');
    const kind: MultiScaleKind = scales.includes('long')
      ? 'degradation'
      : scales.includes('medium')
        ? 'drift'
        : scales.includes('short')
          ? 'fluctuation'
          : 'healthy';
    return {
      kpi,
      samples: st.window.length,
      anchorMedian: median,
      sigmaFloor,
      shortMean: Number(meanOf(cfg.shortWindow).toFixed(4)),
      mediumMean: Number(meanOf(cfg.mediumWindow).toFixed(4)),
      longMean: Number(meanOf(cfg.longWindow).toFixed(4)),
      shortZ: Number(shortZ.toFixed(2)),
      mediumZ: Number(mediumZ.toFixed(2)),
      longZ: Number(longZ.toFixed(2)),
      scales,
      kind,
    };
  }

  /** 4.0：多时间尺度检验（每批快照后调用；判级翻转沿产出洞察） */
  private checkMultiScale(kpi: string, value: number): Insight[] {
    const st = this.multiScaleStreams?.get(kpi);
    if (!st || !Number.isFinite(value)) return [];
    st.window.push(value);
    if (st.window.length > this.multiScaleCfg.longWindow) st.window.splice(0, st.window.length - this.multiScaleCfg.longWindow);
    if (st.window.length < this.multiScaleCfg.longWindow) return []; // 长窗未满：诚实预热，不判
    // 首个满窗冻结为稳态锚点
    const anchor = st.anchor ?? (st.anchor = robustBaseline(st.window));
    const read = this.computeMultiScale(kpi, { window: st.window, anchor });
    // 清晰健康时缓慢重锚（跟随系统的合法慢迁移；异常期锚点冻结）
    if (read.kind === 'healthy' && read.longZ < this.multiScaleCfg.longZ * 0.5) {
      st.anchor = robustBaseline(st.window);
    }
    const last = st.lastKind;
    st.lastKind = read.kind;
    if (read.kind === 'healthy' || read.kind === last) return []; // 只在判级翻转沿打扰
    const cfg = this.multiScaleCfg;
    const scaleNote = `尺度标签 ${read.scales.join('+')}（短 z=${read.shortZ} / 中 z=${read.mediumZ} / 长 z=${read.longZ}，锚点 ${read.anchorMedian.toFixed(3)}）`;
    if (read.kind === 'fluctuation') {
      return [
        {
          source: 'meta-cognition',
          category: 'kpi-multiscale-fluctuation',
          severity: 0.35,
          message: `KPI ${kpi} 短窗（${cfg.shortWindow} 批）偏离长窗稳态但中/长窗健康——单次波动而非退化（${scaleNote}）`,
          suggestion: `短窗灵敏、长窗稳态未破：按波动处理（观察即可），勿触发调参或自愈——等待后续批读数确认是否持续；连续波动升级为 drift 时再行动`,
        },
      ];
    }
    if (read.kind === 'drift') {
      return [
        {
          source: 'meta-cognition',
          category: 'kpi-multiscale-drift',
          severity: 0.6,
          message: `KPI ${kpi} 中窗（${cfg.mediumWindow} 批）持续偏离而长窗稳态未破——慢漂移早期（${scaleNote}）`,
          suggestion: `中期持续走弱但稳态锚点尚存：结合 3.0 相对带与 27.0 滤波斜率定位漂移速率，在长窗破位（真退化）之前介入——此时干预成本最低`,
        },
      ];
    }
    return [
      {
        source: 'meta-cognition',
        category: 'kpi-multiscale-degradation',
        severity: 0.85,
        message: `KPI ${kpi} 短/中/长三尺度同向退化，长窗稳态锚点已破——真退化而非毛刺（${scaleNote}）`,
        suggestion: `稳态已破：按 ${kpi} 的因果旋钮排序实施干预并持续观察保证层裁决；与「kpi-multiscale-fluctuation」的区别在于长窗均值也越限——持续性得到确认`,
      },
    ];
  }

  // ─────────────────── 4.0：KPI 相关性图 ───────────────────

  /** 4.0：相关性滚动窗（kpi → 最近 window 个观测） */
  private kpiCorrelationWindows?: Map<string, number[]>;
  /** 4.0：相关性参数（attach 时定格） */
  private kpiCorrelationCfg = { window: 24, minSamples: 12, threshold: 0.7 };

  /**
   * 4.0：挂载 KPI 相关性图（幂等覆盖，挂载即生效）。
   *
   * 维护 KPI 间滚动 Pearson 相关矩阵：与目标 KPI |r| ≥ 阈值的 KPI 视为
   * 联动——调参动作自动附注 affectedKpis（调整的影响面），把「调 A 却
   * 动了 B」的暗耦合显式化（归因混淆的第一道防线）。未挂载零漂移。
   */
  attachKpiCorrelation(options?: KpiCorrelationOptions): void {
    const kpis = options?.kpis ?? ['successRate', 'avgQuality', 'avgLatency', 'cacheHitRate'];
    this.kpiCorrelationCfg = {
      window: Math.max(8, Math.floor(options?.window ?? 24)),
      minSamples: Math.max(4, Math.floor(options?.minSamples ?? 12)),
      threshold: Number.isFinite(options?.threshold) ? options!.threshold! : 0.7,
    };
    this.kpiCorrelationWindows = new Map();
    for (const kpi of kpis) this.kpiCorrelationWindows.set(kpi, []);
  }

  /** 4.0：Pearson 相关系数（常序列 → 0，诚实无相关） */
  private static pearson(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    if (n < 2) return 0;
    const sx = x.slice(-n);
    const sy = y.slice(-n);
    const mx = sx.reduce((s, v) => s + v, 0) / n;
    const my = sy.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i += 1) {
      num += (sx[i] - mx) * (sy[i] - my);
      dx += (sx[i] - mx) ** 2;
      dy += (sy[i] - my) ** 2;
    }
    const den = Math.sqrt(dx * dy);
    return den > 1e-12 ? num / den : 0;
  }

  /** 4.0：相关性矩阵视图（纯读取；未挂载/样本不足返回 undefined） */
  kpiCorrelationView():
    | { window: number; samples: number; threshold: number; pairs: Array<{ a: string; b: string; r: number; linked: boolean }> }
    | undefined {
    const windows = this.kpiCorrelationWindows;
    if (!windows) return undefined;
    const kpis = [...windows.keys()];
    const samples = kpis.length > 0 ? windows.get(kpis[0])!.length : 0;
    const pairs: Array<{ a: string; b: string; r: number; linked: boolean }> = [];
    if (samples >= this.kpiCorrelationCfg.minSamples) {
      for (let i = 0; i < kpis.length; i += 1) {
        for (let j = i + 1; j < kpis.length; j += 1) {
          const r = MetaCognitionEngine.pearson(windows.get(kpis[i])!, windows.get(kpis[j])!);
          pairs.push({ a: kpis[i], b: kpis[j], r: Number(r.toFixed(4)), linked: Math.abs(r) >= this.kpiCorrelationCfg.threshold });
        }
      }
    }
    return { window: this.kpiCorrelationCfg.window, samples, threshold: this.kpiCorrelationCfg.threshold, pairs };
  }

  /** 4.0：与目标 KPI 联动的 KPI 集合（|r| ≥ 阈值；纯读取） */
  linkedKpis(kpi: string): Array<{ kpi: string; r: number }> {
    const view = this.kpiCorrelationView();
    if (!view) return [];
    const linked: Array<{ kpi: string; r: number }> = [];
    for (const p of view.pairs) {
      if (p.a === kpi && p.linked) linked.push({ kpi: p.b, r: p.r });
      else if (p.b === kpi && p.linked) linked.push({ kpi: p.a, r: p.r });
    }
    return linked;
  }

  /** 4.0：相关性序列喂入（observe 调用；未挂载零开销） */
  private feedKpiCorrelation(kpi: string, value: number): void {
    const window = this.kpiCorrelationWindows?.get(kpi);
    if (!window || !Number.isFinite(value)) return;
    window.push(value);
    if (window.length > this.kpiCorrelationCfg.window) window.splice(0, window.length - this.kpiCorrelationCfg.window);
  }

  /**
   * 3.0：挂载相对基线偏差带（幂等覆盖，挂载即生效）。
   *
   * 与 1 号静态目标线 / 12.0 保证层 / 27.0 卡尔曼的分工：
   * - 静态目标线问「绝对水平是否达标」——慢漂移在 0.95→0.7 之间隐身；
   * - 保证层问「是否确证低于水位线」——同一水位线的偷看免疫裁决；
   * - 卡尔曼问「新息是否超模型方差」——需要状态转移模型先验；
   * - 本层问「是否偏离自身滚动基线」——中位数±MAD 带给出无先验、
   *   无绝对阈值的相对口径：基线跟系统走，慢漂移在静态线之前暴露，
   *   平稳噪声（|z| ≲ 1.5）不误报。
   */
  attachRelativeKpiBand(options?: RelativeKpiBandOptions): void {
    const kpis = options?.kpis ?? ['successRate', 'avgQuality', 'avgLatency', 'cacheHitRate'];
    this.relativeBandCfg = {
      window: Math.max(8, Math.floor(options?.window ?? 24)),
      bandWidthMad: Number.isFinite(options?.bandWidthMad) ? options!.bandWidthMad! : 3.5,
      minSamples: Math.max(3, Math.floor(options?.minSamples ?? 8)),
    };
    this.relativeBandWindows = new Map();
    this.relativeBandState = new Map();
    for (const kpi of kpis) this.relativeBandWindows.set(kpi, []);
  }

  /** 3.0：KPI 的当前相对基线带读数（纯读取；未挂载/样本不足返回 undefined） */
  relativeKpiBandView(kpi: string): RelativeKpiBandRead | undefined {
    const window = this.relativeBandWindows?.get(kpi);
    if (!window || window.length === 0) return undefined;
    const prior = window.slice(0, -1);
    if (prior.length < this.relativeBandCfg.minSamples) return undefined;
    const value = window[window.length - 1];
    return this.computeRelativeBand(kpi, prior, value);
  }

  /** 3.0：相对带计算（基线 = 不含当前值的先验窗） */
  private computeRelativeBand(kpi: string, prior: number[], value: number): RelativeKpiBandRead {
    const { median, madSigma } = robustBaseline(prior);
    const robustZ = (value - median) / madSigma;
    const outOfBand = Math.abs(robustZ) > this.relativeBandCfg.bandWidthMad;
    const degraded = outOfBand && (kpi === 'avgLatency' ? robustZ > 0 : robustZ < 0);
    return {
      kpi,
      samples: prior.length,
      baselineMedian: median,
      madSigma,
      value,
      robustZ,
      bandWidthMad: this.relativeBandCfg.bandWidthMad,
      outOfBand,
      degraded,
    };
  }

  /** 3.0：相对带检验（每批快照后调用；进入退化越带的翻转沿产出洞察） */
  private checkRelativeBand(kpi: string, value: number): Insight[] {
    const window = this.relativeBandWindows?.get(kpi);
    if (!window || !Number.isFinite(value)) return [];
    window.push(value);
    if (window.length > this.relativeBandCfg.window) window.splice(0, window.length - this.relativeBandCfg.window);
    const prior = window.slice(0, -1);
    if (prior.length < this.relativeBandCfg.minSamples) return [];
    const read = this.computeRelativeBand(kpi, prior, value);
    const last = this.relativeBandState.get(kpi) ?? false;
    this.relativeBandState.set(kpi, read.degraded);
    if (!read.degraded || last) return []; // 只在进入退化越带的翻转沿打扰
    const staticTarget =
      kpi === 'successRate' ? this.config.successRateTarget : kpi === 'avgQuality' ? this.config.qualityTarget : undefined;
    const staticNote =
      staticTarget !== undefined && value > staticTarget
        ? `（仍高于静态目标线 ${staticTarget}，静态口径此时不可见）`
        : '';
    return [
      {
        source: 'meta-cognition',
        category: 'kpi-relative-drift',
        severity: Math.min(0.85, 0.5 + Math.min(0.3, (Math.abs(read.robustZ) - read.bandWidthMad) / 20)),
        message: `KPI ${kpi} 相对自身基线显著偏离：当前 ${value.toFixed(3)} vs 滚动中位数 ${read.baselineMedian.toFixed(3)}（稳健 z=${read.robustZ.toFixed(1)}，MAD 带 ±${(read.bandWidthMad * read.madSigma).toFixed(4)}，${read.samples} 样本）${staticNote}`,
        suggestion:
          '相对基线早于静态阈值报警：系统正在偏离「一贯的自己」而非仅仅跌破绝对目标线——优先排查渐进性退化（模型缓慢劣化/负载结构漂移），结合 27.0 滤波斜率与 17.0 形状漂移定位漂移速率',
      },
    ];
  }

  /** 38.0：KPI 的动力学体质读数（纯读取；未挂载/未满窗返回 undefined） */
  chaosView(kpi: string): DynamicsAssessment | undefined {
    const series = this.chaosSeries?.get(kpi);
    if (!series || series.length < this.chaosMinPoints) return undefined;
    return dynamicsRegime(series, this.chaosOptions);
  }

  /** 38.0：体质分类（满窗后每批快照评估；翻转沿产出洞察） */
  private checkChaos(kpi: string, value: number): Insight[] {
    const series = this.chaosSeries?.get(kpi);
    if (!series || !Number.isFinite(value)) return [];
    series.push(value);
    if (series.length > 256) series.splice(0, series.length - 256);
    if (series.length < this.chaosMinPoints) return [];
    const assessment = dynamicsRegime(series, this.chaosOptions);
    const last = this.chaosRegimeState.get(kpi);
    this.chaosRegimeState.set(kpi, assessment.regime);
    if (last === undefined || last === assessment.regime || assessment.regime === 'stochastic') return [];
    const hints: Record<Exclude<DynamicsRegime, 'stochastic'>, { severity: number; message: string; suggestion: string }> = {
      chaotic: {
        severity: 0.7,
        message: `KPI ${kpi} 动力学体质转为混沌（λ₁=${assessment.lyapunov?.toFixed(3)} nat/步 > 0）：误差指数放大，可用预测视野约 ${assessment.forecastHorizonSteps} 步`,
        suggestion: '收窄 26.0 GP 校准与 2 号预测的信任视野至 ~1/λ₁ 步；混沌不是噪声——加大采样不解决敏感依赖，改用区间/包络口径而非点预测',
      },
      persistent: {
        severity: 0.55,
        message: `KPI ${kpi} 呈持续性（H=${assessment.hurst?.toFixed(2)} > 0.5）：趋势自我强化，动量口径成立`,
        suggestion: '趋势洞察加权：上升沿的健康度下滑更可能是真退化（勿当突发噪声 dismissing）；回落确认需更长证据',
      },
      'mean-reverting': {
        severity: 0.45,
        message: `KPI ${kpi} 呈反持续性（H=${assessment.hurst?.toFixed(2)} < 0.5）：均值回归，单点「突破」多半回摆`,
        suggestion: '突破类洞察降权：等待回归失败（连续越界）再升级；熔断/阈值口径可适度放宽瞬时抖动',
      },
    };
    const hint = hints[assessment.regime];
    return hint
      ? [{ source: 'meta-cognition', category: 'dynamics-regime', taskType: undefined, severity: hint.severity, message: hint.message, suggestion: hint.suggestion }]
      : [];
  }

  /** 27.0：NIS 门控检验（每批快照后调用；进入门控的翻转沿产出洞察） */
  private checkKalman(kpi: string, value: number): Insight[] {
    const filter = this.kalmanFilters?.get(kpi);
    if (!filter || !Number.isFinite(value)) return [];
    const read = filter.observe(value);
    const last = this.kalmanGateState.get(kpi) ?? false;
    this.kalmanGateState.set(kpi, read.gated);
    if (!read.gated || last) return []; // 只在进入门控的翻转沿打扰
    // 方向语义：延迟上升 / 其余下降 = 退化
    const degraded = kpi === 'avgLatency' ? read.innovation > 0 : read.innovation < 0;
    if (!degraded) return []; // 方向性改善不打扰（健康报告可见）
    return [
      {
        source: 'meta-cognition',
        category: 'kpi-innovation-gate',
        severity: Math.min(0.9, 0.55 + Math.min(0.35, Math.log10(Math.max(10, read.nis)) / 12)),
        message: `KPI ${kpi} 新息门控触发：观测 ${value.toFixed(3)} 偏离滤波预测 ${read.level.toFixed(3)}（NIS=${read.nis.toFixed(1)} > χ²阈值 ${read.threshold.toFixed(1)}），突变在模型方差下 99.7% 不该发生`,
        suggestion: '单点冲击先观察（可能是突发负载）；连续门控 = 状态转移模型失配，结合 17.0 形状漂移与 12.0 保证层三口径定位根因',
      },
    ];
  }

  /**
   * 12.0：保证层检验（每批快照后调用）。
   *
   * 阶段一（未确证过）：全历史 e-过程裁决——e ≥ 1/α 才确证退化
   * （高严重度，证据携带 e-值与任意时刻 p-值），否则诚实不打扰。
   * 阶段二（确证过至少一次）：情节化状态机跟踪当前状态——恢复与
   * 再劣化都要求持续越过水位线的证据（e-确证或 CS 交叉），翻转沿
   * 产出洞察。
   */
  private checkGuarantee(kpi: string, value: number): Insight[] {
    const stream = this.anytimeGuards?.get(kpi);
    if (!stream) return [];
    const view = stream.observe(value); // 全历史流持续积累（健康报告口径）
    const ref = stream.reference;
    const threshold = 1 / this.guardAlpha;
    const insights: Insight[] = [];
    const watch = this.regimeWatches?.get(kpi);

    if (!watch) {
      // 阶段一：全历史任意时刻有效确证（偷看免疫）
      if (view.verdict === 'below-reference') {
        this.regimeWatches?.set(kpi, {
          regime: 'degraded',
          recovery: this.newGuardChannel(ref, 'at-most'),
          degrade: this.newGuardChannel(ref, 'at-least'),
        });
        insights.push({
          source: 'meta-cognition',
          category: 'kpi-degradation-confirmed',
          severity: 0.9,
          message: `KPI ${kpi} 真实水平低于目标线 ${ref} 已被任意时刻有效证据确证（e=${view.eBelow.toFixed(1)}，anytime-p=${view.anytimeP.toFixed(4)}，${view.n} 样本，偷看免疫）`,
          suggestion: `退化确证非偷看假象：按 ${kpi} 的因果旋钮排序实施干预，并持续观察保证层裁决`,
        });
      }
      return insights;
    }

    // 阶段二：情节化状态机（水位线两侧的连续 run 裁决当前状态）
    if (value < ref) {
      // 线下证据：中断恢复 run（恢复证据清零），积累劣化 run
      watch.recovery = this.newGuardChannel(ref, 'at-most');
      const e = watch.degrade.e.observe(value);
      watch.degrade.cs.observe(value);
      if (watch.regime === 'recovered' && (e >= threshold || watch.degrade.cs.bounds().upper <= ref)) {
        watch.regime = 'degraded';
        insights.push({
          source: 'meta-cognition',
          category: 'kpi-degradation-confirmed',
          severity: 0.85,
          message: `KPI ${kpi} 劣化复发：水位线下连续 ${watch.degrade.e.count} 批证据（e=${e.toFixed(1)}，CS 上界 ${watch.degrade.cs.bounds().upper.toFixed(2)} ≤ 目标线 ${ref}）`,
          suggestion: '劣化复发：优先检查上一次恢复对应的干预是否被回滚',
        });
      }
    } else {
      // 线上证据：中断劣化 run（劣化证据清零），积累恢复 run
      watch.degrade = this.newGuardChannel(ref, 'at-least');
      const e = watch.recovery.e.observe(value);
      watch.recovery.cs.observe(value);
      if (watch.regime === 'degraded' && (e >= threshold || watch.recovery.cs.bounds().lower >= ref)) {
        watch.regime = 'recovered';
        insights.push({
          source: 'meta-cognition',
          category: 'kpi-recovery-confirmed',
          severity: 0.3,
          message: `KPI ${kpi} 退出确证退化态：水位线上连续 ${watch.recovery.e.count} 批证据（CS 下界 ${watch.recovery.cs.bounds().lower.toFixed(2)} ≥ 目标线 ${ref}，e=${e.toFixed(1)}）——自愈或干预见效`,
          suggestion: '保持当前参数并继续观察置信序列走势',
        });
      }
    }
    return insights;
  }

  /**
   * 5.0：因果旋钮排序 —— 哪个旋钮真正导致了目标 KPI 的改善。
   *
   * 质变点：旧版 tryTune 是「if KPI 退化 then 固定规则调某旋钮」——
   * 规则命中顺序即优先级，与旋钮真实效果无关。挂载因果内核后，
   * 旋钮推荐改按 do-干预效应下界 × 置信度排序：调过且被实验证实
   * 有效的旋钮优先，混杂严重（观测相关但实验无效）的旋钮沉底。
   *
   * @param targetKpi 退化中的 KPI（如 'successRate'）
   */
  rankTuningKnobs(targetKpi: string): CausalEffect[] {
    if (!this.causal) return [];
    return this.causal.rankCauses(`kpi:${targetKpi}`).filter((e) => e.from.startsWith('knob:'));
  }

  /**
   * 5.0：调参干预对账 —— 上次调参后 KPI 是否真的改善。
   *
   * 在 observe() 每批快照后自动调用：基线 → 干预后首个快照的比较
   * 结果作为 do-干预的 observedY 写回因果图（黄金证据闭环：
   * 调参 = 干预，下批 KPI = 实验结果，图更新 = 学习）。
   */
  private settleTuningInterventions(snapshot: KpiSnapshot): void {
    if (!this.causal || this.pendingTuningInterventions.length === 0) return;
    for (const pending of this.pendingTuningInterventions) {
      const current = (snapshot as unknown as Record<string, number>)[pending.kpi];
      if (!Number.isFinite(current)) continue;
      const improved = current >= pending.baseline;
      this.causal.intervene(
        `knob:${pending.action.parameter}`,
        `kpi:${pending.kpi}`,
        true,
        improved,
        'meta-cognition',
        `调参实验：${pending.action.parameter} ${pending.action.from} → ${pending.action.to}，观察 ${pending.kpi}`,
      );
    }
    // 每次干预只对账一次（下一批快照即实验读数）
    this.pendingTuningInterventions = [];
  }

  /** 登记待对账的调参干预（内部：动作落地后基线快照） */
  private registerTuningIntervention(action: TuningAction, kpi: string, baseline: number): void {
    this.pendingTuningInterventions.push({ action, kpi, baseline });
    if (this.pendingTuningInterventions.length > 8) this.pendingTuningInterventions.shift();
  }

  /**
   * 观察一次 KPI 快照（元认知主入口）
   * @returns 本轮产出的自愈洞察（交给目标引擎）
   */
  observe(snapshot: KpiSnapshot): Insight[] {
    this.history.push(snapshot);
    if (this.history.length > this.config.windowSize) this.history.shift();

    const insights: Insight[] = [];

    // 0. 5.0：调参干预对账（上批调参 → 本批 KPI 即实验读数）
    this.settleTuningInterventions(snapshot);

    // 0.5 12.0：KPI 保证层检验（任意时刻有效裁决的翻转沿洞察）
    if (this.anytimeGuards) {
      insights.push(...this.checkGuarantee('successRate', snapshot.successRate));
      insights.push(...this.checkGuarantee('avgQuality', snapshot.avgQuality));
    }

    // 0.6 17.0：形状感知传输漂移（W₁ 口径；均值水位检测的盲区补位）
    if (this.transportDrift) {
      for (const [kpi, monitor] of this.transportDrift) {
        const value = kpi === 'avgLatency' ? snapshot.avgLatency : kpi === 'cacheHitRate' ? snapshot.cacheHitRate : kpi === 'successRate' ? snapshot.successRate : snapshot.avgQuality;
        if (monitor === undefined || !Number.isFinite(value)) continue;
        insights.push(...this.checkTransportDrift(kpi, value));
      }
    }

    // 0.7 27.0：卡尔曼新息门控（突变判定的假设检验口径）
    if (this.kalmanFilters) {
      for (const kpi of this.kalmanFilters.keys()) {
        const value = kpi === 'avgLatency' ? snapshot.avgLatency : kpi === 'cacheHitRate' ? snapshot.cacheHitRate : kpi === 'successRate' ? snapshot.successRate : snapshot.avgQuality;
        if (!Number.isFinite(value)) continue;
        insights.push(...this.checkKalman(kpi, value));
      }
    }

    // 0.8 38.0：动力学体质分类（混沌/持续/反持续/随机——翻转沿洞察）
    if (this.chaosSeries) {
      for (const kpi of this.chaosSeries.keys()) {
        const value = kpi === 'avgLatency' ? snapshot.avgLatency : kpi === 'cacheHitRate' ? snapshot.cacheHitRate : kpi === 'successRate' ? snapshot.successRate : snapshot.avgQuality;
        insights.push(...this.checkChaos(kpi, value));
      }
    }

    // 0.9 49.0：多尺度小波视图（序列喂入；纯读数，不产洞察——零打扰）
    if (this.waveletSeries) {
      for (const kpi of this.waveletSeries.keys()) {
        this.feedWavelet(kpi, kpi === 'avgLatency' ? snapshot.avgLatency : kpi === 'cacheHitRate' ? snapshot.cacheHitRate : kpi === 'successRate' ? snapshot.successRate : snapshot.avgQuality);
      }
    }

    // 0.95 3.0：相对基线偏差带（中位数±MAD；慢漂移早于静态阈值暴露）
    if (this.relativeBandWindows) {
      for (const kpi of this.relativeBandWindows.keys()) {
        const value = kpi === 'avgLatency' ? snapshot.avgLatency : kpi === 'cacheHitRate' ? snapshot.cacheHitRate : kpi === 'successRate' ? snapshot.successRate : snapshot.avgQuality;
        insights.push(...this.checkRelativeBand(kpi, value));
      }
    }

    // 0.96 4.0：多时间尺度监控（短/中/长三窗；判级翻转沿产出尺度标签洞察）
    if (this.multiScaleStreams) {
      for (const kpi of this.multiScaleStreams.keys()) {
        const value = kpi === 'avgLatency' ? snapshot.avgLatency : kpi === 'cacheHitRate' ? snapshot.cacheHitRate : kpi === 'successRate' ? snapshot.successRate : snapshot.avgQuality;
        insights.push(...this.checkMultiScale(kpi, value));
      }
    }

    // 0.97 4.0：KPI 相关性图（序列喂入；纯读数，不产洞察——零打扰）
    if (this.kpiCorrelationWindows) {
      for (const kpi of this.kpiCorrelationWindows.keys()) {
        this.feedKpiCorrelation(kpi, kpi === 'avgLatency' ? snapshot.avgLatency : kpi === 'cacheHitRate' ? snapshot.cacheHitRate : kpi === 'successRate' ? snapshot.successRate : snapshot.avgQuality);
      }
    }

    // 1. z-score 异常检测（窗口足够时）
    if (this.history.length >= 5) {
      for (const kpi of ['successRate', 'avgQuality', 'cacheHitRate'] as const) {
        const anomaly = this.detectAnomaly(kpi, snapshot[kpi]);
        if (anomaly) this.anomalies.push(anomaly);
      }
      if (this.anomalies.length > 100) this.anomalies.splice(0, this.anomalies.length - 100);
    }

    // 2. 退化检测与参数自调优
    insights.push(...this.checkDegradation(snapshot));

    // 3. 模型健康度检查
    insights.push(...this.checkModelHealth(snapshot));

    return insights;
  }

  /** 最近一次健康报告 */
  getHealthReport(): HealthReport {
    const latest = this.history[this.history.length - 1];
    if (!latest) return { healthy: true, score: 1, message: '暂无 KPI 数据', kpis: {} };

    const successScore = Math.min(1, latest.successRate / this.config.successRateTarget);
    const qualityScore = Math.min(1, latest.avgQuality / this.config.qualityTarget);
    const cacheScore = Math.min(1, latest.cacheHitRate / 0.3); // 命中率 30% 视为满分基准
    const score = successScore * 0.5 + qualityScore * 0.35 + cacheScore * 0.15;

    return {
      healthy: score >= 0.7,
      score: Number(score.toFixed(3)),
      samples: this.history.length,
      kpis: {
        successRate: latest.successRate,
        avgQuality: latest.avgQuality,
        avgLatency: latest.avgLatency,
        cacheHitRate: latest.cacheHitRate,
      },
      degradeStreaks: Object.fromEntries(this.degradeStreaks),
      recentAnomalies: this.anomalies.slice(-5),
      recentTuning: this.tuningHistory.slice(-5),
      // 6.0：统一自由能 KPI（挂载引擎且有观测时输出）
      freeEnergy: this.freeEnergyEngine
        ? (() => {
            const s = this.freeEnergyEngine!.currentSurprisal();
            const interpretation =
              s < 0.35 ? '预测握力强：世界行为基本符合模型预期'
              : s < 0.7 ? '预测握力中等：部分结果出乎意料，模型在局部过时'
              : '预测握力弱：世界已漂移（惊讶持续偏高），建议触发世界模型重构或因果实验';
            return { surprisalEma: Number(s.toFixed(3)), samples: this.history.length, interpretation };
          })()
        : undefined,
      // 7.0：梦校准 KPI（挂载深思内核且已有对账记录时输出）
      imagination: this.deliberationEngine
        ? (() => {
            const cal = this.deliberationEngine!.currentCalibration() ?? 0;
            const settled = this.deliberationEngine!.settledCount();
            const skills = this.deliberationEngine!.allSkills().length;
            const interpretation =
              settled === 0 ? '尚未对账：想象力未经现实检验'
              : cal < 0.15 ? '梦境即现实：计划排练可信，深思搜索结论可靠'
              : cal < 0.3 ? '梦有偏差：想象部分失真，规划结论需保留怀疑'
              : '梦已失灵：想象与现实验重背离，先修转移模型再规划';
            return { calibrationEma: Number(cal.toFixed(3)), plansSettled: settled, skills, interpretation };
          })()
        : undefined,
      // 8.0：认知经济 KPI（挂载元推理内核时输出）
      cognitiveEconomy: this.metareasoner ? this.metareasoner.cognitiveEconomy() : undefined,
      // 9.0：抽象统计 KPI（挂载抽象内核时输出）
      abstraction: this.abstractionEngine ? this.abstractionEngine.stats() : undefined,
      // 10.0：知识前沿 KPI（挂载科学家内核时输出）
      knowledgeFrontier: this.scientistMind ? this.scientistMind.knowledgeFrontier() : undefined,
      // 11.0：理论前沿 KPI（挂载理论内核时输出）
      theoryFrontier: this.theoristEngine ? this.theoristEngine.frontier() : undefined,
      // 27.0：卡尔曼滤波层（挂载后输出；level 去噪 / slope 漂移 / NIS 门控）
      kalman: this.kalmanFilters
        ? (() => {
            const streams = [...this.kalmanFilters!.entries()].map(([kpi, filter]) => {
              const r = filter.lastRead;
              return r
                ? { kpi, level: Number(r.level.toFixed(4)), slope: Number(r.slope.toFixed(5)), nis: Number(r.nis.toFixed(2)), threshold: Number(r.threshold.toFixed(2)), gated: r.gated }
                : { kpi, level: 0, slope: 0, nis: 0, threshold: 0, gated: false };
            });
            const gatedCount = streams.filter((s) => s.gated).length;
            return {
              streams,
              interpretation:
                gatedCount > 0
                  ? '存在新息门控触发中的 KPI：观测偏离滤波预测超出 χ² 99.7% 分位——突变正在发生'
                  : '全部 KPI 新息在模型方差内：状态转移模型仍解释世界',
            };
          })()
        : undefined,
      // 12.0：KPI 保证层（挂载 anytime 守卫后输出）
      guarantees: this.anytimeGuards
        ? (() => {
            const streams = [...this.anytimeGuards!.entries()].map(([kpi, stream]) => {
              const v = stream.view();
              return {
                kpi,
                reference: stream.reference,
                verdict: v.verdict,
                /** 12.0：情节化当前状态（undefined = 尚未确证过退化） */
                regime: this.regimeWatches?.get(kpi)?.regime,
                eBelow: v.eBelow,
                anytimeP: v.anytimeP,
                n: v.n,
                cs: { lower: v.cs.lower, upper: v.cs.upper },
              };
            });
            const degraded = streams.filter(
              (s) => s.regime === 'degraded' || (s.regime === undefined && s.verdict === 'below-reference'),
            );
            const interpretation =
              streams.every((s) => s.n === 0)
                ? '保证层已挂载，等待首批 KPI 快照'
                : degraded.length === 0
                  ? '全部受保护 KPI 未确证退化（任意时刻有效，偷看免疫）'
                  : `${degraded.map((s) => s.kpi).join('、')} 处于确证退化态（全历史 e-过程背书；情节化通道跟踪恢复/复发）`;
            return { streams, interpretation };
          })()
        : undefined,
      // 3.0：相对基线偏差带（挂载后输出；中位数±MAD 相对口径）
      relativeBands: this.relativeBandWindows
        ? (() => {
            const streams = [...this.relativeBandWindows!.keys()]
              .map((kpi) => this.relativeKpiBandView(kpi))
              .filter((r): r is RelativeKpiBandRead => r !== undefined)
              .map((r) => ({
                kpi: r.kpi,
                samples: r.samples,
                baselineMedian: Number(r.baselineMedian.toFixed(4)),
                madSigma: Number(r.madSigma.toFixed(6)),
                value: Number(r.value.toFixed(4)),
                robustZ: Number(r.robustZ.toFixed(2)),
                bandWidthMad: r.bandWidthMad,
                outOfBand: r.outOfBand,
                degraded: r.degraded,
              }));
            const degraded = streams.filter((s) => s.degraded);
            const interpretation =
              streams.length === 0
                ? '相对基线带已挂载，等待基线窗积累'
                : degraded.length === 0
                  ? '全部 KPI 处于自身滚动基线带内（中位数±MAD 相对口径，慢漂移可见）'
                  : `${degraded.map((s) => s.kpi).join('、')} 偏离自身基线（稳健 z=${degraded.map((s) => s.robustZ).join('/')}，静态阈值可能尚未可见）`;
            return { streams, interpretation };
          })()
        : undefined,
      // 4.0：多时间尺度监控（挂载后输出；短/中/长三窗 + 尺度合成判级）
      multiScale: this.multiScaleStreams
        ? (() => {
            const streams = [...this.multiScaleStreams!.keys()]
              .map((kpi) => this.multiScaleView(kpi))
              .filter((r): r is MultiScaleRead => r !== undefined);
            const alarming = streams.filter((s) => s.kind !== 'healthy');
            const interpretation =
              streams.length === 0
                ? '多时间尺度监控已挂载，等待长窗积累'
                : alarming.length === 0
                  ? '全部 KPI 三尺度健康（短窗灵敏、长窗稳态锚点均未破）'
                  : alarming
                      .map((s) => `${s.kpi}=${s.kind}（${s.scales.join('+')} 越限）`)
                      .join('、') + (alarming.some((s) => s.kind === 'degradation') ? '——长窗稳态已破，真退化' : '——长窗稳态未破，按波动/漂移口径处理');
            return { streams, interpretation };
          })()
        : undefined,
      // 4.0：KPI 相关性图（挂载后输出；滚动 Pearson 矩阵 + 联动对）
      kpiCorrelations: this.kpiCorrelationWindows
        ? (() => {
            const view = this.kpiCorrelationView()!;
            const linked = view.pairs.filter((p) => p.linked);
            const interpretation =
              view.pairs.length === 0
                ? 'KPI 相关性图已挂载，样本积累中'
                : linked.length === 0
                  ? '无联动 KPI 对（各 KPI 独立运动，调整影响面干净）'
                  : `联动对：${linked.map((p) => `${p.a}↔${p.b}（r=${p.r}）`).join('、')}——调整任一侧的影响面自动扩至对侧（归因防混淆）`;
            return { ...view, interpretation };
          })()
        : undefined,
    };
  }

  /** 调优历史 */
  getTuningHistory(): TuningAction[] {
    return [...this.tuningHistory];
  }

  /** 异常历史 */
  getAnomalies(): KpiAnomaly[] {
    return [...this.anomalies];
  }

  /** KPI 历史（只读快照） */
  getHistory(): KpiSnapshot[] {
    return [...this.history];
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** z-score 异常检测 */
  private detectAnomaly(kpi: keyof Pick<KpiSnapshot, 'successRate' | 'avgQuality' | 'avgLatency' | 'cacheHitRate'>, value: number): KpiAnomaly | null {
    const series = this.history.slice(0, -1).map((s) => s[kpi]);
    if (series.length < 4) return null;
    const mean = series.reduce((a, b) => a + b, 0) / series.length;
    const variance = series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length;
    const std = Math.sqrt(variance);
    if (std < 1e-6) return null;
    const z = (value - mean) / std;
    if (Math.abs(z) < this.config.zScoreThreshold) return null;
    return {
      kpi,
      value,
      baseline: mean,
      zScore: Number(z.toFixed(2)),
      direction: z < 0 ? 'degraded' : 'improved',
      timestamp: this.now(),
    };
  }

  /** 退化检测：连续低于目标线 → 参数自调优 + 自愈洞察 */
  private checkDegradation(snapshot: KpiSnapshot): Insight[] {
    const insights: Insight[] = [];
    const checks: Array<{ kpi: string; value: number; target: number }> = [
      { kpi: 'successRate', value: snapshot.successRate, target: this.config.successRateTarget },
      { kpi: 'avgQuality', value: snapshot.avgQuality, target: this.config.qualityTarget },
    ];

    for (const check of checks) {
      const streak = check.value < check.target ? (this.degradeStreaks.get(check.kpi) ?? 0) + 1 : 0;
      this.degradeStreaks.set(check.kpi, streak);
      if (streak < this.config.degradeStreakThreshold) continue;

      // 触发参数自调优（冷却期内不重复调整）
      const tuned = this.tryTune(check.kpi, check.value, check.target);
      if (tuned) {
        this.tuningHistory.push(tuned);
        this.config.applier?.(tuned);
        // 调优后重置连续计数，给新参数生效的机会
        this.degradeStreaks.set(check.kpi, 0);
      } else {
        // 冷却期内或无可调参数 → 产出自愈洞察交给目标引擎
        insights.push({
          source: 'meta-cognition',
          category: 'kpi-degradation',
          severity: Math.min(1, 0.5 + streak * 0.1),
          message: `KPI ${check.kpi} 连续 ${streak} 次低于目标线（当前 ${check.value.toFixed(2)}，目标 ${check.target}）`,
          suggestion: check.kpi === 'successRate'
            ? '排查高频失败任务类型并优化其执行策略'
            : '复盘低质量任务的计划生成与模型分配',
        });
      }
    }
    return insights;
  }

  /**
   * 参数自调优策略
   *
   * 5.0 质变：挂载因果内核后，旋钮选择按因果证据而非规则命中顺序——
   * 1. rankTuningKnobs(kpi) 查询已确立的正因果旋钮（实验证实调它有效），
   *    有效应下界最高者优先，动作携带 causalBasis；
   * 2. 无因果证据时回退既有规则（零行为漂移）；
   * 3. 每次落地动作登记为待对账干预：下批 KPI 快照 = 实验读数，
   *    成败自动写回因果图（元认知从「调参」升级为「做实验」）。
   */
  private tryTune(kpi: string, value: number, target: number): TuningAction | null {
    if (this.now() - this.lastTuningAt < this.config.tuningCooldownMs) return null;

    let action: TuningAction | null = null;

    // 5.0：因果旋钮优先（有实验证据的调参方向）
    if (this.causal) {
      const ranked = this.rankTuningKnobs(kpi);
      const bestKnob = ranked.find((e) => e.established && e.direction === 'positive' && e.interventionalSamples >= 3);
      if (bestKnob) {
        const parameter = bestKnob.from.replace('knob:', '') as TuningAction['parameter'];
        const step = parameter === 'maxRetries' ? 1 : 0.05;
        action = {
          parameter,
          from: target,
          to: Number((target + step).toFixed(2)),
          reason: `因果证据优先：${parameter} 对 ${kpi} 的干预效应 ${bestKnob.ate.toFixed(2)} [${bestKnob.lower.toFixed(2)}, ${bestKnob.upper.toFixed(2)}]（${bestKnob.interventionalSamples} 次实验）`,
          timestamp: this.now(),
          causalBasis: {
            ate: bestKnob.ate,
            lower: bestKnob.lower,
            confidence: bestKnob.confidence,
            interventionalSamples: bestKnob.interventionalSamples,
          },
        };
      }
    }

    // 规则回退（无因果证据时保持既有行为）
    if (!action) {
      if (kpi === 'successRate') {
        // 成功率退化：降低质量阈值减少无效重试风暴，提升通过率。
        // 注意 from/to 基线必须是「当前实际质量阈值」——若以成功率目标
        // （默认 0.8）为基线，max(0.5, 0.8−0.05)=0.75 反而高于默认质量
        // 阈值 0.7，名为放宽实则收紧
        if (this.config.getQualityThreshold) {
          const from = Math.min(0.95, Math.max(0.5, this.config.getQualityThreshold()));
          const to = Math.max(0.5, Number((from - 0.05).toFixed(2)));
          if (to < from) {
            action = {
              parameter: 'qualityThreshold',
              from,
              to,
              reason: `成功率 ${value.toFixed(2)} 低于目标 ${target}，放宽质量阈值：当前 ${from.toFixed(2)} → ${to.toFixed(2)}，减少重试风暴`,
              timestamp: this.now(),
            };
          }
        } else {
          // 未注入当前阈值读取回调：保持旧行为（零漂移，既有验证口径不变）
          const relaxed = Math.max(0.5, target - 0.05);
          if (relaxed < target) {
            action = {
              parameter: 'qualityThreshold',
              from: target,
              to: relaxed,
              reason: `成功率 ${value.toFixed(2)} 低于目标 ${target}，放宽质量阈值减少重试风暴`,
              timestamp: this.now(),
            };
          }
        }
      } else if (kpi === 'avgQuality') {
        // 质量退化：增加重试次数争取更高质量
        action = {
          parameter: 'maxRetries',
          from: 2,
          to: 3,
          reason: `平均质量 ${value.toFixed(2)} 低于目标 ${target}，增加重试次数`,
          timestamp: this.now(),
        };
      }
    }

    if (action) {
      this.lastTuningAt = this.now();
      // 4.0：相关图附注影响面（与目标 KPI 联动的 KPI 一并列入——归因防混淆）
      if (this.kpiCorrelationWindows) {
        const linked = this.linkedKpis(kpi);
        if (linked.length > 0) action.affectedKpis = linked.map((l) => l.kpi);
      }
      // 5.0：登记待对账干预（下批快照结算成败 → 写回因果图）
      this.registerTuningIntervention(action, kpi, value);
    }
    return action;
  }

  /** 模型健康度检查：单模型成功率过低 → 自愈洞察 */
  private checkModelHealth(snapshot: KpiSnapshot): Insight[] {
    const insights: Insight[] = [];
    for (const [modelId, rate] of Object.entries(snapshot.modelSuccessRates)) {
      if (rate >= this.config.modelHealthThreshold) continue;
      insights.push({
        source: 'meta-cognition',
        category: 'model-unhealthy',
        severity: 0.8,
        message: `模型 ${modelId} 成功率仅 ${(rate * 100).toFixed(0)}%，低于健康线 ${(this.config.modelHealthThreshold * 100).toFixed(0)}%`,
        suggestion: `降低模型 ${modelId} 的任务分配权重，将其任务迁移至更健康的模型`,
      });
    }
    return insights;
  }
}
