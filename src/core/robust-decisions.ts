/**
 * 34.0 分布鲁棒内核 —— CVaR + Wasserstein 球：最坏情况有了闭式价格
 *
 * 动机: 系统里一切「按均值/按经验分位」的决策都隐含一个赌注：未来样本
 * 来自与历史相同的分布。但模型延迟分布会漂移（上游变慢、配额收紧），
 * 超时预算按均值设 → 一漂移就雪崩式超时。分布鲁棒优化（DRO）不赌单一
 * 分布，而是问:
 *
 *   sup_{Q: W₁(Q, P̂) ≤ ε} E_Q[ℓ]     （以经验分布为中心、半径 ε 的
 *                                     Wasserstein 球内的最坏期望）
 *
 *   Kantorovich–Rubinstein 对偶: W₁(Q,P̂) = sup{|E_Q φ − E_P̂ φ| : φ 1-Lipschitz}
 *   → 一维恒等映射是 1-Lipschitz ⟹ |E_Q[X] − E_P̂[X]| ≤ W₁ ≤ ε，且
 *     上界可达（把 ε 预算全部用于把最低处的质量搬到最高处——单位距离
 *     单位收益）。于是:
 *
 *     sup_{W₁≤ε} E[X] = min(E[X] + ε, b)   （支撑上界 b 已知时；
 *                                            无界支撑 = E[X] + ε）
 *     鲁棒均值不是启发式加成，是对偶定理的代数恒等式。
 *
 *   尾部风险的凸口径: CVaR（Rockafellar–Uryasev 2002）是唯一同时满足
 *   凸性 / 单调性 / 平移等变 / 正齐次的**相干风险度量**（与 16.0 Shapley
 *   的公理化同一品味——四公理不是描述，是唯一性定理）:
 *
 *     CVaR_α(X) = min_t { t + E[(X−t)₊]/(1−α) }
 *              = 最坏 (1−α) 尾部的期望（经验分布上 O(n log n) 精确）
 *
 *   超越概率的鲁棒口径: W₁ 球内质量要跨过阈值 t 至少要移动 (t − x)
 *   的距离 → 从最贴近 t 的下方样本搬起（单位质量成本最小）——精确的
 *   组合最坏化，worst P(X ≥ t) 有显式有限样本算法。
 *
 *   调度语义: 超时预算 = margin × CVaR_α(该模型延迟史)——「按最坏尾部
 *   的期望定价」而非「按均值加拍脑袋的裕度」；超时率从此有分布口径。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致。
 */

/** 样本分位（最近邻下插值；空样本返回 undefined） */
export function quantile(samples: ReadonlyArray<number>, p: number): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/**
 * CVaR_α（损失口径，越大越坏）：最坏 1−α 尾部的期望。
 *
 * Rockafellar–Uryasev min-form 在经验分布上的闭式解（α 为**置信水平**，
 * α=0.95 即最坏 5% 尾）：k = ⌈(1−α)n⌉，最坏 k−1 个样本全取 + 第 k 个
 * 取分数权重（权重恰合 1−α）。
 */
export function cvar(samples: ReadonlyArray<number>, alpha: number): number | undefined {
  if (samples.length === 0) return undefined;
  const beta = Math.min(1, Math.max(1e-9, 1 - alpha)); // 尾部质量
  const n = samples.length;
  const m = beta * n; // 尾部等效样本数（可分数）
  const sorted = [...samples].sort((a, b) => b - a); // 降序（最坏在前）
  const full = Math.floor(m + 1e-12);
  const frac = m - full;
  let acc = 0;
  for (let i = 0; i < full && i < n; i += 1) acc += sorted[i];
  if (frac > 1e-12 && full < n) acc += frac * sorted[full];
  return acc / m;
}

/** Rockafellar–Uryasev min-form 数值口径（验证锚点：与 cvar() 解析式对账） */
export function cvarMinForm(samples: ReadonlyArray<number>, alpha: number): number | undefined {
  if (samples.length === 0) return undefined;
  // 经验分布上 min 在某个样本点取到 → 候选 t = 各样本值，取最小
  let best = Infinity;
  for (const t of samples) {
    let excess = 0;
    for (const x of samples) excess += Math.max(0, x - t);
    best = Math.min(best, t + excess / samples.length / Math.max(1e-9, 1 - alpha));
  }
  return best;
}

/** CVaR 相干性公理审计（与 16.0 Shapley 四公理同一品味的验证锚点） */
export function cvarCoherenceAudit(samples: ReadonlyArray<number>, alpha: number): {
  monotone: boolean;
  translationEquivariant: boolean;
  positivelyHomogeneous: boolean;
  subadditive: boolean;
} {
  const base = cvar(samples, alpha) ?? 0;
  const shifted = cvar(samples.map((x) => x + 5), alpha) ?? 0;
  const scaled = cvar(samples.map((x) => x * 3), alpha) ?? 0;
  // 次可加性 CVaR(X+Y) ≤ CVaR(X)+CVaR(Y)：公理对任意耦合成立，取
  // 索引配对耦合（z_i = x_i + y_i）——边缘为 x、y 的合法联合分布
  const xs = samples.filter((_, i) => i % 2 === 0);
  const ys = samples.filter((_, i) => i % 2 === 1);
  // 索引配对耦合（z_i = x_i + y_i）——奇数样本时末位不配对（NaN 会静默
  // 毁掉次可加性判定），只取两边共有的前缀长度
  const zs = xs.slice(0, ys.length).map((x, i) => x + ys[i]);
  const subadd = (cvar(xs, alpha) ?? 0) + (cvar(ys, alpha) ?? 0) - (cvar(zs, alpha) ?? 0);
  return {
    monotone: (cvar(samples.map((x) => x + 1), alpha) ?? 0) >= base - 1e-9,
    translationEquivariant: Math.abs(shifted - (base + 5)) <= 1e-9,
    positivelyHomogeneous: Math.abs(scaled - 3 * base) <= 1e-9,
    subadditive: subadd >= -1e-9,
  };
}

/** Wasserstein-1 鲁棒均值（对偶定理的代数恒等式）。
 *
 * sup_{W₁(Q,P̂)≤ε} E_Q[X] = min(E_P̂[X] + ε, supportUpper)。
 * supportUpper 未提供 = 无界支撑（值 = E + ε）。样本为空 → undefined。
 */
export function wassersteinRobustMean(
  samples: ReadonlyArray<number>,
  epsilon: number,
  supportUpper?: number,
): number | undefined {
  if (samples.length === 0) return undefined;
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
  const robust = mean + Math.max(0, epsilon);
  return supportUpper !== undefined ? Math.min(robust, supportUpper) : robust;
}

/** 超越概率的最坏化（W₁ 球内 P(X ≥ t) 的精确有限样本最大值）。
 *
 * 贪心搬质量：单位质量从 x < t 跨到 t 的运价 = t − x，从最贴近 t 的
 * 下方样本搬起直到预算耗尽——运输问题的精确解（成本递增序贪心 =
 * 最小代价流）。返回名义值与最坏值。
 */
export function robustExceedance(
  samples: ReadonlyArray<number>,
  threshold: number,
  epsilon: number,
): { nominal: number; worst: number; movedMass: number } | undefined {
  if (samples.length === 0) return undefined;
  const n = samples.length;
  let above = 0;
  const below: number[] = [];
  for (const x of samples) {
    if (x >= threshold) above += 1;
    else below.push(x);
  }
  below.sort((a, b) => b - a); // 贴近阈值在前（运价最小）
  let budget = Math.max(0, epsilon);
  let moved = 0;
  for (const x of below) {
    if (budget <= 0) break;
    const costPerUnit = threshold - x;
    if (costPerUnit <= 0) continue;
    const affordable = budget / costPerUnit; // 每样本质量 1/n
    const take = Math.min(1 / n, affordable);
    moved += take;
    budget -= take * costPerUnit;
  }
  const nominal = above / n;
  return { nominal, worst: Math.min(1, nominal + moved), movedMass: moved };
}

export interface RobustTimeoutConfig {
  /** 置信水平 α（CVaR_α 取最坏 1−α 尾；缺省 0.95 即最坏 5% 尾） */
  alpha?: number;
  /** 裕度乘数（缺省 1.5——超时预算略高于条件尾部值，容纳批间漂移） */
  margin?: number;
  /** 样本下限（不足则不接管；缺省 30） */
  minSamples?: number;
  /** 下限（毫秒；缺省 5000） */
  floorMs?: number;
  /** 上限（毫秒；缺省 300000） */
  capMs?: number;
}

/**
 * 鲁棒超时预算（34.0 接线口径）。
 *
 * margin × CVaR_α(延迟样本)，钳位 [floor, cap]；样本不足返回 undefined
 * （调用方回退原口径——零漂移）。比「均值 × 3」好在：尾部的形状直接
 * 进入价格——重尾模型自动获得更长预算、轻尾模型不被一刀切。
 */
export function robustTimeout(samples: ReadonlyArray<number>, config?: RobustTimeoutConfig): number | undefined {
  const alpha = config?.alpha ?? 0.95;
  const margin = config?.margin ?? 1.5;
  const minSamples = config?.minSamples ?? 30;
  const floorMs = config?.floorMs ?? 5000;
  const capMs = config?.capMs ?? 300_000;
  if (samples.length < minSamples) return undefined;
  const tail = cvar(samples, alpha);
  if (tail === undefined || !Number.isFinite(tail) || tail <= 0) return undefined;
  return Math.min(capMs, Math.max(floorMs, tail * margin));
}

// ══════════════════════ R5 进化（第五轮·世界性进化） ══════════════════════
//
// 轴 1（数学）: CVaR 场景逼近的有限样本界（样本复杂度）。
//   经验 CVaR 是**乐观有偏**的: RU min-form CVaR_emp = min_t φ_t(样本) 与
//   min/max 可交换方向给出 E[CVaR_emp] ≤ min_t E[φ_t] = CVaR_true——
//   经验尾部平均系统性低估真实尾部。补偿多少? 三个引理给出精确价格:
//     (i)  有偏方向: E[CVaR_emp] ≤ CVaR_true（上式，Jensen 方向）;
//     (ii) 有界差分: CVaR_emp 对单个样本替换是 B/((1−α)n)-Lipschitz
//          （尾部平均总权重为 1，摊在 ≤ 1/(1−α) 个样本上，单样本替换至多
//          改变 B·(1/((1−α)n))，B = 支撑直径）;
//     (iii) McDiarmid: P(CVaR_true − CVaR_emp > ε) ≤ exp(−2ε²(1−α)²n/B²)。
//   ⟹ 以置信 1−δ: CVaR_true ≤ CVaR_emp + (B/(1−α))·√(ln(1/δ)/(2n))。
//   反解得样本复杂度: n ≥ B²·ln(1/δ)/(2ε²(1−α)²) ——「要 ε 精度的尾部，
//   样本按 1/ε² 计费，且尾部越深（α→1）越贵（1/(1−α)² 因子）」。
//   调度语义: 超时预算从「拿经验 CVaR 当真」升级为「CVaR + 有限样本罚」——
//   新模型样本少 30 条时预算自动加厚，样本攒够后罚项消失（确定性公式）。
//
// 轴 2（性能）: cvarProfile —— 一次排序 + 前缀和，多档 α 的 CVaR 全部
//   O(log n)（二分尾部切点），替代 k 次 O(n log n) 独立排序。等价性:
//   与 cvar() 解析式同式（仅求和顺序不同，容差 1e-9 内一致）。
//
// 轴 4（性质）: CVaR_α 关于 α 单调不降（尾部均值随置信加深只增不减）、
//   尾支配 CVaR_α ≥ VaR_α（尾部均值 ≥ 尾部分位）、关于分布混合凸
//  （次可加 + 正齐次的直接推论——凸性的正确口径在分布上; α ↦ CVaR_α
//   在分位数拐点处只保证单调与 Lipschitz，不保证 α 凸）。
// ══════════════════════════════════════════════════════════

/** CVaR 场景逼近配置（有限样本界口径） */
export interface CvarScenarioConfig {
  /** 置信水平 1−δ ∈ (0,1)（缺省 0.95——界以 95% 概率成立） */
  confidence?: number;
  /** 支撑上界 b（损失的最高可能值） */
  supportUpper: number;
  /** 支撑下界（缺省 0——延迟/成本口径的最低值） */
  supportLower?: number;
}

/**
 * CVaR 场景逼近的 ε 罚（McDiarmid 有界差分界）:
 *   ε(n, α, δ, B) = (B/(1−α))·√(ln(1/δ)/(2n))
 * 含义: n 个样本的经验 CVaR 低于真实 CVaR 超过 ε 的概率 ≤ δ。
 */
export function cvarSampleComplexity(
  sampleCount: number,
  alpha: number,
  confidence: number,
  supportDiameter: number,
): number {
  if (!Number.isInteger(sampleCount) || sampleCount < 1) {
    throw new Error(`cvarSampleComplexity: sampleCount=${String(sampleCount)} 必须为 ≥1 整数`);
  }
  const beta = Math.min(1, Math.max(1e-9, 1 - alpha));
  if (!(confidence > 0) || !(confidence < 1)) {
    throw new Error(`cvarSampleComplexity: confidence=${String(confidence)} 必须在 (0,1) 内`);
  }
  if (!(supportDiameter >= 0) || !Number.isFinite(supportDiameter)) {
    throw new Error(`cvarSampleComplexity: supportDiameter=${String(supportDiameter)} 必须为有限非负数`);
  }
  return (supportDiameter / beta) * Math.sqrt(Math.log(1 / (1 - confidence)) / (2 * sampleCount));
}

/**
 * 样本复杂度反解: 要 |CVaR_true − CVaR_emp| ≤ ε 以置信 1−δ 成立，
 * 至少需要 n = ⌈B²·ln(1/δ)/(2ε²(1−α)²)⌉ 个样本（上界紧到常数因子）。
 */
export function cvarRequiredSamples(
  alpha: number,
  epsilon: number,
  confidence: number,
  supportDiameter: number,
): number {
  const beta = Math.min(1, Math.max(1e-9, 1 - alpha));
  if (!(epsilon > 0) || !Number.isFinite(epsilon)) {
    throw new Error(`cvarRequiredSamples: epsilon=${String(epsilon)} 必须为 >0 有限数`);
  }
  if (!(confidence > 0) || !(confidence < 1)) {
    throw new Error(`cvarRequiredSamples: confidence=${String(confidence)} 必须在 (0,1) 内`);
  }
  if (!(supportDiameter >= 0) || !Number.isFinite(supportDiameter)) {
    throw new Error(`cvarRequiredSamples: supportDiameter=${String(supportDiameter)} 必须为有限非负数`);
  }
  return Math.ceil((supportDiameter * supportDiameter * Math.log(1 / (1 - confidence))) / (2 * epsilon * epsilon * beta * beta));
}

/**
 * CVaR 场景逼近上界（高置信真实 CVaR 上界）:
 *   bound = CVaR_emp + ε(n, α, δ, B) ≥ CVaR_true（概率 ≥ 1−δ）。
 * 超时定价的诚实口径——样本越少罚项越厚，与「拍脑袋 margin」不同，
 * 罚项有定理背书且随 n 以 1/√n 收缩。空样本 → undefined。
 */
export function cvarScenarioBound(
  samples: ReadonlyArray<number>,
  alpha: number,
  config: CvarScenarioConfig,
): { bound: number; empiricalCvar: number; epsilon: number; sampleCount: number } | undefined {
  if (samples.length === 0) return undefined;
  const confidence = config.confidence ?? 0.95;
  const supportLower = config.supportLower ?? 0;
  if (!(config.supportUpper > supportLower)) {
    throw new Error(`cvarScenarioBound: 需 supportUpper(${String(config.supportUpper)}) > supportLower(${String(supportLower)})`);
  }
  for (let i = 0; i < samples.length; i += 1) {
    if (!Number.isFinite(samples[i])) {
      throw new Error(`cvarScenarioBound: samples[${i}]=${String(samples[i])} 必须为有限数`);
    }
  }
  const empirical = cvar(samples, alpha);
  if (empirical === undefined) return undefined;
  const epsilon = cvarSampleComplexity(samples.length, alpha, confidence, config.supportUpper - supportLower);
  return { bound: empirical + epsilon, empiricalCvar: empirical, epsilon, sampleCount: samples.length };
}

/**
 * 多档 α 的 CVaR 剖面（性能进化）: 一次升序排序 + 前缀和，
 * 每档 α 二分定位尾部切点 O(log n)，总计 O(n log n + k·log n)——
 * 替代 k 次独立 cvar() 的 O(k·n log n)。与 cvar() 解析式同式，
 * 仅求和顺序不同（前缀和 = 升序前缀，cvar = 降序累加），浮点尾数差异
 * 在 1e-9 相对容差内（验证脚本逐档对账）。
 */
export function cvarProfile(samples: ReadonlyArray<number>, alphas: ReadonlyArray<number>): number[] | undefined {
  if (samples.length === 0) return undefined;
  const n = samples.length;
  const sorted = [...samples].sort((a, b) => a - b);
  const prefix = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + sorted[i];
  const out = new Array<number>(alphas.length);
  for (let k = 0; k < alphas.length; k += 1) {
    const alpha = alphas[k];
    if (!Number.isFinite(alpha)) {
      throw new Error(`cvarProfile: alphas[${k}]=${String(alpha)} 必须为有限数`);
    }
    const beta = Math.min(1, Math.max(1e-9, 1 - alpha));
    const m = beta * n;
    const full = Math.min(n, Math.floor(m + 1e-12));
    const frac = m - full;
    // 最坏 full 个 = 升序末 full 个（前缀和区间），第 full+1 个取分数权重
    let acc = prefix[n] - prefix[n - full];
    if (frac > 1e-12 && full < n) acc += frac * sorted[n - 1 - full];
    out[k] = acc / m;
  }
  return out;
}
