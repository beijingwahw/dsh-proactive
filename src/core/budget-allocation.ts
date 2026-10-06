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
 * ── R5-A13 世界性进化（第五轮）──
 *
 * 9. **保留最优性结构的圆整（ocbaAllocatePlan）**: 原「最大余数法 +
 *    下限垫底 + 超预算回撤」可能破坏 OCBA 的渐近比例结构（回撤按
 *    下标序拿走样本，理想分配序可能被反转）。新入口给出**序保持的
 *    受控圆整**：理想差 ≥ 2 的候选对整数序必须一致（违规自动换位
 *    修复）；超预算回撤从理想最小者先撤（保大头）；报告逐候选相对
 *    圆整误差与序违规计数——圆整后的分配仍是 OCBA 公式的忠实整数化。
 *
 * 10. **多约束预算分配（容量上限 caps）**: 每候选可加样本上限（如
 *     单场景每日配额）。理想分配削顶后剩余预算在未削顶候选间按其
 *     理想比例注水（比例结构在活跃集内保持），迭代至稳定；Σ caps
 *     < budget 的不可行预算显式抛错（诚实拒绝而非静默丢弃守恒）。
 *
 * 11. **不变量缓存 + 除零/负预算护栏**: 不动点迭代中 Σ_{i≠best}
 *     ratio_i 与 prefix/suffix 基和跨迭代不变——缓存后每迭代少一遍
 *     O(k) 归约（大 k 下实测提速）；budget 非有限显式抛错、负预算
 *     钳到 0（原实现会产出负样本数的垃圾数组）。
 *
 * 零漂移: ocbaAllocate 的经典路径对合法输入逐位不变；本节为纯新增
 * 入口（ocbaAllocatePlan）+ 非法输入护栏。
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
  if (!Number.isFinite(budget)) {
    throw new Error(`ocbaAllocate: budget 必须为有限数（收到 ${budget}）`);
  }
  const safeBudget = Math.max(0, budget); // 负预算按 0 处理（原路径会产出负样本数）
  const bigger = options?.biggerIsBetter ?? true;
  const minSamples = options?.minSamples ?? 2;
  const k = candidates.length;
  if (k === 0 || safeBudget < k * minSamples) {
    // 预算不足：均匀最小分配（诚实退化）
    const per = k === 0 ? 0 : Math.floor(safeBudget / Math.max(1, k));
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
  // 超预算回撤（单趟 O(k)，R5-A13 修复）：按下标序能撤尽撤（下限为界）
  // ——与原「findIndex 逐次撤 1」的最终结果逐位一致，但去掉了
  // guard 10000 上限（垫底样本极多的病态实例下原实现会静默漏撤、
  // Σ ≠ budget 违反自身合同；单趟版恒守恒）。
  let over = assigned - budget;
  for (let i = 0; i < k && over > 0; i += 1) {
    const take = Math.min(over, floored[i] - minSamples);
    if (take > 0) {
      floored[i] -= take;
      over -= take;
    }
  }
  return { counts: floored, best, gaps, total: floored.reduce((a, b) => a + b, 0) };
}

// ─────────────────────────── R5-A13：序保持圆整 + 多约束预算 ───────────────────────────

/** ocbaAllocatePlan 选项 */
export interface OcbaPlanOptions {
  biggerIsBetter?: boolean;
  minSamples?: number;
  /** 每候选样本上限（多约束预算分配；标量 = 全体同上限，数组 = 逐候选） */
  maxSamples?: number | ReadonlyArray<number>;
}

/** 序保持受控圆整的分配计划 */
export interface OcbaAllocationPlan extends OcbaAllocation {
  /** 圆整相对误差 max_i |n_i − n*_i| / max(1, n*_i)（n* = 容量约束后的连续理想分配） */
  roundingError: number;
  /** 理想差 ≥ 2 却整数序反转的候选对数（受控圆整后应为 0） */
  orderViolations: number;
  /** 被容量上限削顶的候选数 */
  capped: number;
  /** 连续理想分配（容量约束后；诊断/等价证明对照口径） */
  ideal: number[];
}

/**
 * OCBA 分配计划（R5-A13）：连续不动点 → 容量约束注水 → **序保持受控圆整**。
 *
 * 1. 不动点与 ocbaAllocate 同式，但缓存跨迭代不变量（Σ_{i≠best} ratio_i
 *    基和）——大 k 下每迭代省一遍 O(k) 归约；
 * 2. caps：理想值逐轮削顶，超出预算量按剩余候选的理想比例注水回填
 *    （活跃集内 OCBA 比例结构保持）；Σ caps < budget 显式抛错；
 * 3. 圆整：下限/上限垫底 + 最大余数法（平手取小下标），随后**序修复**——
 *    理想差 ≥ 2 的对若整数序反转则换位（可行动时）；超预算回撤按
 *    理想值从小到大撤（先撤大头之外的零头，保大头）；全程整数运算，
 *    Σ counts = budget 精确守恒。
 */
export function ocbaAllocatePlan(
  candidates: ReadonlyArray<OcbaCandidate>,
  budget: number,
  options?: OcbaPlanOptions,
): OcbaAllocationPlan {
  if (!Number.isFinite(budget)) throw new Error(`ocbaAllocatePlan: budget 必须为有限数（收到 ${budget}）`);
  const safeBudget = Math.max(0, budget);
  const bigger = options?.biggerIsBetter ?? true;
  const minSamples = options?.minSamples ?? 2;
  const k = candidates.length;
  if (k === 0) {
    return { counts: [], best: 0, gaps: [], total: 0, roundingError: 0, orderViolations: 0, capped: 0, ideal: [] };
  }
  const caps = normalizeCaps(options?.maxSamples, k);
  for (let i = 0; i < k; i += 1) {
    if (caps[i] < minSamples) {
      throw new Error(`ocbaAllocatePlan: 候选 ${i} 的上限 ${caps[i]} < 下限 ${minSamples}（约束不可行）`);
    }
  }
  if (caps.reduce((a, b) => a + b, 0) < safeBudget) {
    throw new Error(
      `ocbaAllocatePlan: Σ 上限 ${caps.reduce((a, b) => a + b, 0)} < 预算 ${safeBudget}（预算在容量约束下不可行——不静默丢守恒）`,
    );
  }
  if (safeBudget < k * minSamples) {
    // 预算不足：与 ocbaAllocate 同款诚实退化（再受 caps 约束）
    const perRaw = Math.floor(safeBudget / Math.max(1, k));
    const per = Math.min(perRaw, Math.max(0, Math.min(...caps)));
    const counts = Array.from({ length: k }, () => per);
    return { counts, best: 0, gaps: Array.from({ length: k }, () => 0), total: per * k, roundingError: 0, orderViolations: 0, capped: 0, ideal: counts.map(() => per) };
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

  // ── 1. 连续不动点（不变量缓存：Σ_{i≠best} ratio_i 跨迭代不变）──
  const ratio = candidates.map((_, i) => (i === best ? 0 : (sigma[i] / gaps[i]) ** 2));
  let baseRatioSum = 0; // 不变量缓存：非最优理想比例之和
  for (let i = 0; i < k; i += 1) if (i !== best) baseRatioSum += ratio[i];
  let counts = ratio.map((r) => r * minSamples + minSamples);
  for (let iter = 0; iter < 50; iter += 1) {
    let sumSq = 0;
    for (let i = 0; i < k; i += 1) {
      if (i !== best) sumSq += (counts[i] / sigma[i]) ** 2;
    }
    const bestRatio = sigma[best] * Math.sqrt(Math.max(0, sumSq));
    const totalRatio = baseRatioSum + bestRatio;
    if (!(totalRatio > 0)) break;
    const next = ratio.map((r, i) => (i === best ? bestRatio : r) / totalRatio * safeBudget);
    let delta = 0;
    for (let i = 0; i < k; i += 1) delta = Math.max(delta, Math.abs(next[i] - counts[i]));
    counts = next;
    if (delta <= 1e-9 * safeBudget) break;
  }

  // ── 2. 容量约束：削顶 + 缺口按活跃集权重注水至守恒（结构化多约束分配）──
  // 每轮：贴顶者固定在 cap，剩余缺口 (budget − Σ) 按未贴顶者的理想权重
  // 分摊；中途贴顶者出局进下一轮——k+2 轮内 Σ ideal = budget（整数 caps
  // 下最多 k 次贴顶）。Σ caps ≥ budget 已校验，注水必有去处。
  for (let round = 0; round < k + 2; round += 1) {
    for (let i = 0; i < k; i += 1) if (counts[i] > caps[i]) counts[i] = caps[i];
    let sum = 0;
    for (let i = 0; i < k; i += 1) sum += counts[i];
    if (sum >= safeBudget - 1e-9) break;
    let wSum = 0;
    for (let i = 0; i < k; i += 1) {
      if (counts[i] < caps[i]) wSum += i === best ? Math.max(eps, counts[i]) : Math.max(ratio[i], eps);
    }
    if (!(wSum > 0)) break;
    const gap = safeBudget - sum;
    let distributed = 0;
    for (let i = 0; i < k; i += 1) {
      if (counts[i] < caps[i]) {
        const w = i === best ? Math.max(eps, counts[i]) : Math.max(ratio[i], eps);
        const add = Math.min((gap * w) / wSum, caps[i] - counts[i]);
        counts[i] += add;
        distributed += add;
      }
    }
    if (distributed <= 1e-12) break;
  }
  let cappedCount = 0;
  for (let i = 0; i < k; i += 1) if (idealAtCap(counts[i], caps[i])) cappedCount += 1;
  const ideal = [...counts];

  // ── 3. 序保持受控圆整（整数域，精确守恒）──
  const floored = counts.map((c, i) => Math.max(minSamples, Math.min(caps[i], Math.floor(c))));
  let assigned = floored.reduce((a, b) => a + b, 0);
  // 低于预算：最大余数法补 1（平手取小下标；到顶候选跳过）
  const remainders = counts
    .map((c, i) => ({ i, frac: c - Math.floor(c) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  let ri = 0;
  while (assigned < safeBudget) {
    let granted = false;
    for (let step = 0; step < remainders.length && !granted; step += 1) {
      const cand = remainders[(ri + step) % remainders.length];
      if (floored[cand.i] < caps[cand.i]) {
        floored[cand.i] += 1;
        assigned += 1;
        ri += step + 1;
        granted = true;
      }
    }
    if (!granted) break; // 全部到顶：Σ caps ≥ budget 已校验，理论不可达（防御）
  }
  // 序修复（理想降序的相邻换位）：只修理想差 ≥ 2 的真错序——舍入在
  // 近并列（差 < 2）间产生的 ±1 反转属圆整固有松弛、不算违规也不修
  // （修了会在并列带内气泡式连锁，O(k²) 且无意义）。一趟 O(k)，
  // 最多 k+2 趟（防御上限）。
  const byIdeal = counts.map((c, i) => ({ i, ideal: c })).sort((a, b) => b.ideal - a.ideal || a.i - b.i);
  for (let pass = 0; pass < k + 2; pass += 1) {
    let repaired = false;
    for (let p = 0; p + 1 < k; p += 1) {
      const hi = byIdeal[p].i;
      const lo = byIdeal[p + 1].i;
      if (
        byIdeal[p].ideal >= byIdeal[p + 1].ideal + 2 &&
        floored[hi] < floored[lo] &&
        floored[hi] + 1 <= caps[hi] &&
        floored[lo] - 1 >= minSamples
      ) {
        floored[hi] += 1;
        floored[lo] -= 1;
        repaired = true;
      }
    }
    if (!repaired) break;
  }
  // 超预算回撤（单趟 O(k)）：byIdeal 尾端即理想升序——从理想最小者
  // 撤起、能撤尽撤（下限为界），只降小者、理想序只紧不破（复用
  // byIdeal，省第二次排序）。
  let over = assigned - safeBudget;
  for (let p = k - 1; p >= 0 && over > 0; p -= 1) {
    const i = byIdeal[p].i;
    const take = Math.min(over, floored[i] - minSamples);
    if (take > 0) {
      floored[i] -= take;
      over -= take;
    }
  }

  // 序违规计数（回撤之后核账）：理想降序中，p 违规 ⟺ 存在 q > p，
  // ideal_q ≤ ideal_p − 2 且 floored_q > floored_p。阈值随 p 升序单调
  // 右移——双指针 + 后缀最大值一遍 O(k) 精确计数。
  let orderViolations = 0;
  const suffixMax = new Array<number>(k + 1).fill(-Infinity);
  for (let p = k - 1; p >= 0; p -= 1) suffixMax[p] = Math.max(suffixMax[p + 1], floored[byIdeal[p].i]);
  let s = 0;
  for (let p = 0; p < k; p += 1) {
    const bound = byIdeal[p].ideal - 2;
    if (s < p + 1) s = p + 1;
    while (s < k && byIdeal[s].ideal > bound) s += 1;
    if (s < k && suffixMax[s] > floored[byIdeal[p].i]) orderViolations += 1;
  }
  let roundingError = 0;
  for (let i = 0; i < k; i += 1) {
    roundingError = Math.max(roundingError, Math.abs(floored[i] - ideal[i]) / Math.max(1, ideal[i]));
  }
  const total = floored.reduce((a, b) => a + b, 0);
  return { counts: floored, best, gaps, total, roundingError, orderViolations, capped: cappedCount, ideal };
}

/** caps 归一：标量 → 全体；数组 → 长度/整数/正数校验（分数上限会破坏整数守恒） */
function normalizeCaps(maxSamples: number | ReadonlyArray<number> | undefined, k: number): number[] {
  if (maxSamples === undefined) return Array.from({ length: k }, () => Number.POSITIVE_INFINITY);
  if (typeof maxSamples === 'number') {
    if (!Number.isInteger(maxSamples) || maxSamples < 1) {
      throw new Error(`ocbaAllocatePlan: maxSamples 标量必须为 ≥1 的整数（收到 ${maxSamples}——分数上限会破坏 Σ = budget 的整数守恒）`);
    }
    return Array.from({ length: k }, () => maxSamples);
  }
  if (maxSamples.length !== k) {
    throw new Error(`ocbaAllocatePlan: maxSamples 数组长度 ${maxSamples.length} 必须等于候选数 ${k}`);
  }
  return maxSamples.map((c, i) => {
    if (!Number.isInteger(c) || c < 1) {
      throw new Error(`ocbaAllocatePlan: maxSamples[${i}] 必须为 ≥1 的整数（收到 ${c}）`);
    }
    return c;
  });
}

/** 理想值已贴住容量上限（削顶判定，浮点容差口径） */
function idealAtCap(value: number, cap: number): boolean {
  return Number.isFinite(cap) && value >= cap - 1e-9;
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
