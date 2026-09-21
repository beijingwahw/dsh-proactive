/**
 * 44.0 公平分配内核 —— 极大极小公平 + 注水算法：没有谁被饿死是定理
 *
 * 动机: 探索预算分给哪些知识域？按新颖度比例分会让冷门域长期饿死
 * （新颖度高的域永远拿走大头），均分又浪费（有的域根本没有盲区）。
 * 网络工程的经典答案——**极大极小公平**（max-min fairness）:
 *
 *   分配 x 在「不减少更穷者」的意义下不可改进：
 *     ∀i: 增加 x_i 必然存在 j，x_j ≤ x_i 且 x_j 减少
 *   → 词典序最大：先尽量抬高最小的份额，再抬高次小的……（Bertsekas–
 *     Gallager–Tsitsiklis 1992）。注水算法（water-filling）O(n log n)
 *   精确求解：需求低于水位的拿满需求，剩余容量在超额需求者间均摊。
 *
 *   加权口径（progressive filling，weights w_i）: 份额按权重比例增长
 *   直到容量耗尽——权重公平同时保底「最穷相对份额」。
 *
 *   调度语义: 探索预算按域分配从「新颖度 top-k 的赢者通吃」升级为
 *   加权极大极小：热门域可以多拿，但任何活跃域的相对份额不被压扁——
 *   **探索的覆盖有公平定理背书**（多样性坍缩在预算层再上一道锁）。
 *
 *   验证锚点: 教科书例（demands [2, 4, 2.4, 1] / 容量 5 → 前两个均摊
 *   2.5 的经典）、公平支配性审计（不可改进性逐位检查）、加权口径
 *   按权重比例、需求全小于容量时各取所需。
 *
 * 零漂移: 未挂载时探索预算分配与升级前逐位一致。
 */

export interface FairAllocation {
  /** 各方份额 */
  shares: number[];
  /** 注水水位（需求超额者共同的水位；全需求内则 = ∞ 语义，此处 = max(share)） */
  waterLevel: number;
  /** 未满足的总需求 */
  deficit: number;
}

/**
 * 极大极小公平分配（注水算法）。
 *
 * demands: 各方需求（≥ 0）；capacity ≥ 0。需求 ≤ 水位者拿满需求，
 * 超额者在剩余容量中均摊。词典序最优性是构造性保证。
 */
export function maxMinFair(demands: ReadonlyArray<number>, capacity: number): FairAllocation {
  const n = demands.length;
  const shares = new Array<number>(n).fill(0);
  const remaining = [...demands.map((d) => Math.max(0, d))];
  let left = Math.max(0, capacity);
  let unfilled = remaining.filter((r) => r > 0).length;
  while (unfilled > 0 && left > 0) {
    const share = left / unfilled;
    let progressed = false;
    for (let i = 0; i < n; i += 1) {
      if (remaining[i] <= 0) continue;
      if (remaining[i] <= share + 1e-12) {
        shares[i] += remaining[i];
        left -= remaining[i];
        remaining[i] = 0;
        unfilled -= 1;
        progressed = true;
      }
    }
    if (!progressed) {
      // 所有剩余需求都超过水位：均摊
      for (let i = 0; i < n; i += 1) {
        if (remaining[i] > 0) shares[i] += share;
      }
      left = 0;
    }
  }
  const deficit = remaining.reduce((a, b) => a + Math.max(0, b), 0);
  const waterLevel = shares.length > 0 ? Math.max(...shares) : 0;
  return { shares, waterLevel, deficit };
}

/**
 * 加权极大极小公平（progressive filling：各方按权重比例注水）。
 *
 * 份额增长率 ∝ w_i；某方到达需求后退出，其余继续。w_i 全相等时退化为
 * 经典 max-min（等权重是特例——验证锚点之一）。
 */
export function weightedMaxMinFair(demands: ReadonlyArray<number>, weights: ReadonlyArray<number>, capacity: number): FairAllocation {
  const n = demands.length;
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 1));
  const shares = new Array<number>(n).fill(0);
  const remaining = demands.map((d) => Math.max(0, d));
  const active = new Set(remaining.map((r, i) => (r > 0 ? i : -1)).filter((i) => i >= 0));
  let left = Math.max(0, capacity);
  while (active.size > 0 && left > 0) {
    const wSum = [...active].reduce((s, i) => s + w[i], 0);
    // 一步注水：找最先到岸的（需求 / 权重比最小）
    let timeToFill = Infinity;
    for (const i of active) {
      timeToFill = Math.min(timeToFill, remaining[i] / w[i]);
    }
    const totalFill = timeToFill * wSum;
    if (totalFill <= left) {
      for (const i of active) {
        shares[i] += timeToFill * w[i];
        remaining[i] -= timeToFill * w[i];
        left -= timeToFill * w[i];
        if (remaining[i] <= 1e-12) {
          remaining[i] = 0;
          active.delete(i);
        }
      }
    } else {
      const scale = left / wSum;
      for (const i of active) shares[i] += scale * w[i];
      left = 0;
    }
  }
  const deficit = remaining.reduce((a, b) => a + Math.max(0, b), 0);
  return { shares, waterLevel: shares.length > 0 ? Math.max(...shares) : 0, deficit };
}

/**
 * 公平支配性审计（验证锚点）: 极大极小的定义性检查——
 * ∀i: x_i < demand_i（未拿满）⟹ ∃j≠i: x_j/w_j ≤ x_i/w_i 且 x_j > 0
 * （i 的任何增长必挤占一个相对份额不高于自己的持有者）。
 */
export function fairnessAudit(
  demands: ReadonlyArray<number>,
  allocation: ReadonlyArray<number>,
  weights?: ReadonlyArray<number>,
): { fair: boolean; violations: number } {
  const w = weights ?? demands.map(() => 1);
  let violations = 0;
  for (let i = 0; i < demands.length; i += 1) {
    if (allocation[i] >= demands[i] - 1e-9) continue; // 拿满需求者不适用
    const relI = allocation[i] / w[i];
    const hasBlocker = demands.some((_, j) => j !== i && allocation[j] > 1e-9 && allocation[j] / w[j] <= relI + 1e-9);
    if (!hasBlocker) violations += 1;
  }
  return { fair: violations === 0, violations };
}

/** 域预算接线口径：需求（各域盲区数 × 新颖度权重）→ 加权公平份额（整数保底：活跃域优先各得 1，再按权重注水） */
export function fairDomainBudget(
  domains: ReadonlyArray<{ id: string; demand: number; weight: number }>,
  budget: number,
): Array<{ id: string; share: number }> {
  if (domains.length === 0) return [];
  const active = domains.filter((d) => d.demand > 0);
  if (active.length === 0) return domains.map((d) => ({ id: d.id, share: 0 }));
  const shares = new Map<string, number>(domains.map((d) => [d.id, 0]));
  let left = Math.max(0, Math.floor(budget));
  // 整数保底：任何活跃域优先各得 1（权重序——预算不足时高权重域先保命）
  for (const d of [...active].sort((a, b) => b.weight - a.weight)) {
    if (left <= 0) break;
    const grant = Math.min(1, Math.floor(d.demand));
    shares.set(d.id, grant);
    left -= grant;
  }
  if (left > 0) {
    const alloc = weightedMaxMinFair(
      active.map((d) => Math.max(0, d.demand - (shares.get(d.id) ?? 0))),
      active.map((d) => d.weight),
      left,
    );
    active.forEach((d, i) => shares.set(d.id, (shares.get(d.id) ?? 0) + Math.floor(alloc.shares[i])));
  }
  return domains.map((d) => ({ id: d.id, share: shares.get(d.id) ?? 0 }));
}
