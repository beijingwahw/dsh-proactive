/**
 * llm-client.ts — OpenAI 兼容 LLM 调用客户端（集成层基础设施）
 *
 * 职责：为战略决策（strategist）与执行器（executor）提供统一的模型调用入口
 * - OpenAI 兼容 /v1/chat/completions 协议（fetch 实现，零第三方依赖）
 * - 单请求超时控制（AbortController）
 * - 指数退避重试（仅对可重试错误：429 / 5xx / 网络错误 / 超时）
 * - 每模型并发度控制（信号量 + 排队队列，超限排队而非拒绝）
 * - 结构化 JSON 输出解析（容错代码块包裹 / 前后杂散文本）
 * - 调用统计（次数、成功率、平均延迟、token 消耗、成本估算）
 *
 * 升级点（相对裸 fetch 调用的质的提升）：
 * 1. 并发信号量带排队队列与队列上限，过载时快速失败而非无限堆积
 * 2. 重试预算与退避抖动（jitter）避免多客户端同步重试风暴
 * 3. fetchImpl 可注入，冒烟测试可完全离线模拟模型端点
 * 4. 成本估算内置：按 costPerKToken × tokensUsed 计算
 *
 * 第三轮模块域 A14 升级（世界性）：
 * A14-1 重试去相关抖动：退避从「指数 × 半幅随机」升级为「全抖动 + 去相关
 *       抖动」混合（exponential envelope + full jitter + AWS decorrelated
 *       jitter），上限钳位 retryMaxDelay；连续重试链的延迟互相去相关，
 *       多客户端同时失败后的重试到达时刻被打散（消同步雪崩）。
 *       随机源（jitterRandom）与睡眠（sleepImpl）均可注入——退避时刻表
 *       可在虚拟时钟上逐位复现（确定性验证，零真定时器）。
 * A14-2 令牌账户与硬预算：每次调用按模型价目表记账（成功记实测 usage，
 *       失败记输入估算），账户余额耗尽后新调用被熔断拒绝（在途调用
 *       完成并如实入账），onExhausted 上报；getTokenAccount 精确可查。
 * A14-3 流式背压：chatStream 异步生成器经有界泵（BoundedPump）拉取
 *       SSE 流——缓冲超过高水位即暂停对传输层的 read() 拉取，消费者
 *       慢时缓冲有界（highWatermark），快时全量按序交付、零丢失。
 * A14-4 调用审计：每次调用（模型、时延、token、重试、结局）结构化
 *       记入有界环形日志，getAuditLog() 导出（含预算熔断拒绝记录）。
 *
 * 第四轮模块域 R4-A14 升级（全新维度，全部 opt-in、缺省零漂移）：
 * R4-1 模型能力探测：probeModel() 以确定性探测问题集（结构化输出 /
 *       长上下文召回 / 工具调用）逐项打能力位，响应特征决定 pass/fail，
 *       探测失败（异常 / 端点拒绝）的能力位一律 false 不虚标；能力位
 *       经 getModelCapabilities / getModelStatuses().capabilities 暴露，
 *       selectModelsByCapabilities() 供调度消费。
 * R4-2 请求优先级队列：并发上限下的优先级排队（priorityQueue opt-in）
 *       ——高优先先出、同优先 FIFO；低优先「未开始」的排队可被高优先
 *       抢占槽位继承权（priorityPreemptions 计数）；排队超时
 *       （queueTimeoutMs / defaultQueueTimeoutMs）诚实拒绝（QUEUE_TIMEOUT，
 *       不虚耗槽位、审计如实）。缺省关闭：行为与升级前逐位一致（纯 FIFO）。
 * R4-3 流式中断续传：chatStreamResumable() 在长流中断后携带已接收前缀
 *       发起续写请求（assistant 前缀 + 续写指令含前缀末尾原文），接缝
 *       最小校验 joinContinuationSeam（前缀末尾一致性：重叠剥离 / 重启
 *       检测）；续写被协议拒绝或模型无视前缀重启时诚实回退全量重试
 *       （restart 标记块显式告知消费者重置，绝不静默重复交付）。
 * R4-5 成本对账（加分项）：costLedger opt-in 记账（模型 × 任务类型 ×
 *       时刻），reconcile() 周期性出账——按时段桶 / 模型 / 任务类型聚合，
 *       与令牌硬预算账户、模型统计、外部账单（reportExternalCost）四路
 *       交叉核对，价目表演化（重定价）与账目差异一律告警。
 */

import { AppError, NetworkError, TimeoutError } from './errors.js';
import { RobustStream } from './core/robust-statistics.js';
import { robustTimeout } from './core/robust-decisions.js';

/** 聊天消息（OpenAI 兼容格式） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/** 模型端点配置（cordis.patch.yml models[] 条目 + strategistModel 的公共形态） */
export interface ModelConfig {
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
  /** 每千 token 成本（美元），用于成本估算与令牌账户计价 */
  costPerKToken?: number;
  /** 上下文窗口大小（token） */
  contextWindow?: number;
  /** 初始能力画像 */
  initialCapabilities?: { taskScores?: Record<string, number>; [key: string]: any };
}

/**
 * A14-2 令牌账户状态（硬预算记账快照）
 */
export interface TokenAccountStatus {
  /** 预算上限（token）；Infinity 表示未设置预算（只记账不熔断） */
  limit: number;
  /** 已入账 token（成功调用记实测 usage；失败调用记输入估算） */
  spentTokens: number;
  /** 已入账成本（美元，按各模型 costPerKToken 计价） */
  spentCost: number;
  /** 剩余额度（limit - spent；可为负——在途调用完成后如实入账） */
  remainingTokens: number;
  /** 已入账调用次数（成功 + 失败终态） */
  meteredCalls: number;
  /** 因预算耗尽被熔断拒绝的调用次数 */
  rejectedCalls: number;
  /** 账户是否已耗尽（spent >= limit） */
  exhausted: boolean;
}

/**
 * A14-4 调用审计条目（每次调用的结构化记录，环形有界）
 */
export interface CallAuditEntry {
  /** 记账时刻（毫秒，可注入时钟） */
  ts: number;
  /** 模型 id */
  model: string;
  /** 调用形态：非流式 / 流式 */
  kind: 'chat' | 'chat-stream';
  /** 结局：成功 / 失败 / 预算熔断拒绝 / 消费者提前中止流 */
  outcome: 'success' | 'failure' | 'rejected' | 'aborted';
  /** 总耗时（毫秒，含重试与排队） */
  latencyMs: number;
  /** 总尝试次数（首调 + 重试） */
  attempts: number;
  /** 实际重试次数（attempts - 1） */
  retries: number;
  /** 本次记账 token（成功为实测 usage；失败为输入估算；拒绝为 0） */
  tokensUsed: number;
  /** 本次记账成本（美元） */
  cost: number;
  /** 失败时的错误码（LLM_ERROR / TIMEOUT_ERROR / NETWORK_ERROR / BUDGET_EXHAUSTED…） */
  errorKind?: string;
  /** 失败时的 HTTP 状态码（如有） */
  errorStatus?: number;
  /** 流式调用交付的 chunk 数（仅 chat-stream） */
  streamChunks?: number;
  /** 记账后的账户累计消耗（token） */
  budgetSpentTokens?: number;
}

/**
 * A14-3 流式增量 chunk（chatStream 产出）
 */
export interface StreamChunk {
  /** 增量文本（可能为空串，如纯 usage 帧） */
  delta: string;
  /** chunk 序号（本次调用内 0 起，单调递增） */
  index: number;
  /** 流结束标记（最后一个 chunk 为 true） */
  done?: boolean;
  /** 端点返回的 usage（通常仅最后一个数据帧携带） */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

// ───────────────────── R4-A14-1 模型能力探测 ─────────────────────

/** R4-1 探测项 id（确定性探测问题集，逐项对应一个能力位） */
export type CapabilityProbeId = 'structured-output' | 'long-context' | 'tool-calling';

/** R4-1 单项探测结果（pass/fail 由响应特征判定；失败不虚标） */
export interface CapabilityProbeResult {
  id: CapabilityProbeId;
  /** 是否通过（探测异常 / 端点拒绝 / 响应特征不符 → false） */
  passed: boolean;
  /** 判定依据（人可读；失败时含原因，供审计与告警） */
  detail: string;
  /** 该探测项耗时（毫秒，注入时钟口径） */
  latencyMs: number;
}

/** R4-1 能力位（探测结论；供调度消费的最小契约） */
export interface ModelCapabilityBits {
  /** 长上下文：埋点召回探测通过 */
  longContext: boolean;
  /** 工具调用：tools 参数被接受且返回 tool_calls */
  toolCalling: boolean;
  /** 结构化输出：严格 JSON 指令下产出可解析 JSON */
  structuredOutput: boolean;
}

/** R4-1 一次 probeModel 的完整报告 */
export interface ModelCapabilityReport {
  model: string;
  /** 探测完成时刻（毫秒，注入时钟口径） */
  probedAt: number;
  /** 探测总耗时（毫秒） */
  durationMs: number;
  /** 逐项结果（按执行顺序） */
  probes: CapabilityProbeResult[];
  /** 能力位（探测失败的能力恒为 false，绝不虚标） */
  capabilities: ModelCapabilityBits;
  /** 通过项数 / 总项数 */
  passedCount: number;
  totalCount: number;
}

// ───────────────────── R4-A14-3 流式中断续传 ─────────────────────

/** R4-3 续传配置（chatStreamResumable 第四参；全部缺省） */
export interface StreamResumeOptions {
  /** 中断后最多续传尝试次数（默认 1） */
  maxResumeAttempts?: number;
  /** 续传不可行时最多全量重试次数（默认 1） */
  maxRestartAttempts?: number;
  /** 接缝重叠剥离上限字符数（默认 96） */
  seamOverlapMaxChars?: number;
  /** 重启检测比对字符数（默认 32；≥8 生效） */
  restartDetectChars?: number;
}

/** R4-3 可续传流的增量 chunk（在 StreamChunk 上附流阶段元数据） */
export interface ResumableStreamChunk extends StreamChunk {
  /** 该 chunk 所属流阶段：初次 / 续写 / 全量重试 */
  phase?: 'initial' | 'continuation' | 'restart';
  /** true = 全量重试开始：消费者应重置已累积文本，此后从头交付 */
  restart?: boolean;
  /** 接缝修复剥离的重叠字符数（仅续写首个内容块可能携带） */
  seamTrimmed?: number;
}

/** R4-3 可续传流终值（LLMResponse + 恢复统计） */
export interface ResumableStreamResult extends LLMResponse {
  /** 实际发生的续传（接续前缀）次数 */
  resumes: number;
  /** 实际发生的全量重试次数 */
  restarts: number;
  /** 最终完成阶段 */
  finalPhase: 'initial' | 'continuation' | 'restart';
}

/** R4-3 接缝裁决结果（纯函数 joinContinuationSeam 产出） */
export interface SeamDecision {
  /** 接缝处理后的续写首块文本 */
  text: string;
  /** clean=自然衔接 / overlap-trimmed=重叠剥离 / restart=模型无视前缀从头重写 */
  kind: 'clean' | 'overlap-trimmed' | 'restart';
  /** 剥离的重叠字符数（kind=overlap-trimmed 时 ≥1） */
  trimmed?: number;
}

// ───────────────────── R4-A14-5 成本对账 ─────────────────────

/** R4-5 账本条目（每次入账一行；模型 × 任务类型 × 时刻） */
export interface CostLedgerEntry {
  /** 入账时刻（毫秒，注入时钟口径） */
  ts: number;
  model: string;
  /** 任务类型（ChatOptions.taskType，缺省 'default'；探测调用为 'capability-probe'） */
  taskType: string;
  /** 调用形态 */
  kind: 'chat' | 'chat-stream';
  /** 成功记实测 usage / 失败记输入估算（与令牌账户同源同刻） */
  outcome: 'success' | 'failure';
  tokens: number;
  /** 入账成本（美元，按入账时价目表） */
  cost: number;
}

/** R4-5 外部账单记录（宿主上报供应商计费口径，用于交叉核对） */
export interface ExternalCostRecord {
  /** 账单来源标识（如 'provider-invoice'） */
  source: string;
  model: string;
  periodStart: number;
  periodEnd: number;
  tokens: number;
  cost: number;
}

/** R4-5 交叉核对单项 */
export interface CostCrossCheck {
  name: 'ledger-vs-account' | 'ledger-vs-model-stats' | 'repricing' | 'internal-vs-external';
  status: 'ok' | 'mismatch';
  ledgerValue: number;
  otherValue: number;
  delta: number;
  detail?: string;
}

/** R4-5 对账报告 */
export interface CostReconciliationReport {
  generatedAt: number;
  /** 对账窗口（缺省全量账本） */
  window?: { from: number; to: number };
  /** 时段桶宽（毫秒） */
  bucketMs: number;
  byModel: Array<{ model: string; calls: number; tokens: number; cost: number }>;
  byTaskType: Array<{ taskType: string; calls: number; tokens: number; cost: number }>;
  byBucket: Array<{ bucketStart: number; tokens: number; cost: number }>;
  /** 对账时刻的令牌硬预算账户快照 */
  account: TokenAccountStatus;
  crossChecks: CostCrossCheck[];
  /** 差异告警（人可读；每条 mismatch 交叉核对一条） */
  alerts: string[];
}

/** R4-2 单模型排队指标（命名避开 core/capacity-planning 的 QueueMetrics） */
export interface LLMQueueMetrics {
  model: string;
  /** 当前排队数 */
  waiting: number;
  /** 按优先级分层的排队数（键为优先级数字字符串，降序展示） */
  byPriority: Array<{ priority: number; waiting: number }>;
  /** 因排队超时被诚实拒绝的调用数 */
  queueTimeouts: number;
  /** 高优先级抢占低优先级未开始槽位继承权的次数（相对 FIFO 的换序次数） */
  priorityPreemptions: number;
}


/**
 * A14-1 退避调度配置（纯函数 nextRetryDelay 的入参）
 */
export interface RetryBackoffConfig {
  /** 基础延迟（毫秒） */
  baseDelay: number;
  /** 钳位上限（毫秒） */
  maxDelay: number;
}

/** A14-3 有界泵配置 */
export interface BoundedPumpOptions {
  /** 高水位：缓冲达到该条数即暂停生产端拉取 */
  highWatermark: number;
  /** 低水位：消费后低于该条数恢复生产端拉取（默认高水位一半） */
  lowWatermark?: number;
}

/** LLM 客户端全局配置 */
export interface LLMClientConfig {
  /** 默认单请求超时（毫秒），可被单次调用覆盖 */
  timeout: number;
  /** 默认最大重试次数（不含首次调用） */
  maxRetries: number;
  /** 重试基础延迟（毫秒），指数退避基数 */
  retryBaseDelay: number;
  /**
   * A14-1 重试退避钳位上限（毫秒，默认 30_000）。
   * 全抖动 + 去相关抖动的混合调度永远不超过该值。
   */
  retryMaxDelay?: number;
  /** 默认每模型并发上限 */
  defaultMaxConcurrency: number;
  /** 每模型排队队列上限，超出直接拒绝 */
  maxQueueSize: number;
  /** fetch 实现注入点（测试/自定义运行时） */
  fetchImpl?: typeof fetch;
  /**
   * A14-1 抖动随机源注入点（默认 Math.random）。
   * 验证脚本注入种子化 LCG 即可在虚拟时钟上逐位复现退避时刻表。
   */
  jitterRandom?: () => number;
  /**
   * A14-1 睡眠实现注入点（默认 setTimeout）。测试注入即时 resolve 的
   * 假 sleep 即可确定性推进重试链（零真定时器、零墙钟等待）。
   */
  sleepImpl?: (ms: number) => Promise<void>;
  /**
   * A14-2 令牌硬预算：limit 为 token 上限；账户余额耗尽后新调用被熔断
   * 拒绝（在途调用完成并如实入账，账户可小幅越限——这是「硬熔断新
   * 调用、不杀在途」的既定语义）；onExhausted 在耗尽被观测到时上报。
   */
  tokenBudget?: { limit: number; onExhausted?: (status: TokenAccountStatus) => void };
  /**
   * A14-4 调用审计环形缓冲条数（默认 256，0 关闭审计）。
   */
  auditMaxEntries?: number;
  /**
   * A14-3 流式背压：chatStream 有界泵高水位（默认 32 个 chunk）。
   */
  streamHighWatermark?: number;
  /** 时钟注入点（默认 Date.now；审计时间戳与延迟测量统一走它） */
  nowImpl?: () => number;
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
  robustLatency?: { alpha?: number; maxSamples?: number };
  /**
   * R4-2 请求优先级队列（opt-in，缺省 undefined = 纯 FIFO 零漂移）。
   * 启用后：并发槽位释放时按「优先级降序、同优先级到达序」继承；
   * 低优先排队者未开始的槽位继承权可被更高优先级抢占（计数
   * priorityPreemptions）；排队超过 defaultQueueTimeoutMs（可被单次
   * 调用 queueTimeoutMs 覆盖）诚实拒绝（QUEUE_TIMEOUT，不虚耗槽位）。
   */
  priorityQueue?: { defaultQueueTimeoutMs?: number };
  /**
   * R4-2/R4-5 定时器注入点（默认 setTimeout/clearTimeout，自动 unref）。
   * 排队超时与成本对账周期均经它调度——验证脚本注入虚拟定时器即可
   * 在零真定时器下确定性驱动（时钟配合 nowImpl）。
   */
  setTimerImpl?: (callback: () => void, ms: number) => unknown;
  clearTimerImpl?: (handle: unknown) => void;
  /**
   * R4-5 成本对账账本（opt-in，缺省不记账零开销零漂移）。启用后每次
   * 入账同步落一行账本（模型 × 任务类型 × 时刻），reconcile() 出账；
   * autoReconcileMs 配置后按周期自动对账并回调 onReconciliation。
   */
  costLedger?: {
    /** 时段桶宽（毫秒，默认 3_600_000） */
    bucketMs?: number;
    /** 账本条数上限（默认 4096，超出挤掉最旧并如实在对账中标注截断） */
    maxEntries?: number;
    /** 周期自动对账间隔（毫秒；不配置则仅手动 reconcile） */
    autoReconcileMs?: number;
    /** 周期对账回调（差异告警一并携带） */
    onReconciliation?: (report: CostReconciliationReport) => void;
  };
}

/** 单次调用选项 */
export interface ChatOptions {
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
  /**
   * R4-2 请求优先级（数值大者优先；缺省 0）。仅在客户端配置
   * priorityQueue 后生效——未启用时优先级被忽略（纯 FIFO 零漂移）。
   */
  priority?: number;
  /**
   * R4-2 本次调用排队超时（毫秒；仅入队后计时）。覆盖 priorityQueue
   * .defaultQueueTimeoutMs；超时诚实拒绝（QUEUE_TIMEOUT）。
   */
  queueTimeoutMs?: number;
  /**
   * R4-5 任务类型标签（成本对账聚合维度；缺省 'default'）。
   * probeModel 自动携带 'capability-probe'。
   */
  taskType?: string;
}

/** 调用结果 */
export interface LLMResponse {
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
  /**
   * R4-1 工具调用返回（端点在 message.tool_calls 回传时原样透出）。
   * 仅当响应携带非空 tool_calls 时存在——其余调用该键不出现（零漂移）。
   */
  toolCalls?: Array<Record<string, any>>;
}

/** 单模型运行时状态（供 model_dashboard Tool 消费） */
export interface ModelRuntimeStatus {
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
  /**
   * R4-1 能力位（仅当该模型已 probeModel 探测过时出现，否则键不存在
   * ——零漂移）；调度方按位过滤消费。
   */
  capabilities?: ModelCapabilityBits;
}

/** 模型调用错误（携带 HTTP 状态与可重试标记） */
export class LLMError extends AppError {
  public readonly status?: number;
  public readonly retryable: boolean;

  constructor(message: string, status?: number, retryable = false, details?: Record<string, unknown>) {
    super(message, 'LLM_ERROR', details);
    this.status = status;
    this.retryable = retryable;
  }
}

/** 默认配置 */
export const DEFAULT_LLM_CLIENT_CONFIG: LLMClientConfig = {
  timeout: 60_000,
  maxRetries: 2,
  retryBaseDelay: 500,
  defaultMaxConcurrency: 3,
  maxQueueSize: 32,
};

/** A14-1 默认退避钳位（毫秒） */
const DEFAULT_RETRY_MAX_DELAY = 30_000;
/** A14-4 默认审计环形缓冲条数 */
const DEFAULT_AUDIT_MAX_ENTRIES = 256;
/** A14-3 默认流式有界泵高水位（chunk 条数） */
const DEFAULT_STREAM_HIGH_WATERMARK = 32;

// ── R4-A14 缺省常量 ──
/** R4-1 长上下文探测：埋点文本目标长度（字符，≈6k token） */
const PROBE_LONG_CONTEXT_CHARS = 24_000;
/** R4-1 长上下文探测：埋点位置（填充文本长度比例） */
const PROBE_MARKER_POSITION = 0.7;
/** R4-1 长上下文探测：埋点暗号（确定性，不随机——可复现） */
const PROBE_MARKER = 'DSH-PROBE-CODEWORD-7Q4Z9';
/** R4-3 续写指令携带的前缀末尾长度（字符） */
const RESUME_TAIL_CHARS = 32;
/** R4-5 默认账本条数与时段桶宽 */
const DEFAULT_LEDGER_MAX_ENTRIES = 4096;
const DEFAULT_COST_BUCKET_MS = 3_600_000;

/**
 * A14-1 混合抖动退避调度（纯函数，确定性可测）。
 *
 * 第 attempt 次重试（0 起）在给定 prevDelay（上一次实际睡眠的延迟，
 * 链首传 baseDelay）下的下一次延迟：
 *
 * - 指数包络：envelope = min(maxDelay, baseDelay · 2^attempt)
 * - 全抖动（full jitter）：f ~ U(0, envelope)
 * - 去相关抖动（AWS decorrelated jitter）：d ~ U(baseDelay, min(maxDelay, 3·prevDelay))
 * - 混合上界：ceiling = min(maxDelay, max(envelope, d的上界))——包络与去相关
 *   链上界取较大者（首拍包络=base 时去相关分量可达 3·base，若仅以指数包络
 *   钳位会把近半质量堆在同一个整数值上形成「准同拍」，雪崩消解不彻底）
 * - delay = clamp((f + d) / 2, 1, ceiling)
 *
 * 性质（对任意 rand ∈ [0,1)²链均成立）：
 * - 有界：1 ≤ delay ≤ ceiling ≤ maxDelay —— 最大延迟被硬钳位；
 * - 期望有界：E[delay] ≤ (envelope/2 + maxDelay) / 2 ≤ 0.75 · maxDelay；
 * - 分散：支撑集覆盖 [base/2, ceiling] 连续铺开（触顶仅发生在 maxDelay
 *   硬钳位处，AWS 原语义），且 d 依赖各自链历史——多并发客户端的重试
 *   时刻互相去相关，同步雪崩（固定退避下 M 个客户端同拍重试）被打散。
 */
export function nextRetryDelay(
  attempt: number,
  prevDelay: number,
  config: RetryBackoffConfig,
  rand: () => number,
): number {
  const cap = Math.max(1, config.maxDelay);
  const base = Math.max(1, config.baseDelay);
  const envelope = Math.min(cap, base * 2 ** Math.min(Math.max(attempt, 0), 62));
  const full = rand() * envelope;
  const decorHigh = Math.min(cap, Math.max(base, Math.max(prevDelay, 0) * 3));
  const decorrelated = base + rand() * (decorHigh - base);
  // 混合上界取指数包络与去相关链上界的较大者（仍被 cap 硬钳）：
  // 仅以指数包络钳位时首拍近半样本堆在同一整数值（准同拍），雪崩消解不彻底
  const ceiling = Math.min(cap, Math.max(envelope, decorHigh));
  return Math.max(1, Math.min(ceiling, Math.round((full + decorrelated) / 2)));
}

/**
 * R4-3 接缝最小校验（纯函数，确定性可测）：续写首块与前缀末尾的一致性裁决。
 *
 * 判定顺序：
 * 1. 重启检测：续写开头与「整个前缀的开头」逐字符一致（≥ min(8,
 *    restartDetectChars) 字符且前缀明显长于比对窗）——模型无视前缀从头
 *    重写 → restart（不可续传，须全量重试口径处理）。
 * 2. 重叠剥离：续写开头重复了前缀末尾（LLM 续写最常见的接缝重复）——
 *    取最大重叠 k（≤ seamOverlapMaxChars）剥离，前缀末尾与续写开头
 *    「前缀末尾一致性」由此保证（拼接处无重复、无跳变）。
 * 3. 其余视为 clean（自然衔接；本层不做语义级判断——是最小检查）。
 */
export function joinContinuationSeam(
  prefix: string,
  continuation: string,
  opts: { seamOverlapMaxChars: number; restartDetectChars: number },
): SeamDecision {
  if (continuation.length === 0) return { text: '', kind: 'clean' };
  // 1. 重启检测（比对窗至少 8 字符，避免短前缀的平凡误判）
  const n = Math.min(Math.max(opts.restartDetectChars, 8), prefix.length, continuation.length);
  if (n >= 8 && prefix.length > opts.restartDetectChars && prefix.slice(0, n) === continuation.slice(0, n)) {
    return { text: continuation, kind: 'restart' };
  }
  // 2. 重叠剥离（最大后缀-前缀重叠）
  const maxK = Math.min(opts.seamOverlapMaxChars, prefix.length, continuation.length);
  for (let k = maxK; k >= 1; k -= 1) {
    if (prefix.endsWith(continuation.slice(0, k))) {
      return { text: continuation.slice(k), kind: 'overlap-trimmed', trimmed: k };
    }
  }
  // 3. 自然衔接
  return { text: continuation, kind: 'clean' };
}

/**
 * A14-3 有界泵：把「快生产者 → 慢消费者」的中间缓冲钳在高水位。
 *
 * 生产端（producer，一次拉取可返回一批）由 start() 驱动持续拉取并入队；
 * 队列达到 highWatermark 即暂停拉取（不再调用 producer —— 对 fetch 流
 * 即不再 read()），消费者经 next() 取走并降到 lowWatermark 以下后恢复。
 * 因此任意时刻未消费缓冲 ≤ highWatermark（+1 批在途），内存有界；
 * 数据不丢弃、顺序保持——这是背压（backpressure），不是丢弃。
 * producerPulls / maxBufferedObserved 供验证脚本直接读取「拉取口径」。
 */
export class BoundedPump<T> {
  private readonly high: number;
  private readonly low: number;
  private readonly queue: T[] = [];
  private ended = false;
  private stopped = false;
  private failure: { err: unknown } | undefined;
  private drainWaiter: (() => void) | null = null;
  private itemWaiters: Array<() => void> = [];
  private running = false;
  /** 生产端拉取次数（每调用 producer 一次 +1；背压生效时不再增长） */
  public producerPulls = 0;
  /** 观测到的最大瞬时缓冲（≤ highWatermark + 单批超额） */
  public maxBufferedObserved = 0;

  constructor(
    private readonly producer: () => Promise<T[] | undefined>,
    options: BoundedPumpOptions,
  ) {
    this.high = Math.max(1, Math.floor(options.highWatermark));
    this.low = Math.max(1, Math.min(this.high, Math.floor(options.lowWatermark ?? Math.ceil(this.high / 2))));
  }

  /** 启动生产循环（幂等） */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  /** 消费一个元素；生产端耗尽后返回 { done: true } */
  async next(): Promise<IteratorResult<T>> {
    for (;;) {
      if (this.queue.length > 0) {
        const value = this.queue.shift()!;
        if (this.queue.length < this.low) this.resumeProducer();
        return { done: false, value };
      }
      if (this.failure) throw this.failure.err;
      if (this.ended) return { done: true, value: undefined as never };
      await new Promise<void>((resolve) => this.itemWaiters.push(resolve));
    }
  }

  /** 停止生产并唤醒所有等待者（幂等；已缓冲元素仍可被消费取走） */
  stop(): void {
    this.stopped = true;
    this.ended = true;
    this.resumeProducer();
    this.notifyItems();
  }

  /** 当前缓冲深度 */
  get buffered(): number {
    return this.queue.length;
  }

  private async run(): Promise<void> {
    try {
      while (!this.stopped) {
        if (this.queue.length >= this.high) {
          // 背压核心：缓冲满 → 暂停拉取，等消费者排水后恢复
          await new Promise<void>((resolve) => {
            this.drainWaiter = resolve;
          });
          continue;
        }
        const batch = await this.producer();
        if (this.stopped) return;
        if (batch === undefined) break;
        this.producerPulls += 1;
        if (batch.length > 0) {
          this.queue.push(...batch);
          if (this.queue.length > this.maxBufferedObserved) this.maxBufferedObserved = this.queue.length;
          this.notifyItems();
        }
      }
    } catch (err) {
      this.failure = { err };
    } finally {
      this.ended = true;
      this.notifyItems();
    }
  }

  private notifyItems(): void {
    const waiters = this.itemWaiters;
    this.itemWaiters = [];
    for (const w of waiters) w();
  }

  private resumeProducer(): void {
    const w = this.drainWaiter;
    this.drainWaiter = null;
    w?.();
  }
}

/** R4-2 排队条目（优先级 + 到达序 + 可选中止定时器） */
interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  /** 优先级（大者优先；priorityQueue 未启用时恒 0） */
  priority: number;
  /** 到达序（同优先级 FIFO 锚点，单调递增） */
  seq: number;
  /** 入队时刻（注入时钟口径；超时计量与审计用） */
  enqueuedAt: number;
  /** 排队超时定时器句柄（未配置超时则 undefined） */
  timer?: unknown;
}

/** 每模型并发控制与统计 */
interface ModelState {
  config: ModelConfig;
  maxConcurrency: number;
  active: number;
  queue: QueueEntry[];
  /** R4-2：排队到达序发生器 */
  queueSeq: number;
  /** R4-2：排队超时诚实拒绝计数 */
  queueTimeouts: number;
  /** R4-2：高优先级抢占低优先级未开始槽位继承权计数 */
  priorityPreemptions: number;
  /** R4-1：最近一次能力探测报告（未探测 undefined） */
  capabilityReport?: ModelCapabilityReport;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  totalLatency: number;
  totalTokensUsed: number;
  totalCost: number;
}

/** 可重试的 HTTP 状态码 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** 触发密钥轮换的状态码（认证失败 / 配额耗尽） */
const KEY_ROTATABLE_STATUS = new Set([401, 403, 429]);

/**
 * OpenAI 兼容 LLM 客户端
 *
 * 被 index.ts 持有：strategist 决策与 executor 子任务执行均通过本客户端调用。
 */
export class LLMClient {
  private config: LLMClientConfig;
  private models = new Map<string, ModelState>();
  private fetchImpl: typeof fetch;
  private disposed = false;
  /** 23.0：每模型稳健延迟流（仅配置 robustLatency 时创建） */
  private readonly robustStreams = new Map<string, RobustStream>();

  // ── A14-2 令牌账户（全局硬预算）──
  private tokenLimit = Number.POSITIVE_INFINITY;
  private tokenSpent = 0;
  private tokenCostSpent = 0;
  private meteredCalls = 0;
  private rejectedCalls = 0;
  private exhaustedReported = false;

  // ── A14-4 调用审计（有界环形）──
  private auditLog: CallAuditEntry[] = [];
  private readonly auditMax: number;

  // ── R4-A14-2 优先级队列 / R4-A14-5 成本对账 ──
  private readonly setTimerFn: (callback: () => void, ms: number) => unknown;
  private readonly clearTimerFn: (handle: unknown) => void;
  private readonly ledgerEnabled: boolean;
  private readonly ledgerMax: number;
  private ledger: CostLedgerEntry[] = [];
  private ledgerTruncated = false;
  private externalCosts: ExternalCostRecord[] = [];
  private reconcileTimer: unknown = null;

  constructor(config?: Partial<LLMClientConfig>) {
    this.config = { ...DEFAULT_LLM_CLIENT_CONFIG, ...config };
    this.fetchImpl = this.config.fetchImpl ?? fetch;
    this.auditMax = Math.max(0, Math.floor(this.config.auditMaxEntries ?? DEFAULT_AUDIT_MAX_ENTRIES));
    if (typeof this.config.tokenBudget?.limit === 'number' && Number.isFinite(this.config.tokenBudget.limit)) {
      this.tokenLimit = this.config.tokenBudget.limit;
    }
    // R4-2/R4-5：定时器注入（缺省真定时器，自动 unref 不阻退出）
    this.setTimerFn =
      this.config.setTimerImpl ??
      ((cb, ms) => {
        const h = setTimeout(cb, ms);
        (h as { unref?: () => void } | undefined)?.unref?.();
        return h;
      });
    this.clearTimerFn = this.config.clearTimerImpl ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    // R4-5：账本 opt-in
    this.ledgerEnabled = this.config.costLedger !== undefined;
    this.ledgerMax = Math.max(1, Math.floor(this.config.costLedger?.maxEntries ?? DEFAULT_LEDGER_MAX_ENTRIES));
    if (this.ledgerEnabled && this.config.costLedger?.autoReconcileMs && this.config.costLedger.autoReconcileMs > 0) {
      this.scheduleAutoReconcile(this.config.costLedger.autoReconcileMs);
    }
  }

  /** A14 时钟（默认 Date.now；测试注入虚拟时钟） */
  private now(): number {
    return this.config.nowImpl ? this.config.nowImpl() : Date.now();
  }

  /**
   * 注册一个模型端点（重复注册同 id 时覆盖配置并保留统计）
   * @param model 模型配置
   */
  registerModel(model: ModelConfig): void {
    const existing = this.models.get(model.id);
    this.models.set(model.id, {
      config: model,
      maxConcurrency: model.maxConcurrency ?? this.config.defaultMaxConcurrency,
      active: existing?.active ?? 0,
      queue: existing?.queue ?? [],
      queueSeq: existing?.queueSeq ?? 0,
      queueTimeouts: existing?.queueTimeouts ?? 0,
      priorityPreemptions: existing?.priorityPreemptions ?? 0,
      capabilityReport: existing?.capabilityReport,
      totalCalls: existing?.totalCalls ?? 0,
      successCount: existing?.successCount ?? 0,
      failureCount: existing?.failureCount ?? 0,
      totalLatency: existing?.totalLatency ?? 0,
      totalTokensUsed: existing?.totalTokensUsed ?? 0,
      totalCost: existing?.totalCost ?? 0,
    });
    // 23.0：启用稳健延迟统计时随注册建流（已存在则保留样本，不因重注册清零）
    if (this.config.robustLatency) this.robustStreamFor(model.id);
  }

  /**
   * 获取已注册模型配置
   * @param modelId 模型 id
   */
  getModel(modelId: string): ModelConfig | undefined {
    return this.models.get(modelId)?.config;
  }

  /** 所有已注册模型 id */
  getModelIds(): string[] {
    return [...this.models.keys()];
  }

  // ─────────────────────── A14-2 令牌账户 ───────────────────────

  /**
   * A14-2：设置（或调整）令牌硬预算上限。
   * 上调越过当前消耗时重新武装熔断上报；传 Infinity 关闭熔断（只记账）。
   */
  setTokenBudget(limit: number): void {
    this.tokenLimit = limit;
    if (limit > this.tokenSpent) this.exhaustedReported = false;
  }

  /**
   * A14-2：令牌账户快照（记账精确性可由此核对：
   * spentTokens 恒等于历次成功调用 usage 之和 + 失败调用输入估算之和）。
   */
  getTokenAccount(): TokenAccountStatus {
    const limit = this.tokenLimit;
    return {
      limit,
      spentTokens: this.tokenSpent,
      spentCost: Number(this.tokenCostSpent.toFixed(8)),
      remainingTokens: Number.isFinite(limit) ? limit - this.tokenSpent : Number.POSITIVE_INFINITY,
      meteredCalls: this.meteredCalls,
      rejectedCalls: this.rejectedCalls,
      exhausted: this.tokenSpent >= limit,
    };
  }

  /** 入账一次消耗（成功记实测，失败记估算），观测到耗尽即上报；R4-5：账本同步落行 */
  private meterTokens(
    modelId: string,
    tokens: number,
    meta?: { taskType?: string; kind: 'chat' | 'chat-stream'; outcome: 'success' | 'failure' },
  ): void {
    if (tokens <= 0) return;
    const costPerKToken = this.models.get(modelId)?.config.costPerKToken ?? 0;
    const cost = (tokens / 1000) * costPerKToken;
    this.tokenSpent += tokens;
    this.tokenCostSpent += cost;
    this.meteredCalls += 1;
    // R4-5：账本与账户同源同刻（对账的 ledger-vs-account 恒等式来源）
    if (this.ledgerEnabled) {
      this.ledger.push({
        ts: this.now(),
        model: modelId,
        taskType: meta?.taskType ?? 'default',
        kind: meta?.kind ?? 'chat',
        outcome: meta?.outcome ?? 'success',
        tokens,
        cost,
      });
      if (this.ledger.length > this.ledgerMax) {
        this.ledger.shift();
        this.ledgerTruncated = true;
      }
    }
    this.reportExhaustedIfNeeded();
  }

  /** 预算闸门：余额耗尽 → 拒绝新调用（在途调用不受影响） */
  private guardBudget(modelId: string, kind: 'chat' | 'chat-stream'): void {
    if (this.tokenSpent < this.tokenLimit) return;
    this.rejectedCalls += 1;
    const status = this.getTokenAccount();
    this.reportExhaustedIfNeeded();
    const err = new LLMError(
      `令牌预算已耗尽（spent=${this.tokenSpent} ≥ limit=${this.tokenLimit}），新调用被熔断拒绝（在途调用将完成并如实入账）`,
      undefined,
      false,
      { code: 'BUDGET_EXHAUSTED', account: status },
    );
    this.recordAudit({
      ts: this.now(),
      model: modelId,
      kind,
      outcome: 'rejected',
      latencyMs: 0,
      attempts: 0,
      retries: 0,
      tokensUsed: 0,
      cost: 0,
      errorKind: 'BUDGET_EXHAUSTED',
      budgetSpentTokens: this.tokenSpent,
    });
    throw err;
  }

  private reportExhaustedIfNeeded(): void {
    if (this.tokenSpent < this.tokenLimit || this.exhaustedReported) return;
    this.exhaustedReported = true;
    this.config.tokenBudget?.onExhausted?.(this.getTokenAccount());
  }

  // ─────────────────────── A14-4 调用审计 ───────────────────────

  /** A14-4：导出调用审计日志（最旧在前，数组拷贝） */
  getAuditLog(): CallAuditEntry[] {
    return this.auditLog.slice();
  }

  /** A14-4：清空审计日志 */
  clearAudit(): void {
    this.auditLog = [];
  }

  private recordAudit(entry: CallAuditEntry): void {
    if (this.auditMax === 0) return;
    this.auditLog.push(entry);
    if (this.auditLog.length > this.auditMax) this.auditLog.shift();
  }

  // ─────────────────────────── 调用入口 ───────────────────────────

  /**
   * 发起一次聊天补全调用（含并发控制、超时、重试）
   * @param modelId 已注册的模型 id
   * @param messages 聊天消息序列
   * @param options 单次调用选项
   * @returns 调用结果
   * @throws LLMError / TimeoutError / NetworkError
   */
  async chat(modelId: string, messages: ChatMessage[], options: ChatOptions = {}): Promise<LLMResponse> {
    const state = this.models.get(modelId);
    if (!state) throw new LLMError(`未注册的模型: ${modelId}`);
    if (this.disposed) throw new LLMError('LLM 客户端已关闭');
    // A14-2：预算闸门在排队之前——耗尽后连队列都不进
    this.guardBudget(modelId, 'chat');

    const startedAt = this.now();
    await this.acquireSlot(state, options, 'chat');
    let attempts = 0;
    let auditOutcome: 'success' | 'failure' = 'failure';
    let auditTokens = 0;
    let auditCost = 0;
    let auditError: Error | null = null;
    try {
      const response = await this.chatWithRetry(state, messages, options, (n) => (attempts = n));
      state.successCount += 1;
      auditOutcome = 'success';
      auditTokens = response.tokensUsed;
      auditCost = response.cost;
      // A14-2：成功调用按实测 usage 精确入账
      this.meterTokens(modelId, response.tokensUsed, {
        taskType: options.taskType,
        kind: 'chat',
        outcome: 'success',
      });
      return response;
    } catch (err) {
      state.failureCount += 1;
      const error = err instanceof Error ? err : new Error(String(err));
      auditError = error;
      auditTokens = estimateTokens(messages, '');
      // A14-2：失败调用按输入 token 估算入账（端点已消耗 prompt）
      this.meterTokens(modelId, auditTokens, { taskType: options.taskType, kind: 'chat', outcome: 'failure' });
      throw error;
    } finally {
      state.totalCalls += 1;
      state.totalLatency += this.now() - startedAt;
      this.releaseSlot(state);
      // A14-4：审计（无论成败）
      this.recordAudit({
        ts: this.now(),
        model: modelId,
        kind: 'chat',
        outcome: auditOutcome,
        latencyMs: this.now() - startedAt,
        attempts,
        retries: Math.max(0, attempts - 1),
        tokensUsed: auditTokens,
        cost: auditCost,
        errorKind: auditError ? (auditError instanceof AppError ? auditError.code : 'UNKNOWN') : undefined,
        errorStatus: (auditError as LLMError | null)?.status,
        budgetSpentTokens: this.tokenSpent,
      });
    }
  }

  /**
   * 发起一次调用并将输出解析为 JSON（容错代码块包裹）
   * @param modelId 已注册的模型 id
   * @param messages 聊天消息序列
   * @param options 单次调用选项
   * @returns 解析后的 JSON 对象与调用元数据
   */
  async chatJSON<T = any>(
    modelId: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<{ data: T; response: LLMResponse }> {
    const response = await this.chat(modelId, messages, options);
    const data = parseJSONLoose<T>(response.content);
    if (data === undefined) {
      throw new LLMError(`模型输出无法解析为 JSON: ${truncate(response.content, 200)}`, undefined, false, {
        modelId,
      });
    }
    return { data, response };
  }

  /**
   * A14-3：流式聊天补全（SSE），带背压的有界缓冲。
   *
   * - 消费者按自身节奏迭代（for await / next()），中间经有界泵钳位：
   *   未消费缓冲 ≤ streamHighWatermark（默认 32 chunk），满了暂停对
   *   传输层的 read() 拉取——消费者慢时内存有界、数据零丢失；
   * - 连接建立阶段（收到首个 chunk 前）按与 chat 相同的混合抖动退避
   *   重试可重试错误；一旦开始交付即不再重试（避免重复输出）；
   * - 生成器 return 值为 LLMResponse（token/成本/时延记账与 chat 同口径）。
   *
   * @param modelId 已注册的模型 id
   * @param messages 聊天消息序列
   * @param options 单次调用选项
   */
  async *chatStream(
    modelId: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): AsyncGenerator<StreamChunk, LLMResponse, void> {
    const state = this.models.get(modelId);
    if (!state) throw new LLMError(`未注册的模型: ${modelId}`);
    if (this.disposed) throw new LLMError('LLM 客户端已关闭');
    this.guardBudget(modelId, 'chat-stream');

    const maxRetries = options.maxRetries ?? this.config.maxRetries;
    const startedAt = this.now();
    await this.acquireSlot(state, options, 'chat-stream');

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let chunkCount = 0;
    let content = '';
    let usage: StreamChunk['usage'];
    let attempts = 0;
    let outcome: CallAuditEntry['outcome'] = 'aborted';
    let failure: { err: Error; status?: number } | null = null;
    const timeout = options.timeout ?? this.getCvarTimeout(modelId) ?? this.config.timeout;
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref?.();

    try {
      // ── 阶段一：建立流连接（可重试，与 chat 同口径的混合抖动退避）──
      let opened: Awaited<ReturnType<LLMClient['openStream']>>;
      let lastError: Error | null = null;
      let keyAttempt = 0;
      const rand = this.config.jitterRandom ?? Math.random;
      const sleepFn = this.config.sleepImpl ?? sleep;
      let prevDelay = Math.max(1, this.config.retryBaseDelay);

      for (let attempt = 0; ; attempt += 1) {
        attempts = attempt + 1;
        if (attempt > 0) {
          prevDelay = nextRetryDelay(
            attempt - 1,
            prevDelay,
            {
              baseDelay: this.config.retryBaseDelay,
              maxDelay: this.config.retryMaxDelay ?? DEFAULT_RETRY_MAX_DELAY,
            },
            rand,
          );
          await sleepFn(prevDelay);
        }
        try {
          opened = await this.openStream(state, messages, options, keyAttempt, controller.signal);
          this.config.onKeyOutcome?.(modelId, keyAttempt, true);
          break;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          lastError = error;
          this.config.onKeyOutcome?.(
            modelId,
            keyAttempt,
            false,
            error instanceof LLMError ? error.status : undefined,
          );
          if (error instanceof LLMError && error.status !== undefined && KEY_ROTATABLE_STATUS.has(error.status)) {
            keyAttempt += 1;
          }
          const retryable =
            error instanceof TimeoutError ||
            error instanceof NetworkError ||
            (error instanceof LLMError &&
              (error.retryable || (error.status !== undefined && KEY_ROTATABLE_STATUS.has(error.status))));
          if (!retryable || attempt >= maxRetries) throw error;
        }
      }

      // ── 阶段二：有界泵消费（不重试；消费者中止经 finally 清理）──
      const high = Math.max(1, Math.floor(this.config.streamHighWatermark ?? DEFAULT_STREAM_HIGH_WATERMARK));
      const pump = new BoundedPump<StreamChunk>(opened.nextBatch, { highWatermark: high });
      pump.start();
      try {
        for (;;) {
          const r = await pump.next();
          if (r.done) break;
          const chunk: StreamChunk = { ...r.value, index: chunkCount };
          if (!chunk.done) chunkCount += 1;
          content += chunk.delta;
          if (chunk.usage) usage = chunk.usage;
          yield chunk;
        }
      } finally {
        pump.stop();
        opened.close();
      }

      const latency = this.now() - startedAt;
      const tokensUsed = usage?.total_tokens ?? estimateTokens(messages, content);
      const costPerKToken = state.config.costPerKToken ?? 0;
      const response: LLMResponse = {
        content,
        model: opened.echo.model ?? modelId,
        latency,
        tokensUsed,
        cost: (tokensUsed / 1000) * costPerKToken,
        retries: attempts - 1,
      };
      state.successCount += 1;
      state.totalTokensUsed += tokensUsed;
      state.totalCost += response.cost;
      this.robustStreamFor(modelId)?.observe(latency);
      this.meterTokens(modelId, tokensUsed, {
        taskType: options.taskType,
        kind: 'chat-stream',
        outcome: 'success',
      });
      outcome = 'success';
      return response;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      state.failureCount += 1;
      failure = { err: error, status: (error as LLMError)?.status };
      // A14-2：失败按输入估算入账
      this.meterTokens(modelId, estimateTokens(messages, ''), {
        taskType: options.taskType,
        kind: 'chat-stream',
        outcome: 'failure',
      });
      throw error;
    } finally {
      state.totalCalls += 1;
      state.totalLatency += this.now() - startedAt;
      this.releaseSlot(state);
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
      this.recordAudit({
        ts: this.now(),
        model: modelId,
        kind: 'chat-stream',
        outcome,
        latencyMs: this.now() - startedAt,
        attempts,
        retries: Math.max(0, attempts - 1),
        tokensUsed: outcome === 'success' ? (usage?.total_tokens ?? estimateTokens(messages, content)) : estimateTokens(messages, ''),
        cost: outcome === 'success' ? ((usage?.total_tokens ?? estimateTokens(messages, content)) / 1000) * (state.config.costPerKToken ?? 0) : 0,
        errorKind: failure ? (failure.err instanceof AppError ? failure.err.code : 'UNKNOWN') : undefined,
        errorStatus: failure?.status,
        streamChunks: chunkCount,
        budgetSpentTokens: this.tokenSpent,
      });
    }
  }

  // ─────────────────────── R4-A14-1 模型能力探测 ───────────────────────

  /**
   * R4-1：对新（或存量）模型执行能力探测。
   *
   * 确定性探测问题集（三项，顺序执行，各自独立 pass/fail）：
   * - structured-output：严格 JSON 指令 → 输出经 parseJSONLoose 可解析且
   *   字段特征吻合 → 通过；
   * - long-context：约 PROBE_LONG_CONTEXT_CHARS 字符填充文本、70% 处埋
   *   固定暗号 → 输出含暗号 → 通过（召回特征）；
   * - tool-calling：携带 tools + tool_choice 请求 → 端点接受且回传
   *   tool_calls → 通过（端点 400 拒绝 / 无 tool_calls 均不通过——不虚标）。
   *
   * 探测调用走常规 chat() 通道（并发/超时/审计/入账全部同口径，taskType
   * 固定 'capability-probe'）；单项探测异常不抛出、如实记 passed=false。
   * 结论缓存于模型状态：getModelCapabilities / getModelStatuses().capabilities
   * / selectModelsByCapabilities 供调度消费。
   */
  async probeModel(
    modelId: string,
    options: { maxRetries?: number; timeout?: number; longContextChars?: number } = {},
  ): Promise<ModelCapabilityReport> {
    const state = this.models.get(modelId);
    if (!state) throw new LLMError(`未注册的模型: ${modelId}`);
    const startedAt = this.now();
    const probeOptions: ChatOptions = {
      maxRetries: options.maxRetries ?? 0,
      timeout: options.timeout,
      taskType: 'capability-probe',
    };
    const runProbe = async (
      id: CapabilityProbeId,
      messages: ChatMessage[],
      extraBody: Record<string, any> | undefined,
      judge: (resp: LLMResponse) => { passed: boolean; detail: string },
    ): Promise<CapabilityProbeResult> => {
      const t0 = this.now();
      try {
        const resp = await this.chat(modelId, messages, extraBody ? { ...probeOptions, extraBody } : probeOptions);
        const { passed, detail } = judge(resp);
        return { id, passed, detail, latencyMs: this.now() - t0 };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        return {
          id,
          passed: false,
          detail: `探测失败（不虚标）: ${truncate(error.message, 160)}`,
          latencyMs: this.now() - t0,
        };
      }
    };

    // 探测一：结构化输出（严格 JSON 指令的产出特征）
    const structuredProbe = await runProbe(
      'structured-output',
      [
        {
          role: 'system',
          content: 'You are the target of an automated capability probe. Follow instructions exactly.',
        },
        {
          role: 'user',
          content:
            'Reply with ONLY this exact JSON object as your entire message, no prose, no markdown fences: {"probe":"structured-output","values":[1,2,3]}',
        },
      ],
      undefined,
      (resp) => {
        const parsed = parseJSONLoose<any>(resp.content);
        const passed =
          parsed !== undefined &&
          typeof parsed === 'object' &&
          parsed !== null &&
          parsed.probe === 'structured-output' &&
          Array.isArray(parsed.values) &&
          parsed.values.length === 3;
        return {
          passed,
          detail: passed
            ? `严格 JSON 指令下输出可解析且字段特征吻合（${truncate(resp.content, 60)}）`
            : `输出不满足结构化特征（parseJSONLoose=${parsed === undefined ? '不可解析' : '可解析但字段不符'}，原文 ${truncate(resp.content, 60)}）`,
        };
      },
    );

    // 探测二：长上下文（埋点暗号召回）
    const longChars = Math.max(2000, Math.floor(options.longContextChars ?? PROBE_LONG_CONTEXT_CHARS));
    const fillerUnit =
      'The quick brown fox jumps over the lazy dog while the system records another unremarkable observation line. ';
    const fillCount = Math.ceil(longChars / fillerUnit.length);
    const markerAt = Math.floor(fillCount * PROBE_MARKER_POSITION);
    const passage: string[] = [];
    for (let i = 0; i < fillCount; i += 1) {
      passage.push(fillerUnit);
      if (i === markerAt) passage.push(`The secret codeword for this passage is ${PROBE_MARKER}. `);
    }
    const longProbe = await runProbe(
      'long-context',
      [
        { role: 'system', content: 'You are the target of an automated capability probe. Follow instructions exactly.' },
        {
          role: 'user',
          content: `${passage.join('')}\n\nReply with only the secret codeword contained in the passage above. No other text.`,
        },
      ],
      undefined,
      (resp) => {
        const passed = resp.content.includes(PROBE_MARKER);
        return {
          passed,
          detail: passed
            ? `长文本（≈${longChars} 字符）70% 处埋点暗号被准确召回`
            : `埋点暗号未召回（输出 ${truncate(resp.content, 60)}）——长上下文能力不虚标`,
        };
      },
    );

    // 探测三：工具调用（tools 参数接受 + tool_calls 回传特征）
    const toolProbe = await runProbe(
      'tool-calling',
      [
        { role: 'system', content: 'You are the target of an automated capability probe. Follow instructions exactly.' },
        { role: 'user', content: 'Call the function probe_tool with argument x = 42. Do not reply in prose.' },
      ],
      {
        tools: [
          {
            type: 'function',
            function: {
              name: 'probe_tool',
              description: 'capability probe no-op tool',
              parameters: {
                type: 'object',
                properties: { x: { type: 'number' } },
                required: ['x'],
              },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'probe_tool' } },
      },
      (resp) => {
        const calls = resp.toolCalls ?? [];
        const passed = Array.isArray(calls) && calls.some((tc) => tc?.function?.name === 'probe_tool');
        return {
          passed,
          detail: passed
            ? 'tools 参数被端点接受且 message.tool_calls 回传 probe_tool'
            : `无 tool_calls 回传（${calls.length === 0 ? '端点忽略 tools 或拒绝该参数' : '回传函数名不符'}）——工具调用能力不虚标`,
        };
      },
    );

    const probes = [structuredProbe, longProbe, toolProbe];
    const report: ModelCapabilityReport = {
      model: modelId,
      probedAt: this.now(),
      durationMs: this.now() - startedAt,
      probes,
      capabilities: {
        longContext: longProbe.passed,
        toolCalling: toolProbe.passed,
        structuredOutput: structuredProbe.passed,
      },
      passedCount: probes.filter((p) => p.passed).length,
      totalCount: probes.length,
    };
    state.capabilityReport = report;
    return report;
  }

  /**
   * R4-1：模型能力位（未探测过返回 undefined——不猜测、不虚标）。
   */
  getModelCapabilities(modelId: string): ModelCapabilityBits | undefined {
    return this.models.get(modelId)?.capabilityReport?.capabilities;
  }

  /**
   * R4-1：按能力位过滤模型（调度消费入口）。
   * required 中仅 true 的位参与过滤（false/缺省位不约束）；
   * 未探测过的模型不入选（能力未知 ≠ 具备）。
   */
  selectModelsByCapabilities(required: Partial<ModelCapabilityBits>): string[] {
    const out: string[] = [];
    for (const state of this.models.values()) {
      const caps = state.capabilityReport?.capabilities;
      if (!caps) continue;
      let ok = true;
      if (required.longContext === true && !caps.longContext) ok = false;
      if (required.toolCalling === true && !caps.toolCalling) ok = false;
      if (required.structuredOutput === true && !caps.structuredOutput) ok = false;
      if (ok) out.push(state.config.id);
    }
    return out;
  }

  // ─────────────────────── R4-A14-2 排队指标 ───────────────────────

  /**
   * R4-2：各模型排队指标（waiting 分层 / 超时拒绝 / 抢占计数）。
   * 未启用 priorityQueue 时 byPriority 恒为单层 0、计数恒 0（读数如实）。
   */
  getQueueMetrics(): LLMQueueMetrics[] {
    return [...this.models.values()].map((s) => {
      const byPriority = new Map<number, number>();
      for (const entry of s.queue) byPriority.set(entry.priority, (byPriority.get(entry.priority) ?? 0) + 1);
      return {
        model: s.config.id,
        waiting: s.queue.length,
        byPriority: [...byPriority.entries()]
          .map(([priority, waiting]) => ({ priority, waiting }))
          .sort((a, b) => b.priority - a.priority),
        queueTimeouts: s.queueTimeouts,
        priorityPreemptions: s.priorityPreemptions,
      };
    });
  }

  // ─────────────────────── R4-A14-3 流式中断续传 ───────────────────────

  /**
   * R4-3：可续传的流式聊天补全。
   *
   * 语义（缺省即普通 chatStream，零漂移；中断后才出现恢复行为）：
   * - 初次流正常完成 → 与 chatStream 同构（chunk 多 phase='initial'）；
   * - 中断（已交付 ≥1 内容块后出错）→ 携带已接收前缀发起续写请求
   *   （原 messages + assistant 前缀全文 + 续写指令含前缀末尾 32 字符），
   *   续写首块经 joinContinuationSeam 接缝校验（重叠剥离 / 重启检测），
   *   phase='continuation'；续写成功则总输出 = 前缀 + 续写（无缝）；
   * - 续传不可行（协议拒绝续写 / 模型无视前缀从头重写 / 续写反复中断
   *   耗尽预算）→ 诚实回退全量重试：先发 {restart:true} 标记块（消费者
   *   应重置已累积文本），再从头交付完整重试流——绝不静默重复交付；
   * - 恢复不可重试的错误（预算熔断 / 排队超时 / 未交付即失败）→ 原样
   *   上抛，不伪装成功。
   * - 终值在 LLMResponse 上附 resumes / restarts / finalPhase；各次底层
   *   调用的 token/成本均如实分别入账审计（恢复不免费的诚实口径）。
   */
  async *chatStreamResumable(
    modelId: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
    resume: StreamResumeOptions = {},
  ): AsyncGenerator<ResumableStreamChunk, ResumableStreamResult, void> {
    const maxResumes = Math.max(0, Math.floor(resume.maxResumeAttempts ?? 1));
    const maxRestarts = Math.max(0, Math.floor(resume.maxRestartAttempts ?? 1));
    const seamOpts = {
      seamOverlapMaxChars: Math.max(1, Math.floor(resume.seamOverlapMaxChars ?? 96)),
      restartDetectChars: Math.max(8, Math.floor(resume.restartDetectChars ?? 32)),
    };
    const t0 = this.now();
    // 跨生成器可变上下文（前缀/序号/统计——恢复阶段间共享）
    const ctx = {
      prefix: '',
      index: 0,
      resumes: 0,
      restarts: 0,
      tokens: 0,
      cost: 0,
      retries: 0,
      modelEcho: modelId,
      lastError: null as Error | null,
    };
    for (let fullAttempt = 0; fullAttempt <= maxRestarts; fullAttempt += 1) {
      const phase: 'initial' | 'restart' = fullAttempt === 0 ? 'initial' : 'restart';
      if (phase === 'restart') {
        ctx.restarts += 1;
        ctx.prefix = '';
        // 诚实回退标记：消费者见此块须重置已累积文本，此后从头交付
        yield { delta: '', index: ctx.index++, restart: true, phase: 'restart', done: false };
      }
      // 每个全量段重新武装续传预算
      const budget = maxResumes;
      const segment = yield* this.runResumableSegment(modelId, messages, options, phase, budget, seamOpts, ctx);
      if (segment.outcome === 'completed') {
        return {
          content: ctx.prefix,
          model: ctx.modelEcho,
          latency: this.now() - t0,
          tokensUsed: ctx.tokens,
          cost: ctx.cost,
          retries: ctx.retries,
          resumes: ctx.resumes,
          restarts: ctx.restarts,
          finalPhase: segment.phase,
        };
      }
      // restart-needed：本段续传不可行 → 外层进入全量重试（或耗尽后上抛）
      ctx.prefix = '';
    }
    throw (
      ctx.lastError ??
      new LLMError(`模型 ${modelId} 流式恢复失败（续传不可行且全量重试预算耗尽）`, undefined, false, {
        code: 'RESUME_EXHAUSTED',
      })
    );
  }

  /**
   * R4-3：一个「全量流 + 至多 budget 次续传修复」段。
   * 返回 completed（段内最终完成的阶段）或 restart-needed（续传不可行，
   * 须全量重试）。不可恢复错误（预算熔断/排队超时/零交付失败）直接上抛。
   */
  private async *runResumableSegment(
    modelId: string,
    messages: ChatMessage[],
    options: ChatOptions,
    phase: 'initial' | 'restart',
    budget: number,
    seamOpts: { seamOverlapMaxChars: number; restartDetectChars: number },
    ctx: {
      prefix: string;
      index: number;
      resumes: number;
      restarts: number;
      tokens: number;
      cost: number;
      retries: number;
      modelEcho: string;
      lastError: Error | null;
    },
  ): AsyncGenerator<ResumableStreamChunk, { outcome: 'completed'; phase: 'initial' | 'continuation' | 'restart' } | { outcome: 'restart-needed' }, void> {
    let remainingBudget = budget;
    let deliveredAny = false;
    for (;;) {
      // ── 全量流（initial 段或 restart 段的完整重放）──
      const gen = this.chatStream(modelId, messages, options);
      try {
        let response: LLMResponse | undefined;
        for (;;) {
          const r = await gen.next();
          if (r.done) {
            response = r.value;
            break;
          }
          const c = r.value;
          if (c.delta) {
            ctx.prefix += c.delta;
            deliveredAny = true;
          }
          yield { ...c, index: ctx.index++, phase };
        }
        // 段内完成（无中断）
        if (response) {
          ctx.tokens += response.tokensUsed;
          ctx.cost += response.cost;
          ctx.retries += response.retries;
          ctx.modelEcho = response.model;
          return { outcome: 'completed', phase };
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        ctx.lastError = error;
        // 恢复不可重试的错误：预算熔断 / 排队超时 / 未交付即失败 → 原样上抛
        const errCode = (error as LLMError)?.details?.code;
        if (errCode === 'BUDGET_EXHAUSTED' || errCode === 'QUEUE_TIMEOUT' || !deliveredAny) throw error;
      }
      // ── 中断修复：续传尝试（budget 递减，失败可再续）──
      let restartNeeded = false;
      while (remainingBudget > 0) {
        remainingBudget -= 1;
        ctx.resumes += 1;
        const contMessages: ChatMessage[] = [
          ...messages,
          { role: 'assistant', content: ctx.prefix },
          {
            role: 'user',
            content: buildResumeInstruction(ctx.prefix.slice(-RESUME_TAIL_CHARS)),
          },
        ];
        const contGen = this.chatStream(modelId, contMessages, options);
        let seamDecided = false;
        let pendingSeamTrim: number | undefined;
        try {
          for (;;) {
            const r = await contGen.next();
            if (r.done) {
              // 续写流完成：段以 continuation 阶段收束
              ctx.tokens += r.value.tokensUsed;
              ctx.cost += r.value.cost;
              ctx.retries += r.value.retries;
              ctx.modelEcho = r.value.model;
              return { outcome: 'completed', phase: 'continuation' };
            }
            const c = r.value;
            if (!seamDecided) {
              if (!c.delta) continue; // 前导空帧（usage 等）：接缝未决前暂扣
              const seam = joinContinuationSeam(ctx.prefix, c.delta, seamOpts);
              if (seam.kind === 'restart') {
                restartNeeded = true;
                break;
              }
              seamDecided = true;
              if (seam.kind === 'overlap-trimmed' && seam.text.length === 0) {
                // 首块被整块剥离（纯重叠，无净内容）：剥离量记到下一有效块
                pendingSeamTrim = seam.trimmed;
                continue;
              }
              if (seam.text) {
                ctx.prefix += seam.text;
                deliveredAny = true;
                yield {
                  ...c,
                  delta: seam.text,
                  index: ctx.index++,
                  phase: 'continuation',
                  ...(seam.trimmed ? { seamTrimmed: seam.trimmed } : {}),
                };
              }
              continue;
            }
            if (c.delta) {
              ctx.prefix += c.delta;
              deliveredAny = true;
            }
            yield {
              ...c,
              index: ctx.index++,
              phase: 'continuation',
              ...(pendingSeamTrim !== undefined ? { seamTrimmed: pendingSeamTrim } : {}),
            };
            pendingSeamTrim = undefined;
          }
        } catch (contErr) {
          ctx.lastError = contErr instanceof Error ? contErr : new Error(String(contErr));
          continue; // 续写中断：budget 允许则携带更长前缀再续
        }
        if (restartNeeded) {
          // 模型无视前缀从头重写：取消续写流，交由外层全量重试
          await contGen.return(undefined as never).catch(() => undefined);
          return { outcome: 'restart-needed' };
        }
      }
      // 续传预算耗尽仍不可行 → 全量重试口径（外层决定是否还有重试预算）
      return { outcome: 'restart-needed' };
    }
  }

  // ─────────────────────── R4-A14-5 成本对账 ───────────────────────

  /**
   * R4-5：登记一笔外部账单（供应商计费口径），供 reconcile 交叉核对。
   * 同源同期多笔记录按求和聚合（增量账单可分批上报）。
   */
  reportExternalCost(record: ExternalCostRecord): void {
    if (!record || typeof record.model !== 'string' || !Number.isFinite(record.tokens) || !Number.isFinite(record.cost)) {
      throw new LLMError('外部账单记录不完整（须含 model/tokens/cost）', undefined, false);
    }
    this.externalCosts.push({ ...record });
  }

  /** R4-5：导出账本（最旧在前，拷贝） */
  getCostLedger(): CostLedgerEntry[] {
    return this.ledger.slice();
  }

  /** R4-5：停用周期自动对账（手动 reconcile 不受影响） */
  stopAutoReconcile(): void {
    if (this.reconcileTimer !== null) {
      this.clearTimerFn(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  private scheduleAutoReconcile(intervalMs: number): void {
    this.reconcileTimer = this.setTimerFn(() => {
      this.reconcileTimer = null;
      const report = this.reconcile();
      if (report) this.config.costLedger?.onReconciliation?.(report);
      this.scheduleAutoReconcile(intervalMs);
    }, intervalMs);
  }

  /**
   * R4-5：出对账报告（未启用 costLedger 返回 undefined——无账可对，诚实）。
   *
   * 聚合：byModel / byTaskType / byBucket（时段桶宽可覆盖）。
   * 四路交叉核对（差异 → alerts 告警，绝不静默）：
   * 1. ledger-vs-account：账本合计 vs 令牌硬预算账户（同源恒等；账本
   *    截断时如实标注 mismatch）；
   * 2. ledger-vs-model-stats：账本成功条目 vs 模型统计 totalTokensUsed/
   *    totalCost（口径：模型统计只计成功调用实测 usage）；
   * 3. repricing：按当前价目表重定价每条账目——价目表在事后演化（涨价/
   *    降价）即 mismatch（成本漂移告警）；
   * 4. internal-vs-external：逐笔外部账单 vs 账本同期同模型合计——供应商
   *    口径与内部记账的差异（注入差异必被检出）。
   */
  reconcile(options: { from?: number; to?: number; bucketMs?: number; tolerance?: number } = {}): CostReconciliationReport | undefined {
    if (!this.ledgerEnabled) return undefined;
    const tolerance = options.tolerance ?? 1e-9;
    const bucketMs = Math.max(1, Math.floor(options.bucketMs ?? this.config.costLedger?.bucketMs ?? DEFAULT_COST_BUCKET_MS));
    const entries = this.ledger.filter(
      (e) =>
        (options.from === undefined || e.ts >= options.from) &&
        (options.to === undefined || e.ts < options.to),
    );
    // 交叉核对恒用全量账本（账户/模型统计是累计口径，窗口化对照无意义）；
    // from/to 窗口只约束聚合分组（byModel/byTaskType/byBucket）。
    const allEntries = this.ledger;
    const groupBy = <K extends string>(keyOf: (e: CostLedgerEntry) => K) => {
      const m = new Map<K, { calls: number; tokens: number; cost: number }>();
      for (const e of entries) {
        const k = keyOf(e);
        const cur = m.get(k) ?? { calls: 0, tokens: 0, cost: 0 };
        cur.calls += 1;
        cur.tokens += e.tokens;
        cur.cost += e.cost;
        m.set(k, cur);
      }
      return m;
    };
    const byModelMap = groupBy((e) => e.model);
    const byTaskMap = groupBy((e) => e.taskType);
    const byBucketMap = groupBy((e) => String(Math.floor(e.ts / bucketMs) * bucketMs));
    const sumOf = (list: CostLedgerEntry[], field: 'tokens' | 'cost') =>
      list.reduce((acc, e) => acc + e[field], 0);

    const crossChecks: CostCrossCheck[] = [];
    const alerts: string[] = [];
    const ledgerTokens = sumOf(allEntries, 'tokens');
    const ledgerCost = sumOf(allEntries, 'cost');

    // 1. 账本 vs 账户（同源恒等式；截断即如实 mismatch + 归因说明）
    const account = this.getTokenAccount();
    {
      const dTokens = ledgerTokens - account.spentTokens;
      const dCost = ledgerCost - account.spentCost;
      const okAccount = Math.abs(dTokens) < 0.5 && Math.abs(dCost) <= Math.max(tolerance, 1e-6);
      crossChecks.push({
        name: 'ledger-vs-account',
        status: okAccount ? 'ok' : 'mismatch',
        ledgerValue: ledgerTokens,
        otherValue: account.spentTokens,
        delta: dTokens,
        detail: okAccount
          ? undefined
          : this.ledgerTruncated
            ? `账本达上限 ${this.ledgerMax} 条被截断——差异源于被挤出的历史入账（账户为全量口径）`
            : undefined,
      });
      if (!okAccount) {
        alerts.push(`账本与令牌账户不平：账本 ${ledgerTokens} token / $${ledgerCost.toFixed(6)}，账户 ${account.spentTokens} token / $${account.spentCost.toFixed(6)}（Δtoken=${dTokens}，Δcost=${(ledgerCost - account.spentCost).toFixed(8)}）${this.ledgerTruncated ? '（账本已截断）' : ''}`);
      }
    }

    // 2. 账本（成功条目） vs 模型统计（模型统计只计成功调用实测 usage）
    {
      let worst: { model: string; dTokens: number; dCost: number } | null = null;
      let allOk = true;
      const modelsInLedger = new Set(allEntries.map((e) => e.model));
      for (const model of modelsInLedger) {
        const st = this.models.get(model);
        const successList = allEntries.filter((e) => e.model === model && e.outcome === 'success');
        const successTokens = sumOf(successList, 'tokens');
        const successCost = sumOf(successList, 'cost');
        const dTokens = successTokens - (st?.totalTokensUsed ?? 0);
        const dCost = successCost - (st?.totalCost ?? 0);
        if (Math.abs(dTokens) >= 0.5 || Math.abs(dCost) > Math.max(tolerance, 1e-6)) {
          allOk = false;
          if (!worst || Math.abs(dTokens) > Math.abs(worst.dTokens)) worst = { model, dTokens, dCost };
        }
      }
      const successAll = allEntries.filter((e) => e.outcome === 'success');
      crossChecks.push({
        name: 'ledger-vs-model-stats',
        status: allOk ? 'ok' : 'mismatch',
        ledgerValue: sumOf(successAll, 'tokens'),
        otherValue: [...this.models.values()]
          .filter((s) => modelsInLedger.has(s.config.id))
          .reduce((acc, s) => acc + s.totalTokensUsed, 0),
        delta: allOk ? 0 : (worst?.dTokens ?? 0),
        detail: allOk ? undefined : `最偏模型 ${worst?.model}（Δtoken=${worst?.dTokens}，Δcost=${worst?.dCost?.toFixed(8)}）`,
      });
      if (!allOk) {
        alerts.push(`账本与模型统计不平（成功口径）：最偏 ${worst?.model} Δtoken=${worst?.dTokens}`);
      }
    }

    // 3. 重定价（价目表演化检出）
    {
      let drift: { model: string; recorded: number; repriced: number } | null = null;
      for (const e of allEntries) {
        const price = this.models.get(e.model)?.config.costPerKToken ?? 0;
        const repriced = (e.tokens / 1000) * price;
        if (Math.abs(repriced - e.cost) > Math.max(tolerance, 1e-9)) {
          drift = drift ?? { model: e.model, recorded: e.cost, repriced };
        }
      }
      crossChecks.push({
        name: 'repricing',
        status: drift ? 'mismatch' : 'ok',
        ledgerValue: ledgerCost,
        otherValue: allEntries.reduce(
          (acc, e) => acc + (e.tokens / 1000) * (this.models.get(e.model)?.config.costPerKToken ?? 0),
          0,
        ),
        delta: drift ? drift.recorded - drift.repriced : 0,
        detail: drift
          ? `价目表已演化：${drift.model} 记账 $${drift.recorded.toFixed(8)} vs 当前价重定价 $${drift.repriced.toFixed(8)}——成本漂移告警`
          : undefined,
      });
      if (drift) {
        alerts.push(`价目表演化（成本漂移）：${drift.model} 记账价与当前价目表不符（$${drift.recorded.toFixed(8)} vs $${drift.repriced.toFixed(8)}）`);
      }
    }

    // 4. 内部 vs 外部账单（注入差异必被检出）
    {
      let allOk = true;
      let worst: { source: string; model: string; dTokens: number; dCost: number } | null = null;
      for (const rec of this.externalCosts) {
        const internal = allEntries.filter((e) => e.model === rec.model && e.ts >= rec.periodStart && e.ts < rec.periodEnd);
        const internalTokens = sumOf(internal, 'tokens');
        const internalCost = sumOf(internal, 'cost');
        const dTokens = internalTokens - rec.tokens;
        const dCost = internalCost - rec.cost;
        if (Math.abs(dTokens) >= 0.5 || Math.abs(dCost) > Math.max(tolerance, 1e-6)) {
          allOk = false;
          if (!worst || Math.abs(dCost) > Math.abs(worst.dCost)) worst = { source: rec.source, model: rec.model, dTokens, dCost };
        }
      }
      crossChecks.push({
        name: 'internal-vs-external',
        status: allOk ? 'ok' : 'mismatch',
        ledgerValue: ledgerCost,
        otherValue: this.externalCosts.reduce((acc, r) => acc + r.cost, 0),
        delta: worst ? worst.dCost : 0,
        detail: worst
          ? `外部账单 ${worst.source}/${worst.model} 与内部记账不符（Δtoken=${worst.dTokens}，Δcost=${worst.dCost.toFixed(8)}）`
          : this.externalCosts.length === 0
            ? '无外部账单登记（跳过核对）'
            : undefined,
      });
      if (!allOk && worst) {
        alerts.push(`外部账单对不平：${worst.source}/${worst.model} Δtoken=${worst.dTokens}，Δcost=$${worst.dCost.toFixed(8)}`);
      }
    }

    return {
      generatedAt: this.now(),
      ...(options.from !== undefined || options.to !== undefined
        ? { window: { from: options.from ?? -Infinity, to: options.to ?? Infinity } }
        : {}),
      bucketMs,
      byModel: [...byModelMap.entries()]
        .map(([model, v]) => ({ model, ...v }))
        .sort((a, b) => b.tokens - a.tokens),
      byTaskType: [...byTaskMap.entries()]
        .map(([taskType, v]) => ({ taskType, ...v }))
        .sort((a, b) => b.tokens - a.tokens),
      byBucket: [...byBucketMap.entries()]
        .map(([b, v]) => ({ bucketStart: Number(b), tokens: v.tokens, cost: v.cost }))
        .sort((a, b) => a.bucketStart - b.bucketStart),
      account,
      crossChecks,
      alerts,
    };
  }

  /**
   * 获取所有模型的运行时状态（model_dashboard Tool 数据源）
   */
  getModelStatuses(): ModelRuntimeStatus[] {
    return [...this.models.values()].map((s) => {
      // 23.0：稳健延迟读数（未配置 robustLatency 时为 undefined，
      // 两个新字段不进入状态对象 —— 输出与升级前逐位一致，零漂移）
      const robust = this.config.robustLatency ? this.robustStreamFor(s.config.id)?.read() : undefined;
      return {
        id: s.config.id,
        name: s.config.name ?? s.config.id,
        endpoint: s.config.endpoint,
        activeRequests: s.active,
        queuedRequests: s.queue.length,
        maxConcurrency: s.maxConcurrency,
        totalCalls: s.totalCalls,
        successCount: s.successCount,
        failureCount: s.failureCount,
        successRate: s.totalCalls > 0 ? s.successCount / s.totalCalls : 1,
        avgLatency: s.totalCalls > 0 ? Math.round(s.totalLatency / s.totalCalls) : 0,
        totalTokensUsed: s.totalTokensUsed,
        totalCost: Number(s.totalCost.toFixed(6)),
        taskScores: s.config.initialCapabilities?.taskScores ?? {},
        ...(robust
          ? { robustAvgLatencyMs: Math.round(robust.robustMean), robustLatencyMethod: robust.method }
          : {}),
        // R4-1：探测过的模型附能力位（未探测不出现该键——零漂移）
        ...(s.capabilityReport ? { capabilities: s.capabilityReport.capabilities } : {}),
      };
    });
  }

  /**
   * 关闭客户端：拒绝所有排队中的请求
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.robustStreams.clear();
    // R4-5：停掉周期对账定时器
    if (this.reconcileTimer !== null) {
      this.clearTimerFn(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    for (const state of this.models.values()) {
      for (const waiter of state.queue.splice(0)) {
        if (waiter.timer !== undefined) this.clearTimerFn(waiter.timer);
        waiter.reject(new LLMError('LLM 客户端已关闭，排队请求被取消'));
      }
    }
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /**
   * A14-3：建立 SSE 流连接，返回「按批拉取解析后的 chunk」的泵生产端。
   * nextBatch 每次调用对应传输层一次 read()——泵的背压直接传导为
   * 「不再 read()」。close() 释放 reader/decoder（消费者中止时调用）。
   */
  private async openStream(
    state: ModelState,
    messages: ChatMessage[],
    options: ChatOptions,
    keyAttempt: number,
    signal: AbortSignal,
  ): Promise<{
    echo: { model?: string };
    nextBatch: () => Promise<StreamChunk[] | undefined>;
    close: () => void;
  }> {
    const { config } = state;
    const url = buildCompletionsUrl(config.endpoint);
    // 头部合并顺序与 chatOnce 一致：固定头 → 模型自带 Key → 宿主注入头
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const hostHeaders = this.config.headerProvider?.(config.id, keyAttempt);
    if (hostHeaders) Object.assign(headers, hostHeaders);

    let res: any;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.id,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
          ...(options.extraBody ?? {}),
        }),
        signal,
      });
    } catch (err) {
      if ((err as any)?.name === 'AbortError') {
        throw new TimeoutError(`模型 ${config.id} 流式连接超时`, { modelId: config.id });
      }
      throw new NetworkError(`模型 ${config.id} 网络错误: ${(err as Error)?.message ?? String(err)}`, {
        modelId: config.id,
      });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LLMError(
        `模型 ${config.id} 返回 HTTP ${res.status}: ${truncate(body, 200)}`,
        res.status,
        RETRYABLE_STATUS.has(res.status),
      );
    }

    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
      throw new NetworkError(`模型 ${config.id} 流式响应缺少可读 body`, { modelId: config.id });
    }
    const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let sawDone = false;
    const echo: { model?: string } = {};

    return {
      echo,
      async nextBatch(): Promise<StreamChunk[] | undefined> {
        if (sawDone) return undefined;
        const { done, value } = await reader.read();
        if (done) {
          sawDone = true;
          const tail = parseSseBlock((sseBuffer += '\n'), echo);
          sseBuffer = '';
          if (tail.length > 0) return tail;
          return [{ delta: '', index: -1, done: true }];
        }
        sseBuffer += decoder.decode(value, { stream: true });
        const newline = sseBuffer.lastIndexOf('\n');
        if (newline < 0) return [];
        const block = sseBuffer.slice(0, newline + 1);
        sseBuffer = sseBuffer.slice(newline + 1);
        const batch = parseSseBlock(block, echo);
        // 已见 [DONE]：后续不再拉取传输层
        if (batch.some((c) => c.done)) sawDone = true;
        return batch;
      },
      close() {
        try {
          reader.cancel().catch(() => undefined);
        } catch {
          /* 忽略 */
        }
      },
    };
  }

  /**
   * 23.0：取（或惰性创建）模型的稳健延迟流。
   * 仅在配置 robustLatency 时返回流，否则返回 undefined（零开销路径）；
   * dispose 后不再复活统计流（清空即终态）。
   */
  private robustStreamFor(modelId: string): RobustStream | undefined {
    if (!this.config.robustLatency) return undefined;
    let stream = this.robustStreams.get(modelId);
    if (!stream) {
      if (this.disposed) return undefined;
      stream = new RobustStream({
        alpha: this.config.robustLatency.alpha,
        maxSamples: this.config.robustLatency.maxSamples,
      });
      this.robustStreams.set(modelId, stream);
    }
    return stream;
  }

  /**
   * 28.0：取模型的原始延迟样本（毫秒）。
   * 仅配置 robustLatency 时有值（否则 undefined，零开销零漂移）——
   * 尾部风险监视器（POT/GPD）与 23.0 稳健估计共用同一条流。
   */
  getLatencySamples(modelId: string): number[] | undefined {
    return this.robustStreams.get(modelId)?.toSamples();
  }

  /**
   * 34.0：挂载 CVaR 超时预算（幂等覆盖，挂载即生效）。
   *
   * 每模型超时从固定魔数升级为 margin × CVaR_α(该模型延迟史)——按
   * 「最坏尾部的期望」定价：重尾模型自动获得更长预算、轻尾模型不被
   * 一刀切。依赖 robustLatency 启用（延迟样本与其共用）；样本不足
   * minSamples 时该模型回退全局缺省超时（零漂移）。
   */
  attachCvarTimeouts(options?: import('./core/robust-decisions.js').RobustTimeoutConfig): void {
    this.cvarTimeoutConfig = {
      alpha: options?.alpha ?? 0.95,
      margin: options?.margin ?? 1.5,
      minSamples: options?.minSamples ?? 30,
      floorMs: options?.floorMs ?? 5000,
      capMs: options?.capMs ?? 300_000,
    };
  }

  /** 34.0：CVaR 超时配置（未挂载 undefined） */
  private cvarTimeoutConfig?: import('./core/robust-decisions.js').RobustTimeoutConfig;

  /** 34.0：模型的 CVaR 超时预算（未挂载 / 样本不足 → undefined 回退缺省） */
  getCvarTimeout(modelId: string): number | undefined {
    if (!this.cvarTimeoutConfig) return undefined;
    const samples = this.getLatencySamples(modelId);
    if (!samples) return undefined;
    return robustTimeout(samples, this.cvarTimeoutConfig);
  }

  /**
   * 获取并发槽位（必要时排队）。
   *
   * R4-2：配置 priorityQueue 后排队语义升级为优先级队列——高优先先出、
   * 同优先 FIFO、排队超时诚实拒绝；未配置时逐位保持升级前的纯 FIFO
   * （priority/queueTimeoutMs 被忽略，零漂移）。
   */
  private acquireSlot(
    state: ModelState,
    options: ChatOptions = {},
    kind: 'chat' | 'chat-stream' = 'chat',
  ): Promise<void> {
    if (state.active < state.maxConcurrency) {
      state.active += 1;
      return Promise.resolve();
    }
    if (state.queue.length >= this.config.maxQueueSize) {
      return Promise.reject(
        new LLMError(`模型 ${state.config.id} 并发过载，队列已满（${this.config.maxQueueSize}）`, 429, true),
      );
    }
    const priorityEnabled = this.config.priorityQueue !== undefined;
    const priority = priorityEnabled ? (options.priority ?? 0) : 0;
    const timeoutMs = priorityEnabled
      ? (options.queueTimeoutMs ?? this.config.priorityQueue?.defaultQueueTimeoutMs)
      : undefined;
    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = {
        resolve,
        reject,
        priority,
        seq: state.queueSeq++,
        enqueuedAt: this.now(),
      };
      // R4-2：排队超时——到点未获得槽位即诚实拒绝（不虚耗、不静默吞）
      if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        entry.timer = this.setTimerFn(() => {
          // registerModel 重复注册会以新对象替换 ModelState（统计拷贝保留）；
          // 闭包捕获的可能是已替换的旧对象——按模型 id 重解析现行状态，
          // 使超时拒绝计数落在现行对象上（queue 数组为共享引用，出队不受影响）
          const live = this.models.get(state.config.id) ?? state;
          const idx = live.queue.indexOf(entry);
          if (idx < 0) return; // 已出队获得槽位（或已被 dispose 拒绝）
          live.queue.splice(idx, 1);
          live.queueTimeouts += 1;
          const waitedMs = this.now() - entry.enqueuedAt;
          this.recordAudit({
            ts: this.now(),
            model: state.config.id,
            kind,
            outcome: 'rejected',
            latencyMs: waitedMs,
            attempts: 0,
            retries: 0,
            tokensUsed: 0,
            cost: 0,
            errorKind: 'QUEUE_TIMEOUT',
            budgetSpentTokens: this.tokenSpent,
          });
          entry.reject(
            new LLMError(
              `模型 ${state.config.id} 排队超时（等待 ${waitedMs}ms ≥ ${timeoutMs}ms，优先级 ${priority}），本次调用被诚实拒绝（未消耗任何槽位）`,
              undefined,
              false,
              { code: 'QUEUE_TIMEOUT', waitedMs, priority, requestedTimeoutMs: timeoutMs },
            ),
          );
        }, timeoutMs);
      }
      state.queue.push(entry);
    });
  }

  /**
   * 释放并发槽位并唤醒下一位。
   *
   * R4-2：优先级模式下唤醒「优先级最高、同优先级最早到达」的排队者——
   * 早到低优先级的槽位继承权被后到高优先级抢占（priorityPreemptions
   * 计数）；未启用时队首即出（升级前语义逐位不变）。
   */
  private releaseSlot(state: ModelState): void {
    // registerModel 重复注册会以新对象替换 ModelState——按 id 重解析现行状态，
    // 使槽位释放（active 递减 / 抢占计数 / 唤醒排队者）落在现行对象上
    // （queue 数组为共享引用，无重注册时 live === state，行为逐位不变）
    const live = this.models.get(state.config.id) ?? state;
    if (live.queue.length > 0) {
      let best = 0;
      if (this.config.priorityQueue !== undefined) {
        for (let i = 1; i < live.queue.length; i += 1) {
          const cand = live.queue[i]!;
          const champ = live.queue[best]!;
          if (cand.priority > champ.priority || (cand.priority === champ.priority && cand.seq < champ.seq)) {
            best = i;
          }
        }
        if (best !== 0) live.priorityPreemptions += 1;
      }
      const next = live.queue.splice(best, 1)[0]!;
      if (next.timer !== undefined) this.clearTimerFn(next.timer);
      // 槽位移交给下一个排队者
      next.resolve();
      return;
    }
    live.active = Math.max(0, live.active - 1);
  }

  /** 带重试的调用主循环（含多密钥故障转移 + A14-1 混合抖动退避） */
  private async chatWithRetry(
    state: ModelState,
    messages: ChatMessage[],
    options: ChatOptions,
    reportAttempts?: (attempts: number) => void,
  ): Promise<LLMResponse> {
    const maxRetries = options.maxRetries ?? this.config.maxRetries;
    const rand = this.config.jitterRandom ?? Math.random;
    const sleepFn = this.config.sleepImpl ?? sleep;
    const maxDelay = this.config.retryMaxDelay ?? DEFAULT_RETRY_MAX_DELAY;
    let lastError: Error | null = null;
    let keyAttempt = 0;
    // A14-1：去相关抖动链状态（每次实际睡眠的延迟进入下一次采样）
    let prevDelay = Math.max(1, this.config.retryBaseDelay);

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      reportAttempts?.(attempt + 1);
      if (attempt > 0) {
        prevDelay = nextRetryDelay(
          attempt - 1,
          prevDelay,
          { baseDelay: this.config.retryBaseDelay, maxDelay },
          rand,
        );
        await sleepFn(prevDelay);
      }
      try {
        const response = this.config.externalChat
          ? await this.config.externalChat(state.config.id, messages, options)
          : await this.chatOnce(state, messages, options, keyAttempt);
        response.retries = attempt;
        state.totalTokensUsed += response.tokensUsed;
        state.totalCost += response.cost;
        // 23.0：成功调用的本次延迟（毫秒）喂入稳健流
        // （重试链路最终成功的那一次实测延迟；未配置时零开销）
        this.robustStreamFor(state.config.id)?.observe(response.latency);
        this.config.onKeyOutcome?.(state.config.id, keyAttempt, true);
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.config.onKeyOutcome?.(
          state.config.id,
          keyAttempt,
          false,
          lastError instanceof LLMError ? lastError.status : undefined,
        );
        // 认证/配额失败且存在多个候选密钥时，轮换密钥重试
        if (err instanceof LLMError && err.status !== undefined && KEY_ROTATABLE_STATUS.has(err.status)) {
          keyAttempt += 1;
        }
        const retryable =
          err instanceof TimeoutError ||
          err instanceof NetworkError ||
          (err instanceof LLMError && (err.retryable || (err.status !== undefined && KEY_ROTATABLE_STATUS.has(err.status))));
        if (!retryable || attempt >= maxRetries) break;
      }
    }
    throw lastError ?? new LLMError(`模型 ${state.config.id} 调用失败`);
  }

  /** 单次 HTTP 调用（含超时控制；keyAttempt 用于多密钥轮换） */
  private async chatOnce(state: ModelState, messages: ChatMessage[], options: ChatOptions, keyAttempt = 0): Promise<LLMResponse> {
    const { config } = state;
    // 34.0：模型级 CVaR 超时预算优先（按该模型延迟史的尾部定价；
    // 未挂载 / 样本不足时逐位回退全局缺省——零漂移）
    const timeout = options.timeout ?? this.getCvarTimeout(config.id) ?? this.config.timeout;
    const url = buildCompletionsUrl(config.endpoint);
    const startedAt = this.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    // 合并外部中止信号
    const onExternalAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      // 头部合并顺序：固定头 → 模型自带 Key → 宿主注入头（宿主优先，
      // 使 DSH 经 ctx 注入的 Key 覆盖本地配置）
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      const hostHeaders = this.config.headerProvider?.(config.id, keyAttempt);
      if (hostHeaders) Object.assign(headers, hostHeaders);

      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.id,
          messages,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
          ...(options.extraBody ?? {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new LLMError(
          `模型 ${config.id} 返回 HTTP ${res.status}: ${truncate(body, 200)}`,
          res.status,
          RETRYABLE_STATUS.has(res.status),
        );
      }

      const json: any = await res.json();
      const content: string = json?.choices?.[0]?.message?.content ?? '';
      const usage = json?.usage;
      const tokensUsed: number =
        typeof usage?.total_tokens === 'number' ? usage.total_tokens : estimateTokens(messages, content);
      const costPerKToken = config.costPerKToken ?? 0;
      // R4-1：端点回传 tool_calls 时原样透出（能力探测与工具编排消费；
      // 无 tool_calls 的调用该键不出现——零漂移）
      const toolCalls = json?.choices?.[0]?.message?.tool_calls;

      return {
        content,
        model: json?.model ?? config.id,
        latency: this.now() - startedAt,
        tokensUsed,
        cost: (tokensUsed / 1000) * costPerKToken,
        retries: 0,
        ...(Array.isArray(toolCalls) && toolCalls.length > 0 ? { toolCalls } : {}),
      };
    } catch (err) {
      if (err instanceof LLMError) throw err;
      if ((err as any)?.name === 'AbortError') {
        throw new TimeoutError(`模型 ${config.id} 调用超时（${timeout}ms）`, { modelId: config.id, timeout });
      }
      throw new NetworkError(`模型 ${config.id} 网络错误: ${(err as Error)?.message ?? String(err)}`, {
        modelId: config.id,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

/**
 * 宽松 JSON 解析：剥离 Markdown 代码块包裹，截取首个完整 JSON 片段
 * @param text 模型原始输出
 * @returns 解析结果，失败返回 undefined
 */
export function parseJSONLoose<T = any>(text: string): T | undefined {
  if (!text) return undefined;
  let candidate = text.trim();

  // 剥离 ```json ... ``` 包裹
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();

  // 直接尝试
  try {
    return JSON.parse(candidate) as T;
  } catch {
    /* 继续兜底 */
  }

  // 截取首个 { ... } 或 [ ... ] 片段（括号配对扫描）
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = candidate.indexOf(open);
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i += 1) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1)) as T;
          } catch {
            break;
          }
        }
      }
    }
  }
  return undefined;
}

/** 解析一段完整 SSE 文本块为 chunk 批（识别 [DONE] 与 usage 帧；echo 收集端点回显模型 id） */
function parseSseBlock(block: string, echo?: { model?: string }): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      chunks.push({ delta: '', index: -1, done: true });
      continue;
    }
    try {
      const json: any = JSON.parse(payload);
      if (echo && typeof json?.model === 'string' && echo.model === undefined) echo.model = json.model;
      const delta: string = json?.choices?.[0]?.delta?.content ?? '';
      const usage = json?.usage;
      if (delta || usage) chunks.push({ delta, index: -1, usage });
    } catch {
      /* 跳过无法解析的行 */
    }
  }
  return chunks;
}

/** 拼接 chat/completions 端点 URL */
function buildCompletionsUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** R4-3：续写指令（携带前缀末尾原文——续写请求口径可被传输层检视验证） */
function buildResumeInstruction(tail: string): string {
  return (
    'Your previous reply was interrupted by a connection drop. Continue that reply from EXACTLY the point where it stopped. ' +
    'Rules: do not repeat any part of what you already wrote, do not apologize, do not explain, do not start over. ' +
    `The last characters of your previous reply were: "${tail}". ` +
    'Continue seamlessly from there and output only the continuation.'
  );
}

/** 粗略 token 估算（端点未返回 usage 时兜底：约 4 字符/token） */
function estimateTokens(messages: ChatMessage[], content: string): number {
  const inputChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  return Math.ceil((inputChars + content.length) / 4);
}

/** 截断字符串用于错误信息 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 可中止的 sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
