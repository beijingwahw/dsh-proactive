/**
 * conformal.ts — 保形校准内核（项目 13.0「预测的不确定性有了保证」质变基座）
 *
 * 升级前的根本局限（世界模型与质量反思的共性天花板）：
 * - 世界模型的预测区间是 sqrt(λ) 泊松近似——**没有覆盖率保证**：
 *   名义 95% 的区间实际覆盖多少，无人知晓（分布偏斜/过散时系统性失准）；
 * - 反思引擎的质量阈值 ±0.02 步进自校准——**没有风险保证**：重试率
 *   会冲到多少全凭运气，重试风暴与漏放低质量交替发生；
 * - 校准失效无法侦测：模型漂移后旧区间继续输出，直到下游连环失误
 *   才间接暴露——预测系统对「自己已经不可信」毫无察觉。
 *
 * 本内核引入保形预测与分布无关风险控制
 * （Vovk; Angelopoulos & Bates; Bates et al. RCPS）：
 *
 * 1. **分裂保形区间（split conformal）**：校准残差 |y−ŷ| 的
 *    ⌈(n+1)(1−α)⌉ 次序统计量为半径 q̂：
 *      P(y ∈ [ŷ−q̂, ŷ+q̂]) ≥ 1−α
 *    **精确有限样本保证，零分布假设**——只需校准集与新样本可交换。
 *    样本不足时区间诚实发散（finite: false），不伪装确定。
 *
 * 2. **覆盖漂移 e-过程监测（建在 12.0 之上）**：被覆盖指示
 *    1{covered} 在校准良好下条件均值 ≥ 1−α → 资本过程
 *    Π(1 + λ(1{covered} − (1−α)))（λ ≤ 0 可预测）是非负上鞅；
 *    e ≥ 1/δ → 以水平 δ 确证**区间正在失准**（欠覆盖），触发重校准。
 *    预测系统第一次拥有「自我怀疑」的合法检验。
 *
 * 3. **风险受控阈值选择（RCPS 思想 + 12.0 固定样本界）**：对候选
 *    阈值网格逐一计算风险上界（经验伯恩斯坦，Bonferroni 分摊置信度），
 *    取风险上界 ≤ 目标 α 的最激进阈值：
 *      P(未来风险 ≤ α) ≥ 1−δ
 *    反思引擎的重试率第一次被钉在数学上限之内。
 *
 * 与 12.0 的关系：12.0 保证「结论」永不夸大，本内核保证「预测与
 * 阈值」永不越界——二者合成预测-决策全链路的分布无关保证。
 * 与 3-11.0 的关系：世界模型的 MAE 校准（经验性的）继续服务趋势
 * 置信度；保形区间作为并行旁路叠加（不替换既有字段语义）。
 *
 * R5 第五轮进化（内核世界性进化·统计推断组）：
 * - 数学：Mondrian 条件保形（分组覆盖保证）——把校准分数按组
 *   （模型档位 / 任务类型 / 租户层）切开，各组独立取 ⌈(n_g+1)(1−α)⌉
 *   次序统计量：Mondrian 定理（Vovk et al.; Xu & Ramdas 2021 的
 *   Mondrian-ish 框架）保证**条件于组标签**的覆盖 P(覆盖 | 组=g) ≥ 1−α
 *   ——边际覆盖不再被组间失衡稀释（旧池化区间对小组系统性失准）。
 *   组样本不足时诚实回退合并池（source='pooled'，条件保证标记降级，
 *   边际保证仍成立）。
 * - 数学：conformalPValue —— 校准分数的保形 p-值
 *   p = (1 + #{s_i ≥ s}) / (n+1)：可交换性下超均匀
 *   （P(p ≤ t) ≤ t，Vovk），把保形残差接入任意时刻 p-值语言。
 * - 性能：selectRiskControlledThreshold 由 O(2·G·n) 双遍扫描改为
 *   **一次排序 + 二分定位**（O(n log n + G·log n)）：经验风险
 *   mean = #{s<λ}/n 由升序样本上的 lower-bound 二分 O(log n) 取得，
 *   0/1 指示样本方差以闭式 (k(1−mean)² + (n−k)·mean²)/(n−1) 代数
 *   等价替换两遍累加——与旧实现解析等价（指示变量方差恒等式，
 *   浮点级差 ≤ 1e-12），网格遍历顺序与「取最大合格 λ」语义逐位保持。
 */

import { fixedSampleUpperBound, round } from './anytime-evidence.js';

// ─────────────────────────── 保形次序统计量 ───────────────────────────

/**
 * 保形分位数（纯函数）：校准分数的 ⌈(n+1)(1−α)⌉ 次序统计量。
 *
 * 有限样本精确覆盖（可交换性下）：P(新样本分数 ≤ q̂) ≥ 1−α。
 * 秩超出 n（校准集太小撑不起该置信度）→ 返回 undefined（诚实发散）。
 */
export function conformalQuantile(scores: number[], alpha: number): number | undefined {
  const n = scores.length;
  if (n === 0) return undefined;
  const rank = Math.ceil((n + 1) * (1 - alpha));
  if (rank > n) return undefined;
  const sorted = [...scores].sort((a, b) => a - b);
  return sorted[rank - 1];
}

// ───────────────────── R5：Mondrian 条件保形（分组覆盖保证） ─────────────────────

/** Mondrian 保形分位数读取视图 */
export interface MondrianQuantileResult {
  /** 组条件保形半径（source='none' 时 undefined） */
  qhat?: number;
  /** 口径：组自身样本（条件保证）/ 合并池（仅边际保证）/ 无 */
  source: 'group' | 'pooled' | 'none';
  /** 该口径下的校准样本量 */
  calibrationN: number;
  /** 查询的组标签 */
  group: string;
  /** 名义误覆盖率 α */
  alpha: number;
}

/**
 * Mondrian 保形分位数（组条件覆盖保证）。
 *
 * Mondrian 框架：把样本空间按组标签剖分，每组独立做分裂保形
 * （每组 α_g = α）。Mondrian 定理保证每个组的**条件**覆盖
 *   P(新样本被覆盖 | 组 = g) ≥ 1 − α_g
 * ——只要组内分数与新样本在组内可交换。组样本撑不起该置信度
 * （秩 > n_g）时回退合并池：合并池内可交换性给出**边际**覆盖
 * ≥ 1−α，但组间分布异质时条件保证不再精确成立——source 如实
 * 标记 'pooled'（诚实降级，不假装条件有效）。
 */
export function mondrianQuantile(
  scoresByGroup: ReadonlyMap<string, readonly number[]>,
  group: string,
  alpha: number,
): MondrianQuantileResult {
  const groupScores = scoresByGroup.get(group);
  if (groupScores && groupScores.length > 0) {
    const q = conformalQuantile([...groupScores], alpha);
    if (q !== undefined) {
      return { qhat: q, source: 'group', calibrationN: groupScores.length, group, alpha };
    }
  }
  const pooled: number[] = [];
  for (const scores of scoresByGroup.values()) pooled.push(...scores);
  const qPooled = pooled.length > 0 ? conformalQuantile(pooled, alpha) : undefined;
  if (qPooled === undefined) {
    return { source: 'none', calibrationN: pooled.length, group, alpha };
  }
  return { qhat: qPooled, source: 'pooled', calibrationN: pooled.length, group, alpha };
}

/** Mondrian 保形区间（finite=false 时诚实发散；pooled 标记条件口径降级） */
export interface MondrianInterval extends ConformalInterval {
  /** 查询的组标签 */
  group: string;
  /** true = 组条件保证（source='group'）；false = 合并池回退（仅边际保证） */
  conditional: boolean;
}

/**
 * Mondrian 保形区间引擎：按组维护校准集（每组 FIFO maxCalibration），
 * interval(group, ŷ) 返回组条件保形区间。
 *
 * 数据流与 ConformalIntervalEngine 同构：calibrate(group, residual)
 * 入组校准集；interval 时先查组口径、不足回退合并池。保证：
 * source='group' 的区间在组内精确覆盖 ≥ 1−α（条件于组标签）。
 */
export class MondrianConformalEngine {
  private readonly config: ConformalIntervalConfig;
  private readonly calibrationByGroup = new Map<string, number[]>();

  constructor(config?: Partial<ConformalIntervalConfig>) {
    this.config = { ...DEFAULT_CONFORMAL_CONFIG, ...config };
  }

  /** 名义误覆盖率 */
  get alpha(): number {
    return this.config.alpha;
  }

  /** 已登记的组标签 */
  groups(): string[] {
    return [...this.calibrationByGroup.keys()];
  }

  /** 组校准样本量（无组返回 0；缺省 group 逐组，传 undefined 返回总量） */
  calibrationSize(group?: string): number {
    if (group !== undefined) return this.calibrationByGroup.get(group)?.length ?? 0;
    let total = 0;
    for (const scores of this.calibrationByGroup.values()) total += scores.length;
    return total;
  }

  /** 入组校准样本（残差 = |真值 − 点预测|；每组 FIFO 上限） */
  calibrate(group: string, residual: number): void {
    let scores = this.calibrationByGroup.get(group);
    if (!scores) {
      scores = [];
      this.calibrationByGroup.set(group, scores);
    }
    scores.push(Math.max(0, residual));
    if (scores.length > this.config.maxCalibration) {
      scores.splice(0, scores.length - this.config.maxCalibration);
    }
  }

  /** 组条件保形区间（组不足回退合并池，conditional=false 如实标记） */
  interval(group: string, pointForecast: number): MondrianInterval {
    const mondrian = mondrianQuantile(this.calibrationByGroup, group, this.config.alpha);
    if (mondrian.qhat === undefined) {
      return {
        lower: Number.NEGATIVE_INFINITY,
        upper: Number.POSITIVE_INFINITY,
        finite: false,
        qhat: Number.NaN,
        calibrationN: mondrian.calibrationN,
        alpha: this.config.alpha,
        group,
        conditional: false,
      };
    }
    return {
      lower: pointForecast - mondrian.qhat,
      upper: pointForecast + mondrian.qhat,
      finite: true,
      qhat: mondrian.qhat,
      calibrationN: mondrian.calibrationN,
      alpha: this.config.alpha,
      group,
      conditional: mondrian.source === 'group',
    };
  }
}

// ───────────────────── R5：保形 p-值（可交换性下超均匀） ─────────────────────

/**
 * 保形 p-值：p = (1 + #{s_i ≥ s}) / (n + 1)。
 *
 * (校准分数 s₁..s_n, 新分数 s) 可交换时，新分数的秩在 {1..n+1} 上
 * 均匀 → p 超均匀（P(p ≤ t) ≤ t，Vovk）。与 12.0 的任意时刻 p-值
 * 同语言：保形残差第一次能以「p 值」而非「区间」的口径进入裁决链。
 */
export function conformalPValue(scores: readonly number[], s: number): number {
  const n = scores.length;
  let count = 0;
  for (const x of scores) if (x >= s) count += 1;
  return (1 + count) / (n + 1);
}

/** 保形预测区间 */
export interface ConformalInterval {
  /** 下界（finite=false 时为 −Infinity） */
  lower: number;
  /** 上界（finite=false 时为 +Infinity） */
  upper: number;
  /** 区间是否有限（false = 校准不足，诚实承认无法覆盖） */
  finite: boolean;
  /** 保形半径 q̂ */
  qhat: number;
  /** 校准样本量 */
  calibrationN: number;
  /** 名义误覆盖率 α（覆盖 ≥ 1−α） */
  alpha: number;
}

// ─────────────────────────── 覆盖漂移监测 ───────────────────────────

/** 覆盖漂移监测读取视图 */
export interface CoverageDriftView {
  /** 当前 e-值（≥ 1/δ 确证欠覆盖漂移） */
  eValue: number;
  /** 是否已确证漂移（欠覆盖） */
  drifting: boolean;
  /** 观测覆盖率的 EMA（对照目标 1−α） */
  empiricalCoverage: number;
  /** 目标覆盖率 */
  targetCoverage: number;
  /** 观测数 */
  n: number;
}

/**
 * 覆盖漂移 e-过程监测器（12.0 复用）
 *
 * 语义：校准良好的区间在每个时刻的条件覆盖率 ≥ 1−α。资本过程
 * e_t = Π(1 + λ_i(C_i − (1−α)))，λ_i ≤ 0 可预测，在「覆盖率达标」
 * 零假设下是非负上鞅（Ville：P(∃t: e ≥ 1/δ) ≤ δ）。连续欠覆盖
 * 会让资本指数上升 → e ≥ 1/δ 确证漂移 → 建议重校准。
 */
export class CoverageDriftMonitor {
  private capital = 1;
  private n = 0;
  private coverageEma: number | undefined;

  constructor(
    /** 名义误覆盖率 α（目标覆盖率 1−α） */
    public readonly alpha: number,
    /** 漂移确证水平 δ（e ≥ 1/δ 确证；缺省 0.01） */
    public readonly delta: number,
  ) {}

  /** 观测一次预测是否覆盖真值 */
  observe(covered: boolean): CoverageDriftView {
    const target = 1 - this.alpha;
    const indicator = covered ? 1 : 0;
    // 可预测 λ ≤ 0：EMA 低于目标（疑似欠覆盖）时才下注——λ<0 使
    // 未覆盖事件（indicator−target = −(1−α) < 0）推高资本、覆盖事件
    // 轻微回撤；EMA 高于目标时 λ=0（不下注，资本横盘）。
    // 截断 [−0.5, 0] 保证因子 1+λ(C−(1−α)) > 0 恒成立。
    const observed = this.coverageEma ?? target;
    const lambda = Math.max(-0.5, Math.min(0, (observed - target) / 4));
    this.capital *= Math.max(0.5, 1 + lambda * (indicator - target));
    this.n += 1;
    this.coverageEma = this.coverageEma === undefined ? indicator : 0.9 * this.coverageEma + 0.1 * indicator;
    return this.view();
  }

  /** 当前视图 */
  view(): CoverageDriftView {
    return {
      eValue: round(this.capital),
      drifting: this.capital >= 1 / this.delta,
      empiricalCoverage: round(this.coverageEma ?? 0),
      targetCoverage: round(1 - this.alpha),
      n: this.n,
    };
  }

  /** 重置（重校准后重启监测） */
  reset(): void {
    this.capital = 1;
    this.n = 0;
    this.coverageEma = undefined;
  }
}

// ─────────────────────────── 保形区间引擎 ───────────────────────────

/** 保形区间引擎配置 */
export interface ConformalIntervalConfig {
  /** 名义误覆盖率 α（区间覆盖 ≥ 1−α，缺省 0.1） */
  alpha: number;
  /** 校准集容量上限（FIFO；缺省 200） */
  maxCalibration: number;
  /** 覆盖漂移确证水平 δ（缺省 0.01） */
  driftDelta: number;
}

export const DEFAULT_CONFORMAL_CONFIG: ConformalIntervalConfig = {
  alpha: 0.1,
  maxCalibration: 200,
  driftDelta: 0.01,
};

/** 保形引擎状态报告 */
export interface ConformalStatus {
  calibrationN: number;
  alpha: number;
  /** 当前保形半径（校准不足时 undefined） */
  qhat?: number;
  /** 漂移监测视图 */
  drift: CoverageDriftView;
  /** 累计发出的区间数 / 覆盖数（经验口径） */
  emitted: number;
  covered: number;
  interpretation: string;
}

/**
 * 保形区间引擎
 *
 * 数据流：
 *   预测前：interval(pointForecast) → 带 1−α 精确覆盖保证的区间
 *   真值到达：calibrate(|y − ŷ|) 入校准集 + recordCovered(覆盖?) 喂漂移监测
 *   漂移确证：drifting=true → 调用方重校准（resetDrift 重启监测）
 */
export class ConformalIntervalEngine {
  private readonly config: ConformalIntervalConfig;
  private calibration: number[] = [];
  private monitor: CoverageDriftMonitor;
  private emitted = 0;
  private coveredCount = 0;

  constructor(config?: Partial<ConformalIntervalConfig>) {
    this.config = { ...DEFAULT_CONFORMAL_CONFIG, ...config };
    this.monitor = new CoverageDriftMonitor(this.config.alpha, this.config.driftDelta);
  }

  /** 名义误覆盖率 */
  get alpha(): number {
    return this.config.alpha;
  }

  /** 校准样本量 */
  get calibrationSize(): number {
    return this.calibration.length;
  }

  /** 当前保形半径（校准不足时 undefined） */
  get qhat(): number | undefined {
    return conformalQuantile(this.calibration, this.config.alpha);
  }

  /** 入校准样本（残差 = |真值 − 点预测|） */
  calibrate(residual: number): void {
    this.calibration.push(Math.max(0, residual));
    if (this.calibration.length > this.config.maxCalibration) {
      this.calibration.splice(0, this.calibration.length - this.config.maxCalibration);
    }
  }

  /**
   * 为点预测生成保形区间。
   *
   * 校准充足（秩 ≤ n）：[ŷ−q̂, ŷ+q̂]，精确覆盖 ≥ 1−α；
   * 校准不足：finite=false（lower=−∞/upper=+∞）——诚实承认无法覆盖。
   */
  interval(pointForecast: number): ConformalInterval {
    this.emitted += 1;
    const q = conformalQuantile(this.calibration, this.config.alpha);
    if (q === undefined) {
      return {
        lower: Number.NEGATIVE_INFINITY,
        upper: Number.POSITIVE_INFINITY,
        finite: false,
        qhat: Number.NaN,
        calibrationN: this.calibration.length,
        alpha: this.config.alpha,
      };
    }
    return {
      lower: pointForecast - q,
      upper: pointForecast + q,
      finite: true,
      qhat: q,
      calibrationN: this.calibration.length,
      alpha: this.config.alpha,
    };
  }

  /** 登记一次覆盖结果（漂移监测 + 经验覆盖统计） */
  recordCovered(covered: boolean): CoverageDriftView {
    if (covered) this.coveredCount += 1;
    return this.monitor.observe(covered);
  }

  /** 重校准后重启漂移监测（保留校准集——它承载新分布的证据） */
  resetDrift(): void {
    this.monitor.reset();
  }

  /** 引擎状态 */
  status(): ConformalStatus {
    const q = conformalQuantile(this.calibration, this.config.alpha);
    const drift = this.monitor.view();
    const interpretation =
      this.calibration.length === 0
        ? '保形引擎待校准（calibrate 喂入首批残差后区间生效）'
        : q === undefined
          ? `校准样本 ${this.calibration.length} 不足以支撑 ${(1 - this.config.alpha) * 100}% 覆盖（需 ${Math.ceil(1 / (1 - this.config.alpha)) - 1} 条以上）——区间诚实发散`
          : drift.drifting
            ? `覆盖漂移确证：经验覆盖 ${(drift.empiricalCoverage * 100).toFixed(0)}% vs 目标 ${((1 - this.config.alpha) * 100).toFixed(0)}%（e=${drift.eValue.toFixed(1)} ≥ 1/δ）——应重校准`
            : `区间生效：q̂=${q.toFixed(3)}（${this.calibration.length} 条校准），覆盖监测正常（经验 ${drift.empiricalCoverage.toFixed(2)}）`;
    return {
      calibrationN: this.calibration.length,
      alpha: this.config.alpha,
      qhat: q === undefined ? undefined : round(q),
      drift,
      emitted: this.emitted,
      covered: this.coveredCount,
      interpretation,
    };
  }
}

// ─────────────────────────── 风险受控阈值选择 ───────────────────────────

/** 风险受控阈值选择结果 */
export interface RiskControlResult {
  /** 选定阈值（网格中最激进的合格者） */
  threshold: number;
  /** 该阈值下的经验风险（样本口径） */
  empiricalRisk: number;
  /** 风险上界（1−δ 置信；≤ target 是入选资格） */
  riskBound: number;
  /** 目标风险 α */
  target: number;
  /** 置信度 1−δ */
  confidence: number;
  /** 参与选择的样本量 */
  samples: number;
  /** 候选网格大小 */
  grid: number;
  interpretation: string;
}

/**
 * 风险受控阈值选择（RCPS 思想：固定候选网格 + Bonferroni 分摊
 * + 12.0 经验伯恩斯坦上界）
 *
 * 语义：risk(λ) = P(X < λ)（如质量分低于阈值触发重试的概率）。
 * 对每个 λ ∈ grid 用 1−δ/G 置信上界估计 risk(λ)，取上界 ≤ α 的
 * **最大** λ（最激进/最严格的质量门槛）：
 *   P(未来真实风险 ≤ α) ≥ 1−δ
 *
 * 用于反思引擎重试阈值：保证「重试率 ≤ α」的同时把质量门槛推到
 * 数学允许的最严处——旧 ±0.02 步进启发式被带保证的选择取代。
 *
 * 样本不足（无合格 λ）→ 返回 undefined（调用方回退既有逻辑）。
 *
 * R5 性能：O(2·G·n) 双遍扫描 → **一次排序 O(n log n) + 每 λ 一次
 * 二分 O(log n)**。#{s<λ} 由升序数组 lower-bound 二分取得（与线性
 * 扫描逐位同值）；0/1 指示样本方差用代数恒等式
 *   Σ(1{s<λ} − mean)² = k(1−mean)² + (n−k)·mean², k = #{s<λ}
 * 闭式替换（解析等价，浮点级差 ≤ 1e-12）。网格遍历顺序与
 * 「取数组序最后一个合格 λ」的既有语义逐位保持。
 */
export function selectRiskControlledThreshold(
  samples: number[],
  grid: number[],
  options?: { targetRisk?: number; confidence?: number },
): RiskControlResult | undefined {
  const alpha = options?.targetRisk ?? 0.1;
  const delta = 1 - (options?.confidence ?? 0.95);
  const n = samples.length;
  if (n < 2 || grid.length === 0) return undefined;

  const beta = delta / grid.length; // Bonferroni 分摊
  const sorted = [...samples].sort((a, b) => a - b); // 一次排序，全部 λ 共享
  let chosen: RiskControlResult | undefined;
  for (const lambda of grid) {
    // k = #{s < λ}：升序数组上的 lower-bound 二分（与旧线性扫描同值）
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < lambda) lo = mid + 1;
      else hi = mid;
    }
    const below = lo;
    const mean = below / n;
    // 0/1 指示方差闭式（与两遍累加解析等价）
    const variance = (below * (1 - mean) * (1 - mean) + (n - below) * mean * mean) / (n - 1);
    const bound = fixedSampleUpperBound(n, mean, variance, beta);
    if (bound <= alpha) {
      // 风险上界合格；取最大 λ（网格升序遍历，后者覆盖前者）
      chosen = {
        threshold: lambda,
        empiricalRisk: round(mean),
        riskBound: round(bound),
        target: alpha,
        confidence: 1 - delta,
        samples: n,
        grid: grid.length,
        interpretation: `阈值 ${lambda.toFixed(3)}：经验风险 ${(mean * 100).toFixed(1)}%，上界 ${(bound * 100).toFixed(1)}% ≤ 目标 ${(alpha * 100).toFixed(0)}%（${((1 - delta) * 100).toFixed(0)}% 置信，Bonferroni ×${grid.length}）`,
      };
    }
  }
  return chosen;
}
