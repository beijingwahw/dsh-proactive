/**
 * contracts.ts — 自主智能闭环三大支柱的接口契约（验收标准 2）
 *
 * 三个接口与最初定义严格一致，由具体组件 implements：
 * - IMemoryStore  → LongTermMemory（记忆支柱：任务模式 / 模型画像 / 决策反馈）
 * - IReflector    → Reflector（反思支柱：执行后复盘并更新记忆）
 * - IOptimizer    → Optimizer（优化支柱：调度前基于记忆推荐）
 *
 * 外部集成方（宿主、测试、替代实现）只依赖本文件的接口，不依赖具体类。
 */

import type {
  BayesianEstimate,
  DecisionFeedback,
  DistilledStrategy,
  DistillationReport,
  ModelLongTermProfile,
  ProceduralMemory,
  RecordDecisionFeedbackParams,
  RecordFailureParams,
  RecordSuccessParams,
  SemanticMemory,
  TaskPatternMemory,
} from './memory/long-term-memory.js';
import type { ExecutionPlan, PlanExecutionResult } from './types.js';
import { AggregateAppError, TypedAppError } from './errors.js';
import type { ExperienceLookup } from './optimizer.js';
import type { Signal } from './sentinel.js';
import type { MemorySearchHit } from './memory/backend.js';
// 第三阶段：策略进化（策略表示 + 沙盒评估报告）
import type { EvaluationReport, Policy, SandboxTask } from './policy/policy-types.js';
// 第四阶段：元认知层（心智报告 + 调整报告 + 回滚结果）
import type { AdjustmentReport, MentalReport, RollbackResult, SystemMetrics } from './meta/meta-types.js';

/** 记忆支柱契约：三类数据的读写与生命周期 */
export interface IMemoryStore {
  // ── 任务模式 ──
  findPattern(taskType: string, complexity: number, features?: string[]): TaskPatternMemory | undefined;
  recordSuccess(params: RecordSuccessParams): void;
  recordFailure(params: RecordFailureParams): void;
  getTopPatterns(limit?: number): TaskPatternMemory[];
  getAllTaskPatterns(): TaskPatternMemory[];
  upsertPattern(pattern: TaskPatternMemory): 'created' | 'updated';
  removePattern(fingerprint: string): boolean;
  // ── 模型画像 ──
  getModelProfile(modelId: string): ModelLongTermProfile | undefined;
  getAllModelProfiles(): ModelLongTermProfile[];
  upsertModelProfile(profile: ModelLongTermProfile): 'created' | 'updated';
  /**
   * 贝叶斯能力估计（第一阶段 2.0：模型 × 任务类型的 Beta 后验推断）
   *
   * 时间加权证据 → 后验均值 / Wilson 下界 / 有效样本量 / 漂移；
   * 调度器利用端评分与反思器反事实分析的数据基础。
   * 可选方法：旧实现未提供时调度回退裸计数、反事实分析静默跳过。
   */
  getBayesianEstimate?(modelId: string, taskType: string): BayesianEstimate | undefined;
  // ── 决策反馈 ──
  recordDecisionFeedback(params: RecordDecisionFeedbackParams): void;
  getRecentFeedback(limit?: number): DecisionFeedback[];
  getDecisionSuccessRate(signalType: string): { total: number; successRate: number; avgOutcome: string };
  appendFeedback(feedback: DecisionFeedback): boolean;
  // ── 蒸馏策略 ──
  distillExperience(minConfidence?: number): DistilledStrategy[];
  getStrategies(taskType: string, limit?: number): DistilledStrategy[];
  getAllStrategies(): DistilledStrategy[];
  recordStrategyOutcome(strategyId: string, success: boolean): void;
  // ── 语义记忆（第二阶段：跨任务规律） ──
  findSemanticMemory(
    taskType: string,
    context?: {
      features?: string[];
      complexity?: number;
      length?: number;
      tokenCost?: number;
    },
  ): SemanticMemory | undefined;
  getSemanticMemories(taskType: string, limit?: number): SemanticMemory[];
  getAllSemanticMemories(): SemanticMemory[];
  /**
   * 插入或更新语义记忆（第二阶段升级：证据合并增强 + 冲突消解）
   * @returns 'created' 新增 / 'updated' 覆盖 / 'merged' 证据合并增强 /
   *           'superseded' 取代旧冲突规律 / 'duplicate' 证据不足被丢弃
   */
  upsertSemanticMemory(memory: SemanticMemory): 'created' | 'updated' | 'duplicate' | 'merged' | 'superseded';
  removeSemanticMemory(id: string): boolean;
  recordSemanticOutcome(id: string, success: boolean): void;
  // ── 程序记忆（第二阶段：if-then 可执行规则） ──
  findProceduralMemory(
    kind: ProceduralMemory['kind'],
    taskType: string,
    context?: {
      features?: string[];
      complexity?: number;
      length?: number;
      tokenCost?: number;
      outcome?: string;
      rootCause?: string;
    },
  ): ProceduralMemory | undefined;
  getProceduralMemories(taskType: string, kind?: ProceduralMemory['kind'], limit?: number): ProceduralMemory[];
  getAllProceduralMemories(): ProceduralMemory[];
  /**
   * 插入或更新程序记忆（第二阶段升级：证据合并增强 + 冲突消解，语义同 upsertSemanticMemory）
   * @returns 'created' / 'updated' / 'merged' / 'superseded' / 'duplicate'
   */
  upsertProceduralMemory(memory: ProceduralMemory): 'created' | 'updated' | 'duplicate' | 'merged' | 'superseded';
  removeProceduralMemory(id: string): boolean;
  recordProceduralOutcome(id: string, success: boolean): void;
  // ── 蒸馏水位（第二阶段升级：阈值触发知识蒸馏的依据；可选注入保持向后兼容） ──
  /** 情景事件水位：距上次蒸馏新增的情景事件数（成功+失败均计） */
  getDistillationProgress?(): {
    episodicEventCount: number;
    lastDistillationEventCount: number;
    pendingSinceLastDistillation: number;
  };
  /** 蒸馏完成检查点：刷新水位（distillKnowledge 成功后调用） */
  noteDistillationCheckpoint?(): void;
  // ── 全局统计与维护 ──
  getGlobalStats(): {
    totalExecutions: number;
    totalSuccesses: number;
    totalFailures: number;
    totalTokensUsed: number;
    totalCostEstimate: number;
    averageQualityScore: number;
    averageExecutionTime: number;
  };
  getMemorySummary(): string;
  prune(maxAgeDays?: number): number;
  applyForgettingCurve(halfLifeDays?: number, forgetThreshold?: number): { decayed: number; forgotten: number };
  // ── 混合检索增强（仅 SQLite 后端提供；JSON 后端缺省为空结果） ──
  fullTextSearch?(query: string, limit?: number): MemorySearchHit[];
  vectorSearch?(query: string, limit?: number): MemorySearchHit[];
  // ── 数据库维护 API（仅 SQLite 后端提供；JSON 后端为安全缺省） ──
  integrityCheck(): string;
  dbStats(): {
    patterns: number;
    profiles: number;
    feedback: number;
    strategies: number;
    /** 第二阶段：语义记忆条数 */
    semantic: number;
    /** 第二阶段：程序记忆条数 */
    procedural: number;
    pageSize: number;
    pageCount: number;
    walSize: number;
    schemaVersion: number;
    fts: boolean;
    vec: boolean;
  };
  checkpoint(): void;
  vacuum(): void;
  backup(destPath: string): string | undefined;
  rawQuery(sql: string, params?: Array<string | number | null>): Array<Record<string, unknown>>;
  flushSync(): void;
  dispose(): void;
}

/** 反思支柱契约：任务完成后复盘并更新记忆 */
export interface IReflector {
  reflectOnOutcome(params: {
    signal: Signal;
    plan: ExecutionPlan;
    result: PlanExecutionResult;
    /** 本次注入/应用的蒸馏策略 id 列表（策略反馈闭环） */
    appliedStrategies?: string[];
    /** 第二阶段升级：本次经验检索命中的语义/程序记忆 id（三层记忆应用反馈闭环） */
    appliedMemoryIds?: { semantic?: string[]; procedural?: string[] };
    /**
     * 第一阶段 2.0：本次各节点的调度决策洞察（预测置信度 + 实际结果）
     *
     * 由编排层从 TaskExecutor.getAndClearDecisionInsights() 桥接，
     * 反思器据此更新 Brier 校准统计（调度预测质量的自知之明）。
     */
    decisionInsights?: Array<{
      nodeId: string;
      taskType: string;
      modelId: string;
      predictedConfidence: number;
      exploration: boolean;
      success: boolean;
    }>;
  }): void;
  /**
   * 调度校准状态（第一阶段 2.0：预测置信度 vs 实际结果的滚动统计）
   *
   * Brier 分 / 平均残差 / 过自信-欠自信方向；可选方法，旧实现不提供时编排层跳过。
   */
  getCalibration?(): {
    brierScore: number;
    residualMean: number;
    samples: number;
    direction: 'overconfident' | 'underconfident' | 'calibrated' | 'insufficient';
    windowSize: number;
  };
  /**
   * 知识蒸馏（第二阶段）：从累积的情景记忆中蒸馏出语义记忆与程序记忆
   *
   * 触发时机：
   * - 定期：AutonomyLoop 维护周期内调用（水位门控，无新增样本时跳过）
   * - 阈值（第二阶段升级）：距上次蒸馏新增情景事件 ≥ autoDistillThreshold 时
   *   在成功复盘后由反思器自动触发
   * - 按需：外部通过 distill_knowledge Tool 调用（force 强制全量蒸馏）
   *
   * 蒸馏过程应产出可被优化器直接使用的结构化知识（SemanticMemory / ProceduralMemory）。
   * 第二阶段升级：产物使用内容寻址稳定 id；重复蒸馏合并增强既有规律（证据累积），
   * 冲突规律由证据竞争淘汰（superseded）。
   *
   * @param options.force 强制蒸馏（绕过水位门控）
   * @returns 蒸馏报告（水位不足或并发冲突时返回 skipped 报告）
   */
  distillKnowledge(options?: { force?: boolean }): Promise<DistillationReport>;
}

/** 优化支柱契约：下一次调度前基于记忆产出推荐 */
export interface IOptimizer {
  /**
   * 经验检索：相似任务模式 + 推荐模型组合 + 历史统计
   *
   * 第二阶段三层记忆优先级：procedural > semantic > episodic > none。
   * 命中程序/语义记忆时，返回 memoryLayer 与 rationale 说明决策依据。
   *
   * @param taskType 任务类型
   * @param complexity 复杂度 0~1
   * @param features 任务特征标签
   * @param context 第二阶段：程序/语义记忆条件匹配所需的额外上下文（长度 / token 成本）
   */
  lookupExperience(
    taskType: string,
    complexity: number,
    features?: string[],
    context?: { length?: number; tokenCost?: number },
  ): ExperienceLookup;
  /** 经验快路径：高置信度模式直接召回历史最优成功计划 */
  recallPlan(lookup: ExperienceLookup, objective: string): ExecutionPlan | undefined;
  /** 混合检索（模糊 + FTS5 + 向量 + 图联想），缺省实现可省略 */
  hybridSearch?(query: string, taskType: string, complexity: number, limit?: number): MemorySearchHit[];
}

// ── 第三阶段：策略进化契约（策略进化器 + 安全沙盒） ──

/**
 * 安全沙盒契约：新策略上线路前的隔离验证环境
 *
 * 隔离性：评估全程离线（不调 LLM、不写记忆、不接触操作环调度器），
 * 不阻塞正常任务调度；同一策略 + 任务集 + 随机种子 → 评估结果可复现。
 */
export interface ISandbox {
  /**
   * 隔离评估策略：历史任务回放 + 合成对抗任务，
   * 产出收益（reward/gain）、风险（risks）、回归（regressions）三段式报告
   * @param policy 待评估策略
   * @param baseline 对比基线策略（通常为当前部署策略；缺省仅输出绝对指标）
   */
  evaluate(policy: Policy, baseline?: Policy): Promise<EvaluationReport>;
  /** 当前评估任务集（历史回放 + 对抗合成） */
  getTaskSet(): SandboxTask[];
}

/**
 * 策略进化器契约：变异 → 沙盒选择 → 保留部署
 *
 * 进化循环：
 * - generateCandidates：基于当前策略产出变异候选（可追溯：generation/parentId/origin）
 * - evaluateCandidate：候选经沙盒隔离评估（与当前策略对比）
 * - selectBest：仅综合收益超阈值且零风险零回归的候选可胜出（劣变体淘汰）
 * - deployPolicy：胜出策略热切换到操作环（无需重启系统）
 */
export interface IPolicyEvolver {
  /** 变异：产出候选策略变体 */
  generateCandidates(currentPolicy: Policy): Promise<Policy[]>;
  /** 选择（评估）：沙盒隔离评估单个候选 */
  evaluateCandidate(policy: Policy, sandbox: ISandbox): Promise<EvaluationReport>;
  /** 保留：择优返回可部署候选（无合格候选返回 null） */
  selectBest(candidates: Policy[], reports: EvaluationReport[]): Promise<Policy | null>;
  /** 部署：策略热切换到操作环 */
  deployPolicy(policy: Policy): Promise<void>;
}

// ── 第四阶段：元认知层契约（自我建模 + 元认知控制） ──

/**
 * 自我建模契约：系统对自身运行状态的持续观察与结构化认知
 *
 * 双环架构的外环感知端：内环（执行 → 反思 → 记忆 → 优化 → 进化）
 * 的运行质量被持续采集为系统指标，并周期性凝结为心智报告——
 * 策略的优势与盲点、记忆体系的增长与退化、进化器的发现速度与
 * 存活率、系统稳定性与风险点，以及可机器验证的自我改进证据。
 */
export interface ISelfModel {
  /** 生成一份心智报告（持续进程：报告随时间累积形成趋势） */
  generateMentalReport(): Promise<MentalReport>;
  /** 采集系统指标快照（心智报告的原始素材） */
  getSystemMetrics(): Promise<SystemMetrics>;
}

/**
 * 元认知控制契约：基于心智报告自动调整操作环与进化环参数
 *
 * 双环架构的外环决策端——调整「进化机制本身」：
 * - 保守原则：每轮至多小幅调整少量参数，观察效果后再继续
 * - 自动回滚：观察期内判定指标劣化超容忍 → 恢复调整前取值
 * - 审计留痕：全部自动/手动调整全量记录，支持手动覆盖与冻结
 */
export interface IMetaCognitiveController {
  /** 评估最新心智报告并推进调整状态机（应用 / 观察 / 判定保留 / 自动回滚） */
  evaluateAndAdjust(): Promise<AdjustmentReport>;
  /** 手动回滚最近一次调整（观察中或已提交） */
  rollbackLastAdjustment(): Promise<RollbackResult>;
}

// ═══════════════════════════════════════════════════════════════════
// 第三轮模块域升级（A16 · 基础契约层）：运行时契约校验器
//
// 既有接口契约（IMemoryStore / IReflector / IOptimizer / ISandbox /
// IPolicyEvolver / ISelfModel / IMetaCognitiveController）全部原样保留。
// 本节是**纯增量**的轻量运行时校验：
// - SchemaSpec：声明式 schema（类型 / 范围 / 枚举 / 必填 / 嵌套对象 / 数组元素）
// - validate(value, schema, {mode})：fast-fail（首个错误即返）与
//   collect（全量收集）双模式；错误为路径化列表（nodes[2].modelId）
// - 预设 schema：PLAN_NODE_SCHEMA / EXECUTION_PLAN_SCHEMA /
//   NODE_RESULT_SCHEMA / PLAN_EXECUTION_RESULT_SCHEMA——types.ts 核心
//   数据结构的运行时契约化（外部输入进入执行链前的第一道门）
// - validateOrThrow：校验失败抛 VALIDATION_ERROR（与类型化错误体系对接）
//
// 零依赖、确定性：遍历顺序 = schema 声明序（不依赖输入对象键序），
// 错误消息由固定模板生成（同输入同输出）。
// ═══════════════════════════════════════════════════════════════════

/** 标量类型名（integer 是 number 的收窄：Number.isInteger） */
export type SchemaTypeName = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

/** 字段 schema：类型 / 必填 / 枚举 / 范围 / 长度 / 嵌套 */
export interface SchemaSpec {
  /** 值类型 */
  type: SchemaTypeName;
  /** 是否必填（仅 object properties 内生效；缺省 true） */
  required?: boolean;
  /** 枚举白名单（string / number / boolean / null 字面量） */
  enum?: ReadonlyArray<string | number | boolean | null>;
  /** 数值下界（含；number / integer） */
  min?: number;
  /** 数值上界（含；number / integer） */
  max?: number;
  /** 长度下界（含；string / array） */
  minLength?: number;
  /** 长度上界（含；string / array） */
  maxLength?: number;
  /** array 元素 schema */
  items?: SchemaSpec;
  /** object 属性 schema（声明序即校验序） */
  properties?: Readonly<Record<string, SchemaSpec>>;
  /** 是否拒绝 properties 之外的额外键（缺省宽容忽略） */
  additionalProperties?: false;
  /** 允许显式 null（缺省 false：null 按类型不符处理） */
  nullable?: boolean;
  /** 人类可读说明（进错误消息，提高可定位性） */
  description?: string;
}

/** 路径化校验错误 */
export interface ValidationError {
  /** 值路径（根为 ''；字段 'a'；嵌套 'a.b'；数组 'a[2].b'） */
  path: string;
  /** 确定性错误消息（固定模板） */
  message: string;
  /** 期望的契约描述 */
  expected: string;
  /** 实际值的人类可读摘要（确定性：JSON 截断到 120 字符） */
  actual: string;
}

/** 校验结果：ok 判别 + 错误列表（fast 模式 ≤1 条；collect 模式全量） */
export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

/** 校验模式：fast = 首个错误即返（热路径）；collect = 全量收集（表单/批量） */
export type ValidationMode = 'fast' | 'collect';

/** 校验选项 */
export interface ValidateOptions {
  mode?: ValidationMode;
  /** 根路径名（默认 ''；用于复用校验器校验子对象时的消息前缀） */
  rootPath?: string;
}

/** 期望描述的确定性摘要（进 expected 字段） */
function describeSpec(spec: SchemaSpec): string {
  const parts: string[] = [spec.type];
  if (spec.enum !== undefined) parts.push(`enum(${spec.enum.map((v) => String(v)).join('|')})`);
  if (spec.min !== undefined) parts.push(`min=${spec.min}`);
  if (spec.max !== undefined) parts.push(`max=${spec.max}`);
  if (spec.minLength !== undefined) parts.push(`minLength=${spec.minLength}`);
  if (spec.maxLength !== undefined) parts.push(`maxLength=${spec.maxLength}`);
  if (spec.description !== undefined) parts.push(`(${spec.description})`);
  return parts.join(' ');
}

/** 实际值的确定性摘要（JSON 序列化，截断 120 字符） */
function describeActual(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? JSON.stringify(value) : value === undefined ? 'undefined' : JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = 'undefined';
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** 值是否匹配标量类型 */
function matchesType(value: unknown, type: SchemaTypeName): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
  }
}

/**
 * 运行时契约校验：值 → {ok, errors}
 *
 * 遍历确定性：object 按 properties 声明序、array 按索引序；
 * 同一输入恒产生同一错误列表（顺序与内容均稳定）。
 */
export function validate(value: unknown, schema: SchemaSpec, options: ValidateOptions = {}): ValidationResult {
  const mode: ValidationMode = options.mode ?? 'collect';
  const errors: ValidationError[] = [];
  const prefix = options.rootPath ?? '';
  validateNode(value, schema, prefix, mode, errors);
  return { ok: errors.length === 0, errors };
}

function shouldStop(mode: ValidationMode, errors: ValidationError[]): boolean {
  return mode === 'fast' && errors.length > 0;
}

function validateNode(value: unknown, spec: SchemaSpec, path: string, mode: ValidationMode, errors: ValidationError[]): void {
  const label = path === '' ? '根值' : path;
  const expected = describeSpec(spec);

  // null / undefined 处理
  if (value === null) {
    if (spec.nullable === true) return;
    errors.push({ path, message: `${label} 不允许为 null（schema 未声明 nullable）`, expected, actual: 'null' });
    return;
  }
  if (value === undefined) {
    // 必填判定在父级（properties）做；根级 undefined 直接类型不符
    if (path === '') {
      errors.push({ path, message: '根值缺失（undefined）', expected, actual: 'undefined' });
    }
    return;
  }

  // 类型判定
  if (!matchesType(value, spec.type)) {
    errors.push({
      path,
      message: `${label} 类型不符：期望 ${spec.type}，实际 ${Array.isArray(value) ? 'array' : typeof value}`,
      expected,
      actual: describeActual(value),
    });
    return; // 类型不符时不再做后续检查（范围/枚举/嵌套无意义）
  }

  // 枚举
  if (spec.enum !== undefined && !spec.enum.some((candidate) => candidate === value)) {
    errors.push({
      path,
      message: `${label} 不在枚举白名单内：${spec.enum.map((v) => String(v)).join('|')}`,
      expected,
      actual: describeActual(value),
    });
    if (shouldStop(mode, errors)) return;
  }

  // 数值范围
  if (spec.type === 'number' || spec.type === 'integer') {
    const num = value as number;
    if (spec.min !== undefined && num < spec.min) {
      errors.push({ path, message: `${label} 低于下界：${num} < ${spec.min}`, expected, actual: describeActual(value) });
      if (shouldStop(mode, errors)) return;
    }
    if (spec.max !== undefined && num > spec.max) {
      errors.push({ path, message: `${label} 超过上界：${num} > ${spec.max}`, expected, actual: describeActual(value) });
      if (shouldStop(mode, errors)) return;
    }
  }

  // 字符串/数组长度
  if (spec.type === 'string' || spec.type === 'array') {
    const length = spec.type === 'string' ? (value as string).length : (value as unknown[]).length;
    if (spec.minLength !== undefined && length < spec.minLength) {
      errors.push({ path, message: `${label} 长度 ${length} 低于 minLength=${spec.minLength}`, expected, actual: describeActual(value) });
      if (shouldStop(mode, errors)) return;
    }
    if (spec.maxLength !== undefined && length > spec.maxLength) {
      errors.push({ path, message: `${label} 长度 ${length} 超过 maxLength=${spec.maxLength}`, expected, actual: describeActual(value) });
      if (shouldStop(mode, errors)) return;
    }
  }

  // 数组元素
  if (spec.type === 'array' && spec.items !== undefined) {
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i += 1) {
      validateNode(arr[i], spec.items, `${path}[${i}]`, mode, errors);
      if (shouldStop(mode, errors)) return;
    }
  }

  // 对象属性（声明序遍历）
  if (spec.type === 'object' && spec.properties !== undefined) {
    const obj = value as Record<string, unknown>;
    for (const [key, childSpec] of Object.entries(spec.properties)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      const childValue = obj[key];
      if (childValue === undefined) {
        if (childSpec.required !== false) {
          errors.push({ path: childPath, message: `${childPath} 为必填字段（缺失或 undefined）`, expected: describeSpec(childSpec), actual: 'undefined' });
          if (shouldStop(mode, errors)) return;
        }
        continue;
      }
      validateNode(childValue, childSpec, childPath, mode, errors);
      if (shouldStop(mode, errors)) return;
    }
    // 额外键拒绝
    if (spec.additionalProperties === false) {
      const allowed = new Set(Object.keys(spec.properties));
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          errors.push({ path: path === '' ? key : `${path}.${key}`, message: `${path === '' ? key : `${path}.${key}`} 为未声明的额外字段（additionalProperties=false）`, expected: '仅 schema 声明的字段', actual: describeActual(obj[key]) });
          if (shouldStop(mode, errors)) return;
        }
      }
    }
  }
}

/** 校验失败即抛：TypedAppError(VALIDATION_ERROR)，details.errors 为路径化错误列表 */
export function validateOrThrow(value: unknown, schema: SchemaSpec, options: ValidateOptions = {}): void {
  const result = validate(value, schema, options);
  if (!result.ok) {
    throw new TypedAppError(`运行时契约校验失败：${result.errors.map((e) => `${e.path || '(root)'} ${e.message}`).join('; ')}`, {
      code: 'VALIDATION_ERROR',
      details: { errors: result.errors },
    });
  }
}

// ── 预设 schema：types.ts 核心数据结构的运行时契约 ──

/** PlanNode 运行时契约（id / description / type / dependsOn / 可选 modelId / timeout / cascade） */
export const PLAN_NODE_SCHEMA: SchemaSpec = {
  type: 'object',
  description: 'PlanNode',
  properties: {
    id: { type: 'string', minLength: 1, description: '节点 id' },
    description: { type: 'string', minLength: 1, description: '节点任务描述' },
    type: { type: 'string', minLength: 1, description: '任务类型' },
    dependsOn: { type: 'array', items: { type: 'string', minLength: 1, description: '依赖节点 id' }, description: '依赖列表' },
    modelId: { type: 'string', minLength: 1, required: false, description: '指定模型（可选）' },
    timeout: { type: 'number', min: 0, required: false, description: '节点级超时毫秒（可选）' },
    cascade: {
      type: 'array',
      required: false,
      description: '级联触发（可选）',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
        },
      },
    },
  },
};

/** ExecutionPlan 运行时契约（objective / nodes / parallelismStrategy / source 枚举） */
export const EXECUTION_PLAN_SCHEMA: SchemaSpec = {
  type: 'object',
  description: 'ExecutionPlan',
  properties: {
    objective: { type: 'string', minLength: 1, description: '目标描述' },
    nodes: { type: 'array', minLength: 1, items: PLAN_NODE_SCHEMA, description: 'DAG 节点列表' },
    parallelismStrategy: { type: 'string', minLength: 1, description: '并行策略' },
    source: { type: 'string', enum: ['strategist', 'fallback', 'memory'], description: '计划来源' },
  },
};

/** NodeResult 运行时契约（quality 0~1 / 非负延迟 / 非负计数） */
export const NODE_RESULT_SCHEMA: SchemaSpec = {
  type: 'object',
  description: 'NodeResult',
  properties: {
    nodeId: { type: 'string', minLength: 1 },
    modelId: { type: 'string', minLength: 1 },
    success: { type: 'boolean' },
    output: { type: 'string', required: false },
    quality: { type: 'number', min: 0, max: 1, description: '质量分 0~1' },
    latency: { type: 'number', min: 0, description: '延迟毫秒' },
    attempts: { type: 'integer', min: 0 },
    error: { type: 'string', required: false },
    tokensUsed: { type: 'integer', min: 0 },
  },
};

/** PlanExecutionResult 运行时契约 */
export const PLAN_EXECUTION_RESULT_SCHEMA: SchemaSpec = {
  type: 'object',
  description: 'PlanExecutionResult',
  properties: {
    planId: { type: 'string', minLength: 1 },
    success: { type: 'boolean' },
    nodeResults: { type: 'array', items: NODE_RESULT_SCHEMA },
    totalTime: { type: 'number', min: 0 },
    successCount: { type: 'integer', min: 0 },
    totalTokens: { type: 'integer', min: 0 },
    avgQuality: { type: 'number', min: 0, max: 1 },
    error: { type: 'string', required: false },
  },
};

// ═══════════════════════════════════════════════════════════════════
// 第四轮模块域升级（R4-A16 · 基础契约层）：API 版本化 / 模式演化 / 不变量库
//
// 同样是**纯增量**：本节不触碰上文任何接口与校验器。
// - API 版本化：语义版本三元组解析 + 请求方/提供方兼容判定与协商
//   （major 相同且请求方 minor ≤ 提供方 minor 即向后兼容；不兼容时
//   给出双方可用的最大公共版本或明确拒绝）
// - 模式演化：SchemaMigrationChain 链式迁移器——升级只许加字段带缺省
//   或按声明删字段（弃用期声明注册时强制）；降级允许丢字段但必须
//   诚实记账（lossless=false + 逐字段 notes），运行时审计强制执行
// - 声明式不变量库：invariant(description, check) 声明 + 注册表 +
//   assertInvariants 一次检查全部（失败清单带描述）
// ═══════════════════════════════════════════════════════════════════

// ── 1. API 版本化：语义版本兼容声明与协商 ──

/** 语义版本三元组（major.minor.patch，各段为非负整数） */
export interface ApiVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * 版本字符串 → 三元组（诚实构造点：格式非法即抛 VALIDATION_ERROR）
 *
 * 只接受严格三段式 `major.minor.patch`（如 '1.4.2'）：
 * '1.2' / 'v1.2.3' / '1.2.3.4' / '1.2.x' / '-1.0.0' / '1.02.3' 全部拒绝
 * （前导零拒绝——避免 '1.02.3' 与 '1.2.3' 一码两形）。
 */
export function parseApiVersion(input: string): ApiVersion {
  if (typeof input !== 'string') {
    throw new TypedAppError(`API 版本必须是字符串，实际 ${typeof input}`, { code: 'VALIDATION_ERROR', details: { input } });
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(input.trim());
  if (match === null) {
    throw new TypedAppError(`API 版本格式非法：${JSON.stringify(input)}（期望 major.minor.patch 三段非负整数）`, {
      code: 'VALIDATION_ERROR',
      details: { input, expected: 'major.minor.patch' },
    });
  }
  // 前导零拒绝（'1.02.3' 的 '02' 即违规），保证一码一形
  if (match[1] !== '0' && match[1].startsWith('0')) {
    throw new TypedAppError(`API 版本段含前导零：${JSON.stringify(input)}`, { code: 'VALIDATION_ERROR', details: { input } });
  }
  if (match[2] !== '0' && match[2].startsWith('0')) {
    throw new TypedAppError(`API 版本段含前导零：${JSON.stringify(input)}`, { code: 'VALIDATION_ERROR', details: { input } });
  }
  if (match[3] !== '0' && match[3].startsWith('0')) {
    throw new TypedAppError(`API 版本段含前导零：${JSON.stringify(input)}`, { code: 'VALIDATION_ERROR', details: { input } });
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** 三元组 → 规范字符串（与 parseApiVersion 互逆） */
export function formatApiVersion(version: ApiVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** 全序比较：major → minor → patch（返回 -1 / 0 / 1） */
export function compareApiVersions(a: ApiVersion, b: ApiVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * 请求方版本 vs 单个提供方版本的兼容分类：
 * - exact          三段完全一致
 * - satisfies      同 major 且提供方 minor ≥ 请求方 minor（向后兼容：
 *                  minor 只增不改义，旧请求可直接打新服务；patch 任意——
 *                  patch 仅承载缺陷修复）
 * - downgrade      同 major 但提供方 minor 更低（请求方需降级读取）
 * - incompatible   major 不同（破坏性变更，明确拒绝）
 */
export type VersionCompatClass = 'exact' | 'satisfies' | 'downgrade' | 'incompatible';

/** 单对版本兼容分类（negotiateApiVersion 的判定原子） */
export function classifyVersionPair(requested: ApiVersion, offered: ApiVersion): VersionCompatClass {
  if (compareApiVersions(requested, offered) === 0) return 'exact';
  if (requested.major !== offered.major) return 'incompatible';
  return offered.minor >= requested.minor ? 'satisfies' : 'downgrade';
}

/** 提供方版本集声明（构造点：解析、去重校验、升序排序——确定性） */
export interface ApiVersionSet {
  /** API / 能力名（如 'dsh.scheduler-tools'） */
  readonly name: string;
  /** 全部支持版本（升序；原始字符串形态） */
  readonly versions: readonly string[];
}

/** 声明一个提供方版本集：逐项解析 + 重名/空集拒绝 */
export function declareApiVersions(name: string, versions: readonly string[]): ApiVersionSet {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypedAppError('版本集 name 不能为空', { code: 'VALIDATION_ERROR', details: { name } });
  }
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new TypedAppError(`版本集 ${name} 至少要声明一个版本`, { code: 'VALIDATION_ERROR', details: { name } });
  }
  const seen = new Set<string>();
  const parsed = versions.map((raw) => {
    const v = parseApiVersion(raw);
    const canonical = formatApiVersion(v);
    if (seen.has(canonical)) {
      throw new TypedAppError(`版本集 ${name} 含重复版本 ${canonical}`, { code: 'VALIDATION_ERROR', details: { name, duplicate: canonical } });
    }
    seen.add(canonical);
    return { raw: canonical, v };
  });
  parsed.sort((a, b) => compareApiVersions(a.v, b.v));
  return { name, versions: parsed.map((p) => p.raw) };
}

/** 版本协商结果（成功带 chosen；失败带 reason 与可选的降级建议 fallback） */
export interface VersionNegotiation {
  readonly ok: boolean;
  /** 请求方原始版本串 */
  readonly requested: string;
  /** 成功时选定的提供方版本（exact 请求串原样；satisfies 取最小可用升级） */
  readonly chosen?: string;
  /** 单对分类（无同 major 版本时为 'incompatible'，空集为 'none'） */
  readonly compatibility: VersionCompatClass | 'none';
  /** 失败原因：major-mismatch 无公共 major / provider-too-old 提供方过旧 / empty-supported 提供方空集 */
  readonly reason?: 'major-mismatch' | 'provider-too-old' | 'empty-supported';
  /** 双方可用的最大公共版本（仅 downgrade 场景：同 major 中提供方最大版本） */
  readonly fallback?: string;
  /** 确定性人类可读结论（进日志/审计） */
  readonly message: string;
}

/**
 * 版本协商：请求方版本 vs 提供方版本集
 *
 * 判定规则（与 classifyVersionPair 同一原子）：
 * 1. 精确命中 → ok，chosen = 请求串
 * 2. 存在 satisfies（同 major 且 minor ≥ 请求方）→ ok，chosen 取**最小**
 *    可用升级（最接近请求的提供方版本——不过度超前）
 * 3. 仅剩 downgrade（同 major 全部更旧）→ 拒绝 + fallback = 同 major
 *    提供方最大版本（双方都能说的最大公共版本：新侧降级读旧格式）
 * 4. 无同 major 版本 → 明确拒绝（major-mismatch，无公共语言）
 */
export function negotiateApiVersion(requested: string, supported: readonly string[]): VersionNegotiation {
  const req = parseApiVersion(requested);
  if (!Array.isArray(supported) || supported.length === 0) {
    return {
      ok: false,
      requested,
      compatibility: 'none',
      reason: 'empty-supported',
      message: `版本协商失败：提供方版本集为空，无法服务请求 ${requested}`,
    };
  }
  const ascending = supported.map((raw) => parseApiVersion(raw)).sort(compareApiVersions);

  // ① 精确命中
  const exact = ascending.find((v) => compareApiVersions(v, req) === 0);
  if (exact !== undefined) {
    return {
      ok: true,
      requested,
      chosen: formatApiVersion(exact),
      compatibility: 'exact',
      message: `版本协商成功：请求 ${requested} 与提供方精确匹配`,
    };
  }

  const sameMajor = ascending.filter((v) => v.major === req.major);

  // ④ 无公共 major
  if (sameMajor.length === 0) {
    const majors = [...new Set(ascending.map((v) => String(v.major)))].join(', ');
    return {
      ok: false,
      requested,
      compatibility: 'incompatible',
      reason: 'major-mismatch',
      message: `版本协商失败：请求 ${requested} 的 major=${req.major} 不在提供方 major 集 {${majors}} 内（破坏性变更，明确拒绝）`,
    };
  }

  // ② 最小可用升级（同 major、minor ≥ 请求方；minor 平局取 patch 较小者=最近）
  const satisfiers = sameMajor.filter((v) => v.minor >= req.minor);
  if (satisfiers.length > 0) {
    const best = satisfiers[0];
    return {
      ok: true,
      requested,
      chosen: formatApiVersion(best),
      compatibility: 'satisfies',
      message: `版本协商成功：请求 ${requested} 由提供方 ${formatApiVersion(best)} 向后兼容服务（同 major、提供方 minor ≥ 请求方）`,
    };
  }

  // ③ 提供方过旧：拒绝 + 双方最大公共版本
  const fallback = sameMajor[sameMajor.length - 1];
  return {
    ok: false,
    requested,
    compatibility: 'downgrade',
    reason: 'provider-too-old',
    fallback: formatApiVersion(fallback),
    message: `版本协商失败：请求 ${requested} 依赖 minor=${req.minor} 的能力，提供方同 major 最新为 ${formatApiVersion(fallback)}；可降级至该公共版本后重试`,
  };
}

// ── 2. 模式演化：向后兼容的 schema 迁移链 ──

/** 迁移单步产物：新值 + 有损标记 + 逐字段记账 */
export interface MigrationOutcome {
  /** 迁移后的数据（本步输出） */
  value: Record<string, unknown>;
  /** 本步是否无损：升级未删任何在场字段应报 true；降级丢字段必须报 false（运行时审计强制） */
  lossless: boolean;
  /** 逐字段记账说明（缺省回填 / 声明弃用移除 / 降级丢失） */
  notes: readonly string[];
}

/** 删除字段的弃用期声明（迁移删除字段时的强制元数据） */
export interface FieldRemovalDeclaration {
  /** 被删除的字段名 */
  readonly field: string;
  /** 首次标记弃用的版本标签（如 'v2'） */
  readonly deprecatedSince: string;
  /** 弃用宽限：声明弃用后再保留的版本数（≥0；0 = 声明即移除） */
  readonly graceVersions: number;
}

/** 一步 schema 迁移（from → to，链式注册） */
export interface SchemaMigration {
  /** 源版本标签（首步必须等于链基版本；后续必须衔接前一步 to） */
  readonly from: string;
  readonly to: string;
  /** 迁移说明（进 MigrationResult 审计） */
  readonly description: string;
  /** 本步删除字段的弃用声明：删除字段的迁移必填（未声明即注册拒绝） */
  readonly removals?: ReadonlyArray<FieldRemovalDeclaration>;
  /** 升级：旧 schema → 新 schema（加字段带缺省 / 仅可删除已声明弃用的字段） */
  readonly up: (data: Record<string, unknown>) => MigrationOutcome;
  /** 降级：新 schema → 旧 schema（丢字段允许，但必须 lossless=false 且逐字段记账） */
  readonly down: (data: Record<string, unknown>) => MigrationOutcome;
}

/** 一次（多步）迁移的完整审计结果 */
export interface MigrationResult {
  /** 起始版本标签 */
  readonly fromVersion: string;
  /** 目标版本标签 */
  readonly toVersion: string;
  /** 途经版本（含起止；如 ['v1','v2','v3']） */
  readonly path: readonly string[];
  /** 迁移产物 */
  readonly value: Record<string, unknown>;
  /** 全程无损（各步 lossless 之与） */
  readonly lossless: boolean;
  /** 全部步骤记账（按步序，带 [from→to] 前缀） */
  readonly notes: readonly string[];
  /** 目标版本 schema 校验（该版本定义了 schema 时给出；恒为通过态——失败即抛） */
  readonly validation?: ValidationResult;
}

/** 迁移运行选项（缺省 from=链基版本 / to=链最新版本） */
export interface MigrationRunOptions {
  from?: string;
  to?: string;
}

/**
 * schema 迁移链：v1 → v2 → v3 … 链式注册、链式应用
 *
 * 注册纪律（违反即 VALIDATION_ERROR，链保持不可污染）：
 * - 连续性：每步 from 必须等于前一步 to（首步等于链基版本）
 * - 删除声明：removals 条目字段名/弃用版本非空、graceVersions 为非负整数
 *
 * 运行时诚实性审计（每步执行后强制）：
 * - 升级：输出中被删的输入字段必须全部在 removals 声明内（未声明删除 → 抛）；
 *   实际删除的声明字段必须出现在 notes（未记账 → 抛）
 * - 降级：每个被删且原值非 undefined 的字段必须被 notes 提及，且
 *   lossless 必须为 false（丢字段谎报无损 → 抛）
 * - 起止版本定义了 schema 时：入口校验输入、出口校验产物（失败即抛，
 *   MigrationResult.validation 携带通过态结果）
 */
export class SchemaMigrationChain {
  private readonly steps: SchemaMigration[] = [];
  private readonly schemasByLabel = new Map<string, SchemaSpec>();
  private readonly versionOrder: string[] = [];

  constructor(
    public readonly name: string,
    options: { baseVersion?: string } = {},
  ) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new TypedAppError('迁移链 name 不能为空', { code: 'VALIDATION_ERROR', details: { name } });
    }
    const base = options.baseVersion ?? 'v1';
    if (typeof base !== 'string' || base.trim().length === 0) {
      throw new TypedAppError('迁移链 baseVersion 不能为空', { code: 'VALIDATION_ERROR' });
    }
    this.versionOrder.push(base);
  }

  /** 链上全部版本标签（升级序：基版本 → … → 最新） */
  versions(): readonly string[] {
    return [...this.versionOrder];
  }

  /** 最新版本标签 */
  latestVersion(): string {
    return this.versionOrder[this.versionOrder.length - 1];
  }

  /** 某版本的 schema（未定义返回 undefined） */
  schemaFor(version: string): SchemaSpec | undefined {
    return this.schemasByLabel.get(version);
  }

  /** 为某个版本定义运行时 schema（可校验入口/出口；重复定义抛） */
  defineVersion(version: string, schema: SchemaSpec): this {
    if (this.schemasByLabel.has(version)) {
      throw new TypedAppError(`版本 ${version} 的 schema 已定义（迁移链 ${this.name}）`, { code: 'VALIDATION_ERROR' });
    }
    this.schemasByLabel.set(version, schema);
    return this;
  }

  /** 注册一步迁移（连续性与删除声明校验；链不可中途污染） */
  register(migration: SchemaMigration): this {
    if (typeof migration?.from !== 'string' || migration.from.trim().length === 0) {
      throw new TypedAppError(`迁移步 from 不能为空（迁移链 ${this.name}）`, { code: 'VALIDATION_ERROR' });
    }
    if (typeof migration?.to !== 'string' || migration.to.trim().length === 0) {
      throw new TypedAppError(`迁移步 to 不能为空（迁移链 ${this.name}）`, { code: 'VALIDATION_ERROR' });
    }
    if (migration.from === migration.to) {
      throw new TypedAppError(`迁移步 from 与 to 相同：${migration.from}`, { code: 'VALIDATION_ERROR' });
    }
    if (typeof migration.description !== 'string' || migration.description.trim().length === 0) {
      throw new TypedAppError(`迁移步 ${migration.from}→${migration.to} 缺少 description`, { code: 'VALIDATION_ERROR' });
    }
    if (typeof migration.up !== 'function' || typeof migration.down !== 'function') {
      throw new TypedAppError(`迁移步 ${migration.from}→${migration.to} 必须同时提供 up/down`, { code: 'VALIDATION_ERROR' });
    }
    const tail = this.versionOrder[this.versionOrder.length - 1];
    if (migration.from !== tail) {
      throw new TypedAppError(
        `迁移链断裂：新步 from=${migration.from} 必须等于链尾 ${tail}（迁移链 ${this.name}）`,
        { code: 'VALIDATION_ERROR', details: { expected: tail, got: migration.from } },
      );
    }
    if (migration.removals !== undefined) {
      for (const removal of migration.removals) {
        if (typeof removal?.field !== 'string' || removal.field.trim().length === 0) {
          throw new TypedAppError(`迁移步 ${migration.from}→${migration.to} 的删除声明缺字段名`, { code: 'VALIDATION_ERROR' });
        }
        if (typeof removal.deprecatedSince !== 'string' || removal.deprecatedSince.trim().length === 0) {
          throw new TypedAppError(`删除声明 ${removal.field} 缺 deprecatedSince（弃用期起点）`, { code: 'VALIDATION_ERROR' });
        }
        if (!Number.isInteger(removal.graceVersions) || removal.graceVersions < 0) {
          throw new TypedAppError(
            `删除声明 ${removal.field} 的 graceVersions 必须为非负整数（实际 ${String(removal.graceVersions)}）`,
            { code: 'VALIDATION_ERROR' },
          );
        }
      }
    }
    this.steps.push(migration);
    this.versionOrder.push(migration.to);
    return this;
  }

  /** 升级：旧数据 → 新 schema（缺省从链基升到最新） */
  migrateUp(data: Record<string, unknown>, options: MigrationRunOptions = {}): MigrationResult {
    const fromIdx = this.indexOfVersion(options.from ?? this.versionOrder[0], 'migrateUp.from');
    const toIdx = this.indexOfVersion(options.to ?? this.latestVersion(), 'migrateUp.to');
    if (toIdx < fromIdx) {
      throw new TypedAppError(
        `migrateUp 方向非法：${this.versionOrder[fromIdx]} → ${this.versionOrder[toIdx]} 是降级（请用 migrateDown）`,
        { code: 'VALIDATION_ERROR' },
      );
    }
    return this.run(data, fromIdx, toIdx, 'up');
  }

  /** 降级：新数据 → 旧 schema（诚实报告丢失字段） */
  migrateDown(data: Record<string, unknown>, options: Required<Pick<MigrationRunOptions, 'from' | 'to'>>): MigrationResult {
    const fromIdx = this.indexOfVersion(options.from, 'migrateDown.from');
    const toIdx = this.indexOfVersion(options.to, 'migrateDown.to');
    if (toIdx > fromIdx) {
      throw new TypedAppError(
        `migrateDown 方向非法：${this.versionOrder[fromIdx]} → ${this.versionOrder[toIdx]} 是升级（请用 migrateUp）`,
        { code: 'VALIDATION_ERROR' },
      );
    }
    return this.run(data, fromIdx, toIdx, 'down');
  }

  private indexOfVersion(version: string, field: string): number {
    const idx = this.versionOrder.indexOf(version);
    if (idx === -1) {
      throw new TypedAppError(
        `版本 ${String(version)} 不在迁移链 ${this.name} 上（${field}；链版本：${this.versionOrder.join(' → ')}）`,
        { code: 'VALIDATION_ERROR' },
      );
    }
    return idx;
  }

  private run(data: Record<string, unknown>, fromIdx: number, toIdx: number, direction: 'up' | 'down'): MigrationResult {
    const fromVersion = this.versionOrder[fromIdx];
    const toVersion = this.versionOrder[toIdx];

    // 入口契约：起始版本 schema（已定义时）校验输入
    const entrySchema = this.schemasByLabel.get(fromVersion);
    if (entrySchema !== undefined) {
      const entry = validate(data, entrySchema, { mode: 'fast' });
      if (!entry.ok) {
        throw new TypedAppError(
          `迁移输入不符合 ${fromVersion} schema（迁移链 ${this.name}）：${entry.errors.map((e) => `${e.path || '(root)'} ${e.message}`).join('; ')}`,
          { code: 'VALIDATION_ERROR', details: { version: fromVersion, errors: entry.errors } },
        );
      }
    }

    // 组装步序（down 按逆序取各步的 down 函数）
    const stepPlan: Array<{ step: SchemaMigration; fn: (data: Record<string, unknown>) => MigrationOutcome }> = [];
    if (direction === 'up') {
      for (let i = fromIdx; i < toIdx; i += 1) stepPlan.push({ step: this.steps[i], fn: this.steps[i].up });
    } else {
      for (let i = fromIdx; i > toIdx; i -= 1) stepPlan.push({ step: this.steps[i - 1], fn: this.steps[i - 1].down });
    }

    let current: Record<string, unknown> = data;
    let lossless = true;
    const notes: string[] = [];
    for (const { step, fn } of stepPlan) {
      const outcome = fn(current);
      if (outcome === null || typeof outcome !== 'object' || typeof outcome.value !== 'object' || outcome.value === null) {
        throw new TypedAppError(
          `迁移步 ${step.from}→${step.to} 的 ${direction} 返回值非法（缺 value 对象）`,
          { code: 'VALIDATION_ERROR' },
        );
      }
      this.auditOutcome(step, direction, current, outcome);
      current = outcome.value;
      lossless = lossless && outcome.lossless === true;
      for (const note of outcome.notes) notes.push(`[${step.from}→${step.to}] ${note}`);
    }

    // 出口契约：目标版本 schema（已定义时）校验产物
    let validation: ValidationResult | undefined;
    const exitSchema = this.schemasByLabel.get(toVersion);
    if (exitSchema !== undefined) {
      validation = validate(current, exitSchema, { mode: 'fast' });
      if (!validation.ok) {
        throw new TypedAppError(
          `迁移产物不符合 ${toVersion} schema（迁移链 ${this.name}）：${validation.errors.map((e) => `${e.path || '(root)'} ${e.message}`).join('; ')}`,
          { code: 'VALIDATION_ERROR', details: { version: toVersion, errors: validation.errors } },
        );
      }
    }

    const path: string[] = [];
    if (direction === 'up') for (let i = fromIdx; i <= toIdx; i += 1) path.push(this.versionOrder[i]);
    else for (let i = fromIdx; i >= toIdx; i -= 1) path.push(this.versionOrder[i]);

    return { fromVersion, toVersion, path, value: current, lossless, notes, ...(validation !== undefined ? { validation } : {}) };
  }

  /** 运行时诚实性审计：升级不删未声明字段；删除要记账；降级丢字段必须报有损 */
  private auditOutcome(step: SchemaMigration, direction: 'up' | 'down', input: Record<string, unknown>, outcome: MigrationOutcome): void {
    const inputKeys = Object.keys(input);
    const outputKeys = new Set(Object.keys(outcome.value));
    const dropped = inputKeys.filter((key) => !outputKeys.has(key));
    const droppedWithValue = dropped.filter((key) => input[key] !== undefined);
    const declared = new Set((step.removals ?? []).map((r) => r.field));
    const noteText = outcome.notes.join(' | ');

    if (direction === 'up') {
      const undeclared = dropped.filter((key) => !declared.has(key));
      if (undeclared.length > 0) {
        throw new TypedAppError(
          `向后兼容升级不允许未声明的字段删除：${undeclared.join('、')}（迁移步 ${step.from}→${step.to}；删除字段必须在 removals 声明弃用期）`,
          { code: 'VALIDATION_ERROR', details: { step: `${step.from}→${step.to}`, undeclared } },
        );
      }
      const unaccounted = droppedWithValue.filter((key) => !noteText.includes(key));
      if (unaccounted.length > 0) {
        throw new TypedAppError(
          `升级删除的已声明字段必须逐字段记账：${unaccounted.join('、')} 未出现在 notes（迁移步 ${step.from}→${step.to}）`,
          { code: 'VALIDATION_ERROR', details: { step: `${step.from}→${step.to}`, unaccounted } },
        );
      }
    } else {
      if (droppedWithValue.length > 0 && outcome.lossless === true) {
        throw new TypedAppError(
          `降级丢弃了 ${droppedWithValue.length} 个字段却声明 lossless=true（迁移步 ${step.from}→${step.to}）——必须报告为有损`,
          { code: 'VALIDATION_ERROR', details: { step: `${step.from}→${step.to}`, droppedWithValue } },
        );
      }
      const unaccounted = droppedWithValue.filter((key) => !noteText.includes(key));
      if (unaccounted.length > 0) {
        throw new TypedAppError(
          `降级丢失字段必须诚实报告：${unaccounted.join('、')} 已丢弃但未出现在 notes（迁移步 ${step.to}→${step.from}）`,
          { code: 'VALIDATION_ERROR', details: { step: `${step.from}→${step.to}`, unaccounted } },
        );
      }
    }
  }
}

// ── 3. 声明式不变量库：模块自声明健康规约 ──

/** 单条不变量声明：id 稳定 + 人类可读描述 + 确定性检查谓词 */
export interface InvariantSpec<S = any> {
  /** 稳定标识（模块前缀约定，如 'memory.budget-nonneg'；缺省取 description） */
  readonly id: string;
  /** 人类可读描述（进违例清单——「失败清单带描述」的载体） */
  readonly description: string;
  /** 检查谓词：true = 满足；抛错按违例记账（不炸断整批检查） */
  readonly check: (subject: S) => boolean;
}

/** 单条违例（含描述与可选的检查期抛错摘要） */
export interface InvariantViolation {
  readonly id: string;
  readonly description: string;
  /** 检查谓词抛错时的消息（谓词返回 false 时无此字段） */
  readonly error?: string;
}

/** 一次全量检查的报告（注册序确定） */
export interface InvariantReport {
  readonly ok: boolean;
  /** 已检查不变量总数 */
  readonly total: number;
  /** 通过数 */
  readonly passedCount: number;
  /** 违例清单（按注册序；带描述） */
  readonly violations: readonly InvariantViolation[];
}

/** 声明一条不变量（id 缺省取 description 本身，保证报告可读且稳定） */
export function invariant<S>(description: string, check: (subject: S) => boolean, id?: string): InvariantSpec<S> {
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new TypedAppError('不变量 description 不能为空', { code: 'VALIDATION_ERROR' });
  }
  if (typeof check !== 'function') {
    throw new TypedAppError(`不变量 ${description} 的 check 必须是函数`, { code: 'VALIDATION_ERROR' });
  }
  const resolvedId = id !== undefined && id.trim().length > 0 ? id : description;
  return { id: resolvedId, description, check };
}

/**
 * 不变量注册表：模块声明自己的健康规约，一次检查全部
 *
 * check：全量检查（谓词抛错按违例记账，不中断）；
 * assert：全量检查后若有违例抛 AggregateAppError（消息含全部违例描述）。
 */
export class InvariantRegistry<S = any> {
  private readonly specsInOrder: InvariantSpec<S>[] = [];
  private readonly byId = new Map<string, InvariantSpec<S>>();

  constructor(public readonly kind: string) {
    if (typeof kind !== 'string' || kind.trim().length === 0) {
      throw new TypedAppError('不变量注册表 kind 不能为空', { code: 'VALIDATION_ERROR' });
    }
  }

  /** 注册一条（id 重复抛——违例清单需要唯一归因） */
  register(spec: InvariantSpec<S>): this {
    if (spec === null || typeof spec !== 'object' || typeof spec.id !== 'string' || spec.id.length === 0 || typeof spec.check !== 'function') {
      throw new TypedAppError(`注册到 ${this.kind} 的不变量形态非法（需 id/check）`, { code: 'VALIDATION_ERROR' });
    }
    if (this.byId.has(spec.id)) {
      throw new TypedAppError(`不变量 id 重复注册：${spec.id}（注册表 ${this.kind}）`, { code: 'VALIDATION_ERROR', details: { id: spec.id } });
    }
    this.byId.set(spec.id, spec);
    this.specsInOrder.push(spec);
    return this;
  }

  /** 批量注册（注册序 = 数组序） */
  registerAll(specs: readonly InvariantSpec<S>[]): this {
    for (const spec of specs) this.register(spec);
    return this;
  }

  /** 已注册清单（注册序） */
  specs(): readonly InvariantSpec<S>[] {
    return [...this.specsInOrder];
  }

  /** 全量检查（不抛；谓词抛错按违例记账） */
  check(subject: S): InvariantReport {
    const violations: InvariantViolation[] = [];
    for (const spec of this.specsInOrder) {
      try {
        if (spec.check(subject) !== true) {
          violations.push({ id: spec.id, description: spec.description });
        }
      } catch (error) {
        violations.push({
          id: spec.id,
          description: spec.description,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      ok: violations.length === 0,
      total: this.specsInOrder.length,
      passedCount: this.specsInOrder.length - violations.length,
      violations,
    };
  }

  /** 全量检查 + 违例即抛 AggregateAppError（失败清单带描述） */
  assert(subject: S): InvariantReport {
    const report = this.check(subject);
    if (!report.ok) {
      throw AggregateAppError.fromChildren(
        report.violations.map((v) => new TypedAppError(v.error !== undefined ? `不变量违例（检查抛错）：${v.description} —— ${v.error}` : `不变量违例：${v.description}`, { code: 'VALIDATION_ERROR', details: { invariantId: v.id } })),
        `${this.kind} 不变量检查失败：${report.violations.length}/${report.total} 条违例`,
      );
    }
    return report;
  }
}

/** 创建不变量注册表（kind = 被检对象的领域名） */
export function createInvariantRegistry<S>(kind: string): InvariantRegistry<S> {
  return new InvariantRegistry<S>(kind);
}

/** 一次性全量检查（无注册表时的轻量入口；specs 序 = 检查序 = 报告序） */
export function checkInvariants<S>(subject: S, specs: readonly InvariantSpec<S>[]): InvariantReport {
  return new InvariantRegistry<S>(`inline(${specs.length})`).registerAll(specs).check(subject);
}

/** 一次性全量检查 + 违例即抛（接受注册表或裸 specs 数组） */
export function assertInvariants<S>(subject: S, target: InvariantRegistry<S> | readonly InvariantSpec<S>[]): InvariantReport {
  if (target instanceof InvariantRegistry) return target.assert(subject);
  return new InvariantRegistry<S>(`inline(${target.length})`).registerAll(target).assert(subject);
}
