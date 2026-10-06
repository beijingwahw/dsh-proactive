/**
 * 72.0 稀疏恢复内核 —— Lasso 坐标下降 + OMP 贪心支撑恢复
 *
 * 动机: 优化器要做「信号 → 质量」归因——几十个候选因素（模型档位、上下文
 * 长度、检索命中数、温度……）里真正影响质量增量的往往只有少数几个。全因素
 * 回归在样本少时方差爆炸；本内核用**稀疏性先验**把逆问题变成可解的：
 * 候选因素矩阵 A、质量增量观测 y，求 k-稀疏 / ℓ1-正则的 x，读出「谁在起
 * 作用、作用多大」。与 5.0 因果内核互补：稀疏恢复给出候选短清单（相关结构），
 * 因果内核再裁决方向（干预语义）。
 *
 * 数学:
 *   Lasso（Tibshirani 1996）:  min_x ½‖Ax−y‖² + λ‖x‖₁ ——凸，唯一最优
 *   （列满秩时）。坐标下降 + 软阈值：对第 j 列精确最小化
 *     x_j ← S(ρ_j, λ) / ‖a_j‖²,  ρ_j = a_jᵀ(y − A x_{−j}) = c_j − Σ_{k≠j} G_jk x_k
 *     S(v, t) = sign(v)·max(|v|−t, 0)（软阈值算子）
 *   每步都是该坐标的精确极小 ⟹ 目标函数沿迭代单调不增（块状坐标下降定理）。
 *
 *   KKT 最优性证书（凸问题 ⟹ 充要）: x* 最优 ⟺ 残差相关满足
 *     x_j ≠ 0:  a_jᵀ(y − Ax) = λ·sign(x_j)   （active 取等号）
 *     x_j = 0:  |a_jᵀ(y − Ax)| ≤ λ           （inactive 被压在双闸内）
 *   一站式度量: max_j (|a_jᵀ(y−Ax)| − λ) ≤ 0 即**证明了**到最优点——
 *   不是「迭代跑完了」，是「最优性被证书确认了」。
 *
 *   闭式阈值: λ_max = ‖Aᵀy‖∞。λ ≥ λ_max ⟹ x* ≡ 0（x=0 处全部 |c_j| ≤ λ，
 *   KKT 直接满足）——λ 轴的原点锚。
 *
 *   OMP（正交匹配追踪）: 每步选与残差最相关的列、在已选支撑上做全最小二乘
 *   重投影（残差始终正交于已选列扩张的空间）。无噪 + 已知稀疏度 k + 相干性
 *   μ(A) < 1/(2k−1)（Welch 充分条件）⟹ 精确恢复支撑与数值。
 *
 *   CV 选 λ: K 折交叉验证的 held-out MSE 最小化；平局取更大 λ（更稀疏、
 *   更 parsimony）。无截距项——调用方先中心化 y（或接受过原点模型）。
 *
 * R5-A17 世界性进化（数学轴 + 性能轴 + 数值稳健轴，2026-10）:
 *   ⑥ 强规则筛选（SAFE, El Ghaoui–Gu–Bouttier 2012）: 求解 λ₀ < λ 的 Lasso
 *     前，用 λ 处的对偶可行点 θ̂ = r̂/λ 圈住 λ₀ 的对偶最优解所在球
 *     B(y/λ₀, v/λ₀)，v = ‖y − (λ₀/λ)·r̂‖（强对偶性: 对偶目标
 *     D(θ) = ½‖y‖² − ½‖y − λ₀θ‖² 在 θ* 处取最大 ⟹ ‖y − λ₀θ*‖ ≤ ‖y − λ₀θ̂‖）。
 *     x_j* ≠ 0 ⟹ |a_jᵀθ*| = 1（互补松弛），而 |a_jᵀθ*| ≤ (|c_j| + ‖a_j‖₂·v)/λ₀
 *     ⟹ |c_j| + ‖a_j‖₂·v < λ₀ 的列可**安全置零**——被丢变量在完整解中恰为 0
 *     是定理不是启发式。零列（‖a_j‖=0）恒被丢（c_j=0 < λ₀，与软阈值一致）。
 *   ⑦ λ 路径热启动: lassoCD 新增 x0 初值参数（缺省 0——零漂移）；λ 降序
 *     扫描时上一个 λ 的解作下一个的 x0，配合 SAFE 筛选只在保留列上做坐标
 *     下降。每步产出全设计阵上的 KKT 证书（kktMaxViolation ≤ 0 才可采信）
 *     ——筛选与热启动都不触碰最优性，只省掉「已知不会动」的坐标。
 *
 * 验证锚点（scripts/verify-search-sparse.mjs）:
 *   ① 无噪 3-稀疏 60×10 设计: OMP 支撑与数值精确恢复（1e-9）；
 *   ② Lasso CD 收敛解 kktMaxViolation < 1e-8（最优性证书）；
 *   ③ objectiveTrace 沿迭代单调不增；
 *   ④ λ ≥ λ_max = ‖Aᵀy‖∞ ⟹ 解 ≡ 0（逐分量 === 0 的精确断言）；
 *   ⑤ σ=0.1 噪声 100 种子: OMP 支撑恢复率 ≥ 95%；
 *   ⑥ CV 选 λ 的验证误差 ≤ 真支撑最小二乘（oracle）误差 + 容差。
 *
 * 确定性: 全部随机源为文件内 mulberry32(seed)（randomSparseDesign 的
 *   高斯设计/稀疏信号/噪声、cvLasso 的折分配）；同输入同输出。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 确定性随机源 ───────────────────────────

/** mulberry32——本内核唯一随机源（同 seed 逐位复现） */
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

/** 标准正态（Box–Muller；u1 钳位防 log(0)，与 24.0 gaussianNoise 同式） */
function standardNormal(rng: () => number): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ─────────────────────────── 基础校验与线性代数 ───────────────────────────

/** 设计阵 + 观测校验（显式 throw）：A 非空矩形、元素有限；y 与 A 行数一致且有限 */
function validateDesign(A: unknown, y: unknown, who: string): { m: number; n: number } {
  if (!Array.isArray(A) || A.length === 0) throw new Error(`${who}: A 需为非空的 m×n 二维数组`);
  if (!Array.isArray(y) || y.length !== A.length) throw new Error(`${who}: y 长度 ${Array.isArray(y) ? y.length : String(y)} 需等于 A 的行数 ${A.length}`);
  const n = (A[0] as unknown[]).length;
  if (!Number.isInteger(n) || n < 1) throw new Error(`${who}: A 的列数需 ≥ 1`);
  for (let i = 0; i < A.length; i += 1) {
    const row = A[i];
    if (!Array.isArray(row) || row.length !== n) throw new Error(`${who}: A 的第 ${i} 行需有 ${n} 列`);
    for (let j = 0; j < n; j += 1) {
      if (typeof row[j] !== 'number' || !Number.isFinite(row[j])) {
        throw new Error(`${who}: A[${i}][${j}] = ${String(row[j])} 需为有限数`);
      }
    }
  }
  for (let i = 0; i < y.length; i += 1) {
    if (typeof y[i] !== 'number' || !Number.isFinite(y[i])) throw new Error(`${who}: y[${i}] = ${String(y[i])} 需为有限数`);
  }
  return { m: A.length, n };
}

/** 高斯消元（部分主元 + Gauss–Jordan），奇异时显式 throw */
function solveLinearSystem(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const aug = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(aug[r]![col]!) > Math.abs(aug[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(aug[pivot]![col]!) < 1e-12) {
      throw new Error('solveLinearSystem: 法方程奇异（列强共线或 m < 列数）——子问题病态');
    }
    const tmp = aug[col]!;
    aug[col] = aug[pivot]!;
    aug[pivot] = tmp;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = aug[r]![col]! / aug[col]![col]!;
      if (factor === 0) continue;
      for (let c = col; c <= n; c += 1) aug[r]![c]! -= factor * aug[col]![c]!;
    }
  }
  return aug.map((row, i) => row[n]! / row[i]!);
}

/** Gram 阵 G = AᵀA（n×n） */
function gram(A: number[][]): number[][] {
  const m = A.length;
  const n = A[0]!.length;
  const G: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < m; i += 1) {
    const row = A[i]!;
    for (let j = 0; j < n; j += 1) {
      const rij = row[j]!;
      if (rij === 0) continue;
      for (let k = j; k < n; k += 1) {
        G[j]![k]! += rij * row[k]!;
      }
    }
  }
  for (let j = 0; j < n; j += 1) {
    for (let k = 0; k < j; k += 1) G[j]![k] = G[k]![j]!;
  }
  return G;
}

/** 普通最小二乘（法方程 + 部分主元消元）。列需线性无关（m ≥ n 且列满秩），奇异 throw。 */
export function leastSquares(A: number[][], y: number[]): number[] {
  validateDesign(A, y, 'leastSquares');
  const n = A[0]!.length;
  const G = gram(A);
  const b = new Array<number>(n).fill(0);
  for (let j = 0; j < n; j += 1) {
    let acc = 0;
    for (let i = 0; i < A.length; i += 1) acc += A[i]![j]! * y[i]!;
    b[j] = acc;
  }
  return solveLinearSystem(G, b);
}

// ─────────────────────────── 软阈值 ───────────────────────────

/**
 * 软阈值算子 S(v, t) = sign(v)·max(|v|−t, 0)——ℓ1 优化的解析原子：
 * t = 0 恒等映射；|v| ≤ t 时输出精确 0（λ ≥ λ_max ⟹ 全零解的浮点保证）。
 */
export function softThreshold(v: number, t: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`softThreshold: v=${String(v)} 需为有限数`);
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) throw new Error(`softThreshold: t=${String(t)} 需为有限非负数`);
  const magnitude = Math.max(Math.abs(v) - t, 0);
  return magnitude === 0 ? 0 : Math.sign(v) * magnitude; // 归一 +0（−0 会污染展示与序列化）
}

// ─────────────────────────── Lasso 坐标下降 ───────────────────────────

export interface LassoOptions {
  /** 设计阵（m×n，行=样本，列=候选因素） */
  A: number[][];
  /** 观测（长度 m） */
  y: number[];
  /** ℓ1 正则强度 λ ≥ 0（λ ≥ ‖Aᵀy‖∞ 时解恒为零） */
  lambda: number;
  /** 最大扫描轮数（缺省 500） */
  iters?: number;
  /** 一轮内最大 |Δx_j| 低于此即判收敛（缺省 1e-12） */
  tol?: number;
  /** 初值 x(0)（缺省全零——λ 路径热启动用；不影响不动点，只省迭代） */
  x0?: ReadonlyArray<number>;
}

export interface LassoOutcome {
  /** 解 x（长度 n； inactive 分量精确为 0） */
  x: number[];
  /** 目标函数值轨迹（[初值, 第 1 轮末, …]——单调不增可审计） */
  objectiveTrace: number[];
  /** 收敛解的 KKT 最大违反 max_j(|a_jᵀ(y−Ax)| − λ)；≤ 0 为最优性证书 */
  kktViolation: number;
  /** 实际扫描轮数 */
  sweeps: number;
  /** 是否在一轮内 |Δx| < tol 收敛 */
  converged: boolean;
  /** active 集 { j : x_j ≠ 0 }（升序） */
  activeSet: number[];
}

/**
 * Lasso 坐标下降：min_x ½‖Ax−y‖² + λ‖x‖₁。
 * 预计算 Gram 阵 G 与相关向量 z = Aᵀ(y−Ax)（每坐标 O(n) 增量维护，
 * 不回读 A）；x_j ← S(z_j + G_jj·x_j, λ) / G_jj 为该坐标精确极小。
 * 零列（G_jj ≈ 0）跳过——该列与 y 无相关，阈值后必为 0。
 */
export function lassoCD(options: LassoOptions): LassoOutcome {
  if (!options || typeof options !== 'object') throw new Error('lassoCD: 需传入 { A, y, lambda, iters?, tol? }');
  const { A, y, lambda } = options;
  validateDesign(A, y, 'lassoCD');
  if (typeof lambda !== 'number' || !Number.isFinite(lambda) || lambda < 0) {
    throw new Error(`lassoCD: lambda=${String(lambda)} 需为有限非负数`);
  }
  const iters = options.iters ?? 500;
  if (!Number.isInteger(iters) || iters < 1) throw new Error(`lassoCD: iters=${String(iters)} 需为正整数`);
  const tol = options.tol ?? 1e-12;
  if (typeof tol !== 'number' || !Number.isFinite(tol) || tol <= 0) throw new Error(`lassoCD: tol=${String(tol)} 需为有限正数`);

  const m = A.length;
  const n = A[0]!.length;
  const G = gram(A);
  const c = new Array<number>(n).fill(0);
  for (let j = 0; j < n; j += 1) {
    let acc = 0;
    for (let i = 0; i < m; i += 1) acc += A[i]![j]! * y[i]!;
    c[j] = acc;
  }

  const x = new Array<number>(n).fill(0);
  if (options.x0 !== undefined) {
    if (!Array.isArray(options.x0) || options.x0.length !== n) {
      throw new Error(`lassoCD: x0 长度 ${Array.isArray(options.x0) ? options.x0.length : String(options.x0)} 需等于列数 ${n}`);
    }
    for (let j = 0; j < n; j += 1) {
      const v = options.x0[j]!;
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`lassoCD: x0[${j}] = ${String(v)} 需为有限数`);
      x[j] = v;
    }
  }
  // z_j = a_jᵀ(y − Ax)（热启动时按 x0 一次性重算；x=0 时即 c）
  const z = [...c];
  for (let j = 0; j < n; j += 1) {
    if (x[j]! === 0) continue;
    for (let k = 0; k < n; k += 1) z[k]! -= G[k]![j]! * x[j]!;
  }

  const objective = (): number => {
    let sq = 0;
    let l1 = 0;
    for (let i = 0; i < m; i += 1) {
      const row = A[i]!;
      let pred = 0;
      for (let j = 0; j < n; j += 1) pred += row[j]! * x[j]!;
      const r = pred - y[i]!;
      sq += r * r;
    }
    for (let j = 0; j < n; j += 1) l1 += Math.abs(x[j]!);
    return 0.5 * sq + lambda * l1;
  };

  const objectiveTrace: number[] = [objective()];
  let converged = false;
  let sweeps = 0;
  for (let sweep = 1; sweep <= iters; sweep += 1) {
    sweeps = sweep;
    let maxDelta = 0;
    for (let j = 0; j < n; j += 1) {
      const gjj = G[j]![j]!;
      if (gjj <= 1e-15) continue; // 零列：无相关可压，x_j 保持 0
      const rho = z[j]! + gjj * x[j]!;
      const xj = softThreshold(rho, lambda) / gjj;
      const delta = xj - x[j]!;
      if (delta !== 0) {
        x[j] = xj;
        const absDelta = Math.abs(delta);
        if (absDelta > maxDelta) maxDelta = absDelta;
        for (let k = 0; k < n; k += 1) z[k]! -= G[k]![j]! * delta;
      }
    }
    objectiveTrace.push(objective());
    if (maxDelta < tol) {
      converged = true;
      break;
    }
  }

  const activeSet: number[] = [];
  for (let j = 0; j < n; j += 1) if (x[j]! !== 0) activeSet.push(j);

  return { x, objectiveTrace, kktViolation: kktMaxViolation(A, y, x, lambda), sweeps, converged, activeSet };
}

// ─────────────────────────── KKT 证书 ───────────────────────────

/**
 * KKT 最大违反: max_j (|a_jᵀ(y − Ax)| − λ)。
 * 返回值 ≤ 0（含数值容差内）⟺ x 为 Lasso 全局最优（凸问题 KKT 充要）——
 * 迭代器的「毕业证」而不是「出勤记录」。
 */
export function kktMaxViolation(A: number[][], y: number[], x: number[], lambda: number): number {
  validateDesign(A, y, 'kktMaxViolation');
  const n = A[0]!.length;
  if (!Array.isArray(x) || x.length !== n) throw new Error(`kktMaxViolation: x 长度 ${Array.isArray(x) ? x.length : String(x)} 需为 ${n}`);
  for (let j = 0; j < n; j += 1) {
    if (typeof x[j] !== 'number' || !Number.isFinite(x[j]!)) throw new Error(`kktMaxViolation: x[${j}] = ${String(x?.[j])} 需为有限数`);
  }
  if (typeof lambda !== 'number' || !Number.isFinite(lambda) || lambda < 0) {
    throw new Error(`kktMaxViolation: lambda=${String(lambda)} 需为有限非负数`);
  }
  // 残差 r = y − Ax，一次遍历同时累积各列相关 a_jᵀ r
  const corr = new Array<number>(n).fill(0);
  for (let i = 0; i < A.length; i += 1) {
    const row = A[i]!;
    let pred = 0;
    for (let j = 0; j < n; j += 1) pred += row[j]! * x[j]!;
    const r = y[i]! - pred;
    for (let j = 0; j < n; j += 1) corr[j]! += row[j]! * r;
  }
  let worst = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < n; j += 1) {
    const violation = Math.abs(corr[j]!) - lambda;
    if (violation > worst) worst = violation;
  }
  return worst;
}

// ─────────────────────────── OMP ───────────────────────────

export interface OmpOptions {
  A: number[][];
  y: number[];
  /** 目标稀疏度 k ∈ [1, n]（已知/预估的活跃因素数上限） */
  k: number;
}

export interface OmpOutcome {
  /** 恢复的支撑（按选中顺序） */
  support: number[];
  /** 全长系数向量（支撑外精确为 0） */
  x: number[];
  /** 终止时 ‖y − Ax‖₂ */
  residualNorm: number;
  /** 实际贪心步数（残差与全部候选列不再相关时提前停） */
  steps: number;
}

/**
 * 正交匹配追踪：每步选 |a_jᵀ r| 最大的列（平局取小下标），支撑上做全
 * 最小二乘重投影（残差正交于已选列空间）。无噪 + 低相干 + k 不过大时
 * 精确恢复。停止条件：步数达 k，或最优相关 ≤ 1e-12·max(1, ‖y‖∞)
 * （信号已全部捕获，继续选只会拟合噪声）。
 */
export function omp(options: OmpOptions): OmpOutcome {
  if (!options || typeof options !== 'object') throw new Error('omp: 需传入 { A, y, k }');
  const { A, y } = options;
  const { n } = validateDesign(A, y, 'omp');
  const k = options.k;
  if (!Number.isInteger(k) || k < 1 || k > n) throw new Error(`omp: k=${String(k)} 需为 [1, ${n}] 的整数`);

  const m = A.length;
  let yInf = 0;
  for (let i = 0; i < m; i += 1) yInf = Math.max(yInf, Math.abs(y[i]!));
  const relevanceFloor = 1e-12 * Math.max(1, yInf);

  const support: number[] = [];
  const x = new Array<number>(n).fill(0);
  let residual = [...y];
  let steps = 0;

  for (let step = 0; step < k; step += 1) {
    const inSupport = new Set(support);
    let bestJ = -1;
    let bestCorr = 0;
    for (let j = 0; j < n; j += 1) {
      if (inSupport.has(j)) continue;
      let corr = 0;
      for (let i = 0; i < m; i += 1) corr += A[i]![j]! * residual[i]!;
      const absCorr = Math.abs(corr);
      if (absCorr > bestCorr) {
        bestCorr = absCorr;
        bestJ = j;
      }
    }
    if (bestJ < 0 || bestCorr <= relevanceFloor) break; // 无相关方向：精确恢复完成
    support.push(bestJ);
    steps = step + 1;

    // 支撑上全最小二乘重投影（法方程 + 消元；支撑 ≤ k 很小）
    const s = support.length;
    const Gss: number[][] = Array.from({ length: s }, (_, a) =>
      Array.from({ length: s }, (_, b) => {
        let acc = 0;
        for (let i = 0; i < m; i += 1) acc += A[i]![support[a]!]! * A[i]![support[b]!]!;
        return acc;
      }),
    );
    const bss: number[] = Array.from({ length: s }, (_, a) => {
      let acc = 0;
      for (let i = 0; i < m; i += 1) acc += A[i]![support[a]!]! * y[i]!;
      return acc;
    });
    const coef = solveLinearSystem(Gss, bss);
    // 支撑只增、x 初值为零且每步整支撑重写——支撑外恒为 0，无需清理
    for (let a = 0; a < s; a += 1) x[support[a]!] = coef[a]!;
    residual = y.map((yi, i) => {
      let pred = 0;
      for (let a = 0; a < s; a += 1) pred += A[i]![support[a]!]! * coef[a]!;
      return yi - pred;
    });
  }

  let residualNorm = 0;
  for (const r of residual) residualNorm += r * r;
  return { support, x, residualNorm: Math.sqrt(residualNorm), steps };
}

// ─────────────────────────── 交叉验证选 λ ───────────────────────────

export interface CvLassoOptions {
  A: number[][];
  y: number[];
  /** 折数（缺省 5；∈ [2, m]） */
  folds?: number;
  /** λ 网格（缺省：λ_max → 1e-3·λ_max 的 25 点几何网格，降序） */
  lambdas?: number[];
  /** 折分配种子（缺省 20261002；Fisher–Yates 洗牌，同种子同折） */
  seed?: number;
  iters?: number;
  tol?: number;
}

export interface CvPoint {
  lambda: number;
  cvError: number;
}

export interface CvLassoOutcome {
  /** CV 误差最小的 λ（平局取更大——更稀疏） */
  bestLambda: number;
  /** bestLambda 的按样本平均 held-out MSE */
  cvError: number;
  /** λ–误差曲线（按传入网格原序；缺省网格为 λ 降序） */
  curve: CvPoint[];
  /** 各折 held-out 样本下标（供外部用同一折复算 oracle 误差） */
  folds: number[][];
}

/** K 折交叉验证选 λ：每折内 lassoCD 训练、held-out 预测，按样本平均 MSE。 */
export function cvLasso(options: CvLassoOptions): CvLassoOutcome {
  if (!options || typeof options !== 'object') throw new Error('cvLasso: 需传入 { A, y, folds?, lambdas?, seed? }');
  const { A, y } = options;
  const { m, n } = validateDesign(A, y, 'cvLasso');
  const folds = options.folds ?? 5;
  if (!Number.isInteger(folds) || folds < 2 || folds > m) throw new Error(`cvLasso: folds=${String(folds)} 需为 [2, ${m}] 的整数`);
  const seed = options.seed ?? 20261002;
  if (!Number.isFinite(seed)) throw new Error('cvLasso: seed 需为有限数');

  let lambdas = options.lambdas;
  if (lambdas === undefined) {
    let lambdaMax = 0;
    for (let j = 0; j < n; j += 1) {
      let acc = 0;
      for (let i = 0; i < m; i += 1) acc += A[i]![j]! * y[i]!;
      lambdaMax = Math.max(lambdaMax, Math.abs(acc));
    }
    const points = 25;
    lambdas = Array.from({ length: points }, (_, i) => lambdaMax * Math.pow(10, (-3 * i) / (points - 1)));
  } else {
    if (!Array.isArray(lambdas) || lambdas.length === 0) throw new Error('cvLasso: lambdas 需为非空数组');
    for (let i = 0; i < lambdas.length; i += 1) {
      const v = lambdas[i]!;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`cvLasso: lambdas[${i}]=${String(v)} 需为有限非负数`);
    }
  }

  // 折分配：Fisher–Yates 洗牌后连续切分（前 m%folds 折多 1 个样本）
  const rng = mulberry32(seed);
  const idx = Array.from({ length: m }, (_, i) => i);
  for (let i = m - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = idx[i]!;
    idx[i] = idx[j]!;
    idx[j] = tmp;
  }
  const foldArrays: number[][] = [];
  const base = Math.floor(m / folds);
  const rem = m % folds;
  let cursor = 0;
  for (let f = 0; f < folds; f += 1) {
    const size = base + (f < rem ? 1 : 0);
    foldArrays.push(idx.slice(cursor, cursor + size));
    cursor += size;
  }

  const curve: CvPoint[] = [];
  for (const lambda of lambdas) {
    let totalSq = 0;
    for (const fold of foldArrays) {
      const testSet = new Set(fold);
      const trainRows: number[][] = [];
      const trainY: number[] = [];
      for (let i = 0; i < m; i += 1) {
        if (!testSet.has(i)) {
          trainRows.push(A[i]!);
          trainY.push(y[i]!);
        }
      }
      if (trainRows.length === 0) continue; // folds === m 时该折无训练样本：跳过（其余折承担）
      const fit = lassoCD({ A: trainRows, y: trainY, lambda, iters: options.iters, tol: options.tol });
      for (const i of fold) {
        const row = A[i]!;
        let pred = 0;
        for (let j = 0; j < n; j += 1) pred += row[j]! * fit.x[j]!;
        const err = pred - y[i]!;
        totalSq += err * err;
      }
    }
    curve.push({ lambda, cvError: totalSq / m });
  }

  let bestIndex = 0;
  for (let i = 1; i < curve.length; i += 1) {
    const better = curve[i]!.cvError < curve[bestIndex]!.cvError
      || (curve[i]!.cvError === curve[bestIndex]!.cvError && curve[i]!.lambda > curve[bestIndex]!.lambda);
    if (better) bestIndex = i;
  }
  return { bestLambda: curve[bestIndex]!.lambda, cvError: curve[bestIndex]!.cvError, curve, folds: foldArrays };
}

// ─────────────────────────── R5: SAFE 强规则筛选 + λ 路径 ───────────────────────────

export interface LassoScreenOptions {
  /** 目标正则强度 λ₀ ∈ (0, λ_warm]（在它上面证零） */
  lambda: number;
  /**
   * 热启动口径: λ_warm ≥ λ₀ 处的（近似）解 x̂ 与该 λ。缺省 x̂ = 0、
   * λ_warm = λ_max = ‖Aᵀy‖∞（x=0 在 λ ≥ λ_max 处对偶可行——闭式锚）。
   */
  warm?: { x: ReadonlyArray<number>; lambda: number };
}

export interface LassoScreenOutcome {
  /** 升序保留列（需进入坐标下降） */
  kept: number[];
  /** 升序被丢弃列（定理保证 x_j*(λ₀) = 0） */
  discarded: number[];
  /** 对偶球半径 v = ‖y − (λ₀/λ_warm)·r̂‖ */
  sphereRadius: number;
  /** 对偶可行性证书 max_j |a_jᵀθ̂|（θ̂ = r̂/λ_warm；须 ≤ 1，否则 throw） */
  dualFeasibility: number;
  /** 各列 L2 范数（零列恒被丢） */
  columnNorms: number[];
  /** 热启动 λ */
  warmLambda: number;
}

/**
 * SAFE 强规则筛选（El Ghaoui–Gu–Bouttier 2012，安全版）:
 * 给定 λ_warm ≥ λ₀ 处的对偶可行点 θ̂ = (y − Ax̂)/λ_warm，λ₀ 的对偶最优解
 * 全体落在球 B(y/λ₀, v/λ₀) 内（v = ‖y − λ₀θ̂‖——强对偶 + 二次对偶目标）。
 * 互补松弛: x_j*(λ₀) ≠ 0 ⟹ |a_jᵀθ*(λ₀)| = 1；而球上的上界
 *   |a_jᵀθ*| ≤ (|c_j| + ‖a_j‖₂·v)/λ₀，
 * 故 |c_j| + ‖a_j‖₂·v < λ₀ ⟹ x_j*(λ₀) = 0——**被丢变量在完整解中恰为 0**。
 *
 * 安全性前提: θ̂ 必须对偶可行（‖Aᵀθ̂‖∞ ≤ 1）。缺省口径 x̂=0、λ_warm=λ_max
 * 自动满足；传入 warm 时显式复核（违反则 throw——安全优先于速度）。
 */
export function lassoScreen(A: number[][], y: number[], options: LassoScreenOptions): LassoScreenOutcome {
  if (!options || typeof options !== 'object') throw new Error('lassoScreen: 需传入 { lambda, warm? }');
  const { m, n } = validateDesign(A, y, 'lassoScreen');
  const lambda0 = options.lambda;
  if (typeof lambda0 !== 'number' || !Number.isFinite(lambda0) || lambda0 <= 0) {
    throw new Error(`lassoScreen: lambda=${String(lambda0)} 需为正有限数（λ₀ = 0 时无任何列可被安全丢弃）`);
  }
  let warmX: ReadonlyArray<number> = new Array<number>(n).fill(0);
  let warmLambda: number;
  if (options.warm === undefined) {
    // x = 0 在 λ_max 处对偶可行（|c_j| ≤ λ_max 即 KKT）
    let lambdaMax = 0;
    for (let j = 0; j < n; j += 1) {
      let acc = 0;
      for (let i = 0; i < m; i += 1) acc += A[i]![j]! * y[i]!;
      lambdaMax = Math.max(lambdaMax, Math.abs(acc));
    }
    warmLambda = lambdaMax;
  } else {
    const warm = options.warm;
    if (!warm || typeof warm !== 'object') throw new Error('lassoScreen: warm 需为 { x, lambda }');
    if (!Array.isArray(warm.x) || warm.x.length !== n) {
      throw new Error(`lassoScreen: warm.x 长度 ${Array.isArray(warm.x) ? warm.x.length : String(warm.x)} 需等于列数 ${n}`);
    }
    for (let j = 0; j < n; j += 1) {
      if (typeof warm.x[j] !== 'number' || !Number.isFinite(warm.x[j]!)) {
        throw new Error(`lassoScreen: warm.x[${j}] = ${String(warm.x?.[j])} 需为有限数`);
      }
    }
    if (typeof warm.lambda !== 'number' || !Number.isFinite(warm.lambda) || warm.lambda <= 0) {
      throw new Error(`lassoScreen: warm.lambda = ${String(warm.lambda)} 需为正有限数`);
    }
    warmX = warm.x;
    warmLambda = warm.lambda;
  }
  if (lambda0 > warmLambda) {
    throw new Error(`lassoScreen: 目标 λ₀=${lambda0} 需 ≤ 热启动 λ=${warmLambda}（规则只沿 λ 递减方向安全）`);
  }

  // 残差 r̂ = y − A·x̂（一次 O(mn)），相关 c = Aᵀy、对偶相关 Aᵀr̂、列范数
  const residual = new Array<number>(m).fill(0);
  for (let i = 0; i < m; i += 1) residual[i] = y[i]! - dotRow(A[i]!, warmX);
  const c = new Array<number>(n).fill(0);
  const aTRes = new Array<number>(n).fill(0);
  const colNorms = new Array<number>(n).fill(0);
  for (let j = 0; j < n; j += 1) {
    let cj = 0;
    let ajr = 0;
    let nj = 0;
    for (let i = 0; i < m; i += 1) {
      const aij = A[i]![j]!;
      cj += aij * y[i]!;
      ajr += aij * residual[i]!;
      nj += aij * aij;
    }
    c[j] = cj;
    aTRes[j] = ajr;
    colNorms[j] = Math.sqrt(nj);
  }
  let dualFeas = 0;
  for (let j = 0; j < n; j += 1) dualFeas = Math.max(dualFeas, Math.abs(aTRes[j]!));
  dualFeas /= warmLambda;
  if (dualFeas > 1 + 1e-6) {
    throw new Error(`lassoScreen: 热启动点对偶不可行（‖Aᵀθ̂‖∞ = ${dualFeas.toFixed(6)} > 1）——安全前提破坏，拒绝筛选`);
  }
  // v = ‖y − λ₀θ̂‖ = ‖y − (λ₀/λ_warm)·r̂‖
  const ratio = lambda0 / warmLambda;
  let vSq = 0;
  for (let i = 0; i < m; i += 1) {
    const d = y[i]! - ratio * (y[i]! - dotRow(A[i]!, warmX));
    vSq += d * d;
  }
  const sphereRadius = Math.sqrt(vSq);
  const kept: number[] = [];
  const discarded: number[] = [];
  for (let j = 0; j < n; j += 1) {
    if (Math.abs(c[j]!) + colNorms[j]! * sphereRadius < lambda0) discarded.push(j);
    else kept.push(j);
  }
  return { kept, discarded, sphereRadius, dualFeasibility: dualFeas, columnNorms: colNorms, warmLambda };
}

/** 行向量点积（内联辅助，避免闭包分配） */
function dotRow(row: number[], x: ReadonlyArray<number>): number {
  let acc = 0;
  for (let j = 0; j < row.length; j += 1) acc += row[j]! * x[j]!;
  return acc;
}

export interface LassoPathOptions {
  A: number[][];
  y: number[];
  /** λ 网格（需**严格降序**；缺省 λ_max → 1e-3·λ_max 的 25 点几何网格） */
  lambdas?: number[];
  iters?: number;
  tol?: number;
  /** true（缺省）= SAFE 筛选 + 热启动；false = 每点全列冷启动（公平对照基准） */
  accelerate?: boolean;
}

export interface LassoPathPoint {
  lambda: number;
  /** 全长解（被筛列精确 0） */
  x: number[];
  /** 全设计阵 KKT 最大违反（≤ 0 附近 = 筛选/热启动未破坏最优性的证书） */
  kktViolation: number;
  /** 本点坐标下降扫描轮数（在保留列上计） */
  sweeps: number;
  converged: boolean;
  activeSet: number[];
  keptCount: number;
  discardedCount: number;
}

export interface LassoPathResult {
  path: LassoPathPoint[];
  /** 加速口径的坐标-轮乘积总量（列更新工作的代理度量） */
  columnWork: number;
  /** 同路径不加速对照的坐标-轮乘积总量（由全列求解实测，非公式） */
  baselineColumnWork: number;
}

/**
 * λ 路径求解: 降序扫描，逐点「SAFE 筛选 → 保留列 CD（上一解热启动）→
 * 全设计阵 KKT 证书」。不加速对照（accelerate: false）每点全列冷启动——
 * 两口径的解一致（同一唯一最优），差别只在列更新工作量与墙钟。
 */
export function lassoPath(options: LassoPathOptions): LassoPathResult {
  if (!options || typeof options !== 'object') throw new Error('lassoPath: 需传入 { A, y, lambdas?, iters?, tol?, accelerate? }');
  const { A, y } = options;
  const { m, n } = validateDesign(A, y, 'lassoPath');
  const accelerate = options.accelerate ?? true;
  let lambdas = options.lambdas;
  if (lambdas === undefined) {
    let lambdaMax = 0;
    for (let j = 0; j < n; j += 1) {
      let acc = 0;
      for (let i = 0; i < m; i += 1) acc += A[i]![j]! * y[i]!;
      lambdaMax = Math.max(lambdaMax, Math.abs(acc));
    }
    const points = 25;
    lambdas = Array.from({ length: points }, (_, i) => lambdaMax * Math.pow(10, (-3 * i) / (points - 1)));
  } else {
    if (!Array.isArray(lambdas) || lambdas.length === 0) throw new Error('lassoPath: lambdas 需为非空数组');
    for (let i = 0; i < lambdas.length; i += 1) {
      const v = lambdas[i]!;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new Error(`lassoPath: lambdas[${i}]=${String(v)} 需为正有限数`);
      }
      if (i > 0 && v >= lambdas[i - 1]!) {
        throw new Error(`lassoPath: lambdas 需严格降序（lambdas[${i}]=${v} ≥ lambdas[${i - 1}]）`);
      }
    }
  }

  const path: LassoPathPoint[] = [];
  let columnWork = 0;
  let baselineColumnWork = 0;
  let prevX: number[] | undefined; // 上一点全解（热启动）
  let prevLambda: number | undefined;
  for (const lambda of lambdas) {
    let xFull: number[];
    let sweeps: number;
    let converged: boolean;
    let keptCount = n;
    if (accelerate && prevX !== undefined && prevLambda !== undefined) {
      const screen = lassoScreen(A, y, { lambda, warm: { x: prevX, lambda: prevLambda } });
      const kept = screen.kept;
      keptCount = kept.length;
      if (kept.length === 0) {
        xFull = new Array<number>(n).fill(0);
        sweeps = 0;
        converged = true;
      } else {
        const subA = A.map((row) => kept.map((j) => row[j]!));
        const subX0 = kept.map((j) => prevX![j]!);
        const fit = lassoCD({ A: subA, y, lambda, x0: subX0, iters: options.iters, tol: options.tol });
        sweeps = fit.sweeps;
        converged = fit.converged;
        xFull = new Array<number>(n).fill(0);
        for (let a = 0; a < kept.length; a += 1) xFull[kept[a]!] = fit.x[a]!;
      }
    } else {
      const fit = lassoCD({ A, y, lambda, iters: options.iters, tol: options.tol });
      xFull = fit.x;
      sweeps = fit.sweeps;
      converged = fit.converged;
    }
    columnWork += sweeps * Math.max(1, keptCount);
    const kkt = kktMaxViolation(A, y, xFull, lambda);
    const activeSet: number[] = [];
    for (let j = 0; j < n; j += 1) if (xFull[j]! !== 0) activeSet.push(j);
    path.push({ lambda, x: xFull, kktViolation: kkt, sweeps, converged, activeSet, keptCount, discardedCount: n - keptCount });
    prevX = xFull;
    prevLambda = lambda;
  }
  // 基线工作量：同路径逐点全列冷启动实测（解的唯一性 + KKT 证书 ⟹ 与加速
  // 口径同解；这里只为给出「省了多少」的实测对照，不参与加速口径的求解）
  for (const lambda of lambdas) {
    const fit = lassoCD({ A, y, lambda, iters: options.iters, tol: options.tol });
    baselineColumnWork += fit.sweeps * n;
  }
  return { path, columnWork, baselineColumnWork };
}

// ─────────────────────────── 数据工厂 ───────────────────────────

export interface SparseDesignOptions {
  /** 噪声标准差 σ ≥ 0（缺省 0 = 无噪） */
  noiseSigma?: number;
  /** 稀疏系数幅值下限 ≥ 0（缺省 0；> 0 时重抽 |x*| 过小者，避免「测不出的活跃因素」） */
  minMagnitude?: number;
}

export interface SparseDesign {
  /** m×n 高斯设计阵 */
  A: number[][];
  /** A·x* + 噪声 */
  y: number[];
  /** 真稀疏信号（k 个非零） */
  xStar: number[];
  /** 真支撑（升序） */
  support: number[];
  /** 噪声向量（无噪时全 0） */
  noise: number[];
}

/**
 * 种子化稀疏逆问题数据工厂：A ~ N(0,1)（行主序抽取）→ 支撑 k 个互异下标
 * （Fisher–Yates 局部抽取）→ 系数 ~ N(0,1)（幅值下限重抽）→ 噪声 ~ N(0,σ²)。
 * 抽取顺序固定，同 seed 逐位复现。
 */
export function randomSparseDesign(m: number, n: number, k: number, seed: number, options?: SparseDesignOptions): SparseDesign {
  if (!Number.isInteger(m) || m < 1) throw new Error(`randomSparseDesign: m=${String(m)} 需为正整数`);
  if (!Number.isInteger(n) || n < 1) throw new Error(`randomSparseDesign: n=${String(n)} 需为正整数`);
  if (!Number.isInteger(k) || k < 0 || k > n) throw new Error(`randomSparseDesign: k=${String(k)} 需为 [0, ${n}] 的整数`);
  if (!Number.isFinite(seed)) throw new Error('randomSparseDesign: seed 需为有限数');
  const noiseSigma = options?.noiseSigma ?? 0;
  if (typeof noiseSigma !== 'number' || !Number.isFinite(noiseSigma) || noiseSigma < 0) {
    throw new Error(`randomSparseDesign: noiseSigma=${String(noiseSigma)} 需为有限非负数`);
  }
  const minMagnitude = options?.minMagnitude ?? 0;
  if (typeof minMagnitude !== 'number' || !Number.isFinite(minMagnitude) || minMagnitude < 0) {
    throw new Error(`randomSparseDesign: minMagnitude=${String(minMagnitude)} 需为有限非负数`);
  }

  const rng = mulberry32(seed);
  const A: number[][] = Array.from({ length: m }, () => Array.from({ length: n }, () => standardNormal(rng)));

  const pool = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < k; i += 1) {
    const j = i + Math.floor(rng() * (n - i));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  const support = pool.slice(0, k).sort((a, b) => a - b);

  const xStar = new Array<number>(n).fill(0);
  for (const j of support) {
    let v = standardNormal(rng);
    while (Math.abs(v) < minMagnitude) v = standardNormal(rng);
    xStar[j] = v;
  }

  const noise = Array.from({ length: m }, () => noiseSigma * standardNormal(rng));
  const y = new Array<number>(m).fill(0);
  for (let i = 0; i < m; i += 1) {
    let acc = noise[i]!;
    const row = A[i]!;
    for (let j = 0; j < n; j += 1) acc += row[j]! * xStar[j]!;
    y[i] = acc;
  }
  return { A, y, xStar, support, noise };
}

/* ── 接线建议 ──
 * 建议挂载引擎: 优化器（信号→质量归因）、模型组合残差诊断、特征预算仲裁。
 *   1. 优化器归因管线: A = 候选因素 × 回合矩阵（因素档位标准化列），y = 质量
 *      增量观测。cvLasso 自选 λ → lassoCD 出 x 与 kktViolation（≤0 才可
 *      采信）；activeSet 即「真正起作用的少数因素」短清单，交 5.0 因果内核
 *      裁决方向（稀疏恢复给候选、因果定极性——两内核互补成环）。
 *   2. 模型组合残差诊断: 多模型输出作 A 列、目标信号作 y，omp(k) 找最少的
 *      「有效模型子集」+ 组合系数——退模清单从启发式变贪心支撑恢复。
 *   3. 特征预算: λ 从 λ_max 下扫得到的 curve 是「因素数 × 误差」帕累托
 *      前沿，预算仲裁按拐点选工作因素集（与 25.0 容量规划同构的经济学）。
 *   采集纪律: y 先中心化（本内核无截距项）；样本 m ≥ 5×预期活跃数；
 *      kktViolation 与 objectiveTrace 随归因结果一起落账（可审计）。
 *   缺省关闭旗标名: enableSparseRecoveryKernel（缺省 false；旗标关闭时
 *      归因/退模/特征选择全部走原有全因素回归或启发式规则）。
 *   挂载后改变的决策点: ① 质量归因的候选集（全因素 → 稀疏 active 集）；
 *      ② 模型组合的参与方（固定组合 → OMP 支撑恢复）；③ 特征采集预算
 *      （均摊 → λ 帕累托拐点配给）。
 * 未挂载（旗标 false）时以上决策点全部走原路径——行为逐位一致（零漂移）。
 */
