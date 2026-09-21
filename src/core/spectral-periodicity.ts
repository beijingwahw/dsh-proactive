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
 */
export function fisherGUpperTail(g: number, m: number): number {
  if (!(g > 0) || m < 2) return 1;
  if (g >= 1) return 0;
  let p = 0;
  const binom = (a: number, b: number): number => {
    let c = 1;
    for (let i = 0; i < b; i += 1) c = (c * (a - i)) / (i + 1);
    return c;
  };
  for (let j = 1; j * g < 1 && j <= m; j += 1) {
    const term = binom(m, j) * Math.pow(1 - j * g, m - 1);
    p += j % 2 === 1 ? term : -term;
  }
  return Math.min(1, Math.max(0, p));
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
    const order = Array.from({ length: half - 3 }, (_, i) => i + 2).sort((a, b) => pg[b] - pg[a]);
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
