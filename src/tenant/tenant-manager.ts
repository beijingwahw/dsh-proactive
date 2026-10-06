/**
 * tenant-manager.ts — 多租户管理器（能力层，依赖 long-term-memory）
 *
 * 职责：
 * - 租户注册 / 移除 / 更新 / 查询（含按标签检索）
 * - 每个租户持有独立的 LongTermMemory 实例与运行时状态（TenantRuntime）
 * - 按文件路径匹配租户（matchTenantByPath）
 * - 信号路由：将外部信号分发到最合适的租户（routeSignal）
 * - 租户注册表持久化与全局统计
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 注册表持久化：租户配置落盘到 registry.json，进程重启后自动恢复全部运行时
 * 2. 信号路由评分制：按 payload 路径前缀匹配深度 + 信号类型命中 + 标签命中
 *    加权打分，选择得分最高的租户，而非简单首个匹配
 * 3. 路径匹配安全化：workDir 规范化后做前缀比较，防止相对路径逃逸误匹配
 * 4. 租户级记忆隔离：每个租户独立 memoryPath 与 LongTermMemory 实例，
 *    移除租户时可选级联删除数据
 * 5. 运行时统计自维护：activeExecutions / pendingSignals / stats 全量跟踪，
 *    供 model_dashboard 与 manage_tenants Tool 直接消费
 *
 * 第三轮升级（治理域 A13）：
 * 6. 极大极小公平配额（44.0 口径自实现水填充，内核不 import）：资源容量
 *    超卖时按「需求低于水位者拿满、超额者按权重比例注水均摊」分配，
 *    附公平支配性审计（任何未拿满者的增长必挤占一个相对份额不高于
 *    自己的持有者）——没有谁被饿死从口号变成定理；释放需求即自动重分配
 * 7. 吵闹邻居抑制：租户消费滚动窗口检测 → 速率限制梯度
 *    （正常 → 软限制警告 → 硬限制拒绝）+ 影响记账（超配额总量 / 被压
 *    消费事件数 / 软硬计数全量可观测）；硬限制带滞回（回落到软阈值以下
 *    才解除，边界不抖动）；未配置零介入（旧行为逐位保留）
 *
 * 第四轮升级（治理域 R4-A13，全新维度）：
 * 8. 配额预测性调整：用量流按时间桶聚合 → EWMA 水平 + 最小二乘斜率
 *    外推，在「将超配额」真正发生之前给出预警（warnFactor 口径：当前
 *    未超但外推将超）与扩容建议（预测峰值 / headroom 目标容量、含增量）；
 *    增长流预警时刻严格先于首个实际越限、平稳流零误报；给出按当前斜率
 *    的预计越限时刻（timeToBreachMs）；未配置零介入（observeUsage 空
 *    操作、forecastQuota undefined——旧行为逐位保留）
 * 9. 审计合规导出：租户资源使用（配额满足率）+ 公平性核验（水填充
 *    分配的公平支配性审计）+ 安全事件摘要（治理器结构化鸭子类型数据源）
 *    汇聚为结构化 JSON 合规报告——确定性字段序（构造序固定）+ SHA-256
 *    全文摘要；同状态两次导出逐位一致（含注入 asOf 时钟口径）
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../errors.js';
import { LongTermMemory } from '../memory/long-term-memory.js';
import type { ModelLongTermProfile } from '../memory/long-term-memory.js';
import { CryptoEngine, type EncryptedField } from '../security/crypto-engine.js';
import type { Signal } from '../sentinel.js';

/** 租户静态配置 */
export interface TenantConfig {
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
  strategistModel?: { id: string; endpoint: string; apiKey: string };
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
  /** 第三轮：公平配额权重（declareQuotaDemand 未显式给权重时的缺省，default 1） */
  quotaWeight?: number;
  createdAt: number;
  lastActiveAt: number;
}

/** 租户运行时（配置 + 记忆 + 实时状态） */
export interface TenantRuntime {
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
export interface TenantRegistry {
  version: number;
  tenants: TenantConfig[];
  globalDefaults: {
    qualityThreshold: number;
    maxRetries: number;
    globalTimeout: number;
    aggregationWindow: number;
  };
}

/** 注册表默认值（与 cordis.patch.yml 全局配置对齐） */
const DEFAULT_GLOBALS: TenantRegistry['globalDefaults'] = {
  qualityThreshold: 0.7,
  maxRetries: 2,
  globalTimeout: 300000,
  aggregationWindow: 5,
};

// ─────────────── 第三轮：极大极小公平配额 + 吵闹邻居抑制 ───────────────

/** 单个租户在某资源上的配额分配结果 */
export interface QuotaAllocationEntry {
  tenantId: string;
  /** 申报需求 */
  demand: number;
  /** 权重（缺省 1；等权即经典极大极小） */
  weight: number;
  /** 分配份额（水填充解） */
  allocated: number;
  /** 需求满足率 allocated/demand（demand=0 视为 1） */
  satisfaction: number;
}

/** 一次配额分配的完整结果（含注水水位与公平性审计） */
export interface QuotaAllocationResult {
  resource: string;
  capacity: number;
  /** 注水水位（超额需求者共同的水位线） */
  waterLevel: number;
  /** 总赤字（未满足需求合计） */
  deficit: number;
  /** 分配是否满足公平支配性（44.0 定义性口径） */
  fair: boolean;
  /** 公平支配性违例数（0 = 极大极小成立） */
  fairnessViolations: number;
  entries: QuotaAllocationEntry[];
  allocatedAt: number;
}

/** 吵闹邻居抑制配置（未配置 = 不检测不限流，旧行为） */
export interface NoisyNeighborConfig {
  /** 滚动检测窗口（ms） */
  windowMs: number;
  /** 窗口用量超过配额 × softFactor → 软限制（放行 + 警告 + 记账） */
  softFactor: number;
  /** 窗口用量超过配额 × hardFactor → 硬限制（拒绝） */
  hardFactor: number;
  /** 连续软限制累计到该次数 → 升级硬限制（梯度第二通道） */
  maxSoftStrikes: number;
  /** 硬限制解除阈值（窗口比值须回落到 ≤ softFactor × recoveryFactor；滞回防抖） */
  recoveryFactor: number;
  /** 注入时钟（确定性验证口径；缺省 Date.now） */
  clock?: () => number;
}

/** 配额执法裁决 */
export interface NoisyNeighborVerdict {
  allowed: boolean;
  level: 'normal' | 'soft' | 'hard';
  /** 是否真的在执法（未配置抑制 / 未分配配额 → false，恒放行） */
  enforced: boolean;
  /** 滚动窗口内用量 */
  windowUsage: number;
  /** 生效配额（未分配 → null 表示不限） */
  quota: number | null;
  /** 窗口用量 / 配额（quota null → 0） */
  ratio: number;
  /** 连续软限制次数 */
  softStrikes: number;
  /** 硬限制触发通道 */
  escalatedBy?: 'ratio' | 'strikes';
  warning?: string;
  reason?: string;
}

/** 吵闹邻居影响记账条目（治理可观测口径） */
export interface NoisyNeighborEntry {
  tenantId: string;
  resource: string;
  level: 'normal' | 'soft' | 'hard';
  windowUsage: number;
  quota: number | null;
  ratio: number;
  softStrikes: number;
  /** 软限制警告次数 */
  warnedEvents: number;
  /** 硬限制拒绝次数 */
  suppressedEvents: number;
  /** 超配额消耗总量（影响记账：挤占了多少共享资源） */
  excessTotal: number;
}

/** 资源配额状态（容量 + 各租户需求申报 + 最近一次分配） */
interface ResourceQuotaState {
  capacity: number;
  demands: Map<string, { demand: number; weight: number }>;
  lastAllocation?: QuotaAllocationResult;
}

/** 单租户单资源的吵闹邻居跟踪状态 */
interface NoisyNeighborState {
  events: Array<{ at: number; amount: number }>;
  softStrikes: number;
  hardActive: boolean;
  level: 'normal' | 'soft' | 'hard';
  warnedEvents: number;
  suppressedEvents: number;
  excessTotal: number;
}

// ─────────────── 第四轮：配额预测性调整（EWMA + 斜率外推） ───────────────

/** 配额预测配置（opt-in；未配置 = 无预测语义，旧行为） */
export interface QuotaForecastConfig {
  /** EWMA 平滑系数 α ∈ (0,1]（越大越偏重新样本） */
  alpha: number;
  /** 用量聚合桶宽 ms（每桶一个样本点；缺桶按 0 计入斜率窗） */
  intervalMs: number;
  /** 斜率估计窗口（最近 K 个桶做最小二乘回归，K ≥ 2） */
  slopeWindow: number;
  /** 预测时域 ms（外推该时长后的桶用量） */
  horizonMs: number;
  /** 预警线：外推用量 / 配额 ≥ warnFactor 且当前水平未超 → 预警 */
  warnFactor: number;
  /** 扩容余量目标：建议容量 = ⌈预测峰值 / headroom⌉（缺省 0.7） */
  headroom?: number;
  /** 注入时钟（确定性验证口径；缺省 Date.now） */
  clock?: () => number;
}

/** 一次配额外推的完整读数 */
export interface QuotaForecast {
  tenantId: string;
  resource: string;
  /** 已观测的样本事件数（跨桶累计） */
  samples: number;
  /** EWMA 平滑后的当前桶用量水平 */
  level: number;
  /** 最小二乘斜率（每桶用量增量；0 = 平稳，>0 = 增长） */
  slope: number;
  /** 外推 horizonMs 后的桶用量（负增长按 0 截断） */
  projectedUsage: number;
  /** 执法基准配额（最近一次分配的 allocated；未分配 → null） */
  quota: number | null;
  /** 外推用量 / 配额（quota null → 0） */
  projectedRatio: number;
  /** 当前 EWMA 水平是否已超配额 */
  alreadyOver: boolean;
  /** 预警：当前未超、外推将超（先于真正超限的提前量） */
  willExceed: boolean;
  /** 按当前斜率的预计越限时刻（相对现在的 ms；斜率 ≤ 0 且未超 → null；已超 → 0） */
  timeToBreachMs: number | null;
  /** 预计越限绝对时刻（timeToBreachMs null → null） */
  breachAt: number | null;
  /** 扩容建议容量（预警时 ⌈预测峰值 / headroom⌉；无预警 → null） */
  recommendedCapacity: number | null;
  /** 建议增量（相对当前登记容量；无建议 → 0） */
  recommendedAddition: number;
  forecastAt: number;
}

/** 单租户单资源的用量观测序列（桶聚合） */
interface ForecastSeries {
  /** 桶起始时间索引 → 桶内用量合计 */
  buckets: Map<number, number>;
  /** 累计观测事件数 */
  observations: number;
}

// ─────────────── 第四轮：审计合规导出（确定性字段序 + SHA-256 摘要） ───────────────

/** 治理器安全事件摘要（SafetyGovernor.securitySummary 的结构化鸭子类型口径） */
export interface ComplianceSecuritySummary {
  killSwitchEngaged: boolean;
  circuitState: string;
  ladder: {
    throttleActive: boolean;
    breakerActive: boolean;
    killActive: boolean;
    causes: Array<{
      cause: string;
      level: string;
      levelIndex: number;
      since: number;
      strikes: number;
      escalations: number;
      suppressed: number;
      cooldownRemainingMs: number;
    }>;
  } | null;
  incidents: {
    auditEntries: number;
    allowed: number;
    blocked: number;
    ladderActions: number;
    byBlocker: Array<{ blocker: string; count: number }>;
    /** 取证事故概要（治理器未挂载取证 → 空数组） */
    forensics: Array<{
      incidentId: string;
      openedAt: number;
      closedAt?: number;
      outcome?: string;
      events: number;
      causalComplete: boolean;
    }>;
  };
}

/** 合规报告的治理器数据源（结构化鸭子类型——SafetyGovernor 天然满足，零 import 耦合） */
export interface ComplianceGovernorSource {
  securitySummary(options?: { auditLimit?: number }): ComplianceSecuritySummary;
}

/** 合规报告（租户资源使用 + 公平性核验 + 安全事件摘要；确定性字段序） */
export interface ComplianceReport {
  reportType: 'dsh-compliance';
  schemaVersion: 1;
  generatedAt: number;
  scope: { tenants: number; resources: number };
  tenants: Array<{
    tenantId: string;
    name: string;
    enabled: boolean;
    tags: string[];
    quotas: Array<{ resource: string; demand: number; weight: number; allocated: number; satisfaction: number }>;
    noisyNeighbor: { level: string; warnedEvents: number; suppressedEvents: number; excessTotal: number } | null;
  }>;
  fairness: Array<{
    resource: string;
    capacity: number;
    allocatedTotal: number;
    deficit: number;
    waterLevel: number;
    fair: boolean;
    fairnessViolations: number;
    allocatedAt: number;
  }>;
  forecast: Array<{
    tenantId: string;
    resource: string;
    level: number;
    slope: number;
    projectedUsage: number;
    projectedRatio: number;
    willExceed: boolean;
    timeToBreachMs: number | null;
    recommendedCapacity: number | null;
    recommendedAddition: number;
  }>;
  security: ComplianceSecuritySummary | null;
  /** 报告正文（除 digest 外）的 SHA-256 hex（逐位一致性口径） */
  digest: string;
}

/**
 * 多租户管理器
 *
 * 被 index.ts 集成层持有，manage_tenants Tool 的全部 action 映射到本类方法。
 */
export class TenantManager {
  private dataDir: string;
  private registryPath: string;
  private registry: TenantRegistry;
  private runtimes = new Map<string, TenantRuntime>();
  private cryptoEngine?: CryptoEngine;
  /** 第三轮：各资源的公平配额状态（opt-in，未登记即无配额语义） */
  private quotas = new Map<string, ResourceQuotaState>();
  /** 第三轮：吵闹邻居抑制（未配置 = 零介入） */
  private noisy?: {
    config: NoisyNeighborConfig;
    clock: () => number;
    state: Map<string, NoisyNeighborState>;
  };
  /** 第四轮：配额预测（未配置 = 零介入） */
  private forecastCfg?: {
    config: QuotaForecastConfig;
    clock: () => number;
    series: Map<string, ForecastSeries>;
  };

  /**
   * @param dataDir 租户数据根目录（注册表与各租户记忆库的存放处）
   * @param cryptoEngine 可选加密引擎，透传给各租户的记忆库
   */
  constructor(dataDir: string, cryptoEngine?: CryptoEngine) {
    this.dataDir = dataDir;
    this.cryptoEngine = cryptoEngine;
    this.registryPath = path.join(dataDir, 'registry.json');
    this.registry = this.loadRegistry();
    // 恢复所有已启用租户的运行时
    for (const config of this.registry.tenants) {
      if (config.enabled !== false) {
        this.runtimes.set(config.id, this.buildRuntime(config));
      }
    }
  }

  /**
   * 注册新租户并创建运行时
   * @param config 租户配置（createdAt / lastActiveAt 自动填充）
   * @throws ConfigError id 重复或必填字段缺失
   */
  registerTenant(config: Omit<TenantConfig, 'createdAt' | 'lastActiveAt'>): TenantRuntime {
    if (!config.id || !config.name || !config.workDir) {
      throw new ConfigError('租户配置缺少必填字段: id / name / workDir');
    }
    if (this.registry.tenants.some((t) => t.id === config.id)) {
      throw new ConfigError(`租户已存在: ${config.id}`);
    }
    const now = Date.now();
    const fullConfig: TenantConfig = {
      enabled: true,
      ...config,
      createdAt: now,
      lastActiveAt: now,
    };
    this.registry.tenants.push(fullConfig);
    this.persistRegistry();
    const runtime = this.buildRuntime(fullConfig);
    this.runtimes.set(fullConfig.id, runtime);
    return runtime;
  }

  /**
   * 移除租户
   * @param tenantId 租户 id
   * @param deleteData 是否级联删除租户记忆数据，默认 false
   */
  removeTenant(tenantId: string, deleteData = false): void {
    // 校验先行：原实现先销毁运行时再查注册表——注册表缺失时抛错，
    // 但运行时已被删，留下「调用方以为失败、系统却已半移除」的不一致状态
    const index = this.registry.tenants.findIndex((t) => t.id === tenantId);
    if (index < 0) {
      throw new ConfigError(`租户不存在: ${tenantId}`);
    }
    const [removed] = this.registry.tenants.splice(index, 1);
    const runtime = this.runtimes.get(tenantId);
    if (runtime) {
      if (runtime.aggregationTimer) clearTimeout(runtime.aggregationTimer);
      runtime.memory.dispose();
      this.runtimes.delete(tenantId);
    }
    // 配额需求随租户终结：declareQuotaDemand 要求租户在案，需求不应比租户
    // 活得更久——否则幽灵需求在后续 allocateQuotas 中继续挤占存量租户份额；
    // 已分配过的资源立即重分配（其余租户自动受益，与 releaseQuotaDemand 同口径）
    for (const [resource, state] of this.quotas) {
      if (state.demands.delete(tenantId) && state.lastAllocation) {
        this.allocateQuotas(resource);
      }
    }
    this.persistRegistry();
    if (deleteData && removed) {
      const memoryPath = this.resolveMemoryPath(removed);
      try {
        if (fs.existsSync(memoryPath)) fs.rmSync(memoryPath);
      } catch {
        /* 数据删除失败不阻塞移除流程 */
      }
    }
  }

  /**
   * 更新租户配置（增量合并）
   * @param tenantId 租户 id
   * @param updates 需要更新的字段
   */
  updateTenant(tenantId: string, updates: Partial<TenantConfig>): void {
    const config = this.registry.tenants.find((t) => t.id === tenantId);
    if (!config) {
      throw new ConfigError(`租户不存在: ${tenantId}`);
    }
    // id 为不可变主键
    const { id: _ignored, ...safeUpdates } = updates;
    Object.assign(config, safeUpdates);
    this.persistRegistry();

    // 运行时热更新：enabled 变化时创建/销毁运行时
    const runtime = this.runtimes.get(tenantId);
    if (config.enabled === false && runtime) {
      if (runtime.aggregationTimer) clearTimeout(runtime.aggregationTimer);
      // 禁用即清空待聚合信号：运行时即将销毁，残留信号只做内存驻留；
      // 重新启用时 buildRuntime 全新起步，旧信号既不会被聚合也不会被路由
      runtime.pendingSignals.length = 0;
      runtime.memory.dispose();
      this.runtimes.delete(tenantId);
    } else if (config.enabled !== false && !runtime) {
      this.runtimes.set(tenantId, this.buildRuntime(config));
    } else if (runtime) {
      runtime.config = config;
    }
  }

  /** 获取单个租户运行时 */
  getTenant(tenantId: string): TenantRuntime | undefined {
    return this.runtimes.get(tenantId);
  }

  /** 获取全部租户运行时 */
  getAllTenants(): TenantRuntime[] {
    return [...this.runtimes.values()];
  }

  /** 按标签检索租户 */
  getTenantsByTag(tag: string): TenantRuntime[] {
    return this.getAllTenants().filter((rt) => rt.config.tags?.includes(tag));
  }

  /**
   * 按文件路径匹配租户（路径规范化后做前缀比较）
   * @param filePath 文件或目录绝对路径
   * @returns workDir 最深匹配的租户运行时，无匹配返回 undefined
   */
  matchTenantByPath(filePath: string): TenantRuntime | undefined {
    const normalized = path.resolve(filePath);
    let best: TenantRuntime | undefined;
    let bestDepth = -1;
    for (const rt of this.runtimes.values()) {
      const workDir = path.resolve(rt.config.workDir);
      if (normalized === workDir || normalized.startsWith(workDir + path.sep)) {
        const depth = workDir.split(path.sep).length;
        if (depth > bestDepth) {
          bestDepth = depth;
          best = rt;
        }
      }
    }
    return best;
  }

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
  routeSignal(signal: { type: string; payload: Record<string, any> }): TenantRuntime | undefined {
    let best: TenantRuntime | undefined;
    let bestScore = 0;

    for (const rt of this.runtimes.values()) {
      let score = 0;

      // 1. 路径匹配：扫描 payload 中所有字符串值寻找路径线索
      const workDir = path.resolve(rt.config.workDir);
      for (const value of Object.values(signal.payload)) {
        if (typeof value === 'string' && (value.includes('/') || value.includes(path.sep))) {
          const resolved = path.resolve(value);
          if (resolved === workDir || resolved.startsWith(workDir + path.sep)) {
            score += 2 * workDir.split(path.sep).length;
            break;
          }
        }
      }

      // 2. 信号源类型命中
      const sources = rt.config.sentinel?.signalSources ?? [];
      if (sources.some((s) => s.signalType === signal.type)) {
        score += 3;
      }

      // 3. 标签命中
      if (rt.config.tags?.includes(signal.type)) {
        score += 1;
      }

      if (score > bestScore) {
        bestScore = score;
        best = rt;
      }
    }
    return best;
  }

  /** 刷新租户活跃时间 */
  touchTenant(tenantId: string): void {
    const config = this.registry.tenants.find((t) => t.id === tenantId);
    if (config) {
      config.lastActiveAt = Date.now();
      this.persistRegistry();
    }
  }

  /**
   * 全局统计（跨租户汇总，供 manage_tenants stats 使用）
   */
  getGlobalStats(): Record<string, any> {
    const tenants = this.getAllTenants();
    const sum = (fn: (rt: TenantRuntime) => number): number => tenants.reduce((s, rt) => s + fn(rt), 0);
    return {
      tenantCount: tenants.length,
      activeTenants: tenants.filter((rt) => rt.config.enabled !== false).length,
      executingTenants: tenants.filter((rt) => rt.isExecuting).length,
      totalExecutions: sum((rt) => rt.stats.totalExecutions),
      totalSuccesses: sum((rt) => rt.stats.totalSuccesses),
      totalFailures: sum((rt) => rt.stats.totalFailures),
      totalSignals: sum((rt) => rt.stats.totalSignals),
      totalTokensUsed: sum((rt) => rt.stats.totalTokensUsed),
      pendingSignals: sum((rt) => rt.pendingSignals.length),
      globalDefaults: { ...this.registry.globalDefaults },
    };
  }

  /** 释放全部运行时（进程退出前调用） */
  dispose(): void {
    for (const rt of this.runtimes.values()) {
      if (rt.aggregationTimer) clearTimeout(rt.aggregationTimer);
      rt.memory.dispose();
    }
    this.runtimes.clear();
  }

  // ─────────────── 第三轮：极大极小公平配额（44.0 口径自实现水填充） ───────────────

  /**
   * 登记资源总容量（配额分配的「池子」）。
   * @param resource 资源名（如 'llm-tokens' / 'api-calls'）
   * @param capacity 总容量（≥ 0；超卖与否由需求合计与容量的比较决定）
   */
  setResourceCapacity(resource: string, capacity: number): void {
    if (!resource || !Number.isFinite(capacity) || capacity < 0) {
      throw new ConfigError('资源容量非法（须为 ≥ 0 的有限值）');
    }
    const state = this.quotas.get(resource) ?? { capacity: 0, demands: new Map() };
    state.capacity = capacity;
    this.quotas.set(resource, state);
  }

  /**
   * 申报租户对某资源的需求（可多次申报，后申报覆盖）。
   * @param weight 权重（缺省取租户配置 quotaWeight，再缺省 1；等权即经典极大极小）
   * @throws ConfigError 租户不存在
   */
  declareQuotaDemand(tenantId: string, resource: string, demand: number, weight?: number): void {
    const runtime = this.runtimes.get(tenantId);
    if (!runtime) {
      throw new ConfigError(`租户不存在: ${tenantId}`);
    }
    if (!this.quotas.has(resource)) {
      throw new ConfigError(`资源未登记容量: ${resource}（先 setResourceCapacity）`);
    }
    if (!Number.isFinite(demand) || demand < 0) {
      throw new ConfigError('需求非法（须为 ≥ 0 的有限值）');
    }
    const w =
      weight ??
      runtime.config.quotaWeight ??
      1;
    this.quotas.get(resource)!.demands.set(tenantId, { demand, weight: Number.isFinite(w) && w > 0 ? w : 1 });
  }

  /**
   * 释放租户对某资源的需求申报，并立即重分配（其余租户自动受益）。
   * @returns 重分配结果；该资源从未分配过则返回 undefined
   */
  releaseQuotaDemand(tenantId: string, resource: string): QuotaAllocationResult | undefined {
    const state = this.quotas.get(resource);
    if (!state) return undefined;
    const had = state.demands.delete(tenantId);
    if (!had) return state.lastAllocation;
    return state.lastAllocation ? this.allocateQuotas(resource) : undefined;
  }

  /**
   * 执行极大极小公平分配（progressive filling 水填充，44.0 口径自实现）：
   * 各方份额按权重比例增长，需求到岸者退出，容量耗尽即停——
   * 词典序最优（先抬最穷者，再抬次穷者）。等权退化为经典 max-min。
   * @throws ConfigError 资源未登记
   */
  allocateQuotas(resource: string): QuotaAllocationResult {
    const state = this.quotas.get(resource);
    if (!state) {
      throw new ConfigError(`资源未登记: ${resource}`);
    }
    const tenantIds = [...state.demands.keys()].sort();
    const demands = tenantIds.map((id) => state.demands.get(id)!.demand);
    const weights = tenantIds.map((id) => state.demands.get(id)!.weight);
    const { shares, waterLevel, deficit } = this.maxMinWaterFill(demands, weights, state.capacity);
    const audit = this.quotaFairAudit(demands, weights, shares);
    const result: QuotaAllocationResult = {
      resource,
      capacity: state.capacity,
      waterLevel,
      deficit,
      fair: audit.fair,
      fairnessViolations: audit.violations,
      entries: tenantIds.map((id, i) => ({
        tenantId: id,
        demand: demands[i],
        weight: weights[i],
        allocated: shares[i],
        satisfaction: demands[i] > 0 ? shares[i] / demands[i] : 1,
      })),
      allocatedAt: Date.now(),
    };
    state.lastAllocation = result;
    return result;
  }

  /** 最近一次分配结果（未分配过 → undefined） */
  getQuotaAllocation(resource: string): QuotaAllocationResult | undefined {
    return this.quotas.get(resource)?.lastAllocation;
  }

  /** 单租户在某资源上的配额视图（无申报 → undefined） */
  getTenantQuota(tenantId: string, resource: string): QuotaAllocationEntry | undefined {
    return this.quotas.get(resource)?.lastAllocation?.entries.find((e) => e.tenantId === tenantId);
  }

  // ─────────────── 第三轮：吵闹邻居抑制（梯度限流 + 影响记账） ───────────────

  /**
   * 启用吵闹邻居抑制（opt-in；重复调用覆盖配置、保留记账状态）。
   * @throws ConfigError 配置非法（softFactor 须 ∈ (0, hardFactor]，hardFactor > softFactor）
   */
  configureNoisyNeighbor(config: NoisyNeighborConfig): void {
    if (
      !Number.isFinite(config.windowMs) ||
      config.windowMs <= 0 ||
      !Number.isFinite(config.softFactor) ||
      config.softFactor <= 0 ||
      !Number.isFinite(config.hardFactor) ||
      config.hardFactor <= config.softFactor ||
      !Number.isInteger(config.maxSoftStrikes) ||
      config.maxSoftStrikes < 1 ||
      !Number.isFinite(config.recoveryFactor) ||
      config.recoveryFactor <= 0
    ) {
      throw new ConfigError(
        '吵闹邻居配置非法（windowMs>0；0<softFactor<hardFactor；maxSoftStrikes≥1；recoveryFactor>0——滞回释放阈 softFactor×recoveryFactor 须为正有限值）',
      );
    }
    this.noisy = {
      config: { ...config },
      clock: config.clock ?? (() => Date.now()),
      state: this.noisy?.state ?? new Map(),
    };
  }

  /**
   * 记账式登记一次消费（不执法）：无论是否被限流都进入影响账本。
   * 未配置抑制时为无害空操作（返回 recorded=false）。
   */
  recordConsumption(tenantId: string, resource: string, amount: number, at?: number): { recorded: boolean } {
    if (!this.noisy || !Number.isFinite(amount) || amount <= 0) return { recorded: false };
    const now = at ?? this.noisy.clock();
    const st = this.noisyState(tenantId, resource);
    st.events.push({ at: now, amount });
    this.pruneEvents(st, now);
    return { recorded: true };
  }

  /**
   * 配额执法（纯判定 + 状态推进；不登记消费）：
   * - 未配置抑制 / 该租户无配额分配 → 恒放行（enforced=false，旧行为）
   * - 窗口比值 ≤ softFactor → normal（放行，软计数清零）
   * - softFactor < 比值 ≤ hardFactor → soft（放行 + 警告 + 软计数累积；
   *   连续软限制达 maxSoftStrikes → 升级硬限制）
   * - 比值 > hardFactor → hard（拒绝）
   * - 硬限制滞回：须回落到 ≤ softFactor × recoveryFactor 才解除（边界不抖动）
   */
  enforceQuota(tenantId: string, resource: string, at?: number): NoisyNeighborVerdict {
    if (!this.noisy) {
      return { allowed: true, level: 'normal', enforced: false, windowUsage: 0, quota: null, ratio: 0, softStrikes: 0 };
    }
    const cfg = this.noisy.config;
    const now = at ?? this.noisy.clock();
    const st = this.noisyState(tenantId, resource);
    this.pruneEvents(st, now);
    const entry = this.quotas.get(resource)?.lastAllocation?.entries.find((e) => e.tenantId === tenantId);
    if (!entry) {
      // 无配额分配（未申报需求或资源未分配）→ 不限流（无法定义「超配额」）
      return { allowed: true, level: 'normal', enforced: false, windowUsage: st.events.reduce((s, e) => s + e.amount, 0), quota: null, ratio: 0, softStrikes: st.softStrikes };
    }
    const quota = Math.max(entry.allocated, 1e-12);
    const windowUsage = st.events.reduce((s, e) => s + e.amount, 0);
    const ratio = windowUsage / quota;
    const excess = Math.max(0, windowUsage - entry.allocated);
    st.excessTotal += excess > 0 ? excess : 0;

    // 影响记账恒先行（无论裁决如何，挤占量入账）
    const base = { windowUsage, quota: entry.allocated, ratio, softStrikes: st.softStrikes, enforced: true };

    // 滞回：硬限制在途时，未回落到释放阈值以下不解除
    if (st.hardActive) {
      if (ratio <= cfg.softFactor * cfg.recoveryFactor) {
        st.hardActive = false;
        st.softStrikes = 0;
        st.level = 'normal';
      } else {
        st.suppressedEvents += 1;
        st.level = 'hard';
        return {
          ...base,
          allowed: false,
          level: 'hard',
          reason: `硬限制在途：窗口比值 ${ratio.toFixed(2)} > 释放阈值 ${(cfg.softFactor * cfg.recoveryFactor).toFixed(2)}（滞回）`,
        };
      }
    }

    if (ratio > cfg.hardFactor) {
      st.hardActive = true;
      st.level = 'hard';
      st.suppressedEvents += 1;
      return {
        ...base,
        allowed: false,
        level: 'hard',
        escalatedBy: 'ratio',
        reason: `硬限制：窗口用量 ${windowUsage.toFixed(1)} > 配额 ${entry.allocated.toFixed(1)} × ${cfg.hardFactor}`,
      };
    }
    if (ratio > cfg.softFactor) {
      st.softStrikes += 1;
      if (st.softStrikes >= cfg.maxSoftStrikes) {
        st.hardActive = true;
        st.level = 'hard';
        st.suppressedEvents += 1;
        return {
          ...base,
          allowed: false,
          level: 'hard',
          escalatedBy: 'strikes',
          reason: `硬限制：连续软限制 ${st.softStrikes} 次达上限 ${cfg.maxSoftStrikes}（梯度升级）`,
        };
      }
      st.warnedEvents += 1;
      st.level = 'soft';
      return {
        ...base,
        allowed: true,
        level: 'soft',
        softStrikes: st.softStrikes,
        warning: `软限制警告：窗口比值 ${ratio.toFixed(2)} > ${cfg.softFactor}（第 ${st.softStrikes}/${cfg.maxSoftStrikes} 次）`,
      };
    }
    st.softStrikes = 0;
    st.level = 'normal';
    return { ...base, allowed: true, level: 'normal', softStrikes: 0 };
  }

  /**
   * 消费 + 执法一体化：先执法，放行才入账（被拒消费不占用窗口，
   * 但计入 suppressedEvents 影响账本）。
   */
  consumeQuota(tenantId: string, resource: string, amount: number, at?: number): NoisyNeighborVerdict {
    const verdict = this.enforceQuota(tenantId, resource, at);
    if (verdict.allowed && amount > 0) {
      this.recordConsumption(tenantId, resource, amount, at);
    }
    return verdict;
  }

  /** 吵闹邻居影响账本（未配置 → undefined 诚实降级） */
  noisyNeighborView(): NoisyNeighborEntry[] | undefined {
    if (!this.noisy) return undefined;
    const entries: NoisyNeighborEntry[] = [];
    for (const [key, st] of this.noisy.state) {
      const [tenantId, resource] = key.split('\u0000');
      const entry = this.quotas.get(resource)?.lastAllocation?.entries.find((e) => e.tenantId === tenantId);
      const windowUsage = st.events.reduce((s, e) => s + e.amount, 0);
      entries.push({
        tenantId,
        resource,
        level: st.level,
        windowUsage,
        quota: entry ? entry.allocated : null,
        ratio: entry && entry.allocated > 0 ? windowUsage / entry.allocated : 0,
        softStrikes: st.softStrikes,
        warnedEvents: st.warnedEvents,
        suppressedEvents: st.suppressedEvents,
        excessTotal: st.excessTotal,
      });
    }
    return entries.sort((a, b) => (a.tenantId + a.resource).localeCompare(b.tenantId + b.resource));
  }

  // ─────────────── 第四轮：配额预测性调整（EWMA + 斜率外推） ───────────────

  /**
   * 启用配额预测（opt-in；重复调用覆盖配置、保留观测序列）。
   * @throws ConfigError 配置非法（α∈(0,1]、intervalMs>0、slopeWindow≥2 整数、
   *         horizonMs>0、warnFactor>0、headroom∈(0,1]）
   */
  configureQuotaForecast(config: QuotaForecastConfig): void {
    if (
      !Number.isFinite(config.alpha) ||
      config.alpha <= 0 ||
      config.alpha > 1 ||
      !Number.isFinite(config.intervalMs) ||
      config.intervalMs <= 0 ||
      !Number.isInteger(config.slopeWindow) ||
      config.slopeWindow < 2 ||
      !Number.isFinite(config.horizonMs) ||
      config.horizonMs <= 0 ||
      !Number.isFinite(config.warnFactor) ||
      config.warnFactor <= 0 ||
      (config.headroom !== undefined && (!Number.isFinite(config.headroom) || config.headroom <= 0 || config.headroom > 1))
    ) {
      throw new ConfigError(
        '配额预测配置非法（α∈(0,1]；intervalMs>0；slopeWindow≥2 整数；horizonMs>0；warnFactor>0；headroom∈(0,1]）',
      );
    }
    this.forecastCfg = {
      config: { ...config },
      clock: config.clock ?? (() => Date.now()),
      series: this.forecastCfg?.series ?? new Map(),
    };
  }

  /**
   * 记录一次用量观测（按桶聚合；预测的原料）。未配置预测时为无害空操作。
   * @param amount 本笔用量（> 0 有限值）
   * @param at 观测时刻（缺省注入时钟当前值）
   */
  observeUsage(tenantId: string, resource: string, amount: number, at?: number): { recorded: boolean } {
    if (!this.forecastCfg || !Number.isFinite(amount) || amount <= 0) return { recorded: false };
    const now = at ?? this.forecastCfg.clock();
    const index = Math.floor(now / this.forecastCfg.config.intervalMs);
    const key = `${tenantId}\u0000${resource}`;
    let series = this.forecastCfg.series.get(key);
    if (!series) {
      series = { buckets: new Map(), observations: 0 };
      this.forecastCfg.series.set(key, series);
    }
    series.buckets.set(index, (series.buckets.get(index) ?? 0) + amount);
    series.observations += 1;
    // 桶序列滚动截断：forecastQuota 只读最近 slopeWindow 个桶（缺桶按 0），
    // 更早的桶是无界累积的死数据（intervalMs 较小时每天可新增数万条）——
    // 保留 latest-(slopeWindow+8) 之后的桶：比窗口多 8 桶余量，读数逐位不变
    const latest = Math.max(index, ...series.buckets.keys());
    const cutoff = latest - (this.forecastCfg.config.slopeWindow + 8);
    if (cutoff > 0) {
      for (const k of series.buckets.keys()) {
        if (k < cutoff) series.buckets.delete(k);
      }
    }
    return { recorded: true };
  }

  /**
   * 外推租户在某资源上的用量趋势（EWMA 水平 + 最小二乘斜率）：
   * - 预警 willExceed：当前水平未超配额、但外推 horizonMs 后将达
   *   warnFactor × 配额 —— 在真正超限之前的提前量；
   * - timeToBreachMs：按当前斜率解出的越限时刻（斜率 ≤ 0 → null）；
   * - 扩容建议：预警时给 ⌈预测峰值 / headroom⌉ 与相对当前容量的增量。
   * @returns 预测读数；未配置预测或无观测 → undefined
   */
  forecastQuota(tenantId: string, resource: string): QuotaForecast | undefined {
    if (!this.forecastCfg) return undefined;
    const series = this.forecastCfg.series.get(`${tenantId}\u0000${resource}`);
    if (!series || series.buckets.size === 0) return undefined;
    const cfg = this.forecastCfg.config;
    const now = this.forecastCfg.clock();

    // 对齐斜率窗：最近 K 个桶（缺桶按 0 计——稀疏流的时间真相）
    const latest = Math.max(...series.buckets.keys());
    const K = cfg.slopeWindow;
    const window: number[] = [];
    for (let i = K - 1; i >= 0; i -= 1) window.push(series.buckets.get(latest - i) ?? 0);

    // EWMA 水平（时间顺序折叠）
    let level = window[0]!;
    for (let i = 1; i < window.length; i += 1) level = cfg.alpha * window[i]! + (1 - cfg.alpha) * level;

    // 最小二乘斜率（x = 桶序 0..K-1）
    const meanI = (K - 1) / 2;
    const meanX = window.reduce((s, v) => s + v, 0) / K;
    let num = 0;
    let den = 0;
    for (let i = 0; i < K; i += 1) {
      num += (i - meanI) * (window[i]! - meanX);
      den += (i - meanI) * (i - meanI);
    }
    const slope = den > 0 ? num / den : 0;

    const h = cfg.horizonMs / cfg.intervalMs;
    const projectedUsage = Math.max(0, level + slope * h);
    const entry = this.quotas.get(resource)?.lastAllocation?.entries.find((e) => e.tenantId === tenantId);
    const quota = entry ? entry.allocated : null;
    const projectedRatio = quota !== null && quota > 0 ? projectedUsage / quota : 0;
    const alreadyOver = quota !== null && level >= quota;
    const willExceed = quota !== null && !alreadyOver && projectedRatio >= cfg.warnFactor;

    let timeToBreachMs: number | null = null;
    if (quota !== null) {
      if (alreadyOver) timeToBreachMs = 0;
      else if (slope > 0 && level < quota) timeToBreachMs = ((quota - level) / slope) * cfg.intervalMs;
    }

    let recommendedCapacity: number | null = null;
    let recommendedAddition = 0;
    if (willExceed && projectedUsage > 0) {
      const headroom = cfg.headroom ?? 0.7;
      recommendedCapacity = Math.ceil(projectedUsage / headroom);
      recommendedAddition = Math.max(0, recommendedCapacity - (this.quotas.get(resource)?.capacity ?? 0));
    }

    return {
      tenantId,
      resource,
      samples: series.observations,
      level,
      slope,
      projectedUsage,
      quota,
      projectedRatio,
      alreadyOver,
      willExceed,
      timeToBreachMs,
      breachAt: timeToBreachMs !== null ? now + timeToBreachMs : null,
      recommendedCapacity,
      recommendedAddition,
      forecastAt: now,
    };
  }

  /** 全部预测读数（按 tenantId+resource 字典序；未配置 → undefined） */
  forecastAll(): QuotaForecast[] | undefined {
    if (!this.forecastCfg) return undefined;
    const out: QuotaForecast[] = [];
    for (const key of this.forecastCfg.series.keys()) {
      const [tenantId, resource] = key.split('\u0000');
      const f = this.forecastQuota(tenantId, resource);
      if (f) out.push(f);
    }
    return out.sort((a, b) => (a.tenantId + a.resource).localeCompare(b.tenantId + b.resource));
  }

  // ─────────────── 第四轮：审计合规导出（确定性字段序 + SHA-256 摘要） ───────────────

  /**
   * 导出合规报告：租户资源使用（配额满足率）+ 公平性核验（水填充分配的
   * 公平支配性审计）+ 安全事件摘要（可选治理器数据源）。
   *
   * 确定性口径：字段序由构造固定、全部数组按稳定键排序、时间取 asOf
   * （注入时钟口径）——同状态两次导出逐位一致；digest 为正文（除 digest
   * 外）的 SHA-256 hex，可独立复核。
   */
  exportComplianceReport(options?: { governor?: ComplianceGovernorSource; asOf?: number }): ComplianceReport {
    const asOf = options?.asOf ?? Date.now();
    const runtimes = this.getAllTenants().sort((a, b) => a.config.id.localeCompare(b.config.id));
    const noisyByTenant = new Map<string, { level: string; warnedEvents: number; suppressedEvents: number; excessTotal: number }>();
    for (const e of this.noisyNeighborView() ?? []) {
      const cur = noisyByTenant.get(e.tenantId) ?? { level: 'normal', warnedEvents: 0, suppressedEvents: 0, excessTotal: 0 };
      cur.warnedEvents += e.warnedEvents;
      cur.suppressedEvents += e.suppressedEvents;
      cur.excessTotal += e.excessTotal;
      const rank = { normal: 0, soft: 1, hard: 2 } as const;
      if (rank[e.level] > rank[cur.level as keyof typeof rank]) cur.level = e.level;
      noisyByTenant.set(e.tenantId, cur);
    }

    const tenants: ComplianceReport['tenants'] = runtimes.map((rt) => ({
      tenantId: rt.config.id,
      name: rt.config.name,
      enabled: rt.config.enabled !== false,
      tags: [...(rt.config.tags ?? [])].sort(),
      quotas: [...this.quotas.entries()]
        .filter(([, state]) => state.lastAllocation)
        .flatMap(([resource, state]) => {
          const e = state.lastAllocation!.entries.find((x) => x.tenantId === rt.config.id);
          return e ? [{ resource, demand: e.demand, weight: e.weight, allocated: e.allocated, satisfaction: e.satisfaction }] : [];
        })
        .sort((a, b) => a.resource.localeCompare(b.resource)),
      noisyNeighbor: noisyByTenant.get(rt.config.id) ?? null,
    }));

    const fairness: ComplianceReport['fairness'] = [...this.quotas.entries()]
      .filter(([, state]) => state.lastAllocation)
      .map(([resource, state]) => {
        const a = state.lastAllocation!;
        return {
          resource,
          capacity: a.capacity,
          allocatedTotal: a.entries.reduce((s, e) => s + e.allocated, 0),
          deficit: a.deficit,
          waterLevel: a.waterLevel,
          fair: a.fair,
          fairnessViolations: a.fairnessViolations,
          allocatedAt: a.allocatedAt,
        };
      })
      .sort((a, b) => a.resource.localeCompare(b.resource));

    const forecast: ComplianceReport['forecast'] = (this.forecastAll() ?? []).map((f) => ({
      tenantId: f.tenantId,
      resource: f.resource,
      level: f.level,
      slope: f.slope,
      projectedUsage: f.projectedUsage,
      projectedRatio: f.projectedRatio,
      willExceed: f.willExceed,
      timeToBreachMs: f.timeToBreachMs,
      recommendedCapacity: f.recommendedCapacity,
      recommendedAddition: f.recommendedAddition,
    }));

    const body = {
      reportType: 'dsh-compliance' as const,
      schemaVersion: 1 as const,
      generatedAt: asOf,
      scope: { tenants: tenants.length, resources: fairness.length },
      tenants,
      fairness,
      forecast,
      security: options?.governor ? options.governor.securitySummary() : null,
    };
    const digest = crypto.createHash('sha256').update(JSON.stringify(body), 'utf-8').digest('hex');
    return { ...body, digest };
  }

  /**
   * 报告的规范化序列化（JSON.stringify 固定字段序——构造序即字段序；
   * 同状态两次导出逐位一致的直接口径）。
   */
  serializeComplianceReport(report: ComplianceReport): string {
    return JSON.stringify(report);
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 加载注册表（不存在时初始化；检测到加密结构时先解密再校验） */
  private loadRegistry(): TenantRegistry {
    if (!fs.existsSync(this.registryPath)) {
      return { version: 1, tenants: [], globalDefaults: { ...DEFAULT_GLOBALS } };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      // 读回时检测到字段级加密结构（__encrypted 标记）→ 先解密再走原校验；
      // cryptoEngine 缺失时不做解密（向后兼容：旧明文注册表照常加载）
      const data =
        this.cryptoEngine && CryptoEngine.hasEncryptedFields(raw)
          ? this.cryptoEngine.decryptSensitiveFields(raw).result
          : raw;
      if (!Array.isArray(data.tenants)) {
        throw new Error('注册表结构非法：缺少 tenants 数组');
      }
      return {
        version: data.version ?? 1,
        tenants: data.tenants,
        globalDefaults: { ...DEFAULT_GLOBALS, ...data.globalDefaults },
      };
    } catch (err) {
      throw new ConfigError(`租户注册表加载失败: ${this.registryPath}`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 持久化注册表（原子写入；apiKey 经字段级加密后落盘，不再明文存储） */
  private persistRegistry(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.registryPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.encryptRegistryForDisk(), null, 2), 'utf-8');
    fs.renameSync(tmp, this.registryPath);
  }

  /**
   * 生成落盘载荷：存在加密引擎时对注册表做字段级加密（apiKey 等敏感
   * 字段封为 __encrypted 结构）；加密失败降级为明文写并在 stderr 警告
   * （租户持久化是关键路径，不允许因加密故障整体失败）。
   */
  private encryptRegistryForDisk(): TenantRegistry {
    if (!this.cryptoEngine) return this.registry;
    try {
      // 主路径：引擎的敏感字段加密（实例 sensitiveFields 通常已含 apiKey）
      const { result } = this.cryptoEngine.encryptSensitiveFields(this.registry);
      // 兜底路径：引擎 sensitiveFields 未覆盖 apiKey 时，手动补封剩余明文字段
      return this.sealRemainingApiKeys(result) as TenantRegistry;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[tenant-manager] 警告: 注册表字段加密失败，降级为明文写入: ${message}\n`);
      return this.registry;
    }
  }

  /**
   * 兜底封印：深扫载荷中仍是明文字符串的 apiKey 字段（引擎的
   * sensitiveFields 配置可能不含 apiKey），逐个用引擎的整段加密原语
   * 封为与 EncryptedField 同构的结构（__encrypted 标记 + keyVersion），
   * 读回路径 decryptSensitiveFields 可统一解密。不修改原对象。
   */
  private sealRemainingApiKeys(node: unknown): unknown {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((item) => this.sealRemainingApiKeys(item));
    if ((node as { __encrypted?: boolean }).__encrypted === true) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'apiKey' && typeof value === 'string' && value.length > 0) {
        const sealed = this.cryptoEngine!.encryptFile(value);
        out[key] = {
          __encrypted: true,
          algorithm: sealed.algorithm,
          iv: sealed.iv,
          tag: sealed.tag,
          ciphertext: sealed.ciphertext,
          keyVersion: sealed.keyVersion,
        } satisfies EncryptedField;
      } else {
        out[key] = this.sealRemainingApiKeys(value);
      }
    }
    return out;
  }

  /** 解析租户记忆库路径 */
  private resolveMemoryPath(config: TenantConfig): string {
    if (config.memoryPath) {
      return path.isAbsolute(config.memoryPath)
        ? config.memoryPath
        : path.join(this.dataDir, config.id, config.memoryPath);
    }
    return path.join(this.dataDir, config.id, 'memory.json');
  }

  /** 构建租户运行时 */
  private buildRuntime(config: TenantConfig): TenantRuntime {
    const memoryPath = this.resolveMemoryPath(config);
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    return {
      config,
      memory: new LongTermMemory(memoryPath, this.cryptoEngine),
      activeExecutions: 0,
      pendingSignals: [],
      isExecuting: false,
      modelProfiles: new Map(),
      aggregationTimer: null,
      stats: {
        totalExecutions: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        totalSignals: 0,
        totalTokensUsed: 0,
      },
    };
  }

  // ─────────────── 第三轮内部实现：水填充 + 公平审计 + 滚动窗口 ───────────────

  /** 注水容差（浮点累积误差吸收） */
  private static readonly WATER_EPS = 1e-12;

  /**
   * 极大极小公平水填充（progressive filling，44.0 口径自实现）：
   * 各活跃方份额按权重比例增长，最先到岸（demand/weight 最小）者退出，
   * 容量耗尽即按剩余量等比截断。等权退化为经典 max-min
   * （需求低于水位者拿满，超额者在剩余容量中均摊）。
   */
  private maxMinWaterFill(
    demands: number[],
    weights: number[],
    capacity: number,
  ): { shares: number[]; waterLevel: number; deficit: number } {
    const n = demands.length;
    const shares = new Array<number>(n).fill(0);
    const remaining = demands.map((d) => Math.max(0, d));
    const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 1));
    const EPS = TenantManager.WATER_EPS;
    const active = new Set<number>(remaining.map((r, i) => (r > EPS ? i : -1)).filter((i) => i >= 0));
    let left = Math.max(0, capacity);
    while (active.size > 0 && left > EPS) {
      const wSum = [...active].reduce((s, i) => s + w[i], 0);
      // 最先到岸时间（需求 / 权重比最小者）
      let timeToFill = Infinity;
      for (const i of active) timeToFill = Math.min(timeToFill, remaining[i] / w[i]);
      const totalFill = timeToFill * wSum;
      if (totalFill <= left + EPS) {
        for (const i of active) {
          const fill = timeToFill * w[i];
          shares[i] += fill;
          remaining[i] -= fill;
          left -= fill;
          if (remaining[i] <= EPS) {
            remaining[i] = 0;
            active.delete(i);
          }
        }
      } else {
        const scale = left / wSum;
        for (const i of active) shares[i] += scale * w[i];
        left = 0;
      }
    }
    const deficit = remaining.reduce((a, b) => a + Math.max(0, b), 0);
    return { shares, waterLevel: n > 0 ? Math.max(...shares) : 0, deficit };
  }

  /**
   * 公平支配性审计（44.0 定义性检查，自实现）：
   * ∀i: x_i < demand_i（未拿满）⟹ ∃j≠i: x_j/w_j ≤ x_i/w_i 且 x_j > 0
   * —— i 的任何增长必挤占一个相对份额不高于自己的持有者。
   */
  private quotaFairAudit(
    demands: number[],
    weights: number[],
    shares: number[],
  ): { fair: boolean; violations: number } {
    let violations = 0;
    for (let i = 0; i < demands.length; i += 1) {
      if (shares[i] >= demands[i] - 1e-9) continue;
      const relI = shares[i] / weights[i];
      const hasBlocker = shares.some(
        (s, j) => j !== i && s > 1e-9 && s / weights[j] <= relI + 1e-9,
      );
      if (!hasBlocker) violations += 1;
    }
    return { fair: violations === 0, violations };
  }

  /** 吵闹邻居状态按（租户 × 资源）懒初始化 */
  private noisyState(tenantId: string, resource: string): NoisyNeighborState {
    const key = `${tenantId}\u0000${resource}`;
    let st = this.noisy!.state.get(key);
    if (!st) {
      st = { events: [], softStrikes: 0, hardActive: false, level: 'normal', warnedEvents: 0, suppressedEvents: 0, excessTotal: 0 };
      this.noisy!.state.set(key, st);
    }
    return st;
  }

  /** 滚动窗口裁剪（保留 (now - windowMs, now]） */
  private pruneEvents(st: NoisyNeighborState, now: number): void {
    const windowMs = this.noisy!.config.windowMs;
    while (st.events.length > 0 && now - st.events[0].at >= windowMs) {
      st.events.shift();
    }
  }
}
