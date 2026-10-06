/**
 * 76.0 新奇检测内核 —— 「见过 vs 没见过」的分布数学（自主识别轴）
 *
 * 动机: 异常检测的主流口径是「多大」——幅值离群（23.0 重尾统计）与尾部极端
 * （28.0 EVT）回答的都是异常值有多极端。但自主识别的核心问题不是多大, 而是
 * 「这没见过」: 一个幅值完全正常、但组合方式从未出现的模式（新故障形态 / 新
 * 攻击签名 / 新行为模式）在一切幅值口径下隐形。本内核以基准集（已见世界）为
 * 参照, 给「没见过」第一个可计算口径——深度（在已见分布的中心有多深）、密度
 * （已见分布在该点有多稠密）、以及新奇分序列的序贯变点（世界何时开始换新）。
 *
 * 数学:
 *   ① Mahalanobis 深度（收缩协方差防奇异）:
 *      d²(x) = (x−μ̂)ᵀ Σ̂⁻¹ (x−μ̂),  depth = 1/(1+d²);
 *      高斯原假设下 d² ~ χ²ₚ（d²/p 内点 ≈ 1）, 上尾 P(χ²ₚ ≥ d²) 即新奇 p 值。
 *      样本协方差在 p > n 或强相关时奇异 → Ledoit–Wolf (2004) 收缩:
 *      Σ* = (1−s)·S + s·μI,  μ = tr(S)/p,  s = b²/d², 其中
 *      d² = ‖S−μI‖²_F / p（离散度）,  b̄² = Σᵢ wᵢ²·‖tᵢ−S‖²_F/p / (Σw)²
 *      （估计噪声; 频率权重推广口径, 整数权重时退化为 LW 原式）, b² = min(b̄², d²)。
 *      s 缺省取 LW 自动强度（n ≪ p → s→1, 恒正定）; 显式 s=0 时若奇异,
 *      诚实返回 degenerate（d²=NaN）而非假装可逆。
 *   ② kNN 密度比新奇分（mND 距离基准集第 k 近邻相对距离, 近邻计数比）:
 *      dₖ(x) = x 到基准集的第 k 近邻距离（权重累积 ≥ k 的加权第 k 近邻）;
 *      score = dₖ(x) / medianᵢ dₖ⁻ᶦⁱ(x)（基准集留一第 k 近邻距离的加权中位,
 *      维度自归一的相对口径）; 密度比（新奇向）log(ρ̃_基准/ρ̂(x)) = p·ln(dₖ/median)
 *      （kNN 密度的常数体积项在比值中抵消, 与 score 同向: 越大越新奇）;
 *      近邻计数比（保形口径）
 *      p = (1 + Σŵᵢ·1[dₖⁱ ≥ dₖ(x)]) / (1+n)——与 13.0 同一「让数据定阈」哲学。
 *   ③ CUSUM 序贯变点（Page 1954）: 对新奇分序列 Sₜ,
 *      zₜ = (Sₜ−μ₀)/σ₀,  Cₜ = max(0, Cₜ₋₁ + (zₜ−k)),  告警 Cₜ > h 后零状态复位。
 *      阈值 h 由可容许误报率校准, 口径文档化如下:
 *      误报率 = 每步误报概率 ≈ 1/ARL₀（更新循环更新报酬定理口径, 复位即更新起点）;
 *      ARL₀ 用 Brook–Evans (1972) 马尔可夫链数值解（统计量中点离散化, 缺省
 *      200 态, 该规格下与精确值相对偏差 <1%, 校准采用口径）, Siegmund 修正 Wald 闭式
 *      ARL₀ ≈ (e^{2k(h+1.166)} − 1 − 2k(h+1.166)) / (2k²) 作对照（离散时间过冲
 *      修正 ζ≈1.166, 已知 O(数成) 相对偏差, 不用于校准只用于审计）。
 *      μ₀/σ₀ 用中位数 + MAD×1.4826 稳健估计（新奇分右偏, 23.0 同源口径）。
 *   ④ 自适应基准窗: 参考集滑动更新, 旧样本指数衰减 w(age) = 2^(−age/halfLife)
 *      （有效样本量 ESS = (Σw)²/Σw²）, 且新奇样本不入窗（污染门控）——概念漂移
 *      后检测器自愈: 旧世界样本老化出局, 基准分布跟随新世界, 漂移后的新内点
 *      不再误报。
 *
 * 验证锚点（scripts/verify-novelty-detection.mjs, 全部确定性断言）:
 *   ① 种子化高斯内点 + 8σ 平移外点（p=4, n=300）: Mahalanobis 外点 χ² 比与
 *      p 值显著分离、kNN 第 k 近邻距离外点 100% 高于内点、noveltyAUC ≥ 0.95;
 *   ② CUSUM 已知时刻注入 0.5σ 均值漂移（误报率 0.001, ARL₀=1000 校准）:
 *      检测延迟有界且 < 同误报率朴素单点阈值法的 1/3; 平稳段实测误报率
 *      ≤ 校准值; Markov ARL 与蒙特卡洛 ARL 相对偏差 ≤ 12%, Siegmund 闭式
 *      同数量级;
 *   ③ p=64 > n=40 高维: 未收缩诚实报告奇异（degenerate, d²=NaN）, LW 自动
 *      收缩不崩（内点 χ² 比 ≈ 1, 12σ 外点显著分离, 收缩强度 > 0.5）;
 *   ④ 慢漂移（每步 0.02σ × 600 步）后: 自适应窗新内点误报 ≤ 8%,
 *      固定基准 ≥ 90%——检测器自愈的比例断言。
 *
 * 应用: Sentinel 异常信号识别（「没见过的模式」第一次有可计算口径——不是异常值
 * 多大, 而是「这没见过」）; 好奇心引擎对新奇定向（与 91.0 新奇搜索互补: 91.0
 * 搜索参数空间的新奇, 本内核判定观测空间的新奇）。
 *
 * R5 进化（拓扑动力内核第五轮）:
 *   ⑤ 局部离群因子 LOF（localOutlierFactor, Breunig–Kriegel–Ng–Sander 2000）
 *      ——kNN 密度比是**全局**口径（稀疏簇的正常成员会被误伤）; LOF 用
 *      「我的局部密度 vs 邻居们的局部密度」的比值: 均匀区 ≈ 1、稀疏簇
 *      内部仍 ≈ 1（邻居们同样稀疏）、孤立外点 ≫ 1——密度不均的世界里
 *      「离群」第一次有了局部口径。reach-dist（max(k-dist(o), d(p,o))）
 *      抹平近重复的密度爆炸, lrd 倒数护栏（零 reach 上限截断）。
 *   ⑥ 一维半空间深度 halfspaceDepth1D（Tukey 1975）——中位数深度 ≈ 0.5、
 *      出界深度 0, 单调远离中心; 一维 KPI 的「离中心多深」非参数口径。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入
 */

// ─────────────────── 确定性随机源（mulberry32 + Box–Muller） ───────────────────

/** mulberry32: 32 位确定性伪随机源（种子固定时序列逐位可复现, 零外部随机源） */
export function mulberry32(seed: number): () => number {
  if (!Number.isFinite(seed)) throw new Error(`mulberry32: seed 必须为有限数（得到 ${seed}）`);
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller 标准正态采样（配 mulberry32; 同随机源状态同输出） */
export function gaussianNoise(rand: () => number): number {
  const u1 = Math.max(rand(), Number.MIN_VALUE); // 防 log(0)
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ─────────────────── 特殊函数（Φ / χ² 上尾 / 分位数） ───────────────────

const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS: readonly number[] = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** Lanczos (g=7) log Γ——χ² 概率的底座 */
function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS_COEFFICIENTS[0];
  const t = z + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_COEFFICIENTS.length; i += 1) {
    a += LANCZOS_COEFFICIENTS[i]! / (z + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 正则化下不完全 γ 函数 P(s,x)（级数法, x < s+1 收敛） */
function gammaLowerSeries(s: number, x: number): number {
  let sum = 1 / s;
  let del = sum;
  let ap = s;
  for (let n = 0; n < 500; n += 1) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * 1e-16) break;
  }
  return sum * Math.exp(-x + s * Math.log(x) - logGamma(s));
}

/** 正则化上不完全 γ 函数 Q(s,x)（Lentz 连分式, x ≥ s+1 收敛） */
function gammaUpperContinuedFraction(s: number, x: number): number {
  const tiny = 1e-300;
  let b = x + 1 - s;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 500; i += 1) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return Math.exp(-x + s * Math.log(x) - logGamma(s)) * h;
}

/** 正则化上尾 Q(s,x) = Γ(s,x)/Γ(s)（口径选择: 级数 vs 连分式按 x 与 s+1 分界） */
function regularizedUpperGamma(s: number, x: number): number {
  if (x <= 0) return 1;
  if (x < s + 1) return 1 - gammaLowerSeries(s, x);
  return gammaUpperContinuedFraction(s, x);
}

/** 标准正态 CDF（erfc 与上尾 γ 的恒等式: Φ(x) = 1 − ½Q(½, x²/2), x ≥ 0） */
export function normalCdf(x: number): number {
  if (!Number.isFinite(x)) throw new Error(`normalCdf: x 必须为有限数（得到 ${x}）`);
  if (x === 0) return 0.5;
  return x < 0
    ? 0.5 * regularizedUpperGamma(0.5, (x * x) / 2)
    : 1 - 0.5 * regularizedUpperGamma(0.5, (x * x) / 2);
}

/** 标准正态分位数 Φ⁻¹（q ∈ (0,1); normalCdf 上二分——单调无局部极值） */
export function normalQuantile(q: number): number {
  if (!(q > 0 && q < 1)) throw new Error(`normalQuantile: q 必须落在开区间 (0,1)（得到 ${q}）`);
  let lo = -40;
  let hi = 40;
  for (let i = 0; i < 200; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (normalCdf(mid) < q) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** χ² 上尾 P(χ²_df ≥ x)——高斯原假设下 Mahalanobis d² 的新奇 p 值口径 */
export function chiSquareUpperTail(df: number, x: number): number {
  if (!Number.isInteger(df) || df < 1) throw new Error(`chiSquareUpperTail: df 必须为 ≥1 整数（得到 ${df}）`);
  if (!Number.isFinite(x)) throw new Error(`chiSquareUpperTail: x 必须为有限数（得到 ${x}）`);
  if (x <= 0) return 1;
  return regularizedUpperGamma(df / 2, x / 2);
}

/** χ² 分位数（CDF = q 的 x; 上界倍增 + 二分） */
export function chiSquareQuantile(df: number, q: number): number {
  if (!Number.isInteger(df) || df < 1) throw new Error(`chiSquareQuantile: df 必须为 ≥1 整数（得到 ${df}）`);
  if (!(q > 0 && q < 1)) throw new Error(`chiSquareQuantile: q 必须落在开区间 (0,1)（得到 ${q}）`);
  const cdf = (v: number): number => 1 - chiSquareUpperTail(df, v);
  let lo = 0;
  let hi = Math.max(1, df);
  while (cdf(hi) < q && hi < 1e12) hi *= 2;
  for (let i = 0; i < 200; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (cdf(mid) < q) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// ─────────────────── 共用校验 / 加权统计工具 ───────────────────

interface ReferenceShape {
  n: number;
  p: number;
}

function validateReferenceSet(reference: readonly (readonly number[])[], label: string): ReferenceShape {
  if (!Array.isArray(reference) || reference.length < 2) {
    throw new Error(`${label}: 基准集至少需要 2 个样本（得到 ${reference.length}）`);
  }
  const first = reference[0];
  if (first === undefined) throw new Error(`${label}: 基准集首样本缺失`);
  const p = first.length;
  if (!Number.isInteger(p) || p < 1) throw new Error(`${label}: 样本维度必须为 ≥1（得到 ${p}）`);
  for (const row of reference) {
    if (row.length !== p) throw new Error(`${label}: 基准集维度不一致（期望 ${p}, 得到 ${row.length}）`);
    for (const v of row) {
      if (!Number.isFinite(v)) throw new Error(`${label}: 样本含非有限值`);
    }
  }
  return { n: reference.length, p };
}

function validatePoint(x: readonly number[], p: number, label: string): void {
  if (x.length !== p) throw new Error(`${label}: 待测点维度必须为 ${p}（得到 ${x.length}）`);
  for (const v of x) {
    if (!Number.isFinite(v)) throw new Error(`${label}: 待测点含非有限值`);
  }
}

/** 权重校验（正有限）; 缺省返回均匀权重 1 */
function normalizeWeights(weights: readonly number[] | undefined, n: number, label: string): number[] {
  if (weights === undefined) return new Array<number>(n).fill(1);
  if (weights.length !== n) throw new Error(`${label}: 权重长度必须与基准集一致（${n} vs ${weights.length}）`);
  for (const w of weights) {
    if (!Number.isFinite(w) || w <= 0) throw new Error(`${label}: 权重必须为正有限数（得到 ${w}）`);
  }
  return [...weights];
}

interface WeightedValue {
  value: number;
  weight: number;
}

/** 加权第 k 近邻: 升序距离上累积权重首次 ≥ k 处的距离（频率权重口径） */
function weightedKthDistance(sortedAsc: readonly WeightedValue[], k: number): number {
  let acc = 0;
  for (const item of sortedAsc) {
    acc += item.weight;
    if (acc >= k) return item.value;
  }
  const last = sortedAsc[sortedAsc.length - 1];
  return last !== undefined ? last.value : 0; // 权重不足以凑满 k → 最大距离兜底（文档化口径）
}

/** 加权分位数（升序; 目标 = q·Σw） */
function weightedQuantile(sortedAsc: readonly WeightedValue[], q: number): number {
  let total = 0;
  for (const item of sortedAsc) total += item.weight;
  if (!(total > 0)) return 0;
  const target = q * total;
  let acc = 0;
  for (const item of sortedAsc) {
    acc += item.weight;
    if (acc >= target) return item.value;
  }
  const last = sortedAsc[sortedAsc.length - 1];
  return last !== undefined ? last.value : 0;
}

function plainMedian(sortedAsc: readonly number[]): number {
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 === 1
    ? sortedAsc[mid]!
    : (sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2;
}

function sampleStddev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) * (v - m), 0) / (xs.length - 1));
}

/** 加权矩: 均值 / 有偏加权协方差（LW 原文口径, 分母 Σw）/ 有效样本量 */
function weightedMoments(
  reference: readonly (readonly number[])[],
  weights: readonly number[],
): { mean: number[]; cov: number[][]; s1: number; ess: number } {
  const { n, p } = validateReferenceSet(reference, 'weightedMoments');
  const s1 = weights.reduce((s, w) => s + w, 0);
  const s2 = weights.reduce((s, w) => s + w * w, 0);
  const mean = new Array<number>(p).fill(0);
  for (let j = 0; j < p; j += 1) {
    let acc = 0;
    for (let i = 0; i < n; i += 1) acc += weights[i]! * reference[i]![j]!;
    mean[j] = acc / s1;
  }
  const cov: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let a = 0; a < p; a += 1) {
    for (let b = a; b < p; b += 1) {
      let acc = 0;
      for (let i = 0; i < n; i += 1) {
        acc += weights[i]! * (reference[i]![a]! - mean[a]!) * (reference[i]![b]! - mean[b]!);
      }
      const v = acc / s1;
      cov[a][b] = v;
      cov[b][a] = v;
    }
  }
  return { mean, cov, s1, ess: s2 > 0 ? (s1 * s1) / s2 : 0 };
}

/** Cholesky 分解（正定判定: 主元 > max对角×1e-13; 失败返回 null = 奇异/非正定） */
function choleskyFactor(matrix: readonly (readonly number[])[]): number[][] | null {
  const n = matrix.length;
  let maxDiag = 0;
  for (let i = 0; i < n; i += 1) maxDiag = Math.max(maxDiag, matrix[i]![i]!);
  if (!(maxDiag > 0)) return null;
  const tol = maxDiag * 1e-13;
  const lower: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = matrix[i]![j]!;
      for (let t = 0; t < j; t += 1) sum -= lower[i]![t]! * lower[j]![t]!;
      if (i === j) {
        if (!(sum > tol)) return null;
        lower[i]![i] = Math.sqrt(sum);
      } else {
        lower[i]![j] = sum / lower[j]![j]!;
      }
    }
  }
  return lower;
}

/** Cholesky 解 Σz = b（前代 + 回代） */
function choleskySolve(lower: readonly (readonly number[])[], b: readonly number[]): number[] {
  const n = b.length;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let s = b[i]!;
    for (let t = 0; t < i; t += 1) s -= lower[i]![t]! * y[t]!;
    y[i] = s / lower[i]![i]!;
  }
  const z = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let s = y[i]!;
    for (let t = i + 1; t < n; t += 1) s -= lower[t]![i]! * z[t]!;
    z[i] = s / lower[i]![i]!;
  }
  return z;
}

// ─────────────────── ① Mahalanobis 深度（收缩协方差防奇异） ───────────────────

export interface MahalanobisOptions {
  /** 收缩强度 [0,1): 缺省 = Ledoit–Wolf 自动强度; 显式 0 = 不收缩（奇异时诚实报告） */
  shrinkage?: number;
  /** 基准样本权重（自适应基准窗的衰减权重）; 缺省均匀 */
  weights?: readonly number[];
  /** χ² 新奇水平 (0,1), 缺省 0.01 */
  alpha?: number;
}

export interface MahalanobisDepthResult {
  /** (x−μ̂)ᵀΣ̂*⁻¹(x−μ̂); 奇异无法定义时 NaN（degenerate=true） */
  d2: number;
  /** Mahalanobis 深度 1/(1+d²)（越大越「见过」） */
  depth: number;
  dimension: number;
  effectiveSamples: number;
  /** 实际施加的收缩强度 */
  shrinkage: number;
  /** d²/p——每自由度 χ² 比, 高斯内点 ≈ 1 */
  chiSquareRatio: number;
  /** P(χ²ₚ ≥ d²)——新奇 p 值 */
  pValue: number;
  /** χ²ₚ 的 1−α 分位（新颖判定阈） */
  threshold: number;
  novel: boolean;
  /** 基准协方差（含收缩后）仍奇异/退化——诚实报告, 不给假数 */
  degenerate: boolean;
}

export interface LedoitWolfResult {
  /** LW 最优收缩强度 b²/d² ∈ [0,1] */
  intensity: number;
  /** 收缩目标尺度 μ = tr(S)/p */
  targetScale: number;
  /** 离散度 d² = ‖S−μI‖²_F/p */
  dispersion: number;
  /** 估计噪声 b̄²（capped 前） */
  noiseTerm: number;
}

/**
 * Ledoit–Wolf (2004) 收缩强度（恒等目标 μI）。
 *
 * 频率权重推广口径: 整数权重 wᵢ=kᵢ 时 b̄² = Σkᵢ²‖tᵢ−S‖²/(Σk)² 与原式
 * (1/n²)Σ‖tᵢ−S‖² 逐项一致; 连续衰减权重为同一泛函的自然延拓（文档化约定）。
 */
export function ledoitWolfIntensity(
  reference: readonly (readonly number[])[],
  weights?: readonly number[],
): LedoitWolfResult {
  const { n, p } = validateReferenceSet(reference, 'ledoitWolfIntensity');
  const w = normalizeWeights(weights, n, 'ledoitWolfIntensity');
  const { mean, cov, s1 } = weightedMoments(reference, w);
  const centered: number[][] = reference.map((row) => row.map((v, j) => v - mean[j]!));
  let trace = 0;
  for (let j = 0; j < p; j += 1) trace += cov[j]![j]!;
  const target = trace / p;
  let dispersion = 0;
  for (let a = 0; a < p; a += 1) {
    for (let b = 0; b < p; b += 1) {
      const base = a === b ? target : 0;
      const delta = cov[a]![b]! - base;
      dispersion += delta * delta;
    }
  }
  dispersion /= p;
  let noise = 0;
  for (let i = 0; i < n; i += 1) {
    let term = 0;
    for (let a = 0; a < p; a += 1) {
      for (let b = 0; b < p; b += 1) {
        const outer = centered[i]![a]! * centered[i]![b]!;
        const delta = outer - cov[a]![b]!;
        term += delta * delta;
      }
    }
    noise += w[i]! * w[i]! * (term / p);
  }
  noise /= s1 * s1;
  const b2 = Math.min(noise, dispersion);
  const intensity = dispersion > 1e-300 ? b2 / dispersion : 1;
  return { intensity, targetScale: target, dispersion, noiseTerm: noise };
}

/**
 * Mahalanobis 深度（收缩协方差）。
 *
 * Σ* = (1−s)·S + s·(tr(S)/p)·I 后 Cholesky 解 d² = (x−μ̂)ᵀΣ*⁻¹(x−μ̂);
 * 高斯原假设下 d² ~ χ²ₚ, p 值即上尾。显式 shrinkage=0 且样本协方差奇异
 * （p > n / 完全相关）时不假装可逆: degenerate=true, d²=NaN, novel=true
 * （无法证明「见过」按未见过处理, 保守口径）。
 */
export function mahalanobisDepth(
  reference: readonly (readonly number[])[],
  x: readonly number[],
  options?: MahalanobisOptions,
): MahalanobisDepthResult {
  const { n, p } = validateReferenceSet(reference, 'mahalanobisDepth');
  validatePoint(x, p, 'mahalanobisDepth');
  const alpha = options?.alpha ?? 0.01;
  if (!(alpha > 0 && alpha < 1)) throw new Error(`mahalanobisDepth: alpha 必须落在 (0,1)（得到 ${alpha}）`);
  if (options?.shrinkage !== undefined && !(options.shrinkage >= 0 && options.shrinkage < 1)) {
    throw new Error(`mahalanobisDepth: shrinkage 必须落在 [0,1)（得到 ${options.shrinkage}）`);
  }
  const w = normalizeWeights(options?.weights, n, 'mahalanobisDepth');
  const { mean, cov, ess } = weightedMoments(reference, w);
  const lw = ledoitWolfIntensity(reference, w);
  const s = options?.shrinkage ?? lw.intensity;
  const threshold = chiSquareQuantile(p, 1 - alpha);

  let trace = 0;
  for (let j = 0; j < p; j += 1) trace += cov[j]![j]!;
  const target = trace / p;
  if (!(target > 0)) {
    // 基准集全部重合（零方差）: 深度退化, 诚实报告
    let dist2 = 0;
    for (let j = 0; j < p; j += 1) dist2 += (x[j]! - mean[j]!) * (x[j]! - mean[j]!);
    return {
      d2: dist2 > 0 ? Infinity : 0,
      depth: dist2 > 0 ? 0 : 1,
      dimension: p,
      effectiveSamples: ess,
      shrinkage: s,
      chiSquareRatio: dist2 > 0 ? Infinity : 0,
      pValue: dist2 > 0 ? 0 : 1,
      threshold,
      novel: dist2 > 0,
      degenerate: true,
    };
  }

  const shrunk: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let a = 0; a < p; a += 1) {
    for (let b = 0; b < p; b += 1) {
      const base = a === b ? target : 0;
      shrunk[a]![b] = (1 - s) * cov[a]![b]! + s * base;
    }
  }
  const lower = choleskyFactor(shrunk);
  if (lower === null) {
    // 奇异（显式 shrinkage=0 且秩亏）: 不给假数
    return {
      d2: Number.NaN,
      depth: Number.NaN,
      dimension: p,
      effectiveSamples: ess,
      shrinkage: s,
      chiSquareRatio: Number.NaN,
      pValue: Number.NaN,
      threshold,
      novel: true,
      degenerate: true,
    };
  }
  const residual = x.map((v, j) => v - mean[j]!);
  const solved = choleskySolve(lower, residual);
  let d2 = 0;
  for (let j = 0; j < p; j += 1) d2 += residual[j]! * solved[j]!;
  d2 = Math.max(0, d2);
  const pValue = chiSquareUpperTail(p, d2);
  return {
    d2,
    depth: 1 / (1 + d2),
    dimension: p,
    effectiveSamples: ess,
    shrinkage: s,
    chiSquareRatio: d2 / p,
    pValue,
    threshold,
    novel: d2 > threshold,
    degenerate: false,
  };
}

// ─────────────────── ② kNN 密度比新奇分（mND 相对距离 + 计数比） ───────────────────

export interface KnnNoveltyOptions {
  /** 近邻数, 缺省 5（须满足 1 ≤ k ≤ n） */
  k?: number;
  /** 基准样本权重; 缺省均匀 */
  weights?: readonly number[];
  /** 闵氏距离幂次 ≥ 1, 缺省 2（欧氏） */
  power?: number;
  /** 保形计数比的新奇水平 (0,1), 缺省 0.05 */
  alpha?: number;
}

export interface KnnNoveltyResult {
  /** x 到基准集的第 k（加权）近邻距离 */
  kthDistance: number;
  /** 基准集留一第 k 近邻距离的加权中位（已见世界的典型间距） */
  referenceMedian: number;
  /** mND 相对距离比 dₖ(x)/median₍LOO₎——维度自归一的新奇分 */
  score: number;
  /** log 密度比（新奇向）: log(ρ̃_基准/ρ̂(x)) = p·ln(dₖ/median)——kNN 密度的常数
   *  体积项在比值中抵消; 正 = 比典型更稀（更新奇）, 与 score 同向 */
  logDensityRatio: number;
  /** 近邻计数比（保形口径）: (1 + Σŵᵢ·1[dₖⁱ ≥ dₖ(x)])/(1+n) */
  pValue: number;
  novel: boolean;
  k: number;
  effectiveSamples: number;
}

/**
 * kNN 密度比新奇分。
 *
 * mND（modified Novelty Degree, Nguyen–Gao 2013）的密度比思想在单类基准上的
 * 落地: 相对距离 score 与密度比 logDensityRatio 互为镜像（p·ln 1/score）,
 * 计数比 pValue 是 13.0 保形哲学的非参数版——「比 x 更孤立的基准点占比」。
 */
export function knnNovelty(
  reference: readonly (readonly number[])[],
  x: readonly number[],
  options?: KnnNoveltyOptions,
): KnnNoveltyResult {
  const { n, p } = validateReferenceSet(reference, 'knnNovelty');
  validatePoint(x, p, 'knnNovelty');
  const k = options?.k ?? 5;
  if (!Number.isInteger(k) || k < 1 || k > n) {
    throw new Error(`knnNovelty: k 必须为 1..n 的整数（n=${n}, 得到 ${k}）`);
  }
  const power = options?.power ?? 2;
  if (!(power >= 1)) throw new Error(`knnNovelty: power 必须 ≥ 1（得到 ${power}）`);
  const alpha = options?.alpha ?? 0.05;
  if (!(alpha > 0 && alpha < 1)) throw new Error(`knnNovelty: alpha 必须落在 (0,1)（得到 ${alpha}）`);
  const raw = normalizeWeights(options?.weights, n, 'knnNovelty');
  const s1 = raw.reduce((a, b) => a + b, 0);
  const s2 = raw.reduce((a, b) => a + b * b, 0);
  const what = raw.map((v) => (v * n) / s1); // 归一使 Σŵ = n（频率权重口径）
  const dist = (a: readonly number[], b: readonly number[]): number => {
    let acc = 0;
    for (let j = 0; j < p; j += 1) acc += Math.pow(Math.abs(a[j]! - b[j]!), power);
    return Math.pow(acc, 1 / power);
  };
  // x 的第 k 近邻
  const dx = reference.map((row, i) => ({ value: dist(x, row), weight: what[i]! })).sort((a, b) => a.value - b.value);
  const kth = weightedKthDistance(dx, k);
  // 基准集留一第 k 近邻距离（O(n²·p)——基准集规模受控的分析内核口径）
  const loo: WeightedValue[] = [];
  for (let i = 0; i < n; i += 1) {
    const pairs: WeightedValue[] = [];
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      pairs.push({ value: dist(reference[i]!, reference[j]!), weight: what[j]! });
    }
    pairs.sort((a, b) => a.value - b.value);
    loo.push({ value: weightedKthDistance(pairs, k), weight: what[i]! });
  }
  loo.sort((a, b) => a.value - b.value);
  const median = weightedQuantile(loo, 0.5);
  let exceed = 0;
  for (const item of loo) if (item.value >= kth) exceed += item.weight;
  const pValue = (1 + exceed) / (1 + n);
  const safeKth = Math.max(kth, 1e-300);
  const safeMedian = Math.max(median, 1e-300);
  return {
    kthDistance: kth,
    referenceMedian: median,
    score: safeKth / safeMedian,
    logDensityRatio: p * Math.log(safeKth / safeMedian),
    pValue,
    novel: pValue <= alpha,
    k,
    effectiveSamples: s2 > 0 ? (s1 * s1) / s2 : 0,
  };
}

// ─────────────────── noveltyAUC（新奇分的判别力总评） ───────────────────

export interface NoveltyAUCResult {
  /** Mann–Whitney AUC: 随机外点分数 > 随机内点分数的概率（平手计 0.5） */
  auc: number;
  inlierScoreMean: number;
  outlierScoreMean: number;
  /** min(外点分数) − max(内点分数): > 0 即完全分离 */
  margin: number;
}

/**
 * 新奇分判别力: 以 reference 为已见世界, 用 kNN 新奇分给内点/外点打分,
 * 报告 AUC（1 = 完全分离, 0.5 = 无判别力）。锚点口径: 平移外点族 AUC ≥ 0.95。
 */
export function noveltyAUC(
  reference: readonly (readonly number[])[],
  inliers: readonly (readonly number[])[],
  outliers: readonly (readonly number[])[],
  options?: KnnNoveltyOptions,
): NoveltyAUCResult {
  const { p } = validateReferenceSet(reference, 'noveltyAUC');
  if (inliers.length < 1) throw new Error(`noveltyAUC: 内点集至少 1 个样本（得到 ${inliers.length}）`);
  if (outliers.length < 1) throw new Error(`noveltyAUC: 外点集至少 1 个样本（得到 ${outliers.length}）`);
  for (const s of [...inliers, ...outliers]) validatePoint(s, p, 'noveltyAUC');
  const scoreOf = (s: readonly number[]): number => knnNovelty(reference, s, options).score;
  const si = inliers.map(scoreOf);
  const so = outliers.map(scoreOf);
  let wins = 0;
  for (const b of so) {
    for (const a of si) {
      if (b > a) wins += 1;
      else if (b === a) wins += 0.5;
    }
  }
  return {
    auc: wins / (si.length * so.length),
    inlierScoreMean: si.reduce((s, v) => s + v, 0) / si.length,
    outlierScoreMean: so.reduce((s, v) => s + v, 0) / so.length,
    margin: Math.min(...so) - Math.max(...si),
  };
}

// ─────────────────── ③ CUSUM 序贯变点 ───────────────────

export interface CUSUMConfig {
  /** 容许值 k（σ 单位; 常取待检测位移 δ 的一半; > 0） */
  k: number;
  /** 决策阈值 h（σ 单位; > 0）——calibrateThreshold 的输出 */
  h: number;
  /** 基线均值（与 baselineSigma 成对提供时对 Sₜ 标准化; 缺省视为输入已标准化） */
  baselineMean?: number;
  /** 基线尺度（> 0） */
  baselineSigma?: number;
}

export interface CUSUMRead {
  /** 累计更新次数 */
  t: number;
  /** 标准化后的本步观测 zₜ */
  standardized: number;
  /** 累积统计量 Cₜ = max(0, Cₜ₋₁ + (zₜ − k)) */
  c: number;
  /** 本步告警（Cₜ > h 的上升沿; 告警后零状态复位） */
  alarm: boolean;
  totalAlarms: number;
  stepsSinceAlarm: number;
}

/**
 * CUSUM 检测器（Page 1954）。
 *
 * 对新奇分序列 Sₜ: zₜ = (Sₜ−μ₀)/σ₀, Cₜ = max(0, Cₜ₋₁+(zₜ−k)), Cₜ > h 告警
 * 并复位 C=0（零状态重启, 更新循环口径——与校准用的 ARL 定义一致）。
 * 对小位移漂移的检测延迟按 Wald 渐近最优（对数似然比累积的线性化）。
 */
export class CUSUMDetector {
  private readonly config: CUSUMConfig;
  private readonly standardize: boolean;
  private c = 0;
  private t = 0;
  private totalAlarms = 0;
  private stepsSinceAlarm = 0;

  constructor(config: CUSUMConfig) {
    if (!Number.isFinite(config.k) || !(config.k > 0)) {
      throw new Error(`CUSUMDetector: k 必须为正数（得到 ${config.k}）`);
    }
    if (!Number.isFinite(config.h) || !(config.h > 0)) {
      throw new Error(`CUSUMDetector: h 必须为正数（得到 ${config.h}）`);
    }
    const hasMean = config.baselineMean !== undefined;
    const hasSigma = config.baselineSigma !== undefined;
    if (hasMean !== hasSigma) {
      throw new Error('CUSUMDetector: baselineMean 与 baselineSigma 必须成对提供（或都不提供）');
    }
    if (hasMean && !Number.isFinite(config.baselineMean)) {
      throw new Error(`CUSUMDetector: baselineMean 必须为有限数（得到 ${config.baselineMean}）`);
    }
    if (config.baselineSigma !== undefined && !(config.baselineSigma > 0)) {
      throw new Error(`CUSUMDetector: baselineSigma 必须为正数（得到 ${config.baselineSigma}）`);
    }
    this.config = { ...config };
    this.standardize = hasMean && hasSigma;
  }

  update(s: number): CUSUMRead {
    if (!Number.isFinite(s)) throw new Error(`CUSUMDetector.update: 观测必须为有限数（得到 ${s}）`);
    this.t += 1;
    const z = this.standardize
      ? (s - this.config.baselineMean!) / this.config.baselineSigma!
      : s;
    this.c = Math.max(0, this.c + (z - this.config.k));
    const alarm = this.c > this.config.h;
    if (alarm) {
      this.totalAlarms += 1;
      this.c = 0;
      this.stepsSinceAlarm = 0;
    } else {
      this.stepsSinceAlarm += 1;
    }
    return {
      t: this.t,
      standardized: z,
      c: this.c,
      alarm,
      totalAlarms: this.totalAlarms,
      stepsSinceAlarm: this.stepsSinceAlarm,
    };
  }

  reset(): void {
    this.c = 0;
    this.t = 0;
    this.totalAlarms = 0;
    this.stepsSinceAlarm = 0;
  }

  get iterations(): number {
    return this.t;
  }

  get alarmCount(): number {
    return this.totalAlarms;
  }

  get statistic(): number {
    return this.c;
  }
}

/**
 * Siegmund 修正 Wald 闭式 ARL 近似（对照口径, 不用于校准）:
 *   ARL₀ ≈ (e^{2k(h+ζ)} − 1 − 2k(h+ζ)) / (2k²),  ζ = 1.166（离散过冲修正）;
 *   k→0 极限 (h+ζ)²（零漂移随机走命中时间）。
 * 已知相对精确值有 O(数成) 偏差——审计时看数量级, 校准请用 cusumARLMarkov。
 */
export function cusumARLSiegmund(k: number, h: number): number {
  if (!Number.isFinite(k) || !(k > 0)) throw new Error(`cusumARLSiegmund: k 必须为正数（得到 ${k}）`);
  if (!Number.isFinite(h) || !(h > 0)) throw new Error(`cusumARLSiegmund: h 必须为正数（得到 ${h}）`);
  const hc = h + 1.166;
  if (k < 1e-8) return hc * hc;
  const y = 2 * k * hc;
  if (y > 690) return Number.POSITIVE_INFINITY;
  return (Math.expm1(y) - y) / (2 * k * k);
}

/**
 * Brook–Evans (1972) 马尔可夫链 ARL（校准采用口径, 中点离散化）。
 *
 * 把统计量值域 [0,h) 离散化为 states 个格子（格宽 w = h/states, 态取格中点
 * zᵢ = (i+½)·w——边界离散会系统性高估 ARL, 中点把偏差压到 O(w²)）, 瞬态转移
 * Q[i][j] = P(格 i → 格 j)（正态增量下用 Φ 直接写出）, 告警为吸收态;
 * ARL 解 (I−Q)·r = 1（列主元高斯消去）, 零状态 ARL = r₀。
 * 该规格（states = 200 缺省）与精确值相对偏差 < 1%
 * （k=0.5, h=5 锚点: m=200 → 919.0, 蒙特卡洛 926.5 ± 19）。
 */
export function cusumARLMarkov(k: number, h: number, states = 200): number {
  if (!Number.isFinite(k) || !(k > 0)) throw new Error(`cusumARLMarkov: k 必须为正数（得到 ${k}）`);
  if (!Number.isFinite(h) || !(h > 0)) throw new Error(`cusumARLMarkov: h 必须为正数（得到 ${h}）`);
  if (!Number.isInteger(states) || states < 20 || states > 2000) {
    throw new Error(`cusumARLMarkov: states 必须为 20..2000 的整数（得到 ${states}）`);
  }
  const m = states;
  const w = h / m;
  // 增广矩阵 [I−Q | 1]
  const rows: number[][] = [];
  for (let i = 0; i < m; i += 1) {
    const zi = (i + 0.5) * w;
    const row = new Array<number>(m + 1).fill(1);
    for (let j = 0; j < m; j += 1) {
      const pij =
        j === 0
          ? normalCdf(w - zi + k) // 负增量被 max(0,·) 折入 0 号格
          : normalCdf((j + 1) * w - zi + k) - normalCdf(j * w - zi + k);
      row[j] = (i === j ? 1 : 0) - pij;
    }
    rows.push(row);
  }
  // 列主元高斯消去（(I−Q) 为非奇异 M-阵, 数值稳定）
  for (let col = 0; col < m; col += 1) {
    let piv = col;
    for (let r = col + 1; r < m; r += 1) {
      if (Math.abs(rows[r]![col]!) > Math.abs(rows[piv]![col]!)) piv = r;
    }
    const tmp = rows[col];
    rows[col] = rows[piv]!;
    rows[piv] = tmp;
    const diag = rows[col]![col]!;
    if (Math.abs(diag) < 1e-300) throw new Error('cusumARLMarkov: 转移矩阵数值奇异（h/states 过小）');
    for (let r = col + 1; r < m; r += 1) {
      const f = rows[r]![col]! / diag;
      if (f === 0) continue;
      for (let c = col; c <= m; c += 1) rows[r]![c]! -= f * rows[col]![c]!;
    }
  }
  const r = new Array<number>(m).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    let acc = rows[i]![m]!;
    for (let j = i + 1; j < m; j += 1) acc -= rows[i]![j]! * r[j]!;
    r[i] = acc / rows[i]![i]!;
  }
  return r[0]!;
}

export interface CalibrationOptions {
  /** 容许值 k（σ 单位）, 缺省 0.5（瞄准 1σ 位移; δ/2 最优） */
  k?: number;
  /** 马尔可夫链离散态数, 缺省 200 */
  states?: number;
}

export interface CUSUMCalibration {
  k: number;
  /** 校准出的决策阈值（σ 单位） */
  h: number;
  falseAlarmRate: number;
  targetArl: number;
  /** Markov 口径的零状态 ARL（校准后残差, 应 ≈ targetArl） */
  arlZero: number;
  /** Siegmund 闭式对照值（审计用） */
  arlSiegmund: number;
  /** 稳健基线（中位数）——喂给 CUSUMDetector 的 baselineMean */
  baselineMean: number;
  /** 稳健尺度 MAD×1.4826（退化时回退标准差）——baselineSigma */
  baselineSigma: number;
  states: number;
  converged: boolean;
}

/**
 * 由平稳基准序列与可容许误报率校准 CUSUM 阈值 h。
 *
 * 口径: 误报率 = 每步误报概率 ≈ 1/ARL₀; 对 cusumARLMarkov(k,·) 单调二分
 * 反解 h 使 ARL₀ = 1/falseAlarmRate。基线用中位数 + MAD×1.4826 稳健估计
 * （新奇分右偏, 算术均值/标准差会被自身污染——23.0 的教训）; MAD 退化时
 * 回退样本标准差, 仍退化（恒定序列）则显式 throw。
 */
export function calibrateThreshold(
  reference: readonly number[],
  falseAlarmRate: number,
  options?: CalibrationOptions,
): CUSUMCalibration {
  if (!Array.isArray(reference) || reference.length < 10) {
    throw new Error(`calibrateThreshold: 基准序列至少 10 个观测（得到 ${reference.length}）`);
  }
  for (const v of reference) {
    if (!Number.isFinite(v)) throw new Error('calibrateThreshold: 基准序列含非有限值');
  }
  if (!(falseAlarmRate > 0 && falseAlarmRate <= 0.5)) {
    throw new Error(`calibrateThreshold: falseAlarmRate 必须落在 (0, 0.5]（得到 ${falseAlarmRate}）`);
  }
  const k = options?.k ?? 0.5;
  if (!Number.isFinite(k) || !(k > 0)) throw new Error(`calibrateThreshold: k 必须为正数（得到 ${k}）`);
  const states = options?.states ?? 200;
  if (!Number.isInteger(states) || states < 20 || states > 2000) {
    throw new Error(`calibrateThreshold: states 必须为 20..2000 的整数（得到 ${states}）`);
  }
  const sorted = [...reference].sort((a, b) => a - b);
  const median = plainMedian(sorted);
  const deviations = reference.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = plainMedian(deviations) * 1.4826;
  let sigma = mad;
  if (!(sigma > 1e-12)) sigma = sampleStddev(reference);
  if (!(sigma > 1e-12)) {
    throw new Error('calibrateThreshold: 基准序列零离散（恒定值）, 无法定义标准化与阈值');
  }
  const targetArl = 1 / falseAlarmRate;
  let lo = 0.01;
  let hi = 60; // ARL(60) ≥ e^{2·0.01·61} 量级 ≫ 任何目标, 上界必够
  for (let it = 0; it < 60; it += 1) {
    const mid = 0.5 * (lo + hi);
    if (cusumARLMarkov(k, mid, states) < targetArl) lo = mid;
    else hi = mid;
  }
  const h = 0.5 * (lo + hi);
  return {
    k,
    h,
    falseAlarmRate,
    targetArl,
    arlZero: cusumARLMarkov(k, h, states),
    arlSiegmund: cusumARLSiegmund(k, h),
    baselineMean: median,
    baselineSigma: sigma,
    states,
    converged: true,
  };
}

// ─────────────────── ④ 自适应基准窗（旧样本衰减 + 污染门控） ───────────────────

export interface AdaptiveWindowConfig {
  /** 窗容量上限（最近样本优先保留）, 缺省 256 */
  capacity: number;
  /** 半衰期（推进次数）: 权重 w(age) = 2^(−age/halfLife), 缺省 128 */
  halfLife: number;
  /** 权重低于此值的样本出局, 缺省 1e-3 */
  minWeight: number;
  /** 暖机样本量（低于此只入窗不判定）, 缺省 30 */
  minSamples: number;
  /** χ² 新奇水平（Mahalanobis 门控）, 缺省 0.01 */
  alpha: number;
  /** kNN 近邻数, 缺省 5 */
  k: number;
  /** Mahalanobis 收缩强度; 缺省 Ledoit–Wolf 自动 */
  shrinkage?: number;
}

export const DEFAULT_ADAPTIVE_WINDOW_CONFIG: AdaptiveWindowConfig = {
  capacity: 256,
  halfLife: 128,
  minWeight: 1e-3,
  minSamples: 30,
  alpha: 0.01,
  k: 5,
};

interface WindowEntry {
  sample: number[];
  age: number;
}

export interface AdaptiveNoveltyRead {
  /** 暖机期（窗未满 minSamples）: 只入窗不判定 */
  warmup: boolean;
  novel: boolean;
  /** 本样本是否入窗（暖机或非新奇） */
  accepted: boolean;
  /** 入窗前快照（observe 返回的读数为判定时刻状态） */
  mahalanobis: MahalanobisDepthResult | null;
  knn: KnnNoveltyResult | null;
  windowSize: number;
  effectiveSize: number;
}

export interface WindowReferenceView {
  samples: number[][];
  weights: number[];
  effectiveSize: number;
}

/**
 * 自适应基准窗: 概念漂移下「已见世界」的滚动更新。
 *
 * 两个自愈机制: ① 旧样本指数衰减（2^(−age/halfLife)）——旧世界的样本权重
 * 出局, 协方差/近邻结构跟随新世界; ② 污染门控——observe() 判定为新奇的样本
 * 不入窗（真正的未知不该污染「已见」的定义）。固定基准在漂移后必然把新内点
 * 全部误报; 本窗在慢漂移下滞后 ≈ halfLife/ln2 步（可配置）, 误报收敛回水位。
 */
export class AdaptiveReferenceWindow {
  private readonly config: Required<AdaptiveWindowConfig>;
  private entries: WindowEntry[] = [];
  private dim = 0;

  constructor(config?: Partial<AdaptiveWindowConfig>) {
    this.config = { ...DEFAULT_ADAPTIVE_WINDOW_CONFIG, ...config } as Required<AdaptiveWindowConfig>;
    const c = this.config;
    if (!Number.isInteger(c.capacity) || c.capacity < 2) {
      throw new Error(`AdaptiveReferenceWindow: capacity 必须为 ≥2 整数（得到 ${c.capacity}）`);
    }
    if (!Number.isFinite(c.halfLife) || !(c.halfLife > 0)) {
      throw new Error(`AdaptiveReferenceWindow: halfLife 必须为正数（得到 ${c.halfLife}）`);
    }
    if (!(c.minWeight > 0 && c.minWeight < 1)) {
      throw new Error(`AdaptiveReferenceWindow: minWeight 必须落在 (0,1)（得到 ${c.minWeight}）`);
    }
    if (!Number.isInteger(c.minSamples) || c.minSamples < 1) {
      throw new Error(`AdaptiveReferenceWindow: minSamples 必须为 ≥1 整数（得到 ${c.minSamples}）`);
    }
    if (!(c.alpha > 0 && c.alpha < 1)) {
      throw new Error(`AdaptiveReferenceWindow: alpha 必须落在 (0,1)（得到 ${c.alpha}）`);
    }
    if (!Number.isInteger(c.k) || c.k < 1) {
      throw new Error(`AdaptiveReferenceWindow: k 必须为 ≥1 整数（得到 ${c.k}）`);
    }
    if (c.shrinkage !== undefined && !(c.shrinkage >= 0 && c.shrinkage < 1)) {
      throw new Error(`AdaptiveReferenceWindow: shrinkage 必须落在 [0,1)（得到 ${c.shrinkage}）`);
    }
  }

  get size(): number {
    return this.entries.length;
  }

  get dimension(): number {
    return this.dim;
  }

  private weightOf(age: number): number {
    return Math.pow(0.5, age / this.config.halfLife);
  }

  /** 无门控入窗（外部已裁决非新奇时使用） */
  push(sample: readonly number[]): void {
    if (sample.length < 1) throw new Error('AdaptiveReferenceWindow.push: 样本维度必须 ≥1');
    for (const v of sample) {
      if (!Number.isFinite(v)) throw new Error('AdaptiveReferenceWindow.push: 样本含非有限值');
    }
    if (this.dim === 0) this.dim = sample.length;
    if (sample.length !== this.dim) {
      throw new Error(`AdaptiveReferenceWindow.push: 维度必须为 ${this.dim}（得到 ${sample.length}）`);
    }
    for (const e of this.entries) e.age += 1;
    this.entries.push({ sample: [...sample], age: 0 });
    while (this.entries.length > this.config.capacity) this.entries.shift();
    this.entries = this.entries.filter((e) => this.weightOf(e.age) >= this.config.minWeight);
  }

  /** 当前基准视图（样本 + 衰减权重 + 有效样本量） */
  reference(): WindowReferenceView {
    const weights = this.entries.map((e) => this.weightOf(e.age));
    const s1 = weights.reduce((a, b) => a + b, 0);
    const s2 = weights.reduce((a, b) => a + b * b, 0);
    return {
      samples: this.entries.map((e) => [...e.sample]),
      weights,
      effectiveSize: s2 > 0 ? (s1 * s1) / s2 : 0,
    };
  }

  /** 纯评估（不入窗）: 暖机期返回 warmup=true */
  assess(sample: readonly number[]): AdaptiveNoveltyRead {
    if (sample.length < 1) throw new Error('AdaptiveReferenceWindow.assess: 样本维度必须 ≥1');
    for (const v of sample) {
      if (!Number.isFinite(v)) throw new Error('AdaptiveReferenceWindow.assess: 样本含非有限值');
    }
    if (this.dim > 0 && sample.length !== this.dim) {
      throw new Error(`AdaptiveReferenceWindow.assess: 维度必须为 ${this.dim}（得到 ${sample.length}）`);
    }
    const view = this.reference();
    const need = Math.max(this.config.minSamples, this.dim + 2);
    if (this.entries.length < need || this.entries.length < 2) {
      return {
        warmup: true,
        novel: false,
        accepted: false,
        mahalanobis: null,
        knn: null,
        windowSize: this.entries.length,
        effectiveSize: view.effectiveSize,
      };
    }
    const m = mahalanobisDepth(view.samples, sample, {
      shrinkage: this.config.shrinkage,
      weights: view.weights,
      alpha: this.config.alpha,
    });
    const kn = knnNovelty(view.samples, sample, { k: this.config.k, weights: view.weights });
    const novel = m.degenerate ? true : m.novel;
    return {
      warmup: false,
      novel,
      accepted: false,
      mahalanobis: m,
      knn: kn,
      windowSize: this.entries.length,
      effectiveSize: view.effectiveSize,
    };
  }

  /** 观测并门控入窗: 非新奇（或暖机）才成为「已见世界」的一部分 */
  observe(sample: readonly number[]): AdaptiveNoveltyRead {
    const read = this.assess(sample);
    if (!read.novel) {
      this.push(sample);
      read.accepted = true;
    }
    return read;
  }
}

// ─────────────────── ⑤ 局部离群因子 LOF（R5: 密度不均世界的局部口径） ───────────────────

export interface LofOptions {
  /** 近邻数 k, 缺省 5（须 1 ≤ k ≤ n） */
  k?: number;
  /** 闵氏距离幂次 ≥ 1, 缺省 2（欧氏） */
  power?: number;
}

export interface LofResult {
  /** LOF(p): ≈1 = 与邻居同密度（均匀区/稀疏簇内部）; ≫1 = 局部离群 */
  lof: number;
  /** x 到基准集的第 k 近邻距离 */
  kDistance: number;
  /** x 的局部可达密度 lrd(x) = 1 / mean reach（护栏: 零均值 reach 截断到 1/1e-12） */
  lrd: number;
  /** 邻居下标（k 个, 距离升序、平局按下标序——确定序） */
  neighbors: number[];
  /** 对邻居的平均 reach-dist */
  meanReach: number;
}

/**
 * 局部离群因子（Breunig–Kriegel–Ng–Sander 2000）。
 *
 *   k-dist(p)   = p 到第 k 近邻的距离
 *   reach(p,o)  = max(k-dist(o), d(p,o))     ——抹平近重复的密度爆炸
 *   lrd(p)      = 1 / mean_{o∈N_k(p)} reach(p,o)
 *   LOF(p)      = mean_{o∈N_k(p)} lrd(o)/lrd(p)
 *
 * 与 ② kNN 密度比的分水岭: kNN 新奇分是全局口径——双密度世界（密簇 +
 * 疏簇）里疏簇的正常成员 k-dist 大, 被全局口径误伤; LOF 比较的是「我
 * 的局部密度 vs 我邻居们的局部密度」——疏簇内部邻居们同样稀疏, LOF ≈ 1,
 * 只有真正孤立于**自己邻域**的点 LOF ≫ 1。
 *
 * 数值纪律: 邻居平局按下标序（确定序）; 近重复（全零 reach）时 lrd 以
 * 1e-12 均值截断（上限 1e12——诚实截断而非 Infinity 污染比值）。
 */
export function localOutlierFactor(
  reference: readonly (readonly number[])[],
  x: readonly number[],
  options?: LofOptions,
): LofResult {
  const { n, p } = validateReferenceSet(reference, 'localOutlierFactor');
  validatePoint(x, p, 'localOutlierFactor');
  const k = options?.k ?? 5;
  if (!Number.isInteger(k) || k < 1 || k > n) {
    throw new Error(`localOutlierFactor: k 必须为 1..n 的整数（n=${n}, 得到 ${k}）`);
  }
  const power = options?.power ?? 2;
  if (!(power >= 1)) throw new Error(`localOutlierFactor: power 必须 ≥ 1（得到 ${power}）`);
  const dist = (a: readonly number[], b: readonly number[]): number => {
    let acc = 0;
    for (let j = 0; j < p; j += 1) acc += Math.pow(Math.abs(a[j]! - b[j]!), power);
    return Math.pow(acc, 1 / power);
  };
  /** 基准点 i 的第 k 近邻距离与邻居（排除自身; 平局按下标序） */
  const neighborsOf = (i: number): { kth: number; nb: Array<{ j: number; d: number }> } => {
    const pairs: Array<{ j: number; d: number }> = [];
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      pairs.push({ j, d: dist(reference[i]!, reference[j]!) });
    }
    pairs.sort((a, b) => a.d - b.d || a.j - b.j);
    return { kth: pairs[Math.min(k, pairs.length) - 1]?.d ?? 0, nb: pairs.slice(0, k) };
  };
  // 缓存基准点的邻居结构（LOF 需要邻居的 lrd → 邻居的邻居）
  const cache = new Map<number, { kth: number; nb: Array<{ j: number; d: number }> }>();
  const neighborsOfCached = (i: number): { kth: number; nb: Array<{ j: number; d: number }> } => {
    let e = cache.get(i);
    if (e === undefined) {
      e = neighborsOf(i);
      cache.set(i, e);
    }
    return e;
  };
  const REACH_CAP = 1e-12;
  const lrdOf = (nb: Array<{ j: number; d: number }>): number => {
    let sum = 0;
    for (const o of nb) sum += Math.max(neighborsOfCached(o.j).kth, o.d);
    const mean = sum / nb.length;
    return mean > REACH_CAP ? 1 / mean : 1 / REACH_CAP;
  };
  // x 的邻居与 lrd、LOF
  const xPairs: Array<{ j: number; d: number }> = [];
  for (let j = 0; j < n; j += 1) xPairs.push({ j, d: dist(x, reference[j]!) });
  xPairs.sort((a, b) => a.d - b.d || a.j - b.j);
  const xNb = xPairs.slice(0, k);
  const kDistance = xPairs[k - 1]!.d;
  let reachSum = 0;
  for (const o of xNb) reachSum += Math.max(neighborsOfCached(o.j).kth, o.d);
  const meanReach = reachSum / xNb.length;
  const lrdX = meanReach > REACH_CAP ? 1 / meanReach : 1 / REACH_CAP;
  let lofSum = 0;
  for (const o of xNb) lofSum += lrdOf(neighborsOfCached(o.j).nb) / lrdX;
  return {
    lof: lofSum / xNb.length,
    kDistance,
    lrd: lrdX,
    neighbors: xNb.map((o) => o.j),
    meanReach,
  };
}

/** LOF 判别力总评（noveltyAUC 的 LOF 版: 平手计 0.5） */
export function lofAUC(
  reference: readonly (readonly number[])[],
  inliers: readonly (readonly number[])[],
  outliers: readonly (readonly number[])[],
  options?: LofOptions,
): { auc: number; inlierMaxLof: number; outlierMinLof: number } {
  const { p } = validateReferenceSet(reference, 'lofAUC');
  if (inliers.length < 1 || outliers.length < 1) {
    throw new Error('lofAUC: 内点/外点集至少各 1 个样本');
  }
  for (const s of [...inliers, ...outliers]) validatePoint(s, p, 'lofAUC');
  const si = inliers.map((s) => localOutlierFactor(reference, s, options).lof);
  const so = outliers.map((s) => localOutlierFactor(reference, s, options).lof);
  let wins = 0;
  for (const b of so) {
    for (const a of si) {
      if (b > a) wins += 1;
      else if (b === a) wins += 0.5;
    }
  }
  return {
    auc: wins / (si.length * so.length),
    inlierMaxLof: Math.max(...si),
    outlierMinLof: Math.min(...so),
  };
}

// ─────────────────── ⑥ 一维半空间深度（Tukey depth） ───────────────────

/**
 * 一维半空间深度（Tukey 1975）: depth(x) = min(#{v ≤ x}, #{v ≥ x}) / n。
 *
 * 中位数处 ≈ 0.5（最深）、离开中心单调下降、出值域即 0——「离已见世界
 * 的中心多深」的非参数口径（无分布假设; 与 Mahalanobis 的椭圆假设互补）。
 */
export function halfspaceDepth1D(reference: readonly number[], x: number): number {
  if (!Array.isArray(reference) || reference.length < 1) {
    throw new Error(`halfspaceDepth1D: reference 至少 1 个观测（得到 ${reference.length}）`);
  }
  for (const v of reference) {
    if (!Number.isFinite(v)) throw new Error('halfspaceDepth1D: reference 含非有限值');
  }
  if (!Number.isFinite(x)) throw new Error(`halfspaceDepth1D: x 必须为有限数（得到 ${x}）`);
  let le = 0;
  let ge = 0;
  for (const v of reference) {
    if (v <= x) le += 1;
    if (v >= x) ge += 1;
  }
  return Math.min(le, ge) / reference.length;
}

// ─────────────────── 接线建议 ───────────────────
// 1. Sentinel 异常信号识别: 挂载点为信号监察引擎（engine/observability 链路）。
//    每类信号流维护一个 AdaptiveReferenceWindow（特征向量 = 该信号的嵌入/摘要
//    数组, 维度由上游特征器决定, 建议先经 15.0 信息瓶颈降维到 p ≤ 32）, 用
//    observe() 替换现有的静态阈值判异: 「异常」从「幅值超阈」升级为「没见过」
//    （mahalanobis.novel / knn.pValue 双证据, 可要求双触发降低误报）。窗口容量
//    = 日活跃信号量级, halfLife ≈ 概念漂移时间尺度（小时→数百次观测）。
// 2. 好奇心引擎对新奇定向: 与 91.0 新奇搜索互补——91.0 在参数/行为空间搜索
//    新奇（生成侧）, 本内核在观测空间判定新奇（评价侧）: 把候选方向的预期观测
//    特征喂 assess(), novelty 越高分配越多探索预算（好奇心 = 新奇分的单调
//    函数, 内在奖励有了可计算口径）。
// 3. 新奇分序列的运维变点监测: 对 Sentinel 每窗口的新奇分均值/最大值流, 用
//    calibrateThreshold(scores, 0.01) 校准 CUSUMDetector——「世界开始出现更多
//    没见过的东西」本身是一个可检测的变点（比单点异常更早的系统性预警）。
// 4. 缺省关闭旗标: config.noveltySentinelEnabled（缺省 false）。打开后仅改变
//    一处决策点: 信号判异从静态幅值阈值改为「窗口深度 + kNN 计数比」双证据,
//    且告警语义从「值过大」变为「模式未见过」; 旗标关闭时监察路径与现状逐位
//    一致（零漂移）。
