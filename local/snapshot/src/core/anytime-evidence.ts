/**
 * anytime-evidence.ts — 任意时刻有效证据内核（项目 12.0「永不撒谎的统计」质变基座）
 *
 * 升级前的根本局限（3.0 证据内核的天花板）：
 * 系统是一部**永不停机的流处理器**——决策、选型、进化、熔断每时每刻
 * 都在读取统计量并行动。但 3.0 的 Wilson 下界是**固定样本口径**的：
 * - 「偷看」无效：Wilson 界只在「先定样本量、再看数据」时成立；系统
 *   却是边看边停（连续监控下任何固定样本界都会严重夸大置信度——
 *   停止时刻是被数据挑选的， peeking 悖论）；
 * - 不能「随时下结论」：想宣布「模型 A 确证劣于基线」，现有口径没有
 *   合法的停止规则——要么等固定样本（永远不齐），要么偷看（不合法）；
 * - 多重比较失控：对 N 个模型/N 条策略各自做检验，错误发现率（FDR）
 *   无控制——并行淘汰越激进，冤案率越高；
 * - 置信度随时间重置：同一统计量在不同时刻反复使用，名义 95% 的界
 *   实际覆盖率随观测次数增加而衰减到 0。
 *
 * 本内核引入 2020 年代统计学的任意时刻有效推断
 * （Ramdas–Grünwald–Vovk–Shafer 学派：e-值 / e-过程 / 置信序列）：
 *
 * 1. **缝合经验伯恩斯坦置信序列（stitched EB-CS）**：
 *      CS_t = μ̂_t ± min(Hoeffding 半径, EB 半径)
 *    对全部时刻 t 同时成立（时间一致覆盖 ≥ 1−α）——**在任意停止时刻
 *    读区间都合法**。几何分期（epoch 2^k）× 联合界把「偷看」变合法；
 *    低方差流上 EB 半径远窄于 Hoeffding（收敛快一个量级）。
 *
 * 2. **e-过程（资本过程 / 可验证赌注）**：检验 H0: μ ≤ μ0（或 ≥ μ0）
 *      e_t = Π (1 + λ_i (X_i − μ0)), λ 可预测（只依赖过去）
 *    零假设下 e_t 是非负上鞅 → Ville 不等式：
 *      P(∃t: e_t ≥ 1/α) ≤ α
 *    **对任意（甚至数据自适应的）停止时刻有效**——「证据积到 1/α
 *    就定罪」是数学上无懈可击的停止规则。
 *
 * 3. **e-BH 多重检验（FDR 控制）**：对 m 条并行检验的 e-值做
 *    Benjamini-Hochberg 的 e-版本（Wang & Ramdas 2022）：在**任意
 *    依赖**结构下 FDR ≤ fdr——并行淘汰「证明确实差」的策略/模型时，
 *    冤案率的数学上限被钉死。
 *
 * 4. **任意时刻 p-值**：p_t = min(1, 1/e_t)——对每个 t 都合法
 *    （超均匀），与 e-过程同源。
 *
 * 与 3-11.0 的关系：3.0 给了统一的证据语言，本内核给这套语言
 * 补上**在线有效性**——系统从「定时看报表的统计」升维为
 * 「永不停机且永不撒谎的统计」。Wilson 下界继续服务固定口径场景
 * （并行旁路，不替换）；凡「边看边停」的场景（进化淘汰、劣化判定、
 * 漂移侦测）一律升级为任意时刻有效口径。
 *
 * R5 第五轮进化（内核世界性进化·统计推断组）：
 * - 数学：MixtureEProcess —— **混合 e-过程**（ε-混合 / robust-to-
 *   unknown-effect-size）：对一组固定 λ 网格并行跑资本过程并取凸组合。
 *   e-过程的凸组合仍是 e-过程（非负上鞅的凸组合仍是非负上鞅，
 *   E ≤ 1 保持）→ Ville 不等式原样成立。单一可预测 λ 在真实效应
 *   量未知时赌错方向幅度就浪费证据；混合网格对未知效应量稳健——
 *   大效应由大 λ 分量收割、小效应由小 λ 分量细磨，任何量级都有
 *   分量接近最优（Ramdas–Grünwald–Vovk–Shafer 学派的 mixture 思想）。
 * - 数学：anytimeConfidenceSet —— **e-过程对偶置信集**（AV-CI）：
 *   对 μ 网格逐点构造点零假设 H0: μ = μ₀ 的双向混合 e-过程
 *   e(μ₀) = ½·e↑(μ₀) + ½·e↓(μ₀)（点零假设下两向上鞅 E=1，等权
 *   平均仍是上鞅），拒绝集 {μ₀ : e(μ₀) ≥ 1/α}。Ville：
 *   P(∃t: μ* 被拒) ≤ α —— 在**任意停止时刻**读取该置信集，
 *   覆盖 ≥ 1−α（e-值与置信区间的对偶性落地成闭式可算的区间）。
 * - 数值稳健：混合资本全程 **log 域**累积（log1p 逐因子 + 私有
 *   log-sum-exp 聚合）：万步流的线性资本 0.5^10000 ≈ 1e-3010 早已
 *   下溢为 0（信息全丢），log 域仍精确保持（logEValue 无损读取）；
 *   eValue 读取端再做安全 exp（≥ 709.78 时饱和 +∞ 而非 Infinity 噪声）。
 */

// ─────────────────────────── 缝合置信序列 ───────────────────────────

/** 置信序列读取视图（任意时刻读取均合法） */
export interface ConfidenceSequenceView {
  /** 样本量 */
  n: number;
  /** 样本均值（中心估计） */
  mean: number;
  /** 时间一致置信下界（覆盖 ≥ 1−α 对所有 t 同时成立） */
  lower: number;
  /** 时间一致置信上界 */
  upper: number;
  /** 半径（upper − mean） */
  radius: number;
  /** 当前分期（epoch k = ⌊log2 n⌋） */
  epoch: number;
}

/**
 * 缝合置信序列半径（纯函数，epoch k 上的联合界）。
 *
 * 数学（对 n ≥ 1，k = ⌊log2 n⌋，β_k = α·2^{−(k+2)} 每条界各分一半）：
 * - Hoeffding：|μ̂−μ| ≤ sqrt(ln(2/β_k) / (2n))（X∈[0,1]）
 * - 经验伯恩斯坦（Maurer–Pontil）：|μ̂−μ| ≤ sqrt(2σ̂²·ln(2/β_k)/n)
 *   + 7ln(2/β_k)/(3(n−1))，σ̂² = 样本方差
 * - 取二者最小（每条各用 β_k，分期 × 两条界联合求和恰为 α）
 *
 * 任何时刻读取均合法：Σ_k 2β_k = α。
 */
export function stitchedCsRadius(n: number, sampleVariance: number, alpha: number): number {
  if (n <= 0) return Infinity;
  const epoch = Math.floor(Math.log2(n));
  const beta = alpha * Math.pow(2, -(epoch + 2));
  const logTerm = Math.log(2 / beta);
  const hoeffding = Math.sqrt(logTerm / (2 * n));
  if (n < 2) return hoeffding;
  const variance = Math.min(0.25, Math.max(0, sampleVariance));
  const eb = Math.sqrt((2 * variance * logTerm) / n) + (7 * logTerm) / (3 * (n - 1));
  return Math.min(hoeffding, eb);
}

/**
 * 固定样本单侧上界（13.0 风险控制器复用；β 直接给定，不做分期）。
 *
 * 经验伯恩斯坦上界：μ ≤ μ̂ + sqrt(2σ̂²·ln(1/β)/n) + 7ln(1/β)/(3(n−1))。
 */
export function fixedSampleUpperBound(n: number, mean: number, sampleVariance: number, beta: number): number {
  if (n <= 0) return 1;
  const logTerm = Math.log(1 / beta);
  if (n < 2) return Math.min(1, mean + Math.sqrt(logTerm / (2 * n)));
  const variance = Math.min(0.25, Math.max(0, sampleVariance));
  const eb = Math.sqrt((2 * variance * logTerm) / n) + (7 * logTerm) / (3 * (n - 1));
  const hoeffding = Math.sqrt(logTerm / (2 * n));
  return Math.min(1, mean + Math.min(eb, hoeffding));
}

/**
 * 流式经验伯恩斯坦置信序列
 *
 * observe(x∈[0,1]) 单遍累积（均值 + 方差 Welford 在线算法），
 * bounds() 在任意时刻返回时间一致置信区间。
 */
export class EmpiricalBernsteinSequence {
  private n = 0;
  private mean = 0;
  private m2 = 0; // Welford 二阶累积（M2 = Σ(x−μ̂)²）

  constructor(private readonly alpha: number) {}

  /** 观测一次 x ∈ [0,1]（连续收益按值观测，布尔按 0/1 观测） */
  observe(x: number): void {
    const v = Math.max(0, Math.min(1, x));
    this.n += 1;
    const delta = v - this.mean;
    this.mean += delta / this.n;
    this.m2 += delta * (v - this.mean);
  }

  /** 当前样本量 */
  get count(): number {
    return this.n;
  }

  /** 当前均值 */
  get sampleMean(): number {
    return this.mean;
  }

  /** 样本方差（n≥2；n=1 视为 0） */
  get sampleVariance(): number {
    return this.n >= 2 ? this.m2 / (this.n - 1) : 0;
  }

  /** 任意时刻读取的时间一致置信区间 */
  bounds(): ConfidenceSequenceView {
    const radius = this.n > 0 ? stitchedCsRadius(this.n, this.sampleVariance, this.alpha) : Infinity;
    return {
      n: this.n,
      mean: round(this.mean),
      lower: round(Math.max(0, this.mean - radius)),
      upper: round(Math.min(1, this.mean + radius)),
      radius: round(radius),
      epoch: this.n > 0 ? Math.floor(Math.log2(this.n)) : -1,
    };
  }

  /** 假设值 μ 是否落在当前置信序列内（任意停止时刻合法） */
  contains(mu: number): boolean {
    if (this.n === 0) return true;
    const b = this.bounds();
    return mu >= b.lower - 1e-9 && mu <= b.upper + 1e-9;
  }
}

// ─────────────────────────── e-过程 ───────────────────────────

/** e-过程方向：null 为 μ ≤ μ0（at-most）或 μ ≥ μ0（at-least） */
export type EProcessSide = 'at-most' | 'at-least';

/**
 * 单侧 e-过程（资本过程）
 *
 * 检验 H0: μ ≤ μ0（side='at-most'，λ ≥ 0）或 H0: μ ≥ μ0
 * （side='at-least'，λ ≤ 0）：
 *   e_t = Π_{i≤t} (1 + λ_i (X_i − μ0))
 * λ_i 可预测（只依赖 i−1 前的 μ̂）且 |λ_i| ≤ 0.5 —— 对任意
 * μ0∈(0,1)、x∈[0,1] 保持因子严格正（≥ 0.5）。零假设下
 * E[1+λ(X−μ0)] ≤ 1 → 非负上鞅 → Ville：P(∃t: e_t ≥ 1/α) ≤ α。
 */
export class EProcess {
  private capital = 1;
  private n = 0;
  private mean = 0;
  /** 历史峰值（审计：证据曾到达多强） */
  private peak = 1;

  constructor(
    public readonly mu0: number,
    public readonly side: EProcessSide,
  ) {}

  /** 观测一次 x ∈ [0,1]；返回更新后的 e-值 */
  observe(x: number): number {
    const v = Math.max(0, Math.min(1, x));
    // 可预测 λ：上一时刻均值与零假设的背离 ÷ 4，截断到 [−0.5, 0.5]，
    // 符号由检验方向决定（背离方向才有赌注价值）
    const edge = (this.mean - this.mu0) / 4;
    const lambda = this.side === 'at-most' ? clamp(lambdaAtMost(edge), 0, 0.5) : clamp(lambdaAtLeast(edge), -0.5, 0);
    const factor = 1 + lambda * (v - this.mu0);
    this.capital *= Math.max(0.5, factor); // 因子下界保护（数学上恒 ≥ 0.5，冗余防御）
    this.peak = Math.max(this.peak, this.capital);
    this.n += 1;
    this.mean += (v - this.mean) / this.n;
    return this.capital;
  }

  /** 当前 e-值（≥ 0；零假设下任意时刻 ≤ 1/α 的概率 ≤ α） */
  get eValue(): number {
    return this.capital;
  }

  /** 历史峰值 */
  get peakValue(): number {
    return this.peak;
  }

  /** 样本量 */
  get count(): number {
    return this.n;
  }

  /** 是否已在水平 α 下拒绝零假设（e ≥ 1/α，任意停止时刻合法） */
  rejectedAt(alpha: number): boolean {
    return this.capital >= 1 / alpha;
  }

  /** 任意时刻有效 p-值：p_t = min(1, 1/e_t)（超均匀） */
  anytimePValue(): number {
    return Math.min(1, 1 / this.capital);
  }
}

function lambdaAtMost(edge: number): number {
  // at-most 方向（H0: μ ≤ μ0）：λ ≥ 0，均值高于 μ0 才下注
  return Math.max(0, edge);
}

function lambdaAtLeast(edge: number): number {
  // at-least 方向（H0: μ ≥ μ0）：λ ≤ 0，均值低于 μ0 才下注
  return Math.min(0, edge);
}

// ─────────────────────────── R5：混合 e-过程（log 域） ───────────────────────────

/** 混合 e-过程配置（全部可选；缺省 λ 网格 0.05~0.5 六档等权） */
export interface MixtureEProcessOptions {
  /** λ 网格（绝对值；符号由 side 决定；各值会被钳到 [1e-4, 0.5]） */
  lambdas?: number[];
  /** 分量权重（缺省均匀；自动归一化，负权重钳 0） */
  weights?: number[];
}

/** 缺省混合 λ 网格：小效应 0.05 细磨 → 大效应 0.5 强收（六档等权） */
export const DEFAULT_MIXTURE_LAMBDAS: readonly number[] = [0.05, 0.1, 0.15, 0.25, 0.35, 0.5];

/** exp 安全上界（log 资本 ≥ 此值时 eValue 饱和 +∞，避免 exp 溢出噪声） */
const LOG_EXP_OVERFLOW = 709.782712893384;

/**
 * 混合 e-过程（ε-mixture 资本过程，log 域实现）。
 *
 * 数学：分量 j 的资本 W_j = Π_i (1 + λ_j (X_i − μ0)) 在零假设下是
 * 非负上鞅（E[W_j] ≤ 1）；凸组合 W = Σ_j w_j W_j 仍是非负上鞅
 * （上鞅的凸组合保持，Jensen/线性期望逐条成立）→ Ville：
 *   P(∃t: W_t ≥ 1/α) ≤ α —— 任意停止时刻合法。
 *
 * 数值：每个分量以 logCapital_j = Σ log1p(λ_j(X_i − μ0)) 累积
 * （|λ_j| ≤ 0.5 ⇒ 因子 ∈ [0.5, 1.5]，log1p 无损）；混合读取走
 * log-sum-exp——万步流的 1e-3010 量级资本在线性域早已下溢为 0，
 * log 域仍精确（logEValue 无损口径）。
 */
export class MixtureEProcess {
  private readonly mu0Value: number;
  private readonly lambdas: number[];
  private readonly logWeights: number[];
  private readonly logCapitals: number[];
  private n = 0;
  private mean = 0;
  private peakLog = 0; // log 域历史峰值（审计）

  constructor(
    mu0: number,
    side: EProcessSide,
    options?: MixtureEProcessOptions,
  ) {
    this.mu0Value = Math.min(1 - 1e-9, Math.max(1e-9, mu0));
    const rawLambdas = options?.lambdas ?? DEFAULT_MIXTURE_LAMBDAS;
    const filtered = rawLambdas.map((l) => Math.abs(l)).filter((l) => Number.isFinite(l) && l >= 1e-4);
    this.lambdas = (filtered.length > 0 ? filtered : [...DEFAULT_MIXTURE_LAMBDAS]).map((l) =>
      Math.min(0.5, Math.max(1e-4, side === 'at-least' ? -l : l)),
    );
    const rawW = options?.weights;
    const base = rawW && rawW.length === this.lambdas.length ? rawW.map((w) => Math.max(0, w)) : this.lambdas.map(() => 1);
    const total = base.reduce((s, w) => s + w, 0);
    this.logWeights = base.map((w) => Math.log(w / total));
    this.logCapitals = this.lambdas.map(() => 0);
  }

  /** 参考水位线 */
  get mu0(): number {
    return this.mu0Value;
  }

  /** λ 网格副本（审计用） */
  get mixtureLambdas(): number[] {
    return [...this.lambdas];
  }

  /** 观测一次 x ∈ [0,1]；返回更新后的混合 e-值 */
  observe(x: number): number {
    const v = Math.max(0, Math.min(1, x));
    for (let j = 0; j < this.lambdas.length; j += 1) {
      const factor = Math.max(0.5, 1 + this.lambdas[j]! * (v - this.mu0Value)); // |λ|≤0.5 ⇒ 因子 ≥ 0.5（冗余防御）
      this.logCapitals[j]! += Math.log(factor);
    }
    this.n += 1;
    this.mean += (v - this.mean) / this.n;
    const logE = this.logEValue;
    if (logE > this.peakLog) this.peakLog = logE;
    return logE >= LOG_EXP_OVERFLOW ? Number.POSITIVE_INFINITY : Math.exp(logE);
  }

  /** 混合 e-值（log 域读取后安全 exp；log ≥ 709.78 饱和 +∞） */
  get eValue(): number {
    const logE = this.logEValue;
    return logE >= LOG_EXP_OVERFLOW ? Number.POSITIVE_INFINITY : Math.exp(logE);
  }

  /** 混合 e-值的对数（无损口径：线性域下溢到 0 后仍精确可读） */
  get logEValue(): number {
    return mixtureLogSumExp(this.logCapitals, this.logWeights);
  }

  /** log 域历史峰值 */
  get peakLogValue(): number {
    return this.peakLog;
  }

  /** 样本量 */
  get count(): number {
    return this.n;
  }

  /** 是否已在水平 α 下拒绝零假设（log 域比较，无溢出） */
  rejectedAt(alpha: number): boolean {
    return this.logEValue >= -Math.log(alpha);
  }

  /** 任意时刻有效 p-值：p_t = min(1, exp(−logE))（超均匀） */
  anytimePValue(): number {
    const logE = this.logEValue;
    if (logE <= 0) return 1;
    return logE >= LOG_EXP_OVERFLOW ? 0 : Math.exp(-logE);
  }
}

/** log 域凸组合读取：log Σ_j w_j e^{c_j}（log-sum-exp，防上下溢） */
function mixtureLogSumExp(logCapitals: readonly number[], logWeights: readonly number[]): number {
  let max = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < logCapitals.length; j += 1) {
    const v = logCapitals[j]! + logWeights[j]!;
    if (v > max) max = v;
  }
  if (max === Number.NEGATIVE_INFINITY || max === Number.POSITIVE_INFINITY) return max;
  let sum = 0;
  for (let j = 0; j < logCapitals.length; j += 1) {
    sum += Math.exp(logCapitals[j]! + logWeights[j]! - max);
  }
  return max + Math.log(sum);
}

// ─────────────────────────── R5：e-过程对偶置信集（AV-CI） ───────────────────────────

/** 任意时刻有效置信集读取视图 */
export interface AnytimeConfidenceSet {
  /** 置信集下端（空集时 +∞——诚实的不确定：什么都不包含） */
  lower: number;
  /** 置信集上端（空集时 −∞） */
  upper: number;
  /** 置信集是否为空（全部网格点被 e-过程拒绝） */
  empty: boolean;
  /** 覆盖参数（任意停止时刻覆盖 ≥ 1−α） */
  alpha: number;
  /** 网格步长 */
  gridStep: number;
  /** 被拒绝的网格点数（审计：证据对假设空间的切除量） */
  rejected: number;
  /** 网格点总数 */
  grid: number;
}

/**
 * 任意时刻有效置信集（e-过程对偶：拒绝 {μ₀ : e(μ₀) ≥ 1/α}）。
 *
 * 对每个网格点 μ₀ 构造**点零假设** H0: μ = μ₀ 的双向等权混合
 * e-过程 e(μ₀) = ½·e↑(μ₀) + ½·e↓(μ₀)：点零下两个单向上鞅期望
 * 都恰为 1，等权平均仍是上鞅 → Ville：P(∃t: e(μ*) ≥ 1/α) ≤ α。
 * 保留集（未被拒绝的 μ₀）在任意停止时刻以 ≥ 1−α 覆盖真值。
 *
 * 与缝合置信序列（EmpiricalBernsteinSequence）的分工：CS 给
 * 「半径随 n 收缩」的中心区间；本函数给「e-证据切除」的对偶区间——
 * 二者数学口径同源（都时间一致），切除式区间在强证据下可非对称
 * 收缩（证据说「不在这里」就真的切掉）。纯函数：对给定样本数组
 * 一次性计算，复杂度 O(grid × n × |λ|)。
 */
export function anytimeConfidenceSet(
  samples: readonly number[],
  alpha: number,
  options?: { grid?: number[]; lambdas?: number[] },
): AnytimeConfidenceSet {
  const grid =
    options?.grid ??
    Array.from({ length: 99 }, (_, i) => Math.min(1, Math.max(0, (i + 1) / 100))); // 0.01 ~ 0.99
  let lower = Number.POSITIVE_INFINITY;
  let upper = Number.NEGATIVE_INFINITY;
  let rejectedCount = 0;
  const logAlpha = -Math.log(alpha);
  for (const mu0 of grid) {
    // 双向等权混合：log e = lse(logUp + ln½, logDown + ln½)
    const up = new MixtureEProcess(mu0, 'at-most', { lambdas: options?.lambdas });
    const down = new MixtureEProcess(mu0, 'at-least', { lambdas: options?.lambdas });
    for (const s of samples) {
      const v = Math.max(0, Math.min(1, s));
      up.observe(v);
      down.observe(v);
    }
    const logHalf = Math.log(0.5);
    const logE = mixtureLogSumExp([up.logEValue, down.logEValue], [logHalf, logHalf]);
    if (logE >= logAlpha) {
      rejectedCount += 1;
    } else {
      if (mu0 < lower) lower = mu0;
      if (mu0 > upper) upper = mu0;
    }
  }
  const empty = rejectedCount === grid.length;
  return {
    lower: empty ? Number.POSITIVE_INFINITY : lower,
    upper: empty ? Number.NEGATIVE_INFINITY : upper,
    empty,
    alpha,
    gridStep: grid.length > 1 ? Math.abs(grid[1]! - grid[0]!) : 0,
    rejected: rejectedCount,
    grid: grid.length,
  };
}

// ─────────────────────────── e-BH 多重检验 ───────────────────────────

/** e-BH 检验条目 */
export interface EBHEntry {
  /** 被检对象标识 */
  id: string;
  /** e-值（来自各对象的 e-过程） */
  eValue: number;
}

/**
 * e-Benjamini-Hochberg（Wang & Ramdas 2022）：任意依赖下 FDR ≤ fdr。
 *
 * 算法：e 值降序 e_(1) ≥ … ≥ e_(m)；
 *   k* = max{ k : e_(k) ≥ m/(k·fdr) }；
 *   拒绝所有 e ≥ m/(k*·fdr) 的对象（k*=0 时不拒绝）。
 *
 * 用途：并行淘汰「证明确实低于水位线」的策略/模型——冤案率（FDR）
 * 有数学上限，与检验数量、依赖结构无关。
 */
export function eBenjaminiHochberg(entries: EBHEntry[], fdr: number): string[] {
  const m = entries.length;
  if (m === 0 || fdr <= 0 || fdr > 1) return [];
  const sorted = [...entries].sort((a, b) => b.eValue - a.eValue);
  let kStar = 0;
  for (let k = 1; k <= m; k += 1) {
    if (sorted[k - 1]!.eValue >= m / (k * fdr)) kStar = k;
  }
  if (kStar === 0) return [];
  const threshold = m / (kStar * fdr);
  return entries.filter((e) => e.eValue >= threshold).map((e) => e.id);
}

// ─────────────────────────── 组合流 ───────────────────────────

/** 组合流配置 */
export interface AnytimeEvidenceConfig {
  /** 时间一致覆盖率（置信序列口径，缺省 0.05 → 95%） */
  alpha: number;
  /** 参考水位线 μ0（裁决基准：高于/低于该线的可证裁决，缺省 0.5） */
  reference: number;
}

export const DEFAULT_ANYTIME_EVIDENCE_CONFIG: AnytimeEvidenceConfig = {
  alpha: 0.05,
  reference: 0.5,
};

/** 任意时刻有效裁决 */
export type AnytimeVerdict = 'above-reference' | 'below-reference' | 'undecided';

/** 组合流读取视图 */
export interface AnytimeEvidenceView {
  n: number;
  /** 置信序列（任意时刻合法） */
  cs: ConfidenceSequenceView;
  /** H0: μ ≤ μ0 的 e-值（大 → 证实高于水位线） */
  eAbove: number;
  /** H0: μ ≥ μ0 的 e-值（大 → 证实低于水位线） */
  eBelow: number;
  /** 当前裁决（e ≥ 1/α 时确证；否则 undecided——诚实的不确定） */
  verdict: AnytimeVerdict;
  /** 任意时刻有效 p-值（与裁决同源） */
  anytimeP: number;
}

/**
 * 任意时刻有效证据流（置信序列 + 双侧 e-过程 + 裁决）
 *
 * 一次 observe 同时驱动三台机器：
 * - 置信序列：值域估计（任意时刻读取）
 * - e↑：检验「μ ≤ μ0」（确证高于水位线）
 * - e↓：检验「μ ≥ μ0」（确证低于水位线）
 * verdict 在任一方向确证时给出，否则 undecided——系统第一次拥有
 * 「随时下结论且结论永不夸大」的能力。
 */
export class AnytimeEvidenceStream {
  private readonly config: AnytimeEvidenceConfig;
  private readonly cs: EmpiricalBernsteinSequence;
  private readonly eUp: EProcess;
  private readonly eDown: EProcess;

  constructor(config?: Partial<AnytimeEvidenceConfig>) {
    this.config = { ...DEFAULT_ANYTIME_EVIDENCE_CONFIG, ...config };
    this.cs = new EmpiricalBernsteinSequence(this.config.alpha);
    this.eUp = new EProcess(this.config.reference, 'at-most');
    this.eDown = new EProcess(this.config.reference, 'at-least');
  }

  /** 参考水位线 */
  get reference(): number {
    return this.config.reference;
  }

  /** 观测一次 x ∈ [0,1]（连续收益或 0/1 布尔） */
  observe(x: number): AnytimeEvidenceView {
    this.cs.observe(x);
    const eAbove = this.eUp.observe(x);
    const eBelow = this.eDown.observe(x);
    return this.view();
  }

  /** 当前读取视图（纯读取，不改变状态） */
  view(): AnytimeEvidenceView {
    const threshold = 1 / this.config.alpha;
    const eAbove = this.eUp.eValue;
    const eBelow = this.eDown.eValue;
    const verdict: AnytimeVerdict =
      eAbove >= threshold ? 'above-reference' : eBelow >= threshold ? 'below-reference' : 'undecided';
    return {
      n: this.cs.count,
      cs: this.cs.bounds(),
      eAbove: round(eAbove),
      eBelow: round(eBelow),
      verdict,
      anytimeP: round(Math.min(1, 1 / Math.max(eAbove, eBelow))),
    };
  }
}

// ─────────────────────────── 登记表（并行对象管理） ───────────────────────────

/** 登记表报告 */
export interface AnytimeEvidenceRegistryReport {
  /** 活跃流数量 */
  streams: number;
  /** 各裁决方向的流数量 */
  verdicts: { above: number; below: number; undecided: number };
  /** 累计确证次数（裁决从 undecided 翻转的时刻） */
  totalConfirmations: number;
  /** e-BH 累计淘汰数 */
  totalEliminations: number;
  /** 最强证据（当前活跃流中的最大 e-值） */
  strongestEvidence: number;
  interpretation: string;
}

/**
 * 任意时刻证据登记表
 *
 * 管理一组并行对象（策略基因组 / 模型 / 密钥）的证据流：
 * - observe(id, x)：向对象 id 的流喂证据（流惰性创建）
 * - verdicts()：全部流的当前裁决
 * - eliminate(fdr)：对「确证低于水位线」的对象做 e-BH FDR 控制淘汰
 *
 * 淘汰语义：只淘汰 e-值确证的对象；FDR ≤ fdr 在任意依赖下成立——
 * 并行淘汰的冤案率第一次有了数学上限。
 */
export class AnytimeEvidenceRegistry {
  private readonly config: AnytimeEvidenceConfig;
  private streams = new Map<string, AnytimeEvidenceStream>();
  private confirmedOnce = new Set<string>();
  private totalEliminations = 0;
  private fdrLevel = 0.1;

  constructor(config?: Partial<AnytimeEvidenceConfig>) {
    this.config = { ...DEFAULT_ANYTIME_EVIDENCE_CONFIG, ...config };
  }

  /** 喂证据（流按需创建）；返回该对象当前视图 */
  observe(id: string, x: number): AnytimeEvidenceView {
    let stream = this.streams.get(id);
    if (!stream) {
      stream = new AnytimeEvidenceStream(this.config);
      this.streams.set(id, stream);
    }
    const view = stream.observe(x);
    if (view.verdict !== 'undecided') this.confirmedOnce.add(id);
    return view;
  }

  /** 对象当前视图（未登记返回 undefined） */
  viewOf(id: string): AnytimeEvidenceView | undefined {
    return this.streams.get(id)?.view();
  }

  /** 释放对象（淘汰/注销后清理流） */
  forget(id: string): void {
    this.streams.delete(id);
    this.confirmedOnce.delete(id);
  }

  /**
   * e-BH FDR 控制淘汰：返回被确证低于水位线（且通过多重校正）的对象。
   *
   * 只对 e↓ ≥ 1/α 的候选进入 e-BH；淘汰即 forget（调用方负责从其
   * 业务结构中移除对象）。零候选 → 零淘汰（诚实的不确定）。
   */
  eliminate(fdr = 0.1): string[] {
    this.fdrLevel = fdr;
    const threshold = 1 / this.config.alpha;
    const candidates: EBHEntry[] = [];
    for (const [id, stream] of this.streams) {
      const view = stream.view();
      if (view.eBelow >= threshold) candidates.push({ id, eValue: view.eBelow });
    }
    const rejected = eBenjaminiHochberg(candidates, fdr);
    for (const id of rejected) this.forget(id);
    this.totalEliminations += rejected.length;
    return rejected;
  }

  /** 登记表报告 */
  report(): AnytimeEvidenceRegistryReport {
    let above = 0;
    let below = 0;
    let undecided = 0;
    let strongest = 0;
    for (const stream of this.streams.values()) {
      const v = stream.view();
      if (v.verdict === 'above-reference') above += 1;
      else if (v.verdict === 'below-reference') below += 1;
      else undecided += 1;
      strongest = Math.max(strongest, v.eAbove, v.eBelow);
    }
    const interpretation =
      this.streams.size === 0
        ? '证据登记表为空：流式统计待命（observe 喂入第一条证据）'
        : below > 0
          ? `${below} 个对象被任意时刻有效证据确证低于水位线 ${this.config.reference}（FDR ≤ ${this.fdrLevel} 口径可淘汰）`
          : undecided === this.streams.size
            ? `${this.streams.size} 个流尚无确证（诚实的不确定：e-值未达 ${round(1 / this.config.alpha)}）`
            : `${above} 个对象确证高于水位线，其余待证`;
    return {
      streams: this.streams.size,
      verdicts: { above, below, undecided },
      totalConfirmations: this.confirmedOnce.size,
      totalEliminations: this.totalEliminations,
      strongestEvidence: round(strongest),
      interpretation,
    };
  }
}

// ─────────────────────────── 工具 ───────────────────────────

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** 六位小数圆整（13.0/16.0 内核复用的展示口径） */
export function round(x: number): number {
  return Number(x.toFixed(6));
}
