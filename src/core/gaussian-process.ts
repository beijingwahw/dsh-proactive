/**
 * 26.0 高斯过程内核 —— RBF/Matérn 贝叶斯回归 + 期望改进贝叶斯优化
 *
 * 动机: 世界模型的预测校准史（predicted vs actual）是一条**时间序列**——
 * 「预测系统性偏高/偏低多少」本身随时间漂移（负载周期、模型更替、宿主行为
 * 变化）。EWPMA / 线性回归只能给点估计，GP 给出**带不确定度的非参数回归**：
 *
 *   f ~ GP(m, k),  k(x,x') = σf²·exp(−(x−x')²/2ℓ²)（RBF）
 *   后验（无噪观测推导，含噪以 σn 加入对角）:
 *     μ*(x) = k*ᵀ(K+σn²I)⁻¹y
 *     σ*²(x) = k(x,x) − k*ᵀ(K+σn²I)⁻¹k*
 *   边际似然（超参 ℓ,σf 由网格搜索极大化）:
 *     ln p(y|X,θ) = −½yᵀK_y⁻¹y − ½ln|K_y| − n/2·ln(2π)
 *
 *   贝叶斯优化（采集函数 = 期望改进 EI）:
 *     EI(x) = (μ*−y_best−ξ)·Φ(z) + σ*·φ(z),  z = (μ*−y_best−ξ)/σ*
 *   解析式与蒙特卡洛口径一致（验证脚本对照），全局搜索与局部精化自动平衡——
 *   不确定的地方探索（φ 项），确定的地方利用（Φ 项）。
 *
 * 数值稳定: Cholesky 分解带抖动升级（1e-10 → 1e-6），对数域计算 LML;
 *   y 标准化（均值 0 方差 1）、x 归一到 [0,1] 后再拟合，尺度不敏感。
 *
 * ── R5-A3 世界性进化（第五轮）──
 * 数学进化（FITC 稀疏 GP）: fitSparse(xs, ys, {numInducing})——诱导点
 *   近似（FITC/QFFG）：K ≈ Q + diag(K − Q) + σn²I，Q = K_xu K_uu⁻¹ K_ux。
 *   Woodbury 恒等式把 (Q+Λ)⁻¹ 的求解压到 m×m（m = 诱导点数）：
 *     (Q+Λ)⁻¹ = Λ⁻¹ − Λ⁻¹K_xu·B⁻¹·K_uxΛ⁻¹，B = K_uu + K_uxΛ⁻¹K_xu
 *   预测均值/方差均归结为预计算的 m 维量（β 向量与 G = C−CB⁻¹C 矩阵），
 *   单点预测 O(m²)（全 GP O(n²) 求解 + O(n) 核求值）；LML 用
 *     ln|Q+Λ| = Σlnλ + ln|B| − ln|K_uu|
 *   全程对数域。**m = n 且诱导点 = 训练点时 Q = K、λ = σn² ⟹ FITC ≡
 *   精确 GP**（验证脚本的收敛锚点：m→n 时后验与 LML 双双逼近全 GP）。
 *
 * 性能进化（核矩阵三角化 + 预测缓存 + 批量预测）:
 *   - kernelMatrix 只算下三角再镜像（核函数对称且 IEEE 平方/绝对值位级
 *     对称 ⟹ 结果逐位一致），fit 的 LML 网格搜索核求值次数减半；
 *   - fit 缓存归一化训练输入（nxTrain），predict 不再每点重算 O(n) 次
 *     归一化；predictBatch 一次批量多点（Cholesky 预分解复用的批量口径）。
 *
 * 数值稳健性（条件预警）: GpFitReport 新增 jitterApplied / conditionEstimate
 *   / illConditioned——λ̂max ≥ max diag(K_y)、λ̂min ≤ min L_ii² 的保守
 *   估计，κ 估计 > 1e12 或抖动非零时置警（重复观测点 + 小 σn 的经典
 *   病态可被调用方感知，而非静默拿到不可信后验）。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致。
 */

export type GpKernelKind = 'rbf' | 'matern52';

export interface GaussianProcessConfig {
  /** 协方差核族（缺省 rbf；matern52 假设更粗糙，对阶跃漂移更稳健） */
  kernel: GpKernelKind;
  /** 信号标准差 σf（标准化 y 尺度；缺省 1.0） */
  sigmaF: number;
  /** 长度尺度 ℓ（x 归一到 [0,1] 后；缺省 0.3） */
  lengthScale: number;
  /** 观测噪声标准差 σn（标准化 y 尺度；缺省 0.1） */
  sigmaN: number;
  /** 训练点上限（超出丢弃最旧；缺省 64） */
  maxPoints: number;
  /** 是否网格搜索 (ℓ, σf) 极大化 LML（缺省 true） */
  tuneHyperparams: boolean;
}

export const DEFAULT_GP_CONFIG: GaussianProcessConfig = {
  kernel: 'rbf',
  sigmaF: 1.0,
  lengthScale: 0.3,
  sigmaN: 0.1,
  maxPoints: 64,
  tuneHyperparams: true,
};

/** Cholesky 分解（下三角），失败时抖动逐级升级，全失败返回 undefined */
export function choleskyLower(A: number[][]): { L: number[][]; jitter: number } | undefined {
  const n = A.length;
  for (const jitter of [0, 1e-10, 1e-8, 1e-6]) {
    const L: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    let ok = true;
    for (let i = 0; i < n && ok; i += 1) {
      for (let j = 0; j <= i; j += 1) {
        let sum = A[i]![j]! + (i === j ? jitter : 0);
        for (let k = 0; k < j; k += 1) sum -= L[i]![k]! * L[j]![k]!;
        if (i === j) {
          if (sum <= 0) { ok = false; break; }
          L[i]![j] = Math.sqrt(sum);
        } else {
          L[i]![j] = sum / L[j]![j]!;
        }
      }
    }
    if (ok) return { L, jitter };
  }
  return undefined;
}

/** 解 L·Lᵀ·x = b（前代 + 回代） */
export function solveCholesky(L: number[][], b: number[]): number[] {
  const n = L.length;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let sum = b[i]!;
    for (let k = 0; k < i; k += 1) sum -= L[i]![k]! * y[k]!;
    y[i] = sum / L[i]![i]!;
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = y[i]!;
    for (let k = i + 1; k < n; k += 1) sum -= L[k]![i]! * x[k]!;
    x[i] = sum / L[i]![i]!;
  }
  return x;
}

/** 标准正态 CDF（Abramowitz-Stegun 7.1.26 有理逼近，|误差| < 7.5e-8） */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - (Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)) * poly;
  return z >= 0 ? p : 1 - p;
}

/** 标准正态 PDF */
export function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/** Matérn-5/2 核（k = σf²(1+√5r+5r²/3)exp(−√5r), r = |x−x'|/ℓ） */
function matern52(d: number, lengthScale: number, sigmaF: number): number {
  const r = Math.abs(d) / lengthScale;
  const s = Math.sqrt(5) * r;
  return sigmaF * sigmaF * (1 + s + (s * s) / 3) * Math.exp(-s);
}

export interface GpPredict {
  /** 后验均值（原始尺度） */
  mean: number;
  /** 后验标准差（原始尺度，含观测噪声项） */
  std: number;
}

export interface GpFitReport {
  points: number;
  lengthScale: number;
  sigmaF: number;
  logMarginalLikelihood: number;
  tuned: boolean;
  /** R5-A3：诱导点数（稀疏拟合时有值；undefined = 全 GP） */
  inducing?: number;
  /** R5-A3：最终分解实际加入的对角抖动（0 = 精确分解） */
  jitterApplied?: number;
  /** R5-A3：条件数保守估计 λ̂max/λ̂min（λ̂max ≥ max diag，λ̂min ≤ min L_ii²） */
  conditionEstimate?: number;
  /** R5-A3：病态预警（抖动非零或条件数估计 > 1e12） */
  illConditioned?: boolean;
}

/**
 * 一维高斯过程回归器。
 *
 * fit() 内部完成 y 标准化 + x 归一；tuneHyperparams 时在
 * ℓ ∈ logspace(−2, 0.7, 8) × σf ∈ {0.5, 1, 2} 网格上取 LML 最大者。
 * predict() 返回原始尺度的均值/标准差（不确定度随距离数据远近伸缩）。
 */
export class GaussianProcess {
  private config: GaussianProcessConfig;
  private xs: number[] = [];
  private ys: number[] = [];
  private yMean = 0;
  private yStd = 1;
  private xMin = 0;
  private xMax = 1;
  private L: number[][] | undefined;
  private alpha: number[] = [];
  private fitReport: GpFitReport | undefined;
  /** R5-A3：归一化训练输入缓存（fit 时一次算好，predict 免去 O(n) 重算） */
  private nxTrain: number[] = [];
  /** R5-A3：FITC 稀疏因子（fitSparse 时填充；predict 自动走稀疏路径） */
  private sparseState:
    | {
        inducingNx: number[];
        ell: number;
        sf: number;
        /** mean_std(x*) = k_u*(x*)·β */
        beta: number[];
        /** K_uu 的 Cholesky（r = K_uu⁻¹k_u* 求解用） */
        Luu: number[][];
        /** G = C − C·B⁻¹·C（方差二次型：var = sf² − rᵀGr） */
        G: number[][];
      }
    | undefined;

  constructor(config?: Partial<GaussianProcessConfig>) {
    this.config = { ...DEFAULT_GP_CONFIG, ...config };
  }

  /** 拟合（重复调用为全量重拟合；数据先按 maxPoints 截尾） */
  fit(xs: number[], ys: number[]): GpFitReport | undefined {
    const n = Math.min(xs.length, ys.length);
    if (n < 2) return undefined;
    let sx = xs.slice(-n);
    let sy = ys.slice(-n);
    if (n > this.config.maxPoints) {
      sx = sx.slice(sx.length - this.config.maxPoints);
      sy = sy.slice(sy.length - this.config.maxPoints);
    }
    this.xs = sx;
    this.ys = sy;
    const m = this.xs.length;
    this.yMean = this.ys.reduce((s, v) => s + v, 0) / m;
    this.yStd = Math.max(1e-9, Math.sqrt(this.ys.reduce((s, v) => s + (v - this.yMean) ** 2, 0) / Math.max(1, m - 1)));
    this.xMin = Math.min(...this.xs);
    this.xMax = Math.max(...this.xs);
    if (!(this.xMax - this.xMin > 1e-12)) this.xMax = this.xMin + 1;

    const zy = this.ys.map((v) => (v - this.yMean) / this.yStd);
    const nx = this.xs.map((x) => this.normalize(x));
    // R5-A3：缓存归一化训练输入；fit 是全 GP 拟合，清掉稀疏态
    this.nxTrain = nx;
    this.sparseState = undefined;

    const lmlOf = (ell: number, sf: number): number => {
      const K = this.kernelMatrix(nx, ell, sf);
      const { L } = choleskyLower(K.map((row, i) => row.map((v, j) => v + (i === j ? this.config.sigmaN ** 2 : 0)))) ?? {};
      if (!L) return Number.NEGATIVE_INFINITY;
      const alpha = solveCholesky(L, zy);
      let quad = 0;
      for (let i = 0; i < m; i += 1) quad += zy[i]! * alpha[i]!;
      let logDet = 0;
      for (let i = 0; i < m; i += 1) logDet += Math.log(Math.max(1e-300, L[i]![i]!));
      return -0.5 * quad - logDet - (m / 2) * Math.log(2 * Math.PI);
    };

    let bestEll = this.config.lengthScale;
    let bestSf = this.config.sigmaF;
    let bestLml = lmlOf(bestEll, bestSf);
    let tuned = false;
    if (this.config.tuneHyperparams) {
      tuned = true;
      for (let e = 0; e < 8; e += 1) {
        const ell = 10 ** (-2 + (0.7 * e) / 7);
        for (const sf of [0.5, 1, 2]) {
          const lml = lmlOf(ell, sf);
          if (lml > bestLml) {
            bestLml = lml;
            bestEll = ell;
            bestSf = sf;
          }
        }
      }
    }

    const K = this.kernelMatrix(nx, bestEll, bestSf).map((row, i) => row.map((v, j) => v + (i === j ? this.config.sigmaN ** 2 : 0)));
    const decomp = choleskyLower(K);
    if (!decomp) {
      // 分解失败须保持失败原子性：xs/nxTrain 已更新为最新数据，若残留旧拟合的
      // L/α/fitReport，predict 会把新训练输入与旧分解做维度错配的混合运算
      this.L = undefined;
      this.alpha = [];
      this.fitReport = undefined;
      return undefined;
    }
    this.L = decomp.L;
    this.alpha = solveCholesky(this.L, zy);
    // R5-A3：条件数保守估计（λ̂max ≥ max diag(K_y)，λ̂min ≤ min L_ii²）
    let maxDiag = 0;
    let minLii2 = Infinity;
    for (let i = 0; i < m; i += 1) {
      maxDiag = Math.max(maxDiag, K[i][i]);
      minLii2 = Math.min(minLii2, this.L[i][i] ** 2);
    }
    const conditionEstimate = maxDiag / Math.max(1e-300, minLii2);
    this.fitReport = {
      points: m,
      lengthScale: bestEll,
      sigmaF: bestSf,
      logMarginalLikelihood: bestLml,
      tuned,
      jitterApplied: decomp.jitter,
      conditionEstimate,
      illConditioned: decomp.jitter > 0 || conditionEstimate > 1e12,
    };
    return this.fitReport;
  }

  /**
   * FITC 稀疏拟合（R5-A3 数学进化）：诱导点近似把后验求解压到 m×m。
   * 诱导点取归一化训练输入的分位数网格（numInducing 缺省 ⌈√n⌉；
   * numInducing ≥ 训练点数时退化为「诱导点 = 全部训练点」⟹ FITC ≡ 精确 GP）。
   * 拟合后 predict()/predictBatch() 自动走 O(m²) 稀疏路径。
   */
  fitSparse(xs: number[], ys: number[], opts?: { numInducing?: number }): GpFitReport | undefined {
    const n = Math.min(xs.length, ys.length);
    if (n < 2) return undefined;
    let sx = xs.slice(-n);
    let sy = ys.slice(-n);
    if (n > this.config.maxPoints) {
      sx = sx.slice(sx.length - this.config.maxPoints);
      sy = sy.slice(sy.length - this.config.maxPoints);
    }
    this.xs = sx;
    this.ys = sy;
    const m = this.xs.length;
    this.yMean = this.ys.reduce((s, v) => s + v, 0) / m;
    this.yStd = Math.max(1e-9, Math.sqrt(this.ys.reduce((s, v) => s + (v - this.yMean) ** 2, 0) / Math.max(1, m - 1)));
    this.xMin = Math.min(...this.xs);
    this.xMax = Math.max(...this.xs);
    if (!(this.xMax - this.xMin > 1e-12)) this.xMax = this.xMin + 1;
    const zy = this.ys.map((v) => (v - this.yMean) / this.yStd);
    const nx = this.xs.map((x) => this.normalize(x));
    this.nxTrain = nx;
    const numInd = Math.min(m, Math.max(2, Math.round(opts?.numInducing ?? Math.ceil(Math.sqrt(m)))));

    // 诱导点：归一化训练输入的等分位网格（覆盖全域，无重复）
    const sortedNx = [...nx].sort((a, b) => a - b);
    const u: number[] = [];
    if (numInd === 1) {
      u.push(sortedNx[0]);
    } else {
      for (let j = 0; j < numInd; j += 1) u.push(sortedNx[Math.round((j * (m - 1)) / (numInd - 1))]);
    }

    /** FITC 因子与 LML（给定超参） */
    const buildSparse = (ell: number, sf: number) => {
      const Kuu = u.map((a) => u.map((b) => this.kernelValue(a, b, ell, sf)));
      const duu = choleskyLower(Kuu);
      if (!duu) return undefined;
      const Kux: number[][] = u.map((a) => nx.map((x) => this.kernelValue(a, x, ell, sf)));
      // W = K_uu⁻¹K_ux（逐列解）；Q_ii = K_ux[:,i]ᵀW[:,i]；λ = σn² + K_ii − Q_ii
      const W: number[][] = Array.from({ length: numInd }, () => new Array<number>(m).fill(0));
      const lam = new Array<number>(m).fill(0);
      for (let i = 0; i < m; i += 1) {
        const col = Kux.map((row) => row[i]);
        const w = solveCholesky(duu.L, col);
        let q = 0;
        for (let a = 0; a < numInd; a += 1) {
          W[a][i] = w[a];
          q += col[a] * w[a];
        }
        lam[i] = Math.max(1e-12, this.config.sigmaN ** 2 + sf * sf - q);
      }
      // S = K_uxΛ⁻¹；C = S·K_ux；B = K_uu + C
      const C: number[][] = Array.from({ length: numInd }, () => new Array<number>(numInd).fill(0));
      for (let a = 0; a < numInd; a += 1) {
        for (let b = a; b < numInd; b += 1) {
          let s = 0;
          for (let i = 0; i < m; i += 1) s += (Kux[a][i] * Kux[b][i]) / lam[i];
          C[a][b] = s;
          C[b][a] = s;
        }
      }
      const B = Kuu.map((row, a) => row.map((v, b) => v + C[a][b]));
      const dB = choleskyLower(B);
      if (!dB) return undefined;
      // v = (Q+Λ)⁻¹zy = Λ⁻¹(zy − K_uxᵀ·B⁻¹·S·zy)
      const p = new Array<number>(numInd).fill(0);
      for (let a = 0; a < numInd; a += 1) {
        let s = 0;
        for (let i = 0; i < m; i += 1) s += (Kux[a][i] * zy[i]) / lam[i];
        p[a] = s;
      }
      const w = solveCholesky(dB.L, p);
      const v = new Array<number>(m).fill(0);
      for (let i = 0; i < m; i += 1) {
        let t = 0;
        for (let a = 0; a < numInd; a += 1) t += Kux[a][i] * w[a];
        v[i] = (zy[i] - t) / lam[i];
      }
      // β = K_uu⁻¹(K_ux·v)：mean_std(x*) = k_u*(x*)·β
      const Kv = new Array<number>(numInd).fill(0);
      for (let a = 0; a < numInd; a += 1) {
        let s = 0;
        for (let i = 0; i < m; i += 1) s += Kux[a][i] * v[i];
        Kv[a] = s;
      }
      const beta = solveCholesky(duu.L, Kv);
      // G = C − C·B⁻¹·C（方差二次型）
      const Z: number[][] = Array.from({ length: numInd }, () => new Array<number>(numInd).fill(0));
      for (let b = 0; b < numInd; b += 1) {
        const colB = Array.from({ length: numInd }, (_, a) => C[a][b]);
        const z = solveCholesky(dB.L, colB);
        for (let a = 0; a < numInd; a += 1) Z[a][b] = z[a];
      }
      const G: number[][] = Array.from({ length: numInd }, () => new Array<number>(numInd).fill(0));
      for (let a = 0; a < numInd; a += 1) {
        for (let b = a; b < numInd; b += 1) {
          let s = 0;
          for (let c = 0; c < numInd; c += 1) s += C[a][c] * Z[c][b];
          const g = C[a][b] - s;
          G[a][b] = g;
          G[b][a] = g;
        }
      }
      // LML_FITC = −½zyᵀv − ½(Σlnλ + ln|B| − ln|K_uu|) − (m/2)ln2π
      let quad = 0;
      for (let i = 0; i < m; i += 1) quad += zy[i] * v[i];
      let logDet = 0;
      for (let i = 0; i < m; i += 1) logDet += Math.log(lam[i]);
      for (let a = 0; a < numInd; a += 1) logDet += 2 * Math.log(Math.max(1e-300, dB.L[a][a]));
      for (let a = 0; a < numInd; a += 1) logDet -= 2 * Math.log(Math.max(1e-300, duu.L[a][a]));
      return {
        lml: -0.5 * quad - 0.5 * logDet - (m / 2) * Math.log(2 * Math.PI),
        Luu: duu.L,
        beta,
        G,
        jitter: dB.jitter,
      };
    };

    // 超参网格搜索（与 fit 同网格，LML 口径换 FITC）
    let bestEll = this.config.lengthScale;
    let bestSf = this.config.sigmaF;
    let built = buildSparse(bestEll, bestSf);
    let bestLml = built ? built.lml : Number.NEGATIVE_INFINITY;
    let tuned = false;
    if (this.config.tuneHyperparams) {
      tuned = true;
      for (let e = 0; e < 8; e += 1) {
        const ell = 10 ** (-2 + (0.7 * e) / 7);
        for (const sf of [0.5, 1, 2]) {
          const trial = buildSparse(ell, sf);
          if (trial && trial.lml > bestLml) {
            bestLml = trial.lml;
            bestEll = ell;
            bestSf = sf;
            built = trial;
          }
        }
      }
    }
    if (!built) return undefined;
    this.L = undefined;
    this.alpha = [];
    this.sparseState = { inducingNx: u, ell: bestEll, sf: bestSf, beta: built.beta, Luu: built.Luu, G: built.G };
    this.fitReport = {
      points: m,
      lengthScale: bestEll,
      sigmaF: bestSf,
      logMarginalLikelihood: bestLml,
      tuned,
      inducing: numInd,
      jitterApplied: built.jitter,
    };
    return this.fitReport;
  }

  /** 后验预测（原始尺度；未拟合时 undefined；稀疏拟合走 O(m²) FITC 路径） */
  predict(x: number): GpPredict | undefined {
    if (this.sparseState) return this.predictSparse(x);
    if (!this.L || this.xs.length === 0) return undefined;
    const nx = this.normalize(x);
    const kStar = this.nxTrain.map((nxi) => this.kernelValue(nx, nxi, this.fitReport!.lengthScale, this.fitReport!.sigmaF));
    let meanStd = 0;
    for (let i = 0; i < kStar.length; i += 1) meanStd += kStar[i]! * this.alpha[i]!;
    const w = solveCholesky(this.L!, kStar);
    // var = k(x,x) − k*ᵀK⁻¹k*（点积口径；wᵀw 会错算成 k*ᵀK⁻²k*）
    let quad = 0;
    for (let i = 0; i < w.length; i += 1) quad += kStar[i]! * w[i]!;
    const prior = this.fitReport!.sigmaF ** 2;
    const varStd = Math.max(0, prior - quad);
    return {
      mean: meanStd * this.yStd + this.yMean,
      std: Math.sqrt(varStd + this.config.sigmaN ** 2) * this.yStd,
    };
  }

  /**
   * 批量后验预测（R5-A3 性能进化）：Cholesky 预分解的批量复用口径——
   * 超参/归一化训练输入/α/L 循环外提升为局部量，核函数分支按 batch
   * 选定一次（RBF 公式内联），逐点求解共享同一份预分解。单点结果与
   * 逐次 predict(x) 逐位一致（算术次序与表达式完全相同）。
   */
  predictBatch(xs: number[]): (GpPredict | undefined)[] {
    if (this.sparseState) return xs.map((x) => this.predictSparse(x));
    if (!this.L || this.xs.length === 0) return xs.map(() => undefined);
    const report = this.fitReport!;
    const ell = report.lengthScale;
    const sf = report.sigmaF;
    const nTrain = this.nxTrain.length;
    const alpha = this.alpha;
    const L = this.L;
    const yMean = this.yMean;
    const yStd = this.yStd;
    const n2 = this.config.sigmaN ** 2;
    const useMatern = this.config.kernel === 'matern52';
    const twoEll2 = 2 * ell * ell;
    const sf2 = sf * sf;
    return xs.map((x) => {
      // 与 normalize 相同的除法口径（保持与 predict 逐位一致）
      const nx = (x - this.xMin) / (this.xMax - this.xMin);
      const kStar = new Array<number>(nTrain);
      if (useMatern) {
        for (let i = 0; i < nTrain; i += 1) kStar[i] = matern52(nx - this.nxTrain[i], ell, sf);
      } else {
        for (let i = 0; i < nTrain; i += 1) {
          const d = nx - this.nxTrain[i];
          kStar[i] = sf2 * Math.exp(-(d * d) / twoEll2);
        }
      }
      let meanStd = 0;
      for (let i = 0; i < nTrain; i += 1) meanStd += kStar[i] * alpha[i];
      const w = solveCholesky(L, kStar);
      let quad = 0;
      for (let i = 0; i < nTrain; i += 1) quad += kStar[i] * w[i];
      const varStd = Math.max(0, sf * sf - quad);
      return {
        mean: meanStd * yStd + yMean,
        std: Math.sqrt(varStd + n2) * yStd,
      };
    });
  }

  /** 是否处于 FITC 稀疏拟合态 */
  get isSparse(): boolean {
    return this.sparseState !== undefined;
  }

  /** FITC 稀疏路径：mean = k_u*·β；var = sf² − rᵀGr（r = K_uu⁻¹k_u*） */
  private predictSparse(x: number): GpPredict | undefined {
    if (this.xs.length === 0) return undefined;
    const sp = this.sparseState!;
    const nx = this.normalize(x);
    const ku = sp.inducingNx.map((uj) => this.kernelValue(nx, uj, sp.ell, sp.sf));
    let meanStd = 0;
    for (let a = 0; a < ku.length; a += 1) meanStd += ku[a]! * sp.beta[a]!;
    const r = solveCholesky(sp.Luu, ku);
    let quad = 0;
    for (let a = 0; a < r.length; a += 1) {
      let s = 0;
      for (let b = 0; b < r.length; b += 1) s += sp.G[a][b] * r[b]!;
      quad += r[a]! * s;
    }
    const varStd = Math.max(0, sp.sf * sp.sf - quad);
    return {
      mean: meanStd * this.yStd + this.yMean,
      std: Math.sqrt(varStd + this.config.sigmaN ** 2) * this.yStd,
    };
  }

  /** 最近一次拟合报告 */
  get fitSummary(): GpFitReport | undefined {
    return this.fitReport;
  }

  /** 训练点数 */
  get size(): number {
    return this.xs.length;
  }

  private normalize(x: number): number {
    return (x - this.xMin) / (this.xMax - this.xMin);
  }

  private kernelValue(a: number, b: number, ell: number, sf: number): number {
    if (this.config.kernel === 'matern52') return matern52(a - b, ell, sf);
    return sf * sf * Math.exp(-((a - b) ** 2) / (2 * ell * ell));
  }

  /**
   * 核矩阵（R5-A3 三角化）：只算下三角再镜像——核函数关于 (a,b) 位级
   * 对称（rbf 的 (a−b)² 与 (b−a)² 在 IEEE 下精确相等、matern52 用 |a−b|），
   * 结果与全矩阵计算逐位一致，核求值次数减半。
   */
  private kernelMatrix(xs: number[], ell: number, sf: number): number[][] {
    const n = xs.length;
    const K: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let i = 0; i < n; i += 1) {
      K[i][i] = this.kernelValue(xs[i], xs[i], ell, sf);
      for (let j = 0; j < i; j += 1) {
        const v = this.kernelValue(xs[i], xs[j], ell, sf);
        K[i][j] = v;
        K[j][i] = v;
      }
    }
    return K;
  }
}

/**
 * 期望改进（解析式）。
 * @param mu 候选点后验均值（越大越好口径）
 * @param sigma 候选点后验标准差
 * @param best 已观测最优值
 * @param xi 改进裕量（缺省 0.01，防过早在噪声上收敛）
 */
export function expectedImprovement(mu: number, sigma: number, best: number, xi = 0.01): number {
  if (!(sigma > 1e-12)) return Math.max(0, mu - best - xi);
  const z = (mu - best - xi) / sigma;
  return (mu - best - xi) * normalCdf(z) + sigma * normalPdf(z);
}

export interface BoSuggestion {
  x: number;
  expectedImprovement: number;
  posteriorMean: number;
  posteriorStd: number;
}

export interface BoState {
  observations: number;
  bestX?: number;
  bestY?: number;
}

/**
 * 离散候选集上的贝叶斯优化器（EI 采集）。
 *
 * observe(x,y) 登记真实观测；suggest(candidates) 拟合 GP 并返回 EI 最大
 * 的候选。适合「心跳间期在有限候选点里挑下一个试验参数」的在线调参场景。
 */
export class BayesianOptimizer {
  private gp: GaussianProcess;
  private xs: number[] = [];
  private ys: number[] = [];
  private dirty = true;

  constructor(config?: Partial<GaussianProcessConfig>) {
    this.gp = new GaussianProcess(config);
  }

  observe(x: number, y: number): void {
    this.xs.push(x);
    this.ys.push(y);
    this.dirty = true;
  }

  /** EI 最优候选（观测 < 2 或全部失败时 undefined） */
  suggest(candidates: number[]): BoSuggestion | undefined {
    if (this.xs.length < 2 || candidates.length === 0) return undefined;
    if (this.dirty) {
      this.gp.fit(this.xs, this.ys);
      this.dirty = false;
    }
    const best = Math.max(...this.ys);
    let bestSuggestion: BoSuggestion | undefined;
    for (const x of candidates) {
      const p = this.gp.predict(x);
      if (!p) continue;
      const ei = expectedImprovement(p.mean, p.std, best);
      if (!bestSuggestion || ei > bestSuggestion.expectedImprovement) {
        bestSuggestion = { x, expectedImprovement: ei, posteriorMean: p.mean, posteriorStd: p.std };
      }
    }
    return bestSuggestion;
  }

  get state(): BoState {
    const bestIdx = this.ys.length > 0 ? this.ys.indexOf(Math.max(...this.ys)) : -1;
    return {
      observations: this.xs.length,
      bestX: bestIdx >= 0 ? this.xs[bestIdx] : undefined,
      bestY: bestIdx >= 0 ? this.ys[bestIdx] : undefined,
    };
  }
}

export interface GpCorrection {
  /** 乘性修正因子（已钳制） */
  factor: number;
  /** 因子的后验标准差（原始尺度） */
  std: number;
  /** 参与拟合的校准点数 */
  points: number;
}

/** GpSeriesCalibrator 构造参数（26.0 接线口径） */
export interface ConstructorOptionsGpSeries {
  maxPoints?: number;
  sigmaN?: number;
  minPoints?: number;
  factorClamp?: number;
  kernel?: GpKernelKind;
}

/**
 * 26.0 接线辅助：序列校准器——「预测/实际」比值的时间序列 GP。
 *
 * 世界模型每次校准对账 push(timestamp, ratio)；predictAt(now) 返回当前
 * 时刻的比值修正（均值 + 不确定度）。数据不足 minPoints 时 undefined
 * （先验无知 = 不修正，早期零漂移）。内部按归一时间轴拟合，GP 均值函数
 * 取经验均值——比值无趋势时修正 ≈ 平均比值，有趋势时跟踪漂移。
 */
export class GpSeriesCalibrator {
  private config: { maxPoints: number; sigmaN: number; minPoints: number; factorClamp: number };
  private ts: number[] = [];
  private vs: number[] = [];
  private gp: GaussianProcess;
  private fittedAt = -1;

  constructor(config?: ConstructorOptionsGpSeries) {
    this.config = {
      maxPoints: config?.maxPoints ?? 64,
      sigmaN: config?.sigmaN ?? 0.15,
      minPoints: config?.minPoints ?? 6,
      factorClamp: config?.factorClamp ?? 4,
    };
    this.gp = new GaussianProcess({ maxPoints: this.config.maxPoints, sigmaN: this.config.sigmaN, tuneHyperparams: true, kernel: config?.kernel ?? 'rbf' });
  }

  /** 登记一次比值观测（actual/predicted） */
  push(timestamp: number, ratio: number): void {
    if (!Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(timestamp)) return;
    this.ts.push(timestamp);
    this.vs.push(ratio);
    if (this.ts.length > this.config.maxPoints) {
      this.ts.splice(0, this.ts.length - this.config.maxPoints);
      this.vs.splice(0, this.vs.length - this.config.maxPoints);
      // 环形裁剪后长度不变但内容已换血：以长度为键的重拟合缓存会被误命中，
      // 满容量后 GP 永久冻结在首次到达容量时的拟合——裁剪即失效，强制重拟合
      this.fittedAt = -1;
    }
  }

  /** 当前时刻的比值修正（点数不足或拟合失败时 undefined） */
  predictAt(now: number): GpCorrection | undefined {
    if (this.ts.length < this.config.minPoints) return undefined;
    if (this.fittedAt !== this.ts.length) {
      this.gp.fit(this.ts, this.vs);
      this.fittedAt = this.ts.length;
    }
    const p = this.gp.predict(now);
    if (!p) return undefined;
    const clamp = this.config.factorClamp;
    return {
      factor: Math.min(clamp, Math.max(1 / clamp, p.mean)),
      std: p.std,
      points: this.ts.length,
    };
  }

  get size(): number {
    return this.ts.length;
  }
}
