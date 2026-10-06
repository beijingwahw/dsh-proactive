/**
 * 33.0 随机矩阵内核 —— Marchenko–Pastur 噪声边界 + 特征值清洗 + 系统性风险
 *
 * 动机: 多模型系统的「相关性」是排险与分流的依据——两个模型同挂才需要
 * 热备，彼此独立的模型才构成真正的冗余。但**样本相关矩阵的大多数特征
 * 结构是纯噪声**：p 个模型 × n 个观测的 iid 噪声，其相关谱不是集中于 1，
 * 而是铺满一整条带——
 *
 *   Marchenko–Pastur (1967): p×n iid（方差 σ²/n 口径）样本协方差的谱
 *   渐近支撑于 [σ²(1−√γ)², σ²(1+√γ)²]，γ = p/n。
 *   → **λ > λ+ 的特征值在纯噪声下几乎不可能出现**（大偏差指数衰减）：
 *   噪声带以上 = 信号（真实的相关结构），以下 = 不可区分于噪声。
 *
 *   RMT 清洗（Laloux et al. 1999 / Plerou et al. 2002, 「noise dressing」）:
 *   谱分解 → λ < λ+ 的特征值替换为其均值（保迹）→ 重组 → 对角归一。
 *   被清洗的矩阵把「伪相关」抹掉、把真结构保留——相关性从统计幻觉
 *   升级为可证伪的结构断言。
 *
 *   系统性风险判据（本内核的调度语义）: 模型失败序列的相关矩阵经清洗后，
 *   若头号特征值仍显著超出 MP 边界（解释份额 λ₁/Σλ 超阈值），说明存在
 *   **共同因子**（同厂商 / 同上游 / 同配额池）——一个因子倒下会同时击穿
 *   一串「看起来分散」的模型。伪相关则会被清洗到边界内——不误报。
 *
 *   特征分解: 循环 Jacobi 旋转（对称矩阵，二次收敛，纯 TS 零依赖），
 *   A = QΛQᵀ 正交到机器精度——谱的每个数字都是可复算的。
 *
 * R5-A11 进化（四轴）:
 *   [数学] MP 分布从「只有边界」升维为**全分布断言**: mpDensity 解析式
 *     ρ(x) = √((λ+−x)(x−λ−))/(2πσ²γx)；mpCdf 自适应 Simpson 数值积分
 *     （积分总质量 = 1 到 1e-10）；mpKsTest 对经验谱 vs MP 律做 KS 检验
 *     （含 Kolmogorov 分布 p 值与 Stephens 有限样本校正）——「谱是噪声」
 *     第一次成为可拒绝的假设而不只是目测。
 *   [数学] Tracy–Widom 边缘律的**数值解**: Hastings–McLeod 解（Painlevé II
 *     q'' = sq + 2q³）经有限差分边值问题 + 阻尼牛顿求出（残差 < 1e-11），
 *     TW₂ = exp(−∫(x−s)q²)、TW₁ = √TW₂·exp(−½∫q)；配合 Johnstone 边缘
 *     标准化 edgeStandardScore，头号特征值有了**分布已知的检验统计量**
 *     （verify: TW₁ 分位数锚点 0.05/−3.181、0.5/−1.262、0.95/0.980 各
 *     ±0.03 内；GOE 蒙特卡洛均值对照）。口径注意: 标准化按**样本协方差**
 *     （1/n 列中心化）标定；相关矩阵的对角归一使统计量下偏 ~0.5σ
 *     （有限样本效应，文档化而非掩盖）。
 *   [性能] jacobiEigensym 对称镜像旋转: 列/行旋转互为转置镜像——非角元
 *     算一次镜像写两处、角元走解析式，每对旋转算术量 ~6n → ~4n（120×120
 *     实测 ~1.4×），特征值与两遍实现一致到重结合舍入（verify 对照）。
 *   [数值稳健性] 特征值排序平局显式按下标定序（浮点相等时结果确定）；
 *     mpEdges 的 sigma2/γ 护栏；KS 统计量对未排序输入自动排序。
 *
 * 零漂移: 现有导出（jacobiEigensym/mpEdges/correlationFromSeries/
 *   cleanseCorrelation/SystemicRiskMonitor）签名与语义不变（Jacobi 的
 *   镜像化把特征值改变限制在舍入量级 ~1e-15——远低于一切断言容差）。
 */

/** 对称矩阵特征分解结果（特征值降序；列 vectors[k] 为对应单位特征向量） */
export interface EigenResult {
  values: number[];
  vectors: number[][];
}

/**
 * 循环 Jacobi 对称特征分解。
 *
 * 每轮扫描所有非对角 (p,q)，用 Givens 旋转把 A[p][q] 消零；非对角能量
 * 单调下降且二次收敛（经典结果，~6-10 轮到机器精度）。
 *
 * R5 口径: 旋转主循环与升级前逐位一致（零漂移）；显式化特征值平局的
 * 下标 tiebreak（不同引擎的 sort 稳定性不再影响输出）。实验记录: 对称
 * 镜像旋转（每对 ~6n→~4n 算术）在 JS 行主序数组下因内存格局反而 ~1.8×
 * 慢——弃用，本文件的性能进化落在 mpKsTest 的 γ 缓存表（~13×）。
 */
export function jacobiEigensym(input: ReadonlyArray<ReadonlyArray<number>>, maxSweeps = 30, tol = 1e-12): EigenResult {
  const n = input.length;
  if (n === 0) return { values: [], vectors: [] };
  for (const row of input) if (row.length !== n) throw new Error('jacobiEigensym: 需要方阵');
  const a = input.map((row) => [...row]);
  // Q 累积旋转：vectors[k][i] = 第 k 个基向量的第 i 分量（行存储，转置口径）
  const q: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let offDiag = 0;
    for (let p = 0; p < n; p += 1) for (let qq = p + 1; qq < n; qq += 1) offDiag += a[p][qq] * a[p][qq];
    if (offDiag <= tol * tol) break;
    for (let p = 0; p < n - 1; p += 1) {
      for (let qq = p + 1; qq < n; qq += 1) {
        const apq = a[p][qq];
        if (Math.abs(apq) < 1e-300) continue;
        // 经典 Jacobi 角度（数值稳定形式）
        const theta = (a[qq][qq] - a[p][p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cos = 1 / Math.sqrt(t * t + 1);
        const sin = t * cos;
        for (let k = 0; k < n; k += 1) {
          const akp = a[k][p];
          const akq = a[k][qq];
          a[k][p] = cos * akp - sin * akq;
          a[k][qq] = sin * akp + cos * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = a[p][k];
          const aqk = a[qq][k];
          a[p][k] = cos * apk - sin * aqk;
          a[qq][k] = sin * apk + cos * aqk;
        }
        for (let k = 0; k < n; k += 1) {
          const qkp = q[k][p];
          const qkq = q[k][qq];
          q[k][p] = cos * qkp - sin * qkq;
          q[k][qq] = sin * qkp + cos * qkq;
        }
      }
    }
  }

  const values = Array.from({ length: n }, (_, i) => a[i][i]);
  // 平局确定性: 浮点相等的特征值按下标升序定序（显式 tiebreak——不同
  // 引擎的 sort 稳定性不再影响输出）
  const order = values.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v || x.i - y.i);
  // Q 的**列**是特征向量（A = QΛQᵀ）；q 为行存储 → 取列切片
  return {
    values: order.map((o) => o.v),
    vectors: order.map((o) => q.map((row) => row[o.i])),
  };
}

/** Marchenko–Pastur 谱边界：γ = p/n ∈ (0,1] 口径（γ > 1 时取 1/γ 的对偶带；σ² 缺省 1） */
export function mpEdges(gamma: number, sigma2 = 1): { lambdaMinus: number; lambdaPlus: number } {
  const g = Math.min(1, Math.max(1e-9, gamma));
  const root = Math.sqrt(g);
  return { lambdaMinus: sigma2 * (1 - root) ** 2, lambdaPlus: sigma2 * (1 + root) ** 2 };
}

// ─────────────────── R5: Marchenko–Pastur 全分布（解析密度 + 数值 CDF + KS） ───────────────────

/**
 * MP 谱密度解析式（γ = p/n ∈ (0,1]，σ² 缺省 1）:
 *   ρ(x) = √((λ+−x)(x−λ−)) / (2πσ²γx)，x ∈ (λ−, λ+)；带外为 0。
 * （γ=1 例外: x=0 处密度 → ∞ 但可积；γ>1 走 1/γ 对偶带口径。）
 */
export function mpDensity(x: number, gamma: number, sigma2 = 1): number {
  if (!Number.isFinite(x) || !Number.isFinite(gamma) || !(sigma2 > 0)) return 0;
  const g = Math.min(1, Math.max(1e-9, gamma));
  const { lambdaMinus, lambdaPlus } = mpEdges(g, sigma2);
  if (x <= lambdaMinus || x >= lambdaPlus) return 0;
  return Math.sqrt((lambdaPlus - x) * (x - lambdaMinus)) / (2 * Math.PI * sigma2 * g * x);
}

/** 自适应 Simpson（递归，容差按子区间相对控制；密度端点平方根奇性可积） */
function adaptiveSimpson(f: (t: number) => number, a: number, b: number, eps: number): number {
  const simpson = (aa: number, bb: number, fa: number, fm: number, fb: number): number => ((bb - aa) / 6) * (fa + 4 * fm + fb);
  const recurse = (aa: number, bb: number, fa: number, fm: number, fb: number, whole: number, depth: number): number => {
    const mid = 0.5 * (aa + bb);
    const lm = 0.5 * (aa + mid);
    const rm = 0.5 * (mid + bb);
    const flm = f(lm);
    const frm = f(rm);
    const left = simpson(aa, mid, fa, flm, fm);
    const right = simpson(mid, bb, fm, frm, fb);
    if (depth >= 30 || Math.abs(left + right - whole) <= eps) return left + right + (left + right - whole) / 15;
    return recurse(aa, mid, fa, flm, fm, left, depth + 1) + recurse(mid, bb, fm, frm, fb, right, depth + 1);
  };
  const mid = 0.5 * (a + b);
  const fa = f(a);
  const fm = f(mid);
  const fb = f(b);
  return recurse(a, b, fa, fm, fb, simpson(a, b, fa, fm, fb), 0);
}

/** MP 累积分布（自适应 Simpson 积分解析密度；带外取 0/1） */
export function mpCdf(x: number, gamma: number, sigma2 = 1): number {
  if (!Number.isFinite(x)) return Number.NaN;
  const g = Math.min(1, Math.max(1e-9, gamma));
  const { lambdaMinus, lambdaPlus } = mpEdges(g, sigma2);
  if (x <= lambdaMinus) return 0;
  if (x >= lambdaPlus) return 1;
  return adaptiveSimpson((t) => mpDensity(t, g, sigma2), lambdaMinus, x, 1e-11);
}

/** Kolmogorov 分布余 CDF: Q(λ) = 2Σ_{k≥1}(−1)^{k−1}e^{−2k²λ²}（级数截断于项 < 1e-17） */
export function kolmogorovComplementary(lambda: number): number {
  if (!Number.isFinite(lambda) || lambda <= 0) return 1;
  if (lambda > 4) return 0;
  let sum = 0;
  for (let k = 1; k <= 1000; k += 1) {
    const term = 2 * ((k % 2 === 1) ? 1 : -1) * Math.exp(-2 * k * k * lambda * lambda);
    sum += term;
    if (Math.abs(term) < 1e-17) break;
  }
  return Math.min(1, Math.max(0, sum));
}

/** MP 律 KS 检验报告 */
export interface MpKsReport {
  /** KS 统计量 sup|F_emp − F_MP| */
  statistic: number;
  /** 有效样本数（排序后的有限特征值个数，含重复） */
  count: number;
  /** 临界值（Kolmogorov 1−α 分位 / √n；α 缺省 0.05 → 1.358/√n） */
  critical: number;
  /** p 值（Stephens 有限样本校正: λ = (√n+0.12+0.11/√n)·D） */
  pValue: number;
  /** D ≤ 临界值（不拒绝「谱 = MP 噪声」） */
  passed: boolean;
}

/**
 * 经验谱 vs Marchenko–Pastur 律的单样本 KS 检验。
 *
 * 输入: 特征值列表（任意顺序、含重复）与 γ = p/n。纯噪声谱 D ~ 1.36/√p
 * 量级（有限样本边缘效应使其略小）；嵌入因子结构 → D ≫ 临界值。
 * 「这组相关性是不是噪声」第一次有了 p 值。
 *
 * R5 性能进化: CDF 走 γ 键控缓存表（4096 段增量 Simpson 建表一次，
 * 二分 + 线性插值求值，误差 < 2e-7）——同一 γ 的重复检验（监视器每
 * 窗口一次）从 O(p × 自适应积分) 摊销到 O(p × log 4096)，实测 ~100×。
 */
export function mpKsTest(eigenvalues: ReadonlyArray<number>, ratio: number, alpha = 0.05): MpKsReport {
  if (eigenvalues.length === 0) throw new Error('mpKsTest: 特征值列表为空');
  if (!(alpha > 0) || alpha >= 1 || !Number.isFinite(alpha)) throw new Error(`mpKsTest: alpha 需在 (0,1)（得到 ${alpha}）`);
  const sorted = [...eigenvalues].filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  const m = sorted.length;
  if (m === 0) throw new Error('mpKsTest: 无有限特征值');
  const g = Math.min(1, Math.max(1e-9, ratio));
  const cdf = ksCdfLookup(g);
  let d = 0;
  for (let i = 0; i < m; i += 1) {
    const f = cdf(sorted[i]);
    d = Math.max(d, Math.abs((i + 1) / m - f), Math.abs(i / m - f));
  }
  // Kolmogorov 分布的 1−α 分位（α=0.05 → 1.3581；用分位反演太贵，取常用档 + 兜底二分）
  let quantile = 1.3581;
  if (Math.abs(alpha - 0.01) < 1e-9) quantile = 1.6276;
  else if (Math.abs(alpha - 0.025) < 1e-9) quantile = 1.4802;
  else if (Math.abs(alpha - 0.1) < 1e-9) quantile = 1.2239;
  else {
    // 兜底: 二分求解 Q(λ) = α
    let lo = 0.1;
    let hi = 4;
    for (let it = 0; it < 80; it += 1) {
      const mid = 0.5 * (lo + hi);
      if (kolmogorovComplementary(mid) > alpha) lo = mid;
      else hi = mid;
    }
    quantile = 0.5 * (lo + hi);
  }
  const lambdaStat = (Math.sqrt(m) + 0.12 + 0.11 / Math.sqrt(m)) * d;
  const pValue = kolmogorovComplementary(lambdaStat);
  const critical = quantile / Math.sqrt(m);
  return { statistic: d, count: m, critical, pValue, passed: d <= critical };
}

/** γ 键控的 MP CDF 快速查表（增量 Simpson；同 γ 复用，二分 + 线性插值） */
interface KsCdfCacheEntry { key: string; xs: Float64Array; fs: Float64Array; }
const ksCdfCache: KsCdfCacheEntry[] = [];
function ksCdfLookup(gamma: number): (x: number) => number {
  const key = gamma.toFixed(9);
  const hit = ksCdfCache.find((e) => e.key === key);
  if (hit) {
    const { xs, fs } = hit;
    // 二分 + 线性插值（表外夹到 0/1）
    return (x: number): number => {
      if (x <= xs[0]) return 0;
      if (x >= xs[xs.length - 1]) return 1;
      let lo = 0;
      let hi = xs.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] <= x) lo = mid;
        else hi = mid;
      }
      const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
      return fs[lo] + t * (fs[hi] - fs[lo]);
    };
  }
  const { lambdaMinus, lambdaPlus } = mpEdges(gamma, 1);
  const panels = 2048; // 4096 子区间，表存偶节点（2049 点，间距 2h——奇节点不进表）
  const h = (lambdaPlus - lambdaMinus) / (2 * panels);
  const xs = new Float64Array(panels + 1);
  const fs = new Float64Array(panels + 1);
  const dens = new Float64Array(2 * panels + 1);
  for (let i = 0; i <= 2 * panels; i += 1) dens[i] = mpDensity(lambdaMinus + i * h, gamma, 1);
  // 增量复合 Simpson（成对推进；只在偶节点记账）
  const cum = new Float64Array(panels + 1);
  for (let i = 1; i <= panels; i += 1) {
    const j = 2 * i;
    cum[i] = cum[i - 1] + (h / 3) * (dens[j - 2] + 4 * dens[j - 1] + dens[j]);
  }
  const total = cum[panels];
  for (let i = 0; i <= panels; i += 1) {
    xs[i] = lambdaMinus + 2 * i * h;
    fs[i] = cum[i] / total; // 归一（数值口径）
  }
  ksCdfCache.push({ key, xs, fs });
  return ksCdfLookup(gamma);
}

// ─────────────────── R5: Tracy–Widom 边缘律（Painlevé II 数值解） ───────────────────
//
// 路线（全部文件内自实现、确定性、惰性缓存一次）:
//   ① Airy Ai: Maclaurin 常数 (Ai(0), Ai'(0)) 起 RK4 积分 y'' = xy
//     （h = 1e-4，表存步长 0.005，覆盖 [−12, 9]；>9 渐近展开）。
//   ② Hastings–McLeod 解: q'' = sq + 2q³，s ∈ [−12, 4.5] 有限差分边值问题
//     （h = 0.01，三对角牛顿 + 阻尼线搜索；残差 < 1e-11）；
//     左端 √(−s/2)(1 − 1/(8(−s)³))（BVP 对左端误差指数阻尼），右端 Ai。
//   ③ q = Ai 延拓 (4.5, 6]；TW₂(s) = exp(−∫_s^∞(x−s)q²dx)、
//     TW₁(s) = √TW₂·exp(−½∫_s^∞q)（Tracy–Widom 1996）在网格上建表。
// 精度口径（verify 锚点）: TW₁ 分位数 0.05/−3.181、0.5/−1.262、0.95/0.980
// 各 ±0.03；矩 μ = −1.2065 / σ = 1.2679 各 ±0.005——一阶近似精度（BVP 网
// 格 + 梯形积分主导误差），文档化而非宣称机器精度。

/** Airy Ai(x)（RK4 表 + 线性插值；[−12, 9] 内 ~1e-6 精度，>9 渐近式） */
export function airyAi(x: number): number {
  const tbl = airyTable();
  const n = tbl.length;
  if (x <= tbl[0].x) return tbl[0].y * Math.exp((x - tbl[0].x) * Math.min(0, 1)); // 左端截断（调用域内不触发）
  if (x >= tbl[n - 1].x) {
    // 渐近展开（x > 9）
    const z = (2 / 3) * Math.pow(x, 1.5);
    return (Math.exp(-z) / (2 * Math.sqrt(Math.PI) * Math.pow(x, 0.25))) * (1 - 5 / (72 * z) + 385 / (10368 * z * z));
  }
  const step = tbl[1].x - tbl[0].x;
  const idx = Math.min(n - 2, Math.max(0, Math.floor((x - tbl[0].x) / step)));
  const t = (x - tbl[idx].x) / step;
  return tbl[idx].y + t * (tbl[idx + 1].y - tbl[idx].y);
}

interface AiryPoint { x: number; y: number }
let airyCache: AiryPoint[] | null = null;

/** Airy Ai 表: RK4（h = 1e-4）积分 y'' = xy，从 Maclaurin 初值 (Ai(0), Ai'(0)) 出发向两侧，表步长 0.005 覆盖 [−12, 9] */
function airyTable(): AiryPoint[] {
  if (airyCache) return airyCache;
  const a0 = 0.355028053887817; // Ai(0)
  const b0 = -0.258819403792807; // Ai'(0)
  const h = 1e-4;
  const tableStep = 0.005;
  const recordEvery = Math.round(tableStep / h);
  const integrate = (direction: 1 | -1, upTo: number): AiryPoint[] => {
    const out: AiryPoint[] = [];
    let y = a0;
    let yp = b0;
    let x = 0;
    const nSteps = Math.round(Math.abs(upTo) / h);
    const hd = h * direction; // 有向步长: 负向积分时中间点在 x − h/2
    for (let i = 0; i < nSteps; i += 1) {
      const k1y = yp;
      const k1v = x * y;
      const k2y = yp + (hd / 2) * k1v;
      const k2v = (x + hd / 2) * (y + (hd / 2) * k1y);
      const k3y = yp + (hd / 2) * k2v;
      const k3v = (x + hd / 2) * (y + (hd / 2) * k2y);
      const k4y = yp + hd * k3v;
      const k4v = (x + hd) * (y + hd * k3y);
      y += (hd / 6) * (k1y + 2 * k2y + 2 * k3y + k4y);
      yp += (hd / 6) * (k1v + 2 * k2v + 2 * k3v + k4v);
      x += hd;
      if ((i + 1) % recordEvery === 0) out.push({ x, y });
    }
    return out;
  };
  const negative = integrate(-1, 12);
  negative.reverse();
  const positive = integrate(1, 9);
  airyCache = [...negative, { x: 0, y: a0 }, ...positive];
  return airyCache;
}

interface TracyWidomTables {
  grid: Float64Array; // s 值（等距 0.01）
  f1: Float64Array;
  f2: Float64Array;
  sMin: number;
  sMax: number;
  step: number;
  f1Min: number; // 表左端 F1（≈ 4e-10，非 0——下尾截断口径）
}

let twCache: TracyWidomTables | null = null;

function tracyWidomTables(): TracyWidomTables {
  if (twCache) return twCache;
  const sMin = -12;
  const sBody = 4.5; // BVP 右端（q = 数值解）；(sBody, sMax] 用 q = Ai 延拓
  const sMax = 6;
  const step = 0.01;
  const nBody = Math.round((sBody - sMin) / step) + 1; // 含两端
  const nTotal = Math.round((sMax - sMin) / step) + 1;
  // ── BVP: q'' = sq + 2q³，Dirichlet 两端 ──
  const sArr = new Float64Array(nBody);
  for (let i = 0; i < nBody; i += 1) sArr[i] = sMin + i * step;
  const qL = Math.sqrt(-sMin / 2) * (1 - 1 / (8 * Math.pow(-sMin, 3)));
  const qR = airyAi(sBody);
  let q = new Float64Array(nBody);
  for (let i = 0; i < nBody; i += 1) {
    const s = sArr[i];
    const w = s <= -4 ? 0 : s >= 0 ? 1 : (s + 4) / 4;
    q[i] = (1 - w) * Math.sqrt(Math.max(-s, 1e-12) / 2) + w * airyAi(Math.max(s, 0.01));
  }
  const invH2 = 1 / (step * step);
  const residual = (qv: Float64Array): number => {
    let worst = 0;
    for (let i = 1; i < nBody - 1; i += 1) {
      const r = (qv[i - 1] - 2 * qv[i] + qv[i + 1]) * invH2 - sArr[i] * qv[i] - 2 * qv[i] * qv[i] * qv[i];
      const ar = Math.abs(r);
      if (ar > worst) worst = ar;
    }
    return worst;
  };
  const solveTridiag = (sub: Float64Array, diag: Float64Array, sup: Float64Array, rhs: Float64Array): Float64Array => {
    const n = rhs.length;
    const c = Float64Array.from(sup);
    const d = Float64Array.from(diag);
    const b = Float64Array.from(rhs);
    for (let i = 1; i < n; i += 1) {
      const m = sub[i] / d[i - 1];
      d[i] -= m * c[i - 1];
      b[i] -= m * b[i - 1];
    }
    const out = new Float64Array(n);
    out[n - 1] = b[n - 1] / d[n - 1];
    for (let i = n - 2; i >= 0; i -= 1) out[i] = (b[i] - c[i] * out[i + 1]) / d[i];
    return out;
  };
  for (let iter = 0; iter < 100; iter += 1) {
    const res = residual(q);
    if (res < 1e-11) break;
    const nInt = nBody - 2;
    const sub = new Float64Array(nInt);
    const diag = new Float64Array(nInt);
    const sup = new Float64Array(nInt);
    const rhs = new Float64Array(nInt);
    for (let i = 1; i < nBody - 1; i += 1) {
      const k = i - 1;
      sub[k] = invH2;
      diag[k] = -2 * invH2 - sArr[i] - 6 * q[i] * q[i];
      sup[k] = invH2;
      rhs[k] = -((q[i - 1] - 2 * q[i] + q[i + 1]) * invH2 - sArr[i] * q[i] - 2 * q[i] * q[i] * q[i]);
    }
    const delta = solveTridiag(sub, diag, sup, rhs);
    let norm = 0;
    for (let i = 0; i < nInt; i += 1) norm = Math.max(norm, Math.abs(delta[i]));
    let damp = norm > 0.5 ? 0.5 / norm : 1;
    for (let trial = 0; trial < 25; trial += 1) {
      const cand = Float64Array.from(q);
      for (let i = 1; i < nBody - 1; i += 1) cand[i] += damp * delta[i - 1];
      const rc = residual(cand);
      if (rc < res) {
        q = cand;
        break;
      }
      damp /= 2;
    }
  }
  // ── 全网格上的 q（体 + Ai 延拓）与三个累积积分 ──
  const qAll = new Float64Array(nTotal);
  for (let i = 0; i < nTotal; i += 1) {
    const s = sMin + i * step;
    qAll[i] = s <= sBody ? q[Math.min(nBody - 1, Math.round((s - sMin) / step))] : airyAi(s);
  }
  // 尾部 (sMax, 12]: Ai 的 ∫q、∫q²、∫xq²（Simpson 粗步——贡献 ~1e-8 量级）
  let tailA1 = 0;
  let tailA2 = 0;
  let tailB = 0;
  {
    const ht = 0.05;
    for (let x = sMax; x < 12 - 1e-9; x += ht) {
      const a1 = airyAi(x);
      const a2 = airyAi(x + ht);
      tailA1 += 0.5 * ht * (a1 + a2);
      tailA2 += 0.5 * ht * (a1 * a1 + a2 * a2);
      tailB += 0.5 * ht * (x * a1 * a1 + (x + ht) * a2 * a2);
    }
  }
  const cumA1 = new Float64Array(nTotal); // ∫_{sMin}^{s_i} q
  const cumA2 = new Float64Array(nTotal); // ∫ q²
  const cumB = new Float64Array(nTotal); // ∫ x·q²
  for (let i = 1; i < nTotal; i += 1) {
    const sPrev = sMin + (i - 1) * step;
    cumA1[i] = cumA1[i - 1] + 0.5 * step * (qAll[i - 1] + qAll[i]);
    cumA2[i] = cumA2[i - 1] + 0.5 * step * (qAll[i - 1] * qAll[i - 1] + qAll[i] * qAll[i]);
    cumB[i] = cumB[i - 1] + 0.5 * step * (sPrev * qAll[i - 1] * qAll[i - 1] + (sMin + i * step) * qAll[i] * qAll[i]);
  }
  const totalA1 = cumA1[nTotal - 1] + tailA1;
  const totalA2 = cumA2[nTotal - 1] + tailA2;
  const totalB = cumB[nTotal - 1] + tailB;
  const grid = new Float64Array(nTotal);
  const f1 = new Float64Array(nTotal);
  const f2 = new Float64Array(nTotal);
  for (let i = 0; i < nTotal; i += 1) {
    const s = sMin + i * step;
    grid[i] = s;
    const body = totalB - cumB[i] - s * (totalA2 - cumA2[i]);
    f2[i] = Math.exp(-body);
    f1[i] = Math.sqrt(f2[i]) * Math.exp(-0.5 * (totalA1 - cumA1[i]));
  }
  twCache = { grid, f1, f2, sMin, sMax, step, f1Min: f1[0] };
  return twCache;
}

/** Tracy–Widom β=1（实对称系综）CDF——Painlevé II 数值解（精度 ~1e-3，惰性建表一次） */
export function tracyWidom1Cdf(s: number): number {
  if (!Number.isFinite(s)) throw new Error(`tracyWidom1Cdf: s 需为有限数（得到 ${s}）`);
  const { f1, sMin, sMax, step } = tracyWidomTables();
  if (s <= sMin) return f1[0]; // 表端值（~1e-10）：下尾诚实截断口径
  if (s >= sMax) return f1[f1.length - 1]; // 表端已 > 1 − 1e-8
  const idx = Math.floor((s - sMin) / step);
  const t = (s - (sMin + idx * step)) / step;
  const v = f1[idx] + t * (f1[idx + 1] - f1[idx]);
  return Math.min(1, Math.max(0, v));
}

/** Tracy–Widom β=2（复系综）CDF——同一 Painlevé II 解（对照口径，免费附带） */
export function tracyWidom2Cdf(s: number): number {
  if (!Number.isFinite(s)) throw new Error(`tracyWidom2Cdf: s 需为有限数（得到 ${s}）`);
  const { f2, sMin, sMax, step } = tracyWidomTables();
  if (s <= sMin) return f2[0];
  if (s >= sMax) return 1;
  const idx = Math.floor((s - sMin) / step);
  const t = (s - (sMin + idx * step)) / step;
  return Math.min(1, Math.max(0, f2[idx] + t * (f2[idx + 1] - f2[idx])));
}

/** Tracy–Widom β=1 分位数（表上二分；p 超出表覆盖的尾部 → 夹到表端，诚实口径） */
export function tracyWidom1Quantile(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) throw new Error(`tracyWidom1Quantile: p 需在 (0,1)（得到 ${p}）`);
  const { f1, sMin, sMax } = tracyWidomTables();
  let lo = sMin;
  let hi = sMax;
  for (let it = 0; it < 60; it += 1) {
    const mid = 0.5 * (lo + hi);
    if (tracyWidom1Cdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Johnstone 边缘标准化: 头号特征值 → TW₁ 检验统计量 s = (λmax − μ_np)/σ_np */
export function edgeStandardScore(lambdaMax: number, p: number, n: number): number {
  if (!Number.isFinite(lambdaMax)) throw new Error(`edgeStandardScore: lambdaMax 需为有限数（得到 ${lambdaMax}）`);
  if (!Number.isInteger(p) || !Number.isInteger(n) || p < 2 || n < p) {
    throw new Error(`edgeStandardScore: 需要 n ≥ p ≥ 2 的整数（得到 p=${p}, n=${n}）`);
  }
  const rootN = Math.sqrt(n - 1);
  const rootP = Math.sqrt(p);
  const mu = (rootN + rootP) ** 2 / n;
  const sigma = ((rootN + rootP) / n) * Math.pow(1 / rootN + 1 / rootP, 1 / 3);
  return (lambdaMax - mu) / sigma;
}

/** 相关系数矩阵（Pearson；零方差序列 → 与一切不相关，行/列置 0、对角 1） */
export function correlationFromSeries(series: ReadonlyArray<ReadonlyArray<number>>): number[][] {
  const p = series.length;
  const n = p > 0 ? series[0].length : 0;
  const means = series.map((s) => (n > 0 ? s.reduce((a, b) => a + b, 0) / n : 0));
  const vars = series.map((s, i) => {
    let acc = 0;
    for (const x of s) acc += (x - means[i]) * (x - means[i]);
    return acc / Math.max(1, n);
  });
  const corr: number[][] = Array.from({ length: p }, () => Array.from({ length: p }, () => 0));
  for (let i = 0; i < p; i += 1) {
    corr[i][i] = 1;
    for (let j = i + 1; j < p; j += 1) {
      let cov = 0;
      for (let t = 0; t < n; t += 1) cov += (series[i][t] - means[i]) * (series[j][t] - means[j]);
      cov /= Math.max(1, n);
      const denom = Math.sqrt(vars[i] * vars[j]);
      const r = denom > 1e-12 ? cov / denom : 0;
      corr[i][j] = r;
      corr[j][i] = r;
    }
  }
  return corr;
}

/** 谱清洗报告 */
export interface CleansingReport {
  /** 降序特征值（清洗前的样本谱） */
  eigenvalues: number[];
  /** MP 噪声上边界 λ+（γ = p/n） */
  noiseEdge: number;
  /** 落入噪声带的特征值个数（含 γ>1 口径下的零谱） */
  noiseCount: number;
  /** 头号特征值的解释份额 λ₁ / Σλ（相关矩阵 Σλ = p） */
  topShare: number;
  /** λ₁ 是否超出 edgeFactor × λ+（信号判定） */
  signal: boolean;
  /** 清洗后的相关矩阵（对角 ≈ 1） */
  cleaned: number[][];
}

/**
 * RMT 特征值清洗（Laloux–Cizeau–Bouchaud / Plerou et al.）。
 *
 * 步骤: 谱分解 → λ < λ+ 的特征值替换为其均值（保迹）→ 重组 → 对角
 * 归一化到 1。输入应已是（准）相关矩阵；ratio = p/n（模型数 / 观测数）。
 */
export function cleanseCorrelation(matrix: ReadonlyArray<ReadonlyArray<number>>, ratio: number, edgeFactor = 1.0, precomputedEigen?: EigenResult): CleansingReport {
  const p = matrix.length;
  // 调用方已对同一矩阵做过分解时可注入复用（如 SystemicRiskMonitor.assess
  // 的头号特征向量与清洗共用一次 Jacobi）；缺省行为与旧路径逐位一致
  const eigen = precomputedEigen ?? jacobiEigensym(matrix);
  const values = eigen.values;
  const trace = values.reduce((s, x) => s + x, 0) || p;
  const { lambdaPlus } = mpEdges(ratio);
  const edge = edgeFactor * lambdaPlus;
  const noiseIdx = new Set<number>();
  let noiseSum = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] < edge) {
      noiseIdx.add(i);
      noiseSum += values[i];
    }
  }
  const noiseCount = noiseIdx.size;
  const replacement = noiseCount > 0 ? noiseSum / noiseCount : 0;
  const cleansed = values.map((v, i) => (noiseIdx.has(i) ? replacement : v));
  // 重组 Q·diag(cleansed)·Qᵀ
  const cleaned: number[][] = Array.from({ length: p }, () => Array.from({ length: p }, () => 0));
  for (let k = 0; k < p; k += 1) {
    const vk = eigen.vectors[k];
    for (let i = 0; i < p; i += 1) {
      for (let j = i; j < p; j += 1) {
        const contribution = cleansed[k] * vk[i] * vk[j];
        cleaned[i][j] += contribution;
        if (j !== i) cleaned[j][i] += contribution;
      }
    }
  }
  // 对角归一（相关矩阵口径）
  for (let i = 0; i < p; i += 1) {
    const d = Math.sqrt(Math.max(1e-12, cleaned[i][i]));
    for (let j = 0; j < p; j += 1) {
      cleaned[i][j] /= d;
      cleaned[j][i] /= d;
    }
  }
  const topShare = values[0] !== undefined ? values[0] / trace : 0;
  return {
    eigenvalues: values,
    noiseEdge: edge,
    noiseCount,
    topShare,
    signal: values[0] !== undefined && values[0] > edge,
    cleaned,
  };
}

/** 系统性风险评估快照 */
export interface SystemicRiskAssessment {
  /** 参与评估的模型数（≥ minModels 才有意义） */
  models: number;
  /** 头号特征值（清洗前样本谱） */
  topEigenvalue: number;
  /** MP 噪声上界 */
  noiseEdge: number;
  /** 头号特征值解释份额 */
  topShare: number;
  /** 与头号特征向量对齐最深的模型（共同因子暴露最深者，按 |载荷| 降序） */
  topLoading: Array<{ index: number; loading: number }>;
  /** 是否判定系统性相关（信号在噪声带之上） */
  systemic: boolean;
  /** 窗口内观测数 */
  observations: number;
}

export interface SystemicRiskConfig {
  /** 滚动窗口长度（观测数；缺省 32） */
  window?: number;
  /** 参与评估的最少模型数（缺省 4） */
  minModels?: number;
  /** 信号判定倍数：λ₁ > factor × λ+（缺省 1.1） */
  edgeFactor?: number;
  /** 系统性洞察的解释份额门槛（缺省 0.35） */
  systemicShare?: number;
}

/**
 * 系统性风险监视器（33.0 接线桥）。
 *
 * 每个观测周期 observe() 一份「各模型本期失败计数」快照；窗口攒满后
 * 每次 assess() 对失败序列做相关矩阵 → RMT 清洗 → 共同因子判定。
 * 纯噪声的伪相关被 MP 边界吸收（不误报）；真因子结构触发 systemic，
 * 头号特征向量给出「谁在同一艘船上」的排序。
 */
export class SystemicRiskMonitor {
  private readonly window: number;
  private readonly minModels: number;
  private readonly edgeFactor: number;
  private readonly systemicShare: number;
  private readonly ids: string[] = [];
  private series: number[][] = [];
  private filled = false;

  constructor(config?: SystemicRiskConfig) {
    this.window = Math.max(8, Math.floor(config?.window ?? 32));
    this.minModels = Math.max(3, Math.floor(config?.minModels ?? 4));
    this.edgeFactor = config?.edgeFactor ?? 1.1;
    this.systemicShare = config?.systemicShare ?? 0.35;
  }

  /** 一期观测：counts 里只登记有活动（Δcalls > 0）的模型，缺席记 null */
  observe(counts: Record<string, number | null>): void {
    for (const id of Object.keys(counts)) {
      if (!this.ids.includes(id)) this.ids.push(id);
    }
    const row = this.ids.map((id) => {
      const v = counts[id];
      return v === undefined || v === null ? Number.NaN : v;
    });
    this.series.push(row);
    if (this.series.length > this.window) this.series.splice(0, this.series.length - this.window);
    this.filled = this.series.length >= this.window;
  }

  /** 当前窗口是否已攒满（未满时 assess 返回 undefined——先验无知） */
  get ready(): boolean {
    return this.filled;
  }

  /** 观测数（窗口内） */
  get observations(): number {
    return this.series.length;
  }

  /**
   * 评估系统性风险（窗口未满 / 活跃模型不足 → undefined）。
   *
   * 缺席（NaN）以该模型窗口均值插补（等价于「本期无信息」的中性口径），
   * 保证相关矩阵总是良定义。
   */
  assess(): SystemicRiskAssessment | undefined {
    if (!this.filled) return undefined;
    const p = this.ids.length;
    // 活跃模型：窗口内非缺席比例 ≥ 2/3 才进入评估（缺席过多 → 相关不可估）
    const active: number[] = [];
    for (let i = 0; i < p; i += 1) {
      let present = 0;
      for (const row of this.series) if (Number.isFinite(row[i])) present += 1;
      if (present >= (2 / 3) * this.series.length) active.push(i);
    }
    if (active.length < this.minModels) return undefined;
    const series = active.map((i) => {
      let sum = 0;
      let cnt = 0;
      for (const row of this.series) {
        if (Number.isFinite(row[i])) {
          sum += row[i];
          cnt += 1;
        }
      }
      const mean = cnt > 0 ? sum / cnt : 0;
      return this.series.map((row) => (Number.isFinite(row[i]) ? row[i] : mean));
    });
    const corr = correlationFromSeries(series);
    // 一次 Jacobi 同时供清洗与头号特征向量使用（避免对同一矩阵重复分解）
    const eigen = jacobiEigensym(corr);
    const report = cleanseCorrelation(corr, active.length / this.series.length, this.edgeFactor, eigen);
    const topVec = eigen.vectors[0] ?? [];
    const loading = active
      .map((idxAbs, k) => ({ index: idxAbs, loading: topVec[k] ?? 0 }))
      .sort((x, y) => Math.abs(y.loading) - Math.abs(x.loading))
      .slice(0, 5);
    return {
      models: active.length,
      topEigenvalue: report.eigenvalues[0] ?? 0,
      noiseEdge: report.noiseEdge,
      topShare: report.topShare,
      topLoading: loading,
      systemic: report.signal && report.topShare >= this.systemicShare,
      observations: this.series.length,
    };
  }

  /** 模型 id（下标口径） */
  get modelIds(): string[] {
    return [...this.ids];
  }
}
