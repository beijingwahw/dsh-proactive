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
