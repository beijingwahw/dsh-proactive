/**
 * curriculum-learning.ts — 课程学习内核（项目 59.0「怎么学有了课程论」质变基座）
 *
 * 升级前的根本局限（好奇心与训练的「乱试」天花板）：
 * 自主探索（好奇心引擎 / 策略进化沙盒 / 任务生成）的难度调度只有
 * 三种朴素形态，全都对「学习发生在哪里」一无所知：
 * - **均匀乱试**：预算平摊在早已掌握的舒适区（p→1，练了等于没练）
 *   与远超当前的绝望区（p→0，无成功信号可学）——两头都是浪费；
 * - **最难优先**：早期成功率 ≈ 0，练习既无反馈也无增益，卡死在
 *   绝望之谷里等待概率极小的运气（有梯度的地方它偏不去）；
 * - **固定顺序**：现实中难度常常**非单调**（某一层是墙、绕过更易），
 *   固定阶梯在墙前死锁——「必须爬完每一级」不是定理而是执念。
 * 更根本的：**「练够了没有」从未被定义**——没有掌握的度量，
 * 晋升与回退就只能靠拍脑袋的水位魔数。
 *
 * 本内核引入课程学习（Vygotsky 最近发展区；Bengio et al. 2009
 * Curriculum Learning；Graves et al. 2017 自动课程学习）：
 *
 * 1. **学习者模型（幂律强度 + 逻辑成功）**：知识组件强度随练习
 *    幂律增长 θ(E) = a·E^b（收益递减是技能学习的普遍标度律），
 *      P(成功 | 层 L, 经验 E) = σ(a·E^b − 难度_L)
 *    难度以 logit 单位标定，层与经验共同决定成功率。
 *
 * 2. **增益窗口（desirable difficulty 倒 U）**：每次练习的经验增益
 *      g(p) = 4·p·(1−p)·c ∈ [0, c]
 *    p→1 无新知（已掌握，练习是空转）、p→0 无信号（必败局学不到
 *    东西），峰值在 p=0.5——**学习只发生在能力的边缘**。这一条
 *    让「课程」从教育学的善意变成可计算的调度目标：好的课程
 *    始终把学习者骑在增益前沿上。
 *
 * 3. **掌握门限状态机（mastery curriculum）**：当前层的后验
 *    P(成功|层) ≥ θ 连续 r 次 → 升层；连续 s 次失败 → 降层
 *    （防挫折回退——退一级不是惩罚，是回到有增益的地方）。
 *    「练够了」第一次有了定义：后验掌握证据 + 连续性确认。
 *
 * 4. **Thompson 课程（对练习效用做后验采样 + 锚定单调信念）**：
 *    各层维护成功率后验，每步采样 θ̂_L，选**采样效用** 4θ̂(1−θ̂)
 *    最大者——把「增益窗口」本身当作 Thompson 的效用函数。未试
 *    层先验宽 = 自动探索；已掌握（θ̂→1）与绝望（θ̂→0）的层采样
 *    效用 → 0，预算自动集中前沿。计数指数衰减，但衰减后锚回
 *    「上次已知成功率」且只向上修正（经验只增 → 成功率只升不降
 *    ——对技能成长世界的诚实信念）——**前沿会自己退移，课程会
 *    自己升班**。非单调难度（墙）下墙层信念锁死在 ≈0、效用≈0
 *    永不被选，墙后的可学层照常被发现（绕得过去）。
 *
 * 5. **对照基线**：随机层（均匀乱试）/ 最难优先（绝望之谷驻留）。
 *
 * 与既有内核的关系：10.0 科学家内核设计「对世界提什么问」，
 * 本内核决定「先学哪一课」（提问的难度调度）；14.0 质量-多样性
 * 保护行为地图的覆盖，本内核决定每张地图上练习的爬阶路径；
 * 31.0 在线学习管「学多快」（权重更新），本内核管「学多难」
 * （任务难度选择）——三层正交，合成完整的训练经济学。
 *
 * 验证锚点：
 * ① 三策略 200 种子：达到顶层所需试验数中位数 课程 < 随机 < 最难
 *   （配对胜率统计）；② 课程法困死率（限定步数内未达顶层）显著
 *   最低；③ 非单调难度（墙）下 Thompson 课程仍自适应（胜过固定
 *   阶梯）；④ 掌握门限升/降级状态机的构造轨迹单测。
 *
 * 应用：好奇心引擎 / 策略进化沙盒——自主探索从「乱试」变「有序
 * 爬阶」；训练任务生成课程化（难度分档 + 掌握门限晋升）。
 *
 * ── 第五轮世界性进化（R5-A15，四轴）──
 * 1. [数学] 课程的最优排序定理（机器验证口径）：增益函数 h(E,d) =
 *    4p(1−p)·c 的前沿 frontierLevel(E) = argmax_L g(p_L(E)) 给出
 *    「当前最值得练的层」。三条可机器检验的主张：
 *    (T1) 前沿难度单调（frontierCertificate 的 (i)）⟺ 贪心课程
 *    （每步练前沿层）的练习难度单调不减——「课程会自己升班」；
 *    (T2) 冷启动下「按难度升序」≥「最难优先」（regret 差
 *    ascendingOverHardest ≥ 0——升序的练习始终骑在增益前沿附近，
 *    最难优先在绝望之谷空转）；
 *    (T3) 同预算的前沿贪心 ≥ 全部 m! 固定排列的最大终态经验
 *    （自适应前沿追踪支配一切固定课程——枚举零反例）。
 *    注：「升序 = 全排列 argmax」不是定理——近距难度世界存在反例
 *    （先收割略低于峰的层穿过峰值更划算），枚举审计如实报告
 *    ascendingIsOptimal；Lipschitz 充分条件（max|∂h/∂E| ≤ 1）在
 *    b < 1 时于 E→0 天然不满足（θ′ 发散），降级为诊断量——诚实边界。
 *    墙层（levelsNeverFrontier）：前沿永不经过的层——升序排列会
 *    浪费一块预算的层，贪心课程自动绕行。
 * 2. [数学] 教师-学生双向课程（MentoredCurriculum）：教师（任意
 *    CurriculumPolicy）提名，学生侧 Beta(1+s,1+f) 后验构造 Vygotsky
 *    门控——「够得着边界」border = 最高后验 ≥ zoneThreshold 的层，
 *    ZPD 窗口 = [0, border+1]：越窗提案（绝望区）压回上缘、已掌握
 *    提案顶到上缘、其余照准。课程不再单向：学生的掌握状态实时
 *    反馈调节教师的提案（盲教师被门控成有序爬阶，好教师不劣化）。
 * 3. [数值] 证书的斜率用中心差分（h 光滑、无 kink）；后验全
 *    Beta 域（(1+s)/(2+s+f) 分母恒 ≥ 2——无除零路径）。
 * 4. [性质] 种子化 ≥200 世界批量断言：证书单调性 + 墙层检出、
 *    (T2)(T3) 枚举复核、门控课程对盲教师的改造胜率（配对 200 种子）。
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
  let v = rng();
  while (v <= 1e-12) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape, 1) 样本（Marsaglia–Tsang 舍选；shape < 1 用 u^{1/shape} 提升） */
function gammaSample(shape: number, rng: () => number): number {
  if (shape <= 0) return 0;
  if (shape < 1) return gammaSample(shape + 1, rng) * Math.pow(rng(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 1000; i += 1) {
    const x = standardNormal(rng);
    const vBase = 1 + c * x;
    if (vBase <= 0) continue;
    const v = vBase * vBase * vBase;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d; // 舍选千次未中（概率 ~0）：退化为均值，保持确定性
}

/** Beta(α, β) 样本（两独立 Gamma 之比；Thompson 采样用） */
function betaSample(alpha: number, beta: number, rng: () => number): number {
  const x = gammaSample(alpha, rng);
  const y = gammaSample(beta, rng);
  const denom = x + y;
  return denom > 0 ? x / denom : 0.5;
}

// ─────────────────────────── 学习者世界 ───────────────────────────

/** 学习者世界：难度阶梯 + 幂律成长参数（「学什么」的环境侧） */
export interface LearnerWorld {
  /** 各层真实难度（logit 单位；下标即层号——允许非单调（墙），不要求有序） */
  difficulties: number[];
  /** 强度幂律 θ(E) = a·E^b 的系数 a（> 0） */
  growthA: number;
  /** 强度幂律指数 b（∈ (0,1]：收益递减） */
  growthB: number;
  /** 经验增益满格缩放 c（缺省 1） */
  gainScale?: number;
  /** 初始经验 E₀（缺省 0：首层成功率恰为 σ(−难度₀)） */
  initialExperience?: number;
}

/** 标准六层阶梯（验证与缺省锚定用）：难度等距 0..8.5 logit，幂律 θ(E)=1.6·E^0.7 */
export const STANDARD_LADDER: LearnerWorld = {
  difficulties: [0, 1.7, 3.4, 5.1, 6.8, 8.5],
  growthA: 1.6,
  growthB: 0.7,
  gainScale: 1,
  initialExperience: 0,
};

/** P(成功 | 层 L, 经验 E) = σ(a·E^b − 难度_L) —— 内核的成功率定律 */
export function learnerSuccessProb(world: LearnerWorld, level: number, experience: number): number {
  const d = world.difficulties[level];
  if (d === undefined) throw new Error(`curriculum-learning: 层 ${level} 不存在（共 ${world.difficulties.length} 层）`);
  return sigmoid(world.growthA * Math.pow(Math.max(0, experience), world.growthB) - d);
}

/** 单次练习的经验增益 g(p) = 4p(1−p)·c（倒 U：学习只发生在能力边缘） */
export function practiceGain(world: LearnerWorld, successProb: number): number {
  const c = world.gainScale ?? 1;
  return c * 4 * successProb * (1 - successProb);
}

/** 数值稳定性友好的 logistic */
function sigmoid(x: number): number {
  if (x >= 0) {
    const e = Math.exp(-x);
    return 1 / (1 + e);
  }
  const e = Math.exp(x);
  return e / (1 + e);
}

// ─────────────────────────── 课程策略接口 ───────────────────────────

/** 课程策略：nextLevel() 选下一练习层，report() 回收成败证据 */
export interface CurriculumPolicy {
  /** 策略名（统计报告用） */
  readonly name: string;
  /** 选择下一个练习层（0..m−1） */
  nextLevel(): number;
  /** 回收一次练习结局（层, 成败）——策略据此更新内部状态 */
  report(level: number, success: boolean): void;
  /** 重置状态（可换种子；缺省回到构造种子）——复跑/多种子统计用 */
  reset(seed?: number): void;
}

// ─────────────────────────── 掌握门限课程（状态机） ───────────────────────────

/** 掌握门限课程配置 */
export interface MasteryOptions {
  /** 层数 m（层数组长度，1-based 层号上限 m−1） */
  levelCount: number;
  /** 掌握门限 θ：后验 P(成功|当前层) ≥ θ 才允许晋升（缺省 0.75） */
  threshold?: number;
  /** 连续 r 次成功（且后验达标）→ 升层（缺省 3） */
  promoteR?: number;
  /** 连续 s 次失败 → 降层（缺省 2，防挫折回退） */
  demoteS?: number;
}

/**
 * 掌握门限课程（固定阶梯 + 升降级状态机）。
 *
 * 状态转移（每次当前层练习后）：
 *   成功 → 晋升连击 +1、挫败连击清零；失败 → 挫败连击 +1、晋升连击清零；
 *   晋升连击 ≥ r 且 后验均值 ≥ θ 且未到顶层 → 升层；
 *   挫败连击 ≥ s 且不在底层 → 降层。
 * 后验为 Beta(1+成功, 1+失败)（与 10.0 科学家内核同一共轭口径）——
 * 幸运连击推不高稀证据的后验，防「运气晋升」。
 */
export class MasteryCurriculum implements CurriculumPolicy {
  readonly name: string;
  private readonly levelCount: number;
  private readonly threshold: number;
  private readonly promoteR: number;
  private readonly demoteS: number;
  private level = 0;
  private promoteStreak = 0;
  private demoteStreak = 0;
  private readonly successes: number[];
  private readonly failures: number[];

  constructor(options: MasteryOptions) {
    const levelCount = Math.floor(options.levelCount);
    if (!(levelCount >= 1)) throw new Error(`curriculum-learning: levelCount 必须 ≥ 1（收到 ${options.levelCount}）`);
    const threshold = options.threshold ?? 0.75;
    if (!(threshold > 0 && threshold < 1)) throw new Error(`curriculum-learning: threshold 必须在 (0,1)（收到 ${threshold}）`);
    const promoteR = Math.floor(options.promoteR ?? 3);
    const demoteS = Math.floor(options.demoteS ?? 2);
    if (!(promoteR >= 1)) throw new Error(`curriculum-learning: promoteR 必须 ≥ 1（收到 ${options.promoteR}）`);
    if (!(demoteS >= 1)) throw new Error(`curriculum-learning: demoteS 必须 ≥ 1（收到 ${options.demoteS}）`);
    this.name = `mastery(θ=${threshold}, r=${promoteR}, s=${demoteS})`;
    this.levelCount = levelCount;
    this.threshold = threshold;
    this.promoteR = promoteR;
    this.demoteS = demoteS;
    this.successes = new Array<number>(levelCount).fill(0);
    this.failures = new Array<number>(levelCount).fill(0);
  }

  /** 当前所在层 */
  get currentLevel(): number {
    return this.level;
  }

  /** 当前晋升连击（连续成功次数） */
  get promotionStreak(): number {
    return this.promoteStreak;
  }

  /** 当前挫败连击（连续失败次数） */
  get frustrationStreak(): number {
    return this.demoteStreak;
  }

  /** 层 L 的后验 P(成功|L) = Beta(1+s, 1+f) 均值 */
  posteriorMean(level: number): number {
    if (level < 0 || level >= this.levelCount) {
      throw new Error(`curriculum-learning: 后验查询层 ${level} 越界（0..${this.levelCount - 1}）`);
    }
    return (1 + this.successes[level]) / (2 + this.successes[level] + this.failures[level]);
  }

  nextLevel(): number {
    return this.level;
  }

  report(level: number, success: boolean): void {
    if (level < 0 || level >= this.levelCount) {
      throw new Error(`curriculum-learning: report 层 ${level} 越界（0..${this.levelCount - 1}）`);
    }
    if (success) this.successes[level] += 1;
    else this.failures[level] += 1;
    if (level !== this.level) return; // 非当前层练习只积累证据，不驱动状态机
    if (success) {
      this.promoteStreak += 1;
      this.demoteStreak = 0;
    } else {
      this.demoteStreak += 1;
      this.promoteStreak = 0;
    }
    if (this.promoteStreak >= this.promoteR && this.posteriorMean(level) >= this.threshold && this.level < this.levelCount - 1) {
      this.level += 1;
      this.promoteStreak = 0;
      this.demoteStreak = 0;
    } else if (this.demoteStreak >= this.demoteS && this.level > 0) {
      this.level -= 1;
      this.promoteStreak = 0;
      this.demoteStreak = 0;
    }
  }

  reset(): void {
    this.level = 0;
    this.promoteStreak = 0;
    this.demoteStreak = 0;
    this.successes.fill(0);
    this.failures.fill(0);
  }
}

/** 掌握门限课程工厂（规格签名：masteryCurriculum({threshold, promoteR, demoteS})） */
export function masteryCurriculum(options: MasteryOptions): MasteryCurriculum {
  return new MasteryCurriculum(options);
}

// ─────────────────────────── Thompson 采样课程 ───────────────────────────

/** Thompson 课程配置 */
export interface ThompsonOptions {
  /** 层数 m */
  levelCount: number;
  /** 计数衰减系数 γ ∈ (0,1]（缺省 0.98：滑窗跟踪成功率漂移；γ=1 关闭遗忘） */
  decay?: number;
  /** 先验锚重 w（缺省 6：证据衰减后后验回落到「上次已知成功率」而非 0.5） */
  anchorWeight?: number;
  /** 采样随机源种子（缺省 20260590） */
  seed?: number;
}

/**
 * Thompson 采样课程（对练习效用做后验采样，锚定遗忘）。
 *
 * 每步对每层采成功率 θ̂_L，选**采样效用** 4θ̂(1−θ̂) 最大者——把
 * 「增益窗口」本身当作 Thompson 的效用函数（对效用后验采样是
 * Thompson 的标准形态）：
 * - 未试过的层先验 Beta(1,1) 宽 → 采样偶尔落在窗口内 → 自动探索；
 * - 已掌握（θ̂→1）与绝望（θ̂→0）的层采样效用 → 0，不再浪费预算；
 * - **锚定遗忘**：计数按 γ 指数衰减，但后验回落到各层「上次已知
 *   成功率」μ_L 的锚先验 Beta(wμ_L+s, w(1−μ_L)+f)，而非回落到
 *   无信息 0.5——已掌握的层保持「已掌握」（不被重新当成未知而
 *   反复重探），成功率随学习者成长向上漂移时新证据仍会接管
 *   （**前沿会自己退移，课程会自己升班**）。
 * 非单调难度（墙）下不被阶梯顺序绑架：墙层 μ_L 锁死在 ≈0、
 * 效用≈0 永不被选；墙后的可学层照常被发现（绕得过去）。
 */
export class ThompsonCurriculum implements CurriculumPolicy {
  readonly name: string;
  private readonly levelCount: number;
  private readonly decay: number;
  private readonly anchor: number;
  private readonly seed: number;
  private rng: () => number;
  private successes: number[];
  private failures: number[];
  private means: number[];

  constructor(options: ThompsonOptions) {
    const levelCount = Math.floor(options.levelCount);
    if (!(levelCount >= 1)) throw new Error(`curriculum-learning: levelCount 必须 ≥ 1（收到 ${options.levelCount}）`);
    const decay = options.decay ?? 0.98;
    if (!(decay > 0 && decay <= 1)) throw new Error(`curriculum-learning: decay 必须在 (0,1]（收到 ${options.decay}）`);
    const anchor = options.anchorWeight ?? 6;
    if (!(anchor >= 0)) throw new Error(`curriculum-learning: anchorWeight 必须 ≥ 0（收到 ${options.anchorWeight}）`);
    if (!Number.isFinite(options.seed ?? 20260590)) throw new Error('curriculum-learning: seed 必须为有限数');
    this.name = `thompson(γ=${decay}, w=${anchor})`;
    this.levelCount = levelCount;
    this.decay = decay;
    this.anchor = anchor;
    this.seed = Math.floor(options.seed ?? 20260590);
    this.rng = mulberry32(this.seed);
    this.successes = new Array<number>(levelCount).fill(0);
    this.failures = new Array<number>(levelCount).fill(0);
    this.means = new Array<number>(levelCount).fill(0.5);
  }

  nextLevel(): number {
    let best = 0;
    let bestUtility = Number.NEGATIVE_INFINITY;
    for (let level = 0; level < this.levelCount; level += 1) {
      const sample = betaSample(
        this.anchor * this.means[level] + this.successes[level] + 1,
        this.anchor * (1 - this.means[level]) + this.failures[level] + 1,
        this.rng,
      );
      const utility = 4 * sample * (1 - sample); // 采样练习效用（增益窗口）
      if (utility > bestUtility) {
        bestUtility = utility;
        best = level;
      }
    }
    return best;
  }

  report(level: number, success: boolean): void {
    if (level < 0 || level >= this.levelCount) {
      throw new Error(`curriculum-learning: report 层 ${level} 越界（0..${this.levelCount - 1}）`);
    }
    // 全层计数衰减（滑窗），登记结局，再把锚均值更新为当前后验均值
    for (let i = 0; i < this.levelCount; i += 1) {
      this.successes[i] *= this.decay;
      this.failures[i] *= this.decay;
    }
    if (success) this.successes[level] += 1;
    else this.failures[level] += 1;
    const alpha = this.anchor * this.means[level] + this.successes[level] + 1;
    const beta = this.anchor * (1 - this.means[level]) + this.failures[level] + 1;
    // 单调信念：经验只增 → 成功率只升不降——锚均值只向上修正
    // （对「技能单调成长」世界类的诚实建模，防已掌握层被重探）
    this.means[level] = Math.max(this.means[level], alpha / (alpha + beta));
  }

  reset(seed?: number): void {
    this.rng = mulberry32(seed === undefined ? this.seed : Math.floor(seed));
    this.successes.fill(0);
    this.failures.fill(0);
    this.means.fill(0.5);
  }
}

/** Thompson 课程工厂（规格签名：thompsonCurriculum()） */
export function thompsonCurriculum(options: ThompsonOptions): ThompsonCurriculum {
  return new ThompsonCurriculum(options);
}

// ─────────────────────────── 对照基线 ───────────────────────────

/** 随机层课程（均匀乱试——「无课程」的诚实基线） */
export class RandomCurriculum implements CurriculumPolicy {
  readonly name = 'random';
  private readonly levelCount: number;
  private readonly seed: number;
  private rng: () => number;

  constructor(options: { levelCount: number; seed?: number }) {
    const levelCount = Math.floor(options.levelCount);
    if (!(levelCount >= 1)) throw new Error(`curriculum-learning: levelCount 必须 ≥ 1（收到 ${options.levelCount}）`);
    this.levelCount = levelCount;
    this.seed = Math.floor(options.seed ?? 20260590);
    this.rng = mulberry32(this.seed);
  }

  nextLevel(): number {
    return Math.floor(this.rng() * this.levelCount);
  }

  report(): void {
    // 证据盲策略：成败一概不看
  }

  reset(seed?: number): void {
    this.rng = mulberry32(seed === undefined ? this.seed : Math.floor(seed));
  }
}

/** 最难优先课程（永远顶层——「硬刚」的诚实基线，绝望之谷驻留者） */
export class HardestFirstCurriculum implements CurriculumPolicy {
  readonly name = 'hardest-first';
  private readonly top: number;

  constructor(options: { levelCount: number }) {
    const levelCount = Math.floor(options.levelCount);
    if (!(levelCount >= 1)) throw new Error(`curriculum-learning: levelCount 必须 ≥ 1（收到 ${options.levelCount}）`);
    this.top = levelCount - 1;
  }

  nextLevel(): number {
    return this.top;
  }

  report(): void {
    // 证据盲策略
  }

  reset(): void {
    // 无内部状态
  }
}

/** 随机层课程工厂 */
export function randomCurriculum(options: { levelCount: number; seed?: number }): RandomCurriculum {
  return new RandomCurriculum(options);
}

/** 最难优先课程工厂 */
export function hardestFirstCurriculum(options: { levelCount: number }): HardestFirstCurriculum {
  return new HardestFirstCurriculum(options);
}

// ─────────────────── 第五轮进化：前沿 / 最优排序定理 ───────────────────

/**
 * 前沿层：argmax_L g(p_L(E))（当前增益最大的层——desirable difficulty
 * 的落点）。平局取更低难度层（保守爬阶，确定性）。
 */
export function frontierLevel(world: LearnerWorld, experience: number): number {
  validateWorld(world);
  let best = 0;
  let bestGain = Number.NEGATIVE_INFINITY;
  for (let level = 0; level < world.difficulties.length; level += 1) {
    const gain = practiceGain(world, learnerSuccessProb(world, level, experience));
    if (gain > bestGain) {
      bestGain = gain;
      best = level;
    }
  }
  return best;
}

/** 前沿证书：最优排序定理的机器检验读出 */
export interface FrontierCertificate {
  /** (i) 前沿难度在 E 网格上单调不减（「课程会自己升班」的结构条件） */
  readonly monotone: boolean;
  readonly violations: number;
  /** 首个前沿难度下降点（E、from、to）——非单调世界的检出器 */
  readonly firstViolation: { experience: number; fromLevel: number; toLevel: number } | null;
  /** 墙层清单：证书的 E 检查范围（缺省 = 最难层 p ≥ 0.99 的 E；可显式
   *  eMax 收窄为「课程地平线」）内从未成为前沿的层——规划视野内前沿
   *  绕行的隐形墙检出器（升序排列会浪费一块预算的层，贪心自动绕行） */
  readonly levelsNeverFrontier: number[];
  /** 交换论证 Lipschitz 条件 max|∂h/∂E| ≤ 1 的实测最大斜率（诊断量——
   *  b < 1 时 θ′ = abE^{b−1} 在 E→0 发散，充分条件天然过强，定理主张
   *  改由全排列枚举复核，见 enumerateScheduleOptimality） */
  readonly maxAbsSlope: number;
  /** Lipschitz 充分条件是否成立（诊断；不作为定理开关） */
  readonly exchangeLipschitzHolds: boolean;
  readonly gridPoints: number;
  readonly eMax: number;
  /** 定理口径可用 = (i) 前沿单调（升序 ≥ 最难优先 + 贪心层序单调的机器检验前提） */
  readonly orderingTheoremApplies: boolean;
}

/** E 上界求解：最难关 p ≥ 0.99 的最小 E（倍增搜索，上限 1e9） */
function experienceForMastery(world: LearnerWorld): number {
  const hardest = Math.max(...world.difficulties);
  let hi = 1;
  for (let guard = 0; guard < 60; guard += 1) {
    const p = sigmoid(world.growthA * Math.pow(hi, world.growthB) - hardest);
    if (p >= 0.99 || hi > 1e9) return hi;
    hi *= 2;
  }
  return hi;
}

/**
 * 前沿证书（定理假设的机器检验）：
 * - (i) 前沿难度单调：E 网格上 frontierLevel 的难度值单调不减——
 *   「课程会自己升班」的结构条件；
 * - 墙层检出：从未成为前沿的层（难度非单调世界的前沿绕行点——
 *   升序排列会浪费的块，贪心课程自动绕过）；
 * - 斜率诊断：max_E |∂h/∂E|（中心差分）——交换论证的 Lipschitz
 *   充分条件在 b < 1 时于 E→0 处天然不满足（θ′ 发散），故仅作诊断
 *   量报告，定理主张（升序 ≥ 最难优先、贪心 ≥ 最优固定排列）由
 *   enumerateScheduleOptimality 的全排列枚举逐世界复核。
 */
export function frontierCertificate(world: LearnerWorld, options?: { eMax?: number; grid?: number }): FrontierCertificate {
  validateWorld(world);
  const m = world.difficulties.length;
  const eMax = options?.eMax ?? experienceForMastery(world);
  const grid = Math.max(2, Math.floor(options?.grid ?? 480));
  const e0 = world.initialExperience ?? 0;
  let violations = 0;
  let firstViolation: { experience: number; fromLevel: number; toLevel: number } | null = null;
  const everFrontier = new Array<boolean>(m).fill(false);
  let prevLevel = frontierLevel(world, e0);
  everFrontier[prevLevel] = true;
  for (let i = 1; i <= grid; i += 1) {
    const e = e0 + ((eMax - e0) * i) / grid;
    const level = frontierLevel(world, e);
    everFrontier[level] = true;
    if (world.difficulties[level]! < world.difficulties[prevLevel]!) {
      violations += 1;
      if (firstViolation === null) firstViolation = { experience: e, fromLevel: prevLevel, toLevel: level };
    }
    prevLevel = level;
  }
  // 斜率诊断：|h(E+δ) − h(E−δ)| / 2δ，δ = max(eMax·1e-4, 1e-9)
  const delta = Math.max(eMax * 1e-4, 1e-9);
  let maxAbsSlope = 0;
  for (let level = 0; level < m; level += 1) {
    for (let i = 0; i <= grid; i += 1) {
      const e = e0 + ((eMax - e0) * i) / grid;
      const hi = practiceGain(world, learnerSuccessProb(world, level, e + delta));
      const lo = practiceGain(world, learnerSuccessProb(world, level, Math.max(0, e - delta)));
      const slope = Math.abs(hi - lo) / (e + delta - Math.max(0, e - delta));
      if (Number.isFinite(slope)) maxAbsSlope = Math.max(maxAbsSlope, slope);
    }
  }
  const monotone = violations === 0;
  const levelsNeverFrontier: number[] = [];
  for (let level = 0; level < m; level += 1) {
    if (!everFrontier[level]) levelsNeverFrontier.push(level);
  }
  return {
    monotone,
    violations,
    firstViolation,
    levelsNeverFrontier,
    maxAbsSlope,
    exchangeLipschitzHolds: maxAbsSlope <= 1 + 1e-9,
    gridPoints: grid + 1,
    eMax,
    orderingTheoremApplies: monotone,
  };
}

/** 期望增益爬阶结果（确定性，无伯努利噪声） */
export interface ExpectedGainScheduleResult {
  /** 练习层序（长度 = order.length × reps） */
  readonly sequence: number[];
  readonly repsPerLevel: number;
  /** 终态经验 E_T */
  readonly finalExperience: number;
  /** 逐步经验轨迹（长度 = sequence.length + 1，[0] = 初始） */
  readonly experienceTrace: number[];
  /** 总增益 = finalExperience − initialExperience */
  readonly totalGain: number;
}

/**
 * 确定性期望增益爬阶：按 order 逐层各练 reps 次，每步
 * E ← E + g(p_L(E))（期望口径——定理与枚举的载体，无随机噪声）。
 */
export function expectedGainSchedule(
  world: LearnerWorld,
  order: ReadonlyArray<number>,
  options?: { reps?: number; initialExperience?: number },
): ExpectedGainScheduleResult {
  validateWorld(world);
  const m = world.difficulties.length;
  if (!Array.isArray(order) || order.length === 0) throw new Error('curriculum-learning: order 须为非空层数组');
  for (const level of order) {
    if (!Number.isInteger(level) || level < 0 || level >= m) {
      throw new Error(`curriculum-learning: order 含非法层 ${String(level)}（0..${m - 1}）`);
    }
  }
  const reps = Math.floor(options?.reps ?? 4);
  if (!(reps >= 1)) throw new Error(`curriculum-learning: reps 必须 ≥ 1（收到 ${options?.reps}）`);
  const e0 = options?.initialExperience ?? world.initialExperience ?? 0;
  const sequence: number[] = [];
  const experienceTrace: number[] = [e0];
  let e = e0;
  for (const level of order) {
    for (let r = 0; r < reps; r += 1) {
      e += practiceGain(world, learnerSuccessProb(world, level, e));
      sequence.push(level);
      experienceTrace.push(e);
    }
  }
  return { sequence, repsPerLevel: reps, finalExperience: e, experienceTrace, totalGain: e - e0 };
}

/** 前沿贪心课程（确定性）：每步练当前增益最大的层 */
export interface FrontierGreedyResult {
  readonly sequence: number[];
  readonly finalExperience: number;
  readonly experienceTrace: number[];
  /** 贪心层序的难度是否单调不减（证书 (i) 的轨迹复核） */
  readonly difficultyMonotone: boolean;
}

/** 前沿贪心爬阶：每步选 frontierLevel(E)（步数固定，无随机） */
export function frontierGreedySchedule(
  world: LearnerWorld,
  options?: { steps?: number; initialExperience?: number },
): FrontierGreedyResult {
  validateWorld(world);
  const steps = Math.floor(options?.steps ?? 24);
  if (!(steps >= 1)) throw new Error(`curriculum-learning: steps 必须 ≥ 1（收到 ${options?.steps}）`);
  const e0 = options?.initialExperience ?? world.initialExperience ?? 0;
  const sequence: number[] = [];
  const experienceTrace: number[] = [e0];
  let e = e0;
  let monotone = true;
  let prevDifficulty = Number.NEGATIVE_INFINITY;
  for (let t = 0; t < steps; t += 1) {
    const level = frontierLevel(world, e);
    const d = world.difficulties[level]!;
    if (d < prevDifficulty) monotone = false;
    prevDifficulty = d;
    e += practiceGain(world, learnerSuccessProb(world, level, e));
    sequence.push(level);
    experienceTrace.push(e);
  }
  return { sequence, finalExperience: e, experienceTrace, difficultyMonotone: monotone };
}

/** 排列最优性审计（全枚举） */
export interface ScheduleOptimalityAudit {
  readonly reps: number;
  readonly permutations: number;
  /** 全排列最优终态经验 */
  readonly bestFinalExperience: number;
  /** 达到最优的排列（难度升序稳定排序在列） */
  readonly bestOrders: number[][];
  /** 按难度升序（平局层号升序）排列的终态经验 */
  readonly ascendingFinalExperience: number;
  /** 最难优先排列的终态经验 */
  readonly hardestFirstFinalExperience: number;
  /** 升序 − 最难优先（由易到难的 regret 差，≥ 0 即定理方向成立） */
  readonly ascendingOverHardest: number;
  /** 升序是否为（并列）最优 */
  readonly ascendingIsOptimal: boolean;
  /** 同预算前沿贪心的终态经验（自适应上界参照） */
  readonly greedyFinalExperience: number;
}

/**
 * 排列最优性审计：枚举全部 m! 层块排列（m ≤ 6），逐排列
 * expectedGainSchedule 复核「升序最优」定理；附最难优先对照与同预算
 * 前沿贪心参照。冷启动口径（initialExperience 用世界的或显式给定）。
 */
export function enumerateScheduleOptimality(
  world: LearnerWorld,
  options?: { reps?: number; initialExperience?: number },
): ScheduleOptimalityAudit {
  validateWorld(world);
  const m = world.difficulties.length;
  if (m > 6) throw new Error(`curriculum-learning: 全排列枚举限 m ≤ 6（收到 ${m} 层——720 排列上限）`);
  const reps = Math.floor(options?.reps ?? 4);
  if (!(reps >= 1)) throw new Error(`curriculum-learning: reps 必须 ≥ 1（收到 ${options?.reps}）`);
  const initial = options?.initialExperience ?? world.initialExperience ?? 0;
  const levels = Array.from({ length: m }, (_, i) => i);
  const permutations: number[][] = [];
  const permute = (current: number[], rest: number[]): void => {
    if (rest.length === 0) {
      permutations.push([...current]);
      return;
    }
    for (let i = 0; i < rest.length; i += 1) {
      permute([...current, rest[i]!], [...rest.slice(0, i), ...rest.slice(i + 1)]);
    }
  };
  permute([], levels);
  let best = Number.NEGATIVE_INFINITY;
  let bestOrders: number[][] = [];
  for (const order of permutations) {
    const final = expectedGainSchedule(world, order, { reps, initialExperience: initial }).finalExperience;
    if (final > best + 1e-12) {
      best = final;
      bestOrders = [order];
    } else if (Math.abs(final - best) <= 1e-12) {
      bestOrders.push(order);
    }
  }
  const ascending = [...levels].sort((a, b) => world.difficulties[a]! - world.difficulties[b]! || a - b);
  const hardestFirst = [...levels].sort((a, b) => world.difficulties[b]! - world.difficulties[a]! || b - a);
  const ascendingFinal = expectedGainSchedule(world, ascending, { reps, initialExperience: initial }).finalExperience;
  const hardestFinal = expectedGainSchedule(world, hardestFirst, { reps, initialExperience: initial }).finalExperience;
  const greedy = frontierGreedySchedule(world, { steps: m * reps, initialExperience: initial });
  return {
    reps,
    permutations: permutations.length,
    bestFinalExperience: best,
    bestOrders,
    ascendingFinalExperience: ascendingFinal,
    hardestFirstFinalExperience: hardestFinal,
    ascendingOverHardest: ascendingFinal - hardestFinal,
    ascendingIsOptimal: ascendingFinal >= best - 1e-12,
    greedyFinalExperience: greedy.finalExperience,
  };
}

// ─────────────────── 第五轮进化：教师-学生双向课程 ───────────────────

/** 教师-学生双向课程配置 */
export interface MentorOptions {
  /** 教师策略（任意 CurriculumPolicy——Thompson / mastery / random 均可） */
  readonly teacher: CurriculumPolicy;
  readonly levelCount: number;
  /** 学生 ZPD 下缘判据：层后验均值 ≥ zoneThreshold 视为「够得着」（缺省 0.6） */
  readonly zoneThreshold?: number;
  /** 学生已掌握判据：层后验均值 ≥ masteredHigh 时提案顶到 ZPD 上缘（缺省 0.9） */
  readonly masteredHigh?: number;
}

/**
 * 教师-学生双向课程（学生状态反馈调节课程，Vygotsky 门控）。
 *
 * 学生侧逐层维护 Beta(1+s, 1+f) 掌握后验，「够得着边界」
 * border = 最高的后验 ≥ zoneThreshold 的层（无则 −1），
 * ZPD 窗口 = [0, min(top, border+1)]。教师提名 nextLevel() 后门控：
 * - 提名越过 ZPD 上缘（绝望区）→ 压回上缘 border+1——再难的课先
 *   够着边再上（防绝望之谷驻留）；
 * - 提名层已掌握（后验 ≥ masteredHigh）→ 顶到 ZPD 上缘——已会的
 *   课不再陪练（防舒适区空转）；
 * - 其余照准（ZPD 内或更低——低层重练是巩固不是浪费）。
 * 每次 report() 同时喂教师与学生（双向：教师给方向，学生给门控）。
 * 效果口径：盲教师（均匀乱试）被门控成有序爬阶；好教师
 * （mastery/Thompson）不劣化——学生的掌握状态是教师提案的
 * 结构性护栏。
 */
export class MentoredCurriculum implements CurriculumPolicy {
  readonly name: string;
  private readonly teacher: CurriculumPolicy;
  private readonly levelCount: number;
  private readonly zoneThreshold: number;
  private readonly masteredHigh: number;
  private readonly successes: number[];
  private readonly failures: number[];
  private proposal = 0;

  constructor(options: MentorOptions) {
    if (options.teacher === null || typeof options.teacher !== 'object' || typeof options.teacher.nextLevel !== 'function') {
      throw new Error('curriculum-learning: mentoredCurriculum 的 teacher 须为 CurriculumPolicy（缺 nextLevel 方法）');
    }
    const levelCount = Math.floor(options.levelCount);
    if (!(levelCount >= 1)) throw new Error(`curriculum-learning: levelCount 必须 ≥ 1（收到 ${options.levelCount}）`);
    const zoneThreshold = options.zoneThreshold ?? 0.6;
    if (!(zoneThreshold > 0 && zoneThreshold < 1)) {
      throw new Error(`curriculum-learning: zoneThreshold 必须在 (0,1)（收到 ${zoneThreshold}）`);
    }
    const masteredHigh = options.masteredHigh ?? 0.9;
    if (!(masteredHigh > 0 && masteredHigh < 1)) {
      throw new Error(`curriculum-learning: masteredHigh 必须在 (0,1)（收到 ${masteredHigh}）`);
    }
    if (masteredHigh < zoneThreshold) {
      throw new Error(`curriculum-learning: masteredHigh（${masteredHigh}）须 ≥ zoneThreshold（${zoneThreshold}）`);
    }
    this.name = `mentored(${options.teacher.name})`;
    this.teacher = options.teacher;
    this.levelCount = levelCount;
    this.zoneThreshold = zoneThreshold;
    this.masteredHigh = masteredHigh;
    this.successes = new Array<number>(levelCount).fill(0);
    this.failures = new Array<number>(levelCount).fill(0);
  }

  /** 学生对层 L 的掌握后验均值 Beta(1+s, 1+f)（分母 2+s+f 恒 ≥ 2，无除零） */
  studentPosteriorMean(level: number): number {
    if (level < 0 || level >= this.levelCount) {
      throw new Error(`curriculum-learning: 学生后验查询层 ${level} 越界（0..${this.levelCount - 1}）`);
    }
    return (1 + this.successes[level]!) / (2 + this.successes[level]! + this.failures[level]!);
  }

  /** 够得着边界 border = 最高后验 ≥ zoneThreshold 的层（无则 −1） */
  zoneBorder(): number {
    for (let level = this.levelCount - 1; level >= 0; level -= 1) {
      if (this.studentPosteriorMean(level) >= this.zoneThreshold) return level;
    }
    return -1;
  }

  /** ZPD 上缘 = min(top, border + 1) */
  zoneCeiling(): number {
    return Math.min(this.levelCount - 1, this.zoneBorder() + 1);
  }

  /** 本轮教师原始提案（审计：门控前的提名） */
  lastTeacherProposal(): number {
    return this.proposal;
  }

  nextLevel(): number {
    const proposal = this.teacher.nextLevel();
    this.proposal = proposal;
    if (proposal < 0 || proposal >= this.levelCount) return proposal; // 非法提案原样上抛（simulateLearner 校验）
    const ceiling = this.zoneCeiling();
    if (proposal > ceiling) return ceiling; // 绝望区 → 压回 ZPD 上缘
    if (this.studentPosteriorMean(proposal) >= this.masteredHigh) return ceiling; // 已掌握 → 顶到上缘
    return proposal;
  }

  report(level: number, success: boolean): void {
    if (level < 0 || level >= this.levelCount) {
      throw new Error(`curriculum-learning: report 层 ${level} 越界（0..${this.levelCount - 1}）`);
    }
    if (success) this.successes[level] += 1;
    else this.failures[level] += 1;
    this.teacher.report(level, success); // 双向：证据同时喂教师
  }

  reset(seed?: number): void {
    this.teacher.reset(seed);
    this.successes.fill(0);
    this.failures.fill(0);
    this.proposal = 0;
  }
}

/** 教师-学生双向课程工厂 */
export function mentoredCurriculum(options: MentorOptions): MentoredCurriculum {
  return new MentoredCurriculum(options);
}

// ─────────────────────────── 学习者模拟 ───────────────────────────

/** 模拟选项 */
export interface SimulateOptions {
  /** 世界随机源种子（Bernoulli 成败流；同种子逐位复现） */
  seed: number;
  /** 步数上限（达到顶层即提前停止） */
  steps: number;
  /** 「达到顶层」判据：顶层连续成功次数（缺省 3） */
  consecutiveTop?: number;
}

/** 模拟结果（策略无关的达成度量） */
export interface SimulationResult {
  /** 实际模拟步数（达到顶层即截断） */
  attempts: number;
  /** 是否在步数上限内达到顶层（顶层连续 consecutiveTop 次成功） */
  reachedTop: boolean;
  /** 达到顶层的试验序号（1-based；未达为 null） */
  reachTopAtStep: number | null;
  /** 终态经验 E */
  finalExperience: number;
  /** 总成功次数 */
  totalSuccesses: number;
  /** 顶层练习的成功率（顶层尝试数 > 0 时） */
  topSuccessRate: number | null;
  /** 逐层选择轨迹 */
  levelTrace: number[];
  /** 逐次成败轨迹 */
  successTrace: boolean[];
  /** 逐次练习后的经验轨迹（长度 = attempts） */
  experienceTrace: number[];
}

/**
 * 模拟学习者在一个策略下的完整爬阶过程。
 *
 * 每步：策略选层 → 按定律 σ(a·E^b − 难度) 抽成败 → 经验按倒 U 增益
 * 4p(1−p)·c 累积 → 证据回流策略。「达到顶层」采用策略无关口径：
 * 顶层连续 k 次成功（顶层之外的练习不打断该连击，顶层失败清零）
 * ——所有策略在同一把尺下比较。
 */
export function simulateLearner(
  policy: CurriculumPolicy,
  world: LearnerWorld,
  options: SimulateOptions,
): SimulationResult {
  validateWorld(world);
  const steps = Math.floor(options.steps);
  if (!(steps >= 1)) throw new Error(`curriculum-learning: steps 必须 ≥ 1（收到 ${options.steps}）`);
  const kTop = Math.floor(options.consecutiveTop ?? 3);
  if (!(kTop >= 1)) throw new Error(`curriculum-learning: consecutiveTop 必须 ≥ 1（收到 ${options.consecutiveTop}）`);
  if (!Number.isFinite(options.seed)) throw new Error('curriculum-learning: seed 必须为有限数');
  const m = world.difficulties.length;
  const top = m - 1;
  const rng = mulberry32(Math.floor(options.seed));
  let experience = world.initialExperience ?? 0;
  let topStreak = 0;
  let reachTopAtStep: number | null = null;
  let totalSuccesses = 0;
  let topAttempts = 0;
  let topSuccesses = 0;
  const levelTrace: number[] = [];
  const successTrace: boolean[] = [];
  const experienceTrace: number[] = [];
  for (let t = 0; t < steps; t += 1) {
    const level = policy.nextLevel();
    if (!Number.isInteger(level) || level < 0 || level >= m) {
      throw new Error(`curriculum-learning: 策略 ${policy.name} 返回非法层 ${level}（0..${m - 1}）`);
    }
    const p = learnerSuccessProb(world, level, experience);
    const success = rng() < p;
    experience += practiceGain(world, p);
    policy.report(level, success);
    if (success) totalSuccesses += 1;
    if (level === top) {
      topAttempts += 1;
      if (success) {
        topSuccesses += 1;
        topStreak += 1;
      } else {
        topStreak = 0;
      }
      if (topStreak >= kTop && reachTopAtStep === null) reachTopAtStep = t + 1;
    }
    levelTrace.push(level);
    successTrace.push(success);
    experienceTrace.push(experience);
    if (reachTopAtStep !== null) break;
  }
  return {
    attempts: levelTrace.length,
    reachedTop: reachTopAtStep !== null,
    reachTopAtStep,
    finalExperience: round(experience),
    totalSuccesses,
    topSuccessRate: topAttempts > 0 ? round(topSuccesses / topAttempts) : null,
    levelTrace,
    successTrace,
    experienceTrace,
  };
}

// ─────────────────────────── 多策略对照统计 ───────────────────────────

/** 对照统计选项 */
export interface CompareOptions {
  /** 每策略试验数（缺省 200 种子） */
  trials?: number;
  /** 每次试验步数上限（缺省 400） */
  steps?: number;
  /** 种子基址（第 i 次试验世界种子 = seedBase + i；缺省 1） */
  seedBase?: number;
  /** 顶层达成连击（缺省 3） */
  consecutiveTop?: number;
}

/** 单策略统计 */
export interface PolicyStatistics {
  name: string;
  trials: number;
  /** 步数上限（删失口径用） */
  stepsCap: number;
  /** 达成顶层的试验数 */
  reachedCount: number;
  /** 困死率 = 1 − 达成率（限定步数内未达顶层） */
  stuckRate: number;
  /** 达成试验的步数中位数（无达成为 null） */
  medianSteps: number | null;
  /** 达成试验的步数均值（无达成为 null） */
  meanSteps: number | null;
  /** 删失中位数：困死试验按步数上限计（策略可比的保守口径） */
  medianStepsCensored: number;
  /** 删失均值：困死试验按步数上限计 */
  meanStepsCensored: number;
  /** 达成步数 10 分位（无达成为 null） */
  p10Steps: number | null;
  /** 达成步数 90 分位（无达成为 null） */
  p90Steps: number | null;
  /** 逐试验达成步数（null = 困死）——配对胜率统计用 */
  stepsToTop: Array<number | null>;
}

/**
 * 多策略多种子对照：同一种子（同一世界成败流）跑全部策略（配对
 * 设计），汇总「达到顶层所需试验数」分布与困死率。
 */
export function comparePolicies(
  world: LearnerWorld,
  policies: ReadonlyArray<CurriculumPolicy>,
  options?: CompareOptions,
): PolicyStatistics[] {
  validateWorld(world);
  const trials = Math.floor(options?.trials ?? 200);
  const steps = Math.floor(options?.steps ?? 400);
  const seedBase = Math.floor(options?.seedBase ?? 1);
  const consecutiveTop = Math.floor(options?.consecutiveTop ?? 3);
  if (!(trials >= 1)) throw new Error(`curriculum-learning: trials 必须 ≥ 1（收到 ${options?.trials}）`);
  if (!(steps >= 1)) throw new Error(`curriculum-learning: steps 必须 ≥ 1（收到 ${options?.steps}）`);
  if (policies.length === 0) throw new Error('curriculum-learning: policies 不能为空');
  const perPolicy: Array<Array<number | null>> = policies.map(() => []);
  for (let i = 0; i < trials; i += 1) {
    for (let p = 0; p < policies.length; p += 1) {
      const policy = policies[p];
      policy.reset(seedBase * 7919 + i * 31 + p); // 每试验重播种（策略内部随机源与世界流独立）
      const result = simulateLearner(policy, world, { seed: seedBase + i, steps, consecutiveTop });
      perPolicy[p].push(result.reachTopAtStep);
    }
  }
  return policies.map((policy, index) => summarize(policy.name, perPolicy[index], trials, steps));
}

function summarize(name: string, stepsToTop: Array<number | null>, trials: number, stepsCap: number): PolicyStatistics {
  const reached = stepsToTop.filter((s): s is number => s !== null).sort((a, b) => a - b);
  const median = reached.length > 0 ? quantile(reached, 0.5) : null;
  const mean = reached.length > 0 ? reached.reduce((s, v) => s + v, 0) / reached.length : null;
  const censored = stepsToTop.map((s) => (s === null ? stepsCap : s)).sort((a, b) => a - b);
  return {
    name,
    trials,
    stepsCap,
    reachedCount: reached.length,
    stuckRate: round(1 - reached.length / trials),
    medianSteps: median,
    meanSteps: mean === null ? null : round(mean),
    medianStepsCensored: quantile(censored, 0.5),
    meanStepsCensored: round(censored.reduce((s, v) => s + v, 0) / trials),
    p10Steps: reached.length > 0 ? quantile(reached, 0.1) : null,
    p90Steps: reached.length > 0 ? quantile(reached, 0.9) : null,
    stepsToTop,
  };
}

/** 就地升序数组的分位数（线性插值；输入须已排序） */
function quantile(sorted: ReadonlyArray<number>, q: number): number {
  if (sorted.length === 0) throw new Error('curriculum-learning: 空数组分位数');
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return round(sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]));
}

// ─────────────────────────── 校验与工具 ───────────────────────────

function validateWorld(world: LearnerWorld): void {
  if (!Array.isArray(world.difficulties) || world.difficulties.length === 0) {
    throw new Error('curriculum-learning: difficulties 必须为非空数组');
  }
  for (const d of world.difficulties) {
    if (!Number.isFinite(d)) throw new Error(`curriculum-learning: 难度必须为有限数（收到 ${d}）`);
  }
  if (!(world.growthA > 0) || !Number.isFinite(world.growthA)) {
    throw new Error(`curriculum-learning: growthA 必须 > 0（收到 ${world.growthA}）`);
  }
  if (!(world.growthB > 0 && world.growthB <= 1) || !Number.isFinite(world.growthB)) {
    throw new Error(`curriculum-learning: growthB 必须在 (0,1]（收到 ${world.growthB}）`);
  }
  const scale = world.gainScale ?? 1;
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error(`curriculum-learning: gainScale 必须 > 0（收到 ${world.gainScale}）`);
  const e0 = world.initialExperience ?? 0;
  if (!(e0 >= 0) || !Number.isFinite(e0)) throw new Error(`curriculum-learning: initialExperience 必须 ≥ 0（收到 ${world.initialExperience}）`);
}

function round(x: number): number {
  return Number(x.toFixed(6));
}

/* ── 接线建议 ─────────────────────────────────────────────────────────
 *
 * 1. 好奇心引擎（任务生成的难度调度）：
 *    - 把任务生成器的难度旋钮离散为 difficulties 层（logit 标定：
 *      用历史成功率反解 σ^{-1}，P(成功) 与 logit 难度一一对应）；
 *    - 每次任务结局回填 masteryCurriculum.report(level, success)；
 *      引擎读 nextLevel() 作为下一任务的难度档——探索从均匀乱试
 *      变为掌握门限爬阶。
 *
 * 2. 策略进化沙盒（14.0 QD 的难度侧）：
 *    - 新策略先在低难度层评估（对抗强度分层），mastery 状态机自动
 *      晋升/回退；comparePolicies 的世界即沙盒，晋升轨迹是策略
 *      「学习速度」的可审计画像。
 *
 * 3. 训练任务生成课程化：
 *    - prompt 模板按难度分层，thompsonCurriculum 做无标定冷启动
 *      （后验自动试出带内层），mastery 做有标定主路径；两者可并行
 *      A/B（comparePolicies 即在线对照仪表）。
 *
 * 4. 挂载边界（零介入承诺）：
 *    - 只读挂载：引擎仅调用 nextLevel()/report()，内核不发起任何
 *      调度决策、不写任何状态；未挂载时现有路径逐位一致。
 * ────────────────────────────────────────────────────────────────── */
