/**
 * optimizer.ts — 优化器组件（新架构「记忆库 → 优化器 → 模型调度」）
 *
 * 职责（对应架构图 Optimizer 框）：
 * - 经验检索：查询记忆库匹配相似任务模式，产出按节点类型的推荐模型组合
 * - 经验快路径：命中高置信度模式时直接召回历史最优成功计划，跳过 LLM 重新规划
 * - 策略/教训召回：为计划生成注入蒸馏策略与历史教训上下文（由编排层组合调用）
 *
 * 第四轮 R4-A6 新增维度（全部 opt-in，未挂载零漂移）：
 * - 经验迁移推荐：检索无直接命中时跨任务类型借「结构相似」异类经验，
 *   可迁移置信标注 + 不可迁移对拒因落账（attachTransferRecommendation）
 * - 经验置信传播：经验置信随借用结果传播（成功上调 / 失败下调并降权，
 *   有界收敛；借用对 Wilson 学习分）（attachExperiencePropagation）
 * - 计划模板抽象：成功计划泛化为参数化模板（具体值→槽位），复用时实例化
 *   回填（attachPlanTemplates）
 *
 * 边界：只读记忆库 + 产出调度建议，不执行任务、不写记忆。
 * 写记忆统一由反思器（reflector.ts）负责，形成单向数据流：
 *   记忆库 → 优化器 → 模型调度/任务执行 → 反思器 → 记忆更新 → 记忆库
 * （R4 新增三面均为模块本地账 / 本地模板库，不破只读边界）
 */

import type { ExecutionPlan, PlanNode } from './types.js';
import type { IMemoryStore, IOptimizer } from './contracts.js';
import type { ProceduralAction, ProceduralMemory, SemanticMemory, TaskPatternMemory } from './memory/long-term-memory.js';
import { matchesMemoryConditions } from './memory/long-term-memory.js';
import type { MemoryGraph } from './memory/memory-graph.js';
import type { MemorySearchHit } from './memory/backend.js';
import type { ProgressBroadcaster } from './progress-ws.js';
import { resolveEffectiveParams, type Policy } from './policy/policy-types.js';
import type { DeliberationEngine, DeliberationResult } from './core/deliberation.js';
import type { ArbitrationResult, RationalMetareasoner } from './core/metareasoning.js';
// 创世纪 71.0/72.0：A* 最优子计划搜索 / Lasso+CV 稀疏归因
import { astar, graphFromEdgeList, zeroHeuristic } from './core/astar-search.js';
import { cvLasso, lassoCD } from './core/sparse-recovery.js';
// 第三轮模块域升级 A6：经验检索置信路由（字段加权 + 时效衰减，与全层证据共用 30 天半衰期）
// 第四轮模块域升级 R4-A6：置信传播的借用对学习分（Wilson 95% 下界——与全层证据同一统计语言）
import { decayFactor, wilsonLowerBound } from './core/evidence.js';

/**
 * 记忆层级（第二阶段）
 *
 * 优化器推荐优先级：procedural > semantic > episodic > none
 * - procedural：程序记忆命中（最具体的 if-then 规则）
 * - semantic：语义记忆命中（跨任务抽象规律）
 * - episodic：情景记忆命中（既有任务模式匹配）
 * - none：无任何记忆命中（首次任务）
 */
export type MemoryLayer = 'procedural' | 'semantic' | 'episodic' | 'none';

/** 经验检索结果（优化器产物，供模型调度消费） */
export interface ExperienceLookup {
  pattern?: TaskPatternMemory;
  /** 按节点类型的推荐模型组合（模型调度优先采用） */
  recommendedModels: Record<string, string>;
  historicalSuccessRate: number;
  avgExecutionTime: number;
  // ── 第二阶段：三层记忆推荐来源 ──
  /** 命中的最高记忆层级（procedural > semantic > episodic > none） */
  memoryLayer: MemoryLayer;
  /** 决策依据说明（人类可读，供广播与可观测性） */
  rationale: string;
  /** 命中的程序记忆 id（memoryLayer='procedural' 时非空） */
  matchedProceduralId?: string;
  /** 命中的语义记忆 id（memoryLayer='semantic' 时非空） */
  matchedSemanticId?: string;
  /** 程序记忆触发的动作列表（供执行器/调度器消费：启用思维链、避免某模型等） */
  suggestedActions?: ProceduralAction[];
  // ── 第二阶段升级：负向约束与多规则命中 ──
  /** 程序记忆聚合的规避模型列表（avoid-model 动作目标；调度时从候选中剔除） */
  avoidModels: string[];
  /** 本次条件匹配命中的全部程序记忆 id（应用反馈闭环回写用） */
  matchedProceduralIds?: string[];
  // ── 第三阶段：策略进化 ──
  /** 本次推荐使用的调度策略版本（policyId@vN；策略热切换后随次检索更新） */
  policyVersion: string;
  // ── 第三轮 A6 升级 2：推荐理由分解（attachRecommendationDecomposition 后输出；未挂载时字段省略——零漂移） ──
  /** 推荐 + 备选的历史质量/成本/速度三维理由分解 */
  recommendation?: RecommendationBreakdown;
  // ── 第四轮 R4-A6 升级 1：经验迁移推荐（attachTransferRecommendation 后且无直接命中时输出；未挂载时字段省略——零漂移） ──
  /** 无直接命中时的跨任务类型经验借用推荐（结构相似异类经验 + 可迁移置信标注） */
  transfer?: TransferRecommendation;
}

/**
 * 第三轮 A6 升级 2：单模型三维记分卡（推荐理由分解的原子产物）
 *
 * 三个维度全部来自记忆库的历史统计（不是模型供应商标称参数——
 * 系统只相信自己在该任务类型上亲测过的表现）：
 * - quality：质量维。贝叶斯后验均值（记忆库支持时）→ 平均质量分回退
 * - cost：成本维。costEfficiency（质量/千 token 的 EMA，越高越便宜）
 * - speed：速度维。平均时延的倒数映射 1/(1+avgLatency/refLatency) ∈ (0,1]
 */
export interface ModelDimensionScore {
  modelId: string;
  /** 质量维 0~1（期望交付质量 = 成功质量 EMA × 成功概率（贝叶斯后验均值优先）） */
  quality: number;
  /** 成本维 0~1（质量/千 token 效率，越高越省） */
  cost: number;
  /** 速度维 0~1（时延倒数映射，越快越高） */
  speed: number;
  /** 该模型在该任务类型上的有效样本量（0 = 无历史，不入分解） */
  samples: number;
}

/** 第三轮 A6 升级 2：推荐理由分解（推荐 + 备选 + 三维记分 + 人类可读理由） */
export interface RecommendationBreakdown {
  taskType: string;
  /** 主推荐模型（与 recommendedModels[taskType] 一致；无推荐时 undefined 缺省由 alternatives 头名补位） */
  primary?: ModelDimensionScore;
  /** 备选模型（按三维加权综合分降序，剔除主推荐与规避模型） */
  alternatives: ModelDimensionScore[];
  /** 人类可读三维理由（推荐为什么是它、备选在哪个维度更优） */
  rationale: string;
}

/**
 * 第三轮 A6 升级 1：经验快路径的置信路由账单（命中 / 回退两路由的决策记录）
 *
 * 字段加权综合置信度 = (w_conf × 模式置信度 + w_rate × 历史成功率 + w_sup × 样本支撑度)
 *                      × 时效新鲜度（半衰期衰减，旧经验自然让位）
 * 综合分 ≥ 阈值 → hit（直接复用历史最优计划）；否则 → fallback（回退 DAG
 * 重新规划），两路由均落账可审计。
 */
export interface RecallRouteRecord {
  /** 决策时刻（注入时钟口径） */
  at: number;
  /** 字段加权原始分（未乘时效） */
  weightedBase: number;
  /** 历史成功率分量 0~1 */
  successRate: number;
  /** 样本支撑度分量 0~1（frequency / 饱和样本数，上限 1） */
  sampleSupport: number;
  /** 时效新鲜度因子 0~1（0.5^(ageDays/halfLifeDays)） */
  freshness: number;
  /** 综合置信度（weightedBase × freshness） */
  composite: number;
  /** 判定阈值 */
  threshold: number;
  /** 模式年龄（天） */
  ageDays: number;
  /** 路由结果：hit = 复用历史计划 / fallback = 回退 DAG 生成 */
  route: 'hit' | 'fallback';
  /** 路由理由（含未命中原因编码） */
  reason: 'above-threshold' | 'below-confidence' | 'no-pattern' | 'no-successful-plans';
}

// ───────────────────── 第四轮模块域升级 R4-A6：经验迁移推荐 / 置信传播 / 计划模板 ─────────────────────

/**
 * R4-A6 升级 1：可迁移经验候选（异类任务经验的借用建议）
 *
 * 「结构相似」口径（任务特征向量距离——确定性、无嵌入依赖）：
 * - 注入 featureVectorOf 时：来源/目标任务类型的特征向量余弦相似度
 * - 缺省回退：特征集 Jaccard × featureWeight + 复杂度贴近度 × (1−featureWeight)
 *
 * 可迁移置信 = similarity × sourceStrength × propagationWeight：
 * - sourceStrength = 来源模式历史成功率 × 置信度（借用方只信亲测过的来源）
 * - propagationWeight = 借用传播权重（升级 4：借出反复失败的经验降权，恒 1 起步）
 */
export interface TransferCandidate {
  /** 来源任务类型（异类——同类型属直接命中域，不入迁移） */
  sourceTaskType: string;
  /** 来源模式指纹 */
  sourceFingerprint: string;
  /** 结构相似度 0~1（任务特征向量距离口径） */
  similarity: number;
  /** 来源经验自身质量 0~1（成功率 × 置信度） */
  sourceStrength: number;
  /** 可迁移置信 0~1（similarity × sourceStrength × propagationWeight） */
  transferConfidence: number;
  /** 借用产物的按节点类型推荐模型组合（来源最优组合映射） */
  borrowedModels: Record<string, string>;
  /** 人类可读理由 */
  rationale: string;
}

/** R4-A6 升级 1：被拒候选的结构化落账（不可迁移对要可审计） */
export interface TransferRejection {
  sourceTaskType: string;
  similarity: number;
  transferConfidence: number;
  /** 拒因：结构不相似 / 来源证据弱 / 综合置信不足 */
  reason: 'below-similarity' | 'weak-source' | 'below-threshold';
}

/** R4-A6 升级 1：跨任务经验迁移推荐（检索无直接命中时的第二落点） */
export interface TransferRecommendation {
  taskType: string;
  /** 最高可迁移候选（≥ minTransferConfidence 才有） */
  best?: TransferCandidate;
  /** 通过全部门槛的候选（按可迁移置信降序） */
  candidates: TransferCandidate[];
  /** 被拒候选（含拒因——「不可迁移对被拒」的可审计证据） */
  rejected: TransferRejection[];
}

/**
 * R4-A6 升级 4：经验置信传播条目（一条经验被借用后的置信账）
 *
 * 经验条目置信随借用结果传播：
 * - 借出成功：effectiveConfidence ×(1+successGain)，单调上调、封顶 ceiling
 * - 借出失败：effectiveConfidence ×(1−failurePenalty) 且 weight ×weightDecay
 *   （下调 + 降权——失败经验既更不可信也更不被推荐）
 * - 全部有界收敛：floor ≤ effectiveConfidence ≤ ceiling，minWeight ≤ weight ≤ 1
 */
export interface PropagationEntry {
  fingerprint: string;
  sourceTaskType: string;
  /** 首次借出时的来源置信度（传播基准） */
  baseConfidence: number;
  borrowSuccesses: number;
  borrowFailures: number;
  /** 传播后有效置信 ∈ [floor, ceiling] */
  effectiveConfidence: number;
  /** 借出权重 ∈ [minWeight, 1]（失败降权；恢复靠成功的置信上调，权重保守不放） */
  weight: number;
  lastSettledAt: number;
}

/** R4-A6 升级 4：有向借用对统计（A→B 方向；Wilson 下界学习口径） */
export interface BorrowPairStats {
  from: string;
  to: string;
  trials: number;
  successes: number;
  /** Wilson 95% 下界（trials ≥ minTrials 才计算，否则 0） */
  wilsonLower: number;
  /** 是否已学习（借用史足够） */
  learned: boolean;
}

/**
 * R4-A6 升级 5（加分）：计划模板（成功计划的泛化抽象）
 *
 * 参数化节点：具体值→槽位——数字字面量替换为 `{slot-N}`（同值复用同槽），
 * 复用时实例化回填（目标目标文本中的数字按出现序自动绑定同序槽位）。
 */
export interface PlanTemplate {
  /** 内容寻址稳定 id（结构签名哈希） */
  id: string;
  /** 结构签名（节点类型序列 + 依赖形态 + 槽位化描述——同构计划同签名） */
  signature: string;
  /** 槽位化目标模板（含 {slot-N} 占位） */
  objectiveTemplate: string;
  /** 参数化节点（依赖以模板内下标表达，跨计划 node id 无关） */
  nodes: Array<{ slotDescription: string; type: string; dependsOnIdx: number[] }>;
  /** 槽位表（name + 提取时的样例值——复用缺省回填） */
  slots: Array<{ name: string; example: string }>;
  /** 复用实例化次数 */
  usage: number;
  /** 提取次数（同构成功计划合并计数） */
  extractions: number;
  /** 提取来源计划的平均质量 */
  avgQuality: number;
  extractedFrom: string;
  createdAt: number;
  lastUsedAt?: number;
}

/** R4-A6 升级 5：目标与模板的匹配读数 */
export interface TemplateMatch {
  template: PlanTemplate;
  /** 归一化 token 重叠分 0~1（数字掩码后比较——参数差异不罚分） */
  score: number;
}

/** 优化器配置 */
export interface OptimizerConfig {
  /**
   * 经验快路径：命中模式置信度 ≥ 该阈值时，直接复用历史最优成功计划，
   * 跳过 strategist LLM 重新规划（越用越快、越稳、越省 token）。
   * 设为 >1 可关闭快路径。缺省 0.9。
   */
  memoryFastPathThreshold?: number;
  /**
   * 第三轮 A6 升级 1：置信路由的样本支撑饱和数（frequency ≥ 该值时支撑度满 1）。
   * 缺省 8——少于 8 次的经验即使是全胜也应折价（小样本过拟合防护）。
   */
  recallSupportSaturation?: number;
}

/**
 * 优化器
 *
 * 被编排层（index.ts）持有：执行前调用 lookupExperience / recallPlan
 * 产出推荐模型与复用计划，喂给执行器（模型调度 + 任务执行）。
 *
 * 第三阶段升级（策略进化）：
 * - 策略版本标注：构造时注入 policyProvider（由编排层桥接到策略进化器或模型
 *   调度器），每次经验检索返回 policyVersion，推荐可追溯到具体策略版本
 * - 任务分解决策：shouldDecompose 按当前策略的分解规则判断是否拆分任务
 *   （沙盒中进化出的分解参数在操作环落地）
 * - 未注入 policyProvider 时标注 baseline 策略，行为与第二阶段一致（兼容）
 */
export class Optimizer implements IOptimizer {
  private memory: IMemoryStore;
  private config: OptimizerConfig;
  private broadcaster?: ProgressBroadcaster;
  private graph?: MemoryGraph;
  /** 当前调度策略提供器（第三阶段：策略版本标注与分解决策依据） */
  private policyProvider?: () => Policy;
  /** 7.0：深思内核（冷启动序列推荐 = 规划即推断） */
  private deliberation?: DeliberationEngine;
  /** 8.0：元推理内核（推荐的双过程仲裁 = 理性元推理） */
  private metareasoner?: RationalMetareasoner;

  constructor(params: {
    memory: IMemoryStore;
    config?: OptimizerConfig;
    broadcaster?: ProgressBroadcaster;
    graph?: MemoryGraph;
    policyProvider?: () => Policy;
  }) {
    this.memory = params.memory;
    this.config = params.config ?? {};
    this.broadcaster = params.broadcaster;
    this.graph = params.graph;
    this.policyProvider = params.policyProvider;
  }

  /** 7.0：挂载深思内核（幂等；挂载后获得冷启动深思推荐能力） */
  attachDeliberation(engine: DeliberationEngine): void {
    this.deliberation = engine;
  }

  /** 8.0：挂载元推理内核（幂等；挂载后推荐经双过程仲裁定价） */
  attachMetareasoner(reasoner: RationalMetareasoner): void {
    this.metareasoner = reasoner;
  }

  // ───────────────────── 第三轮模块域升级 A6：经验检索置信路由 + 推荐理由分解 ─────────────────────

  /**
   * 第三轮 A6 升级 1：挂载经验检索置信路由（幂等覆盖，挂载即生效）。
   *
   * recallPlan 的快路径判定从「模式置信度单一字段 ≥ 阈值」升级为
   * **字段加权综合置信度 + 时效衰减**的路由决策：
   *
   *   composite = (w_conf × confidence + w_rate × 历史成功率 + w_sup × 样本支撑度) × 0.5^(ageDays / halfLifeDays)
   *
   * - 半匹配经验（置信度高但成功率平庸 / 样本稀少 / 记忆陈旧）综合分
   *   跌破阈值 → 回退 DAG 重新规划，且路由决策落账（reason 可审计）
   * - 全新鲜且全胜的经验 → weightedBase ≈ 1、freshness ≈ 1 → 命中路由
   *   行为与旧口径一致（高置信模式照常复用）
   * - 未挂载零漂移：判定与返回值逐位等于旧口径（单一 confidence 比较）
   *
   * @param options.weights 三字段权重（缺省 0.5/0.3/0.2；自动归一化）
   * @param options.halfLifeDays 时效半衰期（缺省 30 天，与全层证据口径一致）
   * @param options.now 注入时钟（确定性验证用；缺省 Date.now）
   */
  attachRecallConfidenceRouting(options?: {
    weights?: { confidence?: number; successRate?: number; sampleSupport?: number };
    halfLifeDays?: number;
    now?: () => number;
  }): void {
    const w = options?.weights ?? {};
    const conf = Math.max(0, w.confidence ?? 0.5);
    const rate = Math.max(0, w.successRate ?? 0.3);
    const sup = Math.max(0, w.sampleSupport ?? 0.2);
    const total = conf + rate + sup;
    // 全零权重会让归一化除零得 NaN（NaN 综合分与阈值比较恒 false → 永走回退
    // 且账面数值不可读）——回退缺省权重组
    this.recallRouting = {
      weights:
        total > 0
          ? { confidence: conf / total, successRate: rate / total, sampleSupport: sup / total }
          : { confidence: 0.5, successRate: 0.3, sampleSupport: 0.2 },
      halfLifeDays: options?.halfLifeDays ?? 30,
      now: options?.now ?? (() => Date.now()),
    };
  }

  /** A6 升级 1：置信路由配置（未挂载零介入） */
  private recallRouting?: {
    weights: { confidence: number; successRate: number; sampleSupport: number };
    halfLifeDays: number;
    now: () => number;
  };

  /** A6 升级 1：路由决策环形账本（缺省容量 64） */
  private recallRouteLog: RecallRouteRecord[] = [];

  /**
   * A6 升级 1：经验快路径置信评分（未挂载 / 无模式时 undefined）。
   *
   * 纯函数式读数——同 pattern 同时刻评分确定，供验证脚本与编排层
   * 在决策前预览路由走向。评分不写账（recallPlan 决策时才落账）。
   */
  recallConfidenceOf(pattern: TaskPatternMemory | undefined): RecallRouteRecord | undefined {
    if (!this.recallRouting || !pattern) return undefined;
    const now = this.recallRouting.now();
    return this.scorePattern(pattern, now, this.config.memoryFastPathThreshold ?? 0.9);
  }

  /** A6 升级 1：最近的路由决策账单（新→旧；未挂载恒空） */
  recentRecallRoutes(limit = 16): RecallRouteRecord[] {
    // limit ≤ 0 时 slice(-0) 会返回全量账本——按「取 0 条」语义诚实返回空
    return limit <= 0 ? [] : this.recallRouteLog.slice(-limit).reverse();
  }

  /** A6 升级 1：路由决策统计（hit/fallback 计数与最近理由） */
  recallRouteStats(): { total: number; hits: number; fallbacks: number } {
    const hits = this.recallRouteLog.filter((r) => r.route === 'hit').length;
    return { total: this.recallRouteLog.length, hits, fallbacks: this.recallRouteLog.length - hits };
  }

  /** A6 升级 1：字段加权 + 时效衰减的置信评分（私有：纯计算，不落账） */
  private scorePattern(pattern: TaskPatternMemory, now: number, threshold: number): RecallRouteRecord {
    const routing = this.recallRouting!;
    const { weights } = routing;
    const successes = pattern.successfulPlans.length;
    const failures = pattern.failureRecords.length;
    const totalRuns = successes + failures;
    const successRate = totalRuns > 0 ? successes / totalRuns : 0;
    const saturation = Math.max(1, this.config.recallSupportSaturation ?? 8);
    const sampleSupport = Math.min(1, pattern.frequency / saturation);
    const weightedBase =
      weights.confidence * pattern.confidence + weights.successRate * successRate + weights.sampleSupport * sampleSupport;
    const ageMs = Math.max(0, now - (pattern.lastSeenAt ?? pattern.firstSeenAt ?? now));
    const freshness = decayFactor(ageMs, routing.halfLifeDays);
    const composite = weightedBase * freshness;
    const route: RecallRouteRecord['route'] = composite >= threshold ? 'hit' : 'fallback';
    return {
      at: now,
      weightedBase: Number(weightedBase.toFixed(6)),
      successRate: Number(successRate.toFixed(6)),
      sampleSupport: Number(sampleSupport.toFixed(6)),
      freshness: Number(freshness.toFixed(6)),
      composite: Number(composite.toFixed(6)),
      threshold,
      ageDays: Number((ageMs / 86_400_000).toFixed(6)),
      route,
      reason: route === 'hit' ? 'above-threshold' : 'below-confidence',
    };
  }

  /**
   * 第三轮 A6 升级 2：挂载推荐理由分解（幂等覆盖，挂载即生效）。
   *
   * lookupExperience 的输出从「推荐谁 + 一句话 rationale」升级为附带
   * **推荐 + 备选的历史三维记分卡**（质量 / 成本 / 速度，全部来自记忆库
   * 亲测统计）：推荐为什么是它（三维综合）、备选各自在哪个维度更优
   * （如备选更快但质量略低）——调度层与可观测性第一次能看见推荐的
   * 「价格标签」。未挂载零漂移（recommendation 字段省略）。
   *
   * @param options.weights 三维综合权重（备选排序用；缺省 0.5/0.25/0.25）
   * @param options.refLatencyMs 速度维参考时延（avgLatency = 该值时速度分 0.5；缺省 5000ms）
   */
  attachRecommendationDecomposition(options?: {
    weights?: { quality?: number; cost?: number; speed?: number };
    refLatencyMs?: number;
  }): void {
    const w = options?.weights ?? {};
    const q = Math.max(0, w.quality ?? 0.5);
    const c = Math.max(0, w.cost ?? 0.25);
    const s = Math.max(0, w.speed ?? 0.25);
    const total = q + c + s;
    // 全零权重回退缺省权重组（防归一化除零 → NaN 排序）；参考时延钳 ≥1ms
    //（0 会使 avgLatency/0 出 Infinity/NaN 污染速度维）
    this.recommendationDecomposition = {
      weights:
        total > 0
          ? { quality: q / total, cost: c / total, speed: s / total }
          : { quality: 0.5, cost: 0.25, speed: 0.25 },
      refLatencyMs: Math.max(1, options?.refLatencyMs ?? 5_000),
    };
  }

  /** A6 升级 2：推荐理由分解配置（未挂载零介入） */
  private recommendationDecomposition?: {
    weights: { quality: number; cost: number; speed: number };
    refLatencyMs: number;
  };

  /**
   * A6 升级 2：三维记分卡计算（私有）。
   *
   * - 质量维 = 期望交付质量 = 质量水平（成功质量 EMA，缺省裸均值）
   *   × 成功概率（贝叶斯后验均值，记忆库不支持时回退裸成功率）——
   *   「大概率成功且成功时质量高」才叫质量高，单一分量都有盲区
   * - 成本维 = costEfficiency（质量/千 token 的 EMA，越高越省）
   * - 速度维 = 1/(1 + avgLatency/refLatency)（时延倒数映射）
   * 样本为 0 的模型不参与分解（没有亲测数据就没有理由——诚实优先于覆盖度）。
   */
  private buildRecommendationBreakdown(
    taskType: string,
    primaryModelId: string | undefined,
    avoidModels: string[],
  ): RecommendationBreakdown | undefined {
    if (!this.recommendationDecomposition) return undefined;
    const { weights, refLatencyMs } = this.recommendationDecomposition;
    const scored: ModelDimensionScore[] = [];
    for (const profile of this.memory.getAllModelProfiles()) {
      const stats = profile.taskHistory[taskType];
      if (!stats || stats.totalCalls <= 0) continue;
      const estimate = this.memory.getBayesianEstimate?.(profile.id, taskType);
      const qualityLevel = stats.emaQuality ?? stats.avgQualityScore;
      const reliability = estimate
        ? estimate.posteriorMean
        : stats.successCount / stats.totalCalls;
      // 时延均值防 NaN/Infinity 污染速度维（脏统计回退参考时延 → 速度 0.5）
      const rawLatency = stats.totalLatency / stats.totalCalls;
      const avgLatency = Number.isFinite(rawLatency) ? rawLatency : refLatencyMs;
      scored.push({
        modelId: profile.id,
        quality: Number(Math.max(0, Math.min(1, qualityLevel * reliability)).toFixed(6)),
        cost: Number(Math.max(0, Math.min(1, profile.costEfficiency[taskType] ?? 0)).toFixed(6)),
        speed: Number((1 / (1 + avgLatency / refLatencyMs)).toFixed(6)),
        samples: estimate?.effectiveSamples ?? stats.totalCalls,
      });
    }
    if (scored.length === 0) return undefined;

    const compositeOf = (s: ModelDimensionScore): number =>
      weights.quality * s.quality + weights.cost * s.cost + weights.speed * s.speed;
    const ranked = [...scored].sort((a, b) => compositeOf(b) - compositeOf(a));
    const primary =
      (primaryModelId ? scored.find((s) => s.modelId === primaryModelId) : undefined) ?? (primaryModelId ? undefined : ranked[0]);
    const alternatives = ranked.filter((s) => s.modelId !== primary?.modelId && !avoidModels.includes(s.modelId));

    // 三维理由：主推荐的综合分构成 + 备选各自的差异化卖点
    const fmt = (v: number): string => v.toFixed(2);
    let rationale: string;
    if (primary) {
      rationale = `推荐 ${primary.modelId}：质量 ${fmt(primary.quality)}（${primary.samples} 样本）/ 成本效率 ${fmt(primary.cost)} / 速度 ${fmt(primary.speed)}，三维综合 ${fmt(compositeOf(primary))}`;
    } else {
      rationale = `无历史推荐（首次任务），历史最优备选 ${ranked[0]!.modelId}：三维综合 ${fmt(compositeOf(ranked[0]!))}`;
    }
    if (alternatives.length > 0) {
      const altNotes = alternatives.slice(0, 3).map((a) => {
        const dims: string[] = [];
        if (primary && a.quality > primary.quality) dims.push('质量更优');
        if (primary && a.cost > primary.cost) dims.push('更省成本');
        if (primary && a.speed > primary.speed) dims.push('更快');
        return `${a.modelId}（${dims.length > 0 ? dims.join('、') : `综合 ${fmt(compositeOf(a))}`}）`;
      });
      rationale += `；备选：${altNotes.join('、')}`;
    }
    return { taskType, primary, alternatives, rationale };
  }

  // ───────────────────── 第四轮模块域升级 R4-A6：经验迁移推荐 + 置信传播 + 计划模板 ─────────────────────

  /**
   * R4-A6 升级 1：挂载经验迁移推荐（幂等覆盖，挂载即生效）。
   *
   * lookupExperience 无直接命中（memoryLayer='none'）时，跨任务类型检索
   * 「结构相似」的异类经验并标注可迁移置信——B 类任务第一次执行也能
   * 借到 A 类亲测过的成功经验，而不是空手走冷启动：
   *
   *   transferConfidence = similarity × (来源成功率 × 来源置信度) × 借用传播权重
   *
   * - similarity：任务特征向量距离（注入 featureVectorOf → 余弦相似度；
   *   缺省回退特征 Jaccard × 0.7 + 复杂度贴近 × 0.3——确定性无嵌入依赖）
   * - 三重门槛：similarity / sourceStrength / transferConfidence 各自独立
   *   把关，被拒对结构化落账（rejected.reason 可审计——不可迁移就是不可迁移）
   * - 未挂载零漂移：lookupExperience 照旧返回 memoryLayer='none' 的空推荐
   *
   * @param options.featureVectorOf 任务类型 → 特征向量提供器（跨类型结构相似
   *        的向量口径；缺失或长度不齐时回退 Jaccard 结构路径）
   * @param options.minSimilarity 结构相似门槛（缺省 0.4，与记忆库模糊匹配门槛一致）
   * @param options.minSourceStrength 来源经验质量门槛（缺省 0.5）
   * @param options.minTransferConfidence 可迁移置信门槛（缺省 0.35）
   */
  attachTransferRecommendation(options?: {
    featureVectorOf?: (taskType: string) => number[] | undefined;
    featureWeight?: number;
    minSimilarity?: number;
    minSourceStrength?: number;
    minTransferConfidence?: number;
  }): void {
    this.transferRouting = {
      featureVectorOf: options?.featureVectorOf,
      featureWeight: Math.min(1, Math.max(0, options?.featureWeight ?? 0.7)),
      minSimilarity: Math.min(1, Math.max(0, options?.minSimilarity ?? 0.4)),
      minSourceStrength: Math.min(1, Math.max(0, options?.minSourceStrength ?? 0.5)),
      minTransferConfidence: Math.min(1, Math.max(0, options?.minTransferConfidence ?? 0.35)),
    };
  }

  /** R4-A6 升级 1：迁移推荐配置（未挂载零介入） */
  private transferRouting?: {
    featureVectorOf?: (taskType: string) => number[] | undefined;
    featureWeight: number;
    minSimilarity: number;
    minSourceStrength: number;
    minTransferConfidence: number;
  };

  /**
   * R4-A6 升级 1：跨任务经验迁移推荐（未挂载返回 undefined）。
   *
   * 遍历记忆库全部异类模式（同类型属直接命中域），对每个有成功记录的来源
   * 计算结构相似度 × 来源质量 × 传播权重，三重门槛过滤——通过者按可迁移
   * 置信降序作为借用候选，被拒者带拒因落账。来源的最优模型组合映射为
   * 「按节点类型」的借用推荐（与 lookupExperience 同一口径）。
   *
   * @param limit 候选上限（缺省 3）
   */
  recommendTransfer(taskType: string, complexity: number, features: string[] = [], limit = 3): TransferRecommendation | undefined {
    if (!this.transferRouting) return undefined;
    const routing = this.transferRouting;
    const candidates: TransferCandidate[] = [];
    const rejected: TransferRejection[] = [];

    for (const pattern of this.memory.getAllTaskPatterns()) {
      const sourceTaskType = pattern.fingerprint.split('::')[0] ?? '';
      if (!sourceTaskType || sourceTaskType === taskType) continue; // 异类借用才算迁移
      if (pattern.successfulPlans.length === 0) continue; // 无成功记录 = 无可借之物

      const similarity = this.structuralSimilarity(taskType, complexity, features, pattern, sourceTaskType);
      const propagation = this.propagationLedger?.entries.get(pattern.fingerprint);
      const successes = pattern.successfulPlans.length;
      const failures = pattern.failureRecords.length;
      const successRate = successes + failures > 0 ? successes / (successes + failures) : 0;
      const effectiveConfidence = propagation ? propagation.effectiveConfidence : pattern.confidence;
      const propagationWeight = propagation ? propagation.weight : 1;
      const sourceStrength = Math.max(0, Math.min(1, successRate * effectiveConfidence));
      const transferConfidence = similarity * sourceStrength * propagationWeight;

      // 三重门槛（顺序固定——先结构后证据后综合，拒因可审计）
      if (similarity < routing.minSimilarity) {
        rejected.push({ sourceTaskType, similarity: round6(similarity), transferConfidence: round6(transferConfidence), reason: 'below-similarity' });
        continue;
      }
      if (sourceStrength < routing.minSourceStrength) {
        rejected.push({ sourceTaskType, similarity: round6(similarity), transferConfidence: round6(transferConfidence), reason: 'weak-source' });
        continue;
      }
      if (transferConfidence < routing.minTransferConfidence) {
        rejected.push({ sourceTaskType, similarity: round6(similarity), transferConfidence: round6(transferConfidence), reason: 'below-threshold' });
        continue;
      }

      const borrowedModels = this.bestModelsOfPattern(pattern);
      candidates.push({
        sourceTaskType,
        sourceFingerprint: pattern.fingerprint,
        similarity: round6(similarity),
        sourceStrength: round6(sourceStrength),
        transferConfidence: round6(transferConfidence),
        borrowedModels,
        rationale: `${taskType} 无直接经验，可借用结构相似的 ${sourceTaskType} 亲测经验（相似度 ${similarity.toFixed(2)} × 来源质量 ${sourceStrength.toFixed(2)}${propagationWeight < 1 ? ` × 传播权重 ${propagationWeight.toFixed(2)}（该经验有失败借出史）` : ''} → 可迁移置信 ${transferConfidence.toFixed(2)}）`,
      });
    }

    candidates.sort((a, b) => b.transferConfidence - a.transferConfidence || (a.sourceTaskType < b.sourceTaskType ? -1 : 1));
    const top = candidates.slice(0, Math.max(1, limit));
    return { taskType, best: top[0], candidates: top, rejected };
  }

  /**
   * R4-A6 升级 1：结构相似度（任务特征向量距离）。
   *
   * 向量口径优先（featureVectorOf 注入且两类型向量同长）：非负特征向量的
   * 余弦相似度；否则回退结构路径——特征 Jaccard × featureWeight +
   * 复杂度贴近度 ×(1−featureWeight)。两条路径均确定性、无随机源。
   */
  private structuralSimilarity(
    targetTaskType: string,
    complexity: number,
    features: string[],
    pattern: TaskPatternMemory,
    sourceTaskType: string,
  ): number {
    const routing = this.transferRouting!;
    const vectorOf = routing.featureVectorOf;
    if (vectorOf) {
      const vq = vectorOf(targetTaskType);
      const vs = vectorOf(sourceTaskType);
      if (vq && vs && vq.length > 0 && vq.length === vs.length) {
        let dot = 0;
        let na = 0;
        let nb = 0;
        for (let i = 0; i < vq.length; i += 1) {
          dot += vq[i]! * vs[i]!;
          na += vq[i]! * vq[i]!;
          nb += vs[i]! * vs[i]!;
        }
        if (na > 0 && nb > 0) return Math.max(0, Math.min(1, dot / Math.sqrt(na * nb)));
      }
      // 向量缺失/长度不齐 → 回退结构路径（诚实降级，不臆造相似度）
    }
    const patternFeatures = (pattern.fingerprint.split('::')[2] ?? '').split(',').filter(Boolean);
    // 指纹复杂度段缺失/畸形时 Number 会得 NaN 并沿相似度传播（NaN 比较恒 false
    // 会绕过全部迁移门槛）——回退 0.5 中性复杂度，诚实降级
    const parsedComplexity = Number(pattern.fingerprint.split('::')[1] ?? 0.5);
    const patternComplexity = Number.isFinite(parsedComplexity) ? parsedComplexity : 0.5;
    const union = new Set([...features, ...patternFeatures]);
    const inter = new Set(features).size + patternFeatures.length - union.size;
    const featureSim = union.size > 0 ? inter / union.size : 0;
    const complexityCloseness = Math.max(0, 1 - Math.abs(patternComplexity - complexity));
    return Math.max(0, Math.min(1, routing.featureWeight * featureSim + (1 - routing.featureWeight) * complexityCloseness));
  }

  /** R4-A6 升级 1：来源模式的最优模型组合 → 按节点类型映射（与 lookupExperience 同口径） */
  private bestModelsOfPattern(pattern: TaskPatternMemory): Record<string, string> {
    const result: Record<string, string> = {};
    const nodeTypeById = new Map<string, string>();
    const bestPlan = pattern.successfulPlans[pattern.successfulPlans.length - 1];
    for (const node of bestPlan?.plan.nodes ?? []) nodeTypeById.set(node.id, node.type);
    for (const [nodeId, modelId] of Object.entries(pattern.bestModelCombination ?? {})) {
      const nodeType = nodeTypeById.get(nodeId);
      if (nodeType) result[nodeType] = modelId;
    }
    if (Object.keys(result).length === 0 && bestPlan) {
      // 无 bestModelCombination 时回退最近成功计划的分配映射
      for (const [nodeId, modelId] of Object.entries(bestPlan.modelAssignments)) {
        const nodeType = nodeTypeById.get(nodeId);
        if (nodeType) result[nodeType] = modelId;
      }
    }
    return result;
  }

  // ── R4-A6 升级 4：经验置信度传播（借还流） ──

  /**
   * R4-A6 升级 4：挂载经验置信传播账本（幂等覆盖，挂载即生效）。
   *
   * 经验条目的置信随借用结果传播——被借用成功 → 有效置信上调（×(1+gain)，
   * 封顶 ceiling）、更愿意被再次借出；借用失败 → 下调（×(1−penalty)，托底
   * floor）并降权（×weightDecay，托底 minWeight）——推荐排序同步折价。
   * 借用对（from→to）另计 Wilson 下界学习分（借用史 ≥ minPairTrials 才
   * 采信——与全层证据同一统计语言）。
   *
   * 全部状态为本模块本地账（不写记忆库——优化器只读边界不破）。
   * 未挂载零漂移：迁移推荐的来源质量按裸 pattern.confidence 计。
   *
   * @param options.successGain 单次借出成功的置信增益（缺省 0.05）
   * @param options.failurePenalty 单次借出失败的置信惩罚（缺省 0.15——惩罚重于奖励，坏经验淘汰快）
   * @param options.floor / ceiling 有效置信界（缺省 0.3 / 0.98）
   * @param options.weightDecay 单次借出失败的权重乘子（缺省 0.9）
   * @param options.minWeight 权重下界（缺省 0.2）
   * @param options.minPairTrials 借用对学习门槛（缺省 3）
   * @param options.clock 注入时钟（确定性验证用；缺省 Date.now）
   */
  attachExperiencePropagation(options?: {
    successGain?: number;
    failurePenalty?: number;
    floor?: number;
    ceiling?: number;
    weightDecay?: number;
    minWeight?: number;
    minPairTrials?: number;
    clock?: () => number;
  }): void {
    this.propagationLedger = {
      successGain: Math.min(1, Math.max(0, options?.successGain ?? 0.05)),
      failurePenalty: Math.min(1, Math.max(0, options?.failurePenalty ?? 0.15)),
      floor: Math.min(0.99, Math.max(0, options?.floor ?? 0.3)),
      ceiling: Math.min(1, Math.max(0.01, options?.ceiling ?? 0.98)),
      weightDecay: Math.min(1, Math.max(0.5, options?.weightDecay ?? 0.9)),
      minWeight: Math.min(1, Math.max(0, options?.minWeight ?? 0.2)),
      minPairTrials: Math.max(1, options?.minPairTrials ?? 3),
      clock: options?.clock ?? (() => Date.now()),
      entries: new Map(),
      pairs: new Map(),
    };
  }

  /** R4-A6 升级 4：置信传播账本（未挂载零介入） */
  private propagationLedger?: {
    successGain: number;
    failurePenalty: number;
    floor: number;
    ceiling: number;
    weightDecay: number;
    minWeight: number;
    minPairTrials: number;
    clock: () => number;
    entries: Map<string, PropagationEntry>;
    pairs: Map<string, BorrowPairStats>;
  };

  /**
   * R4-A6 升级 4：结算一次借用（借还流的「还」端）。
   *
   * @param params.sourceFingerprint 被借用的来源模式指纹
   * @param params.fromTaskType 来源任务类型 / params.toTaskType 借用方任务类型
   * @param params.success 借用后该次任务是否成功
   * @param params.sourceConfidence 来源基准置信（缺省查记忆库现值，再缺省 0.7）
   * @returns 更新后的传播条目（未挂载 undefined）
   */
  settleBorrowedExperience(params: {
    sourceFingerprint: string;
    fromTaskType: string;
    toTaskType: string;
    success: boolean;
    sourceConfidence?: number;
  }): PropagationEntry | undefined {
    const ledger = this.propagationLedger;
    if (!ledger) return undefined;
    const now = ledger.clock();

    // ── 条目传播：置信上调 / 下调 + 降权（全有界） ──
    let entry = ledger.entries.get(params.sourceFingerprint);
    if (!entry) {
      const memoryConfidence = this.memory.getAllTaskPatterns().find((p) => p.fingerprint === params.sourceFingerprint)?.confidence;
      entry = {
        fingerprint: params.sourceFingerprint,
        sourceTaskType: params.fromTaskType,
        baseConfidence: params.sourceConfidence ?? memoryConfidence ?? 0.7,
        borrowSuccesses: 0,
        borrowFailures: 0,
        effectiveConfidence: params.sourceConfidence ?? memoryConfidence ?? 0.7,
        weight: 1,
        lastSettledAt: now,
      };
      ledger.entries.set(params.sourceFingerprint, entry);
    }
    if (params.success) {
      entry.borrowSuccesses += 1;
      entry.effectiveConfidence = Math.min(ledger.ceiling, entry.effectiveConfidence * (1 + ledger.successGain));
    } else {
      entry.borrowFailures += 1;
      entry.effectiveConfidence = Math.max(ledger.floor, entry.effectiveConfidence * (1 - ledger.failurePenalty));
      entry.weight = Math.max(ledger.minWeight, entry.weight * ledger.weightDecay);
    }
    entry.lastSettledAt = now;

    // ── 借用对统计：Wilson 下界学习分（方向性 A→B） ──
    const pairKey = `${params.fromTaskType}→${params.toTaskType}`;
    let pair = ledger.pairs.get(pairKey);
    if (!pair) {
      pair = { from: params.fromTaskType, to: params.toTaskType, trials: 0, successes: 0, wilsonLower: 0, learned: false };
      ledger.pairs.set(pairKey, pair);
    }
    pair.trials += 1;
    if (params.success) pair.successes += 1;
    pair.learned = pair.trials >= ledger.minPairTrials;
    pair.wilsonLower = pair.learned ? wilsonLowerBound(pair.successes, pair.trials - pair.successes) : 0;

    return { ...entry, effectiveConfidence: round6(entry.effectiveConfidence), weight: round6(entry.weight) };
  }

  /** R4-A6 升级 4：传播账本视图（条目按最近结算新→旧；未挂载 undefined） */
  propagationView(): { entries: PropagationEntry[]; pairs: BorrowPairStats[] } | undefined {
    const ledger = this.propagationLedger;
    if (!ledger) return undefined;
    return {
      entries: [...ledger.entries.values()]
        .sort((a, b) => b.lastSettledAt - a.lastSettledAt)
        .map((e) => ({ ...e, effectiveConfidence: round6(e.effectiveConfidence), weight: round6(e.weight) })),
      pairs: [...ledger.pairs.values()]
        .sort((a, b) => b.trials - a.trials || (a.to < b.to ? -1 : 1))
        .map((p) => ({ ...p, wilsonLower: round6(p.wilsonLower) })),
    };
  }

  // ── R4-A6 升级 5（加分）：计划模板抽象 ──

  /**
   * R4-A6 升级 5：挂载计划模板库（幂等覆盖，挂载即生效）。
   *
   * 成功计划的泛化模板提取与复用：noteSuccessfulPlan 把高质量成功计划
   * 参数化（数字字面量→槽位，同值复用同槽；node id→模板内下标——跨计划
   * 无关），suggestTemplate 按数字掩码后的 token 重叠匹配目标，
   * instantiatePlan 实例化回填（目标文本中的数字按出现序自动绑定同序槽）。
   * 模板库为本模块本地态（不写记忆库——优化器只读边界不破）。
   * 未挂载零漂移。
   *
   * @param options.qualityThreshold 提取的质量门槛（缺省 0.8——只有成功且优的计划值得泛化）
   * @param options.maxTemplates 模板容量（缺省 32；满时淘汰复用最少且质量最低者）
   * @param options.clock 注入时钟（确定性验证用）
   */
  attachPlanTemplates(options?: { qualityThreshold?: number; maxTemplates?: number; clock?: () => number }): void {
    this.planTemplateStore = {
      qualityThreshold: Math.min(1, Math.max(0, options?.qualityThreshold ?? 0.8)),
      maxTemplates: Math.max(4, options?.maxTemplates ?? 32),
      clock: options?.clock ?? (() => Date.now()),
      templates: new Map(),
    };
  }

  /** R4-A6 升级 5：模板库状态（未挂载零介入） */
  private planTemplateStore?: {
    qualityThreshold: number;
    maxTemplates: number;
    clock: () => number;
    templates: Map<string, PlanTemplate>;
  };

  /**
   * R4-A6 升级 5：从成功计划提取泛化模板（未挂载 / 质量不达标返回 undefined）。
   *
   * 同构计划（节点类型序列 + 依赖形态 + 槽位化描述一致）合并计数
   * （extractions++、质量滚动均值），不重复开条。返回提取（或合并）的模板。
   */
  noteSuccessfulPlan(
    plan: { objective: string; nodes: Array<{ id: string; description: string; type: string; dependsOn: string[] }> },
    avgQuality: number,
  ): PlanTemplate | undefined {
    const store = this.planTemplateStore;
    if (!store || plan.nodes.length === 0 || avgQuality < store.qualityThreshold) return undefined;
    const now = store.clock();

    // 槽位化：数字字面量 → {slot-N}（同值复用同槽——目标与节点中的同一数值联动）
    const slots = new Map<string, { name: string; example: string }>();
    const slotify = (text: string): string =>
      text.replace(/\d+(?:\.\d+)?/g, (m) => {
        let slot = slots.get(m);
        if (!slot) {
          slot = { name: `slot-${slots.size}`, example: m };
          slots.set(m, slot);
        }
        return `{${slot.name}}`;
      });

    const indexOfId = new Map(plan.nodes.map((n, i) => [n.id, i] as const));
    const templateNodes = plan.nodes.map((n) => ({
      slotDescription: slotify(n.description),
      type: n.type,
      dependsOnIdx: n.dependsOn.map((dep) => indexOfId.get(dep) ?? -1).filter((i) => i >= 0),
    }));
    const objectiveTemplate = slotify(plan.objective);
    const signature = stableTemplateSignature(
      plan.nodes.map((n) => n.type),
      templateNodes.map((n) => `${n.slotDescription}@${n.dependsOnIdx.join(',')}`),
      objectiveTemplate,
    );
    const id = `tpl-${signature}`;

    const existing = store.templates.get(id);
    if (existing) {
      // 同构合并：质量滚动均值 + 提取计数（证据增强，不重复开条）
      existing.extractions += 1;
      existing.avgQuality = (existing.avgQuality * (existing.extractions - 1) + avgQuality) / existing.extractions;
      return { ...existing };
    }

    const template: PlanTemplate = {
      id,
      signature,
      objectiveTemplate,
      nodes: templateNodes,
      slots: [...slots.values()],
      usage: 0,
      extractions: 1,
      avgQuality,
      extractedFrom: plan.objective,
      createdAt: now,
    };
    store.templates.set(id, template);
    // 容量淘汰：满时剔除 (usage, avgQuality) 字典序最低者（最少复用且质量最低）
    if (store.templates.size > store.maxTemplates) {
      let victimId = id;
      let victimUsage = template.usage;
      let victimQuality = template.avgQuality;
      for (const [tid, t] of store.templates) {
        // 数值序比较（usage 为非负整数——字符串字典序在 "2" vs "10" 上会误序）
        if (t.usage < victimUsage || (t.usage === victimUsage && t.avgQuality < victimQuality)) {
          victimUsage = t.usage;
          victimQuality = t.avgQuality;
          victimId = tid;
        }
      }
      store.templates.delete(victimId);
    }
    return { ...template };
  }

  /** R4-A6 升级 5：模板库视图（按 avgQuality 降序；未挂载 undefined） */
  planTemplates(): PlanTemplate[] | undefined {
    const store = this.planTemplateStore;
    if (!store) return undefined;
    return [...store.templates.values()]
      .sort((a, b) => b.avgQuality - a.avgQuality || (a.id < b.id ? -1 : 1))
      .map((t) => ({ ...t }));
  }

  /**
   * R4-A6 升级 5：目标 → 最佳模板匹配（数字掩码后的 token Jaccard 重叠；
   * 未挂载 / 无过线模板返回 undefined）。参数差异不罚分——「翻译 8000 字」
   * 与「翻译 5000 字」在掩码后完全同构。
   */
  suggestTemplate(objective: string, threshold = 0.6): TemplateMatch | undefined {
    const store = this.planTemplateStore;
    if (!store) return undefined;
    const targetTokens = maskedTokens(objective);
    let best: { template: PlanTemplate; score: number } | undefined;
    for (const template of store.templates.values()) {
      // 槽位占位符 {slot-N} 先归一为掩码符：否则 token 化会拆出字面量「slot」，
      // 任何真实目标都不含该 token，完美同构也只能得 <1（并集被污染）
      const templateTokens = maskedTokens(template.objectiveTemplate.replace(/\{slot-\d+\}/g, '␦'));
      const union = new Set([...targetTokens, ...templateTokens]);
      // 交集按去重口径计数（目标 token 重复出现不得放大分子——保证 Jaccard ≤ 1）
      const inter = new Set(targetTokens.filter((t) => templateTokens.includes(t))).size;
      const score = union.size > 0 ? inter / union.size : 0;
      if (score >= threshold && (!best || score > best.score || (score === best.score && template.id < best.template.id))) {
        best = { template, score };
      }
    }
    return best ? { template: { ...best.template }, score: round6(best.score) } : undefined;
  }

  /**
   * R4-A6 升级 5：模板实例化（复用落地点；未挂载 / 模板不存在返回 undefined）。
   *
   * 槽位绑定序：① 目标文本中的数字按出现序绑定到 objectiveTemplate 中
   * 同序出现的槽位（自动绑定——两次相似任务的参数自动对位）；② 显式
   * slotValues 覆盖自动绑定；③ 未绑定槽位回填提取时的样例值。
   * 产出 ExecutionPlan（source='memory'——模板与经验复用同源）。
   */
  instantiatePlan(
    templateId: string,
    objective: string,
    slotValues: Record<string, string | number> = {},
  ): { plan: ExecutionPlan; template: PlanTemplate; boundSlots: Record<string, string> } | undefined {
    const store = this.planTemplateStore;
    if (!store) return undefined;
    const template = store.templates.get(templateId);
    if (!template) return undefined;
    const now = store.clock();

    // 自动绑定：objectiveTemplate 中槽位出现序 ↔ 目标文本数字出现序
    const bound: Record<string, string> = {};
    const slotOrder = [...template.objectiveTemplate.matchAll(/\{(slot-\d+)\}/g)].map((m) => m[1]!);
    const targetNumbers = objective.match(/\d+(?:\.\d+)?/g) ?? [];
    slotOrder.forEach((name, i) => {
      if (targetNumbers[i] !== undefined) bound[name] = targetNumbers[i]!;
    });
    for (const [k, v] of Object.entries(slotValues)) bound[k] = String(v);
    const fill = (text: string): string =>
      text.replace(/\{(slot-\d+)\}/g, (_m, name: string) => bound[name] ?? template.slots.find((s) => s.name === name)?.example ?? '');

    const prefix = template.id.slice(-6);
    const nodes: PlanNode[] = template.nodes.map((n, i) => ({
      id: `t-${prefix}-${i}`,
      description: fill(n.slotDescription),
      type: n.type,
      dependsOn: n.dependsOnIdx.map((d) => `t-${prefix}-${d}`),
    }));

    template.usage += 1;
    template.lastUsedAt = now;
    return {
      plan: { objective: fill(template.objectiveTemplate), nodes, parallelismStrategy: 'layered', source: 'memory' },
      template: { ...template },
      boundSlots: bound,
    };
  }

  /** 运行时配置热更新（元认知自调优落地入口） */
  updateConfig(patch: Partial<OptimizerConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /** 当前配置快照（第四阶段：元认知旋钮 read 端；只读） */
  getConfig(): Readonly<OptimizerConfig> {
    return { ...this.config };
  }

  /** 当前策略版本标识（policyId@vN；未注入提供器时为 baseline） */
  private currentPolicyVersion(): string {
    const policy = this.policyProvider?.();
    return policy ? `${policy.id}@v${policy.version}` : 'policy-baseline@v1';
  }

  /**
   * 经验检索 — 三层记忆优先级匹配并给出推荐模型组合
   *
   * 第二阶段三层记忆级联（procedural > semantic > episodic > none）：
   * 1. 程序记忆（findProceduralMemory）：按 kind='scheduling' + 条件合取匹配。
   *    命中时从 action 提取 prefer-model 写入 recommendedModels，并返回 suggestedActions
   *    供执行器消费（如 enable-cot / avoid-model / parallelism）。
   * 2. 语义记忆（findSemanticMemory）：跨任务规律匹配。命中时从 conclusion 提取
   *    model-preference 写入 recommendedModels。
   * 3. 情景记忆（findPattern）：既有模糊匹配，回退路径。
   * 4. 全无命中：memoryLayer='none'，返回空推荐（首次任务）。
   *
   * 三层均会查询（不只取首层），但 memoryLayer 标记命中的最高层级，
   * rationale 说明决策依据。程序/语义记忆未命中时仍会回退到情景记忆，
   * 保证既有"模型推荐组合"链路不被破坏。
   *
   * @param taskType 任务类型
   * @param complexity 复杂度 0~1
   * @param features 任务特征标签
   * @param context 程序/语义记忆条件匹配所需的额外上下文（长度 / token 成本）
   */
  lookupExperience(
    taskType: string,
    complexity: number,
    features: string[] = [],
    context: { length?: number; tokenCost?: number } = {},
  ): ExperienceLookup {
    // ── 三层记忆匹配上下文（features / complexity / length / tokenCost） ──
    const matchContext = {
      features,
      complexity,
      length: context.length,
      tokenCost: context.tokenCost,
    };

    // ── 第 1 层：程序记忆（最高优先级，if-then 可执行规则） ──
    // 第二阶段升级：从"单条最优"扩展为"多条条件匹配"——同一任务可能同时命中
    // prefer-model / enable-cot / avoid-model 多条规则，全部聚合消费，
    // 而非只取置信度最高的一条（该条若是 avoid-model 会丢失其余正向偏好）。
    // 条件求值复用记忆库导出的 matchesMemoryConditions，保证两端语义一致。
    const proceduralMatches = this.memory
      .getProceduralMemories(taskType, 'scheduling')
      .filter((p) => matchesMemoryConditions(p.conditions, taskType, matchContext));
    const procedural = proceduralMatches[0];
    // ── 第 2 层：语义记忆（跨任务规律） ──
    const semantic = this.memory.findSemanticMemory(taskType, matchContext);
    // ── 第 3 层：情景记忆（既有模糊匹配） ──
    const pattern = this.memory.findPattern(taskType, complexity, features);

    // bestModelCombination 以 nodeId 为键，但 nodeId 跨计划不复用 →
    // 借助存储计划把 nodeId 映射回节点类型，产出"按节点类型"的推荐组合，
    // 供模型调度在 assignModel 时作为 preferred 真正消费（越用越聪明）。
    const recommendedModels: Record<string, string> = {};

    // 程序记忆动作聚合：prefer-model → 推荐；avoid-model → 负向约束；其余 → suggestedActions
    const suggestedActions: ProceduralAction[] = [];
    const avoidModels: string[] = [];
    for (const proc of proceduralMatches) {
      suggestedActions.push(proc.action);
      if (proc.action.type === 'prefer-model') {
        const model = proc.action.params['model'];
        if (typeof model === 'string' && !recommendedModels[taskType]) {
          // 程序记忆的模型偏好按 taskType 键写入（节点类型无关的全局偏好，首条优先）
          recommendedModels[taskType] = model;
        }
      } else if (proc.action.type === 'avoid-model') {
        const model = proc.action.params['model'];
        if (typeof model === 'string' && !avoidModels.includes(model)) avoidModels.push(model);
      }
    }

    // 语义记忆 model-preference 结论 → 推荐模型组合（程序记忆未指定时采用）
    if (semantic && Object.keys(recommendedModels).length === 0 && semantic.conclusion.type === 'model-preference') {
      const model = semantic.conclusion.value;
      if (typeof model === 'string') {
        recommendedModels[taskType] = model;
      }
    }

    // 情景记忆 bestModelCombination → 按节点类型的推荐组合（仍是最丰富的来源）
    // 第二阶段升级：仅补充程序/语义记忆未覆盖的节点类型（高级记忆优先，不被回退层覆盖）
    if (pattern?.bestModelCombination) {
      const nodeTypeById = new Map<string, string>();
      const bestPlan = pattern.successfulPlans[pattern.successfulPlans.length - 1];
      for (const node of bestPlan?.plan.nodes ?? []) nodeTypeById.set(node.id, node.type);
      for (const [nodeId, modelId] of Object.entries(pattern.bestModelCombination)) {
        const nodeType = nodeTypeById.get(nodeId);
        if (nodeType && !recommendedModels[nodeType]) recommendedModels[nodeType] = modelId;
      }
      // 兜底：无法映射回类型时，保留原 nodeId 键（strategist 提示词仍可读）
      if (Object.keys(recommendedModels).length === 0) Object.assign(recommendedModels, pattern.bestModelCombination);
    }

    let historicalSuccessRate = 0;
    let avgExecutionTime = 0;
    if (pattern) {
      const successes = pattern.successfulPlans.length;
      const failures = pattern.failureRecords.length;
      historicalSuccessRate = successes + failures > 0 ? successes / (successes + failures) : 0;
      avgExecutionTime = pattern.avgExecutionTime;
    }

    // ── 确定命中的最高记忆层级与决策依据 ──
    const memoryLayer: MemoryLayer = procedural ? 'procedural' : semantic ? 'semantic' : pattern ? 'episodic' : 'none';
    const rationale = this.buildRationale(memoryLayer, proceduralMatches, avoidModels, semantic, pattern);

    // ── A6 升级 2：推荐理由分解（挂载后附带推荐+备选的三维记分卡；未挂载 undefined 省略） ──
    const recommendation = this.buildRecommendationBreakdown(
      taskType,
      recommendedModels[taskType],
      avoidModels,
    );

    // ── R4-A6 升级 1：经验迁移推荐（挂载且无直接命中时——冷启动第二落点；未挂载零漂移） ──
    const transfer = this.transferRouting && memoryLayer === 'none' ? this.recommendTransfer(taskType, complexity, features) : undefined;

    return {
      pattern,
      recommendedModels,
      historicalSuccessRate,
      avgExecutionTime,
      memoryLayer,
      rationale,
      matchedProceduralId: procedural?.id,
      matchedSemanticId: semantic?.id,
      suggestedActions: suggestedActions.length > 0 ? suggestedActions : undefined,
      avoidModels,
      matchedProceduralIds: proceduralMatches.length > 0 ? proceduralMatches.map((p) => p.id) : undefined,
      policyVersion: this.currentPolicyVersion(),
      ...(recommendation ? { recommendation } : {}),
      ...(transfer ? { transfer } : {}),
    };
  }

  /**
   * 任务分解决策（第三阶段：策略进化中「任务分解规则」的操作环落地）
   *
   * 按当前策略判定：分解启用且复杂度 ≥ 阈值时建议将任务拆分为子任务。
   * 编排层在兜底单节点计划时消费该建议（decomposePlan）。
   * 质级升级：传入 taskType/features 时按规则基因组解析上下文有效参数
   * （规则可对特定任务类型/复杂度段强制开/关分解）。
   * @param complexity 任务复杂度 0~1
   * @param taskType 任务类型（供规则基因匹配）
   * @param features 特征标签（供规则基因匹配）
   */
  shouldDecompose(complexity: number, taskType?: string, features?: string[]): boolean {
    const policy = this.policyProvider?.();
    if (!policy) return false;
    const params =
      taskType !== undefined
        ? resolveEffectiveParams(policy.params, { taskType, complexity, features })
        : policy.params;
    if (!params.decomposeEnabled) return false;
    return complexity >= params.decomposeComplexityThreshold;
  }

  /**
   * 构建决策依据说明（人类可读，供广播与可观测性）
   *
   * 第二阶段升级：程序记忆层说明全部命中规则数与正负向动作概览，
   * 让"使用了哪一层记忆、为什么"完全可追溯。
   */
  private buildRationale(
    layer: MemoryLayer,
    proceduralMatches: ProceduralMemory[],
    avoidModels: string[],
    semantic: SemanticMemory | undefined,
    pattern: TaskPatternMemory | undefined,
  ): string {
    switch (layer) {
      case 'procedural': {
        const parts = proceduralMatches.map((p) => `${p.name}（${p.action.type}，置信度 ${p.confidence.toFixed(2)}）`);
        const avoidNote = avoidModels.length > 0 ? `；规避模型：${avoidModels.join('/')}` : '';
        return `程序记忆命中 ${proceduralMatches.length} 条规则：${parts.join('；')}${avoidNote}`;
      }
      case 'semantic':
        return `语义记忆命中：${semantic!.statement}（置信度 ${semantic!.confidence.toFixed(2)}）`;
      case 'episodic':
        return `情景记忆命中：${pattern!.taskSummary}（置信度 ${pattern!.confidence.toFixed(2)}）`;
      case 'none':
      default:
        return '无记忆命中（首次任务，走常规规划）';
    }
  }

  /**
   * 经验快路径：命中高置信度模式时，直接复用历史最优成功计划，
   * 跳过 strategist LLM 重新规划——越用越快、越稳、越省 token。
   *
   * 复用条件（全部满足才返回计划，否则返回 undefined 走常规规划）：
   * 1. 模式置信度 ≥ memoryFastPathThreshold（缺省 0.9）
   * 2. 存在至少一条成功计划记录
   *
   * 选取策略：取平均质量最高的成功记录；其节点模型分配经 recommendedModels
   * （按节点类型）在执行时优先采用，保持"记忆驱动选型"的一致性。
   *
   * 第三轮 A6 升级 1（attachRecallConfidenceRouting 后生效，未挂载零漂移）：
   * 条件 1 升级为字段加权综合置信度（模式置信度 + 历史成功率 + 样本支撑度，
   * 再乘时效新鲜度半衰期衰减）。半匹配经验（置信度达标但成功率平庸 /
   * 样本稀少 / 记忆陈旧）综合分跌破阈值 → 回退 DAG 生成并落账路由决策
   * （recentRecallRoutes 可审计命中/回退两路由）。
   *
   * @param lookup 经验检索结果
   * @param objective 当前任务目标（写入计划）
   * @returns 复用的计划（source='memory'），不满足条件时 undefined
   */
  recallPlan(lookup: ExperienceLookup, objective: string): ExecutionPlan | undefined {
    const threshold = this.config.memoryFastPathThreshold ?? 0.9;
    const pattern = lookup.pattern;

    // ── A6 升级 1：置信路由（未挂载时走原判定——单一 confidence 比较，逐位等价） ──
    if (this.recallRouting) {
      const now = this.recallRouting.now();
      let record: RecallRouteRecord;
      if (!pattern) {
        record = this.blankRoute(now, threshold, 'no-pattern');
      } else if (pattern.successfulPlans.length === 0) {
        record = this.blankRoute(now, threshold, 'no-successful-plans');
      } else {
        record = this.scorePattern(pattern, now, threshold);
      }
      this.recallRouteLog.push(record);
      if (this.recallRouteLog.length > 64) this.recallRouteLog.shift();
      if (record.route !== 'hit') return undefined; // 低置信 → 回退 DAG 生成（编排层常规规划）
    } else {
      // 原口径（零漂移）：置信度单一字段比较
      if (!pattern || pattern.confidence < threshold) return undefined;
      if (pattern.successfulPlans.length === 0) return undefined;
    }

    // 取平均质量最高的历史成功计划
    let best = pattern!.successfulPlans[0];
    let bestQuality = -1;
    for (const record of pattern!.successfulPlans) {
      const qualities = Object.values(record.qualityScores);
      const avg = qualities.length > 0 ? qualities.reduce((s, v) => s + v, 0) / qualities.length : 0;
      if (avg > bestQuality) {
        bestQuality = avg;
        best = record;
      }
    }

    const nodes: PlanNode[] = best.plan.nodes.map((n) => ({
      id: n.id,
      description: n.description,
      type: n.type,
      dependsOn: [...n.dependsOn],
    }));

    this.broadcast({
      type: 'plan-recalled',
      fingerprint: pattern!.fingerprint,
      confidence: pattern!.confidence,
      nodeCount: nodes.length,
      historicalQuality: Number(bestQuality.toFixed(3)),
    });

    return {
      objective,
      nodes,
      parallelismStrategy: best.plan.parallelismStrategy || 'layered',
      source: 'memory',
    };
  }

  /** A6 升级 1：无模式 / 无成功记录时的回退路由账单（结构化 reason 编码） */
  private blankRoute(at: number, threshold: number, reason: RecallRouteRecord['reason']): RecallRouteRecord {
    return {
      at,
      weightedBase: 0,
      successRate: 0,
      sampleSupport: 0,
      freshness: 0,
      composite: 0,
      threshold,
      ageDays: 0,
      route: 'fallback',
      reason,
    };
  }

  /**
   * 7.0：深思推荐 —— 规划即推断的冷启动序列建议。
   *
   * 与经验检索的本质区别：lookupExperience 回答「历史上类似任务
   * 用过什么」（没有历史就没有答案）；本方法回答「按我脑内的世界
   * 演练，怎样的一串选择全程自由能最低」——**零情景记忆也能给出
   * 计划级建议**（转移模型无证据时诚实返回无知区间，搜索以认知
   * 价值驱动试探序）。
   *
   * 消费方：编排层在 memoryLayer='none'（冷启动）时以序列建议辅助
   * 逐节点选型；有记忆命中时经验优先（深思只补充，不越权）。
   *
   * @param taskType 任务类型（构造状态键 `${taskType}#s${i}`）
   * @param candidateActions 每阶段的候选行动（如模型 id 列表）
   * @param stages 计划阶段数（搜索深度）
   */
  deliberativeRecommendation(
    taskType: string,
    candidateActions: string[],
    stages: number,
    opts?: { breadth?: number; preference?: number },
  ): DeliberationResult | undefined {
    if (!this.deliberation || candidateActions.length === 0 || stages < 1) return undefined;
    // 29.0：挂载 MCTS 后深思推荐切换 UCT 口径（报告与 beam 同构可互查）
    if (this.mctsOptions) {
      return this.deliberation.searchMcts(
        `${taskType}#s0`,
        candidateActions,
        {
          iterations: this.mctsOptions.iterations,
          explorationC: this.mctsOptions.explorationC,
          discount: this.mctsOptions.discount,
          topK: opts?.breadth,
          preference: opts?.preference,
          advance: ({ step }) => `${taskType}#s${step + 1}`,
        },
      );
    }
    return this.deliberation.search(
      `${taskType}#s0`,
      candidateActions,
      {
        depth: stages,
        breadth: opts?.breadth,
        preference: opts?.preference,
        // 确定性阶段状态机：第 i 步 → `${taskType}#s{i+1}`（不依赖学习后继）
        advance: ({ step }) => `${taskType}#s${step + 1}`,
      },
    );
  }

  /** 29.0 MCTS 搜索参数（attachMctsSearch 后深思推荐走 UCT；undefined = 原 beam search） */
  private mctsOptions?: { iterations?: number; explorationC?: number; discount?: number };

  /**
   * 29.0：挂载 UCT 搜索口径（幂等；撤除传 null）。
   * 深思推荐从 beam search 切换为 MCTS——转移边按 Beta 后验采样成败，
   * UCB1 平衡利用/探索，迭代预算耗尽即读出（任意时刻性）。
   */
  attachMctsSearch(options?: { iterations?: number; explorationC?: number; discount?: number } | null): void {
    this.mctsOptions = options === null ? undefined : (options ?? {});
  }

  /**
   * 71.0：挂载 A* 计划搜索（幂等覆盖，挂载即生效——旁路咨询口径）。
   *
   * optimalSubplan() 把「任务图 → 最优子计划序列」从贪心组装升级为
   * 可证明最优的 A* 搜索（可采纳 h 下最优性由弹出语义证明；展开/重开
   * 计数即运行时账单可审计）。不改变 buildPlan/执行路径（零漂移）——
   * 编排侧按需消费（h 用关键路径下界，checkConsistent 上线前自证）。
   */
  attachAstarPlanner(): void {
    this.astarPlannerEnabled = true;
  }

  /** 71.0：A* 挂载标志（未挂载零介入） */
  private astarPlannerEnabled = false;

  /**
   * 71.0：最优子计划搜索（未挂载返回 undefined）。
   * @param nodes 节点 id 清单
   * @param edges 依赖边（from/to/cost——cost = 预计 token 或时延）
   * @param heuristic 可采纳启发（缺省 h≡0 = Dijkstra 精确口径）
   */
  optimalSubplan(
    nodes: string[],
    edges: Array<{ from: string; to: string; cost: number }>,
    start: string,
    goal: string,
    options?: { heuristic?: (node: string) => number },
  ): import('./core/astar-search.js').SearchResult | undefined {
    if (!this.astarPlannerEnabled) return undefined;
    try {
      const graph = graphFromEdgeList(nodes, edges);
      return astar({ graph, start, goal, h: options?.heuristic ?? zeroHeuristic });
    } catch {
      return undefined; // 图规格非法（未知节点/负代价等）→ 诚实降级
    }
  }

  /**
   * 72.0：挂载稀疏归因（幂等覆盖，挂载即生效——旁路分析口径）。
   *
   * attributeFactors() 把「哪些因素真正起作用」从全因素回归升级为
   * 稀疏恢复：cvLasso 自选 λ，activeSet 即「真正起作用的少数因素」
   * 短清单（KKT 违反 ≤ 0 才可采信——最优性证书随结果落账）；候选集
   * 交 5.0 因果内核裁决方向（稀疏恢复给候选、因果定极性——互补成环）。
   * 不改变任何检索/推荐路径（零漂移）。
   */
  attachSparseAttribution(): void {
    this.sparseAttributionEnabled = true;
  }

  /** 72.0：稀疏归因挂载标志（未挂载零介入） */
  private sparseAttributionEnabled = false;

  /**
   * 72.0：质量归因的稀疏恢复（未挂载返回 undefined）。
   * @param A 因素 × 回合矩阵（列标准化；y 先中心化——内核无截距项）
   */
  attributeFactors(A: number[][], y: number[], options?: { folds?: number; seed?: number }): {
    bestLambda: number;
    cvError: number;
    coefficients: number[];
    activeSet: number[];
    kktViolation: number;
  } | undefined {
    if (!this.sparseAttributionEnabled) return undefined;
    try {
      const cv = cvLasso({ A, y, folds: options?.folds, seed: options?.seed });
      const fit = lassoCD({ A, y, lambda: cv.bestLambda });
      return {
        bestLambda: cv.bestLambda,
        cvError: cv.cvError,
        coefficients: fit.x,
        activeSet: fit.activeSet,
        kktViolation: fit.kktViolation,
      };
    } catch {
      return undefined; // 矩阵规格非法 → 诚实降级
    }
  }

  /**
   * 8.0：元认知推荐 —— 理性元推理的冷启动序列建议。
   *
   * 与 7.0 深思推荐的区别：deliberativeRecommendation **每次都全深度
   * 搜索**（想不想要深思是配置，不是决策）；本方法把「想多深」本身
   * 变成决策——双过程仲裁：
   *   habit       深思已摊销为习惯（查表直答，成本 ≈ 0）
   *   reactive    证据充分且优劣悬殊（VOC ≈ 0，直接反应一步）
   *   deliberative 任意时搜索（首行动稳定即停，思考按 nat 计价）
   *
   * 结算闭环：上游执行后调 metareasoner.settleDecision(decisionId, 成败)
   * → 反应失手收紧门槛、深思成功晋升习惯（元学习）。
   */
  metacognitiveRecommendation(
    taskType: string,
    candidateActions: string[],
    stages: number,
    opts?: { preference?: number },
  ): ArbitrationResult | undefined {
    if (!this.metareasoner || candidateActions.length === 0 || stages < 1) return undefined;
    // 状态推进交给学到的转移模型（行动依赖的后继：诱饵通向死路、
    // 缓行通向富态——这正是深思要看见的结构）；无证据时 MAP 后继
    // 停留原态，认知价值驱动试探序。
    return this.metareasoner.decide(`${taskType}#s0`, candidateActions, {
      preference: opts?.preference,
    });
  }

  /**
   * 混合检索（自主学习建议 1：sqlite-vec + FTS5 + jieba 分词管道）
   *
   * 四路召回合并去重（按 refId 取最高分）：
   * 1. 模糊匹配（findPattern：taskType/complexity/features 相似度）
   * 2. FTS5 全文（trigram 子串级 + jieba 式 token 级，中文友好）
   * 3. 向量（sqlite-vec 可用时宿主扩展；缺省稀疏词频向量余弦）
   * 4. 图联想（记忆网络相邻节点，权重折半计入）
   */
  hybridSearch(query: string, taskType: string, complexity: number, limit = 5): MemorySearchHit[] {
    const merged = new Map<string, MemorySearchHit>();
    const consider = (hit: MemorySearchHit, factor = 1): void => {
      const score = hit.score * factor;
      const prev = merged.get(hit.refId);
      if (!prev || prev.score < score) merged.set(hit.refId, { ...hit, score });
    };

    const fuzzy = this.memory.findPattern(taskType, complexity);
    if (fuzzy) consider({ kind: 'pattern', refId: fuzzy.fingerprint, score: 1 });
    for (const hit of this.memory.fullTextSearch?.(query, limit) ?? []) consider(hit);
    for (const hit of this.memory.vectorSearch?.(query, limit) ?? []) consider(hit, 0.9);
    if (this.graph) {
      for (const hit of [...merged.values()]) {
        for (const related of this.graph.related(hit.refId, 3)) {
          consider({ kind: 'pattern', refId: related, score: hit.score }, 0.5);
        }
      }
    }

    return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** 进度事件广播（broadcaster 缺省时为空操作） */
  private broadcast(event: Record<string, any>): void {
    if (!this.broadcaster) return;
    this.broadcaster.broadcast({ type: event.type as string, timestamp: Date.now(), ...event });
  }
}

// ───────────────────── 第四轮 R4-A6 文件级工具（确定性、零依赖） ─────────────────────

/** 数值 6 位小数规整（读数口径统一，浮点尾差不进账面） */
function round6(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * 模板结构签名（FNV-1a 32bit × 两轮——确定性内容寻址：
 * 同构计划（类型序列 + 依赖形态 + 槽位化描述）恒同签名）
 */
function stableTemplateSignature(types: string[], slotNodes: string[], objectiveTemplate: string): string {
  const parts = [types.join('>'), ...slotNodes, objectiveTemplate].join('|');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < parts.length; i += 1) {
    const c = parts.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

/** 数字掩码 token 化（模板匹配口径：参数差异不罚分——「5000」与「8000」同占位） */
function maskedTokens(text: string): string[] {
  return text
    .replace(/\d+(?:\.\d+)?/g, '␦')
    .split(/[^\p{L}\p{N}␦]+/u)
    .filter(Boolean);
}
