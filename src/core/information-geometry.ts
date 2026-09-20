/**
 * information-geometry.ts — 信息几何内核（项目 18.0「进化在流形上行走」质变基座）
 *
 * 升级前的根本局限（坐标空间变异的几何盲区）：
 * - 高斯变异在**原始坐标轴**上独立加噪——步长正比于各基因的取值
 *   范围，本质是把「坐标怎么标」当成了「空间怎么弯」：把某个基因
 *   的单位从秒改成毫秒，同样的变异在物理上走 1000 倍远——进化的
 *   行为被坐标系绑架（参数化依赖）；
 * - 基因间的**相关结构**完全不可见：lowConfidenceThreshold 与
 *   costDeferRatio 在历史上可能总是同向移动（一个隐性组合在起作用），
 *   独立加噪把每次变异都强行拆散——有利的基因组合永远无法被
 *   一次变异完整传递；
 * - 步长没有信息单位：变异走多远用「参数距离」度量，而参数距离
 *   在重参数化下不守恒——「这次变异改变策略分布多少信息」才是
 *   不变量，坐标系无权过问。
 *
 * 本内核引入信息几何（Amari 自然梯度 / Fisher 信息度量；
 * Kakade 2001 自然梯度 RL；Schulman 2015 TRPO 信任域）：
 *
 * 1. **Fisher 信息度量**：搜索分布 N(θ, Σ) 的均值参数上，
 *      F = Σ⁻¹
 *    概率分布族构成黎曼流形，Fisher 度量给出其上真实的「距离」——
 *    两个策略参数点的距离不是欧氏范数，而是
 *      ‖δ‖_F = √(δᵀ Σ⁻¹ δ)（Mahalanobis 范数）
 *
 * 2. **不变性（本内核的数学心脏）**：种群协方差在仿射重参数化
 *    y = Ax 下协变（Σ_y = AΣAᵀ），故 Mahalanobis 距离严格不变：
 *      δ_yᵀ Σ_y⁻¹ δ_y = δ_xᵀ Σ_x⁻¹ δ_x
 *    单位换算、量纲缩放、坐标旋转——几何不变量纹丝不动。
 *    变异第一次拥有了与坐标系无关的「真实步长」。
 *
 * 3. **自然变异（协方差白化采样）**：ε ~ N(0, I)，子代 =
 *      parent + σ · L ε，L = Cholesky(Σ̂)
 *    变异方向沿种群历史方差的主轴展开——显性组合方向自动获得
 *    更大步幅（有利的基因组合被完整传递），垂直方向自动收紧；
 *    等价于在 Fisher 流形上沿测地方向迈步（自然梯度的采样版）。
 *
 * 4. **KL 信任域（步长以 nat 计价）**：同协方差高斯的
 *      KL(N(θ) ‖ N(θ+δ)) = ½ δᵀ Σ⁻¹ δ
 *    步长用信息单位（nat）度量：Mahalanobis 距离超界即整体缩放
 *    回信任域——单次进化对策略分布的最大信息改动被数学封顶，
 *    「大步翻车」与「小步原地」都不再取决于坐标系标定。
 *
 * 5. **协方差收缩（Ledoit–Wolf 式）**：小种群（个位数）的样本
 *    协方差病态；Σ̂ = (1−λ)S + λ·(tr S / d)·I 以种群规模定 λ，
 *    良态保证 Cholesky 可分解；条件数 / 有效维数（参与比）随报告
 *    输出——搜索几何本身成为可观测对象。
 *
 * 与 8.0 的关系：8.0 元推理把「思考」按 nat 计价，本内核把「进化」
 * 按 nat 计价——认知经济学的两种支出（推理与变异）统一信息单位；
 * 与 14.0 的关系：14.0 在**行为空间**（结果维度）保流派不灭，本内核
 * 在**参数流形**（策略维度）让搜索沿几何走——结果空间的多样性与
 * 参数空间的几何是两层互补的正交保护；与 16.0 的关系：Shapley 的
 * 协同检测找出 1+1>2 的玩家对，本内核的协方差主轴找出总是同向
 * 移动的基因组合——归因在智能体层，几何在基因层。
 */

// ─────────────────────────── 配置与类型 ───────────────────────────

/** 信息几何配置 */
export interface InformationGeometryConfig {
  /** KL 信任域半径 δ_max（Mahalanobis 上限；缺省 1.2 ≈ 单步 ≤ 0.72 nat） */
  klBudget: number;
  /** 基础变异尺度 σ（信任域内的高斯步幅；缺省 0.5） */
  stepScale: number;
  /** 收缩强度覆盖（缺省按种群规模自适应：λ = 2/(n+2)，n = 种群数） */
  shrinkageIntensity?: number;
  /** 最大维度（超出拒绝估计；缺省 32） */
  maxDimension: number;
  /** 随机数源（缺省 Math.random） */
  rng?: () => number;
}

export const DEFAULT_INFORMATION_GEOMETRY_CONFIG: InformationGeometryConfig = {
  klBudget: 1.2,
  stepScale: 0.5,
  maxDimension: 32,
};

/** 自然变异结果 */
export interface NaturalMutationResult {
  /** 变异后的点（归一化空间） */
  child: number[];
  /** Mahalanobis 步长 ‖δ‖_F（信任域口径；坐标不变量） */
  mahalanobis: number;
  /** KL 步长（nat）= mahalanobis² / 2 */
  klStep: number;
  /** 是否触发信任域缩放（步长超界被整体收缩） */
  trustRegionClipped: boolean;
}

/** 几何诊断报告 */
export interface InformationGeometryReport {
  /** 估计样本数（种群规模口径） */
  samples: number;
  /** 维度 */
  dimension: number;
  /** 收缩强度 λ（0 = 纯样本协方差，1 = 各向同性） */
  shrinkage: number;
  /** 条件数 κ(Σ̂)（大 = 主轴悬殊；∞ 防护 = 奇异） */
  conditionNumber: number;
  /** 有效维数（参与比 (tr Σ)²/tr Σ² ∈ [1, d]；小 = 搜索低维流形） */
  effectiveDimension: number;
  /** 平均步长（最近变异的 Mahalanobis 均值；无样本 = 0） */
  meanStep: number;
  /** 信任域触发率（最近变异中缩放占比） */
  trustRegionRate: number;
  interpretation: string;
}

// ─────────────────────────── 纯函数几何工具 ───────────────────────────

/**
 * 收缩协方差估计：Σ̂ = (1−λ)·S + λ·(tr S / d)·I。
 *
 * λ 缺省 = 2/(n+2)（贝叶斯收缩的经典口径：n 个样本时各向同性先验
 * 占 2/(n+2)——种群越小收缩越强，Cholesky 良态有保证）。
 */
export function shrinkageCovariance(points: readonly (readonly number[])[], intensity?: number): number[][] {
  const n = points.length;
  const d = points[0]?.length ?? 0;
  if (n === 0 || d === 0) return [];
  const lambda = intensity ?? 2 / (n + 2);
  // 样本均值
  const mean = new Float64Array(d);
  for (const p of points) for (let i = 0; i < d; i += 1) mean[i] += p[i]! / n;
  // 样本协方差（无偏口径）
  const cov: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (const p of points) {
    for (let i = 0; i < d; i += 1) {
      for (let j = 0; j < d; j += 1) cov[i]![j] += ((p[i]! - mean[i]!) * (p[j]! - mean[j]!)) / Math.max(1, n - 1);
    }
  }
  // 各向同性收缩目标 (tr S / d)·I
  let trace = 0;
  for (let i = 0; i < d; i += 1) trace += cov[i]![i]!;
  const isotropic = trace / d;
  for (let i = 0; i < d; i += 1) {
    for (let j = 0; j < d; j += 1) {
      cov[i]![j] = (1 - lambda) * cov[i]![j]! + (i === j ? lambda * isotropic : 0);
    }
  }
  return cov;
}

/** Cholesky 分解（下三角；非正定时加抖动重试，仍失败返回 undefined） */
export function cholesky(matrix: readonly (readonly number[])[]): number[][] | undefined {
  const d = matrix.length;
  const a = matrix.map((row) => [...row]);
  for (const jitter of [0, 1e-10, 1e-8, 1e-6]) {
    const L: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    let ok = true;
    for (let i = 0; i < d && ok; i += 1) {
      for (let j = 0; j <= i && ok; j += 1) {
        let sum = a[i]![j]! + (i === j ? jitter : 0);
        for (let k = 0; k < j; k += 1) sum -= L[i]![k]! * L[j]![k]!;
        if (i === j) {
          if (sum <= 0) {
            ok = false;
            break;
          }
          L[i]![j] = Math.sqrt(sum);
        } else {
          L[i]![j] = sum / L[j]![j]!;
        }
      }
    }
    if (ok) return L;
  }
  return undefined;
}

/** 条件数 κ = λ_max / λ_min（幂迭代 + 逆幂迭代近似；奇异返回 Infinity） */
export function conditionNumber(matrix: readonly (readonly number[])[]): number {
  const d = matrix.length;
  if (d === 0) return 1;
  const max = largestEigenvalue(matrix);
  const min = smallestEigenvalue(matrix);
  if (min <= 1e-15) return Infinity;
  return max / min;
}

/** 参与比（有效维数）：(tr Σ)² / tr(Σ²) ∈ [1, d] */
export function participationRatio(matrix: readonly (readonly number[])[]): number {
  const d = matrix.length;
  if (d === 0) return 0;
  let tr = 0;
  let trSq = 0;
  for (let i = 0; i < d; i += 1) {
    for (let j = 0; j < d; j += 1) {
      const v = matrix[i]![j]!;
      if (i === j) tr += v;
      trSq += v * v;
    }
  }
  if (trSq <= 1e-15) return d;
  return Math.max(1, Math.min(d, (tr * tr) / trSq));
}

// ─────────────────────────── 引擎 ───────────────────────────

/**
 * Fisher 几何引擎：估计种群几何 + 自然变异 + 诊断
 *
 * 用法：
 *   const geo = new FisherGeometryEngine({ klBudget: 1.2 });
 *   geo.estimate(populationPoints);          // 归一化参数点（[0,1]^d）
 *   const { child } = geo.naturalMutate(parentPoint);  // 沿流形测地方向变异
 *   geo.report();                            // 条件数 / 有效维数 / 步长审计
 *
 * 所有点在**归一化空间**（各维 [0,1]）进出——坐标不变量保证这些
 * 数值与外部标定无关。
 */
export class FisherGeometryEngine {
  private readonly config: InformationGeometryConfig;
  private readonly rng: () => number;
  private dimension = 0;
  private samples = 0;
  private shrinkageUsed = 0;
  private covariance: number[][] = [];
  private choleskyFactor?: number[][];
  /** 最近变异步长审计（信任域触发率 / 均值口径） */
  private recentSteps: Array<{ mahalanobis: number; clipped: boolean }> = [];

  constructor(config?: Partial<InformationGeometryConfig>) {
    this.config = { ...DEFAULT_INFORMATION_GEOMETRY_CONFIG, ...config };
    this.rng = this.config.rng ?? Math.random;
  }

  /**
   * 估计种群几何（归一化点集 → 收缩协方差 + Cholesky）。
   *
   * 点集通常为当前种群全部个体（含精英）；样本 ≤ 1 时几何退化为
   * 各向同性（自然变异回退坐标无关的等幅噪声）。
   */
  estimate(points: readonly (readonly number[])[]): boolean {
    const n = points.length;
    const d = points[0]?.length ?? 0;
    if (n === 0 || d === 0 || d > this.config.maxDimension) return false;
    // 方差退化保护：全同种群 → 各向同性
    let diverse = false;
    for (let i = 1; i < n && !diverse; i += 1) {
      for (let j = 0; j < d; j += 1) {
        if (Math.abs(points[i]![j]! - points[0]![j]!) > 1e-9) {
          diverse = true;
          break;
        }
      }
    }
    if (!diverse) {
      this.covariance = identity(d, Math.max(1e-4, 1 / (d * d)));
      this.choleskyFactor = cholesky(this.covariance);
    } else {
      this.shrinkageUsed = this.config.shrinkageIntensity ?? 2 / (n + 2);
      this.covariance = shrinkageCovariance(points, this.shrinkageUsed);
      this.choleskyFactor = cholesky(this.covariance);
      if (!this.choleskyFactor) {
        // 病态兜底：强收缩到各向同性
        this.shrinkageUsed = 1;
        this.covariance = identity(d, Math.max(1e-4, averageDiagonal(this.covariance)));
        this.choleskyFactor = cholesky(this.covariance);
      }
    }
    this.dimension = d;
    this.samples = n;
    return this.choleskyFactor !== undefined;
  }

  /**
   * 自然变异：ε ~ N(0,I) 沿 Cholesky 主轴展开，KL 信任域封顶。
   *
   * 未估计几何（estimate 未调用 / 失败）时回退各向同性小步——
   * 调用方无需关心几何是否可用（优雅降级，零漂移）。
   */
  naturalMutate(parent: readonly number[], scale?: number): NaturalMutationResult {
    const d = parent.length;
    if (d === 0) return { child: [], mahalanobis: 0, klStep: 0, trustRegionClipped: false };
    const sigma = (scale ?? this.config.stepScale) / Math.max(1e-12, Math.sqrt(Math.max(1, this.dimension)));
    // ε ~ N(0, I)：Box–Muller
    const epsilon = new Array<number>(d);
    for (let i = 0; i < d; i += 1) epsilon[i] = standardNormal(this.rng);
    // δ = σ·Lε（L 缺失时各向同性回退）
    const delta = new Array<number>(d);
    if (this.choleskyFactor && this.dimension === d) {
      const L = this.choleskyFactor;
      for (let i = 0; i < d; i += 1) {
        let acc = 0;
        for (let k = 0; k <= i; k += 1) acc += L[i]![k]! * epsilon[k]!;
        delta[i] = sigma * acc;
      }
    } else {
      for (let i = 0; i < d; i += 1) delta[i] = sigma * epsilon[i]!;
    }
    // KL 信任域：‖δ‖_F = √(δᵀ Σ⁻¹ δ)。Σ = LLᵀ ⇒ Σ⁻¹ = L⁻ᵀL⁻¹ ⇒ ‖δ‖_F = ‖L⁻¹δ‖
    let mahalanobis = d;
    if (this.choleskyFactor && this.dimension === d) {
      // 前代换解 L y = δ → ‖δ‖_F = ‖y‖
      const y = forwardSubstitute(this.choleskyFactor, delta);
      mahalanobis = norm(y);
    } else {
      mahalanobis = norm(delta) / Math.max(1e-12, sigma);
    }
    let clipped = false;
    if (mahalanobis > this.config.klBudget && mahalanobis > 0) {
      const factor = this.config.klBudget / mahalanobis;
      for (let i = 0; i < d; i += 1) delta[i] *= factor;
      mahalanobis = this.config.klBudget;
      clipped = true;
    }
    const child = parent.map((v, i) => v + delta[i]!);
    this.recentSteps.push({ mahalanobis, clipped });
    if (this.recentSteps.length > 100) this.recentSteps.shift();
    return { child, mahalanobis: round(mahalanobis), klStep: round((mahalanobis * mahalanobis) / 2), trustRegionClipped: clipped };
  }

  /** 几何诊断报告 */
  report(): InformationGeometryReport {
    const clippedCount = this.recentSteps.filter((s) => s.clipped).length;
    const meanStep = this.recentSteps.length > 0 ? this.recentSteps.reduce((s, r) => s + r.mahalanobis, 0) / this.recentSteps.length : 0;
    const kappa = this.covariance.length > 0 ? conditionNumber(this.covariance) : 1;
    const effDim = this.covariance.length > 0 ? participationRatio(this.covariance) : this.dimension;
    return {
      samples: this.samples,
      dimension: this.dimension,
      shrinkage: round(this.shrinkageUsed),
      conditionNumber: kappa === Infinity ? Infinity : round(kappa),
      effectiveDimension: round(effDim),
      meanStep: round(meanStep),
      trustRegionRate: this.recentSteps.length > 0 ? round(clippedCount / this.recentSteps.length) : 0,
      interpretation:
        this.samples === 0
          ? '几何未估计（estimate 喂入种群后生效；当前自然变异为各向同性回退）'
          : `搜索流形 d=${this.dimension}（有效维 ${effDim.toFixed(1)}），条件数 κ=${kappa === Infinity ? '∞' : kappa.toFixed(1)}，平均步长 ${meanStep.toFixed(2)}（信任域 ${this.config.klBudget}，触发率 ${(this.recentSteps.length > 0 ? (clippedCount / this.recentSteps.length) * 100 : 0).toFixed(0)}%）——步长以 nat 计价，坐标不变`,
    };
  }
}

// ─────────────────────────── 内部工具 ───────────────────────────

/** 单位矩阵 × 标量 */
function identity(d: number, scale: number): number[][] {
  return Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => (i === j ? scale : 0)));
}

/** 对角均值 */
function averageDiagonal(matrix: readonly (readonly number[])[]): number {
  if (matrix.length === 0) return 1e-4;
  let acc = 0;
  for (let i = 0; i < matrix.length; i += 1) acc += matrix[i]![i]!;
  return Math.max(1e-4, acc / matrix.length);
}

/** Box–Muller 标准正态采样 */
function standardNormal(rng: () => number): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** 欧氏范数 */
function norm(xs: readonly number[]): number {
  return Math.sqrt(xs.reduce((s, x) => s + x * x, 0));
}

/** 前代换：解 L y = b（L 下三角） */
function forwardSubstitute(L: readonly (readonly number[])[], b: readonly number[]): number[] {
  const d = b.length;
  const y = new Array<number>(d).fill(0);
  for (let i = 0; i < d; i += 1) {
    let acc = b[i]!;
    for (let k = 0; k < i; k += 1) acc -= L[i]![k]! * y[k]!;
    y[i] = acc / L[i]![i]!;
  }
  return y;
}

/** 幂迭代最大特征值 */
function largestEigenvalue(matrix: readonly (readonly number[])[]): number {
  const d = matrix.length;
  let v = new Array<number>(d).fill(1 / Math.sqrt(Math.max(1, d)));
  let eigenvalue = 0;
  for (let iter = 0; iter < 100; iter += 1) {
    const Av = multiplyMatrixVector(matrix, v);
    const next = norm(Av);
    if (next < 1e-15) return 0;
    eigenvalue = next;
    v = Av.map((x) => x / next);
  }
  return eigenvalue;
}

/** 幂迭代最小特征值（移位反幂：A − σI 近似逆用 CG 太重，直接用移位幂迭代兜底） */
function smallestEigenvalue(matrix: readonly (readonly number[])[]): number {
  const d = matrix.length;
  // 对称 PSD：λ_min ≥ 0。Rayleigh 商下界扫描：对随机向量取 min(Rayleigh) 作近似下界
  let best = Infinity;
  for (let trial = 0; trial < 16; trial += 1) {
    const v = new Array<number>(d);
    for (let i = 0; i < d; i += 1) v[i] = Math.random() - 0.5;
    const nv = norm(v);
    if (nv < 1e-12) continue;
    const unit = v.map((x) => x / nv);
    const Av = multiplyMatrixVector(matrix, unit);
    const rayleigh = unit.reduce((s, x, i) => s + x * Av[i]!, 0);
    best = Math.min(best, rayleigh);
  }
  return best === Infinity ? 0 : best;
}

function multiplyMatrixVector(matrix: readonly (readonly number[])[], v: readonly number[]): number[] {
  return matrix.map((row) => row.reduce((s, a, j) => s + a * v[j]!, 0));
}

/** 六位小数圆整（项目统一展示口径） */
function round(x: number): number {
  return Number(x.toFixed(6));
}
