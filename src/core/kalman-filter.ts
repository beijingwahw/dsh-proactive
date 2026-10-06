/**
 * 27.0 卡尔曼滤波内核 —— 线性高斯状态空间滤波 + RTS 平滑 + NIS 门控
 *
 * 动机: KPI 快照是**带噪的状态观测**——成功率的真水平被采样噪声、窗口效应、
 * 瞬时抖动遮蔽。z-score（meta-cognition 1 号检查）在窗口内做无记忆比较，
 * 而卡尔曼滤波把整条历史压缩进 (x, P) 两个充分统计量：
 *
 *   预测:  x⁻ = F·x,  P⁻ = F·P·Fᵀ + Q
 *   更新:  y = z − H·x⁻（新息）,  S = H·P⁻·Hᵀ + R
 *          K = P⁻·Hᵀ·S⁻¹（最优增益 = 最小方差）
 *          x = x⁻ + K·y,  P = (I−K·H)·P⁻
 *   新息平方和 NIS = yᵀ·S⁻¹·y ~ χ²(dim)（模型正确时）
 *     → NIS 门控: 突变不是「窗口均值变了」而是「新息超出模型方差 99.7%
 *       分位」——异常判定从启发式升级为假设检验。
 *
 *   平滑（RTS，批量回看）: 后向递推把未来信息回灌历史估计——
 *     趋势斜率的「事后最优」读数（检测缓慢漂移比滤波更早确认）。
 *
 *   随机游走稳态解析解（验证锚点）: q 过程噪声 / r 观测噪声,
 *     后验 P∞ 满足 P² + q·P − q·r = 0 → P∞ = (√(q²+4qr) − q)/2
 *     （等价地预测方差 P⁻∞ = P∞ + q = (q + √(q²+4qr))/2）——
 *     Riccati 迭代收敛于此（精确对照，见 randomWalkSteadyState）。
 *
 * ── R5-A3 世界性进化（第五轮）──
 * 数学进化（UKF 无迹卡尔曼）: UnscentedKalmanFilter——非线性模型的
 *   确定性采样推断。对称 2n+1 sigma 点集（X₀ = x，X±ᵢ = x ± √(n+λ)·Lᵢ，
 *   P = LLᵀ）经 f/h 映射后加权重构均值/协方差（权重 ΣWᵐ = 1）。
 *   线性 f/h 下 UT **精确**重现矩（ΣWᶜ(Xᵢ−x̄)(Xᵢ−x̄)ᵀ = LLᵀ 逐项可验）
 *   ⟹ UKF ≡ KF（验证锚点）；非线性下捕获三阶矩（对称点集），
 *   优于 EKF 的一阶线性化（验证脚本 sin 观测下与求积真值对照）。
 *   标量观测的特殊结构使更新全为一阶量：S 标量、K = P_xz/S、
 *   P ← P − P_xzP_xzᵀ/S——无矩阵求逆。
 *
 * 性能进化（标量测量特化）: KalmanFilter.update 的通用矩阵链
 *   (H·P·Hᵀ、P·Hᵀ、K·H、(I−KH)·P) 在标量观测（H 为 1×n）下全部退化为
 *   向量运算——特化实现按与 matMul 链**完全相同的累加次序**重写
 *   （c1[j] = ΣₖhₖPₖⱼ → S = Σⱼc1[j]hⱼ + r；Kᵢ = ΣₖPᵢₖhₖ/S；
 *   P'ᵢⱼ = Σₖ[(δᵢₖ − Kᵢhₖ)Pₖⱼ]），结果与原实现**逐位一致**（验证
 *   脚本逐位对照），去掉全部中间矩阵分配/转置——20000 步趋势滤波
 *   实测提速（验证脚本耗时对照）。
 *
 * 数值稳健性（Joseph 型更新选项）: covarianceForm: 'joseph' 时
 *   P ← (I−KH)P(I−KH)ᵀ + KRKᵀ（随后对称化）——两项均 PSD，长序列/
 *   增益趋 1 的病态场景不产生负特征值，且**精确对称**（标准型
 *   (I−KH)P 的舍入不对称随步数累积）。缺省 'standard' 保持旧路径。
 *   UKF 的 sigma 点分解用尺度相对抖动阶梯的 Cholesky（P 病态时不崩）。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致。
 */

// ─────────────────────────── 小矩阵工具（dim ≤ 3） ───────────────────────────

type Matrix = number[][];

function matMul(A: Matrix, B: Matrix): Matrix {
  const n = A.length;
  const m = B[0]!.length;
  const k = B.length;
  const C: Matrix = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      let sum = 0;
      for (let t = 0; t < k; t += 1) sum += A[i]![t]! * B[t]![j]!;
      C[i]![j] = sum;
    }
  }
  return C;
}

function matT(A: Matrix): Matrix {
  return A[0]!.map((_, j) => A.map((row) => row[j]!));
}

function matAdd(A: Matrix, B: Matrix): Matrix {
  return A.map((row, i) => row.map((v, j) => v + B[i]![j]!));
}

function matSub(A: Matrix, B: Matrix): Matrix {
  return A.map((row, i) => row.map((v, j) => v - B[i][j]));
}

/** 列向量 */
type Vec = number[];
function asMatrix(v: Vec): Matrix {
  return v.map((x) => [x]);
}
function asVec(m: Matrix): Vec {
  return m.map((row) => row[0]!);
}

// ─────────────────────────── χ² 分位数表 ───────────────────────────

/** 常用 (df, p) 精确分位数；其余 Wilson-Hilferty 近似（误差 < 0.5%） */
const CHI2_TABLE: Record<string, number> = {
  '1:0.90': 2.7055,
  '1:0.95': 3.8415,
  '1:0.99': 6.6349,
  '1:0.997': 8.8097,
  '2:0.90': 4.6052,
  '2:0.95': 5.9915,
  '2:0.99': 9.2103,
  '2:0.997': 11.6193,
};

/** 逆正态 CDF（Acklam 有理逼近，|误差| < 1.15e-9） */
function normalQuantile(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const pLow = 0.02425;
  const pp = Math.min(Math.max(p, 1e-20), 1 - 1e-20);
  if (pp < pLow) {
    const q = Math.sqrt(-2 * Math.log(pp));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (pp <= 1 - pLow) {
    const q = pp - 0.5;
    const r = q * q;
    return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - pp));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

/** χ² 分布分位数（自由度 df、累积概率 p——表中 0.997 即 NIS 门控缺省阈值的下侧分位） */
export function chiSquareQuantile(p: number, df: number): number {
  const hit = CHI2_TABLE[`${df}:${p}`];
  if (hit !== undefined) return hit;
  // Wilson-Hilferty: X ≈ df·(1 − 2/(9df) + z·√(2/(9df)))³, z = Φ⁻¹(p)
  const a = 2 / (9 * df);
  return df * Math.pow(1 - a + normalQuantile(p) * Math.sqrt(a), 3);
}

// ─────────────────────────── 通用线性高斯滤波器 ───────────────────────────

export interface KalmanModel {
  /** 状态转移 F */
  F: Matrix;
  /** 观测矩阵 H */
  H: Matrix;
  /** 过程噪声协方差 Q */
  Q: Matrix;
  /** 观测噪声协方差 R */
  R: Matrix;
  /** 初始状态（列向量） */
  x0: Vec;
  /** 初始协方差 */
  P0: Matrix;
}

export interface KalmanStepResult {
  /** 滤波后状态（列向量） */
  x: Vec;
  /** 新息（标量观测） */
  innovation: number;
  /** 新息方差 S */
  innovationVar: number;
  /** 新息平方和（NIS，模型正确时 ~ χ²(dim)） */
  nis: number;
  /** 本步对数似然（用于模型比较 / 变点检测） */
  logLikelihood: number;
  /** NIS 是否超过门控分位 */
  gated: boolean;
}

/** 协方差更新形式：standard = (I−KH)P（旧路径）；joseph = (I−KH)P(I−KH)ᵀ + KRKᵀ（PSD 保形） */
export type CovarianceForm = 'standard' | 'joseph';

/**
 * 线性高斯卡尔曼滤波器（dim ≤ 3 的小矩阵实现，标量观测）。
 *
 * predict()/update() 分离（无观测的心跳可只预测），step(z) = 预测 + 更新 +
 * 门控判定。所有数值在线更新，无历史缓冲（内存 O(dim²)）。
 *
 * R5-A3：update() 用标量测量特化实现（与原 matMul 链累加次序逐位一致，
 * 免中间矩阵分配）；covarianceForm = 'joseph' 可选 PSD 保形更新。
 */
export class KalmanFilter {
  private readonly model: KalmanModel;
  private readonly gateQuantile: number;
  private readonly gateThreshold: number;
  private readonly covForm: CovarianceForm;
  private x: Vec;
  private P: Matrix;

  constructor(model: KalmanModel, gateP = 0.997, opts?: { covarianceForm?: CovarianceForm }) {
    this.model = model;
    this.gateQuantile = gateP;
    this.gateThreshold = chiSquareQuantile(gateP, model.H.length);
    this.covForm = opts?.covarianceForm ?? 'standard';
    this.x = [...model.x0];
    this.P = model.P0.map((row) => [...row]);
  }

  /** 一步预测（不更新） */
  predict(): void {
    const F = this.model.F;
    this.x = asVec(matMul(F, asMatrix(this.x)));
    this.P = matAdd(matMul(matMul(F, this.P), matT(F)), this.model.Q);
  }

  /** 一步预测 + 观测更新 + NIS 门控 */
  step(z: number): KalmanStepResult {
    this.predict();
    return this.update(z);
  }

  /**
   * 观测更新（假设已 predict）——标量测量特化（R5-A3）。
   *
   * 与原通用矩阵链相同的累加次序（逐位一致）：
   *   Hx = Σₖ hₖxₖ；c1[j] = Σₖ hₖPₖⱼ；S = Σⱼ c1[j]hⱼ + r；
   *   Kᵢ = (Σₖ Pᵢₖhₖ)/S；P'ᵢⱼ = Σₖ (δᵢₖ − Kᵢhₖ)·Pₖⱼ。
   */
  update(z: number): KalmanStepResult {
    const { H, R } = this.model;
    const h = H[0];
    const n = this.x.length;
    const r = R[0][0];
    let Hx = 0;
    for (let k = 0; k < n; k += 1) Hx += h[k] * this.x[k];
    const innovation = z - Hx;
    // S = H·P·Hᵀ + r（c1 = H·P 的行向量，S 按 j 序累加——与 matMul 链同序）
    let S = 0;
    for (let j = 0; j < n; j += 1) {
      let s = 0;
      for (let k = 0; k < n; k += 1) s += h[k] * this.P[k][j];
      S += s * h[j];
    }
    S += r;
    // K = P·Hᵀ/S（PHtᵢ = Σₖ Pᵢₖhₖ，k 序与 matMul(P, Hᵀ) 同）
    const K = new Array<number>(n);
    for (let i = 0; i < n; i += 1) {
      let ph = 0;
      for (let k = 0; k < n; k += 1) ph += this.P[i][k] * h[k];
      K[i] = ph / S;
    }
    // x ← x + K·y（与 matAdd(asMatrix(x), matMul(K, [[y]])) 同值）
    for (let i = 0; i < n; i += 1) this.x[i] = this.x[i] + K[i] * innovation;
    if (this.covForm === 'joseph') {
      // Joseph 型：(I−KH)·P·(I−KH)ᵀ + K·r·Kᵀ（两项均 PSD），随后对称化
      const IKH: Matrix = Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => (i === j ? 1 : 0) - K[i] * h[j]),
      );
      const T = matMul(IKH, this.P); // (I−KH)P
      const JP = matMul(T, matT(IKH)); // (I−KH)P(I−KH)ᵀ
      for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n; j += 1) {
          JP[i][j] += K[i] * r * K[j];
        }
      }
      this.P = JP.map((row, i) => row.map((v, j) => 0.5 * (v + JP[j][i])));
    } else {
      // 标准型：P'ᵢⱼ = Σₖ (δᵢₖ − Kᵢhₖ)·Pₖⱼ（k 序与 matMul(I−KH, P) 同）
      const newP: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
      for (let i = 0; i < n; i += 1) {
        const ikh = new Array<number>(n);
        for (let k = 0; k < n; k += 1) ikh[k] = (i === k ? 1 : 0) - K[i] * h[k];
        for (let j = 0; j < n; j += 1) {
          let s = 0;
          for (let k = 0; k < n; k += 1) s += ikh[k] * this.P[k][j];
          newP[i][j] = s;
        }
      }
      this.P = newP;
    }
    const nis = (innovation * innovation) / Math.max(1e-12, S);
    const logLikelihood = -0.5 * (Math.log(2 * Math.PI * Math.max(1e-12, S)) + nis);
    return {
      x: [...this.x],
      innovation,
      innovationVar: S,
      nis,
      logLikelihood,
      gated: nis > this.gateThreshold,
    };
  }

  get state(): Vec {
    return [...this.x];
  }

  get covariance(): Matrix {
    return this.P.map((row) => [...row]);
  }

  get gate(): { p: number; threshold: number } {
    return { p: this.gateQuantile, threshold: this.gateThreshold };
  }
}

// ─────────────────────────── 随机游走稳态解析解 ───────────────────────────

/**
 * 随机游走 + 白噪观测的稳态滤波方差（精确闭式）：
 *   P∞ = (√(q² + 4·q·r) − q) / 2,  K∞ = P∞ / (P∞ + r)
 * （Riccati 稳态方程 P² + q·P − q·r = 0 的正根；验证锚点：迭代收敛于此值）
 */
export function randomWalkSteadyState(q: number, r: number): { pInf: number; kInf: number } {
  const pInf = (Math.sqrt(q * q + 4 * q * r) - q) / 2;
  return { pInf, kInf: pInf / (pInf + r) };
}

// ─────────────────────────── UKF 无迹卡尔曼滤波器（R5-A3） ───────────────────────────

/** 尺度相对抖动阶梯的 SPD Cholesky（sigma 点平方根分解用；0 级 = 精确） */
function cholLowerJittered(A: Matrix): { L: Matrix; jitter: number } | undefined {
  const n = A.length;
  let maxDiag = 0;
  for (let i = 0; i < n; i += 1) maxDiag = Math.max(maxDiag, Math.abs(A[i][i]));
  if (!(maxDiag > 0) || !Number.isFinite(maxDiag)) return undefined;
  for (const level of [0, 1e-12, 1e-10, 1e-8]) {
    const jitter = level * maxDiag;
    const L: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
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

/** 非线性模型规格：f 状态转移、h 标量观测、Q/R 噪声、UT 参数 */
export interface UnscentedModel {
  /** 状态转移 x⁺ = f(x)（非线性；长度须等于 dim） */
  f: (x: Vec) => Vec;
  /** 标量观测函数 z = h(x) + ε */
  h: (x: Vec) => number;
  /** 过程噪声协方差（dim×dim） */
  Q: Matrix;
  /** 观测噪声方差（标量观测） */
  r: number;
  /** 初始状态 */
  x0: Vec;
  /** 初始协方差 */
  P0: Matrix;
  /** UT 主标度 α（缺省 1；小值收缩 sigma 点分布） */
  alpha?: number;
  /** UT 高阶矩权重 β（缺省 2，高斯最优） */
  beta?: number;
  /** UT 自由参数 κ（缺省 0） */
  kappa?: number;
}

export interface UnscentedStepResult {
  x: Vec;
  innovation: number;
  innovationVar: number;
  nis: number;
  logLikelihood: number;
  gated: boolean;
}

/**
 * 无迹卡尔曼滤波器（UKF，R5-A3）：确定性 sigma 点采样推断非线性模型。
 *
 * 对称 2n+1 点集：X₀ = x，X_{±i} = x ± √(n+λ)·Lᵢ（P = LLᵀ 的第 i 列），
 * λ = α²(n+κ) − n；权重 W⁰ₘ = λ/(n+λ)、Wⁱₘ = 1/(2(n+λ))（ΣWᵐ = 1）、
 * W⁰ᶜ = W⁰ₘ + (1−α²+β)、Wⁱᶜ = Wⁱₘ。
 * 线性 f/h 下 UT 精确重现矩（ΣWᶜ(Xᵢ−x̄)(Xᵢ−x̄)ᵀ = LLᵀ = P）⟹ UKF ≡ KF；
 * 非线性下捕获至三阶矩（对称点集），优于 EKF 一阶线性化。
 * 标量观测：S 标量、K = P_xz/S、P ← P − P_xzP_xzᵀ/S——全程无矩阵求逆。
 */
export class UnscentedKalmanFilter {
  private readonly model: UnscentedModel;
  private readonly dim: number;
  private readonly wm: number[];
  private readonly wc: number[];
  private readonly gamma: number;
  private readonly gateThreshold: number;
  private x: Vec;
  private P: Matrix;

  constructor(model: UnscentedModel, gateP = 0.997) {
    if (typeof model.f !== 'function' || typeof model.h !== 'function') {
      throw new Error('UnscentedKalmanFilter: f 与 h 需为函数');
    }
    const dim = model.x0.length;
    if (!Number.isInteger(dim) || dim < 1) throw new Error('UnscentedKalmanFilter: x0 需为非空向量');
    if (
      !Array.isArray(model.P0) ||
      model.P0.length !== dim ||
      model.P0.some((row) => !Array.isArray(row) || row.length !== dim || row.some((v) => !Number.isFinite(v)))
    ) {
      throw new Error('UnscentedKalmanFilter: P0 需为 dim×dim 有限数值矩阵');
    }
    if (
      !Array.isArray(model.Q) ||
      model.Q.length !== dim ||
      model.Q.some((row) => !Array.isArray(row) || row.length !== dim || row.some((v) => !Number.isFinite(v)))
    ) {
      throw new Error('UnscentedKalmanFilter: Q 需为 dim×dim 有限数值矩阵');
    }
    if (!(model.r > 0) || !Number.isFinite(model.r)) throw new Error('UnscentedKalmanFilter: r 需 > 0');
    const alpha = model.alpha ?? 1;
    const beta = model.beta ?? 2;
    const kappa = model.kappa ?? 0;
    if (!(alpha > 0) || !Number.isFinite(alpha)) throw new Error('UnscentedKalmanFilter: alpha 需 > 0');
    if (!Number.isFinite(beta)) throw new Error('UnscentedKalmanFilter: beta 需为有限数');
    if (!Number.isFinite(kappa)) throw new Error('UnscentedKalmanFilter: kappa 需为有限数');
    const lam = alpha * alpha * (dim + kappa) - dim;
    if (!(dim + lam > 0)) throw new Error('UnscentedKalmanFilter: 需 n + λ > 0（检查 alpha/kappa）');
    this.model = model;
    this.dim = dim;
    this.gamma = Math.sqrt(dim + lam);
    this.wm = [lam / (dim + lam)];
    this.wc = [lam / (dim + lam) + (1 - alpha * alpha + beta)];
    for (let i = 0; i < 2 * dim; i += 1) {
      this.wm.push(1 / (2 * (dim + lam)));
      this.wc.push(1 / (2 * (dim + lam)));
    }
    this.gateThreshold = chiSquareQuantile(gateP, 1);
    this.x = [...model.x0];
    this.P = model.P0.map((row) => [...row]);
  }

  /** UT：生成 sigma 点（x 为中心，P 的列缩放 γ） */
  private sigmaPoints(): Vec[] {
    const n = this.dim;
    const decomp = cholLowerJittered(this.P);
    if (!decomp) throw new Error('UnscentedKalmanFilter: P 的 Cholesky 分解失败（协方差非正定）');
    const L = decomp.L;
    const pts: Vec[] = [[...this.x]];
    for (let i = 0; i < n; i += 1) {
      const plus = new Array<number>(n);
      const minus = new Array<number>(n);
      for (let k = 0; k < n; k += 1) {
        plus[k] = this.x[k] + this.gamma * L[k][i];
        minus[k] = this.x[k] - this.gamma * L[k][i];
      }
      pts.push(plus, minus);
    }
    return pts;
  }

  /** 一步预测：sigma 点过 f，加权重构均值/协方差（+ Q，对称化） */
  predict(): void {
    const n = this.dim;
    const pts = this.sigmaPoints();
    const Y = pts.map((p) => this.callF(p));
    const xm = new Array<number>(n).fill(0);
    for (let i = 0; i < Y.length; i += 1) {
      for (let k = 0; k < n; k += 1) xm[k] += this.wm[i] * Y[i][k];
    }
    const Pm: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let i = 0; i < Y.length; i += 1) {
      const w = this.wc[i];
      for (let a = 0; a < n; a += 1) {
        const da = Y[i][a] - xm[a];
        for (let b = 0; b < n; b += 1) Pm[a][b] += w * da * (Y[i][b] - xm[b]);
      }
    }
    for (let a = 0; a < n; a += 1) {
      for (let b = 0; b < n; b += 1) {
        this.P[a][b] = 0.5 * (Pm[a][b] + Pm[b][a]) + this.model.Q[a][b];
      }
    }
    this.x = xm;
  }

  /** 观测更新（假设已 predict）：标量 S、K = P_xz/S、P ← P − P_xzP_xzᵀ/S */
  update(z: number): UnscentedStepResult {
    const n = this.dim;
    const pts = this.sigmaPoints();
    const Z = pts.map((p) => this.callH(p));
    let zbar = 0;
    for (let i = 0; i < Z.length; i += 1) zbar += this.wm[i] * Z[i];
    let S = 0;
    for (let i = 0; i < Z.length; i += 1) {
      const d = Z[i] - zbar;
      S += this.wc[i] * d * d;
    }
    S += this.model.r;
    const Pxz = new Array<number>(n).fill(0);
    for (let i = 0; i < pts.length; i += 1) {
      const w = this.wc[i];
      const dz = Z[i] - zbar;
      for (let a = 0; a < n; a += 1) Pxz[a] += w * (pts[i][a] - this.x[a]) * dz;
    }
    const innovation = z - zbar;
    for (let a = 0; a < n; a += 1) this.x[a] += (Pxz[a] / S) * innovation;
    for (let a = 0; a < n; a += 1) {
      for (let b = 0; b < n; b += 1) this.P[a][b] -= (Pxz[a] * Pxz[b]) / S;
    }
    // 对称化（截断误差防御）
    for (let a = 0; a < n; a += 1) {
      for (let b = a + 1; b < n; b += 1) {
        const v = 0.5 * (this.P[a][b] + this.P[b][a]);
        this.P[a][b] = v;
        this.P[b][a] = v;
      }
    }
    const nis = (innovation * innovation) / Math.max(1e-12, S);
    const logLikelihood = -0.5 * (Math.log(2 * Math.PI * Math.max(1e-12, S)) + nis);
    return { x: [...this.x], innovation, innovationVar: S, nis, logLikelihood, gated: nis > this.gateThreshold };
  }

  /** 一步预测 + 观测更新 */
  step(z: number): UnscentedStepResult {
    this.predict();
    return this.update(z);
  }

  get state(): Vec {
    return [...this.x];
  }

  get covariance(): Matrix {
    return this.P.map((row) => [...row]);
  }

  private callF(p: Vec): Vec {
    const y = this.model.f(p);
    if (!Array.isArray(y) || y.length !== this.dim || y.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error('UnscentedKalmanFilter: f 需返回长度 dim 的有限数值数组');
    }
    return y;
  }

  private callH(p: Vec): number {
    const v = this.model.h(p);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('UnscentedKalmanFilter: h 需返回有限数值');
    return v;
  }
}

// ─────────────────────────── 局部线性趋势滤波器 ───────────────────────────

export interface TrendFilterConfig {
  /** 水平过程噪声 q_level（越大跟踪越快、越信新观测；缺省 1e-4） */
  qLevel: number;
  /** 斜率过程噪声 q_slope（缺省 1e-6） */
  qSlope: number;
  /** 观测噪声方差 r（缺省 2e-4） */
  r: number;
  /** NIS 门控上侧概率（缺省 0.997 ≈ 3σ） */
  gateP: number;
  /** 初始水平不确定度 */
  p0Level: number;
  /** 初始斜率不确定度 */
  p0Slope: number;
}

export const DEFAULT_TREND_FILTER_CONFIG: TrendFilterConfig = {
  qLevel: 1e-4,
  qSlope: 1e-6,
  r: 2e-4,
  gateP: 0.997,
  p0Level: 1.0,
  p0Slope: 0.01,
};

export interface TrendStepRead {
  /** 滤波水平（去噪后的当前值） */
  level: number;
  /** 滤波斜率（每步变化率） */
  slope: number;
  /** 新息 */
  innovation: number;
  /** NIS 与门控阈值 */
  nis: number;
  threshold: number;
  /** NIS 超门（异常观测） */
  gated: boolean;
  /** 水平的滤波方差 */
  levelVar: number;
  logLikelihood: number;
}

export interface SmoothedPoint {
  level: number;
  slope: number;
}

/**
 * 局部线性趋势滤波器（constant-velocity 模型，标量序列）：
 *
 *   状态 [level, slope]ᵀ,  F = [[1,1],[0,1]],  H = [1, 0]
 *   Q = diag(q_level, q_slope),  R = r
 *
 * 用途: KPI 序列的去噪读数（level）、缓慢漂移的早期读数（slope）、
 * 突变的假设检验（NIS 门控）。历史保留 filter 状态序列以支持 RTS 平滑。
 */
export class LocalLinearTrendFilter {
  private config: TrendFilterConfig;
  private filter: KalmanFilter;
  private history: Array<{ x: Vec; P: Matrix; innovation: number; innovationVar: number; nis: number; z: number }> = [];
  private last: TrendStepRead | undefined;

  constructor(config?: Partial<TrendFilterConfig>) {
    this.config = { ...DEFAULT_TREND_FILTER_CONFIG, ...config };
    this.filter = new KalmanFilter(
      {
        F: [[1, 1], [0, 1]],
        H: [[1, 0]],
        Q: [[this.config.qLevel, 0], [0, this.config.qSlope]],
        R: [[this.config.r]],
        x0: [0, 0],
        P0: [[this.config.p0Level, 0], [0, this.config.p0Slope]],
      },
      this.config.gateP,
    );
  }

  /** 喂入一个观测（自动先验初始化：首个观测把水平初始化为 z，收敛更快） */
  observe(z: number): TrendStepRead {
    if (this.history.length === 0) {
      this.filter = new KalmanFilter(
        {
          F: [[1, 1], [0, 1]],
          H: [[1, 0]],
          Q: [[this.config.qLevel, 0], [0, this.config.qSlope]],
          R: [[this.config.r]],
          x0: [z, 0],
          P0: [[this.config.p0Level, 0], [0, this.config.p0Slope]],
        },
        this.config.gateP,
      );
    }
    const r = this.filter.step(z);
    this.history.push({ x: r.x, P: this.filter.covariance, innovation: r.innovation, innovationVar: r.innovationVar, nis: r.nis, z });
    if (this.history.length > 256) this.history.shift();
    this.last = {
      level: r.x[0]!,
      slope: r.x[1]!,
      innovation: r.innovation,
      nis: r.nis,
      threshold: this.filter.gate.threshold,
      gated: r.gated,
      levelVar: this.filter.covariance[0]![0]!,
      logLikelihood: r.logLikelihood,
    };
    return this.last;
  }

  /** 最近一次滤波读数（纯读取；无观测时 undefined） */
  get lastRead(): TrendStepRead | undefined {
    return this.last;
  }

  /**
   * RTS 平滑（批量后向回看）：用全部历史给出每个时刻的事后最优
   * (level, slope)。缓慢漂移的确认比纯滤波更早、更稳。
   */
  smooth(): SmoothedPoint[] {
    const n = this.history.length;
    if (n === 0) return [];
    const xs = this.history.map((h) => [...h.x]);
    const Ps = this.history.map((h) => h.P.map((row) => [...row]));
    const F = [[1, 1], [0, 1]] as Matrix;
    for (let t = n - 2; t >= 0; t -= 1) {
      // 预测量（从 t 重算 t+1 的先验）
      const xPred = asVec(matMul(F, asMatrix(xs[t]!)));
      const PPred = matAdd(matMul(matMul(F, Ps[t]!), matT(F)), [[this.config.qLevel, 0], [0, this.config.qSlope]]);
      // 增益 G = P_t·Fᵀ·P_pred⁻¹（2×2 直接求逆）
      const det = PPred[0]![0]! * PPred[1]![1]! - PPred[0]![1]! * PPred[1]![0]!;
      if (Math.abs(det) < 1e-15) continue;
      const PPredInv: Matrix = [
        [PPred[1]![1]! / det, -PPred[0]![1]! / det],
        [-PPred[1]![0]! / det, PPred[0]![0]! / det],
      ];
      const G = matMul(matMul(Ps[t]!, matT(F)), PPredInv);
      xs[t] = asVec(matAdd(asMatrix(xs[t]!), matMul(G, matSub(asMatrix(xs[t + 1]!), asMatrix(xPred)))));
      Ps[t] = matAdd(Ps[t]!, matMul(matMul(G, matSub(Ps[t + 1]!, PPred)), matT(G)));
    }
    return xs.map((x) => ({ level: x[0]!, slope: x[1]! }));
  }

  get size(): number {
    return this.history.length;
  }
}
