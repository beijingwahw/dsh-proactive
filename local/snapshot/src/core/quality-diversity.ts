/**
 * quality-diversity.ts — 质量-多样性进化内核（项目 14.0「进化的多样性有了保证」质变基座）
 *
 * 升级前的根本局限（策略进化的天花板）：
 * 纯适应度进化（精英保留 + 锦标赛 + 变异）只有一个优化目标——
 * 「谁平均分高谁活」。这在环境平稳时是美德，在系统里是慢性病：
 * - **多样性塌缩**：环境一旦变化（负载模式漂移 / 用户习惯迁移 /
 *   模型供应商故障），种群早已收敛到旧最优的小邻域——全部家当
 *   押在一种活法上，环境变脸即全军覆没；
 * - **局部最优陷阱**：适应度相同的高原上，进化随机漂移，永远
 *   走不出「够好但不是最好」的盆地；
 * - **探索无方向**：UCB 探索只看「谁试得少」，不看「哪种活法
 *   从没试过」——行为空间大片区域从未被采样而系统不自知；
 * - **进化不可审计**：种群的基因多样性没有度量，收敛过程不可观测。
 *
 * 本内核引入质量-多样性进化（Mouret & Clune 2015, MAP-Elites；
 * POET 的开放式进化谱系）：
 *
 * 1. **行为描述子（behavior descriptor）**：把候选者的「活法」映射
 *    到低维行为空间（策略基因 → 敢为度 × 节俭度 × 警觉度）——
 *    优化目标从「找到最好的一个」升维为「点亮整张行为地图」。
 *
 * 2. **MAP-Elites 归档（网格精英制）**：行为空间离散化为 niche 网格，
 *    每格只留适应度最高的精英。place() 的准入规则极简而深刻：
 *    **在自己的 niche 里赢过现任就能上位**——全局平庸但本地独特
 *    的候选者第一次有了生存权（全局进化会杀死它们）。
 *
 * 3. **QD 记分（可审计的多样性）**：
 *      QD-score = Σ_{被占据 niche} fitness(elite)
 *      coverage = 被占据 niche / 总 niche
 *    进化的产出第一次可以被度量：不只「最好的多好」，还有
 *    「点亮了多少种活法」。
 *
 * 4. **前沿 niche 采样探索**：从被占据 niche 均匀采样（而非按适应
 *    度加权）——每个「活法流派」获得等量的试验预算，行为空间的
 *    空白区域经变异自然被点亮（好奇心的几何化）。
 *
 * 与 3-13.0 的关系：3.0 的证据统计度量单个候选者的可信度，本内核
 * 度量**种群的健康度**；与 12.0 的淘汰语义互补——12.0 淘汰「证明
 * 差」的个体（纵向收缩），本内核保护「独特」的个体（横向保持），
 * 二者合成「该淘汰的淘汰、该保留的保留」的完整进化语法。
 *
 * ── 第五轮世界性进化（R5-A15，四轴）──
 * 1. [数学] CVT-MAP-Elites（Mouret & Clune 2015）：bins 网格换「质心
 *    Voronoi niche」——配置 centroids 后按最近质心归属 niche（归一化
 *    描述子空间的欧氏距离，平局取低质心下标——确定性）。网格 niche
 *    对行为空间的分布形状一无所知（均匀格切割把样本挤在少数格），
 *    CVT 把 niche 边界贴着样本质量弯折——同数量 niche 下覆盖更均衡
 *    （等量预算性质的来源）。cvtCentroids() 用确定性 Lloyd 迭代
 *    （文件内 mulberry32 种子）产出质心。
 * 2. [数学] 稀疏重启（sparse restart，Mouret & Clune 同款）：place()
 *    逐 niche 记录「连续挑战失败次数」；niche 停滞（挑战失败 ≥
 *    patience）后 sparseRestart() 用变异算子重播该 niche——现任精英
 *    被强制换下（适应度允许下降），探索从停滞点重新出发。精英制的
 *    单调性在 niche 内被有意打破——这是重启的代价，也是逃出局部
 *    最优的代价。
 * 3. [性能] O(1) 哈希 niche 采样：sample() 原先每次采样都展开
 *    [...elites.keys()]（O(k) 分配）；改为首次展开后缓存键数组，仅在
 *    **新** niche 首次占据时失效（既有 niche 的再晋升不改变 Map 键序
 *    ——键集合不变则缓存恒等价）。等价性：Map 迭代序 = 键的首次插入
 *    序，缓存数组恰为该序的快照——采样分布逐位不变（验证锚点对照）。
 * 4. [性质] CVT 等量预算：均匀行为质量下每个 Voronoi niche 的期望
 *    占据份额 ≈ 1/k（体积等分），采样频率均衡；确定性（同种子同
 *    质心同轨迹）——种子化 ≥200 输入的批量断言。
 */

// ─────────────────────────── 确定性随机源（CVT 工厂用） ───────────────────────────

/** mulberry32：32 位确定性伪随机源（同种子同序列——cvtCentroids 可复现） */
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

// ─────────────────────────── 归档配置与报告 ───────────────────────────

/** MAP-Elites 归档配置 */
export interface MapElitesConfig<T> {
  /** 行为空间各维 bins（网格分辨率；缺省每维 4） */
  bins: number[];
  /** 行为空间各维取值范围 [min, max]（描述子应输出该范围内坐标） */
  ranges: Array<[number, number]>;
  /** 行为描述子：候选者 → 行为坐标（维度 = bins.length） */
  descriptor: (candidate: T) => number[];
  /** 适应度（越大越好） */
  fitness: (candidate: T) => number;
  /** 随机源（测试可注入；缺省 Math.random） */
  rng?: () => number;
  /** niche 精英同分容差（适应度差 ≤ 该值视为持平，先到先得） */
  tieTolerance?: number;
  /**
   * CVT 模式（第五轮进化）：归一化 [0,1]^d 空间的 Voronoi 质心表。
   * 给出时 niche 归属 = 最近质心（欧氏距离，平局取低质心下标），
   * bins 网格化被替代（bins.length 仍须等于 ranges.length 以定维数）。
   * 用 cvtCentroids() 产出，或调用方自带。
   */
  centroids?: number[][];
}

/** 归档放置结果 */
export interface PlacementOutcome<T> {
  /** 候选者是否成为所在 niche 的新精英 */
  becameElite: boolean;
  /** 被替换下台的前任精英（首次占据时为 undefined） */
  displaced?: T;
  /** 候选者所在 niche 键（逗号连接的网格坐标） */
  niche: string;
}

/** 质量-多样性指标 */
export interface QualityDiversityMetrics {
  /** 被占据 niche 数 */
  nichesOccupied: number;
  /** 总 niche 数 */
  totalNiches: number;
  /** 覆盖率 = 占据 / 总数（0~1） */
  coverage: number;
  /** QD-score = 被占据 niche 精英适应度之和 */
  qdScore: number;
  /** 精英平均适应度 */
  meanFitness: number;
  /** 全局最优精英的适应度 */
  bestFitness: number;
  /** 累计放置次数 / 上位次数（替换率 = 上位/放置） */
  placements: number;
  promotions: number;
}

/** 归档状态报告 */
export interface ArchiveReport<T> {
  metrics: QualityDiversityMetrics;
  /** 各 niche 现任精英（按适应度降序） */
  elites: Array<{ niche: string; fitness: number; candidate: T }>;
}

// ─────────────────────────── MAP-Elites 归档 ───────────────────────────

/**
 * MAP-Elites 归档（泛型网格精英制）
 *
 * place() 准入规则：候选者落入唯一 niche；适应度严格高于现任
 * （或 niche 空缺）即上位。O(1) 放置、O(k) 指标计算（k = 占据数）。
 * 跨 niche 永不比较——多样性的保护是结构性的，不依赖任何阈值。
 *
 * 第五轮进化：centroids 配置启用 CVT（Voronoi niche）模式；place()
 * 逐 niche 记录停滞计数（连续挑战失败），sparseRestart() 据此重播
 * 停滞 niche；sample() 用缓存的键数组实现 O(1) 均匀采样。
 */
export class MapElitesArchive<T> {
  private readonly config: MapElitesConfig<T>;
  private readonly centroids: number[][] | undefined;
  private readonly elites = new Map<string, { fitness: number; candidate: T; challenges: number }>();
  private placements = 0;
  private promotions = 0;
  private rng: () => number;
  /** 采样键缓存：仅在新 niche 首次占据时失效（Map 键序 = 首次插入序，缓存恒等价） */
  private keyCache: string[] | null = null;

  constructor(config: MapElitesConfig<T>) {
    if (config.bins.length !== config.ranges.length) {
      throw new Error(`quality-diversity: bins(${config.bins.length}) 与 ranges(${config.ranges.length}) 维度不一致`);
    }
    if (config.centroids !== undefined) {
      if (!Array.isArray(config.centroids) || config.centroids.length === 0) {
        throw new Error('quality-diversity: centroids 须为非空二维数组（每行一个质心坐标）');
      }
      for (let c = 0; c < config.centroids.length; c += 1) {
        const cent = config.centroids[c];
        if (!Array.isArray(cent) || cent.length !== config.bins.length) {
          throw new Error(`quality-diversity: centroids[${c}] 维度（${cent?.length}）须等于 bins 维度（${config.bins.length}）`);
        }
        for (const v of cent) {
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            throw new Error(`quality-diversity: centroids[${c}] 含非有限值（${String(v)}）——质心须在归一化 [0,1]^d 空间`);
          }
        }
      }
    }
    this.config = config;
    this.centroids = config.centroids;
    this.rng = config.rng ?? Math.random;
  }

  /** 总 niche 数（CVT 模式 = 质心数；网格模式 = bins 乘积） */
  get totalNiches(): number {
    return this.centroids !== undefined ? this.centroids.length : this.config.bins.reduce((a, b) => a * b, 1);
  }

  /** 被占据 niche 数 */
  get occupiedNiches(): number {
    return this.elites.size;
  }

  /** 候选者 → niche 键：CVT 模式取最近质心（平局低质心下标），网格模式取网格坐标（越界饱和到边界格） */
  nicheOf(candidate: T): string {
    const coords = this.config.descriptor(candidate);
    if (this.centroids !== undefined) {
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let c = 0; c < this.centroids.length; c += 1) {
        const cent = this.centroids[c]!;
        let dist = 0;
        for (let d = 0; d < cent.length; d += 1) {
          const [min, max] = this.config.ranges[d]!;
          const normalized = Math.min(1, Math.max(0, (coords[d]! - min) / (max - min)));
          const diff = normalized - cent[d]!;
          dist += diff * diff;
          if (dist >= bestDist) break; // 距离只增不减：超不过现任最优即可提前出局
        }
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      return String(best);
    }
    const parts: string[] = [];
    for (let d = 0; d < this.config.bins.length; d += 1) {
      const [min, max] = this.config.ranges[d]!;
      const bins = this.config.bins[d]!;
      const normalized = Math.min(1, Math.max(0, (coords[d]! - min) / (max - min)));
      const cell = Math.min(bins - 1, Math.floor(normalized * bins));
      parts.push(String(cell));
    }
    return parts.join(',');
  }

  /**
   * 放置候选者：在其 niche 内挑战现任精英。
   * 适应度严格超过现任（容差内持平算挑战失败——先到先得，防抖动）
   * 或 niche 空缺时上位。挑战失败累加该 niche 的停滞计数（sparseRestart 的素材）。
   */
  place(candidate: T): PlacementOutcome<T> {
    const niche = this.nicheOf(candidate);
    const fitness = this.config.fitness(candidate);
    const current = this.elites.get(niche);
    this.placements += 1;
    const tie = this.config.tieTolerance ?? 1e-9;
    if (!current || fitness > current.fitness + tie) {
      this.elites.set(niche, { fitness, candidate, challenges: 0 });
      this.promotions += 1;
      if (!current) this.keyCache = null; // 新 niche 首次占据：键集合变化，缓存失效
      return { becameElite: true, displaced: current?.candidate, niche };
    }
    current.challenges += 1;
    return { becameElite: false, niche };
  }

  /**
   * 稀疏重启（第五轮进化）：重播停滞 niche。
   *
   * 停滞 = 该 niche 现任精英已连续 ≥ patience 次击退挑战者（局部收敛
   * 证据）。对每个停滞 niche（按停滞深度降序、平局 niche 键升序，至多
   * maxRestarts 个）用 mutation(elite, rng) 产一个重启候选者并**强制
   * 上位**（适应度允许下降——重启的代价），停滞计数清零、探索从新
   * 候选重新出发。返回每次重启的前任/继任对（可审计）。
   */
  sparseRestart(options: {
    /** 停滞精英的重启变异（确定性注入 this.rng） */
    mutation: (elite: T, rng: () => number) => T;
    /** 停滞判定：连续挑战失败 ≥ patience（缺省 4） */
    patience?: number;
    /** 单次最多重启的 niche 数（缺省 8；0 = 不重启） */
    maxRestarts?: number;
  }): {
    restarted: Array<{ niche: string; previous: T; previousFitness: number; candidate: T; candidateFitness: number }>;
    stagnantNiches: number;
  } {
    if (typeof options.mutation !== 'function') {
      throw new Error('quality-diversity: sparseRestart 须提供 mutation(elite, rng) 变异算子');
    }
    const patience = Math.max(1, Math.floor(options.patience ?? 4));
    const maxRestarts = Math.max(0, Math.floor(options.maxRestarts ?? 8));
    const stagnant = [...this.elites.entries()]
      .filter(([, e]) => e.challenges >= patience)
      .sort((a, b) => b[1].challenges - a[1].challenges || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, maxRestarts);
    const restarted: Array<{ niche: string; previous: T; previousFitness: number; candidate: T; candidateFitness: number }> = [];
    for (const [niche, e] of stagnant) {
      const candidate = options.mutation(e.candidate, this.rng);
      const fitness = this.config.fitness(candidate);
      this.elites.set(niche, { fitness, candidate, challenges: 0 });
      restarted.push({ niche, previous: e.candidate, previousFitness: e.fitness, candidate, candidateFitness: fitness });
    }
    return { restarted, stagnantNiches: stagnant.length };
  }

  /** 从被占据 niche 均匀采样一位精英（前沿探索；空归档返回 undefined） */
  sample(): T | undefined {
    if (this.elites.size === 0) return undefined;
    // O(1) 哈希 niche 采样（第五轮进化）：键数组缓存，仅新 niche 占据时失效
    if (this.keyCache === null) this.keyCache = [...this.elites.keys()];
    const key = this.keyCache[Math.floor(this.rng() * this.keyCache.length)]!;
    return this.elites.get(key)!.candidate;
  }

  /** 全局最优精英（适应度最高；空归档返回 undefined） */
  best(): T | undefined {
    let best: { fitness: number; candidate: T } | undefined;
    for (const elite of this.elites.values()) {
      if (!best || elite.fitness > best.fitness) best = elite;
    }
    return best?.candidate;
  }

  /** 全部现任精英（候选者列表；按 niche 键序） */
  eliteCandidates(): T[] {
    return [...this.elites.values()].map((e) => e.candidate);
  }

  /** QD 指标 */
  metrics(): QualityDiversityMetrics {
    let qd = 0;
    let bestFit = Number.NEGATIVE_INFINITY;
    for (const elite of this.elites.values()) {
      qd += elite.fitness;
      bestFit = Math.max(bestFit, elite.fitness);
    }
    return {
      nichesOccupied: this.elites.size,
      totalNiches: this.totalNiches,
      coverage: round(this.elites.size / this.totalNiches),
      qdScore: round(qd),
      meanFitness: this.elites.size > 0 ? round(qd / this.elites.size) : 0,
      bestFitness: this.elites.size > 0 ? round(bestFit) : 0,
      placements: this.placements,
      promotions: this.promotions,
    };
  }

  /** 归档报告 */
  report(): ArchiveReport<T> {
    const elites = [...this.elites.entries()]
      .map(([niche, e]) => ({ niche, fitness: round(e.fitness), candidate: e.candidate }))
      .sort((a, b) => b.fitness - a.fitness);
    return { metrics: this.metrics(), elites };
  }
}

// ─────────────────────────── 策略基因行为描述子 ───────────────────────────

/** 策略基因结构（与 strategy-evolution.StrategyGenes 结构兼容，避免循环依赖） */
export interface StrategyGenesLike {
  suppressionWindowMs: number;
  failureEscalationThreshold: number;
  lowConfidenceThreshold: number;
  costDeferRatio: number;
  burstOccurrences: number;
}

/** 策略行为空间维度 */
export type StrategyBehaviorDim = 'boldness' | 'frugality' | 'vigilance';

/** 策略行为空间（三维，均归一到 [0,1]） */
export const STRATEGY_BEHAVIOR_SPACE: {
  dims: StrategyBehaviorDim[];
  ranges: Array<[number, number]>;
  defaultBins: number[];
} = {
  dims: ['boldness', 'frugality', 'vigilance'],
  ranges: [
    [0, 1],
    [0, 1],
    [0, 1],
  ],
  defaultBins: [4, 4, 4],
};

/** 基因取值边界（与 strategy-evolution.GENE_BOUNDS 同口径） */
const GENE_BOUNDS: Record<keyof StrategyGenesLike, { min: number; max: number }> = {
  suppressionWindowMs: { min: 30_000, max: 15 * 60_000 },
  failureEscalationThreshold: { min: 1, max: 8 },
  lowConfidenceThreshold: { min: 0.2, max: 0.7 },
  costDeferRatio: { min: 1, max: 10 },
  burstOccurrences: { min: 2, max: 12 },
};

function normalized(gene: keyof StrategyGenesLike, value: number): number {
  const { min, max } = GENE_BOUNDS[gene];
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * 策略基因 → 行为坐标 [boldness, frugality, vigilance]（各维 ∈ [0,1]）
 *
 * - 敢为度 boldness：低置信阈值（敢放行低置信决策）+ 宽重复抑制
 *   （敢重复执行）→ 越大越激进
 * - 节俭度 frugality：成本延迟比越高越省钱 → 越大越节俭
 * - 警觉度 vigilance：失败升级阈值越低 + 突发判定越敏感 → 越大越警觉
 *
 * 三个维度刻画决策策略的「活法」：激进省钱 vs 节俭保守 vs 高敏止损——
 * 归档保证每种活法都保留一个最佳代表。
 */
export function strategyBehaviorDescriptor(genes: StrategyGenesLike): number[] {
  const boldness =
    0.6 * (1 - normalized('lowConfidenceThreshold', genes.lowConfidenceThreshold)) +
    0.4 * (1 - normalized('suppressionWindowMs', genes.suppressionWindowMs));
  const frugality = normalized('costDeferRatio', genes.costDeferRatio);
  const vigilance =
    0.6 * (1 - normalized('failureEscalationThreshold', genes.failureEscalationThreshold)) +
    0.4 * (1 - normalized('burstOccurrences', genes.burstOccurrences));
  return [
    Math.min(1, Math.max(0, boldness)),
    Math.min(1, Math.max(0, frugality)),
    Math.min(1, Math.max(0, vigilance)),
  ];
}

function round(x: number): number {
  return Number(x.toFixed(6));
}

// ─────────────────────────── CVT 质心工厂（第五轮进化） ───────────────────────────

/** cvtCentroids 配置 */
export interface CvtCentroidsOptions {
  /** 行为空间维数 d（≥ 1） */
  dims: number;
  /** 质心数 k（≥ 1；即 CVT 模式的 niche 数） */
  k: number;
  /** Lloyd 采样点数（缺省 max(400, 20·k·dims)） */
  samples?: number;
  /** 最大迭代（缺省 60；提前停止条件 = 最大质心位移 < 1e-12） */
  iters?: number;
  /** 随机源种子（缺省 14；与 rng 二选一，rng 优先） */
  seed?: number;
  /** 随机源（测试注入；缺省 mulberry32(seed)——确定性） */
  rng?: () => number;
}

/**
 * CVT 质心（质心 Voronoi 镶嵌）：在归一化 [0,1]^d 空间均匀采样
 * `samples` 个点，跑确定性 Lloyd 迭代（分配 → 取均值 → 再分配），
 * 空簇重播种到「离现有质心最远的样本点」（平局取低下标），至最大
 * 质心位移 < 1e-12 或迭代上限。产出可直接喂给 MapElitesConfig.
 * centroids——niche 边界贴着均匀样本质量弯折（每胞体积 ≈ 1/k，
 * 等量预算性质的来源）。同 (seed|rng) 同质心表。
 */
export function cvtCentroids(options: CvtCentroidsOptions): number[][] {
  const dims = Math.floor(options.dims);
  if (!(dims >= 1)) throw new Error(`quality-diversity: cvtCentroids 的 dims 必须 ≥ 1（收到 ${options.dims}）`);
  const k = Math.floor(options.k);
  if (!(k >= 1)) throw new Error(`quality-diversity: cvtCentroids 的 k 必须 ≥ 1（收到 ${options.k}）`);
  const samples = Math.floor(options.samples ?? Math.max(400, 20 * k * dims));
  if (!(samples >= k)) throw new Error(`quality-diversity: cvtCentroids 的 samples（${samples}）必须 ≥ k（${k}）`);
  const iters = Math.floor(options.iters ?? 60);
  if (!(iters >= 1)) throw new Error(`quality-diversity: cvtCentroids 的 iters 必须 ≥ 1（收到 ${options.iters}）`);
  const rng = options.rng ?? mulberry32(Math.floor(options.seed ?? 14));

  // 1. 均匀样本（[0,1]^dims）
  const points: number[][] = Array.from({ length: samples }, () => Array.from({ length: dims }, () => rng()));
  // 2. 初始质心 = 前 k 个样本（确定性初始化，文档化）
  let centroids: number[][] = points.slice(0, k).map((p) => [...p]);

  for (let iter = 0; iter < iters; iter += 1) {
    // 分配：每点到最近质心（平局低质心下标）
    const sums: number[][] = Array.from({ length: k }, () => new Array<number>(dims).fill(0));
    const counts = new Array<number>(k).fill(0);
    for (const p of points) {
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let c = 0; c < k; c += 1) {
        let dist = 0;
        const cent = centroids[c]!;
        for (let d = 0; d < dims; d += 1) {
          const diff = p[d]! - cent[d]!;
          dist += diff * diff;
          if (dist >= bestDist) break;
        }
        if (dist < bestDist) {
          bestDist = dist;
          best = c;
        }
      }
      counts[best] += 1;
      const s = sums[best]!;
      for (let d = 0; d < dims; d += 1) s[d] = (s[d] ?? 0) + p[d]!;
    }
    // 均值 + 空簇重播种（最远样本，平局低下标）
    let maxShift = 0;
    const next: number[][] = [];
    for (let c = 0; c < k; c += 1) {
      if (counts[c] === 0) {
        let far = 0;
        let farDist = -1;
        for (let i = 0; i < points.length; i += 1) {
          let dist = Number.POSITIVE_INFINITY;
          for (let cc = 0; cc < k; cc += 1) {
            let dd = 0;
            const cent = centroids[cc]!;
            const p = points[i]!;
            for (let d = 0; d < dims; d += 1) {
              const diff = p[d]! - cent[d]!;
              dd += diff * diff;
            }
            if (dd < dist) dist = dd;
          }
          if (dist > farDist) {
            farDist = dist;
            far = i;
          }
        }
        next.push([...points[far]!]);
        continue;
      }
      const cent: number[] = [];
      for (let d = 0; d < dims; d += 1) cent.push((sums[c]![d] ?? 0) / counts[c]!);
      const shift = Math.max(...cent.map((v, d) => Math.abs(v - centroids[c]![d]!)));
      maxShift = Math.max(maxShift, shift);
      next.push(cent);
    }
    centroids = next;
    if (maxShift < 1e-12) break; // 收敛：质心不再移动
  }
  return centroids.map((c) => c.map((v) => Math.min(1, Math.max(0, v))));
}
