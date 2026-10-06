/**
 * 42.0 谱周期内核 —— FFT 周期图 + Fisher g 检验：节律从数据里解出来
 *
 * 动机: 世界模型的「时段热度」是 24 小时直方图——周期被**预设**为一天。
 * 但多模型调度面对的节律不止昼夜：分钟级突发回环、小时级批处理、
 * 周节律——预设直方图看不见它们。谱分析把周期问题变成数据问题:
 *
 *   离散傅里叶变换（Cooley–Tukey 1965, O(n log n)）:
 *     X_k = Σ_t x_t e^{−2πikt/n}
 *   周期图 I_k = |X_k|²——信号能量在频率上的分布（Parseval: ΣI = nΣx²）。
 *
 *   Fisher g 检验（1929）: g = max_k I_k / Σ_k I_k——最大周期图份额；
 *   白噪声下 g 的精确分布已知（P(g > g₀) 递推式），g 显著大 ⟹ 序列
 *   含有**真实周期**而不是抖动。显著周期经谐波重构给出相位感知的
 *   季节因子——「现在处于周期的哪个相位」成为可计算的读数。
 *
 *   调度语义: 到达历史的显著周期 + 相位 → 预测乘上季节因子（该相位
 *   的历史期望权重），时段热度从「预设的小时直方图」升级为「从数据
 *   里解出的频谱」；无显著周期时因子恒 1（诚实无节律）。
 *
 *   验证锚点: FFT 往返恒等（x ↔ FFT⁻¹FFT(x)）、Parseval 定理、已知
 *   周期的频率恢复、纯噪声 g 检验不显著 / 注入周期显著。
 *
 * R5-A10 世界性进化（随机过程第五轮）:
 *   轴 1 数学: ③ 谐波梳（harmonic comb）多周期检测——非正弦周期信号
 *     的能量散布在基频的整数倍上，Fisher g（单 bin 最大份额）对它
 *     系统性失明；梳统计量 = 基频+谐波的周期图份额之和，白噪声零假设
 *     下份额联合分布是 Dirichlet(1/2,…,1/2) → **子集和服从精确
 *     Beta(K/2,(m−K)/2)**——梳 p 值有闭式（数据挑选的基频用 Bonferroni
 *     家族校正，诚实不装作先验已知）；
 *   轴 2 性能: ④ fftAutocorrelation——Wiener–Khinchin 定理，自相关
 *     一次 FFT 变换乘积（|FFT|²→IFFT）O(n log n)，替代逐 lag 直积
 *     O(n·L)，与直积**逐位等价**（相对误差 < 1e-9）；
 *   轴 3 稳健: ⑤ Fisher g 精确 p 升级为 log 域——lgamma(Lanczos) +
 *     log1p 项式 + Kahan 交错求和（小项先加），大 m（C(m,j) 直接
 *     乘积溢出到 1e308+）与极小 g 下不再返回 NaN。
 *
 * 零漂移: 未挂载时预测路径与升级前逐位一致。
 */

/** 迭代 radix-2 FFT（n 为 2 的幂；原地蝶形，bit 反转重排） */
export function fft(input: ReadonlyArray<number>): Array<{ re: number; im: number }> {
  const { re, im } = fftComplex([...input], new Array<number>(input.length).fill(0));
  return re.map((r, i) => ({ re: r, im: im[i] }));
}

/** 复数输入的 FFT 核心（ifft 的共轭法依赖它） */
function fftComplex(reIn: number[], imIn: number[]): { re: number[]; im: number[] } {
  const n = reIn.length;
  if (n === 0) return { re: [], im: [] };
  if ((n & (n - 1)) !== 0) throw new Error('fft: 长度必须是 2 的幂');
  const re = [...reIn];
  const im = [...imIn];
  // bit 反转
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j |= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  return { re, im };
}

/** 逆 FFT（共轭法：IFFT(X) = conj(FFT(conj(X)))/n，实序列取实部） */
export function ifft(spectrum: ReadonlyArray<{ re: number; im: number }>): number[] {
  const n = spectrum.length;
  const { re } = fftComplex(
    spectrum.map((c) => c.re),
    spectrum.map((c) => -c.im),
  );
  return re.map((r) => r / n);
}

export interface SpectralPeak {
  /** 周期图份额（I_k / ΣI） */
  share: number;
  /** 周期（ bins；period = n / k） */
  period: number;
  /** 频率 index k */
  frequency: number;
  /** 相位（弧度，x_t ≈ A·cos(2πkt/n + φ)） */
  phase: number;
  /** 振幅（2|X_k|/n，实信号口径） */
  amplitude: number;
}

export interface PeriodogramReport {
  /** 周期图（前 n/2+1 个 bin） */
  periodogram: number[];
  /** Fisher g 统计量（最大份额） */
  g: number;
  /** g 的上侧 p 值（白噪声零假设；精确分布递推） */
  pValue: number;
  /** 是否存在显著周期（p < alpha） */
  significant: boolean;
  /** 降序前 k 个谱峰（只报显著时） */
  peaks: SpectralPeak[];
  bins: number;
}

/**
 * Fisher g 检验上侧概率（精确递推，n_bins = n/2）:
 *   P(g > g₀) = Σ_j (-1)^{j+1} C(m, j) (1 - j·g₀)^{m-1}，j ≤ 1/g₀
 * （Fisher 1929；只取 1 - j·g₀ > 0 的项）
 *
 * R5-A10 轴 3（数值稳健性）: 项式改在 **log 域**计算——
 *   log|term_j| = lbinom(m,j) + (m−1)·log1p(−j·g₀)
 * （lgamma 用 Lanczos g=7 系数），再按 |term| **从小到大**（j 从大到小）
 * Kahan 交错累加。旧实现 C(m,j) 直接连乘在 m·g ≳ 380·ln2 时溢出为
 * Infinity/NaN（如 m=5000, g=0.005），log 域全程有限；在旧实现可行的
 * 区间两者相对误差 < 1e-12（验证脚本网格对照）。
 */
export function fisherGUpperTail(g: number, m: number): number {
  if (!(g > 0) || m < 2) return 1;
  if (g >= 1) return 0;
  if (!Number.isFinite(g) || !Number.isFinite(m)) return NaN;
  const mMinus1 = m - 1;
  const jMax = Math.min(m, Math.max(0, Math.ceil(1 / g) - 1));
  if (jMax < 1) return 1;
  // 按 |term| 从小到大（j 从大到小）Kahan 交错累加（小项先加降舍入）
  let sum = 0;
  let compensation = 0;
  for (let j = jMax; j >= 1; j -= 1) {
    const logTerm = logBinomial(m, j) + mMinus1 * Math.log1p(-j * g);
    // 组合后单项 > 1e304 属于双精度必然失真的病态区（现实参数不出现）——截断
    if (logTerm > 700) continue;
    const term = Math.exp(logTerm);
    const signed = j % 2 === 1 ? term : -term; // 符号 (−1)^{j+1}
    const y = signed - compensation;
    const t = sum + y;
    compensation = t - sum - y;
    sum = t;
  }
  return Math.min(1, Math.max(0, sum));
}

/** logΓ（Lanczos g=7, 9 项系数；z>0；|误差| < 2e-13 相对） */
export function logGamma(z: number): number {
  const LANCZOS = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    // 反射公式: Γ(z)Γ(1−z) = π/sin(πz)
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  let x = LANCZOS[0];
  for (let i = 1; i < 9; i += 1) x += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** log C(m, j)（二项系数 log 域——大 m 下唯一的有限口径） */
export function logBinomial(m: number, j: number): number {
  return logGamma(m + 1) - logGamma(j + 1) - logGamma(m - j + 1);
}

/**
 * 正则化不完全 Beta 上侧尾 P(B > x)（Lentz 连分数，Numerical Recipes 口径）。
 * 白噪声周期图份额的 Dirichlet(1/2,…,1/2) 聚合性质: 指定 K 个 bin 的
 * 份额和 ~ Beta(K/2, (m−K)/2)——谐波梳 p 值的闭式心脏。
 */
export function betaUpperTail(x: number, a: number, b: number): number {
  if (!(x > 0)) return 1;
  if (x >= 1) return 0;
  if (!(a > 0) || !(b > 0)) return NaN;
  const continuedFraction = (aa: number, bb: number, xx: number): number => {
    const tiny = 1e-30;
    const qab = aa + bb;
    const qap = aa + 1;
    const qam = aa - 1;
    let c = 1;
    let d = 1 - (qab * xx) / qap;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 300; m += 1) {
      const m2 = 2 * m;
      let aaa = (m * (bb - m) * xx) / ((qam + m2) * (aa + m2));
      d = 1 + aaa * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + aaa / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      h *= d * c;
      aaa = (-(aa + m) * (qab + m) * xx) / ((aa + m2) * (qap + m2));
      d = 1 + aaa * d;
      if (Math.abs(d) < tiny) d = tiny;
      c = 1 + aaa / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-14) break;
    }
    return h;
  };
  const logBetaPdfNorm = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x);
  // I_x(a,b)（下侧）; 上侧 = 1 − I_x
  const lower = x < (a + 1) / (a + b + 2)
    ? Math.exp(logBetaPdfNorm) * continuedFraction(a, b, x) / a
    : 1 - Math.exp(logBetaPdfNorm) * continuedFraction(b, a, 1 - x) / b;
  return Math.min(1, Math.max(0, 1 - lower));
}

/**
 * 周期图 + Fisher g 检验 + 谱峰提取。
 *
 * series: 等间隔采样序列（自动去均值）；lengthPad: 补零目标长度（2 的幂，
 * 缺省不补）。alpha 显著水平（缺省 0.05）。
 */
export function periodogram(series: ReadonlyArray<number>, options?: { alpha?: number; topPeaks?: number }): PeriodogramReport {
  const alpha = options?.alpha ?? 0.05;
  const topPeaks = options?.topPeaks ?? 3;
  const n = series.length;
  if (n < 8 || (n & (n - 1)) !== 0) {
    // 补零到 2 的幂（≥8）
    let padded = 8;
    while (padded < n) padded <<= 1;
    const mean = series.length > 0 ? series.reduce((a, b) => a + b, 0) / series.length : 0;
    const filled = [...series.map((x) => x - mean), ...new Array<number>(padded - n).fill(0)];
    return analyze(filled, n, alpha, topPeaks);
  }
  const mean = series.reduce((a, b) => a + b, 0) / n;
  return analyze(series.map((x) => x - mean), n, alpha, topPeaks);
}

function analyze(centered: ReadonlyArray<number>, originalN: number, alpha: number, topPeaks: number): PeriodogramReport {
  const n = centered.length;
  const spec = fft(centered);
  const half = Math.floor(n / 2);
  const pg: number[] = [];
  for (let k = 0; k <= half; k += 1) pg.push(spec[k].re * spec[k].re + spec[k].im * spec[k].im);
  const total = pg.reduce((a, b) => a + b, 0) || 1;
  // k=1（周期 = 整窗）排除：覆盖缺口/补零边界的伪低频能量几乎总是
  // 落在最低 bin——物理周期 ≤ 窗长一半才有资格称「周期」
  let g = 0;
  let bestK = 2;
  for (let k = 2; k < half; k += 1) {
    const share = pg[k] / total;
    if (share > g) {
      g = share;
      bestK = k;
    }
  }
  void bestK;
  const m = half - 2; // 检验自由 bin 数（排除 DC、k=1 与 Nyquist）
  const pValue = fisherGUpperTail(g, m);
  const significant = pValue < alpha;
  const peaks: SpectralPeak[] = [];
  if (significant) {
    // 候选域与 g 搜索域一致：自由 bin 全集 {2..half−1}（m = half−2 个）
    const order = Array.from({ length: half - 2 }, (_, i) => i + 2).sort((a, b) => pg[b] - pg[a]);
    const seen: number[] = [];
    for (const k of order) {
      if (peaks.length >= topPeaks) break;
      // 谐波去重：与已选峰成整数倍频的跳过（基频已携带该能量）
      if (seen.some((s) => Math.max(s, k) % Math.min(s, k) === 0)) continue;
      seen.push(k);
      const amplitude = (2 * Math.sqrt(pg[k])) / originalN;
      const phase = Math.atan2(-spec[k].im, spec[k].re);
      peaks.push({ share: pg[k] / total, period: originalN / k, frequency: k, phase, amplitude });
    }
  }
  return { periodogram: pg, g, pValue, significant, peaks, bins: n };
}

// ─────────────────── 42.0 预测接线口径（季节因子） ───────────────────

/**
 * 季节因子（42.0 接线口径）：给定历史等间隔序列与当前相位 bin，
 * 显著周期时返回「该相位的历史期望权重」（谐波重构，缺省平滑到 1），
 * 无显著周期 / 样本不足返回 1（诚实无节律——零介入）。
 */
export function seasonalFactor(history: ReadonlyArray<number>, phaseBin: number): { factor: number; significant: boolean; period: number | undefined } {
  if (history.length < 16) return { factor: 1, significant: false, period: undefined };
  const report = periodogram(history);
  if (!report.significant || report.peaks.length === 0) return { factor: 1, significant: false, period: undefined };
  const n = history.length;
  const mean = history.reduce((a, b) => a + b, 0) / n;
  if (!(mean > 0)) return { factor: 1, significant: false, period: undefined };
  // 谐波重构：均值 + 各非冗余谱峰在当前相位的取值
  let value = mean;
  for (const peak of report.peaks) {
    value += peak.amplitude * Math.cos((2 * Math.PI * peak.frequency * phaseBin) / n + peak.phase);
  }
  // 平滑钳位：季节分量最多 ±60%（极端直方图缺口的防呆口径）
  const factor = Math.min(1.6, Math.max(0.4, value / mean));
  return { factor, significant: true, period: report.peaks[0].period };
}

// ─────────────────── R5-A10 进化 ③/④：谐波梳多周期检测 + FFT 自相关 ───────────────────

export interface HarmonicCombPeak {
  /** 基频 bin k* */
  frequency: number;
  /** 周期 = originalN / k* */
  period: number;
  /** 梳统计量：基频+全部谐波 bin 的周期图份额和 */
  combShare: number;
  /** 命中的谐波 bin（含基频） */
  harmonics: number[];
  /** 精确 Beta p（基频视为预先指定时；Dirichlet 聚合性质） */
  pValue: number;
  /** Bonferroni 家族 p（基频从数据挑选时 × 候选基频数，诚实口径） */
  pValueFamily: number;
  significant: boolean;
}

export interface HarmonicCombReport {
  /** 按家族 p 升序的候选周期（已剔除非显著与「是已接受基频之谐波」者） */
  comb: HarmonicCombPeak[];
  /** 家族显著性（任一梳候选显著） */
  significant: boolean;
  /** 参与检验的自由 bin 数（与 Fisher g 同口径：排除 DC、k=1 与 Nyquist） */
  bins: number;
  /** 候选基频总数（Bonferroni 因子） */
  candidates: number;
}

/**
 * 谐波梳多周期检测（轴 1 数学进化）。
 *
 * 非正弦周期（方波/尖峰串）把能量铺在 f, 3f, 5f… 上——Fisher g 只看单个
 * 最大 bin，对它系统性失明。梳统计量把基频与谐波 bin 的份额**求和**：
 *
 *   comb(f) = (I_f + I_{2f} + … ) / ΣI，谐波 = k·f ≤ half−1 的整数倍
 *
 * 白噪声零假设下 m 个自由 bin 的份额向量 ~ Dirichlet(1/2,…,1/2)，
 * **聚合性质**: 指定 K 个 bin 的份额和 ~ Beta(K/2, (m−K)/2) →
 *   p = P(Beta > combShare)（betaUpperTail 闭式，精确）
 * 基频若从数据挑出（缺省：周期图局部极大且份额 ≥ 1.5/m 的 bin——真基频
 * 必是峰；任意 bin 会让真基频的因数以超集梳伪胜出），乘候选数做
 * Bonferroni 家族校正；先验已知周期（options.fundamental）时不惩罚。
 * 多周期：按家族 p 升序贪心接受，跳过是已接受基频整数倍的候选（那是
 * 谐波不是新周期）。
 */
export function harmonicComb(
  series: ReadonlyArray<number>,
  options?: { alpha?: number; fundamental?: number; maxPeriods?: number },
): HarmonicCombReport {
  const alpha = options?.alpha ?? 0.05;
  const maxPeriods = options?.maxPeriods ?? 3;
  const n = series.length;
  if (n < 16) return { comb: [], significant: false, bins: 0, candidates: 0 };
  const report = periodogram(series);
  const pg = report.periodogram;
  const half = Math.floor(report.bins / 2);
  const total = pg.reduce((s, v) => s + v, 0);
  const m = half - 2; // 与 Fisher g 同口径
  if (!(total > 0) || m < 4) return { comb: [], significant: false, bins: m, candidates: 0 };
  const originalN = n;
  const combAt = (f: number): { share: number; harmonics: number[] } => {
    const harmonics: number[] = [];
    let share = 0;
    for (let k = f; k <= half - 1; k += f) {
      harmonics.push(k);
      share += pg[k] / total;
    }
    return { share, harmonics };
  };
  const pOf = (f: number): { share: number; harm: number[]; p: number } => {
    const { share, harmonics } = combAt(f);
    const k = harmonics.length;
    // Dirichlet 聚合: 子集和 ~ Beta(K/2, (m−K)/2)
    const p = betaUpperTail(share, k / 2, Math.max(0.5, (m - k) / 2));
    return { share, harm: harmonics, p };
  };
  let candidates: number;
  let results: HarmonicCombPeak[] = [];
  if (options?.fundamental !== undefined) {
    const f = Math.round(options.fundamental);
    if (f >= 2 && f <= half - 1) {
      const r = pOf(f);
      results.push({
        frequency: f, period: originalN / f, combShare: r.share, harmonics: r.harm,
        pValue: r.p, pValueFamily: r.p, significant: r.p < alpha,
      });
    }
    candidates = 1;
  } else {
    // 候选基频 = 周期图局部极大且份额 ≥ 1.5/m 的 bin（真基频必是峰；任意 bin
    // 会让真基频的因数以超集梳伪胜出——别名防御）
    const threshold = 1.5 / m;
    const fundamentals: number[] = [];
    for (let f = 2; f <= half - 1; f += 1) {
      const share = pg[f] / total;
      if (share < threshold) continue;
      const left = f === 2 ? -Infinity : pg[f - 1];
      const right = f === half - 1 ? -Infinity : pg[f + 1];
      if (pg[f] >= left && pg[f] >= right) fundamentals.push(f);
    }
    candidates = fundamentals.length;
    const evaluated: Array<{ f: number; share: number; harm: number[]; p: number; family: number }> = [];
    for (const f of fundamentals) {
      const r = pOf(f);
      evaluated.push({ f, share: r.share, harm: r.harm, p: r.p, family: Math.min(1, r.p * Math.max(1, candidates)) });
    }
    evaluated.sort((a, b) => a.family - b.family || b.f - a.f);
    const taken: number[] = []; // 已接受基频（含其谐波）
    for (const e of evaluated) {
      if (results.length >= maxPeriods) break;
      if (e.family >= alpha) break; // 已按家族 p 升序——后面只会更大
      // 剔除：候选是已接受基频的整数倍（谐波而非新周期）
      if (taken.some((f0) => e.f % f0 === 0 && e.f !== f0)) continue;
      results.push({
        frequency: e.f, period: originalN / e.f, combShare: e.share, harmonics: e.harm,
        pValue: e.p, pValueFamily: e.family, significant: true,
      });
      taken.push(e.f);
      for (const h of e.harm) taken.push(h);
    }
  }
  return {
    comb: results,
    significant: results.some((r) => r.significant),
    bins: m,
    candidates,
  };
}

/**
 * FFT 自相关（轴 2 性能进化，Wiener–Khinchin）：
 *   ACF = IFFT(|FFT(x)|²)（补零到 ≥2n 的 2 的幂消 circular 卷绕）
 * 一次正逆变换给出全部 lag 的自相关，O(n log n) vs 逐 lag 直积 O(n·L)；
 * 与直积数值等价（相对差 < 1e-9，验证脚本对照）。返回 biased 口径
 * r(τ)/r(0)（÷n，谱分析标准口径）；unbiased=true 时 ÷(n−τ)。
 */
export function fftAutocorrelation(
  series: ReadonlyArray<number>,
  options?: { maxLag?: number; unbiased?: boolean },
): number[] {
  const n = series.length;
  if (n < 2) return n === 1 ? [1] : [];
  const maxLag = Math.min(n - 1, options?.maxLag ?? Math.min(n - 1, 64));
  const mean = series.reduce((s, v) => s + v, 0) / n;
  // 补零到 ≥ 2n 的 2 的幂（linear ACF 无 circular 卷绕）
  let m = 1;
  while (m < 2 * n) m <<= 1;
  const padded = new Array<number>(m).fill(0);
  for (let i = 0; i < n; i += 1) padded[i] = series[i] - mean;
  const spec = fft(padded);
  // |X|² 的逆变换 = ACF（补零后为 linear 口径）；返回 r(τ)/r(0)（尺度无关）
  const power = spec.map((c) => ({ re: c.re * c.re + c.im * c.im, im: 0 }));
  const acfRaw = ifft(power);
  const r0 = acfRaw[0];
  if (!(r0 > 0)) return new Array<number>(maxLag + 1).fill(0); // 常数序列
  const out: number[] = [];
  for (let lag = 0; lag <= maxLag; lag += 1) {
    const denom = options?.unbiased ? Math.max(1, n - lag) : n;
    out.push(acfRaw[lag] / denom / (r0 / n));
  }
  return out;
}
