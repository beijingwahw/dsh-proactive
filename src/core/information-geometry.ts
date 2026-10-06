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
 *
 * R5 进化（第五轮·信息几何世界性进化）：
 * 6. **一维 Gauss 族 Fisher 测地距离（精确闭式，Atkinson–Mitchell 1981）**：
 *      Fisher 度量 ds² = dμ²/σ² + 2dσ²/σ² 在坐标 (u,v) = (μ, √2σ) 下是
 *      2× 双曲上半平面度量——流形是曲率 −½ 的双曲面，测地距离闭式：
 *        d_F = √2·arccosh(1 + (Δμ² + 2Δσ²)/(4σ₁σ₂))
 *      纯 σ 位移退化为 √2·|ln(σ₂/σ₁)|（0.5 缩放的仿射不变度量），
 *      小 Δμ 极限退化为 |Δμ|/σ（Mahalanobis 一阶）——两条已有时轴
 *      都是它的 Totally-geodesic 切片，第一次有了**全流形**的真距离。
 * 7. **d 维 Gauss 族 Fisher 路径长度（仿射不变上界近似）**：
 *      连接路径取 Σ 的仿射不变测地 Σ(t) = Σ₁^{1/2}(Σ₁^{-1/2}Σ₂Σ₁^{-1/2})^t Σ₁^{1/2}
 *      + μ 线性插值，路径的 Fisher 长度
 *        L = ∫₀¹ √(ΔμᵀΣ(t)⁻¹Δμ + ½Σᵢln²λᵢ) dt
 *      （λᵢ = Σ₁⁻¹Σ₂ 广义特征值；被积函数在广义特征基下逐项闭式）
 *      由 32 点 Gauss–Legendre 求积。L 是**真测地距离的上界**（路径
 *      长度 ≥ 测地长度），且在两个 Totally-geodesic 切片（Σ 固定 →
 *      Mahalanobis 精确；μ 固定 → ½AIRM 精确）上**退化为精确值**；
 *      仿射重参数化 y = Aθ 下严格不变（两段都是），对称（AIRM 测地
 *      可逆）。1 维可与闭式 d_F 对照：L ≥ d_F（上界性质可验）。
 * 8. **自然梯度（Amari）**：grad_F L = F⁻¹∇L = Σ∇L（Cholesky/Jacobi 求解）。
 *      定义性质 ⟨grad, v⟩_F = ∇Lᵀv（∀v）；仿射等变性
 *      F(AΣAᵀ)⁻¹·A^{-ᵀ}∇L = A·F(Σ)⁻¹∇L（自然梯度步在重参数化下协变）；
 *      在单位 Fisher 范数方向中取最速上升方向（黎曼意义的最速下降）。
 * 9. **确定性诊断（数值稳健性）**：Jacobi 旋转特征解（纯数学、确定性）
 *      替换幂迭代 + 随机 Rayleigh 的最小特征值估计——conditionNumber
 *      由随机近似变为精确计算；缺省 rng 由 Math.random 改为固定种子
 *      确定性序列（宿主显式传 rng 的行为不变；未传时全程可复现）。
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
  /** 随机数源（缺省确定性序列：固定种子 mulberry32——宪章禁 Math.random，未传 rng 时全程可复现） */
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

// ───────────────── R5：Jacobi 特征解 / Fisher 测地距离 / 自然梯度 ─────────────────

/** 对称矩阵特征分解结果（values 升序；vectors[i] = 第 i 个特征向量） */
export interface SymmetricEigenResult {
  /** 特征值（升序） */
  values: number[];
  /** 特征向量（列向量口径：vectors[k][i] = 第 k 个特征向量的第 i 分量） */
  vectors: number[][];
  /** 离差收敛判据：末轮非对角 Frobenius 范数平方 */
  offDiagonal: number;
}

/**
 * 循环 Jacobi 旋转特征解（对称矩阵，R5）：纯数学、确定性、精确到
 * 机器精度——替换幂迭代 + 随机 Rayleigh 的最小特征值估计（后者
 * 不确定且只是下界近似）。O(d³) 每轮扫描，d ≤ 32 的诊断规模下瞬时。
 * （命名 symmetricEigen：与 canonical-correlation 内核的 jacobiEigen
 * 在 index 汇出层消歧。）
 */
export function symmetricEigen(matrix: readonly (readonly number[])[], options?: { maxSweeps?: number; tolerance?: number }): SymmetricEigenResult {
  const d = matrix.length;
  const maxSweeps = options?.maxSweeps ?? 100;
  const tol = options?.tolerance ?? 1e-26;
  if (d === 0) return { values: [], vectors: [], offDiagonal: 0 };
  const a = matrix.map((row) => [...row]);
  const V: number[][] = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => (i === j ? 1 : 0)));
  let off = Infinity;
  for (let sweep = 0; sweep < maxSweeps && off > tol; sweep += 1) {
    off = 0;
    for (let p = 0; p < d - 1; p += 1) {
      for (let q = p + 1; q < d; q += 1) {
        const apq = a[p]![q]!;
        off += apq * apq;
        if (Math.abs(apq) <= 1e-30) continue;
        // Jacobi 旋转角（数值稳定公式）
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        // A ← JᵀAJ（p/q 行列同时更新）
        for (let k = 0; k < d; k += 1) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < d; k += 1) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < d; k += 1) {
          const vkp = V[k]![p]!;
          const vkq = V[k]![q]!;
          V[k]![p] = c * vkp - s * vkq;
          V[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const indexed = a.map((row, i) => ({ value: row[i]!, index: i }));
  indexed.sort((x, y) => x.value - y.value);
  return {
    values: indexed.map((e) => e.value),
    vectors: indexed.map((e) => V.map((row) => row[e.index]!)),
    offDiagonal: off,
  };
}

/**
 * 一维 Gauss 族 Fisher 测地距离（精确闭式，Atkinson–Mitchell 1981）：
 *
 *   d_F = √2 · arccosh( 1 + (Δμ² + 2Δσ²) / (4σ₁σ₂) )
 *
 * 推导：Fisher 度量 ds² = dμ²/σ² + 2dσ²/σ² 在 (u,v) = (μ,√2σ) 下 =
 * 2·(du²+dv²)/v²（曲率 −½ 双曲上半平面）——双曲距离闭式直接给出。
 * 切片精确退化：σ 固定（沿子流形路径 |Δμ|/σ 是测地的上界）、
 * μ 固定 → √2·|ln(σ₂/σ₁)| 精确；小 Δμ 极限 → |Δμ|/σ（Mahalanobis 一阶）。
 */
export function fisherDistance1D(mu1: number, sigma1: number, mu2: number, sigma2: number): number {
  if (!Number.isFinite(mu1) || !Number.isFinite(mu2)) throw new Error('fisherDistance1D: mu 必须是有限数');
  if (!(sigma1 > 0) || !Number.isFinite(sigma1) || !(sigma2 > 0) || !Number.isFinite(sigma2)) {
    throw new Error('fisherDistance1D: sigma 必须为正有限数');
  }
  const dMu = mu1 - mu2;
  const dSigma = sigma1 - sigma2;
  const arg = 1 + (dMu * dMu + 2 * dSigma * dSigma) / (4 * sigma1 * sigma2);
  if (arg <= 1) return 0; // 同一点（浮点上界保护；arg < 1 只能来自舍入）
  return Math.SQRT2 * Math.acosh(arg);
}

/** d 维 Gauss 族 Fisher 路径长度报告 */
export interface GaussianFisherDistanceReport {
  /** 路径长度 L = ∫₀¹ √(ΔμᵀΣ(t)⁻¹Δμ + ½Σln²λ) dt（真测地距离的上界） */
  pathLength: number;
  /** 协方差分量 √(½Σᵢln²λᵢ)（0.5 缩放 AIRM——μ 固定时精确即测地距离） */
  covarianceDistance: number;
  /** 均值分量在路径中点的 Mahalanobis 值 √(ΔμᵀΣ(½)⁻¹Δμ)（诊断口径） */
  midpointMahalanobis: number;
  /** Σ₁⁻¹Σ₂ 的广义特征值 λᵢ（对数升序） */
  eigenvalueRatios: number[];
  /** 求积点数（Gauss–Legendre） */
  quadraturePoints: number;
}

/**
 * d 维 Gauss 族 Fisher 路径长度（R5）：仿射不变、对称、真测地距离的
 * 上界；在两个 Totally-geodesic 切片上精确（Σ 固定 → Mahalanobis；
 * μ 固定 → ½AIRM）。连接路径 Σ(t) = Σ₁^{1/2}G^t Σ₁^{1/2}
 * （G = Σ₁^{-1/2}Σ₂Σ₁^{-1/2}）+ μ 线性插值；被积函数
 *   a(t) + c = Σᵢ wᵢλᵢ^{-t} + ½Σᵢln²λᵢ（wᵢ = (qᵢᵀΣ₁^{-1/2}Δμ)²）
 * 在 G 的特征基下逐项闭式，32 点 Gauss–Legendre 求积（节点用 Legendre
 * 多项式 Newton 迭代现场计算——纯数学、确定性、无查表）。
 */
export function gaussianFisherPathLength(
  mean1: readonly number[],
  cov1: readonly (readonly number[])[],
  mean2: readonly number[],
  cov2: readonly (readonly number[])[],
): GaussianFisherDistanceReport {
  const d = mean1.length;
  if (d === 0 || mean2.length !== d || cov1.length !== d || cov2.length !== d) {
    throw new Error('gaussianFisherPathLength: 维度不一致');
  }
  if (d > 32) throw new Error('gaussianFisherPathLength: 维度上限 32');
  // 对称化 + 维度校验
  const S1 = symmetrize(cov1);
  const S2 = symmetrize(cov2);
  // Σ₁ 特征分解 → Σ₁^{±1/2} = Q Λ^{±1/2} Qᵀ
  const eig1 = symmetricEigen(S1);
  const minEig = eig1.values[0]!;
  if (!(minEig > 1e-12)) throw new Error('gaussianFisherPathLength: cov1 必须正定');
  const halfPow = eig1.values.map((v) => Math.sqrt(Math.max(v, 1e-300)));
  const negHalfPow = eig1.values.map((v) => 1 / Math.sqrt(Math.max(v, 1e-300)));
  const S1half = composeEigen(eig1.vectors, halfPow);
  const S1negHalf = composeEigen(eig1.vectors, negHalfPow);
  // G = Σ₁^{-1/2} Σ₂ Σ₁^{-1/2}（对称 PD）
  const T = matMulMat(S1negHalf, S2);
  const G = symmetrize(matMulMat(T, S1negHalf));
  const eigG = symmetricEigen(G);
  if (!(eigG.values[0]! > 0)) throw new Error('gaussianFisherPathLength: cov2 必须正定');
  // wᵢ = (qᵢᵀ Σ₁^{-1/2} Δμ)²
  const dMu = mean1.map((v, i) => v - mean2[i]!);
  const u = matVec(S1negHalf, dMu);
  const w: number[] = [];
  for (let k = 0; k < d; k += 1) {
    let acc = 0;
    for (let i = 0; i < d; i += 1) acc += eigG.vectors[k]![i]! * u[i]!;
    w.push(acc * acc);
  }
  const lambdas = eigG.values;
  const c = lambdas.reduce((s, l) => s + Math.log(l) * Math.log(l), 0) / 2; // ½Σln²λ
  const integrand = (t: number): number => {
    let a = 0;
    for (let k = 0; k < d; k += 1) a += w[k]! * Math.pow(lambdas[k]!, -t);
    return Math.sqrt(a + c);
  };
  const gl = gaussLegendre(32);
  let integral = 0;
  for (let i = 0; i < gl.nodes.length; i += 1) integral += gl.weights[i]! * integrand(0.5 * (gl.nodes[i]! + 1));
  integral *= 0.5;
  // 中点 Mahalanobis（诊断）：a(½) = Σ wᵢλᵢ^{-1/2}
  let aMid = 0;
  for (let k = 0; k < d; k += 1) aMid += w[k]! / Math.sqrt(lambdas[k]!);
  // 数值不圆整（数学量原值返回—— Totally-geodesic 切片的 1e-9 精确对照需要全精度）
  return {
    pathLength: integral,
    covarianceDistance: Math.sqrt(c),
    midpointMahalanobis: Math.sqrt(aMid),
    eigenvalueRatios: lambdas.map((l) => round(l)),
    quadraturePoints: gl.nodes.length,
  };
}

/**
 * 自然梯度（Amari 1998）：grad = F⁻¹∇L = Σ·∇L（Fisher 度量 F = Σ⁻¹，
 * 把欧氏梯度「抬起」为黎曼梯度——满足 ⟨grad, v⟩_F = ∇Lᵀv 对一切 v，
 * 即 Σ⁻¹·grad = ∇L）。求解用 Jacobi 特征分解（特征值钳制 ≥ 1e-12
 * 保证半正定也良态，x = Q diag(max(λ,ε)) Qᵀ g）；仿射等变
 * F(AΣAᵀ)⁻¹·A⁻ᵀ∇L = A·F(Σ)⁻¹∇L（自然梯度步 y = Aθ 协变——坐标系
 * 绑架解除）；单位 Fisher 球上的最速上升方向（Cauchy–Schwarz 取等：
 * max gᵀv = √(∇LᵀΣ∇L)，取等方向 ∝ Σg）。
 */
export function naturalGradient(covariance: readonly (readonly number[])[], gradient: readonly number[]): number[] {
  const d = gradient.length;
  if (d === 0 || covariance.length !== d) throw new Error('naturalGradient: 维度不一致');
  for (let i = 0; i < d; i += 1) {
    if (covariance[i]!.length !== d) throw new Error('naturalGradient: 协方差矩阵必须是方阵');
    if (!Number.isFinite(gradient[i]!)) throw new Error('naturalGradient: 梯度必须为有限数');
  }
  const eig = symmetricEigen(symmetrize(covariance));
  // x = Σ·g = Q diag(max(λ,ε)) Qᵀ g（解 Σx = g——黎曼梯度方向）
  const qtg = eig.vectors.map((v) => {
    let acc = 0;
    for (let i = 0; i < d; i += 1) acc += v[i]! * gradient[i]!;
    return acc;
  });
  const scaled = qtg.map((v, k) => v * Math.max(1e-12, eig.values[k]!));
  return Array.from({ length: d }, (_, i) => {
    let acc = 0;
    for (let k = 0; k < d; k += 1) acc += eig.vectors[k]![i]! * scaled[k]!;
    return acc;
  });
}

/** 对称化 (A+Aᵀ)/2 */
function symmetrize(matrix: readonly (readonly number[])[]): number[][] {
  const d = matrix.length;
  return Array.from({ length: d }, (_, i) =>
    Array.from({ length: d }, (_, j) => {
      const aij = matrix[i]![j] ?? 0;
      const aji = matrix[j]![i] ?? 0;
      return (aij + aji) / 2;
    }),
  );
}

/** 矩阵乘（方阵） */
function matMulMat(x: readonly (readonly number[])[], y: readonly (readonly number[])[]): number[][] {
  const d = x.length;
  return Array.from({ length: d }, (_, i) =>
    Array.from({ length: d }, (_, j) => {
      let acc = 0;
      for (let k = 0; k < d; k += 1) acc += x[i]![k]! * y[k]![j]!;
      return acc;
    }),
  );
}

/** 矩阵 × 向量 */
function matVec(matrix: readonly (readonly number[])[], v: readonly number[]): number[] {
  return matrix.map((row) => row.reduce((s, a, j) => s + a * v[j]!, 0));
}

/** 由特征向量（列）与特征值构造 Q diag(f(λ)) Qᵀ */
function composeEigen(vectors: readonly (readonly number[])[], values: readonly number[]): number[][] {
  const d = values.length;
  return Array.from({ length: d }, (_, i) =>
    Array.from({ length: d }, (_, j) => {
      let acc = 0;
      for (let k = 0; k < d; k += 1) acc += vectors[k]![i]! * values[k]! * vectors[k]![j]!;
      return acc;
    }),
  );
}

/** Gauss–Legendre 求积节点/权重（n 点，[−1,1]；Newton 迭代解 Legendre 根——纯数学无查表） */
function gaussLegendre(n: number): { nodes: number[]; weights: number[] } {
  const nodes: number[] = [];
  const weights: number[] = [];
  for (let i = 1; i <= Math.floor((n + 1) / 2); i += 1) {
    let x = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5));
    let dp = 0;
    for (let iter = 0; iter < 100; iter += 1) {
      // P_n(x) 与 P_n'(x) 的三项递推
      let p0 = 1;
      let p1 = x;
      for (let k = 2; k <= n; k += 1) {
        const p2 = ((2 * k - 1) * x * p1 - (k - 1) * p0) / k;
        p0 = p1;
        p1 = p2;
      }
      dp = (n * (x * p1 - p0)) / (x * x - 1);
      const dx = p1 / dp;
      x -= dx;
      if (Math.abs(dx) < 1e-15) break;
    }
    const w = 2 / ((1 - x * x) * dp * dp);
    nodes.push(x, -x);
    weights.push(w, w);
  }
  return { nodes, weights };
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
    // 缺省确定性序列（固定种子 mulberry32——同配置同变异序列；宿主显式
    // 传 rng 时行为与既有口径逐位一致）
    this.rng = this.config.rng ?? deterministicRng();
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

/**
 * 最小特征值（R5：Jacobi 旋转精确解——替换随机 Rayleigh 商下界近似）。
 * 旧行为：16 个随机向量的 Rayleigh 商取 min（不确定 + 偏大近似）；
 * 新行为：特征分解最小值（确定 + 精确到机器精度）。
 */
function smallestEigenvalue(matrix: readonly (readonly number[])[]): number {
  const eig = symmetricEigen(matrix);
  return eig.values[0] ?? 0;
}

/** 确定性伪随机序列（mulberry32 固定种子 0x5eed_1337——缺省 rng 用） */
function deterministicRng(): () => number {
  let s = 0x5eed1337 >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function multiplyMatrixVector(matrix: readonly (readonly number[])[], v: readonly number[]): number[] {
  return matrix.map((row) => row.reduce((s, a, j) => s + a * v[j]!, 0));
}

/** 六位小数圆整（项目统一展示口径） */
function round(x: number): number {
  return Number(x.toFixed(6));
}
