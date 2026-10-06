/**
 * mechanism-design.ts — 62.0 机制设计内核 —— VCG 外部性定价 + Myerson 最优拍卖
 *
 * 动机: 共生市场（src/symbiosis/market.ts 的连续双向拍卖）的费率表是拍
 * 脑袋的：喊价高于真值 → 赢了也亏（赢者诅咒），喊低 → 错失成交——参与者
 * 的最优策略是揣摩别人而非报告真实估值，价格信号从根上被污染。机制设计
 * （Hurwicz–Maskin–Myerson，2007 诺贝尔经济学奖；Myerson 2020）反过来
 * 问：什么规则能让「说真话」本身成为占优策略（DSIC）？Shapley 16.0 管
 * 事后分账（合作博弈），本内核管事前定价（非合作博弈）——参与 → 效应 →
 * 定价 → 分账，多智能体问责链补上激励这一层。
 *
 * 数学:
 * 1. VCG（Vickrey–Clarke–Groves）机制：分配最大化社会福利
 *      a* = argmax_a Σᵢ vᵢ(a)，W = Σᵢ vᵢ(a*)
 *    定价 = 外部性（Clarke  pivot 规则）：
 *      payᵢ = W*₋ᵢ − W₋ᵢ(a*)   （i 不在场时的最优他人总福利
 *                               − 胜出分配下的实际他人总福利）
 *    加性估值（agents × goods 矩阵，每物品独立估价）时精确退化为逐物品
 *    二价拍卖：每件物品归最高估值者、付该物品的第二高价。性质：
 *      - DSIC（诚实占优）：谎报不改变他人福利，只会把分配推离最优 →
 *        自身效用不可能提高；
 *      - 个体理性（IR）：payᵢ ≤ vᵢ(a*)，真实效用 ≥ 0；
 *      - 福利最优（efficiency）；
 *      - 非预算平衡：收入 ≥ 0 但一般 > 转移需求——Myerson–Satterthwaite
 *        不可能性定理的诚实呈现：DSIC + IR + 效率 + 预算平衡不可兼得，
 *        VCG 选择牺牲预算平衡换取其余三条。
 *
 * 2. Myerson 最优拍卖（单物品、n 个买方 iid 估值 ~ F 已知）：
 *      虚拟价值 φ(v) = v − (1−F(v))/f(v)   （估值 − 信息租）
 *    最高**非负**虚拟价值者获胜，支付为临界值（第二高虚拟价值反解）：
 *      pay = φ̄⁻¹( max(0, φ̄(v₂)) )
 *    φ 非单调（非正则分布）时铁化（ironing）：对 φ 在 F 的测度下做加权
 *    保序回归（池相邻违例算法 PAVA，权重 = 各格点的 F 质量），池区间内
 *    以池均值替换——等价于对 Φ(z) = ∫₀ᶻ φ dF 取凸包后求导；铁化曲线 φ̄
 *    单调且保持 ∫φ̄ dF（期望虚拟价值 = 期望估值不变）。正则对称情形，
 *    最优拍卖恰为带保留价 r = φ̄⁻¹(0) 的二价拍卖；均匀 [0,1] 时
 *    φ(v) = 2v−1 → r = 1/2，n=2 期望收益 E[max(r, V₍₂₍)] = 5/12
 *    > 1/3 = E[V₍₂₍]（无保留价二价）。
 *
 * 验证锚点（scripts/verify-mechanism-design.mjs）:
 * ① 单物品 2 人退化：VCG 支付 = 第二高价（精确对照）；
 * ② DSIC 抽样：≥1000 组随机估值剖面 × 每个 agent 随机谎报，按真实估值
 *    计算的效用从不高于诚实（无一违例；VCG / Myerson 正则 / Myerson
 *    铁化三路各测）；
 * ③ 均匀 [0,1] iid：保留价 ≈ 0.5（插值精确到 1e-9）、逐场收益
 *    max(r, v₂) ≥ v₂ 点态 ≥ 无保留价二价（4 种子逐种子对照）、
 *    Monte Carlo 期望收益对照理论 5/12（容差 0.01 ≈ 8σ，σ≈0.0012）；
 * ④ 非单调虚拟值输入 → PAVA 铁化输出单调，且加权质量守恒
 *    Σwⱼφⱼ = Σwⱼφ̄ⱼ；
 * ⑤ 个体理性：支付 ≤ 真实估值恒成立（VCG 与 Myerson 全样本）；
 * ⑥ VCG 收入非负（Revenue ≥ −1e-9 全样本）。
 *
 * R5 进化（第五轮·世界性升级，数学+性能+性质三轴）:
 *   数学轴——组合拍卖赢家确定（combinatorial winner determination，
 *   一般估值/捆绑报价/XOR 口径）: bids = (agent, 捆绑 S, 报价 v)，可行解
 *   = 捆绑两两不交且每 agent 至多中一标; 赢家确定 = 最大权集合打包
 *   （set packing，NP-hard）——小规模精确求解: 分支定界（take 分支
 *   先行 + 剩余可行价值上界剪枝），确定性平局规则 = 中标指示向量按
 *   输入序的字典序最大（优先保留更早的标）。定价叠 VCG 外部性:
 *   payᵢ = W*₋ᵢ − W₋ᵢ(a*)（每 agent 剔除重解一次 WDP）——单物品
 *   退化 = secondPrice（每人一标 ⟹ 最高者胜、付第二高价，与 Vickrey
 *   二价逐字一致）。
 *   性能轴——分支定界 vs 2^m 全子集暴力: 等价性 = 同一最优值 + 同一
 *     「指示向量字典序最大」argmax（take-first DFS 的叶序 = 该字典序
 *     的降序，故「首个严格改进者」= 规则下唯一 argmax，暴力侧同规则
 *     枚举）——≥200 种子化实例逐一对照 + 耗时比。DSIC/IR/收入非负
 *     同锚点②⑤⑥口径延伸到组合域。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 常量与类型 ───────────────────────────

/** pdf 数值下限（f→0 处 φ→−∞ 的有界化；权重同步下限防 0/0） */
const PDF_FLOOR = 1e-12;
/** 单调性判定的浮点容差 */
const MONOTONE_TOL = 1e-12;

/** 估值分布的网格表示（xs 严格递增；cdf 单调不减 ∈ [0,1]；pdf ≥ 0） */
export interface DistributionGrid {
  readonly xs: readonly number[];
  readonly cdf: readonly number[];
  readonly pdf: readonly number[];
}

/** 铁化池：φ 在 [lo, hi] 上被池均值 value 替换（Myerson ironing 的区间） */
export interface IronPool {
  readonly lo: number;
  readonly hi: number;
  readonly value: number;
}

/** 虚拟价值曲线：原始 φ + PAVA 铁化 φ̄（单调） */
export interface IronedVirtualCurve {
  readonly xs: readonly number[];
  /** 原始虚拟价值 φ(xⱼ) = xⱼ − (1−Fⱼ)/fⱼ */
  readonly phi: readonly number[];
  /** 铁化后 φ̄（单调不减；raw 单调时与 phi 重合） */
  readonly ironed: readonly number[];
  /** 各格点的 F 质量 wⱼ = max(fⱼ, floor)·Δⱼ（PAVA 权重，质量守恒的可观测面） */
  readonly weights: readonly number[];
  /** 原始 φ 是否已单调（true = 无需铁化） */
  readonly rawMonotone: boolean;
  /** 铁化池列表（跨 ≥2 个格点的常数段） */
  readonly pools: readonly IronPool[];
}

/** VCG 拍卖输入：bids[i][g] = agent i 对物品 g 的估值（加性、单位需求） */
export interface VcgAuctionInput {
  readonly bids: ReadonlyArray<ReadonlyArray<number>>;
  /** 物品数（给出时必须等于 bids 行宽；缺省按首行推断） */
  readonly goods?: number;
}

/** VCG 拍卖结果 */
export interface VcgOutcome {
  /** assignment[g] = 物品 g 的胜者下标（并列时取最小下标，确定性） */
  readonly assignment: number[];
  /** allocatedGoods[i] = agent i 赢得的物品列表 */
  readonly allocatedGoods: number[][];
  /** Clarke 外部性支付（加性情形 = 所赢物品的第二高价之和） */
  readonly payments: number[];
  /** 诚实报价下的效用 Σ 自身赢得估值 − 支付（IR 的可观测面，≥ 0） */
  readonly utilities: number[];
  /** 社会福利 Σ 胜出报价（加性情形的可行最优） */
  readonly welfare: number;
  /** 拍卖收入 Σ payments（≥ 0——非预算平衡的下界） */
  readonly revenue: number;
  /** 每件物品的第二高价（n=1 时为 0——无外部性即无支付） */
  readonly perGoodSecondPrice: number[];
}

/** Myerson 最优拍卖结果（单物品） */
export interface MyersonOutcome {
  /** 胜者下标（无成交 = −1） */
  readonly winner: number;
  /** 临界值支付 φ̄⁻¹(max(0, 第二高虚拟价值))；无成交 = 0 */
  readonly payment: number;
  /** 收入 = payment（无成交 = 0） */
  readonly revenue: number;
  /** 是否成交 */
  readonly sold: boolean;
  /** 保留价 r = φ̄⁻¹(0)（分布整体为负虚拟价值时为 Infinity = 永不卖） */
  readonly reserve: number;
  /** 各报价的铁化虚拟价值 φ̄(vᵢ)（分配与定价的实际依据） */
  readonly virtuals: number[];
  /** 各报价的原始虚拟价值 φ(vᵢ)（透明度：铁化改变了什么） */
  readonly rawVirtuals: number[];
  /** 本次拍卖是否实际启用了铁化曲线（分布非正则） */
  readonly ironed: boolean;
}

// ─────────────────────────── 确定性随机源 ───────────────────────────

/** 确定性 PRNG（mulberry32；验证脚本与内核共用同一实现保证可复现） */
export function mulberry32(seed: number): () => number {
  if (!Number.isFinite(seed)) throw new Error('mulberry32: seed 必须为有限数');
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────── 分布网格 ───────────────────────────

/**
 * 构造并校验估值分布网格。
 * xs 严格递增、cdf ∈ [0,1] 单调不减、pdf ≥ 0 且总质量 > 0。
 */
export function makeDistributionGrid(
  xs: readonly number[],
  cdf: readonly number[],
  pdf: readonly number[],
): DistributionGrid {
  if (xs.length < 2) throw new Error('makeDistributionGrid: xs 至少 2 个格点');
  if (cdf.length !== xs.length || pdf.length !== xs.length) {
    throw new Error('makeDistributionGrid: xs/cdf/pdf 长度必须一致');
  }
  let mass = 0;
  for (let j = 0; j < xs.length; j += 1) {
    if (!Number.isFinite(xs[j]) || !Number.isFinite(cdf[j]) || !Number.isFinite(pdf[j])) {
      throw new Error('makeDistributionGrid: 含非有限值');
    }
    if (j > 0 && !(xs[j] > xs[j - 1])) throw new Error('makeDistributionGrid: xs 必须严格递增');
    if (cdf[j] < 0 || cdf[j] > 1) throw new Error('makeDistributionGrid: cdf 必须在 [0,1]');
    if (j > 0 && cdf[j] < cdf[j - 1] - 1e-12) throw new Error('makeDistributionGrid: cdf 必须单调不减');
    if (pdf[j] < 0) throw new Error('makeDistributionGrid: pdf 必须 ≥ 0');
    const width = j === 0 ? xs[1] - xs[0] : j === xs.length - 1 ? xs[j] - xs[j - 1] : (xs[j + 1] - xs[j - 1]) / 2;
    mass += Math.max(pdf[j], PDF_FLOOR) * width;
  }
  if (mass <= PDF_FLOOR) throw new Error('makeDistributionGrid: 分布总质量必须 > 0');
  // 防御性拷贝：网格一经构造不可变（铁化缓存的前提）
  return { xs: [...xs], cdf: [...cdf], pdf: [...pdf] };
}

/** 均匀 [0,1] 分布网格（steps+1 个格点，xsⱼ = j/steps；解析锚点用） */
export function uniformUnitGrid(steps = 100): DistributionGrid {
  if (!Number.isInteger(steps) || steps < 2) throw new Error('uniformUnitGrid: steps 必须为 ≥2 的整数');
  const xs: number[] = [];
  const cdf: number[] = [];
  const pdf: number[] = [];
  for (let j = 0; j <= steps; j += 1) {
    xs.push(j / steps);
    cdf.push(j / steps);
    pdf.push(1);
  }
  return makeDistributionGrid(xs, cdf, pdf);
}

/**
 * 经验分布网格（样本 → 网格）：xs 均匀覆盖 [min, max]，cdf 为经验累积
 * 频率，pdf 为 cdf 的中点差分斜率（区间密度）。
 */
export function empiricalGrid(samples: readonly number[], bins = 64): DistributionGrid {
  if (samples.length < 2) throw new Error('empiricalGrid: 样本至少 2 个');
  if (!Number.isInteger(bins) || bins < 8) throw new Error('empiricalGrid: bins 必须为 ≥8 的整数');
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of samples) {
    if (!Number.isFinite(s)) throw new Error('empiricalGrid: 样本含非有限值');
    if (s < lo) lo = s;
    if (s > hi) hi = s;
  }
  if (!(hi > lo)) throw new Error('empiricalGrid: 样本值域为零宽度（常数样本）');
  const n = samples.length;
  const xs: number[] = [];
  const cdf: number[] = [];
  const pdf: number[] = [];
  for (let j = 0; j <= bins; j += 1) {
    const x = lo + ((hi - lo) * j) / bins;
    let count = 0;
    for (const s of samples) if (s <= x) count += 1;
    xs.push(x);
    cdf.push(count / n);
  }
  for (let j = 0; j <= bins; j += 1) {
    // 中点差分斜率（端点单侧），恒 ≥ 0（cdf 单调）
    const left = j === 0 ? cdf[0] : cdf[j - 1];
    const right = j === bins ? cdf[bins] : cdf[j + 1];
    const dx = j === 0 ? xs[1] - xs[0] : j === bins ? xs[bins] - xs[bins - 1] : (xs[j + 1] - xs[j - 1]) / 2;
    pdf.push((right - left) / dx);
  }
  return makeDistributionGrid(xs, cdf, pdf);
}

// ─────────────────────────── 插值工具 ───────────────────────────

/** 二分定位：返回最后一个 ≤ v 的格点下标（v 越界则夹逼到端点） */
function bracketIndex(xs: readonly number[], v: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  if (v <= xs[0]) return 0;
  if (v >= xs[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= v) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** 在 (xs, ys) 上对 v 做分段线性插值（越界夹逼到端点值） */
function interpolateAt(v: number, xs: readonly number[], ys: readonly number[]): number {
  const i = bracketIndex(xs, v);
  if (i >= xs.length - 1) return ys[xs.length - 1];
  const t = (v - xs[i]) / (xs[i + 1] - xs[i]);
  return ys[i] + t * (ys[i + 1] - ys[i]);
}

/** 在单调不减曲线 (xs, ys) 上反解：最小的 x 使 ys(x) ≥ target */
function inverseMonotone(target: number, xs: readonly number[], ys: readonly number[]): number {
  if (!(ys[ys.length - 1] >= target)) return xs[xs.length - 1];
  if (ys[0] >= target) return xs[0];
  let lo = 0;
  let hi = ys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ys[mid] >= target) hi = mid;
    else lo = mid;
  }
  // ys[lo] < target ≤ ys[hi]：段内线性反解
  const t = (target - ys[lo]) / (ys[hi] - ys[lo]);
  return xs[lo] + t * (xs[hi] - xs[lo]);
}

// ─────────────────────────── 虚拟价值与铁化 ───────────────────────────

/**
 * 虚拟价值 φ(v) = v − (1−F(v))/f(v)（估值 − 信息租）。
 * f 数值为 0 时按 PDF_FLOOR 有界化（φ→−∞ 的数值语义：该点几乎无密度，
 * 信息租无限大）。v 越出网格域时按端点 F/f 取值（外延只用于展示，
 * 拍卖入口会拒绝越域报价）。
 */
export function virtualValue(v: number, grid: DistributionGrid): number {
  if (!Number.isFinite(v)) throw new Error('virtualValue: v 必须为有限数');
  const F = interpolateAt(v, grid.xs, grid.cdf);
  const f = Math.max(interpolateAt(v, grid.xs, grid.pdf), PDF_FLOOR);
  return v - (1 - F) / f;
}

/** 网格上的原始虚拟价值曲线 φ(xⱼ)（铁化输入 / 单调性检查用） */
export function virtualValueCurve(grid: DistributionGrid): number[] {
  const phi: number[] = [];
  for (let j = 0; j < grid.xs.length; j += 1) {
    const f = Math.max(grid.pdf[j], PDF_FLOOR);
    phi.push(grid.xs[j] - (1 - grid.cdf[j]) / f);
  }
  return phi;
}

/**
 * 加权保序回归（池相邻违例 PAVA）：最小化 Σwⱼ(φⱼ−gⱼ)² s.t. g 单调不减。
 * 返回拟合值与常数块的起止下标。合并条件取严格 >（保证输出单调不减），
 * 合并守恒 Σw·φ（质量守恒锚点的来源）。
 */
function weightedIsotonic(
  values: readonly number[],
  weights: readonly number[],
): { fitted: number[]; starts: number[]; ends: number[] } {
  const n = values.length;
  const fitted = new Array<number>(n).fill(0);
  const blockSum: number[] = [];
  const blockWeight: number[] = [];
  const blockStart: number[] = [];
  const blockEnd: number[] = [];
  for (let j = 0; j < n; j += 1) {
    blockSum.push(values[j] * weights[j]);
    blockWeight.push(weights[j]);
    blockStart.push(j);
    blockEnd.push(j);
    while (blockWeight.length >= 2) {
      const k = blockWeight.length;
      const prev = blockSum[k - 2] / blockWeight[k - 2];
      const curr = blockSum[k - 1] / blockWeight[k - 1];
      if (prev > curr) {
        blockSum[k - 2] += blockSum[k - 1];
        blockWeight[k - 2] += blockWeight[k - 1];
        blockEnd[k - 2] = blockEnd[k - 1];
        blockSum.pop();
        blockWeight.pop();
        blockStart.pop();
        blockEnd.pop();
      } else break;
    }
  }
  for (let b = 0; b < blockWeight.length; b += 1) {
    const avg = blockSum[b] / blockWeight[b];
    for (let j = blockStart[b]; j <= blockEnd[b]; j += 1) fitted[j] = avg;
  }
  return { fitted, starts: blockStart, ends: blockEnd };
}

/** 铁化曲线缓存（同一网格对象只做一次 PAVA；网格不可变是缓存前提） */
const ironCache = new WeakMap<DistributionGrid, IronedVirtualCurve>();

/**
 * 铁化（ironing）：接受网格或原始样本（样本先经 empiricalGrid 网格化）。
 *
 * 对 φ 在 F 测度下做加权保序回归（权重 = 格点 F 质量），非单调区间被
 * 池化为常数（池均值）——等价于取 Φ(z) = ∫₀ᶻφ dF 凸包的导数。输出 φ̄
 * 单调不减、保持 ∫φ̄ dF = ∫φ dF。raw 已单调时原样返回（pools 空）。
 */
export function ironVirtualValues(source: DistributionGrid | readonly number[]): IronedVirtualCurve {
  let grid: DistributionGrid;
  let fresh = false;
  if ('xs' in source) grid = source;
  else {
    grid = empiricalGrid(source);
    fresh = true;
  }
  const cached = fresh ? undefined : ironCache.get(grid);
  if (cached !== undefined) return cached;

  const xs = grid.xs;
  const phi = virtualValueCurve(grid);
  const weights: number[] = [];
  for (let j = 0; j < xs.length; j += 1) {
    const width = j === 0 ? xs[1] - xs[0] : j === xs.length - 1 ? xs[j] - xs[j - 1] : (xs[j + 1] - xs[j - 1]) / 2;
    weights.push(Math.max(grid.pdf[j], PDF_FLOOR) * width);
  }
  const { fitted, starts, ends } = weightedIsotonic(phi, weights);

  let rawMonotone = true;
  let worstDrop = 0;
  for (let j = 1; j < phi.length; j += 1) {
    const drop = phi[j - 1] - phi[j];
    if (drop > worstDrop) worstDrop = drop;
    if (drop > MONOTONE_TOL) rawMonotone = false;
  }

  const pools: IronPool[] = [];
  for (let b = 0; b < starts.length; b += 1) {
    if (ends[b] > starts[b]) {
      pools.push({ lo: xs[starts[b]], hi: xs[ends[b]], value: fitted[starts[b]] });
    }
  }

  const curve: IronedVirtualCurve = {
    xs: [...xs],
    phi,
    ironed: fitted,
    weights,
    rawMonotone,
    pools,
  };
  if (!fresh) ironCache.set(grid, curve);
  return curve;
}

/** 铁化曲线在 v 处的取值 φ̄(v)（分段线性插值，单调） */
function ironedAt(v: number, curve: IronedVirtualCurve): number {
  return interpolateAt(v, curve.xs, curve.ironed);
}

// ─────────────────────────── Myerson 最优拍卖 ───────────────────────────

/**
 * Myerson 保留价 r = φ̄⁻¹(0)：最小估值使其（铁化）虚拟价值非负。
 * 均匀 [0,1] → r = 1/2。铁化曲线整体为负（分布无正虚拟价值区间）时
 * 返回 Infinity——诚实语义：任何保留价下卖方都不应出售。
 */
export function myersonReserve(grid: DistributionGrid): number {
  const curve = ironVirtualValues(grid);
  const last = curve.ironed[curve.ironed.length - 1];
  if (!(last >= 0)) return Infinity;
  return inverseMonotone(0, curve.xs, curve.ironed);
}

/**
 * Myerson 最优拍卖（单物品、iid F、密封报价、DSIC）：
 * 1) 对每个报价取铁化虚拟价值 φ̄(vᵢ)；
 * 2) 最高非负 φ̄ 者获胜（并列取最小下标，确定性）；
 * 3) 支付 = 临界报价 φ̄⁻¹(max(0, 第二高 φ̄))——正则单调情形即
 *    max(保留价, 第二高真实报价)，与带保留价的二价拍卖逐字等价。
 * 报价必须落在网格值域内（越域即 throw——φ 在域外无定义）。
 */
export function myersonAuction(values: readonly number[], grid: DistributionGrid): MyersonOutcome {
  if (values.length < 1) throw new Error('myersonAuction: 至少 1 个报价');
  const lo = grid.xs[0];
  const hi = grid.xs[grid.xs.length - 1];
  const clamped: number[] = [];
  for (const v of values) {
    if (!Number.isFinite(v)) throw new Error('myersonAuction: 报价含非有限值');
    if (v < 0) throw new Error('myersonAuction: 报价必须 ≥ 0');
    if (v < lo - 1e-9 || v > hi + 1e-9) {
      throw new Error(`myersonAuction: 报价 ${v} 超出分布网格值域 [${lo}, ${hi}]`);
    }
    clamped.push(Math.min(Math.max(v, lo), hi));
  }

  const curve = ironVirtualValues(grid);
  const reserve = myersonReserve(grid);
  const virtuals = clamped.map((v) => ironedAt(v, curve));
  const rawVirtuals = clamped.map((v) => interpolateAt(v, curve.xs, curve.phi));

  // 最高非负虚拟价值者获胜（严格 > 保证并列取最小下标）
  let winner = -1;
  let best = -Infinity;
  for (let i = 0; i < virtuals.length; i += 1) {
    if (virtuals[i] > best) {
      best = virtuals[i];
      winner = i;
    }
  }
  const sold = winner >= 0 && best >= 0;

  if (!sold) {
    return {
      winner: -1,
      payment: 0,
      revenue: 0,
      sold: false,
      reserve,
      virtuals,
      rawVirtuals,
      ironed: !curve.rawMonotone,
    };
  }

  let second = -Infinity;
  for (let i = 0; i < virtuals.length; i += 1) {
    if (i !== winner && virtuals[i] > second) second = virtuals[i];
  }
  const threshold = Math.max(0, second);
  const payment = inverseMonotone(threshold, curve.xs, curve.ironed);
  return {
    winner,
    payment,
    revenue: payment,
    sold: true,
    reserve,
    virtuals,
    rawVirtuals,
    ironed: !curve.rawMonotone,
  };
}

// ─────────────────────────── 二价拍卖（对照） ───────────────────────────

/**
 * 无保留价二价拍卖（对照基线）：最高报价者获胜、付第二高报价。
 * 均匀 [0,1] iid 下期望收入 = E[V₍₂₍] = 1/3（n=2），低于 Myerson 的 5/12。
 */
export function secondPrice(values: readonly number[]): { winner: number; payment: number; revenue: number } {
  if (values.length < 1) throw new Error('secondPrice: 至少 1 个报价');
  for (const v of values) {
    if (!Number.isFinite(v)) throw new Error('secondPrice: 报价含非有限值');
    if (v < 0) throw new Error('secondPrice: 报价必须 ≥ 0');
  }
  let winner = 0;
  for (let i = 1; i < values.length; i += 1) if (values[i] > values[winner]) winner = i;
  let payment = 0;
  for (let i = 0; i < values.length; i += 1) if (i !== winner && values[i] > payment) payment = values[i];
  return { winner, payment, revenue: payment };
}

// ─────────────────────────── VCG 组合拍卖 ───────────────────────────

/**
 * VCG 机制（加性估值组合单轮）：bids[i][g] = agent i 对物品 g 的估值。
 *
 * 分配：每件物品独立归最高估值者（加性下即全局福利最优），并列取最小
 * 下标（确定性）。定价：Clarke 外部性 payᵢ = W*₋ᵢ − W₋ᵢ(a*)；加性情形
 * 精确等于「所赢物品各自第二高价之和」（单物品 2 人退化为 Vickrey 二价）。
 * 性质：DSIC + IR + 福利最优；收入 ≥ 0 但非预算平衡
 * （Myerson–Satterthwaite 不可能性定理的诚实呈现）。
 */
export function vcgAllocate(input: VcgAuctionInput): VcgOutcome {
  const bids = input.bids;
  if (bids.length < 1) throw new Error('vcgAllocate: 至少 1 个 agent');
  const goods = input.goods ?? bids[0].length;
  if (!Number.isInteger(goods) || goods < 1) throw new Error('vcgAllocate: goods 必须为 ≥1 的整数');
  for (const row of bids) {
    if (row.length !== goods) throw new Error('vcgAllocate: bids 每行宽度必须等于 goods');
    for (const b of row) {
      if (!Number.isFinite(b)) throw new Error('vcgAllocate: 估值含非有限值');
      if (b < 0) throw new Error('vcgAllocate: 估值必须 ≥ 0');
    }
  }

  const agents = bids.length;
  const assignment = new Array<number>(goods).fill(0);
  const perGoodSecondPrice = new Array<number>(goods).fill(0);
  for (let g = 0; g < goods; g += 1) {
    let winner = 0;
    let top = bids[0][g];
    let second = 0;
    for (let i = 1; i < agents; i += 1) {
      const b = bids[i][g];
      if (b > top) {
        second = top;
        top = b;
        winner = i;
      } else if (b > second) {
        second = b;
      }
    }
    assignment[g] = winner;
    perGoodSecondPrice[g] = second; // n=1 时恒 0（无外部性 → 免费）
  }

  const allocatedGoods: number[][] = Array.from({ length: agents }, () => []);
  const payments = new Array<number>(agents).fill(0);
  const wonValue = new Array<number>(agents).fill(0);
  for (let g = 0; g < goods; g += 1) {
    const w = assignment[g];
    allocatedGoods[w].push(g);
    wonValue[w] += bids[w][g];
    payments[w] += perGoodSecondPrice[g]; // 加性 VCG = 逐物品二价之和
  }

  let welfare = 0;
  let revenue = 0;
  for (let i = 0; i < agents; i += 1) {
    welfare += wonValue[i];
    revenue += payments[i];
  }
  const utilities = payments.map((p, i) => wonValue[i] - p);

  return { assignment, allocatedGoods, payments, utilities, welfare, revenue, perGoodSecondPrice };
}

// ─────────────────────────── R5 进化: 组合拍卖赢家确定（一般估值 + VCG 定价） ───────────────────────────

/** 捆绑投标: agent 愿付 value 换**恰好** items 这束物品（XOR 口径: 每 agent 至多中一标）*/
export interface BundleBid {
  /** 投标方下标 ∈ [0, agents) */
  readonly agent: number;
  /** 捆绑的物品下标（非空、升序、不重复、∈ [0, items)）*/
  readonly items: readonly number[];
  /** 对该捆绑的报价（有限、≥ 0）*/
  readonly value: number;
}

export interface CombinatorialAuctionInput {
  readonly bids: ReadonlyArray<BundleBid>;
  /** agent 总数（≥ bids 中的最大 agent+1; 支付向量的长度）*/
  readonly agents: number;
  /** 物品数（缺省按 items 推断）*/
  readonly items?: number;
}

/** 组合拍卖 VCG 结果（赢家确定精确解 + Clarke 外部性支付）*/
export interface CombinatorialOutcome {
  /** 中标 bid 下标（升序）*/
  readonly winningBids: number[];
  /** agent → 赢得的物品（未中标 = 空表）*/
  readonly allocation: number[][];
  /** 社会福利 = Σ 中标报价（可行最优——精确解）*/
  readonly welfare: number;
  /** VCG 支付 payᵢ = W*₋ᵢ − W₋ᵢ(a*)（未中标者恒 0）*/
  readonly payments: number[];
  /** 诚实报价效用 = 自身中标报价 − 支付（IR 的可观测面，≥ 0）*/
  readonly utilities: number[];
  /** 收入 = Σ payments（≥ 0）*/
  readonly revenue: number;
  /** 每个 agent 的 W*₋ᵢ（剔除该 agent 全部投标后的最优社会福利）*/
  readonly welfareWithout: number[];
  /** 赢家确定（含 n+1 次 WDP 重解）的分支定界探索节点总数（审计）*/
  readonly nodes: number;
}

/** 赢家确定护栏: 物品 ≤ 20（位掩码 2²⁰）、投标 ≤ 32（分支定界务实上界）*/
export const CA_MAX_ITEMS = 20;
export const CA_MAX_BIDS = 32;

interface WdpSolution {
  chosen: number[];
  value: number;
  nodes: number;
}

/**
 * 精确赢家确定（最大权集合打包）: 分支定界 DFS。
 *
 * 语义: 按 bid 输入序逐标决策 take/skip; take 需捆绑不交、agent 未中过标
 * （XOR）。**take 分支先行** ⟹ DFS 叶序 = 中标指示向量 (b₀,…,b_{m−1})
 * 按输入序的字典序降序（优先保留更早的标）⟹ 只在严格改进时更新 ⟹ 输出
 * = 最大社会福利中「指示向量字典序最大」的那个 argmax——确定性平局
 * 规则，与 2^m 暴力同规则枚举（按同一字典序扫描 + 严格改进）**逐一等价**。
 *
 * 剪枝: 剩余上界 = Σ 后续「看似可行」标（agent 未中、捆绑与已用物品不交）
 * 的报价——任何可行完成都是其子集，上界有效; value + bound ≤ best 即剪。
 * excludedAgent ≥ 0 时剔除该 agent 的全部投标（VCG 的 W*₋ᵢ 重解口径）。
 */
function solveWinnerDetermination(
  bids: ReadonlyArray<BundleBid>,
  nItems: number,
  excludedAgent: number,
): WdpSolution {
  const m = bids.length;
  const itemMasks = bids.map((b) => {
    let mask = 0;
    for (const it of b.items) mask |= 1 << it;
    return mask;
  });
  // 代理位重映射: agent 下标可能 ≥ 32（JS 位移按 32 取模会位冲突——
  // agent 40 与 agent 8 撞位），按投标首现序压缩到 [0, 32) 紧凑位。
  // 重映射保持「同一 agent」等价关系 ⟹ 搜索路径与结果对 agent < 32 逐位一致。
  const agentBits = new Map<number, number>();
  for (const b of bids) if (!agentBits.has(b.agent)) agentBits.set(b.agent, 1 << agentBits.size);
  const bidAgentMasks = bids.map((b) => agentBits.get(b.agent)!);
  const blocked = bids.map((b) => b.agent === excludedAgent);
  let bestValue = -1;
  let bestChosen: number[] = [];
  let nodes = 0;
  const chosen: number[] = [];
  const rec = (k: number, usedItems: number, usedAgents: number, value: number): void => {
    nodes += 1;
    if (k === m) {
      if (value > bestValue) {
        bestValue = value;
        bestChosen = [...chosen];
      }
      return;
    }
    // 上界: 后续可行标的报价总和（任何可行完成是其子集）
    let bound = 0;
    for (let j = k; j < m; j += 1) {
      if (blocked[j]) continue;
      if ((usedAgents & bidAgentMasks[j]) !== 0) continue;
      if ((itemMasks[j] & usedItems) !== 0) continue;
      bound += bids[j].value;
    }
    if (value + bound <= bestValue) return; // 无法严格改进 → 剪枝
    const bid = bids[k];
    const canTake =
      !blocked[k] &&
      (usedAgents & bidAgentMasks[k]) === 0 &&
      (itemMasks[k] & usedItems) === 0 &&
      (itemMasks[k] & ((1 << nItems) - 1)) === itemMasks[k]; // 物品越界防护（掩码截断）
    if (canTake) {
      chosen.push(k);
      rec(k + 1, usedItems | itemMasks[k], usedAgents | bidAgentMasks[k], value + bid.value);
      chosen.pop();
    }
    rec(k + 1, usedItems, usedAgents, value);
  };
  rec(0, 0, 0, 0);
  return { chosen: bestChosen, value: Math.max(0, bestValue), nodes };
}

/**
 * 组合拍卖 VCG（一般捆绑估值、XOR、单轮、精确赢家确定 + Clarke 定价）。
 *
 * 分配: 最大社会福利的可行打包（集合打包的精确解）; 定价: payᵢ =
 * W*₋ᵢ − W₋ᵢ(a*)——i 的外部性 = 其在场使他人福利减少的量。性质: DSIC +
 * IR + 福利最优（一般估值下的 VCG 定理，加性退化 = vcgAllocate）。
 * 护栏: 物品 ≤ 20、投标 ≤ 32（NP-hard 内核的务实规模）。
 */
export function combinatorialVcg(input: CombinatorialAuctionInput): CombinatorialOutcome {
  const bids = input.bids;
  if (!Number.isInteger(input.agents) || input.agents < 1) {
    throw new Error(`combinatorialVcg: agents 必须是 ≥1 的整数（收到 ${String(input.agents)}）`);
  }
  if (bids.length > CA_MAX_BIDS) {
    throw new Error(`combinatorialVcg: 投标数 ${bids.length} > ${CA_MAX_BIDS}（赢家确定护栏）`);
  }
  let nItems = input.items ?? 0;
  for (let k = 0; k < bids.length; k += 1) {
    const b = bids[k];
    if (b === null || typeof b !== 'object') throw new Error(`combinatorialVcg: 第 ${k} 标必须是对象`);
    if (!Number.isInteger(b.agent) || b.agent < 0 || b.agent >= input.agents) {
      throw new Error(`combinatorialVcg: 第 ${k} 标 agent=${String(b.agent)} 越界 [0, ${input.agents})`);
    }
    if (!Array.isArray(b.items) || b.items.length === 0) {
      throw new Error(`combinatorialVcg: 第 ${k} 标的捆绑必须非空`);
    }
    for (let t = 0; t < b.items.length; t += 1) {
      const it = b.items[t];
      if (!Number.isInteger(it) || it < 0 || it > CA_MAX_ITEMS - 1) {
        throw new Error(`combinatorialVcg: 第 ${k} 标物品下标 ${String(it)} 越界 [0, ${CA_MAX_ITEMS})`);
      }
      if (t > 0 && !(it > b.items[t - 1])) {
        throw new Error(`combinatorialVcg: 第 ${k} 标的捆绑必须严格升序去重`);
      }
      if (it + 1 > nItems) nItems = it + 1;
    }
    if (!Number.isFinite(b.value) || b.value < 0) {
      throw new Error(`combinatorialVcg: 第 ${k} 标报价必须有限 ≥ 0（收到 ${String(b.value)}）`);
    }
  }

  const opt = solveWinnerDetermination(bids, nItems, -1);
  const welfare = opt.value;
  const welfareWithout: number[] = [];
  let nodes = opt.nodes;
  for (let i = 0; i < input.agents; i += 1) {
    const without = solveWinnerDetermination(bids, nItems, i);
    welfareWithout.push(without.value);
    nodes += without.nodes;
  }
  const allocation: number[][] = Array.from({ length: input.agents }, () => []);
  const wonValue = new Array<number>(input.agents).fill(0);
  const winnerOf: number[] = new Array<number>(input.agents).fill(-1);
  for (const k of opt.chosen) {
    const b = bids[k];
    for (const it of b.items) allocation[b.agent].push(it);
    wonValue[b.agent] += b.value;
    winnerOf[b.agent] = k;
  }
  const payments = welfareWithout.map((wMinus, i) => wMinus - (welfare - wonValue[i]));
  const utilities = payments.map((p, i) => wonValue[i] - p);
  let revenue = 0;
  for (const p of payments) revenue += p;
  return {
    winningBids: [...opt.chosen].sort((a, b) => a - b),
    allocation,
    welfare,
    payments,
    utilities,
    revenue,
    welfareWithout,
    nodes,
  };
}

/* ── 接线建议 ──
 * 1. 建议挂载引擎: src/symbiosis/market.ts 认知市场（连续双向拍卖）——
 *    本内核是它的「激励相容」理论核：
 *    a) 知识/算力费率定价：卖方挂单 ask 的底价从拍脑袋费率表 →
 *       myersonReserve(历史成交价经验分布)，把「喊价=真话」变成占优策略；
 *    b) 多买方竞争同一知识资产时，从「先到先得价格交叉」→ 单轮
 *       vcgAllocate 出清（支付=外部性=第二高边际估值），收入入央行国库
 *       （预算不平衡是 DSIC 的数学代价，由国库吸收而非说谎者套利）；
 *    c) 多物品版税分配预演：VCG 事前定价 + Shapley 16.0 事后分账互补
 *       （VCG 管「卖多少钱」，Shapley 管「贡献者怎么分」）。
 * 2. 缺省关闭旗标名: SymbiosisBridgeConfig 新增
 *    `mechanismDesign?: { enabled?: boolean }`（缺省 false，与 futarchy
 *    旗标同款——影子计算，不改变主链路）。
 * 3. 挂载后改变的决策点：
 *    - market.ts 的 ask 下限与成交清算价 → myersonReserve / VCG 外部性价；
 *    - 挂单费 burn 额度可与 Myerson 收入合并记账（防垃圾与防谎报分层）；
 *    - 未启用时市场行为与本内核加入前逐位一致（零漂移）。
 */
