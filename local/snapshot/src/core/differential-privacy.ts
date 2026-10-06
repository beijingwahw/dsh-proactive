/**
 * 24.0 差分隐私内核 —— Laplace/Gaussian 机制 + Rényi-DP 记账
 *
 * 定义: 随机机制 M 满足 (ε, δ)-DP 当且仅当对一切相邻数据集 D, D′(至多一个个体不同):
 *     P[M(D) ∈ S] ≤ e^ε · P[M(D′) ∈ S] + δ,  ∀S
 * 相邻个体的存在性不可区分 —— 遥测(心智报告 / Sankey 能量流 / 模型画像)不再裸暴露
 * 单一模型或单一租户的商业敏感数据。
 *
 * 机制:
 *   Laplace(数值/直方图, 精确 (ε,0)-DP): 加噪 Lap(b), b = Δ₁/ε, Δ₁ = 敏感度
 *     (相邻数据集下查询输出的最大 L1 变化)。计数敏感度 1; n 条值的钳位均值敏感度 (hi−lo)/n。
 *   Gaussian + Rényi-DP 组合(多轮发布): 单次发布满足 RDP(α_ord) = α_ord·Δ₂²/(2σ²);
 *     组合 = 各次 RDP 求和(无论相关性); 转 (ε, δ):
 *     ε = sup_{α>1} [ RDP(α) + ln(1/δ)/(α−1) ]。
 *     本实现取固定阶 α_ord = 8 的单阶记账(合法上界, 工程上简洁): σ = Δ₂·√(α_ord/(2·ε_alloc))。
 *
 * 预算记账: PrivacyAccountant 维护总 ε 预算, 每次发布折半分账(几何分配, 永不超支),
 * 超预算返回 undefined 并标记 exhausted —— 差分隐私的保证以预算纪律为前提。
 *
 * R5 第五轮进化（内核世界性进化·统计推断组）：
 * - 数学：exponentialMechanism —— **指数机制**（McSherry–Talwar 2007，
 *   (ε,0)-DP 的通用机制）：对效用 u_i 依 P(i) ∝ exp(ε·u_i/(2Δu)) 采样，
 *   效用最大化与隐私同时成立——「选最优租户/最优策略」这类**非数值
 *   查询」第一次有 DP 机制（Laplace/Gaussian 只会加噪破坏离散选择）。
 * - 数学：gaussianRdpEpsilon / rdpToEpsilonOptimal —— RDP→(ε,δ) 的
 *   **最优阶转换**：单阶记账是 RDP(α_ord)+ln(1/δ)/(α_ord−1)，对高斯
 *   RDP(α)=αΔ²/(2σ²) 关于 α 凸，最优阶有闭式 α* = 1+σ√(2ln(1/δ))/Δ
 *   （对目标函数求导置零），夹到 [2,∞)。任意参数下 optimal ≤ 固定阶 8
 *   ——同一噪声 σ 的**精确隐私账单**比固定阶更省 ε（或同 ε 下允许更
 *   小噪声）：rdpToEpsilonOptimal 对任意 RDP 阶集合取逐阶最小。
 * - 数值稳健：指数机制全程 log 域（log-sum-exp + 归一化游走采样）：
 *   ε·u/(2Δ) ~ 5000 时线性 softmax 直接 exp 溢出为 NaN，log 域精确
 *   给出「最优项概率 ≈ 1」的合法分布。
 *
 * 零漂移: 未启用时一切导出路径输出与升级前逐位一致。
 */

export interface PrivacyConfig {
  /** 总 ε 预算(整个账本生命周期) */
  epsilon: number;
  /** 高斯机制的 δ(建议 ≤ 1e-6, 须远小于 1/数据集规模) */
  delta: number;
}

export const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  epsilon: 3.0,
  delta: 1e-6,
};

/** RDP 组合采用的固定阶 */
export const RDP_ORDER = 8;

export interface PrivacyRelease {
  tag: string;
  mechanism: 'laplace' | 'gaussian-rdp';
  epsilonSpent: number;
  at: number;
}

export interface PrivacyStatus {
  epsilonBudget: number;
  epsilonSpent: number;
  epsilonRemaining: number;
  delta: number;
  releases: PrivacyRelease[];
  exhausted: boolean;
}

export type Rng = () => number;

/** Laplace(0, b) 噪声: 逆 CDF 采样, U(0,1) → −b·sign(u−½)·ln(1−2|u−½|) */
export function laplaceNoise(scale: number, rng: Rng = Math.random): number {
  const u = Math.max(1e-12, Math.min(1 - 1e-12, rng()));
  return -scale * Math.sign(u - 0.5) * Math.log(1 - 2 * Math.abs(u - 0.5));
}

/** 标准正态噪声(Box–Muller) */
export function gaussianNoise(rng: Rng = Math.random): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Laplace 机制单值: (ε,0)-DP, 无记账(机制级原语) */
export function dpValue(value: number, epsilon: number, sensitivity = 1, rng: Rng = Math.random): number {
  return value + laplaceNoise(sensitivity / Math.max(epsilon, 1e-9), rng);
}

/** 钳位均值 + Laplace: 敏感度 (hi−lo)/n */
export function dpMeanClamped(values: number[], epsilon: number, lo: number, hi: number, rng: Rng = Math.random): number {
  const clamped = values.map(v => Math.min(hi, Math.max(lo, v)));
  const mean = clamped.length ? clamped.reduce((s, x) => s + x, 0) / clamped.length : (lo + hi) / 2;
  return dpValue(mean, epsilon, (hi - lo) / Math.max(1, clamped.length), rng);
}

/** 直方图 + Laplace: 不相交桶并行组合, 敏感度 1 */
export function dpHistogram(counts: number[], epsilon: number, rng: Rng = Math.random): number[] {
  return counts.map(c => Math.max(0, dpValue(c, epsilon, 1, rng)));
}

/** RDP(α_ord) 转 (ε, δ): 单阶记账的解析转换 */
export function rdpToEpsilon(rdpAtOrder: number, order: number, delta: number): number {
  return rdpAtOrder + Math.log(1 / Math.max(delta, 1e-15)) / (order - 1);
}

// ───────────────────── R5：最优阶 RDP→(ε,δ) 转换（精确化记账） ─────────────────────

/** RDP 阶-值条目（某机制在给定阶下的 Rényi-DP 值） */
export interface RdpOrderEntry {
  /** Rényi 散度阶 α（须 > 1） */
  order: number;
  /** 该阶下的 RDP 值（α 阶 Rényi 散度） */
  rdp: number;
}

/**
 * 最优阶 RDP→(ε,δ) 转换：ε = min_α [RDP(α) + ln(1/δ)/(α−1)]。
 *
 * 每个阶都给出一个合法的 (ε(α), δ) 转换（标准 RDP→DP 引理），取逐阶
 * 最小即该机制在 δ 下的**精确**账单——多阶记账（如 Gaussian 机制沿
 * α 网格评估）不用猜哪个阶好，直接取最优。
 */
export function rdpToEpsilonOptimal(orders: ReadonlyArray<RdpOrderEntry>, delta: number): number {
  const lnInvDelta = Math.log(1 / Math.max(delta, 1e-15));
  let best = Number.POSITIVE_INFINITY;
  for (const entry of orders) {
    if (!(entry.order > 1) || !Number.isFinite(entry.rdp)) continue;
    const candidate = entry.rdp + lnInvDelta / (entry.order - 1);
    if (candidate < best) best = candidate;
  }
  return best;
}

/** 高斯机制最优阶转换读取视图 */
export interface GaussianRdpEpsilonResult {
  /** 精确 (ε, δ) 账单（最优阶） */
  epsilon: number;
  /** 闭式最优阶 α* = 1 + σ√(2·ln(1/δ))/Δ，夹到 [2, ∞) */
  optimalOrder: number;
  /** 固定阶 8 的旧账单（对照口径） */
  fixedOrderEpsilon: number;
  /** 节省量 fixed − optimal（≥ 0，任意参数下非负） */
  saving: number;
}

/**
 * 高斯机制的精确 RDP 账单（闭式最优阶）。
 *
 * 高斯 RDP：R(α) = α·Δ₂²/(2σ²)。转换目标 f(α) = R(α) + ln(1/δ)/(α−1)
 * 关于 α 严格凸，f′(α) = Δ₂²/(2σ²) − ln(1/δ)/(α−1)² = 0 给出闭式
 *   α* = 1 + σ·√(2·ln(1/δ))/Δ₂
 * 夹到 [2, ∞)（RDP 引理要求 α > 1；工程取 α ≥ 2 与 RDP_ORDER=8 口径
 * 可比）。任意 (σ, Δ, δ) 下 epsilon ≤ fixedOrderEpsilon——固定阶 8
 * 只在 α* 恰为 8 时最优，其余情形精确账单严格更省（同噪声更小 ε /
 * 同 ε 预算更小 σ 更高效用）。
 */
export function gaussianRdpEpsilon(sigma: number, l2Sensitivity: number, delta: number): GaussianRdpEpsilonResult {
  const s = Math.max(1e-12, Math.abs(sigma));
  const d = Math.max(1e-12, Math.abs(l2Sensitivity));
  const lnInvDelta = Math.log(1 / Math.max(delta, 1e-15));
  const alphaStar = Math.max(2, 1 + (s * Math.sqrt(2 * lnInvDelta)) / d);
  const rdpAt = (alpha: number): number => (alpha * d * d) / (2 * s * s);
  const epsilon = rdpAt(alphaStar) + lnInvDelta / (alphaStar - 1);
  const fixed = rdpToEpsilon(rdpAt(RDP_ORDER), RDP_ORDER, Math.max(delta, 1e-15));
  return { epsilon, optimalOrder: alphaStar, fixedOrderEpsilon: fixed, saving: fixed - epsilon };
}

// ───────────────────── R5：指数机制（非数值查询的 DP 选择） ─────────────────────

/**
 * 指数机制（McSherry–Talwar 2007）：P(选择 i) ∝ exp(ε·u_i/(2Δu))。
 *
 * 对任意效用函数 u 与敏感度 Δu（相邻数据集下 max|u_i − u′_i|），
 * 采样输出满足 (ε, 0)-DP——效用越大概率越大，隐私账单精确 ε。
 * 敏感度 ≤ 0（效用不依赖数据）→ 均匀采样（0-DP）。全程 log 域：
 *   log w_i = ε·u_i/(2Δu)，归一化经 log-sum-exp，
 *   逆 CDF 游走采样（单次 rng 调用，给定 rng 流完全确定）。
 * NaN/±∞ 效用：−∞ 视为永不选中（除非全部 −∞ → 均匀），NaN 视为 0 效用。
 */
export function exponentialMechanism(
  utilities: readonly number[],
  epsilon: number,
  sensitivity: number,
  rng: Rng = Math.random,
): number {
  const m = utilities.length;
  if (m === 0) return -1;
  if (m === 1) return 0;
  const eps = Math.max(0, epsilon);
  if (eps === 0 || sensitivity <= 0 || !Number.isFinite(sensitivity)) {
    // 零隐私预算或数据无关效用：均匀采样（合法且信息最省）
    return Math.min(m - 1, Math.floor(Math.max(1e-12, Math.min(1 - 1e-12, rng())) * m));
  }
  const scale = eps / (2 * sensitivity);
  let maxLog = Number.NEGATIVE_INFINITY;
  const logWeights: number[] = new Array(m);
  for (let i = 0; i < m; i += 1) {
    const u = utilities[i]!;
    // NaN 视为 0 效用（文档契约）；±∞ 分别映射为 ±∞ 对数权重
    const lw = Number.isFinite(u) ? u * scale : Number.isNaN(u) ? 0 : u > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    logWeights[i] = lw;
    if (lw > maxLog) maxLog = lw;
  }
  if (maxLog === Number.NEGATIVE_INFINITY) {
    return Math.min(m - 1, Math.floor(Math.max(1e-12, Math.min(1 - 1e-12, rng())) * m)); // 全 −∞：均匀
  }
  if (maxLog === Number.POSITIVE_INFINITY) {
    // 存在 +∞ 权重：退化为其中的等权选择（log-sum-exp 的 m−max→+∞ 段）
    const winners: number[] = [];
    for (let i = 0; i < m; i += 1) if (logWeights[i] === Number.POSITIVE_INFINITY) winners.push(i);
    return winners[Math.min(winners.length - 1, Math.floor(Math.max(1e-12, Math.min(1 - 1e-12, rng())) * winners.length))]!;
  }
  // log-sum-exp 归一化 + 逆 CDF 游走（log 域，exp(5000) 级不溢出）
  const lse = maxLog + Math.log(logWeights.reduce((s, lw) => s + Math.exp(lw - maxLog), 0));
  const r = Math.max(1e-12, Math.min(1 - 1e-12, rng()));
  let cumulative = 0;
  for (let i = 0; i < m; i += 1) {
    cumulative += Math.exp(logWeights[i]! - lse);
    if (cumulative >= r) return i;
  }
  return m - 1; // 浮点游走兜底（r < 1）
}

/**
 * 差分隐私账本: 折半分账的预算管理。
 * 每次 gaussianRdp/laplace 调用消耗剩余预算的一半 —— 几何级数保证总消耗 ≤ ε,
 * 且任何时刻可读出已耗/剩余。
 */
export class PrivacyAccountant {
  private readonly config: PrivacyConfig;
  private readonly rng: Rng;
  private spent = 0;
  private readonly releases: PrivacyRelease[] = [];
  private readonly releaseLimit = 200;

  constructor(config?: Partial<PrivacyConfig>, rng?: Rng) {
    this.config = { ...DEFAULT_PRIVACY_CONFIG, ...config };
    this.rng = rng ?? Math.random;
  }

  get remaining(): number {
    return Math.max(0, this.config.epsilon - this.spent);
  }

  get exhausted(): boolean {
    return this.remaining <= 1e-6;
  }

  /** Laplace 发布(消耗折半预算); 超限返回 undefined */
  laplace(value: number, sensitivity: number, tag: string): number | undefined {
    const alloc = this.allocate(tag, 'laplace');
    if (alloc == null) return undefined;
    return dpValue(value, alloc, sensitivity, this.rng);
  }

  /**
   * Gaussian + RDP 发布: σ 由本次分配的 ε 与固定阶推得;
   * 返回加噪后的数值数组, 超限返回 undefined。
   */
  gaussianRdp(values: number[], l2Sensitivity: number, tag: string): number[] | undefined {
    const alloc = this.allocate(tag, 'gaussian-rdp');
    if (alloc == null) return undefined;
    const sigma = l2Sensitivity * Math.sqrt(RDP_ORDER / (2 * alloc));
    return values.map(v => v + gaussianNoise(this.rng) * sigma);
  }

  /** 状态快照(自身不含敏感数值) */
  status(): PrivacyStatus {
    return {
      epsilonBudget: this.config.epsilon,
      epsilonSpent: round(this.spent),
      epsilonRemaining: round(this.remaining),
      delta: this.config.delta,
      releases: [...this.releases],
      exhausted: this.exhausted,
    };
  }

  private allocate(tag: string, mechanism: 'laplace' | 'gaussian-rdp'): number | null {
    if (this.exhausted || this.releases.length >= this.releaseLimit) return null;
    const alloc = this.remaining / 2;
    if (alloc < 1e-4) return null;
    this.spent += alloc;
    this.releases.push({ tag: `${mechanism}:${tag}`, mechanism, epsilonSpent: round(alloc), at: Date.now() });
    return alloc;
  }
}

/**
 * 通用视图扰动: 深度优先遍历 JSON 视图, 对数值叶子施加 Laplace(敏感度 1)。
 * 跳过 id/时间戳/版本/计数类键(这些字段本身不可逆推个体), 每次调用最多扰动 maxFields 个
 * 数值以控制预算燃烧。预算耗尽后剩余字段原样返回(不静默失败——status 可审计)。
 */
export function perturbNumbers<T>(view: T, accountant: PrivacyAccountant, maxFields = 24): T {
  let touched = 0;
  const SKIP = /(^|[^a-z])(id|at|ts|version|seq|count|port|index|rank|generation|tick)s?$/i;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v) && !SKIP.test(k)) {
          if (touched < maxFields) {
            const noisy = accountant.laplace(v, 1, k);
            touched += 1;
            out[k] = noisy ?? v;
          } else {
            out[k] = v;
          }
        } else {
          out[k] = walk(v);
        }
      }
      return out;
    }
    return node;
  };
  return walk(view) as T;
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
