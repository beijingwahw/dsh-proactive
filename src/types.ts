/**
 * types.ts — 共享类型层（新架构各组件的公共契约）
 *
 * 新架构单向数据流：
 *   记忆库(Memory) → 优化器(Optimizer) → 模型调度(ModelScheduler)/任务执行(TaskExecutor) → 反思器(Reflector) → 记忆更新(Memory)
 *
 * 本文件承载数据流各组件共享的领域类型，避免组件间相互依赖：
 * - 计划结构：PlanNode / ExecutionPlan（优化器产出、任务执行消费）
 * - 执行结果：NodeResult / PlanExecutionResult（任务执行产出、反思器消费）
 * - 注入点：NodeRunner / CascadeHandler（测试离线模拟 / 级联回注哨兵）
 * - 错误：ExecutionError
 */

import { AppError, TypedAppError, classifyTaxonomy } from './errors.js';
import type { ErrorTaxonomyEntry } from './errors.js';
import type { Signal } from './sentinel.js';

/** DAG 计划节点 */
export interface PlanNode {
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
  cascade?: Array<{ type: string; description: string }>;
}

/** 执行计划（优化器快路径召回 / strategist DAG / 离线兜底 三类来源） */
export interface ExecutionPlan {
  objective: string;
  nodes: PlanNode[];
  parallelismStrategy: string;
  /** 计划来源：strategist 模型 / 离线兜底 / 记忆复用 */
  source: 'strategist' | 'fallback' | 'memory';
}

/** 单节点执行结果 */
export interface NodeResult {
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
export interface PlanExecutionResult {
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
export type NodeRunner = (params: {
  node: PlanNode;
  modelId: string;
  context: Record<string, string>;
  signal: Signal;
  /** 全局中止信号（计划级超时/外部中止时中断在途 LLM 请求） */
  abortSignal?: AbortSignal;
  attempt: number;
}) => Promise<{ output: string; quality: number; tokensUsed?: number }>;

/** 级联触发回调（由 index.ts 桥接到 sentinel.ingest） */
export type CascadeHandler = (newSignal: { type: string; description: string; payload: Record<string, any> }) => void;

/** 计划执行失败 */
export class ExecutionError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'EXECUTION_ERROR', details);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 第三轮模块域升级（A16 · 基础契约层）：品牌化 ID / Result<T,E> / 事件信封
//
// 三者均为**纯增量**：既有 string 字段类型零改动——品牌类型是可选强化，
// 模块可渐进采用（接收处 `SignalId`、传入处仍传 string 也兼容，因为
// 品牌类型对 string 结构透明）。
// ═══════════════════════════════════════════════════════════════════

// ── 1. 品牌化 ID 类型（declaration merging 风格 string & {__brand}） ──

/**
 * 品牌底座：`T & { readonly __brand: B }`
 *
 * - 品牌类型可赋给裸 T（SignalId → string 零成本下行）
 * - 裸 T 不可赋给品牌类型（string ↛ SignalId，编译期防混用）
 * - 仅工厂函数（asSignalId 等）能制造品牌值——构造点收敛可审计
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** 信号 id 品牌（sentinel 信号 / 级联溯源 parentId） */
export type SignalId = Brand<string, 'SignalId'>;
/** 模型 id 品牌（模型注册表 / 调度决策） */
export type ModelId = Brand<string, 'ModelId'>;
/** 租户 id 品牌（多租户路由） */
export type TenantId = Brand<string, 'TenantId'>;
/** 计划 id 品牌（ExecutionPlan 实例标识） */
export type PlanId = Brand<string, 'PlanId'>;
/** 目标 id 品牌（goal-engine） */
export type GoalId = Brand<string, 'GoalId'>;
/** 计划节点 id 品牌（PlanNode.id / NodeResult.nodeId） */
export type NodeId = Brand<string, 'NodeId'>;
/** 蒸馏策略 id 品牌（DistilledStrategy / 策略进化） */
export type StrategyId = Brand<string, 'StrategyId'>;
/** 决策反馈 id 品牌（DecisionFeedback） */
export type FeedbackId = Brand<string, 'FeedbackId'>;

/** 品牌工厂共享实现：非空字符串校验 + 品牌断言（空串/纯空白 = VALIDATION_ERROR） */
function brandString<T extends Brand<string, string>>(value: string, kind: string): T {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypedAppError(`${kind} 不能为空字符串`, {
      code: 'VALIDATION_ERROR',
      details: { kind, got: value },
    });
  }
  return value as T;
}

/** string → SignalId（编译期防与其他 id 混用的唯一构造点） */
export function asSignalId(value: string): SignalId {
  return brandString(value, 'SignalId');
}
/** string → ModelId */
export function asModelId(value: string): ModelId {
  return brandString(value, 'ModelId');
}
/** string → TenantId */
export function asTenantId(value: string): TenantId {
  return brandString(value, 'TenantId');
}
/** string → PlanId */
export function asPlanId(value: string): PlanId {
  return brandString(value, 'PlanId');
}
/** string → GoalId */
export function asGoalId(value: string): GoalId {
  return brandString(value, 'GoalId');
}
/** string → NodeId */
export function asNodeId(value: string): NodeId {
  return brandString(value, 'NodeId');
}
/** string → StrategyId */
export function asStrategyId(value: string): StrategyId {
  return brandString(value, 'StrategyId');
}
/** string → FeedbackId */
export function asFeedbackId(value: string): FeedbackId {
  return brandString(value, 'FeedbackId');
}

/**
 * 品牌逃生舱：品牌值 → 裸 string（显式、可 grep 的降级点）
 * （品牌对 string 结构透明，本函数语义上是对称性的文档化，非必需）
 */
export function unbrandId(value: Brand<string, string>): string {
  return value as string;
}

// ── 2. Result<T,E>：可组合错误通道（ok/err 判别联合 + 单子工具） ──

/** 成功态 */
export interface OkResult<T> {
  readonly ok: true;
  readonly value: T;
}
/** 失败态 */
export interface ErrResult<E> {
  readonly ok: false;
  readonly error: E;
}
/** 判别联合：以 `ok` 布尔判别，窄化后 value/error 均为精确类型 */
export type Result<T, E = AppError> = OkResult<T> | ErrResult<E>;

/** 构造成功值 */
export function ok<T>(value: T): OkResult<T> {
  return { ok: true, value };
}
/** 构造失败值 */
export function err<E>(error: E): ErrResult<E> {
  return { ok: false, error };
}

/** 窄化守卫：成功态 */
export function isOk<T, E>(result: Result<T, E>): result is OkResult<T> {
  return result.ok === true;
}
/** 窄化守卫：失败态 */
export function isErr<T, E>(result: Result<T, E>): result is ErrResult<E> {
  return result.ok === false;
}

/** map：成功态变换（失败态原样穿透） */
export function mapResult<T, U, E>(result: Result<T, E>, f: (value: T) => U): Result<U, E> {
  return result.ok ? ok(f(result.value)) : result;
}
/** mapErr：失败态变换（成功态原样穿透） */
export function mapErrResult<T, E, F>(result: Result<T, E>, f: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(f(result.error));
}
/** unwrapOr：失败态取默认值 */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
/** unwrap：失败态抛出（错误直接 throw；成功态返回值） */
export function unwrapResult<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error;
}
/** andThen（bind）：成功态接续下一个可能失败的运算（单子组合律的核心操作） */
export function andThen<T, U, E>(result: Result<T, E>, f: (value: T) => Result<U, E>): Result<U, E> {
  return result.ok ? f(result.value) : result;
}
/** match：双分支消解 */
export function matchResult<T, E, U>(result: Result<T, E>, handlers: { ok: (value: T) => U; err: (error: E) => U }): U {
  return result.ok ? handlers.ok(result.value) : handlers.err(result.error);
}
/** Result → AppError 分类学条目（错误通道与类型化错误体系互通） */
export function resultTaxonomy<T, E>(result: Result<T, E>): ErrorTaxonomyEntry | undefined {
  return result.ok ? undefined : classifyTaxonomy(result.error);
}

// ── 3. 结构化事件信封：跨模块事件总线统一形态 ──

/**
 * 事件信封：type / payload / ts / seq / source 五要素 + 可选关联链
 *
 * 用途：模块间发布订阅的统一载荷——窄化守卫（isEventEnvelope）保证
 * 消费端拿到的信封结构完备；seq 单调递增支撑因果排序与去重。
 */
export interface EventEnvelope<EventName extends string = string, Payload = Record<string, unknown>> {
  /** 事件类型名（点分命名空间约定：module.verb，如 plan.completed） */
  type: EventName;
  /** 事件载荷 */
  payload: Payload;
  /** 事件时间戳（毫秒；生产方时钟） */
  ts: number;
  /** 全源单调递增序号（EventSequencer 维护；去重与因果排序依据） */
  seq: number;
  /** 发布来源标识（模块名 / 实例 id） */
  source: string;
  /** 关联 id（同一业务流的横向关联） */
  correlationId?: string;
  /** 因果 id（触发本事件的上一事件/信号 id） */
  causationId?: string;
  /** 租户隔离 */
  tenantId?: string;
}

/** 信封构造入参（ts 可省略走注入时钟，缺省 Date.now——生产代码路径） */
export interface EventEnvelopeInit<EventName extends string = string, Payload = Record<string, unknown>> {
  type: EventName;
  payload: Payload;
  source: string;
  seq: number;
  ts?: number;
  correlationId?: string;
  causationId?: string;
  tenantId?: string;
}

/** 确定性信封工厂：ts 显式传入（测试/回放），缺省取实时时钟 */
export function createEventEnvelope<EventName extends string, Payload>(init: EventEnvelopeInit<EventName, Payload>): EventEnvelope<EventName, Payload> {
  const ts = init.ts ?? Date.now();
  if (typeof init.type !== 'string' || init.type.trim().length === 0) {
    throw new TypedAppError('事件信封 type 不能为空', { code: 'VALIDATION_ERROR', details: { got: init.type } });
  }
  if (typeof init.source !== 'string' || init.source.trim().length === 0) {
    throw new TypedAppError('事件信封 source 不能为空', { code: 'VALIDATION_ERROR', details: { got: init.source } });
  }
  if (!Number.isInteger(init.seq) || init.seq < 0) {
    throw new TypedAppError('事件信封 seq 必须为非负整数', { code: 'VALIDATION_ERROR', details: { got: init.seq } });
  }
  if (!Number.isFinite(ts)) {
    throw new TypedAppError('事件信封 ts 必须为有限数', { code: 'VALIDATION_ERROR', details: { got: ts } });
  }
  return {
    type: init.type,
    payload: init.payload,
    ts,
    seq: init.seq,
    source: init.source,
    ...(init.correlationId !== undefined ? { correlationId: init.correlationId } : {}),
    ...(init.causationId !== undefined ? { causationId: init.causationId } : {}),
    ...(init.tenantId !== undefined ? { tenantId: init.tenantId } : {}),
  };
}

/** 结构窄化守卫：五要素形态完备且类型正确（正例放行，反例拒绝） */
export function isEventEnvelope(value: unknown): value is EventEnvelope<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Partial<EventEnvelope> & Record<string, unknown>;
  if (typeof v.type !== 'string' || v.type.length === 0) return false;
  if (typeof v.payload !== 'object' || v.payload === null) return false;
  if (typeof v.ts !== 'number' || !Number.isFinite(v.ts)) return false;
  if (typeof v.seq !== 'number' || !Number.isInteger(v.seq) || v.seq < 0) return false;
  if (typeof v.source !== 'string' || v.source.length === 0) return false;
  if (v.correlationId !== undefined && typeof v.correlationId !== 'string') return false;
  if (v.causationId !== undefined && typeof v.causationId !== 'string') return false;
  if (v.tenantId !== undefined && typeof v.tenantId !== 'string') return false;
  return true;
}

/** 断言版守卫：不合法即抛 VALIDATION_ERROR（携带具体缺陷字段） */
export function assertEventEnvelope(value: unknown): asserts value is EventEnvelope<string, unknown> {
  if (!isEventEnvelope(value)) {
    const defects: string[] = [];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) defects.push('根形态');
    else {
      const v = value as Partial<EventEnvelope> & Record<string, unknown>;
      if (typeof v.type !== 'string' || v.type.length === 0) defects.push('type');
      if (typeof v.payload !== 'object' || v.payload === null) defects.push('payload');
      if (typeof v.ts !== 'number' || !Number.isFinite(v.ts)) defects.push('ts');
      if (typeof v.seq !== 'number' || !Number.isInteger(v.seq) || v.seq < 0) defects.push('seq');
      if (typeof v.source !== 'string' || v.source.length === 0) defects.push('source');
    }
    throw new TypedAppError(`事件信封结构非法：${defects.join('、')} 不合规`, {
      code: 'VALIDATION_ERROR',
      details: { defects },
    });
  }
}

/**
 * 事件定序器：单一来源分配单调 seq（确定性；时钟可注入）
 *
 * 同一 sequencer 实例发出的信封 seq 严格递增、ts 单调不减
 * （注入时钟不回拨的前提下），支撑消费端因果排序与重复检测。
 */
export class EventSequencer {
  private nextSeq: number;
  private readonly clock: () => number;
  readonly source: string;

  constructor(source: string, options: { startSeq?: number; clock?: () => number } = {}) {
    if (typeof source !== 'string' || source.trim().length === 0) {
      throw new TypedAppError('EventSequencer source 不能为空', { code: 'VALIDATION_ERROR', details: { got: source } });
    }
    this.source = source;
    this.nextSeq = options.startSeq ?? 0;
    this.clock = options.clock ?? Date.now;
  }

  /** 下一序号（不消耗） */
  peekSeq(): number {
    return this.nextSeq;
  }

  /** 发布一个事件（消耗一个 seq） */
  emit<EventName extends string, Payload>(init: {
    type: EventName;
    payload: Payload;
    ts?: number;
    correlationId?: string;
    causationId?: string;
    tenantId?: string;
  }): EventEnvelope<EventName, Payload> {
    const envelope = createEventEnvelope<EventName, Payload>({
      type: init.type,
      payload: init.payload,
      source: this.source,
      seq: this.nextSeq,
      // ts 缺省走本定序器的注入时钟（而非 createEventEnvelope 的 Date.now）——
      // 「时钟可注入」的确定性语义在 emit 路径同样成立（测试/回放无定时器）
      ts: init.ts !== undefined ? init.ts : this.clock(),
      ...(init.correlationId !== undefined ? { correlationId: init.correlationId } : {}),
      ...(init.causationId !== undefined ? { causationId: init.causationId } : {}),
      ...(init.tenantId !== undefined ? { tenantId: init.tenantId } : {}),
    });
    this.nextSeq += 1;
    return envelope;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 第四轮模块域升级（R4-A16 · 基础契约层）：类型依赖图
//
// 运行时可查询的类型元数据注册表：类型名 → 字段清单 → 依赖类型清单。
// 供 dashboard / 文档生成 / 影响分析消费（如「改动 PlanNode 会波及谁」）。
// 纯增量：手工注册的元数据，不改变任何既有类型的运行时形态。
// ═══════════════════════════════════════════════════════════════════

/** 类型元数据：单字段（字段名 / 类型描述 / 可选性 / 说明） */
export interface TypeFieldMeta {
  /** 字段名 */
  readonly name: string;
  /** 类型描述（标量名 'string' / 引用类型名 'PlanNode' / 复合描述 'PlanNode[]'） */
  readonly type: string;
  /** 是否可选字段（缺省 false） */
  readonly optional?: boolean;
  /** 字段说明（文档生成用） */
  readonly description?: string;
}

/** 类型元数据：一个可注册类型节点 */
export interface TypeMeta {
  /** 类型名（注册表主键，须与源码类型名一致） */
  readonly name: string;
  /** 类型种类 */
  readonly kind: 'interface' | 'type-alias' | 'class' | 'union' | 'enum';
  /** 类型说明（文档生成用） */
  readonly description?: string;
  /** 字段清单（声明序；type-alias/union 可为空） */
  readonly fields: readonly TypeFieldMeta[];
  /** 依赖类型清单（本类型字段引用的其他类型名；注册序敏感——拓扑排序依据） */
  readonly dependencies: readonly string[];
}

/**
 * 类型注册表：名 → 元数据的运行时依赖图
 *
 * - register：重名/自依赖拒绝（结构防御在注册点，不推迟到查询点）
 * - topologicalOrder：依赖在前；同层按注册序（Kahn 稳定队列，确定性）
 * - 有环时 topologicalOrder 抛 VALIDATION_ERROR（环路径进消息），
 *   detectCycles 给出全部环（诊断用，不抛）
 * - dependentsOf / reachableFrom：反向与传递闭包（影响分析）
 * - toDot：确定性 DOT 导出（dashboard / 文档渲染可直接吃）
 */
export class TypeRegistry {
  private readonly metaByName = new Map<string, TypeMeta>();
  private readonly orderByName = new Map<string, number>();

  constructor(public readonly name = 'default') {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new TypedAppError('TypeRegistry name 不能为空', { code: 'VALIDATION_ERROR' });
    }
  }

  /** 注册一个类型节点（重名 / 依赖自身 → VALIDATION_ERROR） */
  register(meta: TypeMeta): this {
    if (meta === null || typeof meta !== 'object' || typeof meta.name !== 'string' || meta.name.trim().length === 0) {
      throw new TypedAppError('类型元数据 name 不能为空', { code: 'VALIDATION_ERROR' });
    }
    if (this.metaByName.has(meta.name)) {
      throw new TypedAppError(`类型重复注册：${meta.name}（注册表 ${this.name}）`, {
        code: 'VALIDATION_ERROR',
        details: { type: meta.name },
      });
    }
    if (!Array.isArray(meta.fields)) {
      throw new TypedAppError(`类型 ${meta.name} 的 fields 必须是数组`, { code: 'VALIDATION_ERROR' });
    }
    if (!Array.isArray(meta.dependencies)) {
      throw new TypedAppError(`类型 ${meta.name} 的 dependencies 必须是数组`, { code: 'VALIDATION_ERROR' });
    }
    if (meta.dependencies.includes(meta.name)) {
      throw new TypedAppError(`类型 ${meta.name} 不允许依赖自身（自环）`, { code: 'VALIDATION_ERROR' });
    }
    const seen = new Set<string>();
    for (const dep of meta.dependencies) {
      if (typeof dep !== 'string' || dep.trim().length === 0) {
        throw new TypedAppError(`类型 ${meta.name} 的依赖名非法：${String(dep)}`, { code: 'VALIDATION_ERROR' });
      }
      if (seen.has(dep)) {
        throw new TypedAppError(`类型 ${meta.name} 的依赖 ${dep} 重复声明`, { code: 'VALIDATION_ERROR' });
      }
      seen.add(dep);
    }
    this.orderByName.set(meta.name, this.metaByName.size);
    this.metaByName.set(meta.name, meta);
    return this;
  }

  /** 批量注册（数组序 = 注册序） */
  registerAll(metas: readonly TypeMeta[]): this {
    for (const meta of metas) this.register(meta);
    return this;
  }

  /** 是否已注册 */
  has(name: string): boolean {
    return this.metaByName.has(name);
  }

  /** 取元数据（未注册返回 undefined——前向引用的判空责任在调用方） */
  get(name: string): TypeMeta | undefined {
    return this.metaByName.get(name);
  }

  /** 全部类型名（注册序） */
  names(): readonly string[] {
    return [...this.metaByName.keys()];
  }

  /** 已注册节点数 */
  get size(): number {
    return this.metaByName.size;
  }

  /** 直接依赖（未注册名抛——查询图内拓扑关系应先 has 判空） */
  dependenciesOf(name: string): readonly string[] {
    const meta = this.require(name);
    return [...meta.dependencies];
  }

  /** 直接反向依赖（谁直接依赖 name；注册序） */
  dependentsOf(name: string): readonly string[] {
    this.require(name);
    return this.names().filter((candidate) => this.metaByName.get(candidate)?.dependencies.includes(name));
  }

  /** 传递依赖闭包（不含自身；依赖声明的去重并集，按发现序确定） */
  reachableFrom(name: string): readonly string[] {
    this.require(name);
    const visited = new Set<string>();
    const queue = [...(this.metaByName.get(name)?.dependencies ?? [])];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (visited.has(current) || current === name) continue;
      visited.add(current);
      const next = this.metaByName.get(current)?.dependencies ?? [];
      queue.push(...next);
    }
    return [...visited];
  }

  /**
   * 拓扑序：依赖在前、被依赖在后；同层按注册序（确定性）
   * 未注册的依赖名视为外部叶子（排在依赖者之前即可）；
   * 图有环时抛 VALIDATION_ERROR（消息含环路径）。
   */
  topologicalOrder(): readonly string[] {
    const cycles = this.detectCycles();
    if (cycles.length > 0) {
      throw new TypedAppError(
        `类型依赖图存在 ${cycles.length} 个环，无拓扑序（注册表 ${this.name}）：${cycles.map((c) => c.join(' → ')).join('；')}`,
        { code: 'VALIDATION_ERROR', details: { cycles } },
      );
    }
    const registered = new Set(this.metaByName.keys());
    const sorted = [...registered].sort((a, b) => (this.orderByName.get(a) ?? 0) - (this.orderByName.get(b) ?? 0));
    const indegree = new Map<string, number>();
    const edgesFrom = new Map<string, string[]>();
    for (const node of sorted) {
      const deps = (this.metaByName.get(node)?.dependencies ?? []).filter((d) => registered.has(d));
      edgesFrom.set(node, []);
      indegree.set(node, 0);
      for (const dep of deps) indegree.set(node, (indegree.get(node) ?? 0) + 1);
    }
    for (const node of sorted) {
      for (const dep of this.metaByName.get(node)?.dependencies ?? []) {
        if (registered.has(dep)) edgesFrom.get(dep)?.push(node);
      }
    }
    const ready = sorted.filter((node) => (indegree.get(node) ?? 0) === 0);
    const out: string[] = [];
    // 稳定 Kahn：ready 保持注册序（splice 取首），输出确定
    while (ready.length > 0) {
      const node = ready.shift() as string;
      out.push(node);
      for (const dependent of edgesFrom.get(node) ?? []) {
        const left = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, left);
        if (left === 0) {
          // 插回注册序位置（稳定）：找到第一个注册序更大的 ready 元素前插入
          let at = ready.length;
          const depOrder = this.orderByName.get(dependent) ?? 0;
          for (let i = 0; i < ready.length; i += 1) {
            if ((this.orderByName.get(ready[i]) ?? 0) > depOrder) {
              at = i;
              break;
            }
          }
          ready.splice(at, 0, dependent);
        }
      }
    }
    return out;
  }

  /** 全部环（每环为类型名序列 a → b → … → a；DFS 判定，确定性；无环返回空） */
  detectCycles(): readonly string[][] {
    const state = new Map<string, 'visiting' | 'done'>();
    const stack: string[] = [];
    const cycles: string[][] = [];
    const visit = (node: string): void => {
      const phase = state.get(node);
      if (phase === 'done') return;
      if (phase === 'visiting') {
        const start = stack.indexOf(node);
        cycles.push([...stack.slice(start), node]);
        return;
      }
      state.set(node, 'visiting');
      stack.push(node);
      for (const dep of this.metaByName.get(node)?.dependencies ?? []) {
        if (this.metaByName.has(dep)) visit(dep);
      }
      stack.pop();
      state.set(node, 'done');
    };
    for (const node of this.names()) visit(node);
    return cycles;
  }

  /** 图结构快照（节点 + 边；dashboard 消费形态；全部按注册序确定） */
  describe(): { registry: string; nodes: readonly TypeMeta[]; edges: ReadonlyArray<{ from: string; to: string; registered: boolean }> } {
    const edges: Array<{ from: string; to: string; registered: boolean }> = [];
    for (const node of this.names()) {
      for (const dep of this.metaByName.get(node)?.dependencies ?? []) {
        edges.push({ from: node, to: dep, registered: this.metaByName.has(dep) });
      }
    }
    return { registry: this.name, nodes: this.names().map((n) => this.metaByName.get(n) as TypeMeta), edges };
  }

  /** 确定性 DOT 导出（graphviz 直接渲染；节点/边均按注册序） */
  toDot(): string {
    const lines = [`digraph "${this.name}" {`];
    for (const node of this.names()) {
      const meta = this.metaByName.get(node) as TypeMeta;
      const label = `${node}\\n(${meta.kind}${meta.fields.length > 0 ? `, ${meta.fields.length} 字段` : ''})`;
      lines.push(`  "${node}" [label="${label}"];`);
    }
    for (const node of this.names()) {
      for (const dep of this.metaByName.get(node)?.dependencies ?? []) {
        lines.push(`  "${node}" -> "${dep}"${this.metaByName.has(dep) ? '' : ' [style=dashed]'};`);
      }
    }
    lines.push('}');
    return lines.join('\n');
  }

  private require(name: string): TypeMeta {
    const meta = this.metaByName.get(name);
    if (meta === undefined) {
      throw new TypedAppError(`类型 ${String(name)} 未注册（注册表 ${this.name}；在册：${this.names().join('、') || '无'}）`, {
        code: 'VALIDATION_ERROR',
      });
    }
    return meta;
  }
}

/** 创建独立类型注册表（name 用于诊断与 DOT 标题） */
export function createTypeRegistry(name?: string): TypeRegistry {
  return new TypeRegistry(name);
}

/**
 * 核心数据流类型的预置注册表（本文件 + errors.ts 的公共契约类型）
 *
 * 图结构（依赖箭头方向 = 「依赖」）：
 *   ExecutionPlan → PlanNode → NodeId / ModelId
 *   PlanExecutionResult → NodeResult → NodeId / ModelId
 *   ExecutionError → AppError
 *   EventEnvelope（叶）
 * dashboard / 文档生成可直接消费；业务侧可另建注册表注册领域类型。
 */
export const CORE_TYPE_REGISTRY: TypeRegistry = new TypeRegistry('dsh-core').registerAll([
  {
    name: 'NodeId',
    kind: 'type-alias',
    description: '计划节点 id 品牌（string 的编译期防混用强化）',
    fields: [],
    dependencies: [],
  },
  {
    name: 'ModelId',
    kind: 'type-alias',
    description: '模型 id 品牌（string 的编译期防混用强化）',
    fields: [],
    dependencies: [],
  },
  {
    name: 'AppError',
    kind: 'class',
    description: '应用错误基类：code + details（errors.ts）',
    fields: [
      { name: 'code', type: 'string', description: '机器可读错误码' },
      { name: 'details', type: 'object', optional: true, description: '附加上下文' },
    ],
    dependencies: [],
  },
  {
    name: 'PlanNode',
    kind: 'interface',
    description: 'DAG 计划节点（优化器产出、任务执行消费）',
    fields: [
      { name: 'id', type: 'NodeId', description: '节点 id' },
      { name: 'description', type: 'string', description: '任务描述' },
      { name: 'type', type: 'string', description: '任务类型' },
      { name: 'dependsOn', type: 'NodeId[]', description: '依赖节点列表' },
      { name: 'modelId', type: 'ModelId', optional: true, description: '指定模型' },
      { name: 'timeout', type: 'number', optional: true, description: '节点级超时毫秒' },
      { name: 'cascade', type: 'object[]', optional: true, description: '完成后级联触发' },
    ],
    dependencies: ['NodeId', 'ModelId'],
  },
  {
    name: 'ExecutionPlan',
    kind: 'interface',
    description: '执行计划（三类来源：strategist / fallback / memory）',
    fields: [
      { name: 'objective', type: 'string', description: '目标描述' },
      { name: 'nodes', type: 'PlanNode[]', description: 'DAG 节点列表' },
      { name: 'parallelismStrategy', type: 'string', description: '并行策略' },
      { name: 'source', type: 'string', description: '计划来源枚举' },
    ],
    dependencies: ['PlanNode'],
  },
  {
    name: 'NodeResult',
    kind: 'interface',
    description: '单节点执行结果（任务执行产出、反思器消费）',
    fields: [
      { name: 'nodeId', type: 'NodeId', description: '节点 id' },
      { name: 'modelId', type: 'ModelId', description: '实际执行模型' },
      { name: 'success', type: 'boolean', description: '是否成功' },
      { name: 'output', type: 'string', optional: true, description: '执行产物' },
      { name: 'quality', type: 'number', description: '质量分 0~1' },
      { name: 'latency', type: 'number', description: '延迟毫秒' },
      { name: 'attempts', type: 'number', description: '尝试次数' },
      { name: 'error', type: 'string', optional: true, description: '失败原因' },
      { name: 'tokensUsed', type: 'number', description: 'token 消耗' },
    ],
    dependencies: ['NodeId', 'ModelId'],
  },
  {
    name: 'PlanExecutionResult',
    kind: 'interface',
    description: '计划执行结果（含聚合统计）',
    fields: [
      { name: 'planId', type: 'string', description: '计划 id' },
      { name: 'success', type: 'boolean', description: '整体是否成功' },
      { name: 'nodeResults', type: 'NodeResult[]', description: '各节点结果' },
      { name: 'totalTime', type: 'number', description: '总耗时毫秒' },
      { name: 'successCount', type: 'number', description: '成功节点数' },
      { name: 'totalTokens', type: 'number', description: '总 token 消耗' },
      { name: 'avgQuality', type: 'number', description: '平均质量分（仅成功节点）' },
      { name: 'error', type: 'string', optional: true, description: '整体失败原因' },
    ],
    dependencies: ['NodeResult'],
  },
  {
    name: 'EventEnvelope',
    kind: 'interface',
    description: '跨模块事件总线统一信封（type/payload/ts/seq/source 五要素）',
    fields: [
      { name: 'type', type: 'string', description: '事件类型名（module.verb）' },
      { name: 'payload', type: 'object', description: '事件载荷' },
      { name: 'ts', type: 'number', description: '时间戳毫秒' },
      { name: 'seq', type: 'number', description: '全源单调递增序号' },
      { name: 'source', type: 'string', description: '发布来源标识' },
      { name: 'correlationId', type: 'string', optional: true, description: '业务流横向关联' },
      { name: 'causationId', type: 'string', optional: true, description: '因果链上一事件' },
      { name: 'tenantId', type: 'string', optional: true, description: '租户隔离' },
    ],
    dependencies: [],
  },
  {
    name: 'ExecutionError',
    kind: 'class',
    description: '计划执行失败错误（EXECUTION_ERROR）',
    fields: [],
    dependencies: ['AppError'],
  },
]);
