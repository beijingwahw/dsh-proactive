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
 * ── R5 进化(第五轮, 2026-10) ──────────────────────────────────────────────
 * A1【数学】计算成本版 Gittins 指数 indexWithCost(α,β,c): 每次拉臂支付恒定
 *   计算成本 c ∈ [0,1)（延迟/算力/注意力口径; Glazebrook 1982 计算成本 bandit /
 *   Weber 1992 第 4 节「calculating costs」谱系）: 播放分支的单步奖励变为
 *   成功 1−c / 失败 −c, 退休 MDP 不变
 *     V^c_R(a,b) = max( R/(1−γ),  p·(1−c + γ·V') + (1−p)·(−c + γ·V') ),
 *   ν^c(a,b) = sup{ R : 播放最优 }。闭式锚点: 已知臂(n→∞) ν^c = p − c 精确;
 *   单调性定理(逐项归纳即可证): ① ν^c 关于 c 不增(播放分支逐点被压低, 退休
 *   不动 ⟹ 交点左移); ② ν^c(a,b) ≥ a/(a+b) − c(学习溢价在成本下存活);
 *   ③ ν^c = 0 时(免费退休金都不值得播放)调度器应永远退休该臂。
 * A2【性能】增量表构建 + 稠密归纳(等价性有证明, 见下):
 *   (i) 归纳三角从 Map<string,number> 换成稠密 Float64Array 暂存(每表一份,
 *       只写本三角形、只读本三角形已写格 —— 无跨调用读污染);
 *   (ii) 二分区间用**既有表项播种**: 单调性引理 ν(a,b+1) ≤ ν(a,b) ≤ ν(a+1,b)
 *       (等价地平移: ν(a−1,b) ≤ ν(a,b) ≤ ν(a,b−1))给出含唯一交点的初始区间,
 *       后验随时间增长的真实查询序列(新状态的前驱恰是旧状态)天然命中缓存;
 *       端点自校验(谓词不成立即回退全域)使正确性不依赖引理——引理只加速。
 *   等价性: 交点 c 唯一(播放分支对 R 单调不增、退休严格增), 新旧二分的最终
 *   区间都含 c 且宽 ≤ 2⁻²⁶ ⟹ 两个返回的 lo 都落在 [c−2⁻²⁶, c] 内,
 *   |ν_new − ν_old| ≤ 2⁻²⁶ ≈ 1.5e-8(1e-6 圆整口径下除贴边点外逐位一致)。
 * A3【数值稳健】平局与圆整的确定性口径文档化: 二分一律取 lo(交点下界),
 *   round(1e-6) 圆整; 谓词比较带 −1e-12 容差(与升级前一致); 播种端点自校验
 *   失败时的回退顺序固定(先回退 lo=0, 再回退 hi=1)——同输入同输出。
 *
 * 关键性质(验证脚本逐条断言):
 *   1. ν ≥ p̂ 恒成立(已知臂的指数 = p̂, 不确定性带来学习溢价);
 *   2. ν(a+1,b) > ν(a,b) 单调(更多成功 → 更高指数);
 *   3. α+β → ∞ 时学习溢价 → 0(探索自我终结);
 *   4. 恒成功臂 (p=1) 指数恰为 1;
 *   5. 多臂截断视界 DP 对照: 索引策略折扣价值 ≥ 最优价值 − 容差(最优性的实证检查);
 *   6. (R5) ν^c 已知臂 = p − c; ν^c 关于 c 单调不增且 ≥ p̂ − c(≥200 种子);
 *   7. (R5) 播种二分与全域二分在 2⁻²⁶ 内一致(网格全状态对照)。
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
  /** (R5) 计算成本版指数的缓存状态数 */
  costComputedStates: number;
  /** (R5) 用既有表项收窄初始区间的二分次数(增量构建命中口径) */
  seededBisections: number;
  /** (R5) 播种端点自校验失败而回退全域的次数(恒为 0 除非单调性引理被破坏) */
  seedFallbacks: number;
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
  /** (R5) 计算成本版指数缓存: key = `${a}:${b}#${cost}` */
  private readonly costCache = new Map<string, number>();
  /** (R5) 稠密归纳暂存(每表一份, 只写当前三角形) */
  private scratch: Float64Array | undefined;
  private cacheHits = 0;
  private seededBisections = 0;
  private seedFallbacks = 0;

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
    const value = this.computeIndex(a, b, 0);
    this.cache.set(key, { index: value, clamped });
    return value;
  }

  /**
   * (R5-A1) 计算成本版 Gittins 指数 ν^c(α, β): 每次拉臂支付恒定成本 c ∈ [0,1)
   * (单步播放奖励 = p − c; 播放价值可为负——这正是成本口径的意义)。
   *
   * 闭式锚点: 大计数已知臂 ν^c → p̂ − c; 单调性: c↑ ⟹ ν^c↓ 且 ν^c ≥ p̂ − c。
   * 与无成本版的序关系: ν^c ≤ ν(成本压低播放)。钳制口径与 index() 一致。
   */
  indexWithCost(alpha: number, beta: number, costPerPlay: number): number {
    if (typeof costPerPlay !== 'number' || !Number.isFinite(costPerPlay) || costPerPlay < 0 || costPerPlay >= 1) {
      throw new Error(`indexWithCost: costPerPlay 必须在 [0,1) 内, 收到 ${costPerPlay}`);
    }
    let a = Math.max(1, Math.round(alpha));
    let b = Math.max(1, Math.round(beta));
    const n = a + b;
    if (n > this.maxCount) {
      const scale = this.maxCount / n;
      a = Math.max(1, Math.floor(a * scale));
      b = Math.max(1, this.maxCount - a);
    }
    const costKey = Math.round(costPerPlay * 1e9);
    const key = `${a}:${b}#${costKey}`;
    const hit = this.costCache.get(key);
    if (hit !== undefined) return hit;
    const value = this.computeIndex(a, b, costPerPlay);
    this.costCache.set(key, value);
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
      costComputedStates: this.costCache.size,
      seededBisections: this.seededBisections,
      seedFallbacks: this.seedFallbacks,
    };
  }

  /**
   * 核心: 对退休金 R 反向归纳求 V_R(a0,b0), 返回「播放是否最优」。
   * 只在 (a0,b0) 可达的三角形 (a≥a0, b≥b0, a+b ≤ maxCount) 上归纳。
   * (R5-A2) 稠密 Float64Array 暂存: 写入只发生在本三角形, 读取只指向
   * 上一层已写格(n+1 层先于 n 层写入)——暂存复用无跨调用读污染。
   * (R5-A1) cost > 0 时播放分支单步奖励右移 −cost, 数学结构(DAG + 交点唯一)不变。
   */
  private playOptimal(a0: number, b0: number, R: number, cost: number): boolean {
    const gamma = this.discount;
    const inv = 1 / (1 - gamma);
    const retire = R * inv;
    const n0 = a0 + b0;
    const stride = this.maxCount + 2;
    if (this.scratch === undefined) {
      this.scratch = new Float64Array(stride * stride);
    }
    const v = this.scratch;
    for (let n = this.maxCount; n >= n0; n--) {
      for (let a = a0; a <= n - b0; a++) {
        const b = n - a;
        const p = a / n;
        let playV: number;
        if (n === this.maxCount) {
          // 边界: 后验视为收敛, 播放即永续开采净均值流
          playV = (p - cost) * inv;
        } else {
          const vS = v[(a + 1) * stride + b];
          const vF = v[a * stride + b + 1];
          playV = p * (1 - cost + gamma * vS) + (1 - p) * (-cost + gamma * vF);
        }
        v[a * stride + b] = Math.max(retire, playV);
      }
    }
    // 根节点必须用「播放分支原值」与退休比较 —— 值函数(max) ≥ 退休恒真, 直接比较会使 ν≡1。
    // 播放分支关于 R 单调不增(后继更早退休压低持续价值), 退休值关于 R 递增 → 交点唯一, 二分合法。
    const p0 = a0 / (a0 + b0);
    const rootPlay = a0 + b0 === this.maxCount
      ? (p0 - cost) * inv
      : p0 * (1 - cost + gamma * v[(a0 + 1) * stride + b0])
        + (1 - p0) * (-cost + gamma * v[a0 * stride + b0 + 1]);
    return rootPlay >= retire - 1e-12;
  }

  /**
   * (R5-A2) 播种二分: 无成本版用缓存中的单调界收窄初始区间。
   * 引理(Weber 1992 口径的数值事实, 本内核不依赖其成立——端点自校验兜底):
   *   ν(a,b+1) ≤ ν(a,b) ≤ ν(a+1,b)  ⟹  平移得 ν(a−1,b) ≤ ν(a,b) ≤ ν(a,b−1)。
   * 后验随时间只增的真实查询流(新状态的前驱 = 旧状态)天然命中:
   *   下界 ← max{ 已缓存 ν(a−1,b), 已缓存 ν(a,b+1) }, 上界 ← min{ 已缓存 ν(a,b−1), 已缓存 ν(a+1,b) }。
   * 等价性见文件头 A2: 交点唯一 + 终区间含交点且宽 ≤ 2⁻²⁶ ⟹ 与全域二分差 ≤ 2⁻²⁶。
   */
  private computeIndex(a: number, b: number, cost: number): number {
    const target = Math.pow(2, -Math.min(30, this.bisectionRounds));
    const pred = (R: number): boolean => this.playOptimal(a, b, R, cost);
    let lo: number;
    let hi: number;
    if (cost === 0) {
      let loSeed = 0;
      let hiSeed = 1;
      let seeded = false;
      const lowerA = a > 1 ? this.cache.get(`${a - 1}:${b}`) : undefined;
      if (lowerA !== undefined && lowerA.index > loSeed) { loSeed = lowerA.index; seeded = true; }
      const lowerB = this.cache.get(`${a}:${b + 1}`);
      if (lowerB !== undefined && lowerB.index > loSeed) { loSeed = lowerB.index; seeded = true; }
      const upperA = b > 1 ? this.cache.get(`${a}:${b - 1}`) : undefined;
      if (upperA !== undefined && upperA.index < hiSeed) { hiSeed = upperA.index; seeded = true; }
      const upperB = this.cache.get(`${a + 1}:${b}`);
      if (upperB !== undefined && upperB.index < hiSeed) { hiSeed = upperB.index; seeded = true; }
      // 全域 [0,1] 恒合法(cost=0 时 pred(0) 恒真、pred(1) 恒假)——无种子时不做校验(零开销)
      if (seeded) {
        this.seededBisections += 1;
        // 端点自校验: 引理被破坏(或浮点贴边)时回退全域——正确性只依赖交点唯一性
        if (!pred(loSeed)) {
          loSeed = 0;
          this.seedFallbacks += 1;
        }
        if (pred(hiSeed)) {
          hiSeed = 1;
          this.seedFallbacks += 1;
        }
        if (loSeed > hiSeed) {
          loSeed = 0;
          hiSeed = 1;
          this.seedFallbacks += 1;
        }
      }
      lo = loSeed;
      hi = hiSeed;
    } else {
      // 成本版: 播放奖励可为负, 指数域 [−1, 1](R=−1 时播放恒优于退休:
      // rootPlay ≥ −c/(1−γ) > −1/(1−γ) = retire 对 c<1 严格成立;
      // R=1 时 retire = 1/(1−γ) ≥ 任意播放值——cost=0 且 p≡1 的极限角点除外,
      // 而 b≥1 的网格状态 p<1 恒成立, 故 pred(1) 恒假)
      lo = -1;
      hi = 1;
      let guard = 0;
      while (!pred(lo) && guard < 16) {
        lo *= 2;
        guard += 1;
      }
    }
    // ν = sup{ R : 播放最优 }; 交点唯一 ⟹ 二分; 终区间宽 ≤ target(与升级前 2⁻²⁶ 同精度)
    while (hi - lo > target) {
      const mid = (lo + hi) / 2;
      if (pred(mid)) lo = mid;
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
 * (确定性平局口径: effectiveIndex 并列按 id 字典序升序——文档化的 tie-break)
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
