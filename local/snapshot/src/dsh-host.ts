/**
 * dsh-host.ts — DSH 宿主集成层
 *
 * 职责：经 cordis ctx 上下文解析 DSH 宿主提供的 LLM 能力，
 * 使插件无需在配置中携带任何 API Key：
 *
 * 1. resolveHostLLM(ctx)：优先获取宿主已配置好的 LLM 客户端
 *    （服务名 llmClient / llm / modelClient / dsh.llm），委托全部模型调用；
 * 2. resolveHostModels(ctx)：获取宿主模型目录（llmModels / models / dsh.models），
 *    用于在宿主未提供客户端时注册端点（Key 由头部注入器提供）；
 * 3. resolveHeaderProvider(ctx)：获取宿主请求头注入器
 *    （llmHeaders / dsh.llmHeaders / 函数型 llmHeaderProvider），
 *    DSH 会把用户在 Web UI / 环境变量中配置的 Key 注入请求头。
 *
 * 解析顺序遵循"宿主优先、配置兜底"：任何一项解析失败都不阻断插件启动，
 * 由 index.ts 回退到 cordis.patch.yml 中的 models 配置。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ChatMessage, ChatOptions, LLMResponse, ModelConfig } from './llm-client.js';

/** 宿主 LLM 客户端的最小调用面（chat / complete / call 任一即可） */
export interface HostLLMClientLike {
  chat?: (modelId: string, messages: ChatMessage[], options?: ChatOptions) => Promise<LLMResponse | { content: string; tokensUsed?: number; cost?: number }>;
  complete?: (modelId: string, messages: ChatMessage[], options?: ChatOptions) => Promise<LLMResponse | { content: string; tokensUsed?: number; cost?: number }>;
  call?: (modelId: string, messages: ChatMessage[], options?: ChatOptions) => Promise<LLMResponse | { content: string; tokensUsed?: number; cost?: number }>;
}

/** 宿主模型目录条目的宽松形态 */
interface HostModelEntry {
  id?: string;
  name?: string;
  model?: string;
  endpoint?: string;
  baseUrl?: string;
  base_url?: string;
  timeout?: number;
  maxConcurrency?: number;
  costPerKToken?: number;
  contextWindow?: number;
  initialCapabilities?: ModelConfig['initialCapabilities'];
}

/** 从 ctx 安全读取服务（不存在返回 undefined，不抛错） */
function tryGet(ctx: Context, name: string): any {
  try {
    return (ctx as any).get?.(name);
  } catch {
    return undefined;
  }
}

/** 归一化宿主客户端的返回值为 LLMResponse */
function normalizeResponse(raw: any, modelId: string): LLMResponse {
  return {
    content: typeof raw?.content === 'string' ? raw.content : '',
    model: raw?.model ?? modelId,
    latency: typeof raw?.latency === 'number' ? raw.latency : 0,
    tokensUsed: typeof raw?.tokensUsed === 'number' ? raw.tokensUsed : 0,
    cost: typeof raw?.cost === 'number' ? raw.cost : 0,
    retries: typeof raw?.retries === 'number' ? raw.retries : 0,
  };
}

/**
 * 解析宿主已配置的 LLM 客户端。
 * @returns 统一的调用器；宿主未提供时返回 undefined
 */
export function resolveHostLLM(
  ctx: Context,
): ((modelId: string, messages: ChatMessage[], options: ChatOptions) => Promise<LLMResponse>) | undefined {
  const candidates = [tryGet(ctx, 'llmClient'), tryGet(ctx, 'llm'), tryGet(ctx, 'modelClient'), tryGet(ctx, 'dsh.llm')];
  for (const client of candidates) {
    if (!client || typeof client !== 'object') continue;
    const host = client as HostLLMClientLike;
    const fn = host.chat ?? host.complete ?? host.call;
    if (typeof fn === 'function') {
      return async (modelId, messages, options) =>
        normalizeResponse(await fn.call(host, modelId, messages, options), modelId);
    }
  }
  return undefined;
}

/**
 * 解析宿主模型目录为插件 ModelConfig 列表（不含 Key）。
 * @returns 模型配置数组；宿主未提供时返回空数组
 */
export function resolveHostModels(ctx: Context): ModelConfig[] {
  const raw = tryGet(ctx, 'llmModels') ?? tryGet(ctx, 'models') ?? tryGet(ctx, 'dsh.models');
  if (!Array.isArray(raw)) return [];

  const models: ModelConfig[] = [];
  for (const entry of raw as HostModelEntry[]) {
    if (!entry || typeof entry !== 'object') continue;
    const id = entry.id ?? entry.model ?? entry.name;
    const endpoint = entry.endpoint ?? entry.baseUrl ?? entry.base_url;
    if (!id || !endpoint) continue;
    models.push({
      id,
      name: entry.name,
      endpoint,
      timeout: entry.timeout,
      maxConcurrency: entry.maxConcurrency,
      costPerKToken: entry.costPerKToken,
      contextWindow: entry.contextWindow,
      initialCapabilities: entry.initialCapabilities,
    });
  }
  return models;
}

/**
 * 解析宿主请求头注入器（DSH 将用户配置的 Key 注入请求头）。
 * @returns 按 modelId 返回头部的函数；宿主未提供时返回 undefined
 */
export function resolveHeaderProvider(
  ctx: Context,
): ((modelId: string) => Record<string, string> | undefined) | undefined {
  const direct = tryGet(ctx, 'llmHeaderProvider');
  if (typeof direct === 'function') return direct;

  const provider = tryGet(ctx, 'llmHeaders') ?? tryGet(ctx, 'dsh.llmHeaders');
  if (typeof provider === 'function') return provider;
  if (provider && typeof provider === 'object') {
    // 静态头部表：{ [modelId]: { Authorization: 'Bearer xxx' } } 或全局头部
    const table = provider as Record<string, any>;
    return (modelId) => {
      const perModel = table[modelId];
      if (perModel && typeof perModel === 'object') return perModel;
      if (table.Authorization || table.authorization) return table as Record<string, string>;
      return undefined;
    };
  }
  return undefined;
}

// ─────────────────────────── 本地密钥自动填入 ───────────────────────────

/** 厂商识别规则：模型 id 前缀 → 环境变量候选列表 */
const VENDOR_ENV_VARS: Array<{ match: RegExp; envVars: string[] }> = [
  { match: /^deepseek/i, envVars: ['DEEPSEEK_API_KEY'] },
  { match: /^qwen|^qwq/i, envVars: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'ALIBABA_CLOUD_API_KEY'] },
  { match: /^glm|^chatglm/i, envVars: ['ZHIPU_API_KEY', 'ZHIPUAI_API_KEY'] },
  { match: /^moonshot|^kimi/i, envVars: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'] },
  { match: /^abab/i, envVars: ['MINIMAX_API_KEY'] },
  { match: /^general|^spark/i, envVars: ['SPARK_API_KEY', 'IFLYTEK_API_KEY', 'XFYUN_API_KEY'] },
  { match: /^hunyuan/i, envVars: ['HUNYUAN_API_KEY', 'TENCENT_HUNYUAN_API_KEY'] },
  { match: /^ernie/i, envVars: ['QIANFAN_API_KEY', 'ERNIE_API_KEY', 'BAIDU_API_KEY'] },
  { match: /^sensechat|^sense/i, envVars: ['SENSENOVA_API_KEY', 'SENSETIME_API_KEY'] },
];

/** DSH 本地配置文件探测路径（宿主在本地保存用户 Web UI 配置的常见位置） */
const LOCAL_CONFIG_PATHS = [
  '~/.dsh/config.json',
  '~/.dsh/llm.json',
  '~/.config/dsh/config.json',
  '~/.config/dsh/llm.json',
  '~/.deepseek-harness/config.json',
];

/** 按模型 id 识别厂商环境变量并返回首个非空值 */
function envKeyForModel(modelId: string): string | undefined {
  for (const rule of VENDOR_ENV_VARS) {
    if (!rule.match.test(modelId)) continue;
    for (const envVar of rule.envVars) {
      const value = process.env[envVar];
      if (value) return value;
    }
  }
  return undefined;
}

/** 深度优先查找对象中的 apiKey 字段（兼容 models 数组 / 厂商键两种形态） */
function findApiKeyInConfig(obj: any, modelId: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;

  // models 数组形态：[{ id, apiKey }]
  if (Array.isArray(obj.models)) {
    for (const entry of obj.models) {
      if (entry?.id === modelId && typeof entry.apiKey === 'string' && entry.apiKey) return entry.apiKey;
    }
  }

  // 精确模型键：{ "deepseek-v4-pro": { apiKey } } 或 { "deepseek-v4-pro": "sk-..." }
  const exact = obj[modelId];
  if (typeof exact === 'string' && exact) return exact;
  if (exact && typeof exact === 'object' && typeof exact.apiKey === 'string' && exact.apiKey) return exact.apiKey;

  // 厂商键：{ deepseek: { apiKey } } / { deepseek: "sk-..." }
  for (const rule of VENDOR_ENV_VARS) {
    if (!rule.match.test(modelId)) continue;
    for (const vendorKey of rule.envVars[0].replace(/_API_KEY$/, '').toLowerCase().split('_').slice(0, 1)) {
      const entry = obj[vendorKey];
      if (typeof entry === 'string' && entry) return entry;
      if (entry && typeof entry === 'object' && typeof entry.apiKey === 'string' && entry.apiKey) return entry.apiKey;
    }
  }

  // 全局兜底：{ apiKey } / { llm: { apiKey } }
  if (typeof obj.apiKey === 'string' && obj.apiKey) return obj.apiKey;
  if (obj.llm && typeof obj.llm === 'object') return findApiKeyInConfig(obj.llm, modelId);
  return undefined;
}

/** 本地配置文件发现/缓存状态（支持热更新：mtime 变化自动重读） */
let localConfigCache: any | null | undefined;
let localConfigPath: string | null | undefined;
let localConfigMtime = 0;
let localConfigMissAt = 0;
/** 未找到配置文件时的重新探测间隔（Web UI 后续写入也能被感知） */
const LOCAL_CONFIG_RETRY_MS = 60_000;

/** 探测首个可读的本地配置文件路径 */
function discoverLocalConfigPath(): string | null {
  for (const rawPath of LOCAL_CONFIG_PATHS) {
    const filePath = rawPath.startsWith('~') ? rawPath.replace('~', os.homedir()) : rawPath;
    try {
      fs.accessSync(filePath, fs.constants.R_OK);
      return filePath;
    } catch {
      /* 路径不存在，继续下一个 */
    }
  }
  return null;
}

/** 读取本地配置文件（mtime 热更新 + 缺失时定期重探测，失败静默） */
function loadLocalConfig(): any | null {
  const now = Date.now();
  if (localConfigPath === undefined) {
    localConfigPath = discoverLocalConfigPath();
    if (!localConfigPath) localConfigMissAt = now;
  } else if (!localConfigPath && now - localConfigMissAt > LOCAL_CONFIG_RETRY_MS) {
    localConfigPath = discoverLocalConfigPath();
    if (!localConfigPath) localConfigMissAt = now;
  }
  if (!localConfigPath) return localConfigCache ?? null;
  try {
    const stat = fs.statSync(localConfigPath);
    if (localConfigCache === undefined || stat.mtimeMs !== localConfigMtime) {
      localConfigCache = JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
      localConfigMtime = stat.mtimeMs;
    }
    return localConfigCache;
  } catch {
    localConfigPath = undefined; // 文件被删/不可读，下次重新探测
    return localConfigCache ?? null;
  }
}

/**
 * 本地密钥候选列表（按优先级排序，支持多密钥故障转移）：
 * 1. 进程环境变量（按模型 id 前缀匹配厂商，多个候选变量依次排列）；
 * 2. DSH 本地配置文件（~/.dsh/config.json 等，用户在 Web UI 配置的落盘位置）。
 * @returns 带来源标记的密钥候选数组（可能为空）
 */
export function resolveLocalKeyCandidates(modelId: string): Array<{ source: string; key: string }> {
  const candidates: Array<{ source: string; key: string }> = [];
  const rule = VENDOR_ENV_VARS.find((r) => r.match.test(modelId));
  if (rule) {
    for (const envVar of rule.envVars) {
      const value = process.env[envVar];
      if (value) candidates.push({ source: `env:${envVar}`, key: value });
    }
  }
  const fileKey = findApiKeyInConfig(loadLocalConfig(), modelId);
  if (fileKey) candidates.push({ source: 'local-config', key: fileKey });
  return candidates;
}

/**
 * 本地密钥提供器：自动从宿主本地来源读取 Key 并填入 Authorization 请求头。
 * keyAttempt 用于故障转移：认证/配额失败时 LLMClient 递增 attempt。
 * 传入 manager 时启用健康感知路由（按健康度选择 + 冷却规避），
 * 否则退化为顺序轮换。密钥只进内存、不落盘、不打印日志。
 * @returns 按 (modelId, keyAttempt) 返回请求头的函数
 */
export function resolveLocalKeyProvider(
  manager?: KeyHealthManager,
): (modelId: string, keyAttempt?: number) => Record<string, string> | undefined {
  return (modelId, keyAttempt = 0) => {
    const candidates = resolveLocalKeyCandidates(modelId);
    if (candidates.length === 0) return undefined;
    const pick = manager
      ? manager.pick(modelId, keyAttempt, candidates)
      : candidates[Math.min(keyAttempt, candidates.length - 1)];
    return pick ? { Authorization: `Bearer ${pick.key}` } : undefined;
  };
}

/** 密钥来源可观测性：返回某模型可用的密钥来源标识（不含密钥值） */
export function describeKeySources(modelId: string): string[] {
  return resolveLocalKeyCandidates(modelId).map((c) => c.source);
}

// ─────────────────────────── 密钥健康感知路由 ───────────────────────────

/** 单密钥健康状态（不含密钥值） */
export interface KeyHealthStatus {
  source: string;
  successes: number;
  failures: number;
  coolingDown: boolean;
  cooldownRemainingMs: number;
  lastErrorStatus?: number;
}

/**
 * 密钥健康管理器：把"顺序轮换"升级为"健康感知路由"。
 * - 用户顺序：用户可通过 setKeyOrder 指定密钥来源优先级（持久化，重启保留）；
 * - 选择策略：用户序优先 → 冷却规避 → 失败次数少 → 成功次数多；
 * - 冷却策略：429（配额/限流）冷却 1 分钟，401/403（认证）冷却 5 分钟；
 * - 成功即清零失败计数并解除冷却；
 * - 并发安全：按 (modelId, attempt) 记录每次选择，失败结果精确归因到所用密钥。
 */
export class KeyHealthManager {
  private health = new Map<string, KeyHealthStatus & { cooldownUntil: number }>();
  private lastPicks = new Map<string, string>();
  /** 用户自定义密钥来源优先级（来源标识数组，靠前优先） */
  private userOrder: string[] = [];
  private persistPath?: string;

  constructor(private readonly cooldownMs = 60_000, persistPath?: string) {
    this.persistPath = persistPath;
    if (persistPath) this.loadOrder();
  }

  /** 设置用户密钥顺序（持久化） */
  setKeyOrder(order: string[]): void {
    this.userOrder = [...order];
    this.saveOrder();
  }

  /** 获取当前用户密钥顺序 */
  getKeyOrder(): string[] {
    return [...this.userOrder];
  }

  /** 清除用户顺序，恢复默认（环境变量序 → 本地配置） */
  clearKeyOrder(): void {
    this.userOrder = [];
    this.saveOrder();
  }

  private loadOrder(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.persistPath!, 'utf8'));
      if (Array.isArray(parsed.order)) this.userOrder = parsed.order.filter((s: unknown) => typeof s === 'string');
    } catch {
      /* 首次启动或文件损坏，使用默认顺序 */
    }
  }

  private saveOrder(): void {
    if (!this.persistPath) return;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify({ order: this.userOrder }, null, 2));
    } catch {
      /* 持久化失败不影响运行时顺序 */
    }
  }

  private entry(source: string): KeyHealthStatus & { cooldownUntil: number } {
    let e = this.health.get(source);
    if (!e) {
      e = { source, successes: 0, failures: 0, coolingDown: false, cooldownRemainingMs: 0, cooldownUntil: 0 };
      this.health.set(source, e);
    }
    return e;
  }

  /** 为某次调用选择最优候选密钥（用户序优先，冷却规避；attempt>0 时排除上一次刚失败的来源） */
  pick(
    modelId: string,
    attempt: number,
    candidates: Array<{ source: string; key: string }>,
  ): { source: string; key: string } | undefined {
    if (candidates.length === 0) return undefined;
    const now = Date.now();
    const prev = attempt > 0 ? this.lastPicks.get(`${modelId}#${attempt - 1}`) : undefined;

    const orderIndex = (source: string) => {
      const idx = this.userOrder.indexOf(source);
      return idx === -1 ? this.userOrder.length : idx;
    };
    const scored = candidates.map((c) => ({ ...c, h: this.entry(c.source) }));
    // 综合排序：冷却中最后 → 用户序靠前 → 失败少 → 成功多
    const rank = (x: (typeof scored)[number]) =>
      (x.h.cooldownUntil <= now ? 0 : 1) * 10_000 + orderIndex(x.source) * 100 + x.h.failures - Math.min(x.h.successes, 100) / 1000;
    const rotated = scored.filter((c) => c.source !== prev);
    const pool = rotated.length > 0 ? rotated : scored;
    pool.sort((a, b) => rank(a) - rank(b));

    const chosen = pool[0];
    this.lastPicks.set(`${modelId}#${attempt}`, chosen.source);
    return { source: chosen.source, key: chosen.key };
  }

  /** 上报调用结果：成功清零失败；429/401/403 进入冷却 */
  recordOutcome(modelId: string, attempt: number, success: boolean, status?: number): void {
    const source = this.lastPicks.get(`${modelId}#${attempt}`);
    if (!source) return;
    const e = this.entry(source);
    if (success) {
      e.successes += 1;
      e.failures = 0;
      e.cooldownUntil = 0;
      e.coolingDown = false;
      e.cooldownRemainingMs = 0;
      return;
    }
    e.failures += 1;
    e.lastErrorStatus = status;
    if (status === 429) e.cooldownUntil = Date.now() + this.cooldownMs;
    else if (status === 401 || status === 403) e.cooldownUntil = Date.now() + this.cooldownMs * 5;
  }

  /** 全部密钥的健康汇总（供 query_memory 的 keys 查询） */
  status(): KeyHealthStatus[] {
    const now = Date.now();
    return [...this.health.values()].map((e) => ({
      source: e.source,
      successes: e.successes,
      failures: e.failures,
      coolingDown: e.cooldownUntil > now,
      cooldownRemainingMs: Math.max(0, e.cooldownUntil - now),
      lastErrorStatus: e.lastErrorStatus,
    }));
  }
}

// ─────────────────────────── 第三轮：宿主桥生命周期 ───────────────────────────

/** 桥连接状态（连接 / 降级 / 断开 / 重连退避） */
export type BridgeState = 'disconnected' | 'connecting' | 'connected' | 'degraded' | 'backoff';

/** 一次状态迁移记录（审计口径） */
export interface BridgeTransition {
  from: BridgeState;
  to: BridgeState;
  at: number;
  reason: string;
}

/** 宿主桥配置 */
export interface HostBridgeOptions {
  /** 重连退避基数毫秒（缺省 1000） */
  baseBackoffMs?: number;
  /** 退避倍率（缺省 2——指数退避） */
  backoffFactor?: number;
  /** 退避上限毫秒（缺省 30000） */
  maxBackoffMs?: number;
  /** 幂等结果缓存容量（缺省 256，超出按 LRU 淘汰） */
  cacheCapacity?: number;
  /** 注入时钟（缺省 Date.now——确定性测试用） */
  now?: () => number;
  /** 连接探测（connect() 时调用；抛错 = 连接失败进退避） */
  connectProbe?: () => Promise<void>;
  /** 桥标识（日志/审计用） */
  label?: string;
}

/** 桥错误（请求在断开/退避态被拒等生命周期语义错误） */
export class HostBridgeError extends Error {
  constructor(
    message: string,
    readonly code: 'not-connected' | 'duplicate-key-rejection' | 'no-healthy-host',
  ) {
    super(message);
    this.name = 'HostBridgeError';
  }
}

/**
 * 宿主桥：连接状态机 + 请求幂等键。
 *
 * 状态机：disconnected/connecting/connected/degraded/backoff
 * - connect()：探测成功 → connected（清零失败计数）；退避未到期 → 拒绝（false）
 * - fail(reason)：连接失败/断线 → backoff，退避 = base × factor^(连续失败-1)，
 *   封顶 max（指数退避；注入时钟下完全确定）
 * - markDegraded(reason)：connected → degraded（还连着但能力缩水——
 *   与 host-fusion 能力协商降级联动：协商降级不掐线，标记降级态继续服务）
 * - disconnect(reason)：显式断开 → disconnected（重置退避序列——新会话重连
 *   不背旧退避；进行中的幂等缓存保留，重连后同键仍不重复执行）
 *
 * 幂等键：request(key, exec)
 * - 同键已完成 → 重放结果（含失败——严格幂等：重试不重复执行；
 *   真要重新执行请换新键）
 * - 同键在途 → 共享同一个 Promise（并发去重）
 * - disconnected/backoff 态 → 立即拒绝且不执行不缓存（键保持新鲜，
 *   重连后重试恰好执行一次）
 * - 完成结果进 LRU 缓存（容量有界）
 */
export class HostBridge {
  private state: BridgeState = 'disconnected';
  private consecutiveFailures = 0;
  private backoffUntil = 0;
  private nextBackoffMs: number;
  private readonly baseBackoffMs: number;
  private readonly backoffFactor: number;
  private readonly maxBackoffMs: number;
  private readonly cacheCapacity: number;
  private readonly now: () => number;
  private readonly connectProbe?: () => Promise<void>;
  private readonly label: string;
  /** 幂等缓存：已完成键 → settle 后的结果/错误（Map 序即 LRU 序） */
  private completed = new Map<string, { ok: true; value: unknown } | { ok: false; error: unknown }>();
  /** 在途键 → 共享 Promise */
  private inflight = new Map<string, Promise<unknown>>();
  private transitions: BridgeTransition[] = [];
  private stats = { executed: 0, replayed: 0, dedupedInflight: 0, rejectedNotConnected: 0, evicted: 0, connects: 0, failures: 0 };

  constructor(options?: HostBridgeOptions) {
    this.baseBackoffMs = Math.max(0, options?.baseBackoffMs ?? 1_000);
    this.backoffFactor = Math.max(1, options?.backoffFactor ?? 2);
    this.maxBackoffMs = Math.max(this.baseBackoffMs, options?.maxBackoffMs ?? 30_000);
    this.cacheCapacity = Math.max(1, Math.floor(options?.cacheCapacity ?? 256));
    this.now = options?.now ?? Date.now;
    this.connectProbe = options?.connectProbe;
    this.label = options?.label ?? 'host-bridge';
    this.nextBackoffMs = this.baseBackoffMs;
  }

  /** 当前状态 */
  get connectionState(): BridgeState {
    return this.state;
  }

  /** 退避剩余毫秒（非退避态为 0；注入时钟下确定） */
  backoffRemainingMs(): number {
    if (this.state !== 'backoff') return 0;
    return Math.max(0, this.backoffUntil - this.now());
  }

  /** 状态迁移审计日志（最近 100 条，含 reason） */
  transitionLog(): BridgeTransition[] {
    return [...this.transitions];
  }

  /** 桥统计（幂等命中率 / 连接史） */
  bridgeStats(): {
    state: BridgeState;
    consecutiveFailures: number;
    connects: number;
    failures: number;
    executed: number;
    replayed: number;
    dedupedInflight: number;
    rejectedNotConnected: number;
    evicted: number;
    cacheSize: number;
  } {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      connects: this.stats.connects,
      failures: this.stats.failures,
      executed: this.stats.executed,
      replayed: this.stats.replayed,
      dedupedInflight: this.stats.dedupedInflight,
      rejectedNotConnected: this.stats.rejectedNotConnected,
      evicted: this.stats.evicted,
      cacheSize: this.completed.size,
    };
  }

  private transition(to: BridgeState, reason: string): void {
    if (this.state === to) return; // 同态不记账
    const entry = { from: this.state, to, at: this.now(), reason };
    this.transitions.push(entry);
    if (this.transitions.length > 100) this.transitions.splice(0, this.transitions.length - 100);
    this.state = to;
  }

  /**
   * 建立连接：connecting →（探测成功）connected。
   * @returns false = 退避未到期（重连节奏由指数退避控制）或探测失败；
   *   探测失败会推进失败计数并加深退避
   */
  async connect(): Promise<boolean> {
    if (this.state === 'backoff' && this.now() < this.backoffUntil) return false;
    if (this.state === 'connected') return true;
    if (this.state === 'connecting') return false; // 已有连接尝试在途
    this.transition('connecting', this.state === 'backoff' ? '退避到期重连' : '发起连接');
    try {
      await this.connectProbe?.();
    } catch (error) {
      this.fail(`连接探测失败: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    this.consecutiveFailures = 0;
    this.nextBackoffMs = this.baseBackoffMs;
    this.stats.connects += 1;
    this.transition('connected', '连接建立');
    return true;
  }

  /**
   * 上报连接失败/断线：进入（或加深）指数退避。
   * disconnected 态下无连接可失败——忽略。
   */
  fail(reason: string): void {
    if (this.state === 'disconnected') return;
    this.stats.failures += 1;
    this.consecutiveFailures += 1;
    const backoff = Math.min(this.nextBackoffMs, this.maxBackoffMs);
    this.nextBackoffMs = Math.min(this.nextBackoffMs * this.backoffFactor, this.maxBackoffMs);
    this.backoffUntil = this.now() + backoff;
    this.transition('backoff', `${reason}（连续第 ${this.consecutiveFailures} 次，退避 ${backoff}ms）`);
  }

  /** 标记降级（连接仍在、能力缩水——协商降级/半故障继续服务） */
  markDegraded(reason: string): void {
    if (this.state !== 'connected' && this.state !== 'degraded') return;
    this.transition('degraded', reason);
  }

  /** 显式断开（重置退避序列；幂等缓存保留） */
  disconnect(reason: string): void {
    this.consecutiveFailures = 0;
    this.nextBackoffMs = this.baseBackoffMs;
    this.backoffUntil = 0;
    this.transition('disconnected', reason);
  }

  /**
   * 幂等请求：同键重放不重执行（含失败重放——严格幂等）；
   * 同键在途共享 Promise；断开/退避态立即拒绝（不执行、不缓存——
   * 键保持新鲜，重连后重试恰好执行一次）。
   */
  async request<T>(idempotencyKey: string, exec: () => Promise<T>): Promise<T> {
    if (this.state === 'disconnected' || this.state === 'backoff') {
      this.stats.rejectedNotConnected += 1;
      throw new HostBridgeError(`桥处于 ${this.state} 态，拒绝请求（键 ${idempotencyKey} 未消耗）`, 'not-connected');
    }
    // 已完成 → 重放（LRU 触碰：删后重插）
    const done = this.completed.get(idempotencyKey);
    if (done) {
      this.stats.replayed += 1;
      this.completed.delete(idempotencyKey);
      this.completed.set(idempotencyKey, done);
      if (done.ok) return done.value as T;
      throw done.error;
    }
    // 在途 → 共享同一个 Promise（并发去重）
    const pending = this.inflight.get(idempotencyKey);
    if (pending) {
      this.stats.dedupedInflight += 1;
      return pending as Promise<T>;
    }
    // 执行一次
    this.stats.executed += 1;
    const promise = (async () => {
      try {
        const value = await exec();
        this.completed.set(idempotencyKey, { ok: true, value });
        this.evictIfNeeded();
        return value;
      } catch (error) {
        this.completed.set(idempotencyKey, { ok: false, error });
        this.evictIfNeeded();
        throw error;
      } finally {
        this.inflight.delete(idempotencyKey);
      }
    })();
    this.inflight.set(idempotencyKey, promise);
    return promise;
  }

  private evictIfNeeded(): void {
    while (this.completed.size > this.cacheCapacity) {
      const oldest = this.completed.keys().next().value;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
      this.stats.evicted += 1;
    }
  }
}

// ─────────────────── 第四轮：宿主桥多路复用（多宿主连接池） ───────────────────

/** 连接池中一个宿主的瞬时状态（路由可观测口径） */
export interface PoolHostStatus {
  id: string;
  label: string;
  state: BridgeState;
  /** 是否可承接新请求（connected / degraded） */
  eligible: boolean;
  /** 健康度评分（路由依据；不可服务宿主恒 0；connected 基 100 / degraded 基 50，每连续失败 -10，下限 1） */
  healthScore: number;
  connects: number;
  failures: number;
  executed: number;
  replayed: number;
}

/** 连接池统计（路由史 + 亲和史） */
export interface HostBridgePoolStats {
  hosts: number;
  /** 已路由请求数 */
  routed: number;
  /** 池级重放命中数（同键重放发生在亲和宿主上） */
  replayed: number;
  /** 故障转移次数（亲和宿主失格 → 改道 healthier 宿主，同键在新宿主上重新执行） */
  failovers: number;
  /** 亲和命中数（同键直接路由到执行过它的宿主——幂等重放的落点保证） */
  affinityHits: number;
  rejectedNoHost: number;
  affinitySize: number;
}

/** 连接池配置 */
export interface HostBridgePoolOptions {
  /** 键→宿主亲和缓存容量（缺省 512，超出按 LRU 淘汰） */
  affinityCapacity?: number;
}

/**
 * 宿主桥连接池：多宿主并发复用（第四轮加分项）。
 *
 * - 每宿主独立 HostBridge 状态机（退避/降级/幂等缓存互不影响）；
 * - 请求路由按宿主健康度：eligible（connected=100 基 / degraded=50 基，
 *   每连续失败 -10）中取最高分，同分按入池序（确定性）；全部失格 →
 *   HostBridgeError('no-healthy-host') 拒绝（键不消耗）；
 * - 键→宿主亲和：执行过某键的宿主被记住，同键重试优先回到原宿主——
 *   幂等重放发生在有缓存的宿主上（跨宿主缓存不共享，改道即诚实重执行，
 *   计一次 failover）；亲和宿主失格时自动改道最健康宿主并迁移亲和。
 *
 * 池不代理 connect/fail（每宿主生命周期归连接管理方——池只做路由）。
 */
export class HostBridgePool {
  private readonly affinityCapacity: number;
  private members = new Map<string, { bridge: HostBridge; label: string }>();
  /** 幂等键 → 宿主 id（Map 序即 LRU 序） */
  private affinity = new Map<string, string>();
  private stats = { routed: 0, replayed: 0, failovers: 0, affinityHits: 0, rejectedNoHost: 0 };

  constructor(options?: HostBridgePoolOptions) {
    this.affinityCapacity = Math.max(1, Math.floor(options?.affinityCapacity ?? 512));
  }

  /** 入池一个宿主桥（id 缺省 `host-N`；重复 id = 替换，亲和指向旧桥的记录保留原宿主 id） */
  add(bridge: HostBridge, id?: string, label?: string): string {
    const hostId = id ?? `host-${this.members.size + 1}`;
    this.members.set(hostId, { bridge, label: label ?? hostId });
    return hostId;
  }

  /** 出池（其亲和记录一并清除） */
  remove(hostId: string): boolean {
    const removed = this.members.delete(hostId);
    if (removed) {
      for (const [key, bound] of this.affinity) {
        if (bound === hostId) this.affinity.delete(key);
      }
    }
    return removed;
  }

  /** 池内宿主数 */
  hostCount(): number {
    return this.members.size;
  }

  /** 宿主健康评分（路由依据；不可服务 → 0 分） */
  private scoreOf(host: { bridge: HostBridge }): { eligible: boolean; score: number } {
    const s = host.bridge.bridgeStats();
    if (s.state === 'connected') return { eligible: true, score: Math.max(1, 100 - s.consecutiveFailures * 10) };
    if (s.state === 'degraded') return { eligible: true, score: Math.max(1, 50 - s.consecutiveFailures * 10) };
    return { eligible: false, score: 0 };
  }

  /** 全部宿主的瞬时状态（入池序） */
  hosts(): PoolHostStatus[] {
    return [...this.members.entries()].map(([id, h]) => {
      const s = h.bridge.bridgeStats();
      const score = this.scoreOf(h);
      return { id, label: h.label, state: s.state, eligible: score.eligible, healthScore: score.score, connects: s.connects, failures: s.failures, executed: s.executed, replayed: s.replayed };
    });
  }

  /**
   * 路由决策预览（纯读：不执行、不改亲和）。
   * @returns 落点宿主与依据；无可用宿主 → undefined
   */
  peekRoute(idempotencyKey: string): { hostId: string; healthScore: number; viaAffinity: boolean } | undefined {
    const affinedId = this.affinity.get(idempotencyKey);
    const affinedHost = affinedId !== undefined ? this.members.get(affinedId) : undefined;
    if (affinedHost) {
      const score = this.scoreOf(affinedHost);
      if (score.eligible) return { hostId: affinedId!, healthScore: score.score, viaAffinity: true };
    }
    let best: { id: string; score: number } | undefined;
    for (const [id, host] of this.members) {
      const { eligible, score } = this.scoreOf(host);
      if (!eligible) continue;
      // 同分按入池序：Map 迭代序天然稳定（先入池者优先）
      if (!best || score > best.score) best = { id, score };
    }
    return best ? { hostId: best.id, healthScore: best.score, viaAffinity: false } : undefined;
  }

  /**
   * 幂等请求（路由到最健康宿主；同键优先回亲和宿主保证重放语义）。
   * 全部宿主失格 → HostBridgeError('no-healthy-host')（键不消耗）。
   */
  async request<T>(idempotencyKey: string, exec: () => Promise<T>): Promise<T> {
    const route = this.peekRoute(idempotencyKey);
    if (!route) {
      this.stats.rejectedNoHost += 1;
      throw new HostBridgeError(`连接池无可用宿主（${this.members.size} 个宿主全部不可服务），拒绝请求（键 ${idempotencyKey} 未消耗）`, 'no-healthy-host');
    }
    const previousAffinity = this.affinity.get(idempotencyKey);
    if (route.viaAffinity) this.stats.affinityHits += 1;
    else if (previousAffinity !== undefined && previousAffinity !== route.hostId) this.stats.failovers += 1; // 亲和宿主失格 → 故障转移
    this.touchAffinity(idempotencyKey, route.hostId);
    const host = this.members.get(route.hostId)!;
    const replayedBefore = host.bridge.bridgeStats().replayed;
    this.stats.routed += 1;
    try {
      return await host.bridge.request(idempotencyKey, exec);
    } finally {
      if (host.bridge.bridgeStats().replayed > replayedBefore) this.stats.replayed += 1;
    }
  }

  /** 亲和 LRU 触碰（删后重插 = 最近使用） */
  private touchAffinity(idempotencyKey: string, hostId: string): void {
    this.affinity.delete(idempotencyKey);
    this.affinity.set(idempotencyKey, hostId);
    while (this.affinity.size > this.affinityCapacity) {
      const oldest = this.affinity.keys().next().value;
      if (oldest === undefined) break;
      this.affinity.delete(oldest);
    }
  }

  /** 连接池统计 */
  poolStats(): HostBridgePoolStats {
    return { hosts: this.members.size, ...this.stats, affinitySize: this.affinity.size };
  }
}
