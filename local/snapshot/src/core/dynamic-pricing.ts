/**
 * 65.0 动态定价内核 —— learning-to-price：未知需求曲线下的学习定价与价格发现
 *
 * 动机: 共生市场的费率表（算力/能量现货价）是**静态的**——价格由人拍、由表查，
 * 12.0 连续拍卖只在「已知供需」时撮合出清。但真实市场需求曲线 d(p) 未知，
 * 且只有**报价才能探得**：报 p、观察买/不买（伯努利，成功概率 d(p)）——
 * 这是 bandit 反馈（不是全曲线回归）。定价于是成为在线学习问题:
 *
 *   收益 R(p) = p·d(p)，遗憾 regret_T = Σ_t [R* − R(p_t)]，R* = max_p R(p)
 *
 * 数学（线性基准 d(p) = 1−p ⇒ p* = 0.5、R* = 0.25 解析锚）:
 *   ① 离散化 UCB 定价: 价格网格上维护需求后验 d̂_i = s_i/n_i，对每个
 *      网格价算**上置信收益** p_i·(d̂_i + √(c·ln t / 2n_i))，取 argmax。
 *      乐观主义把「报价低收益未知」的好奇心变成可计算的探索预算；
 *      K 点网格的期望遗憾 O(√(K·T·lnT))——√T 率（无学习固定价遗憾 ∝ T）。
 *   ② Thompson 定价: 斜率-截距参数化 d(p) = a − b·p，(a,b) 高斯先验，
 *      伯努利结果按贝叶斯线性回归（信息形式 Λ, h）在线更新后验，
 *      每期从后验采样 (ã,b̃) 并报解析最优价 ã/(2b̃)（R=p(a−bp) 的驻点，
 *      钳位 [pMin,pMax]）——随机化探索随后验收敛自动熄火。
 *   ③ 固定价对照: 永远报 p₀——无学习基线，遗憾严格线性于 T（对照组）。
 *
 *   遗憾记账用**期望收益口径** R(p_t) = p_t·d(p_t)（伯努利噪声在期望中
 *   消除——固定价遗憾逐位确定，学习算法遗憾只剩「报价位置」的代价）。
 *
 * 验证锚点（scripts/verify-pricing-calibration.mjs）:
 *   ① 三算法 T=5000、200 种子: 平均遗憾 regret(T)/T 递减；√T 率粗检
 *      regret(5000)/regret(500) 显著 < 线性 10 倍（固定价对照恰为 10 倍）；
 *   ② 收敛价: 学习算法中位 |p̂_final − 0.5| < 0.05（网格含 0.5）；
 *   ③ 中位遗憾序: Thompson ≤ UCB ≤ 固定价（后验采样优于乐观界优于不学习）；
 *   ④ regret 关于 T 的双对数斜率 ∈ [0.4, 0.7]（√T 率的实证）。
 *
 * 应用: 共生市场能量/算力现货价——费率表从静态查表升级为学习定价
 * （12.0 连续拍卖的价格发现层：出清价不再假设已知，而是从成交反馈中学出）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 确定性随机源（零依赖） ───────────────────────────

/** mulberry32：32 位确定性伪随机源（种子固定时序列逐位可复现） */
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

/** 标准正态样本（Box–Muller；每次消耗 2 个均匀随机数） */
function standardNormal(rng: () => number): number {
  let u = rng();
  while (u <= 1e-12) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) throw new Error('median: 样本不能为空');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─────────────────────────── 市场模拟器 ───────────────────────────

/** 需求曲线：价格 → 购买概率（须映 [0,1] → [0,1]） */
export type DemandCurve = (price: number) => number;

/** 市场最优价格-收益对（p*, R* = p*·d(p*)） */
export interface MarketOptimum {
  price: number;
  revenue: number;
}

export interface MarketplaceOptions {
  /** 需求曲线（缺省线性基准 d(p) = 1−p） */
  demand?: DemandCurve;
  /** 伯努利购买噪声种子（同种子逐位复现） */
  noiseSeed: number;
}

/** 线性基准的需求曲线（真值 d(p) = 1−p） */
export function linearDemand(price: number): number {
  return 1 - price;
}

/** 线性基准的解析最优（p* = 0.5、R* = 0.25——验证锚点） */
export const LINEAR_OPTIMUM: MarketOptimum = { price: 0.5, revenue: 0.25 };

function evaluateDemand(demand: DemandCurve, price: number): number {
  if (!Number.isFinite(price) || price < 0 || price > 1) {
    throw new Error(`报价必须落在 [0,1]（收到 ${price}）`);
  }
  const d = demand(price);
  if (!Number.isFinite(d)) throw new Error(`需求曲线在 p=${price} 返回非有限值`);
  if (d < -1e-9 || d > 1 + 1e-9) {
    throw new Error(`需求曲线输出须在 [0,1]（p=${price} 处得到 ${d}）`);
  }
  return Math.min(1, Math.max(0, d));
}

/** 未知需求的最优价数值求解（细网格扫描 + 三分细化；确定性） */
function numericOptimum(demand: DemandCurve): MarketOptimum {
  const N = 2001;
  let bestP = 0;
  let bestR = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < N; i += 1) {
    const p = i / (N - 1);
    const r = p * evaluateDemand(demand, p);
    if (r > bestR + 1e-15) {
      bestR = r;
      bestP = p;
    }
  }
  let lo = Math.max(0, bestP - 1 / (N - 1));
  let hi = Math.min(1, bestP + 1 / (N - 1));
  for (let k = 0; k < 80; k += 1) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (m1 * evaluateDemand(demand, m1) >= m2 * evaluateDemand(demand, m2)) hi = m2;
    else lo = m1;
  }
  const p = (lo + hi) / 2;
  return { price: p, revenue: p * evaluateDemand(demand, p) };
}

/** 市场模拟器状态 */
export interface Marketplace {
  /** 报价一次：返回该期购买（0/1，伯努利成功概率 d(price)） */
  offer(price: number): 0 | 1;
  /** 真实需求（只读——仅供遗憾记账/ oracle 对照，算法不得偷看） */
  trueDemand(price: number): number;
  /** 市场最优（{p*, R*}） */
  readonly optimum: MarketOptimum;
  /** 已流逝期数 / 成交次数 */
  readonly rounds: number;
  readonly purchases: number;
}

/**
 * 构造市场模拟器。
 *
 * 缺省线性基准 d(p)=1−p（解析最优 0.5/0.25 精确命中）；自定义曲线走
 * 数值最优求解。购买为种子化伯努利——同 noiseSeed 同报价序列逐位复现。
 */
export function makeMarketplace(options: MarketplaceOptions): Marketplace {
  if (options === null || typeof options !== 'object') throw new Error('makeMarketplace: 需要 options 对象');
  if (!Number.isFinite(options.noiseSeed)) throw new Error('makeMarketplace: noiseSeed 须为有限数');
  const custom = options.demand;
  const demand: DemandCurve = custom ?? linearDemand;
  const rng = mulberry32(Math.floor(options.noiseSeed));
  const optimum = custom === undefined ? { ...LINEAR_OPTIMUM } : numericOptimum(demand);
  let rounds = 0;
  let purchases = 0;
  return {
    offer(price: number): 0 | 1 {
      const d = evaluateDemand(demand, price);
      const bought = rng() < d ? 1 : 0;
      rounds += 1;
      purchases += bought;
      return bought as 0 | 1;
    },
    trueDemand(price: number): number {
      return evaluateDemand(demand, price);
    },
    get optimum(): MarketOptimum {
      return optimum;
    },
    get rounds(): number {
      return rounds;
    },
    get purchases(): number {
      return purchases;
    },
  };
}

// ─────────────────────────── 定价策略（策略对象协议） ───────────────────────────

/** 策略当前的定价信念（可选读出——供审计/收敛诊断） */
export interface PriceEstimate {
  price: number;
  expectedDemand: number;
  expectedRevenue: number;
}

/** 定价策略协议：每期 nextPrice() 报价 → 市场返回 observe(买没买) */
export interface PricingPolicy {
  readonly name: string;
  /** 已决策期数 */
  readonly rounds: number;
  /** 报出本期价格（须在 [0,1]） */
  nextPrice(): number;
  /** 回填本期购买结果（0/1）——必须紧跟 nextPrice 之后调用 */
  observe(bought: number): void;
  /** 当前最优价估计（证据不足时 undefined） */
  estimate(): PriceEstimate | undefined;
}

/** ③ 固定价对照（无学习基线：遗憾严格线性于 T） */
export class FixedPricePolicy implements PricingPolicy {
  readonly name: string;
  private readonly priceValue: number;
  private count = 0;

  constructor(price: number, name = 'fixed') {
    if (!Number.isFinite(price) || price < 0 || price > 1) {
      throw new Error(`固定价必须落在 [0,1]（收到 ${price}）`);
    }
    this.priceValue = price;
    this.name = name;
  }

  get rounds(): number {
    return this.count;
  }

  nextPrice(): number {
    this.count += 1;
    return this.priceValue;
  }

  observe(bought: number): void {
    if (bought !== 0 && bought !== 1) throw new Error(`observe 期望 0/1（收到 ${bought}）`);
  }

  estimate(): PriceEstimate | undefined {
    return undefined; // 固定价不持有需求信念
  }
}

// ─────────────────────────── ① 离散化 UCB 定价 ───────────────────────────

/** UCB 定价缺省探索常数（bonus = exploration·√(ln t / 2n)；0.35 为线性基准 200 种子的√T 率调优值，斜率 ≈ 0.51） */
export const DEFAULT_UCB_EXPLORATION = 0.35;

/** 缺省价格网格：0 到 1 步长 0.02（51 点，含精确 0.5；两步邻价误差 0.04 < 0.05 收敛容差） */
export function defaultPriceGrid(): number[] {
  const grid: number[] = [];
  for (let i = 0; i <= 50; i += 1) grid.push(i / 50);
  return grid;
}

export interface UcbPricingOptions {
  /** 价格网格（严格递增、落在 [0,1]；缺省 0..1 步长 0.02） */
  grid?: number[];
  /** 探索常数 c（bonus = c·√(ln t / 2n_i)；缺省 0.35） */
  exploration?: number;
  /**
   * 已知视界 T（可选）：给出则 bonus 用 ln T 替代 ln t（固定置信口径，
   * 早期探索略省）；缺省按当期轮数自适应。
   */
  horizon?: number;
}

/**
 * ① 离散化 UCB 定价。
 *
 * 每个网格价维护 (n_i, s_i)：需求估计 d̂_i = s_i/n_i，Hoeffding 半径
 * r_i = c·√(ln t / 2n_i)，每期报价 argmax_i p_i·min(1, d̂_i + r_i)
 * ——对**上置信收益**乐观。未试过的价格先各试一次（诚实的不确定性：
 * 无样本 = 无限乐观）。理论遗憾 O(√(K·T·lnT))（K = 网格点数）。
 */
export class UcbPricingPolicy implements PricingPolicy {
  readonly name = 'ucb';
  private readonly grid: number[];
  private readonly exploration: number;
  private readonly horizonLog: number | undefined;
  private readonly trials: number[];
  private readonly successes: number[];
  private count = 0;
  private lastIndex = -1;

  constructor(options: UcbPricingOptions = {}) {
    if (options === null || typeof options !== 'object') throw new Error('ucbPricing: 需要 options 对象');
    const grid = options.grid ?? defaultPriceGrid();
    if (!Array.isArray(grid) || grid.length < 2) throw new Error('UCB 定价网格须含至少 2 个价格点');
    for (let i = 0; i < grid.length; i += 1) {
      const p = grid[i];
      if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error(`网格价格须在 [0,1]（第 ${i} 项为 ${p}）`);
      if (i > 0 && grid[i - 1] >= p) throw new Error('网格价格须严格递增');
    }
    const exploration = options.exploration ?? DEFAULT_UCB_EXPLORATION;
    if (!Number.isFinite(exploration) || exploration <= 0) throw new Error(`探索常数须 > 0（收到 ${exploration}）`);
    this.grid = [...grid];
    this.exploration = exploration;
    this.horizonLog =
      options.horizon !== undefined
        ? Math.log(Math.max(2, Math.floor(options.horizon)))
        : undefined;
    this.trials = Array.from({ length: this.grid.length }, () => 0);
    this.successes = Array.from({ length: this.grid.length }, () => 0);
  }

  get rounds(): number {
    return this.count;
  }

  nextPrice(): number {
    this.count += 1;
    // 每价先试一次：无样本 = 无限乐观
    for (let i = 0; i < this.trials.length; i += 1) {
      if (this.trials[i] === 0) {
        this.lastIndex = i;
        return this.grid[i];
      }
    }
    const logT = this.horizonLog ?? Math.log(this.count);
    let bestIdx = 0;
    let bestUcb = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.grid.length; i += 1) {
      const n = this.trials[i];
      const mean = this.successes[i] / n;
      const bonus = this.exploration * Math.sqrt(logT / (2 * n));
      const ucb = this.grid[i] * Math.min(1, mean + bonus);
      if (ucb > bestUcb + 1e-15) {
        bestUcb = ucb;
        bestIdx = i;
      }
    }
    this.lastIndex = bestIdx;
    return this.grid[bestIdx];
  }

  observe(bought: number): void {
    if (bought !== 0 && bought !== 1) throw new Error(`observe 期望 0/1（收到 ${bought}）`);
    if (this.lastIndex < 0) throw new Error('observe 须在 nextPrice 之后调用');
    this.trials[this.lastIndex] += 1;
    this.successes[this.lastIndex] += bought;
  }

  /** 当前最优价估计（无折扣的收益 argmax；网格全未试时 undefined） */
  estimate(): PriceEstimate | undefined {
    let bestIdx = -1;
    let bestRev = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.grid.length; i += 1) {
      if (this.trials[i] === 0) continue;
      const mean = this.successes[i] / this.trials[i];
      const rev = this.grid[i] * mean;
      if (rev > bestRev + 1e-15) {
        bestRev = rev;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return undefined;
    const mean = this.successes[bestIdx] / this.trials[bestIdx];
    return { price: this.grid[bestIdx], expectedDemand: mean, expectedRevenue: this.grid[bestIdx] * mean };
  }
}

/** 工厂：离散化 UCB 定价策略 */
export function ucbPricing(options: UcbPricingOptions = {}): UcbPricingPolicy {
  return new UcbPricingPolicy(options);
}

// ─────────────────────────── ② Thompson 定价（斜率-截距高斯后验） ───────────────────────────

/** Thompson 定价先验/噪声（模型 d(p) = a − b·p + ε，ε ~ N(0, noiseVar)） */
export interface ThompsonPrior {
  /** 截距 a 先验均值（缺省 1——「线性需求」族的自然锚） */
  interceptMean: number;
  /** 斜率 b 先验均值（缺省 1） */
  slopeMean: number;
  /** 截距先验方差（缺省 1） */
  interceptVar: number;
  /** 斜率先验方差（缺省 1） */
  slopeVar: number;
  /** 观测噪声方差 σ²（缺省 0.25 = 伯努利方差上界） */
  noiseVar: number;
}

export const DEFAULT_THOMPSON_PRIOR: ThompsonPrior = {
  interceptMean: 1,
  slopeMean: 1,
  interceptVar: 1,
  slopeVar: 1,
  noiseVar: 0.25,
};

export interface ThompsonPricingOptions {
  /** 先验参数（缺省线性族 {a~N(1,1), b~N(1,1)}、σ²=0.25） */
  prior?: Partial<ThompsonPrior>;
  /** 报价下/上钳位（缺省 0.01 / 0.99——避免贴边零信息报价） */
  minPrice?: number;
  maxPrice?: number;
  /** 后验采样随机源种子（同种子逐位复现；缺省 65） */
  seed?: number;
  /**
   * 已知视界 T（可选，仅作文档口径——Thompson 无探索率可调，
   * 随机化探索的熄火由后验收敛自动完成，保留此字段为接口一致性）。
   */
  horizon?: number;
}

/** 信息形式高斯后验的读出视图 */
export interface GaussianPosteriorView {
  /** 后验均值 (a, b) */
  mean: [number, number];
  /** 后验协方差（对称 2×2，按 [σ_aa, σ_ab, σ_bb] 展开） */
  cov: [number, number, number];
  /** 后验均值下的最优报价 a/(2b)（钳位后） */
  meanOptimalPrice: number;
}

/**
 * ② Thompson 定价。
 *
 * 参数化 d(p) = a − b·p，(a,b) 高斯先验。每期：
 *   1. 从后验 N(μ, Σ) 采样 (ã, b̃)（Cholesky 下三角）；
 *   2. 报采样模型下的解析最优价 ã/(2·b̃)（R(p) = p(a−bp) 驻点），
 *      b̃ ≤ 0 时贴上界（采样世界里涨价不掉需求）；
 *   3. 观测 y ∈ {0,1}，按贝叶斯线性回归信息形式更新：
 *      Λ ← Λ + xxᵀ/σ²（x = [1, p]），h ← h + x·y/σ²。
 * 后验不确定性越price集中探索越少——「随机化乐观」的自我熄火，
 * 线性需求下实证遗憾优于 UCB（验证锚点③）。
 */
export class ThompsonPricingPolicy implements PricingPolicy {
  readonly name = 'thompson';
  private readonly prior: ThompsonPrior;
  private readonly minPrice: number;
  private readonly maxPrice: number;
  private readonly rng: () => number;
  /** 信息形式 Λ = Σ⁻¹（对称，[Λ11, Λ12, Λ22] 展开） */
  private lam: [number, number, number];
  /** 信息向量 h = Λμ */
  private h: [number, number];
  private count = 0;
  private lastPrice = 0.5;
  private observed = true;

  constructor(options: ThompsonPricingOptions = {}) {
    if (options === null || typeof options !== 'object') throw new Error('thompsonPricing: 需要 options 对象');
    const prior: ThompsonPrior = { ...DEFAULT_THOMPSON_PRIOR, ...options.prior };
    for (const [key, value] of Object.entries(prior)) {
      if (!Number.isFinite(value)) throw new Error(`先验参数 ${key} 须为有限数（收到 ${value}）`);
    }
    if (prior.interceptVar <= 0 || prior.slopeVar <= 0 || prior.noiseVar <= 0) {
      throw new Error('先验方差与噪声方差须 > 0');
    }
    this.prior = prior;
    const minPrice = options.minPrice ?? 0.01;
    const maxPrice = options.maxPrice ?? 0.99;
    if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || minPrice <= 0 || maxPrice >= 1 || minPrice >= maxPrice) {
      throw new Error(`报价钳位须满足 0 < minPrice < maxPrice < 1（收到 (${minPrice}, ${maxPrice})）`);
    }
    this.minPrice = minPrice;
    this.maxPrice = maxPrice;
    const seed = options.seed ?? 65;
    if (!Number.isFinite(seed)) throw new Error(`seed 须为有限数（收到 ${seed}）`);
    this.rng = mulberry32(Math.floor(seed));
    // Λ₀ = Σ₀⁻¹（对角先验）、h₀ = Λ₀μ₀
    this.lam = [1 / prior.interceptVar, 0, 1 / prior.slopeVar];
    this.h = [prior.interceptMean / prior.interceptVar, prior.slopeMean / prior.slopeVar];
  }

  get rounds(): number {
    return this.count;
  }

  /** 当前后验（μ, Σ 与后验均值最优价；只读诊断） */
  posterior(): GaussianPosteriorView {
    const { mu, cov } = this.moments();
    return { mean: [mu[0], mu[1]], cov: [cov[0], cov[1], cov[2]], meanOptimalPrice: this.priceFor(mu[0], mu[1]) };
  }

  nextPrice(): number {
    if (!this.observed) throw new Error('nextPrice: 上一期报价尚未 observe（每期报价须回填结果）');
    this.count += 1;
    const { mu, cov } = this.moments();
    // Σ = LLᵀ（下三角 Cholesky），θ̃ = μ + L·z
    const l11 = Math.sqrt(Math.max(0, cov[0]));
    const l21 = l11 > 1e-12 ? cov[1] / l11 : 0;
    const l22 = Math.sqrt(Math.max(0, cov[2] - l21 * l21));
    const z1 = standardNormal(this.rng);
    const z2 = standardNormal(this.rng);
    const aTilde = mu[0] + l11 * z1;
    const bTilde = mu[1] + l21 * z1 + l22 * z2;
    this.lastPrice = this.priceFor(aTilde, bTilde);
    this.observed = false;
    return this.lastPrice;
  }

  observe(bought: number): void {
    if (bought !== 0 && bought !== 1) throw new Error(`observe 期望 0/1（收到 ${bought}）`);
    if (this.observed) throw new Error('observe: 没有等待回填的报价（先 nextPrice）');
    const p = this.lastPrice;
    const inv = 1 / this.prior.noiseVar;
    // Λ ← Λ + xxᵀ/σ²，h ← h + x·y/σ²（设计向量 x = [1, −p]，
    // 与模型 d(p) = a − b·p 一致——真值 (a,b)=(1,1) 落在先验中心）
    this.lam[0] += inv;
    this.lam[1] -= p * inv;
    this.lam[2] += p * p * inv;
    this.h[0] += bought * inv;
    this.h[1] -= p * bought * inv;
    this.observed = true;
  }

  /** 当前最优价估计（后验均值口径；证据不足时 undefined） */
  estimate(): PriceEstimate | undefined {
    if (this.count === 0) return undefined;
    const { mu } = this.moments();
    const price = this.priceFor(mu[0], mu[1]);
    const demand = clamp01(mu[0] - mu[1] * price);
    return { price, expectedDemand: demand, expectedRevenue: price * demand };
  }

  /** 模型参数 (a, b) 下的最优报价：R(p) = p(a−bp) 驻点 a/(2b)，钳位 */
  private priceFor(a: number, b: number): number {
    if (b <= 1e-9) return this.maxPrice; // 采样斜率非正：涨价不掉需求 → 贴上界
    return Math.min(this.maxPrice, Math.max(this.minPrice, a / (2 * b)));
  }

  /** Λ, h → (μ, Σ)：2×2 解析逆 */
  private moments(): { mu: [number, number]; cov: [number, number, number] } {
    let det = this.lam[0] * this.lam[2] - this.lam[1] * this.lam[1];
    if (!(det > 1e-12)) det = 1e-12; // 数值兜底（先验正定保证真实 det > 0）
    const c11 = this.lam[2] / det;
    const c12 = -this.lam[1] / det;
    const c22 = this.lam[0] / det;
    return {
      mu: [c11 * this.h[0] + c12 * this.h[1], c12 * this.h[0] + c22 * this.h[1]],
      cov: [c11, c12, c22],
    };
  }
}

/** 工厂：Thompson 定价策略 */
export function thompsonPricing(options: ThompsonPricingOptions = {}): ThompsonPricingPolicy {
  return new ThompsonPricingPolicy(options);
}

// ─────────────────────────── 试验与遗憾统计 ───────────────────────────

export interface TrialOptions {
  /** 需求曲线（缺省线性基准） */
  demand?: DemandCurve;
  /** 已知最优（注入解析锚，跳过数值求解） */
  optimum?: MarketOptimum;
}

export interface TrialResult {
  rounds: number;
  /** 累计遗憾 Σ_t [R* − R(p_t)]（期望收益口径） */
  regret: number;
  /** 平均遗憾 regret / T */
  averageRegret: number;
  /** 末期报价 */
  finalPrice: number;
  /** |finalPrice − p*| */
  finalPriceError: number;
  /** 策略期末的最优价估计（estimate()；无则 undefined） */
  estimatedOptimalPrice: number | undefined;
  /** 实现收益 Σ p_t·y_t（伯努利实现口径，对照用） */
  realizedRevenue: number;
}

/**
 * 单次试验：策略与市场对跑 T 期（市场噪声种子 = seed）。
 *
 * 遗憾按期望收益记账（伯努利噪声消除——固定价遗憾逐位确定，
 * 学习算法的遗憾只剩报价位置的代价）。同 (策略种子, seed, T) 逐位复现。
 */
export function runTrial(policy: PricingPolicy, T: number, seed: number, options: TrialOptions = {}): TrialResult {
  if (!Number.isInteger(T) || T < 1) throw new Error(`T 须为 ≥1 的整数（收到 ${T}）`);
  if (!Number.isFinite(seed)) throw new Error(`seed 须为有限数（收到 ${seed}）`);
  const market = makeMarketplace({ demand: options.demand, noiseSeed: seed });
  const optimum = options.optimum ?? market.optimum;
  let regret = 0;
  let realized = 0;
  let lastPrice = Number.NaN;
  for (let t = 0; t < T; t += 1) {
    const p = policy.nextPrice();
    const y = market.offer(p);
    policy.observe(y);
    regret += optimum.revenue - p * market.trueDemand(p);
    realized += p * y;
    lastPrice = p;
  }
  const estimate = policy.estimate();
  return {
    rounds: T,
    regret,
    averageRegret: regret / T,
    finalPrice: lastPrice,
    finalPriceError: Math.abs(lastPrice - optimum.price),
    estimatedOptimalPrice: estimate === undefined ? undefined : estimate.price,
    realizedRevenue: realized,
  };
}

/** 单种子全轨迹记账（regretCurve / runTrial 共用内核） */
interface TrackedTrial {
  regretAt: number[];
  finalPrice: number;
  finalPriceError: number;
}

function runTracked(
  makePolicy: (seed: number) => PricingPolicy,
  T: number,
  seed: number,
  checkpoints: ReadonlyArray<number>,
  demand: DemandCurve | undefined,
  optimum: MarketOptimum | undefined,
): TrackedTrial {
  const policy = makePolicy(seed);
  const market = makeMarketplace({ demand, noiseSeed: seed });
  const best = optimum ?? market.optimum;
  let regret = 0;
  let lastPrice = Number.NaN;
  const regretAt: number[] = [];
  let nextCp = 0;
  for (let t = 1; t <= T; t += 1) {
    const p = policy.nextPrice();
    const y = market.offer(p);
    policy.observe(y);
    regret += best.revenue - p * market.trueDemand(p);
    lastPrice = p;
    if (nextCp < checkpoints.length && t === checkpoints[nextCp]) {
      regretAt.push(regret);
      nextCp += 1;
    }
  }
  return { regretAt, finalPrice: lastPrice, finalPriceError: Math.abs(lastPrice - best.price) };
}

export interface RegretCurvePoint {
  /** 检查点轮数 */
  t: number;
  /** 跨种子中位累计遗憾 */
  medianRegret: number;
  /** 跨种子均值累计遗憾 */
  meanRegret: number;
  /** 中位平均遗憾 medianRegret / t */
  medianAvgRegret: number;
  /** 逐种子配对：平均遗憾较上一检查点不增（≤ + 1e-12）的种子比例 */
  improvingFraction: number;
}

export interface RegretCurveReport {
  /** 各检查点统计（升序） */
  points: RegretCurvePoint[];
  /** 视界 T = 末检查点 */
  horizon: number;
  /** 种子数 */
  seeds: number;
  /** 末期报价中位数 */
  finalPriceMedian: number;
  /** 末期 |报价 − p*| 中位数 */
  finalPriceErrorMedian: number;
}

export interface RegretCurveOptions {
  /** 策略工厂（入参为试验种子——策略内部随机源可与之解耦/绑定） */
  policy: (seed: number) => PricingPolicy;
  /** 种子列表（非空） */
  seeds: number[];
  /** 检查点（≥1 整数、严格递增；末值即视界 T） */
  checkpoints: number[];
  demand?: DemandCurve;
  optimum?: MarketOptimum;
}

/**
 * 遗憾曲线（分段统计）：跨种子在每个检查点汇报累计/平均遗憾的分位口径。
 *
 * 一次单遍对跑收集所有检查点（不重复模拟）；improvingFraction 给出
 * 逐种子配对的「regret(T)/T 递减」证据（对照锚点①）。
 */
export function regretCurve(options: RegretCurveOptions): RegretCurveReport {
  if (options === null || typeof options !== 'object') throw new Error('regretCurve: 需要 options 对象');
  const { seeds, checkpoints } = options;
  if (!Array.isArray(seeds) || seeds.length === 0) throw new Error('regretCurve: seeds 不能为空');
  for (const s of seeds) if (!Number.isFinite(s)) throw new Error(`种子须为有限数（收到 ${s}）`);
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) throw new Error('regretCurve: checkpoints 不能为空');
  for (let i = 0; i < checkpoints.length; i += 1) {
    const t = checkpoints[i];
    if (!Number.isInteger(t) || t < 1) throw new Error(`检查点须为 ≥1 的整数（收到 ${t}）`);
    if (i > 0 && checkpoints[i - 1] >= t) throw new Error('检查点须严格递增');
  }
  const T = checkpoints[checkpoints.length - 1];
  const trials: TrackedTrial[] = seeds.map((seed) =>
    runTracked(options.policy, T, seed, checkpoints, options.demand, options.optimum),
  );
  const points: RegretCurvePoint[] = checkpoints.map((t, idx) => {
    const column = trials.map((tr) => tr.regretAt[idx]);
    let improved = 0;
    if (idx === 0) improved = seeds.length;
    else {
      for (let s = 0; s < trials.length; s += 1) {
        if (column[s] / t <= trials[s].regretAt[idx - 1] / checkpoints[idx - 1] + 1e-12) improved += 1;
      }
    }
    let mean = 0;
    for (const v of column) mean += v;
    mean /= column.length;
    const med = median(column);
    return {
      t,
      medianRegret: med,
      meanRegret: mean,
      medianAvgRegret: med / t,
      improvingFraction: improved / seeds.length,
    };
  });
  return {
    points,
    horizon: T,
    seeds: seeds.length,
    finalPriceMedian: median(trials.map((tr) => tr.finalPrice)),
    finalPriceErrorMedian: median(trials.map((tr) => tr.finalPriceError)),
  };
}

/**
 * 双对数斜率：ln(value) 对 ln(t) 的最小二乘斜率。
 *
 * √T 率 ⇒ 斜率 ≈ 0.5；线性 ⇒ 1.0（学习定价 vs 固定价的判别量，锚点④）。
 */
export function logLogSlope(points: ReadonlyArray<{ t: number; value: number }>): number {
  if (points.length < 2) throw new Error('logLogSlope: 至少需要 2 个点');
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const point of points) {
    if (!(point.t > 0) || !(point.value > 0) || !Number.isFinite(point.t) || !Number.isFinite(point.value)) {
      throw new Error(`logLogSlope: t 与 value 须为正有限数（收到 (${point.t}, ${point.value})）`);
    }
    const x = Math.log(point.t);
    const y = Math.log(point.value);
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const n = points.length;
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}

// ─────────────────── R5 进化：定价 + 库存联合（稀缺性定价） ───────────────────
//
// 动机: 65.0 原版假设货源无限——报多少卖多少。真实共生市场的能量/算力现货
// 有**库存约束**（本轮配额 m 单位），库存把定价从「每期独立的收益最大化」
// 变成跨期权衡: 低价清仓快但单位收益低，高价惜售但可能期末剩货。经典结果
// （Gallego–van Ryzin 1994 系）: 稀缺时的最优报价**高于**无约束最优 p*，
// 且随库存相对剩余时间（m/τ）下降而抬升（价格围栏 / bid-price 控制）。
//
// 数学:
//   ① 精确 oracle（需求已知）: 有限视界 DP
//     V_t(m) = max_{p∈网格} [ d(p)·(p + V_{t+1}(m−1)) + (1−d(p))·V_{t+1}(m) ]，
//     V_T(·) = V_·(0) = 0。
//     短路定理（R5 性能轴）: m ≥ T−t ⇒ V_t(m) = (T−t)·R*，R* = max_p p·d(p)。
//     证明: 无限库存下卖出与否都转移到同一状态 (t+1, ∞)，故 V 分解为
//     逐期独立最大化 Σ_{s≥t} max_p p·d(p) = (T−t)·R*; 而 m ≥ 剩余期数时
//     库存约束永不激活，两 DP 值相同（验证脚本以暴力 DP 逐位对照）。
//   ② 围栏定价（学习版）: 对网格价维护伯努利需求估计 d̂_i = s_i/n_i，
//     单调上包络 D_i = max_{j≥i} d̂_j（需求关于价格非增的先验投影），
//     剩 m 库存、剩 τ 期时报
//       i_fence = max{ i : τ·D_i ≥ m }（能把库存按期望恰好卖光的最高价），
//     无 i 满足（库存卖不完）或 m ≥ τ 时退回无约束 argmax p_i·d̂_i。
//     未试过的价格先各试一次（高价位优先——试探库存成本最低）。
//
// 锚点（verify-r5-online.mjs）: 无稀缺极限（capacity=T）收敛价 ≈ 0.5;
//   稀缺（capacity = 半仓）时中位收益 > 无视库存的 UCB 基线 ≥ 5%;
//   DP 短路 = 暴力 DP（1e-12）; capacity=T ⇒ V = T·R* 精确。

/** 稀缺性定价的缺省价格网格: 0.05..0.95 步长 0.05（19 点——围栏粒度 ±0.025） */
export function defaultScarcityGrid(): number[] {
  const grid: number[] = [];
  for (let i = 1; i <= 19; i += 1) grid.push(i / 20);
  return grid;
}

export interface ScarcityPricingOptions {
  /** 初始库存（容量）≥ 1 */
  capacity: number;
  /** 已知视界 T（围栏需要 τ; 缺省 1000——未给时按长期口径） */
  horizon?: number;
  /** 价格网格（严格递增、∈(0,1]; 缺省 0.05..0.95 步长 0.05） */
  grid?: number[];
}

/**
 * 稀缺性定价策略（学习版围栏控制）。
 *
 * 协议与 PricingPolicy 一致（nextPrice/observe），库存内嵌: observe(1) 扣减
 * 库存; 库存为 0 时仍返回网格末价（市场侧由 runScarcityTrial 停止成交——
 * 报价只是协议完整性）。需求学习: 每价伯努利估计 + 单调上包络。
 */
export class ScarcityPricingPolicy implements PricingPolicy {
  readonly name = 'scarcity';
  private readonly grid: number[];
  private readonly horizonValue: number;
  private stock: number;
  private readonly trials: number[];
  private readonly successes: number[];
  private count = 0;
  private lastIndex = -1;

  constructor(options: ScarcityPricingOptions) {
    if (options === null || typeof options !== 'object') throw new Error('scarcityPricing: 需要 options 对象');
    const capacity = options.capacity;
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`capacity 须为 ≥1 的整数（收到 ${capacity}）`);
    const grid = options.grid ?? defaultScarcityGrid();
    if (!Array.isArray(grid) || grid.length < 2) throw new Error('稀缺性定价网格须含至少 2 个价格点');
    for (let i = 0; i < grid.length; i += 1) {
      const p = grid[i];
      if (!Number.isFinite(p) || p <= 0 || p > 1) throw new Error(`网格价格须 ∈ (0,1]（第 ${i} 项为 ${p}）`);
      if (i > 0 && grid[i - 1] >= p) throw new Error('网格价格须严格递增');
    }
    const horizon = options.horizon ?? 1000;
    if (!Number.isInteger(horizon) || horizon < 1) throw new Error(`horizon 须为 ≥1 的整数（收到 ${horizon}）`);
    this.grid = [...grid];
    this.horizonValue = horizon;
    this.stock = capacity;
    this.trials = Array.from({ length: grid.length }, () => 0);
    this.successes = Array.from({ length: grid.length }, () => 0);
  }

  get rounds(): number {
    return this.count;
  }

  /** 剩余库存（只读） */
  get remainingStock(): number {
    return this.stock;
  }

  nextPrice(): number {
    this.count += 1;
    // 探索: 未试价格各试一次，从高价往低价（高价试探的库存成本最低）
    for (let i = this.grid.length - 1; i >= 0; i -= 1) {
      if (this.trials[i] === 0) {
        this.lastIndex = i;
        return this.grid[i];
      }
    }
    const tau = Math.max(1, this.horizonValue - this.count + 1);
    if (this.stock <= 0) {
      this.lastIndex = this.grid.length - 1;
      return this.grid[this.grid.length - 1]; // 库存空: 协议完整性报价（无成交）
    }
    if (this.stock >= tau) return this.unconstrainedPrice();
    // 围栏: 能把库存按期望卖光的最高价（需求单调上包络）
    const demand = this.monotoneDemand();
    let fence = -1;
    for (let i = 0; i < this.grid.length; i += 1) {
      if (tau * demand[i] >= this.stock) fence = i;
    }
    if (fence < 0) return this.unconstrainedPrice(); // 库存卖不完 → 无约束
    this.lastIndex = fence;
    return this.grid[fence];
  }

  observe(bought: number): void {
    if (bought !== 0 && bought !== 1) throw new Error(`observe 期望 0/1（收到 ${bought}）`);
    if (this.lastIndex < 0) throw new Error('observe 须在 nextPrice 之后调用');
    this.trials[this.lastIndex] += 1;
    this.successes[this.lastIndex] += bought;
    if (bought === 1 && this.stock > 0) this.stock -= 1;
  }

  /** 当前需求信念下的最优价估计（无折扣收益 argmax） */
  estimate(): PriceEstimate | undefined {
    let bestIdx = -1;
    let bestRev = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.grid.length; i += 1) {
      if (this.trials[i] === 0) continue;
      const mean = this.successes[i] / this.trials[i];
      const rev = this.grid[i] * mean;
      if (rev > bestRev + 1e-15) {
        bestRev = rev;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) return undefined;
    const mean = this.successes[bestIdx] / this.trials[bestIdx];
    return { price: this.grid[bestIdx], expectedDemand: mean, expectedRevenue: this.grid[bestIdx] * mean };
  }

  /** 需求估计的单调上包络 D_i = max_{j≥i} d̂_j（非增投影——高价位的乐观
   *  上包络让围栏在情报不足时偏向惜售（宁可晚卖光，不贱卖）） */
  private monotoneDemand(): number[] {
    const raw = this.grid.map((_, i) => (this.trials[i] > 0 ? this.successes[i] / this.trials[i] : 1));
    const out = new Array<number>(raw.length);
    let runMax = 0;
    for (let i = raw.length - 1; i >= 0; i -= 1) {
      runMax = Math.max(runMax, raw[i]);
      out[i] = runMax;
    }
    return out;
  }

  /** 无约束最优价: argmax p_i·d̂_i（原始估计，非包络） */
  private unconstrainedPrice(): number {
    let bestIdx = 0;
    let bestRev = Number.NEGATIVE_INFINITY;
    const raw = this.grid.map((_, i) => (this.trials[i] > 0 ? this.successes[i] / this.trials[i] : 1));
    for (let i = 0; i < this.grid.length; i += 1) {
      const rev = this.grid[i] * raw[i];
      if (rev > bestRev + 1e-15) {
        bestRev = rev;
        bestIdx = i;
      }
    }
    this.lastIndex = bestIdx;
    return this.grid[bestIdx];
  }
}

/** 工厂：稀缺性定价策略 */
export function scarcityPricing(options: ScarcityPricingOptions): ScarcityPricingPolicy {
  return new ScarcityPricingPolicy(options);
}

/**
 * 稀缺性定价的精确 oracle（需求已知）: 有限视界 DP。
 *
 * V_t(m) = max_p [ d(p)·(p + V_{t+1}(m−1)) + (1−d(p))·V_{t+1}(m) ]，
 * m ≥ T−t 时短路为 (T−t)·R*（R* = max_{p∈网格} p·d(p)——定理与证明见文件
 * 头 R5 段; 暴力 DP 逐位对照在验证脚本）。确定性、O(T·m·K)。
 */
export function scarcityOptimalValue(capacity: number, horizon: number, demand: DemandCurve, grid?: number[]): number {
  if (!Number.isInteger(capacity) || capacity < 0) throw new Error(`capacity 须为 ≥0 的整数（收到 ${capacity}）`);
  if (!Number.isInteger(horizon) || horizon < 1) throw new Error(`horizon 须为 ≥1 的整数（收到 ${horizon}）`);
  if (typeof demand !== 'function') throw new Error('scarcityOptimalValue: demand 须为价格→概率函数');
  const g = grid ?? defaultScarcityGrid();
  if (!Array.isArray(g) || g.length < 1) throw new Error('scarcityOptimalValue: 网格不能为空');
  const K = g.length;
  const d: number[] = [];
  let rStar = 0;
  for (let i = 0; i < K; i += 1) {
    const p = g[i];
    if (!Number.isFinite(p) || p <= 0 || p > 1) throw new Error(`网格价格须 ∈ (0,1]（第 ${i} 项为 ${p}）`);
    const di = evaluateDemand(demand, p);
    d.push(di);
    if (p * di > rStar) rStar = p * di;
  }
  const mMax = Math.min(capacity, horizon); // m > horizon 的库存无用（每期至多卖 1）
  // next[m]: V_{t+1}(m); cur[m]: V_t(m)
  let next = new Array<number>(mMax + 1).fill(0);
  for (let t = horizon - 1; t >= 0; t -= 1) {
    const cur = new Array<number>(mMax + 1).fill(0);
    const periodsLeft = horizon - t;
    const unconstrained = periodsLeft * rStar;
    for (let m = 1; m <= mMax; m += 1) {
      if (m >= periodsLeft) {
        cur[m] = unconstrained; // 短路定理: 库存不约束 ⇒ (T−t)·R*
        continue;
      }
      const vNextSame = next[m];
      const vNextLess = next[m - 1];
      let best = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < K; i += 1) {
        const di = d[i];
        const value = di * (g[i] + vNextLess) + (1 - di) * vNextSame;
        if (value > best) best = value;
      }
      cur[m] = best;
    }
    next = cur;
  }
  return next[Math.min(capacity, mMax)];
}

/** 稀缺性试验结果 */
export interface ScarcityTrialResult {
  rounds: number;
  capacity: number;
  /** 实现收益 Σ p_t·y_t·1{库存>0}（伯努利实现口径） */
  revenue: number;
  /** 售出件数 */
  sold: number;
  /** 库存耗尽的轮（1 起; 未耗尽为 undefined） */
  soldOutAt: number | undefined;
  /** 精确 oracle 值 V_0(capacity)（期望最优收益——遗憾的分母） */
  optimalValue: number;
  /** oracle 期望收益 − 实现收益（正 = 少赚; 含伯努利噪声） */
  regret: number;
  finalPrice: number;
  /** 成交均价 revenue/sold（未售出为 NaN——稀缺性抬价的直接读数） */
  averagePrice: number;
}

export interface ScarcityTrialOptions {
  /** 需求曲线（缺省线性基准） */
  demand?: DemandCurve;
  /** 价格网格（缺省 0.05..0.95; 须与 policy 网格一致以对齐 oracle） */
  grid?: number[];
  /** 注入已知 oracle 值（跳过 DP——多种子批跑的省算口径） */
  optimum?: number;
}

/**
 * 单次稀缺性试验: 策略与限量市场对跑 T 期。
 *
 * 库存空后不再成交（无报价反馈——市场关闭）; oracle 用同网格 DP。同
 * (策略种子, seed, T) 逐位复现。任意 PricingPolicy 可跑（含无视库存的
 * 基线——库存由市场侧强制执行）。
 */
export function runScarcityTrial(
  policy: PricingPolicy,
  T: number,
  seed: number,
  capacity: number,
  options: ScarcityTrialOptions = {},
): ScarcityTrialResult {
  if (!Number.isInteger(T) || T < 1) throw new Error(`T 须为 ≥1 的整数（收到 ${T}）`);
  if (!Number.isFinite(seed)) throw new Error(`seed 须为有限数（收到 ${seed}）`);
  if (!Number.isInteger(capacity) || capacity < 0) throw new Error(`capacity 须为 ≥0 的整数（收到 ${capacity}）`);
  const grid = options.grid ?? defaultScarcityGrid();
  const market = makeMarketplace({ demand: options.demand, noiseSeed: seed });
  const optimalValue =
    options.optimum !== undefined
      ? options.optimum
      : scarcityOptimalValue(capacity, T, options.demand ?? linearDemand, grid);
  let revenue = 0;
  let sold = 0;
  let stock = capacity;
  let soldOutAt: number | undefined;
  let lastPrice = Number.NaN;
  for (let t = 1; t <= T; t += 1) {
    if (stock <= 0) {
      soldOutAt = t; // 售罄即停: 无成交亦无反馈（市场关闭，策略时钟冻结）
      break;
    }
    const p = policy.nextPrice();
    const y = market.offer(p);
    policy.observe(y);
    lastPrice = p;
    if (y === 1) {
      revenue += p;
      sold += 1;
      stock -= 1;
    }
  }
  return {
    rounds: T,
    capacity,
    revenue,
    sold,
    soldOutAt,
    optimalValue,
    regret: optimalValue - revenue,
    finalPrice: lastPrice,
    averagePrice: sold > 0 ? revenue / sold : Number.NaN,
  };
}

// ── 接线建议 ─────────────────────────────────────────────────────────
//
// 1. 共生市场费率表（能量/算力现货价）：
//    - 费率档位作为价格网格（ucbPricing({grid: 费率档})），每期报价 =
//      报价档；成交/未成交回填 observe——费率表从静态查表升级为
//      「从成交反馈学价格」，闲置档自动降价、抢手档自动提价。
//
// 2. 12.0 连续拍卖的价格发现层：
//    - 拍卖撮合假设「供需已知才出清」；挂载本内核后出清价由
//      thompsonPricing 连续试探（后验采样报价天然打散 tie），拍卖只读
//      nextPrice() 作为保留价底稿——价格发现从撮合前置变为学习内嵌。
//
// 3. 对照与守门：
//    - 固定价对照（FixedPricePolicy）作为 A/B 基线常驻：学习定价的
//      遗憾优势必须在线可审计（regretCurve 定期出报表）；一旦学习侧
//      遗憾劣于固定价（需求突变/被套利），自动回退静态费率表。
//
// 4. 挂载边界（零介入承诺）：
//    - 只读挂载：引擎仅调用 nextPrice()/observe()/estimate()，内核
//      不发起交易、不写市场状态；未挂载时现有费率路径逐位一致。
// ──────────────────────────────────────────────────────────────────
