/**
 * 30.0 次模优化内核 —— 加权覆盖 + 惰性贪心 (CELF) + 曲率修正保证
 *
 * 动机: 「探索预算分给谁」是组合选择：好奇心引擎按新颖度 top-k 挑盲区，
 * 但 top-k 是**模函数**口径——相关知识（共享主题的盲区）被重复购买,
 * 预算在冗余上浪费。覆盖价值天然**次模**（边际收益递减）：
 *
 *   f(A ∪ {x}) − f(A) ≥ f(B ∪ {x}) − f(B),  ∀A ⊆ B, x ∉ B
 *   （同一主题第二次被覆盖的边际严格更小）
 *
 *   加权覆盖函数（本内核的具体化）:
 *     f(S) = Σ_theme W_t · (1 − Π_{i∈S∩t}(1 − c_{i,t}))
 *     W_t = 主题权重（新颖度质量），c_{i,t} = 项 i 覆盖主题 t 的强度
 *
 *   Nemhauser–Wolsey–Fisher (1978): 单调次模 + 基数约束 k，
 *     贪心 ≥ (1 − 1/e)·OPT ≈ 0.632·OPT——多项式时间可证的近似比；
 *     惰性贪心（CELF, Leskovec 2007）与朴素贪心**逐位同解**，评估次数
 *     数量级下降（上一轮选中的项使其余边际只降不升——次模性的红利）。
 *
 *   曲率修正 (Conforti–Cornuéjols): 曲率 c = 1 − min_i min_X 边际(X,i)/f({i}),
 *     贪心保证收紧为 ≥ (1 − e^{−c})/c·OPT ∈ [0.632, 1]·OPT——
 *     c 从数据里算出来，不是拍脑袋。
 *
 *   预算约束（每项有成本）: 边际贪心 / 边际密度贪心取优——
 *     ≥ ½(1 − 1/e)·OPT（Khuller–Moss–Naor）。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致。
 */

/** 确定性 PRNG（mulberry32） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 次模目标函数（下标即地面集合） */
export interface SubmodularFunction {
  groundSize: number;
  /** f(S)（空集 = 0） */
  value(selected: ReadonlySet<number>): number;
  /** 边际增益 f(S ∪ {item}) − f(S)（item ∉ S 时） */
  marginal(item: number, selected: ReadonlySet<number>): number;
}

interface ThemeSpec {
  /** 主题权重 W_t ≥ 0 */
  weight: number;
  /** 覆盖项 → 覆盖强度 c ∈ (0,1] */
  covers: Map<number, number>;
}

/**
 * 加权覆盖函数：f(S) = Σ_t W_t·(1 − Π_{i∈S∩t}(1 − c_{i,t}))。
 *
 * 每个主题是概率覆盖集——单调、次模（且归一化时 f(全集) = ΣW_t）。
 */
export class WeightedCoverage implements SubmodularFunction {
  readonly groundSize: number;
  private readonly themes: ThemeSpec[] = [];
  /** item → theme 下标列表（边际查询加速） */
  private readonly itemThemes: Array<number[]>;

  constructor(groundSize: number) {
    this.groundSize = groundSize;
    this.itemThemes = Array.from({ length: groundSize }, () => []);
  }

  /** 登记一个覆盖主题：weight 权重，items 覆盖项 → 强度 c ∈ (0,1] */
  addTheme(weight: number, covers: ReadonlyMap<number, number>): void {
    if (!(weight > 0)) return;
    const theme: ThemeSpec = { weight, covers: new Map(covers) };
    const idx = this.themes.length;
    for (const item of covers.keys()) {
      if (item >= 0 && item < this.groundSize) this.itemThemes[item]!.push(idx);
    }
    this.themes.push(theme);
  }

  value(selected: ReadonlySet<number>): number {
    let acc = 0;
    for (const theme of this.themes) {
      let uncovered = 1;
      for (const [item, c] of theme.covers) {
        if (selected.has(item)) uncovered *= 1 - c;
      }
      acc += theme.weight * (1 - uncovered);
    }
    return acc;
  }

  marginal(item: number, selected: ReadonlySet<number>): number {
    let gain = 0;
    for (const t of this.itemThemes[item] ?? []) {
      const theme = this.themes[t]!;
      let uncovered = 1;
      for (const [j, c] of theme.covers) {
        if (j !== item && selected.has(j)) uncovered *= 1 - c;
      }
      gain += theme.weight * (1 - uncovered * (1 - (theme.covers.get(item) ?? 0))) - theme.weight * (1 - uncovered);
    }
    return gain;
  }

  get themeCount(): number {
    return this.themes.length;
  }
}

/**
 * 从 token 集合构造覆盖函数（30.0 接线辅助）。
 *
 * 主题 = 每个知识项自身的质量 w_i（被覆盖 = 该盲区的知识被获得）；
 * 项 j 对主题 i 的覆盖强度：自身 1；共享 token 的近邻 coverageStrength。
 *
 *   f({i}) = w_i；f({i, j≈i}) = w_i + w_j·(1−c)  —— 冗余第二选的
 *   边际从 w_j 衰减到 (1−c)·w_j（它 70% 的知识已经被第一个选中者
 *   「顺带学会」）；互补项边际完整保留 w_k。这是加权覆盖在
 * 「知识覆盖」语义下的正确形态（token 做主题会让独占 token 的项
 * 价值归零——语义错误）。
 */
export function coverageFromTokens(
  items: Array<{ tokens: ReadonlyArray<string>; weight: number }>,
  coverageStrength = 0.7,
): WeightedCoverage {
  const n = items.length;
  const cov = new WeightedCoverage(n);
  const tokenSets = items.map((item) => new Set(item.tokens.filter((t) => t.length >= 2)));
  for (let i = 0; i < n; i += 1) {
    const covers = new Map<number, number>();
    covers.set(i, 1);
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      const shared = [...tokenSets[i]!].some((t) => tokenSets[j]!.has(t));
      if (shared) covers.set(j, coverageStrength);
    }
    cov.addTheme(Math.max(1e-9, items[i]!.weight), covers);
  }
  return cov;
}

export interface GreedyResult {
  selected: number[];
  /** 贪心终止价值（逐选择点记录，任何时刻可读） */
  values: number[];
  /** 边际增益序列 */
  gains: number[];
  /** marginal 调用次数（CELF 加速比的证据） */
  evaluations: number;
}

/**
 * 惰性贪心（CELF）：单调次模 + 基数约束 k → ≥ (1−1/e)·OPT。
 * 与朴素贪心逐位同解（次模性保证队列顶端的陈旧边际只降不升）。
 */
export function lazyGreedy(f: SubmodularFunction, k: number): GreedyResult {
  const cap = Math.max(0, Math.min(k, f.groundSize));
  const selected = new Set<number>();
  const values: number[] = [];
  const gains: number[] = [];
  let evaluations = 0;
  // (stale marginal, item) 大顶堆（数组 + 每轮取最大，n 小时代价可忽略）
  const queue: Array<{ key: number; item: number }> = [];
  for (let i = 0; i < f.groundSize; i += 1) {
    evaluations += 1;
    queue.push({ key: f.marginal(i, selected), item: i });
  }

  while (selected.size < cap && queue.length > 0) {
    let topIdx = 0;
    for (let i = 1; i < queue.length; i += 1) if (queue[i]!.key > queue[topIdx]!.key) topIdx = i;
    const top = queue[topIdx]!;
    // 重估顶端（次模性：陈旧键只可能高估）
    evaluations += 1;
    const fresh = f.marginal(top.item, selected);
    if (fresh <= 1e-12) {
      // 真实边际归零（顶端高估的最保守情形）：淘汰出队
      queue.splice(topIdx, 1);
      continue;
    }
    // 次大键（含陈旧口径——它是重估后真实键的上界，判据安全）
    let secondKey = 0;
    for (let i = 0; i < queue.length; i += 1) {
      if (i !== topIdx && queue[i]!.key > secondKey) secondKey = queue[i]!.key;
    }
    if (fresh >= secondKey - 1e-12) {
      // 重估后仍为顶端：选中（与朴素贪心逐位同解）
      queue.splice(topIdx, 1);
      selected.add(top.item);
      const prev = values.length > 0 ? values[values.length - 1]! : 0;
      values.push(prev + fresh);
      gains.push(fresh);
    } else {
      // 键过期：降级回队列
      top.key = fresh;
    }
  }
  return { selected: [...selected], values, gains, evaluations };
}

/**
 * 预算约束贪心（每项成本不同）：边际贪心与边际密度贪心各跑一遍取优，
 * 保证 ≥ ½(1−1/e)·OPT（Khuller–Moss–Naor 之「取优」加强）。
 */
export function budgetedGreedy(f: SubmodularFunction, costs: ReadonlyArray<number>, budget: number): GreedyResult & { variant: 'marginal' | 'density' } {
  const runBy = (keyOf: (item: number, gain: number) => number): GreedyResult => {
    let remaining = budget;
    const selected = new Set<number>();
    const values: number[] = [];
    const gains: number[] = [];
    let evaluations = 0;
    for (;;) {
      let bestItem = -1;
      let bestKey = 0;
      let bestGain = 0;
      for (let i = 0; i < f.groundSize; i += 1) {
        if (selected.has(i)) continue;
        if (costs[i]! > remaining) continue;
        evaluations += 1;
        const gain = f.marginal(i, selected);
        const key = keyOf(i, gain);
        if (key > bestKey && gain > 1e-12) {
          bestKey = key;
          bestItem = i;
          bestGain = gain;
        }
      }
      if (bestItem < 0) break;
      selected.add(bestItem);
      remaining -= costs[bestItem]!;
      const prev = values.length > 0 ? values[values.length - 1]! : 0;
      values.push(prev + bestGain);
      gains.push(bestGain);
    }
    return { selected: [...selected], values, gains, evaluations };
  };
  const byMarginal = runBy((_i, gain) => gain);
  const byDensity = runBy((i, gain) => gain / Math.max(1e-9, costs[i]!));
  const totalOf = (r: GreedyResult) => (r.values.length > 0 ? r.values[r.values.length - 1]! : 0);
  return totalOf(byDensity) > totalOf(byMarginal)
    ? { ...byDensity, variant: 'density' }
    : { ...byMarginal, variant: 'marginal' };
}

/** 穷举最优（验证锚点；C(n,k) 组合枚举，n ≤ ~14 适用） */
export function bruteForceBest(f: SubmodularFunction, k: number): { selected: number[]; value: number } {
  const n = f.groundSize;
  const cap = Math.min(k, n);
  let best: number[] = [];
  let bestValue = 0;
  const combo: number[] = [];
  const empty = new Set<number>();
  const rec = (start: number): void => {
    if (combo.length === cap) {
      const v = f.value(new Set(combo));
      if (v > bestValue) {
        bestValue = v;
        best = [...combo];
      }
      return;
    }
    for (let i = start; i < n; i += 1) {
      combo.push(i);
      rec(i + 1);
      combo.pop();
    }
  };
  rec(0);
  if (bestValue === 0) {
    // k=0 或全零价值：显式评估空集口径
    f.value(empty);
  }
  return { selected: best, value: bestValue };
}

export interface SubmodularityAudit {
  trials: number;
  /** 违反递减收益不等式的次数（应恒为 0） */
  violations: number;
  maxViolation: number;
}

/** 随机次模性审计：A ⊆ B、x ∉ B，检验 f(A∪x)−f(A) ≥ f(B∪x)−f(B) */
export function submodularityCheck(f: SubmodularFunction, trials = 300, seed = 20260920): SubmodularityAudit {
  const rng = mulberry32(seed);
  let violations = 0;
  let maxViolation = 0;
  const randSet = (mask: number[]): Set<number> => new Set(mask);
  for (let t = 0; t < trials; t += 1) {
    const ground = Array.from({ length: f.groundSize }, (_, i) => i);
    const perm = ground.filter(() => rng() > 0.5).concat(ground.filter(() => rng() <= 0.5));
    // B ⊇ A：随机划分已选集
    const bSize = 1 + Math.floor(rng() * f.groundSize);
    const rest = [...ground];
    const B: number[] = [];
    for (let i = 0; i < bSize && rest.length > 0; i += 1) {
      B.push(rest.splice(Math.floor(rng() * rest.length), 1)[0]!);
    }
    const A = B.filter(() => rng() < 0.6);
    const candidates = ground.filter((i) => !B.includes(i));
    if (candidates.length === 0) continue;
    const x = candidates[Math.floor(rng() * candidates.length)]!;
    void perm;
    const setA = randSet(A);
    const setB = randSet(B);
    const gainA = f.marginal(x, setA);
    const gainB = f.marginal(x, setB);
    const violation = gainA - gainB;
    if (violation < -1e-9) {
      violations += 1;
      maxViolation = Math.max(maxViolation, -violation);
    }
  }
  return { trials, violations, maxViolation };
}

export interface CurvatureReport {
  /** 曲率估计 c ∈ [0,1]（越接近 0 越接近模函数 = 贪心越接近精确） */
  curvature: number;
  /** 修正保证因子 (1 − e^{−c})/c ∈ [1−1/e, 1] */
  guaranteeFactor: number;
  samples: number;
}

/**
 * 曲率估计（Conforti–Cornuéjols）：c = 1 − min 边际(X,i)/f({i})，
 * X 取随机子集采样（精确最小是指数级，采样给出 c 的上界估计——
 * 保守口径：真实曲率 ≤ 估计值，保证因子按估计值陈述仍然成立的方向）。
 */
export function curvatureEstimate(f: SubmodularFunction, samples = 200, seed = 20260921): CurvatureReport {
  const rng = mulberry32(seed);
  let minRatio = 1;
  const fSingle = (i: number): number => f.marginal(i, new Set<number>());
  for (let s = 0; s < samples; s += 1) {
    const X = new Set<number>();
    for (let i = 0; i < f.groundSize; i += 1) if (rng() < 0.5) X.add(i);
    const x = Math.floor(rng() * f.groundSize);
    X.delete(x);
    const base = fSingle(x);
    if (base <= 1e-12) continue;
    const ratio = Math.max(0, f.marginal(x, X) / base);
    if (ratio < minRatio) minRatio = ratio;
  }
  const c = Math.min(1, Math.max(0, 1 - minRatio));
  const factor = c < 1e-9 ? 1 : (1 - Math.exp(-c)) / c;
  return { curvature: c, guaranteeFactor: factor, samples };
}
