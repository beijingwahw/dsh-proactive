/**
 * curiosity-engine.ts — 好奇心引擎（自主智能"内在动机"支柱）
 *
 * 职责：让系统不满足于"完成被指派的任务"，而是主动发现自身的知识盲区，
 * 生成探索性任务去填补盲区——这是从"工具"到"自主智能体"的关键跃迁。
 *
 * 能力矩阵：
 * 1. 知识盲区扫描：对比"系统接触过的任务类型"与"记忆中有成功经验的类型"，
 *    识别接触多但经验少（高失败/低质量）的类型，以及从未探索过的类型
 * 2. 新颖度排序：对候选探索目标按"信息增益"打分——
 *    未知程度（无经验）+ 潜在价值（接触频率）+ 探索稀缺度（历史探索次数）
 * 3. 探索预算：限制探索任务占比，防止好奇心失控挤占核心任务资源，
 *    预算随系统健康度动态调节（健康时多探索，退化时收敛）
 * 4. 探索回写：探索任务完成后记录收获（是否填补了盲区），
 *    驱动好奇心模型更新，形成"探索 → 学习 → 新盲区"的循环
 *
 * 设计要点：
 * - 好奇心产出的探索目标经 goalEngine 注入哨兵执行，与自主闭环无缝衔接
 * - 探索预算与健康度联动，保证探索行为始终在安全边界内
 * - 第三轮升级（69.0 盲区定向，缺省零漂移）：挂载 MapperBlindSpot
 *   视图后，探索从「随机 + 经典好奇分」升级为拓扑盲区定向——预算优先
 *   流向经验地形的稀疏带 / 边界前沿 / 孤岛（未挂载 → 逐位不变）
 * - 第四轮升级（探索-利用预算自动平衡，缺省零漂移）：挂载
 *   attachAdaptiveExploration 后，探索预算比例按「近期探索回报率」
 *   EWMA 自动调节——回报高多拨（比例向 maxRatio 扩张）、连续无收获
 *   收紧（比例向 minRatio 收缩）；零样本时有效比例恰等于基础比例
 *   （挂载即零漂移），探索的预算第一次有了收益率反馈环
 */

import { coverageFromTokens, lazyGreedy } from './core/submodular.js';
import { fairDomainBudget } from './core/fair-division.js';
// 创世纪 59.0：探索难度课程（掌握门限爬阶）
import { ExplorationCurriculum } from './engines-frontier/genesis25.js';

// 第二轮创世纪 91.0：新奇搜索（探索预算向行为空间空白定向——与 76.0 互补：
// 91 生成侧搜新奇，76 评价侧判新奇）
import { noveltyDirectionProbe, type NoveltyDirectionView } from './engines-frontier/autonomy25.js';

/** 知识盲区候选 */
export interface KnowledgeGap {
  /** 任务类型 */
  taskType: string;
  /** 盲区成因 */
  reason: 'unexplored' | 'low-experience' | 'high-failure' | 'topological';
  /** 接触次数（外部信号到达次数） */
  exposureCount: number;
  /** 已有成功经验数 */
  experienceCount: number;
  /** 历史探索次数 */
  explorationCount: number;
  /** 新颖度评分 0~1（越高越值得探索） */
  noveltyScore: number;
}

/**
 * 69.0 Mapper 拓扑盲区视图（盲区定向好奇的只读输入）。
 *
 * 结构兼容 world-model.experienceMapperView() 的图口径：nodes 的成员
 * 直接以任务类型标签给出（视图提供方负责映射），edges 为节点邻接。
 * 引擎侧从拓扑计算三轴盲区信号：节点稀疏（成员少 = 经验空白带）、
 * 边界前沿（度数低 = 经验大陆的边缘）、孤岛断裂（分量小 = 与主经验
 * 大陆失连的知识岛）。
 */
export interface MapperBlindSpotView {
  /** Mapper 节点（members = 该节点覆盖的任务类型） */
  nodes: ReadonlyArray<{ members: ReadonlyArray<string> }>;
  /** 节点邻接边（下标对） */
  edges: ReadonlyArray<readonly [number, number]>;
}

/** 探索任务建议 */
export interface ExplorationProposal {
  taskType: string;
  description: string;
  noveltyScore: number;
  /** 预期信息增益描述 */
  expectedGain: string;
}

/** 探索记录 */
export interface ExplorationRecord {
  taskType: string;
  timestamp: number;
  /** 探索是否带来新知识（填补盲区） */
  gainedKnowledge: boolean;
  note?: string;
}

/**
 * 5.0：因果实验记录（假设驱动好奇心的科学循环）
 *
 * 与普通探索记录的本质区别：每次因果实验都有先验假设（可证伪）、
 * 干预动作（do 而非看）与图更新（贝叶斯后验收缩）——
 * 即使结果否定假设（证伪），区间收窄本身就是知识增量。
 */
export interface CausalExplorationRecord {
  from: string;
  to: string;
  hypothesis: string;
  setTo: boolean;
  observedY: boolean;
  timestamp: number;
  /** 实验前效应区间宽度 */
  uncertaintyBefore: number;
  /** 实验后效应区间宽度（应小于 before —— 后验收缩） */
  uncertaintyAfter: number;
  /** 假设是否被支持 */
  hypothesisSupported: boolean;
}

/** 好奇心引擎配置 */
export interface CuriosityEngineConfig {
  /** 探索预算占单轮心跳派发的最大比例 0~1 */
  explorationBudgetRatio: number;
  /** 判定"低经验"的成功经验数阈值 */
  lowExperienceThreshold: number;
  /** 判定"高失败"的失败率阈值 */
  highFailureRateThreshold: number;
  /** 新颖度评分中未知程度的权重 */
  noveltyUnknownWeight: number;
  /** 新颖度评分中接触频率的权重 */
  noveltyExposureWeight: number;
  /** 新颖度评分中探索稀缺度的权重 */
  noveltyScarcityWeight: number;
}

/** 默认配置 */
export const DEFAULT_CURIOSITY_CONFIG: CuriosityEngineConfig = {
  explorationBudgetRatio: 0.3,
  lowExperienceThreshold: 2,
  highFailureRateThreshold: 0.5,
  noveltyUnknownWeight: 0.5,
  noveltyExposureWeight: 0.3,
  noveltyScarcityWeight: 0.2,
};

/**
 * 第四轮升级：探索-利用预算自动平衡配置（attachAdaptiveExploration）。
 * 有效探索比例 = minRatio + (maxRatio − minRatio) × 回报率 EWMA——
 * 挂载时 EWMA 初值取 (基础比例 − minRatio)/(maxRatio − minRatio)，
 * 故零样本有效比例恰等于 explorationBudgetRatio（挂载即零漂移）。
 */
export interface AdaptiveExplorationOptions {
  /** 有效比例下限（缺省 max(0.05, 基础比例/2)，钳位 (0, 基础比例]） */
  minRatio?: number;
  /** 有效比例上限（缺省 min(1, 基础比例×1.5)，钳位 [基础比例, 1]） */
  maxRatio?: number;
  /** 回报率 EWMA 平滑系数（缺省 0.4；越大近期样本权重越高） */
  alpha?: number;
}

/** 探索-利用预算自动平衡遥测（adaptiveExplorationView 读数） */
export interface AdaptiveExplorationTelemetry {
  /** 基础比例（配置口径 explorationBudgetRatio） */
  baseRatio: number;
  minRatio: number;
  maxRatio: number;
  /** 近期探索回报率 EWMA（gainedKnowledge 0/1 流的指数加权均值） */
  yieldEwma: number;
  /** 当前有效探索比例（预算计算的实际取用值） */
  effectiveRatio: number;
  /** 已喂入 EWMA 的探索样本数 */
  samples: number;
  /** 最近一次样本后的走向（expand = 扩张 / tighten = 收紧 / steady = 持平） */
  trend: 'expand' | 'steady' | 'tighten';
}

/** 知识状态提供器（由 index.ts 桥接长期记忆与世界模型） */
export interface KnowledgeProvider {
  /** 系统接触过的任务类型及接触次数 */
  getExposure(): Record<string, number>;
  /** 各任务类型的成功经验数 */
  getExperienceCounts(): Record<string, number>;
  /** 各任务类型的失败率 0~1 */
  getFailureRates(): Record<string, number>;
}

/**
 * 好奇心引擎
 *
 * 被 index.ts 持有：心跳循环在派发子任务前调用 proposeExplorations()
 * 获取探索建议（受预算约束），探索完成后经 recordExploration() 回写收获。
 */
export class CuriosityEngine {
  private config: CuriosityEngineConfig;
  private provider: KnowledgeProvider;
  private explorations: ExplorationRecord[] = [];
  /** 各类型历史探索次数 */
  private explorationCounts = new Map<string, number>();
  /** 5.0：因果内核（挂载后好奇心升级为假设驱动的实验设计） */
  private causal?: import('./core/causal-kernel.js').CausalKernel;
  /** 10.0：科学家内核（挂载后实验建议升级为 Lindley EIG 最优设计） */
  private scientist?: import('./core/scientist.js').ScientistMind;
  /** 5.0：因果实验历史 */
  private causalExplorations: CausalExplorationRecord[] = [];

  constructor(provider: KnowledgeProvider, config?: Partial<CuriosityEngineConfig>) {
    this.provider = provider;
    this.config = { ...DEFAULT_CURIOSITY_CONFIG, ...config };
  }

  /** 5.0：挂载因果内核（幂等） */
  attachCausalKernel(kernel: import('./core/causal-kernel.js').CausalKernel): void {
    this.causal = kernel;
  }

  /** 10.0：挂载科学家内核（幂等）——实验建议升级为 EIG 最优设计 */
  attachScientistMind(mind: import('./core/scientist.js').ScientistMind): void {
    this.scientist = mind;
  }

  /**
   * 5.0：假设驱动实验设计 —— 好奇心的科学化。
   *
   * 质变点：旧版好奇心是「类型盲区扫描」（没做过什么就做什么）——
   * 探索目标由接触频率决定，与知识价值无关。挂载因果内核后，
   * 探索目标改为「因果图上不确定性最高 × 重要性最高的边」：
   * 每个建议自带可证伪假设与 do-干预方案。
   * 探索从「到处走走看」升级为「设计实验回答关键问题」。
   *
   * 10.0 质变（挂载科学家内核后）：建议口径从「不确定性 × 重要性」
   * 的启发式升级为 Lindley EIG 最优设计——每条建议携带净价值
   * （EIG + 混杂加成 − 实验代价，nat 口径）与最优臂选择，
   * 混杂分歧边（观测≠干预）优先——那是观测永远买不到的知识。
   *
   * @param targetKpi 实验关心的结果指标（默认 'task.outcome'；EIG 口径下仅作无科学家时的回退）
   * @param budget 本轮实验配额
   */
  proposeCausalExperiments(
    targetKpi = 'task.outcome',
    budget = 2,
  ): import('./core/causal-kernel.js').CausalExperiment[] {
    if (this.scientist) {
      // 10.0 EIG 口径：净价值降序的最优设计（预算仲裁已内嵌——
      // netValue ≤ 0 的问题根本不出现）；仅当问题空间空时回退启发式
      const designs = this.scientist.designExperiments(budget);
      if (designs.length > 0) {
        return designs.map((d) => ({
          from: d.from,
          to: d.to,
          suggestedArm: d.arm,
          // 0~1 归一口径：净价值经 sigmoid 映射（保持接口兼容）
          infoGain: Number((1 / (1 + Math.exp(-d.netValue))).toFixed(4)),
          hypothesis: `${d.hypothesis}（净价值 ${d.netValue.toFixed(3)} nat：EIG ${d.armEig.toFixed(3)} + 混杂 ${d.confoundingBonus.toFixed(3)} − 代价）`,
          uncertainty: 0,
        }));
      }
    }
    if (!this.causal) return [];
    return this.causal.suggestExperiments(targetKpi, budget);
  }

  /**
   * 10.0：EIG 最优实验设计透传（原生口径，供宿主直接执行与结算）。
   * 与 proposeCausalExperiments 的区别：不压缩为 0~1 启发式评分，
   * 返回完整的 DesignedExperiment（nat 口径 + 台账结算句柄）。
   */
  designOptimalExperiments(maxCount = 3): import('./core/scientist.js').DesignedExperiment[] {
    return this.scientist ? this.scientist.designExperiments(maxCount) : [];
  }

  /**
   * 5.0：回写因果实验结果（假设 → 干预 → 图更新闭环）。
   *
   * 证伪也是收获：假设被否定时区间同样收窄（后验收缩），
   * uncertaintyReduction > 0 即记 gainedKnowledge ——
   * 好奇心的收益率第一次有了科学口径（信息增益而非运气）。
   */
  recordCausalExperiment(experiment: { from: string; to: string; setTo: boolean; hypothesis: string }, observedY: boolean): CausalExplorationRecord | null {
    if (!this.causal) return null;
    const before = this.causal.effect(experiment.from, experiment.to);
    const uncertaintyBefore = before.upper - before.lower;
    this.causal.intervene(experiment.from, experiment.to, experiment.setTo, observedY, 'curiosity', experiment.hypothesis);
    const after = this.causal.effect(experiment.from, experiment.to);
    const uncertaintyAfter = after.upper - after.lower;
    const record: CausalExplorationRecord = {
      ...experiment,
      observedY,
      timestamp: Date.now(),
      uncertaintyBefore: Number(uncertaintyBefore.toFixed(4)),
      uncertaintyAfter: Number(uncertaintyAfter.toFixed(4)),
      hypothesisSupported: (after.direction === 'positive') === experiment.setTo,
    };
    this.causalExplorations.push(record);
    if (this.causalExplorations.length > 200) this.causalExplorations.splice(0, this.causalExplorations.length - 200);
    // 同步计入探索计数（防止同一边被反复实验）
    this.explorationCounts.set(experiment.from, (this.explorationCounts.get(experiment.from) ?? 0) + 1);
    return record;
  }

  /** 5.0：因果实验历史 */
  getCausalExplorations(): CausalExplorationRecord[] {
    return [...this.causalExplorations];
  }

  /** 5.0：实验的信息增益率（平均区间收缩比例） */
  getCausalYield(): number {
    if (this.causalExplorations.length === 0) return 0;
    const reductions = this.causalExplorations.map((r) => Math.max(0, r.uncertaintyBefore - r.uncertaintyAfter) / Math.max(0.01, r.uncertaintyBefore));
    return Number((reductions.reduce((a, b) => a + b, 0) / reductions.length).toFixed(3));
  }

  /**
   * 扫描知识盲区
   *
   * 第三轮升级（69.0 盲区定向，挂载即生效 / 未挂载零漂移）：挂载
   * MapperBlindSpot 提供器后，经典盲区的新颖度与拓扑盲区分加权融合，
   * 且「有经验、失败率不高但身处拓扑盲区（稀疏节点/边界前沿/孤岛）」
   * 的类型以 topological 成因补全入池——这类盲区经典口径永远看不见。
   * @returns 盲区候选列表（按新颖度降序）
   */
  scanKnowledgeGaps(): KnowledgeGap[] {
    const exposure = this.provider.getExposure();
    const experience = this.provider.getExperienceCounts();
    const failureRates = this.provider.getFailureRates();
    const gaps: KnowledgeGap[] = [];

    const maxExposure = Math.max(1, ...Object.values(exposure));

    for (const [taskType, exposureCount] of Object.entries(exposure)) {
      const experienceCount = experience[taskType] ?? 0;
      const failureRate = failureRates[taskType] ?? 0;
      const explorationCount = this.explorationCounts.get(taskType) ?? 0;

      // 盲区成因判定
      let reason: KnowledgeGap['reason'] | null = null;
      if (experienceCount === 0) reason = 'unexplored';
      else if (failureRate >= this.config.highFailureRateThreshold) reason = 'high-failure';
      else if (experienceCount < this.config.lowExperienceThreshold) reason = 'low-experience';
      if (!reason) continue;

      // 新颖度评分：未知程度 + 接触频率 + 探索稀缺度
      const unknownScore = reason === 'unexplored' ? 1 : experienceCount < this.config.lowExperienceThreshold ? 0.6 : 0.4;
      const exposureScore = exposureCount / maxExposure;
      const scarcityScore = 1 / (1 + explorationCount);
      const noveltyScore =
        unknownScore * this.config.noveltyUnknownWeight +
        exposureScore * this.config.noveltyExposureWeight +
        scarcityScore * this.config.noveltyScarcityWeight;

      gaps.push({
        taskType,
        reason,
        exposureCount,
        experienceCount,
        explorationCount,
        noveltyScore: Number(noveltyScore.toFixed(3)),
      });
    }

    // 文档契约：按新颖度降序返回（预算截断的 top-k 与 topGaps 读数口径）。
    // 缺了这步排序时选择按 exposure 插入序进行——已探索类型的稀缺度衰减
    // （1/(1+探索次数)）无法把其挤出预算窗口，同一盲区会被反复探索
    gaps.sort((a, b) => b.noveltyScore - a.noveltyScore);

    // 第三轮 69.0：拓扑盲区定向融合 + topological 成因补全（未挂载零漂移）
    return this.applyMapperDirection(gaps);
  }

  /**
   * 30.0：挂载次模选择器（幂等）。
   *
   * top-k 按新颖度选盲区是模函数口径——共享主题的盲区（'generate-code' /
   * 'review-code' 同含 code）被重复购买。挂载后探索预算按加权覆盖次模
   * 函数惰性贪心分配（CELF，≥ (1−1/e)·OPT）：同主题第二个候选的边际
   * 自动衰减，预算优先流向互补的知识结构。未挂载即零漂移（原 top-k）。
   */
  attachSubmodularSelector(options?: { coverageStrength?: number }): void {
    this.submodularSelector = { coverageStrength: options?.coverageStrength ?? 0.7 };
  }

  private submodularSelector?: { coverageStrength: number };

  /**
   * 44.0：挂载公平预算（幂等覆盖，挂载即生效）。
   *
   * 探索预算按域（taskType）加权极大极小分配（新颖度权重 + 注水算法，
   * 词典序最优）：热门域可以多拿，但任何活跃域的相对份额不被压扁——
   * 探索的覆盖有公平定理背书（多样性坍缩在预算层上锁）。未挂载零漂移。
   */
  attachFairBudget(): void {
    this.fairBudget = true;
  }

  private fairBudget = false;

  // ─────────────── 第四轮升级：探索-利用预算自动平衡（缺省零漂移） ───────────────

  /** 自适应探索预算状态（attachAdaptiveExploration 挂载；未挂载 undefined → 固定比例） */
  private adaptiveExplorationState?: {
    minRatio: number;
    maxRatio: number;
    alpha: number;
    yieldEwma: number;
    samples: number;
    trend: 'expand' | 'steady' | 'tighten';
  };

  /**
   * 挂载探索-利用预算自动平衡（幂等覆盖，挂载即生效——预算口径）。
   *
   * 探索预算比例从固定值升级为「近期探索回报率」的反馈调节：
   * - 回报率 EWMA：recordExploration 的 gainedKnowledge（0/1 流）按
   *   alpha 指数加权——近期探索收获权重高，远期逐渐淡忘
   * - 有效比例 = minRatio + (maxRatio − minRatio) × EWMA：探索前热
   *   （连续填补盲区）→ 比例向 maxRatio 扩张、预算变多；后冷（连续
   *   无收获）→ 比例向 minRatio 收缩、预算回流核心任务
   * - 零样本初值：EWMA 取使有效比例恰等于基础比例的点——挂载瞬间
   *   预算逐位不变（零漂移），首个样本后才开始调节
   * 未挂载 → proposeExplorations 仍按固定 explorationBudgetRatio
   * （第三轮及以前行为，逐位不变）。
   */
  attachAdaptiveExploration(options?: AdaptiveExplorationOptions): void {
    const base = Math.max(0.01, Math.min(1, this.config.explorationBudgetRatio));
    const minRatio = Math.max(0.01, Math.min(options?.minRatio ?? Math.max(0.05, base / 2), base));
    const maxRatio = Math.max(base, Math.min(options?.maxRatio ?? Math.min(1, base * 1.5), 1));
    const alpha = Math.max(0.01, Math.min(1, options?.alpha ?? 0.4));
    const yieldEwma = maxRatio > minRatio ? Math.max(0, Math.min(1, (base - minRatio) / (maxRatio - minRatio))) : 0.5;
    this.adaptiveExplorationState = { minRatio, maxRatio, alpha, yieldEwma, samples: 0, trend: 'steady' };
  }

  /** 自适应探索预算遥测（未挂载 undefined） */
  adaptiveExplorationView(): AdaptiveExplorationTelemetry | undefined {
    const state = this.adaptiveExplorationState;
    if (!state) return undefined;
    return {
      baseRatio: this.config.explorationBudgetRatio,
      minRatio: Number(state.minRatio.toFixed(4)),
      maxRatio: Number(state.maxRatio.toFixed(4)),
      yieldEwma: Number(state.yieldEwma.toFixed(4)),
      effectiveRatio: Number(this.effectiveExplorationRatio().toFixed(4)),
      samples: state.samples,
      trend: state.trend,
    };
  }

  /** 有效探索比例（挂载态的预算取用值；未挂载 = 基础比例） */
  private effectiveExplorationRatio(): number {
    const state = this.adaptiveExplorationState;
    if (!state) return this.config.explorationBudgetRatio;
    return state.minRatio + (state.maxRatio - state.minRatio) * state.yieldEwma;
  }

  /** 30.0：任务类型 → token 集（主题 = 共享 token；camelCase 与连字符统一拆分） */
  private static tokenize(taskType: string): string[] {
    return taskType
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2);
  }
  /**
   * 生成探索建议（受预算约束）
   * @param dispatchSlots 本轮心跳的总派发槽位数
   * @param healthScore 系统健康度 0~1（健康时多探索）
   * @returns 探索任务建议列表
   *
   * 30.0：挂载次模选择器后，预算内选择从「新颖度 top-k」升级为
   * 加权覆盖惰性贪心——共享主题的盲区边际自动衰减（CELF 保证
   * ≥ (1−1/e)·OPT）；主题来自任务类型 token 集。候选不足预算时
   * 两者结果一致（全部选中）。
   *
   * 第四轮：挂载自适应探索预算后，比例取 effectiveExplorationRatio()
   * （近期回报率反馈调节）；未挂载 → 固定 explorationBudgetRatio（零漂移）。
   */
  proposeExplorations(dispatchSlots: number, healthScore = 1): ExplorationProposal[] {
    // 探索预算：探索比例（固定或回报率自适应）× 健康度调节（退化时收敛探索）
    const healthFactor = Math.max(0.2, Math.min(1, healthScore));
    const ratio = this.adaptiveExplorationState ? this.effectiveExplorationRatio() : this.config.explorationBudgetRatio;
    const budget = Math.floor(dispatchSlots * ratio * healthFactor);
    if (budget <= 0) return [];

    const gaps = this.scanKnowledgeGaps();
    if (gaps.length <= budget) {
      return gaps.map((gap) => ({
        taskType: gap.taskType,
        description: this.describeExploration(gap),
        noveltyScore: gap.noveltyScore,
        expectedGain: this.describeGain(gap),
      }));
    }

    // 44.0 公平预算路径：按域（任务家族 = 类型首 token，如 gen-* / review-*）
    // 加权极大极小分配——热门家族可以多拿，但任何活跃家族的相对份额不被
    // 压扁（整数保底：高权重家族优先各得 1，再按新颖度权重注水）；
    // 家族内按新颖度取 top。未挂载时零漂移（原 top-k / 次模路径不变）。
    if (this.fairBudget) {
      const familyOf = (taskType: string) => taskType.split(/[-_\s]/)[0] || taskType;
      const byDomain = new Map<string, KnowledgeGap[]>();
      for (const gap of gaps) {
        const family = familyOf(gap.taskType);
        const bucket = byDomain.get(family) ?? [];
        bucket.push(gap);
        byDomain.set(family, bucket);
      }
      const shares = new Map(
        fairDomainBudget(
          [...byDomain.entries()].map(([id, list]) => ({
            id,
            demand: list.length,
            weight: Math.max(1e-6, list.reduce((s, g) => s + g.noveltyScore, 0) / list.length),
          })),
          budget,
        ).map((s) => [s.id, Math.floor(s.share)]),
      );
      const proposals: ExplorationProposal[] = [];
      const domainsSorted = [...byDomain.entries()].sort((a, b) => shares.get(b[0])! - shares.get(a[0])!);
      for (const [domain, list] of domainsSorted) {
        const take = Math.min(list.length, shares.get(domain) ?? 0);
        for (const gap of [...list].sort((a, b) => b.noveltyScore - a.noveltyScore).slice(0, take)) {
          proposals.push({
            taskType: gap.taskType,
            description: this.describeExploration(gap),
            noveltyScore: gap.noveltyScore,
            expectedGain: this.describeGain(gap),
          });
        }
      }
      // 尾差补齐（floor 损失的名额按全局新颖度回填）
      if (proposals.length < budget) {
        const taken = new Set(proposals.map((p) => p.taskType + p.description));
        for (const gap of [...gaps].sort((a, b) => b.noveltyScore - a.noveltyScore)) {
          if (proposals.length >= budget) break;
          const key = gap.taskType + this.describeExploration(gap);
          if (taken.has(key)) continue;
          taken.add(key);
          proposals.push({
            taskType: gap.taskType,
            description: this.describeExploration(gap),
            noveltyScore: gap.noveltyScore,
            expectedGain: this.describeGain(gap),
          });
        }
      }
      return proposals.slice(0, budget);
    }

    // 30.0 次模路径：加权覆盖（主题 = 共享 token）惰性贪心
    if (this.submodularSelector) {
      const cov = coverageFromTokens(
        gaps.map((gap) => ({ tokens: CuriosityEngine.tokenize(gap.taskType), weight: Math.max(1e-6, gap.noveltyScore) })),
        this.submodularSelector.coverageStrength,
      );
      const order = lazyGreedy(cov, budget);
      const byType = new Map(gaps.map((gap) => [gap.taskType, gap]));
      const proposals: ExplorationProposal[] = [];
      for (const idx of order.selected) {
        const gap = byType.get(gaps[idx]!.taskType);
        if (!gap) continue;
        proposals.push({
          taskType: gap.taskType,
          description: this.describeExploration(gap),
          noveltyScore: gap.noveltyScore,
          expectedGain: this.describeGain(gap),
        });
      }
      if (proposals.length > 0) return proposals.slice(0, budget);
    }

    // 原路径（未挂载次模选择器）：新颖度 top-k
    const proposals: ExplorationProposal[] = [];
    for (const gap of gaps) {
      if (proposals.length >= budget) break;
      proposals.push({
        taskType: gap.taskType,
        description: this.describeExploration(gap),
        noveltyScore: gap.noveltyScore,
        expectedGain: this.describeGain(gap),
      });
    }
    return proposals;
  }

  /**
   * 回写探索结果（探索完成后调用）
   * @param taskType 探索的任务类型
   * @param gainedKnowledge 是否填补了盲区
   * @param note 备注
   */
  recordExploration(taskType: string, gainedKnowledge: boolean, note?: string): void {
    this.explorations.push({ taskType, timestamp: Date.now(), gainedKnowledge, note });
    this.explorationCounts.set(taskType, (this.explorationCounts.get(taskType) ?? 0) + 1);
    if (this.explorations.length > 200) this.explorations.splice(0, this.explorations.length - 200);
    // 第四轮：回报率 EWMA 更新（未挂载自适应预算 → 零介入，逐位不变）
    const adaptive = this.adaptiveExplorationState;
    if (adaptive) {
      const prev = adaptive.yieldEwma;
      adaptive.yieldEwma = prev + adaptive.alpha * ((gainedKnowledge ? 1 : 0) - prev);
      adaptive.samples += 1;
      adaptive.trend = adaptive.yieldEwma > prev + 1e-12 ? 'expand' : adaptive.yieldEwma < prev - 1e-12 ? 'tighten' : 'steady';
    }
    // 59.0：探索结局回填难度课程（未挂载零介入——只追加掌握状态机记账，
    // 不改变探索派发/统计任何行为）
    this.curriculum?.report(gainedKnowledge);
  }

  /**
   * 59.0：挂载探索难度课程（幂等覆盖，挂载即生效——记账 + 读数口径）。
   *
   * 探索结局（是否填补盲区）喂入掌握门限状态机（Beta(1,1) 共轭后验，
   * 后验达标 + 连击才晋升——幸运连击推不高稀证据的后验）；curriculumView()
   * 给出当前难度档——探索从均匀乱试升级为「带内练习、掌握爬阶」的
   * 可审计画像（难度档建议由派发侧按需消费，引擎不强制）。
   */
  attachCurriculum(options?: { levelCount?: number; threshold?: number; promoteR?: number; demoteS?: number }): void {
    this.curriculum = new ExplorationCurriculum(options);
  }

  /** 59.0：探索难度课程（未挂载 undefined） */
  private curriculum?: ExplorationCurriculum;

  /** 59.0：当前难度档读数（未挂载 undefined） */
  curriculumView(): { level: number; levelCount: number; name: string } | undefined {
    return this.curriculum?.view();
  }

  /**
   * 91.0：挂载新奇搜索定向（幂等覆盖，挂载即生效——咨询口径）。
   *
   * 探索预算从「随机噪声 + 简单好奇分」升级为新奇定向：候选方向的预期
   * 行为特征喂 noveltyScore（对档案的 kNN 距离）——novelty 越高分配越多
   * 探索预算（好奇心 = 新奇分的单调函数，内在奖励有了可计算口径）。
   * minCriterion 挂 MCNS 可行性门槛（预算禁区/安全边界内定向）。
   * 不改变探索派发行为（零漂移）。
   */
  attachNoveltySearch(options?: { k?: number }): void {
    this.noveltySearchOptions = { k: options?.k ?? 3 };
  }

  /** 91.0：新奇搜索配置（未挂载 undefined） */
  private noveltySearchOptions?: { k: number };

  /**
   * 91.0：新奇定向读数（未挂载 / 无档案时 undefined）。
   * @param candidates 候选方向的预期行为特征向量表
   * @param archive 已探索行为档案（如 69.0 Mapper 节点坐标 / 经验轨迹表示）
   */
  noveltySearchView(
    candidates: ReadonlyArray<ReadonlyArray<number>>,
    archive: ReadonlyArray<ReadonlyArray<number>>,
  ): NoveltyDirectionView | undefined {
    return this.noveltySearchOptions ? noveltyDirectionProbe(candidates, archive, { k: this.noveltySearchOptions.k }) : undefined;
  }

  /**
   * 第三轮 69.0：挂载 Mapper 拓扑盲区定向（幂等覆盖，挂载即生效）。
   *
   * 探索从「随机 + 经典好奇分」升级为盲区定向：provider 给出经验地形
   * 的 Mapper 骨架视图（结构兼容 world-model.experienceMapperView），
   * 引擎按三轴拓扑信号定分——
   * - 稀疏（节点成员少 = 经验空白带）0.4
   * - 前沿（节点度数低 = 经验大陆边缘）0.3
   * - 孤岛（连通分量小 = 与主经验失连的知识岛）0.3
   * 既有盲区的新颖度与拓扑分按 weight 融合；经典口径看不见的拓扑盲区
   * 类型以 'topological' 成因补全入池。未挂载 → scanKnowledgeGaps /
   * proposeExplorations 输出逐位不变（零漂移）。
   * @param provider 视图提供器（数据不足 / 异常时返回 undefined 即诚实降级）
   * @param options.weight 拓扑分融合权重（缺省 0.5）
   */
  attachMapperBlindSpot(provider: () => MapperBlindSpotView | undefined, options?: { weight?: number }): void {
    this.mapperBlindSpot = {
      provider,
      weight: Math.max(0, Math.min(1, options?.weight ?? 0.5)),
    };
  }

  /** 第三轮 69.0：Mapper 盲区定向配置（未挂载 undefined） */
  private mapperBlindSpot?: { provider: () => MapperBlindSpotView | undefined; weight: number };

  /**
   * 第三轮 69.0：拓扑盲区读数（未挂载 / 视图缺席时 undefined）。
   * 每个类型的 { 稀疏, 前沿, 孤岛, 综合 } 分（归一口径，审计可用）。
   */
  mapperBlindSpotView(): { scores: Array<{ taskType: string; sparsity: number; frontier: number; isolation: number; topoScore: number }>; insight: string } | undefined {
    if (!this.mapperBlindSpot) return undefined;
    let view: MapperBlindSpotView | undefined;
    try {
      view = this.mapperBlindSpot.provider();
    } catch {
      return undefined;
    }
    if (!view || view.nodes.length === 0) return undefined;
    const scores = this.topoScores(view);
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    return {
      scores: ranked.map(([taskType, topoScore]) => {
        const axes = this.topoAxes.get(taskType) ?? { sparsity: 0, frontier: 0, isolation: 0 };
        return {
          taskType,
          sparsity: Number(axes.sparsity.toFixed(3)),
          frontier: Number(axes.frontier.toFixed(3)),
          isolation: Number(axes.isolation.toFixed(3)),
          topoScore: Number(topoScore.toFixed(3)),
        };
      }),
      insight: `盲区定向：${scores.size} 类型入图——头号拓扑盲区「${top?.[0] ?? '—'}」（综合 ${top ? top[1].toFixed(3) : '—'}：稀疏 ${top ? (this.topoAxes.get(top[0])?.sparsity ?? 0).toFixed(3) : '—'} / 前沿 ${top ? (this.topoAxes.get(top[0])?.frontier ?? 0).toFixed(3) : '—'} / 孤岛 ${top ? (this.topoAxes.get(top[0])?.isolation ?? 0).toFixed(3) : '—'}）——探索预算向经验地形的空白带定向`,
    };
  }

  /** 三轴分缓存（topoScores 副产品，读数用） */
  private topoAxes = new Map<string, { sparsity: number; frontier: number; isolation: number }>();

  /** 探索历史 */
  getExplorations(): ExplorationRecord[] {
    return [...this.explorations];
  }

  /** 探索收获率（填补盲区的比例） */
  getExplorationYield(): number {
    if (this.explorations.length === 0) return 0;
    const gained = this.explorations.filter((e) => e.gainedKnowledge).length;
    return Number((gained / this.explorations.length).toFixed(3));
  }

  /** 好奇心摘要 */
  getSummary(): any {
    return {
      totalExplorations: this.explorations.length,
      explorationYield: this.getExplorationYield(),
      topGaps: this.scanKnowledgeGaps().slice(0, 5),
      explorationCounts: Object.fromEntries(this.explorationCounts),
      /** 5.0：假设驱动实验（因果好奇心） */
      causalExperiments: this.causalExplorations.length,
      causalYield: this.getCausalYield(),
      pendingHypotheses: this.proposeCausalExperiments('task.outcome', 3),
    };
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /**
   * 69.0 拓扑定向融合（scanKnowledgeGaps 专用；未挂载原样返回——零漂移）。
   * ① 既有盲区新颖度 × (1−w) + 拓扑分 × w；② 视图中经典口径看不见的
   * 类型以 topological 成因补全（noveltyScore = 拓扑分——纯定向口径）。
   */
  private applyMapperDirection(gaps: KnowledgeGap[]): KnowledgeGap[] {
    if (!this.mapperBlindSpot) return gaps;
    let view: MapperBlindSpotView | undefined;
    try {
      view = this.mapperBlindSpot.provider();
    } catch {
      return gaps; // 视图异常 → 诚实降级回经典口径
    }
    if (!view || view.nodes.length === 0) return gaps;

    const topo = this.topoScores(view);
    const weight = this.mapperBlindSpot.weight;
    const blended = gaps.map((gap) => {
      const topoScore = topo.get(gap.taskType);
      if (topoScore === undefined) return gap;
      return {
        ...gap,
        noveltyScore: Number((gap.noveltyScore * (1 - weight) + topoScore * weight).toFixed(3)),
      };
    });

    const exposure = this.provider.getExposure();
    const experience = this.provider.getExperienceCounts();
    const seen = new Set(blended.map((gap) => gap.taskType));
    for (const [taskType, topoScore] of topo) {
      if (seen.has(taskType)) continue;
      // 拓扑补全项同样吃探索稀缺衰减（1/(1+探索次数)）——同一盲区反复
      // 探索边际递减，定向不等于钉死一处：填过一轮的盲区自动让位给
      // 下一个未探索盲区
      const explorationCount = this.explorationCounts.get(taskType) ?? 0;
      blended.push({
        taskType,
        reason: 'topological',
        exposureCount: exposure[taskType] ?? 0,
        experienceCount: experience[taskType] ?? 0,
        explorationCount,
        noveltyScore: Number((topoScore / (1 + explorationCount)).toFixed(3)),
      });
    }
    return blended.sort((a, b) => b.noveltyScore - a.noveltyScore);
  }

  /**
   * 69.0 三轴拓扑盲区分（稀疏 0.4 / 前沿 0.3 / 孤岛 0.3，各轴跨类型
   * 归一到 [0,1]；类型出现于多节点时按轴取最盲的一侧；孤岛轴按分量内
   * 类型总数计——「知识岛」规模）。副产品缓存 topoAxes 供
   * mapperBlindSpotView 审计读数。
   */
  private topoScores(view: MapperBlindSpotView): Map<string, number> {
    // 节点规模 / 度数
    const nodeSize = view.nodes.map((node) => Math.max(1, node.members.length));
    const degree = new Array<number>(view.nodes.length).fill(0);
    for (const [a, b] of view.edges) {
      if (a >= 0 && a < view.nodes.length) degree[a] += 1;
      if (b >= 0 && b < view.nodes.length) degree[b] += 1;
    }
    // 连通分量（union-find）；分量规模按「知识岛」计——分量内类型总数
    // （成员去重：大陆 = 类型多的大岛，孤岛 = 类型少的小岛）
    const parent = Array.from({ length: view.nodes.length }, (_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (const [a, b] of view.edges) {
      if (a < 0 || a >= view.nodes.length || b < 0 || b >= view.nodes.length) continue;
      parent[find(a)] = find(b);
    }
    const compMembers = new Map<number, Set<string>>();
    for (let i = 0; i < view.nodes.length; i += 1) {
      const root = find(i);
      let set = compMembers.get(root);
      if (!set) {
        set = new Set<string>();
        compMembers.set(root, set);
      }
      for (const member of view.nodes[i].members) set.add(member);
    }

    // 类型 → 各轴原始分（多节点取最盲侧：size 最小 / degree 最小 / 知识岛最小）
    const raw = new Map<string, { size: number; degree: number; comp: number }>();
    view.nodes.forEach((node, ni) => {
      for (const taskType of node.members) {
        const prev = raw.get(taskType);
        const size = nodeSize[ni] ?? 1;
        const deg = degree[ni] ?? 0;
        const comp = compMembers.get(find(ni))?.size ?? 1;
        if (!prev) raw.set(taskType, { size, degree: deg, comp });
        else raw.set(taskType, { size: Math.min(prev.size, size), degree: Math.min(prev.degree, deg), comp: Math.min(prev.comp, comp) });
      }
    });

    // 各轴归一（除以最大值 → 最盲类型 = 1）
    const axes = [...raw.entries()].map(([taskType, v]) => ({
      taskType,
      sparsity: 1 / v.size,
      frontier: 1 / (1 + v.degree),
      isolation: 1 / v.comp,
    }));
    const maxSparsity = Math.max(...axes.map((a) => a.sparsity), 1e-9);
    const maxFrontier = Math.max(...axes.map((a) => a.frontier), 1e-9);
    const maxIsolation = Math.max(...axes.map((a) => a.isolation), 1e-9);
    const scores = new Map<string, number>();
    this.topoAxes.clear();
    for (const a of axes) {
      const sparsity = a.sparsity / maxSparsity;
      const frontier = a.frontier / maxFrontier;
      const isolation = a.isolation / maxIsolation;
      this.topoAxes.set(a.taskType, { sparsity, frontier, isolation });
      scores.set(a.taskType, Number((0.4 * sparsity + 0.3 * frontier + 0.3 * isolation).toFixed(3)));
    }
    return scores;
  }

  /** 生成探索任务描述 */
  private describeExploration(gap: KnowledgeGap): string {
    switch (gap.reason) {
      case 'unexplored':
        return `探索未知任务类型「${gap.taskType}」：系统已接触 ${gap.exposureCount} 次但尚无成功经验，需建立首个成功范例`;
      case 'high-failure':
        return `攻克高失败任务类型「${gap.taskType}」：失败率偏高，需探索更可靠的执行方案`;
      case 'low-experience':
        return `深化低经验任务类型「${gap.taskType}」：成功经验不足，需积累更多成功范例`;
      case 'topological':
        return `定向探索拓扑盲区「${gap.taskType}」：经验地形上身处稀疏/前沿/孤岛带（经典盲区口径看不见——定向好奇专属）`;
      default:
        return `探索任务类型「${gap.taskType}」`;
    }
  }

  /** 生成预期收益描述 */
  private describeGain(gap: KnowledgeGap): string {
    switch (gap.reason) {
      case 'unexplored':
        return `填补「${gap.taskType}」的经验空白，使系统具备处理该类任务的能力`;
      case 'high-failure':
        return `降低「${gap.taskType}」的失败率，提升该类任务的可靠性`;
      case 'low-experience':
        return `丰富「${gap.taskType}」的成功经验库，提升决策与模型分配的准确性`;
      case 'topological':
        return `把「${gap.taskType}」连回经验大陆：填补 Mapper 骨架的稀疏带/边缘/孤岛，扩大可迁移经验的覆盖面`;
      default:
        return `增强「${gap.taskType}」的处理能力`;
    }
  }
}
