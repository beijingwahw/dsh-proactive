/**
 * goal-engine.ts — 自主目标引擎（"彻底自主智能"核心组件 1/4）
 *
 * 职责：让系统从"被动响应信号"进化为"主动追求目标"。
 *
 * 能力矩阵：
 * 1. 目标自主生成：从反思教训 / 质量趋势 / 元认知诊断等洞察中，
 *    自动提炼可执行的改进目标（规则化 + 可选 LLM 增强），无需人工指派
 * 2. 目标分解：将目标拆解为带任务类型的子任务序列，
 *    每个子任务可直接注入哨兵作为信号执行（LLM 分解 + 规则兜底）
 * 3. 价值评估：impact × confidence / cost 三维打分，
 *    多目标竞争时按价值排序，资源永远流向最高价值目标
 * 4. 进度追踪：子任务与执行信号双向绑定，信号完成自动回写目标进度，
 *    全部子任务完成 → 目标达成；反复失败 → 自动放弃（止损）
 * 5. 目标生命周期：proposed → active → in-progress → completed / abandoned
 *
 * 第三轮世界性升级（缺省零漂移——新轴全部挂载/记账口径）：
 * 6. 目标 DAG：dependsOn 依赖边（声明期 DFS 拒环；前驱 completed 才派发）
 * 7. 目标预算：时间 / 尝试数双轴（超支判停滞——budget-time / budget-attempts）
 * 8. 陈旧检测：长期无进展 / 时限已过 / 依赖失效 → 自动降级（优先序乘
 *    停滞因子，有进展摘帽复权）；同前驱失效的停滞目标自动并入健康
 *    幸存同门（merge——未决子任务不陪葬）
 * 9. 价值排序升级：优先序 = 价值 × 成功率先验（Beta(α,α) 共轭后验）
 *    ——零证据先验恒 0.5，排序退化为原价值序（零漂移）；证据积累后
 *    高价值但反复失败的目标让位给稳步推进的目标
 *
 * 第四轮世界性升级（激活与深化，全部 opt-in、缺省零漂移）：
 * 10. 目标冲突检测：目标声明共享资源需求（resources）+ 挂载资源池后，
 *     同资源超预算的互斥目标对成对检出——哪两个目标争什么资源、
 *     缺口多少（pairwise shortfall + 池级总超载双口径）
 * 11. 长期目标里程碑：长期目标自动分解为里程碑链（时间锚点 + 完成判据
 *     = 进度阈值），sweepMilestoneDelays 延误预警（过期未达标即报，
 *     幂等；进度补齐自动转 met——延误后追赶也被记账）
 * 12. 自主动作风险分级声明：子任务可声明 riskTier（observe/act/mutate
 *     三级），由 autonomy-loop 的动作安全门消费（缺省不声明 → 门按
 *     taskType 映射/缺省级解析，行为不变）
 * 13. pickNextSubtask 支持排除集（安全门拒绝/时段窗口排队的子任务让位
 *     给后续可选者——不传参数行为逐位不变）
 *
 * 设计要点：
 * - 目标库随长期记忆持久化（serialize/deserialize），跨会话延续追求
 * - decomposer 可注入，冒烟测试可离线模拟
 */

import type { Lesson } from './reflection-engine.js';

/** 洞察来源（目标生成的输入） */
export interface Insight {
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
export interface GoalSubtask {
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
  /**
   * 第四轮升级：自主动作风险三级声明（缺省不声明 → 由安全门按 taskType
   * 映射 / 缺省级解析；声明仅是元数据，不改变目标引擎任何派发行为）
   */
  riskTier?: ActionRiskTier;
}

/**
 * 第四轮升级：自主动作风险三级（白名单分级门的安全口径）。
 * - observe：只读观察——恒放行
 * - act：低风险写——常规放行（可配冷却）
 * - mutate：高风险变更——需证书 / 确认 / 冷却 / 单拍上限（autonomy-loop 消费）
 */
export type ActionRiskTier = 'observe' | 'act' | 'mutate';

/** 目标状态（merged = 第三轮 DAG 升级：未决子任务已并入幸存目标——终态） */
export type GoalStatus = 'proposed' | 'active' | 'in-progress' | 'completed' | 'abandoned' | 'merged';

/** 目标级预算（第三轮 DAG 升级：时间 / 尝试数双轴，超支判停滞） */
export interface GoalBudget {
  /** 时间预算（毫秒，自目标首次派发起算；超时 → budget-time 停滞） */
  timeMs?: number;
  /** 尝试预算（目标级累计派发次数；超限 → budget-attempts 停滞） */
  maxAttempts?: number;
}

/** 停滞处置动作（sweepStalledGoals 的返回口径） */
export interface StallAction {
  goalId: string;
  /** demoted = 降级（优先序乘停滞因子）；merged = 并入幸存同门目标 */
  action: 'demoted' | 'merged';
  /** 停滞成因（budget-time / budget-attempts / no-progress / deadline-exceeded / dependency-invalid） */
  reasons: string[];
  /** merged 动作的吸收目标 id */
  mergedInto?: string;
}

/**
 * 第四轮升级：目标间资源冲突报告（哪两个目标争什么资源、缺口多少）。
 * 检出口径：同资源上两个活跃（未停滞）目标的需求之和超过池容量
 * ——该资源上这对目标互斥（同期无法同时满足）。
 */
export interface GoalResourceConflict {
  /** 冲突目标对（目标 id 升序——确定性） */
  goals: [string, string];
  /** 争夺的共享资源名 */
  resource: string;
  /** 前一目标的声明需求 */
  demandA: number;
  /** 后一目标的声明需求 */
  demandB: number;
  /** 双目标合计需求 */
  totalDemand: number;
  /** 池容量 */
  capacity: number;
  /** 缺口（totalDemand − capacity，> 0 即互斥） */
  shortfall: number;
}

/** 池级资源超载（全活跃目标合计超容量——比成对口径更宽的警报） */
export interface ResourceOverload {
  resource: string;
  /** 参与声明的活跃目标（id 升序） */
  goals: string[];
  totalDemand: number;
  capacity: number;
  shortfall: number;
}

/**
 * 第四轮升级：长期目标里程碑（时间锚点 + 完成判据 = 进度阈值）。
 * 完成判据自动评估：目标进度 ≥ progressAtLeast 即 met（sweep 时机判定）；
 * 锚点已过且未达标 → 延误预警（幂等）；延误后进度补齐 → 追赶转 met。
 */
export interface GoalMilestone {
  id: string;
  /** 链上序号（0 起） */
  index: number;
  title: string;
  /** 完成判据描述（自动生成：进度阈值口径） */
  criterion: string;
  /** 时间锚点（毫秒时间戳——该里程碑应达成的最晚时刻） */
  dueAt: number;
  /** 完成判据：目标进度 ≥ 该阈值即自动判 met */
  progressAtLeast: number;
  status: 'pending' | 'met' | 'overdue';
  /** 延误预警时刻（已预警的证据，幂等标记） */
  warnedAt?: number;
  /** 达标时刻 */
  metAt?: number;
}

/** 里程碑延误预警（sweepMilestoneDelays 的返回口径） */
export interface MilestoneDelay {
  goalId: string;
  milestoneId: string;
  index: number;
  /** 已延误时长（now − dueAt，毫秒） */
  delayMs: number;
  /** 目标当前进度 0~1 */
  progress: number;
  /** 该里程碑的进度阈值 */
  progressAtLeast: number;
  /** 进度缺口（阈值 − 当前进度——离达标还差多少） */
  progressShortfall: number;
}

/** 自主目标 */
export interface Goal {
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
  /** DAG 依赖的前驱目标 id（前驱未 completed 前不参与派发；环拒绝） */
  dependsOn?: string[];
  /** 目标级预算（时间/尝试数；超支自动停滞） */
  budget?: GoalBudget;
  /** 子任务成败统计（成功率先验的数据源，recordSubtaskOutcome 记账） */
  outcomes?: { successes: number; failures: number };
  /** 停滞标记（陈旧检测打上；有新进展自动摘除） */
  stalled?: boolean;
  /** 停滞成因列表 */
  stallReasons?: string[];
  /** 降级时刻（毫秒时间戳） */
  demotedAt?: number;
  /** 合并去向（未决子任务已并入的目标 id） */
  mergedInto?: string;
  /** 首次派发时刻（预算时间轴起点） */
  startedAt?: number;
  /** 最近一次前进进展时刻（陈旧检测「长期无进展」轴的起点水位） */
  lastProgressAt?: number;
  /** 第四轮升级：共享资源需求表（资源名 → 声明需求量；冲突检测用，缺省不声明） */
  resources?: Record<string, number>;
  /** 第四轮升级：里程碑链（planMilestones 生成；缺省无——任何行为零漂移） */
  milestones?: GoalMilestone[];
}

/** 目标分解器签名（可注入，通常为 strategist LLM） */
export type GoalDecomposer = (goal: Goal) => Promise<Array<{ description: string; taskType: string }>>;

/** 目标引擎配置 */
export interface GoalEngineConfig {
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
  /** 陈旧窗口（毫秒）：活跃目标超过该时长无前进进展 → no-progress 停滞；≤0 关闭该轴（缺省 30 分钟） */
  staleNoProgressMs?: number;
  /** 停滞降级因子：停滞目标优先序乘子（缺省 0.25——降级不销户，有进展可复权） */
  stallDemoteFactor?: number;
  /** 成功率先验强度（Beta(α,α) 共轭先验，缺省 1；零证据时先验 = 0.5 → 排序退化为原价值序，零漂移） */
  successPriorStrength?: number;
}

/** 默认配置 */
export const DEFAULT_GOAL_ENGINE_CONFIG: GoalEngineConfig = {
  minInsightSeverity: 0.4,
  maxActiveGoals: 5,
  maxSubtaskAttempts: 2,
  dedupeEnabled: true,
  staleNoProgressMs: 30 * 60_000,
  stallDemoteFactor: 0.25,
  successPriorStrength: 1,
};

/**
 * 自主目标引擎
 *
 * 被 index.ts 持有：autonomy-loop 每轮心跳调用 generateGoalsFromInsights
 * 产出目标，再将分解后的子任务注入哨兵执行，执行结果经
 * recordSubtaskOutcome 回写进度，形成"洞察 → 目标 → 行动 → 达成"闭环。
 */
export class GoalEngine {
  private config: GoalEngineConfig;
  private goals = new Map<string, Goal>();
  private goalCounter = 0;
  private subtaskCounter = 0;
  /** 第四轮升级：共享资源池容量（attachResourcePool 挂载；未挂载 → 冲突检测恒空，零漂移） */
  private resourcePool?: Record<string, number>;

  constructor(config?: Partial<GoalEngineConfig>) {
    this.config = { ...DEFAULT_GOAL_ENGINE_CONFIG, ...config };
  }

  /**
   * 从洞察批量生成目标（自主目标生成的核心入口）
   * @param insights 来自反思/元认知/记忆的洞察列表
   * @returns 新生成的目标（去重后）
   */
  generateGoalsFromInsights(insights: Insight[]): Goal[] {
    const created: Goal[] = [];
    // 按严重度降序，优先消化最重要的洞察
    const sorted = [...insights]
      .filter((i) => i.severity >= this.config.minInsightSeverity)
      .sort((a, b) => b.severity - a.severity);

    for (const insight of sorted) {
      if (this.activeGoalCount() >= this.config.maxActiveGoals) break;

      const title = this.titleFromInsight(insight);
      if (this.config.dedupeEnabled && this.isDuplicate(title)) continue;

      // 价值评估：严重度驱动 impact，建议明确度驱动 confidence，成本按子任务数估算
      const impact = Math.min(1, 0.3 + insight.severity * 0.7);
      const confidence = insight.suggestion.length > 0 ? 0.7 : 0.4;
      const estimatedCost = 1; // 分解前按单步估算，分解后可重估
      const goal: Goal = {
        id: `goal-${++this.goalCounter}`,
        title,
        description: `${insight.message}。改进方向：${insight.suggestion}`,
        origin: insight.source,
        insightRef: insight.message,
        status: 'proposed',
        valueScore: this.computeValue(impact, confidence, estimatedCost),
        impact,
        confidence,
        estimatedCost,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        taskType: insight.taskType,
        subtasks: [],
        outcomes: { successes: 0, failures: 0 },
        lastProgressAt: Date.now(),
      };
      this.goals.set(goal.id, goal);
      created.push(goal);
    }
    return created;
  }

  /**
   * 分解目标为子任务（LLM 分解 + 规则兜底）
   * @param goalId 目标 id
   * @returns 分解出的子任务列表
   */
  async decompose(goalId: string): Promise<GoalSubtask[]> {
    const goal = this.goals.get(goalId);
    if (!goal) return [];

    let steps: Array<{ description: string; taskType: string }> = [];
    if (this.config.decomposer) {
      try {
        steps = await this.config.decomposer(goal);
      } catch {
        /* 落入规则兜底 */
      }
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      // 规则兜底：目标描述本身作为单一子任务
      steps = [{ description: goal.description, taskType: goal.taskType ?? 'self-improvement' }];
    }

    goal.subtasks = steps.slice(0, 8).map((step) => ({
      id: `subtask-${++this.subtaskCounter}`,
      description: step.description,
      taskType: step.taskType || goal.taskType || 'self-improvement',
      status: 'pending' as const,
      attempts: 0,
    }));
    // 分解后按子任务数重估成本与价值
    goal.estimatedCost = goal.subtasks.length;
    goal.valueScore = this.computeValue(goal.impact, goal.confidence, goal.estimatedCost);
    goal.status = 'active';
    goal.updatedAt = Date.now();
    return goal.subtasks;
  }

  /**
   * 选取下一个待执行子任务（优先序最高目标优先，FIFO 次序）
   *
   * 第三轮升级（缺省零漂移）：
   * - 优先序 = 价值分 × 成功率先验 × 停滞降级因子（priorityScoreOf）——
   *   零证据时先验恒 0.5、无停滞时因子恒 1，排序与原价值序完全一致；
   *   证据积累后，资源流向「价值 × 可实现性」的乘积最优者（高价值但
   *   反复失败的目标让位给稳步推进的目标）
   * - DAG 就绪门：dependsOn 前驱全部 completed 才参与派发
   *   （未声明依赖 → 恒就绪，行为不变）
   * - 第四轮升级：可选排除集（安全门拒绝 / 时段窗口排队的子任务本轮
   *   让位，派发机会顺延给后续可选者——不传参数行为逐位不变）
   * @param excludeSubtaskIds 本轮排除的子任务 id（可选）
   * @returns 目标与子任务，无待执行项时返回 null
   */
  pickNextSubtask(excludeSubtaskIds?: string[]): { goal: Goal; subtask: GoalSubtask } | null {
    const exclude = excludeSubtaskIds ? new Set(excludeSubtaskIds) : undefined;
    const activeGoals = [...this.goals.values()]
      .filter((g) => (g.status === 'active' || g.status === 'in-progress') && g.subtasks.some((s) => s.status === 'pending'))
      .filter((g) => this.dependenciesSatisfied(g))
      .sort((a, b) => this.priorityScoreOf(b) - this.priorityScoreOf(a));
    for (const goal of activeGoals) {
      const subtask = goal.subtasks.find((s) => s.status === 'pending' && !(exclude?.has(s.id)));
      if (subtask) return { goal, subtask };
    }
    return null;
  }

  /**
   * 标记子任务已派发（绑定执行信号）
   */
  markDispatched(goalId: string, subtaskId: string, signalId: string): void {
    const subtask = this.findSubtask(goalId, subtaskId);
    if (!subtask) return;
    subtask.status = 'dispatched';
    subtask.signalId = signalId;
    subtask.attempts += 1;
    const goal = this.goals.get(goalId);
    if (goal) {
      goal.status = 'in-progress';
      // 预算时间轴起点：首次派发记账（缺省无预算 → 不参与任何判定）
      if (goal.startedAt === undefined) goal.startedAt = Date.now();
      goal.updatedAt = Date.now();
    }
  }

  /**
   * 回写子任务执行结果（由编排层在信号执行完成后调用）
   *
   * 第三轮升级（记账口径，不改变既有状态迁移）：
   * - 成败喂入目标级 outcomes（成功率先验的数据源）
   * - 成功即前进进展：刷新 lastProgressAt；停滞目标自动摘帽复权
   *   （降级是「暂停信任」不是销户——重新挣得优先序）
   * @returns 目标状态变化（completed / abandoned / null）
   */
  recordSubtaskOutcome(goalId: string, subtaskId: string, success: boolean, result?: string): GoalStatus | null {
    const goal = this.goals.get(goalId);
    const subtask = this.findSubtask(goalId, subtaskId);
    if (!goal || !subtask) return null;

    // 成功率先验记账（零证据 → Beta 先验 0.5，排序零漂移）
    if (goal.outcomes === undefined) goal.outcomes = { successes: 0, failures: 0 };
    if (success) {
      goal.outcomes.successes += 1;
      goal.lastProgressAt = Date.now();
      if (goal.stalled) {
        // 复权：停滞目标重新产生进展，摘帽恢复满优先序
        goal.stalled = false;
        goal.stallReasons = undefined;
        goal.demotedAt = undefined;
      }
    } else {
      goal.outcomes.failures += 1;
    }

    if (success) {
      subtask.status = 'done';
      subtask.result = result;
    } else if (subtask.attempts >= this.config.maxSubtaskAttempts) {
      subtask.status = 'failed';
      subtask.result = result ?? '重试耗尽';
    } else {
      // 未达重试上限：回到 pending 等待重新派发
      subtask.status = 'pending';
      subtask.signalId = undefined;
    }
    goal.updatedAt = Date.now();

    // 目标终态判定
    const allDone = goal.subtasks.every((s) => s.status === 'done');
    const anyFailed = goal.subtasks.some((s) => s.status === 'failed');
    if (allDone && goal.subtasks.length > 0) {
      goal.status = 'completed';
      return 'completed';
    }
    if (anyFailed && !goal.subtasks.some((s) => s.status === 'pending' || s.status === 'dispatched')) {
      goal.status = 'abandoned';
      return 'abandoned';
    }
    return null;
  }

  /** 通过信号 id 查找绑定的目标与子任务（执行完成回写用） */
  findBySignal(signalId: string): { goal: Goal; subtask: GoalSubtask } | null {
    for (const goal of this.goals.values()) {
      const subtask = goal.subtasks.find((s) => s.signalId === signalId);
      if (subtask) return { goal, subtask };
    }
    return null;
  }

  // ─────────────── 第三轮升级：目标 DAG · 预算 · 陈旧检测 · 价值排序 ───────────────

  /**
   * 声明目标 DAG 依赖（goalId 依赖 dependsOnGoalId：前驱 completed 前不派发）。
   *
   * 拒绝：未知 id、自依赖、重复边、成环（DFS 检测——目标图必须是 DAG，
   * 环上的目标谁也无法就绪）。声明期即拒绝，不留运行期死锁。
   * @returns 是否声明成功
   */
  addDependency(goalId: string, dependsOnGoalId: string): boolean {
    if (goalId === dependsOnGoalId) return false;
    const goal = this.goals.get(goalId);
    const dep = this.goals.get(dependsOnGoalId);
    if (!goal || !dep) return false;
    if ((goal.dependsOn ?? []).includes(dependsOnGoalId)) return false;
    if (this.reaches(dependsOnGoalId, goalId)) return false; // 反向可达 = 成环
    goal.dependsOn = [...(goal.dependsOn ?? []), dependsOnGoalId];
    goal.updatedAt = Date.now();
    return true;
  }

  /**
   * 目标 DAG 视图（只读：节点就绪态 + 全图无环性）
   */
  dependencyView(): { goals: Array<{ id: string; title: string; status: GoalStatus; dependsOn: string[]; ready: boolean }>; acyclic: boolean } {
    return {
      goals: [...this.goals.values()].map((g) => ({
        id: g.id,
        title: g.title,
        status: g.status,
        dependsOn: [...(g.dependsOn ?? [])],
        ready: this.dependenciesSatisfied(g),
      })),
      acyclic: this.isAcyclic(),
    };
  }

  /**
   * 设定目标级预算（时间 / 尝试数双轴；超支由 sweepStalledGoals 判停滞）。
   * @returns 目标是否存在
   */
  setGoalBudget(goalId: string, budget: GoalBudget): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) return false;
    goal.budget = { ...goal.budget, ...budget };
    goal.updatedAt = Date.now();
    return true;
  }

  /**
   * 成功率先验（Beta(α,α) 共轭后验：(成功数+α) / (成败数+2α)）。
   * 零证据 → 0.5（与价值分单调复合 → 排序退化为原价值序，缺省零漂移）。
   */
  goalSuccessPrior(goalId: string): number {
    const goal = this.goals.get(goalId);
    if (!goal) return 0;
    const alpha = Math.max(0, this.config.successPriorStrength ?? 1);
    if (alpha === 0) {
      // 先验强度 0：无平滑——零证据目标先验记 0（不参与派发直到有成功）
      const outcomes = goal.outcomes;
      if (!outcomes || outcomes.successes + outcomes.failures === 0) return 0;
      return outcomes.successes / (outcomes.successes + outcomes.failures);
    }
    const successes = goal.outcomes?.successes ?? 0;
    const failures = goal.outcomes?.failures ?? 0;
    return (successes + alpha) / (successes + failures + 2 * alpha);
  }

  /**
   * 优先序读数（资源投入的真实排序键）：价值分 × 成功率先验 × 停滞降级因子。
   */
  priorityScore(goalId: string): number {
    const goal = this.goals.get(goalId);
    if (!goal) return 0;
    return this.priorityScoreOf(goal);
  }

  /**
   * 陈旧检测 + 自动降级/合并（心跳 propose 相位或宿主按需调用，幂等）。
   *
   * 停滞成因（任一命中即降级，可叠加）：
   * - budget-time：时间预算超支（首次派发起算）
   * - budget-attempts：尝试预算超限（目标级累计派发数）
   * - no-progress：陈旧窗口内无前进进展（lastProgressAt 水位）
   * - deadline-exceeded：时限已过且尚有未决子任务
   * - dependency-invalid：DAG 前驱 abandoned / merged（前提失效——立即停滞）
   *
   * 处置：
   * - 降级：stalled = true + 优先序乘停滞因子（0.25 缺省）——不销户，
   *   后续成功自动摘帽复权（recordSubtaskOutcome）
   * - 合并：因「前提失效」而停滞且存在健康同型目标（DAG 就绪、未停滞、
   *   同 taskType 优先 / 同来源次之 / 再按优先序）时，未决子任务自动
   *   并入该目标，源目标终态 merged——子任务不陪葬
   * @returns 本轮处置动作（已停滞目标不重复报告）
   */
  sweepStalledGoals(now: number = Date.now()): StallAction[] {
    const actions: StallAction[] = [];
    const stalledThisRound: string[] = [];
    for (const goal of this.goals.values()) {
      if (goal.status !== 'active' && goal.status !== 'in-progress') continue;
      if (goal.stalled) continue; // 幂等：已降级者不重复报告
      const reasons: string[] = [];

      if (goal.budget?.timeMs !== undefined && goal.startedAt !== undefined && now - goal.startedAt > goal.budget.timeMs) {
        reasons.push('budget-time');
      }
      const attempts = goal.subtasks.reduce((sum, s) => sum + s.attempts, 0);
      if (goal.budget?.maxAttempts !== undefined && attempts > goal.budget.maxAttempts) {
        reasons.push('budget-attempts');
      }
      const window = this.config.staleNoProgressMs ?? 30 * 60_000;
      if (window > 0 && goal.lastProgressAt !== undefined && now - goal.lastProgressAt > window) {
        reasons.push('no-progress');
      }
      if (goal.deadline !== undefined && now > goal.deadline && goal.subtasks.some((s) => s.status !== 'done')) {
        reasons.push('deadline-exceeded');
      }
      const failedDeps = (goal.dependsOn ?? []).filter((id) => {
        const d = this.goals.get(id);
        return d !== undefined && (d.status === 'abandoned' || d.status === 'merged');
      });
      if (failedDeps.length > 0) reasons.push('dependency-invalid');

      if (reasons.length === 0) continue;
      goal.stalled = true;
      goal.stallReasons = reasons;
      goal.demotedAt = now;
      goal.updatedAt = now;
      actions.push({ goalId: goal.id, action: 'demoted', reasons });
      stalledThisRound.push(goal.id);
    }

    // 自动合并：前提失效的停滞目标 → 未决子任务并入健康同型目标
    // （同 taskType 优先、同来源次之、再按优先序；目标须已分解且 DAG 就绪
    //   ——同样依赖失效前驱的目标自己也在停滞名单里，天然出局）
    for (const id of stalledThisRound) {
      const goal = this.goals.get(id);
      if (!goal || !goal.stalled || !(goal.stallReasons ?? []).includes('dependency-invalid')) continue;
      const candidates = [...this.goals.values()].filter(
        (s) =>
          s.id !== goal.id &&
          !s.stalled &&
          (s.status === 'active' || s.status === 'in-progress') &&
          this.dependenciesSatisfied(s),
      );
      if (candidates.length === 0) continue;
      const target = candidates.sort((a, b) => {
        const typeMatch = (Number(b.taskType === goal.taskType) - Number(a.taskType === goal.taskType));
        if (typeMatch !== 0) return typeMatch;
        const originMatch = Number(b.origin === goal.origin) - Number(a.origin === goal.origin);
        if (originMatch !== 0) return originMatch;
        return this.priorityScoreOf(b) - this.priorityScoreOf(a);
      })[0]!;
      const merged = this.mergeGoals(goal.id, target.id, now);
      if (merged && merged.moved > 0) {
        // 合并吸收降级动作（同一目标一轮只报一条处置——merged 已含降级语义）
        const demoteIndex = actions.findIndex((a) => a.goalId === goal.id && a.action === 'demoted');
        if (demoteIndex >= 0) actions.splice(demoteIndex, 1);
        actions.push({ goalId: goal.id, action: 'merged', reasons: goal.stallReasons ?? [], mergedInto: target.id });
      }
    }
    return actions;
  }

  /**
   * 合并目标：source 的未决子任务（pending / dispatched）并入 target，
   * source 终态 merged。dispatched 子任务连信号绑定一起迁移
   * （findBySignal 回写不中断）。terminal → terminal 不合并。
   * @returns 迁移子任务数（目标非法返回 null）
   */
  mergeGoals(sourceId: string, targetId: string, now: number = Date.now()): { moved: number } | null {
    const source = this.goals.get(sourceId);
    const target = this.goals.get(targetId);
    if (!source || !target || sourceId === targetId) return null;
    if (source.status === 'completed' || source.status === 'abandoned' || source.status === 'merged') return null;
    if (target.status !== 'active' && target.status !== 'in-progress') return null;
    if (this.reaches(targetId, sourceId) && (source.dependsOn ?? []).includes(targetId)) return null; // 互为依赖不合并

    const movers = source.subtasks.filter((s) => s.status === 'pending' || s.status === 'dispatched');
    if (movers.length > 0) {
      target.subtasks.push(...movers.map((s) => ({ ...s })));
      source.subtasks = source.subtasks.filter((s) => s.status !== 'pending' && s.status !== 'dispatched');
      // 吸收方成本重估（子任务变多 → 单位价值摊薄，价值分按口径重算）
      target.estimatedCost += movers.length;
      target.valueScore = this.computeValue(target.impact, target.confidence, target.estimatedCost);
      target.updatedAt = now;
    }
    source.status = 'merged';
    source.mergedInto = targetId;
    source.updatedAt = now;
    return { moved: movers.length };
  }

  // ─────────────── 第四轮升级：目标冲突检测 · 长期目标里程碑（缺省零漂移） ───────────────

  /**
   * 挂载共享资源池（幂等覆盖，挂载即生效）。
   *
   * 资源池给出每个共享资源的总容量（如 { 'llm-budget': 10, 'gpu': 8 }，
   * 口径由宿主任意定义——模型并发额度 / 存储 / 配额皆可）。挂载后
   * detectResourceConflicts / resourceConflictView 可用；未挂载 →
   * 冲突检测恒空、目标行为逐位不变（零漂移）。
   * @param capacity 资源名 → 容量（负容量按 0 计）
   */
  attachResourcePool(capacity: Record<string, number>): void {
    const pool: Record<string, number> = {};
    for (const [resource, raw] of Object.entries(capacity)) {
      pool[resource] = Number.isFinite(raw) && raw > 0 ? raw : 0;
    }
    this.resourcePool = pool;
  }

  /**
   * 声明目标的共享资源需求（冲突检测的数据源；对未知目标返回 false）。
   * @param goalId 目标 id
   * @param resources 资源名 → 需求量（负需求按 0 计；传空对象 = 清空声明）
   */
  declareGoalResources(goalId: string, resources: Record<string, number>): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) return false;
    const clean: Record<string, number> = {};
    for (const [resource, raw] of Object.entries(resources)) {
      const value = Number.isFinite(raw) && raw > 0 ? raw : 0;
      if (value > 0) clean[resource] = value;
    }
    goal.resources = clean;
    goal.updatedAt = Date.now();
    return true;
  }

  /**
   * 检测目标间资源冲突（成对口径）：同一资源上两个活跃目标的声明需求
   * 之和超过池容量 → 该目标对在该资源上互斥，报告缺口。
   *
   * 口径细则：
   * - 参与者：proposed / active / in-progress 且未停滞的目标（停滞目标
   *   已降级——资源声明视为休眠，不参与冲突；有进展复权后自动回池）
   * - 终态目标（completed / abandoned / merged）不参与
   * - 确定性排序：资源名升序，目标 id 升序（同库状态 → 报告逐位可复现）
   * - 未挂载资源池 / 目标未声明资源 → 恒空（零漂移）
   */
  detectResourceConflicts(): GoalResourceConflict[] {
    if (!this.resourcePool) return [];
    const conflicts: GoalResourceConflict[] = [];
    for (const resource of Object.keys(this.resourcePool).sort()) {
      const capacity = this.resourcePool[resource] ?? 0;
      const claimants = [...this.goals.values()]
        .filter(
          (g) =>
            (g.status === 'proposed' || g.status === 'active' || g.status === 'in-progress') &&
            !g.stalled &&
            (g.resources?.[resource] ?? 0) > 0,
        )
        .map((g) => ({ id: g.id, demand: g.resources![resource] ?? 0 }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (let i = 0; i < claimants.length; i += 1) {
        for (let j = i + 1; j < claimants.length; j += 1) {
          const a = claimants[i]!;
          const b = claimants[j]!;
          const totalDemand = a.demand + b.demand;
          if (totalDemand > capacity) {
            conflicts.push({
              goals: [a.id, b.id],
              resource,
              demandA: a.demand,
              demandB: b.demand,
              totalDemand,
              capacity,
              shortfall: totalDemand - capacity,
            });
          }
        }
      }
    }
    return conflicts;
  }

  /**
   * 资源冲突全景视图：成对冲突 + 池级超载（全活跃目标合计超容量——
   * 比「任两个目标互斥」更宽的口径：三个目标各要 4、池容量 10 时无
   * 成对冲突但合计超载 12 > 10，池级口径能看见）。
   */
  resourceConflictView(): { pool: Record<string, number>; conflicts: GoalResourceConflict[]; overloads: ResourceOverload[] } {
    const pool = this.resourcePool ? { ...this.resourcePool } : {};
    if (!this.resourcePool) return { pool, conflicts: [], overloads: [] };
    const overloads: ResourceOverload[] = [];
    for (const resource of Object.keys(this.resourcePool).sort()) {
      const capacity = this.resourcePool[resource] ?? 0;
      const claimants = [...this.goals.values()]
        .filter(
          (g) =>
            (g.status === 'proposed' || g.status === 'active' || g.status === 'in-progress') &&
            !g.stalled &&
            (g.resources?.[resource] ?? 0) > 0,
        )
        .map((g) => ({ id: g.id, demand: g.resources![resource] ?? 0 }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const totalDemand = claimants.reduce((sum, c) => sum + c.demand, 0);
      if (totalDemand > capacity) {
        overloads.push({
          resource,
          goals: claimants.map((c) => c.id),
          totalDemand,
          capacity,
          shortfall: totalDemand - capacity,
        });
      }
    }
    return { pool, conflicts: this.detectResourceConflicts(), overloads };
  }

  /**
   * 为长期目标规划里程碑链（时间锚点 + 完成判据 = 进度阈值）。
   *
   * 链上第 i 个里程碑（0 起，共 count 个）：
   * - 锚点 dueAt = now + horizon × (i+1)/count（均匀切分目标地平线）
   * - 判据 progressAtLeast = (i+1)/count（进度累计达标口径）
   * 延误检测见 sweepMilestoneDelays（锚点已过且进度未达标 → 预警）。
   *
   * @param goalId 目标 id（未知返回 []）
   * @param options.count 里程碑数（缺省 3，钳位 [1, 12]）
   * @param options.horizonMs 目标地平线（缺省：目标 deadline − now，无
   *   deadline 或已过期则 90 天）
   * @param options.now 规划起点（缺省 Date.now——注入时钟可确定性复现）
   * @returns 生成的里程碑链（重新规划覆盖旧链）
   */
  planMilestones(goalId: string, options?: { count?: number; horizonMs?: number; now?: number }): GoalMilestone[] {
    const goal = this.goals.get(goalId);
    if (!goal) return [];
    const now = options?.now ?? Date.now();
    const count = Math.max(1, Math.min(12, Math.floor(options?.count ?? 3)));
    const defaultHorizon = goal.deadline !== undefined && goal.deadline > now ? goal.deadline - now : 90 * 24 * 60 * 60_000;
    const horizonMs = Math.max(1, Math.floor(options?.horizonMs ?? defaultHorizon));

    goal.milestones = Array.from({ length: count }, (_, i) => {
      const threshold = Number(((i + 1) / count).toFixed(4));
      return {
        id: `ms-${goal.id}-${i}`,
        index: i,
        title: `里程碑 ${i + 1}/${count}：${goal.title.slice(0, 40)}`,
        criterion: `目标进度 ≥ ${Math.round(threshold * 100)}%`,
        dueAt: now + Math.floor((horizonMs * (i + 1)) / count),
        progressAtLeast: threshold,
        status: 'pending' as const,
      };
    });
    goal.updatedAt = now;
    return [...goal.milestones];
  }

  /**
   * 里程碑延误扫描（心跳 propose 相位或宿主按需调用，幂等）。
   *
   * 对每个带里程碑链的非终态目标：
   * - 进度达标（progressOf ≥ progressAtLeast）→ 自动判 met（含延误后
   *   追赶——overdue 状态补齐也转 met，warnedAt 留档审计）
   * - 锚点已过（now > dueAt）且未达标 → 延误预警（只报一次——warnedAt
   *   幂等标记；再次调用不重复报）
   * @returns 本轮新检出的延误预警
   */
  sweepMilestoneDelays(now: number = Date.now()): MilestoneDelay[] {
    const delays: MilestoneDelay[] = [];
    for (const goal of this.goals.values()) {
      if (!goal.milestones || goal.milestones.length === 0) continue;
      if (goal.status !== 'proposed' && goal.status !== 'active' && goal.status !== 'in-progress') continue;
      const progress = this.progressOf(goal);
      for (const milestone of goal.milestones) {
        if (milestone.status === 'met') continue;
        if (progress + 1e-9 >= milestone.progressAtLeast) {
          // 达标（含延误后追赶）：转 met，预警留档
          milestone.status = 'met';
          milestone.metAt = now;
          continue;
        }
        if (now > milestone.dueAt && milestone.status !== 'overdue') {
          milestone.status = 'overdue';
          milestone.warnedAt = now;
          delays.push({
            goalId: goal.id,
            milestoneId: milestone.id,
            index: milestone.index,
            delayMs: now - milestone.dueAt,
            progress: Number(progress.toFixed(4)),
            progressAtLeast: milestone.progressAtLeast,
            progressShortfall: Number((milestone.progressAtLeast - progress).toFixed(4)),
          });
        }
      }
      goal.updatedAt = now;
    }
    return delays;
  }

  /**
   * 待执行子任务总数（心跳自适应节奏的「待处理目标负载」轴）。
   */
  pendingSubtaskCount(): number {
    let count = 0;
    for (const goal of this.goals.values()) {
      if (goal.status !== 'active' && goal.status !== 'in-progress' && goal.status !== 'proposed') continue;
      count += goal.subtasks.filter((s) => s.status === 'pending').length;
    }
    return count;
  }

  /** 活跃目标数（proposed / active / in-progress） */
  activeGoalCount(): number {
    return [...this.goals.values()].filter((g) => g.status === 'proposed' || g.status === 'active' || g.status === 'in-progress').length;
  }

  /** 获取目标 */
  getGoal(goalId: string): Goal | undefined {
    return this.goals.get(goalId);
  }

  /** 全部目标（按价值降序） */
  getAllGoals(): Goal[] {
    return [...this.goals.values()].sort((a, b) => b.valueScore - a.valueScore);
  }

  /** 目标进度摘要 */
  getSummary(): any {
    const goals = this.getAllGoals();
    return {
      total: goals.length,
      byStatus: goals.reduce((acc, g) => {
        acc[g.status] = (acc[g.status] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      activeGoals: goals.filter((g) => g.status === 'active' || g.status === 'in-progress').map((g) => ({
        id: g.id,
        title: g.title,
        valueScore: Number(g.valueScore.toFixed(3)),
        /** 优先序（价值 × 成功率先验 × 停滞降级）——资源投入的真实排序键 */
        priorityScore: Number(this.priorityScoreOf(g).toFixed(3)),
        successPrior: Number(this.goalSuccessPrior(g.id).toFixed(3)),
        stalled: g.stalled ?? false,
        stallReasons: g.stalled ? g.stallReasons : undefined,
        mergedInto: g.mergedInto,
        progress: this.progressOf(g),
        subtasks: g.subtasks.map((s) => ({ id: s.id, status: s.status, description: s.description })),
      })),
    };
  }

  /** 序列化（随长期记忆持久化） */
  serialize(): Goal[] {
    return this.getAllGoals();
  }

  /** 反序列化（恢复跨会话目标追求） */
  deserialize(goals: Goal[]): void {
    this.goals.clear();
    let maxGoal = 0;
    let maxSubtask = 0;
    for (const goal of goals) {
      this.goals.set(goal.id, goal);
      const goalNum = Number(goal.id.split('-')[1] ?? 0);
      if (goalNum > maxGoal) maxGoal = goalNum;
      for (const subtask of goal.subtasks) {
        const subNum = Number(subtask.id.split('-')[1] ?? 0);
        if (subNum > maxSubtask) maxSubtask = subNum;
      }
    }
    this.goalCounter = maxGoal;
    this.subtaskCounter = maxSubtask;
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /**
   * 优先序（资源投入排序键）：价值分 × 成功率先验 × 停滞降级因子。
   * 零证据 + 无停滞 → 价值分 × 0.5（单调复合 → 与原价值序完全一致，零漂移）。
   */
  private priorityScoreOf(goal: Goal): number {
    const prior = (() => {
      const alpha = Math.max(0, this.config.successPriorStrength ?? 1);
      const successes = goal.outcomes?.successes ?? 0;
      const failures = goal.outcomes?.failures ?? 0;
      if (alpha === 0) {
        if (successes + failures === 0) return 0;
        return successes / (successes + failures);
      }
      return (successes + alpha) / (successes + failures + 2 * alpha);
    })();
    const demote = goal.stalled ? (this.config.stallDemoteFactor ?? 0.25) : 1;
    return goal.valueScore * prior * demote;
  }

  /** DAG 就绪：无依赖恒就绪；有依赖 → 全部前驱 completed（零漂移：缺省无依赖字段） */
  private dependenciesSatisfied(goal: Goal): boolean {
    const deps = goal.dependsOn;
    if (!deps || deps.length === 0) return true;
    return deps.every((id) => this.goals.get(id)?.status === 'completed');
  }

  /** 依赖可达性：from 沿 dependsOn 深度优先是否可达 to（环检测用） */
  private reaches(from: string, to: string, visited?: Set<string>): boolean {
    if (from === to) return true;
    const seen = visited ?? new Set<string>();
    if (seen.has(from)) return false;
    seen.add(from);
    for (const dep of this.goals.get(from)?.dependsOn ?? []) {
      if (this.reaches(dep, to, seen)) return true;
    }
    return false;
  }

  /** 全图无环性（依赖闭包上 DFS：任一节点沿依赖回到自身即有环） */
  private isAcyclic(): boolean {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    const visit = (id: string): boolean => {
      const c = color.get(id) ?? WHITE;
      if (c === GRAY) return false;
      if (c === BLACK) return true;
      color.set(id, GRAY);
      for (const dep of this.goals.get(id)?.dependsOn ?? []) {
        if (!visit(dep)) return false;
      }
      color.set(id, BLACK);
      return true;
    };
    for (const id of this.goals.keys()) {
      if (!visit(id)) return false;
    }
    return true;
  }

  /** 价值评估：impact × confidence / cost（成本至少为 1） */
  private computeValue(impact: number, confidence: number, cost: number): number {
    return (impact * confidence) / Math.max(1, cost);
  }

  /** 从洞察提炼目标标题 */
  private titleFromInsight(insight: Insight): string {
    const scope = insight.taskType ? `[${insight.taskType}] ` : '';
    return `${scope}${insight.suggestion}`.slice(0, 120);
  }

  /** 目标去重：归一化标题的包含关系判定 */
  private isDuplicate(title: string): boolean {
    const normalized = title.toLowerCase().trim();
    for (const goal of this.goals.values()) {
      if (goal.status === 'completed' || goal.status === 'abandoned' || goal.status === 'merged') continue;
      const existing = goal.title.toLowerCase().trim();
      if (existing === normalized || existing.includes(normalized) || normalized.includes(existing)) {
        return true;
      }
    }
    return false;
  }

  /** 目标进度 0~1 */
  private progressOf(goal: Goal): number {
    if (goal.subtasks.length === 0) return 0;
    const done = goal.subtasks.filter((s) => s.status === 'done').length;
    return done / goal.subtasks.length;
  }

  /** 查找子任务 */
  private findSubtask(goalId: string, subtaskId: string): GoalSubtask | undefined {
    return this.goals.get(goalId)?.subtasks.find((s) => s.id === subtaskId);
  }
}

/** 从反思教训构建洞察（目标引擎与反思引擎的桥接） */
export function lessonsToInsights(lessons: Lesson[]): Insight[] {
  return lessons.map((lesson) => ({
    source: 'reflection' as const,
    category: lesson.rootCause,
    taskType: lesson.taskType,
    severity: lesson.rootCause === 'model-capability' || lesson.rootCause === 'timeout' ? 0.7 : 0.5,
    message: lesson.lesson,
    suggestion: lesson.suggestion,
  }));
}
