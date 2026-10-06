/**
 * 74.0 镜像下降内核 —— OMD：Bregman 几何下的无悔更新（熵 = Hedge / 欧氏 = PGD）
 *
 * 动机: 31.0 Hedge 的指数权重更新不是特设技巧，而是一个深刻原理的特例——
 * 镜像下降（OMD, Nemirovski–Yudin 1983）: 策略空间是分布（单纯形）时，
 * **熵镜像**与概率的乘性几何天然匹配; 同一框架换镜像立即得到 PGD。决策
 * 引擎的统计学习更新规则由此从「特设的指数权重」升级为「带正确几何的
 * 通用无悔算子」——几何适配原则: 让 Bregman 球贴合可行域的形状。
 *
 * 数学:
 *   OMD: x_{t+1} = argmin_x { ⟨g_t, x⟩ + (1/η)·D_h(x, x_t) }，其中
 *   Bregman 散度 D_h(x,y) = h(x) − h(y) − ⟨∇h(y), x − y⟩。
 *
 *   - 熵镜像 h(x) = Σ xᵢ log xᵢ（单纯形上 0·log 0 = 0）:
 *     解析解 x_{t+1,i} ∝ x_{t,i}·e^{−η·g_{t,i}}——精确退化为 31.0 的
 *     Hedge（无 Fixed-Share 回灌）; D_h = KL 散度。后悔界
 *     D_h(x*,x₁)/η + (η/2)·Σ_t range_t²（每轮中心化口径），调优
 *     η = √(2 ln n / T) → √(2T ln n)。
 *   - 欧氏镜像 h(x) = ½‖x‖²: D_h 精确退化为 ½‖x−y‖²，更新 =
 *     x_{t+1} = Π_Δ(x_t − η·g_t)（投影梯度下降 PGD）; 界
 *     D_h(x*,x₁)/η + (η/2)·Σ_t‖g̃_t‖₂²，调优后 D·G√T（单纯形 D=√2）。
 *     大梯度下欧氏步长被 G₂ 逼小、跨单纯形搬质量慢，且投影把截断质量
 *     无差别喷回全部坐标——单纯形上几何失配（验证锚点②的诚实对照）。
 *
 *   单纯形上的中心化不变性（本内核记账口径的合法性）: 对 x, x* ∈ Δ，
 *   ⟨x − x*, g_t − c·1⟩ = ⟨x − x*, g_t⟩——遗憾对每轮整体平移不变;
 *   两种镜像的更新迭代也逐位不变（熵: 归一化吸收常数; 欧氏: 单纯形投影
 *   沿 1 方向平移不变）。故记账用每轮中心化后的范数，界取到最紧的诚实口径。
 *
 *   Bregman 三点恒等式（本文件推导并文档化的方向口径）:
 *     D_h(x,y) + D_h(y,z) − D_h(x,z)
 *       = [h(x)−h(y)−⟨∇h(y),x−y⟩] + [h(y)−h(z)−⟨∇h(z),y−z⟩]
 *         − [h(x)−h(z)−⟨∇h(z),x−z⟩]
 *       = −⟨∇h(y),x−y⟩ − ⟨∇h(z),y−z⟩ + ⟨∇h(z),x−z⟩
 *       = ⟨∇h(z) − ∇h(y), x − y⟩。
 *     注: 另一口径 ⟨∇h(x)−∇h(y), z−y⟩ 仅在 h = ½‖x‖²（散度对称）时与
 *     上式重合，一般镜像（熵）下两式不等——本内核取**恒真式**并数值验证
 *     （threePointIdentityCheck，残差 < 1e-12）。
 *
 * 验证锚点（scripts/verify-online-frontier.mjs）:
 *   ① n=10 单纯形、种子化随机梯度（每步随机梯度向量）T=5000: 熵镜像
 *      后悔 ≤ 1.2×(2√(T ln n) + 8)——经验界不破定理; 且恒 ≤ 定理界
 *      （对手无关口径）; ② 同场景大梯度（±G 随机梯度 + 持久质量差，
 *      模型选型的真实口径）下 PGD 后悔 > Hedge——几何失配诚实对照;
 *   ③ 三点恒等式数值残差 < 1e-12（两种镜像）; ④ 欧氏 D_h = ½‖x−y‖²
 *      精确、熵 D_h = KL（解析锚点）; ⑤ 后悔曲线双对数斜率 ≈ 0.5
 *      （√T 形状）。
 *
 * 应用: 31.0 对抗无悔学习的几何升级——策略空间是分布（流量占比/概率
 *   混合）时熵镜像天然匹配，averageStrategy 即混合策略输出（博弈/CFR
 *   口径）; 连续箱约束参数空间则用欧氏镜像。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

/** 镜像种类（strip-types 兼容: const 对象 + 类型，不用 enum） */
export const MIRROR_KINDS = {
  /** 熵镜像 h(x) = Σ xᵢ log xᵢ——单纯形（分布）策略空间的天然几何 */
  entropic: 'entropic',
  /** 欧氏镜像 h(x) = ½‖x‖²——退化为投影梯度下降 PGD */
  euclidean: 'euclidean',
} as const;

export type MirrorKind = (typeof MIRROR_KINDS)[keyof typeof MIRROR_KINDS];

/** 单纯形域 {x ≥ 0, Σx = 1} */
export interface SimplexDomain {
  kind: 'simplex';
  /** 维度 n ≥ 1 */
  n: number;
}

export interface MirrorDescentOptions {
  mirror: MirrorKind;
  domain: SimplexDomain;
  /**
   * 序贯对手: 第 round 轮（0 起）返回梯度/损失向量 g_t（长度 n，有限数，
   * 任意符号——后悔与记账对每轮平移不变）。随机性用传入的 rand()（内核
   * 种子化 rng）——对手序列由此确定，同种子同输出。
   */
  losses: (round: number, rand: () => number) => ReadonlyArray<number>;
  /** 步长 η > 0; 缺省 optimalEta(T, n, mirror)（单位梯度量级口径） */
  eta?: number;
  /** 轮数 T ≥ 1 */
  T: number;
  /** RNG 种子（缺省 1） */
  seed?: number;
  /**
   * R5 进化: 乐观 FTRL（Optimistic Mirror Descent, Rakhlin–Sridharan 2013 /
   * Chiang et al. 2012 的 FTRL 形）。预测 m_t = g_{t−1}（梯度持续性先验），
   * 每轮先算 x_t = argmin_{x∈Δ} ⟨x, S_{t−1} + m_t⟩ + (1/η)·D_h(x, x₁)
   * （熵: softmax(−η(S+m)); 欧氏: Π_Δ(x₁ − η(S+m))）再观测 g_t。
   * 可预测流（梯度自相关）下后悔由**预测误差** ‖g_t − m_t‖ 记账（而非
   * ‖g_t‖）——常数/缓变流对数级甚至 O(1) 后悔; 不可预测流退回 √T 无悔。
   * 缺省 false——经典 OMD 路径逐位不变（零漂移）。
   */
  optimistic?: boolean;
}

export interface MirrorDescentResult {
  mirror: MirrorKind;
  n: number;
  eta: number;
  T: number;
  /** 平均策略 x̄ = (1/T)·Σ_t x_t（Σ = 1; 博弈口径的混合策略输出） */
  averageStrategy: number[];
  /** 终局策略 x_T */
  finalStrategy: number[];
  /** regretTrace[t−1] = Σ_{s≤t}⟨x_s,g_s⟩ − min_i Σ_{s≤t} g_{s,i}，t = 1..T */
  regretTrace: number[];
  /** 终局后悔 R_T */
  regret: number;
  /** 事后最优纯臂（累计损失最小，平手小下标） */
  bestArm: number;
  /**
   * 定理界（对手无关）: D_h(x*, x₁)/η + (η/2)·Σ_t（每轮中心化范数）²。
   * 熵口径用 min 平移后的 ‖·‖∞ = 每轮 range，有效性条件
   * η·gradientRangeMax ≤ 1（切线界）; 欧氏口径无条件成立（OMD 引理）。
   */
  regretBound: number;
  /** 全程观测到的最大每轮 range（max_t max_i g − min_i g; 有效性审计） */
  gradientRangeMax: number;
  /** 熵口径 η·gradientRangeMax ≤ 1 是否成立（界有效性的诚实开关） */
  boundValid: boolean;
  /** R5: 是否启用乐观 FTRL（缺省 false——经典 OMD） */
  optimistic: boolean;
  /**
   * R5: 全程最大预测误差 range（乐观口径的 max_t max_i |g_{t,i} − m_{t,i}|;
   * 非乐观路径为 0——口径标记）。
   */
  predictionRangeMax: number;
}

export interface ThreePointCheck {
  kind: MirrorKind;
  /** D_h(x,y) + D_h(y,z) − D_h(x,z) */
  lhs: number;
  /** ⟨∇h(z) − ∇h(y), x − y⟩ */
  rhs: number;
  /** |lhs − rhs|（恒等式残差） */
  residual: number;
}

// ─────────────────────────── 内部工具 ───────────────────────────

/** 文件内确定性 RNG（mulberry32）——同种子同序列 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function validateKind(kind: MirrorKind): MirrorKind {
  const known = Object.values(MIRROR_KINDS) as string[];
  if (!known.includes(kind)) {
    throw new Error(`mirrorDescent: mirror 必须是 ${known.join(' / ')}，收到 ${String(kind)}`);
  }
  return kind;
}

function validateVector(x: ReadonlyArray<number>, label: string): number[] {
  if (!Array.isArray(x) || x.length === 0) {
    throw new Error(`mirrorDescent: ${label} 必须是非空数值向量`);
  }
  const out: number[] = [];
  for (let i = 0; i < x.length; i += 1) {
    const v = x[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`mirrorDescent: ${label}[${i}] 必须是有限数，收到 ${String(v)}`);
    }
    out.push(v);
  }
  return out;
}

/**
 * 欧氏投影到单纯形 {x ≥ 0, Σx = 1}（Duchi et al. 2008 排序算法，O(n log n)）。
 *
 * R5 性能进化: 先做 O(n) 快速路径——z 已在单纯形上（z ≥ 0 且 Σz = 1，
 * 中心化梯度流下的常态: 每步 z = x − ηg 的和 = 1 − η·Σg，Σg = 0 时不变）
 * 时投影 = z 自身，**跳过排序**。可行性是投影不动点的充分条件（投影到包含
 * 点的闭凸集 = 该点本身），等价性与耗时对照见 verify-r5-online.mjs。
 */
export function projectToSimplex(z: ReadonlyArray<number>): number[] {
  let sum = 0;
  let feasible = true;
  for (let i = 0; i < z.length; i += 1) {
    const v = z[i];
    if (v < 0) {
      feasible = false;
      break;
    }
    sum += v;
  }
  if (feasible && Math.abs(sum - 1) <= 1e-12) return [...z]; // 已可行：投影不动点
  const u = [...z].sort((a, b) => b - a);
  let cumsum = 0;
  let theta = 0;
  for (let j = 0; j < u.length; j += 1) {
    cumsum += u[j];
    const tau = (cumsum - 1) / (j + 1);
    if (u[j] - tau > 0) theta = tau;
  }
  return z.map((v) => Math.max(0, v - theta));
}

/** 熵镜像步（log 域防下溢）: x_{t+1,i} ∝ x_{t,i}·e^{−η·g_i} */
function entropicStep(x: ReadonlyArray<number>, g: ReadonlyArray<number>, eta: number): number[] {
  const logw = x.map((xi, i) => (xi > 0 ? Math.log(xi) - eta * g[i] : -Infinity));
  let m = -Infinity;
  for (const lw of logw) if (lw > m) m = lw;
  if (!Number.isFinite(m)) return [...x]; // 全坐标下溢（ηG 有界时不可达）——防御性原样返回
  const w = logw.map((lw) => (lw === -Infinity ? 0 : Math.exp(lw - m)));
  let total = 0;
  for (const v of w) total += v;
  return w.map((v) => v / total);
}

/** 乐观 FTRL 的行动读出（log 域）: x_t ∝ exp(−η·(S_{t−1} + m_t)₁ᵢ)——从均匀起点累计 */
function entropicFtrlPlay(cumulative: ReadonlyArray<number>, prediction: ReadonlyArray<number>, eta: number): number[] {
  const logw = cumulative.map((s, i) => -eta * (s + prediction[i]));
  let m = -Infinity;
  for (const lw of logw) if (lw > m) m = lw;
  const w = logw.map((lw) => Math.exp(lw - m));
  let total = 0;
  for (const v of w) total += v;
  return w.map((v) => v / total);
}

// ─────────────────────────── Bregman 几何 ───────────────────────────

/**
 * 镜像势函数 h(x)。
 * entropic: h(x) = Σ xᵢ·log xᵢ（负熵，0·log 0 = 0; 要求 xᵢ ≥ 0）;
 * euclidean: h(x) = ½‖x‖²。
 */
export function mirrorPotential(kind: MirrorKind, x: ReadonlyArray<number>): number {
  validateKind(kind);
  const v = validateVector(x, `mirrorPotential 的 x`);
  if (kind === MIRROR_KINDS.entropic) {
    let h = 0;
    for (const xi of v) {
      if (xi < 0) throw new Error(`mirrorPotential: 熵镜像要求 xᵢ ≥ 0，收到 ${xi}`);
      if (xi > 0) h += xi * Math.log(xi);
    }
    return h;
  }
  let s = 0;
  for (const xi of v) s += xi * xi;
  return 0.5 * s;
}

/** ∇h: entropic → 1 + log xᵢ（要求 xᵢ > 0）; euclidean → x 本身 */
export function mirrorGradient(kind: MirrorKind, x: ReadonlyArray<number>): number[] {
  validateKind(kind);
  const v = validateVector(x, `mirrorGradient 的 x`);
  if (kind === MIRROR_KINDS.entropic) {
    return v.map((xi, i) => {
      if (xi <= 0) throw new Error(`mirrorGradient: 熵镜像梯度要求 x[${i}] > 0，收到 ${xi}`);
      return 1 + Math.log(xi);
    });
  }
  return [...v];
}

/**
 * Bregman 散度 D_h(x,y) = h(x) − h(y) − ⟨∇h(y), x − y⟩。
 * - entropic: KL(x‖y) = Σ xᵢ·log(xᵢ/yᵢ)（xᵢ = 0 项记 0; yᵢ = 0 且 xᵢ > 0
 *   时发散为 Infinity——支撑必须包含）;
 * - euclidean: 精确 ½‖x − y‖²。
 */
export function bregmanDivergence(kind: MirrorKind, x: ReadonlyArray<number>, y: ReadonlyArray<number>): number {
  validateKind(kind);
  const xv = validateVector(x, `bregmanDivergence 的 x`);
  const yv = validateVector(y, `bregmanDivergence 的 y`);
  if (xv.length !== yv.length) {
    throw new Error(`bregmanDivergence: x 与 y 维度须一致（${xv.length} vs ${yv.length}）`);
  }
  if (kind === MIRROR_KINDS.entropic) {
    let d = 0;
    for (let i = 0; i < xv.length; i += 1) {
      const xi = xv[i];
      const yi = yv[i];
      if (xi < 0) throw new Error(`bregmanDivergence: 熵镜像要求 xᵢ ≥ 0，收到 x[${i}] = ${xi}`);
      if (yi <= 0) {
        if (xi > 0) return Infinity; // 支撑不包含: 无穷远
        continue; // 0·log(0/0) → 0
      }
      if (xi > 0) d += xi * (Math.log(xi) - Math.log(yi));
    }
    return d;
  }
  let s = 0;
  for (let i = 0; i < xv.length; i += 1) s += (xv[i] - yv[i]) * (xv[i] - yv[i]);
  return 0.5 * s;
}

/**
 * 三点恒等式数值验证: D_h(x,y) + D_h(y,z) − D_h(x,z) = ⟨∇h(z) − ∇h(y), x − y⟩
 * （推导见文件头; 对称散度 h = ½‖x‖² 时与 ⟨∇h(x)−∇h(y), z−y⟩ 口径重合，
 * 一般镜像取恒真式）。熵镜像要求 y, z 严格正（梯度取 log）。
 */
export function threePointIdentityCheck(
  kind: MirrorKind,
  x: ReadonlyArray<number>,
  y: ReadonlyArray<number>,
  z: ReadonlyArray<number>,
): ThreePointCheck {
  validateKind(kind);
  const xv = validateVector(x, `threePointIdentityCheck 的 x`);
  const yv = validateVector(y, `threePointIdentityCheck 的 y`);
  const zv = validateVector(z, `threePointIdentityCheck 的 z`);
  if (xv.length !== yv.length || xv.length !== zv.length) {
    throw new Error(`threePointIdentityCheck: x/y/z 维度须一致（${xv.length}/${yv.length}/${zv.length}）`);
  }
  const lhs = bregmanDivergence(kind, xv, yv) + bregmanDivergence(kind, yv, zv) - bregmanDivergence(kind, xv, zv);
  const gz = mirrorGradient(kind, zv);
  const gy = mirrorGradient(kind, yv);
  let rhs = 0;
  for (let i = 0; i < xv.length; i += 1) rhs += (gz[i] - gy[i]) * (xv[i] - yv[i]);
  return { kind, lhs, rhs, residual: Math.abs(lhs - rhs) };
}

// ─────────────────────────── 主算法 ───────────────────────────

/**
 * 镜像下降 OMD 主循环（纯函数: 同 options 同输出）。
 *
 * 每轮: 记账（算法损失/累计对手损失/后悔曲线/界用中心化范数）→ 镜像步
 * （熵: 乘性指数权重; 欧氏: 加性投影梯度）。x_t 是**本轮实际行动**，先
 * 记账后更新。返回定理界与有效性审计字段（boundValid）。
 */
export function mirrorDescent(options: MirrorDescentOptions): MirrorDescentResult {
  const mirror = validateKind(options.mirror);
  if (!options.domain || options.domain.kind !== 'simplex') {
    throw new Error(`mirrorDescent: domain 目前只支持 { kind: 'simplex', n }，收到 ${String(options.domain?.kind)}`);
  }
  const n = options.domain.n;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1 || Math.floor(n) !== n) {
    throw new Error(`mirrorDescent: domain.n 必须是正整数，收到 ${String(n)}`);
  }
  const T = options.T;
  if (typeof T !== 'number' || !Number.isFinite(T) || T < 1 || Math.floor(T) !== T) {
    throw new Error(`mirrorDescent: T 必须是正整数，收到 ${String(T)}`);
  }
  const eta = options.eta ?? optimalEta(T, n, mirror);
  if (typeof eta !== 'number' || !Number.isFinite(eta) || eta <= 0) {
    throw new Error(`mirrorDescent: eta 必须为正有限数，收到 ${String(options.eta)}`);
  }
  if (typeof options.losses !== 'function') {
    throw new Error(`mirrorDescent: losses 必须是 (round, rand) => number[] 的序贯函数`);
  }
  const rng = mulberry32(options.seed ?? 1);
  const optimistic = options.optimistic ?? false;
  let x = new Array<number>(n).fill(1 / n);
  const x0 = [...x];
  const cumulative = new Array<number>(n).fill(0);
  const average = new Array<number>(n).fill(0);
  const regretTrace: number[] = [];
  let algorithmLoss = 0;
  let sumRangeSquared = 0; // Σ_t (每轮 range_t)² —— 熵界口径（min 平移后 ‖·‖∞）
  let sumCenteredSquared = 0; // Σ_t ‖g_t − mean_t·1‖₂² —— 欧氏界口径
  let rangeMax = 0;
  // ── 乐观 FTRL 状态（optimistic=false 时零介入）──
  const gradSum = new Array<number>(n).fill(0); // S_{t−1} = Σ_{s<t} g_s
  const prediction = new Array<number>(n).fill(0); // m_t = g_{t−1}（m_1 = 0）
  let sumDiffRangeSquared = 0; // Σ_t range(g_t − m_t)² —— 乐观界口径
  let sumDiffCenteredSquared = 0; // Σ_t ‖(g_t − m_t) − mean‖² —— 欧氏乐观界口径
  let predRangeMax = 0;
  for (let t = 0; t < T; t += 1) {
    if (optimistic) {
      // 先出招: x_t = argmin_{x∈Δ} ⟨x, S_{t−1} + m_t⟩ + (1/η)·D_h(x, x₁)
      x =
        mirror === MIRROR_KINDS.entropic
          ? entropicFtrlPlay(gradSum, prediction, eta)
          : projectToSimplex(x0.map((xi, i) => xi - eta * (gradSum[i] + prediction[i])));
    }
    const g = options.losses(t, rng);
    if (!Array.isArray(g) || g.length !== n) {
      throw new Error(`mirrorDescent: losses 第 ${t} 轮应返回 ${n} 维向量，收到长度 ${g === null || g === undefined ? String(g) : g.length}`);
    }
    let lo = Infinity;
    let hi = -Infinity;
    let mean = 0;
    for (let i = 0; i < n; i += 1) {
      const gi = g[i];
      if (typeof gi !== 'number' || !Number.isFinite(gi)) {
        throw new Error(`mirrorDescent: losses 第 ${t} 轮 g[${i}] 必须是有限数，收到 ${String(gi)}`);
      }
      if (gi < lo) lo = gi;
      if (gi > hi) hi = gi;
      mean += gi / n;
    }
    const range = hi - lo;
    sumRangeSquared += range * range;
    if (range > rangeMax) rangeMax = range;
    let centered = 0;
    for (let i = 0; i < n; i += 1) centered += (g[i] - mean) * (g[i] - mean);
    sumCenteredSquared += centered;
    if (optimistic) {
      // 预测误差记账: d_t = g_t − m_t（乐观口径的「有效梯度」）
      let dLo = Infinity;
      let dHi = -Infinity;
      let dMean = 0;
      for (let i = 0; i < n; i += 1) {
        const d = g[i] - prediction[i];
        if (d < dLo) dLo = d;
        if (d > dHi) dHi = d;
        dMean += d / n;
      }
      const dRange = dHi - dLo;
      sumDiffRangeSquared += dRange * dRange;
      if (dRange > predRangeMax) predRangeMax = dRange;
      let dCentered = 0;
      for (let i = 0; i < n; i += 1) dCentered += (g[i] - prediction[i] - dMean) * (g[i] - prediction[i] - dMean);
      sumDiffCenteredSquared += dCentered;
    }
    // 记账: x_t 是本轮实际行动（更新之前）
    for (let i = 0; i < n; i += 1) {
      algorithmLoss += x[i] * g[i];
      cumulative[i] += g[i];
      average[i] += x[i] / T;
    }
    let best = 0;
    for (let i = 1; i < n; i += 1) if (cumulative[i] < cumulative[best]) best = i;
    regretTrace.push(algorithmLoss - cumulative[best]);
    // 更新
    if (optimistic) {
      // S_t = S_{t−1} + g_t; m_{t+1} = g_t（FTRL 累计 + 预测滚动）
      for (let i = 0; i < n; i += 1) {
        gradSum[i] += g[i];
        prediction[i] = g[i];
      }
    } else {
      // 镜像步: x_{t+1} = argmin_{x∈Δ} ⟨g_t, x⟩ + (1/η)·D_h(x, x_t)
      x =
        mirror === MIRROR_KINDS.entropic
          ? entropicStep(x, g as number[], eta)
          : projectToSimplex(x.map((xi, i) => xi - eta * g[i]));
    }
  }
  let bestArm = 0;
  for (let i = 1; i < n; i += 1) if (cumulative[i] < cumulative[bestArm]) bestArm = i;
  const star = new Array<number>(n).fill(0);
  star[bestArm] = 1;
  const dStart = bregmanDivergence(mirror, star, x0);
  const entropyPenalty = optimistic ? eta * sumDiffRangeSquared : (eta / 2) * sumRangeSquared;
  const euclidPenalty = optimistic ? eta * sumDiffCenteredSquared : (eta / 2) * sumCenteredSquared;
  const penalty = mirror === MIRROR_KINDS.entropic ? entropyPenalty : euclidPenalty;
  const regretBound = dStart / eta + penalty;
  return {
    mirror,
    n,
    eta,
    T,
    averageStrategy: average,
    finalStrategy: [...x],
    regretTrace,
    regret: regretTrace.length > 0 ? regretTrace[regretTrace.length - 1] : 0,
    bestArm,
    regretBound,
    gradientRangeMax: rangeMax,
    boundValid:
      mirror === MIRROR_KINDS.euclidean
        ? true
        : optimistic
          ? eta * (rangeMax + predRangeMax) <= 1
          : eta * rangeMax <= 1,
    optimistic,
    predictionRangeMax: optimistic ? predRangeMax : 0,
  };
}

// ─────────────────────────── 理论界与调优 ───────────────────────────

/**
 * 视界 T 已知时的最优步长（单位梯度范数 G = 1 口径; 大梯度按 1/G 缩放）:
 * - entropic: η = √(2·ln n / T)/G（‖·‖∞ 口径，熵镜像是 1-强凸于 ℓ₁）;
 * - euclidean: η = D/(G·√T) = √2/(G·√T)（单纯形直径 D = √2，‖·‖₂ 口径）。
 */
export function optimalEta(T: number, n: number, mirror: MirrorKind = MIRROR_KINDS.entropic, gradientNorm = 1): number {
  validateKind(mirror);
  if (typeof T !== 'number' || !Number.isFinite(T) || T < 1) {
    throw new Error(`optimalEta: T 必须 ≥ 1，收到 ${String(T)}`);
  }
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) {
    throw new Error(`optimalEta: n 必须 ≥ 1，收到 ${String(n)}`);
  }
  if (typeof gradientNorm !== 'number' || !Number.isFinite(gradientNorm) || gradientNorm <= 0) {
    throw new Error(`optimalEta: gradientNorm 必须为正，收到 ${String(gradientNorm)}`);
  }
  if (mirror === MIRROR_KINDS.entropic) return Math.sqrt((2 * Math.log(Math.max(2, n))) / T) / gradientNorm;
  return Math.SQRT2 / (gradientNorm * Math.sqrt(T));
}

/**
 * 调优 η 下的经典后悔界（对手无关，G = 1 归一化口径; 与 31.0
 * staticRegretBound 同族）:
 * - entropic: √(2·T·ln n)（= ln n/η + ηT/2 在 η = √(2 ln n/T) 处的值）;
 * - euclidean: D·G·√T = √(2T)（单纯形 D = √2）。
 */
export function regretBound(T: number, n: number, mirror: MirrorKind = MIRROR_KINDS.entropic): number {
  validateKind(mirror);
  if (typeof T !== 'number' || !Number.isFinite(T) || T < 1) {
    throw new Error(`regretBound: T 必须 ≥ 1，收到 ${String(T)}`);
  }
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) {
    throw new Error(`regretBound: n 必须 ≥ 1，收到 ${String(n)}`);
  }
  if (mirror === MIRROR_KINDS.entropic) return Math.sqrt(2 * T * Math.log(Math.max(1, n)));
  return Math.sqrt(2 * T);
}

// ─────────────────── 74.0 调度接线建议（挂载侧的语义桥） ───────────────────
// 1. 31.0 升级路径: Hedge.update 的指数权重更新 = 本内核熵镜像的解析解
//    （x_{t+1,i} ∝ x_{t,i}·e^{−ηg_i}）; 31.0 的 Fixed-Share（α 回灌）可在
//    调用侧对 averageStrategy/finalStrategy 做正则混合实现。本内核不吞
//    并 31.0——两者并存，31.0 继续负责记账口径（部分反馈/跟踪遗憾），
//    74.0 提供几何正确的更新算子与 Bregman 工具箱。
// 2. 镜像选择（几何适配原则）: 策略空间是分布（多模型流量占比/概率混合）
//    → 'entropic'; 策略空间是带箱约束的连续参数（温度/阈值/权重向量）
//    → 'euclidean'。判据: Bregman 球的等值面是否贴合可行域边界。
// 3. η 调优: optimalEta(T, n, mirror, G)，G 取梯度量级（range 或 ‖·‖₂）;
//    未知视界参照 31.0 timeVaryingEta 的 √(ln n/t) 时间变步长口径。
// 4. regretTrace 是学习健康的实时仪表: 双对数斜率持续 > 0.5 说明对手
//    压制有效或特征失配 → 触发 31.0 的 Fixed-Share/切换升级; averageStrategy
//    直接作为下游路由器的混合策略输入（CFR/博弈口径的自收敛保证）。
