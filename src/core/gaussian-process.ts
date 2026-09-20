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
    if (!decomp) return undefined;
    this.L = decomp.L;
    this.alpha = solveCholesky(this.L, zy);
    this.fitReport = {
      points: m,
      lengthScale: bestEll,
      sigmaF: bestSf,
      logMarginalLikelihood: bestLml,
      tuned,
    };
    return this.fitReport;
  }

  /** 后验预测（原始尺度；未拟合时 undefined） */
  predict(x: number): GpPredict | undefined {
    if (!this.L || this.xs.length === 0) return undefined;
    const nx = this.normalize(x);
    const kStar = this.xs.map((xi) => this.kernelValue(nx, this.normalize(xi), this.fitReport!.lengthScale, this.fitReport!.sigmaF));
    let meanStd = 0;
    for (let i = 0; i < kStar.length; i += 1) meanStd += kStar[i]! * this.alpha[i]!;
    const w = solveCholesky(this.L!, kStar);
    // var = k(x,x) − k*ᵀK⁻¹k*（点积口径；wᵀw 会错算成 k*ᵀK⁻²k*）
    let quad = 0;
    for (let i = 0; i < w.length; i += 1) quad += kStar[i]! * w[i]!;
    const prior = this.kernelValue(0, 0, this.fitReport!.lengthScale, this.fitReport!.sigmaF);
    const varStd = Math.max(0, prior - quad);
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

  private kernelMatrix(xs: number[], ell: number, sf: number): number[][] {
    return xs.map((a) => xs.map((b) => this.kernelValue(a, b, ell, sf)));
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
