/**
 * policy-evolver.ts — 策略进化器（第三阶段质级升级：种群进化 + 金丝雀部署）
 *
 * 进化循环（变异/交叉 → 选择 → 保留）：
 * 1. 变异与交叉 generateCandidates：以当前策略与种群精英（Hall of Fame）为
 *    亲代，产出混合候选——高斯变异（自适应步长）、双亲交叉（标量均匀 + 
 *    规则子集合并）、规则基因变异（增/删/改）、边界内探索者
 * 2. 选择 evaluateCandidate + selectBest：每个候选经沙盒多种子统计评估
 *    （历史回放 + 对抗任务），产出收益/风险/回归/LCB 四段式报告；
 *    仅 deployable（gainLCB ≥ minGain 且零风险零回归）的候选可胜出
 * 3. 保留 deployPolicy：胜出变体热切换到操作环（onDeploy 回调落地到
 *    ModelScheduler / Optimizer，无需重启）；劣于当前策略的变体自然淘汰，
 *    但精英进种群存档（优秀基因不因单轮失利丢失）
 *
 * 质级升级点：
 * 1. 种群进化（1+λ + HoF）：从单亲盲变异升级为种群精英交叉——进化在
 *    「当前最优」与「历史优秀基因库」之间重组，跳出局部最优
 * 2. 自适应步长（1/5 法则）：近 10 轮部署成功率 > 20% 时放大变异强度
 *    （×1.25 探索），否则收缩（×0.85 收敛），无需人工调参
 * 3. 规则基因组变异：规则的增加/删除/修改三类变异 + 交叉合并，
 *    策略空间从标量微调扩展为可组合调度程序
 * 4. 金丝雀部署：新策略上线后进入观察窗，操作环真实结果回报
 *    （reportOperationalOutcome）；成功率/质量劣化超阈自动回滚前一策略，
 *    样本充足且无劣化则晋升正式——「沙盒通过」不再等于「永久上线」
 *
 * 可追溯性：每个策略携带 id / version / generation / parentId（交叉含
 * secondaryParentId）/ origin / fitness；评估报告、部署历史、种群、金丝雀
 * 状态全量持久化（JSON），支持任意时点审计进化链。
 *
 * 第四轮升级（激活与深化——全新维度，全部 opt-in、缺省零漂移）：
 * - 跨任务策略迁移：源任务的优秀策略经 exportTransferDonors 导出为可序列化
 *   供体，目标任务经 importTransferredPolicy 部分复制其结构性标量基因
 *   （默认迁移评分/组合基因，任务耦合的分解基因留在目标）作为微调起点；
 *   迁移谱系（派生起点及其变异/交叉后代）的每次沙盒评估自动入账，
 *   收益追踪对照冷启动基线：有益迁移保留为微调起点、收敛更快；无益
 *   迁移被识别（平均增益 ≤ −margin）并弃用（谱系移出种群，台账留痕）
 * - A/B 分支谱系：版本树上的并行分支——champion（当前在线策略）与
 *   challenger（其子代分支）同时在线，操作环流量按比例确定性分流
 *   （亏损补齐式路由，无随机数、序列可复现），按双侧实际表现晋升
 *   （challenger 热切换为新 champion）或淘汰（champion 保持在线）；
 *   分支台账与路由统计全量可观测
 */

import fs from 'node:fs';
import path from 'node:path';
import type { EvaluationReport, Policy, PolicyRule, ScalarGeneKey, SchedulerPolicyParams } from './policy-types.js';
import {
  MAX_POLICY_RULES,
  POLICY_GENE_BOUNDS,
  POLICY_RULE_DELTA_BOUNDS,
  createBaselinePolicy,
  normalizePolicyParams,
} from './policy-types.js';
import { wilsonLowerBound, wilsonUpperBound } from '../core/evidence.js';

// 第二轮创世纪 88.0/89.0：离线策略评估（反事实估值）+ 安全策略改进
// （有统计证书才上线）——金丝雀门控的离线双通道
import {
  offlinePolicyAudit,
  safeImprovementGate,
  type OfflinePolicyAuditView,
  type OpeEpisode,
  type DiscretePolicy,
  type QModel,
  type SafeImprovementGateView,
} from '../engines-frontier/autonomy25.js';
import type { ISandbox, IPolicyEvolver } from '../contracts.js';

/** 标量基因视图（数值/布尔字段；规则基因单独处理） */
type GeneRecord = Record<string, number | boolean>;

const geneRecord = (params: SchedulerPolicyParams): GeneRecord => params as unknown as GeneRecord;

/** 全部标量基因键 */
const SCALAR_GENE_KEYS = Object.keys(POLICY_GENE_BOUNDS) as ScalarGeneKey[];

/** 种群多样性半径：基因距离小于此值的个体视为近重复（适应度共享近似） */
const POLICY_DIVERSITY_RADIUS = 0.06;

// ─────────────────────────── 配置与报告 ───────────────────────────

export interface PolicyEvolverConfig {
  /** 每轮进化的候选变体数（缺省 6） */
  candidateCount?: number;
  /** 每个数值基因的变异概率（缺省 0.6） */
  mutationRate?: number;
  /** 变异强度基准（相对基因取值范围的比例，缺省 0.25；实际 × sigmaScale 自适应） */
  mutationStrength?: number;
  /** 布尔基因的翻转概率（缺省 0.25） */
  booleanFlipRate?: number;
  /** 部署门禁：相对 baseline 的最小收益提升（缺省 0.02，作用于 gainLCB） */
  minGain?: number;
  /** 种群（Hall of Fame）容量（缺省 6） */
  populationSize?: number;
  /** 交叉候选占比（缺省 0.34；种群 ≥2 时生效） */
  crossoverRate?: number;
  /** 规则变异概率（每个候选独立触发，缺省 0.3） */
  ruleMutationRate?: number;
  /** 探索者候选占比——边界内随机个体注入多样性（缺省 0.17） */
  explorerRate?: number;
  /** 规则变异可引用的已知任务类型（缺省空 = 规则用复杂度/特征条件） */
  knownTaskTypes?: string[];
  /** 金丝雀：最少观察样本数（缺省 5） */
  canaryMinSamples?: number;
  /** 金丝雀：晋升正式所需样本数（缺省 15） */
  canaryPromoteSamples?: number;
  /** 金丝雀：成功率劣化容忍（缺省 0.1） */
  canarySuccessTolerance?: number;
  /** 金丝雀：质量劣化容忍（缺省 0.05） */
  canaryQualityTolerance?: number;
  /** 进化历史持久化路径（缺省不持久化） */
  persistPath?: string;
  /** 随机源（测试可注入确定性实现） */
  rng?: () => number;
  /** 策略部署回调（热切换落地：更新 ModelScheduler/Optimizer 等） */
  onDeploy?: (policy: Policy) => void;
  /** 金丝雀决策回调（自动回滚 / 晋升时通知操作环） */
  onCanaryDecision?: (decision: { action: 'rolled-back' | 'promoted'; policyId: string; reason: string }) => void;
  /** 进化周期完成回调（可观测性） */
  onCycle?: (report: EvolutionCycleReport) => void;
}

/** 单轮进化周期报告 */
export interface EvolutionCycleReport {
  /** 本轮进化代际 */
  generation: number;
  /** 父代策略 */
  parentPolicyId: string;
  /** 候选来源构成（mutation/crossover/rule-mutation/explorer） */
  candidateOrigins: Record<string, number>;
  /** 各候选评估摘要（含淘汰原因） */
  candidates: Array<{
    policyId: string;
    reward: number;
    gain: number;
    /** 收益置信下界（多种子统计门禁） */
    gainLCB?: number;
    deployable: boolean;
    risks: number;
    regressions: number;
  }>;
  /** 胜出并部署的策略 id（无合适候选为空） */
  deployedPolicyId?: string;
  /** 本轮结论（人类可读） */
  summary: string;
}

/** 金丝雀状态（部署后观察窗） */
export interface CanaryState {
  policyId: string;
  deployedAt: number;
  status: 'active' | 'promoted' | 'rolled-back';
  /** 沙盒期望基线（部署时快照） */
  expectedSuccessRate: number;
  expectedAvgQuality: number;
  /** 操作环真实回报累计 */
  samples: number;
  successes: number;
  qualitySum: number;
  /** 状态变更原因（回滚/晋升时填写） */
  reason?: string;
}

// ─────────────────────────── 第四轮升级：跨任务策略迁移 ───────────────────────────

/**
 * 默认可迁移的结构性基因：全部标量基因（评分权重 + 分解阈值 + 组合逻辑）
 * ——调度程序的结构旋钮，是跨任务域仍然成立的结构先验。
 * 规则基因组（rules）缺省不迁移：规则条件（任务类型/复杂度带/特征）是
 * 任务耦合的记忆而非结构。「部分复制」的语义边界即在此：结构走、记忆留。
 */
export const TRANSFERABLE_POLICY_GENES: readonly ScalarGeneKey[] = [
  'costWeight',
  'memoryWeightBase',
  'memoryWeightGrowth',
  'memoryWeightCap',
  'decomposeEnabled',
  'decomposeComplexityThreshold',
  'decomposeMaxSubtasks',
  'ensembleEnabled',
  'ensembleScoreGap',
  'ensembleMaxModels',
];

/** 源任务导出的迁移供体（可序列化——跨进程/跨任务域传递） */
export interface TransferDonor {
  /** 供体策略快照（含适应度） */
  policy: Policy;
  /** 源任务标签（审计：迁移来自哪个任务域） */
  sourceTask: string;
  /** 导出时供体适应度分 */
  donorFitnessScore?: number;
  exportedAt: number;
}

/** 迁移选项 */
export interface PolicyTransferOptions {
  /** 迁移的标量基因键（缺省 TRANSFERABLE_POLICY_GENES——结构性基因） */
  transferKeys?: ScalarGeneKey[];
  /** 是否迁移规则基因组（缺省 false——规则条件通常任务耦合） */
  transferRules?: boolean;
}

/** 迁移收益裁决 */
export type TransferVerdict = 'pending' | 'beneficial' | 'neutral' | 'harmful';

/** 单次迁移记录（收益追踪台账） */
export interface TransferRecord {
  id: string;
  /** 源任务供体策略 id */
  donorPolicyId: string;
  sourceTask: string;
  /** 迁移派生策略 id（目标任务的微调起点） */
  derivedPolicyId: string;
  /** 实际迁移的基因键 */
  transferredKeys: string[];
  importedAt: number;
  /** 导入时刻目标任务当前策略的适应度分（冷启动对照线） */
  controlFitnessScore?: number;
  /** 迁移谱系（派生起点及其后代）的评估轨迹 */
  evaluations: Array<{ policyId: string; reward: number; gain: number; evaluatedAt: number }>;
  verdict: TransferVerdict;
  reason?: string;
  /** 弃用时间（verdict = harmful 时非空） */
  discardedAt?: number;
}

/** 迁移总报告 */
export interface TransferReport {
  records: TransferRecord[];
  pending: number;
  beneficial: number;
  neutral: number;
  harmful: number;
}

// ─────────────────────────── 第四轮升级：A/B 分支谱系 ───────────────────────────

/** A/B 分支配置 */
export interface ABBranchingOptions {
  /** challenger 流量比例（0~0.5；缺省 0.2） */
  challengerTraffic?: number;
  /** 裁决所需双侧最少分流样本数（缺省 8） */
  minSamples?: number;
  /** 晋升所需的最小成功率优势（缺省 0.05） */
  promoteMargin?: number;
  /** 淘汰判定的最小成功率劣化（缺省 0.05） */
  retireMargin?: number;
  /** 分流样本上限（达上限仍未晋升则淘汰——challenger 必须自证；缺省 200） */
  maxSamples?: number;
}

/** 单个已终结分支的档案 */
export interface ABBranchOutcome {
  championPolicyId: string;
  challengerPolicyId: string;
  challengerParentId: string;
  startedAt: number;
  decidedAt: number;
  status: 'promoted' | 'retired';
  trafficRatio: number;
  champion: ABArmStats;
  challenger: ABArmStats;
  reason: string;
}

/** 单臂统计 */
export interface ABArmStats {
  samples: number;
  successRate: number;
  avgQuality: number;
}

/** A/B 分支报告（活跃分支 + 历史档案） */
export interface ABBranchReport {
  active: boolean;
  championPolicyId?: string;
  challengerPolicyId?: string;
  /** challenger 的父代（版本树上的分支点——champion 的 id） */
  challengerParentId?: string;
  status?: 'active' | 'promoted' | 'retired';
  trafficRatio: number;
  champion: ABArmStats;
  challenger: ABArmStats;
  routedTotal: number;
  /** 已终结分支档案（晋升/淘汰路径可审计） */
  history: ABBranchOutcome[];
  reason?: string;
}

// ─────────────────────────── 证书门进化环（第三轮升级） ───────────────────────────

/**
 * 证书门上下文：离线双通道的轨迹素材与策略编码器
 *
 * 进化器不规定「调度基因 → 动作分布」的编码（那是操作环的领域知识）；
 * 调用方注入 encode（生产侧把策略参数映射为离散动作分布）与行为策略
 * μ 下采集的真实轨迹（OpeEpisode），88.0/89.0 内核在调用侧拼装。
 */
export interface CertificateGateContext {
  /** 行为策略 μ（当前生产策略）下采集的真实轨迹（≥2 条才可评估） */
  episodes: ReadonlyArray<OpeEpisode>;
  /** 策略参数 → 离散动作分布编码器（证书门的反事实评估对象） */
  encode: (params: SchedulerPolicyParams) => DiscretePolicy;
  /** 行为策略（轨迹采集者） */
  behavior: DiscretePolicy;
  /** 基准策略的编码（缺省 = behavior，即「与生产行为比」） */
  baseline?: DiscretePolicy;
  /** 近似 Q 模型（可选；不破坏 DR 无偏性，只影响方差） */
  qModel?: QModel;
}

/** 证书门裁决（四门：沙盒 → 88.0 OPE → 89.0 证书 → 金丝雀观察窗） */
export type CertificateVerdict =
  | 'deployed'
  | 'blocked-sandbox'
  | 'blocked-ope'
  | 'blocked-certificate'
  | 'revoked'
  | 'insufficient-episodes';

/** 单候选证书门决策（全量留痕，可审计） */
export interface CertificateDecision {
  policyId: string;
  generation: number;
  verdict: CertificateVerdict;
  /** 沙盒通道：相对当前策略的收益与置信下界 */
  sandboxGain: number;
  sandboxGainLCB?: number;
  /** 88.0 OPE 通道：DR 反事实估值及其经验伯恩斯坦下界 */
  opeDrEstimate?: number;
  opeLower?: number;
  /** 89.0 证书通道：配对差 Δ̂ 与高置信下界 LCB（accepted ⇔ LCB > 0） */
  certificateDelta?: number;
  certificateLCB?: number;
  certificateSamples?: number;
  reason: string;
  decidedAt: number;
}

/** 证书门进化周期报告（EvolutionCycleReport + 门控过程摘要） */
export interface CertificateCycleReport extends EvolutionCycleReport {
  gate: {
    /** 沙盒评估的候选总数 */
    evaluated: number;
    /** 通过沙盒门（deployable ∧ gainLCB ≥ minGain）的候选数 */
    sandboxPassed: number;
    /** 被 88.0 OPE 门拦截（表面分高但离线估值差）的候选数 */
    opeBlocked: number;
    /** 被 89.0 证书门拦截（配对差 LCB ≤ 0）的候选数 */
    certificateBlocked: number;
    /** 因证书吊销被跳过的候选数 */
    revokedSkipped: number;
    /** 最终裁决（无候选进入离线通道为 undefined） */
    decision?: CertificateDecision;
  };
}

/** 进化器状态报告（运维可观测） */
export interface PolicyEvolverStatus {
  currentPolicy: Policy;
  /** 已部署策略链（按部署时间升序；含回滚标记） */
  deployedHistory: Array<{
    id: string;
    version: number;
    generation: number;
    origin: string;
    gain?: number;
    deployedAt: number;
    rolledBackAt?: number;
  }>;
  /** 种群精英（按适应度降序） */
  population: Array<{ id: string; origin: string; generation: number; fitnessScore?: number }>;
  /** 自适应变异步长系数（1 = 基准强度） */
  sigmaScale: number;
  /** 金丝雀观察窗（无活跃金丝雀为空） */
  canary?: CanaryState;
  /** 评估过的候选总数 */
  totalCandidatesEvaluated: number;
  /** 进化总轮数 */
  totalCycles: number;
  /** 最近一轮周期报告（无则为空） */
  lastCycle?: EvolutionCycleReport;
  /** 第三轮升级：证书门摘要（吊销名单 + 最近决策台账） */
  certificate?: {
    revoked: string[];
    decisions: number;
    deployed: number;
    blocked: number;
    recent: CertificateDecision[];
  };
  /** 第四轮升级：跨任务迁移台账（有迁移记录时输出） */
  transfer?: TransferReport;
  /** 第四轮升级：A/B 分支谱系（有分支时输出） */
  ab?: ABBranchReport;
}

// ─────────────────────────── 策略进化器 ───────────────────────────

/**
 * 策略进化器（implements IPolicyEvolver）
 *
 * 被 index.ts 持有：autonomy-loop 进化段定期触发 runEvolutionCycle()，
 * 或外部经 evolve_policy Tool 手动触发；deployPolicy 经 onDeploy 回调
 * 热切换操作环（ModelScheduler.updatePolicy 等），金丝雀观察窗内由
 * reportOperationalOutcome 持续接收操作环真实结果。
 */
export class PolicyEvolver implements IPolicyEvolver {
  private config: Required<Omit<PolicyEvolverConfig, 'onDeploy' | 'onCanaryDecision' | 'onCycle' | 'persistPath' | 'rng' | 'knownTaskTypes'>> &
    Pick<PolicyEvolverConfig, 'onDeploy' | 'onCanaryDecision' | 'onCycle' | 'persistPath' | 'rng' | 'knownTaskTypes'>;
  private current: Policy;
  /** 部署回滚栈：金丝雀失败时恢复 */
  private previousPolicy?: Policy;
  private deployedHistory: Array<Policy & { gain?: number; rolledBackAt?: number }> = [];
  /** 种群精英存档（Hall of Fame，按 fitness.score 降序） */
  private population: Policy[] = [];
  private evaluatedReports = new Map<string, EvaluationReport>();
  private cycleReports: EvolutionCycleReport[] = [];
  private policyCounter = 0;
  private totalCandidatesEvaluated = 0;
  private totalCycles = 0;
  /** 自适应步长系数（1/5 法则驱动） */
  private sigmaScale = 1;
  /** 近 10 轮部署成败窗口（自适应步长依据） */
  private selectionWindow: boolean[] = [];
  /** 金丝雀观察窗（无活跃金丝雀为空） */
  private canary?: CanaryState;
  /** 第三轮升级：证书门决策台账（全量留痕，可审计） */
  private certificateLedger: CertificateDecision[] = [];
  /** 第三轮升级：被吊销证书的策略 id（金丝雀观察窗确认漂移劣化 → 同 id 不再复证） */
  private revokedCertificates = new Set<string>();
  // ── 第四轮升级：跨任务迁移 ──
  /** 迁移记录（含谱系 id 集合——派生起点及其后代） */
  private transferRecords: Array<{ record: TransferRecord; lineageIds: Set<string> }> = [];
  // ── 第四轮升级：A/B 分支谱系 ──
  /** A/B 分支配置（startABBranch 时以缺省配置懒启用） */
  private abCfg?: Required<ABBranchingOptions>;
  /** 活跃 A/B 分支（无分支为空） */
  private abBranch?: {
    championPolicyId: string;
    /** challenger 策略快照（版本树上的并行分支） */
    challengerPolicy: Policy;
    challengerParentId: string;
    startedAt: number;
    trafficRatio: number;
    champion: { samples: number; successes: number; qualitySum: number };
    challenger: { samples: number; successes: number; qualitySum: number };
    status: 'active' | 'promoted' | 'retired';
    reason?: string;
    decidedAt?: number;
  };
  /** 已终结分支档案（晋升/淘汰路径台账） */
  private abHistory: ABBranchOutcome[] = [];
  private rng: () => number;
  private evolving = false;

  constructor(config?: PolicyEvolverConfig, baseline?: Policy) {
    const { onDeploy, onCanaryDecision, onCycle, persistPath, rng, knownTaskTypes, ...rest } = config ?? {};
    this.config = {
      candidateCount: 6,
      mutationRate: 0.6,
      mutationStrength: 0.25,
      booleanFlipRate: 0.25,
      minGain: 0.02,
      populationSize: 6,
      crossoverRate: 0.34,
      ruleMutationRate: 0.3,
      explorerRate: 0.17,
      canaryMinSamples: 5,
      canaryPromoteSamples: 15,
      canarySuccessTolerance: 0.1,
      canaryQualityTolerance: 0.05,
      ...rest,
      onDeploy,
      onCanaryDecision,
      onCycle,
      persistPath,
      rng,
      knownTaskTypes,
    };
    this.rng = this.config.rng ?? Math.random;
    this.current = baseline ?? createBaselinePolicy();
    this.deployedHistory.push({ ...this.current, deployedAt: this.current.createdAt });
    this.loadPersisted();
    this.seedPopulation();
  }

  /** 当前生效策略（操作环据此调度） */
  getCurrentPolicy(): Policy {
    return { ...this.current, params: cloneParams(this.current.params) };
  }

  /** 进化器状态报告 */
  getStatus(): PolicyEvolverStatus {
    return {
      currentPolicy: this.getCurrentPolicy(),
      deployedHistory: this.deployedHistory.map((p) => ({
        id: p.id,
        version: p.version,
        generation: p.generation,
        origin: p.origin,
        gain: p.gain,
        deployedAt: p.deployedAt ?? p.createdAt,
        rolledBackAt: p.rolledBackAt,
      })),
      population: this.population.map((p) => ({ id: p.id, origin: p.origin, generation: p.generation, fitnessScore: p.fitness?.score })),
      sigmaScale: Number(this.sigmaScale.toFixed(3)),
      canary: this.canary ? { ...this.canary } : undefined,
      totalCandidatesEvaluated: this.totalCandidatesEvaluated,
      totalCycles: this.totalCycles,
      lastCycle: this.cycleReports[this.cycleReports.length - 1],
      certificate: {
        revoked: [...this.revokedCertificates],
        decisions: this.certificateLedger.length,
        deployed: this.certificateLedger.filter((d) => d.verdict === 'deployed').length,
        blocked: this.certificateLedger.filter((d) => d.verdict.startsWith('blocked')).length,
        recent: this.certificateLedger.slice(-5),
      },
      ...(this.transferRecords.length > 0 ? { transfer: this.transferReport() } : {}),
      ...(this.abBranch || this.abHistory.length > 0 ? { ab: this.abReport() } : {}),
    };
  }

  /** 种群精英（只读快照） */
  getPopulation(): Policy[] {
    return this.population.map((p) => ({ ...p, params: cloneParams(p.params) }));
  }

  /** 策略评估历史（policyId → 最近一次评估报告） */
  getEvaluationHistory(): EvaluationReport[] {
    return [...this.evaluatedReports.values()].sort((a, b) => b.evaluatedAt - a.evaluatedAt);
  }

  /**
   * 运行时调参入口（第四阶段：元认知控制器调节进化机制本身）
   *
   * 仅接受数值类进化参数（mutationRate / minGain / candidateCount 等），
   * 回调与持久化路径不可经此变更；下一进化周期即按新参数运行。
   */
  updateConfig(patch: Partial<PolicyEvolverConfig>): void {
    const numericKeys = [
      'candidateCount',
      'mutationRate',
      'mutationStrength',
      'booleanFlipRate',
      'minGain',
      'populationSize',
      'crossoverRate',
      'ruleMutationRate',
      'explorerRate',
      'canaryMinSamples',
      'canaryPromoteSamples',
      'canarySuccessTolerance',
      'canaryQualityTolerance',
    ] as const;
    for (const key of numericKeys) {
      const value = patch[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        const target = this.config as unknown as Record<string, number>;
        target[key] = key === 'populationSize' || key === 'candidateCount' || key === 'canaryMinSamples' || key === 'canaryPromoteSamples' ? Math.max(1, Math.round(value)) : value;
      }
    }
    if (Array.isArray(patch.knownTaskTypes)) this.config.knownTaskTypes = patch.knownTaskTypes;
  }

  /** 数值进化参数快照（元认知旋钮 read 端；只读） */
  getTunableParams(): Readonly<{
    candidateCount: number;
    mutationRate: number;
    mutationStrength: number;
    booleanFlipRate: number;
    minGain: number;
    populationSize: number;
    crossoverRate: number;
    ruleMutationRate: number;
    explorerRate: number;
    canaryMinSamples: number;
    canaryPromoteSamples: number;
    canarySuccessTolerance: number;
    canaryQualityTolerance: number;
  }> {
    return {
      candidateCount: this.config.candidateCount,
      mutationRate: this.config.mutationRate,
      mutationStrength: this.config.mutationStrength,
      booleanFlipRate: this.config.booleanFlipRate,
      minGain: this.config.minGain,
      populationSize: this.config.populationSize,
      crossoverRate: this.config.crossoverRate,
      ruleMutationRate: this.config.ruleMutationRate,
      explorerRate: this.config.explorerRate,
      canaryMinSamples: this.config.canaryMinSamples,
      canaryPromoteSamples: this.config.canaryPromoteSamples,
      canarySuccessTolerance: this.config.canarySuccessTolerance,
      canaryQualityTolerance: this.config.canaryQualityTolerance,
    };
  }

  // ─────────────────────────── IPolicyEvolver 实现 ───────────────────────────

  /**
   * 变异与交叉：产出混合候选（质级升级）
   *
   * 候选构成（candidateCount 个）：
   * - ⌈candidateCount × crossoverRate⌉ 个交叉候选（种群 ≥2 时；标量均匀交叉 +
   *   规则子集合并，双亲谱系可追溯）
   * - ⌊candidateCount × explorerRate⌋ 个探索者（边界内随机，注入多样性）
   * - 其余为当前策略/种群精英的高斯变异（sigmaScale 自适应）+ 规则变异
   */
  async generateCandidates(currentPolicy: Policy): Promise<Policy[]> {
    const total = Math.max(1, this.config.candidateCount);
    const crossoverCount =
      this.population.length >= 2 ? Math.ceil(total * this.config.crossoverRate) : 0;
    const explorerCount = Math.floor(total * this.config.explorerRate);
    const mutationCount = Math.max(1, total - crossoverCount - explorerCount);

    const candidates: Policy[] = [];
    for (let i = 0; i < crossoverCount; i += 1) {
      const child = this.crossoverRandom();
      if (child) candidates.push(child);
    }
    for (let i = 0; i < explorerCount; i += 1) {
      candidates.push(this.explorerPolicy(currentPolicy));
    }
    for (let i = 0; i < mutationCount; i += 1) {
      // 亲代交替取当前策略与种群精英（精英基因持续参与变异）
      const parent = i % 2 === 0 || this.population.length === 0 ? currentPolicy : this.population[Math.floor(this.rng() * this.population.length)]!;
      candidates.push(this.mutatePolicy(parent));
    }
    return candidates.slice(0, Math.max(total, candidates.length));
  }

  /** 选择（评估）：在沙盒中隔离评估候选（与当前策略对比，多种子统计） */
  async evaluateCandidate(policy: Policy, sandbox: ISandbox): Promise<EvaluationReport> {
    const report = await sandbox.evaluate(policy, this.current);
    this.evaluatedReports.set(policy.id, report);
    this.totalCandidatesEvaluated += 1;
    // 第四轮升级：迁移谱系收益追踪（谱系成员的每次沙盒评估自动入账）
    if (this.transferRecords.length > 0) this.noteTransferEvaluation(policy.id, report);
    return report;
  }

  /**
   * 保留（择优）：deployable 且 gainLCB 最高且 ≥ minGain 的候选胜出
   *
   * 报告中 deployable 已含「零风险 + 零回归 + gainLCB ≥ 0」统计门禁，
   * 此处再叠加进化器级 minGain 阈值（双保险）；胜出者回填适应度并入种群。
   */
  async selectBest(candidates: Policy[], reports: EvaluationReport[]): Promise<Policy | null> {
    const reportByPolicy = new Map(reports.map((r) => [r.policyId, r]));
    let best: Policy | null = null;
    let bestScore = this.config.minGain;
    for (const candidate of candidates) {
      const report = reportByPolicy.get(candidate.id);
      if (!report || !report.deployable) continue;
      const score = report.gainLCB ?? report.gain;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    if (best) {
      const report = reportByPolicy.get(best.id)!;
      best.fitness = {
        score: report.reward,
        successRate: report.metrics.successRate,
        avgQuality: report.metrics.avgQuality,
        avgLatencyMs: report.metrics.avgLatencyMs,
        totalTokens: report.metrics.totalTokens,
        evaluatedTasks: report.taskStats.replayed + report.taskStats.adversarial,
        evaluatedAt: report.evaluatedAt,
      };
    }
    // 种群更新：全部候选（含未胜出者）按适应度竞争入种群——优秀基因不丢失
    this.updatePopulation(candidates);
    return best;
  }

  /**
   * 部署：胜出策略热切换到操作环并进入金丝雀观察窗
   *
   * 经 onDeploy 回调落地（无需重启）；部署记录写入可追溯历史并持久化；
   * 金丝雀基线取沙盒评估期望，观察窗内 reportOperationalOutcome 持续校验。
   */
  async deployPolicy(policy: Policy): Promise<void> {
    const deployedAt = Date.now();
    const normalized: Policy = {
      ...policy,
      params: normalizePolicyParams(policy.params),
      deployedAt,
    };
    const report = this.evaluatedReports.get(policy.id);
    const previous = this.current;
    this.current = normalized;
    this.previousPolicy = { ...previous, params: cloneParams(previous.params) };
    this.deployedHistory.push({ ...normalized, gain: report?.gain });
    this.canary = {
      policyId: normalized.id,
      deployedAt,
      status: 'active',
      expectedSuccessRate: report?.metrics.successRate ?? 1,
      expectedAvgQuality: report?.metrics.avgQuality ?? 1,
      samples: 0,
      successes: 0,
      qualitySum: 0,
    };
    this.persist();
    try {
      this.config.onDeploy?.(normalized);
    } catch {
      // 部署回调失败回滚到前一策略（操作环一致性优先）
      this.current = previous;
      this.previousPolicy = undefined;
      this.deployedHistory.pop();
      this.canary = undefined;
      this.persist();
      throw new Error(`策略 ${policy.id} 部署回调失败，已回滚至 ${previous.id}`);
    }
  }

  // ─────────────────────────── 金丝雀（质级升级） ───────────────────────────

  /**
   * 88.0：挂载离线策略评估门控（幂等覆盖，挂载即生效——咨询口径）。
   *
   * 上线判据从「沙盒跑分 gainLCB ≥ 0」升级为双通道的离线通道：用生产
   * 行为策略 μ 的真实轨迹 drEstimate 反事实评估候选 π（近似 Q 不破坏
   * 无偏性，只影响方差）+ empiricalBernsteinCI——LCB ≤ 0 即不放行
   * （与 89.0 组成「离线策略评估双件套」）。不改变既有晋升路径（零漂移）。
   */
  attachOpeGate(options?: { delta?: number; gamma?: number }): void {
    this.opeGateConfig = { delta: options?.delta ?? 0.05, gamma: options?.gamma ?? 1 };
  }

  /** 88.0：离线评估门控配置（未挂载零介入） */
  private opeGateConfig?: { delta: number; gamma: number };

  /** 88.0：离线评估读数（未挂载 / 轨迹不足时 undefined） */
  offlineEvaluation(
    episodes: ReadonlyArray<OpeEpisode>,
    candidate: DiscretePolicy,
    behavior: DiscretePolicy,
    qModel?: QModel,
  ): OfflinePolicyAuditView | undefined {
    return this.opeGateConfig
      ? offlinePolicyAudit(episodes, candidate, behavior, {
          qModel,
          gamma: this.opeGateConfig.gamma,
          delta: this.opeGateConfig.delta,
        })
      : undefined;
  }

  /**
   * 89.0：挂载安全策略改进门控（幂等覆盖，挂载即生效——咨询口径）。
   *
   * 候选晋升的安全阀：逐轨迹配对差 Δ̂ = Ĵ(π_cand) − Ĵ(π_base) 的高置信
   * 下界 LCB > 0 才 accepted（δ = 每次上线决策的错误接受上限，缺省
   * 0.05）。estimator 注入 88.0 的 drPerEpisode（两内核零 import、调用
   * 侧拼装）；concentrationCurve 回答「还差多少样本才能下发证书」。
   * 不改变既有晋升路径（零漂移）。
   */
  attachSafeImprovementGate(options?: { delta?: number; minSamples?: number; gamma?: number }): void {
    this.safeGateConfig = {
      delta: options?.delta ?? 0.05,
      minSamples: options?.minSamples ?? 30,
      gamma: options?.gamma ?? 1,
    };
  }

  /** 89.0：安全改进门控配置（未挂载零介入） */
  private safeGateConfig?: { delta: number; minSamples: number; gamma: number };

  /** 89.0：上线安全阀裁决（未挂载 / 轨迹不足时 undefined） */
  safeImprovementVerdict(
    episodes: ReadonlyArray<OpeEpisode>,
    candidate: DiscretePolicy,
    baseline: DiscretePolicy,
    behavior: DiscretePolicy,
    qModel?: QModel,
  ): SafeImprovementGateView | undefined {
    return this.safeGateConfig
      ? safeImprovementGate(episodes, candidate, baseline, behavior, {
          qModel,
          delta: this.safeGateConfig.delta,
          minSamples: this.safeGateConfig.minSamples,
          gamma: this.safeGateConfig.gamma,
        })
      : undefined;
  }

  /**
   * 操作环真实结果回报（金丝雀观察窗，4.0 Wilson 统计判定）
   *
   * 单侧噪声不回滚：仅当成功率 Wilson 上界（乐观边界）也跌破
   * 期望 − 容忍 时才统计确认劣化 → 回滚（如 7/10 = 0.7 的 UB ≈ 0.89
   * 高于底线 → 继续观察；0/5 的 UB ≈ 0.43 → 立即回滚）。
   * 晋升：样本达 canaryPromoteSamples 且未确认劣化、点估计不破底线，
   * 且 Wilson 下界（保守边界）亦不破底线 → 统计达标晋升；下界未达标
   * 则继续累积样本（宁可多观察，不冒进上线）。
   * @returns 金丝雀状态（无活跃金丝雀返回 undefined）
   */
  reportOperationalOutcome(outcome: { success: boolean; quality?: number }): CanaryState | undefined {
    if (!this.canary || this.canary.status !== 'active') return this.canary;
    this.canary.samples += 1;
    if (outcome.success) this.canary.successes += 1;
    if (typeof outcome.quality === 'number' && outcome.quality > 0) this.canary.qualitySum += outcome.quality;

    if (this.canary.samples >= this.config.canaryMinSamples) {
      const failures = this.canary.samples - this.canary.successes;
      const successRate = this.canary.successes / this.canary.samples;
      const successUB = wilsonUpperBound(this.canary.successes, failures);
      const successLB = wilsonLowerBound(this.canary.successes, failures);
      const successFloor = this.canary.expectedSuccessRate - this.config.canarySuccessTolerance;
      const avgQuality = this.canary.qualitySum / Math.max(1, this.canary.samples);
      const successDegrade = successUB < successFloor;
      const qualityDegrade =
        this.canary.qualitySum > 0 && this.canary.expectedAvgQuality - avgQuality > this.config.canaryQualityTolerance;
      if (successDegrade || qualityDegrade) {
        const reason = successDegrade
          ? `成功率 Wilson 上界 ${successUB.toFixed(3)}（点估计 ${successRate.toFixed(3)}，n=${this.canary.samples}）仍低于底线 ${successFloor.toFixed(3)}（期望 ${this.canary.expectedSuccessRate.toFixed(3)} − 容忍 ${this.config.canarySuccessTolerance}），统计确认劣化`
          : `质量 ${avgQuality.toFixed(3)} 低于沙盒期望 ${this.canary.expectedAvgQuality.toFixed(3)} 超过容忍 ${this.config.canaryQualityTolerance}`;
        return this.rollbackCanary(reason);
      }
      if (this.canary.samples >= this.config.canaryPromoteSamples) {
        if (successRate < successFloor || successLB < successFloor) {
          // 点估计或保守边界未达标：不冒进晋升，继续观察累积样本
          return { ...this.canary };
        }
        this.canary.status = 'promoted';
        this.canary.reason = `金丝雀观察 ${this.canary.samples} 个样本：成功率 ${successRate.toFixed(3)}（Wilson 区间 [${successLB.toFixed(3)}, ${successUB.toFixed(3)}]）达标底线 ${successFloor.toFixed(3)}，质量 ${avgQuality.toFixed(3)} 无劣化，晋升正式`;
        const decision = { action: 'promoted' as const, policyId: this.canary.policyId, reason: this.canary.reason };
        this.persist();
        this.config.onCanaryDecision?.(decision);
        return { ...this.canary };
      }
    }
    return { ...this.canary };
  }

  /** 金丝雀自动回滚：恢复前一策略并热切换（操作环安全兜底） */
  private rollbackCanary(reason: string): CanaryState {
    const canary = this.canary!;
    canary.status = 'rolled-back';
    canary.reason = reason;
    // 第三轮升级：观察窗漂移确认劣化 → 吊销证书（同 id 候选不再凭同一批
    // 离线证据复证上线——「沙盒+OPE 双门都过了」不等于「永久通行」）
    this.revokedCertificates.add(canary.policyId);
    this.certificateLedger.push({
      policyId: canary.policyId,
      generation: this.current.generation,
      verdict: 'revoked',
      sandboxGain: 0,
      reason: `金丝雀观察窗漂移确认劣化，证书吊销：${reason}`,
      decidedAt: Date.now(),
    });
    if (this.previousPolicy) {
      const rollbackTarget = this.previousPolicy;
      this.current = { ...rollbackTarget, params: cloneParams(rollbackTarget.params) };
      this.previousPolicy = undefined;
      const lastEntry = this.deployedHistory[this.deployedHistory.length - 1];
      if (lastEntry && lastEntry.id === canary.policyId) lastEntry.rolledBackAt = Date.now();
      this.persist();
      try {
        this.config.onDeploy?.(this.getCurrentPolicy());
      } catch {
        /* 回滚回调失败仅记录（前一策略本就是稳定态） */
      }
      this.config.onCanaryDecision?.({ action: 'rolled-back', policyId: canary.policyId, reason });
    }
    return { ...canary };
  }

  /** 运维手动回滚（金丝雀外强制恢复前一策略） */
  rollbackLastDeployment(): boolean {
    if (!this.previousPolicy) return false;
    return Boolean(this.rollbackCanary('运维手动回滚'));
  }

  // ─────────────────────────── 证书门进化环（第三轮升级） ───────────────────────────

  /**
   * 单候选证书门：沙盒跑分 → 88.0 OPE 离线估值 → 89.0 LCB 证书 → 部署金丝雀
   *
   * 四门次序（先便宜后昂贵、先在线后离线）：
   *   门 1 沙盒：多种子统计 gainLCB ≥ minGain 且零风险零回归（在线通道）
   *   门 2 OPE：生产轨迹反事实估值 DR 的经验伯恩斯坦下界 > 0——
   *     「表面分高（沙盒好）但离线估值差（真实轨迹不支持）」在此拦截
   *   门 3 证书：候选 vs 基准的逐轨迹配对差高置信下界 LCB > 0
   *     （safeImprovementGate accepted——统计证书在案才放行）
   *   门 4 金丝雀：部署后观察窗操作环漂移 → 自动回滚 + 证书吊销
   *
   * 已吊销证书的策略 id 直接拒绝复证（除非调用方换新 id 携新证据）。
   * @returns 证书门决策（全量入台账）
   */
  async certifyPolicy(policy: Policy, sandbox: ISandbox, gate: CertificateGateContext): Promise<CertificateDecision> {
    const decidedAt = Date.now();
    const base = { policyId: policy.id, generation: policy.generation, decidedAt };
    if (this.revokedCertificates.has(policy.id)) {
      return {
        ...base,
        verdict: 'revoked',
        sandboxGain: 0,
        reason: `策略 ${policy.id} 的证书已被吊销（金丝雀观察窗确认漂移劣化），同一证据下不再复证`,
      };
    }
    // 门 1：沙盒跑分（在线通道；评估留痕）
    const report = await this.evaluateCandidate(policy, sandbox);
    const decision = this.runOfflineGates(policy, report, gate, decidedAt);
    if (decision.verdict === 'deployed') {
      await this.deployPolicy(policy);
    }
    this.certificateLedger.push(decision);
    return decision;
  }

  /**
   * 离线双通道（门 2 + 门 3）：沙盒报告已备，只跑 88.0/89.0 内核
   *
   * 通过则回填适应度并入种群（优秀基因留档），不部署（部署由调用方决定）。
   */
  private runOfflineGates(
    policy: Policy,
    report: EvaluationReport,
    gate: CertificateGateContext,
    decidedAt: number,
  ): CertificateDecision {
    const base = { policyId: policy.id, generation: policy.generation, decidedAt };
    const sandboxGainLCB = report.gainLCB ?? report.gain;
    if (!report.deployable || sandboxGainLCB < this.config.minGain) {
      return {
        ...base,
        verdict: 'blocked-sandbox',
        sandboxGain: report.gain,
        sandboxGainLCB,
        reason: `沙盒门未过：deployable=${report.deployable}，gainLCB=${sandboxGainLCB.toFixed(4)} < minGain=${this.config.minGain}${report.risks.length > 0 ? `（风险 ${report.risks.length} 项）` : ''}${report.regressions.length > 0 ? `（回归 ${report.regressions.length} 项）` : ''}`,
      };
    }
    if (gate.episodes.length < 2) {
      return {
        ...base,
        verdict: 'insufficient-episodes',
        sandboxGain: report.gain,
        sandboxGainLCB,
        reason: `离线证据不足：行为策略轨迹仅 ${gate.episodes.length} 条（≥2 条才可反事实评估），拒绝在无证书状态下上线`,
      };
    }
    // 门 2：88.0 OPE——DR 反事实估值 + 经验伯恩斯坦 CI（下界 ≤ 0 = 真实轨迹不支持）
    const candidatePi = gate.encode(policy.params);
    const opeView = offlinePolicyAudit([...gate.episodes], candidatePi, gate.behavior, {
      qModel: gate.qModel,
      gamma: this.opeGateConfig?.gamma ?? 1,
      delta: this.opeGateConfig?.delta ?? 0.05,
    });
    if (!opeView) {
      return {
        ...base,
        verdict: 'insufficient-episodes',
        sandboxGain: report.gain,
        sandboxGainLCB,
        reason: '88.0 OPE 评估失败（轨迹非法或数值异常），拒绝在无证书状态下上线',
      };
    }
    if (opeView.ci.lower <= 0) {
      return {
        ...base,
        verdict: 'blocked-ope',
        sandboxGain: report.gain,
        sandboxGainLCB,
        opeDrEstimate: opeView.drEstimate,
        opeLower: opeView.ci.lower,
        reason: `88.0 OPE 门拦截：沙盒 gain=${report.gain.toFixed(4)}（LCB +${sandboxGainLCB.toFixed(4)}）但生产轨迹反事实估值 DR=${opeView.drEstimate.toFixed(4)}（EB 下界 ${opeView.ci.lower.toFixed(4)} ≤ 0）——表面分高、离线估值差`,
      };
    }
    // 门 3：89.0 证书——候选 vs 基准逐轨迹配对差的高置信下界 > 0
    const safeView = safeImprovementGate([...gate.episodes], candidatePi, gate.baseline ?? gate.behavior, gate.behavior, {
      qModel: gate.qModel,
      delta: this.safeGateConfig?.delta ?? 0.05,
      minSamples: this.safeGateConfig?.minSamples ?? 30,
      gamma: this.safeGateConfig?.gamma ?? 1,
    });
    if (!safeView) {
      return {
        ...base,
        verdict: 'insufficient-episodes',
        sandboxGain: report.gain,
        sandboxGainLCB,
        opeDrEstimate: opeView.drEstimate,
        opeLower: opeView.ci.lower,
        reason: '89.0 安全改进证书计算失败（轨迹非法或数值异常），拒绝在无证书状态下上线',
      };
    }
    if (!safeView.verdict.accepted) {
      return {
        ...base,
        verdict: 'blocked-certificate',
        sandboxGain: report.gain,
        sandboxGainLCB,
        opeDrEstimate: opeView.drEstimate,
        opeLower: opeView.ci.lower,
        certificateDelta: safeView.verdict.delta,
        certificateLCB: safeView.verdict.lcb,
        certificateSamples: safeView.verdict.n,
        reason: `89.0 证书门拦截：配对差 Δ̂=${safeView.verdict.delta.toFixed(4)} 的 LCB ${safeView.verdict.lcb.toFixed(4)} ≤ 0（n=${safeView.verdict.n}，${safeView.verdict.reason}）——统计证书不在案，不上线`,
      };
    }
    // 全门通过：回填适应度、入种群（部署由调用方执行）
    policy.fitness = {
      score: report.reward,
      successRate: report.metrics.successRate,
      avgQuality: report.metrics.avgQuality,
      avgLatencyMs: report.metrics.avgLatencyMs,
      totalTokens: report.metrics.totalTokens,
      evaluatedTasks: report.taskStats.replayed + report.taskStats.adversarial,
      evaluatedAt: report.evaluatedAt,
    };
    this.updatePopulation([policy]);
    return {
      ...base,
      verdict: 'deployed',
      sandboxGain: report.gain,
      sandboxGainLCB,
      opeDrEstimate: opeView.drEstimate,
      opeLower: opeView.ci.lower,
      certificateDelta: safeView.verdict.delta,
      certificateLCB: safeView.verdict.lcb,
      certificateSamples: safeView.verdict.n,
      reason: `四门全过：沙盒 gainLCB=+${sandboxGainLCB.toFixed(4)}；OPE DR=${opeView.drEstimate.toFixed(4)}（下界 ${opeView.ci.lower.toFixed(4)} > 0）；证书 Δ̂=+${safeView.verdict.delta.toFixed(4)}（LCB +${safeView.verdict.lcb.toFixed(4)}，n=${safeView.verdict.n}）——放行进入金丝雀观察窗`,
    };
  }

  /**
   * 证书门进化周期：变异/交叉 → 沙盒评估 →（LCB 排序）→ 离线双门 → 金丝雀
   *
   * 与 runEvolutionCycle 的区别：胜出判据从「沙盒 gainLCB 最高」升级为
   * 「沙盒 → 88.0 OPE → 89.0 证书」三连门全过才部署——沙盒排名只决定
   * 离线通道的检验次序（省算力），不再有最终决定权。被 OPE/证书门拦截
   * 的候选依次顺延检验下一名，全拦截则本轮不部署（当前策略保持）。
   */
  async runCertificateGatedCycle(sandbox: ISandbox, gate: CertificateGateContext): Promise<CertificateCycleReport> {
    if (this.evolving) {
      return {
        generation: this.current.generation,
        parentPolicyId: this.current.id,
        candidateOrigins: {},
        candidates: [],
        summary: '跳过：已有进化周期进行中',
        gate: { evaluated: 0, sandboxPassed: 0, opeBlocked: 0, certificateBlocked: 0, revokedSkipped: 0 },
      };
    }
    this.evolving = true;
    try {
      const parent = this.getCurrentPolicy();
      const candidates = await this.generateCandidates(parent);
      const reports: EvaluationReport[] = [];
      for (const candidate of candidates) {
        reports.push(await this.evaluateCandidate(candidate, sandbox));
      }
      const reportByPolicy = new Map(reports.map((r) => [r.policyId, r]));

      // 沙盒门排序：deployable ∧ gainLCB ≥ minGain，按 LCB 降序依次送检离线通道
      const ranked = candidates
        .filter((c) => {
          const r = reportByPolicy.get(c.id);
          return r?.deployable && (r.gainLCB ?? r.gain) >= this.config.minGain;
        })
        .sort((a, b) => (reportByPolicy.get(b.id)!.gainLCB ?? reportByPolicy.get(b.id)!.gain) - (reportByPolicy.get(a.id)!.gainLCB ?? reportByPolicy.get(a.id)!.gain));

      let decision: CertificateDecision | undefined;
      let opeBlocked = 0;
      let certificateBlocked = 0;
      let revokedSkipped = 0;
      for (const candidate of ranked) {
        if (this.revokedCertificates.has(candidate.id)) {
          revokedSkipped += 1;
          continue;
        }
        const d = this.runOfflineGates(candidate, reportByPolicy.get(candidate.id)!, gate, Date.now());
        this.certificateLedger.push(d);
        if (d.verdict === 'blocked-ope') opeBlocked += 1;
        if (d.verdict === 'blocked-certificate') certificateBlocked += 1;
        if (d.verdict === 'deployed') {
          decision = d;
          await this.deployPolicy(candidate);
          break; // 一轮只部署一个（金丝雀观察窗串行）
        }
      }

      // 种群照常更新（含被拦截候选——离线差但沙盒表现仍是基因素材）
      this.updatePopulation(candidates);
      this.adaptSigma(Boolean(decision));

      this.totalCycles += 1;
      const cycle: CertificateCycleReport = {
        generation: parent.generation + 1,
        parentPolicyId: parent.id,
        candidateOrigins: candidates.reduce<Record<string, number>>((acc, c) => {
          acc[c.origin] = (acc[c.origin] ?? 0) + 1;
          return acc;
        }, {}),
        candidates: candidates.map((c) => {
          const r = reportByPolicy.get(c.id);
          return {
            policyId: c.id,
            reward: r?.reward ?? 0,
            gain: r?.gain ?? 0,
            gainLCB: r?.gainLCB,
            deployable: r?.deployable ?? false,
            risks: r?.risks.length ?? 0,
            regressions: r?.regressions.length ?? 0,
          };
        }),
        deployedPolicyId: decision?.policyId,
        summary: decision
          ? `第 ${parent.generation + 1} 代（证书门）：候选 ${candidates.length} 个，沙盒过门 ${ranked.length} 个，胜出 ${decision.policyId}（沙盒 LCB +${(decision.sandboxGainLCB ?? 0).toFixed(3)} + OPE DR ${decision.opeDrEstimate?.toFixed(3)} + 证书 LCB +${(decision.certificateLCB ?? 0).toFixed(3)}），已热切换进入金丝雀观察`
          : `第 ${parent.generation + 1} 代（证书门）：候选 ${candidates.length} 个均未走完四门（沙盒过门 ${ranked.length}，OPE 拦截 ${opeBlocked}，证书拦截 ${certificateBlocked}，吊销跳过 ${revokedSkipped}），当前策略保持不变`,
        gate: {
          evaluated: candidates.length,
          sandboxPassed: ranked.length,
          opeBlocked,
          certificateBlocked,
          revokedSkipped,
          decision,
        },
      };
      this.cycleReports.push(cycle);
      if (this.cycleReports.length > 50) this.cycleReports.shift();
      // 第四轮升级：迁移收益裁决（无迁移记录时零介入——零漂移）
      if (this.transferRecords.length > 0) this.reviewTransfers();
      this.persist();
      this.config.onCycle?.(cycle);
      return cycle;
    } finally {
      this.evolving = false;
    }
  }

  /** 证书门决策台账（全量只读快照，按时间升序） */
  getCertificateLedger(): CertificateDecision[] {
    return this.certificateLedger.map((d) => ({ ...d }));
  }

  /** 已吊销证书的策略 id 列表（审计） */
  getRevokedCertificates(): string[] {
    return [...this.revokedCertificates];
  }

  // ─────────────────────────── 第四轮升级：跨任务策略迁移 ───────────────────────────

  /**
   * 导出迁移供体：种群精英前 topK（适应度降序）打包为可序列化快照。
   *
   * 源任务侧调用：优秀策略（含参数与适应度）跨任务域传递的出口。
   * 不改变进化器任何状态（纯导出）。
   */
  exportTransferDonors(sourceTask: string, topK = 3): TransferDonor[] {
    const ranked = [...this.population]
      .sort((a, b) => (b.fitness?.score ?? -1) - (a.fitness?.score ?? -1))
      .slice(0, Math.max(1, Math.floor(topK)));
    const exportedAt = Date.now();
    return ranked.map((p) => ({
      policy: { ...p, params: cloneParams(p.params) },
      sourceTask,
      donorFitnessScore: p.fitness?.score,
      exportedAt,
    }));
  }

  /**
   * 导入迁移供体：部分复制供体的结构性标量基因到目标任务当前策略之上，
   * 产出 origin='transfer' 的派生策略（微调起点），进入种群与迁移谱系追踪。
   *
   * - 部分复制：只复制 transferKeys（缺省评分/组合结构基因）；任务耦合的
   *   分解基因、规则条件缺省留在目标任务——「源任务学到的结构」而非
   *   「源任务的任务记忆」被迁移
   * - 微调起点：派生策略进入种群，后续进化周期以其（及种群精英）为亲代
   *   变异——目标任务不是从零搜索，而是从迁移起点精修
   * - 收益追踪：导入时刻记录目标任务当前策略适应度（冷启动对照线）；
   *   迁移谱系（派生起点及其变异/交叉后代）此后每次沙盒评估自动入账
   *   （evaluateCandidate 钩子），reviewTransfers 依平均增益裁决
   *   beneficial / neutral / harmful（harmful = 谱系移出种群并弃用）
   */
  importTransferredPolicy(donor: TransferDonor, options?: PolicyTransferOptions): Policy {
    const keys = options?.transferKeys ?? [...TRANSFERABLE_POLICY_GENES];
    const params = cloneParams(this.current.params);
    const target = geneRecord(params);
    const source = geneRecord(donor.policy.params);
    for (const key of keys) {
      if (key in source) target[key] = source[key];
    }
    if (options?.transferRules && Array.isArray(donor.policy.params.rules)) {
      params.rules = donor.policy.params.rules.map((r) => ({ ...r, when: { ...r.when }, action: { ...r.action } }));
    }
    const derived: Policy = {
      id: `policy-${++this.policyCounter}`,
      version: this.current.version + 1,
      type: 'scheduler',
      params: normalizePolicyParams(params),
      origin: 'transfer',
      generation: this.current.generation + 1,
      parentId: donor.policy.id,
      createdAt: Date.now(),
    };
    // 冷启动对照线快照：导入时刻目标当前策略的适应度（fitness 缺省回退最近评估报告的 reward）
    const controlReport = this.evaluatedReports.get(this.current.id);
    this.transferRecords.push({
      record: {
        id: `transfer-${this.transferRecords.length + 1}`,
        donorPolicyId: donor.policy.id,
        sourceTask: donor.sourceTask,
        derivedPolicyId: derived.id,
        transferredKeys: [...keys],
        importedAt: Date.now(),
        controlFitnessScore: this.current.fitness?.score ?? controlReport?.reward,
        evaluations: [],
        verdict: 'pending',
      },
      lineageIds: new Set([derived.id]),
    });
    // 微调起点进入种群（下一次 evaluateCandidate 回填适应度后参与精英竞争）
    this.population.push({ ...derived, params: cloneParams(derived.params) });
    return { ...derived, params: cloneParams(derived.params) };
  }

  /** 迁移收益报告（无迁移记录时 records 为空——冷启动对照的读数端） */
  transferReport(): TransferReport {
    const records = this.transferRecords.map((t) => ({ ...t.record, evaluations: [...t.record.evaluations] }));
    return {
      records,
      pending: records.filter((r) => r.verdict === 'pending').length,
      beneficial: records.filter((r) => r.verdict === 'beneficial').length,
      neutral: records.filter((r) => r.verdict === 'neutral').length,
      harmful: records.filter((r) => r.verdict === 'harmful').length,
    };
  }

  /**
   * 迁移收益裁决（进化周期尾部自动调用；也可手动调用）
   *
   * 样本 ≥ minEvaluations 的 pending 记录：谱系评估平均增益 ≥ +benefitMargin
   * → beneficial（保留微调起点）；≤ −discardMargin → harmful（识别为无益
   * 迁移：谱系个体移出种群（保底 2），弃用留痕）；其间 → neutral（观察）。
   */
  reviewTransfers(options?: { minEvaluations?: number; benefitMargin?: number; discardMargin?: number }): TransferReport {
    const minEvaluations = Math.max(1, options?.minEvaluations ?? 4);
    const benefitMargin = options?.benefitMargin ?? 0.01;
    const discardMargin = options?.discardMargin ?? 0.01;
    for (const { record, lineageIds } of this.transferRecords) {
      if (record.verdict !== 'pending' || record.evaluations.length < minEvaluations) continue;
      const meanGain = record.evaluations.reduce((s, e) => s + e.gain, 0) / record.evaluations.length;
      if (meanGain >= benefitMargin) {
        record.verdict = 'beneficial';
        record.reason = `迁移谱系 ${record.evaluations.length} 次评估平均增益 +${meanGain.toFixed(4)} ≥ +${benefitMargin}：源任务「${record.sourceTask}」的结构对目标任务有益，保留为微调起点`;
        continue;
      }
      if (meanGain <= -discardMargin) {
        record.verdict = 'harmful';
        record.discardedAt = Date.now();
        record.reason = `迁移谱系 ${record.evaluations.length} 次评估平均增益 ${meanGain.toFixed(4)} ≤ −${discardMargin}：无益迁移被识别并弃用（谱系 ${lineageIds.size} 个个体移出种群，台账留痕）`;
        // 无益迁移弃用：谱系个体移出种群（保底 2 个——种群不能失去变异素材）
        const removals = this.population.filter((p) => lineageIds.has(p.id));
        const nonLineage = this.population.length - removals.length;
        const keepFloor = Math.max(0, 2 - nonLineage);
        const toRemove = new Set(removals.slice(0, Math.max(0, removals.length - keepFloor)).map((p) => p.id));
        if (toRemove.size > 0) this.population = this.population.filter((p) => !toRemove.has(p.id));
        continue;
      }
      record.verdict = 'neutral';
      record.reason = `迁移谱系 ${record.evaluations.length} 次评估平均增益 ${meanGain.toFixed(4)} 在 [−${discardMargin}, +${benefitMargin}] 观察带内：继续累积证据`;
    }
    return this.transferReport();
  }

  /** 迁移谱系评估入账（evaluateCandidate 钩子——谱系成员的每次沙盒评估） */
  private noteTransferEvaluation(policyId: string, report: EvaluationReport): void {
    for (const { record, lineageIds } of this.transferRecords) {
      if (record.verdict === 'harmful') continue;
      if (!lineageIds.has(policyId)) continue;
      record.evaluations.push({ policyId, reward: report.reward, gain: report.gain, evaluatedAt: report.evaluatedAt });
    }
  }

  /** 迁移谱系追踪：谱系成员产生的变异/交叉后代并入谱系（供体基因的传播可审计） */
  private trackTransferLineage(parentIds: readonly string[], childId: string): void {
    if (this.transferRecords.length === 0) return;
    for (const { record, lineageIds } of this.transferRecords) {
      if (record.verdict === 'harmful') continue;
      if (parentIds.some((id) => lineageIds.has(id))) lineageIds.add(childId);
    }
  }

  // ─────────────────────────── 第四轮升级：A/B 分支谱系 ───────────────────────────

  /**
   * 挂载 A/B 分支配置（幂等覆盖；startABBranch 未挂载时以缺省配置懒启用）
   */
  attachABBranching(options?: ABBranchingOptions): void {
    const traffic = Math.max(0.05, Math.min(0.5, options?.challengerTraffic ?? 0.2));
    this.abCfg = {
      challengerTraffic: traffic,
      minSamples: Math.max(2, Math.floor(options?.minSamples ?? 8)),
      promoteMargin: Math.max(0, options?.promoteMargin ?? 0.05),
      retireMargin: Math.max(0, options?.retireMargin ?? 0.05),
      maxSamples: Math.max(16, Math.floor(options?.maxSamples ?? 200)),
    };
  }

  /**
   * 开启 A/B 分支：champion（当前在线策略）与 challenger（其版本树子代）
   * 同时在线，操作环流量按 trafficRatio 分流。
   *
   * @param challenger 挑战者（缺省 = 当前策略的变异体——版本树上的并行分支）
   */
  startABBranch(challenger?: Policy): ABBranchReport {
    if (!this.abCfg) this.attachABBranching();
    const cfg = this.abCfg!;
    const champ = this.getCurrentPolicy();
    const chall = challenger
      ? { ...challenger, params: cloneParams(challenger.params) }
      : this.mutatePolicy(champ);
    // 既有活跃分支先归档（被新分支替换——不静默丢弃实验数据）
    if (this.abBranch && this.abBranch.status === 'active') {
      this.finalizeABBranch('retired', '被新的 A/B 分支替换（实验数据归档）');
    }
    this.abBranch = {
      championPolicyId: champ.id,
      challengerPolicy: chall,
      challengerParentId: chall.parentId ?? champ.id,
      startedAt: Date.now(),
      trafficRatio: cfg.challengerTraffic,
      champion: { samples: 0, successes: 0, qualitySum: 0 },
      challenger: { samples: 0, successes: 0, qualitySum: 0 },
      status: 'active',
    };
    return this.abReport();
  }

  /**
   * 预览下一条操作环流量的去向（纯计算，不记账、不消耗随机数）
   *
   * 调用方据此为两侧构造不同成功率的回报流（确定性实验的关键）。
   */
  peekABRoute(): 'champion' | 'challenger' | 'none' {
    return this.abRouteDecision();
  }

  /**
   * 操作环真实回报的 A/B 分流入口
   *
   * 亏损补齐式确定性路由：challenger 份额落后于目标比例时接收下一条
   * 流量——无随机数、给定回报序列完全可复现（20% 比例在任意前缀上
   * 的路由序列唯一）。双侧样本达 minSamples 后按实际表现裁决：
   * challenger 成功率 ≥ champion + promoteMargin → 晋升（热切换为新
   * champion，走金丝雀观察窗）；champion ≥ challenger + retireMargin
   * → 淘汰（champion 保持在线，challenger 实验归档）。
   * @returns 该条流量实际流向的分支
   */
  async routeOperationalOutcome(outcome: { success: boolean; quality?: number }): Promise<'champion' | 'challenger' | 'none'> {
    const arm = this.abRouteDecision();
    if (arm === 'none' || !this.abBranch || this.abBranch.status !== 'active') return 'none';
    const b = this.abBranch;
    const side = arm === 'champion' ? b.champion : b.challenger;
    side.samples += 1;
    if (outcome.success) side.successes += 1;
    if (typeof outcome.quality === 'number' && outcome.quality > 0) side.qualitySum += outcome.quality;
    await this.reviewABBranch();
    return arm;
  }

  /** A/B 分支报告（活跃分支双侧统计 + 已终结分支档案） */
  abReport(): ABBranchReport {
    const toStats = (s: { samples: number; successes: number; qualitySum: number }): ABArmStats => ({
      samples: s.samples,
      successRate: s.samples > 0 ? Number((s.successes / s.samples).toFixed(4)) : 0,
      avgQuality: s.samples > 0 ? Number((s.qualitySum / s.samples).toFixed(4)) : 0,
    });
    const b = this.abBranch;
    return {
      active: b?.status === 'active',
      championPolicyId: b?.championPolicyId,
      challengerPolicyId: b?.challengerPolicy?.id,
      challengerParentId: b?.challengerParentId,
      status: b?.status,
      trafficRatio: b?.trafficRatio ?? this.abCfg?.challengerTraffic ?? 0.2,
      champion: toStats(b?.champion ?? { samples: 0, successes: 0, qualitySum: 0 }),
      challenger: toStats(b?.challenger ?? { samples: 0, successes: 0, qualitySum: 0 }),
      routedTotal: (b?.champion.samples ?? 0) + (b?.challenger.samples ?? 0),
      history: [...this.abHistory],
      reason: b?.reason,
    };
  }

  /** 确定性路由决策（亏损补齐：落后于目标比例的一侧接收下一条流量） */
  private abRouteDecision(): 'champion' | 'challenger' | 'none' {
    const b = this.abBranch;
    if (!b || b.status !== 'active') return 'none';
    const total = b.champion.samples + b.challenger.samples;
    return (total + 1) * b.trafficRatio > b.challenger.samples ? 'challenger' : 'champion';
  }

  /** 分支裁决：双侧样本达标 → 按实际表现晋升/淘汰；达样本上限 → challenger 必须自证 */
  private async reviewABBranch(): Promise<void> {
    const b = this.abBranch;
    const cfg = this.abCfg!;
    if (!b || b.status !== 'active') return;
    const total = b.champion.samples + b.challenger.samples;
    const champRate = b.champion.successes / Math.max(1, b.champion.samples);
    const challRate = b.challenger.successes / Math.max(1, b.challenger.samples);
    const matured = b.champion.samples >= cfg.minSamples && b.challenger.samples >= cfg.minSamples;
    const atCap = total >= cfg.maxSamples;
    if (!matured && !atCap) return; // 样本未齐且未达上限：继续分流观察
    if (matured && !atCap) {
      if (challRate >= champRate + cfg.promoteMargin) {
        const challengerPolicy = b.challengerPolicy;
        this.finalizeABBranch(
          'promoted',
          `challenger 成功率 ${challRate.toFixed(3)} ≥ champion ${champRate.toFixed(3)} + margin ${cfg.promoteMargin}（样本 ${b.challenger.samples} vs ${b.champion.samples}），晋升为新 champion`,
        );
        await this.deployPolicy({ ...challengerPolicy, params: cloneParams(challengerPolicy.params) });
      } else if (champRate >= challRate + cfg.retireMargin) {
        this.finalizeABBranch(
          'retired',
          `challenger 成功率 ${challRate.toFixed(3)} 劣于 champion ${champRate.toFixed(3)}（≥ +${cfg.retireMargin}，样本 ${b.challenger.samples} vs ${b.champion.samples}），淘汰回候选池——champion 保持在线`,
        );
      }
      return; // 劣化与优势都未达阈值：继续分流观察
    }
    // 达样本上限：challenger 必须自证（严格优于 champion 才晋升，否则淘汰）
    if (challRate > champRate) {
      const challengerPolicy = b.challengerPolicy;
      this.finalizeABBranch(
        'promoted',
        `分流样本达上限 ${cfg.maxSamples}，challenger 成功率 ${challRate.toFixed(3)} > champion ${champRate.toFixed(3)}，晋升为新 champion`,
      );
      await this.deployPolicy({ ...challengerPolicy, params: cloneParams(challengerPolicy.params) });
    } else {
      this.finalizeABBranch(
        'retired',
        `分流样本达上限 ${cfg.maxSamples}，challenger 成功率 ${challRate.toFixed(3)} 未严格优于 champion ${champRate.toFixed(3)}，淘汰——champion 保持在线`,
      );
    }
  }

  /** 分支终结统一出口（档案入历史，活跃分支清空） */
  private finalizeABBranch(status: 'promoted' | 'retired', reason: string): void {
    const b = this.abBranch;
    if (!b) return;
    b.status = status;
    b.reason = reason;
    b.decidedAt = Date.now();
    const toStats = (s: { samples: number; successes: number; qualitySum: number }): ABArmStats => ({
      samples: s.samples,
      successRate: s.samples > 0 ? Number((s.successes / s.samples).toFixed(4)) : 0,
      avgQuality: s.samples > 0 ? Number((s.qualitySum / s.samples).toFixed(4)) : 0,
    });
    this.abHistory.push({
      championPolicyId: b.championPolicyId,
      challengerPolicyId: b.challengerPolicy.id,
      challengerParentId: b.challengerParentId,
      startedAt: b.startedAt,
      decidedAt: b.decidedAt,
      status,
      trafficRatio: b.trafficRatio,
      champion: toStats(b.champion),
      challenger: toStats(b.challenger),
      reason,
    });
    if (this.abHistory.length > 50) this.abHistory.shift();
    this.abBranch = undefined;
  }

  /** 1/5 法则自适应步长（runEvolutionCycle 与证书门周期共用） */
  private adaptSigma(hadDeployment: boolean): void {
    this.selectionWindow.push(hadDeployment);
    if (this.selectionWindow.length > 10) this.selectionWindow.shift();
    if (this.selectionWindow.length >= 5) {
      const successRate = this.selectionWindow.filter(Boolean).length / this.selectionWindow.length;
      this.sigmaScale = Math.max(0.25, Math.min(3, this.sigmaScale * (successRate > 0.2 ? 1.25 : 0.85)));
    }
  }

  // ─────────────────────────── 进化周期编排 ───────────────────────────

  /**
   * 运行一轮完整进化周期（变异/交叉 → 沙盒评估 → 择优 → 部署）
   *
   * 自主循环定期调用 / 外部 Tool 手动触发；进化中重复调用返回进行中报告。
   * 周期尾部按 1/5 法则自适应调整变异步长。沙盒全程离线，不阻塞操作环。
   */
  async runEvolutionCycle(sandbox: ISandbox): Promise<EvolutionCycleReport> {
    if (this.evolving) {
      return {
        generation: this.current.generation,
        parentPolicyId: this.current.id,
        candidateOrigins: {},
        candidates: [],
        summary: '跳过：已有进化周期进行中',
      };
    }
    this.evolving = true;
    try {
      const parent = this.getCurrentPolicy();
      const candidates = await this.generateCandidates(parent);
      const reports: EvaluationReport[] = [];
      for (const candidate of candidates) {
        reports.push(await this.evaluateCandidate(candidate, sandbox));
      }
      const best = await this.selectBest(candidates, reports);
      if (best) await this.deployPolicy(best);

      // 1/5 法则自适应步长：近 10 轮部署成功率驱动探索/收敛
      this.adaptSigma(Boolean(best));

      this.totalCycles += 1;
      const bestReport = best ? reports.find((r) => r.policyId === best.id) : undefined;
      const cycle: EvolutionCycleReport = {
        generation: parent.generation + 1,
        parentPolicyId: parent.id,
        candidateOrigins: candidates.reduce<Record<string, number>>((acc, c) => {
          const key = c.origin === 'mutation' && (c.params.rules?.length ?? 0) > 0 ? 'rule-mutation' : c.origin;
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
        candidates: candidates.map((c) => {
          const r = reports.find((x) => x.policyId === c.id);
          return {
            policyId: c.id,
            reward: r?.reward ?? 0,
            gain: r?.gain ?? 0,
            gainLCB: r?.gainLCB,
            deployable: r?.deployable ?? false,
            risks: r?.risks.length ?? 0,
            regressions: r?.regressions.length ?? 0,
          };
        }),
        deployedPolicyId: best?.id,
        summary: best
          ? `第 ${parent.generation + 1} 代：候选 ${candidates.length} 个（${Object.entries(
              candidates.reduce<Record<string, number>>((acc, c) => ((acc[c.origin] = (acc[c.origin] ?? 0) + 1), acc), {}),
            )
              .map(([k, v]) => `${k}×${v}`)
              .join(' + ')}），胜出 ${best.id}（gainLCB ${((bestReport?.gainLCB ?? bestReport?.gain ?? 0)).toFixed(3)}），已热切换进入金丝雀观察`
          : `第 ${parent.generation + 1} 代：候选 ${candidates.length} 个均未达部署门禁（minGain=${this.config.minGain}，LCB 统计），当前策略保持不变（σ×${this.sigmaScale.toFixed(2)}）`,
      };
      this.cycleReports.push(cycle);
      if (this.cycleReports.length > 50) this.cycleReports.shift();
      // 第四轮升级：迁移收益裁决（无迁移记录时零介入——零漂移）
      if (this.transferRecords.length > 0) this.reviewTransfers();
      this.persist();
      this.config.onCycle?.(cycle);
      return cycle;
    } finally {
      this.evolving = false;
    }
  }

  // ─────────────────────────── 内部实现：遗传算子 ───────────────────────────

  /** 高斯变异：数值基因按概率扰动（×sigmaScale）+ 钳制边界；布尔基因按概率翻转；规则基因增/删/改 */
  private mutatePolicy(parent: Policy): Policy {
    const genes = { ...parent.params, rules: [...(parent.params.rules ?? [])] };
    const record = geneRecord(genes);
    for (const key of SCALAR_GENE_KEYS) {
      const value = record[key];
      if (typeof value === 'boolean') {
        if (this.rng() < this.config.booleanFlipRate) record[key] = !value;
        continue;
      }
      if (this.rng() > this.config.mutationRate) continue;
      const bounds = POLICY_GENE_BOUNDS[key];
      const range = bounds.max - bounds.min;
      // 近似高斯（两均匀分布叠加中心化），强度 × 自适应 sigmaScale
      const noise =
        (this.rng() + this.rng() - 1) * this.config.mutationStrength * this.sigmaScale * range;
      let mutated = Number(value) + noise;
      mutated = Math.max(bounds.min, Math.min(bounds.max, mutated));
      record[key] = bounds.integer ? Math.round(mutated) : Number(mutated.toFixed(4));
    }
    // 规则基因变异（增/删/改）
    if (this.rng() < this.config.ruleMutationRate) this.mutateRules(genes);
    const child: Policy = {
      id: `policy-${++this.policyCounter}`,
      version: parent.version + 1,
      type: 'scheduler',
      params: genes,
      origin: 'mutation',
      generation: parent.generation + 1,
      parentId: parent.id,
      createdAt: Date.now(),
    };
    // 第四轮升级：迁移谱系追踪（谱系成员的变异后代并入谱系）
    if (this.transferRecords.length > 0) this.trackTransferLineage([parent.id], child.id);
    return child;
  }

  /** 规则变异：无规则→增加；有规则→随机改一条或删一条 */
  private mutateRules(genes: SchedulerPolicyParams): void {
    const rules = genes.rules ?? [];
    if (rules.length === 0) {
      genes.rules = [this.randomRule()];
      return;
    }
    const roll = this.rng();
    if (roll < 0.4 && rules.length < MAX_POLICY_RULES) {
      genes.rules = [...rules, this.randomRule()];
    } else if (roll < 0.7) {
      genes.rules = rules.slice(0, rules.length - 1); // 删除末位规则
    } else {
      // 修改随机一条的动作幅度
      const idx = Math.floor(this.rng() * rules.length);
      const rule = { ...rules[idx]!, action: { ...rules[idx]!.action } };
      if (rule.action.costWeightDelta !== undefined || rule.action.ensembleForce !== undefined) {
        rule.action.costWeightDelta = clampDelta(
          (rule.action.costWeightDelta ?? 0) + (this.rng() - 0.5) * 0.2,
        );
      } else {
        rule.action.memoryWeightBaseDelta = clampDelta(
          (rule.action.memoryWeightBaseDelta ?? 0) + (this.rng() - 0.5) * 0.2,
        );
      }
      genes.rules = rules.map((r, i) => (i === idx ? rule : r));
    }
  }

  /** 随机合成一条规则（复杂度/特征/任务类型条件 + 随机动作） */
  private randomRule(): PolicyRule {
    const min = Number((this.rng() * 0.8).toFixed(2));
    const taskTypes =
      this.config.knownTaskTypes && this.config.knownTaskTypes.length > 0 && this.rng() < 0.6
        ? [this.config.knownTaskTypes[Math.floor(this.rng() * this.config.knownTaskTypes.length)]!]
        : undefined;
    const roll = this.rng();
    return {
      id: `rule-${++this.policyCounter}-${Math.floor(this.rng() * 10_000)}`,
      when: {
        taskTypes,
        minComplexity: min,
        maxComplexity: Number(Math.min(1, min + 0.2 + this.rng() * 0.3).toFixed(2)),
      },
      action:
        roll < 0.4
          ? { costWeightDelta: clampDelta((this.rng() - 0.5) * 2 * POLICY_RULE_DELTA_BOUNDS.max) }
          : roll < 0.7
            ? { ensembleForce: this.rng() < 0.7 }
            : { decomposeForce: this.rng() < 0.5 },
      priority: Math.floor(this.rng() * 10),
    };
  }

  /** 种群内随机双亲交叉（种群 <2 返回 null） */
  private crossoverRandom(): Policy | null {
    if (this.population.length < 2) return null;
    const i = Math.floor(this.rng() * this.population.length);
    let j = Math.floor(this.rng() * this.population.length);
    if (j === i) j = (j + 1) % this.population.length;
    return this.crossoverPolicies(this.population[i]!, this.population[j]!);
  }

  /** 双亲交叉：标量基因逐位均匀选取 + 规则子集合并（双亲谱系可追溯） */
  private crossoverPolicies(a: Policy, b: Policy): Policy {
    const childParams = { ...a.params, rules: [...(a.params.rules ?? [])] };
    const childRecord = geneRecord(childParams);
    const aRecord = geneRecord(a.params);
    const bRecord = geneRecord(b.params);
    for (const key of SCALAR_GENE_KEYS) {
      childRecord[key] = this.rng() < 0.5 ? aRecord[key] : bRecord[key];
    }
    // 数值基因中点交叉（50% 概率）：在两亲之间取值，平滑探索
    for (const key of ['costWeight', 'memoryWeightBase', 'memoryWeightCap', 'ensembleScoreGap'] as const) {
      if (this.rng() < 0.5) {
        const va = Number(aRecord[key]);
        const vb = Number(bRecord[key]);
        childRecord[key] = Number(((va + vb) / 2).toFixed(4));
      }
    }
    // 规则合并：双亲规则去重合并后截断
    const mergedRules = [...(a.params.rules ?? []), ...(b.params.rules ?? [])];
    const seen = new Set<string>();
    childParams.rules = mergedRules.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).slice(0, MAX_POLICY_RULES);
    const child: Policy = {
      id: `policy-${++this.policyCounter}`,
      version: Math.max(a.version, b.version) + 1,
      type: 'scheduler',
      params: childParams,
      origin: 'crossover',
      generation: Math.max(a.generation, b.generation) + 1,
      parentId: a.id,
      secondaryParentId: b.id,
      createdAt: Date.now(),
    };
    // 第四轮升级：迁移谱系追踪（任一亲代在谱系内 → 交叉后代并入谱系）
    if (this.transferRecords.length > 0) this.trackTransferLineage([a.id, b.id], child.id);
    return child;
  }

  /** 探索者：全基因边界内随机（注入种群多样性，跳出局部最优；origin 专属标记，谱系不误导为变异） */
  private explorerPolicy(parent: Policy): Policy {
    const params = { ...parent.params, rules: [] as PolicyRule[] };
    const record = geneRecord(params);
    for (const key of SCALAR_GENE_KEYS) {
      const bounds = POLICY_GENE_BOUNDS[key];
      const value = bounds.min + this.rng() * (bounds.max - bounds.min);
      record[key] = bounds.integer ? Math.round(value) : Number(value.toFixed(4));
    }
    params.decomposeEnabled = this.rng() < 0.5;
    params.ensembleEnabled = this.rng() < 0.6;
    params.rules = this.rng() < 0.3 ? [this.randomRule()] : [];
    return {
      id: `policy-${++this.policyCounter}`,
      version: parent.version + 1,
      type: 'scheduler',
      params,
      origin: 'explorer',
      generation: parent.generation + 1,
      createdAt: Date.now(),
    };
  }

  // ─────────────────────────── 内部实现：种群 ───────────────────────────

  /** 启动时确保种群含当前策略 */
  private seedPopulation(): void {
    if (this.population.length === 0) {
      this.population = [this.getCurrentPolicy()];
    }
  }

  /**
   * 种群更新（4.0 多样性保持：拥挤去重选择）
   *
   * 候选按适应度竞争入种群，但与已入选个体基因距离 < DIVERSITY_RADIUS 的
   * 近重复个体被跳过（适应度共享的贪婪近似）——种群由「高适应度且彼此
   * 基因相异」的个体构成，避免单一基因型霸占种群导致交叉退化自交。
   * 池内相异个体不足容量时回填近重复（保持容量的降级策略）。
   */
  private updatePopulation(candidates: Policy[]): void {
    const pool = [...this.population];
    for (const candidate of candidates) {
      const report = this.evaluatedReports.get(candidate.id);
      if (!report) continue;
      const fitness = {
        score: report.reward,
        successRate: report.metrics.successRate,
        avgQuality: report.metrics.avgQuality,
        avgLatencyMs: report.metrics.avgLatencyMs,
        totalTokens: report.metrics.totalTokens,
        evaluatedTasks: report.taskStats.replayed + report.taskStats.adversarial,
        evaluatedAt: report.evaluatedAt,
      };
      pool.push({ ...candidate, fitness });
    }
    // 去重（同 id 保留最新）+ 按 fitness.score 降序
    const byId = new Map(pool.map((p) => [p.id, p]));
    const ranked = [...byId.values()].sort((a, b) => (b.fitness?.score ?? -1) - (a.fitness?.score ?? -1));
    const capacity = Math.max(2, this.config.populationSize);

    // 第一遍：适应度降序贪心入选，跳过与已入选个体基因过近的近重复
    const selected: Policy[] = [];
    for (const p of ranked) {
      if (selected.length >= capacity) break;
      if (!selected.some((s) => this.geneDistance(s.params, p.params) < POLICY_DIVERSITY_RADIUS)) selected.push(p);
    }
    // 第二遍：相异个体不足容量时回填（保持种群容量的降级策略）
    for (const p of ranked) {
      if (selected.length >= capacity) break;
      if (!selected.includes(p)) selected.push(p);
    }
    this.population = selected;
  }

  /**
   * 基因距离（0~1）：标量基因归一化绝对距离 + 布尔差异 + 规则集合
   * Jaccard 距离的等权平均——衡量两个策略在基因空间的相异度。
   */
  private geneDistance(a: SchedulerPolicyParams, b: SchedulerPolicyParams): number {
    let total = 0;
    let count = 0;
    for (const key of SCALAR_GENE_KEYS) {
      const bounds = POLICY_GENE_BOUNDS[key];
      const va = a[key];
      const vb = b[key];
      if (typeof va === 'boolean' || typeof vb === 'boolean') {
        total += va === vb ? 0 : 1;
      } else {
        const range = Math.max(1e-9, bounds.max - bounds.min);
        total += Math.min(1, Math.abs(Number(va) - Number(vb)) / range);
      }
      count += 1;
    }
    const ra = new Set((a.rules ?? []).map((r) => r.id));
    const rb = new Set((b.rules ?? []).map((r) => r.id));
    if (ra.size > 0 || rb.size > 0) {
      let inter = 0;
      for (const id of ra) if (rb.has(id)) inter += 1;
      const union = new Set([...ra, ...rb]).size;
      total += 1 - inter / union;
      count += 1;
    }
    return count === 0 ? 0 : total / count;
  }

  // ─────────────────────────── 持久化 ───────────────────────────

  /** 持久化进化状态（原子写；失败不阻断进化流程） */
  private persist(): void {
    const persistPath = this.config.persistPath;
    if (!persistPath) return;
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      const payload = {
        version: 2,
        currentPolicy: this.current,
        previousPolicy: this.previousPolicy,
        deployedHistory: this.deployedHistory.map((p) => ({ ...p, params: cloneParams(p.params) })),
        population: this.population.map((p) => ({ ...p, params: cloneParams(p.params) })),
        sigmaScale: this.sigmaScale,
        canary: this.canary,
        totalCandidatesEvaluated: this.totalCandidatesEvaluated,
        totalCycles: this.totalCycles,
        cycleReports: this.cycleReports.slice(-20),
        // 策略 id 计数器一并落盘：重启后新策略 id 从恢复值续增，不与
        // 恢复的种群/历史撞 id（loadPersisted 侧还会扫 id 后缀取 max 兜底）
        policyCounter: this.policyCounter,
        // 第三轮升级：证书门台账与吊销名单一并落盘（跨重启可审计）
        certificateLedger: this.certificateLedger.slice(-100),
        revokedCertificates: [...this.revokedCertificates],
        // 第四轮升级：迁移台账（含谱系 id 集）与 A/B 分支状态一并落盘
        transferRecords: this.transferRecords.map((t) => ({ record: t.record, lineageIds: [...t.lineageIds] })),
        abBranch: this.abBranch
          ? { ...this.abBranch, challengerPolicy: { ...this.abBranch.challengerPolicy, params: cloneParams(this.abBranch.challengerPolicy.params) } }
          : undefined,
        abHistory: this.abHistory.slice(-20),
        savedAt: Date.now(),
      };
      const tmp = `${persistPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
      fs.renameSync(tmp, persistPath);
    } catch {
      /* 持久化失败静默（进化流程不受影响） */
    }
  }

  /** 启动时恢复上次部署策略与种群（无持久化文件或损坏时保持基准） */
  private loadPersisted(): void {
    const persistPath = this.config.persistPath;
    if (!persistPath || !fs.existsSync(persistPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(persistPath, 'utf-8')) as {
        currentPolicy: Policy;
        previousPolicy?: Policy;
        deployedHistory?: Policy[];
        population?: Policy[];
        sigmaScale?: number;
        canary?: CanaryState;
        totalCandidatesEvaluated?: number;
        totalCycles?: number;
        policyCounter?: number;
        certificateLedger?: CertificateDecision[];
        revokedCertificates?: string[];
        transferRecords?: Array<{ record: TransferRecord; lineageIds?: string[] }>;
        abBranch?: {
          championPolicyId: string;
          challengerPolicy: Policy;
          challengerParentId: string;
          startedAt: number;
          trafficRatio: number;
          champion: { samples: number; successes: number; qualitySum: number };
          challenger: { samples: number; successes: number; qualitySum: number };
          status: 'active' | 'promoted' | 'retired';
        };
        abHistory?: ABBranchOutcome[];
      };
      if (parsed.currentPolicy?.params) {
        this.current = { ...parsed.currentPolicy, params: normalizePolicyParams(parsed.currentPolicy.params) };
        this.deployedHistory = parsed.deployedHistory ?? [this.current];
        this.population = (parsed.population ?? []).filter((p) => p?.params).map((p) => ({ ...p, params: normalizePolicyParams(p.params) }));
        this.previousPolicy = parsed.previousPolicy ? { ...parsed.previousPolicy, params: normalizePolicyParams(parsed.previousPolicy.params) } : undefined;
        this.sigmaScale = typeof parsed.sigmaScale === 'number' ? Math.max(0.25, Math.min(3, parsed.sigmaScale)) : 1;
        this.canary = parsed.canary?.status === 'active' ? parsed.canary : undefined;
        this.totalCandidatesEvaluated = parsed.totalCandidatesEvaluated ?? 0;
        this.totalCycles = parsed.totalCycles ?? 0;
        // 恢复策略 id 计数器：取持久化值与已恢复集合中出现过的
        // `policy-N` 数字后缀最大值之 max——旧版持久化文件没有计数器
        // 字段时，仍能从恢复的种群/部署历史/评估谱系兜底推出不撞 id 的起点
        const persistedCounter =
          typeof parsed.policyCounter === 'number' && Number.isFinite(parsed.policyCounter) && parsed.policyCounter > 0
            ? Math.floor(parsed.policyCounter)
            : 0;
        let maxIdSuffix = 0;
        for (const policy of [this.current, this.previousPolicy, ...this.deployedHistory, ...this.population]) {
          if (!policy?.id) continue;
          const match = /^policy-(\d+)$/.exec(policy.id);
          if (match) maxIdSuffix = Math.max(maxIdSuffix, Number(match[1]));
        }
        this.policyCounter = Math.max(persistedCounter, maxIdSuffix);
        // 第三轮升级：恢复证书门台账与吊销名单（被吊销的策略重启后仍被拒绝复证）
        this.certificateLedger = Array.isArray(parsed.certificateLedger) ? parsed.certificateLedger.filter((d) => d?.policyId && d.verdict) : [];
        this.revokedCertificates = new Set(Array.isArray(parsed.revokedCertificates) ? parsed.revokedCertificates.filter((id) => typeof id === 'string') : []);
        // 第四轮升级：恢复迁移台账（谱系 id 集合重建）与 A/B 分支状态
        if (Array.isArray(parsed.transferRecords)) {
          this.transferRecords = parsed.transferRecords
            .filter((t) => t?.record?.derivedPolicyId)
            .map((t) => ({
              record: { ...t.record, evaluations: Array.isArray(t.record.evaluations) ? t.record.evaluations : [] },
              lineageIds: new Set<string>([t.record.derivedPolicyId, ...(t.lineageIds ?? [])]),
            }));
        }
        if (parsed.abBranch?.challengerPolicy?.params) {
          const saved = parsed.abBranch;
          this.abBranch = {
            ...saved,
            challengerPolicy: { ...saved.challengerPolicy, params: normalizePolicyParams(saved.challengerPolicy.params) },
            status: saved.status === 'active' ? 'active' : saved.status,
          };
          if (!this.abCfg) this.attachABBranching({ challengerTraffic: saved.trafficRatio });
        }
        this.abHistory = Array.isArray(parsed.abHistory) ? parsed.abHistory.filter((h) => h?.challengerPolicyId) : [];
        // 恢复后立即热切换到上次策略（无需重启即恢复进化成果）
        this.config.onDeploy?.(this.getCurrentPolicy());
      }
    } catch {
      /* 损坏文件忽略，保持基准策略 */
    }
  }
}

// ─────────────────────────── 工具函数 ───────────────────────────

function clampDelta(v: number): number {
  return Number(Math.max(POLICY_RULE_DELTA_BOUNDS.min, Math.min(POLICY_RULE_DELTA_BOUNDS.max, v)).toFixed(4));
}

function cloneParams(params: SchedulerPolicyParams): SchedulerPolicyParams {
  return { ...params, rules: (params.rules ?? []).map((r) => ({ ...r, when: { ...r.when }, action: { ...r.action } })) };
}
