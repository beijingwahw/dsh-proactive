/**
 * sandbox.ts — 安全沙盒（第三阶段质级升级：校准 + 多种子统计门禁）
 *
 * 职责：
 * - 历史任务回放：从长期记忆的任务模式中提取历史任务集，重放评估策略变体
 * - 对抗任务合成：生成极端复杂度/冷启动/特征密集/超长文本等压力任务，测鲁棒性
 * - 策略模拟执行：PolicySimulator 按策略参数（评分函数/分解规则/组合逻辑/规则基因组）
 *   在离线模型快照上模拟调度与产出（质量/延迟/成本），形成真实选择压力
 * - 评估报告：收益（reward/gain/gainLCB）+ 风险（risks）+ 回归（regressions）→ 部署门禁
 *
 * 质级升级点：
 * 1. 历史校准（calibration）：模型×任务维度的真实历史平均质量锚定模拟 baseFit，
 *    沙盒不再是纯合成世界——操作环真实结果持续校准模拟器，保真度随使用提升
 * 2. 规则基因组选择压力：simulate 内以完整任务上下文（类型/复杂度/特征）
 *    解析有效参数（resolveEffectiveParams），规则基因在沙盒中承受真实淘汰
 * 3. 多种子统计门禁：评估在 N 个噪声种子上重复，产出 gain 均值/标准差/
 *    置信下界（LCB）；deployable 要求 gainLCB ≥ 0，防止单种子过拟合的
 *    脆弱策略混入操作环
 *
 * 隔离性保证：
 * - 纯内存计算，不调用 LLM、不写记忆库、不接触操作环调度器
 * - 离线可运行（构造沙盒只需模型状态快照 + 任务集 + 校准表，均可注入）
 * - 质量噪声为「任务×模型×种子」哈希稳定噪声：与评估顺序/策略无关 → 候选与
 *   baseline 在同一评估内看到完全相同的噪声序列（公平对比），且确定可复现
 */

import type {
  EvaluationReport,
  Policy,
  PolicyEvaluationMetrics,
  SandboxTask,
  SchedulerPolicyParams,
  SimModelStatus,
} from './policy-types.js';
import { policyParamsWithinBounds, resolveEffectiveParams, scoreModelWithPolicy } from './policy-types.js';
import type { LongTermMemory } from '../memory/long-term-memory.js';
import type { ISandbox } from '../contracts.js';
import { BAYES_PRIOR_STRENGTH } from '../core/evidence.js';

// 第二轮创世纪 94.0：仿真校准（沙盒风洞修正——sim-to-real 域差进入部署门禁的数学）
import { windTunnelAudit, type WindTunnelView } from '../engines-frontier/autonomy25.js';

// ─────────────────────────── 校准数据 ───────────────────────────

/**
 * 模型×任务校准条目：用操作环真实历史锚定沙盒模拟
 *
 * observedAvgQuality = 记忆库模型画像中该模型在该任务类型的历史平均质量分；
 * samples = 历史调用次数（≥ minCalibrationSamples 才启用锚定）。
 *
 * 3.0 并行旁路（贝叶斯化）：posteriorQuality / effectiveSamples / drift
 * 由 buildCalibrationFromMemory 从统一证据内核填充——手工/旧格式条目
 * 缺省时 calibratedFit 回退 legacy 口径（observedAvgQuality × samples），
 * 行为与升级前逐位一致。
 */
export interface SimCalibrationEntry {
  observedAvgQuality: number;
  samples: number;
  /** 3.0：贝叶斯后验质量（时间加权 EMA 质量向 0.5 先验收缩；小样本自动保守） */
  posteriorQuality?: number;
  /** 3.0：时间衰减后有效样本量（校准权重依据——旧证据自动让位） */
  effectiveSamples?: number;
  /** 3.0：近期能力漂移（加权成功率 − 裸成功率；沙盒感知模型修复/退化） */
  drift?: number;
}

/** 校准表：modelId → taskType → 条目 */
export type SimCalibration = Record<string, Record<string, SimCalibrationEntry>>;

/** 启用校准锚定所需的最小历史样本数 */
export const MIN_CALIBRATION_SAMPLES = 3;

/**
 * 从长期记忆构建校准表（index.ts 注入沙盒；进化周期之间可刷新）
 *
 * 3.0 贝叶斯化：在保留裸口径（observedAvgQuality/samples）的同时，
 * 从 getBayesianEstimate 附带时间加权证据视图——
 * - posteriorQuality = (n·emaQuality + 1·0.5) / (n+1)：近期敏感 + 小样本收缩
 * - effectiveSamples：30 天半衰期衰减后的等效观测数（校准权重依据）
 * - drift：能力漂移让沙盒感知「模型变了」（配合 calibratedFit 漂移倾斜）
 */
export function buildCalibrationFromMemory(memory: LongTermMemory): SimCalibration {
  const calibration: SimCalibration = {};
  for (const profile of memory.getAllModelProfiles()) {
    const perTask: Record<string, SimCalibrationEntry> = {};
    for (const [taskType, history] of Object.entries(profile.taskHistory)) {
      if (history.totalCalls >= MIN_CALIBRATION_SAMPLES && history.avgQualityScore > 0) {
        const entry: SimCalibrationEntry = { observedAvgQuality: history.avgQualityScore, samples: history.totalCalls };
        const est = memory.getBayesianEstimate(profile.id, taskType);
        if (est) {
          const n = Math.max(0, est.effectiveSamples);
          entry.posteriorQuality = Number(((n * est.emaQuality + BAYES_PRIOR_STRENGTH * 0.5) / (n + BAYES_PRIOR_STRENGTH)).toFixed(6));
          entry.effectiveSamples = Number(n.toFixed(6));
          entry.drift = est.drift;
        }
        perTask[taskType] = entry;
      }
    }
    if (Object.keys(perTask).length > 0) calibration[profile.id] = perTask;
  }
  return calibration;
}

// ─────────────────────────── 沙盒配置 ───────────────────────────

export interface SandboxConfig {
  /** 综合收益中成功率的权重（缺省 0.35） */
  successWeight?: number;
  /** 质量权重（缺省 0.35） */
  qualityWeight?: number;
  /** 成本权重（缺省 0.2；延迟权重 = 1 - 其余三项） */
  costWeight?: number;
  /** 成本归一化基准：单任务 token 数达到该值视为满成本（缺省 4000） */
  costNormTokens?: number;
  /** 延迟归一化基准：单任务延迟达到该值视为满延迟（缺省 5000ms） */
  latencyNormMs?: number;
  /** 模拟成功质量阈值（缺省 0.55） */
  successQualityThreshold?: number;
  /** 成功率的最大允许回归幅度（缺省 0.05） */
  regressionSuccessTolerance?: number;
  /** 质量的最大允许回归幅度（缺省 0.03） */
  regressionQualityTolerance?: number;
  /** token 成本的最大允许涨幅（相对 baseline，缺省 1.5 倍） */
  regressionCostTolerance?: number;
  /** 多种子评估的种子数（缺省 3；1 = 关闭统计门禁） */
  evaluationSeeds?: number;
  /** 历史校准表（缺省空 = 纯合成模拟） */
  calibration?: SimCalibration;
}

const DEFAULT_SANDBOX_CONFIG: Required<SandboxConfig> = {
  successWeight: 0.35,
  qualityWeight: 0.35,
  costWeight: 0.2,
  costNormTokens: 4_000,
  latencyNormMs: 5_000,
  successQualityThreshold: 0.55,
  regressionSuccessTolerance: 0.05,
  regressionQualityTolerance: 0.03,
  regressionCostTolerance: 1.5,
  evaluationSeeds: 3,
  calibration: {},
};

// ─────────────────────────── 模拟执行 ───────────────────────────

/** 单任务模拟结果 */
interface TaskSimulation {
  success: boolean;
  quality: number;
  latencyMs: number;
  tokens: number;
  decomposed: boolean;
  ensembleUsed: boolean;
  chosenModels: string[];
}

/**
 * 策略模拟执行器
 *
 * 给定策略参数 + 任务 + 模型快照，模拟「上下文规则解析 → 评分 → 分解决策 →
 * 选模型 → 组合决策 → 产出」：
 * - 有效参数：resolveEffectiveParams(params, task) —— 规则基因在此承受选择压力
 * - 产出质量 = 校准后能力适配 − 复杂度惩罚 + 稳定噪声（ensemble 取均值 + 多样性增益）
 * - 分解降低单节点复杂度（子复杂度 = c / n^0.7），但增加协调开销（延迟 +15%、token +10%）
 * - 评分调用与操作环共享 scoreModelWithPolicy → 沙盒保真
 */
export class PolicySimulator {
  private models: SimModelStatus[];
  private config: Required<SandboxConfig>;
  private modelIndex: Map<string, SimModelStatus>;

  constructor(models: SimModelStatus[], config?: SandboxConfig) {
    this.models = [...models];
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
    this.modelIndex = new Map(this.models.map((m) => [m.id, m]));
  }

  /** 模型快照（只读） */
  getModels(): SimModelStatus[] {
    return [...this.models];
  }

  /**
   * 校准后的能力适配分：真实历史锚定合成画像
   *
   * 3.0 贝叶斯口径（条目携带证据字段时）：
   * - 权重 w = min(0.6, effectiveSamples/50)：时间衰减后的等效样本——
   *   旧证据自动让位，长期不用的模型不再被陈旧历史过度锚定
   * - 锚定值 = posteriorQuality：近期敏感 EMA + 小样本向先验收缩
   * - 漂移倾斜：|drift| 大的模型按近期能力变化微调（±0.05 钳制），
   *   「模型修好了 / 模型退化了」在沙盒中被真实感知
   *
   * 兼容：旧格式条目（无证据字段）走 legacy 口径，行为与升级前逐位一致。
   */
  private calibratedFit(modelId: string, taskType: string, syntheticFit: number): number {
    const entry = this.config.calibration[modelId]?.[taskType];
    if (!entry) return syntheticFit;
    const n = entry.effectiveSamples ?? entry.samples;
    const w = Math.min(0.6, n / 50);
    const anchor = entry.posteriorQuality ?? entry.observedAvgQuality;
    const blended = syntheticFit * (1 - w) + anchor * w;
    const driftTilt = Math.max(-0.05, Math.min(0.05, (entry.drift ?? 0) * 0.25));
    return Number((blended + driftTilt).toFixed(6));
  }

  /**
   * 稳定噪声（FNV-1a 哈希 → [-0.05, 0.05)）
   *
   * 同一「任务×模型×种子」组合恒定同一噪声：策略变体与 baseline 在同一任务上
   * 的随机扰动完全一致，评估差异纯粹来自策略本身（选择压力不失真）。
   */
  private stableNoise(seed: string, salt: number): number {
    let h = 2166136261 ^ salt;
    for (let i = 0; i < seed.length; i += 1) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const frac = ((h >>> 0) % 10_000) / 10_000;
    return (frac - 0.5) * 0.1;
  }

  /** 按策略给全部候选模型评分（降序；使用上下文有效参数） */
  rankModels(params: SchedulerPolicyParams, task: SandboxTask): Array<{ id: string; score: number }> {
    const effective = resolveEffectiveParams(params, {
      taskType: task.taskType,
      complexity: task.complexity,
      features: task.features,
    });
    return this.models
      .map((m) => ({
        id: m.id,
        score: scoreModelWithPolicy(effective, {
          taskScore: m.taskScores[task.taskType] ?? m.taskScores['general'] ?? 0.5,
          // 沙盒无记忆画像历史（策略比较在同等条件下进行）→ 记忆项中性
          memoryScore: 0.5,
          memoryCalls: 0,
          avgQuality: 0.5,
          avgTokens: m.avgTokens,
        }),
      }))
      .sort((a, b) => b.score - a.score);
  }

  /** 模拟执行单个任务（seedSalt 区分多种子轮次） */
  simulate(params: SchedulerPolicyParams, task: SandboxTask, seedSalt = 0): TaskSimulation {
    const ranked = this.rankModels(params, task);
    if (ranked.length === 0) {
      throw new Error('沙盒内无可用模型');
    }
    const effective = resolveEffectiveParams(params, {
      taskType: task.taskType,
      complexity: task.complexity,
      features: task.features,
    });

    // ── 分解决策：复杂度超阈值 → 拆为 n 个子任务（规则可覆盖开关） ──
    const decomposed =
      effective.decomposeEnabled && task.complexity >= effective.decomposeComplexityThreshold;
    const subtaskCount = decomposed
      ? Math.max(
          1,
          Math.min(effective.decomposeMaxSubtasks, Math.ceil(task.complexity * effective.decomposeMaxSubtasks)),
        )
      : 1;
    // 分解降低单节点复杂度（次线性收益），但存在协调开销
    const subComplexity = task.complexity / Math.pow(subtaskCount, 0.7);

    // ── 组合决策：最高分与次高分差距 < gap 且模型数足够 → 集成（规则可覆盖开关） ──
    const ensembleUsed =
      effective.ensembleEnabled && ranked.length >= 2 && ranked[0]!.score - ranked[1]!.score < effective.ensembleScoreGap;
    const ensembleSize = ensembleUsed ? Math.min(effective.ensembleMaxModels, ranked.length) : 1;
    const chosen = ranked.slice(0, ensembleSize).map((r) => r.id);

    // ── 产出模拟 ──
    let qualitySum = 0;
    let latencyMax = 0;
    let tokensTotal = 0;
    for (const modelId of chosen) {
      const model = this.modelIndex.get(modelId);
      if (!model) throw new Error(`策略选中了沙盒外的模型: ${modelId}`);
      const syntheticFit = model.taskScores[task.taskType] ?? model.taskScores['general'] ?? 0.5;
      const baseFit = this.calibratedFit(modelId, task.taskType, syntheticFit);
      // 复杂度惩罚：模型能力越弱、任务越复杂，惩罚越大；噪声按「任务×模型×种子」指纹稳定派生
      const noise = this.stableNoise(`${task.taskType}|${task.complexity}|${task.length}|${modelId}`, seedSalt);
      const quality = Math.max(0, Math.min(1, baseFit - subComplexity * (1 - baseFit) * 0.5 + noise));
      qualitySum += quality;
      latencyMax = Math.max(latencyMax, model.avgLatencyMs * (1 + subComplexity));
      tokensTotal += model.avgTokens * (1 + subComplexity * 0.5) * (1 + task.length / 50_000);
    }

    let quality = qualitySum / ensembleSize;
    if (ensembleUsed) quality = Math.min(1, quality + 0.05); // 多样性融合增益

    const success = quality >= this.config.successQualityThreshold;
    const coordinationOverhead = decomposed ? 1.15 : 1;
    const latency = latencyMax * coordinationOverhead;
    const tokens = tokensTotal * subtaskCount * (decomposed ? 1.1 : 1);

    return { success, quality, latencyMs: latency, tokens: Math.round(tokens), decomposed, ensembleUsed, chosenModels: chosen };
  }
}

// ─────────────────────────── 对抗任务合成 ───────────────────────────

/**
 * 生成合成对抗任务（测鲁棒性）
 *
 * 四类压力模式：
 * 1. 极端复杂：高复杂度 + 多特征 + 超长文本（压测分解与集成决策、规则条件匹配）
 * 2. 冷启动：从未见过的任务类型（压测评分函数的缺省路径）
 * 3. 特征密集：特征标签爆炸（压测规则特征条件匹配）
 * 4. 极简任务：低复杂度短文本（压测过度调度/过度分解）
 *
 * （第三轮升级注：固定难度版本保留为兼容口径——难度自适应见 AdversarialCurriculum）
 */
export function generateAdversarialTasks(knownTaskTypes: string[] = [], rng: () => number = Math.random): SandboxTask[] {
  const types = knownTaskTypes.length > 0 ? knownTaskTypes : ['code-generation'];
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;
  return [
    {
      taskType: pick(types),
      complexity: 0.95 + rng() * 0.05,
      features: ['code', 'review', 'test', 'documentation'],
      length: 80_000,
      source: 'adversarial',
      label: '极端复杂任务',
    },
    {
      taskType: `unseen-${Math.floor(rng() * 1_000_000)}`,
      complexity: 0.5 + rng() * 0.3,
      features: [],
      length: 2_000,
      source: 'adversarial',
      label: '冷启动任务',
    },
    {
      taskType: pick(types),
      complexity: 0.7 + rng() * 0.2,
      features: ['code', 'review', 'test', 'analysis', 'translation', 'documentation'],
      length: 30_000,
      source: 'adversarial',
      label: '特征密集任务',
    },
    {
      taskType: pick(types),
      complexity: 0.05 + rng() * 0.1,
      features: [],
      length: 120,
      source: 'adversarial',
      label: '极简任务',
    },
  ];
}

// ─────────────────────────── 域偏移任务生成（第四轮升级：跨任务迁移的目标任务构造） ───────────────────────────

/** 域偏移选项（源任务分布 → 目标任务分布的确定性变换） */
export interface DomainShiftOptions {
  /** 复杂度整体偏移（−0.5~0.5；正 = 目标任务更复杂；缺省 0.15） */
  complexityShift?: number;
  /** 复杂度逐任务抖动半径（缺省 0.05） */
  complexityJitter?: number;
  /** 文本长度缩放（缺省 1.2） */
  lengthScale?: number;
  /** 特征标签丢弃概率（缺省 0——特征分布保持） */
  featureDropRate?: number;
  /** 随机源（测试可注入确定性实现；缺省 Math.random） */
  rng?: () => number;
}

/**
 * 域偏移任务集：源任务分布的整体平移（跨任务迁移实验的目标任务构造器）
 *
 * 与对抗任务合成的区别：generateAdversarialTasks 造「极端压力点」，
 * 本函数造「另一个任务域」——同一批任务类型、同一模型池可用，但
 * 复杂度/长度分布整体平移：目标任务与源任务既不相同（冷启动有真实
 * 差距），又相关（源任务学到的结构性基因——如组合逻辑——仍然适用）。
 *
 * 这是第四轮「跨任务策略迁移」的实验基础设施：源任务沙盒（原任务集）
 * → exportTransferDonors 导出优秀策略 → 目标任务沙盒（本函数产物）
 * → importTransferredPolicy 注入微调起点 → 迁移收益 vs 冷启动对照。
 * 确定性：注入 rng 后同参数同输出。
 */
export function generateDomainShiftedTasks(base: ReadonlyArray<SandboxTask>, options?: DomainShiftOptions): SandboxTask[] {
  const shift = Math.max(-0.5, Math.min(0.5, options?.complexityShift ?? 0.15));
  const jitter = Math.max(0, Math.min(0.3, options?.complexityJitter ?? 0.05));
  const lengthScale = Math.max(0.1, options?.lengthScale ?? 1.2);
  const dropRate = Math.max(0, Math.min(1, options?.featureDropRate ?? 0));
  const rng = options?.rng ?? Math.random;
  return base.map((task, index) => {
    const jittered = shift + (rng() * 2 - 1) * jitter;
    const complexity = Math.max(0.02, Math.min(0.99, task.complexity + jittered));
    return {
      taskType: task.taskType,
      complexity: Number(complexity.toFixed(3)),
      features: dropRate > 0 ? task.features.filter(() => rng() >= dropRate) : [...task.features],
      length: Math.max(100, Math.round(task.length * lengthScale)),
      source: task.source,
      label: `${task.label ?? task.taskType}（域偏移 #${index + 1}：c=${complexity.toFixed(2)}）`,
    };
  });
}

// ─────────────────────────── 对抗课程（第三轮升级：难度自适应 + 边界案例挖掘） ───────────────────────────

/** 历史失败模式探针（边界案例挖掘的采样锚点） */
export interface FailureModeProbe {
  taskType: string;
  /** 失败发生处的复杂度（0~1） */
  complexity: number;
  /** 失败现场的典型特征标签（缺省用密集默认集） */
  features?: string[];
  /** 该模式累计失败次数（采样权重；缺省 1） */
  failures?: number;
}

/** 对抗课程配置 */
export interface AdversarialCurriculumOptions {
  /** 已知任务类型池（缺省 ['code-generation']） */
  knownTaskTypes?: string[];
  /** 随机源（测试可注入确定性实现） */
  rng?: () => number;
  /** 初始难度档（0~1，缺省 0.5） */
  initialDifficulty?: number;
  /** 难度调整步长（缺省 0.12） */
  difficultyStep?: number;
  /** 连续成功 N 次后加难（掌握门限，缺省 2） */
  successStreakToHarden?: number;
  /** 连续失败 N 次后减难（防挫折回退，缺省 2） */
  failureStreakToSoften?: number;
  /** 难度下限（缺省 0.05） */
  minDifficulty?: number;
  /** 难度上限（缺省 0.98） */
  maxDifficulty?: number;
  /** 历史失败模式集（空 = 关闭边界案例挖掘） */
  failureModes?: FailureModeProbe[];
  /** 边界案例采样占比（0~1，缺省 0.35） */
  boundaryMiningRate?: number;
  /** 边界案例复杂度抖动半径（缺省 0.08） */
  boundaryJitter?: number;
}

/** 对抗课程运行报告（学习曲线可观测） */
export interface AdversarialCurriculumReport {
  /** 当前难度档（0~1） */
  difficulty: number;
  /** 累计加难次数 */
  hardened: number;
  /** 累计减难次数 */
  softened: number;
  /** 最近窗口成功率（学习前沿读数） */
  successRate: number;
  /** 增益窗口累计 Σ 4·p̂·(1−p̂)（59.0 倒 U 增益定律的滚动累计） */
  frontierGain: number;
  /** 累计生成任务数 */
  generated: number;
  /** 其中边界案例挖掘产物数 */
  boundaryMined: number;
  /** 难度轨迹（每代一档，审计学习曲线） */
  difficultyTrail: number[];
}

/**
 * 对抗课程——难度自适应的对抗任务生成器（59.0 课程思想在沙盒侧的自实现）
 *
 * 升级前的根本局限：generateAdversarialTasks 的四类压力模板是**固定难度**的
 * ——对当前策略太易（全过，练了等于没练）或太难（全败，无信号可学）都
 * 由同一批任务反复产生，选择压力浪费在能力两端。
 *
 * 升级机制：
 * 1. **难度自适应（掌握门限状态机）**：任务复杂度由当前难度档 d 驱动
 *    （模板复杂度 = 基线 + d × 跨度）；连续 successStreakToHarden 次成功
 *    → 加难（d += step，任务更难）；连续 failureStreakToSoften 次失败
 *    → 减难（退一级不是惩罚，是回到有增益的地方）——生成器始终把
 *    被测策略骑在「能力边缘」（59.0 增益窗口 4p(1−p) 的峰值带）。
 * 2. **边界案例挖掘**：以 boundaryMiningRate 概率从历史失败模式
 *    （taskType × complexity × features）附近采样（复杂度 ± jitter），
 *    失败密集处采样密度加大——回归测试式的对抗压力集中在真实弱点
 *    附近，而非均匀撒网。
 * 3. **学习曲线可观测**：difficultyTrail / frontierGain / successRate
 *    输出完整学习曲线（对照实验：自适应 vs 固定难度的前沿增益差）。
 *
 * 兼容：固定难度口径 generateAdversarialTasks 原样保留（零漂移）。
 */
export class AdversarialCurriculum {
  private types: string[];
  private rng: () => number;
  private difficulty: number;
  private readonly step: number;
  private readonly hardenStreak: number;
  private readonly softenStreak: number;
  private readonly minDifficulty: number;
  private readonly maxDifficulty: number;
  private readonly failureModes: FailureModeProbe[];
  private readonly boundaryMiningRate: number;
  private readonly boundaryJitter: number;
  private successStreak = 0;
  private failureStreak = 0;
  private hardened = 0;
  private softened = 0;
  private outcomes: boolean[] = [];
  private frontierGain = 0;
  private generated = 0;
  private boundaryMinedCount = 0;
  private difficultyTrail: number[] = [];

  constructor(options?: AdversarialCurriculumOptions) {
    this.types = options?.knownTaskTypes && options.knownTaskTypes.length > 0 ? [...options.knownTaskTypes] : ['code-generation'];
    this.rng = options?.rng ?? Math.random;
    this.difficulty = clamp01(options?.initialDifficulty ?? 0.5);
    this.step = Math.max(0.01, Math.min(0.5, options?.difficultyStep ?? 0.12));
    this.hardenStreak = Math.max(1, Math.floor(options?.successStreakToHarden ?? 2));
    this.softenStreak = Math.max(1, Math.floor(options?.failureStreakToSoften ?? 2));
    this.minDifficulty = Math.max(0.01, Math.min(0.5, options?.minDifficulty ?? 0.05));
    this.maxDifficulty = Math.max(this.minDifficulty + 0.01, Math.min(1, options?.maxDifficulty ?? 0.98));
    this.failureModes = (options?.failureModes ?? []).filter((m) => m && typeof m.taskType === 'string' && Number.isFinite(m.complexity));
    this.boundaryMiningRate = Math.max(0, Math.min(1, options?.boundaryMiningRate ?? 0.35));
    this.boundaryJitter = Math.max(0.001, Math.min(0.3, options?.boundaryJitter ?? 0.08));
    this.difficultyTrail.push(this.difficulty);
  }

  /** 当前难度档（0~1） */
  getDifficulty(): number {
    return this.difficulty;
  }

  /** 历史失败模式（只读快照） */
  getFailureModes(): FailureModeProbe[] {
    return this.failureModes.map((m) => ({ ...m, features: m.features ? [...m.features] : undefined }));
  }

  /**
   * 生成一批对抗任务（难度自适应 + 边界案例挖掘）
   *
   * 模板沿用四类压力模式（极端复杂/冷启动/特征密集/极简），但复杂度由
   * 当前难度档线性驱动（d=0 → 模板下界，d=1 → 模板上界）；边界案例
   * 任务按概率替换生成，标签「边界案例挖掘」并在 curriculum 元数据中
   * 标记，供评估报告区分来源。
   */
  generate(count = 4): SandboxTask[] {
    const total = Math.max(1, Math.floor(count));
    const tasks: SandboxTask[] = [];
    for (let i = 0; i < total; i += 1) {
      const mode = i % 4;
      // 边界案例挖掘：失败模式非空且掷中概率 → 在历史失败现场附近采样
      if (this.failureModes.length > 0 && this.rng() < this.boundaryMiningRate) {
        tasks.push(this.mineBoundaryCase());
        continue;
      }
      const d = this.difficulty;
      const pickType = this.types[Math.floor(this.rng() * this.types.length)] ?? 'code-generation';
      if (mode === 0) {
        tasks.push({
          taskType: pickType,
          complexity: round3(0.55 + 0.44 * d),
          features: ['code', 'review', 'test', 'documentation'],
          length: Math.round(20_000 + 70_000 * d),
          source: 'adversarial',
          label: '极端复杂任务',
          curriculum: { difficulty: round3(d), boundaryMined: false, mode: 'extreme' },
        });
      } else if (mode === 1) {
        tasks.push({
          taskType: `unseen-${Math.floor(this.rng() * 1_000_000)}`,
          complexity: round3(0.3 + 0.5 * d),
          features: [],
          length: 2_000,
          source: 'adversarial',
          label: '冷启动任务',
          curriculum: { difficulty: round3(d), boundaryMined: false, mode: 'cold-start' },
        });
      } else if (mode === 2) {
        tasks.push({
          taskType: pickType,
          complexity: round3(0.4 + 0.5 * d),
          features: ['code', 'review', 'test', 'analysis', 'translation', 'documentation'],
          length: Math.round(10_000 + 30_000 * d),
          source: 'adversarial',
          label: '特征密集任务',
          curriculum: { difficulty: round3(d), boundaryMined: false, mode: 'feature-dense' },
        });
      } else {
        tasks.push({
          taskType: pickType,
          complexity: round3(0.05 + 0.15 * d),
          features: [],
          length: Math.round(100 + 60 * d),
          source: 'adversarial',
          label: '极简任务',
          curriculum: { difficulty: round3(d), boundaryMined: false, mode: 'minimal' },
        });
      }
    }
    this.generated += tasks.length;
    return tasks;
  }

  /** 边界案例挖掘：在历史失败模式附近采样（失败次数加权 + 复杂度抖动） */
  private mineBoundaryCase(): SandboxTask {
    // 失败次数加权选择（失败密集处采样密度大——回归压力集中真实弱点）
    const weights = this.failureModes.map((m) => Math.max(0.5, m.failures ?? 1));
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    let roll = this.rng() * totalWeight;
    let chosen = this.failureModes[0]!;
    for (let i = 0; i < this.failureModes.length; i += 1) {
      roll -= weights[i]!;
      if (roll <= 0) {
        chosen = this.failureModes[i]!;
        break;
      }
    }
    const jitter = (this.rng() * 2 - 1) * this.boundaryJitter;
    const complexity = Math.max(0.02, Math.min(0.99, chosen.complexity + jitter));
    this.boundaryMinedCount += 1;
    return {
      taskType: chosen.taskType,
      complexity: round3(complexity),
      features: chosen.features && chosen.features.length > 0 ? [...chosen.features] : ['code', 'analysis'],
      length: Math.round(4_000 + complexity * 20_000),
      source: 'adversarial',
      label: '边界案例挖掘',
      curriculum: { difficulty: round3(this.difficulty), boundaryMined: true, mode: 'boundary' },
    };
  }

  /**
   * 回报一条任务执行结果（驱动难度自适应）
   *
   * 掌握门限状态机：连续成功 hardenStreak 次 → 加难；连续失败
   * softenStreak 次 → 减难；难度轨迹入档（学习曲线）。同时滚动
   * 维护成功率 p̂ 与增益窗口累计 frontierGain += 4·p̂·(1−p̂)
   * （59.0 增益定律——好的课程应持续把 p̂ 骑在倒 U 峰值带）。
   */
  recordOutcome(success: boolean): void {
    this.outcomes.push(success);
    if (this.outcomes.length > 8) this.outcomes.shift();
    if (success) {
      this.successStreak += 1;
      this.failureStreak = 0;
      if (this.successStreak >= this.hardenStreak) {
        this.difficulty = round3(Math.min(this.maxDifficulty, this.difficulty + this.step));
        this.successStreak = 0;
        this.hardened += 1;
        this.difficultyTrail.push(this.difficulty);
      }
    } else {
      this.failureStreak += 1;
      this.successStreak = 0;
      if (this.failureStreak >= this.softenStreak) {
        this.difficulty = round3(Math.max(this.minDifficulty, this.difficulty - this.step));
        this.failureStreak = 0;
        this.softened += 1;
        this.difficultyTrail.push(this.difficulty);
      }
    }
    const p = this.outcomes.length > 0 ? this.outcomes.filter(Boolean).length / this.outcomes.length : 0.5;
    this.frontierGain = Number((this.frontierGain + 4 * p * (1 - p)).toFixed(6));
  }

  /** 批量回报（一批任务的成败序列） */
  recordOutcomes(successes: ReadonlyArray<boolean>): void {
    for (const s of successes) this.recordOutcome(s);
  }

  /** 运行报告（学习曲线：难度轨迹 / 加难减难计数 / 前沿增益） */
  report(): AdversarialCurriculumReport {
    const p = this.outcomes.length > 0 ? this.outcomes.filter(Boolean).length / this.outcomes.length : 0;
    return {
      difficulty: this.difficulty,
      hardened: this.hardened,
      softened: this.softened,
      successRate: Number(p.toFixed(4)),
      frontierGain: this.frontierGain,
      generated: this.generated,
      boundaryMined: this.boundaryMinedCount,
      difficultyTrail: [...this.difficultyTrail],
    };
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function round3(v: number): number {
  return Number(v.toFixed(3));
}

// ─────────────────────────── 历史任务回放集 ───────────────────────────

/**
 * 从长期记忆提取历史任务集（回放评估的数据来源）
 *
 * 每个任务模式（含成功与失败记录）至少产出 1 个回放任务；
 * 模式指纹 `taskType::complexity::features` 解析回任务上下文。
 */
export function extractReplayTasks(memory: LongTermMemory): SandboxTask[] {
  const tasks: SandboxTask[] = [];
  for (const pattern of memory.getAllTaskPatterns()) {
    const [taskType, complexityRaw, featuresRaw] = pattern.fingerprint.split('::');
    if (!taskType) continue;
    // 复杂度段缺失/非数字时回退 0.5：NaN 一路传播会让全任务集评估的
    // reward/gain/LCB 变 NaN（NaN ≥ 0 恒 false）——进化门禁被单个脏指纹静默锁死
    const parsedComplexity = Number(complexityRaw ?? 0.5);
    const complexity = Number.isFinite(parsedComplexity) ? parsedComplexity : 0.5;
    const features = (featuresRaw ?? '').split(',').filter(Boolean);
    const records = Math.max(1, pattern.successfulPlans.length + pattern.failureRecords.length);
    // 每个成功/失败记录各产出 1 个回放任务（高频模式权重更高）
    for (let i = 0; i < records; i += 1) {
      tasks.push({
        taskType,
        complexity,
        features,
        length: Math.max(100, Math.round(complexity * 20_000)),
        source: 'replay',
        label: pattern.taskSummary,
      });
    }
  }
  return tasks;
}

// ─────────────────────────── 安全沙盒 ───────────────────────────

/** 多种子单轮聚合产物 */
interface SeedRun {
  metrics: PolicyEvaluationMetrics;
  reward: number;
}

/**
 * 安全沙盒（implements ISandbox）
 *
 * 被 PolicyEvolver 调用：evaluate(policy, baseline) 在隔离环境重放任务集，
 * 产出收益/风险/回归三段式评估报告（多种子统计门禁）。全程离线，不阻塞操作环调度。
 */
export class Sandbox implements ISandbox {
  private simulator: PolicySimulator;
  private tasks: SandboxTask[];
  private config: Required<SandboxConfig>;

  constructor(params: { models: SimModelStatus[]; tasks: SandboxTask[]; config?: SandboxConfig }) {
    this.simulator = new PolicySimulator(params.models, params.config);
    this.tasks = [...params.tasks];
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...params.config };
  }

  /** 当前任务集（可观测） */
  getTaskSet(): SandboxTask[] {
    return [...this.tasks];
  }

  /** 替换任务集（进化周期之间可刷新历史回放集） */
  setTaskSet(tasks: SandboxTask[]): void {
    this.tasks = [...tasks];
  }

  /**
   * 替换模型快照（进化周期之间可刷新——操作环模型池增删/画像漂移同步进沙盒）。
   * 此前模型快照仅构造时注入：宿主「每轮进化前刷新任务集/校准/模型快照」的
   * 素材同步缺少模型侧入口（setTaskSet / setCalibration 均不覆盖模型）。
   */
  setModels(models: SimModelStatus[]): void {
    this.simulator = new PolicySimulator(models, this.config);
  }

  /**
   * 94.0：挂载风洞修正透镜（幂等覆盖，挂载即生效——只读咨询口径）。
   *
   * 沙盒评估产出的 per-task 质量分序列与操作环真实质量分构成两样本：
   * mmd2/energyDistance 量化「模拟器此刻失真多少」，密度比 r̂ 把沙盒
   * 统计换算真实口径（真实口径增益 ≈ 再加权统计）——上线判据的离线通道
   * 素材（与 88.0 合成「沙盒分数 → 真实口径反事实」的完整换算链）。
   * ESS/n 低（重度再加权）时换算不可信，报告提示回退保守门禁。纯读数
   * （不改变 evaluate 路径，零漂移）。
   */
  attachSimCalibration(): void {
    this.simCalibrationEnabled = true;
  }

  /** 94.0：风洞修正旗标（未挂载零介入） */
  private simCalibrationEnabled?: boolean;

  /** 94.0：风洞修正读数（未挂载 / 样本不足时 undefined；sim/real = 两样本质量分序列） */
  windTunnelReport(simScores: ReadonlyArray<number>, realScores: ReadonlyArray<number>): WindTunnelView | undefined {
    return this.simCalibrationEnabled ? windTunnelAudit(simScores, realScores) : undefined;
  }

  /** 刷新校准表（操作环真实结果持续锚定模拟器） */
  setCalibration(calibration: SimCalibration): void {
    this.config = { ...this.config, calibration };
    this.simulator = new PolicySimulator(this.simulator.getModels(), this.config);
  }

  /**
   * 运行时调参入口（第四阶段：元认知控制器调节验证严格度）
   *
   * 经此调整多种子统计门禁（evaluationSeeds：种子越多 LCB 越严格）、
   * 回归容忍（regression*）与 reward 权重；下次评估即生效。
   * calibration 字段不可经此变更（走 setCalibration）。
   */
  updateConfig(patch: SandboxConfig): void {
    const { calibration: _ignored, ...rest } = patch;
    void _ignored;
    this.config = { ...this.config, ...rest };
    this.simulator = new PolicySimulator(this.simulator.getModels(), this.config);
  }

  /** 当前评估配置快照（元认知旋钮 read 端；只读） */
  getConfig(): Readonly<SandboxConfig> {
    return { ...this.config, calibration: this.config.calibration };
  }

  /**
   * 评估策略（可选与 baseline 对比；多种子统计）
   *
   * 流程：参数边界风险检查 → 多种子全任务集模拟（逐种子聚合求均值）→
   * reward/gain 均值与标准差 → 置信下界 LCB → 回归检测 → 部署门禁
   * （gainLCB ≥ 0：97.5% 置信下界上收益仍非负，防单种子过拟合）
   */
  async evaluate(policy: Policy, baseline?: Policy): Promise<EvaluationReport> {
    const evaluatedAt = Date.now();
    const replayed = this.tasks.filter((t) => t.source === 'replay').length;
    const adversarial = this.tasks.filter((t) => t.source === 'adversarial').length;
    const seeds = Math.max(1, Math.floor(this.config.evaluationSeeds));

    // ── 风险检查 1：参数越界（含规则数量与增量幅度；防御，变异已钳制） ──
    const risks: string[] = [];
    if (!policyParamsWithinBounds(policy.params)) {
      risks.push('策略参数越界（超出 POLICY_GENE_BOUNDS）');
    }

    // ── 多种子模拟：候选与 baseline 在相同种子序列上评估（公平对比） ──
    const policyRuns = this.runAllSeeds(policy.params, seeds, risks);
    const metrics = averageMetrics(policyRuns.map((r) => r.metrics));
    const reward = policyRuns.reduce((s, r) => s + r.reward, 0) / policyRuns.length;

    // ── baseline 对比（gain 均值 + 跨种子标准差 + LCB + 回归检测） ──
    let baselineMetrics: PolicyEvaluationMetrics | undefined;
    let baselineReward: number | undefined;
    let gainStdDev = 0;
    let gainLCB: number | undefined;
    const regressions: string[] = [];
    if (baseline) {
      const baselineRisks: string[] = [];
      const baselineRuns = this.runAllSeeds(baseline.params, seeds, baselineRisks);
      baselineMetrics = averageMetrics(baselineRuns.map((r) => r.metrics));
      baselineReward = baselineRuns.reduce((s, r) => s + r.reward, 0) / baselineRuns.length;

      // 逐种子配对差值 → 均值与标准差（配对消除种子间公共方差）
      const gains = policyRuns.map((r, i) => r.reward - (baselineRuns[i]?.reward ?? r.reward));
      const meanGain = gains.reduce((s, g) => s + g, 0) / gains.length;
      gainStdDev =
        gains.length > 1
          ? Math.sqrt(gains.reduce((s, g) => s + (g - meanGain) ** 2, 0) / (gains.length - 1))
          : 0;
      gainLCB = meanGain - (1.96 * gainStdDev) / Math.sqrt(gains.length);

      if (metrics.successRate < baselineMetrics.successRate - this.config.regressionSuccessTolerance) {
        regressions.push(`成功率回归：${baselineMetrics.successRate.toFixed(3)} → ${metrics.successRate.toFixed(3)}`);
      }
      if (metrics.avgQuality < baselineMetrics.avgQuality - this.config.regressionQualityTolerance) {
        regressions.push(`质量回归：${baselineMetrics.avgQuality.toFixed(3)} → ${metrics.avgQuality.toFixed(3)}`);
      }
      if (baselineMetrics.totalTokens > 0 && metrics.totalTokens > baselineMetrics.totalTokens * this.config.regressionCostTolerance) {
        regressions.push(
          `成本回归：token ${baselineMetrics.totalTokens} → ${metrics.totalTokens}（超出 ${(this.config.regressionCostTolerance - 1) * 100}%）`,
        );
      }
    }

    const gain = baselineReward !== undefined ? reward - baselineReward : 0;
    // 部署门禁：零风险 + 零回归 + 收益置信下界非负（多种子 LCB；无 baseline 时交由进化器决定）
    const deployable =
      risks.length === 0 &&
      regressions.length === 0 &&
      baselineReward !== undefined &&
      (gainLCB ?? gain) >= 0 &&
      this.tasks.length > 0;

    return {
      policyId: policy.id,
      baselinePolicyId: baseline?.id,
      metrics,
      baselineMetrics,
      reward,
      baselineReward,
      gain,
      gainStdDev: seeds > 1 ? gainStdDev : undefined,
      gainLCB: seeds > 1 ? gainLCB : undefined,
      seeds,
      risks,
      regressions,
      deployable,
      taskStats: { replayed, adversarial },
      evaluatedAt,
    };
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 在全部种子上模拟执行（每种子完整跑一遍任务集） */
  private runAllSeeds(params: SchedulerPolicyParams, seeds: number, risks: string[]): SeedRun[] {
    const runs: SeedRun[] = [];
    for (let salt = 0; salt < seeds; salt += 1) {
      const metrics = this.simulateAll(params, salt, risks);
      runs.push({ metrics, reward: this.computeReward(metrics) });
    }
    return runs;
  }

  /** 单种子模拟执行全任务集并聚合指标（单个任务异常记为风险 + 失败样本） */
  private simulateAll(params: SchedulerPolicyParams, seedSalt: number, risks: string[]): PolicyEvaluationMetrics {
    let successCount = 0;
    let qualitySum = 0;
    let latencySum = 0;
    let tokensTotal = 0;
    let decomposeCount = 0;
    let ensembleCount = 0;
    let evaluated = 0;

    for (const task of this.tasks) {
      try {
        const sim = this.simulator.simulate(params, task, seedSalt);
        evaluated += 1;
        if (sim.success) successCount += 1;
        qualitySum += sim.quality;
        latencySum += sim.latencyMs;
        tokensTotal += sim.tokens;
        if (sim.decomposed) decomposeCount += 1;
        if (sim.ensembleUsed) ensembleCount += 1;
      } catch (err) {
        risks.push(`任务 ${task.taskType}(${task.label ?? ''}) 模拟异常: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const total = Math.max(evaluated, 1);
    return {
      successRate: successCount / total,
      avgQuality: qualitySum / total,
      avgLatencyMs: latencySum / total,
      totalTokens: Math.round(tokensTotal),
      decompositionRate: decomposeCount / total,
      ensembleRate: ensembleCount / total,
    };
  }

  /** 综合收益：成功率 + 质量 + 成本效率 + 延迟效率 加权（归一化到 0~1） */
  private computeReward(metrics: PolicyEvaluationMetrics): number {
    const perTaskTokens = metrics.totalTokens / Math.max(1, this.tasks.length);
    const costEfficiency = 1 - Math.min(1, perTaskTokens / this.config.costNormTokens);
    const latencyEfficiency = 1 - Math.min(1, metrics.avgLatencyMs / this.config.latencyNormMs);
    const { successWeight, qualityWeight, costWeight } = this.config;
    const latencyWeight = Math.max(0, 1 - successWeight - qualityWeight - costWeight);
    return successWeight * metrics.successRate + qualityWeight * metrics.avgQuality + costWeight * costEfficiency + latencyWeight * latencyEfficiency;
  }
}

/** 多种子指标平均（token 取均值以保持与单任务口径一致） */
function averageMetrics(list: PolicyEvaluationMetrics[]): PolicyEvaluationMetrics {
  if (list.length === 0) {
    return { successRate: 0, avgQuality: 0, avgLatencyMs: 0, totalTokens: 0, decompositionRate: 0, ensembleRate: 0 };
  }
  const avg = (pick: (m: PolicyEvaluationMetrics) => number) => list.reduce((s, m) => s + pick(m), 0) / list.length;
  return {
    successRate: avg((m) => m.successRate),
    avgQuality: avg((m) => m.avgQuality),
    avgLatencyMs: avg((m) => m.avgLatencyMs),
    totalTokens: Math.round(avg((m) => m.totalTokens)),
    decompositionRate: avg((m) => m.decompositionRate),
    ensembleRate: avg((m) => m.ensembleRate),
  };
}
