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
 * ── R5 进化(第五轮, 2026-10) ──────────────────────────────────────────────
 * A1【数学】LP 松弛界的对偶证书 bwkLpCertificate: 真值参数下每轮 LP
 *     max Σ x_i q_i  s.t.  Σ x_i c_i ≤ b, Σ x_i = 1, x ≥ 0
 *   的精确最优解 + **对偶可行解** (y0, λ) 使 y0 + λ·c_k ≥ q_k ∀k(证书本体)且
 *   对偶目标 = 原始目标(强对偶 ⟹ 界紧)。构造: 点集 {(c_k,q_k)} 的上凸包在 b 处
 *   的支撑线即最优对偶——单资源 LP 的最优支撑 ≤ 2 个臂(顶点解), 混合系数
 *   t* = (b − c_j)/(c_i − c_j), λ* = (q_i − q_j)/(c_i − c_j) ≥ 0(包在 b 处
 *   非降——降边意味着左端纯解占优), y0* = q_j − λ*·c_j。
 *   数学保证: 上凸包 ⟹ 所有点在支撑线下方 ⟹ 对偶可行由构造成立;
 *   y0 + λb = t*·q_i + (1−t*)·q_j(代数恒等) ⟹ gap = 0。
 * A2【性能】上凸包 Andrew 单调链 O(K log K) 替代全对 O(K²) 混合扫描——
 *   等价性: LP 值函数 b ↦ value(b) 是点集的凹包络, 凹包络在 b 处的值 =
 *   跨 b 的凸包边插值(或左侧顶点纯解), 全对扫描的最优混合对也必在该边上
 *   (任何两点弦 ≤ 包络) ⟹ 两者 argmax 与值一致(验证脚本 ≥200 种子对照)。
 *
 * 零漂移: 未挂载时调度器行为与升级前逐位一致(新增 API 独立, route() 未动)。
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

// ─────────────────── (R5-A1/A2) LP 松弛界的对偶证书 ───────────────────

/** LP 最优解的混合支撑分量(支撑 ≤ 2 个臂——单资源 LP 顶点解) */
export interface BwKLpMixtureComponent {
  id: string;
  /** 混合权重 x_i ∈ [0,1], Σ = 1 */
  weight: number;
  tokensMean: number;
  quality: number;
}

export interface BwKLpCertificate {
  /** 每轮预算率 b = tokensRemaining / roundsRemaining */
  rateTokens: number;
  /** LP 可行性: min_k c_k ≤ b(不可行 = 任何纯臂都超预算率) */
  feasible: boolean;
  /** LP 最优每轮期望质量(可行时) */
  primalValue: number;
  /** 最优支撑: 单臂纯解 / 跨 b 的两臂混合顶点 / LP 不可行 */
  basis: 'single-arm' | 'two-arm-mixture' | 'infeasible';
  mixture: BwKLpMixtureComponent[];
  /** 对偶最优 λ*: tokens 约束的影子价格(边际质量/单位 token); 预算不紧时为 0 */
  shadowPrice: number;
  /** 对偶最优 y0*(Σπ=1 约束的价格) */
  baseValue: number;
  /** 对偶目标 y0* + λ*·b */
  dualObjective: number;
  /** 对偶可行性: ∀k, y0* + λ*·c_k ≥ q_k − 1e-9(证书本体——上凸包构造保证) */
  dualFeasible: boolean;
  /** max(0, q_k − y0* − λ*·c_k)(对偶约束最大违反量, 理想为 0 或浮点尘埃) */
  maxConstraintViolation: number;
  /** |对偶目标 − 原始目标|(强对偶 ⟹ ≈ 0 ⟹ 界紧) */
  gap: number;
  /** gap ≤ 1e-9: 证书证明了 LP 上界恰在此处取紧 */
  tight: boolean;
}

interface HullPoint {
  c: number;
  q: number;
  id: string;
}

/** 叉积 (a−o) × (b−o): >0 = b 在 o→a 的逆时针侧(左侧) */
function cross(o: HullPoint, a: HullPoint, b: HullPoint): number {
  return (a.c - o.c) * (b.q - o.q) - (a.q - o.q) * (b.c - o.c);
}

/**
 * 上凸包(Andrew 单调链, O(K log K)): 返回从最左到最右的凹链顶点序列。
 * 走向 c 递增时保留「顺时针转折」的链——所有点在链上或链下方。
 */
function upperConvexHull(points: HullPoint[]): HullPoint[] {
  const pts = [...points].sort((x, y) => x.c - y.c || y.q - x.q || (x.id < y.id ? -1 : 1));
  const dedup: HullPoint[] = [];
  for (const p of pts) {
    if (dedup.length > 0 && Math.abs(p.c - dedup[dedup.length - 1].c) <= 1e-12) continue;
    dedup.push(p);
  }
  const hull: HullPoint[] = [];
  for (const p of dedup) {
    // 上凸包(左→右沿顶部走, 逐段顺时针/斜率递减): 中间点在弦上或弦下方
    // (cross ≥ 0 = 左转/共线)时出栈——留下的链上所有点都在其下方或之上
    while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) > -1e-15) {
      hull.pop();
    }
    hull.push(p);
  }
  return hull;
}

/**
 * (R5-A1) 真值参数下 BwK 每轮 LP 松弛的精确解 + 对偶可行证书。
 *
 * 单资源(tokens)口径: max Σ x_i q_i s.t. Σ x_i c_i ≤ b, Σ x_i = 1, x ≥ 0。
 * 原始: 最优支撑 ≤ 2(顶点解)——上凸包在 b 处的插值(跨 b 的边, 斜率 ≥ 0 时)
 *   或可行域内最高质量纯臂(降边/无跨边)。
 * 对偶: min y0 + λ·b s.t. y0 + λ·c_k ≥ q_k ∀k, λ ≥ 0——支撑线即证书:
 *   混合顶点处 λ* = 边斜率、y0* = q_j − λ*·c_j;纯解处 λ* = 0、y0* = max q。
 * 强对偶: gap = |dual − primal| = 0(浮点尘埃), tight = true ⟹ 上界证明完毕。
 *
 * 入参口径与 route() 相同(qualityMean/tokensMean/samples); samples 不进入
 * LP(证书是「真值上界」的数学口径, 乐观半径是算法口径——两者互补)。
 * 空臂集 / 全 NaN 臂集显式 throw(证书对空问题无意义, 诚实拒绝)。
 */
export function bwkLpCertificate(arms: BwKArmStat[], budgets: BwKBudgets): BwKLpCertificate {
  const valid = arms.filter(a => a && typeof a.id === 'string' && a.id
    && Number.isFinite(a.qualityMean) && Number.isFinite(a.tokensMean) && a.tokensMean >= 0);
  if (valid.length === 0) {
    throw new Error('bwkLpCertificate: 无可用臂(LP 证书对空问题无意义)');
  }
  const rounds = Math.max(1, Math.floor(budgets.roundsRemaining || 100));
  const b = Math.max(0, budgets.tokensRemaining) / rounds;

  // 同 c 去重保最高 q(确定性: id 升序破平)——混合中低质同成本臂永不入支撑
  const byC = new Map<string, HullPoint>();
  for (const arm of valid) {
    const p: HullPoint = { c: arm.tokensMean, q: clamp01(arm.qualityMean), id: arm.id };
    const key = p.c.toFixed(12);
    const prev = byC.get(key);
    if (prev === undefined || p.q > prev.q + 1e-15 || (Math.abs(p.q - prev.q) <= 1e-15 && p.id < prev.id)) {
      byC.set(key, p);
    }
  }
  const points = Array.from(byC.values());

  // 可行性: 没有任何纯臂满足 c ≤ b ⟺ LP 可行域空(Σx=1, x≥0 下 Σxc ≥ min c)
  let cheapest = points[0];
  for (const p of points) if (p.c < cheapest.c) cheapest = p;
  if (cheapest.c > b + 1e-12) {
    return {
      rateTokens: round(b),
      feasible: false,
      primalValue: Number.NaN,
      basis: 'infeasible',
      mixture: [],
      shadowPrice: Number.POSITIVE_INFINITY,
      baseValue: Number.NaN,
      dualObjective: Number.POSITIVE_INFINITY,
      dualFeasible: true,
      maxConstraintViolation: 0,
      gap: Number.POSITIVE_INFINITY,
      tight: false,
    };
  }

  const hull = upperConvexHull(points);
  // 纯可行最优(候选 1): c ≤ b 中最高质量
  let pureBest = hull[0];
  for (const p of hull) {
    if (p.c <= b + 1e-12 && p.q > pureBest.q + 1e-15) pureBest = p;
  }
  if (pureBest.c > b + 1e-12) pureBest = cheapest; // 保险(不应触发: cheapest 可行)

  // 跨 b 的凸包边(候选 2): 最后一个 c ≤ b 的顶点 j → 首个 c > b 的顶点 i
  let j = -1;
  for (let h = 0; h < hull.length; h += 1) {
    if (hull[h].c <= b + 1e-12) j = h;
  }
  let mixture: BwKLpMixtureComponent[] = [];
  let lambda = 0;
  let y0 = pureBest.q;
  let primal = pureBest.q;
  let basis: BwKLpCertificate['basis'] = 'single-arm';
  if (j >= 0 && j + 1 < hull.length) {
    const vj = hull[j];
    const vi = hull[j + 1];
    const slope = (vi.q - vj.q) / (vi.c - vj.c);
    if (slope > 1e-12) {
      // 上升边: 插值 t*·q_i + (1−t*)·q_j ≥ 任何纯可行解(凹包络非降到达 b)
      const t = (b - vj.c) / (vi.c - vj.c);
      const interp = t * vi.q + (1 - t) * vj.q;
      primal = interp;
      lambda = slope;
      y0 = vj.q - slope * vj.c;
      basis = 'two-arm-mixture';
      mixture = [
        { id: vi.id, weight: t, tokensMean: vi.c, quality: vi.q },
        { id: vj.id, weight: 1 - t, tokensMean: vj.c, quality: vj.q },
      ];
    } else {
      mixture = [{ id: pureBest.id, weight: 1, tokensMean: pureBest.c, quality: pureBest.q }];
    }
  } else {
    // 全部凸包顶点 c ≤ b: 预算率不紧, 纯最高质量即最优, λ* = 0
    mixture = [{ id: pureBest.id, weight: 1, tokensMean: pureBest.c, quality: pureBest.q }];
  }

  // 证书核验: 对偶可行性 ∀k: y0 + λ·c_k ≥ q_k(凸包构造保证, 数值复核)
  let violation = 0;
  for (const p of points) {
    violation = Math.max(violation, p.q - (y0 + lambda * p.c));
  }
  const dualObjective = y0 + lambda * b;
  const gap = Math.abs(dualObjective - primal);
  return {
    rateTokens: round(b),
    feasible: true,
    primalValue: round(primal),
    basis,
    mixture: mixture.map(m => ({ ...m, weight: round(m.weight) })),
    shadowPrice: round(lambda),
    baseValue: round(y0),
    dualObjective: round(dualObjective),
    dualFeasible: violation <= 1e-9,
    maxConstraintViolation: Math.max(0, violation),
    gap: round(gap),
    tight: gap <= 1e-9,
  };
}
