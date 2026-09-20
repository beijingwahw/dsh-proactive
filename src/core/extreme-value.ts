/**
 * 28.0 极值理论内核 —— POT/GPD 尾部建模 + Hill 估计 + 风险度量
 *
 * 动机: 平均值撒谎，尾部杀人。p99.9 延迟、预算爆仓、失败风暴都住在分布
 * 的尾部——而经验分位数在尾部**没有数据可看**（1000 个样本里 p99.9 就是
 * 最大值，纯运气）。极值理论（EVT）不外推整个分布，只外推尾部，且尾部
 * 有定理保证：
 *
 *   Pickands–Balkema–de Haan: 超过阈值 u 的超出量 Y = X − u（足够大的 u）
 *     收敛于广义帕累托 GPD_ξ,σ:
 *     H(y) = 1 − (1 + ξy/σ)^{−1/ξ}  (ξ≠0),  1 − e^{−y/σ}  (ξ=0)
 *   ξ > 0 重尾（无限方差当 ξ > 1/2）, ξ = 0 指数尾, ξ < 0 有界尾
 *
 *   POT 分位数（尾部外推，经验分位数的定理化替代）:
 *     VaR_p = u + (σ̂/ξ̂)·[ (N_u/n · 1/(1−p))^{ξ̂} − 1 ]
 *   期望损失 ES_p = (VaR_p + σ̂ − ξ̂·u)/(1 − ξ̂)  (ξ̂ < 1)
 *
 *   Hill 估计（重尾指数的半参数估计）:
 *     α̂_k = k / Σ_{i≤k} ln(x_(i)/x_(k+1))  （降序前 k 个）
 *     jackknife 标准误——「尾部有多重」本身带不确定度
 *
 *   GPD MLE: Grimshaw (1993) 剖面似然——把 (ξ,σ) 二维优化化为 θ = ξ/σ
 *   的一维搜索（σ(θ) = k̄/θ, k̄ = mean ln(1+θy)），θ ∈ (−1/y_max, 2/y_max)
 *   网格 + 黄金分割细化；θ→0 边界退化为指数 MLE（σ̂ = ȳ）。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致。
 */

/** 确定性 PRNG（mulberry32；验证脚本与内核共用同一实现保证可复现） */
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

/** 经验分位数（最近邻插值；xs 无序） */
export function empiricalQuantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = Math.min(Math.max(q * (sorted.length - 1), 0), sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (pos - lo) * (sorted[hi]! - sorted[lo]!);
}

// ─────────────────────────── Hill 估计 ───────────────────────────

export interface HillEstimate {
  /** 尾指数 α̂（1/ξ̂ 口径；α 越小尾越重） */
  alpha: number;
  /** ξ̂ = 1/α̂ */
  xi: number;
  /** jackknife 标准误 */
  se: number;
  /** 使用的尾部序统计量个数 */
  k: number;
}

/**
 * Hill 尾指数估计（降序取前 k 个对 x_(k+1) 的对数比）。
 * 适用 ξ > 0（重尾）；数据不足或含非正值时 undefined。
 */
export function hillEstimator(samples: number[], k?: number): HillEstimate | undefined {
  const positive = samples.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => b - a);
  const kk = Math.min(k ?? Math.floor(positive.length * 0.1), positive.length - 1);
  if (kk < 2) return undefined;
  const xK1 = positive[kk]!;
  const logs: number[] = [];
  for (let i = 0; i < kk; i += 1) logs.push(Math.log(positive[i]! / xK1));
  const sum = logs.reduce((s, v) => s + v, 0);
  const alpha = kk / Math.max(1e-12, sum);
  // jackknife SE: 逐一剔除后的估计散布
  let sq = 0;
  for (let i = 0; i < kk; i += 1) {
    const rest = (sum - logs[i]!) / Math.max(1e-12, kk - 1);
    const aj = 1 / Math.max(1e-12, rest);
    sq += (aj - 1 / (sum / kk)) ** 2;
  }
  const se = Math.sqrt(Math.max(0, sq) * (kk - 1) / kk / kk);
  return { alpha, xi: 1 / alpha, se, k: kk };
}

// ─────────────────────────── GPD 剖面似然 MLE（Grimshaw） ───────────────────────────

export interface GpdFit {
  /** 形状参数 ξ̂ */
  xi: number;
  /** 尺度参数 σ̂ */
  sigma: number;
  /** 剖面对数似然 */
  logLikelihood: number;
  /** θ = ξ/σ 的收敛点 */
  theta: number;
  /** 拟合用超出量个数 */
  n: number;
}

function gpdProfileLoglik(theta: number, ys: number[]): number {
  const n = ys.length;
  let sumLog = 0;
  for (const y of ys) {
    const inner = 1 + theta * y;
    if (inner <= 1e-12) return Number.NEGATIVE_INFINITY;
    sumLog += Math.log(inner);
  }
  if (Math.abs(theta) < 1e-10) {
    // θ→0 边界：指数似然 MLE σ̂ = ȳ
    const ybar = sumLog === 0 ? ys.reduce((s, y) => s + y, 0) / n : ys.reduce((s, y) => s + y, 0) / n;
    return -n * Math.log(ybar) - n;
  }
  const kBar = sumLog / n; // = ξ̂(θ)
  const sigma = kBar / theta;
  if (sigma <= 0) return Number.NEGATIVE_INFINITY;
  return -n * Math.log(sigma) - (1 + 1 / kBar) * sumLog;
}

/**
 * GPD 极大似然（Grimshaw 剖面法）。ys 为严格正的超出量（x − u）。
 * 数据不足 / 退化时 undefined。
 */
export function fitGpd(ys: number[]): GpdFit | undefined {
  const n = ys.length;
  if (n < 8) return undefined;
  const yMax = Math.max(...ys);
  const yMean = ys.reduce((s, y) => s + y, 0) / n;
  if (!(yMax > 0) || !(yMean > 0)) return undefined;
  // θ 的可行开区间 (−1/y_max, ∞)：重尾下真值 θ* = ξ/σ ≈ 1/(ξ·u) 可远大于
  // 1/y_max（尺度 σ 与最大超出量无关），故上界按均值尺度展到 32/ȳ
  const lo = -1 / yMax + 1e-9;
  const hi = Math.max(2 / yMax, 32 / yMean);
  // 网格粗扫（近 0 段加密——指数边界）+ 黄金分割细化
  const grid = 96;
  let bestTheta = 0;
  let bestLl = gpdProfileLoglik(0, ys);
  for (let i = 0; i <= grid; i += 1) {
    const theta = lo + ((hi - lo) * i) / grid;
    const ll = gpdProfileLoglik(theta, ys);
    if (ll > bestLl) {
      bestLl = ll;
      bestTheta = theta;
    }
  }
  let a = Math.max(lo, bestTheta - (hi - lo) / grid);
  let b = Math.min(hi, bestTheta + (hi - lo) / grid);
  const gr = 0.6180339887498949;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let fc = gpdProfileLoglik(c, ys);
  let fd = gpdProfileLoglik(d, ys);
  for (let it = 0; it < 80; it += 1) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - gr * (b - a);
      fc = gpdProfileLoglik(c, ys);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + gr * (b - a);
      fd = gpdProfileLoglik(d, ys);
    }
  }
  const theta = (a + b) / 2;
  const ll = gpdProfileLoglik(theta, ys);
  if (ll >= bestLl) {
    bestTheta = theta;
    bestLl = ll;
  }
  if (Math.abs(bestTheta) < 1e-10) {
    const ybar = ys.reduce((s, y) => s + y, 0) / n;
    return { xi: 0, sigma: ybar, logLikelihood: bestLl, theta: 0, n };
  }
  let sumLog = 0;
  for (const y of ys) sumLog += Math.log(1 + bestTheta * y);
  const xi = sumLog / n;
  const sigma = xi / bestTheta;
  if (!(sigma > 0)) return undefined;
  return { xi, sigma, logLikelihood: bestLl, theta: bestTheta, n };
}

/** GPD 分布函数 */
export function gpdCdf(y: number, xi: number, sigma: number): number {
  if (y <= 0) return 0;
  if (Math.abs(xi) < 1e-10) return 1 - Math.exp(-y / sigma);
  const t = 1 + (xi * y) / sigma;
  if (t <= 0) return 1;
  return 1 - Math.pow(t, -1 / xi);
}

// ─────────────────────────── 尾部风险度量 ───────────────────────────

export interface TailQuantiles {
  /** POT 外推分位数（p ∈ (0,1)，如 0.999） */
  varP: number;
  /** 期望损失（尾部均值；ξ̂ ≥ 1 时 undefined——均值不存在） */
  esP?: number;
}

/**
 * POT 分位数与期望损失。
 * @param fit GPD 拟合（超出量口径）
 * @param totalSamples 原始样本总数 n
 * @param exceedances 超出量个数 N_u
 * @param u 阈值
 */
export function potQuantiles(fit: GpdFit, totalSamples: number, exceedances: number, u: number, p: number): TailQuantiles | undefined {
  // 尾概率守恒：P(X>x) = (N_u/n)·(1+ξ(x−u)/σ)^{−1/ξ} = 1−p
  //   → x = u + (σ/ξ)·[((N_u/n)/(1−p))^ξ − 1]
  const ratio = (exceedances / Math.max(1, totalSamples)) * (1 / Math.max(1e-12, 1 - p));
  if (Math.abs(fit.xi) < 1e-6) {
    const varP = u + fit.sigma * Math.log(ratio);
    return { varP, esP: varP + fit.sigma };
  }
  if (fit.xi >= 1) {
    return { varP: u + (fit.sigma / fit.xi) * (Math.pow(ratio, fit.xi) - 1) };
  }
  const varP = u + (fit.sigma / fit.xi) * (Math.pow(ratio, fit.xi) - 1);
  return { varP, esP: (varP + fit.sigma - fit.xi * u) / (1 - fit.xi) };
}

/** 均值超出诊断：E[X − u | X > u] 关于 u 的曲线（GPD 下应为线性，斜率 ξ/(1−ξ)） */
export function meanExcessCurve(samples: number[], quantiles: number[]): Array<{ u: number; meanExcess: number; count: number }> {
  const out: Array<{ u: number; meanExcess: number; count: number }> = [];
  for (const q of quantiles) {
    const u = empiricalQuantile(samples, q);
    const exceed = samples.filter((x) => x > u);
    if (exceed.length < 3) continue;
    out.push({
      u: Number(u.toFixed(3)),
      meanExcess: Number((exceed.reduce((s, x) => s + (x - u), 0) / exceed.length).toFixed(3)),
      count: exceed.length,
    });
  }
  return out;
}

// ─────────────────────────── 尾部风险监视器 ───────────────────────────

export interface TailRiskConfig {
  /** 超阈值经验分位（缺省 0.9：最重 10% 样本入 GPD） */
  thresholdQuantile: number;
  /** 拟合所需最小超出量（缺省 20） */
  minExceedances: number;
  /** 环形缓冲容量（缺省 2048） */
  maxSamples: number;
  /** bootstrap 置信区间重采样次数（0 = 不算 CI；缺省 200） */
  bootstrap: number;
  /** bootstrap 种子（缺省 20260920） */
  seed: number;
}

export const DEFAULT_TAIL_RISK_CONFIG: TailRiskConfig = {
  thresholdQuantile: 0.9,
  minExceedances: 20,
  maxSamples: 2048,
  bootstrap: 200,
  seed: 20260920,
};

export interface TailRiskReport {
  /** 样本量 */
  samples: number;
  /** 阈值 u（经验分位） */
  threshold: number;
  /** 超出量个数 */
  exceedances: number;
  /** GPD 拟合 */
  gpd: GpdFit;
  /** p99 外推 */
  p99: number;
  /** p99.9 外推（经验分位数看不到的地方） */
  p999: number;
  /** p99 期望损失 */
  es99?: number;
  /** Hill 尾指数（重尾口径） */
  hill?: HillEstimate;
  /** p99.9 的 bootstrap 90% 置信区间 */
  p999Ci?: { lower: number; upper: number };
}

/**
 * 尾部风险监视器：延迟/成本样本的环形流 → POT/GPD 拟合 → p99/p99.9/ES。
 *
 * 与经验分位数的本质区别：p99.9 不是「样本最大值」（运气）而是定理背书
 * 的尾部外推，且带 bootstrap 置信区间。样本不足或拟合失败时 fit()
 * 返回 undefined（诚实拒绝，不输出编造的尾部）。
 */
export class TailRiskMonitor {
  private config: TailRiskConfig;
  private buffer: number[] = [];

  constructor(config?: Partial<TailRiskConfig>) {
    this.config = { ...DEFAULT_TAIL_RISK_CONFIG, ...config };
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

  /** 拟合（幂等；失败/数据不足 → undefined） */
  fit(): TailRiskReport | undefined {
    const n = this.buffer.length;
    const u = empiricalQuantile(this.buffer, this.config.thresholdQuantile);
    const ys = this.buffer.filter((x) => x > u).map((x) => x - u);
    if (ys.length < this.config.minExceedances) return undefined;
    const gpd = fitGpd(ys);
    if (!gpd) return undefined;
    const q99 = potQuantiles(gpd, n, ys.length, u, 0.99);
    const q999 = potQuantiles(gpd, n, ys.length, u, 0.999);
    if (!q99 || !q999) return undefined;
    const report: TailRiskReport = {
      samples: n,
      threshold: Number(u.toFixed(3)),
      exceedances: ys.length,
      gpd,
      p99: q99.varP,
      p999: q999.varP,
      es99: q99.esP,
      hill: gpd.xi > 0.05 ? hillEstimator(this.buffer) : undefined,
    };
    if (this.config.bootstrap > 0) {
      const rng = mulberry32(this.config.seed);
      const estimates: number[] = [];
      for (let b = 0; b < this.config.bootstrap; b += 1) {
        const resample: number[] = [];
        for (let i = 0; i < ys.length; i += 1) resample.push(ys[Math.floor(rng() * ys.length)]!);
        const bf = fitGpd(resample);
        if (!bf) continue;
        const bq = potQuantiles(bf, n, ys.length, u, 0.999);
        if (bq) estimates.push(bq.varP);
      }
      if (estimates.length >= 50) {
        estimates.sort((a, b) => a - b);
        report.p999Ci = {
          lower: estimates[Math.floor(estimates.length * 0.05)]!,
          upper: estimates[Math.floor(estimates.length * 0.95)]!,
        };
      }
    }
    return report;
  }

  /** 原始样本副本（消费方自取；26.0 GP / 23.0 稳健统计可复用同一流） */
  toSamples(): number[] {
    return [...this.buffer];
  }
}
