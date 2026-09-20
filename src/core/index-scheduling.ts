/**
 * 21.0 最优索引调度内核 —— Gittins 指数 + 可用性折算(Whittle 一阶近似)
 *
 * 数学: 折扣 Bernoulli bandit 的最优调度 = Gittins 索引策略(Gittins 1979; Weber 1992 对
 * Bernoulli+Beta 情形的最优性证明)。臂 = 模型, 臂状态 = Beta(α, β) 后验。
 *
 * 精确计算(本实现的要害): 对固定退休金 R 的「退休 MDP」
 *     V_R(a,b) = max( R/(1−γ),  p·(1 + γ·V_R(a+1,b)) + (1−p)·γ·V_R(a,b+1) ),  p = a/(a+b)
 * 因转移严格增大 n = a+b, 整个值函数在 (a,b) 三角形上是 DAG —— 按 n 从 maxCount 向下
 * 反向归纳一遍即得全部 V_R, 无需任何不动点迭代。Gittins 指数
 *     ν(a,b) = sup{ R ≥ 0 : 在状态 (a,b) 继续播放优于退休 }
 * 对 R 二分(每次一遍 O(三角形) 归纳)即得。边界 n = maxCount 处后验视为已收敛,
 * 播放值取 p/(1−γ)(永续开采)。
 *
 * 关键性质(验证脚本逐条断言):
 *   1. ν ≥ p̂ 恒成立(已知臂的指数 = p̂, 不确定性带来学习溢价);
 *   2. ν(a+1,b) > ν(a,b) 单调(更多成功 → 更高指数);
 *   3. α+β → ∞ 时学习溢价 → 0(探索自我终结);
 *   4. 恒成功臂 (p=1) 指数恰为 1;
 *   5. 多臂截断视界 DP 对照: 索引策略折扣价值 ≥ 最优价值 − 容差(最优性的实证检查)。
 *
 * 可用性折算(Whittle 一阶): 熔断/不健康使臂成为「躁动臂」(restless)。精确 Whittle 指数
 * 一般不可判定(PSPACE-hard), 本内核取一阶折算 effectiveIndex = ν × availability,
 * availability ∈ [0,1] 由调用方按熔断/健康状态折算, 0 表示不可用直接剔除。
 */

export interface GittinsConfig {
  /** 贴现因子 γ ∈ (0,1): 一步未来的奖励折算比例 */
  discount: number;
  /** 后验计数网格上限 N = α+β ≤ maxCount, 超出按比例钳制到边界(学习溢价已趋零) */
  maxCount: number;
  /** 无差异退休金 R 的二分轮数(精度 2^{-rounds}) */
  bisectionRounds: number;
}

export const DEFAULT_GITTINS_CONFIG: GittinsConfig = {
  discount: 0.95,
  maxCount: 48,
  bisectionRounds: 26,
};

export interface GittinsSnapshot {
  discount: number;
  maxCount: number;
  computedStates: number;
  cacheHits: number;
}

interface TableEntry {
  index: number;
  clamped: boolean;
}

/** 惰性 Gittins 指数表: 每个后验状态首次查询时精确计算并缓存 */
export class GittinsIndexTable {
  private readonly discount: number;
  private readonly maxCount: number;
  private readonly bisectionRounds: number;
  private readonly cache = new Map<string, TableEntry>();
  private cacheHits = 0;

  constructor(config?: Partial<GittinsConfig>) {
    const cfg = { ...DEFAULT_GITTINS_CONFIG, ...config };
    if (cfg.discount <= 0 || cfg.discount >= 1) {
      throw new Error(`GittinsIndexTable: discount 必须在 (0,1) 开区间, 收到 ${cfg.discount}`);
    }
    this.discount = cfg.discount;
    this.maxCount = Math.max(4, Math.floor(cfg.maxCount));
    this.bisectionRounds = Math.max(8, Math.floor(cfg.bisectionRounds));
  }

  /**
   * 状态 (α, β) 的 Gittins 指数。计数超网格时按比例钳制到边界并标记 clamped
   * (大样本后验的学习溢价本就趋零, 钳制误差有界)。
   */
  index(alpha: number, beta: number): number {
    let a = Math.max(1, Math.round(alpha));
    let b = Math.max(1, Math.round(beta));
    let clamped = false;
    const n = a + b;
    if (n > this.maxCount) {
      const scale = this.maxCount / n;
      a = Math.max(1, Math.floor(a * scale));
      b = Math.max(1, this.maxCount - a);
      clamped = true;
    }
    const key = `${a}:${b}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cacheHits += 1;
      return hit.index;
    }
    const value = this.computeIndex(a, b);
    this.cache.set(key, { index: value, clamped });
    return value;
  }

  /** 是否经过了网格钳制(审计口径) */
  clamped(alpha: number, beta: number): boolean {
    return Math.round(alpha) + Math.round(beta) > this.maxCount;
  }

  snapshot(): GittinsSnapshot {
    return {
      discount: this.discount,
      maxCount: this.maxCount,
      computedStates: this.cache.size,
      cacheHits: this.cacheHits,
    };
  }

  /**
   * 核心: 对退休金 R 反向归纳求 V_R(a0,b0), 返回「播放是否最优」。
   * 只在 (a0,b0) 可达的三角形 (a≥a0, b≥b0, a+b ≤ maxCount) 上归纳。
   */
  private playOptimal(a0: number, b0: number, R: number): boolean {
    const gamma = this.discount;
    const inv = 1 / (1 - gamma);
    const retire = R * inv;
    const n0 = a0 + b0;
    // v.get(`${a}:${b}`) 按 n 降序填入, 后继状态必已就绪(DAG)
    const v = new Map<string, number>();
    for (let n = this.maxCount; n >= n0; n--) {
      for (let a = a0; a <= n - b0; a++) {
        const b = n - a;
        const p = a / n;
        let playV: number;
        if (n === this.maxCount) {
          // 边界: 后验视为收敛, 播放即永续开采均值流
          playV = p * inv;
        } else {
          const vS = v.get(`${a + 1}:${b}`) ?? p * inv;
          const vF = v.get(`${a}:${b + 1}`) ?? p * inv;
          playV = p * (1 + gamma * vS) + (1 - p) * (gamma * vF);
        }
        v.set(`${a}:${b}`, Math.max(retire, playV));
      }
    }
    // 根节点必须用「播放分支原值」与退休比较 —— 值函数(max) ≥ 退休恒真, 直接比较会使 ν≡1。
    // 播放分支关于 R 单调不增(后继更早退休压低持续价值), 退休值关于 R 递增 → 交点唯一, 二分合法。
    const p0 = a0 / (a0 + b0);
    const rootPlay = a0 + b0 === this.maxCount
      ? p0 * inv
      : p0 * (1 + gamma * (v.get(`${a0 + 1}:${b0}`) ?? p0 * inv))
        + (1 - p0) * (gamma * (v.get(`${a0}:${b0 + 1}`) ?? p0 * inv));
    return rootPlay >= retire - 1e-12;
  }

  private computeIndex(a: number, b: number): number {
    // ν = sup{ R : 播放最优 }; R=0 必然播放, R 单调淘汰播放 → 二分
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < this.bisectionRounds; i++) {
      const mid = (lo + hi) / 2;
      if (this.playOptimal(a, b, mid)) lo = mid;
      else hi = mid;
    }
    return round(lo);
  }
}

export interface IndexArm {
  id: string;
  /** 成功次数(加权计数亦可为小数, 内部取整钳制) */
  successes: number;
  failures: number;
  /** 可用性 ∈ [0,1], 缺省 1; 熔断 open → 建议 0, half-open → 建议 0.3~0.5 */
  availability?: number;
}

export interface ArmIndex {
  id: string;
  alpha: number;
  beta: number;
  posteriorMean: number;
  gittinsIndex: number;
  /** 学习溢价 = ν − p̂ ≥ 0(定理保证): 越不确定越值得探索 */
  learningPremium: number;
  availability: number;
  /** ν × availability(Whittle 一阶折算), 调度依据 */
  effectiveIndex: number;
  rank: number;
  clamped: boolean;
}

/**
 * 索引调度器: 把候选模型(臂)按 effectiveIndex 降序排列。
 * 与 UCB 的本质区别: UCB 是乐观置信上界启发式, Gittins 是折扣 bandit 的
 * **可证明最优**指数; 挂载后调度器的候选排序升级为最优口径(零漂移: 不挂载即旧行为)。
 */
export class IndexScheduler {
  private readonly table: GittinsIndexTable;

  constructor(table?: GittinsIndexTable) {
    this.table = table ?? new GittinsIndexTable();
  }

  getTable(): GittinsIndexTable {
    return this.table;
  }

  rank(arms: IndexArm[]): ArmIndex[] {
    const scored: ArmIndex[] = [];
    for (const arm of arms) {
      if (!arm || typeof arm.id !== 'string' || !arm.id) continue;
      const availability = clamp01(arm.availability ?? 1);
      if (availability <= 0) continue; // 不可用臂剔除
      const alpha = 1 + Math.max(0, arm.successes);
      const beta = 1 + Math.max(0, arm.failures);
      const posteriorMean = alpha / (alpha + beta);
      const gittinsIndex = this.table.index(alpha, beta);
      scored.push({
        id: arm.id,
        alpha,
        beta,
        posteriorMean: round(posteriorMean),
        gittinsIndex,
        learningPremium: round(gittinsIndex - posteriorMean),
        availability: round(availability),
        effectiveIndex: round(gittinsIndex * availability),
        rank: 0,
        clamped: this.table.clamped(alpha, beta),
      });
    }
    scored.sort((x, y) => y.effectiveIndex - x.effectiveIndex || x.id.localeCompare(y.id));
    scored.forEach((s, i) => { s.rank = i + 1; });
    return scored;
  }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
