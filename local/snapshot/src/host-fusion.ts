/**
 * host-fusion.ts — 宿主融合层（质的飞跃）
 *
 * 将调度器从"被动插件"升维为"宿主级认知与安全层"：
 *
 * 1. 全宿主可观测（tools/result，emit 模式）
 *    - 订阅宿主 ToolRegistry 管线事件（cordis 跨 fiber 事件传播）
 *    - 每次宿主工具调用 → 世界模型 observeArrival（学习宿主行为节律，增强预见）
 *    - 工具失败 → 注入 'host-tool-failure' 信号至哨兵（触发决策链路自愈）
 *    - 同工具连续失败达阈值 → 提取教训 + 高紧急度信号（经验沉淀）
 *
 * 2. 全宿主安全治理（tools/pre-execute，waterfall 模式）
 *    - Kill Switch 启用 → 冻结全宿主工具调用（紧急停止从"冻结自身"升级为"冻结宿主"）
 *    - 熔断器开启（调度器自身失败螺旋）→ fail-closed 拒绝宿主动作
 *    - 只读门控（checkGate），不消耗限流/预算，不污染调度器自身治理语义
 *
 * 3. 设计原则
 *    - 观测 fail-open：自身异常绝不破坏宿主管线
 *    - 治理 fail-closed：仅在显式安全状态下拒绝，其余一律 next() 放行
 *    - 自排除：调度器自身桥接的 14 个 Tool 不参与观测/治理（避免反馈环路）
 *    - 零依赖：结构化类型（duck-typing），不 import @deepseek-ai/dsh-tools
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Sentinel } from './sentinel.js';
import type { WorldModel } from './world-model.js';
import type { SafetyGovernor } from './safety-governor.js';

// ─────────────────────────── 结构化类型（宿主管线载荷） ───────────────────────────

/** 宿主工具执行对象（ToolExecution 的结构化子集） */
interface HostToolExecution {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/** 宿主工具执行结果（ToolExecutionResult 的结构化子集） */
interface HostToolResult {
  readonly isError: boolean;
  readonly error?: { message: string };
}

/** pre-execute waterfall 决策 */
type PreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string };

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

// ─────────────────────────── 第三轮：宿主能力协商 ───────────────────────────

/** 本插件 speaks 的宿主协议版本（每次破坏性变更 +1） */
export const HOST_PROTOCOL_VERSION = 3;

/** 向后兼容的最低协议线（协商版本低于此线 = 不兼容，拒绝激活） */
export const HOST_MIN_PROTOCOL_VERSION = 2;

/**
 * 特性位向量定义（版本化能力集的位）。新增特性只加位不改位——
 * 旧宿主不认识的位自然在协商交集中被丢弃（前向兼容）。
 */
export const HostFeature = {
  /** tools/result 观测事件（emit 模式） */
  ToolResultEvents: 1 << 0,
  /** tools/pre-execute 治理门（waterfall 模式） */
  PreExecuteGate: 1 << 1,
  /** 进度流式推送（宿主侧长连接） */
  ProgressStreaming: 1 << 2,
  /** 进度轮询（流式不可用时的降级替代） */
  ProgressPolling: 1 << 3,
  /** 结构化工具 schema（参数校验前置） */
  StructuredToolSchemas: 1 << 4,
  /** 多模态内容（图文混排载荷） */
  MultimodalContent: 1 << 5,
} as const;

export type HostFeatureName = keyof typeof HostFeature;

/** 全部特性名（稳定枚举序，协商与降级遍历用） */
export const HOST_FEATURE_NAMES: readonly HostFeatureName[] = [
  'ToolResultEvents',
  'PreExecuteGate',
  'ProgressStreaming',
  'ProgressPolling',
  'StructuredToolSchemas',
  'MultimodalContent',
];

/**
 * 降级链：我方想要某特性但协商交集里没有时，按链回退。
 * 链首是该特性自身，其后是替代特性，0 = 无替代（能力整体让渡）。
 */
export const HOST_DEGRADATION_CHAINS: Readonly<Partial<Record<HostFeatureName, readonly number[]>>> = {
  ProgressStreaming: [HostFeature.ProgressStreaming, HostFeature.ProgressPolling, 0],
};

/** 版本化能力集（协议版本 + 特性位向量） */
export interface HostCapabilities {
  protocolVersion: number;
  /** 特性位向量（HostFeature 位或组合） */
  features: number;
  /** 能力集标识（宿主名/版本，可观测用） */
  label?: string;
}

/** 一次降级事件（新特性不可用 → 回退并记录） */
export interface CapabilityDegradation {
  feature: HostFeatureName;
  bit: number;
  /** 实际回退到的特性位（0 = 无替代，能力让渡） */
  fallbackBit: number;
  fallbackName: string;
  reason: string;
}

/** 能力协商结果 */
export interface NegotiationResult {
  /** 协议版本协商后仍 ≥ 最低兼容线 */
  compatible: boolean;
  /** 不兼容原因（compatible=false 时给出） */
  incompatibleReason?: string;
  /** 协商协议版本 = min(我方, 宿主) */
  protocolVersion: number;
  /** 是否发生了协议版本降级 */
  protocolDowngraded: boolean;
  /** 特性交集（协商后立即可用的特性位） */
  features: number;
  /** 交集内的可用特性名 */
  enabled: HostFeatureName[];
  /** 我方想要但交集缺失、走了降级链的特性（含回退落点） */
  degradations: CapabilityDegradation[];
  ours: HostCapabilities;
  theirs: HostCapabilities;
  negotiatedAt: number;
}

/** 位向量 → 特性名列表（可观测口径） */
export function describeFeatures(bits: number): HostFeatureName[] {
  return HOST_FEATURE_NAMES.filter((name) => (bits & HostFeature[name]) !== 0);
}

/**
 * 能力协商（纯函数）：协议版本取 min（低于我方最低线 → 不兼容），
 * 特性取交集；我方声明想要（我方位图中置位）但交集缺失的特性沿
 * HOST_DEGRADATION_CHAINS 回退——回退落点必须是交集内的位或 0
 * （无替代），每步留下降级记录。交集之外的能力静默丢弃不记录
 * （宿主没有的东西谈不上「降级」，只有我方依赖的才需要账）。
 */
export function negotiateCapabilities(ours: HostCapabilities, theirs: HostCapabilities, now = Date.now()): NegotiationResult {
  const protocolVersion = Math.min(ours.protocolVersion, theirs.protocolVersion);
  const features = ours.features & theirs.features;
  const compatible = protocolVersion >= HOST_MIN_PROTOCOL_VERSION;
  const degradations: CapabilityDegradation[] = [];
  if (compatible) {
    for (const name of HOST_FEATURE_NAMES) {
      const bit = HostFeature[name];
      // 只为我方声明依赖（置位）且宿主缺失的特性记账走降级
      if ((ours.features & bit) === 0 || (features & bit) !== 0) continue;
      const chain = HOST_DEGRADATION_CHAINS[name];
      // 链首是自身（已缺失），从第二项开始找交集内的落点；无链 = 无替代
      let fallbackBit = 0;
      if (chain) {
        for (let i = 1; i < chain.length; i += 1) {
          if (chain[i] === 0 || (features & chain[i]) !== 0) {
            fallbackBit = chain[i];
            break;
          }
        }
      }
      degradations.push({
        feature: name,
        bit,
        fallbackBit,
        fallbackName: fallbackBit === 0 ? 'none' : describeFeatures(fallbackBit)[0] ?? `bit${fallbackBit}`,
        reason:
          fallbackBit === 0
            ? `宿主 ${theirs.label ?? `protocol v${theirs.protocolVersion}`} 不提供 ${name} 且无替代——该能力让渡`
            : `宿主 ${theirs.label ?? `protocol v${theirs.protocolVersion}`} 不支持 ${name}，回退至 ${describeFeatures(fallbackBit)[0] ?? `bit${fallbackBit}`}`,
      });
    }
  }
  return {
    compatible,
    ...(compatible ? {} : { incompatibleReason: `协议版本协商结果 v${protocolVersion} 低于最低兼容线 v${HOST_MIN_PROTOCOL_VERSION}` }),
    protocolVersion,
    protocolDowngraded: protocolVersion < ours.protocolVersion,
    features,
    enabled: describeFeatures(features),
    degradations,
    ours,
    theirs,
    negotiatedAt: now,
  };
}

// ─────────────────────────── 配置 ───────────────────────────

/** 宿主融合层配置 */
export interface HostFusionConfig {
  /** 是否启用宿主融合（缺省 true；宿主无 ctx.tools 时自动静默降级） */
  enabled: boolean;
  /** 是否观测宿主工具结果（世界模型 + 失败信号注入） */
  observeToolResults: boolean;
  /** 是否治理宿主工具调用（kill switch / 熔断器门控） */
  governToolCalls: boolean;
  /** 同工具连续失败达到该次数后注入高紧急度信号并提取教训 */
  failureEscalationThreshold: number;
  /**
   * 第四轮（激活）：宿主工具可靠性信念——工具成败作为观测证据写入世界
   * 模型观测融合（键 host-tool-reliability:<tool>，值 'healthy'/'failing'）。
   * opt-in（缺省 false）：开启后工具状态翻转不再静默——健康→失败会走
   * 第三轮真冲突记账（等显式裁决）而非无声翻转；证据同时喂给第四轮
   * 不确定性地图（单观察源的可靠性键恒为薄弱区——诚实呈现）与事件
   * 因果链账本。世界模型未挂载观测融合时 writeObservation 返回
   * undefined，静默无操作（诚实降级）。
   */
  observeToolReliability?: boolean;
}

/** 默认配置 */
export const DEFAULT_HOST_FUSION_CONFIG: HostFusionConfig = {
  enabled: true,
  observeToolResults: true,
  governToolCalls: true,
  failureEscalationThreshold: 3,
  observeToolReliability: false,
};

// ─────────────────────────── 依赖注入面 ───────────────────────────

/** 融合层依赖（由 index.ts apply 注入） */
export interface HostFusionDeps {
  ctx: Context;
  sentinel: Sentinel;
  worldModel: WorldModel;
  governor: SafetyGovernor;
  /** 进度广播（可为 null：enableProgress=false 时） */
  broadcast: (event: Record<string, unknown>) => void;
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void };
  /** 调度器自身桥接进宿主注册表的 Tool 名集合（自排除，避免反馈环路） */
  selfToolNames: Set<string>;
  /** 教训提取回调（复用反思引擎的规则化路径） */
  onLessonExtracted?: (toolName: string, consecutiveFailures: number, lastError: string) => void;
}

// ─────────────────────────── 融合层主体 ───────────────────────────

/**
 * 宿主融合层
 *
 * 由 index.ts 在全部引擎构造完成后 activate()；fiber 卸载时 dispose()。
 * 宿主未提供 ctx.tools 服务时，activate() 静默返回 false（降级为纯内部模式）。
 */
export class HostFusionLayer {
  private config: HostFusionConfig;
  private deps: HostFusionDeps;
  private active = false;
  /** 每工具连续失败计数 */
  private consecutiveFailures = new Map<string, number>();
  /** 每工具最近一次失败信息 */
  private lastFailureError = new Map<string, string>();
  /** 统计 */
  private stats = { observed: 0, failures: 0, governed: 0, denied: 0, reliabilityWrites: 0 };
  /** 第三轮：最近一次能力协商结果（activate 前显式给宿主能力集则用之） */
  private negotiation?: NegotiationResult;

  constructor(config: Partial<HostFusionConfig> | undefined, deps: HostFusionDeps) {
    this.config = { ...DEFAULT_HOST_FUSION_CONFIG, ...config };
    this.deps = deps;
  }

  /**
   * 第三轮：声明本插件的能力集（观测/治理按配置裁剪——没开的开关
   * 不进「我方想要」清单，协商时就不会为其记降级）。
   */
  private ourCapabilities(): HostCapabilities {
    let features = 0;
    if (this.config.observeToolResults) features |= HostFeature.ToolResultEvents;
    if (this.config.governToolCalls) features |= HostFeature.PreExecuteGate;
    // 进度通道：优先流式，轮询兜底（降级链在协商时展开）
    features |= HostFeature.ProgressStreaming | HostFeature.ProgressPolling;
    return { protocolVersion: HOST_PROTOCOL_VERSION, features, label: 'dsh-proactive' };
  }

  /**
   * 第三轮：与宿主协商能力集。
   *
   * @param theirs 宿主能力集；缺省自动探测——宿主 ToolRegistry 在场即按
   *   当代宿主（全特性、当前协议线）处理（保持既有激活行为逐位不变）；
   *   不在场则 v0/无特性 → 协商不兼容（等价于旧逻辑的静默降级返回 false）。
   *   旧宿主场景由调用方显式传入其版本化能力集（宿主侧自报）。
   * @returns 协商结果（activate() 将按其裁剪订阅面；降级已逐条记录）
   */
  negotiateWithHost(theirs?: HostCapabilities): NegotiationResult {
    if (theirs) {
      this.negotiation = negotiateCapabilities(this.ourCapabilities(), theirs);
      return this.negotiation;
    }
    // 自动探测：宿主 ToolRegistry 在场 → 当代宿主口径
    const hostTools = (this.deps.ctx as Context & { get?: (key: string) => unknown }).get?.('tools');
    let allFeatures = 0;
    for (const name of HOST_FEATURE_NAMES) allFeatures |= HostFeature[name];
    const probed: HostCapabilities = hostTools
      ? { protocolVersion: HOST_PROTOCOL_VERSION, features: allFeatures, label: 'auto-probe(current-gen)' }
      : { protocolVersion: 0, features: 0, label: 'auto-probe(no-tool-registry)' };
    this.negotiation = negotiateCapabilities(this.ourCapabilities(), probed);
    return this.negotiation;
  }

  /** 第三轮：最近一次能力协商结果（未协商 → undefined） */
  getNegotiation(): NegotiationResult | undefined {
    return this.negotiation;
  }

  /**
   * 激活融合层：订阅宿主管线事件
   *
   * 第三轮：激活面由能力协商裁剪——协商不兼容或对应特性位缺失时
   * 跳过订阅（降级已记录在 getNegotiation()）。缺省自动探测当代宿主，
   * 订阅行为与升级前逐位一致（零漂移）。
   * @returns 是否成功激活（宿主无 ctx.tools / 协商不兼容时返回 false）
   */
  activate(): boolean {
    if (!this.config.enabled) return false;

    // 第三轮：先协商（显式 negotiateWithHost 预置的结果优先复用）
    const negotiation = this.negotiation ?? this.negotiateWithHost();
    if (!negotiation.compatible) {
      this.deps.logger.warn('宿主能力协商不兼容：%s —— 融合层不激活（静默降级）', negotiation.incompatibleReason ?? 'unknown');
      return false;
    }
    for (const degradation of negotiation.degradations) {
      this.deps.logger.warn('能力降级：%s', degradation.reason);
    }
    const { ctx } = this.deps;

    // ── 观测：tools/result（emit 模式，跨 fiber 传播；协商缺位则跳过） ──
    if (this.config.observeToolResults && (negotiation.features & HostFeature.ToolResultEvents) !== 0) {
      ctx.on('tools/result', (exec: HostToolExecution, result: HostToolResult) => {
        try {
          this.onToolResult(exec, result);
        } catch {
          /* 观测 fail-open：绝不破坏宿主管线 */
        }
      });
    }

    // ── 治理：tools/pre-execute（waterfall 模式；协商缺位则跳过） ──
    if (this.config.governToolCalls && (negotiation.features & HostFeature.PreExecuteGate) !== 0) {
      ctx.on('tools/pre-execute', async (exec: HostToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
        try {
          // await 在 try 内：异步 rejection 也落入 fail-open 兜底（不 await 会
          // 把 onPreExecute 的异步异常漏出治理门，直接打断宿主管线）
          return await this.onPreExecute(exec, next);
        } catch {
          /* 治理自身异常 → fail-open 放行，不阻断宿主 */
          return next();
        }
      });
    }

    this.active = true;
    this.deps.logger.info(
      '宿主融合层已激活（观测: %s / 治理: %s | 协议 v%s / 特性 [%s]%s）',
      this.config.observeToolResults && (negotiation.features & HostFeature.ToolResultEvents) !== 0,
      this.config.governToolCalls && (negotiation.features & HostFeature.PreExecuteGate) !== 0,
      negotiation.protocolVersion,
      negotiation.enabled.join(', ') || '无',
      negotiation.degradations.length > 0 ? ` / 降级 ${negotiation.degradations.length} 项` : '',
    );
    return true;
  }

  /** 是否已激活 */
  isActive(): boolean {
    return this.active;
  }

  /** 融合层统计 */
  getStats(): {
    observed: number;
    failures: number;
    governed: number;
    denied: number;
    /** 第四轮：可靠性信念写入次数（observeToolReliability 关闭时恒 0） */
    reliabilityWrites: number;
    active: boolean;
    /** 第三轮：能力协商摘要（未协商 → undefined） */
    negotiation?: { compatible: boolean; protocolVersion: number; protocolDowngraded: boolean; features: number; enabled: HostFeatureName[]; degradations: number };
  } {
    return {
      ...this.stats,
      active: this.active,
      ...(this.negotiation
        ? {
            negotiation: {
              compatible: this.negotiation.compatible,
              protocolVersion: this.negotiation.protocolVersion,
              protocolDowngraded: this.negotiation.protocolDowngraded,
              features: this.negotiation.features,
              enabled: this.negotiation.enabled,
              degradations: this.negotiation.degradations.length,
            },
          }
        : {}),
    };
  }

  /**
   * 观测宿主工具执行结果
   * - 成功：世界模型学习到达节律 + 重置该工具失败计数
   * - 失败：注入信号 + 连续失败升级
   */
  private onToolResult(exec: HostToolExecution, result: HostToolResult): void {
    // 自排除：调度器自身桥接的 Tool 不参与观测
    if (this.deps.selfToolNames.has(exec.name)) return;

    this.stats.observed += 1;

    // 世界模型：学习宿主工具调用节律（预见性增强）
    this.deps.worldModel.observeArrival(`host-tool:${exec.name}`);

    // 第四轮（激活）：宿主工具可靠性信念（opt-in；观测融合未挂载时
    // writeObservation 返回 undefined——静默无操作，不破坏宿主管线）
    if (this.config.observeToolReliability) {
      const written = this.deps.worldModel.writeObservation(
        `host-tool-reliability:${exec.name}`,
        result.isError ? 'failing' : 'healthy',
        'host-fusion',
        { confidence: 0.7 },
      );
      if (written) this.stats.reliabilityWrites += 1;
    }

    if (!result.isError) {
      // 成功 → 重置该工具连续失败计数
      this.consecutiveFailures.delete(exec.name);
      return;
    }

    // ── 失败路径 ──
    this.stats.failures += 1;
    const errorMsg = result.error?.message ?? 'unknown error';
    const count = (this.consecutiveFailures.get(exec.name) ?? 0) + 1;
    this.consecutiveFailures.set(exec.name, count);
    this.lastFailureError.set(exec.name, errorMsg);

    // 注入信号至哨兵（触发决策链路）
    const escalated = count >= this.config.failureEscalationThreshold;
    this.deps.sentinel.ingest({
      type: 'host-tool-failure',
      description: `宿主工具 ${exec.name} 执行失败${count > 1 ? `（连续第 ${count} 次）` : ''}: ${errorMsg.slice(0, 200)}`,
      source: `host-tool:${exec.name}`,
      urgency: escalated ? 0.9 : 0.5,
      dedupeKey: `host-tool-failure:${exec.name}`,
      payload: { toolName: exec.name, consecutiveFailures: count, error: errorMsg.slice(0, 500), escalated },
    });

    // 连续失败升级 → 提取教训 + 进度广播
    if (escalated && count === this.config.failureEscalationThreshold) {
      this.deps.logger.warn('宿主工具 %s 连续失败 %d 次，已升级（教训提取 + 高紧急度信号）', exec.name, count);
      this.deps.onLessonExtracted?.(exec.name, count, errorMsg);
    }

    this.deps.broadcast({
      type: 'host-tool-failure',
      toolName: exec.name,
      consecutiveFailures: count,
      escalated,
      error: errorMsg.slice(0, 200),
    });
  }

  /**
   * 治理宿主工具调用（pre-execute waterfall）
   * - Kill Switch → deny（紧急冻结全宿主）
   * - 熔断器开启 → deny（fail-closed）
   * - 其余 → next() 放行
   */
  private async onPreExecute(exec: HostToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    // 自排除：调度器自身 Tool 不受宿主治理门控（避免双重治理）
    if (this.deps.selfToolNames.has(exec.name)) return next();

    this.stats.governed += 1;

    // 只读门控：kill switch + 熔断器（不消耗限流/预算）
    const gate = this.deps.governor.checkGate();
    if (!gate.allowed) {
      this.stats.denied += 1;
      this.deps.broadcast({
        type: 'host-tool-denied',
        toolName: exec.name,
        blockedBy: gate.blockedBy,
        reason: gate.reason,
      });
      return { kind: 'deny', reason: `[scheduler-governor] ${gate.reason}` };
    }

    return next();
  }

  /** 卸载：清理状态（事件监听由 cordis fiber 自动回收） */
  dispose(): void {
    this.active = false;
    this.consecutiveFailures.clear();
    this.lastFailureError.clear();
    this.negotiation = undefined;
  }
}
