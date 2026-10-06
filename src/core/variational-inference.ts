/**
 * variational-inference.ts — 57.0 变分推断内核（推断双件套之一：确定性近似）
 *
 * 动机: 系统内所有「后验」至今都是点估计 + 手拍区间——世界模型校准史的
 * 回归系数、因果边的效应强度、策略基因的适应度，全都只报一个数。6.0
 * 自由能引擎的 KL(q‖p) 需要 q 是一个**真正的分布**而非退化的 δ 点；
 * 元认知想知道「参数还有多不确定」，前提是能**算出后验**。精确后验
 * 要对隐变量边际化（高维积分无从下手），变分推断把「推断」变成「优化」：
 *
 *   ELBO(q) = E_q[ln p(X,Z)] − KL(q‖p) = ln p(X) − KL(q‖p(Z|X)) ≤ ln p(X)
 *
 * ELBO 是证据下界，也正是 6.0 变分自由能 F = −ELBO 的计算引擎：
 * 最大化 ELBO ⟺ 最小化自由能 ⟺ q 逼近真后验。本内核两条路线：
 *
 * 数学（路线一：平均场 CAVI，共轭闭式）:
 *   平均场高斯族 q = Π_i N(m_i, s_i²)，坐标上升（CAVI）逐坐标取最优
 *     q_i*(z_i) ∝ exp(E_{q_{−i}}[ln p(X,Z)])
 *   贝叶斯线性回归 y = Xw + ε（先验 w~N(0,α⁻¹I)，噪声 ε~N(0,β⁻¹I)）
 *   共轭 → 全条件高斯 → 闭式更新。推导要点（文档化）:
 *     ln p(y,w) 的 w_i 二次项 −½(β[XᵀX]_ii + α)w_i² 给出**条件精度**；
 *     线性项 β(Xᵀy)_i − βΣ_{j≠i}[XᵀX]_ij·w_j 中 E_{q_{−i}} 把 w_j 代换
 *     为 m_j（线性项期望只动均值）。于是
 *       s_i² ← 1/(β[XᵀX]_ii + α)，  m_i ← s_i²·β[(Xᵀy)_i − Σ_{j≠i}[XᵀX]_ij·m_j]
 *   不动点是**精确后验均值**（m = βΛ⁻¹Xᵀy，Λ = βXᵀX+αI）与**条件方差**
 *   1/Λ_ii。平均场已知偏置：方差被压缩（s_i² ≤ Σ_ii，等号 ⟺ 精度对角/
 *   后验可分解）；正交设计（XᵀX 对角）下后验可分解 → 一次扫描即精确，
 *   且 ELBO* = ln p(y)（KL* = 0）。ELBO 每步坐标更新最大化该坐标 →
 *   轨迹单调不减；ELBO* = ln p(y) − KL(q*‖后验) —— 相关设计下严格小。
 *   证据解析式（d 维口径，验证脚本用 n 维 Cholesky 独立对照）:
 *     ln p(y) = ½[d·ln α − ln|Λ| − n·ln(2π/β) − β‖y‖² + β²(Xᵀy)ᵀΛ⁻¹(Xᵀy)]
 *   ELBO 闭式（E_q‖y−Xw‖² = ‖y−Xm‖² + Σ_j s_j²[XᵀX]_jj）:
 *     ELBO = (n/2)ln(β/2π) − (β/2)E_q‖y−Xw‖²
 *          + (d/2)ln(α/2π) − (α/2)(‖m‖² + Σs²) + Σ_i ½ln(2πe·s_i²)
 *
 * 数学（路线二：解析梯度高斯 VI，非共轭）:
 *   逻辑回归 + 高斯先验无闭式条件分布 → 重参数化 z = m + s⊙ε，
 *   ε~N(0,I)，ELBO(m,s) = E_ε[ln p(y,z(ε))] + H(q)。ε 取**固定公共随机
 *   数集**（mulberry32 种子化，CRN，antithetic 对 (ε,−ε)：估计量关于 m
 *   严格偶对称 + 方差减半）→ ELBO 估计成为 (m,s) 的确定性光滑函数；
 *   解析梯度 ∇_m = E[g(z)]、∇_s = E[g(z)⊙ε] + 1/s（g = ∇_z ln p），
 *   Armijo 回溯线性搜索**只接受提升步** → ELBO 轨迹单调不减由构造保证，
 *   全程同种子逐位可复现。
 *
 * 验证锚点: ①CAVI 收敛到解析后验（均值 1e-6、方差 = 条件方差 1/Λ_ii
 *   至 1e-6；方差压缩 s² ≤ Σ_ii；正交设计一次扫描即精确且 ELBO* = ln p(y)）；
 *   ②ELBO 300 步逐差单调不减；③逻辑回归 VI：ELBO 单调 + 收敛 + 对称
 *   数据后验均值 → 0（梯度正确性的 razor）；④ELBO ≤ ln p(y)（下界性；
 *   相关设计严格 <，间隙 = KL(q*‖后验) > 0）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 *
 * ── R5-A3 世界性进化（第五轮）──
 * 数学进化（自然梯度）: 高斯族的普通梯度步在参数空间度量下取步，而
 * 变分目标是**分布**——KL(q‖q′) ≈ ½ΔᵀFΔ，F = Fisher 信息（对角高斯的
 * (m,s) 参数化：F = diag(1/s², 2/s²)）。自然梯度方向 d = F⁻¹∇：
 *   d_m = ∇_m，d_s = (s²/2)·∇_s
 * ——步长按「分布空间的距离（KL）」度量，s 小（后验已尖）时不再被
 * 1/s 量级的 ∇_s 分量支配。方向仍为上升方向（F⁻¹ 正定 ⟹ dᵀ∇ > 0），
 * Armijo 只接受提升步 ⟹ ELBO 单调性保持。config.naturalGradient
 * 缺省 false（旧路径逐位一致）。
 *
 * 性能进化（ELBO 平台早停）: fit 增补 elboTol——当 |ΔELBO| 连续 3 步
 * ≤ elboTol·max(1,|ELBO|) 即收敛早停（参数 tol 在缓收敛问题上等到最后
 * 一个坐标静止才停，ELBO 平台先到）。等价性：早停终值与全轨迹终值差
 * ≤ elboTol 量级（验证脚本对照 + 迭代数/耗时对比）。
 *
 * 数值稳健性: Λ = βXᵀX + αI 的 Cholesky 加抖动回退（阶梯 0 → 1e-12 →
 * 1e-10 → 1e-8；病态共线设计 + 极小 α 下不再 throw，报告实际抖动量）。
 * 缺省抖动 0 路径与原实现逐位一致。
 */

// ─────────────────────────── 确定性随机基座 ───────────────────────────

/** mulberry32：32 位确定性伪随机源（种子固定时序列完全可复现） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller 标准正态（随机源注入，保持确定性） */
function gaussianNoise(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ─────────────────────────── 线性代数基座（SPD Cholesky） ───────────────────────────

/**
 * 带抖动阶梯的 SPD Cholesky（R5-A3 数值稳健性）：逐级加**尺度相对**
 * 抖动（level × max|diag|）重试，全部失败返回 undefined。jitter = 0 的
 * 首轮与 choleskyLower 逐位一致；相对刻度保证大 β/大尺度设计矩阵下
 * 抖动能盖过舍入噪声（绝对 1e-8 在 ‖Λ‖ ~ 1e18 时会被完全吸收）。
 */
function choleskyLowerJittered(A: number[][]): { L: number[][]; jitter: number } | undefined {
  const n = A.length;
  let maxDiag = 0;
  for (let i = 0; i < n; i += 1) maxDiag = Math.max(maxDiag, Math.abs(A[i][i]));
  if (!(maxDiag > 0) || !Number.isFinite(maxDiag)) return undefined;
  for (const level of [0, 1e-12, 1e-10, 1e-8]) {
    const jitter = level * maxDiag;
    const L: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    let ok = true;
    for (let i = 0; i < n && ok; i += 1) {
      for (let j = 0; j <= i; j += 1) {
        let sum = A[i][j] + (i === j ? jitter : 0);
        for (let k = 0; k < j; k += 1) sum -= L[i][k] * L[j][k];
        if (i === j) {
          if (!(sum > 0)) {
            ok = false;
            break;
          }
          L[i][j] = Math.sqrt(sum);
        } else {
          L[i][j] = sum / L[j][j];
        }
      }
    }
    if (ok) return { L, jitter };
  }
  return undefined;
}

/** 解 L·Lᵀ·x = b（前代 + 回代） */
function cholSolve(L: number[][], b: number[]): number[] {
  const n = L.length;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let sum = b[i];
    for (let k = 0; k < i; k += 1) sum -= L[i][k] * y[k];
    y[i] = sum / L[i][i];
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = y[i];
    for (let k = i + 1; k < n; k += 1) sum -= L[k][i] * x[k];
    x[i] = sum / L[i][i];
  }
  return x;
}

/** SPD 逆（按单位向量逐列 cholSolve，对称化平均压浮点尘埃） */
function cholInverse(L: number[][]): number[][] {
  const n = L.length;
  const cols: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const e = new Array<number>(n).fill(0);
    e[i] = 1;
    cols.push(cholSolve(L, e));
  }
  const inv: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      inv[i][j] = i === j ? cols[j][i] : (cols[j][i] + cols[i][j]) / 2;
    }
  }
  return inv;
}

// ─────────────────────────── 入参校验 ───────────────────────────

function assertFiniteVec(v: number[], what: string): void {
  if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
    throw new Error(`variationalInference: ${what} 必须是非空有限数值数组`);
  }
}

/** 设计矩阵 / 观测 / 精度校验（返回 {n, d}） */
function validateDesign(X: number[][], y: number[], alpha: number, beta: number): { n: number; d: number } {
  if (!Array.isArray(X) || X.length === 0 || !Array.isArray(y) || y.length !== X.length) {
    throw new Error('variationalInference: X 必须为 n×d 矩阵且 y 长度 = n（n ≥ 1）');
  }
  const d = X[0].length;
  if (!Number.isInteger(d) || d < 1) throw new Error('variationalInference: X 每行需 d ≥ 1 列');
  for (const row of X) {
    if (!Array.isArray(row) || row.length !== d || row.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
      throw new Error('variationalInference: X 必须是每行等长（d 列）的有限数值矩阵');
    }
  }
  assertFiniteVec(y, 'y');
  if (!(alpha > 0) || !Number.isFinite(alpha)) throw new Error('variationalInference: alpha 必须 > 0（先验精度）');
  if (!(beta > 0) || !Number.isFinite(beta)) throw new Error('variationalInference: beta 必须 > 0（噪声精度）');
  return { n: X.length, d };
}

// ─────────────────────────── 解析后验（对照锚点） ───────────────────────────

/** 贝叶斯线性回归精确后验（平均场 CAVI 的对照真值） */
export interface ConjugatePosterior {
  dim: number;
  /** 后验均值 m = βΛ⁻¹Xᵀy */
  mean: number[];
  /** 后验协方差 Σ = Λ⁻¹ */
  cov: number[][];
  /** 后验精度 Λ = βXᵀX + αI */
  precision: number[][];
  /** 条件方差 1/Λ_ii（平均场 CAVI 的收敛目标——非边缘方差） */
  condVar: number[];
  /** ln p(y)（d 维公式解析；n 维 Cholesky 口径在验证脚本独立对照） */
  logMarginalLikelihood: number;
  /** Λ 分解实际加入的对角抖动（0 = 精确分解；R5-A3 病态回退的审计字段） */
  jitter?: number;
}

/**
 * 共轭贝叶斯线性回归的解析后验：w|y ~ N(m, Σ)，
 * Λ = βXᵀX + αI，Σ = Λ⁻¹，m = βΛ⁻¹Xᵀy。
 * 导出供 CAVI 验证（收敛锚点）与 6.0 自由能的 q 侧真值对照。
 */
export function conjugateLinearRegressionPosterior(
  X: number[][],
  y: number[],
  alpha: number,
  beta: number,
): ConjugatePosterior {
  const { n, d } = validateDesign(X, y, alpha, beta);
  const Lam: number[][] = Array.from({ length: d }, (_, i) =>
    Array.from({ length: d }, (_, j) => {
      let s = 0;
      for (let k = 0; k < n; k += 1) s += X[k][i] * X[k][j];
      return beta * s + (i === j ? alpha : 0);
    }),
  );
  const Xty = new Array<number>(d).fill(0);
  for (let k = 0; k < n; k += 1) {
    for (let j = 0; j < d; j += 1) Xty[j] += X[k][j] * y[k];
  }
  const decomp = choleskyLowerJittered(Lam);
  if (!decomp) throw new Error('conjugateLinearRegressionPosterior: Λ = βXᵀX + αI 非正定（抖动阶梯全部失败）');
  const L = decomp.L;
  const mean = cholSolve(L, Xty.map((v) => beta * v));
  const cov = cholInverse(L);
  let logDet = 0;
  for (let i = 0; i < d; i += 1) logDet += 2 * Math.log(L[i][i]);
  let yty = 0;
  for (let k = 0; k < n; k += 1) yty += y[k] * y[k];
  const LinvXty = cholSolve(L, Xty);
  let quad = 0;
  for (let j = 0; j < d; j += 1) quad += Xty[j] * LinvXty[j];
  const logMarginalLikelihood =
    0.5 * (d * Math.log(alpha) - logDet - n * Math.log((2 * Math.PI) / beta) - beta * yty + beta * beta * quad);
  return { dim: d, mean, cov, precision: Lam, condVar: Lam.map((row, i) => 1 / row[i]), logMarginalLikelihood, jitter: decomp.jitter };
}

// ─────────────────────────── 问题规格与配置 ───────────────────────────

/** 问题种类（const 对象替代 enum，strip-types 兼容） */
export const VI_KIND = {
  /** 共轭线性回归（闭式 CAVI） */
  linearRegression: 'linearRegression',
  /** 非共轭一般对数联合密度（重参数化高斯 VI） */
  gaussianVI: 'gaussianVI',
} as const;

export type ViKind = (typeof VI_KIND)[keyof typeof VI_KIND];

/** 共轭规格：y = Xw + ε，w~N(0,α⁻¹I)，ε~N(0,β⁻¹I) */
export interface LinearRegressionSpec {
  /** 设计矩阵（n×d） */
  X: number[][];
  /** 观测（长度 n） */
  y: number[];
  /** 先验精度 α */
  alpha: number;
  /** 噪声精度 β */
  beta: number;
}

/** 非共轭规格：只需 ln p(y,z) 与（可选）其梯度 */
export interface GaussianVISpec {
  /** 联合对数密度（可差任意常数——常数项不改变最优 q） */
  logJoint: (z: number[]) => number;
  /** 解析梯度（缺省中心差分，每次求值 2d 次 logJoint） */
  gradLogJoint?: (z: number[]) => number[];
  /** 参数维数 */
  dim: number;
}

export type VIProblem = ({ kind: 'linearRegression' } & LinearRegressionSpec) | ({ kind: 'gaussianVI' } & GaussianVISpec);

export interface VIConfig {
  /** 非共轭 CRN 种子（固定 → 全程逐位可复现） */
  seed: number;
  /** 非共轭 CRN 样本数（E_ε 的确定性估计；内部向下取偶成 antithetic 对） */
  mcSamples: number;
  /** 初始标准差 s（缺省 1） */
  initStd: number;
  /** 非共轭梯度步长初值（Armijo 回溯自动收缩） */
  stepInit: number;
  /** R5-A3：非共轭路线用自然梯度方向 d = F⁻¹∇（缺省 false = 普通梯度，逐位旧路径） */
  naturalGradient?: boolean;
}

export const DEFAULT_VI_CONFIG: VIConfig = {
  seed: 20260101,
  mcSamples: 256,
  initStd: 1,
  stepInit: 0.2,
};

export interface VIFitOptions {
  /** 最大迭代数（缺省 300） */
  iters?: number;
  /** 收敛阈（参数最大变动 < tol 早停；tol = 0 禁用早停，缺省按问题种类） */
  tol?: number;
  /**
   * R5-A3：ELBO 平台早停阈（缺省 0 禁用）。> 0 时，当 |ΔELBO| 连续
   * plateauSteps 步 ≤ elboTol·max(1,|ELBO|) 即判定收敛——证据是平台
   * 先于参数静止（缓收敛设计的 ELBO 在坐标末段已贴住上界）。
   */
  elboTol?: number;
  /** ELBO 平台判定的连续步数（缺省 3；elboTol > 0 时生效） */
  plateauSteps?: number;
}

export interface VIFitResult {
  /** 平均场均值 m_i */
  means: number[];
  /** 平均场方差 s_i² */
  vars: number[];
  /** 每次迭代后的 ELBO 轨迹（单调不减） */
  elboTrace: number[];
  /** 实际迭代数（= elboTrace.length） */
  iterations: number;
  /** 是否按 tol 早停收敛 */
  converged: boolean;
  finalElbo: number;
}

// ─────────────────────────── 内核实现 ───────────────────────────

/**
 * 变分推断引擎（平均场高斯族）。
 *
 * - linearRegression: 闭式 CAVI 坐标扫描（caviStep 可单步调用）；
 * - gaussianVI: 固定 CRN 集上的解析梯度 + Armijo 回溯，只接受提升步。
 *
 * 同输入同输出：非共轭路线的 ε 集由 config.seed 确定，构造即固定。
 */
export class VariationalEngine {
  private readonly problem: VIProblem;
  private readonly config: VIConfig;
  private readonly dim: number;
  private means: number[];
  private vars: number[];
  private readonly lin: { X: number[][]; y: number[]; alpha: number; beta: number } | undefined;
  private readonly nc: { logJoint: (z: number[]) => number; grad?: (z: number[]) => number[] } | undefined;
  private readonly XtX: number[][] = [];
  private readonly Xty: number[] = [];
  private readonly eps: number[][] | undefined;
  private stepSize: number;

  constructor(problem: VIProblem, config?: Partial<VIConfig>) {
    this.config = { ...DEFAULT_VI_CONFIG, ...config };
    const c = this.config;
    if (!Number.isFinite(c.seed)) throw new Error('variationalInference: seed 必须为有限数');
    if (!Number.isInteger(c.mcSamples) || c.mcSamples < 16) throw new Error('variationalInference: mcSamples 需为 ≥ 16 的整数');
    if (!(c.initStd > 0) || !Number.isFinite(c.initStd)) throw new Error('variationalInference: initStd 必须 > 0');
    if (!(c.stepInit > 0) || !Number.isFinite(c.stepInit)) throw new Error('variationalInference: stepInit 必须 > 0');
    this.problem = problem;
    this.stepSize = c.stepInit;

    if (problem.kind === VI_KIND.linearRegression) {
      const { n, d } = validateDesign(problem.X, problem.y, problem.alpha, problem.beta);
      this.dim = d;
      this.lin = { X: problem.X, y: problem.y, alpha: problem.alpha, beta: problem.beta };
      this.XtX = Array.from({ length: d }, (_, i) =>
        Array.from({ length: d }, (_, j) => {
          let s = 0;
          for (let k = 0; k < n; k += 1) s += problem.X[k][i] * problem.X[k][j];
          return s;
        }),
      );
      this.Xty = new Array<number>(d).fill(0);
      for (let k = 0; k < n; k += 1) {
        for (let j = 0; j < d; j += 1) this.Xty[j] += problem.X[k][j] * problem.y[k];
      }
    } else {
      if (typeof problem.logJoint !== 'function') throw new Error('variationalInference: gaussianVI 需要 logJoint 函数');
      if (problem.gradLogJoint !== undefined && typeof problem.gradLogJoint !== 'function') {
        throw new Error('variationalInference: gradLogJoint 需为函数或省略');
      }
      if (!Number.isInteger(problem.dim) || problem.dim < 1) throw new Error('variationalInference: dim 需为 ≥ 1 的整数');
      this.dim = problem.dim;
      this.nc = { logJoint: problem.logJoint, grad: problem.gradLogJoint };
      // 固定公共随机数集（CRN，antithetic 对 (ε, −ε)）：ELBO 估计成为
      // (m,s) 的确定性光滑函数，且关于 m **严格偶对称**（对称后验的
      // 最优 m 精确为 0——验证 razor），同时方差减半。L 向下取偶。
      const rng = mulberry32(c.seed);
      const half = Math.floor(c.mcSamples / 2);
      this.eps = [];
      for (let l = 0; l < half; l += 1) {
        const e = Array.from({ length: this.dim }, () => gaussianNoise(rng));
        this.eps.push(e, e.map((v) => -v));
      }
    }
    this.means = new Array<number>(this.dim).fill(0);
    this.vars = new Array<number>(this.dim).fill(c.initStd * c.initStd);
  }

  /** 问题种类 */
  get kind(): ViKind {
    return this.problem.kind;
  }

  /** 当前平均场参数（拷贝） */
  get state(): { means: number[]; vars: number[] } {
    return { means: [...this.means], vars: [...this.vars] };
  }

  /**
   * 单次 CAVI 坐标扫描（仅共轭线性回归；返回扫描后 ELBO）。
   * 逐坐标闭式：s_i² ← 1/Λ_ii，m_i ← s_i²·β[(Xᵀy)_i − Σ_{j≠i}[XᵀX]_ij·m_j]。
   */
  caviStep(): number {
    if (this.problem.kind !== VI_KIND.linearRegression) {
      throw new Error('caviStep: 仅共轭线性回归有闭式坐标更新（非共轭请用 fit）');
    }
    this.caviSweep();
    return this.elbo();
  }

  /**
   * 拟合（迭代至收敛 / 上限）。tol = 0 禁用早停（验证单调性用全轨迹）。
   */
  fit(opts: VIFitOptions = {}): VIFitResult {
    const iters = opts.iters ?? 300;
    if (!Number.isInteger(iters) || iters < 1 || iters > 1_000_000) {
      throw new Error('fit: iters 需为 1..1e6 的整数');
    }
    const tol = opts.tol ?? (this.problem.kind === VI_KIND.linearRegression ? 1e-12 : 1e-7);
    if (!(tol >= 0) || !Number.isFinite(tol)) throw new Error('fit: tol 需为 ≥ 0 的有限数');
    const elboTol = opts.elboTol ?? 0;
    if (!(elboTol >= 0) || !Number.isFinite(elboTol)) throw new Error('fit: elboTol 需为 ≥ 0 的有限数');
    const plateauNeed = opts.plateauSteps ?? 3;
    if (!Number.isInteger(plateauNeed) || plateauNeed < 1 || plateauNeed > 1000) {
      throw new Error('fit: plateauSteps 需为 1..1000 的整数');
    }
    const trace: number[] = [];
    let converged = false;
    let plateau = 0;
    for (let k = 0; k < iters; k += 1) {
      let delta: number;
      if (this.problem.kind === VI_KIND.linearRegression) {
        const prev = [...this.means];
        this.caviSweep();
        delta = Math.max(...this.means.map((v, i) => Math.abs(v - prev[i])));
      } else {
        const prevM = [...this.means];
        const prevS = [...this.vars];
        this.gradientSweep();
        delta = Math.max(
          ...this.means.map((v, i) => Math.abs(v - prevM[i])),
          ...this.vars.map((v, i) => Math.abs(v - prevS[i])),
        );
      }
      const e = this.elbo();
      trace.push(e);
      if (elboTol > 0 && trace.length >= 2) {
        // 平台判据：相邻 ELBO 相对变动连续 plateauNeed 步 ≤ elboTol
        plateau = Math.abs(e - trace[trace.length - 2]) <= elboTol * Math.max(1, Math.abs(e)) ? plateau + 1 : 0;
        if (plateau >= plateauNeed) {
          converged = true;
          break;
        }
      }
      if (tol > 0 && delta < tol) {
        converged = true;
        break;
      }
    }
    return {
      means: [...this.means],
      vars: [...this.vars],
      elboTrace: trace,
      iterations: trace.length,
      converged,
      finalElbo: trace.length > 0 ? trace[trace.length - 1] : this.elbo(),
    };
  }

  /**
   * 当前 ELBO。共轭：闭式（见文件头）；非共轭：CRN 确定性估计
   * ELBÔ(m,s) = (1/L)Σ_l ln p(y, m+s⊙ε_l) + Σ ln s_i + (d/2)(1+ln 2π)。
   */
  elbo(): number {
    if (this.problem.kind === VI_KIND.linearRegression) {
      const lin = this.lin!;
      const n = lin.y.length;
      const d = this.dim;
      // E_q‖y − Xw‖² = ‖y − Xm‖² + Σ_j s_j²·‖X_:,j‖²
      let resid = 0;
      for (let i = 0; i < n; i += 1) {
        let pred = 0;
        for (let j = 0; j < d; j += 1) pred += lin.X[i][j] * this.means[j];
        const e = lin.y[i] - pred;
        resid += e * e;
      }
      for (let j = 0; j < d; j += 1) resid += this.vars[j] * this.XtX[j][j];
      let nrm = 0;
      let ssum = 0;
      let ent = 0;
      for (let j = 0; j < d; j += 1) {
        nrm += this.means[j] * this.means[j];
        ssum += this.vars[j];
        ent += 0.5 * Math.log(2 * Math.PI * Math.E * this.vars[j]);
      }
      return (
        0.5 * n * Math.log(lin.beta / (2 * Math.PI)) -
        0.5 * lin.beta * resid +
        0.5 * d * Math.log(lin.alpha / (2 * Math.PI)) -
        0.5 * lin.alpha * (nrm + ssum) +
        ent
      );
    }
    return this.crnElbo(this.means, this.vars);
  }

  // ─────────────────────────── 内部 ───────────────────────────

  private caviSweep(): void {
    const lin = this.lin!;
    const d = this.dim;
    for (let i = 0; i < d; i += 1) {
      const prec = lin.beta * this.XtX[i][i] + lin.alpha;
      let linTerm = lin.beta * this.Xty[i];
      for (let j = 0; j < d; j += 1) {
        if (j !== i) linTerm -= lin.beta * this.XtX[i][j] * this.means[j];
      }
      this.vars[i] = 1 / prec;
      this.means[i] = this.vars[i] * linTerm;
    }
  }

  /** CRN 期望下的 ELBO（任意 (m,s) 处；s 需 > 0） */
  private crnElbo(m: number[], s: number[]): number {
    const d = this.dim;
    const L = this.eps!.length;
    if (s.some((v) => !(v > 0) || !Number.isFinite(v))) throw new Error('variationalInference: s 必须 > 0');
    let obj = 0;
    for (let j = 0; j < d; j += 1) obj += Math.log(s[j]);
    const z = new Array<number>(d).fill(0);
    for (let l = 0; l < L; l += 1) {
      for (let j = 0; j < d; j += 1) z[j] = m[j] + s[j] * this.eps![l][j];
      obj += this.callLogJoint(z) / L;
    }
    return obj + (d / 2) * (1 + Math.log(2 * Math.PI));
  }

  private callLogJoint(z: number[]): number {
    const v = this.nc!.logJoint(z);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('variationalInference: logJoint 需返回有限数值');
    return v;
  }

  /** ∇_z ln p（解析优先，缺省中心差分） */
  private gradOf(z: number[]): number[] {
    const d = this.dim;
    const grad = this.nc!.grad;
    if (grad) {
      const g = grad(z);
      if (!Array.isArray(g) || g.length !== d || g.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
        throw new Error('variationalInference: gradLogJoint 需返回长度 dim 的有限数值数组');
      }
      return g;
    }
    const g = new Array<number>(d).fill(0);
    const zp = [...z];
    const zm = [...z];
    for (let j = 0; j < d; j += 1) {
      const h = 1e-5 * Math.max(1, Math.abs(z[j]));
      zp[j] = z[j] + h;
      zm[j] = z[j] - h;
      g[j] = (this.callLogJoint(zp) - this.callLogJoint(zm)) / (2 * h);
      zp[j] = z[j];
      zm[j] = z[j];
    }
    return g;
  }

  /**
   * 非共轭单步：CRN 解析梯度 + Armijo 回溯，只接受提升步
   * （ELBO 轨迹单调不减由构造保证；找不到提升步时原地不动）。
   */
  private gradientSweep(): void {
    const d = this.dim;
    const L = this.eps!.length;
    const gm = new Array<number>(d).fill(0);
    const gs = new Array<number>(d).fill(0);
    let obj = 0;
    for (let j = 0; j < d; j += 1) obj += Math.log(this.vars[j]);
    const z = new Array<number>(d).fill(0);
    for (let l = 0; l < L; l += 1) {
      for (let j = 0; j < d; j += 1) z[j] = this.means[j] + this.vars[j] * this.eps![l][j];
      const g = this.gradOf(z);
      obj += this.callLogJoint(z) / L;
      for (let j = 0; j < d; j += 1) {
        gm[j] += g[j] / L;
        gs[j] += (g[j] * this.eps![l][j]) / L;
      }
    }
    for (let j = 0; j < d; j += 1) gs[j] += 1 / this.vars[j];
    obj += (d / 2) * (1 + Math.log(2 * Math.PI));

    // R5-A3：搜索方向。普通梯度 d = ∇；自然梯度 d = F⁻¹∇（对角高斯族
    // 的 Fisher 信息 F = diag(1/s², 2/s²) ⟹ d_m = ∇_m、d_s = (s²/2)·∇_s）。
    // 两方向均为上升方向（dᵀ∇ = ‖∇‖² > 0 / F⁻¹∇ 的 ∇ 内积 > 0），
    // Armijo 条件用方向导数 slope = dᵀ∇ 保持「只接受提升步」的单调性构造。
    const useNg = this.config.naturalGradient === true;
    const dirM = gm;
    const dirS = useNg ? gs.map((v, j) => (this.vars[j] * this.vars[j] * v) / 2) : gs;
    const slope = useNg
      ? gm.reduce((s, v, j) => s + v * dirM[j], 0) + gs.reduce((s, v, j) => s + v * dirS[j], 0)
      : gm.reduce((s, v) => s + v * v, 0) + gs.reduce((s, v) => s + v * v, 0);
    if (!(slope > 1e-24)) return; // 数值驻点
    let t = this.stepSize;
    for (let tries = 0; tries < 60 && t > 1e-14; tries += 1) {
      if (this.vars.every((v, j) => v + t * dirS[j] > 1e-10)) {
        const m2 = this.means.map((v, j) => v + t * dirM[j]);
        const s2 = this.vars.map((v, j) => v + t * dirS[j]);
        const obj2 = this.crnElbo(m2, s2);
        if (obj2 >= obj + 1e-4 * t * slope) {
          for (let j = 0; j < d; j += 1) {
            this.means[j] = m2[j];
            this.vars[j] = s2[j];
          }
          this.stepSize = Math.min(this.stepSize * 1.2, 1);
          return;
        }
      }
      t *= 0.5;
    }
    this.stepSize = Math.max(this.stepSize * 0.5, 1e-8); // 回退收缩，下轮再试
  }
}

// ─────────────────────────── 非共轭测试台：贝叶斯逻辑回归 ───────────────────────────

/** 数值稳定 softplus（ln(1+e^t)） */
function softplus(t: number): number {
  if (t > 35) return t;
  if (t < -35) return 0;
  return Math.log1p(Math.exp(t));
}

/** 数值稳定 sigmoid */
function sigmoid(t: number): number {
  if (t >= 0) return 1 / (1 + Math.exp(-t));
  const e = Math.exp(t);
  return e / (1 + e);
}

export interface LogisticModel {
  /** ln p(y, w)（含先验归一化常数；可差常数不影响 VI） */
  logJoint: (w: number[]) => number;
  /** ∇_w ln p(y, w) = Σ_n (y_n − σ(x_nᵀw))·x_n − αw */
  gradLogJoint: (w: number[]) => number[];
}

/**
 * 贝叶斯逻辑回归的 ln p(y,w) 与解析梯度（非共轭路线的标准测试台）：
 *   y_n ∈ {0,1}，ln p(y|w) = Σ_n [y_n·ln σ(t_n) + (1−y_n)·ln(1−σ(t_n))]，
 *   t_n = x_nᵀw；先验 w ~ N(0, α⁻¹I)。稳定口径：ln σ = −softplus(−t)。
 */
export function logisticRegressionLogJoint(X: number[][], y: number[], alpha: number): LogisticModel {
  const { n, d } = validateDesign(X, y, alpha, 1);
  if (!y.every((v) => v === 0 || v === 1)) throw new Error('logisticRegressionLogJoint: y 需为 0/1 标签');
  const dot = (row: number[], w: number[]): number => {
    let s = 0;
    for (let j = 0; j < d; j += 1) s += row[j] * w[j];
    return s;
  };
  const logJoint = (w: number[]): number => {
    if (!Array.isArray(w) || w.length !== d || w.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error('logJoint: w 需为长度 d 的有限数值数组');
    }
    let ll = 0;
    for (let i = 0; i < n; i += 1) {
      const t = dot(X[i], w);
      ll -= y[i] * softplus(-t) + (1 - y[i]) * softplus(t);
    }
    let nrm = 0;
    for (let j = 0; j < d; j += 1) nrm += w[j] * w[j];
    return ll - 0.5 * alpha * nrm - (d / 2) * Math.log((2 * Math.PI) / alpha);
  };
  const gradLogJoint = (w: number[]): number[] => {
    if (!Array.isArray(w) || w.length !== d || w.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error('gradLogJoint: w 需为长度 d 的有限数值数组');
    }
    const g = new Array<number>(d).fill(0);
    for (let i = 0; i < n; i += 1) {
      const s = y[i] - sigmoid(dot(X[i], w));
      for (let j = 0; j < d; j += 1) g[j] += s * X[i][j];
    }
    for (let j = 0; j < d; j += 1) g[j] -= alpha * w[j];
    return g;
  };
  return { logJoint, gradLogJoint };
}

/* ── 接线建议 ──
 * 挂载引擎: meta-cognition（元认知自我模型）——世界模型校准史回归系数、
 *   因果边效应强度的后验从「点估计 + 手拍区间」升级为平均场后验
 *   N(m_i, s_i²)；为 6.0 自由能引擎的 KL(q‖p) 提供真正的 q 分布，
 *   ELBO 终值即变分自由能 −F，直接进元认知 KPI（预测握力的信息论口径）。
 * 建议方法: metaCognition.attachVariationalInference(options?)——对照
 *   strategy-evolution.attachInformationGeometry（18.0）的接线模式，
 *   挂载后只读消费，不动既有决策路径。
 * 缺省关闭旗标: config.kernels.variationalInferenceEnabled = false
 *   （未开启时元认知一切路径与现状逐位一致——零介入）。
 * 决策点:
 *   - 信念对账（world-model / 6.0 变分自由能）: q 侧来源从点估计升级为
 *     CAVI 后验，driftDetected 第一次有分布级判据；
 *   - 多模型调度: 模型成功率后验用高斯 VI（非共轭路线）近似，s_i 大的
 *     模型自动获得探索加成——探索率由后验不确定度内生，不再拍脑袋；
 *   - 升级门: fit().converged === false 或迭代触顶时回退点估计（失败
 *     诚实降级，不拿半收敛的后验冒充真后验）。
 */
