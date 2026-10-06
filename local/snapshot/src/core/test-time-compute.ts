/**
 * 52.0 测试时计算内核 —— 推理期算力的最优配置（compute-optimal inference scaling）
 *
 * 动机: 「让模型多想一会儿再答」从来不是免费的。测试时算力（n 路采样投票、
 * 最佳-of-n、顺序精炼）在工程上只是一组旋钮，旋到多少从未被计算过：
 *   - 投票投几路？拍脑袋定 5——没人算过第 5 路对多数票正确率的边际贡献；
 *   - 预算该给投票还是给精炼？两类策略的边际质量增益从未被放在同一把
 *     尺子下比较；
 *   - 什么时候停？深度上限是配置的恩赐，不是「再算已不值」的证据。
 *
 * 数学（三件套，全部闭式或可独立复算）:
 *
 * (a) 自一致性投票（Condorcet 口径 + 相关性诚实校正）:
 *   独立采样: 单样本正确率 p、奇数 n 路多数票正确率
 *     M(p,n) = Σ_{i>(n/2)} C(n,i)·pⁱ·(1−p)ⁿ⁻ⁱ = I_p(k,k)，k=(n+1)/2
 *   （二项尾概率的正则化不完全 Beta 恒等式；本实现用 log-Γ 逐项精确求和）。
 *   对称性即诚实判定: p=1/2 时 M≡0.5 ∀n（投票对掷硬币无增益）；
 *   p<1/2 时 M<p 且随 n 递减（多数票放大系统性错误）。
 *   相关校正（de Finetti / β-binomial）: 采样共享潜变量 θ~Beta(α,β)，
 *     α = p(1−ρ)/ρ，β = (1−p)(1−ρ)/ρ，成对相关 Corr(Xᵢ,Xⱼ) = 1/(α+β+1) = ρ，
 *     P(X=i) = C(n,i)·B(i+α, n−i+β)/B(α,β)；
 *   有效样本数 n_eff = n/(1+(n−1)ρ)（均值方差口径——相关让样本「变少」）；
 *   精度天花板 lim_{n→∞} M = P(θ>1/2) = 1 − I_{1/2}(α,β)：相关投票加样本
 *   也到不了 1——天花板被诚实给出，optimalVoteN 据此拒绝不可达目标。
 *   达到目标准确率的最小奇数 n：二分查找（单调性：独立情形是 Condorcet
 *   陪审团定理的经典结论；β-binomial 情形单调性经数值验证锚定，实现
 *   另带邻点回退步兜底）。
 *
 * (b) 质量-算力幂律 + 拉格朗日水填充（compute-optimal 配给）:
 *   单策略质量曲线 Q_i(C) = a_i − b_i·C^{−β_i}（渐近线 a_i；亏耗
 *   a_i − Q = b_i·C^{−β_i} 在 log-log 上线性: ln(a_i−Q) = ln b_i − β_i·ln C，
 *   故可从实测 (算力, 质量) 点回归——powerLawFit）。
 *   边际增益 ∂Q_i/∂C = b_i·β_i·C^{−β_i−1}：C→0⁺ 时 →∞（任何策略的第一份
 *   算力都值得给），C→∞ 时 →0（饱和）。
 *   总预算 B 下 max Σ Q_i(C_i) s.t. Σ C_i = B 的 KKT 条件 = 边际增益全相等:
 *     b_i·β_i·C_i^{−(β_i+1)} = λ  ⟹  C_i = (b_i·β_i/λ)^{1/(β_i+1)}
 *   记 s_i = 1/(β_i+1)、w_i = (b_i·β_i)^{s_i}，则 C_i = w_i·λ^{−s_i}，预算方程
 *     Σ_i w_i·λ^{−s_i} = B，左端对 λ 严格单调减——唯一根（几何中点二分）。
 *   β_i 全相等时的闭式比例解（文档化推导）:
 *     λ^{−s}·Σw = B ⟹ λ = (Σw/B)^{1/s}，C_i = B·w_i/Σ_j w_j
 *     ⟹ C_i/C_j = (b_i·β/(b_j·β))^{1/(β+1)} = (b_i/b_j)^{1/(β+1)}
 *   ——配比只看亏耗 b_i 与指数 β_i；渐近线 a_i 不影响分配（影响总质量）。
 *   最小可行配置 C_i ≥ min_i（如投票至少 1 路）: 被下限钉住的策略边际 ≤ λ、
 *   被上限钉住的边际 ≥ λ（KKT 不等式口径，验证锚点检查方向）。
 *
 * (c) 边际收益早停: 再花一单位算力的质量增益（幂律边际）低于单位算力
 *   价格 → 停。思考的停机不是深度的恩赐，是「再算已不值」的经济学证据。
 *
 * ── R5 进化(第五轮, 2026-10) ──────────────────────────────────────────────
 * A1【数学】自一致性的加权多数（按单样本置信加权）:
 *   每票带权 w_j（模型自评置信/日志概率口径）, 正确侧胜出 = P(2S > M),
 *   S = Σ_j m_j·X_j 为加权正确票数(M = Σ m_j, m_j 为公度整数化权重)。
 *   · 独立情形(ρ=0): 子集和动态规划**精确**分布——Poisson-binomial 的
 *     加权推广, O(n·M) 伪多项式;
 *   · 相关情形(ρ>0, de Finetti β-binomial): 条件于潜变量 θ 的混合
 *     E_θ[θ^a(1−θ)^{n−a}] = B(α+a, β+n−a)/B(α,β) 逐(a, s)闭式——子集
 *     计数 DP(计数 ≤ 2⁴⁰ 在 float64 精确) × Beta 矩的精确求和, 无积分;
 *   · 等价锚点: 权重全 1 时逐位退化为 majorityAccuracy(p, n, ρ)(独立 =
 *     二项尾, 相关 = β-binomial 尾)——加权理论是既有投票理论的真推广;
 *   · Kish 有效样本数 n_eff = (Σw)²/Σw²: 权重集中 ⟹ n_eff ↓ ⟹ p>1/2 时
 *     精度 ↓(信息变少的方差口径, 验证锚点);
 *   · weightedMajorityNormal: 任意实权重的 CLT 近似(精确一二阶矩, 含
 *     相关修正 Var = p(1−p)[ρ(Σw)² + (1−ρ)Σw²])。
 * A2【性能】二项/β-二项上尾的对数域递推: 逐项 log-Γ(每项 3 次 logΓ 求值)
 *   换为首项一次 log-Γ + 逐项对数增量 + 求和时逐项 exp
 *     binom:   ln T_{i+1} = ln T_i + ln(n−i) − ln(i+1) + ln(p/(1−p))
 *     β-binom: ln T_{i+1} = ln T_i + ln(n−i) + ln(i+α) − ln(i+1) − ln(n−i+β−1)
 *   ——每尾从 O(3(n−k)) 次 logΓ 降为 3 次, n=3001 的 M(0.6,3001) 约快数倍
 *   (耗时对照见验证脚本)。
 * A3【数值稳健】对数域是**正确性**要件而非仅精度优化: 尾首项可小至 e^{−5000}
 *   （p 偏一侧 + n 大时）, 线性域乘法递推从下溢的 0 出发永远爬不回众数
 *   （M(0.9, 9999) 类参数因此全尾失真）; 对数域递推 + 求和时逐项 exp 使
 *   微小项诚实贡献 0、众数邻域项完整保留。加权 DP 的平局口径文档化
 *   （tie = P(2S=M) 单列, accuracy = win + tie/2 随机破平）。
 *
 * 验证锚点: ①p=0.6,n=5 手算 0.68256 = 10·0.6³·0.4² + 5·0.6⁴·0.4 + 0.6⁵；
 *   ②p=0.5 时任意 n 与 ρ 都恒 0.5（投票无增益的诚实判定）；
 *   ③水填充 ΣC_i=B 守恒、两策略边际相等（1e-6）、等 β 闭式比例
 *   (b_i/b_j)^{1/(β+1)}；④单策略退化=全押；⑤早停预算内不触发、超额触发；
 *   ⑥β-binomial 与 de Finetti 数值积分（Simpson，归一化相消）对照 1e-8；
 *   ⑦幂律精确数据参数回收；⑧局部最优性扰动检查（δ 搬预算不改进）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 缺省配置 ───────────────────────────

/** 内核缺省参数（const 对象 + 类型，无 enum/namespace） */
export const TTC_DEFAULTS = {
  /** optimalVoteN 的奇数 n 搜索上限 */
  maxVoteN: 9999,
  /** powerLawFit 未知渐近线时的网格粗扫点数 */
  fitGridPoints: 97,
  /** 渐近线括号贴边时的自动扩张次数上限 */
  fitBracketExpansions: 9,
  /** 黄金分割细化迭代数 */
  fitGoldenIters: 60,
} as const;

export interface TtcDefaults {
  readonly maxVoteN: number;
  readonly fitGridPoints: number;
  readonly fitBracketExpansions: number;
  readonly fitGoldenIters: number;
}

// ─────────────────────────── (a) 自一致性投票 ───────────────────────────

/**
 * 多数票正确率（奇数 n 路自一致性投票）。
 *
 * rho=0（独立）: 二项尾 Σ_{i>(n/2)} C(n,i)pⁱ(1−p)ⁿ⁻ⁱ，log-Γ 逐项精确求和。
 * rho>0（β-binomial 相关校正）: 潜变量 θ~Beta(α,β)（α=p(1−ρ)/ρ，
 * β=(1−p)(1−ρ)/ρ，成对相关恰为 ρ），票数服从 beta-binomial。
 */
export function majorityAccuracy(p: number, n: number, rho = 0): number {
  const nn = Math.floor(n);
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('majorityAccuracy: p ∈ [0,1]');
  if (!Number.isFinite(n) || nn < 1 || nn % 2 === 0) {
    throw new Error('majorityAccuracy: n 需为 ≥ 1 的奇数（多数票无平局口径）');
  }
  if (!Number.isFinite(rho) || rho < 0 || rho >= 1) throw new Error('majorityAccuracy: ρ ∈ [0,1)');
  if (nn === 1) return p;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const k = (nn + 1) / 2;
  if (p === 0.5) return 0.5; // α=β 对称：任意 n 恰为 0.5（解析对称性，绕开数值尘埃）
  if (rho <= 0) {
    return binomialUpperTail(p, nn, k);
  }
  const shape = betaShapeParams(p, rho);
  return betaBinomialUpperTail(shape.alpha, shape.beta, nn, k);
}

/**
 * 有效样本数 n_eff = n/(1+(n−1)ρ)（均值方差口径）：
 * Var(X̄) = p(1−p)(1+(n−1)ρ)/n = p(1−p)/n_eff——相关让样本「变少」。
 */
export function voteEffectiveSampleSize(n: number, rho: number): number {
  const nn = Math.floor(n);
  if (!Number.isFinite(nn) || nn < 1) throw new Error('voteEffectiveSampleSize: n ≥ 1');
  if (!Number.isFinite(rho) || rho < 0 || rho >= 1) throw new Error('voteEffectiveSampleSize: ρ ∈ [0,1)');
  return nn / (1 + (nn - 1) * rho);
}

/**
 * 多数票精度天花板 lim_{n→∞} M(p,n,ρ)：
 * ρ=0 → p>1/2 时 1、p<1/2 时 0（Condorcet 极限）；ρ>0 → P(θ>1/2) =
 * 1 − I_{1/2}(α,β)——相关投票加样本也跨不过这道天花板（诚实给出）。
 */
export function voteAccuracyCeiling(p: number, rho = 0): number {
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('voteAccuracyCeiling: p ∈ [0,1]');
  if (!Number.isFinite(rho) || rho < 0 || rho >= 1) throw new Error('voteAccuracyCeiling: ρ ∈ [0,1)');
  if (p === 0.5) return 0.5;
  if (rho <= 0) return p > 0.5 ? 1 : 0;
  const shape = betaShapeParams(p, rho);
  return 1 - betainc(shape.alpha, shape.beta, 0.5);
}

/**
 * 达到目标准确率 target 的最小奇数 n。
 *
 * 不可达时显式 throw：target 超过精度天花板（相关性钉死）或超过
 * maxN（默认 9999）内可解——诚实拒绝而非假装达标。
 * 返回值保证 majorityAccuracy(p, n, rho) ≥ target 且（n>1 时）
 * majorityAccuracy(p, n−2, rho) < target（最小性的邻点口径）。
 */
export function optimalVoteN(p: number, target: number, rho = 0, maxN = TTC_DEFAULTS.maxVoteN): number {
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('optimalVoteN: p ∈ [0,1]');
  if (!Number.isFinite(target) || target <= 0 || target > 1) throw new Error('optimalVoteN: target ∈ (0,1]');
  if (!Number.isFinite(rho) || rho < 0 || rho >= 1) throw new Error('optimalVoteN: ρ ∈ [0,1)');
  const cap = Math.floor(maxN);
  if (!Number.isFinite(cap) || cap < 1) throw new Error('optimalVoteN: maxN ≥ 1');
  const topOdd = cap % 2 === 1 ? cap : cap - 1;
  if (topOdd < 1) throw new Error('optimalVoteN: maxN ≥ 1');

  const ceiling = voteAccuracyCeiling(p, rho);
  if (target > ceiling + 1e-12) {
    throw new Error(
      `optimalVoteN: target=${target} 超过精度天花板 ${ceiling.toPrecision(10)}（p=${p}, ρ=${rho}）——相关投票加样本不可达，诚实拒绝`,
    );
  }
  if (p < 0.5) {
    // 多数票放大系统性错误：M 随 n 递减 → 最优只能是 n=1（单样本 p）
    if (p >= target - 1e-15) return 1;
    throw new Error(`optimalVoteN: p=${p} < 0.5 时多数票精度随 n 递减，target=${target} 不可达`);
  }
  if (majorityAccuracy(p, 1, rho) >= target) return 1;
  if (majorityAccuracy(p, topOdd, rho) < target) {
    throw new Error(
      `optimalVoteN: n ≤ ${topOdd} 内不可达（M(${topOdd})=${majorityAccuracy(p, topOdd, rho).toPrecision(10)} < ${target}）`,
    );
  }
  // 奇数网格 n = 2i+1 上二分最小达标 i（M 对奇数 n 单调不减；p>0.5）
  let lo = 0;
  let hi = (topOdd - 1) / 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (majorityAccuracy(p, 2 * mid + 1, rho) >= target) hi = mid;
    else lo = mid + 1;
  }
  // 邻点回退兜底（β-binomial 单调性为数值验证口径，非定理防御）
  while (lo > 0 && majorityAccuracy(p, 2 * (lo - 1) + 1, rho) >= target) lo -= 1;
  return 2 * lo + 1;
}

// ─────────────────────────── (b) 幂律曲线与水填充 ───────────────────────────

/** 质量-算力幂律曲线 Q(C) = a − b·C^{−β} */
export interface PowerLawCurve {
  /** 渐近线（算力无穷时的质量上界） */
  a: number;
  /** 亏耗幅度 b > 0 */
  b: number;
  /** 收敛指数 β > 0（越大越快饱和） */
  beta: number;
}

/** 实测（算力, 质量）样本点 */
export interface PowerLawPoint {
  compute: number;
  quality: number;
}

export interface PowerLawFitOptions {
  /** 已知渐近线（如准确率上限 1）——只需 2 个点，且 (b, β) 为精确线性解 */
  asymptote?: number;
  /** 未知渐近线时的搜索括号上界（缺省自适应扩张） */
  maxAsymptote?: number;
  /** 网格粗扫点数 */
  gridPoints?: number;
}

export interface PowerLawFitResult extends PowerLawCurve {
  /** Q 空间决定系数（可为负——诚实报告烂拟合） */
  r2: number;
  /** Q 空间 RMSE */
  rmse: number;
  /** 拟合点数 */
  points: number;
  /** 渐近线是否由调用方给定 */
  asymptoteGiven: boolean;
}

/** 幂律质量 Q(C) = a − b·C^{−β}（C > 0） */
export function powerLawQuality(curve: PowerLawCurve, compute: number): number {
  assertCurve(curve, 'powerLawQuality');
  if (!Number.isFinite(compute) || compute <= 0) throw new Error('powerLawQuality: compute > 0');
  return curve.a - curve.b * Math.pow(compute, -curve.beta);
}

/** 幂律边际增益 ∂Q/∂C = b·β·C^{−β−1}（严格递减，C→0⁺ → +∞） */
export function powerLawMarginal(curve: PowerLawCurve, compute: number): number {
  assertCurve(curve, 'powerLawMarginal');
  if (!Number.isFinite(compute) || compute <= 0) throw new Error('powerLawMarginal: compute > 0');
  return curve.b * curve.beta * Math.pow(compute, -curve.beta - 1);
}

/**
 * 幂律拟合：从实测 (compute, quality) 点回归 {a, b, β}。
 *
 * 给定渐近线 a 时 ln(a−Q) = ln b − β·ln C 是精确线性回归（最小二乘闭式）。
 * 未知 a 时在括号 (max Q, upper] 内最小化 Q 空间残差：网格粗扫定位 +
 * 黄金分割细化；最优贴上边界则括号翻倍重扫（自适应扩张，上限 9 次）。
 */
export function powerLawFit(sample: ReadonlyArray<PowerLawPoint>, options?: PowerLawFitOptions): PowerLawFitResult {
  if (!sample || sample.length < 2) throw new Error('powerLawFit: 至少 2 个 (compute, quality) 点');
  const asymptoteGiven = options?.asymptote != null && Number.isFinite(options.asymptote);
  if (options?.asymptote != null && !Number.isFinite(options.asymptote)) {
    throw new Error('powerLawFit: asymptote 需为有限数');
  }
  if (sample.length < (asymptoteGiven ? 2 : 3)) {
    throw new Error(asymptoteGiven ? 'powerLawFit: 已知渐近线时至少 2 个点' : 'powerLawFit: 未知渐近线时至少 3 个点');
  }
  let qMax = -Infinity;
  let qMin = Infinity;
  for (const pt of sample) {
    if (!pt || !Number.isFinite(pt.compute) || pt.compute <= 0) throw new Error('powerLawFit: compute > 0 且有限');
    if (!Number.isFinite(pt.quality)) throw new Error('powerLawFit: quality 有限');
    qMax = Math.max(qMax, pt.quality);
    qMin = Math.min(qMin, pt.quality);
  }
  const distinctC = new Set(sample.map(pt => pt.compute)).size;
  if (distinctC < 2) throw new Error('powerLawFit: 至少需要 2 个不同的 compute 才能定斜率');
  if (qMax - qMin <= 1e-15 * Math.max(1, Math.abs(qMax))) {
    throw new Error('powerLawFit: 质量不随算力变化——递增幂律不适用（b→0 退化，诚实拒绝）');
  }
  if (asymptoteGiven && (options as { asymptote: number }).asymptote <= qMax) {
    throw new Error('powerLawFit: 渐近线必须高于全部实测质量');
  }
  const xs = sample.map(pt => Math.log(pt.compute));
  const nPts = sample.length;

  /** 给定渐近线 a：log-log OLS → (b, β) + Q 空间残差平方和 */
  const fitAt = (a: number): { sseQ: number; b: number; beta: number } => {
    const ys: number[] = [];
    for (const pt of sample) {
      const d = a - pt.quality;
      if (!(d > 1e-12)) return { sseQ: Infinity, b: NaN, beta: NaN };
      ys.push(Math.log(d));
    }
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < nPts; i += 1) {
      sx += xs[i];
      sy += ys[i];
      sxx += xs[i] * xs[i];
      sxy += xs[i] * ys[i];
    }
    const denom = nPts * sxx - sx * sx;
    if (!(denom > 1e-12)) return { sseQ: Infinity, b: NaN, beta: NaN };
    const slope = (nPts * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / nPts;
    const beta = -slope;
    const b = Math.exp(intercept);
    let sseQ = 0;
    for (let i = 0; i < nPts; i += 1) {
      const pred = a - b * Math.pow(sample[i].compute, -beta);
      if (!Number.isFinite(pred)) return { sseQ: Infinity, b, beta };
      sseQ += (pred - sample[i].quality) * (pred - sample[i].quality);
    }
    return { sseQ, b, beta };
  };

  let aFit: number;
  let fit: { sseQ: number; b: number; beta: number };
  if (asymptoteGiven) {
    aFit = (options as { asymptote: number }).asymptote;
    fit = fitAt(aFit);
  } else {
    const lower = qMax; // 排除边界（a − Q > 0 要求 a > max Q）
    let upper: number;
    let allowExpand: boolean;
    if (options?.maxAsymptote != null && Number.isFinite(options.maxAsymptote)) {
      if (options.maxAsymptote <= qMax) throw new Error('powerLawFit: maxAsymptote 必须高于全部实测质量');
      upper = options.maxAsymptote;
      allowExpand = false;
    } else {
      upper = qMax + Math.max(1e-6, qMax - qMin);
      allowExpand = true;
    }
    const grid = Math.max(16, Math.floor(options?.gridPoints ?? TTC_DEFAULTS.fitGridPoints));
    const goldenIters = TTC_DEFAULTS.fitGoldenIters;
    const invPhi = (Math.sqrt(5) - 1) / 2;
    fit = { sseQ: Infinity, b: NaN, beta: NaN };
    aFit = NaN;
    for (let attempt = 0; attempt < TTC_DEFAULTS.fitBracketExpansions; attempt += 1) {
      const at = (j: number): number => lower + (upper - lower) * (j / grid);
      // 网格粗扫 (lower, upper]
      let bestJ = 1;
      let bestSse = Infinity;
      for (let j = 1; j <= grid; j += 1) {
        const s = fitAt(at(j)).sseQ;
        if (s < bestSse) {
          bestSse = s;
          bestJ = j;
        }
      }
      // 黄金分割细化 [a_{bestJ−1}, a_{bestJ+1}]
      let loG = at(Math.max(0, bestJ - 1));
      let hiG = at(Math.min(grid, bestJ + 1));
      let cG = hiG - invPhi * (hiG - loG);
      let dG = loG + invPhi * (hiG - loG);
      let fc = fitAt(cG).sseQ;
      let fd = fitAt(dG).sseQ;
      for (let it = 0; it < goldenIters && hiG - loG > 1e-14 * Math.max(1, Math.abs(hiG)); it += 1) {
        if (fc < fd) {
          hiG = dG;
          dG = cG;
          fd = fc;
          cG = hiG - invPhi * (hiG - loG);
          fc = fitAt(cG).sseQ;
        } else {
          loG = cG;
          cG = dG;
          fc = fd;
          dG = loG + invPhi * (hiG - loG);
          fd = fitAt(dG).sseQ;
        }
      }
      const aCand = fc < fd ? cG : dG;
      const sseCand = fc < fd ? fc : fd;
      const aTry = sseCand < bestSse ? aCand : at(bestJ);
      const fitTry = sseCand < bestSse ? fitAt(aTry) : fitAt(at(bestJ));
      if (fitTry.sseQ < fit.sseQ) {
        fit = fitTry;
        aFit = aTry;
      }
      // 贴上边界 → 真渐近线可能在更远处：括号翻倍重扫（或已达扩张上限，接受当前最优）
      if (!allowExpand || aFit < upper - (upper - lower) / grid || attempt === TTC_DEFAULTS.fitBracketExpansions - 1) {
        break;
      }
      upper = lower + (upper - lower) * 2;
    }
  }
  if (!Number.isFinite(aFit) || !Number.isFinite(fit.sseQ)) {
    throw new Error('powerLawFit: 幂律拟合未收敛（数据需呈递增饱和形态）');
  }
  if (!(fit.beta > 0) || !Number.isFinite(fit.beta)) {
    throw new Error(`powerLawFit: 拟合指数 β=${fit.beta} ≤ 0（质量不随算力递增），幂律模型不适用`);
  }
  if (!(fit.b > 0) || !Number.isFinite(fit.b)) {
    throw new Error(`powerLawFit: 拟合亏耗 b=${fit.b} ≤ 0，幂律模型不适用`);
  }
  const qMean = sample.reduce((s, pt) => s + pt.quality, 0) / nPts;
  const ssTot = sample.reduce((s, pt) => s + (pt.quality - qMean) * (pt.quality - qMean), 0);
  const r2 = ssTot > 0 ? 1 - fit.sseQ / ssTot : 1;
  return {
    a: aFit,
    b: fit.b,
    beta: fit.beta,
    r2,
    rmse: Math.sqrt(fit.sseQ / nPts),
    points: nPts,
    asymptoteGiven,
  };
}

/** 水填充策略曲线（幂律 + 最小/最大可行配置） */
export interface WaterfillCurve extends PowerLawCurve {
  id: string;
  /** 最小可行算力（如投票至少 1 路的成本）；缺省 0 */
  min?: number;
  /** 最大可用算力（策略饱和/许可上限）；缺省 ∞ */
  max?: number;
}

export interface WaterfillAllocation {
  id: string;
  /** 分得算力 C_i */
  compute: number;
  /** 质量贡献 Q_i(C_i)（C_i=0 的未参与策略记 0——未运行不产出质量） */
  quality: number;
  /** 边际增益 b_iβ_iC_i^{−β_i−1}（C_i=0 时为 ∞——第一份算力无价） */
  marginal: number;
  /** 被下限/上限钉住，还是自由水填充 */
  pinned: 'min' | 'max' | null;
}

export interface WaterfillPlan {
  allocations: WaterfillAllocation[];
  /** 共同边际增益 = KKT 乘子 λ（单位质量/单位算力） */
  lambda: number;
  totalQuality: number;
  spent: number;
  /** 上限钉死导致的未花完预算（诚实暴露，其余情形为 0） */
  slack: number;
  /** 自由策略边际是否全部等于 λ（1e-6 口径） */
  equalized: boolean;
  iterations: number;
  reason: string;
}

/**
 * 预算 B 下的拉格朗日水填充：max Σ Q_i(C_i) s.t. Σ C_i = B，C_i ∈ [min_i, max_i]。
 *
 * 自由策略边际全相等（= λ），被 min 钉住的边际 ≤ λ、被 max 钉住的 ≥ λ；
 * 预算低于 Σmin_i 时显式 throw（不可行，诚实拒绝）。
 */
export function waterfillBudget(curves: ReadonlyArray<WaterfillCurve>, budget: number): WaterfillPlan {
  if (!Number.isFinite(budget) || budget < 0) throw new Error('waterfillBudget: 预算 B ≥ 0');
  if (!curves || curves.length === 0) throw new Error('waterfillBudget: 至少一条策略曲线');
  const seen = new Set<string>();
  const items = curves.map(c => {
    if (!c || typeof c.id !== 'string' || !c.id) throw new Error('waterfillBudget: 每条曲线需非空 id');
    if (seen.has(c.id)) throw new Error(`waterfillBudget: 策略 id 重复（${c.id}）`);
    seen.add(c.id);
    assertCurve(c, 'waterfillBudget');
    const min = c.min ?? 0;
    const max = c.max ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(min) || min < 0) throw new Error(`waterfillBudget: ${c.id} 的 min ≥ 0`);
    if (max < min) throw new Error(`waterfillBudget: ${c.id} 的 max ≥ min`);
    return {
      id: c.id,
      a: c.a,
      b: c.b,
      beta: c.beta,
      min,
      max,
      w: Math.pow(c.b * c.beta, 1 / (c.beta + 1)),
      s: 1 / (c.beta + 1),
      compute: 0,
      pinned: null as 'min' | 'max' | null,
    };
  });
  const minSum = items.reduce((s, x) => s + x.min, 0);
  if (minSum > budget + 1e-12 * Math.max(1, budget)) {
    throw new Error(`waterfillBudget: 预算 ${budget} 低于最小可行配置之和 ${minSum}（不可行，诚实拒绝）`);
  }

  let lambda = Number.POSITIVE_INFINITY;
  let iterations = 0;
  for (;;) {
    iterations += 1;
    const active = items.filter(x => x.pinned === null);
    if (active.length === 0) break;
    const remaining = budget - items.reduce((s, x) => s + (x.pinned ? x.compute : 0), 0);
    if (remaining <= 1e-15 * Math.max(1, budget)) {
      // 预算恰好被钉住策略花完：min=0 的自由策略分得 0（Σmin ≤ B 已保证 min>0 者不会滞留）
      for (const x of active) x.compute = x.min;
      break;
    }
    // f(λ) = Σ_active w_i·λ^{−s_i} − remaining，严格递减；动态括号 + 几何中点二分
    const f = (lam: number): number => active.reduce((s, x) => s + x.w * Math.pow(lam, -x.s), 0) - remaining;
    let hiL = 1;
    while (f(hiL) > 0 && hiL < 1e300) hiL *= 8;
    let loL = hiL;
    while (loL > 1e-300 && f(loL) < 0) loL /= 8;
    let lo = loL;
    let hi = hiL;
    for (let it = 0; it < 200; it += 1) {
      const mid = Math.sqrt(lo * hi); // 几何中点：λ 跨量级时收敛均匀
      if (f(mid) > 0) lo = mid;
      else hi = mid;
    }
    lambda = Math.sqrt(lo * hi);
    let pinnedNow = false;
    for (const x of active) {
      const c = x.w * Math.pow(lambda, -x.s);
      if (c < x.min) {
        x.compute = x.min;
        x.pinned = 'min';
        pinnedNow = true;
      } else if (c > x.max) {
        x.compute = x.max;
        x.pinned = 'max';
        pinnedNow = true;
      } else {
        x.compute = c;
      }
    }
    if (!pinnedNow) break;
    if (iterations > items.length + 1) break; // 每轮至少钉住一条，理论 ≤ m 轮——安全阀
  }

  const allocations: WaterfillAllocation[] = items.map(x => ({
    id: x.id,
    compute: x.compute,
    quality: x.compute > 0 ? x.a - x.b * Math.pow(x.compute, -x.beta) : 0,
    marginal: x.compute > 0 ? x.b * x.beta * Math.pow(x.compute, -x.beta - 1) : Number.POSITIVE_INFINITY,
    pinned: x.pinned,
  }));
  const spent = allocations.reduce((s, al) => s + al.compute, 0);
  const totalQuality = allocations.reduce((s, al) => s + al.quality, 0);
  const slack = Math.max(0, budget - spent);
  const free = allocations.filter(al => al.pinned === null && al.compute > 0);
  const maxDiff = free.reduce((m, al) => Math.max(m, Math.abs(al.marginal - lambda)), 0);
  const equalized = free.length <= 1 || maxDiff <= 1e-6;
  const pinnedIds = allocations.filter(al => al.pinned !== null).map(al => `${al.id}@${al.pinned}=${al.compute.toPrecision(6)}`);
  const reason =
    `${allocations.length} 条策略配给 ${spent.toPrecision(8)}/${budget} 算力，λ=${lambda.toExponential(4)} 质量/单位算力` +
    (pinnedIds.length > 0 ? `；钉住: ${pinnedIds.join(', ')}` : '；全部自由水填充') +
    (slack > 1e-9 * Math.max(1, budget) ? `；上限留白 ${slack.toPrecision(6)}` : '');
  return { allocations, lambda, totalQuality, spent, slack, equalized, iterations, reason };
}

// ─────────────────────────── (c) 边际收益早停 ───────────────────────────

export interface EarlyStopVerdict {
  /** true = 停止追加算力 */
  stop: boolean;
  /** 边际增益 − 价格（每单位算力的净价值） */
  netValue: number;
  reason: string;
}

/**
 * 边际收益早停规则：边际增益 < 单位算力价格 → 停（再算不值）。
 * 等号（增益恰等于价格）视为继续——无差异时不放弃已有改进。
 */
export function earlyStopRule(marginalGain: number, price: number): EarlyStopVerdict {
  if (!Number.isFinite(marginalGain)) throw new Error('earlyStopRule: marginalGain 需为有限数');
  if (!Number.isFinite(price) || price < 0) throw new Error('earlyStopRule: price ≥ 0 且有限');
  const netValue = marginalGain - price;
  const stop = marginalGain < price;
  return {
    stop,
    netValue,
    reason: stop
      ? `边际增益 ${marginalGain.toPrecision(6)} < 算力价格 ${price.toPrecision(6)}（净值 ${netValue.toPrecision(6)}）——再算不值，停`
      : `边际增益 ${marginalGain.toPrecision(6)} ≥ 算力价格 ${price.toPrecision(6)}（净值 +${netValue.toPrecision(6)}/单位算力）——继续`,
  };
}

// ─────────────────────────── 数值基础设施（文件内自带，零 import） ───────────────────────────

// ─────────────────── (R5-A1) 自一致性的加权多数（按单样本置信加权） ───────────────────

/** 加权多数票结果（win/tie/accuracy 三口径 + 审计字段） */
export interface WeightedMajorityResult {
  /** P(严格多数正确) = P(2S > M) */
  win: number;
  /** P(平局) = P(2S = M)（M 偶数时 > 0; 奇数恒 0——与无平局奇数口径一致） */
  tie: number;
  /** win + tie/2（随机破平的期望口径） */
  accuracy: number;
  /** Kish 有效样本数 (Σw)²/Σw²（尺度不变） */
  effectiveN: number;
  /** 公度整数化后的权重（审计口径; m_j = w_j × scale 取整） */
  integerWeights: number[];
  /** 整数化倍率 scale */
  scale: number;
  /** 恒 true: ρ=0 与 ρ>0 均为精确组合/闭式（与 weightedMajorityNormal 的近似对照） */
  exact: true;
}

/**
 * Kish 有效样本数 n_eff = (Σw)² / Σw²。
 *
 * 加权样本均值的方差口径: Var(Σw X/Σw) = σ²·Σw²/(Σw)² = σ²/n_eff——
 * 权重集中 ⟹ n_eff < n（同样的票数, 信息更少）。尺度不变。
 */
export function kishEffectiveSampleSize(weights: ReadonlyArray<number>): number {
  const w = validateWeights(weights);
  let s1 = 0;
  let s2 = 0;
  for (const x of w) {
    s1 += x;
    s2 += x * x;
  }
  return (s1 * s1) / s2;
}

function validateWeights(weights: ReadonlyArray<number>): number[] {
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new Error('weightedMajority: weights 需为非空数组');
  }
  if (weights.length > 40) {
    throw new Error(`weightedMajority: 权重数 ${weights.length} > 40（精确 DP 的组合计数上界 2⁴⁰ 口径, 诚实拒绝）`);
  }
  const out: number[] = [];
  for (let i = 0; i < weights.length; i += 1) {
    const w = weights[i];
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
      throw new Error(`weightedMajority: weights[${i}] 需为 ≥0 有限数, 收到 ${String(w)}`);
    }
    out.push(w);
  }
  if (out.reduce((s, x) => s + x, 0) <= 0) {
    throw new Error('weightedMajority: 权重全零（无信息——诚实拒绝）');
  }
  return out;
}

/** 公度整数化: 最小 s ∈ 1..2048 使全部 w_i·s 贴整(相对 1e-9)且 Σ取整 ≤ 4096 */
function integerizeWeights(w: ReadonlyArray<number>): { m: number[]; scale: number } {
  for (let s = 1; s <= 2048; s += 1) {
    const scaled = w.map(x => x * s);
    const ints = scaled.map(x => Math.round(x));
    let ok = true;
    for (let i = 0; i < scaled.length; i += 1) {
      if (Math.abs(scaled[i] - ints[i]) > 1e-9 * Math.max(1, Math.abs(scaled[i]))) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const total = ints.reduce((sum, x) => sum + x, 0);
    if (total > 4096) break; // 更大的 s 只会更大——停
    return { m: ints, scale: s };
  }
  throw new Error('weightedMajority: 权重不可公度（×s 后无法全为整数或 Σ > 4096）——精确 DP 需整数权重, 诚实拒绝（可用 weightedMajorityNormal）');
}

/**
 * (R5-A1) 加权多数票的**精确**正确率。
 *
 * 模型: 第 j 票正确 X_j ~ Bernoulli（交换相关 ρ = de Finetti β-binomial 口径,
 * 与 majorityAccuracy 同族）, 票权 w_j; 正确侧胜出 = P(2S > M), S = Σ m_j X_j。
 *
 * ρ=0: 加权 Poisson-binomial 的子集和概率 DP（伪多项式 O(n·M), 逐项精确）;
 * ρ>0: 子集计数 DP c_{s,a}（计数 ≤ 2⁴⁰, float64 内精确）× Beta 矩闭式
 *   P(S=s) = Σ_a c_{s,a}·B(α+a, β+n−a)/B(α,β), α = p(1−ρ)/ρ, β = (1−p)(1−ρ)/ρ
 * ——θ 条件独立 ⟹ E[θ^a(1−θ)^{n−a}] = B(α+a,β+n−a)/B(α,β) 逐项闭式, 无数值积分。
 *
 * 等价锚点: 权重全 1（M = n 奇数）时 win ≡ majorityAccuracy(p, n, ρ)。
 */
export function weightedMajorityAccuracy(
  p: number,
  weights: ReadonlyArray<number>,
  rho = 0,
): WeightedMajorityResult {
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('weightedMajorityAccuracy: p ∈ [0,1]');
  if (!Number.isFinite(rho) || rho < 0 || rho >= 1) throw new Error('weightedMajorityAccuracy: ρ ∈ [0,1)');
  const w = validateWeights(weights);
  const { m, scale } = integerizeWeights(w);
  const n = m.length;
  const M = m.reduce((s, x) => s + x, 0);
  const effectiveN = kishEffectiveSampleSize(w);
  const finish = (win: number, tie: number): WeightedMajorityResult => ({
    win,
    tie,
    accuracy: win + tie / 2,
    effectiveN,
    integerWeights: m,
    scale,
    exact: true,
  });
  if (p === 0.5) {
    // 对称性: S 与 M−S 同分布 ⟹ win = (1−tie)/2, accuracy 恒 0.5（投票无增益的诚实判定）
    const tie = tieMass(m, M, rho);
    return finish((1 - tie) / 2, tie);
  }
  if (p <= 0) return finish(0, 0); // 全错: S=0, 2·0 > M 不可能(M>0)
  if (p >= 1) return finish(1, 0); // 全对: S=M, 2M > M 恒真
  if (rho <= 0) {
    // 独立: 概率 DP over 子集和
    let dp = new Float64Array(M + 1);
    dp[0] = 1;
    for (const mj of m) {
      const nd = new Float64Array(M + 1);
      for (let s = 0; s <= M - mj; s += 1) {
        if (dp[s] === 0) continue;
        nd[s] += dp[s] * (1 - p);
        nd[s + mj] += dp[s] * p;
      }
      dp = nd;
    }
    let win = 0;
    for (let s = 0; s <= M; s += 1) if (2 * s > M) win += dp[s];
    const tie = M % 2 === 0 ? dp[M / 2] : 0;
    return finish(Math.min(1, win), tie);
  }
  // 相关: 计数 DP c[s][a]（float64 精确 ≤ 2⁴⁰）× Beta 矩闭式
  const shape = betaShapeParams(p, rho);
  const alpha = shape.alpha;
  const betaS = shape.beta;
  const lnB0 = logBeta(alpha, betaS);
  let c = new Float64Array((M + 1) * (n + 1));
  c[0] = 1;
  const at = (s: number, a: number): number => c[s * (n + 1) + a];
  for (const mj of m) {
    const nc = new Float64Array((M + 1) * (n + 1));
    for (let s = 0; s <= M - mj; s += 1) {
      for (let a = 0; a < n; a += 1) {
        const v = at(s, a);
        if (v === 0) continue;
        nc[s * (n + 1) + a] += v; // 第 j 票错: 和不变, 基数不变
        nc[(s + mj) * (n + 1) + a + 1] += v; // 第 j 票对: 和 +m_j, 基数 +1
      }
    }
    c = nc;
  }
  let win = 0;
  let tie = 0;
  for (let s = 0; s <= M; s += 1) {
    if (2 * s < M) continue;
    let mass = 0;
    for (let a = 0; a <= n; a += 1) {
      const v = at(s, a);
      if (v === 0) continue;
      mass += v * Math.exp(logBeta(alpha + a, betaS + n - a) - lnB0);
    }
    if (2 * s > M) win += mass;
    else tie += mass;
  }
  return finish(Math.min(1, win), Math.min(1, tie));
}

/** 平局质量 P(S = M/2)（p=0.5 对称口径与 M 偶数审计复用; 独立/相关两路） */
function tieMass(m: ReadonlyArray<number>, M: number, rho: number): number {
  if (M % 2 !== 0) return 0;
  if (rho <= 0) {
    let dp = new Float64Array(M + 1);
    dp[0] = 1;
    for (const mj of m) {
      const nd = new Float64Array(M + 1);
      for (let s = 0; s <= M - mj; s += 1) {
        if (dp[s] === 0) continue;
        nd[s] += dp[s] * 0.5;
        nd[s + mj] += dp[s] * 0.5;
      }
      dp = nd;
    }
    return dp[M / 2];
  }
  const shape = betaShapeParams(0.5, rho);
  const n = m.length;
  const lnB0 = logBeta(shape.alpha, shape.beta);
  let c = new Float64Array((M + 1) * (n + 1));
  c[0] = 1;
  const at = (s: number, a: number): number => c[s * (n + 1) + a];
  for (const mj of m) {
    const nc = new Float64Array((M + 1) * (n + 1));
    for (let s = 0; s <= M - mj; s += 1) {
      for (let a = 0; a < n; a += 1) {
        const v = at(s, a);
        if (v === 0) continue;
        nc[s * (n + 1) + a] += v;
        nc[(s + mj) * (n + 1) + a + 1] += v;
      }
    }
    c = nc;
  }
  let mass = 0;
  for (let a = 0; a <= n; a += 1) {
    const v = at(M / 2, a);
    if (v === 0) continue;
    mass += v * Math.exp(logBeta(shape.alpha + a, shape.beta + n - a) - lnB0);
  }
  return Math.min(1, mass);
}

/**
 * (R5-A1) 加权多数票的 CLT 近似（任意实权重, 精确一二阶矩）:
 *   D = Σ_j w_j(2X_j−1), win ≈ Φ(E[D]/σ_D);
 *   E[D] = (2p−1)·Σw;
 *   Var[D] = 4·Var(Σw_j X_j) = 4p(1−p)·[ρ(Σw)² + (1−ρ)Σw²]
 *   （ρ=0 独立: 4p(1−p)Σw²; ρ>0: de Finetti 混合的方差分解）。
 * 与精确 DP 对照的误差 O(n^{−1/2})（验证脚本锚点）; 不可公度权重的可用口径。
 */
export function weightedMajorityNormal(p: number, weights: ReadonlyArray<number>, rho = 0): number {
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('weightedMajorityNormal: p ∈ [0,1]');
  if (!Number.isFinite(rho) || rho < 0 || rho >= 1) throw new Error('weightedMajorityNormal: ρ ∈ [0,1)');
  const w = validateWeights(weights);
  let s1 = 0;
  let s2 = 0;
  for (const x of w) {
    s1 += x;
    s2 += x * x;
  }
  const mean = (2 * p - 1) * s1;
  const variance = 4 * p * (1 - p) * (rho * s1 * s1 + (1 - rho) * s2);
  if (variance <= 0) {
    // 退化: p∈{0,1} 或只有一个非零权重——确定性结果
    if (mean > 0) return 1;
    if (mean < 0) return 0;
    return 0.5;
  }
  const z = mean / Math.sqrt(variance);
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** 误差函数 erf（Abramowitz–Stegun 7.1.26 有理逼近, |ε| ≤ 1.5e-7——CLT 近似口径足够） */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** de Finetti 混合分布参数：ρ = 1/(α+β+1) ⟺ α+β = (1−ρ)/ρ，均值 α/(α+β) = p */
function betaShapeParams(p: number, rho: number): { alpha: number; beta: number } {
  const s = (1 - rho) / rho;
  return { alpha: p * s, beta: (1 - p) * s };
}

/**
 * 二项上尾 Σ_{i=k}^{n} C(n,i)pⁱ(1−p)ⁿ⁻ⁱ（R5-A2: 对数域递推）。
 * 首项一次 log-Γ 起算, 逐项 ln T_{i+1} = ln T_i + ln(n−i) − ln(i+1) + ln(p/q)。
 * 对数域是关键: 尾首项可小至 e^{−5000}（线性域乘法递推会下溢为 0 且永远
 * 爬不回众数——M(0.9, 9999) 类极端参数因此失真）; 对数域无此问题,
 * exp 仅在求和时逐项求值（微小项诚实贡献 0）。
 */
function binomialUpperTail(p: number, n: number, k: number): number {
  const lp = Math.log(p);
  const lq = Math.log(1 - p);
  let lnTerm = logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1) + k * lp + (n - k) * lq;
  let sum = Math.exp(lnTerm);
  const lnRatio = lp - lq;
  for (let i = k; i < n; i += 1) {
    lnTerm += Math.log(n - i) - Math.log(i + 1) + lnRatio;
    sum += Math.exp(lnTerm);
  }
  return Math.min(1, sum);
}

/**
 * beta-binomial 上尾 Σ_{i=k}^{n} C(n,i)B(i+α, n−i+β)/B(α,β)
 * （R5-A2: 对数域递推; 比值 = (n−i)/(i+1) · (i+α)/(n−i+β−1),
 *   由 B(x+1,y−1)/B(x,y) = x/(y−1) 与 C(n,i+1)/C(n,i) 的乘积）。
 * 同 binomialUpperTail 的对数域动机: 尾首项下溢不再是破坏项。
 */
function betaBinomialUpperTail(alpha: number, beta: number, n: number, k: number): number {
  let lnTerm =
    logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1)
    + logBeta(k + alpha, n - k + beta) - logBeta(alpha, beta);
  let sum = Math.exp(lnTerm);
  for (let i = k; i < n; i += 1) {
    lnTerm += Math.log(n - i) + Math.log(i + alpha) - Math.log(i + 1) - Math.log(n - i + beta - 1);
    sum += Math.exp(lnTerm);
  }
  return Math.min(1, sum);
}

function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/** Lanczos log-Γ（g=7, n=9 系数；|相对误差| ~ 1e-13） */
function logGamma(x: number): number {
  const coef = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let acc = 0.99999999999980993;
  for (let i = 0; i < coef.length; i += 1) acc += coef[i] / (z + i + 1);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(acc);
}

/** 正则化不完全 Beta I_x(a,b)（Lentz 连分式，NR 口径） */
function betainc(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBt = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(lnBt);
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** 不完全 Beta 的连分式（Lentz 修正，MAXIT=300） */
function betacf(a: number, b: number, x: number): number {
  const maxIt = 300;
  const eps = 3e-16;
  const fpMin = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpMin) d = fpMin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIt; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

function assertCurve(curve: PowerLawCurve, who: string): void {
  if (!curve || typeof curve !== 'object') throw new Error(`${who}: 曲线需为含 {a, b, beta} 的对象`);
  if (!Number.isFinite(curve.a)) throw new Error(`${who}: a 有限`);
  if (!Number.isFinite(curve.b) || curve.b <= 0) throw new Error(`${who}: b > 0`);
  if (!Number.isFinite(curve.beta) || curve.beta <= 0) throw new Error(`${who}: beta > 0`);
}

/* ── 接线建议 ──
 * 建议挂载引擎: 任务执行器（高价值任务的重推理配置）与元认知预算仲裁
 * （跨策略算力配给 + 推理循环内边际停机）。
 *   1. 任务执行器: 任务价值/难度评估 → optimalVoteN(p̂, target) 计算投票
 *      路数 n（p̂ 来自模型历史准确率，target 来自任务价值分层）——高价值
 *      任务自动升级「重推理配置」，低价值任务保持单路；投票规模从拍脑袋
 *      升级为可达性计算（p̂ ≤ 0.5 或 target 超天花板时显式拒绝升级）。
 *   2. 元认知预算仲裁: 各策略（n 路投票 / 最佳-of-n / 顺序精炼）的历史
 *      (算力, 质量) 点 → powerLawFit 回归曲线 → waterfillBudget 在总预算 B
 *      下做边际相等配给；推理循环内每步用 earlyStopRule 检查
 *      powerLawMarginal < 算力价格即停（深度的恩赐 → 经济学停机）。
 *   缺省关闭旗标名: enableTestTimeComputeKernel（缺省 false；旗标关闭时
 *      采样路数/精炼深度/停机条件全部走原配置路径）。
 *   挂载后改变的决策点: ① 推理采样路数与精炼深度（原为固定配置常量）；
 *      ② 跨策略算力配比（原为均分或经验值）；③ 推理停机条件（原为深度
 *      上限，改为边际增益 < 单位算力价格的早停规则）。
 * 未挂载（旗标 false）时以上决策点全部走原路径——行为逐位一致（零漂移）。
 */
