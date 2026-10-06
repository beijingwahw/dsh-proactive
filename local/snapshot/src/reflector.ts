/**
 * reflector.ts — 反思器组件（新架构「任务执行 → 反思器 → 记忆更新」）
 *
 * 职责（对应架构图 Reflector 框）：
 * - 执行后复盘：消费执行结果，驱动反思引擎（质量趋势 / 阈值自校准 / 教训提取）
 * - 记忆更新：成功方案沉淀（任务模式 + 模型画像）/ 失败记录写入记忆库
 * - 策略反馈：蒸馏策略应用结果回写，反向校准策略置信度
 * - 经验蒸馏：成功沉淀达到阈值时提炼可复用策略
 *
 * 第四轮 R4-A6 新增维度（opt-in，未挂载零漂移）：
 * - 失败知识库：失败的结构化沉淀（失败模式特征 + 触发条件 + 规避动作），
 *   同模式合并计数、规避动作随重复升级；检索命中作为「规避建议」随计划
 *   下发，采纳结果回填有效性（attachFailureKnowledgeBase）
 *
 * 边界：只写记忆库 + 复盘，不做调度决策。
 * 与优化器（optimizer.ts）构成单向数据流的两端：
 *   记忆库 → 优化器 → 模型调度/任务执行 → 反思器 → 记忆更新 → 记忆库
 */

import crypto from 'node:crypto';
import type { ExecutionPlan, PlanExecutionResult } from './types.js';
import type { IMemoryStore, IReflector } from './contracts.js';
import type { ProgressBroadcaster } from './progress-ws.js';
import type { Lesson, ReflectionEngine } from './reflection-engine.js';
import type {
  DistilledStrategy,
  DistillationReport,
  ProceduralAction,
  ProceduralCondition,
  ProceduralMemory,
  SemanticCondition,
  SemanticConclusion,
  SemanticMemory,
  TaskPatternMemory,
} from './memory/long-term-memory.js';
import { buildPatternFingerprint } from './memory/long-term-memory.js';
import type { MemoryGraph } from './memory/memory-graph.js';
import type { ChangeEntry, ChangePayload } from './sync/distributed-sync.js';
import type { Signal } from './sentinel.js';
// 创世纪 70.0：部分信息分解（多模型组合的冗余/独占/协同四分诊断）
import { pidFromJoint, oInformation, type PidReport, type OInfoReport } from './core/partial-info-decomposition.js';

// 第二轮创世纪 82.0/90.0：众包聚合（多模型判定的信任票权）/ 偏好学习
// （RLHF-lite：从偏好对学调度层价值序）
import {
  crowdVerdict,
  PreferenceLedger,
  type CrowdVerdictView,
  type CrowdsourcedLabels,
  type PreferenceLedgerView,
} from './engines-frontier/autonomy25.js';
import { distillRetention } from './core/information-bottleneck.js';
// 第三轮模块域升级 A6：反事实臂台账（OPE 消费口径）+ 洞察去重衰减 / 沉淀价值评分（共用全层证据半衰期）
import type { DiscretePolicy, Episode } from './core/off-policy-evaluation.js';
import { tabularPolicy } from './core/off-policy-evaluation.js';
import { decayFactor } from './core/evidence.js';

/** 反思器配置 */
export interface ReflectorConfig {
  /** 是否广播进度事件（lesson-extracted / experience-distilled 等） */
  enableProgress?: boolean;
  /** 教训沉淀回调（编排层日志） */
  onLesson?: (lesson: Lesson) => void;
  /** 经验蒸馏回调（编排层日志） */
  onDistilled?: (strategies: DistilledStrategy[]) => void;
  /** 第二阶段：知识蒸馏回调（语义+程序记忆产出） */
  onKnowledgeDistilled?: (report: DistillationReport) => void;
  /** 第二阶段：参与蒸馏的最低情景记忆置信度，缺省 0.6 */
  distillMinConfidence?: number;
  /** 第二阶段：参与蒸馏的最低成功方案数，缺省 3 */
  distillMinSuccesses?: number;
  /** 第二阶段：模型偏好蒸馏的最低占比阈值，缺省 0.6 */
  distillModelAffinityThreshold?: number;
  /**
   * 第二阶段升级：阈值自动蒸馏 — 距上次蒸馏新增情景事件 ≥ 该值时，
   * 在成功复盘后自动触发知识蒸馏（缺省 5；设为 0 关闭自动触发）。
   * 与自主循环的周期触发互补：高负载更快沉淀，低负载不做无效全量蒸馏。
   */
  autoDistillThreshold?: number;
  // ── 2.0：统计学习反思 ──
  /** 校准滑动窗口容量（缺省 50；Brier 残差滚动统计范围） */
  calibrationWindowSize?: number;
  /** 反事实遗憾触发的置信差距（缺省 0.1；替代者下界须超过所用模型后验均值该幅度） */
  counterfactualMargin?: number;
  /** 反事实分析的最低有效样本量（缺省 3；证据不足不产生遗憾结论） */
  counterfactualMinSamples?: number;
}

/** 决策洞察记录（2.0：执行器收集、反思器消费的调度预测归因） */
export interface DecisionInsightRecord {
  nodeId: string;
  taskType: string;
  modelId: string;
  /** 调度时预测的成功概率（贝叶斯后验均值） */
  predictedConfidence: number;
  /** 本次是否探索性选择 */
  exploration: boolean;
  /** 该节点实际执行结果 */
  success: boolean;
}

/** 调度校准状态（2.0：预测置信度 vs 实际结果的持续统计；3.0：自修正量） */
export interface CalibrationStatus {
  /** Brier 分 = mean((predicted - actual)²)，0 完美 1 最差（概率预测质量金标准） */
  brierScore: number;
  /** 平均残差 = mean(predicted - actual)：>0 系统性过自信，<0 欠自信 */
  residualMean: number;
  /** 样本量（窗口内） */
  samples: number;
  /** 校准方向判定（样本 < 10 时为 insufficient） */
  direction: 'overconfident' | 'underconfident' | 'calibrated' | 'insufficient';
  /** 滑动窗口容量 */
  windowSize: number;
/**
 * 3.0 校准自修正量：后续预测置信度的建议偏移（过自信 → 负值收缩）。
 * 样本 ≥ 20 且 |residualMean| > 0.1 时生效（= −residual × 0.5，±0.15 钳制），
 * 否则为 0——样本不足或已校准时不动预测，避免噪声驱动的过度修正。
 */
  correction: number;
}

// ───────────────────── 第三轮模块域升级 A6：反事实臂台账 / 洞察去重衰减 / 沉淀价值评分 ─────────────────────

/**
 * A6 升级 4：备选方案反事实臂（沉淀时的「当时还有哪些选择」结构化记录）
 *
 * 每个候选臂的估计成功概率来自记忆库贝叶斯后验（时间加权 + 小样本
 * 收缩——不是拍脑袋概率）；证据不足（有效样本 < minSamples）的候选
 * 不入账（诚实优先于覆盖度）。
 */
export interface CounterfactualArm {
  modelId: string;
  /** 估计成功概率（贝叶斯后验均值；实际臂无可用时以本次实测代替并标注 samples=0） */
  estimatedProb: number;
  /** 威尔逊下界（保守口径——备选臂采信门槛） */
  wilsonLower: number;
  /** 有效样本量（0 = 无先验，estimatedProb 为本次实测） */
  samples: number;
  /** 是否本次实际执行的臂 */
  chosen: boolean;
}

/**
 * A6 升级 4：一次节点沉淀的反事实台账记录（决策台账原子）
 *
 * 「实际选了谁 + 结果如何 + 当时还有什么备选及其估计」三元组。
 * 供两个下游消费：决策台账（审计口径）与 88.0 离线策略评估
 * （counterfactualOpeDataset 直接产出 Episode + 行为策略）。
 */
export interface CounterfactualOutcomeRecord {
  at: number;
  taskType: string;
  nodeId: string;
  /** 实际选择的模型（行为臂） */
  chosenModel: string;
  /** 实际结果（成功 1 / 失败 0 —— OPE 回报口径） */
  outcome: 0 | 1;
  /** 该节点质量分 */
  quality: number;
  /** 候选臂表（含实际臂） */
  arms: CounterfactualArm[];
  /** 行为策略对实际臂的选择概率（调度器探索率桥接；缺省均匀 1/K） */
  chosenPropensity: number;
}

/**
 * A6 升级 5：洞察账本条目（同类洞察合并计数 + 半衰期衰减）
 *
 * 「同类」= 同 key（taskType × subject）：重复出现的洞察合并为一条、
 * 计数累加（去重），而不是每次沉淀都新开一条把账本灌满同质条目；
 * 读取时按距 lastSeenAt 的年龄做半衰期衰减——长期不再出现的洞察
 * 有效分自然衰减为遗忘候选（对接遗忘曲线 / 60.0 率失真语义）。
 */
export interface InsightLedgerEntry {
  /** 洞察键（taskType::subject —— 同类合并的判据） */
  key: string;
  /** 洞察适用范围（任务类型；跨任务为 'global'） */
  scope: string;
  /** 洞察主体（模型 id / 记忆条目 id） */
  subject: string;
  /** 累计出现次数（同类合并计数） */
  hits: number;
  successes: number;
  failures: number;
  /** 原始成功率（successes / hits） */
  rawScore: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** 半衰期新鲜度（0.5^(ageDays/halfLifeDays)） */
  freshness: number;
  /** 有效分 = rawScore × freshness（排序 / 遗忘判定口径） */
  effectiveScore: number;
}

/** A6 升级 5：洞察账本视图（衰减后排序 + 遗忘候选分离） */
export interface InsightLedgerView {
  entries: InsightLedgerEntry[];
  /** 有效分跌破阈值的遗忘候选（读取时判定，不删除底账） */
  forgetCandidates: InsightLedgerEntry[];
  /** 账本容量上限 */
  maxEntries: number;
}

/**
 * A6 升级 6（加分）：沉淀价值评分条目（历史命中频率先验 → 遗忘候选标注）
 *
 * 对蒸馏产物（语义/程序/策略）按「历史命中频率 × 应用成功率 × 新鲜度」
 * 折算价值分：从未被命中且长期闲置的条目标为 forget-candidate——
 * 喂给记忆库遗忘曲线（60.0 率失真语义）做先验，而非等价对待全部沉淀。
 */
export interface SedimentationValueEntry {
  kind: 'semantic' | 'procedural' | 'strategy';
  id: string;
  /** 历史命中次数（本地挂账计数 + 记忆库 appliedTotal） */
  hits: number;
  successes: number;
  successRate: number;
  /** 距最近应用/蒸馏的天数 */
  daysIdle: number;
  /** 价值分 = log(1+hits)/log(1+hitSaturation) × successRate × 0.5^(daysIdle/halfLifeDays) */
  value: number;
  /** retain / forget-candidate（value < forgetThreshold） */
  recommendation: 'retain' | 'forget-candidate';
}

// ───────────────────── 第四轮模块域升级 R4-A6：失败知识库（结构化失败沉淀 + 规避建议） ─────────────────────

/** R4-A6 升级 3：失败错误类目（与反思引擎规则化兜底同口径的确定性分类） */
export type FailureErrorCategory = 'timeout' | 'quality' | 'dependency' | 'transient';

/**
 * R4-A6 升级 3：失败模式条目（失败的结构化沉淀）
 *
 * 「失败模式特征 + 触发条件 + 规避动作」三元组——同一签名（任务类型 ×
 * 根因 × 失败节点类型）的重复失败合并计数（occurrences），规避动作随
 * 重复次数升级（超时：首次参数调优 → 第二次起直接规避涉事模型）。
 * 检索命中时作为「规避建议」随计划下发（avoidanceAdvice）。
 */
export interface FailureModeEntry {
  /** 内容寻址稳定 id（签名哈希——同模式跨次沉淀同 id，合并计数） */
  id: string;
  taskType: string;
  /** 模式签名 `${taskType}::${rootCause}::${failedNodeType}` */
  signature: string;
  /** 根因（反思引擎 RootCauseCategory 口径） */
  rootCause: 'timeout' | 'model-capability' | 'dependency' | 'transient';
  /** 错误类目 */
  errorCategory: FailureErrorCategory;
  /** 失败节点类型 */
  failedNodeType: string;
  /** 涉事模型集合（同模式累计） */
  implicatedModels: string[];
  /** 触发条件（与程序记忆同构——可直接落为检索条件） */
  triggers: ProceduralCondition[];
  /** 规避动作（随 occurrences 升级） */
  avoidance: ProceduralAction;
  /** 同模式累计失败次数 */
  occurrences: number;
  /** 规避建议被采纳次数 */
  avoidanceAdopted: number;
  /** 采纳后成功的次数（规避有效性证据） */
  avoidanceSuccesses: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

/**
 * R4-A6 升级 3：规避建议（检索命中时随计划下发）
 *
 * matchScore = 0.6 基础 + 0.2 节点类型匹配 + 0.2 错误线索匹配（确定性
 * 加法——上下文给得越准建议越可信）；effectiveness 为规避建议采纳后的
 * 实测成功率（无采纳记录时 undefined——诚实标注）。
 */
export interface AvoidanceAdvice {
  entryId: string;
  taskType: string;
  signature: string;
  rootCause: FailureModeEntry['rootCause'];
  errorCategory: FailureErrorCategory;
  /** 规避动作（调度层消费：avoid-model 剔除候选 / param-tune 调参） */
  avoidance: ProceduralAction;
  /** 同模式历史失败次数（先验强度） */
  occurrences: number;
  /** 触发上下文匹配分 0.6~1 */
  matchScore: number;
  /** 规避有效性 = avoidanceSuccesses / avoidanceAdopted（无采纳记录 undefined） */
  effectiveness?: number;
  rationale: string;
}

/**
 * 反思器
 *
 * 被编排层（index.ts）持有：执行器完成计划后调用 reflectOnOutcome()，
 * 一次性完成「复盘 → 记忆更新 → 策略反馈 → 蒸馏」全链路学习。
 */
export class Reflector implements IReflector {
  private memory: IMemoryStore;
  private reflection: ReflectionEngine;
  private config: ReflectorConfig;
  private broadcaster?: ProgressBroadcaster;
  private graph?: MemoryGraph;
  /** 同步变更登记回调（由 index.ts 桥接到 distributed-sync.recordChange） */
  private onMemoryChange?: (type: ChangeEntry['type'], fingerprint: string, payload: ChangePayload) => void;
  /** 蒸馏进行中标志（阈值自动触发的防抖，避免并发重复蒸馏） */
  private distilling = false;
  /** 37.0：信息瓶颈蒸馏定价（attachBottleneckDistiller 后生效；未挂载零漂移） */
  private bottleneck?: { beta: number; retentionFloor: number };
  /** 37.0：最近一次瓶颈定价读数（审计口径） */
  private lastBottleneck?: { retention: number; iXY: number; clusters: number; sampleCount: number };
  /** 2.0：校准滑动窗口（Brier 残差滚动统计） */
  private calibrationWindow: Array<{ predicted: number; actual: 0 | 1 }> = [];

  constructor(params: {
    memory: IMemoryStore;
    reflection: ReflectionEngine;
    config?: ReflectorConfig;
    broadcaster?: ProgressBroadcaster;
    graph?: MemoryGraph;
    onMemoryChange?: (type: ChangeEntry['type'], fingerprint: string, payload: ChangePayload) => void;
  }) {
    this.memory = params.memory;
    this.reflection = params.reflection;
    this.config = params.config ?? {};
    this.broadcaster = params.broadcaster;
    this.graph = params.graph;
    this.onMemoryChange = params.onMemoryChange;
  }

  /**
   * 运行时配置热更新（第四阶段：元认知控制器调参落地入口）
   *
   * 元认知层经此调整反思触发频率与蒸馏门槛（autoDistillThreshold /
   * distillMinConfidence 等），立即对后续复盘生效，无需重启。
   * 回调类字段（onLesson/onDistilled/...）仅显式传入时覆盖。
   */
  updateConfig(patch: ReflectorConfig): void {
    this.config = { ...this.config, ...patch };
  }

  /** 当前配置快照（元认知旋钮 read 端；只读） */
  getConfig(): Readonly<ReflectorConfig> {
    return { ...this.config };
  }

  /**
   * 执行后反思与记忆更新（闭环学习入口）
   *
   * 步骤：
   * 1. 质量趋势记录（反思引擎阈值自校准）
   * 2. 经验沉淀：成功 → 任务模式 + 模型画像；失败 → 失败记录 + 教训提取
   * 3. 策略反馈：本次应用的蒸馏策略按结果回写，校准置信度
   * 3.5 记忆反馈（第二阶段升级）：本次命中的语义/程序记忆按结果回写——
   *    有效规律越用越强，无效规律被应用成功率反向衰减，同时刷新 lastAppliedAt
   *    （否则遗忘曲线会以 distilledAt 为基准误杀从未被"应用"过的高级记忆）
   * 4. 经验蒸馏：成功时尝试提炼新策略
   * 4.6 阈值自动蒸馏（第二阶段升级）：新增情景事件达阈值时后台触发知识蒸馏
   *
   * @param signal 触发信号
   * @param plan 执行的计划
   * @param result 计划执行结果
   * @param appliedStrategies 本次注入/应用的蒸馏策略 id 列表（策略反馈闭环）
   * @param appliedMemoryIds 本次经验检索命中的语义/程序记忆 id（记忆反馈闭环）
   */
  reflectOnOutcome(params: {
    signal: Signal;
    plan: ExecutionPlan;
    result: PlanExecutionResult;
    appliedStrategies?: string[];
    /** 第二阶段升级：本次命中的语义/程序记忆 id（三层记忆应用反馈闭环） */
    appliedMemoryIds?: { semantic?: string[]; procedural?: string[] };
    /** 2.0：本次各节点的调度决策洞察（校准闭环素材；缺省跳过校准更新） */
    decisionInsights?: DecisionInsightRecord[];
  }): void {
    const { signal, plan, result } = params;
    const taskType = plan.nodes[0]?.type ?? signal.type;

    // 1. 质量趋势记录（驱动阈值自校准与下滑告警）
    this.reflection.recordExecution(taskType, result.avgQuality, result.success);

    // 2. 经验沉淀（记忆更新）
    this.settleExperience(signal, plan, result);

    // 2.2 第三轮 A6 升级 4：反事实结果台账（沉淀旁路——实际臂 + 结果 + 备选臂估计；
    //     未挂载零介入，不改变任何既有沉淀行为）
    if (this.counterfactualLedger) {
      const nodeTypeById = new Map(plan.nodes.map((n) => [n.id, n.type] as const));
      for (const node of result.nodeResults) {
        if (!node.modelId) continue;
        this.noteCounterfactualOutcome(nodeTypeById.get(node.nodeId) ?? taskType, node, plan.nodes.length);
      }
    }

    // 2.4 第三轮 A6 升级 5/6：洞察入账（同类合并计数）+ 沉淀条目命中计数
    //     （未挂载零介入；decisionInsights 的成败、命中记忆的成败均按结果入账）
    if (this.insightLedger || this.sedimentationScoring) {
      const now = this.insightLedger?.clock() ?? this.sedimentationScoring!.clock();
      for (const insight of params.decisionInsights ?? []) {
        this.noteInsightHit(insight.taskType, insight.modelId, insight.success, now);
      }
      for (const semanticId of params.appliedMemoryIds?.semantic ?? []) {
        this.noteInsightHit(taskType, semanticId, result.success, now);
        this.noteSedimentationHit('semantic', semanticId, result.success);
      }
      for (const proceduralId of params.appliedMemoryIds?.procedural ?? []) {
        this.noteInsightHit(taskType, proceduralId, result.success, now);
        this.noteSedimentationHit('procedural', proceduralId, result.success);
      }
      for (const strategyId of params.appliedStrategies ?? []) {
        this.noteSedimentationHit('strategy', strategyId, result.success);
      }
    }

    // 2.5 统计学习反思（2.0：校准闭环 + 反事实遗憾）
    if (params.decisionInsights && params.decisionInsights.length > 0) {
      this.updateCalibration(params.decisionInsights);
    }
    this.analyzeCounterfactualRegret(signal, plan, result);

    // 2.6 第四轮 R4-A6 升级 3：失败知识库沉淀（同模式失败的结构化规避记忆；
    //     未挂载零介入，不改变任何既有沉淀/教训行为）
    if (!result.success && this.failureKnowledgeBase) {
      this.captureFailureMode(taskType, plan, result);
    }

    // 3. 策略应用反馈闭环：有效策略越用越强，无效策略自然淘汰
    for (const strategyId of params.appliedStrategies ?? []) {
      this.memory.recordStrategyOutcome(strategyId, result.success);
    }

    // 3.5 语义/程序记忆应用反馈闭环（第二阶段升级）
    for (const semanticId of params.appliedMemoryIds?.semantic ?? []) {
      this.memory.recordSemanticOutcome(semanticId, result.success);
    }
    for (const proceduralId of params.appliedMemoryIds?.procedural ?? []) {
      this.memory.recordProceduralOutcome(proceduralId, result.success);
    }

    // 4.5 记忆图更新（自主学习建议 2：记忆网络共现边 + 主题树挂载）
    if (this.graph && result.success) {
      const complexity = Math.min(1, plan.nodes.length / 5);
      const features = [...new Set(plan.nodes.map((n) => n.type))];
      const fingerprint = buildPatternFingerprint(taskType, complexity, features);
      this.graph.ensureNode(fingerprint, 'pattern', signal.description);
      this.graph.attachTopic(fingerprint, taskType);
      for (const strategyId of params.appliedStrategies ?? []) {
        this.graph.ensureNode(strategyId, 'strategy', strategyId);
        this.graph.link(fingerprint, strategyId);
      }
    }

    // 4. 失败 → 教训提取（异步，不阻塞主流程）；成功 → 经验蒸馏
    if (!result.success) {
      void this.reflection.extractLesson({ signal, taskType, result, plan }).then((lesson) => {
        if (lesson) {
          this.broadcast({ type: 'lesson-extracted', lessonId: lesson.id, rootCause: lesson.rootCause, lesson: lesson.lesson });
          this.config.onLesson?.(lesson);
        }
      });
    } else {
      const fresh = this.memory.distillExperience();
      if (fresh.length > 0) {
        this.broadcast({ type: 'experience-distilled', strategies: fresh.map((s) => ({ id: s.id, description: s.description, confidence: s.confidence })) });
        this.config.onDistilled?.(fresh);
      }
    }

    // 4.6 阈值自动蒸馏（第二阶段升级）：新增情景事件达到阈值时后台触发
    // （非阻塞：蒸馏在微任务/IO 间隙完成，失败不影响主复盘流程）
    const autoThreshold = this.config.autoDistillThreshold ?? 5;
    if (autoThreshold > 0 && !this.distilling) {
      const progress = this.memory.getDistillationProgress?.();
      if (progress && progress.pendingSinceLastDistillation >= autoThreshold) {
        void this.distillKnowledge().catch(() => {
          /* 自动蒸馏失败静默（下次阈值再试） */
        });
      }
    }
  }

  /**
   * 校准更新（2.0：预测置信度 vs 实际结果的滚动统计）
   *
   * Brier 分 = mean((predicted - actual)²)——概率预测质量金标准：
   * 调度器说「90% 能成」的实际成了 → 无惩罚；说 90% 却连续失败 → 重罚。
   * 这是「系统知道自己有多准」的自知之明，过自信/欠自信方向可诊断。
   */
  private updateCalibration(insights: DecisionInsightRecord[]): void {
    const windowSize = this.config.calibrationWindowSize ?? 50;
    for (const insight of insights) {
      this.calibrationWindow.push({ predicted: insight.predictedConfidence, actual: insight.success ? 1 : 0 });
    }
    if (this.calibrationWindow.length > windowSize) {
      this.calibrationWindow.splice(0, this.calibrationWindow.length - windowSize);
    }
    const status = this.getCalibration();
    this.broadcast({
      type: 'calibration-updated',
      brierScore: Number(status.brierScore.toFixed(4)),
      residualMean: Number(status.residualMean.toFixed(4)),
      samples: status.samples,
      direction: status.direction,
      correction: status.correction,
    });
  }

  /** 校准状态查询（2.0：调度预测质量的持续自知；3.0：附带自修正量） */
  getCalibration(): CalibrationStatus {
    const windowSize = this.config.calibrationWindowSize ?? 50;
    const n = this.calibrationWindow.length;
    if (n === 0) {
      return { brierScore: 0, residualMean: 0, samples: 0, direction: 'insufficient', windowSize, correction: 0 };
    }
    const brier = this.calibrationWindow.reduce((s, w) => s + (w.predicted - w.actual) ** 2, 0) / n;
    const residual = this.calibrationWindow.reduce((s, w) => s + (w.predicted - w.actual), 0) / n;
    const direction: CalibrationStatus['direction'] =
      n < 10 ? 'insufficient' : residual > 0.1 ? 'overconfident' : residual < -0.1 ? 'underconfident' : 'calibrated';
    // 3.0 自修正量：样本充分且系统性偏差显著时，给出保守的预测偏移建议
    const correction = n >= 20 && Math.abs(residual) > 0.1 ? Math.max(-0.15, Math.min(0.15, -residual * 0.5)) : 0;
    return {
      brierScore: Number(brier.toFixed(6)),
      residualMean: Number(residual.toFixed(6)),
      samples: n,
      direction,
      windowSize,
      correction: Number(correction.toFixed(6)),
    };
  }

  /**
   * 校准自修正（3.0）：对调度预测置信度施加校准偏移
   *
   * 过自信系统（如预测 0.9 实际 0.7）→ 收缩预测使其贴近真实成功率；
   * 欠自信系统 → 适度放大。样本不足或已校准时为恒等映射（零风险旁路）。
   */
  correctConfidence(predicted: number): number {
    const { correction, samples } = this.getCalibration();
    if (correction === 0 || samples < 20) return predicted;
    return Number(Math.max(0, Math.min(1, predicted + correction)).toFixed(6));
  }

  /**
   * 自知之明报告（3.0：系统对自己记忆与预测质量的一次性全景自检）
   *
   * 汇聚两路自知信号：
   * - calibration：调度预测校准（Brier / 残差 / 方向 / 自修正量）
   * - census：全层证据普查（各记忆层证据覆盖度 + 有效样本量 + 证据枯竭 +
   *   模型能力漂移）——记忆库未实现 evidenceCensus 时静默省略（旧实现兼容）
   */
  getSelfKnowledge(): { generatedAt: number; calibration: CalibrationStatus; census?: import('./memory/long-term-memory.js').EvidenceCensus } {
    const calibration = this.getCalibration();
    const memoryWithCensus = this.memory as import('./memory/long-term-memory.js').LongTermMemory;
    const census = typeof memoryWithCensus.evidenceCensus === 'function' ? memoryWithCensus.evidenceCensus() : undefined;
    return { generatedAt: Date.now(), calibration, census };
  }

  /**
   * 反事实遗憾分析（2.0：「当时是否有更优选择」的结构化复盘）
   *
   * 对每个节点实际使用的模型，检索全部模型画像中该任务类型的贝叶斯估计：
   * 若存在替代者满足（威尔逊下界 > 所用模型后验均值 + margin 且有效样本充足），
   * 则生成反事实教训写入决策反馈——不依赖 LLM 的可机器验证归因，
   * 让「本可以更优」的选择失误成为可检索的记忆而非事后遗忘。
   *
   * 证据门槛（margin / minSamples 可配）杜绝小样本噪声触发误报。
   */
  private analyzeCounterfactualRegret(signal: Signal, plan: ExecutionPlan, result: PlanExecutionResult): void {
    if (!this.memory.getBayesianEstimate) return; // 记忆库未提供贝叶斯估计（旧实现兼容）
    const margin = this.config.counterfactualMargin ?? 0.1;
    const minSamples = this.config.counterfactualMinSamples ?? 3;
    const nodeTypeById = new Map(plan.nodes.map((n) => [n.id, n.type] as const));

    for (const node of result.nodeResults) {
      const taskType = nodeTypeById.get(node.nodeId);
      if (!taskType) continue;
      const usedEstimate = this.memory.getBayesianEstimate(node.modelId, taskType);
      if (!usedEstimate || usedEstimate.effectiveSamples < minSamples) continue;

      let bestAlternative: { modelId: string; wilsonLower: number; samples: number } | undefined;
      for (const profile of this.memory.getAllModelProfiles()) {
        if (profile.id === node.modelId) continue;
        const est = this.memory.getBayesianEstimate!(profile.id, taskType);
        if (!est || est.effectiveSamples < minSamples) continue;
        if (est.wilsonLower > usedEstimate.posteriorMean + margin && (!bestAlternative || est.wilsonLower > bestAlternative.wilsonLower)) {
          bestAlternative = { modelId: profile.id, wilsonLower: est.wilsonLower, samples: est.effectiveSamples };
        }
      }
      if (!bestAlternative) continue;

      const lesson = `[反事实] ${taskType} 节点 ${node.nodeId} 使用 ${node.modelId}（贝叶斯后验 ${usedEstimate.posteriorMean.toFixed(2)}，本次${node.success ? '成功' : '失败'}），但 ${bestAlternative.modelId} 的威尔逊下界 ${bestAlternative.wilsonLower.toFixed(2)}（有效样本 ${bestAlternative.samples.toFixed(0)}）显著更优——下次同类任务优先考虑`;
      this.memory.appendFeedback({
        id: `cf-${node.nodeId}-${node.modelId}-${Date.now()}`,
        timestamp: Date.now(),
        signalType: taskType,
        signalDescription: signal.description,
        decision: `model:${node.modelId}`,
        outcome: node.success ? 'acceptable' : 'poor',
        outcomeReason: 'counterfactual-regret-analysis',
        lesson,
        chosenModelId: node.modelId,
        predictedConfidence: usedEstimate.posteriorMean,
      });
      this.broadcast({
        type: 'counterfactual-regret',
        nodeId: node.nodeId,
        taskType,
        usedModel: node.modelId,
        usedPosterior: usedEstimate.posteriorMean,
        betterModel: bestAlternative.modelId,
        betterWilsonLower: bestAlternative.wilsonLower,
      });
    }
  }

  /**
   * 知识蒸馏（第二阶段）：从累积的情景记忆中蒸馏出语义记忆与程序记忆
   *
   * 蒸馏来源：
   * 1. 情景记忆（TaskPatternMemory）：高置信度 + 多次成功的模式
   * 2. 反思教训（Lesson）：失败根因 → 反思规则（程序记忆 kind='reflection'）
   * 3. 既有 distillExperience：兼容产出 DistilledStrategy（不变）
   *
   * 蒸馏产物：
   * - 语义记忆（SemanticMemory）：
   *   * model-affinity：某模型在某任务类型的多条模式中占比 ≥ 阈值 → 跨任务规律
   *   * complexity-pattern：高复杂度任务的成功模型偏好
   * - 程序记忆（ProceduralMemory）：
   *   * scheduling：feature='code' 且复杂度高 → prefer-model + enable-cot
   *   * reflection：rootCause='timeout'/'model-capability' → avoid-model 规则
   *
   * 第二阶段升级：
   * - 幂等性升级：蒸馏产物使用内容寻址稳定 id（同一规律跨次蒸馏 id 不变），
   *   重复蒸馏不再丢弃证据，而是合并增强（supportCount 累加、置信度加权），
   *   冲突规律由证据竞争淘汰（详见 upsertSemanticMemory / upsertProceduralMemory）
   * - 水位门控：options.force 未设且新增情景事件 < autoDistillThreshold 且
   *   已有蒸馏知识时跳过全量蒸馏（返回 skipped 报告），避免无效计算
   * - 水位检查点：蒸馏成功后刷新水位（noteDistillationCheckpoint）
   *
   * @param options.force 强制蒸馏（Tool 按需调用 / 首次蒸馏时使用）
   * @returns 蒸馏报告（含本次产出的语义/程序记忆与兼容策略）
   */
  /**
   * 37.0：挂载信息瓶颈蒸馏定价（幂等覆盖，挂载即生效）。
   *
   * 蒸馏门槛从纯水位（样本计数）升维为水位 + 信息量双门：X = 任务位型
   * （类型 × 质量档 × 延迟档），Y = 成败；Blahut–Arimoto IB 压缩后的
   * 保留率 retention = I(T;Y)/I(X;Y) < retentionFloor 时，样本与既有
   * 知识同构——水位再高也只产出重复知识，诚实跳过（below-information）。
   * 未挂载零漂移（原水位单门）。
   */
  attachBottleneckDistiller(options?: { beta?: number; retentionFloor?: number }): void {
    this.bottleneck = {
      beta: options?.beta ?? 5,
      retentionFloor: Math.min(0.99, Math.max(0.01, options?.retentionFloor ?? 0.4)),
    };
  }

  /**
   * 70.0：挂载 PID 组合诊断（幂等覆盖，挂载即生效——只读分析口径）。
   *
   * 多模型组合的「暗结构」第一次可见：combinationPid() 把 (模型A观点,
   * 模型B观点, 最终决策成败) 的经验联合分布做 BROJA 部分信息分解——
   * 协同 C > 0 的组合 = 单独平庸、联合有效（16.0 Shapley 只会平分功劳，
   * 看不见这类组合；应保留并优先编排）；冗余 R 主导 = 两路可相互替代
   * （择一降频省预算）；独占 U 主导 = 预算倾斜给携带信息的那一路。
   * Ω（O 信息）作为组合健康度的单一只读仪表。不改变任何反思/沉淀
   * 路径（零漂移）。
   */
  attachPidDiagnostics(): void {
    this.pidDiagnosticsEnabled = true;
  }

  /**
   * 82.0：挂载众包聚合（幂等覆盖，挂载即生效——咨询口径）。
   *
   * N 个模型对同一判定各自报标签时从「人人一票」升级为 Dawid–Skene：
   * truthPosterior 作为聚合判定输出，workerReliability 作为各模型的
   * 信任票权（哪个模型在哪类问题上可信，EM 从投票记录里自己学出来——
   * 对角塌陷 = 自动摘牌，无需人工规则）。影子计算零漂移。
   */
  attachCrowdAggregation(): void {
    this.crowdAggregationEnabled = true;
  }

  /** 82.0：众包聚合旗标（未挂载零介入） */
  private crowdAggregationEnabled?: boolean;

  /** 82.0：多模型聚合读数（未挂载 / 记录非法时 undefined；truth 可选给两口径正确率对照） */
  crowdVerdictOf(labels: CrowdsourcedLabels, truth?: ReadonlyArray<number>): CrowdVerdictView | undefined {
    return this.crowdAggregationEnabled ? crowdVerdict(labels, truth) : undefined;
  }

  /**
   * 90.0：挂载偏好学习账本（幂等覆盖，挂载即生效——影子学习口径）。
   *
   * 人工/用户反馈从「打分」改录为「偏好对」（notePreferencePair），
   * 攒够窗口量后 bradleyTerryMLE 学出效用向量——RLHF-lite：不训练模型
   * 权重，只学调度层的价值序（指标改版不作废历史：偏好对是不变的原始
   * 证据）。前置体检（传递性 + 拟合优度）不通过时 usable=false——B-T
   * 效用不可用于决策排序。影子学习零漂移。
   */
  attachPreferenceLearning(options?: { minPairs?: number; l2?: number }): void {
    this.preferenceLedger = new PreferenceLedger(options);
  }

  /** 90.0：偏好账本（未挂载零介入） */
  private preferenceLedger?: PreferenceLedger;

  /** 90.0：回填一次偏好对（winner ≻ loser；挂载时由人工反馈通道调用） */
  notePreferencePair(winnerId: string, loserId: string): void {
    this.preferenceLedger?.note(winnerId, loserId);
  }

  /** 90.0：效用学习读数（未挂载 / 样本不足 / 前置体检未过时 usable=false 或 undefined） */
  preferenceView(): PreferenceLedgerView | undefined {
    return this.preferenceLedger?.view();
  }

  // ───────────────────── 第三轮 A6 升级 4：反事实结果台账（沉淀时记录备选方案臂估计） ─────────────────────

  /**
   * A6 升级 4：挂载反事实结果台账（幂等覆盖，挂载即生效——沉淀旁路口径）。
   *
   * reflectOnOutcome 沉淀经验的同时，为每个节点记录「实际臂 + 结果 +
   * 备选臂估计」的反事实台账：备选臂估计 = 记忆库贝叶斯后验（证据门槛
   * minSamples 与 2.0 反事实遗憾分析共用 counterfactualMinSamples 配置）。
   * 台账两个下游：决策台账（审计）与 88.0 离线策略评估
   * （counterfactualOpeDataset 产出 Episode[] + 行为策略 μ）——
   * 「日志策略好不好」第一次有了可评估的离线数据面。
   * 未挂载零漂移（不计算、不落账、不广播）。
   *
   * @param options.clock 注入时钟（确定性验证用；缺省 Date.now）
   * @param options.maxEntries 环形容量（缺省 256）
   * @param options.propensity 行为策略对实际臂的选择概率提供器（调度器
   *        探索率桥接；缺省均匀 1/K）
   */
  attachCounterfactualLedger(options?: { clock?: () => number; maxEntries?: number; propensity?: () => number }): void {
    this.counterfactualLedger = {
      clock: options?.clock ?? (() => Date.now()),
      maxEntries: Math.max(16, options?.maxEntries ?? 256),
      propensity: options?.propensity,
      records: [],
    };
  }

  /** A6 升级 4：反事实台账状态（未挂载零介入） */
  private counterfactualLedger?: {
    clock: () => number;
    maxEntries: number;
    propensity?: () => number;
    records: CounterfactualOutcomeRecord[];
  };

  /**
   * A6 升级 4：沉淀一次节点的反事实臂记录（私有——reflectOnOutcome 沉淀旁路调用）。
   *
   * 备选臂 = 记忆库全部模型画像中该任务类型有效样本 ≥ minSamples 者
   * （剔除实际臂）；实际臂恒入账（无后验时以本次实测为概率、samples=0
   * 标注——诚实记录证据量）。选择概率缺省 1/K（无探索率桥接时的
   * 无信息口径）。
   */
  private noteCounterfactualOutcome(
    taskType: string,
    node: { nodeId: string; modelId: string; quality: number; success: boolean },
    candidateCount: number,
  ): void {
    const ledger = this.counterfactualLedger;
    if (!ledger) return;
    const minSamples = this.config.counterfactualMinSamples ?? 3;
    const arms: CounterfactualArm[] = [];
    // 实际臂：恒入账（估计缺失时以本次实测代替，samples=0）
    const chosenEstimate = this.memory.getBayesianEstimate?.(node.modelId, taskType);
    arms.push({
      modelId: node.modelId,
      estimatedProb: chosenEstimate ? chosenEstimate.posteriorMean : node.success ? 1 : 0,
      wilsonLower: chosenEstimate?.wilsonLower ?? 0,
      samples: chosenEstimate?.effectiveSamples ?? 0,
      chosen: true,
    });
    // 备选臂：证据门槛过滤（与 analyzeCounterfactualRegret 同一 minSamples 口径）
    for (const profile of this.memory.getAllModelProfiles()) {
      if (profile.id === node.modelId) continue;
      const est = this.memory.getBayesianEstimate?.(profile.id, taskType);
      if (!est || est.effectiveSamples < minSamples) continue;
      arms.push({
        modelId: profile.id,
        estimatedProb: est.posteriorMean,
        wilsonLower: est.wilsonLower,
        samples: est.effectiveSamples,
        chosen: false,
      });
    }
    const k = Math.max(candidateCount, arms.length);
    const record: CounterfactualOutcomeRecord = {
      at: ledger.clock(),
      taskType,
      nodeId: node.nodeId,
      chosenModel: node.modelId,
      outcome: node.success ? 1 : 0,
      quality: node.quality,
      arms,
      chosenPropensity: Number((ledger.propensity?.() ?? 1 / k).toFixed(6)),
    };
    ledger.records.push(record);
    if (ledger.records.length > ledger.maxEntries) ledger.records.shift();
  }

  /** A6 升级 4：反事实台账读取（新→旧；未挂载恒空） */
  counterfactualRecords(limit = 32): CounterfactualOutcomeRecord[] {
    return this.counterfactualLedger?.records.slice(-limit).reverse() ?? [];
  }

  /**
   * A6 升级 4：把台账转成 88.0 OPE 可直接消费的数据集（未挂载 undefined）。
   *
   * - 动作索引：记忆库全部模型 id 排序后的全局稳定编号（跨记录可比）
   * - 回报：节点成功 = 1 / 失败 = 0（终端单步轨迹）
   * - 行为策略 μ：台账内各臂被实际选择的经验频率（混合了探索与贪心的
   *   真实行为分布——IS 估计的合法口径）；逐条记录的 chosenPropensity
   *   另存于台账本体（逐决策 IS 消费）
   */
  counterfactualOpeDataset(): { episodes: Episode[]; behavior: DiscretePolicy; armIndexByModel: Record<string, number> } | undefined {
    const ledger = this.counterfactualLedger;
    if (!ledger) return undefined;
    const armIndexByModel: Record<string, number> = {};
    [...this.memory.getAllModelProfiles().map((p) => p.id)]
      .sort()
      .forEach((id, i) => {
        armIndexByModel[id] = i;
      });
    const numActions = Math.max(1, Object.keys(armIndexByModel).length);
    const choiceCounts = new Array<number>(numActions).fill(0);
    let total = 0;
    const episodes: Episode[] = [];
    for (const record of ledger.records) {
      const action = armIndexByModel[record.chosenModel] ?? 0;
      episodes.push({ states: [0, 1], actions: [action], rewards: [record.outcome] });
      choiceCounts[action] += 1;
      total += 1;
    }
    // 行为策略 = 经验选择频率（无记录时均匀）
    const probs = choiceCounts.map((c) => (total > 0 ? c / total : 1 / numActions));
    return { episodes, behavior: tabularPolicy([probs]), armIndexByModel };
  }

  // ───────────────────── 第三轮 A6 升级 5：洞察去重与衰减 + A6 升级 6：沉淀价值评分 ─────────────────────

  /**
   * A6 升级 5：挂载洞察账本（幂等覆盖，挂载即生效——沉淀旁路口径）。
   *
   * 每次复盘把「调度决策洞察 + 命中的记忆条目」按 key（taskType::subject）
   * 合并计数（同类洞察不再重复开条），读取时按半衰期衰减：
   *   effectiveScore = rawScore × 0.5^(ageDays / halfLifeDays)
   * 有效分跌破 forgetThreshold 的洞察列为遗忘候选（对接 60.0 遗忘语义）。
   * 未挂载零漂移。
   *
   * @param options.halfLifeDays 半衰期（缺省 30 天——与全层证据口径一致）
   * @param options.forgetThreshold 遗忘候选阈值（缺省 0.1）
   * @param options.maxEntries 账本容量（缺省 512；满时淘汰最久未更新者——同类合并计数使高频洞察不被误杀）
   * @param options.clock 注入时钟（确定性验证用）
   */
  attachInsightLedger(options?: {
    halfLifeDays?: number;
    forgetThreshold?: number;
    maxEntries?: number;
    clock?: () => number;
  }): void {
    this.insightLedger = {
      halfLifeDays: Math.max(0.5, options?.halfLifeDays ?? 30),
      forgetThreshold: Math.max(0, Math.min(1, options?.forgetThreshold ?? 0.1)),
      maxEntries: Math.max(16, options?.maxEntries ?? 512),
      clock: options?.clock ?? (() => Date.now()),
      entries: new Map(),
    };
  }

  /** A6 升级 5：洞察账本状态（未挂载零介入） */
  private insightLedger?: {
    halfLifeDays: number;
    forgetThreshold: number;
    maxEntries: number;
    clock: () => number;
    entries: Map<string, { scope: string; subject: string; hits: number; successes: number; failures: number; firstSeenAt: number; lastSeenAt: number }>;
  };

  /**
   * A6 升级 6（加分）：挂载沉淀价值评分（幂等覆盖，挂载即生效——计数旁路口径）。
   *
   * 复盘时对「本次命中的语义/程序/策略记忆」计数（历史命中频率先验），
   * sedimentationValueView() 折算价值分并标注 forget-candidate——
   * 从未被命中且长期闲置的沉淀条目第一次有了量化遗忘依据。
   * 未挂载零漂移。
   */
  attachSedimentationScoring(options?: { halfLifeDays?: number; hitSaturation?: number; forgetThreshold?: number; clock?: () => number }): void {
    this.sedimentationScoring = {
      halfLifeDays: Math.max(0.5, options?.halfLifeDays ?? 30),
      hitSaturation: Math.max(1, options?.hitSaturation ?? 10),
      forgetThreshold: Math.max(0, Math.min(1, options?.forgetThreshold ?? 0.15)),
      clock: options?.clock ?? (() => Date.now()),
      hits: new Map(),
    };
  }

  /** A6 升级 6：沉淀价值评分状态（未挂载零介入） */
  private sedimentationScoring?: {
    halfLifeDays: number;
    hitSaturation: number;
    forgetThreshold: number;
    clock: () => number;
    hits: Map<string, { hits: number; successes: number }>;
  };

  /** A6 升级 5/6 共用：一次洞察入账（同类合并计数；未挂载账本时零介入） */
  private noteInsightHit(scope: string, subject: string, success: boolean, at: number): void {
    const ledger = this.insightLedger;
    if (!ledger) return;
    const key = `${scope}::${subject}`;
    const entry = ledger.entries.get(key) ?? { scope, subject, hits: 0, successes: 0, failures: 0, firstSeenAt: at, lastSeenAt: at };
    entry.hits += 1;
    if (success) entry.successes += 1;
    else entry.failures += 1;
    entry.lastSeenAt = at;
    ledger.entries.set(key, entry);
    // 容量淘汰：满时剔除最久未更新者（同类合并计数使高频洞察永不被误杀）
    if (ledger.entries.size > ledger.maxEntries) {
      let oldestKey = key;
      let oldestAt = entry.lastSeenAt;
      for (const [k, e] of ledger.entries) {
        if (e.lastSeenAt < oldestAt) {
          oldestAt = e.lastSeenAt;
          oldestKey = k;
        }
      }
      ledger.entries.delete(oldestKey);
    }
  }

  /** A6 升级 6：沉淀条目命中计数（本地先验，含成败分解；未挂载零介入） */
  private noteSedimentationHit(kind: SedimentationValueEntry['kind'], id: string, success: boolean): void {
    if (!this.sedimentationScoring) return;
    const key = `${kind}:${id}`;
    const prev = this.sedimentationScoring.hits.get(key) ?? { hits: 0, successes: 0 };
    prev.hits += 1;
    if (success) prev.successes += 1;
    this.sedimentationScoring.hits.set(key, prev);
  }

  /** A6 升级 5：洞察账本视图（衰减后排序 + 遗忘候选分离；未挂载 undefined） */
  insightLedgerView(): InsightLedgerView | undefined {
    const ledger = this.insightLedger;
    if (!ledger) return undefined;
    const now = ledger.clock();
    const decayed: InsightLedgerEntry[] = [];
    for (const [key, e] of ledger.entries) {
      const ageDays = Math.max(0, (now - e.lastSeenAt) / 86_400_000);
      const freshness = decayFactor(ageDays * 86_400_000, ledger.halfLifeDays);
      const rawScore = e.hits > 0 ? e.successes / e.hits : 0;
      decayed.push({
        key,
        scope: e.scope,
        subject: e.subject,
        hits: e.hits,
        successes: e.successes,
        failures: e.failures,
        rawScore: Number(rawScore.toFixed(6)),
        firstSeenAt: e.firstSeenAt,
        lastSeenAt: e.lastSeenAt,
        freshness: Number(freshness.toFixed(6)),
        effectiveScore: Number((rawScore * freshness).toFixed(6)),
      });
    }
    decayed.sort((a, b) => b.effectiveScore - a.effectiveScore);
    return {
      entries: decayed.filter((e) => e.effectiveScore >= ledger.forgetThreshold),
      forgetCandidates: decayed.filter((e) => e.effectiveScore < ledger.forgetThreshold),
      maxEntries: ledger.maxEntries,
    };
  }

  /** A6 升级 6：沉淀价值评分视图（历史命中频率先验 + 遗忘候选标注；未挂载 undefined） */
  sedimentationValueView(): SedimentationValueEntry[] | undefined {
    const scoring = this.sedimentationScoring;
    if (!scoring) return undefined;
    const now = scoring.clock();
    const entries: SedimentationValueEntry[] = [];
    const evaluate = (
      kind: SedimentationValueEntry['kind'],
      id: string,
      appliedTotal: number,
      appliedSuccesses: number,
      lastActiveAt: number,
    ): void => {
      const local = scoring.hits.get(`${kind}:${id}`) ?? { hits: 0, successes: 0 };
      const hits = appliedTotal + local.hits;
      const successes = Math.min(appliedSuccesses + local.successes, hits);
      const successRate = hits > 0 ? successes / hits : 0;
      const daysIdle = Math.max(0, (now - lastActiveAt) / 86_400_000);
      const freshness = decayFactor(daysIdle * 86_400_000, scoring.halfLifeDays);
      const value = (Math.log(1 + hits) / Math.log(1 + scoring.hitSaturation)) * successRate * freshness;
      entries.push({
        kind,
        id,
        hits,
        successes,
        successRate: Number(successRate.toFixed(6)),
        daysIdle: Number(daysIdle.toFixed(6)),
        value: Number(value.toFixed(6)),
        recommendation: value < scoring.forgetThreshold ? 'forget-candidate' : 'retain',
      });
    };
    for (const m of this.memory.getAllSemanticMemories()) {
      evaluate('semantic', m.id, m.appliedTotal, m.appliedSuccesses, m.lastAppliedAt ?? m.distilledAt);
    }
    for (const p of this.memory.getAllProceduralMemories()) {
      evaluate('procedural', p.id, p.appliedTotal, p.appliedSuccesses, p.lastAppliedAt ?? p.distilledAt);
    }
    for (const s of this.memory.getAllStrategies()) {
      evaluate('strategy', s.id, s.appliedTotal, s.appliedSuccesses, s.lastAppliedAt ?? s.distilledAt);
    }
    return entries.sort((a, b) => b.value - a.value);
  }

  // ───────────────────── 第四轮模块域升级 R4-A6：失败知识库 ─────────────────────

  /**
   * R4-A6 升级 3：挂载失败知识库（幂等覆盖，挂载即生效）。
   *
   * 失败不再只是「记录 + 异步教训」——每次失败复盘同步沉淀结构化失败
   * 模式：**失败模式特征（根因 × 错误类目 × 失败节点类型）+ 触发条件 +
   * 规避动作**。同签名重复失败合并计数（occurrences 累加，规避动作随
   * 重复升级：超时首次建议调参、第二次起建议直接规避涉事模型）。
   *
   * 检索端（avoidanceAdvice）：计划下发前按任务类型（+ 可选失败节点类型 /
   * 错误线索）检索命中条目作为「规避建议」随计划下发——同模式二次失败
   * 时调度层第一次能在**事前**绕开已知坑（旧口径只有事后教训）。
   * 采纳回填（noteAvoidanceAdopted）：规避建议被采纳后的任务成败回写，
   * effectiveness = 采纳后成功率——规避有效性有了实测证据。
   *
   * 未挂载零漂移（不沉淀、不检索、不回填）。
   *
   * @param options.clock 注入时钟（确定性验证用；缺省 Date.now）
   * @param options.maxEntries 容量上限（缺省 128；满时淘汰 occurrences 最低且最久未见者）
   * @param options.minOccurrences 检索输出的最低出现次数（缺省 1——首次沉淀即可被检索）
   */
  attachFailureKnowledgeBase(options?: { clock?: () => number; maxEntries?: number; minOccurrences?: number }): void {
    this.failureKnowledgeBase = {
      clock: options?.clock ?? (() => Date.now()),
      maxEntries: Math.max(8, options?.maxEntries ?? 128),
      minOccurrences: Math.max(1, options?.minOccurrences ?? 1),
      entries: new Map(),
    };
  }

  /** R4-A6 升级 3：失败知识库状态（未挂载零介入） */
  private failureKnowledgeBase?: {
    clock: () => number;
    maxEntries: number;
    minOccurrences: number;
    entries: Map<string, FailureModeEntry>;
  };

  /**
   * R4-A6 升级 3：失败模式沉淀（私有——reflectOnOutcome 失败分支旁路调用）。
   *
   * 同签名（taskType × rootCause × failedNodeType）合并计数；规避动作按
   * 根因 + 重复次数确定性推导：
   * - timeout：首次 → 放大超时（param-tune ×2）；≥ 2 次 → 规避涉事模型
   * - model-capability（质量不足）：规避涉事模型（能力不足换模型才有意义）
   * - dependency：上游校验（param-tune verifyUpstream）
   * - transient：有限重试（param-tune maxRetries 2）
   */
  private captureFailureMode(taskType: string, plan: ExecutionPlan, result: PlanExecutionResult): void {
    const kb = this.failureKnowledgeBase;
    if (!kb) return;
    const failed = result.nodeResults.find((r) => !r.success);
    if (!failed) return;
    const now = kb.clock();
    const failedNodeType = plan.nodes.find((n) => n.id === failed.nodeId)?.type ?? taskType;
    const { errorCategory, rootCause } = classifyFailureText(failed.error);
    const signature = `${taskType}::${rootCause}::${failedNodeType}`;
    const id = this.stableId('fkb', signature);

    let entry = kb.entries.get(id);
    if (!entry) {
      entry = {
        id,
        taskType,
        signature,
        rootCause,
        errorCategory,
        failedNodeType,
        implicatedModels: [],
        triggers: [
          { dimension: 'task-type', operator: 'eq', value: taskType },
          { dimension: 'root-cause', operator: 'eq', value: rootCause },
        ],
        avoidance: { type: 'param-tune', params: {}, rationale: '' },
        occurrences: 0,
        avoidanceAdopted: 0,
        avoidanceSuccesses: 0,
        firstSeenAt: now,
        lastSeenAt: now,
      };
      kb.entries.set(id, entry);
    }
    entry.occurrences += 1;
    entry.errorCategory = errorCategory;
    entry.lastSeenAt = now;
    if (failed.modelId && !entry.implicatedModels.includes(failed.modelId)) entry.implicatedModels.push(failed.modelId);
    entry.avoidance = deriveAvoidanceAction(entry, failed.modelId);

    // 容量淘汰：满时剔除 occurrences 最低且最久未见者（高频失败模式永不被误杀）
    if (kb.entries.size > kb.maxEntries) {
      let victimId = id;
      let victimKey = `${entry.occurrences}::${entry.lastSeenAt}`;
      for (const [eid, e] of kb.entries) {
        const key = `${e.occurrences}::${e.lastSeenAt}`;
        if (key < victimKey) {
          victimKey = key;
          victimId = eid;
        }
      }
      kb.entries.delete(victimId);
    }

    this.broadcast({ type: 'failure-mode-captured', entryId: id, signature, occurrences: entry.occurrences, avoidance: entry.avoidance.type });
  }

  /**
   * R4-A6 升级 3：规避建议检索（计划下发前的失败知识消费；未挂载 undefined）。
   *
   * @param taskType 任务类型（必匹配——失败模式的作用域）
   * @param context.failedNodeType 失败节点类型（给定且匹配 → matchScore +0.2）
   * @param context.errorHint 错误线索文本（分类后与条目根因匹配 → matchScore +0.2）
   * @param limit 输出上限（缺省 3；按 occurrences × matchScore 降序）
   */
  avoidanceAdvice(
    taskType: string,
    context?: { failedNodeType?: string; errorHint?: string },
    limit = 3,
  ): AvoidanceAdvice[] | undefined {
    const kb = this.failureKnowledgeBase;
    if (!kb) return undefined;
    const hintCause = context?.errorHint !== undefined ? classifyFailureText(context.errorHint).rootCause : undefined;
    const advices: AvoidanceAdvice[] = [];
    for (const entry of kb.entries.values()) {
      if (entry.taskType !== taskType) continue;
      if (entry.occurrences < kb.minOccurrences) continue;
      const nodeTypeMatch = context?.failedNodeType !== undefined && context.failedNodeType === entry.failedNodeType;
      const hintMatch = hintCause !== undefined && hintCause === entry.rootCause;
      const matchScore = Math.min(1, 0.6 + (nodeTypeMatch ? 0.2 : 0) + (hintMatch ? 0.2 : 0));
      advices.push({
        entryId: entry.id,
        taskType: entry.taskType,
        signature: entry.signature,
        rootCause: entry.rootCause,
        errorCategory: entry.errorCategory,
        avoidance: entry.avoidance,
        occurrences: entry.occurrences,
        matchScore: Number(matchScore.toFixed(6)),
        ...(entry.avoidanceAdopted > 0 ? { effectiveness: Number((entry.avoidanceSuccesses / entry.avoidanceAdopted).toFixed(6)) } : {}),
        rationale: `${entry.taskType} 已在该模式失败 ${entry.occurrences} 次（${entry.rootCause}@${entry.failedNodeType}${entry.implicatedModels.length > 0 ? `，涉事 ${entry.implicatedModels.join('/')}` : ''}）：${entry.avoidance.rationale}`,
      });
    }
    return advices
      .sort((a, b) => b.occurrences * b.matchScore - a.occurrences * a.matchScore || (a.entryId < b.entryId ? -1 : 1))
      .slice(0, Math.max(1, limit));
  }

  /**
   * R4-A6 升级 3：规避建议采纳回填（编排层在采纳建议的任务结算后调用）。
   *
   * 采纳后成功 → avoidanceSuccesses++：规避有效性（effectiveness）从
   * 建议本身长出来——「同模式二次失败的建议采纳后确实成功了」第一次
   * 有了实测证据链。未挂载空操作。
   */
  noteAvoidanceAdopted(entryId: string, success: boolean): void {
    const kb = this.failureKnowledgeBase;
    if (!kb) return;
    const entry = kb.entries.get(entryId);
    if (!entry) return;
    entry.avoidanceAdopted += 1;
    if (success) entry.avoidanceSuccesses += 1;
  }

  /** R4-A6 升级 3：失败知识库视图（按 occurrences 降序；未挂载 undefined） */
  failureKnowledgeView(): FailureModeEntry[] | undefined {
    const kb = this.failureKnowledgeBase;
    if (!kb) return undefined;
    return [...kb.entries.values()]
      .sort((a, b) => b.occurrences - a.occurrences || (a.id < b.id ? -1 : 1))
      .map((e) => ({ ...e, implicatedModels: [...e.implicatedModels] }));
  }

  /** 70.0：PID 挂载标志（未挂载零介入） */
  private pidDiagnosticsEnabled = false;

  /**
   * 70.0：组合 PID 分解（未挂载返回 undefined）。
   * @param joint p(x₁,x₂,s) 三维联合分布表（内层 = 决策成败维度）
   */
  combinationPid(
    joint: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>,
  ): { pid: PidReport; oInformation?: OInfoReport } | undefined {
    if (!this.pidDiagnosticsEnabled) return undefined;
    try {
      return { pid: pidFromJoint(joint), oInformation: oInformation(joint as never) };
    } catch {
      return undefined; // 联合表规格非法 → 诚实降级
    }
  }

  /** 37.0：最近一次瓶颈定价读数（未挂载/未评估时 undefined） */
  getBottleneckView(): { retention: number; iXY: number; clusters: number; sampleCount: number } | undefined {
    return this.lastBottleneck ? { ...this.lastBottleneck } : undefined;
  }

  async distillKnowledge(options?: { force?: boolean }): Promise<DistillationReport> {    const now = Date.now();
    const minConfidence = this.config.distillMinConfidence ?? 0.6;
    const minSuccesses = this.config.distillMinSuccesses ?? 3;
    const affinityThreshold = this.config.distillModelAffinityThreshold ?? 0.6;
    const autoThreshold = this.config.autoDistillThreshold ?? 5;

    // ── 0. 水位门控：无新增样本且已有蒸馏知识 → 跳过全量蒸馏 ──
    if (!options?.force && !this.distilling) {
      const progress = this.memory.getDistillationProgress?.();
      const hasDistilledKnowledge =
        this.memory.getAllSemanticMemories().length > 0 || this.memory.getAllProceduralMemories().length > 0;
      if (progress && hasDistilledKnowledge && progress.pendingSinceLastDistillation < Math.max(1, autoThreshold)) {
        const skippedReport: DistillationReport = {
          distilledAt: now,
          sourceEpisodicCount: 0,
          semanticMemories: [],
          proceduralMemories: [],
          strategies: [],
          summary: `跳过蒸馏：新增情景事件 ${progress.pendingSinceLastDistillation} 未达阈值 ${Math.max(1, autoThreshold)}，既有知识无需刷新`,
          skipped: true,
          skipReason: 'below-threshold',
        };
        return skippedReport;
      }
      // ── 0.5 信息瓶颈门控（37.0）：水位达标但信息量不足 → 依然不蒸馏 ──
      // X = 任务位型（类型 × 质量档），Y = 成败结果；IB 压缩后的保留率
      // retention = I(T;Y)/I(X;Y) 是「这批样本携带多少值得蒸馏的新信息」
      // 的定价——同构样本水位再高也只产出重复知识（数据处理不等式的
      // 应用面）。未挂载 / 样本不足时本段零介入。
      if (this.bottleneck) {
        const patterns = this.memory.getAllTaskPatterns();
        const samples = patterns.flatMap((p) => {
          const total = p.successfulPlans.length + p.failureRecords.length;
          if (total === 0) return [];
          const qualityBucket = p.avgQualityScore >= 0.8 ? 'high-q' : p.avgQualityScore >= 0.6 ? 'mid-q' : 'low-q';
          const latencyBucket = p.avgExecutionTime >= 30_000 ? 'slow' : 'fast';
          const outcomes: Array<{ features: string[]; success: boolean }> = [];
          for (let k = 0; k < Math.min(total, 5); k += 1) {
            outcomes.push({ features: [p.taskSummary.slice(0, 12), qualityBucket, latencyBucket], success: k < p.successfulPlans.length });
          }
          return outcomes;
        });
        if (samples.length >= 8) {
          const report = distillRetention(samples, { beta: this.bottleneck.beta });
          this.lastBottleneck = { retention: report.retention, iXY: report.iXY, clusters: report.clusters, sampleCount: report.sampleCount };
          // 双门：绝对信息量（I(X;Y) < 0.05 nat——批次本身近乎无信息，
          // 此时的保留率是噪声过拟合）或保留率不足（同构于既有知识）
          if (report.iXY < 0.05 || report.retention < this.bottleneck.retentionFloor) {
            return {
              distilledAt: now,
              sourceEpisodicCount: 0,
              semanticMemories: [],
              proceduralMemories: [],
              strategies: [],
              summary: `跳过蒸馏：水位已达但信息瓶颈保留率 ${report.retention.toFixed(3)} < ${this.bottleneck.retentionFloor}（I(X;Y)=${report.iXY.toFixed(3)} nat，${report.sampleCount} 样本同构——值得蒸馏的新信息不足）`,
              skipped: true,
              skipReason: 'below-information',
            };
          }
        }
      }
    }

    // ── 并发防抖：蒸馏进行中直接返回空报告 ──
    if (this.distilling) {
      return {
        distilledAt: now,
        sourceEpisodicCount: 0,
        semanticMemories: [],
        proceduralMemories: [],
        strategies: [],
        summary: '跳过蒸馏：已有蒸馏任务进行中',
        skipped: true,
        skipReason: 'in-flight',
      };
    }

    this.distilling = true;
    try {
      // ── 1. 收集符合条件的情景记忆样本 ──
      const patterns = this.memory.getAllTaskPatterns();
      const qualifiedPatterns = patterns.filter(
        (p) => p.confidence >= minConfidence && p.successfulPlans.length >= minSuccesses,
      );
      const sourceEpisodicCount = qualifiedPatterns.length;

      // ── 2. 兼容：调用既有 distillExperience 产出 DistilledStrategy ──
      const strategies = this.memory.distillExperience(minConfidence);

      // ── 3. 蒸馏语义记忆：模型亲和规律 ──
      const semanticMemories: SemanticMemory[] = [];
      semanticMemories.push(...this.distillModelAffinity(qualifiedPatterns, affinityThreshold, now));
      semanticMemories.push(...this.distillComplexityPatterns(qualifiedPatterns, now));

      // ── 4. 蒸馏程序记忆：调度规则 + 反思规则 ──
      const proceduralMemories: ProceduralMemory[] = [];
      proceduralMemories.push(...this.distillSchedulingRules(qualifiedPatterns, now));
      proceduralMemories.push(...this.distillReflectionRules(now));

      // ── 5. 写入记忆库（第二阶段升级：证据合并 / 冲突取代） ──
      let mergedSemanticCount = 0;
      let mergedProceduralCount = 0;
      let supersededCount = 0;
      const writtenSemantic: SemanticMemory[] = [];
      for (const mem of semanticMemories) {
        const result = this.memory.upsertSemanticMemory(mem);
        if (result === 'merged') {
          mergedSemanticCount += 1;
          // 报告携带合并后的库内版本（含累加后的支撑度）
          writtenSemantic.push(this.memory.getAllSemanticMemories().find((m) => m.id === mem.id) ?? mem);
        } else if (result === 'superseded') {
          supersededCount += 1;
          writtenSemantic.push(mem);
        } else if (result !== 'duplicate') {
          writtenSemantic.push(mem);
        }
      }
      const writtenProcedural: ProceduralMemory[] = [];
      for (const proc of proceduralMemories) {
        const result = this.memory.upsertProceduralMemory(proc);
        if (result === 'merged') {
          mergedProceduralCount += 1;
          writtenProcedural.push(this.memory.getAllProceduralMemories().find((p) => p.id === proc.id) ?? proc);
        } else if (result === 'superseded') {
          supersededCount += 1;
          writtenProcedural.push(proc);
        } else if (result !== 'duplicate') {
          writtenProcedural.push(proc);
        }
      }

      // ── 6. 记忆图挂载（语义/程序记忆与源模式建立共现边） ──
      if (this.graph) {
        for (const mem of writtenSemantic) {
          this.graph.ensureNode(mem.id, 'semantic', mem.statement);
          for (const fp of mem.sourceFingerprints) {
            this.graph.ensureNode(fp, 'pattern', fp);
            this.graph.link(fp, mem.id);
          }
        }
        for (const proc of writtenProcedural) {
          this.graph.ensureNode(proc.id, 'procedural', proc.name);
          for (const fp of proc.sourceFingerprints) {
            this.graph.ensureNode(fp, 'pattern', fp);
            this.graph.link(fp, proc.id);
          }
        }
      }

      // ── 7. 构建摘要 ──
      const summary = this.buildDistillationSummary(sourceEpisodicCount, writtenSemantic, writtenProcedural, strategies);
      const summaryWithMerge =
        mergedSemanticCount + mergedProceduralCount + supersededCount > 0
          ? `${summary}\n证据合并：语义 ${mergedSemanticCount} 条 / 程序 ${mergedProceduralCount} 条；冲突取代 ${supersededCount} 条`
          : summary;

      // ── 8. 蒸馏成功：刷新水位（下次阈值触发以此为基准） ──
      this.memory.noteDistillationCheckpoint?.();

      this.broadcast({
        type: 'knowledge-distilled',
        sourceEpisodicCount,
        semanticCount: writtenSemantic.length,
        proceduralCount: writtenProcedural.length,
        strategyCount: strategies.length,
        mergedSemanticCount,
        mergedProceduralCount,
        supersededCount,
      });

      const report: DistillationReport = {
        distilledAt: now,
        sourceEpisodicCount,
        semanticMemories: writtenSemantic,
        proceduralMemories: writtenProcedural,
        strategies,
        summary: summaryWithMerge,
        mergedSemanticCount,
        mergedProceduralCount,
        supersededCount,
      };
      this.config.onKnowledgeDistilled?.(report);
      return report;
    } finally {
      this.distilling = false;
    }
  }

  /**
   * 内容寻址稳定 id（第二阶段升级）
   *
   * 同一规律（相同组成要素）跨次蒸馏生成相同 id，使 upsert 的证据合并
   * 能命中既有记录，而非每次插入新 id 后靠 statement 判重丢弃证据。
   */
  private stableId(prefix: string, ...parts: Array<string | number>): string {
    const hash = crypto.createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 12);
    return `${prefix}-${hash}`;
  }

  /**
   * 蒸馏模型亲和规律（语义记忆 domain='model-affinity'）
   *
   * 按 taskType 聚合所有合格模式中的模型分配，若某模型占比 ≥ affinityThreshold
   * 且支撑模式数 ≥ 2，则产出跨任务规律："X 类任务适合模型 Y"。
   */
  private distillModelAffinity(
    patterns: TaskPatternMemory[],
    affinityThreshold: number,
    now: number,
  ): SemanticMemory[] {
    const result: SemanticMemory[] = [];
    // 按 taskType 聚合模型分配
    const byTaskType = new Map<string, { patterns: TaskPatternMemory[]; modelWins: Map<string, number>; total: number }>();
    for (const pattern of patterns) {
      const taskType = this.extractTaskType(pattern);
      const bucket = byTaskType.get(taskType) ?? { patterns: [], modelWins: new Map<string, number>(), total: 0 };
      bucket.patterns.push(pattern);
      for (const plan of pattern.successfulPlans) {
        for (const modelId of Object.values(plan.modelAssignments)) {
          bucket.modelWins.set(modelId, (bucket.modelWins.get(modelId) ?? 0) + 1);
          bucket.total += 1;
        }
      }
      byTaskType.set(taskType, bucket);
    }

    for (const [taskType, bucket] of byTaskType) {
      if (bucket.patterns.length < 2 || bucket.total === 0) continue;
      for (const [modelId, wins] of bucket.modelWins) {
        const ratio = wins / bucket.total;
        if (ratio >= affinityThreshold) {
          const statement = `${taskType} 类任务适合模型 ${modelId}（跨 ${bucket.patterns.length} 个模式占比 ${(ratio * 100).toFixed(0)}%）`;
          const conditions: SemanticCondition[] = [
            { dimension: 'task-type', operator: 'eq', value: taskType },
          ];
          const conclusion: SemanticConclusion = {
            type: 'model-preference',
            value: modelId,
            rationale: `在 ${bucket.patterns.length} 个高置信度模式中占比 ${(ratio * 100).toFixed(0)}%（${wins}/${bucket.total} 次成功分配）`,
          };
          result.push({
            id: this.stableId('sem-ma', taskType, modelId),
            domain: 'model-affinity',
            statement,
            taskTypes: [taskType],
            conditions,
            conclusion,
            confidence: Math.min(0.95, ratio * 0.9 + 0.1),
            supportCount: wins,
            sourceFingerprints: bucket.patterns.map((p) => p.fingerprint),
            distilledAt: now,
            appliedTotal: 0,
            appliedSuccesses: 0,
          });
        }
      }
    }
    return result;
  }

  /**
   * 蒸馏复杂度模式（语义记忆 domain='complexity-pattern'）
   *
   * 高复杂度（complexity ≥ 0.7）任务的成功模型偏好。
   */
  private distillComplexityPatterns(patterns: TaskPatternMemory[], now: number): SemanticMemory[] {
    const result: SemanticMemory[] = [];
    const highComplexity = patterns.filter((p) => {
      const complexity = Number(p.fingerprint.split('::')[1] ?? 0);
      return complexity >= 0.7;
    });
    if (highComplexity.length < 2) return result;

    const modelWins = new Map<string, number>();
    let total = 0;
    for (const pattern of highComplexity) {
      for (const plan of pattern.successfulPlans) {
        for (const modelId of Object.values(plan.modelAssignments)) {
          modelWins.set(modelId, (modelWins.get(modelId) ?? 0) + 1);
          total += 1;
        }
      }
    }
    if (total === 0) return result;

    for (const [modelId, wins] of modelWins) {
      const ratio = wins / total;
      if (ratio >= 0.6) {
        const statement = `高复杂度任务适合模型 ${modelId}（${highComplexity.length} 个高复杂度模式占比 ${(ratio * 100).toFixed(0)}%）`;
        result.push({
          id: this.stableId('sem-cp', modelId),
          domain: 'complexity-pattern',
          statement,
          taskTypes: [], // 跨任务通用
          conditions: [{ dimension: 'complexity', operator: 'gte', value: 0.7 }],
          conclusion: {
            type: 'model-preference',
            value: modelId,
            rationale: `高复杂度（≥0.7）任务中占比 ${(ratio * 100).toFixed(0)}%（${wins}/${total}）`,
          },
          confidence: Math.min(0.9, ratio * 0.85),
          supportCount: wins,
          sourceFingerprints: highComplexity.map((p) => p.fingerprint),
          distilledAt: now,
          appliedTotal: 0,
          appliedSuccesses: 0,
        });
      }
    }
    return result;
  }

  /**
   * 蒸馏调度规则（程序记忆 kind='scheduling'）
   *
   * 规则：feature='code' 且 complexity ≥ 0.7 的任务 → prefer-model + enable-cot
   * 支撑：该任务类型的成功方案中存在模型偏好。
   */
  private distillSchedulingRules(patterns: TaskPatternMemory[], now: number): ProceduralMemory[] {
    const result: ProceduralMemory[] = [];
    for (const pattern of patterns) {
      const features = (pattern.fingerprint.split('::')[2] ?? '').split(',').filter(Boolean);
      const complexity = Number(pattern.fingerprint.split('::')[1] ?? 0);
      const taskType = this.extractTaskType(pattern);
      if (!features.includes('code') || complexity < 0.7) continue;

      // 统计该模式的最优模型
      const modelWins = new Map<string, number>();
      for (const plan of pattern.successfulPlans) {
        for (const modelId of Object.values(plan.modelAssignments)) {
          modelWins.set(modelId, (modelWins.get(modelId) ?? 0) + 1);
        }
      }
      let bestModel = '';
      let bestWins = 0;
      for (const [modelId, wins] of modelWins) {
        if (wins > bestWins) {
          bestWins = wins;
          bestModel = modelId;
        }
      }
      if (!bestModel || bestWins < 2) continue;

      const conditions: ProceduralCondition[] = [
        { dimension: 'task-type', operator: 'eq', value: taskType },
        { dimension: 'feature', operator: 'contains', value: 'code' },
        { dimension: 'complexity', operator: 'gte', value: 0.7 },
      ];
      const action: ProceduralAction = {
        type: 'prefer-model',
        params: { model: bestModel, cot: true },
        rationale: `长代码任务在 ${bestModel} + CoT 下成功率更高（${bestWins}/${pattern.successfulPlans.length} 次成功）`,
      };
      // 同时附加 enable-cot 动作（通过单独的程序记忆条目，避免动作合取）
      result.push({
        id: this.stableId('proc-sched', taskType, 'prefer', bestModel),
        kind: 'scheduling',
        name: `${taskType} 长代码任务偏好模型 ${bestModel}`,
        taskTypes: [taskType],
        conditions,
        action,
        confidence: Math.min(0.9, pattern.confidence * 0.95),
        supportCount: bestWins,
        sourceFingerprints: [pattern.fingerprint],
        distilledAt: now,
        appliedTotal: 0,
        appliedSuccesses: 0,
      });
      result.push({
        id: this.stableId('proc-sched', taskType, 'cot'),
        kind: 'scheduling',
        name: `${taskType} 长代码任务启用思维链`,
        taskTypes: [taskType],
        conditions,
        action: {
          type: 'enable-cot',
          params: { model: bestModel },
          rationale: `长代码任务启用 CoT 可提升结构化输出质量`,
        },
        confidence: Math.min(0.85, pattern.confidence * 0.9),
        supportCount: bestWins,
        sourceFingerprints: [pattern.fingerprint],
        distilledAt: now,
        appliedTotal: 0,
        appliedSuccesses: 0,
      });
    }
    return result;
  }

  /**
   * 蒸馏反思规则（程序记忆 kind='reflection'）
   *
   * 从反思教训中提炼：rootCause='timeout' → avoid-model + escalate
   * rootCause='model-capability' → avoid-model + retry-switch
   */
  private distillReflectionRules(now: number): ProceduralMemory[] {
    const result: ProceduralMemory[] = [];
    const lessons = this.reflection.getAllLessons();
    // 按 taskType + rootCause 聚合
    const byKey = new Map<string, { taskType: string; rootCause: string; modelIds: Set<string>; count: number }>();
    for (const lesson of lessons) {
      const key = `${lesson.taskType}::${lesson.rootCause}`;
      const bucket = byKey.get(key) ?? { taskType: lesson.taskType, rootCause: lesson.rootCause, modelIds: new Set<string>(), count: 0 };
      bucket.count += 1;
      // 从 lesson 文本中提取模型 id（启发式：匹配 "模型 X" 模式）
      const modelMatch = lesson.lesson.match(/模型\s+(\S+)/);
      if (modelMatch) bucket.modelIds.add(modelMatch[1]!);
      byKey.set(key, bucket);
    }

    for (const [, bucket] of byKey) {
      if (bucket.count < 2) continue; // 至少 2 次同类教训才蒸馏为规则
      for (const modelId of bucket.modelIds) {
        const conditions: ProceduralCondition[] = [
          { dimension: 'task-type', operator: 'eq', value: bucket.taskType },
          { dimension: 'root-cause', operator: 'eq', value: bucket.rootCause },
        ];
        const avoidAction: ProceduralAction =
          bucket.rootCause === 'timeout'
            ? {
                type: 'avoid-model',
                params: { model: modelId },
                rationale: `${bucket.taskType} 在 ${modelId} 上累计 ${bucket.count} 次超时，应规避`,
              }
            : {
                type: 'avoid-model',
                params: { model: modelId },
                rationale: `${bucket.taskType} 在 ${modelId} 上累计 ${bucket.count} 次能力不足，应换模型`,
              };
        result.push({
          id: this.stableId('proc-refl', bucket.taskType, bucket.rootCause, modelId),
          kind: 'reflection',
          name: `${bucket.taskType} ${bucket.rootCause} 时规避模型 ${modelId}`,
          taskTypes: [bucket.taskType],
          conditions,
          action: avoidAction,
          confidence: Math.min(0.85, 0.5 + bucket.count * 0.1),
          supportCount: bucket.count,
          sourceFingerprints: [],
          distilledAt: now,
          appliedTotal: 0,
          appliedSuccesses: 0,
        });
      }
    }
    return result;
  }

  /** 从模式指纹提取 taskType（首段，去除 [失败] 前缀） */
  private extractTaskType(pattern: TaskPatternMemory): string {
    return pattern.fingerprint.split('::')[0]?.replace(/^\[失败\]\s*/, '') || 'general';
  }

  /** 构建蒸馏报告摘要 */
  private buildDistillationSummary(
    sourceCount: number,
    semantic: SemanticMemory[],
    procedural: ProceduralMemory[],
    strategies: DistilledStrategy[],
  ): string {
    const lines = [
      `知识蒸馏完成：来源情景记忆 ${sourceCount} 条`,
      `产出语义记忆 ${semantic.length} 条${semantic.length > 0 ? `（${semantic.map((m) => m.statement).join('；')}）` : ''}`,
      `产出程序记忆 ${procedural.length} 条${procedural.length > 0 ? `（${procedural.map((p) => p.name).join('；')}）` : ''}`,
      `产出蒸馏策略 ${strategies.length} 条（兼容）`,
    ];
    return lines.join('\n');
  }

  /** 经验沉淀：成功方案 / 失败记录写入记忆库并登记同步变更 */
  private settleExperience(signal: Signal, plan: ExecutionPlan, result: PlanExecutionResult): void {
    const taskType = plan.nodes[0]?.type ?? signal.type;
    const complexity = Math.min(1, plan.nodes.length / 5);
    const features = [...new Set(plan.nodes.map((n) => n.type))];
    const taskSummary = signal.description;

    if (result.success) {
      const modelAssignments: Record<string, string> = {};
      const qualityScores: Record<string, number> = {};
      for (const nodeResult of result.nodeResults) {
        modelAssignments[nodeResult.nodeId] = nodeResult.modelId;
        qualityScores[nodeResult.nodeId] = nodeResult.quality;
      }
      this.memory.recordSuccess({
        taskType,
        complexity,
        features,
        taskSummary,
        plan: { objective: plan.objective, nodes: plan.nodes.map((n) => ({ id: n.id, description: n.description, type: n.type, dependsOn: n.dependsOn })), parallelismStrategy: plan.parallelismStrategy },
        modelAssignments,
        totalLatency: result.totalTime,
        qualityScores,
        tokenCost: result.totalTokens,
      });
      this.onMemoryChange?.('pattern-updated', fingerprintOf(taskType, complexity), { taskType, complexity, outcome: 'success' });
    } else {
      const failed = result.nodeResults.find((r) => !r.success);
      this.memory.recordFailure({
        taskType,
        complexity,
        features,
        reason: failed?.error ?? '计划执行失败',
        failedNodeId: failed?.nodeId ?? 'unknown',
        failedModelId: failed?.modelId ?? 'unknown',
        errorMessage: failed?.error ?? 'unknown',
      });
      this.onMemoryChange?.('pattern-updated', fingerprintOf(taskType, complexity), { taskType, complexity, outcome: 'failure' });
    }
  }

  /** 进度事件广播（enableProgress 关闭或 broadcaster 缺省时为空操作） */
  private broadcast(event: Record<string, any>): void {
    if (this.config.enableProgress === false || !this.broadcaster) return;
    this.broadcaster.broadcast({ type: event.type as string, timestamp: Date.now(), ...event });
  }
}

/** 任务指纹（taskType + complexity 分档，同步变更登记的稳定键） */
function fingerprintOf(taskType: string, complexity: number): string {
  return crypto.createHash('sha256').update(`${taskType}:${Math.round(complexity * 10)}`).digest('hex').slice(0, 16);
}

// ───────────────────── 第四轮 R4-A6 失败知识库的文件级工具（确定性） ─────────────────────

/**
 * 失败文本 → 错误类目 + 根因（与反思引擎规则化兜底同口径的关键词分类；
 * 确定性、零依赖——失败知识库的同步沉淀不能等异步教训提取）
 */
function classifyFailureText(error: string | undefined): { errorCategory: FailureErrorCategory; rootCause: FailureModeEntry['rootCause'] } {
  const err = (error ?? '').toLowerCase();
  if (err.includes('超时') || err.includes('timeout')) return { errorCategory: 'timeout', rootCause: 'timeout' };
  if (err.includes('质量不达标') || err.includes('质量不足')) return { errorCategory: 'quality', rootCause: 'model-capability' };
  if (err.includes('依赖')) return { errorCategory: 'dependency', rootCause: 'dependency' };
  return { errorCategory: 'transient', rootCause: 'transient' };
}

/** 规避动作推导（根因 × 重复次数——确定性规则；超时二次起升级为规避模型） */
function deriveAvoidanceAction(entry: FailureModeEntry, failedModelId: string | undefined): ProceduralAction {
  switch (entry.rootCause) {
    case 'timeout':
      return entry.occurrences >= 2 && failedModelId
        ? {
            type: 'avoid-model',
            params: { model: failedModelId },
            rationale: `${entry.taskType} 在 ${failedModelId} 上累计 ${entry.occurrences} 次超时——调参救不了，直接规避该模型`,
          }
        : {
            type: 'param-tune',
            params: { param: 'timeoutMultiplier', value: 2 },
            rationale: `${entry.taskType} 首次超时——节点超时上限放大 2 倍再观察`,
          };
    case 'model-capability':
      return failedModelId
        ? {
            type: 'avoid-model',
            params: { model: failedModelId },
            rationale: `${failedModelId} 对 ${entry.taskType} 质量不足（能力短板非瞬时故障）——换能力更强的模型`,
          }
        : {
            type: 'param-tune',
            params: { param: 'maxRetries', value: 2 },
            rationale: `${entry.taskType} 质量不足且涉事模型未知——有限重试后升级人工`,
          };
    case 'dependency':
      return {
        type: 'param-tune',
        params: { param: 'verifyUpstream', value: true },
        rationale: '上游产出质量亏空传导——下游执行前先校验上游产物',
      };
    default:
      return {
        type: 'param-tune',
        params: { param: 'maxRetries', value: 2 },
        rationale: '瞬时故障——有限重试（超过 2 次仍失败再深挖根因）',
      };
  }
}
