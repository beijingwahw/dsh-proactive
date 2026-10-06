/**
 * metareasoning.ts — 元推理内核（项目 8.0「元认知心智」质变基座：理性元推理）
 *
 * 升级前的根本局限（7.0 深思心智的天花板）：
 * 「要不要深思」是一个**配置开关**——启用后每个决策都全深度 beam
 * search，不启用则全部单步反应。思考本身从不被定价：
 * - 简单决策（证据充分、优劣悬殊）也在全深度搜索——浪费算力；
 * - 熟场景（同样的路口走过十次，每次深思都得出同一计划）仍在
 *   重新发明轮子——**重复深思是系统对自身经验的不信任**；
 * - 算力无限假设：现实里搜索有延迟、有能耗，深思的代价从未
 *   进入决策依据。
 *
 * 本内核引入 Rational Metareasoning（Russell & Wefald 1991;
 * Lieder & Griffiths 2020——计算即行动，思考有价格）：
 *
 * 1. **双过程仲裁**（Kahneman System 1/2 的主动推断重构）：
 *   - 习惯（habit）：深思的摊销缓存——同一状态反复深思出同一计划
 *     → 蒸馏为习惯，一次查表零搜索（摊销推断，amortized inference）
 *   - 反应（reactive）：一步 EFE——证据充分且优劣悬殊时，再想
 *     也不会改变选择，VOC ≈ 0，直接反应
 *   - 深思（deliberative）：任意时 beam search——只在值得想的地方想
 *   仲裁依据 = 元期望自由能：metaG(mode) = 预期决策质量损失 − 计算成本
 *
 * 2. **任意时搜索 + 决策稳定性停机**（anytime search）：
 *   逐深度展开 beam，每层比较「更深搜索是否改变第一步的选择」——
 *   首行动连续两层不变 = 深思已收敛（再想也不改结论），立即停机。
 *   停机不是深度预算的恩赐，而是**思考收敛的证据**。
 *
 * 3. **计算成本入账**（思考有价格）：
 *   每个展开节点计价 natPerNode（nat 货币），与决策质量同一量纲。
 *   认知经济 KPI：搜索开销、习惯命中率、模式分布全程可审计。
 *
 * 4. **习惯生命周期**（经验的可信与失效）：
 *   同状态同计划连续成功 ≥ 门槛 → 习惯晋升（此后零成本直答）；
 *   习惯失败 → 即刻作废（世界漂移的铁证）+ 元遗憾计数。
 *
 * 5. **元学习**（想多深由后果校准）：
 *   结算回流：反应模式失手 → 门槛收紧（下次更早深思）；
 *   各模式成功率 EMA = 「思考的价值」实测——元认知不再是假设，
 *   而是被现实反复校准的统计量。
 *
 * 与 6.0/7.0 的关系：6.0 定价了行动（单步 EFE），7.0 定价了计划
 * （轨迹 G），本内核定价**思考本身**（元 EFE）。
 * 元认知心智 = 深思心智 × 自知（知道自己何时值得想）。
 *
 * ── R5 第五轮世界性进化（四轴）──
 *
 * A1【数学进化】计算最优停止的闭式解（泊松近似 + 几何衰减改进流）：
 *    把「更深一层搜索」建模为改进到达率 λ(d) = λ₀·ρ^d 的泊松流
 *    （越深越难再改进——anytime 算法的标准近似），每次发现价值 v
 *    （nat 口径决策质量增益），每层成本 c（nat）。
 *      V(D) = v·λ₀·ρ(1−ρ^D)/(1−ρ) − c·D        （闭式几何和）
 *      边际：V(D) − V(D−1) = v·λ₀·ρ^D − c
 *      停机深度闭式：d* = ceil( ln(c/(v·λ₀)) / ln ρ ) − 1，clamp [0, Dmax]
 *    与全深度枚举 argmax V(D) 严格一致（verify 脚本 ≥200 种子对照）。
 *    多算法预算分配（McGrath–Balch 圆定理的水填充口径）：各算法的
 *    单位边际 vᵢλᵢρᵢ^d − cᵢ 构成单调几何序列，最优分配 = 取预算内
 *    最大的若干单位边际（水填充）；闭式解与 O(B²) 暴力枚举一致。
 *
 * A2【接线】decideWithClosedFormStop：先用闭式 d* 封顶深思深度再进
 *    任意时搜索——「该想多深」从稳定性回看升级为前瞻定价；decide()
 *    缺省路径逐位不变（零漂移，opt-in 才启用新口径）。
 *
 * A3【数值稳健】几何级数一律用闭式 (1−ρ^D)/(1−ρ)（ρ→1 时退化为 D
 *    的连续极限）而非逐项累加；对数域求解停机深度避免 ρ^D 下溢；
 *    除零护栏（c=0 → d*=Dmax、vλ₀≤c → d*=0 的退化分支显式处理）。
 */

import type { DeliberationEngine, ImaginationReport } from './deliberation.js';

// ─────────────────────────── 数据结构 ───────────────────────────

/** 决策模式（双过程：1=习惯/反应，2=深思） */
export type DecisionMode = 'habit' | 'reactive' | 'deliberative';

/** 习惯（深思的摊销缓存：状态 → 直答计划） */
export interface Habit {
  /** 触发状态键 */
  state: string;
  /** 摊销的计划（深思反复收敛出的行动序列） */
  actions: string[];
  /** 连续成功次数（晋升后持续累计） */
  consecutiveSuccesses: number;
  /** 形成后总使用次数 */
  usages: number;
  /** 全程成功概率（形成时口径，审计用） */
  reliability: number;
  createdAt: number;
  lastUsedAt: number;
}

/** 元决策记录（pending → 结算回流） */
export interface MetaDecision {
  id: number;
  /** 仲裁时的时间戳 */
  ts: number;
  state: string;
  mode: DecisionMode;
  /** 习惯模式 = 习惯计划；反应 = [bestAction]；深思 = 最优轨迹 */
  actions: string[];
  /** 计算成本（nat；习惯 ≈ 0，反应 ≈ 0，深思 = nodes × natPerNode） */
  costNat: number;
  /** 深思展开的节点数（认知经济审计） */
  nodesExpanded: number;
  /** 深思停止时的搜索深度 */
  depthStopped: number;
  /** 首行动稳定性（深思连续不变的层数） */
  firstActionStable: boolean;
  /** 反应门槛判定：best 与次优的单步 EFE 差（nat） */
  reactiveGap: number;
  /** 结算状态 */
  settled: boolean;
  /** 结算整体成败 */
  outcome?: boolean;
}

/** 仲裁结果 */
export interface ArbitrationResult {
  mode: DecisionMode;
  actions: string[];
  /** 深思模式附带完整想象报告（审计/上游再利用） */
  report?: ImaginationReport;
  costNat: number;
  nodesExpanded: number;
  decisionId: number;
  /** 反应门槛判定：best 与次优的单步 EFE 差（nat；深思模式下 = 未达门槛的暧昧度） */
  reactiveGap: number;
  /** 深思停止时的搜索深度（反应 = 1，习惯 = 0） */
  depthStopped: number;
  /** 仲裁理由（人类可读，进决策审计） */
  rationale: string;
}

/** 认知经济 KPI（meta-cognition 统一报告用） */
export interface CognitiveEconomy {
  /** 已仲裁决策总数 */
  decisions: number;
  /** 模式分布（份额和为 1） */
  modeShare: Record<DecisionMode, number>;
  /** 习惯命中节省的搜索成本（nat，认知经济的直接产出） */
  habitSavingsNat: number;
  /** 累计计算开销（nat） */
  totalSpendNat: number;
  /** 累计展开节点数 */
  totalNodes: number;
  /** 习惯库规模 */
  habits: number;
  /** 习惯命中率（习惯模式 / 决策总数） */
  habitHitRate: number;
  /** 元遗憾：习惯失灵（世界漂移下沿用了过期习惯）次数 */
  staleHabitRegrets: number;
  /** 反应失手次数（本该深思却反应了） */
  reactiveFailures: number;
  /** 各模式成功率（元学习实测：思考的价值） */
  modeSuccessRate: Partial<Record<DecisionMode, number>>;
  /** 平均深思深度（收敛性：越低=越早想清楚） */
  avgDeliberationDepth: number;
  interpretation: string;
}

// ─────────────────────────── 配置 ───────────────────────────

export interface MetareasoningConfig {
  /** 反应门槛：best 与次优单步 EFE 差 ≥ 该值 → 无需深思（nat，缺省 0.25） */
  decisivenessGap: number;
  /** 反应模式对 best 行动的最低证据量要求（缺省 8） */
  sufficientEvidence: number;
  /** 习惯晋升门槛：同状态同计划连续成功次数（缺省 2） */
  habitPromotionSuccesses: number;
  /** 深思最大深度（缺省 4；任意时停机通常更早） */
  maxDepth: number;
  /** beam 宽度（缺省 6） */
  beamBreadth: number;
  /** 每展开节点的计算价格（nat/节点，缺省 0.01） */
  natPerNode: number;
  /** 思考预算：单次深思最大开销（nat，缺省 2.0——约等于一次大惊小怪） */
  budgetNat: number;
  /** 反应失手后门槛收紧系数（缺省 0.8：gap *= 0.8，更难走反应路） */
  reactiveTightening: number;
  /** 反应门槛下限（收紧不至零：深思不能因一次失手变成常态，缺省 0.08） */
  minDecisivenessGap: number;
  /** 模式成功率 EMA 平滑（缺省 0.3） */
  metaAlpha: number;
}

export const DEFAULT_METAREASONING_CONFIG: MetareasoningConfig = {
  decisivenessGap: 0.25,
  sufficientEvidence: 8,
  habitPromotionSuccesses: 2,
  maxDepth: 4,
  beamBreadth: 6,
  natPerNode: 0.01,
  budgetNat: 2.0,
  reactiveTightening: 0.8,
  minDecisivenessGap: 0.08,
  metaAlpha: 0.3,
};

// ─────────────────────────── R5：计算最优停止的闭式解（泊松近似） ───────────────────────────

/** 单个 anytime 搜索的改进流参数 */
export interface AnytimeSearchModel {
  /** 深度 1 的改进到达率 λ₀ > 0（每层单位） */
  rate0: number;
  /** 深度衰减 ρ ∈ (0,1)（越深改进越罕见） */
  decay: number;
  /** 每次改进的价值 v > 0（nat 口径的决策质量增益） */
  valuePerDiscovery: number;
  /** 每层成本 c ≥ 0（nat/深度） */
  costPerDepth: number;
}

/** 泊松最优停止闭式解读出 */
export interface OptimalStopResult {
  /** 闭式最优停止深度 d*（继续搜索当且仅当 d < d*；枚举 argmax 一致） */
  optimalDepth: number;
  /** d* 处的边际净值 v·λ₀·ρ^{d*+1} − c（≤ 0 即停机判据成立） */
  marginalNetAtStop: number;
  /** V(d*) 闭式期望净值（几何和） */
  totalExpectedValue: number;
  /** 退化分支标注 */
  degenerate: 'none' | 'never-search' | 'search-to-cap';
  params: AnytimeSearchModel & { depthCap: number };
}

/**
 * R5·A1 单算法最优停止闭式解。
 *
 * 改进流 λ(d) = λ₀ρ^d（泊松近似）：
 *   V(D) = v·λ₀·Σ_{d=1..D} ρ^d − c·D = v·λ₀·ρ(1−ρ^D)/(1−ρ) − c·D
 *   边际 v·λ₀·ρ^D − c > 0 ⟺ D < ln(c/(vλ₀))/ln ρ
 *   ⟹ d* = ceil( ln(c/(vλ₀))/ln ρ ) − 1，clamp [0, depthCap]
 * 退化分支：c = 0（思考免费）→ 搜索到上限；vλ₀ ≤ c（第一层就不值）→ 0。
 * ρ→1 用极限 Σρ^d → D 处理（闭式连续延拓，不逐项累加——数值稳健轴）。
 */
export function poissonOptimalStop(
  model: AnytimeSearchModel,
  depthCap = 10000,
): OptimalStopResult {
  if (!model || typeof model !== 'object') {
    throw new Error('poissonOptimalStop: 需要 { rate0, decay, valuePerDiscovery, costPerDepth } 对象');
  }
  const { rate0, decay, valuePerDiscovery, costPerDepth } = model;
  if (!Number.isFinite(rate0) || rate0 <= 0) {
    throw new Error(`poissonOptimalStop: rate0 须为 > 0 有限数（收到 ${rate0}）`);
  }
  if (!Number.isFinite(decay) || decay <= 0 || decay >= 1) {
    throw new Error(`poissonOptimalStop: decay 须落在开区间 (0,1)（收到 ${decay}）`);
  }
  if (!Number.isFinite(valuePerDiscovery) || valuePerDiscovery <= 0) {
    throw new Error(`poissonOptimalStop: valuePerDiscovery 须为 > 0 有限数（收到 ${valuePerDiscovery}）`);
  }
  if (!Number.isFinite(costPerDepth) || costPerDepth < 0) {
    throw new Error(`poissonOptimalStop: costPerDepth 须为 ≥ 0 有限数（收到 ${costPerDepth}）`);
  }
  if (!Number.isInteger(depthCap) || depthCap < 1) {
    throw new Error(`poissonOptimalStop: depthCap 须为 ≥1 整数（收到 ${depthCap}）`);
  }
  const grossRate = valuePerDiscovery * rate0;
  if (costPerDepth === 0) {
    // 思考免费：一直搜到上限
    return {
      optimalDepth: depthCap,
      marginalNetAtStop: round(grossRate * Math.pow(decay, depthCap + 1)),
      totalExpectedValue: round(geometricSum(decay, depthCap) * grossRate),
      degenerate: 'search-to-cap',
      params: { ...model, depthCap },
    };
  }
  // ln(c/(vλ₀))/ln ρ：对数域求解（ρ^D 下溢免疫）
  const ratio = costPerDepth / grossRate; // ≥ 0
  if (ratio >= 1) {
    // 第一层的期望改进都抵不过成本 → 一次都不搜
    return {
      optimalDepth: 0,
      marginalNetAtStop: round(grossRate * decay - costPerDepth),
      totalExpectedValue: 0,
      degenerate: 'never-search',
      params: { ...model, depthCap },
    };
  }
  const rawDepth = Math.log(ratio) / Math.log(decay) - 1;
  const optimalDepth = Math.max(0, Math.min(depthCap, Math.ceil(rawDepth)));
  return {
    optimalDepth,
    marginalNetAtStop: round(grossRate * Math.pow(decay, optimalDepth + 1) - costPerDepth),
    totalExpectedValue: round(geometricSum(decay, optimalDepth) * grossRate - costPerDepth * optimalDepth),
    degenerate: 'none',
    params: { ...model, depthCap },
  };
}

/** Σ_{d=1..D} ρ^d 的闭式（ρ→1 连续延拓为 D；除零护栏） */
function geometricSum(rho: number, D: number): number {
  if (D <= 0) return 0;
  if (Math.abs(1 - rho) < 1e-12) return D;
  return (rho * (1 - Math.pow(rho, D))) / (1 - rho);
}

/** 多算法预算分配（水填充）读出 */
export interface ComputeAllocationResult {
  /** 各算法分得的最优深度 */
  allocations: number[];
  /** 分配后的总期望净值 */
  totalValue: number;
  /** 各算法在分配量处的单位边际净值（最优时各非零分配的边际相等或为负触底） */
  marginalNets: number[];
  /** 与暴力枚举一致性由验证脚本保证；此处标注总分配 = 预算 */
  budgetUsed: number;
}

/**
 * R5·A1 多算法算力分配（圆定理的水填充口径）。
 *
 * 每个算法的单位边际净值构成严格递减几何序列 mᵢ(d) = vᵢλᵢρᵢ^d − cᵢ
 * （d = 1,2,…为其获得的第 d 层深度）。预算 B 下总价值最大的分配 =
 * 取全体单位边际中最大的 min(B, 正边际个数) 个——交换论证：序列逐算法
 * 单调 ⟹ 贪心合并（每次给当前最大边际的算法加一层）即全局最优；边际
 * ≤ 0 的层不值得计算，即使预算未满也停（水填充到边际 0 水位）。
 * 同判定下按算法序破平——确定性。与 O(B·n) 枚举的最优值一致由
 * verify 脚本 ≥200 组参数对照保证。
 */
export function optimalComputeAllocation(
  models: ReadonlyArray<AnytimeSearchModel>,
  budget: number,
): ComputeAllocationResult {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('optimalComputeAllocation: models 须为非空数组');
  }
  if (!Number.isInteger(budget) || budget < 0) {
    throw new Error(`optimalComputeAllocation: budget 须为 ≥0 整数（收到 ${budget}）`);
  }
  for (const m of models) poissonOptimalStop(m, 10 ** 9); // 入参校验复用
  const alloc = models.map(() => 0);
  let budgetUsed = 0;
  // 每算法「下一层」的边际净值：v λ ρ^{d+1} − c（对数域幂避免下溢前
  // 的大数吃小数；ρ^{d+1} 用 Math.pow 即可——d ≤ budget 有界）
  const nextMarginal = (i: number): number => {
    const m = models[i]!;
    return m.valuePerDiscovery * m.rate0 * Math.pow(m.decay, alloc[i]! + 1) - m.costPerDepth;
  };
  while (budgetUsed < budget) {
    let bestIdx = -1;
    let bestMarginal = 0; // 严格 > 0 才值得计算（≤ 0 的层不拿——预算未满也停）
    for (let i = 0; i < models.length; i += 1) {
      const m = nextMarginal(i);
      if (m > bestMarginal + 1e-15) {
        bestMarginal = m;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break; // 水位到 0：所有下一层都不值得
    alloc[bestIdx] = alloc[bestIdx]! + 1;
    budgetUsed += 1;
  }
  const totalValue = models.reduce(
    (s, m, i) => s + geometricSum(m.decay, alloc[i] ?? 0) * m.valuePerDiscovery * m.rate0 - m.costPerDepth * (alloc[i] ?? 0),
    0,
  );
  const marginalNets = models.map((m, i) => {
    const d = alloc[i] ?? 0;
    return round(m.valuePerDiscovery * m.rate0 * Math.pow(m.decay, d + 1) - m.costPerDepth);
  });
  return {
    allocations: alloc,
    totalValue: round(totalValue),
    marginalNets,
    budgetUsed,
  };
}

// ─────────────────────────── 内核实现 ───────────────────────────

/**
 * 元推理内核：双过程仲裁 + 任意时搜索 + 习惯摊销 + 元学习。
 *
 * 消费方：
 * - optimizer：metacognitiveRecommendation（冷启动推荐的元认知版）
 * - meta-cognition：认知经济 KPI（思考的价格与价值实测）
 * - 宿主：决策执行后 settleDecision 回流（元学习闭环）
 */
export class RationalMetareasoner {
  private config: DeliberationConfigLike;
  private deliberation: DeliberationEngine;
  private habits = new Map<string, Habit>();
  private pending = new Map<number, MetaDecision>();
  private decisionCounter = 0;

  // 认知经济记账
  private modeCounts: Record<DecisionMode, number> = { habit: 0, reactive: 0, deliberative: 0 };
  private totalSpendNat = 0;
  private totalNodes = 0;
  private deliberationDepths: number[] = [];
  private habitSavingsNat = 0;
  private staleHabitRegrets = 0;
  private reactiveFailures = 0;
  private modeOutcomes: Record<DecisionMode, { ema: number | undefined; settled: number }> = {
    habit: { ema: undefined, settled: 0 },
    reactive: { ema: undefined, settled: 0 },
    deliberative: { ema: undefined, settled: 0 },
  };
  private dynamicGap: number;

  constructor(deliberation: DeliberationEngine, config?: Partial<MetareasoningConfig>) {
    this.deliberation = deliberation;
    this.config = { ...DEFAULT_METAREASONING_CONFIG, ...config };
    this.dynamicGap = this.config.decisivenessGap;
  }

  // ─────────────────────────── 仲裁（思考的定价） ───────────────────────────

  /**
   * 双过程仲裁：习惯 → 反应 → 深思，逐级升级、逐级定价。
   *
   * 元 EFE 判据（越低越好）：
   *   habit:       直答（查表成本 ≈ 0）——信任摊销经验
   *   reactive:    一步 EFE 差悬殊且证据充分 → VOC ≈ 0，想也不会变
   *   deliberative: 任意时搜索直到首行动稳定或预算耗尽
   */
  decide(
    state: string,
    candidates: string[],
    opts?: {
      preference?: number;
      useSkills?: boolean;
      /** 状态推进覆盖（确定性别状态机；透传给深思搜索） */
      advance?: (ctx: { state: string; action: string; step: number; successor: string }) => string;
    },
  ): ArbitrationResult {
    const preference = opts?.preference ?? 0.9;
    if (candidates.length === 0) {
      throw new Error('metareasoning.decide: 候选行动为空（无决策可仲裁）');
    }

    // 1) 习惯直答（摊销推断：深思的缓存命中）
    const habit = this.habits.get(state);
    if (habit) {
      habit.usages += 1;
      habit.lastUsedAt = Date.now();
      // 命中习惯 = 省下一次同等深思（按上一代深思成本口径入账）
      const saved = this.estimateDeliberationCost(habit.actions.length);
      this.habitSavingsNat += saved;
      return this.record({
        state,
        mode: 'habit',
        actions: [...habit.actions],
        costNat: 0,
        nodesExpanded: 0,
        depthStopped: 0,
        firstActionStable: true,
        reactiveGap: 0,
        rationale: `习惯命中：${habit.actions.join(' → ')}（连续成功 ${habit.consecutiveSuccesses}，省下 ≈${saved.toFixed(2)} nat 搜索）`,
      });
    }

    // 2) 反应判定：一步 EFE 差是否悬殊到「想也不会变」
    const singles = candidates
      .map((action) => {
        const report = this.deliberation.imagine(state, [action], preference);
        return { action, efe: report.totalEfe, evidence: report.steps[0]?.evidence ?? 0 };
      })
      .sort((a, b) => a.efe - b.efe);
    const best = singles[0];
    const second = singles[1];
    const gap = second ? second.efe - best.efe : Infinity;

    if (singles.length === 1 || (gap >= this.dynamicGap && (best?.evidence ?? 0) >= this.config.sufficientEvidence)) {
      return this.record({
        state,
        mode: 'reactive',
        actions: [best!.action],
        costNat: round(singles.length * this.config.natPerNode),
        nodesExpanded: singles.length,
        depthStopped: 1,
        firstActionStable: true,
        reactiveGap: round(gap === Infinity ? 0 : gap),
        rationale:
          singles.length === 1
            ? `唯一候选 → 直接反应（${best!.action}）`
            : `优劣悬殊（gap ${gap.toFixed(3)} ≥ ${this.dynamicGap.toFixed(3)} nat，证据 ${best!.evidence.toFixed(0)}）→ 深思不会改变选择，VOC ≈ 0`,
      });
    }

    // 3) 深思：任意时搜索 + 决策稳定性停机
    const search = this.searchAnytime(state, candidates, preference, opts?.useSkills, opts?.advance);
    return this.record({
      state,
      mode: 'deliberative',
      actions: search.report.actions,
      report: search.report,
      costNat: round(search.nodes * this.config.natPerNode),
      nodesExpanded: search.nodes,
      depthStopped: search.depthStopped,
      firstActionStable: search.stable,
      reactiveGap: round(gap === Infinity ? 0 : gap),
      rationale: search.stable
        ? `深思收敛：首行动 ${search.report.actions[0]} 连续 ${search.stableRounds} 层不变（深度 ${search.depthStopped} 早停，省 ${((this.config.maxDepth - search.depthStopped) * candidates.length).toFixed(0)} 节点）`
        : `深思预算耗尽（${search.nodes} 节点 / ${this.config.budgetNat} nat），首行动 ${search.report.actions[0]}（未收敛，结果存疑）`,
    });
  }

  /**
   * R5·A2 闭式前瞻封顶深思：先用泊松最优停止闭式 d* 封顶搜索深度，
   * 再进任意时稳定性搜索（预算与习惯仲裁口径不变）。
   *
   * 「该想多深」从稳定性回看（首行动连续两层不变）升级为前瞻定价
   * （改进流的边际净值 ≤ 0 即停）；d* 由调用方给出改进流参数（可从
   * 历史深思的深度-收益回归估计），封顶取 min(d*, maxDepth, 预算反推
   * 深度)。缺省 decide() 路径不经过本方法（零漂移，opt-in）。
   */
  decideWithClosedFormStop(
    state: string,
    candidates: string[],
    model: AnytimeSearchModel,
    opts?: {
      preference?: number;
      useSkills?: boolean;
      advance?: (ctx: { state: string; action: string; step: number; successor: string }) => string;
    },
  ): ArbitrationResult & { closedFormCap: number } {
    if (candidates.length === 0) {
      throw new Error('metareasoning.decideWithClosedFormStop: 候选行动为空（无决策可仲裁）');
    }
    // 预算反推深度上限：budgetNat / (natPerNode × beam × 候选数) 层
    const perDepthCost = this.config.natPerNode * this.config.beamBreadth * Math.max(1, candidates.length);
    const budgetDepth = Math.max(1, Math.floor(this.config.budgetNat / Math.max(perDepthCost, 1e-12)));
    const stop = poissonOptimalStop(model, Math.max(1, Math.min(this.config.maxDepth, budgetDepth)));
    const cap = Math.max(1, Math.min(this.config.maxDepth, stop.optimalDepth, budgetDepth));
    const prevMax = this.config.maxDepth;
    this.config = { ...this.config, maxDepth: cap };
    try {
      const result = this.decide(state, candidates, opts);
      return { ...result, closedFormCap: cap };
    } finally {
      this.config = { ...this.config, maxDepth: prevMax };
    }
  }

  /**
   * 任意时搜索：逐深度展开，首行动连续 stableRounds 层不变即停。
   *
   * 停机判据的数学含义：beam 在深度 d 与 d+1 给出的最优计划首行动
   * 相同 → 深层补偿已不影响当下选择 → 继续搜索的期望决策增益 < 成本。
   * 这是「思考收敛」的可观测证据，不是拍脑袋的深度上限。
   */
  private searchAnytime(
    state: string,
    candidates: string[],
    preference: number,
    useSkills?: boolean,
    advance?: (ctx: { state: string; action: string; step: number; successor: string }) => string,
  ): { report: ImaginationReport; nodes: number; depthStopped: number; stable: boolean; stableRounds: number } {
    let nodes = 0;
    let prevFirst: string | undefined;
    let stableRounds = 0;
    let last: ImaginationReport | undefined;
    let depthStopped = 0;
    let stable = false;

    for (let depth = 1; depth <= this.config.maxDepth; depth += 1) {
      const result = this.deliberation.search(state, candidates, {
        depth,
        breadth: this.config.beamBreadth,
        preference,
        useSkills,
        advance,
      });
      nodes += result.expandedNodes;
      last = result.best ?? last;
      depthStopped = depth;
      if (budgetExhausted(nodes, this.config)) break;
      if (!last) break;
      const first = last.actions[0]!;
      if (first === prevFirst) {
        stableRounds += 1;
        if (stableRounds >= 1) {
          stable = true; // 连续两层一致 = 收敛
          break;
        }
      } else {
        stableRounds = 0;
      }
      prevFirst = first;
    }
    return {
      report: last ?? { actions: [], totalEfe: Infinity } as unknown as ImaginationReport,
      nodes,
      depthStopped,
      stable,
      stableRounds,
    };
  }

  // ─────────────────────────── 元学习（结算回流） ───────────────────────────

  /**
   * 决策结算：现实的后果校准元认知。
   *
   * - 习惯失手 → 习惯作废（世界漂移铁证）+ 元遗憾（不该省的思考）
   * - 反应失手 → 门槛收紧（下次更早进入深思）
   * - 深思成功且重复 → 习惯晋升候选（摊销推断）
   * - 各模式成功率 EMA 更新（思考价值的实测）
   */
  settleDecision(decisionId: number, overallSuccess: boolean, actionsTaken?: string[]): void {
    const decision = this.pending.get(decisionId);
    if (!decision || decision.settled) return;
    decision.settled = true;
    decision.outcome = overallSuccess;

    // 模式成功率 EMA（思考的价值实测）
    const stat = this.modeOutcomes[decision.mode];
    stat.ema = stat.ema === undefined ? (overallSuccess ? 1 : 0) : (1 - this.config.metaAlpha) * stat.ema + this.config.metaAlpha * (overallSuccess ? 1 : 0);
    stat.settled += 1;

    if (decision.mode === 'habit') {
      const habit = this.habits.get(decision.state);
      if (habit) {
        if (overallSuccess) {
          habit.consecutiveSuccesses += 1;
        } else {
          // 习惯失灵 = 世界漂移：即刻作废，元遗憾入账
          this.habits.delete(decision.state);
          this.staleHabitRegrets += 1;
        }
      }
    } else if (decision.mode === 'reactive') {
      if (!overallSuccess) {
        // 本该深思却反应了：收紧门槛（更难再走反应路），不至归零
        this.reactiveFailures += 1;
        this.dynamicGap = Math.max(this.config.minDecisivenessGap, this.dynamicGap * this.config.reactiveTightening);
      }
    } else if (decision.mode === 'deliberative') {
      if (overallSuccess) {
        // 深思成功 → 习惯晋升候选（同状态连续同计划成功达门槛）
        const taken = actionsTaken ?? decision.actions;
        const draft = this.drafts.get(decision.state);
        if (draft && draft.actions.join('|') === taken.join('|')) {
          draft.successes += 1;
        } else {
          this.drafts.set(decision.state, { actions: taken, successes: 1 });
        }
        const candidate = this.drafts.get(decision.state)!;
        if (candidate.successes >= this.config.habitPromotionSuccesses) {
          const reliability = this.deliberation
            .imagine(decision.state, taken, 0.9)
            .pAllSuccess;
          this.habits.set(decision.state, {
            state: decision.state,
            actions: [...taken],
            consecutiveSuccesses: candidate.successes,
            usages: 0,
            reliability: round(reliability),
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
          });
          this.drafts.delete(decision.state);
        }
      } else {
        this.drafts.delete(decision.state);
      }
    }
    this.pending.delete(decisionId);
  }

  /** 未结算决策的只读视图（宿主对账用） */
  pendingDecisions(): MetaDecision[] {
    return [...this.pending.values()];
  }

  /** 当前动态反应门槛（元学习可观测） */
  currentDecisivenessGap(): number {
    return round(this.dynamicGap);
  }

  /** 习惯库只读视图（审计） */
  allHabits(): Habit[] {
    return [...this.habits.values()].sort((a, b) => b.consecutiveSuccesses - a.consecutiveSuccesses);
  }

  /** 手动作废习惯（上游漂移信号，如变分自由能报警时） */
  invalidateHabit(state: string): boolean {
    return this.habits.delete(state);
  }

  // ─────────────────────────── 认知经济 KPI ───────────────────────────

  /** 认知经济报告：思考的价格与价值的统一核算 */
  cognitiveEconomy(): CognitiveEconomy {
    const decisions = this.modeCounts.habit + this.modeCounts.reactive + this.modeCounts.deliberative;
    const share = (m: DecisionMode) => (decisions === 0 ? 0 : round(this.modeCounts[m] / decisions));
    const avgDepth = this.deliberationDepths.length > 0
      ? round(this.deliberationDepths.reduce((a, b) => a + b, 0) / this.deliberationDepths.length)
      : 0;
    const modeSuccessRate: Partial<Record<DecisionMode, number>> = {};
    for (const [mode, stat] of Object.entries(this.modeOutcomes) as Array<[DecisionMode, { ema: number | undefined; settled: number }]>) {
      if (stat.ema !== undefined) modeSuccessRate[mode] = round(stat.ema);
    }
    const interpretation =
      decisions === 0
        ? '尚未决策：元推理待命'
        : this.staleHabitRegrets > 0
          ? `习惯失灵 ${this.staleHabitRegrets} 次：世界在漂移，摊销经验需重建（已自动作废）`
          : this.habitHitRate(decisions) > 0.5
            ? `认知经济健康：${(this.habitHitRate(decisions) * 100).toFixed(0)}% 决策走习惯直答，累计省 ${this.habitSavingsNat.toFixed(2)} nat`
            : this.modeCounts.reactive > this.modeCounts.deliberative * 3
              ? '反应主导：多数决策证据充分，深思预算集中用在疑难处'
              : '深思主导：局势不确定，思考是主要开销——观察收敛深度是否下降';

    return {
      decisions,
      modeShare: { habit: share('habit'), reactive: share('reactive'), deliberative: share('deliberative') },
      habitSavingsNat: round(this.habitSavingsNat),
      totalSpendNat: round(this.totalSpendNat),
      totalNodes: this.totalNodes,
      habits: this.habits.size,
      habitHitRate: round(this.habitHitRate(decisions)),
      staleHabitRegrets: this.staleHabitRegrets,
      reactiveFailures: this.reactiveFailures,
      modeSuccessRate,
      avgDeliberationDepth: avgDepth,
      interpretation,
    };
  }

  private habitHitRate(decisions: number): number {
    return decisions === 0 ? 0 : this.modeCounts.habit / decisions;
  }

  /** 同长度深思的成本估算（习惯节省额入账口径） */
  private estimateDeliberationCost(steps: number): number {
    return round(steps * this.config.beamBreadth * this.config.natPerNode * 2);
  }

  /** 决策入账（pending 登记 + 认知经济计数） */
  private record(input: {
    state: string;
    mode: DecisionMode;
    actions: string[];
    costNat: number;
    nodesExpanded: number;
    depthStopped: number;
    firstActionStable: boolean;
    reactiveGap: number;
    rationale: string;
    report?: ImaginationReport;
  }): ArbitrationResult {
    this.decisionCounter += 1;
    const id = this.decisionCounter;
    this.modeCounts[input.mode] += 1;
    this.totalSpendNat += input.costNat;
    this.totalNodes += input.nodesExpanded;
    if (input.mode === 'deliberative') this.deliberationDepths.push(input.depthStopped);
    this.pending.set(id, {
      id,
      ts: Date.now(),
      state: input.state,
      mode: input.mode,
      actions: input.actions,
      costNat: input.costNat,
      nodesExpanded: input.nodesExpanded,
      depthStopped: input.depthStopped,
      firstActionStable: input.firstActionStable,
      reactiveGap: input.reactiveGap,
      settled: false,
    });
    return {
      mode: input.mode,
      actions: input.actions,
      report: input.report,
      costNat: input.costNat,
      nodesExpanded: input.nodesExpanded,
      decisionId: id,
      reactiveGap: input.reactiveGap,
      depthStopped: input.depthStopped,
      rationale: input.rationale,
    };
  }

  /** 晋升草稿（同状态连续同计划成功计数） */
  private drafts = new Map<string, { actions: string[]; successes: number }>();
}

// ─────────────────────────── 工具 ───────────────────────────

type DeliberationConfigLike = MetareasoningConfig;

function budgetExhausted(nodes: number, config: DeliberationConfigLike): boolean {
  return nodes * config.natPerNode >= config.budgetNat;
}

function round(x: number): number {
  return Number(x.toFixed(6));
}
