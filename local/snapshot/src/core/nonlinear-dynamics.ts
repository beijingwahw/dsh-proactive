/**
 * 38.0 非线性动力学内核 —— Lyapunov 指数 + Hurst 标度：系统动力学体质分类
 *
 * 动机: KPI 序列的异常检测（z-score / NIS / 形状漂移）都在问「现在
 * 正常吗」，没有问**这条序列是什么体质**：
 *
 *   最大 Lyapunov 指数 λ₁ > 0 ⟹ 混沌（敏感依赖）——误差指数放大，
 *     任何预测的可用视野只有 ~1/λ₁ 步；λ₁ ≤ 0 ⟹ 轨道稳定。
 *     Rosenstein 法（1993）：重构空间找最近邻，平均对数分离率的最陡
 *     段斜率——不重构全谱，只取最大指数，短序列可用。
 *
 *   Hurst 指数 H（R/S 分析，1951）——长记忆标度：
 *     H > 0.5 持续性（趋势自我强化，动量口径）；H ≈ 0.5 无记忆
 *     （布朗）；H < 0.5 反持续（均值回归，振荡口径）。
 *     E[R(n)/S(n)] ~ c·n^H。
 *
 *   体质分类改变下游口径: 混沌序列上精细预测器（26.0 GP / 世界模型）
 *     的置信区间应随 1/λ₁ 收窄视野；持续序列的趋势洞察值得加权；
 *     反持续序列的「突破」多半回归——**同一份 KPI，三种读法**。
 *
 *   验证锚点: logistic 映射 x→4x(1−x) 的 λ₁ = ln 2（解析已知）；
 *     白噪声 H ≈ 0.5；趋势叠加随机游走 H > 0.5。
 *
 *   R5 进化（拓扑动力内核第五轮）: Wolf 法最大 Lyapunov 指数（wolfLyapunov，
 *   Wolf et al. 1985）——Rosenstein 的「平均对数分离曲线取最陡段斜率」是
 *   拟合口径，Wolf 是**逐步重整化的直接法**: 追踪一对轨迹的分离，分离
 *   超阈即换邻居重定向（保持线性区），λ₁ = Σ ln(dₖ/dₖ₋₁)/Σk 纯 log 域
 *   累加（无指数、无 exp——除零护栏: 零分离步跳过不贡献）。多起点
 *   （3 轨迹）汇池平均。锚点: logistic r=4 → λ₁ ≈ ln2；周期窗口
 *   （r=3.2/3.5）→ λ₁ ≈ 0（周期轨道上分离不增长——一维可观测口径的
 *   诚实边界：横向收缩率不可见）；参数扫描与解析轨迹平均逐点对符号。
 *
 * 零漂移: 未挂载时元认知输出与升级前逐位一致。
 */

export interface LyapunovResult {
  /** 最大 Lyapunov 指数估计（每步，nat） */
  lambda: number;
  /** 拟合窗口（用于斜率回归的分离步区间 [0, fitWindow]） */
  fitWindow: number;
  /** 平均分离曲线（log 发散 vs 步数；断言单调性的原料） */
  divergence: number[];
  usedPairs: number;
}

/**
 * Rosenstein 最大 Lyapunov 指数。
 *
 * series: 标量序列（≥ 32 点）；meanGap 排除时间近邻（假最近邻防御）；
 * fitWindow: 线性拟合的步数上限（缺省 ~ √N）。
 */
export function largestLyapunov(
  series: ReadonlyArray<number>,
  options?: { meanGap?: number; fitWindow?: number },
): LyapunovResult | undefined {
  const n = series.length;
  if (n < 32) return undefined;
  const meanGap = Math.max(1, options?.meanGap ?? 5);
  const fitWindow = Math.max(4, Math.min(options?.fitWindow ?? Math.floor(Math.sqrt(n)), n - 2));
  // 最近邻（排除 |i−j| < meanGap）
  const neighbor = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i += 1) {
    let best = -1;
    let bestDist = Infinity;
    for (let j = 0; j < n; j += 1) {
      if (Math.abs(i - j) < meanGap) continue;
      const d = Math.abs(series[i] - series[j]);
      if (d < bestDist) {
        bestDist = d;
        best = j;
      }
    }
    neighbor[i] = best;
  }
  const used = Array.from({ length: n }, (_, i) => i).filter((i) => neighbor[i] >= 0 && i + fitWindow < n && neighbor[i] + fitWindow < n);
  if (used.length < 8) return undefined;
  const divergence: number[] = [];
  for (let k = 0; k <= fitWindow; k += 1) {
    let sum = 0;
    for (const i of used) {
      sum += Math.log(1e-12 + Math.abs(series[i + k] - series[neighbor[i]! + k]));
    }
    divergence.push(sum / used.length);
  }
  // 最陡段斜率（混沌标志）：滑窗线性回归取最大斜率（前 1/3 至全窗）
  let lambda = 0;
  for (let span = Math.max(3, Math.floor(fitWindow / 3)); span <= fitWindow; span += 1) {
    const m = span + 1;
    const mx = (m - 1) / 2;
    const my = divergence.slice(0, m).reduce((a, b) => a + b, 0) / m;
    let num = 0;
    let den = 0;
    for (let k = 0; k < m; k += 1) {
      num += (k - mx) * (divergence[k] - my);
      den += (k - mx) * (k - mx);
    }
    if (den > 0) lambda = Math.max(lambda, num / den);
  }
  return { lambda, fitWindow, divergence, usedPairs: used.length };
}

export interface HurstResult {
  hurst: number;
  /** 各窗口的 (log n, log R/S) 点（回归原料） */
  points: Array<{ logN: number; logRS: number }>;
}

// ═══════════ R5: Wolf 法最大 Lyapunov 指数（重整化直接法） ═══════════

export interface WolfOptions {
  /** 替换阈值：分离超过该倍数 × 吸引子直径时换邻居重定向（缺省 0.05——Wolf 原文线性区口径） */
  replacementThreshold?: number;
  /** 时间近邻排除窗 |t−p| ≥ meanGap（缺省 5，与 Rosenstein 同口径——防平移复制） */
  meanGap?: number;
  /** 轨迹起点数（缺省 3: 首点/1/3 处/2/3 处——汇池平均的稳健口径） */
  tracks?: number;
}

export interface WolfResult {
  /** λ₁ 估计（每步，nat）= Σ ln(dₖ/dₖ₋₁) / Σ k——纯 log 域累加 */
  lambda: number;
  /** 累计演化步数（分母；零分离步跳过不计） */
  steps: number;
  /** 邻居替换次数（分离超阈 → 重定向回线性区；Wolf 法的 Signature 动作） */
  replacements: number;
  /** 追踪轨迹数 */
  tracks: number;
}

/**
 * Wolf 法最大 Lyapunov 指数（Wolf, Swift, Swinney & Vastano 1985——标量
 * 序列版）。
 *
 * 与 Rosenstein 的差别: Rosenstein 取「平均分离曲线最陡段」的回归斜率
 * （拟合口径，短窗噪声敏感）；Wolf 逐步追踪一对轨迹: 分离 dₖ 每步贡献
 * ln(dₖ/dₖ₋₁)，分离超过 replacementThreshold × 吸引子直径（序列值域）即
 * 把邻居重定向到当前参考点的最近邻（时间近邻排除），把分离拉回线性区
 * ——重整化让对数增长率直接可加，不依赖任何窗口拟合。
 *
 * 数值纪律（R5 轴 3）: 全程 log 域（log(dₖ/dₖ₋₁) 逐项累加，无 exp）；
 * 零分离步（重复值）跳过不贡献（d=0 的 ln 无定义——诚实跳过而非注入
 * 噪声）；最近邻平局取下标小者（确定序）。
 *
 * 诚实边界: 周期轨道上 λ₁ ≈ 0（分离不增长——一维可观测口径看不见
 * 横向收缩率），判「非混沌」正确、判「收缩强度」不可能。
 */
export function wolfLyapunov(series: ReadonlyArray<number>, options?: WolfOptions): WolfResult | undefined {
  const threshold = options?.replacementThreshold ?? 0.05;
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error(`wolfLyapunov: replacementThreshold 须为正数（得到 ${String(threshold)}）`);
  }
  const meanGap = Math.max(1, Math.floor(options?.meanGap ?? 5));
  const trackCount = Math.max(1, Math.min(options?.tracks ?? 3, 12));
  const n = series.length;
  if (n < 32) return undefined;
  for (const v of series) {
    if (!Number.isFinite(v)) return undefined;
  }
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of series) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const diameter = hi - lo;
  if (!(diameter > 1e-12)) return undefined; // 常值序列：分离恒零，无 Lyapunov 可言
  const replaceAt = threshold * diameter;

  /** 当前参考点的最近邻（时间近邻排除；平局取下标小者；全零分离返回 -1） */
  const nearest = (t: number): number => {
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let j = 0; j < n; j += 1) {
      if (Math.abs(t - j) < meanGap) continue;
      const d = Math.abs(series[t]! - series[j]!);
      if (d > 0 && d < bestDist) {
        bestDist = d;
        best = j;
      }
    }
    return best;
  };

  let zsum = 0;
  let steps = 0;
  let replacements = 0;
  for (let tr = 0; tr < trackCount; tr += 1) {
    const t0 = Math.min(n - 2, Math.floor((tr * (n - 1)) / trackCount));
    let anchorT = t0; // 参考轨迹锚点（邻居与其同步推进；重定向后重锚）
    let anchorP = nearest(t0);
    if (anchorP < 0) continue;
    let dPrev = Math.abs(series[anchorT]! - series[anchorP]!);
    if (dPrev <= 0) continue;
    for (let t = anchorT + 1; t < n; t += 1) {
      const pt = anchorP + (t - anchorT); // 邻居与参考同步推进
      if (pt >= n) break; // 邻居轨迹走到尽头
      const d = Math.abs(series[t]! - series[pt]!);
      if (d > 0 && dPrev > 0) {
        zsum += Math.log(d / dPrev);
        steps += 1;
      }
      if (d > replaceAt) {
        // 分离超出线性区 → 重定向: 换当前参考点的最近邻，重锚同步起点
        const q = nearest(t);
        if (q < 0) break;
        anchorT = t;
        anchorP = q;
        const dNew = Math.abs(series[t]! - series[q]!);
        if (dNew <= 0) break;
        dPrev = dNew;
        replacements += 1;
      } else {
        dPrev = d; // 零分离步：跳过贡献，分离状态照常更新
      }
    }
  }
  if (steps < 8) return undefined;
  return { lambda: zsum / steps, steps, replacements, tracks: trackCount };
}

/** R/S 分析（多窗口聚合回归；窗口数不足时返回 undefined） */
export function hurstExponent(series: ReadonlyArray<number>): HurstResult | undefined {
  const n = series.length;
  if (n < 32) return undefined;
  const points: Array<{ logN: number; logRS: number }> = [];
  for (let size = 8; size <= n / 2; size = Math.floor(size * 1.6)) {
    const chunks = Math.floor(n / size);
    let rsSum = 0;
    let used = 0;
    for (let c = 0; c < chunks; c += 1) {
      const seg = series.slice(c * size, (c + 1) * size);
      const mean = seg.reduce((a, b) => a + b, 0) / seg.length;
      let cum = 0;
      let min = Infinity;
      let max = -Infinity;
      let ss = 0;
      for (const x of seg) {
        cum += x - mean;
        min = Math.min(min, cum);
        max = Math.max(max, cum);
        ss += (x - mean) * (x - mean);
      }
      const s = Math.sqrt(ss / seg.length);
      if (s <= 1e-12) continue;
      rsSum += (max - min) / s;
      used += 1;
    }
    if (used > 0) points.push({ logN: Math.log(size), logRS: Math.log(rsSum / used) });
  }
  if (points.length < 3) return undefined;
  const mx = points.reduce((s, p) => s + p.logN, 0) / points.length;
  const my = points.reduce((s, p) => s + p.logRS, 0) / points.length;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.logN - mx) * (p.logRS - my);
    den += (p.logN - mx) * (p.logN - mx);
  }
  if (den <= 0) return undefined;
  return { hurst: num / den, points };
}

export type DynamicsRegime = 'chaotic' | 'persistent' | 'mean-reverting' | 'stochastic';

export interface DynamicsAssessment {
  regime: DynamicsRegime;
  lyapunov: number | undefined;
  hurst: number | undefined;
  /** 混沌视野（步数 ≈ 1/λ₁；λ₁ ≤ 0 时 undefined = 无界） */
  forecastHorizonSteps: number | undefined;
  readable: boolean;
}

/**
 * 最近邻一步可预测性（噪声门判据，Casdagli 局部线性预测）。
 *
 * 每点取值域最近 m 邻居，用邻居的下一步均值预测：白噪声无增益
 * （score ≈ 1）；确定性映射近零误差（score ≈ 0）；线性 AR 只有
 * 线性增益（φ=±0.8 → score ≈ 0.6）。作混沌判定的前置门——白噪声
 * 对 Rosenstein 是无穷维混沌（最近邻瞬间发散），必须先排除。
 */
export function determinismScore(series: ReadonlyArray<number>, m = 8): number | undefined {
  const n = series.length;
  if (n < 32) return undefined;
  const mean = series.reduce((s, x) => s + x, 0) / n;
  let varSum = 0;
  for (const x of series) varSum += (x - mean) * (x - mean);
  const sd = Math.sqrt(varSum / n);
  if (sd <= 1e-12) return undefined;
  let errSum = 0;
  let used = 0;
  for (let i = 0; i + 1 < n; i += 1) {
    // 值域最近 m 邻居（排除时间近邻 |i−j| < 5，防平移复制）
    const dists: Array<{ d: number; next: number }> = [];
    for (let j = 0; j + 1 < n; j += 1) {
      if (Math.abs(i - j) < 5) continue;
      dists.push({ d: Math.abs(series[i] - series[j]), next: series[j + 1] });
    }
    if (dists.length < m) continue;
    dists.sort((a, b) => a.d - b.d);
    let pred = 0;
    for (let k = 0; k < m; k += 1) pred += dists[k].next;
    pred /= m;
    errSum += (series[i + 1] - pred) * (series[i + 1] - pred);
    used += 1;
  }
  if (used < 16) return undefined;
  return Math.sqrt(errSum / used) / sd;
}

/**
 * 动力学体质分类（38.0 接线口径）。
 *
 * 判序: 先过**噪声门**（最近邻一步可预测性 determinism < 0.5——白噪声
 * 无可预测增益，却会被 Rosenstein 判成无穷维混沌）；过门且 λ₁ > λPos
 * （缺省 0.05 nat/步）→ 混沌；否则 H > 0.5+δ → 持续、H < 0.5−δ →
 * 反持续、其余 → 随机漫步体质。
 */
export function dynamicsRegime(
  series: ReadonlyArray<number>,
  options?: { lambdaThreshold?: number; hurstDelta?: number; determinismGate?: number },
): DynamicsAssessment {
  const lambdaThreshold = options?.lambdaThreshold ?? 0.05;
  const hurstDelta = options?.hurstDelta ?? 0.08;
  const determinismGate = options?.determinismGate ?? 0.5;
  const lyap = largestLyapunov(series);
  const hurst = hurstExponent(series);
  // 确定性门取近期子窗（≤96 点）——体质跟随口径：混合历史不稀释
  // 当前动力学结构的可预测性判读
  const det = determinismScore(series.length > 96 ? series.slice(-96) : series);
  const h = hurst?.hurst;
  const readable = lyap !== undefined && hurst !== undefined;
  if (lyap !== undefined && lyap.lambda > lambdaThreshold && det !== undefined && det < determinismGate) {
    return {
      regime: 'chaotic',
      lyapunov: lyap.lambda,
      hurst: h,
      forecastHorizonSteps: Math.max(1, Math.round(1 / lyap.lambda)),
      readable,
    };
  }
  if (h !== undefined && h > 0.5 + hurstDelta) {
    return { regime: 'persistent', lyapunov: lyap?.lambda, hurst: h, forecastHorizonSteps: undefined, readable };
  }
  if (h !== undefined && h < 0.5 - hurstDelta) {
    return { regime: 'mean-reverting', lyapunov: lyap?.lambda, hurst: h, forecastHorizonSteps: undefined, readable };
  }
  return { regime: 'stochastic', lyapunov: lyap?.lambda, hurst: h, forecastHorizonSteps: undefined, readable };
}
