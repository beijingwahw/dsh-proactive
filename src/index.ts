/**
 * index.ts — dsh-proactive 核心插件入口（集成层）
 *
 * 职责：整合全部 9 个模块，编排"信号 → 决策 → 执行 → 沉淀"10 步链路
 *
 * 10 步链路（新架构单向数据流：记忆库 → 优化器 → 模型调度/任务执行 → 反思器 → 记忆更新）：
 * 1. 信号接入（Sentinel：webhook / 文件监听 / 轮询 / 手动注入）
 * 2. 信号聚合（Sentinel 聚合窗口去重合并）
 * 3. 优先级排序（strategist 模型紧急度评估，urgency 降序）
 * 4. 战略决策（execute / defer / dismiss / ask-user）
 * 5. 经验检索（Optimizer.lookupExperience → 记忆库模糊匹配 + 推荐模型）
 * 6. 计划生成（Optimizer.recallPlan 快路径 / TaskExecutor.buildPlan：strategist DAG + 离线兜底）
 * 7. 并行执行（TaskExecutor.executePlan：拓扑分层并行，ModelScheduler 推荐模型参与调度）
 * 8. 质量反思（quality < threshold 自动重试 / 切换模型）
 * 9. 级联触发（节点完成触发下游信号，回注 Sentinel）
 * 10. 反思与记忆更新（Reflector.reflectOnOutcome：沉淀 + 策略反馈 + 蒸馏 + 同步变更登记）
 *
 * 14 个 Tool 通过 ToolRegistry 服务注册并经 ctx.provide('schedulerTools') 暴露。
 * 自主智能层（目标引擎 / 元认知 / 策略进化 / 心跳循环）使系统在无外部信号时
 * 也能自我观察、自我改进、自我进化。
 * 全部资源在 fiber 卸载时按依赖逆序清理（cleanup）。
 *
 * 第四轮 R4-A17：① 第三/四轮模块域升级经 autonomy.modules.* 16 旗标接入
 * 插件运行时（缺省全关——关 = 零挂载零注入，行为与升级前逐位一致）；② 主链
 * 路深化三件套（跨步骤缓存 / 降级阶梯 / 步骤预取）经 autonomy.pipeline.* 旗标
 * 缺省关闭接入（introspect 导出 moduleFlags 总览与 pipelineDeepening 读数）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';

import { AppError, ConfigError } from './errors.js';
import { CryptoEngine, type EncryptionConfig } from './security/crypto-engine.js';
import { LongTermMemory } from './memory/long-term-memory.js';
import { MemoryGraph } from './memory/memory-graph.js';
import { AliasMap } from './memory/alias-map.js';
import { MigrationTool } from './memory/migration-tool.js';
import { ProgressBroadcaster } from './progress-ws.js';
import { TenantManager } from './tenant/tenant-manager.js';
import { BenchmarkEngine } from './benchmark/benchmark-engine.js';
import { DistributedSync, type SyncNodeConfig } from './sync/distributed-sync.js';
import { RaftEngine, type ConsensusLogEntry } from './consensus/raft-engine.js';
import { HotReloadEngine, type HotReloadConfig } from './hot-reload/hot-reload-engine.js';
import { LLMClient, type ModelConfig } from './llm-client.js';
import { Sentinel, type Signal, type SignalBatch } from './sentinel.js';
import { ModelScheduler } from './model-scheduler.js';
import { TaskExecutor } from './task-executor.js';
import type { NodeRunner, PlanExecutionResult, ExecutionPlan } from './types.js';
import { Optimizer } from './optimizer.js';
import { Reflector } from './reflector.js';
import { attachDashboard } from './dashboard/index.js';
import { DecisionEngine, type Decision, type SignalHistoryStats } from './decision-engine.js';
import { ReflectionEngine } from './reflection-engine.js';
import { GoalEngine, type Goal, type GoalSubtask, type Insight } from './goal-engine.js';
import { MetaCognitionEngine, type TuningAction } from './meta-cognition.js';
import { StrategyEvolutionEngine } from './strategy-evolution.js';
import { AutonomyLoop } from './autonomy-loop.js';
import { PolicyEvolver } from './policy/policy-evolver.js';
import { Sandbox, buildCalibrationFromMemory, extractReplayTasks, generateAdversarialTasks } from './policy/sandbox.js';
import { SelfModel } from './meta/self-model.js';
import { MetaCognitiveController } from './meta/meta-controller.js';
import type { SimModelStatus } from './policy/policy-types.js';
import { WorldModel } from './world-model.js';
import { CausalKernel } from './core/causal-kernel.js';
import { FreeEnergyEngine } from './core/free-energy.js';
import { DeliberationEngine } from './core/deliberation.js';
import { RationalMetareasoner } from './core/metareasoning.js';
import { AbstractionEngine } from './core/abstraction.js';
import { ScientistMind } from './core/scientist.js';
import { TheoristEngine } from './core/theorist.js';
import { ConformalIntervalEngine } from './core/conformal.js';
import { CellularSheaf } from './core/sheaf-consensus.js';
import { GittinsIndexTable, IndexScheduler } from './core/index-scheduling.js';
import { BwKRouter } from './core/bandit-knapsack.js';
import { PrivacyAccountant, perturbNumbers } from './core/differential-privacy.js';
import { CapacityPlanner, type CapacityPlan } from './core/capacity-planning.js';
import { TailRiskMonitor, type TailRiskReport } from './core/extreme-value.js';
import { SystemicRiskMonitor, type SystemicRiskAssessment } from './core/random-matrix.js';
import { tandemNetwork, bottleneckInsight } from './core/queueing-network.js';
import { renderSankeyHtml } from './symbiosis/observability.js';
import { CuriosityEngine, type ExplorationProposal } from './curiosity-engine.js';
import { SafetyGovernor } from './safety-governor.js';
import { SymbiosisBridge } from './symbiosis/bridge.js';
import { PlasticityLoop } from './plasticity/loop.js';
import { Consolidator } from './plasticity/consolidation.js';
import { ProbeOperations } from './plasticity/probes-ops.js';
import { auditConstitution } from './plasticity/constitution.js';
import { HostFusionLayer } from './host-fusion.js';
import { resolveHostLLM, resolveHostModels, resolveHeaderProvider, resolveLocalKeyProvider, describeKeySources, KeyHealthManager } from './dsh-host.js';
// 第四轮 R4-A17：模块域升级接线适配层（autonomy.modules.* 旗标 → attach / 构造配置片段）
import {
  attachPostConstructModuleUpgrades,
  clientModuleUpgradeConfig,
  cryptoModuleUpgradeConfig,
  metaStabilityUpgradeConfig,
  moduleFlagOverview,
  sentinelModuleUpgradeConfig,
  symbiosisMonetaryUpgradeConfig,
  type ModuleUpgradeFlags,
} from './engines-frontier/autonomy25.js';

// ─────────────────────────── 插件配置类型 ───────────────────────────

/** 插件配置（对应 cordis.patch.yml config 节） */
export interface SchedulerConfig {
  /** 可选：DSH 宿主经 ctx 提供模型时无需配置；apiKey 亦可省略（宿主注入请求头） */
  strategistModel?: { id: string; endpoint: string; apiKey?: string };
  /** 可选：宿主未提供模型目录时的兜底配置 */
  models?: ModelConfig[];
  sentinel: {
    watchCodeChanges: boolean;
    watchErrors: boolean;
    watchPerformance: boolean;
    /** 聚合窗口（秒） */
    aggregationWindow: number;
    signalSources?: Array<{ type: 'webhook' | 'polling' | 'filesystem'; port?: number; interval?: number; url?: string; path?: string; signalType: string }>;
  };
  qualityThreshold: number;
  maxRetries: number;
  globalTimeout: number;
  enableProgress: boolean;
  progressPort: number;
  verbose: boolean;
  experienceStorePath: string;
  encryption: { enabled: boolean; masterKey?: string; algorithm: 'aes-256-gcm' | 'aes-256-cbc'; fullFileEncryption: boolean };
  sync: { localNodeId: string; peers: SyncNodeConfig[] };
  consensus: {
    enabled: boolean;
    localNodeId: string;
    consensusPort: number;
    electionTimeoutMin: number;
    electionTimeoutMax: number;
    heartbeatInterval: number;
    cluster: Array<{ nodeId: string; address: string; port: number; priority?: number }>;
  };
  hotReload: Partial<HotReloadConfig> & { enabled: boolean };
  tenants: Array<any>;
  /** 运行时数据根目录（默认 .scheduler） */
  dataDir?: string;
  /** 经验快路径阈值：命中模式置信度 ≥ 该值时直接复用历史成功计划（缺省 0.9；设 >1 关闭） */
  memoryFastPathThreshold?: number;
  /** LLM 客户端选项覆盖（测试注入 fetchImpl 等） */
  llm?: { fetchImpl?: typeof fetch; timeout?: number };
  /** 执行器节点执行器注入（测试离线模拟） */
  nodeRunner?: NodeRunner;
  /** 决策引擎配置覆盖（闭环深度优化） */
  decision?: Partial<import('./decision-engine.js').DecisionEngineConfig>;
  /** 反思引擎配置覆盖（闭环深度优化） */
  reflection?: Partial<import('./reflection-engine.js').ReflectionEngineConfig>;
  /** 评审模型注入（LLM-as-judge，测试离线模拟） */
  judge?: import('./reflection-engine.js').JudgeModel;
  /** 教训提取器注入（测试离线模拟） */
  lessonExtractor?: import('./reflection-engine.js').LessonExtractor;
  /** 自主智能配置（目标引擎 / 元认知 / 策略进化 / 心跳循环 / 世界模型 / 好奇心 / 安全治理） */
  autonomy?: {
    /** 是否启用自主心跳循环（缺省 true） */
    enabled?: boolean;
    /** 心跳间隔（毫秒，缺省 30000） */
    heartbeatMs?: number;
    /**
     * 新臂入场探索（调度器 UCB 旋钮透传）。sampleFloor：每模型×任务
     * 类型积累 N 样本前保持探索加成——中龄系统引入新模型时，冷启动
     * 限定 UCB（总预算 30）给不出首发流量（桶内对照是 τ2 结构固化
     * 的数据前提）。缺省关闭（沿用冷启动口径，零漂移）。
     */
    exploration?: {
      enabled?: boolean;
      sampleFloor?: number;
      budget?: number;
      bonus?: number;
      /** G4 推荐反垄断：放弃历史推荐交动态选型的概率（0~1，缺省 0 零漂移） */
      overrideRate?: number;
    };
    /**
     * 创世纪 G4 · 快路径反垄断：reuseModels = false 时快路径只复用
     * 计划结构、解钉历史模型指派（执行期重新选型——新臂获得入场
     * 流量，桶内对照恢复供给）。缺省 true（旧行为零漂移）。
     */
    fastPath?: {
      reuseModels?: boolean;
    };
    /** 目标引擎配置覆盖 */
    goal?: Partial<import('./goal-engine.js').GoalEngineConfig>;
    /** 元认知配置覆盖 */
    metaCognition?: Partial<import('./meta-cognition.js').MetaCognitionConfig>;
    /** 策略进化配置覆盖 */
    evolution?: Partial<import('./strategy-evolution.js').StrategyEvolutionConfig>;
    /**
     * 第三阶段：调度策略进化（PolicyEvolver + Sandbox）配置覆盖。
     * 设为 { enabled: false } 可完全关闭；沙盒离线评估，不阻塞操作环调度。
     */
    policyEvolution?: Partial<import('./policy/policy-evolver.js').PolicyEvolverConfig> & {
      enabled?: boolean;
      /** 沙盒评估配置覆盖 */
      sandbox?: Partial<import('./policy/sandbox.js').SandboxConfig>;
    };
    /**
     * 第四阶段：元认知层（SelfModel + MetaCognitiveController）配置覆盖。
     * 设为 { enabled: false } 可完全关闭外环；心智报告与审计日志落盘 dataDir。
     */
    metaLayer?: {
      enabled?: boolean;
      /** 自我建模配置覆盖 */
      selfModel?: Partial<import('./meta/self-model.js').SelfModelConfig>;
      /** 元认知控制器配置覆盖 */
      controller?: Partial<import('./meta/meta-controller.js').MetaControllerConfig>;
    };
    /** 心跳循环配置覆盖 */
    loop?: Partial<import('./autonomy-loop.js').AutonomyLoopConfig>;
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
       * E 路线：τ1 可塑性学习闭环（缺省关闭；须同时 symbiosis.enabled = true）。
       * 启用后每次任务结算（成败 + 逐节点真值）喂给三内核的参数级在线
       * 学习（Beta 后验 / 门控校准 / 预算赌徒路由）；学习状态原子落盘，
       * 每窗口自动遗忘门控（冻结探针对数损失退化即回滚本窗口）。
       * 纯影子学习：不改变任何铸币/分红/信誉数值。
       */
      plasticity?: {
        /** 是否启用（缺省 false；须同时 symbiosis.enabled = true） */
        enabled?: boolean;
        /** 学习状态持久化路径（如 .scheduler/plasticity.json；不设则内存态） */
        persistPath?: string;
        /** 每多少事件执行一轮遗忘门控（缺省 50） */
        gateWindow?: number;
        /** 每轮冻结的探针数（缺省 50） */
        probeSize?: number;
        /** 探针采样种子（门控决策可复现；缺省 0x9e3779b9） */
        seed?: number;
        /** τ2 固化：规则档案持久化路径（如 .scheduler/plasticity-rules.json） */
        rulesPath?: string;
        /** τ2 固化：每多少结算事件尝试一轮固化（缺省 200） */
        consolidateEvery?: number;
        /**
         * 创世纪 G3 · 探针操作（缺省关闭）：检测对照市场流动性枯竭
         * （饿死/陈旧臂），预算限定内注入真实微任务。探针是真实模型
         * 调用（~10-50 token/条），绝非伪造结算。
         */
        probes?: {
          /** 是否启用（缺省 false） */
          enabled?: boolean;
          /** 滚动每小时最多注入条数（缺省 6——央行预算） */
          maxPerHour?: number;
        };
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
    worldModel?: Partial<import('./world-model.js').WorldModelConfig>;
    /** 好奇心引擎配置覆盖 */
    curiosity?: Partial<import('./curiosity-engine.js').CuriosityEngineConfig>;
    /** 安全治理器配置覆盖 */
    governor?: Partial<import('./safety-governor.js').SafetyGovernorConfig>;
    /** 5.0：因果内核配置覆盖（do-干预登记 + Shapley 分红 + 反事实查询） */
    causalKernel?: Partial<import('./core/causal-kernel.js').CausalKernelConfig>;
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
      specs?: import('./core/runtime-verification.js').SafetySpec[];
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
    /**
     * 创世纪升级（51.0→75.0）：五大新层 25 个内核的统一开关命名空间。
     * 全部缺省关闭（false / 不挂载）——打开才挂载，关闭时引擎行为与
     * 升级前逐位一致（零漂移是本仓库的宪法）。旗标名与各内核文件尾
     * 「接线建议」块的建议对齐（统一收敛为 kernels.<camelCase>.enabled）。
     */
    kernels?: {
      /** 51.0 投机解码：模型调度/任务执行的 drafter→verifier 配对经济裁决（咨询口径） */
      speculativeDecoding?: { enabled?: boolean; maxK?: number };
      /** 52.0 测试时计算：任务执行的高价值任务投票路数可达性计算（咨询口径） */
      testTimeCompute?: { enabled?: boolean; alpha?: number };
      /** 53.0 Whittle 指数：模型/租户两态臂的部分激活最优调度（动态选型升级） */
      whittleIndex?: { enabled?: boolean; goodThreshold?: number; passiveHeal?: number; discount?: number };
      /** 54.0 Lyapunov 漂移加罚：任务执行的任务类型背压账本与稳定性告警（观测口径） */
      lyapunovBackpressure?: { enabled?: boolean; V?: number; priceThreshold?: number };
      /** 55.0 Hawkes 自激发：哨兵到达流的自激发风暴判定与爆发外推（观测口径） */
      hawkesBurstGuard?: { enabled?: boolean; windowSec?: number; burstShare?: number; minEvents?: number };
      /** 56.0 置信传播：世界模型多源证据融合（旁路咨询口径） */
      beliefPropagation?: { enabled?: boolean };
      /** 57.0 变分推断：元认知平均场后验（6.0 自由能 q 分布供给方；旁路咨询） */
      variationalInference?: { enabled?: boolean };
      /** 58.0 朗之万采样：策略进化变异分布的 MALA 健康度体检（只读口径） */
      langevinMutation?: { enabled?: boolean; steps?: number; seed?: number };
      /** 59.0 课程学习：好奇心探索难度的掌握门限爬阶（记账 + 读数口径） */
      curriculum?: { enabled?: boolean; levelCount?: number; threshold?: number };
      /** 60.0 率失真：长期记忆 keep/compress/drop 三档压缩规划 + 影子价格 KPI（只读规划） */
      rateDistortion?: { enabled?: boolean; budgetBits?: number };
      /** 61.0 稳定匹配：共生市场双边偏好撮合（影子口径） */
      stableMatching?: { enabled?: boolean };
      /** 62.0 机制设计：共生市场 Myerson 保留价 + VCG 竞争出清（影子口径） */
      mechanismDesign?: { enabled?: boolean };
      /** 63.0 核仁：共生分账的 Shapley × 核仁双口径审计（影子口径） */
      nucleolusAudit?: { enabled?: boolean };
      /** 64.0 相关均衡：竞争性协调议题的无悔动态 CE 画像（影子口径） */
      correlatedEquilibrium?: { enabled?: boolean };
      /** 65.0 动态定价：共生费率档的 UCB/Thompson 学习定价（影子口径） */
      dynamicPricing?: { enabled?: boolean; policy?: 'ucb' | 'thompson'; unit?: number; exploration?: number };
      /** 66.0 模拟退火：策略进化种群的势阱深度与逃逸温度体检（只读口径） */
      annealingEscape?: { enabled?: boolean };
      /** 67.0 NSGA-II：模型调度「质量-成本-延迟」帕累托前沿菜单（只读口径） */
      paretoFront?: { enabled?: boolean };
      /** 68.0 压缩距离：长期记忆 NCD 近邻查重（零模型「内容相近」判据；只读咨询） */
      compressionDistance?: { enabled?: boolean; threshold?: number };
      /** 69.0 Mapper 图：世界模型经验地形骨架（拓扑盲区可见；只读口径） */
      mapperGraph?: { enabled?: boolean; intervals?: number; overlap?: number; clusterEps?: number };
      /** 70.0 部分信息分解：反思器多模型组合的冗余/独占/协同诊断（只读分析） */
      pidDiagnostics?: { enabled?: boolean };
      /** 71.0 A* 搜索：优化器最优子计划搜索（旁路咨询口径） */
      astarSearch?: { enabled?: boolean };
      /** 72.0 稀疏恢复：优化器质量归因的 Lasso+CV 稀疏 active 集（旁路分析） */
      sparseRecovery?: { enabled?: boolean };
      /** 73.0 最佳臂识别：基准报告的引擎锦标赛冠军裁决（纯报告附加） */
      baiSelector?: { enabled?: boolean; budget?: number };
      /** 74.0 镜像下降：决策引擎行动混合的无悔策略读数（咨询口径） */
      mirrorDescent?: { enabled?: boolean; mirror?: 'entropic' | 'euclidean'; alpha?: number };
      /** 75.0 在线校准：决策引擎概率口径前置层（门控激活后置信度被校准） */
      onlineCalibration?: { enabled?: boolean; strategy?: 'platt' | 'isotonic' | 'blended'; lr?: number; window?: number };
      /**
       * 第二轮创世纪升级（76.0→100.0）：五大新层 25 个内核的统一开关。
       * 全部缺省关闭（false / 不挂载）——打开才挂载，关闭时引擎行为与
       * 升级前逐位一致（零漂移是本仓库的宪法）。旗标名与各内核文件尾
       * 「接线建议」块的建议对齐（统一收敛为 kernels.<camelCase>.enabled）。
       */
      /** 76.0 新奇检测：哨兵「异常 = 没见过」双证据判定 + 新奇分序列变点监测（观测口径） */
      noveltySentinel?: { enabled?: boolean; capacity?: number; halfLife?: number; minSamples?: number; changeAlpha?: number };
      /** 77.0 因果发现：观测指标流 PC 学图（CPDAG 等价类，无向边 = 数据说不清；旁路咨询） */
      causalDiscovery?: { enabled?: boolean; alpha?: number };
      /** 78.0 典型相关：多源证据对齐的公共潜坐标系（私有噪声方向自动降权；旁路咨询） */
      ccaAlignment?: { enabled?: boolean; lambda?: number };
      /** 79.0 扩散映射：经验连续嵌入（与 69.0 Mapper 成对：骨架 + 连续坐标；旁路咨询） */
      diffusionManifold?: { enabled?: boolean; k?: number; dims?: number };
      /** 80.0 流式概要：哨兵高频流缓冲（键频上界/滑窗计数/等概率样本/重元素；观测口径） */
      streamingSketch?: { enabled?: boolean; cmsEps?: number; cmsDelta?: number; window?: number; reservoirK?: number };
      /** 81.0 论证：深思/反思结论的辩护链裁决（grounded 语义；影子计算） */
      argumentation?: { enabled?: boolean };
      /** 82.0 众包聚合：多模型判定的 Dawid–Skene 信任票权（对角塌陷 = 自动摘牌；咨询口径） */
      crowdAggregation?: { enabled?: boolean };
      /** 83.0 世界模型学习：调度轨迹学 T̂/r̂ + 值迭代 + Bellman 残差健康度（旁路咨询） */
      worldModelLearning?: { enabled?: boolean; prior?: number };
      /** 84.0 POMDP：决策引擎信念规划咨询（α-VI 点基下界 × QMDP 上界的信息价值间隙） */
      pomdpPlanner?: { enabled?: boolean };
      /** 85.0 符号求解：DAG 计划可行性静态裁决（SAT/UNSAT + 冲突账单 + 可行解计数） */
      symbolicFeasibility?: { enabled?: boolean };
      /** 86.0 分层技能：SMDP 宏动作时间信用分配 γ^k 体检（只读基准口径） */
      optionsFramework?: { enabled?: boolean; episodes?: number };
      /** 87.0 安全屏障：逐动作微分安全过滤（最小安全修改；infeasible 上报总督；咨询口径） */
      safetyBarrier?: { enabled?: boolean; eta?: number };
      /** 88.0 离线评估：金丝雀门控的反事实估值通道（DR + EB 置信区间；咨询口径） */
      offPolicyEvaluation?: { enabled?: boolean; delta?: number; gamma?: number };
      /** 89.0 安全策略改进：候选晋升的高置信证书（LCB > 0 才上线；咨询口径） */
      safePolicyImprovement?: { enabled?: boolean; delta?: number; minSamples?: number };
      /** 90.0 偏好学习：RLHF-lite 效用序（传递性 + 拟合优度双前置体检；影子学习） */
      preferenceLearning?: { enabled?: boolean; minPairs?: number; l2?: number };
      /** 91.0 新奇搜索：探索预算向行为空间空白定向（MCNS 可行性门槛；咨询口径） */
      noveltySearch?: { enabled?: boolean; k?: number };
      /** 92.0 自我对弈：策略进化对抗压力审计（可剥削度 + 联赛 exploiter 档案；影子计算） */
      selfPlay?: { enabled?: boolean; leagueRounds?: number; seed?: number };
      /** 93.0 AutoML Hyperband：引擎内超参自动寻优（连续配置 × 早停曲线；咨询口径） */
      automlHyperband?: { enabled?: boolean; eta?: number; seed?: number };
      /** 94.0 仿真校准：沙盒风洞修正（MMD² 域差 + 密度比换算真实口径；只读） */
      simulationCalibration?: { enabled?: boolean };
      /** 95.0 中断交接：ask-user 期望成本最优裁决（闭式 τ* = c_H + c_delay；咨询口径） */
      interruptibleAutonomy?: { enabled?: boolean };
      /** 96.0 全局工作空间：跨引擎意识总线（投标竞争 + 点火广播；心跳旁路仲裁） */
      globalWorkspace?: { enabled?: boolean; threshold?: number; temperature?: number };
      /** 97.0 元认知信心：决策置信度校准审计（M-ratio）+ 求助触发闭式阈值（观测口径） */
      metacognitiveConfidence?: { enabled?: boolean };
      /** 98.0 经验重放：长期记忆睡眠固化阶段（分层优先重放 + IS 加权；旁路口径） */
      experienceReplay?: { enabled?: boolean; capacity?: number; alpha?: number; beta?: number };
      /** 99.0 注意力经济：哨兵→优化器信息流拍卖（VCG 支付，谎报无利可图；影子口径） */
      attentionEconomy?: { enabled?: boolean };
      /** 100.0 自我边界：归因边界（防把环境红利记成功绩）+ 身份断点监控（影子计算） */
      selfBoundary?: { enabled?: boolean };
    };
    /**
     * 第四轮 R4-A17：模块域升级统一开关命名空间（autonomy.modules.*）。
     * 把第三/四轮各模块的 attach 式 / 构造配置式升级收敛为 16 个缺省关闭
     * 旗标（风格与 kernels.* 一致）——关 = 不挂载不注入，引擎行为与升级前
     * 逐位一致（零漂移）；开 = 经 engines-frontier/autonomy25.ts 适配层
     * 挂载（attachPostConstructModuleUpgrades / xxxModuleUpgradeConfig）。
     */
    modules?: import('./engines-frontier/autonomy25.js').ModuleUpgradeFlags;
    /**
     * 第四轮 R4-A17：主链路深化开关（跨步骤缓存 / 降级阶梯 / 步骤预取）。
     * 全部缺省关闭——关闭时 10 步链路行为与升级前逐位一致；开启为纯性能 /
     * 韧性增强（缓存命中结果与直算逐位一致、降级仅在异常时触发、预取经
     * 代际守卫消费结果恒一致）。
     */
    pipeline?: {
      /** 跨步骤派生值缓存（信号指纹 / 任务上下文推断的纯函数 LRU 记忆化） */
      crossStepCache?: {
        enabled?: boolean;
        /** LRU 容量（缺省 256） */
        capacity?: number;
      };
      /** 链路降级阶梯（第 5/6 步异常时：主路径 → 简化路径 → 兜底直通，逐级入审计） */
      degradationLadder?: { enabled?: boolean };
      /** 步骤并行化预取（执行等待期预取下一执行信号的经验检索，代际守卫消费） */
      stepPrefetch?: { enabled?: boolean };
    };
    /** 目标分解器注入（测试离线模拟） */
    decomposer?: import('./goal-engine.js').GoalDecomposer;
  };
  /** 宿主融合配置（全宿主可观测 + 全宿主安全治理；宿主无 ctx.tools 时静默降级） */
  hostFusion?: Partial<import('./host-fusion.js').HostFusionConfig>;
}

// ─────────────────────────── Tool 注册表 ───────────────────────────

/** Tool 定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean; enum?: string[] }>;
  handler: (args: any) => Promise<any> | any;
}

/** Tool 调用错误 */
export class ToolError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'TOOL_ERROR', details);
  }
}

/** Tool 调用统计（第三轮 A17：introspect 的工具调用计数口径） */
export interface ToolCallStats {
  name: string;
  /** 总调用次数（含被校验拒绝与执行失败） */
  calls: number;
  /** 入参校验拒绝次数 */
  rejected: number;
  /** handler 执行失败（抛出）次数 */
  failures: number;
  lastCalledAt?: number;
}

/**
 * Tool 入参轻量校验（第三轮 A17：契约思想的零依赖自实现）。
 *
 * 校验口径与 parameters 声明一一对应：必填在场、类型匹配（string/number/
 * boolean/array/object）、enum 成员资格；未声明的额外键放行（与官方
 * JSON Schema 导出的 additionalProperties: true 一致）。返回 undefined =
 * 通过；返回字符串 = 拒绝原因（调用方转 ToolError）。纯函数、确定性。
 */
export function validateToolInput(
  parameters: ToolDefinition['parameters'],
  args: Record<string, unknown>,
): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return '入参必须是对象（key-value 形式）';
  }
  for (const [key, spec] of Object.entries(parameters)) {
    const value = args[key];
    if (value === undefined || value === null) {
      if (spec.required) return `缺少必填参数 ${key}（${spec.type}）`;
      continue;
    }
    const typeError = checkToolParamType(key, spec.type, value);
    if (typeError) return typeError;
    if (spec.enum && spec.enum.length > 0 && typeof value === 'string' && !spec.enum.includes(value)) {
      return `参数 ${key} 的值 "${value}" 不在允许枚举内（${spec.enum.join(' / ')}）`;
    }
  }
  return undefined;
}

function checkToolParamType(key: string, type: string, value: unknown): string | undefined {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : `参数 ${key} 需为有限数字`;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `参数 ${key} 需为布尔值`;
    case 'array':
      return Array.isArray(value) ? undefined : `参数 ${key} 需为数组`;
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? undefined : `参数 ${key} 需为对象`;
    default:
      return typeof value === 'string' ? undefined : `参数 ${key} 需为字符串`;
  }
}

/**
 * Tool 注册表服务
 *
 * cordis 核心未内置 Tool API，本插件以 provide('schedulerTools') 形式
 * 向宿主暴露 12 个 Tool 的注册、发现与调用能力。
 *
 * 第三轮 A17 升级（纯增量、零漂移——合法入参路径与升级前逐位一致）：
 * - invoke 先经 validateToolInput 入参校验，非法入参在进入 handler 前
 *   以 ToolError 拒绝（既有 handler 内的防御检查保持不动，双保险）；
 * - 全部调用计数（calls / rejected / failures）经 stats() 导出，供
 *   introspect 工具调用计数消费；
 * - schemas() 导出每工具的官方 JSON Schema 文档（dsh-tools 子集口径）。
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private readonly callStats = new Map<string, { calls: number; rejected: number; failures: number; lastCalledAt?: number }>();
  private readonly statClock: () => number;

  constructor(options?: { /** 统计时钟（测试注入；缺省 Date.now） */ now?: () => number }) {
    this.statClock = options?.now ?? Date.now;
  }

  /** 注册一个 Tool（重名覆盖；统计计数随新定义重置） */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
    this.callStats.delete(tool.name);
  }

  /** 注销一个 Tool */
  unregister(name: string): boolean {
    this.callStats.delete(name);
    return this.tools.delete(name);
  }

  /** 获取 Tool 定义 */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** 列出全部 Tool（不含 handler） */
  list(): Array<Pick<ToolDefinition, 'name' | 'description' | 'parameters'>> {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  /** 每工具官方 JSON Schema 文档（name + description + parameters 子集 schema） */
  schemas(): Array<{ name: string; description: string; schema: Record<string, unknown> }> {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: toJsonSchemaParameters(tool.parameters),
    }));
  }

  /** 调用统计（introspect 口径；未注册工具的未知调用不计入） */
  stats(): { total: number; tools: ToolCallStats[] } {
    const tools = [...this.tools.keys()].map((name) => {
      const s = this.callStats.get(name);
      return { name, calls: s?.calls ?? 0, rejected: s?.rejected ?? 0, failures: s?.failures ?? 0, ...(s?.lastCalledAt !== undefined ? { lastCalledAt: s.lastCalledAt } : {}) };
    });
    return { total: tools.reduce((sum, t) => sum + t.calls, 0), tools };
  }

  /** 清零调用统计（只清统计，不动注册表） */
  resetStats(): void {
    this.callStats.clear();
  }

  private statsFor(name: string): { calls: number; rejected: number; failures: number; lastCalledAt?: number } {
    let stats = this.callStats.get(name);
    if (!stats) {
      stats = { calls: 0, rejected: 0, failures: 0 };
      this.callStats.set(name, stats);
    }
    return stats;
  }

  /** 调用 Tool（未知名称抛 ToolError；非法入参在进入 handler 前被校验拒绝） */
  async invoke(name: string, args: Record<string, any> = {}): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolError(`未知 Tool: ${name}`);
    const stats = this.statsFor(name);
    stats.calls += 1;
    stats.lastCalledAt = this.statClock();
    const rejection = validateToolInput(tool.parameters, args ?? {});
    if (rejection) {
      stats.rejected += 1;
      throw new ToolError(`Tool ${name} 入参校验失败: ${rejection}`);
    }
    try {
      return await tool.handler(args ?? {});
    } catch (err) {
      stats.failures += 1;
      throw err;
    }
  }
}

/**
 * 将内部 Tool 参数声明转换为官方 JSON Schema 子集（dsh-tools 强制子集：
 * object 根 + properties/required/additionalProperties + 标量 enum）。
 */
function toJsonSchemaParameters(parameters: ToolDefinition['parameters']): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [key, spec] of Object.entries(parameters)) {
    const node: Record<string, unknown> = { description: spec.description };
    switch (spec.type) {
      case 'number':
        node.type = 'number';
        break;
      case 'boolean':
        node.type = 'boolean';
        break;
      case 'array':
        node.type = 'array';
        break;
      case 'object':
        node.type = 'object';
        node.additionalProperties = true;
        break;
      default:
        node.type = 'string';
    }
    if (spec.enum && spec.enum.length > 0) node.enum = [...spec.enum];
    properties[key] = node;
    if (spec.required) required.push(key);
  }
  const schema: Record<string, unknown> = { type: 'object', properties, additionalProperties: true };
  if (required.length > 0) schema.required = required;
  return schema;
}

// ─────────────────────────── 第三轮 A17：10 步链路结构化审计轨迹 ───────────────────────────

/** 10 步链路的步序元数据（与文件头注释的 1~10 步一一对应；审计口径的唯一事实源） */
export const PIPELINE_STEPS = [
  { step: 1, key: 'signal-intake', label: '信号接入' },
  { step: 2, key: 'signal-aggregation', label: '信号聚合' },
  { step: 3, key: 'priority-ranking', label: '优先级排序' },
  { step: 4, key: 'strategy-decision', label: '战略决策' },
  { step: 5, key: 'experience-retrieval', label: '经验检索' },
  { step: 6, key: 'plan-generation', label: '计划生成' },
  { step: 7, key: 'parallel-execution', label: '并行执行' },
  { step: 8, key: 'quality-reflection', label: '质量反思' },
  { step: 9, key: 'cascade-trigger', label: '级联触发' },
  { step: 10, key: 'memory-consolidation', label: '反思与记忆更新' },
] as const;

/** 单条链路检查点（结构化审计轨迹的原子记录） */
export interface PipelineCheckpoint {
  /** 全局单调序号（缓冲内严格递增） */
  seq: number;
  /** 追踪 id（批次口径 batch-N / 信号口径为空） */
  trace: string;
  /** 步序 1~10 */
  step: number;
  stepKey: string;
  label: string;
  /** 时钟读数（毫秒；注入时钟时为注入值——确定性可重放） */
  at: number;
  /** 本步耗时（begin→end 区间；单点 mark 恒 0） */
  durationMs: number;
  /** 关键决策值（步序相关的结构化摘录） */
  decisions?: Record<string, unknown>;
  /** 结局（ok / fast-path / planned / failed / skipped / blocked / …） */
  outcome: string;
  detail?: Record<string, unknown>;
}

/** 审计轨迹摘要（introspect 导出口径） */
export interface PipelineAuditSummary {
  /** 逐步聚合（按步序升序；仅统计当前缓冲内样本） */
  steps: Array<{ step: number; stepKey: string; label: string; count: number; totalDurationMs: number; outcomes: Record<string, number>; lastOutcome?: string }>;
  /** 出现过检查点的步序（升序去重） */
  coveredSteps: number[];
  /** 从未出现检查点的步序（升序） */
  missingSteps: number[];
  /** 当前缓冲区检查点条数 */
  checkpoints: number;
  /** 环形覆盖丢弃的历史检查点累计数 */
  dropped: number;
  /** 导出序列的时序单调性（seq 严格递增 且 at 单调不减） */
  monotonic: boolean;
}

/**
 * 10 步链路结构化审计轨迹（第三轮 A17；环形缓冲 + 注入式时钟）。
 *
 * 纯记录口径——begin/end/mark 只写私有缓冲，不读不写任何引擎状态、
 * 不抛异常（未知步序静默忽略）、不影响链路任何分支：缺省开启且零行为
 * 影响。时钟经构造注入（缺省 Date.now），验证脚本可注入合成时钟获得
 * 逐位可重放的轨迹。容量为环形上限，超出按 FIFO 覆盖最旧并累计 dropped。
 */
export class PipelineAuditTrail {
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly buffer: PipelineCheckpoint[] = [];
  private readonly openSpans = new Map<string, number>();
  private seq = 0;
  private dropped = 0;

  constructor(options?: {
    /** 环形缓冲容量（缺省 1024，下限 16） */
    capacity?: number;
    /** 时钟注入（缺省 Date.now；确定性测试用） */
    now?: () => number;
  }) {
    this.capacity = Math.max(16, Math.floor(options?.capacity ?? 1024));
    this.now = options?.now ?? Date.now;
  }

  private static meta(step: number): { key: string; label: string } | undefined {
    return PIPELINE_STEPS.find((s) => s.step === step);
  }

  private push(entry: Omit<PipelineCheckpoint, 'seq'>): void {
    this.seq += 1;
    this.buffer.push({ seq: this.seq, ...entry });
    if (this.buffer.length > this.capacity) {
      this.dropped += this.buffer.length - this.capacity;
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
  }

  /** 步骤开始（与 end 成对计时；决策值统一在 end 落账） */
  begin(trace: string, step: number): void {
    const meta = PipelineAuditTrail.meta(step);
    if (!meta) return;
    this.openSpans.set(`${trace}:${step}`, this.now());
  }

  /** 步骤结束（durationMs = end 时钟 − begin 时钟） */
  end(trace: string, step: number, outcome: string, decisions?: Record<string, unknown>, detail?: Record<string, unknown>): void {
    const meta = PipelineAuditTrail.meta(step);
    if (!meta) return;
    const key = `${trace}:${step}`;
    const start = this.openSpans.get(key);
    this.openSpans.delete(key);
    const at = this.now();
    this.push({
      trace,
      step,
      stepKey: meta.key,
      label: meta.label,
      at,
      durationMs: start === undefined ? 0 : Math.max(0, at - start),
      ...(decisions !== undefined ? { decisions } : {}),
      outcome,
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  /** 单点检查点（无需计时的步骤：数据到位即落账，durationMs 恒 0） */
  mark(trace: string, step: number, outcome: string, decisions?: Record<string, unknown>, detail?: Record<string, unknown>): void {
    const meta = PipelineAuditTrail.meta(step);
    if (!meta) return;
    this.push({
      trace,
      step,
      stepKey: meta.key,
      label: meta.label,
      at: this.now(),
      durationMs: 0,
      ...(decisions !== undefined ? { decisions } : {}),
      outcome,
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  /** 轨迹快照（浅拷贝；按 seq 升序） */
  export(): PipelineCheckpoint[] {
    return this.buffer.map((c) => ({ ...c, ...(c.decisions !== undefined ? { decisions: { ...c.decisions } } : {}), ...(c.detail !== undefined ? { detail: { ...c.detail } } : {}) }));
  }

  /** 轨迹摘要（introspect 口径：逐步计数 + 覆盖面 + 时序单调性自检） */
  summary(): PipelineAuditSummary {
    const steps = PIPELINE_STEPS.map((meta) => {
      const hits = this.buffer.filter((c) => c.step === meta.step);
      const outcomes: Record<string, number> = {};
      for (const c of hits) outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + 1;
      const last = hits[hits.length - 1];
      return {
        step: meta.step,
        stepKey: meta.key,
        label: meta.label,
        count: hits.length,
        totalDurationMs: hits.reduce((sum, c) => sum + (c.durationMs ?? 0), 0),
        outcomes,
        ...(last !== undefined ? { lastOutcome: last.outcome } : {}),
      };
    });
    const coveredSteps = [...new Set(this.buffer.map((c) => c.step))].sort((a, b) => a - b);
    const missingSteps = PIPELINE_STEPS.map((s) => s.step).filter((s) => !coveredSteps.includes(s));
    let monotonic = true;
    for (let i = 1; i < this.buffer.length; i += 1) {
      const prev = this.buffer[i - 1]!;
      const curr = this.buffer[i]!;
      if (!(curr.seq === prev.seq + 1) || curr.at < prev.at) monotonic = false;
    }
    return { steps, coveredSteps, missingSteps, checkpoints: this.buffer.length, dropped: this.dropped, monotonic };
  }

  /** 清空轨迹与计数（测试口径） */
  reset(): void {
    this.buffer.length = 0;
    this.openSpans.clear();
    this.seq = 0;
    this.dropped = 0;
  }
}

// ─────────────────── 第四轮 R4-A17：主链路深化三件套（跨步骤缓存 / 降级阶梯 / 步骤预取） ───────────────────

/** 跨步骤缓存读数（introspect / 验证口径） */
export interface PipelineStepCacheStats {
  /** 命中次数 */
  hits: number;
  /** 未命中次数（含代际失效） */
  misses: number;
  /** LRU 淘汰次数 */
  evictions: number;
  /** 当前条目数 */
  size: number;
  /** 容量上限 */
  capacity: number;
  /** 当前写入代数（每次 bump +1） */
  generation: number;
  /** 纯函数条目数（永不代际失效） */
  pureEntries: number;
}

/**
 * 深化 1：跨步骤派生值缓存（第四轮 R4-A17）。
 *
 * 链路中重复计算的纯派生值（信号指纹 sha256 / 任务上下文推断）的轻量
 * LRU 记忆化——键 = 输入指纹，命中路径结果与直算逐位一致（纯函数同输入
 * 同输出，构造对照可证）。两种条目：
 * - pure（缺省 false）：纯函数值，永不失效（键即全部输入）；
 * - 非 pure：携带写入代数，bump() 后视为陈旧（记忆写入点调用 bump——
 *   陈旧即重算，杜绝跨写窗口读到旧值）。
 *
 * 纯容器：零引擎依赖、零 I/O、时钟无关；缺省不启用（autonomy.pipeline.
 * crossStepCache），关闭时链路不经过本容器（零漂移）。
 */
export class PipelineStepCache<V = unknown> {
  private entries = new Map<string, { value: V; generation: number; pure: boolean }>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private gen = 0;

  constructor(public readonly capacity = 256) {}

  /** 当前写入代数（每次 bump +1） */
  get generation(): number {
    return this.gen;
  }

  /** 推进写入代数：非 pure 条目全部视为陈旧（记忆写入点调用） */
  bump(): void {
    this.gen += 1;
  }

  /** 读取：pure 条目命中即返回；非 pure 条目须代数一致（陈旧则删除并计 miss） */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.misses += 1;
      return undefined;
    }
    if (!entry.pure && entry.generation !== this.gen) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    // LRU 新近度：命中即重插（Map 迭代序 = 插入序 → 淘汰最旧）
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  /** 写入（超出容量淘汰最旧条目并计数） */
  set(key: string, value: V, options?: { pure?: boolean }): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, generation: this.gen, pure: options?.pure === true });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }

  /** 读数（introspect 口径） */
  stats(): PipelineStepCacheStats {
    let pureEntries = 0;
    for (const entry of this.entries.values()) if (entry.pure) pureEntries += 1;
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      size: this.entries.size,
      capacity: this.capacity,
      generation: this.gen,
      pureEntries,
    };
  }

  /** 清空（测试口径） */
  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.gen = 0;
  }
}

/** 单级降级的尝试记录（审计口径） */
export interface DegradationAttempt {
  /** 级序（1 = 主路径） */
  rung: number;
  /** 级名（main / simplified / fallback） */
  name: string;
  /** 该级抛出的异常消息（成功级无此键） */
  error?: string;
}

/** 降级阶梯执行结果 */
export interface DegradationLadderResult<T> {
  /** 最终成功级的结果 */
  result: T;
  /** 成功级序（1 起；> 1 即发生过降级） */
  usedRung: number;
  /** 逐级尝试记录（按触发序——证明降级链按序触发） */
  attempts: DegradationAttempt[];
}

/**
 * 深化 2：链路降级阶梯（第四轮 R4-A17）。
 *
 * 某步骤（经验检索 / 计划生成）异常时的降级链：主路径 → 简化路径 → 兜底
 * 直通——逐级尝试、逐级入审计（attempts 按序记录每级的名字与异常）。
 * 任一级成功即返回该级结果；全部失败则抛出携带完整尝试轨迹的聚合错误
 * （诚实上抛——上层走既有失败路径，不吞错）。
 *
 * 纯函数、零引擎依赖；run 支持 async（预取消费等异步主路径）。缺省不
 * 启用（autonomy.pipeline.degradationLadder），关闭时链路不经过本函数。
 */
export async function runDegradationLadder<T>(
  rungs: ReadonlyArray<{ name: string; run: () => T | Promise<T> }>,
): Promise<DegradationLadderResult<T>> {
  if (rungs.length === 0) throw new Error('降级阶梯为空（至少一级）');
  const attempts: DegradationAttempt[] = [];
  for (let i = 0; i < rungs.length; i += 1) {
    const { name, run } = rungs[i]!;
    try {
      const result = await run();
      attempts.push({ rung: i + 1, name });
      return { result, usedRung: i + 1, attempts };
    } catch (error) {
      attempts.push({ rung: i + 1, name, error: (error as Error).message });
    }
  }
  throw new Error(`降级阶梯全部失败：${attempts.map((a) => `L${a.rung}${a.name}${a.error ? `（${a.error}）` : ''}`).join(' → ')}`);
}

/** 步骤预取读数（introspect / 验证口径） */
export interface StepPrefetchStats {
  /** 预取发起次数 */
  fired: number;
  /** 消费次数 */
  consumed: number;
  /** 代际一致命中次数（免重算） */
  hits: number;
  /** 未命中次数（未发起 / 代际失效 → 直算） */
  misses: number;
}

/** 单条预取条目（promise + 发起时代数） */
interface PrefetchEntry<V> {
  promise: Promise<V>;
  generation: number;
}

/**
 * 深化 3（加分）：步骤并行化预取（第四轮 R4-A17）。
 *
 * 无依赖步骤的预取口径：信号 i 执行等待期（第 7 步 await）预取下一执行
 * 信号的第 5 步三重读取，消费时经代际守卫（发起与消费之间记忆代数一致才
 * 用预取值，否则直算）——结果恒与串行直算一致，只降时延。
 *
 * 零引擎依赖；时钟无关。缺省不启用（autonomy.pipeline.stepPrefetch）。
 */
export class StepPrefetcher<V = unknown> {
  private store = new Map<string, PrefetchEntry<V>>();
  private statsRecord: StepPrefetchStats = { fired: 0, consumed: 0, hits: 0, misses: 0 };

  constructor(private readonly generation: () => number = () => 0) {}

  /** 发起预取（微任务调度——宿主 await 让出事件循环时执行；重复发起覆盖旧条目） */
  fire(key: string, compute: () => V): void {
    const generation = this.generation();
    const promise = Promise.resolve().then(compute);
    // 预取计算抛错且条目最终未被消费（批次边界 clear 作废）时，
    // 挂一个空 catch 防 Node 未处理 Promise 拒绝；消费侧 await 的仍是原
    // promise，拒绝照常上抛给调用方——只补漏，不改语义
    void promise.catch(() => {});
    this.store.set(key, { promise, generation });
    this.statsRecord.fired += 1;
  }

  /** 消费预取：发起在案且代际一致 → 预取值（hit）；否则直算（miss）。结果恒一致。 */
  async consume(key: string, recompute: () => V): Promise<{ value: V; hit: boolean }> {
    this.statsRecord.consumed += 1;
    const entry = this.store.get(key);
    if (entry !== undefined && entry.generation === this.generation()) {
      this.store.delete(key);
      this.statsRecord.hits += 1;
      return { value: await entry.promise, hit: true };
    }
    if (entry !== undefined) this.store.delete(key);
    this.statsRecord.misses += 1;
    return { value: recompute(), hit: false };
  }

  /** 读数（introspect 口径） */
  stats(): StepPrefetchStats {
    return { ...this.statsRecord };
  }

  /** 清空在途条目（批次边界口径——未消费的预取诚实作废，消费侧自动直算） */
  clear(): void {
    this.store.clear();
  }
}

// ─────────────────────────── 第三轮 A17：fiber 资源清理审计注册表 ───────────────────────────

/** 单条资源登记的审计视图 */
export interface ResourceAuditEntry {
  id: number;
  kind: string;
  label: string;
  registeredAt: number;
  /** held = 仍持有；released = 已释放；leaked = 登记未销账且无释放句柄；error = 释放抛错 */
  status: 'held' | 'released' | 'leaked' | 'error';
  releasedAt?: number;
  /** 释放序（1 起；逆序释放中的实际次序） */
  releasedOrder?: number;
  error?: string;
}

/** 资源清理审计报告（disposeAll 产出 / audit 只读快照共用口径） */
export interface ResourceAuditReport {
  registered: number;
  released: number;
  leaked: number;
  errored: number;
  held: number;
  /** 实际释放序（disposeAll 填充；audit() 为空数组） */
  releaseOrder: Array<{ id: number; kind: string; label: string }>;
  entries: ResourceAuditEntry[];
}

/**
 * fiber 资源清理审计注册表（第三轮 A17）。
 *
 * 登记造册：interval / fiber / listener / watcher / server / persist 等一切
 * dispose 句柄入册；卸载时 disposeAll() 按注册逆序释放（后注册者先释放——
 * 与资源创建的依赖序天然相反），逐条 try/catch 记账并产出审计报告：
 * 释放出错不阻断后续释放；登记时无释放句柄且事后未销账 → 漏释放（leaked）
 * 显式告警。时钟可注入（缺省 Date.now）。纯登记容器，不含任何引擎依赖。
 */
export class ResourceRegistry {
  private nextId = 1;
  private releaseSeq = 0;
  private readonly clock: () => number;
  private readonly entries: Array<{
    id: number;
    kind: string;
    label: string;
    registeredAt: number;
    dispose?: () => void;
    releasedAt?: number;
    releasedOrder?: number;
    error?: string;
  }> = [];

  constructor(options?: { /** 时钟注入（缺省 Date.now） */ now?: () => number }) {
    this.clock = options?.now ?? Date.now;
  }

  /** 登记一项资源（dispose 省略 = 只读登记——漏释放审计的观察对象）；返回登记 id */
  register(kind: string, dispose?: () => void, label?: string): number {
    const id = this.nextId;
    this.nextId += 1;
    this.entries.push({
      id,
      kind,
      label: label ?? `${kind}#${id}`,
      registeredAt: this.clock(),
      ...(dispose !== undefined ? { dispose } : {}),
    });
    return id;
  }

  /** 外部销账（资源已由其它路径释放；无 dispose 句柄的只读登记用） */
  markReleased(id: number): boolean {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry || entry.releasedAt !== undefined) return false;
    entry.releasedAt = this.clock();
    this.releaseSeq += 1;
    entry.releasedOrder = this.releaseSeq;
    return true;
  }

  /** 仍持有的登记数 */
  get size(): number {
    return this.entries.filter((e) => e.releasedAt === undefined).length;
  }

  /** 按注册逆序释放全部未销账登记并产出审计报告（释放出错记账不阻断） */
  disposeAll(): ResourceAuditReport {
    const releaseOrder: Array<{ id: number; kind: string; label: string }> = [];
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i]!;
      if (entry.releasedAt !== undefined) continue; // 已提前销账——跳过
      if (typeof entry.dispose === 'function') {
        try {
          entry.dispose();
          entry.releasedAt = this.clock();
          this.releaseSeq += 1;
          entry.releasedOrder = this.releaseSeq;
        } catch (err) {
          entry.error = err instanceof Error ? err.message : String(err);
        }
      }
      // 无 dispose 句柄且未销账 → 保持未释放状态，报告中以 leaked 呈现（漏释放检测）
      if (entry.releasedAt !== undefined) releaseOrder.push({ id: entry.id, kind: entry.kind, label: entry.label });
    }
    return this.report(releaseOrder);
  }

  /** 只读审计快照（不释放任何资源） */
  audit(): ResourceAuditReport {
    return this.report([]);
  }

  private report(releaseOrder: ResourceAuditReport['releaseOrder']): ResourceAuditReport {
    const entries: ResourceAuditEntry[] = this.entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      label: e.label,
      registeredAt: e.registeredAt,
      status: e.releasedAt !== undefined ? 'released' : e.error !== undefined ? 'error' : typeof e.dispose === 'function' ? 'held' : 'leaked',
      ...(e.releasedAt !== undefined ? { releasedAt: e.releasedAt } : {}),
      ...(e.releasedOrder !== undefined ? { releasedOrder: e.releasedOrder } : {}),
      ...(e.error !== undefined ? { error: e.error } : {}),
    }));
    return {
      registered: entries.length,
      released: entries.filter((e) => e.status === 'released').length,
      leaked: entries.filter((e) => e.status === 'leaked').length,
      errored: entries.filter((e) => e.status === 'error').length,
      held: entries.filter((e) => e.status === 'held').length,
      releaseOrder,
      entries,
    };
  }
}

// ─────────────────────────── 第三轮 A17：内核旗标总览（kernels.* 50 旗标） ───────────────────────────

/** 单个 kernels.* 旗标的静态元数据 */
export interface KernelFlagMeta {
  /** 旗标名（kernels 命名空间的键） */
  name: string;
  /** 内核版本号（51.0 → 100.0） */
  version: string;
  /** 升级轮次（1 = 创世纪 51.0→75.0；2 = 第二轮创世纪 76.0→100.0） */
  wave: 1 | 2;
  /** 挂载点引擎（attachXxx 所在文件） */
  scope: string;
}

/** 旗标开关态（元数据 + 运行时 enabled） */
export interface KernelFlagState extends KernelFlagMeta {
  enabled: boolean;
}

/** 内核旗标总览（introspect 导出口径） */
export interface KernelFlagOverview {
  total: number;
  enabled: number;
  disabled: number;
  flags: KernelFlagState[];
}

/** kernels.* 命名空间 50 旗标的静态清单（与 SchedulerConfig.autonomy.kernels 一一对应） */
export const KERNEL_FLAGS: ReadonlyArray<KernelFlagMeta> = [
  { name: 'speculativeDecoding', version: '51.0', wave: 1, scope: 'model-scheduler' },
  { name: 'testTimeCompute', version: '52.0', wave: 1, scope: 'task-executor' },
  { name: 'whittleIndex', version: '53.0', wave: 1, scope: 'model-scheduler' },
  { name: 'lyapunovBackpressure', version: '54.0', wave: 1, scope: 'task-executor' },
  { name: 'hawkesBurstGuard', version: '55.0', wave: 1, scope: 'sentinel' },
  { name: 'beliefPropagation', version: '56.0', wave: 1, scope: 'world-model' },
  { name: 'variationalInference', version: '57.0', wave: 1, scope: 'meta-cognition' },
  { name: 'langevinMutation', version: '58.0', wave: 1, scope: 'strategy-evolution' },
  { name: 'curriculum', version: '59.0', wave: 1, scope: 'curiosity' },
  { name: 'rateDistortion', version: '60.0', wave: 1, scope: 'long-term-memory' },
  { name: 'stableMatching', version: '61.0', wave: 1, scope: 'symbiosis' },
  { name: 'mechanismDesign', version: '62.0', wave: 1, scope: 'symbiosis' },
  { name: 'nucleolusAudit', version: '63.0', wave: 1, scope: 'symbiosis' },
  { name: 'correlatedEquilibrium', version: '64.0', wave: 1, scope: 'symbiosis' },
  { name: 'dynamicPricing', version: '65.0', wave: 1, scope: 'symbiosis' },
  { name: 'annealingEscape', version: '66.0', wave: 1, scope: 'strategy-evolution' },
  { name: 'paretoFront', version: '67.0', wave: 1, scope: 'model-scheduler' },
  { name: 'compressionDistance', version: '68.0', wave: 1, scope: 'long-term-memory' },
  { name: 'mapperGraph', version: '69.0', wave: 1, scope: 'world-model' },
  { name: 'pidDiagnostics', version: '70.0', wave: 1, scope: 'reflector' },
  { name: 'astarSearch', version: '71.0', wave: 1, scope: 'optimizer' },
  { name: 'sparseRecovery', version: '72.0', wave: 1, scope: 'optimizer' },
  { name: 'baiSelector', version: '73.0', wave: 1, scope: 'benchmark' },
  { name: 'mirrorDescent', version: '74.0', wave: 1, scope: 'decision-engine' },
  { name: 'onlineCalibration', version: '75.0', wave: 1, scope: 'decision-engine' },
  { name: 'noveltySentinel', version: '76.0', wave: 2, scope: 'sentinel' },
  { name: 'causalDiscovery', version: '77.0', wave: 2, scope: 'world-model' },
  { name: 'ccaAlignment', version: '78.0', wave: 2, scope: 'world-model' },
  { name: 'diffusionManifold', version: '79.0', wave: 2, scope: 'world-model' },
  { name: 'streamingSketch', version: '80.0', wave: 2, scope: 'sentinel' },
  { name: 'argumentation', version: '81.0', wave: 2, scope: 'reflection-engine' },
  { name: 'crowdAggregation', version: '82.0', wave: 2, scope: 'reflector' },
  { name: 'worldModelLearning', version: '83.0', wave: 2, scope: 'world-model' },
  { name: 'pomdpPlanner', version: '84.0', wave: 2, scope: 'decision-engine' },
  { name: 'symbolicFeasibility', version: '85.0', wave: 2, scope: 'task-executor' },
  { name: 'optionsFramework', version: '86.0', wave: 2, scope: 'task-executor' },
  { name: 'safetyBarrier', version: '87.0', wave: 2, scope: 'task-executor' },
  { name: 'offPolicyEvaluation', version: '88.0', wave: 2, scope: 'policy-evolver' },
  { name: 'safePolicyImprovement', version: '89.0', wave: 2, scope: 'policy-evolver' },
  { name: 'preferenceLearning', version: '90.0', wave: 2, scope: 'reflector' },
  { name: 'noveltySearch', version: '91.0', wave: 2, scope: 'curiosity' },
  { name: 'selfPlay', version: '92.0', wave: 2, scope: 'strategy-evolution' },
  { name: 'automlHyperband', version: '93.0', wave: 2, scope: 'benchmark' },
  { name: 'simulationCalibration', version: '94.0', wave: 2, scope: 'sandbox' },
  { name: 'interruptibleAutonomy', version: '95.0', wave: 2, scope: 'decision-engine' },
  { name: 'globalWorkspace', version: '96.0', wave: 2, scope: 'autonomy-loop' },
  { name: 'metacognitiveConfidence', version: '97.0', wave: 2, scope: 'decision-engine' },
  { name: 'experienceReplay', version: '98.0', wave: 2, scope: 'long-term-memory' },
  { name: 'attentionEconomy', version: '99.0', wave: 2, scope: 'sentinel' },
  { name: 'selfBoundary', version: '100.0', wave: 2, scope: 'self-model' },
];

/** 内核旗标总览（50 旗标开关态；enabled 仅在显式 === true 时为真——缺省关闭） */
export function kernelFlagOverview(kernels?: NonNullable<SchedulerConfig['autonomy']>['kernels']): KernelFlagOverview {
  const flags = KERNEL_FLAGS.map((meta) => ({
    ...meta,
    enabled: (kernels as Record<string, { enabled?: boolean }> | undefined)?.[meta.name]?.enabled === true,
  }));
  const enabled = flags.filter((f) => f.enabled).length;
  return { total: flags.length, enabled, disabled: flags.length - enabled, flags };
}

/** 插件对外暴露的调度器服务面 */
export interface SchedulerService {
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
  /** 10 步链路结构化审计轨迹（第三轮 A17；纯记录、缺省开启、零行为影响） */
  pipelineAudit: PipelineAuditTrail;
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

// ─────────────────────────── 默认配置 ───────────────────────────

const DEFAULT_CONFIG: Partial<SchedulerConfig> = {
  qualityThreshold: 0.7,
  maxRetries: 2,
  globalTimeout: 300_000,
  enableProgress: true,
  progressPort: 9877,
  verbose: false,
  experienceStorePath: '.scheduler/memory.json',
};

// ─────────────────────────── Schemastery Config schema（加载时校验 + 默认值填充） ───────────────────────────

/**
 * 插件配置 schema（cordis Plugin.Base.Config）。
 * 经 ctx.plugin() 加载时由 cordis resolveConfig 自动校验并填充默认值；
 * 函数型注入字段（nodeRunner / judge / llm.fetchImpl 等）不在 schema 中声明，
 * 作为额外属性透传，不受校验影响。
 */
export const Config = Schema.object({
  // strategistModel 整体可选（宿主经 ctx 提供模型时无需配置）；
  // 指定时 id/endpoint 的完整性由 apply 运行时守卫校验（ConfigError）
  strategistModel: Schema.object({
    id: Schema.string(),
    endpoint: Schema.string(),
    apiKey: Schema.string(),
  }),
  models: Schema.array(Schema.any()),
  sentinel: Schema.object({
    watchCodeChanges: Schema.boolean().default(true),
    watchErrors: Schema.boolean().default(true),
    watchPerformance: Schema.boolean().default(true),
    aggregationWindow: Schema.number().min(0).default(0.5),
    signalSources: Schema.array(Schema.any()),
  }).default({} as any),
  qualityThreshold: Schema.percent().default(0.7),
  maxRetries: Schema.natural().default(2),
  globalTimeout: Schema.natural().default(300_000),
  enableProgress: Schema.boolean().default(true),
  progressPort: Schema.natural().default(9877),
  verbose: Schema.boolean().default(false),
  experienceStorePath: Schema.string().default('.scheduler/memory.json'),
  encryption: Schema.object({
    enabled: Schema.boolean().default(false),
    masterKey: Schema.string(),
    algorithm: Schema.union([Schema.const('aes-256-gcm'), Schema.const('aes-256-cbc')]).default('aes-256-gcm'),
    fullFileEncryption: Schema.boolean().default(true),
  }).default({} as any),
  sync: Schema.object({
    localNodeId: Schema.string().default('node-dev-01'),
    peers: Schema.array(Schema.any()).default([]),
  }).default({} as any),
  consensus: Schema.object({
    enabled: Schema.boolean().default(false),
    localNodeId: Schema.string().default('node-01'),
    consensusPort: Schema.natural().default(9880),
    electionTimeoutMin: Schema.natural().default(1500),
    electionTimeoutMax: Schema.natural().default(3000),
    heartbeatInterval: Schema.natural().default(500),
    cluster: Schema.array(Schema.any()).default([]),
  }).default({} as any),
  hotReload: Schema.object({
    enabled: Schema.boolean().default(false),
    watchDirs: Schema.array(Schema.string()).default(['src']),
    watchExtensions: Schema.array(Schema.string()).default(['.ts', '.tsx', '.js']),
    debounceMs: Schema.natural().default(1000),
    buildCommand: Schema.string().default('npm run build'),
    autoRollback: Schema.boolean().default(true),
  }).default({} as any),
  tenants: Schema.array(Schema.any()).default([]),
  dataDir: Schema.string(),
  memoryFastPathThreshold: Schema.number().min(0),
  autonomy: Schema.object({
    enabled: Schema.boolean().default(true),
    heartbeatMs: Schema.natural().default(30_000),
    exploration: Schema.object({
      enabled: Schema.boolean().default(false),
      sampleFloor: Schema.natural().default(30),
      budget: Schema.number().min(1),
      bonus: Schema.number().min(0).max(1),
      overrideRate: Schema.percent().default(0),
    }).default({} as any),
    fastPath: Schema.object({
      reuseModels: Schema.boolean().default(true),
    }).default({} as any),
  }).default({} as any),
  hostFusion: Schema.object({
    enabled: Schema.boolean().default(true),
    observeToolResults: Schema.boolean().default(true),
    governToolCalls: Schema.boolean().default(true),
    failureEscalationThreshold: Schema.natural().min(1).default(3),
  }).default({} as any),
});

/** 插件名称 */
export const name = 'dsh-proactive';

// ─────────────────────────── 插件主体 ───────────────────────────

/**
 * 插件入口：初始化全部模块、编排 10 步链路、注册 12 Tool、登记 cleanup
 */
export function apply(ctx: Context, config: Partial<SchedulerConfig>): void {
  const cfg = { ...DEFAULT_CONFIG, ...config } as SchedulerConfig;

  // strategistModel 完整性守卫（schema 层整体可选，指定时字段必须齐全）
  // schema 对缺省的嵌套对象会解析为 {}，故以"是否含任一字段"判定是否真正指定
  if (cfg.strategistModel && (cfg.strategistModel.id || cfg.strategistModel.endpoint)) {
    if (!cfg.strategistModel.id || !cfg.strategistModel.endpoint) {
      throw new ConfigError('strategistModel 配置不完整：指定时需同时提供 id 与 endpoint');
    }
  } else {
    cfg.strategistModel = undefined;
  }

  // ── DSH 宿主 LLM 能力解析（宿主优先、配置兜底）──
  // 宿主经 ctx 提供已配置好的 LLM 客户端 / 模型目录 / 请求头注入器，
  // 插件本身无需持有任何 API Key（DSH 自动注入用户配置的 Key）。
  const hostChat = resolveHostLLM(ctx);
  const hostModels = resolveHostModels(ctx);
  // 请求头注入优先级：DSH 宿主 ctx 注入 > 宿主本地密钥自动填入（环境变量/本地配置，健康感知路由）
  const ctxHeaderProvider = resolveHeaderProvider(ctx);
  const keyHealth = new KeyHealthManager(60_000, path.join(path.dirname(cfg.experienceStorePath), 'key-order.json'));
  const localKeyProvider = resolveLocalKeyProvider(keyHealth);
  const headerProvider = (modelId: string, keyAttempt = 0) =>
    (keyAttempt === 0 ? ctxHeaderProvider?.(modelId) : undefined) ?? localKeyProvider(modelId, keyAttempt);
  const mergedModels: ModelConfig[] = [...hostModels];
  for (const model of cfg.models ?? []) {
    if (!mergedModels.some((m) => m.id === model.id)) mergedModels.push(model);
  }
  if (!hostChat && mergedModels.length === 0) {
    throw new ConfigError('无可用模型：DSH 宿主未提供模型目录（ctx），且配置缺少 models 列表');
  }

  const logger = ctx.logger('scheduler');
  const dataDir = path.resolve(cfg.dataDir ?? '.scheduler');
  fs.mkdirSync(dataDir, { recursive: true });

  // ── 第四轮 R4-A17：模块域升级旗标（autonomy.modules.*，缺省全关）──
  // 构造配置式升级（sentinel/llm/crypto/meta/symbiosis）在下述构造点按片段
  // 注入（旗标关时片段为 {}，构造参数逐位不变）；attach 式升级集中在
  // 「模块域升级接线」区块（引擎全部构造完成后调用 attachPostConstructModuleUpgrades）。
  const modulesCfg: ModuleUpgradeFlags = cfg.autonomy?.modules ?? {};
  const pipelineCacheOn = cfg.autonomy?.pipeline?.crossStepCache?.enabled === true;
  const pipelineLadderOn = cfg.autonomy?.pipeline?.degradationLadder?.enabled === true;
  const pipelinePrefetchOn = cfg.autonomy?.pipeline?.stepPrefetch?.enabled === true;

  // ── 第三轮 A17：结构化审计设施（纯记录/登记容器，缺省开启、零行为影响）──
  // pipelineAudit：10 步链路检查点环形缓冲（步序/时长/关键决策值/结局）；
  // resources：fiber 资源清理审计注册表（卸载时逆序释放 + 漏释放检测）。
  const pipelineAudit = new PipelineAuditTrail({ capacity: 1024 });
  const resources = new ResourceRegistry();
  /** 批次序号（审计 trace id 的确定性来源） */
  let pipelineBatchSeq = 0;

  // ── 第四轮 R4-A17：主链路深化三件套（跨步骤缓存 / 降级阶梯 / 步骤预取）──
  // 容器恒建（纯记账零行为），读写仅在各旗标开启时发生——缺省全关 = 链路
  // 不经过任何深化路径，行为与升级前逐位一致（零漂移）。
  const pipelineStepCache = new PipelineStepCache(cfg.autonomy?.pipeline?.crossStepCache?.capacity ?? 256);
  const stepPrefetcher = new StepPrefetcher<Step5Trio>(() => pipelineStepCache.generation);
  /** 第 5 步降级触发计数（introspect 口径；旗标关恒 0） */
  let pipelineLadderDegradations = 0;

  // ── 基础层 ──
  const cryptoEngine = cfg.encryption?.enabled
    ? new CryptoEngine({
        enabled: true,
        masterKey: cfg.encryption.masterKey ?? CryptoEngine.generateKey(),
        algorithm: cfg.encryption.algorithm ?? 'aes-256-gcm',
        sensitiveFields: ['apiKey', 'masterKey', 'token'],
        fullFileEncryption: cfg.encryption.fullFileEncryption ?? true,
        // R4-A17 modules.cryptoTieredKeys：密钥分级（旗标关时片段 {}，零注入）
        ...cryptoModuleUpgradeConfig(modulesCfg),
      })
    : null;

  const memoryPath = path.resolve(cfg.experienceStorePath);
  fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
  const memory = new LongTermMemory(memoryPath, cryptoEngine ?? undefined);
  // 记忆图（记忆网络 + 主题树）：内存管理、JSON 序列化持久化，启动时加载
  const memoryGraph = new MemoryGraph(path.join(path.dirname(memoryPath), 'memory-graph.json'));

  let broadcaster: ProgressBroadcaster | null = null;
  if (cfg.enableProgress) {
    broadcaster = new ProgressBroadcaster(cfg.progressPort);
  }

  // ── LLM 客户端 ──
  // 宿主提供客户端时委托调用；否则仅注册端点，Key 由 headerProvider 注入请求头
  const llm = new LLMClient({
    timeout: cfg.llm?.timeout ?? 60_000,
    maxRetries: cfg.maxRetries,
    fetchImpl: cfg.llm?.fetchImpl,
    headerProvider,
    onKeyOutcome: (modelId, keyAttempt, success, status) => keyHealth.recordOutcome(modelId, keyAttempt, success, status),
    externalChat: hostChat,
    // 23.0 稳健延迟统计：启用后每模型维护 RobustStream（mean → MoM →
    // Catoni 随样本量自适应），getModelStatuses 输出 robustAvgLatencyMs /
    // robustLatencyMethod；未启用时不传（字段不出现，零漂移）
    ...(cfg.autonomy?.robustStatistics?.enabled === true
      ? { robustLatency: { alpha: cfg.autonomy.robustStatistics.alpha } }
      : {}),
    // R4-A17 modules.clientPriorityQueue：请求优先级队列（旗标关时片段 {}，零注入）
    ...clientModuleUpgradeConfig(modulesCfg),
  });
  for (const model of mergedModels) llm.registerModel(model);
  // strategist 模型确保已注册（决策调用专用）
  if (cfg.strategistModel && !llm.getModel(cfg.strategistModel.id)) {
    llm.registerModel({ id: cfg.strategistModel.id, endpoint: cfg.strategistModel.endpoint, apiKey: cfg.strategistModel.apiKey });
  }
  const strategistId = cfg.strategistModel?.id ?? mergedModels[0]?.id ?? llm.getModelIds()[0];
  if (hostChat) logger.info('LLM 调用已委托给 DSH 宿主客户端（Key 由宿主注入）');
  else logger.info('模型 Key 自动经请求头注入（优先级：宿主 ctx → 本地环境变量 → 本地配置文件，认证失败自动轮换）');
  for (const model of mergedModels) {
    const sources = describeKeySources(model.id);
    if (sources.length > 0) logger.info('模型 %s 密钥来源: %s', model.id, sources.join(', '));
  }

  // ── 24.0 差分隐私内核：遥测发布的预算记账（心智报告 / Sankey 能量流）──
  // 启用后对外视图的数值叶子经 Laplace 扰动（每次发布折半分账，几何级数
  // 保证总消耗 ≤ ε，超限返回 undefined 并保持原值）；id / 时间戳 / 计数类
  // 键自动跳过。未启用时 accountant 为 undefined，一切导出路径逐位不变。
  const privacyAccountant = cfg.autonomy?.privacy?.enabled === true
    ? new PrivacyAccountant({
        epsilon: cfg.autonomy.privacy.epsilon,
        delta: cfg.autonomy.privacy.delta,
      })
    : undefined;
  if (privacyAccountant) {
    logger.info(
      '24.0 差分隐私内核已启用：遥测数值发布经 Laplace 扰动（ε=%s, δ=%s）',
      cfg.autonomy?.privacy?.epsilon ?? 3.0,
      cfg.autonomy?.privacy?.delta ?? 1e-6,
    );
  }

  // ── 能力层 ──
  const tenantManager = new TenantManager(path.join(dataDir, 'tenants'), cryptoEngine ?? undefined);
  const benchmark = new BenchmarkEngine(path.join(dataDir, 'benchmarks'));
  const migrationTool = new MigrationTool(cfg.sync?.localNodeId ?? 'node-dev-01');

  // ── 协作层 ──
  const sync = new DistributedSync(
    cfg.sync?.localNodeId ?? 'node-dev-01',
    memory,
    path.join(dataDir, 'sync-state.json'),
    cryptoEngine,
  );
  for (const peer of cfg.sync?.peers ?? []) sync.registerNode(peer);

  let raft: RaftEngine | null = null;
  if (cfg.consensus?.enabled) {
    raft = new RaftEngine({
      localNodeId: cfg.consensus.localNodeId,
      cluster: cfg.consensus.cluster ?? [],
      electionTimeoutMin: cfg.consensus.electionTimeoutMin ?? 1500,
      electionTimeoutMax: cfg.consensus.electionTimeoutMax ?? 3000,
      heartbeatInterval: cfg.consensus.heartbeatInterval ?? 500,
      consensusPort: cfg.consensus.consensusPort ?? 9880,
      logPath: path.join(dataDir, 'raft-log.json'),
    });
  }

  let hotReload: HotReloadEngine | null = null;
  if (cfg.hotReload?.enabled) {
    hotReload = new HotReloadEngine({
      enabled: true,
      watchDirs: cfg.hotReload.watchDirs ?? ['src'],
      watchExtensions: cfg.hotReload.watchExtensions ?? ['.ts', '.tsx', '.js'],
      debounceMs: cfg.hotReload.debounceMs ?? 1000,
      buildCommand: cfg.hotReload.buildCommand ?? 'npm run build',
      distDir: cfg.hotReload.distDir ?? 'dist',
      entryFile: cfg.hotReload.entryFile ?? 'index.js',
      maxVersionHistory: cfg.hotReload.maxVersionHistory ?? 5,
      gracefulShutdownTimeout: cfg.hotReload.gracefulShutdownTimeout ?? 10_000,
      versionsDir: cfg.hotReload.versionsDir ?? path.join(dataDir, 'versions'),
      autoRollback: cfg.hotReload.autoRollback ?? true,
    });
  }

  // ── 集成层：决策引擎与反思引擎（闭环深度优化） ──
  const reflectionEngine = new ReflectionEngine({
    qualityThreshold: cfg.qualityThreshold,
    ...cfg.reflection,
    judge: cfg.judge,
    lessonExtractor: cfg.lessonExtractor,
  });
  reflectionEngine.setAlertHandler((alert) => {
    broadcast({ type: 'quality-alert', alertType: alert.type, message: alert.message, taskType: alert.taskType });
    logger.warn('质量告警: %s', alert.message);
  });

  // ── 优化器（记忆库 → 优化器 → 模型调度）：经验检索 + 快路径计划召回 ──
  // 第三阶段：policyProvider 桥接模型调度器的当前策略 → 推荐可追溯策略版本
  const optimizer = new Optimizer({
    memory,
    config: { memoryFastPathThreshold: cfg.memoryFastPathThreshold },
    broadcaster: broadcaster ?? undefined,
    graph: memoryGraph,
    policyProvider: () => modelScheduler.getPolicy(),
  });

  const decisionEngine = new DecisionEngine({
    ...cfg.decision,
    strategist: async (signals, history) => {
      // strategist 决策器：注入历史统计上下文，提升新信号决策质量
      const { data } = await llm.chatJSON<Array<{ id: string; urgency: number; decision: string; reason?: string; deferMs?: number }>>(
        strategistId,
        [
          { role: 'system', content: '你是调度系统的战略决策器。对每个信号评估紧急度(0~1)并决策: execute/defer/dismiss/ask-user。仅输出 JSON 数组。' },
          {
            role: 'user',
            content: JSON.stringify({
              signals: signals.map((s) => ({ id: s.id, type: s.type, description: s.description, occurrences: s.occurrences, urgency: s.urgency })),
              history: Object.fromEntries(history),
            }),
          },
        ],
        { timeout: 30_000, maxRetries: 1 },
      );
      const verdicts = new Map<string, { urgency: number; decision: any; reason?: string; deferMs?: number }>();
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item && typeof item.id === 'string') {
            verdicts.set(item.id, {
              urgency: Math.max(0, Math.min(1, Number(item.urgency) || 0.5)),
              decision: ['execute', 'defer', 'dismiss', 'ask-user'].includes(item.decision) ? item.decision : 'execute',
              reason: item.reason,
              deferMs: typeof item.deferMs === 'number' ? item.deferMs : undefined,
            });
          }
        }
      }
      return verdicts;
    },
  });

  // ── 模型调度器（新架构：优化器 → 模型调度；推荐模型优先采纳） ──
  // B 路线：能量反哺调度开关（缺省关闭——共生心跳把经济健康度折算为
  // 调度乘数注入这里；关闭时乘数恒为 1，评分与原逻辑逐位一致）
  const schedulingFeedbackEnabled = cfg.autonomy?.symbiosis?.enabled === true && (cfg.autonomy?.symbiosis?.schedulingFeedback?.enabled ?? false);
  const modelScheduler = new ModelScheduler({
    llm,
    memory,
    config: {
      costWeight: 0.2,
      economicFeedbackEnabled: schedulingFeedbackEnabled,
      // 新臂入场探索（τ2 结构学习的数据前提）：冷启动限定 UCB（预算 30）
      // 无法给中龄系统里的新模型首发流量——soak 与实测双重确认。
      // sampleFloor：每模型×任务类型积累 N 样本前保持探索加成。
      explorationEnabled: cfg.autonomy?.exploration?.enabled ?? true,
      exploreSampleFloor: cfg.autonomy?.exploration?.sampleFloor,
      exploreBudget: cfg.autonomy?.exploration?.budget,
      exploreBonus: cfg.autonomy?.exploration?.bonus,
    },
  });

  // ── 第三阶段（质级升级）：策略进化器 + 校准沙盒（「优化」本身可进化） ──
  // 沙盒任务集 = 历史回放（记忆库任务模式）+ 对抗合成（极端复杂/冷启动/特征密集/极简）；
  // 模型快照从 LLM 客户端运行时状态映射，评估全程离线，不阻塞操作环调度。
  // 质级升级：① 沙盒注入历史校准表（真实模型画像锚定模拟）；
  // ② 每轮进化前刷新任务集/校准/模型快照（进化素材与操作环同步）；
  // ③ 金丝雀观察窗喂数：决策反馈的真实成败/质量回报给进化器自动回滚/晋升。
  const policyEvolutionEnabled = cfg.autonomy?.policyEvolution?.enabled ?? true;
  /** 金丝雀喂数游标：仅消费尚未回报过的决策反馈（增量喂数） */
  let lastCanaryFeedAt = 0;
  const knownTaskTypes = () =>
    [...new Set(memory.getAllTaskPatterns().map((p) => p.fingerprint.split('::')[0]))].filter(Boolean);
  const buildSandboxTaskSet = () => [
    ...extractReplayTasks(memory),
    ...generateAdversarialTasks(knownTaskTypes()),
  ];
  const mapSimModels = (): SimModelStatus[] =>
    llm.getModelStatuses().map((s) => ({
      id: s.id,
      taskScores: s.taskScores,
      avgLatencyMs: s.avgLatency > 0 ? s.avgLatency : 800,
      avgTokens: s.totalCalls > 0 ? s.totalTokensUsed / s.totalCalls : 600,
      maxConcurrency: s.maxConcurrency,
    }));
  const policySandbox = new Sandbox({
    models: mapSimModels(),
    tasks: buildSandboxTaskSet(),
    config: {
      ...cfg.autonomy?.policyEvolution?.sandbox,
      calibration: buildCalibrationFromMemory(memory),
    },
  });
  const policyEvolver = new PolicyEvolver({
    ...cfg.autonomy?.policyEvolution,
    knownTaskTypes: knownTaskTypes(),
    persistPath: path.join(dataDir, 'policy-evolution.json'),
    onDeploy: (policy) => {
      // 热切换落地：评分函数参数即时生效（无需重启）；优化器随次检索自动标注新版本
      modelScheduler.updatePolicy(policy);
      broadcast({
        type: 'policy-deployed',
        policyId: policy.id,
        version: policy.version,
        generation: policy.generation,
        origin: policy.origin,
        params: policy.params,
      });
      logger.info(
        '策略进化部署: %s@v%d（第 %d 代，来源 %s）已热切换到操作环',
        policy.id,
        policy.version,
        policy.generation,
        policy.origin,
      );
    },
    onCanaryDecision: (decision) => {
      broadcast({ type: 'policy-canary', ...decision });
      logger[decision.action === 'rolled-back' ? 'warn' : 'info'](
        '金丝雀[%s]: 策略 %s → %s（%s）',
        decision.action,
        decision.policyId,
        decision.action === 'rolled-back' ? '自动回滚前一策略' : '晋升正式',
        decision.reason,
      );
    },
    onCycle: (cycle) => {
      broadcast({ type: 'policy-evolution-cycle', ...cycle });
    },
  });

  // ── 任务执行器（新架构：模型调度 → 任务执行；优化器喂入复用计划） ──
  // 4.0 弹性升级：模型级熔断（连续 5 次可用性失败隔离）+ 全抖动指数退避重试
  /** 第 9 步级联触发累计计数（审计口径——cascadeHandler 内纯计数，不改变回注行为） */
  let cascadeCount = 0;
  const taskExecutor = new TaskExecutor({
    config: {
      qualityThreshold: cfg.qualityThreshold,
      maxRetries: cfg.maxRetries,
      globalTimeout: cfg.globalTimeout,
      nodeTimeout: Math.min(120_000, cfg.globalTimeout),
      enableProgress: cfg.enableProgress,
      verbose: cfg.verbose,
      circuitFailureThreshold: 5,
      circuitCooldownMs: 60_000,
      retryBackoffBaseMs: 200,
      retryBackoffMaxMs: 8_000,
      // 创世纪 G4：推荐反垄断（缺省 0 零漂移；启用探索时按配置放开）
      explorationOverrideRate: cfg.autonomy?.exploration?.overrideRate ?? 0,
    },
    llm,
    modelScheduler,
    broadcaster: broadcaster ?? undefined,
    nodeRunner: cfg.nodeRunner,
    reflection: reflectionEngine,
    cascadeHandler: (newSignal) => {
      // 第 9 步级联触发 → 回注哨兵形成闭环
      cascadeCount += 1; // A17 审计计数（纯记录）
      sentinel.ingest({ ...newSignal, source: 'cascade' });
    },
  });

  // ── 反思器（任务执行 → 反思器 → 记忆更新）：复盘 + 沉淀 + 策略反馈 + 蒸馏 ──
  const reflector = new Reflector({
    memory,
    reflection: reflectionEngine,
    graph: memoryGraph,
    config: {
      enableProgress: cfg.enableProgress,
      onLesson: (lesson) => logger.info('教训沉淀 [%s]: %s', lesson.rootCause, lesson.lesson),
      onDistilled: (fresh) => logger.info('经验蒸馏产出 %d 条策略', fresh.length),
      // 第二阶段：知识蒸馏回调（语义+程序记忆产出）；升级：含证据合并/冲突取代统计与跳过说明
      onKnowledgeDistilled: (report) =>
        logger.info(
          '知识蒸馏: 语义 %d 条 / 程序 %d 条 / 策略 %d 条（来源情景 %d）%s',
          report.semanticMemories.length,
          report.proceduralMemories.length,
          report.strategies.length,
          report.sourceEpisodicCount,
          report.skipped
            ? `— ${report.summary}`
            : (report.mergedSemanticCount ?? 0) + (report.mergedProceduralCount ?? 0) + (report.supersededCount ?? 0) > 0
              ? `— 合并增强 语义${report.mergedSemanticCount ?? 0}/程序${report.mergedProceduralCount ?? 0}，冲突取代 ${report.supersededCount ?? 0}`
              : '',
        ),
    },
    broadcaster: broadcaster ?? undefined,
    onMemoryChange: (type, fingerprint, payload) => {
      sync.recordChange(type as any, fingerprint, payload);
    },
  });

  // ── 集成层：哨兵与 10 步链路编排 ──
  const sentinel = new Sentinel(
    {
      watchCodeChanges: cfg.sentinel?.watchCodeChanges ?? true,
      watchErrors: cfg.sentinel?.watchErrors ?? true,
      watchPerformance: cfg.sentinel?.watchPerformance ?? true,
      aggregationWindow: cfg.sentinel?.aggregationWindow ?? 0.5,
      signalSources: cfg.sentinel?.signalSources,
      watchDir: process.cwd(),
      // R4-A17 modules.sentinelAdaptive：自适应聚合窗口 v2 + 风暴预算共享
      //（旗标关时片段 {}，零注入——哨兵走既有固定窗口口径）
      ...sentinelModuleUpgradeConfig(modulesCfg),
    },
    (batch) => {
      // 火忘调用：processBatch 内部已逐信号 try/catch，此处兜底捕获
      // 循环前置阶段（决策引擎/记忆库读取）的异常，防止未处理拒绝
      processBatch(batch).catch((err) => {
        logger.error('信号批次处理失败: %s', (err as Error).message);
      });
    },
  );

  // ── 第四阶段：元认知层（自我建模 + 元认知控制——观察并改进进化机制本身） ──
  // 双环架构外环：内环 = 任务执行 → 反思 → 记忆 → 优化 → 策略进化（一~三阶段）；
  // 外环 = 自我建模（心智报告：策略优劣势/记忆健康/进化效率/稳定性/改进证据）
  // → 元认知控制器（保守调参 → 观察窗 → 判定保留/自动回滚，全程审计）。
  // 旋钮与真实组件联动：反思器蒸馏阈值、进化器变异率与门禁、
  // 沙盒严格度、优化器记忆快路径门槛——调整的是「进化机制」而非策略本身。
  const metaLayerEnabled = cfg.autonomy?.metaLayer?.enabled ?? true;
  /**
   * 2.0 稳态目标带（自我建模与元认知控制器共享）：
   * 配置后自我建模在心智报告中输出稳态带状态（in/near/out-of-band），
   * 元认知控制器据此自适应调整步长（偏离越远步长越大，量化档位）。
   */
  const DEFAULT_HOMEOSTASIS_BANDS: import('./meta/meta-types.js').HomeostasisBands = {
    operationalSuccessRate: { min: 0.8, max: 0.95 }, // 操作环成功率健康带
    discoveryRate: { min: 0.1, max: 0.3 }, // 进化发现速率健康带（过高=探索过热）
    survivalRate: { min: 0.7, max: 1.0 }, // 新策略存活率健康带
  };
  const selfModel = new SelfModel({
    collectors: {
      getEvolverStatus: () => policyEvolver.getStatus(),
      getMemoryStats: () => memory.dbStats(),
      getGlobalStats: () => memory.getGlobalStats(),
      getDistillationProgress: () => memory.getDistillationProgress?.(),
      getRecentFeedback: (limit) => memory.getRecentFeedback(limit),
      // 2.0：元认知层状态回注（学习器有效性 + 熔断器 + 安全包络 → 心智报告 metaStability/knobEffectiveness）
      getMetaLayerState: () => {
        if (!metaLayerEnabled) return undefined;
        const state = metaController.getState();
        return {
          knobEffectiveness: state.learner.effectiveness,
          metaStability: {
            circuitBreakers: state.circuitBreakers,
            globalFrozen: state.frozen,
            frozenByBreaker: state.frozenByBreaker,
            safeEnvelopes: state.safeEnvelopes,
            learner: {
              totalTrials: state.learner.totalTrials,
              arms: state.learner.arms,
              explorationWeight: state.learner.explorationWeight,
            },
          },
        };
      },
    },
    config: {
      homeostasisBands: DEFAULT_HOMEOSTASIS_BANDS,
      ...cfg.autonomy?.metaLayer?.selfModel,
      persistPath: path.join(dataDir, 'self-model-reports.json'),
    },
  });
  const metaController = new MetaCognitiveController({
    selfModel,
    knobs: [
      {
        id: 'reflector.autoDistillThreshold',
        label: '反思器自动蒸馏阈值',
        category: 'reflector',
        min: 2,
        max: 20,
        step: 1,
        integer: true,
        read: () => reflector.getConfig().autoDistillThreshold ?? 5,
        write: (v) => reflector.updateConfig({ autoDistillThreshold: v }),
        judgeMetric: 'pendingDistillation',
        higherIsBetter: false,
      },
      {
        id: 'reflector.distillMinConfidence',
        label: '知识蒸馏写入置信度门槛',
        category: 'reflector',
        min: 0.4,
        max: 0.8,
        step: 0.05,
        read: () => reflector.getConfig().distillMinConfidence ?? 0.6,
        write: (v) => reflector.updateConfig({ distillMinConfidence: v }),
        judgeMetric: 'proceduralGrowth',
        higherIsBetter: true,
      },
      {
        id: 'evolver.mutationRate',
        label: '进化器变异率',
        category: 'evolver',
        min: 0.2,
        max: 0.9,
        step: 0.1,
        read: () => policyEvolver.getTunableParams().mutationRate,
        write: (v) => policyEvolver.updateConfig({ mutationRate: v }),
        judgeMetric: 'discoveryRate',
        higherIsBetter: true,
      },
      {
        id: 'evolver.minGain',
        label: '进化器部署门禁（选择压力）',
        category: 'evolver',
        min: 0.001,
        max: 0.05,
        step: 0.005,
        read: () => policyEvolver.getTunableParams().minGain,
        write: (v) => policyEvolver.updateConfig({ minGain: v }),
        judgeMetric: 'survivalRate',
        higherIsBetter: true,
      },
      {
        id: 'sandbox.evaluationSeeds',
        label: '沙盒多种子评估严格度',
        category: 'sandbox',
        min: 1,
        max: 7,
        step: 1,
        integer: true,
        read: () => policySandbox.getConfig().evaluationSeeds ?? 3,
        write: (v) => policySandbox.updateConfig({ evaluationSeeds: v }),
        judgeMetric: 'survivalRate',
        higherIsBetter: true,
      },
      {
        id: 'optimizer.memoryFastPathThreshold',
        label: '记忆快路径复用门槛',
        category: 'memory',
        min: 0.7,
        max: 0.95,
        step: 0.05,
        read: () => optimizer.getConfig().memoryFastPathThreshold ?? 0.9,
        write: (v) => optimizer.updateConfig({ memoryFastPathThreshold: v }),
        judgeMetric: 'operationalSuccessRate',
        higherIsBetter: true,
      },
    ],
    config: {
      // 2.0：学习型稳态控制（稳态带与自我建模共享；用户配置覆盖优先）
      homeostasisBands: DEFAULT_HOMEOSTASIS_BANDS,
      maxStepMultiplier: 3,
      breakerThreshold: 2,
      globalBreakerThreshold: 3,
      proactiveEnabled: true,
      ...cfg.autonomy?.metaLayer?.controller,
      // R4-A17 modules.metaStabilityLoop：调参死区稳定环（旗标关时片段 {}，
      // 零注入——仅补 stabilityLoop 键，不覆盖 metaLayer.controller 其余配置）
      ...metaStabilityUpgradeConfig(modulesCfg),
      persistPath: path.join(dataDir, 'meta-controller-audit.json'),
      onAdjust: (entry) => {
        const { type: _kind, ...rest } = entry;
        broadcast({ type: 'meta-adjusted', ...rest });
        logger.info(
          '元认知调整: %s %s → %s（%s）',
          entry.knob ?? '',
          entry.from ?? '',
          entry.to ?? '',
          entry.reason,
        );
      },
      onCommit: (entry) => {
        const { type: _kind, ...rest } = entry;
        broadcast({ type: 'meta-committed', ...rest });
        logger.info('元认知判定保留: %s（%s）', entry.knob ?? '', entry.reason);
      },
      onRollback: (entry) => {
        const { type: _kind, ...rest } = entry;
        broadcast({ type: 'meta-rollback', ...rest });
        logger.warn('元认知回滚: %s %s → %s（%s）', entry.knob ?? '', entry.from ?? '', entry.to ?? '', entry.reason);
      },
    },
  });

  /** 延迟队列（defer 决策的信号） */
  const deferredQueue: Array<{ signal: Signal; deferUntil: number }> = [];

  // ── 自主智能层：目标引擎 / 元认知 / 策略进化 / 心跳循环 ──
  const autonomyEnabled = cfg.autonomy?.enabled ?? true;

  const goalEngine = new GoalEngine({
    ...cfg.autonomy?.goal,
    decomposer: cfg.autonomy?.decomposer,
  });

  const metaCognition = new MetaCognitionEngine({
    ...cfg.autonomy?.metaCognition,
    // 注入当前真实质量阈值读取器：successRate 退化的「放宽质量阈值」
    // 规则以实际阈值为基线（反射引擎动态阈值 → 全局配置兜底）
    getQualityThreshold: () => reflectionEngine.getCurrentThreshold() ?? cfg.qualityThreshold,
    applier: (action: TuningAction) => {
      // 元认知自调优落地：参数调整应用到真实引擎
      if (action.parameter === 'qualityThreshold') {
        reflectionEngine.setQualityThreshold(action.to);
        taskExecutor.updateConfig({ qualityThreshold: action.to });
      } else if (action.parameter === 'maxRetries') {
        taskExecutor.updateConfig({ maxRetries: action.to });
      } else if (action.parameter === 'aggregationWindow') {
        // 聚合窗口调整通过哨兵配置（此处仅记录，哨兵窗口在构造时固定）
      }
      broadcast({ type: 'meta-tuning', parameter: action.parameter, from: action.from, to: action.to, reason: action.reason });
      logger.info('元认知自调优: %s %s → %s（%s）', action.parameter, action.from, action.to, action.reason);
    },
  });

  const strategyEvolution = new StrategyEvolutionEngine({
    ...cfg.autonomy?.evolution,
  });

  // ── 自主智能扩展层：世界模型（预见）/ 好奇心（内在动机）/ 安全治理（边界） ──
  const worldModel = new WorldModel(cfg.autonomy?.worldModel);

  // ── 5.0 因果内核：全系统共享的因果图 + do-干预登记处 ──
  // 质变基座：evidence.ts 回答「它表现如何」（相关），本内核回答
  // 「是不是它造成的」（因果）。五处消费：共生 Shapley 分红、世界模型
  // 因果预见、反思引擎反事实教训、元认知因果旋钮排序、好奇心实验设计。
  const causalKernel = new CausalKernel(cfg.autonomy?.causalKernel);
  worldModel.attachCausalKernel(causalKernel);
  reflectionEngine.attachCausalKernel(causalKernel);
  metaCognition.attachCausalKernel(causalKernel);

  /** 知识提供器：桥接世界模型（接触面）与长期记忆（经验面）供好奇心扫描盲区 */
  const knowledgeProvider = {
    getExposure(): Record<string, number> {
      const exposure: Record<string, number> = {};
      for (const item of worldModel.getSummary().types) exposure[item.type] = item.totalCount;
      return exposure;
    },
    getExperienceCounts(): Record<string, number> {
      const counts: Record<string, number> = {};
      for (const pattern of memory.getAllTaskPatterns()) {
        const taskType = pattern.taskSummary.split(':')[0];
        counts[taskType] = (counts[taskType] ?? 0) + pattern.successfulPlans.length;
      }
      return counts;
    },
    getFailureRates(): Record<string, number> {
      const rates: Record<string, number> = {};
      for (const pattern of memory.getAllTaskPatterns()) {
        const taskType = pattern.taskSummary.split(':')[0];
        const total = pattern.successfulPlans.length + pattern.failureRecords.length;
        const rate = total > 0 ? pattern.failureRecords.length / total : 0;
        rates[taskType] = Math.max(rates[taskType] ?? 0, rate);
      }
      return rates;
    },
  };
  const curiosity = new CuriosityEngine(knowledgeProvider, cfg.autonomy?.curiosity);
  curiosity.attachCausalKernel(causalKernel);

  // ── 6.0 主动推断内核：全系统共享的自由能引擎 ──
  // 质变基座：把调度（利用）、探索（UCB）、好奇心（盲区）、健康度（KPI）
  // 四套互不通约的判据统一为一个变分目标 G(a) = 务实价值 − 认知价值。
  // 三处消费：调度器 EFE 模式、元认知统一自由能 KPI、共生变分漂移监测。
  // 缺省关闭（零漂移）；启用后探索预算由证据量内生推导，无需手设常数。
  const activeInferenceEnabled = cfg.autonomy?.activeInference?.enabled === true;
  const freeEnergyEngine = new FreeEnergyEngine({
    epistemicWeight: cfg.autonomy?.activeInference?.epistemicWeight,
  });
  metaCognition.attachFreeEnergyEngine(freeEnergyEngine);

  // ── 7.0 深思内核：规划即推断（转移模型 + 想象推演 + 技能库） ──
  // 质变基座：把单步 EFE 沿时间维展开——从「选最好的一步」到「选最好
  // 的余生」。计划执行后 settle 对账：转移模型学习 + 感知惊奇回流 +
  // 梦校准 KPI + 成功计划蒸馏为技能（时间抽象）。
  const deliberationEngine = new DeliberationEngine(
    { epistemicWeight: cfg.autonomy?.activeInference?.epistemicWeight },
    freeEnergyEngine,
  );
  metaCognition.attachDeliberationEngine(deliberationEngine);
  optimizer.attachDeliberation(deliberationEngine);

  // ── 8.0 元推理内核：理性元推理（计算即行动，思考有价格） ──
  // 质变基座：把「想多深」本身变成决策——双过程仲裁（习惯/反应/深思），
  // 任意时搜索按首行动稳定性早停，思考按 nat 计价入认知经济 KPI；
  // 结算回流驱动元学习（反应失手收紧门槛、深思成功晋升习惯）。
  const metareasoner = new RationalMetareasoner(deliberationEngine, {
    decisivenessGap: cfg.autonomy?.metareasoning?.decisivenessGap,
    sufficientEvidence: cfg.autonomy?.metareasoning?.sufficientEvidence,
    habitPromotionSuccesses: cfg.autonomy?.metareasoning?.habitPromotionSuccesses,
    maxDepth: cfg.autonomy?.metareasoning?.maxDepth,
    natPerNode: cfg.autonomy?.metareasoning?.natPerNode,
    budgetNat: cfg.autonomy?.metareasoning?.budgetNat,
  });
  metaCognition.attachMetareasoner(metareasoner);
  optimizer.attachMetareasoner(metareasoner);

  // ── 9.0 抽象内核：类比结构映射（经验跨域流动） ──
  // 质变基座：状态分解为 域#骨架——保关系、换对象。结构同构的域
  // 互为类比证人（Jaccard 域画像），冷状态零样本借用别域后验，
  // 后继结构继承让「陷阱类经验」跨域复用，整体计划跨域成功晋升
  // 抽象技能。缺省关闭；均匀层与 Beta(1,1) 严格等价（零数据零漂移）。
  if (cfg.autonomy?.abstraction?.enabled === true) {
    const abstractionEngine = new AbstractionEngine({
      analogyStrength: cfg.autonomy?.abstraction?.analogyStrength,
      minSimilarity: cfg.autonomy?.abstraction?.minSimilarity,
      abstractSkillDomains: cfg.autonomy?.abstraction?.abstractSkillDomains,
    });
    deliberationEngine.attachAbstraction(abstractionEngine);
    metaCognition.attachAbstractionEngine(abstractionEngine);
  }

  // ── 10.0 科学家内核：最优实验设计（知识获取的经济学） ──
  // 质变基座：把「学什么」本身变成决策——Lindley EIG 定价每次实验
  // 的期望知识（nat），混杂分歧（观测≠干预）获得实验独占加成，
  // netValue = EIG − cost 的预算仲裁拒绝赔本实验；信息台账对账
  // 「承诺 vs 兑现」，知识前沿 KPI 审计知识版图的收缩。缺省关闭
  // （零漂移——不登记问题即无设计）；启用后好奇心实验建议升级为
  // EIG 口径，健康报告携带知识前沿。
  let scientistAutoRegister = false;
  const scientistCfg = cfg.autonomy?.scientist;
  const scientistMind =
    scientistCfg?.enabled === true
      ? new ScientistMind(causalKernel, freeEnergyEngine, {
          defaultCostNat: scientistCfg.defaultCostNat,
          maxConfoundingBonus: scientistCfg.maxConfoundingBonus,
          lawBonusCap: scientistCfg.lawBonusCap,
        })
      : undefined;
  if (scientistMind) {
    metaCognition.attachScientistMind(scientistMind);
    curiosity.attachScientistMind(scientistMind);
    // 热点自动登记：调度器结算的 (贡献者 → task.outcome) 边入问题空间
    scientistAutoRegister = scientistCfg?.autoRegisterQuestions === true;
  }

  // ── 11.0 理论内核：从数据到定律（知识的压缩与体系化） ──
  // 质变基座：层级贝叶斯把同族 K 条边压缩为一条定律（借力收缩，
  // 定律区间窄于任何单边）；MDL 用 nat 给「理解即压缩」定价——
  // compression ≤ 0 的定律不配存在；作用域内的新边零样本继承
  // 全族知识；反常者驱逐、定律重建（范式转移）。科学家的问题
  // 在定律作用域内获得定律试验加成（一次实验校准整个作用域）。
  // 缺省关闭（零漂移）；归纳是因果图的纯函数，确定性可重放。
  const theoristCfg = cfg.autonomy?.theorist;
  const theoristEngine =
    theoristCfg?.enabled === true
      ? new TheoristEngine(causalKernel, {
          minMembers: theoristCfg.minMembers,
          zeroShotMaxArmSamples: theoristCfg.zeroShotMaxArmSamples,
        })
      : undefined;
  if (theoristEngine) {
    metaCognition.attachTheoristEngine(theoristEngine);
    scientistMind?.attachTheorist(theoristEngine);
  }

  // ── 12.0 任意时刻证据内核：结论永不夸大的统计 ──
  // 质变基座：固定样本统计在「边看边停」场景（进化淘汰、退化判定）
  // 会累积假阳性（偷看悖论）。启用后：进化适应度改用任意时刻有效
  // 置信序列下界，基因组淘汰走 e-BH FDR 控制（冤案率有数学上限）；
  // 元认知 KPI 保证层以 e-过程确证退化（任意时刻读取均合法）。
  // 缺省关闭（零漂移）；启用后「随时下结论且结论永不夸大」。
  if (cfg.autonomy?.anytimeEvidence?.enabled === true) {
    strategyEvolution.attachAnytimeEvidence({
      alpha: cfg.autonomy.anytimeEvidence.alpha,
      reference: cfg.autonomy.anytimeEvidence.reference,
    });
    metaCognition.attachAnytimeGuards({ alpha: cfg.autonomy.anytimeEvidence.alpha });
  }

  // ── 13.0 保形校准内核：预测与阈值的分布无关保证 ──
  // 质变基座：世界模型的 sqrt(λ) 泊松区间没有覆盖率保证；反思引擎
  // ±0.02 步进阈值没有风险保证。启用后：预测区间升级为分裂保形区间
  // （精确有限样本覆盖 ≥ 1−α，零分布假设），阈值自校准升级为风险
  // 受控选择（P(未来重试率 ≤ targetRisk) ≥ confidence——重试风暴
  // 在数学上被封顶）。缺省关闭（回退既有口径，零漂移）。
  const conformalCfg = cfg.autonomy?.conformal;
  if (conformalCfg?.enabled === true) {
    const conformalEngine = new ConformalIntervalEngine({
      alpha: conformalCfg.alpha,
      maxCalibration: conformalCfg.maxCalibration,
    });
    worldModel.attachConformalCalibrator(conformalEngine);
    reflectionEngine.attachRiskController({
      targetRisk: conformalCfg.thresholdTargetRisk,
      confidence: conformalCfg.thresholdConfidence,
    });
  }

  // ── 14.0 质量-多样性内核：行为流派不灭 ──
  // 质变基座：纯 UCB 探索必然坍缩到单一最优流派（局部最优陷阱）。
  // 启用后 selectGenome 以 exploreRate 概率从 MAP-Elites 行为归档
  // 均匀采样——敢为/节俭/警觉各流派获得等量试验预算，演化报告
  // 携带 coverage/QD-score 多样性审计。缺省关闭（零漂移）。
  if (cfg.autonomy?.qualityDiversity?.enabled === true) {
    strategyEvolution.attachQualityDiversity({
      exploreRate: cfg.autonomy.qualityDiversity.exploreRate,
    });
  }

  if (activeInferenceEnabled) {
    modelScheduler.attachFreeEnergy(freeEnergyEngine);
    modelScheduler.updateConfig({
      freeEnergyEnabled: true,
      freeEnergyPreference: cfg.autonomy?.activeInference?.schedulingPreference,
    });
  }

  const governor = new SafetyGovernor(cfg.autonomy?.governor);

  // ── 15.0 运行时验证内核：安全规约形式化 ──
  // 质变基座：治理器的标量门控表达不了时序性质（「熔断开后 10 分钟
  // 必须恢复」「失败风暴 60 秒 ≤ 5 次」）。启用后治理器迁移事件流
  // 自动喂入 LTLf 规约监视器（确定性可重放），critical 违规自动触发
  // Kill Switch——形式裁决获得治理的牙齿，违规报告携带见证轨迹。
  // 缺省关闭（零漂移——不挂载即不监视）。
  if (cfg.autonomy?.runtimeVerification?.enabled === true) {
    const verifier = governor.attachRuntimeVerifier();
    for (const spec of cfg.autonomy.runtimeVerification.specs ?? []) {
      verifier.register(spec);
    }
  }

  // ── 21.0 最优索引调度内核：候选排序的可证明最优口径 ──
  // 质变基座：UCB 是乐观置信上界启发式、EFE 是变分近似，Gittins 索引是
  // 折扣 bandit 的可证明最优策略（Weber 1992 对 Bernoulli+Beta 情形）。
  // 启用后调度器动态选型对每个候选的 Beta 后验精确计算 ν(a,b)（退休
  // MDP 三角形反向归纳，无需不动点迭代），按 effectiveIndex = ν ×
  // availability 排序取榜首；学习溢价随证据积累自动归零（探索自我
  // 终结，无需手设探索预算）。缺省关闭（零漂移——不挂载即原路径；
  // preferred 短路与 avoidModels 语义不变）。
  if (cfg.autonomy?.indexScheduling?.enabled === true) {
    const indexScheduler = new IndexScheduler(
      new GittinsIndexTable({
        discount: cfg.autonomy.indexScheduling.discount,
        maxCount: cfg.autonomy.indexScheduling.maxCount,
      }),
    );
    modelScheduler.attachIndexScheduler(indexScheduler);
    logger.info(
      '21.0 最优索引调度内核已挂载：Gittins 指数精确计算（discount=%s, maxCount=%s）',
      cfg.autonomy.indexScheduling.discount ?? 0.95,
      cfg.autonomy.indexScheduling.maxCount ?? 48,
    );
  }

  // ── 22.0 预算最优路由内核：Bandits with Knapsacks ──
  // 质变基座：固定 costWeight 只是影子价格 λ 的一次性猜测，本内核让
  // 预算约束直接参与在线选臂：质量走经验伯恩斯坦乐观上界（复用 12.0），
  // 可行性按「剩余预算/剩余轮数」×(1+slack) 判定，λ 从不可行高质臂与
  // 选中臂的混合 LP 顶点内生涌现；无可行臂时选最廉臂止血（负载卸载，
  // 而非假装最优仍存在）。治理器未配置预算时 budgetSnapshot() 恒
  // undefined，路由不介入（走原路径）。缺省关闭（零漂移）。
  if (cfg.autonomy?.banditKnapsack?.enabled === true) {
    const bwKRouter = new BwKRouter({
      ucbAlpha: cfg.autonomy.banditKnapsack.ucbAlpha,
      feasibilitySlack: cfg.autonomy.banditKnapsack.feasibilitySlack,
      horizonDefault: cfg.autonomy.banditKnapsack.horizonDefault,
    });
    modelScheduler.attachBwKRouter(bwKRouter, () => governor.budgetSnapshot());
    logger.info(
      '22.0 预算最优路由内核已挂载：Bandits with Knapsacks（ucbAlpha=%s, feasibilitySlack=%s, horizonDefault=%s）',
      cfg.autonomy.banditKnapsack.ucbAlpha ?? 0.05,
      cfg.autonomy.banditKnapsack.feasibilitySlack ?? 0.25,
      cfg.autonomy.banditKnapsack.horizonDefault ?? 100,
    );
  }

  // ── 17.0 最优传输内核：漂移检测看见分布的形状 ──
  // 质变基座：12.0 的 e-过程 / 置信序列盯的是均值水位——均值不变、
  // 形状巨变的分布（双峰化 / 尾部变厚）完全隐形。启用后元认知挂载
  // Wasserstein-1 形状漂移监视（滑动窗 vs 基准窗 + 历史分位自适应
  // 阈值）：「水平没变但世界换了」第一次可见；保形区间（13.0）的
  // 覆盖前提在漂移下失效——本内核是其绊线。缺省关闭（零漂移）。
  if (cfg.autonomy?.optimalTransport?.enabled === true) {
    metaCognition.attachTransportDrift({
      kpis: cfg.autonomy.optimalTransport.kpis,
      windowSize: cfg.autonomy.optimalTransport.windowSize,
      referenceSize: cfg.autonomy.optimalTransport.referenceSize,
      thresholdQuantile: cfg.autonomy.optimalTransport.thresholdQuantile,
      minSamples: cfg.autonomy.optimalTransport.minSamples,
    });
  }

  // ── 18.0 信息几何内核：进化在流形上行走 ──
  // 质变基座：坐标轴独立变异把「坐标怎么标」当成「空间怎么弯」，
  // 基因间相关结构不可见、步长无信息单位。启用后策略变异升级为
  // Fisher 流形自然变异：种群协方差主轴联合相关步（有利基因组合
  // 完整传递）+ KL 信任域（步长以 nat 计价，仿射重参数化不变）。
  // 缺省关闭（零漂移——原坐标高斯变异）。
  if (cfg.autonomy?.informationGeometry?.enabled === true) {
    strategyEvolution.attachInformationGeometry({
      klBudget: cfg.autonomy.informationGeometry.klBudget,
      stepScale: cfg.autonomy.informationGeometry.stepScale,
    });
  }

  // ── 19.0 最优停止内核：等待有了数学价格 ──
  // 质变基座：规则 C 的「urgency < 0.3 且成本 > 5000 → defer 5 分钟」
  // 是无最优性依据的魔数。启用后高成本信号是否现在占坑由继续价值
  // 裁决：紧急度流经验分布 + 向后归纳精确阈值 V_{horizon}（先知
  // 不等式审计成色）——defer 从「不敢做」升维为「等下一个机会期望
  // 更优」。缺省关闭（零漂移——原魔数规则）。
  if (cfg.autonomy?.optimalStopping?.enabled === true) {
    decisionEngine.attachOptimalStopper({
      horizon: cfg.autonomy.optimalStopping.horizon,
      minSamples: cfg.autonomy.optimalStopping.minSamples,
    });
  }

  // ── 20.0 层论共识内核：分歧的形状可见（Tool 注册见下方 tool 列表） ──

  // ── 26.0 高斯过程内核：预测校准从魔数到学习修正 ──
  // 质变基座：趋势修正 1.25/0.75 与时段热度是「拍脑袋的世界观」；
  // 本内核让「预测系统性偏差多少」从校准对账史里学出来——
  // actual/predicted 比值序列经 GP 回归给出带不确定度的乘性修正因子，
  // 有漂移时跟踪、无漂移时收敛到 1。校准史不足时因子恒 1（零漂移）。
  if (cfg.autonomy?.gaussianProcess?.enabled === true) {
    worldModel.attachGpCalibrator({
      maxPoints: cfg.autonomy.gaussianProcess.maxPoints,
      sigmaN: cfg.autonomy.gaussianProcess.sigmaN,
      minPoints: cfg.autonomy.gaussianProcess.minPoints,
    });
    logger.info(
      '26.0 高斯过程内核已挂载：预测校准 GP 修正（maxPoints=%s, minPoints=%s）',
      cfg.autonomy.gaussianProcess.maxPoints ?? 48,
      cfg.autonomy.gaussianProcess.minPoints ?? 6,
    );
  }

  // ── 27.0 卡尔曼滤波内核：KPI 异常判定的假设检验口径 ──
  // 质变基座：z-score 是窗口内无记忆比较，阈值是经验拍定；本内核把
  // 整条历史压进 (level, slope) 充分统计量，突变判定 = 新息 NIS 超出
  // χ²(1) 99.7% 分位（假设检验），缓慢漂移由滤波斜率早期读出。
  // 缺省关闭（零漂移——原 z-score 路径）。
  if (cfg.autonomy?.kalmanFilter?.enabled === true) {
    metaCognition.attachKalmanAnomaly({
      qLevel: cfg.autonomy.kalmanFilter.qLevel,
      qSlope: cfg.autonomy.kalmanFilter.qSlope,
      r: cfg.autonomy.kalmanFilter.r,
      gateP: cfg.autonomy.kalmanFilter.gateP,
      kpis: cfg.autonomy.kalmanFilter.kpis,
    });
    logger.info(
      '27.0 卡尔曼滤波内核已挂载：KPI 新息门控（gateP=%s, 覆盖 %s）',
      cfg.autonomy.kalmanFilter.gateP ?? 0.997,
      (cfg.autonomy.kalmanFilter.kpis ?? ['successRate', 'avgQuality', 'avgLatency', 'cacheHitRate']).join('/'),
    );
  }

  // ── 29.0 MCTS 内核：深思推荐的序贯决策口径 ──
  // 质变基座：beam search 的宽度是资源上限，搜索预算分配本身不是决策；
  // UCT 把预算分配变成序贯决策（UCB1 平衡利用/探索），迭代耗尽即读出。
  // 启用后 optimizer 深思推荐切至 searchMcts（报告口径与 beam 一致）。
  // 缺省关闭（零漂移——原 beam search）。
  if (cfg.autonomy?.mcts?.enabled === true) {
    optimizer.attachMctsSearch({
      iterations: cfg.autonomy.mcts.iterations,
      explorationC: cfg.autonomy.mcts.explorationC,
      discount: cfg.autonomy.mcts.discount,
    });
    logger.info(
      '29.0 MCTS 内核已挂载：深思推荐切换 UCT（iterations=%s, explorationC=%s）',
      cfg.autonomy.mcts.iterations ?? 600,
      cfg.autonomy.mcts.explorationC ?? Math.SQRT2,
    );
  }

  // ── 30.0 次模内核：探索预算的组合最优分配 ──
  // 质变基座：新颖度 top-k 是模函数口径（重复购买相关知识）；
  // 加权覆盖惰性贪心（CELF）给预算分配第一个近似比保证（≥ (1−1/e)·OPT），
  // 同主题盲区边际自动衰减。缺省关闭（零漂移——原 top-k）。
  if (cfg.autonomy?.submodular?.enabled === true) {
    curiosity.attachSubmodularSelector({
      coverageStrength: cfg.autonomy.submodular.coverageStrength,
    });
    logger.info(
      '30.0 次模内核已挂载：探索预算加权覆盖贪心（coverageStrength=%s）',
      cfg.autonomy.submodular.coverageStrength ?? 0.7,
    );
  }

  // ── 31.0 对抗组合内核：调度权重的无悔学习 ──
  // 质变基座：Wilson/UCB/Gittins 全部假设世界是平稳概率分布；多模型
  // 现实是对抗 / 非平稳的（限流、静默降级、周节律）。Fixed-Share Hedge
  // 叠加有界乘数（[0.25,4]）：对事后最优固定模型的遗憾 ≤ √(2T lnN)，
  // 对手无论怎么出招都成立；α 回灌保证模型能力翻转可跟踪。
  // 缺省关闭（零漂移——乘数恒 1）。
  if (cfg.autonomy?.hedgePortfolio?.enabled === true) {
    modelScheduler.attachHedgePortfolio({
      eta: cfg.autonomy.hedgePortfolio.eta,
      alpha: cfg.autonomy.hedgePortfolio.alpha,
    });
    logger.info(
      '31.0 对抗组合内核已挂载：Fixed-Share Hedge（eta=%s, alpha=%s）',
      cfg.autonomy.hedgePortfolio.eta ?? 0.3,
      cfg.autonomy.hedgePortfolio.alpha ?? 0.05,
    );
  }

  // ── 32.0 全局指派内核：批内选型从局部贪心到全局最优 ──
  // 质变基座：同批节点逐个调用调度器 = 局部贪心，最优模型被重复超订、
  // 次优闲置；匈牙利算法在「节点 × 候选」收益矩阵上求全局总收益最优
  // 一对一指派（O(n³) 精确解，携带对偶证书）。约束节点（计划指定 /
  // 优化器推荐）优先不动，只协调无约束节点。缺省关闭（零漂移——逐节点）。
  if (cfg.autonomy?.optimalAssignment?.enabled === true) {
    taskExecutor.attachOptimalAssignment({
      candidateCap: cfg.autonomy.optimalAssignment.candidateCap,
    });
    logger.info(
      '32.0 全局指派内核已挂载：批内匈牙利最优指派（candidateCap=%s）',
      cfg.autonomy.optimalAssignment.candidateCap ?? 8,
    );
  }

  // ── 34.0 分布鲁棒内核：超时预算的最坏尾部定价 ──
  // 质变基座：固定超时魔数对重尾模型雪崩（一刀切的过紧）、对轻尾模型
  // 浪费（过松保守）；margin × CVaR_α(延迟史) 让尾部形状直接进入价格。
  // 样本不足时逐位回退全局缺省（零漂移）。缺省关闭。
  if (cfg.autonomy?.cvarTimeouts?.enabled === true) {
    llm.attachCvarTimeouts({
      alpha: cfg.autonomy.cvarTimeouts.alpha,
      margin: cfg.autonomy.cvarTimeouts.margin,
      minSamples: cfg.autonomy.cvarTimeouts.minSamples,
      floorMs: cfg.autonomy.cvarTimeouts.floorMs,
      capMs: cfg.autonomy.cvarTimeouts.capMs,
    });
    logger.info(
      '34.0 分布鲁棒内核已挂载：CVaR 超时预算（alpha=%s, margin=%s, minSamples=%s）',
      cfg.autonomy.cvarTimeouts.alpha ?? 0.95,
      cfg.autonomy.cvarTimeouts.margin ?? 1.5,
      cfg.autonomy.cvarTimeouts.minSamples ?? 30,
    );
  }

  // ── 35.0 反馈控制内核：并发上限的闭环驾驭 ──
  // 质变基座：25.0 排队论反解出静态目标并发，但负载非平稳；LQR 闭环
  // （DARE 闭式增益 + Lyapunov 稳定证书 + 死区抗抖振 + 钳位抗饱和）
  // 让 computeParallelism 成为追踪目标的反馈控制器。缺省关闭（零漂移）。
  if (cfg.autonomy?.concurrencyControl?.enabled === true) {
    modelScheduler.attachConcurrencyController({
      target: cfg.autonomy.concurrencyControl.target,
      plantGain: cfg.autonomy.concurrencyControl.plantGain,
      r: cfg.autonomy.concurrencyControl.r,
      deadband: cfg.autonomy.concurrencyControl.deadband,
    });
    logger.info(
      '35.0 反馈控制内核已挂载：并发闭环 LQR（target=%s, plantGain=%s）',
      cfg.autonomy.concurrencyControl.target ?? 0.75,
      cfg.autonomy.concurrencyControl.plantGain ?? 0.4,
    );
  }

  // ── 37.0 信息瓶颈内核：蒸馏门槛从水位到信息量 ──
  // 质变基座：水位计数只能保证「样本够多」，不能保证「样本不同质」；
  // IB 保留率 I(T;Y)/I(X;Y)（Blahut-Arimoto 收敛）给「值得蒸馏的新
  // 信息」定价——同构样本诚实跳过（below-information）。
  // 缺省关闭（零漂移——原水位单门）。
  if (cfg.autonomy?.informationBottleneck?.enabled === true) {
    reflector.attachBottleneckDistiller({
      beta: cfg.autonomy.informationBottleneck.beta,
      retentionFloor: cfg.autonomy.informationBottleneck.retentionFloor,
    });
    logger.info(
      '37.0 信息瓶颈内核已挂载：蒸馏信息定价（beta=%s, retentionFloor=%s）',
      cfg.autonomy.informationBottleneck.beta ?? 5,
      cfg.autonomy.informationBottleneck.retentionFloor ?? 0.4,
    );
  }

  // ── 38.0 非线性动力学内核：KPI 的体质分类 ──
  // 质变基座：异常检测都在问「现在正常吗」，没人问「这条序列是什么
  // 体质」——混沌（λ₁>0，视野 ~1/λ₁）/ 持续（H>0.5，动量）/ 反持续
  // （H<0.5，回归）。同一份 KPI，三种读法。缺省关闭（零漂移）。
  if (cfg.autonomy?.chaosDiagnostics?.enabled === true) {
    metaCognition.attachChaosDiagnostics({
      minPoints: cfg.autonomy.chaosDiagnostics.minPoints,
      lambdaThreshold: cfg.autonomy.chaosDiagnostics.lambdaThreshold,
      hurstDelta: cfg.autonomy.chaosDiagnostics.hurstDelta,
    });
    logger.info(
      '38.0 非线性动力学内核已挂载：KPI 体质分类（minPoints=%s, λ阈值=%s）',
      cfg.autonomy.chaosDiagnostics.minPoints ?? 96,
      cfg.autonomy.chaosDiagnostics.lambdaThreshold ?? 0.05,
    );
  }

  // ── 39.0 谱排序内核：知识图的影响力骨架 ──
  // 质变基座：联想检索按边权排序是局部口径；PageRank 把「被重要者
  // 共现者重要」写成不动点（幂迭代线性收敛，质量守恒可逐位检查）——
  // related() 升维为影响力加权，知识骨架成为蒸馏保骨去肉的依据。
  // 缺省关闭（零漂移——原边权序）。
  if (cfg.autonomy?.spectralRanking?.enabled === true) {
    memoryGraph.attachInfluenceRanking({ damping: cfg.autonomy.spectralRanking.damping });
    logger.info(
      '39.0 谱排序内核已挂载：知识图 PageRank 骨架（damping=%s）',
      cfg.autonomy.spectralRanking.damping ?? 0.85,
    );
  }

  // ── 40.0 首达时间内核：熔断冷却的概率定价 ──
  // 质变基座：冷却定值是魔数；失败间隔序列的漂移/波动喂入逆高斯
  // 首达模型，「以 target 概率确信已恢复」的最小等待被解出来——
  // 过早重试 = 高概率再次击穿，过晚 = 无谓损失，两者都有了价格。
  // 建议口径（半开时序仍由状态机治理）。缺省关闭（零记录零介入）。
  if (cfg.autonomy?.firstPassageCooldown?.enabled === true) {
    governor.attachFirstPassageAdvisor({
      targetProb: cfg.autonomy.firstPassageCooldown.targetProb,
    });
    logger.info(
      '40.0 首达时间内核已挂载：熔断冷却定价（targetProb=%s）',
      cfg.autonomy.firstPassageCooldown.targetProb ?? 0.9,
    );
  }

  // ── 42.0 谱周期内核：到达节律从数据里解出来 ──
  // 质变基座：时段热度是「周期被预设为一天」的小时直方图；FFT 周期图 +
  // Fisher g 检验让周期成为数据问题（分钟回环/昼夜/周节律一视同仁），
  // 显著时用相位感知的谐波季节因子。不显著时逐位回退原口径。
  // 缺省关闭（零漂移）。
  if (cfg.autonomy?.spectralCalendar?.enabled === true) {
    worldModel.attachSpectralCalendar({ bins: cfg.autonomy.spectralCalendar.bins });
    logger.info(
      '42.0 谱周期内核已挂载：FFT 周期图 + Fisher g 节律检验（bins=%s）',
      cfg.autonomy.spectralCalendar.bins ?? 128,
    );
  }

  // ── 43.0 最大流内核：吞吐上限与瓶颈归因 ──
  // 质变基座：可行并发不是各模型上限的简单求和，是流网络的值；
  // min-cut 指认钳制者（类型在饿 / 模型独木桥），割容量 = 流值是证书。
  // 纯诊断口径（执行批回写需求），缺省关闭（零漂移）。
  if (cfg.autonomy?.capacityFrontier?.enabled === true) {
    modelScheduler.attachCapacityFrontier();
    logger.info('43.0 最大流内核已挂载：容量前沿诊断（max-flow / min-cut 归因）');
  }

  // ── 44.0 公平分配内核：探索预算的域级极大极小 ──
  // 质变基座：新颖度 top-k 是赢者通吃（冷门域长期饿死）；加权注水保证
  // 任何活跃域的相对份额不被压扁（词典序最优）——探索覆盖有公平定理。
  // 缺省关闭（零漂移——原 top-k / 次模路径）。
  if (cfg.autonomy?.fairBudget?.enabled === true) {
    curiosity.attachFairBudget();
    logger.info('44.0 公平分配内核已挂载：探索预算加权极大极小注水');
  }

  // ── 45.0 OCBA 预算分配内核：基准瓶颈确认的最优预算 ──
  // 质变基座：均匀重跑浪费（差距大的场景早该停）；OCBA 让 P(正确选中
  // 瓶颈) 的指数衰减率最优——每一步确认预算花在刀刃上。纯报告口径。
  // 缺省关闭（零漂移）。
  if (cfg.autonomy?.ocbaAllocator?.enabled === true) {
    benchmark.attachOcbaAllocator({ confirmationBudget: cfg.autonomy.ocbaAllocator.confirmationBudget });
    logger.info(
      '45.0 OCBA 内核已挂载：基准瓶颈聚焦（confirmationBudget=%s）',
      cfg.autonomy.ocbaAllocator.confirmationBudget ?? 200,
    );
  }

  // ── 49.0 多尺度内核：KPI 的尺度透镜 ──
  // 质变基座：单尺度异常检测分不清「慢漂移」与「快突发」；Haar 小波
  // 把序列分解为对数个正交尺度（能量守恒 + 完美重构）。纯读数口径。
  // 缺省关闭（零漂移）。
  if (cfg.autonomy?.waveletView?.enabled === true) {
    metaCognition.attachWaveletView({ minPoints: cfg.autonomy.waveletView.minPoints });
    logger.info(
      '49.0 多尺度内核已挂载：KPI 小波视图（minPoints=%s）',
      cfg.autonomy.waveletView.minPoints ?? 64,
    );
  }

  // ── 50.0 矩阵补全内核：冷启动能力的潜维度外推 ──
  // 质变基座：新模型 taskScores 空白 → 只能瞎选；能力矩阵低秩（少数
  // 潜维度决定）时，少量观测即可 ALS 补全全矩阵——冷启动选型从零
  // 样本升级为潜维度预测。纯诊断口径（coldStartEstimate 按需读取）。
  // 缺省关闭（零漂移）。
  if (cfg.autonomy?.latentFactors?.enabled === true) {
    modelScheduler.attachLatentFactors({ rank: cfg.autonomy.latentFactors.rank });
    const report = modelScheduler.getLatentFactorReport();
    logger.info(
      '50.0 矩阵补全内核已挂载：能力潜因子（rank=%s, lowRankShare=%s）',
      cfg.autonomy.latentFactors.rank ?? 3,
      report ? report.lowRankShare.toFixed(2) : '—',
    );
  }

  /** KPI 采集器：从真实引擎状态聚合 KPI 快照 */
  const collectKpi = () => {
    const modelStatuses = llm.getModelStatuses();
    const modelSuccessRates: Record<string, number> = {};
    let activeExecutions = 0;
    for (const status of modelStatuses) {
      modelSuccessRates[status.id] = status.totalCalls > 0 ? status.successCount / status.totalCalls : 1;
      activeExecutions += status.activeRequests;
    }
    const globalStats = memory.getGlobalStats();
    const decisionStats = decisionEngine.getStats();
    return {
      timestamp: Date.now(),
      successRate: globalStats.totalExecutions > 0 ? globalStats.totalSuccesses / globalStats.totalExecutions : 1,
      avgQuality: globalStats.averageQualityScore,
      avgLatency: globalStats.averageExecutionTime,
      cacheHitRate: decisionStats.cacheHitRate ?? 0,
      modelSuccessRates,
      activeExecutions,
    };
  };

  // ── 第五阶段 Phase 2.5：共生进化融合（能量经济 + 信念市场 → 元认知漂移报警）──
  // 缺省关闭：影子系统不改变既有主链路行为；启用后 KPI 注入共生心跳，
  // 市场价 vs 统计估计的显著背离回流为自愈目标，任务成功铸币分红给模型智能体。
  const symbiosisEnabled = cfg.autonomy?.symbiosis?.enabled ?? false;
  // 创世纪 G4：快路径复用历史模型指派（缺省 true = 旧行为逐位一致）
  const fastPathReuseModels = cfg.autonomy?.fastPath?.reuseModels ?? true;
  // 创世纪 G3：探针操作器（提升作用域——心跳闭包在 if 块外消费）
  let probeOps: ProbeOperations | undefined;
  // 创世纪 G5：固化器引用（宪法审计在心跳闭包内消费）
  let genesisConsolidator: Consolidator | undefined;
  logger.info(
    '探索配置回显：exploration=%j（sampleFloor=%s budget=%s bonus=%s overrideRate=%s）fastPath.reuseModels=%s',
    cfg.autonomy?.exploration?.enabled,
    cfg.autonomy?.exploration?.sampleFloor,
    cfg.autonomy?.exploration?.budget,
    cfg.autonomy?.exploration?.bonus,
    cfg.autonomy?.exploration?.overrideRate,
    fastPathReuseModels,
  );
  const futarchyEnabled = symbiosisEnabled && (cfg.autonomy?.symbiosis?.futarchy?.enabled ?? false);
  // C 路线：能量 Sankey 落盘（sankeyPath 设置即启用）
  const sankeyPath = symbiosisEnabled ? cfg.autonomy?.symbiosis?.observability?.sankeyPath : undefined;
  const sankeyEveryNTicks = Math.max(1, cfg.autonomy?.symbiosis?.observability?.everyNTicks ?? 5);
  let symbiosisTickCount = 0;
  const symbiosisBridge = symbiosisEnabled
    ? new SymbiosisBridge(
        {
          beliefHorizonTicks: cfg.autonomy?.symbiosis?.beliefHorizonTicks,
          globalSuccessThreshold: cfg.autonomy?.symbiosis?.globalSuccessThreshold,
          modelSuccessThreshold: cfg.autonomy?.symbiosis?.modelSuccessThreshold,
          modelBetBudget: cfg.autonomy?.symbiosis?.modelBetBudget,
          divergenceMargin: cfg.autonomy?.symbiosis?.divergenceMargin,
          futarchy: {
            enabled: futarchyEnabled,
            minImpliedProb: cfg.autonomy?.symbiosis?.futarchy?.minImpliedProb,
            decisionB: cfg.autonomy?.symbiosis?.futarchy?.decisionB,
            evolutionCost: cfg.autonomy?.symbiosis?.futarchy?.evolutionCost,
            evolutionBalanceThreshold: cfg.autonomy?.symbiosis?.futarchy?.evolutionBalanceThreshold,
            selfBetBudget: cfg.autonomy?.symbiosis?.futarchy?.selfBetBudget,
          },
          economic: {
            reputationWeight: cfg.autonomy?.symbiosis?.schedulingFeedback?.reputationWeight,
            minMultiplier: cfg.autonomy?.symbiosis?.schedulingFeedback?.minMultiplier,
            maxMultiplier: cfg.autonomy?.symbiosis?.schedulingFeedback?.maxMultiplier,
            neutralHealth: cfg.autonomy?.symbiosis?.schedulingFeedback?.neutralHealth,
            balanceBaseline: cfg.autonomy?.symbiosis?.schedulingFeedback?.balanceBaseline,
          },
          // 5.0：因果内核接入共生运行时——任务结算自动登记 do-干预，
          // 分红升级为 Shapley 反事实边际贡献定价
          // 6.0：自由能引擎接入——心跳产出变分自由能（市场价 vs 因果后验
          // 的 KL 漂移监测），行动提案可按 EFE 排序
          // 10.0：科学家内核接入（autoRegisterQuestions 开启时）——
          // 调度器结算的因果边自动进入 EIG 实验设计的问题空间
          runtime: {
            causalKernel,
            freeEnergy: freeEnergyEngine,
            ...(scientistMind && scientistAutoRegister ? { scientist: scientistMind } : {}),
            // R4-A17 modules.symbiosisEconomy：货币治理（流通量目标带铸币税
            // 调节；旗标关时片段 {}，零注入——央行不干预）
            ...symbiosisMonetaryUpgradeConfig(modulesCfg),
          },
        },
        { checkGate: () => governor.checkGate() },
      )
    : undefined;
  if (symbiosisBridge) {
    for (const model of mergedModels) symbiosisBridge.registerModel(model.id);

    // ── E 路线：τ1 可塑性学习闭环（结算结局 → 参数级在线学习，缺省关闭）──
    // 纯影子学习：铸币/分红/信誉数值逐位不变；遗忘门控（冻结探针退化
    // 即回滚本窗口）与状态落盘由 loop 自理。未启用 = 本块零介入。
    const plasticityCfg = cfg.autonomy?.symbiosis?.plasticity;
    const plasticityLoop = plasticityCfg?.enabled
      ? new PlasticityLoop({
          persistPath: plasticityCfg.persistPath,
          autoGate: {
            window: plasticityCfg.gateWindow ?? 50,
            probeSize: plasticityCfg.probeSize ?? 50,
            seed: plasticityCfg.seed,
          },
        })
      : undefined;
    if (plasticityLoop) {
      symbiosisBridge.attachPlasticity(plasticityLoop);
      // 学习反哺调度：结算结局 → 参数更新 → 利用端评分乘数——
      // 「学习改变行为」的最后一段闭环（未挂载恒 1，评分零漂移）
      modelScheduler.attachPlasticityProfile(plasticityLoop);
      // τ2 固化：稳定结构（保持集验证过的偏好）蒸馏为持久规则——
      // 不随证据衰减，退役留痕；规则乘数叠加进调度评分链
      const consolidator = new Consolidator({
        persistPath: plasticityCfg?.rulesPath,
        interval: plasticityCfg?.consolidateEvery ?? 200,
      });
      consolidator.bindSource(() => plasticityLoop.eventLog());
      symbiosisBridge.attachConsolidation(consolidator);
      modelScheduler.attachDurableRules(consolidator);
      genesisConsolidator = consolidator;
      // 创世纪 G3：探针操作器（流动性检测 + 预算纪律；未配置 = 零介入）
      probeOps = plasticityCfg?.probes?.enabled ? new ProbeOperations({ maxPerHour: plasticityCfg.probes.maxPerHour }) : undefined;
      logger.info(
        'τ1 学习闭环 + τ2 固化已挂载（结算学习 + 调度反哺 + 结构蒸馏%s）：%s',
        probeOps ? ' + G3 流动性操作' : '',
        plasticityCfg?.persistPath ?? '内存态（未配置 persistPath）',
      );
    }

    // ── D 路线：全智能体接入（认知分工完全市场化，缺省关闭）──
    const agentsCfg = cfg.autonomy?.symbiosis?.agents;
    const attached: string[] = [];
    if (agentsCfg?.memory?.enabled) {
      symbiosisBridge.attachMemory(memory, {
        listingBasePrice: agentsCfg.memory.listingBasePrice,
        listingConfidenceThreshold: agentsCfg.memory.listingConfidenceThreshold,
        listingFrequencyThreshold: agentsCfg.memory.listingFrequencyThreshold,
        maintenanceInterval: agentsCfg.memory.maintenanceInterval,
      });
      attached.push('memory');
    }
    if (agentsCfg?.optimizer?.enabled) {
      symbiosisBridge.attachOptimizer({
        onPurchase: (assetId, refId, price) => {
          broadcast({ type: 'knowledge-trade', assetId, refId, price });
          logger.info('知识成交：optimizer 购入 %s（要价 %.1f）', refId, price);
        },
        config: {
          maxBudget: agentsCfg.optimizer.maxBudget,
          reserveBalance: agentsCfg.optimizer.reserveBalance,
          minClaimedQuality: agentsCfg.optimizer.minClaimedQuality,
          beliefBetBudget: agentsCfg.optimizer.beliefBetBudget,
        },
      });
      attached.push('optimizer');
    }

    logger.info(
      '共生进化融合已启用：模型智能体 ×%d，能量经济 + 信念市场并行心跳%s%s',
      mergedModels.length,
      futarchyEnabled ? '，futarchy 进化表决开启（高成本进化由市场资助）' : '',
      attached.length > 0 ? `，全智能体接入：${attached.join(' / ')}` : '',
    );
  }

  // ── 创世纪升级 51.0→75.0：五大新层 25 个内核接线（全部缺省关闭，零漂移）──
  // 开关收敛于 autonomy.kernels 命名空间；挂载纪律与 21.0→50.0 先例一致：
  // 缺省不 attach 即零介入，引擎行为与升级前逐位一致。
  const kernelsCfg = cfg.autonomy?.kernels ?? {};
  if (kernelsCfg.speculativeDecoding?.enabled === true) {
    modelScheduler.attachSpeculativeDecoding({ maxK: kernelsCfg.speculativeDecoding.maxK });
    logger.info('51.0 投机解码内核已挂载：drafter→verifier 配对经济裁决（maxK=%s）', kernelsCfg.speculativeDecoding.maxK ?? 64);
  }
  if (kernelsCfg.testTimeCompute?.enabled === true) {
    taskExecutor.attachTestTimeCompute({ alpha: kernelsCfg.testTimeCompute.alpha });
    logger.info('52.0 测试时计算内核已挂载：投票路数可达性计算（alpha=%s）', kernelsCfg.testTimeCompute.alpha ?? 0.2);
  }
  if (kernelsCfg.whittleIndex?.enabled === true) {
    modelScheduler.attachWhittleIndex({
      goodThreshold: kernelsCfg.whittleIndex.goodThreshold,
      passiveHeal: kernelsCfg.whittleIndex.passiveHeal,
      discount: kernelsCfg.whittleIndex.discount,
    });
    logger.info('53.0 Whittle 指数内核已挂载：两态臂部分激活最优调度（goodThreshold=%s, discount=%s）', kernelsCfg.whittleIndex.goodThreshold ?? 0.7, kernelsCfg.whittleIndex.discount ?? 0.95);
  }
  if (kernelsCfg.lyapunovBackpressure?.enabled === true) {
    taskExecutor.attachBackpressureController({
      V: kernelsCfg.lyapunovBackpressure.V,
      priceThreshold: kernelsCfg.lyapunovBackpressure.priceThreshold,
    });
    logger.info('54.0 Lyapunov 背压内核已挂载：任务类型队列稳定性告警（V=%s）', kernelsCfg.lyapunovBackpressure.V ?? 8);
  }
  if (kernelsCfg.hawkesBurstGuard?.enabled === true) {
    sentinel.attachHawkesBurstGuard({
      windowSec: kernelsCfg.hawkesBurstGuard.windowSec,
      burstShare: kernelsCfg.hawkesBurstGuard.burstShare,
      minEvents: kernelsCfg.hawkesBurstGuard.minEvents,
    });
    logger.info('55.0 Hawkes 爆发监视内核已挂载：到达相关性数学口径（windowSec=%s, burstShare=%s）', kernelsCfg.hawkesBurstGuard.windowSec ?? 900, kernelsCfg.hawkesBurstGuard.burstShare ?? 0.5);
  }
  if (kernelsCfg.beliefPropagation?.enabled === true) {
    worldModel.attachBeliefPropagation();
    logger.info('56.0 置信传播内核已挂载：多源证据因子图融合（旁路咨询）');
  }
  if (kernelsCfg.variationalInference?.enabled === true) {
    metaCognition.attachVariationalInference();
    logger.info('57.0 变分推断内核已挂载：平均场后验（自由能 q 分布供给方）');
  }
  if (kernelsCfg.langevinMutation?.enabled === true) {
    strategyEvolution.attachLangevinMutation({ steps: kernelsCfg.langevinMutation.steps, seed: kernelsCfg.langevinMutation.seed });
    logger.info('58.0 朗之万采样内核已挂载：变异分布 MALA 健康度体检（只读）');
  }
  if (kernelsCfg.curriculum?.enabled === true) {
    curiosity.attachCurriculum({ levelCount: kernelsCfg.curriculum.levelCount, threshold: kernelsCfg.curriculum.threshold });
    logger.info('59.0 课程学习内核已挂载：探索难度掌握门限爬阶（记账 + 读数）');
  }
  if (kernelsCfg.rateDistortion?.enabled === true) {
    memory.attachCompressionPlanner({ budgetBits: kernelsCfg.rateDistortion.budgetBits });
    logger.info('60.0 率失真内核已挂载：记忆压缩规划 + 影子价格 KPI（只读，budgetBits=%s）', kernelsCfg.rateDistortion.budgetBits ?? 1_000_000);
  }
  if (symbiosisBridge) {
    // 共生市场理论核（61.0→65.0，全部影子口径——不改变主链路铸币与结算）
    const marketAttached: string[] = [];
    if (kernelsCfg.stableMatching?.enabled === true) {
      symbiosisBridge.attachStableMatching();
      marketAttached.push('61.0 稳定匹配');
    }
    if (kernelsCfg.mechanismDesign?.enabled === true) {
      symbiosisBridge.attachMechanismDesign();
      marketAttached.push('62.0 机制设计');
    }
    if (kernelsCfg.nucleolusAudit?.enabled === true) {
      symbiosisBridge.attachNucleolusAudit();
      marketAttached.push('63.0 核仁');
    }
    if (kernelsCfg.correlatedEquilibrium?.enabled === true) {
      symbiosisBridge.attachCorrelatedEquilibrium();
      marketAttached.push('64.0 相关均衡');
    }
    if (kernelsCfg.dynamicPricing?.enabled === true) {
      symbiosisBridge.attachDynamicPricing({
        policy: kernelsCfg.dynamicPricing.policy,
        unit: kernelsCfg.dynamicPricing.unit,
        exploration: kernelsCfg.dynamicPricing.exploration,
      });
      marketAttached.push('65.0 动态定价');
    }
    if (marketAttached.length > 0) logger.info('共生市场理论核已挂载：%s（影子口径）', marketAttached.join(' / '));
  }
  if (kernelsCfg.annealingEscape?.enabled === true) {
    strategyEvolution.attachAnnealingEscape();
    logger.info('66.0 模拟退火内核已挂载：种群势阱深度与逃逸温度体检（只读）');
  }
  if (kernelsCfg.paretoFront?.enabled === true) {
    modelScheduler.attachParetoFront();
    logger.info('67.0 NSGA-II 内核已挂载：质量-成本-延迟帕累托前沿菜单（只读）');
  }
  if (kernelsCfg.compressionDistance?.enabled === true) {
    memory.attachNcdDedup({ threshold: kernelsCfg.compressionDistance.threshold });
    logger.info('68.0 压缩距离内核已挂载：NCD 近邻查重（threshold=%s，只读咨询）', kernelsCfg.compressionDistance.threshold ?? 0.65);
  }
  if (kernelsCfg.mapperGraph?.enabled === true) {
    worldModel.attachMapperLens({
      intervals: kernelsCfg.mapperGraph.intervals,
      overlap: kernelsCfg.mapperGraph.overlap,
      clusterEps: kernelsCfg.mapperGraph.clusterEps,
    });
    logger.info('69.0 Mapper 图内核已挂载：经验地形骨架与拓扑盲区（只读）');
  }
  if (kernelsCfg.pidDiagnostics?.enabled === true) {
    reflector.attachPidDiagnostics();
    logger.info('70.0 部分信息分解内核已挂载：多模型组合冗余/独占/协同诊断（只读）');
  }
  if (kernelsCfg.astarSearch?.enabled === true) {
    optimizer.attachAstarPlanner();
    logger.info('71.0 A* 搜索内核已挂载：最优子计划搜索（旁路咨询）');
  }
  if (kernelsCfg.sparseRecovery?.enabled === true) {
    optimizer.attachSparseAttribution();
    logger.info('72.0 稀疏恢复内核已挂载：质量归因 Lasso+CV active 集（旁路分析）');
  }
  if (kernelsCfg.baiSelector?.enabled === true) {
    benchmark.attachBaiSelector({ budget: kernelsCfg.baiSelector.budget });
    logger.info('73.0 最佳臂识别内核已挂载：基准引擎锦标赛冠军裁决（纯报告，budget=%s）', kernelsCfg.baiSelector.budget ?? 120);
  }
  if (kernelsCfg.mirrorDescent?.enabled === true) {
    decisionEngine.attachNoRegretRouter({
      mirror: kernelsCfg.mirrorDescent.mirror,
      alpha: kernelsCfg.mirrorDescent.alpha,
    });
    logger.info('74.0 镜像下降内核已挂载：决策行动无悔混合策略读数（咨询口径）');
  }
  if (kernelsCfg.onlineCalibration?.enabled === true) {
    decisionEngine.attachProbabilityCalibrator({
      strategy: kernelsCfg.onlineCalibration.strategy,
      lr: kernelsCfg.onlineCalibration.lr,
      window: kernelsCfg.onlineCalibration.window,
    });
    logger.info('75.0 在线校准内核已挂载：决策概率口径前置层（门控激活后校准生效）');
  }

  // ── 第二轮创世纪升级 76.0→100.0：五大新层 25 个内核接线（全部缺省关闭，零漂移）──
  // 开关同样收敛于 autonomy.kernels 命名空间；挂载纪律与 51.0→75.0 先例一致：
  // 缺省不 attach 即零介入，引擎行为与升级前逐位一致。适配层见
  // src/engines-frontier/autonomy25.ts（纯函数 / 自包含小对象，零引擎依赖）。
  if (kernelsCfg.noveltySentinel?.enabled === true) {
    sentinel.attachNoveltySentinel({
      window: {
        capacity: kernelsCfg.noveltySentinel.capacity,
        halfLife: kernelsCfg.noveltySentinel.halfLife,
        minSamples: kernelsCfg.noveltySentinel.minSamples,
      },
      changeAlpha: kernelsCfg.noveltySentinel.changeAlpha,
    });
    logger.info('76.0 新奇检测内核已挂载：信号判异从静态幅值阈值升级为「窗口深度 + kNN 计数比」双证据（观测口径）');
  }
  if (kernelsCfg.causalDiscovery?.enabled === true) {
    worldModel.attachCausalLens({ alpha: kernelsCfg.causalDiscovery.alpha });
    logger.info('77.0 因果发现内核已挂载：观测指标流 PC 学图（CPDAG 等价类；旁路咨询，alpha=%s）', kernelsCfg.causalDiscovery.alpha ?? 0.01);
  }
  if (kernelsCfg.ccaAlignment?.enabled === true) {
    worldModel.attachCcaLens({ lambda: kernelsCfg.ccaAlignment.lambda });
    logger.info('78.0 典型相关内核已挂载：多源证据对齐公共潜坐标系（旁路咨询，λ=%s）', kernelsCfg.ccaAlignment.lambda ?? 0.5);
  }
  if (kernelsCfg.diffusionManifold?.enabled === true) {
    worldModel.attachDiffusionLens({ k: kernelsCfg.diffusionManifold.k, dims: kernelsCfg.diffusionManifold.dims });
    logger.info('79.0 扩散映射内核已挂载：经验连续嵌入（旁路咨询，k=%s, dims=%s）', kernelsCfg.diffusionManifold.k ?? 10, kernelsCfg.diffusionManifold.dims ?? 2);
  }
  if (kernelsCfg.streamingSketch?.enabled === true) {
    sentinel.attachStreamingSketch({
      cmsEps: kernelsCfg.streamingSketch.cmsEps,
      cmsDelta: kernelsCfg.streamingSketch.cmsDelta,
      window: kernelsCfg.streamingSketch.window,
      reservoirK: kernelsCfg.streamingSketch.reservoirK,
    });
    logger.info('80.0 流式概要内核已挂载：哨兵感官缓冲（键频/滑窗计数/等概率样本/重元素，观测口径）');
  }
  if (kernelsCfg.argumentation?.enabled === true) {
    reflectionEngine.attachArgumentation();
    logger.info('81.0 论证内核已挂载：深思/反思结论的辩护链裁决（影子计算）');
  }
  if (kernelsCfg.crowdAggregation?.enabled === true) {
    reflector.attachCrowdAggregation();
    logger.info('82.0 众包聚合内核已挂载：多模型判定 Dawid–Skene 信任票权（咨询口径）');
  }
  if (kernelsCfg.worldModelLearning?.enabled === true) {
    worldModel.attachModelLearning({ prior: kernelsCfg.worldModelLearning.prior });
    logger.info('83.0 世界模型学习内核已挂载：调度轨迹学 T̂/r̂ + 值迭代（旁路咨询，prior=%s）', kernelsCfg.worldModelLearning.prior ?? 2);
  }
  if (kernelsCfg.pomdpPlanner?.enabled === true) {
    decisionEngine.attachPomdpPlanner();
    logger.info('84.0 POMDP 内核已挂载：defer/execute/ask-user 的信念规划咨询（α-VI 下界 × QMDP 上界）');
  }
  if (kernelsCfg.symbolicFeasibility?.enabled === true) {
    taskExecutor.attachSymbolicFeasibility();
    logger.info('85.0 符号求解内核已挂载：DAG 计划可行性静态裁决（SAT/UNSAT + 冲突账单）');
  }
  if (kernelsCfg.optionsFramework?.enabled === true) {
    taskExecutor.attachOptionsFramework();
    logger.info('86.0 分层技能内核已挂载：SMDP 宏动作时间信用分配体检（只读基准）');
  }
  if (kernelsCfg.safetyBarrier?.enabled === true) {
    taskExecutor.attachSafetyBarrier({ eta: kernelsCfg.safetyBarrier.eta });
    logger.info('87.0 安全屏障内核已挂载：逐动作微分安全过滤（infeasible 上报总督，η=%s）', kernelsCfg.safetyBarrier.eta ?? 0.05);
  }
  if (kernelsCfg.offPolicyEvaluation?.enabled === true) {
    policyEvolver.attachOpeGate({ delta: kernelsCfg.offPolicyEvaluation.delta, gamma: kernelsCfg.offPolicyEvaluation.gamma });
    logger.info('88.0 离线评估内核已挂载：金丝雀门控反事实估值通道（DR + EB-CS，δ=%s）', kernelsCfg.offPolicyEvaluation.delta ?? 0.05);
  }
  if (kernelsCfg.safePolicyImprovement?.enabled === true) {
    policyEvolver.attachSafeImprovementGate({
      delta: kernelsCfg.safePolicyImprovement.delta,
      minSamples: kernelsCfg.safePolicyImprovement.minSamples,
    });
    logger.info('89.0 安全策略改进内核已挂载：候选晋升高置信证书（LCB > 0 才上线，δ=%s）', kernelsCfg.safePolicyImprovement.delta ?? 0.05);
  }
  if (kernelsCfg.preferenceLearning?.enabled === true) {
    reflector.attachPreferenceLearning({ minPairs: kernelsCfg.preferenceLearning.minPairs, l2: kernelsCfg.preferenceLearning.l2 });
    logger.info('90.0 偏好学习内核已挂载：RLHF-lite 效用序（影子学习，minPairs=%s）', kernelsCfg.preferenceLearning.minPairs ?? 8);
  }
  if (kernelsCfg.noveltySearch?.enabled === true) {
    curiosity.attachNoveltySearch({ k: kernelsCfg.noveltySearch.k });
    logger.info('91.0 新奇搜索内核已挂载：探索预算向行为空间空白定向（咨询口径，k=%s）', kernelsCfg.noveltySearch.k ?? 3);
  }
  if (kernelsCfg.selfPlay?.enabled === true) {
    strategyEvolution.attachSelfPlay({ leagueRounds: kernelsCfg.selfPlay.leagueRounds, seed: kernelsCfg.selfPlay.seed });
    logger.info('92.0 自我对弈内核已挂载：策略进化对抗压力审计（影子计算，leagueRounds=%s）', kernelsCfg.selfPlay.leagueRounds ?? 60);
  }
  if (kernelsCfg.automlHyperband?.enabled === true) {
    benchmark.attachHyperbandTuner({ eta: kernelsCfg.automlHyperband.eta, seed: kernelsCfg.automlHyperband.seed });
    logger.info('93.0 AutoML Hyperband 内核已挂载：引擎内超参自动寻优（咨询口径，η=%s）', kernelsCfg.automlHyperband.eta ?? 3);
  }
  if (kernelsCfg.simulationCalibration?.enabled === true) {
    policySandbox.attachSimCalibration();
    logger.info('94.0 仿真校准内核已挂载：沙盒风洞修正（MMD² 域差 + 密度比换算真实口径，只读）');
  }
  if (kernelsCfg.interruptibleAutonomy?.enabled === true) {
    decisionEngine.attachHandoffPolicy();
    logger.info('95.0 中断交接内核已挂载：ask-user 期望成本最优裁决（闭式 τ* = c_H + c_delay）');
  }
  if (kernelsCfg.metacognitiveConfidence?.enabled === true) {
    decisionEngine.attachMetacognitiveConfidence();
    logger.info('97.0 元认知信心内核已挂载：决策置信度校准审计（M-ratio）+ 求助触发闭式阈值（观测口径）');
  }
  if (kernelsCfg.experienceReplay?.enabled === true) {
    memory.attachExperienceReplay({
      capacity: kernelsCfg.experienceReplay.capacity,
      alpha: kernelsCfg.experienceReplay.alpha,
      beta: kernelsCfg.experienceReplay.beta,
    });
    logger.info('98.0 经验重放内核已挂载：长期记忆睡眠固化阶段（旁路口径，capacity=%s）', kernelsCfg.experienceReplay.capacity ?? 512);
  }
  if (kernelsCfg.attentionEconomy?.enabled === true) {
    sentinel.attachAttentionEconomy();
    logger.info('99.0 注意力经济内核已挂载：哨兵→优化器信息流拍卖（VCG 支付，影子口径）');
  }
  if (kernelsCfg.selfBoundary?.enabled === true) {
    selfModel.attachSelfBoundary();
    logger.info('100.0 自我边界内核已挂载：归因边界 + 身份断点监控（影子计算）');
  }

  // ── 第四轮 R4-A17：模块域升级接线（autonomy.modules.* 16 旗标，全部缺省关闭，零漂移）──
  // 集中挂载区块：第三/四轮各模块的 attach 式升级在此按旗标挂载（适配层
  // engines-frontier/autonomy25.ts 的 attachPostConstructModuleUpgrades——
  // 旗标关 = 对应 attach 不调用，引擎读数 undefined，行为与升级前逐位一致）。
  // 构造配置式旗标（sentinelAdaptive / clientPriorityQueue / cryptoTieredKeys /
  // metaStabilityLoop / symbiosisEconomy 的货币治理半边）已在上文各构造点
  // 按片段注入；dashboardAlarmSources 在 attachDashboard 调用点接线。
  const moduleAttached = attachPostConstructModuleUpgrades(
    {
      decisionEngine,
      modelScheduler,
      taskExecutor,
      memory,
      policyEvolver,
      worldModel,
      symbiosisBridge: symbiosisBridge ?? undefined,
      tenantManager,
      benchmark,
    },
    modulesCfg,
  );
  if (moduleAttached.length > 0) {
    logger.info(
      '模块域升级已挂载（%d/%d 旗标）：%s',
      moduleAttached.length,
      moduleFlagOverview(modulesCfg).total,
      moduleAttached.join(' / '),
    );
  }

  /**
   * 真实进化周期（futarchy 表决的行动本体 / 直连模式的执行体，共用）：
   * ① 喂数金丝雀（决策反馈真实成败/质量 → 自动回滚/晋升）
   * ② 刷新沙盒素材（任务集/校准表/模型快照与操作环同步）
   * ③ 触发进化周期（变异/交叉 → 沙盒评估 → 择优 → 热切换）
   */
  const runPolicyEvolutionCycle = async () => {
    // 金丝雀喂数：增量消费部署以来的决策反馈（outcome → 成败 + 质量近似分）
    const canaryNow = policyEvolver.getStatus().canary;
    if (canaryNow?.status === 'active') {
      const QUALITY_BY_OUTCOME: Record<string, number> = {
        excellent: 0.95,
        good: 0.8,
        acceptable: 0.65,
        poor: 0.4,
        failed: 0.1,
      };
      const recent = memory.getRecentFeedback(50);
      const fresh = recent.filter((f) => f.timestamp >= canaryNow.deployedAt && f.timestamp > lastCanaryFeedAt);
      for (const feedback of fresh) {
        policyEvolver.reportOperationalOutcome({
          success: ['excellent', 'good', 'acceptable'].includes(feedback.outcome),
          quality: QUALITY_BY_OUTCOME[feedback.outcome],
        });
        lastCanaryFeedAt = Math.max(lastCanaryFeedAt, feedback.timestamp);
      }
    }
    // 沙盒素材刷新：模型快照 + 历史回放集 + 校准表（进化素材与操作环同步）
    policySandbox.setTaskSet(buildSandboxTaskSet());
    policySandbox.setCalibration(buildCalibrationFromMemory(memory));
    const cycle = await policyEvolver.runEvolutionCycle(policySandbox);
    logger.info('策略进化周期完成: %s', cycle.summary);
    return cycle;
  };

  // ── A 路线：futarchy 启用时把真实进化周期绑定给进化智能体 ──
  // 市场成为高成本进化的唯一资助闸门（进化者自注 + 模型健康度定价 +
  // 监管一票否决）；进化贡献者凭部署中的策略基因参与任务分红（自持经济）。
  if (symbiosisBridge && futarchyEnabled) {
    symbiosisBridge.attachEvolver(
      async () => {
        const cycle = await runPolicyEvolutionCycle();
        const gains = cycle.candidates.map((c) => c.gain);
        return {
          deployed: !!cycle.deployedPolicyId,
          bestGain: gains.length > 0 ? Math.max(...gains) : 0,
          policyId: cycle.deployedPolicyId,
          summary: cycle.summary,
        };
      },
      {
        dividendWeight: () => {
          const status = policyEvolver.getStatus();
          if (status.currentPolicy.origin === 'baseline') return undefined;
          // 部署中的进化策略（非基线）= 任务成功的隐性贡献者；权重锚定其部署增益
          const lastDeployed = status.deployedHistory[status.deployedHistory.length - 1];
          return Math.max(0.2, (lastDeployed?.gain ?? 0) * 5);
        },
      },
    );
  }

  /** 子任务派发器：目标子任务注入哨兵作为信号 */
  const dispatchSubtask = (subtask: GoalSubtask, goal: Goal): string => {
    const signal = sentinel.ingest({
      type: subtask.taskType,
      description: subtask.description,
      payload: { goalId: goal.id, subtaskId: subtask.id, autonomous: true },
      source: 'autonomy-loop',
      urgency: Math.min(1, 0.5 + goal.valueScore * 0.3),
    });
    broadcast({ type: 'autonomy-dispatch', goalId: goal.id, subtaskId: subtask.id, signalId: signal.id });
    return signal.id;
  };

  /** 探索任务派发器：好奇心探索建议注入哨兵作为信号 */
  const dispatchExploration = (proposal: ExplorationProposal): string => {
    const signal = sentinel.ingest({
      type: proposal.taskType,
      description: proposal.description,
      payload: { exploration: true, noveltyScore: proposal.noveltyScore, expectedGain: proposal.expectedGain },
      source: 'curiosity',
      urgency: Math.min(1, 0.3 + proposal.noveltyScore * 0.4),
    });
    broadcast({ type: 'exploration-dispatch', taskType: proposal.taskType, signalId: signal.id, noveltyScore: proposal.noveltyScore });
    return signal.id;
  };

  // ── 25.0 容量规划内核：心跳 2.5 段的容量反解（λ̂ × 服务统计 → 最小并发）──
  // λ̂ = 世界模型 60 秒窗口预测到达数之和 / 60（每秒）；服务时长 = 各模型
  // 稳健平均延迟（23.0 robustAvgLatencyMs，未启用时回退 avgLatency）按
  // totalCalls 加权平均（无权重数据时简单平均）；当前并发 = 各模型
  // maxConcurrency 之和（取不到兜底 4）。Erlang-C / Kingman 反解最小可行
  // 并发，不可行（ρ≥1）或建议并发 > 当前×1.2 时产出 capacity-warning
  // 洞察回流目标引擎。未启用时 advisor 不注入（自主循环零改动）。
  const capacityPlanner = cfg.autonomy?.capacityPlanning?.enabled === true
    ? new CapacityPlanner({
        targetWaitMs: cfg.autonomy.capacityPlanning.targetWaitMs,
        defaultScv: cfg.autonomy.capacityPlanning.defaultScv,
      })
    : undefined;
  /** 最近一次容量规划产物（introspect 审计口径；未启用/未产出时恒 undefined） */
  let lastCapacityPlan: CapacityPlan | undefined;
  const runCapacityPlanning = (): Insight[] => {
    if (!capacityPlanner) return [];
    // λ̂：expectedCount 为趋势/时段热度修正后的调整值；无观测类型无从规划
    const predictions = worldModel.predictArrivals(60_000);
    if (predictions.length === 0) return [];
    const totalArrivals = predictions.reduce((sum, p) => sum + (Number.isFinite(p.expectedCount) ? p.expectedCount : 0), 0);
    if (totalArrivals <= 0) return [];
    const predictedArrivalPerSec = totalArrivals / 60;
    // 服务时长：稳健延迟优先（23.0），按调用量加权；无任何有限延迟数据返回 []
    const statuses = llm.getModelStatuses();
    let latencyWeightedSum = 0;
    let weightSum = 0;
    let unweightedSum = 0;
    let unweightedCount = 0;
    for (const status of statuses) {
      const latency = status.robustAvgLatencyMs ?? status.avgLatency;
      if (!Number.isFinite(latency) || latency <= 0) continue;
      if (status.totalCalls > 0) {
        latencyWeightedSum += latency * status.totalCalls;
        weightSum += status.totalCalls;
      } else {
        unweightedSum += latency;
        unweightedCount += 1;
      }
    }
    const serviceMeanMs = weightSum > 0
      ? latencyWeightedSum / weightSum
      : unweightedCount > 0
        ? unweightedSum / unweightedCount
        : undefined;
    if (serviceMeanMs === undefined) return [];
    // 当前并发：各模型并发上限之和（异常配置兜底 4，与调度器 computeParallelism 的兜底口径一致）
    const currentConcurrency = statuses.reduce((sum, s) => sum + (s.maxConcurrency > 0 ? s.maxConcurrency : 0), 0) || 4;
    const plan = capacityPlanner.plan({ predictedArrivalPerSec, serviceMeanMs, currentConcurrency });
    lastCapacityPlan = plan;
    if (plan.feasible && plan.headroom <= 1.2) return [];
    const severity = !plan.feasible ? 0.9 : Math.min(0.85, 0.5 + (plan.headroom - 1.2));
    return [
      {
        source: 'meta-cognition',
        category: 'capacity-warning',
        taskType: undefined,
        severity,
        message: `容量规划：预测到达率 ${predictedArrivalPerSec.toFixed(3)}/s × 平均服务 ${Math.round(serviceMeanMs)}ms，当前并发 ${plan.currentConcurrency}（利用率 ρ=${plan.rho}）；反解建议并发 ${plan.recommendedConcurrency}，预计平均等待 ${plan.feasible ? `${plan.expectedWaitMs}ms` : `超出目标 ${plan.targetWaitMs}ms（不可达）`}`,
        suggestion: !plan.feasible
          ? '并发上限内无法满足目标等待：立即扩容模型并发上限或对低价值信号降载，防止队列排队失控'
          : `建议把模型并发上限扩至 ${plan.recommendedConcurrency}（当前 ${plan.currentConcurrency}），或对低价值信号降载以守住 ${plan.targetWaitMs}ms 等待目标`,
      },
    ];
  };
  if (capacityPlanner) {
    logger.info(
      '25.0 容量规划内核已启用：心跳 2.5 段反解最小并发（targetWaitMs=%s, defaultScv=%s）',
      cfg.autonomy?.capacityPlanning?.targetWaitMs ?? 5000,
      cfg.autonomy?.capacityPlanning?.defaultScv ?? 2.0,
    );
  }

  // ── 28.0 极值理论内核：心跳 2.7 段的尾部风险评估 ──
  // 质变基座：p99.9 的经验分位数 = 样本最大值（纯运气）；POT/GPD 给出
  // Pickands–Balkema–de Haan 定理背书的尾部外推（含 bootstrap CI）。
  // 各模型延迟样本（与 23.0 稳健估计共用 robustLatency 流，需其启用）
  // 喂入尾部监视器，p99 外推超出 targetP99Ms 产出 tail-risk 洞察。
  // 未启用 / 样本不足时 advisor 不产出（自主循环零改动）。
  const tailRiskEnabled = cfg.autonomy?.extremeValue?.enabled === true;
  const tailRiskTargetMs = cfg.autonomy?.extremeValue?.targetP99Ms ?? 30_000;
  const tailRiskMinSamples = cfg.autonomy?.extremeValue?.minSamples ?? 60;
  const tailRiskMonitors = new Map<string, TailRiskMonitor>();
  /** 最近一次尾部风险评估产物（introspect 审计口径） */
  let lastTailRisk: TailRiskReport & { modelId: string } | undefined;
  const runTailRiskAssessment = (): Insight[] => {
    if (!tailRiskEnabled) return [];
    const insights: Insight[] = [];
    for (const status of llm.getModelStatuses()) {
      const samples = llm.getLatencySamples(status.id);
      if (!samples || samples.length < tailRiskMinSamples) continue;
      let monitor = tailRiskMonitors.get(status.id);
      if (!monitor) {
        monitor = new TailRiskMonitor({
          thresholdQuantile: cfg.autonomy?.extremeValue?.thresholdQuantile,
          bootstrap: cfg.autonomy?.extremeValue?.bootstrap,
        });
        tailRiskMonitors.set(status.id, monitor);
      }
      // 样本流重建（监视器自持环形缓冲，按当前快照全量对齐）
      for (const s of samples) monitor.observe(s);
      const report = monitor.fit();
      if (!report) continue;
      if (report.p99 <= tailRiskTargetMs) continue;
      lastTailRisk = { ...report, modelId: status.id };
      const ci = report.p999Ci ? `，p99.9 外推 ${Math.round(report.p999)}ms（90% CI ${Math.round(report.p999Ci.lower)}–${Math.round(report.p999Ci.upper)}）` : `，p99.9 外推 ${Math.round(report.p999)}ms`;
      insights.push({
        source: 'meta-cognition',
        category: 'tail-risk',
        taskType: undefined,
        severity: Math.min(0.9, 0.5 + 0.4 * Math.min(1, report.p99 / tailRiskTargetMs - 1)),
        message: `尾部风险：模型 ${status.id} 延迟 p99 外推 ${Math.round(report.p99)}ms 超出目标 ${tailRiskTargetMs}ms（GPD ξ=${report.gpd.xi.toFixed(3)}，σ=${Math.round(report.gpd.sigma)}ms，${report.exceedances} 超出量${ci}）——经验最大值只是运气，定理外推才是尾部`,
        suggestion: report.gpd.xi > 0.5
          ? '重尾确认（ξ>0.5）：极端延迟无界，为该模型设独立超时与并发上限，路由侧按 22.0 影子价格降载，必要时熔断切流'
          : '尾部超限：收紧该模型超时预算或降低其高成本任务占比，观察 27.0 滤波层对延迟水平的后续裁决',
      });
    }
    return insights;
  };
  if (tailRiskEnabled) {
    logger.info(
      '28.0 极值理论内核已启用：心跳 2.7 段 POT/GPD 尾部外推（targetP99Ms=%s, minSamples=%s）',
      tailRiskTargetMs,
      tailRiskMinSamples,
    );
  }

  // ── 33.0 随机矩阵内核：心跳 2.8 段的系统性风险评估 ──
  // 质变基座：模型失败计数的样本相关矩阵，其大部分谱结构是纯噪声
  // （Marchenko–Pastur 带）；RMT 清洗把伪相关吸收进噪声带（不误报），
  // 头号特征值仍显著超带且解释份额达标 = 存在共同因子——「看起来
  // 分散」的模型冗余（同厂商/同上游）是统计幻觉，热备会被一击串联。
  // 各模型每期失败计数从 getModelStatuses 的差分提取（重置/无历史 =
  // 该期缺席）；窗口攒满才评估（先验无知期零输出）。缺省关闭（零漂移）。
  const rmtEnabled = cfg.autonomy?.randomMatrix?.enabled === true;
  const systemicRiskMonitor = new SystemicRiskMonitor({
    window: cfg.autonomy?.randomMatrix?.window,
    minModels: cfg.autonomy?.randomMatrix?.minModels,
    edgeFactor: cfg.autonomy?.randomMatrix?.edgeFactor,
    systemicShare: cfg.autonomy?.randomMatrix?.systemicShare,
  });
  /** 各模型上期快照（失败计数差分的基准） */
  const rmtLastSnapshot = new Map<string, { totalCalls: number; successCount: number }>();
  /** 最近一次系统性风险评估产物（introspect 审计口径） */
  let lastSystemicRisk: SystemicRiskAssessment | undefined;
  const runSystemicRiskAssessment = (): Insight[] => {
    if (!rmtEnabled) return [];
    const counts: Record<string, number | null> = {};
    for (const status of llm.getModelStatuses()) {
      const prev = rmtLastSnapshot.get(status.id);
      rmtLastSnapshot.set(status.id, { totalCalls: status.totalCalls, successCount: status.successCount });
      if (!prev || status.totalCalls < prev.totalCalls) continue; // 无历史 / 计数重置：本期缺席
      const deltaCalls = status.totalCalls - prev.totalCalls;
      if (deltaCalls <= 0) continue; // 本期无活动：缺席（NaN 插补口径）
      const deltaSuccess = Math.max(0, status.successCount - prev.successCount);
      counts[status.id] = deltaCalls - deltaSuccess;
    }
    systemicRiskMonitor.observe(counts);
    const assessment = systemicRiskMonitor.assess();
    if (!assessment || !assessment.systemic) return [];
    lastSystemicRisk = assessment;
    const ids = systemicRiskMonitor.modelIds;
    const exposed = assessment.topLoading
      .slice(0, 3)
      .map((l) => ids[l.index])
      .filter((id): id is string => Boolean(id));
    return [
      {
        source: 'meta-cognition',
        category: 'systemic-risk',
        taskType: undefined,
        severity: Math.min(0.9, 0.5 + 0.4 * Math.min(1, assessment.topShare)),
        message: `系统性风险：${assessment.models} 个模型的失败相关矩阵头号特征值 ${assessment.topEigenvalue.toFixed(2)} 显著超出 Marchenko–Pastur 噪声带 ${assessment.noiseEdge.toFixed(2)}（解释份额 ${(assessment.topShare * 100).toFixed(0)}%，共同因子暴露最深：${exposed.join(' / ') || '—'}）——这些模型会同沉浮，当前冗余是统计幻觉`,
        suggestion: '把热备与分流的候选池按共同因子拆开（跨厂商/跨上游各留一席）；对暴露最深的模型降低关键任务的并发占比，防止一个上游故障串联击穿',
      },
    ];
  };
  if (rmtEnabled) {
    logger.info(
      '33.0 随机矩阵内核已启用：心跳 2.8 段 MP 清洗 + 系统性风险（window=%s, minModels=%s）',
      cfg.autonomy?.randomMatrix?.window ?? 32,
      cfg.autonomy?.randomMatrix?.minModels ?? 4,
    );
  }

  // ── 41.0 排队网络内核：心跳 2.9 段的瓶颈站评估 ──
  // 质变基座：25.0 单站反解看不到「哪一站钳制整条链路」。各模型作为
  // 独立 M/M/c 站（Jackson 分流网络同属乘积形式——各站边际独立），
  // 到达率 = 世界模型预测到达率 × 当前流量份额，μ = 稳健平均延迟的
  // 倒数，c = maxConcurrency；Erlang-C 口径解瓶颈站（ρ 最大）。
  // 缺省关闭（零漂移）；失败静默。
  const queueingEnabled = cfg.autonomy?.queueingNetwork?.enabled === true;
  const queueingRhoThreshold = cfg.autonomy?.queueingNetwork?.rhoThreshold ?? 0.85;
  const runQueueingAssessment = (): Insight[] => {
    if (!queueingEnabled) return [];
    const statuses = llm.getModelStatuses().filter((s) => s.maxConcurrency > 0);
    if (statuses.length === 0) return [];
    const horizonMs = 5 * 60_000;
    const predictedPerMs = worldModel.predictArrivals(horizonMs).reduce((s, p) => s + p.expectedCount, 0) / horizonMs;
    if (!(predictedPerMs > 0)) return [];
    const totalActive = statuses.reduce((s, st) => s + st.activeRequests, 0);
    const stations = statuses.map((st) => ({
      name: st.id,
      lambdaPerMs: totalActive > 0 ? predictedPerMs * (st.activeRequests / totalActive) : predictedPerMs / statuses.length,
      muPerMs: 1 / Math.max(1, st.robustAvgLatencyMs ?? st.avgLatency),
      servers: st.maxConcurrency,
    }));
    const report = tandemNetwork(stations); // 分流 Jackson：各站独立 M/M(c) 边际（乘积形式）
    const verdict = bottleneckInsight(report, queueingRhoThreshold);
    if (!verdict) return [];
    return [
      {
        source: 'meta-cognition',
        category: 'capacity-flow',
        taskType: undefined,
        severity: verdict.severity,
        message: verdict.message,
        suggestion: verdict.suggestion,
      },
    ];
  };
  if (queueingEnabled) {
    logger.info(
      '41.0 排队网络内核已启用：心跳 2.9 段瓶颈站评估（rhoThreshold=%s）',
      queueingRhoThreshold,
    );
  }

  const autonomyLoop = new AutonomyLoop({
    config: {
      ...cfg.autonomy?.loop,
      heartbeatMs: cfg.autonomy?.heartbeatMs ?? cfg.autonomy?.loop?.heartbeatMs ?? 30_000,
    },
    goalEngine,
    metaCognition,
    evolution: strategyEvolution,
    collectKpi,
    dispatchSubtask,
    maintainer: {
      distillExperience: () => memory.distillExperience().length,
      applyForgettingCurve: () => memory.applyForgettingCurve(),
      // 第二阶段：知识蒸馏桥接（反思器产出语义+程序记忆）
      distillKnowledge: async () => {
        const report = await reflector.distillKnowledge();
        return { semantic: report.semanticMemories.length, procedural: report.proceduralMemories.length };
      },
    },
    lessonProvider: () => reflectionEngine.getAllLessons(),
    strategyApplier: (config) => {
      decisionEngine.updateConfig(config);
      broadcast({ type: 'strategy-evolved', config });
      logger.info('策略进化落地: %s', JSON.stringify(config));
    },
    worldModel,
    curiosity,
    governor,
    dispatchExploration,
    // 25.0 容量规划桥接（心跳 2.5 段：λ̂ × 服务统计 → 反解最小并发 → 扩容洞察）
    capacityAdvisor: capacityPlanner ? runCapacityPlanning : undefined,
    // 28.0 尾部风险桥接（心跳 2.7 段：延迟样本 → POT/GPD → 尾部外推洞察）
    tailRiskAdvisor: tailRiskEnabled ? runTailRiskAssessment : undefined,
    // 33.0 系统性风险桥接（心跳 2.8 段：失败相关 → MP 清洗 → 共同因子洞察）
    systemicRiskAdvisor: rmtEnabled ? runSystemicRiskAssessment : undefined,
    // 41.0 排队网络桥接（心跳 2.9 段：模型站 M/M(c) × 流量份额 → 瓶颈站洞察）
    networkAdvisor: queueingEnabled ? runQueueingAssessment : undefined,
    // 第三阶段（质级升级）：调度策略进化桥接
    // 每轮周期：① 喂数金丝雀（决策反馈真实成败/质量 → 自动回滚/晋升）
    // ② 刷新沙盒素材（任务集/校准表/模型快照与操作环同步）→ 触发进化周期
    policyEvolution:
      policyEvolutionEnabled && !futarchyEnabled
        ? {
            // futarchy 关闭（缺省）：心跳直连进化（既有行为不变）
            runEvolutionCycle: runPolicyEvolutionCycle,
          }
        : undefined,
    // 第四阶段：元认知环桥接（低频外环：自我建模 → 保守调整 → 观察/回滚）
    metaCognitionBridge: metaLayerEnabled
      ? {
          runMetaCycle: async () => {
            const adjustment = await metaController.evaluateAndAdjust();
            broadcast({
              type: 'mental-report',
              reportIndex: adjustment.reportIndex,
              status: adjustment.status,
              appliedKnobs: adjustment.applied.map((a) => a.knob),
              stabilityScore: adjustment.mentalReport.systemStability.stabilityScore,
            });
            if (adjustment.applied.length > 0 || adjustment.rolledBack || adjustment.committed) {
              logger.info(
                '元认知周期[%s]: 报告 #%d，稳定分 %.3f，证据 %d 条，推荐 %d 项',
                adjustment.status,
                adjustment.reportIndex,
                adjustment.mentalReport.systemStability.stabilityScore,
                adjustment.mentalReport.improvementEvidence.length,
                adjustment.mentalReport.recommendedAdjustments.length,
              );
            }
            return adjustment;
          },
        }
      : undefined,
    // 第五阶段 Phase 2.5：共生进化桥接（KPI → 能量经济/信念市场 → 漂移洞察回流）
    symbiosis: symbiosisBridge
      ? {
          runSymbiosisTick: async (snapshot) => {
            const driftInsights = await symbiosisBridge.heartbeat(snapshot);
            // 创世纪 G5 · 宪法审计（每 10 拍一次，约 5 分钟）：四条定律
            // 的运行时合规检查——链完整 / 结构负债可溯源 / 央行两定律。
            // 违宪即告警（审计是宪法不是建议）。
            const pLoop = symbiosisBridge.plasticityLoop;
            if (pLoop && genesisConsolidator && symbiosisTickCount % 10 === 0) {
              const report = auditConstitution(pLoop, genesisConsolidator);
              const failed = report.checks.filter((c) => !c.holds);
              if (failed.length === 0) {
                logger.info('宪法审计：全绿（%d 项检查）', report.checks.length);
              } else {
                logger.warn('宪法审计：违宪 %d/%d —%s', failed.length, report.checks.length, failed.map((c) => `${c.name}: ${c.detail}`).join('；'));
              }
            }
            symbiosisTickCount += 1;
            // 创世纪 G3 · 探针即公开市场操作：检测对照市场流动性枯竭
            // （饿死/陈旧臂），预算限定内注入真实微任务（~10-50 token）——
            // 真实调用、真实结算，绝非伪造证据。未启用零介入。
            if (pLoop && probeOps) {
              const now = Date.now();
              for (const order of probeOps.due(pLoop.eventLog(), now)) {
                if (!probeOps.admit(now)) break;
                try {
                  const res = await llm.chat(order.modelId, [{ role: 'user', content: '回复两个字：正常' }], { maxTokens: 16, timeout: 30_000 });
                  const ok = (res?.content ?? '').trim().length > 0;
                  probeOps.record(now);
                  symbiosisBridge.settleTask(
                    { success: ok, nodeResults: [{ modelId: order.modelId, success: ok, quality: ok ? 0.9 : 0.1, tokensUsed: res?.tokensUsed ?? 0 }] },
                    { taskContext: order.taskContext },
                  );
                  logger.info('G3 流动性注入：%s @%s（%s；预算 %s/%s）', order.modelId, order.taskContext ?? '全局', order.reason, probeOps.used(now), '上限见配置');
                } catch (err) {
                  probeOps.record(now);
                  symbiosisBridge.settleTask(
                    { success: false, nodeResults: [{ modelId: order.modelId, success: false, quality: 0, error: err instanceof Error ? err.message : String(err) }] },
                    { taskContext: order.taskContext },
                  );
                  logger.info('G3 流动性注入（失败入账，分型分账）：%s — %s', order.modelId, err instanceof Error ? err.message.slice(0, 80) : '未知错误');
                }
              }
            }
            // B 路线：能量反哺调度——每轮心跳把经济健康度折算为调度乘数
            // （赚钱升权 / 亏损降权；开关关闭时 scheduler 侧乘数恒为 1）
            if (schedulingFeedbackEnabled) {
              const signals = symbiosisBridge.economicSignals();
              modelScheduler.updateEconomicSignals(
                new Map([...signals].map(([modelId, s]) => [modelId, s.multiplier])),
              );
            }
            // C 路线：能量 Sankey 周期落盘（自包含 HTML，零依赖离线可开）
            symbiosisTickCount += 1;
            if (sankeyPath && symbiosisTickCount % sankeyEveryNTicks === 0) {
              try {
                // 24.0 差分隐私：能量流数值（links[].amount / totals 等）经
                // Laplace 扰动后再渲染——账本口径不再裸暴露单一模型/渠道的
                // 精确金额；seqRange / count 等键被 SKIP 正则自动跳过，
                // 预算耗尽后剩余字段原样返回（status 可审计）。
                const sankeyReport = symbiosisBridge.sankey();
                const safeReport = privacyAccountant
                  ? perturbNumbers(sankeyReport, privacyAccountant)
                  : sankeyReport;
                fs.writeFileSync(sankeyPath, renderSankeyHtml(safeReport));
                broadcast({ type: 'sankey-updated', path: sankeyPath, tick: symbiosisTickCount });
                logger.debug('能量 Sankey 已落盘: %s', sankeyPath);
              } catch (err) {
                logger.warn('能量 Sankey 落盘失败: %s', err instanceof Error ? err.message : err);
              }
            }
            if (driftInsights.length > 0) {
              broadcast({ type: 'market-divergence', count: driftInsights.length, messages: driftInsights.map((i) => i.message) });
              logger.warn('信念市场漂移告警 ×%d（市场价 vs 统计估计显著背离）', driftInsights.length);
            }
            // A 路线：futarchy 进化表决决议广播（funded / market-rejected / governor-vetoed）
            const decisions = symbiosisBridge.lastFutarchyDecisions();
            if (decisions.length > 0) {
              for (const d of decisions) {
                broadcast({ type: 'futarchy-decision', ...d });
                logger.info(
                  'futarchy 进化表决：%s（隐含成功概率 %.3f%s）',
                  d.decision,
                  d.impliedProb,
                  d.decision === 'funded' ? ` → 已资助执行，行动${d.actionSuccess ? '成功' : '失败'}` : '',
                );
              }
            }
            return driftInsights;
          },
        }
      : undefined,
  });

  if (kernelsCfg.globalWorkspace?.enabled === true) {
    // 缺省投标者 = 三引擎最小代表团（哨兵/进化/预算——遥测估计口径：信号
    // 密度折算 novelty/urgency、目标关联折算 relevance；编排层可随时以
    // 真实引擎读数替换，总线数学不因代表团的简省而改变）。
    autonomyLoop.attachGlobalWorkspace(
      [
        {
          id: 'sentinel',
          bid: (ctx) => ({
            novelty: Math.min(1, ctx.signals.length / 8),
            relevance: ctx.goal ? 0.7 : 0.4,
            confidence: 0.8,
            urgency: Math.min(1, ctx.signals.length / 12),
          }),
          describe: (ctx) => (ctx.signals.length >= 4 ? ['异常爆发'] : ['常规信号流']),
        },
        {
          id: 'evolution',
          bid: (ctx) => ({ novelty: 0.3, relevance: ctx.goal ? 0.8 : 0.3, confidence: 0.6, urgency: 0.2 }),
          describe: () => ['策略突破候选'],
        },
        {
          id: 'budget',
          bid: () => ({ novelty: 0.2, relevance: 0.5, confidence: 0.9, urgency: 0.6 }),
          describe: () => ['预算告警监视'],
        },
      ],
      { threshold: kernelsCfg.globalWorkspace.threshold, temperature: kernelsCfg.globalWorkspace.temperature },
    );
    logger.info('96.0 全局工作空间内核已挂载：跨引擎意识总线（心跳旁路仲裁，缺省三引擎代表团投标）');
  }
  /**
   * 10 步链路编排主流程（第 3~10 步）
   *
   * 深度优化：第 3~4 步由决策引擎四级流水线完成
   * （规则快速路径 → 决策缓存 → strategist → 启发式兜底）
   */
  async function processBatch(batch: SignalBatch): Promise<void> {
    // ── A17 审计：批次追踪 id + 第 1/2 步检查点（信号接入 / 聚合交付）──
    pipelineBatchSeq += 1;
    const traceId = `batch-${pipelineBatchSeq}`;
    pipelineAudit.mark(traceId, 1, 'ok', {
      signals: batch.signals.length,
      sources: [...new Set(batch.signals.map((s) => s.source))],
      reason: batch.reason,
    });
    pipelineAudit.mark(traceId, 2, 'ok', {
      occurrences: batch.signals.reduce((sum, s) => sum + s.occurrences, 0),
      types: [...new Set(batch.signals.map((s) => s.type))],
      ...(batch.maxProvenanceDepth !== undefined ? { maxProvenanceDepth: batch.maxProvenanceDepth } : {}),
    });
    broadcast({ type: 'batch-start', signalCount: batch.signals.length, signals: batch.signals.map((s) => ({ id: s.id, type: s.type })) });

    // R4-A17 深化 3：批次边界清空预取在途条目（未消费预取作废——消费侧直算，零漂移）
    if (pipelinePrefetchOn) stepPrefetcher.clear();

    // ── 自主智能·预见：世界模型学习本批信号到达规律 ──
    for (const signal of batch.signals) {
      worldModel.observeArrival(signal.type, signal.receivedAt);
    }

    // ── 自主智能：策略进化基因组选择 → 决策引擎参数落地 ──
    const genome = strategyEvolution.selectGenome();
    decisionEngine.updateConfig({ ...genome.genes });

    // ── 第 3~4 步：决策引擎（优先级排序 + 战略决策） ──
    broadcast({ type: 'strategist-thinking', step: 3, message: '决策引擎四级流水线评估中' });
    const history = buildSignalHistory(batch.signals);
    pipelineAudit.begin(traceId, 3);
    const decisions = await decisionEngine.decide(batch.signals, history);
    const sorted = [...batch.signals].sort((a, b) => (decisions.get(b.id)?.urgency ?? 0) - (decisions.get(a.id)?.urgency ?? 0));
    pipelineAudit.end(traceId, 3, 'ok', {
      order: sorted.map((s) => s.id),
      urgencies: sorted.map((s) => decisions.get(s.id)?.urgency ?? 0),
    });

    broadcast({ type: 'strategist-thinking', step: 4, message: '战略决策完成，按紧急度执行' });
    for (const signal of sorted) {
      const decision = decisions.get(signal.id);
      const action = decision?.action ?? 'execute';
      signal.urgency = signal.urgency ?? decision?.urgency ?? 0.5;
      broadcast({
        type: 'signal-received',
        signal: { id: signal.id, type: signal.type, urgency: signal.urgency, decision: action },
        decisionSource: decision?.source,
        confidence: decision?.confidence,
        pendingCount: sentinel.getPendingSignals().length,
      });
      ctx.emit('scheduler/signal', signal);
      // ── A17 审计：第 4 步检查点（战略决策结局——execute/defer/dismiss/ask-user）──
      pipelineAudit.mark(traceId, 4, action, {
        signalId: signal.id,
        urgency: signal.urgency,
        ...(decision?.source !== undefined ? { source: decision.source } : {}),
        ...(decision?.confidence !== undefined ? { confidence: decision.confidence } : {}),
      });

      try {
        if (action === 'execute') {
          // ── R4-A17 深化 3：步骤预取——本信号执行等待期（第 7 步 await）预取
          // 下一执行信号的第 5 步三重读取（微任务在宿主 await 让出时执行；
          // 消费侧经代际守卫，结果恒与直算一致——见 executeSignal 第 5 步）。
          if (pipelinePrefetchOn) {
            const nextExecute = sorted.slice(sorted.indexOf(signal) + 1).find((s) => (decisions.get(s.id)?.action ?? 'execute') === 'execute');
            if (nextExecute) {
              const prefetchSignal = nextExecute;
              const inferredNext = inferTaskContextMemo(prefetchSignal);
              stepPrefetcher.fire(`step5:${prefetchSignal.id}`, () => ({
                lookup: optimizer.lookupExperience(prefetchSignal.type, inferredNext.complexity, inferredNext.features, { length: inferredNext.length }),
                strategies: memory.getStrategies(prefetchSignal.type, 3),
                lessons: reflectionEngine.getLessons(prefetchSignal.type, 3),
              }));
            }
          }
          const result = await executeSignal(signal, traceId);
          // 决策反馈闭环：按真实结局修正决策引擎缓存与规则计数器
          //（R4-A17 深化 1：指纹经跨步骤缓存——纯函数，命中与直算逐位一致）
          // result 为 null（共识否决 / 治理拦截——未实际执行）记 acceptable：
          // 既不误报成功抑制同类信号，也不误记失败驱动升级规则
          const feedback = result === null ? 'acceptable' : result.success ? 'good' : 'failed';
          const fingerprint = pipelineFingerprint(signal);
          decisionEngine.recordOutcome(signal.type, fingerprint, feedback);
          // 自主智能：策略进化适应度回写（同口径——失败/未执行不再虚记 good）
          strategyEvolution.recordOutcome(genome.id, feedback);
          // 目标进度回写：仅实际执行后结算（未执行 null 保持 pending 待重试，不虚记完成）
          if (result !== null) settleGoalProgress(signal.id, result.success);
          // 自主智能·边界：治理器结果回写（熔断器 / 预算统计）
          governor.recordOutcome(result ? result.success : false, result?.totalTokens ?? 0, 0);
          // 自主智能·内在动机：探索任务回写好奇心收获
          if (signal.payload?.exploration) {
            curiosity.recordExploration(signal.type, Boolean(result?.success), result ? `质量 ${result.avgQuality.toFixed(2)}` : undefined);
          }
        } else if (action === 'defer') {
          deferredQueue.push({ signal, deferUntil: Date.now() + (decision?.deferMs ?? 60_000) });
          recordDecision(signal, action, 'acceptable', `延迟 ${Math.round((decision?.deferMs ?? 60_000) / 1000)}s 后重审（${decision?.reason ?? ''}）`);
          strategyEvolution.recordOutcome(genome.id, 'acceptable');
        } else if (action === 'ask-user') {
          recordDecision(signal, action, 'acceptable', decision?.reason ?? '需要人工确认');
          strategyEvolution.recordOutcome(genome.id, 'acceptable');
        } else {
          recordDecision(signal, 'dismiss', 'good', decision?.reason ?? '战略决策忽略');
          strategyEvolution.recordOutcome(genome.id, 'good');
          // dismiss 也反馈给决策引擎（抑制窗口依赖成功记录，dismiss 不记录成功）
        }
      } catch (err) {
        logger.error('信号 %s 处理失败: %s', signal.id, (err as Error).message);
        pipelineAudit.mark(traceId, 4, 'failed', { signalId: signal.id, error: (err as Error).message });
        recordDecision(signal, action, 'failed', (err as Error).message);
        // 失败反馈：驱动失败升级规则（R4-A17 深化 1：指纹经跨步骤缓存）
        const fingerprint = pipelineFingerprint(signal);
        decisionEngine.recordOutcome(signal.type, fingerprint, 'failed');
        // 自主智能：失败适应度回写 + 目标进度回写
        strategyEvolution.recordOutcome(genome.id, 'failed');
        settleGoalProgress(signal.id, false);
        // 自主智能·边界：治理器失败回写（驱动熔断器）
        governor.recordOutcome(false, 0, 0);
        // 自主智能·内在动机：探索失败回写
        if (signal.payload?.exploration) {
          curiosity.recordExploration(signal.type, false, (err as Error).message);
        }
      }
    }

    // 到期延迟信号重新入队
    const now = Date.now();
    for (let i = deferredQueue.length - 1; i >= 0; i -= 1) {
      const item = deferredQueue[i];
      if (item.deferUntil <= now) {
        deferredQueue.splice(i, 1);
        sentinel.ingest({ type: item.signal.type, description: item.signal.description, payload: item.signal.payload, source: 'deferred' });
      }
    }
  }

  /** 目标进度回写：信号执行完成后更新绑定的目标子任务状态 */
  function settleGoalProgress(signalId: string, success: boolean): void {
    const bound = goalEngine.findBySignal(signalId);
    if (!bound) return;
    const transition = goalEngine.recordSubtaskOutcome(bound.goal.id, bound.subtask.id, success, success ? '执行成功' : '执行失败');
    broadcast({ type: 'goal-progress', goalId: bound.goal.id, subtaskId: bound.subtask.id, success, transition });
    if (transition === 'completed') {
      logger.info('自主目标达成: %s', bound.goal.title);
      broadcast({ type: 'goal-completed', goalId: bound.goal.id, title: bound.goal.title });
    } else if (transition === 'abandoned') {
      logger.warn('自主目标放弃: %s', bound.goal.title);
    }
  }

  /** 构建信号历史统计（决策引擎上下文，来自长期记忆） */
  function buildSignalHistory(signals: Signal[]): Map<string, SignalHistoryStats> {
    const history = new Map<string, SignalHistoryStats>();
    for (const signal of signals) {
      if (history.has(signal.type)) continue;
      const decisionStats = memory.getDecisionSuccessRate(signal.type);
      const pattern = memory.findPattern(signal.type, 0.5);
      history.set(signal.type, {
        totalDecisions: decisionStats.total,
        successRate: decisionStats.successRate,
        avgExecutionTime: pattern?.avgExecutionTime ?? 0,
        avgTokenCost: pattern && pattern.successfulPlans.length > 0
          ? pattern.successfulPlans.reduce((sum, p) => sum + p.tokenCost, 0) / pattern.successfulPlans.length
          : 0,
      });
    }
    return history;
  }

  /**
   * 推断信号的任务上下文（第二阶段升级）
   *
   * 此前调用 lookupExperience 时 complexity 硬编码 0.5、features 恒为空，
   * 导致程序记忆中 complexity>=0.7 / feature contains code 类条件永不满足，
   * 三层级联中最高层从未真正命中。此处在计划生成前用启发式从信号描述推断
   * features / complexity / length，让程序记忆与语义记忆的条件匹配真正生效。
   * （启发式仅影响"记忆检索"这一只读环节，不影响任何执行语义，风险可控）
   */
  function inferTaskContext(signal: Signal): { features: string[]; complexity: number; length: number } {
    const text = `${signal.type} ${signal.description}`.toLowerCase();
    const keywords: Array<[string, string]> = [
      ['code', 'code'], ['代码', 'code'], ['refactor', 'code'], ['重构', 'code'],
      ['review', 'review'], ['审查', 'review'],
      ['test', 'test'], ['测试', 'test'],
      ['doc', 'documentation'], ['文档', 'documentation'], ['翻译', 'translation'], ['translate', 'translation'],
      ['analyz', 'analysis'], ['分析', 'analysis'], ['report', 'analysis'],
    ];
    const features = [...new Set(keywords.filter(([kw]) => text.includes(kw)).map(([, tag]) => tag))];
    // 复杂度启发式：描述长度归一（100~4000 字符 → 0.4~0.95），叠加特征加成
    const length = signal.description.length;
    let complexity = Math.min(0.95, 0.4 + (Math.log10(Math.max(10, length)) - 2) * 0.35);
    if (features.includes('code')) complexity = Math.min(1, complexity + 0.15);
    if (features.length >= 3) complexity = Math.min(1, complexity + 0.05);
    return { features, complexity, length };
  }

  // ── 第四轮 R4-A17 深化 1：跨步骤派生值缓存读写口径（旗标关 = 直算，逐位一致）──
  // 信号指纹（sha256）与任务上下文推断均为纯函数（键即全部输入），重复
  // 信号（延迟重审回注 / 周期性监控告警同文复发）跨批次跨步骤命中缓存，
  // 结果与直算逐位一致（同输入同输出）。旗标关时不经过缓存容器。
  const pipelineFingerprint = (signal: Pick<Signal, 'type' | 'description'>): string => {
    if (!pipelineCacheOn) return decisionEngine.fingerprint(signal);
    const key = `fp:${signal.type}:${signal.description}`;
    const cached = pipelineStepCache.get(key) as string | undefined;
    if (cached !== undefined) return cached;
    const value = decisionEngine.fingerprint(signal);
    pipelineStepCache.set(key, value, { pure: true });
    return value;
  };
  const inferTaskContextMemo = (signal: Signal): { features: string[]; complexity: number; length: number } => {
    if (!pipelineCacheOn) return inferTaskContext(signal);
    const key = `ctx:${signal.type}:${signal.description}`;
    const cached = pipelineStepCache.get(key) as { features: string[]; complexity: number; length: number } | undefined;
    if (cached !== undefined) return cached;
    const value = inferTaskContext(signal);
    pipelineStepCache.set(key, value, { pure: true });
    return value;
  };

  /** 第 5 步三重读取产物（经验检索 + 蒸馏策略 + 历史教训——深化 2/3 的载荷口径） */
  interface Step5Trio {
    lookup: ReturnType<Optimizer['lookupExperience']>;
    strategies: ReturnType<LongTermMemory['getStrategies']>;
    lessons: ReturnType<ReflectionEngine['getLessons']>;
  }

  /**
   * 执行单个信号（第 5~10 步）
   * @param traceId 审计追踪 id（批次口径；A17 纯记录，不影响执行语义）
   * @returns 计划执行结果（共识未提交时返回 null）
   */
  async function executeSignal(signal: Signal, traceId = ''): Promise<PlanExecutionResult | null> {
    // 共识门控：集群模式下决策需经 Raft 提交
    if (raft) {
      const proposal = await raft.propose({
        type: 'execute-plan',
        signalId: signal.id,
        signalDescription: signal.description,
        decision: {
          action: 'execute',
          urgency: signal.urgency ?? 0.5,
          confidence: 1,
          reason: `共识门控提交执行：${signal.description}`,
          source: 'rule',
          decidedAt: Date.now(),
        },
        proposedBy: cfg.sync?.localNodeId ?? 'node-dev-01',
      });
      if (!proposal.committed) {
        recordDecision(signal, 'execute', 'failed', '共识提案未提交');
        pipelineAudit.mark(traceId, 5, 'skipped', { signalId: signal.id, reason: 'consensus-rejected' });
        return null;
      }
    }

    // 第 5 步：经验检索（优化器：记忆库 → 优化器，叠加蒸馏策略与历史教训）
    // 第二阶段升级：传入推断的 features/complexity/length，让程序/语义记忆的条件匹配真正生效
    // R4-A17 深化接线（全部旗标缺省关 = 原直算路径，逐位一致）：
    // ① 深化 1 crossStepCache：任务上下文推断经跨步骤缓存（纯函数记忆化）；
    // ② 深化 2 degradationLadder：三重读取异常时 主路径→简化路径→兜底直通（逐级入审计）；
    // ③ 深化 3 stepPrefetch：执行等待期预取的代际守卫消费（结果恒与直算一致）。
    const taskType = signal.type;
    const inferred = inferTaskContextMemo(signal);
    pipelineAudit.begin(traceId, 5);
    const runStep5Trio = (): Step5Trio => ({
      lookup: optimizer.lookupExperience(taskType, inferred.complexity, inferred.features, { length: inferred.length }),
      strategies: memory.getStrategies(taskType, 3),
      lessons: reflectionEngine.getLessons(taskType, 3),
    });
    let lookup: Step5Trio['lookup'];
    let strategies: Step5Trio['strategies'];
    let lessons: Step5Trio['lessons'];
    let step5Ladder: DegradationLadderResult<Step5Trio> | undefined;
    if (pipelineLadderOn) {
      const policy = modelScheduler.getPolicy();
      step5Ladder = await runDegradationLadder<Step5Trio>([
        // L1 主路径：完整三重读取（features/complexity/length 全上下文）
        { name: 'main', run: runStep5Trio },
        // L2 简化路径：退化为裸任务类型检索（无特征上下文），跳过策略/教训读取
        {
          name: 'simplified',
          run: () => ({
            lookup: optimizer.lookupExperience(taskType, 0.5),
            strategies: [],
            lessons: [],
          }),
        },
        // L3 兜底直通：零记忆检索（空推荐直通执行——链路不因经验检索故障中断）
        {
          name: 'fallback',
          run: () => ({
            lookup: {
              recommendedModels: {},
              historicalSuccessRate: 0,
              avgExecutionTime: 0,
              memoryLayer: 'none' as const,
              rationale: `降级直通：经验检索不可用（任务类型 ${taskType}），无记忆推荐`,
              avoidModels: [],
              policyVersion: `${policy.id}@v${policy.version}`,
            },
            strategies: [],
            lessons: [],
          }),
        },
      ]);
      ({ lookup, strategies, lessons } = step5Ladder.result);
    } else if (pipelinePrefetchOn) {
      ({ lookup, strategies, lessons } = (await stepPrefetcher.consume(`step5:${signal.id}`, runStep5Trio)).value);
    } else {
      ({ lookup, strategies, lessons } = runStep5Trio());
    }
    if (step5Ladder !== undefined && step5Ladder.usedRung > 1) {
      pipelineLadderDegradations += 1;
      pipelineAudit.mark(traceId, 5, 'degraded', {
        signalId: signal.id,
        rung: step5Ladder.usedRung,
        attempts: step5Ladder.attempts.map((a) => `L${a.rung}:${a.name}${a.error ? `（${a.error}）` : ''}`),
      });
      logger.warn(
        '第 5 步经验检索降级至 L%d：%s',
        step5Ladder.usedRung,
        step5Ladder.attempts.map((a) => `${a.name}${a.error ? `（${a.error}）` : ''}`).join(' → '),
      );
    }
    pipelineAudit.end(traceId, 5, 'ok', {
      taskType,
      memoryLayer: lookup.memoryLayer,
      ...(lookup.pattern !== undefined ? { patternConfidence: lookup.pattern.confidence } : {}),
      strategies: strategies.length,
      lessons: lessons.length,
      features: inferred.features,
      complexity: Number(inferred.complexity.toFixed(3)),
    });
    broadcast({
      type: 'strategist-thinking',
      step: 5,
      message: `经验检索[记忆层级:${lookup.memoryLayer}]: ${lookup.rationale}，蒸馏策略 ${strategies.length} 条，历史教训 ${lessons.length} 条`,
    });

    // 第二阶段升级：消费程序记忆动作——
    // 1) avoid-model 负向约束：从推荐组合中剔除被规避模型（如历史超时/能力不足的模型）
    // 2) 广播命中动作（enable-cot / parallelism / param-tune 等），供执行侧与可观测性消费
    const avoided = new Set(lookup.avoidModels ?? []);
    const effectiveRecommended = Object.fromEntries(
      Object.entries(lookup.recommendedModels).filter(([, model]) => !avoided.has(model)),
    );
    if (avoided.size > 0 || (lookup.suggestedActions?.length ?? 0) > 0) {
      broadcast({
        type: 'procedural-actions-applied',
        signalId: signal.id,
        avoidedModels: [...avoided],
        actions: lookup.suggestedActions?.map((a) => ({ type: a.type, params: a.params, rationale: a.rationale })) ?? [],
      });
    }

    // 第 6 步：计划生成
    // 经验快路径（优化器）：命中高置信度成熟模式时，直接复用历史最优成功计划，
    // 跳过 strategist LLM 重新规划（越用越快、越稳、越省 token）
    // R4-A17 深化 2：degradationLadder 开启时计划生成异常走三级降级
    //（L1 快路径/LLM 规划 → L2 离线兜底单节点 → L3 兜底直通内联单节点计划）；
    // 关闭时保持原路径逐位一致（LLM 失败仍走既有「兜底计划」分支）。
    const runStep6LLM = async (throwOnChatError: boolean): Promise<ExecutionPlan> => {
      // 常规路径：strategist 输出 DAG，注入蒸馏策略与教训上下文
      let strategistOutput: string | undefined;
      try {
        // 防幻觉（自主学习建议 3）：冗长记忆 ID 转短索引（#1…）注入模型，输出后反解回完整 ID
        const aliasMap = new AliasMap();
        const strategyLines = strategies.map((s) => `${aliasMap.encode(s.id)} ${s.description}`);
        const lessonLines = lessons.map((l) => `${aliasMap.encode(l.id)} ${l.lesson}→${l.suggestion}`);
        const experienceContext = [
          lookup.pattern ? `历史经验(推荐模型): ${JSON.stringify(effectiveRecommended)}` : '',
          strategyLines.length > 0 ? `蒸馏策略(引用时仅用短索引): ${strategyLines.join('；')}` : '',
          lessonLines.length > 0 ? `历史教训(务必规避，引用时仅用短索引): ${lessonLines.join('；')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        const response = await llm.chat(
          strategistId,
          [
            { role: 'system', content: '你是任务规划器。将任务拆解为 DAG，输出 JSON: {"nodes":[{"id","description","type","dependsOn"}],"parallelismStrategy":"layered"}。' },
            { role: 'user', content: `任务: ${signal.description}\n任务类型: ${taskType}${experienceContext ? `\n${experienceContext}` : ''}` },
          ],
          { timeout: 30_000, maxRetries: 1 },
        );
        // 模型输出中的短索引反解回完整记忆 ID（未登记的索引原样保留）
        strategistOutput = aliasMap.decodeText(response.content);
      } catch (err) {
        if (throwOnChatError) throw err;
        logger.warn('strategist 计划生成失败，使用兜底计划: %s', (err as Error).message);
      }
      return taskExecutor.buildPlan(signal.description, strategistOutput, taskType);
    };
    let plan: ExecutionPlan;
    let fastPathHit = false;
    let step6Ladder: DegradationLadderResult<{ plan: ExecutionPlan; fastPathHit: boolean }> | undefined;
    if (pipelineLadderOn) {
      step6Ladder = await runDegradationLadder<{ plan: ExecutionPlan; fastPathHit: boolean }>([
        // L1 主路径：经验快路径 / strategist LLM 规划（LLM 失败上抛 → 降级）
        {
          name: 'main',
          run: async () => {
            const fastPlan = optimizer.recallPlan(lookup, signal.description);
            if (fastPlan) return { plan: fastPlan, fastPathHit: true };
            return { plan: await runStep6LLM(true), fastPathHit: false };
          },
        },
        // L2 简化路径：离线兜底单节点计划（与既有 LLM 失败兜底同款口径）
        { name: 'simplified', run: () => ({ plan: taskExecutor.buildPlan(signal.description, undefined, taskType), fastPathHit: false }) },
        // L3 兜底直通：内联单节点计划（buildPlan 亦不可用时链路仍不中断）
        {
          name: 'fallback',
          run: () => ({
            plan: {
              objective: signal.description,
              nodes: [{ id: 'node-1', description: signal.description, type: taskType, dependsOn: [] }],
              parallelismStrategy: 'sequential',
              source: 'fallback',
            },
            fastPathHit: false,
          }),
        },
      ]);
      plan = step6Ladder.result.plan;
      fastPathHit = step6Ladder.result.fastPathHit;
    } else {
      const fastPlan = optimizer.recallPlan(lookup, signal.description);
      fastPathHit = fastPlan !== undefined;
      if (fastPlan) {
        // 创世纪 G4 · 快路径反垄断：缺省复用历史模型指派（零漂移）；
        // 关闭后快路径只复用计划**结构**（怎么做），模型字段解钉——
        // 执行期重新选型（探索与学习保留选择权；soak/实测双重确认
        // 钉死会让新臂永久饿死、桶内对照断流）
        plan = fastPathReuseModels ? fastPlan : { ...fastPlan, nodes: fastPlan.nodes.map((n) => ({ ...n, modelId: undefined })) };
      } else {
        plan = await runStep6LLM(false);
      }
    }
    if (step6Ladder !== undefined && step6Ladder.usedRung > 1) {
      pipelineLadderDegradations += 1;
      pipelineAudit.mark(traceId, 6, 'degraded', {
        signalId: signal.id,
        rung: step6Ladder.usedRung,
        attempts: step6Ladder.attempts.map((a) => `L${a.rung}:${a.name}${a.error ? `（${a.error}）` : ''}`),
      });
      logger.warn(
        '第 6 步计划生成降级至 L%d：%s',
        step6Ladder.usedRung,
        step6Ladder.attempts.map((a) => `${a.name}${a.error ? `（${a.error}）` : ''}`).join(' → '),
      );
    }
    if (fastPathHit) {
      broadcast({
        type: 'strategist-thinking',
        step: 6,
        message: `经验快路径：复用历史成功计划（置信度 ${lookup.pattern!.confidence.toFixed(2)}，${plan.nodes.length} 节点），跳过 LLM 规划`,
      });
      logger.info('经验快路径命中：任务类型 %s 复用历史计划（%d 节点）', taskType, plan.nodes.length);
    }
    // ── A17 审计：第 6 步检查点（快路径复用 vs 重新规划）──
    pipelineAudit.mark(traceId, 6, fastPathHit ? 'fast-path' : 'planned', {
      signalId: signal.id,
      fastPath: fastPathHit,
      nodes: plan.nodes.length,
      taskType,
    });

    // 第 7~10 步：并行执行 + 质量反思 + 级联触发 + 经验沉淀
    // 4.0 治理闭环：主执行路径接入安全治理器（升级前仅自主循环子集动作受治理，
    // 核心执行绕过限流/预算/置信度门控——治理器形同虚设）
    const governance = governor.govern('autonomous-execute', lookup.pattern?.confidence ?? 0.8);
    if (!governance.allowed) {
      recordDecision(signal, 'execute', 'failed', `治理拦截：${governance.reason ?? 'unknown'}`);
      pipelineAudit.mark(traceId, 7, 'blocked', { signalId: signal.id, blockedBy: governance.blockedBy, reason: governance.reason });
      for (const st of [8, 9, 10]) pipelineAudit.mark(traceId, st, 'skipped', { signalId: signal.id, reason: 'governed' });
      broadcast({ type: 'execution-governed', signalId: signal.id, blockedBy: governance.blockedBy, reason: governance.reason });
      logger.warn('执行被安全治理器拦截 [%s]: %s', governance.blockedBy, governance.reason);
      return null;
    }

    // 经验驱动选型：把记忆推荐模型组合（按节点类型，已剔除 avoid-model 目标）传入执行器
    // 4.0：avoidModels 负向约束贯通执行全程（调度选型 + 重试切换均排除）
    if (hotReload) hotReload.registerTask(signal.id, taskType);
    const cascadesBefore = cascadeCount; // A17 审计：第 9 步级联计数基线
    pipelineAudit.begin(traceId, 7);
    try {
      const result = await taskExecutor.executePlan(signal, plan, effectiveRecommended, { avoidModels: [...avoided] });
      pipelineAudit.end(traceId, 7, result.success ? 'ok' : 'failed', {
        signalId: signal.id,
        nodes: plan.nodes.length,
        successCount: result.successCount,
        avgQuality: Number(result.avgQuality.toFixed(3)),
        totalTokens: result.totalTokens,
        ...(result.error !== undefined ? { error: result.error } : {}),
      });
      // ── A17 审计：第 8 步检查点（质量反思口径——质量分 vs 阈值 + 重试账目）──
      pipelineAudit.mark(traceId, 8, result.avgQuality >= cfg.qualityThreshold ? 'passed' : 'below-threshold', {
        signalId: signal.id,
        avgQuality: Number(result.avgQuality.toFixed(3)),
        threshold: cfg.qualityThreshold,
        retries: result.nodeResults.reduce((sum, n) => sum + Math.max(0, n.attempts - 1), 0),
      });
      // ── A17 审计：第 9 步检查点（级联触发计数——执行期内新级联信号数）──
      const cascaded = cascadeCount - cascadesBefore;
      pipelineAudit.mark(traceId, 9, cascaded > 0 ? 'ok' : 'none', { signalId: signal.id, cascaded });
      ctx.emit('scheduler/plan-complete', result, signal);
      recordDecision(signal, 'execute', result.success ? (result.avgQuality >= 0.85 ? 'excellent' : 'good') : 'failed', result.success ? `平均质量 ${result.avgQuality.toFixed(2)}` : result.error ?? '执行失败');

      // ── 第 10 步：反思器（任务执行 → 反思器 → 记忆更新） ──
      // 一次性完成：质量趋势记录 + 经验沉淀（模式/画像/失败记录）+
      // 蒸馏策略应用反馈回写（有效策略越用越强，无效策略自然淘汰）+ 教训提取/经验蒸馏
      // 第二阶段升级：语义/程序记忆应用反馈回写 + 达阈值自动触发知识蒸馏
      // 第一阶段 2.0：调度决策洞察回注（Brier 校准闭环 + 反事实遗憾分析）
      reflector.reflectOnOutcome({
        signal,
        plan,
        result,
        appliedStrategies: strategies.map((s) => s.id),
        appliedMemoryIds: {
          semantic: lookup.matchedSemanticId ? [lookup.matchedSemanticId] : [],
          procedural: lookup.matchedProceduralIds ?? [],
        },
        decisionInsights: taskExecutor.getAndClearDecisionInsights(),
      });
      // R4-A17 深化：反思落盘后推进记忆写入代数（预取条目代际守卫的失效口径
      //——第 5 步三重读取的记忆输入已被本次反思改写，陈旧预取自动降级直算）
      pipelineStepCache.bump();
      // ── A17 审计：第 10 步检查点（反思与记忆更新完成——沉淀/策略反馈/蒸馏）──
      pipelineAudit.mark(traceId, 10, result.success ? 'ok' : 'recorded', {
        signalId: signal.id,
        success: result.success,
        appliedStrategies: strategies.length,
        ...(lookup.matchedSemanticId !== undefined ? { matchedSemantic: true } : {}),
        matchedProcedural: (lookup.matchedProceduralIds ?? []).length,
      });

      // ── 第五阶段 Phase 2.5：任务结算 → 能量经济（价值铸币闭环）──
      // 各模型按成功节点的质量加权分红；失败任务不铸币但记录贡献证据
      if (symbiosisBridge) {
        symbiosisBridge.settleTask(result, { taskContext: signal.type });
      }
      return result;
    } finally {
      if (hotReload) hotReload.unregisterTask(signal.id);
    }
  }

  /** 决策反馈沉淀（第 10 步组成部分） */
  function recordDecision(signal: Signal, decision: string, outcome: 'excellent' | 'good' | 'acceptable' | 'poor' | 'failed', reason: string): void {
    memory.recordDecisionFeedback({
      signalType: signal.type,
      signalDescription: signal.description,
      decision,
      outcome,
      outcomeReason: reason,
    });
    sync.recordChange('feedback-created', `fb-${signal.id}`, {
      id: `fb-${signal.id}`,
      timestamp: Date.now(),
      signalType: signal.type,
      signalDescription: signal.description,
      decision,
      outcome,
      outcomeReason: reason,
    });
  }

  /** 进度广播（enableProgress 关闭时为空操作） */
  function broadcast(event: Record<string, any>): void {
    if (!broadcaster) return;
    broadcaster.broadcast({ type: event.type as string, timestamp: Date.now(), ...event });
  }

  // ── 启动各引擎 ──
  if (broadcaster) {
    broadcaster.start();
    // R4-A17 modules.dashboardAlarmSources：统一告警源接线（安全总督熔断 /
    // 元认知冻结 / 哨兵风暴预算 → /api/alarm-feed；旗标关时第三参缺席——
    // 告警面板空态，零漂移）。真实读数源（非注入样例）：
    // - safety-governor：kill switch / 熔断态 / 连续失败（governor.getStatus）
    // - metacognition：外环全局冻结（metaController.getState().frozen）
    // - sentinel：全局风暴预算激活（stormBudgetView，未配置时缺席）
    const dashboardAlarmSources = modulesCfg.dashboardAlarmSources?.enabled === true
      ? {
          getAlarms: () => {
            const alarms: Array<{ id: string; source: string; severity: 'info' | 'warning' | 'critical'; title: string; detail?: string; timestamp: number }> = [];
            try {
              const status = governor.getStatus();
              if (status?.killSwitch) {
                alarms.push({ id: 'governor-kill-switch', source: 'safety-governor', severity: 'critical', title: '安全总督 Kill Switch 已触发', detail: `熔断态 ${String(status.circuitState)}，连续失败 ${String(status.consecutiveFailures)}`, timestamp: Date.now() });
              } else if (status?.circuitState === 'open') {
                alarms.push({ id: 'governor-circuit-open', source: 'safety-governor', severity: 'critical', title: '安全总督熔断器开启', detail: `连续失败 ${String(status.consecutiveFailures)}`, timestamp: Date.now() });
              } else if (typeof status?.consecutiveFailures === 'number' && status.consecutiveFailures >= 3) {
                alarms.push({ id: 'governor-failure-streak', source: 'safety-governor', severity: 'warning', title: '治理连续失败累计中', detail: `连续失败 ${String(status.consecutiveFailures)} 次`, timestamp: Date.now() });
              }
            } catch { /* 治理器读数缺席时诚实跳过 */ }
            try {
              if (metaController.getState().frozen) {
                alarms.push({ id: 'meta-layer-frozen', source: 'metacognition', severity: 'warning', title: '元认知外环全局冻结', detail: '调参已熔断（等待观察窗判定回滚/保留）', timestamp: Date.now() });
              }
            } catch { /* 元认知读数缺席时诚实跳过 */ }
            try {
              const storm = sentinel.stormBudgetView();
              if (storm?.active) {
                alarms.push({ id: 'sentinel-storm-budget', source: 'sentinel', severity: 'warning', title: '全局风暴预算收紧中', detail: `强度 ${storm.intensityPerSec?.toFixed(1) ?? '?'} 次/秒 ≥ 阈 ${storm.thresholdPerSec.toFixed(1)}（预算 ${storm.budgetPerSec.toFixed(1)}/s）`, timestamp: Date.now() });
              }
            } catch { /* 哨兵读数缺席时诚实跳过 */ }
            return alarms;
          },
        }
      : undefined;
    attachDashboard(broadcaster, () => llm.getModelStatuses(), dashboardAlarmSources);
    if (dashboardAlarmSources) {
      logger.info('模块域升级已挂载（1 旗标）：dashboardAlarmSources —— 统一告警源接入 /api/alarm-feed（安全总督 / 元认知 / 哨兵风暴预算）');
    }
  }
  sentinel.start();
  if (autonomyEnabled) {
    autonomyLoop.start();
    logger.info('自主心跳循环已启动（间隔 %dms）', cfg.autonomy?.heartbeatMs ?? 30_000);
  }
  if (raft) {
    raft.start();
    raft.onRoleChange((role, term) => broadcast({ type: 'role-change', role, term }));
  }
  if (hotReload) {
    hotReload.startWatching();
    hotReload.on('deploy-succeeded', (event: any) => broadcast({ type: 'plugin-reloaded', version: event.version }));
  }

  // 恢复已注册租户
  for (const tenant of cfg.tenants ?? []) {
    try {
      if (!tenantManager.getTenant(tenant.id)) tenantManager.registerTenant(tenant);
    } catch (err) {
      logger.warn('租户恢复失败 %s: %s', tenant.id, (err as Error).message);
    }
  }

  // 注册基准测试内置场景
  benchmark.registerBuiltinScenarios({
    memory,
    cryptoEngine: cryptoEngine ?? (new CryptoEngine({ enabled: false, masterKey: 'benchmark-placeholder', algorithm: 'aes-256-gcm', sensitiveFields: [], fullFileEncryption: false })),
    callLLM: (modelId: string, messages: any[]) => llm.chat(modelId, messages),
    models: mergedModels.map((m) => ({ id: m.id, endpoint: m.endpoint, apiKey: m.apiKey ?? '' })),
  });

  logger.info('调度器已启动: %d 个模型, 哨兵窗口 %ss, 进度端口 %s', mergedModels.length, cfg.sentinel?.aggregationWindow ?? 0.5, cfg.enableProgress ? String(cfg.progressPort) : '关闭');

  // ─────────────────────────── 12 Tool 注册 ───────────────────────────

  const tools = new ToolRegistry();

  // 1. autonomous_execute — 提交自主任务
  tools.register({
    name: 'autonomous_execute',
    description: '提交一个自主任务，由调度器完成感知-决策-执行-沉淀全链路',
    parameters: {
      task: { type: 'string', description: '任务描述', required: true },
      urgency: { type: 'number', description: '紧急度 0~1，缺省 0.8' },
    },
    handler: (args) => {
      if (!args.task || typeof args.task !== 'string') throw new ToolError('task 为必填字符串');
      const urgency = typeof args.urgency === 'number' ? Math.max(0, Math.min(1, args.urgency)) : 0.8;
      const signal = sentinel.ingest({ type: 'manual-task', description: args.task, payload: { task: args.task }, source: 'manual', urgency });
      return { signalId: signal.id, urgency, status: 'queued' };
    },
  });

  // 2. model_dashboard — 查看模型状态
  tools.register({
    name: 'model_dashboard',
    description: '查看所有已注册模型的运行时状态（并发、成功率、延迟、token、成本）',
    parameters: {},
    handler: () => ({ models: llm.getModelStatuses(), sentinel: sentinel.getStatus() }),
  });

  // 3. query_memory — 查询记忆库
  tools.register({
    name: 'query_memory',
    description: '查询长期记忆库（含蒸馏策略、教训、质量趋势、决策引擎统计）',
    parameters: {
      query_type: { type: 'string', description: '查询类型', required: true, enum: ['overview', 'patterns', 'model-profile', 'feedback', 'strategies', 'lessons', 'trends', 'decision-stats', 'goals', 'health', 'evolution', 'autonomy-status', 'world-model', 'curiosity', 'governance', 'introspect', 'keys', 'topology', 'influence'] },
      limit: { type: 'number', description: '返回条数上限，缺省 10' },
      task_type: { type: 'string', description: 'strategies/lessons 按任务类型过滤（可选）' },
    },
    handler: (args) => {
      const limit = typeof args.limit === 'number' ? args.limit : 10;
      switch (args.query_type) {
        case 'overview':
          return { globalStats: memory.getGlobalStats(), summary: memory.getMemorySummary() };
        case 'patterns':
          return { patterns: memory.getTopPatterns(limit) };
        case 'model-profile':
          return { profiles: memory.getAllModelProfiles() };
        case 'feedback':
          return { feedback: memory.getRecentFeedback(limit) };
        case 'strategies':
          return { strategies: args.task_type ? memory.getStrategies(String(args.task_type), limit) : memory.getAllStrategies().slice(0, limit) };
        case 'lessons':
          return { lessons: args.task_type ? reflectionEngine.getLessons(String(args.task_type), limit) : reflectionEngine.getAllLessons().slice(-limit) };
        case 'trends':
          return { trends: reflectionEngine.getTrendSummary() };
        case 'decision-stats':
          return { stats: decisionEngine.getStats(), audit: decisionEngine.getAudit(limit) };
        case 'goals':
          return { summary: goalEngine.getSummary(), goals: goalEngine.getAllGoals().slice(0, limit) };
        case 'health':
          return { health: metaCognition.getHealthReport(), anomalies: metaCognition.getAnomalies().slice(-limit), tuning: metaCognition.getTuningHistory().slice(-limit) };
        case 'evolution':
          return { evolution: strategyEvolution.getReport(), history: strategyEvolution.getEvolutionHistory().slice(-limit) };
        case 'autonomy-status':
          return { status: autonomyLoop.getStatus(), reports: autonomyLoop.getReports().slice(-limit) };
        case 'world-model':
          return { summary: worldModel.getSummary(), predictions: worldModel.predictArrivals().slice(0, limit) };
        case 'curiosity':
          return { summary: curiosity.getSummary(), gaps: curiosity.scanKnowledgeGaps().slice(0, limit) };
        case 'governance':
          return { status: governor.getStatus(), audit: governor.getAudit(limit) };
        case 'keys':
          return {
            health: keyHealth.status(),
            userOrder: keyHealth.getKeyOrder(),
            sources: Object.fromEntries(mergedModels.map((m) => [m.id, describeKeySources(m.id)])),
          };
        case 'introspect':
          return { introspection: autonomyLoop.introspect() };
        case 'topology':
          // 36.0：知识地形（H₀ 持续同调——大陆/孤岛/合并带；孤岛 = 盲区的拓扑定义）
          return { topography: memoryGraph.knowledgeTopography(typeof args.limit === 'number' && args.limit > 0 && args.limit < 1 ? args.limit : 0.2) };
        case 'influence':
          // 39.0：知识骨架（PageRank；未挂载时给出挂载提示）
          return {
            influential: memoryGraph.topInfluential(typeof args.limit === 'number' ? args.limit : 8),
            attached: cfg.autonomy?.spectralRanking?.enabled === true,
            hint: cfg.autonomy?.spectralRanking?.enabled === true ? undefined : 'autonomy.spectralRanking.enabled=true 后 related() 联想序升级为影响力加权',
          };
        default:
          throw new ToolError(`未知 query_type: ${args.query_type}`);
      }
    },
  });

  // 4. query_experience — 查询经验库
  tools.register({
    name: 'query_experience',
    description: '按任务类型检索历史经验（相似模式、成功率、推荐模型、记忆层级）',
    parameters: {
      task_type: { type: 'string', description: '任务类型（可选，缺省返回 Top 模式）' },
      complexity: { type: 'number', description: '复杂度 0~1（可选，缺省 0.5）' },
      features: { type: 'string', description: '特征标签逗号分隔（可选，如 code,test）' },
    },
    handler: (args) => {
      if (args.task_type) {
        // 第二阶段升级：支持传入 complexity/features，真实触发程序/语义记忆条件匹配
        const complexity = typeof args.complexity === 'number' ? Math.max(0, Math.min(1, args.complexity)) : 0.5;
        const features = typeof args.features === 'string' ? args.features.split(',').map((f: string) => f.trim()).filter(Boolean) : [];
        const lookup = optimizer.lookupExperience(String(args.task_type), complexity, features);
        return { taskType: args.task_type, ...lookup };
      }
      return { patterns: memory.getTopPatterns(10) };
    },
  });

  // 4b. distill_knowledge — 触发知识蒸馏（第二阶段：语义+程序记忆）
  tools.register({
    name: 'distill_knowledge',
    description: '触发知识蒸馏：从累积情景记忆中产出语义记忆与程序记忆（三层记忆升级；强制全量蒸馏，绕过水位门控）',
    parameters: {},
    handler: async () => {
      const report = await reflector.distillKnowledge({ force: true });
      return {
        distilledAt: report.distilledAt,
        sourceEpisodicCount: report.sourceEpisodicCount,
        semanticCount: report.semanticMemories.length,
        proceduralCount: report.proceduralMemories.length,
        strategyCount: report.strategies.length,
        mergedSemanticCount: report.mergedSemanticCount ?? 0,
        mergedProceduralCount: report.mergedProceduralCount ?? 0,
        supersededCount: report.supersededCount ?? 0,
        semanticMemories: report.semanticMemories.map((m) => ({ id: m.id, domain: m.domain, statement: m.statement, confidence: m.confidence, supportCount: m.supportCount })),
        proceduralMemories: report.proceduralMemories.map((p) => ({ id: p.id, kind: p.kind, name: p.name, action: p.action.type, confidence: p.confidence, supportCount: p.supportCount })),
        summary: report.summary,
      };
    },
  });

  // 4c. mental_report — 心智报告（第四阶段：自我建模的人类审查入口）
  tools.register({
    name: 'mental_report',
    description:
      '第四阶段元认知层：生成/查询系统心智报告（策略优劣势、记忆健康趋势、进化器效率、稳定性风险、自我改进证据、推荐调整），支持人类审查与手动干预',
    parameters: {
      action: {
        type: 'string',
        description: 'generate 生成新报告（含保守调整推荐）/ latest 最近报告 / history 报告历史 / trend 趋势序列 / formatted 人类可读版',
        required: true,
        enum: ['generate', 'latest', 'history', 'trend', 'formatted'],
      },
      limit: { type: 'number', description: 'history 返回条数上限，缺省 10' },
    },
    handler: async (args) => {
      // 24.0 差分隐私：报告数值叶子经 Laplace 扰动后出站（id/时间戳/计数
      // 键自动跳过；未启用 privacy 时原样返回，逐位不变）。generate 分支的
      // 人类可读版从扰动后的报告渲染，保证文本与对象口径一致。
      const privacyView = <T,>(view: T): T => (privacyAccountant ? perturbNumbers(view, privacyAccountant) : view);
      switch (args.action) {
        case 'generate': {
          const report = await selfModel.generateMentalReport();
          const safeReport = privacyView(report);
          broadcast({ type: 'mental-report', reportIndex: report.reportIndex, status: 'generated', stabilityScore: report.systemStability.stabilityScore });
          return {
            report: safeReport,
            formatted: selfModel.formatReport(safeReport),
          };
        }
        case 'latest': {
          const report = selfModel.getLatestReport();
          if (!report) throw new ToolError('暂无心智报告，先执行 action=generate');
          return { report: privacyView(report) };
        }
        case 'history':
          return { history: privacyView(selfModel.getReportHistory().slice(-Math.max(1, args.limit ?? 10))) };
        case 'trend':
          return { trend: selfModel.getTrendSeries() };
        case 'formatted': {
          const report = selfModel.getLatestReport();
          if (!report) throw new ToolError('暂无心智报告，先执行 action=generate');
          return { formatted: selfModel.formatReport(report) };
        }
        default:
          throw new ToolError(`未知 action: ${args.action}`);
      }
    },
  });

  // 4e. self_knowledge — 自知之明报告（3.0：统一证据 + 校准自修正的运维入口）
  tools.register({
    name: 'self_knowledge',
    description:
      '3.0 自知之明报告：调度预测校准（Brier 分 / 残差 / 过自信-欠自信方向 / 自修正量）+ 全层证据普查（策略/语义/程序/模型画像四层的证据覆盖度、平均有效样本量、证据枯竭数、模型能力漂移）——系统知道自己哪些记忆可信、哪些在过期、预测有多准',
    parameters: {},
    handler: async () => {
      const report = reflector.getSelfKnowledge();
      return {
        generatedAt: report.generatedAt,
        calibration: report.calibration,
        census: report.census
          ? {
              generatedAt: report.census.generatedAt,
              layers: report.census.layers,
              driftedModels: report.census.driftedModels,
            }
          : undefined,
      };
    },
  });

  // 4d. meta_cognition — 元认知控制（第四阶段：手动干预入口）
  tools.register({
    name: 'meta_cognition',
    description:
      '第四阶段元认知控制器（2.0 学习型稳态控制）：evaluate 推进保守调整状态机（应用/观察/判定/回滚）/ status 旋钮面板、学习器有效性、熔断器与审计日志 / rollback 手动回滚最近调整 / override 手动覆盖旋钮（自动调整冻结）/ freeze 全局冻结与解冻 / rearm-breaker 复位熔断器（连续回滚触发的旋钮级或全局熔断）',
    parameters: {
      action: {
        type: 'string',
        description: '控制动作',
        required: true,
        enum: ['evaluate', 'status', 'rollback', 'override', 'unfreeze-knob', 'freeze', 'rearm-breaker'],
      },
      knob: { type: 'string', description: 'override / unfreeze-knob / rearm-breaker 时的旋钮 id（如 evolver.mutationRate）；rearm-breaker 缺省复位全部' },
      value: { type: 'number', description: 'override 时的目标取值' },
      frozen: { type: 'boolean', description: 'freeze 时的冻结开关（true 冻结 / false 解冻）' },
      limit: { type: 'number', description: 'status 时审计日志条数上限，缺省 20' },
    },
    handler: async (args) => {
      switch (args.action) {
        case 'evaluate': {
          const adjustment = await metaController.evaluateAndAdjust();
          return {
            status: adjustment.status,
            reportIndex: adjustment.reportIndex,
            applied: adjustment.applied,
            rolledBack: adjustment.rolledBack,
            committed: adjustment.committed,
            observation: adjustment.observation,
            skippedReason: adjustment.skippedReason,
            stabilityScore: adjustment.mentalReport.systemStability.stabilityScore,
            improvementEvidence: adjustment.mentalReport.improvementEvidence,
          };
        }
        case 'status': {
          const state = metaController.getState();
          return {
            frozen: state.frozen,
            frozenByBreaker: state.frozenByBreaker,
            manuallyFrozenKnobs: state.manuallyFrozenKnobs,
            circuitBreakers: state.circuitBreakers.filter((b) => b.tripped || b.consecutiveRollbacks > 0),
            learner: state.learner,
            safeEnvelopes: state.safeEnvelopes,
            pending: state.pending,
            knobs: state.knobs,
            counters: { adjustments: state.totalAdjustments, rollbacks: state.totalRollbacks, commits: state.totalCommits },
            auditTrail: state.auditTrail.slice(-Math.max(1, args.limit ?? 20)),
          };
        }
        case 'rollback':
          return { result: await metaController.rollbackLastAdjustment() };
        case 'override': {
          if (!args.knob || typeof args.value !== 'number') throw new ToolError('override 需要 knob 与 value 参数');
          return { result: metaController.setManualOverride(String(args.knob), args.value) };
        }
        case 'unfreeze-knob': {
          if (!args.knob) throw new ToolError('unfreeze-knob 需要 knob 参数');
          return { cleared: metaController.clearManualOverride(String(args.knob)) };
        }
        case 'freeze':
          metaController.setFrozen(args.frozen !== false);
          return { frozen: args.frozen !== false };
        case 'rearm-breaker':
          return { reArmed: metaController.reArmBreaker(args.knob ? String(args.knob) : undefined) };
        default:
          throw new ToolError(`未知 action: ${args.action}`);
      }
    },
  });

  // 5. maintain_memory — 维护记忆库
  tools.register({
    name: 'maintain_memory',
    description: '维护长期记忆库（清理过期数据 / 查看状态）',
    parameters: {
      action: { type: 'string', description: '维护动作', required: true, enum: ['prune', 'status'] },
      maxAgeDays: { type: 'number', description: 'prune 时保留的天数，缺省 90' },
    },
    handler: (args) => {
      if (args.action === 'prune') return { pruned: memory.prune(typeof args.maxAgeDays === 'number' ? args.maxAgeDays : 90) };
      if (args.action === 'status') return { globalStats: memory.getGlobalStats(), summary: memory.getMemorySummary() };
      throw new ToolError(`未知 action: ${args.action}`);
    },
  });

  // 6. manage_tenants — 管理多租户
  tools.register({
    name: 'manage_tenants',
    description: '多租户管理（列表 / 注册 / 移除 / 更新 / 统计 / 路径匹配）',
    parameters: {
      action: { type: 'string', description: '管理动作', required: true, enum: ['list', 'register', 'remove', 'update', 'stats', 'match'] },
      config: { type: 'object', description: 'register 时的租户配置' },
      tenantId: { type: 'string', description: '目标租户 id' },
      updates: { type: 'object', description: 'update 时的更新字段' },
      filePath: { type: 'string', description: 'match 时的文件路径' },
    },
    handler: (args) => {
      switch (args.action) {
        case 'list':
          return { tenants: tenantManager.getAllTenants().map((t) => ({ id: t.config.id, name: t.config.name, enabled: t.config.enabled !== false, activeExecutions: t.activeExecutions })) };
        case 'register':
          return { tenant: tenantManager.registerTenant(args.config).config };
        case 'remove':
          tenantManager.removeTenant(String(args.tenantId), Boolean(args.deleteData));
          return { removed: args.tenantId };
        case 'update':
          tenantManager.updateTenant(String(args.tenantId), args.updates ?? {});
          return { updated: args.tenantId };
        case 'stats':
          return { stats: tenantManager.getGlobalStats() };
        case 'match': {
          const matched = tenantManager.matchTenantByPath(String(args.filePath ?? ''));
          return { matched: matched ? { id: matched.config.id, name: matched.config.name } : null };
        }
        default:
          throw new ToolError(`未知 action: ${args.action}`);
      }
    },
  });

  // 7. manage_encryption — 管理加密
  tools.register({
    name: 'manage_encryption',
    description: '加密管理（生成密钥 / 轮换密钥 / 查看状态 / 加密存量文件 / 解密文件）',
    parameters: {
      action: { type: 'string', description: '加密动作', required: true, enum: ['generate-key', 'rotate-key', 'check-status', 'encrypt-existing', 'decrypt-file'] },
      filePath: { type: 'string', description: '目标文件路径（rotate-key / decrypt-file）' },
      newMasterKey: { type: 'string', description: 'rotate-key 的新主密钥' },
    },
    handler: (args) => {
      if (args.action === 'generate-key') return { key: CryptoEngine.generateKey() };
      if (args.action === 'check-status') {
        return { enabled: Boolean(cryptoEngine), algorithm: cfg.encryption?.algorithm ?? 'aes-256-gcm', fingerprint: cryptoEngine?.getKeyFingerprint() ?? null };
      }
      if (!cryptoEngine) throw new ToolError('加密功能未启用（encryption.enabled=false）');
      if (args.action === 'rotate-key') return cryptoEngine.rotateKey(String(args.filePath), String(args.newMasterKey));
      if (args.action === 'decrypt-file') {
        const { data } = cryptoEngine.readEncrypted(String(args.filePath));
        return { decrypted: true, preview: JSON.stringify(data).slice(0, 200) };
      }
      if (args.action === 'encrypt-existing') {
        const target = String(args.filePath ?? memoryPath);
        if (!fs.existsSync(target)) throw new ToolError(`文件不存在: ${target}`);
        const raw = JSON.parse(fs.readFileSync(target, 'utf-8'));
        return cryptoEngine.writeEncrypted(target, raw);
      }
      throw new ToolError(`未知 action: ${args.action}`);
    },
  });

  // 8. memory_migration — 记忆迁移
  tools.register({
    name: 'memory_migration',
    description: '记忆迁移（导出 / 导入 / 冲突预演 / 跨租户迁移）',
    parameters: {
      action: { type: 'string', description: '迁移动作', required: true, enum: ['export', 'import', 'dry-run', 'migrate-tenant'] },
      filePath: { type: 'string', description: '导出/导入文件路径' },
      strategy: { type: 'string', description: '合并策略', enum: ['overwrite', 'merge', 'skip', 'newer-wins'] },
      sourceTenantId: { type: 'string', description: 'migrate-tenant 源租户' },
      targetTenantId: { type: 'string', description: 'migrate-tenant 目标租户' },
    },
    handler: (args) => {
      switch (args.action) {
        case 'export': {
          const out = String(args.filePath ?? path.join(dataDir, `migration-${Date.now()}.json`));
          migrationTool.exportToFile(memory, out);
          return { exportedTo: out };
        }
        case 'import':
          return migrationTool.importFromFile(memory, String(args.filePath), (args.strategy as any) ?? 'merge');
        case 'dry-run': {
          const pkg = migrationTool.exportFromFile(String(args.filePath));
          return migrationTool.dryRun(memory, pkg);
        }
        case 'migrate-tenant': {
          const source = tenantManager.getTenant(String(args.sourceTenantId));
          const target = tenantManager.getTenant(String(args.targetTenantId));
          if (!source || !target) throw new ToolError('源或目标租户不存在');
          return migrationTool.migrateBetweenTenants(source.memory, target.memory);
        }
        default:
          throw new ToolError(`未知 action: ${args.action}`);
      }
    },
  });

  // 9. manage_sync — 管理分布式同步
  tools.register({
    name: 'manage_sync',
    description: '分布式记忆同步管理（状态 / 立即同步 / 注册节点）',
    parameters: {
      action: { type: 'string', description: '同步动作', required: true, enum: ['status', 'sync-now', 'register-node'] },
      peerId: { type: 'string', description: 'sync-now 目标节点' },
      node: { type: 'object', description: 'register-node 节点配置' },
    },
    handler: async (args) => {
      if (args.action === 'status') return sync.getStatus();
      if (args.action === 'sync-now') return sync.syncNow(String(args.peerId));
      if (args.action === 'register-node') {
        sync.registerNode(args.node as SyncNodeConfig);
        return { registered: (args.node as SyncNodeConfig)?.nodeId };
      }
      throw new ToolError(`未知 action: ${args.action}`);
    },
  });

  // 10. manage_consensus — 管理分布式共识
  tools.register({
    name: 'manage_consensus',
    description: 'Raft 共识管理（集群状态 / 提交提案）',
    parameters: {
      action: { type: 'string', description: '共识动作', required: true, enum: ['status', 'propose'] },
      command: { type: 'object', description: 'propose 的提案命令' },
    },
    handler: async (args) => {
      if (!raft) return { enabled: false, message: '共识功能未启用（consensus.enabled=false）' };
      if (args.action === 'status') return raft.getClusterStatus();
      if (args.action === 'propose') return raft.propose(args.command as ConsensusLogEntry['command']);
      throw new ToolError(`未知 action: ${args.action}`);
    },
  });

  // 11. run_benchmark — 性能基准测试
  tools.register({
    name: 'run_benchmark',
    description: '性能基准测试（全量运行 / 场景列表 / 报告列表 / 对比 / 生成报告）',
    parameters: {
      action: { type: 'string', description: '基准动作', required: true, enum: ['run-all', 'list-scenarios', 'list-reports', 'compare', 'generate-report'] },
      beforeId: { type: 'string', description: 'compare 的基准报告 id' },
      afterId: { type: 'string', description: 'compare 的对比报告 id' },
      reportId: { type: 'string', description: 'generate-report 的报告 id' },
    },
    handler: async (args) => {
      switch (args.action) {
        case 'run-all':
          return benchmark.runAll();
        case 'list-scenarios':
          return { scenarios: benchmark.listScenarios() };
        case 'list-reports':
          return { reports: benchmark.loadReports().map((r) => ({ id: r.id, timestamp: r.timestamp, overallPassed: r.overallPassed })) };
        case 'compare':
          return { comparison: benchmark.compareReports(String(args.beforeId), String(args.afterId)) };
        case 'generate-report': {
          const report = benchmark.loadReports().find((r) => r.id === args.reportId);
          if (!report) throw new ToolError(`报告不存在: ${args.reportId}`);
          return { markdown: benchmark.generateMarkdownReport(report) };
        }
        default:
          throw new ToolError(`未知 action: ${args.action}`);
      }
    },
  });

  // 12. manage_hot_reload — 管理热更新
  tools.register({
    name: 'manage_hot_reload',
    description: '插件热更新管理（状态 / 回滚 / 部署版本 / 启停监听）',
    parameters: {
      action: { type: 'string', description: '热更新动作', required: true, enum: ['status', 'rollback', 'deploy-version', 'stop-watching', 'start-watching'] },
      versionId: { type: 'string', description: 'deploy-version 的目标版本' },
    },
    handler: async (args) => {
      if (!hotReload) return { enabled: false, message: '热更新未启用（hotReload.enabled=false）' };
      switch (args.action) {
        case 'status':
          return hotReload.getStatus();
        case 'rollback':
          await hotReload.rollback();
          return { rolledBack: true };
        case 'deploy-version':
          await hotReload.manualDeploy(String(args.versionId));
          return { deployed: args.versionId };
        case 'stop-watching':
          hotReload.stopWatching();
          return { watching: false };
        case 'start-watching':
          hotReload.startWatching();
          return { watching: true };
        default:
          throw new ToolError(`未知 action: ${args.action}`);
      }
    },
  });

  // 13. manage_autonomy — 管理自主智能
  tools.register({
    name: 'manage_autonomy',
    description: '自主智能管理（心跳循环启停 / 手动心跳 / 注入洞察 / 目标管理 / 强制进化）',
    parameters: {
      action: { type: 'string', description: '自主动作', required: true, enum: ['status', 'start', 'stop', 'tick', 'inject-insight', 'list-goals', 'abandon-goal', 'evolve-now', 'kill-switch', 'revive', 'reset-circuit', 'introspect'] },
      insight: { type: 'object', description: 'inject-insight 的洞察对象（source/category/severity/message/suggestion/taskType）' },
      goalId: { type: 'string', description: 'abandon-goal 的目标 id' },
      engage: { type: 'boolean', description: 'kill-switch 的启停（true=启用紧急停止，false=解除）' },
    },
    handler: async (args) => {
      switch (args.action) {
        case 'status':
          return { status: autonomyLoop.getStatus(), health: metaCognition.getHealthReport(), goals: goalEngine.getSummary() };
        case 'start':
          autonomyLoop.start();
          return { running: true };
        case 'stop':
          autonomyLoop.stop();
          return { running: false };
        case 'tick':
          return { report: await autonomyLoop.tick() };
        case 'inject-insight': {
          const insight = args.insight as any;
          if (!insight?.message || !insight?.suggestion) throw new ToolError('insight 需包含 message 与 suggestion');
          const goals = goalEngine.generateGoalsFromInsights([{
            source: insight.source ?? 'user',
            category: insight.category ?? 'user-request',
            severity: typeof insight.severity === 'number' ? insight.severity : 0.6,
            message: String(insight.message),
            suggestion: String(insight.suggestion),
            taskType: insight.taskType,
          }]);
          for (const goal of goals) await goalEngine.decompose(goal.id);
          return { goalsCreated: goals.map((g) => ({ id: g.id, title: g.title, valueScore: g.valueScore })) };
        }
        case 'list-goals':
          return { goals: goalEngine.getAllGoals() };
        case 'abandon-goal': {
          const goal = goalEngine.getGoal(String(args.goalId));
          if (!goal) throw new ToolError(`目标不存在: ${args.goalId}`);
          goal.status = 'abandoned';
          return { abandoned: args.goalId };
        }
        case 'evolve-now': {
          const report = strategyEvolution.evolve(true);
          if (report) decisionEngine.updateConfig(strategyEvolution.bestGenesAsConfig());
          return { report, bestGenes: strategyEvolution.bestGenome().genes };
        }
        case 'kill-switch': {
          if (args.engage) {
            governor.engageKillSwitch();
            autonomyLoop.stop();
            broadcast({ type: 'kill-switch-engaged' });
            logger.warn('紧急停止开关已启用，自主行为已冻结');
            return { engaged: true };
          }
          governor.disengageKillSwitch();
          broadcast({ type: 'kill-switch-disengaged' });
          return { engaged: false };
        }
        case 'revive':
          governor.disengageKillSwitch();
          governor.resetCircuit();
          if (autonomyEnabled) autonomyLoop.start();
          return { revived: true };
        case 'reset-circuit':
          governor.resetCircuit();
          return { circuitState: governor.getCircuitState() };
        case 'introspect': {
          // 21.0/22.0：已挂载数学内核的诊断快照（未挂载/未裁决的键不出现，
          // 保持返回对象简洁）
          const kernelDiagnostics = modelScheduler.getAttachedDiagnostics();
          // 创世纪观测口径（未挂载/未产出时键缺席——缺席即零介入的证明）
          const hawkes = sentinel.hawkesView();
          const backpressure = taskExecutor.backpressureView();
          const speculative = modelScheduler.getSpeculativeVerdict();
          const pricing = symbiosisBridge?.dynamicPricingView();
          return {
            introspection: autonomyLoop.introspect(),
            // ── 第三轮 A17 升级（纯增量字段）：内核旗标总览 + 链路审计摘要 + 工具调用计数 ──
            kernelFlags: kernelFlagOverview(cfg.autonomy?.kernels),
            // ── 第四轮 R4-A17 增量字段：模块域升级旗标总览（与 kernelFlags 同款）──
            moduleFlags: moduleFlagOverview(cfg.autonomy?.modules),
            // ── 第四轮 R4-A17 增量字段：主链路深化读数（任一深化旗标开启时在场；全关时键缺席——零漂移）──
            ...(pipelineCacheOn || pipelineLadderOn || pipelinePrefetchOn
              ? {
                  pipelineDeepening: {
                    crossStepCache: pipelineCacheOn ? pipelineStepCache.stats() : undefined,
                    degradationLadder: pipelineLadderOn ? { degradations: pipelineLadderDegradations } : undefined,
                    stepPrefetch: pipelinePrefetchOn ? stepPrefetcher.stats() : undefined,
                  },
                }
              : {}),
            pipelineAudit: pipelineAudit.summary(),
            toolCalls: tools.stats(),
            ...(kernelDiagnostics.indexScheduling ? { indexScheduling: kernelDiagnostics.indexScheduling } : {}),
            ...(kernelDiagnostics.lastBwK ? { banditKnapsack: kernelDiagnostics.lastBwK } : {}),
            // 24.0/25.0：隐私预算账本快照与最近容量规划产物（未启用/未产出时不出现）
            ...(privacyAccountant ? { privacy: privacyAccountant.status() } : {}),
            ...(lastCapacityPlan ? { capacity: lastCapacityPlan } : {}),
            // 28.0：最近尾部风险评估产物（未启用/未产出时不出现）
            ...(lastTailRisk ? { tailRisk: { modelId: lastTailRisk.modelId, p99: Math.round(lastTailRisk.p99), p999: Math.round(lastTailRisk.p999), xi: Number(lastTailRisk.gpd.xi.toFixed(3)), sigma: Math.round(lastTailRisk.gpd.sigma), exceedances: lastTailRisk.exceedances, samples: lastTailRisk.samples, p999Ci: lastTailRisk.p999Ci ? { lower: Math.round(lastTailRisk.p999Ci.lower), upper: Math.round(lastTailRisk.p999Ci.upper) } : undefined } } : {}),
            // 55.0：Hawkes 爆发读数（激发份额 / 风暴判定 / 当前强度）
            ...(hawkes ? { hawkesBurst: { excitationShare: Number(hawkes.excitationShare.toFixed(3)), burst: hawkes.burst, rateAtNow: Number(hawkes.forecast.rateAtNow.toFixed(3)), expectedNextMin: Number(hawkes.forecast.expected.toFixed(2)), events: hawkes.events } } : {}),
            // 54.0：背压稳定性告警（对偶价格超阈时的瓶颈洞察）
            ...(backpressure?.insight ? { backpressure: backpressure.insight } : {}),
            // 51.0：最近一次投机配对裁决
            ...(speculative ? { speculativeDecoding: { pair: speculative.verdict.pair, adopt: speculative.verdict.adopt, optimalK: speculative.verdict.optimalK, speedup: Number(speculative.verdict.speedup.toFixed(3)) } } : {}),
            // 65.0：共生费率学习读数（影子口径）
            ...(pricing ? { dynamicPricing: pricing } : {}),
          };
        }
        default:
          throw new ToolError(`未知 action: ${args.action}`);
      }
    },
  });

  // 14. manage_keys — 密钥管理（查看健康状态 / 调整密钥顺序）
  tools.register({
    name: 'manage_keys',
    description: '密钥管理：查看各密钥来源健康状态，或调整多密钥的使用顺序（持久化，重启保留）',
    parameters: {
      action: { type: 'string', description: '密钥动作', required: true, enum: ['list', 'set-order', 'clear-order'] },
      order: { type: 'array', description: 'set-order 的密钥来源顺序（如 ["local-config", "env:DASHSCOPE_API_KEY"]，靠前优先）' },
    },
    handler: (args) => {
      switch (args.action) {
        case 'list':
          return {
            health: keyHealth.status(),
            userOrder: keyHealth.getKeyOrder(),
            sources: Object.fromEntries(mergedModels.map((m) => [m.id, describeKeySources(m.id)])),
          };
        case 'set-order': {
          if (!Array.isArray(args.order) || args.order.length === 0) {
            throw new ToolError('set-order 需要非空的 order 数组（密钥来源标识列表）');
          }
          keyHealth.setKeyOrder(args.order);
          return { userOrder: keyHealth.getKeyOrder() };
        }
        case 'clear-order':
          keyHealth.clearKeyOrder();
          return { userOrder: [], restored: '默认顺序（环境变量序 → 本地配置）' };
        default:
          throw new ToolError(`未知 action: ${args.action}`);
      }
    },
  });

  // 15. sheaf_consensus — 层论共识（20.0：多源信念结构化融合，缺省关闭）
  if (cfg.autonomy?.sheafConsensus?.enabled === true) {
    tools.register({
      name: 'sheaf_consensus',
      description:
        '层论共识：把多源信念（模型估计 / 市场价 / 直接观测）按「谁与谁、在哪些声明上应该一致」的结构调和为全局共识——'
        + '平均化会编造共识（0.9 与 0.1 平均成 0.5，无人真的这么认为），本工具在结构性分歧时明确说「无解」并指出最大翻供者',
      parameters: {
        vertices: {
          type: 'array',
          description: '顶点声明：[{id, dim}]（dim = 该源的信念向量维度，标量源 dim=1）',
          required: true,
        },
        edges: {
          type: 'array',
          description:
            '一致性约束边：[{a, b, sharedA?, sharedB?}]——a/b 为顶点 id；'
            + 'sharedA/sharedB 为两侧参与共享的坐标下标表（长度相等；省略 = 同序全维度等值约束）',
        },
        observations: {
          type: 'array',
          description: '观测锚点：[{id, values, weight?}]（values 长度 = 顶点 dim；weight = 置信权重，缺省 1）',
          required: true,
        },
      },
      handler: (args) => {
        const vertices = Array.isArray(args.vertices) ? args.vertices : [];
        const edges = Array.isArray(args.edges) ? args.edges : [];
        const observations = Array.isArray(args.observations) ? args.observations : [];
        if (vertices.length === 0 || observations.length === 0) {
          throw new ToolError('sheaf_consensus 需要 vertices 与 observations（至少各 1 项）');
        }
        const sheaf = new CellularSheaf();
        for (const v of vertices) {
          if (typeof v?.id !== 'string' || typeof v?.dim !== 'number') throw new ToolError('顶点格式：{id: string, dim: number}');
          sheaf.addVertex(v.id, v.dim);
        }
        for (const e of edges) {
          if (typeof e?.a !== 'string' || typeof e?.b !== 'string') throw new ToolError('边格式：{a, b, sharedA?, sharedB?}');
          try {
            sheaf.addEdge({
              a: e.a,
              b: e.b,
              sharedA: Array.isArray(e.sharedA) ? e.sharedA.map(Number) : undefined,
              sharedB: Array.isArray(e.sharedB) ? e.sharedB.map(Number) : undefined,
            });
          } catch (err) {
            throw new ToolError(`边 ${e.a}↔${e.b} 无效: ${(err as Error).message}`);
          }
        }
        const anchors = observations
          .filter((o: { id?: unknown; values?: unknown }) => typeof o?.id === 'string' && Array.isArray(o.values))
          .map((o: { id: string; values: unknown[]; weight?: unknown }) => ({
            id: o.id,
            values: o.values.map(Number),
            weight: typeof o.weight === 'number' ? o.weight : 1,
          }));
        return sheaf.harmonize(anchors, { misfitTolerance: cfg.autonomy?.sheafConsensus?.misfitTolerance });
      },
    });
  }

  // ─────────────────────────── 官方 Tool 注册链路桥接 ───────────────────────────
  // 宿主加载了 @deepseek-ai/dsh-tools（ctx.tools 服务）时，把内部 14 个 Tool
  // 同步注册进官方 ToolRegistry，纳入 pre/around/post 执行管线与模型可见面；
  // duck-typing 探测（ctx.get 免 inject 读取，未提供时返回 undefined），
  // 不引入 dsh-tools 依赖（避免整套 agent 栈），
  // 宿主未提供时静默降级为仅内部 ToolRegistry + ctx.provide('schedulerTools')。
  const hostToolRegistry = (ctx as any).get?.('tools');
  const hostToolDisposers: Array<() => void> = [];
  if (hostToolRegistry && typeof hostToolRegistry.register === 'function') {
    for (const tool of tools.list()) {
      const internal = tools.get(tool.name)!;
      try {
        const dispose = hostToolRegistry.register({
          name: tool.name,
          description: tool.description,
          parameters: toJsonSchemaParameters(tool.parameters),
          output: {
            // 无约束 JSON 输出（注解型 schema 为官方子集的标准形式），渲染为文本块
            schema: {},
            render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          },
          execute: async (args: unknown) => internal.handler({ ...(args as Record<string, unknown>) }),
        });
        if (typeof dispose === 'function') hostToolDisposers.push(dispose);
      } catch (err) {
        // 单个 Tool 桥接失败不阻断启动（内部注册表仍可经 schedulerTools 使用）
        logger.warn('官方 Tool 注册跳过 %s: %s', tool.name, (err as Error).message);
      }
    }
    if (hostToolDisposers.length > 0) logger.info('已桥接 %d 个 Tool 到 DSH 官方注册表（ctx.tools）', hostToolDisposers.length);
  }

  // ─────────────────────────── 宿主融合层（质的飞跃） ───────────────────────────
  // 全宿主可观测（tools/result）+ 全宿主安全治理（tools/pre-execute）。
  // 宿主无 ctx.tools 时 activate() 静默返回 false，降级为纯内部模式。
  const selfToolNames = new Set(tools.list().map((t) => t.name));
  const hostFusion = new HostFusionLayer(cfg.hostFusion, {
    ctx,
    sentinel,
    worldModel,
    governor,
    broadcast,
    logger,
    selfToolNames,
    onLessonExtracted: (toolName, consecutiveFailures, lastError) => {
      reflectionEngine.addLesson({
        taskType: `host-tool:${toolName}`,
        rootCause: 'transient',
        lesson: `宿主工具 ${toolName} 连续失败 ${consecutiveFailures} 次：${lastError.slice(0, 200)}`,
        suggestion: '检查该工具的依赖/参数，或暂时规避调用',
        signalDescription: `宿主工具 ${toolName} 连续失败升级`,
      });
    },
  });
  hostFusion.activate();

  // ── 服务暴露 ──
  const service: SchedulerService = {
    tools,
    sentinel,
    modelScheduler,
    taskExecutor,
    memory,
    llm,
    tenantManager,
    sync,
    raft,
    hotReload,
    broadcaster,
    benchmark,
    cryptoEngine,
    decisionEngine,
    reflectionEngine,
    optimizer,
    reflector,
    goalEngine,
    metaCognition,
    strategyEvolution,
    // 第四阶段：元认知层（自我建模 + 元认知控制）
    selfModel,
    metaController,
    autonomyLoop,
    worldModel,
    curiosity,
    governor,
    hostFusion,
    // 第三轮 A17：10 步链路结构化审计轨迹（export()/summary() 离线可审计）
    pipelineAudit,
    submitTask: (task, urgency = 0.8) => sentinel.ingest({ type: 'manual-task', description: task, payload: { task }, source: 'manual', urgency }),
  };
  ctx.provide('scheduler', service);
  ctx.provide('schedulerTools', tools);

  // ─────────────────────────── cleanup（fiber 卸载时逆序清理） ───────────────────────────
  // 第三轮 A17：资源登记造册 + 清理审计。disposeSequence 按既有清理顺序枚举全部
  // dispose 句柄（interval / fiber / listener / watcher / server / persist），逆序注册
  // 进 ResourceRegistry——disposeAll() 的逆序释放遂与升级前的清理序逐位一致；
  // 释放逐条 try/catch 记账，漏释放（登记未销账且无句柄）在审计报告中显式告警。
  const disposeSequence: Array<{ kind: string; label: string; dispose: () => void }> = [
    { kind: 'service', label: 'host-fusion', dispose: () => hostFusion.dispose() },
    ...hostToolDisposers.map((dispose, i) => ({ kind: 'listener', label: `host-tool#${i}`, dispose: () => dispose() })),
    { kind: 'fiber', label: 'autonomy-loop', dispose: () => autonomyLoop.stop() },
    ...(hotReload ? [{ kind: 'watcher', label: 'hot-reload', dispose: () => hotReload.stop() }] : []),
    ...(raft ? [{ kind: 'server', label: 'raft', dispose: () => raft.stop() }] : []),
    { kind: 'service', label: 'distributed-sync', dispose: () => sync.stop() },
    { kind: 'watcher', label: 'sentinel', dispose: () => sentinel.stop() },
    { kind: 'service', label: 'tenant-manager', dispose: () => tenantManager.dispose() },
    ...(broadcaster ? [{ kind: 'server', label: 'progress-broadcaster', dispose: () => broadcaster.stop() }] : []),
    { kind: 'client', label: 'llm-client', dispose: () => llm.dispose() },
    { kind: 'persist', label: 'memory-graph', dispose: () => memoryGraph.save() },
    { kind: 'persist', label: 'long-term-memory', dispose: () => memory.dispose() },
  ];
  for (let i = disposeSequence.length - 1; i >= 0; i -= 1) {
    const entry = disposeSequence[i]!;
    resources.register(entry.kind, entry.dispose, entry.label);
  }
  ctx.effect(() => {
    return () => {
      logger.info('调度器卸载中，清理资源…');
      const report = resources.disposeAll();
      logger.info('调度器资源已清理');
      logger.info(
        '资源清理审计: 登记 %d / 释放 %d / 漏释放 %d / 出错 %d%s',
        report.registered,
        report.released,
        report.leaked,
        report.errored,
        report.leaked > 0 ? `——漏释放: ${report.entries.filter((e) => e.status === 'leaked').map((e) => `${e.kind}:${e.label}`).join(', ')}` : '',
      );
    };
  }, 'scheduler-cleanup');
}

/**
 * 插件导出（cordis 函数插件形态 + 静态元数据）
 * - name：注册表显示名（Function.name 只读，须用 defineProperty）
 * - Config：Schemastery 标准 schema，加载时由 cordis resolveConfig 校验并填充默认值
 * - provide：向宿主声明本插件提供的服务（供加载器诊断，不改变运行时行为）
 */
const pluginEntry = apply as typeof apply & {
  name: string;
  Config: typeof Config;
  provide: string[];
};
Object.defineProperty(pluginEntry, 'name', { value: name });
pluginEntry.Config = Config;
pluginEntry.provide = ['scheduler', 'schedulerTools'];
export default pluginEntry;

// ─────────────────────────── 子模块再导出（集成层统一入口） ───────────────────────────
export * from './errors.js';
export * from './security/crypto-engine.js';
// 3.0 统一证据内核：显式具名再导出（wilsonLowerBound / 衰减与先验常量已随
// long-term-memory.js 的兼容再导出进入根入口，此处不重复以防 star 导出歧义）
export {
  decayFactor,
  evidenceRankScore,
  initEvidence,
  observeEvidence,
  readEvidence,
  EVIDENCE_MIN_SAMPLES,
  EVIDENCE_RANK_BLEND,
  LEGACY_EVIDENCE_DISCOUNT,
  // 第五轮 R5-A19 导出面收口：evidence 新增 API（wilson 上界 / logBeta /
  // 贝叶斯因子阈值与计算 / 多源证据合成）补入显式名单
  wilsonUpperBound,
  logBeta,
  BAYES_FACTOR_THRESHOLDS,
  bayesFactor,
  synthesizeEvidence,
} from './core/evidence.js';
export type { MemoryEvidence, EvidenceView } from './core/evidence.js';
// ── 5.0 因果内核：因果边贝叶斯更新 + do-干预登记 + Shapley 反事实分红 ──
export * from './core/causal-kernel.js';
// ── 6.0 主动推断内核：期望自由能 EFE + 变分漂移 + 精度控制 ──
export * from './core/free-energy.js';
export * from './core/deliberation.js';
export * from './core/metareasoning.js';
export * from './core/abstraction.js';
// ── 10.0 科学家内核：最优实验设计（EIG + 混杂加成 + 预算仲裁 + 信息台账）──
export * from './core/scientist.js';
// ── 11.0 理论内核：从数据到定律（层级归纳 + MDL 压缩 + 零样本 + 范式转移）──
export * from './core/theorist.js';
// ── 12.0 任意时刻证据内核：置信序列 + e-过程 + e-BH（结论永不夸大）──
export * from './core/anytime-evidence.js';
// ── 13.0 保形校准内核：分裂保形区间 + 覆盖漂移 e-监测 + 风险受控阈值 ──
export * from './core/conformal.js';
// ── 14.0 质量-多样性内核：MAP-Elites 行为归档（多样性坍缩结构性阻断）──
export * from './core/quality-diversity.js';
// ── 15.0 运行时验证内核：LTLf 安全规约监视器（证明携带裁决）──
export * from './core/runtime-verification.js';
// ── 16.0 Shapley 归因内核：公理化公平分配 + 任意时刻有效置信区间 ──
export * from './core/shapley.js';
// ── 17.0 最优传输内核：Wasserstein 漂移 + Sinkhorn + 重心（分布形状可见）──
export * from './core/optimal-transport.js';
// ── 18.0 信息几何内核：Fisher 度量自然变异 + KL 信任域（步长以 nat 计价）──
export * from './core/information-geometry.js';
// ── 19.0 最优停止内核：先知不等式 + 向后归纳 + 机会停止器（等待有数学价格）──
export * from './core/optimal-stopping.js';
// ── 20.0 层论共识内核：胞腔层拉普拉斯 + 调和共识 + 结构性障碍检测 ──
export * from './core/sheaf-consensus.js';
// ── 21.0 最优索引调度内核：Gittins 指数精确计算（退休 MDP 三角形反向归纳）──
export * from './core/index-scheduling.js';
// ── 22.0 预算最优路由内核：Bandits with Knapsacks（影子价格从预算稀缺性内生涌现）──
export * from './core/bandit-knapsack.js';
// ── 23.0 稳健统计内核：Catoni + Median-of-Means（重尾延迟的 sub-Gaussian 估计）──
export * from './core/robust-statistics.js';
// ── 24.0 差分隐私内核：Laplace/Gaussian 机制 + Rényi-DP 记账（遥测不裸暴露个体）──
export * from './core/differential-privacy.js';
// ── 25.0 容量规划内核：Erlang-C/Kingman 反解最小并发 + Little 定律自检 ──
export * from './core/capacity-planning.js';
// ── 26.0 高斯过程内核：RBF/Matérn 贝叶斯回归 + 期望改进贝叶斯优化 ──
export * from './core/gaussian-process.js';
// ── 27.0 卡尔曼滤波内核：线性高斯滤波 + RTS 平滑 + NIS 门控 ──
export * from './core/kalman-filter.js';
// ── 28.0 极值理论内核：POT/GPD 尾部建模 + Hill 估计 + 风险度量 ──
export * from './core/extreme-value.js';
// ── 29.0 蒙特卡洛树搜索内核：UCT + 折扣回报 + 任意时刻可读 ──
export * from './core/mcts.js';
// ── 30.0 次模优化内核：加权覆盖 + 惰性贪心 CELF + 曲率修正保证 ──
export * from './core/submodular.js';
// ── 31.0 在线学习内核：Fixed-Share Hedge 对抗无悔 ──
export * from './core/online-learning.js';
// ── 32.0 全局指派内核：匈牙利算法 + 对偶最优性证书 ──
export * from './core/optimal-assignment.js';
// ── 33.0 随机矩阵内核：Marchenko–Pastur 清洗 + 系统性风险监视 ──
export * from './core/random-matrix.js';
// ── 34.0 分布鲁棒内核：CVaR + Wasserstein 球最坏化 ──
export * from './core/robust-decisions.js';
// ── 35.0 反馈控制内核：DARE 闭式 + Lyapunov 稳定证书 ──
export * from './core/feedback-control.js';
// ── 36.0 持续同调内核：H₀ 持续图 + 瓶颈距离（知识的形状） ──
export * from './core/persistent-homology.js';
// ── 37.0 信息瓶颈内核：Blahut-Arimoto（蒸馏的信息论定价） ──
export * from './core/information-bottleneck.js';
// ── 38.0 非线性动力学内核：Lyapunov + Hurst（体质分类） ──
export * from './core/nonlinear-dynamics.js';
// ── 39.0 谱排序内核：PageRank 幂迭代（知识图影响力） ──
export * from './core/spectral-ranking.js';
// ── 40.0 首达时间内核：反射原理 + 逆高斯（恢复的概率定价） ──
export * from './core/first-passage.js';
// ── 41.0 排队网络内核：Jackson 乘积形式 + 瓶颈站 ──
export * from './core/queueing-network.js';
// ── 42.0 谱周期内核：FFT 周期图 + Fisher g 检验 ──
export * from './core/spectral-periodicity.js';
// ── 43.0 最大流内核：Edmonds-Karp + 最小割证书 ──
export * from './core/max-flow.js';
// ── 44.0 公平分配内核：极大极小注水 + 加权口径 ──
export * from './core/fair-division.js';
// ── 45.0 预算分配内核：OCBA 最优计算预算 ──
export * from './core/budget-allocation.js';
// ── 46.0 法定人数内核：quorum 交叉 + 拜占庭可行性 ──
export * from './core/quorum-systems.js';
// ── 47.0 无冲突复制内核：CRDT 三定律收敛 ──
export * from './core/crdt.js';
// ── 48.0 秘密共享内核：Shamir 阈值 + 随机性审计 ──
export * from './core/secret-sharing.js';
// ── 49.0 多尺度内核：Haar 小波分解 ──
export * from './core/multiscale-wavelet.js';
// ── 50.0 矩阵补全内核：ALS 低秩潜因子 ──
export * from './core/matrix-completion.js';
// ════════════════ 创世纪升级 51.0→75.0：五大新层 25 个内核 ════════════════
// 全部经根入口 re-export（含类型）；缺省关闭旗标见 SchedulerConfig.autonomy.kernels，
// 挂载点见各引擎 attachXxx 方法与 src/engines-frontier/genesis25.ts 适配层。
// 导出消歧：多个内核自带同构 RNG 工具 mulberry32（与 28.0 extreme-value 的
// 导出冲突，ES 星导出歧义按既有先例显式消解——各内核内部实现不受影响，
// 根入口的规范 mulberry32 以 extreme-value 版为准）；stable-matching 与
// nucleolus 各有一个语义不同的 inCore（房屋市场核 / 合作博弈核），显式别名保留两者。
// ── 51.0 投机解码内核：draft-verify 期望收益闭式（N(k,γ) + 最优深度 k*）──
export * from './core/speculative-decoding.js';
// ── 52.0 测试时计算内核：多数票可达性 + 幂律曲线 + 注水配给 + 早停 ──
export * from './core/test-time-compute.js';
// ── 53.0 Whittle 指数内核：不休眠两态臂补贴法 + 可索引性定理 ──
export * from './core/whittle-index.js';
// ── 54.0 Lyapunov 漂移加罚内核：[O(1/V), O(V)] 背压调度 + LP 对偶基准 ──
export * from './core/lyapunov-drift.js';
// ── 55.0 Hawkes 自激发内核：EM 拟合 + 残差诊断 + 爆发闭式外推 ──
export * from './core/hawkes-process.js';
// ── 56.0 置信传播内核：因子图 sum-product / max-product（含圈阻尼）──
export * from './core/belief-propagation.js';
// ── 57.0 变分推断内核：平均场 CAVI / 非共轭 Armijo（显式列表：mulberry32 与 28.0 冲突）──
export {
  conjugateLinearRegressionPosterior,
  VI_KIND,
  DEFAULT_VI_CONFIG,
  VariationalEngine,
  logisticRegressionLogJoint,
} from './core/variational-inference.js';
export type {
  ConjugatePosterior,
  ViKind,
  LinearRegressionSpec,
  GaussianVISpec,
  VIProblem,
  VIConfig,
  VIFitOptions,
  VIFitResult,
  LogisticModel,
} from './core/variational-inference.js';
// ── 58.0 朗之万采样内核：ULA/MALA + 步长自标定 + W2(Bures)（显式列表：mulberry32 冲突）──
export {
  MALA_OPTIMAL_ACCEPT,
  empiricalMeanCov,
  ula,
  mala,
  tuneStep,
  gaussianTarget,
  doubleWellTarget,
  w2Gaussian,
  // R5-A19 导出面收口：蛙跳提案 / OU 动量刷新尺度 / 欠阻尼 MALA
  leapfrogProposal,
  ouRefreshScale,
  underdampedMala,
} from './core/langevin-sampling.js';
export type {
  LangevinTarget,
  UlaOptions,
  UlaResult,
  MalaOptions,
  MalaResult,
  TuneStepOptions,
  TuneStepResult,
  GaussianTargetOptions,
  GaussianTarget,
  W2Report,
} from './core/langevin-sampling.js';
// ── 59.0 课程学习内核：掌握门限状态机 + Thompson 课程 + 多策略对照 ──
export * from './core/curriculum-learning.js';
// ── 60.0 率失真内核：Blahut-Arimoto + 记忆三档压缩规划（影子价格 λ*）──
export * from './core/rate-distortion.js';
// ── 61.0 稳定匹配内核：延迟接受 + 格极值 + TTC（显式列表：inCore/mulberry32 冲突）──
export {
  deferredAcceptance,
  latticeExtremes,
  isStable,
  allStableMatchings,
  topTradingCycles,
  inCore as inCoreHousing,
  randomMatchingProblem,
  randomHousingMarket,
  // R5-A19 导出面收口：容量约束 DA / 队列化 DA / 多对一稳定性 / 医院-居民市场
  capacityDeferredAcceptance,
  deferredAcceptanceQueued,
  isStableManyToOne,
  randomHospitalResidentsProblem,
  ruralHospitalCheck,
} from './core/stable-matching.js';
export type {
  StableMatchingProblem,
  DeferredAcceptanceResult,
  StabilityCheck,
  LatticeExtremes,
  AllStableMatchingsResult,
  HousingMarketProblem,
  TopTradingCyclesResult,
  CoreCheck,
  CoreCheckOptions,
} from './core/stable-matching.js';
// ── 62.0 机制设计内核：铁化虚拟价值 + Myerson 最优拍卖 + VCG（显式列表：mulberry32 冲突）──
export {
  makeDistributionGrid,
  uniformUnitGrid,
  empiricalGrid,
  virtualValue,
  virtualValueCurve,
  ironVirtualValues,
  myersonReserve,
  myersonAuction,
  secondPrice,
  vcgAllocate,
  // R5-A19 导出面收口：组合拍卖 VCG
  combinatorialVcg,
} from './core/mechanism-design.js';
export type {
  DistributionGrid,
  IronPool,
  IronedVirtualCurve,
  VcgAuctionInput,
  VcgOutcome,
  MyersonOutcome,
} from './core/mechanism-design.js';
// ── 63.0 核仁内核：精确分数算术 LP + 逐级最小化最大抱怨（显式列表：inCore 冲突）──
export {
  Fraction,
  frac,
  solveLP,
  MAX_EXACT_PLAYERS,
  makeGame,
  makeGameFromPairs,
  coalitionMask,
  coalitionMembers,
  excess,
  excessVector,
  isImputation,
  inCore as inCoreGame,
  leastCore,
  core,
  nucleolus,
  shapleyExact,
  // R5-A19 导出面收口：批量等价加速核仁 / 对称类归并
  nucleolusFast,
  symmetryClasses,
} from './core/nucleolus.js';
export type {
  ConstraintSense,
  LPProblem,
  LPSolution,
  CoalitionValue,
  CooperativeGame,
  CoalitionExcess,
  LeastCoreResult,
  CoreStatus,
  NucleolusRound,
  NucleolusResult,
} from './core/nucleolus.js';
// ── 64.0 相关均衡内核：无悔动态学习 CE + 偏离审计 + Nash 枚举（显式列表：mulberry32 冲突）──
export {
  MAX_JOINT_ACTIONS,
  normalGame,
  jointIndexOf,
  profileOfJoint,
  payoffOf,
  counterfactualPayoffs,
  positiveRegretDistribution,
  regretMatchingStep,
  isCorrelatedEquilibrium,
  expectedPayoffsUnder,
  learnCE,
  enumerateNash,
  // R5-A19 导出面收口：CCE 检验 / 均衡间隙 / 向量化无悔 CE 学习
  isCoarseCorrelatedEquilibrium,
  equilibriumGaps,
  learnCEFast,
} from './core/correlated-equilibrium.js';
export type {
  NormalGame,
  RegretMatchingStep,
  CEDeviation,
  CECheck,
  LearnCEResult,
  NashEquilibrium,
} from './core/correlated-equilibrium.js';
// ── 65.0 动态定价内核：UCB/Thompson 无悔定价 + 遗憾曲线 ──
export * from './core/dynamic-pricing.js';
// ── 66.0 模拟退火内核：Metropolis + 退火日程 + 势阱深度（TSP 测试台）──
export * from './core/simulated-annealing.js';
// ── 67.0 NSGA-II 内核：非支配排序 + 拥挤距离 + 2D 超体积 ──
export * from './core/nsga2-pareto.js';
// ── 68.0 压缩距离内核：LZW/NCD + 层次聚类 + 三角不等式审计（显式列表：mulberry32 冲突）──
export {
  LZW_SELF_DISTANCE_ASYMPTOTE,
  pseudoRandomString,
  lzwCompress,
  compressedBits,
  ncd,
  ncdMatrix,
  ncdCluster,
  ncdTriangleAudit,
  // R5-A19 导出面收口：LZ77 压缩 / NCD LZ77 口径 / 矩阵缓存统计与重置
  lz77Compress,
  ncdLz77,
  ncdCacheStats,
  resetNcdCache,
} from './core/compression-distance.js';
export type {
  LzwResult,
  NcdClusterOptions,
  NcdClusterMerge,
  NcdClusterResult,
  NcdTriangleAudit,
} from './core/compression-distance.js';
// ── 69.0 Mapper 图内核：区间覆盖 × 单链聚类 × 圈基（经验地形骨架）──
export * from './core/mapper-graph.js';
// ── 70.0 部分信息分解内核：BROJA PID + O 信息（协同/冗余/独占可计算）──
export * from './core/partial-info-decomposition.js';
// ── 71.0 A* 搜索内核：可采纳启发最优搜索 + 一致性自证（网格世界测试台）──
export * from './core/astar-search.js';
// ── 72.0 稀疏恢复内核：Lasso 坐标下降 + KKT 证书 + OMP + CV 选 λ ──
export * from './core/sparse-recovery.js';
// ── 73.0 最佳臂识别内核：逐次减半 / 置信淘汰 / H 复杂度 ──
export * from './core/best-arm-identification.js';
// ── 74.0 镜像下降内核：Bregman 几何无悔更新 + 三点恒等式审计 ──
export * from './core/mirror-descent.js';
// ── 75.0 在线校准内核：门控 Platt/Isotonic + 漂移哨兵 ──
export * from './core/online-calibration.js';
// ── 创世纪接线适配层（引擎数据 → 内核输入的纯翻译；挂载点见各引擎 attachXxx）──
export * from './engines-frontier/genesis25.js';

// ════════════════ 第二轮创世纪升级 76.0→100.0：五大新层 25 个内核 ════════════════
// 全部经根入口 re-export（含类型）；缺省关闭旗标见 SchedulerConfig.autonomy.kernels，
// 挂载点见各引擎 attachXxx 方法与 src/engines-frontier/autonomy25.ts 适配层。
// 导出消歧（第一轮先例同款）：8 个新内核自带同构 RNG 工具 mulberry32——根入口
// 规范 mulberry32 仍以 28.0 extreme-value 版为准；gaussianNoise 以 differential-privacy
// 版为准（76.0/86.0/87.0 的同名实现数学同构）；normalCdf 以 gaussian-process 版为准
// （76.0/97.0 同构）；chiSquareQuantile 以 28.0 版为准；isStable 以 61.0 stable-matching
// 版为准（81.0 的论证语义同名实现显式列表排除——语义不同不得混淆）；SimulateOptions
// 以 59.0 curriculum-learning 版为准（90.0/87.0 各自别名保留语义）；ViolationReport
// 以 15.0 runtime-verification 版为准（87.0 别名 BarrierViolationReport）；CalibrationReport
// 以 75.0 online-calibration 版为准（94.0 别名 SimCalibrationReport）；Episode/DiscretePolicy
// 以 88.0 off-policy-evaluation 版为准（83.0 别名 MdlEpisode、89.0 别名 SpiEpisode/
// SpiDiscretePolicy——三个内核的 Episode 字段语义不同，别名全部保留）。
// ── 76.0 新奇检测内核：自适应参考窗双证据（Mahalanobis 门控 + kNN 计数比）+ CUSUM 变点（显式列表：与既有导出同名冲突按先例消歧，见上方消歧注释） ──
export {
  normalQuantile,
  chiSquareUpperTail,
  ledoitWolfIntensity,
  mahalanobisDepth,
  knnNovelty,
  noveltyAUC,
  CUSUMDetector,
  cusumARLSiegmund,
  cusumARLMarkov,
  calibrateThreshold,
  DEFAULT_ADAPTIVE_WINDOW_CONFIG,
  AdaptiveReferenceWindow,
  // R5-A19 导出面收口：LOF 新奇评分 / 半空间深度
  localOutlierFactor,
  lofAUC,
  halfspaceDepth1D,
} from './core/novelty-detection.js';
// ── 77.0 因果发现内核：PC 算法 CPDAG 等价类 + 偏相关/互信息检验（显式列表：与既有导出同名冲突按先例消歧，见上方消歧注释） ──
export {
  EDGE_STATE,
  partialCorrelationTest,
  mutualInformationTest,
  pcAlgorithm,
  cpdagFromDag,
  edgesOfMixed,
  vStructuresOf,
  cpdagSummary,
  randomDag,
  dagFromEdges,
  sampleLinearSem,
  structuralHammingDistance,
  // R5-A19 导出面收口：GES 贪婪等价搜索（lite）
  gesLite,
} from './core/causal-discovery.js';
// ── 78.0 典型相关内核：CCA/岭正则 CCA + Jacobi 特征归约 ──
export * from './core/canonical-correlation.js';
// ── 79.0 扩散映射内核：流形嵌入 + 扩散距离 + 谱隙簇数（显式列表：与既有导出同名冲突按先例消歧，见上方消歧注释） ──
export {
  gaussianSampler,
  pairwiseDistances,
  knnGraph,
  diffusionMaps,
  diffusionDistance,
  floydWarshall,
  isomap,
  swissRoll,
  twoMoons,
  nearestCentroidClassify,
  // R5-A19 导出面收口：地标扩散嵌入 / 尺度扫描
  landmarkDiffusion,
  diffusionScaleSweep,
} from './core/diffusion-maps.js';
// ── 80.0 流式概要内核：CMS/指数直方图/蓄水池/Misra–Gries 四结构 ──
export * from './core/streaming-sketch.js';
// ── 81.0 论证内核：Dung 抽象论证框架 + grounded/preferred/stable 语义（显式列表：与既有导出同名冲突按先例消歧，见上方消歧注释） ──
export {
  MAX_ENUM_ARGUMENTS,
  argumentFramework,
  randomFramework,
  isConflictFree,
  defends,
  isAdmissible,
  isComplete,
  isAcceptable,
  groundedExtension,
  completeExtensions,
  preferredExtensions,
  stableExtensions,
  bruteForceSemantics,
  EXTENSION_SEMANTICS,
  acceptance,
  formatArgumentSet,
  // R5-A19 导出面收口：价值论证框架（VAF）听众语义与攻击检验
  valueFramework,
  inducedFramework,
  allAudiences,
  attackSucceeds,
  valueAcceptance,
  randomValueFramework,
  VAF_MAX_VALUES,
} from './core/argumentation.js';
// ── 82.0 众包聚合内核：Dawid–Skene EM + 信任票权加权多数票 ──
export * from './core/crowd-aggregation.js';
// ── 83.0 世界模型学习内核：转移/奖励自学 + 值迭代 + 后继特征换目标（显式列表：与既有导出同名冲突按先例消歧，见上方消歧注释） ──
export {
  makeChain,
  makeGridworld,
  sampleTransition,
  randomPolicy,
  greedyPolicyFn,
  epsGreedyPolicyFn,
  collectEpisodes,
  learnModel,
  valueIteration,
  bellmanResidual,
  policyValue,
  greedyActions,
  greedyPolicyMatrix,
  successorFeatures,
  retarget,
  qLearning,
  dynaQ,
  // R5-A19 导出面收口：优先级扫描 / 随机表格 MDP 生成器
  prioritizedSweeping,
  randomTabularMDP,
} from './core/world-model-learning.js';
// ── 84.0 POMDP 规划内核：α-向量值迭代 + 信念更新 + QMDP 上界 ──
export * from './core/pomdp-planning.js';
// ── 85.0 符号求解内核：DPLL SAT + 模型计数 + DIMACS lite ──
export * from './core/symbolic-solver.js';
// ── 86.0 分层技能内核：option/SMDP Q 学习 + 时间信用分配 γ^k（显式列表：与既有导出同名冲突按先例消歧，见上方消歧注释） ──
export {
  ACTIONS,
  fourRoomsGridworld,
  corridorGridworld,
  primitiveOptions,
  hallwayOptions,
  smdpQLearning,
  flatQLearning,
  intraOptionQLearning,
  solveSmdpExact,
  optionBellmanResidual,
  smokeTestPolicy,
  // R5-A19 导出面收口：瓶颈态发现 / 图论中心性 / 选项自动生成
  bottleneckStates,
  articulationPoints,
  stateBetweenness,
  optionsFromBottlenecks,
  optionTables,
} from './core/options-framework.js';
// ── 87.0 安全屏障内核：离散控制屏障函数 cbfFilter 最小安全修改（显式列表：与既有导出同名冲突按先例消歧，见上方消歧注释） ──
export {
  BARRIER_VIOLATION_TOL,
  cbfFilter,
  brakeDoubleIntegrator,
  simulateClosedLoop,
  violationReport,
  // R5-A19 导出面收口：多屏障合取安全滤波
  cbfFilterConjunction,
} from './core/safety-barrier.js';
// ── 88.0 离线评估内核：OIS/WIS/PDIS/DR 反事实估值 + EB 置信区间 ──
export * from './core/off-policy-evaluation.js';
// ── 89.0 安全策略改进内核：HCPI 高置信证书 + 集中率曲线（显式列表：与既有导出同名冲突按先例消歧，见上方消歧注释） ──
export {
  pdisEpisodeValue,
  ebRadius,
  safePolicyImprove,
  concentrationCurve,
  rejectionRate,
  // R5-A19 导出面收口：多重校正（Bonferroni δ）/ 多策略安全改进
  bonferroniDelta,
  MULTI_CORRECTION,
  safePolicyImproveMulti,
} from './core/safe-policy-improvement.js';
// ── 90.0 偏好学习内核：Bradley–Terry MLE + 拟合优度体检 + Elo（显式列表：与既有导出同名冲突按先例消歧，见上方消歧注释） ──
export {
  BT_FIT_DEFAULTS,
  ELO_DEFAULTS,
  GOF_DEFAULTS,
  logistic,
  stdNormalCdf,
  chiSquarePValue,
  ELO_SCALE,
  utilityToEloScale,
  eloScaleToUtility,
  expectedScore,
  predictPair,
  thurstoneProbability,
  btLogLoss,
  bradleyTerryMLE,
  eloUpdate,
  eloSequence,
  transitivityCheck,
  btGoodnessOfFit,
  simulatePreferences,
  heldOutAccuracy,
  rankByUtility,
  // R5-A19 导出面收口：Plackett–Luce 排名模型（概率 / 对数似然 / MLE / 仿真）
  plackettLuceProbability,
  plackettLuceChoiceProbability,
  plackettLuceLogProb,
  plackettLuceMLE,
  simulateRankings,
} from './core/preference-learning.js';
// ── 91.0 新奇搜索内核：行为空间 kNN 新奇定向 + MCNS 门槛 ──
export * from './core/novelty-search.js';
// ── 92.0 自我对弈内核：可剥削度 + 虚拟对弈 + 联赛 exploiter 训练（显式列表：与既有导出同名冲突按先例消歧，见上方消歧注释） ──
export {
  matrixGame,
  transposeMatrix,
  rockPaperScissors,
  kuhnDealPayoff,
  kuhnPokerMini,
  expectedRowValues,
  expectedValue,
  valueOf,
  bestResponse,
  bestResponseColumn,
  exploitability,
  fictitiousPlay,
  leaguePlay,
  // R5-A19 导出面收口：最优反应弱点剖析 / 演化稳定性排名
  bestResponseWeakness,
  evolutionaryStabilityRank,
} from './core/self-play.js';
// ── 93.0 AutoML Hyperband 内核：无限早停预算分配 + 学习曲线 ──
export * from './core/automl-hyperband.js';
// ── 94.0 仿真校准内核：MMD²/能量距离域差 + 密度比再加权（显式列表：与既有导出同名冲突按先例消歧，见上方消歧注释） ──
export {
  mmd2,
  medianHeuristicGamma,
  energyDistance,
  densityRatioClassifier,
  reweightedStatistic,
  weightedMmd2,
  calibrateSim,
  makeDomainGap,
  // R5-A19 导出面收口：重要性权重截断 / 加权自助法
  truncateWeights,
  weightedBootstrap,
} from './core/simulation-calibration.js';
// ── 95.0 中断交接内核：闭式接管阈值 τ* + 可中断 Q 学习修正 ──
export * from './core/interruptible-autonomy.js';
// ── 96.0 全局工作空间内核：投标竞争 + 点火广播 + 不应期防垄断 ──
export * from './core/global-workspace.js';
// ── 97.0 元认知信心内核：meta-d′ 效率 M-ratio + 闭式求助阈值（显式列表：与既有导出同名冲突按先例消歧，见上方消歧注释） ──
export {
  probit,
  typeOneDprime,
  metaDprime,
  confidenceAccuracyCurve,
  optimalAskThreshold,
  posteriorErrorProbability,
  shouldAsk,
  simulateMetacognition,
  // R5-A19 导出面收口：meta-d′ 最大似然拟合 / 贝叶斯最优求助报告
  metaDprimeFit,
  bayesOptimalReport,
} from './core/metacognitive-confidence.js';
// ── 98.0 经验重放内核：分层优先重放 + IS 加权睡眠固化 ──
export * from './core/experience-replay.js';
// ── 99.0 注意力经济内核：凹价值曲线贪心出清（= 穷举最优）+ VCG 支付（显式列表：与既有导出同名冲突按先例消歧，见上方消歧注释） ──
export {
  unitDemandSource,
  geometricSource,
  saturatingSource,
  concavityCheck,
  allocateAttention,
  greedyVsOptimal,
  misreportGain,
  // R5-A19 导出面收口：注意力衰减经济（衰减源 / 退出年龄 / 衰减与快速分配）
  decayedSource,
  decayExitAge,
  allocateAttentionDecayed,
  allocateAttentionFast,
} from './core/attention-economy.js';
// ── 100.0 自我边界内核：能动性归因（shuffle 对照互信息）+ 身份连续性（显式列表：与既有导出同名冲突按先例消歧，见上方消歧注释） ──
export {
  contingencyScore,
  detectAgency,
  doVsObserve,
  identityContinuity,
  simulateEnv,
  // R5-A19 导出面收口：增量列联表 / 多步归因 / 他者心智模型与仿真
  IncrementalContingency,
  multiStepAttribution,
  otherAgentModel,
  simulateOtherAgent,
  simulateChain,
} from './core/self-boundary.js';
// ── 第二轮创世纪接线适配层（引擎数据 → 内核输入的纯翻译；挂载点见各引擎 attachXxx）──
export * from './engines-frontier/autonomy25.js';
// 4.0 弹性内核：熔断器 / 指数退避 / 错误分型（可靠执行共享组件）
export {
  CircuitBreaker,
  CircuitBreakerRegistry,
  backoffDelayMs,
  abortableSleep,
  classifyError,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_BACKOFF_CONFIG,
  // R5-A19 导出面收口：Weibull 寿命模型 / 可用性闭环 / 冗余与维修增益 / 韧性预算
  weibullLogSurvival,
  weibullSurvival,
  weibullHazard,
  weibullMean,
  weibullVariance,
  weibullCoefficientOfVariation,
  weibullDiagnostics,
  steadyStateAvailability,
  logDomainAvailability,
  systemAvailability,
  redundancyGainLog,
  repairSpeedGainLog,
  resilienceBudget,
} from './core/resilience.js';
export type { BreakerState, BreakerProbe, BreakerStatus, CircuitBreakerConfig, BackoffConfig, RetryClass, ErrorClassification } from './core/resilience.js';
export * from './memory/long-term-memory.js';
export * from './memory/backend.js';
export * from './memory/memory-graph.js';
export * from './memory/alias-map.js';
export * from './contracts.js';
// 第三阶段：策略进化（策略表示/共享评分函数 + 安全沙盒 + 策略进化器）
export * from './policy/policy-types.js';
export * from './policy/sandbox.js';
export * from './policy/policy-evolver.js';
// 第四阶段：元认知层
export * from './meta/meta-types.js';
export * from './meta/self-model.js';
export * from './meta/meta-controller.js';
export * from './memory/migration-tool.js';
export * from './progress-ws.js';
export * from './tenant/tenant-manager.js';
export * from './benchmark/benchmark-engine.js';
export * from './sync/distributed-sync.js';
export * from './consensus/raft-engine.js';
export * from './hot-reload/hot-reload-engine.js';
export * from './llm-client.js';
export * from './sentinel.js';
export * from './types.js';
export * from './model-scheduler.js';
export * from './task-executor.js';
export * from './optimizer.js';
export * from './reflector.js';
export * from './decision-engine.js';
export * from './reflection-engine.js';
export * from './goal-engine.js';
export * from './meta-cognition.js';
export * from './strategy-evolution.js';
export * from './autonomy-loop.js';
export * from './world-model.js';
export * from './curiosity-engine.js';
export * from './safety-governor.js';
// ── 共生进化架构（第五阶段 Phase 1：智能体 + 能量预算 + 知识交易）──
export * from './symbiosis/ledger.js';
export * from './symbiosis/agent.js';
export * from './symbiosis/market.js';
export * from './symbiosis/runtime.js';
// ── Phase 2：市场即心智（信念市场 LMSR + futarchy 决策资助 + 元认知对账）──
export * from './symbiosis/belief.js';
// 消歧：deliberation 与 belief 均导出 SettlementReport（export * 静默
// 排除同名成员），显式导出主名 + 别名保留两者语义
export type { SettlementReport, SettlementReport as DeliberationSettlementReport } from './core/deliberation.js';
export type { SettlementReport as BeliefSettlementReport } from './symbiosis/belief.js';
export * from './symbiosis/wrappers.js';
// ── Phase 2.5：共生融合桥（KPI → 能量经济/信念市场 → 漂移洞察回流宿主自愈链路）──
export * from './symbiosis/bridge.js';
// ── C 路线：生态可观测性（能量 Sankey 数据模型 + 自包含 HTML 渲染）──
export * from './symbiosis/observability.js';
export { attachDashboard } from './dashboard/index.js';
// ── A18 遥测审计总线（第三轮新模块 src/telemetry/）：结构化事件总线 /
//    指标注册表 / 追加式审计账 / 嵌套栈跟踪（注入时钟、纯内存、零 I/O）──
export * from './telemetry/event-bus.js';
export * from './telemetry/metrics.js';
export * from './telemetry/audit-log.js';
export * from './telemetry/trace.js';
// 消歧：progress-ws 的 SeqGap（客户端缺口 {from,to}）与 event-bus 的
// SeqGap（总线缓冲缺口 {fromSeq,toSeq,count}）同名；meta-types 的
// AuditEntry（元认知审计轨迹）与 audit-log 的 AuditEntry（遥测审计账
// 条目 + 哈希链字段）同名（export * 静默排除同名成员），显式导出主名
// （既有根入口语义不变）+ 别名保留两者语义（SettlementReport 先例同款）
export type { SeqGap } from './progress-ws.js';
export type { SeqGap as TelemetrySeqGap } from './telemetry/event-bus.js';
export type { AuditEntry } from './meta/meta-types.js';
export type { AuditEntry as TelemetryAuditEntry } from './telemetry/audit-log.js';
