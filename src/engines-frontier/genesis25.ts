/**
 * genesis25.ts — 创世纪升级（51.0→75.0，25 个新内核）的全链路接线适配层
 *
 * 职责：把引擎的真实数据结构转换成各内核的输入口径（纯函数 / 自包含
 * 小对象，零引擎依赖、零 I/O、同输入同输出）。各引擎（model-scheduler /
 * task-executor / decision-engine / sentinel / world-model / strategy-evolution /
 * curiosity / long-term-memory / optimizer / benchmark / symbiosis-bridge /
 * meta-cognition / reflector）以 attachXxx() 挂载点消费本层——缺省全部
 * 关闭（不 attach 即零介入，行为与升级前逐位一致——零漂移是本仓库的宪法）。
 *
 * 适配纪律：
 * - 内核的数学不动：本层只做「引擎数据 → 内核输入」的翻译与遥测估计；
 * - 遥测缺位时的估计常数（如 Hawkes 窗口、Whittle 被动转移）全部显式
 *   缺省 + 可配置覆盖，并在 JSDoc 标明口径；
 * - 挂载边界遵循各内核文件尾「接线建议」块的零介入承诺。
 */

import {
  speculativeEconomy,
  type DrafterStats,
  type VerifierStats,
  type SpeculativeEconomyVerdict,
} from '../core/speculative-decoding.js';
import { optimalVoteN, voteAccuracyCeiling, type EarlyStopVerdict, earlyStopRule } from '../core/test-time-compute.js';
import {
  whittleScheduler,
  ARM_STATE,
  type WhittleArm,
  type WhittleScheduleResult,
} from '../core/whittle-index.js';
import { backpressureInsight as kernelBackpressureInsight, type LyapunovAction, driftPlusPenaltyStep } from '../core/lyapunov-drift.js';
import {
  fitHawkes,
  burstForecast,
  residualDiagnostics,
  type HawkesFit,
  type HawkesBurstForecast,
  type HawkesResidualReport,
} from '../core/hawkes-process.js';
import { mala, gaussianTarget, w2Gaussian, tuneStep } from '../core/langevin-sampling.js';
import { masteryCurriculum, type MasteryCurriculum } from '../core/curriculum-learning.js';
import { memoryCompressionPlanner, type CompressionPlan, type MemoryEntry } from '../core/rate-distortion.js';
import { ucbPricing, thompsonPricing, type PricingPolicy } from '../core/dynamic-pricing.js';
import { mirrorDescent, MIRROR_KINDS, type MirrorKind, type MirrorDescentResult } from '../core/mirror-descent.js';

// ─────────────────────────── 51.0 投机解码：配对经济性适配 ───────────────────────────

/** 调度侧候选模型画像（引擎数据 → 内核 Drafter/Verifier 输入的原料） */
export interface SpeculativeCandidate {
  id: string;
  /** 单次调用成本口径（任意一致单位——只有比值进入数学；缺省用平均延迟 ms） */
  costPerCall: number;
  /** 该任务类型的贝叶斯后验均值（无画像时 0.5） */
  posteriorMean: number;
}

/**
 * 配对建议（第三轮 A17「被动咨询 → 主动建议」升级：数据之上叠加
 * 建议 + 理由 + 置信——既有字段全部保留，调用方零破坏）。
 */
export interface PairingAdvice {
  /** 主动建议：是否采纳 draft-verify 通道（= verdict.adopt 的建议化表述） */
  recommend: boolean;
  /** 经济性理由（加速比 × 成本比 × 盈亏平衡 × 安全边际的闭式口径） */
  reason: string;
  /** 建议置信度 0~1（γ 为遥测估计而非实测时诚实降权；边际越大建议越稳） */
  confidence: number;
  /** 建议的数值依据（经济性分解） */
  economics: {
    speedup: number;
    costRatio: number;
    breakEvenGamma: number;
    margin: number;
    optimalK: number;
  };
}

/**
 * 配对建议构造（纯函数——同输入同输出；与 SpeculativePairingAdvisor 解耦，
 * 便于验证脚本直接断言）。置信度口径：闭式数学本身精确，不确定性来自 γ 的
 * 遥测估计——实测接受率注入时基础置信 0.75，后验乘积近似时 0.55；
 * |γ − γ_be| 安全边际按 1.5 倍折算加成（上限 +0.45）。
 */
export function pairingAdvice(
  verdict: SpeculativeEconomyVerdict,
  options: { /** γ 是否来自真实接受率遥测（false = 后验近似估计） */ gammaMeasured: boolean },
): PairingAdvice {
  const marginConfidence = Math.min(0.45, Math.abs(verdict.margin) * 1.5);
  const confidence = Math.max(0, Math.min(1, (options.gammaMeasured ? 0.75 : 0.55) + marginConfidence));
  const reason = verdict.adopt
    ? `建议采纳：k*=${verdict.optimalK} 时加速比 ${verdict.speedup.toFixed(2)}×（成本比 r=${verdict.costRatio.toFixed(3)}，γ=${verdict.gamma.toFixed(3)} ≥ 盈亏平衡 ${verdict.breakEven.toFixed(3)}，安全边际 +${verdict.margin.toFixed(3)}${verdict.capped ? '，k* 触扫描上限' : ''}）——每轮期望产出 ${verdict.tokensPerRound.toFixed(1)} token，经济性成立（${options.gammaMeasured ? '实测接受率' : '后验估计 γ'}口径）`
    : `建议不采纳：γ=${verdict.gamma.toFixed(3)} 低于盈亏平衡 ${verdict.breakEven.toFixed(3)}（边际 ${verdict.margin.toFixed(3)}）——draft-verify 通道期望收益为负，验证器直通更经济`;
  return {
    recommend: verdict.adopt,
    reason,
    confidence,
    economics: {
      speedup: verdict.speedup,
      costRatio: verdict.costRatio,
      breakEvenGamma: verdict.breakEven,
      margin: verdict.margin,
      optimalK: verdict.optimalK,
    },
  };
}

/**
 * 投机解码配对裁决器（引擎侧无状态包装；γ 由遥测估计，可注入覆盖）。
 *
 * γ 估计口径（缺省）：γ̂ = p_d² / p_v（两事件独立近似——草稿合格 × 草稿
 * 与验证器结论一致的概率上界，p_d/p_v 为两模型任务后验）；引擎接入真实
 * 「草稿接受率滑动统计」后可经 options.gammaOf 覆盖（内核不采集遥测）。
 * 配对选择：草稿 = 成本最低者，验证器 = 后验均值最高者（≠ 草稿）。
 * 第三轮 A17：bestPair 输出叠加 advice（建议 + 经济性理由 + 置信）——
 * 既有 verdict/drafterId/verifierId/taskType 字段原样保留。
 */
export class SpeculativePairingAdvisor {
  private readonly maxK: number;
  private readonly gammaOf: ((drafter: SpeculativeCandidate, verifier: SpeculativeCandidate) => number) | undefined;

  constructor(options?: {
    /** 最优草稿深度扫描上限（缺省 64，与内核一致） */
    maxK?: number;
    /** γ 遥测覆盖（真实接受率统计可用时注入） */
    gammaOf?: (drafter: SpeculativeCandidate, verifier: SpeculativeCandidate) => number;
  }) {
    this.maxK = options?.maxK ?? 64;
    this.gammaOf = options?.gammaOf;
  }

  /** 估计配对接受率 γ ∈ (0,1)（遥测覆盖优先） */
  estimateGamma(drafter: SpeculativeCandidate, verifier: SpeculativeCandidate): number {
    if (this.gammaOf) return Math.max(0, Math.min(1, this.gammaOf(drafter, verifier)));
    const pv = Math.max(0.05, verifier.posteriorMean);
    const gamma = (drafter.posteriorMean * drafter.posteriorMean) / pv;
    return Math.max(0, Math.min(1, gamma));
  }

  /** 在候选池中选出「最廉草稿 × 最强验证器」并给出经济性裁决（A17：附建议结构） */
  bestPair(
    candidates: ReadonlyArray<SpeculativeCandidate>,
    taskType: string,
  ): { verdict: SpeculativeEconomyVerdict; drafterId: string; verifierId: string; taskType: string; advice: PairingAdvice } | undefined {
    const pool = candidates.filter((c) => Number.isFinite(c.costPerCall) && c.costPerCall > 0);
    if (pool.length < 2) return undefined;
    const drafter = pool.reduce((a, b) => (b.costPerCall < a.costPerCall ? b : a));
    const verifier = pool
      .filter((c) => c.id !== drafter.id)
      .reduce((a, b) => (b.posteriorMean > a.posteriorMean ? b : a));
    const drafterStats: DrafterStats = {
      id: drafter.id,
      costPerToken: drafter.costPerCall,
      acceptanceRate: this.estimateGamma(drafter, verifier),
    };
    const verifierStats: VerifierStats = { id: verifier.id, costPerToken: verifier.costPerCall };
    const verdict = speculativeEconomy(drafterStats, verifierStats, { maxK: this.maxK });
    const advice = pairingAdvice(verdict, { gammaMeasured: this.gammaOf !== undefined });
    return { verdict, drafterId: drafter.id, verifierId: verifier.id, taskType, advice };
  }
}

// ─────────────────────────── 52.0 测试时计算：投票预算适配 ───────────────────────────

/**
 * 投票预算建议（第三轮 A17「被动咨询 → 主动建议」升级：数据之上叠加
 * 建议 + 理由 + 置信——既有字段全部保留，调用方零破坏）。
 */
export interface VotePlanAdvice {
  /** 主动建议：是否值得把算力升到 n 路多数票 */
  recommend: boolean;
  /** 理由（可达性边际 × 预算代价口径） */
  reason: string;
  /** 置信度 0~1（可达边际越宽建议越稳；拒绝时边际 deficit 越大拒绝越确凿） */
  confidence: number;
  /** 精度天花板 − 目标（正 = 目标可达的余量；负 = 不可达的缺口） */
  reachMargin: number;
}

/**
 * 测试时计算预算规划器（任务执行侧咨询口径）。
 *
 * p̂ = 各任务类型成功率的 EWMA（执行器回填真实成败；冷启动 0.5）；
 * target = 按紧急度分层的目标多数票正确率（≥0.8 → 0.95；≥0.5 → 0.9；
 * 其余 0.85）；optimalVoteN 给出可达性计算的投票路数 n——p̂ ≤ 0.5 或
 * target 超天花板时诚实拒绝升级（n=1）。第三轮 A17：votePlan 输出叠加
 * advice（建议 + 可达性理由 + 置信），既有字段原样保留。
 */
export class TestTimeComputePlanner {
  private readonly alpha: number;
  private readonly ewma = new Map<string, number>();

  constructor(options?: { /** EWMA 平滑系数（新样本权重，缺省 0.2） */ alpha?: number }) {
    this.alpha = Math.max(0.05, Math.min(1, options?.alpha ?? 0.2));
  }

  /** 执行器回填真实成败（挂载时由 executeNode 调用） */
  note(taskType: string, success: boolean): void {
    const prev = this.ewma.get(taskType) ?? 0.5;
    this.ewma.set(taskType, prev * (1 - this.alpha) + (success ? 1 : 0) * this.alpha);
  }

  /** 该任务类型的成功率估计 p̂ */
  successEstimate(taskType: string): number {
    return this.ewma.get(taskType) ?? 0.5;
  }

  /** 紧急度 → 目标准确率分层 */
  static targetOf(urgency: number): number {
    if (urgency >= 0.8) return 0.95;
    if (urgency >= 0.5) return 0.9;
    return 0.85;
  }

  /**
   * 投票路数建议（高价值任务的「重推理配置」预算）。
   * p̂ ≤ 0.5 或 target 超精度天花板时内核显式 throw（诚实拒绝）——
   * 此处翻译为 n=1（不升级，保持单路原配置），rationale 说明拒绝原因。
   */
  votePlan(taskType: string, urgency: number): {
    taskType: string;
    urgency: number;
    p: number;
    target: number;
    votes: number;
    ceiling: number;
    upgrade: boolean;
    rationale: string;
    advice: VotePlanAdvice;
  } {
    const p = this.successEstimate(taskType);
    const target = TestTimeComputePlanner.targetOf(urgency);
    const ceiling = voteAccuracyCeiling(p);
    let n = 1;
    try {
      n = optimalVoteN(p, target);
    } catch {
      n = 1; // 目标超过精度天花板（ρ=0 时天花板 = p）——相关投票加样本不可达，诚实拒绝
    }
    const upgrade = n > 1;
    const reachMargin = ceiling - target;
    // 置信度口径：可达边际（或不可达缺口）按 1:1 折算加成，基线 0.6、上限 0.95
    const confidence = Math.max(0, Math.min(0.95, 0.6 + Math.min(0.35, Math.abs(reachMargin))));
    const reason = upgrade
      ? `建议升 ${n} 路投票：天花板 ${ceiling.toFixed(2)} 高于目标 ${target}（余量 +${reachMargin.toFixed(2)}）——单路 p̂=${p.toFixed(2)} 的错误率 ${(1 - p).toFixed(2)} 经多数票收敛，代价 ${n}× 单路算力换精度`
      : `建议保持单路：目标 ${target} 超出精度天花板 ${ceiling.toFixed(2)}（缺口 ${Math.abs(reachMargin).toFixed(2)}）——相关投票加样本不可达，${n}× 算力买不到目标精度，不如换更强模型或降低目标`;
    return {
      taskType,
      urgency,
      p: Number(p.toFixed(3)),
      target,
      votes: n,
      ceiling: Number(ceiling.toFixed(3)),
      upgrade,
      rationale: upgrade
        ? `p̂=${p.toFixed(2)} × 目标 ${target}：多数票需 ${n} 路（天花板 ${ceiling.toFixed(2)}，可达）`
        : `p̂=${p.toFixed(2)}：投票不可达目标 ${target}（天花板 ${ceiling.toFixed(2)}）——保持单路原配置`,
      advice: { recommend: upgrade, reason, confidence, reachMargin: Number(reachMargin.toFixed(3)) },
    };
  }

  /** 推理循环早停规则（边际增益 < 算力价格即停） */
  static shouldStop(marginalGain: number, price: number): EarlyStopVerdict {
    return earlyStopRule(marginalGain, price);
  }
}

// ─────────────────────────── 53.0 Whittle 指数：模型/租户两态臂适配 ───────────────────────────

/** 调度侧模型画像（→ Whittle 臂的原料） */
export interface WhittleCandidate {
  id: string;
  /** 任务后验均值（健康遥测；无画像 0.5） */
  posteriorMean: number;
}

export interface WhittleAdapterOptions {
  /** good 态判定阈值（后验均值 ≥ 此值，缺省 0.7） */
  goodThreshold?: number;
  /** 被动自愈率（落选的坏臂转为好的概率，缺省 0.1——保守可配置） */
  passiveHeal?: number;
  /** 折扣因子（缺省 0.95） */
  discount?: number;
}

/**
 * 模型两态健康臂构造：state = 后验均值是否达 good 阈值；主动转移的
 * 修复率 = 后验均值（被服务的坏模型按其真实成功率恢复）；被动转移的
 * 恶化率 = 1 − 后验均值（不被服务的模型按失败率恶化）。全部为遥测估计、
 * 显式缺省、可配置——挂载方接入真实转移统计后可换成滑窗计数。
 */
export function buildWhittleArms(
  candidates: ReadonlyArray<WhittleCandidate>,
  options?: WhittleAdapterOptions & { statesOverride?: Record<string, 0 | 1> },
): WhittleArm[] {
  const threshold = options?.goodThreshold ?? 0.7;
  const passiveHeal = options?.passiveHeal ?? 0.1;
  const discount = options?.discount ?? 0.95;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  return candidates.map((c) => {
    const p = clamp01(c.posteriorMean);
    const state = options?.statesOverride?.[c.id] ?? (p >= threshold ? ARM_STATE.good : ARM_STATE.bad);
    return {
      id: c.id,
      state,
      pa: [[1 - p, p], [clamp01((1 - p) / 2), 1 - clamp01((1 - p) / 2)]],
      pp: [[1 - passiveHeal, passiveHeal], [1 - p, p]],
      activeReward: p,
      passiveReward: 0,
      discount,
    } satisfies WhittleArm;
  });
}

/** 部分激活调度：n 臂中选 Whittle 指数最高的 k 个（不可索引/未收敛时调用方回退） */
export function whittleSchedule(candidates: ReadonlyArray<WhittleCandidate>, k: number, options?: WhittleAdapterOptions): WhittleScheduleResult | undefined {
  if (candidates.length === 0) return undefined;
  try {
    return whittleScheduler(buildWhittleArms(candidates, options), Math.max(0, Math.min(k, candidates.length)));
  } catch {
    return undefined; // 数值防御：任一臂求解失败 → 诚实回退原路径
  }
}

// ─────────────────────────── 54.0 Lyapunov 漂移：背压账本适配 ───────────────────────────

/**
 * 背压账本（任务执行侧）：per-队列（任务类型）在途工作量计数——
 * 派发时 acquire、完成/失败时 release；对偶价格 p_i = Q_i/V 持续超阈
 * 即「到达率逼近容量域」的稳定性告警（backpressureInsight 桥）。
 * 纯计数内核：不改变任何派发行为（只读观测口径）。
 */
export class BackpressureLedger {
  private readonly V: number;
  private readonly priceThreshold: number;
  private readonly queues = new Map<string, number>();

  constructor(options?: { /** [O(1/V), O(V)] 权衡旋钮（缺省 8） */ V?: number; priceThreshold?: number }) {
    this.V = options?.V && options.V > 0 ? options.V : 8;
    this.priceThreshold = options?.priceThreshold ?? 1.5;
  }

  acquire(queue: string): void {
    this.queues.set(queue, (this.queues.get(queue) ?? 0) + 1);
  }

  release(queue: string): void {
    const q = (this.queues.get(queue) ?? 1) - 1;
    if (q <= 0) this.queues.delete(queue);
    else this.queues.set(queue, q);
  }

  /** 当前队列长度向量（稳定顺序） */
  queueVector(): { names: string[]; queues: number[] } {
    const names = [...this.queues.keys()].sort();
    return { names, queues: names.map((n) => this.queues.get(n) ?? 0) };
  }

  /** 对偶价格 p_i = Q_i / V（背压优先级读数） */
  prices(): Array<{ name: string; price: number }> {
    const { names, queues } = this.queueVector();
    return names.map((name, i) => ({ name, price: queues[i] / this.V }));
  }

  /** 背压瓶颈洞察（54.0 内核桥：超阈产出，否则 undefined） */
  insight(): { message: string; suggestion: string; severity: number } | undefined {
    const { names, queues } = this.queueVector();
    if (queues.length === 0) return undefined;
    return kernelBackpressureInsight(queues, this.V, { names, priceThreshold: this.priceThreshold });
  }

  /**
   * 单步 drift-plus-penalty 裁决（挂载方传入动作集时使用；纯函数转发）：
   * 积压本身就是优先级——α* = argmin [ 漂移上界 + V·成本 ]。
   * @returns 选中动作下标（含对偶价格与漂移证书的完整审计）
   */
  decideAction(
    queues: ReadonlyArray<number>,
    arrivals: ReadonlyArray<number>,
    actions: ReadonlyArray<LyapunovAction>,
  ): { index: number; prices: number[]; backpressure: number } {
    const step = driftPlusPenaltyStep(queues, arrivals, actions, { V: this.V });
    return { index: step.index, prices: step.prices, backpressure: step.backpressure };
  }
}

// ─────────────────────────── 55.0 Hawkes 自激发：爆发监视适配 ───────────────────────────

export interface HawkesBurstView {
  /** 拟合参数与收敛性（样本不足/退化时 undefined——诚实降级） */
  fit?: HawkesFit;
  /** 未来窗期望事件数（闭式） */
  forecast: HawkesBurstForecast;
  /** 激发份额（> burstShare 即「信号风暴」判定） */
  excitationShare: number;
  burst: boolean;
  /** 残差诊断（均值/自相关漂移时 poissonOk=false → 退回 Poisson 假设） */
  residuals?: HawkesResidualReport;
  events: number;
}

/**
 * Hawkes 爆发监视器（Sentinel 侧）：滚动窗口记录信号到达时间戳（秒），
 * view() 拟合 μ/α/β 并闭式外推未来窗期望事件数——「到达相关性」第一次
 * 有了数学口径（激发份额超阈 = 自激发风暴，非独立 Poisson）。
 */
export class HawkesBurstMonitor {
  private readonly windowSec: number;
  private readonly burstShare: number;
  private readonly minEvents: number;
  private readonly events: number[] = [];

  constructor(options?: { /** 滚动窗（秒，缺省 900） */ windowSec?: number; burstShare?: number; minEvents?: number }) {
    this.windowSec = options?.windowSec ?? 900;
    this.burstShare = options?.burstShare ?? 0.5;
    this.minEvents = options?.minEvents ?? 8;
  }

  /** 记录一次到达（挂载时由 ingest 调用；秒口径任意基准） */
  observe(tSec: number): void {
    if (!Number.isFinite(tSec)) return;
    this.events.push(tSec);
    const cutoff = tSec - this.windowSec;
    while (this.events.length > 0 && this.events[0] < cutoff) this.events.shift();
  }

  /** 爆发读数（样本不足/拟合退化时 fit 置空——诚实降级为只报计数） */
  view(forecastMs = 60_000): HawkesBurstView | undefined {
    if (this.events.length < this.minEvents) return undefined;
    const base = this.events[0];
    const rel = this.events.map((t) => t - base);
    const now = rel[rel.length - 1];
    let fit: HawkesFit | undefined;
    try {
      fit = fitHawkes(rel, { iters: 60 });
    } catch {
      fit = undefined;
    }
    if (!fit || !fit.converged) return undefined;
    const forecast = burstForecast({ mu: fit.mu, alpha: fit.alpha, beta: fit.beta }, rel, forecastMs / 1000, { now });
    let residuals: HawkesResidualReport | undefined;
    try {
      residuals = residualDiagnostics({ mu: fit.mu, alpha: fit.alpha, beta: fit.beta }, rel);
    } catch {
      residuals = undefined;
    }
    const excitationShare = forecast.excitationShare;
    return {
      fit,
      forecast,
      excitationShare,
      burst: excitationShare > this.burstShare,
      residuals,
      events: this.events.length,
    };
  }
}

// ─────────────────────────── 58.0 朗之万采样：种群后验诊断适配 ───────────────────────────

/**
 * 种群朗之万诊断（策略进化侧只读口径）：把当前种群基因向量的高斯近似
 * （逐维均值/标准差）作为 MALA 目标后验，采样后以 W2（Bures）对照真矩
 * ——采样器健康度（接受率 ≈ 0.574、W2 收敛）即「变异分布知不知道该往
 * 哪走」的体检读数。挂载不改变 evolve() 任何行为（零漂移）。
 */
export function populationLangevinDiagnostics(
  vectors: ReadonlyArray<ReadonlyArray<number>>,
  options?: { steps?: number; seed?: number },
): { dim: number; acceptRate: number; w2: number; samples: number } | undefined {
  const d = vectors[0]?.length ?? 0;
  if (vectors.length < 3 || d < 1) return undefined;
  const mean = new Array<number>(d).fill(0);
  for (const v of vectors) for (let i = 0; i < d; i += 1) mean[i] += v[i] / vectors.length;
  const std = new Array<number>(d).fill(0);
  for (const v of vectors) for (let i = 0; i < d; i += 1) std[i] += (v[i] - mean[i]) ** 2 / Math.max(1, vectors.length - 1);
  for (let i = 0; i < d; i += 1) std[i] = Math.max(1e-6, Math.sqrt(std[i]));
  const target = gaussianTarget(d, { mean, std });
  const steps = options?.steps ?? 300;
  const seed = options?.seed ?? 7;
  // 步长自标定（目标接受率 0.574——Roberts–Rosenthal 一维最优尺度理论）
  const tuned = tuneStep({ gradU: target.gradU, logU: target.logU, dim: d, seed, targetAccept: 0.574, pilotSteps: 120 });
  const result = mala({
    gradU: target.gradU,
    logU: target.logU,
    dim: d,
    eta: tuned.eta,
    steps,
    seed,
    burnIn: Math.floor(steps / 3),
  });
  const trueCov = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => (i === j ? std[i] * std[j] : 0)));
  const w2 = w2Gaussian(result.samples, mean, trueCov).w2;
  return { dim: d, acceptRate: result.acceptRate, w2, samples: result.samples.length };
}

// ─────────────────────────── 59.0 课程学习：探索难度课程适配 ───────────────────────────

/**
 * 探索难度课程（好奇心侧）：把探索结局（是否填补盲区）回填掌握门限
 * 状态机，nextLevel() 即下一档探索难度建议——探索从均匀乱试升级为
 * 「带内练习、掌握爬阶」。挂载仅追加记账，不改变探索派发行为。
 */
export class ExplorationCurriculum {
  private readonly policy: MasteryCurriculum;
  private readonly levelCount: number;

  constructor(options?: { levelCount?: number; threshold?: number; promoteR?: number; demoteS?: number }) {
    this.levelCount = Math.max(1, Math.floor(options?.levelCount ?? 5));
    this.policy = masteryCurriculum({
      levelCount: this.levelCount,
      threshold: options?.threshold,
      promoteR: options?.promoteR,
      demoteS: options?.demoteS,
    });
  }

  /** 回填一次探索结局（挂载时由 recordExploration 调用） */
  report(success: boolean): void {
    this.policy.report(this.policy.nextLevel(), success);
  }

  /** 当前难度档与策略名（只读） */
  view(): { level: number; levelCount: number; name: string } {
    return { level: this.policy.nextLevel(), levelCount: this.levelCount, name: this.policy.name };
  }
}

// ─────────────────────────── 60.0 率失真：记忆压缩规划适配 ───────────────────────────

/** 记忆模式画像（→ MemoryEntry 原料；字段与 TaskPatternMemory 兼容） */
export interface CompressionPatternInput {
  taskSummary: string;
  confidence: number;
  successfulPlanCount?: number;
}

/**
 * 记忆条目构造：价值 v = 置信度 × (1 + ln(1+成功计划数))；全保真比特
 * b = 摘要字符 × 8（字节口径）；压缩档 c = b/4（蒸馏摘要缺省压缩比），
 * 留存率 ρ = 0.6（内核缺省同款）。执行仍由蒸馏管线决定——本层只产出
 * 规划与影子价格 λ*（记忆健康度的信息论 KPI）。
 */
export function buildCompressionEntries(
  patterns: ReadonlyArray<CompressionPatternInput>,
  options?: { retention?: number },
): MemoryEntry[] {
  const retention = options?.retention ?? 0.6;
  return patterns.map((p) => {
    const sizeBits = Math.max(8, p.taskSummary.length * 8);
    return {
      id: p.taskSummary.slice(0, 80),
      value: Math.max(0, p.confidence) * (1 + Math.log1p(p.successfulPlanCount ?? 0)),
      sizeBits,
      compressedBits: Math.round(sizeBits / 4),
      retention,
    };
  });
}

/** 记忆压缩规划（预算约束下 keep/compress/drop 三档 + 影子价格；纯读口径） */
export function planMemoryCompression(
  patterns: ReadonlyArray<CompressionPatternInput>,
  budgetBits: number,
  options?: { retention?: number },
): CompressionPlan | undefined {
  if (patterns.length === 0) return undefined;
  return memoryCompressionPlanner(buildCompressionEntries(patterns, options), budgetBits);
}

// ─────────────────────────── 65.0 动态定价：共生费率学习适配 ───────────────────────────

/**
 * 共生市场费率学习挂载（影子口径）：策略在归一化价域 [0,1] 上学习
 * （UCB 网格 [0.25, 0.5, 0.75, 1]；Thompson 连续报价），出价按 unit
 * （单位能量价，缺省 10）折算——闲置档自动降价、抢手档自动提价。
 * 仅 observe/estimate 读数，不改变任何真实铸币/结算数值（零漂移）。
 */
export class EnergyPricingMount {
  private readonly policy: PricingPolicy;
  private readonly unit: number;
  private lastQuoted: number | undefined;

  constructor(options?: { policy?: 'ucb' | 'thompson'; unit?: number; exploration?: number; seed?: number }) {
    this.unit = options?.unit && options.unit > 0 ? options.unit : 10;
    this.policy =
      options?.policy === 'thompson'
        ? thompsonPricing({ seed: options?.seed })
        : ucbPricing({ grid: [0.25, 0.5, 0.75, 1], exploration: options?.exploration });
  }

  /** 结算回填（挂载时由 settleTask 调用：报价 → 是否有成交铸币）；返回单位能量报价 */
  settlement(hadValue: boolean): number {
    const price = this.policy.nextPrice() * this.unit;
    this.lastQuoted = price;
    this.policy.observe(hadValue ? 1 : 0);
    return price;
  }

  /** 当前价估计与学习读数（只读；estimate 已按 unit 折算） */
  view(): { lastPrice: number | undefined; estimate: { price: number; expectedDemand: number; expectedRevenue: number } | undefined } {
    const estimate = this.policy.estimate();
    return {
      lastPrice: this.lastQuoted,
      estimate: estimate
        ? {
            price: estimate.price * this.unit,
            expectedDemand: estimate.expectedDemand,
            expectedRevenue: estimate.expectedRevenue * this.unit,
          }
        : undefined,
    };
  }
}

// ─────────────────────────── 67.0 NSGA-II：调度帕累托视图适配 ───────────────────────────

export interface ParetoModelPoint {
  id: string;
  /** 风险调整错误率 = 1 − Wilson 下界（最小化目标 1） */
  risk: number;
  /** 单次调用成本口径（最小化目标 2；缺省平均延迟 ms） */
  cost: number;
  /** 平均延迟（最小化目标 3） */
  latency: number;
}

export interface ParetoFrontView {
  /** 非支配前沿模型 id（按风险升序） */
  frontIds: string[];
  /** 全体候选点（诊断口径） */
  points: ParetoModelPoint[];
  /** 前沿点的拥挤距离（同序） */
  crowding: number[];
  /** (风险, 成本) 平面上的 2D 超体积（参考点 = 1.25×各维最差值） */
  hypervolume: number;
  insight: string;
}

// ─────────────────────────── 74.0 镜像下降：无悔路由账本适配 ───────────────────────────

export interface NoRegretView {
  actions: string[];
  /** 平均混合策略 x̄（博弈口径的自收敛输出） */
  averageStrategy: number[];
  regret: number;
  regretBound: number;
  rounds: number;
  boundValid: boolean;
}

/**
 * 决策无悔账本（决策引擎侧）：每次决策反馈按「行动 × 结局价值」记账，
 * 每轮损失向量 g_t = 1 − 行动 EWMA 价值（未行动臂保留既有估计——代理
 * 全信息口径）；view() 用 74.0 内核在历史上重放镜像下降，输出无悔混合
 * 策略与后悔迹线（咨询口径——决策路径零漂移）。
 */
export class NoRegretLedger {
  private readonly actions: string[];
  private readonly mirror: MirrorKind;
  private readonly ewma = new Map<string, number>();
  private readonly lossHistory: number[][] = [];
  private readonly alpha: number;

  constructor(options?: { actions?: string[]; mirror?: MirrorKind; alpha?: number }) {
    this.actions = options?.actions ?? ['execute', 'defer', 'dismiss', 'ask-user'];
    this.mirror = options?.mirror ?? MIRROR_KINDS.entropic;
    this.alpha = options?.alpha ?? 0.15;
  }

  /** 决策反馈记账（挂载时由 recordOutcome 调用） */
  note(action: string, value: number): void {
    const prev = this.ewma.get(action);
    const next = prev === undefined ? value : prev * (1 - this.alpha) + value * this.alpha;
    this.ewma.set(action, next);
    this.lossHistory.push(this.actions.map((a) => 1 - (this.ewma.get(a) ?? 0.5)));
    if (this.lossHistory.length > 500) this.lossHistory.shift();
  }

  /** 无悔混合策略读数（样本不足时 undefined） */
  view(): NoRegretView | undefined {
    const T = this.lossHistory.length;
    if (T < 5) return undefined;
    const replay = this.lossHistory.slice(-200);
    const history = replay;
    const result: MirrorDescentResult = mirrorDescent({
      mirror: this.mirror,
      domain: { kind: 'simplex', n: this.actions.length },
      losses: (round) => history[round],
      T: replay.length,
    });
    return {
      actions: this.actions,
      averageStrategy: result.averageStrategy,
      regret: result.regret,
      regretBound: result.regretBound,
      rounds: replay.length,
      boundValid: result.boundValid,
    };
  }
}
