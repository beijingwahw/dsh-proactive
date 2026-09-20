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
 *     P∞ 满足 P∞ = q + r·P∞/(P∞+r) → P∞ = (q + √(q²+4qr))/2,
 *     K∞ = P∞/(P∞+r)——Riccati 迭代收敛于此（精确对照）。
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
  return A.map((row, i) => row.map((v, j) => v - B[i]![j]!));
}

function identity(n: number): Matrix {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
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

/** χ² 分布分位数（自由度 df、上侧概率 p） */
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

/**
 * 线性高斯卡尔曼滤波器（dim ≤ 3 的小矩阵实现，标量观测）。
 *
 * predict()/update() 分离（无观测的心跳可只预测），step(z) = 预测 + 更新 +
 * 门控判定。所有数值在线更新，无历史缓冲（内存 O(dim²)）。
 */
export class KalmanFilter {
  private readonly model: KalmanModel;
  private readonly gateQuantile: number;
  private readonly gateThreshold: number;
  private x: Vec;
  private P: Matrix;

  constructor(model: KalmanModel, gateP = 0.997) {
    this.model = model;
    this.gateQuantile = gateP;
    this.gateThreshold = chiSquareQuantile(gateP, model.H.length);
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

  /** 观测更新（假设已 predict） */
  update(z: number): KalmanStepResult {
    const { H, R } = this.model;
    const Hx = asVec(matMul(H, asMatrix(this.x)))[0]!;
    const innovation = z - Hx;
    // S = H·P·Hᵀ + R（标量观测 → 标量 S）
    const S = matMul(matMul(H, this.P), matT(H))[0]![0]! + R[0]![0]!;
    const PHt = matMul(this.P, matT(H));
    const K = PHt.map((row) => row.map((v) => v / S));
    this.x = asVec(matAdd(asMatrix(this.x), matMul(K, [[innovation]])));
    const KH = matMul(K, H);
    this.P = matMul(matSub(identity(this.x.length), KH), this.P);
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
