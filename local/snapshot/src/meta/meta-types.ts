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
 * - 3.0 升级新增（全部可选字段/联合扩展，旧持久化历史向后兼容）：
 *   死区稳定环（StabilityLoopConfig）/ 调整证书门（CertificateGateConfig，
 *   89.0 视图 LCB>0 才放行）/ 自我模型变更日志（SelfModelChange）/
 *   自我评估校准（SelfCalibrationSummary）/ 内外环冲突仲裁审计
 * - 4.0 升级新增（全部可选字段/联合扩展，缺省零漂移）：
 *   自我效能预测（SelfEfficacySummary，按任务类型 Beta 后验 + 校准追踪）/
 *   认知负荷计量（CognitiveLoadConfig，超阈值暂停新调整防归因混淆）/
 *   调整幅度元学习（AmplitudeMetaLearnConfig，大调整连续翻车→幅度先验收紧）
 */

// ─────────────────────────── 系统指标快照 ───────────────────────────

/** 操作环指标（源自决策反馈与全局统计） */
export interface OperationalMetrics {
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
export interface MemoryMetrics {
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
export interface EvolverMetrics {
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
export interface SystemMetrics {
  collectedAt: number;
  operational: OperationalMetrics;
  memory: MemoryMetrics;
  evolver: EvolverMetrics;
}

// ─────────────────────────── 心智报告 ───────────────────────────

/** 策略表现摘要（当前策略的优势与盲点） */
export interface StrategyPerformanceSummary {
  currentPolicyId: string;
  currentPolicyVersion: number;
  currentPolicyGeneration: number;
  currentPolicyOrigin: string;
  /** 操作环整体表现（最近决策反馈窗口） */
  operational: { successRate: number; avgQuality: number; sampleCount: number };
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
  strengths: Array<{ taskType: string; successRate: number; samples: number }>;
  /** 盲点：成功率最低的任务类型 */
  blindSpots: Array<{ taskType: string; successRate: number; samples: number }>;
  /** 最近一次进化周期的沙盒收益（无评估历史为空） */
  sandboxFitness?: { reward: number; gain: number; gainLCB?: number };
}

/** 记忆体系质量摘要（哪类记忆在增加、哪类在退化） */
export interface MemoryQualitySummary {
  counts: MemoryMetrics['counts'];
  /** 与上一份心智报告对比的增量（首份报告为全 0） */
  growth: { episodic: number; semantic: number; procedural: number; strategies: number };
  /** 蒸馏水位（越高 = 情景积压越多，蒸馏越滞后） */
  distillation: { pendingSinceLastDistillation: number };
  /** 各层趋势评估：growing 增长 / stable 平稳 / degrading 退化（遗忘主导） */
  layers: Array<{ layer: string; trend: 'growing' | 'stable' | 'degrading'; detail: string }>;
  totalExecutions: number;
  averageQualityScore: number;
}

/** 进化器效率摘要（发现速度与存活率） */
export interface EvolverEfficiencySummary {
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
export interface SystemStabilitySummary {
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
export interface ImprovementEvidence {
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
export interface RecommendedAdjustment {
  /** 调节旋钮 id（如 'evolver.mutationRate'） */
  knob: string;
  label: string;
  direction: 'up' | 'down';
  reason: string;
  /** 0~1，越高越优先 */
  priority: number;
}

/** 心智报告（第四阶段验收核心结构） */
export interface MentalReport {
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
  // ── 2.0 质级升级扩展（可选字段：旧持久化历史向后兼容） ──
  /** 关键指标趋势外推（≥ minForecastHistory 份历史报告后产出） */
  forecasts?: MetricForecast[];
  /** 前瞻性风险：预测越限 → 建议在指标仍健康时提前调整 */
  proactiveRisks?: ProactiveRisk[];
  /** 旋钮调整有效性（Bandit 学习器快照；需编排层注入元认知状态采集器） */
  knobEffectiveness?: KnobEffectiveness[];
  /** 元认知层自察：熔断器 / 安全包络 / 学习器 / 稳态带（系统对自身调整机制的认知） */
  metaStability?: MetaStabilitySummary;
  /**
   * 3.0：自我评估校准（自评 vs 实际表现的滚动偏差追踪）。
   *
   * 有 recordSelfAssessment 样本后输出：自评过高（overconfident）的
   * 系统会把「感觉良好」当成「表现良好」，自评过低（underconfident）
   * 的系统会过度求助/过度保守——校准视图给出偏差 EMA、校正口径与
   * 告警态。无样本时字段缺省（旧持久化历史向后兼容）。
   */
  selfCalibration?: SelfCalibrationSummary;
  /**
   * 4.0：自我效能预测（按任务类型的成功率预测 + 预测-实际校准追踪）。
   *
   * 有 recordSelfEfficacy 样本后输出：各任务类型的 Beta 后验预测
   * （历史 α/β + 事后实测）、预测 vs 实际的偏差 EMA（预测过高 = 把
   * 「预计能成」当「真能成」）与 Brier 分数 EMA（预测质量的概率校准
   * 口径）。无样本时字段缺省（旧持久化历史向后兼容）。
   */
  selfEfficacy?: SelfEfficacySummary;
}

// ─────────────────────────── 元认知控制 ───────────────────────────

/** 调整效果判定指标（旋钮与指标的显式关联） */
export type JudgeMetric =
  | 'operationalSuccessRate' // 操作环成功率
  | 'discoveryRate' // 进化发现速率
  | 'proceduralGrowth' // 程序记忆累积量
  | 'pendingDistillation' // 蒸馏积压水位（越低越好）
  | 'survivalRate'; // 新策略存活率

/** 审计日志条目（所有自动/手动调整全量留痕） */
export interface AuditEntry {
  id: string;
  timestamp: number;
  type:
    | 'adjust'
    | 'commit'
    | 'rollback'
    | 'manual-override'
    | 'freeze'
    | 'skip'
    | 'circuit-breaker'
    | 'certificate-reject'
    | 'conflict-arbitration'
    | 'load-gate';
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
  /** 调整来源（reactive 规则反应式 / proactive 预测前瞻式 / homeostatic 稳定环） */
  source?: 'reactive' | 'proactive' | 'homeostatic';
  /** 关联的心智报告序号 */
  reportIndex?: number;
  /**
   * 3.0：调整证书（89.0 视图裁决）。
   *
   * mode = full：89.0 视图可用且 LCB > 0，证书放行全幅调整；
   * mode = provisional：视图样本不足（不可用），退化为保守半步调整 +
   *   严格判定观察窗（无明确改善即自动回滚）；
   * mode = rejected：视图可用但 LCB ≤ 0（历史效果的高置信下界非正，
   * 「假改进」嫌疑），本候选被拒绝。
   */
  certificate?: {
    mode: 'full' | 'provisional' | 'rejected';
    /** 89.0 口径的置信下界（视图可用时填写） */
    lcb?: number;
    /** 视图配对样本数 */
    samples: number;
    /** 所用置信参数 δ */
    delta?: number;
  };
  /**
   * 4.0：调整幅度元学习记录（启用 amplitudeMetaLearn 后的 adjust 条目填写）。
   *
   * band = 该次调整的幅度类（按 |Δ|/step 分档）；factor = 幅度先验因子
   * （历史同类成功率 → 贝叶斯平滑 / 目标成功率，<1 收缩、>1 放宽）；
   * trials = 判定入账时该幅度类的历史试验数。
   */
  amplitude?: {
    band: 'tentative' | 'standard' | 'aggressive';
    factor: number;
    trials: number;
  };
}

/** 调整报告（evaluateAndAdjust 产物） */
export interface AdjustmentReport {
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
    source?: 'reactive' | 'proactive' | 'homeostatic';
    /** 3.0：调整证书（89.0 视图裁决：full 全幅放行 / provisional 保守半步） */
    certificate?: { mode: 'full' | 'provisional'; lcb?: number; samples: number };
    /** 4.0：幅度元学习（幅度类 / 先验因子 / 历史试验数） */
    amplitude?: { band: 'tentative' | 'standard' | 'aggressive'; factor: number; trials: number };
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
  committed?: { knob: string; effect: NonNullable<AuditEntry['effect']> };
  /** 观察窗进度 */
  observation?: { knob: string; reportsSeen: number; reportsNeeded: number };
  /** no-op / frozen 时的原因说明 */
  skippedReason?: string;
  /** 本轮依据的心智报告（人类审查入口） */
  mentalReport: MentalReport;
}

/** 回滚结果（rollbackLastAdjustment 产物） */
export interface RollbackResult {
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
export interface MetaControllerState {
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
  // ── 3.0：稳定环 / 证书门 / 冲突仲裁（未启用稳定环时 undefined） ──
  /** 3.0：死区稳定环统计（死区跳过 / 方向翻转 / 冷却跳过 / 斜坡衰减调整） */
  stability?: {
    deadbandSkips: number;
    cooldownSkips: number;
    directionFlips: number;
    rampedAdjustments: number;
    /** 各旋钮当前同向连续调整计数（斜坡位置） */
    streaks: Array<{ knob: string; direction: 'up' | 'down'; count: number }>;
  };
  /** 3.0：调整证书门面板（各「旋钮×方向」臂最近一次 89.0 视图裁决） */
  certificateGate?: {
    decisions: Array<{
      knob: string;
      direction: 'up' | 'down';
      mode: 'full' | 'provisional' | 'rejected';
      lcb?: number;
      samples: number;
    }>;
    rejected: number;
    provisional: number;
    full: number;
  };
  /** 3.0：内外环冲突仲裁（同参数被多方调整：最后写入者胜 + 冲突计数） */
  arbitration?: {
    conflicts: number;
    arbitrated: number;
    lastConflict?: { knob: string; winner: string; at: number };
  };
  // ── 4.0：认知负荷门 / 调整幅度元学习（未启用时 undefined） ──
  /**
   * 4.0：认知负荷面板（在调旋钮数 / 在观实验数 / 在跟踪 KPI 数 → 合成
   * 负荷分 vs 上限；超限被拦截的次数）。未启用 cognitiveLoad 时 undefined。
   */
  cognitiveLoad?: {
    activeAdjustments: number;
    activeExperiments: number;
    trackedKpis: number;
    load: number;
    threshold: number;
    paused: boolean;
    gateSkips: number;
  };
  /**
   * 4.0：调整幅度元学习面板（各幅度类的历史成功率与当前幅度先验因子）。
   * 未启用 amplitudeMetaLearn 时 undefined。
   */
  amplitudeLearning?: {
    bands: Array<{
      band: 'tentative' | 'standard' | 'aggressive';
      trials: number;
      commits: number;
      successRate: number;
      /** 当前幅度先验因子（<1 收缩 / 1 中性 / >1 放宽；零试验 = 1） */
      factor: number;
    }>;
  };
}

// ─────────────────── 2.0 质级升级：预测 / 学习 / 安全 / 稳态 ───────────────────

/** 趋势预测覆盖的指标（判定指标 + 综合稳定分） */
export type TrendMetric = JudgeMetric | 'stabilityScore';

/** 单指标趋势外推（报告历史最小二乘拟合） */
export interface MetricForecast {
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
export interface ProactiveRisk {
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
export interface KnobEffectiveness {
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
export interface CircuitBreakerInfo {
  knob: string;
  /** 连续自动回滚次数（判定保留后清零） */
  consecutiveRollbacks: number;
  /** 是否已熔断 */
  tripped: boolean;
  trippedAt?: number;
  reason?: string;
}

/** 经验安全包络（从 commit/rollback 历史学习的旋钮安全区间） */
export interface SafeEnvelopeInfo {
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
export type HomeostasisBands = Partial<Record<JudgeMetric, { min: number; max: number }>>;

/** 单指标稳态状态 */
export interface HomeostasisStatus {
  metric: TrendMetric;
  band: { min: number; max: number };
  current: number;
  /** 归一化偏离（带内为 0；带外按带宽归一，可 >1） */
  deviation: number;
  state: 'in-band' | 'near-edge' | 'out-of-band';
}

/** 元认知层自察（系统对自身调整机制的认知） */
export interface MetaStabilitySummary {
  /** 熔断器面板 */
  circuitBreakers: CircuitBreakerInfo[];
  /** 手动全局冻结 */
  globalFrozen: boolean;
  /** 全局熔断（连续回滚自动触发） */
  frozenByBreaker: boolean;
  /** 各旋钮安全包络 */
  safeEnvelopes: SafeEnvelopeInfo[];
  /** 学习器概况 */
  learner: { totalTrials: number; arms: number; explorationWeight: number };
  /** 稳态目标带状态 */
  homeostasis: HomeostasisStatus[];
}

// ─────────────────── 3.0 世界性升级：稳定环 / 证书门 / 变更日志 / 校准 ───────────────────

/**
 * 3.0：调参死区稳定环配置（外环防震荡三件套：死区 + 斜坡 + 冷却）。
 *
 * 朴素比例外环在噪声下会极限环震荡：指标贴着目标带边缘抖动，控制器
 * 每次都全力纠正，反而把旋钮推离均衡点。三件套对应三种阻尼：
 * 1. 死区（deadbandDeviation）：归一化偏离 ≤ 死区半宽 → 判为测量噪声，
 *    不产生调整（带内不动是稳态而非失职）；
 * 2. 斜坡（rampStart / rampIncrement）：新方向的首次调整只走 rampStart
 *    比例步长，同向连续调整逐步升幅（封顶全幅）；方向翻转即重置——
 *    持续误差才配得上大动作，瞬时越界只配小步试探；
 * 3. 冷却（cooldownReports）：commit/rollback 判定后强制冷却若干份报告，
 *    不允许背靠背调整（给被调系统留出暂态消退时间）。
 *
 * 未配置（undefined）= 完全保持 2.0 行为（零漂移）。
 */
export interface StabilityLoopConfig {
  /** 死区半宽（归一化偏离单位；缺省 0.25 = 偏离带宽 25% 以内不动） */
  deadbandDeviation?: number;
  /** 斜坡起点步长因子（新方向首次调整 ×rampStart；缺省 0.5 = 半步） */
  rampStart?: number;
  /** 同向连续调整的步长因子增量（线性升幅封顶 1；缺省 0.25） */
  rampIncrement?: number;
  /** 判定（commit/rollback）后的冷却报告数（缺省 1） */
  cooldownReports?: number;
  /**
   * 稳定环候选方向表：旋钮 id → 该旋钮增大对其判定指标的影响方向
   * （'positive' = 增大旋钮使指标上升）。提供后控制器可直接从稳态带
   * 偏离生成 homeostatic 候选（不依赖心智报告的规则推荐）。
   */
  knobAffect?: Record<string, 'positive' | 'negative'>;
}

/**
 * 3.0：调整证书门配置（89.0 视图：LCB > 0 才放行全幅自我调整）。
 *
 * 自我修改（阈值/参数变更）是单向门：改坏了要靠回滚兜底，不如改前
 * 就要证书。证书原料 = 学习臂记录的历史调整效果配对样本
 * （每次判定的 effectDelta），裁决 = 89.0 安全策略改进的经验伯恩斯坦
 * 单侧下界（ebRadius 同式）：mean(deltas) − radius(σ̂, b−a, n, δ) > 0
 * 才放行全幅调整。视图不可用（样本 < minSamples，如冷启动）时不装懂：
 * 退化为保守半步调整 + 严格判定观察窗（无明确改善即自动回滚）。
 *
 * 未配置（undefined）= 完全保持 2.0 行为（零漂移）。
 */
export interface CertificateGateConfig {
  /** 置信参数 δ ∈ (0,1)：P[错误放行假改进] ≤ δ（缺省 0.1） */
  delta?: number;
  /** 89.0 视图可用的最小配对样本数（不足 → provisional 半步；缺省 4） */
  minSamples?: number;
}

/**
 * 3.0：自我模型变更日志条目（一切自我修改入账：改动前后 + 理由 + 触发者）。
 *
 * 自我模型是「会改自己的模型」：配置（反馈窗口 / 异常阈值 / 稳态带…）
 * 会被外环或人工修改。变更日志让每次自我修改可追溯、可逆——rollback
 * 按日志逆向恢复（from 值写回），snapshot/restore 整体回滚。
 */
export interface SelfModelChange {
  id: string;
  timestamp: number;
  /** 变更目标（自我模型自身的配置键，如 'anomalyZThreshold'） */
  key: string;
  /** 改动前取值 */
  from: unknown;
  /** 改动后取值 */
  to: unknown;
  /** 理由（为什么改） */
  reason: string;
  /** 触发者（谁改的：meta-controller / manual / system …） */
  trigger: string;
  /** 已被 rollbackSelfChanges 逆转 */
  undone?: boolean;
}

/**
 * 3.0：自我评估校准摘要（自评 vs 实际表现的滚动偏差追踪）。
 *
 * 「能力自评」（claimed）与「实际表现」（actual）的配对流进入滚动
 * 追踪：偏差均值 + EMA 双口径，|biasEma| 超容忍带即告警——自评过高
 * （overconfident，感觉良好 ≠ 表现良好）或自评过低（underconfident，
 * 过度保守/求助）。calibrated 给出校正口径：把后续自评减去 biasEma
 * 即得校准后的诚实自评。
 */
export interface SelfCalibrationSummary {
  /** 已积累的配对样本数 */
  samples: number;
  /** 滚动窗口偏差均值（claimed − actual；正 = 自评偏高） */
  biasMean: number;
  /** 偏差 EMA（指数平滑，对趋势收敛快于窗口均值） */
  biasEma: number;
  /** 最新一次的校正后自评（claimed − biasEma） */
  calibrated: number | null;
  /** 校准状态：warming-up 样本不足 / calibrated 带内 / overconfident 偏高 / underconfident 偏低 */
  state: 'warming-up' | 'calibrated' | 'overconfident' | 'underconfident';
  /** 进入过高/过低告警态的翻转沿次数 */
  alarms: number;
  /** 最近一次告警方向 */
  lastAlarm?: 'overconfident' | 'underconfident';
}

// ─────────────────── 4.0 世界性升级：自我效能 / 认知负荷 / 幅度元学习 ───────────────────

/** 4.0：单任务类型的自我效能读数（Beta 后验 + 事后实测） */
export interface SelfEfficacyTypeView {
  taskType: string;
  /** 已结算的任务数 */
  trials: number;
  successes: number;
  /** Beta(α₀+s, β₀+f) 后验均值 = 预测成功率 */
  predicted: number;
  /** 后验 90% 可信区间（Beta 分位近似，Wilson 口径） */
  ci90: { lower: number; upper: number };
  /** 事后实测成功率（trials=0 为 null——预测先于经验，诚实分离） */
  empirical: number | null;
}

/**
 * 4.0：自我效能预测摘要（按任务类型的成功率预测 + 校准追踪）。
 *
 * 与 3.0 SelfCalibrationSummary 的分工：校准摘要追踪「自评 vs 实际」的
 * 滚动偏差（单一全局口径）；效能预测按**任务类型**维护 Beta 后验——
 * 三类任务历史各自分化（擅长/平庸/短板），预测携带区间而非点值，
 * 校准追踪（biasEma / brierEma）度量「预测本身」的概率质量。
 */
export interface SelfEfficacySummary {
  /** 各任务类型的 Beta 后验读数（按 trials 降序） */
  types: SelfEfficacyTypeView[];
  /** 预测-实际偏差 EMA（正 = 预测过高：把「预计能成」当「真能成」） */
  calibrationBiasEma: number;
  /** Brier 分数 EMA（预测质量：0=完美预测，0.25=瞎猜恒 0.5） */
  brierEma: number;
  /** 已结算的预测-结果对数 */
  samples: number;
  /** 校准状态：warming-up 预热 / calibrated 带内 / over-predicting 预测过高 / under-predicting 预测过低 */
  state: 'warming-up' | 'calibrated' | 'over-predicting' | 'under-predicting';
}

/**
 * 4.0：认知负荷计量配置（防「同时调太多不可归因」）。
 *
 * 调整中的旋钮、观察中的实验、跟踪中的 KPI 各占认知带宽；合成负荷分
 * 超过 maxLoad 时暂停**新**调整（观察窗判定照常推进——已投入的观察
 * 不作废），把并发调整压到可归因的水平。未配置（undefined）= 完全
 * 保持既有行为（零漂移）。
 */
export interface CognitiveLoadConfig {
  /**
   * 在调旋钮的计数窗（最近 N 份报告内的 adjust 条目计为「在调整」；
   * 缺省 4）——调整落地后系统需要连续几份报告消化其效果，期间的
   * 新调整都是归因混淆源。
   */
  flightWindowReports?: number;
  /** 在调旋钮权重（缺省 1） */
  adjustmentWeight?: number;
  /** 在观实验权重（缺省 1） */
  experimentWeight?: number;
  /** 在跟踪 KPI 单个权重（缺省 0.1） */
  kpiWeight?: number;
  /** 负荷上限（超过即暂停新调整；缺省 2） */
  maxLoad?: number;
}

/**
 * 4.0：调整幅度元学习配置（调参策略本身的学习）。
 *
 * 每个已判定的调整按幅度 |Δ|/step 归入幅度类（tentative ≤0.6 /
 * standard ≤1.0 / aggressive >1.0），逐类累计 commit/rollback——
 * 「大调整连续翻车」压低 aggressive 后验 → 后续同类调整的幅度先验
 * 收缩；「小调整连续成功」抬高 tentative 后验 → 幅度先验放宽。
 * 因子 = 贝叶斯平滑成功率 / target，零试验恒 1（零漂移）。
 */
export interface AmplitudeMetaLearnConfig {
  /** 目标成功率（因子 = 平滑成功率/target；缺省 0.6） */
  target?: number;
  /** 幅度先验因子下限（缺省 0.25） */
  minFactor?: number;
  /** 幅度先验因子上限（缺省 1.5） */
  maxFactor?: number;
  /** Beta 平滑先验权重（缺省 1，即 Beta(1,1)） */
  priorWeight?: number;
}
