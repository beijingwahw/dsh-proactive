/**
 * 45.0 预算分配内核 —— OCBA 最优计算预算：找最优者的每一步都花在刀刃上
 *
 * 动机: 基准测试与 A/B 比较的资源分配是均匀的——每个候配置跑同样
 * 多次。但「确认谁最优」不需要均匀：差距大的候选早早出局、方差大的
 * 候选需要更多样本。Chen 等人的最优计算预算分配（OCBA, 2000）把
 * 「以最小总预算最大化正确选出最优者的概率 P(CS)」近似成渐近有效
 * 的闭式分配:
 *
 *   n_i / n_j = (σ_i/δ_i)² / (σ_j/δ_j)²        （i, j 非最优候选间）
 *   n_b = σ_b · sqrt(Σ_{i≠b} n_i²/σ_i²)         （最优者基准样本）
 *   δ_i = |μ_i − μ_b|（与最优者的差距）
 *
 *   渐近最优性 (Glynn–Juneja 2004): 该分配在 budget → ∞ 时最大化
 *   P(CS) 的指数衰减率——**每一步采样都花在刀刃上**。贝叶斯最优实验
 *   设计（10.0 科学家）面向「知识获取」，OCBA 面向「择优确认」——
 *   两者互补。
 *
 *   调度语义: 基准预算在场景间的分配从均匀升级为 OCBA——多花样本在
 *   「不确定是否最差」的场景上（找瓶颈子系统），差距明确的场景早停。
 *   验证锚点: Monte Carlo 对照（OCBA vs 均匀的 P(CS)）、固定分配的
 *   渐近比例与公式一致、预算守恒。
 *
 * 零漂移: 未挂载时基准执行与升级前逐位一致。
 */

export interface OcbaCandidate {
  /** 候选名（诊断输出用） */
  name: string;
  /** 试点均值估计（越大越优或越小越优，由 biggerIsBetter 统一口径） */
  mean: number;
  /** 试点标准差估计 */
  std: number;
}

export interface OcbaAllocation {
  /** 各候选分配的样本数（整数，总和 = budget） */
  counts: number[];
  /** 最优者下标（按试点均值） */
  best: number;
  /** 分配依据的差距 δ_i */
  gaps: number[];
  total: number;
}

/**
 * OCBA 迭代分配（Chen et al. 2000）。
 *
 * candidates: 试点统计；budget: 总样本预算；biggerIsBetter: 均值大者优
 * （缺省 true——如吞吐；false 用于延迟类越小越优）。
 * 试点 std ≤ 0 时给最小噪声下限（方差为零的候选按公式退化，防除零）。
 */
export function ocbaAllocate(
  candidates: ReadonlyArray<OcbaCandidate>,
  budget: number,
  options?: { biggerIsBetter?: boolean; minSamples?: number },
): OcbaAllocation {
  const bigger = options?.biggerIsBetter ?? true;
  const minSamples = options?.minSamples ?? 2;
  const k = candidates.length;
  if (k === 0 || budget < k * minSamples) {
    // 预算不足：均匀最小分配（诚实退化）
    const per = k === 0 ? 0 : Math.floor(budget / Math.max(1, k));
    return { counts: Array.from({ length: k }, () => per), best: 0, gaps: Array.from({ length: k }, () => 0), total: per * k };
  }
  const eps = 1e-9;
  const sigma = candidates.map((c) => Math.max(1e-6, Math.abs(c.std)));
  let best = 0;
  for (let i = 1; i < k; i += 1) {
    const better = bigger ? candidates[i].mean > candidates[best].mean : candidates[i].mean < candidates[best].mean;
    if (better) best = i;
  }
  const gaps = candidates.map((c, i) => {
    if (i === best) return 0;
    return Math.max(eps, Math.abs(c.mean - candidates[best].mean));
  });
  // 迭代不动点：非最优 n_i ∝ (σ_i/δ_i)²；n_b = σ_b √(Σ n_i²/σ_i²)
  const ratio = candidates.map((_, i) => (i === best ? 0 : (sigma[i] / gaps[i]) ** 2));
  let counts = ratio.map((r) => r * minSamples + minSamples);
  for (let iter = 0; iter < 50; iter += 1) {
    let sumSq = 0;
    for (let i = 0; i < k; i += 1) {
      if (i !== best) sumSq += (counts[i] / sigma[i]) ** 2;
    }
    const bestRatio = sigma[best] * Math.sqrt(Math.max(0, sumSq));
    const totalRatio = ratio.reduce((s, r, i) => s + (i === best ? bestRatio : r), 0);
    if (!(totalRatio > 0)) break;
    const next = ratio.map((r, i) => (i === best ? bestRatio : r) / totalRatio * budget);
    let delta = 0;
    for (let i = 0; i < k; i += 1) delta = Math.max(delta, Math.abs(next[i] - counts[i]));
    counts = next;
    if (delta <= 1e-9 * budget) break;
  }
  // 整数化 + 下限 + 守恒（最大余数法）
  const floored = counts.map((c) => Math.max(minSamples, Math.floor(c)));
  let assigned = floored.reduce((a, b) => a + b, 0);
  const order = counts.map((c, i) => ({ i, frac: c - Math.floor(c) })).sort((a, b) => b.frac - a.frac);
  let oi = 0;
  while (assigned < budget && order.length > 0) {
    floored[order[oi % order.length].i] += 1;
    assigned += 1;
    oi += 1;
  }
  // 超预算回撤（下限导致的超出）
  let over = assigned - budget;
  let guard = 0;
  while (over > 0 && guard < 10000) {
    const idx = floored.findIndex((c) => c > minSamples);
    if (idx < 0) break;
    floored[idx] -= 1;
    over -= 1;
    guard += 1;
  }
  return { counts: floored, best, gaps, total: floored.reduce((a, b) => a + b, 0) };
}

/**
 * Monte Carlo P(CS) 对照（验证锚点）: 按给定分配重复模拟「采样 → 选
 * 经验最优」的正确概率。用于断言 OCBA 分配的 P(CS) ≥ 均匀分配。
 */
export function monteCarloCorrectSelection(
  trueMeans: ReadonlyArray<number>,
  trueStds: ReadonlyArray<number>,
  counts: ReadonlyArray<number>,
  biggerIsBetter: boolean,
  reps = 2000,
  seed = 20261012,
): number {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    const u = Math.max(1e-12, rnd());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  let trueBest = 0;
  for (let i = 1; i < trueMeans.length; i += 1) {
    const better = biggerIsBetter ? trueMeans[i] > trueMeans[trueBest] : trueMeans[i] < trueMeans[trueBest];
    if (better) trueBest = i;
  }
  let correct = 0;
  for (let r = 0; r < reps; r += 1) {
    let bestIdx = 0;
    let bestStat = biggerIsBetter ? -Infinity : Infinity;
    for (let i = 0; i < trueMeans.length; i += 1) {
      const n = Math.max(1, counts[i]);
      let sum = 0;
      for (let j = 0; j < n; j += 1) sum += trueMeans[i] + trueStds[i] * gauss();
      const stat = sum / n;
      if ((biggerIsBetter && stat > bestStat) || (!biggerIsBetter && stat < bestStat)) {
        bestStat = stat;
        bestIdx = i;
      }
    }
    if (bestIdx === trueBest) correct += 1;
  }
  return correct / reps;
}
