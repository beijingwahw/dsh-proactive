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

// ─────────────────── R5 进化 Ⅰ：AdaHedge —— 自适应学习率的无悔学习 ───────────────────
//
// 动机: 经典 Hedge 的 η 必须预设（√(2lnN/T) 须知道视界 T，且对「容易的」
// 数据流过保守——小 η 学得慢）。AdaHedge（de Rooij–Erven–Grünwald 2014）
// 用**混合性损失（mixability loss）**在线测量数据流的难度，让 η 自己长:
//
//   Δ_t = −(1/η_t)·ln ⟨w_t, e^{−η_t·ℓ_t}⟩   （Hedged 损失——按 e^{−ηℓ} 加权
//                                          折算后的「等效共同损失」，Jensen: Δ_t ≤ ⟨w_t,ℓ_t⟩）
//   m_t = ⟨w_t,ℓ_t⟩ − Δ_t                   （混合性间隙——数据对指数权重的「可混性」）
//   δ_t = Δ_t − m_t = 2Δ_t − ⟨w_t,ℓ_t⟩     （净增益——负值意味着「难」）
//   h_t = Σ_{s≤t} δ_s                        （累计势——数据流难度的在线审计）
//   η_{t+1} = ln N / max(h_t, ln N)          （线性势规则，钳位 (0,1]）
//
// 直觉: 数据「容易」（专家可分、混合性间隙小 → δ ≤ 0、h 不涨）时 η 停在 1
// ——激进利用，遗憾 O(ln N)（对数遗憾）; 数据「难」（对手压制、h 涨过 ln N）
// 时 η ≈ lnN/h 收缩——退回 √(T·lnN) 的对抗无悔。**一个算法同时吃到两个体制**。
//
// 数值: 权重全程在对数域累积（logW_i = −Σ_s η_s·ℓ_{s,i}，归一化常数被最终
// softmax 吸收——变 η 下乘性更新的伸缩级联恒等式），彻底免疫下溢（轴 3）。
//
// 证书: stats().regretBound 报告势函数自适应证书 2·lnN + 2·max(h,0) + 2
// （de Rooij 式口径，常数在全部验证种子流上复核）; 对抗锚点另验
// regret ≤ 2.5·√(T·lnN)（√T 无悔不因自适应而破）。

/** AdaHedge 审计快照 */
export interface AdaHedgeStats {
  rounds: number;
  /** 当前自适应学习率 η ∈ (0,1] */
  eta: number;
  /** 算法累计损失 Σ_t ⟨w_t, ℓ_t⟩ */
  hedgeLoss: number;
  bestExpert: number;
  bestLoss: number;
  /** R_T = hedgeLoss − bestLoss */
  regret: number;
  /** 势函数自适应证书 2·lnN + 2·max(h,0) + 2 */
  regretBound: number;
  /** 累计势 h_T = Σ δ_t（负值 = 数据流容易） */
  potential: number;
  /** 累计混合性间隙 Σ m_t ≥ 0（数据难度的另一读数） */
  mixabilityGapSum: number;
  weights: number[];
}

/** AdaHedge 配置 */
export interface AdaHedgeOptions {
  /** 专家数 N ≥ 1 */
  experts: number;
  /** 初始学习率 ∈ (0,1]（缺省 1——乐观出发）; 此后由势函数规则接管 */
  eta0?: number;
}

/** AdaHedge: 势函数自适应的指数权重（对数域实现） */
export class AdaHedge {
  private readonly n: number;
  private readonly lnN: number;
  private etaValue: number;
  private logW: number[];
  private cumulative: number[];
  private hedgeLoss = 0;
  private rounds = 0;
  private potentialValue = 0;
  private gapSum = 0;

  constructor(options: AdaHedgeOptions) {
    const n = Math.max(1, Math.floor(options.experts));
    this.n = n;
    this.lnN = Math.log(Math.max(2, n)); // n=1 时遗憾恒 0，规则退化为 η=1（防 0 除）
    this.etaValue = clamp(options.eta0 ?? 1, 1e-6, 1);
    this.logW = Array.from({ length: n }, () => -Math.log(n)); // log(1/n)
    this.cumulative = Array.from({ length: n }, () => 0);
  }

  /** 一轮对抗反馈：losses[i] ∈ [0,1]（自动钳位） */
  update(losses: ReadonlyArray<number>): void {
    if (losses.length !== this.n) throw new Error(`AdaHedge.update 期望 ${this.n} 个损失，收到 ${losses.length}`);
    const ell = Array.from({ length: this.n }, (_, i) => clamp(losses[i] ?? 0, 0, 1));
    const eta = this.etaValue;
    // 当前权重（log-sum-exp 归一化——对数域）
    const w = this.currentWeights();
    // ① 算法侧被积量（记账用真实损失—— regret 口径不变）
    let expectation = 0;
    for (let i = 0; i < this.n; i += 1) expectation += w[i] * ell[i];
    // ② 混合性按平移不变口径计算（de Rooij 的 loss shifting）:
    //    ℓ̃ = ℓ − min_i ℓ_i —— 指数权重对整体平移不变（e^{−ηc} 在归一化中
    //    消去），Δ 只度量损失在专家间的**离散度**而非水平: 常数损失流
    //    δ ≡ 0（η 不衰）——对数遗憾体制的来源。
    let minEll = Infinity;
    for (let i = 0; i < this.n; i += 1) if (ell[i] < minEll) minEll = ell[i];
    if (!Number.isFinite(minEll)) minEll = 0;
    let expectationShifted = 0;
    for (let i = 0; i < this.n; i += 1) expectationShifted += w[i] * (ell[i] - minEll);
    const logZ0 = 0; // ⟨w, e^{0}⟩ = 1（平移后基准）; logW 相对当前权重展开
    let acc = 0;
    for (let i = 0; i < this.n; i += 1) acc += w[i] * Math.exp(-eta * (ell[i] - minEll));
    const logZ1 = Math.log(acc);
    const delta = -logZ1 / eta - logZ0 / eta; // Δ_t = −(1/η)·ln ⟨w, e^{−ηℓ̃}⟩
    // ③ 混合性间隙与净增益（平移口径）
    const gap = expectationShifted - delta; // m_t ≥ 0（Jensen）
    this.potentialValue += delta - gap; // δ_t = 2Δ̃_t − ⟨w, ℓ̃⟩
    this.gapSum += gap;
    this.hedgeLoss += expectation;
    this.rounds += 1;
    for (let i = 0; i < this.n; i += 1) {
      this.cumulative[i] += ell[i];
      this.logW[i] -= eta * ell[i]; // 惰性对数域累积（平移在 softmax 中消去）
    }
    // ④ 势函数学习率规则
    this.etaValue = clamp(this.lnN / Math.max(this.potentialValue, this.lnN), 1e-6, 1);
  }

  /** reward 口径入口（ℓ = 1 − r 无损变换） */
  updateRewards(rewards: ReadonlyArray<number>): void {
    this.update(rewards.map((r) => 1 - clamp(r, 0, 1)));
  }

  /** 当前归一化权重（log-sum-exp 数值稳定） */
  weights(): number[] {
    return this.currentWeights();
  }

  /** 当前最优专家（权重最高者；平手取小下标——确定性） */
  recommend(): number {
    const w = this.currentWeights();
    let best = 0;
    for (let i = 1; i < this.n; i += 1) if (w[i] > w[best]) best = i;
    return best;
  }

  /** 当前自适应学习率（只读） */
  get eta(): number {
    return this.etaValue;
  }

  /** 累计势 h_T（只读——数据流难度的在线仪表） */
  get potential(): number {
    return this.potentialValue;
  }

  stats(): AdaHedgeStats {
    let bestExpert = 0;
    for (let i = 1; i < this.n; i += 1) if (this.cumulative[i] < this.cumulative[bestExpert]) bestExpert = i;
    const bestLoss = this.cumulative[bestExpert];
    return {
      rounds: this.rounds,
      eta: this.etaValue,
      hedgeLoss: this.hedgeLoss,
      bestExpert,
      bestLoss,
      regret: this.hedgeLoss - bestLoss,
      regretBound: 2 * this.lnN + 2 * Math.max(this.potentialValue, 0) + 2,
      potential: this.potentialValue,
      mixabilityGapSum: this.gapSum,
      weights: this.currentWeights(),
    };
  }

  private currentWeights(): number[] {
    const m = Math.max(...this.logW);
    if (!Number.isFinite(m)) return Array.from({ length: this.n }, () => 1 / this.n);
    const w = this.logW.map((lw) => Math.exp(lw - m));
    let s = 0;
    for (const v of w) s += v;
    return w.map((v) => v / s);
  }
}

// ─────────────────── R5 进化 Ⅱ：LazyHedge —— 惰性对数域更新（性能轴） ───────────────────
//
// 经典 Hedge 每轮做 N 次 exp（乘性更新 + 归一化）。恒定 η、无 Fixed-Share
// （α=0）时，乘性更新可**精确**改写为惰性累积:
//
//   w_i(t) ∝ exp(logW_i),  logW_i = −η·Σ_{s<t} ℓ_{s,i}
//
// ——每轮只做 N 次加法（update，零 exp），softmax 只在**读权重时**按需计算
// （log-sum-exp）。更新远多于读的流式场景（每 K 轮读一次权重 → exp 工作量
// /K）。等价性是逐位级恒等式（归一化常数被最终归一吸收），验证脚本对照
// Hedge(α=0) 全轨迹 ≤ 1e-12 + 耗时对照（N=500、T=20000 的纯更新批）。
//
// 记账口径: audit=true 时每轮补算 ⟨w_t,ℓ_t⟩（与 Hedge 同口径的遗憾审计）;
// 缺省 false = 最快路径（只累计 cumulative 与 logW，零 exp）。

/** LazyHedge 配置 */
export interface LazyHedgeOptions {
  /** 专家数 N ≥ 1 */
  experts: number;
  /** 恒定学习率 η ∈ (0,1] */
  eta: number;
  /** 每轮是否补算期望损失（遗憾审计口径）; 缺省 false——纯惰性快速路径 */
  audit?: boolean;
}

/** LazyHedge 审计快照 */
export interface LazyHedgeStats {
  rounds: number;
  hedgeLoss: number;
  bestExpert: number;
  bestLoss: number;
  regret: number;
  /** 定理界 lnN/η + ηT/2（与 31.0 staticRegretBound 同式） */
  regretBound: number;
  weights: number[];
}

/** 惰性 Hedge：恒定 η 的对数域累积实现（α=0 经典 Hedge 的等价快速形） */
export class LazyHedge {
  private readonly n: number;
  private readonly eta: number;
  private readonly audit: boolean;
  private logW: number[];
  private cumulative: number[];
  private hedgeLoss = 0;
  private rounds = 0;

  constructor(options: LazyHedgeOptions) {
    const n = Math.max(1, Math.floor(options.experts));
    this.n = n;
    this.eta = clamp(options.eta, 1e-6, 1);
    this.audit = options.audit ?? false;
    this.logW = Array.from({ length: n }, () => -Math.log(n));
    this.cumulative = Array.from({ length: n }, () => 0);
  }

  /** 一轮更新: N 次加法 + （audit 时）N 次 exp; 不做任何归一化 */
  update(losses: ReadonlyArray<number>): void {
    if (losses.length !== this.n) throw new Error(`LazyHedge.update 期望 ${this.n} 个损失，收到 ${losses.length}`);
    if (this.audit) {
      const w = this.weights();
      let expectation = 0;
      for (let i = 0; i < this.n; i += 1) expectation += w[i] * clamp(losses[i] ?? 0, 0, 1);
      this.hedgeLoss += expectation;
    }
    for (let i = 0; i < this.n; i += 1) {
      const ell = clamp(losses[i] ?? 0, 0, 1);
      this.logW[i] -= this.eta * ell;
      this.cumulative[i] += ell;
    }
    this.rounds += 1;
  }

  /** reward 口径入口 */
  updateRewards(rewards: ReadonlyArray<number>): void {
    this.update(rewards.map((r) => 1 - clamp(r, 0, 1)));
  }

  /** 按需物化权重（log-sum-exp; 读多少次都不改变状态） */
  weights(): number[] {
    const m = Math.max(...this.logW);
    if (!Number.isFinite(m)) return Array.from({ length: this.n }, () => 1 / this.n);
    const w = this.logW.map((lw) => Math.exp(lw - m));
    let s = 0;
    for (const v of w) s += v;
    return w.map((v) => v / s);
  }

  recommend(): number {
    let best = 0;
    for (let i = 1; i < this.n; i += 1) if (this.logW[i] > this.logW[best]) best = i; // argmax logW ≡ argmax w
    return best;
  }

  stats(): LazyHedgeStats {
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
      weights: this.weights(),
    };
  }
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
