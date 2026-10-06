/**
 * decision-engine.ts — 战略决策引擎（闭环"决策"环节深度优化）
 *
 * 职责：在 strategist LLM 决策之上构建四级决策流水线，
 * 让高频/已知信号以近零成本、近零延迟获得决策，LLM 只处理真正的新信号。
 *
 * 四级流水线（命中即返回，逐级下沉）：
 * 1. 规则快速路径（rule）：确定性强的高置信规则
 *    - 重复抑制：同指纹信号在抑制窗口内已成功执行 → dismiss（避免重复劳动）
 *    - 失败升级：同类型连续失败 ≥ N 次 → ask-user（止损，防止无效重试循环）
 *    - 突发提权：occurrences 突发放大 → 提升 urgency
 * 2. 决策缓存（cache）：同指纹信号的历史决策复用（TTL + 结果反馈修正置信度）
 * 3. strategist 模型（strategist）：新信号交给 LLM 决策（注入历史统计上下文）
 * 4. 启发式兜底（heuristic）：strategist 失败时的保守决策
 *
 * 升级点（相对裸 LLM 决策的质的提升）：
 * 1. 成本/影响估算：基于长期记忆的 avgExecutionTime / tokenCost 预估执行成本，
 *    高成本 + 低紧急度 → 自动 defer，把算力留给关键任务
 * 2. 置信度评分：每个决策携带 confidence，低于阈值自动升级为 ask-user
 * 3. 结果反馈闭环：recordOutcome 依据实际结果修正缓存置信度与规则计数器，
 *    决策系统随运行时间自我校准
 * 4. 决策审计：保留最近决策记录，可追溯每个决策的来源与理由
 *
 * 第三轮世界性升级（R3，全部 attach* 挂载式——不挂零漂移）：
 *   - 决策滞后状态机：execute↔defer 双阈值 + 最短驻留期，消除边界抖动
 *   - 反事实决策台账：按上下文桶记录假想臂估计，结局回填滚动后悔统计
 *     （Wilson 区间）——「换一个动作会不会更好」有了量化口径
 *   - ask-user 信息价值门：挂载 95.0 交接 / 97.0 元认知后，低置信升级
 *     经期望成本裁决（x = p·c_auto vs τ* = c_H + c_delay）——高代价
 *     低信心才值得打扰用户
 *   - 上下文分桶校准：规则 C 的全局紧急度线升级为「时段 × 源信誉 ×
 *     同类密度」分桶统计线——上下文漂移（如夜间紧急度虚高）被桶内
 *     失败证据自动纠正，且只收紧不放松（保守改进）
 *   - 决策审计记录：结构化理由（stage / 分数分解 / 置信度 / 内核标记）
 *     导出，自由文本 reason 之外有了机器可读口径
 *
 * 第四轮世界性升级（R4，全部 attach* 挂载式——不挂零漂移）：
 *   - 批量联合决策：同批信号按组归并——同类型 n 条合并为一次代表性
 *     执行（联合成本模型 c×(1+(n−1)·ratio)），互斥信号经确定性仲裁
 *     （urgency > occurrences > receivedAt > id 四级决胜）只放行胜者
 *   - 决策疲劳计量：滑动窗口决策预算，超限后低价值信号自动推迟 /
 *     积压批排（fatigue mode=batch + drainFatigueBacklog），高价值
 *     信号带保护线永不节流
 *   - 失败模式聚类：历史失败决策按「时段×源信誉×紧急度带×动作×成本带」
 *     特征网格聚类，Top 失败模式（失败数 × 失败率 Wilson 上界排序）
 *     ——从结局反馈里挖出「什么样的决策在什么上下文里反复失败」
 *   - 决策路径解释器：四级流水线全程留痕，任意一次决策的完整解释树
 *     （规则 A/B/C 逐条命中/未中与数值 → 缓存 → strategist/启发式 →
 *     低置信门 → 滞后 → 校准 → 终局动作），递归可读渲染
 *   - 决策撤销协议：execute 决策的撤销窗口（未级联前可撤），撤销
 *     成本 = estimatedCost × undoCostRatio，窗口过期 / 已级联拒撤
 */

import crypto from 'node:crypto';
import type { Signal } from './sentinel.js';
import { OpportunityStopper, type StoppingVerdict } from './core/optimal-stopping.js';
// 创世纪 74.0/75.0：镜像下降无悔账本 / 门控在线校准器
import { NoRegretLedger, type NoRegretView } from './engines-frontier/genesis25.js';

// 第二轮创世纪 84.0/95.0/97.0：POMDP 信念规划 / ask-user 交接成本最优 /
// 元认知信心（知道自己不知道才求助）
import {
  pomdpConsult,
  askUserHandoffAdvice,
  MetacognitionLedger,
  shouldAskAdvice,
  type HandoffAdviceView,
  type HandoffConsultInput,
  type PomdpConsultView,
  type POMDP,
} from './engines-frontier/autonomy25.js';
import { gatedCalibrator, type GatedCalibrator, type GatedCalibratorOptions } from './core/online-calibration.js';

/** 决策动作 */
export type DecisionAction = 'execute' | 'defer' | 'dismiss' | 'ask-user';

/** 决策结果 */
export interface Decision {
  action: DecisionAction;
  urgency: number;
  /** 置信度 0~1 */
  confidence: number;
  reason: string;
  /** 决策来源：规则 / 缓存 / strategist / 启发式 */
  source: 'rule' | 'cache' | 'strategist' | 'heuristic';
  deferMs?: number;
  /** 预估执行成本（token 量级） */
  estimatedCost?: number;
  decidedAt: number;
}

/** 决策引擎配置 */
export interface DecisionEngineConfig {
  /** 决策缓存 TTL（毫秒） */
  cacheTtlMs: number;
  /** 缓存容量上限 */
  cacheMaxSize: number;
  /** 重复抑制窗口（毫秒）：窗口内同指纹成功执行过的信号直接 dismiss */
  suppressionWindowMs: number;
  /** 同类型连续失败达到该次数后升级为 ask-user */
  failureEscalationThreshold: number;
  /** 低于该置信度的决策升级为 ask-user */
  lowConfidenceThreshold: number;
  /** 成本延迟比：预估成本超过该值 × 历史均值 且 urgency < 0.3 时 defer */
  costDeferRatio: number;
  /** 突发判定：occurrences 达到该值视为突发 */
  burstOccurrences: number;
  /** strategist 决策器（注入，通常为 LLM 调用） */
  strategist?: (signals: Signal[], context: Map<string, SignalHistoryStats>) => Promise<Map<string, StrategistVerdict>>;
}

/** strategist 对单信号的裁定 */
export interface StrategistVerdict {
  urgency: number;
  decision: DecisionAction;
  reason?: string;
  deferMs?: number;
}

/** 信号历史统计（由长期记忆提供，注入决策上下文） */
export interface SignalHistoryStats {
  totalDecisions: number;
  successRate: number;
  avgExecutionTime: number;
  avgTokenCost: number;
}

/** 决策审计记录 */
export interface DecisionAuditEntry {
  signalId: string;
  fingerprint: string;
  decision: Decision;
  /** 事后结果反馈 */
  outcome?: 'excellent' | 'good' | 'acceptable' | 'poor' | 'failed';
}

/** 缓存条目 */
interface CacheEntry {
  decision: Decision;
  hits: number;
  /** 反馈修正后的置信度 */
  adjustedConfidence: number;
}

// ═══════════════════ R3-1：决策滞后状态机（hysteresis） ═══════════════════

/** 滞后状态机配置 */
export interface DecisionHysteresisOptions {
  /** 换向 execute 需 urgency ≥ 该值（进入高阈值） */
  enterHigh?: number;
  /** 换向 defer 需 urgency < 该值（退出低阈值，须 < enterHigh） */
  exitLow?: number;
  /** 最短驻留期（毫秒）：状态切换后至少驻留这么久才允许再切 */
  minDwellMs?: number;
}

/** 滞后状态机读数 */
export interface DecisionHysteresisView {
  /** 每 signal.type 一条状态机 */
  states: Array<{ signalType: string; action: 'execute' | 'defer'; since: number }>;
  /** 实际完成的换向次数 */
  flips: number;
  /** 被双阈值间隙 / 驻留期抑制的横跳请求数（消除抖动的直接计数） */
  suppressed: number;
}

// ═══════════════════ R3-2：反事实决策台账 ═══════════════════

/** 台账配置 */
export interface CounterfactualLedgerOptions {
  /** 未观测臂的先验价值（缺省 0.5——不知道就当五五开） */
  priorArmValue?: number;
  /** 每动作后悔样本滚动窗口（缺省 256） */
  regretWindow?: number;
  /** 触发 Wilson 区间的最小样本数（缺省 5） */
  wilsonMinSamples?: number;
}

/** 单臂经验统计 */
export interface CounterfactualArmStat {
  action: DecisionAction;
  n: number;
  meanValue: number;
}

/** 按决策类型的滚动后悔统计 */
export interface CounterfactualRegretStat {
  n: number;
  /** 平均后悔（best-other 臂估计 − 实际结局价值，可为负 = 选得更好） */
  meanRegret: number;
  /** 后悔率：后悔 > 0 的决策占比 */
  regretRate: number;
  /** 后悔率的 Wilson 95% 区间（样本充足时给出） */
  wilsonLow?: number;
  wilsonHigh?: number;
}

/** 反事实台账读数 */
export interface CounterfactualView {
  /** 上下文桶 × 各臂经验均值（「换一个动作会怎样」的量化口径） */
  buckets: Array<{ key: string; arms: CounterfactualArmStat[] }>;
  /** 按决策类型的滚动后悔统计（Wilson 区间） */
  regretByAction: Partial<Record<DecisionAction, CounterfactualRegretStat>>;
  window: number;
}

// ═══════════════════ R3-3：ask-user 信息价值门 ═══════════════════

/** 信息价值门成本模型（挂载 95.0/97.0 后生效） */
export interface AskUserGateOptions {
  /** 打扰用户的成本（缺省 500——成本量纲由调用方统一） */
  costHuman?: number;
  /** 用户响应延迟成本（缺省 0） */
  delayCost?: number;
  /** decision.estimatedCost 缺席时的失败代价缺省（缺省 1000） */
  defaultCostAuto?: number;
  /** 97.0 闭式阈的先验错误率（缺省 0.2） */
  priorError?: number;
}

/** 信息价值门裁决计数 */
export interface AskUserGateStats {
  /** 门裁决总次数 */
  total: number;
  /** 维持升级（期望损失确实超过打扰成本） */
  escalated: number;
  /** 拦截升级（低风险不值得打扰——旧规则会多问的次数） */
  spared: number;
}

// ═══════════════════ R3-4：上下文分桶校准 ═══════════════════

/** 分桶校准配置 */
export interface ContextCalibratorOptions {
  /** 桶内最少样本数（缺省 8，不足回退全局线） */
  minSamples?: number;
  /** 失败样本紧急度分位（缺省 0.9——失败证据的高分位作安全线） */
  failQuantile?: number;
  /** 自定义源信誉分（0~1；缺省 manual 0.9 / webhook 0.7 / 其余 0.5） */
  trust?: (source: string) => number;
  /** 自定义时段分桶（缺省 9~18 点 'work'，其余 'off'） */
  hourBuckets?: (hour: number) => string;
}

/** 分桶校准读数 */
export interface ContextCalibrationView {
  buckets: Array<{
    key: string;
    n: number;
    fails: number;
    /** 桶校准线（undefined = 样本不足，回退全局缺省线） */
    threshold?: number;
    applied: number;
  }>;
  /** 全局缺省线（未校准口径） */
  globalLine: number;
}

// ═══════════════════ R3-5：决策审计记录（结构化理由） ═══════════════════

/** 结构化决策理由（自由文本 reason 之外的机器可读口径） */
export interface DecisionRationale {
  /** 决策来源分解：规则 A（重复抑制）/ B（失败升级）/ C（成本闸门）/ 缓存 / strategist / 启发式 */
  stage: 'rule-A' | 'rule-B' | 'rule-C' | 'cache' | 'strategist' | 'heuristic';
  /** 分数分解：进入决策的数值因子 */
  factors: Array<{ name: string; value: number }>;
  /** reason 中的内核标记（〔滞后·换向〕〔信息价值门…〕〔75.0 校准〕等） */
  markers: string[];
  /** 分桶校准挂载时的上下文桶 key */
  contextBucket?: string;
}

/** 结构化审计条目（DecisionAuditEntry + rationale） */
export interface StructuredAuditEntry extends DecisionAuditEntry {
  rationale: DecisionRationale;
}

// ═══════════════════ R4-1：批量联合决策 ═══════════════════

/** 批量联合决策配置 */
export interface BatchJointOptions {
  /** 分组键（缺省 signal.type——同类型视为可合并） */
  groupKey?: (signal: Signal) => string;
  /** 互斥键：同组内该键相同的信号互斥（缺省 undefined = 无互斥） */
  conflictKey?: (signal: Signal) => string | undefined;
  /** 合并触发下限：同组达到该数量才合并（缺省 2） */
  minMergeSize?: number;
  /** 合并执行成本边际比：n 条合并执行成本 = c×(1+(n−1)×ratio)（缺省 0.35） */
  mergeCostRatio?: number;
  /** 注入时钟（确定性验证用，缺省 Date.now） */
  now?: () => number;
}

/** 同组互斥信号的仲裁记录 */
export interface JointConflictRecord {
  /** 互斥键值 */
  key: string;
  /** 胜者（继续参与决策） */
  winnerId: string;
  /** 败者（dismiss，带〔批次·冲突抑制〕标记） */
  loserIds: string[];
  /** 仲裁依据（确定性四级决胜链的可读口径） */
  basis: string;
}

/** 联合组报告 */
export interface JointGroupReport {
  /** 组键（缺省 = signal.type） */
  key: string;
  /** 组内全部信号 */
  signalIds: string[];
  /** 是否合并为单次代表性执行 */
  merged: boolean;
  /** 组终局动作（全体成员共享） */
  action: DecisionAction;
  /** 代表信号 id（合并执行/仲裁胜者） */
  representativeId: string;
  /** 合并节省成本（逐条成本合计 − 联合成本；未合并为 0） */
  savedCost: number;
  /** 联合执行成本（缺省逐条成本的合并模型口径） */
  jointCost: number;
  /** 组内互斥仲裁记录 */
  conflicts: JointConflictRecord[];
}

/** 批量联合决策结果 */
export interface JointBatchResult {
  /** signalId → Decision（合并成员共享代表决策 + 合并标记） */
  decisions: Map<string, Decision>;
  groups: JointGroupReport[];
  /** 本次 strategist 回调实际调用次数（旧逐条口径 = 信号数） */
  strategistInvocations: number;
  /** 合并总节省成本（Σ savedCost） */
  totalSavedCost: number;
}

// ═══════════════════ R4-2：决策疲劳计量 ═══════════════════

/** 疲劳防护配置 */
export interface FatigueGuardOptions {
  /** 滑动窗口长度（毫秒，缺省 60_000） */
  windowMs?: number;
  /** 决策预算：窗口内最多多少次付费决策（缺省 20） */
  budgetPerWindow?: number;
  /** 低价值线：urgency < 该值的信号在疲劳时被推迟（缺省 0.5） */
  lowValueUrgencyBelow?: number;
  /** 高价值保护线：urgency ≥ 该值的信号永不节流（缺省 0.8） */
  highValueUrgency?: number;
  /** 推迟时长（毫秒，缺省 30_000） */
  deferMs?: number;
  /** 疲劳处置模式：defer = 直接推迟；batch = 推迟并积压待批排（缺省 defer） */
  mode?: 'defer' | 'batch';
  /** 积压上限（batch 模式；缺省 64，溢出退化为直接 defer） */
  backlogMax?: number;
  /** 注入时钟（确定性验证用，缺省 Date.now） */
  now?: () => number;
}

/** 疲劳防护读数 */
export interface FatigueGuardView {
  windowMs: number;
  budget: number;
  /** 窗口内已用预算 */
  used: number;
  /** 窗口内决策速率（used/window，次/窗口） */
  ratePerWindow: number;
  /** 当前状态：ok = 预算内，fatigued = 预算耗尽 */
  state: 'ok' | 'fatigued';
  /** 被推迟的低价值信号数 */
  deferred: number;
  /** 高价值信号越过预算放行数（保护证明） */
  protectedPassed: number;
  /** batch 模式积压量 */
  backlog: number;
  /** drainFatigueBacklog 已批排还原的信号数 */
  drained: number;
}

// ═══════════════════ R4-3：失败模式聚类 ═══════════════════

/** 失败聚类配置 */
export interface FailureModeClusterOptions {
  /** 特征提取器（缺省：时段×源信誉×紧急度带×动作×成本带 五元组） */
  features?: (signal: Signal, decision: Decision) => string[];
  /** 每簇滚动样本上限（缺省 256） */
  window?: number;
  /** 簇入选下限：失败样本数 ≥ 该值（缺省 3） */
  minClusterFails?: number;
  /** Top 输出条数（缺省 5） */
  topK?: number;
}

/** 单个失败模式簇 */
export interface FailureModeCluster {
  /** 簇键（特征有序拼接） */
  key: string;
  features: string[];
  n: number;
  fails: number;
  /** 失败率（fails/n） */
  failureRate: number;
  /** 失败率 Wilson 95% 上界（排序次键） */
  wilsonHigh: number;
  /** 簇内失败决策平均成本 */
  meanFailedCost: number;
  /** 最近一条失败决策的 reason（典型样本） */
  sampleReason: string;
}

/** 失败模式读数 */
export interface FailureModeView {
  /** Top 失败模式（失败数降序，平局失败率降序，再簇键字典序——确定性排序） */
  clusters: FailureModeCluster[];
  /** 追踪样本总数 */
  totalTracked: number;
  /** 追踪失败总数 */
  totalFails: number;
}

// ═══════════════════ R4-4：决策路径解释器 ═══════════════════

/** 解释树节点状态 */
export type PathExplainerStatus = 'hit' | 'miss' | 'applied' | 'pass-through' | 'skipped';

/** 解释树节点（递归） */
export interface PathExplainerNode {
  /** 阶段名：fatigue / rule-A / rule-B / rule-C / cache / strategist / heuristic / low-confidence-gate / hysteresis / calibration / optimal-stopping */
  node: string;
  status: PathExplainerStatus;
  /** 结论文本（含数值依据） */
  detail: string;
  /** 进入该阶段判定的数值因子 */
  factors: Array<{ name: string; value: number }>;
  /** 子内核（rule-C 内的停止器 / strategist 内的低置信门等） */
  children: PathExplainerNode[];
}

/** 决策路径解释（一次决策的完整解释树） */
export interface DecisionPathExplanation {
  signalId: string;
  fingerprint: string;
  /** 决策时间戳 */
  at: number;
  /** 流水线逐级评估（评估顺序 = 数组顺序；终止级之后 skipped） */
  pipeline: PathExplainerNode[];
  /** 终局动作快照（与返回的 Decision 逐字段一致） */
  final: Decision;
  /** 终局 reason 的内核标记 */
  markers: string[];
  /** 递归缩进的可读渲染 */
  rendered: string;
}

// ═══════════════════ R4-5：决策撤销协议 ═══════════════════

/** 撤销协议配置 */
export interface UndoProtocolOptions {
  /** 撤销窗口（毫秒，缺省 120_000） */
  windowMs?: number;
  /** 撤销成本 = 决策 estimatedCost × 该比率（缺省 0.2） */
  undoCostRatio?: number;
  /** estimatedCost 缺席时的成本基线（缺省 1000） */
  defaultCost?: number;
  /** 注入时钟（确定性验证用，缺省 Date.now） */
  now?: () => number;
}

/** 撤销窗口读数 */
export interface UndoWindowView {
  signalId: string;
  fingerprint: string;
  openedAt: number;
  /** 距窗口关闭剩余毫秒（已过期为 0） */
  remainingMs: number;
  costEstimate: number;
  cascaded: boolean;
}

/** 撤销结果 */
export type UndoResult =
  | { undone: true; signalId: string; action: DecisionAction; costEstimate: number; windowRemainingMs: number }
  | { undone: false; reason: 'not-found' | 'window-expired' | 'cascaded'; detail: string };

/** 默认配置 */
export const DEFAULT_DECISION_ENGINE_CONFIG: DecisionEngineConfig = {
  cacheTtlMs: 10 * 60_000,
  cacheMaxSize: 512,
  suppressionWindowMs: 5 * 60_000,
  failureEscalationThreshold: 3,
  lowConfidenceThreshold: 0.4,
  costDeferRatio: 3,
  burstOccurrences: 5,
};

/** outcome → 决策质量数值 */
const OUTCOME_VALUE: Record<string, number> = {
  excellent: 1,
  good: 0.8,
  acceptable: 0.6,
  poor: 0.3,
  failed: 0,
};

/** 规则 C 的全局低紧急判定线（R3-4 前的魔数口径，抽名为常量供分桶对照） */
const DECISION_LOW_URGENCY_LINE = 0.3;

/** 四级决策动作全集（反事实台账的臂空间） */
const ALL_ACTIONS: readonly DecisionAction[] = ['execute', 'defer', 'dismiss', 'ask-user'];

/** 数值夹取到 [0,1]（非法输入回落 0.5——配置鲁棒性） */
function clamp01ish(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
}

/** 经验分位（线性插值；空数组返回 NaN） */
function quantile(sortedValues: ReadonlyArray<number>, q: number): number {
  if (sortedValues.length === 0) return Number.NaN;
  const sorted = [...sortedValues].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Wilson 95% 置信区间（比例的紧凑区间——后悔率的不确定性口径） */
function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - spread), high: Math.min(1, center + spread) };
}

/** 缺省源信誉：manual 0.9 / webhook 0.7 / 其余 0.5（分桶 'hi' ≥ 0.65） */
function defaultSourceTrust(source: string): number {
  const head = source.split(':')[0];
  if (head === 'manual' || source.startsWith('manual')) return 0.9;
  if (head === 'webhook' || source.startsWith('webhook')) return 0.7;
  return 0.5;
}

/** 从 signal 归纳上下文桶 key：时段 × 源信誉 × 同类密度 */
function contextBucketOf(signal: Signal, trust?: (source: string) => number, hourBuckets?: (hour: number) => string): string {
  const hour = new Date(signal.receivedAt).getHours();
  const hb = hourBuckets ? hourBuckets(hour) : hour >= 9 && hour < 18 ? 'work' : 'off';
  const t = trust ? trust(signal.source) : defaultSourceTrust(signal.source);
  const tb = t >= 0.65 ? 'hi' : 'lo';
  const db = signal.occurrences >= 3 ? 'dense' : 'sparse';
  return `${hb}/${tb}/${db}`;
}

/** 从 decision 推断结构化 stage（规则 A/B/C / cache / strategist / heuristic） */
function inferStage(decision: Decision): DecisionRationale['stage'] {
  if (decision.source === 'rule') {
    if (decision.reason.startsWith('重复抑制')) return 'rule-A';
    if (decision.reason.includes('连续失败')) return 'rule-B';
    return 'rule-C';
  }
  return decision.source;
}

/** 紧急度带（0.2 步长五带——失败聚类的特征维度之一） */
function urgencyBand(u: number): string {
  if (!Number.isFinite(u)) return 'unknown';
  if (u < 0.2) return 'u<0.2';
  if (u < 0.4) return 'u0.2-0.4';
  if (u < 0.6) return 'u0.4-0.6';
  if (u < 0.8) return 'u0.6-0.8';
  return 'u>=0.8';
}

/** 成本带（无成本 / 低 / 中 / 高——失败聚类的特征维度之一） */
function costBand(cost: number | undefined): string {
  if (cost === undefined || !Number.isFinite(cost) || cost <= 0) return 'no-cost';
  if (cost < 1000) return 'cost<1k';
  if (cost < 10000) return 'cost1k-10k';
  return 'cost>=10k';
}

/** 缺省失败特征：时段 × 源信誉 × 紧急度带 × 动作 × 成本带（确定性网格） */
function defaultFailureFeatures(signal: Signal, decision: Decision): string[] {
  const hour = new Date(signal.receivedAt).getHours();
  const hb = hour >= 9 && hour < 18 ? 'work' : 'off';
  const tb = defaultSourceTrust(signal.source) >= 0.65 ? 'trust-hi' : 'trust-lo';
  return [hb, tb, urgencyBand(decision.urgency), decision.action, costBand(decision.estimatedCost)];
}

/**
 * 信号优先级四级决胜（批量联合决策的仲裁与代表选择共用）：
 * urgency 高者胜 → occurrences 高者胜 → 先到者胜（receivedAt 小者胜）
 * → id 字典序小者胜——全平不可能（id 唯一），保证确定性全序。
 */
function signalPriority(a: Signal, b: Signal): number {
  const ua = typeof a.urgency === 'number' && Number.isFinite(a.urgency) ? a.urgency : 0;
  const ub = typeof b.urgency === 'number' && Number.isFinite(b.urgency) ? b.urgency : 0;
  if (ua !== ub) return ub - ua;
  if (a.occurrences !== b.occurrences) return b.occurrences - a.occurrences;
  if (a.receivedAt !== b.receivedAt) return a.receivedAt - b.receivedAt;
  return a.id < b.id ? -1 : 1;
}

/** 仲裁依据的可读口径（与 signalPriority 的四级决胜链一一对应） */
function priorityBasis(winner: Signal, loser: Signal): string {
  const uw = typeof winner.urgency === 'number' ? winner.urgency : 0;
  const ul = typeof loser.urgency === 'number' ? loser.urgency : 0;
  if (uw !== ul) return `urgency ${uw.toFixed(2)} > ${ul.toFixed(2)}`;
  if (winner.occurrences !== loser.occurrences) return `occurrences ${winner.occurrences} > ${loser.occurrences}`;
  if (winner.receivedAt !== loser.receivedAt) return `先到 ${winner.id}（receivedAt ${winner.receivedAt} < ${loser.receivedAt}）`;
  return `id 字典序 ${winner.id} < ${loser.id}`;
}

/** 解释树递归渲染（缩进可读——detail 自带数值依据，无需外部状态） */
function renderExplainerNode(node: PathExplainerNode, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth);
  const factors = node.factors.length > 0 ? `（${node.factors.map((f) => `${f.name}=${f.value}`).join(', ')}）` : '';
  out.push(`${pad}- ${node.node} [${node.status}] ${node.detail}${factors}`);
  for (const child of node.children) renderExplainerNode(child, depth + 1, out);
}

/** 决策引擎统计（运维可观测） */
export interface DecisionEngineStats {
  total: number;
  ruleHits: number;
  cacheHits: number;
  strategistCalls: number;
  heuristicFallbacks: number;
  cacheSize: number;
  cacheHitRate: number;
  ruleHitRate: number;
  consecutiveFailures: Record<string, number>;
}

/**
 * 战略决策引擎
 *
 * 被 index.ts 编排层持有：processBatch 的第 3~4 步由本引擎完成。
 */
export class DecisionEngine {
  private config: DecisionEngineConfig;
  private cache = new Map<string, CacheEntry>();
  /** 类型 → 连续失败计数 */
  private consecutiveFailures = new Map<string, number>();
  /** 指纹 → 最近成功执行时间（重复抑制用） */
  private recentSuccess = new Map<string, number>();
  /** 决策审计环形缓冲 */
  private audit: DecisionAuditEntry[] = [];
  private stats = { total: 0, ruleHits: 0, cacheHits: 0, strategistCalls: 0, heuristicFallbacks: 0 };
  /** 19.0：机会停止器（挂载后 defer/execute 由继续价值阈值裁决） */
  private stopper?: OpportunityStopper;
  /** 19.0：defer 窗口内的预计剩余机会数（继续价值 V_{k−1} 的口径） */
  private stopperHorizon = 3;
  /** 19.0：停止器裁决审计（最近若干次） */
  private stopperVerdicts: Array<{ signalType: string; at: number; act: boolean; value: number; threshold: number }> = [];
  /** 75.0：门控在线校准器（未挂载零介入——概率口径前置层） */
  private probabilityCalibrator?: GatedCalibrator;
  /** 75.0：待校准预报队列（fingerprint → 决策时置信度；结局到达即配对消费） */
  private calibrationQueue = new Map<string, number>();
  /** 74.0：无悔路由账本（未挂载零介入——咨询口径） */
  private noRegretLedger?: NoRegretLedger;

  // ── 第三轮 R3 状态（全部挂载式，缺省零介入） ──
  /** R3-1：滞后状态机（execute↔defer 双阈值 + 驻留期） */
  private hysteresisEnabled?: boolean;
  private hysteresisCfg: Required<DecisionHysteresisOptions> = { enterHigh: 0.65, exitLow: 0.45, minDwellMs: 30_000 };
  private hysteresisStates = new Map<string, { action: 'execute' | 'defer'; since: number }>();
  private hysteresisCounters = { flips: 0, suppressed: 0 };

  /** R3-2：反事实台账（上下文桶 × 假想臂 × 滚动后悔） */
  private cfEnabled?: boolean;
  private cfCfg: Required<CounterfactualLedgerOptions> = { priorArmValue: 0.5, regretWindow: 256, wilsonMinSamples: 5 };
  private cfBuckets = new Map<string, Map<DecisionAction, { n: number; sum: number }>>();
  private cfQueue = new Map<string, Array<{ ctxKey: string; chosen: DecisionAction; armEstimates: Partial<Record<DecisionAction, number>> }>>();
  private cfRegret = new Map<DecisionAction, number[]>();

  /** R3-3：ask-user 信息价值门成本模型（生效条件 = 95.0/97.0 已挂载） */
  private askGateCfg: Required<AskUserGateOptions> = { costHuman: 500, delayCost: 0, defaultCostAuto: 1000, priorError: 0.2 };
  private askGateStats: AskUserGateStats = { total: 0, escalated: 0, spared: 0 };

  /** R3-4：上下文分桶校准（时段 × 源信誉 × 同类密度） */
  private ctxCalEnabled?: boolean;
  private ctxCalCfg: Required<Pick<ContextCalibratorOptions, 'minSamples' | 'failQuantile'>> = { minSamples: 8, failQuantile: 0.9 };
  private ctxCalTrust?: (source: string) => number;
  private ctxCalHourBuckets?: (hour: number) => string;
  private ctxBuckets = new Map<string, Array<{ urgency: number; good: boolean }>>();
  private ctxQueue = new Map<string, Array<{ bucket: string; urgency: number }>>();
  private ctxApplied = new Map<string, number>();

  /** R3-5：结构化审计捕获 */
  private rationaleCaptureEnabled?: boolean;
  private structuredAudit: StructuredAuditEntry[] = [];

  // ── 第四轮 R4 状态（全部挂载式，缺省零介入） ──
  /** R4-1：批量联合决策 */
  private jointEnabled?: boolean;
  private jointCfg: Required<Omit<BatchJointOptions, 'groupKey' | 'conflictKey'>> = {
    minMergeSize: 2,
    mergeCostRatio: 0.35,
    now: () => Date.now(),
  };
  private jointGroupKey?: (signal: Signal) => string;
  private jointConflictKey?: (signal: Signal) => string | undefined;
  /** strategist 回调调用计数（联合决策的成本口径——decide 前后差分） */
  private strategistInvokeCount = 0;

  /** R4-2：决策疲劳计量（滑动窗口预算 + 低价值推迟/积压批排） */
  private fatigueEnabled?: boolean;
  private fatigueCfg: Required<Omit<FatigueGuardOptions, 'mode'>> = {
    windowMs: 60_000,
    budgetPerWindow: 20,
    lowValueUrgencyBelow: 0.5,
    highValueUrgency: 0.8,
    deferMs: 30_000,
    backlogMax: 64,
    now: () => Date.now(),
  };
  private fatigueMode: 'defer' | 'batch' = 'defer';
  private fatigueTimestamps: number[] = [];
  private fatigueCounters = { deferred: 0, protectedPassed: 0, drained: 0 };
  private fatigueBacklog: Signal[] = [];
  private fatigueDraining = false;

  /** R4-3：失败模式聚类（特征网格 × Top 失败模式） */
  private failClusterEnabled?: boolean;
  private failClusterCfg: Required<Omit<FailureModeClusterOptions, 'features'>> = { window: 256, minClusterFails: 3, topK: 5 };
  private failClusterFeatures?: (signal: Signal, decision: Decision) => string[];
  private failClusterTable = new Map<string, { key: string; features: string[]; outcomes: number[]; failedCosts: number[]; lastFailReason: string }>();
  private clusterQueue = new Map<string, Array<{ features: string[]; cost: number; reason: string }>>();

  /** R4-4：决策路径解释器（四级流水线全程留痕） */
  private explainerEnabled?: boolean;
  private explanations = new Map<string, DecisionPathExplanation>();
  /** 一次 decide() 调用内的活动留痕（signalId → 节点草稿）；调用结束即结算 */
  private traceDrafts: Map<string, { fingerprint: string; nodes: PathExplainerNode[] }> | undefined;
  /** 流水线标准级序（skipped 填充的顺序口径） */
  private static readonly PIPELINE_STAGES = ['fatigue', 'rule-A', 'rule-B', 'rule-C', 'cache', 'strategist', 'heuristic'] as const;

  /** R4-5：决策撤销协议（execute 的可撤窗口 + 级联封锁） */
  private undoEnabled?: boolean;
  private undoCfg: Required<UndoProtocolOptions> = { windowMs: 120_000, undoCostRatio: 0.2, defaultCost: 1000, now: () => Date.now() };
  private undoRegistry = new Map<string, { fingerprint: string; action: DecisionAction; openedAt: number; cost: number; cascaded: boolean }>();

  constructor(config?: Partial<DecisionEngineConfig>) {
    this.config = { ...DEFAULT_DECISION_ENGINE_CONFIG, ...config };
  }

  /**
   * 19.0：挂载最优停止内核（幂等；挂载后规则 C 的成本闸门从
   * 「urgency < 0.3 且 cost > 5000 → defer」的魔数口径升级为
   * 继续价值裁决：每类信号的紧急度流喂入经验分布，defer 窗口内
   * 预计还有 horizon 次同类机会——当前紧急度 ≥ V_{horizon}（向后
   * 归纳精确阈值）即执行（占坑数学最优），否则 defer（等待有价）。
   * 不 attach 即零漂移（原魔数规则）。
   */
  attachOptimalStopper(options?: { horizon?: number; minSamples?: number }): void {
    this.stopper = new OpportunityStopper({ minSamples: options?.minSamples });
    this.stopperHorizon = Math.max(1, Math.floor(options?.horizon ?? 3));
  }

  /** 19.0：最近停止器裁决审计 */
  getStopperVerdicts(limit = 10): Array<{ signalType: string; at: number; act: boolean; value: number; threshold: number }> {
    return this.stopperVerdicts.slice(-limit);
  }

  /**
   * 75.0：挂载门控在线校准器（幂等覆盖，挂载即生效——概率口径前置层）。
   *
   * 一切「概率直觉」（决策置信度）出链前过 GatedCalibrator：决策时登记
   * p，结局回填 y（failed/poor → 0，其余 → 1）——完美校准期间输出
   * 逐位不变（门控未开恒等直通，零漂移）；失准确证后（drift 哨兵锁存）
   * 输出置信度经 Platt/Isotonic 通道校准并标注〔75.0 校准〕——置信度
   * 低于 lowConfidenceThreshold 的升级语义随之吃到校准收益。
   */
  attachProbabilityCalibrator(options?: GatedCalibratorOptions): void {
    this.probabilityCalibrator = gatedCalibrator(options);
    this.calibrationQueue.clear();
  }

  /** 75.0：校准器状态（未挂载 undefined） */
  calibrationStatus(): ReturnType<GatedCalibrator['status']> | undefined {
    return this.probabilityCalibrator?.status();
  }

  /**
   * 74.0：挂载无悔路由账本（幂等覆盖，挂载即生效——咨询口径）。
   *
   * 每次决策反馈按「行动 × 结局价值」记账，noRegretView() 用 74.0 内核
   * 在历史上重放熵镜像下降——输出事后无悔混合策略 x̄ 与后悔迹线（几何
   * 正确的更新算子，与 31.0 Hedge 记账口径互补而非吞并）。不改变决策
   * 路径（零漂移）。
   */
  attachNoRegretRouter(options?: { mirror?: 'entropic' | 'euclidean'; alpha?: number }): void {
    this.noRegretLedger = new NoRegretLedger(options);
  }

  /** 74.0：无悔混合策略读数（未挂载 / 样本不足时 undefined） */
  noRegretView(): NoRegretView | undefined {
    return this.noRegretLedger?.view();
  }

  /**
   * 84.0：挂载 POMDP 信念规划咨询（幂等覆盖，挂载即生效——咨询口径）。
   *
   * defer/execute/ask-user 在部分可观察下的开销-价值比较：α-VI 点基
   * 下界 × QMDP 上界——信息价值间隙（上界−下界）大 = 「继续听」值钱
   * （ask-user = 一次高精度观测动作）。greedyActionAt 给信念阈值口径
   * 的动作建议。不改变决策路径（零漂移）。
   */
  attachPomdpPlanner(): void {
    this.pomdpPlannerEnabled = true;
  }

  /** 84.0：POMDP 咨询旗标（未挂载零介入） */
  private pomdpPlannerEnabled?: boolean;

  /** 84.0：信念规划读数（未挂载 / 结构非法时 undefined） */
  pomdpActionValue(pomdp: POMDP, belief: ReadonlyArray<number>, horizon?: number): PomdpConsultView | undefined {
    return this.pomdpPlannerEnabled ? pomdpConsult(pomdp, belief, { horizon }) : undefined;
  }

  /**
   * 95.0：挂载 ask-user 交接成本裁决（幂等覆盖，挂载即生效——咨询口径）。
   *
   * 「何时求助」从经验阈值升级为期望成本最优：闭式 τ* = c_H + c_delay，
   * 对期望自动成本分数 x = p·c_auto 应用 handoffPolicy（x > τ* → 人工）。
   * ask-user 的数学 = 84.0 信念价值 + 97.0 元认知信心 + 95.0 交接成本
   * 三内核合龙。不改变决策路径（零漂移）。
   */
  attachHandoffPolicy(): void {
    this.handoffPolicyEnabled = true;
  }

  /** 95.0：交接裁决旗标（未挂载零介入） */
  private handoffPolicyEnabled?: boolean;

  /** 95.0：交接建议读数（未挂载 / 成本模型非法时 undefined） */
  handoffAdvice(input: HandoffConsultInput): HandoffAdviceView | undefined {
    return this.handoffPolicyEnabled ? askUserHandoffAdvice(input) : undefined;
  }

  /**
   * 97.0：挂载元认知信心账本（幂等覆盖，挂载即生效——只读观测口径）。
   *
   * 每批决策回填 (confidence, correct) 对——confidenceAccuracyCurve 出
   * 「哪一档信心在撒谎」，metaDprime 对照 typeOneDprime 出元认知效率
   * M-ratio（低 → 信心不可信 → 求助策略退化为任务难度先验的保守口径）。
   * shouldAsk 咨询给闭式求助阈值。不改变决策路径（零漂移）。
   */
  attachMetacognitiveConfidence(): void {
    this.metacognitionLedger = new MetacognitionLedger();
  }

  /** 97.0：元认知账本（未挂载零介入） */
  private metacognitionLedger?: MetacognitionLedger;

  /** 97.0：回填一次 (信心, 对错) 对（挂载时由决策反馈通道调用） */
  noteMetacognitionPair(confidence: number, correct: boolean): void {
    this.metacognitionLedger?.note(confidence, correct);
  }

  /** 97.0：元认知效率读数（未挂载 / 样本不足时 undefined） */
  metacognitionView(): ReturnType<MetacognitionLedger['view']> {
    return this.metacognitionLedger?.view();
  }

  /** 97.0：求助决策咨询（shouldAsk 闭式转发；未挂载 / 信心非法时 undefined） */
  metacognitiveShouldAsk(confidence: number, model: { costError: number; costAsk: number; priorError: number }): { ask: boolean; posteriorError: number; expectedSaving: number; threshold: number } | undefined {
    return this.metacognitionLedger ? shouldAskAdvice(confidence, model) : undefined;
  }

  // ─────────────────────────── 第三轮 R3 挂载面 ───────────────────────────

  /**
   * R3-1：挂载决策滞后状态机（幂等覆盖，挂载即生效）。
   *
   * execute↔defer 的边界抖动消除：换向 execute 需 urgency ≥ enterHigh，
   * 换向 defer 需 urgency < exitLow（exitLow < enterHigh 的间隙内维持
   * 原状态）；换向还需度过最短驻留期 minDwellMs。旧口径（不挂载）逐位
   * 不变——抖动的信号流照旧直通（零漂移）。
   */
  attachDecisionHysteresis(options?: DecisionHysteresisOptions): void {
    this.hysteresisEnabled = true;
    this.hysteresisCfg = {
      enterHigh: clamp01ish(options?.enterHigh ?? 0.65),
      exitLow: clamp01ish(options?.exitLow ?? 0.45),
      minDwellMs: Math.max(0, options?.minDwellMs ?? 30_000),
    };
    if (this.hysteresisCfg.exitLow >= this.hysteresisCfg.enterHigh) {
      // 间隙为负则退化成单阈值——按工程惯例取中点对折，保证语义自洽
      const mid = (this.hysteresisCfg.exitLow + this.hysteresisCfg.enterHigh) / 2;
      this.hysteresisCfg = { ...this.hysteresisCfg, enterHigh: mid + 0.05, exitLow: mid - 0.05 };
    }
    this.hysteresisStates.clear();
    this.hysteresisCounters = { flips: 0, suppressed: 0 };
  }

  /** R3-1：滞后状态机读数（未挂载 undefined） */
  hysteresisView(): DecisionHysteresisView | undefined {
    if (!this.hysteresisEnabled) return undefined;
    return {
      states: [...this.hysteresisStates].map(([signalType, st]) => ({ signalType, ...st })),
      ...this.hysteresisCounters,
    };
  }

  /**
   * R3-2：挂载反事实决策台账（幂等覆盖，挂载即生效——只读观测口径）。
   *
   * 每次决策按上下文桶（signal.type）快照四臂估计值（有观测的动作用
   * 桶内经验均值，未观测臂用先验）；结局回填后 actual vs 当时的
   * best-other 臂估计 = 一次后悔——按决策类型滚动统计均值后悔、后悔率
   * 与 Wilson 95% 区间。「换一个动作会不会更好」从拍脑袋变成有数可查。
   * 不改变决策路径（零漂移）。
   */
  attachCounterfactualLedger(options?: CounterfactualLedgerOptions): void {
    this.cfEnabled = true;
    this.cfCfg = {
      priorArmValue: options?.priorArmValue ?? 0.5,
      regretWindow: Math.max(16, Math.floor(options?.regretWindow ?? 256)),
      wilsonMinSamples: Math.max(2, Math.floor(options?.wilsonMinSamples ?? 5)),
    };
    this.cfBuckets.clear();
    this.cfQueue.clear();
    this.cfRegret.clear();
  }

  /** R3-2：反事实台账读数（未挂载 undefined） */
  counterfactualView(): CounterfactualView | undefined {
    if (!this.cfEnabled) return undefined;
    const regretByAction: Partial<Record<DecisionAction, CounterfactualRegretStat>> = {};
    for (const [action, samples] of this.cfRegret) {
      if (samples.length === 0) continue;
      const n = samples.length;
      const meanRegret = samples.reduce((s, v) => s + v, 0) / n;
      const hits = samples.filter((v) => v > 0).length;
      const stat: CounterfactualRegretStat = { n, meanRegret, regretRate: hits / n };
      if (n >= this.cfCfg.wilsonMinSamples) {
        const w = wilsonInterval(hits, n);
        stat.wilsonLow = w.low;
        stat.wilsonHigh = w.high;
      }
      regretByAction[action] = stat;
    }
    return {
      buckets: [...this.cfBuckets].map(([key, arms]) => ({
        key,
        arms: [...arms].map(([action, s]) => ({ action, n: s.n, meanValue: s.n > 0 ? s.sum / s.n : 0 })).filter((a) => a.n > 0),
      })).filter((b) => b.arms.length > 0),
      regretByAction,
      window: this.cfCfg.regretWindow,
    };
  }

  /**
   * R3-3：配置 ask-user 信息价值门的成本模型（幂等覆盖）。
   *
   * 门的生效条件是 95.0 交接 / 97.0 元认知任一已挂载（任务语义：挂了
   * 置信+成本口径才值得做期望成本裁决）；二者均未挂载时低置信升级保持
   * 旧规则（零漂移）。本方法只覆盖成本参数，典型用法：
   * attachAskUserValueGate({ costHuman: 5000 })。
   */
  attachAskUserValueGate(options?: AskUserGateOptions): void {
    this.askGateCfg = {
      costHuman: Math.max(0, options?.costHuman ?? 500),
      delayCost: Math.max(0, options?.delayCost ?? 0),
      defaultCostAuto: Math.max(1, options?.defaultCostAuto ?? 1000),
      priorError: clamp01ish(options?.priorError ?? 0.2),
    };
  }

  /** R3-3：门裁决计数（「旧规则会多问的次数」= spared） */
  askUserGateStats(): AskUserGateStats | undefined {
    return this.askGateStats.total > 0 ? { ...this.askGateStats } : undefined;
  }

  /**
   * R3-4：挂载上下文分桶校准（幂等覆盖，挂载即生效）。
   *
   * 紧急度评估升级为「时段 × 源信誉 × 同类密度」分桶统计校准：每桶
   * 收集 (urgency, 结局好坏) 对，桶校准线 = min(失败样本 urgency 的
   * failQuantile 分位, 成功样本中位 urgency)，再与全局缺省线取 max
   * ——只收紧不放松（保守改进：证据确凿才把「低紧急」的判定线上移，
   * 纠正如「夜间低信誉源紧急度虚高」的上下文漂移）。桶样本不足回退
   * 全局线（诚实弃权）。不挂载零漂移（原全局魔数线）。
   */
  attachContextCalibrator(options?: ContextCalibratorOptions): void {
    this.ctxCalEnabled = true;
    this.ctxCalCfg = {
      minSamples: Math.max(4, Math.floor(options?.minSamples ?? 8)),
      failQuantile: Math.min(0.99, Math.max(0.5, options?.failQuantile ?? 0.9)),
    };
    this.ctxCalTrust = options?.trust;
    this.ctxCalHourBuckets = options?.hourBuckets;
    this.ctxBuckets.clear();
    this.ctxQueue.clear();
    this.ctxApplied.clear();
  }

  /** R3-4：分桶校准读数（未挂载 undefined） */
  contextCalibrationView(): ContextCalibrationView | undefined {
    if (!this.ctxCalEnabled) return undefined;
    return {
      buckets: [...this.ctxBuckets].map(([key, samples]) => ({
        key,
        n: samples.length,
        fails: samples.filter((s) => !s.good).length,
        threshold: this.contextThresholdFor(key),
        applied: this.ctxApplied.get(key) ?? 0,
      })),
      globalLine: DECISION_LOW_URGENCY_LINE,
    };
  }

  /**
   * R3-5：挂载结构化审计捕获（幂等覆盖）。
   *
   * 每次决策在自由文本 reason 之外捕获结构化理由：stage（规则 A/B/C /
   * 缓存 / strategist / 启发式）、分数分解（urgency / confidence /
   * estimatedCost 等数值因子）、内核标记（〔滞后·换向〕〔信息价值门〕
   * 〔75.0 校准〕等）、分桶上下文。getStructuredAudit 导出。不改变决策
   * 路径（零漂移）。
   */
  attachRationaleCapture(): void {
    this.rationaleCaptureEnabled = true;
    this.structuredAudit = [];
  }

  /** R3-5：结构化审计导出（未挂载时空数组——零漂移） */
  getStructuredAudit(limit = 20): StructuredAuditEntry[] {
    return this.structuredAudit.slice(-limit);
  }

  // ─────────────────────────── 第四轮 R4 挂载面 ───────────────────────────

  /**
   * R4-1：挂载批量联合决策（幂等覆盖，挂载后 decideJointly 可用）。
   *
   * 同批信号按 groupKey（缺省 type）归组：组内互斥信号（conflictKey 同值）
   * 先经确定性仲裁（urgency > occurrences > receivedAt > id 四级决胜）只放
   * 行胜者，败者 dismiss；余下 ≥ minMergeSize 条合并为一次代表性执行——
   * 只对代表信号走一次完整四级流水线，成员共享终局动作并标注
   * 〔批次·合并执行〕；联合成本模型 c×(1+(n−1)×mergeCostRatio)，
   * 节省 = c×(n−1)×(1−ratio)。不挂载时 decideJointly 抛错、decide()
   * 逐位不变（零漂移）。
   */
  attachBatchJointDecider(options?: BatchJointOptions): void {
    this.jointEnabled = true;
    this.jointCfg = {
      minMergeSize: Math.max(2, Math.floor(options?.minMergeSize ?? 2)),
      mergeCostRatio: Math.min(1, Math.max(0, options?.mergeCostRatio ?? 0.35)),
      now: options?.now ?? (() => Date.now()),
    };
    this.jointGroupKey = options?.groupKey;
    this.jointConflictKey = options?.conflictKey;
  }

  /**
   * R4-1：批量联合决策入口（须先 attachBatchJointDecider）。
   *
   * 返回每信号决策（合并成员共享代表动作）+ 每组报告（merged /
   * conflicts / jointCost / savedCost）+ strategist 实调次数与总节省。
   * 成本对照口径：旧逐条 = Σ 单条成本 + n 次 strategist 调用；新合并 =
   * 联合成本 + 1 次调用。
   */
  async decideJointly(signals: Signal[], history: Map<string, SignalHistoryStats>): Promise<JointBatchResult> {
    if (!this.jointEnabled) {
      throw new Error('DecisionEngine: 批量联合决策未挂载（先 attachBatchJointDecider）');
    }
    const now = this.jointCfg.now();
    const groupOf = this.jointGroupKey ?? ((s: Signal) => s.type);
    // 1) 归组（Map 保插入序——组序 = 首见序，确定性）
    const groups = new Map<string, Signal[]>();
    for (const signal of signals) {
      const key = groupOf(signal);
      const list = groups.get(key);
      if (list) list.push(signal);
      else groups.set(key, [signal]);
    }

    const decisions = new Map<string, Decision>();
    const reports: JointGroupReport[] = [];
    const strategistBefore = this.strategistInvokeCount;

    for (const [key, members] of groups) {
      // 2) 组内互斥仲裁：conflictKey 同值的桶内只放行四级决胜胜者
      const conflicts: JointConflictRecord[] = [];
      const survivors: Signal[] = [];
      const conflictBuckets = new Map<string, Signal[]>();
      for (const signal of members) {
        const ck = this.jointConflictKey?.(signal);
        if (ck === undefined) {
          survivors.push(signal);
          continue;
        }
        const bucket = conflictBuckets.get(ck);
        if (bucket) bucket.push(signal);
        else conflictBuckets.set(ck, [signal]);
      }
      for (const [ck, bucket] of conflictBuckets) {
        if (bucket.length < 2) {
          survivors.push(...bucket);
          continue;
        }
        const ranked = [...bucket].sort(signalPriority);
        const winner = ranked[0];
        const losers = ranked.slice(1);
        conflicts.push({
          key: ck,
          winnerId: winner.id,
          loserIds: losers.map((l) => l.id),
          basis: losers.map((l) => priorityBasis(winner, l)).join('；'),
        });
        survivors.push(winner);
        for (const loser of losers) {
          const loserUrgency = typeof loser.urgency === 'number' && Number.isFinite(loser.urgency) ? loser.urgency : 0.1;
          const dismissed: Decision = {
            action: 'dismiss',
            urgency: loserUrgency,
            confidence: 0.85,
            reason: `〔批次·冲突抑制〕与 ${winner.id} 互斥（${ck}），仲裁依据：${priorityBasis(winner, loser)}——败者让位`,
            source: 'rule',
            decidedAt: now,
          };
        decisions.set(loser.id, dismissed);
        this.stats.ruleHits += 1;
        this.stats.total += 1;
        this.auditDecision(loser, fingerprintOf(loser), dismissed, { skipUndo: true });
        this.seedJointExplanation(
          loser,
          'joint-arbitration',
          `组「${key}」互斥败者：互斥值 ${ck} 与胜者 ${winner.id} 冲突，四级决胜让位（${priorityBasis(winner, loser)}）`,
          [{ name: 'loserUrgency', value: loserUrgency }],
        );
        this.finalizeExplanation(loser.id, dismissed);
        }
      }

      // 3) 合并阶段：≥ minMergeSize 条合并为一次代表性执行（代表走一次完整流水线）
      survivors.sort(signalPriority);
      const representative = survivors[0];
      const rest = survivors.slice(1);
      const mergeable = survivors.length >= this.jointCfg.minMergeSize;
      const repDecision = (await this.decide([representative], history)).get(representative.id)!;
      decisions.set(representative.id, repDecision);

      const perSignalCost =
        repDecision.estimatedCost ?? history.get(representative.type)?.avgTokenCost ?? 0;
      const n = survivors.length;
      const jointCost = mergeable && perSignalCost > 0
        ? perSignalCost * (1 + (n - 1) * this.jointCfg.mergeCostRatio)
        : perSignalCost;
      const savedCost = mergeable && perSignalCost > 0
        ? perSignalCost * (n - 1) * (1 - this.jointCfg.mergeCostRatio)
        : 0;

      for (const member of rest) {
        const shared: Decision = mergeable
          ? {
              ...repDecision,
              reason: `${repDecision.reason}〔批次·合并执行×${n}〕（代表 ${representative.id}）`,
              estimatedCost: jointCost > 0 ? jointCost : repDecision.estimatedCost,
              decidedAt: now,
            }
          : { ...repDecision, reason: `${repDecision.reason}〔批次·独立组〕`, decidedAt: now };
        decisions.set(member.id, shared);
        this.stats.total += 1;
        this.auditDecision(member, fingerprintOf(member), shared, { skipUndo: repDecision.action === 'execute' });
        this.seedJointExplanation(
          member,
          'joint-batch',
          mergeable
            ? `组「${key}」合并成员：共享代表 ${representative.id} 的终局动作（合并 ×${n}，联合成本 ${jointCost.toFixed(0)}）`
            : `组「${key}」未达合并下限：与代表 ${representative.id} 同组独立决策`,
          [
            { name: 'groupSize', value: n },
            { name: 'jointCost', value: jointCost },
            { name: 'savedCost', value: savedCost },
          ],
        );
        this.finalizeExplanation(member.id, shared);
        this.traceDrafts = undefined;
      }

      reports.push({
        key,
        signalIds: members.map((m) => m.id),
        merged: mergeable,
        action: repDecision.action,
        representativeId: representative.id,
        savedCost,
        jointCost,
        conflicts,
      });
    }

    return {
      decisions,
      groups: reports,
      strategistInvocations: this.strategistInvokeCount - strategistBefore,
      totalSavedCost: reports.reduce((s, r) => s + r.savedCost, 0),
    };
  }

  /**
   * R4-2：挂载决策疲劳防护（幂等覆盖，挂载即生效）。
   *
   * 滑动窗口决策预算：窗口内已用满 budgetPerWindow 个决策位后，urgency
   * 低于 lowValueUrgencyBelow 的信号自动推迟（mode=batch 时入积压队列，
   * drainFatigueBacklog 在预算恢复后一次性批排）；urgency ≥
   * highValueUrgency 的高价值信号带保护线永不节流。被推迟决策不占预算
   * （推迟本身就是减压阀）。不挂载零漂移（无预算检查）。
   */
  attachFatigueGuard(options?: FatigueGuardOptions): void {
    this.fatigueEnabled = true;
    this.fatigueCfg = {
      windowMs: Math.max(1, Math.floor(options?.windowMs ?? 60_000)),
      budgetPerWindow: Math.max(1, Math.floor(options?.budgetPerWindow ?? 20)),
      lowValueUrgencyBelow: clamp01ish(options?.lowValueUrgencyBelow ?? 0.5),
      highValueUrgency: clamp01ish(options?.highValueUrgency ?? 0.8),
      deferMs: Math.max(0, Math.floor(options?.deferMs ?? 30_000)),
      backlogMax: Math.max(1, Math.floor(options?.backlogMax ?? 64)),
      now: options?.now ?? (() => Date.now()),
    };
    this.fatigueMode = options?.mode ?? 'defer';
    this.fatigueTimestamps = [];
    this.fatigueCounters = { deferred: 0, protectedPassed: 0, drained: 0 };
    this.fatigueBacklog = [];
  }

  /** R4-2：疲劳防护读数（未挂载 undefined） */
  fatigueView(): FatigueGuardView | undefined {
    if (!this.fatigueEnabled) return undefined;
    const now = this.fatigueCfg.now();
    while (this.fatigueTimestamps.length > 0 && now - this.fatigueTimestamps[0] > this.fatigueCfg.windowMs) {
      this.fatigueTimestamps.shift();
    }
    return {
      windowMs: this.fatigueCfg.windowMs,
      budget: this.fatigueCfg.budgetPerWindow,
      used: this.fatigueTimestamps.length,
      ratePerWindow: this.fatigueTimestamps.length / this.fatigueCfg.budgetPerWindow,
      state: this.fatigueTimestamps.length >= this.fatigueCfg.budgetPerWindow ? 'fatigued' : 'ok',
      ...this.fatigueCounters,
      backlog: this.fatigueBacklog.length,
    };
  }

  /**
   * R4-2：批排积压（mode=batch 时被疲劳推迟的信号在预算恢复后一次性
   * 重新决策——整批共用一次 strategist 调用，即「疲劳后的批量回收」）。
   * 应在疲劳读数回落（state=ok）后调用；分块大小 = 当前剩余预算。
   */
  async drainFatigueBacklog(history: Map<string, SignalHistoryStats>): Promise<Map<string, Decision>> {
    if (!this.fatigueEnabled || this.fatigueDraining || this.fatigueBacklog.length === 0) return new Map();
    const view = this.fatigueView();
    const available = view ? Math.max(0, view.budget - view.used) : this.fatigueCfg.budgetPerWindow;
    const chunk = this.fatigueBacklog.splice(0, Math.max(1, available));
    this.fatigueDraining = true;
    try {
      const drained = await this.decide(chunk, history);
      this.fatigueCounters.drained += chunk.length;
      return drained;
    } finally {
      this.fatigueDraining = false;
    }
  }

  /**
   * R4-3：挂载失败模式聚类（幂等覆盖，挂载即生效——只读观测口径）。
   *
   * 每次决策按特征网格（缺省：时段×源信誉×紧急度带×动作×成本带五元组
   * ，可注入自定义 features 提取器）登记待配对样本，结局回填后按簇累积
   * (结局好坏, 失败成本)；failureModeView 输出 Top 失败模式——失败数
   * 降序、失败率 Wilson 上界降序、簇键字典序的三级确定性排序。不改变
   * 决策路径（零漂移）。
   */
  attachFailureModeClusterer(options?: FailureModeClusterOptions): void {
    this.failClusterEnabled = true;
    this.failClusterCfg = {
      window: Math.max(16, Math.floor(options?.window ?? 256)),
      minClusterFails: Math.max(1, Math.floor(options?.minClusterFails ?? 3)),
      topK: Math.max(1, Math.floor(options?.topK ?? 5)),
    };
    this.failClusterFeatures = options?.features;
    this.failClusterTable.clear();
    this.clusterQueue.clear();
  }

  /** R4-3：Top 失败模式读数（未挂载 undefined） */
  failureModeView(): FailureModeView | undefined {
    if (!this.failClusterEnabled) return undefined;
    const clusters: FailureModeCluster[] = [];
    let totalTracked = 0;
    let totalFails = 0;
    for (const stat of this.failClusterTable.values()) {
      totalTracked += stat.outcomes.length;
      const fails = stat.outcomes.reduce((s, v) => s + v, 0);
      totalFails += fails;
      if (fails < this.failClusterCfg.minClusterFails) continue;
      const n = stat.outcomes.length;
      const rate = fails / n;
      const w = wilsonInterval(fails, n);
      clusters.push({
        key: stat.key,
        features: stat.features,
        n,
        fails,
        failureRate: rate,
        wilsonHigh: w.high,
        meanFailedCost: stat.failedCosts.length > 0 ? stat.failedCosts.reduce((s, c) => s + c, 0) / stat.failedCosts.length : 0,
        sampleReason: stat.lastFailReason,
      });
    }
    clusters.sort((a, b) => (b.fails - a.fails) || (b.failureRate - a.failureRate) || (a.key < b.key ? -1 : 1));
    return { clusters: clusters.slice(0, this.failClusterCfg.topK), totalTracked, totalFails };
  }

  /**
   * R4-4：挂载决策路径解释器（幂等覆盖，挂载即生效——只读观测口径）。
   *
   * decide() 全程留痕：fatigue → 规则 A/B/C（逐条命中/未中与数值）→
   * 缓存 → strategist / 启发式（含低置信门、突发提权）→ 滞后 → 在线
   * 校准 → 终局。所有数值在决策现场捕获（非事后重算——解释与决策
   * 必然逐字段一致）。explain(signalId) 取解释树（含递归缩进渲染）。
   * 不改变决策路径（零漂移）。
   */
  attachPathExplainer(): void {
    this.explainerEnabled = true;
    this.explanations.clear();
    this.traceDrafts = undefined;
  }

  /** R4-4：取某次决策的完整解释树（未挂载 / 无记录 undefined） */
  explain(signalId: string): DecisionPathExplanation | undefined {
    return this.explanations.get(signalId);
  }

  /** R4-4：最近解释列表（决策序，旧→新） */
  getRecentExplanations(limit = 10): DecisionPathExplanation[] {
    const all = [...this.explanations.values()];
    return all.slice(-limit);
  }

  /**
   * R4-5：挂载决策撤销协议（幂等覆盖，挂载即生效）。
   *
   * execute 决策落定时自动开撤销窗（decidedAt 起算 windowMs）；窗口内
   * 且未级联（markCascade 封锁）可 undoDecision 撤销，返回撤销成本估计
   * = estimatedCost × undoCostRatio（缺席用 defaultCost 基线）。批量
   * 合并的成员决策不开窗（合并执行以代表为准）。不改变决策路径（零漂移
   * ——只是登记）。
   */
  attachUndoProtocol(options?: UndoProtocolOptions): void {
    this.undoEnabled = true;
    this.undoCfg = {
      windowMs: Math.max(0, Math.floor(options?.windowMs ?? 120_000)),
      undoCostRatio: Math.min(1, Math.max(0, options?.undoCostRatio ?? 0.2)),
      defaultCost: Math.max(0, options?.defaultCost ?? 1000),
      now: options?.now ?? (() => Date.now()),
    };
    this.undoRegistry.clear();
  }

  /** R4-5：当前打开的撤销窗口（按剩余时间升序——快过期在前） */
  undoWindowView(): UndoWindowView[] {
    if (!this.undoEnabled) return [];
    const now = this.undoCfg.now();
    return [...this.undoRegistry]
      .map(([signalId, rec]) => ({
        signalId,
        fingerprint: rec.fingerprint,
        openedAt: rec.openedAt,
        remainingMs: Math.max(0, rec.openedAt + this.undoCfg.windowMs - now),
        costEstimate: rec.cost * this.undoCfg.undoCostRatio,
        cascaded: rec.cascaded,
      }))
      .sort((a, b) => a.remainingMs - b.remainingMs || (a.signalId < b.signalId ? -1 : 1));
  }

  /** R4-5：标记级联（级联扩散后撤销代价不可控——窗口封锁） */
  markCascade(signalIdOrFingerprint: string): boolean {
    const rec =
      this.undoRegistry.get(signalIdOrFingerprint) ??
      [...this.undoRegistry.values()].find((r) => r.fingerprint === signalIdOrFingerprint);
    if (!rec) return false;
    rec.cascaded = true;
    return true;
  }

  /** R4-5：撤销一次 execute 决策（窗口内且未级联才成功） */
  undoDecision(signalIdOrFingerprint: string): UndoResult {
    if (!this.undoEnabled) {
      return { undone: false, reason: 'not-found', detail: '撤销协议未挂载' };
    }
    let id: string | undefined = this.undoRegistry.has(signalIdOrFingerprint) ? signalIdOrFingerprint : undefined;
    if (id === undefined) {
      for (const [signalId, rec] of this.undoRegistry) {
        if (rec.fingerprint === signalIdOrFingerprint) {
          id = signalId;
          break;
        }
      }
    }
    if (id === undefined) {
      return { undone: false, reason: 'not-found', detail: `无 ${signalIdOrFingerprint} 的撤销窗口（已撤销或从未 execute）` };
    }
    const rec = this.undoRegistry.get(id)!;
    const now = this.undoCfg.now();
    if (rec.cascaded) {
      return { undone: false, reason: 'cascaded', detail: `决策已级联扩散（${id}）——撤销不可控，拒绝` };
    }
    const remaining = rec.openedAt + this.undoCfg.windowMs - now;
    if (remaining <= 0) {
      return { undone: false, reason: 'window-expired', detail: `撤销窗口已过期 ${Math.round(-remaining)}ms（${id}）` };
    }
    this.undoRegistry.delete(id);
    return {
      undone: true,
      signalId: id,
      action: rec.action,
      costEstimate: rec.cost * this.undoCfg.undoCostRatio,
      windowRemainingMs: remaining,
    };
  }

  /**
   * 对一批信号做决策（四级流水线）
   * @param signals 聚合后的信号批次
   * @param history 每类信号的历史统计（长期记忆提供）
   * @returns signalId → Decision
   */
  async decide(signals: Signal[], history: Map<string, SignalHistoryStats>): Promise<Map<string, Decision>> {
    const results = new Map<string, Decision>();
    const needStrategist: Signal[] = [];

    // R4-4：解释器留痕开批（signalId → 节点草稿；结算即出批）
    if (this.explainerEnabled) {
      this.traceDrafts = new Map(signals.map((s) => [s.id, { fingerprint: fingerprintOf(s), nodes: [] }]));
    }

    // 19.0：本批信号的紧急度是「机会价值」的抽样——逐信号喂入
    // 停止器经验分布（规则 C 的继续价值阈值由此积累）
    if (this.stopper) {
      for (const signal of signals) {
        if (typeof signal.urgency === 'number' && Number.isFinite(signal.urgency)) {
          this.stopper.note(signal.type, signal.urgency);
        }
      }
    }

    for (const signal of signals) {
      const fingerprint = fingerprintOf(signal);

      // ── R4-2：疲劳防护筛（未挂载直通，零漂移） ──
      const fatigueDecision = this.fatigueScreen(signal);
      if (fatigueDecision) {
        this.stats.ruleHits += 1;
        results.set(signal.id, fatigueDecision);
        this.auditDecision(signal, fingerprint, fatigueDecision, { skipUndo: true });
        this.finalizeExplanation(signal.id, fatigueDecision);
        continue;
      }

      // ── 第 1 级：规则快速路径 ──
      const ruleDecision = this.applyRules(signal, fingerprint, history.get(signal.type));
      if (ruleDecision) {
        this.stats.ruleHits += 1;
        this.applyHysteresis(signal, ruleDecision);
        results.set(signal.id, ruleDecision);
        this.auditDecision(signal, fingerprint, ruleDecision);
        this.finalizeExplanation(signal.id, ruleDecision);
        continue;
      }

      // ── 第 2 级：决策缓存 ──
      const cached = this.lookupCache(fingerprint, signal.id);
      if (cached) {
        this.stats.cacheHits += 1;
        this.applyHysteresis(signal, cached);
        results.set(signal.id, cached);
        this.auditDecision(signal, fingerprint, cached);
        this.finalizeExplanation(signal.id, cached);
        continue;
      }

      needStrategist.push(signal);
    }

    // ── 第 3 级：strategist 模型 ──
    if (needStrategist.length > 0) {
      this.stats.strategistCalls += 1;
      let verdicts = new Map<string, StrategistVerdict>();
      if (this.config.strategist) {
        try {
          this.strategistInvokeCount += 1; // R4-1：回调实调计数（联合成本口径）
          verdicts = await this.config.strategist(needStrategist, history);
        } catch {
          /* 落入启发式兜底 */
        }
      }
      for (const signal of needStrategist) {
        const fingerprint = fingerprintOf(signal);
        const verdict = verdicts.get(signal.id);
        const stats = history.get(signal.type);
        const decision = verdict
          ? this.fromStrategist(signal, verdict, stats)
          : this.heuristic(signal, stats);
        if (!verdict) this.stats.heuristicFallbacks += 1;
        this.storeCache(fingerprint, decision);
        this.applyHysteresis(signal, decision);
        results.set(signal.id, decision);
        this.auditDecision(signal, fingerprint, decision);
        this.finalizeExplanation(signal.id, decision);
      }
    }

    this.stats.total += signals.length;
    this.traceDrafts = undefined; // 留痕批次收口（未结算草稿不留残）
    return results;
  }

  /**
   * 结果反馈闭环：依据执行结果修正缓存置信度与规则计数器
   * @param signalType 信号类型
   * @param fingerprint 信号指纹（缺省按 type+description 计算需提供 description）
   * @param outcome 执行结果
   */
  recordOutcome(signalType: string, fingerprint: string, outcome: DecisionAuditEntry['outcome']): void {
    // 连续失败计数
    if (outcome === 'failed' || outcome === 'poor') {
      this.consecutiveFailures.set(signalType, (this.consecutiveFailures.get(signalType) ?? 0) + 1);
    } else {
      this.consecutiveFailures.set(signalType, 0);
    }

    // 成功记录用于重复抑制
    if (outcome === 'excellent' || outcome === 'good') {
      this.recentSuccess.set(fingerprint, Date.now());
      this.trimRecentSuccess();
    }

    // 缓存置信度修正
    const entry = this.cache.get(fingerprint);
    if (entry) {
      const value = OUTCOME_VALUE[outcome ?? 'acceptable'] ?? 0.6;
      // 指数加权：新结果占 30%
      entry.adjustedConfidence = entry.adjustedConfidence * 0.7 + value * 0.3;
      entry.decision.confidence = entry.adjustedConfidence;
      // 持续失败的缓存条目淘汰，强制重新决策
      if (entry.adjustedConfidence < 0.2) this.cache.delete(fingerprint);
    }

    // 审计回填（74.0：捕获待回填条目供无悔记账消费）
    let pendingEntry: DecisionAuditEntry | undefined;
    for (let i = this.audit.length - 1; i >= 0; i -= 1) {
      if (this.audit[i].fingerprint === fingerprint && !this.audit[i].outcome) {
        this.audit[i].outcome = outcome;
        pendingEntry = this.audit[i];
        break;
      }
    }

    // R3-5：结构化审计条目同步回填 outcome（与主审计同一配对协议）
    if (this.rationaleCaptureEnabled) {
      for (let i = this.structuredAudit.length - 1; i >= 0; i -= 1) {
        if (this.structuredAudit[i].fingerprint === fingerprint && !this.structuredAudit[i].outcome) {
          this.structuredAudit[i].outcome = outcome;
          break;
        }
      }
    }

    // R3-4 分桶校准：配对消费决策时登记的 (桶, 紧急度)——(urgency, 结局
    // 好坏) 对入桶，供桶校准线迭代。未挂载零介入。
    if (this.ctxCalEnabled) {
      const pending = this.ctxQueue.get(fingerprint);
      if (pending && pending.length > 0) {
        const { bucket, urgency } = pending.shift()!;
        if (pending.length === 0) this.ctxQueue.delete(fingerprint);
        if (Number.isFinite(urgency)) {
          const samples = this.ctxBuckets.get(bucket) ?? [];
          samples.push({ urgency, good: (OUTCOME_VALUE[outcome ?? 'acceptable'] ?? 0.6) >= 0.6 });
          if (samples.length > 512) samples.shift();
          this.ctxBuckets.set(bucket, samples);
        }
      }
    }

    // R4-3 失败模式聚类：结局配对——(特征网格, 结局好坏) 入簇累积。未挂载零介入。
    if (this.failClusterEnabled) {
      const pending = this.clusterQueue.get(fingerprint);
      if (pending && pending.length > 0) {
        const sample = pending.shift()!;
        if (pending.length === 0) this.clusterQueue.delete(fingerprint);
        const good = (OUTCOME_VALUE[outcome ?? 'acceptable'] ?? 0.6) >= 0.6;
        const key = sample.features.join('·');
        const cluster = this.failClusterTable.get(key) ?? {
          key,
          features: sample.features,
          outcomes: [],
          failedCosts: [],
          lastFailReason: sample.reason,
        };
        cluster.outcomes.push(good ? 0 : 1);
        if (cluster.outcomes.length > this.failClusterCfg.window) cluster.outcomes.shift();
        if (!good) {
          cluster.failedCosts.push(sample.cost);
          if (cluster.failedCosts.length > this.failClusterCfg.window) cluster.failedCosts.shift();
          cluster.lastFailReason = sample.reason;
        }
        this.failClusterTable.set(key, cluster);
      }
    }

    // R3-2 反事实台账：结局回填——actual vs 决策时快照的 best-other 臂
    // 估计 = 一次后悔（按决策类型滚动）；同时把 actual 记入桶内选中臂。
    // 未挂载零介入。
    if (this.cfEnabled) {
      const pending = this.cfQueue.get(fingerprint);
      if (pending && pending.length > 0) {
        const snap = pending.shift()!;
        if (pending.length === 0) this.cfQueue.delete(fingerprint);
        const actual = OUTCOME_VALUE[outcome ?? 'acceptable'] ?? 0.6;
        // 桶内选中臂累积观测
        const arms = this.cfBuckets.get(snap.ctxKey) ?? new Map<DecisionAction, { n: number; sum: number }>();
        const armStat = arms.get(snap.chosen) ?? { n: 0, sum: 0 };
        armStat.n += 1;
        armStat.sum += actual;
        arms.set(snap.chosen, armStat);
        this.cfBuckets.set(snap.ctxKey, arms);
        // 后悔 = 当时 best-other 估计 − actual（> 0 = 当时选错了）
        let bestOther = Number.NEGATIVE_INFINITY;
        for (const arm of ALL_ACTIONS) {
          if (arm === snap.chosen) continue;
          const est = snap.armEstimates[arm];
          if (est !== undefined && est > bestOther) bestOther = est;
        }
        if (Number.isFinite(bestOther)) {
          const samples = this.cfRegret.get(snap.chosen) ?? [];
          samples.push(bestOther - actual);
          if (samples.length > this.cfCfg.regretWindow) samples.shift();
          this.cfRegret.set(snap.chosen, samples);
        }
      }
    }

    // 75.0 在线校准：p（决策时置信度）→ y（结局二值化）喂入门控校准器
    //（calibrateNext→observe 背靠背配对，协议与内核一致；未挂载零介入）
    if (this.probabilityCalibrator) {
      const p = this.calibrationQueue.get(fingerprint);
      if (p !== undefined) {
        this.calibrationQueue.delete(fingerprint);
        this.probabilityCalibrator.calibrateNext(p);
        this.probabilityCalibrator.observe(outcome === 'failed' || outcome === 'poor' ? 0 : 1);
      }
    }

    // 74.0 镜像下降：行动 × 结局价值记账（未挂载零介入）
    if (this.noRegretLedger && pendingEntry) {
      this.noRegretLedger.note(pendingEntry.decision.action, OUTCOME_VALUE[outcome ?? 'acceptable'] ?? 0.6);
    }
  }

  /** 计算信号指纹（对外暴露，供编排层沉淀反馈时使用） */
  fingerprint(signal: Pick<Signal, 'type' | 'description'>): string {
    return fingerprintOf(signal);
  }

  /**
   * 运行时配置热更新（策略进化引擎的基因组落地入口）
   * @param patch 配置补丁（仅覆盖提供的字段，strategist 回调不可经此修改）
   */
  updateConfig(patch: Partial<Omit<DecisionEngineConfig, 'strategist'>>): void {
    this.config = { ...this.config, ...patch };
  }

  /** 当前配置快照（不含 strategist 回调） */
  getConfig(): Omit<DecisionEngineConfig, 'strategist'> {
    const { strategist: _strategist, ...rest } = this.config;
    return { ...rest };
  }

  /** 决策引擎运行统计 */
  getStats(): DecisionEngineStats {
    return {
      ...this.stats,
      cacheSize: this.cache.size,
      cacheHitRate: this.stats.total > 0 ? this.stats.cacheHits / this.stats.total : 0,
      ruleHitRate: this.stats.total > 0 ? this.stats.ruleHits / this.stats.total : 0,
      consecutiveFailures: Object.fromEntries(this.consecutiveFailures),
    };
  }

  /** 最近决策审计记录 */
  getAudit(limit = 20): DecisionAuditEntry[] {
    return this.audit.slice(-limit);
  }

  /** 清空缓存与计数器（测试/重置用；R3/R4 状态一并清零） */
  reset(): void {
    this.cache.clear();
    this.consecutiveFailures.clear();
    this.recentSuccess.clear();
    this.audit = [];
    this.hysteresisStates.clear();
    this.hysteresisCounters = { flips: 0, suppressed: 0 };
    this.cfBuckets.clear();
    this.cfQueue.clear();
    this.cfRegret.clear();
    this.ctxBuckets.clear();
    this.ctxQueue.clear();
    this.ctxApplied.clear();
    this.structuredAudit = [];
    // R4 状态
    this.strategistInvokeCount = 0;
    this.fatigueTimestamps = [];
    this.fatigueCounters = { deferred: 0, protectedPassed: 0, drained: 0 };
    this.fatigueBacklog = [];
    this.failClusterTable.clear();
    this.clusterQueue.clear();
    this.explanations.clear();
    this.traceDrafts = undefined;
    this.undoRegistry.clear();
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 第 1 级：规则快速路径（R4-4：逐条留痕——hit/miss 与数值因子现场捕获） */
  private applyRules(signal: Signal, fingerprint: string, stats?: SignalHistoryStats): Decision | null {
    const now = Date.now();

    // 规则 A：重复抑制 — 抑制窗口内已成功执行过
    const lastSuccess = this.recentSuccess.get(fingerprint);
    if (lastSuccess && now - lastSuccess < this.config.suppressionWindowMs) {
      this.traceNode(signal.id, 'rule-A', 'hit', `重复抑制：${Math.round((now - lastSuccess) / 1000)}s 前同指纹已成功——dismiss`, [
        { name: 'lastSuccessAgeMs', value: now - lastSuccess },
        { name: 'suppressionWindowMs', value: this.config.suppressionWindowMs },
      ]);
      return {
        action: 'dismiss',
        urgency: 0.1,
        confidence: 0.9,
        reason: `重复抑制：${Math.round((now - lastSuccess) / 1000)}s 前同指纹任务已成功执行`,
        source: 'rule',
        decidedAt: now,
      };
    }
    this.traceNode(signal.id, 'rule-A', 'miss', lastSuccess
      ? `同指纹成功记录已出窗（${Math.round((now - lastSuccess) / 1000)}s ≥ 窗口 ${Math.round(this.config.suppressionWindowMs / 1000)}s）`
      : '无同指纹成功记录——重复抑制不适用', [
        { name: 'lastSuccessAgeMs', value: lastSuccess ? now - lastSuccess : -1 },
        { name: 'suppressionWindowMs', value: this.config.suppressionWindowMs },
      ]);

    // 规则 B：失败升级 — 同类型连续失败达阈值，止损交人工
    const failures = this.consecutiveFailures.get(signal.type) ?? 0;
    if (failures >= this.config.failureEscalationThreshold) {
      this.traceNode(signal.id, 'rule-B', 'hit', `连续失败 ${failures} ≥ 阈值 ${this.config.failureEscalationThreshold}——升级 ask-user 止损`, [
        { name: 'consecutiveFailures', value: failures },
        { name: 'threshold', value: this.config.failureEscalationThreshold },
      ]);
      return {
        action: 'ask-user',
        urgency: 0.7,
        confidence: 0.85,
        reason: `类型 ${signal.type} 已连续失败 ${failures} 次，升级人工介入`,
        source: 'rule',
        decidedAt: now,
      };
    }
    this.traceNode(signal.id, 'rule-B', 'miss', `连续失败 ${failures} < 阈值 ${this.config.failureEscalationThreshold}`, [
      { name: 'consecutiveFailures', value: failures },
      { name: 'threshold', value: this.config.failureEscalationThreshold },
    ]);

    // 规则 C：成本闸门 — 高成本 + 低紧急度 → defer（需历史成本数据支撑）
    if (stats && stats.avgTokenCost > 0 && signal.urgency !== undefined) {
      const estimatedCost = stats.avgTokenCost;
      // R3-4：上下文分桶校准线——挂载且桶内失败证据充足时替换全局魔数线
      // （只收紧不放松：纠正「夜间低信誉源紧急度虚高」类漂移；样本不足
      // 或未挂载时回退 DECISION_LOW_URGENCY_LINE，逐位零漂移）
      const lowUrgencyLine = this.contextThresholdForSignal(signal) ?? DECISION_LOW_URGENCY_LINE;
      if (signal.urgency < lowUrgencyLine && estimatedCost > 5000) {
        // 19.0：最优停止裁决——高成本信号是否值得现在占坑，由该类型
        // 紧急度经验分布的继续价值阈值决定（魔数 defer 升级为数学 defer）
        const stopperVerdict = this.assessOpportunity(signal.type, signal.urgency);
        const stopperChild: PathExplainerNode[] = stopperVerdict
          ? [{
              node: 'optimal-stopping',
              status: stopperVerdict.act ? 'applied' : 'miss',
              detail: `${stopperVerdict.interpretation}（现值 ${stopperVerdict.value.toFixed(3)} vs 继续价值线 ${stopperVerdict.threshold.toFixed(3)}）`,
              factors: [
                { name: 'opportunityValue', value: stopperVerdict.value },
                { name: 'continueThreshold', value: stopperVerdict.threshold },
              ],
              children: [],
            }]
          : [];
        if (stopperVerdict?.act) {
          this.traceNode(signal.id, 'rule-C', 'hit', `低紧急（${signal.urgency.toFixed(3)} < 线 ${lowUrgencyLine.toFixed(3)}）高成本（${estimatedCost}）但现值过继续价值线——execute`, [
            { name: 'urgency', value: signal.urgency },
            { name: 'estimatedCost', value: estimatedCost },
            { name: 'lowUrgencyLine', value: lowUrgencyLine },
          ], stopperChild);
          return {
            action: 'execute',
            urgency: signal.urgency,
            confidence: 0.75,
            reason: `高成本但现值已过继续价值线：${stopperVerdict.interpretation}`,
            source: 'rule',
            estimatedCost,
            decidedAt: now,
          };
        }
        this.traceNode(signal.id, 'rule-C', 'hit', `低紧急（${signal.urgency.toFixed(3)} < 线 ${lowUrgencyLine.toFixed(3)}）× 高成本（${estimatedCost} > 5000）→ defer`, [
          { name: 'urgency', value: signal.urgency },
          { name: 'estimatedCost', value: estimatedCost },
          { name: 'lowUrgencyLine', value: lowUrgencyLine },
        ], stopperChild);
        return {
          action: 'defer',
          urgency: signal.urgency,
          confidence: 0.7,
          reason: stopperVerdict
            ? `高成本任务（约 ${estimatedCost} tokens）且 ${stopperVerdict.interpretation}`
            : `高成本任务（约 ${estimatedCost} tokens）且紧急度低，延迟到空闲期`,
          source: 'rule',
          deferMs: 5 * 60_000,
          estimatedCost,
          decidedAt: now,
        };
      }
      this.traceNode(signal.id, 'rule-C', 'miss', signal.urgency >= lowUrgencyLine
        ? `紧急度 ${signal.urgency.toFixed(3)} ≥ 线 ${lowUrgencyLine.toFixed(3)}——成本闸门不适用`
        : `成本 ${estimatedCost} ≤ 5000——未达高成本闸门`, [
          { name: 'urgency', value: signal.urgency },
          { name: 'estimatedCost', value: estimatedCost },
          { name: 'lowUrgencyLine', value: lowUrgencyLine },
        ]);
      return null;
    }
    this.traceNode(signal.id, 'rule-C', 'miss', '无历史成本统计或紧急度缺席——成本闸门不适用', [
      { name: 'avgTokenCost', value: stats?.avgTokenCost ?? -1 },
    ]);
    return null;
  }

  /**
   * 19.0：机会价值评估（规则 C 内部调用）。
   *
   * 紧急度流已在 decide() 逐信号喂入停止器；此处评估当前抽值是否
   * 越过继续价值。未挂载或经验不足（insufficient）返回 undefined
   * ——回退原魔数口径（诚实弃权，零漂移）。
   */
  private assessOpportunity(signalType: string, urgency: number): StoppingVerdict | undefined {
    if (!this.stopper) return undefined;
    const verdict = this.stopper.assess(signalType, urgency, this.stopperHorizon);
    if (verdict.basis !== 'backward-induction') return undefined;
    this.stopperVerdicts.push({
      signalType,
      at: Date.now(),
      act: verdict.act,
      value: verdict.value,
      threshold: verdict.threshold,
    });
    if (this.stopperVerdicts.length > 50) this.stopperVerdicts.shift();
    return verdict;
  }

  /** 第 2 级：缓存查询（校验 TTL 与置信度；R4-4 留痕 hit/miss 与数值） */
  private lookupCache(fingerprint: string, signalId?: string): Decision | null {
    const entry = this.cache.get(fingerprint);
    if (!entry) {
      if (signalId !== undefined) {
        this.traceNode(signalId, 'cache', 'miss', '无缓存条目（新指纹）——下沉 strategist', []);
      }
      return null;
    }
    const age = Date.now() - entry.decision.decidedAt;
    if (age > this.config.cacheTtlMs) {
      this.cache.delete(fingerprint);
      if (signalId !== undefined) {
        this.traceNode(signalId, 'cache', 'miss', `条目过期（age ${age}ms > TTL ${this.config.cacheTtlMs}ms）——淘汰后下沉`, [
          { name: 'ageMs', value: age },
          { name: 'ttlMs', value: this.config.cacheTtlMs },
        ]);
      }
      return null;
    }
    // 低置信度缓存不复用，交给 strategist 重审
    if (entry.adjustedConfidence < this.config.lowConfidenceThreshold) {
      if (signalId !== undefined) {
        this.traceNode(signalId, 'cache', 'miss', `缓存置信度 ${entry.adjustedConfidence.toFixed(3)} < 阈值 ${this.config.lowConfidenceThreshold}——不复用，下沉重审`, [
          { name: 'adjustedConfidence', value: entry.adjustedConfidence },
          { name: 'lowConfidenceThreshold', value: this.config.lowConfidenceThreshold },
        ]);
      }
      return null;
    }

    entry.hits += 1;
    if (signalId !== undefined) {
      this.traceNode(signalId, 'cache', 'hit', `复用缓存决策（第 ${entry.hits} 次命中，置信度 ${entry.adjustedConfidence.toFixed(3)}）`, [
        { name: 'hits', value: entry.hits },
        { name: 'adjustedConfidence', value: entry.adjustedConfidence },
        { name: 'ageMs', value: age },
      ]);
    }
    return { ...entry.decision, source: 'cache', confidence: entry.adjustedConfidence, decidedAt: Date.now() };
  }

  /** 缓存写入（LRU 淘汰） */
  private storeCache(fingerprint: string, decision: Decision): void {
    if (this.cache.size >= this.config.cacheMaxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(fingerprint, { decision, hits: 0, adjustedConfidence: decision.confidence });
  }

  /** 第 3 级：strategist 裁定 → Decision（含置信度与低置信升级；R4-4 留痕） */
  private fromStrategist(signal: Signal, verdict: StrategistVerdict, stats?: SignalHistoryStats): Decision {
    // 置信度基线：历史数据越充分越可信
    const historyFactor = stats ? Math.min(0.2, stats.totalDecisions * 0.02) : 0;
    let confidence = 0.65 + historyFactor;
    let action = verdict.decision;

    // 突发信号提权
    let urgency = Math.max(0, Math.min(1, verdict.urgency));
    let burstUplift = 0;
    if (signal.occurrences >= this.config.burstOccurrences) {
      burstUplift = Math.min(1, urgency + 0.2) - urgency;
      urgency = Math.min(1, urgency + 0.2);
    }

    // 成本估算注入
    const estimatedCost = stats?.avgTokenCost;

    // 低置信升级（R3-3：挂载 95.0/97.0 后经信息价值门裁决——高代价低
    // 信心才问；未挂载保持旧规则直接升级，零漂移）
    let reason = verdict.reason ?? 'strategist 决策';
    let gateNote = '';
    if (confidence < this.config.lowConfidenceThreshold && action === 'execute') {
      const gate = this.gateAskUserUpgrade(confidence, estimatedCost);
      if (gate === undefined) {
        action = 'ask-user'; // 旧规则：无成本口径，低置信一律升级
        gateNote = '低置信旧规则升级（未挂 95.0/97.0 成本口径——直接 ask-user）';
      } else if (gate.keep === 'ask-user') {
        action = 'ask-user';
        reason += gate.note;
        gateNote = `维持升级：${gate.note}`;
      } else {
        reason += gate.note; // 维持 execute：期望损失低于打扰成本
        gateNote = `拦截升级：${gate.note}`;
      }
    }

    // R4-4：strategist 级留痕（verdict → 提权 → 低置信门子节点）
    const gateChildren: PathExplainerNode[] = gateNote
      ? [{
          node: 'low-confidence-gate',
          status: action === 'ask-user' ? 'applied' : 'miss',
          detail: gateNote,
          factors: [
            { name: 'confidence', value: confidence },
            { name: 'lowConfidenceThreshold', value: this.config.lowConfidenceThreshold },
          ],
          children: [],
        }]
      : [];
    this.traceNode(signal.id, 'strategist', 'applied', `strategist 裁定 ${verdict.decision}（urgency ${verdict.urgency.toFixed(3)}${burstUplift > 0 ? `，突发提权 +${burstUplift.toFixed(3)}` : ''}）→ 终局 ${action}`, [
      { name: 'verdictUrgency', value: verdict.urgency },
      { name: 'urgency', value: urgency },
      { name: 'confidence', value: confidence },
      { name: 'estimatedCost', value: estimatedCost ?? 0 },
    ], gateChildren);

    return {
      action,
      urgency,
      confidence,
      reason,
      source: 'strategist',
      deferMs: verdict.deferMs,
      estimatedCost,
      decidedAt: Date.now(),
    };
  }

  /** 第 4 级：启发式兜底（保守执行；R4-4 留痕） */
  private heuristic(signal: Signal, stats?: SignalHistoryStats): Decision {
    const urgency = Math.min(1, 0.5 + signal.occurrences * 0.1);
    this.traceNode(signal.id, 'heuristic', 'applied', `strategist 不可用/未裁定——启发式保守执行（0.5 + ${signal.occurrences}×0.1）`, [
      { name: 'occurrences', value: signal.occurrences },
      { name: 'urgency', value: urgency },
    ]);
    return {
      action: 'execute',
      urgency,
      confidence: 0.5,
      reason: 'strategist 不可用，启发式兜底',
      source: 'heuristic',
      estimatedCost: stats?.avgTokenCost,
      decidedAt: Date.now(),
    };
  }

  /** 审计记录（环形缓冲上限 200；75.0：门控开启时置信度经在线校准；
   *  R4-3：失败聚类特征登记；R4-5：execute 落定开撤销窗） */
  private auditDecision(signal: Signal, fingerprint: string, decision: Decision, opts?: { skipUndo?: boolean }): void {
    // 75.0 在线校准：决策时登记待校准 p；门控确证失准后输出置信度经
    // Platt/Isotonic 通道校准并标注——「报多少就发生多少」。未挂载 /
    // 门控未开时恒等直通（逐位零漂移）。
    if (this.probabilityCalibrator) {
      this.calibrationQueue.set(fingerprint, decision.confidence);
      if (this.probabilityCalibrator.status().active) {
        const before = decision.confidence;
        decision.confidence = Math.max(0, Math.min(1, this.probabilityCalibrator.calibrate(decision.confidence)));
        decision.reason += '〔75.0 校准〕';
        this.traceNode(signal.id, 'calibration', 'applied', `75.0 校准通道改写置信度 ${before.toFixed(3)} → ${decision.confidence.toFixed(3)}`, [
          { name: 'before', value: before },
          { name: 'after', value: decision.confidence },
        ]);
      } else {
        this.traceNode(signal.id, 'calibration', 'pass-through', '75.0 校准器挂载但门控未开——恒等直通', [
          { name: 'confidence', value: decision.confidence },
        ]);
      }
    }

    // R3-2 反事实台账：按上下文桶快照四臂估计（决策时点的「假想臂」——
    // 结局回填后与 actual 对比即后悔）。未挂载零介入。
    if (this.cfEnabled) {
      const armEstimates: Partial<Record<DecisionAction, number>> = {};
      for (const arm of ALL_ACTIONS) {
        armEstimates[arm] = this.cfArmEstimate(signal.type, arm);
      }
      this.cfPush(this.cfQueue, fingerprint, { ctxKey: signal.type, chosen: decision.action, armEstimates });
    }

    // R3-4 分桶校准：登记 (桶, 紧急度) 待结局回填配对消费。未挂载零介入。
    if (this.ctxCalEnabled) {
      this.ctxPush(this.ctxQueue, fingerprint, {
        bucket: contextBucketOf(signal, this.ctxCalTrust, this.ctxCalHourBuckets),
        urgency: decision.urgency,
      });
    }

    // R4-3 失败模式聚类：登记特征样本待结局配对（缺省五元组网格，可注入
    // 自定义提取器）。未挂载零介入。
    if (this.failClusterEnabled) {
      const features = this.failClusterFeatures
        ? this.failClusterFeatures(signal, decision)
        : defaultFailureFeatures(signal, decision);
      this.cfPush(this.clusterQueue, fingerprint, {
        features,
        cost: decision.estimatedCost ?? 0,
        reason: decision.reason,
      });
    }

    // R3-5 结构化审计：stage / 分数分解 / 内核标记 / 上下文桶。未挂载零介入。
    if (this.rationaleCaptureEnabled) {
      const entry: StructuredAuditEntry = {
        signalId: signal.id,
        fingerprint,
        decision,
        rationale: {
          stage: inferStage(decision),
          factors: [
            { name: 'urgency', value: decision.urgency },
            { name: 'confidence', value: decision.confidence },
            { name: 'estimatedCost', value: decision.estimatedCost ?? 0 },
            { name: 'occurrences', value: signal.occurrences },
          ],
          markers: [...decision.reason.matchAll(/〔([^〕]+)〕/g)].map((m) => m[1]),
          contextBucket: this.ctxCalEnabled
            ? contextBucketOf(signal, this.ctxCalTrust, this.ctxCalHourBuckets)
            : undefined,
        },
      };
      this.structuredAudit.push(entry);
      if (this.structuredAudit.length > 200) this.structuredAudit.shift();
    }

    this.audit.push({ signalId: signal.id, fingerprint, decision });
    if (this.audit.length > 200) this.audit.shift();

    // R4-5：execute 落定即开撤销窗（skipUndo = 合并成员——撤销以代表为准）
    this.registerUndoWindow(signal.id, fingerprint, decision, opts?.skipUndo === true);
  }

  // ─────────────────────────── R3 内部实现 ───────────────────────────

  /**
   * R3-1：滞后滤波——对 execute/defer 决策应用双阈值 + 最短驻留期。
   *
   * 换向 execute 需 urgency ≥ enterHigh；换向 defer 需 urgency < exitLow；
   * 间隙内维持原状态；换向后 minDwellMs 内的反向请求一律保持。被抑制的
   * 请求计入 suppressed（消除抖动的直接读数）。未挂载零介入。
   */
  private applyHysteresis(signal: Signal, decision: Decision): void {
    if (!this.hysteresisEnabled) return;
    if (decision.action !== 'execute' && decision.action !== 'defer') return;
    const now = decision.decidedAt;
    const st = this.hysteresisStates.get(signal.type);
    if (!st) {
      this.hysteresisStates.set(signal.type, { action: decision.action, since: now });
      this.traceNode(signal.id, 'hysteresis', 'pass-through', `类型 ${signal.type} 首决策——建态 ${decision.action}（不算换向）`, [
        { name: 'enterHigh', value: this.hysteresisCfg.enterHigh },
        { name: 'exitLow', value: this.hysteresisCfg.exitLow },
      ]);
      return;
    }
    if (decision.action === st.action) {
      this.traceNode(signal.id, 'hysteresis', 'pass-through', `与当前状态 ${st.action} 同向——直通`, [
        { name: 'enterHigh', value: this.hysteresisCfg.enterHigh },
        { name: 'exitLow', value: this.hysteresisCfg.exitLow },
      ]);
      return; // 与当前状态同向，无换向请求
    }
    if (now - st.since < this.hysteresisCfg.minDwellMs) {
      decision.action = st.action;
      decision.reason += '〔滞后·驻留保持〕';
      this.hysteresisCounters.suppressed += 1;
      this.traceNode(signal.id, 'hysteresis', 'applied', `驻留期内反向请求（${now - st.since}ms < ${this.hysteresisCfg.minDwellMs}ms）——保持 ${st.action}`, [
        { name: 'dwellElapsedMs', value: now - st.since },
        { name: 'minDwellMs', value: this.hysteresisCfg.minDwellMs },
      ]);
      return;
    }
    const crossed = decision.action === 'execute'
      ? decision.urgency >= this.hysteresisCfg.enterHigh
      : decision.urgency < this.hysteresisCfg.exitLow;
    if (crossed) {
      st.action = decision.action;
      st.since = now;
      this.hysteresisCounters.flips += 1;
      decision.reason += '〔滞后·换向〕';
      this.traceNode(signal.id, 'hysteresis', 'applied', `越过${decision.action === 'execute' ? '进入' : '退出'}阈（urgency ${decision.urgency.toFixed(3)}）——换向 ${st.action}`, [
        { name: 'urgency', value: decision.urgency },
        { name: decision.action === 'execute' ? 'enterHigh' : 'exitLow', value: decision.action === 'execute' ? this.hysteresisCfg.enterHigh : this.hysteresisCfg.exitLow },
      ]);
    } else {
      decision.action = st.action;
      decision.reason += '〔滞后·间隙保持〕';
      this.hysteresisCounters.suppressed += 1;
      this.traceNode(signal.id, 'hysteresis', 'applied', `间隙区反向请求（${this.hysteresisCfg.exitLow} ≤ urgency ${decision.urgency.toFixed(3)} < ${this.hysteresisCfg.enterHigh}）——保持 ${st.action}`, [
        { name: 'urgency', value: decision.urgency },
        { name: 'enterHigh', value: this.hysteresisCfg.enterHigh },
        { name: 'exitLow', value: this.hysteresisCfg.exitLow },
      ]);
    }
  }

  /** R3-2：桶内某臂的经验均值估计（无观测 → 先验） */
  private cfArmEstimate(ctxKey: string, arm: DecisionAction): number {
    const s = this.cfBuckets.get(ctxKey)?.get(arm);
    return s && s.n > 0 ? s.sum / s.n : this.cfCfg.priorArmValue;
  }

  /** 通用指纹队列 push（反事实 / 分桶共用的配对协议） */
  private cfPush<T>(queue: Map<string, T[]>, fingerprint: string, item: T): void {
    const list = queue.get(fingerprint);
    if (list) list.push(item);
    else queue.set(fingerprint, [item]);
  }

  private ctxPush<T>(queue: Map<string, T[]>, fingerprint: string, item: T): void {
    this.cfPush(queue, fingerprint, item);
  }

  /**
   * R3-3：ask-user 信息价值门（95.0 交接 / 97.0 元认知已挂载时生效）。
   *
   * 对「低置信欲升级 ask-user」的决策做期望成本裁决：x = (1−confidence)·
   * c_auto（自动执行的期望损失）vs τ* = c_H + c_delay（打扰用户的全成本
   * ）——x > τ* 才值得问（高代价低信心才问）。95.0 挂载优先走闭式交接
   * 裁决，否则 97.0 闭式求助阈。均未挂载 / 成本模型非法时返回 undefined
   * ——调用方保持旧规则（直接升级，零漂移）。规则 B（失败止损）语义
   * 独立、不经此门。
   */
  private gateAskUserUpgrade(confidence: number, estimatedCost: number | undefined): { keep: 'ask-user' | 'execute'; note: string } | undefined {
    if (!this.handoffPolicyEnabled && !this.metacognitionLedger) return undefined;
    const cfg = this.askGateCfg;
    const c = clamp01ish(confidence);
    const costAuto = estimatedCost && estimatedCost > 0 ? estimatedCost : cfg.defaultCostAuto;
    if (this.handoffPolicyEnabled) {
      const advice = askUserHandoffAdvice({ pError: 1 - c, costAuto, costHuman: cfg.costHuman, delayCost: cfg.delayCost });
      if (advice) {
        this.askGateStats.total += 1;
        if (advice.advice.recommend === 'ask-user') {
          this.askGateStats.escalated += 1;
          return { keep: 'ask-user', note: `〔信息价值门：x=${advice.expectedAutoCost.toFixed(0)} > τ*=${advice.threshold.toFixed(0)}——期望损失超过打扰成本，值得问〕` };
        }
        this.askGateStats.spared += 1;
        return { keep: 'execute', note: `〔信息价值门：x=${advice.expectedAutoCost.toFixed(0)} ≤ τ*=${advice.threshold.toFixed(0)}——期望损失低于打扰成本，不值得打扰〕` };
      }
    }
    if (this.metacognitionLedger) {
      const a = shouldAskAdvice(c, { costError: costAuto, costAsk: cfg.costHuman + cfg.delayCost, priorError: cfg.priorError });
      if (a) {
        this.askGateStats.total += 1;
        if (a.ask) {
          this.askGateStats.escalated += 1;
          return { keep: 'ask-user', note: `〔信息价值门(97.0)：后验错误率 ${a.posteriorError.toFixed(2)} 越过闭式阈 ${a.threshold.toFixed(2)}，求助期望省 ${a.expectedSaving.toFixed(0)}〕` };
        }
        this.askGateStats.spared += 1;
        return { keep: 'execute', note: `〔信息价值门(97.0)：后验错误率 ${a.posteriorError.toFixed(2)} 未过阈 ${a.threshold.toFixed(2)}——不值得打扰〕` };
      }
    }
    return undefined;
  }

  /** R3-4：信号当前桶的校准线（不足/未挂载 → undefined = 全局缺省线） */
  private contextThresholdForSignal(signal: Signal): number | undefined {
    if (!this.ctxCalEnabled) return undefined;
    const key = contextBucketOf(signal, this.ctxCalTrust, this.ctxCalHourBuckets);
    const t = this.contextThresholdFor(key);
    if (t !== undefined) this.ctxApplied.set(key, (this.ctxApplied.get(key) ?? 0) + 1);
    return t;
  }

  /** R3-4：桶校准线 = max(全局线, min(失败分位线, 成功中位线))——只收紧不放松 */
  private contextThresholdFor(key: string): number | undefined {
    const samples = this.ctxBuckets.get(key);
    if (!samples || samples.length < this.ctxCalCfg.minSamples) return undefined;
    const fails = samples.filter((s) => !s.good).map((s) => s.urgency);
    const succs = samples.filter((s) => s.good).map((s) => s.urgency);
    if (fails.length === 0 || succs.length === 0) return undefined;
    const failLine = quantile(fails, this.ctxCalCfg.failQuantile);
    const succMedian = quantile(succs, 0.5);
    if (!Number.isFinite(failLine) || !Number.isFinite(succMedian)) return undefined;
    return Math.max(DECISION_LOW_URGENCY_LINE, Math.min(failLine, succMedian));
  }

  /** 清理过期的重复抑制记录 */
  private trimRecentSuccess(): void {
    const cutoff = Date.now() - this.config.suppressionWindowMs;
    for (const [key, ts] of this.recentSuccess) {
      if (ts < cutoff) this.recentSuccess.delete(key);
    }
  }

  // ─────────────────────────── R4 内部实现 ───────────────────────────

  /**
   * R4-4：流水线留痕（解释器未挂载 / 草稿不在批 → 无操作，零开销）。
   * 返回节点引用供子内核（停止器 / 低置信门）挂接。
   */
  private traceNode(
    signalId: string,
    node: string,
    status: PathExplainerStatus,
    detail: string,
    factors: Array<{ name: string; value: number }> = [],
    children: PathExplainerNode[] = [],
  ): PathExplainerNode | undefined {
    if (!this.explainerEnabled || !this.traceDrafts) return undefined;
    const draft = this.traceDrafts.get(signalId);
    if (!draft) return undefined;
    const entry: PathExplainerNode = { node, status, detail, factors, children };
    draft.nodes.push(entry);
    return entry;
  }

  /** R4-4：联合决策成员/败者不在 decide() 批内——显式播种解释草稿
   *  （顺序级以 skipped 留痕：成员未单独过流水线，共享代表终局） */
  private seedJointExplanation(signal: Signal, node: string, detail: string, factors: Array<{ name: string; value: number }>): void {
    if (!this.explainerEnabled) return;
    const jointNode: PathExplainerNode = { node, status: 'applied', detail, factors, children: [] };
    const stages = DecisionEngine.PIPELINE_STAGES.slice(0, 5).map((stage) => ({
      node: stage,
      status: 'skipped' as PathExplainerStatus,
      detail: '联合批次成员——本级未单独评估（共享代表决策）',
      factors: [] as Array<{ name: string; value: number }>,
      children: [] as PathExplainerNode[],
    }));
    this.traceDrafts ??= new Map();
    this.traceDrafts.set(signal.id, { fingerprint: fingerprintOf(signal), nodes: [jointNode, ...stages] });
  }

  /**
   * R4-4：结算解释树——终局之后的流水线级补 skipped；final 快照取决策
   * 现场对象（auditDecision 可能已做 75.0 校准改写——快照在最后一刻
   * 拍，保证解释与返回决策逐字段一致）。
   */
  private finalizeExplanation(signalId: string, decision: Decision): void {
    if (!this.explainerEnabled) return;
    const draft = this.traceDrafts?.get(signalId);
    if (!draft) return;
    // 终局之后未评估的顺序级（fatigue/规则 A~C/缓存）补 skipped；
    // strategist / heuristic 是二选一分支，缺席自明（final.source 可辨）
    const present = new Set(draft.nodes.map((n) => n.node));
    const lastDecisive = (() => {
      let last = -1;
      for (const node of draft.nodes) {
        const idx = DecisionEngine.PIPELINE_STAGES.indexOf(node.node as (typeof DecisionEngine.PIPELINE_STAGES)[number]);
        if (idx >= 0 && (node.status === 'hit' || node.status === 'applied')) last = Math.max(last, idx);
      }
      return last;
    })();
    for (let i = 0; i <= 4; i += 1) {
      const stage = DecisionEngine.PIPELINE_STAGES[i];
      if (present.has(stage)) continue;
      if (i > lastDecisive) {
        draft.nodes.push({ node: stage, status: 'skipped', detail: '上级已返回，本级未评估', factors: [], children: [] });
      }
    }
    const lines: string[] = [`signal ${signalId} → ${decision.action}（source=${decision.source}, urgency=${decision.urgency}, confidence=${decision.confidence}）`];
    for (const node of draft.nodes) renderExplainerNode(node, 1, lines);
    const explanation: DecisionPathExplanation = {
      signalId,
      fingerprint: draft.fingerprint,
      at: decision.decidedAt,
      pipeline: draft.nodes,
      final: { ...decision },
      markers: [...decision.reason.matchAll(/〔([^〕]+)〕/g)].map((m) => m[1]),
      rendered: lines.join('\n'),
    };
    this.explanations.set(signalId, explanation);
    if (this.explanations.size > 100) {
      // 上限 100：淘汰最早条目（Map 迭代序 = 插入序）
      const firstKey = this.explanations.keys().next().value;
      if (firstKey !== undefined) this.explanations.delete(firstKey);
    }
    this.traceDrafts?.delete(signalId);
  }

  /**
   * R4-2：疲劳筛（未挂载恒 null = 直通，零漂移）。
   *
   * 预算内 → null（放行进流水线，占一个决策位）；预算耗尽 →
   * 高价值（≥ highValueUrgency）带保护线放行；低价值（<
   * lowValueUrgencyBelow）推迟（batch 模式入积压）；中间带放行占位。
   * 推迟不占预算（减压阀语义）。
   */
  private fatigueScreen(signal: Signal): Decision | null {
    if (!this.fatigueEnabled) return null;
    const now = this.fatigueCfg.now();
    while (this.fatigueTimestamps.length > 0 && now - this.fatigueTimestamps[0] > this.fatigueCfg.windowMs) {
      this.fatigueTimestamps.shift();
    }
    const u = typeof signal.urgency === 'number' && Number.isFinite(signal.urgency) ? signal.urgency : 0.5;
    const used = this.fatigueTimestamps.length;
    const underBudget = used < this.fatigueCfg.budgetPerWindow;
    if (underBudget) {
      this.fatigueTimestamps.push(now);
      this.traceNode(signal.id, 'fatigue', 'pass-through', `预算内放行（${used + 1}/${this.fatigueCfg.budgetPerWindow} 每 ${this.fatigueCfg.windowMs}ms 窗口）`, [
        { name: 'urgency', value: u },
        { name: 'budgetUsed', value: used + 1 },
      ]);
      return null;
    }
    if (u >= this.fatigueCfg.highValueUrgency) {
      this.fatigueTimestamps.push(now);
      this.fatigueCounters.protectedPassed += 1;
      this.traceNode(signal.id, 'fatigue', 'pass-through', `预算耗尽但高价值保护（u=${u} ≥ ${this.fatigueCfg.highValueUrgency}——永不节流）`, [
        { name: 'urgency', value: u },
        { name: 'budgetUsed', value: used },
      ]);
      return null;
    }
    if (u < this.fatigueCfg.lowValueUrgencyBelow) {
      this.fatigueCounters.deferred += 1;
      let batched = false;
      if (this.fatigueMode === 'batch' && this.fatigueBacklog.length < this.fatigueCfg.backlogMax) {
        this.fatigueBacklog.push(signal);
        batched = true;
      }
      this.traceNode(signal.id, 'fatigue', 'hit', `预算耗尽（${used}/${this.fatigueCfg.budgetPerWindow}）——低价值信号（u=${u} < ${this.fatigueCfg.lowValueUrgencyBelow}）${batched ? '入积压待批排' : '推迟'}`, [
        { name: 'urgency', value: u },
        { name: 'budgetUsed', value: used },
        { name: 'lowValueLine', value: this.fatigueCfg.lowValueUrgencyBelow },
      ]);
      return {
        action: 'defer',
        urgency: u,
        confidence: 0.8,
        reason: batched
          ? `〔疲劳防护·积压〕决策预算 ${used}/${this.fatigueCfg.budgetPerWindow} 已耗尽，低价值信号（u=${u.toFixed(2)}）入积压队列待批排`
          : `〔疲劳防护〕决策预算 ${used}/${this.fatigueCfg.budgetPerWindow} 已耗尽，低价值信号（u=${u.toFixed(2)}）推迟`,
        source: 'rule',
        deferMs: this.fatigueCfg.deferMs,
        decidedAt: now,
      };
    }
    // 中间带：放行占位（只节流低价值——疲劳不是一刀切）
    this.fatigueTimestamps.push(now);
    this.traceNode(signal.id, 'fatigue', 'pass-through', `预算耗尽但中间带（${this.fatigueCfg.lowValueUrgencyBelow} ≤ u=${u} < ${this.fatigueCfg.highValueUrgency}）放行`, [
      { name: 'urgency', value: u },
      { name: 'budgetUsed', value: used },
    ]);
    return null;
  }

  /** R4-5：撤销窗口登记（auditDecision 末尾调用——execute 落定即开窗） */
  private registerUndoWindow(signalId: string, fingerprint: string, decision: Decision, skip: boolean): void {
    if (!this.undoEnabled || skip) return;
    if (decision.action !== 'execute') return;
    const now = this.undoCfg.now();
    // 开新窗时清理已过期窗口（过期窗已不可撤——防 Map 随 execute 决策无界增长）。
    // 只在真正开窗时清理：defer/dismiss 决策不触发，读数侧（undoWindowView）
    // 保持纯读语义（过期窗口在视图里以 remainingMs=0 呈现）
    for (const [id, rec] of this.undoRegistry) {
      if (rec.openedAt + this.undoCfg.windowMs <= now) this.undoRegistry.delete(id);
    }
    this.undoRegistry.set(signalId, {
      fingerprint,
      action: decision.action,
      openedAt: now,
      cost: decision.estimatedCost && decision.estimatedCost > 0 ? decision.estimatedCost : this.undoCfg.defaultCost,
      cascaded: false,
    });
  }
}

/** 信号指纹：type + 归一化描述 */
function fingerprintOf(signal: Pick<Signal, 'type' | 'description'>): string {
  const normalized = signal.description.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(`${signal.type}:${normalized}`).digest('hex').slice(0, 16);
}
