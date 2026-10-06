/**
 * world-model.ts — 世界模型（自主智能"预见"支柱）
 *
 * 职责：让系统对"外部世界如何运转"建立内部模型，从而具备预见能力——
 * 不是被动等待信号到来，而是提前预判信号到达、负载趋势与类型关联，
 * 为决策引擎、心跳循环与元认知提供前瞻性依据。
 *
 * 能力矩阵：
 * 1. 信号到达规律学习：按类型维护到达时间序列（滑动窗口），
 *    计算到达率、到达间隔分布、时段热度（小时直方图）
 * 2. 到达预测：基于历史到达率 + 时段热度 + 突发趋势，
 *    预测未来窗口内各类型信号的期望到达数（含置信区间）
 * 3. 类型关联矩阵：统计类型对的共现频率（时间邻近窗口内），
 *    识别"A 类型信号常伴随 B 类型信号"的规律，供级联与预取决策
 * 4. 预测校准：记录每次预测与实际到达的偏差，
 *    计算校准误差（MAE），误差过大时降低预测置信度并提示重学
 * 5. 趋势检测：对到达率做线性回归，识别上升/下降/平稳趋势，
 *    上升趋势触发负载预警洞察（交给元认知/目标引擎）
 *
 * 设计要点：
 * - 全部为纯统计学习，无需 LLM，开销极低，可在每次信号到达时增量更新
 * - 时间序列窗口有界（每类型最多保留 N 个到达时间戳），内存可控
 */
import { GpSeriesCalibrator, type ConstructorOptionsGpSeries } from './core/gaussian-process.js';
import { seasonalFactor } from './core/spectral-periodicity.js';
// 创世纪 56.0/69.0：置信传播多源证据融合 / Mapper 经验地形图
import { FactorGraph, type BPReport } from './core/belief-propagation.js';
import { buildMapper, mapperInsight, type MapperGraph } from './core/mapper-graph.js';

// 第二轮创世纪 77.0/78.0/79.0/83.0：因果发现（观测学图）/ 典型相关（多源
// 对齐）/ 扩散映射（经验流形）/ 世界模型学习（转移动态自学）
import {
  causalStructureView,
  sourceAlignmentView,
  manifoldEmbeddingView,
  modelLearningView,
  type CausalObservationInput,
  type CausalStructureView,
  type ManifoldEmbeddingView,
  type MdlEpisode,
  type ModelLearningView,
  type SourceAlignmentView,
  type TabularMDP,
} from './engines-frontier/autonomy25.js';

/** 单类型信号的到达统计 */
export interface ArrivalStats {
  type: string;
  /** 到达时间戳（滑动窗口，最新在尾部） */
  timestamps: number[];
  /** 小时直方图（0~23 时段的到达计数） */
  hourHistogram: number[];
  /** 总到达数 */
  totalCount: number;
  /** 首次观测时间 */
  firstSeenAt: number;
  /** 最近观测时间 */
  lastSeenAt: number;
}

/** 到达预测结果 */
export interface ArrivalPrediction {
  type: string;
  /** 预测窗口内期望到达数 */
  expectedCount: number;
  /** 置信区间下界 */
  lowerBound: number;
  /** 置信区间上界 */
  upperBound: number;
  /** 预测置信度 0~1（由校准误差驱动） */
  confidence: number;
  /** 趋势方向 */
  trend: 'rising' | 'falling' | 'stable';
  /**
   * 13.0：保形区间（分布无关精确覆盖保证，attachConformalCalibrator 后输出）。
   * 挂载后 lowerBound/upperBound 即保形口径（P(实际 ∈ [lower, upper]) ≥ 1−α，
   * 精确有限样本保证，零分布假设）；finite=false 表示校准不足——
   * 区间诚实发散（+∞），而非伪装确定。
   */
  conformal?: { lower: number; upper: number; finite: boolean; qhat: number; calibrationN: number; alpha: number };
  /**
   * 26.0：GP 校准修正（attachGpCalibrator 后输出）。factor 为乘性修正
   * （从校准史的 actual/predicted 比值序列 GP 回归而来，含不确定度）；
   * expectedCount 已乘 factor，lowerBound/upperBound 已按 std 拓宽。
   */
  gp?: { factor: number; std: number; points: number };
}

/** 预测校准记录 */
export interface CalibrationRecord {
  type: string;
  predicted: number;
  actual: number;
  error: number;
  timestamp: number;
}

/** 类型关联（共现） */
export interface TypeCorrelation {
  typeA: string;
  typeB: string;
  /** 共现次数 */
  coOccurrences: number;
  /** 关联强度 0~1（共现数 / min(各自总数)） */
  strength: number;
}

// ─────────────────── 第三轮：观测信念融合 / 时间旅行 / 健康度 类型 ───────────────────

/** 键的当前观测信念（多源冲突消解后的裁决结果） */
export interface ObservationBelief {
  key: string;
  /** 当前生效的观测值（原样保存，不做类型归一） */
  value: unknown;
  /** 当前值的来源 */
  source: string;
  /** 信念强度 = 写入源可靠性 × 写入自信度（印证按 noisy-OR 合并） */
  strength: number;
  /** 该键最近一次裁决所在的全局版本号 */
  version: number;
  updatedAt: number;
  /** 真冲突待裁决标记（写入方应查看 observationConflicts() 并裁决） */
  conflicted: boolean;
}

/** 真冲突记录（同键异值且双源都自信——记账而非静默覆盖） */
export interface ObservationConflict {
  key: string;
  incumbent: { value: unknown; source: string; strength: number };
  challenger: { value: unknown; source: string; strength: number };
  /** 冲突触发时的全局版本号 */
  version: number;
  timestamp: number;
  /** 已裁决（resolveObservationConflict 或同值印证消解） */
  resolved?: boolean;
  resolvedTo?: unknown;
  adjudicatedBy?: string;
}

/** 源可靠性画像（Beta 后验均值口径，随写入结果在线校准） */
export interface SourceReliability {
  source: string;
  /** 后验可靠性 0~1（先验 + 印证/矛盾计数平滑） */
  reliability: number;
  corroborations: number;
  contradictions: number;
  /** 真冲突参战次数（不惩罚——矛盾双方可能都对，等裁决） */
  conflicts: number;
  writes: number;
  lastSeenAt: number;
}

/** 时间旅行快照（某版本的观测信念全量帧） */
export interface TimeTravelSnapshot {
  version: number;
  timestamp: number;
  beliefs: ObservationBelief[];
}

/** 两版本间的键级 diff（增/删/改） */
export interface ObservationDiff {
  fromVersion: number;
  toVersion: number;
  added: Array<{ key: string; value: unknown }>;
  removed: Array<{ key: string; value: unknown }>;
  changed: Array<{ key: string; from: unknown; to: unknown }>;
}

/** 观测值相等判定：Object.is 快路径 → JSON 形态兜底（结构相等） */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false; // 循环引用等不可序列化形态：不武断判等
  }
}

/** 在场感知的相等判定（一方存在一方不存在 = 变化；双方皆缺 = 相等） */
function sameKeyState(hasA: boolean, a: unknown, hasB: boolean, b: unknown): boolean {
  if (hasA !== hasB) return false;
  if (!hasA) return true;
  return valuesEqual(a, b);
}

/** 假设备注的安全序列化（循环引用等不可序列化值不抛错） */
function supposeNote(key: string, value: unknown, absent = false): string {
  if (absent) return `suppose ${key} absent`;
  try {
    return `suppose ${key} = ${JSON.stringify(value)}`;
  } catch {
    return `suppose ${key} = <unserializable>`;
  }
}

/** 反事实分支运行时态（engine.branches 的值类型） */
interface CounterfactualBranchState {
  label: string;
  createdAt: number;
  forkedAtVersion: number;
  /** fork 基线（fork 时刻主线信念的深拷贝） */
  base: Map<string, { value: unknown; source: string; strength: number }>;
  /** 假设覆盖表：键 → 假设值 | null（null = 假设该键不存在，墓碑） */
  overrides: Map<string, { value: unknown; note: string } | null>;
  notes: string[];
}

/** 世界模型健康度报告（近期预测 vs 实际的滚动口径） */
export interface WorldHealthReport {
  /** 参与评定的滚动窗口容量 */
  window: number;
  /** 实际参与评定的样本数（≤ window） */
  samples: number;
  /** 命中率：|预测−实际| ≤ hitTolerance 的记录占比 */
  hitRate: number;
  /** 平均绝对误差（窗口内） */
  meanError: number;
  /** 最大绝对误差（窗口内） */
  maxError: number;
  /** 综合置信度 0~1（样本充足 × 命中率驱动；样本不足 → 低置信） */
  confidence: number;
  /** 近期崩坏信号：样本 ≥ minSamples 且命中率 < relearnHitRate → true */
  needsRelearning: boolean;
  /** 按类型分解（窗口内，按命中率升序——最差的排前面） */
  perType: Array<{ type: string; samples: number; hitRate: number; meanError: number }>;
  generatedAt: number;
}

/** 健康度评定选项 */
export interface WorldHealthOptions {
  /** 滚动窗口容量（最近 N 条校准记录，缺省 50） */
  window: number;
  /** 单条命中容差（|error| ≤ 容差记命中，缺省 1） */
  hitTolerance: number;
  /** 触发重学习提示的最少样本数（缺省 8） */
  minSamples: number;
  /** 重学习提示的命中率下限（缺省 0.5——低于即提示） */
  relearnHitRate: number;
}

/**
 * 世界模型健康度（纯函数口径，供 worldHealthReport 与外部复用）：
 * 全史 MAE（旧世界唯一口径）会被「早期好 + 近期崩」的平均掩盖——
 * 滚动窗口命中率把近期崩坏单独曝光，低命中 → needsRelearning
 * （77.0 因果图 / 83.0 T̂ r̂ 应重估的运维信号）。
 */
export function computeWorldHealth(records: ReadonlyArray<CalibrationRecord>, options: WorldHealthOptions): WorldHealthReport {
  const recent = records.slice(-options.window);
  const samples = recent.length;
  if (samples === 0) {
    return { window: options.window, samples: 0, hitRate: 0, meanError: 0, maxError: 0, confidence: 0, needsRelearning: false, perType: [], generatedAt: Date.now() };
  }
  const hits = recent.filter((r) => Math.abs(r.error) <= options.hitTolerance).length;
  const meanError = recent.reduce((sum, r) => sum + r.error, 0) / samples;
  const maxError = recent.reduce((mx, r) => Math.max(mx, r.error), 0);
  const hitRate = hits / samples;
  const byType = new Map<string, { samples: number; hits: number; errorSum: number }>();
  for (const r of recent) {
    const entry = byType.get(r.type) ?? { samples: 0, hits: 0, errorSum: 0 };
    entry.samples += 1;
    if (Math.abs(r.error) <= options.hitTolerance) entry.hits += 1;
    entry.errorSum += r.error;
    byType.set(r.type, entry);
  }
  const perType = [...byType.entries()]
    .map(([type, e]) => ({ type, samples: e.samples, hitRate: Number((e.hits / e.samples).toFixed(4)), meanError: Number((e.errorSum / e.samples).toFixed(4)) }))
    .sort((a, b) => a.hitRate - b.hitRate);
  return {
    window: options.window,
    samples,
    hitRate: Number(hitRate.toFixed(4)),
    meanError: Number(meanError.toFixed(4)),
    maxError: Number(maxError.toFixed(4)),
    confidence: Number(Math.min(1, (samples / options.minSamples) * hitRate).toFixed(4)),
    needsRelearning: samples >= options.minSamples && hitRate < options.relearnHitRate,
    perType,
    generatedAt: Date.now(),
  };
}

// ─────────────────── 第四轮：反事实世界 / 不确定性地图 / 多假说并存 / 事件因果链 类型 ───────────────────

/** 反事实分支（影子世界）信息卡 */
export interface CounterfactualBranchInfo {
  id: string;
  label: string;
  /** fork 自的主线版本号（fork 后主线继续推进不影响影子） */
  forkedAtVersion: number;
  createdAt: number;
  /** 已施加的假设变更数（suppose / supposeAbsent 计数） */
  hypotheses: number;
  /** 假设备注清单（与施加序一致） */
  notes: string[];
}

/** 影子世界的键态（有效态 = fork 基线 ∪ 假设覆盖；假设移除的键不出现） */
export interface ShadowBelief {
  key: string;
  value: unknown;
  /** 该键当前取值的来源假设（'inherited' = 继承自 fork 基线） */
  hypothesis: string;
}

/** 三方 diff 的变化归因：仅假设造成 / 仅主线漂移 / 双方都动（真分叉） */
export type CounterfactualCause = 'hypothesis' | 'mainline' | 'diverged';

/** 反事实 diff 条目（fork 基线 × 主线现状 × 影子现状） */
export interface CounterfactualChange {
  key: string;
  cause: CounterfactualCause;
  /** fork 基线值（undefined = 基线无此键） */
  base: unknown;
  /** 主线现状（undefined = 主线已无此键 / 从未有） */
  mainline: { value: unknown; source: string; strength: number } | undefined;
  /** 影子现状（undefined = 影子假设该键不存在） */
  shadow: { value: unknown; hypothesis: string } | undefined;
}

/** 反事实 diff 结果（影子 vs 主线，含 fork 基线三方归因；即时快照口径） */
export interface CounterfactualDiff {
  branchId: string;
  label: string;
  forkedAtVersion: number;
  /** 对照时的主线版本号（主线随时可继续推进） */
  mainlineVersion: number;
  changes: CounterfactualChange[];
}

/** 键空间证据分区：充分 / 薄弱 / 争议 / 未知 */
export type UncertaintyZone = 'sufficient' | 'thin' | 'contested' | 'unknown';

/** 薄弱区条目（有证据但不充分——最该补观测的地方） */
export interface ThinRegion {
  key: string;
  /** 被采纳的写入次数 */
  writes: number;
  /** 采纳写入的独立源数 */
  sources: number;
  /** 同值印证次数 */
  agreements: number;
  /** 被拒写入次数（噪声尝试——不构成证据，也不构成矛盾） */
  rejections: number;
  /** 当前信念强度（无当前信念时 undefined） */
  beliefStrength: number | undefined;
}

/** 不确定性地图报告（键空间四分区 + 未知率 + 薄弱区清单） */
export interface UncertaintyMapReport {
  /** 键空间大小（登记键 ∪ 观测过的键） */
  keySpace: number;
  zones: Record<UncertaintyZone, string[]>;
  /** 未知率 = unknown / keySpace */
  unknownRate: number;
  /** 薄弱区清单（按 writes 升序——证据最少的排前面） */
  thinRegions: ThinRegion[];
  /** 争议键数（有未决真冲突） */
  contested: number;
  /** 充分键数 */
  sufficient: number;
  generatedAt: number;
}

/** 竞争假说的当前支持度 */
export interface HypothesisStanding {
  candidateId: string;
  label: string;
  /** 归一化支持度 0~1（全体候选之和 = 1） */
  support: number;
}

/** 一次证据称量记录（历史保留——支持度怎么走到今天的可回放） */
export interface EvidenceWeighing {
  index: number;
  timestamp: number;
  note: string;
  /** 本次证据在各候选下的相对似然（未提及的候选 = 1：证据对其沉默） */
  likelihoods: Record<string, number>;
  /** 称量后即刻的支持度快照（候选插入序） */
  standingAfter: Array<{ candidateId: string; support: number }>;
}

/** 假说问题信息卡 */
export interface HypothesisQuestionInfo {
  id: string;
  topic: string;
  openedAt: number;
  weighings: number;
  retired: boolean;
  verdict?: string;
}

/** 世界事件种类（观测信念层状态变化因果链的闭环谓词） */
export type WorldJournalKind = 'write' | 'reject' | 'conflict' | 'resolve' | 'forget';

/** 世界状态变化事件（谁在何时改了什么键、来源、当时的全局版本） */
export interface WorldJournalEvent {
  seq: number;
  timestamp: number;
  kind: WorldJournalKind;
  key: string;
  source: string;
  /** 事件发生时的全局版本号（被拒不推进版本——如实携带旧版本） */
  version: number;
  detail: { from?: unknown; to?: unknown; reason?: string; challenger?: { value: unknown; source: string } };
}

/** 事件回放过滤器（全部条件 AND；时间闭区间） */
export interface JournalFilter {
  keys?: string[];
  from?: number;
  to?: number;
  kinds?: WorldJournalKind[];
}

/** 世界模型配置 */
export interface WorldModelConfig {
  /** 每类型保留的到达时间戳上限 */
  maxTimestampsPerType: number;
  /** 关联共现判定窗口（毫秒） */
  coOccurrenceWindowMs: number;
  /** 趋势检测最少样本数 */
  minSamplesForTrend: number;
  /** 上升趋势判定斜率阈值（每分钟到达数增量） */
  risingSlopeThreshold: number;
  /** 校准误差超过该值视为预测失准 */
  calibrationErrorThreshold: number;
}

/** 默认配置 */
export const DEFAULT_WORLD_MODEL_CONFIG: WorldModelConfig = {
  maxTimestampsPerType: 500,
  coOccurrenceWindowMs: 60_000,
  minSamplesForTrend: 6,
  risingSlopeThreshold: 0.05,
  calibrationErrorThreshold: 2,
};

/** 世界模型摘要（运维可观测） */
export interface WorldModelSummary {
  trackedTypes: number;
  totalArrivals: number;
  types: Array<{ type: string; totalCount: number; lastSeenAt: number; recentRatePerMin: number }>;
  correlations: TypeCorrelation[];
  trends: Array<{ type: string; trend: 'rising' | 'falling' | 'stable'; slopePerMin: number }>;
  calibrationError: number;
  /** 5.0：混杂指纹（观测共现 ≠ 因果的证伪现场） */
  confoundedPairs?: Array<{ typeA: string; typeB: string; observationalStrength: number; causalEffect: number; divergence: number }>;
  /** 13.0：保形校准状态（attachConformalCalibrator 后输出） */
  conformal?: import('./core/conformal.js').ConformalStatus;
}

/**
 * 世界模型
 *
 * 被 index.ts 持有：哨兵每次 ingest 后调用 observeArrival() 增量学习；
 * 心跳循环定期调用 predictArrivals() 获取前瞻预测，detectTrends() 产出负载预警。
 *
 * 5.0 质变（因果升级）：挂载 CausalKernel 后，本模型从「相关性预测器」
 * 升级为「因果预见器」——predictInterventionEffect(action, kpi) 直接回答
 * 「若我对系统实施 do(action)，目标 KPI 期望变化几何（含不确定性区间）」。
 * 相关矩阵负责「看见规律」，因果图负责「预见干预后果」——
 * 二者的显著背离（混杂指纹）在 getSummary() 中显式曝光。
 */
export class WorldModel {
  private config: WorldModelConfig;
  private stats = new Map<string, ArrivalStats>();
  private calibrations: CalibrationRecord[] = [];
  /** 待校准的预测（type → 预测值，窗口结束后对账） */
  private pendingPredictions = new Map<
    string,
    {
      predicted: number;
      windowEnd: number;
      /** 13.0：发出预测时的保形区间（对账覆盖监测用） */
      conformalInterval?: { lower: number; upper: number; finite: boolean };
    }
  >();
  /** 5.0：因果内核（可选挂载） */
  private causal?: import('./core/causal-kernel.js').CausalKernel;
  /** 13.0：保形校准引擎（可选挂载） */
  private conformalEngine?: import('./core/conformal.js').ConformalIntervalEngine;
  /** 26.0：每类型 GP 校准器（可选挂载；attachGpCalibrator 后惰性创建） */
  private gpCalibrators?: Map<string, import('./core/gaussian-process.js').GpSeriesCalibrator>;

  constructor(config?: Partial<WorldModelConfig>) {
    this.config = { ...DEFAULT_WORLD_MODEL_CONFIG, ...config };
  }

  /**
   * 26.0：挂载 GP 序列校准器开关（幂等）。
   *
   * 挂载后每次 settleCalibrations 把 actual/predicted 比值喂入该类型的
   * GP 时间序列；predictArrivals 的期望乘以 GP 后验均值因子、区间按
   * 后验标准差拓宽——趋势修正的 1.25/0.75 魔数由「从对账结果学出来的
   * 修正」接管（校准史充分前 factor 恒 1，早期零漂移）。
   */
  attachGpCalibrator(options?: ConstructorOptionsGpSeries): void {
    this.gpOptions = options;
    this.gpCalibrators = this.gpCalibrators ?? new Map();
  }

  private gpOptions?: ConstructorOptionsGpSeries;

  private gpFor(type: string): GpSeriesCalibrator | undefined {
    if (!this.gpCalibrators) return undefined;
    let cal = this.gpCalibrators.get(type);
    if (!cal) {
      cal = new GpSeriesCalibrator(this.gpOptions);
      this.gpCalibrators.set(type, cal);
    }
    return cal;
  }

  /** 26.0：GP 校准状态（未挂载返回 undefined） */
  getGpCalibrationStatus(): Array<{ type: string; points: number }> | undefined {
    if (!this.gpCalibrators) return undefined;
    return [...this.gpCalibrators.entries()].map(([type, cal]) => ({ type, points: cal.size }));
  }

  /**
   * 5.0：挂载因果内核（幂等）。
   *
   * 挂载后：
   * - 类型共现自动作为观测证据写入因果图（银级证据）；
   * - predictInterventionEffect 提供因果预见（黄金口径）。
   */
  attachCausalKernel(kernel: import('./core/causal-kernel.js').CausalKernel): void {
    this.causal = kernel;
    // 把既有共现规律回灌为观测证据（一次性迁移，非逐拍重复）
    for (const corr of this.getCorrelations(0.05)) {
      for (let k = 0; k < Math.min(corr.coOccurrences, 20); k += 1) {
        kernel.observe(`signal:${corr.typeA}`, `signal:${corr.typeB}`, true, true);
      }
    }
  }

  /**
   * 13.0：挂载保形校准引擎（幂等）。
   *
   * 挂载后 predictArrivals 的区间从 sqrt(λ) 泊松近似升级为保形区间：
   * 精确有限样本覆盖 ≥ 1−α，零分布假设（可交换性即可）；每次
   * settleCalibrations 的残差自动入校准集，覆盖漂移由 e-过程监测
   * （失准确证 → status().drift.drifting，应重校准）。
   */
  attachConformalCalibrator(engine: import('./core/conformal.js').ConformalIntervalEngine): void {
    this.conformalEngine = engine;
  }

  /** 13.0：保形校准状态（未挂载返回 undefined） */
  getConformalStatus(): import('./core/conformal.js').ConformalStatus | undefined {
    return this.conformalEngine?.status();
  }

  /**
   * 5.0：因果预见 ——「若实施 do(action)，目标指标期望如何变化」。
   *
   * 与 predictArrivals 的本质区别：那是「世界自己会怎样」（外推），
   * 这是「我们主动干预后世界会怎样」（因果阶梯第二层）。
   * 无因果证据时诚实返回 null，而非伪装成知道。
   */
  predictInterventionEffect(
    action: string,
    targetKpi: string,
  ): import('./core/causal-kernel.js').CausalEffect | null {
    if (!this.causal) return null;
    const eff = this.causal.effect(action, targetKpi);
    if (eff.interventionalSamples + eff.observationalSamples === 0) return null;
    return eff;
  }

  /** 5.0：登记一次真实干预（A/B 切换 / 参数实验的黄金证据） */
  recordIntervention(
    action: string,
    targetKpi: string,
    setTo: boolean,
    observedY: boolean,
    actor: string,
    hypothesis?: string,
  ): void {
    this.causal?.intervene(action, targetKpi, setTo, observedY, actor, hypothesis);
  }

  /**
   * 观察一次信号到达（增量学习入口）
   * @param type 信号类型
   * @param timestamp 到达时间戳（缺省当前时间）
   */
  observeArrival(type: string, timestamp = Date.now()): void {
    let entry = this.stats.get(type);
    if (!entry) {
      entry = {
        type,
        timestamps: [],
        hourHistogram: new Array(24).fill(0),
        totalCount: 0,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
      };
      this.stats.set(type, entry);
    }
    entry.timestamps.push(timestamp);
    if (entry.timestamps.length > this.config.maxTimestampsPerType) {
      entry.timestamps.splice(0, entry.timestamps.length - this.config.maxTimestampsPerType);
    }
    entry.hourHistogram[new Date(timestamp).getHours()] += 1;
    entry.totalCount += 1;
    entry.lastSeenAt = timestamp;
  }

  /**
   * 预测未来窗口内各类型信号的到达数
   * @param horizonMs 预测窗口（毫秒，缺省 5 分钟）
   * @returns 各类型的到达预测（按期望到达数降序）
   */
  predictArrivals(horizonMs = 5 * 60_000): ArrivalPrediction[] {
    const now = Date.now();
    const predictions: ArrivalPrediction[] = [];

    for (const [type, entry] of this.stats) {
      const ratePerMs = this.recentRate(entry, now);
      const trend = this.trendOf(entry, now);
      // 趋势修正：上升趋势上浮预测，下降趋势下调
      const trendFactor = trend === 'rising' ? 1.25 : trend === 'falling' ? 0.75 : 1;
      const expected = ratePerMs * horizonMs * trendFactor;

      // 时段热度修正：目标时段相对全天均值的权重
      // 42.0：挂载谱日历后，小时直方图（周期被预设为一天）升级为
      // 从到达史解出的频谱——Fisher g 显著时用谐波重构的季节因子
      // （相位感知，可捕捉非昼夜节律）；不显著时回退原直方图口径。
      const hourFactor = this.spectralCalendar
        ? (this.spectralFactorOf(entry, now + horizonMs / 2) ?? this.hourFactor(entry, now + horizonMs / 2))
        : this.hourFactor(entry, now + horizonMs / 2);
      const adjustedRaw = expected * hourFactor;

      const confidence = this.calibrationConfidence(type);

      // 13.0：保形区间升级——泊松 sqrt(λ) 近似是「假装高斯」；
      // 保形区间给出精确有限样本覆盖保证（≥ 1−α，零分布假设）。
      // 校准不足时 finite=false（诚实发散），回退泊松近似区间。
      // 26.0：GP 校准修正——期望乘以从校准史学出的比值因子（含不确定度），
      // 区间按后验标准差拓宽；校准史不足时 factor=1（零漂移）。
      const gpCorrection = this.gpFor(type)?.predictAt(now);
      const gpFactor = gpCorrection?.factor ?? 1;
      const gpStd = gpCorrection?.std ?? 0;
      const adjusted = adjustedRaw * gpFactor;
      const gpSpread = gpStd * adjustedRaw;
      // 置信区间：基于到达间隔的波动性（泊松近似，std≈sqrt(mean)）；
      // GP 不确定度在区间端点上单独叠加（避免与泊松口径重复计价）
      const spread = Math.sqrt(Math.max(adjusted, 0.5));

      let prediction: ArrivalPrediction;
      if (this.conformalEngine) {
        const interval = this.conformalEngine.interval(adjusted);
        prediction = {
          type,
          expectedCount: Number(adjusted.toFixed(2)),
          lowerBound: interval.finite ? Number(Math.max(0, interval.lower - gpSpread).toFixed(2)) : Math.max(0, Number((adjusted - spread - gpSpread).toFixed(2))),
          upperBound: interval.finite ? Number(Math.max(0, interval.upper + gpSpread).toFixed(2)) : Number((adjusted + spread + gpSpread).toFixed(2)),
          confidence,
          trend,
          conformal: {
            lower: interval.finite ? Number(Math.max(0, interval.lower - gpSpread).toFixed(2)) : Number.POSITIVE_INFINITY,
            upper: interval.finite ? Number(Math.max(0, interval.upper + gpSpread).toFixed(2)) : Number.POSITIVE_INFINITY,
            finite: interval.finite,
            qhat: interval.qhat,
            calibrationN: interval.calibrationN,
            alpha: interval.alpha,
          },
          ...(gpCorrection ? { gp: { factor: Number(gpFactor.toFixed(3)), std: Number(gpStd.toFixed(3)), points: gpCorrection.points } } : {}),
        };
        this.pendingPredictions.set(type, {
          predicted: adjusted,
          windowEnd: now + horizonMs,
          conformalInterval: interval.finite ? { lower: interval.lower, upper: interval.upper, finite: true } : undefined,
        });
      } else {
        prediction = {
          type,
          expectedCount: Number(adjusted.toFixed(2)),
          lowerBound: Math.max(0, Number((adjusted - spread - gpSpread).toFixed(2))),
          upperBound: Number((adjusted + spread + gpSpread).toFixed(2)),
          confidence,
          trend,
          ...(gpCorrection ? { gp: { factor: Number(gpFactor.toFixed(3)), std: Number(gpStd.toFixed(3)), points: gpCorrection.points } } : {}),
        };
        this.pendingPredictions.set(type, { predicted: adjusted, windowEnd: now + horizonMs });
      }
      predictions.push(prediction);
    }

    return predictions.sort((a, b) => b.expectedCount - a.expectedCount);
  }

  /**
   * 对账预测与实际到达（校准）
   * @returns 本轮新增的校准记录
   */
  settleCalibrations(now = Date.now()): CalibrationRecord[] {
    const settled: CalibrationRecord[] = [];
    for (const [type, pending] of this.pendingPredictions) {
      if (pending.windowEnd > now) continue;
      const entry = this.stats.get(type);
      // 统计预测窗口内的实际到达数
      const windowStart = pending.windowEnd - this.lastHorizonMs;
      const actualCount = entry ? entry.timestamps.filter((t) => t > windowStart && t <= pending.windowEnd).length : 0;
      const record: CalibrationRecord = {
        type,
        predicted: Number(pending.predicted.toFixed(2)),
        actual: actualCount,
        error: Number(Math.abs(pending.predicted - actualCount).toFixed(2)),
        timestamp: now,
      };
      this.calibrations.push(record);
      settled.push(record);
      // 26.0：比值入 GP 校准器（actual/predicted 序列 → 预测修正因子）
      const gp = this.gpFor(type);
      if (gp && record.predicted > 0) {
        gp.push(now, Math.max(0.05, Math.min(20, record.actual / record.predicted)));
      }
      // 13.0：残差入保形校准集 + 覆盖监测（发出过有限区间才对账覆盖）
      if (this.conformalEngine) {
        this.conformalEngine.calibrate(record.error);
        if (pending.conformalInterval?.finite) {
          this.conformalEngine.recordCovered(
            actualCount >= pending.conformalInterval.lower && actualCount <= pending.conformalInterval.upper,
          );
        }
      }
      this.pendingPredictions.delete(type);
    }
    if (this.calibrations.length > 200) this.calibrations.splice(0, this.calibrations.length - 200);
    return settled;
  }

  /**
   * 类型关联矩阵（共现强度）
   * @param minStrength 最低关联强度过滤
   * @returns 类型对关联列表（按强度降序）
   */
  getCorrelations(minStrength = 0.1): TypeCorrelation[] {
    const types = [...this.stats.keys()];
    const correlations: TypeCorrelation[] = [];
    for (let i = 0; i < types.length; i += 1) {
      for (let j = i + 1; j < types.length; j += 1) {
        const a = this.stats.get(types[i])!;
        const b = this.stats.get(types[j])!;
        const coOccurrences = this.countCoOccurrences(a.timestamps, b.timestamps);
        if (coOccurrences === 0) continue;
        // 强度契约 0~1：一个到达可在窗口内匹配对方多个到达（成对计数），
        // 比值可能越过 1（如 1 次稀疏到达邻近对方 10 次密集到达）——按文档口径钳位上界
        const strength = Math.min(1, coOccurrences / Math.max(1, Math.min(a.totalCount, b.totalCount)));
        if (strength >= minStrength) {
          correlations.push({ typeA: types[i], typeB: types[j], coOccurrences, strength: Number(strength.toFixed(3)) });
        }
      }
    }
    return correlations.sort((x, y) => y.strength - x.strength);
  }

  /**
   * 趋势检测：识别到达率上升的类型（负载预警）
   * @returns 上升趋势的类型列表（含斜率）
   */
  detectTrends(): Array<{ type: string; trend: 'rising' | 'falling' | 'stable'; slopePerMin: number }> {
    const now = Date.now();
    const results: Array<{ type: string; trend: 'rising' | 'falling' | 'stable'; slopePerMin: number }> = [];
    for (const [type, entry] of this.stats) {
      const slope = this.slopeOf(entry, now);
      const trend = slope > this.config.risingSlopeThreshold ? 'rising' : slope < -this.config.risingSlopeThreshold ? 'falling' : 'stable';
      results.push({ type, trend, slopePerMin: Number(slope.toFixed(4)) });
    }
    return results.sort((a, b) => b.slopePerMin - a.slopePerMin);
  }

  /** 世界模型摘要 */
  getSummary(): WorldModelSummary {
    const types = [...this.stats.keys()];
    return {
      trackedTypes: types.length,
      totalArrivals: types.reduce((sum, t) => sum + this.stats.get(t)!.totalCount, 0),
      types: types.map((t) => {
        const entry = this.stats.get(t)!;
        return { type: t, totalCount: entry.totalCount, lastSeenAt: entry.lastSeenAt, recentRatePerMin: Number((this.recentRate(entry, Date.now()) * 60_000).toFixed(3)) };
      }),
      correlations: this.getCorrelations().slice(0, 10),
      trends: this.detectTrends().filter((t) => t.trend !== 'stable'),
      calibrationError: this.meanCalibrationError(),
      // 5.0：混杂指纹 —— 观测共现强但因果效应弱的类型对（伪规律证伪现场）
      confoundedPairs: this.causal
        ? this.causal
            .detectConfounding()
            .filter((e) => e.from.startsWith('signal:') && e.to.startsWith('signal:'))
            .slice(0, 5)
            .map((e) => ({
              typeA: e.from.replace('signal:', ''),
              typeB: e.to.replace('signal:', ''),
              observationalStrength: e.observationalAssociation,
              causalEffect: e.ate,
              divergence: e.divergence,
            }))
        : undefined,
      // 13.0：保形校准状态（区间保证 + 覆盖漂移监测）
      conformal: this.conformalEngine ? this.conformalEngine.status() : undefined,
    };
  }

  /** 平均校准误差（MAE） */
  meanCalibrationError(): number {
    if (this.calibrations.length === 0) return 0;
    return Number((this.calibrations.reduce((sum, c) => sum + c.error, 0) / this.calibrations.length).toFixed(3));
  }

  /** 序列化 */
  serialize(): { stats: ArrivalStats[]; calibrations: CalibrationRecord[] } {
    return { stats: [...this.stats.values()], calibrations: [...this.calibrations] };
  }

  /** 反序列化 */
  deserialize(data: { stats: ArrivalStats[]; calibrations: CalibrationRecord[] }): void {
    this.stats.clear();
    for (const entry of data.stats) this.stats.set(entry.type, entry);
    this.calibrations = [...data.calibrations];
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 最近到达率（每毫秒），基于最近 5 分钟窗口 */
  private recentRate(entry: ArrivalStats, now: number): number {
    const windowMs = 5 * 60_000;
    const recent = entry.timestamps.filter((t) => t >= now - windowMs);
    if (recent.length === 0) return 0;
    return recent.length / windowMs;
  }

  /** 时段热度因子：目标时段计数 / 全天均值 */
  /**
   * 42.0：挂载谱日历（幂等覆盖，挂载即生效）。
   *
   * 时段热度从「预设为一天的小时直方图」升级为谱分析：到达时间戳按
   * 小时分桶为时间序列，FFT 周期图 + Fisher g 检验判定是否存在显著
   * 周期（任意周期——分钟回环/小时批处理/昼夜/周节律）；显著时
   * predictArrivals 的热度因子切换为谐波重构的季节因子（相位感知），
   * 不显著时逐位回退原直方图口径。未挂载零漂移。
   */
  attachSpectralCalendar(options?: { bins?: number }): void {
    this.spectralCalendar = { bins: Math.max(32, Math.floor(options?.bins ?? 128)) };
  }

  /** 42.0：谱日历配置（未挂载 undefined） */
  private spectralCalendar?: { bins: number };

  /**
   * 56.0：挂载置信传播（幂等覆盖，挂载即生效——旁路咨询口径）。
   *
   * fuseBeliefs() 把「多源证据 × 假设」结构化为因子图：假设变量化
   * （离散域 + 单源先验）× 证据因子化（兼容度势表），sum-product 边缘
   * 给出「综合全部证据后各假设多可信」——与 20.0 层论共识互补（层论
   * 定位「哪里结构性矛盾」，本内核量化「矛盾之下各假设的相对可信度」；
   * 互斥证据不再被平均成编造共识）。不改变任何既有预测/统计路径
   * （零漂移）——融合结果按需消费。
   */
  attachBeliefPropagation(): void {
    this.beliefPropagationEnabled = true;
  }

  /** 56.0：置信传播挂载标志（未挂载零介入） */
  private beliefPropagationEnabled = false;

  /**
   * 56.0：多源信念融合（未挂载 / 结构非法时 undefined——诚实降级）。
   * @param spec.variables 假设变量 [{id, domain（离散状态数）, prior?（缺省均匀）}]
   * @param spec.factors 证据因子 [{scope（覆盖变量 id）, table（兼容度势表）}]
   * @param spec.damping 阻尼系数（含圈图建议 0.5）
   */
  fuseBeliefs(spec: {
    variables: Array<{ id: string; domain: number; prior?: number[] }>;
    factors: Array<{ scope: string[]; table: number[] }>;
    damping?: number;
  }): { report: BPReport; marginals: Record<string, number[]> } | undefined {
    if (!this.beliefPropagationEnabled) return undefined;
    try {
      const graph = new FactorGraph();
      for (const v of spec.variables) graph.addVariable(v.id, v.domain, v.prior);
      for (const f of spec.factors) graph.addFactor(f.scope, f.table);
      const report = graph.runBeliefPropagation({ damping: spec.damping });
      return { report, marginals: graph.marginals() };
    } catch {
      return undefined; // 结构非法（未知变量 / 势表长度不符等）→ 诚实降级
    }
  }

  /**
   * 69.0：挂载 Mapper 经验透镜（幂等覆盖，挂载即生效——只读观测口径）。
   *
   * 经验地形图：各信号类型在「总量 × 活跃度」对数平面上的 Mapper 骨架
   * （区间覆盖 × 单链聚类 × 圈基）——分量数变化 = 行为模式分裂/合并的
   * 拓扑事件，圈基维数 > 0 = 经验空洞（探索盲区的拓扑定义，好奇心可按
   * 洞定向）。纯读数（不改变任何预测路径，零漂移）。
   */
  attachMapperLens(options?: { intervals?: number; overlap?: number; clusterEps?: number }): void {
    this.mapperLens = {
      intervals: Math.max(2, Math.floor(options?.intervals ?? 5)),
      overlap: options?.overlap ?? 0.33,
      clusterEps: options?.clusterEps ?? 0.5,
    };
  }

  /** 69.0：Mapper 透镜配置（未挂载 undefined） */
  private mapperLens?: { intervals: number; overlap: number; clusterEps: number };

  /**
   * 69.0：经验地形图视图（未挂载 / 类型 <3 时 undefined）。
   * points = [log₁₀(1+总到达数), log₁₀(1+近期速率×60)]（总量/活跃度双维），
   * 滤镜取活跃度维（覆盖沿活跃度展开——盲区即低活跃带）。
   */
  experienceMapperView(): { graph: MapperGraph; insight: string } | undefined {
    if (!this.mapperLens) return undefined;
    const types = this.getSummary().types;
    if (types.length < 3) return undefined;
    const points = types.map((t) => [
      Math.log10(1 + t.totalCount),
      Math.log10(1 + t.recentRatePerMin * 60),
    ]);
    const filterValues = points.map((p) => p[1]);
    const min = Math.min(...filterValues);
    const max = Math.max(...filterValues);
    if (!(max - min > 1e-9)) return undefined; // 活跃度同层：无覆盖结构可图
    let graph: MapperGraph;
    try {
      graph = buildMapper({
        points,
        filter: (p) => p[1],
        intervals: this.mapperLens.intervals,
        overlap: this.mapperLens.overlap,
        clusterEps: this.mapperLens.clusterEps,
      });
    } catch {
      return undefined; // 覆盖参数与数据形态不匹配（空区间等）→ 诚实降级
    }
    return { graph, insight: mapperInsight(graph) };
  }

  /**
   * 77.0：挂载因果发现透镜（幂等覆盖，挂载即生效——旁路咨询口径）。
   *
   * 观测指标流（模型旋钮 × 任务特征 × KPI）攒成 n×d 矩阵 → PC 算法学
   * CPDAG（5.0 causal-kernel 管「已知图做推断」，本内核管「图从哪来」
   * ——两内核合成完整因果闭环）。无向边是「数据说不清」的诚实陈述，
   * 接线侧不得替它拍方向。纯读数（零漂移）。
   */
  attachCausalLens(options?: { alpha?: number }): void {
    this.causalLens = { alpha: options?.alpha ?? 0.01 };
  }

  /** 77.0：因果发现透镜配置（未挂载 undefined） */
  private causalLens?: { alpha: number };

  /** 77.0：因果结构读数（未挂载 / 样本不足 / 维度超护栏时 undefined） */
  causalDiscoveryView(input: CausalObservationInput): CausalStructureView | undefined {
    return this.causalLens ? causalStructureView(input, { alpha: this.causalLens.alpha }) : undefined;
  }

  /**
   * 78.0：挂载典型相关透镜（幂等覆盖，挂载即生效——旁路咨询口径）。
   *
   * 模型评分面板 X × 多源信号特征 Y → CCA 公共潜坐标系：高 ρ 方向 =
   * 共享因子（证据融合先投影到典型变量再加权，替代异构列硬拼接），
   * 低 ρ = 私有噪声自动降权；某源典型相关谱整体塌陷 = 该源与世界模型
   * 脱锚（触发校准/下线检查）。纯读数（零漂移）。
   */
  attachCcaLens(options?: { lambda?: number }): void {
    this.ccaLens = { lambda: options?.lambda ?? 0.5 };
  }

  /** 78.0：CCA 透镜配置（未挂载 undefined；早期积累期 λ>0 走岭正则护栏） */
  private ccaLens?: { lambda: number };

  /** 78.0：多源对齐读数（未挂载 / 维度退化时 undefined） */
  ccaAlignmentView(x: ReadonlyArray<ReadonlyArray<number>>, y: ReadonlyArray<ReadonlyArray<number>>): SourceAlignmentView | undefined {
    return this.ccaLens ? sourceAlignmentView(x, y, { lambda: this.ccaLens.lambda }) : undefined;
  }

  /**
   * 79.0：挂载扩散映射透镜（幂等覆盖，挂载即生效——旁路咨询口径）。
   *
   * 经验连续嵌入（与 69.0 Mapper 成对：Mapper 给离散骨架，本内核给连续
   * 坐标）：嵌入欧氏距离 ≈ 扩散距离 = 流形上的连通难度；谱隙/分量数兼作
   * 经验分布的结构预警（行为模式分裂/合并事件）。纯读数（零漂移）。
   */
  attachDiffusionLens(options?: { k?: number; dims?: number }): void {
    this.diffusionLens = { k: options?.k ?? 10, dims: options?.dims ?? 2 };
  }

  /** 79.0：扩散映射透镜配置（未挂载 undefined） */
  private diffusionLens?: { k: number; dims: number };

  /** 79.0：经验流形读数（未挂载 / 样本不足时 undefined；points = 表示向量） */
  experienceManifoldView(points: ReadonlyArray<ReadonlyArray<number>>): ManifoldEmbeddingView | undefined {
    return this.diffusionLens ? manifoldEmbeddingView(points, { k: this.diffusionLens.k, dims: this.diffusionLens.dims }) : undefined;
  }

  // ─────────────────── 第三轮·观测信念融合 + 时间旅行 + 健康度 ───────────────────

  /**
   * 第三轮：挂载观测信念融合（幂等覆盖，挂载即生效——观测台口径）。
   *
   * 多源写入冲突消解从「后写覆盖」升级为「可靠性加权 + 真冲突检测」：
   * - 每个源带可靠性画像（Beta 先验，缺省 0.5；可用 sourcePriors 预置），
   *   随写入结果在线校准——与既有信念互相印证 → 一致数 +1；写入被拒或
   *   被更强源推翻 → 矛盾数 +1；可靠性 = Beta 后验均值（Laplace 平滑）。
   * - 写入裁决：同值 → 印证（信念强度按 noisy-OR 合并）；异值且双源都
   *   自信（强度均 ≥ conflictThreshold）→ **真冲突**——记账而非静默覆盖，
   *   等显式 resolveConflict 裁决；异值但只有一方自信 → 强度定胜负
   *   （可靠源胜噪声源，噪声写入被拒且记矛盾）。
   * - 每次版本推进落一帧全量快照进环形缓冲（最近 K 版），支持回到任一
   *   保留版本查询与键级 diff（时间旅行视图）。
   *
   * 不挂载零介入：writeObservation / observationStateAt / diffObservations
   * 等一律返回 undefined，既有预测/统计路径逐位不变（零漂移）。
   */
  attachObservationFusion(options?: {
    /** 快照环深度（最近 K 版，缺省 24，最小 2） */
    snapshotDepth?: number;
    /** 真冲突判定：双方信念强度下限（缺省 0.35） */
    conflictThreshold?: number;
    /** 推翻既有信念所需强度比（挑战者 > 既有 × margin，缺省 1.2） */
    overwriteMargin?: number;
    /** 源可靠性先验（source → 0~1；缺省全部 0.5） */
    sourcePriors?: Record<string, number>;
  }): void {
    const priors = new Map<string, { alpha: number; beta: number }>();
    for (const [source, prior] of Object.entries(options?.sourcePriors ?? {})) {
      const p = Math.min(0.99, Math.max(0.01, prior));
      const kappa = 10; // 先验权重：等价于 10 次虚拟观测
      priors.set(source, { alpha: p * kappa, beta: (1 - p) * kappa });
    }
    this.observationFusion = {
      snapshotDepth: Math.max(2, Math.floor(options?.snapshotDepth ?? 24)),
      conflictThreshold: Math.min(1, Math.max(0, options?.conflictThreshold ?? 0.35)),
      overwriteMargin: Math.max(1, options?.overwriteMargin ?? 1.2),
      priors,
      beliefs: new Map(),
      reliabilities: new Map(),
      conflicts: [],
      snapshots: [],
      version: 0,
    };
  }

  /** 第三轮：观测融合配置与状态（未挂载 undefined） */
  private observationFusion?: {
    snapshotDepth: number;
    conflictThreshold: number;
    overwriteMargin: number;
    priors: Map<string, { alpha: number; beta: number }>;
    beliefs: Map<string, ObservationBelief>;
    reliabilities: Map<string, { corroboration: number; contradictions: number; conflicts: number; writes: number; lastSeenAt: number }>;
    conflicts: ObservationConflict[];
    snapshots: TimeTravelSnapshot[];
    version: number;
  };

  /** 源可靠性后验均值（Beta(α₀+一致, β₀+矛盾) 的均值口径） */
  private reliabilityOf(source: string): number {
    const fusion = this.observationFusion!;
    const prior = fusion.priors.get(source) ?? { alpha: 1, beta: 1 };
    const stat = fusion.reliabilities.get(source);
    if (!stat) return prior.alpha / (prior.alpha + prior.beta);
    return (prior.alpha + stat.corroboration) / (prior.alpha + prior.beta + stat.corroboration + stat.contradictions);
  }

  /** 登记一次源活动（不动可靠性，只更新写入计数与时间） */
  private touchSource(source: string, timestamp: number): void {
    const stat = this.observationFusion!.reliabilities.get(source);
    if (stat) {
      stat.writes += 1;
      stat.lastSeenAt = timestamp;
    } else {
      this.observationFusion!.reliabilities.set(source, { corroboration: 0, contradictions: 0, conflicts: 0, writes: 1, lastSeenAt: timestamp });
    }
  }

  /**
   * 版本推进 + 落一帧全量快照（环形缓冲，超出深度淘汰最旧）。
   * apply 在版本号自增后、快照落盘前执行——调用方在其中把新信念的
   * version 字段对齐到本帧版本，保证快照里的版本号完整。
   */
  private commitSnapshot(timestamp: number, apply?: (version: number) => void): number {
    const fusion = this.observationFusion!;
    fusion.version += 1;
    apply?.(fusion.version);
    fusion.snapshots.push({
      version: fusion.version,
      timestamp,
      beliefs: [...fusion.beliefs.values()].map((b) => ({ ...b })),
    });
    if (fusion.snapshots.length > fusion.snapshotDepth) fusion.snapshots.splice(0, fusion.snapshots.length - fusion.snapshotDepth);
    return fusion.version;
  }

  /**
   * 第三轮：多源观测写入（未挂载 → undefined 诚实降级）。
   *
   * @param key 观测键（如 'host-tool:read_file.latency'）
   * @param value 观测值（原样保存；同值判定 Object.is → JSON 兜底）
   * @param source 观测源标识
   * @param options.confidence 该源本次写入的自信度 0~1（缺省 0.8）
   * @param options.timestamp 写入时间戳（缺省当前时间）
   * @returns 裁决结果：accepted（是否成为当前信念）、belief（裁决后的当前
   *   信念）、version（本次推进到的版本号；被拒写入不推进版本）、
   *   conflict（触发真冲突时携带冲突记录）
   */
  writeObservation(
    key: string,
    value: unknown,
    source: string,
    options?: { confidence?: number; timestamp?: number },
  ): { accepted: boolean; belief: ObservationBelief; version: number; conflict?: ObservationConflict } | undefined {
    const fusion = this.observationFusion;
    if (!fusion) return undefined;
    const timestamp = options?.timestamp ?? Date.now();
    const confidence = Math.min(1, Math.max(0.01, options?.confidence ?? 0.8));
    const reliability = this.reliabilityOf(source);
    const strength = reliability * confidence;
    this.touchSource(source, timestamp);

    const incumbent = fusion.beliefs.get(key);
    const stat = fusion.reliabilities.get(source)!;

    // 首次写入：直接建立信念
    if (!incumbent) {
      const belief: ObservationBelief = { key, value, source, strength, version: 0, updatedAt: timestamp, conflicted: false };
      fusion.beliefs.set(key, belief);
      const version = this.commitSnapshot(timestamp, (v) => {
        belief.version = v;
      });
      this.noteEvidence(key, source, false);
      this.journalEmit('write', key, source, version, { to: value, reason: 'first-write' }, timestamp);
      return { accepted: true, belief: { ...belief }, version };
    }

    // 同值 → 互相印证（写入者与原信念源同时加分；强度按 noisy-OR 合并）
    if (valuesEqual(incumbent.value, value)) {
      if (source !== incumbent.source) {
        stat.corroboration += 1;
        const incumbentStat = fusion.reliabilities.get(incumbent.source);
        if (incumbentStat) incumbentStat.corroboration += 1;
      } else {
        stat.corroboration += 1;
      }
      incumbent.strength = Math.min(0.9999, 1 - (1 - incumbent.strength) * (1 - strength));
      incumbent.updatedAt = timestamp;
      incumbent.conflicted = false; // 印证即消解待裁决状态（同值侧证据加强）
      const openConflict = fusion.conflicts.find((c) => c.key === key && !c.resolved);
      if (openConflict && valuesEqual(openConflict.incumbent.value, value)) {
        openConflict.resolved = true;
        openConflict.resolvedTo = value;
      }
      const version = this.commitSnapshot(timestamp, (v) => {
        incumbent.version = v;
      });
      this.noteEvidence(key, source, true);
      this.journalEmit('write', key, source, version, { from: incumbent.value, to: value, reason: 'corroborated' }, timestamp);
      return { accepted: true, belief: { ...incumbent }, version };
    }

    // 异值：双源都自信 → 真冲突（记账不覆盖，等显式裁决）
    if (strength >= fusion.conflictThreshold && incumbent.strength >= fusion.conflictThreshold) {
      const conflict: ObservationConflict = {
        key,
        incumbent: { value: incumbent.value, source: incumbent.source, strength: incumbent.strength },
        challenger: { value, source, strength },
        version: fusion.version,
        timestamp,
      };
      fusion.conflicts.push(conflict);
      if (fusion.conflicts.length > 200) fusion.conflicts.splice(0, fusion.conflicts.length - 200);
      stat.conflicts += 1;
      const incumbentStat = fusion.reliabilities.get(incumbent.source);
      if (incumbentStat) incumbentStat.conflicts += 1;
      incumbent.conflicted = true;
      const version = this.commitSnapshot(timestamp, (v) => {
        incumbent.version = v;
        conflict.version = v;
      });
      this.journalEmit('conflict', key, source, version, { from: incumbent.value, to: value, reason: 'conflict-raised', challenger: { value, source } }, timestamp);
      return { accepted: false, belief: { ...incumbent }, version, conflict };
    }

    // 异值、单侧自信：强度定胜负（挑战者需显著更强才推翻——可靠源胜噪声源）
    if (strength > incumbent.strength * fusion.overwriteMargin) {
      const incumbentStat = fusion.reliabilities.get(incumbent.source);
      if (incumbentStat) incumbentStat.contradictions += 1; // 被更强源推翻记矛盾
      const previousValue = incumbent.value;
      const belief: ObservationBelief = { key, value, source, strength, version: 0, updatedAt: timestamp, conflicted: false };
      fusion.beliefs.set(key, belief);
      const version = this.commitSnapshot(timestamp, (v) => {
        belief.version = v;
      });
      this.noteEvidence(key, source, false);
      this.journalEmit('write', key, source, version, { from: previousValue, to: value, reason: 'overwritten' }, timestamp);
      return { accepted: true, belief: { ...belief }, version };
    }

    // 噪声写入被拒：挑战者记矛盾（与世界相悖），版本不推进
    stat.contradictions += 1;
    this.noteRejection(key);
    this.journalEmit('reject', key, source, fusion.version, { to: value, reason: 'out-strengthened' }, timestamp);
    return { accepted: false, belief: { ...incumbent }, version: fusion.version };
  }

  /**
   * 第三轮：显式裁决真冲突（裁决即校准——胜方参战源一致 +1，败方矛盾 +1）。
   * @returns 裁决后的信念；无未决冲突 / 未挂载 → undefined
   */
  resolveObservationConflict(key: string, value: unknown, adjudicator = 'manual'): ObservationBelief | undefined {
    const fusion = this.observationFusion;
    if (!fusion) return undefined;
    const open = fusion.conflicts.find((c) => c.key === key && !c.resolved);
    if (!open) return undefined;
    const winnerIsIncumbent = valuesEqual(open.incumbent.value, value);
    const winnerIsChallenger = valuesEqual(open.challenger.value, value);
    if (winnerIsIncumbent || winnerIsChallenger) {
      // 裁决落在参战某方：胜方一致 +1，败方矛盾 +1
      const winnerSource = winnerIsIncumbent ? open.incumbent.source : open.challenger.source;
      const loserSource = winnerIsIncumbent ? open.challenger.source : open.incumbent.source;
      const winnerStat = fusion.reliabilities.get(winnerSource);
      if (winnerStat) winnerStat.corroboration += 1;
      const loserStat = fusion.reliabilities.get(loserSource);
      if (loserStat) loserStat.contradictions += 1;
    }
    const belief: ObservationBelief = {
      key,
      value,
      source: winnerIsIncumbent ? open.incumbent.source : winnerIsChallenger ? open.challenger.source : adjudicator,
      strength: Math.max(open.incumbent.strength, open.challenger.strength),
      version: 0,
      updatedAt: Date.now(),
      conflicted: false,
    };
    fusion.beliefs.set(key, belief);
    const version = this.commitSnapshot(belief.updatedAt, (v) => {
      belief.version = v;
      open.resolved = true;
      open.resolvedTo = value;
      open.adjudicatedBy = adjudicator;
    });
    this.noteEvidence(key, belief.source, true);
    this.journalEmit('resolve', key, belief.source, version, { from: open.incumbent.value, to: value, reason: adjudicator });
    return { ...belief, version };
  }

  /** 第三轮：当前观测信念全景（未挂载 / 空 → undefined） */
  observationBeliefs(): ObservationBelief[] | undefined {
    const fusion = this.observationFusion;
    if (!fusion) return undefined;
    return [...fusion.beliefs.values()].map((b) => ({ ...b }));
  }

  /** 第三轮：真冲突台账（未挂载 → undefined；含已裁决历史） */
  observationConflicts(): ObservationConflict[] | undefined {
    return this.observationFusion ? this.observationFusion.conflicts.map((c) => ({ ...c, incumbent: { ...c.incumbent }, challenger: { ...c.challenger } })) : undefined;
  }

  /** 第三轮：源可靠性画像（未挂载 → undefined；按可靠性降序） */
  sourceReliabilities(): SourceReliability[] | undefined {
    const fusion = this.observationFusion;
    if (!fusion) return undefined;
    return [...fusion.reliabilities.entries()]
      .map(([source, stat]) => ({ source, reliability: Number(this.reliabilityOf(source).toFixed(4)), corroborations: stat.corroboration, contradictions: stat.contradictions, conflicts: stat.conflicts, writes: stat.writes, lastSeenAt: stat.lastSeenAt }))
      .sort((a, b) => b.reliability - a.reliability);
  }

  /** 第三轮：当前全局版本号（未挂载 → undefined） */
  observationVersion(): number | undefined {
    return this.observationFusion?.version;
  }

  /**
   * 第三轮：时间旅行——回到版本 t 查询（未挂载 / 版本不存在或已被
   * 环形缓冲淘汰 → undefined；可用 observationVersions() 枚举保留版本）。
   */
  observationStateAt(version: number): TimeTravelSnapshot | undefined {
    const fusion = this.observationFusion;
    if (!fusion) return undefined;
    const frame = fusion.snapshots.find((s) => s.version === version);
    if (!frame) return undefined;
    return { version: frame.version, timestamp: frame.timestamp, beliefs: frame.beliefs.map((b) => ({ ...b })) };
  }

  /** 第三轮：快照环当前保留的版本号列表（升序；未挂载 → undefined） */
  observationVersions(): number[] | undefined {
    return this.observationFusion?.snapshots.map((s) => s.version);
  }

  /**
   * 第三轮：遗忘一个观测键（删除也是版本化事件——时间旅行 diff 的
   * 「删」态来源）。未挂载 / 键不存在 → undefined（无事发生）。
   * @returns 删除后的版本号
   */
  forgetObservation(key: string, reason = 'manual'): number | undefined {
    const fusion = this.observationFusion;
    if (!fusion || !fusion.beliefs.has(key)) return undefined;
    const existed = fusion.beliefs.get(key)!;
    fusion.beliefs.delete(key);
    // 该键的未决冲突一并作废（主体已不存在）
    for (const conflict of fusion.conflicts) {
      if (conflict.key === key && !conflict.resolved) {
        conflict.resolved = true;
        conflict.resolvedTo = undefined;
        conflict.adjudicatedBy = `forgot:${reason}`;
      }
    }
    const version = this.commitSnapshot(Date.now());
    this.journalEmit('forget', key, existed.source, version, { from: existed.value, reason });
    return version;
  }

  /**
   * 第三轮：时间旅行——两版本间的键级 diff（增/删/改）。
   * 任一版本不在快照环内 → undefined（诚实降级，不猜）。
   */
  diffObservations(versionA: number, versionB: number): ObservationDiff | undefined {
    const fusion = this.observationFusion;
    if (!fusion) return undefined;
    const frameA = fusion.snapshots.find((s) => s.version === versionA);
    const frameB = fusion.snapshots.find((s) => s.version === versionB);
    if (!frameA || !frameB) return undefined;
    const mapA = new Map(frameA.beliefs.map((b) => [b.key, b]));
    const mapB = new Map(frameB.beliefs.map((b) => [b.key, b]));
    const added: Array<{ key: string; value: unknown }> = [];
    const removed: Array<{ key: string; value: unknown }> = [];
    const changed: Array<{ key: string; from: unknown; to: unknown }> = [];
    for (const [key, beliefB] of mapB) {
      const beliefA = mapA.get(key);
      if (!beliefA) added.push({ key, value: beliefB.value });
      else if (!valuesEqual(beliefA.value, beliefB.value)) changed.push({ key, from: beliefA.value, to: beliefB.value });
    }
    for (const [key, beliefA] of mapA) {
      if (!mapB.has(key)) removed.push({ key, value: beliefA.value });
    }
    return { fromVersion: versionA, toVersion: versionB, added, removed, changed };
  }

  /**
   * 第三轮：挂载世界模型健康度（幂等覆盖；77.0 因果 / 83.0 模型学习语义的
   * 运维延伸——「模型近期还准不准」本身就是该被监测的量）。
   *
   * 滚动窗口内：预测命中（|误差| ≤ 容差）率、平均误差、按类型分解；
   * 近期命中率崩坏（样本充足且 < relearnHitRate）→ needsRelearning=true
   * ——提示上层触发重学习（83.0 重估 T̂/r̂ / 77.0 重估因果图）。
   */
  attachWorldHealth(options?: { window?: number; hitTolerance?: number; minSamples?: number; relearnHitRate?: number }): void {
    this.worldHealthOptions = {
      window: Math.max(1, Math.floor(options?.window ?? 50)),
      hitTolerance: Math.max(0, options?.hitTolerance ?? 1),
      minSamples: Math.max(1, Math.floor(options?.minSamples ?? 8)),
      relearnHitRate: Math.min(1, Math.max(0, options?.relearnHitRate ?? 0.5)),
    };
  }

  /** 第三轮：健康度配置（未挂载 undefined） */
  private worldHealthOptions?: { window: number; hitTolerance: number; minSamples: number; relearnHitRate: number };

  /** 第三轮：世界模型健康度报告（未挂载 → undefined；滚动最近 window 条校准记录） */
  worldHealthReport(): WorldHealthReport | undefined {
    if (!this.worldHealthOptions) return undefined;
    return computeWorldHealth(this.calibrations, this.worldHealthOptions);
  }

  // ─────────────────── 第四轮·R4-1 反事实世界（影子分支 what-if） ───────────────────

  /**
   * 第四轮：挂载反事实引擎（幂等覆盖——重挂清空既有分支）。
   *
   * what-if 分支模拟：从当前观测信念 fork 一个影子分支，在影子上施加
   * 假设变化（suppose / supposeAbsent），查询影子态与主线的三方 diff
   * （fork 基线 × 主线现状 × 影子现状，逐键归因 hypothesis/mainline/
   * diverged）。影子写入只进分支的覆盖表——版本号、快照环、可靠性画像、
   * 冲突台账全部不动（主线零污染，可同时开多个互不干扰的平行假设）。
   * 未挂载零介入：fork/suppose/diff 一律 undefined/false。
   */
  attachCounterfactual(options?: { clock?: () => number }): void {
    this.counterfactualEngine = { clock: options?.clock ?? Date.now, nextBranch: 1, branches: new Map() };
  }

  /** 第四轮：反事实引擎状态（未挂载 undefined） */
  private counterfactualEngine?: {
    clock: () => number;
    nextBranch: number;
    branches: Map<string, CounterfactualBranchState>;
  };

  /**
   * 第四轮：fork 影子分支（「假设世界从这里走向别处」的起点）。
   * @returns 分支 id（`branch-N` 单调编号，确定性）；未挂载 → undefined
   */
  forkShadowWorld(label = 'what-if'): string | undefined {
    const engine = this.counterfactualEngine;
    if (!engine) return undefined;
    const id = `branch-${engine.nextBranch}`;
    engine.nextBranch += 1;
    const base = new Map<string, { value: unknown; source: string; strength: number }>();
    for (const [key, belief] of this.observationFusion?.beliefs ?? []) {
      base.set(key, { value: belief.value, source: belief.source, strength: belief.strength });
    }
    engine.branches.set(id, { label, createdAt: engine.clock(), forkedAtVersion: this.observationFusion?.version ?? 0, base, overrides: new Map(), notes: [] });
    return id;
  }

  /** 第四轮：施加假设「key = value」（只进影子；分支不存在 → false） */
  suppose(branchId: string, key: string, value: unknown, note?: string): boolean {
    const branch = this.counterfactualEngine?.branches.get(branchId);
    if (!branch) return false;
    const effectiveNote = note ?? supposeNote(key, value);
    branch.overrides.set(key, { value, note: effectiveNote });
    branch.notes.push(effectiveNote);
    return true;
  }

  /** 第四轮：施加假设「key 不存在」（删除也是可假设的 世界；只进影子） */
  supposeAbsent(branchId: string, key: string, note?: string): boolean {
    const branch = this.counterfactualEngine?.branches.get(branchId);
    if (!branch) return false;
    const effectiveNote = note ?? supposeNote(key, undefined, true);
    branch.overrides.set(key, null);
    branch.notes.push(effectiveNote);
    return true;
  }

  /** 第四轮：影子有效态全量（fork 基线 ∪ 假设覆盖 − 墓碑；按键升序） */
  shadowBeliefs(branchId: string): ShadowBelief[] | undefined {
    const branch = this.counterfactualEngine?.branches.get(branchId);
    if (!branch) return undefined;
    return [...this.effectiveShadow(branch).entries()]
      .map(([key, s]) => ({ key, value: s.value, hypothesis: s.hypothesis }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** 影子有效态 = 基线被假设覆盖（墓碑删除） */
  private effectiveShadow(branch: CounterfactualBranchState): Map<string, { value: unknown; hypothesis: string }> {
    const out = new Map<string, { value: unknown; hypothesis: string }>();
    for (const [key, b] of branch.base) out.set(key, { value: b.value, hypothesis: 'inherited' });
    for (const [key, override] of branch.overrides) {
      if (override === null) out.delete(key);
      else out.set(key, { value: override.value, hypothesis: override.note });
    }
    return out;
  }

  /**
   * 第四轮：反事实三方 diff——影子 vs 主线，以 fork 基线为合并基逐键归因：
   * - hypothesis：只有假设动了的键（「假设 X 则 Y」的直接答案）
   * - mainline：只有主线动了的键（fork 后世界自己走了——假设无关）
   * - diverged：两边都动了同一键（真分叉——假设与现实的背离现场）
   * 未动过的键不出现。分支不存在 → undefined。
   */
  counterfactualDiff(branchId: string): CounterfactualDiff | undefined {
    const engine = this.counterfactualEngine;
    const branch = engine?.branches.get(branchId);
    if (!engine || !branch) return undefined;
    const shadow = this.effectiveShadow(branch);
    const mainline = this.observationFusion?.beliefs ?? new Map<string, ObservationBelief>();
    const keys = new Set<string>([...branch.base.keys(), ...mainline.keys(), ...shadow.keys()]);
    const changes: CounterfactualChange[] = [];
    for (const key of [...keys].sort()) {
      const baseEntry = branch.base.get(key);
      const mainEntry = mainline.get(key);
      const shadowEntry = shadow.get(key);
      const hypTouched = branch.overrides.has(key);
      const mainMoved = !sameKeyState(baseEntry !== undefined, baseEntry?.value, mainEntry !== undefined, mainEntry?.value);
      const shadowMoved = !sameKeyState(baseEntry !== undefined, baseEntry?.value, shadowEntry !== undefined, shadowEntry?.value);
      if (!hypTouched && !mainMoved && !shadowMoved) continue;
      const cause: CounterfactualCause = hypTouched && mainMoved ? 'diverged' : hypTouched ? 'hypothesis' : 'mainline';
      changes.push({
        key,
        cause,
        base: baseEntry?.value,
        mainline: mainEntry ? { value: mainEntry.value, source: mainEntry.source, strength: mainEntry.strength } : undefined,
        shadow: shadowEntry ? { value: shadowEntry.value, hypothesis: shadowEntry.hypothesis } : undefined,
      });
    }
    return { branchId, label: branch.label, forkedAtVersion: branch.forkedAtVersion, mainlineVersion: this.observationFusion?.version ?? 0, changes };
  }

  /** 第四轮：全部反事实分支信息卡（创建序） */
  counterfactualBranches(): CounterfactualBranchInfo[] | undefined {
    const engine = this.counterfactualEngine;
    if (!engine) return undefined;
    return [...engine.branches.entries()].map(([id, b]) => ({ id, label: b.label, forkedAtVersion: b.forkedAtVersion, createdAt: b.createdAt, hypotheses: b.overrides.size, notes: [...b.notes] }));
  }

  /** 第四轮：关闭影子分支（分支不存在 → false；主线从未被影子影响） */
  closeShadowWorld(branchId: string): boolean {
    return this.counterfactualEngine?.branches.delete(branchId) ?? false;
  }

  // ─────────────────── 第四轮·R4-2 不确定性地图（键空间证据分区） ───────────────────

  /**
   * 第四轮：挂载不确定性地图（幂等覆盖——重挂清空登记与证据）。
   *
   * 键空间按证据强度四分区：充分（写入 ≥ minWrites 且独立源 ≥ minSources）/
   * 薄弱（有证据但不充分）/ 争议（有未决真冲突）/ 未知（从未被采纳性写入
   * ——被拒的噪声写入既不算证据、也不算矛盾）。证据计数在挂载后随
   * writeObservation 在线累积。未挂载零介入。
   */
  attachUncertaintyMap(options?: { minWrites?: number; minSources?: number; clock?: () => number }): void {
    this.uncertaintyLens = {
      minWrites: Math.max(1, Math.floor(options?.minWrites ?? 3)),
      minSources: Math.max(1, Math.floor(options?.minSources ?? 2)),
      clock: options?.clock ?? Date.now,
      registered: new Set(),
      evidence: new Map(),
    };
  }

  /** 第四轮：不确定性地图状态（未挂载 undefined） */
  private uncertaintyLens?: {
    minWrites: number;
    minSources: number;
    clock: () => number;
    registered: Set<string>;
    evidence: Map<string, { writes: number; sources: Set<string>; agreements: number; rejections: number; lastWriteAt: number }>;
  };

  /**
   * 第四轮：登记键空间（系统声称关心的键——未登记但被观测过的键也会进
   * 地图；登记的意义是把「从未见过」的键显式纳入未知率分母）。
   * @returns 登记后的键空间累计大小；未挂载 → undefined
   */
  registerKeySpace(keys: string[]): number | undefined {
    const lens = this.uncertaintyLens;
    if (!lens) return undefined;
    for (const key of keys) lens.registered.add(key);
    return lens.registered.size;
  }

  /** 采纳性写入的证据记账（挂载不确定性地图才生效） */
  private noteEvidence(key: string, source: string, agreed: boolean): void {
    const lens = this.uncertaintyLens;
    if (!lens) return;
    const entry = lens.evidence.get(key) ?? { writes: 0, sources: new Set<string>(), agreements: 0, rejections: 0, lastWriteAt: 0 };
    entry.writes += 1;
    entry.sources.add(source);
    if (agreed) entry.agreements += 1;
    entry.lastWriteAt = lens.clock();
    lens.evidence.set(key, entry);
  }

  /** 被拒写入的记账（不是证据、不是矛盾——只是「有人这么主张过但输了」） */
  private noteRejection(key: string): void {
    const lens = this.uncertaintyLens;
    if (!lens) return;
    const entry = lens.evidence.get(key) ?? { writes: 0, sources: new Set<string>(), agreements: 0, rejections: 0, lastWriteAt: 0 };
    entry.rejections += 1;
    lens.evidence.set(key, entry);
  }

  /**
   * 第四轮：不确定性地图——键空间四分区 + 未知率 + 薄弱区清单。
   * 分区优先序：争议（有未决冲突）→ 未知（无采纳证据且无信念）→
   * 薄弱 → 充分。未挂载 → undefined。
   */
  uncertaintyMap(): UncertaintyMapReport | undefined {
    const lens = this.uncertaintyLens;
    if (!lens) return undefined;
    const openConflicts = new Set((this.observationFusion?.conflicts ?? []).filter((c) => !c.resolved).map((c) => c.key));
    const keySpace = new Set<string>([...lens.registered, ...lens.evidence.keys(), ...(this.observationFusion?.beliefs.keys() ?? [])]);
    const zones: Record<UncertaintyZone, string[]> = { sufficient: [], thin: [], contested: [], unknown: [] };
    const thinRegions: ThinRegion[] = [];
    for (const key of [...keySpace].sort()) {
      const evidence = lens.evidence.get(key);
      const belief = this.observationFusion?.beliefs.get(key);
      if (openConflicts.has(key) || belief?.conflicted) {
        zones.contested.push(key);
        continue;
      }
      if (!evidence && !belief) {
        zones.unknown.push(key);
        continue;
      }
      const writes = evidence?.writes ?? 0;
      const sources = evidence?.sources.size ?? 0;
      if (writes < lens.minWrites || sources < lens.minSources) {
        zones.thin.push(key);
        thinRegions.push({
          key,
          writes,
          sources,
          agreements: evidence?.agreements ?? 0,
          rejections: evidence?.rejections ?? 0,
          beliefStrength: belief ? Number(belief.strength.toFixed(4)) : undefined,
        });
      } else {
        zones.sufficient.push(key);
      }
    }
    thinRegions.sort((a, b) => a.writes - b.writes || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return {
      keySpace: keySpace.size,
      zones,
      unknownRate: keySpace.size === 0 ? 0 : Number((zones.unknown.length / keySpace.size).toFixed(4)),
      thinRegions,
      contested: zones.contested.length,
      sufficient: zones.sufficient.length,
      generatedAt: lens.clock(),
    };
  }

  // ─────────────────── 第四轮·R4-3 多假说并存（竞争假说竞技场） ───────────────────

  /**
   * 第四轮：挂载多假说竞技场（幂等覆盖——重挂清空全部问题）。
   *
   * 同一现象的多个候选解释各自持有支持度：开问题时给先验（缺省均匀），
   * 新证据以相对似然做贝叶斯式更新（w_i ×= L_i 后归一；未提及的候选
   * L=1——证据对其沉默）。不设自动收敛：排序可随证据翻转，全部称量
   * 历史保留可回放，直到显式 retireQuestion 才终结。未挂载零介入。
   */
  attachHypothesisArena(options?: { clock?: () => number }): void {
    this.hypothesisArena = { clock: options?.clock ?? Date.now, nextId: 1, questions: new Map() };
  }

  /** 第四轮：竞技场状态（未挂载 undefined） */
  private hypothesisArena?: {
    clock: () => number;
    nextId: number;
    questions: Map<string, {
      topic: string;
      openedAt: number;
      retired: boolean;
      verdict: string | undefined;
      candidates: Array<{ id: string; label: string }>;
      weights: number[];
      history: EvidenceWeighing[];
    }>;
  };

  /**
   * 第四轮：开一个竞争问题。
   * @param candidates ≥2 个候选（id 唯一非空；prior > 0，缺省 1 → 均匀）
   * @returns 问题 id（`q-N` 单调编号，确定性）；未挂载 / 候选非法 → undefined
   */
  openQuestion(topic: string, candidates: Array<{ id: string; label?: string; prior?: number }>): string | undefined {
    const arena = this.hypothesisArena;
    if (!arena || !Array.isArray(candidates) || candidates.length < 2) return undefined;
    const seen = new Set<string>();
    const priors: number[] = [];
    const normalized: Array<{ id: string; label: string }> = [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.id !== 'string' || candidate.id.length === 0 || seen.has(candidate.id)) return undefined;
      const prior = candidate.prior ?? 1;
      if (!Number.isFinite(prior) || prior <= 0) return undefined;
      seen.add(candidate.id);
      priors.push(prior);
      normalized.push({ id: candidate.id, label: candidate.label ?? candidate.id });
    }
    const sum = priors.reduce((a, b) => a + b, 0);
    const id = `q-${arena.nextId}`;
    arena.nextId += 1;
    arena.questions.set(id, { topic, openedAt: arena.clock(), retired: false, verdict: undefined, candidates: normalized, weights: priors.map((p) => p / sum), history: [] });
    return id;
  }

  /**
   * 第四轮：称量一条证据——按相对似然贝叶斯式更新全体候选支持度。
   * @param likelihoods 候选 id → 相对似然（有限正数；未提及的候选 = 1）。
   *   必须至少提及一个候选，且不得出现未知候选 id（部分更新 = 不更新）。
   * @returns 称量记录（含更新后即刻的支持度快照）；问题不存在/已终结/
   *   似然非法 / 未挂载 → undefined（原支持度保持不变）
   */
  weighEvidence(questionId: string, likelihoods: Record<string, number>, note = ''): EvidenceWeighing | undefined {
    const arena = this.hypothesisArena;
    const question = arena?.questions.get(questionId);
    if (!arena || !question || question.retired) return undefined;
    const provided = Object.entries(likelihoods ?? {});
    if (provided.length === 0) return undefined;
    for (const [candidateId, likelihood] of provided) {
      if (!question.candidates.some((c) => c.id === candidateId)) return undefined;
      if (!Number.isFinite(likelihood) || likelihood <= 0) return undefined;
    }
    for (let i = 0; i < question.candidates.length; i += 1) {
      question.weights[i] *= likelihoods[question.candidates[i].id] ?? 1;
    }
    const sum = question.weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < question.weights.length; i += 1) question.weights[i] /= sum;
    const entry: EvidenceWeighing = {
      index: question.history.length + 1,
      timestamp: arena.clock(),
      note,
      likelihoods: { ...likelihoods },
      standingAfter: question.candidates.map((c, i) => ({ candidateId: c.id, support: Number(question.weights[i].toFixed(6)) })),
    };
    question.history.push(entry);
    return { ...entry, likelihoods: { ...entry.likelihoods }, standingAfter: entry.standingAfter.map((s) => ({ ...s })) };
  }

  /** 第四轮：当前支持度排序（降序；同分按候选插入序——确定性）；问题不存在 → undefined */
  hypothesisRanking(questionId: string): HypothesisStanding[] | undefined {
    const arena = this.hypothesisArena;
    const question = arena?.questions.get(questionId);
    if (!arena || !question) return undefined;
    return question.candidates
      .map((c, i) => ({ candidateId: c.id, label: c.label, support: Number(question.weights[i].toFixed(6)), i }))
      .sort((a, b) => b.support - a.support || a.i - b.i)
      .map(({ i, ...standing }) => standing);
  }

  /** 第四轮：称量史（含每次更新后的支持度快照——支持度怎么走到今天的可回放） */
  hypothesisHistory(questionId: string): EvidenceWeighing[] | undefined {
    const arena = this.hypothesisArena;
    if (!arena) return undefined;
    const question = arena.questions.get(questionId);
    if (!question) return undefined;
    return question.history.map((e) => ({ ...e, likelihoods: { ...e.likelihoods }, standingAfter: e.standingAfter.map((s) => ({ ...s })) }));
  }

  /** 第四轮：全部问题信息卡（开题序） */
  hypothesisQuestions(): HypothesisQuestionInfo[] | undefined {
    const arena = this.hypothesisArena;
    if (!arena) return undefined;
    return [...arena.questions.entries()].map(([id, q]) => ({ id, topic: q.topic, openedAt: q.openedAt, weighings: q.history.length, retired: q.retired, ...(q.verdict !== undefined ? { verdict: q.verdict } : {}) }));
  }

  /**
   * 第四轮：终结一个问题（冻结支持度与历史——竞技场不自动收敛，
   * 终结是显式决定；终结后 weighEvidence → undefined）。
   * @returns 问题存在且未终结 → true；否则 false
   */
  retireQuestion(questionId: string, verdict?: string): boolean {
    const arena = this.hypothesisArena;
    const question = arena?.questions.get(questionId);
    if (!arena || !question || question.retired) return false;
    question.retired = true;
    question.verdict = verdict;
    return true;
  }

  // ─────────────────── 第四轮·R4-4 事件因果链账本（世界状态变化回放） ───────────────────

  /**
   * 第四轮：挂载事件因果链账本（幂等覆盖——重挂清空事件序列）。
   *
   * 观测信念层的每次状态变化都落一条事件：谁（source）在何时（timestamp）
   * 对哪个键（key）做了什么（write/reject/conflict/resolve/forget）、
   * 事件时的全局版本号、前后值。事件进有界环形缓冲，可按键 / 时段 /
   * 种类过滤回放（完整因果链：写入 → 印证 → 冲突 → 裁决 → 遗忘）。
   * 未挂载零介入：回放 → undefined。
   */
  attachEventJournal(options?: { capacity?: number; clock?: () => number }): void {
    this.eventJournal = { capacity: Math.max(1, Math.floor(options?.capacity ?? 1000)), clock: options?.clock ?? Date.now, events: [], nextSeq: 1, emitted: 0, kindCounts: new Map() };
  }

  /** 第四轮：事件账本状态（未挂载 undefined） */
  private eventJournal?: {
    capacity: number;
    clock: () => number;
    events: WorldJournalEvent[];
    nextSeq: number;
    emitted: number;
    kindCounts: Map<string, number>;
  };

  /** 事件落账（挂载账本才生效；环形缓冲超容量淘汰最旧，seq 全局单调不重置） */
  private journalEmit(kind: WorldJournalKind, key: string, source: string, version: number, detail: WorldJournalEvent['detail'], timestamp?: number): void {
    const journal = this.eventJournal;
    if (!journal) return;
    journal.events.push({ seq: journal.nextSeq, timestamp: timestamp ?? journal.clock(), kind, key, source, version, detail });
    journal.nextSeq += 1;
    journal.emitted += 1;
    journal.kindCounts.set(kind, (journal.kindCounts.get(kind) ?? 0) + 1);
    if (journal.events.length > journal.capacity) journal.events.splice(0, journal.events.length - journal.capacity);
  }

  /**
   * 第四轮：回放事件因果链（按 seq 升序）。
   * @param filter 全部条件 AND：keys（键集合）/ from,to（时间闭区间）/ kinds
   * @returns 事件数组（浅拷贝；无匹配 → 空数组）；未挂载 → undefined
   */
  replayJournal(filter?: JournalFilter): WorldJournalEvent[] | undefined {
    const journal = this.eventJournal;
    if (!journal) return undefined;
    const keyset = filter?.keys ? new Set(filter.keys) : undefined;
    const kinds = filter?.kinds ? new Set(filter.kinds) : undefined;
    return journal.events
      .filter((e) => (!keyset || keyset.has(e.key)) && (filter?.from === undefined || e.timestamp >= filter.from) && (filter?.to === undefined || e.timestamp <= filter.to) && (!kinds || kinds.has(e.kind)))
      .map((e) => ({ ...e, detail: { ...e.detail } }));
  }

  /** 第四轮：账本统计（事件数 / 容量 / 累计落账 / 按种类计数——含已被环淘汰的） */
  journalStats(): { events: number; capacity: number; emitted: number; kinds: Record<string, number> } | undefined {
    const journal = this.eventJournal;
    if (!journal) return undefined;
    return { events: journal.events.length, capacity: journal.capacity, emitted: journal.emitted, kinds: Object.fromEntries([...journal.kindCounts.entries()].sort()) };
  }

  /**
   * 83.0：挂载世界模型学习透镜（幂等覆盖，挂载即生效——旁路咨询口径）。
   *
   * 调度轨迹离散化为 (状态, 动作, 奖励) 回合 → learnModel 学 T̂/r̂ →
   * valueIteration 出策略与 V 表，bellmanResidual 作模型-策略联合健康度。
   * 与 77.0 互补（因果学结构方向，本内核学转移动态）；T̂ 亦可作为 84.0
   * POMDP 的转移输入（模型 → 信念规划）。纯读数（零漂移）。
   */
  attachModelLearning(options?: { prior?: number }): void {
    this.modelLearningLens = { prior: options?.prior ?? 2 };
  }

  /** 83.0：世界模型学习透镜配置（未挂载 undefined） */
  private modelLearningLens?: { prior: number };

  /** 83.0：转移动态自学读数（未挂载 / 素材不足时 undefined） */
  modelLearningAudit(mdp: TabularMDP, episodes: ReadonlyArray<MdlEpisode>): ModelLearningView | undefined {
    return this.modelLearningLens ? modelLearningView(mdp, episodes, { prior: this.modelLearningLens.prior }) : undefined;
  }

  /** 42.0：谱季节因子（显著周期时数值；不显著 / 样本不足 → undefined 回退） */
  private spectralFactorOf(entry: ArrivalStats, targetTimestamp: number): number | undefined {
    const bins = this.spectralCalendar?.bins ?? 128;
    if (entry.timestamps.length < 16) return undefined;
    const hourMs = 3_600_000;
    const newest = entry.timestamps[entry.timestamps.length - 1];
    const baseHour = Math.floor(newest / hourMs);
    const counts = new Array<number>(bins).fill(0);
    let firstCovered = -1;
    for (const t of entry.timestamps) {
      const hourIndex = Math.floor(t / hourMs) - (baseHour - bins + 1);
      if (hourIndex >= 0 && hourIndex < bins) {
        counts[hourIndex] += 1;
        if (firstCovered < 0 || hourIndex < firstCovered) firstCovered = hourIndex;
      }
    }
    if (firstCovered < 0) return undefined;
    // 裁剪到覆盖段（前导零空洞会注入伪低频能量）
    const covered = counts.slice(firstCovered);
    const phase = ((Math.floor(targetTimestamp / hourMs) - (baseHour - bins + 1) - firstCovered) % covered.length + covered.length) % covered.length;
    const seasonal = seasonalFactor(covered, phase);
    this.lastSpectral = {
      bins,
      samples: entry.timestamps.length,
      significant: seasonal.significant,
      periodHours: seasonal.period,
    };
    return seasonal.significant ? seasonal.factor : undefined;
  }

  /** 42.0：谱日历状态（纯读取；未挂载/未评估时 undefined） */
  getSpectralCalendarStatus(): { bins: number; samples: number; significant: boolean; periodHours: number | undefined } | undefined {
    return this.lastSpectral ? { ...this.lastSpectral } : undefined;
  }

  private lastSpectral?: { bins: number; samples: number; significant: boolean; periodHours: number | undefined };

  private hourFactor(entry: ArrivalStats, targetTimestamp: number): number {
    const total = entry.hourHistogram.reduce((a, b) => a + b, 0);
    if (total === 0) return 1;    const hour = new Date(targetTimestamp).getHours();
    const mean = total / 24;
    if (mean === 0) return 1;
    // 限制因子范围，避免冷启动时段过度放大
    return Math.max(0.5, Math.min(2, entry.hourHistogram[hour] / mean));
  }

  /** 趋势方向（由斜率判定） */
  private trendOf(entry: ArrivalStats, now: number): 'rising' | 'falling' | 'stable' {
    const slope = this.slopeOf(entry, now);
    if (slope > this.config.risingSlopeThreshold) return 'rising';
    if (slope < -this.config.risingSlopeThreshold) return 'falling';
    return 'stable';
  }

  /** 到达率线性回归斜率（每分钟到达数 / 分钟） */
  private slopeOf(entry: ArrivalStats, now: number): number {
    const windowMs = 10 * 60_000;
    const recent = entry.timestamps.filter((t) => t >= now - windowMs);
    if (recent.length < this.config.minSamplesForTrend) return 0;
    // 将窗口切成两半，比较前后半的到达率
    const mid = now - windowMs / 2;
    const firstHalf = recent.filter((t) => t < mid).length;
    const secondHalf = recent.filter((t) => t >= mid).length;
    const halfMinutes = windowMs / 2 / 60_000;
    return (secondHalf - firstHalf) / halfMinutes / halfMinutes;
  }

  /** 共现计数：两序列中时间邻近的配对数 */
  private countCoOccurrences(a: number[], b: number[]): number {
    let count = 0;
    let j = 0;
    for (let i = 0; i < a.length; i += 1) {
      while (j < b.length && b[j] < a[i] - this.config.coOccurrenceWindowMs) j += 1;
      for (let k = j; k < b.length && b[k] <= a[i] + this.config.coOccurrenceWindowMs; k += 1) {
        count += 1;
      }
    }
    return count;
  }

  /** 预测置信度（由该类型历史校准误差驱动） */
  private calibrationConfidence(type: string): number {
    const records = this.calibrations.filter((c) => c.type === type);
    if (records.length === 0) return 0.5; // 无校准数据时中等置信
    const mae = records.reduce((sum, c) => sum + c.error, 0) / records.length;
    if (mae > this.config.calibrationErrorThreshold) return 0.3;
    return Math.max(0.4, Math.min(0.95, 1 - mae / (this.config.calibrationErrorThreshold * 2)));
  }

  /** 最近一次预测窗口（用于对账，简化为固定 5 分钟） */
  private get lastHorizonMs(): number {
    return 5 * 60_000;
  }
}
