/**
 * optimal-transport.ts — 最优传输内核（项目 17.0「漂移检测看见分布的形状」质变基座）
 *
 * 升级前的根本局限（均值水位检测的形状盲区）：
 * - 12.0 的 e-过程 / 置信序列盯的是**均值水位**（μ 是否越过水位线）——
 *   一个均值不变、形状巨变的分布（双峰化、方差爆炸、尾部变厚）在
 *   水位线检测下完全隐形：μ̂ 纹丝不动，系统却已经换了世界；
 * - z-score / 方差检测只看一两个矩——矩相同而分布不同的两个世界
 *   无穷多，二阶统计不足以充当「世界没变」的证书；
 * - KL 散度在不相交支撑（旧窗口全是 0.6，新窗口全是 0.9）上
 *   发散为 ∞，既不可比较也不可累积；平方误差只看均值差。
 *
 * 本内核引入 Monge–Kantorovich 最优传输理论（Villani 2009 Fields /
 * Cuturi 2013 Sinkhorn / Peyré–Cuturi 2019 计算最优传输）：
 *
 * 1. **一维精确 Wasserstein-p**（分位数耦合）：
 *      W_p(μ, ν) = ( ∫₀¹ |F_μ⁻¹(q) − F_ν⁻¹(q)|ᵖ dq )^{1/p}
 *    一维情形最优耦合就是分位数单调配对（秩相依 / comonotone 耦合），
 *    经验分布上排序后逐分位配对即**精确值**——不是近似，O(n log n)。
 *    W₁ = 「把分布 μ 的土搬到 ν 的最小搬运代价」，单位就是被监测
 *    量本身的单位（质量分 / 延迟毫秒）——可解释、可设定阈。
 *
 * 2. **熵正则 Sinkhorn（任意代价矩阵的离散 OT）**：
 *      min_π ⟨C, π⟩ + ε·KL(π ‖ a bᵀ),  s.t. π1 = μ, πᵀ1 = ν
 *    Cuturi 2013：Sinkhorn 不动点迭代在 Hilbert 度量下收缩，
 *    O(k²) 每步、线性收敛；对数域稳定化（log-sum-exp）防下溢。
 *    代价矩阵可以是任意「行为距离」——预算在 niche 网格间的
 *    最小移动方案（探索预算再平衡）有了数学最优解。
 *
 * 3. **Wasserstein 重心（barycenter）**：
 *    一维固定质量情形，重心 = 分位数平均：B⁻¹(q) = Σ wᵢ Fᵢ⁻¹(q)。
 *    多个窗口 / 多个模型的分布信息融合为一条「共识分布」——
 *    比「平均的均值」保留全部形状（均值融合丢掉形状，重心融合
 *    保留形状），11.0 定律归纳的分布版。
 *
 * 4. **形状感知漂移监视器（TransportDriftMonitor）**：
 *    滑动窗 vs 基准窗的 W₁ 持续计算；阈值不是拍的——历史窗口间
 *    W₁ 的经验分布给出「正常漂移」的分位数（conformal 式阈值，
 *    与 13.0 同一哲学：让数据自己定阈），超越即报 shape-drift。
 *
 * 与 12.0 的关系：12.0 盯水位（均值），本内核盯形状（全分布）——
 * 「水平没变但世界换了」第一次可见；与 13.0 的关系：保形覆盖保证
 * 在分布漂移下失效，本内核是保形区间的**绊线**（先见漂移、再谈覆盖）；
 * 与 14.0 的关系：Sinkhorn 给出探索预算跨 niche 的最优搬运方案，
 * 多样性维护从「均匀采样」升维为「最小代价再平衡」。
 *
 * R5 进化（第五轮·信息几何世界性进化）：
 * 5. **精确一维 Wasserstein-p（CDF 双指针合并，O((m+n)log(m+n))）**：
 *      经验分布（任意样本数 m ≠ n）的最优单调耦合由西北角法则给出——
 *      按剩余质量逐段配对，W_p = (Σ_k w_k·|a_(i)−b_(j)|ᵖ)^{1/p} 是**精确值**
 *      （不是分位网格插值近似）；等样本数时退化为逐秩配对。W₁ 是真度量
 *      （恒等 / 对称 / 三角不等式逐条可验）。
 * 6. **Sinkhorn 散度（去偏，Feydy et al. 2019）**：
 *      S_ε(μ,ν) = OT_ε(μ,ν) − ½·OT_ε(μ,μ) − ½·OT_ε(ν,ν)
 *      带偏的 ⟨C,π_ε⟩ 含 ε 级熵偏置且 S_ε(μ,μ) ≠ 0；去偏后（共享支撑
 *      + 对称代价）S_ε(μ,μ) = 0、S_ε(μ,ν) > 0（μ≠ν）、ε → 0 收敛到真
 *      W——点测度（并支撑代价）情形对任意 ε **精确**去偏（−ε 偏置被
 *      自能项逐位抵消）。一般非对称交叉代价不保证正性（诚实边界）。
 * 7. **热启动 + 零分配迭代（性能）**：SinkhornConfig.warmStart 接收
 *      上一解的对偶势 (f,g)；SinkhornResult.potentials 回传当前解——
 *      序列问题（分布微移、预算微调）从不动点附近起步，迭代数骤降；
 *      不动点在 Hilbert 度量下唯一（至多差可加常数），冷/热解一致。
 *      迭代内循环去除每行/列两次 .map 分配（预分配缓冲），浮点序不变。
 * 8. **边际（KKT）残差报告（数值稳健性）**：SinkhornResult.marginalResidual
 *      = max|π1−μ|, |πᵀ1−ν|——原 residual 只报对偶势漂移，边际残差是
 *      约束满足度的直接读数；TransportDriftEvent.at 改用确定性观测
 *      序号（逻辑时钟——内核宪章：无 Date.now/Math.random，全程可复现）。
 */

// ─────────────────────────── 一维精确 Wasserstein ───────────────────────────

/**
 * 一维经验 Wasserstein-p 距离（精确：分位数单调耦合）。
 *
 * 两个样本集各自视为等权经验分布；排序后按分位配对：
 *   W_p = ( (1/m) Σ |a_(i) − b_(i)|ᵖ )^{1/p}（m = n 时逐秩配对；
 *   m ≠ n 时按经验分位数网格插值）。
 *
 * @param p 距离阶数（1 = 搬运代价，2 = 能量距离；缺省 1）
 */
export function wasserstein1D(samplesA: readonly number[], samplesB: readonly number[], p = 1): number {
  const a = [...samplesA].filter(Number.isFinite).sort((x, y) => x - y);
  const b = [...samplesB].filter(Number.isFinite).sort((x, y) => x - y);
  if (a.length === 0 || b.length === 0) return 0;
  const grid = 256; // 分位数网格（m=n 时退化为逐秩精确配对）
  let acc = 0;
  for (let i = 0; i < grid; i += 1) {
    const q = (i + 0.5) / grid;
    const delta = quantileSorted(a, q) - quantileSorted(b, q);
    acc += Math.pow(Math.abs(delta), p);
  }
  return Math.pow(acc / grid, 1 / p);
}

/** 排序数组的经验分位数（线性插值；q ∈ [0,1]） */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * 精确一维经验 Wasserstein-p（R5）：CDF 双指针西北角合并，任意样本数。
 *
 * 一维最优传输 = 分位数单调配对（comonotone 耦合）；经验分布（等权
 * 点质量）的该耦合由西北角法则显式给出——按「当前样本剩余质量」逐段
 * 配对，段质量 w_k 取双方剩余量的较小者：
 *   W_p = ( Σ_k w_k·|a_(i) − b_(j)|ᵖ )^{1/p}，Σ_k w_k = 1
 * 这是**精确值**（Villani 2009, Thm 2.18 一维情形），不是分位网格插值
 * 近似；排序后 O(m+n)，总复杂度 O((m+n)log(m+n))。m = n 时退化为
 * 逐秩配对 |a_(i) − b_(i)|。W₁ 在实轴分布上满足度量公理（恒等 /
 * 对称 / 三角），可直接做距离公理的随机检验。
 */
export function wassersteinExact1D(samplesA: readonly number[], samplesB: readonly number[], p = 1): number {
  if (!(p >= 1)) throw new Error('wassersteinExact1D: p 必须 ≥ 1');
  const a = [...samplesA].filter(Number.isFinite).sort((x, y) => x - y);
  const b = [...samplesB].filter(Number.isFinite).sort((x, y) => x - y);
  if (a.length === 0 || b.length === 0) return 0;
  const n = a.length;
  const m = b.length;
  let i = 0;
  let j = 0;
  let remA = 1; // 当前 a[i] 的剩余质量（占自身点质量的比分 ∈ (0,1]）
  let remB = 1;
  let acc = 0;
  while (i < n && j < m) {
    const w = Math.min(remA / n, remB / m);
    acc += w * Math.pow(Math.abs(a[i]! - b[j]!), p);
    remA -= w * n;
    remB -= w * m;
    if (remA <= 1e-12) {
      i += 1;
      remA = 1;
    }
    if (remB <= 1e-12) {
      j += 1;
      remB = 1;
    }
  }
  return Math.pow(acc, 1 / p);
}

// ─────────────────────────── Wasserstein 重心 ───────────────────────────

/**
 * 一维 Wasserstein 重心（分位数平均）：多个经验分布按权重融合为一条共识分布。
 *
 * B⁻¹(q) = Σᵢ wᵢ Fᵢ⁻¹(q)——保留全部形状信息的「分布平均」
 * （均值的平均只留一个数，重心的平均留一条曲线）。
 *
 * @returns 重心的代表样本集（分位数网格采样），可直接参与后续 W 距离计算
 */
export function wassersteinBarycenter1D(
  distributions: readonly (readonly number[])[],
  weights?: readonly number[],
): number[] {
  const valid = distributions.filter((d) => d.length > 0);
  if (valid.length === 0) return [];
  const w =
    weights && weights.length === valid.length && weights.reduce((s, x) => s + x, 0) > 0
      ? weights.map((x) => x / weights.reduce((s, y) => s + y, 0))
      : valid.map(() => 1 / valid.length);
  const sorted = valid.map((d) => [...d].sort((x, y) => x - y));
  const grid = 128;
  const result: number[] = [];
  for (let i = 0; i < grid; i += 1) {
    const q = (i + 0.5) / grid;
    result.push(sorted.reduce((acc, s, k) => acc + w[k]! * quantileSorted(s, q), 0));
  }
  return result;
}

// ─────────────────────────── Sinkhorn 熵正则最优传输 ───────────────────────────

/** Sinkhorn 求解配置 */
export interface SinkhornConfig {
  /** 熵正则强度 ε（越小越接近精确 OT、收敛越慢；缺省 0.05） */
  epsilon: number;
  /** 最大迭代数（缺省 300） */
  maxIterations: number;
  /** 收敛容差（对偶势漂移 ‖Δf‖∞,‖Δg‖∞；缺省 1e-8） */
  tolerance: number;
  /** 代价矩阵数值范围保护（|C| 上限；缺省 100） */
  maxCost: number;
  /** 热启动对偶势（R5）：上一解的 (f,g) 作为迭代起点——序列问题迭代数骤降 */
  warmStart?: { f: readonly number[]; g: readonly number[] };
}

export const DEFAULT_SINKHORN_CONFIG: SinkhornConfig = {
  epsilon: 0.05,
  maxIterations: 300,
  tolerance: 1e-8,
  maxCost: 100,
};

/** Sinkhorn 求解结果 */
export interface SinkhornResult {
  /** 传输方案 π（π[i][j] = 从 i 搬到 j 的质量） */
  plan: number[][];
  /** 熵正则传输代价 ⟨C, π⟩（+ ε·KL 已剔除的主项） */
  cost: number;
  /** 收敛判定 */
  converged: boolean;
  /** 实际迭代数 */
  iterations: number;
  /** 边际约束最大残差 */
  residual: number;
  /** R5：边际约束残差 max(|π1−μ|, |πᵀ1−ν|)——约束满足度的直接读数 */
  marginalResidual: number;
  /** R5：收敛对偶势（乘子），可回传 warmStart 复用（热启动） */
  potentials: { f: number[]; g: number[] };
}

/**
 * 对数域稳定化 Sinkhorn 求解器
 *
 * 不动点迭代（Hilbert 度量压缩，Franklin–Lorenz 1989；Cuturi 2013）：
 *   f_i ← −ε log Σ_j exp((g_j − C_ij)/ε) a_j
 *   g_j ← −ε log Σ_i exp((f_i − C_ij)/ε) b_i
 * 全程 log-sum-exp，指数下溢免疫；f、g 为对偶势（Kantorovich 最优
 * 对偶变量的熵正则版）。R5：迭代内循环改预分配缓冲（去除每行/列
 * 两次 .map 临时数组分配，浮点运算次序不变——解逐位一致）；支持
 * warmStart 热启动（上一解的对偶势作起点；不动点唯一，冷/热收敛同解）。
 */
export function sinkhorn(
  cost: readonly (readonly number[])[],
  sourceMass: readonly number[],
  targetMass: readonly number[],
  config?: Partial<SinkhornConfig>,
): SinkhornResult {
  const cfg = { ...DEFAULT_SINKHORN_CONFIG, ...config };
  const core = solveSinkhornCore(cost, sourceMass, targetMass, cfg);
  if (core === undefined) {
    return { plan: [], cost: 0, converged: false, iterations: 0, residual: Infinity, marginalResidual: Infinity, potentials: { f: [], g: [] } };
  }
  return {
    plan: core.plan,
    cost: round(core.transportCost),
    converged: core.converged,
    iterations: core.iterations,
    residual: round(core.residual),
    marginalResidual: round(core.marginalResidual),
    potentials: { f: Array.from(core.f), g: Array.from(core.g) },
  };
}

/** Sinkhorn 核心求解（内部共享：sinkhorn / sinkhornDivergence 同一代码路径） */
interface SinkhornCoreResult {
  f: Float64Array;
  g: Float64Array;
  plan: number[][];
  transportCost: number;
  converged: boolean;
  iterations: number;
  residual: number;
  marginalResidual: number;
  /** ⟨f,a⟩ + ⟨g,b⟩（对偶目标主项，OT_ε 公式用） */
  potentialDot: number;
  /** Σ_ij π_ij（收敛时应为 1） */
  planMass: number;
  a: number[];
  b: number[];
}

function solveSinkhornCore(
  cost: readonly (readonly number[])[],
  sourceMass: readonly number[],
  targetMass: readonly number[],
  cfg: SinkhornConfig,
): SinkhornCoreResult | undefined {
  const n = sourceMass.length;
  const m = targetMass.length;
  if (n === 0 || m === 0 || cost.length !== n) return undefined;
  // 归一化质量（允许输入未归一权重）
  const sumA = sourceMass.reduce((s, x) => s + x, 0);
  const sumB = targetMass.reduce((s, x) => s + x, 0);
  if (!(sumA > 0) || !(sumB > 0)) return undefined;
  const a = sourceMass.map((x) => x / sumA);
  const b = targetMass.map((x) => x / sumB);
  // 对数域代价（截断保护 + ε 缩放）
  const logC: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const row: number[] = [];
    for (let j = 0; j < m; j += 1) {
      const c = Math.max(0, Math.min(cfg.maxCost, Math.abs(cost[i]?.[j] ?? 0)));
      row.push(-c / cfg.epsilon);
    }
    logC.push(row);
  }
  // 对数域质量（0 质量 → −∞ 参与度为 0）
  const logA = a.map((x) => (x > 0 ? Math.log(x) : -Infinity));
  const logB = b.map((x) => (x > 0 ? Math.log(x) : -Infinity));

  // 热启动：维度匹配则从上一解的对偶势起步（缺省 0——与原口径逐位一致）
  const f = new Float64Array(n);
  const g = new Float64Array(m);
  const warm = cfg.warmStart;
  if (warm && warm.f.length === n && warm.g.length === m) {
    for (let i = 0; i < n; i += 1) {
      const v = warm.f[i]!;
      f[i] = Number.isFinite(v) ? v : 0;
    }
    for (let j = 0; j < m; j += 1) {
      const v = warm.g[j]!;
      g[j] = Number.isFinite(v) ? v : 0;
    }
  }
  const prevF = new Float64Array(f);
  const prevG = new Float64Array(g);
  let converged = false;
  let iterations = 0;
  let residual = Infinity;
  // 预分配行/列缓冲（R5：去除迭代内 .map 分配；元素运算次序与原实现一致）
  const rowBuf = new Array<number>(m);
  const colBuf = new Array<number>(n);

  for (let iter = 0; iter < cfg.maxIterations; iter += 1) {
    iterations = iter + 1;
    // f 行更新：f_i = −ε log Σ_j exp((g_j − C_ij)/ε + log b_j)
    for (let i = 0; i < n; i += 1) {
      const row = logC[i]!;
      for (let j = 0; j < m; j += 1) rowBuf[j] = g[j]! + row[j]! + logB[j]!;
      f[i] = -logSumExp(rowBuf);
    }
    // g 列更新：g_j = −ε log Σ_i exp((f_i − C_ij)/ε + log a_i)
    for (let j = 0; j < m; j += 1) {
      for (let i = 0; i < n; i += 1) colBuf[i] = f[i]! + logC[i]![j]! + logA[i]!;
      g[j] = -logSumExp(colBuf);
    }
    // 收敛判据：对偶势（乘子）漂移（边际在每次更新后恒精确，不具判据力）
    let maxDrift = 0;
    for (let i = 0; i < n; i += 1) maxDrift = Math.max(maxDrift, Math.abs(f[i]! - prevF[i]!));
    for (let j = 0; j < m; j += 1) maxDrift = Math.max(maxDrift, Math.abs(g[j]! - prevG[j]!));
    residual = maxDrift;
    if (maxDrift < cfg.tolerance) {
      converged = true;
      break;
    }
    prevF.set(f);
    prevG.set(g);
  }

  // 还原传输方案：π_ij = a_i·b_j·exp(f_i + g_j − C_ij/ε)
  //（对偶势口径：u_i = a_i·e^{f_i}，v_j = b_j·e^{g_j}，π = diag(u) K diag(v)）
  const plan: number[][] = [];
  let transportCost = 0;
  let planMass = 0;
  let potentialDot = 0;
  for (let i = 0; i < n; i += 1) {
    const row: number[] = [];
    for (let j = 0; j < m; j += 1) {
      const pij = a[i]! * b[j]! * Math.exp(f[i]! + g[j]! + logC[i]![j]!);
      row.push(pij);
      transportCost += pij * Math.abs(cost[i]![j] ?? 0);
      planMass += pij;
    }
    plan.push(row);
    potentialDot += a[i]! * f[i]!;
  }
  for (let j = 0; j < m; j += 1) potentialDot += b[j]! * g[j]!;
  // 边际（KKT）残差：max |π1 − a|, |πᵀ1 − b|（R5：约束满足度直接读数）
  let marginalResidual = 0;
  for (let i = 0; i < n; i += 1) {
    let s = 0;
    for (let j = 0; j < m; j += 1) s += plan[i]![j]!;
    marginalResidual = Math.max(marginalResidual, Math.abs(s - a[i]!));
  }
  for (let j = 0; j < m; j += 1) {
    let s = 0;
    for (let i = 0; i < n; i += 1) s += plan[i]![j]!;
    marginalResidual = Math.max(marginalResidual, Math.abs(s - b[j]!));
  }
  return {
    f,
    g,
    plan,
    transportCost,
    converged,
    iterations,
    residual,
    marginalResidual,
    potentialDot,
    planMass,
    a,
    b,
  };
}

// ─────────────────────────── Sinkhorn 散度（去偏） ───────────────────────────

/** Sinkhorn 散度（去偏）结果 */
export interface SinkhornDivergenceResult {
  /** S_ε(μ,ν) = OT_ε(μ,ν) − ½·OT_ε(μ,μ) − ½·OT_ε(ν,ν)（≥ 0，μ=ν 时 = 0） */
  divergence: number;
  /** OT_ε(μ,ν)：熵正则传输主项（带偏） */
  otEps: number;
  /** OT_ε(μ,μ)：源侧自能项 */
  selfTermLeft: number;
  /** OT_ε(ν,ν)：目标侧自能项 */
  selfTermRight: number;
  /** ⟨C, π_ε⟩：带偏的传输代价（≥ 真 W₁——π_ε 对精确 OT 可行） */
  biasedCost: number;
  converged: boolean;
  iterations: number;
  residual: number;
  marginalResidual: number;
}

/**
 * Sinkhorn 散度（去偏，Feydy–Séjourné–Trouvé–Cuturi 2019）：
 *
 *   S_ε(μ,ν) = OT_ε(μ,ν) − ½·OT_ε(μ,μ) − ½·OT_ε(ν,ν)
 *   OT_ε(μ,ν) = ε·( ⟨f,a⟩ + ⟨g,b⟩ − Σ_ij a_i b_j e^{(f_i+g_j−C_ij)/ε} )
 *
 * 性质口径（诚实边界）：
 * - **共享支撑 + 对称代价**（C 同一核上定义、C = Cᵀ）：S_ε(μ,μ) = 0、
 *   S_ε(μ,ν) > 0（μ ≠ ν）、S_ε(μ,ν) = S_ε(ν,μ)、ε → 0 收敛精确 W——
 *   Feydy et al. 2019 的定理设定；点测度（并支撑代价矩阵）情形对任意
 *   ε **逐位精确**：S_ε = |c|（−ε 熵偏置被两个自能项各回补 ε/2）。
 * - 一般**非对称交叉代价**（源/目标不同支撑、自能项沿用交叉矩阵）：
 *   S_ε 可为负（无定理覆盖——去偏只保证自零与 ε→0 极限，不保证正性）；
 *   调用方按需选择口径，本函数不做掩盖。
 * 退化输入（空质量 / 非正质量）返回 divergence=NaN、converged=false。
 */
export function sinkhornDivergence(
  cost: readonly (readonly number[])[],
  sourceMass: readonly number[],
  targetMass: readonly number[],
  config?: Partial<SinkhornConfig>,
): SinkhornDivergenceResult {
  const cfg = { ...DEFAULT_SINKHORN_CONFIG, ...config };
  const main = solveSinkhornCore(cost, sourceMass, targetMass, cfg);
  if (main === undefined) {
    return {
      divergence: NaN,
      otEps: NaN,
      selfTermLeft: NaN,
      selfTermRight: NaN,
      biasedCost: NaN,
      converged: false,
      iterations: 0,
      residual: Infinity,
      marginalResidual: Infinity,
    };
  }
  // 自能项热启动：主解的对偶势是良好的同量级起点（对称问题收敛更快）
  const selfLeft = solveSinkhornCore(cost, main.a, main.a, { ...cfg, warmStart: { f: Array.from(main.f), g: Array.from(main.f) } });
  const selfRight = solveSinkhornCore(cost, main.b, main.b, { ...cfg, warmStart: { f: Array.from(main.g), g: Array.from(main.g) } });
  if (selfLeft === undefined || selfRight === undefined) {
    return {
      divergence: NaN,
      otEps: NaN,
      selfTermLeft: NaN,
      selfTermRight: NaN,
      biasedCost: NaN,
      converged: false,
      iterations: 0,
      residual: Infinity,
      marginalResidual: Infinity,
    };
  }
  const otEps = cfg.epsilon * (main.potentialDot - main.planMass);
  const termL = cfg.epsilon * (selfLeft.potentialDot - selfLeft.planMass);
  const termR = cfg.epsilon * (selfRight.potentialDot - selfRight.planMass);
  const divergence = otEps - 0.5 * termL - 0.5 * termR;
  return {
    divergence: round(divergence),
    otEps: round(otEps),
    selfTermLeft: round(termL),
    selfTermRight: round(termR),
    biasedCost: round(main.transportCost),
    converged: main.converged && selfLeft.converged && selfRight.converged,
    iterations: main.iterations + selfLeft.iterations + selfRight.iterations,
    residual: round(Math.max(main.residual, selfLeft.residual, selfRight.residual)),
    marginalResidual: round(Math.max(main.marginalResidual, selfLeft.marginalResidual, selfRight.marginalResidual)),
  };
}

/** log-sum-exp（数值稳定） */
function logSumExp(xs: readonly number[]): number {
  let max = -Infinity;
  for (const x of xs) if (x > max) max = x;
  if (max === -Infinity) return -Infinity;
  let acc = 0;
  for (const x of xs) acc += Math.exp(x - max);
  return max + Math.log(acc);
}

// ─────────────────────────── 形状感知漂移监视器 ───────────────────────────

/** 传输漂移监视器配置 */
export interface TransportDriftConfig {
  /** 滑动窗容量（近期样本；缺省 50） */
  windowSize: number;
  /** 基准窗容量（历史样本；缺省 200） */
  referenceSize: number;
  /** 漂移阈值的经验分位数（历史窗间 W₁ 的分位；缺省 0.95） */
  thresholdQuantile: number;
  /** 最小样本量（双方达标才开始判定；缺省 20） */
  minSamples: number;
  /** 严重度平滑因子（severity = W₁ / threshold 的自然缩放；缺省 1） */
  severityScale: number;
}

export const DEFAULT_TRANSPORT_DRIFT_CONFIG: TransportDriftConfig = {
  windowSize: 50,
  referenceSize: 200,
  thresholdQuantile: 0.95,
  minSamples: 20,
  severityScale: 1,
};

/** 漂移视图 */
export interface TransportDriftView {
  /** 窗口 vs 基准的 W₁（被监测量原单位） */
  w1: number;
  /** 自适应阈值（历史漂移的分位数） */
  threshold: number;
  /** 是否判定漂移 */
  drifting: boolean;
  /** 严重度 = w1 / threshold（>1 越多越严重） */
  severity: number;
  /** 方向洞察：均值位移量（窗口均值 − 基准均值） */
  meanShift: number;
  /** 形状洞察：分布展宽比（窗口 σ / 基准 σ；≈1 形状未变，>1 双峰化/尾部变厚） */
  spreadRatio: number;
  /** 漂移主成分：level（均值水位）/ shape（形状重排）/ both / none */
  kind: 'none' | 'level' | 'shape' | 'both';
  /** 样本量（窗口 / 基准） */
  samples: { window: number; reference: number };
  interpretation: string;
}

/** 漂移事件（翻转沿审计） */
export interface TransportDriftEvent {
  /** 观测序号（确定性逻辑时钟——R5 起替代 Date.now()，内核全程可复现） */
  at: number;
  kind: TransportDriftView['kind'];
  severity: number;
  w1: number;
  threshold: number;
}

/**
 * 形状感知传输漂移监视器
 *
 * 用法：
 *   const monitor = new TransportDriftMonitor();
 *   monitor.observe(0.82);  // 持续喂入被监测量（质量分 / 延迟 / 收益）
 *   monitor.drift();        // 任意时刻读取（W₁ 原单位 + 自适应阈值）
 *
 * 几何细节：基准窗取**滑动窗之前**的样本（两窗不相交）——若拿
 * 包含自身的历史当基准，W₁ 被窗口⊂基准的相关性系统性压低，
 * 阈值口径失真。阈值哲学（与 13.0 同源）：不拍脑袋——历史平稳期
 * 两两 W₁ 构成「正常漂移」经验分布，thresholdQuantile 分位即阈值；
 * 新 W₁ 入账前先裁决，漂移期样本不污染基准。
 */
export class TransportDriftMonitor {
  private readonly config: TransportDriftConfig;
  private readonly buffer: number[] = [];
  private readonly historyW1: number[] = [];
  private lastDrifting = false;
  private events: TransportDriftEvent[] = [];
  /** 观测序号（确定性逻辑时钟：observe 每调用一次 +1） */
  private tick = 0;

  constructor(config?: Partial<TransportDriftConfig>) {
    this.config = { ...DEFAULT_TRANSPORT_DRIFT_CONFIG, ...config };
  }

  /** 观测一次被监测量 */
  observe(x: number): TransportDriftView {
    this.tick += 1;
    const v = Number.isFinite(x) ? x : 0;
    this.buffer.push(v);
    if (this.buffer.length > this.config.referenceSize) this.buffer.shift();
    const view = this.drift();
    // 阈值记账：非漂移期的新 W₁ 入历史（漂移期样本不污染基准）
    if (!view.drifting && view.samples.window >= this.config.minSamples) {
      this.historyW1.push(view.w1);
      if (this.historyW1.length > 200) this.historyW1.shift();
    }
    // 翻转沿审计（at = 观测序号：确定性逻辑时钟，宪章禁 Date.now）
    if (view.drifting !== this.lastDrifting) {
      this.events.push({ at: this.tick, kind: view.kind, severity: view.severity, w1: view.w1, threshold: view.threshold });
      if (this.events.length > 50) this.events.shift();
      this.lastDrifting = view.drifting;
    }
    return view;
  }

  /** 当前漂移视图（纯读取） */
  drift(): TransportDriftView {
    const window = this.buffer.slice(-this.config.windowSize);
    const baseline = this.buffer.slice(0, Math.max(0, this.buffer.length - this.config.windowSize));
    const w1 = wasserstein1D(window, baseline, 1);
    const threshold = this.currentThreshold(baseline);
    const drifting =
      window.length >= this.config.minSamples && baseline.length >= this.config.minSamples && w1 > threshold;
    const meanShift = mean(window) - mean(baseline);
    const spreadRatio = stddev(baseline) > 1e-12 ? stddev(window) / stddev(baseline) : 1;
    // 漂移分型：均值位移明显 → level；展宽明显偏离 1 → shape；两者兼有 → both
    const levelDominant = Math.abs(meanShift) > 0.5 * w1 + 1e-12 && Math.abs(meanShift) > 0.02;
    const shapeDominant = spreadRatio > 1.25 || spreadRatio < 0.8;
    const kind: TransportDriftView['kind'] = !drifting
      ? 'none'
      : levelDominant && shapeDominant
        ? 'both'
        : levelDominant
          ? 'level'
          : 'shape';
    return {
      w1: round(w1),
      threshold: round(threshold),
      drifting,
      severity: round(drifting ? (w1 / Math.max(threshold, 1e-12) - 1) * this.config.severityScale : 0),
      meanShift: round(meanShift),
      spreadRatio: round(spreadRatio),
      kind,
      samples: { window: window.length, reference: baseline.length },
      interpretation: this.interpret(kind, w1, threshold, spreadRatio, window.length),
    };
  }

  /** 漂移事件审计（翻转沿） */
  recentEvents(limit = 10): TransportDriftEvent[] {
    return this.events.slice(-limit);
  }

  /** 当前自适应阈值（历史 W₁ 的分位；历史不足时退化为 2.5σ 启发） */
  private currentThreshold(baseline: readonly number[]): number {
    if (this.historyW1.length >= 10) {
      const sorted = [...this.historyW1].sort((x, y) => x - y);
      return Math.max(1e-12, quantileSorted(sorted, this.config.thresholdQuantile));
    }
    // 冷启动：基准离散度 × 2.5（保守起步，历史积累后自动接管）
    if (baseline.length >= this.config.minSamples) {
      return Math.max(1e-12, 2.5 * stddev(baseline));
    }
    return Infinity;
  }

  private interpret(
    kind: TransportDriftView['kind'],
    w1: number,
    threshold: number,
    spreadRatio: number,
    windowCount: number,
  ): string {
    if (kind === 'none') {
      return windowCount < this.config.minSamples
        ? `样本积累中（${windowCount}/${this.config.minSamples}），形状监测待命`
        : `分布形状稳定（W₁=${w1.toFixed(4)} ≤ 阈值 ${threshold.toFixed(4)}）`;
    }
    if (kind === 'level') return `分布整体位移（W₁=${w1.toFixed(4)} > ${threshold.toFixed(4)}）：均值水位漂移，形状未变`;
    if (kind === 'shape') {
      const spread = spreadRatio > 1 ? `展宽 ×${spreadRatio.toFixed(2)}（双峰化/尾部变厚）` : `收窄 ×${spreadRatio.toFixed(2)}（分布聚集）`;
      return `形状漂移（W₁=${w1.toFixed(4)} > ${threshold.toFixed(4)}）：均值水位基本未动但${spread}——水位检测盲区，先知漂移再谈覆盖`;
    }
    return `复合漂移（W₁=${w1.toFixed(4)} > ${threshold.toFixed(4)}）：均值与形状同时改变，世界已换`;
  }
}

// ─────────────────────────── 工具 ───────────────────────────

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
}

/** 六位小数圆整（与 12.0/13.0/16.0 统一展示口径） */
function round(x: number): number {
  return Number(x.toFixed(6));
}
