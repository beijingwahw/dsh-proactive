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
 * R5 第五轮进化（内核世界性进化·统计推断组）：
 * - 数学：hodgesLehmann —— Hodges–Lehmann 单样本位置估计
 *   （Walsh 平均 {(x_i+x_j)/2 : i ≤ j} 的中位数）：渐近正态、正态下
 *   ARE = 3/π ≈ 0.955（对算术均值）、崩溃点 1 − 1/√2 ≈ 29.29%
 *   （HL_BREAKDOWN_POINT 常数化）——介于均值(0%)与中位数(50%)之间的
 *   效率/稳健折中，且**不需要解方程**（Catoni 要二分解单调方程，
 *   HL 是纯次序统计量，可作 Catoni 的独立交叉验证锚）。
 * - 性能：中位数计算由「全量排序 O(n log n)」改为「确定性内省
 *   quickselect O(n)（期望）/ O(n log n)（最坏保险）」——selectKth
 *   取 median-of-3 主元 + 三路分区（重复值免疫）+ 超深回退排序。
 *   中位数是**精确次序统计量**：新旧实现逐位相同（同一数组元素/
 *   同一对元素的算术平均），madSigma / medianOfMeans 输出零漂移。
 * - 数值稳健：catoniMean 的 Math.min(...samples) 展开调用改为单遍
 *   循环 —— 展开在 maxSamples ≳ 1.2e5 时触发引擎参数上限
 *   RangeError（每个参数都是一次栈调用），单遍循环无此上限且免于
 *   展开时的临时数组分配；结果逐位不变。
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
  const median = medianValue(samples);
  const deviations = samples.map(x => Math.abs(x - median));
  const mad = medianValue(deviations);
  return Math.max(1e-9, 1.4826 * mad);
}

// ───────────────────── R5：确定性 quickselect 中位数（O(n)） ─────────────────────

/**
 * 升序第 k 个次序统计量（0-based，就地分区）。
 *
 * 确定性内省 quickselect：median-of-3 主元 + 三路分区（重复值免疫：
 * 全同值数组一遍收敛）+ 深度保险（超过 2⌈log₂n⌉+4 层回退局部排序，
 * 杜绝最坏 O(n²)）。返回值恒为**精确次序统计量**——与全量排序后
 * 取第 k 个逐位相同。
 */
export function selectKth(arr: number[], k: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  const depthLimit = 2 * Math.ceil(Math.log2(arr.length + 1)) + 4;
  let depth = 0;
  while (lo < hi) {
    if (depth > depthLimit) {
      // 超深保险：区间内排序后直接取（确定性，同一结果）
      const part = arr.slice(lo, hi + 1).sort((a, b) => a - b);
      for (let i = 0; i < part.length; i += 1) arr[lo + i] = part[i];
      break;
    }
    depth += 1;
    const pivot = medianOfThree(arr[lo]!, arr[(lo + hi) >> 1]!, arr[hi]!);
    // 三路分区（Dutch national flag）: [<pivot | =pivot | >pivot]
    let i = lo;
    let j = lo;
    let n = hi;
    while (j <= n) {
      const v = arr[j]!;
      if (v < pivot) {
        arr[j] = arr[i]!;
        arr[i] = v;
        i += 1;
        j += 1;
      } else if (v > pivot) {
        arr[j] = arr[n]!;
        arr[n] = v;
        n -= 1;
      } else {
        j += 1;
      }
    }
    if (k < i) hi = i - 1;
    else if (k > n) lo = n + 1;
    else break; // k 落在 =pivot 段内
  }
  return arr[k]!;
}

function medianOfThree(a: number, b: number, c: number): number {
  if (a < b) {
    if (b < c) return b;
    return a < c ? c : a;
  }
  if (a < c) return a;
  return b < c ? c : b;
}

/** 数组中位数（奇数取中心元素；偶数取中间两元素均值——与排序法逐位一致） */
function medianValue(arr: readonly number[]): number {
  const n = arr.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return selectKth([...arr], (n - 1) >> 1);
  const upper = selectKth([...arr], n >> 1);
  const lower = selectKth([...arr], (n >> 1) - 1);
  return (lower + upper) / 2;
}

// ───────────────────── R5：Hodges–Lehmann 估计（定理背书） ─────────────────────

/** Hodges–Lehmann 单样本估计崩溃点：1 − 1/√2 ≈ 0.2929（29.29% 污染不垮） */
export const HL_BREAKDOWN_POINT = 1 - 1 / Math.SQRT2;

/** Hodges–Lehmann 估计读取视图 */
export interface HodgesLehmannResult {
  /** 位置估计（Walsh 平均数的中位数） */
  estimate: number;
  /** Walsh 平均对数 n(n+1)/2（审计计算量） */
  pairs: number;
}

/**
 * Hodges–Lehmann 单样本位置估计：median{(x_i + x_j)/2 : 1 ≤ i ≤ j ≤ n}。
 *
 * 定理背书（Hodges & Lehmann 1963）：渐近正态，正态总体下相对算术均值
 * 的渐近相对效率 ARE = 3/π ≈ 0.955（几乎无损效率）；崩溃点
 * 1 − 1/√2 ≈ 29.29%（i ≤ j 版本）——远高于均值的 0%。平移等变
 * （HL(x + c) = HL(x) + c）且置换不变。纯次序统计量实现，
 * O(n²) 对 O(n² log n)：Walsh 数组生成后 quickselect 取中位数。
 */
export function hodgesLehmann(samples: readonly number[]): HodgesLehmannResult {
  const n = samples.length;
  if (n === 0) return { estimate: 0, pairs: 0 };
  if (n === 1) return { estimate: samples[0]!, pairs: 1 };
  const walsh: number[] = new Array((n * (n + 1)) / 2);
  let w = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i; j < n; j += 1) {
      walsh[w] = (samples[i]! + samples[j]!) / 2;
      w += 1;
    }
  }
  return { estimate: medianValue(walsh), pairs: walsh.length };
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
  // 单遍 min/max（R5 数值稳健：Math.min(...spread) 在 maxSamples ≳ 1.2e5 时
  // 触发参数数量上限 RangeError；单遍循环无上限，且结果逐位相同）
  let minV = samples[0]!;
  let maxV = samples[0]!;
  for (let i = 1; i < n; i += 1) {
    const x = samples[i]!;
    if (x < minV) minV = x;
    if (x > maxV) maxV = x;
  }
  // g(θ) = Σψ_δ(x_i−θ) 关于 θ 严格单调下降; 二分求零点
  let lo = minV;
  let hi = maxV;
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
  const radius = Math.min(hi - lo + sigma * Math.sqrt(8 * Math.log(2 / alpha) / n), maxV - minV);
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
  // R5：块均值中位数走 quickselect（与全量排序逐位一致，O(k) 替代 O(k log k)）
  const median = medianValue(blockMeans);
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

  /** 缓冲副本（28.0 EVT 等下游内核的原料通道；不影响内部状态） */
  toSamples(): number[] {
    return [...this.buffer];
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
