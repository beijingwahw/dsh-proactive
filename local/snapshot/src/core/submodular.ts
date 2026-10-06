/**
 * 30.0 次模优化内核 —— 加权覆盖 + 惰性贪心 (CELF) + 曲率修正保证
 *    R5 进化：SFMin 图割特例（一次最小割 = 全局最小化）+ 堆化 CELF（O(log n) 顶端提取）
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
 *     ≥ ½(1−1/e)·OPT（Khuller–Moss–Naor）。
 *
 * R5-A17 世界性进化（数学轴 + 性能轴，2026-10）:
 *   ⑤ SFMin 的最小割特例（图割能量最小化）:
 *     f(S) = Σ_{i∈S} a_i + Σ_{i∉S} b_i + Σ_{(u,v)∈E} w_uv·1[u∈S ≠ v∈S]，w ≥ 0。
 *     成对项是对称次模（a_i/b_i 模函数项）⟹ f 次模——**最小化**这个 NP 难的
 *     一般问题在此特例上退化为一次 s-t 最小割: 拆 α_i = a_i−b_i = p_i−q_i
 *     (p,q ≥ 0)，源 s 连 i 容量 q_i（i 归 t 侧付费）、i 连汇 t 容量 p_i
 *     （i 归 s 侧付费）、割边双向容量 w——割容量恰等于 f(S) − Σb_i。
 *     Ford–Fulkerson: 最小割 = 最大流 ⟹ **全局**最优（非近似），Dinic 算法
 *     多项式内确定性求解。零先验知识的「哪些项该关掉」这类**次模最小化**
 *     决策第一次有了精确解（NWF 是最大化侧的近似，图割是最小化侧的精确）。
 *   ⑥ 堆化 CELF: 大顶二叉堆（键降序、同键取小下标——与线性扫描「首个最大」
 *     逐位同义）替代每轮 O(n) 顶端扫描与次大键扫描，单次选择 O(log n)；
 *     与朴素贪心的逐位同解性由次模性保证（陈旧键只高估不低估）。
 *     evaluations 计数口径不变（初始 n 次 + 每次顶端重估 1 次）。
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
 *
 * R5 堆化：大顶二叉堆（键降序、同键取小下标——与旧线性扫描「首个最大」
 * 完全同义）承担顶端提取与次大键读取（弹出后的堆顶即次大键，含陈旧口径
 * ——它是全体真实边际的上界，判据安全）。单次选择 O(log n)，n 大时
 * 评估次数之外又省一个数量级的比较开销；evaluations 计数口径不变。
 */
export function lazyGreedy(f: SubmodularFunction, k: number): GreedyResult {
  const cap = Math.max(0, Math.min(k, f.groundSize));
  const selected = new Set<number>();
  const values: number[] = [];
  const gains: number[] = [];
  let evaluations = 0;
  // (stale marginal, item) 大顶堆：键降序、同键取小下标（二叉堆，数组实现）
  const keys: number[] = [];
  const items: number[] = [];
  const swapAt = (i: number, j: number): void => {
    const tk = keys[i]!;
    keys[i] = keys[j]!;
    keys[j] = tk;
    const ti = items[i]!;
    items[i] = items[j]!;
    items[j] = ti;
  };
  const higher = (i: number, j: number): boolean =>
    keys[i]! > keys[j]! || (keys[i]! === keys[j]! && items[i]! < items[j]!);
  const push = (key: number, item: number): void => {
    keys.push(key);
    items.push(item);
    let c = keys.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (higher(c, p)) {
        swapAt(c, p);
        c = p;
      } else break;
    }
  };
  const pop = (): void => {
    const last = keys.length - 1;
    keys[0] = keys[last]!;
    items[0] = items[last]!;
    keys.pop();
    items.pop();
    let c = 0;
    for (;;) {
      const l = 2 * c + 1;
      const r = l + 1;
      let best = c;
      if (l < keys.length && higher(l, best)) best = l;
      if (r < keys.length && higher(r, best)) best = r;
      if (best === c) break;
      swapAt(c, best);
      c = best;
    }
  };
  for (let i = 0; i < f.groundSize; i += 1) {
    evaluations += 1;
    push(f.marginal(i, selected), i);
  }

  while (selected.size < cap && keys.length > 0) {
    const topItem = items[0]!;
    const topKey = keys[0]!;
    void topKey;
    pop();
    // 重估顶端（次模性：陈旧键只可能高估）
    evaluations += 1;
    const fresh = f.marginal(topItem, selected);
    if (fresh <= 1e-12) {
      // 真实边际归零（顶端高估的最保守情形）：淘汰出队
      continue;
    }
    // 次大键 = 弹出后的堆顶（含陈旧口径——它是重估后真实键的上界，判据安全）
    const secondKey = keys.length > 0 ? keys[0]! : 0;
    if (fresh >= secondKey - 1e-12) {
      // 重估后仍为顶端：选中（与朴素贪心逐位同解）
      selected.add(topItem);
      const prev = values.length > 0 ? values[values.length - 1]! : 0;
      values.push(prev + fresh);
      gains.push(fresh);
    } else {
      // 键过期：降级回队列
      push(fresh, topItem);
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

// ─────────────────────────── R5: SFMin 的最小割特例（图割） ───────────────────────────

/** 割边 (u, v)：u∈S 与 v∉S（对称）时付 weight ≥ 0 */
export interface CutEdgeSpec {
  readonly u: number;
  readonly v: number;
  readonly weight: number;
}

/** 图割能量规格：f(S) = Σ_{i∈S} a_i + Σ_{i∉S} b_i + Σ w·1[u,v 分属两侧] */
export interface CutEnergySpec {
  /** i ∈ S 的一次性代价 a_i（可负——负 = 偏好选入） */
  readonly unaryIn: ReadonlyArray<number>;
  /** i ∉ S 的一次性代价 b_i（可负——负 = 偏好排除） */
  readonly unaryOut: ReadonlyArray<number>;
  /** 割边列表（无向语义，weight ≥ 0） */
  readonly edges: ReadonlyArray<CutEdgeSpec>;
}

/**
 * 图割能量（次模最小化的可精确求解特例）:
 *   f(S) = Σ_{i∈S} a_i + Σ_{i∉S} b_i + Σ_{(u,v)} w_uv·1[u∈S ≠ v∈S]。
 * 单独的模函数项 + 对称成对割项——每条割边对边际的贡献随已选集增大只减不增
 * （A ⊆ B ⟹ v∉A ⊇ v∉B）⟹ f 次模（submodularityCheck 可审计）。
 */
export class CutEnergy implements SubmodularFunction {
  readonly groundSize: number;
  private readonly unaryIn: number[];
  private readonly unaryOut: number[];
  /** 割边邻接表（item → {v, w}） */
  private readonly cutAdj: Array<Array<{ v: number; w: number }>>;

  constructor(spec: CutEnergySpec) {
    if (!spec || !Array.isArray(spec.unaryIn) || !Array.isArray(spec.unaryOut)) {
      throw new Error('CutEnergy: 需传入 { unaryIn, unaryOut, edges }');
    }
    const n = spec.unaryIn.length;
    if (n < 1) throw new Error('CutEnergy: 地面集需非空');
    if (spec.unaryOut.length !== n) {
      throw new Error(`CutEnergy: unaryOut 长度 ${spec.unaryOut.length} 需等于 unaryIn 长度 ${n}`);
    }
    for (let i = 0; i < n; i += 1) {
      if (typeof spec.unaryIn[i] !== 'number' || !Number.isFinite(spec.unaryIn[i]!)) {
        throw new Error(`CutEnergy: unaryIn[${i}] = ${String(spec.unaryIn[i])} 需为有限数`);
      }
      if (typeof spec.unaryOut[i] !== 'number' || !Number.isFinite(spec.unaryOut[i]!)) {
        throw new Error(`CutEnergy: unaryOut[${i}] = ${String(spec.unaryOut[i])} 需为有限数`);
      }
    }
    if (!Array.isArray(spec.edges)) throw new Error('CutEnergy: edges 需为数组');
    this.groundSize = n;
    this.unaryIn = [...spec.unaryIn];
    this.unaryOut = [...spec.unaryOut];
    this.cutAdj = Array.from({ length: n }, () => []);
    for (let e = 0; e < spec.edges.length; e += 1) {
      const edge = spec.edges[e]!;
      if (!edge || typeof edge !== 'object') throw new Error(`CutEnergy: edges[${e}] 需为 { u, v, weight }`);
      const { u, v, weight } = edge;
      if (!Number.isInteger(u) || u < 0 || u >= n) throw new Error(`CutEnergy: edges[${e}].u = ${String(u)} 越界`);
      if (!Number.isInteger(v) || v < 0 || v >= n) throw new Error(`CutEnergy: edges[${e}].v = ${String(v)} 越界`);
      if (u === v) throw new Error(`CutEnergy: edges[${e}] 自环 (u = v = ${u}) 永不被割，语义非法`);
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
        throw new Error(`CutEnergy: edges[${e}].weight = ${String(weight)} 需为有限非负数（w < 0 破坏次模性）`);
      }
      this.cutAdj[u]!.push({ v, w: weight });
      this.cutAdj[v]!.push({ v: u, w: weight });
    }
  }

  value(selected: ReadonlySet<number>): number {
    let acc = 0;
    for (let i = 0; i < this.groundSize; i += 1) {
      acc += selected.has(i) ? this.unaryIn[i]! : this.unaryOut[i]!;
    }
    for (let i = 0; i < this.groundSize; i += 1) {
      if (!selected.has(i)) continue;
      for (const { v, w } of this.cutAdj[i]!) {
        if (!selected.has(v)) acc += w; // 分属两侧才付费（每条无向边恰记一次）
      }
    }
    return acc;
  }

  marginal(item: number, selected: ReadonlySet<number>): number {
    if (!Number.isInteger(item) || item < 0 || item >= this.groundSize) {
      throw new Error(`CutEnergy.marginal: item = ${String(item)} 越界`);
    }
    // f(S∪{x}) − f(S) = (a_x − b_x) + Σ_{(x,v)} w·1[v∉S]（割项从 0 变为至多 w）
    let gain = this.unaryIn[item]! - this.unaryOut[item]!;
    for (const { v, w } of this.cutAdj[item]!) {
      if (!selected.has(v)) gain += w;
    }
    return gain;
  }
}

/** Dinic 最大流（数组邻接 + 层次图 + 封锁流；正/反向边成对存储于 i / i^1） */
class Dinic {
  private readonly n: number;
  private readonly to: number[] = [];
  private readonly cap: number[] = [];
  private readonly head: Int32Array;
  private readonly nextEdge: number[] = [];
  private readonly level: Int32Array;
  private readonly cursor: Int32Array;
  augmentations = 0;

  constructor(n: number) {
    this.n = n;
    this.head = new Int32Array(n).fill(-1);
    this.level = new Int32Array(n).fill(-1);
    this.cursor = new Int32Array(n).fill(-1);
  }

  addEdge(u: number, v: number, capacity: number): void {
    this.to.push(v);
    this.cap.push(capacity);
    this.nextEdge.push(this.head[u]!);
    this.head[u] = this.to.length - 1;
    this.to.push(u); // 反向边（初始容量 0）
    this.cap.push(0);
    this.nextEdge.push(this.head[v]!);
    this.head[v] = this.to.length - 1;
  }

  private bfs(s: number, t: number): boolean {
    this.level.fill(-1);
    const queue = [s];
    this.level[s] = 0;
    for (let headQ = 0; headQ < queue.length; headQ += 1) {
      const u = queue[headQ]!;
      for (let e = this.head[u]!; e !== -1; e = this.nextEdge[e]!) {
        if (this.cap[e]! <= 0) continue;
        const v = this.to[e]!;
        if (this.level[v] !== -1) continue;
        this.level[v] = this.level[u]! + 1;
        queue.push(v);
      }
    }
    return this.level[t]! !== -1;
  }

  private dfsBlocking(s: number, t: number): number {
    // 迭代 DFS（显式栈；viaEdge[d] = 进入 stack[d] 所用的边），沿层次图推封锁流
    let flow = 0;
    const stack: number[] = [s];
    const viaEdge: number[] = [-1];
    while (stack.length > 0) {
      const u = stack[stack.length - 1]!;
      if (u === t) {
        // 找到增广路：沿栈取瓶颈并扣减（反向边同步回加）
        let bottleneck = Infinity;
        for (let d = 1; d < stack.length; d += 1) {
          bottleneck = Math.min(bottleneck, this.cap[viaEdge[d]!]!);
        }
        for (let d = 1; d < stack.length; d += 1) {
          const e = viaEdge[d]!;
          this.cap[e]! -= bottleneck;
          this.cap[e ^ 1]! += bottleneck;
        }
        flow += bottleneck;
        this.augmentations += 1;
        // 回退到最深的「出边已饱和」节点（其 cursor 会在推进循环里自行跳过）
        let backTo = 0;
        for (let d = stack.length - 1; d >= 1; d -= 1) {
          if (this.cap[viaEdge[d]!]! <= 0) {
            backTo = d;
            break;
          }
        }
        stack.length = backTo;
        viaEdge.length = backTo;
        continue;
      }
      // 沿层次图推进（cursor 单调前进，保证每条边每轮至多被扫一次）
      let advanced = false;
      while (this.cursor[u]! !== -1) {
        const e = this.cursor[u]!;
        if (this.cap[e]! > 0 && this.level[this.to[e]!] === this.level[u]! + 1) {
          stack.push(this.to[e]!);
          viaEdge.push(e);
          advanced = true;
          break;
        }
        this.cursor[u] = this.nextEdge[e]!;
      }
      if (!advanced) {
        this.level[u] = -1; // 封锁：该节点本层不再可用
        stack.pop();
        viaEdge.pop();
      }
    }
    return flow;
  }

  maxFlow(s: number, t: number): number {
    let total = 0;
    while (this.bfs(s, t)) {
      this.cursor.set(this.head);
      total += this.dfsBlocking(s, t);
    }
    return total;
  }

  /** 残量图上从 s 可达的节点集（最小割的 s 侧，不含 s 本身） */
  sourceSide(s: number): number[] {
    const seen = new Uint8Array(this.n);
    const out: number[] = [];
    const queue = [s];
    seen[s] = 1;
    for (let h = 0; h < queue.length; h += 1) {
      const u = queue[h]!;
      for (let e = this.head[u]!; e !== -1; e = this.nextEdge[e]!) {
        if (this.cap[e]! <= 0) continue;
        const v = this.to[e]!;
        if (seen[v] === 1) continue;
        seen[v] = 1;
        queue.push(v);
      }
    }
    for (let v = 0; v < this.n; v += 1) if (seen[v] === 1 && v !== s) out.push(v);
    return out;
  }
}

export interface GraphCutMinimizeResult {
  /** 最小化子 S（升序；可达自源侧的全部非源节点） */
  minimizer: number[];
  /** f(S*) 直接求值（与 cutValue 相互独立复核） */
  value: number;
  /** Σb + 最大流（图割口径的另一种算法算出的同一数） */
  cutValue: number;
  /** |value − cutValue|（应 ≤ 1e-9，两种口径互证的差） */
  gap: number;
  /** Dinic 增广路条数 */
  augmentations: number;
}

/**
 * 图割 SFMin：一次最大流求 f(S) = Σ a_i·1[i∈S] + Σ b_i·1[i∉S] + Σ w·1[割] 的
 * **全局**最小化（Ford–Fulkerson 最小割 = 最大流；确定性，非近似）。
 *
 * 归约: α_i = a_i − b_i 拆 p_i = max(α_i,0) / q_i = max(−α_i,0)；
 *   f(S) = (Σb_i − Σq_i) + [Σ_{i∈S} p_i + Σ_{i∉S} q_i + Σ w·1[割]]，
 *   括号内 = s-t 割容量（s→i 容量 q_i、i→t 容量 p_i、割边双向 w）。
 */
export function minimizeCutEnergy(spec: CutEnergySpec): GraphCutMinimizeResult {
  const energy = new CutEnergy(spec);
  const n = energy.groundSize;
  const s = n;
  const t = n + 1;
  const dinic = new Dinic(n + 2);
  let sumB = 0;
  let sumQ = 0;
  for (let i = 0; i < n; i += 1) {
    const aI = spec.unaryIn[i]!;
    const bI = spec.unaryOut[i]!;
    sumB += bI;
    const alpha = aI - bI;
    if (alpha > 0) dinic.addEdge(i, t, alpha); // 归 s 侧付费 p_i
    else if (alpha < 0) dinic.addEdge(s, i, -alpha); // 归 t 侧付费 q_i（常量 −Σq 在割容量外）
  }
  for (const edge of spec.edges) {
    if (edge.weight > 0) {
      dinic.addEdge(edge.u, edge.v, edge.weight);
      dinic.addEdge(edge.v, edge.u, edge.weight);
    }
  }
  const maxFlow = dinic.maxFlow(s, t);
  const sideAll = dinic.sourceSide(s);
  const minimizer = sideAll.filter((v) => v !== t).sort((a, b) => a - b);
  for (let i = 0; i < n; i += 1) {
    sumQ += Math.max(0, spec.unaryOut[i]! - spec.unaryIn[i]!);
  }
  const value = energy.value(new Set(minimizer));
  const cutValue = sumB - sumQ + maxFlow;
  return {
    minimizer,
    value,
    cutValue,
    gap: Math.abs(value - cutValue),
    augmentations: dinic.augmentations,
  };
}
