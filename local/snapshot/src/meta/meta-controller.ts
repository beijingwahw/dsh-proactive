/**
 * meta-controller.ts — 元认知控制器（第四阶段「元认知层」核心 2/2，implements IMetaCognitiveController）
 *
 * 职责：基于自我建模产出心智报告，自动调整操作环与进化环的运行参数——
 * 系统不仅进化策略（第三阶段内环），还进化「进化机制本身」（第四阶段外环），
 * 完成双环自治进化架构。
 *
 * 可调旋钮（与真实组件联动，经 read/write 回调落地）：
 * - reflector.autoDistillThreshold / distillMinConfidence：反思触发频率与蒸馏门槛
 * - evolver.mutationRate / minGain：进化器变异率与选择压力
 * - sandbox.evaluationSeeds：沙盒验证严格度（多种子统计门禁）
 * - optimizer.memoryFastPathThreshold：记忆层读取复用门槛
 *
 * 保守原则（安全内建，不依赖调用方自觉）：
 * 1. 每轮至多应用 maxAdjustmentsPerRound（缺省 1）个调整
 * 2. 每次只移动一个 step（旋钮自定义的小步长），绝不跳变
 * 3. 调整后进入观察窗（observationReports 份心智报告），期间不应用新调整
 * 4. 观察期满按 judgeMetric 判定：劣化超容忍 → 自动回滚；否则保留生效
 * 5. 手动接管优先：setManualOverride 的旋钮与全局 freeze 期间不做自动调整
 *
 * ── 2.0 质级升级：从「规则诊断 + 固定步长」到「学习型稳态控制」──
 * 1. 调参策略学习（AdjustmentLearner，乐观先验 Bandit）：每个「旋钮×方向」
 *    是一个学习臂，从 commit/rollback 历史估计各臂有效性并参与候选排序
 *    （权重随试验数增长）——元认知器进化自己的调参策略本身
 * 2. 综合判定护栏：任何调整若伴随操作环成功率显著劣化（超容忍），无论
 *    目标指标改善与否一律判失败——单指标优化不得以整体劣化为代价
 * 3. 稳态自适应步长：判定指标配置目标带（homeostasisBands）后，偏离带
 *    越远步长倍率越大（1~maxStepMultiplier 量化档位）；带内保持标准步长
 * 4. 经验安全包络：从 commit 取值学习安全区间（好值 ± 一步长），自动回滚
 *    发生过的取值记为已知劣化值——后续调整自动排除（prevention > rollback）
 * 5. 熔断器：单旋钮连续 breakerThreshold 次自动回滚 → 熔断该旋钮；
 *    全局连续 globalBreakerThreshold 次 → 全局熔断；reArmBreaker 手动复位
 * 6. 前瞻性调整：心智报告的前瞻风险（预测越限）注入候选——指标仍健康
 *    时提前行动（proactive），与反应式规则（reactive）互补
 *
 * ── 3.0 世界性升级：稳定环 / 证书门 / 冲突仲裁（全部 opt-in，零漂移） ──
 * 1. 调参死区稳定环（stabilityLoop）：死区（偏离 ≤ 带宽 25% 判为噪声不动）
 *    + 调整幅度斜坡（新方向首调半步，同向连续逐步升幅，翻转即重置）
 *    + 判定后冷却期——三重阻尼终结朴素比例外环在噪声下的极限环震荡；
 *    稳态带偏离可直接生成 homeostatic 候选（knobAffect 方向表）。
 * 2. 调整证书门（certificateGate，89.0 视图）：自我修改前用学习臂的
 *    历史调整效果配对样本做经验伯恩斯坦单侧下界（复用 89.0 ebRadius），
 *    LCB > 0 才放行全幅调整；视图不可用（冷启动）退化为保守半步 +
 *    严格判定观察窗（无明确改善即自动回滚）——「假改进」被证书拒绝。
 * 3. 内外环冲突仲裁：同参数被多方调整（内环调参器 / 人工 / 其他控制
 *    实例）→ 最后写入者胜（以旋钮当前真值为准，不盲目覆盖）+ 冲突
 *    计数与审计（观察中的调整被外部改写 → 观察作废重仲裁）。
 * 4. 注入时钟（config.clock）：审计/报告时间戳可注入（确定性验证口径）。
 *
 * ── 4.0 世界性升级：认知负荷计量 / 调整幅度元学习（全部 opt-in，零漂移） ──
 * 1. 认知负荷计量（cognitiveLoad）：在调旋钮数（最近 flightWindowReports
 *    份报告内的 adjust）/ 在观实验数（beginMetaExperiment 登记）/ 在跟踪
 *    KPI 数（setTrackedKpiCount）加权合成负荷分；超 maxLoad 暂停**新**
 *    调整（观察窗判定照常）——同时调太多旋钮时效果不可归因，负荷门把
 *    并发压回可归因水平（audit type 'load-gate'）。
 * 2. 调整幅度元学习（amplitudeMetaLearn）：调参策略本身的学习——每个
 *    已判定调整按幅度 |Δ|/step 归入幅度类（tentative ≤0.6 / standard
 *    ≤1.0 / aggressive >1.0），逐类累计成功率；后续同类调整的幅度先验
 *    因子 = 贝叶斯平滑成功率 / target（大调整连续翻车 → 收缩，小调整
 *    连续成功 → 放宽），零试验恒 1（冷启动零漂移）。
 *
 * 审计与可追溯：全部 adjust/commit/rollback/manual-override/skip/circuit-breaker
 * 动作全量写入审计日志并持久化（JSON）；rollbackLastAdjustment 支持手动回滚
 * 最近一次调整（无论观察中还是已提交）。
 */

import fs from 'node:fs';
import type {
  AdjustmentReport,
  AmplitudeMetaLearnConfig,
  AuditEntry,
  CertificateGateConfig,
  CircuitBreakerInfo,
  CognitiveLoadConfig,
  HomeostasisBands,
  JudgeMetric,
  KnobEffectiveness,
  MentalReport,
  MetaControllerState,
  RecommendedAdjustment,
  RollbackResult,
  SafeEnvelopeInfo,
  StabilityLoopConfig,
} from './meta-types.js';
// 89.0 安全策略改进：调整证书门的浓度半径（经验伯恩斯坦单侧界，与内核同式）
import { ebRadius } from '../core/safe-policy-improvement.js';
import { computeHomeostasis } from './self-model.js';
import type { SelfModel } from './self-model.js';

// ─────────────────────────── 调节旋钮 ───────────────────────────

/** 单个调节旋钮（参数热调整的最小单元） */
export interface AdjustmentKnob {
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

// ─────────────────────────── 配置与状态 ───────────────────────────

/** 元认知控制器配置 */
export interface MetaControllerConfig {
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
  // ── 2.0：学习型稳态控制 ──
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
  // ── 3.0：死区稳定环 / 调整证书门 / 冲突仲裁 / 注入时钟 ──
  /**
   * 3.0：调参死区稳定环（死区 + 斜坡 + 冷却）。
   * 提供该对象即启用（空对象 = 全缺省值）；undefined = 完全保持 2.0 行为。
   */
  stabilityLoop?: StabilityLoopConfig;
  /**
   * 3.0：调整证书门（89.0 视图：LCB > 0 才放行全幅自我调整）。
   * 提供该对象即启用；undefined = 完全保持 2.0 行为。
   */
  certificateGate?: CertificateGateConfig;
  /** 3.0：注入时钟（审计/报告时间戳来源；缺省 wall-clock，行为不变） */
  clock?: () => number;
  // ── 4.0：认知负荷门 / 调整幅度元学习 ──
  /**
   * 4.0：认知负荷计量（超阈值暂停新调整，防「同时调太多不可归因」）。
   * 提供该对象即启用；undefined = 完全保持既有行为（零漂移）。
   */
  cognitiveLoad?: CognitiveLoadConfig;
  /**
   * 4.0：调整幅度元学习（幅度类历史成功率 → 后续同类调整的幅度先验）。
   * 提供该对象即启用；undefined = 幅度因子恒 1（零漂移）。
   */
  amplitudeMetaLearn?: AmplitudeMetaLearnConfig;
}

/** 观察窗中的待判定调整 */
interface PendingAdjustment {
  knob: string;
  from: number;
  to: number;
  reason: string;
  reportsSeen: number;
  reportsNeeded: number;
  judgeMetric: JudgeMetric;
  higherIsBetter: boolean;
  baselineMetricValue: number;
  /** 2.0：判定时刻的全指标基线快照（护栏综合判定用） */
  baselineMetrics?: Record<JudgeMetric, number>;
  /** 2.0：调整方向（学习臂的组成部分） */
  direction?: 'up' | 'down';
  /** 2.0：调整来源（reactive / proactive / homeostatic） */
  source?: 'reactive' | 'proactive' | 'homeostatic';
  appliedAt: number;
  /** 触发本次调整的 adjust 审计条目 id（手动回滚去重用） */
  adjustAuditId?: string;
  /**
   * 3.0：保守半步标记（证书门视图不可用时的降级口径）。
   * 判定时执行严格标准：无明确改善（progress ≤ 容忍）即自动回滚——
   * 半步 + 严格窗 = 「先小试，没证据就退回」。
   */
  provisional?: boolean;
  /**
   * 3.0：稳态带判定口径（homeostatic 候选专用）。
   * 稳定环的目标是「回到带内」而非「指标越高越好」：从带上方 0.66
   * 调回带内 0.54 是靠带 1.1 个带宽的改善，按原始指标方向判反而是
   * 劣化。配置后判定改用带距离缩减量（devBefore − devAfter）作为
   * progress——仅稳定环候选携带，规则/前瞻候选维持 2.0 原始口径。
   */
  bandJudged?: { min: number; max: number };
  /**
   * 4.0：幅度类（|Δ|/step 分档）——判定时入账幅度元学习器。
   * 仅启用 amplitudeMetaLearn 后填写。
   */
  amplitudeBand?: 'tentative' | 'standard' | 'aggressive';
}

/** 持久化负载 */
interface PersistPayload {
  audit: AuditEntry[];
  pending?: PendingAdjustment;
  frozen: boolean;
  manuallyFrozenKnobs: string[];
  rolledBackAdjustIds: string[];
  counters: { adjustments: number; rollbacks: number; commits: number };
  // ── 2.0 ──
  learner?: { arms: Record<string, ArmStats>; totalTrials: number };
  envelopeGood?: Record<string, number[]>;
  envelopeBad?: Record<string, number[]>;
  breakerCounters?: Record<string, number>;
  trippedBreakers?: string[];
  globalRollbackStreak?: number;
  frozenByBreaker?: boolean;
  // ── 3.0：稳定环 / 证书门 / 冲突仲裁（缺省字段向后兼容旧持久化文件） ──
  directionStreaks?: Array<{ knob: string; direction: 'up' | 'down'; count: number }>;
  cooldownLeft?: number;
  stabilityCounters?: { deadbandSkips: number; cooldownSkips: number; directionFlips: number; rampedAdjustments: number };
  arbitrationCounters?: { conflicts: number; arbitrated: number };
  certificateState?: {
    decisions: Array<{ knob: string; direction: 'up' | 'down'; mode: 'full' | 'provisional' | 'rejected'; lcb?: number; samples: number }>;
    counters: { full: number; provisional: number; rejected: number };
  };
  // ── 4.0：认知负荷门 / 幅度元学习（缺省字段向后兼容旧持久化文件） ──
  loadGateState?: { experiments: string[]; trackedKpis: number; gateSkips: number };
  amplitudeBands?: Record<string, { trials: number; commits: number }>;
}

// ─────────────────── 2.0：调参策略学习器（乐观先验 Bandit） ───────────────────

/** 学习臂统计（臂 = 旋钮 × 方向） */
export interface ArmStats {
  trials: number;
  commits: number;
  rollbacks: number;
  /** 按指标原符号的效果增量累计 */
  effectSum: number;
  /** 3.0：逐次效果增量序列（89.0 证书门的配对样本视图；有界保留最近 32 次） */
  effects?: number[];
}

/** 乐观先验（Beta 平滑）：冷启动臂保持探索吸引力 */
const ARM_PRIOR_MEAN = 0.7;
const ARM_PRIOR_WEIGHT = 2;

/**
 * 调参策略学习器
 *
 * 每个调整臂（旋钮×方向）维护 trials/commits/rollbacks/effectSum；
 * 选择评分 = (1−w)·规则优先级 + w·贝叶斯平滑成功率，其中
 * w = trials/(trials+2)——试验越多越信任学习结果，冷启动完全
 * 遵循规则优先级（行为向后兼容），随经验积累逐步接管排序。
 */
class AdjustmentLearner {
  private arms = new Map<string, ArmStats & { knob: string; direction: 'up' | 'down'; judgeMetric: JudgeMetric }>();
  totalTrials = 0;

  private key(knob: string, direction: 'up' | 'down'): string {
    return `${knob}:${direction}`;
  }

  private ensure(knob: string, direction: 'up' | 'down', judgeMetric: JudgeMetric) {
    const k = this.key(knob, direction);
    let arm = this.arms.get(k);
    if (!arm) {
      arm = { knob, direction, judgeMetric, trials: 0, commits: 0, rollbacks: 0, effectSum: 0 };
      this.arms.set(k, arm);
    }
    return arm;
  }

  /** 候选选择评分（规则优先级与学习有效性的加权融合） */
  selectionScore(rulePriority: number, knob: string, direction: 'up' | 'down', judgeMetric: JudgeMetric): number {
    const arm = this.arms.get(this.key(knob, direction));
    if (!arm || arm.trials === 0) return rulePriority; // 冷启动：完全遵循规则优先级
    const w = arm.trials / (arm.trials + 2);
    const learned = (arm.commits + ARM_PRIOR_MEAN * ARM_PRIOR_WEIGHT) / (arm.trials + ARM_PRIOR_WEIGHT);
    return (1 - w) * rulePriority + w * learned;
  }

  /** 记录一次判定结果 */
  record(
    knob: string,
    direction: 'up' | 'down',
    judgeMetric: JudgeMetric,
    committed: boolean,
    effectDelta: number,
  ): void {
    const arm = this.ensure(knob, direction, judgeMetric);
    arm.trials += 1;
    arm.effectSum += effectDelta;
    // 3.0：效果序列入账（89.0 证书门的配对样本）
    arm.effects = arm.effects ?? [];
    arm.effects.push(effectDelta);
    if (arm.effects.length > 32) arm.effects.splice(0, arm.effects.length - 32);
    if (committed) arm.commits += 1;
    else arm.rollbacks += 1;
    this.totalTrials += 1;
  }

  /** 3.0：某臂的逐次效果序列（89.0 视图的原始配对样本；无试验返回空） */
  effectHistoryOf(knob: string, direction: 'up' | 'down'): number[] {
    return [...(this.arms.get(this.key(knob, direction))?.effects ?? [])];
  }

  /** 有效性快照（试验过的臂；供心智报告与状态面板） */
  effectiveness(): KnobEffectiveness[] {
    return [...this.arms.values()]
      .filter((a) => a.trials > 0)
      .map((a) => ({
        knob: a.knob,
        direction: a.direction,
        judgeMetric: a.judgeMetric,
        trials: a.trials,
        commits: a.commits,
        rollbacks: a.rollbacks,
        successRate: a.commits / a.trials,
        avgEffectDelta: a.effectSum / a.trials,
        effectivenessScore: (a.commits + ARM_PRIOR_MEAN * ARM_PRIOR_WEIGHT) / (a.trials + ARM_PRIOR_WEIGHT),
      }));
  }

  /** 平均学习置信权重（心智报告 explorationWeight） */
  averageConfidenceWeight(): number {
    const tried = [...this.arms.values()].filter((a) => a.trials > 0);
    if (tried.length === 0) return 0;
    return tried.reduce((s, a) => s + a.trials / (a.trials + 2), 0) / tried.length;
  }

  /** 手动探测某臂评分（测试/可观测） */
  peekScore(knob: string, direction: 'up' | 'down'): number | undefined {
    const arm = this.arms.get(this.key(knob, direction));
    if (!arm || arm.trials === 0) return undefined;
    return (arm.commits + ARM_PRIOR_MEAN * ARM_PRIOR_WEIGHT) / (arm.trials + ARM_PRIOR_WEIGHT);
  }

  dump(): { arms: Record<string, ArmStats>; totalTrials: number } {
    const arms: Record<string, ArmStats> = {};
    for (const [k, a] of this.arms) {
      arms[k] = { trials: a.trials, commits: a.commits, rollbacks: a.rollbacks, effectSum: a.effectSum, effects: [...(a.effects ?? [])] };
    }
    return { arms, totalTrials: this.totalTrials };
  }

  load(data: { arms: Record<string, ArmStats>; totalTrials: number } | undefined, judgeMetricOf: (knob: string) => JudgeMetric): void {
    if (!data || typeof data.arms !== 'object') return;
    for (const [k, stats] of Object.entries(data.arms)) {
      const [knob, direction] = k.split(':');
      if (!knob || (direction !== 'up' && direction !== 'down')) continue;
      const arm = this.ensure(knob, direction, judgeMetricOf(knob));
      arm.trials = stats.trials ?? 0;
      arm.commits = stats.commits ?? 0;
      arm.rollbacks = stats.rollbacks ?? 0;
      arm.effectSum = stats.effectSum ?? 0;
      arm.effects = [...(stats.effects ?? [])]; // 3.0：证书视图跨重启连续
    }
    this.totalTrials = typeof data.totalTrials === 'number' ? data.totalTrials : 0;
  }
}

// ─────────────────── 4.0：调整幅度元学习器（调参策略的学习） ───────────────────

/** 4.0：幅度类（|Δ|/step 分档） */
export type AmplitudeBand = 'tentative' | 'standard' | 'aggressive';

/**
 * 调整幅度元学习器
 *
 * 2.0 AdjustmentLearner 学「**哪个旋钮×方向**有效」；本学习器学
 * 「**多大力度**的调整有效」——同一旋钮同方向，全幅大步与半幅小步是
 * 两种策略：大调整快但翻车率高（回滚成本 + 暂态扰动），小调整稳但
 * 收敛慢。每个已判定调整按幅度倍率（|Δ|/step）归入幅度类，逐类累计
 * commit/rollback；后续同类调整的幅度先验因子 = 贝叶斯平滑成功率 /
 * target（<1 收缩 / >1 放宽，区间 [minFactor, maxFactor]）。
 * 零试验恒 1（冷启动零漂移，不预设立场）。
 */
class AmplitudeMetaLearner {
  private bands = new Map<AmplitudeBand, { trials: number; commits: number }>();

  constructor(private cfg: Required<AmplitudeMetaLearnConfig>) {}

  /** 幅度倍率 → 幅度类（≤0.6 tentative / ≤1.0 standard / >1.0 aggressive；边界含 1e-9 容差防浮点噪声换带） */
  static bandOfRatio(ratio: number): AmplitudeBand {
    if (ratio <= 0.6 + 1e-9) return 'tentative';
    if (ratio <= 1.0 + 1e-9) return 'standard';
    return 'aggressive';
  }

  /** 判定入账（commit/rollback → 该幅度类的成功率更新） */
  record(band: AmplitudeBand, committed: boolean): void {
    const b = this.bands.get(band) ?? { trials: 0, commits: 0 };
    b.trials += 1;
    if (committed) b.commits += 1;
    this.bands.set(band, b);
  }

  /**
   * 幅度先验因子：贝叶斯平滑成功率 / target。
   * p = (commits + w) / (trials + 2w)（Beta(w, w) 平滑）；零试验 = 1。
   */
  factorFor(band: AmplitudeBand): { factor: number; trials: number; smoothed: number } {
    const b = this.bands.get(band);
    if (!b || b.trials === 0) return { factor: 1, trials: 0, smoothed: 0.5 };
    const w = this.cfg.priorWeight;
    const smoothed = (b.commits + w) / (b.trials + 2 * w);
    const factor = Math.max(this.cfg.minFactor, Math.min(this.cfg.maxFactor, smoothed / this.cfg.target));
    return { factor: Number(factor.toFixed(4)), trials: b.trials, smoothed };
  }

  /** 面板快照（getState 用） */
  panel(): Array<{ band: AmplitudeBand; trials: number; commits: number; successRate: number; factor: number }> {
    return (['tentative', 'standard', 'aggressive'] as const).map((band) => {
      const b = this.bands.get(band) ?? { trials: 0, commits: 0 };
      return {
        band,
        trials: b.trials,
        commits: b.commits,
        successRate: b.trials > 0 ? b.commits / b.trials : 0,
        factor: this.factorFor(band).factor,
      };
    });
  }

  dump(): Record<string, { trials: number; commits: number }> {
    return Object.fromEntries([...this.bands.entries()].map(([band, b]) => [band, { ...b }]));
  }

  load(data: Record<string, { trials: number; commits: number }> | undefined): void {
    if (!data || typeof data !== 'object') return;
    for (const band of ['tentative', 'standard', 'aggressive'] as const) {
      const b = data[band];
      if (b && typeof b.trials === 'number' && typeof b.commits === 'number') {
        this.bands.set(band, { trials: b.trials, commits: b.commits });
      }
    }
  }
}

// ─────────────────────────── 元认知控制器 ───────────────────────────

/**
 * 元认知控制器（implements IMetaCognitiveController）
 *
 * 被编排层持有：autonomy-loop 低频触发 evaluateAndAdjust（每 N 轮心跳），
 * 也可经 meta_cognition_* Tool 手动触发/审查/接管。
 */
export class MetaCognitiveController {
  private config: Required<
    Omit<
      MetaControllerConfig,
      'persistPath' | 'onAdjust' | 'onRollback' | 'onCommit' | 'stabilityLoop' | 'certificateGate' | 'clock' | 'cognitiveLoad' | 'amplitudeMetaLearn'
    >
  > &
    Pick<
      MetaControllerConfig,
      'persistPath' | 'onAdjust' | 'onRollback' | 'onCommit' | 'stabilityLoop' | 'certificateGate' | 'clock' | 'cognitiveLoad' | 'amplitudeMetaLearn'
    >;
  private selfModel: SelfModel;
  private knobs: Map<string, AdjustmentKnob> = new Map();
  private audit: AuditEntry[] = [];
  private pending?: PendingAdjustment;
  private frozen = false;
  private manuallyFrozenKnobs = new Set<string>();
  /** 已被回滚过的 adjust 审计 id（手动回滚去重） */
  private rolledBackAdjustIds = new Set<string>();
  private counters = { adjustments: 0, rollbacks: 0, commits: 0 };
  private auditSeq = 0;
  // ── 2.0：学习 / 安全 / 稳态 ──
  /** 调参策略学习器（乐观先验 Bandit） */
  private learner = new AdjustmentLearner();
  /** 安全包络：各旋钮的已验证好取值 / 已知劣化取值 */
  private envelopeGood = new Map<string, number[]>();
  private envelopeBad = new Map<string, number[]>();
  /** 熔断器：单旋钮连续自动回滚计数与已熔断旋钮 */
  private breakerCounters = new Map<string, number>();
  private trippedBreakers = new Set<string>();
  /** 全局连续自动回滚计数（跨旋钮） */
  private globalRollbackStreak = 0;
  /** 全局熔断标记（区别于手动 frozen） */
  private frozenByBreaker = false;
  // ── 3.0：死区稳定环 / 证书门 / 冲突仲裁 ──
  /** 3.0：稳定环参数（构造时定格；undefined = 未启用） */
  private stability?: Required<Pick<StabilityLoopConfig, 'deadbandDeviation' | 'rampStart' | 'rampIncrement' | 'cooldownReports'>> &
    Pick<StabilityLoopConfig, 'knobAffect'>;
  /** 3.0：证书门参数（构造时定格；undefined = 未启用） */
  private certGate?: Required<CertificateGateConfig>;
  /** 3.0：各旋钮的同向连续调整计数（斜坡位置；方向翻转重置） */
  private directionStreaks = new Map<string, { direction: 'up' | 'down'; count: number }>();
  /** 3.0：方向翻转计数（震荡探测） */
  private directionFlips = 0;
  /** 3.0：死区跳过 / 冷却跳过 / 斜坡生效调整计数 */
  private deadbandSkips = 0;
  private cooldownSkips = 0;
  private rampedAdjustments = 0;
  /** 3.0：判定后的剩余冷却报告数 */
  private cooldownLeft = 0;
  /** 3.0：我们上次写入后的旋钮值（外部改写检测基线） */
  private lastWrittenByUs = new Map<string, number>();
  /** 3.0：外部写入者报告的待仲裁旋钮（下次接触时计数冲突） */
  private driftSuspected = new Set<string>();
  /** 3.0：冲突仲裁计数 */
  private conflictCount = 0;
  private arbitratedCount = 0;
  private lastConflict?: { knob: string; winner: string; at: number };
  /** 3.0：证书门裁决面板（每臂最近一次） */
  private certificateDecisions = new Map<string, { mode: 'full' | 'provisional' | 'rejected'; lcb?: number; samples: number }>();
  private certificateCounters = { full: 0, provisional: 0, rejected: 0 };
  // ── 4.0：认知负荷门 / 幅度元学习 ──
  /** 4.0：认知负荷参数（构造时定格；undefined = 未启用） */
  private loadGate?: Required<CognitiveLoadConfig>;
  /** 4.0：在观实验登记表（其他子系统的实验占认知带宽） */
  private activeExperiments = new Set<string>();
  /** 4.0：在跟踪 KPI 数（心智报告口径的观测面宽度） */
  private trackedKpiCount = 0;
  /** 4.0：负荷门拦截计数 */
  private gateSkips = 0;
  /** 4.0：最近见到的心智报告序号（负荷窗的时间轴） */
  private lastReportIndex = 0;
  /** 4.0：幅度元学习器（未启用 undefined） */
  private ampLearner?: AmplitudeMetaLearner;

  constructor(params: { selfModel: SelfModel; knobs: AdjustmentKnob[]; config?: MetaControllerConfig }) {
    this.config = {
      maxAdjustmentsPerRound: 1,
      observationReports: 2,
      degradationTolerance: 0.02,
      auditLimit: 200,
      homeostasisBands: {},
      maxStepMultiplier: 3,
      breakerThreshold: 2,
      globalBreakerThreshold: 3,
      proactiveEnabled: true,
      ...params.config,
    };
    this.selfModel = params.selfModel;
    for (const knob of params.knobs) this.knobs.set(knob.id, knob);
    // 3.0：稳定环 / 证书门参数定格（提供对象即启用；缺省值见 StabilityLoopConfig）
    if (params.config?.stabilityLoop) {
      const sl = params.config.stabilityLoop;
      this.stability = {
        deadbandDeviation: sl.deadbandDeviation ?? 0.25,
        rampStart: sl.rampStart ?? 0.5,
        rampIncrement: sl.rampIncrement ?? 0.25,
        cooldownReports: sl.cooldownReports ?? 1,
        knobAffect: sl.knobAffect,
      };
    }
    if (params.config?.certificateGate) {
      const cg = params.config.certificateGate;
      this.certGate = {
        delta: Number.isFinite(cg.delta) ? cg.delta! : 0.1,
        minSamples: Math.max(2, Math.floor(cg.minSamples ?? 4)),
      };
    }
    // 4.0：认知负荷门 / 幅度元学习参数定格（提供对象即启用）
    if (params.config?.cognitiveLoad) {
      const cl = params.config.cognitiveLoad;
      this.loadGate = {
        flightWindowReports: Math.max(1, Math.floor(cl.flightWindowReports ?? 4)),
        adjustmentWeight: Number.isFinite(cl.adjustmentWeight) ? cl.adjustmentWeight! : 1,
        experimentWeight: Number.isFinite(cl.experimentWeight) ? cl.experimentWeight! : 1,
        kpiWeight: Number.isFinite(cl.kpiWeight) ? cl.kpiWeight! : 0.1,
        maxLoad: Number.isFinite(cl.maxLoad) ? cl.maxLoad! : 2,
      };
    }
    if (params.config?.amplitudeMetaLearn) {
      const am = params.config.amplitudeMetaLearn;
      this.ampLearner = new AmplitudeMetaLearner({
        target: Number.isFinite(am.target) ? am.target! : 0.6,
        minFactor: Number.isFinite(am.minFactor) ? am.minFactor! : 0.25,
        maxFactor: Number.isFinite(am.maxFactor) ? am.maxFactor! : 1.5,
        priorWeight: Number.isFinite(am.priorWeight) ? am.priorWeight! : 1,
      });
    }
    this.restore();
  }

  /** 3.0：统一时钟（注入时钟优先；缺省 wall-clock，行为不变） */
  private now(): number {
    return this.config.clock ? this.config.clock() : Date.now();
  }

  // ── IMetaCognitiveController 实现 ──

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
   *
   * 3.0：候选再 ∪ 稳定环 homeostatic 候选；应用前过证书门
   * （89.0 视图 LCB>0 全幅 / 视图不可用保守半步 + 严格判定）；
   * 死区 + 斜坡 + 冷却三重阻尼；观察期内旋钮被外部改写 → 冲突仲裁
   * （最后写入者胜，观察作废）。
   */
  async evaluateAndAdjust(): Promise<AdjustmentReport> {
    const report = await this.selfModel.generateMentalReport();
    this.lastReportIndex = report.reportIndex; // 4.0：负荷窗时间轴推进

    // ── 1. 观察窗判定优先 ──
    if (this.pending) {
      // 3.0：冲突仲裁——观察期内旋钮被外部（内环调参器/人工/其他实例）改写
      const observedKnob = this.knobs.get(this.pending.knob);
      const externallyTouched =
        observedKnob !== undefined &&
        (this.driftSuspected.has(this.pending.knob) || observedKnob.read() !== this.pending.to);
      if (observedKnob && externallyTouched) {
        const winner = this.driftSuspected.delete(this.pending.knob) ? '外部写入者（已报告）' : '外部写入者（未报告，读数检测）';
        const entry = this.appendAudit({
          type: 'conflict-arbitration',
          knob: this.pending.knob,
          from: this.pending.to,
          to: observedKnob.read(),
          reason: `观察中的调整（${this.pending.from} → ${this.pending.to}）在观察期内被外部改写为 ${observedKnob.read()}：最后写入者胜，本观察作废不判定`,
        });
        this.conflictCount += 1;
        this.arbitratedCount += 1;
        this.lastConflict = { knob: this.pending.knob, winner, at: entry.timestamp };
        this.lastWrittenByUs.delete(this.pending.knob);
        this.pending = undefined;
        this.persist();
        return this.buildReport('no-op', report, {
          skippedReason: `冲突仲裁：旋钮 ${entry.knob} 观察期内被外部改写（${entry.from} → ${entry.to}），最后写入者胜，观察作废`,
        });
      }
      this.pending.reportsSeen += 1;
      if (this.pending.reportsSeen < this.pending.reportsNeeded) {
        return this.buildReport('observing', report, {
          observation: {
            knob: this.pending.knob,
            reportsSeen: this.pending.reportsSeen,
            reportsNeeded: this.pending.reportsNeeded,
          },
        });
      }
      const verdict = this.judge(this.pending, report);
      const knob = this.knobs.get(this.pending.knob);
      const direction = this.pending.direction ?? 'up';
      const source = this.pending.source;
      if (verdict.good || !knob) {
        // 保留生效：未劣化（或小幅波动在容忍内）且护栏未违反
        const entry = this.appendAudit({
          type: 'commit',
          knob: this.pending.knob,
          from: this.pending.from,
          to: this.pending.to,
          reason: `观察 ${this.pending.reportsNeeded} 份报告：${verdict.detail}，调整保留生效`,
          effect: verdict.effect,
          guardrail: verdict.guardrail,
          source,
          reportIndex: report.reportIndex,
        });
        this.counters.commits += 1;
        // 2.0：学习器记录成功 + 包络收录好值 + 熔断器计数复位
        this.learner.record(this.pending.knob, direction, this.pending.judgeMetric, true, verdict.effect.delta);
        // 4.0：幅度元学习入账（该幅度类 +1 成功）
        if (this.ampLearner && this.pending.amplitudeBand) this.ampLearner.record(this.pending.amplitudeBand, true);
        this.recordGoodValue(this.pending.knob, this.pending.to);
        this.onJudgedCommit(this.pending.knob);
        this.config.onCommit?.(entry);
        const result = this.buildReport('committed', report, {
          committed: { knob: this.pending.knob, effect: verdict.effect },
        });
        this.pending = undefined;
        this.enterCooldown();
        this.persist();
        return result;
      }
      // 自动回滚：劣化超容忍或护栏违反
      let rolledBackTo = this.pending.to;
      try {
        knob.write(this.pending.from);
        rolledBackTo = this.pending.from;
        this.lastWrittenByUs.set(this.pending.knob, this.pending.from);
      } catch {
        /* 写回失败保留审计记录，下轮重试判定 */
      }
      const entry = this.appendAudit({
        type: 'rollback',
        knob: this.pending.knob,
        from: this.pending.to,
        to: rolledBackTo,
        reason: `观察期判定劣化（${verdict.detail}），自动回滚参数`,
        effect: verdict.effect,
        guardrail: verdict.guardrail,
        source,
        reportIndex: report.reportIndex,
      });
      this.counters.rollbacks += 1;
      this.rolledBackAdjustIds.add(this.pending.adjustAuditId ?? '');
      // 2.0：学习器记录失败 + 包络标记劣化值 + 熔断器计数推进
      this.learner.record(this.pending.knob, direction, this.pending.judgeMetric, false, verdict.effect.delta);
      // 4.0：幅度元学习入账（该幅度类 +1 翻车）
      if (this.ampLearner && this.pending.amplitudeBand) this.ampLearner.record(this.pending.amplitudeBand, false);
      this.recordBadValue(this.pending.knob, this.pending.to);
      this.onJudgedRollback(this.pending.knob);
      this.config.onRollback?.(entry);
      const result = this.buildReport('rolled-back', report, {
        rolledBack: {
          knob: this.pending.knob,
          from: this.pending.to,
          to: rolledBackTo,
          reason: entry.reason,
          effect: verdict.effect,
        },
      });
      this.pending = undefined;
      this.enterCooldown();
      this.persist();
      return result;
    }

    // ── 2. 冻结检查（手动冻结 或 全局熔断） ──
    if (this.frozen) {
      return this.buildReport('frozen', report, { skippedReason: '自动调整已被手动冻结（setFrozen）' });
    }
    if (this.frozenByBreaker) {
      return this.buildReport('frozen', report, {
        skippedReason: `连续 ${this.config.globalBreakerThreshold} 次自动回滚触发全局熔断（reArmBreaker 可复位）`,
      });
    }

    // ── 2.5 3.0：判定后冷却期（给被调系统留出暂态消退时间，防背靠背调整） ──
    if (this.stability && this.cooldownLeft > 0) {
      this.cooldownLeft -= 1;
      this.cooldownSkips += 1;
      return this.buildReport('no-op', report, {
        skippedReason: `稳定环冷却期：上次判定后还需观察 ${this.cooldownLeft + 1} 份报告才可再次调整`,
      });
    }

    // ── 2.7 4.0：认知负荷门（同时调太多 → 效果不可归因 → 暂停新调整） ──
    const load = this.computeCognitiveLoad(report.reportIndex);
    if (load && load.load > this.loadGate!.maxLoad) {
      this.gateSkips += 1;
      const reason = `认知负荷 ${load.load.toFixed(2)} > 上限 ${this.loadGate!.maxLoad}：在调旋钮 ${load.activeAdjustments}×${this.loadGate!.adjustmentWeight} + 在观实验 ${load.activeExperiments}×${this.loadGate!.experimentWeight} + 跟踪 KPI ${load.trackedKpis}×${this.loadGate!.kpiWeight}——暂停新调整防归因混淆（观察窗判定照常推进）`;
      this.appendAudit({ type: 'load-gate', reason, reportIndex: report.reportIndex });
      return this.buildReport('no-op', report, { skippedReason: reason });
    }

    // ── 3. 构建候选（反应式推荐 ∪ 前瞻风险建议 ∪ 稳定环稳态候选）──
    const candidates: Array<RecommendedAdjustment & { source: 'reactive' | 'proactive' | 'homeostatic' }> =
      report.recommendedAdjustments
        .filter((r) => this.knobs.has(r.knob) && !this.manuallyFrozenKnobs.has(r.knob) && !this.trippedBreakers.has(r.knob))
        .map((r) => ({ ...r, source: 'reactive' as const }));

    if (this.config.proactiveEnabled && report.proactiveRisks) {
      for (const risk of report.proactiveRisks) {
        const knob = this.knobs.get(risk.suggestedKnob);
        if (!knob) continue;
        if (this.manuallyFrozenKnobs.has(knob.id) || this.trippedBreakers.has(knob.id)) continue;
        if (candidates.some((c) => c.knob === knob.id && c.direction === risk.suggestedDirection)) continue;
        candidates.push({
          knob: knob.id,
          label: knob.label,
          direction: risk.suggestedDirection,
          reason: `[前瞻] ${risk.description}，在指标仍健康时提前调整`,
          priority: risk.urgency,
          source: 'proactive',
        });
      }
    }

    // 3.0：稳定环 homeostatic 候选（稳态带偏离越过死区 → 朝带内方向调整）
    for (const candidate of this.stabilityCandidates(report)) {
      if (candidates.some((c) => c.knob === candidate.knob && c.direction === candidate.direction)) continue;
      candidates.push(candidate);
    }

    if (candidates.length === 0) {
      const tripped = [...this.trippedBreakers];
      return this.buildReport('no-op', report, {
        skippedReason:
          tripped.length > 0
            ? `无可用候选（推荐旋钮被手动接管或已熔断：${tripped.join('、')}）`
            : '无匹配旋钮或全部被手动接管',
      });
    }

    // 2.0：学习器排序（规则优先级 × 学习有效性；冷启动臂退化为规则优先级 → 行为向后兼容）
    candidates.sort(
      (a, b) =>
        this.learner.selectionScore(b.priority, b.knob, b.direction, this.knobs.get(b.knob)!.judgeMetric) -
        this.learner.selectionScore(a.priority, a.knob, a.direction, this.knobs.get(a.knob)!.judgeMetric),
    );

    // ── 4. 保守应用一个调整（死区 + 斜坡 + 证书门 + 安全包络） ──
    const applied: AdjustmentReport['applied'] = [];
    for (const rec of candidates) {
      if (applied.length >= this.config.maxAdjustmentsPerRound) break;
      const knob = this.knobs.get(rec.knob)!;
      const current = knob.read();
      const direction = rec.direction === 'up' ? 1 : -1;

      // 3.0：冲突仲裁（应用路径）——上次写入后旋钮被外部改写 → 最后写入者胜：
      // 外部当前值即为新基线（本次调整从它出发），冲突计数 + 审计
      this.arbitrateIfDrifted(knob, current);

      // 3.0：死区——判定指标偏离带但未越过死区半宽 → 判为噪声，不调整
      const deadbandSkip = this.deadbandBlocks(knob, report);
      if (deadbandSkip) {
        this.deadbandSkips += 1;
        continue;
      }

      // 2.0：稳态自适应步长——判定指标偏离目标带越远步长越大（量化档位）
      const stepMultiplier = this.stepMultiplierFor(knob, report);
      // 3.0：斜坡——新方向首调只走 rampStart 比例，同向连续逐步升幅（翻转重置）
      const rampFactor = this.rampFactorFor(knob.id, rec.direction);
      let next = current + direction * knob.step * stepMultiplier * rampFactor;

      // 3.0：调整证书门（89.0 视图）——LCB>0 全幅放行 / 视图不可用保守半步 / LCB≤0 拒绝
      const certificate = this.certificateDecisionFor(knob, rec.direction);
      if (certificate.mode === 'rejected') {
        this.appendAudit({
          type: 'certificate-reject',
          knob: knob.id,
          from: current,
          to: current + direction * knob.step * stepMultiplier * rampFactor,
          reason: `证书门拒绝：${knob.id} ${rec.direction === 'up' ? '↑' : '↓'} 的历史效果 LCB=${certificate.lcb?.toFixed(4)} ≤ 0（${certificate.samples} 配对样本，δ=${this.certGate?.delta}）——「假改进」嫌疑，不放行`,
          source: rec.source,
          reportIndex: report.reportIndex,
          certificate: { mode: 'rejected', lcb: certificate.lcb, samples: certificate.samples, delta: this.certGate?.delta },
        });
        continue;
      }
      if (certificate.mode === 'provisional') {
        // 保守半步：幅度减半 + 严格判定观察窗（无明确改善即自动回滚）
        next = current + direction * knob.step * stepMultiplier * rampFactor * 0.5;
      }

      // 4.0：幅度先验因子（元学习）——同类幅度历史成功率 → 后续幅度收缩/放宽。
      // 因子恒 1（未启用 / 零试验）时不触碰 next（浮点逐位不变，零漂移）。
      let amplitudeInfo: { band: AmplitudeBand; factor: number; trials: number } | undefined;
      if (this.ampLearner) {
        const band = AmplitudeMetaLearner.bandOfRatio(Math.abs(next - current) / knob.step);
        const { factor, trials } = this.ampLearner.factorFor(band);
        amplitudeInfo = { band, factor, trials };
        if (factor !== 1) next = current + (next - current) * factor;
      }

      next = knob.integer ? Math.round(next) : Number(next.toFixed(6));

      // 2.0：安全包络钳制（经验学习的安全区间优先于旋钮原始边界）
      const envelope = this.envelopeOf(knob);
      next = Math.max(envelope.min, Math.min(envelope.max, next));
      if (knob.integer) next = Math.round(next);

      if (next === current) continue; // 已到边界/包络缘，换下一个候选
      if (this.isKnownBadValue(knob, next)) continue; // 已知劣化取值，预防性跳过

      try {
        knob.write(next);
      } catch {
        continue;
      }
      this.lastWrittenByUs.set(knob.id, next);
      this.updateDirectionStreak(knob.id, rec.direction, rampFactor);

      const entry = this.appendAudit({
        type: 'adjust',
        knob: knob.id,
        from: current,
        to: next,
        reason:
          certificate.mode === 'provisional'
            ? `${rec.reason}（证书门视图不可用：${certificate.samples}/${this.certGate?.minSamples} 样本 → 保守半步 + 严格判定）`
            : rec.reason,
        source: rec.source,
        reportIndex: report.reportIndex,
        certificate:
          this.certGate !== undefined
            ? { mode: certificate.mode, lcb: certificate.lcb, samples: certificate.samples, delta: this.certGate.delta }
            : undefined,
        amplitude: amplitudeInfo,
      });
      this.counters.adjustments += 1;
      this.config.onAdjust?.(entry);

      applied.push({
        knob: knob.id,
        label: knob.label,
        from: current,
        to: next,
        reason: rec.reason,
        source: rec.source,
        certificate:
          this.certGate !== undefined
            ? { mode: certificate.mode, lcb: certificate.lcb, samples: certificate.samples }
            : undefined,
        amplitude: amplitudeInfo,
      });
      this.pending = {
        knob: knob.id,
        from: current,
        to: next,
        reason: rec.reason,
        reportsSeen: 0,
        reportsNeeded: this.config.observationReports,
        judgeMetric: knob.judgeMetric,
        higherIsBetter: knob.higherIsBetter,
        baselineMetricValue: this.extractMetric(report, knob.judgeMetric),
        baselineMetrics: this.snapshotAllMetrics(report),
        direction: rec.direction,
        source: rec.source,
        appliedAt: this.now(),
        adjustAuditId: entry.id,
        provisional: certificate.mode === 'provisional' || undefined,
        // 3.0：稳定环候选携带稳态带判定口径（judge 按带距离缩减量判改善）
        bandJudged:
          rec.source === 'homeostatic' ? this.config.homeostasisBands[knob.judgeMetric] : undefined,
        // 4.0：本次调整的幅度类（与因子决策同带——学习的是「提出这类幅度
        // 的策略」的成败；因子只是对该类策略的力度调制）
        amplitudeBand: amplitudeInfo?.band,
      };
      break; // 保守原则：一轮只调一个
    }

    if (applied.length === 0) {
      return this.buildReport('no-op', report, { skippedReason: '推荐旋钮均已到达边界或命中已知劣化值，无可应用调整' });
    }

    this.persist();
    return this.buildReport('adjusted', report, {
      applied,
      observation: {
        knob: this.pending!.knob,
        reportsSeen: 0,
        reportsNeeded: this.pending!.reportsNeeded,
      },
    });
  }

  /**
   * 手动回滚最近一次调整
   *
   * 优先回滚观察窗中的调整；无观察中调整时回滚最近一次已提交
   * （未被回滚过）的调整。全部审计留痕。
   */
  async rollbackLastAdjustment(): Promise<RollbackResult> {
    // 路径 1：观察窗中的调整
    if (this.pending) {
      const knob = this.knobs.get(this.pending.knob);
      const { knob: knobId, from, to, reason } = this.pending;
      if (!knob) {
        this.pending = undefined;
        return { success: false, reason: '旋钮未注册', message: `旋钮 ${knobId} 未注册，仅清除观察状态` };
      }
      try {
        knob.write(from);
      } catch (error) {
        return { success: false, knob: knobId, reason: '写回失败', message: `回滚写回失败：${(error as Error).message}` };
      }
      const entry = this.appendAudit({
        type: 'rollback',
        knob: knobId,
        from: to,
        to: from,
        reason: `手动回滚观察中的调整（原调整理由：${reason}）`,
      });
      this.counters.rollbacks += 1;
      if (this.pending.adjustAuditId) this.rolledBackAdjustIds.add(this.pending.adjustAuditId);
      this.pending = undefined;
      this.persist();
      this.config.onRollback?.(entry);
      return {
        success: true,
        knob: knobId,
        from: to,
        to: from,
        reason: '手动回滚观察中的调整',
        message: `旋钮 ${knobId} 已从 ${to} 回滚到 ${from}`,
      };
    }

    // 路径 2：最近一次已提交且未回滚过的调整
    for (let i = this.audit.length - 1; i >= 0; i -= 1) {
      const entry = this.audit[i];
      if (entry.type !== 'adjust' && entry.type !== 'commit') continue;
      if (entry.type === 'commit') {
        // commit 引用的原 adjust 已记录；继续向前找对应 adjust
        continue;
      }
      if (entry.knob === undefined || entry.to === undefined || entry.from === undefined) continue;
      if (this.rolledBackAdjustIds.has(entry.id)) continue;
      const knob = this.knobs.get(entry.knob);
      if (!knob) continue;
      try {
        knob.write(entry.from);
      } catch (error) {
        return {
          success: false,
          knob: entry.knob,
          reason: '写回失败',
          message: `回滚写回失败：${(error as Error).message}`,
        };
      }
      this.rolledBackAdjustIds.add(entry.id);
      const rollbackEntry = this.appendAudit({
        type: 'rollback',
        knob: entry.knob,
        from: entry.to,
        to: entry.from,
        reason: `手动回滚已提交的调整（原调整理由：${entry.reason}）`,
      });
      this.counters.rollbacks += 1;
      this.persist();
      this.config.onRollback?.(rollbackEntry);
      return {
        success: true,
        knob: entry.knob,
        from: entry.to,
        to: entry.from,
        reason: '手动回滚已提交的调整',
        message: `旋钮 ${entry.knob} 已从 ${entry.to} 回滚到 ${entry.from}`,
      };
    }

    return { success: false, reason: '无可回滚的调整', message: '审计日志中不存在未回滚的调整记录' };
  }

  // ── 手动接管（优先于自动调整） ──

  /** 手动覆盖旋钮值：写入后该旋钮冻结自动调整（人工优先） */
  setManualOverride(knobId: string, value: number): RollbackResult {
    const knob = this.knobs.get(knobId);
    if (!knob) return { success: false, reason: '旋钮未注册', message: `旋钮 ${knobId} 不存在` };
    const from = knob.read();
    const clamped = Math.max(knob.min, Math.min(knob.max, knob.integer ? Math.round(value) : value));
    try {
      knob.write(clamped);
    } catch (error) {
      return { success: false, knob: knobId, reason: '写入失败', message: `手动覆盖失败：${(error as Error).message}` };
    }
    this.manuallyFrozenKnobs.add(knobId);
    // 若观察中的正是该旋钮 → 撤销观察（人工已接管）
    if (this.pending?.knob === knobId) this.pending = undefined;
    const entry = this.appendAudit({
      type: 'manual-override',
      knob: knobId,
      from,
      to: clamped,
      reason: `手动覆盖取值（自动调整已对该旋钮冻结）`,
    });
    this.persist();
    void entry;
    return {
      success: true,
      knob: knobId,
      from,
      to: clamped,
      reason: '手动覆盖',
      message: `旋钮 ${knobId} 已手动设为 ${clamped}（原值 ${from}），该旋钮自动调整已冻结`,
    };
  }

  /** 解除旋钮的手动接管（恢复自动调整资格） */
  clearManualOverride(knobId: string): boolean {
    const removed = this.manuallyFrozenKnobs.delete(knobId);
    if (removed) {
      this.appendAudit({ type: 'freeze', knob: knobId, reason: '解除手动接管，恢复自动调整' });
      this.persist();
    }
    return removed;
  }

  /** 全局冻结 / 解冻自动调整 */
  setFrozen(frozen: boolean): void {
    this.frozen = frozen;
    if (frozen && this.pending) {
      // 冻结时保留 pending 状态（解冻后继续观察），仅阻断新调整
    }
    this.appendAudit({ type: 'freeze', reason: frozen ? '全局冻结自动调整（手动接管）' : '解除全局冻结' });
    this.persist();
  }

  /** 运行状态（meta_cognition_status Tool / 审查入口） */
  getState(): MetaControllerState {
    const effectiveness = this.learner.effectiveness();
    return {
      frozen: this.frozen,
      manuallyFrozenKnobs: [...this.manuallyFrozenKnobs],
      circuitBreakers: this.breakerPanel(),
      frozenByBreaker: this.frozenByBreaker,
      learner: {
        totalTrials: this.learner.totalTrials,
        arms: effectiveness.length,
        explorationWeight: this.learner.averageConfidenceWeight(),
        effectiveness,
      },
      safeEnvelopes: [...this.knobs.values()].map((k) => this.envelopeOf(k)),
      pending: this.pending
        ? {
            knob: this.pending.knob,
            from: this.pending.from,
            to: this.pending.to,
            reason: this.pending.reason,
            reportsSeen: this.pending.reportsSeen,
            reportsNeeded: this.pending.reportsNeeded,
            judgeMetric: this.pending.judgeMetric,
            baselineMetricValue: this.pending.baselineMetricValue,
          }
        : undefined,
      knobs: [...this.knobs.values()].map((k) => ({
        id: k.id,
        label: k.label,
        category: k.category,
        current: k.read(),
        min: k.min,
        max: k.max,
        step: k.step,
        manuallyFrozen: this.manuallyFrozenKnobs.has(k.id),
        breakerTripped: this.trippedBreakers.has(k.id),
      })),
      auditTrail: [...this.audit],
      totalAdjustments: this.counters.adjustments,
      totalRollbacks: this.counters.rollbacks,
      totalCommits: this.counters.commits,
      // 3.0：稳定环统计（未启用稳定环时 undefined）
      stability: this.stability
        ? {
            deadbandSkips: this.deadbandSkips,
            cooldownSkips: this.cooldownSkips,
            directionFlips: this.directionFlips,
            rampedAdjustments: this.rampedAdjustments,
            streaks: [...this.directionStreaks.entries()].map(([knob, s]) => ({ knob, direction: s.direction, count: s.count })),
          }
        : undefined,
      // 3.0：证书门面板（未启用时 undefined）
      certificateGate: this.certGate
        ? {
            decisions: [...this.certificateDecisions.entries()].map(([key, d]) => {
              const [knob, direction] = key.split(':');
              return { knob, direction: direction === 'down' ? 'down' : 'up', mode: d.mode, lcb: d.lcb, samples: d.samples };
            }),
            rejected: this.certificateCounters.rejected,
            provisional: this.certificateCounters.provisional,
            full: this.certificateCounters.full,
          }
        : undefined,
      // 3.0：内外环冲突仲裁面板
      arbitration: {
        conflicts: this.conflictCount,
        arbitrated: this.arbitratedCount,
        lastConflict: this.lastConflict ? { ...this.lastConflict } : undefined,
      },
      // 4.0：认知负荷面板（未启用时 undefined）
      cognitiveLoad: this.cognitiveLoadView(),
      // 4.0：幅度元学习面板（未启用时 undefined）
      amplitudeLearning: this.ampLearner ? { bands: this.ampLearner.panel() } : undefined,
    };
  }

  /** 审计日志（全量，升序） */
  getAuditTrail(): AuditEntry[] {
    return [...this.audit];
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /**
   * 观察期满判定：劣化超容忍 → 回滚
   *
   * 2.0 综合判定护栏：目标指标未劣化但操作环成功率显著下滑 → 一律判失败。
   * 单指标优化不得以整体劣化为代价（guardrail violated → rollback）。
   */
  private judge(
    pending: PendingAdjustment,
    report: MentalReport,
  ): {
    good: boolean;
    effect: NonNullable<AuditEntry['effect']>;
    guardrail?: AuditEntry['guardrail'];
    detail: string;
  } {
    const after = this.extractMetric(report, pending.judgeMetric);
    const before = pending.baselineMetricValue;
    const delta = after - before;
    // 按指标方向归一：progress > 0 = 改善，< 0 = 劣化
    let progress = pending.higherIsBetter ? delta : -delta;
    // 3.0：稳态带判定口径——稳定环候选的「改善」= 离目标带更近
    //（带距离缩减量），而非原始指标的绝对升降
    let bandNote = '';
    if (pending.bandJudged) {
      const devBefore = computeHomeostasis(pending.bandJudged, before).deviation;
      const devAfter = computeHomeostasis(pending.bandJudged, after).deviation;
      progress = devBefore - devAfter;
      bandNote = `（稳态带口径：带距离 ${devBefore.toFixed(2)} → ${devAfter.toFixed(2)}）`;
    }
    // 3.0：保守半步（证书门视图不可用）执行严格标准——无明确改善即回滚；
    // 正常路径维持 2.0 口径（未劣化超容忍即保留）
    let good = pending.provisional
      ? progress > this.config.degradationTolerance
      : progress >= -this.config.degradationTolerance;
    const metricLabel = JUDGE_METRIC_LABELS[pending.judgeMetric];
    let detail = `${metricLabel} ${before.toFixed(4)} → ${after.toFixed(4)}（${progress >= 0 ? '改善' : '劣化'} ${Math.abs(progress).toFixed(4)}，${pending.provisional ? '严格口径：需改善超容忍才保留' : `容忍 ${this.config.degradationTolerance}`}）${bandNote}`;

    // 2.0：护栏——操作环成功率显著劣化则一票否决（判定指标本身即操作环成功率时跳过）
    let guardrail: AuditEntry['guardrail'] | undefined;
    if (pending.baselineMetrics && pending.judgeMetric !== 'operationalSuccessRate') {
      const grBefore = pending.baselineMetrics.operationalSuccessRate;
      const grAfter = this.extractMetric(report, 'operationalSuccessRate');
      const violated = grAfter < grBefore - this.config.degradationTolerance;
      guardrail = {
        metric: 'operationalSuccessRate',
        before: grBefore,
        after: grAfter,
        delta: grAfter - grBefore,
        violated,
      };
      if (violated) {
        good = false;
        detail += `；护栏违规：操作环成功率 ${grBefore.toFixed(4)} → ${grAfter.toFixed(4)}（劣化 ${(grBefore - grAfter).toFixed(4)}）`;
      }
    }

    return {
      good,
      effect: {
        metric: pending.judgeMetric,
        before,
        after,
        delta,
        good,
      },
      guardrail,
      detail,
    };
  }

  /** 全指标基线快照（护栏综合判定的 before 数据） */
  private snapshotAllMetrics(report: MentalReport): Record<JudgeMetric, number> {
    return {
      operationalSuccessRate: this.extractMetric(report, 'operationalSuccessRate'),
      discoveryRate: this.extractMetric(report, 'discoveryRate'),
      proceduralGrowth: this.extractMetric(report, 'proceduralGrowth'),
      pendingDistillation: this.extractMetric(report, 'pendingDistillation'),
      survivalRate: this.extractMetric(report, 'survivalRate'),
    };
  }

  // ── 2.0：稳态自适应步长 ──

  /**
   * 稳态步长倍率（1~maxStepMultiplier）：
   * 判定指标配置了目标带 → 偏离带越远倍率越大（比例控制，量化档位）；
   * 未配置目标带 → 1（行为与 1.0 固定步长一致）。
   */
  private stepMultiplierFor(knob: AdjustmentKnob, report: MentalReport): number {
    const band = this.config.homeostasisBands[knob.judgeMetric];
    if (!band) return 1;
    const current = this.extractMetric(report, knob.judgeMetric);
    const { deviation } = computeHomeostasis(band, current);
    if (deviation <= 0) return 1; // 带内 / 贴边：标准步长
    const raw = 1 + deviation * 2; // 偏离 50% → ×2；≥100% → ×3
    return Math.max(1, Math.min(Math.ceil(raw), this.config.maxStepMultiplier));
  }

  // ─────────────────── 3.0：死区稳定环 / 证书门 / 冲突仲裁 ───────────────────

  /**
   * 3.0：判定冷却（commit/rollback 后进入冷却期——背靠背调整会互相
   * 污染对方的观察窗，先让暂态消退）。未启用稳定环时无冷却（零漂移）。
   */
  private enterCooldown(): void {
    if (this.stability) this.cooldownLeft = this.stability.cooldownReports;
  }

  /**
   * 3.0：死区判定——旋钮的判定指标配置了目标带、且当前偏离为正但
   * 未越过死区半宽 → 判为测量噪声，阻止本候选。
   * （偏离 ≤ 0 在带内本就不会有稳定环候选；规则候选带内也尊重死区。）
   */
  private deadbandBlocks(knob: AdjustmentKnob, report: MentalReport): boolean {
    if (!this.stability) return false;
    const band = this.config.homeostasisBands[knob.judgeMetric];
    if (!band) return false; // 无带可依 → 无法计算偏离 → 不阻止（保持 2.0 行为）
    const current = this.extractMetric(report, knob.judgeMetric);
    const { deviation } = computeHomeostasis(band, current);
    return deviation > 0 && deviation <= this.stability.deadbandDeviation;
  }

  /**
   * 3.0：斜坡因子——同向连续调整逐步升幅，方向翻转/首次重置到起点。
   * rampStart=1 且 rampIncrement=0 时恒为 1（退化为 2.0 全幅步长）。
   */
  private rampFactorFor(knobId: string, direction: 'up' | 'down'): number {
    if (!this.stability) return 1;
    const streak = this.directionStreaks.get(knobId);
    const count = streak && streak.direction === direction ? streak.count : 0;
    return Math.min(1, this.stability.rampStart + count * this.stability.rampIncrement);
  }

  /** 3.0：调整落地后更新同向计数（翻转即重置并计数一次方向翻转） */
  private updateDirectionStreak(knobId: string, direction: 'up' | 'down', rampFactor: number): void {
    if (!this.stability) return;
    const streak = this.directionStreaks.get(knobId);
    if (streak && streak.direction !== direction) this.directionFlips += 1;
    this.directionStreaks.set(
      knobId,
      streak && streak.direction === direction ? { direction, count: streak.count + 1 } : { direction, count: 1 },
    );
    if (rampFactor < 1) this.rampedAdjustments += 1;
  }

  /**
   * 3.0：稳定环 homeostatic 候选——稳态带偏离越过死区 → 朝带内方向的
   * 系统性候选（不依赖心智报告的规则推荐；方向由 knobAffect 影响方向表
   * 与指标偏离侧联合决定）。未启用稳定环 / 无方向表 / 带内 → 空数组。
   */
  private stabilityCandidates(report: MentalReport): Array<RecommendedAdjustment & { source: 'homeostatic' }> {
    if (!this.stability?.knobAffect) return [];
    const candidates: Array<RecommendedAdjustment & { source: 'homeostatic' }> = [];
    for (const knob of this.knobs.values()) {
      if (this.manuallyFrozenKnobs.has(knob.id) || this.trippedBreakers.has(knob.id)) continue;
      const affect = this.stability.knobAffect[knob.id];
      if (!affect) continue;
      const band = this.config.homeostasisBands[knob.judgeMetric];
      if (!band) continue;
      const current = this.extractMetric(report, knob.judgeMetric);
      const { deviation } = computeHomeostasis(band, current);
      if (deviation <= this.stability.deadbandDeviation) {
        // 死区命中：偏离为正但未越过死区半宽 → 判为噪声，抑制本旋钮的
        // 稳定环候选（带内 deviation ≤ 0 同样静默，但不计入死区统计）
        if (deviation > 0) this.deadbandSkips += 1;
        continue;
      }
      // 指标低于带下沿 → 需要指标上升；高于上沿 → 需要下降
      const wantMetricUp = current < band.min;
      const direction: 'up' | 'down' = wantMetricUp === (affect === 'positive') ? 'up' : 'down';
      candidates.push({
        knob: knob.id,
        label: knob.label,
        direction,
        reason: `[稳定环] ${JUDGE_METRIC_LABELS[knob.judgeMetric]} ${current} 偏离目标带 [${band.min}, ${band.max}]（归一化偏离 ${deviation.toFixed(2)} > 死区 ${this.stability.deadbandDeviation}），朝带内方向保守调整`,
        priority: Number((0.5 + Math.min(0.3, deviation * 0.3)).toFixed(3)),
        source: 'homeostatic',
      });
    }
    return candidates;
  }

  /**
   * 3.0：调整证书门裁决（89.0 视图）。
   *
   * 视图 = 学习臂记录的逐次调整效果配对样本（effectHistoryOf）。
   * - 样本 ≥ minSamples：经验伯恩斯坦单侧下界 LCB = mean − ebRadius
   *   （复用 89.0 内核同式）——LCB > 0 放行全幅（真改进：历史效果
   *   的高置信下界为正）；LCB ≤ 0 拒绝（假改进：均值或许为正但方差
   *   吞噬了全部证据）；
   * - 样本不足（视图不可用，如冷启动）：provisional——保守半步 +
   *   严格判定观察窗（改一半幅度，无明确改善即自动回滚）。
   *
   * 未启用证书门（undefined）恒返回 full（保持 2.0 行为，零漂移）。
   */
  private certificateDecisionFor(
    knob: AdjustmentKnob,
    direction: 'up' | 'down',
  ): { mode: 'full' | 'provisional' | 'rejected'; lcb?: number; samples: number } {
    if (!this.certGate) return { mode: 'full', samples: 0 };
    const history = this.learner.effectHistoryOf(knob.id, direction);
    const key = `${knob.id}:${direction}`;
    if (history.length < this.certGate.minSamples) {
      this.certificateDecisions.set(key, { mode: 'provisional', samples: history.length });
      this.certificateCounters.provisional += 1;
      return { mode: 'provisional', samples: history.length };
    }
    const n = history.length;
    const mean = history.reduce((s, v) => s + v, 0) / n;
    let variance = 0;
    for (const v of history) variance += (v - mean) ** 2;
    const sigma = Math.sqrt(variance / (n - 1));
    const range = Math.max(...history) - Math.min(...history);
    // 89.0 同式：r = σ̂·√(2·ln(3/δ)/n) + 7·(b−a)·ln(3/δ)/(3·(n−1))
    const radius = ebRadius(sigma, range, n, this.certGate.delta);
    const lcb = mean - radius;
    const mode = lcb > 0 ? 'full' : 'rejected';
    this.certificateDecisions.set(key, { mode, lcb, samples: n });
    this.certificateCounters[mode] += 1;
    return { mode, lcb, samples: n };
  }

  /**
   * 3.0：应用路径的冲突检测与仲裁——上次我们写入的值与当前读数不一致
   * 即为外部改写（内环调参器 / 人工 / 其他控制实例）。最后写入者胜：
   * 外部当前值即为新基线（调用方本就从 current 出发计算），冲突计数
   * + 审计留痕，绝不盲目覆盖外部值。
   */
  private arbitrateIfDrifted(knob: AdjustmentKnob, current: number): void {
    const known = this.lastWrittenByUs.get(knob.id);
    const notified = this.driftSuspected.delete(knob.id);
    if (known === undefined || known === current) {
      if (!notified) return;
      // 显式报告但值恰好一致：记录冲突（多方写过同一值仍是多方调整）
      this.recordConflict(knob.id, current, '外部写入者（已报告，值一致）');
      return;
    }
    this.recordConflict(knob.id, current, notified ? '外部写入者（已报告）' : '外部写入者（未报告，读数检测）');
  }

  /** 3.0：冲突入账（计数 + 审计） */
  private recordConflict(knobId: string, currentValue: number, winner: string): void {
    this.conflictCount += 1;
    this.arbitratedCount += 1;
    this.lastConflict = { knob: knobId, winner, at: this.now() };
    this.appendAudit({
      type: 'conflict-arbitration',
      knob: knobId,
      to: currentValue,
      reason: `旋钮 ${knobId} 被外部改写（当前 ${currentValue}）：最后写入者胜，以外部值为新基线继续`,
    });
    // 外部值成为新的已知基线（否则每次调整都会重复计数同一冲突）
    this.lastWrittenByUs.set(knobId, currentValue);
  }

  /**
   * 3.0：外部写入报告通道（公共 API）。
   *
   * 内环调参器 / 人工通道 / 其他控制实例在改写某旋钮后调用，控制器
   * 记录冲突并在下次接触该旋钮时按「最后写入者胜」仲裁；若该旋钮
   * 正处于观察窗，立即作废观察（证据已被污染）。
   */
  notifyExternalWrite(knobId: string, writer = 'external'): boolean {
    const knob = this.knobs.get(knobId);
    if (!knob) return false;
    if (this.pending?.knob === knobId) {
      // 观察中：立即仲裁（观察作废）——下一轮 evaluateAndAdjust 的
      // 观察窗冲突检测会处理读数不一致；这里先登记 drift
      this.driftSuspected.add(knobId);
      this.lastWrittenByUs.delete(knobId);
      return true;
    }
    this.driftSuspected.add(knobId);
    void writer;
    return true;
  }

  // ─────────────────── 4.0：认知负荷计量 ───────────────────

  /**
   * 4.0：认知负荷合成（纯读取）。
   *
   * 负荷 = 在调旋钮数×w_adj + 在观实验数×w_exp + 在跟踪 KPI 数×w_kpi。
   * 「在调旋钮」= 最近 flightWindowReports 份报告内的 adjust 审计条目
   * （调整落地后系统需要连续几份报告消化效果，期间的新调整都是归因
   * 混淆源）；「在观实验」= beginMetaExperiment 登记的其他子系统实验；
   * 「在跟踪 KPI」= setTrackedKpiCount 登记的观测面宽度。
   * 未启用 cognitiveLoad 时返回 undefined。
   */
  private computeCognitiveLoad(reportIndex: number): {
    activeAdjustments: number;
    activeExperiments: number;
    trackedKpis: number;
    load: number;
    threshold: number;
  } | undefined {
    if (!this.loadGate) return undefined;
    const cfg = this.loadGate;
    let activeAdjustments = 0;
    for (const entry of this.audit) {
      if (entry.type !== 'adjust' || typeof entry.reportIndex !== 'number') continue;
      if (reportIndex - entry.reportIndex < cfg.flightWindowReports) activeAdjustments += 1;
    }
    const load =
      activeAdjustments * cfg.adjustmentWeight +
      this.activeExperiments.size * cfg.experimentWeight +
      this.trackedKpiCount * cfg.kpiWeight;
    return {
      activeAdjustments,
      activeExperiments: this.activeExperiments.size,
      trackedKpis: this.trackedKpiCount,
      load: Number(load.toFixed(4)),
      threshold: cfg.maxLoad,
    };
  }

  /** 4.0：认知负荷读数（公共 API；未启用返回 undefined；时间轴取最近报告序号） */
  cognitiveLoadView(): NonNullable<MetaControllerState['cognitiveLoad']> | undefined {
    const view = this.computeCognitiveLoad(this.lastReportIndex);
    if (!view) return undefined;
    return { ...view, paused: view.load > this.loadGate!.maxLoad, gateSkips: this.gateSkips };
  }

  /**
   * 4.0：登记一个进行中的实验（内环调参实验 / 因果干预 / 其他控制实例的
   * 观察窗——一切占用归因带宽的并发活动）。重复登记返回 false。
   */
  beginMetaExperiment(id: string): boolean {
    if (typeof id !== 'string' || id.length === 0 || this.activeExperiments.has(id)) return false;
    this.activeExperiments.add(id);
    return true;
  }

  /** 4.0：结束一个实验（释放归因带宽）。未登记返回 false。 */
  endMetaExperiment(id: string): boolean {
    return this.activeExperiments.delete(id);
  }

  /** 4.0：设置在跟踪 KPI 数（心智报告/监控面的观测宽度——看得越多，单次归因越难） */
  setTrackedKpiCount(count: number): void {
    this.trackedKpiCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  }

  // ── 2.0：经验安全包络 ──

  /** 旋钮当前安全包络：有 commit 好值 → 好值区间 ± 一步长；否则旋钮原始边界 */
  private envelopeOf(knob: AdjustmentKnob): SafeEnvelopeInfo {
    const good = this.envelopeGood.get(knob.id) ?? [];
    const bad = this.envelopeBad.get(knob.id) ?? [];
    if (good.length === 0) {
      return { knob: knob.id, min: knob.min, max: knob.max, source: 'default', sampleCount: 0, knownBadValues: bad };
    }
    const learnedMin = Math.max(knob.min, Number((Math.min(...good) - knob.step).toFixed(6)));
    const learnedMax = Math.min(knob.max, Number((Math.max(...good) + knob.step).toFixed(6)));
    return { knob: knob.id, min: learnedMin, max: learnedMax, source: 'learned', sampleCount: good.length, knownBadValues: bad };
  }

  /** 已知劣化值判定（数值直接相等，或整数旋钮按四舍五入相等） */
  private isKnownBadValue(knob: AdjustmentKnob, value: number): boolean {
    const bad = this.envelopeBad.get(knob.id);
    if (!bad || bad.length === 0) return false;
    return bad.some((b) => (knob.integer ? Math.round(b) === Math.round(value) : b === value));
  }

  /** commit 判定后收录好值（安全包络的「已验证安全」样本） */
  private recordGoodValue(knobId: string, value: number): void {
    const values = this.envelopeGood.get(knobId) ?? [];
    if (!values.includes(value)) values.push(value);
    if (values.length > 8) values.shift(); // 有界记忆：只保留最近 8 个好值
    this.envelopeGood.set(knobId, values);
  }

  /** 自动回滚后标记劣化值（后续调整预防性排除） */
  private recordBadValue(knobId: string, value: number): void {
    const values = this.envelopeBad.get(knobId) ?? [];
    if (!values.includes(value)) values.push(value);
    if (values.length > 8) values.shift();
    this.envelopeBad.set(knobId, values);
  }

  // ── 2.0：熔断器 ──

  /** 单次判定保留：该旋钮连续回滚清零、全局连续回滚清零 */
  private onJudgedCommit(knobId: string): void {
    this.breakerCounters.set(knobId, 0);
    this.globalRollbackStreak = 0;
  }

  /** 单次判定回滚：推进单旋钮与全局连续回滚计数，达阈值触发熔断 */
  private onJudgedRollback(knobId: string): void {
    // 单旋钮熔断
    const knobStreak = (this.breakerCounters.get(knobId) ?? 0) + 1;
    this.breakerCounters.set(knobId, knobStreak);
    if (knobStreak >= this.config.breakerThreshold && !this.trippedBreakers.has(knobId)) {
      this.trippedBreakers.add(knobId);
      this.appendAudit({
        type: 'circuit-breaker',
        knob: knobId,
        reason: `旋钮连续 ${knobStreak} 次自动回滚，熔断其自动调整（reArmBreaker 可复位）`,
      });
    }

    // 全局熔断
    this.globalRollbackStreak += 1;
    if (this.globalRollbackStreak >= this.config.globalBreakerThreshold && !this.frozenByBreaker) {
      this.frozenByBreaker = true;
      this.appendAudit({
        type: 'circuit-breaker',
        reason: `全局连续 ${this.globalRollbackStreak} 次自动回滚，触发全局熔断（reArmBreaker 可复位）`,
      });
    }
  }

  /** 熔断器面板（getState / 心智报告共享） */
  private breakerPanel(): CircuitBreakerInfo[] {
    return [...this.knobs.values()].map((k) => {
      const streak = this.breakerCounters.get(k.id) ?? 0;
      const tripped = this.trippedBreakers.has(k.id);
      return {
        knob: k.id,
        consecutiveRollbacks: streak,
        tripped,
        reason: tripped ? `连续 ${streak} 次自动回滚熔断` : undefined,
      };
    });
  }

  /**
   * 熔断器手动复位（公共 API）
   *
   * - 指定 knobId：复位该旋钮熔断（清零计数 + 解除熔断）
   * - 不指定：复位全局熔断 + 全部旋钮熔断与计数
   * 返回是否发生了实际复位动作。
   */
  reArmBreaker(knobId?: string): boolean {
    if (knobId) {
      const had = this.trippedBreakers.delete(knobId);
      const streak = this.breakerCounters.get(knobId) ?? 0;
      this.breakerCounters.set(knobId, 0);
      if (had || streak > 0) {
        this.appendAudit({ type: 'circuit-breaker', knob: knobId, reason: '手动复位旋钮熔断器，恢复自动调整' });
        this.persist();
        return true;
      }
      return false;
    }
    const anyTripped = this.frozenByBreaker || this.trippedBreakers.size > 0;
    this.frozenByBreaker = false;
    this.trippedBreakers.clear();
    this.breakerCounters.clear();
    this.globalRollbackStreak = 0;
    if (anyTripped) {
      this.appendAudit({ type: 'circuit-breaker', reason: '手动复位全局与全部旋钮熔断器，恢复自动调整' });
      this.persist();
    }
    return anyTripped;
  }

  /** 从心智报告提取判定指标 */
  private extractMetric(report: MentalReport, metric: JudgeMetric): number {
    switch (metric) {
      case 'operationalSuccessRate':
        return report.strategyPerformance.operational.successRate;
      case 'discoveryRate':
        return report.evolverEfficiency.discoveryRate;
      case 'proceduralGrowth':
        return report.memoryQuality.counts.procedural;
      case 'pendingDistillation':
        return report.memoryQuality.distillation.pendingSinceLastDistillation;
      case 'survivalRate':
        return report.evolverEfficiency.survivalRate;
    }
  }

  private appendAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'> & { adjustAuditId?: string }): AuditEntry {
    this.auditSeq += 1;
    const full: AuditEntry = {
      id: `audit-${this.auditSeq}`,
      timestamp: this.now(),
      type: entry.type,
      knob: entry.knob,
      from: entry.from,
      to: entry.to,
      reason: entry.reason,
      effect: entry.effect,
      guardrail: entry.guardrail,
      source: entry.source,
      reportIndex: entry.reportIndex,
      certificate: entry.certificate,
      amplitude: entry.amplitude,
    };
    this.audit.push(full);
    if (this.audit.length > this.config.auditLimit) this.audit.shift();
    return full;
  }

  private buildReport(
    status: AdjustmentReport['status'],
    mentalReport: MentalReport,
    extra: Partial<AdjustmentReport> = {},
  ): AdjustmentReport {
    return {
      timestamp: new Date(this.now()).toISOString(),
      reportIndex: mentalReport.reportIndex,
      status,
      applied: extra.applied ?? [],
      rolledBack: extra.rolledBack,
      committed: extra.committed,
      observation: extra.observation,
      skippedReason: extra.skippedReason,
      mentalReport,
    };
  }

  // ─────────────────────────── 持久化 ───────────────────────────

  private persist(): void {
    if (!this.config.persistPath) return;
    try {
      const payload: PersistPayload & { auditSeq?: number } = {
        audit: this.audit,
        pending: this.pending,
        frozen: this.frozen,
        manuallyFrozenKnobs: [...this.manuallyFrozenKnobs],
        rolledBackAdjustIds: [...this.rolledBackAdjustIds],
        counters: this.counters,
        auditSeq: this.auditSeq,
        // 2.0：学习器 / 安全包络 / 熔断器
        learner: this.learner.dump(),
        envelopeGood: Object.fromEntries(this.envelopeGood),
        envelopeBad: Object.fromEntries(this.envelopeBad),
        breakerCounters: Object.fromEntries(this.breakerCounters),
        trippedBreakers: [...this.trippedBreakers],
        globalRollbackStreak: this.globalRollbackStreak,
        frozenByBreaker: this.frozenByBreaker,
        // 3.0：稳定环 / 证书门 / 冲突仲裁
        directionStreaks: [...this.directionStreaks.entries()].map(([knob, s]) => ({ knob, direction: s.direction, count: s.count })),
        cooldownLeft: this.cooldownLeft,
        stabilityCounters: {
          deadbandSkips: this.deadbandSkips,
          cooldownSkips: this.cooldownSkips,
          directionFlips: this.directionFlips,
          rampedAdjustments: this.rampedAdjustments,
        },
        arbitrationCounters: { conflicts: this.conflictCount, arbitrated: this.arbitratedCount },
        certificateState: {
          decisions: [...this.certificateDecisions.entries()].map(([key, d]) => {
            const [knob, direction] = key.split(':');
            return { knob, direction: direction === 'down' ? ('down' as const) : ('up' as const), mode: d.mode, lcb: d.lcb, samples: d.samples };
          }),
          counters: { ...this.certificateCounters },
        },
        // 4.0：负荷门 / 幅度元学习
        loadGateState: {
          experiments: [...this.activeExperiments],
          trackedKpis: this.trackedKpiCount,
          gateSkips: this.gateSkips,
        },
        amplitudeBands: this.ampLearner?.dump(),
      };
      fs.writeFileSync(this.config.persistPath, JSON.stringify(payload), 'utf-8');
    } catch {
      /* 持久化失败不影响运行 */
    }
  }

  private restore(): void {
    if (!this.config.persistPath || !fs.existsSync(this.config.persistPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.config.persistPath, 'utf-8')) as PersistPayload & {
        auditSeq?: number;
      };
      if (Array.isArray(parsed.audit)) this.audit = parsed.audit;
      this.pending = parsed.pending;
      this.frozen = parsed.frozen === true;
      this.manuallyFrozenKnobs = new Set(parsed.manuallyFrozenKnobs ?? []);
      this.rolledBackAdjustIds = new Set(parsed.rolledBackAdjustIds ?? []);
      if (parsed.counters) this.counters = parsed.counters;
      if (typeof parsed.auditSeq === 'number') this.auditSeq = parsed.auditSeq;
      // 2.0：学习器 / 安全包络 / 熔断器（缺省字段向后兼容旧持久化文件）
      this.learner.load(parsed.learner, (knob) => this.knobs.get(knob)?.judgeMetric ?? 'operationalSuccessRate');
      this.envelopeGood = new Map(Object.entries(parsed.envelopeGood ?? {}).map(([k, v]) => [k, [...v]]));
      this.envelopeBad = new Map(Object.entries(parsed.envelopeBad ?? {}).map(([k, v]) => [k, [...v]]));
      this.breakerCounters = new Map(Object.entries(parsed.breakerCounters ?? {}));
      this.trippedBreakers = new Set(parsed.trippedBreakers ?? []);
      this.globalRollbackStreak = parsed.globalRollbackStreak ?? 0;
      this.frozenByBreaker = parsed.frozenByBreaker === true;
      // 3.0：稳定环 / 证书门 / 冲突仲裁（缺省字段向后兼容旧持久化文件）
      this.directionStreaks = new Map(
        (parsed.directionStreaks ?? []).map((s) => [s.knob, { direction: s.direction, count: s.count }]),
      );
      this.cooldownLeft = parsed.cooldownLeft ?? 0;
      if (parsed.stabilityCounters) {
        this.deadbandSkips = parsed.stabilityCounters.deadbandSkips ?? 0;
        this.cooldownSkips = parsed.stabilityCounters.cooldownSkips ?? 0;
        this.directionFlips = parsed.stabilityCounters.directionFlips ?? 0;
        this.rampedAdjustments = parsed.stabilityCounters.rampedAdjustments ?? 0;
      }
      if (parsed.arbitrationCounters) {
        this.conflictCount = parsed.arbitrationCounters.conflicts ?? 0;
        this.arbitratedCount = parsed.arbitrationCounters.arbitrated ?? 0;
      }
      if (parsed.certificateState) {
        this.certificateDecisions = new Map(
          (parsed.certificateState.decisions ?? []).map((d) => [`${d.knob}:${d.direction}`, { mode: d.mode, lcb: d.lcb, samples: d.samples }]),
        );
        this.certificateCounters = { ...this.certificateCounters, ...parsed.certificateState.counters };
      }
      // 4.0：负荷门 / 幅度元学习（缺省字段向后兼容旧持久化文件）
      if (parsed.loadGateState) {
        this.activeExperiments = new Set(parsed.loadGateState.experiments ?? []);
        this.trackedKpiCount = parsed.loadGateState.trackedKpis ?? 0;
        this.gateSkips = parsed.loadGateState.gateSkips ?? 0;
      }
      this.ampLearner?.load(parsed.amplitudeBands);
    } catch {
      /* 损坏文件忽略，从零开始 */
    }
  }
}

/** 判定指标人类可读标签 */
const JUDGE_METRIC_LABELS: Record<JudgeMetric, string> = {
  operationalSuccessRate: '操作环成功率',
  discoveryRate: '进化发现速率',
  proceduralGrowth: '程序记忆累积量',
  pendingDistillation: '蒸馏积压水位',
  survivalRate: '新策略存活率',
};
