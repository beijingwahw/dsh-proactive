/**
 * 22.0 预算最优路由内核 —— Bandits with Knapsacks(Badanidiyuru–Kleinberg–Slivkins 2013;
 * Agrawal–Devanur 2014): 预算约束下最大化累计质量, 成本权重从对偶中内生涌现。
 *
 * 问题形式化(每轮选一个臂 = 模型执行一次):
 *     max E[ Σ_t q_{i_t} ]   s.t.  Σ_t c_{i_t} ≤ B_tokens, Σ_t cost_{i_t} ≤ B_cost
 * LP 松弛: max Σ π_i q_i s.t. Σ π_i c_i ≤ b, Σ π = 1(b = 剩余预算率);
 * 对偶影子价格 λ ≥ 0 使最优集中于 argmax(q_i − λ c_i) —— 固定 costWeight=0.2 只是 λ 的
 * 一次性猜测, 本内核让 λ 由「剩余预算 / 剩余轮数」的稀缺性实时决定。
 *
 * 在线算法(乐观可行性 + 预算感知贪心, BalK 结构):
 *   1. 质量采用乐观上界 q⁺ = q̂ + r_q(r_q 为 12.0 经验伯恩斯坦半径, 复用
 *      fixedSampleUpperBound), token 消耗半径用无界支撑的 EB 公式;
 *   2. 可行性: 均值消耗 ≤ 剩余预算率 × (1 + slack) —— slack 为噪声与突发留缓冲;
 *   3. 无可行臂 → 选最廉臂并标记 urgent(必须卸载负载, 而非假装最优仍存在);
 *   4. 影子价格: 取「最高质量但不可行臂 f」与「选中臂 c」的混合 LP 解
 *      λ = (q⁺_f − q⁺_c) / (c_f − c_c) —— 两臂混合 t* = (b − c_c)/(c_f − c_c) 是 LP 最优顶点,
 *      λ 即该顶点处预算约束的对偶变量(边际质量/单位 token)。
 *
 * 零漂移: 未挂载时调度器行为与升级前逐位一致。
 */

import { fixedSampleUpperBound } from './anytime-evidence.js';

export interface BwKConfig {
  /** 乐观半径的置信参数(α 越小半径越大, 越探索) */
  ucbAlpha: number;
  /** 可行性松弛: 均值消耗 ≤ 预算率 × (1 + slack) */
  feasibilitySlack: number;
  /** 臂样本少于此值时半径退化为均值一半(诚实的大不确定性) */
  minSamples: number;
  /** roundsRemaining 缺省时的视界估计 */
  horizonDefault: number;
}

export const DEFAULT_BWK_CONFIG: BwKConfig = {
  ucbAlpha: 0.05,
  feasibilitySlack: 0.25,
  minSamples: 1,
  horizonDefault: 100,
};

export interface BwKArmStat {
  id: string;
  /** 历史平均质量 ∈ [0,1] */
  qualityMean: number;
  qualityVar?: number;
  /** 历史平均 token 消耗 */
  tokensMean: number;
  tokensVar?: number;
  /** 可选第二资源(货币成本) */
  costMean?: number;
  costVar?: number;
  samples: number;
}

export interface BwKBudgets {
  tokensRemaining: number;
  costRemaining?: number;
  roundsRemaining: number;
}

export interface BwKCandidateView {
  id: string;
  optimisticQuality: number;
  tokensMean: number;
  feasible: boolean;
  radiusQuality: number;
}

export interface BwKVerdict {
  chosenId: string;
  /** ucb-feasible: 乐观贪心命中可行臂; cheapest-shed: 无可行臂被迫卸载; empty: 无臂 */
  basis: 'ucb-feasible' | 'cheapest-shed' | 'empty';
  urgent: boolean;
  rateTokens: number;
  rateCost: number;
  /** 混合 LP 顶点的对偶影子价格(边际质量/单位 token); 无混合结构时为 0 */
  shadowPriceTokens: number;
  shadowPriceCost: number;
  /** 不可行的高质量臂(影子价格的另一端) */
  bottleneckArmId?: string;
  candidates: BwKCandidateView[];
  reason: string;
}

export class BwKRouter {
  private readonly config: Required<BwKConfig>;

  constructor(config?: Partial<BwKConfig>) {
    this.config = { ...DEFAULT_BWK_CONFIG, ...config } as Required<BwKConfig>;
  }

  getConfig(): Readonly<Required<BwKConfig>> {
    return this.config;
  }

  route(arms: BwKArmStat[], budgets: BwKBudgets): BwKVerdict {
    const valid = arms.filter(a => a && typeof a.id === 'string' && a.id
      && Number.isFinite(a.qualityMean) && Number.isFinite(a.tokensMean) && a.tokensMean >= 0);
    if (valid.length === 0) {
      return {
        chosenId: '', basis: 'empty', urgent: false,
        rateTokens: 0, rateCost: 0, shadowPriceTokens: 0, shadowPriceCost: 0,
        candidates: [], reason: '无可用臂',
      };
    }
    const rounds = Math.max(1, Math.floor(budgets.roundsRemaining || this.config.horizonDefault));
    const tokensRemaining = Math.max(0, budgets.tokensRemaining);
    const rateTokens = tokensRemaining / rounds;
    const rateCost = budgets.costRemaining != null && budgets.costRemaining > 0
      ? Math.max(0, budgets.costRemaining) / rounds : 0;

    const candidates: BwKCandidateView[] = valid.map(arm => {
      const radiusQuality = qualityRadius(arm, this.config.ucbAlpha, this.config.minSamples);
      const optimisticQuality = clamp01(arm.qualityMean + radiusQuality);
      const feasible = arm.tokensMean <= rateTokens * (1 + this.config.feasibilitySlack)
        && (rateCost <= 0 || (arm.costMean ?? 0) <= rateCost * (1 + this.config.feasibilitySlack));
      return { id: arm.id, optimisticQuality, tokensMean: arm.tokensMean, feasible, radiusQuality: round(radiusQuality) };
    });

    const feasible = candidates.filter(c => c.feasible);
    if (feasible.length === 0) {
      // 预算率撑不起任何臂: 必须卸载 —— 选最廉臂止血, 而非假装最优仍在
      const cheapest = [...candidates].sort((x, y) => x.tokensMean - y.tokensMean || y.optimisticQuality - x.optimisticQuality)[0];
      return {
        chosenId: cheapest.id, basis: 'cheapest-shed', urgent: true,
        rateTokens: round(rateTokens), rateCost: round(rateCost),
        shadowPriceTokens: 0, shadowPriceCost: 0,
        candidates,
        reason: `预算率 ${rateTokens.toFixed(0)} tok/轮 低于最廉臂 ${cheapest.tokensMean.toFixed(0)} tok, 触发负载卸载`,
      };
    }

    // 乐观贪心: 可行臂中取乐观质量最高(平局取更廉者)
    const chosen = [...feasible].sort((x, y) => y.optimisticQuality - x.optimisticQuality
      || x.tokensMean - y.tokensMean)[0];

    // 影子价格: 最高乐观质量的不可行臂 f 与选中臂 c 构成 LP 混合顶点
    //   max t·q_f + (1−t)·q_c  s.t.  t·c_f + (1−t)·c_c ≤ b  →  λ = (q_f − q_c)/(c_f − c_c)
    let shadowPriceTokens = 0;
    let bottleneckArmId: string | undefined;
    const infeasible = candidates.filter(c => !c.feasible);
    for (const f of infeasible) {
      if (f.optimisticQuality <= chosen.optimisticQuality) continue;
      const armF = valid.find(a => a.id === f.id)!;
      const denom = armF.tokensMean - chosen.tokensMean;
      if (denom > 1e-9) {
        const lambda = (f.optimisticQuality - chosen.optimisticQuality) / denom;
        if (lambda > shadowPriceTokens) {
          shadowPriceTokens = lambda;
          bottleneckArmId = f.id;
        }
      }
    }

    return {
      chosenId: chosen.id, basis: 'ucb-feasible', urgent: false,
      rateTokens: round(rateTokens), rateCost: round(rateCost),
      shadowPriceTokens: round(shadowPriceTokens),
      shadowPriceCost: 0,
      bottleneckArmId,
      candidates,
      reason: shadowPriceTokens > 0
        ? `选中 ${chosen.id}(乐观质量 ${chosen.optimisticQuality.toFixed(3)}); 影子价格 λ=${shadowPriceTokens.toFixed(4)} 质量/token, 高质臂 ${bottleneckArmId} 被预算率卡在门外`
        : `选中 ${chosen.id}(乐观质量 ${chosen.optimisticQuality.toFixed(3)}), 预算充裕无影子价格`,
    };
  }
}

/** 质量 ∈ [0,1] 的乐观半径: 复用 12.0 经验伯恩斯坦上界减均值 */
function qualityRadius(arm: BwKArmStat, alpha: number, minSamples: number): number {
  if (arm.samples < Math.max(1, minSamples) || arm.samples < 1) {
    return 0.5; // 零样本诚实大半径(与调度器 0.5 中性口径一致)
  }
  const mean = clamp01(arm.qualityMean);
  // 缺省方差取 Bernoulli 最坏情形 mean(1−mean) ≤ 0.25(有界支撑的诚实口径)
  const variance = Math.max(0, arm.qualityVar ?? mean * (1 - mean));
  const upper = fixedSampleUpperBound(arm.samples, mean, variance, alpha);
  const radius = Math.max(0, upper - mean);
  return Number.isFinite(radius) ? Math.min(1, radius) : 0.5;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
