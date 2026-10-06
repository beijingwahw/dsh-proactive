/**
 * errors.ts — 统一错误体系（AppError）
 *
 * 架构文档要求：所有模块的错误处理使用统一的 AppError 体系。
 * 每个子类携带稳定的机器可读 code，便于 Tool 层与日志层统一消费。
 */

/** 应用错误基类，所有业务错误的根类型 */
export class AppError extends Error {
  /** 机器可读错误码，如 CRYPTO_ERROR / MEMORY_ERROR */
  public readonly code: string;
  /** 附加上下文信息（不含敏感数据） */
  public readonly details?: Record<string, unknown>;

  constructor(message: string, code = 'APP_ERROR', details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

/** 配置错误：cordis.patch.yml / 租户配置非法或缺失 */
export class ConfigError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', details);
  }
}

/** 加密错误：加解密失败、密钥无效、加密功能未启用 */
export class CryptoError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CRYPTO_ERROR', details);
  }
}

/** 记忆错误：持久化读写失败、记忆库损坏 */
export class MemoryError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'MEMORY_ERROR', details);
  }
}

/** 网络错误：WebSocket / HTTP / 节点间通信失败 */
export class NetworkError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'NETWORK_ERROR', details);
  }
}

/** 超时错误：模型调用或任务执行超过时限 */
export class TimeoutError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'TIMEOUT_ERROR', details);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 第三轮模块域升级（A16 · 基础契约层）：类型化错误分类学
//
// 既有 AppError 家族（ConfigError / CryptoError / MemoryError /
// NetworkError / TimeoutError）原样保留——新体系是其**纯增量扩展**：
// - 错误码注册表：每个注册码携带 severity / retryability /
//   userMessage（租户安全文案）/ internalDetail（内部诊断指引）/
//   httpStatus / toolVisible 六要素，字段完备可机检
// - TypedAppError：构造即解析注册表缺省、可逐字段覆盖，永远携带完整分类学元数据
// - AggregateAppError：聚合错误（child errors），批量失败一次性上抛
// - 包装/解包（wrapError / errorChain / rootCause）与
//   JSON 序列化往返（serializeError / deserializeError）
// - error → HTTP / Tool 返回值映射助手（classifyTaxonomy / errorToHttpStatus /
//   errorToToolReturn / isRetryableError）
//
// 命名说明：分类函数取名 classifyTaxonomy 而非 classifyError——
// src/core/resilience.ts 已导出同名 classifyError（重试分型，他人域，
// 不可动）；barrel `export *` 重名会被静默吞掉，故新函数用不冲突名。
// ═══════════════════════════════════════════════════════════════════

/** 错误严重度分级（info 可忽略 → critical 需人工介入） */
export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * 可重试性分级：
 * - never        重试必然复现（配置错 / 逻辑错）
 * - immediate    可立即原样重试（幂等读 / 瞬态抖动）
 * - backoff      需退避后重试（限流 / 下游过载 / 超时）
 * - after-fix    需修复前置条件后才值得重试（密钥缺失 / 依赖未就绪）
 */
export type ErrorRetryability = 'never' | 'immediate' | 'backoff' | 'after-fix';

/** 注册表单条：一个机器可读错误码的完整分类学描述 */
export interface ErrorTaxonomyEntry {
  /** 机器可读错误码（全大写蛇形，与 AppError.code 对齐） */
  readonly code: string;
  /** 严重度分级 */
  readonly severity: ErrorSeverity;
  /** 可重试性分级 */
  readonly retryability: ErrorRetryability;
  /** 面向租户/用户的安全文案（不含内部细节，可直接透出） */
  readonly userMessage: string;
  /** 面向工程师的内部诊断指引（仅进日志，不透出） */
  readonly internalDetail: string;
  /** 建议映射 HTTP 状态码 */
  readonly httpStatus: number;
  /** 是否应作为结构化错误返回给 Tool 调用方（false = 只记日志） */
  readonly toolVisible: boolean;
}

/** 内部常量表：satisfies 保证每条字段完备且类型正确 */
const ERROR_TAXONOMIES = {
  APP_ERROR: {
    code: 'APP_ERROR',
    severity: 'error',
    retryability: 'never',
    userMessage: '服务内部错误，请稍后重试或联系管理员。',
    internalDetail: '未分类的应用错误：检查堆栈与上下文详情定位根因。',
    httpStatus: 500,
    toolVisible: true,
  },
  CONFIG_ERROR: {
    code: 'CONFIG_ERROR',
    severity: 'critical',
    retryability: 'after-fix',
    userMessage: '系统配置不完整或非法，请联系管理员检查配置。',
    internalDetail: 'cordis.patch.yml / 租户配置非法或缺失：核对配置文件路径与字段完整性。',
    httpStatus: 503,
    toolVisible: true,
  },
  CRYPTO_ERROR: {
    code: 'CRYPTO_ERROR',
    severity: 'critical',
    retryability: 'after-fix',
    userMessage: '安全模块处理数据失败，请联系管理员。',
    internalDetail: '加解密失败/密钥无效/加密未启用：核对密钥链版本与 GCM 认证标签。',
    httpStatus: 500,
    toolVisible: false,
  },
  MEMORY_ERROR: {
    code: 'MEMORY_ERROR',
    severity: 'error',
    retryability: 'immediate',
    userMessage: '记忆存储读写失败，数据可能暂时不可用。',
    internalDetail: '持久化读写失败或记忆库损坏：检查 SQLite/JSON 后端健康度与备份。',
    httpStatus: 500,
    toolVisible: true,
  },
  NETWORK_ERROR: {
    code: 'NETWORK_ERROR',
    severity: 'error',
    retryability: 'backoff',
    userMessage: '网络通信失败，请稍后重试。',
    internalDetail: 'WebSocket/HTTP/节点间通信失败：检查端点可达性与断线重连状态。',
    httpStatus: 502,
    toolVisible: true,
  },
  TIMEOUT_ERROR: {
    code: 'TIMEOUT_ERROR',
    severity: 'warning',
    retryability: 'backoff',
    userMessage: '操作超时，请稍后重试。',
    internalDetail: '模型调用或任务执行超过时限：核对超时配置与下游负载，按退避重试。',
    httpStatus: 504,
    toolVisible: true,
  },
  EXECUTION_ERROR: {
    code: 'EXECUTION_ERROR',
    severity: 'error',
    retryability: 'never',
    userMessage: '任务执行失败，请检查任务描述后重试。',
    internalDetail: '计划节点执行失败：查看 details.nodeId 与 NodeResult.error 定位失败节点。',
    httpStatus: 500,
    toolVisible: true,
  },
  LLM_ERROR: {
    code: 'LLM_ERROR',
    severity: 'error',
    retryability: 'backoff',
    userMessage: '模型服务调用失败，请稍后重试。',
    internalDetail: '模型端点返回错误：核对 LLMError.status / retryable 与模型注册配置。',
    httpStatus: 502,
    toolVisible: true,
  },
  TOOL_ERROR: {
    code: 'TOOL_ERROR',
    severity: 'warning',
    retryability: 'never',
    userMessage: '工具调用失败：参数或执行环境有误。',
    internalDetail: 'Tool 层执行/参数错误：核对工具入参 schema 与注册表状态。',
    httpStatus: 400,
    toolVisible: true,
  },
  VALIDATION_ERROR: {
    code: 'VALIDATION_ERROR',
    severity: 'warning',
    retryability: 'never',
    userMessage: '输入数据不符合要求，请修正后重试。',
    internalDetail: '运行时契约校验失败：errors[] 为路径化错误列表，逐条修正。',
    httpStatus: 422,
    toolVisible: true,
  },
  AGGREGATE_ERROR: {
    code: 'AGGREGATE_ERROR',
    severity: 'error',
    retryability: 'after-fix',
    userMessage: '多项操作失败，详情见错误列表。',
    internalDetail: '聚合错误：childErrors 逐项解包定位，任一子错误修复后再整体重试。',
    httpStatus: 500,
    toolVisible: true,
  },
  BENCHMARK_ERROR: {
    code: 'BENCHMARK_ERROR',
    severity: 'warning',
    retryability: 'never',
    userMessage: '基准测试执行失败。',
    internalDetail: '基准引擎错误：核对基准任务集与运行环境。',
    httpStatus: 500,
    toolVisible: false,
  },
  UNKNOWN_ERROR: {
    code: 'UNKNOWN_ERROR',
    severity: 'error',
    retryability: 'immediate',
    userMessage: '发生未知错误，请重试；若持续出现请联系管理员。',
    internalDetail: '非 AppError 抛出物（字符串/普通 Error/拒绝值）：补齐类型化包装后归类。',
    httpStatus: 500,
    toolVisible: true,
  },
} satisfies Readonly<Record<string, ErrorTaxonomyEntry>>;

/** 错误码注册表：code → 分类学条目（只读快照） */
export const ERROR_REGISTRY: Readonly<Record<string, ErrorTaxonomyEntry>> = ERROR_TAXONOMIES;

/** 全部已注册错误码的字面量联合（类型化 code——拼写错误编译期即报） */
export type RegisteredErrorCode = keyof typeof ERROR_TAXONOMIES;

/** 已注册错误码列表（注册序，非对象键序的环境敏感顺序） */
export const REGISTERED_ERROR_CODES: readonly RegisteredErrorCode[] = Object.keys(ERROR_TAXONOMIES) as RegisteredErrorCode[];

/** TypedAppError 构造选项：code 解析注册表缺省，其余字段可逐项覆盖 */
export interface TypedErrorOptions {
  /** 错误码：在册则继承其分类学缺省；不在册则按通用缺省合成（仍字段完备） */
  code?: string;
  severity?: ErrorSeverity;
  retryability?: ErrorRetryability;
  userMessage?: string;
  internalDetail?: string;
  httpStatus?: number;
  toolVisible?: boolean;
  /** 附加上下文（沿用 AppError.details 语义） */
  details?: Record<string, unknown>;
  /** 被包装的底层原因（wrapError 的链式来源） */
  cause?: unknown;
}

/**
 * 类型化应用错误：AppError 的分类学升级版
 *
 * 构造时解析注册表缺省 → 六要素（code/severity/retryability/
 * userMessage/internalDetail/httpStatus）+ toolVisible 永远完备；
 * 既有 AppError instanceof 判定与 code/details 字段全部兼容。
 */
export class TypedAppError extends AppError {
  public override readonly code: string;
  /** 严重度分级 */
  public readonly severity: ErrorSeverity;
  /** 可重试性分级 */
  public readonly retryability: ErrorRetryability;
  /** 租户安全文案（可直接透出，不含内部细节） */
  public readonly userMessage: string;
  /** 内部诊断指引（仅进日志） */
  public readonly internalDetail: string;
  /** 建议映射 HTTP 状态码 */
  public readonly httpStatus: number;
  /** 是否作为结构化错误返回 Tool 调用方 */
  public readonly toolVisible: boolean;
  /** 被包装的底层原因（ES2022 Error.cause 同名字段，显式声明便于序列化） */
  public readonly cause?: unknown;

  constructor(message: string, options: TypedErrorOptions = {}) {
    const base = resolveTaxonomy(options.code);
    super(message, base.code, options.details);
    this.code = base.code;
    this.severity = options.severity ?? base.severity;
    this.retryability = options.retryability ?? base.retryability;
    this.userMessage = options.userMessage ?? base.userMessage;
    this.internalDetail = options.internalDetail ?? base.internalDetail;
    this.httpStatus = options.httpStatus ?? base.httpStatus;
    this.toolVisible = options.toolVisible ?? base.toolVisible;
    this.cause = options.cause;
  }

  /** 导出为注册表条目形态（与 ERROR_REGISTRY 单条同构） */
  toTaxonomyEntry(): ErrorTaxonomyEntry {
    return {
      code: this.code,
      severity: this.severity,
      retryability: this.retryability,
      userMessage: this.userMessage,
      internalDetail: this.internalDetail,
      httpStatus: this.httpStatus,
      toolVisible: this.toolVisible,
    };
  }

  /** 是否值得重试（immediate / backoff） */
  get retryable(): boolean {
    return this.retryability === 'immediate' || this.retryability === 'backoff';
  }

  /** JSON 安全的扁平形态（不含原型链；与 serializeError 单条一致） */
  toJSON(): Record<string, unknown> {
    return serializeError(this) as unknown as Record<string, unknown>;
  }
}

/**
 * 聚合错误：一批子错误一次性上抛（批量校验 / 并行任务汇总失败）
 *
 * childErrors 保留原始抛出物；序列化/分类时逐项展开。
 * 建议消息由 fromChildren 自动汇总各子错误 code 计数。
 */
export class AggregateAppError extends TypedAppError {
  /** 聚合的子错误（保持传入顺序，不吞原始抛出物） */
  public readonly childErrors: readonly unknown[];

  constructor(message: string, childErrors: readonly unknown[] = [], options: TypedErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? 'AGGREGATE_ERROR' });
    this.childErrors = childErrors;
  }

  /** 从子错误列表构造：消息自动汇总（确定性——按注册序遍历 code 计数） */
  static fromChildren(childErrors: readonly unknown[], message?: string, options?: TypedErrorOptions): AggregateAppError {
    const counts = new Map<string, number>();
    for (const child of childErrors) {
      const code = classifyTaxonomy(child).code;
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
    const summary = [...counts.entries()].map(([code, n]) => `${code}×${n}`).join(', ');
    return new AggregateAppError(message ?? `聚合失败：${childErrors.length} 个子错误（${summary || '空'}）`, childErrors, options);
  }

  /** 子错误分类学条目列表 */
  childTaxonomies(): ErrorTaxonomyEntry[] {
    return this.childErrors.map((child) => classifyTaxonomy(child));
  }
}

/** 错误码 → 注册表条目（不在册时按通用缺省合成完备条目） */
export function resolveTaxonomy(code: string | undefined): ErrorTaxonomyEntry {
  const registered = code !== undefined ? ERROR_REGISTRY[code] : undefined;
  if (registered !== undefined) return registered;
  return {
    code: code && code.length > 0 ? code : 'APP_ERROR',
    severity: 'error',
    retryability: 'never',
    userMessage: '服务内部错误，请稍后重试或联系管理员。',
    internalDetail: `错误码 ${String(code)} 未注册：补注册表条目后获得精确分类。`,
    httpStatus: 500,
    toolVisible: true,
  };
}

/** 结构化序列化形态（JSON 可往返） */
export interface SerializedError {
  kind: 'typed-error';
  /** 原错误类名（deserializeError 回填 name） */
  name: string;
  code: string;
  message: string;
  severity: ErrorSeverity;
  retryability: ErrorRetryability;
  userMessage: string;
  internalDetail: string;
  httpStatus: number;
  toolVisible: boolean;
  details?: Record<string, unknown>;
  /** 因果链下一环（wrapError 产生） */
  cause?: SerializedError;
  /** 聚合子错误（AggregateAppError 产生） */
  children?: SerializedError[];
}

/** 任意抛出物 → 结构化序列化形态（legacy Error / 字符串 / 拒绝值均可） */
export function serializeError(error: unknown): SerializedError {
  const entry = classifyTaxonomy(error);
  const base: SerializedError = {
    kind: 'typed-error',
    name: errorName(error),
    code: entry.code,
    message: errorMessage(error),
    severity: entry.severity,
    retryability: entry.retryability,
    userMessage: entry.userMessage,
    internalDetail: entry.internalDetail,
    httpStatus: entry.httpStatus,
    toolVisible: entry.toolVisible,
  };
  if (error instanceof AppError && error.details !== undefined) base.details = error.details;
  if (error instanceof AggregateAppError && error.childErrors.length > 0) {
    base.children = error.childErrors.map((child) => serializeError(child));
  } else if (error instanceof TypedAppError && error.cause !== undefined) {
    base.cause = serializeError(error.cause);
  } else if (!(error instanceof TypedAppError) && error instanceof Error && error.cause !== undefined) {
    base.cause = serializeError(error.cause);
  }
  return base;
}

/** 结构化形态 → TypedAppError（JSON 往返的另一侧；非法输入抛 VALIDATION_ERROR） */
export function deserializeError(data: unknown): TypedAppError {
  if (typeof data !== 'object' || data === null) {
    throw new TypedAppError('反序列化失败：输入不是对象', { code: 'VALIDATION_ERROR', details: { got: typeof data } });
  }
  const raw = data as Partial<SerializedError> & { message?: unknown; code?: unknown };
  if (typeof raw.message !== 'string' || typeof raw.code !== 'string') {
    throw new TypedAppError('反序列化失败：缺少 message / code 字段', { code: 'VALIDATION_ERROR' });
  }
  const children = Array.isArray(raw.children) ? raw.children.map((child) => deserializeError(child)) : undefined;
  if (children !== undefined) {
    const agg = new AggregateAppError(raw.message, children, {
      code: raw.code,
      severity: raw.severity,
      retryability: raw.retryability,
      userMessage: raw.userMessage,
      internalDetail: raw.internalDetail,
      httpStatus: raw.httpStatus,
      toolVisible: raw.toolVisible,
      details: raw.details,
    });
    agg.name = typeof raw.name === 'string' ? raw.name : agg.name;
    return agg;
  }
  const restored = new TypedAppError(raw.message, {
    code: raw.code,
    severity: raw.severity,
    retryability: raw.retryability,
    userMessage: raw.userMessage,
    internalDetail: raw.internalDetail,
    httpStatus: raw.httpStatus,
    toolVisible: raw.toolVisible,
    details: raw.details,
    cause: raw.cause !== undefined ? deserializeError(raw.cause) : undefined,
  });
  restored.name = typeof raw.name === 'string' ? raw.name : restored.name;
  return restored;
}

/**
 * 任意抛出物 → 分类学条目（TypedAppError 取自身；AppError 按 code 查表；其余走兜底）
 *
 * 命名：classifyTaxonomy——与 src/core/resilience.ts 的 classifyError
 * （重试分型：{class,kind,reason}）语义不同且名字不冲突，二者在 barrel 并存。
 */
export function classifyTaxonomy(error: unknown): ErrorTaxonomyEntry {
  if (error instanceof TypedAppError) return error.toTaxonomyEntry();
  if (error instanceof AggregateAppError) return error.toTaxonomyEntry();
  if (error instanceof AppError) {
    const entry = ERROR_REGISTRY[error.code];
    if (entry !== undefined) return entry;
    return resolveTaxonomy(error.code);
  }
  if (error instanceof Error) {
    // 常见内置错误按语义就近归类
    const name = error.name;
    if (name === 'TimeoutError' || /timeout/i.test(error.message)) return ERROR_REGISTRY.TIMEOUT_ERROR;
    if (name === 'TypeError' || name === 'RangeError' || name === 'SyntaxError') return ERROR_REGISTRY.VALIDATION_ERROR;
    if (name === 'AggregateError') return ERROR_REGISTRY.AGGREGATE_ERROR;
    return ERROR_REGISTRY.UNKNOWN_ERROR;
  }
  return ERROR_REGISTRY.UNKNOWN_ERROR;
}

/** 错误 → 建议 HTTP 状态码（映射助手） */
export function errorToHttpStatus(error: unknown): number {
  // LLMError 携带真实 HTTP status 时优先
  if (error !== null && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number') {
    const status = (error as { status: number }).status;
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  return classifyTaxonomy(error).httpStatus;
}

/** 错误 → Tool 层结构化返回值（ok:false 判别形态，internalDetail 默认不透出） */
export function errorToToolReturn(error: unknown): {
  ok: false;
  code: string;
  userMessage: string;
  severity: ErrorSeverity;
  retryable: boolean;
  details?: Record<string, unknown>;
} {
  const entry = classifyTaxonomy(error);
  const out: {
    ok: false;
    code: string;
    userMessage: string;
    severity: ErrorSeverity;
    retryable: boolean;
    details?: Record<string, unknown>;
  } = {
    ok: false,
    code: entry.code,
    userMessage: entry.userMessage,
    severity: entry.severity,
    retryable: entry.retryability === 'immediate' || entry.retryability === 'backoff',
  };
  if (error instanceof AppError && error.details !== undefined) out.details = error.details;
  return out;
}

/** 是否值得重试（immediate / backoff；其余分级重试无意义） */
export function isRetryableError(error: unknown): boolean {
  const { retryability } = classifyTaxonomy(error);
  return retryability === 'immediate' || retryability === 'backoff';
}

/** 包装底层原因：保留 cause 链与原始消息，code 默认沿用注册表 */
export function wrapError(cause: unknown, message: string, options: TypedErrorOptions = {}): TypedAppError {
  return new TypedAppError(message, { ...options, cause });
}

/** 因果链解包：[error, cause, cause 的 cause, ...]（非 TypedAppError 链最多退 1 环） */
export function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    const next = (current as { cause?: unknown }).cause;
    if (next === undefined) break;
    current = next;
  }
  return chain;
}

/** 根因：因果链最后一环（链为空时返回原值） */
export function rootCause(error: unknown): unknown {
  const chain = errorChain(error);
  return chain.length > 0 ? chain[chain.length - 1] : error;
}

// ── 内部小工具 ──
function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return '[unstringifiable]';
  }
}

// ═══════════════════════════════════════════════════════════════════
// 第四轮模块域升级（R4-A16 · 基础契约层）：错误重试策略声明
//
// 错误码 → 重试策略（不重试 / 立即 / 退避 / 升级人工）的声明式映射
// 与判定助手。纯增量：分类学 retryability 是「性质」，这里是「运维动作」。
// 解析顺序：显式覆盖（registerRetryPolicy）→ 错误码注册表 retryability
// 派生缺省 → 保守缺省（未注册码不重试——宁可少做不误做）。
// 确定性：延迟为纯指数计算（base × 2^(n-1)，封顶 cap），无随机抖动源。
// ═══════════════════════════════════════════════════════════════════

/** 重试策略四分法（运维动作口径） */
export type RetryPolicyKind = 'none' | 'immediate' | 'backoff' | 'escalate';

/** 单个错误码的重试策略声明 */
export interface RetryPolicy {
  /** 策略种类：none 不重试 / immediate 立即原样重试 / backoff 指数退避 / escalate 升级人工 */
  readonly kind: RetryPolicyKind;
  /** 总尝试上限（含首次；none / escalate 为 1——不自动重试） */
  readonly maxAttempts: number;
  /** backoff：第 n 次重试延迟 = base × 2^(n-1)（毫秒） */
  readonly backoffBaseMs?: number;
  /** backoff：单次延迟上限（毫秒） */
  readonly backoffCapMs?: number;
  /** 连续失败达到此数后升级人工（可选；none/escalate 语义上为 1） */
  readonly escalateAfter?: number;
  /** 策略说明（进日志/审计） */
  readonly description: string;
}

/** 未注册错误码的保守缺省：不重试（诚实报告需要补注册） */
export const CONSERVATIVE_RETRY_POLICY: RetryPolicy = {
  kind: 'none',
  maxAttempts: 1,
  description: '未注册错误码：保守缺省不重试（registerRetryPolicy 或补错误码注册表条目后获得精确路由）',
};

/** 分类学 retryability → 缺省重试策略（声明式派生，字段完备） */
export const RETRY_POLICY_DEFAULTS: Readonly<Record<ErrorRetryability, RetryPolicy>> = {
  never: {
    kind: 'none',
    maxAttempts: 1,
    description: '重试必然复现（配置/逻辑错）：不重试',
  },
  immediate: {
    kind: 'immediate',
    maxAttempts: 3,
    escalateAfter: 3,
    description: '瞬态抖动/幂等读：立即原样重试，至多 3 次',
  },
  backoff: {
    kind: 'backoff',
    maxAttempts: 4,
    backoffBaseMs: 500,
    backoffCapMs: 30_000,
    escalateAfter: 4,
    description: '限流/过载/超时：指数退避 500ms 起、封顶 30s，至多 4 次',
  },
  'after-fix': {
    kind: 'escalate',
    maxAttempts: 1,
    escalateAfter: 1,
    description: '前置条件缺失（密钥/依赖）：不自动重试，修复前置或人工介入',
  },
};

/** 显式覆盖表（registerRetryPolicy 写入；进程内可变，按注册序可枚举） */
const retryPolicyOverrides = new Map<string, RetryPolicy>();

/** 校验策略形态（诚实构造点：字段非法即抛 VALIDATION_ERROR） */
function assertRetryPolicyShape(code: string, policy: RetryPolicy): void {
  if (policy === null || typeof policy !== 'object') {
    throw new TypedAppError(`重试策略声明必须是对象（码 ${code}）`, { code: 'VALIDATION_ERROR' });
  }
  const kinds: ReadonlySet<string> = new Set(['none', 'immediate', 'backoff', 'escalate']);
  if (!kinds.has(policy.kind)) {
    throw new TypedAppError(`重试策略 kind 非法：${String(policy.kind)}（码 ${code}；期望 none|immediate|backoff|escalate）`, {
      code: 'VALIDATION_ERROR',
      details: { code, kind: policy.kind },
    });
  }
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new TypedAppError(`重试策略 maxAttempts 必须为 ≥1 整数（码 ${code}，实际 ${String(policy.maxAttempts)}）`, {
      code: 'VALIDATION_ERROR',
    });
  }
  if (policy.kind === 'none' || policy.kind === 'escalate') {
    if (policy.maxAttempts !== 1) {
      throw new TypedAppError(`重试策略 ${policy.kind} 的 maxAttempts 必须为 1（不自动重试；码 ${code}）`, {
        code: 'VALIDATION_ERROR',
      });
    }
  }
  if (policy.kind === 'backoff') {
    if (typeof policy.backoffBaseMs !== 'number' || !Number.isFinite(policy.backoffBaseMs) || policy.backoffBaseMs <= 0) {
      throw new TypedAppError(`backoff 策略必须携带正的 backoffBaseMs（码 ${code}）`, { code: 'VALIDATION_ERROR' });
    }
    if (policy.backoffCapMs !== undefined && (typeof policy.backoffCapMs !== 'number' || policy.backoffCapMs < policy.backoffBaseMs)) {
      throw new TypedAppError(`backoff 策略的 backoffCapMs 必须 ≥ backoffBaseMs（码 ${code}）`, { code: 'VALIDATION_ERROR' });
    }
  }
  if (typeof policy.description !== 'string' || policy.description.trim().length === 0) {
    throw new TypedAppError(`重试策略声明缺少 description（码 ${code}）`, { code: 'VALIDATION_ERROR' });
  }
}

/**
 * 显式注册/覆盖某错误码的重试策略（优先级最高）
 * @returns 本次注册后的生效策略
 */
export function registerRetryPolicy(code: string, policy: RetryPolicy): RetryPolicy {
  if (typeof code !== 'string' || code.trim().length === 0) {
    throw new TypedAppError('重试策略的错误码不能为空', { code: 'VALIDATION_ERROR' });
  }
  assertRetryPolicyShape(code, policy);
  retryPolicyOverrides.set(code, policy);
  return policy;
}

/** 已显式覆盖的错误码清单（注册序） */
export function registeredRetryPolicyCodes(): readonly string[] {
  return [...retryPolicyOverrides.keys()];
}

/** 撤销显式覆盖（回退到注册表派生缺省；未注册码静默） */
export function unregisterRetryPolicy(code: string): boolean {
  return retryPolicyOverrides.delete(code);
}

/**
 * 错误 → 重试策略（判定助手）
 *
 * 解析顺序（逐级回退，确定性）：
 * 1. 显式覆盖表（registerRetryPolicy）
 * 2. 分类学 retryability 派生缺省（TypedAppError 自身 / AppError 按 code 查表 /
 *    普通 Error 就近归类——classifyTaxonomy 同一原子）
 * 3. CONSERVATIVE_RETRY_POLICY（未注册码：不重试）
 */
export function retryPolicyFor(error: unknown): RetryPolicy {
  const code = classifyTaxonomy(error).code;
  const override = retryPolicyOverrides.get(code);
  if (override !== undefined) return override;
  const entry = ERROR_REGISTRY[code];
  if (entry !== undefined) return RETRY_POLICY_DEFAULTS[entry.retryability];
  return CONSERVATIVE_RETRY_POLICY;
}

/**
 * 是否应发起下一次重试
 * @param error 待判错误
 * @param attemptsMade 已尝试次数（首次失败后为 1；须为 ≥1 整数）
 */
export function shouldRetry(error: unknown, attemptsMade: number): boolean {
  if (!Number.isInteger(attemptsMade) || attemptsMade < 1) {
    throw new TypedAppError(`attemptsMade 必须为 ≥1 整数（实际 ${String(attemptsMade)}）`, { code: 'VALIDATION_ERROR' });
  }
  const policy = retryPolicyFor(error);
  if (policy.kind === 'none' || policy.kind === 'escalate') return false;
  return attemptsMade < policy.maxAttempts;
}

/**
 * 下一次重试的等待毫秒数（确定性：无抖动）
 *
 * immediate → 0；backoff → min(cap, base × 2^(attemptsMade-1))；
 * none/escalate → 0（调用方应先经 shouldRetry 判定）。
 * @param attemptsMade 已尝试次数（≥1）
 */
export function retryDelayMs(error: unknown, attemptsMade: number): number {
  if (!Number.isInteger(attemptsMade) || attemptsMade < 1) {
    throw new TypedAppError(`attemptsMade 必须为 ≥1 整数（实际 ${String(attemptsMade)}）`, { code: 'VALIDATION_ERROR' });
  }
  const policy = retryPolicyFor(error);
  if (policy.kind === 'immediate' || policy.kind === 'none' || policy.kind === 'escalate') return 0;
  const base = policy.backoffBaseMs ?? RETRY_POLICY_DEFAULTS.backoff.backoffBaseMs ?? 500;
  const cap = policy.backoffCapMs ?? Number.MAX_SAFE_INTEGER;
  const raw = base * 2 ** (attemptsMade - 1);
  return Math.min(cap, raw);
}

/** 一次失败的完整确定性重试计划（attempt 序号从 2 起为重试） */
export interface RetryPlan {
  /** 判定来源策略 */
  readonly policy: RetryPolicy;
  /** 判定用的错误码 */
  readonly code: string;
  /** 重试步骤（空 = 不重试）：attempt=2..maxAttempts，各带等待毫秒 */
  readonly steps: ReadonlyArray<{ readonly attempt: number; readonly delayMs: number }>;
}

/** 展开完整重试计划（错误流调度/审计用；确定性：同错误同计划） */
export function planRetries(error: unknown): RetryPlan {
  const policy = retryPolicyFor(error);
  const code = classifyTaxonomy(error).code;
  const steps: Array<{ attempt: number; delayMs: number }> = [];
  if (policy.kind === 'immediate' || policy.kind === 'backoff') {
    for (let attempt = 2; attempt <= policy.maxAttempts; attempt += 1) {
      steps.push({ attempt, delayMs: retryDelayMs(error, attempt - 1) });
    }
  }
  return { policy, code, steps };
}

/**
 * 是否应升级人工介入
 * escalate 策略恒 true；其余策略在连续失败达 escalateAfter 时 true；
 * 未声明 escalateAfter 的策略由 attemptsMade ≥ maxAttempts（重试预算耗尽）兜底。
 * @param error 待判错误
 * @param consecutiveFailures 连续失败次数（≥0 整数）
 */
export function needsHumanEscalation(error: unknown, consecutiveFailures: number): boolean {
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 0) {
    throw new TypedAppError(`consecutiveFailures 必须为 ≥0 整数（实际 ${String(consecutiveFailures)}）`, { code: 'VALIDATION_ERROR' });
  }
  const policy = retryPolicyFor(error);
  if (policy.kind === 'escalate') return true;
  const threshold = policy.escalateAfter ?? policy.maxAttempts;
  return consecutiveFailures >= threshold;
}

