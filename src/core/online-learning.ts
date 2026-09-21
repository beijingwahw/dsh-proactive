/**
 * 31.0 在线学习内核 —— Fixed-Share Hedge：对手存在下的无悔学习
 *
 * 动机: 系统里一切统计学习（Wilson 下界 / UCB / Gittins / GP）都建立在
 * **随机性假设**上——世界是平稳的概率分布，样本独立同分布。但多模型调度
 * 的真实世界是对抗性 / 非平稳的：厂商今天限流明天放开、某模型被静默降级、
 * 流量模式被人间的周节律扭转。「最优」在对手面前是幻觉，唯一守得住的
 * 口径是**无悔**（no-regret）:
 *
 *   R_T = L(算法) − min_i L_i(事后最优固定专家) ≤ o(T)
 *
 *   指数权重（Hedge, Freund–Schapire 1997）:
 *     ω_i(t+1) = ω_i(t)·e^{−η·ℓ_i(t)},  ℓ_i(t) ∈ [0,1]
 *
 *   遗憾定理（切线界 e^{−ηℓ} ≤ 1 − (1−e^{−η})ℓ 的精确推论）:
 *     R_T ≤ ln N/η + (η/2)·T      （η ∈ (0,1]）
 *     η = √(2 lnN/T) 时 R_T ≤ √(2T lnN)——**对手无论怎么出招都成立**，
 *     与分布假设无关。每轮无悔 ⇒ 时间平均收敛到最小最大化均衡
 *     （folk theorem: 遗憾博弈论的黑斯定理入口）。
 *
 *   非平稳世界（模型会漂移）: Fixed-Share（Herbster–Warmuth 1998）
 *     ω_i ← (1−α)·ω_i·e^{−ηℓ_i}/Z + α/N
 *   每轮把 α 份额均匀回灌——权重永远保留「翻盘预算」，对**任意 S 次
 *   切换的最优专家序列**的跟踪遗憾（口径见 trackingRegretBound）:
 *     R_τ ≤ [lnN + S·ln(1/α) + (τ−S)·ln(1/(1−α))]/η + ητ/2
 *   平稳世界取 α→0 退化为经典 Hedge（份额泄漏项归零）。
 *
 *   本内核的双口径承诺:
 *   - 任意对抗序列（含自适应对手，先看权重再出招）遗憾不超界；
 *   - reward 口径（质量 ∈ [0,1]）经 ℓ = 1−r 变换无损进入。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致。
 */

/** Hedge 配置 */
export interface HedgeOptions {
  /** 专家数 N ≥ 1 */
  experts: number;
  /** 学习率 η ∈ (0,1]（缺省 0.3；√(2 lnN/T) 调优口径见 staticEtaFor） */
  eta?: number;
  /** Fixed-Share 回灌率 α ∈ [0,1)（0 = 经典 Hedge；缺省 0.05） */
  alpha?: number;
}

/** 遗憾审计快照（任何时刻可读——任意时刻有效性） */
export interface HedgeStats {
  rounds: number;
  /** 算法累计损失 Σ_t ⟨w_t, ℓ_t⟩（全反馈口径）/ 已实现损失（部分反馈口径） */
  hedgeLoss: number;
  /** 事后最优固定专家及其累计损失 min_i Σ_t ℓ_i(t) */
  bestExpert: number;
  bestLoss: number;
  /** R_T = hedgeLoss − bestLoss（部分反馈口径可为负——算法好运气） */
  regret: number;
  /** 定理界 lnN/η + ηT/2（regret 应恒 ≤ 此界——对手无关） */
  regretBound: number;
  /** 当前权重（归一化） */
  weights: number[];
  /** 反馈口径（full = 全专家每轮有观测；partial = 每轮仅被指派专家） */
  feedback: 'full' | 'partial';
}

/**
 * Fixed-Share 指数权重。
 *
 * update(losses) 每轮一次；weights() 只读；stats() 给出与定理界的实时
 * 对账（验证脚本用它断言「任意对手序列下 regret ≤ bound」）。
 */
export class Hedge {
  private readonly n: number;
  private readonly eta: number;
  private readonly alpha: number;
  private omega: number[];
  private cumulative: number[];
  private hedgeLoss = 0;
  private rounds = 0;
  private partial = false;

  constructor(options: HedgeOptions) {
    const n = Math.max(1, Math.floor(options.experts));
    this.n = n;
    this.eta = clamp(options.eta ?? 0.3, 1e-6, 1);
    this.alpha = clamp(options.alpha ?? 0.05, 0, 0.999);
    this.omega = Array.from({ length: n }, () => 1 / n);
    this.cumulative = Array.from({ length: n }, () => 0);
  }

  /** 一轮对抗反馈：losses[i] ∈ [0,1]（越低越好；自动钳位） */
  update(losses: ReadonlyArray<number>): void {
    if (losses.length !== this.n) throw new Error(`Hedge.update 期望 ${this.n} 个损失，收到 ${losses.length}`);
    const ell = Array.from({ length: this.n }, (_, i) => clamp(losses[i] ?? 0, 0, 1));
    // 归一化权重下的期望损失（遗憾的算法侧被积量）
    let wSum = 0;
    for (const w of this.omega) wSum += w;
    const expectation = wSum > 0 ? this.omega.reduce((s, w, i) => s + w * ell[i], 0) / wSum : 1 / this.n;
    this.hedgeLoss += expectation;
    this.rounds += 1;
    // 指数权重更新 + Fixed-Share 回灌（教科书形：先归一后掺匀）
    const updated = this.omega.map((w, i) => w * Math.exp(-this.eta * ell[i]));
    let total = 0;
    for (const w of updated) total += w;
    const posterior = total > 0 ? updated.map((w) => w / total) : Array.from({ length: this.n }, () => 1 / this.n);
    this.omega = posterior.map((p) => (1 - this.alpha) * p + this.alpha / this.n);
    for (let i = 0; i < this.n; i += 1) this.cumulative[i] += ell[i];
  }

  /** reward 口径入口（质量 ∈ [0,1]；ℓ = 1 − r 无损变换） */
  updateRewards(rewards: ReadonlyArray<number>): void {
    this.update(rewards.map((r) => 1 - clamp(r, 0, 1)));
  }

  /**
   * 部分反馈入口（每轮仅一个专家被指派、有观测）。
   *
   * 掩码更新：其余专家本轮损失记 0（指数权重下等价于其权重不动，
   * 仅受 Fixed-Share 回灌微调）；记账切换为**已实现口径**——cumulative
   * 只累计各专家真实发生的损失，hedgeLoss = 算法实际承受的损失之和。
   * 全反馈定理界仍作为上界参考（部分信息下界弱化 √N 倍，口径在
   * stats.feedback 标注——不冒充全反馈保证）。
   */
  reportSingle(index: number, reward: number): void {
    if (index < 0 || index >= this.n) return;
    const ell = clamp(1 - clamp(reward, 0, 1), 0, 1);
    this.partial = true;
    this.hedgeLoss += ell;
    this.rounds += 1;
    this.cumulative[index] += ell;
    const masked = Array.from({ length: this.n }, (_, i) => (i === index ? ell : 0));
    const updated = this.omega.map((w, i) => w * Math.exp(-this.eta * masked[i]));
    let total = 0;
    for (const w of updated) total += w;
    const posterior = total > 0 ? updated.map((w) => w / total) : Array.from({ length: this.n }, () => 1 / this.n);
    this.omega = posterior.map((p) => (1 - this.alpha) * p + this.alpha / this.n);
  }

  /** 当前归一化权重（拷贝） */
  weights(): number[] {
    return [...this.omega];
  }

  /** 当前最优专家（权重最高者；平手取小下标——确定性） */
  recommend(): number {
    let best = 0;
    for (let i = 1; i < this.n; i += 1) if (this.omega[i] > this.omega[best]) best = i;
    return best;
  }

  stats(): HedgeStats {
    let bestExpert = 0;
    for (let i = 1; i < this.n; i += 1) if (this.cumulative[i] < this.cumulative[bestExpert]) bestExpert = i;
    const bestLoss = this.cumulative[bestExpert];
    return {
      rounds: this.rounds,
      hedgeLoss: this.hedgeLoss,
      bestExpert,
      bestLoss,
      regret: this.hedgeLoss - bestLoss,
      regretBound: staticRegretBound(this.n, this.eta, this.rounds),
      weights: [...this.omega],
      feedback: this.partial ? 'partial' : 'full',
    };
  }
}

/** 平稳界：R_T ≤ lnN/η + ηT/2（η ∈ (0,1]，Freund–Schapire 切线界推论） */
export function staticRegretBound(experts: number, eta: number, rounds: number): number {
  return Math.log(Math.max(1, experts)) / eta + (eta / 2) * rounds;
}

/** 未知视界 T 的时间变学习率 η_t = min(1, √(lnN / t))（√(2T lnN) 阶自适配） */
export function timeVaryingEta(experts: number, t: number): number {
  if (t < 1) return 1;
  return Math.min(1, Math.sqrt(Math.log(Math.max(2, experts)) / t));
}

/** Fixed-Share 跟踪遗憾上界（区间长 τ、切换 S 次；Herbster–Warmuth 口径） */
export function trackingRegretBound(experts: number, eta: number, tau: number, switches: number, alpha: number): number {
  const lnN = Math.log(Math.max(1, experts));
  const a = clamp(alpha, 1e-12, 1 - 1e-12);
  const pathCost = switches * Math.log(1 / a) + Math.max(0, tau - switches) * Math.log(1 / (1 - a));
  return (lnN + pathCost) / eta + (eta / 2) * tau;
}

/** 首步学习率调优建议（视界 T 已知时的最优 η = √(2 lnN/T)） */
export function staticEtaFor(experts: number, horizon: number): number {
  if (horizon < 1) return 1;
  return Math.min(1, Math.sqrt((2 * Math.log(Math.max(2, experts))) / horizon));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));
}

// ─────────────────── 31.0 调度接线口径（挂载侧的语义桥） ───────────────────

/**
 * 模型组合的 Hedge 乘数（31.0 接线辅助）。
 *
 * 权重 → 评分乘数 w_i / mean(w)，钳位 [minMultiplier, maxMultiplier]：
 * - 对抗口径下持续表现好（对手奈何不了它）的模型最多升 maxMultiplier 倍；
 * - 被对手打爆的模型最多降 minMultiplier 倍——**有界干预**，Hedge 只在
 *   证据权重侧表态，不接管评分主体（与经济乘数同一挂载位）。
 */
export function hedgeMultiplier(weights: ReadonlyArray<number>, index: number, minMultiplier = 0.25, maxMultiplier = 4): number {
  const w = weights[index];
  if (w === undefined || !Number.isFinite(w)) return 1;
  let mean = 0;
  for (const x of weights) mean += x;
  mean = mean / weights.length;
  if (!(mean > 0)) return 1;
  return clamp(w / mean, minMultiplier, maxMultiplier);
}
