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
 */

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
 */
export class MapElitesArchive<T> {
  private readonly config: MapElitesConfig<T>;
  private readonly elites = new Map<string, { fitness: number; candidate: T }>();
  private placements = 0;
  private promotions = 0;
  private rng: () => number;

  constructor(config: MapElitesConfig<T>) {
    if (config.bins.length !== config.ranges.length) {
      throw new Error(`quality-diversity: bins(${config.bins.length}) 与 ranges(${config.ranges.length}) 维度不一致`);
    }
    this.config = config;
    this.rng = config.rng ?? Math.random;
  }

  /** 总 niche 数 */
  get totalNiches(): number {
    return this.config.bins.reduce((a, b) => a * b, 1);
  }

  /** 被占据 niche 数 */
  get occupiedNiches(): number {
    return this.elites.size;
  }

  /** 候选者 → niche 键（网格坐标），越界坐标饱和到边界格 */
  nicheOf(candidate: T): string {
    const coords = this.config.descriptor(candidate);
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
   * 或 niche 空缺时上位。
   */
  place(candidate: T): PlacementOutcome<T> {
    const niche = this.nicheOf(candidate);
    const fitness = this.config.fitness(candidate);
    const current = this.elites.get(niche);
    this.placements += 1;
    const tie = this.config.tieTolerance ?? 1e-9;
    if (!current || fitness > current.fitness + tie) {
      this.elites.set(niche, { fitness, candidate });
      this.promotions += 1;
      return { becameElite: true, displaced: current?.candidate, niche };
    }
    return { becameElite: false, niche };
  }

  /** 从被占据 niche 均匀采样一位精英（前沿探索；空归档返回 undefined） */
  sample(): T | undefined {
    if (this.elites.size === 0) return undefined;
    const keys = [...this.elites.keys()];
    const key = keys[Math.floor(this.rng() * keys.length)]!;
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
