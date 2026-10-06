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
 * ── R5-A13 世界性进化（第五轮）：不可分割物品的公平分配 ──
 *
 * 连续注水只适用于可分预算；「k 条记忆 / m 个候选席位给 n 方」这类
 * **不可分割物品**需要另一族定理：
 *
 * 6. **EF1 判定算法**（envy-free up to one item, Lipton et al. 2004）:
 *    i 对 j 无嫉妒「除去至多一件物品」⟺ V_i(A_j) − max_{k∈A_j} v_i(k)
 *    ≤ V_i(A_i)。O(n²m) 精确判定 + 违例明细（谁嫉妒谁、嫉妒多少、
 *    移除最优物品后还剩多少）——无嫉妒检验从「目测」升级为算法。
 *
 * 7. **嫉妒循环消除**（Lipton–Markakis–Mossel–Saberi 2004）: 反复把
 *    下一件物品给「不被任何人嫉妒」的代理；全员被嫉妒时嫉妒图必有
 *    有向环（无入度 0 节点 ⟹ 沿入边回走必复现），沿环轮换捆
 *    （每人拿到自己严格更爱的捆，势函数严格下降 → 有限终止）。
 *    单调估值下产出**定理保证的 EF1 分配**——不依赖参数、不赌运气。
 *
 * 8. **贪心最大纳什福利 + 对数域计算**: 逐件物品给「使正价值捆数最多、
 *    其次使 Σln V_i 最大」的代理（Caragiannis et al. 2016 的 MNW 分解
 *    语义；乘积在 log 域累加——数值稳健，价值悬殊时无下溢）。
 *    精确 MNW 是 NP 难（MNW 分配本身 EF1+PO，但不可有效精确求解），
 *    贪心是诚实标注的启发式：内核报告其 EF1 判定与纳什福利，
 *    不冒充最优（实测可显著偏离最优与 EF1——见验证脚本的穷举对照）。
 *
 * 零漂移: 未挂载时探索预算分配与升级前逐位一致；本节为纯新增函数。
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

// ─────────────────────────── R5-A13：不可分割物品的公平分配 ───────────────────────────

/** 不可分割物品公平分配的浮点容差（嫉妒判定/零捆判定的确定性口径） */
const EF1_EPS = 1e-9;

/** EF1 违例明细：i 嫉妒 j 且移除 j 捆内（i 口径）最优一件物品后仍嫉妒 */
export interface EnvyRecord {
  /** 嫉妒者 */
  envier: number;
  /** 被嫉妒者 */
  envied: number;
  /** 嫉妒量 V_i(A_j) − V_i(A_i)（> 0 才记账） */
  envy: number;
  /** j 捆内 i 口径最值钱的一件（空捆记 null） */
  removable: number | null;
  /** 移除该物品后的剩余嫉妒（> EF1_EPS 即违例） */
  envyAfterRemoval: number;
}

/** EF1 审计结果 */
export interface EF1Audit {
  /** 全部（i,j） 对满足 EF1（嫉妒至多一件物品可消除） */
  ef1: boolean;
  violations: EnvyRecord[];
}

/**
 * 校验可加估值矩阵：矩形、代理 ≥ 1、条目为有限非负数（好物品口径）。
 */
function validateValuations(valuations: ReadonlyArray<ReadonlyArray<number>>): void {
  if (valuations.length < 1) throw new Error('fair-division: 至少需要 1 个代理');
  const items = valuations[0].length;
  for (let a = 0; a < valuations.length; a += 1) {
    if (valuations[a].length !== items) {
      throw new Error(`fair-division: 估值矩阵必须矩形（第 ${a} 行宽 ${valuations[a].length} ≠ ${items}）`);
    }
    for (let k = 0; k < items; k += 1) {
      const v = valuations[a][k];
      if (!Number.isFinite(v) || v < 0) {
        throw new Error(`fair-division: 估值必须为有限非负数（agent ${a} 对物品 ${k} 报 ${v}）`);
      }
    }
  }
}

/** 校验 bundles 与估值矩阵形状一致且不含重复/越界物品 */
function validateBundles(
  valuations: ReadonlyArray<ReadonlyArray<number>>,
  bundles: ReadonlyArray<ReadonlyArray<number>>,
): void {
  if (bundles.length !== valuations.length) {
    throw new Error(`fair-division: bundles 行数 ${bundles.length} 必须等于代理数 ${valuations.length}`);
  }
  const seen = new Set<number>();
  for (const bundle of bundles) {
    for (const item of bundle) {
      if (!Number.isInteger(item) || item < 0 || item >= valuations[0].length) {
        throw new Error(`fair-division: 物品下标越界（${item}；物品数 ${valuations[0].length}）`);
      }
      if (seen.has(item)) throw new Error(`fair-division: 物品 ${item} 被分配给多个代理`);
      seen.add(item);
    }
  }
}

/** agent a 对一捆物品的自估值 V_a(A) = Σ_{k∈A} v_a(k) */
function bundleValueFor(valuations: ReadonlyArray<ReadonlyArray<number>>, a: number, items: ReadonlyArray<number>): number {
  let s = 0;
  for (const k of items) s += valuations[a][k];
  return s;
}

/**
 * EF1 精确判定（Lipton et al. 2004 口径）: ∀i≠j，
 * V_i(A_j) − max_{k∈A_j} v_i(k) ≤ V_i(A_i)。
 * j 的捆为空时不允许移除（空捆本来无嫉妒可记）。O(n²·m)。
 */
export function isEF1(
  valuations: ReadonlyArray<ReadonlyArray<number>>,
  bundles: ReadonlyArray<ReadonlyArray<number>>,
): EF1Audit {
  validateValuations(valuations);
  validateBundles(valuations, bundles);
  const n = valuations.length;
  const violations: EnvyRecord[] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const own = bundleValueFor(valuations, i, bundles[i]);
      const other = bundleValueFor(valuations, i, bundles[j]);
      const envy = other - own;
      if (envy <= EF1_EPS) continue;
      const removable =
        bundles[j].length > 0 ? Math.max(...bundles[j].map((k) => valuations[i][k])) : null;
      const envyAfterRemoval = removable === null ? envy : envy - removable;
      if (envyAfterRemoval > EF1_EPS) {
        violations.push({ envier: i, envied: j, envy, removable, envyAfterRemoval });
      }
    }
  }
  return { ef1: violations.length === 0, violations };
}

/** 不可分割物品分配结果（贪心 MNW / 嫉妒循环消除共用的报告口径） */
export interface IndivisibleGoodsAllocation {
  /** bundles[a] = 分给代理 a 的物品下标（分配顺序原序） */
  bundles: number[][];
  /** 各代理自口径捆价值 V_a(A_a) */
  bundleValues: number[];
  /** 纳什福利 Π_a V_a（任一捆 ≤ 0 → 0） */
  nashWelfare: number;
  /** 对数域纳什福利 Σ_a ln V_a（任一捆 ≤ 0 → −Infinity；大数值稳健） */
  logNashWelfare: number;
  /** 本分配的 EF1 判定（内核口径逐对审计） */
  ef1: boolean;
  ef1Violations: EnvyRecord[];
  method: 'greedy-mnw' | 'envy-cycle';
  interpretation: string;
}

/** 由捆计算 (纳什福利, 对数域纳什福利)——乘法全在 log 域汇总 */
function welfareOf(
  valuations: ReadonlyArray<ReadonlyArray<number>>,
  bundles: ReadonlyArray<ReadonlyArray<number>>,
): { nashWelfare: number; logNashWelfare: number; bundleValues: number[] } {
  const bundleValues = bundles.map((b, a) => bundleValueFor(valuations, a, b));
  if (bundleValues.some((v) => v <= EF1_EPS)) {
    return { nashWelfare: 0, logNashWelfare: Number.NEGATIVE_INFINITY, bundleValues };
  }
  const logNW = bundleValues.reduce((s, v) => s + Math.log(v), 0);
  return { nashWelfare: Math.exp(logNW), logNashWelfare: logNW, bundleValues };
}

/** 物品处理序：max_a v_a(item) 降序，平手取物品下标升序（确定性） */
function itemOrder(valuations: ReadonlyArray<ReadonlyArray<number>>): number[] {
  const items = valuations[0].length;
  return Array.from({ length: items }, (_, k) => k).sort((x, y) => {
    const mx = Math.max(...valuations.map((row) => row[x]));
    const my = Math.max(...valuations.map((row) => row[y]));
    return my - mx || x - y;
  });
}

/**
 * 贪心最大纳什福利（对数域）：逐件物品给「正价值捆数最多，其次
 * Σ ln V_a 最大」的代理（Caragiannis et al. 2016 的 MNW 分层语义——
 * 先保证人人有正价值，再最大化乘积）。诚实口径：精确 MNW 是 NP 难，
 * 贪心不冒充最优也不承诺 EF1——ef1 字段由内核 EF1 判定如实给出。
 */
export function greedyMaxNashWelfare(
  valuations: ReadonlyArray<ReadonlyArray<number>>,
): IndivisibleGoodsAllocation {
  validateValuations(valuations);
  const n = valuations.length;
  const bundles: number[][] = Array.from({ length: n }, () => []);
  const values = new Array<number>(n).fill(0);
  for (const item of itemOrder(valuations)) {
    let bestAgent = -1;
    let bestPositive = -1;
    let bestLog = Number.NEGATIVE_INFINITY;
    for (let a = 0; a < n; a += 1) {
      const candidate = [...values];
      candidate[a] += valuations[a][item];
      const positive = candidate.filter((v) => v > EF1_EPS).length;
      const logW = candidate.reduce((s, v) => (v > EF1_EPS ? s + Math.log(v) : s), 0);
      // 词典序比较（正捆数, Σln V）：严格更优才换——平手保低代理下标（确定性）
      if (positive > bestPositive || (positive === bestPositive && logW > bestLog + 1e-15)) {
        bestPositive = positive;
        bestLog = logW;
        bestAgent = a;
      }
    }
    bundles[bestAgent].push(item);
    values[bestAgent] += valuations[bestAgent][item];
  }
  const { nashWelfare, logNashWelfare, bundleValues } = welfareOf(valuations, bundles);
  const audit = isEF1(valuations, bundles);
  return {
    bundles,
    bundleValues,
    nashWelfare,
    logNashWelfare,
    ef1: audit.ef1,
    ef1Violations: audit.violations,
    method: 'greedy-mnw',
    interpretation: `贪心 MNW（log 域）：NW=${Number.isFinite(logNashWelfare) ? nashWelfare.toFixed(3) : '0'}（Σln V=${Number.isFinite(logNashWelfare) ? logNashWelfare.toFixed(4) : '−∞'}），EF1=${audit.ef1 ? '成立' : `违例 ×${audit.violations.length}`}——启发式口径，不冒充最优`,
  };
}

/**
 * 嫉妒循环消除（Lipton–Markakis–Mossel–Saberi 2004）——**定理保证 EF1**
 * （单调估值下）。流程：下一件物品永远给「不被任何人嫉妒」的最低下标
 * 代理；全员被嫉妒时嫉妒图必有有向环（有限图无入度 0 节点 ⟹ 沿
 * 「谁嫉妒我」入边回走必复现），沿环轮换捆——环上每人拿到自己严格
 * 更爱的捆，势函数 Σ_a V_a(A_a) 严格上升 ⟹ 有限步内必出现不被嫉妒者。
 * 每件物品至多触发有限次轮换（防御性计数器兜底，超限显式抛错）。
 */
export function envyCycleElimination(
  valuations: ReadonlyArray<ReadonlyArray<number>>,
): IndivisibleGoodsAllocation {
  validateValuations(valuations);
  const n = valuations.length;
  const bundles: number[][] = Array.from({ length: n }, () => []);
  const ownValue = new Array<number>(n).fill(0);
  const envies = (i: number, j: number): boolean => {
    // i 嫉妒 j：V_i(A_j) > V_i(A_i)
    let other = 0;
    for (const k of bundles[j]) other += valuations[i][k];
    return other > ownValue[i] + EF1_EPS;
  };

  for (const item of itemOrder(valuations)) {
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 10_000) {
        throw new Error('envyCycleElimination: 嫉妒环消除超过防御上限（不变量破坏——势函数应严格上升）');
      }
      // 被嫉妒标记
      const envied = new Array<boolean>(n).fill(false);
      for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n; j += 1) {
          if (i !== j && envies(i, j)) envied[j] = true;
        }
      }
      const unenvied: number[] = [];
      for (let j = 0; j < n; j += 1) if (!envied[j]) unenvied.push(j);
      if (unenvied.length > 0) {
        // 给不被嫉妒的最低下标代理——不制造新的「底层嫉妒」
        const a = unenvied[0];
        bundles[a].push(item);
        ownValue[a] += valuations[a][item];
        break;
      }
      // 全员被嫉妒：沿入边（谁嫉妒我）回走找环
      const walk = [0];
      const position = new Map<number, number>([[0, 0]]);
      for (;;) {
        const cur = walk[walk.length - 1];
        let pred = -1;
        for (let j = 0; j < n; j += 1) {
          if (j !== cur && envies(j, cur)) {
            pred = j;
            break;
          }
        }
        // 全员被嫉妒 ⟹ 入度处处 ≥ 1 ⟹ pred 必存在（防御性校验）
        if (pred < 0) {
          throw new Error('envyCycleElimination: 全员被嫉妒却找不到嫉妒者（不变量破坏）');
        }
        if (position.has(pred)) {
          const cycle = walk.slice(position.get(pred)!); // cycle[t+1] 嫉妒 cycle[t]
          const old = cycle.map((x) => bundles[x]);
          cycle.forEach((x, t) => {
            bundles[x] = old[(t - 1 + cycle.length) % cycle.length]; // 各拿自己嫉妒者的捆
          });
          for (let a = 0; a < n; a += 1) {
            ownValue[a] = bundleValueFor(valuations, a, bundles[a]);
          }
          break;
        }
        position.set(pred, walk.length);
        walk.push(pred);
      }
    }
  }
  const { nashWelfare, logNashWelfare, bundleValues } = welfareOf(valuations, bundles);
  const audit = isEF1(valuations, bundles);
  return {
    bundles,
    bundleValues,
    nashWelfare,
    logNashWelfare,
    ef1: audit.ef1,
    ef1Violations: audit.violations,
    method: 'envy-cycle',
    interpretation: `嫉妒循环消除：NW=${Number.isFinite(logNashWelfare) ? nashWelfare.toFixed(3) : '0'}，EF1=${audit.ef1 ? '成立（定理保证：单调估值下 Lipton et al. 2004）' : `违例 ×${audit.violations.length}`}`,
  };
}

/**
 * 独立口径：给定捆的（对数域）纳什福利——验证脚本与调度方的对照器。
 */
export function nashWelfareOf(
  valuations: ReadonlyArray<ReadonlyArray<number>>,
  bundles: ReadonlyArray<ReadonlyArray<number>>,
): { nashWelfare: number; logNashWelfare: number; bundleValues: number[] } {
  validateValuations(valuations);
  validateBundles(valuations, bundles);
  return welfareOf(valuations, bundles);
}
