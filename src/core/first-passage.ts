/**
 * 40.0 首达时间内核 —— 反射原理 + 逆高斯 + 赌徒破产：等待恢复有了概率价格
 *
 * 动机: 熔断器打开后的冷却时间是配置魔数（cooldownMs 定值）。但「多久
 * 才敢再试」是随机过程的首达问题——失败率的恢复是带漂移的随机游走，
 * 过早重试 = 高概率再次击穿（熔断风暴），过晚 = 无谓的可用性损失。
 *
 *   反射原理（Brownian 对称性）: P(sup_{s≤t} W_s ≥ a) = 2·P(W_t ≥ a)
 *     —— 最大值分布从端点分布一步读出；无漂移随机游走重越阈值 a 的
 *     概率 = 2(1 − Φ(a/(σ√t)))，闭式。
 *
 *   带漂移首达（逆高斯）: dX = μ ds + σ dW 从 0 出发首达 a > 0 的
 *     时间 T ~ IG(均值 a/μ, 形状 a²/σ²)——密度闭式、期望闭式；
 *     μ ≤ 0 时首达概率 < 1（可能永不到达——诚实区分「会恢复」与
 *     「结构性恶化」）。
 *
 *   离散口径（赌徒破产）: 每步 ±1 概率 p/q，从 i 出发触 N 先于 0 的
 *     概率（p≠q 闭式 (1−(q/p)^i)/(1−(q/p)^N)；p=1/2 时 i/N——公平
 *     游走的经典）。
 *
 *   冷却定价: 从观察到的失败间隔估计 (μ̂, σ̂)，解首达概率
 *     P(T_recover ≤ cooldown) ≥ target 的最小 cooldown——熔断冷却从
 *     魔数升维为「以 target 概率确信已恢复」的定价。
 *
 * 零漂移: 未挂载时熔断与治理行为与升级前逐位一致。
 */

/** 标准正态 CDF（erf 近似，Abramowitz–Stegun 7.1.26；模块私有——公共口径见 gaussian-process.ts 的 normalCdf） */
function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/**
 * 反射原理: 无漂移 Brownian（方差率 σ²）在 (0, t] 内上穿阈值 a > 0 的概率。
 *
 * P(sup W_s ≥ a) = 2(1 − Φ(a/(σ√t)))——与端点分布的解析恒等式
 * （验证脚本用离散模拟对照）。
 */
export function reflectionMaxProb(threshold: number, horizon: number, sigma = 1): number {
  if (!(threshold > 0) || !(horizon > 0)) return 0;
  return Math.min(1, Math.max(0, 2 * (1 - normalCdf(threshold / (sigma * Math.sqrt(horizon))))));
}

/** 逆高斯密度: dX = μ ds + σ dW 首达 a > 0 的时间分布（μ > 0） */
export function inverseGaussianPdf(t: number, mean: number, shape: number): number {
  if (t <= 0 || !(mean > 0) || !(shape > 0)) return 0;
  const lambda = shape;
  return Math.sqrt(lambda / (2 * Math.PI * t * t * t)) * Math.exp((-lambda * (t - mean) * (t - mean)) / (2 * mean * mean * t));
}

/** 逆高斯 CDF（闭式，Chhikara–Folks）：F(t) = Φ(√(λ/t)(t−μ)/μ) + e^{2λ/μ}Φ(−√(λ/t)(t+μ)/μ) */
export function inverseGaussianCdf(t: number, mean: number, shape: number): number {
  if (t <= 0 || !(mean > 0) || !(shape > 0)) return 0;
  const root = Math.sqrt(shape / t);
  const first = normalCdf((root * (t - mean)) / mean);
  const second = Math.exp((2 * shape) / mean) * normalCdf((-root * (t + mean)) / mean);
  return Math.min(1, Math.max(0, first + second));
}

/** 赌徒破产: 从 i 出发、触 N 先于 0 的概率（步进 ±1，上行概率 p） */
export function gamblerRuin(i: number, n: number, p: number): number {
  if (n <= 0 || i <= 0 || i >= n) return i >= n ? 1 : 0;
  if (Math.abs(p - 0.5) < 1e-12) return i / n;
  const q = 1 - p;
  const ratio = q / p;
  return (1 - Math.pow(ratio, i)) / (1 - Math.pow(ratio, n));
}

export interface FirstPassageEstimate {
  /** 漂移估计 μ̂（每单位时间步长；≤ 0 = 结构性恶化，恢复不保证） */
  mu: number;
  /** 波动估计 σ̂ */
  sigma: number;
  /** 首达概率 P(T ≤ horizon)（μ̂ > 0 时逆高斯 CDF；≤ 0 时 1 − 破产反转口径） */
  probByHorizon: number;
  /** 期望恢复时间 a/μ̂（μ̂ > 0；否则 undefined） */
  expectedTime: number | undefined;
  /** 推荐冷却（P(恢复 ≤ cooldown) ≥ target 的最小 horizon；μ̂ ≤ 0 时 undefined） */
  recommendedCooldown: number | undefined;
}

/**
 * 冷却定价（40.0 接线口径）。
 *
 * failureIntervals: 观察到的相邻失败间隔（时间单位任意，一致即可）。
 * 「恢复」被建模为失败强度游走下行首达阈值 a（缺省 = 间隔均值的一半，
 * 即失败频率减半）：μ̂/σ̂ 由间隔序列的均值/标准差估计（间隔上升 =
 * 恢复方向）。recommendedCooldown 二分求解。
 */
export function firstPassageCooldown(
  failureIntervals: ReadonlyArray<number>,
  options?: { targetProb?: number; threshold?: number },
): FirstPassageEstimate | undefined {
  const n = failureIntervals.length;
  if (n < 3) return undefined;
  const mean = failureIntervals.reduce((s, x) => s + x, 0) / n;
  let ss = 0;
  for (const x of failureIntervals) ss += (x - mean) * (x - mean);
  const sigma = Math.sqrt(ss / Math.max(1, n - 1));
  const a = options?.threshold ?? mean / 2;
  const target = Math.min(0.99, Math.max(0.5, options?.targetProb ?? 0.9));
  if (!(a > 0) || !(sigma > 0)) return undefined;
  // 间隔序列的漂移（对失败强度游走的代理：间隔趋势斜率）
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (i - (n - 1) / 2) * (failureIntervals[i] - mean);
    sxx += (i - (n - 1) / 2) * (i - (n - 1) / 2);
  }
  const mu = sxx > 0 ? sxy / sxx : 0; // 间隔增长率（> 0 = 恢复方向）
  if (mu > 0) {
    const m = a / mu;
    const shape = (a * a) / (sigma * sigma);
    // 二分求最小 horizon 使 IG-CDF(horizon) ≥ target
    let lo = m * 0.2;
    let hi = Math.max(m * 5, 1);
    while (inverseGaussianCdf(hi, m, shape) < target && hi < m * 1e6) hi *= 2;
    if (inverseGaussianCdf(hi, m, shape) >= target) {
      for (let k = 0; k < 60; k += 1) {
        const mid = (lo + hi) / 2;
        if (inverseGaussianCdf(mid, m, shape) >= target) hi = mid;
        else lo = mid;
      }
      return {
        mu,
        sigma,
        probByHorizon: inverseGaussianCdf(hi, m, shape),
        expectedTime: m,
        recommendedCooldown: hi,
      };
    }
    return { mu, sigma, probByHorizon: inverseGaussianCdf(hi, m, shape), expectedTime: m, recommendedCooldown: hi };
  }
  return { mu, sigma, probByHorizon: 0, expectedTime: undefined, recommendedCooldown: undefined };
}
