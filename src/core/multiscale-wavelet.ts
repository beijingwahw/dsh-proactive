/**
 * 49.0 多尺度内核 —— Haar 小波：趋势与突发在不同尺度上分离
 *
 * 动机: KPI 异常检测都在**单一时间尺度**上看序列（窗口 z-score、NIS、
 * 形状漂移）——缓慢漂移被当作背景，尖锐突发被当作噪声。Haar 小波
 * 把序列分解为**对数个尺度**的正交分量（Mallat 1989）:
 *
 *   H = I ⊗ ... 正交矩阵（能量守恒 ‖Hx‖ = ‖x‖，完美重构 H⁻¹ = Hᵀ）
 *   每层：近似分量（趋势/2 尺度）+ 细节分量（该尺度的突发）
 *
 *   读法: 最粗尺度的近似 = 长期水平；最细尺度的细节能量 = 瞬时抖动；
 *   中间尺度的细节尖峰 = 特定周期的异常。**同一份 KPI，对数个透镜**。
 *
 *   验证锚点: 完美重构（Hᵀ·Hx = x 机器精度）、能量守恒（Parseval）、
 *   合成「慢趋势 + 快突发」的双尺度分离（各尺度能量落位）。
 *
 * 零漂移: 未挂载时元认知输出与升级前逐位一致。
 */

export interface WaveletDecomposition {
  /** 每层细节系数（从最细到最粗：scale 1, 2, ..., n/2） */
  details: number[][];
  /** 最粗尺度近似（趋势水平） */
  approximation: number[];
  /** 各尺度能量占比（细节 + 近似，和 = 1） */
  energyShares: Array<{ scale: string; share: number }>;
  length: number;
}

/** Haar 离散小波变换（n 为 2 的幂；O(n log n)） */
export function haarDecompose(series: ReadonlyArray<number>): WaveletDecomposition {
  let n = series.length;
  if (n < 2 || (n & (n - 1)) !== 0) {
    // 截断/补零到 2 的幂（末端补零）
    let padded = 2;
    while (padded < n) padded <<= 1;
    const filled = [...series.slice(0, padded)];
    while (filled.length < padded) filled.push(filled[filled.length - 1] ?? 0);
    return haarDecompose(filled);
  }
  let approx = [...series];
  const details: number[][] = [];
  while (approx.length >= 2) {
    const nextApprox: number[] = [];
    const detail: number[] = [];
    for (let i = 0; i < approx.length; i += 2) {
      nextApprox.push((approx[i]! + approx[i + 1]!) / Math.SQRT2);
      detail.push((approx[i]! - approx[i + 1]!) / Math.SQRT2);
    }
    approx = nextApprox;
    details.push(detail);
  }
  // 能量（Parseval：Σ系数² = Σx²）
  const totalEnergy = series.reduce((s, x) => s + x * x, 0) || 1;
  const energyShares: Array<{ scale: string; share: number }> = [];
  details.forEach((d, i) => {
    const e = d.reduce((s, x) => s + x * x, 0);
    energyShares.push({ scale: `detail-${2 ** i}`, share: e / totalEnergy });
  });
  const approxEnergy = approx.reduce((s, x) => s + x * x, 0);
  energyShares.push({ scale: 'trend', share: approxEnergy / totalEnergy });
  return { details, approximation: approx, energyShares, length: series.length };
}

/** Haar 逆变换（完美重构验证锚点） */
export function haarReconstruct(decomposition: WaveletDecomposition): number[] {
  let approx = [...decomposition.approximation];
  for (let level = decomposition.details.length - 1; level >= 0; level -= 1) {
    const detail = decomposition.details[level]!;
    const next: number[] = [];
    for (let i = 0; i < detail.length; i += 1) {
      const a = approx[i]!;
      const d = detail[i]!;
      next.push((a + d) / Math.SQRT2, (a - d) / Math.SQRT2);
    }
    approx = next;
  }
  return approx;
}

export interface MultiScaleView {
  /** 最粗趋势水平（去尺度化：近似系数 / 2^(levels/2) 语义上即长期均值口径） */
  trendLevel: number;
  /** 最细尺度（逐点）细节能量占比 */
  burstShare: number;
  /** 能量最集中的非趋势尺度 */
  dominantScale: string;
  /** 中尺度（8-32 点）细节能量占比（漂移带） */
  driftShare: number;
}

/** 多尺度读数（49.0 接线口径：元认知 KPI 的尺度透镜） */
export function multiScaleView(series: ReadonlyArray<number>): MultiScaleView {
  const dec = haarDecompose(series);
  const mean = series.length > 0 ? series.reduce((s, x) => s + x, 0) / series.length : 0;
  let burstShare = 0;
  let driftShare = 0;
  const trendShare = dec.energyShares.find((e) => e.scale === 'trend')?.share ?? 0;
  let dominant = 'trend';
  let dominantShare = trendShare; // trend 先占主导（details 超过它才夺位）
  dec.energyShares.forEach((e, i) => {
    if (e.scale === 'trend') return;
    if (i === 0) burstShare = e.share;
    if (e.scale === 'detail-8' || e.scale === 'detail-16' || e.scale === 'detail-32') driftShare += e.share;
    if (e.share > dominantShare) {
      dominantShare = e.share;
      dominant = e.scale;
    }
  });
  return {
    trendLevel: mean,
    burstShare,
    dominantScale: dominant,
    driftShare,
  };
}
