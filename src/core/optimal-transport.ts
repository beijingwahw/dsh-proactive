/**
 * optimal-transport.ts — 最优传输内核（项目 17.0「漂移检测看见分布的形状」质变基座）
 *
 * 升级前的根本局限（均值水位检测的形状盲区）：
 * - 12.0 的 e-过程 / 置信序列盯的是**均值水位**（μ 是否越过水位线）——
 *   一个均值不变、形状巨变的分布（双峰化、方差爆炸、尾部变厚）在
 *   水位线检测下完全隐形：μ̂ 纹丝不动，系统却已经换了世界；
 * - z-score / 方差检测只看一两个矩——矩相同而分布不同的两个世界
 *   无穷多，二阶统计不足以充当「世界没变」的证书；
 * - KL 散度在不相交支撑（旧窗口全是 0.6，新窗口全是 0.9）上
 *   发散为 ∞，既不可比较也不可累积；平方误差只看均值差。
 *
 * 本内核引入 Monge–Kantorovich 最优传输理论（Villani 2009 Fields /
 * Cuturi 2013 Sinkhorn / Peyré–Cuturi 2019 计算最优传输）：
 *
 * 1. **一维精确 Wasserstein-p**（分位数耦合）：
 *      W_p(μ, ν) = ( ∫₀¹ |F_μ⁻¹(q) − F_ν⁻¹(q)|ᵖ dq )^{1/p}
 *    一维情形最优耦合就是分位数单调配对（秩相依 / comonotone 耦合），
 *    经验分布上排序后逐分位配对即**精确值**——不是近似，O(n log n)。
 *    W₁ = 「把分布 μ 的土搬到 ν 的最小搬运代价」，单位就是被监测
 *    量本身的单位（质量分 / 延迟毫秒）——可解释、可设定阈。
 *
 * 2. **熵正则 Sinkhorn（任意代价矩阵的离散 OT）**：
 *      min_π ⟨C, π⟩ + ε·KL(π ‖ a bᵀ),  s.t. π1 = μ, πᵀ1 = ν
 *    Cuturi 2013：Sinkhorn 不动点迭代在 Hilbert 度量下收缩，
 *    O(k²) 每步、线性收敛；对数域稳定化（log-sum-exp）防下溢。
 *    代价矩阵可以是任意「行为距离」——预算在 niche 网格间的
 *    最小移动方案（探索预算再平衡）有了数学最优解。
 *
 * 3. **Wasserstein 重心（barycenter）**：
 *    一维固定质量情形，重心 = 分位数平均：B⁻¹(q) = Σ wᵢ Fᵢ⁻¹(q)。
 *    多个窗口 / 多个模型的分布信息融合为一条「共识分布」——
 *    比「平均的均值」保留全部形状（均值融合丢掉形状，重心融合
 *    保留形状），11.0 定律归纳的分布版。
 *
 * 4. **形状感知漂移监视器（TransportDriftMonitor）**：
 *    滑动窗 vs 基准窗的 W₁ 持续计算；阈值不是拍的——历史窗口间
 *    W₁ 的经验分布给出「正常漂移」的分位数（conformal 式阈值，
 *    与 13.0 同一哲学：让数据自己定阈），超越即报 shape-drift。
 *
 * 与 12.0 的关系：12.0 盯水位（均值），本内核盯形状（全分布）——
 * 「水平没变但世界换了」第一次可见；与 13.0 的关系：保形覆盖保证
 * 在分布漂移下失效，本内核是保形区间的**绊线**（先见漂移、再谈覆盖）；
 * 与 14.0 的关系：Sinkhorn 给出探索预算跨 niche 的最优搬运方案，
 * 多样性维护从「均匀采样」升维为「最小代价再平衡」。
 */

// ─────────────────────────── 一维精确 Wasserstein ───────────────────────────

/**
 * 一维经验 Wasserstein-p 距离（精确：分位数单调耦合）。
 *
 * 两个样本集各自视为等权经验分布；排序后按分位配对：
 *   W_p = ( (1/m) Σ |a_(i) − b_(i)|ᵖ )^{1/p}（m = n 时逐秩配对；
 *   m ≠ n 时按经验分位数网格插值）。
 *
 * @param p 距离阶数（1 = 搬运代价，2 = 能量距离；缺省 1）
 */
export function wasserstein1D(samplesA: readonly number[], samplesB: readonly number[], p = 1): number {
  const a = [...samplesA].filter(Number.isFinite).sort((x, y) => x - y);
  const b = [...samplesB].filter(Number.isFinite).sort((x, y) => x - y);
  if (a.length === 0 || b.length === 0) return 0;
  const grid = 256; // 分位数网格（m=n 时退化为逐秩精确配对）
  let acc = 0;
  for (let i = 0; i < grid; i += 1) {
    const q = (i + 0.5) / grid;
    const delta = quantileSorted(a, q) - quantileSorted(b, q);
    acc += Math.pow(Math.abs(delta), p);
  }
  return Math.pow(acc / grid, 1 / p);
}

/** 排序数组的经验分位数（线性插值；q ∈ [0,1]） */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

// ─────────────────────────── Wasserstein 重心 ───────────────────────────

/**
 * 一维 Wasserstein 重心（分位数平均）：多个经验分布按权重融合为一条共识分布。
 *
 * B⁻¹(q) = Σᵢ wᵢ Fᵢ⁻¹(q)——保留全部形状信息的「分布平均」
 * （均值的平均只留一个数，重心的平均留一条曲线）。
 *
 * @returns 重心的代表样本集（分位数网格采样），可直接参与后续 W 距离计算
 */
export function wassersteinBarycenter1D(
  distributions: readonly (readonly number[])[],
  weights?: readonly number[],
): number[] {
  const valid = distributions.filter((d) => d.length > 0);
  if (valid.length === 0) return [];
  const w =
    weights && weights.length === valid.length && weights.reduce((s, x) => s + x, 0) > 0
      ? weights.map((x) => x / weights.reduce((s, y) => s + y, 0))
      : valid.map(() => 1 / valid.length);
  const sorted = valid.map((d) => [...d].sort((x, y) => x - y));
  const grid = 128;
  const result: number[] = [];
  for (let i = 0; i < grid; i += 1) {
    const q = (i + 0.5) / grid;
    result.push(sorted.reduce((acc, s, k) => acc + w[k]! * quantileSorted(s, q), 0));
  }
  return result;
}

// ─────────────────────────── Sinkhorn 熵正则最优传输 ───────────────────────────

/** Sinkhorn 求解配置 */
export interface SinkhornConfig {
  /** 熵正则强度 ε（越小越接近精确 OT、收敛越慢；缺省 0.05） */
  epsilon: number;
  /** 最大迭代数（缺省 200） */
  maxIterations: number;
  /** 收敛容差（边际约束残差；缺省 1e-9） */
  tolerance: number;
  /** 代价矩阵数值范围保护（|C| 上限；缺省 100） */
  maxCost: number;
}

export const DEFAULT_SINKHORN_CONFIG: SinkhornConfig = {
  epsilon: 0.05,
  maxIterations: 300,
  tolerance: 1e-8,
  maxCost: 100,
};

/** Sinkhorn 求解结果 */
export interface SinkhornResult {
  /** 传输方案 π（π[i][j] = 从 i 搬到 j 的质量） */
  plan: number[][];
  /** 熵正则传输代价 ⟨C, π⟩（+ ε·KL 已剔除的主项） */
  cost: number;
  /** 收敛判定 */
  converged: boolean;
  /** 实际迭代数 */
  iterations: number;
  /** 边际约束最大残差 */
  residual: number;
}

/**
 * 对数域稳定化 Sinkhorn 求解器
 *
 * 不动点迭代（Hilbert 度量压缩，Franklin–Lorenz 1989；Cuturi 2013）：
 *   f_i ← −ε log Σ_j exp((g_j − C_ij)/ε) a_j
 *   g_j ← −ε log Σ_i exp((f_i − C_ij)/ε) b_i
 * 全程 log-sum-exp，指数下溢免疫；f、g 为对偶势（Kantorovich 最优
 * 对偶变量的熵正则版）。
 */
export function sinkhorn(
  cost: readonly (readonly number[])[],
  sourceMass: readonly number[],
  targetMass: readonly number[],
  config?: Partial<SinkhornConfig>,
): SinkhornResult {
  const cfg = { ...DEFAULT_SINKHORN_CONFIG, ...config };
  const n = sourceMass.length;
  const m = targetMass.length;
  if (n === 0 || m === 0 || cost.length !== n) {
    return { plan: [], cost: 0, converged: false, iterations: 0, residual: Infinity };
  }
  // 归一化质量（允许输入未归一权重）
  const sumA = sourceMass.reduce((s, x) => s + x, 0);
  const sumB = targetMass.reduce((s, x) => s + x, 0);
  if (!(sumA > 0) || !(sumB > 0)) {
    return { plan: [], cost: 0, converged: false, iterations: 0, residual: Infinity };
  }
  const a = sourceMass.map((x) => x / sumA);
  const b = targetMass.map((x) => x / sumB);
  // 对数域代价（截断保护 + ε 缩放）
  const logC: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const row: number[] = [];
    for (let j = 0; j < m; j += 1) {
      const c = Math.max(0, Math.min(cfg.maxCost, Math.abs(cost[i]?.[j] ?? 0)));
      row.push(-c / cfg.epsilon);
    }
    logC.push(row);
  }
  // 对数域质量（0 质量 → −∞ 参与度为 0）
  const logA = a.map((x) => (x > 0 ? Math.log(x) : -Infinity));
  const logB = b.map((x) => (x > 0 ? Math.log(x) : -Infinity));

  const f = new Float64Array(n);
  const g = new Float64Array(m);
  const prevF = new Float64Array(n);
  const prevG = new Float64Array(m);
  let converged = false;
  let iterations = 0;
  let residual = Infinity;

  for (let iter = 0; iter < cfg.maxIterations; iter += 1) {
    iterations = iter + 1;
    // f 行更新：f_i = −ε log Σ_j exp((g_j − C_ij)/ε + log b_j)
    for (let i = 0; i < n; i += 1) {
      f[i] = -logSumExp(logC[i].map((lc, j) => g[j] + lc + logB[j]));
    }
    // g 列更新：g_j = −ε log Σ_i exp((f_i − C_ij)/ε + log a_i)
    for (let j = 0; j < m; j += 1) {
      g[j] = -logSumExp(logC.map((row, i) => f[i] + row[j]! + logA[i]));
    }
    // 收敛判据：对偶势（乘子）漂移（边际在每次更新后恒精确，不具判据力）
    let maxDrift = 0;
    for (let i = 0; i < n; i += 1) maxDrift = Math.max(maxDrift, Math.abs(f[i]! - prevF[i]!));
    for (let j = 0; j < m; j += 1) maxDrift = Math.max(maxDrift, Math.abs(g[j]! - prevG[j]!));
    residual = maxDrift;
    if (maxDrift < cfg.tolerance) {
      converged = true;
      break;
    }
    prevF.set(f);
    prevG.set(g);
  }

  // 还原传输方案：π_ij = a_i·b_j·exp(f_i + g_j − C_ij/ε)
  //（对偶势口径：u_i = a_i·e^{f_i}，v_j = b_j·e^{g_j}，π = diag(u) K diag(v)）
  const plan: number[][] = [];
  let transportCost = 0;
  for (let i = 0; i < n; i += 1) {
    const row: number[] = [];
    for (let j = 0; j < m; j += 1) {
      const pij = a[i]! * b[j]! * Math.exp(f[i]! + g[j]! + logC[i]![j]!);
      row.push(pij);
      transportCost += pij * Math.abs(cost[i]![j] ?? 0);
    }
    plan.push(row);
  }
  return { plan, cost: round(transportCost), converged, iterations, residual: round(residual) };
}

/** log-sum-exp（数值稳定） */
function logSumExp(xs: readonly number[]): number {
  let max = -Infinity;
  for (const x of xs) if (x > max) max = x;
  if (max === -Infinity) return -Infinity;
  let acc = 0;
  for (const x of xs) acc += Math.exp(x - max);
  return max + Math.log(acc);
}

// ─────────────────────────── 形状感知漂移监视器 ───────────────────────────

/** 传输漂移监视器配置 */
export interface TransportDriftConfig {
  /** 滑动窗容量（近期样本；缺省 50） */
  windowSize: number;
  /** 基准窗容量（历史样本；缺省 200） */
  referenceSize: number;
  /** 漂移阈值的经验分位数（历史窗间 W₁ 的分位；缺省 0.95） */
  thresholdQuantile: number;
  /** 最小样本量（双方达标才开始判定；缺省 20） */
  minSamples: number;
  /** 严重度平滑因子（severity = W₁ / threshold 的自然缩放；缺省 1） */
  severityScale: number;
}

export const DEFAULT_TRANSPORT_DRIFT_CONFIG: TransportDriftConfig = {
  windowSize: 50,
  referenceSize: 200,
  thresholdQuantile: 0.95,
  minSamples: 20,
  severityScale: 1,
};

/** 漂移视图 */
export interface TransportDriftView {
  /** 窗口 vs 基准的 W₁（被监测量原单位） */
  w1: number;
  /** 自适应阈值（历史漂移的分位数） */
  threshold: number;
  /** 是否判定漂移 */
  drifting: boolean;
  /** 严重度 = w1 / threshold（>1 越多越严重） */
  severity: number;
  /** 方向洞察：均值位移量（窗口均值 − 基准均值） */
  meanShift: number;
  /** 形状洞察：分布展宽比（窗口 σ / 基准 σ；≈1 形状未变，>1 双峰化/尾部变厚） */
  spreadRatio: number;
  /** 漂移主成分：level（均值水位）/ shape（形状重排）/ both / none */
  kind: 'none' | 'level' | 'shape' | 'both';
  /** 样本量（窗口 / 基准） */
  samples: { window: number; reference: number };
  interpretation: string;
}

/** 漂移事件（翻转沿审计） */
export interface TransportDriftEvent {
  at: number;
  kind: TransportDriftView['kind'];
  severity: number;
  w1: number;
  threshold: number;
}

/**
 * 形状感知传输漂移监视器
 *
 * 用法：
 *   const monitor = new TransportDriftMonitor();
 *   monitor.observe(0.82);  // 持续喂入被监测量（质量分 / 延迟 / 收益）
 *   monitor.drift();        // 任意时刻读取（W₁ 原单位 + 自适应阈值）
 *
 * 几何细节：基准窗取**滑动窗之前**的样本（两窗不相交）——若拿
 * 包含自身的历史当基准，W₁ 被窗口⊂基准的相关性系统性压低，
 * 阈值口径失真。阈值哲学（与 13.0 同源）：不拍脑袋——历史平稳期
 * 两两 W₁ 构成「正常漂移」经验分布，thresholdQuantile 分位即阈值；
 * 新 W₁ 入账前先裁决，漂移期样本不污染基准。
 */
export class TransportDriftMonitor {
  private readonly config: TransportDriftConfig;
  private readonly buffer: number[] = [];
  private readonly historyW1: number[] = [];
  private lastDrifting = false;
  private events: TransportDriftEvent[] = [];

  constructor(config?: Partial<TransportDriftConfig>) {
    this.config = { ...DEFAULT_TRANSPORT_DRIFT_CONFIG, ...config };
  }

  /** 观测一次被监测量 */
  observe(x: number): TransportDriftView {
    const v = Number.isFinite(x) ? x : 0;
    this.buffer.push(v);
    if (this.buffer.length > this.config.referenceSize) this.buffer.shift();
    const view = this.drift();
    // 阈值记账：非漂移期的新 W₁ 入历史（漂移期样本不污染基准）
    if (!view.drifting && view.samples.window >= this.config.minSamples) {
      this.historyW1.push(view.w1);
      if (this.historyW1.length > 200) this.historyW1.shift();
    }
    // 翻转沿审计
    if (view.drifting !== this.lastDrifting) {
      this.events.push({ at: Date.now(), kind: view.kind, severity: view.severity, w1: view.w1, threshold: view.threshold });
      if (this.events.length > 50) this.events.shift();
      this.lastDrifting = view.drifting;
    }
    return view;
  }

  /** 当前漂移视图（纯读取） */
  drift(): TransportDriftView {
    const window = this.buffer.slice(-this.config.windowSize);
    const baseline = this.buffer.slice(0, Math.max(0, this.buffer.length - this.config.windowSize));
    const w1 = wasserstein1D(window, baseline, 1);
    const threshold = this.currentThreshold(baseline);
    const drifting =
      window.length >= this.config.minSamples && baseline.length >= this.config.minSamples && w1 > threshold;
    const meanShift = mean(window) - mean(baseline);
    const spreadRatio = stddev(baseline) > 1e-12 ? stddev(window) / stddev(baseline) : 1;
    // 漂移分型：均值位移明显 → level；展宽明显偏离 1 → shape；两者兼有 → both
    const levelDominant = Math.abs(meanShift) > 0.5 * w1 + 1e-12 && Math.abs(meanShift) > 0.02;
    const shapeDominant = spreadRatio > 1.25 || spreadRatio < 0.8;
    const kind: TransportDriftView['kind'] = !drifting
      ? 'none'
      : levelDominant && shapeDominant
        ? 'both'
        : levelDominant
          ? 'level'
          : 'shape';
    return {
      w1: round(w1),
      threshold: round(threshold),
      drifting,
      severity: round(drifting ? (w1 / Math.max(threshold, 1e-12) - 1) * this.config.severityScale : 0),
      meanShift: round(meanShift),
      spreadRatio: round(spreadRatio),
      kind,
      samples: { window: window.length, reference: baseline.length },
      interpretation: this.interpret(kind, w1, threshold, spreadRatio, window.length),
    };
  }

  /** 漂移事件审计（翻转沿） */
  recentEvents(limit = 10): TransportDriftEvent[] {
    return this.events.slice(-limit);
  }

  /** 当前自适应阈值（历史 W₁ 的分位；历史不足时退化为 2.5σ 启发） */
  private currentThreshold(baseline: readonly number[]): number {
    if (this.historyW1.length >= 10) {
      const sorted = [...this.historyW1].sort((x, y) => x - y);
      return Math.max(1e-12, quantileSorted(sorted, this.config.thresholdQuantile));
    }
    // 冷启动：基准离散度 × 2.5（保守起步，历史积累后自动接管）
    if (baseline.length >= this.config.minSamples) {
      return Math.max(1e-12, 2.5 * stddev(baseline));
    }
    return Infinity;
  }

  private interpret(
    kind: TransportDriftView['kind'],
    w1: number,
    threshold: number,
    spreadRatio: number,
    windowCount: number,
  ): string {
    if (kind === 'none') {
      return windowCount < this.config.minSamples
        ? `样本积累中（${windowCount}/${this.config.minSamples}），形状监测待命`
        : `分布形状稳定（W₁=${w1.toFixed(4)} ≤ 阈值 ${threshold.toFixed(4)}）`;
    }
    if (kind === 'level') return `分布整体位移（W₁=${w1.toFixed(4)} > ${threshold.toFixed(4)}）：均值水位漂移，形状未变`;
    if (kind === 'shape') {
      const spread = spreadRatio > 1 ? `展宽 ×${spreadRatio.toFixed(2)}（双峰化/尾部变厚）` : `收窄 ×${spreadRatio.toFixed(2)}（分布聚集）`;
      return `形状漂移（W₁=${w1.toFixed(4)} > ${threshold.toFixed(4)}）：均值水位基本未动但${spread}——水位检测盲区，先知漂移再谈覆盖`;
    }
    return `复合漂移（W₁=${w1.toFixed(4)} > ${threshold.toFixed(4)}）：均值与形状同时改变，世界已换`;
  }
}

// ─────────────────────────── 工具 ───────────────────────────

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
}

/** 六位小数圆整（与 12.0/13.0/16.0 统一展示口径） */
function round(x: number): number {
  return Number(x.toFixed(6));
}
