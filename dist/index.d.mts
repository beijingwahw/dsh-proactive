import Schema from "@deepseek-ai/schemastery";
import http from "node:http";
import { EventEmitter } from "node:events";
import { Context } from "@deepseek-ai/cordis";
//#region src/sentinel.d.ts
/**
 * sentinel.ts — 信号感知哨兵（集成层，执行链路第 1~2 步）
 *
 * 职责：主动感知环境变化，统一封装为 Signal 对象并在聚合窗口内合并相关信号
 * - 三种信号源：webhook（HTTP 接入）/ filesystem（文件监听）/ polling（轮询比对）
 * - 手动注入入口（autonomous_execute Tool 与级联触发共用）
 * - 聚合窗口：aggregationWindow 内相关信号合并去重，窗口结束批量交付
 * - 交付回调 onBatch 由 index.ts 编排层消费，进入优先级排序与战略决策
 *
 * 升级点（相对单一 webhook 的质的提升）：
 * 1. 窗口内同源去重：type + dedupeKey 相同的信号合并计数，避免重复决策
 * 2. 批次双触发：窗口到期或达到 maxBatchSize 立即交付，兼顾时延与吞吐
 * 3. 文件监听防抖 + 忽略规则（node_modules / dist / .git），杜绝噪声风暴
 * 4. 轮询源内容哈希比对：仅在内容真实变化时产生信号
 * 5. 全部资源（server / watcher / timer）由 stop() 统一回收，支持 cordis fiber 清理
 */
/** 统一信号对象（执行链路第 1 步产物） */
interface Signal {
  id: string;
  /** 信号类型：code-change / error-detected / performance-degraded / webhook / manual / cascade 等 */
  type: string;
  /** 人类可读描述 */
  description: string;
  /** 原始载荷 */
  payload: Record<string, any>;
  /** 紧急度 0~1（第 3 步由决策模型填充） */
  urgency?: number;
  receivedAt: number;
  /** 来源标识：webhook:9878 / fs:/path / poll:url / manual / cascade */
  source: string;
  /** 聚合去重键（缺省取 type + description） */
  dedupeKey?: string;
  /** 窗口内被合并的原始信号次数 */
  occurrences: number;
  /** 所属租户（多租户路由后填充） */
  tenantId?: string;
  /** 截止时间（毫秒时间戳）：截止时间感知调度依据 */
  deadlineMs?: number;
  /** 富化上下文（哨兵自动附加：到达速率 / 关联信号 / 历史频率） */
  enrichment?: SignalEnrichment;
}
/** 信号富化上下文（感知环节深度优化产物） */
interface SignalEnrichment {
  /** 该类型信号最近 1 分钟到达次数（突发检测依据） */
  recentRatePerMin: number;
  /** 该类型信号历史总次数 */
  historicalCount: number;
  /** 是否突发（recentRatePerMin 超过基线 3 倍） */
  isBurst: boolean;
  /** 关联信号 id 列表（时间邻近 + 类型关联） */
  correlatedSignalIds: string[];
  /** 当前生效的聚合窗口（毫秒，自适应） */
  effectiveWindowMs: number;
}
/** 信号源配置 */
interface SignalSourceConfig {
  type: 'webhook' | 'polling' | 'filesystem';
  /** webhook 监听端口 */
  port?: number;
  /** polling 间隔（毫秒） */
  interval?: number;
  /** polling 目标 URL */
  url?: string;
  /** filesystem 监听路径 */
  path?: string;
  /** 该源产生的信号类型 */
  signalType: string;
}
/** 哨兵配置（对应 cordis.patch.yml sentinel 节） */
interface SentinelConfig {
  watchCodeChanges: boolean;
  watchErrors: boolean;
  watchPerformance: boolean;
  /** 聚合窗口（秒） */
  aggregationWindow: number;
  signalSources?: SignalSourceConfig[];
  /** 文件监听根目录（watchCodeChanges 启用时） */
  watchDir?: string;
  /** 批次大小上限（达到即提前交付） */
  maxBatchSize?: number;
  /** fetch 实现注入（测试用） */
  fetchImpl?: typeof fetch;
}
/** 聚合批次（执行链路第 2 步产物） */
interface SignalBatch {
  signals: Signal[];
  aggregatedAt: number;
  /** 交付原因：窗口到期 / 批量上限 / 手动 flush */
  reason: 'window' | 'max-size' | 'flush';
}
/** 哨兵运行时状态 */
interface SentinelStatus {
  running: boolean;
  pendingSignals: number;
  totalIngested: number;
  totalBatches: number;
  sources: Array<{
    type: string;
    detail: string;
    active: boolean;
  }>;
  aggregationWindow: number;
  /** 当前自适应窗口（毫秒） */
  effectiveWindowMs: number;
  /** 累计突发次数 */
  burstCount: number;
  /** 各类型信号历史计数 */
  historicalCounts: Record<string, number>;
}
/**
 * 信号感知哨兵
 *
 * 被 index.ts 持有：start() 后持续产生 SignalBatch，
 * 编排层对每个批次执行第 3~10 步链路。
 */
declare class Sentinel {
  private config;
  private onBatch;
  private fetchImpl;
  private pending;
  private dedupeIndex;
  private windowTimer;
  private webhookServers;
  private fsWatchers;
  private pollTimers;
  private pollHashes;
  private fsDebounceTimer;
  private fsPendingPaths;
  private running;
  private totalIngested;
  private totalBatches;
  /** 各类型信号到达时间戳环形缓冲（突发检测 / 速率统计） */
  private arrivalHistory;
  /** 各类型信号历史总次数 */
  private historicalCounts;
  /** 各类型信号到达速率基线（指数移动平均，次/分钟） */
  private rateBaseline;
  /** 最近注入的信号（关联分析用，保留 50 条；ingest 时即记录，无需等待交付） */
  private recentSignals;
  /** 当前自适应窗口（毫秒） */
  private currentWindowMs;
  /** 突发计数（最近窗口内被判定为突发的次数） */
  private burstCount;
  /**
   * @param config 哨兵配置
   * @param onBatch 批次交付回调（编排层入口）
   */
  constructor(config: SentinelConfig, onBatch: (batch: SignalBatch) => void);
  /**
   * 启动所有信号源
   */
  start(): void;
  /**
   * 停止所有信号源并清空待处理缓冲（不交付残余信号）
   */
  stop(): void;
  /**
   * 注入一个信号（手动 / webhook / 文件监听 / 轮询 / 级联统一入口）
   * @param partial 信号字段（id / receivedAt / occurrences 自动补齐）
   * @returns 归一化后的 Signal（若被窗口内去重则返回已存在的信号）
   */
  ingest(partial: Omit<Signal, 'id' | 'receivedAt' | 'occurrences'> & Partial<Signal>): Signal;
  /**
   * 信号富化：到达速率统计 + 突发检测 + 关联分析 + 自适应窗口调整
   * @param signal 待富化信号
   */
  private enrich;
  /** 自适应窗口调整：突发 → 缩短至 1/4（下限 50ms）；平稳 → 逐步恢复配置值 */
  private adaptWindow;
  /**
   * 立即交付当前待处理批次（无待处理信号时为空操作）
   * @param reason 交付原因标记
   */
  flush(reason?: SignalBatch['reason']): void;
  /** 当前待处理信号（只读快照） */
  getPendingSignals(): Signal[];
  /**
   * 哨兵运行状态（manage_consensus / model_dashboard 等 Tool 可引用）
   */
  getStatus(): SentinelStatus;
  /** 确保聚合窗口定时器存在（首个信号触发开窗，使用自适应窗口） */
  private ensureWindowTimer;
  /** 启动 webhook 信号源 */
  private startWebhook;
  /** 启动文件监听信号源（递归监听 + 防抖 + 忽略规则） */
  private startFileWatch;
  /** 启动轮询信号源（内容哈希比对） */
  private startPolling;
}
//#endregion
//#region src/decision-engine.d.ts
/** 决策动作 */
type DecisionAction = 'execute' | 'defer' | 'dismiss' | 'ask-user';
/** 决策结果 */
interface Decision {
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
interface DecisionEngineConfig {
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
interface StrategistVerdict {
  urgency: number;
  decision: DecisionAction;
  reason?: string;
  deferMs?: number;
}
/** 信号历史统计（由长期记忆提供，注入决策上下文） */
interface SignalHistoryStats {
  totalDecisions: number;
  successRate: number;
  avgExecutionTime: number;
  avgTokenCost: number;
}
/** 决策审计记录 */
interface DecisionAuditEntry {
  signalId: string;
  fingerprint: string;
  decision: Decision;
  /** 事后结果反馈 */
  outcome?: 'excellent' | 'good' | 'acceptable' | 'poor' | 'failed';
}
/** 默认配置 */
declare const DEFAULT_DECISION_ENGINE_CONFIG: DecisionEngineConfig;
/** 决策引擎统计（运维可观测） */
interface DecisionEngineStats {
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
declare class DecisionEngine {
  private config;
  private cache;
  /** 类型 → 连续失败计数 */
  private consecutiveFailures;
  /** 指纹 → 最近成功执行时间（重复抑制用） */
  private recentSuccess;
  /** 决策审计环形缓冲 */
  private audit;
  private stats;
  /** 19.0：机会停止器（挂载后 defer/execute 由继续价值阈值裁决） */
  private stopper?;
  /** 19.0：defer 窗口内的预计剩余机会数（继续价值 V_{k−1} 的口径） */
  private stopperHorizon;
  /** 19.0：停止器裁决审计（最近若干次） */
  private stopperVerdicts;
  constructor(config?: Partial<DecisionEngineConfig>);
  /**
   * 19.0：挂载最优停止内核（幂等；挂载后规则 C 的成本闸门从
   * 「urgency < 0.3 且 cost > 5000 → defer」的魔数口径升级为
   * 继续价值裁决：每类信号的紧急度流喂入经验分布，defer 窗口内
   * 预计还有 horizon 次同类机会——当前紧急度 ≥ V_{horizon}（向后
   * 归纳精确阈值）即执行（占坑数学最优），否则 defer（等待有价）。
   * 不 attach 即零漂移（原魔数规则）。
   */
  attachOptimalStopper(options?: {
    horizon?: number;
    minSamples?: number;
  }): void;
  /** 19.0：最近停止器裁决审计 */
  getStopperVerdicts(limit?: number): Array<{
    signalType: string;
    at: number;
    act: boolean;
    value: number;
    threshold: number;
  }>;
  /**
   * 对一批信号做决策（四级流水线）
   * @param signals 聚合后的信号批次
   * @param history 每类信号的历史统计（长期记忆提供）
   * @returns signalId → Decision
   */
  decide(signals: Signal[], history: Map<string, SignalHistoryStats>): Promise<Map<string, Decision>>;
  /**
   * 结果反馈闭环：依据执行结果修正缓存置信度与规则计数器
   * @param signalType 信号类型
   * @param fingerprint 信号指纹（缺省按 type+description 计算需提供 description）
   * @param outcome 执行结果
   */
  recordOutcome(signalType: string, fingerprint: string, outcome: DecisionAuditEntry['outcome']): void;
  /** 计算信号指纹（对外暴露，供编排层沉淀反馈时使用） */
  fingerprint(signal: Pick<Signal, 'type' | 'description'>): string;
  /**
   * 运行时配置热更新（策略进化引擎的基因组落地入口）
   * @param patch 配置补丁（仅覆盖提供的字段，strategist 回调不可经此修改）
   */
  updateConfig(patch: Partial<Omit<DecisionEngineConfig, 'strategist'>>): void;
  /** 当前配置快照（不含 strategist 回调） */
  getConfig(): Omit<DecisionEngineConfig, 'strategist'>;
  /** 决策引擎运行统计 */
  getStats(): DecisionEngineStats;
  /** 最近决策审计记录 */
  getAudit(limit?: number): DecisionAuditEntry[];
  /** 清空缓存与计数器（测试/重置用） */
  reset(): void;
  /** 第 1 级：规则快速路径 */
  private applyRules;
  /**
   * 19.0：机会价值评估（规则 C 内部调用）。
   *
   * 紧急度流已在 decide() 逐信号喂入停止器；此处评估当前抽值是否
   * 越过继续价值。未挂载或经验不足（insufficient）返回 undefined
   * ——回退原魔数口径（诚实弃权，零漂移）。
   */
  private assessOpportunity;
  /** 第 2 级：缓存查询（校验 TTL 与置信度） */
  private lookupCache;
  /** 缓存写入（LRU 淘汰） */
  private storeCache;
  /** 第 3 级：strategist 裁定 → Decision（含置信度与低置信升级） */
  private fromStrategist;
  /** 第 4 级：启发式兜底（保守执行） */
  private heuristic;
  /** 审计记录（环形缓冲上限 200） */
  private auditDecision;
  /** 清理过期的重复抑制记录 */
  private trimRecentSuccess;
}
//#endregion
//#region src/errors.d.ts
/**
 * errors.ts — 统一错误体系（AppError）
 *
 * 架构文档要求：所有模块的错误处理使用统一的 AppError 体系。
 * 每个子类携带稳定的机器可读 code，便于 Tool 层与日志层统一消费。
 */
/** 应用错误基类，所有业务错误的根类型 */
declare class AppError extends Error {
  /** 机器可读错误码，如 CRYPTO_ERROR / MEMORY_ERROR */
  readonly code: string;
  /** 附加上下文信息（不含敏感数据） */
  readonly details?: Record<string, unknown>;
  constructor(message: string, code?: string, details?: Record<string, unknown>);
}
/** 配置错误：cordis.patch.yml / 租户配置非法或缺失 */
declare class ConfigError extends AppError {
  constructor(message: string, details?: Record<string, unknown>);
}
/** 加密错误：加解密失败、密钥无效、加密功能未启用 */
declare class CryptoError extends AppError {
  constructor(message: string, details?: Record<string, unknown>);
}
/** 记忆错误：持久化读写失败、记忆库损坏 */
declare class MemoryError extends AppError {
  constructor(message: string, details?: Record<string, unknown>);
}
/** 网络错误：WebSocket / HTTP / 节点间通信失败 */
declare class NetworkError extends AppError {
  constructor(message: string, details?: Record<string, unknown>);
}
/** 超时错误：模型调用或任务执行超过时限 */
declare class TimeoutError extends AppError {
  constructor(message: string, details?: Record<string, unknown>);
}
//#endregion
//#region src/types.d.ts
/** DAG 计划节点 */
interface PlanNode {
  id: string;
  description: string;
  /** 任务类型（code-generation / documentation / analysis 等） */
  type: string;
  dependsOn: string[];
  /** 指定模型（缺省由模型调度决定） */
  modelId?: string;
  /** 节点级超时覆盖（毫秒） */
  timeout?: number;
  /** 完成后级联触发的信号描述 */
  cascade?: Array<{
    type: string;
    description: string;
  }>;
}
/** 执行计划（优化器快路径召回 / strategist DAG / 离线兜底 三类来源） */
interface ExecutionPlan {
  objective: string;
  nodes: PlanNode[];
  parallelismStrategy: string;
  /** 计划来源：strategist 模型 / 离线兜底 / 记忆复用 */
  source: 'strategist' | 'fallback' | 'memory';
}
/** 单节点执行结果 */
interface NodeResult {
  nodeId: string;
  modelId: string;
  success: boolean;
  output?: string;
  /** 质量分 0~1（nodeRunner 自评或启发式） */
  quality: number;
  latency: number;
  attempts: number;
  error?: string;
  tokensUsed: number;
}
/** 计划执行结果 */
interface PlanExecutionResult {
  planId: string;
  success: boolean;
  nodeResults: NodeResult[];
  totalTime: number;
  successCount: number;
  totalTokens: number;
  /** 平均质量分（仅成功节点） */
  avgQuality: number;
  error?: string;
}
/** 节点执行器签名（可注入，测试可离线模拟） */
type NodeRunner = (params: {
  node: PlanNode;
  modelId: string;
  context: Record<string, string>;
  signal: Signal;
  /** 全局中止信号（计划级超时/外部中止时中断在途 LLM 请求） */
  abortSignal?: AbortSignal;
  attempt: number;
}) => Promise<{
  output: string;
  quality: number;
  tokensUsed?: number;
}>;
/** 级联触发回调（由 index.ts 桥接到 sentinel.ingest） */
type CascadeHandler = (newSignal: {
  type: string;
  description: string;
  payload: Record<string, any>;
}) => void;
/** 计划执行失败 */
declare class ExecutionError extends AppError {
  constructor(message: string, details?: Record<string, unknown>);
}
//#endregion
//#region src/core/causal-kernel.d.ts
/**
 * causal-kernel.ts — 因果内核（项目 5.0「从相关到因果」的质变基座）
 *
 * 升级前的根本局限（全模块通病）：
 * - 证据内核（evidence.ts）回答的是 P(成功 | 特征) —— 这是相关性；
 *   系统据此排序/调度/分红，但从未回答「正是这个因素导致了结果吗？」
 * - 相关 ≠ 因果的典型陷阱：健康模型总被派发简单任务 → 观测成功率虚高
 *   （任务难度是混杂因子）；某策略与成功共现 → 可能只是都发生在低峰期。
 * - 一切「调参 / 换模型 / 进化」的决策依据都停留在 observational 层。
 *
 * 本内核引入 Pearl 因果阶梯的第二层 —— do-干预：
 * 1. 双流证据：每条因果边同时维护「干预证据」（do(X=x) 后观测 Y，
 *    如 A/B 实验真实切换）与「观测证据」（被动共现）——两层统计口径
 *    显式分离，永不混账。
 * 2. 干预效应估计：ATE = P(Y=1|do(X=1)) − P(Y=1|do(X=0))，
 *    每臂独立 Beta 后验 + Wilson 风格保守下界 —— 小样本实验不虚报因果。
 * 3. 混杂检测：观测关联与干预效应的显著背离 = 混杂因子的指纹。
 *    「冰淇淋销量 ↔ 溺水」类伪因果在此被自动标记（observationalOnly
 *    边的因果置信度被结构性折扣）。
 * 4. 反事实查询：actualOutcome 与 alternativeAction 的效应对比 ——
 *    「若当时选 B，成功概率几何」从哲学问题变为区间估计。
 * 5. 实验设计（好奇心接口）：不确定性最高（Beta 区间最宽）× 重要性
 *    最高（关联目标 KPI）的边优先做 do-实验 —— 假设驱动的好奇心。
 *
 * 与证据内核的关系：causal-kernel 建立在 evidence.ts 的同一套统计语言
 * （Beta 后验 / Wilson 下界 / 30 天时间衰减）之上，但回答的问题升了一层：
 * evidence.ts 问「它表现如何」，causal-kernel 问「是不是它造成的」。
 *
 * 审计性：全部干预记录（谁、何时、do 了什么、结果）保留链式日志，
 * 因果结论可追溯到每一次实验 —— 因果断言可被审计、可被证伪。
 */
/** 因果节点种类（动作 / 旋钮 / 指标 / 情境） */
type CausalNodeKind = 'action' | 'knob' | 'kpi' | 'context';
/** 因果节点（变量） */
interface CausalNode {
  id: string;
  kind: CausalNodeKind;
  label?: string;
}
/**
 * 因果边双流证据（X → Y）
 *
 * 干预流（黄金证据）：
 * - doXSuccess/doXFailure：do(X=1) 后 Y=1 / Y=0 的次数（处理组）
 * - doNotXSuccess/doNotXFailure：do(X=0) 后 Y=1 / Y=0 的次数（对照组）
 *
 * 观测流（银级证据，受混杂污染）：
 * - obsBoth：X=1 且 Y=1（联合）
 * - obsXOnly：X=1 且 Y=0
 * - obsYOnly：X=0 且 Y=1
 * - obsNeither：X=0 且 Y=0
 */
interface CausalEdgeEvidence {
  doXSuccess: number;
  doXFailure: number;
  doNotXSuccess: number;
  doNotXFailure: number;
  obsBoth: number;
  obsXOnly: number;
  obsYOnly: number;
  obsNeither: number;
  /** 惰性衰减基准（与 MemoryEvidence 同一语义） */
  lastDecayedAt: number;
}
/** 因果边（可序列化） */
interface CausalEdge {
  from: string;
  to: string;
  evidence: CausalEdgeEvidence;
  createdAt: number;
  lastTouchedAt: number;
}
/** 因果效应估计（对某条边的一次完整问答） */
interface CausalEffect {
  from: string;
  to: string;
  /** 平均处理效应 ATE = P(Y=1|do(X=1)) − P(Y=1|do(X=0)) */
  ate: number;
  /** ATE 保守下界（处理组下界 − 对照组上界，最悲观口径） */
  lower: number;
  /** ATE 乐观上界 */
  upper: number;
  /** 处理臂后验 P(Y=1|do(X=1))（无干预样本时回退观测估计并降权） */
  pDo: number;
  /** 对照臂后验 P(Y=1|do(X=0)) */
  pDoNot: number;
  /** 干预证据样本量（两臂合计） */
  interventionalSamples: number;
  /** 观测证据样本量（四格合计） */
  observationalSamples: number;
  /** 观测关联强度（P(Y=1|X=1) − P(Y=1|X=0)） */
  observationalAssociation: number;
  /** 混杂度 0~1：观测关联与干预效应的归一化背离 */
  confounding: number;
  /** 因果置信度 0~1（干预样本量 × 混杂折扣） */
  confidence: number;
  direction: 'positive' | 'negative' | 'none';
  /** 效应是否已确立（下界 > 0 或上界 < 0 且置信度足够） */
  established: boolean;
}
/** do-干预记录（审计链） */
interface InterventionRecord {
  seq: number;
  timestamp: number;
  from: string;
  to: string;
  /** 设定值（do(X=1) / do(X=0)） */
  setTo: boolean;
  /** 观测到的 Y */
  observedY: boolean;
  /** 干预发起方（如 'meta-cognition' / 'curiosity' / 'futarchy'） */
  actor: string;
  /** 干预理由（假设陈述） */
  hypothesis?: string;
}
/** 建议的因果实验（好奇心 → 实验设计） */
interface CausalExperiment {
  from: string;
  to: string;
  /** 建议的干预方向（先验更可能有效的一臂） */
  suggestedArm: boolean;
  /** 信息增益评分 0~1（不确定性 × 重要性） */
  infoGain: number;
  /** 实验假设（可读陈述） */
  hypothesis: string;
  /** 当前不确定性（Beta 区间宽度） */
  uncertainty: number;
}
/** 因果内核配置 */
interface CausalKernelConfig {
  /** 混杂告警的最小背离（|观测关联 − 干预效应|，默认 0.2） */
  confoundingThreshold: number;
  /** 因果确立的最小置信度（默认 0.5） */
  establishedConfidence: number;
  /** 单边干预记录上限（审计链截断保护） */
  maxInterventionLog: number;
  /** 实验建议的最小不确定性（Beta 区间宽度，默认 0.4） */
  experimentMinUncertainty: number;
}
declare const DEFAULT_CAUSAL_CONFIG: CausalKernelConfig;
/**
 * 因果内核：全系统共享的因果图 + do-干预登记处。
 *
 * 消费方：
 * - symbiosis/runtime：Shapley 分红用因果效应（而非线性权重）定价贡献
 * - world-model：do-干预效应预测（预见「若我这样做，世界会怎样」）
 * - reflection-engine：反事实反思（失败 → 「若选 B」教训）
 * - meta-cognition：旋钮推荐按因果效应排序（而非规则命中顺序）
 * - curiosity-engine：假设驱动实验设计（不确定性边 → do-实验 → 图更新）
 */
declare class CausalKernel {
  private config;
  private nodeMap;
  /** 边键 `${from}→${to}` */
  private edgeMap;
  /** 干预审计链（seq 单调递增） */
  private interventionLog;
  private seq;
  constructor(config?: Partial<CausalKernelConfig>);
  /** 登记因果节点（幂等；重复登记仅更新元信息） */
  addNode(node: CausalNode): void;
  /** 便捷登记：模型动作节点（from 形如 `use:model-x`） */
  private ensureNodes;
  /**
   * 被动观测（银级证据）：X 与 Y 的共现 —— 不做任何设定，只是看到。
   *
   * 观测证据只影响 observationalAssociation 与混杂度计算；
   * 无干预证据时作为 ATE 的降权回退估计。
   */
  observe(from: string, to: string, x: boolean, y: boolean, now?: number): void;
  /**
   * do-干预（黄金证据）：主动把 X 设为 setTo，观测结果 Y。
   *
   * 这是因果阶梯第二层的唯一入口 —— 每次真实 A/B 切换、每次参数实验、
   * 每次沙盒部署对照都应经此登记。审计链保留完整因果断言来源。
   *
   * @param actor 干预发起方（审计用）
   * @param hypothesis 实验假设（如「切换 model-b 可提升翻译成功率」）
   */
  intervene(from: string, to: string, setTo: boolean, observedY: boolean, actor: string, hypothesis?: string, now?: number): InterventionRecord;
  /**
   * 估计因果效应 ATE（对一条边的完整因果问答）。
   *
   * 口径优先级：
   * 1. 双臂干预证据齐全 → 纯干预 ATE（黄金口径）
   * 2. 仅处理臂 → 对照臂回退观测基线 P(Y=1|X=0)，混杂折扣已含在 confidence
   * 3. 无任何干预 → ATE = 观测关联 × 0.5（结构性折扣：未经实验的关联
   *    只值一半信任），confidence 上限 0.4（永不 established）
   */
  effect(from: string, to: string, now?: number): CausalEffect;
  /**
   * 因果排序：谁真正导致了 target（按效应下界降序）。
   *
   * 质变点：传统排序 = 相关性命中；本排序 = 已确立因果 > 高置信正效应 >
   * 待验证正效应。混杂严重的边即使观测关联再强也排不上来。
   */
  rankCauses(target: string, now?: number): CausalEffect[];
  /**
   * 混杂指纹检测：观测关联强但干预效应弱（或方向相反）的边。
   *
   * 返回的每条边都是一次「我们曾以为的因果」的证伪现场 ——
   * 调度器/优化器依赖这些边做的历史决策值得复查。
   */
  detectConfounding(now?: number): Array<CausalEffect & {
    divergence: number;
  }>;
  /**
   * 6.0：因果中介分析 —— 效应「经由什么机制」发生。
   *
   * X → M → Y 链上的效应分解（线性链近似，效应尺度用 ATE）：
   * - 总效应 total = effect(X→Y)
   * - 间接效应（经中介）indirect = effect(X→M) × effect(M→Y)
   * - 直接效应（绕过中介）direct = total − indirect
   * - 中介占比 share = indirect / |total|
   *
   * 质变点：此前系统只知道「模型 A 有效」，不知道「为什么有效」。
   * 中介分解回答机制问题：「model-fast 之所以提升成功率，80% 是
   * 因为它降低了延迟（latency），20% 是质量本身」——知识第一次
   * 拥有内部结构，机制理解支撑更精准的迁移决策。
   *
   * @param from 处理 X（如 model-fast）
   * @param mediator 中介 M（如 kpi:latency-improved）
   * @param to 结果 Y（如 task.outcome）
   */
  mediation(from: string, mediator: string, to: string, now?: number): {
    from: string;
    mediator: string;
    to: string;
    total: number;
    indirect: number;
    direct: number;
    /** 中介传导占比 0~1（间接/|总|；总效应近零时为 0） */
    share: number;
    /** 各段效应明细（链上每条边的完整问答） */
    path: {
      xm: CausalEffect;
      my: CausalEffect;
      xy: CausalEffect;
    };
    /** 机制解读 */
    mechanism: string;
  };
  /**
   * 反事实查询：给定实际发生了 actionActual 且结果为 actualY，
   * 「若当时做 actionAlternative」成功概率几何。
   *
   * 实现：两动作 → 同一结果的因果边后验对比（无证据时返回先验 0.5
   * 并以宽区间表达无知 —— 诚实的不确定性，而非假装知道）。
   */
  counterfactual(outcome: string, actionActual: string, actionAlternative: string, actualY: boolean, now?: number): {
    alternative: string;
    estimatedProb: number;
    lower: number;
    upper: number;
    actualProb: number;
    evidenceSamples: number;
    verdict: string;
  };
  /**
   * 假设驱动实验建议：不确定性最高 × 关联 target 的边优先做 do-实验。
   *
   * 信息增益 = Beta 区间宽度（不确定性）× max(观测关联, 已见干预效应)（重要性）。
   * 每条建议自带可读假设陈述 —— 好奇心从「随机探索」升级为
   * 「提出假设 → 设计实验 → do-干预 → 图更新」的科学循环。
   */
  suggestExperiments(target: string, budget?: number, now?: number): CausalExperiment[];
  /**
   * 10.0：单边证据明细（科学家内核的实验设计原料）。
   *
   * 暴露每条边两臂的原始成败计数与观测四格（含衰减口径），
   * 供外部按 Beta(1+s, 1+f) 精确重构臂后验并计算期望信息增益。
   * 只读快照，不暴露内部结构。
   */
  armEvidence(from: string, to: string, now?: number): CausalEdgeEvidence | undefined;
  /**
   * 11.0：全边衰减证据枚举（理论内核的归纳原料）。
   * 返回每条边的 (from, to, 衰减后双流证据)——理论内核据此分组归纳定律。
   */
  allEdgesEvidence(now?: number): Array<CausalEdgeEvidence & {
    from: string;
    to: string;
  }>;
  /** 图快照（节点 + 边效应摘要） */
  snapshot(now?: number): {
    nodes: CausalNode[];
    edgeCount: number;
    establishedEdges: CausalEffect[];
    confoundedEdges: Array<CausalEffect & {
      divergence: number;
    }>;
    interventions: number;
    topEdges: CausalEffect[];
  };
  /** 干预审计链（只读拷贝） */
  interventions(): InterventionRecord[];
  /** 序列化（持久化格式 = JSON） */
  serialize(): {
    nodes: CausalNode[];
    edges: CausalEdge[];
    interventions: InterventionRecord[];
    seq: number;
  };
  /** 反序列化 */
  deserialize(data: {
    nodes: CausalNode[];
    edges: CausalEdge[];
    interventions: InterventionRecord[];
    seq: number;
  }): void;
  /** 惰性衰减（写入路径，与 MemoryEvidence 同一语义） */
  private decayEdge;
  /** 读取式衰减视图（不回写） */
  private decayedView;
}
/** 联盟价值函数输入：单个贡献者的边际成功概率估计 */
interface ContributorProb {
  agentId: string;
  /** P(该贡献者的工作使任务成功) —— 反事实口径的个体成功率 */
  prob: number;
}
/**
 * noisy-OR 联盟价值：v(S) = 1 − Π_{i∈S}(1 − p_i)
 *
 * 语义：每个贡献者独立地「有机会」把任务做成功；任务成功只要
 * 至少一条路径走通。这是多模型协同（任一模型产出可用即成功）的
 * 忠实抽象，且让 Shapley 值有精确的子集枚举解。
 */
declare function coalitionValue(members: ContributorProb[]): number;
/**
 * Shapley 值（n ≤ 12 子集枚举精确；n > 12 确定性置换采样估计）。
 *
 * 精确路径：φ_i = Σ_{S ⊆ N∖{i}} [|S|! (n−|S|−1)! / n!] · [v(S ∪ {i}) − v(S)]
 *
 * 采样路径（n > 12）：固定 512 个随机排列（缺省 mulberry32 种子
 * 0xC0FFEE，确定性可复现；可注入自定义 rng），每个排列沿前缀逐步
 * 计算各贡献者的边际贡献，取全体排列的平均 —— 无偏估计，
 * 复杂度 O(512·n)。分界理由：n > 12 时 2^n 联盟枚举超过 4096 次
 * 联盟估值（n·2^(n−1) 次边际差），精确解成本指数膨胀而采样方差
 * 可控；且位掩码枚举在 n ≥ 33 时 `1 << others` 溢出 32 位整数
 * （死循环/错值），采样路径不依赖位掩码，任意 n 安全。
 *
 * 质变点：分红不再按「表现分的线性份额」（搭便车者只要有正分就
 * 永远分钱），而按「边际反事实贡献」——拔掉你，任务成功率掉多少，
 * 你就分多少。两个都干了活的智能体平分；只挂名不出力的边际贡献
 * ≈ 0，自然饿死（能量经济的真公平）。
 *
 * @param contributors 贡献者及其个体成功概率
 * @param rng 可选随机源注入（缺省 mulberry32(0xC0FFEE)，确定性采样）
 * @returns agentId → Shapley 值（采样路径下为边际贡献均值）
 */
declare function shapleyValues(contributors: ContributorProb[], rng?: () => number): Map<string, number>;
//#endregion
//#region src/core/conformal.d.ts
/**
 * conformal.ts — 保形校准内核（项目 13.0「预测的不确定性有了保证」质变基座）
 *
 * 升级前的根本局限（世界模型与质量反思的共性天花板）：
 * - 世界模型的预测区间是 sqrt(λ) 泊松近似——**没有覆盖率保证**：
 *   名义 95% 的区间实际覆盖多少，无人知晓（分布偏斜/过散时系统性失准）；
 * - 反思引擎的质量阈值 ±0.02 步进自校准——**没有风险保证**：重试率
 *   会冲到多少全凭运气，重试风暴与漏放低质量交替发生；
 * - 校准失效无法侦测：模型漂移后旧区间继续输出，直到下游连环失误
 *   才间接暴露——预测系统对「自己已经不可信」毫无察觉。
 *
 * 本内核引入保形预测与分布无关风险控制
 * （Vovk; Angelopoulos & Bates; Bates et al. RCPS）：
 *
 * 1. **分裂保形区间（split conformal）**：校准残差 |y−ŷ| 的
 *    ⌈(n+1)(1−α)⌉ 次序统计量为半径 q̂：
 *      P(y ∈ [ŷ−q̂, ŷ+q̂]) ≥ 1−α
 *    **精确有限样本保证，零分布假设**——只需校准集与新样本可交换。
 *    样本不足时区间诚实发散（finite: false），不伪装确定。
 *
 * 2. **覆盖漂移 e-过程监测（建在 12.0 之上）**：被覆盖指示
 *    1{covered} 在校准良好下条件均值 ≥ 1−α → 资本过程
 *    Π(1 + λ(1{covered} − (1−α)))（λ ≤ 0 可预测）是非负上鞅；
 *    e ≥ 1/δ → 以水平 δ 确证**区间正在失准**（欠覆盖），触发重校准。
 *    预测系统第一次拥有「自我怀疑」的合法检验。
 *
 * 3. **风险受控阈值选择（RCPS 思想 + 12.0 固定样本界）**：对候选
 *    阈值网格逐一计算风险上界（经验伯恩斯坦，Bonferroni 分摊置信度），
 *    取风险上界 ≤ 目标 α 的最激进阈值：
 *      P(未来风险 ≤ α) ≥ 1−δ
 *    反思引擎的重试率第一次被钉在数学上限之内。
 *
 * 与 12.0 的关系：12.0 保证「结论」永不夸大，本内核保证「预测与
 * 阈值」永不越界——二者合成预测-决策全链路的分布无关保证。
 * 与 3-11.0 的关系：世界模型的 MAE 校准（经验性的）继续服务趋势
 * 置信度；保形区间作为并行旁路叠加（不替换既有字段语义）。
 */
/**
 * 保形分位数（纯函数）：校准分数的 ⌈(n+1)(1−α)⌉ 次序统计量。
 *
 * 有限样本精确覆盖（可交换性下）：P(新样本分数 ≤ q̂) ≥ 1−α。
 * 秩超出 n（校准集太小撑不起该置信度）→ 返回 undefined（诚实发散）。
 */
declare function conformalQuantile(scores: number[], alpha: number): number | undefined;
/** 保形预测区间 */
interface ConformalInterval {
  /** 下界（finite=false 时为 −Infinity） */
  lower: number;
  /** 上界（finite=false 时为 +Infinity） */
  upper: number;
  /** 区间是否有限（false = 校准不足，诚实承认无法覆盖） */
  finite: boolean;
  /** 保形半径 q̂ */
  qhat: number;
  /** 校准样本量 */
  calibrationN: number;
  /** 名义误覆盖率 α（覆盖 ≥ 1−α） */
  alpha: number;
}
/** 覆盖漂移监测读取视图 */
interface CoverageDriftView {
  /** 当前 e-值（≥ 1/δ 确证欠覆盖漂移） */
  eValue: number;
  /** 是否已确证漂移（欠覆盖） */
  drifting: boolean;
  /** 观测覆盖率的 EMA（对照目标 1−α） */
  empiricalCoverage: number;
  /** 目标覆盖率 */
  targetCoverage: number;
  /** 观测数 */
  n: number;
}
/**
 * 覆盖漂移 e-过程监测器（12.0 复用）
 *
 * 语义：校准良好的区间在每个时刻的条件覆盖率 ≥ 1−α。资本过程
 * e_t = Π(1 + λ_i(C_i − (1−α)))，λ_i ≤ 0 可预测，在「覆盖率达标」
 * 零假设下是非负上鞅（Ville：P(∃t: e ≥ 1/δ) ≤ δ）。连续欠覆盖
 * 会让资本指数上升 → e ≥ 1/δ 确证漂移 → 建议重校准。
 */
declare class CoverageDriftMonitor {
  /** 名义误覆盖率 α（目标覆盖率 1−α） */
  readonly alpha: number;
  /** 漂移确证水平 δ（e ≥ 1/δ 确证；缺省 0.01） */
  readonly delta: number;
  private capital;
  private n;
  private coverageEma;
  constructor(
  /** 名义误覆盖率 α（目标覆盖率 1−α） */
  alpha: number,
  /** 漂移确证水平 δ（e ≥ 1/δ 确证；缺省 0.01） */
  delta: number);
  /** 观测一次预测是否覆盖真值 */
  observe(covered: boolean): CoverageDriftView;
  /** 当前视图 */
  view(): CoverageDriftView;
  /** 重置（重校准后重启监测） */
  reset(): void;
}
/** 保形区间引擎配置 */
interface ConformalIntervalConfig {
  /** 名义误覆盖率 α（区间覆盖 ≥ 1−α，缺省 0.1） */
  alpha: number;
  /** 校准集容量上限（FIFO；缺省 200） */
  maxCalibration: number;
  /** 覆盖漂移确证水平 δ（缺省 0.01） */
  driftDelta: number;
}
declare const DEFAULT_CONFORMAL_CONFIG: ConformalIntervalConfig;
/** 保形引擎状态报告 */
interface ConformalStatus {
  calibrationN: number;
  alpha: number;
  /** 当前保形半径（校准不足时 undefined） */
  qhat?: number;
  /** 漂移监测视图 */
  drift: CoverageDriftView;
  /** 累计发出的区间数 / 覆盖数（经验口径） */
  emitted: number;
  covered: number;
  interpretation: string;
}
/**
 * 保形区间引擎
 *
 * 数据流：
 *   预测前：interval(pointForecast) → 带 1−α 精确覆盖保证的区间
 *   真值到达：calibrate(|y − ŷ|) 入校准集 + recordCovered(覆盖?) 喂漂移监测
 *   漂移确证：drifting=true → 调用方重校准（resetDrift 重启监测）
 */
declare class ConformalIntervalEngine {
  private readonly config;
  private calibration;
  private monitor;
  private emitted;
  private coveredCount;
  constructor(config?: Partial<ConformalIntervalConfig>);
  /** 名义误覆盖率 */
  get alpha(): number;
  /** 校准样本量 */
  get calibrationSize(): number;
  /** 当前保形半径（校准不足时 undefined） */
  get qhat(): number | undefined;
  /** 入校准样本（残差 = |真值 − 点预测|） */
  calibrate(residual: number): void;
  /**
   * 为点预测生成保形区间。
   *
   * 校准充足（秩 ≤ n）：[ŷ−q̂, ŷ+q̂]，精确覆盖 ≥ 1−α；
   * 校准不足：finite=false（lower=−∞/upper=+∞）——诚实承认无法覆盖。
   */
  interval(pointForecast: number): ConformalInterval;
  /** 登记一次覆盖结果（漂移监测 + 经验覆盖统计） */
  recordCovered(covered: boolean): CoverageDriftView;
  /** 重校准后重启漂移监测（保留校准集——它承载新分布的证据） */
  resetDrift(): void;
  /** 引擎状态 */
  status(): ConformalStatus;
}
/** 风险受控阈值选择结果 */
interface RiskControlResult {
  /** 选定阈值（网格中最激进的合格者） */
  threshold: number;
  /** 该阈值下的经验风险（样本口径） */
  empiricalRisk: number;
  /** 风险上界（1−δ 置信；≤ target 是入选资格） */
  riskBound: number;
  /** 目标风险 α */
  target: number;
  /** 置信度 1−δ */
  confidence: number;
  /** 参与选择的样本量 */
  samples: number;
  /** 候选网格大小 */
  grid: number;
  interpretation: string;
}
/**
 * 风险受控阈值选择（RCPS 思想：固定候选网格 + Bonferroni 分摊
 * + 12.0 经验伯恩斯坦上界）
 *
 * 语义：risk(λ) = P(X < λ)（如质量分低于阈值触发重试的概率）。
 * 对每个 λ ∈ grid 用 1−δ/G 置信上界估计 risk(λ)，取上界 ≤ α 的
 * **最大** λ（最激进/最严格的质量门槛）：
 *   P(未来真实风险 ≤ α) ≥ 1−δ
 *
 * 用于反思引擎重试阈值：保证「重试率 ≤ α」的同时把质量门槛推到
 * 数学允许的最严处——旧 ±0.02 步进启发式被带保证的选择取代。
 *
 * 样本不足（无合格 λ）→ 返回 undefined（调用方回退既有逻辑）。
 */
declare function selectRiskControlledThreshold(samples: number[], grid: number[], options?: {
  targetRisk?: number;
  confidence?: number;
}): RiskControlResult | undefined;
//#endregion
//#region src/reflection-engine.d.ts
/** 评审模型签名（可注入） */
type JudgeModel = (params: {
  taskDescription: string;
  output: string;
  taskType: string;
}) => Promise<{
  score: number;
  completeness: number;
  correctness: number;
  maintainability: number;
  comment: string;
}>;
/** 教训提取器签名（可注入，通常由 strategist 模型承担） */
type LessonExtractor = (params: {
  signalDescription: string;
  taskType: string;
  errorMessage: string;
  failedNodeId: string;
  failedModelId: string;
}) => Promise<{
  rootCause: RootCauseCategory;
  lesson: string;
  suggestion: string;
}>;
/** 根因分类 */
type RootCauseCategory = 'model-capability' | 'timeout' | 'dependency' | 'prompt-ambiguity' | 'transient' | 'unknown';
/** 结构化教训 */
interface Lesson {
  id: string;
  timestamp: number;
  taskType: string;
  rootCause: RootCauseCategory;
  lesson: string;
  suggestion: string;
  signalDescription: string;
  /** 5.0：反事实教训（失败 → 「若选 B」的因果估计） */
  counterfactual?: CounterfactualInsight;
}
/**
 * 5.0：反事实洞察 ——「若当时选 B」的因果区间估计。
 *
 * 质变点：传统教训只回答「为什么失败」（归因过去）；
 * 反事实教训回答「怎样会成功」（指导未来的反事实推理）。
 */
interface CounterfactualInsight {
  /** 实际采用的模型 */
  actualModel: string;
  /** 反事实最优替代 */
  bestAlternative: string;
  /** 替代模型的估计成功概率（因果口径，非相关） */
  estimatedProb: number;
  /** 区间下界 */
  lower: number;
  /** 区间上界 */
  upper: number;
  /** 可读结论 */
  verdict: string;
  /** 证据样本量（不足时建议先做实验而非直接切换） */
  evidenceSamples: number;
}
/** 质量趋势记录 */
interface QualityTrendPoint {
  timestamp: number;
  taskType: string;
  avgQuality: number;
  success: boolean;
}
/** 质量趋势摘要（按任务类型聚合） */
interface TrendSummary {
  threshold: number;
  windowSize: number;
  byType: Record<string, {
    samples: number;
    avgQuality: number;
    successRate: number;
    trending: 'rising' | 'falling' | 'stable';
  }>;
  /** 13.0：当前阈值的风险依据（挂载风险控制器后输出） */
  basis?: RiskControlResult;
}
/** 反思引擎配置 */
interface ReflectionEngineConfig {
  /** 初始质量阈值 */
  qualityThreshold: number;
  /** 阈值自校准的最小样本数 */
  calibrationMinSamples: number;
  /** 阈值自校准步长 */
  calibrationStep: number;
  /** 阈值允许的范围 */
  thresholdRange: [number, number];
  /** 质量趋势滑动窗口大小 */
  trendWindowSize: number;
  /** 连续下滑触发告警的次数 */
  declineAlertCount: number;
  /** 评审模型（缺省则使用执行器自带质量分） */
  judge?: JudgeModel;
  /** 教训提取器（缺省则使用规则化提取） */
  lessonExtractor?: LessonExtractor;
}
/** 反思结论 */
interface ReflectionVerdict {
  /** 综合质量分（评审模型 or 执行器质量分） */
  quality: number;
  /** 是否达标 */
  passed: boolean;
  /** 重试建议：retry-same / retry-switch / no-retry */
  retryAdvice: 'retry-same' | 'retry-switch' | 'no-retry';
  /** 建议理由 */
  reason: string;
  /** 评审明细（judge 可用时） */
  dimensions?: {
    completeness: number;
    correctness: number;
    maintainability: number;
    comment: string;
  };
}
/** 默认配置 */
declare const DEFAULT_REFLECTION_CONFIG: ReflectionEngineConfig;
/**
 * 质量反思引擎
 *
 * 被 index.ts 持有：executor 执行完成后调用 reflect() 进行深度反思，
 * 失败时调用 extractLesson() 沉淀教训，阈值通过 getCurrentThreshold() 动态获取。
 */
declare class ReflectionEngine {
  private config;
  private lessons;
  private trendWindow;
  /** 各任务类型的质量历史（用于自校准；带时间戳支持衰减均值） */
  private qualityHistory;
  /** 当前动态阈值 */
  private currentThreshold;
  /** 告警回调（由 index.ts 桥接到进度广播） */
  private onAlert?;
  private lessonCounter;
  /** 5.0：因果内核（挂载后失败反思自动触发反事实分析） */
  private causal?;
  /** 13.0：风险受控阈值选择配置（挂载后 ±0.02 步进启发式退役） */
  private riskControl?;
  /** 13.0：最近一次阈值选择的风险依据（可观测/可审计） */
  private thresholdBasis?;
  constructor(config?: Partial<ReflectionEngineConfig>);
  /**
   * 13.0：挂载风险受控阈值选择器（幂等）。
   *
   * 质变点：阈值自校准从「±0.02 步进启发式」（重试率全凭运气）升级为
   * 分布无关的**带保证选择**——每轮从历史质量分布中选出「未来重试率
   * ≤ targetRisk」以 confidence 置信成立的最严格质量门槛：
   *   P(未来重试率 ≤ targetRisk) ≥ confidence
   * 质量普遍优秀 → 风险余量大 → 门槛自动收紧；能力不足 → 门槛自动
   * 让位，但重试率上界永不突破——重试风暴在数学上被封顶。
   */
  attachRiskController(options?: {
    targetRisk?: number;
    confidence?: number;
    gridSteps?: number;
  }): void;
  /** 13.0：最近一次阈值选择的风险依据（未挂载或未决出时 undefined） */
  getThresholdBasis(): RiskControlResult | undefined;
  /** 设置告警回调 */
  setAlertHandler(handler: (alert: {
    type: string;
    message: string;
    taskType: string;
  }) => void): void;
  /** 5.0：挂载因果内核（幂等） */
  attachCausalKernel(kernel: CausalKernel): void;
  /**
   * 5.0：反事实分析 —— 失败后的「若选 B」推理。
   *
   * 对每个候选替代模型查询因果内核：do(use:B) → task.outcome 的
   * 后验成功概率（黄金口径：仅干预证据 ≥ 3 时采信，观测证据降权），
   * 返回最优替代与可读结论。
   *
   * 质变点：教训从「A 超时了」升级为「A 超时了；若当时用 B，
   * 成功概率 0.78 [0.62, 0.91]（12 次干预证据）」——
   * 下次调度的切换决策第一次有了反事实依据。
   *
   * @param outcomeNode 因果图的结果节点（默认 'task.outcome'）
   */
  reflectCounterfactual(params: {
    failedModelId: string;
    alternativeModelIds: string[];
    actualSuccess: boolean;
    outcomeNode?: string;
  }): CounterfactualInsight | null;
  /**
   * 对单个节点输出做深度反思
   * @param params 节点输出与上下文
   * @returns 反思结论
   */
  reflect(params: {
    node: {
      id: string;
      description: string;
      type: string;
    };
    output: string;
    baseQuality: number;
    signal: Signal;
  }): Promise<ReflectionVerdict>;
  /**
   * 从失败执行中提取教训（异步，失败不阻塞主流程）
   * @param params 失败上下文
   * @returns 提取的教训
   */
  extractLesson(params: {
    signal: Signal;
    taskType: string;
    result: PlanExecutionResult;
    plan: ExecutionPlan;
  }): Promise<Lesson | null>;
  /**
   * 记录一次执行结果到趋势窗口并触发自校准
   * @param taskType 任务类型
   * @param quality 平均质量分
   * @param success 是否成功
   */
  recordExecution(taskType: string, quality: number, success: boolean): void;
  /** 当前动态质量阈值 */
  getCurrentThreshold(): number;
  /** 设置质量阈值（元认知自调优落地入口，限制在允许范围内） */
  setQualityThreshold(value: number): void;
  /** 获取指定任务类型的相关教训（供计划生成引用） */
  getLessons(taskType: string, limit?: number): Lesson[];
  /** 全部教训 */
  getAllLessons(): Lesson[];
  /**
   * 直接追加一条结构化教训（轻量入口，无需完整 PlanExecutionResult）。
   * 供宿主融合层等外部观测面在宿主工具连续失败时沉淀经验。
   * @param params 教训字段（id / timestamp 自动补齐）
   * @returns 追加的 Lesson
   */
  addLesson(params: {
    taskType: string;
    rootCause: RootCauseCategory;
    lesson: string;
    suggestion: string;
    signalDescription: string;
  }): Lesson;
  /** 质量趋势摘要 */
  getTrendSummary(): TrendSummary;
  /** 重试建议：依据教训库与根因判断 */
  private adviseRetry;
  /** 质量下滑告警检测 */
  private checkDeclineAlert;
  /**
   * 阈值自校准
   *
   * 13.0 质变（风险受控选择）：挂载 attachRiskController 后，校准从
   * 「时间衰减均值 ±0.02 步进」升级为分布无关的带保证选择——
   * 对候选网格逐一计算「质量 < λ 即重试」的风险上界（经验伯恩斯坦 +
   * Bonferroni 分摊），取上界 ≤ targetRisk 的最严格 λ：
   *   P(未来重试率 ≤ targetRisk) ≥ confidence
   * 重试率第一次被钉在数学上限之内；无合格候选（能力全面不足）时
   * 保持现阈值不动（宁可不调，不可越界）。
   *
   * 未挂载时维持 4.0 行为（半衰期 30 天时间加权均值 ±0.02 步进）。
   */
  private calibrateThreshold;
  /** 趋势方向判断 */
  private trendDirection;
}
//#endregion
//#region src/goal-engine.d.ts
/** 洞察来源（目标生成的输入） */
interface Insight {
  /** 洞察来源引擎 */
  source: 'reflection' | 'meta-cognition' | 'memory' | 'user' | 'market';
  /** 洞察类别 */
  category: string;
  /** 关联任务类型（可选） */
  taskType?: string;
  /** 严重度 0~1（越高越值得生成目标） */
  severity: number;
  /** 洞察描述 */
  message: string;
  /** 改进建议（目标生成的种子） */
  suggestion: string;
}
/** 目标子任务 */
interface GoalSubtask {
  id: string;
  description: string;
  /** 子任务类型（注入哨兵时作为信号类型） */
  taskType: string;
  status: 'pending' | 'dispatched' | 'done' | 'failed';
  /** 绑定的执行信号 id（dispatched 后回填） */
  signalId?: string;
  /** 执行结果摘要 */
  result?: string;
  attempts: number;
}
/** 目标状态 */
type GoalStatus = 'proposed' | 'active' | 'in-progress' | 'completed' | 'abandoned';
/** 自主目标 */
interface Goal {
  id: string;
  title: string;
  description: string;
  /** 目标来源 */
  origin: Insight['source'];
  /** 生成该目标的洞察摘要 */
  insightRef: string;
  status: GoalStatus;
  /** 价值分（impact × confidence / cost） */
  valueScore: number;
  impact: number;
  confidence: number;
  estimatedCost: number;
  createdAt: number;
  updatedAt: number;
  /** 完成时限（毫秒时间戳，可选） */
  deadline?: number;
  subtasks: GoalSubtask[];
  /** 关联任务类型（用于匹配完成信号） */
  taskType?: string;
}
/** 目标分解器签名（可注入，通常为 strategist LLM） */
type GoalDecomposer = (goal: Goal) => Promise<Array<{
  description: string;
  taskType: string;
}>>;
/** 目标引擎配置 */
interface GoalEngineConfig {
  /** 生成目标的最低洞察严重度 */
  minInsightSeverity: number;
  /** 同时活跃的目标上限（防止目标膨胀） */
  maxActiveGoals: number;
  /** 子任务最大重试次数（超过则放弃目标） */
  maxSubtaskAttempts: number;
  /** 目标去重相似度门槛（标题归一化后包含关系视为重复） */
  dedupeEnabled: boolean;
  /** 目标分解器（缺省则规则化单步分解） */
  decomposer?: GoalDecomposer;
}
/** 默认配置 */
declare const DEFAULT_GOAL_ENGINE_CONFIG: GoalEngineConfig;
/**
 * 自主目标引擎
 *
 * 被 index.ts 持有：autonomy-loop 每轮心跳调用 generateGoalsFromInsights
 * 产出目标，再将分解后的子任务注入哨兵执行，执行结果经
 * recordSubtaskOutcome 回写进度，形成"洞察 → 目标 → 行动 → 达成"闭环。
 */
declare class GoalEngine {
  private config;
  private goals;
  private goalCounter;
  private subtaskCounter;
  constructor(config?: Partial<GoalEngineConfig>);
  /**
   * 从洞察批量生成目标（自主目标生成的核心入口）
   * @param insights 来自反思/元认知/记忆的洞察列表
   * @returns 新生成的目标（去重后）
   */
  generateGoalsFromInsights(insights: Insight[]): Goal[];
  /**
   * 分解目标为子任务（LLM 分解 + 规则兜底）
   * @param goalId 目标 id
   * @returns 分解出的子任务列表
   */
  decompose(goalId: string): Promise<GoalSubtask[]>;
  /**
   * 选取下一个待执行子任务（价值最高目标优先，FIFO 次序）
   * @returns 目标与子任务，无待执行项时返回 null
   */
  pickNextSubtask(): {
    goal: Goal;
    subtask: GoalSubtask;
  } | null;
  /**
   * 标记子任务已派发（绑定执行信号）
   */
  markDispatched(goalId: string, subtaskId: string, signalId: string): void;
  /**
   * 回写子任务执行结果（由编排层在信号执行完成后调用）
   * @returns 目标状态变化（completed / abandoned / null）
   */
  recordSubtaskOutcome(goalId: string, subtaskId: string, success: boolean, result?: string): GoalStatus | null;
  /** 通过信号 id 查找绑定的目标与子任务（执行完成回写用） */
  findBySignal(signalId: string): {
    goal: Goal;
    subtask: GoalSubtask;
  } | null;
  /** 活跃目标数（proposed / active / in-progress） */
  activeGoalCount(): number;
  /** 获取目标 */
  getGoal(goalId: string): Goal | undefined;
  /** 全部目标（按价值降序） */
  getAllGoals(): Goal[];
  /** 目标进度摘要 */
  getSummary(): any;
  /** 序列化（随长期记忆持久化） */
  serialize(): Goal[];
  /** 反序列化（恢复跨会话目标追求） */
  deserialize(goals: Goal[]): void;
  /** 价值评估：impact × confidence / cost（成本至少为 1） */
  private computeValue;
  /** 从洞察提炼目标标题 */
  private titleFromInsight;
  /** 目标去重：归一化标题的包含关系判定 */
  private isDuplicate;
  /** 目标进度 0~1 */
  private progressOf;
  /** 查找子任务 */
  private findSubtask;
}
/** 从反思教训构建洞察（目标引擎与反思引擎的桥接） */
declare function lessonsToInsights(lessons: Lesson[]): Insight[];
//#endregion
//#region src/core/free-energy.d.ts
/**
 * free-energy.ts — 主动推断内核（项目 6.0「自由能最小化心智」质变基座）
 *
 * 升级前的根本分裂（全模块通病）：
 * 系统有四套独立的「好坏」判据——调度器用策略评分（利用端），
 * 探索用 UCB 加成（手设预算），好奇心用盲区扫描（接触频率），
 * 元认知用 KPI 逐项阈值（规则命中）。四套判据彼此不通约：
 * 什么时候该探索、探索多少、知识与收益如何换算——全是拍脑袋常数。
 *
 * 本内核引入 Karl Friston 自由能原理（Active Inference）：
 * 智能体唯一目标是 minimize expected free energy——
 *
 *   G(a) = E_q[−ln P(goal | do(a))]  （务实价值：期望惊奇，越低越好）
 *        − E[info gain(a)]           （认知价值：期望信息增益，越高越好）
 *
 * 一个公式同时统一了四大启发式：
 * 1. 利用（务实价值）：预测成功率越接近偏好，惊奇越低 → 替代策略评分
 * 2. 探索（认知价值）：不确定性高的动作信息增益大 → 替代 UCB 加成，
 *    且探索预算不再是常数——不确定性耗尽，认知价值自动归零
 * 3. 好奇心（认知价值）：实验设计 = argmax info gain → 与探索同源，
 *    「想知道」与「想得分」在同一量纲（nat）下权衡
 * 4. 精度控制：温度 γ = f(系统平均不确定性)——世界模型越不可信，
 *    策略越随机（多探索）；越可信越贪婪（多利用）——自适应探索温度
 *
 * 变分自由能（感知侧）：F = KL(q‖p)（信念分布 ‖ 生成模型预测）——
 * 信念市场价与因果后验的背离第一次有了信息论度量（nat），
 * 模型漂移 = 自由能上升 = 系统对世界的「预测握力」松动。
 *
 * 与因果内核的关系：causal-kernel 提供生成模型 P(Y|do(X))，
 * 本内核提供基于该模型的行动选择定理。因果阶梯（第二层）回答
 * 「干预会怎样」，主动推断回答「因此该干预什么」——两者合成
 * 完整的感知-决策-学习闭环。
 *
 * 审计性：EFE 分解（务实/认知）逐动作输出，每个选择都能回答
 * 「为什么选它」——多少因为有用，多少因为想弄清。可解释、可追溯。
 */
/** ln Γ(x)（Lanczos 逼近；x>0） */
declare function lnGamma(x: number): number;
/** ψ(x) = d/dx ln Γ(x)（递推 + 渐近级数；x>0） */
declare function digamma(x: number): number;
/** Beta 分布微分熵（nat）：H = ln B(α,β) − (α−1)ψ(α) − (β−1)ψ(β) + (α+β−2)ψ(α+β) */
declare function betaEntropy(alpha: number, beta: number): number;
/** KL(q‖p)（伯努利分布，nat）；概率裁剪防 log(0) */
declare function bernoulliKL(q: number, p: number): number;
/** 行动候选（生成模型视角下的一个可干预动作） */
interface EFEAction {
  /** 动作标识（modelId / knob:x / 实验边 from） */
  id: string;
  /** P(Y=1|do(a))——因果内核处理臂后验（无证据回退 0.5） */
  pSuccess: number;
  /** 效应区间（不确定性来源） */
  lower: number;
  upper: number;
  /** 干预证据量（黄金证据，信息增益的主依据） */
  interventionalSamples: number;
  /** 观测证据量（银级证据，半价计入） */
  observationalSamples: number;
}
/** EFE 评估结论（逐动作可解释分解） */
interface EFEEvaluation {
  actionId: string;
  /** 务实价值：E[−ln P(goal|do(a))]（nat，越低越好） */
  pragmatic: number;
  /** 认知价值：期望信息增益（nat，越高越好） */
  epistemic: number;
  /** G(a) = pragmatic − epistemicWeight×epistemic（越低越好） */
  efe: number;
  /** Beta 后验参数（信息增益计算依据，审计可查） */
  alpha: number;
  beta: number;
  /** Boltzmann 策略选择概率 */
  boltzmannProb: number;
  /** 该选择中「想知道」的占比（epistemic/(pragmatic+epistemic)） */
  curiosityShare: number;
  /** 若选它，预期把该边的不确定性收缩多少（nat→0 收敛度） */
  expectedUncertaintyReduction: number;
}
/** 变分自由能报告（感知侧漂移监测） */
interface VariationalReport {
  /** Σ KL(q‖p)（nat，信念 vs 生成模型的总背离） */
  totalFreeEnergy: number;
  /** 逐信念明细 */
  perBelief: Array<{
    id: string;
    beliefProb: number;
    modelProb: number;
    kl: number;
  }>;
  /** 漂移判定（总自由能超阈值） */
  driftDetected: boolean;
  /** 最大背离源（漂移归因） */
  worst?: {
    id: string;
    kl: number;
  };
}
interface FreeEnergyConfig {
  /** 认知价值权重（信息增益折算系数，缺省 1：1 nat 信息 = 1 nat 惊奇） */
  epistemicWeight: number;
  /** Boltzmann 温度下限（缺省 0.05：证据充分时接近贪婪） */
  minTemperature: number;
  /** 温度对不确定性的敏感度（缺省 0.3） */
  temperatureSensitivity: number;
  /** 漂移判定的总自由能阈值（nat，缺省 0.25） */
  driftThreshold: number;
  /** 概率裁剪 ε（防 log(0)） */
  probEpsilon: number;
}
declare const DEFAULT_FREE_ENERGY_CONFIG: FreeEnergyConfig;
/**
 * 主动推断内核：期望自由能决策 + 变分漂移监测 + 精度控制。
 *
 * 消费方：
 * - model-scheduler：EFE 模式下行动选择 = argmin G(a)（探索/利用统一）
 * - symbiosis/runtime：行动提案按 EFE 排序（认知经济的注意力分配）
 * - meta-cognition：总自由能作为统一健康度（预测握力）
 * - curiosity-engine：实验目标 = argmax epistemic（与探索同源的定理化好奇心）
 * - world-model / 信念对账：KL 漂移监测（变分自由能）
 */
declare class FreeEnergyEngine {
  private config;
  /** 感知侧：最近观测惊奇（EMA，自由能代理） */
  private surprisalEma;
  private surprisalCount;
  constructor(config?: Partial<FreeEnergyConfig>);
  /**
   * 单动作期望自由能分解。
   *
   * 务实价值（期望惊奇）：
   *   G_prag = −[ω·ln p̂ + (1−ω)·ln(1−p̂)]
   *   ω = 对成功的偏好强度（goal weight）；p̂ = P(Y=1|do(a))。
   *   p̂ 越贴近 ω 惊奇越低；p̂ 与 ω 同侧时交叉熵单调。
   *
   * 认知价值（期望信息增益，一步前瞻）：
   *   IG = H(Beta(α,β)) − [p̂·H(α+1,β) + (1−p̂)·H(α,β+1)]
   *   做这个动作（无论成败）后该边后验熵的期望收缩量。
   *   样本充足 → 微分熵收缩趋零 → 认知价值自动归零（探索自我终结）。
   */
  evaluateAction(action: EFEAction, preference: number, temperature?: number): EFEEvaluation;
  /**
   * 全候选 EFE 评估 + Boltzmann 策略。
   *
   * P(a) ∝ exp(−G(a)/T)：温度由系统不确定性控制（precisionControl）。
   * 高不确定性 → 高温度 → 均匀探索；低不确定性 → 低温 → 贪婪利用。
   * 这是主动推断的规范策略形式：策略 = 对自由能的 softmax。
   */
  evaluateActions(actions: EFEAction[], preference: number, temperature?: number): EFEEvaluation[];
  /**
   * Thompson 采样：θ_a ~ Beta(α_a, β_a)，选 argmax θ。
   *
   * EFE 最优的随机化实现（Bernoulli bandit 的规范探索策略）：
   * 后验越宽采样越散 → 自动探索；后验越尖采样越稳 → 自动利用。
   * 与 Boltzmann 的区别：不依赖温度标定，探索幅度由证据量内生决定。
   */
  thompsonSelect(actions: EFEAction[]): {
    winner: string;
    samples: Record<string, number>;
  };
  /**
   * 精度控制：候选集平均不确定性 → 探索温度。
   *
   * T = minTemperature + sensitivity × avgWidth。
   * 世界的未知程度直接决定策略的随机程度——不确定时多试，
   * 胸有成竹时果断。探索率第一次由认识论内生推导，而非超参数。
   */
  minTemperatureFromActions(actions: EFEAction[]): number;
  /**
   * 感知：登记一次「预测-结果」惊奇（自由能的在线代理）。
   *
   * surprisal = −ln P(实际结果 | 预测概率)。EMA 平滑为系统级
   * 「预测握力」——元认知的总自由能 KPI 数据来源：
   * 预测越准惊奇越低；世界突变（漂移）时惊奇陡升。
   * @returns 本次的惊奇值（nat）
   */
  observeSurprisal(predictedProb: number, actualSuccess: boolean): number;
  /** 感知侧自由能（EMA 惊奇；无观测时 0） */
  currentSurprisal(): number;
  /**
   * 变分自由能：信念分布 vs 生成模型的 KL 总和（感知漂移监测）。
   *
   * 典型用法：信念市场隐含概率（q）vs 因果内核后验（p）。
   * F 上升 = 「市场以为的」与「模型知道的」裂开 = 模型漂移指纹——
   * 为既有 gap 判断提供信息论度量（nat）与归因（worst）。
   */
  variationalFreeEnergy(beliefs: Array<{
    id: string;
    beliefProb: number;
  }>, modelProbs: Record<string, number>): VariationalReport;
}
/** Beta(α,β) 精确采样：Gamma 采样比（Marsaglia-Tsang） */
declare function sampleBeta(alpha: number, beta: number): number;
//#endregion
//#region src/core/abstraction.d.ts
/**
 * abstraction.ts — 抽象内核（项目 9.0「抽象心智」质变基座：类比结构映射）
 *
 * 升级前的根本局限（8.0 元认知心智的天花板）：
 * 转移模型把每个状态键当**孤立符号**——`trapB#s0` 与 `trapA#s0`
 * 哪怕结构完全相同也互不相干；新任务域永远从 Beta(1,1) 完全无知
 * 开始，深思搜索在陌生域只能凭认知价值乱试探。系统**学不会
 * 举一反三**：经验被锁死在它被采集的具体状态键里。
 *
 * 本内核引入结构映射类比（Structure Mapping, Gentner 1983）+
 * 分层贝叶斯收缩（hierarchical partial pooling）：
 *
 * 1. **状态骨架分解**：state = `${domain}#${skeleton}`——域是
 *    「对象标签」（code-gen / translation / trapA / trapB），
 *    骨架是「关系角色」（#s0 起步 / #dead 死路 / #rich 富态）。
 *    抽象 = 保关系、换对象。
 *
 * 2. **域结构相似度**：域画像 = 观测过的 (骨架, 行动) 集合；
 *    sim(d1,d2) = Jaccard(画像)。两个结构相同的陷阱域相似度 1，
 *    无关域相似度 0——**结构同构可度量，类比有了闸门**。
 *
 * 3. **分层先验链**（全部排除自身叶子证据，防双计）：
 *    L1 类比层：结构相似的别域在同骨架同行动上的后验（sim 加权）
 *    L2 域边际层：本域其他骨架对同一行动的经验（域难度）
 *    L3 全局骨架层：所有域在该骨架行动上的无权池化
 *    L4 均匀层：Beta(1,1)（strength=2，与未挂载时严格等价）
 *
 * 4. **后继继承**（结构映射的核心）：冷叶子不仅继承边缘概率，
 *    还继承**转移结构**——别域 (骨架, 行动) 的 MAP 后继骨架映射
 *    回本域（trapA 的 bait→#dead 迁移成 trapB 的 bait→#dead）。
 *    陷阱的本质在后继结构里，不在边缘概率里——不继承结构
 *    就谈不上类比规划。
 *
 * 5. **抽象技能**：同一骨架同一行动序列在 ≥2 个域整体成功 →
 *    晋升为跨域宏技能（`*#${skeleton}` 触发），第三个同构域
 *    冷启动即可复用——「怎么做」的知识第一次跨域通用。
 *
 * 与 6/7/8.0 的关系：6.0 定价行动、7.0 定价计划、8.0 定价思考，
 * 本内核让三者**跨域泛化**——经验不再是一次性的。
 * 抽象心智 = 元认知心智 × 举一反三。
 */
/** 分层先验（叶子证据之外的一切知识来源） */
interface HierarchicalPrior {
  /** 先验均值（域间迁移来的成功率估计） */
  mean: number;
  /** 先验强度（伪计数；均匀层 = 2 与 Beta(1,1) 严格等价） */
  strength: number;
  /** 来源层标注（audit：analogy(domain) / domain-marginal / global-skeleton / uniform） */
  source: string;
  /** L1 层实际参与融合的域（结构映射的证人） */
  witnessDomains?: string[];
}
/** 抽象技能（跨域宏动作；在 deliberation 中包装为 Skill 参与 beam 种子） */
interface AbstractSkillEntry {
  id: string;
  /** 触发骨架（任意域匹配） */
  skeleton: string;
  actions: string[];
  /** 成功域数（晋升证据） */
  domains: number;
  /** 总成功次数 */
  successes: number;
  value: number;
}
/** 抽象统计（meta-cognition KPI 用） */
interface AbstractionStats {
  /** 已观测域数 */
  domains: number;
  /** 骨架级结构边数 */
  structuralEdges: number;
  /** 零样本应答：冷叶子拿到非均匀先验的次数（真正发生的举一反三） */
  zeroShotAnswers: number;
  /** 类比迁移启用次数（L1 命中） */
  analogyTransfers: number;
  /** 后继结构继承次数 */
  successorInheritances: number;
  /** 抽象技能数 */
  abstractSkills: number;
  interpretation: string;
}
interface AbstractionConfig {
  /** L1 类比层先验强度（伪计数，缺省 6） */
  analogyStrength: number;
  /** L2 域边际层先验强度（缺省 4） */
  domainStrength: number;
  /** L3 全局骨架层先验强度（缺省 3） */
  globalStrength: number;
  /** 结构相似度门槛（Jaccard，缺省 0.3——低于此不迁移） */
  minSimilarity: number;
  /** 抽象技能晋升所需跨域成功数（缺省 2） */
  abstractSkillDomains: number;
  /** 域画像最大容量（防爆内存；缺省 4096） */
  maxProfileSize: number;
}
declare const DEFAULT_ABSTRACTION_CONFIG: AbstractionConfig;
/**
 * 抽象内核：状态骨架分解 + 域结构相似度 + 分层先验链 + 后继继承
 * + 抽象技能晋升。
 *
 * 挂载于 DeliberationEngine（attachAbstraction）：observe 喂入证据、
 * posterior 经分层先验收缩、冷叶子继承别域后继结构、搜索种子合并
 * 抽象技能。未挂载时对既有行为零影响（先验链不参与）。
 */
declare class AbstractionEngine {
  private config;
  /** 骨架级证据（域, 骨架, 行动）——L1 目标 + 画像 + 自身排除基数 */
  private skeletonEdges;
  /** 域×行动边际（L2） */
  private domainAction;
  /** 全局骨架×行动（L3） */
  private globalSkeleton;
  /** 域画像（域 → 观测过的 skeleton|action 集合）——相似度原料 */
  private profiles;
  /** 抽象技能晋升追踪（骨架||签名 → 跨域成功） */
  private skillLadder;
  private abstractSkills;
  private skillCounter;
  private zeroShotAnswers;
  private analogyTransfers;
  private successorInheritances;
  constructor(config?: Partial<AbstractionConfig>);
  /**
   * 登记一次观测（与 DeliberationEngine.observe 同步调用）。
   * @param nextState 成功时的后继状态（后继继承的原料）
   */
  observe(state: string, action: string, success: boolean, nextState?: string): void;
  /**
   * 查询 (state, action) 的分层先验（叶子证据之外的一切）。
   *
   * 优先级：L1 类比（结构相似域同骨架）→ L2 域边际（本域其他骨架）
   * → L3 全局骨架（无权跨域）→ L4 均匀。各层均排除查询叶子自身
   * 的证据（防双计——deliberation 会把叶子证据加回后验）。
   */
  hierarchicalPrior(state: string, action: string): HierarchicalPrior;
  /**
   * 冷叶子的后继结构继承：类比域 (骨架, 行动) 的 MAP 后继骨架
   * 映射回本域（trapA#s0 --bait--> trapA#dead ⟹ trapB#s0 --bait--> trapB#dead）。
   * 陷阱的本质在后继结构里——不继承结构就谈不上类比规划。
   * @returns 继承的后继状态；无可继承时 undefined
   */
  inheritedSuccessor(state: string, action: string): string | undefined;
  /** 域画像 Jaccard：观测过的 (骨架, 行动) 集合重合度——结构同构可度量 */
  domainSimilarity(d1: string, d2: string): number;
  /**
   * 查询口径的结构相似度（含冷域首触规则）：
   * - 查询域已有画像：严格 Jaccard（闸门防误迁移；一旦发现域并非
   *   同构，相似度跌破门槛，类比自动停止——错误类比自纠）
   * - 查询域全冷（无任何观测）：对方在**恰好这个结构位置**
   *   (骨架, 行动) 上有经验即为证人（sim=1）——处女域相信任何
   *   走过同一条结构路的前辈；先验强度（6 伪计数）约束借用幅度，
   *   自身证据积累后严格闸门接管
   */
  private structuralSimilarity;
  /** 已观测域列表（audit） */
  domains(): string[];
  /**
   * 计划结局入账（与 DeliberationEngine.settle 同步）：
   * 同一骨架同一行动序列在多个域整体成功 → 跨域宏技能晋升。
   */
  notePlanOutcome(firstState: string, actions: string[], success: boolean): void;
  /** 检索：匹配状态骨架的抽象技能（跨域宏动作） */
  abstractSkillsFor(state: string): AbstractSkillEntry[];
  /** 全部抽象技能（audit） */
  allAbstractSkills(): AbstractSkillEntry[];
  stats(): AbstractionStats;
  serialize(): {
    skeletonEdges: Array<{
      domain: string;
      skeleton: string;
      action: string;
      successes: number;
      failures: number;
      successors: Array<[string, number]>;
    }>;
    domainAction: Array<{
      domain: string;
      action: string;
      successes: number;
      failures: number;
    }>;
    globalSkeleton: Array<{
      skeleton: string;
      action: string;
      successes: number;
      failures: number;
    }>;
    abstractSkills: AbstractSkillEntry[];
    counters: {
      zeroShotAnswers: number;
      analogyTransfers: number;
      successorInheritances: number;
    };
  };
  deserialize(data: ReturnType<AbstractionEngine['serialize']>): void;
}
/**
 * 状态分解：`${domain}#${skeleton...}`（'#' 后全部视为骨架，支持多段）。
 * 无 '#' 时骨架为空串（单段状态——相似度闸门防误迁移）。
 */
declare function decompose(state: string): {
  domain: string;
  skeleton: string;
  hasSkeleton: boolean;
};
//#endregion
//#region src/core/mcts.d.ts
/**
 * 29.0 蒙特卡洛树搜索内核 —— UCT + 折扣回报 + 任意时刻可读
 *
 * 动机: 7.0 beam search 在轨迹空间按「模型评分」剪枝——宽度是资源，深度
 * 受 beam 限制；评估函数（累计 G）是确定性的近视打分。MCTS 把搜索本身
 * 变成**序贯决策问题**：
 *
 *   选择:  UCB1 = Q(s,a)/N(s,a) + c·√(ln N(s) / N(s,a))
 *     ——利用项（均值）与探索项（访问稀缺度）的置信上界平衡，
 *     Hoeffding 界保证收敛到最优动作（Kocsis & Szepesvári 2006）。
 *   扩展: 每次迭代只展开一个未试动作（惰性扩展，树按需生长）；
 *     渐进加宽（可选）⌈k·(N+1)^κ⌉ 限制大动作集的子节点数。
 *   模拟: 随机 rollout 到深度上限，收集折扣回报 Σ γ^t·r_t。
 *   回传: **节点本地回报**——每条边记录进入奖励，回传时按
 *     (R − 前缀折扣奖励)/γ^depth 折算，每个节点的 Q 都是
 *     「从本节点出发的折扣回报」，无深度偏置。
 *
 *   任意时刻性（与 8.0 元推理同族）: 迭代预算 / 时间预算任一耗尽即读出，
 *     访问分布即时可审计（visits 越多 = 证据越多，与 21.0 学习溢价同构）。
 *
 * 确定性: 种子化 mulberry32——同一 (seed, domain) 组合逐位复现；
 *   域内随机必须只消费传入的 rng。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致。
 */
/**
 * 搜索域：动作清单 + 随机步进。
 * 契约：终局状态的 actions() 必须返回空数组（rollout 依赖此停止）。
 */
interface MctsDomain {
  actions(state: string): string[];
  /**
   * 一步转移（域内随机只消费传入 rng，保证种子可复现）。
   * @returns 后继状态、即时奖励 r（建议 [0,1] 口径）、是否终局
   */
  step(state: string, action: string, rng: () => number): {
    state: string;
    reward: number;
    terminal: boolean;
  };
}
interface UctConfig {
  /** UCB1 探索常数 c（缺省 √2） */
  explorationC: number;
  /** 每步折扣 γ（缺省 0.95） */
  discount: number;
  /** rollout 深度上限（缺省 12） */
  rolloutDepth: number;
  /** PRNG 种子（缺省 20260920） */
  seed: number;
  /** 渐进加宽系数 k（子节点上限 ⌈k·(N+1)^κ⌉；0 = 关闭；缺省 0） */
  progressiveWidenK: number;
  /** 渐进加宽指数 κ ∈ (0,1]（缺省 0.5） */
  progressiveWidenKappa: number;
}
declare const DEFAULT_UCT_CONFIG: UctConfig;
interface MctsChildStat {
  action: string;
  visits: number;
  meanValue: number;
}
interface MctsResult {
  /** 访问次数最多的根动作（收敛意义下的最优动作） */
  bestAction: string | undefined;
  /** 根价值（根的本地回报均值） */
  rootValue: number;
  /** 完成迭代数 */
  iterations: number;
  /** 树节点总数 */
  treeNodes: number;
  /** 根子节点统计（visits 降序） */
  children: MctsChildStat[];
  /** 主变化线（最访问链的动作序列） */
  principalVariation: string[];
}
/**
 * UCT 搜索器。bind(domain) 后可反复 search()（每次为独立完整运行，
 * 种子重置——同一预算逐位可复现）。
 */
declare class UctSearch {
  private config;
  private domain;
  private rng;
  private nodeCount;
  constructor(config?: Partial<UctConfig>, domain?: MctsDomain);
  /** 绑定/替换搜索域 */
  bind(domain: MctsDomain): this;
  search(root: string, budget?: {
    iterations?: number;
    timeMs?: number;
  }): MctsResult;
  private runEpisode;
  /** UCB1 选择（访问数 0 的子节点视为 +∞——必先展开） */
  private selectUcb;
  /** 随机 rollout：深度上限内均匀选动作，收集折扣回报（从该节点视角） */
  private rollout;
  /** 渐进加宽：子节点数上限 ⌈k·(N+1)^κ⌉（k=0 恒真 = 关闭） */
  private canWiden;
  /** 主变化线：自根沿最高访问数下降 */
  private extractPv;
}
//#endregion
//#region src/core/deliberation.d.ts
/** 转移边后验（state × action → outcome，学习与想象的生成模型） */
interface TransitionPosterior {
  state: string;
  action: string;
  /** Beta(α,β) 后验均值 = P(成功 | state, action) */
  pSuccess: number;
  alpha: number;
  beta: number;
  /** 真实证据量（成功 + 失败计数） */
  evidence: number;
  /** 90% 区间近似（后验 σ ± 1.645σ） */
  lower: number;
  upper: number;
  /** MAP 后继状态（无证据时停留原态；冷边可经类比继承别域结构） */
  successor: string;
  /**
   * 9.0：分层先验来源（挂载抽象内核时）——这条边的知识有多少是
   * 自己挣的、多少是类比/域边际/全局借来的。audit 用。
   */
  abstract?: {
    source: string;
    strength: number;
    mean: number;
  };
}
/** 轨迹中一步的完整分解（审计单元） */
interface StepEvaluation {
  /** 步序（0 起） */
  step: number;
  state: string;
  action: string;
  nextState: string;
  /** 该步成功概率（后验均值） */
  pStep: number;
  /** 该步开始时的有效证据（真实 + 轨迹内想象折算） */
  evidence: number;
  /** 务实价值：E[−ln P(goal|do(a))]（nat） */
  pragmatic: number;
  /** 认知价值：该步期望信息增益（nat；重访同一边时单调下降） */
  epistemic: number;
  /** 该步 G = pragmatic − epistemicWeight × epistemic */
  efe: number;
  /** 折扣后计入轨迹总 G 的份额（γ^step × efe） */
  discounted: number;
}
/** 想象报告（一条计划的梦境推演） */
interface ImaginationReport {
  /** 起始状态 */
  startState: string;
  /** 行动序列 */
  actions: string[];
  /** 状态轨迹（states[i] = 第 i 步之前所处状态） */
  states: string[];
  /** 折扣累计 G = Σ γ^t · G_t（越低越好；与单步 EFE 同量纲） */
  totalEfe: number;
  /** 未折扣累计（长计划审计用） */
  undiscountedEfe: number;
  /** 全程成功概率 = Π p_t */
  pAllSuccess: number;
  steps: StepEvaluation[];
  /** 首败风险分布：恰好在第 step 步首次失败的概率 */
  riskProfile: Array<{
    step: number;
    pFailAt: number;
  }>;
  /** 同一条边在轨迹内被重访时认知价值是否单调不增（想象证据坍缩） */
  epistemicMonotone: boolean;
}
/** 技能（时间抽象的宏动作：验证过的行动序列） */
interface Skill {
  id: string;
  /** 触发态（起始状态键；检索时精确匹配） */
  initiation: string;
  /** 行动序列（宏展开即按序执行） */
  actions: string[];
  /** 价值估计 = 宏动作全程成功概率口径（0~1，越高越好；随复用/失手 EMA 更新） */
  value: number;
  /** 全程成功概率估计（与价值同源，独立保留供审计） */
  reliability: number;
  /** 价值的不确定度（随结算次数收缩；检索排序折扣用） */
  confidence: number;
  usages: number;
  successes: number;
  createdAt: number;
  lastUsedAt: number;
}
/** 梦实现对账报告（想象的可问责性） */
interface SettlementReport$1 {
  steps: Array<{
    step: number;
    state: string;
    action: string;
    /** 梦里的预测（执行前口径，防止用结果修预测） */
    predicted: number;
    actual: boolean;
    /** −ln P(实际)（nat） */
    surprisal: number;
    /** |predicted − outcome| */
    error: number;
  }>;
  overallSuccess: boolean;
  meanSurprisal: number;
  /** 梦校准误差 EMA（0 = 完美预知；越高想象越不可信） */
  calibrationEma: number;
  /** 本轮技能库动作 */
  skillAction: 'acquired' | 'reinforced' | 'decayed' | 'none';
  skillId?: string;
}
/** 前瞻搜索结果 */
interface DeliberationResult {
  /** 按轨迹 G 升序的完整推演报告 */
  ranked: ImaginationReport[];
  best: ImaginationReport | undefined;
  /** 搜索展开的边数（含技能宏展开） */
  expandedNodes: number;
  /** 技能种子是否参与（时间抽象生效） */
  skillSeeded: boolean;
  /** 29.0：UCT 搜索元数据（searchMcts 专属；beam search 不出现） */
  mcts?: MctsResult;
}
interface DeliberationConfig {
  /** 时间折扣 γ（缺省 0.95：远期收益按 5%/步衰减） */
  gamma: number;
  /** beam 宽度（缺省 6：每层保留的轨迹前缀数） */
  beamBreadth: number;
  /** 搜索深度上限（缺省 4 步） */
  maxDepth: number;
  /** 想象证据折算率（缺省 0.5：轨迹内重访同一边，每次折算 0.5 个伪证据） */
  imaginaryEvidenceRate: number;
  /** 认知价值权重（与 FreeEnergyConfig 同义，缺省 1） */
  epistemicWeight: number;
  /** 概率裁剪 ε */
  probEpsilon: number;
  /** 技能入库价值门槛（全程成功概率 ≥ 该值才可成技能，缺省 0.5） */
  skillValueThreshold: number;
  /** 技能库容量上限（超额按价值×置信度淘汰，缺省 64） */
  skillMaxCount: number;
  /** 梦校准 EMA 平滑系数（缺省 0.3，比感知惊奇更敏） */
  calibrationAlpha: number;
}
declare const DEFAULT_DELIBERATION_CONFIG: DeliberationConfig;
/**
 * 深思内核：转移模型 + 想象推演 + 前瞻搜索 + 技能库 + 梦实现对账。
 *
 * 消费方：
 * - optimizer：冷启动序列推荐（零情景记忆也能按想象给出计划级建议）
 * - meta-cognition：梦校准 KPI（想象可靠性的诚实度量）
 * - symbiosis/runtime：多步行动提案按轨迹 G 排序
 * - 宿主/执行器：计划执行后 settle 对账（学习 + 惊奇回流 + 技能蒸馏）
 */
declare class DeliberationEngine {
  private config;
  private edges;
  private skills;
  private skillCounter;
  private calibrationEma;
  private plansSettled;
  private freeEnergy?;
  /** 9.0：抽象内核（可选挂载；分层先验 + 后继继承 + 抽象技能） */
  private abstraction?;
  constructor(config?: Partial<DeliberationConfig>, freeEnergy?: FreeEnergyEngine);
  /** 挂载自由能引擎（梦对账的惊奇回流目标；幂等） */
  attachFreeEnergyEngine(engine: FreeEnergyEngine): void;
  /**
   * 9.0：挂载抽象内核（幂等）。挂载后：
   * - posterior 经分层先验收缩（L4 均匀层与 Beta(1,1) 严格等价，
   *   零数据时对既有行为零漂移）
   * - 冷叶子继承结构相似域的后继结构（类比规划）
   * - 搜索种子合并跨域抽象技能
   */
  attachAbstraction(engine: AbstractionEngine): void;
  /**
   * 登记一次真实执行证据（执行器/宿主在计划步落定后调用）。
   * @param state 该步所处状态键（如 `${taskType}#s${i}`）
   * @param action 行动（如 modelId）
   * @param success 该步成败
   * @param nextState 成功后的后继状态（缺省停留原态）
   */
  observe(state: string, action: string, success: boolean, nextState?: string): void;
  /**
   * 转移边后验查询。
   *
   * 未挂载抽象内核：Beta(1,1) 均匀先验（无证据 = 诚实的完全无知）。
   * 挂载后：分层先验收缩——先验 = 类比/域边际/全局借来的知识
   * （strength 伪计数），叶子证据逐条覆盖（经验渐近压倒类比）。
   * 均匀层 strength=2 与 Beta(1,1) 严格等价：零数据时零漂移。
   */
  posterior(state: string, action: string): TransitionPosterior;
  /**
   * 想象推演：在转移模型里 rollout 一条完整计划。
   *
   * 逐步计算（与单步 EFE 同一公式，证据沿轨迹累积）：
   *   α' = 1 + 真实成功 + λk·p̂   （λ = 想象证据折算率，k = 轨迹内已想象次数）
   *   β' = 1 + 真实失败 + λk·(1−p̂)
   *   务实 = −[ω ln p̂ + (1−ω) ln(1−p̂)]
   *   认知 = H(α',β') − [p̂·H(α'+1,β') + (1−p̂)·H(α',β'+1)]
   *   G_t = 务实 − w·认知；总 G = Σ γ^t G_t
   *
   * 关键性质：同一条边被重访时 λk 增大 → 后验熵收缩 → 认知价值单调不增
   * （想象证据坍缩：重复梦见同一件事不再带来新知识）。
   */
  imagine(startState: string, actions: string[], preference?: number): ImaginationReport;
  /**
   * 深思搜索：beam search 在轨迹空间按累计 G 剪枝。
   *
   * 与一步贪心（6.0 argmin G(a)）的本质区别：展开的是**轨迹前缀**——
   * 第 1 步的高 G 可以被第 2 步的低 G 补偿（γ 折扣），因此能看见
   * 「先苦后甜」的路，也能避开「第一步诱人、第二步是死路」的陷阱。
   *
   * 技能时间抽象：触发态匹配的技能作为宏动作直接展开整条序列
   * （一个 beam 槽位 = 多个原语步），深思从经验肩膀上起跳。
   *
   * @param startState 起始状态键
   * @param candidates 候选行动（静态清单或按状态动态给出）
   * @param opts 深度/宽度/偏好覆盖
   */
  search(startState: string, candidates: string[] | ((state: string) => string[]), opts?: {
    depth?: number;
    breadth?: number;
    preference?: number;
    useSkills?: boolean;
    /** 状态推进覆盖（确定性别状态机：忽略学习后继，按步推进） */
    advance?: (ctx: {
      state: string;
      action: string;
      step: number;
      successor: string;
    }) => string;
  }): DeliberationResult;
  /**
   * 29.0：UCT 前瞻搜索（beam search 的序贯决策升级口径）。
   *
   * beam search 按轨迹 G 剪枝（宽度即资源上限）；本方法把「搜索预算的
   * 分配」本身交给 UCT——每条转移边按 Beta 后验采样伯努利成败（失败即
   * 终局零回报），回报 = 逐步折扣的成功指示（与 pAllSuccess 同族），
   * UCB1 在「利用证据多的边」与「探索证据少的边」之间自动平衡。
   * 迭代/时间预算耗尽即读出（任意时刻性），根动作按访问证据排序；
   * 每条报告沿 MCTS 主变化线展开完整 ImaginationReport（口径与
   * search() 一致，可互查对账）。未挂载消费方不调用即零漂移。
   */
  searchMcts(startState: string, candidates: string[] | ((state: string) => string[]), opts?: {
    /** UCT 迭代预算（缺省 600） */
    iterations?: number;
    /** UCB1 探索常数（缺省 √2） */
    explorationC?: number;
    /** 折扣 γ（缺省 0.95） */
    discount?: number;
    /** 输出报告条数（缺省 beamBreadth） */
    topK?: number;
    preference?: number;
    /** 状态推进覆盖（与 search 同义） */
    advance?: (ctx: {
      state: string;
      action: string;
      step: number;
      successor: string;
    }) => string;
  }): DeliberationResult & {
    mcts: MctsResult;
  };
  /**
   * 技能入库/强化：整体成功的计划蒸馏为可复用宏动作。
   * 同一 (触发态, 行动序列) 已存在时按 EMA 强化价值。
   */
  acquireSkill(initiation: string, actions: string[], value: number, reliability: number): Skill | undefined;
  /** 技能衰减：匹配的技能失手（价值 EMA 下调，可靠性下滑） */
  decaySkill(initiation: string, actions: string[], penalty?: number): void;
  /**
   * 检索：触发态匹配的技能（按价值 × 置信度降序）。
   * 9.0：挂载抽象内核时合并跨域抽象技能（同骨架任意域可复用）。
   */
  skillsFor(state: string): Skill[];
  /** 全部技能（可观测/审计） */
  allSkills(): Skill[];
  /**
   * 计划落定对账：梦里预测 vs 现实结果。
   *
   * 三重回流：
   * 1. 转移模型学习（真实证据入库）
   * 2. 自由能感知惊奇（−ln P(实际)，挂载引擎时）
   * 3. 梦校准 EMA（|预测 − 结果|：想象可靠性的统一度量）
   *
   * 整体成功 → 计划蒸馏为技能（时间抽象资产）；
   * 整体失败 → 若匹配技能则衰减（梦境失灵的问责）。
   *
   * @param plan 逐步计划（state + action）
   * @param outcomes 逐步真实结果
   */
  settle(plan: Array<{
    state: string;
    action: string;
  }>, outcomes: boolean[], preference?: number): SettlementReport$1;
  /** 梦校准误差（EMA；未对账过时 undefined） */
  currentCalibration(): number | undefined;
  /** 已对账计划数（可观测） */
  settledCount(): number;
  /** 序列化（持久化用；含抽象内核状态） */
  serialize(): {
    edges: Array<{
      state: string;
      action: string;
      successes: number;
      failures: number;
      successors: Array<[string, number]>;
    }>;
    skills: Skill[];
    calibrationEma: number | undefined;
    plansSettled: number;
    /** 9.0：抽象内核状态（挂载时） */
    abstraction?: ReturnType<AbstractionEngine['serialize']>;
  };
  /** 反序列化 */
  deserialize(data: ReturnType<DeliberationEngine['serialize']>): void;
  /** 单步扩展一个 beam 前缀（含想象证据累积；advance 覆盖学习后继） */
  private extendNode;
  /** 整段序列展开（技能宏：从起始态一次推演完整技能） */
  private expandPrefix;
  /** beam 前缀 → 完整想象报告（复用已算好的步分解，不重算） */
  private nodeToReport;
}
//#endregion
//#region src/core/metareasoning.d.ts
/** 决策模式（双过程：1=习惯/反应，2=深思） */
type DecisionMode = 'habit' | 'reactive' | 'deliberative';
/** 习惯（深思的摊销缓存：状态 → 直答计划） */
interface Habit {
  /** 触发状态键 */
  state: string;
  /** 摊销的计划（深思反复收敛出的行动序列） */
  actions: string[];
  /** 连续成功次数（晋升后持续累计） */
  consecutiveSuccesses: number;
  /** 形成后总使用次数 */
  usages: number;
  /** 全程成功概率（形成时口径，审计用） */
  reliability: number;
  createdAt: number;
  lastUsedAt: number;
}
/** 元决策记录（pending → 结算回流） */
interface MetaDecision {
  id: number;
  /** 仲裁时的时间戳 */
  ts: number;
  state: string;
  mode: DecisionMode;
  /** 习惯模式 = 习惯计划；反应 = [bestAction]；深思 = 最优轨迹 */
  actions: string[];
  /** 计算成本（nat；习惯 ≈ 0，反应 ≈ 0，深思 = nodes × natPerNode） */
  costNat: number;
  /** 深思展开的节点数（认知经济审计） */
  nodesExpanded: number;
  /** 深思停止时的搜索深度 */
  depthStopped: number;
  /** 首行动稳定性（深思连续不变的层数） */
  firstActionStable: boolean;
  /** 反应门槛判定：best 与次优的单步 EFE 差（nat） */
  reactiveGap: number;
  /** 结算状态 */
  settled: boolean;
  /** 结算整体成败 */
  outcome?: boolean;
}
/** 仲裁结果 */
interface ArbitrationResult {
  mode: DecisionMode;
  actions: string[];
  /** 深思模式附带完整想象报告（审计/上游再利用） */
  report?: ImaginationReport;
  costNat: number;
  nodesExpanded: number;
  decisionId: number;
  /** 反应门槛判定：best 与次优的单步 EFE 差（nat；深思模式下 = 未达门槛的暧昧度） */
  reactiveGap: number;
  /** 深思停止时的搜索深度（反应 = 1，习惯 = 0） */
  depthStopped: number;
  /** 仲裁理由（人类可读，进决策审计） */
  rationale: string;
}
/** 认知经济 KPI（meta-cognition 统一报告用） */
interface CognitiveEconomy {
  /** 已仲裁决策总数 */
  decisions: number;
  /** 模式分布（份额和为 1） */
  modeShare: Record<DecisionMode, number>;
  /** 习惯命中节省的搜索成本（nat，认知经济的直接产出） */
  habitSavingsNat: number;
  /** 累计计算开销（nat） */
  totalSpendNat: number;
  /** 累计展开节点数 */
  totalNodes: number;
  /** 习惯库规模 */
  habits: number;
  /** 习惯命中率（习惯模式 / 决策总数） */
  habitHitRate: number;
  /** 元遗憾：习惯失灵（世界漂移下沿用了过期习惯）次数 */
  staleHabitRegrets: number;
  /** 反应失手次数（本该深思却反应了） */
  reactiveFailures: number;
  /** 各模式成功率（元学习实测：思考的价值） */
  modeSuccessRate: Partial<Record<DecisionMode, number>>;
  /** 平均深思深度（收敛性：越低=越早想清楚） */
  avgDeliberationDepth: number;
  interpretation: string;
}
interface MetareasoningConfig {
  /** 反应门槛：best 与次优单步 EFE 差 ≥ 该值 → 无需深思（nat，缺省 0.25） */
  decisivenessGap: number;
  /** 反应模式对 best 行动的最低证据量要求（缺省 8） */
  sufficientEvidence: number;
  /** 习惯晋升门槛：同状态同计划连续成功次数（缺省 2） */
  habitPromotionSuccesses: number;
  /** 深思最大深度（缺省 4；任意时停机通常更早） */
  maxDepth: number;
  /** beam 宽度（缺省 6） */
  beamBreadth: number;
  /** 每展开节点的计算价格（nat/节点，缺省 0.01） */
  natPerNode: number;
  /** 思考预算：单次深思最大开销（nat，缺省 2.0——约等于一次大惊小怪） */
  budgetNat: number;
  /** 反应失手后门槛收紧系数（缺省 0.8：gap *= 0.8，更难走反应路） */
  reactiveTightening: number;
  /** 反应门槛下限（收紧不至零：深思不能因一次失手变成常态，缺省 0.08） */
  minDecisivenessGap: number;
  /** 模式成功率 EMA 平滑（缺省 0.3） */
  metaAlpha: number;
}
declare const DEFAULT_METAREASONING_CONFIG: MetareasoningConfig;
/**
 * 元推理内核：双过程仲裁 + 任意时搜索 + 习惯摊销 + 元学习。
 *
 * 消费方：
 * - optimizer：metacognitiveRecommendation（冷启动推荐的元认知版）
 * - meta-cognition：认知经济 KPI（思考的价格与价值实测）
 * - 宿主：决策执行后 settleDecision 回流（元学习闭环）
 */
declare class RationalMetareasoner {
  private config;
  private deliberation;
  private habits;
  private pending;
  private decisionCounter;
  private modeCounts;
  private totalSpendNat;
  private totalNodes;
  private deliberationDepths;
  private habitSavingsNat;
  private staleHabitRegrets;
  private reactiveFailures;
  private modeOutcomes;
  private dynamicGap;
  constructor(deliberation: DeliberationEngine, config?: Partial<MetareasoningConfig>);
  /**
   * 双过程仲裁：习惯 → 反应 → 深思，逐级升级、逐级定价。
   *
   * 元 EFE 判据（越低越好）：
   *   habit:       直答（查表成本 ≈ 0）——信任摊销经验
   *   reactive:    一步 EFE 差悬殊且证据充分 → VOC ≈ 0，想也不会变
   *   deliberative: 任意时搜索直到首行动稳定或预算耗尽
   */
  decide(state: string, candidates: string[], opts?: {
    preference?: number;
    useSkills?: boolean;
    /** 状态推进覆盖（确定性别状态机；透传给深思搜索） */
    advance?: (ctx: {
      state: string;
      action: string;
      step: number;
      successor: string;
    }) => string;
  }): ArbitrationResult;
  /**
   * 任意时搜索：逐深度展开，首行动连续 stableRounds 层不变即停。
   *
   * 停机判据的数学含义：beam 在深度 d 与 d+1 给出的最优计划首行动
   * 相同 → 深层补偿已不影响当下选择 → 继续搜索的期望决策增益 < 成本。
   * 这是「思考收敛」的可观测证据，不是拍脑袋的深度上限。
   */
  private searchAnytime;
  /**
   * 决策结算：现实的后果校准元认知。
   *
   * - 习惯失手 → 习惯作废（世界漂移铁证）+ 元遗憾（不该省的思考）
   * - 反应失手 → 门槛收紧（下次更早进入深思）
   * - 深思成功且重复 → 习惯晋升候选（摊销推断）
   * - 各模式成功率 EMA 更新（思考价值的实测）
   */
  settleDecision(decisionId: number, overallSuccess: boolean, actionsTaken?: string[]): void;
  /** 未结算决策的只读视图（宿主对账用） */
  pendingDecisions(): MetaDecision[];
  /** 当前动态反应门槛（元学习可观测） */
  currentDecisivenessGap(): number;
  /** 习惯库只读视图（审计） */
  allHabits(): Habit[];
  /** 手动作废习惯（上游漂移信号，如变分自由能报警时） */
  invalidateHabit(state: string): boolean;
  /** 认知经济报告：思考的价格与价值的统一核算 */
  cognitiveEconomy(): CognitiveEconomy;
  private habitHitRate;
  /** 同长度深思的成本估算（习惯节省额入账口径） */
  private estimateDeliberationCost;
  /** 决策入账（pending 登记 + 认知经济计数） */
  private record;
  /** 晋升草稿（同状态连续同计划成功计数） */
  private drafts;
}
//#endregion
//#region src/core/theorist.d.ts
/** 定律成员（作用域内一条边的归纳明细） */
interface TheoryMember {
  from: string;
  to: string;
  /** do=1 臂衰减证据 */
  successes: number;
  failures: number;
  /** MLE 成功率（归纳投票口径） */
  phat: number;
  /**
   * 入伙收益（nat）：该边数据在定律下的边际对数似然（其余成员的
   * 汇聚后验作预测先验）− 自立门户的先验预测对数似然。
   * ≤ 0 = 反常者——它的数据用全族知识解释还不如自己单干。
   */
  fitsLawNat: number;
  /** 自立门户的先验预测对数似然（nat）：ln B(1+s, 1+f) */
  standaloneLogMlNat: number;
  /** 反常者：fitsLawNat ≤ 0（不属于这条定律——新范式的种子） */
  anomalous: boolean;
}
/** 归纳出的定律 */
interface Theory {
  /** 作用域标识 family→to */
  id: string;
  /** from 节点的族（id 冒号前缀；无冒号即整体） */
  family: string;
  to: string;
  /** 定律后验 Beta(1+Σs, 1+Σf) */
  lawAlpha: number;
  lawBeta: number;
  /** 定律成功率（后验均值） */
  lawP: number;
  /** 定律 Wilson 区间（比任何单边窄——借力收缩） */
  lawLower: number;
  lawUpper: number;
  /** 幸存成员（构成定律的证据） */
  members: TheoryMember[];
  /** 范式转移中被驱逐的 outlier（新范式的种子） */
  outliers: TheoryMember[];
  /**
   * 定律 vs 各自为政的精确对数贝叶斯因子（nat；>0 定律才配存在）：
   * ln B(1+Σs, 1+Σf) − Σ ln B(1+sᵢ, 1+fᵢ)
   * 共享 θ 用一个参数解释全部数据 vs 每条边各自付一个参数的代价。
   */
  compressionNat: number;
  /** 本次归纳是否发生范式转移（驱逐重建） */
  paradigmShift: boolean;
  /** law：全员一致；contested：存在反常者（定律存疑） */
  status: 'law' | 'contested';
  inducedAt: number;
}
/** 定律零样本预测（作用域内臂证据稀疏的边） */
interface TheoryPrediction {
  theoryId: string;
  p: number;
  lower: number;
  upper: number;
}
/** 理论前沿（meta-cognition 第六层 KPI） */
interface TheoryFrontier {
  /** 在世定律数 */
  theories: number;
  /** 被定律压缩的边数（不再各自为政） */
  compressedEdges: number;
  /** outlier 边数（新范式种子） */
  outlierEdges: number;
  /** 全部定律累计压缩（nat——理解的总账） */
  compressionNat: number;
  /** 零样本预测次数（定律泛化的使用量） */
  zeroShotPredictions: number;
  /** 范式转移累计次数 */
  paradigmShifts: number;
  interpretation: string;
}
interface TheoristConfig {
  /** 立定律的最小成员数（缺省 3：两条边的一致不足以称定律） */
  minMembers: number;
  /** 零样本预测的臂证据门槛：n ≥ 该值的边用自己的后验（缺省 1） */
  zeroShotMaxArmSamples: number;
}
declare const DEFAULT_THEORIST_CONFIG: TheoristConfig;
/**
 * 理论内核：定律归纳 + MDL 压缩定价 + 零样本预测 + 反常/范式转移。
 *
 * 数据流：
 *   kernel.allEdgesEvidence（原料）→ induce（按 family→to 分组、
 *   MDL 仲裁、范式转移）→ predict（定律零样本）→ frontier（第六层 KPI）
 *
 * 归纳是因果图的纯函数（确定性、可重放）；缓存仅避免重复计算。
 */
declare class TheoristEngine {
  private config;
  private kernel;
  private cached;
  private induced;
  private zeroShotCount;
  private paradigmShiftCount;
  /** 各作用域上次范式转移的成员签名（同状态重复归纳不重复计数） */
  private shiftSignatures;
  constructor(kernel: CausalKernel, config?: Partial<TheoristConfig>);
  /**
   * 归纳定律：扫描因果图全边，按 (family(from) → to) 分组，
   * 每组做 MDL 仲裁——compression > 0 才立定律；
   * 整组不抵代价时驱逐最大偏离者（范式转移）为幸存者重建。
   */
  induce(now?: number): Theory[];
  /** 覆盖 (from → to) 的在世定律（无缓存时惰性归纳） */
  coveringTheory(from: string, to: string, now?: number): Theory | undefined;
  /**
   * 定律零样本预测：作用域内臂证据稀疏的边直接拿定律后验说话。
   * 新成员入族即继承全族知识——定律覆盖处无冷启动。
   */
  predict(from: string, to: string, now?: number): TheoryPrediction | undefined;
  /** 在世定律只读视图 */
  allTheories(): Theory[];
  /**
   * 理论前沿报告（第六层 KPI：知识的压缩与体系化）。
   * 每次读取都基于当前因果图重归纳——KPI 永不呈现过期定律，
   * 且宿主无需显式调用 induce（挂载即生效；归纳是纯函数，
   * 心跳粒度重算成本 O(边数)，范式转移计数已去重防虚增）。
   */
  frontier(now?: number): TheoryFrontier;
  /** 对一组成员计算定律与模型比较账目（纯函数） */
  private evaluate;
}
//#endregion
//#region src/core/scientist.d.ts
/** 已登记的因果问题（实验设计的问题空间） */
interface CausalQuestion {
  from: string;
  to: string;
  /** 登记理由（审计：为什么这个因果问题值得回答） */
  why: string;
  /** 单次实验代价（nat；与 EIG 同货币，缺省由引擎配置） */
  costNat?: number;
  createdAt: number;
}
/** 设计好的实验（可执行单元） */
interface DesignedExperiment {
  /** 实验标识（结算回引用） */
  id: number;
  from: string;
  to: string;
  /** 最优臂（EIG 较大的干预方向） */
  arm: boolean;
  /** 该臂一步期望信息增益（nat，未含混杂加成） */
  armEig: number;
  /** 混杂加成（nat；该边因果分歧只能由干预裁决） */
  confoundingBonus: number;
  /** 总价值 = armEig + confoundingBonus + lawBonus（nat） */
  totalEig: number;
  /** 净价值 = totalEig − costNat（nat；>0 才值得做） */
  netValue: number;
  /** 11.0：定律试验加成（nat；作用域内一次实验同时检验压缩 K 条边的定律） */
  lawBonus: number;
  /** 臂后验（设计时口径；结算对账用） */
  priorAlpha: number;
  priorBeta: number;
  /** 预测臂成功率（后验均值） */
  predictedP: number;
  hypothesis: string;
  rationale: string;
}
/** 实验结算（信息台账单元） */
interface ExperimentLedgerEntry {
  experimentId: number;
  from: string;
  to: string;
  arm: boolean;
  observedY: boolean;
  /** 承诺的 EIG（nat，设计时口径） */
  promisedEig: number;
  /** 实际换到的熵收缩（nat，可测：H0 − H(结局后验)） */
  realizedInfo: number;
  /** 结局惊奇（nat，−ln P(实际结局)） */
  surprisal: number;
  settledAt: number;
}
/** 知识前沿（meta-cognition 第五层 KPI） */
interface KnowledgeFrontier {
  /** 已登记因果问题数 */
  questions: number;
  /** 存在混杂分歧的问题数（只能干预裁决） */
  confoundedQuestions: number;
  /** 所有问题两臂残差熵总和（nat；知识版图的总未知量） */
  residualEntropyNat: number;
  /** 已执行实验数 */
  experimentsRun: number;
  /** 累计设计 EIG（nat，承诺） */
  cumulativePromisedNat: number;
  /** 累计实现信息增益（nat，实测） */
  cumulativeRealizedNat: number;
  /** 设计兑现率 = realized / promised（0~1+） */
  deliveryRate: number;
  /** 设计校准 EMA（|承诺−实现|：设计者诚实度，越低越准） */
  designCalibration: number;
  interpretation: string;
}
interface ScientistConfig {
  /** 缺省单次实验代价（nat；EIG 低于此值的问题不值得做，缺省 0.05） */
  defaultCostNat: number;
  /** 混杂加成上限（nat；缺省 1.0 ≈ 一次二分问题的价值） */
  maxConfoundingBonus: number;
  /** 11.0：定律试验加成上限（nat；缺省 1.0——单实验不因定律加成无限膨胀） */
  lawBonusCap: number;
  /** 实验开始的最小臂证据门槛（样本少于该值才算前沿，缺省 0） */
  minArmSamples: number;
  /** 设计校准 EMA 平滑（缺省 0.3） */
  calibrationAlpha: number;
}
declare const DEFAULT_SCIENTIST_CONFIG: ScientistConfig;
/**
 * 科学家内核：EIG 实验设计 + 混杂侦测加成 + 最优臂选择 + 预算仲裁
 * + 信息台账 + 知识前沿。
 *
 * 数据流：
 *   registerQuestion（问题空间）→ designExperiments（最优设计）
 *   → 宿主执行 do-干预 → settleExperiment（图更新 + 惊奇回流 + 台账）
 *   → knowledgeFrontier（知识版图收缩可审计）
 */
declare class ScientistMind {
  private config;
  private kernel;
  private freeEnergy?;
  /** 11.0：理论内核（挂载后作用域内的问题获得定律试验加成） */
  private theorist?;
  private questions;
  private ledger;
  private experimentCounter;
  private cumulativePromised;
  private cumulativeRealized;
  private calibrationEma;
  constructor(kernel: CausalKernel, freeEnergy?: FreeEnergyEngine, config?: Partial<ScientistConfig>);
  /** 挂载自由能引擎（实验结局的惊奇回流；幂等） */
  attachFreeEnergyEngine(engine: FreeEnergyEngine): void;
  /** 11.0：挂载理论内核（定律试验加成；幂等） */
  attachTheorist(theorist: TheoristEngine): void;
  /**
   * 登记因果问题：一条值得回答的「X 是否导致 Y」。
   * 问题空间由宿主/好奇心/调度器声明——科学家只对已声明的问题设计实验。
   */
  registerQuestion(from: string, to: string, why?: string, costNat?: number): CausalQuestion;
  /** 注销问题（问题被回答或不再关心） */
  unregisterQuestion(from: string, to: string): boolean;
  /** 问题空间只读视图 */
  allQuestions(): CausalQuestion[];
  /**
   * 最优实验设计：对问题空间逐一计算 EIG，按净价值排序。
   *
   * 每个问题的评估：
   *   1. 两臂 Beta(1+s, 1+f) 重构（与因果内核 effect() 同数学）
   *   2. 各臂 EIG = 一步期望熵收缩；取大者为最优臂
   *   3. 混杂加成 = −ln(1 − confounding)（背离只能干预裁决）
   *   4. netValue = totalEig − costNat；≤0 不设计（预算仲裁）
   *
   * @param maxCount 最多返回的设计数（组合预算）
   */
  designExperiments(maxCount?: number, now?: number): DesignedExperiment[];
  /**
   * 结算实验：宿主已按设计执行 do-干预并观测到 Y。
   *
   * 三重回流 + 台账：
   * 1. 因果内核干预证据入库（黄金证据）
   * 2. 自由能惊奇回流（预测 vs 结局）
   * 3. 台账：承诺 EIG vs 实际熵收缩（设计校准）
   *
   * @returns 台账条目；设计不存在或重复结算返回 undefined
   */
  settleExperiment(design: DesignedExperiment, observedY: boolean, actor?: string, now?: number): ExperimentLedgerEntry | undefined;
  /** 知识前沿报告：知识版图的总未知量与设计的兑现率（第五层 KPI） */
  knowledgeFrontier(now?: number): KnowledgeFrontier;
  /** 台账只读视图（审计） */
  experimentLedger(): ExperimentLedgerEntry[];
}
//#endregion
//#region src/core/anytime-evidence.d.ts
/**
 * anytime-evidence.ts — 任意时刻有效证据内核（项目 12.0「永不撒谎的统计」质变基座）
 *
 * 升级前的根本局限（3.0 证据内核的天花板）：
 * 系统是一部**永不停机的流处理器**——决策、选型、进化、熔断每时每刻
 * 都在读取统计量并行动。但 3.0 的 Wilson 下界是**固定样本口径**的：
 * - 「偷看」无效：Wilson 界只在「先定样本量、再看数据」时成立；系统
 *   却是边看边停（连续监控下任何固定样本界都会严重夸大置信度——
 *   停止时刻是被数据挑选的， peeking 悖论）；
 * - 不能「随时下结论」：想宣布「模型 A 确证劣于基线」，现有口径没有
 *   合法的停止规则——要么等固定样本（永远不齐），要么偷看（不合法）；
 * - 多重比较失控：对 N 个模型/N 条策略各自做检验，错误发现率（FDR）
 *   无控制——并行淘汰越激进，冤案率越高；
 * - 置信度随时间重置：同一统计量在不同时刻反复使用，名义 95% 的界
 *   实际覆盖率随观测次数增加而衰减到 0。
 *
 * 本内核引入 2020 年代统计学的任意时刻有效推断
 * （Ramdas–Grünwald–Vovk–Shafer 学派：e-值 / e-过程 / 置信序列）：
 *
 * 1. **缝合经验伯恩斯坦置信序列（stitched EB-CS）**：
 *      CS_t = μ̂_t ± min(Hoeffding 半径, EB 半径)
 *    对全部时刻 t 同时成立（时间一致覆盖 ≥ 1−α）——**在任意停止时刻
 *    读区间都合法**。几何分期（epoch 2^k）× 联合界把「偷看」变合法；
 *    低方差流上 EB 半径远窄于 Hoeffding（收敛快一个量级）。
 *
 * 2. **e-过程（资本过程 / 可验证赌注）**：检验 H0: μ ≤ μ0（或 ≥ μ0）
 *      e_t = Π (1 + λ_i (X_i − μ0)), λ 可预测（只依赖过去）
 *    零假设下 e_t 是非负上鞅 → Ville 不等式：
 *      P(∃t: e_t ≥ 1/α) ≤ α
 *    **对任意（甚至数据自适应的）停止时刻有效**——「证据积到 1/α
 *    就定罪」是数学上无懈可击的停止规则。
 *
 * 3. **e-BH 多重检验（FDR 控制）**：对 m 条并行检验的 e-值做
 *    Benjamini-Hochberg 的 e-版本（Wang & Ramdas 2022）：在**任意
 *    依赖**结构下 FDR ≤ fdr——并行淘汰「证明确实差」的策略/模型时，
 *    冤案率的数学上限被钉死。
 *
 * 4. **任意时刻 p-值**：p_t = min(1, 1/e_t)——对每个 t 都合法
 *    （超均匀），与 e-过程同源。
 *
 * 与 3-11.0 的关系：3.0 给了统一的证据语言，本内核给这套语言
 * 补上**在线有效性**——系统从「定时看报表的统计」升维为
 * 「永不停机且永不撒谎的统计」。Wilson 下界继续服务固定口径场景
 * （并行旁路，不替换）；凡「边看边停」的场景（进化淘汰、劣化判定、
 * 漂移侦测）一律升级为任意时刻有效口径。
 */
/** 置信序列读取视图（任意时刻读取均合法） */
interface ConfidenceSequenceView {
  /** 样本量 */
  n: number;
  /** 样本均值（中心估计） */
  mean: number;
  /** 时间一致置信下界（覆盖 ≥ 1−α 对所有 t 同时成立） */
  lower: number;
  /** 时间一致置信上界 */
  upper: number;
  /** 半径（upper − mean） */
  radius: number;
  /** 当前分期（epoch k = ⌊log2 n⌋） */
  epoch: number;
}
/**
 * 缝合置信序列半径（纯函数，epoch k 上的联合界）。
 *
 * 数学（对 n ≥ 1，k = ⌊log2 n⌋，β_k = α·2^{−(k+2)} 每条界各分一半）：
 * - Hoeffding：|μ̂−μ| ≤ sqrt(ln(2/β_k) / (2n))（X∈[0,1]）
 * - 经验伯恩斯坦（Maurer–Pontil）：|μ̂−μ| ≤ sqrt(2σ̂²·ln(2/β_k)/n)
 *   + 7ln(2/β_k)/(3(n−1))，σ̂² = 样本方差
 * - 取二者最小（每条各用 β_k，分期 × 两条界联合求和恰为 α）
 *
 * 任何时刻读取均合法：Σ_k 2β_k = α。
 */
declare function stitchedCsRadius(n: number, sampleVariance: number, alpha: number): number;
/**
 * 固定样本单侧上界（13.0 风险控制器复用；β 直接给定，不做分期）。
 *
 * 经验伯恩斯坦上界：μ ≤ μ̂ + sqrt(2σ̂²·ln(1/β)/n) + 7ln(1/β)/(3(n−1))。
 */
declare function fixedSampleUpperBound(n: number, mean: number, sampleVariance: number, beta: number): number;
/**
 * 流式经验伯恩斯坦置信序列
 *
 * observe(x∈[0,1]) 单遍累积（均值 + 方差 Welford 在线算法），
 * bounds() 在任意时刻返回时间一致置信区间。
 */
declare class EmpiricalBernsteinSequence {
  private readonly alpha;
  private n;
  private mean;
  private m2;
  constructor(alpha: number);
  /** 观测一次 x ∈ [0,1]（连续收益按值观测，布尔按 0/1 观测） */
  observe(x: number): void;
  /** 当前样本量 */
  get count(): number;
  /** 当前均值 */
  get sampleMean(): number;
  /** 样本方差（n≥2；n=1 视为 0） */
  get sampleVariance(): number;
  /** 任意时刻读取的时间一致置信区间 */
  bounds(): ConfidenceSequenceView;
  /** 假设值 μ 是否落在当前置信序列内（任意停止时刻合法） */
  contains(mu: number): boolean;
}
/** e-过程方向：null 为 μ ≤ μ0（at-most）或 μ ≥ μ0（at-least） */
type EProcessSide = 'at-most' | 'at-least';
/**
 * 单侧 e-过程（资本过程）
 *
 * 检验 H0: μ ≤ μ0（side='at-most'，λ ≥ 0）或 H0: μ ≥ μ0
 * （side='at-least'，λ ≤ 0）：
 *   e_t = Π_{i≤t} (1 + λ_i (X_i − μ0))
 * λ_i 可预测（只依赖 i−1 前的 μ̂）且 |λ_i| ≤ 0.5 —— 对任意
 * μ0∈(0,1)、x∈[0,1] 保持因子严格正（≥ 0.5）。零假设下
 * E[1+λ(X−μ0)] ≤ 1 → 非负上鞅 → Ville：P(∃t: e_t ≥ 1/α) ≤ α。
 */
declare class EProcess {
  readonly mu0: number;
  readonly side: EProcessSide;
  private capital;
  private n;
  private mean;
  /** 历史峰值（审计：证据曾到达多强） */
  private peak;
  constructor(mu0: number, side: EProcessSide);
  /** 观测一次 x ∈ [0,1]；返回更新后的 e-值 */
  observe(x: number): number;
  /** 当前 e-值（≥ 0；零假设下任意时刻 ≤ 1/α 的概率 ≤ α） */
  get eValue(): number;
  /** 历史峰值 */
  get peakValue(): number;
  /** 样本量 */
  get count(): number;
  /** 是否已在水平 α 下拒绝零假设（e ≥ 1/α，任意停止时刻合法） */
  rejectedAt(alpha: number): boolean;
  /** 任意时刻有效 p-值：p_t = min(1, 1/e_t)（超均匀） */
  anytimePValue(): number;
}
/** e-BH 检验条目 */
interface EBHEntry {
  /** 被检对象标识 */
  id: string;
  /** e-值（来自各对象的 e-过程） */
  eValue: number;
}
/**
 * e-Benjamini-Hochberg（Wang & Ramdas 2022）：任意依赖下 FDR ≤ fdr。
 *
 * 算法：e 值降序 e_(1) ≥ … ≥ e_(m)；
 *   k* = max{ k : e_(k) ≥ m/(k·fdr) }；
 *   拒绝所有 e ≥ m/(k*·fdr) 的对象（k*=0 时不拒绝）。
 *
 * 用途：并行淘汰「证明确实低于水位线」的策略/模型——冤案率（FDR）
 * 有数学上限，与检验数量、依赖结构无关。
 */
declare function eBenjaminiHochberg(entries: EBHEntry[], fdr: number): string[];
/** 组合流配置 */
interface AnytimeEvidenceConfig {
  /** 时间一致覆盖率（置信序列口径，缺省 0.05 → 95%） */
  alpha: number;
  /** 参考水位线 μ0（裁决基准：高于/低于该线的可证裁决，缺省 0.5） */
  reference: number;
}
declare const DEFAULT_ANYTIME_EVIDENCE_CONFIG: AnytimeEvidenceConfig;
/** 任意时刻有效裁决 */
type AnytimeVerdict = 'above-reference' | 'below-reference' | 'undecided';
/** 组合流读取视图 */
interface AnytimeEvidenceView {
  n: number;
  /** 置信序列（任意时刻合法） */
  cs: ConfidenceSequenceView;
  /** H0: μ ≤ μ0 的 e-值（大 → 证实高于水位线） */
  eAbove: number;
  /** H0: μ ≥ μ0 的 e-值（大 → 证实低于水位线） */
  eBelow: number;
  /** 当前裁决（e ≥ 1/α 时确证；否则 undecided——诚实的不确定） */
  verdict: AnytimeVerdict;
  /** 任意时刻有效 p-值（与裁决同源） */
  anytimeP: number;
}
/**
 * 任意时刻有效证据流（置信序列 + 双侧 e-过程 + 裁决）
 *
 * 一次 observe 同时驱动三台机器：
 * - 置信序列：值域估计（任意时刻读取）
 * - e↑：检验「μ ≤ μ0」（确证高于水位线）
 * - e↓：检验「μ ≥ μ0」（确证低于水位线）
 * verdict 在任一方向确证时给出，否则 undecided——系统第一次拥有
 * 「随时下结论且结论永不夸大」的能力。
 */
declare class AnytimeEvidenceStream {
  private readonly config;
  private readonly cs;
  private readonly eUp;
  private readonly eDown;
  constructor(config?: Partial<AnytimeEvidenceConfig>);
  /** 参考水位线 */
  get reference(): number;
  /** 观测一次 x ∈ [0,1]（连续收益或 0/1 布尔） */
  observe(x: number): AnytimeEvidenceView;
  /** 当前读取视图（纯读取，不改变状态） */
  view(): AnytimeEvidenceView;
}
/** 登记表报告 */
interface AnytimeEvidenceRegistryReport {
  /** 活跃流数量 */
  streams: number;
  /** 各裁决方向的流数量 */
  verdicts: {
    above: number;
    below: number;
    undecided: number;
  };
  /** 累计确证次数（裁决从 undecided 翻转的时刻） */
  totalConfirmations: number;
  /** e-BH 累计淘汰数 */
  totalEliminations: number;
  /** 最强证据（当前活跃流中的最大 e-值） */
  strongestEvidence: number;
  interpretation: string;
}
/**
 * 任意时刻证据登记表
 *
 * 管理一组并行对象（策略基因组 / 模型 / 密钥）的证据流：
 * - observe(id, x)：向对象 id 的流喂证据（流惰性创建）
 * - verdicts()：全部流的当前裁决
 * - eliminate(fdr)：对「确证低于水位线」的对象做 e-BH FDR 控制淘汰
 *
 * 淘汰语义：只淘汰 e-值确证的对象；FDR ≤ fdr 在任意依赖下成立——
 * 并行淘汰的冤案率第一次有了数学上限。
 */
declare class AnytimeEvidenceRegistry {
  private readonly config;
  private streams;
  private confirmedOnce;
  private totalEliminations;
  private fdrLevel;
  constructor(config?: Partial<AnytimeEvidenceConfig>);
  /** 喂证据（流按需创建）；返回该对象当前视图 */
  observe(id: string, x: number): AnytimeEvidenceView;
  /** 对象当前视图（未登记返回 undefined） */
  viewOf(id: string): AnytimeEvidenceView | undefined;
  /** 释放对象（淘汰/注销后清理流） */
  forget(id: string): void;
  /**
   * e-BH FDR 控制淘汰：返回被确证低于水位线（且通过多重校正）的对象。
   *
   * 只对 e↓ ≥ 1/α 的候选进入 e-BH；淘汰即 forget（调用方负责从其
   * 业务结构中移除对象）。零候选 → 零淘汰（诚实的不确定）。
   */
  eliminate(fdr?: number): string[];
  /** 登记表报告 */
  report(): AnytimeEvidenceRegistryReport;
}
/** 六位小数圆整（13.0/16.0 内核复用的展示口径） */
declare function round(x: number): number;
//#endregion
//#region src/core/optimal-transport.d.ts
/**
 * optimal-transport.ts — 最优传输内核（项目 17.0「漂移检测看见分布的形状」质变基座）
 *
 * 升级前的根本局限（均值水位检测的形状盲区）：
 * - 12.0 的 e-过程 / 置信序列盯的是**均值水位**（μ 是否越过水位线）——
 *   一个均值不变、形状巨变的分布（双峰化、方差爆炸、尾部变厚）在
 *   水位线检测下完全隐形：μ̂ 纹丝不动，系统却已经换了世界；
 * - z-score / 方差检测只看一两个矩——矩相同而分布不同的两个世界
 *   无穷多，二阶统计不足以充当「世界没变」的证书；
 * - KL 散度在不相交支撑（旧窗口全是 0.6，新窗口全是 0.9）上
 *   发散为 ∞，既不可比较也不可累积；平方误差只看均值差。
 *
 * 本内核引入 Monge–Kantorovich 最优传输理论（Villani 2009 Fields /
 * Cuturi 2013 Sinkhorn / Peyré–Cuturi 2019 计算最优传输）：
 *
 * 1. **一维精确 Wasserstein-p**（分位数耦合）：
 *      W_p(μ, ν) = ( ∫₀¹ |F_μ⁻¹(q) − F_ν⁻¹(q)|ᵖ dq )^{1/p}
 *    一维情形最优耦合就是分位数单调配对（秩相依 / comonotone 耦合），
 *    经验分布上排序后逐分位配对即**精确值**——不是近似，O(n log n)。
 *    W₁ = 「把分布 μ 的土搬到 ν 的最小搬运代价」，单位就是被监测
 *    量本身的单位（质量分 / 延迟毫秒）——可解释、可设定阈。
 *
 * 2. **熵正则 Sinkhorn（任意代价矩阵的离散 OT）**：
 *      min_π ⟨C, π⟩ + ε·KL(π ‖ a bᵀ),  s.t. π1 = μ, πᵀ1 = ν
 *    Cuturi 2013：Sinkhorn 不动点迭代在 Hilbert 度量下收缩，
 *    O(k²) 每步、线性收敛；对数域稳定化（log-sum-exp）防下溢。
 *    代价矩阵可以是任意「行为距离」——预算在 niche 网格间的
 *    最小移动方案（探索预算再平衡）有了数学最优解。
 *
 * 3. **Wasserstein 重心（barycenter）**：
 *    一维固定质量情形，重心 = 分位数平均：B⁻¹(q) = Σ wᵢ Fᵢ⁻¹(q)。
 *    多个窗口 / 多个模型的分布信息融合为一条「共识分布」——
 *    比「平均的均值」保留全部形状（均值融合丢掉形状，重心融合
 *    保留形状），11.0 定律归纳的分布版。
 *
 * 4. **形状感知漂移监视器（TransportDriftMonitor）**：
 *    滑动窗 vs 基准窗的 W₁ 持续计算；阈值不是拍的——历史窗口间
 *    W₁ 的经验分布给出「正常漂移」的分位数（conformal 式阈值，
 *    与 13.0 同一哲学：让数据自己定阈），超越即报 shape-drift。
 *
 * 与 12.0 的关系：12.0 盯水位（均值），本内核盯形状（全分布）——
 * 「水平没变但世界换了」第一次可见；与 13.0 的关系：保形覆盖保证
 * 在分布漂移下失效，本内核是保形区间的**绊线**（先见漂移、再谈覆盖）；
 * 与 14.0 的关系：Sinkhorn 给出探索预算跨 niche 的最优搬运方案，
 * 多样性维护从「均匀采样」升维为「最小代价再平衡」。
 */
/**
 * 一维经验 Wasserstein-p 距离（精确：分位数单调耦合）。
 *
 * 两个样本集各自视为等权经验分布；排序后按分位配对：
 *   W_p = ( (1/m) Σ |a_(i) − b_(i)|ᵖ )^{1/p}（m = n 时逐秩配对；
 *   m ≠ n 时按经验分位数网格插值）。
 *
 * @param p 距离阶数（1 = 搬运代价，2 = 能量距离；缺省 1）
 */
declare function wasserstein1D(samplesA: readonly number[], samplesB: readonly number[], p?: number): number;
/** 排序数组的经验分位数（线性插值；q ∈ [0,1]） */
declare function quantileSorted(sorted: readonly number[], q: number): number;
/**
 * 一维 Wasserstein 重心（分位数平均）：多个经验分布按权重融合为一条共识分布。
 *
 * B⁻¹(q) = Σᵢ wᵢ Fᵢ⁻¹(q)——保留全部形状信息的「分布平均」
 * （均值的平均只留一个数，重心的平均留一条曲线）。
 *
 * @returns 重心的代表样本集（分位数网格采样），可直接参与后续 W 距离计算
 */
declare function wassersteinBarycenter1D(distributions: readonly (readonly number[])[], weights?: readonly number[]): number[];
/** Sinkhorn 求解配置 */
interface SinkhornConfig {
  /** 熵正则强度 ε（越小越接近精确 OT、收敛越慢；缺省 0.05） */
  epsilon: number;
  /** 最大迭代数（缺省 200） */
  maxIterations: number;
  /** 收敛容差（边际约束残差；缺省 1e-9） */
  tolerance: number;
  /** 代价矩阵数值范围保护（|C| 上限；缺省 100） */
  maxCost: number;
}
declare const DEFAULT_SINKHORN_CONFIG: SinkhornConfig;
/** Sinkhorn 求解结果 */
interface SinkhornResult {
  /** 传输方案 π（π[i][j] = 从 i 搬到 j 的质量） */
  plan: number[][];
  /** 熵正则传输代价 ⟨C, π⟩（+ ε·KL 已剔除的主项） */
  cost: number;
  /** 收敛判定 */
  converged: boolean;
  /** 实际迭代数 */
  iterations: number;
  /** 边际约束最大残差 */
  residual: number;
}
/**
 * 对数域稳定化 Sinkhorn 求解器
 *
 * 不动点迭代（Hilbert 度量压缩，Franklin–Lorenz 1989；Cuturi 2013）：
 *   f_i ← −ε log Σ_j exp((g_j − C_ij)/ε) a_j
 *   g_j ← −ε log Σ_i exp((f_i − C_ij)/ε) b_i
 * 全程 log-sum-exp，指数下溢免疫；f、g 为对偶势（Kantorovich 最优
 * 对偶变量的熵正则版）。
 */
declare function sinkhorn(cost: readonly (readonly number[])[], sourceMass: readonly number[], targetMass: readonly number[], config?: Partial<SinkhornConfig>): SinkhornResult;
/** 传输漂移监视器配置 */
interface TransportDriftConfig {
  /** 滑动窗容量（近期样本；缺省 50） */
  windowSize: number;
  /** 基准窗容量（历史样本；缺省 200） */
  referenceSize: number;
  /** 漂移阈值的经验分位数（历史窗间 W₁ 的分位；缺省 0.95） */
  thresholdQuantile: number;
  /** 最小样本量（双方达标才开始判定；缺省 20） */
  minSamples: number;
  /** 严重度平滑因子（severity = W₁ / threshold 的自然缩放；缺省 1） */
  severityScale: number;
}
declare const DEFAULT_TRANSPORT_DRIFT_CONFIG: TransportDriftConfig;
/** 漂移视图 */
interface TransportDriftView {
  /** 窗口 vs 基准的 W₁（被监测量原单位） */
  w1: number;
  /** 自适应阈值（历史漂移的分位数） */
  threshold: number;
  /** 是否判定漂移 */
  drifting: boolean;
  /** 严重度 = w1 / threshold（>1 越多越严重） */
  severity: number;
  /** 方向洞察：均值位移量（窗口均值 − 基准均值） */
  meanShift: number;
  /** 形状洞察：分布展宽比（窗口 σ / 基准 σ；≈1 形状未变，>1 双峰化/尾部变厚） */
  spreadRatio: number;
  /** 漂移主成分：level（均值水位）/ shape（形状重排）/ both / none */
  kind: 'none' | 'level' | 'shape' | 'both';
  /** 样本量（窗口 / 基准） */
  samples: {
    window: number;
    reference: number;
  };
  interpretation: string;
}
/** 漂移事件（翻转沿审计） */
interface TransportDriftEvent {
  at: number;
  kind: TransportDriftView['kind'];
  severity: number;
  w1: number;
  threshold: number;
}
/**
 * 形状感知传输漂移监视器
 *
 * 用法：
 *   const monitor = new TransportDriftMonitor();
 *   monitor.observe(0.82);  // 持续喂入被监测量（质量分 / 延迟 / 收益）
 *   monitor.drift();        // 任意时刻读取（W₁ 原单位 + 自适应阈值）
 *
 * 几何细节：基准窗取**滑动窗之前**的样本（两窗不相交）——若拿
 * 包含自身的历史当基准，W₁ 被窗口⊂基准的相关性系统性压低，
 * 阈值口径失真。阈值哲学（与 13.0 同源）：不拍脑袋——历史平稳期
 * 两两 W₁ 构成「正常漂移」经验分布，thresholdQuantile 分位即阈值；
 * 新 W₁ 入账前先裁决，漂移期样本不污染基准。
 */
declare class TransportDriftMonitor {
  private readonly config;
  private readonly buffer;
  private readonly historyW1;
  private lastDrifting;
  private events;
  constructor(config?: Partial<TransportDriftConfig>);
  /** 观测一次被监测量 */
  observe(x: number): TransportDriftView;
  /** 当前漂移视图（纯读取） */
  drift(): TransportDriftView;
  /** 漂移事件审计（翻转沿） */
  recentEvents(limit?: number): TransportDriftEvent[];
  /** 当前自适应阈值（历史 W₁ 的分位；历史不足时退化为 2.5σ 启发） */
  private currentThreshold;
  private interpret;
}
//#endregion
//#region src/core/kalman-filter.d.ts
/**
 * 27.0 卡尔曼滤波内核 —— 线性高斯状态空间滤波 + RTS 平滑 + NIS 门控
 *
 * 动机: KPI 快照是**带噪的状态观测**——成功率的真水平被采样噪声、窗口效应、
 * 瞬时抖动遮蔽。z-score（meta-cognition 1 号检查）在窗口内做无记忆比较，
 * 而卡尔曼滤波把整条历史压缩进 (x, P) 两个充分统计量：
 *
 *   预测:  x⁻ = F·x,  P⁻ = F·P·Fᵀ + Q
 *   更新:  y = z − H·x⁻（新息）,  S = H·P⁻·Hᵀ + R
 *          K = P⁻·Hᵀ·S⁻¹（最优增益 = 最小方差）
 *          x = x⁻ + K·y,  P = (I−K·H)·P⁻
 *   新息平方和 NIS = yᵀ·S⁻¹·y ~ χ²(dim)（模型正确时）
 *     → NIS 门控: 突变不是「窗口均值变了」而是「新息超出模型方差 99.7%
 *       分位」——异常判定从启发式升级为假设检验。
 *
 *   平滑（RTS，批量回看）: 后向递推把未来信息回灌历史估计——
 *     趋势斜率的「事后最优」读数（检测缓慢漂移比滤波更早确认）。
 *
 *   随机游走稳态解析解（验证锚点）: q 过程噪声 / r 观测噪声,
 *     P∞ 满足 P∞ = q + r·P∞/(P∞+r) → P∞ = (q + √(q²+4qr))/2,
 *     K∞ = P∞/(P∞+r)——Riccati 迭代收敛于此（精确对照）。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致。
 */
type Matrix = number[][];
/** 列向量 */
type Vec = number[];
/** χ² 分布分位数（自由度 df、上侧概率 p） */
declare function chiSquareQuantile(p: number, df: number): number;
interface KalmanModel {
  /** 状态转移 F */
  F: Matrix;
  /** 观测矩阵 H */
  H: Matrix;
  /** 过程噪声协方差 Q */
  Q: Matrix;
  /** 观测噪声协方差 R */
  R: Matrix;
  /** 初始状态（列向量） */
  x0: Vec;
  /** 初始协方差 */
  P0: Matrix;
}
interface KalmanStepResult {
  /** 滤波后状态（列向量） */
  x: Vec;
  /** 新息（标量观测） */
  innovation: number;
  /** 新息方差 S */
  innovationVar: number;
  /** 新息平方和（NIS，模型正确时 ~ χ²(dim)） */
  nis: number;
  /** 本步对数似然（用于模型比较 / 变点检测） */
  logLikelihood: number;
  /** NIS 是否超过门控分位 */
  gated: boolean;
}
/**
 * 线性高斯卡尔曼滤波器（dim ≤ 3 的小矩阵实现，标量观测）。
 *
 * predict()/update() 分离（无观测的心跳可只预测），step(z) = 预测 + 更新 +
 * 门控判定。所有数值在线更新，无历史缓冲（内存 O(dim²)）。
 */
declare class KalmanFilter {
  private readonly model;
  private readonly gateQuantile;
  private readonly gateThreshold;
  private x;
  private P;
  constructor(model: KalmanModel, gateP?: number);
  /** 一步预测（不更新） */
  predict(): void;
  /** 一步预测 + 观测更新 + NIS 门控 */
  step(z: number): KalmanStepResult;
  /** 观测更新（假设已 predict） */
  update(z: number): KalmanStepResult;
  get state(): Vec;
  get covariance(): Matrix;
  get gate(): {
    p: number;
    threshold: number;
  };
}
/**
 * 随机游走 + 白噪观测的稳态滤波方差（精确闭式）：
 *   P∞ = (√(q² + 4·q·r) − q) / 2,  K∞ = P∞ / (P∞ + r)
 * （Riccati 稳态方程 P² + q·P − q·r = 0 的正根；验证锚点：迭代收敛于此值）
 */
declare function randomWalkSteadyState(q: number, r: number): {
  pInf: number;
  kInf: number;
};
interface TrendFilterConfig {
  /** 水平过程噪声 q_level（越大跟踪越快、越信新观测；缺省 1e-4） */
  qLevel: number;
  /** 斜率过程噪声 q_slope（缺省 1e-6） */
  qSlope: number;
  /** 观测噪声方差 r（缺省 2e-4） */
  r: number;
  /** NIS 门控上侧概率（缺省 0.997 ≈ 3σ） */
  gateP: number;
  /** 初始水平不确定度 */
  p0Level: number;
  /** 初始斜率不确定度 */
  p0Slope: number;
}
declare const DEFAULT_TREND_FILTER_CONFIG: TrendFilterConfig;
interface TrendStepRead {
  /** 滤波水平（去噪后的当前值） */
  level: number;
  /** 滤波斜率（每步变化率） */
  slope: number;
  /** 新息 */
  innovation: number;
  /** NIS 与门控阈值 */
  nis: number;
  threshold: number;
  /** NIS 超门（异常观测） */
  gated: boolean;
  /** 水平的滤波方差 */
  levelVar: number;
  logLikelihood: number;
}
interface SmoothedPoint {
  level: number;
  slope: number;
}
/**
 * 局部线性趋势滤波器（constant-velocity 模型，标量序列）：
 *
 *   状态 [level, slope]ᵀ,  F = [[1,1],[0,1]],  H = [1, 0]
 *   Q = diag(q_level, q_slope),  R = r
 *
 * 用途: KPI 序列的去噪读数（level）、缓慢漂移的早期读数（slope）、
 * 突变的假设检验（NIS 门控）。历史保留 filter 状态序列以支持 RTS 平滑。
 */
declare class LocalLinearTrendFilter {
  private config;
  private filter;
  private history;
  private last;
  constructor(config?: Partial<TrendFilterConfig>);
  /** 喂入一个观测（自动先验初始化：首个观测把水平初始化为 z，收敛更快） */
  observe(z: number): TrendStepRead;
  /** 最近一次滤波读数（纯读取；无观测时 undefined） */
  get lastRead(): TrendStepRead | undefined;
  /**
   * RTS 平滑（批量后向回看）：用全部历史给出每个时刻的事后最优
   * (level, slope)。缓慢漂移的确认比纯滤波更早、更稳。
   */
  smooth(): SmoothedPoint[];
  get size(): number;
}
//#endregion
//#region src/core/nonlinear-dynamics.d.ts
/**
 * 38.0 非线性动力学内核 —— Lyapunov 指数 + Hurst 标度：系统动力学体质分类
 *
 * 动机: KPI 序列的异常检测（z-score / NIS / 形状漂移）都在问「现在
 * 正常吗」，没有问**这条序列是什么体质**：
 *
 *   最大 Lyapunov 指数 λ₁ > 0 ⟹ 混沌（敏感依赖）——误差指数放大，
 *     任何预测的可用视野只有 ~1/λ₁ 步；λ₁ ≤ 0 ⟹ 轨道稳定。
 *     Rosenstein 法（1993）：重构空间找最近邻，平均对数分离率的最陡
 *     段斜率——不重构全谱，只取最大指数，短序列可用。
 *
 *   Hurst 指数 H（R/S 分析，1951）——长记忆标度：
 *     H > 0.5 持续性（趋势自我强化，动量口径）；H ≈ 0.5 无记忆
 *     （布朗）；H < 0.5 反持续（均值回归，振荡口径）。
 *     E[R(n)/S(n)] ~ c·n^H。
 *
 *   体质分类改变下游口径: 混沌序列上精细预测器（26.0 GP / 世界模型）
 *     的置信区间应随 1/λ₁ 收窄视野；持续序列的趋势洞察值得加权；
 *     反持续序列的「突破」多半回归——**同一份 KPI，三种读法**。
 *
 *   验证锚点: logistic 映射 x→4x(1−x) 的 λ₁ = ln 2（解析已知）；
 *     白噪声 H ≈ 0.5；趋势叠加随机游走 H > 0.5。
 *
 * 零漂移: 未挂载时元认知输出与升级前逐位一致。
 */
interface LyapunovResult {
  /** 最大 Lyapunov 指数估计（每步，nat） */
  lambda: number;
  /** 拟合窗口（用于斜率回归的分离步区间 [0, fitWindow]） */
  fitWindow: number;
  /** 平均分离曲线（log 发散 vs 步数；断言单调性的原料） */
  divergence: number[];
  usedPairs: number;
}
/**
 * Rosenstein 最大 Lyapunov 指数。
 *
 * series: 标量序列（≥ 32 点）；meanGap 排除时间近邻（假最近邻防御）；
 * fitWindow: 线性拟合的步数上限（缺省 ~ √N）。
 */
declare function largestLyapunov(series: ReadonlyArray<number>, options?: {
  meanGap?: number;
  fitWindow?: number;
}): LyapunovResult | undefined;
interface HurstResult {
  hurst: number;
  /** 各窗口的 (log n, log R/S) 点（回归原料） */
  points: Array<{
    logN: number;
    logRS: number;
  }>;
}
/** R/S 分析（多窗口聚合回归；窗口数不足时返回 undefined） */
declare function hurstExponent(series: ReadonlyArray<number>): HurstResult | undefined;
type DynamicsRegime = 'chaotic' | 'persistent' | 'mean-reverting' | 'stochastic';
interface DynamicsAssessment {
  regime: DynamicsRegime;
  lyapunov: number | undefined;
  hurst: number | undefined;
  /** 混沌视野（步数 ≈ 1/λ₁；λ₁ ≤ 0 时 undefined = 无界） */
  forecastHorizonSteps: number | undefined;
  readable: boolean;
}
/**
 * 最近邻一步可预测性（噪声门判据，Casdagli 局部线性预测）。
 *
 * 每点取值域最近 m 邻居，用邻居的下一步均值预测：白噪声无增益
 * （score ≈ 1）；确定性映射近零误差（score ≈ 0）；线性 AR 只有
 * 线性增益（φ=±0.8 → score ≈ 0.6）。作混沌判定的前置门——白噪声
 * 对 Rosenstein 是无穷维混沌（最近邻瞬间发散），必须先排除。
 */
declare function determinismScore(series: ReadonlyArray<number>, m?: number): number | undefined;
/**
 * 动力学体质分类（38.0 接线口径）。
 *
 * 判序: 先过**噪声门**（最近邻一步可预测性 determinism < 0.5——白噪声
 * 无可预测增益，却会被 Rosenstein 判成无穷维混沌）；过门且 λ₁ > λPos
 * （缺省 0.05 nat/步）→ 混沌；否则 H > 0.5+δ → 持续、H < 0.5−δ →
 * 反持续、其余 → 随机漫步体质。
 */
declare function dynamicsRegime(series: ReadonlyArray<number>, options?: {
  lambdaThreshold?: number;
  hurstDelta?: number;
  determinismGate?: number;
}): DynamicsAssessment;
//#endregion
//#region src/meta-cognition.d.ts
/** KPI 快照 */
interface KpiSnapshot {
  timestamp: number;
  /** 执行成功率 0~1 */
  successRate: number;
  /** 平均质量分 0~1 */
  avgQuality: number;
  /** 平均延迟（毫秒） */
  avgLatency: number;
  /** 决策缓存命中率 0~1 */
  cacheHitRate: number;
  /** 各模型成功率（模型健康度） */
  modelSuccessRates: Record<string, number>;
  /** 当前活跃执行数 */
  activeExecutions: number;
}
/** KPI 异常事件 */
interface KpiAnomaly {
  kpi: string;
  value: number;
  /** 窗口均值 */
  baseline: number;
  /** z-score（绝对值） */
  zScore: number;
  direction: 'degraded' | 'improved';
  timestamp: number;
}
/** 参数调整动作 */
interface TuningAction {
  parameter: 'qualityThreshold' | 'maxRetries' | 'aggregationWindow';
  from: number;
  to: number;
  reason: string;
  timestamp: number;
  /** 5.0：因果依据（该旋钮对目标 KPI 的干预效应估计） */
  causalBasis?: {
    ate: number;
    lower: number;
    confidence: number;
    interventionalSamples: number;
  };
}
/** 健康报告 */
interface HealthReport {
  healthy: boolean;
  score: number;
  message?: string;
  samples?: number;
  kpis: {
    successRate?: number;
    avgQuality?: number;
    avgLatency?: number;
    cacheHitRate?: number;
  };
  degradeStreaks?: Record<string, number>;
  recentAnomalies?: KpiAnomaly[];
  recentTuning?: TuningAction[];
  /**
   * 6.0：感知侧自由能（EMA 惊奇，nat）——统一健康度。
   *
   * 与逐项 KPI 的本质区别：KPI 各自为政（成功率降/质量降/缓存降），
   * 自由能度量的是系统生成模型对世界的「预测握力」——无论哪项
   * 漂移，惊奇都会上升。一个数字回答「系统整体还理解这个世界吗」。
   */
  freeEnergy?: {
    surprisalEma: number;
    samples: number;
    interpretation: string;
  };
  /**
   * 7.0：梦校准（深思心智的想象可靠性 KPI）。
   *
   * 自由能度量「系统预测世界有多准」；梦校准度量「系统预测
   * **自己的计划**有多准」——想象推演 vs 真实执行的逐步误差。
   * 校准差 = 计划在脑内排练的成绩与现实的落差：想象不可信时，
   * 深思搜索的结论全部作废（应先修转移模型再规划）。
   */
  imagination?: {
    calibrationEma: number;
    plansSettled: number;
    skills: number;
    interpretation: string;
  };
  /**
   * 8.0：认知经济（元认知心智 KPI——思考的价格与价值核算）。
   *
   * 自由能度量预测世界的准确度，梦校准度量预测自己计划的准确度；
   * 认知经济度量**思考本身用得值不值**——习惯命中率（摊销节省）、
   * 搜索开销（nat 计价）、模式成功率（思考价值的实测）、元遗憾
   * （本不该省的思考）。三个 KPI 层层递进：世界→计划→心智自身。
   */
  cognitiveEconomy?: CognitiveEconomy;
  /**
   * 9.0：抽象统计（抽象心智 KPI——举一反三的实绩）。
   *
   * 认知经济度量思考用得值不值；抽象统计度量**经验是否跨域流动**：
   * 类比迁移次数、零样本应答（冷状态凭结构同构直接给出非无知
   * 估计）、后继结构继承、跨域宏技能数。KPI 第四层：世界→计划→
   * 心智→心智的泛化能力。
   */
  abstraction?: AbstractionStats;
  /**
   * 10.0：知识前沿（科学家心智 KPI——知识获取的经济学）。
   *
   * 抽象统计度量经验是否跨域流动；知识前沿度量**求知本身值不值**：
   * 因果问题的残差熵总量（知识版图的未知量）、混杂分歧数（唯有
   * 干预可裁决）、实验兑现率（承诺 EIG vs 实现信息增益——设计者
   * 诚实度的内生度量）。KPI 第五层：世界→计划→心智→泛化→求知。
   */
  knowledgeFrontier?: KnowledgeFrontier;
  /**
   * 11.0：理论前沿（理论心智 KPI——知识的压缩与体系化）。
   *
   * 知识前沿度量求知值不值；理论前沿度量**知识是否成体系**：
   * 在世定律数、被压缩的边数、累计省下的描述长度（理解即压缩，
   * nat 口径）、零样本预测次数（定律泛化）、范式转移次数
   * （定律被推翻重建——科学的自我修正力）。KPI 第六层：
   * 世界→计划→心智→泛化→求知→体系化。
   */
  theoryFrontier?: TheoryFrontier;
  /**
   * 12.0：KPI 保证层（任意时刻有效裁决——退化判定的数学背书）。
   *
   * z-score/连续计数是固定样本统计，反复读取会累积假阳性（偷看悖论）；
   * 保证层为关键 KPI 维护 e-过程证据流，以目标线为水位线：
   * 「KPI 真实水平低于目标」这一结论在**任意时刻**读取都有效
   * （e ≥ 1/α 才确证，否则诚实 undecided）——退化告警第一次
   * 免疫偷看，恢复确证同理。KPI 第七层：世界→计划→心智→泛化→
   * 求知→体系化→结论本身的可信度。
   */
  guarantees?: {
    streams: Array<{
      kpi: string;
      reference: number;
      verdict: AnytimeVerdict;
      /** 情节化当前状态：degraded = 确证退化中；recovered = 已确证恢复；undefined = 尚未确证过 */
      regime?: 'degraded' | 'recovered';
      eBelow: number;
      anytimeP: number;
      n: number;
      cs: {
        lower: number;
        upper: number;
      };
    }>;
    interpretation: string;
  };
  /**
   * 27.0：卡尔曼滤波层（挂载后输出）——KPI 的去噪读数（level）、
   * 缓慢漂移的早期读数（slope）与突变门控状态（NIS 假设检验）。
   */
  kalman?: {
    streams: Array<{
      kpi: string;
      level: number;
      slope: number;
      nis: number;
      threshold: number;
      gated: boolean;
    }>;
    interpretation: string;
  };
}
/** 元认知配置 */
interface MetaCognitionConfig {
  /** KPI 历史窗口大小 */
  windowSize: number;
  /** z-score 异常判定阈值 */
  zScoreThreshold: number;
  /** 成功率目标线（低于该值判定退化） */
  successRateTarget: number;
  /** 质量目标线 */
  qualityTarget: number;
  /** 连续低于目标线多少次触发调优 */
  degradeStreakThreshold: number;
  /** 单模型成功率低于该值标记降级 */
  modelHealthThreshold: number;
  /** 参数调整冷却期（毫秒，防止震荡） */
  tuningCooldownMs: number;
  /** 参数调整落地回调（由 index.ts 桥接到真实引擎） */
  applier?: (action: TuningAction) => void;
  /**
   * 读取当前真实质量阈值的回调（可选注入）。
   * 提供时 successRate 退化规则的 from/to 以当前实际阈值（而非成功率
   * 目标）为基线——「放宽」才名实相符；未提供时保持旧行为（零漂移）。
   */
  getQualityThreshold?: () => number;
}
/** 默认配置 */
declare const DEFAULT_META_COGNITION_CONFIG: MetaCognitionConfig;
/**
 * 元认知监控引擎
 *
 * 被 index.ts 持有：autonomy-loop 每轮心跳采集 KPI 快照并调用 observe()，
 * 引擎自动完成异常检测、参数调优与自愈洞察产出。
 */
declare class MetaCognitionEngine {
  private config;
  private history;
  private anomalies;
  private tuningHistory;
  /** 各 KPI 连续低于目标线的次数 */
  private degradeStreaks;
  private lastTuningAt;
  /** 5.0：因果内核（挂载后旋钮推荐按因果效应排序） */
  private causal?;
  /** 待结算的调参干预（动作 → 下一批 KPI 快照对账） */
  private pendingTuningInterventions;
  constructor(config?: Partial<MetaCognitionConfig>);
  /** 5.0：挂载因果内核（幂等） */
  attachCausalKernel(kernel: CausalKernel): void;
  /** 6.0：挂载自由能引擎（幂等；健康报告开始携带统一自由能 KPI） */
  attachFreeEnergyEngine(engine: FreeEnergyEngine): void;
  /** 7.0：挂载深思内核（梦校准 KPI 数据源；幂等） */
  attachDeliberationEngine(engine: DeliberationEngine): void;
  /** 8.0：挂载元推理内核（认知经济 KPI 数据源；幂等） */
  attachMetareasoner(reasoner: RationalMetareasoner): void;
  /** 9.0：挂载抽象内核（抽象统计 KPI 数据源；幂等） */
  attachAbstractionEngine(engine: AbstractionEngine): void;
  /** 10.0：挂载科学家内核（知识前沿 KPI 数据源；幂等） */
  attachScientistMind(mind: ScientistMind): void;
  /** 11.0：挂载理论内核（理论前沿 KPI 数据源；幂等） */
  attachTheoristEngine(engine: TheoristEngine): void;
  private freeEnergyEngine?;
  private theoristEngine?;
  private deliberationEngine?;
  private metareasoner?;
  private abstractionEngine?;
  private scientistMind?;
  /** 12.0：KPI 保证层（挂载后退化/恢复判定获得任意时刻有效背书） */
  private anytimeGuards?;
  /** 17.0：形状感知传输漂移监视（挂载后分布形状变化可见） */
  private transportDrift?;
  /** 17.0：各 KPI 的上次漂移态（翻转沿触发洞察） */
  private transportDriftState;
  /** 27.0：KPI 局部线性趋势滤波器（挂载后异常判定升级为 NIS 假设检验） */
  private kalmanFilters?;
  /** 38.0：KPI 动力学体质序列（attachChaosDiagnostics 后积累） */
  private chaosSeries?;
  /** 38.0：已确立的动力学体质（翻转沿洞察的去重状态） */
  private chaosRegimeState;
  /** 27.0：各 KPI 的上次门控态（翻转沿触发洞察） */
  private kalmanGateState;
  /** 12.0：保证层显著性水平（e ≥ 1/α 才确证） */
  private guardAlpha;
  /**
   * 12.0：KPI 情节化状态机（首次确证退化后启用）。
   *
   * 全历史 e-过程的资本是只涨难跌的累计证据——确证退化后，即使 KPI
   * 完全恢复，旧资本也会长期压住「已恢复」的事实（恢复不可检测）。
   * 状态机改以水位线两侧的**连续 run** 为情节：恢复通道只吃水位线上
   * 连续批次的证据（e-过程确证 H0: μ ≤ 水位线 被拒，或 CS 下界越过
   * 水位线）；再劣化通道对称。跨线即重置对侧通道（翻转沿语义，
   * 稳态不重复打扰）。
   *
   * 有效性口径（如实标注）：报警方向（首次确证）始终保持全历史
   * 任意时刻有效（Ville，偷看免疫）；情节化通道是「重启式监测」——
   * 每次重启都是合法的水平 α 检验，跨情节的选择效应不具全局有效性
   * （重启式监测的标准取舍：报警从严，全清从宽）。
   */
  private regimeWatches?;
  /** 新建一条情节通道（e-过程 + 置信序列） */
  private newGuardChannel;
  /**
   * 12.0：挂载 KPI 保证层（幂等）。
   *
   * 为 successRate / avgQuality 各建一条 e-过程证据流，水位线 =
   * 各自目标线。「低于目标」的告警从此自带数学保证：任意时刻、
   * 任意频率地读取都不夸大（偷看免疫）。
   */
  attachAnytimeGuards(options?: {
    alpha?: number;
  }): void;
  /**
   * 17.0：挂载形状感知传输漂移监视（幂等；缺省覆盖 avgQuality / avgLatency）。
   *
   * 12.0 保证层盯**均值水位**（μ 是否越过目标线），本层盯**分布形状**
   * （滑动窗 vs 基准窗的 Wasserstein-1）——均值不变而形状巨变
   * （双峰化 / 尾部变厚）的「换了世界」第一次可见；13.0 保形区间的
   * 覆盖保证在漂移下失效，本层是其绊线。阈值自适应（历史 W₁ 分位），
   * 不 attach 即零漂移。
   */
  attachTransportDrift(options?: Partial<{
    kpis: Array<'successRate' | 'avgQuality' | 'avgLatency' | 'cacheHitRate'>;
    windowSize: number;
    referenceSize: number;
    thresholdQuantile: number;
    minSamples: number;
  }>): void;
  /** 17.0：形状漂移检验（每批快照后调用；翻转沿产出洞察，稳态不重复打扰） */
  private checkTransportDrift;
  /** 17.0：各 KPI 的当前形状漂移视图（纯读取；未挂载返回 undefined） */
  transportDriftView(kpi: string): TransportDriftView | undefined;
  /**
   * 27.0：挂载 KPI 卡尔曼滤波层（幂等；缺省覆盖 successRate / avgQuality /
   * avgLatency / cacheHitRate）。
   *
   * 1 号 z-score 检查是窗口内无记忆比较；本层把整条历史压进 (level, slope)
   * 充分统计量——异常判定从启发式升级为 NIS 假设检验（新息平方和超出
   * χ²(1) 99.7% 分位才报警），缓慢漂移由滤波斜率给出早期读数。
   * 不 attach 即零漂移。
   */
  attachKalmanAnomaly(options?: Partial<TrendFilterConfig> & {
    kpis?: Array<'successRate' | 'avgQuality' | 'avgLatency' | 'cacheHitRate'>;
  }): void;
  /** 27.0：KPI 的当前滤波读数（纯读取；未挂载返回 undefined） */
  kalmanView(kpi: string): TrendStepRead | undefined;
  /**
   * 38.0：挂载动力学体质诊断（幂等覆盖，挂载即生效）。
   *
   * 每个 KPI 序列积累满 minPoints（缺省 96）后做体质分类：混沌
   * （λ₁ > 0，预测视野 ~1/λ₁ 步）、持续（H > 0.5+δ，趋势自我强化）、
   * 反持续（H < 0.5−δ，均值回归）、随机漫步（无结构）。体质确立的
   * 翻转沿产出洞察——**同一份 KPI，三种读法**：混沌序列上精细预测器
   * 的置信应随视野收窄、持续序列的趋势洞察加权、反持续序列的「突破」
   * 多半回归。未挂载零漂移。
   */
  attachChaosDiagnostics(options?: {
    kpis?: Array<'successRate' | 'avgQuality' | 'avgLatency' | 'cacheHitRate'>;
    minPoints?: number;
    lambdaThreshold?: number;
    hurstDelta?: number;
  }): void;
  private chaosMinPoints;
  private chaosOptions;
  /**
   * 49.0：挂载多尺度小波视图（幂等覆盖，挂载即生效——纯读数口径）。
   *
   * KPI 序列经 Haar 小波分解为对数个正交尺度：最粗趋势（长期水平）、
   * 中尺度细节（漂移带能量）、最细细节（瞬时突发）——单尺度异常检测
   * 看不见的「慢漂移 vs 快突发」结构分离。waveletView 给出各尺度能量
   * 落位；洞察消费留给上层（零漂移：仅新增读数）。
   */
  attachWaveletView(options?: {
    kpis?: Array<'successRate' | 'avgQuality' | 'avgLatency' | 'cacheHitRate'>;
    minPoints?: number;
  }): void;
  private waveletSeries?;
  private waveletMinPoints;
  /** 49.0：KPI 的多尺度读数（纯读取；未挂载/未满窗返回 undefined） */
  waveletView(kpi: string): {
    trendLevel: number;
    burstShare: number;
    dominantScale: string;
    driftShare: number;
  } | undefined;
  /** 49.0：序列喂入（observe 的 0.9 段调用；未挂载零开销） */
  private feedWavelet;
  /** 38.0：KPI 的动力学体质读数（纯读取；未挂载/未满窗返回 undefined） */
  chaosView(kpi: string): DynamicsAssessment | undefined;
  /** 38.0：体质分类（满窗后每批快照评估；翻转沿产出洞察） */
  private checkChaos;
  /** 27.0：NIS 门控检验（每批快照后调用；进入门控的翻转沿产出洞察） */
  private checkKalman;
  /**
   * 12.0：保证层检验（每批快照后调用）。
   *
   * 阶段一（未确证过）：全历史 e-过程裁决——e ≥ 1/α 才确证退化
   * （高严重度，证据携带 e-值与任意时刻 p-值），否则诚实不打扰。
   * 阶段二（确证过至少一次）：情节化状态机跟踪当前状态——恢复与
   * 再劣化都要求持续越过水位线的证据（e-确证或 CS 交叉），翻转沿
   * 产出洞察。
   */
  private checkGuarantee;
  /**
   * 5.0：因果旋钮排序 —— 哪个旋钮真正导致了目标 KPI 的改善。
   *
   * 质变点：旧版 tryTune 是「if KPI 退化 then 固定规则调某旋钮」——
   * 规则命中顺序即优先级，与旋钮真实效果无关。挂载因果内核后，
   * 旋钮推荐改按 do-干预效应下界 × 置信度排序：调过且被实验证实
   * 有效的旋钮优先，混杂严重（观测相关但实验无效）的旋钮沉底。
   *
   * @param targetKpi 退化中的 KPI（如 'successRate'）
   */
  rankTuningKnobs(targetKpi: string): CausalEffect[];
  /**
   * 5.0：调参干预对账 —— 上次调参后 KPI 是否真的改善。
   *
   * 在 observe() 每批快照后自动调用：基线 → 干预后首个快照的比较
   * 结果作为 do-干预的 observedY 写回因果图（黄金证据闭环：
   * 调参 = 干预，下批 KPI = 实验结果，图更新 = 学习）。
   */
  private settleTuningInterventions;
  /** 登记待对账的调参干预（内部：动作落地后基线快照） */
  private registerTuningIntervention;
  /**
   * 观察一次 KPI 快照（元认知主入口）
   * @returns 本轮产出的自愈洞察（交给目标引擎）
   */
  observe(snapshot: KpiSnapshot): Insight[];
  /** 最近一次健康报告 */
  getHealthReport(): HealthReport;
  /** 调优历史 */
  getTuningHistory(): TuningAction[];
  /** 异常历史 */
  getAnomalies(): KpiAnomaly[];
  /** KPI 历史（只读快照） */
  getHistory(): KpiSnapshot[];
  /** z-score 异常检测 */
  private detectAnomaly;
  /** 退化检测：连续低于目标线 → 参数自调优 + 自愈洞察 */
  private checkDegradation;
  /**
   * 参数自调优策略
   *
   * 5.0 质变：挂载因果内核后，旋钮选择按因果证据而非规则命中顺序——
   * 1. rankTuningKnobs(kpi) 查询已确立的正因果旋钮（实验证实调它有效），
   *    有效应下界最高者优先，动作携带 causalBasis；
   * 2. 无因果证据时回退既有规则（零行为漂移）；
   * 3. 每次落地动作登记为待对账干预：下批 KPI 快照 = 实验读数，
   *    成败自动写回因果图（元认知从「调参」升级为「做实验」）。
   */
  private tryTune;
  /** 模型健康度检查：单模型成功率过低 → 自愈洞察 */
  private checkModelHealth;
}
//#endregion
//#region src/core/evidence.d.ts
/**
 * evidence.ts — 统一证据内核（项目 3.0「全层证据统一 + 自知之明」基石）
 *
 * 项目级质升前的问题（勘察结论）：
 * - 时间衰减 / Wilson 下界 / Beta 后验只服务于模型画像（ModelTaskStats）一层；
 *   蒸馏策略、语义记忆、程序记忆仍用裸 confidence + 裸计数，检索排序裸置信度；
 * - 沙盒校准读裸 avgQualityScore / totalCalls，旧证据与漂移无法感知；
 * - 各层统计口径（confidence / posteriorMean / wilsonLower）混用互不可比。
 *
 * 本内核把同一套统计语言铺到所有记忆层：
 * - wilsonLowerBound：小样本保守的置信下界（排序与校准的统一度量）
 * - decayFactor：时间衰减（30 天半衰期，旧证据自然让位）
 * - MemoryEvidence：可持久化的时间加权 Beta 证据（ws/wf/lastDecayedAt）
 * - observeEvidence：写入式观测（惰性衰减 + 累积，读取零开销）
 * - readEvidence：读取式视图（纯函数衰减，不回写）
 * - evidenceRankScore：证据化排序分（confidence × Wilson 下界等权混合；
 *   无证据时回退裸 confidence，行为与升级前逐位一致——并行旁路设计）
 *
 * 兼容性：旧格式记忆无 evidence 字段 → 首次观测时从裸计数按 0.5 折价初始化
 * （与模型画像 legacy 回退语义一致），confidence 更新公式保持不变。
 */
/** Wilson 置信下界（纯函数，全部层共享的统一不确定性度量） */
declare function wilsonLowerBound(successes: number, failures: number, z?: number): number;
/** 证据时间衰减半衰期（天）——30 天前的证据权重折半 */
declare const DECAY_HALF_LIFE_DAYS = 30;
/** Beta 先验强度（均匀先验 Beta(1,1)） */
declare const BAYES_PRIOR_STRENGTH = 1;
/** 证据参与排序/校准的最小有效样本量（低于此值回退裸 confidence） */
declare const EVIDENCE_MIN_SAMPLES = 3;
/** 旧格式（无时间信息）证据折价系数 */
declare const LEGACY_EVIDENCE_DISCOUNT = 0.5;
/** 排序混合权重：confidence 与 Wilson 下界各占一半 */
declare const EVIDENCE_RANK_BLEND = 0.5;
/** 时间衰减因子：0.5 ^ (elapsedMs / halfLife），未来时间不放大 */
declare function decayFactor(elapsedMs: number, halfLifeDays?: number): number;
/**
 * 可持久化的时间加权 Beta 证据
 *
 * 挂载于 DistilledStrategy / SemanticMemory / ProceduralMemory 的可选字段
 * evidence（并行旁路：不改变宿主实体的 confidence 语义）。
 */
interface MemoryEvidence {
  /** 时间加权成功证据（半衰期 30 天惰性累积） */
  weightedSuccesses: number;
  /** 时间加权失败证据 */
  weightedFailures: number;
  /** 幂等衰减基准（上次证据衰减时间戳） */
  lastDecayedAt: number;
}
/** 从裸计数初始化证据（无时间信息 → 0.5 折价，与模型画像 legacy 回退一致） */
declare function initEvidence(successes: number, total: number, at: number): MemoryEvidence;
/** 写入式观测：先惰性衰减到 now，再计入新证据（原地更新，读取零开销） */
declare function observeEvidence(evidence: MemoryEvidence, success: boolean, now: number): void;
/** 证据读取视图（Beta 后验 + Wilson 下界 + 有效样本量） */
interface EvidenceView {
  weightedSuccesses: number;
  weightedFailures: number;
  effectiveSamples: number;
  posteriorMean: number;
  wilsonLower: number;
}
/** 读取式视图：纯函数衰减（不回写），供排序/报告/沙盒校准消费 */
declare function readEvidence(evidence: MemoryEvidence, now: number): EvidenceView;
/**
 * 证据化排序分：confidence 与 Wilson 下界等权混合
 *
 * 质变：0.95 置信度但仅 3 次应用（下界 ≈ 0.44）的记忆，排序分 ≈ 0.70；
 * 0.85 置信度且 50 次应用 48 成（下界 ≈ 0.79）的记忆，排序分 ≈ 0.82——
 * 小样本高置信不再压过大样本稳置信。
 *
 * 兼容：无证据或有效样本 < EVIDENCE_MIN_SAMPLES → 原样返回 confidence
 * （与升级前排序行为逐位一致，既有消费方零感知）。
 */
declare function evidenceRankScore(confidence: number, evidence: MemoryEvidence | undefined, now: number): number;
//#endregion
//#region src/core/quality-diversity.d.ts
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
/** MAP-Elites 归档配置 */
interface MapElitesConfig<T> {
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
interface PlacementOutcome<T> {
  /** 候选者是否成为所在 niche 的新精英 */
  becameElite: boolean;
  /** 被替换下台的前任精英（首次占据时为 undefined） */
  displaced?: T;
  /** 候选者所在 niche 键（逗号连接的网格坐标） */
  niche: string;
}
/** 质量-多样性指标 */
interface QualityDiversityMetrics {
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
interface ArchiveReport<T> {
  metrics: QualityDiversityMetrics;
  /** 各 niche 现任精英（按适应度降序） */
  elites: Array<{
    niche: string;
    fitness: number;
    candidate: T;
  }>;
}
/**
 * MAP-Elites 归档（泛型网格精英制）
 *
 * place() 准入规则：候选者落入唯一 niche；适应度严格高于现任
 * （或 niche 空缺）即上位。O(1) 放置、O(k) 指标计算（k = 占据数）。
 * 跨 niche 永不比较——多样性的保护是结构性的，不依赖任何阈值。
 */
declare class MapElitesArchive<T> {
  private readonly config;
  private readonly elites;
  private placements;
  private promotions;
  private rng;
  constructor(config: MapElitesConfig<T>);
  /** 总 niche 数 */
  get totalNiches(): number;
  /** 被占据 niche 数 */
  get occupiedNiches(): number;
  /** 候选者 → niche 键（网格坐标），越界坐标饱和到边界格 */
  nicheOf(candidate: T): string;
  /**
   * 放置候选者：在其 niche 内挑战现任精英。
   * 适应度严格超过现任（容差内持平算挑战失败——先到先得，防抖动）
   * 或 niche 空缺时上位。
   */
  place(candidate: T): PlacementOutcome<T>;
  /** 从被占据 niche 均匀采样一位精英（前沿探索；空归档返回 undefined） */
  sample(): T | undefined;
  /** 全局最优精英（适应度最高；空归档返回 undefined） */
  best(): T | undefined;
  /** 全部现任精英（候选者列表；按 niche 键序） */
  eliteCandidates(): T[];
  /** QD 指标 */
  metrics(): QualityDiversityMetrics;
  /** 归档报告 */
  report(): ArchiveReport<T>;
}
/** 策略基因结构（与 strategy-evolution.StrategyGenes 结构兼容，避免循环依赖） */
interface StrategyGenesLike {
  suppressionWindowMs: number;
  failureEscalationThreshold: number;
  lowConfidenceThreshold: number;
  costDeferRatio: number;
  burstOccurrences: number;
}
/** 策略行为空间维度 */
type StrategyBehaviorDim = 'boldness' | 'frugality' | 'vigilance';
/** 策略行为空间（三维，均归一到 [0,1]） */
declare const STRATEGY_BEHAVIOR_SPACE: {
  dims: StrategyBehaviorDim[];
  ranges: Array<[number, number]>;
  defaultBins: number[];
};
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
declare function strategyBehaviorDescriptor(genes: StrategyGenesLike): number[];
//#endregion
//#region src/core/information-geometry.d.ts
/**
 * information-geometry.ts — 信息几何内核（项目 18.0「进化在流形上行走」质变基座）
 *
 * 升级前的根本局限（坐标空间变异的几何盲区）：
 * - 高斯变异在**原始坐标轴**上独立加噪——步长正比于各基因的取值
 *   范围，本质是把「坐标怎么标」当成了「空间怎么弯」：把某个基因
 *   的单位从秒改成毫秒，同样的变异在物理上走 1000 倍远——进化的
 *   行为被坐标系绑架（参数化依赖）；
 * - 基因间的**相关结构**完全不可见：lowConfidenceThreshold 与
 *   costDeferRatio 在历史上可能总是同向移动（一个隐性组合在起作用），
 *   独立加噪把每次变异都强行拆散——有利的基因组合永远无法被
 *   一次变异完整传递；
 * - 步长没有信息单位：变异走多远用「参数距离」度量，而参数距离
 *   在重参数化下不守恒——「这次变异改变策略分布多少信息」才是
 *   不变量，坐标系无权过问。
 *
 * 本内核引入信息几何（Amari 自然梯度 / Fisher 信息度量；
 * Kakade 2001 自然梯度 RL；Schulman 2015 TRPO 信任域）：
 *
 * 1. **Fisher 信息度量**：搜索分布 N(θ, Σ) 的均值参数上，
 *      F = Σ⁻¹
 *    概率分布族构成黎曼流形，Fisher 度量给出其上真实的「距离」——
 *    两个策略参数点的距离不是欧氏范数，而是
 *      ‖δ‖_F = √(δᵀ Σ⁻¹ δ)（Mahalanobis 范数）
 *
 * 2. **不变性（本内核的数学心脏）**：种群协方差在仿射重参数化
 *    y = Ax 下协变（Σ_y = AΣAᵀ），故 Mahalanobis 距离严格不变：
 *      δ_yᵀ Σ_y⁻¹ δ_y = δ_xᵀ Σ_x⁻¹ δ_x
 *    单位换算、量纲缩放、坐标旋转——几何不变量纹丝不动。
 *    变异第一次拥有了与坐标系无关的「真实步长」。
 *
 * 3. **自然变异（协方差白化采样）**：ε ~ N(0, I)，子代 =
 *      parent + σ · L ε，L = Cholesky(Σ̂)
 *    变异方向沿种群历史方差的主轴展开——显性组合方向自动获得
 *    更大步幅（有利的基因组合被完整传递），垂直方向自动收紧；
 *    等价于在 Fisher 流形上沿测地方向迈步（自然梯度的采样版）。
 *
 * 4. **KL 信任域（步长以 nat 计价）**：同协方差高斯的
 *      KL(N(θ) ‖ N(θ+δ)) = ½ δᵀ Σ⁻¹ δ
 *    步长用信息单位（nat）度量：Mahalanobis 距离超界即整体缩放
 *    回信任域——单次进化对策略分布的最大信息改动被数学封顶，
 *    「大步翻车」与「小步原地」都不再取决于坐标系标定。
 *
 * 5. **协方差收缩（Ledoit–Wolf 式）**：小种群（个位数）的样本
 *    协方差病态；Σ̂ = (1−λ)S + λ·(tr S / d)·I 以种群规模定 λ，
 *    良态保证 Cholesky 可分解；条件数 / 有效维数（参与比）随报告
 *    输出——搜索几何本身成为可观测对象。
 *
 * 与 8.0 的关系：8.0 元推理把「思考」按 nat 计价，本内核把「进化」
 * 按 nat 计价——认知经济学的两种支出（推理与变异）统一信息单位；
 * 与 14.0 的关系：14.0 在**行为空间**（结果维度）保流派不灭，本内核
 * 在**参数流形**（策略维度）让搜索沿几何走——结果空间的多样性与
 * 参数空间的几何是两层互补的正交保护；与 16.0 的关系：Shapley 的
 * 协同检测找出 1+1>2 的玩家对，本内核的协方差主轴找出总是同向
 * 移动的基因组合——归因在智能体层，几何在基因层。
 */
/** 信息几何配置 */
interface InformationGeometryConfig {
  /** KL 信任域半径 δ_max（Mahalanobis 上限；缺省 1.2 ≈ 单步 ≤ 0.72 nat） */
  klBudget: number;
  /** 基础变异尺度 σ（信任域内的高斯步幅；缺省 0.5） */
  stepScale: number;
  /** 收缩强度覆盖（缺省按种群规模自适应：λ = 2/(n+2)，n = 种群数） */
  shrinkageIntensity?: number;
  /** 最大维度（超出拒绝估计；缺省 32） */
  maxDimension: number;
  /** 随机数源（缺省 Math.random） */
  rng?: () => number;
}
declare const DEFAULT_INFORMATION_GEOMETRY_CONFIG: InformationGeometryConfig;
/** 自然变异结果 */
interface NaturalMutationResult {
  /** 变异后的点（归一化空间） */
  child: number[];
  /** Mahalanobis 步长 ‖δ‖_F（信任域口径；坐标不变量） */
  mahalanobis: number;
  /** KL 步长（nat）= mahalanobis² / 2 */
  klStep: number;
  /** 是否触发信任域缩放（步长超界被整体收缩） */
  trustRegionClipped: boolean;
}
/** 几何诊断报告 */
interface InformationGeometryReport {
  /** 估计样本数（种群规模口径） */
  samples: number;
  /** 维度 */
  dimension: number;
  /** 收缩强度 λ（0 = 纯样本协方差，1 = 各向同性） */
  shrinkage: number;
  /** 条件数 κ(Σ̂)（大 = 主轴悬殊；∞ 防护 = 奇异） */
  conditionNumber: number;
  /** 有效维数（参与比 (tr Σ)²/tr Σ² ∈ [1, d]；小 = 搜索低维流形） */
  effectiveDimension: number;
  /** 平均步长（最近变异的 Mahalanobis 均值；无样本 = 0） */
  meanStep: number;
  /** 信任域触发率（最近变异中缩放占比） */
  trustRegionRate: number;
  interpretation: string;
}
/**
 * 收缩协方差估计：Σ̂ = (1−λ)·S + λ·(tr S / d)·I。
 *
 * λ 缺省 = 2/(n+2)（贝叶斯收缩的经典口径：n 个样本时各向同性先验
 * 占 2/(n+2)——种群越小收缩越强，Cholesky 良态有保证）。
 */
declare function shrinkageCovariance(points: readonly (readonly number[])[], intensity?: number): number[][];
/** Cholesky 分解（下三角；非正定时加抖动重试，仍失败返回 undefined） */
declare function cholesky(matrix: readonly (readonly number[])[]): number[][] | undefined;
/** 条件数 κ = λ_max / λ_min（幂迭代 + 逆幂迭代近似；奇异返回 Infinity） */
declare function conditionNumber(matrix: readonly (readonly number[])[]): number;
/** 参与比（有效维数）：(tr Σ)² / tr(Σ²) ∈ [1, d] */
declare function participationRatio(matrix: readonly (readonly number[])[]): number;
/**
 * Fisher 几何引擎：估计种群几何 + 自然变异 + 诊断
 *
 * 用法：
 *   const geo = new FisherGeometryEngine({ klBudget: 1.2 });
 *   geo.estimate(populationPoints);          // 归一化参数点（[0,1]^d）
 *   const { child } = geo.naturalMutate(parentPoint);  // 沿流形测地方向变异
 *   geo.report();                            // 条件数 / 有效维数 / 步长审计
 *
 * 所有点在**归一化空间**（各维 [0,1]）进出——坐标不变量保证这些
 * 数值与外部标定无关。
 */
declare class FisherGeometryEngine {
  private readonly config;
  private readonly rng;
  private dimension;
  private samples;
  private shrinkageUsed;
  private covariance;
  private choleskyFactor?;
  /** 最近变异步长审计（信任域触发率 / 均值口径） */
  private recentSteps;
  constructor(config?: Partial<InformationGeometryConfig>);
  /**
   * 估计种群几何（归一化点集 → 收缩协方差 + Cholesky）。
   *
   * 点集通常为当前种群全部个体（含精英）；样本 ≤ 1 时几何退化为
   * 各向同性（自然变异回退坐标无关的等幅噪声）。
   */
  estimate(points: readonly (readonly number[])[]): boolean;
  /**
   * 自然变异：ε ~ N(0,I) 沿 Cholesky 主轴展开，KL 信任域封顶。
   *
   * 未估计几何（estimate 未调用 / 失败）时回退各向同性小步——
   * 调用方无需关心几何是否可用（优雅降级，零漂移）。
   */
  naturalMutate(parent: readonly number[], scale?: number): NaturalMutationResult;
  /** 几何诊断报告 */
  report(): InformationGeometryReport;
}
//#endregion
//#region src/strategy-evolution.d.ts
/** 基因组基因（决策引擎可调超参数子集） */
interface StrategyGenes {
  suppressionWindowMs: number;
  failureEscalationThreshold: number;
  lowConfidenceThreshold: number;
  costDeferRatio: number;
  burstOccurrences: number;
}
/** 策略基因组 */
interface StrategyGenome {
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
interface EvolutionReport {
  generation: number;
  elites: string[];
  born: string[];
  eliminated: string[];
  bestMeanReward: number;
  populationMeanReward: number;
}
/** 策略进化配置 */
interface StrategyEvolutionConfig {
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
declare const DEFAULT_STRATEGY_EVOLUTION_CONFIG: StrategyEvolutionConfig;
/** 种群报告（运维可观测） */
interface EvolutionStatusReport {
  generation: number;
  populationSize: number;
  applicationsSinceEvolution: number;
  populationMeanReward: number;
  genomes: Array<{
    id: string;
    generation: number;
    applications: number;
    meanReward: number;
    genes: StrategyGenes;
  }>;
  bestGenome: string;
  recentEvolutions: EvolutionReport[];
  /** 14.0：质量-多样性指标（attachQualityDiversity 后输出） */
  qd?: QualityDiversityMetrics;
  /** 12.0：任意时刻证据报告（attachAnytimeEvidence 后输出） */
  anytime?: AnytimeEvidenceRegistryReport;
  /** 18.0：搜索几何报告（attachInformationGeometry 后输出） */
  geometry?: InformationGeometryReport;
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
declare class StrategyEvolutionEngine {
  private config;
  private population;
  private genomeCounter;
  private generation;
  private applicationsSinceEvolution;
  private evolutionHistory;
  private rng;
  /** 12.0：任意时刻证据登记表（attach 后启用） */
  private anytime?;
  /** 12.0：已淘汰基因组的 e-值台账（审计） */
  private anytimeEliminations;
  /** 14.0：MAP-Elites 行为归档（attach 后启用） */
  private qdArchive?;
  /** 14.0：前沿 niche 采样概率（探索预算占比） */
  private qdExploreRate;
  /** 18.0：Fisher 几何引擎（attach 后变异沿搜索流形测地方向） */
  private geometry?;
  constructor(config?: Partial<StrategyEvolutionConfig>);
  /**
   * 12.0：挂载任意时刻证据内核（幂等；挂载后适应度用置信序列下界，
   * recordOutcome 的收益同时喂入该基因组的 e-过程）。
   */
  attachAnytimeEvidence(options?: {
    alpha?: number;
    reference?: number;
  }): void;
  /**
   * 14.0：挂载质量-多样性内核（幂等；挂载后 selectGenome 以
   * qdExploreRate 概率从行为归档均匀采样探索，evolve 同步维护归档）。
   */
  attachQualityDiversity(options?: {
    bins?: number[];
    exploreRate?: number;
    rng?: () => number;
  }): void;
  /**
   * 18.0：挂载信息几何内核（幂等；挂载后变异从坐标轴加噪升级为
   * Fisher 流形上的自然变异）。
   *
   * 变异路径变化：种群归一化协方差（Ledoit–Wolf 收缩）→ Cholesky
   * 主轴展开的**联合相关**变异（显性基因组合完整传递；各向同性
   * 加噪被结构性替代）→ KL 信任域（Mahalanobis 半径）封顶单步
   * 信息量——步长以 nat 计价，仿射重参数化下严格不变。
   * 几何每代进化前从当前种群重估。不 attach 即零漂移（原高斯路径）。
   */
  attachInformationGeometry(options?: {
    klBudget?: number;
    stepScale?: number;
    rng?: () => number;
  }): void;
  /** 18.0：从当前种群重估搜索几何（归一化 [0,1]^d 参数空间） */
  private estimateGeometry;
  /** 18.0：几何诊断报告（未挂载返回 undefined） */
  geometryReport(): InformationGeometryReport | undefined;
  /**
   * UCB1 选择当前基因组（探索-利用平衡；4.0 利用项 = 证据化适应度）
   *
   * 利用项与适应度同源（Wilson 下界 × 置信折扣），探索项保持 UCB1
   * 对数置信宽度——探索与利用在同一证据口径下平衡。
   * @returns 选中的基因组
   */
  selectGenome(): StrategyGenome;
  /**
   * 回写决策结果（适应度反馈）
   * @param genomeId 基因组 id
   * @param outcome 决策执行后的实际结果
   */
  recordOutcome(genomeId: string, outcome: string): void;
  /**
   * 触发一轮进化（精英保留 + 锦标赛选择 + 高斯变异）
   * @param force 强制进化（忽略最小应用次数门槛）
   * @returns 进化报告；未达门槛时返回 null
   */
  evolve(force?: boolean): EvolutionReport | null;
  /** 最优基因组（应用次数达标者中平均收益最高） */
  bestGenome(): StrategyGenome;
  /** 最优基因组 → 决策引擎配置片段（进化产物落地） */
  bestGenesAsConfig(): Partial<DecisionEngineConfig>;
  /** 种群报告 */
  getReport(): EvolutionStatusReport;
  /** 进化历史 */
  getEvolutionHistory(): EvolutionReport[];
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
  pruneProvablyDominated(fdr?: number): Array<{
    id: string;
    eValue: number;
    at: number;
  }>;
  /** 12.0：任意时刻证据报告（含历史淘汰台账） */
  anytimeReport(): AnytimeEvidenceRegistryReport & {
    eliminations: Array<{
      id: string;
      eValue: number;
      at: number;
    }>;
  };
  /** 12.0：指定基因组的当前证据视图（未挂载或未观测返回 undefined） */
  anytimeViewOf(genomeId: string): AnytimeEvidenceView | undefined;
  /** 14.0：QD 指标（未挂载返回 undefined） */
  qdMetrics(): QualityDiversityMetrics | undefined;
  /** 初始种群：基准基因组 + 扰动变体 */
  private seedPopulation;
  /** 创建新基因组 */
  private createGenome;
  /**
   * 适应度（4.0 证据化 → 12.0 任意时刻有效化）
   *
   * 挂载任意时刻内核且流样本 ≥ 3：置信序列下界 × 折扣（时间一致
   * 覆盖——连续监控下读适应度永不夸大）；否则回退 Wilson 下界
   * （4.0 口径，固定样本语义）；无证据回退 meanReward × 折扣。
   */
  private fitness;
  /** 锦标赛选择（3 选 1） */
  private tournamentSelect;
  /**
   * 变异产生后代
   *
   * 18.0 挂载后：Fisher 流形上的自然变异（种群协方差主轴展开的
   * 联合相关步 + KL 信任域封顶——步长以 nat 计价，坐标不变）；
   * 未挂载：原各基因独立近似高斯变异（坐标空间，零漂移回退）。
   */
  private mutate;
  /** 种群平均收益 */
  private populationMeanReward;
}
//#endregion
//#region src/policy/policy-types.d.ts
/**
 * policy-types.ts — 第三阶段「策略进化」核心数据结构与共享评分函数
 *
 * 设计要点：
 * - 策略空间：模型评分函数权重 + 任务分解规则 + 模型组合逻辑（10 个可进化基因）
 * - 基准策略参数严格复刻 ModelScheduler 原固定值 → 未部署进化策略时行为与
 *   第二阶段完全一致（向后兼容验收点）
 * - 评分函数提取为纯函数 scoreModelWithPolicy：操作环（ModelScheduler）与
 *   沙盒（Sandbox）共用同一实现，保证沙盒评估对真实调度行为的保真度
 * - 全部结构可直接 JSON 序列化（Policy 即持久化格式）
 */
/** 规则匹配上下文（任务调度现场装配；沙盒评估提供完整上下文） */
interface PolicyMatchContext {
  taskType: string;
  complexity?: number;
  features?: string[];
}
/**
 * 条件-动作规则（规则基因组，质级升级）
 *
 * 超越全局标量权重的上下文敏感调度单元：满足条件时对有效参数施加
 * 增量调整（成本/记忆权重偏移）或直接覆盖分解/集成开关。
 * 规则按 priority 升序依次叠加；可变长度（0~MAX_POLICY_RULES 条），
 * 支持增加/删除/修改三类变异与双亲子集交叉。
 */
interface PolicyRule {
  id: string;
  /** 匹配条件（空字段 = 不限制） */
  when: {
    /** 匹配这些任务类型之一（空 = 任意类型） */
    taskTypes?: string[];
    /** 最小复杂度（缺省 0） */
    minComplexity?: number;
    /** 最大复杂度（缺省 1） */
    maxComplexity?: number;
    /** 含有任一特征标签即匹配（空 = 任意特征） */
    features?: string[];
  };
  /** 匹配时的动作 */
  action: {
    /** 成本权重增量（钳制后仍在基因边界内） */
    costWeightDelta?: number;
    /** 记忆基础权重增量 */
    memoryWeightBaseDelta?: number;
    /** 覆盖集成开关（undefined = 不覆盖） */
    ensembleForce?: boolean;
    /** 覆盖分解开关（undefined = 不覆盖） */
    decomposeForce?: boolean;
  };
  /** 应用顺序（小者优先） */
  priority: number;
}
/** 单策略最大规则数（防规则爆炸） */
declare const MAX_POLICY_RULES = 4;
/** 规则增量幅度边界 */
declare const POLICY_RULE_DELTA_BOUNDS: {
  min: number;
  max: number;
};
/**
 * 调度策略参数（策略基因）
 *
 * 两层基因组：
 * 1. 全局标量基因：评分权重 + 分解阈值 + 集成参数（10 个）
 * 2. 规则基因（rules）：上下文敏感的条件-动作覆盖层（可变长度）
 */
interface SchedulerPolicyParams {
  /** 成本感知权重 0~1（0=纯质量导向，1=纯成本导向） */
  costWeight: number;
  /** 记忆画像基础权重（有历史数据时的起始信任度） */
  memoryWeightBase: number;
  /** 记忆画像权重随历史调用量 的增长率 */
  memoryWeightGrowth: number;
  /** 记忆画像权重上限 */
  memoryWeightCap: number;
  /** 是否启用任务分解 */
  decomposeEnabled: boolean;
  /** 触发分解的任务复杂度阈值 */
  decomposeComplexityThreshold: number;
  /** 分解出的最大子任务数 */
  decomposeMaxSubtasks: number;
  /** 是否启用多模型集成（最高分与次高分差距小于 gap 时并行执行取融合） */
  ensembleEnabled: boolean;
  /** 触发集成的分数差阈值 */
  ensembleScoreGap: number;
  /** 集成的最大模型数 */
  ensembleMaxModels: number;
  rules?: PolicyRule[];
}
/** 策略适应度记录（沙盒评估产出，随策略持久化） */
interface PolicyFitness {
  /** 沙盒综合收益 reward（0~1） */
  score: number;
  successRate: number;
  avgQuality: number;
  avgLatencyMs: number;
  totalTokens: number;
  /** 评估任务数 */
  evaluatedTasks: number;
  evaluatedAt: number;
}
/**
 * 策略（序列化格式）
 *
 * 可追溯性：id 唯一、version 随部署谱系单调递增、generation 记录进化代际、
 * parentId 指向父代策略（交叉时另有 secondaryParentId 双亲）、origin 标记
 * 来源、fitness 携带最近评估表现数据。
 */
interface Policy {
  id: string;
  /** 版本（部署谱系单调递增；候选变体基于当前版本 +1 竞争下一版本槽位） */
  version: number;
  /** 策略类型（当前仅调度策略；预留扩展） */
  type: 'scheduler';
  params: SchedulerPolicyParams;
  /** 来源：baseline 基准 / mutation 变异 / crossover 交叉 / explorer 边界内随机探索 / manual 人工注入 */
  origin: 'baseline' | 'mutation' | 'crossover' | 'explorer' | 'manual';
  /** 进化代际（每轮进化周期 +1） */
  generation: number;
  /** 父代策略 id（可追溯进化链） */
  parentId?: string;
  /** 交叉第二亲代 id（仅 origin=crossover） */
  secondaryParentId?: string;
  /** 适应度（评估后回填） */
  fitness?: PolicyFitness;
  createdAt: number;
  /** 部署时间（未部署为空） */
  deployedAt?: number;
}
/** 沙盒任务（历史回放 / 对抗合成） */
interface SandboxTask {
  taskType: string;
  /** 复杂度 0~1 */
  complexity: number;
  /** 特征标签 */
  features: string[];
  /** 任务文本长度（影响 token 成本模拟） */
  length: number;
  /** 来源：replay 历史回放 / adversarial 对抗合成 */
  source: 'replay' | 'adversarial';
  /** 可读标签（评估报告与调试用） */
  label?: string;
}
/** 沙盒内模拟模型状态（从 LLMClient 运行时状态映射，离线快照） */
interface SimModelStatus {
  id: string;
  /** 能力画像（任务类型 → 适配分 0~1） */
  taskScores: Record<string, number>;
  /** 平均延迟（毫秒） */
  avgLatencyMs: number;
  /** 平均 token 消耗 */
  avgTokens: number;
  maxConcurrency: number;
}
/** 策略评估聚合指标 */
interface PolicyEvaluationMetrics {
  successRate: number;
  avgQuality: number;
  avgLatencyMs: number;
  totalTokens: number;
  /** 分解率（被分解的任务占比） */
  decompositionRate: number;
  /** 集成率（触发多模型集成的任务占比） */
  ensembleRate: number;
}
/**
 * 沙盒评估报告
 *
 * 收益（reward/gain）、风险（risks：参数越界/模拟异常/未知模型）、
 * 回归（regressions：相对 baseline 的成功率/质量/成本退化）三类信息
 * 共同决定 deployable（部署门禁）。
 */
interface EvaluationReport {
  policyId: string;
  baselinePolicyId?: string;
  metrics: PolicyEvaluationMetrics;
  baselineMetrics?: PolicyEvaluationMetrics;
  /** 综合收益 0~1（多种子均值） */
  reward: number;
  baselineReward?: number;
  /** 相对 baseline 的收益提升（多种子均值） */
  gain: number;
  /** 多种子 gain 标准差（0 = 单种子或完全稳定） */
  gainStdDev?: number;
  /** 收益置信下界 gain − 1.96·σ/√n（部署门禁用，防单种子过拟合） */
  gainLCB?: number;
  /** 评估种子数 */
  seeds?: number;
  /** 安全风险（非空 → 不可部署） */
  risks: string[];
  /** 回归项（非空 → 不可部署） */
  regressions: string[];
  /** 部署门禁结论 */
  deployable: boolean;
  taskStats: {
    replayed: number;
    adversarial: number;
  };
  evaluatedAt: number;
}
/** 标量基因键（数值 + 布尔；规则基因为独立可变长度维度） */
type ScalarGeneKey = Exclude<keyof SchedulerPolicyParams, 'rules'>;
/** 基因取值边界（变异钳制 + 部署前校验共用） */
declare const POLICY_GENE_BOUNDS: Record<ScalarGeneKey, {
  min: number;
  max: number;
  integer?: boolean;
}>;
/**
 * 基准策略参数 — 严格复刻 ModelScheduler 第二阶段固定值：
 * costWeight=0.2（index.ts 构造注入）、memoryWeight = min(0.6, 0.2 + n×0.02)、
 * 分解与集成缺省关闭（第二阶段无此行为）。
 */
declare const BASELINE_POLICY_PARAMS: SchedulerPolicyParams;
/** 单条规则是否匹配上下文（空条件字段 = 不限制） */
declare function policyRuleMatches(rule: PolicyRule, ctx: PolicyMatchContext): boolean;
/**
 * 上下文有效参数解析（规则基因组核心）
 *
 * 以基础标量基因为底，按 priority 升序叠加所有匹配规则的增量与开关覆盖，
 * 结果再经边界钳制 → 任意上下文下的有效参数恒在基因边界内（安全不变量）。
 * rules 为空或无匹配时与基础参数完全一致（向后兼容）。
 */
declare function resolveEffectiveParams(params: SchedulerPolicyParams, ctx: PolicyMatchContext): SchedulerPolicyParams;
/**
 * 参数规范化：越界值钳制到边界 + 缺失字段补基准值 + 规则清洗
 * （沙盒风险检查与部署热切换前的防御性归一，共用一份逻辑）
 */
declare function normalizePolicyParams(params: Partial<SchedulerPolicyParams>): SchedulerPolicyParams;
/** 参数是否全部在边界内（不修改原值的风险检查；含规则数量与增量幅度） */
declare function policyParamsWithinBounds(params: SchedulerPolicyParams): boolean;
/** 单模型评分输入（由调用方从运行时状态或沙盒快照装配） */
interface ModelScoreInput {
  /** 能力画像分（taskScores[taskType] ?? general ?? 0.5） */
  taskScore: number;
  /** 记忆画像成功率（无历史 0.5） */
  memoryScore: number;
  /** 该模型在该任务类型的历史调用量 */
  memoryCalls: number;
  /** 历史平均质量分（无历史 0.5） */
  avgQuality: number;
  /** 平均 token 消耗 */
  avgTokens: number;
}
/**
 * 策略化模型评分（操作环与沙盒共用）
 *
 * 公式（与 ModelScheduler 第二阶段实现同构，参数从策略注入）：
 *   memoryWeight = calls > 0 ? min(cap, base + calls × growth) : 0
 *   qualityScore = taskScore × (1-memoryWeight) + memoryScore × memoryWeight
 *   costEfficiency = clamp(avgQuality × (1 - min(1, avgTokens/10000)))
 *   score = qualityScore × (1-costWeight) + costEfficiency × costWeight
 *
 * 当 params = BASELINE_POLICY_PARAMS 时与原固定实现逐位一致。
 */
declare function scoreModelWithPolicy(params: SchedulerPolicyParams, input: ModelScoreInput): number;
/** 构造基准策略对象（缺省当前策略） */
declare function createBaselinePolicy(id?: string, version?: number): Policy;
//#endregion
//#region src/security/crypto-engine.d.ts
/**
 * crypto-engine.ts — 加密引擎（基础层，无内部依赖）
 *
 * 职责：
 * - 记忆库文件的整体加密 / 解密（fullFileEncryption）
 * - 敏感字段（如 apiKey）的字段级加密 / 解密
 * - 密钥轮换（rotateKey）与多版本密钥链管理
 * - 原子化落盘，避免写入中途崩溃导致记忆库损坏
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 主密钥经 scrypt KDF 派生为 32 字节工作密钥，避免弱口令直接作密钥
 * 2. 密钥链（keychain）支持多版本密钥并存，轮换后历史数据仍可解密
 * 3. 原子写入（tmp + rename），杜绝半写状态的记忆文件
 * 4. 密钥指纹使用 timingSafeEqual 比较，防时序侧信道
 * 5. 敏感字段深度递归扫描，支持任意嵌套层级
 */
/** 加密引擎配置 */
interface EncryptionConfig {
  /** 是否启用加密（关闭时 writeEncrypted 落明文 JSON） */
  enabled: boolean;
  /** 主密钥（任意字符串，内部经 scrypt 派生为工作密钥） */
  masterKey: string;
  /** 加密算法 */
  algorithm: 'aes-256-gcm' | 'aes-256-cbc';
  /** 需要字段级加密的字段名列表（递归匹配任意嵌套层级） */
  sensitiveFields: string[];
  /** 是否对整个文件加密（false 时仅加密敏感字段） */
  fullFileEncryption: boolean;
  /** 已轮换的历史主密钥（旧版本，用于解密历史数据） */
  rotatedKeys?: string[];
}
/** 字段级加密产物 */
interface EncryptedField {
  __encrypted: true;
  algorithm: string;
  iv: string;
  tag?: string;
  ciphertext: string;
  keyVersion: number;
}
/** 整文件加密产物 */
interface EncryptedFile {
  __encrypted_file: true;
  version: number;
  algorithm: string;
  iv: string;
  tag?: string;
  ciphertext: string;
  keyVersion: number;
  createdAt: number;
}
/** 加密操作结果 */
interface CryptoResult {
  success: boolean;
  error?: string;
  fieldsEncrypted?: number;
  fieldsDecrypted?: number;
  fileEncrypted?: boolean;
  fileDecrypted?: boolean;
  keyRotated?: boolean;
}
/**
 * 加密引擎
 *
 * 提供文件级与字段级两种加密粒度，以及密钥轮换能力。
 * 被 LongTermMemory（持久化加密）、DistributedSync（同步载荷加密）、
 * BenchmarkEngine（报告加密）依赖。
 */
declare class CryptoEngine {
  private config;
  /** 密钥链：index 0 对应 keyVersion 1，依次递增 */
  private keychain;
  constructor(config: EncryptionConfig);
  /**
   * 加密整段内容为 EncryptedFile 结构
   * @param content 明文字符串（通常是 JSON.stringify 的结果）
   */
  encryptFile(content: string): EncryptedFile;
  /**
   * 解密 EncryptedFile 结构，还原明文
   * @param file 加密文件结构
   * @throws CryptoError 密钥缺失或认证标签校验失败
   */
  decryptFile(file: EncryptedFile): string;
  /**
   * 递归加密对象中的敏感字段
   * @param obj 任意对象（不会被原地修改，返回深拷贝）
   * @returns 加密后的对象与被加密字段数
   */
  encryptSensitiveFields(obj: any): {
    result: any;
    encryptedCount: number;
  };
  /**
   * 递归解密对象中所有 EncryptedField 结构
   * @param obj 含加密字段的对象（不会被原地修改，返回深拷贝）
   * @returns 解密后的对象与被解密字段数
   */
  decryptSensitiveFields(obj: any): {
    result: any;
    decryptedCount: number;
  };
  /**
   * 将数据加密后写入文件（原子写入）
   *
   * 行为矩阵：
   * - enabled && fullFileEncryption  → 整文件加密
   * - enabled && !fullFileEncryption → 仅加密敏感字段后写明文 JSON
   * - !enabled                       → 直接写明文 JSON
   */
  writeEncrypted(filePath: string, data: any): CryptoResult;
  /**
   * 读取文件并自动解密（兼容明文 / 字段加密 / 整文件加密三种形态）
   */
  readEncrypted(filePath: string): {
    data: any;
    result: CryptoResult;
  };
  /**
   * 密钥轮换：用新主密钥重新加密指定文件
   * @param filePath 目标文件
   * @param newMasterKey 新主密钥
   * @param keepOldKey 是否保留旧密钥到 rotatedKeys（保留后历史 keyVersion 仍可解密）
   */
  rotateKey(filePath: string, newMasterKey: string, keepOldKey?: boolean): CryptoResult;
  /**
   * 生成随机主密钥（64 位 hex）
   */
  static generateKey(): string;
  /**
   * 48.0：主密钥阈值分形（Shamir，n 份中任意 t 份可重建、t−1 份
   * 信息论零泄露）。份额应分存于不同介质/保管人；本方法不落盘。
   */
  shardKey(keyHex: string, shares: number, threshold: number): Array<{
    x: number;
    y: string;
  }>;
  /** 48.0：份额重建（任意 ≥ 阈值份；Lagrange 插值） */
  combineKeyShares(shareList: ReadonlyArray<{
    x: number;
    y: string;
  }>): string;
  /**
   * 48.0：密钥原料随机性审计（频数 + 游程检验，NIST SP 800-22 口径）——
   * 「密钥的原料合格吗」从信任变成检查（|z| ≤ 3 通过）。
   */
  auditKeyEntropy(keyHex: string): {
    bytes: number;
    oneRatio: number;
    frequencyChi: number;
    runsZ: number;
    passed: boolean;
  };
  /**
   * 获取指定版本密钥的指纹（SHA-256 前 16 位 hex），用于安全展示与比对
   * @param version 密钥版本，缺省为当前版本
   */
  getKeyFingerprint(version?: number): string;
  /**
   * 判断磁盘文件是否为整文件加密形态
   */
  static isFileEncrypted(filePath: string): boolean;
  /**
   * 判断对象中是否包含加密字段（任意嵌套层级）
   */
  static hasEncryptedFields(obj: any): boolean;
  /**
   * 时序安全的指纹比对（防时序侧信道）
   * @param a 指纹 A
   * @param b 指纹 B
   */
  static safeCompareFingerprint(a: string, b: string): boolean;
  /** 当前密钥版本号（密钥链长度） */
  private currentKeyVersion;
  /** 当前工作密钥 */
  private currentKey;
  /** 按版本号取密钥 */
  private getKeyByVersion;
  /** scrypt 派生工作密钥 */
  private deriveKey;
  /** 字符串 → EncryptedField */
  private encryptStringToField;
  /** 底层加密原语 */
  private encryptRaw;
  /** 底层解密原语 */
  private decryptRaw;
  /** 原子写入：先写临时文件再 rename，防止半写损坏 */
  private atomicWrite;
}
//#endregion
//#region src/memory/backend.d.ts
/** 持久化后端统一契约 */
interface MemoryBackend {
  readonly kind: 'sqlite' | 'json';
  /** FTS5 检索是否可用（仅 SQLite 后端） */
  readonly ftsAvailable?: boolean;
  /** sqlite-vec 扩展是否加载（仅 SQLite 后端） */
  readonly vecAvailable?: boolean;
  /** 加载记忆库（不存在时返回空库） */
  load(): MemoryStore;
  /** 全量保存记忆库 */
  save(store: MemoryStore): void;
  /** 释放连接/资源 */
  close(): void;
  /** FTS5 全文检索（混合检索增强，仅 SQLite 后端提供） */
  fullTextSearch?(query: string, limit?: number): MemorySearchHit[];
  /** 向量检索（sqlite-vec 不可用时的稀疏向量回退，仅 SQLite 后端提供） */
  vectorSearch?(query: string, limit?: number): MemorySearchHit[];
  integrityCheck?(): string;
  stats?(): {
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
  checkpoint?(): void;
  vacuum?(): void;
  backup?(destPath: string): string;
  rawQuery?(sql: string, params?: Array<string | number | null>): Array<Record<string, unknown>>;
}
/** 空记忆库工厂 */
declare function emptyMemoryStore(): MemoryStore;
/** 结构校验与缺省补全（JSON 加载与旧文件迁移共用） */
declare function sanitizeMemoryStore(raw: unknown): MemoryStore;
/** JSON 持久化路径 → SQLite 文件路径（memory.json → memory.db） */
declare function sqlitePathFor(persistPath: string): string;
/** 宿主是否支持内置 SQLite */
declare function sqliteAvailable(): boolean;
/**
 * 轻量中文分词（jieba 式管道的零依赖实现）：
 * - ASCII/数字串按词切分
 * - 连续 CJK 串切分为二元组（bigram），覆盖无词典场景下的中文词级匹配
 *
 * 若宿主提供真实 jieba 管道（如 jieba-wasm），可通过 setChineseTokenizer 注入替换。
 */
declare function tokenizeChinese(text: string): string[];
/** 注入真实 jieba 分词管道（可选；缺省使用内置轻量分词） */
declare function setChineseTokenizer(fn: ((text: string) => string[]) | null): void;
/** 分词入口：优先外部注入的 jieba 管道，缺省轻量分词 */
declare function segment(text: string): string[];
/** 稀疏词频向量（sqlite-vec 不可用时的零依赖向量检索） */
declare function toSparseVector(text: string): Record<string, number>;
declare function cosineSimilarity(a: Record<string, number>, b: Record<string, number>): number;
interface MemorySearchHit {
  /** 联合类型宽化（第二阶段）：新增 semantic / procedural；既有 pattern / strategy 仍合法 */
  kind: 'pattern' | 'strategy' | 'semantic' | 'procedural';
  refId: string;
  score: number;
}
/**
 * SQLite 后端（node:sqlite 内置，零依赖，完全关系化）
 *
 * schema v2：热查询/聚合字段提升为类型化列并建索引，SQL 可直接查询，
 * data 列存完整记录 JSON 保留 schema 演进弹性：
 * - meta(key PK, value)：schema_version / createdAt / lastUpdatedAt / globalStats(JSON)
 * - task_patterns(fingerprint PK, task_type, confidence REAL, frequency, last_seen_at, last_decay_at, data)
 *   + idx(task_type, confidence)：支撑"按类型取最优模式"类 SQL 聚合
 * - model_profiles(id PK, best_task_type, data)
 * - decision_feedback(id PK, ts, signal_type, decision, outcome, data)
 *   + idx(signal_type, ts)：支撑"按信号类型的决策成功率"类 SQL 统计
 * - distilled_strategies(id PK, task_type, confidence REAL, support_count, last_applied_at, data)
 *   + idx(task_type, confidence)
 *
 * 工程特性：
 * - WAL 模式（journal_mode=WAL）：读写不互斥、崩溃恢复更快
 * - 预编译语句缓存（stmt）：热路径零重复编译开销
 * - 增量 UPSERT 同步：save 按主键 upsert + 删除已消失行，不再全表重建
 * - 旧版 v1 blob 表首次打开自动无损升级为 v2
 */
declare class SqliteMemoryBackend implements MemoryBackend {
  readonly kind: 'sqlite';
  private db;
  private dbPath;
  private stmts;
  /** sqlite-vec 扩展是否加载成功（在线/预装环境启用；缺省走零依赖稀疏向量） */
  readonly vecAvailable: boolean;
  /** FTS5 是否可用（node:sqlite 内置；极端裁剪构建可能缺失） */
  readonly ftsAvailable: boolean;
  constructor(dbPath: string);
  /** sqlite-vec 接缝：宿主预装扩展时启用，失败静默回退稀疏向量 */
  private tryLoadVec;
  private createFtsTables;
  /** 预编译语句缓存：同一条 SQL 只编译一次 */
  private stmt;
  /**
   * 版本化迁移框架：按 schema_version 顺序执行 MIGRATIONS 中未应用的步骤，
   * 每步独立事务，失败即停（保留现场便于诊断）。新增迁移只需在数组末尾追加。
   */
  private migrateIfNeeded;
  /** 迁移步骤可访问的内部工具 */
  private hasColumn;
  /** v1（纯 blob 表）→ v2（关系化列）：从 data blob 回填类型化列 */
  private migrateV1toV2;
  private getMeta;
  private setMeta;
  load(): MemoryStore;
  /** 增量同步：按主键 UPSERT + 删除已消失行，单事务保证一致性 */
  save(store: MemoryStore): void;
  /**
   * FTS5 全文检索（混合检索增强）：
   * - trigram 表：原始内容子串级匹配（中文无需分词即可命中）
   * - 分词表：jieba 式 token 级 OR 匹配（词级语义召回）
   * 两路结果按 rank 合并去重。
   */
  fullTextSearch(query: string, limit?: number): MemorySearchHit[];
  /** 稀疏向量检索（sqlite-vec 不可用时的零依赖语义召回） */
  vectorSearch(query: string, limit?: number): MemorySearchHit[];
  /** 完整性检查（PRAGMA integrity_check），返回 ok 或错误描述 */
  integrityCheck(): string;
  /** 数据库统计（运维可观测：行数、页大小、WAL 状态、schema 版本、扩展能力） */
  stats(): {
    patterns: number;
    profiles: number;
    feedback: number;
    strategies: number;
    semantic: number;
    procedural: number;
    pageSize: number;
    pageCount: number;
    walSize: number;
    schemaVersion: number;
    fts: boolean;
    vec: boolean;
  };
  /** WAL checkpoint（TRUNCATE）：把 WAL 合并回主库，缩小文件、便于备份 */
  checkpoint(): void;
  /** VACUUM：回收碎片空间（阻塞式，建议低峰期调用） */
  vacuum(): void;
  /**
   * 热备份：checkpoint 后复制主库文件（node:sqlite 无 backup API，
   * 采用「checkpoint + 文件复制」保证备份一致性），返回备份路径
   */
  backup(destPath: string): string;
  /** 只读查询通道（运维/诊断用；调用方自行保证 SQL 只读） */
  rawQuery(sql: string, params?: Array<string | number | null>): Array<Record<string, unknown>>;
  close(): void;
}
/** JSON 后端（原子写 + 可选加密，回退/兼容路径） */
declare class JsonMemoryBackend implements MemoryBackend {
  private persistPath;
  private cryptoEngine?;
  readonly kind: 'json';
  constructor(persistPath: string, cryptoEngine?: CryptoEngine | undefined);
  load(): MemoryStore;
  save(store: MemoryStore): void;
  close(): void;
}
/**
 * 后端选型：加密启用 → JSON；否则 node:sqlite 可用 → SQLite；不可用 → JSON 回退
 */
declare function createMemoryBackend(persistPath: string, cryptoEngine?: CryptoEngine): MemoryBackend;
//#endregion
//#region src/memory/long-term-memory.d.ts
/** 成功执行记录 */
interface SuccessfulPlanRecord {
  timestamp: number;
  plan: {
    objective: string;
    nodes: Array<{
      id: string;
      description: string;
      type: string;
      dependsOn: string[];
    }>;
    parallelismStrategy: string;
  };
  modelAssignments: Record<string, string>;
  totalLatency: number;
  qualityScores: Record<string, number>;
  tokenCost: number;
}
/** 失败记录 */
interface FailureRecord {
  timestamp: number;
  reason: string;
  failedNodeId: string;
  failedModelId: string;
  errorMessage: string;
}
/** 任务模式记忆 */
interface TaskPatternMemory {
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
interface ModelTaskStats {
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
interface ModelLongTermProfile {
  id: string;
  name: string;
  taskHistory: Record<string, ModelTaskStats>;
  costEfficiency: Record<string, number>;
  bestTaskType: string;
  worstTaskType: string;
  stability: number;
}
/** 决策反馈 */
interface DecisionFeedback {
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
interface BayesianEstimate {
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
interface DistilledStrategy {
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
/** 语义记忆条件维度 */
type SemanticConditionDimension = 'task-type' | 'feature' | 'complexity' | 'length' | 'token-cost';
/** 语义记忆条件（与程序记忆条件结构一致，类型独立以便演进） */
interface SemanticCondition {
  dimension: SemanticConditionDimension;
  operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';
  value: string | number | string[];
}
/** 语义记忆结论 */
interface SemanticConclusion {
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
interface SemanticMemory {
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
}
/** 程序记忆条件维度（含 outcome/root-cause，用于反思规则） */
type ProceduralConditionDimension = 'task-type' | 'feature' | 'complexity' | 'length' | 'token-cost' | 'outcome' | 'root-cause';
/** 程序记忆条件 */
interface ProceduralCondition {
  dimension: ProceduralConditionDimension;
  operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';
  value: string | number | string[];
}
/** 程序记忆动作 */
interface ProceduralAction {
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
interface ProceduralMemory {
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
}
/** 蒸馏报告（distillKnowledge 产物） */
interface DistillationReport {
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
interface MemoryStore {
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
interface RecordSuccessParams {
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
interface RecordFailureParams {
  taskType: string;
  complexity: number;
  features: string[];
  reason: string;
  failedNodeId: string;
  failedModelId: string;
  errorMessage: string;
}
/** 决策反馈记录参数（IMemoryStore 契约） */
interface RecordDecisionFeedbackParams {
  signalType: string;
  signalDescription: string;
  decision: string;
  outcome: DecisionFeedback['outcome'];
  outcomeReason: string;
  lesson?: string;
}
/** 任务模式指纹（taskType + complexity 分桶 + 特征排序，全组件统一约定） */
declare function buildPatternFingerprint(taskType: string, complexity: number, features: string[]): string;
/** 条件匹配上下文（语义/程序记忆共用；outcome 与 rootCause 仅程序记忆使用） */
interface MemoryMatchContext {
  features?: string[];
  complexity?: number;
  length?: number;
  tokenCost?: number;
  outcome?: string;
  rootCause?: string;
}
/** 单条件结构（SemanticCondition / ProceduralCondition 的公共形状） */
interface MemoryCondition {
  dimension: string;
  operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';
  value: string | number | string[];
}
/** 单条件求值（actual 未知时除空值场景外均不命中） */
declare function evaluateMemoryCondition(actual: string | number | string[] | undefined, operator: MemoryCondition['operator'], expected: string | number | string[]): boolean;
/** 合取条件匹配：全部条件满足才返回 true（供优化器检索复用） */
declare function matchesMemoryConditions(conditions: MemoryCondition[], taskType: string, context: MemoryMatchContext): boolean;
/** 证据普查单层统计（3.0：自知之明报告的原料） */
interface EvidenceCensusLayer {
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
interface EvidenceCensus {
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
declare class LongTermMemory implements IMemoryStore {
  private persistPath;
  private backend;
  private store;
  private persistTimer;
  private flushOnExit;
  private idxPattern;
  private idxProfile;
  private idxStrategy;
  private idxStrategyDesc;
  private idxSemantic;
  private idxSemanticStatement;
  private idxProcedural;
  private idxProceduralName;
  private idxFeedbackId;
  /** 从 store 全量重建索引（构造载入 / 批量过滤后调用） */
  private reindex;
  /** 当前持久化后端类型（sqlite / json） */
  get backendKind(): 'sqlite' | 'json';
  /**
   * @param persistPath 持久化文件路径（如 .scheduler/memory.json；SQLite 后端自动映射为 .db）
   * @param cryptoEngine 可选加密引擎，提供后持久化自动适配加密配置（走 JSON 后端）
   */
  constructor(persistPath: string, cryptoEngine?: CryptoEngine);
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
  findPattern(taskType: string, complexity: number, features?: string[]): TaskPatternMemory | undefined;
  /**
   * 记录一次成功执行：沉淀任务模式 + 更新模型画像 + 全局统计
   */
  recordSuccess(params: RecordSuccessParams): void;
  /**
   * 记录一次失败执行
   */
  recordFailure(params: RecordFailureParams): void;
  /**
   * 记录一次决策反馈（execute/defer/dismiss/ask-user 的结果复盘）
   */
  recordDecisionFeedback(params: RecordDecisionFeedbackParams): void;
  /** 获取全局统计 */
  getGlobalStats(): MemoryStore['globalStats'];
  /**
   * 获取置信度最高的任务模式
   * @param limit 返回数量上限，默认 10
   */
  getTopPatterns(limit?: number): TaskPatternMemory[];
  /** 获取指定模型画像 */
  getModelProfile(modelId: string): ModelLongTermProfile | undefined;
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
  getBayesianEstimate(modelId: string, taskType: string): BayesianEstimate | undefined;
  /** 获取全部模型画像 */
  getAllModelProfiles(): ModelLongTermProfile[];
  /** 获取全部任务模式（迁移导出用） */
  getAllTaskPatterns(): TaskPatternMemory[];
  /** 获取全部决策反馈（迁移导出用） */
  getAllDecisionFeedback(): DecisionFeedback[];
  /**
   * 插入或更新任务模式（迁移导入用）
   * @returns 'created' 新增 / 'updated' 覆盖
   */
  upsertPattern(pattern: TaskPatternMemory): 'created' | 'updated';
  /**
   * 按指纹删除任务模式（分布式同步 pattern-deleted 变更用）
   * @returns 是否实际删除
   */
  removePattern(fingerprint: string): boolean;
  /**
   * 插入或更新模型画像（迁移导入用）
   * @returns 'created' 新增 / 'updated' 覆盖
   */
  upsertModelProfile(profile: ModelLongTermProfile): 'created' | 'updated';
  /**
   * 追加一条决策反馈（迁移导入用，按 id 去重）
   * @returns 是否实际写入（重复 id 返回 false）
   */
  appendFeedback(feedback: DecisionFeedback): boolean;
  /**
   * 累加式合并全局统计（迁移导入用）
   * 计数类字段相加，均值类字段按执行次数加权平均
   */
  mergeGlobalStats(incoming: MemoryStore['globalStats']): void;
  /**
   * 获取最近的决策反馈
   * @param limit 返回数量上限，默认 20
   */
  getRecentFeedback(limit?: number): DecisionFeedback[];
  /**
   * 统计某类信号的决策成功率
   * @param signalType 信号类型
   */
  getDecisionSuccessRate(signalType: string): {
    total: number;
    successRate: number;
    avgOutcome: string;
  };
  /**
   * 生成记忆库人类可读摘要（供 query_memory Tool 使用）
   */
  getMemorySummary(): string;
  /**
   * 清理过期记忆
   * @param maxAgeDays 最大保留天数，默认 90
   * @returns 被清理的条目数
   */
  prune(maxAgeDays?: number): number;
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
  distillExperience(minConfidence?: number): DistilledStrategy[];
  /**
   * 获取指定任务类型的蒸馏策略（3.0：按证据化排序分降序——confidence × Wilson 下界等权混合）
   * @param taskType 任务类型
   * @param limit 返回上限
   */
  getStrategies(taskType: string, limit?: number): DistilledStrategy[];
  /** 全部蒸馏策略 */
  getAllStrategies(): DistilledStrategy[];
  /**
   * 策略应用反馈：更新策略的应用成功率（闭环校准策略置信度）
   *
   * 3.0：同步观测统一证据（时间加权 Beta）——旧实体首次观测时从
   * 裸计数折价初始化，与模型画像 legacy 回退语义一致。
   *
   * @param strategyId 策略 id
   * @param success 本次应用是否成功
   */
  recordStrategyOutcome(strategyId: string, success: boolean): void;
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
  findSemanticMemory(taskType: string, context?: {
    features?: string[];
    complexity?: number;
    length?: number;
    tokenCost?: number;
  }): SemanticMemory | undefined;
  /** 获取指定任务类型的语义记忆（3.0：按证据化排序分降序） */
  getSemanticMemories(taskType: string, limit?: number): SemanticMemory[];
  /** 全部语义记忆 */
  getAllSemanticMemories(): SemanticMemory[];
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
   * @returns 'created' / 'updated' / 'merged' / 'superseded' / 'duplicate'
   */
  upsertSemanticMemory(memory: SemanticMemory): 'created' | 'updated' | 'duplicate' | 'merged' | 'superseded';
  /** 按指纹溯源删除语义记忆（分布式同步用；3.0 索引同步删除） */
  removeSemanticMemory(id: string): boolean;
  /** 语义记忆应用反馈（闭环校准置信度 + 3.0 统一证据观测） */
  recordSemanticOutcome(id: string, success: boolean): void;
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
  findProceduralMemory(kind: ProceduralMemory['kind'], taskType: string, context?: {
    features?: string[];
    complexity?: number;
    length?: number;
    tokenCost?: number;
    outcome?: string;
    rootCause?: string;
  }): ProceduralMemory | undefined;
  /** 获取指定任务类型的程序记忆（3.0：按证据化排序分降序） */
  getProceduralMemories(taskType: string, kind?: ProceduralMemory['kind'], limit?: number): ProceduralMemory[];
  /** 全部程序记忆 */
  getAllProceduralMemories(): ProceduralMemory[];
  /**
   * 插入或更新程序记忆（第二阶段升级：证据合并增强 + 冲突消解，语义同 upsertSemanticMemory）
   *
   * 冲突判定：同结构签名（kind + 动作类型 + 目标模型维度 + 条件）但目标模型不同
   * （如"长代码任务偏好模型A" vs "偏好模型B"）→ 新证据显著更强时取代，否则丢弃。
   *
   * @returns 'created' / 'updated' / 'merged' / 'superseded' / 'duplicate'
   */
  upsertProceduralMemory(memory: ProceduralMemory): 'created' | 'updated' | 'duplicate' | 'merged' | 'superseded';
  /** 删除程序记忆（3.0 索引同步删除） */
  removeProceduralMemory(id: string): boolean;
  /** 程序记忆应用反馈（闭环校准置信度 + 3.0 统一证据观测） */
  recordProceduralOutcome(id: string, success: boolean): void;
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
  };
  /** 蒸馏完成检查点：刷新水位（供 distillKnowledge 成功后调用） */
  noteDistillationCheckpoint(): void;
  /**
   * 证据普查（3.0：自知之明报告——全层不确定性一览）
   *
   * 系统级自检 API：
   * - 各记忆层的证据覆盖度（withEvidence / total）、平均有效样本量、证据枯竭数
   * - 模型画像层基于既有时间加权证据换算（legacy 裸计数折价，口径与 getBayesianEstimate 一致）
   * - 能力漂移检测：|drift| > 0.1 且有效样本 ≥ 5 的模型 × 任务组合
   *   （模型修复被察觉 / 模型退化被预警）
   */
  evidenceCensus(): EvidenceCensus;
  /**
   * 通用条件匹配（语义记忆用，第二阶段升级：委托导出的纯函数 matchesMemoryConditions，
   * 与优化器检索共用同一套求值语义，避免两处实现漂移）
   */
  private matchConditions;
  /** 程序记忆条件匹配（含 outcome/root-cause 维度） */
  private matchProceduralConditions;
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
  applyForgettingCurve(halfLifeDays?: number, forgetThreshold?: number): {
    decayed: number;
    forgotten: number;
  };
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
  private decayMemory;
  /** FTS5 全文检索（混合检索增强，委托 SQLite 后端；JSON 后端返回空） */
  fullTextSearch(query: string, limit?: number): MemorySearchHit[];
  /** 向量检索（稀疏向量回退，委托 SQLite 后端；JSON 后端返回空） */
  vectorSearch(query: string, limit?: number): MemorySearchHit[];
  /** 完整性检查（JSON 后端恒 ok） */
  integrityCheck(): string;
  /** 数据库统计（JSON 后端返回内存计数） */
  dbStats(): {
    patterns: number;
    profiles: number;
    feedback: number;
    strategies: number;
    semantic: number;
    procedural: number;
    pageSize: number;
    pageCount: number;
    walSize: number;
    schemaVersion: number;
    fts: boolean;
    vec: boolean;
  };
  /** WAL checkpoint（仅 SQLite 后端有效） */
  checkpoint(): void;
  /** VACUUM 回收碎片空间（仅 SQLite 后端有效） */
  vacuum(): void;
  /** 热备份（仅 SQLite 后端；返回备份路径） */
  backup(destPath: string): string | undefined;
  /** 只读 SQL 查询通道（仅 SQLite 后端；JSON 后端返回空） */
  rawQuery(sql: string, params?: Array<string | number | null>): Array<Record<string, unknown>>;
  /** 立即同步落盘（进程退出前调用） */
  flushSync(): void;
  /** 释放资源（落盘 + 移除 beforeExit 监听 + 关闭后端连接） */
  dispose(): void;
  /** 判断同描述策略是否已存在（蒸馏去重；3.0 索引化 O(1)） */
  private hasStrategy;
  /** 从持久化后端加载记忆库（损坏时由后端备份并抛出） */
  private load;
  /** 防抖持久化调度 */
  private schedulePersist;
  /** 执行持久化（委托后端：SQLite 事务 / JSON 原子写 / 加密落盘） */
  private persist;
  /** 更新模型画像 */
  private updateModelProfile;
  /** 构建任务指纹：taskType + 复杂度分桶 + 排序后的特征 */
  private buildFingerprint;
  /**
   * 相似度打分（0~1）
   * 0.5 × taskType 匹配 + 0.25 × complexity 接近度 + 0.25 × features Jaccard
   */
  private similarity;
  /** 质量分字典的平均值 */
  private avgQuality;
  /** 数值数组平均值 */
  private avg;
  /** 滚动平均（避免保存全量历史） */
  private rollingAvg;
}
//#endregion
//#region src/core/persistent-homology.d.ts
/**
 * 36.0 持续同调内核 —— H₀ 持续图 + 瓶颈距离：知识的形状跨尺度可见
 *
 * 动机: 记忆图（共现网络 + 主题树）只知道「谁连着谁」，不知道**自己在
 * 什么尺度上是什么形状**。把边权视为相似度、阈值 ε 从高往低扫：
 *
 *   ε = ∞: 每条知识自成一个分量（群岛）；ε 下降: 强相似先合并，
 *   分量逐个死去——单连接合并过程就是 H₀ 的持久图（persistence diagram）。
 *
 *   拓扑数据处理（Edelsbrunner–Letscher–Zomorodian 2002）的洞见：
 *   **只在一个尺度上出现的结构是噪声，跨尺度持久的结构是形状**。
 *   - 死得早（高 ε 就被吞并）的分量 = 聚类内部的普通成员；
 *   - 持久到低 ε 的分量 = 稳定的知识大陆；
 *   - 永不合并（essential class）的分量 = 知识孤岛——与任何主题都不
 *     共现的记忆，正是好奇心该去的地方（盲区的拓扑定义）。
 *
 *   瓶颈距离（Cohen-Steiner–Edelsbrunner–Harer 稳定性定理）:
 *   两张持久图的瓶颈距离 ≤ 输入度量的扰动——**知识地形的变化本身
 *   有了 Lipschitz 稳定的度量**：记忆重组前后地形漂移多少，一个数字。
 *
 *   实现口径: 并查集单连接（H₀ 精确，O(E log E)）；瓶颈距离用
 *   阈值化二分 + 增广路匹配（精确，小图适用）。
 *
 * 零漂移: 纯分析内核，未挂载时调用方行为与升级前逐位一致。
 */
/** 一次合并事件（一个 H₀ 类的死亡） */
interface MergeEvent {
  /** 合并发生的相似度阈值（该边权重） */
  epsilon: number;
  /** 被吞并侧的大小（young 类的成员数——分量大小的「死因」） */
  absorbedSize: number;
  /** 存活侧的代表（并查集根，节点 id） */
  survivor: string;
}
interface TopographyReport {
  /** 节点数 */
  nodes: number;
  /** essential 类（永不合并的分量 = 知识孤岛；阈值降到 floor 仍独活） */
  islands: Array<{
    members: string[];
  }>;
  /** 合并事件按 ε 降序（知识大陆的成形史） */
  merges: MergeEvent[];
  /** 有限持久点 (birth, death) = (1, 合并 ε)：death 越小越早被吞并 */
  diagram: Array<{
    birth: number;
    death: number;
  }>;
  /** 最持久的合并阈值带（大陆间连接强度分布的分位数） */
  landscape: {
    p50: number;
    p90: number;
    continentCount: number;
  };
}
/**
 * H₀ 持续同调（相似度口径：阈值 ε 从 1 降到 floor）。
 *
 * nodes: 参与节点 id；edges: {source, target, weight ∈ (0,1]}（相似度）。
 * essential 类 = 阈值降到 floor 仍独活的分量（含完全孤立的节点）。
 */
declare function h0Persistence(nodes: ReadonlyArray<string>, edges: ReadonlyArray<{
  source: string;
  target: string;
  weight: number;
}>, floor?: number): TopographyReport;
/**
 * 瓶颈距离（L∞ 匹配口径，含对角线）。
 *
 * ε-匹配可行性：A_i ↔ B_j（‖·‖∞ ≤ ε）或 A_i ↔ 对角线（distToDiag ≤ ε），
 * B_j 同理可留对角线。二分候选 ε（成对距离 ∪ 对角距离），增广路判可行。
 * 稳定性定理（Cohen-Steiner et al.）: 输入扰动 δ → 瓶颈距离 ≤ δ。
 */
declare function bottleneckDistance(pointsA: ReadonlyArray<{
  birth: number;
  death: number;
}>, pointsB: ReadonlyArray<{
  birth: number;
  death: number;
}>): number;
/** 知识地形摘要（36.0 接线口径：孤岛 = 盲区的拓扑定义） */
declare function topographyInsight(report: TopographyReport): string;
//#endregion
//#region src/memory/memory-graph.d.ts
interface MemoryNode {
  id: string;
  /**
   * 节点类型：
   * - pattern：任务模式（情景记忆叶节点）
   * - strategy：蒸馏策略（第一阶段既有）
   * - topic：主题树节点
   * - semantic：语义记忆节点（第二阶段，由知识蒸馏产出）
   * - procedural：程序记忆节点（第二阶段，由知识蒸馏产出）
   */
  kind: 'pattern' | 'strategy' | 'topic' | 'semantic' | 'procedural';
  label: string;
  createdAt: number;
}
interface MemoryEdge {
  source: string;
  target: string;
  /** 共现次数 */
  cooccurrences: number;
  /** 归一化权重 0~1（cooccurrences / 5 封顶） */
  weight: number;
  lastAt: number;
}
interface TopicNode {
  id: string;
  name: string;
  parentId: string | null;
  childIds: string[];
  patternIds: string[];
}
declare class MemoryGraph {
  private nodes;
  private edges;
  private topics;
  private persistPath;
  /** 39.0：影响力排序（attachInfluenceRanking 后 related() 按 边权×邻居影响力 排序） */
  private influence?;
  constructor(persistPath: string);
  private edgeKey;
  /** 确保节点存在（幂等） */
  ensureNode(id: string, kind: MemoryNode['kind'], label: string): void;
  /** 记录共现：边权重随共现次数增长（上限 1） */
  link(a: string, b: string): MemoryEdge;
  /** 图联想：按边权重返回相邻节点 id（混合检索的联想增强）
   *
   * 39.0：挂载影响力排序后，联想序从「边权」升维为「边权 × 邻居影响力」
   * （与枢纽共现的记忆先被想起）；未挂载时与原边权序逐位一致（零漂移）。
   */
  related(id: string, limit?: number): string[];
  /**
   * 39.0：挂载谱排序影响力（幂等覆盖，挂载即生效）。
   *
   * PageRank 幂迭代（阻尼 0.85，质量守恒 Σ=1）在共现网络上解出每条
   * 知识的结构影响力——「被重要者共现者重要」。topInfluential 输出
   * 知识骨架（蒸馏保骨去肉的依据）；related() 切换影响力加权口径。
   * 未挂载零漂移。
   */
  attachInfluenceRanking(options?: {
    damping?: number;
  }): void;
  /** 39.0：知识骨架清单（未挂载返回空数组） */
  topInfluential(k?: number): Array<{
    id: string;
    score: number;
  }>;
  /**
   * 36.0：知识地形（H₀ 持续同调；纯分析，无副作用）。
   *
   * 共现权重视为相似度、阈值从 1 向 floor 扫描：跨尺度持久的分量 =
   * 稳定知识大陆；永不合并的分量 = 知识孤岛（盲区的拓扑定义——
   * 与任何主题都不共现的记忆，正是好奇心该去的地方）。
   */
  knowledgeTopography(floor?: number): TopographyReport & {
    summary: string;
  };
  /** 将模式挂到主题树（根主题 = taskType） */
  attachTopic(patternId: string, topicName: string, parentTopic?: string): TopicNode;
  /** 主题树（仅根节点，含子主题与叶模式） */
  topicTree(): TopicNode[];
  getNode(id: string): MemoryNode | undefined;
  stats(): {
    nodes: number;
    edges: number;
    topics: number;
  };
  /** 序列化到本地 JSON（原子写） */
  save(): void;
  /** 启动时从本地 JSON 加载（损坏/缺失时从空图开始） */
  private load;
}
//#endregion
//#region src/progress-ws.d.ts
/** 进度事件（type 为附录协议中的 13 种事件名，可自由扩展） */
interface ProgressEvent {
  type: string;
  timestamp: number;
  [key: string]: unknown;
}
/**
 * WebSocket 进度广播器
 *
 * 独立监听一个 HTTP 端口并升级为 WebSocket 服务。
 * 被 index.ts 集成层持有，执行链路各阶段调用 broadcast() 推送事件。
 */
declare class ProgressBroadcaster {
  private port;
  private server;
  private connections;
  /** 环形回放缓冲 */
  private replayBuffer;
  private heartbeatTimer;
  private started;
  /** 可选 HTTP 请求处理器（dashboard 等静态页面复用本端口；返回 true 表示已响应） */
  private httpHandler;
  /**
   * @param port 监听端口，默认 9877（与 cordis.patch.yml progressPort 一致）
   */
  constructor(port?: number);
  /**
   * 注册 HTTP 请求处理器（非 WebSocket 升级请求优先交给它）
   * @param handler 返回 true 表示已处理该请求；返回 false 走默认健康检查响应
   */
  setHttpHandler(handler: ((req: http.IncomingMessage, res: http.ServerResponse) => boolean) | null): void;
  /**
   * 启动 WebSocket 服务
   * 监听失败（端口冲突等）通过 'error' 事件降级停机并记录，
   * 不抛出——EventEmitter 回调内 throw 会成为进程级未捕获异常
   */
  start(): void;
  /**
   * 广播事件给所有在线客户端，并写入回放缓冲
   * @param event 进度事件（timestamp 缺省时自动补当前时间）
   */
  broadcast(event: ProgressEvent): void;
  /**
   * 停止服务：关闭所有连接与监听
   */
  stop(): void;
  /** 当前在线连接数 */
  getClientCount(): number;
  /** RFC 6455 握手 */
  private handleUpgrade;
  /**
   * 解析入站帧（客户端帧必带掩码）
   * 仅处理控制帧：close(0x8) / ping(0x9) / pong(0xA)；业务上行暂不需要
   *
   * TCP 不保证报文边界：一个 WebSocket 帧可能跨多个 data 事件到达（分片），
   * 多个帧也可能挤在同一个 chunk 里（粘包）。因此维护 pendingData 缓冲，
   * 每次仅消费完整帧，未消费的余量留给下一个 data 事件拼接。
   */
  private handleData;
  /** 发送未掩码服务端帧 */
  private sendFrame;
  /** 清理连接 */
  private dropConnection;
}
//#endregion
//#region src/optimizer.d.ts
/**
 * 记忆层级（第二阶段）
 *
 * 优化器推荐优先级：procedural > semantic > episodic > none
 * - procedural：程序记忆命中（最具体的 if-then 规则）
 * - semantic：语义记忆命中（跨任务抽象规律）
 * - episodic：情景记忆命中（既有任务模式匹配）
 * - none：无任何记忆命中（首次任务）
 */
type MemoryLayer = 'procedural' | 'semantic' | 'episodic' | 'none';
/** 经验检索结果（优化器产物，供模型调度消费） */
interface ExperienceLookup {
  pattern?: TaskPatternMemory;
  /** 按节点类型的推荐模型组合（模型调度优先采用） */
  recommendedModels: Record<string, string>;
  historicalSuccessRate: number;
  avgExecutionTime: number;
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
  /** 程序记忆聚合的规避模型列表（avoid-model 动作目标；调度时从候选中剔除） */
  avoidModels: string[];
  /** 本次条件匹配命中的全部程序记忆 id（应用反馈闭环回写用） */
  matchedProceduralIds?: string[];
  /** 本次推荐使用的调度策略版本（policyId@vN；策略热切换后随次检索更新） */
  policyVersion: string;
}
/** 优化器配置 */
interface OptimizerConfig {
  /**
   * 经验快路径：命中模式置信度 ≥ 该阈值时，直接复用历史最优成功计划，
   * 跳过 strategist LLM 重新规划（越用越快、越稳、越省 token）。
   * 设为 >1 可关闭快路径。缺省 0.9。
   */
  memoryFastPathThreshold?: number;
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
declare class Optimizer implements IOptimizer {
  private memory;
  private config;
  private broadcaster?;
  private graph?;
  /** 当前调度策略提供器（第三阶段：策略版本标注与分解决策依据） */
  private policyProvider?;
  /** 7.0：深思内核（冷启动序列推荐 = 规划即推断） */
  private deliberation?;
  /** 8.0：元推理内核（推荐的双过程仲裁 = 理性元推理） */
  private metareasoner?;
  constructor(params: {
    memory: IMemoryStore;
    config?: OptimizerConfig;
    broadcaster?: ProgressBroadcaster;
    graph?: MemoryGraph;
    policyProvider?: () => Policy;
  });
  /** 7.0：挂载深思内核（幂等；挂载后获得冷启动深思推荐能力） */
  attachDeliberation(engine: DeliberationEngine): void;
  /** 8.0：挂载元推理内核（幂等；挂载后推荐经双过程仲裁定价） */
  attachMetareasoner(reasoner: RationalMetareasoner): void;
  /** 运行时配置热更新（元认知自调优落地入口） */
  updateConfig(patch: Partial<OptimizerConfig>): void;
  /** 当前配置快照（第四阶段：元认知旋钮 read 端；只读） */
  getConfig(): Readonly<OptimizerConfig>;
  /** 当前策略版本标识（policyId@vN；未注入提供器时为 baseline） */
  private currentPolicyVersion;
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
  lookupExperience(taskType: string, complexity: number, features?: string[], context?: {
    length?: number;
    tokenCost?: number;
  }): ExperienceLookup;
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
  shouldDecompose(complexity: number, taskType?: string, features?: string[]): boolean;
  /**
   * 构建决策依据说明（人类可读，供广播与可观测性）
   *
   * 第二阶段升级：程序记忆层说明全部命中规则数与正负向动作概览，
   * 让"使用了哪一层记忆、为什么"完全可追溯。
   */
  private buildRationale;
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
   * @param lookup 经验检索结果
   * @param objective 当前任务目标（写入计划）
   * @returns 复用的计划（source='memory'），不满足条件时 undefined
   */
  recallPlan(lookup: ExperienceLookup, objective: string): ExecutionPlan | undefined;
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
  deliberativeRecommendation(taskType: string, candidateActions: string[], stages: number, opts?: {
    breadth?: number;
    preference?: number;
  }): DeliberationResult | undefined;
  /** 29.0 MCTS 搜索参数（attachMctsSearch 后深思推荐走 UCT；undefined = 原 beam search） */
  private mctsOptions?;
  /**
   * 29.0：挂载 UCT 搜索口径（幂等；撤除传 null）。
   * 深思推荐从 beam search 切换为 MCTS——转移边按 Beta 后验采样成败，
   * UCB1 平衡利用/探索，迭代预算耗尽即读出（任意时刻性）。
   */
  attachMctsSearch(options?: {
    iterations?: number;
    explorationC?: number;
    discount?: number;
  } | null): void;
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
  metacognitiveRecommendation(taskType: string, candidateActions: string[], stages: number, opts?: {
    preference?: number;
  }): ArbitrationResult | undefined;
  /**
   * 混合检索（自主学习建议 1：sqlite-vec + FTS5 + jieba 分词管道）
   *
   * 四路召回合并去重（按 refId 取最高分）：
   * 1. 模糊匹配（findPattern：taskType/complexity/features 相似度）
   * 2. FTS5 全文（trigram 子串级 + jieba 式 token 级，中文友好）
   * 3. 向量（sqlite-vec 可用时宿主扩展；缺省稀疏词频向量余弦）
   * 4. 图联想（记忆网络相邻节点，权重折半计入）
   */
  hybridSearch(query: string, taskType: string, complexity: number, limit?: number): MemorySearchHit[];
  /** 进度事件广播（broadcaster 缺省时为空操作） */
  private broadcast;
}
//#endregion
//#region src/meta/meta-types.d.ts
/**
 * meta-types.ts — 第四阶段「元认知层」共享数据结构
 *
 * 双环自治进化的外环数据契约：
 * - 内环（第一~三阶段）：任务执行 → 反思 → 记忆 → 优化 → 策略进化
 * - 外环（第四阶段）：观察内环运行 → 自我建模（心智报告）→ 元认知控制
 *   （调整内环参数）→ 观察调整效果 → 保留 / 回滚
 *
 * 设计要点：
 * - 全部结构可直接 JSON 序列化（报告/审计日志即持久化格式）
 * - MentalReport 严格实现第四阶段验收接口定义，并补充可追溯字段
 * - JudgeMetric 把「参数调整」与「效果判定指标」显式关联，
 *   使保守调整闭环（应用 → 观察 → 判定 → 保留/回滚）可机器执行
 */
/** 操作环指标（源自决策反馈与全局统计） */
interface OperationalMetrics {
  /** 综合成功率 0~1（excellent/good/acceptable 计成功） */
  successRate: number;
  /** 平均质量分（按 outcome 映射 0.95/0.8/0.65/0.4/0.1） */
  avgQuality: number;
  /** 样本数（参与统计的决策反馈条数） */
  sampleCount: number;
  /** 按任务类型（信号类型）分组的成败统计 */
  perTaskType: Array<{
    taskType: string;
    total: number;
    successes: number;
    successRate: number;
    avgQuality: number;
  }>;
}
/** 记忆体系指标 */
interface MemoryMetrics {
  counts: {
    /** 情景记忆（任务模式）条数 */
    episodic: number;
    /** 语义记忆条数 */
    semantic: number;
    /** 程序记忆条数 */
    procedural: number;
    /** 蒸馏策略条数 */
    strategies: number;
    /** 模型画像条数 */
    modelProfiles: number;
    /** 决策反馈条数 */
    feedback: number;
  };
  /** 距上次知识蒸馏新增的情景事件数（蒸馏水位） */
  pendingSinceLastDistillation: number;
  totalExecutions: number;
  totalSuccesses: number;
  totalFailures: number;
  totalTokensUsed: number;
  averageQualityScore: number;
  averageExecutionTime: number;
}
/** 进化环指标（源自策略进化器状态） */
interface EvolverMetrics {
  currentPolicyId: string;
  currentPolicyVersion: number;
  currentPolicyGeneration: number;
  currentPolicyOrigin: string;
  totalCycles: number;
  totalCandidatesEvaluated: number;
  /** 部署次数（不含初始基准） */
  deployedCount: number;
  /** 被金丝雀回滚的部署数 */
  rolledBackCount: number;
  /** 新策略存活率 = 未回滚部署 / 部署总数 */
  survivalRate: number;
  /** 发现速率 = 部署次数 / 进化轮数 */
  discoveryRate: number;
  /** 平均发现间隔（毫秒，相邻部署时间差的均值） */
  avgDiscoveryIntervalMs: number;
  /** 已部署策略的平均沙盒收益 */
  avgDeployedGain: number;
  /** 自适应变异步长系数 */
  sigmaScale: number;
  /** 种群精英数 */
  populationSize: number;
  /** 金丝雀状态（无观察窗为 'none'） */
  canaryStatus: 'none' | 'active' | 'promoted' | 'rolled-back';
  /** 部署链（按部署时间升序） */
  deployedHistory: Array<{
    id: string;
    version: number;
    generation: number;
    deployedAt: number;
    rolledBackAt?: number;
  }>;
}
/** 系统指标快照（getSystemMetrics 产物；心智报告的原始素材） */
interface SystemMetrics {
  collectedAt: number;
  operational: OperationalMetrics;
  memory: MemoryMetrics;
  evolver: EvolverMetrics;
}
/** 策略表现摘要（当前策略的优势与盲点） */
interface StrategyPerformanceSummary {
  currentPolicyId: string;
  currentPolicyVersion: number;
  currentPolicyGeneration: number;
  currentPolicyOrigin: string;
  /** 操作环整体表现（最近决策反馈窗口） */
  operational: {
    successRate: number;
    avgQuality: number;
    sampleCount: number;
  };
  /**
   * 按策略版本归因的表现（部署时间窗内的决策反馈统计）：
   * 回答「策略 v3 升级到 v4 后成功率变化多少」的证据基础
   */
  perVersion: Array<{
    policyId: string;
    version: number;
    successRate: number;
    avgQuality: number;
    samples: number;
  }>;
  /** 优势：成功率最高的任务类型（样本 ≥ 最小样本数） */
  strengths: Array<{
    taskType: string;
    successRate: number;
    samples: number;
  }>;
  /** 盲点：成功率最低的任务类型 */
  blindSpots: Array<{
    taskType: string;
    successRate: number;
    samples: number;
  }>;
  /** 最近一次进化周期的沙盒收益（无评估历史为空） */
  sandboxFitness?: {
    reward: number;
    gain: number;
    gainLCB?: number;
  };
}
/** 记忆体系质量摘要（哪类记忆在增加、哪类在退化） */
interface MemoryQualitySummary {
  counts: MemoryMetrics['counts'];
  /** 与上一份心智报告对比的增量（首份报告为全 0） */
  growth: {
    episodic: number;
    semantic: number;
    procedural: number;
    strategies: number;
  };
  /** 蒸馏水位（越高 = 情景积压越多，蒸馏越滞后） */
  distillation: {
    pendingSinceLastDistillation: number;
  };
  /** 各层趋势评估：growing 增长 / stable 平稳 / degrading 退化（遗忘主导） */
  layers: Array<{
    layer: string;
    trend: 'growing' | 'stable' | 'degrading';
    detail: string;
  }>;
  totalExecutions: number;
  averageQualityScore: number;
}
/** 进化器效率摘要（发现速度与存活率） */
interface EvolverEfficiencySummary {
  totalCycles: number;
  totalCandidatesEvaluated: number;
  deployedCount: number;
  /** 新策略存活率（部署后未被金丝雀回滚的比例） */
  survivalRate: number;
  rolledBackCount: number;
  /** 发现速率：每轮进化平均部署数 */
  discoveryRate: number;
  /** 平均发现间隔（毫秒；相邻部署的wall-clock差均值） */
  avgDiscoveryIntervalMs: number;
  /** 已部署策略的平均沙盒收益 */
  avgDeployedGain: number;
  sigmaScale: number;
  populationSize: number;
  canaryStatus: EvolverMetrics['canaryStatus'];
}
/** 系统稳定性与风险点 */
interface SystemStabilitySummary {
  /** 0~1 综合稳定分（成功率 + 存活率 + 记忆健康加权） */
  stabilityScore: number;
  riskPoints: Array<{
    severity: 'low' | 'medium' | 'high';
    area: 'strategy' | 'memory' | 'evolver' | 'operations' | 'meta';
    description: string;
  }>;
  /** 近期金丝雀回滚次数（部署链 rolledBackAt 计数） */
  recentRollbacks: number;
  canaryActive: boolean;
  /** token 消耗趋势（与上份报告对比） */
  tokenUsageTrend: 'rising' | 'stable' | 'falling' | 'unknown';
}
/** 自我改进证据（可机器验证的前后对比） */
interface ImprovementEvidence {
  kind: 'policy-upgrade' | 'memory-growth' | 'evolver-efficiency' | 'quality-gain';
  /** 人类可读描述（如「策略 v3→v4 后平均任务成功率提升 7pp」） */
  description: string;
  /** 调整/升级前取值 */
  before?: number;
  /** 调整/升级后取值 */
  after?: number;
  /** 计量单位（pp / 条 / 毫秒 / 比率） */
  unit?: string;
  measuredAt: number;
}
/** 推荐调整（元认知控制器的输入；与调节旋钮 id 一一对应） */
interface RecommendedAdjustment {
  /** 调节旋钮 id（如 'evolver.mutationRate'） */
  knob: string;
  label: string;
  direction: 'up' | 'down';
  reason: string;
  /** 0~1，越高越优先 */
  priority: number;
}
/** 心智报告（第四阶段验收核心结构） */
interface MentalReport {
  /** ISO 8601 时间戳（人类审查友好） */
  timestamp: string;
  /** 报告序号（趋势分析用；随报告累积单调递增） */
  reportIndex: number;
  /** 数值时间戳（毫秒） */
  generatedAt: number;
  strategyPerformance: StrategyPerformanceSummary;
  memoryQuality: MemoryQualitySummary;
  evolverEfficiency: EvolverEfficiencySummary;
  systemStability: SystemStabilitySummary;
  improvementEvidence: ImprovementEvidence[];
  recommendedAdjustments: RecommendedAdjustment[];
  /** 关键指标趋势外推（≥ minForecastHistory 份历史报告后产出） */
  forecasts?: MetricForecast[];
  /** 前瞻性风险：预测越限 → 建议在指标仍健康时提前调整 */
  proactiveRisks?: ProactiveRisk[];
  /** 旋钮调整有效性（Bandit 学习器快照；需编排层注入元认知状态采集器） */
  knobEffectiveness?: KnobEffectiveness[];
  /** 元认知层自察：熔断器 / 安全包络 / 学习器 / 稳态带（系统对自身调整机制的认知） */
  metaStability?: MetaStabilitySummary;
}
/** 调整效果判定指标（旋钮与指标的显式关联） */
type JudgeMetric = 'operationalSuccessRate' | 'discoveryRate' | 'proceduralGrowth' | 'pendingDistillation' | 'survivalRate';
/** 审计日志条目（所有自动/手动调整全量留痕） */
interface AuditEntry {
  id: string;
  timestamp: number;
  type: 'adjust' | 'commit' | 'rollback' | 'manual-override' | 'freeze' | 'skip' | 'circuit-breaker';
  /** 调节旋钮 id */
  knob?: string;
  from?: number;
  to?: number;
  reason: string;
  /** 效果判定记录（commit / rollback 时填写） */
  effect?: {
    metric: JudgeMetric;
    before: number;
    after: number;
    /** after - before（按指标原符号） */
    delta: number;
    /** true = 未劣化（保留）；false = 劣化超容忍（回滚） */
    good: boolean;
  };
  /** 2.0：护栏指标记录（操作环成功率综合判定） */
  guardrail?: {
    metric: 'operationalSuccessRate';
    before: number;
    after: number;
    delta: number;
    violated: boolean;
  };
  /** 2.0：调整来源（reactive 规则反应式 / proactive 预测前瞻式） */
  source?: 'reactive' | 'proactive';
  /** 关联的心智报告序号 */
  reportIndex?: number;
}
/** 调整报告（evaluateAndAdjust 产物） */
interface AdjustmentReport {
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 本轮基于的心智报告序号 */
  reportIndex: number;
  /**
   * 本轮状态机结论：
   * - adjusted：应用了新调整（进入观察窗）
   * - observing：观察窗内等待更多报告
   * - committed：观察期通过，调整保留生效
   * - rolled-back：观察期判定劣化，自动回滚
   * - no-op：无可执行的推荐
   * - frozen：自动调整被冻结（手动接管）
   */
  status: 'adjusted' | 'observing' | 'committed' | 'rolled-back' | 'no-op' | 'frozen';
  /** 本轮应用的调整（保守原则：每轮至多 maxAdjustmentsPerRound 个） */
  applied: Array<{
    knob: string;
    label: string;
    from: number;
    to: number;
    reason: string;
    source?: 'reactive' | 'proactive';
  }>;
  /** 本轮自动回滚的调整 */
  rolledBack?: {
    knob: string;
    from: number;
    to: number;
    reason: string;
    effect: NonNullable<AuditEntry['effect']>;
  };
  /** 本轮判定保留的调整 */
  committed?: {
    knob: string;
    effect: NonNullable<AuditEntry['effect']>;
  };
  /** 观察窗进度 */
  observation?: {
    knob: string;
    reportsSeen: number;
    reportsNeeded: number;
  };
  /** no-op / frozen 时的原因说明 */
  skippedReason?: string;
  /** 本轮依据的心智报告（人类审查入口） */
  mentalReport: MentalReport;
}
/** 回滚结果（rollbackLastAdjustment 产物） */
interface RollbackResult {
  success: boolean;
  /** 回滚的旋钮 id（失败为空） */
  knob?: string;
  /** 回滚前取值 */
  from?: number;
  /** 回滚后取值 */
  to?: number;
  reason: string;
  message: string;
}
/** 元认知控制器状态（运维可观测） */
interface MetaControllerState {
  /** 自动调整全局冻结开关 */
  frozen: boolean;
  /** 手动接管（冻结自动调整）的旋钮 id 集合 */
  manuallyFrozenKnobs: string[];
  /** 2.0：熔断器面板（连续自动回滚的旋钮） */
  circuitBreakers: CircuitBreakerInfo[];
  /** 2.0：全局熔断标记（连续自动回滚触发，区别于手动冻结） */
  frozenByBreaker: boolean;
  /** 2.0：调参策略学习器快照 */
  learner: {
    totalTrials: number;
    arms: number;
    /** 平均学习置信权重（0=纯规则排序，1=完全信任学习结果） */
    explorationWeight: number;
    effectiveness: KnobEffectiveness[];
  };
  /** 2.0：安全包络快照（经验学习的安全区间） */
  safeEnvelopes: SafeEnvelopeInfo[];
  /** 观察窗中的待判定调整（无则空） */
  pending?: {
    knob: string;
    from: number;
    to: number;
    reason: string;
    reportsSeen: number;
    reportsNeeded: number;
    judgeMetric: JudgeMetric;
    baselineMetricValue: number;
  };
  /** 旋钮面板快照（当前值 / 边界 / 是否手动接管 / 是否熔断） */
  knobs: Array<{
    id: string;
    label: string;
    category: string;
    current: number;
    min: number;
    max: number;
    step: number;
    manuallyFrozen: boolean;
    /** 2.0：是否被熔断器冻结 */
    breakerTripped: boolean;
  }>;
  /** 最近审计条目（降序？否——按时间升序返回尾部） */
  auditTrail: AuditEntry[];
  totalAdjustments: number;
  totalRollbacks: number;
  totalCommits: number;
}
/** 趋势预测覆盖的指标（判定指标 + 综合稳定分） */
type TrendMetric = JudgeMetric | 'stabilityScore';
/** 单指标趋势外推（报告历史最小二乘拟合） */
interface MetricForecast {
  metric: TrendMetric;
  /** 每期变化量（最小二乘斜率；正 = 上升） */
  slopePerReport: number;
  /** 当前取值（最新报告） */
  currentValue: number;
  /** 外推期数 */
  horizon: number;
  /** horizon 期后的预测值 */
  predictedValue: number;
  /** 拟合优度 0~1 */
  r2: number;
  /** 置信度（历史点数 × R² 决定） */
  confidence: 'low' | 'medium' | 'high';
  /** 预测越限：风险阈值将在 horizon 内被穿越 */
  crossesRiskThreshold?: {
    threshold: number;
    direction: 'above' | 'below';
    /** 预计第几期越限 */
    withinReports: number;
  };
}
/** 前瞻性风险（预测越限 → 在指标仍健康时提前调整） */
interface ProactiveRisk {
  metric: TrendMetric;
  /** 人类可读描述 */
  description: string;
  /** 支撑该风险的预测 */
  forecast: MetricForecast;
  /** 紧迫度 0~1（越限越近越高） */
  urgency: number;
  /** 建议调整的旋钮 id */
  suggestedKnob: string;
  suggestedDirection: 'up' | 'down';
}
/** 旋钮调整有效性（「旋钮 × 方向」= 一个学习臂） */
interface KnobEffectiveness {
  /** 旋钮 id */
  knob: string;
  direction: 'up' | 'down';
  /** 该臂的判定指标 */
  judgeMetric: JudgeMetric;
  /** 试验次数（已判定的调整次数） */
  trials: number;
  commits: number;
  rollbacks: number;
  /** 试验成功率 = commits / trials */
  successRate: number;
  /** 平均效果增量（按指标原符号） */
  avgEffectDelta: number;
  /** 贝叶斯平滑有效性评分（乐观先验；冷启动臂更受探索青睐） */
  effectivenessScore: number;
}
/** 熔断器状态（连续自动回滚 → 冻结该旋钮的自动调整） */
interface CircuitBreakerInfo {
  knob: string;
  /** 连续自动回滚次数（判定保留后清零） */
  consecutiveRollbacks: number;
  /** 是否已熔断 */
  tripped: boolean;
  trippedAt?: number;
  reason?: string;
}
/** 经验安全包络（从 commit/rollback 历史学习的旋钮安全区间） */
interface SafeEnvelopeInfo {
  knob: string;
  min: number;
  max: number;
  /** default 旋钮原始边界 / learned 从好值学习 */
  source: 'default' | 'learned';
  /** 学习样本数（commit 的取值数） */
  sampleCount: number;
  /** 已知劣化取值（在该值上发生过自动回滚） */
  knownBadValues: number[];
}
/** 稳态目标带（判定指标的期望区间；偏离越远 → 调整步长越大） */
type HomeostasisBands = Partial<Record<JudgeMetric, {
  min: number;
  max: number;
}>>;
/** 单指标稳态状态 */
interface HomeostasisStatus {
  metric: TrendMetric;
  band: {
    min: number;
    max: number;
  };
  current: number;
  /** 归一化偏离（带内为 0；带外按带宽归一，可 >1） */
  deviation: number;
  state: 'in-band' | 'near-edge' | 'out-of-band';
}
/** 元认知层自察（系统对自身调整机制的认知） */
interface MetaStabilitySummary {
  /** 熔断器面板 */
  circuitBreakers: CircuitBreakerInfo[];
  /** 手动全局冻结 */
  globalFrozen: boolean;
  /** 全局熔断（连续回滚自动触发） */
  frozenByBreaker: boolean;
  /** 各旋钮安全包络 */
  safeEnvelopes: SafeEnvelopeInfo[];
  /** 学习器概况 */
  learner: {
    totalTrials: number;
    arms: number;
    explorationWeight: number;
  };
  /** 稳态目标带状态 */
  homeostasis: HomeostasisStatus[];
}
//#endregion
//#region src/contracts.d.ts
/** 记忆支柱契约：三类数据的读写与生命周期 */
interface IMemoryStore {
  findPattern(taskType: string, complexity: number, features?: string[]): TaskPatternMemory | undefined;
  recordSuccess(params: RecordSuccessParams): void;
  recordFailure(params: RecordFailureParams): void;
  getTopPatterns(limit?: number): TaskPatternMemory[];
  getAllTaskPatterns(): TaskPatternMemory[];
  upsertPattern(pattern: TaskPatternMemory): 'created' | 'updated';
  removePattern(fingerprint: string): boolean;
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
  recordDecisionFeedback(params: RecordDecisionFeedbackParams): void;
  getRecentFeedback(limit?: number): DecisionFeedback[];
  getDecisionSuccessRate(signalType: string): {
    total: number;
    successRate: number;
    avgOutcome: string;
  };
  appendFeedback(feedback: DecisionFeedback): boolean;
  distillExperience(minConfidence?: number): DistilledStrategy[];
  getStrategies(taskType: string, limit?: number): DistilledStrategy[];
  getAllStrategies(): DistilledStrategy[];
  recordStrategyOutcome(strategyId: string, success: boolean): void;
  findSemanticMemory(taskType: string, context?: {
    features?: string[];
    complexity?: number;
    length?: number;
    tokenCost?: number;
  }): SemanticMemory | undefined;
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
  findProceduralMemory(kind: ProceduralMemory['kind'], taskType: string, context?: {
    features?: string[];
    complexity?: number;
    length?: number;
    tokenCost?: number;
    outcome?: string;
    rootCause?: string;
  }): ProceduralMemory | undefined;
  getProceduralMemories(taskType: string, kind?: ProceduralMemory['kind'], limit?: number): ProceduralMemory[];
  getAllProceduralMemories(): ProceduralMemory[];
  /**
   * 插入或更新程序记忆（第二阶段升级：证据合并增强 + 冲突消解，语义同 upsertSemanticMemory）
   * @returns 'created' / 'updated' / 'merged' / 'superseded' / 'duplicate'
   */
  upsertProceduralMemory(memory: ProceduralMemory): 'created' | 'updated' | 'duplicate' | 'merged' | 'superseded';
  removeProceduralMemory(id: string): boolean;
  recordProceduralOutcome(id: string, success: boolean): void;
  /** 情景事件水位：距上次蒸馏新增的情景事件数（成功+失败均计） */
  getDistillationProgress?(): {
    episodicEventCount: number;
    lastDistillationEventCount: number;
    pendingSinceLastDistillation: number;
  };
  /** 蒸馏完成检查点：刷新水位（distillKnowledge 成功后调用） */
  noteDistillationCheckpoint?(): void;
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
  applyForgettingCurve(halfLifeDays?: number, forgetThreshold?: number): {
    decayed: number;
    forgotten: number;
  };
  fullTextSearch?(query: string, limit?: number): MemorySearchHit[];
  vectorSearch?(query: string, limit?: number): MemorySearchHit[];
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
interface IReflector {
  reflectOnOutcome(params: {
    signal: Signal;
    plan: ExecutionPlan;
    result: PlanExecutionResult;
    /** 本次注入/应用的蒸馏策略 id 列表（策略反馈闭环） */
    appliedStrategies?: string[];
    /** 第二阶段升级：本次经验检索命中的语义/程序记忆 id（三层记忆应用反馈闭环） */
    appliedMemoryIds?: {
      semantic?: string[];
      procedural?: string[];
    };
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
  distillKnowledge(options?: {
    force?: boolean;
  }): Promise<DistillationReport>;
}
/** 优化支柱契约：下一次调度前基于记忆产出推荐 */
interface IOptimizer {
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
  lookupExperience(taskType: string, complexity: number, features?: string[], context?: {
    length?: number;
    tokenCost?: number;
  }): ExperienceLookup;
  /** 经验快路径：高置信度模式直接召回历史最优成功计划 */
  recallPlan(lookup: ExperienceLookup, objective: string): ExecutionPlan | undefined;
  /** 混合检索（模糊 + FTS5 + 向量 + 图联想），缺省实现可省略 */
  hybridSearch?(query: string, taskType: string, complexity: number, limit?: number): MemorySearchHit[];
}
/**
 * 安全沙盒契约：新策略上线路前的隔离验证环境
 *
 * 隔离性：评估全程离线（不调 LLM、不写记忆、不接触操作环调度器），
 * 不阻塞正常任务调度；同一策略 + 任务集 + 随机种子 → 评估结果可复现。
 */
interface ISandbox {
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
interface IPolicyEvolver {
  /** 变异：产出候选策略变体 */
  generateCandidates(currentPolicy: Policy): Promise<Policy[]>;
  /** 选择（评估）：沙盒隔离评估单个候选 */
  evaluateCandidate(policy: Policy, sandbox: ISandbox): Promise<EvaluationReport>;
  /** 保留：择优返回可部署候选（无合格候选返回 null） */
  selectBest(candidates: Policy[], reports: EvaluationReport[]): Promise<Policy | null>;
  /** 部署：策略热切换到操作环 */
  deployPolicy(policy: Policy): Promise<void>;
}
/**
 * 自我建模契约：系统对自身运行状态的持续观察与结构化认知
 *
 * 双环架构的外环感知端：内环（执行 → 反思 → 记忆 → 优化 → 进化）
 * 的运行质量被持续采集为系统指标，并周期性凝结为心智报告——
 * 策略的优势与盲点、记忆体系的增长与退化、进化器的发现速度与
 * 存活率、系统稳定性与风险点，以及可机器验证的自我改进证据。
 */
interface ISelfModel {
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
interface IMetaCognitiveController {
  /** 评估最新心智报告并推进调整状态机（应用 / 观察 / 判定保留 / 自动回滚） */
  evaluateAndAdjust(): Promise<AdjustmentReport>;
  /** 手动回滚最近一次调整（观察中或已提交） */
  rollbackLastAdjustment(): Promise<RollbackResult>;
}
//#endregion
//#region src/policy/policy-evolver.d.ts
interface PolicyEvolverConfig {
  /** 每轮进化的候选变体数（缺省 6） */
  candidateCount?: number;
  /** 每个数值基因的变异概率（缺省 0.6） */
  mutationRate?: number;
  /** 变异强度基准（相对基因取值范围的比例，缺省 0.25；实际 × sigmaScale 自适应） */
  mutationStrength?: number;
  /** 布尔基因的翻转概率（缺省 0.25） */
  booleanFlipRate?: number;
  /** 部署门禁：相对 baseline 的最小收益提升（缺省 0.02，作用于 gainLCB） */
  minGain?: number;
  /** 种群（Hall of Fame）容量（缺省 6） */
  populationSize?: number;
  /** 交叉候选占比（缺省 0.34；种群 ≥2 时生效） */
  crossoverRate?: number;
  /** 规则变异概率（每个候选独立触发，缺省 0.3） */
  ruleMutationRate?: number;
  /** 探索者候选占比——边界内随机个体注入多样性（缺省 0.17） */
  explorerRate?: number;
  /** 规则变异可引用的已知任务类型（缺省空 = 规则用复杂度/特征条件） */
  knownTaskTypes?: string[];
  /** 金丝雀：最少观察样本数（缺省 5） */
  canaryMinSamples?: number;
  /** 金丝雀：晋升正式所需样本数（缺省 15） */
  canaryPromoteSamples?: number;
  /** 金丝雀：成功率劣化容忍（缺省 0.1） */
  canarySuccessTolerance?: number;
  /** 金丝雀：质量劣化容忍（缺省 0.05） */
  canaryQualityTolerance?: number;
  /** 进化历史持久化路径（缺省不持久化） */
  persistPath?: string;
  /** 随机源（测试可注入确定性实现） */
  rng?: () => number;
  /** 策略部署回调（热切换落地：更新 ModelScheduler/Optimizer 等） */
  onDeploy?: (policy: Policy) => void;
  /** 金丝雀决策回调（自动回滚 / 晋升时通知操作环） */
  onCanaryDecision?: (decision: {
    action: 'rolled-back' | 'promoted';
    policyId: string;
    reason: string;
  }) => void;
  /** 进化周期完成回调（可观测性） */
  onCycle?: (report: EvolutionCycleReport) => void;
}
/** 单轮进化周期报告 */
interface EvolutionCycleReport {
  /** 本轮进化代际 */
  generation: number;
  /** 父代策略 */
  parentPolicyId: string;
  /** 候选来源构成（mutation/crossover/rule-mutation/explorer） */
  candidateOrigins: Record<string, number>;
  /** 各候选评估摘要（含淘汰原因） */
  candidates: Array<{
    policyId: string;
    reward: number;
    gain: number;
    /** 收益置信下界（多种子统计门禁） */
    gainLCB?: number;
    deployable: boolean;
    risks: number;
    regressions: number;
  }>;
  /** 胜出并部署的策略 id（无合适候选为空） */
  deployedPolicyId?: string;
  /** 本轮结论（人类可读） */
  summary: string;
}
/** 金丝雀状态（部署后观察窗） */
interface CanaryState {
  policyId: string;
  deployedAt: number;
  status: 'active' | 'promoted' | 'rolled-back';
  /** 沙盒期望基线（部署时快照） */
  expectedSuccessRate: number;
  expectedAvgQuality: number;
  /** 操作环真实回报累计 */
  samples: number;
  successes: number;
  qualitySum: number;
  /** 状态变更原因（回滚/晋升时填写） */
  reason?: string;
}
/** 进化器状态报告（运维可观测） */
interface PolicyEvolverStatus {
  currentPolicy: Policy;
  /** 已部署策略链（按部署时间升序；含回滚标记） */
  deployedHistory: Array<{
    id: string;
    version: number;
    generation: number;
    origin: string;
    gain?: number;
    deployedAt: number;
    rolledBackAt?: number;
  }>;
  /** 种群精英（按适应度降序） */
  population: Array<{
    id: string;
    origin: string;
    generation: number;
    fitnessScore?: number;
  }>;
  /** 自适应变异步长系数（1 = 基准强度） */
  sigmaScale: number;
  /** 金丝雀观察窗（无活跃金丝雀为空） */
  canary?: CanaryState;
  /** 评估过的候选总数 */
  totalCandidatesEvaluated: number;
  /** 进化总轮数 */
  totalCycles: number;
  /** 最近一轮周期报告（无则为空） */
  lastCycle?: EvolutionCycleReport;
}
/**
 * 策略进化器（implements IPolicyEvolver）
 *
 * 被 index.ts 持有：autonomy-loop 进化段定期触发 runEvolutionCycle()，
 * 或外部经 evolve_policy Tool 手动触发；deployPolicy 经 onDeploy 回调
 * 热切换操作环（ModelScheduler.updatePolicy 等），金丝雀观察窗内由
 * reportOperationalOutcome 持续接收操作环真实结果。
 */
declare class PolicyEvolver implements IPolicyEvolver {
  private config;
  private current;
  /** 部署回滚栈：金丝雀失败时恢复 */
  private previousPolicy?;
  private deployedHistory;
  /** 种群精英存档（Hall of Fame，按 fitness.score 降序） */
  private population;
  private evaluatedReports;
  private cycleReports;
  private policyCounter;
  private totalCandidatesEvaluated;
  private totalCycles;
  /** 自适应步长系数（1/5 法则驱动） */
  private sigmaScale;
  /** 近 10 轮部署成败窗口（自适应步长依据） */
  private selectionWindow;
  /** 金丝雀观察窗（无活跃金丝雀为空） */
  private canary?;
  private rng;
  private evolving;
  constructor(config?: PolicyEvolverConfig, baseline?: Policy);
  /** 当前生效策略（操作环据此调度） */
  getCurrentPolicy(): Policy;
  /** 进化器状态报告 */
  getStatus(): PolicyEvolverStatus;
  /** 种群精英（只读快照） */
  getPopulation(): Policy[];
  /** 策略评估历史（policyId → 最近一次评估报告） */
  getEvaluationHistory(): EvaluationReport[];
  /**
   * 运行时调参入口（第四阶段：元认知控制器调节进化机制本身）
   *
   * 仅接受数值类进化参数（mutationRate / minGain / candidateCount 等），
   * 回调与持久化路径不可经此变更；下一进化周期即按新参数运行。
   */
  updateConfig(patch: Partial<PolicyEvolverConfig>): void;
  /** 数值进化参数快照（元认知旋钮 read 端；只读） */
  getTunableParams(): Readonly<{
    candidateCount: number;
    mutationRate: number;
    mutationStrength: number;
    booleanFlipRate: number;
    minGain: number;
    populationSize: number;
    crossoverRate: number;
    ruleMutationRate: number;
    explorerRate: number;
    canaryMinSamples: number;
    canaryPromoteSamples: number;
    canarySuccessTolerance: number;
    canaryQualityTolerance: number;
  }>;
  /**
   * 变异与交叉：产出混合候选（质级升级）
   *
   * 候选构成（candidateCount 个）：
   * - ⌈candidateCount × crossoverRate⌉ 个交叉候选（种群 ≥2 时；标量均匀交叉 +
   *   规则子集合并，双亲谱系可追溯）
   * - ⌊candidateCount × explorerRate⌋ 个探索者（边界内随机，注入多样性）
   * - 其余为当前策略/种群精英的高斯变异（sigmaScale 自适应）+ 规则变异
   */
  generateCandidates(currentPolicy: Policy): Promise<Policy[]>;
  /** 选择（评估）：在沙盒中隔离评估候选（与当前策略对比，多种子统计） */
  evaluateCandidate(policy: Policy, sandbox: ISandbox): Promise<EvaluationReport>;
  /**
   * 保留（择优）：deployable 且 gainLCB 最高且 ≥ minGain 的候选胜出
   *
   * 报告中 deployable 已含「零风险 + 零回归 + gainLCB ≥ 0」统计门禁，
   * 此处再叠加进化器级 minGain 阈值（双保险）；胜出者回填适应度并入种群。
   */
  selectBest(candidates: Policy[], reports: EvaluationReport[]): Promise<Policy | null>;
  /**
   * 部署：胜出策略热切换到操作环并进入金丝雀观察窗
   *
   * 经 onDeploy 回调落地（无需重启）；部署记录写入可追溯历史并持久化；
   * 金丝雀基线取沙盒评估期望，观察窗内 reportOperationalOutcome 持续校验。
   */
  deployPolicy(policy: Policy): Promise<void>;
  /**
   * 操作环真实结果回报（金丝雀观察窗，4.0 Wilson 统计判定）
   *
   * 单侧噪声不回滚：仅当成功率 Wilson 上界（乐观边界）也跌破
   * 期望 − 容忍 时才统计确认劣化 → 回滚（如 7/10 = 0.7 的 UB ≈ 0.89
   * 高于底线 → 继续观察；0/5 的 UB ≈ 0.43 → 立即回滚）。
   * 晋升：样本达 canaryPromoteSamples 且未确认劣化、点估计不破底线，
   * 且 Wilson 下界（保守边界）亦不破底线 → 统计达标晋升；下界未达标
   * 则继续累积样本（宁可多观察，不冒进上线）。
   * @returns 金丝雀状态（无活跃金丝雀返回 undefined）
   */
  reportOperationalOutcome(outcome: {
    success: boolean;
    quality?: number;
  }): CanaryState | undefined;
  /** 金丝雀自动回滚：恢复前一策略并热切换（操作环安全兜底） */
  private rollbackCanary;
  /** 运维手动回滚（金丝雀外强制恢复前一策略） */
  rollbackLastDeployment(): boolean;
  /**
   * 运行一轮完整进化周期（变异/交叉 → 沙盒评估 → 择优 → 部署）
   *
   * 自主循环定期调用 / 外部 Tool 手动触发；进化中重复调用返回进行中报告。
   * 周期尾部按 1/5 法则自适应调整变异步长。沙盒全程离线，不阻塞操作环。
   */
  runEvolutionCycle(sandbox: ISandbox): Promise<EvolutionCycleReport>;
  /** 高斯变异：数值基因按概率扰动（×sigmaScale）+ 钳制边界；布尔基因按概率翻转；规则基因增/删/改 */
  private mutatePolicy;
  /** 规则变异：无规则→增加；有规则→随机改一条或删一条 */
  private mutateRules;
  /** 随机合成一条规则（复杂度/特征/任务类型条件 + 随机动作） */
  private randomRule;
  /** 种群内随机双亲交叉（种群 <2 返回 null） */
  private crossoverRandom;
  /** 双亲交叉：标量基因逐位均匀选取 + 规则子集合并（双亲谱系可追溯） */
  private crossoverPolicies;
  /** 探索者：全基因边界内随机（注入种群多样性，跳出局部最优；origin 专属标记，谱系不误导为变异） */
  private explorerPolicy;
  /** 启动时确保种群含当前策略 */
  private seedPopulation;
  /**
   * 种群更新（4.0 多样性保持：拥挤去重选择）
   *
   * 候选按适应度竞争入种群，但与已入选个体基因距离 < DIVERSITY_RADIUS 的
   * 近重复个体被跳过（适应度共享的贪婪近似）——种群由「高适应度且彼此
   * 基因相异」的个体构成，避免单一基因型霸占种群导致交叉退化自交。
   * 池内相异个体不足容量时回填近重复（保持容量的降级策略）。
   */
  private updatePopulation;
  /**
   * 基因距离（0~1）：标量基因归一化绝对距离 + 布尔差异 + 规则集合
   * Jaccard 距离的等权平均——衡量两个策略在基因空间的相异度。
   */
  private geneDistance;
  /** 持久化进化状态（原子写；失败不阻断进化流程） */
  private persist;
  /** 启动时恢复上次部署策略与种群（无持久化文件或损坏时保持基准） */
  private loadPersisted;
}
//#endregion
//#region src/policy/sandbox.d.ts
/**
 * 模型×任务校准条目：用操作环真实历史锚定沙盒模拟
 *
 * observedAvgQuality = 记忆库模型画像中该模型在该任务类型的历史平均质量分；
 * samples = 历史调用次数（≥ minCalibrationSamples 才启用锚定）。
 *
 * 3.0 并行旁路（贝叶斯化）：posteriorQuality / effectiveSamples / drift
 * 由 buildCalibrationFromMemory 从统一证据内核填充——手工/旧格式条目
 * 缺省时 calibratedFit 回退 legacy 口径（observedAvgQuality × samples），
 * 行为与升级前逐位一致。
 */
interface SimCalibrationEntry {
  observedAvgQuality: number;
  samples: number;
  /** 3.0：贝叶斯后验质量（时间加权 EMA 质量向 0.5 先验收缩；小样本自动保守） */
  posteriorQuality?: number;
  /** 3.0：时间衰减后有效样本量（校准权重依据——旧证据自动让位） */
  effectiveSamples?: number;
  /** 3.0：近期能力漂移（加权成功率 − 裸成功率；沙盒感知模型修复/退化） */
  drift?: number;
}
/** 校准表：modelId → taskType → 条目 */
type SimCalibration = Record<string, Record<string, SimCalibrationEntry>>;
/** 启用校准锚定所需的最小历史样本数 */
declare const MIN_CALIBRATION_SAMPLES = 3;
/**
 * 从长期记忆构建校准表（index.ts 注入沙盒；进化周期之间可刷新）
 *
 * 3.0 贝叶斯化：在保留裸口径（observedAvgQuality/samples）的同时，
 * 从 getBayesianEstimate 附带时间加权证据视图——
 * - posteriorQuality = (n·emaQuality + 1·0.5) / (n+1)：近期敏感 + 小样本收缩
 * - effectiveSamples：30 天半衰期衰减后的等效观测数（校准权重依据）
 * - drift：能力漂移让沙盒感知「模型变了」（配合 calibratedFit 漂移倾斜）
 */
declare function buildCalibrationFromMemory(memory: LongTermMemory): SimCalibration;
interface SandboxConfig {
  /** 综合收益中成功率的权重（缺省 0.35） */
  successWeight?: number;
  /** 质量权重（缺省 0.35） */
  qualityWeight?: number;
  /** 成本权重（缺省 0.2；延迟权重 = 1 - 其余三项） */
  costWeight?: number;
  /** 成本归一化基准：单任务 token 数达到该值视为满成本（缺省 4000） */
  costNormTokens?: number;
  /** 延迟归一化基准：单任务延迟达到该值视为满延迟（缺省 5000ms） */
  latencyNormMs?: number;
  /** 模拟成功质量阈值（缺省 0.55） */
  successQualityThreshold?: number;
  /** 成功率的最大允许回归幅度（缺省 0.05） */
  regressionSuccessTolerance?: number;
  /** 质量的最大允许回归幅度（缺省 0.03） */
  regressionQualityTolerance?: number;
  /** token 成本的最大允许涨幅（相对 baseline，缺省 1.5 倍） */
  regressionCostTolerance?: number;
  /** 多种子评估的种子数（缺省 3；1 = 关闭统计门禁） */
  evaluationSeeds?: number;
  /** 历史校准表（缺省空 = 纯合成模拟） */
  calibration?: SimCalibration;
}
/** 单任务模拟结果 */
interface TaskSimulation {
  success: boolean;
  quality: number;
  latencyMs: number;
  tokens: number;
  decomposed: boolean;
  ensembleUsed: boolean;
  chosenModels: string[];
}
/**
 * 策略模拟执行器
 *
 * 给定策略参数 + 任务 + 模型快照，模拟「上下文规则解析 → 评分 → 分解决策 →
 * 选模型 → 组合决策 → 产出」：
 * - 有效参数：resolveEffectiveParams(params, task) —— 规则基因在此承受选择压力
 * - 产出质量 = 校准后能力适配 − 复杂度惩罚 + 稳定噪声（ensemble 取均值 + 多样性增益）
 * - 分解降低单节点复杂度（子复杂度 = c / n^0.7），但增加协调开销（延迟 +15%、token +10%）
 * - 评分调用与操作环共享 scoreModelWithPolicy → 沙盒保真
 */
declare class PolicySimulator {
  private models;
  private config;
  private modelIndex;
  constructor(models: SimModelStatus[], config?: SandboxConfig);
  /** 模型快照（只读） */
  getModels(): SimModelStatus[];
  /**
   * 校准后的能力适配分：真实历史锚定合成画像
   *
   * 3.0 贝叶斯口径（条目携带证据字段时）：
   * - 权重 w = min(0.6, effectiveSamples/50)：时间衰减后的等效样本——
   *   旧证据自动让位，长期不用的模型不再被陈旧历史过度锚定
   * - 锚定值 = posteriorQuality：近期敏感 EMA + 小样本向先验收缩
   * - 漂移倾斜：|drift| 大的模型按近期能力变化微调（±0.05 钳制），
   *   「模型修好了 / 模型退化了」在沙盒中被真实感知
   *
   * 兼容：旧格式条目（无证据字段）走 legacy 口径，行为与升级前逐位一致。
   */
  private calibratedFit;
  /**
   * 稳定噪声（FNV-1a 哈希 → [-0.05, 0.05)）
   *
   * 同一「任务×模型×种子」组合恒定同一噪声：策略变体与 baseline 在同一任务上
   * 的随机扰动完全一致，评估差异纯粹来自策略本身（选择压力不失真）。
   */
  private stableNoise;
  /** 按策略给全部候选模型评分（降序；使用上下文有效参数） */
  rankModels(params: SchedulerPolicyParams, task: SandboxTask): Array<{
    id: string;
    score: number;
  }>;
  /** 模拟执行单个任务（seedSalt 区分多种子轮次） */
  simulate(params: SchedulerPolicyParams, task: SandboxTask, seedSalt?: number): TaskSimulation;
}
/**
 * 生成合成对抗任务（测鲁棒性）
 *
 * 四类压力模式：
 * 1. 极端复杂：高复杂度 + 多特征 + 超长文本（压测分解与集成决策、规则条件匹配）
 * 2. 冷启动：从未见过的任务类型（压测评分函数的缺省路径）
 * 3. 特征密集：特征标签爆炸（压测规则特征条件匹配）
 * 4. 极简任务：低复杂度短文本（压测过度调度/过度分解）
 */
declare function generateAdversarialTasks(knownTaskTypes?: string[], rng?: () => number): SandboxTask[];
/**
 * 从长期记忆提取历史任务集（回放评估的数据来源）
 *
 * 每个任务模式（含成功与失败记录）至少产出 1 个回放任务；
 * 模式指纹 `taskType::complexity::features` 解析回任务上下文。
 */
declare function extractReplayTasks(memory: LongTermMemory): SandboxTask[];
/**
 * 安全沙盒（implements ISandbox）
 *
 * 被 PolicyEvolver 调用：evaluate(policy, baseline) 在隔离环境重放任务集，
 * 产出收益/风险/回归三段式评估报告（多种子统计门禁）。全程离线，不阻塞操作环调度。
 */
declare class Sandbox implements ISandbox {
  private simulator;
  private tasks;
  private config;
  constructor(params: {
    models: SimModelStatus[];
    tasks: SandboxTask[];
    config?: SandboxConfig;
  });
  /** 当前任务集（可观测） */
  getTaskSet(): SandboxTask[];
  /** 替换任务集（进化周期之间可刷新历史回放集） */
  setTaskSet(tasks: SandboxTask[]): void;
  /** 刷新校准表（操作环真实结果持续锚定模拟器） */
  setCalibration(calibration: SimCalibration): void;
  /**
   * 运行时调参入口（第四阶段：元认知控制器调节验证严格度）
   *
   * 经此调整多种子统计门禁（evaluationSeeds：种子越多 LCB 越严格）、
   * 回归容忍（regression*）与 reward 权重；下次评估即生效。
   * calibration 字段不可经此变更（走 setCalibration）。
   */
  updateConfig(patch: SandboxConfig): void;
  /** 当前评估配置快照（元认知旋钮 read 端；只读） */
  getConfig(): Readonly<SandboxConfig>;
  /**
   * 评估策略（可选与 baseline 对比；多种子统计）
   *
   * 流程：参数边界风险检查 → 多种子全任务集模拟（逐种子聚合求均值）→
   * reward/gain 均值与标准差 → 置信下界 LCB → 回归检测 → 部署门禁
   * （gainLCB ≥ 0：97.5% 置信下界上收益仍非负，防单种子过拟合）
   */
  evaluate(policy: Policy, baseline?: Policy): Promise<EvaluationReport>;
  /** 在全部种子上模拟执行（每种子完整跑一遍任务集） */
  private runAllSeeds;
  /** 单种子模拟执行全任务集并聚合指标（单个任务异常记为风险 + 失败样本） */
  private simulateAll;
  /** 综合收益：成功率 + 质量 + 成本效率 + 延迟效率 加权（归一化到 0~1） */
  private computeReward;
}
//#endregion
//#region src/meta/self-model.d.ts
/** 自我建模配置 */
interface SelfModelConfig {
  /** 报告历史持久化路径（缺省不持久化，仅内存趋势） */
  persistPath?: string;
  /** 内存中保留的报告份数（持久化不受限；缺省 50） */
  reportHistoryLimit?: number;
  /** 盲点/优势判定的最小样本数（缺省 3，防小样本噪声） */
  minSamplesPerTaskType?: number;
  /** 操作环表现统计的决策反馈窗口（缺省 100 条） */
  feedbackWindow?: number;
  /** 趋势外推期数（缺省 3） */
  forecastHorizon?: number;
  /** 产出预测所需的最少历史点数（缺省 3） */
  minForecastHistory?: number;
  /** 异常检测 z 分数阈值（缺省 2.5） */
  anomalyZThreshold?: number;
  /** 稳态目标带（未配置的指标不做稳态评估；元认知控制器同款配置用于步长自适应） */
  homeostasisBands?: HomeostasisBands;
}
/** 数据采集器（由编排层桥接到真实组件；全部同步只读） */
interface SelfModelCollectors {
  /** 策略进化器状态（进化环素材） */
  getEvolverStatus(): PolicyEvolverStatus;
  /** 记忆库分表条数 */
  getMemoryStats(): {
    patterns: number;
    semantic: number;
    procedural: number;
    strategies: number;
    profiles: number;
    feedback: number;
  };
  /** 记忆库全局统计 */
  getGlobalStats(): {
    totalExecutions: number;
    totalSuccesses: number;
    totalFailures: number;
    totalTokensUsed: number;
    totalCostEstimate: number;
    averageQualityScore: number;
    averageExecutionTime: number;
  };
  /** 蒸馏水位（可选注入） */
  getDistillationProgress?(): {
    pendingSinceLastDistillation: number;
  } | undefined;
  /** 最近决策反馈（操作环素材） */
  getRecentFeedback(limit?: number): DecisionFeedback[];
  /** 2.0：元认知层状态（调参策略学习器 + 熔断器 + 安全包络；由编排层回注） */
  getMetaLayerState?(): {
    knobEffectiveness?: KnobEffectiveness[];
    metaStability?: Omit<MetaStabilitySummary, 'homeostasis'>;
  } | undefined;
}
/**
 * 稳态偏离计算（self-model 报告与 meta-controller 步长自适应共用）
 *
 * 返回归一化偏离：带内为 0（含近缘 near-edge），带外按带宽归一（可 >1）。
 * 控制器据此量化步长倍率：1 + floor(deviation × 2)，上限 maxStepMultiplier。
 */
declare function computeHomeostasis(band: {
  min: number;
  max: number;
}, current: number): {
  deviation: number;
  state: 'in-band' | 'near-edge' | 'out-of-band';
};
/**
 * 自我建模引擎（implements ISelfModel）
 *
 * 被编排层持有：元认知控制器每轮 evaluateAndAdjust 先调用
 * generateMentalReport 采集最新自我认知；也可经 mental_report Tool
 * 手动触发（人类审查入口）。
 */
declare class SelfModel {
  private config;
  private collectors;
  /** 报告历史（升序；趋势分析与改进证据的对比基线） */
  private history;
  /** 上一报告窗口的单次执行平均 token（趋势检测基线） */
  private lastTokensPerExecution?;
  constructor(params: {
    collectors: SelfModelCollectors;
    config?: SelfModelConfig;
  });
  /** 采集系统指标快照（心智报告的原始素材） */
  getSystemMetrics(): Promise<SystemMetrics>;
  /** 生成心智报告（持续进程：历史累积 → 趋势与改进证据） */
  generateMentalReport(): Promise<MentalReport>;
  /** 报告历史（升序；趋势分析素材） */
  getReportHistory(): MentalReport[];
  /** 最近一份报告 */
  getLatestReport(): MentalReport | undefined;
  /** 趋势数据（关键指标序列，供图表渲染） */
  getTrendSeries(): {
    reportIndex: number[];
    operationalSuccessRate: number[];
    proceduralCount: number[];
    semanticCount: number[];
    discoveryRate: number[];
    stabilityScore: number[];
  };
  /** 人类可读报告（mental_report Tool 输出 / 审查日志） */
  formatReport(report: MentalReport): string;
  /** 操作环指标：反馈窗口聚合 + 按任务类型分组 */
  private buildOperationalMetrics;
  /** 平均发现间隔：相邻部署 deployedAt 差均值（wall-clock） */
  private avgDiscoveryInterval;
  /** 策略表现：版本归因（按 deployedAt 时间窗分配反馈）+ 优势/盲点 */
  private buildStrategyPerformance;
  /** 记忆质量：三层增长趋势 + 蒸馏水位 */
  private buildMemoryQuality;
  /** 进化器效率 */
  private buildEvolverEfficiency;
  /** 稳定性：综合分 + 风险点 */
  private buildStability;
  /** 自我改进证据：与上份报告的机器可验证对比 */
  private buildEvidence;
  /** 规则化诊断 → 推荐调整（仅诊断方向，剂量由元认知控制器保守决定） */
  private recommend;
  private formatDuration;
  /** 从报告提取趋势指标取值 */
  private metricValueOf;
  /**
   * 趋势外推：关键指标最小二乘拟合 → horizon 期预测 + 越限检测
   *
   * 从被动描述（当前值 + 增量）升级为主动预测：指标按当前轨迹
   * 将在 horizon 内穿越风险阈值时产出 crossesRiskThreshold——
   * 前瞻性调整的触发基础（风险发生前行动，而非发生后补救）。
   */
  private buildForecasts;
  /** 最小二乘拟合（返回斜率/截距/R²） */
  private linearFit;
  /** 前瞻性风险：预测越限 → 紧迫度 + 建议旋钮（元认知控制器提前行动） */
  private buildProactiveRisks;
  /** 异常检测：关键指标对自身历史的 z 分数突变（稳定系统的自体噪声基线） */
  private detectAnomalies;
  /** 稳态目标带评估（偏离越远 → 元认知控制器步长越大） */
  private buildHomeostasis;
  private persist;
  private restore;
}
//#endregion
//#region src/meta/meta-controller.d.ts
/** 单个调节旋钮（参数热调整的最小单元） */
interface AdjustmentKnob {
  /** 全局唯一 id（与心智报告 recommendedAdjustments.knob 对齐） */
  id: string;
  /** 人类可读标签 */
  label: string;
  /** 所属子系统（reflector / evolver / sandbox / memory） */
  category: 'reflector' | 'evolver' | 'sandbox' | 'memory';
  /** 允许取值范围 */
  min: number;
  max: number;
  /** 单次保守步长 */
  step: number;
  /** 整数旋钮（如种子数） */
  integer?: boolean;
  /** 读当前值 */
  read(): number;
  /** 写入新值（落地到真实组件；抛异常视为失败） */
  write(value: number): void;
  /** 调整效果判定指标 */
  judgeMetric: JudgeMetric;
  /** 判定指标方向：true 越高越好；false 越低越好 */
  higherIsBetter: boolean;
}
/** 元认知控制器配置 */
interface MetaControllerConfig {
  /** 每轮最大调整数（保守原则；缺省 1） */
  maxAdjustmentsPerRound?: number;
  /** 观察窗：调整后需观察的心智报告份数（缺省 2） */
  observationReports?: number;
  /** 劣化容忍度（judgeMetric 相对劣化超过该值 → 回滚；缺省 0.02） */
  degradationTolerance?: number;
  /** 审计日志持久化路径（缺省不持久化） */
  persistPath?: string;
  /** 内存保留的审计条数（缺省 200） */
  auditLimit?: number;
  /** 调整应用回调（编排层广播 / 日志） */
  onAdjust?: (entry: AuditEntry) => void;
  /** 回滚回调（自动或手动） */
  onRollback?: (entry: AuditEntry) => void;
  /** 判定保留回调 */
  onCommit?: (entry: AuditEntry) => void;
  /**
   * 稳态目标带：判定指标 → 期望区间。
   * 配置后：① 步长随偏离量化放大（1~maxStepMultiplier 档）；
   * ② 心智报告输出稳态带状态。缺省空 = 纯保守固定步长。
   */
  homeostasisBands?: HomeostasisBands;
  /** 稳态自适应步长上限（×step；缺省 3） */
  maxStepMultiplier?: number;
  /** 单旋钮连续自动回滚熔断阈值（缺省 2） */
  breakerThreshold?: number;
  /** 全局连续自动回滚熔断阈值（缺省 3） */
  globalBreakerThreshold?: number;
  /** 前瞻性调整开关（心智报告前瞻风险注入候选；缺省 true） */
  proactiveEnabled?: boolean;
}
/** 学习臂统计（臂 = 旋钮 × 方向） */
interface ArmStats {
  trials: number;
  commits: number;
  rollbacks: number;
  /** 按指标原符号的效果增量累计 */
  effectSum: number;
}
/**
 * 元认知控制器（implements IMetaCognitiveController）
 *
 * 被编排层持有：autonomy-loop 低频触发 evaluateAndAdjust（每 N 轮心跳），
 * 也可经 meta_cognition_* Tool 手动触发/审查/接管。
 */
declare class MetaCognitiveController {
  private config;
  private selfModel;
  private knobs;
  private audit;
  private pending?;
  private frozen;
  private manuallyFrozenKnobs;
  /** 已被回滚过的 adjust 审计 id（手动回滚去重） */
  private rolledBackAdjustIds;
  private counters;
  private auditSeq;
  /** 调参策略学习器（乐观先验 Bandit） */
  private learner;
  /** 安全包络：各旋钮的已验证好取值 / 已知劣化取值 */
  private envelopeGood;
  private envelopeBad;
  /** 熔断器：单旋钮连续自动回滚计数与已熔断旋钮 */
  private breakerCounters;
  private trippedBreakers;
  /** 全局连续自动回滚计数（跨旋钮） */
  private globalRollbackStreak;
  /** 全局熔断标记（区别于手动 frozen） */
  private frozenByBreaker;
  constructor(params: {
    selfModel: SelfModel;
    knobs: AdjustmentKnob[];
    config?: MetaControllerConfig;
  });
  /**
   * 评估并调整（外环主入口；状态机单步推进）
   *
   * 每次调用 = 一份新心智报告 + 至多一个状态转移：
   * 观察窗满 → 判定（commit / rollback）；空闲 → 应用一个保守调整；
   * 观察中 → 仅累计进度；冻结 → no-op。
   *
   * 2.0：判定带护栏综合评判（学习器/包络/熔断器同步更新）；
   * 候选 = 反应式推荐 ∪ 前瞻风险建议，经学习器排序后保守应用
   * （稳态自适应步长 + 安全包络钳制 + 已知劣化值排除）。
   */
  evaluateAndAdjust(): Promise<AdjustmentReport>;
  /**
   * 手动回滚最近一次调整
   *
   * 优先回滚观察窗中的调整；无观察中调整时回滚最近一次已提交
   * （未被回滚过）的调整。全部审计留痕。
   */
  rollbackLastAdjustment(): Promise<RollbackResult>;
  /** 手动覆盖旋钮值：写入后该旋钮冻结自动调整（人工优先） */
  setManualOverride(knobId: string, value: number): RollbackResult;
  /** 解除旋钮的手动接管（恢复自动调整资格） */
  clearManualOverride(knobId: string): boolean;
  /** 全局冻结 / 解冻自动调整 */
  setFrozen(frozen: boolean): void;
  /** 运行状态（meta_cognition_status Tool / 审查入口） */
  getState(): MetaControllerState;
  /** 审计日志（全量，升序） */
  getAuditTrail(): AuditEntry[];
  /**
   * 观察期满判定：劣化超容忍 → 回滚
   *
   * 2.0 综合判定护栏：目标指标未劣化但操作环成功率显著下滑 → 一律判失败。
   * 单指标优化不得以整体劣化为代价（guardrail violated → rollback）。
   */
  private judge;
  /** 全指标基线快照（护栏综合判定的 before 数据） */
  private snapshotAllMetrics;
  /**
   * 稳态步长倍率（1~maxStepMultiplier）：
   * 判定指标配置了目标带 → 偏离带越远倍率越大（比例控制，量化档位）；
   * 未配置目标带 → 1（行为与 1.0 固定步长一致）。
   */
  private stepMultiplierFor;
  /** 旋钮当前安全包络：有 commit 好值 → 好值区间 ± 一步长；否则旋钮原始边界 */
  private envelopeOf;
  /** 已知劣化值判定（数值直接相等，或整数旋钮按四舍五入相等） */
  private isKnownBadValue;
  /** commit 判定后收录好值（安全包络的「已验证安全」样本） */
  private recordGoodValue;
  /** 自动回滚后标记劣化值（后续调整预防性排除） */
  private recordBadValue;
  /** 单次判定保留：该旋钮连续回滚清零、全局连续回滚清零 */
  private onJudgedCommit;
  /** 单次判定回滚：推进单旋钮与全局连续回滚计数，达阈值触发熔断 */
  private onJudgedRollback;
  /** 熔断器面板（getState / 心智报告共享） */
  private breakerPanel;
  /**
   * 熔断器手动复位（公共 API）
   *
   * - 指定 knobId：复位该旋钮熔断（清零计数 + 解除熔断）
   * - 不指定：复位全局熔断 + 全部旋钮熔断与计数
   * 返回是否发生了实际复位动作。
   */
  reArmBreaker(knobId?: string): boolean;
  /** 从心智报告提取判定指标 */
  private extractMetric;
  private appendAudit;
  private buildReport;
  private persist;
  private restore;
}
//#endregion
//#region src/core/gaussian-process.d.ts
/**
 * 26.0 高斯过程内核 —— RBF/Matérn 贝叶斯回归 + 期望改进贝叶斯优化
 *
 * 动机: 世界模型的预测校准史（predicted vs actual）是一条**时间序列**——
 * 「预测系统性偏高/偏低多少」本身随时间漂移（负载周期、模型更替、宿主行为
 * 变化）。EWPMA / 线性回归只能给点估计，GP 给出**带不确定度的非参数回归**：
 *
 *   f ~ GP(m, k),  k(x,x') = σf²·exp(−(x−x')²/2ℓ²)（RBF）
 *   后验（无噪观测推导，含噪以 σn 加入对角）:
 *     μ*(x) = k*ᵀ(K+σn²I)⁻¹y
 *     σ*²(x) = k(x,x) − k*ᵀ(K+σn²I)⁻¹k*
 *   边际似然（超参 ℓ,σf 由网格搜索极大化）:
 *     ln p(y|X,θ) = −½yᵀK_y⁻¹y − ½ln|K_y| − n/2·ln(2π)
 *
 *   贝叶斯优化（采集函数 = 期望改进 EI）:
 *     EI(x) = (μ*−y_best−ξ)·Φ(z) + σ*·φ(z),  z = (μ*−y_best−ξ)/σ*
 *   解析式与蒙特卡洛口径一致（验证脚本对照），全局搜索与局部精化自动平衡——
 *   不确定的地方探索（φ 项），确定的地方利用（Φ 项）。
 *
 * 数值稳定: Cholesky 分解带抖动升级（1e-10 → 1e-6），对数域计算 LML;
 *   y 标准化（均值 0 方差 1）、x 归一到 [0,1] 后再拟合，尺度不敏感。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致。
 */
type GpKernelKind = 'rbf' | 'matern52';
interface GaussianProcessConfig {
  /** 协方差核族（缺省 rbf；matern52 假设更粗糙，对阶跃漂移更稳健） */
  kernel: GpKernelKind;
  /** 信号标准差 σf（标准化 y 尺度；缺省 1.0） */
  sigmaF: number;
  /** 长度尺度 ℓ（x 归一到 [0,1] 后；缺省 0.3） */
  lengthScale: number;
  /** 观测噪声标准差 σn（标准化 y 尺度；缺省 0.1） */
  sigmaN: number;
  /** 训练点上限（超出丢弃最旧；缺省 64） */
  maxPoints: number;
  /** 是否网格搜索 (ℓ, σf) 极大化 LML（缺省 true） */
  tuneHyperparams: boolean;
}
declare const DEFAULT_GP_CONFIG: GaussianProcessConfig;
/** Cholesky 分解（下三角），失败时抖动逐级升级，全失败返回 undefined */
declare function choleskyLower(A: number[][]): {
  L: number[][];
  jitter: number;
} | undefined;
/** 解 L·Lᵀ·x = b（前代 + 回代） */
declare function solveCholesky(L: number[][], b: number[]): number[];
/** 标准正态 CDF（Abramowitz-Stegun 7.1.26 有理逼近，|误差| < 7.5e-8） */
declare function normalCdf(z: number): number;
/** 标准正态 PDF */
declare function normalPdf(z: number): number;
interface GpPredict {
  /** 后验均值（原始尺度） */
  mean: number;
  /** 后验标准差（原始尺度，含观测噪声项） */
  std: number;
}
interface GpFitReport {
  points: number;
  lengthScale: number;
  sigmaF: number;
  logMarginalLikelihood: number;
  tuned: boolean;
}
/**
 * 一维高斯过程回归器。
 *
 * fit() 内部完成 y 标准化 + x 归一；tuneHyperparams 时在
 * ℓ ∈ logspace(−2, 0.7, 8) × σf ∈ {0.5, 1, 2} 网格上取 LML 最大者。
 * predict() 返回原始尺度的均值/标准差（不确定度随距离数据远近伸缩）。
 */
declare class GaussianProcess {
  private config;
  private xs;
  private ys;
  private yMean;
  private yStd;
  private xMin;
  private xMax;
  private L;
  private alpha;
  private fitReport;
  constructor(config?: Partial<GaussianProcessConfig>);
  /** 拟合（重复调用为全量重拟合；数据先按 maxPoints 截尾） */
  fit(xs: number[], ys: number[]): GpFitReport | undefined;
  /** 后验预测（原始尺度；未拟合时 undefined） */
  predict(x: number): GpPredict | undefined;
  /** 最近一次拟合报告 */
  get fitSummary(): GpFitReport | undefined;
  /** 训练点数 */
  get size(): number;
  private normalize;
  private kernelValue;
  private kernelMatrix;
}
/**
 * 期望改进（解析式）。
 * @param mu 候选点后验均值（越大越好口径）
 * @param sigma 候选点后验标准差
 * @param best 已观测最优值
 * @param xi 改进裕量（缺省 0.01，防过早在噪声上收敛）
 */
declare function expectedImprovement(mu: number, sigma: number, best: number, xi?: number): number;
interface BoSuggestion {
  x: number;
  expectedImprovement: number;
  posteriorMean: number;
  posteriorStd: number;
}
interface BoState {
  observations: number;
  bestX?: number;
  bestY?: number;
}
/**
 * 离散候选集上的贝叶斯优化器（EI 采集）。
 *
 * observe(x,y) 登记真实观测；suggest(candidates) 拟合 GP 并返回 EI 最大
 * 的候选。适合「心跳间期在有限候选点里挑下一个试验参数」的在线调参场景。
 */
declare class BayesianOptimizer {
  private gp;
  private xs;
  private ys;
  private dirty;
  constructor(config?: Partial<GaussianProcessConfig>);
  observe(x: number, y: number): void;
  /** EI 最优候选（观测 < 2 或全部失败时 undefined） */
  suggest(candidates: number[]): BoSuggestion | undefined;
  get state(): BoState;
}
interface GpCorrection {
  /** 乘性修正因子（已钳制） */
  factor: number;
  /** 因子的后验标准差（原始尺度） */
  std: number;
  /** 参与拟合的校准点数 */
  points: number;
}
/** GpSeriesCalibrator 构造参数（26.0 接线口径） */
interface ConstructorOptionsGpSeries {
  maxPoints?: number;
  sigmaN?: number;
  minPoints?: number;
  factorClamp?: number;
  kernel?: GpKernelKind;
}
/**
 * 26.0 接线辅助：序列校准器——「预测/实际」比值的时间序列 GP。
 *
 * 世界模型每次校准对账 push(timestamp, ratio)；predictAt(now) 返回当前
 * 时刻的比值修正（均值 + 不确定度）。数据不足 minPoints 时 undefined
 * （先验无知 = 不修正，早期零漂移）。内部按归一时间轴拟合，GP 均值函数
 * 取经验均值——比值无趋势时修正 ≈ 平均比值，有趋势时跟踪漂移。
 */
declare class GpSeriesCalibrator {
  private config;
  private ts;
  private vs;
  private gp;
  private fittedAt;
  constructor(config?: ConstructorOptionsGpSeries);
  /** 登记一次比值观测（actual/predicted） */
  push(timestamp: number, ratio: number): void;
  /** 当前时刻的比值修正（点数不足或拟合失败时 undefined） */
  predictAt(now: number): GpCorrection | undefined;
  get size(): number;
}
//#endregion
//#region src/world-model.d.ts
/** 单类型信号的到达统计 */
interface ArrivalStats {
  type: string;
  /** 到达时间戳（滑动窗口，最新在尾部） */
  timestamps: number[];
  /** 小时直方图（0~23 时段的到达计数） */
  hourHistogram: number[];
  /** 总到达数 */
  totalCount: number;
  /** 首次观测时间 */
  firstSeenAt: number;
  /** 最近观测时间 */
  lastSeenAt: number;
}
/** 到达预测结果 */
interface ArrivalPrediction {
  type: string;
  /** 预测窗口内期望到达数 */
  expectedCount: number;
  /** 置信区间下界 */
  lowerBound: number;
  /** 置信区间上界 */
  upperBound: number;
  /** 预测置信度 0~1（由校准误差驱动） */
  confidence: number;
  /** 趋势方向 */
  trend: 'rising' | 'falling' | 'stable';
  /**
   * 13.0：保形区间（分布无关精确覆盖保证，attachConformalCalibrator 后输出）。
   * 挂载后 lowerBound/upperBound 即保形口径（P(实际 ∈ [lower, upper]) ≥ 1−α，
   * 精确有限样本保证，零分布假设）；finite=false 表示校准不足——
   * 区间诚实发散（+∞），而非伪装确定。
   */
  conformal?: {
    lower: number;
    upper: number;
    finite: boolean;
    qhat: number;
    calibrationN: number;
    alpha: number;
  };
  /**
   * 26.0：GP 校准修正（attachGpCalibrator 后输出）。factor 为乘性修正
   * （从校准史的 actual/predicted 比值序列 GP 回归而来，含不确定度）；
   * expectedCount 已乘 factor，lowerBound/upperBound 已按 std 拓宽。
   */
  gp?: {
    factor: number;
    std: number;
    points: number;
  };
}
/** 预测校准记录 */
interface CalibrationRecord {
  type: string;
  predicted: number;
  actual: number;
  error: number;
  timestamp: number;
}
/** 类型关联（共现） */
interface TypeCorrelation {
  typeA: string;
  typeB: string;
  /** 共现次数 */
  coOccurrences: number;
  /** 关联强度 0~1（共现数 / min(各自总数)） */
  strength: number;
}
/** 世界模型配置 */
interface WorldModelConfig {
  /** 每类型保留的到达时间戳上限 */
  maxTimestampsPerType: number;
  /** 关联共现判定窗口（毫秒） */
  coOccurrenceWindowMs: number;
  /** 趋势检测最少样本数 */
  minSamplesForTrend: number;
  /** 上升趋势判定斜率阈值（每分钟到达数增量） */
  risingSlopeThreshold: number;
  /** 校准误差超过该值视为预测失准 */
  calibrationErrorThreshold: number;
}
/** 默认配置 */
declare const DEFAULT_WORLD_MODEL_CONFIG: WorldModelConfig;
/** 世界模型摘要（运维可观测） */
interface WorldModelSummary {
  trackedTypes: number;
  totalArrivals: number;
  types: Array<{
    type: string;
    totalCount: number;
    lastSeenAt: number;
    recentRatePerMin: number;
  }>;
  correlations: TypeCorrelation[];
  trends: Array<{
    type: string;
    trend: 'rising' | 'falling' | 'stable';
    slopePerMin: number;
  }>;
  calibrationError: number;
  /** 5.0：混杂指纹（观测共现 ≠ 因果的证伪现场） */
  confoundedPairs?: Array<{
    typeA: string;
    typeB: string;
    observationalStrength: number;
    causalEffect: number;
    divergence: number;
  }>;
  /** 13.0：保形校准状态（attachConformalCalibrator 后输出） */
  conformal?: ConformalStatus;
}
/**
 * 世界模型
 *
 * 被 index.ts 持有：哨兵每次 ingest 后调用 observeArrival() 增量学习；
 * 心跳循环定期调用 predictArrivals() 获取前瞻预测，detectTrends() 产出负载预警。
 *
 * 5.0 质变（因果升级）：挂载 CausalKernel 后，本模型从「相关性预测器」
 * 升级为「因果预见器」——predictInterventionEffect(action, kpi) 直接回答
 * 「若我对系统实施 do(action)，目标 KPI 期望变化几何（含不确定性区间）」。
 * 相关矩阵负责「看见规律」，因果图负责「预见干预后果」——
 * 二者的显著背离（混杂指纹）在 getSummary() 中显式曝光。
 */
declare class WorldModel {
  private config;
  private stats;
  private calibrations;
  /** 待校准的预测（type → 预测值，窗口结束后对账） */
  private pendingPredictions;
  /** 5.0：因果内核（可选挂载） */
  private causal?;
  /** 13.0：保形校准引擎（可选挂载） */
  private conformalEngine?;
  /** 26.0：每类型 GP 校准器（可选挂载；attachGpCalibrator 后惰性创建） */
  private gpCalibrators?;
  constructor(config?: Partial<WorldModelConfig>);
  /**
   * 26.0：挂载 GP 序列校准器开关（幂等）。
   *
   * 挂载后每次 settleCalibrations 把 actual/predicted 比值喂入该类型的
   * GP 时间序列；predictArrivals 的期望乘以 GP 后验均值因子、区间按
   * 后验标准差拓宽——趋势修正的 1.25/0.75 魔数由「从对账结果学出来的
   * 修正」接管（校准史充分前 factor 恒 1，早期零漂移）。
   */
  attachGpCalibrator(options?: ConstructorOptionsGpSeries): void;
  private gpOptions?;
  private gpFor;
  /** 26.0：GP 校准状态（未挂载返回 undefined） */
  getGpCalibrationStatus(): Array<{
    type: string;
    points: number;
  }> | undefined;
  /**
   * 5.0：挂载因果内核（幂等）。
   *
   * 挂载后：
   * - 类型共现自动作为观测证据写入因果图（银级证据）；
   * - predictInterventionEffect 提供因果预见（黄金口径）。
   */
  attachCausalKernel(kernel: CausalKernel): void;
  /**
   * 13.0：挂载保形校准引擎（幂等）。
   *
   * 挂载后 predictArrivals 的区间从 sqrt(λ) 泊松近似升级为保形区间：
   * 精确有限样本覆盖 ≥ 1−α，零分布假设（可交换性即可）；每次
   * settleCalibrations 的残差自动入校准集，覆盖漂移由 e-过程监测
   * （失准确证 → status().drift.drifting，应重校准）。
   */
  attachConformalCalibrator(engine: ConformalIntervalEngine): void;
  /** 13.0：保形校准状态（未挂载返回 undefined） */
  getConformalStatus(): ConformalStatus | undefined;
  /**
   * 5.0：因果预见 ——「若实施 do(action)，目标指标期望如何变化」。
   *
   * 与 predictArrivals 的本质区别：那是「世界自己会怎样」（外推），
   * 这是「我们主动干预后世界会怎样」（因果阶梯第二层）。
   * 无因果证据时诚实返回 null，而非伪装成知道。
   */
  predictInterventionEffect(action: string, targetKpi: string): CausalEffect | null;
  /** 5.0：登记一次真实干预（A/B 切换 / 参数实验的黄金证据） */
  recordIntervention(action: string, targetKpi: string, setTo: boolean, observedY: boolean, actor: string, hypothesis?: string): void;
  /**
   * 观察一次信号到达（增量学习入口）
   * @param type 信号类型
   * @param timestamp 到达时间戳（缺省当前时间）
   */
  observeArrival(type: string, timestamp?: number): void;
  /**
   * 预测未来窗口内各类型信号的到达数
   * @param horizonMs 预测窗口（毫秒，缺省 5 分钟）
   * @returns 各类型的到达预测（按期望到达数降序）
   */
  predictArrivals(horizonMs?: number): ArrivalPrediction[];
  /**
   * 对账预测与实际到达（校准）
   * @returns 本轮新增的校准记录
   */
  settleCalibrations(now?: number): CalibrationRecord[];
  /**
   * 类型关联矩阵（共现强度）
   * @param minStrength 最低关联强度过滤
   * @returns 类型对关联列表（按强度降序）
   */
  getCorrelations(minStrength?: number): TypeCorrelation[];
  /**
   * 趋势检测：识别到达率上升的类型（负载预警）
   * @returns 上升趋势的类型列表（含斜率）
   */
  detectTrends(): Array<{
    type: string;
    trend: 'rising' | 'falling' | 'stable';
    slopePerMin: number;
  }>;
  /** 世界模型摘要 */
  getSummary(): WorldModelSummary;
  /** 平均校准误差（MAE） */
  meanCalibrationError(): number;
  /** 序列化 */
  serialize(): {
    stats: ArrivalStats[];
    calibrations: CalibrationRecord[];
  };
  /** 反序列化 */
  deserialize(data: {
    stats: ArrivalStats[];
    calibrations: CalibrationRecord[];
  }): void;
  /** 最近到达率（每毫秒），基于最近 5 分钟窗口 */
  private recentRate;
  /** 时段热度因子：目标时段计数 / 全天均值 */
  /**
   * 42.0：挂载谱日历（幂等覆盖，挂载即生效）。
   *
   * 时段热度从「预设为一天的小时直方图」升级为谱分析：到达时间戳按
   * 小时分桶为时间序列，FFT 周期图 + Fisher g 检验判定是否存在显著
   * 周期（任意周期——分钟回环/小时批处理/昼夜/周节律）；显著时
   * predictArrivals 的热度因子切换为谐波重构的季节因子（相位感知），
   * 不显著时逐位回退原直方图口径。未挂载零漂移。
   */
  attachSpectralCalendar(options?: {
    bins?: number;
  }): void;
  /** 42.0：谱日历配置（未挂载 undefined） */
  private spectralCalendar?;
  /** 42.0：谱季节因子（显著周期时数值；不显著 / 样本不足 → undefined 回退） */
  private spectralFactorOf;
  /** 42.0：谱日历状态（纯读取；未挂载/未评估时 undefined） */
  getSpectralCalendarStatus(): {
    bins: number;
    samples: number;
    significant: boolean;
    periodHours: number | undefined;
  } | undefined;
  private lastSpectral?;
  private hourFactor;
  /** 趋势方向（由斜率判定） */
  private trendOf;
  /** 到达率线性回归斜率（每分钟到达数 / 分钟） */
  private slopeOf;
  /** 共现计数：两序列中时间邻近的配对数 */
  private countCoOccurrences;
  /** 预测置信度（由该类型历史校准误差驱动） */
  private calibrationConfidence;
  /** 最近一次预测窗口（用于对账，简化为固定 5 分钟） */
  private get lastHorizonMs();
}
//#endregion
//#region src/curiosity-engine.d.ts
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
 */
/** 知识盲区候选 */
interface KnowledgeGap {
  /** 任务类型 */
  taskType: string;
  /** 盲区成因 */
  reason: 'unexplored' | 'low-experience' | 'high-failure';
  /** 接触次数（外部信号到达次数） */
  exposureCount: number;
  /** 已有成功经验数 */
  experienceCount: number;
  /** 历史探索次数 */
  explorationCount: number;
  /** 新颖度评分 0~1（越高越值得探索） */
  noveltyScore: number;
}
/** 探索任务建议 */
interface ExplorationProposal {
  taskType: string;
  description: string;
  noveltyScore: number;
  /** 预期信息增益描述 */
  expectedGain: string;
}
/** 探索记录 */
interface ExplorationRecord {
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
interface CausalExplorationRecord {
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
interface CuriosityEngineConfig {
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
declare const DEFAULT_CURIOSITY_CONFIG: CuriosityEngineConfig;
/** 知识状态提供器（由 index.ts 桥接长期记忆与世界模型） */
interface KnowledgeProvider {
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
declare class CuriosityEngine {
  private config;
  private provider;
  private explorations;
  /** 各类型历史探索次数 */
  private explorationCounts;
  /** 5.0：因果内核（挂载后好奇心升级为假设驱动的实验设计） */
  private causal?;
  /** 10.0：科学家内核（挂载后实验建议升级为 Lindley EIG 最优设计） */
  private scientist?;
  /** 5.0：因果实验历史 */
  private causalExplorations;
  constructor(provider: KnowledgeProvider, config?: Partial<CuriosityEngineConfig>);
  /** 5.0：挂载因果内核（幂等） */
  attachCausalKernel(kernel: CausalKernel): void;
  /** 10.0：挂载科学家内核（幂等）——实验建议升级为 EIG 最优设计 */
  attachScientistMind(mind: ScientistMind): void;
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
  proposeCausalExperiments(targetKpi?: string, budget?: number): CausalExperiment[];
  /**
   * 10.0：EIG 最优实验设计透传（原生口径，供宿主直接执行与结算）。
   * 与 proposeCausalExperiments 的区别：不压缩为 0~1 启发式评分，
   * 返回完整的 DesignedExperiment（nat 口径 + 台账结算句柄）。
   */
  designOptimalExperiments(maxCount?: number): DesignedExperiment[];
  /**
   * 5.0：回写因果实验结果（假设 → 干预 → 图更新闭环）。
   *
   * 证伪也是收获：假设被否定时区间同样收窄（后验收缩），
   * uncertaintyReduction > 0 即记 gainedKnowledge ——
   * 好奇心的收益率第一次有了科学口径（信息增益而非运气）。
   */
  recordCausalExperiment(experiment: {
    from: string;
    to: string;
    setTo: boolean;
    hypothesis: string;
  }, observedY: boolean): CausalExplorationRecord | null;
  /** 5.0：因果实验历史 */
  getCausalExplorations(): CausalExplorationRecord[];
  /** 5.0：实验的信息增益率（平均区间收缩比例） */
  getCausalYield(): number;
  /**
   * 扫描知识盲区
   * @returns 盲区候选列表（按新颖度降序）
   */
  scanKnowledgeGaps(): KnowledgeGap[];
  /**
   * 30.0：挂载次模选择器（幂等）。
   *
   * top-k 按新颖度选盲区是模函数口径——共享主题的盲区（'generate-code' /
   * 'review-code' 同含 code）被重复购买。挂载后探索预算按加权覆盖次模
   * 函数惰性贪心分配（CELF，≥ (1−1/e)·OPT）：同主题第二个候选的边际
   * 自动衰减，预算优先流向互补的知识结构。未挂载即零漂移（原 top-k）。
   */
  attachSubmodularSelector(options?: {
    coverageStrength?: number;
  }): void;
  private submodularSelector?;
  /**
   * 44.0：挂载公平预算（幂等覆盖，挂载即生效）。
   *
   * 探索预算按域（taskType）加权极大极小分配（新颖度权重 + 注水算法，
   * 词典序最优）：热门域可以多拿，但任何活跃域的相对份额不被压扁——
   * 探索的覆盖有公平定理背书（多样性坍缩在预算层上锁）。未挂载零漂移。
   */
  attachFairBudget(): void;
  private fairBudget;
  /** 30.0：任务类型 → token 集（主题 = 共享 token；camelCase 与连字符统一拆分） */
  private static tokenize;
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
   */
  proposeExplorations(dispatchSlots: number, healthScore?: number): ExplorationProposal[];
  /**
   * 回写探索结果（探索完成后调用）
   * @param taskType 探索的任务类型
   * @param gainedKnowledge 是否填补了盲区
   * @param note 备注
   */
  recordExploration(taskType: string, gainedKnowledge: boolean, note?: string): void;
  /** 探索历史 */
  getExplorations(): ExplorationRecord[];
  /** 探索收获率（填补盲区的比例） */
  getExplorationYield(): number;
  /** 好奇心摘要 */
  getSummary(): any;
  /** 生成探索任务描述 */
  private describeExploration;
  /** 生成预期收益描述 */
  private describeGain;
}
//#endregion
//#region src/core/runtime-verification.d.ts
/**
 * runtime-verification.ts — 运行时验证内核（项目 15.0「安全有了形式语义」质变基座）
 *
 * 升级前的根本局限（安全治理的天花板）：
 * 治理器的全部约束都是**标量门控**——限流是每分钟计数、熔断是连续
 * 失败计数、预算是累计求和。它们各自为政，且只能回答「此刻过不过」：
 * - **时序性失明**：「熔断打开后 10 分钟内必须恢复」「失败风暴不得
 *   在 1 分钟内超过 5 次」「Kill Switch 不得无人认领地挂 24 小时」——
 *   这些真实的安全性质是**事件之间的时序关系**，标量门控表达不了；
 * - **不可证明**：拦截了什么、为什么拦截，只有一条条孤立审计日志；
 *   没有「违反了哪条规约、见证事件序列是什么」的证明结构；
 * - **不可扩展**：新增一条安全性质 = 新写一段门控代码；规约（想要
 *   什么）与实现（怎么检查）耦合，无法由配置声明。
 *
 * 本内核引入运行时验证（Runtime Verification；Dwyer 规约模式谱系，
 * 有限踪时序逻辑 LTLf 的可监视片段）：
 *
 * 1. **声明式规约**：安全性质写成结构化规约（模式 × 参数 × 严重级），
 *    配置即可声明，与执行逻辑彻底解耦。
 *
 * 2. **确定性监视器编译**：每条规约编译为独立 DFA 式监视器——
 *    step(event) 单步推进，O(1) 时间 O(1) 空间，无阻塞、无副作用；
 *    违规判定是确定性的（同一事件流永远同一裁决——可重放审计）。
 *
 * 3. **证明携带裁决（proof-carrying verdicts）**：违规报告携带
 *    **见证轨迹**（触发违规的那段事件序列）——「为什么违规」不再是
 *    一句人话理由，而是可机器重放的证据链。
 *
 * 4. **分级升级通道**：违规按严重级接入既有治理机制——critical
 *    → Kill Switch（冻结自主行为）、warn → 熔断器记败（推动熔断）、
 *    info → 仅审计。形式验证的裁决获得治理的牙齿，治理的牙齿获得
 *    形式的语义。
 *
 * 四类规约模式（Dwyer et al. 规约模式的时序核心）：
 * - absence(p)：p 永不发生
 * - response-deadline(p → q within T)：p 发生后 T 内必须出现 q
 * - bounded-recurrence(p ≤ k within W)：滑动窗口 W 内 p 至多 k 次
 * - precedence(p before q)：q 发生前必须发生过 p
 *
 * 与 3-14.0 的关系：治理器回答「这个动作能不能做」，本内核回答
 * 「这段历史是否满足规约」——一个管未来（门控），一个管过去
 * （监视），合起来才是完整的安全闭环：违规的历史立即关门未来。
 */
/** 运行时事件（治理器与宿主生命周期的最小公共语言） */
interface RuntimeEvent {
  /** 事件类型（如 'action-failed' / 'breaker-opened' / 'kill-switch-engaged'） */
  type: string;
  /** 事件时间戳（缺省 Date.now()） */
  at: number;
  /** 附加上下文（审计用，不参与判定） */
  detail?: Record<string, unknown>;
}
/** 规约模式（Dwyer 谱系的可监视时序核心） */
type SafetyPattern = 'absence' | 'response-deadline' | 'bounded-recurrence' | 'precedence';
/** 违规严重级（决定升级通道） */
type ViolationSeverity = 'info' | 'warn' | 'critical';
/** 安全规约（声明式；模式 × 参数 × 严重级） */
interface SafetySpec {
  /** 规约标识（审计引用） */
  id: string;
  /** 规约模式 */
  pattern: SafetyPattern;
  /** 触发事件类型（所有模式的第一主语） */
  trigger: string;
  /** 响应事件类型（response-deadline：trigger 后 withinMs 内必须出现） */
  responder?: string;
  /** 响应期限毫秒（response-deadline） */
  withinMs?: number;
  /** 窗口内最大次数（bounded-recurrence） */
  maxCount?: number;
  /** 滑动窗口毫秒（bounded-recurrence） */
  windowMs?: number;
  /** 严重级（缺省 warn） */
  severity?: ViolationSeverity;
  /** 人读规约文本 */
  description?: string;
}
/** 监视器状态（违规后终态，直到 reset） */
type MonitorStatus = 'monitoring' | 'violated';
/** 违规报告（证明携带：见证轨迹 + 规约引用） */
interface ViolationReport {
  /** 违反的规约 id */
  specId: string;
  pattern: SafetyPattern;
  severity: ViolationSeverity;
  /** 违规时刻 */
  at: number;
  /** 人读违规说明 */
  message: string;
  /** 见证轨迹（触发违规的事件序列，机器可重放） */
  witness: RuntimeEvent[];
  /** 规约原文 */
  spec: SafetySpec;
}
/**
 * 缺省安全规约集（治理器语义的形式化镜像）
 *
 * 1. failure-storm（critical）：60s 窗口失败 ≤ 5 次——熔断阈值的
 *    时序化重述，违规即风暴确证 → Kill Switch；
 * 2. breaker-stuck（warn）：熔断打开后 10 分钟内必须闭合——
 *    「卡死的熔断」比没有熔断更糟（假安全）；
 * 3. kill-switch-left-on（info）：Kill Switch 挂起 24h 内必须解除——
 *    无人认领的紧急停止本身是运维事故。
 */
declare function defaultSafetySpecs(failureThreshold?: number): SafetySpec[];
/**
 * 规约监视器（模式专用 DFA；违规后终态）
 *
 * 每个监视器独立持有最小状态；step() 纯事件驱动，tick() 处理
 * 期限到期（deadline 类模式的「沉默违规」——不响应也是违规）。
 */
declare class SafetyMonitor {
  readonly spec: SafetySpec;
  private status;
  private pendingDeadlines;
  private windowEvents;
  private sawTrigger;
  private recentTrace;
  constructor(spec: SafetySpec);
  /** 当前状态（violated 为终态，直到 reset） */
  get monitorStatus(): MonitorStatus;
  /** 是否仍在监视（未违规） */
  get active(): boolean;
  /**
   * 推进一个事件；返回该步产生的违规（至多一条）。
   * 已终态（violated）的监视器静默吞事件（违规只报一次）。
   */
  step(event: RuntimeEvent): ViolationReport | undefined;
  /**
   * 期限检查（沉默违规）：response-deadline 的未决义务到期未响应。
   * 由 Verifier.observe 在每个事件后以当前时间调用。
   */
  tick(now: number): ViolationReport | undefined;
  /** 重置监视器（运维动作：规约解除后重新武装） */
  reset(): void;
  /** 未决义务数（response-deadline 的在途压力；运维可观测） */
  get pendingObligations(): number;
  private remember;
  private violate;
}
/** 验证器状态报告 */
interface RuntimeVerifierStatus {
  /** 注册规约数 */
  specs: number;
  /** 仍在监视的监视器数 */
  activeMonitors: number;
  /** 已违规终态的监视器数 */
  violatedMonitors: number;
  /** 累计违规报告数 */
  totalViolations: number;
  /** 按严重级分组的违规计数 */
  bySeverity: Record<ViolationSeverity, number>;
  /** 已观察事件总数 */
  eventsObserved: number;
  /** 在途义务数（response-deadline 未决） */
  pendingObligations: number;
  /** 各规约的最近违规（id → 报告） */
  lastViolations: Array<{
    specId: string;
    severity: ViolationSeverity;
    message: string;
  }>;
  interpretation: string;
}
/**
 * 运行时验证器
 *
 * observe(event) 单口进食：内部先跑各监视器 tick（期限到期检查），
 * 再 step（事件推进）；返回本步产生的全部违规（按严重级降序）。
 * 违规的监视器进入终态（同一规约只报一次），运维可 resetMonitor
 * 重新武装。全部判定确定性可重放：同一事件流 → 同一违规集。
 */
declare class RuntimeVerifier {
  private readonly monitors;
  private readonly violations;
  private eventsObserved;
  constructor(specs?: SafetySpec[]);
  /** 注册附加规约（动态扩展；幂等 by id） */
  register(spec: SafetySpec): void;
  /** 移除规约 */
  unregister(specId: string): boolean;
  /** 规约清单（只读） */
  get specs(): SafetySpec[];
  /**
   * 观察一个事件：期限检查 → 事件推进 → 收集违规。
   * @returns 本步产生的违规（critical 优先；通常为空）
   */
  observe(event: RuntimeEvent): ViolationReport[];
  /** 重新武装一条规约（终态 → 监视） */
  resetMonitor(specId: string): boolean;
  /** 全部违规历史（审计通道；proof-carrying） */
  get violationHistory(): ViolationReport[];
  /** 验证器状态 */
  status(): RuntimeVerifierStatus;
}
//#endregion
//#region src/safety-governor.d.ts
/** 治理动作类型 */
type GovernedAction = 'autonomous-execute' | 'exploration' | 'goal-dispatch' | 'strategy-evolution';
/** 治理裁决 */
interface GovernanceVerdict {
  allowed: boolean;
  /** 拦截原因（allowed=false 时） */
  reason?: string;
  /** 拦截类别 */
  blockedBy?: 'kill-switch' | 'rate-limit' | 'budget' | 'circuit-breaker' | 'confidence-gate';
}
/** 治理审计条目 */
interface GovernanceAuditEntry {
  timestamp: number;
  action: GovernedAction;
  verdict: GovernanceVerdict;
}
/** 熔断器状态 */
type CircuitState = 'closed' | 'open' | 'half-open';
/** 安全治理器配置 */
interface SafetyGovernorConfig {
  /** 限流：每分钟最大自主动作数 */
  maxActionsPerMinute: number;
  /** 预算：累计 token 上限（0=不限制） */
  tokenBudget: number;
  /** 预算：累计成本上限（美元，0=不限制） */
  costBudget: number;
  /** 熔断：连续失败阈值 */
  circuitFailureThreshold: number;
  /** 熔断：冷却期（毫秒） */
  circuitCooldownMs: number;
  /** 置信度门控：低于该值的决策需人工确认 */
  confidenceThreshold: number;
  /** 治理审计日志上限 */
  auditLimit: number;
  /**
   * 4.0：按动作独立限流（每分钟上限；未列出的动作沿用共享全局窗口）。
   * 配置后该动作拥有自己的滑动窗口，不再与全局窗口叠加计数。
   */
  perActionRateLimits?: Partial<Record<GovernedAction, number>>;
  /**
   * 4.0：治理状态持久化路径（预算累计 + 审计尾部落盘，重启恢复）。
   * 不配置则纯内存（与升级前行为一致）。
   */
  persistPath?: string;
}
/** 默认配置 */
declare const DEFAULT_SAFETY_GOVERNOR_CONFIG: SafetyGovernorConfig;
/** 可持久化的治理状态（4.0） */
interface GovernorPersistState {
  version: 1;
  totalTokensUsed: number;
  totalCost: number;
  circuitState: CircuitState;
  consecutiveFailures: number;
  circuitOpenedAt: number;
  killSwitchEngaged: boolean;
  auditTail: GovernanceAuditEntry[];
}
/**
 * 安全治理器
 *
 * 被 index.ts 持有：所有自主动作执行前调用 govern() 获取裁决，
 * 执行结果经 recordOutcome() 回写以驱动熔断器与预算统计。
 * 4.0：主执行路径（executeSignal）执行前同样过 govern('autonomous-execute')。
 */
declare class SafetyGovernor {
  private config;
  /** 限流：最近一分钟的动作时间戳（共享全局窗口） */
  private recentActions;
  /** 限流：按动作独立窗口（perActionRateLimits 配置的动作） */
  private perActionWindows;
  /** 预算：累计消耗 */
  private totalTokensUsed;
  private totalCost;
  /** 熔断器状态 */
  private circuitState;
  private consecutiveFailures;
  private circuitOpenedAt;
  /** 40.0：失败时间戳（attachFirstPassageAdvisor 后记录；首达定价原料） */
  private failureTimestamps;
  /** 40.0：首达冷却配置（未挂载 undefined——零记录零介入） */
  private firstPassage?;
  /** 40.0：最近一次首达定价读数（breaker 打开时刷新） */
  private lastFirstPassage?;
  /** 4.0：半开试探互斥（探测在途时其余动作继续拒绝） */
  private halfOpenProbeInFlight;
  /** Kill Switch */
  private killSwitchEngaged;
  /** 审计日志 */
  private audit;
  /** 4.0：持久化防抖定时器 */
  private persistTimer?;
  /** 15.0：运行时验证器（挂载后治理迁移成为被监视的事件流） */
  private verifier?;
  /** 15.0：形式违规升级计数（审计可观测） */
  private formalViolations;
  constructor(config?: Partial<SafetyGovernorConfig>);
  /**
   * 15.0：挂载运行时验证器（幂等；缺省规约集以治理器自身的
   * circuitFailureThreshold 参数化——失败风暴规约与熔断阈值同源）。
   *
   * 挂载后治理器的全部关键迁移自动喂入规约监视器：
   * action-failed / breaker-opened / breaker-closed /
   * kill-switch-engaged / kill-switch-disengaged。
   *
   * @param specs 安全规约集（缺省 defaultSafetySpecs(circuitFailureThreshold)）
   * @returns 挂载的验证器（可继续 register 附加规约）
   */
  attachRuntimeVerifier(specs?: SafetySpec[]): RuntimeVerifier;
  /** 15.0：动态注册一条安全规约（需先挂载验证器） */
  registerSafetySpec(spec: SafetySpec): boolean;
  /** 15.0：运行时验证状态（未挂载时 undefined） */
  getVerificationStatus(): RuntimeVerifierStatus | undefined;
  /**
   * 治理裁决：判定一个自主动作能否执行
   * @param action 动作类型
   * @param confidence 决策置信度（用于置信度门控）
   * @returns 裁决结果
   */
  govern(action: GovernedAction, confidence?: number): GovernanceVerdict;
  /**
   * 40.0：挂载首达时间冷却定价（幂等覆盖，挂载即生效）。
   *
   * 熔断打开时的冷却从配置魔数升维为概率定价：观察到的相邻失败间隔
   * （恢复方向的漂移 μ̂ 与波动 σ̂）喂入逆高斯首达模型，二分解出
   * 「P(失败强度恢复 ≤ cooldown) ≥ targetProb」的最小冷却。μ̂ ≤ 0
   * （结构性恶化）时诚实给出 undefined——再等也不会自己好。定价为
   * 建议口径（半开转换时序仍由既有状态机治理）；未挂载零记录零介入。
   */
  attachFirstPassageAdvisor(options?: {
    targetProb?: number;
  }): void;
  /** 40.0：最近一次首达定价读数（纯读取；未挂载/未打开过熔断返回 undefined） */
  firstPassageView(): {
    recommendedCooldownMs: number;
    expectedRecoverMs: number;
    mu: number;
    sigma: number;
    targetProb: number;
  } | undefined;
  /** 40.0：从失败间隔序列做首达定价（breaker 打开沿调用） */
  private assessFirstPassage;
  /**
   * 回写动作结果（驱动熔断器与预算统计）
   * @param success 动作是否成功
   * @param tokensUsed 本次消耗 token
   * @param cost 本次成本
   */
  recordOutcome(success: boolean, tokensUsed?: number, cost?: number): void;
  /**
   * 只读门控检查：不消耗限流配额、不记审计、不改变任何状态。
   * 供宿主融合层等外部治理面使用（govern() 有副作用，会推进限流窗口）。
   * @returns 当前 kill switch / 熔断器是否放行
   */
  checkGate(): {
    allowed: boolean;
    reason?: string;
    blockedBy?: 'kill-switch' | 'circuit-breaker';
  };
  /**
   * 22.0：预算剩余快照（只读——不消耗限流配额、不记审计、不推进任何状态）。
   * 供预算路由内核（Bandits with Knapsacks）在每次模型选型时读取剩余资源；
   * tokenBudget 与 costBudget 均为 0（不限预算）时返回 undefined
   * （无预算约束即无路由依据，调度器据此走原路径）。
   */
  budgetSnapshot(): {
    tokensRemaining: number;
    costRemaining: number;
  } | undefined;
  /** 启用 Kill Switch */
  engageKillSwitch(): void;
  /** 解除 Kill Switch */
  disengageKillSwitch(): void;
  /** Kill Switch 状态 */
  isKillSwitchEngaged(): boolean;
  /** 手动重置熔断器 */
  resetCircuit(): void;
  /** 熔断器状态 */
  getCircuitState(): CircuitState;
  /** 治理状态摘要 */
  getStatus(): any;
  /** 审计日志 */
  getAudit(limit?: number): GovernanceAuditEntry[];
  /** 导出可持久化状态（4.0：测试与外部备份通道） */
  exportState(): GovernorPersistState;
  /** 导入状态（4.0：重启恢复；忽略非法字段） */
  importState(state: Partial<GovernorPersistState>): void;
  /** 立即落盘（dispose 时调用） */
  flushPersist(): void;
  /**
   * 15.0：治理事件流出口（挂载验证器时生效）。
   *
   * 事件喂入规约监视器；产出的违规按严重级升级：
   * - critical → Kill Switch（形式裁决获得治理的牙齿）；
   * - warn → 计入失败压力（推动熔断器开路）；
   * - info → 仅计数审计。
   */
  private emit;
  /** 形式违规升级通道 */
  private escalate;
  /** 记录审计日志 */
  private logAudit;
  /** 防抖持久化（高频 recordOutcome 不逐次落盘） */
  private schedulePersist;
  /** 原子写持久化状态（失败静默——治理不能因落盘故障停摆） */
  private writePersist;
  /** 启动时恢复持久化状态 */
  private loadPersisted;
}
//#endregion
//#region src/autonomy-loop.d.ts
/** KPI 采集器（由 index.ts 桥接真实引擎状态） */
type KpiCollector = () => KpiSnapshot;
/** 子任务派发器（由 index.ts 桥接到 sentinel.ingest，返回信号 id） */
type SubtaskDispatcher = (subtask: GoalSubtask, goal: Goal) => string;
/** 探索任务派发器（由 index.ts 桥接到 sentinel.ingest，返回信号 id） */
type ExplorationDispatcher = (proposal: ExplorationProposal) => string;
/** 记忆维护器（由 index.ts 桥接到长期记忆） */
interface MemoryMaintainer {
  distillExperience(): number;
  applyForgettingCurve(): {
    decayed: number;
    forgotten: number;
  };
  /**
   * 知识蒸馏（第二阶段）：从情景记忆蒸馏出语义+程序记忆
   * @returns 蒸馏产出的语义/程序记忆条数（{ semantic, procedural }）
   */
  distillKnowledge?(): Promise<{
    semantic: number;
    procedural: number;
  }>;
}
/** 反思教训提供器（由 index.ts 桥接到反思引擎） */
type LessonProvider = () => Lesson[];
/** 策略落地器（进化产物应用到决策引擎） */
type StrategyApplier = (config: Record<string, any>) => void;
/**
 * 调度策略进化桥接器（第三阶段：由 index.ts 桥接到 PolicyEvolver + Sandbox）
 *
 * 心跳进化段调用 runEvolutionCycle 触发「变异 → 沙盒评估 → 择优 → 热切换」；
 * 沙盒离线运行，不阻塞操作环任务调度。
 */
interface PolicyEvolutionBridge {
  runEvolutionCycle(): Promise<unknown>;
}
/**
 * 元认知环桥接器（第四阶段：由 index.ts 桥接到 SelfModel + MetaCognitiveController）
 *
 * 心跳低频段调用 runMetaCycle 触发「自我建模 → 心智报告 → 保守调整 →
 * 观察判定/回滚」——系统观察并改进自身的进化机制（双环外环）。
 */
interface MetaCognitionBridge {
  runMetaCycle(): Promise<unknown>;
}
/**
 * 共生进化桥接器（第五阶段 Phase 2.5：由 index.ts 桥接到 SymbiosisBridge）
 *
 * 心跳每拍调用 runSymbiosisTick：宿主 KPI 注入共生运行时（能量经济 +
 * 信念市场），市场价 vs 被动统计估计的显著背离回流为漂移洞察——
 * 模型漂移的第一现场由市场先行报警，进入目标引擎的自愈链路。
 */
interface SymbiosisBridgeHook {
  runSymbiosisTick(snapshot: KpiSnapshot): Promise<Insight[]>;
}
/**
 * 25.0 容量规划顾问（由 index.ts 桥接到 CapacityPlanner）。
 *
 * 心跳 2.5 段调用：λ̂（世界模型预测到达率）× 服务统计（稳健平均延迟）
 * 反解最小可行并发，不可行（ρ≥1）或建议并发超出当前 1.2 倍时返回
 * capacity-warning 洞察（扩容/降载）；无数据或未启用时返回空数组。
 * 失败由调用侧静默隔离，不阻断主链路。
 */
type CapacityAdvisor = () => Insight[] | void;
/** 28.0：尾部风险顾问（心跳 2.7 段消费，缺省零改动） */
type TailRiskAdvisor = () => Insight[] | void;
/**
 * 33.0：系统性风险顾问（心跳 2.8 段消费，缺省零改动）。
 *
 * 由 index.ts 桥接到 SystemicRiskMonitor：每轮心跳喂入各模型本期
 * 失败计数，窗口攒满后相关矩阵经 Marchenko–Pastur 清洗——伪相关被
 * 噪声带吸收（不误报），真实共同因子（λ₁ 显著超带 + 解释份额达标）
 * 产出 systemic-risk 洞察（同一上游/厂商的模型同沉浮，热备是幻觉）。
 * 失败由调用侧静默隔离，不阻断主链路。
 */
type SystemicRiskAdvisor = () => Insight[] | void;
/**
 * 41.0：排队网络顾问（心跳 2.9 段消费，缺省零改动）。
 *
 * 由 index.ts 桥接到 tandemNetwork：各模型作为独立 M/M/c 站、到达率
 * 按当前流量份额分摊，Erlang-C 口径解出瓶颈站（ρ 最大）与端到端
 * 逗留——瓶颈站接近饱和（ρ ≥ 0.85）或不可稳定时产出 capacity-flow
 * 洞察（Jackson 乘积形式背书）。失败由调用侧静默隔离。
 */
type QueueingNetworkAdvisor = () => Insight[] | void;
/** 自主心跳配置 */
interface AutonomyLoopConfig {
  /** 心跳间隔（毫秒） */
  heartbeatMs: number;
  /** 单轮最多派发的子任务数（防止一次性灌入过多信号） */
  maxDispatchPerTick: number;
  /** 每 N 轮心跳触发一次记忆维护 */
  maintenanceEveryTicks: number;
  /** 第四阶段：每 N 轮心跳触发一次元认知环（自我建模 + 保守调整；缺省 7） */
  metaCognitionEveryTicks: number;
  /** 每轮最多生成的目标数 */
  maxGoalsPerTick: number;
  /** 是否启用策略进化落地 */
  enableStrategyEvolution: boolean;
  /** 是否启用好奇心探索（缺省 true，需注入好奇心引擎） */
  enableExploration: boolean;
  /** 到达预测窗口（毫秒，缺省 5 分钟） */
  predictionHorizonMs: number;
}
/** 默认配置 */
declare const DEFAULT_AUTONOMY_LOOP_CONFIG: AutonomyLoopConfig;
/** 单轮心跳摘要 */
interface TickReport {
  tick: number;
  timestamp: number;
  insightsCollected: number;
  goalsCreated: number;
  subtasksDispatched: number;
  /** 本轮派发的探索任务数 */
  explorationsDispatched: number;
  /** 本轮被治理器拦截的动作数 */
  governanceBlocked: number;
  /** 世界模型预测摘要（rising 趋势类型） */
  risingTrends: string[];
  evolved: boolean;
  maintenance?: {
    distilled: number;
    decayed: number;
    forgotten: number;
    semanticDistilled?: number;
    proceduralDistilled?: number;
  };
  healthScore: number;
}
/**
 * 自主心跳循环
 *
 * 被 index.ts 持有：插件启动时 start()，fiber 卸载时 stop()。
 * 测试可绕过定时器直接调用 tick() 驱动单轮心跳。
 */
declare class AutonomyLoop {
  private config;
  private goalEngine;
  private metaCognition;
  private evolution;
  private collectKpi;
  private dispatchSubtask;
  private maintainer;
  private lessonProvider;
  private strategyApplier?;
  /** 第三阶段：调度策略进化桥接（可选注入） */
  private policyEvolution?;
  /** 第四阶段：元认知环桥接（可选注入） */
  private metaCognitionBridge?;
  /** 第五阶段 Phase 2.5：共生进化桥接（可选注入，缺省不启用） */
  private symbiosis?;
  /** 25.0：容量规划顾问（可选注入；心跳 2.5 段消费，缺省零改动） */
  private capacityAdvisor?;
  /** 28.0：尾部风险顾问（可选注入；心跳 2.7 段消费，缺省零改动） */
  private tailRiskAdvisor?;
  /** 33.0：系统性风险顾问（可选注入；心跳 2.8 段消费，缺省零改动） */
  private systemicRiskAdvisor?;
  /** 41.0：排队网络顾问（可选注入；心跳 2.9 段消费，缺省零改动） */
  private networkAdvisor?;
  private worldModel?;
  private curiosity?;
  private governor?;
  private dispatchExploration?;
  private timer;
  /** 重入保护：上一轮 tick 未完成时跳过新 tick */
  private ticking;
  private running;
  private tickCount;
  private reports;
  /** 已消化过的教训 id（避免重复生成目标） */
  private consumedLessons;
  constructor(params: {
    config?: Partial<AutonomyLoopConfig>;
    goalEngine: GoalEngine;
    metaCognition: MetaCognitionEngine;
    evolution: StrategyEvolutionEngine;
    collectKpi: KpiCollector;
    dispatchSubtask: SubtaskDispatcher;
    maintainer: MemoryMaintainer;
    lessonProvider: LessonProvider;
    strategyApplier?: StrategyApplier;
    /** 第三阶段：调度策略进化桥接（可选，缺省不启用） */
    policyEvolution?: PolicyEvolutionBridge;
    /** 第四阶段：元认知环桥接（可选，缺省不启用） */
    metaCognitionBridge?: MetaCognitionBridge;
    /** 第五阶段 Phase 2.5：共生进化桥接（可选，缺省不启用） */
    symbiosis?: SymbiosisBridgeHook;
    /** 25.0：容量规划顾问（可选，缺省不启用） */
    capacityAdvisor?: CapacityAdvisor;
    /** 28.0：尾部风险顾问（可选，缺省不启用） */
    tailRiskAdvisor?: TailRiskAdvisor;
    /** 33.0：系统性风险顾问（可选，缺省不启用） */
    systemicRiskAdvisor?: SystemicRiskAdvisor;
    /** 41.0：排队网络顾问（可选，缺省不启用） */
    networkAdvisor?: QueueingNetworkAdvisor;
    worldModel?: WorldModel;
    curiosity?: CuriosityEngine;
    governor?: SafetyGovernor;
    dispatchExploration?: ExplorationDispatcher;
  });
  /** 启动心跳定时器 */
  start(): void;
  /** 停止心跳 */
  stop(): void;
  /** 是否运行中 */
  isRunning(): boolean;
  /**
   * 执行一轮心跳（自主智能的核心节拍）
   *
   * 重入保护：心跳是异步长链路（目标分解 / 沙盒进化 / 元认知环都可能
   * 慢于 heartbeatMs），interval 触发的新 tick 与滞留中的旧 tick 并发
   * 会双重派发目标与探索、双重触发维护与进化——上一轮未完成时本轮
   * 直接跳过（返回空摘要，不推进计数）
   * @returns 本轮摘要
   */
  tick(): Promise<TickReport>;
  private runTick;
  /** 心跳历史 */
  getReports(): TickReport[];
  /** 最近一轮摘要 */
  getLatestReport(): TickReport | undefined;
  /**
   * 自省报告（自主智能的全景自我认知）
   * 汇总心跳状态、健康度、目标进度、探索收获、治理状态、世界模型预测
   */
  introspect(): any;
  /** 运行状态 */
  getStatus(): any;
}
//#endregion
//#region src/host-fusion.d.ts
/** 宿主工具执行对象（ToolExecution 的结构化子集） */
interface HostToolExecution {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}
/** 宿主工具执行结果（ToolExecutionResult 的结构化子集） */
interface HostToolResult {
  readonly isError: boolean;
  readonly error?: {
    message: string;
  };
}
/** pre-execute waterfall 决策 */
type PreToolDecision = {
  kind: 'allow';
} | {
  kind: 'deny';
  reason: string;
} | {
  kind: 'ask';
  reason?: string;
};
/**
 * 声明本插件所依赖的宿主 ToolRegistry 管线事件（结构化签名）。
 * 宿主加载 @deepseek-ai/dsh-tools 时，其官方声明与本声明合并为重载，二者兼容；
 * 宿主未加载时，本声明保证类型层面可订阅（运行时无事件到达，静默无操作）。
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 宿主工具最终结果（emit 模式，监听者失败被隔离） */
    'tools/result'(exec: HostToolExecution, result: HostToolResult): undefined;
    /** 宿主工具派发前决策（waterfall 模式：allow / deny / ask） */
    'tools/pre-execute'(exec: HostToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>;
  }
}
/** 宿主融合层配置 */
interface HostFusionConfig {
  /** 是否启用宿主融合（缺省 true；宿主无 ctx.tools 时自动静默降级） */
  enabled: boolean;
  /** 是否观测宿主工具结果（世界模型 + 失败信号注入） */
  observeToolResults: boolean;
  /** 是否治理宿主工具调用（kill switch / 熔断器门控） */
  governToolCalls: boolean;
  /** 同工具连续失败达到该次数后注入高紧急度信号并提取教训 */
  failureEscalationThreshold: number;
}
/** 融合层依赖（由 index.ts apply 注入） */
interface HostFusionDeps {
  ctx: Context;
  sentinel: Sentinel;
  worldModel: WorldModel;
  governor: SafetyGovernor;
  /** 进度广播（可为 null：enableProgress=false 时） */
  broadcast: (event: Record<string, unknown>) => void;
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
  /** 调度器自身桥接进宿主注册表的 Tool 名集合（自排除，避免反馈环路） */
  selfToolNames: Set<string>;
  /** 教训提取回调（复用反思引擎的规则化路径） */
  onLessonExtracted?: (toolName: string, consecutiveFailures: number, lastError: string) => void;
}
/**
 * 宿主融合层
 *
 * 由 index.ts 在全部引擎构造完成后 activate()；fiber 卸载时 dispose()。
 * 宿主未提供 ctx.tools 服务时，activate() 静默返回 false（降级为纯内部模式）。
 */
declare class HostFusionLayer {
  private config;
  private deps;
  private active;
  /** 每工具连续失败计数 */
  private consecutiveFailures;
  /** 每工具最近一次失败信息 */
  private lastFailureError;
  /** 统计 */
  private stats;
  constructor(config: Partial<HostFusionConfig> | undefined, deps: HostFusionDeps);
  /**
   * 激活融合层：订阅宿主管线事件
   * @returns 是否成功激活（宿主无 ctx.tools 时返回 false）
   */
  activate(): boolean;
  /** 是否已激活 */
  isActive(): boolean;
  /** 融合层统计 */
  getStats(): {
    observed: number;
    failures: number;
    governed: number;
    denied: number;
    active: boolean;
  };
  /**
   * 观测宿主工具执行结果
   * - 成功：世界模型学习到达节律 + 重置该工具失败计数
   * - 失败：注入信号 + 连续失败升级
   */
  private onToolResult;
  /**
   * 治理宿主工具调用（pre-execute waterfall）
   * - Kill Switch → deny（紧急冻结全宿主）
   * - 熔断器开启 → deny（fail-closed）
   * - 其余 → next() 放行
   */
  private onPreExecute;
  /** 卸载：清理状态（事件监听由 cordis fiber 自动回收） */
  dispose(): void;
}
//#endregion
//#region src/tenant/tenant-manager.d.ts
/** 租户静态配置 */
interface TenantConfig {
  id: string;
  name: string;
  /** 租户工作目录（用于路径匹配与记忆库默认存放位置） */
  workDir: string;
  models?: Array<{
    id: string;
    name?: string;
    endpoint: string;
    apiKey: string;
    timeout?: number;
    maxConcurrency?: number;
    costPerKToken?: number;
    contextWindow?: number;
    initialCapabilities?: Record<string, any>;
  }>;
  strategistModel?: {
    id: string;
    endpoint: string;
    apiKey: string;
  };
  sentinel?: {
    watchCodeChanges?: boolean;
    watchErrors?: boolean;
    watchPerformance?: boolean;
    aggregationWindow?: number;
    signalSources?: Array<{
      type: 'webhook' | 'polling' | 'filesystem';
      port?: number;
      interval?: number;
      path?: string;
      signalType: string;
    }>;
  };
  qualityThreshold?: number;
  maxRetries?: number;
  globalTimeout?: number;
  memoryPath?: string;
  enabled?: boolean;
  tags?: string[];
  createdAt: number;
  lastActiveAt: number;
}
/** 租户运行时（配置 + 记忆 + 实时状态） */
interface TenantRuntime {
  config: TenantConfig;
  memory: LongTermMemory;
  activeExecutions: number;
  pendingSignals: Signal[];
  isExecuting: boolean;
  modelProfiles: Map<string, ModelLongTermProfile>;
  aggregationTimer: ReturnType<typeof setTimeout> | null;
  stats: {
    totalExecutions: number;
    totalSuccesses: number;
    totalFailures: number;
    totalSignals: number;
    totalTokensUsed: number;
  };
}
/** 租户注册表（持久化结构） */
interface TenantRegistry {
  version: number;
  tenants: TenantConfig[];
  globalDefaults: {
    qualityThreshold: number;
    maxRetries: number;
    globalTimeout: number;
    aggregationWindow: number;
  };
}
/**
 * 多租户管理器
 *
 * 被 index.ts 集成层持有，manage_tenants Tool 的全部 action 映射到本类方法。
 */
declare class TenantManager {
  private dataDir;
  private registryPath;
  private registry;
  private runtimes;
  private cryptoEngine?;
  /**
   * @param dataDir 租户数据根目录（注册表与各租户记忆库的存放处）
   * @param cryptoEngine 可选加密引擎，透传给各租户的记忆库
   */
  constructor(dataDir: string, cryptoEngine?: CryptoEngine);
  /**
   * 注册新租户并创建运行时
   * @param config 租户配置（createdAt / lastActiveAt 自动填充）
   * @throws ConfigError id 重复或必填字段缺失
   */
  registerTenant(config: Omit<TenantConfig, 'createdAt' | 'lastActiveAt'>): TenantRuntime;
  /**
   * 移除租户
   * @param tenantId 租户 id
   * @param deleteData 是否级联删除租户记忆数据，默认 false
   */
  removeTenant(tenantId: string, deleteData?: boolean): void;
  /**
   * 更新租户配置（增量合并）
   * @param tenantId 租户 id
   * @param updates 需要更新的字段
   */
  updateTenant(tenantId: string, updates: Partial<TenantConfig>): void;
  /** 获取单个租户运行时 */
  getTenant(tenantId: string): TenantRuntime | undefined;
  /** 获取全部租户运行时 */
  getAllTenants(): TenantRuntime[];
  /** 按标签检索租户 */
  getTenantsByTag(tag: string): TenantRuntime[];
  /**
   * 按文件路径匹配租户（路径规范化后做前缀比较）
   * @param filePath 文件或目录绝对路径
   * @returns workDir 最深匹配的租户运行时，无匹配返回 undefined
   */
  matchTenantByPath(filePath: string): TenantRuntime | undefined;
  /**
   * 信号路由：将信号分发到最合适的租户
   *
   * 评分规则（加权）：
   * - payload 中的路径字段命中租户 workDir：+2 × 路径深度
   * - 信号类型命中租户 sentinel.signalSources：+3
   * - 信号类型命中租户 tags：+1
   * 得分最高者胜出，全部为 0 分时返回 undefined（由默认实例接管）。
   *
   * @param signal 外部信号 { type, payload }
   */
  routeSignal(signal: {
    type: string;
    payload: Record<string, any>;
  }): TenantRuntime | undefined;
  /** 刷新租户活跃时间 */
  touchTenant(tenantId: string): void;
  /**
   * 全局统计（跨租户汇总，供 manage_tenants stats 使用）
   */
  getGlobalStats(): Record<string, any>;
  /** 释放全部运行时（进程退出前调用） */
  dispose(): void;
  /** 加载注册表（不存在时初始化；检测到加密结构时先解密再校验） */
  private loadRegistry;
  /** 持久化注册表（原子写入；apiKey 经字段级加密后落盘，不再明文存储） */
  private persistRegistry;
  /**
   * 生成落盘载荷：存在加密引擎时对注册表做字段级加密（apiKey 等敏感
   * 字段封为 __encrypted 结构）；加密失败降级为明文写并在 stderr 警告
   * （租户持久化是关键路径，不允许因加密故障整体失败）。
   */
  private encryptRegistryForDisk;
  /**
   * 兜底封印：深扫载荷中仍是明文字符串的 apiKey 字段（引擎的
   * sensitiveFields 配置可能不含 apiKey），逐个用引擎的整段加密原语
   * 封为与 EncryptedField 同构的结构（__encrypted 标记 + keyVersion），
   * 读回路径 decryptSensitiveFields 可统一解密。不修改原对象。
   */
  private sealRemainingApiKeys;
  /** 解析租户记忆库路径 */
  private resolveMemoryPath;
  /** 构建租户运行时 */
  private buildRuntime;
}
//#endregion
//#region src/benchmark/benchmark-engine.d.ts
/** 单次迭代结果 */
interface BenchmarkResult {
  success: boolean;
  latency: number;
  error?: string;
  memoryUsed?: number;
  tokensUsed?: number;
}
/** 基准场景定义 */
interface BenchmarkScenario {
  name: string;
  description: string;
  target: 'sentinel' | 'strategist' | 'executor' | 'memory' | 'sync' | 'consensus' | 'encryption' | 'full-pipeline';
  concurrency: number;
  totalRequests: number;
  warmupRequests: number;
  timeout: number;
  execute: (iteration: number) => Promise<BenchmarkResult>;
  /** 场景资源回收钩子（全部迭代结束后调用一次；如关闭哨兵/Raft 服务） */
  teardown?: () => void | Promise<void>;
}
/** 聚合统计 */
interface BenchmarkStats {
  totalRequests: number;
  successCount: number;
  failCount: number;
  successRate: number;
  minLatency: number;
  maxLatency: number;
  avgLatency: number;
  p50Latency: number;
  p90Latency: number;
  p95Latency: number;
  p99Latency: number;
  stdDev: number;
  /** 每秒完成请求数 */
  throughput: number;
  totalDuration: number;
  peakMemoryMB: number;
  errorDistribution: Record<string, number>;
}
/** 性能阈值 */
interface PerformanceThreshold {
  maxP95Latency: number;
  minThroughput: number;
  minSuccessRate: number;
  maxP99Latency: number;
}
/** 基准报告 */
interface BenchmarkReport {
  id: string;
  timestamp: number;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    cpuCount: number;
    totalMemoryMB: number;
    pluginVersion: string;
  };
  scenarios: Array<{
    name: string;
    description: string;
    target: string;
    concurrency: number;
    stats: BenchmarkStats;
    passed: boolean;
    thresholdViolations: string[];
    latencyDistribution: Array<{
      bucket: string;
      count: number;
    }>;
  }>;
  overallPassed: boolean;
  totalDuration: number;
  /** 45.0：OCBA 瓶颈聚焦（attachOcbaAllocator 后附加——下一轮确认预算的最优分配） */
  bottleneckFocus?: {
    candidate: string | undefined;
    rationale: string | undefined;
    allocation: Array<{
      name: string;
      count: number;
    }>;
  };
}
/** 内置场景上下文 */
interface BuiltinScenarioContext {
  memory: LongTermMemory;
  cryptoEngine: CryptoEngine;
  callLLM: Function;
  models: Array<{
    id: string;
    endpoint: string;
    apiKey: string;
  }>;
}
/**
 * 性能基准测试引擎
 *
 * 被 index.ts 的 run_benchmark Tool 调用
 * （run-all / list-scenarios / list-reports / compare / generate-report）。
 */
declare class BenchmarkEngine {
  private reportDir;
  private scenarios;
  private thresholds;
  /**
   * @param reportDir 报告持久化目录（如 .scheduler/benchmarks）
   */
  constructor(reportDir: string);
  /**
   * 注册自定义场景（同名覆盖）
   */
  registerScenario(scenario: BenchmarkScenario): void;
  /**
   * 覆盖指定 target 的性能阈值
   */
  setThreshold(target: BenchmarkScenario['target'], threshold: Partial<PerformanceThreshold>): void;
  /** 获取已注册场景名列表 */
  listScenarios(): Array<{
    name: string;
    target: string;
    concurrency: number;
    totalRequests: number;
  }>;
  /**
   * 注册内置场景
   *
   * - memory / encryption / sentinel / executor / sync / consensus 场景直接压测
   *   真实模块（离线可运行；executor 压测其弹性内核：熔断/退避/错误分型）
   * - strategist / full-pipeline 场景依赖 context.callLLM，
   *   缺省时注册为"跳过型"场景（执行时立即标注 skipped 原因）
   */
  registerBuiltinScenarios(context: BuiltinScenarioContext): void;
  /**
   * 执行单个场景
   * @param scenario 场景定义
   * @param onProgress 进度回调 (done, total)
   */
  runScenario(scenario: BenchmarkScenario, onProgress?: (done: number, total: number) => void): Promise<{
    stats: BenchmarkStats;
    latencyDistribution: Array<{
      bucket: string;
      count: number;
    }>;
    passed: boolean;
    thresholdViolations: string[];
  }>;
  /**
   * 执行全部已注册场景并生成报告（自动持久化）
   * @param onProgress 进度回调 (scenarioName, done, total)
   */
  runAll(onProgress?: (scenarioName: string, done: number, total: number) => void): Promise<BenchmarkReport>;
  /**
   * 45.0：挂载 OCBA 预算分配器（幂等覆盖，挂载即生效——纯报告附加）。
   *
   * runAll 结束时以各场景延迟统计为试点，给出「确认瓶颈子系统」的
   * OCBA 最优重跑预算分配（P(CS) 渐近最优）附在报告 bottleneckFocus；
   * 不改变场景执行本身（零漂移）。
   */
  attachOcbaAllocator(options?: {
    confirmationBudget?: number;
  }): void;
  private ocbaAllocator?;
  /** 加载全部历史报告（按时间倒序） */
  loadReports(): BenchmarkReport[];
  /**
   * 对比两份报告，输出逐场景变化（用于性能回归检测）
   * @param beforeId 基线报告 id
   * @param afterId 新报告 id
   */
  compareReports(beforeId: string, afterId: string): string;
  /**
   * 生成 Markdown 格式报告
   */
  generateMarkdownReport(report: BenchmarkReport): string;
  /** 计算聚合统计 */
  private computeStats;
  /** 构建延迟分布直方图 */
  private buildDistribution;
  /** 阈值门禁检查 */
  private checkThresholds;
  /** 持久化报告 */
  private saveReport;
}
//#endregion
//#region src/sync/distributed-sync.d.ts
/**
 * 变更载荷联合类型（按 ChangeEntry.type 判别）：
 * - pattern-created / pattern-updated：完整模式，或反思器产出的轻量变更描述
 * - model-profile-updated：模型画像
 * - feedback-created：决策反馈
 * - stats-updated：全局统计增量
 * - pattern-deleted：无载荷（null）
 */
type ChangePayload = TaskPatternMemory | ModelLongTermProfile | DecisionFeedback | MemoryStore['globalStats'] | {
  taskType: string;
  complexity: number;
  outcome: 'success' | 'failure';
} | null;
/** 同步节点配置 */
interface SyncNodeConfig {
  nodeId: string;
  name: string;
  protocol: 'http-poll' | 'websocket' | 'file-share';
  remoteUrl?: string;
  wsUrl?: string;
  sharePath?: string;
  pollInterval?: number;
  authToken?: string;
  bidirectional?: boolean;
  enabled?: boolean;
}
/** 单条变更条目 */
interface ChangeEntry {
  id: string;
  type: 'pattern-created' | 'pattern-updated' | 'pattern-deleted' | 'model-profile-updated' | 'feedback-created' | 'stats-updated';
  fingerprint: string;
  timestamp: number;
  sourceNodeId: string;
  payload: ChangePayload;
  logicalClock: number;
  dataHash: string;
}
/** 同步批次 */
interface SyncBatch {
  batchId: string;
  sourceNodeId: string;
  changes: ChangeEntry[];
  timestamp: number;
  logicalClock: number;
  batchHash: string;
}
/** 同步冲突记录 */
interface SyncConflict {
  changeId: string;
  fingerprint: string;
  localData: TaskPatternMemory;
  remoteData: ChangePayload;
  localClock: number;
  remoteClock: number;
  resolution: 'local-wins' | 'remote-wins' | 'merged' | 'pending';
  resolvedAt?: number;
  resolutionReason?: string;
}
/** 单次同步日志 */
interface SyncLogEntry {
  timestamp: number;
  direction: 'push' | 'pull';
  remoteNodeId: string;
  changesSent: number;
  changesReceived: number;
  conflictsDetected: number;
  conflictsResolved: number;
  errors: string[];
  duration: number;
  status: 'success' | 'partial' | 'failed';
}
/** 同步状态（持久化结构） */
interface SyncState {
  localClock: number;
  peerClocks: Record<string, number>;
  pendingChanges: ChangeEntry[];
  unresolvedConflicts: SyncConflict[];
  syncLog: SyncLogEntry[];
  lastSyncAt: Record<string, number>;
  /** 已应用变更 id（有界 FIFO；跨重启幂等去重的持久化载体） */
  appliedIds?: string[];
}
/**
 * 分布式记忆同步引擎
 *
 * 被 index.ts 的 manage_sync Tool 调用（status / sync-now / register-node）。
 */
declare class DistributedSync {
  private localNodeId;
  private memory;
  private statePath;
  private cryptoEngine?;
  private state;
  /** 已应用的变更 id（幂等去重） */
  private appliedIds;
  private nodes;
  private pollTimers;
  private persistTimer;
  private options;
  /** 各指纹最近一次本地变更时间戳（并发冲突仲裁的第二级依据） */
  private lastLocalChangeAt;
  /** 待推送队列总字节数（含每条变更近似大小缓存） */
  private pendingBytes;
  private totalPendingBytes;
  /**
   * @param localNodeId 本节点 id
   * @param memory 本节点记忆库
   * @param statePath 同步状态持久化路径
   * @param cryptoEngine 可选加密引擎（状态文件加密落盘）
   */
  constructor(localNodeId: string, memory: LongTermMemory, statePath: string, cryptoEngine?: CryptoEngine | null);
  /**
   * 记录一条本地变更（由记忆写入路径调用）
   * @param type 变更类型
   * @param fingerprint 变更对象指纹（pattern 指纹 / 模型 id / 反馈 id）
   * @param payload 变更载荷
   */
  recordChange(type: ChangeEntry['type'], fingerprint: string, payload: ChangePayload): void;
  /**
   * 获取待推送给指定 peer 的增量变更（clock > peer 已知进度）
   * @param forPeerId 目标 peer，缺省返回全部待推送变更
   */
  getPendingChanges(forPeerId?: string): ChangeEntry[];
  /**
   * 确认 peer 已消费到指定时钟位点（可裁剪已确认变更）
   */
  acknowledgePeer(peerId: string, clock: number): void;
  /**
   * 接收并应用远端批次
   *
   * 流程：批次哈希校验 → 逐条幂等应用 → 冲突检测与仲裁 → 时钟推进
   */
  receiveBatch(batch: SyncBatch): Promise<{
    applied: number;
    conflicts: SyncConflict[];
    errors: string[];
  }>;
  /**
   * 为指定 peer 创建增量批次（无新变更时返回 null）
   */
  createBatch(forPeerId: string): SyncBatch | null;
  /**
   * 注册同步节点（enabled 的 http-poll 节点自动启动定时拉取）
   */
  registerNode(config: SyncNodeConfig): void;
  /**
   * 创建 HTTP 同步端点处理器（供集成层挂载到 HTTP 服务）
   *
   * - handlePush: POST 接收远端批次
   * - handlePull: GET 返回本地增量批次（?peerId=xxx&since=clock）
   * - handleStatus: GET 返回同步状态摘要
   */
  createSyncHandlers(): {
    handlePush: (body: unknown) => Promise<Record<string, unknown>>;
    handlePull: (query: {
      peerId?: string;
    }) => {
      ok: boolean;
      batch: SyncBatch | null;
    };
    handleAck: (body: {
      peerId?: string;
      clock?: number;
    }) => Record<string, unknown>;
    handleStatus: () => Record<string, unknown>;
  };
  /**
   * 立即与指定 peer 同步一次（push 本地增量 + 可选 pull 远端增量）
   * @param peerId 已注册节点 id
   */
  syncNow(peerId: string): Promise<SyncLogEntry>;
  /**
   * 停止全部轮询定时器与持久化定时器
   */
  stop(): void;
  /**
   * 获取同步状态摘要（供 manage_sync status 使用）
   */
  /** 同步状态摘要（运维可观测） */
  getStatus(): {
    localNodeId: string;
    localClock: number;
    registeredNodes: Array<{
      nodeId: string;
      name: string;
      protocol: SyncNodeConfig['protocol'];
      enabled: boolean;
    }>;
    peerClocks: Record<string, number>;
    pendingChanges: number;
    unresolvedConflicts: number;
    recentSyncs: SyncLogEntry[];
    lastSyncAt: Record<string, number>;
  };
  /**
   * 应用单条变更到本地记忆库
   * @returns 检测到冲突时返回冲突记录（已自动仲裁）
   */
  private applyChange;
  /**
   * 三级仲裁：clock 高者胜 → timestamp 新者胜 → nodeId 字典序大者胜。
   * 第二级原实现用 Date.now() 近似本地变更时间——墙钟在「应用远端批次」
   * 的当下必然新于远端时间戳，等价于「时钟同段时远端恒胜」，仲裁退化为
   * 单级；现改用指纹级真实本地变更时间（recordChange 时记录）。
   * 第三级 nodeId 决胜保证双方独立仲裁结果一致（无分歧收敛）
   */
  private arbitrate;
  /** http-poll 协议同步：先 push 本地增量，再 pull 远端增量 */
  private syncViaHttp;
  /** file-share 协议同步：通过共享目录交换批次文件 */
  private syncViaFileShare;
  /** 启动 http-poll 定时拉取 */
  private startPolling;
  /** 简易 HTTP 请求（走环境代理，JSON 载荷） */
  private httpRequest;
  /** 计算批次哈希（变更 id + dataHash 链式哈希） */
  private computeBatchHash;
  /** 校验批次哈希 */
  private verifyBatchHash;
  /** 载荷哈希 */
  private hashPayload;
  /** 变更条目近似字节数（载荷序列化长度 + 条目固定开销） */
  private approxSizeOf;
  /** 已应用集合 FIFO 淘汰 */
  private trimAppliedIds;
  /** 追加同步日志（限长） */
  private appendSyncLog;
  /** 加载同步状态 */
  private loadState;
  /** 防抖持久化调度 */
  private schedulePersist;
  /** 执行状态持久化 */
  private persistState;
  /** 47.0：跨节点收敛计数器（G-Counter；按通道隔离） */
  private crdtCounters;
  /**
   * 47.0：CRDT 收敛通道（幂等挂载，挂载即生效——纯增量口径）。
   *
   * 网络分区 / 乱序 / 重复送达下的状态收敛从协议希望升级为合并算子
   * 的代数性质（join-semilattice 三律 ⟹ 强最终一致性，Shapiro 2011）：
   * 本地递增 incrementCrdtCounter，远端状态经 mergeCrdtState 合入，
   * crdtState 读取——任何消息顺序都收敛到同一读数。
   */
  attachCrdtChannel(channels: ReadonlyArray<string>): void;
  /** 47.0：本地递增（通道不存在时惰性创建） */
  incrementCrdtCounter(channel: string, by?: number): void;
  /** 47.0：合入远端 CRDT 状态（交换/幂等——重复合入无害） */
  mergeCrdtState(remote: Record<string, Record<string, number>>): void;
  /** 47.0：CRDT 状态快照（可序列化 gossip 载荷） */
  crdtState(): Record<string, Record<string, number>>;
}
//#endregion
//#region src/consensus/raft-engine.d.ts
/** 节点角色 */
type NodeRole = 'leader' | 'follower' | 'candidate';
/** 共识日志条目（决策命令） */
interface ConsensusLogEntry {
  index: number;
  term: number;
  command: {
    type: 'execute-plan' | 'reject-signal' | 'defer-signal' | 'reassign-model' | 'escalate-to-user';
    signalId: string;
    signalDescription: string;
    decision: Decision | null;
    proposedBy: string;
  };
  timestamp: number;
}
/** 集群状态摘要（运维可观测） */
interface ClusterStatus {
  localNodeId: string;
  role: NodeRole;
  term: number;
  leaderId: string | null;
  commitIndex: number;
  lastLogIndex: number;
  logLength: number;
  peers: Array<{
    nodeId: string;
    address: string;
    matchIndex: number;
    nextIndex: number;
  }>;
  pendingProposals: number;
}
/** 集群节点配置 */
interface ClusterNodeConfig {
  nodeId: string;
  address: string;
  port: number;
  /** 选举优先级（越大越倾向成为 leader），默认 1 */
  priority?: number;
}
/** Raft 引擎配置 */
interface RaftConfig {
  localNodeId: string;
  cluster: ClusterNodeConfig[];
  /** 选举超时下限（毫秒） */
  electionTimeoutMin: number;
  /** 选举超时上限（毫秒） */
  electionTimeoutMax: number;
  /** leader 心跳间隔（毫秒） */
  heartbeatInterval: number;
  /** 共识 RPC 监听端口 */
  consensusPort: number;
  /** 持久化状态路径 */
  logPath: string;
}
/** 提案结果 */
interface ProposeResult {
  committed: boolean;
  decision: Decision | null;
}
/**
 * 分布式共识引擎（Raft）
 *
 * 被 index.ts 的 manage_consensus Tool 调用（status / propose）。
 * 集群模式下，战略决策需经多数派提交后方可执行。
 */
declare class RaftEngine {
  private config;
  private role;
  private currentTerm;
  private votedFor;
  private log;
  private commitIndex;
  private lastApplied;
  private leaderId;
  /** leader 专用：各 peer 已知复制的最高日志索引 */
  private matchIndex;
  /** leader 专用：下一条要发送的日志索引 */
  private nextIndex;
  private electionTimer;
  private heartbeatTimer;
  private server;
  private commitCallbacks;
  private roleChangeCallbacks;
  /** 提案等待队列：logIndex → { term, resolver }（term 防跨任期错配兑现） */
  private pendingProposals;
  private running;
  constructor(config: RaftConfig);
  /**
   * 启动引擎：监听共识端口 + 启动选举定时器
   */
  start(): void;
  /**
   * 停止引擎：关闭服务与全部定时器
   */
  stop(): void;
  /**
   * 提交决策提案
   *
   * - leader：追加本地日志并复制，多数派确认后 resolve
   * - 非 leader：转发给当前 leader；无 leader 时提案失败
   * - 单节点：立即提交
   *
   * @param command 决策命令
   * @param timeoutMs 等待提交的超时（默认 10s）
   */
  propose(command: ConsensusLogEntry['command'], timeoutMs?: number): Promise<ProposeResult>;
  /** 当前 leader id（未知返回 null） */
  getLeaderId(): string | null;
  /** 当前角色 */
  getRole(): NodeRole;
  /** 当前任期 */
  getTerm(): number;
  /**
   * 集群状态摘要（供 manage_consensus status 使用）
   */
  getClusterStatus(): ClusterStatus;
  /** 注册已提交条目回调（状态机应用） */
  onCommit(callback: (entry: ConsensusLogEntry) => void): void;
  /** 注册角色变更回调 */
  onRoleChange(callback: (role: NodeRole, term: number) => void): void;
  /** 重置选举定时器（随机化超时，priority 越高超时越短） */
  private resetElectionTimer;
  /** 发起选举 */
  private startElection;
  /** 成为 leader：初始化 nextIndex/matchIndex 并启动心跳 */
  private becomeLeader;
  /** 降级为 follower */
  private stepDown;
  /** leader 广播心跳 / 日志复制 */
  private broadcastHeartbeat;
  /** 向单个 peer 复制日志 */
  private replicateTo;
  /** leader 推进 commitIndex（多数派 + 仅提交当前任期日志） */
  private advanceCommitIndex;
  /** 应用已提交但未应用的日志条目 */
  private applyCommitted;
  /** 处理 RequestVote */
  private handleRequestVote;
  /** 处理 AppendEntries */
  private handleAppendEntries;
  /** 启动共识 RPC 服务 */
  private startRpcServer;
  /** 发送 RPC 到 peer（泛型响应类型，JSON 边界处一次性断言） */
  private sendRpc;
  /** 非 leader 转发提案 */
  private forwardPropose;
  /** 除自己外的 peer 列表 */
  private peers;
  /** 自身节点配置 */
  private selfConfig;
  /** 多数派数量 */
  private majority;
  /** 最后一条日志索引 */
  private lastLogIndex;
  /**
   * 按索引二分查找日志条目（日志保持 index 升序不变量）。
   * 原实现 Array.find 线性扫描——advanceCommitIndex 每轮对每个 n 都
   * 全表扫，日志增长到数千条后复制心跳的 CPU 开销平方级膨胀
   */
  private findByIndex;
  /**
   * 有序插入：索引已存在返回 false；否则按升序插入到正确位次
   * （纯追加路径 index > 尾元素 → O(1) 尾推）
   */
  private insertOrdered;
  /** 最后一条日志任期 */
  private lastLogTerm;
  /** 触发角色变更回调 */
  private emitRoleChange;
  /** 加载持久化状态 */
  private loadPersistentState;
  /**
   * 46.0：法定人数安全审计（纯读取，零漂移）。
   *
   * 多数派交叉 / 容错上界 / 拜占庭可行性 / 负载——共识安全性从
   * 「被相信」升级为「被检查」（多数派两两相交是 Raft 安全性的
   * 根基，46.0 内核的闭式口径）。
   */
  quorumAudit(): {
    nodes: number;
    quorumSize: number;
    minIntersection: number;
    crashFaultTolerance: number;
    byzantineTolerance: number;
    load: number;
    verdict: string;
  };
  /** 持久化状态（原子写入） */
  private persistState;
}
//#endregion
//#region src/hot-reload/hot-reload-engine.d.ts
/** 插件版本记录 */
interface PluginVersion {
  version: string;
  codeHash: string;
  bundlePath: string;
  deployedAt: number;
  source: 'file-watch' | 'manual' | 'remote';
  active: boolean;
  status: 'deploying' | 'active' | 'rolling-back' | 'failed' | 'retired';
  error?: string;
}
/** 热更新配置 */
interface HotReloadConfig {
  enabled: boolean;
  watchDirs: string[];
  watchExtensions: string[];
  /** 防抖窗口（毫秒） */
  debounceMs: number;
  buildCommand: string;
  distDir: string;
  entryFile: string;
  maxVersionHistory: number;
  gracefulShutdownTimeout: number;
  versionsDir: string;
  autoRollback: boolean;
}
/** 活跃任务记录 */
interface ActiveTask {
  id: string;
  type: string;
  startedAt: number;
  version: string;
}
/** 热更新事件（12 种） */
type HotReloadEvent = {
  type: 'file-changed';
  filePath: string;
  timestamp: number;
} | {
  type: 'compilation-started';
  version: string;
  timestamp: number;
} | {
  type: 'compilation-succeeded';
  version: string;
  duration: number;
  timestamp: number;
} | {
  type: 'compilation-failed';
  version: string;
  error: string;
  timestamp: number;
} | {
  type: 'deploy-started';
  version: string;
  timestamp: number;
} | {
  type: 'deploy-succeeded';
  version: string;
  previousVersion: string | null;
  timestamp: number;
} | {
  type: 'deploy-failed';
  version: string;
  error: string;
  timestamp: number;
} | {
  type: 'rollback-started';
  fromVersion: string;
  toVersion: string;
  timestamp: number;
} | {
  type: 'rollback-succeeded';
  version: string;
  timestamp: number;
} | {
  type: 'rollback-failed';
  error: string;
  timestamp: number;
} | {
  type: 'graceful-shutdown-started';
  version: string;
  activeTasks: number;
  timestamp: number;
} | {
  type: 'graceful-shutdown-completed';
  version: string;
  timestamp: number;
};
/** 热重载状态（运维可观测） */
interface HotReloadStatus {
  enabled: boolean;
  watching: boolean;
  deploying: boolean;
  activeVersion: string | null;
  activeTaskCount: number;
  versionCount: number;
  recentVersions: Array<{
    version: string;
    status: string;
    deployedAt: number;
    source: string;
  }>;
}
/**
 * 插件热更新引擎
 *
 * 被 index.ts 的 manage_hot_reload Tool 调用
 * （status / rollback / deploy-version / stop-watching / start-watching）。
 */
declare class HotReloadEngine extends EventEmitter {
  private config;
  private watchers;
  private debounceTimer;
  private versions;
  private activeTasks;
  private versionsIndexPath;
  private deploying;
  private watching;
  constructor(config: HotReloadConfig);
  /**
   * 启动文件监听（enabled=false 时为空操作）
   */
  startWatching(): void;
  /**
   * 停止文件监听
   */
  stopWatching(): void;
  /**
   * 注册活跃任务（执行层开始子任务时调用）
   */
  registerTask(taskId: string, taskType: string): void;
  /**
   * 注销活跃任务（子任务完成/失败时调用）
   */
  unregisterTask(taskId: string): void;
  /** 当前活跃任务数 */
  getActiveTaskCount(): number;
  /**
   * 回滚到上一个 active 历史版本
   * @throws 无可回滚版本时 reject
   */
  rollback(): Promise<void>;
  /**
   * 手动部署指定版本（从版本历史中选择）
   * @param versionId 目标版本号
   */
  manualDeploy(versionId: string): Promise<void>;
  /**
   * 引擎状态摘要（供 manage_hot_reload status 使用）
   */
  getStatus(): HotReloadStatus;
  /**
   * 停止引擎：停止监听并清理
   */
  stop(): void;
  /** 防抖调度重载流程 */
  private scheduleReload;
  /** 完整重载管道：构建 → 校验 → 优雅停机 → 切换 */
  private reloadPipeline;
  /** 执行构建命令 */
  private runBuild;
  /**
   * 优雅停机：等待活跃任务结束（超时强制继续）
   */
  private gracefulShutdown;
  /** 获取当前激活版本 */
  private getActiveVersion;
  /** 版本历史上限裁剪（保留 active + 最近 N 个） */
  private trimVersionHistory;
  /** 发射事件（类型安全封装） */
  private emitEvent;
  /** 加载版本历史 */
  private loadVersions;
  /** 持久化版本历史 */
  private persistVersions;
}
//#endregion
//#region src/core/robust-decisions.d.ts
/**
 * 34.0 分布鲁棒内核 —— CVaR + Wasserstein 球：最坏情况有了闭式价格
 *
 * 动机: 系统里一切「按均值/按经验分位」的决策都隐含一个赌注：未来样本
 * 来自与历史相同的分布。但模型延迟分布会漂移（上游变慢、配额收紧），
 * 超时预算按均值设 → 一漂移就雪崩式超时。分布鲁棒优化（DRO）不赌单一
 * 分布，而是问:
 *
 *   sup_{Q: W₁(Q, P̂) ≤ ε} E_Q[ℓ]     （以经验分布为中心、半径 ε 的
 *                                     Wasserstein 球内的最坏期望）
 *
 *   Kantorovich–Rubinstein 对偶: W₁(Q,P̂) = sup{|E_Q φ − E_P̂ φ| : φ 1-Lipschitz}
 *   → 一维恒等映射是 1-Lipschitz ⟹ |E_Q[X] − E_P̂[X]| ≤ W₁ ≤ ε，且
 *     上界可达（把 ε 预算全部用于把最低处的质量搬到最高处——单位距离
 *     单位收益）。于是:
 *
 *     sup_{W₁≤ε} E[X] = min(E[X] + ε, b)   （支撑上界 b 已知时；
 *                                            无界支撑 = E[X] + ε）
 *     鲁棒均值不是启发式加成，是对偶定理的代数恒等式。
 *
 *   尾部风险的凸口径: CVaR（Rockafellar–Uryasev 2002）是唯一同时满足
 *   凸性 / 单调性 / 平移等变 / 正齐次的**相干风险度量**（与 16.0 Shapley
 *   的公理化同一品味——四公理不是描述，是唯一性定理）:
 *
 *     CVaR_α(X) = min_t { t + E[(X−t)₊]/(1−α) }
 *              = 最坏 (1−α) 尾部的期望（经验分布上 O(n log n) 精确）
 *
 *   超越概率的鲁棒口径: W₁ 球内质量要跨过阈值 t 至少要移动 (t − x)
 *   的距离 → 从最贴近 t 的下方样本搬起（单位质量成本最小）——精确的
 *   组合最坏化，worst P(X ≥ t) 有显式有限样本算法。
 *
 *   调度语义: 超时预算 = margin × CVaR_α(该模型延迟史)——「按最坏尾部
 *   的期望定价」而非「按均值加拍脑袋的裕度」；超时率从此有分布口径。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致。
 */
/** 样本分位（最近邻下插值；空样本返回 undefined） */
declare function quantile(samples: ReadonlyArray<number>, p: number): number | undefined;
/**
 * CVaR_α（损失口径，越大越坏）：最坏 1−α 尾部的期望。
 *
 * Rockafellar–Uryasev min-form 在经验分布上的闭式解（α 为**置信水平**，
 * α=0.95 即最坏 5% 尾）：k = ⌈(1−α)n⌉，最坏 k−1 个样本全取 + 第 k 个
 * 取分数权重（权重恰合 1−α）。
 */
declare function cvar(samples: ReadonlyArray<number>, alpha: number): number | undefined;
/** Rockafellar–Uryasev min-form 数值口径（验证锚点：与 cvar() 解析式对账） */
declare function cvarMinForm(samples: ReadonlyArray<number>, alpha: number): number | undefined;
/** CVaR 相干性公理审计（与 16.0 Shapley 四公理同一品味的验证锚点） */
declare function cvarCoherenceAudit(samples: ReadonlyArray<number>, alpha: number): {
  monotone: boolean;
  translationEquivariant: boolean;
  positivelyHomogeneous: boolean;
  subadditive: boolean;
};
/** Wasserstein-1 鲁棒均值（对偶定理的代数恒等式）。
 *
 * sup_{W₁(Q,P̂)≤ε} E_Q[X] = min(E_P̂[X] + ε, supportUpper)。
 * supportUpper 未提供 = 无界支撑（值 = E + ε）。样本为空 → undefined。
 */
declare function wassersteinRobustMean(samples: ReadonlyArray<number>, epsilon: number, supportUpper?: number): number | undefined;
/** 超越概率的最坏化（W₁ 球内 P(X ≥ t) 的精确有限样本最大值）。
 *
 * 贪心搬质量：单位质量从 x < t 跨到 t 的运价 = t − x，从最贴近 t 的
 * 下方样本搬起直到预算耗尽——运输问题的精确解（成本递增序贪心 =
 * 最小代价流）。返回名义值与最坏值。
 */
declare function robustExceedance(samples: ReadonlyArray<number>, threshold: number, epsilon: number): {
  nominal: number;
  worst: number;
  movedMass: number;
} | undefined;
interface RobustTimeoutConfig {
  /** 置信水平 α（CVaR_α 取最坏 1−α 尾；缺省 0.95 即最坏 5% 尾） */
  alpha?: number;
  /** 裕度乘数（缺省 1.5——超时预算略高于条件尾部值，容纳批间漂移） */
  margin?: number;
  /** 样本下限（不足则不接管；缺省 30） */
  minSamples?: number;
  /** 下限（毫秒；缺省 5000） */
  floorMs?: number;
  /** 上限（毫秒；缺省 300000） */
  capMs?: number;
}
/**
 * 鲁棒超时预算（34.0 接线口径）。
 *
 * margin × CVaR_α(延迟样本)，钳位 [floor, cap]；样本不足返回 undefined
 * （调用方回退原口径——零漂移）。比「均值 × 3」好在：尾部的形状直接
 * 进入价格——重尾模型自动获得更长预算、轻尾模型不被一刀切。
 */
declare function robustTimeout(samples: ReadonlyArray<number>, config?: RobustTimeoutConfig): number | undefined;
//#endregion
//#region src/llm-client.d.ts
/** 聊天消息（OpenAI 兼容格式） */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}
/** 模型端点配置（cordis.patch.yml models[] 条目 + strategistModel 的公共形态） */
interface ModelConfig {
  id: string;
  name?: string;
  /** API 基地址，如 https://api.deepseek.com（自动补 /v1/chat/completions） */
  endpoint: string;
  /**
   * API Key。可选：当 DSH 宿主经 ctx 注入请求头（headerProvider）时
   * 无需在配置中携带 Key，宿主会自动把用户配置的 Key 注入请求头。
   */
  apiKey?: string;
  /** 单请求超时（毫秒） */
  timeout?: number;
  /** 该模型最大并发请求数 */
  maxConcurrency?: number;
  /** 每千 token 成本（美元），用于成本估算 */
  costPerKToken?: number;
  /** 上下文窗口大小（token） */
  contextWindow?: number;
  /** 初始能力画像 */
  initialCapabilities?: {
    taskScores?: Record<string, number>;
    [key: string]: any;
  };
}
/** LLM 客户端全局配置 */
interface LLMClientConfig {
  /** 默认单请求超时（毫秒），可被单次调用覆盖 */
  timeout: number;
  /** 默认最大重试次数（不含首次调用） */
  maxRetries: number;
  /** 重试基础延迟（毫秒），指数退避基数 */
  retryBaseDelay: number;
  /** 默认每模型并发上限 */
  defaultMaxConcurrency: number;
  /** 每模型排队队列上限，超出直接拒绝 */
  maxQueueSize: number;
  /** fetch 实现注入点（测试/自定义运行时） */
  fetchImpl?: typeof fetch;
  /**
   * DSH 宿主请求头注入器：返回的头部会合并进每次模型调用
   * （如 Authorization），使插件无需在配置中持有 API Key。
   * keyAttempt 用于多密钥故障转移：认证/配额失败时递增，
   * 注入器可据此轮换到下一个候选密钥。
   */
  headerProvider?: (modelId: string, keyAttempt?: number) => Record<string, string> | undefined;
  /** 密钥结果回调：每次调用结束后上报成功/失败（含 HTTP 状态码），用于健康感知路由 */
  onKeyOutcome?: (modelId: string, keyAttempt: number, success: boolean, status?: number) => void;
  /**
   * DSH 宿主 LLM 客户端调用器：存在时所有模型调用委托给宿主客户端
   * （经 ctx 获取的已配置客户端），本客户端仅保留并发控制/统计/重试外壳。
   */
  externalChat?: (modelId: string, messages: ChatMessage[], options: ChatOptions) => Promise<LLMResponse>;
  /**
   * 23.0 稳健延迟统计（可选）：配置后为每模型维护一条 RobustStream
   * （样本量自适应切换 mean → median-of-means → Catoni，重尾延迟下
   * 算术均值被极端值支配的问题被截断影响函数免疫），每次成功调用的
   * 延迟（毫秒）喂入流；getModelStatuses 相应输出 robustAvgLatencyMs /
   * robustLatencyMethod。未配置时两字段不出现、零开销（零漂移）。
   */
  robustLatency?: {
    alpha?: number;
    maxSamples?: number;
  };
}
/** 单次调用选项 */
interface ChatOptions {
  /** 覆盖超时（毫秒） */
  timeout?: number;
  /** 覆盖重试次数 */
  maxRetries?: number;
  temperature?: number;
  maxTokens?: number;
  /** 额外请求体字段（top_p 等） */
  extraBody?: Record<string, any>;
  /** 外部中止信号（与内部超时信号合并） */
  signal?: AbortSignal;
}
/** 调用结果 */
interface LLMResponse {
  /** 模型输出文本 */
  content: string;
  /** 实际响应模型 id */
  model: string;
  /** 本次调用总耗时（毫秒，含重试） */
  latency: number;
  /** token 消耗（prompt + completion，端点未返回时为估算值） */
  tokensUsed: number;
  /** 成本估算（美元） */
  cost: number;
  /** 实际发生的重试次数 */
  retries: number;
}
/** 单模型运行时状态（供 model_dashboard Tool 消费） */
interface ModelRuntimeStatus {
  id: string;
  name: string;
  endpoint: string;
  activeRequests: number;
  queuedRequests: number;
  maxConcurrency: number;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgLatency: number;
  totalTokensUsed: number;
  totalCost: number;
  taskScores: Record<string, number>;
  /**
   * 23.0 稳健平均延迟（毫秒，Catoni/MoM/均值按样本量自适应）；
   * 仅当 LLMClient 配置了 robustLatency 时出现，否则键不存在（零漂移）。
   */
  robustAvgLatencyMs?: number;
  /** 23.0 稳健估计方法（'mean' | 'mom' | 'catoni'；样本 < 8 时如实输出 'mean'） */
  robustLatencyMethod?: string;
}
/** 模型调用错误（携带 HTTP 状态与可重试标记） */
declare class LLMError extends AppError {
  readonly status?: number;
  readonly retryable: boolean;
  constructor(message: string, status?: number, retryable?: boolean, details?: Record<string, unknown>);
}
/** 默认配置 */
declare const DEFAULT_LLM_CLIENT_CONFIG: LLMClientConfig;
/**
 * OpenAI 兼容 LLM 客户端
 *
 * 被 index.ts 持有：strategist 决策与 executor 子任务执行均通过本客户端调用。
 */
declare class LLMClient {
  private config;
  private models;
  private fetchImpl;
  private disposed;
  /** 23.0：每模型稳健延迟流（仅配置 robustLatency 时创建） */
  private readonly robustStreams;
  constructor(config?: Partial<LLMClientConfig>);
  /**
   * 注册一个模型端点（重复注册同 id 时覆盖配置并保留统计）
   * @param model 模型配置
   */
  registerModel(model: ModelConfig): void;
  /**
   * 获取已注册模型配置
   * @param modelId 模型 id
   */
  getModel(modelId: string): ModelConfig | undefined;
  /** 所有已注册模型 id */
  getModelIds(): string[];
  /**
   * 发起一次聊天补全调用（含并发控制、超时、重试）
   * @param modelId 已注册的模型 id
   * @param messages 聊天消息序列
   * @param options 单次调用选项
   * @returns 调用结果
   * @throws LLMError / TimeoutError / NetworkError
   */
  chat(modelId: string, messages: ChatMessage[], options?: ChatOptions): Promise<LLMResponse>;
  /**
   * 发起一次调用并将输出解析为 JSON（容错代码块包裹）
   * @param modelId 已注册的模型 id
   * @param messages 聊天消息序列
   * @param options 单次调用选项
   * @returns 解析后的 JSON 对象与调用元数据
   */
  chatJSON<T = any>(modelId: string, messages: ChatMessage[], options?: ChatOptions): Promise<{
    data: T;
    response: LLMResponse;
  }>;
  /**
   * 获取所有模型的运行时状态（model_dashboard Tool 数据源）
   */
  getModelStatuses(): ModelRuntimeStatus[];
  /**
   * 关闭客户端：拒绝所有排队中的请求
   */
  dispose(): void;
  /**
   * 23.0：取（或惰性创建）模型的稳健延迟流。
   * 仅在配置 robustLatency 时返回流，否则返回 undefined（零开销路径）；
   * dispose 后不再复活统计流（清空即终态）。
   */
  private robustStreamFor;
  /**
   * 28.0：取模型的原始延迟样本（毫秒）。
   * 仅配置 robustLatency 时有值（否则 undefined，零开销零漂移）——
   * 尾部风险监视器（POT/GPD）与 23.0 稳健估计共用同一条流。
   */
  getLatencySamples(modelId: string): number[] | undefined;
  /**
   * 34.0：挂载 CVaR 超时预算（幂等覆盖，挂载即生效）。
   *
   * 每模型超时从固定魔数升级为 margin × CVaR_α(该模型延迟史)——按
   * 「最坏尾部的期望」定价：重尾模型自动获得更长预算、轻尾模型不被
   * 一刀切。依赖 robustLatency 启用（延迟样本与其共用）；样本不足
   * minSamples 时该模型回退全局缺省超时（零漂移）。
   */
  attachCvarTimeouts(options?: RobustTimeoutConfig): void;
  /** 34.0：CVaR 超时配置（未挂载 undefined） */
  private cvarTimeoutConfig?;
  /** 34.0：模型的 CVaR 超时预算（未挂载 / 样本不足 → undefined 回退缺省） */
  getCvarTimeout(modelId: string): number | undefined;
  /** 获取并发槽位（必要时排队） */
  private acquireSlot;
  /** 释放并发槽位并唤醒队首 */
  private releaseSlot;
  /** 带重试的调用主循环（含多密钥故障转移） */
  private chatWithRetry;
  /** 单次 HTTP 调用（含超时控制；keyAttempt 用于多密钥轮换） */
  private chatOnce;
}
/**
 * 宽松 JSON 解析：剥离 Markdown 代码块包裹，截取首个完整 JSON 片段
 * @param text 模型原始输出
 * @returns 解析结果，失败返回 undefined
 */
declare function parseJSONLoose<T = any>(text: string): T | undefined;
//#endregion
//#region src/core/index-scheduling.d.ts
/**
 * 21.0 最优索引调度内核 —— Gittins 指数 + 可用性折算(Whittle 一阶近似)
 *
 * 数学: 折扣 Bernoulli bandit 的最优调度 = Gittins 索引策略(Gittins 1979; Weber 1992 对
 * Bernoulli+Beta 情形的最优性证明)。臂 = 模型, 臂状态 = Beta(α, β) 后验。
 *
 * 精确计算(本实现的要害): 对固定退休金 R 的「退休 MDP」
 *     V_R(a,b) = max( R/(1−γ),  p·(1 + γ·V_R(a+1,b)) + (1−p)·γ·V_R(a,b+1) ),  p = a/(a+b)
 * 因转移严格增大 n = a+b, 整个值函数在 (a,b) 三角形上是 DAG —— 按 n 从 maxCount 向下
 * 反向归纳一遍即得全部 V_R, 无需任何不动点迭代。Gittins 指数
 *     ν(a,b) = sup{ R ≥ 0 : 在状态 (a,b) 继续播放优于退休 }
 * 对 R 二分(每次一遍 O(三角形) 归纳)即得。边界 n = maxCount 处后验视为已收敛,
 * 播放值取 p/(1−γ)(永续开采)。
 *
 * 关键性质(验证脚本逐条断言):
 *   1. ν ≥ p̂ 恒成立(已知臂的指数 = p̂, 不确定性带来学习溢价);
 *   2. ν(a+1,b) > ν(a,b) 单调(更多成功 → 更高指数);
 *   3. α+β → ∞ 时学习溢价 → 0(探索自我终结);
 *   4. 恒成功臂 (p=1) 指数恰为 1;
 *   5. 多臂截断视界 DP 对照: 索引策略折扣价值 ≥ 最优价值 − 容差(最优性的实证检查)。
 *
 * 可用性折算(Whittle 一阶): 熔断/不健康使臂成为「躁动臂」(restless)。精确 Whittle 指数
 * 一般不可判定(PSPACE-hard), 本内核取一阶折算 effectiveIndex = ν × availability,
 * availability ∈ [0,1] 由调用方按熔断/健康状态折算, 0 表示不可用直接剔除。
 */
interface GittinsConfig {
  /** 贴现因子 γ ∈ (0,1): 一步未来的奖励折算比例 */
  discount: number;
  /** 后验计数网格上限 N = α+β ≤ maxCount, 超出按比例钳制到边界(学习溢价已趋零) */
  maxCount: number;
  /** 无差异退休金 R 的二分轮数(精度 2^{-rounds}) */
  bisectionRounds: number;
}
declare const DEFAULT_GITTINS_CONFIG: GittinsConfig;
interface GittinsSnapshot {
  discount: number;
  maxCount: number;
  computedStates: number;
  cacheHits: number;
}
/** 惰性 Gittins 指数表: 每个后验状态首次查询时精确计算并缓存 */
declare class GittinsIndexTable {
  private readonly discount;
  private readonly maxCount;
  private readonly bisectionRounds;
  private readonly cache;
  private cacheHits;
  constructor(config?: Partial<GittinsConfig>);
  /**
   * 状态 (α, β) 的 Gittins 指数。计数超网格时按比例钳制到边界并标记 clamped
   * (大样本后验的学习溢价本就趋零, 钳制误差有界)。
   */
  index(alpha: number, beta: number): number;
  /** 是否经过了网格钳制(审计口径) */
  clamped(alpha: number, beta: number): boolean;
  snapshot(): GittinsSnapshot;
  /**
   * 核心: 对退休金 R 反向归纳求 V_R(a0,b0), 返回「播放是否最优」。
   * 只在 (a0,b0) 可达的三角形 (a≥a0, b≥b0, a+b ≤ maxCount) 上归纳。
   */
  private playOptimal;
  private computeIndex;
}
interface IndexArm {
  id: string;
  /** 成功次数(加权计数亦可为小数, 内部取整钳制) */
  successes: number;
  failures: number;
  /** 可用性 ∈ [0,1], 缺省 1; 熔断 open → 建议 0, half-open → 建议 0.3~0.5 */
  availability?: number;
}
interface ArmIndex {
  id: string;
  alpha: number;
  beta: number;
  posteriorMean: number;
  gittinsIndex: number;
  /** 学习溢价 = ν − p̂ ≥ 0(定理保证): 越不确定越值得探索 */
  learningPremium: number;
  availability: number;
  /** ν × availability(Whittle 一阶折算), 调度依据 */
  effectiveIndex: number;
  rank: number;
  clamped: boolean;
}
/**
 * 索引调度器: 把候选模型(臂)按 effectiveIndex 降序排列。
 * 与 UCB 的本质区别: UCB 是乐观置信上界启发式, Gittins 是折扣 bandit 的
 * **可证明最优**指数; 挂载后调度器的候选排序升级为最优口径(零漂移: 不挂载即旧行为)。
 */
declare class IndexScheduler {
  private readonly table;
  constructor(table?: GittinsIndexTable);
  getTable(): GittinsIndexTable;
  rank(arms: IndexArm[]): ArmIndex[];
}
//#endregion
//#region src/core/bandit-knapsack.d.ts
/**
 * 22.0 预算最优路由内核 —— Bandits with Knapsacks(Badanidiyuru–Kleinberg–Slivkins 2013;
 * Agrawal–Devanur 2014): 预算约束下最大化累计质量, 成本权重从对偶中内生涌现。
 *
 * 问题形式化(每轮选一个臂 = 模型执行一次):
 *     max E[ Σ_t q_{i_t} ]   s.t.  Σ_t c_{i_t} ≤ B_tokens, Σ_t cost_{i_t} ≤ B_cost
 * LP 松弛: max Σ π_i q_i s.t. Σ π_i c_i ≤ b, Σ π = 1(b = 剩余预算率);
 * 对偶影子价格 λ ≥ 0 使最优集中于 argmax(q_i − λ c_i) —— 固定 costWeight=0.2 只是 λ 的
 * 一次性猜测, 本内核让 λ 由「剩余预算 / 剩余轮数」的稀缺性实时决定。
 *
 * 在线算法(乐观可行性 + 预算感知贪心, BalK 结构):
 *   1. 质量采用乐观上界 q⁺ = q̂ + r_q(r_q 为 12.0 经验伯恩斯坦半径, 复用
 *      fixedSampleUpperBound), token 消耗半径用无界支撑的 EB 公式;
 *   2. 可行性: 均值消耗 ≤ 剩余预算率 × (1 + slack) —— slack 为噪声与突发留缓冲;
 *   3. 无可行臂 → 选最廉臂并标记 urgent(必须卸载负载, 而非假装最优仍存在);
 *   4. 影子价格: 取「最高质量但不可行臂 f」与「选中臂 c」的混合 LP 解
 *      λ = (q⁺_f − q⁺_c) / (c_f − c_c) —— 两臂混合 t* = (b − c_c)/(c_f − c_c) 是 LP 最优顶点,
 *      λ 即该顶点处预算约束的对偶变量(边际质量/单位 token)。
 *
 * 零漂移: 未挂载时调度器行为与升级前逐位一致。
 */
interface BwKConfig {
  /** 乐观半径的置信参数(α 越小半径越大, 越探索) */
  ucbAlpha: number;
  /** 可行性松弛: 均值消耗 ≤ 预算率 × (1 + slack) */
  feasibilitySlack: number;
  /** 臂样本少于此值时半径退化为均值一半(诚实的大不确定性) */
  minSamples: number;
  /** roundsRemaining 缺省时的视界估计 */
  horizonDefault: number;
}
declare const DEFAULT_BWK_CONFIG: BwKConfig;
interface BwKArmStat {
  id: string;
  /** 历史平均质量 ∈ [0,1] */
  qualityMean: number;
  qualityVar?: number;
  /** 历史平均 token 消耗 */
  tokensMean: number;
  tokensVar?: number;
  /** 可选第二资源(货币成本) */
  costMean?: number;
  costVar?: number;
  samples: number;
}
interface BwKBudgets {
  tokensRemaining: number;
  costRemaining?: number;
  roundsRemaining: number;
}
interface BwKCandidateView {
  id: string;
  optimisticQuality: number;
  tokensMean: number;
  feasible: boolean;
  radiusQuality: number;
}
interface BwKVerdict {
  chosenId: string;
  /** ucb-feasible: 乐观贪心命中可行臂; cheapest-shed: 无可行臂被迫卸载; empty: 无臂 */
  basis: 'ucb-feasible' | 'cheapest-shed' | 'empty';
  urgent: boolean;
  rateTokens: number;
  rateCost: number;
  /** 混合 LP 顶点的对偶影子价格(边际质量/单位 token); 无混合结构时为 0 */
  shadowPriceTokens: number;
  shadowPriceCost: number;
  /** 不可行的高质量臂(影子价格的另一端) */
  bottleneckArmId?: string;
  candidates: BwKCandidateView[];
  reason: string;
}
declare class BwKRouter {
  private readonly config;
  constructor(config?: Partial<BwKConfig>);
  getConfig(): Readonly<Required<BwKConfig>>;
  route(arms: BwKArmStat[], budgets: BwKBudgets): BwKVerdict;
}
//#endregion
//#region src/core/online-learning.d.ts
/**
 * 31.0 在线学习内核 —— Fixed-Share Hedge：对手存在下的无悔学习
 *
 * 动机: 系统里一切统计学习（Wilson 下界 / UCB / Gittins / GP）都建立在
 * **随机性假设**上——世界是平稳的概率分布，样本独立同分布。但多模型调度
 * 的真实世界是对抗性 / 非平稳的：厂商今天限流明天放开、某模型被静默降级、
 * 流量模式被人间的周节律扭转。「最优」在对手面前是幻觉，唯一守得住的
 * 口径是**无悔**（no-regret）:
 *
 *   R_T = L(算法) − min_i L_i(事后最优固定专家) ≤ o(T)
 *
 *   指数权重（Hedge, Freund–Schapire 1997）:
 *     ω_i(t+1) = ω_i(t)·e^{−η·ℓ_i(t)},  ℓ_i(t) ∈ [0,1]
 *
 *   遗憾定理（切线界 e^{−ηℓ} ≤ 1 − (1−e^{−η})ℓ 的精确推论）:
 *     R_T ≤ ln N/η + (η/2)·T      （η ∈ (0,1]）
 *     η = √(2 lnN/T) 时 R_T ≤ √(2T lnN)——**对手无论怎么出招都成立**，
 *     与分布假设无关。每轮无悔 ⇒ 时间平均收敛到最小最大化均衡
 *     （folk theorem: 遗憾博弈论的黑斯定理入口）。
 *
 *   非平稳世界（模型会漂移）: Fixed-Share（Herbster–Warmuth 1998）
 *     ω_i ← (1−α)·ω_i·e^{−ηℓ_i}/Z + α/N
 *   每轮把 α 份额均匀回灌——权重永远保留「翻盘预算」，对**任意 S 次
 *   切换的最优专家序列**的跟踪遗憾（口径见 trackingRegretBound）:
 *     R_τ ≤ [lnN + S·ln(1/α) + (τ−S)·ln(1/(1−α))]/η + ητ/2
 *   平稳世界取 α→0 退化为经典 Hedge（份额泄漏项归零）。
 *
 *   本内核的双口径承诺:
 *   - 任意对抗序列（含自适应对手，先看权重再出招）遗憾不超界；
 *   - reward 口径（质量 ∈ [0,1]）经 ℓ = 1−r 变换无损进入。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致。
 */
/** Hedge 配置 */
interface HedgeOptions {
  /** 专家数 N ≥ 1 */
  experts: number;
  /** 学习率 η ∈ (0,1]（缺省 0.3；√(2 lnN/T) 调优口径见 staticEtaFor） */
  eta?: number;
  /** Fixed-Share 回灌率 α ∈ [0,1)（0 = 经典 Hedge；缺省 0.05） */
  alpha?: number;
}
/** 遗憾审计快照（任何时刻可读——任意时刻有效性） */
interface HedgeStats {
  rounds: number;
  /** 算法累计损失 Σ_t ⟨w_t, ℓ_t⟩（全反馈口径）/ 已实现损失（部分反馈口径） */
  hedgeLoss: number;
  /** 事后最优固定专家及其累计损失 min_i Σ_t ℓ_i(t) */
  bestExpert: number;
  bestLoss: number;
  /** R_T = hedgeLoss − bestLoss（部分反馈口径可为负——算法好运气） */
  regret: number;
  /** 定理界 lnN/η + ηT/2（regret 应恒 ≤ 此界——对手无关） */
  regretBound: number;
  /** 当前权重（归一化） */
  weights: number[];
  /** 反馈口径（full = 全专家每轮有观测；partial = 每轮仅被指派专家） */
  feedback: 'full' | 'partial';
}
/**
 * Fixed-Share 指数权重。
 *
 * update(losses) 每轮一次；weights() 只读；stats() 给出与定理界的实时
 * 对账（验证脚本用它断言「任意对手序列下 regret ≤ bound」）。
 */
declare class Hedge {
  private readonly n;
  private readonly eta;
  private readonly alpha;
  private omega;
  private cumulative;
  private hedgeLoss;
  private rounds;
  private partial;
  constructor(options: HedgeOptions);
  /** 一轮对抗反馈：losses[i] ∈ [0,1]（越低越好；自动钳位） */
  update(losses: ReadonlyArray<number>): void;
  /** reward 口径入口（质量 ∈ [0,1]；ℓ = 1 − r 无损变换） */
  updateRewards(rewards: ReadonlyArray<number>): void;
  /**
   * 部分反馈入口（每轮仅一个专家被指派、有观测）。
   *
   * 掩码更新：其余专家本轮损失记 0（指数权重下等价于其权重不动，
   * 仅受 Fixed-Share 回灌微调）；记账切换为**已实现口径**——cumulative
   * 只累计各专家真实发生的损失，hedgeLoss = 算法实际承受的损失之和。
   * 全反馈定理界仍作为上界参考（部分信息下界弱化 √N 倍，口径在
   * stats.feedback 标注——不冒充全反馈保证）。
   */
  reportSingle(index: number, reward: number): void;
  /** 当前归一化权重（拷贝） */
  weights(): number[];
  /** 当前最优专家（权重最高者；平手取小下标——确定性） */
  recommend(): number;
  stats(): HedgeStats;
}
/** 平稳界：R_T ≤ lnN/η + ηT/2（η ∈ (0,1]，Freund–Schapire 切线界推论） */
declare function staticRegretBound(experts: number, eta: number, rounds: number): number;
/** 未知视界 T 的时间变学习率 η_t = min(1, √(lnN / t))（√(2T lnN) 阶自适配） */
declare function timeVaryingEta(experts: number, t: number): number;
/** Fixed-Share 跟踪遗憾上界（区间长 τ、切换 S 次；Herbster–Warmuth 口径） */
declare function trackingRegretBound(experts: number, eta: number, tau: number, switches: number, alpha: number): number;
/** 首步学习率调优建议（视界 T 已知时的最优 η = √(2 lnN/T)） */
declare function staticEtaFor(experts: number, horizon: number): number;
/**
 * 模型组合的 Hedge 乘数（31.0 接线辅助）。
 *
 * 权重 → 评分乘数 w_i / mean(w)，钳位 [minMultiplier, maxMultiplier]：
 * - 对抗口径下持续表现好（对手奈何不了它）的模型最多升 maxMultiplier 倍；
 * - 被对手打爆的模型最多降 minMultiplier 倍——**有界干预**，Hedge 只在
 *   证据权重侧表态，不接管评分主体（与经济乘数同一挂载位）。
 */
declare function hedgeMultiplier(weights: ReadonlyArray<number>, index: number, minMultiplier?: number, maxMultiplier?: number): number;
//#endregion
//#region src/core/feedback-control.d.ts
/**
 * 35.0 反馈控制内核 —— 离散 LQR + Lyapunov 证书：并发极限的闭环驾驭
 *
 * 动机: 25.0 容量规划用排队论**反解**最优并发（Erlang-C / Kingman）——
 * 但那是开环的：模型给一个静态建议，世界变了它不知道。真实的负载是
 * 非平稳的（模型变慢、配额收紧、流量起伏），并发上限需要**闭环**：
 *
 *   反馈律: u_k = u_{k−1} + K·(y* − y_k)     （y = 实测利用率，y* = 目标）
 *   闭环系统 y_{k+1} = (1 − bK)·y_k + bK·y* + 噪声
 *
 *   最优 K 从离散代数 Riccati 方程（DARE）解出:
 *     P = q + a²P − a²b²P²/(r + b²P),   K = abP/(r + b²P)
 *   a = 1（积分器口径）时有**闭式解**（P² − qP − qr/b² = 0）:
 *     P = (q + √(q² + 4qr/b²))/2
 *   ——闭式与不动点迭代逐位对账，控制增益不是调出来的，是解出来的。
 *
 *   Lyapunov 证书（与 15.0「证明携带」同一哲学）: 取 V(x) = P x²，则
 *   DARE 恒等式给出
 *     V(x_{k+1}) − V(x_k) = −(q x_k² + r u_k²) ≤ 0
 *   ——闭环的每一步都被李雅普诺夫函数**证明**不发散（数值上逐位可查），
 *   稳定性不是观察出来的，是代数恒等式。
 *
 *   工程加固: 死区（|e| < ε 不动——抗抖振）、输出钳位 [u_min, u_max]、
 *   增益调度保守化（b 未知时按最坏灵敏度取下界 b_min——保证 0 < bK < 2
 *   的稳定域对真实 b 稳健）。AIMD 式启发式调参从此退役。
 *
 * 零漂移: 未挂载时 computeParallelism 与升级前逐位一致（静态口径）。
 */
/** 标量 DARE（a=1 积分器口径）闭式解：P = (q + √(q² + 4qr/b²))/2 */
declare function dareScalarClosedForm(b: number, q: number, r: number): number;
/** 标量 DARE 不动点迭代（一般 a；收敛判据 |P_{k+1} − P_k| ≤ tol） */
declare function dareIterate(a: number, b: number, q: number, r: number, iterations?: number, tol?: number): {
  p: number;
  converged: boolean;
};
/** LQR 增益 K = abP/(r + b²P)（P 为 DARE 解） */
declare function lqrGain(a: number, b: number, p: number, r: number): number;
interface FeedbackControllerConfig {
  /** 目标利用率 y* ∈ (0,1]（缺省 0.75——留 25% 余量吸收突发） */
  target?: number;
  /** 一阶增益标称被控对象系数 b（灵敏度下界；缺省 0.4） */
  plantGain?: number;
  /** 状态权重 q（缺省 1.0——误差的代价） */
  q?: number;
  /** 控制权重 r（缺省 4.0——动作的代价，越大越保守） */
  r?: number;
  /** 死区半宽（|e| < deadband 不动作；缺省 0.05——抗抖振） */
  deadband?: number;
  /** 输出下限（缺省 1） */
  minOutput?: number;
  /** 输出上限（缺省 16） */
  maxOutput?: number;
  /** 初始输出（缺省 = 上限与下限之间靠上（保守起步）） */
  initialOutput?: number;
}
interface ControlStep {
  /** 控制输出（本周期并发上限） */
  output: number;
  /** 误差 e = y* − y（正 = 利用率不足，可放并发；负 = 过载） */
  error: number;
  /** 本步增量（死区内为 0） */
  increment: number;
  /** Lyapunov 函数值 V = P·e²（单调不增的证明对象） */
  lyapunov: number;
  /** 增益与闭环极点（审计口径） */
  meta: {
    gainK: number;
    closedLoopPole: number;
    p: number;
    method: 'closed-form';
  };
}
/**
 * Lyapunov 稳定的并发反馈控制器。
 *
 * 被控对象口径（积分器）: y_{k+1} = y_k + b·Δu_k；控制 Δu = K·(y*−y)。
 * 输出钳位同时充当抗积分饱和（输出到界后误差继续累计不再积深——
 * 增量直接被钳位截断，无 hidden state）。
 */
declare class FeedbackController {
  private readonly target;
  private readonly b;
  private readonly q;
  private readonly r;
  private readonly deadband;
  private readonly minOutput;
  private readonly maxOutput;
  private readonly p;
  private readonly k;
  private output;
  private lastError;
  constructor(config?: FeedbackControllerConfig);
  /** LQR 增益（审计） */
  get gain(): number;
  /** 闭环极点 1 − bK（|·| < 1 即稳定；本口径 ∈ (0,1)） */
  get closedLoopPole(): number;
  /** DARE 解 P（Lyapunov 函数的系数） */
  get dare(): number;
  /** 当前输出（只读） */
  get currentOutput(): number;
  /**
   * 一步反馈：观测当前利用率 measured，返回新输出。
   *
   * Lyapunov: V(e) = P·e²；按被控对象模型 e_{k+1} = (1−bK)e_k，
   * V(e_{k+1}) − V(e_k) = −(q e² + r u²) ≤ 0 —— DARE 恒等式（数值
   * 验证见 verify-equilibrium-kernels）。死区/钳位只会让动作更小
   * （V 降得更慢），不会破坏单调性。
   */
  step(measured: number): ControlStep;
  /** 最近一次误差（未 step 时 undefined） */
  get lastStepError(): number | undefined;
}
/**
 * Lyapunov 证书审计（验证锚点）: 在被控对象模型 y_{k+1} = y_k + b·Δu 上
 * 闭环仿真，逐步断言 V(e_{k+1}) − V(e_k) = −(q·e_k² + r·(K·e_k)²)（DARE
 * 恒等式应到机器精度），返回最大残差。
 */
declare function lyapunovCertificate(config: FeedbackControllerConfig, initialY: number, steps?: number): {
  maxResidual: number;
  convergedToTarget: boolean;
  finalError: number;
  pole: number;
};
//#endregion
//#region src/core/max-flow.d.ts
/**
 * 43.0 最大流内核 —— Edmonds-Karp + 最小割证书：吞吐上限与其钳制者
 *
 * 动机: 「现在最多能同时派发多少」不是各模型并发上限的简单求和——
 * 任务有类型偏好、模型有能力画像，可行并发是**流网络**的值:
 *
 *   源 → 任务类型节点（容量 = 该类型待执行需求） → 模型节点
 *        （类型-模型边存在当且仅当评分 > 0） → 汇（容量 = maxConcurrency）
 *
 *   Ford–Fulkerson 定理 (1956): 最大流 = 最小割。Edmonds-Karp 用
 *   BFS 增广（O(VE²)），终止时残量网络中源可达集 S 与不可达集 T̄ 构成
 *   **最小割**——割容量恰等于流值（弱对偶 + 构造性等式 = 证书：
 *   最优性可逐位检查，与 32.0 对偶证书同一品味）。
 *
 *   调度语义: max-flow = 当前可立即满足的最大并发派发；min-cut 指认
 *   **钳制者**——割边落在类型侧（需求过剩：该类任务在饿）还是模型侧
 *   （容量不足：该模型是独木桥）。吞吐上限与瓶颈归因第一次同时可算。
 *
 *   验证锚点: 经典 CLRS 网络、随机图与穷举所有割对照（小图精确）、
 *   割容量 = 流值恒等式。
 *
 * 零漂移: 未挂载时调度与执行行为与升级前逐位一致（诊断口径挂载）。
 */
/** 流网络（邻接表 + 残量矩阵；节点 0..n-1，source=0，sink=n-1） */
interface FlowNetwork {
  nodes: number;
  source: number;
  sink: number;
  /** capacity[u][v] ≥ 0（0 = 无边） */
  capacity: ReadonlyArray<ReadonlyArray<number>>;
  /** 节点标签（诊断输出用） */
  labels?: ReadonlyArray<string>;
}
interface MaxFlowResult {
  /** 最大流值（= 最小割容量——Ford-Fulkerson 定理） */
  flowValue: number;
  /** 残量网络（capacity − flow + 反向） */
  residual: number[][];
  /** 最小割（源可达集 S；割 = S → V∖S 的满容量边） */
  minCut: {
    sourceSide: number[];
    sinkSide: number[];
    edges: Array<{
      from: string;
      to: string;
      capacity: number;
    }>;
  };
  augmentingPaths: number;
}
/** Edmonds-Karp 最大流（BFS 增广；返回残量网络与最小割） */
declare function maxFlow(network: FlowNetwork): MaxFlowResult;
/** 割证书审计（验证锚点）：割边全饱和（残量 0）且割容量 = 流值 */
declare function minCutCertificate(network: FlowNetwork, result: MaxFlowResult): {
  saturated: boolean;
  cutCapacity: number;
  equalsFlow: boolean;
};
/** 穷举最小割（验证锚点；2^n 枚举，n ≤ 16 适用） */
declare function bruteForceMinCut(network: FlowNetwork): number;
interface CapacityFrontier {
  /** 可立即满足的最大并发派发（max-flow 值） */
  maxDispatch: number;
  /** 割边归因（哪些类型在饿 / 哪些模型是独木桥） */
  bindingConstraints: Array<{
    from: string;
    to: string;
    capacity: number;
  }>;
  /** 归因侧统计 */
  demandStarved: number;
  modelLimited: number;
}
/**
 * 类型需求 × 模型容量的流前沿（43.0 接线口径）。
 *
 * demands: taskType → 待执行数量；modelCapacities: modelId → maxConcurrency；
 * eligibility: (taskType, modelId) => boolean（评分 > 0 视为可达）。
 * 网络: 源 → 类型（容量 = 需求）→ 模型（可达边容量 ∞）→ 汇（容量 = 并发）。
 */
declare function capacityFrontier(demands: ReadonlyArray<{
  type: string;
  count: number;
}>, modelCapacities: ReadonlyArray<{
  id: string;
  capacity: number;
}>, eligibility: (taskType: string, modelId: string) => boolean): CapacityFrontier;
//#endregion
//#region src/model-scheduler.d.ts
/** 模型调度配置 */
interface ModelSchedulerConfig {
  /** 成本感知权重 0~1：模型选择时对单位成本的惩罚系数（0=纯质量导向） */
  costWeight?: number;
  /** 2.0：探索/利用权衡——UCB 探索开关（缺省开启；关闭后纯利用端评分） */
  explorationEnabled?: boolean;
  /** 2.0：探索加成系数（缺省 0.08；乘以 sqrt(log(1+Σn)/(1+n)) 不确定性项） */
  exploreBonus?: number;
  /** 2.0：探索生效的有效样本下限（缺省 5；样本充足的模型不再获得加成） */
  exploreSampleFloor?: number;
  /**
   * 2.0：冷启动探索预算——全部模型有效样本总和 ≥ 该值后探索关闭（缺省 30）
   *
   * 探索的使命是解决冷启动，不是永远与利用竞争：证据充足后纯利用端评分，
   * 避免大样本场景下 log(ΣN) 项给零样本模型过大加成、干扰稳健决策。
   */
  exploreBudget?: number;
  /**
   * 第五阶段 B 路线：能量反哺调度（缺省 false，零行为漂移）。
   * 启用后 updateEconomicSignals 注入的共生经济乘数作用于利用端评分：
   * 赚钱且信誉好的模型升权、持续亏损的模型降权——能量经济的生存压力
   * 直接反馈到调度行为。UCB 探索加成不受乘数影响（信息价值高于
   * 短期经济；冷启动重估机会不被经济惩罚剥夺）。
   */
  economicFeedbackEnabled?: boolean;
  /**
   * 6.0：主动推断调度（缺省 false，零行为漂移）。
   *
   * 启用后候选评分改用期望自由能 G(a) = 务实价值 − 认知价值：
   * - 务实价值 = 模型后验预测对成功偏好的期望惊奇（利用端，替代线性策略评分）
   * - 认知价值 = 该选择预期收缩多少不确定性（探索端，替代 UCB 加成——
   *   不确定性耗尽认知价值自动归零，探索预算不再需要手设常数）
   * 一个变分目标统一探索/利用，且逐选择输出「多少因为有用/多少
   * 因为想弄清」的可解释分解。未启用时评分路径逐位保持原逻辑。
   */
  freeEnergyEnabled?: boolean;
  /** 6.0：EFE 偏好强度（对成功的目标概率，缺省 0.9） */
  freeEnergyPreference?: number;
}
/** 调度决策洞察（2.0：预测置信度 + 探索标记，供反思器校准与反事实分析消费） */
interface SchedulingInsight {
  taskType: string;
  modelId: string;
  /** 所选模型的贝叶斯后验均值（调度器对成功率的预测；无画像时为中性 0.5） */
  confidence: number;
  /** 本次选择是否由探索加成胜出（冷启动模型重估机会） */
  exploration: boolean;
  /** 所选模型有效样本量（0 = 无历史证据的纯探索） */
  effectiveSamples: number;
  /** 决策依据说明 */
  rationale: string;
  /** B 路线：所选模型的共生经济乘数（能量反哺调度；未启用/无信号时为 1） */
  economicMultiplier?: number;
}
/** 任务调度上下文（规则基因组的匹配输入；可选，兼容旧调用方） */
interface SchedulerTaskContext {
  complexity?: number;
  features?: string[];
}
/**
 * 模型调度器
 *
 * 被任务执行器（task-executor.ts）持有：节点执行前调用 assignModel 分配模型，
 * 重试切换时调用 pickFallbackModel 选择次优模型。
 */
declare class ModelScheduler {
  private llm;
  private memory;
  private config;
  /** 当前生效调度策略（第三阶段：评分函数参数来源；基准 = 原固定行为） */
  private currentPolicy;
  /** B 路线：共生经济乘数（modelId → 乘数；缺省空 = 全中性） */
  private economicMultipliers;
  /** 6.0：自由能引擎（EFE 调度模式；未挂载/未启用零漂移） */
  private freeEnergy?;
  /** 21.0：索引调度器（Gittins 指数口径；未挂载零漂移） */
  private indexScheduler?;
  /** 22.0：预算路由器（Bandits with Knapsacks；未挂载零漂移） */
  private bwKRouter?;
  /** 22.0：预算提供器（每次选型时只读治理器剩余预算） */
  private bwKBudgetProvider?;
  /** 22.0：最近一次路由裁决（诊断口径；getAttachedDiagnostics 消费） */
  private lastBwKVerdict?;
  /** 31.0：对抗组合（Fixed-Share Hedge；未挂载零漂移） */
  private hedge?;
  /** 31.0：专家下标 ↔ 模型 id 映射（挂载时刻的注册模型快照） */
  private hedgeModelIds;
  /** 35.0：并发反馈控制器（未挂载零漂移——静态口径） */
  private concurrencyController?;
  /** 43.0：容量前沿挂载标志（未挂载零记录零介入） */
  private capacityFrontierEnabled;
  /** 43.0：最近一次容量前沿（max-flow 值 + min-cut 归因；诊断口径） */
  private lastCapacityFrontier?;
  /** 50.0：潜因子挂载标志（未挂载零介入——纯诊断口径） */
  private latentFactorsEnabled;
  /** 50.0：最近一次矩阵补全报告（冷启动能力预测的原料） */
  private lastCompletion?;
  constructor(params: {
    llm: LLMClient;
    memory: LongTermMemory;
    config?: ModelSchedulerConfig;
  });
  /** 运行时配置热更新（元认知自调优落地入口） */
  updateConfig(patch: Partial<ModelSchedulerConfig>): void;
  /**
   * B 路线：注入共生经济乘数（能量反哺调度；宿主心跳桥接调用）。
   *
   * 乘数来自 SymbiosisBridge.economicSignals()（余额 × Wilson 信誉的
   * 复合健康度），仅作用于利用端评分——赚钱的模型升权、持续亏损的
   * 模型降权。注入即生效（对后续 assignModel/pickEnsemble/pickFallback
   * 全路径一致）；信号中缺失的模型回退中性乘数 1。
   * @param signals modelId → 调度乘数（典型范围 0.5~1.5）
   */
  updateEconomicSignals(signals: Record<string, number> | Map<string, number>): void;
  /**
   * 6.0：挂载自由能引擎（幂等；需同时 freeEnergyEnabled=true 才生效）。
   *
   * @param engine 主动推断内核实例（宿主单一实例共享）
   * @param outcomeNode 因果图结果节点（缺省 'task.outcome'；模型选择即
   *   do(use:model) 干预，证据由共生结算侧登记）
   */
  attachFreeEnergy(engine: FreeEnergyEngine, outcomeNode?: string): void;
  private efeOutcomeNode;
  /**
   * 21.0：挂载索引调度器（幂等覆盖，挂载即生效）。
   *
   * 挂载后 assignModelWithInsight 的动态选型升级为 Gittins 索引口径：
   * 候选（Beta 后验臂）按 effectiveIndex = ν × availability 降序取榜首。
   * preferred 短路 / avoidModels 剔除 / 无候选抛 ExecutionError 的语义
   * 保持不变；未挂载时动态选型与原路径逐位一致（零漂移）。
   */
  attachIndexScheduler(scheduler: IndexScheduler): void;
  /**
   * 22.0：挂载预算路由器与预算提供器（幂等覆盖）。
   *
   * budgetProvider 在每次选型时读取剩余预算（只读，不推进状态）；
   * 返回 undefined 或 tokensRemaining ≤ 0 时本路由不介入（走原路径）。
   */
  attachBwKRouter(router: BwKRouter, budgetProvider: () => {
    tokensRemaining: number;
    costRemaining: number;
  } | undefined): void;
  /** 21.0/22.0/31.0/35.0：已挂载数学内核的诊断快照（未挂载/未裁决的键不出现） */
  getAttachedDiagnostics(): {
    indexScheduling?: GittinsSnapshot;
    lastBwK?: BwKVerdict;
    hedge?: HedgeStats;
    concurrencyControl?: ControlStep;
  };
  /**
   * 31.0：挂载对抗组合（Fixed-Share Hedge，幂等覆盖，挂载即生效）。
   *
   * 专家 = 挂载时刻的注册模型快照；执行侧每节点完成时经
   * reportHedgeOutcome(modelId, reward∈[0,1]) 回报质量。权重经
   * hedgeMultiplierOf 以有界乘数（[0.25, 4]）作用于利用端评分——
   * 统计学习口径（Wilson/UCB/Gittins）之上叠加**对抗口径**：无论世界
   * 怎么漂移（限流、静默降级），对事后最优固定模型的遗憾 ≤ √(2T lnN)。
   * 未挂载时乘数恒 1（评分逐位零漂移）。
   */
  attachHedgePortfolio(options?: {
    eta?: number;
    alpha?: number;
  }): void;
  /**
   * 31.0：执行结果回报（reward = 成功质量 ∈ [0,1]，失败 = 0；未挂载为空操作）。
   *
   * 部分反馈口径：本轮仅被指派模型有观测（掩码更新——未被指派的专家
   * 权重不动，只受 Fixed-Share 回灌微调）。对手把某模型打爆时，其权重
   * 以每失败一轮 e^{−η} 的速度衰减——比统计口径（Wilson 时间衰减）快
   * 一个数量级的对抗性降权。
   */
  reportHedgeOutcome(modelId: string, reward: number): void;
  /** 31.0：对抗组合对模型的有界评分乘数（未挂载恒 1；零漂移） */
  hedgeMultiplierOf(modelId: string): number;
  /**
   * 35.0：挂载并发反馈控制器（幂等覆盖，挂载即生效）。
   *
   * computeParallelism 从静态口径（总并发容量钳位）升级为闭环：每次
   * 被调用即一步反馈（观测当前总利用率 → LQR 增益 → 新上限），目标
   * 利用率缺省 0.75。稳定性由 DARE/Lyapunov 证书背书（35.0 内核），
   * 死区抗抖振、输出钳位即抗饱和。未挂载时与原静态口径逐位一致。
   */
  attachConcurrencyController(options?: FeedbackControllerConfig): void;
  /** 35.0：最近一次控制步（诊断口径） */
  private lastControlStep?;
  /**
   * 43.0：挂载容量前沿（幂等覆盖，挂载即生效——纯诊断口径）。
   *
   * 「类型需求 × 模型容量」流网络（源→类型（需求）→模型（评分>0 可达
   * 边）→汇（maxConcurrency））上解 Edmonds-Karp 最大流 = 可立即满足
   * 的最大并发派发；最小割指认钳制者（类型在饿还是模型是独木桥）——
   * 割容量 = 流值（Ford-Fulkerson 证书）。执行器每批回写待执行需求；
   * 不改变任何派发行为（零漂移），吞吐上限与瓶颈归因经
   * getAttachedDiagnostics / query_memory capacity 可读。
   */
  attachCapacityFrontier(): void;
  /** 43.0：执行批回写待执行需求（未挂载为空操作；类型计数 × 候选容量 → 流前沿） */
  updateCapacityFrontier(demands: ReadonlyArray<{
    type: string;
    count: number;
  }>): void;
  /**
   * 50.0：挂载潜因子补全（幂等覆盖，挂载即生效——纯诊断口径）。
   *
   * 「模型 × 任务类型」能力矩阵经 ALS 低秩补全（rank 缺省 3）：观测
   * 条目（各模型 taskScores 已有值的部分）拟合 U·Vᵀ，未观测条目由
   * 潜因子外推——新模型的冷启动选型从零样本瞎选升级为潜维度预测
   * （Candès–Recht 恢复条件背书）。lowRankShare 读出低秩假设的成色；
   * 不改变任何评分路径（零漂移），coldStartEstimate 按需读取。
   */
  attachLatentFactors(options?: {
    rank?: number;
  }): void;
  private latentRank;
  /** 50.0：重算能力矩阵补全（观测 = 各模型 taskScores 的非空条目，行=模型 列=任务类型并集） */
  private refreshLatentFactors;
  private latentTypeIndex;
  private latentModelIndex;
  /**
   * 50.0：冷启动能力预测（观测未覆盖的 model×taskType 条目由潜因子
   * 外推；未挂载/未覆盖返回 undefined——诚实降级）
   */
  coldStartEstimate(modelId: string, taskType: string): number | undefined;
  /** 50.0：补全报告快照（纯读取） */
  getLatentFactorReport(): {
    rank: number;
    trainRmse: number;
    observedRatio: number;
    lowRankShare: number;
    converged: boolean;
  } | undefined;
  /** 43.0：最近一次容量前沿（纯读取；未挂载/未回写返回 undefined） */
  getCapacityFrontier(): CapacityFrontier | undefined;
  /** 模型的当前经济乘数（无信号 = 中性 1；economicFeedbackEnabled 关闭时恒为 1） */
  economicMultiplierOf(modelId: string): number;
  /**
   * 策略热切换（第三阶段：策略进化器部署入口）
   *
   * 由 PolicyEvolver.deployPolicy → onDeploy 回调调用；
   * 替换评分函数参数集，立即对后续 assignModel 生效，无需重启。
   */
  updatePolicy(policy: Policy): void;
  /** 当前生效策略（供优化器标注策略版本） */
  getPolicy(): Policy;
  /** 解析上下文有效参数（规则基因组匹配；无规则时即基础参数） */
  private effectiveParams;
  /** 单模型评分（2.0：贝叶斯证据装配——Wilson 下界 + 有效样本量 + 质量 EMA） */
  private scoreModel;
  /**
   * 全候选评分（2.0：利用端策略评分 + UCB 探索加成）
   *
   * 探索/利用权衡（解决裸计数调度的两个死局）：
   * - 冷启动死局：新模型 0 样本得中性分 0.5，永远竞争不过平庸但样本多的模型
   * - 埋没死局：模型早期失败后，即使能力已修复也永无翻身机会
   *
   * UCB 加成 = exploreBonus × sqrt(log(1+ΣN) / (1+n_i))：
   * 样本越少加成越大（信息价值高）；仅冷启动期（ΣN < exploreBudget）
   * 生效，且有效样本 ≥ exploreSampleFloor 的模型不加成（纯利用）。
   */
  private scoreCandidates;
  /** 所选模型的决策洞察（预测置信度 + 探索标记 + 依据说明） */
  private insightOf;
  /** 所选模型的贝叶斯置信度（重试切换后由执行器刷新洞察用） */
  modelInsight(taskType: string, modelId: string): SchedulingInsight;
  /**
   * 21.0/22.0：已挂载数学内核的候选选型（零漂移守卫——未挂载/预算
   * 不可用时返回 undefined，调用方走原路径，行为与升级前逐位一致）。
   *
   * 优先级：indexScheduler（可证明最优的 Gittins 索引口径）>
   * bwKRouter（预算约束下的 BwK 路由）> 原评分路径。两条内核路径均
   * 保持 preferred 短路与 avoidModels 剔除之后的候选集语义。
   */
  private selectWithAttachedKernels;
  /**
   * 为任务类型分配最优模型（能力画像 × 贝叶斯记忆画像 × 成本感知 × 探索/利用权衡）
   *
   * 第三阶段：评分核心改用策略参数化的 scoreModelWithPolicy
   * （与安全沙盒共享同一实现，参数 = 基准策略时与原固定公式一致）。
   * 质级升级：传入 context 时按规则基因组解析上下文有效参数。
   * 2.0：记忆证据从裸成功率升级为 Wilson 下界 + 有效样本量 + UCB 探索。
   *
   * @param taskType 任务类型
   * @param preferred 优化器推荐的模型（优先）
   * @param context 任务上下文（复杂度/特征；供规则基因匹配）
   */
  assignModel(taskType: string, preferred?: string, context?: SchedulerTaskContext, options?: {
    avoidModels?: string[];
  }): string;
  /**
   * 带洞察的模型分配（2.0：返回预测置信度与探索标记，供反思器校准闭环）
   *
   * 与 assignModel 共享同一评分与选择逻辑；编排层用本方法收集决策洞察，
   * 在复盘时回注反思器计算 Brier 校准误差与反事实遗憾。
   * 4.0：avoidModels 负向约束——经验规避模型（历史超时/能力不足）从候选剔除，
   * 推荐模型被规避时同样降级为动态评分选型（勘察修复：升级前 avoidModels
   * 产出后无人消费，负向经验在调度端断链）。
   * 21.0/22.0：挂载索引调度器 / 预算路由器后动态选型升级为 Gittins 索引 /
   * Bandits-with-Knapsacks 口径（preferred 短路与 avoidModels 语义不变；
   * 未挂载时逐位保持原行为）。
   */
  assignModelWithInsight(taskType: string, preferred?: string, context?: SchedulerTaskContext, options?: {
    avoidModels?: string[];
  }): SchedulingInsight;
  /**
   * 多模型集成候选（第三阶段：模型组合逻辑的策略落地）
   *
   * 按当前策略评分降序返回前 N 个模型（供执行侧并行执行 + 融合决策）。
   * 质级升级：传入 context 时按规则基因组解析上下文有效参数
   * （如规则强制 ensembleForce=true 的任务类型稳定给出组合候选）。
   * @param taskType 任务类型
   * @param count 集成模型数（缺省取策略 ensembleMaxModels）
   * @param exclude 排除的模型 id（如重试时排除当前模型）
   * @param context 任务上下文（复杂度/特征；供规则基因匹配）
   */
  pickEnsemble(taskType: string, count?: number, exclude?: string[], context?: SchedulerTaskContext): string[];
  /**
   * 选择次优模型（排除当前模型，按策略评分；context 供规则基因匹配）
   * 4.0：excludeModels 额外排除清单（经验规避模型 / 熔断中模型），向后兼容
   */
  pickFallbackModel(taskType: string, excludeModelId: string, context?: SchedulerTaskContext, excludeModels?: string[]): string | undefined;
  /**
   * 动态并行度：依据已注册模型的总并发容量计算同层最大并行数
   * （避免同层节点数超过模型并发容量导致全部排队）
   *
   * 35.0：挂载反馈控制器后升级为闭环口径——每次调用即一步反馈
   * （观测总利用率 activeRequests / 总容量 → LQR 增益步 → 新上限，
   * 死区抗抖振、钳位 [1,16] 抗饱和，稳定性由 Lyapunov 证书背书）。
   * 未挂载时与原静态口径逐位一致（零漂移）。
   */
  computeParallelism(): number;
  /**
   * 32.0：候选评分公开口径（批量全局指派的收益矩阵原料）。
   *
   * 与 assignModelWithInsight 同一评分路径（含 UCB/EFE 加成与经济/
   * 对抗乘数），返回 (id, total) 降序排列——供执行侧构造批内收益矩阵，
   * 匈牙利算法在「同一批节点 × 全体候选」上求全局最优指派。
   */
  rankCandidateScores(taskType: string, context?: SchedulerTaskContext, exclude?: string[]): Array<{
    id: string;
    score: number;
  }>;
}
//#endregion
//#region src/task-executor.d.ts
/** 任务执行器配置 */
interface TaskExecutorConfig {
  qualityThreshold: number;
  maxRetries: number;
  /** 计划级全局超时（毫秒） */
  globalTimeout: number;
  /** 单节点默认超时（毫秒） */
  nodeTimeout: number;
  /** 是否广播进度事件 */
  enableProgress: boolean;
  verbose: boolean;
  /**
   * 4.0：模型级熔断阈值（同一模型连续可用性失败次数，达到即熔断该模型）
   * 缺省 5；设为 0 关闭熔断（与升级前行为一致）
   */
  circuitFailureThreshold?: number;
  /** 4.0：熔断冷却期（毫秒，缺省 60s），期满转半开放行单次试探 */
  circuitCooldownMs?: number;
  /**
   * 4.0：重试退避基数（毫秒，缺省 0 = 不退避，与升级前紧贴重发一致）。
   * 全抖动指数退避：min(base×2^(attempt-1), retryBackoffMaxMs) 内均匀采样
   */
  retryBackoffBaseMs?: number;
  /** 4.0：重试退避上限（毫秒，缺省 8000） */
  retryBackoffMaxMs?: number;
}
/**
 * 任务执行器
 *
 * 被 index.ts 持有：编排层完成战略决策与计划生成后，将计划交给本执行器执行。
 */
declare class TaskExecutor {
  private config;
  private llm;
  private modelScheduler;
  private broadcaster?;
  private nodeRunner;
  private cascadeHandler?;
  /** 反思引擎（可选，节点级质量反思） */
  private reflection?;
  /** 4.0：模型级熔断器注册表（circuitFailureThreshold=0 时不启用） */
  private breakers?;
  /** 2.0：最近一次计划执行的调度决策洞察（校准闭环素材，getAndClearDecisionInsights 取走） */
  private decisionInsights;
  /** 32.0：批内全局最优指派（匈牙利算法；未挂载时逐节点选型原样） */
  private batchAssignmentEnabled;
  /** 32.0：批内指派的候选池上限（每任务类型取评分前 K） */
  private batchCandidateCap;
  constructor(params: {
    config: TaskExecutorConfig;
    llm: LLMClient;
    modelScheduler: ModelScheduler;
    broadcaster?: ProgressBroadcaster;
    nodeRunner?: NodeRunner;
    cascadeHandler?: CascadeHandler;
    reflection?: ReflectionEngine;
  });
  /**
   * 运行时配置热更新（元认知自调优落地入口）
   * @param patch 配置补丁（仅覆盖提供的字段）
   */
  updateConfig(patch: Partial<TaskExecutorConfig>): void;
  /**
   * 32.0：挂载批内全局最优指派（幂等，挂载即生效）。
   *
   * 挂载后每个执行批（同层就绪节点 × 并发上限切片）中的**动态选型节点**
   * 不再逐个调用调度器（局部贪心），而是构造「节点 × 候选模型」收益
   * 矩阵（与逐节点路径同一评分口径），经匈牙利算法求**全局总收益最优**
   * 的一对一指派（O(n³) 精确解，携带对偶证书）——最优模型不再被同批
   * 节点重复超订，次优模型不再闲置。计划指定 / 优化器推荐的节点不受
   * 影响（约束优先，只对无约束节点做全局协调）。未挂载时逐位零漂移。
   */
  attachOptimalAssignment(options?: {
    candidateCap?: number;
  }): void;
  /** 32.0：批内指派断开（诊断/回退口径） */
  detachOptimalAssignment(): void;
  /**
   * 32.0：为执行批计算全局指派（节点 id → 模型 id；无指派必要的批返回 undefined）。
   *
   * 只有批内「动态选型节点」（无计划指定模型、无可执行推荐模型）≥ 2 且
   * 候选模型 ≥ 2 时才升级为全局口径；被约束节点占用的模型从候选池剔除
   * （一对一语义）。返回的 map 缺席 = 该节点走原动态路径（诚实降级）。
   */
  private planBatchAssignment;
  /**
   * 取走最近一次计划执行的调度决策洞察（2.0：校准闭环桥接）
   *
   * 编排层在 executePlan 返回后调用本方法，将洞察作为
   * reflectOnOutcome({ decisionInsights }) 回注反思器，
   * 完成「调度预测 → 实际结果 → Brier 校准」闭环。
   * 取走即清空（每份洞察只消费一次）。
   */
  getAndClearDecisionInsights(): Array<{
    nodeId: string;
    taskType: string;
    modelId: string;
    predictedConfidence: number;
    exploration: boolean;
    success: boolean;
  }>;
  /**
   * 计划生成 — 解析 strategist 输出，非法时回退离线计划
   * @param objective 任务目标
   * @param strategistOutput strategist 模型原始输出（可为空）
   * @param taskType 任务类型
   */
  buildPlan(objective: string, strategistOutput: string | undefined, taskType: string): ExecutionPlan;
  /**
   * 执行完整计划
   *
   * 深度优化：
   * - 截止时间感知：signal.deadlineMs 存在时，全局超时收紧为 min(globalTimeout, deadline - now)
   * - 动态并行度：同层节点数超过模型总并发容量时分批执行，避免并发过载排队
   * - 4.0：avoidModels 负向约束贯通——优化器产出的规避模型在调度与重试切换中全局排除
   *
   * @param signal 触发信号
   * @param plan 执行计划
   * @param recommendedModels 优化器产出的按节点类型推荐模型（模型调度优先采纳）
   * @param options 4.0 扩展选项（avoidModels：经验规避模型，调度与重试全程排除）
   * @returns 计划执行结果
   */
  executePlan(signal: Signal, plan: ExecutionPlan, recommendedModels?: Record<string, string>, options?: {
    avoidModels?: string[];
  }): Promise<PlanExecutionResult>;
  /** 模型级熔断快照（运维可观测：哪些模型被熔断、连续失败数） */
  getBreakerSnapshot(): Record<string, {
    state: string;
    consecutiveFailures: number;
  }>;
  /** 模型当前是否可执行（无熔断器或熔断器放行；peek 纯读取不占探测名额） */
  private modelExecutable;
  /** 选择健康的次优模型：排除当前模型、规避模型与熔断中的模型 */
  private pickHealthyFallback;
  /** 单节点执行（4.0：熔断感知调度 + 错误分型退避重试 + 质量反思切换、级联触发） */
  private executeNode;
  /** 带节点级超时的 nodeRunner 调用 */
  private runWithTimeout;
  /** 默认节点执行器：通过 LLMClient 调用分配模型 */
  private defaultNodeRunner;
  /** 级联触发：节点完成且质量达标时回注下游信号 */
  private triggerCascade;
  /** 拓扑分层（Kahn 算法），检测环 */
  private topologicalLayers;
  /** DAG 结构校验（节点 id 唯一、依赖存在、无环） */
  private validateDag;
  /** 归一化 strategist 输出的节点 */
  private normalizeNode;
  /** 进度事件广播（enableProgress 关闭时为空操作） */
  private broadcast;
}
//#endregion
//#region src/reflector.d.ts
/** 反思器配置 */
interface ReflectorConfig {
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
  /** 校准滑动窗口容量（缺省 50；Brier 残差滚动统计范围） */
  calibrationWindowSize?: number;
  /** 反事实遗憾触发的置信差距（缺省 0.1；替代者下界须超过所用模型后验均值该幅度） */
  counterfactualMargin?: number;
  /** 反事实分析的最低有效样本量（缺省 3；证据不足不产生遗憾结论） */
  counterfactualMinSamples?: number;
}
/** 决策洞察记录（2.0：执行器收集、反思器消费的调度预测归因） */
interface DecisionInsightRecord {
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
interface CalibrationStatus {
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
/**
 * 反思器
 *
 * 被编排层（index.ts）持有：执行器完成计划后调用 reflectOnOutcome()，
 * 一次性完成「复盘 → 记忆更新 → 策略反馈 → 蒸馏」全链路学习。
 */
declare class Reflector implements IReflector {
  private memory;
  private reflection;
  private config;
  private broadcaster?;
  private graph?;
  /** 同步变更登记回调（由 index.ts 桥接到 distributed-sync.recordChange） */
  private onMemoryChange?;
  /** 蒸馏进行中标志（阈值自动触发的防抖，避免并发重复蒸馏） */
  private distilling;
  /** 37.0：信息瓶颈蒸馏定价（attachBottleneckDistiller 后生效；未挂载零漂移） */
  private bottleneck?;
  /** 37.0：最近一次瓶颈定价读数（审计口径） */
  private lastBottleneck?;
  /** 2.0：校准滑动窗口（Brier 残差滚动统计） */
  private calibrationWindow;
  constructor(params: {
    memory: IMemoryStore;
    reflection: ReflectionEngine;
    config?: ReflectorConfig;
    broadcaster?: ProgressBroadcaster;
    graph?: MemoryGraph;
    onMemoryChange?: (type: ChangeEntry['type'], fingerprint: string, payload: ChangePayload) => void;
  });
  /**
   * 运行时配置热更新（第四阶段：元认知控制器调参落地入口）
   *
   * 元认知层经此调整反思触发频率与蒸馏门槛（autoDistillThreshold /
   * distillMinConfidence 等），立即对后续复盘生效，无需重启。
   * 回调类字段（onLesson/onDistilled/...）仅显式传入时覆盖。
   */
  updateConfig(patch: ReflectorConfig): void;
  /** 当前配置快照（元认知旋钮 read 端；只读） */
  getConfig(): Readonly<ReflectorConfig>;
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
    appliedMemoryIds?: {
      semantic?: string[];
      procedural?: string[];
    };
    /** 2.0：本次各节点的调度决策洞察（校准闭环素材；缺省跳过校准更新） */
    decisionInsights?: DecisionInsightRecord[];
  }): void;
  /**
   * 校准更新（2.0：预测置信度 vs 实际结果的滚动统计）
   *
   * Brier 分 = mean((predicted - actual)²)——概率预测质量金标准：
   * 调度器说「90% 能成」的实际成了 → 无惩罚；说 90% 却连续失败 → 重罚。
   * 这是「系统知道自己有多准」的自知之明，过自信/欠自信方向可诊断。
   */
  private updateCalibration;
  /** 校准状态查询（2.0：调度预测质量的持续自知；3.0：附带自修正量） */
  getCalibration(): CalibrationStatus;
  /**
   * 校准自修正（3.0）：对调度预测置信度施加校准偏移
   *
   * 过自信系统（如预测 0.9 实际 0.7）→ 收缩预测使其贴近真实成功率；
   * 欠自信系统 → 适度放大。样本不足或已校准时为恒等映射（零风险旁路）。
   */
  correctConfidence(predicted: number): number;
  /**
   * 自知之明报告（3.0：系统对自己记忆与预测质量的一次性全景自检）
   *
   * 汇聚两路自知信号：
   * - calibration：调度预测校准（Brier / 残差 / 方向 / 自修正量）
   * - census：全层证据普查（各记忆层证据覆盖度 + 有效样本量 + 证据枯竭 +
   *   模型能力漂移）——记忆库未实现 evidenceCensus 时静默省略（旧实现兼容）
   */
  getSelfKnowledge(): {
    generatedAt: number;
    calibration: CalibrationStatus;
    census?: EvidenceCensus;
  };
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
  private analyzeCounterfactualRegret;
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
  attachBottleneckDistiller(options?: {
    beta?: number;
    retentionFloor?: number;
  }): void;
  /** 37.0：最近一次瓶颈定价读数（未挂载/未评估时 undefined） */
  getBottleneckView(): {
    retention: number;
    iXY: number;
    clusters: number;
    sampleCount: number;
  } | undefined;
  distillKnowledge(options?: {
    force?: boolean;
  }): Promise<DistillationReport>;
  /**
   * 内容寻址稳定 id（第二阶段升级）
   *
   * 同一规律（相同组成要素）跨次蒸馏生成相同 id，使 upsert 的证据合并
   * 能命中既有记录，而非每次插入新 id 后靠 statement 判重丢弃证据。
   */
  private stableId;
  /**
   * 蒸馏模型亲和规律（语义记忆 domain='model-affinity'）
   *
   * 按 taskType 聚合所有合格模式中的模型分配，若某模型占比 ≥ affinityThreshold
   * 且支撑模式数 ≥ 2，则产出跨任务规律："X 类任务适合模型 Y"。
   */
  private distillModelAffinity;
  /**
   * 蒸馏复杂度模式（语义记忆 domain='complexity-pattern'）
   *
   * 高复杂度（complexity ≥ 0.7）任务的成功模型偏好。
   */
  private distillComplexityPatterns;
  /**
   * 蒸馏调度规则（程序记忆 kind='scheduling'）
   *
   * 规则：feature='code' 且 complexity ≥ 0.7 的任务 → prefer-model + enable-cot
   * 支撑：该任务类型的成功方案中存在模型偏好。
   */
  private distillSchedulingRules;
  /**
   * 蒸馏反思规则（程序记忆 kind='reflection'）
   *
   * 从反思教训中提炼：rootCause='timeout' → avoid-model + escalate
   * rootCause='model-capability' → avoid-model + retry-switch
   */
  private distillReflectionRules;
  /** 从模式指纹提取 taskType（首段，去除 [失败] 前缀） */
  private extractTaskType;
  /** 构建蒸馏报告摘要 */
  private buildDistillationSummary;
  /** 经验沉淀：成功方案 / 失败记录写入记忆库并登记同步变更 */
  private settleExperience;
  /** 进度事件广播（enableProgress 关闭或 broadcaster 缺省时为空操作） */
  private broadcast;
}
//#endregion
//#region src/core/shapley.d.ts
/**
 * shapley.ts — Shapley 公平归因内核（项目 16.0「功劳分配有了公理根基」质变基座）
 *
 * 升级前的根本局限（多智能体协作的分配黑洞）：
 * - 「谁创造了价值」全靠启发式：均分（大锅饭）、末次触达（抢功）、
 *   出现计数（可刷）——三种启发式对同一份协作产出给出三种互相矛盾的
 *   分配，谁也说不清哪种「对」，因为它们不满足任何公平公理；
 * - 全部可被策略性操纵：搭便车者（不干活但出现）与末位冲刺者
 *   （在结果即将敲定时蹭最后一手）拿走真实贡献者的报酬——
 *   归因体系没有抗操纵的数学骨架；
 * - 点估计无不确定性：「模型 A 贡献 0.37」与「我们对 0.37 一无所知」
 *   在报表上无法区分。
 *
 * 本内核引入合作博弈论的 Shapley 值（Shapley 1953；2012 诺贝尔经济学奖）：
 *
 * 1. **公理化唯一性**：Shapley 值是同时满足四条公平公理的唯一分配——
 *    - 效率（efficiency）：Σφᵢ = V(N)，价值全额分发无遗漏；
 *    - 对称（symmetry）：对所有联盟边际贡献相同的两玩家分配相等；
 *    - 虚拟（dummy）：对所有联盟边际贡献为零者恰好分得 0
 *      ——搭便车在数学上无利可图，归因第一次拥有抗操纵性；
 *    - 可加（additivity）：两博弈的 Shapley 分配之和 = 联合博弈的分配。
 *
 * 2. **精确枚举（n ≤ exactThreshold）**：2ⁿ 联盟值全枚举 + 记忆化 +
 *    标准加权公式 φᵢ = Σ_{S⊆N∖{i}} |S|!(n−|S|−1)!/n!·[V(S∪{i})−V(S)]。
 *
 * 3. **排列采样 + 任意时刻有效置信区间（建在 12.0 之上）**：
 *    随机排列的边际贡献是 Shapley 值的无偏估计（Bourgaine–Friedgut）；
 *    每次排列为每个玩家产出一份边际样本，喂入经验伯恩斯坦置信序列
 *    （边际值域 [−1,1] 仿射缩放到 [0,1] 后观测，区间映射回来）——
 *    **偷看安全**：任意时刻读区间均有效，采样随停随用；
 *    提前停止：相邻名次玩家的置信区间分离（上者下界 > 下者上界）
 *    即停——「排定座次」本身成为受控事件，不再烧完预算才出结果。
 *
 * 4. **协同检测（synergy）**：V(A∪B) − V(A) − V(B) > 0 的玩家对
 *    存在正协同（1+1>2）——团队组建与编排亲和的量化依据；
 *    负协同（互相拆台）同样曝光，负协同对在编排上应被拆散。
 *
 * 5. **关键性指数（Banzhaf swing）**：玩家在多少联盟中是「摇摆者」
 *    （边际贡献 > 容差即改变局面）——比 Shapley 更尖锐的
 *    「关键人/不可替代节点」检测，供共生经济识别单点依赖。
 *
 * 与 12.0 的关系：Shapley 采样的不确定性由 12.0 的置信序列背书——
 * 归因数字第一次自带「这个数可信到什么程度」的数学答案。
 * 与 3-15.0 的关系：证据内核（3.0）记录「谁参与了什么」，因果内核
 * （5.0）回答「干预效应几何」，本内核回答「合作剩余如何公平分割」——
 * 参与 → 效应 → 分配，三层递进构成完整的多智能体问责链。
 */
/** 联盟价值函数：给定一组玩家，返回该联盟独立可创造的价值（值域 [0,1]） */
type CoalitionValueFunction = (coalition: readonly string[]) => number;
/** Shapley 内核配置 */
interface ShapleyConfig {
  /** 精确枚举的玩家数上限（2ⁿ 联盟值全枚举；缺省 8 → 256 次估值） */
  exactThreshold: number;
  /** 排列采样预算上限（缺省 2000） */
  maxPermutations: number;
  /** 置信序列水平 α（区间覆盖 ≥ 1−α，任意时刻有效；缺省 0.05） */
  alpha: number;
  /** 提前停止判定的最小排列数（缺省 30——之前不允许停） */
  minPermutations: number;
  /** 协同/关键性判定的边际容差（缺省 1e-9） */
  tolerance: number;
  /** 随机数源（缺省 Math.random；测试可注入确定性序列） */
  rng?: () => number;
}
declare const DEFAULT_SHAPLEY_CONFIG: ShapleyConfig;
/** 单玩家归因结果 */
interface ShapleyAttribution {
  /** 玩家标识 */
  playerId: string;
  /** Shapley 值（精确枚举=真值；采样=无偏估计的中心） */
  shapley: number;
  /** 任意时刻有效置信下界（采样模式；精确模式与 shapley 重合） */
  lower: number;
  /** 任意时刻有效置信上界 */
  upper: number;
  /** 归因份额 φᵢ/V(N)（Σ share = 1——效率公理的可观测面） */
  share: number;
  /** 名次（按 shapley 降序，1 起） */
  rank: number;
  /** 是否精确枚举（false = 排列采样估计） */
  exact: boolean;
  /** 排列样本量（精确模式 = 联盟枚举覆盖数） */
  samples: number;
  /** Banzhaf 关键性：摇摆联盟占比（0~1；高 = 不可替代节点） */
  criticality: number;
  /** 虚拟玩家标记（所有边际 ≤ 容差——数学上应得 0） */
  isDummy: boolean;
  /** 是否已统计确证为正贡献（下界 > 0；采样模式的偷看安全裁决） */
  provablyPositive: boolean;
}
/** 玩家对协同分析 */
interface SynergyPair {
  a: string;
  b: string;
  /** V(A∪B) − V(A) − V(B)（> 0 正协同；< 0 互相拆台） */
  synergy: number;
  kind: 'positive' | 'negative';
}
/** 归因报告 */
interface ShapleyReport {
  /** 玩家数 */
  players: number;
  /** 大联盟价值 V(N) */
  totalValue: number;
  /** 归因明细（按 shapley 降序） */
  attributions: ShapleyAttribution[];
  /** 协同对（按 |synergy| 降序；仅显著者） */
  synergies: SynergyPair[];
  /** 是否精确枚举 */
  exact: boolean;
  /** 消耗的排列数（采样模式；精确模式为 0） */
  permutations: number;
  /** 效率公理残差 Σφᵢ − V(N)（份额已归一 → 残差恒 0，验证公理成立） */
  efficiencyResidual: number;
  /** 提前停止原因 */
  stopReason: 'exact' | 'budget' | 'ranking-decided';
  interpretation: string;
}
/**
 * Shapley 公平归因引擎
 *
 * 用法：
 *   const engine = new ShapleyAttributionEngine(valueFunction, config);
 *   const report = engine.attribute(['model-a', 'model-b', 'model-c']);
 *
 * 价值函数约定：值域 [0,1]（成功率/质量分/归一化收益等天然满足）；
 * 边际贡献因此落在 [−1,1]，采样模式经仿射缩放喂入 12.0 置信序列。
 */
declare class ShapleyAttributionEngine {
  private readonly config;
  private readonly valueOf;
  private readonly rng;
  /** 联盟值缓存（key = 排序后玩家逗号连接；跨调用复用——价值函数可能是昂贵查询） */
  private readonly cache;
  constructor(valueFunction: CoalitionValueFunction, config?: Partial<ShapleyConfig>);
  /** 缓存命中的联盟值数（可观测：昂贵价值函数的节省程度） */
  get cacheHits(): number;
  /**
   * 公平归因主入口。
   *
   * n ≤ exactThreshold：2ⁿ 全枚举（精确，含 Banzhaf 关键性与协同对）；
   * 否则：排列采样 + 12.0 置信区间（提前停止：名次分离即停）。
   */
  attribute(players: readonly string[]): ShapleyReport;
  private attributeExact;
  private attributeSampled;
  /**
   * 名次分离判定：按当前中心估计排序后，所有相邻对
   * （上者置信下界 > 下者置信上界）均分离 → 座次统计上已定。
   * 置信序列任意时刻有效——这一判定本身偷看安全。
   */
  private rankingDecided;
  /**
   * 两两协同分析：V(A∪B) − V(A) − V(B)。
   * 正协同对应组队增益，负协同对应互相拆台——均只保留超容差者。
   */
  detectSynergies(players: readonly string[]): SynergyPair[];
  /** 联盟值查询（排序记忆化：同一玩家集合只估值一次） */
  private coalition;
  private interpretExact;
}
//#endregion
//#region src/core/optimal-stopping.d.ts
/**
 * optimal-stopping.ts — 最优停止内核（项目 19.0「等待有了数学价格」质变基座）
 *
 * 升级前的根本局限（defer 决策的拍脑袋阈值）：
 * - 「紧急度 < 0.3 且成本 > 5000 → 延迟 5 分钟」——两个魔数没有任何
 *   最优性依据：为什么是 0.3？为什么延迟恰好 5 分钟？延迟之后世界
 *   会更好还是更差？现有口径一概不知，defer 只是「不敢做」的委婉语；
 * - 「现在做」vs「等下一个机会」之间没有价值权衡：信号到达是随机的
 *   流，当前机会的紧急度是一次抽样——如果未来还会来 k 个机会，
 *   当前这次值不值得占坑，是一个标准的最优停止问题，但系统从没
 *   把它当最优停止问题对待过；
 * - 无竞争性保证：任何在线停止策略都至少要回答「最坏比能看到的
 *   最好的差多少」（先知差距）——没有这个下界，defer 策略无法
 *   自证不是在系统性放弃价值。
 *
 * 本内核引入最优停止理论（经典秘书问题谱系：Krengel–Sucheston–
 * Garling 先知不等式；Samuel-Cahn 1984 阈值规则；Bruss 2000 赔率算法）：
 *
 * 1. **精确向后归纳（经验分布上的最优解）**：机会价值 ~ 经验分布
 *      Vₙ = E[X]；V_k = E[max(X, V_{k+1})] = (1/m) Σᵢ max(xᵢ, V_{k+1})
 *    还剩 k 次机会时的期望所得 V_k 逐层精确递推（经验测度下无近似）；
 *    最优策略是阈值策略：当前值 ≥ V_{k−1}（继续价值）即停。
 *
 * 2. **先知基准（prophet value）**：E[max X₁..Xₙ] 由次序统计量精确计算
 *      P(M ≤ x) = F(x)ⁿ ⇒ E[M] = Σᵢ x₍ᵢ₎·[(i/m)ⁿ − ((i−1)/m)ⁿ]
 *    任何在线策略的所得 ≤ 先知所得——先知差距（competitive ratio）
 *    衡量停止策略的成色。
 *
 * 3. **Samuel-Cahn 单阈值规则（分布无关 ½ 保证）**：取 τ = max 的中位数
 *    （F(τ)ⁿ = 1/2 的解），首见 X ≥ τ 即停。对**任意分布**保证
 *      E[规则所得] ≥ ½·E[先知所得]
 *    ——不需要知道分布形状的保守底线，且对适中的 n 常显著超过 ½。
 *
 * 4. **秘书问题与赔率算法（序贯选择的另两把刀）**：
 *    - 1/e 规则（n 已知、只见相对名次）：跳过前 n/e 个，之后取首个
 *      纪录——以恰好 1/e 概率选中全局最优，渐近最优；
 *    - Bruss 赔率算法（独立事件「最后一个成功」）：赔率 r = p/(1−p)，
 *      从最后一个 Σ r ≥ 1 的下标起在首个成功处停——期望停止次数
 *      与最优相差 ≤ 1 的优雅定理。
 *
 * 5. **机会停止器（OpportunityStopper）**：按上下文（信号类型）流式
 *    积累机会价值经验分布，`assess(当前值, 剩余机会数)` 返回
 *    { act, threshold, ruleValue, prophetValue, competitiveRatio }——
 *    defer/execute 第一次由「继续价值的精确阈值」而非拍脑袋魔数裁决。
 *
 * 与 8.0 的关系：8.0 元推理回答「**思考**何时停」（内部计算的最优
 * 分配），本内核回答「**等待**何时停」（外部机会的最优锁定）——
 * 内外两种停止问题共用「继续价值 vs 立即价值」的同一数学骨架；
 * 与 12.0 的关系：12.0 保证「随时下结论不夸大」（证据侧），本内核
 * 保证「何时下结论不吃亏」（行动侧）——结论的有效性与结论的时机
 * 构成决策的完整两面；与 18.0 的关系：18.0 约束单步变异的信息量，
 * 本内核约束单步等待的机会成本——进化与行动都有了自己的最优性口径。
 */
/**
 * 先知价值 E[max X₁..Xₙ]（经验分布次序统计量精确计算）。
 *
 * m 个样本的经验分布上：P(Mₙ ≤ x₍ᵢ₎) = (i/m)ⁿ，故
 *   E[Mₙ] = Σᵢ x₍ᵢ₎·[(i/m)ⁿ − ((i−1)/m)ⁿ]
 * @param samples 经验样本（机会价值历史）
 * @param n 未来机会次数
 */
declare function prophetValue(samples: readonly number[], n: number): number;
/**
 * 向后归纳最优停止价值 V_k（经验测度精确递推）。
 *
 * V_k = 还剩 k 次机会时的期望所得；thresholds[k] = V_{k−1} 为
 * 「剩 k 次时的最优接受阈值」（当前值 ≥ thresholds[k] 即停）。
 * @returns [V₁..Vₙ]（剩 k 次的价值）与对应阈值
 */
declare function backwardInduction(samples: readonly number[], n: number): {
  values: number[];
  thresholds: number[];
};
/**
 * Samuel-Cahn 单阈值规则：τ = Mₙ 的中位数（F(τ)ⁿ = 1/2）。
 *
 * 分布无关保证：E[规则所得] ≥ ½·E[先知所得]（任意分布）。
 * @returns 阈值 τ 与规则期望所得
 */
declare function samuelCahnRule(samples: readonly number[], n: number): {
  threshold: number;
  ruleValue: number;
  prophet: number;
};
/**
 * 1/e 规则（秘书问题，n 已知）：跳过前 ⌊n/e⌋ 个候选，之后录取首个
 * 纪录（比已见全部更好者）。选中全局最优的概率 → 1/e（渐近最优）。
 * @returns 观察期内应跳过的数量
 */
declare function secretarySkipCount(n: number): number;
/**
 * Bruss 赔率算法（最后一个成功问题）：独立事件成功概率 p₁..pₙ，
 * 赔率 r = p/(1−p)。s* = 最大下标使后缀赔差和 Σ_{k≥s} rₖ ≥ 1
 * （从最后一个事件往前累加，和首次达到 1 的下标即 s*）；从 s* 起
 * 在首个成功处停。定理：期望停止次数与最优策略相差 ≤ 1（若存在 s*）。
 * p=1 的臂赔差为 Infinity：后缀和必 ≥ 1，规则自然落在最后一个 p=1
 * 位置处或其后（Infinity 仅参与加法与比较，不产生 NaN）。
 * @returns 起始下标 s*（1 起；无 s* 返回 0 = 全程不押）
 */
declare function brussOddsIndex(successProbabilities: readonly number[]): number;
/** 机会停止器配置 */
interface OptimalStoppingConfig {
  /** 开始裁决的最小经验样本（缺省 8——之前诚实返回 insufficient） */
  minSamples: number;
  /** 单上下文最大样本记忆（缺省 200，FIFO） */
  maxSamples: number;
  /** 保守系数：接受阈值 = 继续价值 × 该系数（>1 更挑剔；缺省 1） */
  thresholdMultiplier: number;
}
declare const DEFAULT_OPTIMAL_STOPPING_CONFIG: OptimalStoppingConfig;
/** 停止裁决视图 */
interface StoppingVerdict {
  /** 当前机会价值是否 ≥ 继续价值（true = 立即行动数学最优） */
  act: boolean;
  /** 继续价值阈值（剩 k 次机会的最优接受线） */
  threshold: number;
  /** 当前值 */
  value: number;
  /** 剩余机会数（评估口径） */
  remaining: number;
  /** 向后归纳最优价值 V_k（当前持有的期望所得） */
  optimalValue: number;
  /** Samuel-Cahn 规则期望所得 */
  ruleValue: number;
  /** 先知价值 E[max]（任何在线策略的上界） */
  prophet: number;
  /** 成色 = 规则所得 / 先知所得（≥ 0.5 有定理背书） */
  competitiveRatio: number;
  /** 经验样本量 */
  samples: number;
  /** 裁决口径（insufficient = 样本不足，诚实弃权） */
  basis: 'backward-induction' | 'insufficient';
  interpretation: string;
}
/**
 * 机会停止器：按上下文流式积累机会价值分布，精确裁决「现在 vs 等待」。
 *
 * 用法：
 *   const stopper = new OpportunityStopper();
 *   stopper.note('deploy-request', 0.62);  // 每次机会到达时喂值
 *   const v = stopper.assess('deploy-request', 0.58, 3);  // 现值 0.58、还会来 ~3 次
 *   if (v.act) 执行(); else 等待();       // 阈值由 V_{k−1} 精确给出
 *
 * 数学保证：act = (value ≥ V_{remaining}) 是经验测度下的精确最优
 * 策略（阈值策略）；competitiveRatio ≥ 0.5 由 Samuel-Cahn 定理背书
 * （报告侧审计用）。
 */
declare class OpportunityStopper {
  private readonly config;
  private readonly contexts;
  /** 最近裁决审计 */
  private recent;
  constructor(config?: Partial<OptimalStoppingConfig>);
  /** 记录一次机会价值观测（FIFO 容量控制） */
  note(context: string, value: number): void;
  /** 上下文样本量 */
  sampleCount(context: string): number;
  /**
   * 裁决「立即行动 vs 等待」。
   *
   * @param context 上下文（如信号类型）
   * @param value 当前机会价值（0~1 口径）
   * @param remaining 预计剩余机会数（缺省 1——等价于最后一搏）
   */
  assess(context: string, value: number, remaining?: number): StoppingVerdict;
  /** 最近裁决审计 */
  recentVerdicts(limit?: number): {
    context: string;
    at: number;
    act: boolean;
    value: number;
    threshold: number;
    competitiveRatio: number;
  }[];
}
//#endregion
//#region src/core/sheaf-consensus.d.ts
/**
 * sheaf-consensus.ts — 层论共识内核（项目 20.0「分歧的形状可见」质变基座）
 *
 * 升级前的根本局限（平均化共识的结构性盲区）：
 * - 多源信念聚合只有「平均 / 投票 / 市场价」三种武器，三者都把
 *   分歧当成标量噪声抹平：「A 说任务简单、B 说任务难」平均成
 *   「中等难度」——这是**编造的共识**：没有人真的认为它中等，
 *   平均值不在任何信息源的支持集里；
 * - 结构性分歧不可检测：循环异议（A 信 0.9、B 信 0.1、约束要求
 *   A=B）不是噪声，是**无解**——但平均给出 0.5 且皆大欢喜，
 *   系统永远不知道「共识根本不存在」这件事本身；
 * - 聚合结构不可声明：市场价（LMSR）按资产独立聚合，跨资产的
 *   一致性要求（「模型 X 在任务类的成功率信念应与任务类自身的
 *   统计一致」）没有表达语言——聚合器不知道什么应该一致。
 *
 * 本内核引入胞腔层（cellular sheaf）共识（Hansen–Ghrist 2019
 * 《Toward a spectral theory of cellular sheaves》；Hansen–Ghrist 2021
 * 《Opinion dynamics on discourse sheaves》——应用层论进入分布式
 * 共识与观点动力学的前沿框架）：
 *
 * 1. **层 = 局部一致性结构的精确语言**：图上每个顶点挂一个 stalk
 *    （该智能体/数据源的信念向量空间），每条边挂一个 edge stalk
 *    （共享声明空间）与两个限制映射 F_{v≺e}, F_{w≺e}（顶点信念
 *    投影到共享声明的线性映射）——**「谁与谁、在哪些声明上、
 *    应该一致到什么程度」第一次成为一等数学对象**。
 *
 * 2. **全局截面（global section）= 完美共识**：所有边约束同时满足
 *    的信念指派。共识不再是「平均」，而是「方程组的解」。
 *
 * 3. **层拉普拉斯算子（sheaf Laplacian）**：
 *      L_F = δ_F† δ_F，L[v][v] = Σ_{e∋v} FᵀF，L[v][w] = −Fᵀ_{v≺e}F_{w≺e}
 *    分歧能量 E(x) = xᵀL_F x = Σ_e ‖F_{v≺e}x_v − F_{w≺e}x_w‖²
 *    调和指派（ker L_F）= 全局截面；λ_max 给出分歧能量的谱上界。
 *
 * 4. **加权调和共识（观测锚定最小二乘）**：
 *      min_x Σ_e ‖F_v x_v − F_w x_w‖² + Σ_v α_v‖x_v − b_v‖²
 *    正规方程 (L_F + A)x = Ab——高斯消元精确求解。产物：
 *    - **共识指派**：每个顶点的调和信念（最接近观测且最大程度
 *      满足一致结构——不是平均，是最小化「翻供量」的代数调解）；
 *    - **离群者定位**：各锚定顶点为达成共识翻供的距离 ‖x*_v − b_v‖
 *      ——谁最抗拒共识，谁最可能是错的一方；
 *    - **结构性障碍（obstruction）检测**：调和后的分歧能量地板
 *      E* > 0 ⇒ 约束网络与观测**无联合实现**——共识在数学上不
 *      存在，系统第一次能说「别装了，你们根本不一致」。
 *
 * 与 16.0 的关系：Shapley 拆分「合作剩余如何公平分配」（博弈论侧），
 * 本内核回答「多源信念如何结构性融合」（拓扑侧）——分配与融合
 * 构成多智能体问责的两大代数支柱；与 6.0 的关系：自由能度量
 * 「预测与观测的惊异」，本内核度量「信念彼此的惊异」——世界对
 * 系统的惊喜与系统内部的自相惊喜同构；与共生经济的关系：LMSR
 * 市场价聚合单资产标量，本内核聚合**带一致性结构的向量信念**——
 * 市场与层论是聚合的两个正交维度（价格 vs 结构）。
 */
/** 顶点声明：id + 信念空间维度 */
interface SheafVertexSpec {
  id: string;
  /** 信念向量维度（标量信念 = 1） */
  dim: number;
}
/**
 * 边声明：a↔b 之间的局部一致性约束。
 *
 * 两种写法（二选一）：
 * - 显式矩阵：mapA / mapB（d_e×d 的行主序矩阵，顶点信念 → 共享声明空间）；
 * - 坐标速记：sharedA / sharedB（顶点 a/b 中参与共享的坐标下标表，
 *   长度必须相等——投影矩阵自动生成；全维度同序共享可整体省略）。
 */
interface SheafEdgeSpec {
  a: string;
  b: string;
  /** a 的限制映射（d_e × dim(a)；与 mapB 的共享维度一致） */
  mapA?: number[][];
  /** b 的限制映射（d_e × dim(b)） */
  mapB?: number[][];
  /** 速记：a 侧参与共享的坐标下标（与 mapA 互斥） */
  sharedA?: number[];
  /** 速记：b 侧参与共享的坐标下标（与 mapB 互斥） */
  sharedB?: number[];
}
/** 观测锚点：某顶点的实测信念 + 置信权重 α（大 = 硬约束） */
interface SheafAnchorSpec {
  id: string;
  values: number[];
  /** 锚定权重（缺省 1；0 = 该顶点完全由邻接结构外推） */
  weight?: number;
}
/** 层共识报告 */
interface SheafConsensusReport {
  /** 调和共识指派（每顶点的信念向量） */
  consensus: Record<string, number[]>;
  /** 分歧能量地板 E*（> 阈值 ⇒ 结构性障碍：完美共识不存在） */
  disagreementEnergy: number;
  /** 归一化分歧（E* / (E* + 锚定拟合能)；0 = 存在完美共识） */
  normalizedDisagreement: number;
  /** 结构性障碍裁决 */
  obstruction: 'none' | 'structural-conflict';
  /** 各锚定顶点为共识翻供的距离（离群者 = 最大翻供者） */
  deviations: Record<string, number>;
  /** 谁最抗拒共识（翻供距离降序） */
  outliers: string[];
  /** 层拉普拉斯谱半径 λ_max（分歧能量的谱上界口径） */
  spectralRadius: number;
  /** 参与顶点数 / 边数 / 总维度 */
  size: {
    vertices: number;
    edges: number;
    dimension: number;
  };
  interpretation: string;
}
/**
 * 胞腔层：图上的局部一致性结构 + 调和共识求解器。
 *
 * 用法：
 *   const sheaf = new CellularSheaf();
 *   sheaf.addVertex('market', 1);        // 市场价信念（标量）
 *   sheaf.addVertex('stats', 1);         // 统计估计信念（标量）
 *   sheaf.addEdge('market', 'stats');    // 标量等值约束（缺省单位映射）
 *   const report = sheaf.harmonize([
 *     { id: 'market', values: [0.82], weight: 1 },
 *     { id: 'stats', values: [0.55], weight: 2 },
 *   ]);
 *   // consensus ≈ 加权调解；structuralConflict = false（标量等值总有解）
 *
 * 结构性障碍示例：三方循环硬约束 0.9 / 0.1 / 0.5（α→大）——
 * 调和后能量地板 > 0，obstruction = 'structural-conflict'：
 * 平均会说 0.5，本内核说「无解，先解决矛盾再谈共识」。
 */
declare class CellularSheaf {
  private readonly vertexIds;
  private readonly vertexDims;
  private readonly edges;
  /** 添加顶点（幂等：重复 id 覆盖维度声明，边失效自检） */
  addVertex(id: string, dim: number): this;
  /** 添加一致性约束边（速记自动展开为投影矩阵） */
  addEdge(spec: SheafEdgeSpec): this;
  /** 顶点数 / 边数 */
  get size(): {
    vertices: number;
    edges: number;
    dimension: number;
  };
  /** 全局维度布局：顶点 → 起始行号 */
  private layout;
  /** 总维度 */
  private totalDim;
  /**
   * 层拉普拉斯 L_F（D×D 块矩阵；D = Σ 各顶点维度）。
   *
   * L[v][v] = Σ_{e∋v} Fᵀ_{v≺e}F_{v≺e}；L[v][w] = −Fᵀ_{v≺e}F_{w≺e}
   * （F 为 d_e×d 的限制映射；FᵀF 与 FᵀG 对共享维度 i 单重求和）
   */
  buildLaplacian(): number[][];
  /**
   * 加权调和共识（双解口径）：
   *
   * - 软调解解 x_soft：min_x E_disagree(x) + Σ αᵢ‖xᵢ − bᵢ‖²
   *   —— 正规方程 (L_F + A)x = Ab，一致性与观测忠诚度的最优折衷；
   * - 完美共识解 x_hard：min Σ αᵢ‖xᵢ − bᵢ‖² s.t. L_F x = 0
   *   —— 刚度惩罚 (A + M·L_F)x = Ab（M 大）实现约束最小二乘：
   *   **完美共识流形上对观测的最佳拟合**；
   * - 障碍裁决：x_hard 的加权锚定失配
   *     misfit = Σ α‖x_hard − b‖² / Σ α
   *   超过容差 ⇒ 任何完美共识都无法解释观测——**结构性障碍**
   *   （平均化会编造共识，本内核宣布无解）；否则共识 = x_hard
   *   （完美一致 + 最忠实观测），障碍时共识 = x_soft（冲突下的
   *   最小翻供调解），两态各得其所。
   *
   * @param anchors 观测锚点（至少 1 个；其余顶点由结构外推——
   *                完全无锚的连通分量无信息，解退化为 0 向量）
   * @param options.misfitTolerance 障碍判定的加权失配容差
   *        （均方差口径；缺省 0.0025 ≈ 5% 标准差）
   */
  harmonize(anchors: readonly SheafAnchorSpec[], options?: {
    misfitTolerance?: number;
  }): SheafConsensusReport;
  private interpret;
}
/**
 * 标量等值层（经典平均共识的层论化）：全部顶点标量信念、边为单位
 * 等值约束——调和共识退化为加权平均，但额外输出翻供距离与
 * （多维时）障碍检测。快路径工具与对照实验用。
 */
declare function scalarAgreementSheaf(ids: readonly string[]): CellularSheaf;
/**
 * 声明重叠层（多源向量信念融合的标准形）：每个源一个顶点，维度 =
 * 其本地声明表长度；边声明两侧共享声明的坐标映射。
 *
 * 例：模型 A 信念表 [c1,c2,c3]，模型 B 信念表 [c1,c2,c4]——
 *   overlapSheaf([dimA=3, dimB=3], edges=[{a,b,sharedA:[0,1],sharedB:[0,1]}])
 * c1/c2 上强制一致，c3/c4 各自独立保留——「在哪一致、在哪各说各话」
 * 逐声明精确声明。
 */
declare function overlapSheaf(vertices: ReadonlyArray<{
  id: string;
  dim: number;
}>, edges: ReadonlyArray<{
  a: string;
  b: string;
  sharedA: number[];
  sharedB: number[];
}>): CellularSheaf;
//#endregion
//#region src/core/robust-statistics.d.ts
/**
 * 23.0 重尾稳健统计内核 —— Catoni 估计 + Median-of-Means
 *
 * 动机: LLM 延迟与评审质量分呈重尾(偶发 100× 尾部), 算术均值与 EMA 被极端值支配,
 * 而 12.0 的经验伯恩斯坦界依赖有界支撑 [0,1]。本内核在**仅有限方差**假设下给出
 * sub-Gaussian 型置信界:
 *
 *   Median-of-Means(n ≥ k 块):  P( |μ̂ − μ| ≥ σ·√(32·ln(1/α)/n) ) ≤ α   —— 无需有界性
 *     (每块均值 sub-Gaussian 化由 Chebyshev + 中位数聚合 Chernoff 完成, k = ⌈8 ln(1/α)⌉)
 *
 *   Catoni 估计: 解单调方程  Σ_i ψ_δ(x_i − θ) = 0,  ψ_δ(y) = sign(y)·ln(1 + δ|y| + δ²y²/2)
 *     偏差界  |μ̂ − μ| ≤ 2σ²δ/n + 2ln(2/α)/(δn),  最优 δ = √(2ln(2/α)/(nσ²))
 *     → 半径 ≈ σ·√(8·ln(2/α)/n), 尾部指数衰减 —— 影响函数线性段截断使单点污染无法搬动估计
 *
 *   尺度 σ̂ 用 MAD(中位绝对偏差)×1.4826(正态一致性常数)—— 尺度本身稳健, 极端值无法
 *   先污染尺度再污染区间。
 *
 * 零漂移: 未挂载时一切统计路径与升级前逐位一致。
 */
interface RobustStatisticsConfig {
  /** 置信参数 α: 区间覆盖 ≥ 1 − α */
  alpha: number;
  /** 流式估计保留的最大样本数(环形) */
  maxSamples: number;
  /** 切换到 Catoni 的最小样本量(低于此用 MoM/普通均值) */
  catoniMinSamples: number;
  /** MoM 的最小样本量 */
  momMinSamples: number;
}
declare const DEFAULT_ROBUST_CONFIG: RobustStatisticsConfig;
/** MAD 稳健尺度估计: σ̂ = 1.4826 × median|x_i − median(x)| */
declare function madSigma(samples: number[]): number;
/**
 * Catoni 稳健均值: 对 θ 二分解单调方程 Σψ_δ(x_i−θ)=0。
 * 返回估计与半径 |μ̂−μ| ≤ σ̂·√(8·ln(2/α)/n) 的置信区间(钳到数据范围)。
 */
declare function catoniMean(samples: number[], alpha?: number): {
  mean: number;
  lower: number;
  upper: number;
  sigma: number;
  radius: number;
};
/** Median-of-Means: k = ⌈8·ln(1/α)⌉ 块连续切分, 块均值取中位数 */
declare function medianOfMeans(samples: number[], alpha?: number): {
  mean: number;
  blocks: number;
  lower: number;
  upper: number;
  sigma: number;
};
type RobustMethod = 'mean' | 'mom' | 'catoni';
interface RobustRead {
  n: number;
  mean: number;
  robustMean: number;
  lower: number;
  upper: number;
  method: RobustMethod;
  sigma: number;
}
/** 流式稳健估计: 环形保留最近 maxSamples 个观测, read() 自动选择方法 */
declare class RobustStream {
  private readonly config;
  private readonly buffer;
  constructor(config?: Partial<RobustStatisticsConfig>);
  observe(x: number): void;
  get size(): number;
  /** 缓冲副本（28.0 EVT 等下游内核的原料通道；不影响内部状态） */
  toSamples(): number[];
  read(): RobustRead;
}
//#endregion
//#region src/core/differential-privacy.d.ts
/**
 * 24.0 差分隐私内核 —— Laplace/Gaussian 机制 + Rényi-DP 记账
 *
 * 定义: 随机机制 M 满足 (ε, δ)-DP 当且仅当对一切相邻数据集 D, D′(至多一个个体不同):
 *     P[M(D) ∈ S] ≤ e^ε · P[M(D′) ∈ S] + δ,  ∀S
 * 相邻个体的存在性不可区分 —— 遥测(心智报告 / Sankey 能量流 / 模型画像)不再裸暴露
 * 单一模型或单一租户的商业敏感数据。
 *
 * 机制:
 *   Laplace(数值/直方图, 精确 (ε,0)-DP): 加噪 Lap(b), b = Δ₁/ε, Δ₁ = 敏感度
 *     (相邻数据集下查询输出的最大 L1 变化)。计数敏感度 1; n 条值的钳位均值敏感度 (hi−lo)/n。
 *   Gaussian + Rényi-DP 组合(多轮发布): 单次发布满足 RDP(α_ord) = α_ord·Δ₂²/(2σ²);
 *     组合 = 各次 RDP 求和(无论相关性); 转 (ε, δ):
 *     ε = sup_{α>1} [ RDP(α) + ln(1/δ)/(α−1) ]。
 *     本实现取固定阶 α_ord = 8 的单阶记账(合法上界, 工程上简洁): σ = Δ₂·√(α_ord/(2·ε_alloc))。
 *
 * 预算记账: PrivacyAccountant 维护总 ε 预算, 每次发布折半分账(几何分配, 永不超支),
 * 超预算返回 undefined 并标记 exhausted —— 差分隐私的保证以预算纪律为前提。
 *
 * 零漂移: 未启用时一切导出路径输出与升级前逐位一致。
 */
interface PrivacyConfig {
  /** 总 ε 预算(整个账本生命周期) */
  epsilon: number;
  /** 高斯机制的 δ(建议 ≤ 1e-6, 须远小于 1/数据集规模) */
  delta: number;
}
declare const DEFAULT_PRIVACY_CONFIG: PrivacyConfig;
/** RDP 组合采用的固定阶 */
declare const RDP_ORDER = 8;
interface PrivacyRelease {
  tag: string;
  mechanism: 'laplace' | 'gaussian-rdp';
  epsilonSpent: number;
  at: number;
}
interface PrivacyStatus {
  epsilonBudget: number;
  epsilonSpent: number;
  epsilonRemaining: number;
  delta: number;
  releases: PrivacyRelease[];
  exhausted: boolean;
}
type Rng = () => number;
/** Laplace(0, b) 噪声: 逆 CDF 采样, U(0,1) → −b·sign(u−½)·ln(1−2|u−½|) */
declare function laplaceNoise(scale: number, rng?: Rng): number;
/** 标准正态噪声(Box–Muller) */
declare function gaussianNoise(rng?: Rng): number;
/** Laplace 机制单值: (ε,0)-DP, 无记账(机制级原语) */
declare function dpValue(value: number, epsilon: number, sensitivity?: number, rng?: Rng): number;
/** 钳位均值 + Laplace: 敏感度 (hi−lo)/n */
declare function dpMeanClamped(values: number[], epsilon: number, lo: number, hi: number, rng?: Rng): number;
/** 直方图 + Laplace: 不相交桶并行组合, 敏感度 1 */
declare function dpHistogram(counts: number[], epsilon: number, rng?: Rng): number[];
/** RDP(α_ord) 转 (ε, δ): 单阶记账的解析转换 */
declare function rdpToEpsilon(rdpAtOrder: number, order: number, delta: number): number;
/**
 * 差分隐私账本: 折半分账的预算管理。
 * 每次 gaussianRdp/laplace 调用消耗剩余预算的一半 —— 几何级数保证总消耗 ≤ ε,
 * 且任何时刻可读出已耗/剩余。
 */
declare class PrivacyAccountant {
  private readonly config;
  private readonly rng;
  private spent;
  private readonly releases;
  private readonly releaseLimit;
  constructor(config?: Partial<PrivacyConfig>, rng?: Rng);
  get remaining(): number;
  get exhausted(): boolean;
  /** Laplace 发布(消耗折半预算); 超限返回 undefined */
  laplace(value: number, sensitivity: number, tag: string): number | undefined;
  /**
   * Gaussian + RDP 发布: σ 由本次分配的 ε 与固定阶推得;
   * 返回加噪后的数值数组, 超限返回 undefined。
   */
  gaussianRdp(values: number[], l2Sensitivity: number, tag: string): number[] | undefined;
  /** 状态快照(自身不含敏感数值) */
  status(): PrivacyStatus;
  private allocate;
}
/**
 * 通用视图扰动: 深度优先遍历 JSON 视图, 对数值叶子施加 Laplace(敏感度 1)。
 * 跳过 id/时间戳/版本/计数类键(这些字段本身不可逆推个体), 每次调用最多扰动 maxFields 个
 * 数值以控制预算燃烧。预算耗尽后剩余字段原样返回(不静默失败——status 可审计)。
 */
declare function perturbNumbers<T>(view: T, accountant: PrivacyAccountant, maxFields?: number): T;
//#endregion
//#region src/core/capacity-planning.d.ts
/**
 * 25.0 排队论容量规划内核 —— Erlang-C 精解 + Kingman 重尾近似 + Little 定律
 *
 * 模型: 每个模型组 = 一个 c 台服务池(c = maxConcurrency); 到达率 λ̂ 来自世界模型预测,
 * 服务时间分布 S 由 LLM 统计估计(μ̂ = 稳健平均延迟, SCV C_s² = σ̂²/μ̂², 重尾时 > 1)。
 *
 * M/M/c 精确解(Erlang-C):
 *     a = λ/μ(提供负载), ρ = a/c < 1
 *     Erlang-B 递推: B(0)=1, B(k) = a·B(k−1)/(k + a·B(k−1))
 *     等待概率 C = B(c) / (1 − ρ·(1 − B(c)))
 *     Wq = C / (cμ − λ),  Lq = λ·Wq
 *   c=1 时 C = ρ, Wq = ρ/(μ−λ) 恰为 M/M/1 精确解(自检锚点)。
 *
 * M/G/c 无闭式 → Kingman 重尾近似(负载越高越准):
 *     Wq ≈ ((C_a² + C_s²)/2) · (ρ/(1−ρ)) · E[S]/c,  泊松到达 C_a² = 1
 *   c=1 且 C_s²=1 时退化为 M/M/1 精确解(第二个自检锚点)。
 *
 * 容量反解: Wq(c) 关于 c 单调下降 → 二分求最小 c 使 Wq(c) ≤ W*(目标等待)。
 *   输出建议并发/预计等待/利用率 ρ/余量 —— 把「提前预留容量」从口号变成不等式。
 *
 * Little 定律自检: L = λ·W(实测在途数 vs 理论队长), 偏差过大说明模型失配(如非平稳到达)。
 *
 * 零漂移: 未挂载时自主循环不产生任何容量洞察。
 */
interface QueueMetrics {
  /** 服务台数 */
  servers: number;
  /** 利用率 ρ = λ/(cμ) */
  rho: number;
  /** 系统稳定(ρ < 1) */
  stable: boolean;
  /** 等待概率(Erlang-C) */
  waitProbability: number;
  /** 平均排队等待(与输入时间单位一致) */
  avgWait: number;
  /** 平均队列长 Lq = λ·Wq */
  avgQueueLength: number;
  basis: 'erlang-c' | 'kingman' | 'unstable' | 'invalid';
}
interface CapacityPlan {
  recommendedConcurrency: number;
  currentConcurrency: number;
  rho: number;
  expectedWaitMs: number;
  targetWaitMs: number;
  feasible: boolean;
  /** 余量 = 建议/当前, > 1.2 触发扩容洞察 */
  headroom: number;
  basis: string;
  metricsAtRecommended: QueueMetrics;
}
interface CapacityPlannerConfig {
  /** 目标平均等待(毫秒) */
  targetWaitMs: number;
  /** 搜索并发上限 */
  maxConcurrency: number;
  /** 服务 SCV 未知时的缺省(指数服务 = 1; LLM 重尾建议 2~4) */
  defaultScv: number;
}
declare const DEFAULT_CAPACITY_CONFIG: CapacityPlannerConfig;
/** M/M/c Erlang-C 精确指标。λ 每单位时间到达数, μ 单台每单位时间服务率, c 台 */
declare function erlangC(lambda: number, mu: number, servers: number): QueueMetrics;
/** M/G/c Kingman 重尾近似; scv = 服务时间平方变异系数 C_s² */
declare function kingmanWq(lambda: number, mu: number, servers: number, scv: number): number;
/** Little 定律自检: 返回实测与理论在途数之比(< 0.5 或 > 2 提示模型失配) */
declare function littleCheck(lambda: number, avgSojournMs: number, observedInFlight: number): {
  theoretical: number;
  observed: number;
  ratio: number;
};
/** 容量规划器: 由预测到达率与服务统计反解最小并发 */
declare class CapacityPlanner {
  private readonly config;
  constructor(config?: Partial<CapacityPlannerConfig>);
  getConfig(): Readonly<Required<CapacityPlannerConfig>>;
  /**
   * @param input.predictedArrivalPerSec 预测到达率(次/秒, 世界模型 predictArrivals ÷ horizon 秒)
   * @param input.serviceMeanMs 稳健平均服务时长(毫秒, 建议 23.0 robustMean)
   * @param input.serviceScv 服务 SCV(σ̂²/μ̂², 缺省 defaultScv)
   * @param input.currentConcurrency 当前该池并发上限
   */
  plan(input: {
    predictedArrivalPerSec: number;
    serviceMeanMs: number;
    serviceScv?: number;
    currentConcurrency: number;
  }): CapacityPlan;
  private build;
}
//#endregion
//#region src/core/extreme-value.d.ts
/**
 * 28.0 极值理论内核 —— POT/GPD 尾部建模 + Hill 估计 + 风险度量
 *
 * 动机: 平均值撒谎，尾部杀人。p99.9 延迟、预算爆仓、失败风暴都住在分布
 * 的尾部——而经验分位数在尾部**没有数据可看**（1000 个样本里 p99.9 就是
 * 最大值，纯运气）。极值理论（EVT）不外推整个分布，只外推尾部，且尾部
 * 有定理保证：
 *
 *   Pickands–Balkema–de Haan: 超过阈值 u 的超出量 Y = X − u（足够大的 u）
 *     收敛于广义帕累托 GPD_ξ,σ:
 *     H(y) = 1 − (1 + ξy/σ)^{−1/ξ}  (ξ≠0),  1 − e^{−y/σ}  (ξ=0)
 *   ξ > 0 重尾（无限方差当 ξ > 1/2）, ξ = 0 指数尾, ξ < 0 有界尾
 *
 *   POT 分位数（尾部外推，经验分位数的定理化替代）:
 *     VaR_p = u + (σ̂/ξ̂)·[ (N_u/n · 1/(1−p))^{ξ̂} − 1 ]
 *   期望损失 ES_p = (VaR_p + σ̂ − ξ̂·u)/(1 − ξ̂)  (ξ̂ < 1)
 *
 *   Hill 估计（重尾指数的半参数估计）:
 *     α̂_k = k / Σ_{i≤k} ln(x_(i)/x_(k+1))  （降序前 k 个）
 *     jackknife 标准误——「尾部有多重」本身带不确定度
 *
 *   GPD MLE: Grimshaw (1993) 剖面似然——把 (ξ,σ) 二维优化化为 θ = ξ/σ
 *   的一维搜索（σ(θ) = k̄/θ, k̄ = mean ln(1+θy)），θ ∈ (−1/y_max, 2/y_max)
 *   网格 + 黄金分割细化；θ→0 边界退化为指数 MLE（σ̂ = ȳ）。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致。
 */
/** 确定性 PRNG（mulberry32；验证脚本与内核共用同一实现保证可复现） */
declare function mulberry32(seed: number): () => number;
/** 经验分位数（最近邻插值；xs 无序） */
declare function empiricalQuantile(xs: number[], q: number): number;
interface HillEstimate {
  /** 尾指数 α̂（1/ξ̂ 口径；α 越小尾越重） */
  alpha: number;
  /** ξ̂ = 1/α̂ */
  xi: number;
  /** jackknife 标准误 */
  se: number;
  /** 使用的尾部序统计量个数 */
  k: number;
}
/**
 * Hill 尾指数估计（降序取前 k 个对 x_(k+1) 的对数比）。
 * 适用 ξ > 0（重尾）；数据不足或含非正值时 undefined。
 */
declare function hillEstimator(samples: number[], k?: number): HillEstimate | undefined;
interface GpdFit {
  /** 形状参数 ξ̂ */
  xi: number;
  /** 尺度参数 σ̂ */
  sigma: number;
  /** 剖面对数似然 */
  logLikelihood: number;
  /** θ = ξ/σ 的收敛点 */
  theta: number;
  /** 拟合用超出量个数 */
  n: number;
}
/**
 * GPD 极大似然（Grimshaw 剖面法）。ys 为严格正的超出量（x − u）。
 * 数据不足 / 退化时 undefined。
 */
declare function fitGpd(ys: number[]): GpdFit | undefined;
/** GPD 分布函数 */
declare function gpdCdf(y: number, xi: number, sigma: number): number;
interface TailQuantiles {
  /** POT 外推分位数（p ∈ (0,1)，如 0.999） */
  varP: number;
  /** 期望损失（尾部均值；ξ̂ ≥ 1 时 undefined——均值不存在） */
  esP?: number;
}
/**
 * POT 分位数与期望损失。
 * @param fit GPD 拟合（超出量口径）
 * @param totalSamples 原始样本总数 n
 * @param exceedances 超出量个数 N_u
 * @param u 阈值
 */
declare function potQuantiles(fit: GpdFit, totalSamples: number, exceedances: number, u: number, p: number): TailQuantiles | undefined;
/** 均值超出诊断：E[X − u | X > u] 关于 u 的曲线（GPD 下应为线性，斜率 ξ/(1−ξ)） */
declare function meanExcessCurve(samples: number[], quantiles: number[]): Array<{
  u: number;
  meanExcess: number;
  count: number;
}>;
interface TailRiskConfig {
  /** 超阈值经验分位（缺省 0.9：最重 10% 样本入 GPD） */
  thresholdQuantile: number;
  /** 拟合所需最小超出量（缺省 20） */
  minExceedances: number;
  /** 环形缓冲容量（缺省 2048） */
  maxSamples: number;
  /** bootstrap 置信区间重采样次数（0 = 不算 CI；缺省 200） */
  bootstrap: number;
  /** bootstrap 种子（缺省 20260920） */
  seed: number;
}
declare const DEFAULT_TAIL_RISK_CONFIG: TailRiskConfig;
interface TailRiskReport {
  /** 样本量 */
  samples: number;
  /** 阈值 u（经验分位） */
  threshold: number;
  /** 超出量个数 */
  exceedances: number;
  /** GPD 拟合 */
  gpd: GpdFit;
  /** p99 外推 */
  p99: number;
  /** p99.9 外推（经验分位数看不到的地方） */
  p999: number;
  /** p99 期望损失 */
  es99?: number;
  /** Hill 尾指数（重尾口径） */
  hill?: HillEstimate;
  /** p99.9 的 bootstrap 90% 置信区间 */
  p999Ci?: {
    lower: number;
    upper: number;
  };
}
/**
 * 尾部风险监视器：延迟/成本样本的环形流 → POT/GPD 拟合 → p99/p99.9/ES。
 *
 * 与经验分位数的本质区别：p99.9 不是「样本最大值」（运气）而是定理背书
 * 的尾部外推，且带 bootstrap 置信区间。样本不足或拟合失败时 fit()
 * 返回 undefined（诚实拒绝，不输出编造的尾部）。
 */
declare class TailRiskMonitor {
  private config;
  private buffer;
  constructor(config?: Partial<TailRiskConfig>);
  observe(x: number): void;
  get size(): number;
  /** 拟合（幂等；失败/数据不足 → undefined） */
  fit(): TailRiskReport | undefined;
  /** 原始样本副本（消费方自取；26.0 GP / 23.0 稳健统计可复用同一流） */
  toSamples(): number[];
}
//#endregion
//#region src/core/submodular.d.ts
/**
 * 30.0 次模优化内核 —— 加权覆盖 + 惰性贪心 (CELF) + 曲率修正保证
 *
 * 动机: 「探索预算分给谁」是组合选择：好奇心引擎按新颖度 top-k 挑盲区，
 * 但 top-k 是**模函数**口径——相关知识（共享主题的盲区）被重复购买,
 * 预算在冗余上浪费。覆盖价值天然**次模**（边际收益递减）：
 *
 *   f(A ∪ {x}) − f(A) ≥ f(B ∪ {x}) − f(B),  ∀A ⊆ B, x ∉ B
 *   （同一主题第二次被覆盖的边际严格更小）
 *
 *   加权覆盖函数（本内核的具体化）:
 *     f(S) = Σ_theme W_t · (1 − Π_{i∈S∩t}(1 − c_{i,t}))
 *     W_t = 主题权重（新颖度质量），c_{i,t} = 项 i 覆盖主题 t 的强度
 *
 *   Nemhauser–Wolsey–Fisher (1978): 单调次模 + 基数约束 k，
 *     贪心 ≥ (1 − 1/e)·OPT ≈ 0.632·OPT——多项式时间可证的近似比；
 *     惰性贪心（CELF, Leskovec 2007）与朴素贪心**逐位同解**，评估次数
 *     数量级下降（上一轮选中的项使其余边际只降不升——次模性的红利）。
 *
 *   曲率修正 (Conforti–Cornuéjols): 曲率 c = 1 − min_i min_X 边际(X,i)/f({i}),
 *     贪心保证收紧为 ≥ (1 − e^{−c})/c·OPT ∈ [0.632, 1]·OPT——
 *     c 从数据里算出来，不是拍脑袋。
 *
 *   预算约束（每项有成本）: 边际贪心 / 边际密度贪心取优——
 *     ≥ ½(1 − 1/e)·OPT（Khuller–Moss–Naor）。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致。
 */
/** 次模目标函数（下标即地面集合） */
interface SubmodularFunction {
  groundSize: number;
  /** f(S)（空集 = 0） */
  value(selected: ReadonlySet<number>): number;
  /** 边际增益 f(S ∪ {item}) − f(S)（item ∉ S 时） */
  marginal(item: number, selected: ReadonlySet<number>): number;
}
/**
 * 加权覆盖函数：f(S) = Σ_t W_t·(1 − Π_{i∈S∩t}(1 − c_{i,t}))。
 *
 * 每个主题是概率覆盖集——单调、次模（且归一化时 f(全集) = ΣW_t）。
 */
declare class WeightedCoverage implements SubmodularFunction {
  readonly groundSize: number;
  private readonly themes;
  /** item → theme 下标列表（边际查询加速） */
  private readonly itemThemes;
  constructor(groundSize: number);
  /** 登记一个覆盖主题：weight 权重，items 覆盖项 → 强度 c ∈ (0,1] */
  addTheme(weight: number, covers: ReadonlyMap<number, number>): void;
  value(selected: ReadonlySet<number>): number;
  marginal(item: number, selected: ReadonlySet<number>): number;
  get themeCount(): number;
}
/**
 * 从 token 集合构造覆盖函数（30.0 接线辅助）。
 *
 * 主题 = 每个知识项自身的质量 w_i（被覆盖 = 该盲区的知识被获得）；
 * 项 j 对主题 i 的覆盖强度：自身 1；共享 token 的近邻 coverageStrength。
 *
 *   f({i}) = w_i；f({i, j≈i}) = w_i + w_j·(1−c)  —— 冗余第二选的
 *   边际从 w_j 衰减到 (1−c)·w_j（它 70% 的知识已经被第一个选中者
 *   「顺带学会」）；互补项边际完整保留 w_k。这是加权覆盖在
 * 「知识覆盖」语义下的正确形态（token 做主题会让独占 token 的项
 * 价值归零——语义错误）。
 */
declare function coverageFromTokens(items: Array<{
  tokens: ReadonlyArray<string>;
  weight: number;
}>, coverageStrength?: number): WeightedCoverage;
interface GreedyResult {
  selected: number[];
  /** 贪心终止价值（逐选择点记录，任何时刻可读） */
  values: number[];
  /** 边际增益序列 */
  gains: number[];
  /** marginal 调用次数（CELF 加速比的证据） */
  evaluations: number;
}
/**
 * 惰性贪心（CELF）：单调次模 + 基数约束 k → ≥ (1−1/e)·OPT。
 * 与朴素贪心逐位同解（次模性保证队列顶端的陈旧边际只降不升）。
 */
declare function lazyGreedy(f: SubmodularFunction, k: number): GreedyResult;
/**
 * 预算约束贪心（每项成本不同）：边际贪心与边际密度贪心各跑一遍取优，
 * 保证 ≥ ½(1−1/e)·OPT（Khuller–Moss–Naor 之「取优」加强）。
 */
declare function budgetedGreedy(f: SubmodularFunction, costs: ReadonlyArray<number>, budget: number): GreedyResult & {
  variant: 'marginal' | 'density';
};
/** 穷举最优（验证锚点；C(n,k) 组合枚举，n ≤ ~14 适用） */
declare function bruteForceBest(f: SubmodularFunction, k: number): {
  selected: number[];
  value: number;
};
interface SubmodularityAudit {
  trials: number;
  /** 违反递减收益不等式的次数（应恒为 0） */
  violations: number;
  maxViolation: number;
}
/** 随机次模性审计：A ⊆ B、x ∉ B，检验 f(A∪x)−f(A) ≥ f(B∪x)−f(B) */
declare function submodularityCheck(f: SubmodularFunction, trials?: number, seed?: number): SubmodularityAudit;
interface CurvatureReport {
  /** 曲率估计 c ∈ [0,1]（越接近 0 越接近模函数 = 贪心越接近精确） */
  curvature: number;
  /** 修正保证因子 (1 − e^{−c})/c ∈ [1−1/e, 1] */
  guaranteeFactor: number;
  samples: number;
}
/**
 * 曲率估计（Conforti–Cornuéjols）：c = 1 − min 边际(X,i)/f({i})，
 * X 取随机子集采样（精确最小是指数级，采样给出 c 的上界估计——
 * 保守口径：真实曲率 ≤ 估计值，保证因子按估计值陈述仍然成立的方向）。
 */
declare function curvatureEstimate(f: SubmodularFunction, samples?: number, seed?: number): CurvatureReport;
//#endregion
//#region src/core/optimal-assignment.d.ts
/**
 * 32.0 全局指派内核 —— 匈牙利算法（Kuhn–Munkres）：批内全局最优匹配 + 对偶证书
 *
 * 动机: 计划执行按「就绪层」分批并行，批内每个节点各自调用调度器选型——
 * **逐节点贪心**。三个同层节点都看到「模型 A 最优」，就都拿 A：最优模型
 * 被超订（并发挤兑）、次优模型闲置，批的总质量/成本是局部视角的拼贴。
 * 线性和指派问题（LSAP）问的是全局:
 *
 *   max Σ_i P_{i,σ(i)}   （批内节点 i 指派给模型 σ(i)，互不冲突）
 *
 *   匈牙利算法在 O(n³) 内**精确**求解（Kuhn 1955 / Munkres 1957；
 *   Jonker–Volgenant 最短增广路 + 位势实现）。贪心没有任何近似比——
 *   反例可以任意坏（所有节点挤同一个模型）；精确解自带最优性。
 *
 *   证明携带（与 15.0 同一哲学）: 算法维护 LP 对偶位势 (u, v) 满足
 *     u_i + v_j ≤ c_ij（对偶可行性）且匹配边上 u_i + v_j = c_ij（互补松弛）
 *   → 弱对偶: 任意可行指派成本 ≥ Σu + Σv = 本算法成本 —— **对偶证书**。
 *   验证脚本逐位断言对偶可行性，最优性不靠信任，靠检查。
 *
 *   语义: 批量分配是「一次装袋」而不是「逐个抢座位」——同一批任务在
 *   模型组合上的总收益先全局最优，再谈个体；模型并发容量、批质量、
 *   调度评分全部进入收益矩阵，一视同仁。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致（逐节点贪心原样）。
 */
interface AssignmentResult {
  /** row → col（-1 = 未指派，行数超过列数时剩余行留给原路径） */
  assignment: number[];
  /** 指派边的代价总和（min 口径） */
  totalCost: number;
  rows: number;
  cols: number;
  /** 对偶位势（互补松弛证书的原料；undefined = 未求解对偶） */
  dual?: {
    u: number[];
    v: number[];
  };
}
interface AssignmentCertificate {
  /** 对偶可行性：∀i,j u_i + v_j ≤ c_ij + tol */
  dualFeasible: boolean;
  /** 互补松弛：匹配边 u_i + v_j = c_ij（±tol） */
  complementarySlackness: boolean;
  /** 弱对偶间隙（应为 0：Σu + Σv = 指派成本） */
  dualityGap: number;
  /** 证书成立 = 指派最优性被证明 */
  optimal: boolean;
  maxConstraintViolation: number;
}
/**
 * 线性和指派（最小化）——Jonker–Volgenant 风格 O(n³)。
 *
 * cost 为 rows × cols 矩阵（rows ≤ cols 直接解；rows > cols 自动转置后
 * 原地还原）。空矩阵 / 零行零列安全返回。
 */
declare function solveAssignment(cost: ReadonlyArray<ReadonlyArray<number>>): AssignmentResult;
/** 最大化指派（收益矩阵 → 取负 → 最小化）。
 *
 * 返回的 dual 为**最大化口径**证书：u_i + v_j ≥ p_ij 对一切 (i,j) 成立、
 * 匹配边上取等（弱对偶：任意指派的收益 ≤ Σu + Σv = 本解收益）。
 * 最小化口径的 assignmentCertificate 请与 solveAssignment 配套使用。
 */
declare function solveAssignmentMax(profit: ReadonlyArray<ReadonlyArray<number>>): AssignmentResult & {
  totalProfit: number;
};
/**
 * 对偶证书检查（证明携带）:
 *   可行 ∀i,j: u_i + v_j ≤ c_ij + tol；松弛：匹配边等号；间隙 = |Σu+Σv−成本|。
 * 三项全过 → optimal = true：本次指派的最优性被数学证明，而非被声称。
 */
declare function assignmentCertificate(cost: ReadonlyArray<ReadonlyArray<number>>, result: AssignmentResult, tol?: number): AssignmentCertificate;
/** 穷举最优（验证锚点；n ≤ 8 适用，排列枚举） */
declare function bruteForceAssignment(cost: ReadonlyArray<ReadonlyArray<number>>): {
  assignment: number[];
  totalCost: number;
};
/**
 * 批内收益矩阵 → 全局指派（32.0 接线辅助）。
 *
 * profit[i][j] = 节点 i 给模型 j 的调度评分；返回 节点 → 模型 指派
 * （未覆盖节点返回 -1，交还逐节点原路径——行数超过列数时的诚实降级）。
 */
declare function assignBatch(profit: ReadonlyArray<ReadonlyArray<number>>): {
  modelOfNode: number[];
  totalProfit: number;
};
//#endregion
//#region src/core/random-matrix.d.ts
/**
 * 33.0 随机矩阵内核 —— Marchenko–Pastur 噪声边界 + 特征值清洗 + 系统性风险
 *
 * 动机: 多模型系统的「相关性」是排险与分流的依据——两个模型同挂才需要
 * 热备，彼此独立的模型才构成真正的冗余。但**样本相关矩阵的大多数特征
 * 结构是纯噪声**：p 个模型 × n 个观测的 iid 噪声，其相关谱不是集中于 1，
 * 而是铺满一整条带——
 *
 *   Marchenko–Pastur (1967): p×n iid（方差 σ²/n 口径）样本协方差的谱
 *   渐近支撑于 [σ²(1−√γ)², σ²(1+√γ)²]，γ = p/n。
 *   → **λ > λ+ 的特征值在纯噪声下几乎不可能出现**（大偏差指数衰减）：
 *   噪声带以上 = 信号（真实的相关结构），以下 = 不可区分于噪声。
 *
 *   RMT 清洗（Laloux et al. 1999 / Plerou et al. 2002, 「noise dressing」）:
 *   谱分解 → λ < λ+ 的特征值替换为其均值（保迹）→ 重组 → 对角归一。
 *   被清洗的矩阵把「伪相关」抹掉、把真结构保留——相关性从统计幻觉
 *   升级为可证伪的结构断言。
 *
 *   系统性风险判据（本内核的调度语义）: 模型失败序列的相关矩阵经清洗后，
 *   若头号特征值仍显著超出 MP 边界（解释份额 λ₁/Σλ 超阈值），说明存在
 *   **共同因子**（同厂商 / 同上游 / 同配额池）——一个因子倒下会同时击穿
 *   一串「看起来分散」的模型。伪相关则会被清洗到边界内——不误报。
 *
 *   特征分解: 循环 Jacobi 旋转（对称矩阵，二次收敛，纯 TS 零依赖），
 *   A = QΛQᵀ 正交到机器精度——谱的每个数字都是可复算的。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致。
 */
/** 对称矩阵特征分解结果（特征值降序；列 vectors[k] 为对应单位特征向量） */
interface EigenResult {
  values: number[];
  vectors: number[][];
}
/**
 * 循环 Jacobi 对称特征分解。
 *
 * 每轮扫描所有非对角 (p,q)，用 Givens 旋转把 A[p][q] 消零；非对角能量
 * 单调下降且二次收敛（经典结果，~6-10 轮到机器精度）。
 */
declare function jacobiEigensym(input: ReadonlyArray<ReadonlyArray<number>>, maxSweeps?: number, tol?: number): EigenResult;
/** Marchenko–Pastur 谱边界：γ = p/n ∈ (0,1] 口径（γ > 1 时取 1/γ 的对偶带；σ² 缺省 1） */
declare function mpEdges(gamma: number, sigma2?: number): {
  lambdaMinus: number;
  lambdaPlus: number;
};
/** 相关系数矩阵（Pearson；零方差序列 → 与一切不相关，行/列置 0、对角 1） */
declare function correlationFromSeries(series: ReadonlyArray<ReadonlyArray<number>>): number[][];
/** 谱清洗报告 */
interface CleansingReport {
  /** 降序特征值（清洗前的样本谱） */
  eigenvalues: number[];
  /** MP 噪声上边界 λ+（γ = p/n） */
  noiseEdge: number;
  /** 落入噪声带的特征值个数（含 γ>1 口径下的零谱） */
  noiseCount: number;
  /** 头号特征值的解释份额 λ₁ / Σλ（相关矩阵 Σλ = p） */
  topShare: number;
  /** λ₁ 是否超出 edgeFactor × λ+（信号判定） */
  signal: boolean;
  /** 清洗后的相关矩阵（对角 ≈ 1） */
  cleaned: number[][];
}
/**
 * RMT 特征值清洗（Laloux–Cizeau–Bouchaud / Plerou et al.）。
 *
 * 步骤: 谱分解 → λ < λ+ 的特征值替换为其均值（保迹）→ 重组 → 对角
 * 归一化到 1。输入应已是（准）相关矩阵；ratio = p/n（模型数 / 观测数）。
 */
declare function cleanseCorrelation(matrix: ReadonlyArray<ReadonlyArray<number>>, ratio: number, edgeFactor?: number): CleansingReport;
/** 系统性风险评估快照 */
interface SystemicRiskAssessment {
  /** 参与评估的模型数（≥ minModels 才有意义） */
  models: number;
  /** 头号特征值（清洗前样本谱） */
  topEigenvalue: number;
  /** MP 噪声上界 */
  noiseEdge: number;
  /** 头号特征值解释份额 */
  topShare: number;
  /** 与头号特征向量对齐最深的模型（共同因子暴露最深者，按 |载荷| 降序） */
  topLoading: Array<{
    index: number;
    loading: number;
  }>;
  /** 是否判定系统性相关（信号在噪声带之上） */
  systemic: boolean;
  /** 窗口内观测数 */
  observations: number;
}
interface SystemicRiskConfig {
  /** 滚动窗口长度（观测数；缺省 32） */
  window?: number;
  /** 参与评估的最少模型数（缺省 4） */
  minModels?: number;
  /** 信号判定倍数：λ₁ > factor × λ+（缺省 1.1） */
  edgeFactor?: number;
  /** 系统性洞察的解释份额门槛（缺省 0.35） */
  systemicShare?: number;
}
/**
 * 系统性风险监视器（33.0 接线桥）。
 *
 * 每个观测周期 observe() 一份「各模型本期失败计数」快照；窗口攒满后
 * 每次 assess() 对失败序列做相关矩阵 → RMT 清洗 → 共同因子判定。
 * 纯噪声的伪相关被 MP 边界吸收（不误报）；真因子结构触发 systemic，
 * 头号特征向量给出「谁在同一艘船上」的排序。
 */
declare class SystemicRiskMonitor {
  private readonly window;
  private readonly minModels;
  private readonly edgeFactor;
  private readonly systemicShare;
  private readonly ids;
  private series;
  private filled;
  constructor(config?: SystemicRiskConfig);
  /** 一期观测：counts 里只登记有活动（Δcalls > 0）的模型，缺席记 null */
  observe(counts: Record<string, number | null>): void;
  /** 当前窗口是否已攒满（未满时 assess 返回 undefined——先验无知） */
  get ready(): boolean;
  /** 观测数（窗口内） */
  get observations(): number;
  /**
   * 评估系统性风险（窗口未满 / 活跃模型不足 → undefined）。
   *
   * 缺席（NaN）以该模型窗口均值插补（等价于「本期无信息」的中性口径），
   * 保证相关矩阵总是良定义。
   */
  assess(): SystemicRiskAssessment | undefined;
  /** 模型 id（下标口径） */
  get modelIds(): string[];
}
//#endregion
//#region src/core/information-bottleneck.d.ts
/**
 * 37.0 信息瓶颈内核 —— Blahut-Arimoto：理解即压缩的算法化
 *
 * 动机: 知识蒸馏的门槛是水位魔数（样本计数 ≥ N 才蒸馏）。但「值得
 * 蒸馏」的本质是信息论问题——Tishby 信息瓶颈（1999）把「压缩 X 的
 * 表征 T 同时保留与目标 Y 相关的信息」写成变分问题：
 *
 *   min_{q(t|x)}  I(X;T) − β·I(T;Y)
 *
 *   I(T;Y) ≤ I(X;Y)（数据处理不等式——任何压缩都不可能增加信息）；
 *   β → 0: T 塌缩为常数（什么都不值得记）；β → ∞: T = X（全保留）。
 *   最优解由自洽方程刻画（Blahut-Arimoto 迭代收敛）：
 *
 *     q(y|t) ∝ Σ_x p(x) q(t|x) p(y|x)
 *     q(t|x) ∝ q(t)·exp(−β·D_KL[p(y|x) ‖ q(y|t)])
 *
 *   蒸馏语义: X = 候选记忆的特征位型，Y = 任务成败结果。IB 最优压缩
 *   保留的是「对预测成败有信息量的结构」——**保留率 retention =
 *   I(T;Y)/I(X;Y) 是「这批样本携带多少值得蒸馏的信息」的定价**：
 *   retention 低于阈值 → 样本与既有知识同构，水位再高也不该重复蒸馏；
 *   retention 高 → 少量样本也值得立即固化。
 *
 *   MDL（11.0 理论家）说「理解即压缩」；IB 给出**压缩-相关**帕累托
 *   前沿上的可计算最优点——蒸馏从经验水位升维为信息论定价。
 *
 * 零漂移: 未挂载时蒸馏门槛与升级前逐位一致。
 */
/** 经验联合分布（X 离散特征 × Y 离散结果） */
interface JointDistribution {
  /** p(x,y)（行 x 列 y；自动归一化） */
  pxy: number[][];
  /** 行标签（特征位型，聚类输出用；可选） */
  xLabels?: string[];
  /** 列标签（结果档位，如 ['fail', 'pass']；可选） */
  yLabels?: string[];
}
interface BottleneckReport {
  /** 压缩道数 |T|（实际存活的道） */
  clusters: number;
  /** I(X;Y)（nat）——源数据关于结果的信息上限 */
  iXY: number;
  /** I(T;Y)（nat）——压缩表征保留的信息 */
  iTY: number;
  /** 保留率 I(T;Y)/I(X;Y) ∈ [0,1]（数据处理不等式保证 ≤ 1） */
  retention: number;
  /** I(X;T)（nat）——压缩的复杂度代价 */
  iXT: number;
  /** 拉格朗日量 L = I(X;T) − β·I(T;Y)（迭代单调不增——验证锚点） */
  lagrangian: number;
  /** 每个特征位型 → 压缩道（argmax_t q(t|x)） */
  assignment: number[];
  /** 每道的后验 q(y|t) */
  clusterPosteriors: number[][];
  iterations: number;
  converged: boolean;
}
interface BottleneckOptions {
  /** 压缩-相关权衡 β（缺省 5；小 = 激进压缩，大 = 忠实保留） */
  beta?: number;
  /** 压缩道数上限 |T|（缺省 = min(|X|, 6)） */
  clusterCap?: number;
  maxIterations?: number;
  tol?: number;
  seed?: number;
}
/**
 * 信息瓶颈（Blahut–Arimoto / Tishby 1999）。
 *
 * 迭代自洽方程至收敛；拉格朗日量单调不增（验证锚点）。|X|=1 或
 * I(X;Y)=0 时诚实返回 retention=0（无信息可保留——不值得蒸馏）。
 */
declare function informationBottleneck(joint: ReadonlyArray<ReadonlyArray<number>>, options?: BottleneckOptions): BottleneckReport;
/**
 * 蒸馏信息定价（37.0 接线口径）。
 *
 * 样本形如 { features: 位型标签数组（如 ['code', 'slow']）, success }。
 * 特征位型做 X、成败做 Y 聚合经验分布 → IB 压缩 → retention 为
 * 「这批样本携带的值得蒸馏的信息比例」。
 */
declare function distillRetention(samples: ReadonlyArray<{
  features: ReadonlyArray<string>;
  success: boolean;
}>, options?: BottleneckOptions): BottleneckReport & {
  sampleCount: number;
};
//#endregion
//#region src/core/spectral-ranking.d.ts
/**
 * 39.0 谱排序内核 —— PageRank 幂迭代：知识图的影响力从结构里涌现
 *
 * 动机: 记忆图的联想检索（related()）按边权排序——**局部口径**：一条
 * 记忆与谁共现强就先想起谁。但「哪条知识重要」是全局结构性质：枢纽
 * 记忆（与很多重要记忆共现）才是检索的骨架。PageRank（Brin–Page 1998）
 * 把「重要性 = 被重要者指向」写成不动点：
 *
 *   r = d·M·r + (1−d)·v
 *
 *   M 为行随机转移（无向图取对称归一），d 阻尼（缺省 0.85），
 *   v 均匀个人化向量。|λ₂(M)| ≤ 1 且谱隙 ≥ 1−d ⟹ 幂迭代线性收敛
 *   （速率 ~ dⁿ，20 余次迭代到 1e-9）；悬挂质量守恒重分配，
 *   Σr ≡ 1（质量守恒断言——谱的正确性可逐位检查）。
 *
 *   检索语义: related() 从「边权序」升维为「边权 × 邻居影响力」——
 *   与枢纽共现的记忆先被想起；枢纽本身沉淀为知识图的骨架清单
 *   （topInfluential）——蒸馏与遗忘的「保骨去肉」有了结构依据。
 *
 *   验证锚点: 环图 → 均匀分布（精确，任何阻尼）；星图 → 中心最高；
 *   双子图 → 与度结构一致；质量总和恒 1。
 *
 * 零漂移: 未挂载时 related() 与升级前逐位一致。
 */
interface PageRankOptions {
  /** 阻尼系数（缺省 0.85） */
  damping?: number;
  /** 收敛容差（L1；缺省 1e-10） */
  tol?: number;
  maxIterations?: number;
}
interface PageRankResult {
  /** 节点 id（输入顺序） */
  ids: string[];
  /** 排序值（Σ = 1） */
  scores: number[];
  iterations: number;
  converged: boolean;
}
/**
 * 加权 PageRank（无向图：对称权重矩阵按行归一）。
 *
 * ids 与 weights（|ids|×|ids|，非负）由调用方给出；悬挂节点（全零行）
 * 的质量均匀重分配（守恒）。空图安全返回。
 */
declare function pageRank(ids: ReadonlyArray<string>, weights: ReadonlyArray<ReadonlyArray<number>>, options?: PageRankOptions): PageRankResult;
/** 按 PageRank 降序的前 k 节点（39.0 接线口径：知识骨架清单） */
declare function topInfluential(result: PageRankResult, k: number): Array<{
  id: string;
  score: number;
}>;
//#endregion
//#region src/core/first-passage.d.ts
/**
 * 40.0 首达时间内核 —— 反射原理 + 逆高斯 + 赌徒破产：等待恢复有了概率价格
 *
 * 动机: 熔断器打开后的冷却时间是配置魔数（cooldownMs 定值）。但「多久
 * 才敢再试」是随机过程的首达问题——失败率的恢复是带漂移的随机游走，
 * 过早重试 = 高概率再次击穿（熔断风暴），过晚 = 无谓的可用性损失。
 *
 *   反射原理（Brownian 对称性）: P(sup_{s≤t} W_s ≥ a) = 2·P(W_t ≥ a)
 *     —— 最大值分布从端点分布一步读出；无漂移随机游走重越阈值 a 的
 *     概率 = 2(1 − Φ(a/(σ√t)))，闭式。
 *
 *   带漂移首达（逆高斯）: dX = μ ds + σ dW 从 0 出发首达 a > 0 的
 *     时间 T ~ IG(均值 a/μ, 形状 a²/σ²)——密度闭式、期望闭式；
 *     μ ≤ 0 时首达概率 < 1（可能永不到达——诚实区分「会恢复」与
 *     「结构性恶化」）。
 *
 *   离散口径（赌徒破产）: 每步 ±1 概率 p/q，从 i 出发触 N 先于 0 的
 *     概率（p≠q 闭式 (1−(q/p)^i)/(1−(q/p)^N)；p=1/2 时 i/N——公平
 *     游走的经典）。
 *
 *   冷却定价: 从观察到的失败间隔估计 (μ̂, σ̂)，解首达概率
 *     P(T_recover ≤ cooldown) ≥ target 的最小 cooldown——熔断冷却从
 *     魔数升维为「以 target 概率确信已恢复」的定价。
 *
 * 零漂移: 未挂载时熔断与治理行为与升级前逐位一致。
 */
/**
 * 反射原理: 无漂移 Brownian（方差率 σ²）在 (0, t] 内上穿阈值 a > 0 的概率。
 *
 * P(sup W_s ≥ a) = 2(1 − Φ(a/(σ√t)))——与端点分布的解析恒等式
 * （验证脚本用离散模拟对照）。
 */
declare function reflectionMaxProb(threshold: number, horizon: number, sigma?: number): number;
/** 逆高斯密度: dX = μ ds + σ dW 首达 a > 0 的时间分布（μ > 0） */
declare function inverseGaussianPdf(t: number, mean: number, shape: number): number;
/** 逆高斯 CDF（闭式，Chhikara–Folks）：F(t) = Φ(√(λ/t)(t−μ)/μ) + e^{2λ/μ}Φ(−√(λ/t)(t+μ)/μ) */
declare function inverseGaussianCdf(t: number, mean: number, shape: number): number;
/** 赌徒破产: 从 i 出发、触 N 先于 0 的概率（步进 ±1，上行概率 p） */
declare function gamblerRuin(i: number, n: number, p: number): number;
interface FirstPassageEstimate {
  /** 漂移估计 μ̂（每单位时间步长；≤ 0 = 结构性恶化，恢复不保证） */
  mu: number;
  /** 波动估计 σ̂ */
  sigma: number;
  /** 首达概率 P(T ≤ horizon)（μ̂ > 0 时逆高斯 CDF；≤ 0 时 1 − 破产反转口径） */
  probByHorizon: number;
  /** 期望恢复时间 a/μ̂（μ̂ > 0；否则 undefined） */
  expectedTime: number | undefined;
  /** 推荐冷却（P(恢复 ≤ cooldown) ≥ target 的最小 horizon；μ̂ ≤ 0 时 undefined） */
  recommendedCooldown: number | undefined;
}
/**
 * 冷却定价（40.0 接线口径）。
 *
 * failureIntervals: 观察到的相邻失败间隔（时间单位任意，一致即可）。
 * 「恢复」被建模为失败强度游走下行首达阈值 a（缺省 = 间隔均值的一半，
 * 即失败频率减半）：μ̂/σ̂ 由间隔序列的均值/标准差估计（间隔上升 =
 * 恢复方向）。recommendedCooldown 二分求解。
 */
declare function firstPassageCooldown(failureIntervals: ReadonlyArray<number>, options?: {
  targetProb?: number;
  threshold?: number;
}): FirstPassageEstimate | undefined;
//#endregion
//#region src/core/queueing-network.d.ts
/**
 * 41.0 排队网络内核 —— Jackson 乘积形式 + 串联逗留 + 瓶颈站：吞吐链路成为网络
 *
 * 动机: 25.0 容量规划把「一个模型」当一台 M/M/c 排队机反解并发；但一次
 * 调度要穿过**一条链**：入队 → 模型调用 → 反思回流——端到端延迟与吞吐
 * 上限由整条串联网络决定，瓶颈站在哪一站是排队网络的问题。
 *
 *   Jackson 定理 (1957): 串联（更一般地，乘积形式网络）各站的稳态
 *   边际分布相互独立、每站各自是 M/M/c：
 *     π(n₁,…,n_K) = Π_k π_k(n_k)，π_k 为该站独立的 M/M(c_k) 稳态
 *   → 端到端逗留时间 = Σ_k (Wq_k + 1/μ_k)；**瓶颈站 = ρ 最大者**，
 *     ρ_k = λ/(c_k μ_k) → 1 时全网排队爆炸（其他站再快也无济于事）。
 *
 *   单站口径复用 25.0 的 erlangC（等待概率 / 平均等待闭式）——内核间
 *   协同：25.0 反解「要多少并发」，41.0 回答「链路瓶颈在哪、端到端
 *   要多久」。验证锚点: 两站串联 M/M/1 的边际独立性（模拟对照乘积
 *   形式）、端到端逗留 = 各站之和。
 *
 * 零漂移: 未挂载时心跳与调度行为与升级前逐位一致。
 */
/** 网络中的一站（M/M/c 口径） */
interface QueueStation {
  /** 站名（诊断输出用） */
  name: string;
  /** 到达率 λ（每毫秒；串联网络各站同 λ） */
  lambdaPerMs: number;
  /** 单服务员服务率 μ（每毫秒；1/平均服务时长） */
  muPerMs: number;
  /** 并行服务员数（并发容量） */
  servers: number;
}
interface StationMetrics {
  name: string;
  rho: number;
  stable: boolean;
  /** 平均等待 Wq（毫秒） */
  avgWaitMs: number;
  /** 平均逗留 Wq + 1/μ（毫秒） */
  avgSojournMs: number;
  /** 等待概率（Erlang-C） */
  waitProbability: number;
}
interface NetworkReport {
  stations: StationMetrics[];
  /** 端到端平均逗留（Σ 各站，Jackson 乘积形式下各站独立） */
  endToEndSojournMs: number;
  /** 瓶颈站（ρ 最大；不稳定站优先） */
  bottleneck: StationMetrics | undefined;
  /** 全网是否稳定（所有站 ρ < 1） */
  stable: boolean;
}
/** 串联排队网络分析（Jackson 乘积形式；各站独立 M/M/c 边际） */
declare function tandemNetwork(stations: ReadonlyArray<QueueStation>): NetworkReport;
/** 网络可稳定的最小服务员配置（逐站反解 ⌈λ/μ⌉ + 1，与 25.0 反解同口径） */
declare function minimalStableServers(stations: Omit<QueueStation, 'servers'>[]): number[];
/**
 * Jackson 乘积形式审计（验证锚点）：给定各站队长样本，检验两站边际
 * 的经验相关性 ≈ 0（独立性的有限样本读数）。
 */
declare function jacksonIndependenceAudit(queueSamples: ReadonlyArray<[number, number]>): {
  correlation: number;
  samples: number;
};
/** 瓶颈站洞察构造（autonomy-loop 2.9 段消费） */
declare function bottleneckInsight(report: NetworkReport, rhoThreshold?: number): {
  message: string;
  suggestion: string;
  severity: number;
} | undefined;
//#endregion
//#region src/core/spectral-periodicity.d.ts
/**
 * 42.0 谱周期内核 —— FFT 周期图 + Fisher g 检验：节律从数据里解出来
 *
 * 动机: 世界模型的「时段热度」是 24 小时直方图——周期被**预设**为一天。
 * 但多模型调度面对的节律不止昼夜：分钟级突发回环、小时级批处理、
 * 周节律——预设直方图看不见它们。谱分析把周期问题变成数据问题:
 *
 *   离散傅里叶变换（Cooley–Tukey 1965, O(n log n)）:
 *     X_k = Σ_t x_t e^{−2πikt/n}
 *   周期图 I_k = |X_k|²——信号能量在频率上的分布（Parseval: ΣI = nΣx²）。
 *
 *   Fisher g 检验（1929）: g = max_k I_k / Σ_k I_k——最大周期图份额；
 *   白噪声下 g 的精确分布已知（P(g > g₀) 递推式），g 显著大 ⟹ 序列
 *   含有**真实周期**而不是抖动。显著周期经谐波重构给出相位感知的
 *   季节因子——「现在处于周期的哪个相位」成为可计算的读数。
 *
 *   调度语义: 到达历史的显著周期 + 相位 → 预测乘上季节因子（该相位
 *   的历史期望权重），时段热度从「预设的小时直方图」升级为「从数据
 *   里解出的频谱」；无显著周期时因子恒 1（诚实无节律）。
 *
 *   验证锚点: FFT 往返恒等（x ↔ FFT⁻¹FFT(x)）、Parseval 定理、已知
 *   周期的频率恢复、纯噪声 g 检验不显著 / 注入周期显著。
 *
 * 零漂移: 未挂载时预测路径与升级前逐位一致。
 */
/** 迭代 radix-2 FFT（n 为 2 的幂；原地蝶形，bit 反转重排） */
declare function fft(input: ReadonlyArray<number>): Array<{
  re: number;
  im: number;
}>;
/** 逆 FFT（共轭法：IFFT(X) = conj(FFT(conj(X)))/n，实序列取实部） */
declare function ifft(spectrum: ReadonlyArray<{
  re: number;
  im: number;
}>): number[];
interface SpectralPeak {
  /** 周期图份额（I_k / ΣI） */
  share: number;
  /** 周期（ bins；period = n / k） */
  period: number;
  /** 频率 index k */
  frequency: number;
  /** 相位（弧度，x_t ≈ A·cos(2πkt/n + φ)） */
  phase: number;
  /** 振幅（2|X_k|/n，实信号口径） */
  amplitude: number;
}
interface PeriodogramReport {
  /** 周期图（前 n/2+1 个 bin） */
  periodogram: number[];
  /** Fisher g 统计量（最大份额） */
  g: number;
  /** g 的上侧 p 值（白噪声零假设；精确分布递推） */
  pValue: number;
  /** 是否存在显著周期（p < alpha） */
  significant: boolean;
  /** 降序前 k 个谱峰（只报显著时） */
  peaks: SpectralPeak[];
  bins: number;
}
/**
 * Fisher g 检验上侧概率（精确递推，n_bins = n/2）:
 *   P(g > g₀) = Σ_j (-1)^{j+1} C(m, j) (1 - j·g₀)^{m-1}，j ≤ 1/g₀
 * （Fisher 1929；只取 1 - j·g₀ > 0 的项）
 */
declare function fisherGUpperTail(g: number, m: number): number;
/**
 * 周期图 + Fisher g 检验 + 谱峰提取。
 *
 * series: 等间隔采样序列（自动去均值）；lengthPad: 补零目标长度（2 的幂，
 * 缺省不补）。alpha 显著水平（缺省 0.05）。
 */
declare function periodogram(series: ReadonlyArray<number>, options?: {
  alpha?: number;
  topPeaks?: number;
}): PeriodogramReport;
/**
 * 季节因子（42.0 接线口径）：给定历史等间隔序列与当前相位 bin，
 * 显著周期时返回「该相位的历史期望权重」（谐波重构，缺省平滑到 1），
 * 无显著周期 / 样本不足返回 1（诚实无节律——零介入）。
 */
declare function seasonalFactor(history: ReadonlyArray<number>, phaseBin: number): {
  factor: number;
  significant: boolean;
  period: number | undefined;
};
//#endregion
//#region src/core/fair-division.d.ts
/**
 * 44.0 公平分配内核 —— 极大极小公平 + 注水算法：没有谁被饿死是定理
 *
 * 动机: 探索预算分给哪些知识域？按新颖度比例分会让冷门域长期饿死
 * （新颖度高的域永远拿走大头），均分又浪费（有的域根本没有盲区）。
 * 网络工程的经典答案——**极大极小公平**（max-min fairness）:
 *
 *   分配 x 在「不减少更穷者」的意义下不可改进：
 *     ∀i: 增加 x_i 必然存在 j，x_j ≤ x_i 且 x_j 减少
 *   → 词典序最大：先尽量抬高最小的份额，再抬高次小的……（Bertsekas–
 *     Gallager–Tsitsiklis 1992）。注水算法（water-filling）O(n log n)
 *   精确求解：需求低于水位的拿满需求，剩余容量在超额需求者间均摊。
 *
 *   加权口径（progressive filling，weights w_i）: 份额按权重比例增长
 *   直到容量耗尽——权重公平同时保底「最穷相对份额」。
 *
 *   调度语义: 探索预算按域分配从「新颖度 top-k 的赢者通吃」升级为
 *   加权极大极小：热门域可以多拿，但任何活跃域的相对份额不被压扁——
 *   **探索的覆盖有公平定理背书**（多样性坍缩在预算层再上一道锁）。
 *
 *   验证锚点: 教科书例（demands [2, 4, 2.4, 1] / 容量 5 → 前两个均摊
 *   2.5 的经典）、公平支配性审计（不可改进性逐位检查）、加权口径
 *   按权重比例、需求全小于容量时各取所需。
 *
 * 零漂移: 未挂载时探索预算分配与升级前逐位一致。
 */
interface FairAllocation {
  /** 各方份额 */
  shares: number[];
  /** 注水水位（需求超额者共同的水位；全需求内则 = ∞ 语义，此处 = max(share)） */
  waterLevel: number;
  /** 未满足的总需求 */
  deficit: number;
}
/**
 * 极大极小公平分配（注水算法）。
 *
 * demands: 各方需求（≥ 0）；capacity ≥ 0。需求 ≤ 水位者拿满需求，
 * 超额者在剩余容量中均摊。词典序最优性是构造性保证。
 */
declare function maxMinFair(demands: ReadonlyArray<number>, capacity: number): FairAllocation;
/**
 * 加权极大极小公平（progressive filling：各方按权重比例注水）。
 *
 * 份额增长率 ∝ w_i；某方到达需求后退出，其余继续。w_i 全相等时退化为
 * 经典 max-min（等权重是特例——验证锚点之一）。
 */
declare function weightedMaxMinFair(demands: ReadonlyArray<number>, weights: ReadonlyArray<number>, capacity: number): FairAllocation;
/**
 * 公平支配性审计（验证锚点）: 极大极小的定义性检查——
 * ∀i: x_i < demand_i（未拿满）⟹ ∃j≠i: x_j/w_j ≤ x_i/w_i 且 x_j > 0
 * （i 的任何增长必挤占一个相对份额不高于自己的持有者）。
 */
declare function fairnessAudit(demands: ReadonlyArray<number>, allocation: ReadonlyArray<number>, weights?: ReadonlyArray<number>): {
  fair: boolean;
  violations: number;
};
/** 域预算接线口径：需求（各域盲区数 × 新颖度权重）→ 加权公平份额（整数保底：活跃域优先各得 1，再按权重注水） */
declare function fairDomainBudget(domains: ReadonlyArray<{
  id: string;
  demand: number;
  weight: number;
}>, budget: number): Array<{
  id: string;
  share: number;
}>;
//#endregion
//#region src/core/budget-allocation.d.ts
/**
 * 45.0 预算分配内核 —— OCBA 最优计算预算：找最优者的每一步都花在刀刃上
 *
 * 动机: 基准测试与 A/B 比较的资源分配是均匀的——每个候配置跑同样
 * 多次。但「确认谁最优」不需要均匀：差距大的候选早早出局、方差大的
 * 候选需要更多样本。Chen 等人的最优计算预算分配（OCBA, 2000）把
 * 「以最小总预算最大化正确选出最优者的概率 P(CS)」近似成渐近有效
 * 的闭式分配:
 *
 *   n_i / n_j = (σ_i/δ_i)² / (σ_j/δ_j)²        （i, j 非最优候选间）
 *   n_b = σ_b · sqrt(Σ_{i≠b} n_i²/σ_i²)         （最优者基准样本）
 *   δ_i = |μ_i − μ_b|（与最优者的差距）
 *
 *   渐近最优性 (Glynn–Juneja 2004): 该分配在 budget → ∞ 时最大化
 *   P(CS) 的指数衰减率——**每一步采样都花在刀刃上**。贝叶斯最优实验
 *   设计（10.0 科学家）面向「知识获取」，OCBA 面向「择优确认」——
 *   两者互补。
 *
 *   调度语义: 基准预算在场景间的分配从均匀升级为 OCBA——多花样本在
 *   「不确定是否最差」的场景上（找瓶颈子系统），差距明确的场景早停。
 *   验证锚点: Monte Carlo 对照（OCBA vs 均匀的 P(CS)）、固定分配的
 *   渐近比例与公式一致、预算守恒。
 *
 * 零漂移: 未挂载时基准执行与升级前逐位一致。
 */
interface OcbaCandidate {
  /** 候选名（诊断输出用） */
  name: string;
  /** 试点均值估计（越大越优或越小越优，由 biggerIsBetter 统一口径） */
  mean: number;
  /** 试点标准差估计 */
  std: number;
}
interface OcbaAllocation {
  /** 各候选分配的样本数（整数，总和 = budget） */
  counts: number[];
  /** 最优者下标（按试点均值） */
  best: number;
  /** 分配依据的差距 δ_i */
  gaps: number[];
  total: number;
}
/**
 * OCBA 迭代分配（Chen et al. 2000）。
 *
 * candidates: 试点统计；budget: 总样本预算；biggerIsBetter: 均值大者优
 * （缺省 true——如吞吐；false 用于延迟类越小越优）。
 * 试点 std ≤ 0 时给最小噪声下限（方差为零的候选按公式退化，防除零）。
 */
declare function ocbaAllocate(candidates: ReadonlyArray<OcbaCandidate>, budget: number, options?: {
  biggerIsBetter?: boolean;
  minSamples?: number;
}): OcbaAllocation;
/**
 * Monte Carlo P(CS) 对照（验证锚点）: 按给定分配重复模拟「采样 → 选
 * 经验最优」的正确概率。用于断言 OCBA 分配的 P(CS) ≥ 均匀分配。
 */
declare function monteCarloCorrectSelection(trueMeans: ReadonlyArray<number>, trueStds: ReadonlyArray<number>, counts: ReadonlyArray<number>, biggerIsBetter: boolean, reps?: number, seed?: number): number;
//#endregion
//#region src/core/quorum-systems.d.ts
/**
 * 46.0 法定人数内核 —— Quorum 交叉 + 拜占庭口径 + 负载：共识安全性可检查
 *
 * 动机: Raft 的安全性靠「多数派两两相交」这条组合性质——但它从未被
 * 系统检查过，只是被相信。法定人数系统（quorum systems）把共识安全
 * 变成可验证的组合对象:
 *
 *   交叉性质: 任意两个法定人数相交 ⟹ 读到的写者集合非空
 *   （一致性）。多数派 quorum 交 |V|/2（崩溃容错 f < n/2 的根源）。
 *
 *   拜占庭口径: 任意两个 quorum 相交于 ≥ f+1 个节点 ⟹ 交集含至少
 *   一个诚实节点（谎言无法同时骗过两个 quorum）——Q² 系统
 *   （n > 3f 时的经典构造）。f ≥ n/3 时不存在这样的系统——
 *   「3f+1 下界」不是工程建议，是不存在性定理。
 *
 *   负载 (Naor–Wool): 系统负载 L = max_Q |Q|/n——读放大的稳态代价；
 *   多数派系统 L = (⌊n/2⌋+1)/n，值得知道而非接受。
 *
 *   验证锚点: 多数派两两相交（枚举）、奇偶 n 的界、拜占庭 n>3f 可行/
 *   n≤3f 不可行的判别、负载闭式。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */
interface QuorumAudit {
  nodes: number;
  /** 法定人数大小（多数派口径 ⌊n/2⌋+1） */
  quorumSize: number;
  /** 容错上界 f = quorumSize − 1（崩溃口径：非交集部分全坏仍安全） */
  crashFaultTolerance: number;
  /** 两两 quorum 的最小交集大小 */
  minIntersection: number;
  /** 交集性质是否成立 */
  intersects: boolean;
  /** 拜占庭口径：最小交集 ≥ f_byz+1 所容许的最大 f_byz */
  byzantineTolerance: number;
  /** 系统负载 max|Q|/n（多数派闭式） */
  load: number;
}
/**
 * 多数派法定人数审计（n ≥ 1）。
 *
 * minIntersection = 2q − n（q = ⌊n/2⌋+1）；拜占庭容错 = minIntersection−1
 * （交集 ≥ f+1 ⟺ f ≤ 交−1）；n ≤ 3f ⟹ 拜占庭容错 < f——诚实给出。
 */
declare function majorityQuorumAudit(n: number): QuorumAudit;
/** 枚举所有 ⌊n/2⌋+1 子集的两两最小交集（验证锚点；n ≤ 15 适用） */
declare function bruteForceMinIntersection(n: number, quorumSize?: number): number;
/**
 * 拜占庭可行性判别（n > 3f 存在性口径）：给定 n 与目标拜占庭容错 f，
 * 最优 quorum 构造 q = ⌈(n+f+1)/2⌉ 是否给出 ≥ f+1 交集——n ≥ 3f+1
 * 时可行（经典构造）；n ≤ 3f 时诚实 false——3f+1 下界（不存在性定理，
 * 换任何 quorum 系统都救不了）。
 */
declare function byzantineFeasible(n: number, f: number): boolean;
/**
 * Raft 集群安全审计（46.0 接线口径，纯读取）。
 *
 * members: 集群节点数（Raft 配置口径）；产出多数派交叉、容错上界与
 * 负载——共识安全性从「被相信」升级为「被检查」。
 */
declare function raftSafetyAudit(members: number): QuorumAudit & {
  verdict: string;
};
//#endregion
//#region src/core/crdt.d.ts
/**
 * 47.0 无冲突复制内核 —— CRDT 三定律：副本收敛是代数性质
 *
 * 动机: 分布式同步的合并语义若不满足代数定律，副本在网络分区/乱序
 * 送达下发散且不可检测。CRDT（Shapiro et al. 2011）把「收敛」从协议
 * 希望变成**合并算子的代数性质**:
 *
 *   强最终一致性定理: 合并 ⋃ 满足交换/结合/幂等三律（join-semilattice）
 *   ⟹ 任意乱序/重复送达的消息流之后，所有活跃副本状态相等——
 *   不需要共识、不需要协调、不需要可信信道。
 *
 *   - G-Counter: 每节点只加自己的分量，合并 = 逐分量 max
 *   - OR-Set (add-win): 元素带唯一标签，add 打标签 / remove 摘标签，
 *     合并 = 标签并集；并发 add+remove 中 add 胜（语义选择，非歧义）
 *   - LWW-Register: 时间戳偏序 + 节点 id 平局仲裁（全序保证合并唯一）
 *
 *   验证锚点: 随机操作流的任意置换应用 → 状态逐位相等（收敛定理的
 *   有限样本验证）；三律逐位检查。
 *
 * 零漂移: 纯数据结构内核（引擎按需使用），未挂载零介入。
 */
/** G-Counter（增长计数器；merge = 逐分量 max） */
declare class GCounter {
  private counts;
  increment(nodeId: string, by?: number): void;
  value(): number;
  state(): Record<string, number>;
  merge(other: GCounter): void;
  clone(): GCounter;
}
/** OR-Set（add-win 观察者集；标签唯一 → 并发 add 胜 remove） */
declare class ORSet {
  private added;
  private removed;
  add(element: string, tag?: string): void;
  remove(element: string): void;
  has(element: string): boolean;
  elements(): string[];
  merge(other: ORSet): void;
  clone(): ORSet;
}
/** LWW-Register（时间戳 + 节点 id 仲裁的全序最后写胜） */
declare class LWWRegister<T> {
  private readonly nodeId;
  private value?;
  private stamp;
  private writer;
  constructor(nodeId: string);
  set(value: T, stamp: number): void;
  get(): T | undefined;
  state(): {
    value?: T;
    stamp: number;
    writer: string;
  };
  merge(other: {
    value?: T;
    stamp: number;
    writer: string;
  }): void;
}
/**
 * 收敛审计（验证锚点）: 两副本各自应用同批操作的任意置换，再互相
 * 合并（含重复合并）——三律成立 ⟹ 状态逐位相等（强最终一致性的
 * 有限样本验证）。返回最大状态偏差（应恒 0）。
 */
declare function crdtConvergenceAudit(ops: ReadonlyArray<{
  node: 'a' | 'b';
  kind: 'inc';
  by: number;
} | {
  node: 'a' | 'b';
  kind: 'add' | 'remove';
  element: string;
}>, permutation: ReadonlyArray<number>): {
  counterDelta: number;
  setSymmetricDiff: number;
};
//#endregion
//#region src/core/secret-sharing.d.ts
/**
 * 48.0 秘密共享内核 —— Shamir 阈值 + 随机性审计：信任被分形，密钥被检验
 *
 * 动机: 主密钥单点保管 = 单点沦陷即全失。Shamir 秘密共享（1979）把
 * 秘密拆成 n 份、任意 t 份可重建、t−1 份**信息论零泄露**:
 *
 *   秘密 = 域 GF(p) 上 t−1 次多项式 f 的常数项，份额 = f(x_i)。
 *   重建 = t 个点上的 Lagrange 插值（任意 t 个点唯一确定 f ⟹ f(0)
 *   唯一）；t−1 个点对 f(0) 的每种猜测都存在唯一一致的多项式——
 *   **完备保密**（不是计算难度，是信息论意义：t−1 份与秘密统计独立）。
 *
 *   随机性审计（NIST SP 800-22 的两个核心检验）:
 *   - 频数检验: 1 的占比偏离 1/2 的 |χ| 口径（渐近 N(0,1)）
 *   - 游程检验: 游程数偏离期望（同值段切换次数的 χ² 口径）
 *   好的 PRNG 通过、偏置源被拒绝——「密钥的原料合格吗」可检查。
 *
 *   验证锚点: 任意 t 份子集重建成功（枚举）、t−1 份子集重建出
 *   随机等可能值（零泄露的实验读数）、Lagrange 恒等式、
 *   均匀字节通过审计 / 偏置字节被拒。
 *
 * 零漂移: 纯函数内核（引擎按需使用），未挂载零介入。
 */
interface ShamirShare {
  /** 份额点 x（非 0） */
  x: number;
  /** f(x)（域元素，字符串化 BigInt） */
  y: string;
}
/** Shamir 拆分：secret（UTF-8）→ n 份，阈值 t ≤ n 重建 */
declare function shamirSplit(secret: string, n: number, threshold: number, rng?: () => number): ShamirShare[];
/** Shamir 重建：任意 ≥ 阈值份额 → 秘密（Lagrange 插值 f(0)） */
declare function shamirCombine(shares: ReadonlyArray<ShamirShare>): string;
interface EntropyAudit {
  bytes: number;
  /** 频数检验：1 的占比（应 ≈ 0.5） */
  oneRatio: number;
  /** 频数 χ 统计量（渐近 N(0,1)；|χ| > 3 拒绝） */
  frequencyChi: number;
  /** 游程数（同值段数；期望 ≈ n/2） */
  runs: number;
  /** 游程偏离 z 口径 */
  runsZ: number;
  /** 综合判定（两项 |z| ≤ 3 通过） */
  passed: boolean;
}
/** 随机性审计（频数 + 游程检验；NIST SP 800-22 口径） */
declare function entropyAudit(bytes: ReadonlyArray<number>): EntropyAudit;
//#endregion
//#region src/core/multiscale-wavelet.d.ts
/**
 * 49.0 多尺度内核 —— Haar 小波：趋势与突发在不同尺度上分离
 *
 * 动机: KPI 异常检测都在**单一时间尺度**上看序列（窗口 z-score、NIS、
 * 形状漂移）——缓慢漂移被当作背景，尖锐突发被当作噪声。Haar 小波
 * 把序列分解为**对数个尺度**的正交分量（Mallat 1989）:
 *
 *   H = I ⊗ ... 正交矩阵（能量守恒 ‖Hx‖ = ‖x‖，完美重构 H⁻¹ = Hᵀ）
 *   每层：近似分量（趋势/2 尺度）+ 细节分量（该尺度的突发）
 *
 *   读法: 最粗尺度的近似 = 长期水平；最细尺度的细节能量 = 瞬时抖动；
 *   中间尺度的细节尖峰 = 特定周期的异常。**同一份 KPI，对数个透镜**。
 *
 *   验证锚点: 完美重构（Hᵀ·Hx = x 机器精度）、能量守恒（Parseval）、
 *   合成「慢趋势 + 快突发」的双尺度分离（各尺度能量落位）。
 *
 * 零漂移: 未挂载时元认知输出与升级前逐位一致。
 */
interface WaveletDecomposition {
  /** 每层细节系数（从最细到最粗：scale 1, 2, ..., n/2） */
  details: number[][];
  /** 最粗尺度近似（趋势水平） */
  approximation: number[];
  /** 各尺度能量占比（细节 + 近似，和 = 1） */
  energyShares: Array<{
    scale: string;
    share: number;
  }>;
  length: number;
}
/** Haar 离散小波变换（n 为 2 的幂；O(n log n)） */
declare function haarDecompose(series: ReadonlyArray<number>): WaveletDecomposition;
/** Haar 逆变换（完美重构验证锚点） */
declare function haarReconstruct(decomposition: WaveletDecomposition): number[];
interface MultiScaleView {
  /** 最粗趋势水平（去尺度化：近似系数 / 2^(levels/2) 语义上即长期均值口径） */
  trendLevel: number;
  /** 最细尺度（逐点）细节能量占比 */
  burstShare: number;
  /** 能量最集中的非趋势尺度 */
  dominantScale: string;
  /** 中尺度（8-32 点）细节能量占比（漂移带） */
  driftShare: number;
}
/** 多尺度读数（49.0 接线口径：元认知 KPI 的尺度透镜） */
declare function multiScaleView(series: ReadonlyArray<number>): MultiScaleView;
//#endregion
//#region src/core/matrix-completion.d.ts
/**
 * 50.0 矩阵补全内核 —— 低秩交替最小二乘：冷启动能力从潜维度涌现
 *
 * 动机: 新模型注册时 taskScores 一片空白——要积累多少次调用才能
 * 知道它擅长什么？如果「模型 × 任务类型」的能力矩阵是**低秩**的
 * （少数几个潜能力维度决定一切——语言能力/推理能力/长文本能力…），
 * 那么观测到的少量条目就足以**补全**整个矩阵:
 *
 *   低秩模型: M ≈ U·Vᵀ（rank r ≪ min(n,m)）；观测 Ω 上的条目
 *   最小化 Σ_{(i,j)∈Ω} (M_ij − (UVᵀ)_ij)² —— 交替最小二乘（ALS）:
 *   固定 V 解 U（每行闭式线性解）、固定 U 解 V，交替至收敛。
 *   恢复条件（Candès–Recht 2009）: 秩 r 与相干性温和、观测密度
 *   |Ω| ≳ r·n·log n 量级时精确恢复（定理背书，非祈祷）。
 *
 *   调度语义: 新模型在若干任务类型上的早期成绩 → ALS 潜因子 →
 *   未测任务类型上的能力预测——**冷启动选型从「零样本瞎选」升级
 *   为潜维度外推**；同时低秩残差大的模型是「能力异常」（不适合
 *   潜维度解释，需单独画像）。
 *
 *   验证锚点: 合成低秩矩阵 + 噪声的部分观测 → 恢复误差 ≪ 观测噪声
 *   的若干倍；满秩随机矩阵诚实高残差（不强行低秩解释）。
 *
 * 零漂移: 纯诊断口径（getAttachedDiagnostics / coldStartEstimate），
 *   未挂载时评分路径逐位一致。
 */
interface MatrixCompletionOptions {
  /** 潜维数 r（缺省 3） */
  rank?: number;
  maxIterations?: number;
  tol?: number;
  /** L2 正则（缺省 1e-3，防过拟合小样本行） */
  lambda?: number;
  seed?: number;
}
interface CompletionReport {
  /** 因子矩阵（n×r 与 m×r） */
  rowFactors: number[][];
  colFactors: number[][];
  /** 观测条目上的 RMSE（拟合度） */
  trainRmse: number;
  /** 观测数 / 全矩阵 */
  observedRatio: number;
  iterations: number;
  converged: boolean;
  /** 有效秩读数：拟合能量 / 总能量（低秩假设的成色） */
  lowRankShare: number;
}
/**
 * 低秩矩阵补全（ALS；行/列闭式岭回归交替）。
 *
 * observed: 观测条目列表 [{i, j, value}]；n/m 为矩阵维度。
 * 行/列因子以确定性小扰动初始化（对称破缺）。
 */
declare function completeMatrix(observed: ReadonlyArray<{
  i: number;
  j: number;
  value: number;
}>, n: number, m: number, options?: MatrixCompletionOptions): CompletionReport;
/** 补全预测：M_ij ≈ u_i · v_j（观测未覆盖的条目外推） */
declare function completedEntry(report: CompletionReport, i: number, j: number): number | undefined;
//#endregion
//#region src/core/resilience.d.ts
/**
 * resilience.ts — 弹性内核（项目 4.0「可靠执行」基石）
 *
 * 勘察结论（升级前）：task-executor 重试紧贴重发（无退避）、错误不分型
 * （网络错与质量错同路径）、无模型级熔断（同一坏模型被反复重试打爆配额）。
 *
 * 本内核把「熔断 + 退避 + 错误分型」做成全链路共享的纯组件：
 * - CircuitBreaker：closed → open（连续失败 ≥ 阈值）→ half-open（冷却后单试探，
 *   并发互斥——同一时刻只放行一个探测请求）→ closed（探测成功）
 * - CircuitBreakerRegistry：按 key（如 modelId）隔离的熔断器集合（容量上限防泄漏）
 * - backoffDelayMs：指数退避 + 全抖动（防惊群），可注入随机源保证测试确定性
 * - abortableSleep：可中止睡眠（全局超时到达时立即中断退避等待）
 * - classifyError：错误分型——可退避重试（网络/超时/限流）/ 立即重试 /
 *   换模型（能力类）/ 终止（不可恢复），驱动差异化重试策略
 */
/** 熔断器状态 */
type BreakerState = 'closed' | 'open' | 'half-open';
/** 熔断器配置 */
interface CircuitBreakerConfig {
  /** 连续失败进入熔断的阈值 */
  failureThreshold: number;
  /** 熔断冷却期（毫秒），期满转 half-open */
  cooldownMs: number;
}
declare const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig;
/** 熔断器可执行性探测结果 */
interface BreakerProbe {
  allowed: boolean;
  state: BreakerState;
  /** open 状态下距下次可试探的剩余毫秒 */
  msUntilRetry: number;
}
/** 熔断器状态快照（可观测性） */
interface BreakerStatus {
  state: BreakerState;
  consecutiveFailures: number;
}
/**
 * 单 key 熔断器
 *
 * half-open 并发互斥：冷却期满后首个请求获得探测资格，其余请求仍被拒绝——
 * 避免冷却结束瞬间流量洪峰直接打到尚未恢复的下游。
 */
declare class CircuitBreaker {
  private config;
  private state;
  private consecutiveFailures;
  private openedAt;
  /** half-open 探测互斥：>0 表示已有探测在途 */
  private halfOpenInFlight;
  constructor(config?: Partial<CircuitBreakerConfig>);
  /** 探测当前是否放行（不改变状态；放行后调用方须成对调用 recordSuccess/recordFailure） */
  canExecute(now?: number): BreakerProbe;
  /**
   * 无副作用检查：纯读取当前可执行性（不获取 half-open 探测名额）
   *
   * 用于候选过滤/展示等「只看不执行」场景——canExecute 在 half-open 态
   * 会占用探测名额，纯检查场景必须用 peek，否则名额泄漏导致永久误判熔断。
   */
  peek(now?: number): BreakerProbe;
  /** 成功回报：清零失败计数，half-open 探测成功 → 恢复闭合 */
  recordSuccess(): void;
  /** 失败回报：累计连续失败，达阈值熔断；half-open 探测失败 → 重新熔断 */
  recordFailure(now?: number): void;
  /** 状态快照（可观测性） */
  getState(): BreakerStatus;
  /** 手动复位 */
  reset(): void;
  /**
   * 释放 half-open 探测资格（不改变成功/失败统计）
   *
   * 用于「请求已发出但无法判定下游可用性」的场景（如客户端 4xx）：
   * 探测互斥锁必须释放，否则后续请求永久被拒。
   */
  releaseProbe(): void;
}
/**
 * 按 key 隔离的熔断器注册表
 *
 * 典型 key = modelId（模型 A 熔断不影响模型 B）；容量上限 + 简单 LRU 淘汰，
 * 防止长尾模型 id 导致的无界增长。
 */
declare class CircuitBreakerRegistry {
  private breakers;
  private config;
  private capacity;
  constructor(config?: Partial<CircuitBreakerConfig> & {
    capacity?: number;
  });
  private get;
  canExecute(key: string, now?: number): BreakerProbe;
  /** 无副作用检查（纯读取，不占用 half-open 探测名额） */
  peek(key: string, now?: number): BreakerProbe;
  recordSuccess(key: string): void;
  recordFailure(key: string): void;
  releaseProbe(key: string): void;
  /** 全部熔断器状态（运维可观测） */
  snapshot(): Record<string, BreakerStatus>;
  /** 是否有任一 key 处于熔断（快速检查） */
  hasOpen(): boolean;
  reset(key?: string): void;
}
/** 退避配置 */
interface BackoffConfig {
  /** 首次退避基数（毫秒） */
  baseMs: number;
  /** 指数因子 */
  factor: number;
  /** 退避上限（毫秒）——防止大重试次数下延迟爆炸 */
  maxMs: number;
}
declare const DEFAULT_BACKOFF_CONFIG: BackoffConfig;
/**
 * 指数退避延迟（全抖动：[0, min(base × factor^(attempt-1), max)] 均匀采样）
 *
 * 全抖动（full jitter）相对确定性退避的优势：并发重试错峰，防惊群。
 * @param attempt 本次失败后的重试序号（1 = 第一次重试）
 * @param rng 随机源（测试可注入确定性实现）
 */
declare function backoffDelayMs(attempt: number, config?: Partial<BackoffConfig>, rng?: () => number): number;
/**
 * 可中止睡眠：全局超时/中止信号到达时立即返回 false（放弃重试）
 * @returns true = 睡满（可继续重试）；false = 被中止（放弃）
 */
declare function abortableSleep(ms: number, abortSignal?: AbortSignal): Promise<boolean>;
/** 错误重试分型 */
type RetryClass =
/** 网络抖动/限流/超时：指数退避后原路重试（下游可能恢复） */
'retryable-backoff' |
/** 已知幂等瞬时错：立即重试（如队列争用） */
'retryable-immediate' |
/** 执行到达但产出不达标：重试无益，换模型（能力问题） */
'switch-model' |
/** 不可恢复（配置错/鉴权错/未知错）：停止重试 */
'fatal';
interface ErrorClassification {
  class: RetryClass;
  /** 机器可读错误类别名 */
  kind: 'timeout' | 'network' | 'rate-limit' | 'server' | 'client' | 'quality' | 'unknown';
  /** 人类可读说明 */
  reason: string;
}
/**
 * 错误分型（差异化重试的依据）
 *
 * 分型策略：
 * - TimeoutError → retryable-backoff（下游可能过载，退避让路）
 * - NetworkError → retryable-backoff（网络抖动，退避重试）
 * - 携带可重试状态码的 LLMError → retryable-backoff（429/5xx）
 * - 携带 4xx（非 408/429）状态码 → fatal（请求本身有问题，重试无意义）
 * - 质量不达标（由调用方在 verdict 层判定，不走本函数）→ switch-model
 * - 其余未知错误 → fatal（与升级前「非超时不重试」行为一致）
 */
declare function classifyError(err: unknown): ErrorClassification;
//#endregion
//#region src/memory/alias-map.d.ts
/**
 * alias-map.ts — 防幻觉短索引映射（自主学习建议 3）
 *
 * 将冗长的记忆 ID（指纹 / 策略 id / 教训 id）在注入大模型前转换为短索引（#1, #2, #3），
 * 模型只需引用短索引，输出后再反向解析回完整 ID：
 * - 降低模型复述长 ID 产生的幻觉率
 * - 减少注入与输出的 Token 消耗
 *
 * 映射为请求级临时对象（不持久化）：每次注入前新建，注入与反解共用同一实例。
 */
declare class AliasMap {
  private encodeMap;
  private decodeMap;
  private next;
  /** 为完整 ID 分配短索引（幂等），返回形如 #1 */
  encode(id: string): string;
  /** 短索引 → 完整 ID（未知索引返回 undefined） */
  resolve(alias: string): string | undefined;
  /** 将文本中的完整 ID 替换为短索引（按 ID 长度降序，避免前缀误替换） */
  encodeText(text: string): string;
  /** 将文本中的短索引反向解析回完整 ID（未登记的索引原样保留） */
  decodeText(text: string): string;
  /** 当前映射条目（调试/日志） */
  entries(): Array<{
    alias: string;
    id: string;
  }>;
  get size(): number;
}
//#endregion
//#region src/memory/migration-tool.d.ts
/** 迁移冲突中可保留的记录版本（按冲突类型判别） */
type MigrationRecordVersion = TaskPatternMemory | ModelLongTermProfile | DecisionFeedback | SemanticMemory | ProceduralMemory;
/** 迁移包（自包含、可校验、可审计） */
interface MigrationPackage {
  version: number;
  exportedAt: number;
  source: {
    instanceId: string;
    instanceName?: string;
    pluginVersion: string;
  };
  scope: {
    includePatterns: boolean;
    includeModelProfiles: boolean;
    includeFeedback: boolean;
    includeSemanticMemories: boolean;
    includeProceduralMemories: boolean;
    includeGlobalStats: boolean;
    tenantFilter?: string[];
  };
  /** data 段 JSON 序列化后的 SHA-256（hex），导入前强制校验 */
  checksum: string;
  data: {
    taskPatterns?: TaskPatternMemory[];
    modelProfiles?: ModelLongTermProfile[];
    decisionFeedback?: DecisionFeedback[];
    /** 4.0：语义记忆（跨任务规律）——此前缺失导致迁移丢数据 */
    semanticMemories?: SemanticMemory[];
    /** 4.0：程序记忆（if-then 规则）——此前缺失导致迁移丢数据 */
    proceduralMemories?: ProceduralMemory[];
    globalStats?: MemoryStore['globalStats'];
    tenants?: TenantConfig[];
  };
}
/** 冲突合并策略 */
type MergeStrategy = 'overwrite' | 'merge' | 'skip' | 'newer-wins';
/** 迁移冲突记录（保留双方数据供审计） */
interface MigrationConflict {
  type: 'pattern' | 'model-profile' | 'feedback' | 'semantic' | 'procedural';
  key: string;
  localVersion: MigrationRecordVersion;
  remoteVersion: MigrationRecordVersion;
  resolution?: MergeStrategy;
}
/** 迁移结果报告 */
interface MigrationReport {
  success: boolean;
  strategy: MergeStrategy;
  imported: {
    patterns: number;
    modelProfiles: number;
    feedback: number;
    semantic: number;
    procedural: number;
  };
  skipped: number;
  conflicts: MigrationConflict[];
  errors: string[];
  duration: number;
}
/** 导出选项 */
interface ExportOptions {
  includePatterns?: boolean;
  includeModelProfiles?: boolean;
  includeFeedback?: boolean;
  includeSemanticMemories?: boolean;
  includeProceduralMemories?: boolean;
  includeGlobalStats?: boolean;
  tenantFilter?: string[];
  instanceName?: string;
}
/**
 * 记忆迁移工具
 *
 * 被 index.ts 的 memory_migration Tool 调用（export/import/dry-run/migrate-tenant）。
 */
declare class MigrationTool {
  private instanceId;
  /**
   * @param instanceId 当前实例标识（写入迁移包 source），缺省自动生成
   */
  constructor(instanceId?: string);
  /**
   * 从记忆库实例导出迁移包
   * @param memory 源记忆库
   * @param options 导出范围选项（缺省全量导出）
   */
  exportFromMemory(memory: LongTermMemory, options?: ExportOptions): MigrationPackage;
  /**
   * 从磁盘文件读取迁移包（含校验和验证）
   * @param filePath 迁移包文件路径
   * @throws MemoryError 文件不存在 / JSON 非法 / 校验和不匹配
   */
  exportFromFile(filePath: string): MigrationPackage;
  /**
   * 导出迁移包并写入文件
   * @param memory 源记忆库
   * @param outputPath 输出路径
   * @param options 导出范围选项
   */
  exportToFile(memory: LongTermMemory, outputPath: string, options?: ExportOptions): void;
  /**
   * 将迁移包导入目标记忆库
   * @param memory 目标记忆库
   * @param pkg 迁移包
   * @param strategy 冲突合并策略，默认 merge
   */
  importToMemory(memory: LongTermMemory, pkg: MigrationPackage, strategy?: MergeStrategy): MigrationReport;
  /**
   * 从文件读取迁移包并导入
   * @param memory 目标记忆库
   * @param filePath 迁移包文件路径
   * @param strategy 冲突合并策略，默认 merge
   */
  importFromFile(memory: LongTermMemory, filePath: string, strategy?: MergeStrategy): MigrationReport;
  /**
   * 预演导入：检测冲突与统计，不产生任何写入
   * @param memory 目标记忆库
   * @param pkg 迁移包
   */
  dryRun(memory: LongTermMemory, pkg: MigrationPackage): {
    conflicts: MigrationConflict[];
    summary: Record<string, number>;
  };
  /**
   * 跨租户迁移：源记忆库 → 目标记忆库
   * @param sourceMemory 源租户记忆库
   * @param targetMemory 目标租户记忆库
   * @param options 迁移选项（范围 + 策略）
   */
  migrateBetweenTenants(sourceMemory: LongTermMemory, targetMemory: LongTermMemory, options?: ExportOptions & {
    strategy?: MergeStrategy;
  }): MigrationReport;
  /** 构建带校验和的迁移包 */
  private buildPackage;
  /** 计算 data 段的 SHA-256（深度键序规范化序列化，与键序无关） */
  private computeChecksum;
  /** 递归按键名排序的规范化 JSON 序列化（保证任意嵌套层级的确定性） */
  private canonicalStringify;
  /** 校验迁移包完整性 */
  private verifyChecksum;
  /**
   * 任务模式冲突仲裁
   * @returns 胜出者；skip 策略返回 null 表示保留本地
   */
  private resolvePatternConflict;
  /** 深度合并两个任务模式：方案并集 + 记录并集 + 统计重算 */
  private mergePatterns;
  /**
   * 模型画像冲突仲裁
   * @returns 胜出者；skip 策略返回 null 表示保留本地
   */
  private resolveProfileConflict;
  /** 深度合并两个模型画像：taskHistory 按任务类型累加 */
  private mergeProfiles;
  /**
   * 语义记忆冲突仲裁（4.0 补全）
   *
   * merge 不做二选一：交给记忆库 upsert 的证据合并语义（同 id 覆盖时
   * 继承既有 evidence 与应用反馈统计；同 statement 时支撑累加合并）。
   * newer-wins 按 max(distilledAt, lastAppliedAt) 仲裁。
   * @returns 胜出者；skip 策略返回 null 表示保留本地
   */
  private resolveSemanticConflict;
  /**
   * 程序记忆冲突仲裁（4.0 补全；语义同 resolveSemanticConflict）
   * @returns 胜出者；skip 策略返回 null 表示保留本地
   */
  private resolveProceduralConflict;
}
//#endregion
//#region src/symbiosis/ledger.d.ts
/**
 * ledger.ts — 认知能量账本（共生进化架构第五阶段 1/4）
 *
 * 质变设计（相对"agent.energy 公开字段"草案的三重升级）：
 *
 * 1. 能量不可伪造：智能体没有 energy 字段，能量只存在于账本账户中，
 *    只能经 transfer/mint/burn 流转；每笔流转双方平衡（复式记账），
 *    全局守恒律恒成立：Σ(所有账户余额) === initialSupply + minted。
 *
 * 2. 链式哈希审计：每笔转账携带 sha256 链哈希（前序哈希 + 本笔内容），
 *    任何对历史凭证的篡改都会导致 verifyChain() 失败——能量流向可审计、
 *    可回放、不可抵赖。这是"玩具模拟"与"经济系统"的分水岭。
 *
 * 3. 生态健康可观测：giniCoefficient() 度量能量分布集中度——
 *    能量过度集中 = 垄断 = 认知生态死亡信号（单一智能体买断全部资源，
 *    多样性消失，进化停滞）。监管层可据此调节铸币与救济策略。
 *
 * 账户语义：
 * - treasury：央行国库（初始供给 + 任务成功铸币收入池），仅 runtime 持有账本引用
 * - burn（INCINERATOR）：燃烧池，burn 的能量退出流通但保留审计痕迹
 * - escrow：行动预扣托管（提案批准 → 预扣；执行完毕 → 燃烧/退还）
 *
 * 权限模型（Phase 1）：EnergyLedger 实例仅由 SymbiosisRuntime / CognitiveMarket
 * 持有；智能体只拿到只读快照（Perception.ownBalance），无法绕过市场直接转账。
 */
/** 账户 id（智能体 id / 内部账户） */
type AccountId = string;
/** 央行国库：初始供给与铸币收入池 */
declare const TREASURY: AccountId;
/** 燃烧池：burn 的能量退出流通（余额保留供审计） */
declare const INCINERATOR: AccountId;
/** 行动预扣托管账户 */
declare const ESCROW: AccountId;
/** 单笔能量流转凭证（复式记账：from 失去 = to 得到，恒等） */
interface EnergyTransfer {
  seq: number;
  from: AccountId;
  to: AccountId;
  amount: number;
  reason: string;
  /** 关联对象（资产 id / 提案 id / 交易 seq 等） */
  refId?: string;
  timestamp: number;
  /** 链式哈希：sha256(prevHash + 本笔内容) */
  hash: string;
}
type TransferError = 'non-positive-amount' | 'unknown-account' | 'insufficient-funds' | 'frozen-account' | 'self-transfer';
interface TransferReceipt {
  ok: boolean;
  error?: TransferError;
  transfer?: EnergyTransfer;
}
interface LedgerConfig {
  /** 央行初始供给（默认 10000） */
  initialSupply?: number;
  /** 凭证日志上限（默认 2000，超出滑出最旧） */
  journalLimit?: number;
}
interface LedgerStats {
  /** 守恒总供给 = initialSupply + minted */
  totalSupply: number;
  /** 流通供给（总供给 - 燃烧池余额） */
  circulatingSupply: number;
  minted: number;
  burned: number;
  transfers: number;
  accounts: number;
  frozenAccounts: number;
  /** 能量分布基尼系数（默认不含 treasury/内部账户） */
  gini: number;
  chainHead: string;
  chainIntact: boolean;
}
/** 账本可持久化快照（同时服务测试篡改注入） */
interface LedgerSnapshot {
  balances: Array<[AccountId, number]>;
  frozen: AccountId[];
  journal: EnergyTransfer[];
  seqCounter: number;
  minted: number;
  initialSupply: number;
  /** 链锚点（journalLimit 裁剪后与创世哈希解耦；旧快照缺省回退 GENESIS） */
  chainAnchor?: string;
}
declare class EnergyLedger {
  private balances;
  private frozen;
  private journal;
  private chainHead;
  /** 链锚点：被裁剪的最后一条凭证哈希（verifyChain 由此起验） */
  private chainAnchor;
  private seqCounter;
  private mintedTotal;
  private readonly initialSupply;
  private readonly journalLimit;
  constructor(config?: LedgerConfig);
  /** 开户（零余额；初始注资由调用方经 treasury transfer 完成） */
  openAccount(id: AccountId): boolean;
  hasAccount(id: AccountId): boolean;
  balance(id: AccountId): number;
  isFrozen(id: AccountId): boolean;
  freeze(id: AccountId): void;
  unfreeze(id: AccountId): void;
  /** 原子转账：余额不足/冻结/非法金额全部拒绝，拒绝时状态零变更 */
  transfer(from: AccountId, to: AccountId, amount: number, reason: string, refId?: string): TransferReceipt;
  /** 央行铸币：向 to 增发能量（对应真实价值注入：任务成功/知识生效）。
   *  仅 runtime 持有账本引用时调用；破坏守恒律的唯一入口且被显式记账。 */
  mint(to: AccountId, amount: number, reason: string, refId?: string): TransferReceipt;
  /** 燃烧：能量转入燃烧池退出流通（余额保留供审计与守恒校验） */
  burn(from: AccountId, amount: number, reason: string, refId?: string): TransferReceipt;
  /** 已燃烧总量 */
  burned(): number;
  /** 央行铸币总量 */
  minted(): number;
  /** 守恒总供给 = initialSupply + minted */
  totalSupply(): number;
  /** 流通供给 = 总供给 - 燃烧池余额 - 托管余额 */
  circulatingSupply(): number;
  /**
   * 基尼系数（0 完全平等 → 1 完全垄断）。
   * 默认只统计智能体账户（排除 treasury/burn/escrow 内部账户）——
   * 内部账户是基础设施而非生态成员，计入会稀释真实集中度信号。
   * 零余额账户**保留**在统计内：这是基尼系数的标准口径（零收入人口
   * 计入分母）——饿死归零 / 尚未入场的智能体都是生态成员，「很多
   * 零余额者」本身就是分布的事实而非统计噪声，剔除会系统性低估
   * 集中度（[100,0] 标准值 0.5，剔除后虚降为 0）
   */
  giniCoefficient(includeInternal?: boolean): number;
  /** 最近 limit 条凭证（拷贝，外部修改不影响账本） */
  audit(limit?: number): EnergyTransfer[];
  /** 守恒律校验：Σ(所有账户余额) === initialSupply + minted */
  verifyConservation(): boolean;
  /** 链完整性校验：重算全链哈希，任何历史篡改即刻暴露 */
  verifyChain(): boolean;
  stats(): LedgerStats;
  /** 导出快照（持久化 / 测试篡改注入用） */
  snapshotState(): LedgerSnapshot;
  /** 导入快照（原子整体替换） */
  restoreState(snap: LedgerSnapshot): void;
  private appendEntry;
}
//#endregion
//#region src/symbiosis/belief.d.ts
/** 信念流动性池账户（收集买单成本、支付结算赔付） */
declare const BELIEF_POOL: AccountId;
type BeliefOutcome = 'YES' | 'NO';
type BeliefStatus = 'open' | 'settled' | 'cancelled';
/** 信念资产：一条可机器核验的未来断言 */
interface BeliefAsset {
  id: string;
  /** 人类可读断言 */
  claim: string;
  /** 结算主体键（运行时信号表的键，如 'task.successRate' / 'evolution:agent-x:3'） */
  subject: string;
  /** 断言阈值：到期 realized > threshold 判 YES */
  threshold: number;
  /** 结算心跳轮（<= 该轮时由运行时结算） */
  settleAtTick: number;
  creator: AccountId;
  /** LMSR 流动性参数 b（越大价格越稳、做市最坏补贴 b·ln2 越大） */
  liquidityB: number;
  /** 流通 YES 份额 */
  yesShares: number;
  /** 流通 NO 份额 */
  noShares: number;
  status: BeliefStatus;
  /** 结算结果（true = YES 兑付） */
  outcome?: boolean;
  /** 结算时的实测值 */
  realizedValue?: number;
  /** 累计净流入成本（= 池内该资产储备） */
  volume: number;
  createdAt: number;
}
/** 感知用脱敏视图（含当前隐含概率） */
interface BeliefView {
  assetId: string;
  claim: string;
  subject: string;
  threshold: number;
  settleAtTick: number;
  /** 市场隐含 YES 概率 = 当前价格 */
  impliedProbYes: number;
  yesShares: number;
  noShares: number;
  volume: number;
  status: BeliefStatus;
}
/** 智能体持仓（审计可查） */
interface BeliefPosition {
  agentId: string;
  assetId: string;
  yesShares: number;
  noShares: number;
  /** 累计净支出（取消退款的精确基数） */
  netPaid: number;
}
interface BetReceipt {
  ok: boolean;
  error?: string;
  /** 买入 = 成本（正）；卖出 = 退款（负） */
  cost?: number;
  shares?: number;
  priceAfter?: number;
}
interface SettlementReport {
  assetId: string;
  /** true = YES 兑付 */
  outcome: boolean;
  realized: number;
  payouts: Array<{
    agentId: string;
    amount: number;
  }>;
  /** 国库有界补贴（最坏 b·ln2 口径内） */
  subsidyFromTreasury: number;
  /** 池盈余扫回国库 */
  sweptToTreasury: number;
}
interface CancelReport {
  assetId: string;
  refunds: Array<{
    agentId: string;
    amount: number;
  }>;
  /** 池余额不足等原因退款失败的持仓（审计可查：谁的钱没退成、应退多少） */
  failedRefunds?: Array<{
    agentId: string;
    requested: number;
  }>;
}
interface BeliefMarketConfig {
  /** 默认流动性参数 b（缺省 10） */
  defaultB?: number;
}
/**
 * 信念市场：LMSR 做市的二元断言交易场所。
 *
 * 权限模型：仅 SymbiosisRuntime 持有实例；智能体经感知视图（BeliefView）
 * 只读价格，经 bet-belief 提案由运行时代为成交。
 */
declare class BeliefMarket {
  private readonly ledger;
  private assets;
  private positions;
  private readonly defaultB;
  constructor(ledger: EnergyLedger, config?: BeliefMarketConfig);
  /** 上市新信念（创建即开放交易；国库隐性承担做市补贴义务） */
  create(input: {
    claim: string;
    subject: string;
    threshold: number;
    settleAtTick: number;
    creator: AccountId;
    liquidityB?: number;
  }): {
    ok: boolean;
    error?: string;
    assetId?: string;
  };
  /** 隐含 YES 概率（当前价格） */
  price(assetId: string): number | undefined;
  view(assetId: string): BeliefView | undefined;
  views(): BeliefView[];
  /** 持仓查询（审计/测试用，拷贝） */
  positionOf(agentId: string, assetId: string): BeliefPosition | undefined;
  /**
   * 精确份额买入：成本 = C(q+Δ) − C(q)（LMSR 定价）。
   * 能量 agent → belief-pool。
   */
  buyShares(agentId: AccountId, assetId: string, outcome: BeliefOutcome, shares: number): BetReceipt;
  /**
   * 卖回做市商（结算前平仓）：退款 = C(q) − C(q−Δ)。
   * LMSR 成本函数路径无关 → 买卖往返净成本恒为 0（零摩擦）。
   */
  sellShares(agentId: AccountId, assetId: string, outcome: BeliefOutcome, shares: number): BetReceipt;
  /**
   * 目标价格买入：把市场价格推到自己的真实估计（激励相容动作）。
   * 份额 = 使 implied = target 所需；预算封顶（不足时二分收缩）。
   * @param targetProb 该结果方向的估计概率 ∈ (0.01, 0.99)
   */
  buyToPrice(agentId: AccountId, assetId: string, outcome: BeliefOutcome, targetProb: number, budget: number): BetReceipt;
  /**
   * 结算：realized > threshold → YES 兑付。
   * 每份命中份额支付 1 能量（scoring 结算）；池缺口国库有界补贴，盈余扫回。
   *
   * 浮点鲁棒性：补贴额加 1e-6 余量对冲 ulp 舍入差（「缺口恰好补齐」在
   * 浮点回加后仍可能差 1e-7，导致赔付/清扫转账静默失败、赢家拿不到钱）；
   * 赔付与清扫均钳制到池实际余额——共享池 + 舍入路径差异下永不透支。
   */
  settle(assetId: string, realized: number): SettlementReport | undefined;
  /** 取消：全额退还净支出（不可结算的悬空信念，如信号永缺失） */
  cancel(assetId: string): CancelReport | undefined;
  /** 池余额（审计用；全部结算/取消后应回到 0） */
  poolBalance(): number;
  snapshot(): {
    open: number;
    settled: number;
    cancelled: number;
    volume: number;
    poolBalance: number;
  };
  private updatePosition;
  private toView;
}
//#endregion
//#region src/symbiosis/agent.d.ts
/** 智能体种类（对应认知生态中的角色） */
type AgentKind = 'memory' | 'reflector' | 'optimizer' | 'evolver' | 'curiosity' | 'world-model' | 'model';
/** 运行模式：活跃 / 饥饿休眠 */
type AgentMode = 'active' | 'dormant';
/** 信誉等级：由证据统计自动晋级，不可自封 */
type ReputationTier = 'seed' | 'established' | 'elite';
/** 结构化目标（可机器观测，而非自由文本口号） */
interface AgentGoal {
  /** 目标陈述（人类可读） */
  objective: string;
  /** 关联的可观测指标名（供心智报告/元认知层归因） */
  metrics: string[];
  /** 能量生存线：低于此值进入休眠 */
  survivalThreshold: number;
}
/** 证据化信誉视图（Wilson 口径，与全层统计语言一致） */
interface AgentReputation {
  tier: ReputationTier;
  /** 有效样本量（时间衰减后） */
  effectiveSamples: number;
  /** Beta 后验均值 */
  posteriorMean: number;
  /** Wilson 95% 置信下界 —— 分红权重与市场定价可信度的统一度量 */
  wilsonLower: number;
  /** 累计收入（能量） */
  earnings: number;
  /** 累计支出（能量） */
  spend: number;
  /** 净流入 */
  netFlow: number;
}
/** 市场行情快照（智能体感知的一部分） */
interface MarketSnapshot {
  listed: number;
  openBids: number;
  trades: number;
  /** 累计成交额（能量） */
  volume: number;
  /** 最近成交均价 */
  lastPrice: number;
}
/** 市场挂单脱敏视图（买方决策依据；不暴露底层知识本体） */
interface ListingView {
  assetId: string;
  kind: string;
  seller: string;
  ask: number;
  /** 卖方申报质量（成交后由实测证据校准） */
  claimedQuality: number;
  /** 历史成交次数 */
  sales: number;
}
/** 感知：运行时每轮心跳分发的世界状态切片 */
interface Perception {
  tick: number;
  timestamp: number;
  /** 自身账户余额（只读快照） */
  ownBalance: number;
  /** 自身信誉视图 */
  reputation: AgentReputation;
  /** 市场行情 */
  market: MarketSnapshot;
  /** 市场挂单列表（脱敏） */
  listings: ReadonlyArray<ListingView>;
  /** 信念市场开放资产视图（隐含概率 = 系统对该断言的市场定价；Phase 2） */
  beliefs?: ReadonlyArray<BeliefView>;
  /** 系统信号（成功率/质量/负载等数值观测，键由宿主定义） */
  signals: Readonly<Record<string, number>>;
}
type ProposalKind = 'list-knowledge' | 'buy-knowledge' | 'maintenance' | 'evolution' | 'exploration' | 'bet-belief' | 'idle';
/** 智能体提案：意图 + 出价。运行时/市场/监管批准后才生效 */
interface AgentProposal {
  id: string;
  kind: ProposalKind;
  description: string;
  /** 行动类=愿意支付的能量；list-knowledge=要价；bet-belief=下注预算上限 */
  bid: number;
  /** 关联知识引用（记忆指纹 / 策略 id / 市场 assetId / 信念 assetId） */
  assetRef?: string;
  /** 挂卖时的申报质量（0~1，成交后由使用证据校准） */
  claimedQuality?: number;
  /** 挂卖/购买的资产种类（pattern/semantic/procedural/strategy/policy-gene 等） */
  assetKind?: string;
  /** bet-belief：下注方向 */
  outcome?: 'YES' | 'NO';
  /** bet-belief：自己对该方向的估计概率（把市场价格推到此值，激励相容动作） */
  targetPrice?: number;
  /** 提案有效期（心跳轮数，缺省 1） */
  ttlTicks?: number;
}
/** 执行授权：能量已预扣托管，智能体据此执行被批准的行动 */
interface ExecutionGrant {
  agentId: string;
  proposal: AgentProposal;
  /** 已托管（escrow）的能量预算 */
  budget: number;
  approvedAt: number;
}
/** 行动结果 */
interface ActionResult {
  success: boolean;
  /** 申报价值估计（0~1，供分红与信誉观测参考） */
  valueEstimate: number;
  summary: string;
  data?: unknown;
}
/**
 * 智能体契约（共生层第五阶段契约；稳定后可提升至 contracts.ts）。
 *
 * 实现方约束：
 * - propose() 必须为同步纯决策（基于最近一次 perceive 的快照），不得有副作用；
 * - execute() 只在收到 ExecutionGrant 后被调用，重操作全部放在这里；
 * - 不得缓存 Ledger/Market 引用（构造注入仅限只读回调）。
 */
interface IAgent {
  readonly id: string;
  readonly kind: AgentKind;
  goal(): AgentGoal;
  mode(): AgentMode;
  reputation(): AgentReputation;
  perceive(p: Perception): void;
  propose(): AgentProposal[];
  execute(grant: ExecutionGrant): Promise<ActionResult>;
}
/** 可选成交回调：买方智能体实现 notePurchase 时，运行时在成交后自动通知（已购去重的数据来源） */
interface TradeListener {
  notePurchase(assetId: string, refId: string, price: number): void;
}
/** 结构化能力检测（IAgent 可选能力，非破坏性扩展） */
declare function isTradeListener(agent: IAgent): agent is IAgent & TradeListener;
/**
 * 运行时托管钩子（AgentBase 统一提供，自定义智能体请继承 AgentBase）：
 * 模式切换 / 贡献观测 / 收支记账均由运行时驱动——智能体自身无法
 * 自增能量、自切模式，能量与信誉的唯一合法来源在宿主侧。
 */
interface ManagedAgent extends IAgent {
  setMode(mode: AgentMode): void;
  recordContribution(success: boolean, now?: number): void;
  noteEarnings(amount: number): void;
  noteSpend(amount: number): void;
}
/**
 * 智能体基座：证据化信誉 + 收支记账 + 模式切换的共享实现。
 * 子类只需实现 goal/propose/execute（perceive 默认存快照）。
 */
declare abstract class AgentBase implements IAgent {
  readonly id: string;
  abstract readonly kind: AgentKind;
  protected lastPerception: Perception | undefined;
  private modeFlag;
  private readonly evidence;
  private earningsTotal;
  private spendTotal;
  private proposalCounter;
  constructor(id: string, createdAt?: number);
  abstract goal(): AgentGoal;
  perceive(p: Perception): void;
  /** 默认空转提案（子类按角色覆写） */
  propose(): AgentProposal[];
  /** 默认 no-op 执行（市场类提案无需 execute，由运行时直接撮合） */
  execute(grant: ExecutionGrant): Promise<ActionResult>;
  mode(): AgentMode;
  /** 模式切换由运行时驱动（休眠/复活），智能体自身只读 */
  setMode(mode: AgentMode): void;
  /** 贡献观测（由运行时在任务结算时回调）——信誉的唯一来源 */
  recordContribution(success: boolean, now?: number): void;
  reputation(now?: number): AgentReputation;
  /** 收入记账（由运行时经账本/市场回调，智能体不可自增） */
  noteEarnings(amount: number): void;
  /** 支出记账 */
  noteSpend(amount: number): void;
  /** 提案 id 生成（id 稳定可追溯） */
  protected proposal(kind: ProposalKind, description: string, bid: number, extra?: Partial<AgentProposal>): AgentProposal;
}
//#endregion
//#region src/symbiosis/market.d.ts
/** 知识资产种类 */
type AssetKind = 'pattern' | 'semantic' | 'procedural' | 'strategy' | 'policy-gene' | 'model-profile';
/** 挂单中的知识资产（引用底层知识本体，不复制数据） */
interface KnowledgeAsset {
  id: string;
  kind: AssetKind;
  seller: AccountId;
  /** 底层知识引用（记忆指纹 / 策略 id 等） */
  refId: string;
  description: string;
  /** 要价（能量） */
  ask: number;
  /** 卖方申报质量（0~1，成交后由使用证据校准） */
  claimedQuality: number;
  /** 售后分成比例（相对最近成交价） */
  royaltyRate: number;
  listedAt: number;
  /** 成交次数 */
  sales: number;
  /** 最近成交价（分成基数） */
  lastPrice: number;
  /** 资产级使用证据 */
  evidence: MemoryEvidence;
}
/** 买单 */
interface BidOrder {
  id: string;
  bidder: AccountId;
  assetId: string;
  price: number;
  placedAt: number;
}
/** 成交记录 */
interface TradeRecord {
  seq: number;
  assetId: string;
  assetKind: AssetKind;
  buyer: AccountId;
  seller: AccountId;
  price: number;
  timestamp: number;
}
/** 售后分成支付凭证 */
interface RoyaltyPayout {
  assetId: string;
  seller: AccountId;
  amount: number;
  /** 有效使用次数（累计） */
  confirmedUses: number;
}
interface MarketConfig {
  /** 挂单费率（相对 ask，燃烧；默认 0.1） */
  listingFeeRate?: number;
  /** 默认售后分成比例（默认 0.2） */
  defaultRoyaltyRate?: number;
  /** 最大同时挂单数（默认 64） */
  maxAssets?: number;
}
type ListError = 'non-positive-ask' | 'duplicate-ref' | 'market-full' | 'listing-fee-unaffordable' | 'insufficient-quality';
declare class CognitiveMarket {
  private readonly ledger;
  private assets;
  private bidsByAsset;
  private trades;
  private volumeTraded;
  private readonly listingFeeRate;
  private readonly defaultRoyaltyRate;
  private readonly maxAssets;
  constructor(ledger: EnergyLedger, config?: MarketConfig);
  /** 挂单要价：立即燃烧挂单费（防垃圾信息），同 refId 去重 */
  list(input: {
    seller: AccountId;
    kind: AssetKind;
    refId: string;
    description: string;
    ask: number;
    claimedQuality: number;
    royaltyRate?: number;
  }): {
    ok: boolean;
    error?: ListError;
    assetId?: string;
    listingFee?: number;
  };
  /** 出价买单（竞价；撮合时取最高价） */
  placeBid(bidder: AccountId, assetId: string, price: number): {
    ok: boolean;
    error?: string;
  };
  /** 卖家下架（无费用；已付挂单费不退——信息发布成本已发生） */
  delist(seller: AccountId, assetId: string): boolean;
  /**
   * 撮合：对每个资产取最高出价，price >= ask 则成交。
   * 能量 buyer → seller；成交后该资产买单清空。
   */
  match(): TradeRecord[];
  /**
   * 使用反馈（由运行时在任务结算自动回填，买卖双方无法操纵）：
   * - 观测资产级证据（申报质量的实测校准来源）；
   * - 有效使用 → 央行向卖方支付售后分成（激励相容：买方零成本报告）。
   */
  reportUsage(assetId: string, success: boolean, now?: number): RoyaltyPayout | undefined;
  getAsset(assetId: string): KnowledgeAsset | undefined;
  listAssets(): KnowledgeAsset[];
  openBidCount(): number;
  tradesLog(limit?: number): TradeRecord[];
  /** 智能体感知用的脱敏挂单视图 */
  listingViews(): ListingView[];
  snapshot(): MarketSnapshot;
  /** 资产证据视图（监管/审计用） */
  assetEvidence(assetId: string, now?: number): {
    weightedSuccesses: number;
    weightedFailures: number;
    effectiveSamples: number;
    posteriorMean: number;
    wilsonLower: number;
    claimedQuality: number;
  } | undefined;
}
//#endregion
//#region src/symbiosis/runtime.d.ts
/** 只读监管门控（与 SafetyGovernor.checkGate 结构兼容） */
interface GovernanceGate {
  checkGate(): {
    allowed: boolean;
    reason?: string;
    blockedBy?: string;
  };
}
interface SymbiosisConfig {
  /** 央行初始供给（默认 10000） */
  initialSupply?: number;
  /** 智能体开业注资（默认 100，从 treasury 划拨） */
  openingGrant?: number;
  /** 休眠救济金额（默认 30） */
  reliefAmount?: number;
  /** 每智能体救济次数上限（默认 3，防僵尸吸血） */
  reliefQuota?: number;
  /** 任务成功的铸币分红总额（默认 40） */
  incomePerSuccess?: number;
  /** 行动失败退还比例（默认 0.5） */
  failureRefundRate?: number;
  /** 心跳系统信号采集器（接入宿主 KPI） */
  tickSignals?: () => Record<string, number>;
  /** ── Phase 2：信念市场（市场即心智）── */
  /** 信念市场流动性参数 b（默认 10；越大价格越稳、国库做市补贴上界 b·ln2 越大） */
  beliefLiquidityB?: number;
  /** 信念到期后信号仍缺失的宽限轮数（默认 2，超出取消退款） */
  beliefGraceTicks?: number;
  /** 元认知对账背离阈值（|市场价 − 统计估计| 超过才告警，默认 0.15） */
  divergenceMargin?: number;
  /** futarchy：高成本行动（进化）是否由信念市场资助表决（默认 false，保持既有行为） */
  futarchyEnabled?: boolean;
  /** futarchy：资助门槛（隐含成功概率下限，默认 0.55） */
  futarchyMinImpliedProb?: number;
  /** futarchy：决策资产流动性 b（默认 6，轻流动性让小额信念快速定价） */
  futarchyDecisionB?: number;
  /** ── 5.0：因果内核（do-干预登记 + Shapley 反事实分红）── */
  /** 因果内核实例（挂载后任务结算自动登记 do-干预、分红改用 Shapley 边际贡献） */
  causalKernel?: CausalKernel;
  /** 因果图的结果节点名（默认 'task.outcome'） */
  causalOutcomeNode?: string;
  /** ── 6.0：主动推断内核（期望自由能行动排序 + 变分漂移监测）── */
  /** 自由能引擎实例（挂载后心跳产出变分自由能、行动提案可按 EFE 排序） */
  freeEnergy?: FreeEnergyEngine;
  /**
   * ── 10.0：科学家内核（热点自动登记问题空间）──
   * 挂载后任务结算的 do-干预边 (贡献者 → task.outcome) 自动进入
   * 科学家问题空间——调度器每刻意选型一次，就为「选用 X 是否导致
   * 成功」这个因果问题积累一次 EIG 实验设计机会（幂等，零漂移）。
   */
  scientist?: ScientistMind;
  /** ── 7.0：深思内核（多步行动提案按轨迹自由能排序）── */
  /** 深思内核实例（挂载后多步计划提案可按想象推演的轨迹 G 排序） */
  deliberation?: DeliberationEngine;
}
interface GrantOutcome {
  agentId: string;
  proposalId: string;
  kind: ProposalKind;
  success: boolean;
  burned: number;
  refunded: number;
  valueEstimate: number;
  summary: string;
}
interface SymbiosisTickReport {
  tick: number;
  timestamp: number;
  activeAgents: string[];
  dormantAgents: string[];
  reliefs: Array<{
    agentId: string;
    amount: number;
  }>;
  proposals: Array<{
    agentId: string;
    kind: ProposalKind;
    bid: number;
  }>;
  vetoes: Array<{
    agentId: string;
    kind: ProposalKind;
    reason: string;
  }>;
  trades: number;
  grants: GrantOutcome[];
  mintedThisTick: number;
  burnedThisTick: number;
  gini: number;
  conservationIntact: boolean;
  market: MarketSnapshot;
  /** ── Phase 2：信念市场 ── */
  /** 本轮成交的信念下注（价格即信念） */
  beliefBets: Array<{
    agentId: string;
    assetId: string;
    outcome: 'YES' | 'NO';
    cost: number;
    priceAfter: number;
  }>;
  /** 本轮到期结算 / 宽限超时取消的信念 */
  beliefSettlements: Array<{
    assetId: string;
    mode: 'settled' | 'cancelled';
    outcome?: boolean;
    realized?: number;
    paidOut: number;
    subsidy: number;
    swept: number;
    refunded: number;
  }>;
  /** futarchy 决议：市场资助 / 市场否决 / 监管一票否决 */
  futarchyDecisions: Array<{
    agentId: string;
    proposalId: string;
    impliedProb: number;
    decision: 'funded' | 'market-rejected' | 'governor-vetoed';
    actionSuccess?: boolean;
  }>;
  /** 元认知对账：市场价 vs 被动统计估计的显著背离（模型漂移信号） */
  divergence: Array<{
    assetId: string;
    subject: string;
    marketProb: number;
    statEstimate: number;
    gap: number;
  }>;
  /** 6.0：变分自由能（信念市场价 vs 因果后验的 KL 总和；漂移的信息论度量） */
  variationalFreeEnergy?: {
    total: number;
    driftDetected: boolean;
    worst?: {
      id: string;
      kl: number;
    };
  };
}
interface DistributionReport {
  totalDistributed: number;
  shares: Array<{
    agentId: string;
    weight: number;
    amount: number;
  }>;
  /** ── 5.0：Shapley 反事实分红明细（挂载因果内核时启用）── */
  method?: 'linear-wilson' | 'shapley-counterfactual';
  /** 各贡献者的 Shapley 边际贡献值（拔掉该智能体任务成功率掉多少） */
  shapley?: Array<{
    agentId: string;
    shapleyValue: number;
    counterfactualProb: number;
  }>;
}
declare class SymbiosisRuntime {
  readonly ledger: EnergyLedger;
  readonly market: CognitiveMarket;
  readonly beliefMarket: BeliefMarket;
  private agents;
  private agentIds;
  private reliefUsed;
  private tickCount;
  /** futarchy 待决议行动（提案轮创建决策资产 → 下一轮市场表决 → 执行/否决） */
  private pendingDecisions;
  private readonly config;
  private readonly tickSignals?;
  private readonly governor?;
  /** 5.0：因果内核（可选挂载；缺省保持既有线性分红，零行为漂移） */
  private readonly causalKernel?;
  private readonly causalOutcomeNode;
  /** 6.0：自由能引擎（可选挂载；缺省心跳不产变分项，零漂移） */
  private readonly freeEnergy?;
  /** 10.0：科学家内核（可选挂载；缺省结算不登记问题，零漂移） */
  private readonly scientist?;
  /** 7.0：深思内核（可选挂载；缺省多步提案排序不可用，零漂移） */
  private readonly deliberation?;
  constructor(config?: SymbiosisConfig, governor?: GovernanceGate);
  /** 注册智能体：开户 + 央行开业注资（继承 AgentBase 即满足托管契约） */
  register(agent: ManagedAgent): boolean;
  /**
   * 单轮心跳：生态一轮完整的生存-感知-决策-交易-行动循环。
   * @param signals 心跳系统信号（同时是信念结算的 realized 值来源）
   * @param opts.externalEstimates 宿主被动统计估计（元认知对账用，键 = 信念 subject）
   */
  tick(signals?: Record<string, number>, opts?: {
    externalEstimates?: Record<string, number>;
  }): Promise<SymbiosisTickReport>;
  /**
   * 6.0：EFE 行动排序——把候选行动按期望自由能从低到高排序。
   *
   * 排序依据 G(a) = 务实价值 − 认知价值：
   * 既预测能达成目标的动作优先，同时高不确定性的动作获得认知价值
   * 折抵（探索不再是外挂加成，而是同一目标函数的另一半）。
   *
   * 消费方：宿主在多个行动提案间分配注意力/预算时调用；
   * 返回逐动作分解（多少因为有用 / 多少因为想弄清），可解释可审计。
   */
  efeRankActions(actions: Array<{
    id: string;
    outcomeNode?: string;
  }>, preference?: number): EFEEvaluation[];
  /**
   * 7.0：EFE 多步计划排序——把候选**行动序列**（计划）按想象推演的
   * 轨迹自由能从低到高排序。
   *
   * 与 efeRankActions 的本质区别：那是单步 bandit（每个行动独立评分），
   * 这是轨迹评估——第 1 步的代价可以被第 2 步的收获补偿（γ 折扣），
   * 序列中同一条边重访时认知价值坍缩（排练过的路不再有信息量）。
   * 智能体提出多步方案（如「先实验后上线」）时按全程 G 分配注意力。
   */
  efeRankPlans(plans: Array<{
    id: string;
    startState: string;
    actions: string[];
  }>, preference?: number): Array<{
    id: string;
    totalEfe: number;
    pAllSuccess: number;
    undiscountedEfe: number;
    epistemicMonotone: boolean;
    worstStep: number;
  }>;
  /** 结算信念并把赔付记入智能体收入账（能量经账本，记账经宿主钩子） */
  private settleBelief;
  /** 取消信念退款（悬空断言的零损失退出） */
  private cancelBelief;
  /**
   * 任务结算：成功 → 央行铸币分红。
   *
   * 5.0 质变（挂载因果内核后）：
   * 1. do-干预登记：调度器「刻意选用」某模型/策略 = 天然干预实验
   *    （非被动观测）——每个贡献者的成败都以 do(use:X) → task.outcome
   *    写入因果图，为后续反事实查询与旋钮排序积累黄金证据。
   * 2. Shapley 反事实分红：分红权重从「Wilson 下界的线性份额」升级为
   *    noisy-OR 联盟下的精确 Shapley 值——「拔掉你，任务成功率掉多少，
   *    你就分多少」。挂名不出力的边际贡献 ≈ 0，自然饿死；不可替代的
   *    关键贡献者获得超额回报（真公平的能量经济）。
   *
   * 未挂载内核时保持既有线性 Wilson 分红（零行为漂移）。
   */
  settleTaskOutcome(success: boolean, contributors: Array<{
    agentId: string;
    weight?: number;
  }>): DistributionReport;
  /** 知识使用回报（任务结算时由运行时自动回填，买卖双方不可操纵） */
  reportAssetUsage(assetId: string, success: boolean): void;
  /** 行动类提案执行：预扣 → 执行 → 成功燃烧 / 失败半退 */
  private executeAction;
  /** 生态全景（心智报告/审计用） */
  stats(): {
    tick: number;
    agents: Array<{
      id: string;
      kind: string;
      mode: string;
      balance: number;
      reputation: ReturnType<ManagedAgent['reputation']>;
    }>;
    ledger: ReturnType<EnergyLedger['stats']>;
    market: MarketSnapshot;
    belief: ReturnType<BeliefMarket['snapshot']>;
  };
}
//#endregion
//#region src/symbiosis/wrappers.d.ts
interface MemoryAgentConfig {
  /** 挂卖定价基准（要价 = base × confidence，默认 10） */
  listingBasePrice?: number;
  /** 挂卖门槛：模式置信度（默认 0.5） */
  listingConfidenceThreshold?: number;
  /** 挂卖门槛：出现频次（默认 2，防孤例噪声） */
  listingFrequencyThreshold?: number;
  /** 单轮最多挂卖数（默认 2） */
  maxListedPerTick?: number;
  /** 维护行动成本（默认 2） */
  maintenanceCost?: number;
  /** 维护间隔（心跳轮数，默认 5） */
  maintenanceInterval?: number;
}
/**
 * 记忆智能体：最大化记忆资产价值。
 * 主动行为：挂卖高置信模式（赚取能量 + 售后分成）、周期维护（遗忘曲线）。
 */
declare class MemoryAgent extends AgentBase {
  private readonly memory;
  readonly kind: 'memory';
  private readonly cfg;
  private listedRefs;
  private lastMaintenanceTick;
  constructor(id: string, memory: LongTermMemory, config?: MemoryAgentConfig);
  goal(): AgentGoal;
  propose(): AgentProposal[];
  execute(grant: ExecutionGrant): Promise<ActionResult>;
  /** 已挂卖引用（测试/审计用） */
  listed(): string[];
}
interface OptimizerAgentConfig {
  /** 单次购买预算上限（默认 20） */
  maxBudget?: number;
  /** 保留余额（低于此值不再出价，默认 30） */
  reserveBalance?: number;
  /** 只买申报质量下限（默认 0.55） */
  minClaimedQuality?: number;
  /** 每轮最多出价数（默认 1） */
  maxBidsPerTick?: number;
  /** ── Phase 2：信念市场 ── */
  /** 单条信念下注预算上限（默认 8） */
  beliefBetBudget?: number;
  /** 每轮最多下注信念数（默认 2） */
  maxBeliefBetsPerTick?: number;
}
/**
 * 优化智能体：提高决策收益。
 * 主动行为：观察行情 → 对高性价比知识出价 → 积累已购知识清单；
 * Phase 2：把系统信号的私有判断注入信念市场（成功率信号 → 下注方向）。
 */
declare class OptimizerAgent extends AgentBase {
  private readonly onPurchase?;
  readonly kind: 'optimizer';
  private readonly cfg;
  private purchased;
  private betAssets;
  constructor(id: string, config?: OptimizerAgentConfig, onPurchase?: ((assetId: string, refId: string, price: number) => void) | undefined);
  goal(): AgentGoal;
  propose(): AgentProposal[];
  private betAgents;
  /** 成交通知（由宿主/测试桥接调用；记录已购清单并回调宿主） */
  notePurchase(assetId: string, refId: string, price: number): void;
  purchases(): Array<{
    assetId: string;
    refId: string;
    price: number;
  }>;
}
interface EvolverAgentConfig {
  /** 进化行动成本（默认 50，提案 bid） */
  evolutionCost?: number;
  /** 发起进化的余额门槛（默认 60，留生存余量） */
  evolutionBalanceThreshold?: number;
  /** 策略基因挂卖基准价（默认 15） */
  geneBasePrice?: number;
  /** ── Phase 2：为自己的进化决策自注（私有信息 = 沙盒增益） ── */
  /** 自注预算上限（默认 12） */
  selfBetBudget?: number;
}
/** 进化周期结果（由宿主桥接真实 PolicyEvolver.runEvolutionCycle） */
interface EvolutionCycleOutcome {
  /** 是否产出可部署策略 */
  deployed: boolean;
  /** 沙盒评估收益（gain，可为负） */
  bestGain: number;
  /** 部署策略 id（有则挂卖） */
  policyId?: string;
  /** 人类可读摘要 */
  summary: string;
}
/**
 * 进化智能体：发现突破性策略。
 * 主动行为：能量充足时发起沙盒进化（最贵的行动）；进化产出的策略基因
 * 下一轮挂上市场出售——「进化 → 变现 → 再进化」资本循环。
 */
declare class EvolverAgent extends AgentBase {
  private readonly runCycle?;
  readonly kind: 'evolver';
  private readonly cfg;
  private pendingGeneListing;
  private cyclesRun;
  private deployCount;
  /** 最近一轮沙盒增益（私有信息：自注 futarchy 决策的依据） */
  private lastGain;
  private betAssets;
  constructor(id: string, runCycle?: (() => Promise<EvolutionCycleOutcome>) | undefined, config?: EvolverAgentConfig);
  goal(): AgentGoal;
  propose(): AgentProposal[];
  execute(grant: ExecutionGrant): Promise<ActionResult>;
  stats(): {
    cyclesRun: number;
    deployCount: number;
  };
}
/** 从感知快照提取挂单视图（便捷桥接，供自定义智能体复用） */
declare function listingsOf(p: Perception | undefined): ListingView[];
//#endregion
//#region src/symbiosis/observability.d.ts
/** 渠道分组（着色 + 图例） */
type ChannelGroup = 'distribution' | 'mint' | 'market' | 'belief' | 'action' | 'other';
declare const CHANNEL_GROUPS: Array<{
  group: ChannelGroup;
  label: string;
  color: string;
}>;
/** Sankey 链接：同 (from,to,reason) 聚合 */
interface SankeyLink {
  source: string;
  target: string;
  channel: string;
  channelLabel: string;
  group: ChannelGroup;
  /** 聚合金额 */
  amount: number;
  /** 聚合笔数 */
  count: number;
}
/** Sankey 节点（分层布局：0 铸币源 / 1 国库 / 2 智能体 / 3 池 / 4 燃烧池） */
interface SankeyNode {
  id: string;
  label: string;
  layer: number;
  kind: string;
  /** 当前余额（快照） */
  balance: number;
  /** 窗口内流入总量 */
  inflow: number;
  /** 窗口内流出总量 */
  outflow: number;
}
/** 生态健康快照（HTML 头部指标） */
interface SankeyTotals {
  transfers: number;
  minted: number;
  burned: number;
  totalSupply: number;
  circulatingSupply: number;
  gini: number;
  conservation: boolean;
  chainIntact: boolean;
}
/** Sankey 数据模型（HTML 渲染与 WS 广播共用） */
interface EnergySankeyReport {
  generatedAt: number;
  /** 聚合窗口的凭证序号范围 */
  seqRange: {
    from: number;
    to: number;
  } | null;
  nodes: SankeyNode[];
  links: SankeyLink[];
  /** 渠道汇总（金额降序） */
  channels: Array<{
    channel: string;
    label: string;
    group: ChannelGroup;
    amount: number;
    count: number;
  }>;
  totals: SankeyTotals;
}
/** 智能元信息（节点标注用；缺省按账户 id 展示） */
interface AgentMeta {
  id: string;
  kind?: string;
  label?: string;
}
/**
 * 构建能量 Sankey 数据模型。
 * @param ledger 只读账本（audit 拷贝聚合）
 * @param opts.agents 智能体元信息（kind/label 标注）
 * @param opts.sinceSeq 只聚合 seq > sinceSeq 的凭证（增量窗口；缺省全量）
 */
declare function buildEnergySankey(ledger: EnergyLedger, opts?: {
  agents?: AgentMeta[];
  sinceSeq?: number;
}): EnergySankeyReport;
/**
 * 渲染自包含 HTML 报告（零外部依赖，离线可开）。
 * @param report buildEnergySankey 产物
 * @param opts.title 报告标题（缺省「认知生态能量流 Sankey」）
 */
declare function renderSankeyHtml(report: EnergySankeyReport, opts?: {
  title?: string;
}): string;
//#endregion
//#region src/symbiosis/bridge.d.ts
/** 全局成功率信号键（同时是滚动信念的 subject 与 externalEstimates 的键） */
declare const SIGNAL_GLOBAL_SUCCESS = "task.successRate";
/** 兼容键：wrappers.OptimizerAgent 读取的信号名 */
declare const SIGNAL_GLOBAL_SUCCESS_ALIAS = "taskSuccessRate";
/** 单模型成功率信号键 */
declare function modelSignalKey(modelId: string): string;
/** 模型智能体账户 id */
declare function modelAgentId(modelId: string): string;
/**
 * 模型智能体：宿主 LLM 在认知生态中的化身。
 *
 * 不主动执行任何行动（模型服务本身在宿主操作环）；其经济角色有二：
 * 1. 用「自身近期表现」作为私有信息，在信念市场为自己（及全局指标）
 *    的未来成功率定价——表现好的模型把价格推向乐观，赚结算兑付；
 *    表现差的自然亏损（信息劣势被套利）。
 * 2. 作为任务结算的贡献者，靠成功任务赚取央行铸币分红。
 */
declare class ModelAgent extends AgentBase {
  readonly modelId: string;
  readonly kind: 'model';
  private readonly betBudget;
  private readonly reserveBalance;
  private betAssets;
  constructor(modelId: string, config?: {
    betBudget?: number;
    reserveBalance?: number;
  });
  goal(): {
    objective: string;
    metrics: string[];
    survivalThreshold: number;
  };
  propose(): AgentProposal[];
}
/** 共生融合桥配置 */
interface SymbiosisBridgeConfig {
  /** 是否启用（缺省 false——影子系统，不改变既有主链路行为） */
  enabled?: boolean;
  /** 滚动信念周期（心跳拍数，缺省 3：市场预测 3 拍后的指标） */
  beliefHorizonTicks?: number;
  /** 全局成功率信念阈值（缺省 0.8，与元认知 successRateTarget 对齐） */
  globalSuccessThreshold?: number;
  /** 单模型成功率信念阈值（缺省 0.7） */
  modelSuccessThreshold?: number;
  /** 模型智能体单信念下注预算（缺省 6） */
  modelBetBudget?: number;
  /** 模型智能体保留余额（低于此值+预算不再下注，缺省 10） */
  modelReserveBalance?: number;
  /** 元认知对账背离阈值（缺省 0.15，透传 runtime） */
  divergenceMargin?: number;
  /** 单轮最多产出的漂移洞察数（缺省 3，防告警风暴） */
  maxDriftInsightsPerTick?: number;
  /**
   * A 路线：futarchy 进化表决（缺省关闭）。
   * 启用后须调用 attachEvolver() 绑定真实进化周期；宿主 autonomy-loop
   * 应停止直连执行进化（市场成为高成本进化的唯一资助闸门）。
   */
  futarchy?: {
    /** 是否启用（缺省 false） */
    enabled?: boolean;
    /** 资助门槛：隐含成功概率下限（缺省 0.55，透传 runtime） */
    minImpliedProb?: number;
    /** 决策资产流动性 b（缺省 6，透传 runtime） */
    decisionB?: number;
    /** 进化行动成本（缺省 50，EvolverAgent 提案 bid） */
    evolutionCost?: number;
    /** 发起进化的余额门槛（缺省 60） */
    evolutionBalanceThreshold?: number;
    /** 自注预算上限（缺省 12：足够把价格从 0.5 推到 ~0.77） */
    selfBetBudget?: number;
  };
  /**
   * B 路线：能量反哺调度（缺省关闭）。
   * economicSignals() 把生态经济健康度（余额 × Wilson 信誉）折算为
   * 调度乘数注入 ModelScheduler——赚钱的模型升权、亏钱的模型降权，
   * 能量从记账数字变成真实的调度行为压力。
   */
  economic?: {
    /** 信誉在经济健康度中的权重（缺省 0.6；余额权重 = 1 − 此值） */
    reputationWeight?: number;
    /** 调度乘数下限（缺省 0.5：亏损模型最多打对折，仍可被选中——经济压力是软约束，不死锁） */
    minMultiplier?: number;
    /** 调度乘数上限（缺省 1.5：盈利模型最多加成一半） */
    maxMultiplier?: number;
    /** 中性健康度锚点（缺省 0.5：h = 该值时乘数恰为 1） */
    neutralHealth?: number;
    /** 余额归一化基准（缺省 100 = 开业注资；余额达 2× 基准即满格） */
    balanceBaseline?: number;
  };
  /** 透传 SymbiosisRuntime 的其余配置（期初供给/开业注资等） */
  runtime?: SymbiosisConfig;
}
/**
 * 共生融合桥：宿主主链路 ⇄ 共生运行时的唯一通道。
 *
 * 被 index.ts 持有：autonomy-loop 每轮心跳调用 heartbeat()（KPI 注入 +
 * 漂移洞察回流），任务执行完成后调用 settleTask()（价值铸币）。
 */
declare class SymbiosisBridge {
  readonly runtime: SymbiosisRuntime;
  private modelAgents;
  private heartbeatCount;
  private evolver?;
  private evolverDividendWeight?;
  private memoryAgentInstance?;
  private optimizerAgentInstance?;
  private futarchyLog;
  private readonly cfg;
  constructor(config?: SymbiosisBridgeConfig, governor?: GovernanceGate);
  /** 注册宿主模型（为其开立模型智能体账户并注入开业能量） */
  registerModel(modelId: string): void;
  /**
   * A 路线：绑定宿主真实进化周期（futarchy 表决的行动本体）。
   *
   * 注册进化智能体并开启市场资助闸门：进化提案 → 决策资产上市 →
   * 次拍自注定价 → 隐含概率过门槛且监管放行 → 资助执行 runCycle。
   * @param runCycle 宿主桥接的真实进化周期（index.ts: 金丝雀喂数 +
   *        沙盒素材刷新 + PolicyEvolver.runEvolutionCycle）
   * @param opts.dividendWeight 任务成功时进化贡献者的分红权重钩子
   *        （返回 undefined/≤0 = 当前无部署策略，不参与分红）
   */
  attachEvolver(runCycle: () => Promise<EvolutionCycleOutcome>, opts?: {
    dividendWeight?: () => number | undefined;
  }): EvolverAgent;
  /** 进化智能体（未绑定为 undefined；观测/审计用） */
  get evolverAgent(): EvolverAgent | undefined;
  /**
   * D 路线：绑定宿主真实长期记忆（知识卖方智能体）。
   *
   * 注册记忆智能体：真实高置信任务模式挂上认知市场出售（成交价 +
   * 央行版税），周期性支付能量执行真实维护（遗忘曲线幂等，与宿主
   * loop 的维护并行安全，多次调用不复合叠加）。
   * @param memory 宿主 LongTermMemory（只经既有公开 API 读写）
   * @param opts 透传 MemoryAgentConfig（挂卖基准价/门槛/维护间隔等）
   */
  attachMemory(memory: LongTermMemory, opts?: MemoryAgentConfig): MemoryAgent;
  /** 记忆智能体（未绑定为 undefined；观测/审计用） */
  get memoryAgent(): MemoryAgent | undefined;
  /**
   * D 路线：注册优化智能体（知识买方 + 信念下注方）。
   *
   * 真实认知分工市场化：Optimizer 观察市场行情，对高性价比知识出价
   * 购买（runtime 撮合成交后经 TradeListener 自动回调 notePurchase），
   * 并以决策视角参与信念市场下注——与模型智能体构成多方定价。
   * @param opts.onPurchase 成交回调（宿主广播/日志桥接点）
   * @param opts.config 透传 OptimizerAgentConfig（预算/保留余额/质量门槛）
   */
  attachOptimizer(opts?: {
    onPurchase?: (assetId: string, refId: string, price: number) => void;
    config?: OptimizerAgentConfig;
  }): OptimizerAgent;
  /** 优化智能体（未绑定为 undefined；观测/审计用） */
  get optimizerAgent(): OptimizerAgent | undefined;
  /** 最近一次心跳的 futarchy 决议（可观测性：funded / market-rejected / governor-vetoed） */
  lastFutarchyDecisions(): SymbiosisTickReport['futarchyDecisions'];
  /** 已注册模型清单 */
  registeredModels(): string[];
  /**
   * 共生心跳（autonomy-loop 每拍调用）：
   * KPI 快照 → 系统信号 + 被动统计估计 + 滚动信念 → 市场对账 → 漂移洞察。
   * @returns source='market' 的漂移洞察（空数组 = 市场与统计一致）
   */
  heartbeat(kpi: KpiSnapshot): Promise<Insight[]>;
  /**
   * 任务结算（宿主计划执行完成后调用）：
   * 逐节点贡献聚合（各模型 = 其成功节点质量之和）→ 央行铸币分红。
   * futarchy 启用时，部署中的策略基因视为任务成功的隐性贡献者
   * （dividendWeight 钩子评估）——进化经济的自持收入来源。
   * 未注册模型的节点不计入；失败任务不铸币但记录贡献证据（信誉惩罚）。
   */
  settleTask(result: {
    success: boolean;
    nodeResults: ReadonlyArray<{
      modelId: string;
      success: boolean;
      quality: number;
    }>;
  }): DistributionReport;
  /**
   * C 路线：能量 Sankey 报告（生态可观测性）。
   * 聚合链式账本凭证为 分层流量图数据模型（节点余额/流入流出 + 渠道链接），
   * 智能体节点自动携带 kind 标注（模型/进化者/记忆/…）。
   * @param sinceSeq 增量窗口（只聚合 seq > sinceSeq 的凭证；缺省全量）
   */
  sankey(sinceSeq?: number): EnergySankeyReport;
  /** C 路线：自包含 HTML（零依赖离线可开；宿主直接落盘即得能量全景） */
  sankeyHtml(sinceSeq?: number): string;
  /**
   * B 路线：模型经济信号 → 调度乘数（能量反哺调度的数据源）。
   *
   * 经济健康度 h = w_rep × Wilson 信誉下界 + w_bal × 余额归一化
   * （余额达 2× balanceBaseline 即满格；信誉为主——长期统计，余额为辅——
   * 短期波动）；调度乘数 m = clamp(h / neutralHealth, min, max)：
   *   赚钱且信誉好的模型 m > 1 升权，持续亏损的模型 m < 1 降权，
   *   中性健康度恰为 1（不奖不罚）。
   *
   * 设计护栏：乘数有界（缺省 0.5~1.5，亏损最多打对折但仍可被选中——
   * 经济压力是软约束，不造成调度死锁）；未注册模型 / 无信号模型
   * 不出现在返回中（调度器对缺失信号保持乘数 1 的中性行为）。
   */
  economicSignals(): Map<string, {
    balance: number;
    reputationLower: number;
    health: number;
    multiplier: number;
  }>;
  /** 生态状态快照（可观测性 / 心智报告采集器用） */
  status(): {
    enabled: boolean;
    registeredModels: string[];
    heartbeats: number;
    gini: number;
    conservationIntact: boolean;
    treasury: number;
    belief: ReturnType<SymbiosisRuntime['beliefMarket']['snapshot']>;
    /** A 路线：futarchy 进化表决状态（未启用时 undefined） */
    futarchy?: {
      enabled: boolean;
      minImpliedProb: number;
      evolver: {
        balance: number;
        cyclesRun: number;
        deployCount: number;
      } | undefined;
      lastDecisions: SymbiosisTickReport['futarchyDecisions'];
    };
  };
  /** 确保某 subject 存在 open 信念；否则新上市一条（结算拍 = 下一拍 + horizon） */
  private ensureRollingBelief;
  /** 市场背离 → 元认知洞察（模型漂移报警，回流目标引擎） */
  private divergenceToInsights;
}
//#endregion
//#region src/dashboard/index.d.ts
/**
 * 将仪表盘挂载到进度广播器的 HTTP 端口
 * @param broadcaster 已创建的进度广播器（须在 start() 之前或之后调用均可）
 * @param getModelStatuses 模型状态提供函数（通常绑定 LLMClient.getModelStatuses）
 * @returns 卸载函数（恢复默认健康检查响应）
 */
declare function attachDashboard(broadcaster: ProgressBroadcaster, getModelStatuses: () => ModelRuntimeStatus[]): () => void;
//#endregion
//#region src/index.d.ts
/** 插件配置（对应 cordis.patch.yml config 节） */
interface SchedulerConfig {
  /** 可选：DSH 宿主经 ctx 提供模型时无需配置；apiKey 亦可省略（宿主注入请求头） */
  strategistModel?: {
    id: string;
    endpoint: string;
    apiKey?: string;
  };
  /** 可选：宿主未提供模型目录时的兜底配置 */
  models?: ModelConfig[];
  sentinel: {
    watchCodeChanges: boolean;
    watchErrors: boolean;
    watchPerformance: boolean;
    /** 聚合窗口（秒） */
    aggregationWindow: number;
    signalSources?: Array<{
      type: 'webhook' | 'polling' | 'filesystem';
      port?: number;
      interval?: number;
      url?: string;
      path?: string;
      signalType: string;
    }>;
  };
  qualityThreshold: number;
  maxRetries: number;
  globalTimeout: number;
  enableProgress: boolean;
  progressPort: number;
  verbose: boolean;
  experienceStorePath: string;
  encryption: {
    enabled: boolean;
    masterKey?: string;
    algorithm: 'aes-256-gcm' | 'aes-256-cbc';
    fullFileEncryption: boolean;
  };
  sync: {
    localNodeId: string;
    peers: SyncNodeConfig[];
  };
  consensus: {
    enabled: boolean;
    localNodeId: string;
    consensusPort: number;
    electionTimeoutMin: number;
    electionTimeoutMax: number;
    heartbeatInterval: number;
    cluster: Array<{
      nodeId: string;
      address: string;
      port: number;
      priority?: number;
    }>;
  };
  hotReload: Partial<HotReloadConfig> & {
    enabled: boolean;
  };
  tenants: Array<any>;
  /** 运行时数据根目录（默认 .scheduler） */
  dataDir?: string;
  /** 经验快路径阈值：命中模式置信度 ≥ 该值时直接复用历史成功计划（缺省 0.9；设 >1 关闭） */
  memoryFastPathThreshold?: number;
  /** LLM 客户端选项覆盖（测试注入 fetchImpl 等） */
  llm?: {
    fetchImpl?: typeof fetch;
    timeout?: number;
  };
  /** 执行器节点执行器注入（测试离线模拟） */
  nodeRunner?: NodeRunner;
  /** 决策引擎配置覆盖（闭环深度优化） */
  decision?: Partial<DecisionEngineConfig>;
  /** 反思引擎配置覆盖（闭环深度优化） */
  reflection?: Partial<ReflectionEngineConfig>;
  /** 评审模型注入（LLM-as-judge，测试离线模拟） */
  judge?: JudgeModel;
  /** 教训提取器注入（测试离线模拟） */
  lessonExtractor?: LessonExtractor;
  /** 自主智能配置（目标引擎 / 元认知 / 策略进化 / 心跳循环 / 世界模型 / 好奇心 / 安全治理） */
  autonomy?: {
    /** 是否启用自主心跳循环（缺省 true） */
    enabled?: boolean;
    /** 心跳间隔（毫秒，缺省 30000） */
    heartbeatMs?: number;
    /** 目标引擎配置覆盖 */
    goal?: Partial<GoalEngineConfig>;
    /** 元认知配置覆盖 */
    metaCognition?: Partial<MetaCognitionConfig>;
    /** 策略进化配置覆盖 */
    evolution?: Partial<StrategyEvolutionConfig>;
    /**
     * 第三阶段：调度策略进化（PolicyEvolver + Sandbox）配置覆盖。
     * 设为 { enabled: false } 可完全关闭；沙盒离线评估，不阻塞操作环调度。
     */
    policyEvolution?: Partial<PolicyEvolverConfig> & {
      enabled?: boolean;
      /** 沙盒评估配置覆盖 */
      sandbox?: Partial<SandboxConfig>;
    };
    /**
     * 第四阶段：元认知层（SelfModel + MetaCognitiveController）配置覆盖。
     * 设为 { enabled: false } 可完全关闭外环；心智报告与审计日志落盘 dataDir。
     */
    metaLayer?: {
      enabled?: boolean;
      /** 自我建模配置覆盖 */
      selfModel?: Partial<SelfModelConfig>;
      /** 元认知控制器配置覆盖 */
      controller?: Partial<MetaControllerConfig>;
    };
    /** 心跳循环配置覆盖 */
    loop?: Partial<AutonomyLoopConfig>;
    /**
     * 第五阶段 Phase 2.5：共生进化融合（能量经济 + 信念市场）。
     * 缺省关闭（影子系统，不改变既有主链路行为）；启用后：
     * KPI 注入共生心跳，市场价 vs 统计估计显著背离回流为自愈目标，
     * 任务成功按模型贡献铸币分红（能量经济真实闭环）。
     */
    symbiosis?: {
      /** 是否启用（缺省 false） */
      enabled?: boolean;
      /** 滚动信念周期（心跳拍数，缺省 3） */
      beliefHorizonTicks?: number;
      /** 全局成功率信念阈值（缺省 0.8） */
      globalSuccessThreshold?: number;
      /** 单模型成功率信念阈值（缺省 0.7） */
      modelSuccessThreshold?: number;
      /** 模型智能体单信念下注预算（缺省 6） */
      modelBetBudget?: number;
      /** 元认知对账背离阈值（缺省 0.15） */
      divergenceMargin?: number;
      /**
       * A 路线：futarchy 进化表决（缺省关闭）。
       * 启用后高成本进化周期不再由心跳无条件触发，改由信念市场表决资助
       * （进化者自注私有信息 + 模型健康度定价 ≥ 门槛且监管放行 → 执行）；
       * autonomy-loop 的直连进化桥接自动让位（市场成为唯一资助闸门）。
       */
      futarchy?: {
        /** 是否启用（缺省 false；须同时 symbiosis.enabled = true） */
        enabled?: boolean;
        /** 资助门槛：隐含成功概率下限（缺省 0.55） */
        minImpliedProb?: number;
        /** 决策资产流动性 b（缺省 6） */
        decisionB?: number;
        /** 进化行动成本（能量，缺省 50） */
        evolutionCost?: number;
        /** 发起进化的余额门槛（能量，缺省 60） */
        evolutionBalanceThreshold?: number;
        /** 自注预算上限（能量，缺省 12） */
        selfBetBudget?: number;
      };
      /**
       * B 路线：能量反哺调度（缺省关闭）。
       * 启用后每轮共生心跳把模型经济健康度（余额 × Wilson 信誉）折算为
       * 调度乘数注入 ModelScheduler——赚钱的模型升权、亏钱的模型降权，
       * 能量从记账数字变成真实的调度行为压力（乘数有界 0.5~1.5，
       * 探索加成不受影响，preferred 推荐语义保持）。
       */
      schedulingFeedback?: {
        /** 是否启用（缺省 false；须同时 symbiosis.enabled = true） */
        enabled?: boolean;
        /** 信誉在经济健康度中的权重（缺省 0.6） */
        reputationWeight?: number;
        /** 调度乘数下限（缺省 0.5） */
        minMultiplier?: number;
        /** 调度乘数上限（缺省 1.5） */
        maxMultiplier?: number;
        /** 中性健康度锚点（缺省 0.5） */
        neutralHealth?: number;
        /** 余额归一化基准（缺省 100） */
        balanceBaseline?: number;
      };
      /**
       * C 路线：生态可观测性（缺省关闭）。
       * 设置 sankeyPath 后每 N 拍共生心跳落盘一份自包含能量 Sankey HTML
       * （零依赖离线可开：分层流量图 + 渠道明细 + 账户余额 + 健康快照）。
       */
      observability?: {
        /** Sankey HTML 落盘路径（设置即启用；如 /tmp/symbiosis-sankey.html） */
        sankeyPath?: string;
        /** 每 N 拍心跳落盘一次（缺省 5） */
        everyNTicks?: number;
      };
      /**
       * D 路线：全智能体接入（缺省关闭；须同时 symbiosis.enabled = true）。
       * 记忆智能体把真实高置信任务模式挂上认知市场（成交 + 央行版税），
       * 优化智能体以决策视角买知识 + 参与信念下注——认知分工完全市场化。
       * （进化智能体经 futarchy.enabled → attachEvolver 接入，见上。）
       */
      agents?: {
        /** 记忆智能体（知识卖方）：缺省关闭 */
        memory?: {
          /** 是否启用（缺省 false） */
          enabled?: boolean;
          /** 挂卖定价基准（要价 = base × 置信度，缺省 10） */
          listingBasePrice?: number;
          /** 挂卖门槛：模式置信度（缺省 0.5） */
          listingConfidenceThreshold?: number;
          /** 挂卖门槛：出现频次（缺省 2） */
          listingFrequencyThreshold?: number;
          /** 维护间隔（共生心跳轮数，缺省 5；遗忘曲线幂等，与宿主 loop 维护并行安全） */
          maintenanceInterval?: number;
        };
        /** 优化智能体（知识买方 + 信念下注方）：缺省关闭 */
        optimizer?: {
          /** 是否启用（缺省 false） */
          enabled?: boolean;
          /** 单次购买预算上限（能量，缺省 20） */
          maxBudget?: number;
          /** 保留余额（能量，缺省 30） */
          reserveBalance?: number;
          /** 只买申报质量下限（缺省 0.55） */
          minClaimedQuality?: number;
          /** 单条信念下注预算上限（能量，缺省 8） */
          beliefBetBudget?: number;
        };
      };
    };
    /** 世界模型配置覆盖 */
    worldModel?: Partial<WorldModelConfig>;
    /** 好奇心引擎配置覆盖 */
    curiosity?: Partial<CuriosityEngineConfig>;
    /** 安全治理器配置覆盖 */
    governor?: Partial<SafetyGovernorConfig>;
    /** 5.0：因果内核配置覆盖（do-干预登记 + Shapley 分红 + 反事实查询） */
    causalKernel?: Partial<CausalKernelConfig>;
    /**
     * 6.0：主动推断配置（自由能最小化心智）。
     * enabled 时调度改用期望自由能（探索/利用统一）、健康报告携带
     * 统一自由能 KPI、共生心跳产出变分漂移监测。缺省关闭（零漂移）。
     */
    activeInference?: {
      enabled?: boolean;
      /** 调度偏好强度（对成功的目标概率，缺省 0.9） */
      schedulingPreference?: number;
      /** 认知价值权重（信息增益折算系数，缺省 1） */
      epistemicWeight?: number;
    };
    /**
     * 8.0：元推理配置（元认知心智：计算即行动，思考有价格）。
     * optimizer.metacognitiveRecommendation 按 habit/reactive/deliberative
     * 三模式仲裁；结算回流驱动元学习（门槛自适应 + 习惯晋升/作废）。
     */
    metareasoning?: {
      /** 反应门槛：单步 EFE 差 ≥ 该值直接反应（nat，缺省 0.25） */
      decisivenessGap?: number;
      /** 反应模式最低证据量（缺省 8） */
      sufficientEvidence?: number;
      /** 习惯晋升门槛：同状态同计划连续成功次数（缺省 2） */
      habitPromotionSuccesses?: number;
      /** 深思最大深度（缺省 4） */
      maxDepth?: number;
      /** 每节点计算价格（nat，缺省 0.01） */
      natPerNode?: number;
      /** 单次深思预算（nat，缺省 2.0） */
      budgetNat?: number;
    };
    /**
     * 9.0：抽象配置（抽象心智：类比结构映射 + 分层收缩）。
     * enabled 时深思内核挂载抽象层——冷状态凭结构同构借别域经验
     * （零样本应答）、后继结构继承、跨域宏技能；健康报告携带
     * 抽象统计 KPI。缺省关闭（零漂移；均匀层与 Beta(1,1) 严格等价）。
     */
    abstraction?: {
      enabled?: boolean;
      /** L1 类比层先验强度（伪计数，缺省 6） */
      analogyStrength?: number;
      /** 结构相似度门槛（Jaccard，缺省 0.3） */
      minSimilarity?: number;
      /** 抽象技能晋升所需跨域成功数（缺省 2） */
      abstractSkillDomains?: number;
    };
    /**
     * 10.0：科学家配置（科学家心智：最优实验设计）。
     * enabled 时宿主创建 ScientistMind（EIG 实验设计 + 混杂侦测加成
     * + 预算仲裁 + 信息台账），好奇心/调度的因果实验建议升级为
     * Lindley 期望信息增益口径；健康报告携带知识前沿 KPI。
     * 缺省关闭（零漂移——不登记问题即无实验设计）。
     */
    scientist?: {
      enabled?: boolean;
      /** 缺省单次实验代价（nat；EIG 低于此值不设计，缺省 0.05） */
      defaultCostNat?: number;
      /** 混杂加成上限（nat，缺省 1.0） */
      maxConfoundingBonus?: number;
      /** 定律试验加成上限（nat，缺省 1.0；需 theorist.enabled） */
      lawBonusCap?: number;
      /** 热点自动登记：调度器观测到的 (model, taskType) 边入问题空间 */
      autoRegisterQuestions?: boolean;
    };
    /**
     * 11.0：理论配置（理论心智：从数据到定律）。
     * enabled 时宿主创建 TheoristEngine（层级贝叶斯定律归纳 +
     * MDL 压缩定价 + 零样本预测 + 反常/范式转移），科学家的问题
     * 若落在定律作用域内获得定律试验加成；健康报告携带理论前沿
     * KPI。缺省关闭（零漂移——不归纳即无定律）。
     */
    theorist?: {
      enabled?: boolean;
      /** 立定律的最小成员数（缺省 3） */
      minMembers?: number;
      /** 零样本预测的臂证据门槛（缺省 1） */
      zeroShotMaxArmSamples?: number;
    };
    /**
     * 12.0：任意时刻证据配置（结论永不夸大的统计）。
     * enabled 时进化适应度升级为置信序列下界（流式统计永不夸大），
     * e-BH FDR 控制淘汰「证明确实低劣」的基因组（冤案率有数学上限），
     * 元认知挂载 KPI 保证层（退化判定偷看免疫）。缺省关闭（零漂移）。
     */
    anytimeEvidence?: {
      enabled?: boolean;
      /** 时间一致覆盖率（1−alpha，缺省 0.05 → 95%） */
      alpha?: number;
      /** 裁决水位线（缺省 0.5） */
      reference?: number;
    };
    /**
     * 13.0：保形校准配置（预测与阈值的分布无关保证）。
     * enabled 时世界模型预测区间获得精确有限样本覆盖保证
     * （P(实际 ∈ 区间) ≥ 1−α，零分布假设），反思引擎阈值自校准
     * 升级为风险受控选择（P(未来重试率 ≤ targetRisk) ≥ confidence）。
     * 缺省关闭（区间回退既有泊松近似口径）。
     */
    conformal?: {
      enabled?: boolean;
      /** 名义误覆盖率 α（覆盖 ≥ 1−α，缺省 0.1） */
      alpha?: number;
      /** 校准集容量上限（缺省 200） */
      maxCalibration?: number;
      /** 阈值选择的目标重试风险（缺省 0.1） */
      thresholdTargetRisk?: number;
      /** 阈值选择的置信水平（缺省 0.95） */
      thresholdConfidence?: number;
    };
    /**
     * 14.0：质量-多样性进化配置（行为流派不灭）。
     * enabled 时策略探索从纯 UCB 升级为 MAP-Elites 前沿 niche
     * 均匀采样——敢为/节俭/警觉各行为流派获得等量试验预算，
     * 多样性坍缩被结构性阻断。缺省关闭（零漂移）。
     */
    qualityDiversity?: {
      enabled?: boolean;
      /** 探索概率（selectGenome 从归档采样的概率，缺省 0.25） */
      exploreRate?: number;
    };
    /**
     * 15.0：运行时验证配置（安全规约形式化）。
     * enabled 时治理器迁移事件流自动喂入 LTLf 规约监视器；
     * critical 违规（如失败风暴）自动触发 Kill Switch——
     * 形式裁决获得治理的牙齿。缺省关闭（零漂移——不挂载即不监视）。
     */
    runtimeVerification?: {
      enabled?: boolean;
      /** 附加安全规约（在缺省规约集之上注册，id 幂等） */
      specs?: SafetySpec[];
    };
    /**
     * 17.0：最优传输配置（漂移检测看见分布的形状）。
     * enabled 时元认知挂载形状感知传输漂移监视（滑动窗 vs 基准窗的
     * Wasserstein-1 + 自适应阈值）——均值不变而形状巨变的「换了世界」
     * 第一次可见（12.0 水位检测的盲区补位，13.0 保形区间的绊线）。
     * 缺省关闭（零漂移）。
     */
    optimalTransport?: {
      enabled?: boolean;
      /** 监测的 KPI 列表（缺省 avgQuality + avgLatency） */
      kpis?: Array<'successRate' | 'avgQuality' | 'avgLatency' | 'cacheHitRate'>;
      /** 滑动窗容量（缺省 50） */
      windowSize?: number;
      /** 基准窗容量（缺省 200） */
      referenceSize?: number;
      /** 漂移阈值的经验分位数（缺省 0.95） */
      thresholdQuantile?: number;
      /** 最小样本量（缺省 20） */
      minSamples?: number;
    };
    /**
     * 18.0：信息几何配置（进化在流形上行走）。
     * enabled 时策略变异从坐标轴独立加噪升级为 Fisher 流形上的
     * 自然变异：种群协方差主轴联合相关步 + KL 信任域封顶——
     * 步长以 nat 计价，仿射重参数化下严格不变。缺省关闭（零漂移）。
     */
    informationGeometry?: {
      enabled?: boolean;
      /** KL 信任域半径 δ_max（Mahalanobis 上限；缺省 1.2） */
      klBudget?: number;
      /** 基础变异尺度 σ（缺省 0.5） */
      stepScale?: number;
    };
    /**
     * 19.0：最优停止配置（等待有了数学价格）。
     * enabled 时决策引擎规则 C 的成本闸门从「urgency < 0.3 → defer」
     * 魔数升级为继续价值裁决：紧急度流经验分布 + 向后归纳精确阈值
     * （现值 ≥ V_{horizon} 即执行——占坑数学最优，否则等待有价）。
     * 缺省关闭（零漂移——原魔数规则）。
     */
    optimalStopping?: {
      enabled?: boolean;
      /** defer 窗口内预计剩余机会数（继续价值口径；缺省 3） */
      horizon?: number;
      /** 开始裁决的最小经验样本（缺省 8） */
      minSamples?: number;
    };
    /**
     * 20.0：层论共识配置（分歧的形状可见）。
     * enabled 时注册 sheaf_consensus Tool：多源信念融合从平均/投票
     * 升级为胞腔层调和共识——「谁与谁、在哪些声明上应该一致」成为
     * 一等数学对象，结构性分歧（无解的循环异议）第一次可检测。
     * 缺省关闭（不注册即零漂移）。
     */
    sheafConsensus?: {
      enabled?: boolean;
      /** 障碍判定的加权失配容差（均方差口径；缺省 0.0025 ≈ 5% 标准差） */
      misfitTolerance?: number;
    };
    /**
     * 21.0：最优索引调度配置（可证明最优的模型调度）。
     * enabled 时调度器动态选型升级为 Gittins 索引口径：对每个候选的
     * Beta 后验精确计算折扣 bandit 最优指数（退休 MDP 三角形反向归纳，
     * 无需不动点迭代），学习溢价随证据积累自动归零（探索自我终结）。
     * preferred 短路与 avoidModels 语义不变。缺省关闭（零漂移）。
     */
    indexScheduling?: {
      enabled: boolean;
      /** 贴现因子 γ ∈ (0,1)（缺省 0.95） */
      discount?: number;
      /** 后验计数网格上限 α+β ≤ N（缺省 48） */
      maxCount?: number;
    };
    /**
     * 22.0：预算最优路由配置（Bandits with Knapsacks）。
     * enabled 时治理器预算成为调度的一等约束：乐观可行性 + 预算感知
     * 贪心选臂，影子价格由「剩余预算/剩余轮数」稀缺性内生涌现；
     * 治理器未配置预算（tokenBudget=costBudget=0）时挂载不生效（走原路径）。
     */
    banditKnapsack?: {
      enabled: boolean;
      /** 乐观半径置信参数 α（越小越探索，缺省 0.05） */
      ucbAlpha?: number;
      /** 可行性松弛（缺省 0.25） */
      feasibilitySlack?: number;
      /** roundsRemaining 缺省时的视界估计（缺省 100） */
      horizonDefault?: number;
    };
    /**
     * 稳健统计配置（预留：运行时接线随后续版本进入）。
     */
    robustStatistics?: {
      enabled: boolean;
      alpha?: number;
    };
    /**
     * 差分隐私配置（预留：运行时接线随后续版本进入）。
     */
    privacy?: {
      enabled: boolean;
      epsilon?: number;
      delta?: number;
    };
    /**
     * 容量规划配置（预留：运行时接线随后续版本进入）。
     */
    capacityPlanning?: {
      enabled: boolean;
      targetWaitMs?: number;
      defaultScv?: number;
    };
    /**
     * 26.0：高斯过程配置（预测校准的非参数贝叶斯升级）。
     * enabled 时世界模型挂载 GP 序列校准器：每次校准对账的
     * actual/predicted 比值喂入时间轴 GP，预测期望乘以 GP 后验因子、
     * 区间按后验标准差拓宽——趋势修正的 1.25/0.75 魔数由从对账结果
     * 学出的修正接管。校准史不足 minPoints 时因子恒 1（早期零漂移）。
     * 缺省关闭（零漂移）。
     */
    gaussianProcess?: {
      enabled: boolean;
      /** 校准点上限（缺省 48） */
      maxPoints?: number;
      /** 出修正前的最小校准点数（缺省 6） */
      minPoints?: number;
      /** 观测噪声 σn（比值尺度标准化后；缺省 0.15） */
      sigmaN?: number;
    };
    /**
     * 27.0：卡尔曼滤波配置（KPI 异常判定的假设检验口径）。
     * enabled 时元认知挂载 KPI 局部线性趋势滤波器：整条历史压进
     * (level, slope) 充分统计量，突变判定从窗口 z-score 升级为
     * NIS 门控（新息平方和超出 χ² 分位才报警——99.7% 不该发生的
     * 才算异常），缓慢漂移由滤波斜率给出早期读数。缺省关闭（零漂移）。
     */
    kalmanFilter?: {
      enabled: boolean;
      /** 水平过程噪声 q_level（缺省 1e-4） */
      qLevel?: number;
      /** 斜率过程噪声 q_slope（缺省 1e-6） */
      qSlope?: number;
      /** 观测噪声方差 r（缺省 2e-4） */
      r?: number;
      /** NIS 门控上侧概率（缺省 0.997 ≈ 3σ） */
      gateP?: number;
      /** 覆盖的 KPI（缺省全部四项） */
      kpis?: Array<'successRate' | 'avgQuality' | 'avgLatency' | 'cacheHitRate'>;
    };
    /**
     * 28.0：极值理论配置（尾部延迟的定理化外推）。
     * enabled 时心跳 2.7 段对各模型延迟样本拟合 POT/GPD：p99.9 不再
     * 是「样本最大值」（运气）而是 Pickands–Balkema–de Haan 定理背书的
     * 尾部外推（含 bootstrap 置信区间），超出目标阈值产出 tail-risk
     * 洞察。依赖 robustStatistics 启用（延迟样本流与其共用）。缺省关闭。
     */
    extremeValue?: {
      enabled: boolean;
      /** p99 外推的目标阈值（毫秒；超出产出洞察；缺省 30000） */
      targetP99Ms?: number;
      /** 参与拟合的最少延迟样本（缺省 60） */
      minSamples?: number;
      /** 超阈值经验分位（缺省 0.9） */
      thresholdQuantile?: number;
      /** bootstrap CI 次数（0 关闭；缺省 200） */
      bootstrap?: number;
    };
    /**
     * 29.0：MCTS 配置（深思搜索的序贯决策升级口径）。
     * enabled 时 optimizer 深思推荐从 beam search 切换为 UCT：转移边按
     * Beta 后验采样成败，UCB1 自动平衡利用/探索，迭代预算耗尽即读出
     * （任意时刻性）；报告口径与 beam search 一致可互查。缺省关闭。
     */
    mcts?: {
      enabled: boolean;
      /** UCT 迭代预算（缺省 600） */
      iterations?: number;
      /** UCB1 探索常数（缺省 √2） */
      explorationC?: number;
      /** 每步折扣 γ（缺省 0.95） */
      discount?: number;
    };
    /**
     * 30.0：次模选择配置（探索预算的组合最优分配）。
     * enabled 时好奇心探索预算从新颖度 top-k 升级为加权覆盖惰性贪心
     * （CELF，≥ (1−1/e)·OPT）：共享主题的盲区（如 'generate-code' 与
     * 'review-code' 同含 code）边际自动衰减，预算优先流向互补知识结构。
     * 缺省关闭（零漂移——原 top-k）。
     */
    submodular?: {
      enabled: boolean;
      /** 主题覆盖强度 c ∈ (0,1]（缺省 0.7） */
      coverageStrength?: number;
    };
    /**
     * 31.0：对抗组合配置（调度权重的无悔学习口径）。
     * enabled 时模型评分叠加 Fixed-Share Hedge 有界乘数（[0.25,4]）：
     * 每次节点完成回报质量（成功 = 质量，失败 = 0），被对手打爆的模型
     * 以每失败一轮 e^{−η} 的速度降权——比统计口径（Wilson 时间衰减）
     * 快一个数量级；α 份额回灌保证漂移世界（模型能力翻转）可跟踪。
     * 对事后最优固定模型遗憾 ≤ √(2T lnN)（对手无关）。缺省关闭（零漂移）。
     */
    hedgePortfolio?: {
      enabled: boolean;
      /** 学习率 η ∈ (0,1]（缺省 0.3） */
      eta?: number;
      /** Fixed-Share 回灌率 α ∈ [0,1)（缺省 0.05；0 = 经典 Hedge） */
      alpha?: number;
    };
    /**
     * 32.0：批内全局最优指派配置（匈牙利算法）。
     * enabled 时同批动态选型节点（≥2 个且候选 ≥2）不再逐节点贪心，
     * 而是构造「节点 × 候选」评分矩阵求**全局总收益最优**一对一指派
     * （O(n³) 精确解 + 对偶证书）——最优模型不被同批节点重复超订。
     * 计划指定/优化器推荐的节点不受影响（约束优先）。缺省关闭（零漂移）。
     */
    optimalAssignment?: {
      enabled: boolean;
      /** 每任务类型进入候选池的评分前 K（缺省 8） */
      candidateCap?: number;
    };
    /**
     * 33.0：随机矩阵配置（失败相关性的噪声清洗与系统性风险）。
     * enabled 时心跳 2.8 段把各模型每期失败计数喂入滚动窗口，攒满后
     * 相关矩阵经 Marchenko–Pastur 边界清洗：伪相关被噪声带吸收（不
     * 误报），头号特征值显著超带且解释份额达标 → systemic-risk 洞察
     * （共同因子暴露：同一上游/厂商的模型会同沉浮，热备冗余是幻觉）。
     * 缺省关闭（零漂移）。
     */
    randomMatrix?: {
      enabled: boolean;
      /** 滚动窗口长度（心跳期数；缺省 32） */
      window?: number;
      /** 参与评估的最少活跃模型数（缺省 4） */
      minModels?: number;
      /** 信号判定倍数 λ₁ > factor × λ+（缺省 1.1） */
      edgeFactor?: number;
      /** 系统性洞察的解释份额门槛（缺省 0.35） */
      systemicShare?: number;
    };
    /**
     * 34.0：CVaR 超时预算配置（超时的最坏尾部定价）。
     * enabled 时每模型超时 = margin × CVaR_α(该模型延迟史)（α 为置信
     * 水平，缺省 0.95 即最坏 5% 尾），钳位 [floorMs, capMs]——「按最坏
     * 尾部的期望定价」取代固定魔数：重尾模型自动获得更长预算、轻尾模型
     * 不被一刀切。依赖 robustStatistics 启用（延迟样本流共用）；样本不足
     * minSamples 回退全局缺省。缺省关闭。
     */
    cvarTimeouts?: {
      enabled: boolean;
      /** 置信水平 α（CVaR_α 取最坏 1−α 尾；缺省 0.95） */
      alpha?: number;
      /** 裕度乘数（缺省 1.5） */
      margin?: number;
      /** 样本下限（缺省 30） */
      minSamples?: number;
      /** 下限毫秒（缺省 5000） */
      floorMs?: number;
      /** 上限毫秒（缺省 300000） */
      capMs?: number;
    };
    /**
     * 35.0：并发反馈控制配置（并发的闭环 LQR 驾驭）。
     * enabled 时 computeParallelism 从静态口径（总容量钳位）升级为闭环：
     * 每次调用观测总利用率 → LQR 增益步（DARE 闭式解出的增益，Lyapunov
     * 证书背书稳定）→ 新上限 [1,16]；死区抗抖振、钳位抗饱和。25.0 排队论
     * 反解给的是静态目标，本内核让系统在非平稳负载下自动追踪它。缺省关闭。
     */
    concurrencyControl?: {
      enabled: boolean;
      /** 目标利用率 ∈ (0,1]（缺省 0.75） */
      target?: number;
      /** 标称被控增益 b（缺省 0.4） */
      plantGain?: number;
      /** 控制权重 r（缺省 4；越大越保守） */
      r?: number;
      /** 死区半宽（缺省 0.05） */
      deadband?: number;
    };
    /**
     * 37.0：信息瓶颈蒸馏定价配置（理解即压缩的算法化）。
     * enabled 时知识蒸馏门槛从纯水位升维为水位 + 信息量双门：候选
     * 样本（任务位型 × 成败）经 Blahut-Arimoto IB 压缩，保留率
     * I(T;Y)/I(X;Y) 低于 retentionFloor → 样本同构，水位再高也只产出
     * 重复知识，诚实跳过（below-information）。缺省关闭（零漂移）。
     */
    informationBottleneck?: {
      enabled: boolean;
      /** 压缩-相关权衡 β（缺省 5） */
      beta?: number;
      /** 保留率下限（缺省 0.4） */
      retentionFloor?: number;
    };
    /**
     * 38.0：动力学体质诊断配置（KPI 的混沌/持续/反持续分类）。
     * enabled 时元认知对每个 KPI 序列积累窗口，满窗后做 Rosenstein
     * Lyapunov + R/S Hurst 体质分类；体质确立的翻转沿产出洞察（混沌
     * → 预测视野 ~1/λ₁ 步；持续 → 趋势加权；反持续 → 突破降权）。
     * 缺省关闭（零漂移）。
     */
    chaosDiagnostics?: {
      enabled: boolean;
      /** 分类前最少样本点（缺省 96） */
      minPoints?: number;
      /** 混沌判定阈值 λ₁（缺省 0.05 nat/步） */
      lambdaThreshold?: number;
      /** Hurst 偏离半宽 δ（缺省 0.08） */
      hurstDelta?: number;
    };
    /**
     * 39.0：谱排序影响力配置（知识图的 PageRank 骨架）。
     * enabled 时记忆图共现网络经 PageRank 幂迭代解出每条知识的结构
     * 影响力：related() 联想序升维为「边权 × 邻居影响力」（与枢纽
     * 共现者先被想起），topInfluential 输出知识骨架清单。缺省关闭。
     */
    spectralRanking?: {
      enabled: boolean;
      /** 阻尼系数（缺省 0.85） */
      damping?: number;
    };
    /**
     * 40.0：首达时间冷却定价配置（熔断恢复的概率口径）。
     * enabled 时治理器记录失败时间戳；熔断打开沿按逆高斯首达模型定价
     * 「以 target 概率确信失败强度已恢复」的最小冷却建议（μ̂ ≤ 0 的
     * 结构性恶化诚实给出不可达）。建议口径，不改既有状态机时序。
     * 缺省关闭（零记录零介入）。
     */
    firstPassageCooldown?: {
      enabled: boolean;
      /** 恢复置信目标（缺省 0.9） */
      targetProb?: number;
    };
    /**
     * 41.0：排队网络配置（心跳 2.9 段的串联瓶颈洞察）。
     * enabled 时各模型作为独立 M/M/c 站、到达率按当前流量份额分摊，
     * Erlang-C 口径解出瓶颈站（ρ 最大）——单站反解（25.0）看不到的
     * 「哪一站钳制整条链路」成为可计算读数，接近饱和产出洞察。
     * 缺省关闭（零漂移）。
     */
    queueingNetwork?: {
      enabled: boolean;
      /** 瓶颈站告警利用率阈值（缺省 0.85） */
      rhoThreshold?: number;
    };
    /**
     * 42.0：谱日历配置（到达节律的频谱解出）。
     * enabled 时世界模型的热度因子从「预设为一天的小时直方图」升级为
     * FFT 周期图 + Fisher g 检验：存在显著周期（任意周期——分钟回环/
     * 昼夜/周节律）时切换为相位感知的谐波季节因子；不显著时逐位回退
     * 原直方图口径。缺省关闭（零漂移）。
     */
    spectralCalendar?: {
      enabled: boolean;
      /** 小时分桶数（2 的幂最优；缺省 128） */
      bins?: number;
    };
    /**
     * 43.0：容量前沿配置（类型需求 × 模型容量的最大流诊断）。
     * enabled 时执行批回写待执行需求，流网络上解 max-flow（可立即满足
     * 的最大并发派发）与 min-cut（钳制者归因：类型在饿还是模型是独木
     * 桥，割容量 = 流值证书）。纯诊断口径，不改变派发行为。缺省关闭。
     */
    capacityFrontier?: {
      enabled: boolean;
    };
    /**
     * 44.0：公平预算配置（探索预算的域级极大极小分配）。
     * enabled 时探索预算按域（taskType）加权极大极小注水（新颖度权重）
     * ——热门域可以多拿，但任何活跃域的相对份额不被压扁（词典序最优，
     * Bertsekas–Gallager）。缺省关闭（零漂移——原 top-k / 次模路径）。
     */
    fairBudget?: {
      enabled: boolean;
    };
    /**
     * 45.0：OCBA 预算分配配置（基准瓶颈确认的最优预算）。
     * enabled 时 runAll 报告附加 bottleneckFocus——以各场景延迟统计为
     * 试点，按 OCBA（P(CS) 渐近最优）给出下一轮确认预算的最优分配。
     * 纯报告口径。缺省关闭（零漂移）。
     */
    ocbaAllocator?: {
      enabled: boolean;
      /** 下一轮确认预算（缺省 200） */
      confirmationBudget?: number;
    };
    /**
     * 49.0：多尺度小波视图配置（元认知 KPI 的尺度透镜）。
     * enabled 时 KPI 序列经 Haar 小波分解为对数个正交尺度——趋势水平/
     * 漂移带能量/瞬时突发分离（单尺度异常检测看不见的结构）。纯读数
     * 口径（waveletView），缺省关闭（零漂移）。
     */
    waveletView?: {
      enabled: boolean;
      /** 补全读数前最少样本点（缺省 64） */
      minPoints?: number;
    };
    /**
     * 50.0：潜因子补全配置（模型能力的冷启动外推）。
     * enabled 时「模型 × 任务类型」能力矩阵经 ALS 低秩补全：未观测
     * 条目由潜因子外推（Candès–Recht 恢复条件），新模型冷启动选型
     * 从零样本升级为潜维度预测。纯诊断口径（coldStartEstimate），
     * 缺省关闭（零漂移）。
     */
    latentFactors?: {
      enabled: boolean;
      /** 潜维数 r（缺省 3） */
      rank?: number;
    };
    /** 目标分解器注入（测试离线模拟） */
    decomposer?: GoalDecomposer;
  };
  /** 宿主融合配置（全宿主可观测 + 全宿主安全治理；宿主无 ctx.tools 时静默降级） */
  hostFusion?: Partial<HostFusionConfig>;
}
/** Tool 定义 */
interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, {
    type: string;
    description: string;
    required?: boolean;
    enum?: string[];
  }>;
  handler: (args: any) => Promise<any> | any;
}
/** Tool 调用错误 */
declare class ToolError extends AppError {
  constructor(message: string, details?: Record<string, unknown>);
}
/**
 * Tool 注册表服务
 *
 * cordis 核心未内置 Tool API，本插件以 provide('schedulerTools') 形式
 * 向宿主暴露 12 个 Tool 的注册、发现与调用能力。
 */
declare class ToolRegistry {
  private tools;
  /** 注册一个 Tool（重名覆盖） */
  register(tool: ToolDefinition): void;
  /** 注销一个 Tool */
  unregister(name: string): boolean;
  /** 获取 Tool 定义 */
  get(name: string): ToolDefinition | undefined;
  /** 列出全部 Tool（不含 handler） */
  list(): Array<Pick<ToolDefinition, 'name' | 'description' | 'parameters'>>;
  /** 调用 Tool（未知名称抛 ToolError） */
  invoke(name: string, args?: Record<string, any>): Promise<any>;
}
/** 插件对外暴露的调度器服务面 */
interface SchedulerService {
  tools: ToolRegistry;
  sentinel: Sentinel;
  /** 模型调度器（新架构：优化器 → 模型调度） */
  modelScheduler: ModelScheduler;
  /** 任务执行器（新架构：模型调度 → 任务执行） */
  taskExecutor: TaskExecutor;
  memory: LongTermMemory;
  llm: LLMClient;
  tenantManager: TenantManager;
  sync: DistributedSync;
  raft: RaftEngine | null;
  hotReload: HotReloadEngine | null;
  broadcaster: ProgressBroadcaster | null;
  benchmark: BenchmarkEngine;
  cryptoEngine: CryptoEngine | null;
  /** 决策引擎（闭环深度优化） */
  decisionEngine: DecisionEngine;
  /** 反思引擎（闭环深度优化） */
  reflectionEngine: ReflectionEngine;
  /** 优化器（新架构：记忆库 → 优化器 → 模型调度） */
  optimizer: Optimizer;
  /** 反思器（新架构：任务执行 → 反思器 → 记忆更新） */
  reflector: Reflector;
  /** 目标引擎（自主智能） */
  goalEngine: GoalEngine;
  /** 元认知引擎（自主智能） */
  metaCognition: MetaCognitionEngine;
  /** 策略进化引擎（自主智能） */
  strategyEvolution: StrategyEvolutionEngine;
  /** 第四阶段：自我建模引擎（心智报告） */
  selfModel: SelfModel;
  /** 第四阶段：元认知控制器（保守调参 + 自动回滚 + 审计） */
  metaController: MetaCognitiveController;
  /** 自主心跳循环（自主智能） */
  autonomyLoop: AutonomyLoop;
  /** 世界模型（自主智能·预见） */
  worldModel: WorldModel;
  /** 好奇心引擎（自主智能·内在动机） */
  curiosity: CuriosityEngine;
  /** 安全治理器（自主智能·边界） */
  governor: SafetyGovernor;
  /** 宿主融合层（全宿主可观测 + 安全治理；未激活时 isActive()=false） */
  hostFusion: HostFusionLayer;
  /** 手动提交任务（等价于 autonomous_execute Tool） */
  submitTask(task: string, urgency?: number): Signal;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    scheduler: SchedulerService;
    schedulerTools: ToolRegistry;
  }
  interface Events {
    'scheduler/signal'(signal: Signal): void;
    'scheduler/plan-complete'(result: PlanExecutionResult, signal: Signal): void;
  }
}
/**
 * 插件配置 schema（cordis Plugin.Base.Config）。
 * 经 ctx.plugin() 加载时由 cordis resolveConfig 自动校验并填充默认值；
 * 函数型注入字段（nodeRunner / judge / llm.fetchImpl 等）不在 schema 中声明，
 * 作为额外属性透传，不受校验影响。
 */
declare const Config: Schema<Schemastery.ObjectS<{
  strategistModel: Schema<Schemastery.ObjectS<{
    id: Schema<string, string>;
    endpoint: Schema<string, string>;
    apiKey: Schema<string, string>;
  }>, Schemastery.ObjectT<{
    id: Schema<string, string>;
    endpoint: Schema<string, string>;
    apiKey: Schema<string, string>;
  }>>;
  models: Schema<any[], any[]>;
  sentinel: Schema<Schemastery.ObjectS<{
    watchCodeChanges: Schema<boolean, boolean>;
    watchErrors: Schema<boolean, boolean>;
    watchPerformance: Schema<boolean, boolean>;
    aggregationWindow: Schema<number, number>;
    signalSources: Schema<any[], any[]>;
  }>, Schemastery.ObjectT<{
    watchCodeChanges: Schema<boolean, boolean>;
    watchErrors: Schema<boolean, boolean>;
    watchPerformance: Schema<boolean, boolean>;
    aggregationWindow: Schema<number, number>;
    signalSources: Schema<any[], any[]>;
  }>>;
  qualityThreshold: Schema<number, number>;
  maxRetries: Schema<number, number>;
  globalTimeout: Schema<number, number>;
  enableProgress: Schema<boolean, boolean>;
  progressPort: Schema<number, number>;
  verbose: Schema<boolean, boolean>;
  experienceStorePath: Schema<string, string>;
  encryption: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    masterKey: Schema<string, string>;
    algorithm: Schema<"aes-256-cbc" | "aes-256-gcm", "aes-256-cbc" | "aes-256-gcm">;
    fullFileEncryption: Schema<boolean, boolean>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    masterKey: Schema<string, string>;
    algorithm: Schema<"aes-256-cbc" | "aes-256-gcm", "aes-256-cbc" | "aes-256-gcm">;
    fullFileEncryption: Schema<boolean, boolean>;
  }>>;
  sync: Schema<Schemastery.ObjectS<{
    localNodeId: Schema<string, string>;
    peers: Schema<any[], any[]>;
  }>, Schemastery.ObjectT<{
    localNodeId: Schema<string, string>;
    peers: Schema<any[], any[]>;
  }>>;
  consensus: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    localNodeId: Schema<string, string>;
    consensusPort: Schema<number, number>;
    electionTimeoutMin: Schema<number, number>;
    electionTimeoutMax: Schema<number, number>;
    heartbeatInterval: Schema<number, number>;
    cluster: Schema<any[], any[]>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    localNodeId: Schema<string, string>;
    consensusPort: Schema<number, number>;
    electionTimeoutMin: Schema<number, number>;
    electionTimeoutMax: Schema<number, number>;
    heartbeatInterval: Schema<number, number>;
    cluster: Schema<any[], any[]>;
  }>>;
  hotReload: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    watchDirs: Schema<string[], string[]>;
    watchExtensions: Schema<string[], string[]>;
    debounceMs: Schema<number, number>;
    buildCommand: Schema<string, string>;
    autoRollback: Schema<boolean, boolean>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    watchDirs: Schema<string[], string[]>;
    watchExtensions: Schema<string[], string[]>;
    debounceMs: Schema<number, number>;
    buildCommand: Schema<string, string>;
    autoRollback: Schema<boolean, boolean>;
  }>>;
  tenants: Schema<any[], any[]>;
  dataDir: Schema<string, string>;
  memoryFastPathThreshold: Schema<number, number>;
  autonomy: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    heartbeatMs: Schema<number, number>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    heartbeatMs: Schema<number, number>;
  }>>;
  hostFusion: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    observeToolResults: Schema<boolean, boolean>;
    governToolCalls: Schema<boolean, boolean>;
    failureEscalationThreshold: Schema<number, number>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    observeToolResults: Schema<boolean, boolean>;
    governToolCalls: Schema<boolean, boolean>;
    failureEscalationThreshold: Schema<number, number>;
  }>>;
}>, Schemastery.ObjectT<{
  strategistModel: Schema<Schemastery.ObjectS<{
    id: Schema<string, string>;
    endpoint: Schema<string, string>;
    apiKey: Schema<string, string>;
  }>, Schemastery.ObjectT<{
    id: Schema<string, string>;
    endpoint: Schema<string, string>;
    apiKey: Schema<string, string>;
  }>>;
  models: Schema<any[], any[]>;
  sentinel: Schema<Schemastery.ObjectS<{
    watchCodeChanges: Schema<boolean, boolean>;
    watchErrors: Schema<boolean, boolean>;
    watchPerformance: Schema<boolean, boolean>;
    aggregationWindow: Schema<number, number>;
    signalSources: Schema<any[], any[]>;
  }>, Schemastery.ObjectT<{
    watchCodeChanges: Schema<boolean, boolean>;
    watchErrors: Schema<boolean, boolean>;
    watchPerformance: Schema<boolean, boolean>;
    aggregationWindow: Schema<number, number>;
    signalSources: Schema<any[], any[]>;
  }>>;
  qualityThreshold: Schema<number, number>;
  maxRetries: Schema<number, number>;
  globalTimeout: Schema<number, number>;
  enableProgress: Schema<boolean, boolean>;
  progressPort: Schema<number, number>;
  verbose: Schema<boolean, boolean>;
  experienceStorePath: Schema<string, string>;
  encryption: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    masterKey: Schema<string, string>;
    algorithm: Schema<"aes-256-cbc" | "aes-256-gcm", "aes-256-cbc" | "aes-256-gcm">;
    fullFileEncryption: Schema<boolean, boolean>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    masterKey: Schema<string, string>;
    algorithm: Schema<"aes-256-cbc" | "aes-256-gcm", "aes-256-cbc" | "aes-256-gcm">;
    fullFileEncryption: Schema<boolean, boolean>;
  }>>;
  sync: Schema<Schemastery.ObjectS<{
    localNodeId: Schema<string, string>;
    peers: Schema<any[], any[]>;
  }>, Schemastery.ObjectT<{
    localNodeId: Schema<string, string>;
    peers: Schema<any[], any[]>;
  }>>;
  consensus: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    localNodeId: Schema<string, string>;
    consensusPort: Schema<number, number>;
    electionTimeoutMin: Schema<number, number>;
    electionTimeoutMax: Schema<number, number>;
    heartbeatInterval: Schema<number, number>;
    cluster: Schema<any[], any[]>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    localNodeId: Schema<string, string>;
    consensusPort: Schema<number, number>;
    electionTimeoutMin: Schema<number, number>;
    electionTimeoutMax: Schema<number, number>;
    heartbeatInterval: Schema<number, number>;
    cluster: Schema<any[], any[]>;
  }>>;
  hotReload: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    watchDirs: Schema<string[], string[]>;
    watchExtensions: Schema<string[], string[]>;
    debounceMs: Schema<number, number>;
    buildCommand: Schema<string, string>;
    autoRollback: Schema<boolean, boolean>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    watchDirs: Schema<string[], string[]>;
    watchExtensions: Schema<string[], string[]>;
    debounceMs: Schema<number, number>;
    buildCommand: Schema<string, string>;
    autoRollback: Schema<boolean, boolean>;
  }>>;
  tenants: Schema<any[], any[]>;
  dataDir: Schema<string, string>;
  memoryFastPathThreshold: Schema<number, number>;
  autonomy: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    heartbeatMs: Schema<number, number>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    heartbeatMs: Schema<number, number>;
  }>>;
  hostFusion: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    observeToolResults: Schema<boolean, boolean>;
    governToolCalls: Schema<boolean, boolean>;
    failureEscalationThreshold: Schema<number, number>;
  }>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    observeToolResults: Schema<boolean, boolean>;
    governToolCalls: Schema<boolean, boolean>;
    failureEscalationThreshold: Schema<number, number>;
  }>>;
}>>;
/** 插件名称 */
declare const name = "dsh-proactive";
/**
 * 插件入口：初始化全部模块、编排 10 步链路、注册 12 Tool、登记 cleanup
 */
declare function apply(ctx: Context, config: Partial<SchedulerConfig>): void;
/**
 * 插件导出（cordis 函数插件形态 + 静态元数据）
 * - name：注册表显示名（Function.name 只读，须用 defineProperty）
 * - Config：Schemastery 标准 schema，加载时由 cordis resolveConfig 校验并填充默认值
 * - provide：向宿主声明本插件提供的服务（供加载器诊断，不改变运行时行为）
 */
declare const pluginEntry: typeof apply & {
  name: string;
  Config: typeof Config;
  provide: string[];
};
//#endregion
export { AbstractSkillEntry, AbstractionConfig, AbstractionEngine, AbstractionStats, AccountId, ActionResult, ActiveTask, AdjustmentKnob, AdjustmentReport, AgentBase, AgentGoal, AgentKind, AgentMeta, AgentMode, AgentProposal, AgentReputation, AliasMap, AnytimeEvidenceConfig, AnytimeEvidenceRegistry, AnytimeEvidenceRegistryReport, AnytimeEvidenceStream, AnytimeEvidenceView, AnytimeVerdict, AppError, ArbitrationResult, ArchiveReport, ArmIndex, ArmStats, ArrivalPrediction, ArrivalStats, AssetKind, AssignmentCertificate, AssignmentResult, AuditEntry, AutonomyLoop, AutonomyLoopConfig, BASELINE_POLICY_PARAMS, BAYES_PRIOR_STRENGTH, BELIEF_POOL, type BackoffConfig, BayesianEstimate, BayesianOptimizer, BeliefAsset, BeliefMarket, BeliefMarketConfig, BeliefOutcome, BeliefPosition, type SettlementReport as BeliefSettlementReport, BeliefStatus, BeliefView, BenchmarkEngine, BenchmarkReport, BenchmarkResult, BenchmarkScenario, BenchmarkStats, BetReceipt, BidOrder, BoState, BoSuggestion, BottleneckOptions, BottleneckReport, type BreakerProbe, type BreakerState, type BreakerStatus, BuiltinScenarioContext, BwKArmStat, BwKBudgets, BwKCandidateView, BwKConfig, BwKRouter, BwKVerdict, CHANNEL_GROUPS, CalibrationRecord, CalibrationStatus, CanaryState, CancelReport, CapacityAdvisor, CapacityFrontier, CapacityPlan, CapacityPlanner, CapacityPlannerConfig, CascadeHandler, CausalEdge, CausalEdgeEvidence, CausalEffect, CausalExperiment, CausalExplorationRecord, CausalKernel, CausalKernelConfig, CausalNode, CausalNodeKind, CausalQuestion, CellularSheaf, ChangeEntry, ChangePayload, ChannelGroup, ChatMessage, ChatOptions, CircuitBreaker, type CircuitBreakerConfig, CircuitBreakerInfo, CircuitBreakerRegistry, CircuitState, CleansingReport, ClusterNodeConfig, ClusterStatus, CoalitionValueFunction, CognitiveEconomy, CognitiveMarket, CompletionReport, ConfidenceSequenceView, Config, ConfigError, ConformalInterval, ConformalIntervalConfig, ConformalIntervalEngine, ConformalStatus, ConsensusLogEntry, ConstructorOptionsGpSeries, ContributorProb, ControlStep, CounterfactualInsight, CoverageDriftMonitor, CoverageDriftView, CryptoEngine, CryptoError, CryptoResult, CuriosityEngine, CuriosityEngineConfig, CurvatureReport, DECAY_HALF_LIFE_DAYS, DEFAULT_ABSTRACTION_CONFIG, DEFAULT_ANYTIME_EVIDENCE_CONFIG, DEFAULT_AUTONOMY_LOOP_CONFIG, DEFAULT_BACKOFF_CONFIG, DEFAULT_BWK_CONFIG, DEFAULT_CAPACITY_CONFIG, DEFAULT_CAUSAL_CONFIG, DEFAULT_CIRCUIT_BREAKER_CONFIG, DEFAULT_CONFORMAL_CONFIG, DEFAULT_CURIOSITY_CONFIG, DEFAULT_DECISION_ENGINE_CONFIG, DEFAULT_DELIBERATION_CONFIG, DEFAULT_FREE_ENERGY_CONFIG, DEFAULT_GITTINS_CONFIG, DEFAULT_GOAL_ENGINE_CONFIG, DEFAULT_GP_CONFIG, DEFAULT_INFORMATION_GEOMETRY_CONFIG, DEFAULT_LLM_CLIENT_CONFIG, DEFAULT_METAREASONING_CONFIG, DEFAULT_META_COGNITION_CONFIG, DEFAULT_OPTIMAL_STOPPING_CONFIG, DEFAULT_PRIVACY_CONFIG, DEFAULT_REFLECTION_CONFIG, DEFAULT_ROBUST_CONFIG, DEFAULT_SAFETY_GOVERNOR_CONFIG, DEFAULT_SCIENTIST_CONFIG, DEFAULT_SHAPLEY_CONFIG, DEFAULT_SINKHORN_CONFIG, DEFAULT_STRATEGY_EVOLUTION_CONFIG, DEFAULT_TAIL_RISK_CONFIG, DEFAULT_THEORIST_CONFIG, DEFAULT_TRANSPORT_DRIFT_CONFIG, DEFAULT_TREND_FILTER_CONFIG, DEFAULT_UCT_CONFIG, DEFAULT_WORLD_MODEL_CONFIG, Decision, DecisionAction, DecisionAuditEntry, DecisionEngine, DecisionEngineConfig, DecisionEngineStats, DecisionFeedback, DecisionInsightRecord, DecisionMode, DeliberationConfig, DeliberationEngine, DeliberationResult, type SettlementReport$1 as DeliberationSettlementReport, SettlementReport$1 as SettlementReport, DesignedExperiment, DistillationReport, DistilledStrategy, DistributedSync, DistributionReport, DynamicsAssessment, DynamicsRegime, EBHEntry, EFEAction, EFEEvaluation, EProcess, EProcessSide, ESCROW, EVIDENCE_MIN_SAMPLES, EVIDENCE_RANK_BLEND, EigenResult, EmpiricalBernsteinSequence, EncryptedField, EncryptedFile, EncryptionConfig, EnergyLedger, EnergySankeyReport, EnergyTransfer, EntropyAudit, type ErrorClassification, EvaluationReport, EvidenceCensus, EvidenceCensusLayer, type EvidenceView, EvolutionCycleOutcome, EvolutionCycleReport, EvolutionReport, EvolutionStatusReport, EvolverAgent, EvolverAgentConfig, EvolverEfficiencySummary, EvolverMetrics, ExecutionError, ExecutionGrant, ExecutionPlan, ExperienceLookup, ExperimentLedgerEntry, ExplorationDispatcher, ExplorationProposal, ExplorationRecord, ExportOptions, FailureRecord, FairAllocation, FeedbackController, FeedbackControllerConfig, FirstPassageEstimate, FisherGeometryEngine, FlowNetwork, FreeEnergyConfig, FreeEnergyEngine, GCounter, GaussianProcess, GaussianProcessConfig, GittinsConfig, GittinsIndexTable, GittinsSnapshot, Goal, GoalDecomposer, GoalEngine, GoalEngineConfig, GoalStatus, GoalSubtask, GovernanceAuditEntry, GovernanceGate, GovernanceVerdict, GovernedAction, GovernorPersistState, GpCorrection, GpFitReport, GpKernelKind, GpPredict, GpSeriesCalibrator, GpdFit, GrantOutcome, GreedyResult, Habit, HealthReport, Hedge, HedgeOptions, HedgeStats, HierarchicalPrior, HillEstimate, HomeostasisBands, HomeostasisStatus, HotReloadConfig, HotReloadEngine, HotReloadEvent, HotReloadStatus, HurstResult, IAgent, IMemoryStore, IMetaCognitiveController, INCINERATOR, IOptimizer, IPolicyEvolver, IReflector, ISandbox, ISelfModel, ImaginationReport, ImprovementEvidence, IndexArm, IndexScheduler, InformationGeometryConfig, InformationGeometryReport, Insight, InterventionRecord, JointDistribution, JsonMemoryBackend, JudgeMetric, JudgeModel, KalmanFilter, KalmanModel, KalmanStepResult, KnobEffectiveness, KnowledgeAsset, KnowledgeFrontier, KnowledgeGap, KnowledgeProvider, KpiAnomaly, KpiCollector, KpiSnapshot, LEGACY_EVIDENCE_DISCOUNT, LLMClient, LLMClientConfig, LLMError, LLMResponse, LWWRegister, LedgerConfig, LedgerSnapshot, LedgerStats, Lesson, LessonExtractor, LessonProvider, ListError, ListingView, LocalLinearTrendFilter, LongTermMemory, LyapunovResult, MAX_POLICY_RULES, MIN_CALIBRATION_SAMPLES, ManagedAgent, MapElitesArchive, MapElitesConfig, MarketConfig, MarketSnapshot, MatrixCompletionOptions, MaxFlowResult, MctsChildStat, MctsDomain, MctsResult, MemoryAgent, MemoryAgentConfig, MemoryBackend, MemoryCondition, MemoryEdge, MemoryError, type MemoryEvidence, MemoryGraph, MemoryLayer, MemoryMaintainer, MemoryMatchContext, MemoryMetrics, MemoryNode, MemoryQualitySummary, MemorySearchHit, MemoryStore, MentalReport, MergeEvent, MergeStrategy, MetaCognitionBridge, MetaCognitionConfig, MetaCognitionEngine, MetaCognitiveController, MetaControllerConfig, MetaControllerState, MetaDecision, MetaStabilitySummary, MetareasoningConfig, MetricForecast, MigrationConflict, MigrationPackage, MigrationRecordVersion, MigrationReport, MigrationTool, ModelAgent, ModelConfig, ModelLongTermProfile, ModelRuntimeStatus, ModelScheduler, ModelSchedulerConfig, ModelScoreInput, ModelTaskStats, MonitorStatus, MultiScaleView, NaturalMutationResult, NetworkError, NetworkReport, NodeResult, NodeRole, NodeRunner, ORSet, OcbaAllocation, OcbaCandidate, OperationalMetrics, OpportunityStopper, OptimalStoppingConfig, Optimizer, OptimizerAgent, OptimizerAgentConfig, OptimizerConfig, POLICY_GENE_BOUNDS, POLICY_RULE_DELTA_BOUNDS, PageRankOptions, PageRankResult, Perception, PerformanceThreshold, PeriodogramReport, PlacementOutcome, PlanExecutionResult, PlanNode, PluginVersion, Policy, PolicyEvaluationMetrics, PolicyEvolutionBridge, PolicyEvolver, PolicyEvolverConfig, PolicyEvolverStatus, PolicyFitness, PolicyMatchContext, PolicyRule, PolicySimulator, PrivacyAccountant, PrivacyConfig, PrivacyRelease, PrivacyStatus, ProactiveRisk, ProceduralAction, ProceduralCondition, ProceduralConditionDimension, ProceduralMemory, ProgressBroadcaster, ProgressEvent, ProposalKind, QualityDiversityMetrics, QualityTrendPoint, QueueMetrics, QueueStation, QueueingNetworkAdvisor, QuorumAudit, RDP_ORDER, RaftConfig, RaftEngine, RationalMetareasoner, RecommendedAdjustment, RecordDecisionFeedbackParams, RecordFailureParams, RecordSuccessParams, ReflectionEngine, ReflectionEngineConfig, ReflectionVerdict, Reflector, ReflectorConfig, ReputationTier, type RetryClass, RiskControlResult, Rng, RobustMethod, RobustRead, RobustStatisticsConfig, RobustStream, RobustTimeoutConfig, RollbackResult, RootCauseCategory, RoyaltyPayout, RuntimeEvent, RuntimeVerifier, RuntimeVerifierStatus, SIGNAL_GLOBAL_SUCCESS, SIGNAL_GLOBAL_SUCCESS_ALIAS, STRATEGY_BEHAVIOR_SPACE, SafeEnvelopeInfo, SafetyGovernor, SafetyGovernorConfig, SafetyMonitor, SafetyPattern, SafetySpec, Sandbox, SandboxConfig, SandboxTask, SankeyLink, SankeyNode, SankeyTotals, ScalarGeneKey, SchedulerConfig, SchedulerPolicyParams, SchedulerService, SchedulerTaskContext, SchedulingInsight, ScientistConfig, ScientistMind, SelfModel, SelfModelCollectors, SelfModelConfig, SemanticConclusion, SemanticCondition, SemanticConditionDimension, SemanticMemory, Sentinel, SentinelConfig, SentinelStatus, ShamirShare, ShapleyAttribution, ShapleyAttributionEngine, ShapleyConfig, ShapleyReport, SheafAnchorSpec, SheafConsensusReport, SheafEdgeSpec, SheafVertexSpec, Signal, SignalBatch, SignalEnrichment, SignalHistoryStats, SignalSourceConfig, SimCalibration, SimCalibrationEntry, SimModelStatus, SinkhornConfig, SinkhornResult, Skill, SmoothedPoint, SpectralPeak, SqliteMemoryBackend, StationMetrics, StepEvaluation, StoppingVerdict, StrategistVerdict, StrategyApplier, StrategyBehaviorDim, StrategyEvolutionConfig, StrategyEvolutionEngine, StrategyGenes, StrategyGenesLike, StrategyGenome, StrategyPerformanceSummary, SubmodularFunction, SubmodularityAudit, SubtaskDispatcher, SuccessfulPlanRecord, SymbiosisBridge, SymbiosisBridgeConfig, SymbiosisBridgeHook, SymbiosisConfig, SymbiosisRuntime, SymbiosisTickReport, SyncBatch, SyncConflict, SyncLogEntry, SyncNodeConfig, SyncState, SynergyPair, SystemMetrics, SystemStabilitySummary, SystemicRiskAdvisor, SystemicRiskAssessment, SystemicRiskConfig, SystemicRiskMonitor, TREASURY, TailQuantiles, TailRiskAdvisor, TailRiskConfig, TailRiskMonitor, TailRiskReport, TaskExecutor, TaskExecutorConfig, TaskPatternMemory, TenantConfig, TenantManager, TenantRegistry, TenantRuntime, TheoristConfig, TheoristEngine, Theory, TheoryFrontier, TheoryMember, TheoryPrediction, TickReport, TimeoutError, ToolDefinition, ToolError, ToolRegistry, TopicNode, TopographyReport, TradeListener, TradeRecord, TransferError, TransferReceipt, TransitionPosterior, TransportDriftConfig, TransportDriftEvent, TransportDriftMonitor, TransportDriftView, TrendFilterConfig, TrendMetric, TrendStepRead, TrendSummary, TuningAction, TypeCorrelation, UctConfig, UctSearch, VariationalReport, ViolationReport, ViolationSeverity, WaveletDecomposition, WeightedCoverage, WorldModel, WorldModelConfig, WorldModelSummary, abortableSleep, apply, assignBatch, assignmentCertificate, attachDashboard, backoffDelayMs, backwardInduction, bernoulliKL, betaEntropy, bottleneckDistance, bottleneckInsight, brussOddsIndex, bruteForceAssignment, bruteForceBest, bruteForceMinCut, bruteForceMinIntersection, budgetedGreedy, buildCalibrationFromMemory, buildEnergySankey, buildPatternFingerprint, byzantineFeasible, capacityFrontier, catoniMean, chiSquareQuantile, cholesky, choleskyLower, classifyError, cleanseCorrelation, coalitionValue, completeMatrix, completedEntry, computeHomeostasis, conditionNumber, conformalQuantile, correlationFromSeries, cosineSimilarity, coverageFromTokens, crdtConvergenceAudit, createBaselinePolicy, createMemoryBackend, curvatureEstimate, cvar, cvarCoherenceAudit, cvarMinForm, dareIterate, dareScalarClosedForm, decayFactor, decompose, pluginEntry as default, defaultSafetySpecs, determinismScore, digamma, distillRetention, dpHistogram, dpMeanClamped, dpValue, dynamicsRegime, eBenjaminiHochberg, empiricalQuantile, emptyMemoryStore, entropyAudit, erlangC, evaluateMemoryCondition, evidenceRankScore, expectedImprovement, extractReplayTasks, fairDomainBudget, fairnessAudit, fft, firstPassageCooldown, fisherGUpperTail, fitGpd, fixedSampleUpperBound, gamblerRuin, gaussianNoise, generateAdversarialTasks, gpdCdf, h0Persistence, haarDecompose, haarReconstruct, hedgeMultiplier, hillEstimator, hurstExponent, ifft, informationBottleneck, initEvidence, inverseGaussianCdf, inverseGaussianPdf, isTradeListener, jacksonIndependenceAudit, jacobiEigensym, kingmanWq, laplaceNoise, largestLyapunov, lazyGreedy, lessonsToInsights, listingsOf, littleCheck, lnGamma, lqrGain, lyapunovCertificate, madSigma, majorityQuorumAudit, matchesMemoryConditions, maxFlow, maxMinFair, meanExcessCurve, medianOfMeans, minCutCertificate, minimalStableServers, modelAgentId, modelSignalKey, monteCarloCorrectSelection, mpEdges, mulberry32, multiScaleView, name, normalCdf, normalPdf, normalizePolicyParams, observeEvidence, ocbaAllocate, overlapSheaf, pageRank, parseJSONLoose, participationRatio, periodogram, perturbNumbers, policyParamsWithinBounds, policyRuleMatches, potQuantiles, prophetValue, quantile, quantileSorted, raftSafetyAudit, randomWalkSteadyState, rdpToEpsilon, readEvidence, reflectionMaxProb, renderSankeyHtml, resolveEffectiveParams, robustExceedance, robustTimeout, round, sampleBeta, samuelCahnRule, sanitizeMemoryStore, scalarAgreementSheaf, scoreModelWithPolicy, seasonalFactor, secretarySkipCount, segment, selectRiskControlledThreshold, setChineseTokenizer, shamirCombine, shamirSplit, shapleyValues, shrinkageCovariance, sinkhorn, solveAssignment, solveAssignmentMax, solveCholesky, sqliteAvailable, sqlitePathFor, staticEtaFor, staticRegretBound, stitchedCsRadius, strategyBehaviorDescriptor, submodularityCheck, tandemNetwork, timeVaryingEta, toSparseVector, tokenizeChinese, topInfluential, topographyInsight, trackingRegretBound, wasserstein1D, wassersteinBarycenter1D, wassersteinRobustMean, weightedMaxMinFair, wilsonLowerBound };