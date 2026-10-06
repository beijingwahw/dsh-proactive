/**
 * autonomy25.ts — 第二轮创世纪进化（76.0→100.0，25 个新内核）的全链路接线适配层
 *
 * 职责：把引擎的真实数据结构转换成各内核的输入口径（纯函数 / 自包含小
 * 对象，零引擎依赖、零 I/O、同输入同输出）。各引擎（sentinel / world-model /
 * reflection-engine / reflector / decision-engine / task-executor / policy-evolver /
 * sandbox / strategy-evolution / curiosity / long-term-memory / benchmark /
 * autonomy-loop / self-model）以 attachXxx() 挂载点消费本层——缺省全部关闭
 * （不 attach 即零介入，行为与升级前逐位一致——零漂移是本仓库的宪法）。
 *
 * 适配纪律（与第一轮 genesis25.ts 完全同款）：
 * - 内核的数学不动：本层只做「引擎数据 → 内核输入」的翻译与遥测估计；
 * - 遥测缺位时的估计常数全部显式缺省 + 可配置覆盖，并在 JSDoc 标明口径；
 * - 挂载边界遵循各内核文件尾「接线建议」块的零介入承诺；
 * - 引擎侧挂载一律「只读观测 / 门控分支 / 独立旁路」，不重写引擎逻辑。
 */

import {
  AdaptiveReferenceWindow,
  calibrateThreshold,
  CUSUMDetector,
  DEFAULT_ADAPTIVE_WINDOW_CONFIG,
  type AdaptiveNoveltyRead,
  type AdaptiveWindowConfig,
  type CUSUMRead,
} from '../core/novelty-detection.js';
import {
  pcAlgorithm,
  cpdagSummary,
  type MixedGraph,
  type PcResult,
} from '../core/causal-discovery.js';
import { cca, ridgeCCA, type CcaResult } from '../core/canonical-correlation.js';
import {
  diffusionMaps,
  type DiffusionMapsOptions,
  type DiffusionMapsResult,
} from '../core/diffusion-maps.js';
import {
  CountMinSketch,
  ExponentialHistogram,
  ReservoirSampler,
  misraGries,
  verifySketches,
} from '../core/streaming-sketch.js';
import {
  argumentFramework,
  groundedExtension,
  acceptance,
  EXTENSION_SEMANTICS,
  MAX_ENUM_ARGUMENTS,
  type AcceptanceResult,
  type ArgumentFramework,
  type ExtensionSemantics,
  type GroundedResult,
} from '../core/argumentation.js';
import {
  dawidSkene,
  estimateAccuracy,
  majorityVote,
  weightedMajority,
  type CrowdsourcedLabels,
  type DawidSkeneResult,
} from '../core/crowd-aggregation.js';
import {
  learnModel,
  valueIteration,
  bellmanResidual,
  greedyActions,
  type Episode as MdlEpisode,
  type LearnedModel,
  type TabularMDP,
  type VIResult,
} from '../core/world-model-learning.js';
import {
  alphaVectorVI,
  beliefValue,
  greedyActionAt,
  qmdp,
  type AlphaVIResult,
  type POMDP,
} from '../core/pomdp-planning.js';
import {
  dpllSolve,
  countModels,
  type Cnf,
  type SolveResult,
} from '../core/symbolic-solver.js';
import {
  corridorGridworld,
  hallwayOptions,
  primitiveOptions,
  optionBellmanResidual,
  smokeTestPolicy,
  solveSmdpExact,
  type Option,
  type SmdpExactSolution,
  type SmokeTestResult,
} from '../core/options-framework.js';
import { cbfFilter, type BarrierSpec, type CbfResult } from '../core/safety-barrier.js';
import {
  drEstimate,
  drPerEpisode,
  empiricalBernsteinCI,
  naiveMean,
  wis,
  type DiscretePolicy,
  type Episode as OpeEpisode,
  type EmpiricalBernsteinCI,
  type QModel,
} from '../core/off-policy-evaluation.js';
import {
  safePolicyImprove,
  concentrationCurve,
  type ConcentrationPoint,
  type SafeImproveResult,
} from '../core/safe-policy-improvement.js';
import {
  bradleyTerryMLE,
  btGoodnessOfFit,
  rankByUtility,
  transitivityCheck,
  type BTFitResult,
  type BTGoodnessOfFitReport,
  type PreferencePair,
  type TransitivityReport,
  type UtilityRank,
} from '../core/preference-learning.js';
import { noveltyScore as kernelNoveltyScore } from '../core/novelty-search.js';
import {
  exploitability,
  leaguePlay,
  matrixGame,
  type ExploitabilityReport,
  type LeagueResult,
} from '../core/self-play.js';
import {
  hyperband,
  type ConfigSource,
  type HyperbandOptions,
  type HyperbandResult,
} from '../core/automl-hyperband.js';
import {
  calibrateSim,
  energyDistance,
  mmd2,
  reweightedStatistic,
  type CalibrationReport,
} from '../core/simulation-calibration.js';
import {
  handoffPolicy,
  takeoverThreshold,
  type HandoffAction,
  type TakeoverPolicy,
} from '../core/interruptible-autonomy.js';
import {
  GlobalWorkspace,
  DEFAULT_GLOBAL_WORKSPACE,
  defaultPriority,
  type BidInput,
  type BroadcastState,
  type GlobalWorkspaceOptions,
  type StepResult,
  type WorkspaceContext,
  type WorkspaceModule,
  type WorkspaceSignal,
} from '../core/global-workspace.js';
import {
  confidenceAccuracyCurve,
  metaDprime,
  shouldAsk,
  typeOneDprime,
  type AskCostModel,
  type ConfidenceAccuracyReport,
  type ConfidenceOutcomePair,
  type ShouldAskResult,
} from '../core/metacognitive-confidence.js';
import {
  PrioritizedReplay,
  WeightedBanditLearner,
  sleepConsolidation,
  type ReplayTransition,
  type SleepResult,
} from '../core/experience-replay.js';
import {
  allocateAttention,
  concavityCheck,
  type AttentionAllocation,
  type AttentionSource,
  type ConcavityReport,
} from '../core/attention-economy.js';
// 引擎侧便捷 re-export（Sentinel / WorldModel 等挂载方直接从本层导入口径类型）
export type { AttentionSource } from '../core/attention-economy.js';
export type { TabularMDP, Episode as MdlEpisode } from '../core/world-model-learning.js';
export type { POMDP } from '../core/pomdp-planning.js';
export type { CrowdsourcedLabels } from '../core/crowd-aggregation.js';
export type { DiscretePolicy, Episode as OpeEpisode, QModel } from '../core/off-policy-evaluation.js';
export type { CbfResult } from '../core/safety-barrier.js';
export type { SleepResult, ReplayTransition } from '../core/experience-replay.js';
export type { StepResult as GwtStepResult, WorkspaceSignal } from '../core/global-workspace.js';
export type { IdentityContinuity } from '../core/self-boundary.js';
import {
  detectAgency,
  identityContinuity,
  type AgencyDetection,
  type IdentityContinuity,
} from '../core/self-boundary.js';

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

// ─────────────────────────── 76.0 新奇检测：Sentinel 信号异常识别适配 ───────────────────────────

/** 哨兵侧信号特征（引擎数据 → 76.0 特征向量的原料；口径见 SentinelNoveltyMonitor.featureVector） */
export interface SignalNoveltyFeatures {
  /** 信号类型键（逐类型一个参考窗） */
  type: string;
  /** 紧急度 0~1（缺省 0.5） */
  urgency: number;
  /** 描述长度（字符） */
  descriptionLength: number;
  /** 窗口内被合并次数 */
  occurrences: number;
}

/**
 * 哨兵新奇监视器（76.0 内核适配）：每类信号流一个自适应参考窗
 * （AdaptiveReferenceWindow），observe() 即「异常 = 没见过」的双证据判读
 * （Mahalanobis 门控 + kNN 计数比）；新奇分序列另以 CUSUM 做系统性变点
 * 监测（「世界开始出现更多没见过的东西」比单点异常更早预警）。
 *
 * 特征向量口径（显式缺省、确定性、零 I/O）：
 *   x = [ clamp01(urgency), log1p(len)/8, log1p(occurrences), hash(type)/32 ]
 * ——紧急度归一、长度/次数对数压缩（重尾稳定）、类型 32 桶 FNV 散列。
 * 只读观测：不改变哨兵任何聚合 / 去重 / 交付路径（零漂移）。
 */
export class SentinelNoveltyMonitor {
  private readonly windowConfig: Partial<AdaptiveWindowConfig>;
  private readonly windows = new Map<string, AdaptiveReferenceWindow>();
  /** 各类型最近一次观测读数（未入窗的新奇样本也能被 view 报告） */
  private readonly lastReadByType = new Map<string, AdaptiveNoveltyRead>();
  private readonly noveltyScores: number[] = [];
  private readonly changeAlpha: number;
  private lastChangeRead: CUSUMRead | undefined;

  constructor(options?: {
    /** 各类型参考窗配置覆盖（容量/半衰期/门控水平等，缺省 = 内核缺省） */
    window?: Partial<AdaptiveWindowConfig>;
    /** 新奇分序列变点检验的误报率（缺省 0.01） */
    changeAlpha?: number;
  }) {
    this.windowConfig = options?.window ?? {};
    this.changeAlpha = options?.changeAlpha ?? 0.01;
  }

  /** FNV-1a 32 桶类型散列（确定性——同类型同向量） */
  private static typeHash(type: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < type.length; i += 1) {
      h ^= type.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % 32;
  }

  /** 信号特征 → 4 维特征向量（口径见类注释） */
  static featureVector(f: SignalNoveltyFeatures): number[] {
    return [
      clamp01(Number.isFinite(f.urgency) ? f.urgency : 0.5),
      Math.log1p(Math.max(0, f.descriptionLength)) / 8,
      Math.log1p(Math.max(1, f.occurrences)),
      SentinelNoveltyMonitor.typeHash(f.type) / 32,
    ];
  }

  /** 观测一次信号（挂载时由 ingest 调用；暖机期/未挂载不影响任何路径） */
  observe(features: SignalNoveltyFeatures): AdaptiveNoveltyRead | undefined {
    let win = this.windows.get(features.type);
    if (!win) {
      win = new AdaptiveReferenceWindow({ ...DEFAULT_ADAPTIVE_WINDOW_CONFIG, ...this.windowConfig });
      this.windows.set(features.type, win);
    }
    const read = win.observe(SentinelNoveltyMonitor.featureVector(features));
    this.lastReadByType.set(features.type, read);
    // 新奇分 = 双证据最强者（kNN 保形计数比 / χ² 每自由度比的代理口径）
    if (!read.warmup) {
      const knnScore = read.knn ? 1 - clamp01(read.knn.pValue) : 0;
      const ratio = read.mahalanobis ? read.mahalanobis.chiSquareRatio : NaN;
      const mahScore = Number.isFinite(ratio) ? clamp01((ratio - 1) / 4) : 0;
      this.noveltyScores.push(Math.max(knnScore, mahScore));
      if (this.noveltyScores.length > 1000) this.noveltyScores.shift();
    }
    return read;
  }

  /** 新奇读数（未观测时 undefined） */
  view(): {
    windows: Array<{ type: string; size: number; effectiveSize: number }>;
    recentNovel: Array<{ type: string; novel: boolean }>;
    /** 新奇分序列的 CUSUM 变点（≥10 个基准观测后产出） */
    changePoint?: { h: number; read: CUSUMRead };
  } | undefined {
    if (this.windows.size === 0) return undefined;
    const windows = [...this.windows.entries()].map(([type, w]) => ({
      type,
      size: w.size,
      effectiveSize: w.reference().effectiveSize,
    }));
    const recentNovel: Array<{ type: string; novel: boolean }> = [];
    for (const type of this.windows.keys()) {
      const read = this.lastReadByType.get(type);
      if (read) recentNovel.push({ type, novel: !read.warmup && read.novel });
    }
    let changePoint: { h: number; read: CUSUMRead } | undefined;
    if (this.noveltyScores.length >= 10) {
      try {
        const calib = calibrateThreshold(this.noveltyScores, this.changeAlpha);
        const detector = new CUSUMDetector({ k: calib.k, h: calib.h });
        let read: CUSUMRead | undefined;
        for (const s of this.noveltyScores) read = detector.update(s);
        if (read) {
          this.lastChangeRead = read;
          changePoint = { h: calib.h, read };
        }
      } catch {
        changePoint = undefined; // 校准退化（序列过短/退化）——诚实降级
      }
    }
    return { windows, recentNovel, changePoint };
  }

  /** 最近一次变点读数（只读） */
  get lastChange(): CUSUMRead | undefined {
    return this.lastChangeRead;
  }
}

// ─────────────────────────── 77.0 因果发现：观测学图适配 ───────────────────────────

/** 观测矩阵（列名 + 行样本；n×d，d ≤ 16 —— PC 算法多重检验口径） */
export interface CausalObservationInput {
  columns: string[];
  rows: number[][];
}

/** 因果结构学习读数（77.0 内核的只读口径） */
export interface CausalStructureView {
  result: PcResult;
  /** CPDAG 人读摘要（直接/无向边清单） */
  summary: string;
  /** 有向边 i→j 列表（名字对） */
  directedEdges: Array<{ from: string; to: string }>;
  /** 无向边（数据说不清方向——诚实陈述，接线侧不得替它拍方向） */
  undirectedEdges: Array<{ a: string; b: string }>;
  insight: string;
}

/**
 * 因果结构自学（世界模型侧只读咨询）：观测指标流（模型旋钮 × 任务特征 ×
 * KPI）攒成 n×d 矩阵 → PC 算法学 CPDAG。5.0 causal-kernel 管「已知图做
 * 推断」，本适配管「图从哪来」。alpha 缺省 0.01（n=5000 量级时幂度近乎
 * 1，抑制多重检验假阳性）。不改变世界模型任何登记/预测路径（零漂移）。
 */
export function causalStructureView(
  input: CausalObservationInput,
  options?: { alpha?: number },
): CausalStructureView | undefined {
  if (input.columns.length < 2 || input.rows.length < 10) return undefined;
  if (input.columns.length > 16) return undefined; // 多重检验护栏：d > 16 诚实拒绝
  const result = pcAlgorithm(input.rows, { alpha: options?.alpha ?? 0.01 });
  const summary = cpdagSummary(result.cpdag as MixedGraph);
  const directedEdges: Array<{ from: string; to: string }> = [];
  const undirectedEdges: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < input.columns.length; i += 1) {
    for (let j = 0; j < input.columns.length; j += 1) {
      const cell = result.cpdag[i]?.[j] ?? 0;
      if (i < j && cell === 1 && result.cpdag[j]?.[i] === 1) {
        undirectedEdges.push({ a: input.columns[i]!, b: input.columns[j]! });
      } else if (cell === 2 && result.cpdag[j]?.[i] === 0) {
        directedEdges.push({ from: input.columns[i]!, to: input.columns[j]! });
      }
    }
  }
  const insight = `PC 学图：${directedEdges.length} 条有向边 / ${undirectedEdges.length} 条无向边（${result.nTests} 次条件独立检验，${result.nVStructures} 个 v-结构）——无向边是「数据说不清」的等价类陈述`;
  return { result, summary, directedEdges, undirectedEdges, insight };
}

// ─────────────────────────── 78.0 典型相关：多源证据对齐适配 ───────────────────────────

/** 多源对齐读数（78.0 内核的只读口径） */
export interface SourceAlignmentView {
  cca: CcaResult;
  /** 第一典型相关 ρ₁（两源共享信息的强度） */
  topCorrelation: number;
  /** min(rank) 个全 ≈1 的谱 = 过拟合警报（高维小样本须走岭正则） */
  overfitWarning: boolean;
  insight: string;
}

/**
 * 多源证据对齐（世界模型侧只读咨询）：模型评分面板 X（模型 × 任务特征）×
 * 多源信号特征 Y（信号 × 任务快照）→ CCA 公共潜坐标系。高 ρ 方向 = 共享
 * 因子，低 ρ = 私有噪声；观测少而特征多（早期积累期）一律走 ridgeCCA
 * （λ 缺省 0.5 起步——接线建议 #3 的护栏口径）。零漂移。
 */
export function sourceAlignmentView(
  x: ReadonlyArray<ReadonlyArray<number>>,
  y: ReadonlyArray<ReadonlyArray<number>>,
  options?: { lambda?: number },
): SourceAlignmentView | undefined {
  if (x.length !== y.length || x.length < 3) return undefined;
  const lambda = options?.lambda ?? 0.5;
  try {
    const fit = lambda > 0 ? ridgeCCA(x as number[][], y as number[][], lambda) : cca(x as number[][], y as number[][], {});
    const minRank = Math.min(fit.rankX, fit.rankY);
    const topCorrelation = fit.canonicalCorrelations[0] ?? 0;
    const overfitWarning =
      minRank > 0 && fit.canonicalCorrelations.slice(0, minRank).every((rho) => rho > 0.999) && lambda === 0;
    return {
      cca: fit,
      topCorrelation,
      overfitWarning,
      insight: `多源对齐 ρ₁=${topCorrelation.toFixed(3)}（rank ${fit.rankX}×${fit.rankY}，λ=${fit.l2}）——共享因子方向${overfitWarning ? '〔谱全 ≈1：过拟合警报，改走岭正则〕' : '可作证据融合的公共坐标系'}`,
    };
  } catch {
    return undefined; // 维度退化 / 数值防御——诚实降级
  }
}

// ─────────────────────────── 79.0 扩散映射：经验流形嵌入适配 ───────────────────────────

/** 经验流形读数（79.0 内核的只读口径；与 69.0 Mapper 成对：骨架 + 连续坐标） */
export interface ManifoldEmbeddingView {
  result: DiffusionMapsResult;
  /** 谱隙位置（1 基；2 = 前 2 个 λ≈1 后大跌 → 2 簇行为模式） */
  gapIndex: number;
  nComponents: number;
  insight: string;
}

/**
 * 经验连续嵌入（世界模型侧只读咨询）：经验条目的表示向量（评分面板 /
 * 信号特征 / 78.0 典型变量）→ 扩散映射低维坐标；嵌入欧氏距离 ≈ 扩散
 * 距离 = 流形上的连通难度。缺省自适应带宽（Zelnik–Manor 局部 σᵢ）。
 * 零漂移。
 */
export function manifoldEmbeddingView(
  points: ReadonlyArray<ReadonlyArray<number>>,
  options?: DiffusionMapsOptions & { minPoints?: number },
): ManifoldEmbeddingView | undefined {
  const minPoints = options?.minPoints ?? 12;
  if (points.length < minPoints) return undefined;
  const { minPoints: _drop, ...kernelOptions } = options ?? {};
  try {
    const result = diffusionMaps(points as number[][], kernelOptions);
    return {
      result,
      gapIndex: result.gapIndex,
      nComponents: result.nComponents,
      insight: `经验流形：${result.nComponents} 个连通分量，谱隙@${result.gapIndex}（相对 ${result.spectralGap.toFixed(3)}）——行为模式事件（分量分裂/合并）与嵌入稀疏带定向的坐标系`,
    };
  } catch {
    return undefined; // 数值防御：诚实降级
  }
}

// ─────────────────────────── 80.0 流式概要：哨兵感官缓冲适配 ───────────────────────────

/**
 * 哨兵感官缓冲（80.0 内核适配）：信号入口的键频（CountMinSketch，只高
 * 不低 ε‖a‖₁ 上界）+ 滑窗计数（ExponentialHistogram）+ 等概率抽样
 * （ReservoirSampler，事后取证）+ 重元素（Misra–Gries，100% 捕获保证）。
 * O(百格 + 百桶) 内存常驻，海啸级信号流下关键统计不再被丢弃。与 55.0
 * Hawkes 互补：Hawkes 管强度模型，本缓冲管原始流概要。只读观测零漂移。
 */
export class SignalSketchBuffer {
  private readonly cms: CountMinSketch;
  private readonly histogram: ExponentialHistogram;
  private readonly reservoir: ReservoirSampler<string>;
  private readonly recentKeys: string[] = [];
  private readonly mgCounters: number;

  constructor(options?: { cmsEps?: number; cmsDelta?: number; window?: number; histogramEps?: number; reservoirK?: number; heavyHitters?: number }) {
    this.cms = new CountMinSketch({ eps: options?.cmsEps ?? 0.02, delta: options?.cmsDelta ?? 0.01 });
    this.histogram = new ExponentialHistogram({ eps: options?.histogramEps ?? 0.1, window: options?.window ?? 1000 });
    this.reservoir = new ReservoirSampler<string>(options?.reservoirK ?? 50);
    this.mgCounters = Math.max(1, options?.heavyHitters ?? 9);
  }

  /** 记录一次信号键到达（挂载时由 ingest 调用） */
  observe(key: string): void {
    this.cms.update(key);
    this.histogram.insert(key, true);
    this.reservoir.feed(key);
    this.recentKeys.push(key);
    if (this.recentKeys.length > 2048) this.recentKeys.splice(0, this.recentKeys.length - 2048);
  }

  /** 当前概要读数（重键频上界 / 滑窗计数 / 取样样本 / 重元素） */
  view(): {
    cms: { estimate: (key: string) => number; stats: ReturnType<CountMinSketch['stats']> };
    windowCount: number;
    samples: string[];
    heavyHitters: ReturnType<typeof misraGries<string>>;
  } {
    const heavy = misraGries<string>(this.recentKeys, this.mgCounters);
    return {
      cms: { estimate: (key: string) => this.cms.estimate(key), stats: this.cms.stats() },
      windowCount: this.histogram.windowCount(),
      samples: this.reservoir.sample(),
      heavyHitters: heavy,
    };
  }

  /** 四结构保证自检（verifySketches；allPassed=false 时拒绝发布该概要读数——诚实降级） */
  selfCheck(): { allPassed: boolean } | undefined {
    if (this.recentKeys.length < 10) return undefined;
    try {
      const report = verifySketches({ stream: this.recentKeys });
      return { allPassed: report.allPassed };
    } catch {
      return undefined;
    }
  }
}

// ─────────────────────────── 81.0 论证：深思/反思裁决适配 ───────────────────────────

/** 对抗论证裁决读数（81.0 内核的咨询口径） */
export interface ConflictAdjudicationView {
  grounded: GroundedResult;
  /** 逐论证疑信/轻信接受（缺省 grounded 语义——多项式、必存在、最保守） */
  acceptances: Array<{ argument: string; credulous: boolean; sceptical: boolean }>;
  groundedIds: string[];
  insight: string;
}

/**
 * 冲突裁决（深思/反思引擎侧咨询口径）：辩论收束后的「结论 + 冲突对」
 * 编码为 ArgumentFramework（每结论一条论证、每条「X 推翻 Y」一条攻击
 * 边），groundedExtension 给出无争议辩护链；acceptance 逐结论回答
 * 疑信/轻信接受。攻击图构造可审计（每条边须对应真实反驳记录）。影子
 * 计算——不改变反思/深思主链路（零漂移）。
 */
export function conflictAdjudication(
  conclusions: ReadonlyArray<string>,
  attacks: ReadonlyArray<readonly [number, number]>,
  options?: { semantics?: ExtensionSemantics },
): ConflictAdjudicationView | undefined {
  if (conclusions.length === 0) return undefined;
  if (conclusions.length > MAX_ENUM_ARGUMENTS) return undefined; // 2^n 枚举护栏——先做同侧聚类再入图
  const semantics = options?.semantics ?? 'grounded';
  if (!Object.prototype.hasOwnProperty.call(EXTENSION_SEMANTICS, semantics)) return undefined;
  let af: ArgumentFramework;
  try {
    af = argumentFramework([...conclusions], attacks.map((a) => [a[0], a[1]] as [number, number]));
  } catch {
    return undefined;
  }
  const grounded = groundedExtension(af);
  const acceptances: ConflictAdjudicationView['acceptances'] = [];
  for (let i = 0; i < conclusions.length; i += 1) {
    try {
      const a: AcceptanceResult = acceptance(i, af, semantics);
      acceptances.push({ argument: conclusions[i]!, credulous: a.credulous, sceptical: a.sceptical });
    } catch {
      acceptances.push({ argument: conclusions[i]!, credulous: false, sceptical: false });
    }
  }
  const groundedIds = grounded.extension.map((i) => conclusions[i]!);
  const scepticalCount = acceptances.filter((a) => a.sceptical).length;
  return {
    grounded,
    acceptances,
    groundedIds,
    insight: `grounded 辩护链 ${grounded.extension.length}/${conclusions.length} 条成立（${grounded.iterations} 轮不动点）；${semantics} 语义疑信接受 ${scepticalCount} 条——被拒结论携带致败边（防得住才算数）`,
  };
}

// ─────────────────────────── 82.0 众包聚合：多模型输出聚合适配 ───────────────────────────

/** 众包聚合读数（82.0 内核的咨询口径） */
export interface CrowdVerdictView {
  ds: DawidSkeneResult;
  /** 等权多数票对照（升级前口径） */
  majorityLabels: number[];
  /** 信任票权加权多数票（升级后口径） */
  weightedLabels: number[];
  /** 与多数票不一致的 item 数（EM 学出的信任差量） */
  disagreements: number;
  insight: string;
}

/**
 * 多模型输出聚合（反思器侧咨询口径）：N 个模型对同一判定各自报标签时，
 * dawidSkene 的 truthPosterior 作为聚合判定、workerReliability 作为各
 * 模型信任票权（哪个模型在哪类问题上可信，EM 从记录里自己学出来——
 * 对角塌陷 = 自动摘牌）。可选真值给两口径的正确率对照。影子计算零漂移。
 */
export function crowdVerdict(labels: CrowdsourcedLabels, truth?: ReadonlyArray<number>): CrowdVerdictView | undefined {
  if (labels.workers.length < 2 || labels.labels.length !== labels.workers.length) return undefined;
  try {
    const ds = dawidSkene(labels);
    const majorityLabels = majorityVote(labels);
    const weightedLabels = weightedMajority(labels, ds.workerReliability);
    let disagreements = 0;
    for (let i = 0; i < majorityLabels.length; i += 1) if (majorityLabels[i] !== weightedLabels[i]) disagreements += 1;
    const accuracyNote =
      truth && truth.length === majorityLabels.length
        ? `（正确率：多数票 ${(estimateAccuracy([...truth], majorityLabels) * 100).toFixed(1)}% → 加权 ${(estimateAccuracy([...truth], weightedLabels) * 100).toFixed(1)}%）`
        : '';
    const minReliability = Math.min(...ds.workerReliability);
    return {
      ds,
      majorityLabels,
      weightedLabels,
      disagreements,
      insight: `DS 聚合 ${ds.iterations} 轮 EM：${disagreements} 个 item 与等权多数票分歧${accuracyNote}；最低票权 ${minReliability.toFixed(3)}${minReliability < 0.35 ? '（对角塌陷——该模型自动摘牌）' : ''}`,
    };
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 83.0 世界模型学习：转移动态自学适配 ───────────────────────────

/** 世界模型学习读数（83.0 内核的只读口径） */
export interface ModelLearningView {
  model: LearnedModel;
  vi: VIResult;
  /** Bellman 残差（模型-策略联合健康度：残差大 = 先诊断再动作用） */
  residual: number;
  greedyActions: number[];
  insight: string;
}

/**
 * 转移动态自学（世界模型侧只读咨询）：调度轨迹离散化为 (状态, 动作,
 * 奖励) 回合 → learnModel 学 T̂/r̂（Dirichlet prior = 先验强度旋钮，
 * 冷启动大 α 接近均匀先验）→ valueIteration 出策略与 V 表，
 * bellmanResidual 作联合健康度。与 77.0 互补：因果学结构方向（边），
 * 本适配学转移动态（权重）。零漂移。
 */
export function modelLearningView(
  mdp: TabularMDP,
  episodes: ReadonlyArray<MdlEpisode>,
  options?: { prior?: number },
): ModelLearningView | undefined {
  const totalSteps = episodes.reduce((s, e) => s + e.length, 0);
  if (episodes.length < 2 || totalSteps < 8) return undefined;
  try {
    const model = learnModel(mdp, [...episodes], options?.prior ?? 2);
    const vi = valueIteration(model.T_hat, model.r_hat, mdp.gamma);
    const residual = bellmanResidual(vi.V, model.T_hat, model.r_hat, mdp.gamma);
    const greedy = greedyActions(vi.Q);
    return {
      model,
      vi,
      residual,
      greedyActions: greedy,
      insight: `T̂/r̂ 学成（${totalSteps} 步素材，先验 α=${options?.prior ?? 2}）：V 收敛 ${vi.iterations} 轮，Bellman 残差 ${residual.toExponential(1)}——残差大 = 模型或迭代有问题，先诊断再动作用`,
    };
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 84.0 POMDP：部分可观察规划适配 ───────────────────────────

/** POMDP 咨询读数（84.0 内核的咨询口径） */
export interface PomdpConsultView {
  alphas: AlphaVIResult;
  /** 当前信念下的贪心动作（α-VI 点基下界口径） */
  greedyAction: number;
  actionName: string;
  /** 信念价值下界 V_H(b) */
  beliefValue: number;
  /** QMDP 上界（信息采集不值得精算时的快速筛） */
  qmdpUpper: number;
  /** 信息价值间隙 = 上界 − 下界（大 = 值得继续「听」） */
  infoGap: number;
  insight: string;
}

/**
 * 部分可观察规划咨询（决策引擎侧）：defer/execute/ask-user 在部分可观
 * 察下的开销-价值比较——ask-user = 一次高精度观测动作。α-VI 点基下界 ×
 * QMDP 上界：间隙大于动作成本时信息采集值得精算，间隙小直接贪心。
 * 不改变决策路径（咨询口径零漂移）。
 */
export function pomdpConsult(
  pomdp: POMDP,
  belief: ReadonlyArray<number>,
  options?: { horizon?: number },
): PomdpConsultView | undefined {
  const horizon = Math.max(1, Math.min(12, Math.floor(options?.horizon ?? 4)));
  if (belief.length !== pomdp.states.length) return undefined;
  try {
    const alphas = alphaVectorVI(pomdp, horizon);
    if (alphas.alphas.length === 0) return undefined;
    const b = [...belief];
    const greedyAction = greedyActionAt(alphas.alphas, alphas.actions, b);
    const value = beliefValue(alphas.alphas, b);
    const qmdpResult = qmdp(pomdp);
    const upper = Math.max(...qmdpResult.Q.map((qa) => qa.reduce((s, v, i) => s + v * b[i]!, 0)));
    const infoGap = upper - value;
    return {
      alphas,
      greedyAction,
      actionName: pomdp.actions[greedyAction] ?? String(greedyAction),
      beliefValue: value,
      qmdpUpper: upper,
      infoGap,
      insight: `信念下界 V(b)=${value.toFixed(3)}（α-VI H=${horizon}，|Γ|=${alphas.alphas.length}）× QMDP 上界 ${upper.toFixed(3)}——信息价值间隙 ${infoGap.toFixed(3)}（大 = 「继续听」值钱，ask-user = 一次高精度观测）`,
    };
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 85.0 符号求解：计划可行性静态裁决适配 ───────────────────────────

/** 计划节点（引擎数据 → 85.0 SAT 变元的原料） */
export interface FeasibilityNodeInput {
  id: string;
  /** 前置节点（至少一个被选后继才可选） */
  dependsOn?: string[];
  /** 互斥节点（同槽二选一 → ¬a ∨ ¬b） */
  exclusiveWith?: string[];
}

/** 计划可行性读数（85.0 内核的静态裁决口径） */
export interface PlanFeasibilityView {
  cnf: Cnf;
  solve: SolveResult;
  /** SAT：一个可行资源选择（被选节点 id）；UNSAT：空数组 */
  selectedIds: string[];
  /** 可行选择总数（唯一解 = 脆弱，多解 = 有重排余地；n > 20 时省略） */
  solutionCount?: number;
  feasible: boolean;
  insight: string;
  /**
   * 主动建议（第三轮 A17「被动咨询 → 主动建议」升级：建议 + 理由 + 置信 +
   * 脆弱性——既有字段全部保留，调用方零破坏）。
   */
  advice: {
    recommend: 'proceed' | 'halt';
    reason: string;
    confidence: number;
    fragility: 'rearrangeable' | 'unique-solution' | 'infeasible' | 'unmeasured';
  };
}

/**
 * 计划可行性 CNF 构造（85.0 内核输入口径）：依赖闭包（前置未选则后继
 * 不可选 → (¬a ∨ d₁ ∨ … ∨ dₘ)）、资源互斥（exclusiveWith → (¬a ∨ ¬b)）、
 * 预算容量（至多 k 个并行 → 全部 (k+1)-子集否定子句）、强制节点
 * （mandatory 缺省 = 无后继的汇节点 → 单元子句）。容量子句组合数护栏
 * 2 万——超出诚实拒绝（拆分计划再裁决）。
 */
export function planFeasibilityCnf(
  nodes: ReadonlyArray<FeasibilityNodeInput>,
  options?: { mandatory?: string[]; capacity?: number },
): Cnf | undefined {
  if (nodes.length === 0 || nodes.length > 32) return undefined;
  const index = new Map<string, number>();
  nodes.forEach((n, i) => index.set(n.id, i + 1));
  for (const n of nodes) {
    for (const d of n.dependsOn ?? []) if (!index.has(d)) return undefined;
    for (const e of n.exclusiveWith ?? []) if (!index.has(e)) return undefined;
  }
  const clauses: number[][] = [];
  // ① 依赖闭包：后继选中 ⟹ 至少一个前置被选
  for (const n of nodes) {
    const deps = (n.dependsOn ?? []).map((d) => index.get(d)!);
    if (deps.length > 0) clauses.push([-index.get(n.id)!, ...deps]);
  }
  // ② 资源互斥：¬a ∨ ¬b
  const seenMutex = new Set<string>();
  for (const n of nodes) {
    for (const e of n.exclusiveWith ?? []) {
      const a = index.get(n.id)!;
      const b = index.get(e)!;
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      if (a !== b && !seenMutex.has(key)) {
        seenMutex.add(key);
        clauses.push([-a, -b]);
      }
    }
  }
  // ③ 预算容量：至多 k 个并行 → 全部 (k+1)-子集否定子句
  const capacity = options?.capacity;
  if (capacity !== undefined && capacity >= 0 && capacity < nodes.length) {
    if (capacity < 0) return undefined;
    const combos = binomial(nodes.length, capacity + 1);
    if (combos > 20_000) return undefined; // 组合爆炸护栏——拆分计划
    for (const subset of combinations(nodes.length, capacity + 1)) {
      clauses.push(subset.map((v) => -v));
    }
  }
  // ④ 强制节点：单元子句（缺省 = 汇节点，即无人依赖它的节点）
  const mandatory = new Set(options?.mandatory ?? sinkNodeIds(nodes));
  for (const id of mandatory) {
    const v = index.get(id);
    if (v) clauses.push([v]);
  }
  return { clauses, numVars: nodes.length };
}

function sinkNodeIds(nodes: ReadonlyArray<FeasibilityNodeInput>): string[] {
  const dependedOn = new Set<string>();
  for (const n of nodes) for (const d of n.dependsOn ?? []) dependedOn.add(d);
  return nodes.filter((n) => !dependedOn.has(n.id)).map((n) => n.id);
}

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const current: number[] = [];
  const walk = (start: number): void => {
    if (current.length === k) {
      out.push([...current]);
      return;
    }
    for (let v = start; v <= n - (k - current.length) + 1; v += 1) {
      current.push(v);
      walk(v + 1);
      current.pop();
    }
  };
  walk(1);
  return out;
}

/**
 * 计划可行性静态裁决（任务执行器侧咨询口径）：DAG 计划动手前 dpllSolve
 * 一次裁决——SAT = 可行（模型即一个可行资源选择）；UNSAT = 动手前判死
 * 并返回 decisions/conflicts 账单。countModels 给可行选择总数（唯一解
 * = 脆弱，多解 = 有重排余地）。执行路径不变（咨询口径零漂移）。
 * 第三轮 A17：输出叠加 advice（proceed/halt 建议 + 理由 + 置信 + 脆弱性
 * 分档——唯一解 proceed 但降权提示脆弱；UNSAT halt 且冲突账单越厚越确凿）。
 */
export function planFeasibilityVerdict(
  nodes: ReadonlyArray<FeasibilityNodeInput>,
  options?: { mandatory?: string[]; capacity?: number },
): PlanFeasibilityView | undefined {
  const cnf = planFeasibilityCnf(nodes, options);
  if (!cnf) return undefined;
  try {
    const solve = dpllSolve(cnf);
    const selectedIds: string[] = [];
    if (solve.sat && solve.model) {
      for (let v = 1; v <= cnf.numVars; v += 1) if (solve.model.get(v) === true) selectedIds.push(nodes[v - 1]!.id);
    }
    let solutionCount: number | undefined;
    if (solve.sat && cnf.numVars <= 20) {
      try {
        solutionCount = countModels(cnf);
      } catch {
        solutionCount = undefined;
      }
    }
    const fragility = !solve.sat
      ? 'infeasible'
      : solutionCount === undefined
        ? 'unmeasured'
        : solutionCount === 1
          ? 'unique-solution'
          : 'rearrangeable';
    const confidence = !solve.sat
      ? Math.max(0.8, Math.min(0.98, 0.8 + solve.conflicts / 50))
      : fragility === 'unique-solution'
        ? 0.75
        : fragility === 'rearrangeable'
          ? 0.9
          : 0.85;
    const reason = solve.sat
      ? `建议动手：计划可行（${solve.decisions} 次分支 / ${solve.conflicts} 次冲突${solutionCount !== undefined ? `，${solutionCount} 个可行选择` : ''}）${fragility === 'unique-solution' ? '——唯一解：任何节点失败即全盘重排，建议预留降级路径' : fragility === 'rearrangeable' ? '——多解：有重排余地，失败可局部换道' : ''}`
      : `建议停止：计划不可行（${solve.conflicts} 次冲突、${solve.learned} 条学子句）——动手前判死，冲突账单定位最小冲突任务集，先拆依赖/互斥再重排`;
    return {
      cnf,
      solve,
      selectedIds,
      ...(solutionCount !== undefined ? { solutionCount } : {}),
      feasible: solve.sat,
      insight: solve.sat
        ? `计划可行（${solve.decisions} 次分支 / ${solve.conflicts} 次冲突${solutionCount !== undefined ? `，${solutionCount} 个可行选择${solutionCount === 1 ? '——唯一解 = 脆弱' : '——有重排余地'}` : ''}）`
        : `计划不可行（${solve.conflicts} 次冲突、${solve.learned} 条学子句——动手前判死，冲突账单定位最小冲突任务集）`,
      advice: {
        recommend: solve.sat ? 'proceed' : 'halt',
        reason,
        confidence,
        fragility,
      },
    };
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 86.0 分层技能：SMDP 技能宏体检适配 ───────────────────────────

/** 技能宏组合体检读数（86.0 内核的只读口径） */
export interface OptionsSkillAuditView {
  /** SMDP 精确宏模型（值迭代收敛的 Q* 表） */
  exact: SmdpExactSolution;
  /** 全起态贪婪执行宏 Q 的冒烟报告 */
  smoke: SmokeTestResult;
  /** BFS 最优平均步数（组合效率的分母基准） */
  meanOptimal: number;
  /** 组合效率 = 最优均值 / 贪婪均值（≈ 1 = 技能组合几乎不付组合损耗） */
  compositionEfficiency: number;
  /** option-Bellman 残差（精确解处 ≈ 机器精度——价值表健康度账单） */
  residual: number;
  insight: string;
}

/**
 * 技能宏组合体检（任务执行器侧只读口径）：corridor 走廊世界（技能 =
 * 导航到里程碑——「执行到检查点」类技能的构造模式）上解 SMDP 精确宏
 * 模型（值迭代收敛即 γ^k 时间信用分配的自洽基准）——smokeTestPolicy
 * 从全部非目标起态贪婪执行宏 Q，组合效率 = BFS 最优均值 / 贪婪均值
 * （≈ 1 = 技能组合几乎不付组合损耗）；optionBellmanResidual 是价值表
 * 健康度账单（精确解处 ≈ 机器精度）。全程 < 20ms——执行器技能库沉淀
 * 的例行健康体检。不改执行路径（零漂移）。
 */
export function optionsSkillAudit(
  options?: { rooms?: number; gamma?: number },
): OptionsSkillAuditView | undefined {
  const world = corridorGridworld({ rooms: options?.rooms ?? 4 });
  const gamma = options?.gamma ?? 0.95;
  try {
    const options_: Option[] = [...hallwayOptions(world), ...primitiveOptions(world)];
    const exact = solveSmdpExact({ world, options: options_, gamma, tol: 1e-10 });
    const residual = optionBellmanResidual({ world, options: options_, Q: exact.Q, gamma }).maxResidual;
    const starts = world.states.filter((s) => s !== world.goal);
    const smoke = smokeTestPolicy({ world, options: options_, Q: exact.Q, starts });
    const meanOptimal = starts.reduce((s, st) => s + world.optimalStepsToGoal(st), 0) / starts.length;
    const compositionEfficiency = smoke.meanSteps > 0 ? meanOptimal / smoke.meanSteps : Number.NaN;
    return {
      exact,
      smoke,
      meanOptimal,
      compositionEfficiency,
      residual,
      insight: `技能宏组合体检：宏模型值迭代 ${exact.iterations} 轮收敛，贪婪执行成功率 ${(smoke.successRate * 100).toFixed(1)}%（${starts.length} 起态），平均 ${smoke.meanSteps.toFixed(1)} 步 vs BFS 最优 ${meanOptimal.toFixed(1)}（组合效率 ${compositionEfficiency.toFixed(3)}，option-Bellman 残差 ${residual.toExponential(1)}）——「子计划值得进主计划」的 γ^k 宏口径基准`,
    };
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 87.0 安全屏障：动作微分安全过滤适配 ───────────────────────────

/** 配额态（引擎侧动作屏障化的状态口径） */
export interface QuotaGuardState {
  /** 配额余量（> 0 = 安全） */
  remaining: number;
  /** 当前消耗速率（单位/步） */
  burnRate: number;
  /** 减速容量（速率每步最多降多少——刹车距离的物理口径） */
  decelCapacity: number;
}

/**
 * 配额屏障规格构造（87.0 内核输入口径）：安全裕度
 * h(x) = 余量 − 速率²/(2·减速容量)（消耗要在红线前刹得住——与刹车屏障
 * 同构）；动力学 x' = [余量 − u, u]（u = 落地消耗速率，箱约束即运维
 * 原钳位边界直接复用）。η 旋钮 = 裕度消耗率：关键配额用小 η。
 */
export function quotaBarrierSpec(
  state: QuotaGuardState,
  options?: { uMin?: number; uMax?: number; eta?: number },
): BarrierSpec | undefined {
  const uMax = options?.uMax ?? Math.max(1, state.burnRate * 2);
  const uMin = options?.uMin ?? 0;
  if (!(uMin < uMax) || !(state.decelCapacity > 0)) return undefined;
  const brakeDistance = (rate: number): number => (rate * rate) / (2 * state.decelCapacity);
  return {
    h: (x) => x[0]! - brakeDistance(Math.max(0, x[1]!)),
    dynamics: (x, u) => [x[0]! - u[0]!, u[0]!],
    eta: options?.eta ?? 0.05,
    uMin,
    uMax,
  };
}

/**
 * 动作安全过滤（任务执行器侧咨询口径）：期望动作（消耗速率）先过
 * cbfFilter 再落地——最小安全修改而非静默截断；infeasible = 即便最优
 * 努力仍差 minViolation，须上报安全总督走熔断路径（差 5% 和差 50% 的
 * 处置不同）。缺省关闭时动作走原钳位路径（零漂移）。
 */
export function quotaGuardAction(
  state: QuotaGuardState,
  desiredRate: number,
  options?: { uMin?: number; uMax?: number; eta?: number },
): CbfResult | undefined {
  const spec = quotaBarrierSpec(state, options);
  if (!spec) return undefined;
  try {
    return cbfFilter([state.remaining, state.burnRate], desiredRate, spec);
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 88.0 离线评估：反事实策略估值适配 ───────────────────────────

/** 离线策略评估读数（88.0 内核的咨询口径） */
export interface OfflinePolicyAuditView {
  drEstimate: number;
  ci: EmpiricalBernsteinCI;
  naiveBaseline: number;
  wisEstimate: number;
  episodes: number;
  insight: string;
}

/**
 * 离线策略评估（策略进化沙盒侧咨询口径）：用生产行为策略 μ 的真实轨迹
 * 离线评估候选 π——drEstimate（双重稳健：近似 Q 不破坏无偏性，只影响
 * 方差）+ empiricalBernsteinCI 置信区间，naiveMean / wis 作对照口径。
 * 金丝雀判据升级为「双通道任一 LCB ≤ 0 即不放行」的离线通道。零漂移。
 */
export function offlinePolicyAudit(
  episodes: ReadonlyArray<OpeEpisode>,
  candidate: DiscretePolicy,
  behavior: DiscretePolicy,
  options?: { qModel?: QModel; gamma?: number; delta?: number },
): OfflinePolicyAuditView | undefined {
  if (episodes.length < 2) return undefined;
  const gamma = options?.gamma ?? 1;
  try {
    const est = drEstimate([...episodes], candidate, behavior, options?.qModel, gamma);
    const perEpisode = episodes.map((e) => drPerEpisode(e, candidate, behavior, options?.qModel, gamma));
    const ci = empiricalBernsteinCI(perEpisode, options?.delta ?? 0.05);
    const naive = naiveMean([...episodes], gamma);
    const weighted = wis([...episodes], candidate, behavior, gamma);
    return {
      drEstimate: est,
      ci,
      naiveBaseline: naive,
      wisEstimate: weighted,
      episodes: episodes.length,
      insight: `DR 反事实估值 ${est.toFixed(3)}（EB-CS 95% 区间 [${ci.lower.toFixed(3)}, ${ci.upper.toFixed(3)}]；naive ${naive.toFixed(3)} / WIS ${weighted.toFixed(3)} 对照）——「如果当初换策略」的无偏估计，LCB ≤ 0 不放行`,
    };
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 89.0 安全策略改进：上线安全阀适配 ───────────────────────────

/** 安全改进门控读数（89.0 内核的决策口径） */
export interface SafeImprovementGateView {
  verdict: SafeImproveResult;
  /** 集中率曲线（回答「还差多少样本才能下发证书」） */
  curve: ConcentrationPoint[];
  insight: string;
}

/**
 * 上线安全阀（策略进化器侧咨询口径）：候选晋升从「沙盒跑分高就上」
 * 升级为 safePolicyImprove——逐轨迹配对差 Δ̂ = Ĵ(π_cand) − Ĵ(π_base) 的
 * 高置信下界 LCB > 0 才 accepted（δ = 每次上线决策的错误接受上限）。
 * estimator 注入 88.0 的 drPerEpisode（两内核零 import、调用侧拼装——
 * 内核接线建议的原样实现）。concentrationCurve 给证书门槛样本量预估。
 * 不改变进化器既有晋升路径（咨询口径零漂移）。
 */
export function safeImprovementGate(
  episodes: ReadonlyArray<OpeEpisode>,
  candidate: DiscretePolicy,
  baseline: DiscretePolicy,
  behavior: DiscretePolicy,
  options?: { qModel?: QModel; delta?: number; minSamples?: number; gamma?: number; curveSizes?: number[] },
): SafeImprovementGateView | undefined {
  if (episodes.length < 2) return undefined;
  const gamma = options?.gamma ?? 1;
  try {
    const verdict = safePolicyImprove({
      episodes: [...episodes],
      candidate,
      baseline,
      behavior,
      delta: options?.delta ?? 0.05,
      minSamples: options?.minSamples ?? 30,
      gamma,
      estimator: (episode, target, mu, g) => drPerEpisode(episode, target, mu, options?.qModel, g),
    });
    let curve: ConcentrationPoint[] = [];
    try {
      const diffs = episodes.map(
        (e) => drPerEpisode(e, candidate, behavior, options?.qModel, gamma) - drPerEpisode(e, baseline, behavior, options?.qModel, gamma),
      );
      curve = concentrationCurve(diffs, options?.curveSizes ?? [10, 20, 40, 80, Math.max(12, episodes.length)]);
    } catch {
      curve = [];
    }
    return {
      verdict,
      curve,
      insight: `${verdict.accepted ? '有证书放行' : '拒绝上线'}：Δ̂=${verdict.delta.toFixed(3)}（LCB ${verdict.lcb.toFixed(3)} / UCB ${verdict.ucb.toFixed(3)}，n=${verdict.n}，δ=${verdict.deltaParam}，${verdict.reason}）——统计证书在案才上线`,
    };
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 90.0 偏好学习：RLHF-lite 效用学习适配 ───────────────────────────

/** 偏好学习读数（90.0 内核的影子口径） */
export interface PreferenceLedgerView {
  pairs: number;
  transitivity: TransitivityReport;
  fit?: BTFitResult;
  gof?: BTGoodnessOfFitReport;
  ranking?: UtilityRank[];
  /** 前置体检结论：环路/系统性残差超阈时 B-T 效用不可用于决策排序 */
  usable: boolean;
  insight: string;
}

/**
 * 偏好账本（反思器侧影子学习）：人工/用户反馈从「打分」改录为「偏好对」
 * （哪次输出更好），攒够窗口量后 bradleyTerryMLE 学出效用向量——
 * RLHF-lite：不训练模型权重，只学调度层的价值序。任何偏好数据先过
 * transitivityCheck + btGoodnessOfFit 双信号前置体检——不通过就别拿它
 * 决策排序（按环路组拆分场景或退回 64.0 相关均衡口径）。零漂移。
 */
export class PreferenceLedger {
  private readonly minPairs: number;
  private readonly l2: number;
  private readonly idToIndex = new Map<string, number>();
  private readonly indexToId: string[] = [];
  private readonly pairs: PreferencePair[] = [];

  constructor(options?: { minPairs?: number; l2?: number }) {
    this.minPairs = Math.max(4, Math.floor(options?.minPairs ?? 8));
    this.l2 = options?.l2 ?? 1;
  }

  private indexOf(id: string): number {
    let idx = this.idToIndex.get(id);
    if (idx === undefined) {
      idx = this.indexToId.length;
      this.indexToId.push(id);
      this.idToIndex.set(id, idx);
    }
    return idx;
  }

  /** 回填一次偏好对（挂载时由人工反馈通道调用；winner ≻ loser） */
  note(winnerId: string, loserId: string): void {
    if (winnerId === loserId) return;
    this.pairs.push({ winner: this.indexOf(winnerId), loser: this.indexOf(loserId) });
    if (this.pairs.length > 5000) this.pairs.shift();
  }

  /** 已积累偏好对数（只读） */
  get size(): number {
    return this.pairs.length;
  }

  /** 效用学习读数（样本不足时 undefined；不可传递建模时 usable=false） */
  view(): PreferenceLedgerView | undefined {
    if (this.pairs.length < this.minPairs) return undefined;
    try {
      const transitivity = transitivityCheck(this.pairs);
      let fit: BTFitResult | undefined;
      let gof: BTGoodnessOfFitReport | undefined;
      let ranking: UtilityRank[] | undefined;
      let usable = transitivity.cycles.length === 0;
      if (usable) {
        fit = bradleyTerryMLE(this.pairs, { l2: this.l2 });
        gof = btGoodnessOfFit(this.pairs, fit.utilities);
        usable = gof.fitOk;
        if (usable) ranking = rankByUtility(fit.utilities);
      }
      return {
        pairs: this.pairs.length,
        transitivity,
        fit,
        gof,
        ranking,
        usable,
        insight: usable
          ? `B-T 效用学成（${this.pairs.length} 对，log-loss ${fit ? fit.logLoss.toFixed(3) : '—'} < ln2 瞎猜线）：偏好对是不变的原始证据，指标改版不作废历史`
          : `前置体检未过（${transitivity.cycles.length > 0 ? `${transitivity.cycles.length} 个偏好环路组` : '系统性残差超阈值'}）——B-T 效用不可用于决策排序，按环路组拆分或退回 64.0 相关均衡口径`,
      };
    } catch {
      return undefined;
    }
  }
}

// ─────────────────────────── 91.0 新奇搜索：探索定向适配 ───────────────────────────

/** 新奇定向读数（91.0 内核的只读口径） */
export interface NoveltyDirectionView {
  scores: Array<{ index: number; novelty: number }>;
  /** 新奇分最高的候选下标（向「没人活过的活法」定向采样） */
  argmax: number;
  insight: string;
}

/**
 * 探索新奇定向（好奇心引擎侧只读咨询）：候选方向的预期行为特征喂
 * noveltyScore（对档案的 kNN 距离均值）——novelty 越高分配越多探索
 * 预算（好奇心 = 新奇分的单调函数）。与 76.0 互补：91 在行为空间搜
 * 新奇（生成侧），76 在观测空间判新奇（评价侧）。不改探索派发（零漂移）。
 */
export function noveltyDirectionProbe(
  candidates: ReadonlyArray<ReadonlyArray<number>>,
  archive: ReadonlyArray<ReadonlyArray<number>>,
  options?: { k?: number; minCriterion?: (behavior: ReadonlyArray<number>) => boolean },
): NoveltyDirectionView | undefined {
  if (candidates.length === 0 || archive.length === 0) return undefined;
  const k = Math.max(1, Math.min(options?.k ?? 3, archive.length));
  try {
    const scored = candidates.map((b, index) => ({
      index,
      novelty: kernelNoveltyScore(b as number[], archive as number[][], k),
      feasible: options?.minCriterion ? options.minCriterion(b) : true,
    }));
    const feasible = scored.filter((s) => s.feasible);
    const pool = feasible.length > 0 ? feasible : scored; // 全不可行时只读不推荐（argmax 取首个——MCNS 语义）
    const best = pool.reduce((a, b) => (b.novelty > a.novelty ? b : a));
    return {
      scores: scored.map(({ index, novelty }) => ({ index, novelty })),
      argmax: best.index,
      insight: `新奇定向：候选 ${candidates.length} 个（可行 ${feasible.length}）——最高新奇分 ${best.novelty.toFixed(3)}@#${best.index}${feasible.length === scored.length ? '' : '（MCNS 门槛已滤除不可行候选——不为「新奇但致死」的活法烧预算）'}`,
    };
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 92.0 自我对弈：对抗压力审计适配 ───────────────────────────

/** 对抗压力审计读数（92.0 内核的影子口径） */
export interface AdversarialPressureView {
  exploitability: ExploitabilityReport;
  league?: LeagueResult;
  insight: string;
}

/**
 * 对抗压力审计（策略进化侧影子口径）：把「候选 vs 其余种群」建成零和
 * 矩阵博弈（收益 = 历史交互的期望得分表），exploitability 即该策略的
 * 弱点货币——QD 归档准入从「适应度高」升级为「适应度高 ∧ 难以被针对」；
 * leaguePlay 的 exploiter 池 = 可审计的失败模式档案。不改变进化路径。
 */
export function adversarialPressureAudit(
  payoff: ReadonlyArray<ReadonlyArray<number>>,
  strategy: ReadonlyArray<number>,
  options?: { leagueRounds?: number; seed?: number },
): AdversarialPressureView | undefined {
  const rows = payoff.length;
  if (rows < 2 || payoff.some((r) => r.length !== rows)) return undefined;
  try {
    const game = matrixGame({ name: 'evolution-arena', payoffRow: payoff as number[][], zeroSum: true });
    const uniform: number[] = new Array(rows).fill(1 / rows);
    const expl = exploitability(game, strategy.length === rows ? strategy : uniform, uniform);
    let league: LeagueResult | undefined;
    const rounds = Math.max(0, Math.min(400, Math.floor(options?.leagueRounds ?? 60)));
    if (rounds > 0) league = leaguePlay(game, { rounds, seed: options?.seed });
    const final = league ? league.finalExploitability : expl.total;
    return {
      exploitability: expl,
      league,
      insight: `可剥削度 ${expl.total.toFixed(3)}（p₁ 偏离净赚 ${expl.p1Gain.toFixed(3)}）${league ? `，联赛 ${rounds} 轮后 main 平均策略收敛到 ${final.toFixed(3)}——「这代比上代更难被针对了吗」第一次有数值答案` : ''}`,
    };
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 93.0 AutoML Hyperband：配置自动寻优适配 ───────────────────────────

/**
 * Hyperband 配置寻优（基准引擎侧咨询口径）：连续配置空间 × 可提前终止
 * 的全预算曲线（与 73.0 BAI 分工：BAI 选离散臂一次性全量评估，本内核
 * 管超参曲线）。evaluate(config, budget) 须确定性且分数随 budget 单调
 * 不减（学习曲线族天然满足）——适配层不代答，由调用方注入。纯转发 +
 * 预算审计汇总。零漂移。
 */
export function hyperbandTune<T>(
  configs: ConfigSource<T>,
  evaluate: (config: T, budget: number) => number,
  options?: { eta?: number; maxBudget: number; seed?: number },
): HyperbandResult<T> | undefined {
  if (!options || !(options.maxBudget >= 1)) return undefined;
  try {
    return hyperband({
      configs,
      evaluate,
      maxBudget: options.maxBudget,
      eta: options?.eta ?? 3,
      seed: options?.seed ?? 1,
    });
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 94.0 仿真校准：沙盒风洞修正适配 ───────────────────────────

/** 风洞修正读数（94.0 内核的只读口径） */
export interface WindTunnelView {
  mmd2: number;
  energy: number;
  calibration: CalibrationReport;
  /** 沙盒均值经密度比换算的真实口径均值（sim-to-real 桥） */
  realisticMean: number;
  simMean: number;
  insight: string;
}

/**
 * 沙盒风洞修正（策略进化沙盒侧只读咨询）：沙盒评估的质量分序列与操作
 * 环真实质量分构成两样本——mmd2/energyDistance 量化「模拟器此刻失真
 * 多少」，密度比 r̂ 把沙盒统计换算真实口径（真实口径增益 ≈ 再加权统计）。
 * ESS/n 低（重度再加权）时任何换算都不可信——报告 warnings 提示回退
 * 保守门禁。上线判据的离线通道素材（与 88.0 合成换算链）。零漂移。
 */
export function windTunnelAudit(
  simScores: ReadonlyArray<number>,
  realScores: ReadonlyArray<number>,
): WindTunnelView | undefined {
  if (simScores.length < 4 || realScores.length < 4) return undefined;
  try {
    const sim = [...simScores];
    const real = [...realScores];
    const gap = mmd2(sim, real);
    const energy = energyDistance(sim, real);
    const calibration = calibrateSim(sim, real);
    const simMean = sim.reduce((s, v) => s + v, 0) / sim.length;
    const realisticMean = reweightedStatistic(sim, (x) => calibration.ratios[sim.indexOf(x)] ?? 1, (x) => x);
    const essWarning = calibration.essFraction < 0.2 ? '〔ESS/n 低：沙盒对真实尾部几乎无覆盖，换算不可信——回退保守门禁〕' : '';
    return {
      mmd2: gap,
      energy,
      calibration,
      realisticMean,
      simMean,
      insight: `风洞失真 MMD²=${gap.toFixed(4)}（能量距离 ${energy.toFixed(4)}），密度比换算后 gap 缩减 ${(calibration.reduction * 100).toFixed(1)}%——沙盒均值 ${simMean.toFixed(3)} → 真实口径 ${realisticMean.toFixed(3)}${essWarning}`,
    };
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 95.0 中断交接：ask-user 期望成本最优适配 ───────────────────────────

/** 交接咨询入参（97.0 元认知信心 + 84.0 信念价值口径的成本合龙） */
export interface HandoffConsultInput {
  /** 失败概率（97.0 元认知信心校准后的口径） */
  pError: number;
  /** 任务失败代价（84.0 信念价值口径） */
  costAuto: number;
  /** ask-user 的打扰成本 + 用户响应延迟 */
  costHuman: number;
  /** 每次接管的延迟成本（缺省 0） */
  delayCost?: number;
}

/** 交接咨询读数（95.0 内核的闭式口径） */
export interface HandoffAdviceView {
  policy: TakeoverPolicy;
  action: HandoffAction;
  /** 期望自动成本分数 x = p·c_auto（与 τ* 的比较量） */
  expectedAutoCost: number;
  threshold: number;
  insight: string;
  /**
   * 主动建议（第三轮 A17「被动咨询 → 主动建议」升级：建议 + 成本分解 +
   * 置信——既有字段全部保留，调用方零破坏）。
   */
  advice: {
    recommend: 'ask-user' | 'execute';
    reason: string;
    confidence: number;
    /** 成本分解（建议的数值依据） */
    costBreakdown: {
      /** 自动执行的期望损失 x = p·c_auto */
      expectedAutoCost: number;
      /** 打扰用户的全成本 τ* = c_H + c_delay */
      handoffFullCost: number;
      /** x − τ*（正 = 求助更省） */
      margin: number;
      /** 选优方案的期望节省 = |x − τ*| */
      expectedSaving: number;
    };
  };
}

/**
 * ask-user 交接裁决（决策引擎侧咨询口径）：「何时求助」从经验阈值升级
 * 为期望成本最优——takeoverThreshold 给出闭式 τ* = c_H + c_delay，对
 * 期望自动成本分数 x = p·c_auto 应用 handoffPolicy（x > τ* → human）。
 * ask-user 的数学 = 84.0 信念价值 + 97.0 元认知信心 + 95.0 交接成本。
 * 不改变决策路径（零漂移）。第三轮 A17：输出叠加 advice（建议 + 成本
 * 分解 + 置信——相对边际 |x−τ*|/τ* 越大，裁决越确凿）。
 */
export function askUserHandoffAdvice(input: HandoffConsultInput): HandoffAdviceView | undefined {
  if (!(input.pError >= 0 && input.pError <= 1) || !(input.costAuto > 0) || !(input.costHuman >= 0)) return undefined;
  try {
    const policy = takeoverThreshold({
      pError: () => input.pError,
      costAuto: () => input.costAuto,
      costHuman: input.costHuman,
      delayCost: input.delayCost ?? 0,
    }, [0]);
    const x = input.pError * input.costAuto;
    const action = handoffPolicy(x, policy.threshold);
    const margin = x - policy.threshold;
    const relMargin = Math.abs(margin) / Math.max(1e-9, policy.threshold);
    const confidence = Math.max(0, Math.min(1, 0.55 + Math.min(0.45, relMargin)));
    const reason = action === 'human'
      ? `建议 ask-user：自动执行的期望损失 x=${x.toFixed(2)}（p=${input.pError.toFixed(2)} × c_auto=${input.costAuto.toFixed(2)}）已超过打扰用户的全成本 τ*=${policy.threshold.toFixed(2)}（c_H=${input.costHuman.toFixed(2)} + c_delay=${(input.delayCost ?? 0).toFixed(2)}），求助期望省 ${Math.abs(margin).toFixed(2)}`
      : `建议自动执行：期望损失 x=${x.toFixed(2)} 低于打扰成本 τ*=${policy.threshold.toFixed(2)}（差 ${Math.abs(margin).toFixed(2)}）——为低风险任务打扰用户反而更贵`;
    return {
      policy,
      action,
      expectedAutoCost: x,
      threshold: policy.threshold,
      insight: `x = p·c_auto = ${x.toFixed(2)} vs τ* = ${policy.threshold.toFixed(2)} → ${action === 'human' ? 'ask-user（期望成本最优：自动错误的代价已超过打扰用户的全成本）' : 'execute（自动执行仍是最优——别为低风险任务打扰用户）'}`,
      advice: {
        recommend: action === 'human' ? 'ask-user' : 'execute',
        reason,
        confidence,
        costBreakdown: {
          expectedAutoCost: Number(x.toFixed(3)),
          handoffFullCost: Number(policy.threshold.toFixed(3)),
          margin: Number(margin.toFixed(3)),
          expectedSaving: Number(Math.abs(margin).toFixed(3)),
        },
      },
    };
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 96.0 全局工作空间：跨引擎意识总线适配 ───────────────────────────

/** 引擎投标者规格（各引擎包装为 WorkspaceModule 的原料——纯函数注入） */
export interface EngineBidderSpec {
  id: string;
  /** 投标分解（novelty×relevance×confidence×urgency；缺省经 defaultPriority 合成） */
  bid: (ctx: { signals: string[]; goal: string | undefined }) => BidInput;
  /** 内容标签（异常爆发 / 策略突破 / 预算告警……） */
  describe?: (ctx: { signals: string[]; goal: string | undefined }) => string[];
  /** 广播订阅（其它模块点火时被调用——级联传播的确定性副作用） */
  onBroadcast?: (content: { sourceId: string; tags: string[]; step: number }) => void;
}

/**
 * 跨引擎意识总线（自主心跳侧旁路口径）：Sentinel/决策/反思/进化/共生
 * 各自包装为 WorkspaceModule，每拍 step({signals, goal}) 投标竞争——
 * 胜者内容广播全员（「此刻全员该知道什么」由竞争仲裁，不再由代码调用
 * 顺序决定）。与 99.0 互补：96 管单步焦点，99 管持续预算。旁路挂载，
 * 不改心跳任何阶段（零漂移）。
 */
export class ConsciousnessBus {
  private readonly ws: GlobalWorkspace;
  private readonly history: StepResult[] = [];
  private readonly winCounts = new Map<string, number>();

  constructor(bidders: ReadonlyArray<EngineBidderSpec>, options?: Omit<GlobalWorkspaceOptions, 'modules' | 'priorityFn'> & { priorityFn?: (b: BidInput) => number }) {
    const modules: WorkspaceModule[] = bidders.map((b) => {
      const describe = b.describe;
      const onBroadcast = b.onBroadcast;
      return {
        id: b.id,
        priorityFn: (ctx: WorkspaceContext, _broadcast: BroadcastState): BidInput =>
          b.bid({ signals: ctx.signals, goal: ctx.goal }),
        describe: describe ? (ctx: WorkspaceContext) => describe({ signals: ctx.signals, goal: ctx.goal }) : undefined,
        onBroadcast: onBroadcast
          ? (content: { sourceId: string; tags: string[]; step: number }) => {
              onBroadcast({ sourceId: content.sourceId, tags: [...content.tags], step: content.step });
            }
          : undefined,
      };
    });
    this.ws = new GlobalWorkspace({
      modules,
      threshold: options?.threshold ?? DEFAULT_GLOBAL_WORKSPACE.threshold,
      temperature: options?.temperature ?? DEFAULT_GLOBAL_WORKSPACE.temperature,
      refractory: options?.refractory ?? DEFAULT_GLOBAL_WORKSPACE.refractory,
      refractoryFactor: options?.refractoryFactor ?? DEFAULT_GLOBAL_WORKSPACE.refractoryFactor,
      priorityFn: options?.priorityFn ?? defaultPriority,
      seed: options?.seed,
    });
  }

  /** 心跳一拍（挂载时由心跳循环仲裁点调用；未挂载零介入） */
  step(signal?: WorkspaceSignal): StepResult {
    const result = this.ws.step(signal);
    this.history.push(result);
    if (this.history.length > 500) this.history.shift();
    if (result.winner) this.winCounts.set(result.winner, (this.winCounts.get(result.winner) ?? 0) + 1);
    return result;
  }

  /** 意识总线读数（点火率 = 意识负荷 KPI；胜者分布熵监控垄断） */
  view(): {
    steps: number;
    ignitionRatio: number;
    winCounts: Array<{ id: string; wins: number }>;
    lastBroadcast?: { sourceId: string; tags: string[]; effectiveBid: number };
    entropy: number;
  } {
    const wins = [...this.winCounts.entries()].map(([id, wins]) => ({ id, wins }));
    const total = wins.reduce((s, w) => s + w.wins, 0);
    const entropy = total > 0 ? -wins.reduce((s, w) => {
      const p = w.wins / total;
      return s + (p > 0 ? p * Math.log2(p) : 0);
    }, 0) : 0;
    const last = this.history[this.history.length - 1];
    return {
      steps: this.history.length,
      ignitionRatio: this.ws.igniteRatio(),
      winCounts: wins.sort((a, b) => b.wins - a.wins),
      lastBroadcast: last?.broadcast
        ? { sourceId: last.broadcast.sourceId, tags: [...last.broadcast.tags], effectiveBid: last.broadcast.effectiveBid }
        : undefined,
      entropy,
    };
  }
}

// ─────────────────────────── 97.0 元认知信心：求助触发与信心校准审计适配 ───────────────────────────

/**
 * 元认知信心账本（决策引擎侧只读口径）：每批决策回填 (confidence,
 * correct) 对——confidenceAccuracyCurve 出「哪一档信心在撒谎」，
 * metaDprime 对照 typeOneDprime 出元认知效率 M-ratio = meta-d′/d′
 * （M-ratio 低 → 信心不可信 → 求助策略退化为任务难度先验的保守口径）。
 * 零漂移。
 */
export class MetacognitionLedger {
  private readonly pairs: ConfidenceOutcomePair[] = [];

  /** 回填一次 (信心, 对错) 对（挂载时由决策反馈通道调用） */
  note(confidence: number, correct: boolean): void {
    if (!(confidence >= 0 && confidence <= 1)) return;
    this.pairs.push({ confidence, correct });
    if (this.pairs.length > 2000) this.pairs.shift();
  }

  /** 已积累对数（只读） */
  get size(): number {
    return this.pairs.length;
  }

  /** 元认知效率读数（正确/错误两侧样本齐备时产出） */
  view(): {
    curve: ConfidenceAccuracyReport;
    metaDprime: number;
    typeOneDprime: number;
    mRatio: number;
    insight: string;
  } | undefined {
    if (this.pairs.length < 8) return undefined;
    const correct = this.pairs.filter((p) => p.correct).map((p) => p.confidence);
    const wrong = this.pairs.filter((p) => !p.correct).map((p) => p.confidence);
    if (correct.length === 0 || wrong.length === 0) return undefined;
    try {
      const curve = confidenceAccuracyCurve(this.pairs);
      const meta = metaDprime(correct, wrong);
      const hits = this.pairs.filter((p) => p.correct && p.confidence >= 0.5).length;
      const fa = this.pairs.filter((p) => !p.correct && p.confidence >= 0.5).length;
      const t1 = typeOneDprime(hits, fa, correct.length, wrong.length);
      const mRatio = t1.dprime > 0 ? meta.metaDprime / t1.dprime : Number.NaN;
      return {
        curve,
        metaDprime: meta.metaDprime,
        typeOneDprime: t1.dprime,
        mRatio,
        insight: `元认知效率 M-ratio = ${Number.isFinite(mRatio) ? mRatio.toFixed(3) : '—'}（meta-d′ ${meta.metaDprime.toFixed(3)} / d′ ${t1.dprime.toFixed(3)}）${Number.isFinite(mRatio) && mRatio < 0.6 ? '——信心不可信，求助策略退化为任务难度先验的保守口径' : '——「知道自己不知道」的量化口径'}`,
      };
    } catch {
      return undefined;
    }
  }
}

/**
 * 求助决策咨询（97.0 内核 shouldAsk 的闭式转发）：模型输出自评信心 →
 * shouldAsk(c, {costError, costAsk, priorError})——只有后验错误率越过
 * 闭式阈值的低信心试验才触发求助（过度自信与过度自卑都被成本模型拉回）。
 */
export function shouldAskAdvice(confidence: number, model: AskCostModel): ShouldAskResult | undefined {
  if (!(confidence >= 0 && confidence <= 1)) return undefined;
  try {
    return shouldAsk(confidence, model);
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 98.0 经验重放：睡眠固化适配 ───────────────────────────

/**
 * 经验重放固化器（长期记忆侧旁路口径）：白天操作环经验逐条 push 进
 * PrioritizedReplay（分层配额——旧技能不被新洪峰覆盖），夜间（心跳睡眠
 * 阶段）sleepConsolidation 只重放不采新、IS 加权消化——improvement 即
 * 「这一觉值不值」的量化汇报。旁路挂载，不改记忆任何读写路径（零漂移）。
 */
export class ReplayConsolidator {
  readonly buffer: PrioritizedReplay;

  constructor(options?: { capacity?: number; alpha?: number; beta?: number; seed?: number }) {
    this.buffer = new PrioritizedReplay({
      capacity: Math.max(2, Math.floor(options?.capacity ?? 512)),
      alpha: options?.alpha ?? 0.6,
      beta: options?.beta ?? 0.4,
      seed: options?.seed ?? 1,
    });
  }

  /** 记一条经验（挂载时由执行反馈通道调用；tdError = 预测误差口径） */
  push(transition: ReplayTransition): void {
    this.buffer.push(transition);
  }

  /** 分层配额读数（每任务域存活样本 + 公平配额——灾难遗忘的存储侧防线） */
  stats(): ReturnType<PrioritizedReplay['stats']> {
    return this.buffer.stats();
  }

  /** 睡眠固化（只重放不采新；truth = 逐臂真值的解析测量，供数方注入） */
  consolidate(truth: ReadonlyArray<number>, options?: { rounds?: number; batchSize?: number; beta?: number }): SleepResult | undefined {
    if (truth.length < 1 || this.buffer.size() < 4) return undefined;
    try {
      const learner = new WeightedBanditLearner(truth.length);
      return sleepConsolidation({
        buffer: this.buffer,
        learner,
        truth: [...truth],
        rounds: Math.max(1, Math.floor(options?.rounds ?? 5)),
        batchSize: options?.batchSize,
        beta: options?.beta,
      });
    } catch {
      return undefined;
    }
  }
}

// ─────────────────────────── 99.0 注意力经济：信息流拍卖适配 ───────────────────────────

/** 注意力拍卖读数（99.0 内核的影子口径） */
export interface AttentionAuctionView {
  allocation: AttentionAllocation;
  concavity: ConcavityReport;
  /** 边际价格 = 最末胜出槽位的边际值（信息饥渴的影子价格） */
  marginalPrice: number;
  winners: string[];
  insight: string;
}

/**
 * 注意力拍卖（哨兵→优化器信息流的影子口径）：各信息源自报 EVSI 式边际
 * 价值（凹性由 concavityCheck 巡检，违规源临时摘牌），k 个深看槽位跑
 * allocateAttention（贪心 = 穷举最优；VCG 支付 = 挤占的他人机会成本，
 * 谎报无利可图）。marginalPrice 高 = 信息饥渴窗口（认知负荷指标）。
 * 不改变信号交付顺序（零漂移）。
 */
export function attentionAuction(
  sources: ReadonlyArray<AttentionSource>,
  slots: number,
): AttentionAuctionView | undefined {
  if (sources.length === 0 || slots <= 0) return undefined;
  try {
    const allocation = allocateAttention(sources as AttentionSource[], Math.floor(slots));
    const concavity = concavityCheck(sources as AttentionSource[], Math.max(1, Math.floor(slots)));
    const lastAward = allocation.awards[allocation.awards.length - 1];
    const marginalPrice = lastAward ? lastAward.marginal : 0;
    const winners = [...new Set(allocation.awards.map((a) => a.sourceId))];
    return {
      allocation,
      concavity,
      marginalPrice,
      winners,
      insight: `${slots} 槽深看出清：${winners.join(' / ') || '（无正边际源）'}，边际价格 ${marginalPrice.toFixed(3)}${marginalPrice > 0.5 ? '（高价窗口 = 信息饥渴——认知负荷上报）' : ''}${concavity.violations.length > 0 ? `〔${concavity.violations.length} 个源凹性违规——临时摘牌〕` : ''}`,
    };
  } catch {
    return undefined;
  }
}

// ─────────────────────────── 100.0 自我边界：归因边界与身份断点适配 ───────────────────────────

/** 归因边界读数（100.0 内核的影子口径） */
export interface AgencyAttributionView {
  detection: AgencyDetection;
  selfCausedChannels: number[];
  insight: string;
}

/**
 * 能动性归因（自我模型侧影子口径）：编排层把每个决策周期的「自身动作
 * 流」（模型切换/调参/进化部署事件序列）与「信号通道」（成功率/延迟/
 * token 消耗遥测）喂 detectAgency——自致通道的改进记入功绩，非自致通道
 * 的波动不揽功（防把环境红利记成自我进步）；已知共因（任务难度/时段
 * 负载）作为 confounders 注入。不改变心智报告既有字段（零漂移）。
 */
export function agencyAttribution(
  actions: ReadonlyArray<number>,
  signals: ReadonlyArray<ReadonlyArray<number>>,
  options?: { confounders?: ReadonlyArray<ReadonlyArray<number>>; seed?: number; shuffles?: number },
): AgencyAttributionView | undefined {
  if (actions.length < 32 || signals.length === 0 || signals.some((ch) => ch.length !== actions.length)) return undefined;
  try {
    const detection = detectAgency({
      actions: [...actions],
      signals: signals.map((ch) => [...ch]),
      confounders: options?.confounders?.map((c) => [...c]),
      seed: options?.seed,
      shuffles: options?.shuffles ?? 120,
    });
    const selfCausedChannels = detection.channels.map((ch, i) => (ch.selfCaused ? i : -1)).filter((i) => i >= 0);
    return {
      detection,
      selfCausedChannels,
      insight: `能动性归因：${selfCausedChannels.length}/${signals.length} 个通道自致（最大 z=${detection.score.toFixed(1)}）——自致通道的改进记功绩，非自致通道的波动不揽功（防把环境红利记成自我进步）`,
    };
  } catch {
    return undefined;
  }
}

/**
 * 身份连续性审计（策略部署侧影子口径）：policy-evolver 部署新策略版本
 * 时，前后参数向量 + 行为探针集跑 identityContinuity——breakAlarm =
 * 不是渐进学习而是身份突变（按最高风险处置，联动金丝雀回滚判据）。
 * score 可写入心智报告的 evolverEfficiency 视图。不改变部署路径。
 */
export function identityContinuityScore(
  before: ReadonlyArray<number>,
  after: ReadonlyArray<number>,
  options?: {
    behaviorTests?: ReadonlyArray<{ probe: ReadonlyArray<number>; run: (parameters: ReadonlyArray<number>, probe: ReadonlyArray<number>) => number }>;
    breakThreshold?: number;
  },
): IdentityContinuity | undefined {
  if (before.length !== after.length || before.length === 0) return undefined;
  try {
    return identityContinuity({ parameters: [...before] }, { parameters: [...after] }, {
      behaviorTests: options?.behaviorTests?.map((t) => ({ probe: [...t.probe], run: t.run })),
      breakThreshold: options?.breakThreshold,
    });
  } catch {
    return undefined;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 第四轮 R4-A17：模块域升级接线适配层（autonomy.modules.* 命名空间）
// ═══════════════════════════════════════════════════════════════════
// 职责：把第三/四轮各模块域的 attach 式 / 构造配置式升级收敛为统一开关
// 命名空间（风格与 autonomy.kernels.* 一致），全部缺省关闭——不挂载 /
// 不注入即零介入，引擎行为与升级前逐位一致（零漂移是本仓库的宪法）。
// 本层只做「旗标 → 挂载调用 / 配置片段」的翻译：
// - attachPostConstructModuleUpgrades()：引擎构造后可挂载的升级（方法挂载面）；
// - xxxModuleUpgradeConfig()：构造时注入的升级（配置片段面——须在引擎
//   构造点展开，缺省返回 {} 即逐位不变）；
// - MODULE_FLAGS / moduleFlagOverview()：16 旗标静态清单与开关态总览
//   （introspect.moduleFlags 口径，与 kernelFlags 同款）。

/** 模块域升级旗标（autonomy.modules.* 全部缺省关闭；仅显式 enabled === true 才生效） */
export interface ModuleUpgradeFlags {
  /** sentinel：自适应聚合窗口 v2（三态强度驱动）+ 风暴预算共享（全局风暴期令牌桶联动收紧）——构造配置注入 */
  sentinelAdaptive?: { enabled?: boolean };
  /** decision：决策滞后（抖动抑制换向带）+ 批量联合决策（同型合并共担 strategist）——attachDecisionHysteresis / attachBatchJointDecider */
  decisionHysteresisJoint?: {
    enabled?: boolean;
    /** 滞后换向带：进入高紧急度（缺省 0.65） */
    enterHigh?: number;
    /** 滞后换向带：退出低紧急度（缺省 0.45） */
    exitLow?: number;
    /** 换向最短驻留 ms（缺省 30_000） */
    minDwellMs?: number;
    /** 批量联合：合并成本比（缺省引擎缺省） */
    mergeCostRatio?: number;
  };
  /** scheduler：健康感知路由（EWMA + 熔断器三态 + 半开探活）——attachHealthRouting */
  schedulerHealthRouting?: {
    enabled?: boolean;
    /** 连续失败跳闸阈（缺省 3） */
    failureThreshold?: number;
    /** EWMA 错误率跳闸阈（缺省 0.6） */
    errorThreshold?: number;
    /** EWMA 平滑系数（缺省 0.3） */
    ewmaAlpha?: number;
    /** 半开冷却 ms（缺省 5_000） */
    halfOpenAfterMs?: number;
  };
  /** scheduler：冷启动准入协议（影子→金丝雀→毕业三阶段）+ 周期预热——attachAdmissionProtocol / attachPrewarm */
  schedulerColdStart?: {
    enabled?: boolean;
    /** 影子期最少观察数（缺省 5） */
    shadowMinSamples?: number;
    /** 影子→金丝雀质量门（缺省 0.5） */
    shadowQualityGate?: number;
    /** 金丝雀→毕业质量门（缺省 0.6） */
    canaryQualityGate?: number;
    /** 金丝雀小流量比例（缺省 0.2） */
    canaryShare?: number;
  };
  /** executor：并行度自适应（同层派发批宽随成功率/失败率调节）——attachAdaptiveParallelism */
  executorAdaptiveParallelism?: { enabled?: boolean };
  /** executor：失败域隔离（按 (model,taskType) 细粒度熔断）——attachFailureDomains */
  executorFailureDomains?: {
    enabled?: boolean;
    /** 失败域熔断阈（缺省 2） */
    failureThreshold?: number;
    /** 熔断冷却 ms（缺省 60_000） */
    cooldownMs?: number;
  };
  /** memory：分层存储（热/温/冷三级 + 新近度价值分）+ 检索仲裁（证据量×新鲜度×置信度三因子）——attachTieredStorage / attachArbiter */
  memoryTieredArbitration?: {
    enabled?: boolean;
    /** 热层容量（缺省 64） */
    hotCapacity?: number;
    /** 温层容量（缺省 256） */
    warmCapacity?: number;
    /** 冷层容量（缺省 1024） */
    coldCapacity?: number;
  };
  /** meta：调参死区稳定环（噪声不动 / 斜坡渐进 / 判定冷却）——MetaController 构造配置注入 */
  metaStabilityLoop?: {
    enabled?: boolean;
    /** 死区半宽（归一化偏离单位；缺省 0.25） */
    deadbandDeviation?: number;
    /** 斜坡起点步长因子（缺省 0.5） */
    rampStart?: number;
    /** 判定后冷却报告数（缺省 1） */
    cooldownReports?: number;
  };
  /** policy：AB 分支进化（challenger 分流 → 双侧证书裁决 → 晋升/淘汰）——attachABBranching */
  policyABBranching?: {
    enabled?: boolean;
    /** challenger 流量比例（缺省 0.2） */
    challengerTraffic?: number;
    /** 双侧最少分流样本数（缺省 8） */
    minSamples?: number;
    /** 晋升最小成功率优势（缺省 0.05） */
    promoteMargin?: number;
    /** 淘汰最小劣化（缺省 0.05） */
    retireMargin?: number;
  };
  /** world：多源观察信念融合（快照环 + 真冲突检测 + 强度比推翻）——attachObservationFusion */
  worldObservationFusion?: {
    enabled?: boolean;
    /** 快照环深度（缺省 24） */
    snapshotDepth?: number;
    /** 真冲突信念强度下限（缺省 0.35） */
    conflictThreshold?: number;
    /** 推翻既有所需强度比（缺省 1.2） */
    overwriteMargin?: number;
  };
  /** symbiosis：货币治理（流通量目标带铸币税调节）+ 条件结算（托管三路结算）——运行时配置注入 + attachConditionalSettlement */
  symbiosisEconomy?: {
    enabled?: boolean;
    /** 流通量目标（能量，缺省 200） */
    targetCirculating?: number;
    /** 目标带半宽比例（缺省 0.1） */
    bandTolerance?: number;
    /** 带内基础铸币税率（缺省 0） */
    baseTaxRate?: number;
  };
  /** crypto：密钥分级（low/medium/high 三级轮换与算法强度）——CryptoEngine 构造配置注入 */
  cryptoTieredKeys?: {
    enabled?: boolean;
    /** 错级处置：alert（放行+告警记账，缺省）/ reject（结构化拒绝） */
    onViolation?: 'alert' | 'reject';
  };
  /** tenant：配额预测性调整（EWMA 水平 + 最小二乘斜率外推预警）——configureQuotaForecast */
  tenantQuotaForecast?: {
    enabled?: boolean;
    /** EWMA 平滑系数（缺省 0.3） */
    alpha?: number;
    /** 用量聚合桶宽 ms（缺省 60_000） */
    intervalMs?: number;
    /** 斜率估计窗口桶数（缺省 12） */
    slopeWindow?: number;
    /** 预测时域 ms（缺省 3_600_000） */
    horizonMs?: number;
    /** 预警线：外推用量/配额（缺省 0.8） */
    warnFactor?: number;
  };
  /** client：请求优先级队列（并发上限下高优先先出 + 抢占继承）——LLMClient 构造配置注入 */
  clientPriorityQueue?: {
    enabled?: boolean;
    /** 缺省排队超时 ms（缺省 30_000） */
    defaultQueueTimeoutMs?: number;
  };
  /** benchmark：长期趋势追踪（Theil–Sen 斜率 + Mann–Kendall 显著性）——attachTrendTracker */
  benchmarkTrendTracker?: {
    enabled?: boolean;
    /** 滚动窗容量（缺省 20） */
    windowSize?: number;
    /** 显著性 α（缺省 0.05） */
    alpha?: number;
  };
  /** dashboard：统一告警源接线（安全总督 / 元认知熔断 → /api/alarm-feed）——attachDashboard 第三参注入 */
  dashboardAlarmSources?: { enabled?: boolean };
}

/** 单个 modules.* 旗标的静态元数据 */
export interface ModuleFlagMeta {
  /** 旗标名（modules 命名空间的键） */
  name: keyof ModuleUpgradeFlags;
  /** 目标模块（引擎文件口径） */
  module: string;
  /** 升级轮次（3 = 第三轮模块域；4 = 第四轮模块域） */
  wave: 3 | 4;
  /** 挂载面（attach 方法 / 构造配置注入点） */
  entry: string;
}

/** 旗标开关态（元数据 + 运行时 enabled） */
export interface ModuleFlagState extends ModuleFlagMeta {
  enabled: boolean;
}

/** 模块旗标总览（introspect 导出口径，与 kernelFlags 同款） */
export interface ModuleFlagOverview {
  total: number;
  enabled: number;
  disabled: number;
  flags: ModuleFlagState[];
}

/** modules.* 命名空间 16 旗标静态清单（与 ModuleUpgradeFlags 一一对应） */
export const MODULE_FLAGS: ReadonlyArray<ModuleFlagMeta> = [
  { name: 'sentinelAdaptive', module: 'sentinel', wave: 3, entry: 'ctor: adaptiveWindow + stormBudget' },
  { name: 'decisionHysteresisJoint', module: 'decision-engine', wave: 4, entry: 'attachDecisionHysteresis + attachBatchJointDecider' },
  { name: 'schedulerHealthRouting', module: 'model-scheduler', wave: 3, entry: 'attachHealthRouting' },
  { name: 'schedulerColdStart', module: 'model-scheduler', wave: 4, entry: 'attachAdmissionProtocol + attachPrewarm' },
  { name: 'executorAdaptiveParallelism', module: 'task-executor', wave: 4, entry: 'attachAdaptiveParallelism' },
  { name: 'executorFailureDomains', module: 'task-executor', wave: 4, entry: 'attachFailureDomains' },
  { name: 'memoryTieredArbitration', module: 'long-term-memory', wave: 3, entry: 'attachTieredStorage + attachArbiter' },
  { name: 'metaStabilityLoop', module: 'meta-controller', wave: 4, entry: 'ctor: stabilityLoop' },
  { name: 'policyABBranching', module: 'policy-evolver', wave: 4, entry: 'attachABBranching' },
  { name: 'worldObservationFusion', module: 'world-model', wave: 4, entry: 'attachObservationFusion' },
  { name: 'symbiosisEconomy', module: 'symbiosis', wave: 4, entry: 'ctor: monetaryPolicy + attachConditionalSettlement' },
  { name: 'cryptoTieredKeys', module: 'crypto-engine', wave: 4, entry: 'ctor: tiered' },
  { name: 'tenantQuotaForecast', module: 'tenant-manager', wave: 4, entry: 'configureQuotaForecast' },
  { name: 'clientPriorityQueue', module: 'llm-client', wave: 4, entry: 'ctor: priorityQueue' },
  { name: 'benchmarkTrendTracker', module: 'benchmark', wave: 4, entry: 'attachTrendTracker' },
  { name: 'dashboardAlarmSources', module: 'dashboard', wave: 4, entry: 'attachDashboard: sources.getAlarms' },
];

/** 模块旗标总览（16 旗标开关态；enabled 仅在显式 === true 时为真——缺省关闭） */
export function moduleFlagOverview(flags?: ModuleUpgradeFlags): ModuleFlagOverview {
  const records = (flags ?? {}) as Record<string, { enabled?: boolean }>;
  const states = MODULE_FLAGS.map((meta) => ({ ...meta, enabled: records[meta.name]?.enabled === true }));
  const enabled = states.filter((f) => f.enabled).length;
  return { total: states.length, enabled, disabled: states.length - enabled, flags: states };
}

// ─────────────────── 构造配置注入片段（缺省 {} —— 逐位不变） ───────────────────

/** sentinel 构造升级片段：adaptiveWindow v2 + stormBudget（旗标关时 {} 零注入） */
export function sentinelModuleUpgradeConfig(flags: ModuleUpgradeFlags): {
  adaptiveWindow?: Record<string, number>;
  stormBudget?: Record<string, number>;
} {
  if (flags.sentinelAdaptive?.enabled !== true) return {};
  return {
    adaptiveWindow: {},
    stormBudget: {},
  };
}

/** LLMClient 构造升级片段：priorityQueue（旗标关时 {} 零注入） */
export function clientModuleUpgradeConfig(flags: ModuleUpgradeFlags): {
  priorityQueue?: { defaultQueueTimeoutMs?: number };
} {
  if (flags.clientPriorityQueue?.enabled !== true) return {};
  const fragment: { priorityQueue: { defaultQueueTimeoutMs?: number } } = { priorityQueue: {} };
  if (flags.clientPriorityQueue.defaultQueueTimeoutMs !== undefined) {
    fragment.priorityQueue.defaultQueueTimeoutMs = flags.clientPriorityQueue.defaultQueueTimeoutMs;
  }
  return fragment;
}

/** CryptoEngine 构造升级片段：tiered 三级密钥（旗标关时 {} 零注入） */
export function cryptoModuleUpgradeConfig(flags: ModuleUpgradeFlags): {
  tiered?: {
    tiers: Record<'low' | 'medium' | 'high', { rotateAfterMs: number; algorithm?: 'aes-256-gcm' | 'aes-256-cbc' }>;
    onViolation?: 'alert' | 'reject';
  };
} {
  if (flags.cryptoTieredKeys?.enabled !== true) return {};
  return {
    tiered: {
      // 三级轮换周期缺省：low 7 天 / medium 1 天 / high 6 小时（敏感级轮换更快）
      tiers: {
        low: { rotateAfterMs: 7 * 24 * 3600_000, algorithm: 'aes-256-cbc' },
        medium: { rotateAfterMs: 24 * 3600_000, algorithm: 'aes-256-gcm' },
        high: { rotateAfterMs: 6 * 3600_000, algorithm: 'aes-256-gcm' },
      },
      ...(flags.cryptoTieredKeys.onViolation !== undefined ? { onViolation: flags.cryptoTieredKeys.onViolation } : {}),
    },
  };
}

/** SymbiosisRuntime 构造升级片段：monetaryPolicy 流通量目标带（旗标关时 {} 零注入） */
export function symbiosisMonetaryUpgradeConfig(flags: ModuleUpgradeFlags): {
  monetaryPolicy?: {
    targetCirculating: number;
    bandTolerance?: number;
    baseTaxRate?: number;
  };
} {
  if (flags.symbiosisEconomy?.enabled !== true) return {};
  return {
    monetaryPolicy: {
      targetCirculating: flags.symbiosisEconomy.targetCirculating ?? 200,
      ...(flags.symbiosisEconomy.bandTolerance !== undefined ? { bandTolerance: flags.symbiosisEconomy.bandTolerance } : {}),
      ...(flags.symbiosisEconomy.baseTaxRate !== undefined ? { baseTaxRate: flags.symbiosisEconomy.baseTaxRate } : {}),
    },
  };
}

/** MetaCognitiveController 构造升级片段：stabilityLoop 死区稳定环（旗标关时 {} 零注入） */
export function metaStabilityUpgradeConfig(flags: ModuleUpgradeFlags): {
  stabilityLoop?: {
    deadbandDeviation?: number;
    rampStart?: number;
    rampIncrement?: number;
    cooldownReports?: number;
  };
} {
  if (flags.metaStabilityLoop?.enabled !== true) return {};
  const f = flags.metaStabilityLoop;
  return {
    stabilityLoop: {
      ...(f.deadbandDeviation !== undefined ? { deadbandDeviation: f.deadbandDeviation } : {}),
      ...(f.rampStart !== undefined ? { rampStart: f.rampStart } : {}),
      ...(f.cooldownReports !== undefined ? { cooldownReports: f.cooldownReports } : {}),
    },
  };
}

// ─────────────────── 构造后挂载面（attachXxx 调用收敛于此） ───────────────────

/**
 * 构造后挂载目标（结构化最小消费面——各引擎只需暴露对应 attach 方法；
 * 全部可选：缺席的引擎其旗标自动跳过）。
 */
export interface ModuleUpgradeTargets {
  decisionEngine?: {
    attachDecisionHysteresis(options?: { enterHigh?: number; exitLow?: number; minDwellMs?: number }): void;
    attachBatchJointDecider(options?: { mergeCostRatio?: number }): void;
  };
  modelScheduler?: {
    attachHealthRouting(options?: { failureThreshold?: number; errorThreshold?: number; ewmaAlpha?: number; halfOpenAfterMs?: number }): void;
    attachAdmissionProtocol(options?: { shadowMinSamples?: number; shadowQualityGate?: number; canaryQualityGate?: number; canaryShare?: number }): void;
    attachPrewarm(options?: Record<string, number>): void;
  };
  taskExecutor?: {
    attachAdaptiveParallelism(options?: Record<string, number>): void;
    attachFailureDomains(options?: { failureThreshold?: number; cooldownMs?: number }): void;
  };
  memory?: {
    attachTieredStorage(options?: { hotCapacity?: number; warmCapacity?: number; coldCapacity?: number }): void;
    attachArbiter(options?: Record<string, unknown>): void;
  };
  policyEvolver?: {
    attachABBranching(options?: { challengerTraffic?: number; minSamples?: number; promoteMargin?: number; retireMargin?: number }): void;
  };
  worldModel?: {
    attachObservationFusion(options?: { snapshotDepth?: number; conflictThreshold?: number; overwriteMargin?: number }): void;
  };
  symbiosisBridge?: {
    attachConditionalSettlement(): void;
  };
  tenantManager?: {
    configureQuotaForecast(config: {
      alpha: number;
      intervalMs: number;
      slopeWindow: number;
      horizonMs: number;
      warnFactor: number;
    }): void;
  };
  benchmark?: {
    attachTrendTracker(options?: { windowSize?: number; alpha?: number }): void;
  };
}

/**
 * 按旗标挂载构造后升级（集中挂载点——apply() 引擎构造后、清理前调用一次）。
 *
 * 纪律：旗标关（或缺省）→ 对应 attach 不调用（引擎读数 undefined，零漂移）；
 * 旗标开 → attach 生效并返回挂载名清单（logger 汇总）。幂等口径与各引擎
 * attachXxx 的「全新挂载」语义一致。
 *
 * @returns 挂载成功的旗标名清单（按 MODULE_FLAGS 声明序）
 */
export function attachPostConstructModuleUpgrades(targets: ModuleUpgradeTargets, flags: ModuleUpgradeFlags): string[] {
  const attached: string[] = [];
  const f = flags;
  if (f.decisionHysteresisJoint?.enabled === true && targets.decisionEngine) {
    const d = f.decisionHysteresisJoint;
    targets.decisionEngine.attachDecisionHysteresis({
      ...(d.enterHigh !== undefined ? { enterHigh: d.enterHigh } : {}),
      ...(d.exitLow !== undefined ? { exitLow: d.exitLow } : {}),
      ...(d.minDwellMs !== undefined ? { minDwellMs: d.minDwellMs } : {}),
    });
    targets.decisionEngine.attachBatchJointDecider(
      d.mergeCostRatio !== undefined ? { mergeCostRatio: d.mergeCostRatio } : undefined,
    );
    attached.push('decisionHysteresisJoint');
  }
  if (f.schedulerHealthRouting?.enabled === true && targets.modelScheduler) {
    const s = f.schedulerHealthRouting;
    targets.modelScheduler.attachHealthRouting({
      ...(s.failureThreshold !== undefined ? { failureThreshold: s.failureThreshold } : {}),
      ...(s.errorThreshold !== undefined ? { errorThreshold: s.errorThreshold } : {}),
      ...(s.ewmaAlpha !== undefined ? { ewmaAlpha: s.ewmaAlpha } : {}),
      ...(s.halfOpenAfterMs !== undefined ? { halfOpenAfterMs: s.halfOpenAfterMs } : {}),
    });
    attached.push('schedulerHealthRouting');
  }
  if (f.schedulerColdStart?.enabled === true && targets.modelScheduler) {
    const s = f.schedulerColdStart;
    targets.modelScheduler.attachAdmissionProtocol({
      ...(s.shadowMinSamples !== undefined ? { shadowMinSamples: s.shadowMinSamples } : {}),
      ...(s.shadowQualityGate !== undefined ? { shadowQualityGate: s.shadowQualityGate } : {}),
      ...(s.canaryQualityGate !== undefined ? { canaryQualityGate: s.canaryQualityGate } : {}),
      ...(s.canaryShare !== undefined ? { canaryShare: s.canaryShare } : {}),
    });
    targets.modelScheduler.attachPrewarm();
    attached.push('schedulerColdStart');
  }
  if (f.executorAdaptiveParallelism?.enabled === true && targets.taskExecutor) {
    targets.taskExecutor.attachAdaptiveParallelism();
    attached.push('executorAdaptiveParallelism');
  }
  if (f.executorFailureDomains?.enabled === true && targets.taskExecutor) {
    const e = f.executorFailureDomains;
    targets.taskExecutor.attachFailureDomains({
      ...(e.failureThreshold !== undefined ? { failureThreshold: e.failureThreshold } : {}),
      ...(e.cooldownMs !== undefined ? { cooldownMs: e.cooldownMs } : {}),
    });
    attached.push('executorFailureDomains');
  }
  if (f.memoryTieredArbitration?.enabled === true && targets.memory) {
    const m = f.memoryTieredArbitration;
    targets.memory.attachTieredStorage({
      ...(m.hotCapacity !== undefined ? { hotCapacity: m.hotCapacity } : {}),
      ...(m.warmCapacity !== undefined ? { warmCapacity: m.warmCapacity } : {}),
      ...(m.coldCapacity !== undefined ? { coldCapacity: m.coldCapacity } : {}),
    });
    targets.memory.attachArbiter();
    attached.push('memoryTieredArbitration');
  }
  if (f.policyABBranching?.enabled === true && targets.policyEvolver) {
    const p = f.policyABBranching;
    targets.policyEvolver.attachABBranching({
      ...(p.challengerTraffic !== undefined ? { challengerTraffic: p.challengerTraffic } : {}),
      ...(p.minSamples !== undefined ? { minSamples: p.minSamples } : {}),
      ...(p.promoteMargin !== undefined ? { promoteMargin: p.promoteMargin } : {}),
      ...(p.retireMargin !== undefined ? { retireMargin: p.retireMargin } : {}),
    });
    attached.push('policyABBranching');
  }
  if (f.worldObservationFusion?.enabled === true && targets.worldModel) {
    const w = f.worldObservationFusion;
    targets.worldModel.attachObservationFusion({
      ...(w.snapshotDepth !== undefined ? { snapshotDepth: w.snapshotDepth } : {}),
      ...(w.conflictThreshold !== undefined ? { conflictThreshold: w.conflictThreshold } : {}),
      ...(w.overwriteMargin !== undefined ? { overwriteMargin: w.overwriteMargin } : {}),
    });
    attached.push('worldObservationFusion');
  }
  if (f.symbiosisEconomy?.enabled === true && targets.symbiosisBridge) {
    targets.symbiosisBridge.attachConditionalSettlement();
    attached.push('symbiosisEconomy');
  }
  if (f.tenantQuotaForecast?.enabled === true && targets.tenantManager) {
    const t = f.tenantQuotaForecast;
    targets.tenantManager.configureQuotaForecast({
      alpha: t.alpha ?? 0.3,
      intervalMs: t.intervalMs ?? 60_000,
      slopeWindow: t.slopeWindow ?? 12,
      horizonMs: t.horizonMs ?? 3_600_000,
      warnFactor: t.warnFactor ?? 0.8,
    });
    attached.push('tenantQuotaForecast');
  }
  if (f.benchmarkTrendTracker?.enabled === true && targets.benchmark) {
    const b = f.benchmarkTrendTracker;
    targets.benchmark.attachTrendTracker({
      ...(b.windowSize !== undefined ? { windowSize: b.windowSize } : {}),
      ...(b.alpha !== undefined ? { alpha: b.alpha } : {}),
    });
    attached.push('benchmarkTrendTracker');
  }
  return attached;
}
