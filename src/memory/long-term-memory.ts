/**
 * long-term-memory.ts — 跨会话长期记忆引擎（基础层）
 *
 * 职责：
 * - 任务模式记忆（TaskPatternMemory）：相似任务的成功方案沉淀与检索
 * - 模型长期画像（ModelLongTermProfile）：按任务类型统计成功率/延迟/质量/成本
 * - 决策反馈（DecisionFeedback）：信号决策的结果复盘与经验教训
 * - 全局统计（globalStats）：执行总量、成功率、token 消耗、成本估算
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 模糊经验匹配：findPattern 不再要求指纹精确命中，而是按
 *    taskType 相似度 + complexity 距离 + features 重叠度加权打分，
 *    返回置信度最高的模式（含最低相似度门槛）
 * 2. 防抖持久化 + 原子写入 + 进程退出兜底 flush，杜绝记忆丢失
 * 3. 与 CryptoEngine 无缝集成，持久化形态自动适配加密配置
 * 4. 模型画像自动推导 bestTaskType / worstTaskType / stability
 * 5. 模式置信度动态演化：成功加分、失败扣分，衰减由频率驱动
 * 6. 对冲机制（防止"越学越错"，缺一不可）：
 *    - 遗忘曲线（applyForgettingCurve）：幂等衰减，以 lastDecayAt 为基准，
 *      多次维护调用不复合叠加；长期未用模式降置信直至彻底遗忘
 *    - 置信度衰减：覆盖任务模式与蒸馏策略两类记忆（策略以 lastAppliedAt 为基准），
 *      长期未被应用/验证的策略同样衰减直至清除
 *    - 阈值自校准：委托反思引擎（reflection-engine.calibrateThreshold），
 *      质量分布偏高收紧、偏低放宽，避免无效重试风暴
 */

import fs from 'node:fs';
import type { CryptoEngine } from '../security/crypto-engine.js';
import { createMemoryBackend, sanitizeMemoryStore, segment } from './backend.js';
import type { MemoryBackend } from './backend.js';
import type { IMemoryStore } from '../contracts.js';
import { BAYES_PRIOR_STRENGTH, DECAY_HALF_LIFE_DAYS, LEGACY_EVIDENCE_DISCOUNT, type MemoryEvidence, evidenceRankScore, initEvidence, observeEvidence, readEvidence, wilsonLowerBound } from '../core/evidence.js';
// 创世纪 60.0/68.0：率失真压缩规划（影子价格 KPI）/ NCD 近邻查重
import { planMemoryCompression } from '../engines-frontier/genesis25.js';

// 第二轮创世纪 98.0：经验重放（睡眠固化——白天经验离线固化成策略改进）
import { ReplayConsolidator, type SleepResult } from '../engines-frontier/autonomy25.js';
import type { CompressionPlan } from '../core/rate-distortion.js';
import { ncd, ncdTriangleAudit, type NcdTriangleAudit } from '../core/compression-distance.js';

// 3.0：统计内核迁至 core/evidence.ts（全层共享），此处再导出保持既有导入路径兼容
export { wilsonLowerBound, DECAY_HALF_LIFE_DAYS, BAYES_PRIOR_STRENGTH } from '../core/evidence.js';

/** 成功执行记录 */
export interface SuccessfulPlanRecord {
  timestamp: number;
  plan: {
    objective: string;
    nodes: Array<{ id: string; description: string; type: string; dependsOn: string[] }>;
    parallelismStrategy: string;
  };
  modelAssignments: Record<string, string>;
  totalLatency: number;
  qualityScores: Record<string, number>;
  tokenCost: number;
}

/** 失败记录 */
export interface FailureRecord {
  timestamp: number;
  reason: string;
  failedNodeId: string;
  failedModelId: string;
  errorMessage: string;
}

/** 任务模式记忆 */
export interface TaskPatternMemory {
  fingerprint: string;
  taskSummary: string;
  frequency: number;
  firstSeenAt: number;
  lastSeenAt: number;
  successfulPlans: SuccessfulPlanRecord[];
  failureRecords: FailureRecord[];
  confidence: number;
  bestModelCombination?: Record<string, string>;
  avgExecutionTime: number;
  avgQualityScore: number;
  /** 上次遗忘曲线衰减的时间戳（幂等衰减基准；缺省视为 lastSeenAt） */
  lastDecayAt?: number;
}

/** 模型单任务类型统计（2.0：含时间加权贝叶斯证据，旧持久化缺省字段自动回退裸计数） */
export interface ModelTaskStats {
  totalCalls: number;
  successCount: number;
  totalLatency: number;
  totalQualityScore: number;
  avgQualityScore: number;
  lastCalledAt: number;
  /** 2.0：时间加权成功计数（半衰期 decayHalfLifeDays，写入时惰性衰减累积） */
  weightedSuccesses?: number;
  /** 2.0：时间加权失败计数 */
  weightedFailures?: number;
  /** 2.0：成功执行质量的指数滑动均值（α=0.3，感知质量漂移） */
  emaQuality?: number;
  /** 2.0：上次时间衰减基准时间戳 */
  lastDecayedAt?: number;
}

/** 模型长期画像 */
export interface ModelLongTermProfile {
  id: string;
  name: string;
  taskHistory: Record<string, ModelTaskStats>;
  costEfficiency: Record<string, number>;
  bestTaskType: string;
  worstTaskType: string;
  stability: number;
}

/** 决策反馈 */
export interface DecisionFeedback {
  id: string;
  timestamp: number;
  signalType: string;
  signalDescription: string;
  decision: string;
  outcome: 'excellent' | 'good' | 'acceptable' | 'poor' | 'failed';
  outcomeReason: string;
  lesson?: string;
  /** 2.0：决策归因——本次实际选用的模型（校准与反事实分析的数据基础） */
  chosenModelId?: string;
  /** 2.0：调度时预测的成功概率（反思器据此计算校准误差） */
  predictedConfidence?: number;
  /** 2.0：本次是否为探索性选择（UCB 加成胜出） */
  exploration?: boolean;
}

/**
 * 贝叶斯能力估计（2.0：模型 × 任务类型的 Beta 后验推断）
 *
 * 设计动机——裸计数的三个盲区：
 * 1. 无不确定性：3 次全成与 300 次全成同置信 → Wilson 下界按样本量保守折价
 * 2. 无时效：半年前的成功与今天的成功等权 → 时间加权计数让近期证据主导
 * 3. 无漂移感知：模型能力变化（升级/降级）无法察觉 → drift = 加权成功率 - 裸成功率
 */
export interface BayesianEstimate {
  modelId: string;
  taskType: string;
  /** Beta 后验参数（含均匀先验 Beta(1,1)） */
  alpha: number;
  beta: number;
  /** 后验均值 = (α)/(α+β)，调度预测置信度来源 */
  posteriorMean: number;
  /** Wilson 95% 置信下界（小样本自动保守，利用端评分依据） */
  wilsonLower: number;
  /** 有效样本量 = weightedSuccesses + weightedFailures（衰减后的等效观测数） */
  effectiveSamples: number;
  /** 裸成功率（对照基准） */
  rawSuccessRate: number;
  /** 近期漂移 = 加权成功率 - 裸成功率（>0 近期更好，<0 近期变差；有效样本 <2 时恒 0） */
  drift: number;
  /** 成功执行质量 EMA（无成功记录时为 0） */
  emaQuality: number;
}

/**
 * Wilson 置信下界：实现迁至 core/evidence.ts（3.0 全层共享），
 * 经文件顶部再导出保持既有导入路径（dist/index.mjs 根导出）兼容。
 */

/** 蒸馏策略（经验蒸馏产物：从成功方案中提炼的可复用决策规则） */
export interface DistilledStrategy {
  id: string;
  taskType: string;
  /** 策略描述（如"documentation 类任务优先使用 model-b"） */
  description: string;
  /** 提炼依据的模式指纹 */
  sourceFingerprint: string;
  /** 支撑该策略的成功次数 */
  supportCount: number;
  /** 策略置信度 0~1 */
  confidence: number;
  distilledAt: number;
  /** 应用该策略后的成功次数（反馈闭环） */
  appliedSuccesses: number;
  appliedTotal: number;
  /** 上次被应用/验证的时间戳（置信度衰减基准；缺省视为 distilledAt） */
  lastAppliedAt?: number;
  /**
   * 3.0：时间加权 Beta 证据（并行旁路——不改变 confidence 语义，
   * 供证据化排序 / 证据普查 / 自知之明报告消费；旧格式缺省视为无证据）
   */
  evidence?: MemoryEvidence;
}

// ─────────────────────────── 三层记忆扩展（第二阶段） ───────────────────────────
//
// 第二阶段在情景记忆（TaskPatternMemory / DecisionFeedback）之上新增两层抽象记忆：
// - 语义记忆（SemanticMemory）：从情景记忆抽象出的跨任务规律
// - 程序记忆（ProceduralMemory）：带触发条件的可执行 if-then 规则
//
// 与既有 DistilledStrategy 共存而非替换：
// DistilledStrategy 仍是面向"模型偏好 / 并行策略"的轻量规则，被同步变更登记、
// 反馈闭环等已验证链路消费；程序记忆承载更丰富的条件+动作结构（启用思维链、
// 避免某模型、参数微调等），供优化器在 lookupExperience 中按条件匹配优先采纳。

/** 语义记忆条件维度 */
export type SemanticConditionDimension = 'task-type' | 'feature' | 'complexity' | 'length' | 'token-cost';

/** 语义记忆条件（与程序记忆条件结构一致，类型独立以便演进） */
export interface SemanticCondition {
  dimension: SemanticConditionDimension;
  operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';
  value: string | number | string[];
}

/** 语义记忆结论 */
export interface SemanticConclusion {
  /** 结论类型：模型偏好 / 并行策略 / 参数微调 */
  type: 'model-preference' | 'parallelism-strategy' | 'parameter-tuning';
  /** 推荐值（按 type 解释：model id / strategy name / 参数字典） */
  value: string | number | boolean | Record<string, string>;
  /** 结论理由 */
  rationale: string;
}

/**
 * 语义记忆：从情景记忆中抽象出的跨任务规律
 *
 * 例如：domain='model-affinity'，statement='长文本代码任务适合模型A'，
 * conditions=[{dimension:'feature',op:'contains',value:'code'},{dimension:'length',op:'gt',value:10000}]，
 * conclusion={type:'model-preference', value:'model-a', rationale:'占比 75% 成功'}。
 */
export interface SemanticMemory {
  id: string;
  /** 规律主题：模型亲和 / 特征关联 / 复杂度模式 / 跨任务趋势 */
  domain: 'model-affinity' | 'feature-correlation' | 'complexity-pattern' | 'cross-task-trend';
  /** 人类可读规律陈述 */
  statement: string;
  /** 适用任务类型集合（空表示跨任务通用） */
  taskTypes: string[];
  /** 结构化条件（合取） */
  conditions: SemanticCondition[];
  /** 结构化结论 */
  conclusion: SemanticConclusion;
  /** 置信度 0~1 */
  confidence: number;
  /** 支撑样本数 */
  supportCount: number;
  /** 溯源情景记忆指纹 */
  sourceFingerprints: string[];
  distilledAt: number;
  /** 反馈闭环 */
  appliedTotal: number;
  appliedSuccesses: number;
  lastAppliedAt?: number;
  /** 幂等衰减基准（缺省视为 distilledAt） */
  lastDecayAt?: number;
  /** 3.0：时间加权 Beta 证据（并行旁路，同 DistilledStrategy.evidence） */
  evidence?: MemoryEvidence;
  /**
   * 第四轮：仲裁地位（缺省 active）。冲突仲裁的败方降级为「历史观点」
   * （status='historical'）——检索层不再采纳，但记录保留可查（不删除）。
   */
  status?: 'active' | 'historical';
  /** 第四轮：降级审计（败方专属：何时被谁以多少分差击败——翻转可解释） */
  demotedBy?: { at: number; winnerId: string; winnerScore: number; loserScore: number };
}

/** 程序记忆条件维度（含 outcome/root-cause，用于反思规则） */
export type ProceduralConditionDimension =
  | 'task-type'
  | 'feature'
  | 'complexity'
  | 'length'
  | 'token-cost'
  | 'outcome'
  | 'root-cause';

/** 程序记忆条件 */
export interface ProceduralCondition {
  dimension: ProceduralConditionDimension;
  operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';
  value: string | number | string[];
}

/** 程序记忆动作 */
export interface ProceduralAction {
  /**
   * 动作类型：
   * - prefer-model / avoid-model：偏好或规避某模型
   * - enable-cot：启用思维链
   * - parallelism：指定并行策略
   * - param-tune：参数微调（如 timeout）
   * - escalate：升级为 ask-user
   */
  type: 'prefer-model' | 'avoid-model' | 'enable-cot' | 'parallelism' | 'param-tune' | 'escalate';
  /** 动作参数（按 type 解释） */
  params: Record<string, string | number | boolean>;
  /** 理由 */
  rationale: string;
}

/**
 * 程序记忆：带触发条件的可执行 if-then 规则
 *
 * 例如：name='长代码任务启用思维链并偏好模型A'，
 * conditions=[{dimension:'feature',op:'contains',value:'code'},{dimension:'length',op:'gt',value:10000}]，
 * action={type:'enable-cot', params:{model:'model-a'}, rationale:'长代码任务在 model-a + CoT 下成功率提升 40%'}。
 *
 * kind='scheduling' 由优化器消费；kind='reflection' 由反思器消费（如"超时根因→直接换模型"）。
 */
export interface ProceduralMemory {
  id: string;
  /** 规则类别：调度策略 / 反思规则 */
  kind: 'scheduling' | 'reflection';
  /** 规则名称 */
  name: string;
  /** 适用任务类型（空表示通用） */
  taskTypes: string[];
  /** 触发条件（合取：全部满足才触发） */
  conditions: ProceduralCondition[];
  /** 触发动作 */
  action: ProceduralAction;
  /** 置信度 0~1 */
  confidence: number;
  /** 支撑样本数 */
  supportCount: number;
  /** 溯源情景记忆指纹 */
  sourceFingerprints: string[];
  distilledAt: number;
  /** 反馈闭环 */
  appliedTotal: number;
  appliedSuccesses: number;
  lastAppliedAt?: number;
  /** 幂等衰减基准（缺省视为 distilledAt） */
  lastDecayAt?: number;
  /** 3.0：时间加权 Beta 证据（并行旁路，同 DistilledStrategy.evidence） */
  evidence?: MemoryEvidence;
  /** 第四轮：仲裁地位（同 SemanticMemory.status——败方降历史不删除） */
  status?: 'active' | 'historical';
  /** 第四轮：降级审计（同 SemanticMemory.demotedBy） */
  demotedBy?: { at: number; winnerId: string; winnerScore: number; loserScore: number };
}

/** 蒸馏报告（distillKnowledge 产物） */
export interface DistillationReport {
  distilledAt: number;
  /** 参与蒸馏的情景记忆样本数 */
  sourceEpisodicCount: number;
  /** 新增/更新的语义记忆 */
  semanticMemories: SemanticMemory[];
  /** 新增/更新的程序记忆 */
  proceduralMemories: ProceduralMemory[];
  /** 兼容字段：本次产出的 DistilledStrategy（来自既有 distillExperience） */
  strategies: DistilledStrategy[];
  /** 人类可读摘要 */
  summary: string;
  // ── 第二阶段升级：增量蒸馏与证据合并可观测性 ──
  /** 水位不足跳过蒸馏时为 true（此时各产物数组为空） */
  skipped?: boolean;
  /** 跳过原因（'below-threshold' 等） */
  skipReason?: string;
  /** 本次通过证据合并增强的语义记忆数（duplicate 不再丢弃证据） */
  mergedSemanticCount?: number;
  /** 本次通过证据合并增强的程序记忆数 */
  mergedProceduralCount?: number;
  /** 本次冲突消解中被新证据取代的旧规律数 */
  supersededCount?: number;
}

/** 记忆库持久化结构 */
export interface MemoryStore {
  version: number;
  createdAt: number;
  lastUpdatedAt: number;
  taskPatterns: TaskPatternMemory[];
  modelProfiles: ModelLongTermProfile[];
  decisionFeedback: DecisionFeedback[];
  /** 蒸馏策略库（经验蒸馏产物） */
  distilledStrategies: DistilledStrategy[];
  /** 语义记忆库（第二阶段：跨任务规律） */
  semanticMemories: SemanticMemory[];
  /** 程序记忆库（第二阶段：if-then 可执行规则） */
  proceduralMemories: ProceduralMemory[];
  globalStats: {
    totalExecutions: number;
    totalSuccesses: number;
    totalFailures: number;
    totalTokensUsed: number;
    totalCostEstimate: number;
    averageQualityScore: number;
    averageExecutionTime: number;
    /** 第二阶段升级：上次知识蒸馏完成时的情景事件计数（阈值触发蒸馏的水位基准；缺省视为当前值） */
    lastDistillationEventCount?: number;
  };
}

/** 成功执行记录参数（IMemoryStore 契约） */
export interface RecordSuccessParams {
  taskType: string;
  complexity: number;
  features: string[];
  taskSummary: string;
  plan: SuccessfulPlanRecord['plan'];
  modelAssignments: Record<string, string>;
  totalLatency: number;
  qualityScores: Record<string, number>;
  tokenCost: number;
}

/** 失败执行记录参数（IMemoryStore 契约） */
export interface RecordFailureParams {
  taskType: string;
  complexity: number;
  features: string[];
  reason: string;
  failedNodeId: string;
  failedModelId: string;
  errorMessage: string;
}

/** 决策反馈记录参数（IMemoryStore 契约） */
export interface RecordDecisionFeedbackParams {
  signalType: string;
  signalDescription: string;
  decision: string;
  outcome: DecisionFeedback['outcome'];
  outcomeReason: string;
  lesson?: string;
}

/** outcome → 数值映射（用于决策成功率统计） */
const OUTCOME_SCORE: Record<DecisionFeedback['outcome'], number> = {
  excellent: 1.0,
  good: 0.8,
  acceptable: 0.6,
  poor: 0.3,
  failed: 0,
};

/** 任务模式指纹（taskType + complexity 分桶 + 特征排序，全组件统一约定） */
export function buildPatternFingerprint(taskType: string, complexity: number, features: string[]): string {
  const bucket = Math.round(complexity * 10) / 10;
  return `${taskType}::${bucket}::${[...features].sort().join(',')}`;
}

// ───────────────────── 第二阶段升级：可复用的条件求值与签名工具（纯函数） ─────────────────────
//
// 语义记忆与程序记忆共享同一套条件求值语义（合取 + 保守缺省）。
// 导出为纯函数供优化器（optimizer.ts）在检索多条程序记忆时复用，
// 避免在 IMemoryStore 之外重复实现一套有漂移风险的匹配逻辑。

/** 条件匹配上下文（语义/程序记忆共用；outcome 与 rootCause 仅程序记忆使用） */
export interface MemoryMatchContext {
  features?: string[];
  complexity?: number;
  length?: number;
  tokenCost?: number;
  outcome?: string;
  rootCause?: string;
}

/** 单条件结构（SemanticCondition / ProceduralCondition 的公共形状） */
export interface MemoryCondition {
  dimension: string;
  operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';
  value: string | number | string[];
}

/** 条件维度 → 上下文取值（未知维度返回 undefined，保守不命中） */
function conditionValueOf(dimension: string, taskType: string, context: MemoryMatchContext): string | number | string[] | undefined {
  switch (dimension) {
    case 'task-type':
      return taskType;
    case 'feature':
      return context.features;
    case 'complexity':
      return context.complexity;
    case 'length':
      return context.length;
    case 'token-cost':
      return context.tokenCost;
    case 'outcome':
      return context.outcome;
    case 'root-cause':
      return context.rootCause;
    default:
      return undefined;
  }
}

/** 单条件求值（actual 未知时除空值场景外均不命中） */
export function evaluateMemoryCondition(
  actual: string | number | string[] | undefined,
  operator: MemoryCondition['operator'],
  expected: string | number | string[],
): boolean {
  if (actual === undefined) return false;
  switch (operator) {
    case 'eq':
      return actual === expected;
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'contains':
      if (typeof actual === 'string') return actual.includes(String(expected));
      if (Array.isArray(actual)) return actual.includes(String(expected));
      return false;
    case 'in':
      if (Array.isArray(expected)) {
        if (Array.isArray(actual)) return actual.some((a) => expected.includes(a));
        return expected.includes(String(actual));
      }
      return false;
    default:
      return false;
  }
}

/** 合取条件匹配：全部条件满足才返回 true（供优化器检索复用） */
export function matchesMemoryConditions(conditions: MemoryCondition[], taskType: string, context: MemoryMatchContext): boolean {
  for (const cond of conditions) {
    const actual = conditionValueOf(cond.dimension, taskType, context);
    if (!evaluateMemoryCondition(actual, cond.operator, cond.value)) return false;
  }
  return true;
}

/** 条件列表 → 归一化签名（排序后拼接，维度无关顺序） */
function conditionSignature(conditions: MemoryCondition[]): string {
  return conditions
    .map((c) => `${c.dimension}:${c.operator}:${Array.isArray(c.value) ? [...c.value].sort().join('|') : String(c.value)}`)
    .sort()
    .join('&');
}

/** 语义记忆结构签名（domain + 结论类型 + 条件）：签名相同且结论值不同 → 规律冲突 */
function semanticSignature(m: SemanticMemory): string {
  return `${m.domain}|${m.conclusion.type}|${conditionSignature(m.conditions)}`;
}

/** 模糊匹配最低相似度门槛 */
const MIN_SIMILARITY = 0.4;
/** 持久化防抖窗口（毫秒） */
const PERSIST_DEBOUNCE_MS = 500;
/** 单个模式保留的成功方案上限（保留质量最高者） */
const MAX_SUCCESSFUL_PLANS = 20;
/** 单个模式保留的失败记录上限 */
const MAX_FAILURE_RECORDS = 20;

/** 证据普查单层统计（3.0：自知之明报告的原料） */
export interface EvidenceCensusLayer {
  /** 记忆层：蒸馏策略 / 语义记忆 / 程序记忆 / 模型画像 */
  layer: 'strategy' | 'semantic' | 'procedural' | 'model-profile';
  /** 该层实体总数 */
  total: number;
  /** 已携带时间加权证据的实体数 */
  withEvidence: number;
  /** 全层平均有效样本量（时间衰减后） */
  avgEffectiveSamples: number;
  /** 证据枯竭实体数（有效样本 < 1，长期未验证） */
  evidenceExhausted: number;
}

/** 证据普查（3.0：全层不确定性一览——系统知道自己「哪些记忆可信、哪些在过期」） */
export interface EvidenceCensus {
  generatedAt: number;
  layers: EvidenceCensusLayer[];
  /** 能力漂移模型（|drift| > 0.1 且有效样本 ≥ 5）：修复被察觉 / 退化被预警 */
  driftedModels: Array<{
    modelId: string;
    taskType: string;
    drift: number;
    effectiveSamples: number;
    posteriorMean: number;
  }>;
}

/**
 * 跨会话长期记忆引擎
 *
 * 被 migration-tool / tenant-manager / benchmark-engine / distributed-sync 依赖。
 *
 * 3.0 工程升级：热路径全量索引化——record/upsert/find/get 的 O(n) 数组扫描
 * 替换为 Map 索引 O(1) 查找（模式指纹 / 画像 id / 策略 id+描述 / 语义 id+陈述 /
 * 程序 id+名称 / 反馈 id），写入方法同步维护索引，批量变更（prune/遗忘曲线/
 * 载入）后统一重建。
 */
export class LongTermMemory implements IMemoryStore {
  private persistPath: string;
  private backend: MemoryBackend;
  private store: MemoryStore;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** 封账标志：dispose 后一切持久化为 no-op（HMR 卸载竞态防护） */
  private disposed = false;
  private flushOnExit: () => void;

  // ── 3.0：主键索引（热路径 O(n) → O(1)）──
  private idxPattern = new Map<string, TaskPatternMemory>();
  private idxProfile = new Map<string, ModelLongTermProfile>();
  private idxStrategy = new Map<string, DistilledStrategy>();
  private idxStrategyDesc = new Map<string, DistilledStrategy>();
  private idxSemantic = new Map<string, SemanticMemory>();
  private idxSemanticStatement = new Map<string, SemanticMemory>();
  private idxProcedural = new Map<string, ProceduralMemory>();
  private idxProceduralName = new Map<string, ProceduralMemory>();
  private idxFeedbackId = new Set<string>();

  /** 从 store 全量重建索引（构造载入 / 批量过滤后调用） */
  private reindex(): void {
    this.idxPattern = new Map(this.store.taskPatterns.map((p) => [p.fingerprint, p]));
    this.idxProfile = new Map(this.store.modelProfiles.map((p) => [p.id, p]));
    this.idxStrategy = new Map(this.store.distilledStrategies.map((s) => [s.id, s]));
    this.idxStrategyDesc = new Map(this.store.distilledStrategies.map((s) => [s.description, s]));
    this.idxSemantic = new Map(this.store.semanticMemories.map((m) => [m.id, m]));
    this.idxSemanticStatement = new Map(this.store.semanticMemories.map((m) => [m.statement, m]));
    this.idxProcedural = new Map(this.store.proceduralMemories.map((p) => [p.id, p]));
    this.idxProceduralName = new Map(this.store.proceduralMemories.map((p) => [p.name, p]));
    this.idxFeedbackId = new Set(this.store.decisionFeedback.map((f) => f.id));
  }

  /** 当前持久化后端类型（sqlite / json） */
  get backendKind(): 'sqlite' | 'json' {
    return this.backend.kind;
  }

  /**
   * @param persistPath 持久化文件路径（如 .scheduler/memory.json；SQLite 后端自动映射为 .db）
   * @param cryptoEngine 可选加密引擎，提供后持久化自动适配加密配置（走 JSON 后端）
   */
  constructor(persistPath: string, cryptoEngine?: CryptoEngine) {
    this.persistPath = persistPath;
    this.backend = createMemoryBackend(persistPath, cryptoEngine);
    // 旧版 JSON 记忆 → SQLite 一次性迁移（仅无加密且后端为 sqlite 时）
    if (this.backend.kind === 'sqlite' && fs.existsSync(persistPath)) {
      try {
        const legacy = sanitizeMemoryStore(JSON.parse(fs.readFileSync(persistPath, 'utf-8')));
        this.backend.save(legacy);
        fs.renameSync(persistPath, `${persistPath}.migrated`);
      } catch {
        /* 旧文件损坏则跳过迁移，从空库开始 */
      }
    }
    this.store = this.backend.load();
    this.reindex();
    // 进程退出兜底：确保未落盘的脏数据不丢失
    this.flushOnExit = () => this.flushSync();
    process.once('beforeExit', this.flushOnExit);
  }

  /**
   * 模糊经验匹配：按 taskType + complexity + features 检索最相似的任务模式
   *
   * 打分公式：0.5 × taskType相似度 + 0.25 × complexity接近度 + 0.25 × features重叠度
   * 仅返回相似度 ≥ 0.4 的模式中的最优者。
   *
   * @param taskType 任务类型（如 code-generation）
   * @param complexity 复杂度 0~1
   * @param features 任务特征标签列表
   * @returns 最匹配的模式，无合格匹配时返回 undefined
   */
  findPattern(taskType: string, complexity: number, features: string[] = []): TaskPatternMemory | undefined {
    let best: TaskPatternMemory | undefined;
    let bestScore = 0;
    for (const pattern of this.store.taskPatterns) {
      const score = this.similarity(pattern, taskType, complexity, features);
      if (score > bestScore) {
        bestScore = score;
        best = pattern;
      }
    }
    if (bestScore < MIN_SIMILARITY) return undefined;
    // 第三轮：分层存储旁路统计（挂载后命中即 touch——不改返回值，零漂移）
    if (this.tieredStore && best) this.tieredTouch(best.fingerprint);
    return best;
  }

  /**
   * 记录一次成功执行：沉淀任务模式 + 更新模型画像 + 全局统计
   */
  recordSuccess(params: RecordSuccessParams): void {
    const now = Date.now();
    const fingerprint = this.buildFingerprint(params.taskType, params.complexity, params.features);
    let pattern = this.idxPattern.get(fingerprint);

    if (!pattern) {
      pattern = {
        fingerprint,
        taskSummary: params.taskSummary,
        frequency: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        successfulPlans: [],
        failureRecords: [],
        confidence: 0.5,
        avgExecutionTime: 0,
        avgQualityScore: 0,
      };
      this.store.taskPatterns.push(pattern);
      this.idxPattern.set(fingerprint, pattern);
    }

    // 更新模式统计
    pattern.frequency += 1;
    pattern.lastSeenAt = now;
    const record: SuccessfulPlanRecord = {
      timestamp: now,
      plan: params.plan,
      modelAssignments: params.modelAssignments,
      totalLatency: params.totalLatency,
      qualityScores: params.qualityScores,
      tokenCost: params.tokenCost,
    };
    pattern.successfulPlans.push(record);
    // 按质量保留 Top N
    if (pattern.successfulPlans.length > MAX_SUCCESSFUL_PLANS) {
      pattern.successfulPlans.sort((a, b) => this.avgQuality(b.qualityScores) - this.avgQuality(a.qualityScores));
      pattern.successfulPlans = pattern.successfulPlans.slice(0, MAX_SUCCESSFUL_PLANS);
    }
    // 置信度演化：成功 +0.05，上限 0.99
    pattern.confidence = Math.min(0.99, pattern.confidence + 0.05);
    pattern.avgExecutionTime = this.avg(pattern.successfulPlans.map((p) => p.totalLatency));
    pattern.avgQualityScore = this.avg(pattern.successfulPlans.map((p) => this.avgQuality(p.qualityScores)));
    // 最佳模型组合 = 最近一次成功方案的分配
    pattern.bestModelCombination = { ...params.modelAssignments };

    // 更新模型画像
    for (const [nodeId, modelId] of Object.entries(params.modelAssignments)) {
      const quality = params.qualityScores[nodeId] ?? this.avgQuality(params.qualityScores);
      this.updateModelProfile(modelId, params.taskType, true, params.totalLatency, quality, params.tokenCost);
    }

    // 全局统计
    const stats = this.store.globalStats;
    stats.totalExecutions += 1;
    stats.totalSuccesses += 1;
    stats.totalTokensUsed += params.tokenCost;
    stats.totalCostEstimate += params.tokenCost * 0.001; // 粗估：token → 成本系数
    stats.averageQualityScore = this.rollingAvg(stats.averageQualityScore, this.avgQuality(params.qualityScores), stats.totalSuccesses);
    stats.averageExecutionTime = this.rollingAvg(stats.averageExecutionTime, params.totalLatency, stats.totalSuccesses);

    this.schedulePersist();
  }

  /**
   * 记录一次失败执行
   */
  recordFailure(params: RecordFailureParams): void {
    const now = Date.now();
    const fingerprint = this.buildFingerprint(params.taskType, params.complexity, params.features);
    let pattern = this.idxPattern.get(fingerprint);

    if (!pattern) {
      pattern = {
        fingerprint,
        taskSummary: `[失败] ${params.taskType}: ${params.reason}`,
        frequency: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        successfulPlans: [],
        failureRecords: [],
        confidence: 0.5,
        avgExecutionTime: 0,
        avgQualityScore: 0,
      };
      this.store.taskPatterns.push(pattern);
      this.idxPattern.set(fingerprint, pattern);
    }

    pattern.frequency += 1;
    pattern.lastSeenAt = now;
    pattern.failureRecords.push({
      timestamp: now,
      reason: params.reason,
      failedNodeId: params.failedNodeId,
      failedModelId: params.failedModelId,
      errorMessage: params.errorMessage,
    });
    if (pattern.failureRecords.length > MAX_FAILURE_RECORDS) {
      pattern.failureRecords = pattern.failureRecords.slice(-MAX_FAILURE_RECORDS);
    }
    // 置信度演化：失败 -0.08，下限 0.01
    pattern.confidence = Math.max(0.01, pattern.confidence - 0.08);

    // 失败模型画像
    this.updateModelProfile(params.failedModelId, params.taskType, false, 0, 0, 0);

    // 全局统计
    this.store.globalStats.totalExecutions += 1;
    this.store.globalStats.totalFailures += 1;

    this.schedulePersist();
  }

  /**
   * 记录一次决策反馈（execute/defer/dismiss/ask-user 的结果复盘）
   */
  recordDecisionFeedback(params: RecordDecisionFeedbackParams): void {
    const feedback: DecisionFeedback = {
      id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      ...params,
    };
    this.store.decisionFeedback.push(feedback);
    this.idxFeedbackId.add(feedback.id);
    // 反馈记录上限 500 条，FIFO
    if (this.store.decisionFeedback.length > 500) {
      this.store.decisionFeedback = this.store.decisionFeedback.slice(-500);
      this.idxFeedbackId = new Set(this.store.decisionFeedback.map((f) => f.id));
    }
    this.schedulePersist();
  }

  /** 获取全局统计 */
  getGlobalStats(): MemoryStore['globalStats'] {
    return { ...this.store.globalStats };
  }

  /**
   * 获取置信度最高的任务模式
   * @param limit 返回数量上限，默认 10
   */
  getTopPatterns(limit = 10): TaskPatternMemory[] {
    return [...this.store.taskPatterns]
      .sort((a, b) => b.confidence - a.confidence || b.frequency - a.frequency)
      .slice(0, limit);
  }

  /** 获取指定模型画像 */
  getModelProfile(modelId: string): ModelLongTermProfile | undefined {
    return this.idxProfile.get(modelId);
  }

  /**
   * 贝叶斯能力估计（2.0：模型 × 任务类型的 Beta 后验推断）
   *
   * 时间加权证据 → Beta(1+ws, 1+wf) 后验：
   * - posteriorMean：调度预测置信度来源（校准闭环素材）
   * - wilsonLower：小样本保守的利用端评分依据
   * - drift：近期成功率 - 裸成功率，感知模型能力漂移（升级/降级）
   *
   * 读取零额外开销（衰减在写入时惰性完成）；旧持久化字段缺失时
   * 回退裸计数（半衰期从查询时刻起步，下次写入完成初始化）。
   */
  getBayesianEstimate(modelId: string, taskType: string): BayesianEstimate | undefined {
    const profile = this.idxProfile.get(modelId);
    const history = profile?.taskHistory[taskType];
    if (!profile || !history) return undefined;

    // 旧格式回退：加权字段缺失时按裸计数估算（无法追溯证据时间，保守以 0.5 折价）
    const legacy = history.weightedSuccesses === undefined || history.weightedFailures === undefined;
    const rawWs = history.weightedSuccesses ?? history.successCount;
    const rawWf = history.weightedFailures ?? history.totalCalls - history.successCount;
    const legacyDiscount = legacy ? 0.5 : 1;
    const ws = rawWs * legacyDiscount;
    const wf = rawWf * legacyDiscount;

    const alpha = ws + BAYES_PRIOR_STRENGTH;
    const beta = wf + BAYES_PRIOR_STRENGTH;
    const posteriorMean = alpha / (alpha + beta);
    const effectiveSamples = ws + wf;
    const rawSuccessRate = history.totalCalls > 0 ? history.successCount / history.totalCalls : 0;
    const weightedRate = effectiveSamples > 0 ? ws / effectiveSamples : 0;
    // 读取时同样应用惰性衰减（距上次衰减基准的流逝时间），保证漂移感知的时效性
    const elapsedSinceDecay = Math.max(0, Date.now() - (history.lastDecayedAt ?? history.lastCalledAt ?? Date.now()));
    const readDecay = Math.pow(0.5, elapsedSinceDecay / (DECAY_HALF_LIFE_DAYS * 86_400_000));
    const decayedSamples = effectiveSamples * readDecay;

    return {
      modelId,
      taskType,
      alpha: Number(alpha.toFixed(6)),
      beta: Number(beta.toFixed(6)),
      posteriorMean: Number(posteriorMean.toFixed(6)),
      wilsonLower: Number(wilsonLowerBound(ws, wf).toFixed(6)),
      effectiveSamples: Number(decayedSamples.toFixed(6)),
      rawSuccessRate: Number(rawSuccessRate.toFixed(6)),
      drift: effectiveSamples >= 2 ? Number((weightedRate - rawSuccessRate).toFixed(6)) : 0,
      emaQuality: history.emaQuality ?? 0,
    };
  }

  /** 获取全部模型画像 */
  getAllModelProfiles(): ModelLongTermProfile[] {
    return [...this.store.modelProfiles];
  }

  /** 获取全部任务模式（迁移导出用） */
  getAllTaskPatterns(): TaskPatternMemory[] {
    return [...this.store.taskPatterns];
  }

  /**
   * 60.0：挂载率失真压缩规划（幂等覆盖，挂载即生效——只读规划口径）。
   *
   * 蒸馏水位规则只回答「样本够不够多」，本内核回答「预算内留谁」：
   * compressionPlan() 把全部任务模式折算为 (价值, 全保真比特, 压缩档
   * 比特, 留存率)，在预算约束下解出 keep/compress/drop 三档与影子价格
   * λ*——λ* 逐周期追踪即记忆健康度的第一条信息论 KPI（λ*↑ = 记忆库
   * 趋紧，遗忘变贵之前边际条目先变贵；λ*=0 = 容量充裕）。内核不发起
   * 任何删除/压缩动作（零介入承诺），执行仍由蒸馏管线决定。
   */
  attachCompressionPlanner(options?: { budgetBits?: number }): void {
    this.compressionPlannerConfig = { budgetBits: options?.budgetBits ?? 1_000_000 };
  }

  /** 60.0：压缩规划配置（未挂载 undefined） */
  private compressionPlannerConfig?: { budgetBits: number };

  /**
   * 60.0：当前记忆库的压缩规划（未挂载 / 无模式时 undefined）。
   * @param budgetBits 预算比特覆盖（缺省取挂载时的配置）
   */
  compressionPlan(budgetBits?: number): CompressionPlan | undefined {
    if (!this.compressionPlannerConfig) return undefined;
    const patterns = this.getAllTaskPatterns();
    if (patterns.length === 0) return undefined;
    return planMemoryCompression(
      patterns.map((p) => ({
        taskSummary: p.taskSummary,
        confidence: p.confidence,
        successfulPlanCount: p.successfulPlans.length,
      })),
      budgetBits ?? this.compressionPlannerConfig.budgetBits,
    );
  }

  /**
   * 98.0：挂载经验重放固化器（幂等覆盖，挂载即生效——旁路口径）。
   *
   * 白天操作环经验逐条 push 进 PrioritizedReplay（分层配额——每个任务
   * 域一个层，新域流量再大也挤不掉旧域的存活样本，灾难遗忘的存储侧
   * 防线）；心跳睡眠阶段 consolidate() 只重放不采新、IS 加权消化——
   * improvement 即「这一觉值不值」的量化汇报（心智报告素材）。旁路
   * 挂载，不改变记忆库任何读写路径（零漂移）。
   */
  attachExperienceReplay(options?: { capacity?: number; alpha?: number; beta?: number; seed?: number }): void {
    this.replayConsolidator = new ReplayConsolidator(options);
  }

  /** 98.0：经验重放固化器（未挂载零介入） */
  private replayConsolidator?: ReplayConsolidator;

  /** 98.0：记一条经验（task = 任务域；arm = 动作/模型下标；tdError = 预测误差口径） */
  replayPush(transition: { task: string; arm: number; reward: number; tdError?: number }): void {
    this.replayConsolidator?.push(transition);
  }

  /** 98.0：分层配额读数（未挂载时 undefined） */
  replayStats(): ReturnType<ReplayConsolidator['stats']> | undefined {
    return this.replayConsolidator?.stats();
  }

  /** 98.0：睡眠固化（只重放不采新；truth = 逐臂真值供数方注入；未挂载时 undefined） */
  sleepConsolidate(truth: ReadonlyArray<number>, options?: { rounds?: number; batchSize?: number }): SleepResult | undefined {
    return this.replayConsolidator?.consolidate(truth, options);
  }

  /**
   * 68.0：挂载 NCD 查重（幂等覆盖，挂载即生效——只读咨询口径）。
   *
   * 新经验入库前的近邻查重有了「内容相近」的零模型判据：ncdNearDuplicate()
   * 用归一化压缩距离（LZW，NCD 口径）在既有模式摘要中找最近邻——距离
   * ≤ 阈值（缺省 0.65 = 自距离 0.41~0.55 + 裕量）即「内容同源，建议归并
   * 而非新建」。不改变任何写入路径（零漂移）；归并决策由蒸馏管线消费。
   */
  attachNcdDedup(options?: { threshold?: number }): void {
    this.ncdDedupConfig = { threshold: Math.max(0, Math.min(1, options?.threshold ?? 0.65)) };
  }

  /** 68.0：NCD 查重配置（未挂载 undefined） */
  private ncdDedupConfig?: { threshold: number };

  /**
   * 68.0：NCD 近邻查重（未挂载 / 语料为空时 undefined）。
   * @param text 候选经验文本
   * @param corpus 对照语料（缺省取 Top 20 任务模式摘要）
   */
  ncdNearDuplicate(text: string, corpus?: string[]): { hit: boolean; distance: number; bestMatch: string; threshold: number } | undefined {
    if (!this.ncdDedupConfig) return undefined;
    const items = corpus ?? this.getTopPatterns(20).map((p) => p.taskSummary);
    if (items.length === 0) return undefined;
    let best = items[0];
    let bestDistance = ncd(text, best);
    for (const candidate of items.slice(1)) {
      const d = ncd(text, candidate);
      if (d < bestDistance) {
        bestDistance = d;
        best = candidate;
      }
    }
    return { hit: bestDistance <= this.ncdDedupConfig.threshold, distance: Number(bestDistance.toFixed(4)), bestMatch: best, threshold: this.ncdDedupConfig.threshold };
  }

  /** 68.0：语料三角不等式审计（非度量的诚实统计；未挂载 undefined） */
  ncdAudit(corpus?: string[]): NcdTriangleAudit | undefined {
    if (!this.ncdDedupConfig) return undefined;
    const items = corpus ?? this.getTopPatterns(12).map((p) => p.taskSummary);
    if (items.length < 3) return undefined;
    return ncdTriangleAudit(items);
  }

  // ───────────────────── 第三轮升级：分层存储（热/温/冷） ─────────────────────

  /**
   * 挂载分层存储（幂等覆盖；旁路统计口径——findPattern 命中时 touch 该模式，
   * 不改变任何返回值）。条目按（访问频率 × 价值）在 热/温/冷 三层间
   * 晋升/降级，各层容量预算独立；价值分缺省取 confidence（记忆自身的
   * 可信度即价值），可由 valueOf 覆盖。未挂载零介入（零漂移）。
   */
  attachTieredStorage(options?: TieredStoreOptions & { valueOf?: (fingerprint: string) => number }): void {
    this.tieredStore = new TieredStore(options);
    this.tieredValueOf = options?.valueOf;
  }

  /** 分层存储实例（未挂载 undefined） */
  private tieredStore?: TieredStore;
  /** 指纹 → 价值分覆盖（缺省用模式 confidence） */
  private tieredValueOf?: (fingerprint: string) => number;

  /** 分层存储层内定位（未挂载 / 未登记 undefined） */
  tierOf(fingerprint: string): StorageTier | undefined {
    return this.tieredStore?.tierOf(fingerprint);
  }

  /** 分层存储读数（未挂载 undefined） */
  tieredStats(): TieredStoreStats | undefined {
    return this.tieredStore?.stats();
  }

  /** 分层存储内部 touch（验证/预热用；未挂载零介入） */
  tieredTouch(fingerprint: string): StorageTier | undefined {
    if (!this.tieredStore) return undefined;
    const pattern = this.idxPattern.get(fingerprint);
    const value = this.tieredValueOf?.(fingerprint) ?? pattern?.confidence ?? 0.5;
    return this.tieredStore.touch(fingerprint, value);
  }

  // ───────────────────── 第三轮升级：检索多路融合（关键词/相似度/图邻居/别名） ─────────────────────

  /**
   * 挂载多路融合检索（幂等覆盖）。单键模糊匹配（findPattern 的
   * taskType+complexity+features 单路打分）升级为四路加权融合：
   * - 关键词路：查询 token 与 摘要+指纹 token 的 Jaccard（缺省权重 0.4）
   * - 相似度路：既有 similarity() 口径（缺省 0.3）
   * - 图邻居路：种子模式（关键词 top1 / 指定种子）在共现图上的邻居按
   *   related() 序折算（缺省 0.2）——「关键词弱但图上强关联」由此召回
   * - 别名路：查询中的 #n 短索引经 AliasMap 反解精确命中（缺省 0.1）
   * 未挂载零介入（fusedSearch 返回 undefined——诚实降级，不静默走单路）。
   */
  attachRetrievalFusion(options?: RetrievalFusionOptions): void {
    const weights = { keyword: 0.4, similarity: 0.3, graph: 0.2, alias: 0.1, ...options?.weights };
    const total = Math.max(1e-9, weights.keyword + weights.similarity + weights.graph + weights.alias);
    this.retrievalFusion = {
      graph: options?.graph,
      aliases: options?.aliases,
      weights: {
        keyword: weights.keyword / total,
        similarity: weights.similarity / total,
        graph: weights.graph / total,
        alias: weights.alias / total,
      },
    };
  }

  /** 融合检索配置（未挂载 undefined） */
  private retrievalFusion?: { graph?: RetrievalFusionOptions['graph']; aliases?: RetrievalFusionOptions['aliases']; weights: Required<NonNullable<RetrievalFusionOptions['weights']>> };

  /**
   * 多路融合检索：全部任务模式按四路信号加权打分，返回带各路得分的排序。
   * @param query 自然语言查询（关键词路 token 源 + #n 别名扫描）
   * @param opts 相似度路上下文 / 图路种子指纹 / 返回上限（缺省 8）
   * @returns 未挂载融合时 undefined
   */
  fusedSearch(
    query: string,
    opts?: { taskType?: string; complexity?: number; features?: string[]; limit?: number; seedFingerprint?: string },
  ): FusionHit[] | undefined {
    if (!this.retrievalFusion) return undefined;
    const { graph, aliases, weights } = this.retrievalFusion;
    const limit = opts?.limit ?? 8;
    const queryTokens = new Set(segment(query));

    // 关键词路先行：同时为图路选种子（关键词最强者）
    let keywordBest: TaskPatternMemory | undefined;
    let keywordBestScore = 0;
    const keywordScores = new Map<string, number>();
    for (const pattern of this.store.taskPatterns) {
      const patternTokens = new Set(segment(`${pattern.taskSummary} ${pattern.fingerprint}`));
      let intersection = 0;
      for (const token of queryTokens) if (patternTokens.has(token)) intersection += 1;
      const union = queryTokens.size + patternTokens.size - intersection;
      const score = union > 0 ? intersection / union : 0;
      keywordScores.set(pattern.fingerprint, score);
      if (score > keywordBestScore) {
        keywordBestScore = score;
        keywordBest = pattern;
      }
    }

    // 图路：种子（显式指定 > 关键词 top1）的邻居序折算（rank 0 → 1.0 线性衰减）
    const graphScores = new Map<string, number>();
    const seed = opts?.seedFingerprint ?? keywordBest?.fingerprint;
    if (graph && seed) {
      const neighbors = graph.related(seed, 16);
      graphScores.set(seed, 1);
      neighbors.forEach((id, i) => {
        if (!graphScores.has(id)) graphScores.set(id, Number(((neighbors.length - i) / neighbors.length).toFixed(4)));
      });
    }

    // 别名路：查询中的 #n 短索引反解
    const aliasHits = new Set<string>();
    if (aliases) {
      for (const match of query.match(/#\d+/g) ?? []) {
        const resolved = aliases.resolve(match);
        if (resolved) aliasHits.add(resolved);
      }
    }

    const complexity = opts?.complexity ?? 0.5;
    const hits: FusionHit[] = [];
    for (const pattern of this.store.taskPatterns) {
      const signals: FusionSignals = {
        keyword: keywordScores.get(pattern.fingerprint) ?? 0,
        similarity: this.similarity(pattern, opts?.taskType ?? '', complexity, opts?.features ?? []),
        graph: graphScores.get(pattern.fingerprint) ?? 0,
        alias: aliasHits.has(pattern.fingerprint) ? 1 : 0,
      };
      const score =
        weights.keyword * signals.keyword +
        weights.similarity * signals.similarity +
        weights.graph * signals.graph +
        weights.alias * signals.alias;
      if (score > 0) {
        hits.push({ pattern, score: Number(score.toFixed(6)), signals });
      }
    }
    hits.sort((a, b) => b.score - a.score || (a.pattern.fingerprint < b.pattern.fingerprint ? -1 : 1));
    return hits.slice(0, limit);
  }

  // ───────────────────── 第四轮升级 ①：冲突记忆仲裁 ─────────────────────
  //
  // 同主题（结构签名相同）新旧条目结论相反时，按（证据量 × 新鲜度 × 来源质量）
  // 三因子几何加权裁决：胜者留任现役，败方降级为「历史观点」（status='historical'，
  // 检索不再采纳）但记录保留可查——新证据可推翻旧结论，旧观点永不丢失。
  // 与既有 upsert 冲突消解（supportCount 1.5 倍硬门槛，败方直接丢弃/被替换）互补：
  // 仲裁是显式的、可解释的、带审计轨迹的裁决通道。

  /** 仲裁器配置（未挂载 undefined——arbitrateConflicts 返回 undefined 零介入） */
  private arbiterConfig?: { weights: ArbitrationWeights; freshnessHalfLifeDays: number; now: () => number };

  /**
   * 挂载冲突仲裁器（幂等覆盖，模块级 opt-in）。
   * @param options 三因子权重 / 新鲜度半衰期 / 注入时钟（确定性验证用）
   */
  attachArbiter(options?: ArbitrationOptions): void {
    const weights = { evidence: 0.5, freshness: 0.3, sourceQuality: 0.2, ...options?.weights };
    const total = Math.max(1e-9, weights.evidence + weights.freshness + weights.sourceQuality);
    this.arbiterConfig = {
      weights: { evidence: weights.evidence / total, freshness: weights.freshness / total, sourceQuality: weights.sourceQuality / total },
      freshnessHalfLifeDays: options?.freshnessHalfLifeDays ?? 30,
      now: options?.now ?? (() => Date.now()),
    };
  }

  /**
   * 仲裁式准入（第四轮主通道）：新经验到达时若与现役条目同主题反结论，
   * 不再走「1.5 倍支撑硬门槛」（门槛不过即丢弃挑战者 / 过门槛即销毁在位者），
   * 而是三因子加权裁决：
   * - 挑战者胜 → 挑战者准入 active，在位者降级 historical（新证据推翻旧结论）
   * - 在位者胜 → 挑战者仍入库但标记 historical（败方不删除——观点留档可查）
   * - 同分 → 挑战者准入 active，双方都不降级（证据不足不翻案）
   * 无冲突时退化为常规 upsert 语义。
   * @returns 裁决结果；未挂载仲裁器时 undefined（零介入）
   */
  admitWithArbitration<T extends SemanticMemory | ProceduralMemory>(
    memory: T,
  ):
    | { outcome: 'arbitrated'; verdict: ArbitrationVerdict; challengerStatus: 'active' | 'historical' }
    | { outcome: 'tie'; verdict: ArbitrationVerdict }
    | { outcome: 'no-conflict'; write: 'created' | 'updated' | 'duplicate' | 'merged' | 'superseded' }
    | undefined {
    if (!this.arbiterConfig) return undefined;
    const { weights, freshnessHalfLifeDays, now } = this.arbiterConfig;
    const at = now();

    // 定位同主题反结论的现役在位者（多在位时取三因子得分最强者应战）
    const isSemantic = 'action' in memory === false;
    const incumbents = isSemantic
      ? this.store.semanticMemories.filter((m) => m.id !== memory.id && m.status !== 'historical')
      : this.store.proceduralMemories.filter((p) => p.id !== memory.id && p.status !== 'historical');
    const conflicting = incumbents.filter((m) => {
      if (isSemantic) {
        const challenger = memory as SemanticMemory;
        const incumbent = m as SemanticMemory;
        return incumbent.conclusion.value !== challenger.conclusion.value && semanticSignature(incumbent) === semanticSignature(challenger);
      }
      const challenger = memory as ProceduralMemory;
      const incumbent = m as ProceduralMemory;
      if (incumbent.kind !== challenger.kind || incumbent.action.type !== challenger.action.type) return false;
      const modelA = incumbent.action.params['model'];
      const modelB = challenger.action.params['model'];
      if (typeof modelA !== 'string' || typeof modelB !== 'string' || modelA === modelB) return false;
      return conditionSignature(incumbent.conditions) === conditionSignature(challenger.conditions);
    });
    if (conflicting.length === 0) {
      const write = isSemantic
        ? this.upsertSemanticMemory(memory as SemanticMemory)
        : this.upsertProceduralMemory(memory as ProceduralMemory);
      return { outcome: 'no-conflict', write };
    }

    const challengerScore = arbitrationScore(memory, weights, freshnessHalfLifeDays, at);
    let strongest = conflicting[0]!;
    let strongestScore = arbitrationScore(strongest, weights, freshnessHalfLifeDays, at);
    for (const incumbent of conflicting.slice(1)) {
      const score = arbitrationScore(incumbent, weights, freshnessHalfLifeDays, at);
      if (score.score > strongestScore.score) {
        strongest = incumbent;
        strongestScore = score;
      }
    }

    if (Math.abs(challengerScore.score - strongestScore.score) < 1e-9) {
      // 同分：挑战者准入但双方都不降级（保守——证据不足不翻案）
      this.insertAbstractMemory(memory);
      this.schedulePersist();
      const verdict: ArbitrationVerdict = {
        kind: isSemantic ? 'semantic' : 'procedural',
        signature: this.conflictSignatureOf(memory),
        outcome: 'tie',
        winner: challengerScore,
        loser: strongestScore,
        flipped: false,
        rawSupportUpset: false,
      };
      return { outcome: 'tie', verdict };
    }

    const challengerWins = challengerScore.score > strongestScore.score;
    const flipped = challengerWins && memory.distilledAt > strongest.distilledAt;
    const rawSupportUpset = challengerWins && memory.supportCount < strongest.supportCount;
    if (challengerWins) {
      strongest.status = 'historical';
      strongest.demotedBy = { at, winnerId: memory.id, winnerScore: challengerScore.score, loserScore: strongestScore.score };
      this.insertAbstractMemory(memory);
    } else {
      memory.status = 'historical';
      memory.demotedBy = { at, winnerId: strongest.id, winnerScore: strongestScore.score, loserScore: challengerScore.score };
      this.insertAbstractMemory(memory);
    }
    this.schedulePersist();
    const verdict: ArbitrationVerdict = {
      kind: isSemantic ? 'semantic' : 'procedural',
      signature: this.conflictSignatureOf(memory),
      outcome: 'arbitrated',
      winner: challengerWins ? challengerScore : strongestScore,
      loser: challengerWins ? strongestScore : challengerScore,
      flipped,
      rawSupportUpset,
    };
    return { outcome: 'arbitrated', verdict, challengerStatus: challengerWins ? 'active' : 'historical' };
  }

  /** 冲突对结构签名（语义 = domain|结论类型|条件；程序 = kind|动作类型|条件） */
  private conflictSignatureOf(memory: SemanticMemory | ProceduralMemory): string {
    return 'action' in memory
      ? `${memory.kind}|${memory.action.type}|${conditionSignature(memory.conditions)}`
      : semanticSignature(memory);
  }

  /** 语义/程序记忆裸插入（维护主键索引；同 id 已存在时不覆盖——仲裁准入只走新条目） */
  private insertAbstractMemory(memory: SemanticMemory | ProceduralMemory): void {
    if ('action' in memory) {
      const proc = memory as ProceduralMemory;
      if (this.idxProcedural.has(proc.id)) return;
      this.store.proceduralMemories.push(proc);
      this.idxProcedural.set(proc.id, proc);
      this.idxProceduralName.set(proc.name, proc);
    } else {
      const semantic = memory as SemanticMemory;
      if (this.idxSemantic.has(semantic.id)) return;
      this.store.semanticMemories.push(semantic);
      this.idxSemantic.set(semantic.id, semantic);
      this.idxSemanticStatement.set(semantic.statement, semantic);
    }
  }

  /**
   * 扫描并仲裁全部同主题冲突对（语义记忆 + 程序记忆）。
   *
   * 冲突判定：语义 = 同 domain+结论类型+条件签名但结论值不同；程序 = 同
   * kind+动作类型+条件签名但目标模型不同。逐对按三因子加权得分裁决：
   * - 胜者留任 active，败方降级 historical（写入 demotedBy 审计轨迹）
   * - 同分（< 1e-9）判 tie：不降级（保守——证据不足时不翻案）
   * - flips 计数「更晚沉淀者胜出」的翻转裁决（新证据推翻旧结论）
   *
   * @returns 仲裁报告；未挂载仲裁器时 undefined
   */
  arbitrateConflicts(): ArbitrationReport | undefined {
    if (!this.arbiterConfig) return undefined;
    const { weights, freshnessHalfLifeDays, now } = this.arbiterConfig;
    const at = now();
    const verdicts: ArbitrationVerdict[] = [];
    let flips = 0;
    let defended = 0;
    let ties = 0;

    const arbitratePair = (
      kind: ArbitrationVerdict['kind'],
      signature: string,
      a: SemanticMemory | ProceduralMemory,
      b: SemanticMemory | ProceduralMemory,
    ): void => {
      const scoreA = arbitrationScore(a, weights, freshnessHalfLifeDays, at);
      const scoreB = arbitrationScore(b, weights, freshnessHalfLifeDays, at);
      if (Math.abs(scoreA.score - scoreB.score) < 1e-9) {
        ties += 1;
        verdicts.push({ kind, signature, outcome: 'tie', winner: scoreA, loser: scoreB, flipped: false, rawSupportUpset: false });
        return;
      }
      const winner = scoreA.score > scoreB.score ? { entry: a, score: scoreA } : { entry: b, score: scoreB };
      const loser = scoreA.score > scoreB.score ? { entry: b, score: scoreB } : { entry: a, score: scoreA };
      const flipped = winner.entry.distilledAt > loser.entry.distilledAt;
      const rawSupportUpset = winner.entry.supportCount < loser.entry.supportCount;
      if (flipped) flips += 1;
      else defended += 1;
      winner.entry.status = 'active';
      loser.entry.status = 'historical';
      loser.entry.demotedBy = { at, winnerId: winner.entry.id, winnerScore: winner.score.score, loserScore: loser.score.score };
      verdicts.push({ kind, signature, outcome: 'arbitrated', winner: winner.score, loser: loser.score, flipped, rawSupportUpset });
    };

    // 语义记忆冲突对（同签名不同结论值）
    for (let i = 0; i < this.store.semanticMemories.length; i += 1) {
      const a = this.store.semanticMemories[i]!;
      for (let j = i + 1; j < this.store.semanticMemories.length; j += 1) {
        const b = this.store.semanticMemories[j]!;
        if (a.status === 'historical' || b.status === 'historical') continue; // 已降级者不重复受审
        if (a.conclusion.value === b.conclusion.value) continue;
        const sigA = semanticSignature(a);
        if (sigA !== semanticSignature(b)) continue;
        arbitratePair('semantic', sigA, a, b);
      }
    }

    // 程序记忆冲突对（同 kind+动作类型+条件签名但目标模型不同）
    for (let i = 0; i < this.store.proceduralMemories.length; i += 1) {
      const a = this.store.proceduralMemories[i]!;
      for (let j = i + 1; j < this.store.proceduralMemories.length; j += 1) {
        const b = this.store.proceduralMemories[j]!;
        if (a.status === 'historical' || b.status === 'historical') continue;
        if (a.kind !== b.kind || a.action.type !== b.action.type) continue;
        const modelA = a.action.params['model'];
        const modelB = b.action.params['model'];
        if (typeof modelA !== 'string' || typeof modelB !== 'string' || modelA === modelB) continue;
        if (conditionSignature(a.conditions) !== conditionSignature(b.conditions)) continue;
        arbitratePair('procedural', `${a.kind}|${a.action.type}|${conditionSignature(a.conditions)}`, a, b);
      }
    }

    if (verdicts.length > 0) this.schedulePersist();
    return {
      arbitratedAt: at,
      conflictsConsidered: verdicts.length,
      verdicts,
      flips,
      defended,
      ties,
      demotedCount: verdicts.filter((v) => v.outcome === 'arbitrated').length,
    };
  }

  /**
   * 历史观点查询（仲裁败方不删除的兑现）：返回全部被降级的历史条目。
   * @param kind 限定记忆类别；缺省两类合并
   */
  historicalViews(kind?: 'semantic' | 'procedural'): Array<SemanticMemory | ProceduralMemory> {
    const semantic = kind === undefined || kind === 'semantic' ? this.store.semanticMemories.filter((m) => m.status === 'historical') : [];
    const procedural = kind === undefined || kind === 'procedural' ? this.store.proceduralMemories.filter((p) => p.status === 'historical') : [];
    return [...semantic, ...procedural];
  }

  // ───────────────────── 第四轮升级 ②：记忆老化温度曲线 ─────────────────────
  //
  // 条目随年龄从热到温到冷非线性冷却；访问与被引用（蒸馏溯源）保温。
  // 温度驱动处置建议（keep/compress/archive/evict-candidate）——荒废的高龄
  // 条目先降温归档，被反复使用/引用的常青知识保温驻留。

  /** 温度模型配置（未挂载 undefined——temperatureProfile 零介入） */
  private temperatureModel?: TemperatureModelOptions & { citations?: (fingerprint: string) => number };

  /**
   * 挂载老化温度模型（幂等覆盖，模块级 opt-in）。
   * @param options 冷却半衰期/保温增益/注入时钟/引用计数注入（缺省按蒸馏溯源指纹统计）
   */
  attachTemperatureModel(options?: TemperatureModelOptions & { citations?: (fingerprint: string) => number }): void {
    this.temperatureModel = { ...options };
  }

  /** 默认引用计数：策略/语义/程序记忆的 sourceFingerprints 对该模式的引用总数 */
  private defaultCitationCount(fingerprint: string): number {
    let count = 0;
    for (const s of this.store.distilledStrategies) if (s.sourceFingerprint === fingerprint) count += 1;
    for (const m of this.store.semanticMemories) if (m.sourceFingerprints.includes(fingerprint)) count += 1;
    for (const p of this.store.proceduralMemories) if (p.sourceFingerprints.includes(fingerprint)) count += 1;
    return count;
  }

  /**
   * 全库温度剖面（未挂载模型时 undefined）。
   * 每条任务模式给出：年龄/访问/引用/保温系数/有效年龄/温度/温层/处置建议，
   * 外加层内计数与「保温 vs 荒废」分岔强度（divergence = 温度极差）。
   */
  temperatureProfile(): TemperatureProfile | undefined {
    if (!this.temperatureModel) return undefined;
    const now = this.temperatureModel.now?.() ?? Date.now();
    const halfLifeDays = this.temperatureModel.halfLifeDays ?? 14;
    const accessGain = this.temperatureModel.accessGain ?? 0.5;
    const citationGain = this.temperatureModel.citationGain ?? 0.75;
    const citationsOf = this.temperatureModel.citations ?? ((fp: string) => this.defaultCitationCount(fp));

    const entries: TemperatureReading[] = this.store.taskPatterns.map((p) => {
      const ageDays = Math.max(0, (now - p.firstSeenAt) / 86_400_000);
      const reading = temperatureOf({ ageDays, accesses: p.frequency, citations: citationsOf(p.fingerprint) }, { halfLifeDays, accessGain, citationGain });
      const suggestion: TemperatureReading['suggestion'] =
        reading.band === 'hot' || reading.band === 'warm'
          ? 'keep'
          : reading.band === 'cold'
            ? 'compress'
            : p.confidence < 0.3
              ? 'evict-candidate'
              : 'archive';
      return { fingerprint: p.fingerprint, ...reading, suggestion };
    });

    const bands: Record<TemperatureBand, number> = { hot: 0, warm: 0, cold: 0, frozen: 0 };
    const suggestions = { keep: 0, compress: 0, archive: 0, evictCandidate: 0 };
    for (const e of entries) {
      bands[e.band] += 1;
      if (e.suggestion === 'keep') suggestions.keep += 1;
      else if (e.suggestion === 'compress') suggestions.compress += 1;
      else if (e.suggestion === 'archive') suggestions.archive += 1;
      else suggestions.evictCandidate += 1;
    }
    const temps = entries.map((e) => e.temperature);
    return {
      generatedAt: now,
      entries,
      bands,
      suggestions,
      divergence: temps.length > 0 ? Number((Math.max(...temps) - Math.min(...temps)).toFixed(6)) : 0,
    };
  }

  // ───────────────────── 第四轮升级 ③：经验因果链溯源 ─────────────────────
  //
  // 每条沉淀记录「从哪次执行 → 哪次反思 → 哪条洞察」的因果链（根节点为感知
  // 信号 id），跨沉淀可链式衍生（derivedFromMemoryId）——任何一条经验都能
  // 逐级回溯到最初的信号。请求级内存登记（同 AliasMap 口径，不持久化）。

  /** memoryId → 因果链（会话级） */
  private causality = new Map<string, CausalChain>();

  /**
   * 登记一条沉淀的因果链（幂等覆盖）。
   * @returns 'created' 首次登记 / 'updated' 覆盖既有链
   */
  noteCausality(memoryId: string, chain: CausalChain): 'created' | 'updated' {
    const existed = this.causality.has(memoryId);
    this.causality.set(memoryId, { ...chain });
    return existed ? 'updated' : 'created';
  }

  /**
   * 因果链溯源：从指定记忆逐级回溯（derivedFromMemoryId 链）到最初的信号。
   * @returns 完整路径 + 完备性判定；未登记时 undefined
   */
  traceCausality(memoryId: string): ProvenanceTrace | undefined {
    if (!this.causality.has(memoryId)) return undefined;
    const path: ProvenanceTraceStep[] = [];
    const visited = new Set<string>();
    let cursor: string | undefined = memoryId;
    while (cursor && !visited.has(cursor) && path.length < 64) {
      const chain = this.causality.get(cursor);
      if (!chain) break;
      visited.add(cursor);
      path.push({ memoryId: cursor, chain: { ...chain }, complete: chainComplete(chain) });
      cursor = chain.derivedFromMemoryId;
    }
    return {
      memoryId,
      path,
      complete: path.every((step) => step.complete),
      depth: path.length,
      rootSignalId: path.length > 0 ? path[path.length - 1]!.chain.signalId : '',
    };
  }

  /** 因果链统计（链数 / 完备链数 / 最大溯源深度） */
  causalityStats(): { chains: number; complete: number; maxDepth: number } {
    let complete = 0;
    let maxDepth = 0;
    for (const memoryId of this.causality.keys()) {
      const trace = this.traceCausality(memoryId)!;
      if (trace.complete) complete += 1;
      maxDepth = Math.max(maxDepth, trace.depth);
    }
    return { chains: this.causality.size, complete, maxDepth };
  }

  // ───────────────────── 第四轮升级 ④：记忆健康审计 ─────────────────────
  //
  // 全库健康报告：重复率（NCD 近邻）/ 矛盾率（同主题反结论）/ 孤岛率（无人
  // 引用且无图邻接）/ 陈旧率（长期未见）/ 分布漂移（早期 vs 近期任务类型
  // 构成的 Jensen-Shannon 散度）。只读分析，无副作用——体检不治病，治病
  // 由蒸馏/仲裁/温度模型各管一摊。

  /**
   * 全库健康审计。
   * @param options 注入时钟 / NCD 查重阈值 / 陈旧天数 / 采样上限 / 图邻接注入（孤岛判定第二口径）
   */
  healthAudit(options?: HealthAuditOptions): MemoryHealthReport {
    const now = options?.now?.() ?? Date.now();
    const duplicateThreshold = options?.duplicateThreshold ?? 0.6;
    const stalenessDays = options?.stalenessDays ?? 45;
    const sampleCap = options?.sampleCap ?? 24;
    const DAY = 86_400_000;

    const totals = {
      patterns: this.store.taskPatterns.length,
      strategies: this.store.distilledStrategies.length,
      semantic: this.store.semanticMemories.length,
      procedural: this.store.proceduralMemories.length,
    };

    // ── 重复率：NCD 近邻对（采样上限内两两比对，确定性取库序前 sampleCap 条） ──
    const sampled = this.store.taskPatterns.slice(0, Math.max(0, sampleCap));
    const duplicatePairs: MemoryHealthReport['duplicatePairs'] = [];
    const duplicated = new Set<string>();
    for (let i = 0; i < sampled.length; i += 1) {
      for (let j = i + 1; j < sampled.length; j += 1) {
        const distance = ncd(sampled[i]!.taskSummary, sampled[j]!.taskSummary);
        if (distance <= duplicateThreshold) {
          duplicatePairs.push({ a: sampled[i]!.fingerprint, b: sampled[j]!.fingerprint, distance: Number(distance.toFixed(4)) });
          duplicated.add(sampled[i]!.fingerprint);
          duplicated.add(sampled[j]!.fingerprint);
        }
      }
    }
    const duplicateRate = totals.patterns > 0 ? Number((duplicated.size / totals.patterns).toFixed(6)) : 0;

    // ── 矛盾率：同主题反结论对（语义签名 / 程序目标模型两口径；不区分 active/historical——历史观点仍是「库内矛盾」的存量事实） ──
    const contradictions: MemoryHealthReport['contradictions'] = [];
    for (let i = 0; i < this.store.semanticMemories.length; i += 1) {
      for (let j = i + 1; j < this.store.semanticMemories.length; j += 1) {
        const a = this.store.semanticMemories[i]!;
        const b = this.store.semanticMemories[j]!;
        if (a.conclusion.value === b.conclusion.value) continue;
        const sigA = semanticSignature(a);
        if (sigA === semanticSignature(b)) contradictions.push({ kind: 'semantic', ids: [a.id, b.id], signature: sigA });
      }
    }
    for (let i = 0; i < this.store.proceduralMemories.length; i += 1) {
      for (let j = i + 1; j < this.store.proceduralMemories.length; j += 1) {
        const a = this.store.proceduralMemories[i]!;
        const b = this.store.proceduralMemories[j]!;
        if (a.kind !== b.kind || a.action.type !== b.action.type) continue;
        const modelA = a.action.params['model'];
        const modelB = b.action.params['model'];
        if (typeof modelA !== 'string' || typeof modelB !== 'string' || modelA === modelB) continue;
        if (conditionSignature(a.conditions) === conditionSignature(b.conditions)) {
          contradictions.push({ kind: 'procedural', ids: [a.id, b.id], signature: `${a.kind}|${a.action.type}|${conditionSignature(a.conditions)}` });
        }
      }
    }
    const abstractTotal = totals.semantic + totals.procedural;
    const contradictionRate = abstractTotal > 0 ? Number((contradictions.length / abstractTotal).toFixed(6)) : 0;

    // ── 孤岛率：无蒸馏引用 且（注入口径下）无图邻接的任务模式 ──
    const referenced = new Set<string>();
    for (const s of this.store.distilledStrategies) referenced.add(s.sourceFingerprint);
    for (const m of this.store.semanticMemories) for (const fp of m.sourceFingerprints) referenced.add(fp);
    for (const p of this.store.proceduralMemories) for (const fp of p.sourceFingerprints) referenced.add(fp);
    const isolated: string[] = [];
    for (const p of this.store.taskPatterns) {
      if (referenced.has(p.fingerprint)) continue;
      if (options?.linkedTo ? options.linkedTo(p.fingerprint) : false) continue;
      isolated.push(p.fingerprint);
    }
    const isolationRate = totals.patterns > 0 ? Number((isolated.length / totals.patterns).toFixed(6)) : 0;

    // ── 陈旧率：lastSeenAt 早于 stalenessDays 前 ──
    const staleCutoff = now - stalenessDays * DAY;
    const stale: string[] = [];
    for (const p of this.store.taskPatterns) if (p.lastSeenAt < staleCutoff) stale.push(p.fingerprint);
    const stalenessRate = totals.patterns > 0 ? Number((stale.length / totals.patterns).toFixed(6)) : 0;

    // ── 分布漂移：firstSeenAt 早晚半仓的任务类型构成 Jensen-Shannon 散度（比特） ──
    const distributionDrift = this.distributionDrift(now);

    // ── 综合健康分：五类缺陷加权扣分（漂移按 0.5 比特归一封顶） ──
    const driftNorm = Math.min(1, distributionDrift.jsDivergenceBits / 0.5);
    const defectMass =
      0.2 * duplicateRate + 0.25 * contradictionRate + 0.2 * isolationRate + 0.2 * stalenessRate + 0.15 * driftNorm;
    const healthScore = Number((100 * (1 - defectMass)).toFixed(2));

    return {
      generatedAt: now,
      totals,
      duplicateRate,
      duplicatePairs,
      contradictionRate,
      contradictions,
      isolationRate,
      isolated,
      stalenessRate,
      stale,
      distributionDrift,
      healthScore,
    };
  }

  /** 任务类型分布漂移（早期 vs 近期 cohort，JSD 比特；样本不足以分层时全零） */
  private distributionDrift(now: number): MemoryHealthReport['distributionDrift'] {
    const result: MemoryHealthReport['distributionDrift'] = {
      jsDivergenceBits: 0,
      taskTypes: [],
      cohorts: { early: 0, late: 0 },
    };
    if (this.store.taskPatterns.length < 2) return result;
    const sorted = [...this.store.taskPatterns].sort((a, b) => a.firstSeenAt - b.firstSeenAt || (a.fingerprint < b.fingerprint ? -1 : 1));
    const mid = sorted[ Math.floor(sorted.length / 2) ]!.firstSeenAt;
    const earlyMass = new Map<string, number>();
    const lateMass = new Map<string, number>();
    let earlyTotal = 0;
    let lateTotal = 0;
    for (const p of sorted) {
      const type = p.fingerprint.split('::')[0] ?? 'general';
      if (p.firstSeenAt < mid) {
        earlyMass.set(type, (earlyMass.get(type) ?? 0) + Math.max(1, p.frequency));
        earlyTotal += Math.max(1, p.frequency);
      } else {
        lateMass.set(type, (lateMass.get(type) ?? 0) + Math.max(1, p.frequency));
        lateTotal += Math.max(1, p.frequency);
      }
    }
    result.cohorts = { early: sorted.filter((p) => p.firstSeenAt < mid).length, late: sorted.length - sorted.filter((p) => p.firstSeenAt < mid).length };
    if (earlyTotal === 0 || lateTotal === 0) return result;
    const share = (m: Map<string, number>, total: number, type: string): number => (m.get(type) ?? 0) / total;
    const types = [...new Set([...earlyMass.keys(), ...lateMass.keys()])].sort();
    let jsd = 0;
    for (const type of types) {
      const pi = share(earlyMass, earlyTotal, type);
      const qi = share(lateMass, lateTotal, type);
      const mi = (pi + qi) / 2;
      if (pi > 0) jsd += 0.5 * pi * Math.log2(pi / mi);
      if (qi > 0) jsd += 0.5 * qi * Math.log2(qi / mi);
      result.taskTypes.push({ type, earlyShare: Number(pi.toFixed(4)), lateShare: Number(qi.toFixed(4)), delta: Number((qi - pi).toFixed(4)) });
    }
    result.jsDivergenceBits = Number(Math.min(1, jsd).toFixed(6));
    return result;
  }

  /** 获取全部决策反馈（迁移导出用） */
  getAllDecisionFeedback(): DecisionFeedback[] {
    return [...this.store.decisionFeedback];
  }

  /**
   * 插入或更新任务模式（迁移导入用）
   * @returns 'created' 新增 / 'updated' 覆盖
   */
  upsertPattern(pattern: TaskPatternMemory): 'created' | 'updated' {
    const index = this.store.taskPatterns.findIndex((p) => p.fingerprint === pattern.fingerprint);
    if (index >= 0) {
      this.store.taskPatterns[index] = pattern;
      this.idxPattern.set(pattern.fingerprint, pattern);
      this.schedulePersist();
      return 'updated';
    }
    this.store.taskPatterns.push(pattern);
    this.idxPattern.set(pattern.fingerprint, pattern);
    this.schedulePersist();
    return 'created';
  }

  /**
   * 按指纹删除任务模式（分布式同步 pattern-deleted 变更用）
   * @returns 是否实际删除
   */
  removePattern(fingerprint: string): boolean {
    const index = this.store.taskPatterns.findIndex((p) => p.fingerprint === fingerprint);
    if (index < 0) return false;
    this.store.taskPatterns.splice(index, 1);
    this.idxPattern.delete(fingerprint);
    this.schedulePersist();
    return true;
  }

  /**
   * 插入或更新模型画像（迁移导入用）
   * @returns 'created' 新增 / 'updated' 覆盖
   */
  upsertModelProfile(profile: ModelLongTermProfile): 'created' | 'updated' {
    const index = this.store.modelProfiles.findIndex((p) => p.id === profile.id);
    if (index >= 0) {
      this.store.modelProfiles[index] = profile;
      this.idxProfile.set(profile.id, profile);
      this.schedulePersist();
      return 'updated';
    }
    this.store.modelProfiles.push(profile);
    this.idxProfile.set(profile.id, profile);
    this.schedulePersist();
    return 'created';
  }

  /**
   * 追加一条决策反馈（迁移导入用，按 id 去重）
   * @returns 是否实际写入（重复 id 返回 false）
   */
  appendFeedback(feedback: DecisionFeedback): boolean {
    if (this.idxFeedbackId.has(feedback.id)) {
      return false;
    }
    this.store.decisionFeedback.push(feedback);
    this.idxFeedbackId.add(feedback.id);
    this.schedulePersist();
    return true;
  }

  /**
   * 累加式合并全局统计（迁移导入用）
   * 计数类字段相加，均值类字段按执行次数加权平均
   */
  mergeGlobalStats(incoming: MemoryStore['globalStats']): void {
    const local = this.store.globalStats;
    const totalExec = local.totalExecutions + incoming.totalExecutions;
    const totalSucc = local.totalSuccesses + incoming.totalSuccesses;
    const mergedAvg = (a: number, aWeight: number, b: number, bWeight: number): number => {
      const w = aWeight + bWeight;
      return w > 0 ? (a * aWeight + b * bWeight) / w : 0;
    };
    local.averageQualityScore = mergedAvg(
      local.averageQualityScore,
      local.totalSuccesses,
      incoming.averageQualityScore,
      incoming.totalSuccesses,
    );
    local.averageExecutionTime = mergedAvg(
      local.averageExecutionTime,
      local.totalExecutions,
      incoming.averageExecutionTime,
      incoming.totalExecutions,
    );
    local.totalExecutions = totalExec;
    local.totalSuccesses = totalSucc;
    local.totalFailures += incoming.totalFailures;
    local.totalTokensUsed += incoming.totalTokensUsed;
    local.totalCostEstimate += incoming.totalCostEstimate;
    this.schedulePersist();
  }

  /**
   * 获取最近的决策反馈
   * @param limit 返回数量上限，默认 20
   */
  getRecentFeedback(limit = 20): DecisionFeedback[] {
    return this.store.decisionFeedback.slice(-limit).reverse();
  }

  /**
   * 统计某类信号的决策成功率
   * @param signalType 信号类型
   */
  getDecisionSuccessRate(signalType: string): { total: number; successRate: number; avgOutcome: string } {
    const relevant = this.store.decisionFeedback.filter((f) => f.signalType === signalType);
    if (relevant.length === 0) {
      return { total: 0, successRate: 0, avgOutcome: 'n/a' };
    }
    const scores = relevant.map((f) => OUTCOME_SCORE[f.outcome]);
    const avgScore = this.avg(scores);
    const successRate = scores.filter((s) => s >= 0.6).length / scores.length;
    // 反查最接近平均分的 outcome 名称
    const avgOutcome = (Object.entries(OUTCOME_SCORE) as Array<[DecisionFeedback['outcome'], number]>)
      .sort((a, b) => Math.abs(a[1] - avgScore) - Math.abs(b[1] - avgScore))[0]![0];
    return { total: relevant.length, successRate, avgOutcome };
  }

  /**
   * 生成记忆库人类可读摘要（供 query_memory Tool 使用）
   */
  getMemorySummary(): string {
    const s = this.store.globalStats;
    const successRate = s.totalExecutions > 0 ? ((s.totalSuccesses / s.totalExecutions) * 100).toFixed(1) : '0';
    const topPatterns = this.getTopPatterns(3)
      .map((p) => `  - ${p.taskSummary}（置信度 ${p.confidence.toFixed(2)}，出现 ${p.frequency} 次）`)
      .join('\n');
    const profiles = this.store.modelProfiles
      .map((p) => `  - ${p.id}: 最佳 ${p.bestTaskType || '-'} / 最差 ${p.worstTaskType || '-'} / 稳定性 ${p.stability.toFixed(2)}`)
      .join('\n');
    return [
      `📊 记忆库摘要`,
      `总执行: ${s.totalExecutions} | 成功: ${s.totalSuccesses} | 失败: ${s.totalFailures} | 成功率: ${successRate}%`,
      `总 token: ${s.totalTokensUsed} | 估算成本: ${s.totalCostEstimate.toFixed(4)}`,
      `平均质量分: ${s.averageQualityScore.toFixed(3)} | 平均耗时: ${Math.round(s.averageExecutionTime)}ms`,
      `任务模式数: ${this.store.taskPatterns.length} | 模型画像数: ${this.store.modelProfiles.length} | 决策反馈数: ${this.store.decisionFeedback.length} | 蒸馏策略数: ${this.store.distilledStrategies.length} | 语义记忆数: ${this.store.semanticMemories.length} | 程序记忆数: ${this.store.proceduralMemories.length}`,
      topPatterns ? `Top 任务模式:\n${topPatterns}` : '',
      profiles ? `模型画像:\n${profiles}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * 清理过期记忆
   * @param maxAgeDays 最大保留天数，默认 90
   * @returns 被清理的条目数
   */
  prune(maxAgeDays = 90): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let pruned = 0;

    const beforePatterns = this.store.taskPatterns.length;
    this.store.taskPatterns = this.store.taskPatterns.filter((p) => p.lastSeenAt >= cutoff);
    pruned += beforePatterns - this.store.taskPatterns.length;

    const beforeFeedback = this.store.decisionFeedback.length;
    this.store.decisionFeedback = this.store.decisionFeedback.filter((f) => f.timestamp >= cutoff);
    pruned += beforeFeedback - this.store.decisionFeedback.length;

    if (pruned > 0) {
      this.reindex();
      this.schedulePersist();
    }
    return pruned;
  }

  /**
   * 经验蒸馏：从高置信度任务模式中提炼可复用策略
   *
   * 蒸馏规则：
   * 1. 模型偏好策略：某模型在该任务类型的成功方案中出现占比 ≥ 60% → 偏好策略
   * 2. 并行策略：成功方案的 parallelismStrategy 众数 → 并行偏好
   * 3. 仅蒸馏 confidence ≥ 0.6 且成功次数 ≥ 3 的模式，保证策略可靠性
   *
   * @param minConfidence 参与蒸馏的最低模式置信度，默认 0.6
   * @returns 本次新蒸馏的策略列表
   */
  distillExperience(minConfidence = 0.6): DistilledStrategy[] {
    const fresh: DistilledStrategy[] = [];
    const now = Date.now();
    /** 策略 id 铸币：同毫秒内多次蒸馏时保证全局唯一（防 memory_vectors ref_id 冲突） */
    const mintStrategyId = (infix: string): string => {
      let seq = this.store.distilledStrategies.length + fresh.length;
      let id = `strategy-${now}-${infix}${seq}`;
      while (this.idxStrategy.has(id) || fresh.some((s) => s.id === id)) {
        seq += 1;
        id = `strategy-${now}-${infix}${seq}`;
      }
      return id;
    };

    for (const pattern of this.store.taskPatterns) {
      if (pattern.confidence < minConfidence || pattern.successfulPlans.length < 3) continue;
      const taskType = pattern.taskSummary.split(':')[0].replace('[失败] ', '').trim() || 'general';

      // ── 规则 1：模型偏好蒸馏 ──
      const modelWins = new Map<string, number>();
      let totalAssignments = 0;
      for (const plan of pattern.successfulPlans) {
        for (const modelId of Object.values(plan.modelAssignments)) {
          modelWins.set(modelId, (modelWins.get(modelId) ?? 0) + 1);
          totalAssignments += 1;
        }
      }
      if (totalAssignments > 0) {
        for (const [modelId, wins] of modelWins) {
          const ratio = wins / totalAssignments;
          if (ratio >= 0.6) {
            const description = `${taskType} 类任务优先使用模型 ${modelId}（成功方案占比 ${(ratio * 100).toFixed(0)}%）`;
            if (!this.hasStrategy(description)) {
              const strategy: DistilledStrategy = {
                id: mintStrategyId(''),
                taskType,
                description,
                sourceFingerprint: pattern.fingerprint,
                supportCount: wins,
                confidence: Math.min(0.95, pattern.confidence * ratio + 0.1),
                distilledAt: now,
                appliedSuccesses: 0,
                appliedTotal: 0,
                // 3.0：蒸馏证据初始化（成功方案占比证据，legacy 折价起步）
                evidence: initEvidence(wins, wins, now),
              };
              this.store.distilledStrategies.push(strategy);
              this.idxStrategy.set(strategy.id, strategy);
              this.idxStrategyDesc.set(strategy.description, strategy);
              fresh.push(strategy);
            }
          }
        }
      }

      // ── 规则 2：并行策略蒸馏 ──
      const strategyCounts = new Map<string, number>();
      for (const plan of pattern.successfulPlans) {
        strategyCounts.set(plan.plan.parallelismStrategy, (strategyCounts.get(plan.plan.parallelismStrategy) ?? 0) + 1);
      }
      let bestStrategy = '';
      let bestCount = 0;
      for (const [strategy, count] of strategyCounts) {
        if (count > bestCount) {
          bestCount = count;
          bestStrategy = strategy;
        }
      }
      if (bestStrategy && bestCount / pattern.successfulPlans.length >= 0.6) {
        const description = `${taskType} 类任务推荐 ${bestStrategy} 并行策略（${bestCount}/${pattern.successfulPlans.length} 次成功）`;
        if (!this.hasStrategy(description)) {
          const strategy: DistilledStrategy = {
            id: mintStrategyId('p'),
            taskType,
            description,
            sourceFingerprint: pattern.fingerprint,
            supportCount: bestCount,
            confidence: Math.min(0.9, pattern.confidence * 0.9),
            distilledAt: now,
            appliedSuccesses: 0,
            appliedTotal: 0,
            // 3.0：蒸馏证据初始化（成功方案数证据，legacy 折价起步）
            evidence: initEvidence(bestCount, bestCount, now),
          };
          this.store.distilledStrategies.push(strategy);
          this.idxStrategy.set(strategy.id, strategy);
          this.idxStrategyDesc.set(strategy.description, strategy);
          fresh.push(strategy);
        }
      }
    }

    if (fresh.length > 0) this.schedulePersist();
    return fresh;
  }

  /**
   * 获取指定任务类型的蒸馏策略（3.0：按证据化排序分降序——confidence × Wilson 下界等权混合）
   * @param taskType 任务类型
   * @param limit 返回上限
   */
  getStrategies(taskType: string, limit = 5): DistilledStrategy[] {
    const now = Date.now();
    return this.store.distilledStrategies
      .filter((s) => s.taskType === taskType)
      .sort((a, b) => evidenceRankScore(b.confidence, b.evidence, now) - evidenceRankScore(a.confidence, a.evidence, now))
      .slice(0, limit);
  }

  /** 全部蒸馏策略 */
  getAllStrategies(): DistilledStrategy[] {
    return [...this.store.distilledStrategies];
  }

  /**
   * 策略应用反馈：更新策略的应用成功率（闭环校准策略置信度）
   *
   * 3.0：同步观测统一证据（时间加权 Beta）——旧实体首次观测时从
   * 裸计数折价初始化，与模型画像 legacy 回退语义一致。
   *
   * @param strategyId 策略 id
   * @param success 本次应用是否成功
   */
  recordStrategyOutcome(strategyId: string, success: boolean): void {
    const strategy = this.idxStrategy.get(strategyId);
    if (!strategy) return;
    const now = Date.now();
    if (!strategy.evidence) strategy.evidence = initEvidence(strategy.appliedSuccesses, strategy.appliedTotal, now);
    strategy.appliedTotal += 1;
    strategy.lastAppliedAt = now;
    if (success) strategy.appliedSuccesses += 1;
    observeEvidence(strategy.evidence, success, now);
    // 应用成功率反向修正置信度（指数加权）
    const appliedRate = strategy.appliedSuccesses / strategy.appliedTotal;
    strategy.confidence = strategy.confidence * 0.7 + appliedRate * 0.3;
    this.schedulePersist();
  }

  // ─────────────────────────── 语义记忆（第二阶段） ───────────────────────────

  /**
   * 查找匹配的语义记忆
   *
   * 匹配规则：taskTypes 包含目标 taskType（或为空表示通用）+ conditions 全部满足。
   * 多条命中时按置信度降序返回最优。
   *
   * @param taskType 任务类型
   * @param context 条件上下文（任务特征 / 复杂度 / 长度等）
   * @returns 最匹配的语义记忆，无命中时 undefined
   */
  findSemanticMemory(
    taskType: string,
    context: {
      features?: string[];
      complexity?: number;
      length?: number;
      tokenCost?: number;
    } = {},
  ): SemanticMemory | undefined {
    const now = Date.now();
    // 第四轮：被仲裁降级的「历史观点」不再作为现役规律被采纳（未标记时零漂移）
    const candidates = this.store.semanticMemories.filter(
      (m) => m.status !== 'historical' && (m.taskTypes.length === 0 || m.taskTypes.includes(taskType)),
    );
    let best: SemanticMemory | undefined;
    let bestScore = 0;
    for (const mem of candidates) {
      if (!this.matchConditions(mem.conditions, taskType, context)) continue;
      // 3.0 证据化评分：confidence × Wilson 混合分 × supportCount 平滑
      const supportBoost = Math.min(1.5, 1 + Math.log10(1 + mem.supportCount) * 0.15);
      const score = evidenceRankScore(mem.confidence, mem.evidence, now) * supportBoost;
      if (score > bestScore) {
        bestScore = score;
        best = mem;
      }
    }
    return best;
  }

  /** 获取指定任务类型的语义记忆（3.0：按证据化排序分降序；第四轮：历史观点除外） */
  getSemanticMemories(taskType: string, limit = 5): SemanticMemory[] {
    const now = Date.now();
    return this.store.semanticMemories
      .filter((m) => m.status !== 'historical' && (m.taskTypes.length === 0 || m.taskTypes.includes(taskType)))
      .sort((a, b) => evidenceRankScore(b.confidence, b.evidence, now) - evidenceRankScore(a.confidence, a.evidence, now))
      .slice(0, limit);
  }

  /** 全部语义记忆 */
  getAllSemanticMemories(): SemanticMemory[] {
    return [...this.store.semanticMemories];
  }

  /**
   * 插入或更新语义记忆（第二阶段升级：证据合并增强 + 冲突消解）
   *
   * 写入语义（按优先级判定）：
   * 1. 冲突消解：同结构签名（domain + 结论类型 + 条件）但结论值不同 →
   *    新证据支撑 ≥ 旧证据 1.5 倍且 ≥ 3 时取代旧规律（'superseded'），否则丢弃（'duplicate'）
   * 2. 证据合并：同 id 或同 statement 的既有规律 → 不再丢弃新证据，而是
   *    支撑数累加、置信度按证据加权、溯源指纹取并集、衰减基准重置（'merged'）
   * 3. 同 id 直接覆盖（'updated'） / 新增（'created'）
   *
   * 第四轮：bypassConflictGate（迁移导入专用）——迁移是传输不是裁决，包内
   * 条目在上游已仲裁过（含历史观点），导入侧不得再走冲突门槛二次裁决。
   *
   * @returns 'created' / 'updated' / 'merged' / 'superseded' / 'duplicate'
   */
  upsertSemanticMemory(memory: SemanticMemory, options?: { bypassConflictGate?: boolean }): 'created' | 'updated' | 'duplicate' | 'merged' | 'superseded' {
    // ── 1. 冲突消解：同签名不同结论的旧规律 ──
    const signature = semanticSignature(memory);
    const conflicting = options?.bypassConflictGate
      ? undefined
      : this.store.semanticMemories.find(
      (m) =>
        m.id !== memory.id &&
        semanticSignature(m) === signature &&
        m.conclusion.value !== memory.conclusion.value,
    );
    if (conflicting) {
      if (memory.supportCount >= conflicting.supportCount * 1.5 && memory.supportCount >= 3) {
        // 新证据显著更强 → 取代旧规律（保留应用统计以延续反馈闭环）
        const superseded: SemanticMemory = {
          ...memory,
          supportCount: memory.supportCount + conflicting.supportCount,
          sourceFingerprints: [...new Set([...memory.sourceFingerprints, ...conflicting.sourceFingerprints])].slice(0, 50),
          appliedTotal: conflicting.appliedTotal,
          appliedSuccesses: conflicting.appliedSuccesses,
          lastAppliedAt: conflicting.lastAppliedAt,
          evidence: memory.evidence ?? conflicting.evidence, // 3.0：证据随应用统计一并继承
        };
        this.store.semanticMemories[this.store.semanticMemories.indexOf(conflicting)] = superseded;
        this.idxSemantic.delete(conflicting.id);
        this.idxSemanticStatement.delete(conflicting.statement);
        this.idxSemantic.set(superseded.id, superseded);
        this.idxSemanticStatement.set(superseded.statement, superseded);
        this.schedulePersist();
        return 'superseded';
      }
      return 'duplicate'; // 证据不足，保守丢弃新样本
    }

    // ── 2. 证据合并：同 id 或同 statement（3.0 索引化 O(1)） ──
    const existing = this.idxSemantic.get(memory.id) ?? this.idxSemanticStatement.get(memory.statement);
    if (existing && existing.id === memory.id) {
      // 同 id 覆盖（重蒸馏全量重算支撑度）：保留既有应用反馈统计，
      // 避免每次重蒸馏把反馈闭环积累的 appliedTotal/appliedSuccesses 清零
      const replacement: SemanticMemory =
        memory.appliedTotal === 0 && (existing.appliedTotal > 0 || existing.appliedSuccesses > 0)
          ? {
              ...memory,
              appliedTotal: existing.appliedTotal,
              appliedSuccesses: existing.appliedSuccesses,
              lastAppliedAt: existing.lastAppliedAt,
            }
          : memory;
      if (!replacement.evidence && existing.evidence) replacement.evidence = existing.evidence; // 3.0：证据继承
      this.store.semanticMemories[this.store.semanticMemories.indexOf(existing)] = replacement;
      if (existing.statement !== replacement.statement) this.idxSemanticStatement.delete(existing.statement);
      this.idxSemantic.set(replacement.id, replacement);
      this.idxSemanticStatement.set(replacement.statement, replacement);
      this.schedulePersist();
      return 'updated';
    }
    if (existing) {
      const totalSupport = existing.supportCount + memory.supportCount;
      existing.confidence = Math.min(
        0.98,
        (existing.confidence * existing.supportCount + memory.confidence * memory.supportCount) / Math.max(1, totalSupport),
      );
      existing.supportCount = totalSupport;
      existing.sourceFingerprints = [...new Set([...existing.sourceFingerprints, ...memory.sourceFingerprints])].slice(0, 50);
      existing.taskTypes = [...new Set([...existing.taskTypes, ...memory.taskTypes])];
      if (existing.statement !== memory.statement) {
        this.idxSemanticStatement.delete(existing.statement);
        existing.statement = memory.statement; // 陈述刷新为最新占比表述
        this.idxSemanticStatement.set(existing.statement, existing);
      }
      existing.conclusion = memory.conclusion;
      existing.distilledAt = memory.distilledAt;
      existing.lastDecayAt = memory.distilledAt; // 新证据已吸收，闲置计时重置
      // 3.0：证据叠加合并（支撑证据累加，衰减基准随新证据重置）
      if (memory.evidence) {
        if (!existing.evidence) existing.evidence = initEvidence(existing.appliedSuccesses, existing.appliedTotal, memory.distilledAt);
        existing.evidence.weightedSuccesses += memory.evidence.weightedSuccesses;
        existing.evidence.weightedFailures += memory.evidence.weightedFailures;
        existing.evidence.lastDecayedAt = memory.distilledAt;
      }
      this.schedulePersist();
      return 'merged';
    }

    this.store.semanticMemories.push(memory);
    this.idxSemantic.set(memory.id, memory);
    this.idxSemanticStatement.set(memory.statement, memory);
    this.schedulePersist();
    return 'created';
  }

  /** 按指纹溯源删除语义记忆（分布式同步用；3.0 索引同步删除） */
  removeSemanticMemory(id: string): boolean {
    const mem = this.idxSemantic.get(id);
    if (!mem) return false;
    const index = this.store.semanticMemories.indexOf(mem);
    if (index < 0) return false;
    this.store.semanticMemories.splice(index, 1);
    this.idxSemantic.delete(id);
    if (this.idxSemanticStatement.get(mem.statement) === mem) this.idxSemanticStatement.delete(mem.statement);
    this.schedulePersist();
    return true;
  }

  /** 语义记忆应用反馈（闭环校准置信度 + 3.0 统一证据观测） */
  recordSemanticOutcome(id: string, success: boolean): void {
    const mem = this.idxSemantic.get(id);
    if (!mem) return;
    const now = Date.now();
    if (!mem.evidence) mem.evidence = initEvidence(mem.appliedSuccesses, mem.appliedTotal, now);
    mem.appliedTotal += 1;
    mem.lastAppliedAt = now;
    if (success) mem.appliedSuccesses += 1;
    observeEvidence(mem.evidence, success, now);
    const appliedRate = mem.appliedSuccesses / mem.appliedTotal;
    mem.confidence = mem.confidence * 0.7 + appliedRate * 0.3;
    this.schedulePersist();
  }

  // ─────────────────────────── 程序记忆（第二阶段） ───────────────────────────

  /**
   * 查找匹配的程序记忆
   *
   * 匹配规则：kind 匹配 + taskTypes 适配 + conditions 合取全部满足。
   * 多条命中时按置信度降序返回最优。
   *
   * @param kind 规则类别（scheduling / reflection）
   * @param taskType 任务类型
   * @param context 条件上下文
   */
  findProceduralMemory(
    kind: ProceduralMemory['kind'],
    taskType: string,
    context: {
      features?: string[];
      complexity?: number;
      length?: number;
      tokenCost?: number;
      outcome?: string;
      rootCause?: string;
    } = {},
  ): ProceduralMemory | undefined {
    const candidates = this.store.proceduralMemories.filter(
      (p) => p.kind === kind && p.status !== 'historical' && (p.taskTypes.length === 0 || p.taskTypes.includes(taskType)),
    );
    let best: ProceduralMemory | undefined;
    let bestScore = 0;
    const now = Date.now();
    for (const proc of candidates) {
      if (!this.matchProceduralConditions(proc.conditions, taskType, context)) continue;
      // 3.0 证据化评分：confidence × Wilson 混合分 × supportCount 平滑
      const supportBoost = Math.min(1.5, 1 + Math.log10(1 + proc.supportCount) * 0.15);
      const score = evidenceRankScore(proc.confidence, proc.evidence, now) * supportBoost;
      if (score > bestScore) {
        bestScore = score;
        best = proc;
      }
    }
    return best;
  }

  /** 获取指定任务类型的程序记忆（3.0：按证据化排序分降序；第四轮：历史观点除外） */
  getProceduralMemories(taskType: string, kind?: ProceduralMemory['kind'], limit = 5): ProceduralMemory[] {
    const now = Date.now();
    return this.store.proceduralMemories
      .filter((p) => (kind ? p.kind === kind : true) && p.status !== 'historical' && (p.taskTypes.length === 0 || p.taskTypes.includes(taskType)))
      .sort((a, b) => evidenceRankScore(b.confidence, b.evidence, now) - evidenceRankScore(a.confidence, a.evidence, now))
      .slice(0, limit);
  }

  /** 全部程序记忆 */
  getAllProceduralMemories(): ProceduralMemory[] {
    return [...this.store.proceduralMemories];
  }

  /**
   * 插入或更新程序记忆（第二阶段升级：证据合并增强 + 冲突消解，语义同 upsertSemanticMemory）
   *
   * 冲突判定：同结构签名（kind + 动作类型 + 目标模型维度 + 条件）但目标模型不同
   * （如"长代码任务偏好模型A" vs "偏好模型B"）→ 新证据显著更强时取代，否则丢弃。
   *
   * 第四轮：bypassConflictGate（迁移导入专用，语义同 upsertSemanticMemory）。
   *
   * @returns 'created' / 'updated' / 'merged' / 'superseded' / 'duplicate'
   */
  upsertProceduralMemory(memory: ProceduralMemory, options?: { bypassConflictGate?: boolean }): 'created' | 'updated' | 'duplicate' | 'merged' | 'superseded' {
    // ── 1. 冲突消解：同条件同动作类型但目标模型不同（如"偏好模型A" vs "偏好模型B"） ──
    const conditionSig = conditionSignature(memory.conditions);
    const realConflicting = options?.bypassConflictGate
      ? undefined
      : this.store.proceduralMemories.find((p) => {
      if (p.id === memory.id) return false;
      if (p.kind !== memory.kind || p.action.type !== memory.action.type) return false;
      if (conditionSignature(p.conditions) !== conditionSig) return false;
      const targetA = p.action.params['model'];
      const targetB = memory.action.params['model'];
      return typeof targetA === 'string' && typeof targetB === 'string' && targetA !== targetB;
    });
    if (realConflicting) {
      if (memory.supportCount >= realConflicting.supportCount * 1.5 && memory.supportCount >= 3) {
        const superseded: ProceduralMemory = {
          ...memory,
          supportCount: memory.supportCount + realConflicting.supportCount,
          sourceFingerprints: [...new Set([...memory.sourceFingerprints, ...realConflicting.sourceFingerprints])].slice(0, 50),
          appliedTotal: realConflicting.appliedTotal,
          appliedSuccesses: realConflicting.appliedSuccesses,
          lastAppliedAt: realConflicting.lastAppliedAt,
          evidence: memory.evidence ?? realConflicting.evidence, // 3.0：证据随应用统计一并继承
        };
        this.store.proceduralMemories[this.store.proceduralMemories.indexOf(realConflicting)] = superseded;
        this.idxProcedural.delete(realConflicting.id);
        this.idxProceduralName.delete(realConflicting.name);
        this.idxProcedural.set(superseded.id, superseded);
        this.idxProceduralName.set(superseded.name, superseded);
        this.schedulePersist();
        return 'superseded';
      }
      return 'duplicate';
    }

    // ── 2. 证据合并：同 id 或同 name（3.0 索引化 O(1)） ──
    const existing = this.idxProcedural.get(memory.id) ?? this.idxProceduralName.get(memory.name);
    if (existing && existing.id === memory.id) {
      if (!memory.evidence && existing.evidence) memory.evidence = existing.evidence; // 3.0：证据继承
      this.store.proceduralMemories[this.store.proceduralMemories.indexOf(existing)] = memory;
      if (existing.name !== memory.name) this.idxProceduralName.delete(existing.name);
      this.idxProcedural.set(memory.id, memory);
      this.idxProceduralName.set(memory.name, memory);
      this.schedulePersist();
      return 'updated';
    }
    if (existing) {
      const totalSupport = existing.supportCount + memory.supportCount;
      existing.confidence = Math.min(
        0.98,
        (existing.confidence * existing.supportCount + memory.confidence * memory.supportCount) / Math.max(1, totalSupport),
      );
      existing.supportCount = totalSupport;
      existing.sourceFingerprints = [...new Set([...existing.sourceFingerprints, ...memory.sourceFingerprints])].slice(0, 50);
      existing.taskTypes = [...new Set([...existing.taskTypes, ...memory.taskTypes])];
      if (existing.name !== memory.name) {
        this.idxProceduralName.delete(existing.name);
        existing.name = memory.name;
        this.idxProceduralName.set(existing.name, existing);
      }
      existing.action = memory.action;
      existing.distilledAt = memory.distilledAt;
      existing.lastDecayAt = memory.distilledAt;
      // 3.0：证据叠加合并（支撑证据累加，衰减基准随新证据重置）
      if (memory.evidence) {
        if (!existing.evidence) existing.evidence = initEvidence(existing.appliedSuccesses, existing.appliedTotal, memory.distilledAt);
        existing.evidence.weightedSuccesses += memory.evidence.weightedSuccesses;
        existing.evidence.weightedFailures += memory.evidence.weightedFailures;
        existing.evidence.lastDecayedAt = memory.distilledAt;
      }
      this.schedulePersist();
      return 'merged';
    }

    this.store.proceduralMemories.push(memory);
    this.idxProcedural.set(memory.id, memory);
    this.idxProceduralName.set(memory.name, memory);
    this.schedulePersist();
    return 'created';
  }

  /** 删除程序记忆（3.0 索引同步删除） */
  removeProceduralMemory(id: string): boolean {
    const proc = this.idxProcedural.get(id);
    if (!proc) return false;
    const index = this.store.proceduralMemories.indexOf(proc);
    if (index < 0) return false;
    this.store.proceduralMemories.splice(index, 1);
    this.idxProcedural.delete(id);
    if (this.idxProceduralName.get(proc.name) === proc) this.idxProceduralName.delete(proc.name);
    this.schedulePersist();
    return true;
  }

  /** 程序记忆应用反馈（闭环校准置信度 + 3.0 统一证据观测） */
  recordProceduralOutcome(id: string, success: boolean): void {
    const proc = this.idxProcedural.get(id);
    if (!proc) return;
    const now = Date.now();
    if (!proc.evidence) proc.evidence = initEvidence(proc.appliedSuccesses, proc.appliedTotal, now);
    proc.appliedTotal += 1;
    proc.lastAppliedAt = now;
    if (success) proc.appliedSuccesses += 1;
    observeEvidence(proc.evidence, success, now);
    const appliedRate = proc.appliedSuccesses / proc.appliedTotal;
    proc.confidence = proc.confidence * 0.7 + appliedRate * 0.3;
    this.schedulePersist();
  }

  // ── 蒸馏水位（第二阶段升级：阈值触发知识蒸馏的依据） ──

  /**
   * 情景事件水位：距上次知识蒸馏新增了多少情景事件（成功+失败均计）
   *
   * 反思器据此实现"达到阈值时自动蒸馏"，替代纯周期触发，
   * 高负载时更快沉淀知识、低负载时不做无效全量蒸馏。
   * 水位持久化于 globalStats.lastDistillationEventCount（重启不丢）。
   */
  getDistillationProgress(): {
    /** 情景事件累计总数（= totalExecutions） */
    episodicEventCount: number;
    /** 上次蒸馏完成时的水位 */
    lastDistillationEventCount: number;
    /** 距上次蒸馏新增的情景事件数 */
    pendingSinceLastDistillation: number;
  } {
    const episodicEventCount = this.store.globalStats.totalExecutions;
    const lastDistillationEventCount = this.store.globalStats.lastDistillationEventCount ?? episodicEventCount;
    return {
      episodicEventCount,
      lastDistillationEventCount,
      pendingSinceLastDistillation: Math.max(0, episodicEventCount - lastDistillationEventCount),
    };
  }

  /** 蒸馏完成检查点：刷新水位（供 distillKnowledge 成功后调用） */
  noteDistillationCheckpoint(): void {
    this.store.globalStats.lastDistillationEventCount = this.store.globalStats.totalExecutions;
    this.schedulePersist();
  }

  /**
   * 证据普查（3.0：自知之明报告——全层不确定性一览）
   *
   * 系统级自检 API：
   * - 各记忆层的证据覆盖度（withEvidence / total）、平均有效样本量、证据枯竭数
   * - 模型画像层基于既有时间加权证据换算（legacy 裸计数折价，口径与 getBayesianEstimate 一致）
   * - 能力漂移检测：|drift| > 0.1 且有效样本 ≥ 5 的模型 × 任务组合
   *   （模型修复被察觉 / 模型退化被预警）
   */
  evidenceCensus(): EvidenceCensus {
    const now = Date.now();
    const layerOf = (layer: EvidenceCensusLayer['layer'], items: Array<{ evidence?: MemoryEvidence }>): EvidenceCensusLayer => {
      let withEvidence = 0;
      let exhausted = 0;
      let totalSamples = 0;
      for (const item of items) {
        if (!item.evidence) continue;
        withEvidence += 1;
        const view = readEvidence(item.evidence, now);
        totalSamples += view.effectiveSamples;
        if (view.effectiveSamples < 1) exhausted += 1;
      }
      return {
        layer,
        total: items.length,
        withEvidence,
        avgEffectiveSamples: items.length > 0 ? Number((totalSamples / items.length).toFixed(3)) : 0,
        evidenceExhausted: exhausted,
      };
    };

    // 模型画像层：任务历史 → 证据视图（加权字段缺失时 legacy 折价）
    const profileItems: Array<{ evidence?: MemoryEvidence }> = [];
    for (const profile of this.store.modelProfiles) {
      for (const history of Object.values(profile.taskHistory)) {
        const legacy = history.weightedSuccesses === undefined || history.weightedFailures === undefined;
        profileItems.push({
          evidence: {
            weightedSuccesses: (history.weightedSuccesses ?? history.successCount) * (legacy ? LEGACY_EVIDENCE_DISCOUNT : 1),
            weightedFailures:
              (history.weightedFailures ?? history.totalCalls - history.successCount) * (legacy ? LEGACY_EVIDENCE_DISCOUNT : 1),
            lastDecayedAt: history.lastDecayedAt ?? history.lastCalledAt ?? now,
          },
        });
      }
    }

    // 能力漂移：Beta 后验漂移检测（加权成功率 vs 裸成功率）
    const driftedModels: EvidenceCensus['driftedModels'] = [];
    for (const profile of this.store.modelProfiles) {
      for (const taskType of Object.keys(profile.taskHistory)) {
        const est = this.getBayesianEstimate(profile.id, taskType);
        if (!est || est.effectiveSamples < 5 || Math.abs(est.drift) <= 0.1) continue;
        driftedModels.push({
          modelId: profile.id,
          taskType,
          drift: est.drift,
          effectiveSamples: est.effectiveSamples,
          posteriorMean: est.posteriorMean,
        });
      }
    }

    return {
      generatedAt: now,
      layers: [
        layerOf('strategy', this.store.distilledStrategies),
        layerOf('semantic', this.store.semanticMemories),
        layerOf('procedural', this.store.proceduralMemories),
        layerOf('model-profile', profileItems),
      ],
      driftedModels,
    };
  }

  /**
   * 通用条件匹配（语义记忆用，第二阶段升级：委托导出的纯函数 matchesMemoryConditions，
   * 与优化器检索共用同一套求值语义，避免两处实现漂移）
   */
  private matchConditions(
    conditions: SemanticCondition[],
    taskType: string,
    context: MemoryMatchContext,
  ): boolean {
    return matchesMemoryConditions(conditions, taskType, context);
  }

  /** 程序记忆条件匹配（含 outcome/root-cause 维度） */
  private matchProceduralConditions(
    conditions: ProceduralCondition[],
    taskType: string,
    context: MemoryMatchContext,
  ): boolean {
    return matchesMemoryConditions(conditions, taskType, context);
  }

  /**
   * 遗忘曲线（对冲机制一）：按艾宾浩斯衰减模型对长期未使用的记忆降低置信度
   *
   * 覆盖四类记忆：任务模式（基准 lastSeenAt）、蒸馏策略（基准 lastAppliedAt）、
   * 语义记忆与程序记忆（基准 lastAppliedAt，第二阶段新增）。
   *
   * 幂等性（关键修正）：衰减以 lastDecayAt 为基准计算"自上次衰减以来的闲置天数"，
   * 而非自 lastSeenAt 起的累计天数——否则高频维护调用会把同一段闲置时间
   * 重复计入，导致复合叠加过度衰减。多次调用只推进衰减窗口，不重复惩罚。
   *
   * 衰减公式：confidence ×= 0.5 ^ (daysIdle / effectiveHalfLife)
   * - 高频模式（frequency 高）半衰期更长，不易遗忘
   * - 置信度低于 forgetThreshold 的记忆直接清除（彻底遗忘）
   *
   * @param halfLifeDays 基准半衰期（天），默认 30
   * @param forgetThreshold 低于该置信度彻底遗忘，默认 0.2
   * @returns { decayed: 衰减的记忆数, forgotten: 彻底遗忘的记忆数 }
   */
  applyForgettingCurve(halfLifeDays = 30, forgetThreshold = 0.2): { decayed: number; forgotten: number } {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    let decayed = 0;
    let forgotten = 0;

    // ── 任务模式衰减（幂等：以 lastDecayAt 为基准） ──
    const survivors: TaskPatternMemory[] = [];
    for (const pattern of this.store.taskPatterns) {
      const decayBase = pattern.lastDecayAt ?? pattern.lastSeenAt;
      const daysIdle = (now - decayBase) / DAY;
      if (daysIdle < 1) {
        survivors.push(pattern);
        continue;
      }
      // 高频模式半衰期延长：frequency 每 +10 次，半衰期 +100%（上限 3 倍）
      const effectiveHalfLife = halfLifeDays * Math.min(3, 1 + pattern.frequency / 10);
      const decayFactor = Math.pow(0.5, daysIdle / effectiveHalfLife);
      const newConfidence = pattern.confidence * decayFactor;

      if (newConfidence < forgetThreshold) {
        forgotten += 1;
        continue; // 彻底遗忘
      }
      if (newConfidence < pattern.confidence - 0.001) {
        pattern.confidence = newConfidence;
        decayed += 1;
      }
      pattern.lastDecayAt = now;
      survivors.push(pattern);
    }

    // ── 蒸馏策略衰减（对冲机制二：长期未被应用/验证的策略同样遗忘） ──
    const strategySurvivors: DistilledStrategy[] = [];
    for (const strategy of this.store.distilledStrategies) {
      const decayBase = strategy.lastAppliedAt ?? strategy.distilledAt;
      const daysIdle = (now - decayBase) / DAY;
      if (daysIdle < 1) {
        strategySurvivors.push(strategy);
        continue;
      }
      // 策略半衰期按支撑度延长：supportCount 越高越不易遗忘（上限 2 倍）
      const effectiveHalfLife = halfLifeDays * Math.min(2, 1 + strategy.supportCount / 20);
      const decayFactor = Math.pow(0.5, daysIdle / effectiveHalfLife);
      const newConfidence = strategy.confidence * decayFactor;

      if (newConfidence < forgetThreshold) {
        forgotten += 1;
        continue; // 彻底遗忘
      }
      if (newConfidence < strategy.confidence - 0.001) {
        strategy.confidence = newConfidence;
        decayed += 1;
      }
      strategy.lastAppliedAt = now;
      strategySurvivors.push(strategy);
    }

    // ── 语义记忆衰减（第二阶段：跨任务规律长期未被应用同样遗忘） ──
    const semanticSurvivors: SemanticMemory[] = this.decayMemory(
      this.store.semanticMemories,
      halfLifeDays,
      forgetThreshold,
      now,
      DAY,
      (count) => forgotten += count,
      (count) => decayed += count,
    );

    // ── 程序记忆衰减（第二阶段：if-then 规则长期未被触发同样遗忘） ──
    const proceduralSurvivors: ProceduralMemory[] = this.decayMemory(
      this.store.proceduralMemories,
      halfLifeDays,
      forgetThreshold,
      now,
      DAY,
      (count) => forgotten += count,
      (count) => decayed += count,
    );

    if (forgotten > 0 || decayed > 0) {
      this.store.taskPatterns = survivors;
      this.store.distilledStrategies = strategySurvivors;
      this.store.semanticMemories = semanticSurvivors;
      this.store.proceduralMemories = proceduralSurvivors;
      this.reindex(); // 3.0：批量过滤后重建索引，保持 O(1) 查找一致性
      this.schedulePersist();
    }
    return { decayed, forgotten };
  }

  /**
   * 通用衰减器（供语义/程序记忆复用，结构同 DistilledStrategy 衰减逻辑）
   *
   * @param items 待衰减的记忆数组
   * @param halfLifeDays 基准半衰期
   * @param forgetThreshold 遗忘阈值
   * @param now 当前时间戳
   * @param DAY 一天的毫秒数
   * @param onForget 遗忘计数回调
   * @param onDecay 衰减计数回调
   * @returns 衰减后的存活数组
   */
  private decayMemory<T extends { confidence: number; supportCount: number; distilledAt: number; lastAppliedAt?: number; lastDecayAt?: number }>(
    items: T[],
    halfLifeDays: number,
    forgetThreshold: number,
    now: number,
    DAY: number,
    onForget: (count: number) => void,
    onDecay: (count: number) => void,
  ): T[] {
    const survivors: T[] = [];
    for (const item of items) {
      const decayBase = item.lastDecayAt ?? item.lastAppliedAt ?? item.distilledAt;
      const daysIdle = (now - decayBase) / DAY;
      if (daysIdle < 1) {
        survivors.push(item);
        continue;
      }
      const effectiveHalfLife = halfLifeDays * Math.min(2, 1 + item.supportCount / 20);
      const decayFactor = Math.pow(0.5, daysIdle / effectiveHalfLife);
      const newConfidence = item.confidence * decayFactor;

      if (newConfidence < forgetThreshold) {
        onForget(1);
        continue; // 彻底遗忘
      }
      if (newConfidence < item.confidence - 0.001) {
        item.confidence = newConfidence;
        onDecay(1);
      }
      item.lastDecayAt = now;
      survivors.push(item);
    }
    return survivors;
  }

  /** FTS5 全文检索（混合检索增强，委托 SQLite 后端；JSON 后端返回空） */
  fullTextSearch(query: string, limit = 5) {
    return this.backend.fullTextSearch?.(query, limit) ?? [];
  }

  /** 向量检索（稀疏向量回退，委托 SQLite 后端；JSON 后端返回空） */
  vectorSearch(query: string, limit = 5) {
    return this.backend.vectorSearch?.(query, limit) ?? [];
  }

  // ── 数据库维护 API（委托 SQLite 后端；JSON 后端为安全缺省） ──

  /** 完整性检查（JSON 后端恒 ok） */
  integrityCheck(): string {
    return this.backend.integrityCheck?.() ?? 'ok';
  }

  /** 数据库统计（JSON 后端返回内存计数） */
  dbStats() {
    return (
      this.backend.stats?.() ?? {
        patterns: this.store.taskPatterns.length,
        profiles: this.store.modelProfiles.length,
        feedback: this.store.decisionFeedback.length,
        strategies: this.store.distilledStrategies.length,
        semantic: this.store.semanticMemories.length,
        procedural: this.store.proceduralMemories.length,
        pageSize: 0,
        pageCount: 0,
        walSize: 0,
        schemaVersion: 0,
        fts: false,
        vec: false,
      }
    );
  }

  /** WAL checkpoint（仅 SQLite 后端有效） */
  checkpoint(): void {
    this.backend.checkpoint?.();
  }

  /** VACUUM 回收碎片空间（仅 SQLite 后端有效） */
  vacuum(): void {
    this.backend.vacuum?.();
  }

  /** 热备份（仅 SQLite 后端；返回备份路径） */
  backup(destPath: string): string | undefined {
    return this.backend.backup?.(destPath);
  }

  /** 只读 SQL 查询通道（仅 SQLite 后端；JSON 后端返回空） */
  rawQuery(sql: string, params: Array<string | number | null> = []): Array<Record<string, unknown>> {
    return this.backend.rawQuery?.(sql, params) ?? [];
  }

  /** 立即同步落盘（进程退出前调用） */
  flushSync(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.backend.save(this.store);
  }

  /** 释放资源（落盘 + 移除 beforeExit 监听 + 关闭后端连接）。
   *  先封账再关库：HMR 卸载后仍在途的异步回调可能再次 schedulePersist——
   *  不封账会让新定时器在 backend.close() 之后触发 save，未捕获的
   *  "database is not open" 直接杀死进程（HMR 热重载实测两次复现）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; // 封账：此后一切定时器与落盘为 no-op
    this.flushSync();
    process.removeListener('beforeExit', this.flushOnExit);
    this.backend.close();
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 判断同描述策略是否已存在（蒸馏去重；3.0 索引化 O(1)） */
  private hasStrategy(description: string): boolean {
    return this.idxStrategyDesc.has(description);
  }

  /** 从持久化后端加载记忆库（损坏时由后端备份并抛出） */
  private load(): MemoryStore {
    return this.backend.load();
  }

  /** 防抖持久化调度（封账后 no-op——见 dispose 的竞态说明） */
  private schedulePersist(): void {
    if (this.disposed) return;
    this.store.lastUpdatedAt = Date.now();
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
    // 不阻塞进程退出
    this.persistTimer.unref?.();
  }

  /** 执行持久化（委托后端：SQLite 事务 / JSON 原子写 / 加密落盘） */
  private persist(): void {
    if (this.disposed) return;
    this.backend.save(this.store);
  }

  /** 更新模型画像 */
  private updateModelProfile(
    modelId: string,
    taskType: string,
    success: boolean,
    latency: number,
    quality: number,
    tokenCost: number,
  ): void {
    let profile = this.idxProfile.get(modelId);
    if (!profile) {
      profile = {
        id: modelId,
        name: modelId,
        taskHistory: {},
        costEfficiency: {},
        bestTaskType: '',
        worstTaskType: '',
        stability: 0.5,
      };
      this.store.modelProfiles.push(profile);
      this.idxProfile.set(modelId, profile);
    }
    const history = (profile.taskHistory[taskType] ??= {
      totalCalls: 0,
      successCount: 0,
      totalLatency: 0,
      totalQualityScore: 0,
      avgQualityScore: 0,
      lastCalledAt: 0,
    });
    history.totalCalls += 1;
    if (success) {
      history.successCount += 1;
      history.totalLatency += latency;
      history.totalQualityScore += quality;
    }
    history.lastCalledAt = Date.now();

    // ── 2.0：时间加权贝叶斯证据（写入时惰性衰减累积，读取零开销） ──
    // 旧持久化缺省字段回退裸计数起步（首次写入即完成初始化，向后兼容）
    const now = history.lastCalledAt;
    const decayBase = history.lastDecayedAt ?? history.lastCalledAt ?? now;
    const decay = Math.pow(0.5, Math.max(0, now - decayBase) / (DECAY_HALF_LIFE_DAYS * 86_400_000));
    const ws = (history.weightedSuccesses ?? history.successCount - (success ? 1 : 0)) * decay;
    const wf = (history.weightedFailures ?? history.totalCalls - history.successCount - (success ? 0 : 1)) * decay;
    history.weightedSuccesses = success ? ws + 1 : ws;
    history.weightedFailures = success ? wf : wf + 1;
    history.lastDecayedAt = now;
    // 质量漂移感知：成功执行的 EMA（α=0.3，与 avgQualityScore 语义对齐只计成功）
    if (success) {
      history.emaQuality = history.emaQuality == null ? quality : 0.7 * history.emaQuality + 0.3 * quality;
    }

    history.avgQualityScore = history.successCount > 0 ? history.totalQualityScore / history.successCount : 0;

    // 成本效率：质量分 / (token 成本 + 1)，越高越好
    if (success && tokenCost > 0) {
      const prev = profile.costEfficiency[taskType] ?? 0;
      profile.costEfficiency[taskType] = (prev + quality / (tokenCost / 1000 + 1)) / 2;
    }

    // 推导 best/worst 任务类型（按成功率，至少 2 次调用才参与评比）
    const ranked = Object.entries(profile.taskHistory)
      .filter(([, h]) => h.totalCalls >= 2)
      .sort((a, b) => b[1].successCount / b[1].totalCalls - a[1].successCount / a[1].totalCalls);
    if (ranked.length > 0) {
      profile.bestTaskType = ranked[0]![0];
      profile.worstTaskType = ranked[ranked.length - 1]![0];
    }

    // 稳定性 = 全任务加权成功率的平滑值（向历史值收敛）
    const totalCalls = Object.values(profile.taskHistory).reduce((s, h) => s + h.totalCalls, 0);
    const totalSuccess = Object.values(profile.taskHistory).reduce((s, h) => s + h.successCount, 0);
    const currentRate = totalCalls > 0 ? totalSuccess / totalCalls : 0.5;
    profile.stability = profile.stability * 0.7 + currentRate * 0.3;
  }

  /** 构建任务指纹：taskType + 复杂度分桶 + 排序后的特征 */
  private buildFingerprint(taskType: string, complexity: number, features: string[]): string {
    return buildPatternFingerprint(taskType, complexity, features);
  }

  /**
   * 相似度打分（0~1）
   * 0.5 × taskType 匹配 + 0.25 × complexity 接近度 + 0.25 × features Jaccard
   */
  private similarity(pattern: TaskPatternMemory, taskType: string, complexity: number, features: string[]): number {
    // taskType：从指纹中还原
    const patternType = pattern.fingerprint.split('::')[0] ?? '';
    const typeScore = patternType === taskType ? 1 : patternType.startsWith(taskType) || taskType.startsWith(patternType) ? 0.5 : 0;

    // complexity：从指纹中还原分桶值（畸形/缺失段回退 0.5 中性复杂度——
    // 否则 NaN 沿相似度传播，NaN 比较恒 false 会让该模式静默绕过匹配门槛）
    const parsedComplexity = Number(pattern.fingerprint.split('::')[1]);
    const patternComplexity = Number.isFinite(parsedComplexity) ? parsedComplexity : 0.5;
    const complexityScore = Math.max(0, 1 - Math.abs(patternComplexity - complexity) * 2);

    // features：Jaccard 系数
    const patternFeatures = (pattern.fingerprint.split('::')[2] ?? '').split(',').filter(Boolean);
    let featureScore = 0;
    if (features.length === 0 && patternFeatures.length === 0) {
      featureScore = 1;
    } else if (features.length > 0 || patternFeatures.length > 0) {
      const setA = new Set(features);
      const setB = new Set(patternFeatures);
      const intersection = [...setA].filter((f) => setB.has(f)).length;
      const union = new Set([...setA, ...setB]).size;
      featureScore = union > 0 ? intersection / union : 0;
    }

    return 0.5 * typeScore + 0.25 * complexityScore + 0.25 * featureScore;
  }

  /** 质量分字典的平均值 */
  private avgQuality(scores: Record<string, number>): number {
    const values = Object.values(scores);
    return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  }

  /** 数值数组平均值 */
  private avg(values: number[]): number {
    return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  }

  /** 滚动平均（避免保存全量历史） */
  private rollingAvg(prevAvg: number, newValue: number, count: number): number {
    return count <= 1 ? newValue : prevAvg + (newValue - prevAvg) / count;
  }
}

// ───────────────────── 第三轮升级：分层存储（热/温/冷） ─────────────────────

/** 存储层：热（快/小/高频高价值）/ 温（中）/ 冷（大/归档/待淘汰） */
export type StorageTier = 'hot' | 'warm' | 'cold';

/** 分层存储配置 */
export interface TieredStoreOptions {
  /** 热层容量预算（缺省 64） */
  hotCapacity?: number;
  /** 温层容量预算（缺省 256） */
  warmCapacity?: number;
  /** 冷层容量预算（缺省 1024） */
  coldCapacity?: number;
  /** 新近度半衰期（毫秒，缺省 10 分钟——超过半衰期未访问，分数减半） */
  halfLifeMs?: number;
  /** 注入时钟（确定性实验/测试用；缺省 Date.now） */
  now?: () => number;
}

/** 分层条目（层内定位与打分原料） */
export interface TieredEntry {
  key: string;
  /** 价值分 0~1（记忆口径缺省 confidence——可信度即价值） */
  value: number;
  /** 访问次数（命中累积） */
  freq: number;
  lastAccessAt: number;
  tier: StorageTier;
}

/** 分层存储读数（命中率按层拆口径） */
export interface TieredStoreStats {
  size: number;
  hot: number;
  warm: number;
  cold: number;
  hits: number;
  misses: number;
  /** 各层命中计数 */
  hotHits: number;
  warmHits: number;
  coldHits: number;
  /** 晋升（cold→warm / warm→hot）累计次数 */
  promotions: number;
  /** 降级（hot→warm / warm→cold）累计次数 */
  demotions: number;
  /** 冷层淘汰累计次数 */
  evictions: number;
  /** 热层命中率 = hotHits / (hits + misses)——快层捕获的访问占比 */
  hotHitRate: number;
  /** 总命中率（三层合计） */
  totalHitRate: number;
}

/**
 * 分层存储（第三轮升级）：条目按（访问频率 × 价值）在 热/温/冷 三层间
 * 晋升/降级，各层容量预算独立。
 *
 * 打分（晋升/降级/淘汰的唯一裁决）：
 *   score = value × (1 + log2(1 + freq)) × 0.5^(闲置时长 / halfLifeMs)
 * ——价值 × 频次对数 × 新近度三因子：高价值高频新近者进热层；低价值
 * 一次性访问者（噪声）即使新近也压不过热层常客的 log(freq) 增益。
 *
 * 与单层 LRU 的本质差异：LRU 只看新近度，一次冷噪声访问即可把常驻热键
 * 挤出缓存；分层存储的降级/淘汰看综合分，噪声键在冷层即被价值分筛掉，
 * 热层由「被反复验证的高价值条目」稳态占据。
 */
export class TieredStore {
  private tiers: Record<StorageTier, Map<string, TieredEntry>>;
  private options: Required<Pick<TieredStoreOptions, 'hotCapacity' | 'warmCapacity' | 'coldCapacity' | 'halfLifeMs'>> & Pick<TieredStoreOptions, 'now'>;
  private hits = 0;
  private misses = 0;
  private tierHits: Record<StorageTier, number> = { hot: 0, warm: 0, cold: 0 };
  private promotions = 0;
  private demotions = 0;
  private evictions = 0;

  constructor(options?: TieredStoreOptions) {
    this.options = {
      hotCapacity: options?.hotCapacity ?? 64,
      warmCapacity: options?.warmCapacity ?? 256,
      coldCapacity: options?.coldCapacity ?? 1024,
      halfLifeMs: options?.halfLifeMs ?? 10 * 60 * 1000,
      now: options?.now,
    };
    this.tiers = { hot: new Map(), warm: new Map(), cold: new Map() };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** 综合分：价值 × 频次对数增益 × 新近度指数衰减 */
  private score(entry: TieredEntry): number {
    const age = Math.max(0, this.now() - entry.lastAccessAt);
    const recency = Math.pow(0.5, age / this.options.halfLifeMs);
    return entry.value * (1 + Math.log2(1 + entry.freq)) * recency;
  }

  /** 层容量预算 */
  private capacityOf(tier: StorageTier): number {
    return tier === 'hot' ? this.options.hotCapacity : tier === 'warm' ? this.options.warmCapacity : this.options.coldCapacity;
  }

  /** 层内综合分最低者 */
  private lowestOf(tier: StorageTier): TieredEntry | undefined {
    let lowest: TieredEntry | undefined;
    let lowestScore = Infinity;
    for (const entry of this.tiers[tier].values()) {
      const score = this.score(entry);
      if (score < lowestScore) {
        lowestScore = score;
        lowest = entry;
      }
    }
    return lowest;
  }

  /** 降级链：层满 → 本层最低分降下一层（cold 满 → 淘汰） */
  private ensureCapacity(tier: StorageTier): void {
    const capacity = this.capacityOf(tier);
    while (this.tiers[tier].size > capacity) {
      const lowest = this.lowestOf(tier);
      if (!lowest) return;
      this.tiers[tier].delete(lowest.key);
      if (tier === 'cold') {
        this.evictions += 1;
      } else {
        const next: StorageTier = tier === 'hot' ? 'warm' : 'cold';
        lowest.tier = next;
        this.tiers[next].set(lowest.key, lowest);
        this.demotions += 1;
        this.ensureCapacity(next);
      }
    }
  }

  /** 晋升：score 超过上一层最低分时上移一层（单次访问最多一级） */
  private tryPromote(entry: TieredEntry): void {
    const upper: StorageTier | undefined = entry.tier === 'cold' ? 'warm' : entry.tier === 'warm' ? 'hot' : undefined;
    if (!upper) return;
    const upperLowest = this.lowestOf(upper);
    if (this.tiers[upper].size < this.capacityOf(upper) || (upperLowest && this.score(entry) > this.score(upperLowest))) {
      this.tiers[entry.tier].delete(entry.key);
      entry.tier = upper;
      this.tiers[upper].set(entry.key, entry);
      this.promotions += 1;
      this.ensureCapacity(upper);
    }
  }

  /**
   * 访问一个键：命中则记一次访问（freq + 新近度刷新）并尝试晋升，返回命中层；
   * 未命中则登记（新条目自冷层起步——价值未证明前不占快层）并返回 undefined。
   * @param key 条目键（记忆口径 = 模式指纹）
   * @param value 价值分 0~1（同一键重复访问时以最新值为准）
   */
  touch(key: string, value = 0.5): StorageTier | undefined {
    let entry: TieredEntry | undefined;
    for (const tier of ['hot', 'warm', 'cold'] as const) {
      entry = this.tiers[tier].get(key);
      if (entry) break;
    }
    if (entry) {
      this.hits += 1;
      this.tierHits[entry.tier] += 1;
      entry.freq += 1;
      entry.lastAccessAt = this.now();
      entry.value = value;
      this.tryPromote(entry);
      return entry.tier;
    }
    this.misses += 1;
    const fresh: TieredEntry = { key, value, freq: 1, lastAccessAt: this.now(), tier: 'cold' };
    this.tiers.cold.set(key, fresh);
    this.ensureCapacity('cold');
    // 高价值新条目的申诉性晋升（仅当仍存活于冷层——刚被容量淘汰者不复活）
    const survivor = this.tiers.cold.get(key);
    if (survivor) this.tryPromote(survivor);
    return undefined;
  }

  /** 只读定位（不改统计） */
  tierOf(key: string): StorageTier | undefined {
    for (const tier of ['hot', 'warm', 'cold'] as const) {
      if (this.tiers[tier].has(key)) return tier;
    }
    return undefined;
  }

  /** 只读条目（打分原料透明化） */
  peek(key: string): TieredEntry | undefined {
    for (const tier of ['hot', 'warm', 'cold'] as const) {
      const entry = this.tiers[tier].get(key);
      if (entry) return { ...entry };
    }
    return undefined;
  }

  /** 读数（命中率按层拆口径——热层命中率是快层价值的核心指标） */
  stats(): TieredStoreStats {
    const total = this.hits + this.misses;
    return {
      size: this.tiers.hot.size + this.tiers.warm.size + this.tiers.cold.size,
      hot: this.tiers.hot.size,
      warm: this.tiers.warm.size,
      cold: this.tiers.cold.size,
      hits: this.hits,
      misses: this.misses,
      hotHits: this.tierHits.hot,
      warmHits: this.tierHits.warm,
      coldHits: this.tierHits.cold,
      promotions: this.promotions,
      demotions: this.demotions,
      evictions: this.evictions,
      hotHitRate: total > 0 ? Number((this.tierHits.hot / total).toFixed(4)) : 0,
      totalHitRate: total > 0 ? Number((this.hits / total).toFixed(4)) : 0,
    };
  }
}

// ───────────────────── 第三轮升级：多路融合检索类型 ─────────────────────

/** 融合检索挂载选项 */
export interface RetrievalFusionOptions {
  /** 共现图（结构化注入：只需 related(id, limit)——MemoryGraph 天然满足） */
  graph?: { related(id: string, limit?: number): string[] };
  /** 别名映射（结构化注入：只需 resolve(alias)——AliasMap 天然满足） */
  aliases?: { resolve(alias: string): string | undefined };
  /** 四路权重（缺省 关键词 0.4 / 相似度 0.3 / 图 0.2 / 别名 0.1；自动归一化） */
  weights?: Partial<Record<'keyword' | 'similarity' | 'graph' | 'alias', number>>;
}

/** 四路信号得分（0~1，融合前的原始口径） */
export interface FusionSignals {
  keyword: number;
  similarity: number;
  graph: number;
  alias: number;
}

/** 融合命中（带各路信号与加权总分——排序可解释） */
export interface FusionHit {
  pattern: TaskPatternMemory;
  score: number;
  signals: FusionSignals;
}

// ───────────────────── 第四轮升级 ①：冲突记忆仲裁类型（纯函数口径） ─────────────────────

/** 仲裁三因子权重（归一化前可任意正数；缺省 证据 0.5 / 新鲜 0.3 / 来源 0.2） */
export interface ArbitrationWeights {
  evidence: number;
  freshness: number;
  sourceQuality: number;
}

/** 仲裁器挂载选项（模块级 opt-in） */
export interface ArbitrationOptions {
  weights?: Partial<ArbitrationWeights>;
  /** 新鲜度半衰期（天，缺省 30——闲置一个月新鲜度减半） */
  freshnessHalfLifeDays?: number;
  /** 注入时钟（确定性验证用；缺省 Date.now） */
  now?: () => number;
}

/** 单条候选的三因子得分拆解（仲裁可解释的原子口径） */
export interface ArbitrationScoreBreakdown {
  id: string;
  /** 证据量因子：有效样本量饱和归一 es/(es+5)（有 Beta 证据用时间加权口径，否则裸 supportCount） */
  evidenceMass: number;
  /** 新鲜度因子：0.5^(闲置天数/半衰期)，基准 max(distilledAt, lastAppliedAt) */
  freshness: number;
  /** 来源质量因子：溯源指纹多样性 nf/(nf+3)（单一来源 0.25，三个来源 0.5，饱和渐近 1） */
  sourceQuality: number;
  /**
   * 总分 = evidenceMass^wE × freshness^wF × sourceQuality^wS（几何加权）：
   * 三因子相乘结构——任一因子趋零则总分趋零（强证据 + 极陈旧 + 单一来源
   * 综合不过中等证据 + 新鲜 + 多源，这正是「新证据推翻旧结论」的数学通道）。
   */
  score: number;
}

/** 单次仲裁裁决（winner/loser 各带三因子拆解） */
export interface ArbitrationVerdict {
  kind: 'semantic' | 'procedural';
  signature: string;
  /** 'arbitrated'：已裁决（败方降级）；'tie'：同分保守不翻案 */
  outcome: 'arbitrated' | 'tie';
  winner: ArbitrationScoreBreakdown;
  loser: ArbitrationScoreBreakdown;
  /** 胜者比败方更晚沉淀 → 新证据推翻旧结论（仲裁翻转） */
  flipped: boolean;
  /** 胜者裸支撑数反而更低 → 三因子加权击败了纯证据量口径 */
  rawSupportUpset: boolean;
}

/** 仲裁报告 */
export interface ArbitrationReport {
  arbitratedAt: number;
  /** 审议的冲突对总数 */
  conflictsConsidered: number;
  verdicts: ArbitrationVerdict[];
  /** 翻转裁决数（新胜旧） */
  flips: number;
  /** 卫冕裁决数（旧胜新——证据厚度顶住新鲜度） */
  defended: number;
  /** 同分保守数（不降级任何一方） */
  ties: number;
  /** 降级为历史观点的条目数 */
  demotedCount: number;
}

/**
 * 仲裁三因子得分（纯函数——验证脚本可手算对照的确定性口径）。
 * @param entry 语义/程序记忆（两接口的共用字段：id/supportCount/evidence/distilledAt/lastAppliedAt/sourceFingerprints）
 * @param weights 归一化三因子权重
 * @param freshnessHalfLifeDays 新鲜度半衰期（天）
 * @param now 裁决时刻
 */
export function arbitrationScore(
  entry: Pick<SemanticMemory, 'id' | 'supportCount' | 'evidence' | 'distilledAt' | 'lastAppliedAt' | 'sourceFingerprints'>,
  weights: ArbitrationWeights,
  freshnessHalfLifeDays: number,
  now: number,
): ArbitrationScoreBreakdown {
  // 证据量：有 Beta 证据走时间加权有效样本量，无证据回退裸支撑数（legacy 口径）
  const effectiveSamples = entry.evidence
    ? readEvidence(entry.evidence, now).effectiveSamples
    : entry.supportCount;
  const evidenceMass = effectiveSamples / (effectiveSamples + 5);
  // 新鲜度：自最近一次沉淀/应用起的指数衰减
  const ageDays = Math.max(0, (now - Math.max(entry.distilledAt, entry.lastAppliedAt ?? 0)) / 86_400_000);
  const freshness = Math.pow(0.5, ageDays / Math.max(1e-9, freshnessHalfLifeDays));
  // 来源质量：溯源指纹多样性（去重计数）
  const distinctSources = new Set(entry.sourceFingerprints).size;
  const sourceQuality = distinctSources / (distinctSources + 3);
  const score =
    Math.pow(evidenceMass, weights.evidence) *
    Math.pow(freshness, weights.freshness) *
    Math.pow(sourceQuality, weights.sourceQuality);
  return {
    id: entry.id,
    evidenceMass: Number(evidenceMass.toFixed(6)),
    freshness: Number(freshness.toFixed(6)),
    sourceQuality: Number(sourceQuality.toFixed(6)),
    score: Number(score.toFixed(6)),
  };
}

/** 因果链环节完备性（signal/execution/insight 必备，reflection 可选） */
function chainComplete(chain: CausalChain): boolean {
  return Boolean(chain.signalId && chain.executionId && chain.insightId);
}

// ───────────────────── 第四轮升级 ②：记忆老化温度曲线类型（纯函数口径） ─────────────────────

/** 温层：热（现役常青）/ 温（缓冷）/ 冷（压缩候选）/ 冻结（归档/淘汰候选） */
export type TemperatureBand = 'hot' | 'warm' | 'cold' | 'frozen';

/** 温度模型配置（模块级 opt-in） */
export interface TemperatureModelOptions {
  /** 基准冷却半衰期（天，缺省 14——无保温时两周温度减半） */
  halfLifeDays?: number;
  /** 访问保温增益（缺省 0.5——访问量每翻倍，保温系数 +0.5） */
  accessGain?: number;
  /** 引用保温增益（缺省 0.75——被蒸馏引用比访问更保温：引用是被复用的强证据） */
  citationGain?: number;
  /** 注入时钟（确定性验证用；缺省 Date.now） */
  now?: () => number;
}

/** 单条记忆的温度读数（建议由条目置信度与温层联合决定，纯读数不含建议） */
export interface TemperatureCoreReading {
  /** 条目年龄（天） */
  ageDays: number;
  /** 访问计数 */
  accesses: number;
  /** 被引用计数 */
  citations: number;
  /** 保温系数 = accessGain×log2(1+accesses) + citationGain×log2(1+citations) */
  warmth: number;
  /** 有效年龄 = ageDays / (1 + warmth)——保温把时钟折慢（非线性分岔的来源） */
  effectiveAgeDays: number;
  /** 温度 0~1（1 = 灼热）：0.5^(有效年龄/半衰期) */
  temperature: number;
  band: TemperatureBand;
}

/** 温度剖面条目（读数 + 处置建议） */
export interface TemperatureReading extends TemperatureCoreReading {
  fingerprint: string;
  /** 温度驱动的处置建议：keep 驻留 / compress 压缩 / archive 归档 / evict-candidate 淘汰候选（冻结且低置信） */
  suggestion: 'keep' | 'compress' | 'archive' | 'evict-candidate';
}

/** 全库温度剖面 */
export interface TemperatureProfile {
  generatedAt: number;
  entries: TemperatureReading[];
  /** 各温层条数 */
  bands: Record<TemperatureBand, number>;
  /** 各处置建议条数（压缩/归档候选清单的计数口径） */
  suggestions: { keep: number; compress: number; archive: number; evictCandidate: number };
  /** 保温/荒废分岔强度 = 库内温度极差（max-min；同库同龄条目因保温差异拉开档位） */
  divergence: number;
}

/**
 * 老化温度（纯函数——非线性模型，验证脚本手算对照的确定性口径）：
 *
 *   warmth        = accessGain×log2(1+accesses) + citationGain×log2(1+citations)
 *   effectiveAge  = ageDays / (1 + warmth)
 *   temperature   = 0.5^(effectiveAge / halfLifeDays)
 *
 * 非线性分岔：同龄两条记忆，被反复访问/引用者有效年龄按 (1+warmth) 折慢
 * （保温），无人问津者按原速冷却——年龄相同而温度拉开档位；线性年龄模型
 * （温度只看 ageDays）对两者给出完全相同的读数（保温不可见）。
 *
 * 温层切点（非线性档位）：hot ≥ 0.66 > warm ≥ 0.33 > cold ≥ 0.12 > frozen。
 */
export function temperatureOf(
  input: { ageDays: number; accesses: number; citations: number },
  options?: TemperatureModelOptions,
): TemperatureCoreReading {
  const halfLifeDays = options?.halfLifeDays ?? 14;
  const accessGain = options?.accessGain ?? 0.5;
  const citationGain = options?.citationGain ?? 0.75;
  const warmth = accessGain * Math.log2(1 + Math.max(0, input.accesses)) + citationGain * Math.log2(1 + Math.max(0, input.citations));
  const effectiveAgeDays = input.ageDays / (1 + warmth);
  const temperature = Math.pow(0.5, effectiveAgeDays / Math.max(1e-9, halfLifeDays));
  const band: TemperatureBand = temperature >= 0.66 ? 'hot' : temperature >= 0.33 ? 'warm' : temperature >= 0.12 ? 'cold' : 'frozen';
  return {
    ageDays: input.ageDays,
    accesses: input.accesses,
    citations: input.citations,
    warmth: Number(warmth.toFixed(6)),
    effectiveAgeDays: Number(effectiveAgeDays.toFixed(6)),
    temperature: Number(temperature.toFixed(6)),
    band,
  };
}

// ───────────────────── 第四轮升级 ③：经验因果链溯源类型 ─────────────────────

/**
 * 单条沉淀的因果链：哪次信号 → 哪次执行 →（哪次反思）→ 哪条洞察 → 本条记忆。
 * 可链式衍生（derivedFromMemoryId 指向上游记忆）——多级沉淀逐级回溯到源信号。
 */
export interface CausalChain {
  /** 源信号 id（感知层事件——因果链的根） */
  signalId: string;
  /** 执行 id（该信号触发的任务执行） */
  executionId: string;
  /** 反思 id（执行后复盘；可选——并非所有沉淀都经过反思） */
  reflectionId?: string;
  /** 洞察 id（执行/反思提炼出的洞察） */
  insightId: string;
  /** 上游记忆 id（本条洞察衍生自哪条既有记忆；缺省 = 源头直沉淀） */
  derivedFromMemoryId?: string;
  /** 链登记时刻 */
  recordedAt: number;
}

/** 溯源路径上的单步（一条记忆 + 它的因果链 + 环节完备性） */
export interface ProvenanceTraceStep {
  memoryId: string;
  chain: CausalChain;
  /** signal/execution/insight 必备环节是否齐全 */
  complete: boolean;
}

/** 因果链溯源结果：从指定记忆逐级回溯到最初信号的完整路径 */
export interface ProvenanceTrace {
  memoryId: string;
  path: ProvenanceTraceStep[];
  /** 全路径必备环节全齐（任一环节缺要素即 false——诚实降级，不假造完整性） */
  complete: boolean;
  /** 溯源深度（= path.length；1 = 源头直沉淀，2 = 二级衍生……） */
  depth: number;
  /** 根信号 id（路径末端的 signalId） */
  rootSignalId: string;
}

// ───────────────────── 第四轮升级 ④：记忆健康审计类型 ─────────────────────

/** 健康审计选项（全部只读口径） */
export interface HealthAuditOptions {
  /** 注入时钟（确定性验证用；缺省 Date.now） */
  now?: () => number;
  /** NCD 查重阈值（缺省 0.6——低于此距离判定内容同源） */
  duplicateThreshold?: number;
  /** 陈旧判定天数（缺省 45——lastSeenAt 早于此即陈旧） */
  stalenessDays?: number;
  /** NCD 两两比对的采样上限（缺省 24；O(cap²) 的 LZW 开销护栏） */
  sampleCap?: number;
  /** 图邻接注入（孤岛判定的第二口径：共现图上有邻居则不算孤岛） */
  linkedTo?: (fingerprint: string) => boolean;
}

/** 全库健康报告（五类缺陷指标 + 综合健康分） */
export interface MemoryHealthReport {
  generatedAt: number;
  totals: { patterns: number; strategies: number; semantic: number; procedural: number };
  /** 重复率 = 参与近邻对的模式数 / 总模式数（NCD ≤ 阈值） */
  duplicateRate: number;
  duplicatePairs: Array<{ a: string; b: string; distance: number }>;
  /** 矛盾率 = 同主题反结论对数 / (语义 + 程序记忆总数) */
  contradictionRate: number;
  contradictions: Array<{ kind: 'semantic' | 'procedural'; ids: [string, string]; signature: string }>;
  /** 孤岛率 = 无引用且无图邻接的模式数 / 总模式数 */
  isolationRate: number;
  isolated: string[];
  /** 陈旧率 = lastSeenAt 超过 stalenessDays 的模式数 / 总模式数 */
  stalenessRate: number;
  stale: string[];
  /** 任务类型分布漂移（早期 vs 近期 cohort 的 Jensen-Shannon 散度，比特；不足以分层时全零） */
  distributionDrift: {
    jsDivergenceBits: number;
    taskTypes: Array<{ type: string; earlyShare: number; lateShare: number; delta: number }>;
    cohorts: { early: number; late: number };
  };
  /** 综合健康分 0~100（五类缺陷加权扣分：重复 .2 / 矛盾 .25 / 孤岛 .2 / 陈旧 .2 / 漂移 .15） */
  healthScore: number;
}
