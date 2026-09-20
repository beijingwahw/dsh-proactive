/**
 * 23.0 重尾稳健统计内核 —— Catoni 估计 + Median-of-Means
 *
 * 动机: LLM 延迟与评审质量分呈重尾(偶发 100× 尾部), 算术均值与 EMA 被极端值支配,
 * 而 12.0 的经验伯恩斯坦界依赖有界支撑 [0,1]。本内核在**仅有限方差**假设下给出
 * sub-Gaussian 型置信界:
 *
 *   Median-of-Means(n ≥ k 块):  P( |μ̂ − μ| ≥ σ·√(32·ln(1/α)/n) ) ≤ α   —— 无需有界性
 *     (每块均值 sub-Gaussian 化由 Chebyshev + 中位数聚合 Chernoff 完成, k = ⌈8 ln(1/α)⌉)
 *
 *   Catoni 估计: 解单调方程  Σ_i ψ_δ(x_i − θ) = 0,  ψ_δ(y) = sign(y)·ln(1 + δ|y| + δ²y²/2)
 *     偏差界  |μ̂ − μ| ≤ 2σ²δ/n + 2ln(2/α)/(δn),  最优 δ = √(2ln(2/α)/(nσ²))
 *     → 半径 ≈ σ·√(8·ln(2/α)/n), 尾部指数衰减 —— 影响函数线性段截断使单点污染无法搬动估计
 *
 *   尺度 σ̂ 用 MAD(中位绝对偏差)×1.4826(正态一致性常数)—— 尺度本身稳健, 极端值无法
 *   先污染尺度再污染区间。
 *
 * 零漂移: 未挂载时一切统计路径与升级前逐位一致。
 */

export interface RobustStatisticsConfig {
  /** 置信参数 α: 区间覆盖 ≥ 1 − α */
  alpha: number;
  /** 流式估计保留的最大样本数(环形) */
  maxSamples: number;
  /** 切换到 Catoni 的最小样本量(低于此用 MoM/普通均值) */
  catoniMinSamples: number;
  /** MoM 的最小样本量 */
  momMinSamples: number;
}

export const DEFAULT_ROBUST_CONFIG: RobustStatisticsConfig = {
  alpha: 0.05,
  maxSamples: 4096,
  catoniMinSamples: 24,
  momMinSamples: 8,
};

/** MAD 稳健尺度估计: σ̂ = 1.4826 × median|x_i − median(x)| */
export function madSigma(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const deviations = samples.map(x => Math.abs(x - median)).sort((a, b) => a - b);
  const mad = deviations.length % 2 === 1
    ? deviations[Math.floor(deviations.length / 2)]
    : (deviations[deviations.length / 2 - 1] + deviations[deviations.length / 2]) / 2;
  return Math.max(1e-9, 1.4826 * mad);
}

/**
 * Catoni 稳健均值: 对 θ 二分解单调方程 Σψ_δ(x_i−θ)=0。
 * 返回估计与半径 |μ̂−μ| ≤ σ̂·√(8·ln(2/α)/n) 的置信区间(钳到数据范围)。
 */
export function catoniMean(samples: number[], alpha = 0.05): {
  mean: number; lower: number; upper: number; sigma: number; radius: number;
} {
  const n = samples.length;
  if (n === 0) return { mean: 0, lower: 0, upper: 0, sigma: 0, radius: 0 };
  const sum = samples.reduce((s, x) => s + x, 0) / n;
  if (n < 2) return { mean: sum, lower: sum, upper: sum, sigma: 0, radius: 0 };
  const sigma = madSigma(samples);
  const delta = Math.min(1, Math.sqrt(2 * Math.log(2 / alpha) / (n * sigma * sigma)));
  // g(θ) = Σψ_δ(x_i−θ) 关于 θ 严格单调下降; 二分求零点
  let lo = Math.min(...samples);
  let hi = Math.max(...samples);
  const g = (theta: number): number => {
    let acc = 0;
    for (const x of samples) {
      const y = x - theta;
      const ay = Math.abs(y);
      acc += Math.sign(y) * Math.log(1 + delta * ay + (delta * ay * ay * delta) / 2);
    }
    return acc;
  };
  if (g(lo) < 0 || g(hi) > 0) {
    // 数值边界异常(全同值等): 退回普通均值
    return { mean: sum, lower: sum, upper: sum, sigma, radius: 0 };
  }
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (g(mid) > 0) lo = mid; else hi = mid;
  }
  const mean = (lo + hi) / 2;
  const radius = Math.min(hi - lo + sigma * Math.sqrt(8 * Math.log(2 / alpha) / n),
    Math.max(...samples) - Math.min(...samples));
  return { mean, lower: mean - radius, upper: mean + radius, sigma, radius };
}

/** Median-of-Means: k = ⌈8·ln(1/α)⌉ 块连续切分, 块均值取中位数 */
export function medianOfMeans(samples: number[], alpha = 0.05): {
  mean: number; blocks: number; lower: number; upper: number; sigma: number;
} {
  const n = samples.length;
  if (n === 0) return { mean: 0, blocks: 0, lower: 0, upper: 0, sigma: 0 };
  const k = Math.max(3, Math.min(n, Math.ceil(8 * Math.log(1 / Math.max(alpha, 1e-12)))));
  if (n < k) {
    const mean = samples.reduce((s, x) => s + x, 0) / n;
    return { mean, blocks: 1, lower: mean, upper: mean, sigma: madSigma(samples) };
  }
  const size = Math.floor(n / k);
  const blockMeans: number[] = [];
  for (let b = 0; b < k; b++) {
    const slice = samples.slice(b * size, (b + 1) * size);
    blockMeans.push(slice.reduce((s, x) => s + x, 0) / slice.length);
  }
  const sorted = [...blockMeans].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const sigma = madSigma(samples);
  const radius = sigma * Math.sqrt(32 * Math.log(1 / Math.max(alpha, 1e-12)) / n);
  return { mean: median, blocks: k, lower: median - radius, upper: median + radius, sigma };
}

export type RobustMethod = 'mean' | 'mom' | 'catoni';

export interface RobustRead {
  n: number;
  mean: number;
  robustMean: number;
  lower: number;
  upper: number;
  method: RobustMethod;
  sigma: number;
}

/** 流式稳健估计: 环形保留最近 maxSamples 个观测, read() 自动选择方法 */
export class RobustStream {
  private readonly config: Required<RobustStatisticsConfig>;
  private readonly buffer: number[] = [];

  constructor(config?: Partial<RobustStatisticsConfig>) {
    this.config = { ...DEFAULT_ROBUST_CONFIG, ...config } as Required<RobustStatisticsConfig>;
  }

  observe(x: number): void {
    if (!Number.isFinite(x)) return;
    this.buffer.push(x);
    if (this.buffer.length > this.config.maxSamples) {
      this.buffer.splice(0, this.buffer.length - this.config.maxSamples);
    }
  }

  get size(): number {
    return this.buffer.length;
  }

  read(): RobustRead {
    const n = this.buffer.length;
    const plainMean = n === 0 ? 0 : this.buffer.reduce((s, x) => s + x, 0) / n;
    if (n < this.config.momMinSamples) {
      return { n, mean: plainMean, robustMean: plainMean, lower: plainMean, upper: plainMean, method: 'mean', sigma: n ? madSigma(this.buffer) : 0 };
    }
    if (n < this.config.catoniMinSamples) {
      const r = medianOfMeans(this.buffer, this.config.alpha);
      return { n, mean: plainMean, robustMean: r.mean, lower: r.lower, upper: r.upper, method: 'mom', sigma: r.sigma };
    }
    const c = catoniMean(this.buffer, this.config.alpha);
    return { n, mean: plainMean, robustMean: c.mean, lower: c.lower, upper: c.upper, method: 'catoni', sigma: c.sigma };
  }
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
