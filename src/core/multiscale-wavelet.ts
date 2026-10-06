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
 * R5-A11 进化（四轴）:
 *   [数学] Daubechies D4 正交小波基（精确代数系数 (1±√3)/4 族，满足
 *     Σc² = 2、Σc_nc_{n+2m} = 2δ、高低通交替翻转正交——由 D4 的定义
 *     方程解出，非查表值）。daubechies4Decompose/Reconstruct: 周期
 *     边界的正交滤波器组 DWT——比 Haar 多一阶消失矩（光滑趋势不再
 *     泄漏进细节尺度），完美重构与 Parseval 到机器精度（verify 双锚点
 *     × 200 种子）。
 *   [数学] 模极大值奇异性分析（Mallat–Hwang 1992）: singularityLipschitz
 *     沿尺度链追踪小波系数模极大，回归 log₂|W_f(2^j)| ~ j·(α+1/2)
 *     （Haar 一阶消失矩口径）估计 Lipschitz 指数 α——阶跃 α≈0、尖点
 *     α≈0.5、折点 α≈1、白噪声 α<0（verify: 合成奇异性恢复 ±0.15）。
 *     KPI 异常从「有/无」升级为「多不规则」（可微 / 折点 / 阶跃 / 噪声）。
 *   [性能] haarDecompose 原地分层（单工作缓冲，算术表达式与旧版逐位
 *     相同——输出零漂移），分配次数从 O(层数×2) 降到 O(层数)；
 *     128K 点实测提速（verify: 逐位一致 + 耗时对照）。
 *   [数值稳健性] 非有限样本按 0 处理（旧版 NaN 逐层污染整个谱）；
 *     n ≤ 1 / 空序列的安全退化；能量份额除零护栏（已除 totalEnergy||1）。
 *
 * 零漂移: 有限输入的 haarDecompose/haarReconstruct/multiScaleView 输出
 *   与升级前逐位一致（原地化为等价改写）；非有限输入从 NaN 传播改为
 *   置 0（文档化的护栏行为）。
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

/** 序列清洗: 非有限样本置 0（NaN/±∞ 不再逐层污染整个谱） */
function sanitize(series: ReadonlyArray<number>): number[] {
  return series.map((v) => (Number.isFinite(v) ? v : 0));
}

/** Haar 离散小波变换（n 为 2 的幂；O(n log n)；原地分层——算术与旧版逐位一致） */
export function haarDecompose(series: ReadonlyArray<number>): WaveletDecomposition {
  const nRaw = series.length;
  if (nRaw < 2 || (nRaw & (nRaw - 1)) !== 0) {
    // 截断/补零到 2 的幂（末端重复末值）
    let padded = 2;
    while (padded < nRaw) padded <<= 1;
    const filled = sanitize(series.slice(0, padded));
    while (filled.length < padded) filled.push(filled[filled.length - 1] ?? 0);
    return haarDecompose(filled);
  }
  const a = sanitize(series);
  // 能量在净化副本上计算（变换会原地覆写 a）——非有限样本置 0 后谱与份额同为有限
  const seriesEnergy = a.reduce((s, x) => s + x * x, 0) || 1;
  const details: number[][] = [];
  let size = a.length;
  while (size >= 2) {
    const half = size >> 1;
    const detail: number[] = []; // push 构建（packed 元素种类——避免 holey 数组的慢访问）
    for (let k = 0; k < half; k += 1) {
      const lo = (a[2 * k] + a[2 * k + 1]) / Math.SQRT2;
      const hi = (a[2 * k] - a[2 * k + 1]) / Math.SQRT2;
      a[k] = lo; // 原地写（k ≤ 2k，读取先行完成）
      detail.push(hi);
    }
    details.push(detail);
    size = half;
  }
  // 能量（Parseval：Σ系数² = Σx²；seriesEnergy 已在净化副本上先行算好）
  const energyShares: Array<{ scale: string; share: number }> = [];
  details.forEach((d, i) => {
    const e = d.reduce((s, x) => s + x * x, 0);
    energyShares.push({ scale: `detail-${2 ** i}`, share: e / seriesEnergy });
  });
  const approxEnergy = a[0] * a[0];
  energyShares.push({ scale: 'trend', share: approxEnergy / seriesEnergy });
  return { details, approximation: [a[0]], energyShares, length: series.length };
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

// ─────────────────── R5: Daubechies D4（精确代数系数） ───────────────────

/**
 * Daubechies D4 尺度滤波器（Σc² = 2 口径，精确代数值）:
 *   c₀ = (1+√3)/4, c₁ = (3+√3)/4, c₂ = (3−√3)/4, c₃ = (1−√3)/4
 * 满足 D4 定义方程: Σcₙ = 2、Σ(−1)ⁿnᵏcₙ = 0（k=0,1 两阶消失矩的
 * 对偶条件）、Σcₙc_{n+2m} = 2δ_{m0}（平移正交）——由这些代数条件解出，
 * 非数值查表。
 */
export function daubechies4Filter(): number[] {
  const r3 = Math.sqrt(3);
  return [(1 + r3) / 4, (3 + r3) / 4, (3 - r3) / 4, (1 - r3) / 4];
}

/** D4 周期边界正交分解一层: approx[k] = (1/√2)Σcₙ·a[(2k+n) mod N] 等 */
function dwtStep(a: number[], size: number, c: number[], d: number[]): { approx: number[]; detail: number[] } {
  const half = size >> 1;
  const approx = new Array<number>(half);
  const detail = new Array<number>(half);
  const invSqrt2 = 1 / Math.SQRT2;
  for (let k = 0; k < half; k += 1) {
    let lo = 0;
    let hi = 0;
    for (let n = 0; n < 4; n += 1) {
      const v = a[(2 * k + n) % size];
      lo += c[n] * v;
      hi += d[n] * v;
    }
    approx[k] = lo * invSqrt2;
    detail[k] = hi * invSqrt2;
  }
  return { approx, detail };
}

/** D4 周期边界逆变换一层: a[m] = (1/√2)Σₖ(c_{m−2k}·approx[k] + d_{m−2k}·detail[k]) */
function idwtStep(approx: number[], detail: number[], size: number, c: number[], d: number[]): number[] {
  const half = size >> 1;
  const out = new Array<number>(size).fill(0);
  const invSqrt2 = 1 / Math.SQRT2;
  for (let k = 0; k < half; k += 1) {
    const ak = approx[k] * invSqrt2;
    const dk = detail[k] * invSqrt2;
    for (let n = 0; n < 4; n += 1) {
      out[(2 * k + n) % size] += c[n] * ak + d[n] * dk;
    }
  }
  return out;
}

/**
 * Daubechies D4 离散小波变换（周期边界；n 为 2 的幂，非 2 幂按旧口径
 * 重复末值补齐）。输出结构与 haarDecompose 相同（details 最细→最粗、
 * approximation、energyShares、length）。正交滤波器组: 完美重构与
 * Parseval 到机器精度；两阶消失矩使线性趋势不泄漏进细节（对照 Haar
 * 的一阶——verify 锚点）。
 */
export function daubechies4Decompose(series: ReadonlyArray<number>): WaveletDecomposition {
  const nRaw = series.length;
  if (nRaw < 2 || (nRaw & (nRaw - 1)) !== 0) {
    let padded = 2;
    while (padded < nRaw) padded <<= 1;
    const filled = sanitize(series.slice(0, padded));
    while (filled.length < padded) filled.push(filled[filled.length - 1] ?? 0);
    return daubechies4Decompose(filled);
  }
  const c = daubechies4Filter();
  const d = [c[3], -c[2], c[1], -c[0]]; // 交替翻转 (−1)ⁿc₃₋ₙ
  let a = sanitize(series);
  // 能量在净化副本上计算（后续循环会整体替换 a）——非有限样本置 0 后份额同为有限
  const seriesEnergy = a.reduce((s, x) => s + x * x, 0) || 1;
  const details: number[][] = [];
  let size = a.length;
  while (size >= 2) {
    const { approx, detail } = dwtStep(a, size, c, d);
    a = approx;
    details.push(detail);
    size >>= 1;
  }
  // 能量（Parseval：Σ系数² = Σx²；seriesEnergy 已在净化副本上先行算好）
  const energyShares: Array<{ scale: string; share: number }> = [];
  details.forEach((det, i) => {
    const e = det.reduce((s, x) => s + x * x, 0);
    energyShares.push({ scale: `detail-${2 ** i}`, share: e / seriesEnergy });
  });
  const approxEnergy = a[0] * a[0];
  energyShares.push({ scale: 'trend', share: approxEnergy / seriesEnergy });
  return { details, approximation: [a[0]], energyShares, length: series.length };
}

/** D4 逆变换（完美重构验证锚点） */
export function daubechies4Reconstruct(decomposition: WaveletDecomposition): number[] {
  const c = daubechies4Filter();
  const d = [c[3], -c[2], c[1], -c[0]];
  let a = [...decomposition.approximation];
  let size = a.length;
  for (let level = decomposition.details.length - 1; level >= 0; level -= 1) {
    size <<= 1;
    a = idwtStep(a, decomposition.details[level]!, size, c, d);
  }
  return a;
}

// ─────────────────── R5: 模极大值奇异性（Lipschitz 指数估计） ───────────────────

export interface LipschitzEstimate {
  /** 奇异性位置（最细尺度模极大所在的采样区间中点，下标口径） */
  position: number;
  /** Lipschitz 指数 α = 回归斜率 − 1/2（Haar 一阶消失矩口径） */
  exponent: number;
  /** log₂|W_f| 对尺度 j 的回归斜率（理论 α + 1/2） */
  slope: number;
  /** 链上的尺度数（回归样本数） */
  scalesUsed: number;
  /** 模极大链: level 1（最细）起，逐尺度 {level, position, magnitude} */
  chain: Array<{ level: number; position: number; magnitude: number }>;
}

/**
 * 模极大值 Lipschitz 估计（Mallat–Hwang 1992; Haar 口径）。
 *
 * 奇异性 x₀ 处 |W f(2^j, x₀)| ~ C·2^{j(α+1/2)}——沿尺度链追踪模极大，
 * log₂|W| 对 j 线性回归: 斜率 = α + 1/2。链的追踪: 最细尺度全局模极大
 * 起步，逐尺度在 [prev − 1, prev + 1]·2^{j−1} 窗口内取模极大（确定性
 * 平局取小下标）。读法: α ≈ 1 光滑折点、α ≈ 0.5 尖点、α ≈ 0 阶跃、
 * α < 0 噪声样不规则。
 */
export function singularityLipschitz(series: ReadonlyArray<number>): LipschitzEstimate {
  const dec = haarDecompose(series);
  const levels = dec.details.length;
  if (levels === 0) return { position: 0, exponent: 0, slope: 0, scalesUsed: 0, chain: [] };
  // 模极大链: 最细尺度全局 |detail| 最大处起步
  const chain: Array<{ level: number; position: number; magnitude: number }> = [];
  const finest = dec.details[0];
  let bestPos = 0;
  let bestMag = -1;
  for (let k = 0; k < finest.length; k += 1) {
    const m = Math.abs(finest[k]);
    if (m > bestMag + 1e-300) {
      bestMag = m;
      bestPos = k;
    }
  }
  chain.push({ level: 1, position: bestPos, magnitude: bestMag });
  for (let j = 2; j <= levels; j += 1) {
    const det = dec.details[j - 1];
    if (!det || det.length === 0) break;
    const prev = chain[chain.length - 1];
    // 尺度 j 的系数覆盖 [k·2^j, (k+1)·2^j): 上尺度位置 x 对应本尺度
    // 候选窗 [floor(x/2) − 2^{j−1}, …]——以扩张半径 2^{j−1} 追踪
    const radius = 2 ** (j - 1);
    const center = Math.floor(prev.position / 2);
    let lo = Math.max(0, center - radius);
    let hi = Math.min(det.length - 1, center + radius);
    let pos = -1;
    let mag = -1;
    for (let k = lo; k <= hi; k += 1) {
      const m = Math.abs(det[k]);
      if (m > mag + 1e-300) {
        mag = m;
        pos = k;
      }
    }
    if (pos < 0) break;
    chain.push({ level: j, position: pos, magnitude: mag });
  }
  // 回归 log2|W| ~ level（模极大为 0 的尺度截断）
  const pts = chain.filter((c) => c.magnitude > 1e-300);
  const m = pts.length;
  if (m < 2) {
    const pos0 = chain[0];
    return { position: finestPosToSample(pos0.position, 1), exponent: Number.NaN, slope: Number.NaN, scalesUsed: m, chain };
  }
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    const x = p.level;
    const y = Math.log2(p.magnitude);
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx);
  const exponent = slope - 0.5;
  return { position: finestPosToSample(chain[0].position, 1), exponent, slope, scalesUsed: m, chain };
}

/** 最细尺度系数位置 → 采样区间中点 */
function finestPosToSample(pos: number, _level: number): number {
  return pos + 0.5;
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
  // 净化后求均值（与谱同口径——非有限样本置 0，trendLevel 不随 NaN 发散）
  const clean = sanitize(series);
  const mean = clean.length > 0 ? clean.reduce((s, x) => s + x, 0) / clean.length : 0;
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
