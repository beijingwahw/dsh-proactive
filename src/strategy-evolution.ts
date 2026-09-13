/**
 * strategy-evolution.ts — 决策策略在线进化引擎（"彻底自主智能"核心组件 3/4）
 *
 * 职责：让决策引擎的超参数不再是人工拍定的静态值，
 * 而是一个随运行反馈持续进化的"策略基因库"。
 *
 * 能力矩阵：
 * 1. 策略基因组：每个基因组是一组决策引擎超参数
 *    （抑制窗口 / 失败升级阈值 / 低置信阈值 / 成本延迟比 / 突发判定）
 * 2. UCB1 探索-利用平衡：选择基因组时兼顾历史收益与探索不足度，
 *    避免陷入局部最优，新变异体有机会被验证
 * 3. 适应度反馈：每次决策的实际结果（outcome → reward）回写基因组，
 *    平均收益即适应度
 * 4. 锦标赛进化：累计足够样本后触发进化——精英保留 + 锦标赛选择父代 +
 *    高斯变异产生后代，淘汰最弱个体，种群整体适应度单调爬升
 * 5. 最优基因组推荐：进化产物直接落地为决策引擎的新配置
 *
 * 4.0 证据化升级：
 * - 基因组携带 MemoryEvidence（时间加权 Beta 证据，半衰期 30 天），
 *   outcome 的连续收益（0~1）经加权观测累积——旧决策结果自然让位
 * - 适应度从裸 meanReward 升级为证据后验的 Wilson 置信下界
 *   （小样本保守、防侥幸），UCB 利用项同源——探索-利用在同一统计口径下平衡
 * - 修复淘汰逻辑 bug：精英保护过滤条件错误（elites 不足额时全员成为
 *   survivors，精英可能被误淘汰）——修正为严格排除精英
 */

import type { DecisionEngineConfig } from './decision-engine.js';
import { initEvidence, observeWeightedEvidence, wilsonLowerBound, type MemoryEvidence } from './core/evidence.js';
import { AnytimeEvidenceRegistry, type AnytimeEvidenceRegistryReport, type AnytimeEvidenceView } from './core/anytime-evidence.js';
import { MapElitesArchive, STRATEGY_BEHAVIOR_SPACE, strategyBehaviorDescriptor, type QualityDiversityMetrics } from './core/quality-diversity.js';

/** 基因组基因（决策引擎可调超参数子集） */
export interface StrategyGenes {
  suppressionWindowMs: number;
  failureEscalationThreshold: number;
  lowConfidenceThreshold: number;
  costDeferRatio: number;
  burstOccurrences: number;
}

/** 策略基因组 */
export interface StrategyGenome {
  id: string;
  genes: StrategyGenes;
  /** 应用次数 */
  applications: number;
  /** 累计收益 */
  totalReward: number;
  /** 平均收益（适应度） */
  meanReward: number;
  /** 时间加权证据（4.0：连续收益证据化；旧数据无此字段回退 meanReward） */
  evidence?: MemoryEvidence;
  generation: number;
  createdAt: number;
}

/** 进化报告 */
export interface EvolutionReport {
  generation: number;
  elites: string[];
  born: string[];
  eliminated: string[];
  bestMeanReward: number;
  populationMeanReward: number;
}

/** 策略进化配置 */
export interface StrategyEvolutionConfig {
  /** 种群规模 */
  populationSize: number;
  /** UCB 探索常数 */
  explorationConstant: number;
  /** 变异概率（每个基因） */
  mutationRate: number;
  /** 变异强度（相对基因取值范围的比例） */
  mutationStrength: number;
  /** 精英保留数 */
  eliteCount: number;
  /** 触发进化所需的最小累计应用次数（相对上次进化） */
  minApplicationsBetweenEvolutions: number;
  /** 参与精英评定的最小应用次数（防止小样本侥幸） */
  minApplicationsForElite: number;
  /** 随机源（测试可注入确定性实现） */
  rng?: () => number;
}

/** 默认配置 */
export const DEFAULT_STRATEGY_EVOLUTION_CONFIG: StrategyEvolutionConfig = {
  populationSize: 6,
  explorationConstant: 1.4,
  mutationRate: 0.5,
  mutationStrength: 0.2,
  eliteCount: 2,
  minApplicationsBetweenEvolutions: 12,
  minApplicationsForElite: 3,
};

/** 基因取值边界 */
const GENE_BOUNDS: Record<keyof StrategyGenes, { min: number; max: number; integer: boolean }> = {
  suppressionWindowMs: { min: 30_000, max: 15 * 60_000, integer: true },
  failureEscalationThreshold: { min: 1, max: 8, integer: true },
  lowConfidenceThreshold: { min: 0.2, max: 0.7, integer: false },
  costDeferRatio: { min: 1, max: 10, integer: false },
  burstOccurrences: { min: 2, max: 12, integer: true },
};

/** 基准基因组（决策引擎默认配置） */
const BASELINE_GENES: StrategyGenes = {
  suppressionWindowMs: 5 * 60_000,
  failureEscalationThreshold: 3,
  lowConfidenceThreshold: 0.4,
  costDeferRatio: 3,
  burstOccurrences: 5,
};

/** outcome → 收益映射 */
const OUTCOME_REWARD: Record<string, number> = {
  excellent: 1,
  good: 0.8,
  acceptable: 0.6,
  poor: 0.3,
  failed: 0,
};

/** 种群报告（运维可观测） */
export interface EvolutionStatusReport {
  generation: number;
  populationSize: number;
  applicationsSinceEvolution: number;
  populationMeanReward: number;
  genomes: Array<{ id: string; generation: number; applications: number; meanReward: number; genes: StrategyGenes }>;
  bestGenome: string;
  recentEvolutions: EvolutionReport[];
  /** 14.0：质量-多样性指标（attachQualityDiversity 后输出） */
  qd?: QualityDiversityMetrics;
  /** 12.0：任意时刻证据报告（attachAnytimeEvidence 后输出） */
  anytime?: AnytimeEvidenceRegistryReport;
}

/**
 * 决策策略在线进化引擎
 *
 * 被 index.ts 持有：决策引擎每次决策前通过 selectGenome() 获取当前基因组
 * （其基因作为决策引擎运行时参数），决策结果经 recordOutcome() 回写适应度，
 * autonomy-loop 定期调用 evolve() 驱动种群进化。
 *
 * 12.0 移植（attachAnytimeEvidence）：适应度从 Wilson 固定样本下界升级为
 * 任意时刻有效置信序列下界（流式统计永不夸大）；pruneProvablyDominated
 * 以 e-BH FDR 控制淘汰「证明确实低于水位线」的基因组——冤案率有数学上限。
 *
 * 14.0 移植（attachQualityDiversity）：selectGenome 的探索从纯 UCB 升级为
 * 「前沿 niche 均匀采样」——每种行为流派（敢为 × 节俭 × 警觉）获得等量
 * 试验预算；evolve 同步维护 MAP-Elites 归档，多样性可审计（coverage/QD-score）。
 * 两个移植均为并行旁路：不 attach 即零漂移。
 */
export class StrategyEvolutionEngine {
  private config: StrategyEvolutionConfig;
  private population: StrategyGenome[] = [];
  private genomeCounter = 0;
  private generation = 0;
  private applicationsSinceEvolution = 0;
  private evolutionHistory: EvolutionReport[] = [];
  private rng: () => number;
  /** 12.0：任意时刻证据登记表（attach 后启用） */
  private anytime?: AnytimeEvidenceRegistry;
  /** 12.0：已淘汰基因组的 e-值台账（审计） */
  private anytimeEliminations: Array<{ id: string; eValue: number; at: number }> = [];
  /** 14.0：MAP-Elites 行为归档（attach 后启用） */
  private qdArchive?: MapElitesArchive<StrategyGenome>;
  /** 14.0：前沿 niche 采样概率（探索预算占比） */
  private qdExploreRate = 0.25;

  constructor(config?: Partial<StrategyEvolutionConfig>) {
    this.config = { ...DEFAULT_STRATEGY_EVOLUTION_CONFIG, ...config };
    this.rng = this.config.rng ?? Math.random;
    this.seedPopulation();
  }

  /**
   * 12.0：挂载任意时刻证据内核（幂等；挂载后适应度用置信序列下界，
   * recordOutcome 的收益同时喂入该基因组的 e-过程）。
   */
  attachAnytimeEvidence(options?: { alpha?: number; reference?: number }): void {
    this.anytime = new AnytimeEvidenceRegistry({ alpha: options?.alpha, reference: options?.reference });
  }

  /**
   * 14.0：挂载质量-多样性内核（幂等；挂载后 selectGenome 以
   * qdExploreRate 概率从行为归档均匀采样探索，evolve 同步维护归档）。
   */
  attachQualityDiversity(options?: { bins?: number[]; exploreRate?: number; rng?: () => number }): void {
    const bins = options?.bins ?? STRATEGY_BEHAVIOR_SPACE.defaultBins;
    this.qdExploreRate = options?.exploreRate ?? 0.25;
    this.qdArchive = new MapElitesArchive<StrategyGenome>({
      bins,
      ranges: STRATEGY_BEHAVIOR_SPACE.ranges,
      descriptor: (g) => strategyBehaviorDescriptor(g.genes),
      fitness: (g) => this.fitness(g),
      rng: options?.rng ?? this.rng,
      tieTolerance: 1e-9,
    });
    for (const genome of this.population) this.qdArchive.place(genome);
  }

  /**
   * UCB1 选择当前基因组（探索-利用平衡；4.0 利用项 = 证据化适应度）
   *
   * 利用项与适应度同源（Wilson 下界 × 置信折扣），探索项保持 UCB1
   * 对数置信宽度——探索与利用在同一证据口径下平衡。
   * @returns 选中的基因组
   */
  selectGenome(): StrategyGenome {
    // 14.0：前沿 niche 采样探索——以 qdExploreRate 概率从行为归档均匀
    // 抽一个「活法流派」的代表（每个流派等量试验预算；空归档自动跳过）
    if (this.qdArchive && this.qdArchive.occupiedNiches > 1 && this.rng() < this.qdExploreRate) {
      const sampled = this.qdArchive.sample();
      if (sampled && this.population.includes(sampled)) return sampled;
    }
    const totalApplications = this.population.reduce((sum, g) => sum + g.applications, 0);
    let best: StrategyGenome = this.population[0];
    let bestScore = -Infinity;
    for (const genome of this.population) {
      // 未应用过的基因组优先探索
      if (genome.applications === 0) return genome;
      const exploitation = this.fitness(genome);
      const exploration = this.config.explorationConstant * Math.sqrt(Math.log(totalApplications + 1) / genome.applications);
      const score = exploitation + exploration;
      if (score > bestScore) {
        bestScore = score;
        best = genome;
      }
    }
    return best;
  }

  /**
   * 回写决策结果（适应度反馈）
   * @param genomeId 基因组 id
   * @param outcome 决策执行后的实际结果
   */
  recordOutcome(genomeId: string, outcome: string): void {
    const genome = this.population.find((g) => g.id === genomeId);
    if (!genome) return;
    const reward = OUTCOME_REWARD[outcome] ?? 0.5;
    genome.applications += 1;
    genome.totalReward += reward;
    genome.meanReward = genome.totalReward / genome.applications;
    // 4.0 证据化：连续收益（0~1）按时间加权观测累积（惰性衰减 + 首次惰性初始化）
    const now = Date.now();
    if (!genome.evidence) genome.evidence = initEvidence(0, 0, now);
    observeWeightedEvidence(genome.evidence, reward, now);
    // 12.0：同一观测喂入任意时刻证据流（e-过程在任意停止时刻合法）
    this.anytime?.observe(genomeId, reward);
    this.applicationsSinceEvolution += 1;
  }

  /**
   * 触发一轮进化（精英保留 + 锦标赛选择 + 高斯变异）
   * @param force 强制进化（忽略最小应用次数门槛）
   * @returns 进化报告；未达门槛时返回 null
   */
  evolve(force = false): EvolutionReport | null {
    if (!force && this.applicationsSinceEvolution < this.config.minApplicationsBetweenEvolutions) return null;

    this.generation += 1;
    const ranked = [...this.population].sort((a, b) => this.fitness(b) - this.fitness(a));

    // 精英保留（需满足最小应用次数，防止小样本侥幸）
    const elites = ranked.filter((g) => g.applications >= this.config.minApplicationsForElite).slice(0, this.config.eliteCount);
    const report: EvolutionReport = {
      generation: this.generation,
      elites: elites.map((g) => g.id),
      born: [],
      eliminated: [],
      bestMeanReward: ranked[0]?.meanReward ?? 0,
      populationMeanReward: this.populationMeanReward(),
    };

    // 淘汰最弱个体（精英严格不淘汰——修复：原条件在精英不足额时全员入 survivors，
    // 精英保护失效），由变异后代顶替
    const survivors = ranked.filter((g) => !elites.includes(g));
    const eliminateCount = Math.max(1, this.config.populationSize - Math.max(elites.length, 1) - Math.floor(this.config.populationSize / 2));
    const eliminated = survivors.slice(-eliminateCount);
    report.eliminated = eliminated.map((g) => g.id);

    // 锦标赛选择父代 + 变异产生后代
    for (const dead of eliminated) {
      const parent = this.tournamentSelect(elites.length > 0 ? elites : ranked);
      const child = this.mutate(parent);
      // 原位替换
      const index = this.population.indexOf(dead);
      if (index >= 0) this.population[index] = child;
      else this.population.push(child);
      report.born.push(child.id);
    }

    // 种群规模收敛
    while (this.population.length > this.config.populationSize) this.population.pop();

    // 14.0：进化后同步归档——每个行为 niche 保留种群内最优代表
    // （全局平庸但本地独特的基因组获得结构性生存权）
    if (this.qdArchive) {
      for (const genome of this.population) this.qdArchive.place(genome);
    }

    this.applicationsSinceEvolution = 0;
    this.evolutionHistory.push(report);
    if (this.evolutionHistory.length > 50) this.evolutionHistory.shift();
    return report;
  }

  /** 最优基因组（应用次数达标者中平均收益最高） */
  bestGenome(): StrategyGenome {
    const eligible = this.population.filter((g) => g.applications >= this.config.minApplicationsForElite);
    const pool = eligible.length > 0 ? eligible : this.population;
    return [...pool].sort((a, b) => this.fitness(b) - this.fitness(a))[0];
  }

  /** 最优基因组 → 决策引擎配置片段（进化产物落地） */
  bestGenesAsConfig(): Partial<DecisionEngineConfig> {
    return { ...this.bestGenome().genes };
  }

  /** 种群报告 */
  getReport(): EvolutionStatusReport {
    return {
      generation: this.generation,
      populationSize: this.population.length,
      applicationsSinceEvolution: this.applicationsSinceEvolution,
      populationMeanReward: Number(this.populationMeanReward().toFixed(3)),
      genomes: [...this.population]
        .sort((a, b) => this.fitness(b) - this.fitness(a))
        .map((g) => ({
          id: g.id,
          generation: g.generation,
          applications: g.applications,
          meanReward: Number(g.meanReward.toFixed(3)),
          genes: g.genes,
        })),
      bestGenome: this.bestGenome().id,
      recentEvolutions: this.evolutionHistory.slice(-5),
      qd: this.qdArchive?.metrics(),
      anytime: this.anytime?.report(),
    };
  }

  /** 进化历史 */
  getEvolutionHistory(): EvolutionReport[] {
    return [...this.evolutionHistory];
  }

  // ─────────────────────────── 12.0 任意时刻证据移植 ───────────────────────────

  /**
   * 证明性淘汰（12.0）：e-BH FDR 控制地移除「任意时刻有效证据确证
   * 收益低于水位线」的基因组。
   *
   * 语义：只删 e-过程确证（e ≥ 1/α）且通过多重校正的对象——
   * 「确实差」才淘汰，冤案率（FDR）≤ fdr；淘汰后由幸存者变异后代
   * 顶替（种群规模不缩水）。未挂载内核时返回空报告（零漂移）。
   *
   * @returns 被淘汰的基因组及定罪 e-值（审计台账）
   */
  pruneProvablyDominated(fdr = 0.1): Array<{ id: string; eValue: number; at: number }> {
    if (!this.anytime) return [];
    // 淘汰前快照各基因组 e-值（eliminate 后流被 forget，无法回查）
    const evidenceSnapshot = new Map<string, number>();
    for (const genome of this.population) {
      const view = this.anytime.viewOf(genome.id);
      if (view) evidenceSnapshot.set(genome.id, view.eBelow);
    }
    const rejected = this.anytime.eliminate(fdr);
    const eliminated: Array<{ id: string; eValue: number; at: number }> = [];
    for (const id of rejected) {
      const genome = this.population.find((g) => g.id === id);
      if (!genome) continue;
      const record = { id, eValue: evidenceSnapshot.get(id) ?? 0, at: Date.now() };
      eliminated.push(record);
      this.anytimeEliminations.push(record);
      // 从种群移除（保底 2 个——进化不能失去变异素材）
      if (this.population.length > 2) {
        const index = this.population.indexOf(genome);
        if (index >= 0) this.population.splice(index, 1);
        // 幸存者变异顶替（规模不缩水；新基因组从零积累证据）
        const parent = this.tournamentSelect(this.population);
        const child = this.mutate(parent);
        this.population.push(child);
        if (this.qdArchive) this.qdArchive.place(child);
      }
    }
    return eliminated;
  }

  /** 12.0：任意时刻证据报告（含历史淘汰台账） */
  anytimeReport(): AnytimeEvidenceRegistryReport & { eliminations: Array<{ id: string; eValue: number; at: number }> } {
    const base = this.anytime?.report() ?? {
      streams: 0,
      verdicts: { above: 0, below: 0, undecided: 0 },
      totalConfirmations: 0,
      totalEliminations: 0,
      strongestEvidence: 0,
      interpretation: '未挂载任意时刻证据内核（attachAnytimeEvidence 启用）',
    };
    return { ...base, eliminations: [...this.anytimeEliminations] };
  }

  /** 12.0：指定基因组的当前证据视图（未挂载或未观测返回 undefined） */
  anytimeViewOf(genomeId: string): AnytimeEvidenceView | undefined {
    return this.anytime?.viewOf(genomeId);
  }

  // ─────────────────────────── 14.0 质量-多样性移植 ───────────────────────────

  /** 14.0：QD 指标（未挂载返回 undefined） */
  qdMetrics(): QualityDiversityMetrics | undefined {
    return this.qdArchive?.metrics();
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 初始种群：基准基因组 + 扰动变体 */
  private seedPopulation(): void {
    this.population = [];
    // 首个个体为无扰动基准（保证系统初始行为与默认配置一致）
    this.population.push(this.createGenome({ ...BASELINE_GENES }, 0));
    for (let i = 1; i < this.config.populationSize; i += 1) {
      const baseline = this.createGenome({ ...BASELINE_GENES }, 0);
      this.population.push(this.mutate(baseline));
    }
  }

  /** 创建新基因组 */
  private createGenome(genes: StrategyGenes, generation: number): StrategyGenome {
    return {
      id: `genome-${++this.genomeCounter}`,
      genes,
      applications: 0,
      totalReward: 0,
      meanReward: 0,
      generation,
      createdAt: Date.now(),
    };
  }

  /**
   * 适应度（4.0 证据化 → 12.0 任意时刻有效化）
   *
   * 挂载任意时刻内核且流样本 ≥ 3：置信序列下界 × 折扣（时间一致
   * 覆盖——连续监控下读适应度永不夸大）；否则回退 Wilson 下界
   * （4.0 口径，固定样本语义）；无证据回退 meanReward × 折扣。
   */
  private fitness(genome: StrategyGenome): number {
    if (genome.applications === 0) return 0;
    const confidenceFactor = Math.min(1, genome.applications / this.config.minApplicationsForElite);
    const anytimeView = this.anytime?.viewOf(genome.id);
    if (anytimeView && anytimeView.n >= 3) {
      return Math.max(0, anytimeView.cs.lower) * confidenceFactor;
    }
    if (genome.evidence) {
      return wilsonLowerBound(genome.evidence.weightedSuccesses, genome.evidence.weightedFailures) * confidenceFactor;
    }
    return genome.meanReward * confidenceFactor;
  }

  /** 锦标赛选择（3 选 1） */
  private tournamentSelect(pool: StrategyGenome[]): StrategyGenome {
    let winner = pool[Math.floor(this.rng() * pool.length)];
    for (let i = 0; i < 2; i += 1) {
      const challenger = pool[Math.floor(this.rng() * pool.length)];
      if (this.fitness(challenger) > this.fitness(winner)) winner = challenger;
    }
    return winner;
  }

  /** 高斯变异：按变异概率逐基因扰动 */
  private mutate(parent: StrategyGenome): StrategyGenome {
    const genes = { ...parent.genes };
    for (const key of Object.keys(GENE_BOUNDS) as Array<keyof StrategyGenes>) {
      if (this.rng() > this.config.mutationRate) continue;
      const bounds = GENE_BOUNDS[key];
      const range = bounds.max - bounds.min;
      // 近似高斯：两个均匀分布叠加中心化
      const noise = (this.rng() + this.rng() - 1) * this.config.mutationStrength * range;
      let value = genes[key] + noise;
      value = Math.max(bounds.min, Math.min(bounds.max, value));
      genes[key] = bounds.integer ? Math.round(value) : Number(value.toFixed(3));
    }
    return this.createGenome(genes, this.generation);
  }

  /** 种群平均收益 */
  private populationMeanReward(): number {
    const applied = this.population.filter((g) => g.applications > 0);
    if (applied.length === 0) return 0;
    return applied.reduce((sum, g) => sum + g.meanReward, 0) / applied.length;
  }
}
