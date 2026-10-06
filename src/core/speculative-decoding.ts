/**
 * speculative-decoding.ts — 51.0 投机解码内核（快模型打草稿、强模型批量校验的期望收益闭式）
 *
 * 动机（升级前的根本局限）:
 * - 「多模型并行执行」目前的配对是拍脑袋的: 「小模型快、大模型强，
 *   那就一起上」——但快模型给强模型打草稿到底划不划算，取决于三个
 *   量的博弈: 逐 token 接受率 γ、草稿/校验成本比 r=c_d/c_v、草稿深度
 *   k。现有系统对三者没有任何闭式口径，「并行」只是并排，不是投机；
 * - 草稿深度 k 是魔数（「打 4 个 token 试试」）: k 太浅吃不满批量
 *   校验的红利，k 太深把省下的时间又花在被拒绝的草稿上——最优 k*
 *   有精确的一阶边际条件，但从没被求解过；
 * - 低接受率的配对在投机通道上「越跑越亏」而系统不自知: 缺一条
 *   「γ 低于临界值就诚实退回直通」的判退线。
 *
 * 数学（draft-verify-accept；Leviathan–Kalman–Matias 2023 / Chen et al.
 * 2023 谱系的期望收益闭式，独立接受近似口径）:
 *
 *   每轮流程: 草稿模型自回归打 k 个 token（成本 k·c_d）→ 验证器一次
 *   前向批量校验 k+1 个位置（k 个草稿 + 1 个续写），从首个分歧点
 *   截断，输出「被接受的草稿 + 1 个验证器自己的 token」。
 *
 *   期望产出: 逐 token 接受率 γ（独立近似）下
 *     N(k,γ) = Σ_{i=0}^{k−1} (i+1)·γ^i·(1−γ) + (k+1)·γ^k
 *            = (1−γ^{k+1})/(1−γ)        （γ=1 取极限 k+1；γ=0 恒 1）
 *
 *   每轮耗时（c_v 归一化）: t(k) = r·k + (k+1)/B，r = c_d/c_v，B 为
 *   验证批加速。规范口径 B=k+1（完美批处理: k+1 个位置的一次前向计
 *   一次 c_v）⇒ t(k) = 1 + r·k，加速比
 *     S(k) = N(k,γ)·c_v / t(k) = N(k,γ)/(1+r·k)
 *   即相对「验证器逐 token 直通」（每 token 恰好一次 c_v）的墙钟比。
 *
 *   最优深度: k→k+1 的边际增长条件（与 S(k+1)≥S(k) 代数等价）
 *     γ^{k+1}·(1+r·k) ≥ r·N(k)
 *   左端可化为 γ^{k+1}·(A+r·k) − (A−1)（A = 1+r/(1−γ)），几何×线性
 *   ⇒ 关于 k 严格递减（γ∈(0,1)）⇒ S(k) 单峰、k* 唯一，扫描首次非正
 *   即停即精确 argmax（非近似）。k*=0 的判退闭式: γ ≤ r ⇔ 一切 k≥1
 *   都 S≤1——因为 N(k,γ)=Σ_{i=0}^{k}γ^i ≤ 1+kγ ≤ 1+rk（γ^i≤γ）:
 *   接受率跑不赢成本比，直通更廉。
 *
 *   临界接受率（break-even）: S(γ,k)=1 ⇔ γ^{k+1} − (1+rk)·γ + rk = 0
 *   在 (0,1) 内唯一根（h(γ)=N(k,γ)−(1+rk) 关于 γ 严格递增，二分精确）；
 *   k=1 退化为 γ_be = r 精确；γ_be 随 k 严格递增（在 γ_be(k) 处必有
 *   γ^{k+1}<r ⇒ 更深的草稿需要更高的接受率才回本）。
 *
 *   上界与诚实边界: N ≤ k+1 ⇒ S ≤ (k+1)/(1+rk)，γ=1 取等（锚点⑤）；
 *   r→0 时上界→k+1 且 k* 增大（锚点③）；γ<γ_be 时 S<1（锚点④）——
 *   投机不是免费午餐: 即使草稿免费（r=0），γ<1 时 S→1/(1−γ) 封顶。
 *
 * ── R5 进化(第五轮, 2026-10) ──────────────────────────────────────────────
 * A1【数学】树投机（多分支草稿）的期望收益闭式——层并行束式口径:
 *   每层草稿模型并行提出 b 个候选 token（全 b 叉树塌缩为「每层 b 路」的
 *   束阶梯; 全树最长接受路径是 Galton–Watson 分支过程、无简单闭式——
 *   本内核不假装它有, 诚实改用层并行模型）, 验证器一次批量校验 k·b+1 个
 *   位置, 任一候选被接受即推进一层、全拒截断 + 1 修正 token:
 *     q := 1−(1−γ)^b        （层推进概率 = b 次独立接受至少一中——分支并行接受率）
 *     N_beam(k,b,γ) = 1 + Σ_{i=1..k} q^i = 1 + q(1−q^k)/(1−q)
 *   —— b=1 精确退化为链闭式 N(k,γ) = (1−γ^{k+1})/(1−γ)（q=γ 恒等代入,
 *   逐位一致）; 成本 D(k,b) = b·k（b=1 ⟹ k）, t = 1 + r·b·k,
 *   S_beam = N_beam/t; 上界定理: N_beam ≤ k+1 ⟹ S_beam ≤ (k+1)/(1+rbk) ≤ k+1。
 *   判退闭式扩展: γ ≤ r ⟹ q ≤ bγ ⟹ N_beam ≤ 1 + kq ≤ 1 + rbk ⟹ 一切 (k,b) S≤1。
 *   最优 (k*, b*) 网格精确 argmax; r 大 ⟹ b*=1, γ 低 ⟹ 分支回收接受率
 *   （q 的边际增益在 γ 小处最陡）——「快模型多候选换强模型一步批量校验」
 *   的经济裁决第一次有了闭式。
 * A3【数值稳健】q = −expm1(b·log1p(−γ)) 消 γ→1 的灾难性消去; q^k 用
 *   −expm1(k·ln q); b=1 直接走链闭式（已是 log1p/expm1 口径）。
 * A4【性质】加速上界（k+1）: ≥200 种子化 (γ,k,r,b) 网格上 S_beam ≤
 *   (k+1)/(1+rbk) 且 ≤ k+1 恒成立; 判退域 γ≤r 全网格 S≤1（验证脚本）。
 *
 * 验证锚点:
 *   ① N(0.5, 4) = 31/16 = 1.9375（手算逐项对照）;
 *   ② k* 关于 γ 单调不减（接受率越高草稿越深）;
 *   ③ costRatio→0 时 k* 增大（触顶如实标记 capped）、加速上界→k+1;
 *   ④ γ 低于 break-even 时 S<1，γ≤r 时一切 k 判退（诚实退回直通）;
 *   ⑤ S(γ=1) = (k+1)/(1+r·k) 闭式对照;
 *   ⑥ 确定性仿真（文件内 mulberry32）大数定律对照闭式 N(k,γ)。
 *
 * 与 19.0 最优停止（行动时机的价格）、22.0 BwK（token 预算的影子价
 * 格）、25.0 容量规划（墙钟成本的排队口径）同一血脉: 把「拍脑袋的
 * 魔数」换成闭式；与 50.0 矩阵补全互补: 50.0 回答「哪两个模型该配
 * 对」（能力画像），本内核回答「配对之后投机通道划不划算、草稿打
 * 多深」（经济裁决）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 核心闭式 ───────────────────────────

/**
 * 每轮期望产出 token 数 N(k,γ) = (1−γ^{k+1})/(1−γ)。
 *
 * 接受前 i 个草稿（i=0..k−1）+ 验证器 1 个修正 token，或全接受时
 * k+1 个。γ=1 取极限 k+1；γ=0 恒为 1（首轮即拒，只剩修正 token）。
 * 数值口径用 log1p/expm1 消除 γ→1 的灾难性消去。
 *
 * @param gamma 逐 token 接受率 γ ∈ [0,1]（独立近似）
 * @param k 草稿深度（非负整数；k=0 即不投机）
 */
export function expectedTokensPerRound(gamma: number, k: number): number {
  if (!Number.isFinite(gamma) || gamma < 0 || gamma > 1) {
    throw new Error('expectedTokensPerRound: γ ∈ [0,1]');
  }
  if (!Number.isInteger(k) || k < 0) {
    throw new Error('expectedTokensPerRound: k 为非负整数');
  }
  if (gamma === 1) return k + 1;
  if (gamma === 0) return 1;
  const u = -Math.log1p(gamma - 1); // u = −ln γ > 0（Sterbenz 精确）
  return Math.expm1(-(k + 1) * u) / Math.expm1(-u);
}

/**
 * 每轮耗时（c_v 归一化）: t(k) = r·k + (k+1)/B。
 *
 * batchSpeedup 缺省 = k+1（完美批处理: 验证器对 k+1 个位置的一次前向
 * 计一次 c_v）⇒ t(k) = 1 + r·k——本内核规范口径。
 *
 * @param k 草稿深度（非负整数）
 * @param costRatio r = c_d/c_v ≥ 0（草稿/验证器单 token 成本比）
 * @param batchSpeedup B > 0（验证批加速；缺省 k+1）
 */
export function roundCost(k: number, costRatio: number, batchSpeedup?: number): number {
  if (!Number.isInteger(k) || k < 0) {
    throw new Error('roundCost: k 为非负整数');
  }
  if (!Number.isFinite(costRatio) || costRatio < 0) {
    throw new Error('roundCost: costRatio ≥ 0');
  }
  const b = batchSpeedup === undefined ? k + 1 : batchSpeedup;
  if (!Number.isFinite(b) || b <= 0) {
    throw new Error('roundCost: batchSpeedup > 0');
  }
  return costRatio * k + (k + 1) / b;
}

/**
 * 加速比 S(k) = N(k,γ)/t(k)——相对「验证器逐 token 直通」的墙钟比。
 *
 * γ=1 时 S = (k+1)/(1+r·k)（验证锚点⑤）；S 关于 γ 严格递增
 * （N 递增、t 与 γ 无关）⇒ 固定 (k,r) 的上界恰在 γ=1。
 *
 * @param gamma 接受率 γ ∈ [0,1]
 * @param k 草稿深度（k=0 时 S≡1——直通基线）
 * @param costRatio r = c_d/c_v ≥ 0
 * @param batchSpeedup 验证批加速 B（缺省 k+1，规范口径）
 */
export function speedup(gamma: number, k: number, costRatio: number, batchSpeedup?: number): number {
  return expectedTokensPerRound(gamma, k) / roundCost(k, costRatio, batchSpeedup);
}

// ─────────────────────────── 最优草稿深度 ───────────────────────────

/** 最优草稿深度求解选项 */
export interface OptimalDraftOptions {
  /** 扫描上限（缺省 64；γ→1 或 r→0 时真最优可能更深，capped 如实标记） */
  maxK?: number;
}

/** 最优草稿深度裁决 */
export interface OptimalDraftResult {
  /** 最优草稿深度 k*（0 = 不投机，直通验证器） */
  k: number;
  /** k* 处每轮期望产出 N(k*,γ) */
  tokensPerRound: number;
  /** k* 处加速比 S(k*,γ,r)（k=0 时恒 1——直通基线） */
  speedup: number;
  /** k* 是否触到扫描上限（真最优可能在更深处——诚实标记而非假装收敛） */
  capped: boolean;
  /** S(k*) > 1: 投机通道值得启用（否则诚实判退） */
  worthwhile: boolean;
  /** 判退闭式是否命中: γ ≤ r ⇔ 一切 k≥1 都 S≤1 */
  rejectedByGammaFloor: boolean;
  interpretation: string;
}

/**
 * 最优草稿长度 k* = argmax_{k≥0} S(k)（精确整数解）。
 *
 * 单峰定理: 边际增长条件 γ^{k+1}(1+rk) ≥ r·N(k) 的左端减右端可化为
 * γ^{k+1}(A+rk) − (A−1)（A=1+r/(1−γ)），几何衰减×线性增长 ⇒ 关于 k
 * 严格递减（γ∈(0,1)）⇒ S(k) 单峰，扫描首次非正即停在唯一峰顶。
 * 边界: γ=1 时条件退化为常数 1−r（r<1 ⇒ k*=maxK，capped）；γ=0 时
 * 恒负 ⇒ k*=0。判退闭式: γ ≤ r ⇒ k*=0。
 *
 * @param gamma 接受率 γ ∈ [0,1]
 * @param costRatio r = c_d/c_v ≥ 0
 */
export function optimalDraftLength(gamma: number, costRatio: number, options?: OptimalDraftOptions): OptimalDraftResult {
  if (!Number.isFinite(gamma) || gamma < 0 || gamma > 1) {
    throw new Error('optimalDraftLength: γ ∈ [0,1]');
  }
  if (!Number.isFinite(costRatio) || costRatio < 0) {
    throw new Error('optimalDraftLength: costRatio ≥ 0');
  }
  const maxK = options?.maxK ?? 64;
  if (!Number.isInteger(maxK) || maxK < 1) {
    throw new Error('optimalDraftLength: maxK 为 ≥1 整数');
  }
  const marginal = (j: number): number =>
    Math.pow(gamma, j + 1) * (1 + costRatio * j) - costRatio * expectedTokensPerRound(gamma, j);
  let k = 0;
  while (k < maxK && marginal(k) > 1e-12) k += 1;
  const capped = k === maxK && marginal(maxK) > 1e-12;
  const tokens = expectedTokensPerRound(gamma, k);
  const s = tokens / (1 + costRatio * k); // t(0)=1 ⇒ k=0 时 S≡1
  const worthwhile = s > 1 + 1e-9;
  const rejectedByGammaFloor = gamma <= costRatio;
  const be = breakEvenGamma(costRatio, k >= 1 ? k : 1);
  const interpretation = worthwhile
    ? `采纳: k*=${k}，每轮期望 ${round(tokens)} token，加速 ${round(s)}×（γ=${round(gamma)} > 临界 γ_be=${round(be)}）——快模型打 ${k} 个草稿、强模型一次批量校验`
    : `判退: γ=${round(gamma)} ≤ r=${round(costRatio)}（临界接受率），一切草稿深度 S≤1——直通验证器更廉，不投机`;
  return {
    k,
    tokensPerRound: round(tokens),
    speedup: round(s),
    capped,
    worthwhile,
    rejectedByGammaFloor,
    interpretation,
  };
}

// ─────────────────────────── 临界接受率 ───────────────────────────

/**
 * 临界接受率 γ_be: 使 S(γ,k)=1 的最小 γ（低于它投机亏本）。
 *
 * h(γ) = N(k,γ) − (1+rk) 关于 γ 严格递增、h(0)=−rk<0、h(1⁻)=k(1−r)>0
 * （r<1）⇒ (0,1) 内唯一根，二分至 1e-14。k=1 退化为闭式 γ_be=r；
 * γ_be 随 k 严格递增。r≥1 → 1（草稿不比验证器廉，永不回本——诚实
 * 返回）；r=0 → 0（任何 γ 都不吃亏）。
 *
 * @param costRatio r = c_d/c_v ≥ 0
 * @param k 草稿深度（≥1 整数；k=0 无投机通道）
 */
export function breakEvenGamma(costRatio: number, k: number): number {
  if (!Number.isFinite(costRatio) || costRatio < 0) {
    throw new Error('breakEvenGamma: costRatio ≥ 0');
  }
  if (!Number.isInteger(k) || k < 1) {
    throw new Error('breakEvenGamma: k ≥ 1（k=0 无投机通道）');
  }
  if (costRatio === 0) return 0;
  if (costRatio >= 1) return 1;
  const target = 1 + costRatio * k;
  let lo = 0;
  let hi = 1;
  while (hi - lo > 1e-14) {
    const mid = (lo + hi) / 2;
    if (expectedTokensPerRound(mid, k) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ─────────────────── (R5-A1) 树投机：多分支草稿的期望收益闭式 ───────────────────

/**
 * 数学修正说明（诚实口径）: 全 b 叉树上「最长接受路径」的分布是 Galton–Watson
 * 分支过程（存活路径数 Z_{i+1} | Z_i=m ~ Bin(m·b, γ)）, P(Z_i ≥ 1) 无简单闭式
 * （路径共享边、事件相依）——本内核不假装它有。取而代之的是**层并行束式
 * 树投机**: 每层草稿模型并行提出 b 个候选 token（树被塌缩为「每层 b 路」的
 * 束阶梯）, 验证器一次批量校验, 任一候选被接受即推进一层, 全拒即截断。
 * 该模型的期望收益有**精确**闭式（层间独立、层内 b 次独立机会）:
 *   q := 1 − (1−γ)^b                    （层推进概率 = b 次独立接受至少一中）
 *   N_beam(k,b,γ) = 1 + Σ_{i=1..k} q^i = 1 + q(1−q^k)/(1−q)
 * b=1 逐位退化为链闭式 N(k,γ) = (1−γ^{k+1})/(1−γ)（q=γ 的恒等代入）——
 * 分支并行接受率理论是链理论的真推广（验证锚点）。
 */

/** 树投机求解选项 */
export interface TreeDraftOptions {
  /** 深度扫描上限（缺省 16——草稿成本 b·k 线性增长, 深度受限的现实口径） */
  maxK?: number;
  /** 每层分支数扫描上限（缺省 4） */
  maxB?: number;
}

/** 树投机裁决 */
export interface TreeDraftResult {
  /** 最优深度 k*（0 = 不投机） */
  k: number;
  /** 最优每层分支数 b*（k*=0 时记 1——链基线） */
  b: number;
  /** N_beam(k*, b*, γ) */
  tokensPerRound: number;
  /** S_beam(k*, b*, γ, r) */
  speedup: number;
  /** k* 处草稿 token 数 D(k*, b*) = b*·k*（成本口径） */
  draftTokens: number;
  /** S_beam > 1: 束式树投机通道值得启用 */
  worthwhile: boolean;
  /** (k*, b*) 是否触到扫描网格边界（真最优可能更深处——诚实标记） */
  cappedK: boolean;
  cappedB: boolean;
  interpretation: string;
}

/** 层推进概率 q = 1−(1−γ)^b（expm1/log1p 消 γ→1 的灾难性消去） */
function levelAdvanceProb(gamma: number, b: number): number {
  if (gamma <= 0) return 0;
  if (gamma >= 1) return 1;
  return -Math.expm1(b * Math.log1p(-gamma));
}

/**
 * (R5-A1) 束式树投机每轮期望产出 N_beam(k,b,γ) = 1 + q(1−q^k)/(1−q),
 * q = 1−(1−γ)^b。b=1 走链闭式 expectedTokensPerRound（恒等 + 数值稳健）;
 * γ∈{0,1} 边界与链一致（恒 1 / k+1）; q^k 用 −expm1(k·ln q) 稳定求值。
 */
export function expectedTokensTree(gamma: number, k: number, b: number): number {
  if (!Number.isFinite(gamma) || gamma < 0 || gamma > 1) {
    throw new Error('expectedTokensTree: γ ∈ [0,1]');
  }
  if (!Number.isInteger(k) || k < 0) {
    throw new Error('expectedTokensTree: k 为非负整数');
  }
  if (!Number.isInteger(b) || b < 1) {
    throw new Error('expectedTokensTree: b 为 ≥1 整数');
  }
  if (b === 1) return expectedTokensPerRound(gamma, k); // b=1 ≡ 链闭式
  if (k === 0) return 1;
  const q = levelAdvanceProb(gamma, b);
  if (q === 0) return 1;
  if (q >= 1) return k + 1;
  return 1 + (q * -Math.expm1(k * Math.log(q))) / (1 - q);
}

/**
 * (R5-A1) 束式树投机的草稿 token 数: 每层 b 个候选 × k 层 ⟹ D(k,b) = b·k
 * （b=1 ⟹ k, 与链口径一致）; 验证器对 k·b+1 个位置一次批量前向（c_v 计一次）。
 */
export function draftTokensTree(k: number, b: number): number {
  if (!Number.isInteger(k) || k < 0) {
    throw new Error('draftTokensTree: k 为非负整数');
  }
  if (!Number.isInteger(b) || b < 1) {
    throw new Error('draftTokensTree: b 为 ≥1 整数');
  }
  return k * b;
}

/**
 * (R5-A1) 束式树投机每轮耗时（c_v 归一化, 规范批口径）: t = 1 + r·b·k。
 */
export function roundCostTree(k: number, b: number, costRatio: number): number {
  if (!Number.isFinite(costRatio) || costRatio < 0) {
    throw new Error('roundCostTree: costRatio ≥ 0');
  }
  return 1 + costRatio * draftTokensTree(k, b);
}

/** (R5-A1) 束式树投机加速比 S_beam = N_beam / t —— 相对验证器逐 token 直通。 */
export function speedupTree(gamma: number, k: number, b: number, costRatio: number): number {
  return expectedTokensTree(gamma, k, b) / roundCostTree(k, b, costRatio);
}

/**
 * (R5-A1) 最优束式树投机 (k*, b*) = argmax_{k≤maxK, b≤maxB} S_beam(k,b)
 * （网格精确 argmax——(maxK+1)×maxB ≤ 17×4 个候选逐点直算, 无单峰性假设）。
 *
 * 与链版 optimalDraftLength 的对照由 b*=1 退化保证; 经济直觉的可计算化:
 * r 大（草稿贵）⟹ b*=1（每层 b 路的线性草稿成本覆盖不了推进概率的凹增益）;
 * γ 低 ⟹ 分支回收接受率（1−(1−γ)^b 的边际在 γ 小处最陡）。
 * 判退口径与链版一致: γ ≤ r ⟹ 一切 (k,b) 都 S_beam ≤ 1——逐项放大
 *   N_beam ≤ 1 + Σ_{i≥1} b·γ^i·? ⟹ 用 N_beam ≤ 1 + k·q ≤ 1 + k·b·γ ≤ 1 + r·b·k
 *   （q ≤ bγ 的 Bernoulli 联合界）⟹ S_beam ≤ (1+rbk)/(1+rbk) = 1。
 */
export function optimalTreeDraft(gamma: number, costRatio: number, options?: TreeDraftOptions): TreeDraftResult {
  if (!Number.isFinite(gamma) || gamma < 0 || gamma > 1) {
    throw new Error('optimalTreeDraft: γ ∈ [0,1]');
  }
  if (!Number.isFinite(costRatio) || costRatio < 0) {
    throw new Error('optimalTreeDraft: costRatio ≥ 0');
  }
  const maxK = options?.maxK ?? 16;
  const maxB = options?.maxB ?? 4;
  if (!Number.isInteger(maxK) || maxK < 1) throw new Error('optimalTreeDraft: maxK 为 ≥1 整数');
  if (!Number.isInteger(maxB) || maxB < 1) throw new Error('optimalTreeDraft: maxB 为 ≥1 整数');
  let bestK = 0;
  let bestB = 1;
  let bestS = speedupTree(gamma, 0, 1, costRatio); // k=0 基线: S≡1
  // 确定性扫描序: b 升序、k 升序, 严格大于才替换（同值保小 (k,b)——文档化 tie-break）
  for (let b = 1; b <= maxB; b += 1) {
    for (let k = 1; k <= maxK; k += 1) {
      const s = speedupTree(gamma, k, b, costRatio);
      if (s > bestS + 1e-12) {
        bestS = s;
        bestK = k;
        bestB = b;
      }
    }
  }
  const worthwhile = bestK > 0 && bestS > 1 + 1e-9;
  const tokens = expectedTokensTree(gamma, bestK, bestB);
  const draft = draftTokensTree(bestK, bestB);
  const cappedK = bestK === maxK;
  const cappedB = bestB === maxB;
  const interpretation = worthwhile
    ? `采纳: (k*,b*)=(${bestK},${bestB})，每轮期望 ${round(tokens)} token（草稿 ${draft} 个），加速 ${round(bestS)}×——${bestB > 1 ? `每层 ${bestB} 路候选回收低接受率` : '单链已最优（草稿贵，分支不值）'}`
    : `判退: γ=${round(gamma)} ≤ r=${round(costRatio)}（临界口径）——一切 (k,b) 束式树投机 S≤1，直通验证器更廉`;
  return {
    k: bestK,
    b: bestK > 0 ? bestB : 1,
    tokensPerRound: round(tokens),
    speedup: round(bestS),
    draftTokens: draft,
    worthwhile,
    cappedK,
    cappedB,
    interpretation,
  };
}

/** (R5) 束式树投机确定性仿真统计（LLN 对照闭式 N_beam） */
export interface TreeRoundSimulation {
  rounds: number;
  seed: number;
  /** 实测每轮平均产出 token 数（LLN → N_beam(k,b,γ)） */
  meanTokensPerRound: number;
  /** 实测平均推进层数（LLN → N_beam − 1） */
  meanLevelsAdvanced: number;
}

/**
 * (R5) 束式树投机确定性仿真（文件内 mulberry32, 同 seed 同输出）:
 * 每层 b 个候选各自独立以概率 γ 被接受, 任一中即推进一层, 全拒截断;
 * 产出 = 推进层数 + 1（修正 token）——闭式 N_beam 的大数定律对照。
 */
export function simulateTreeRounds(
  gamma: number,
  k: number,
  b: number,
  rounds: number,
  seed: number,
): TreeRoundSimulation {
  if (!Number.isFinite(gamma) || gamma < 0 || gamma > 1) {
    throw new Error('simulateTreeRounds: γ ∈ [0,1]');
  }
  if (!Number.isInteger(k) || k < 0) throw new Error('simulateTreeRounds: k 为非负整数');
  if (!Number.isInteger(b) || b < 1) throw new Error('simulateTreeRounds: b 为 ≥1 整数');
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error('simulateTreeRounds: rounds 为 ≥1 整数');
  if (!Number.isInteger(seed) || seed < 0) throw new Error('simulateTreeRounds: seed 为非负整数');
  const rng = mulberry32(seed);
  let tokens = 0;
  let levelsTotal = 0;
  for (let r = 0; r < rounds; r += 1) {
    let levels = 0;
    for (let i = 0; i < k; i += 1) {
      let advanced = false;
      for (let c = 0; c < b; c += 1) {
        if (rng() < gamma) advanced = true;
      }
      if (!advanced) break;
      levels += 1;
    }
    tokens += levels + 1;
    levelsTotal += levels;
  }
  return {
    rounds,
    seed,
    meanTokensPerRound: tokens / rounds,
    meanLevelsAdvanced: levelsTotal / rounds,
  };
}

// ─────────────────────────── 配对经济性裁决 ───────────────────────────

/** 草稿模型（快模型）画像 */
export interface DrafterStats {
  /** 模型标识（如 'fast-mini'） */
  id: string;
  /** 单 token 成本（任意一致单位: ms/token、$/Mtoken、归一化算力均可——只有比值进入数学） */
  costPerToken: number;
  /** 草稿 token 被验证器接受的经验率 γ ∈ [0,1]（独立近似；由引擎遥测供给，核内不采集） */
  acceptanceRate: number;
}

/** 验证器（强模型）画像 */
export interface VerifierStats {
  /** 模型标识（如 'strong-xl'） */
  id: string;
  /** 单 token 成本（与草稿同单位） */
  costPerToken: number;
}

/** drafter→verifier 配对裁决 */
export interface SpeculativeEconomyVerdict {
  /** 配对标识 `${drafter.id}→${verifier.id}` */
  pair: string;
  /** r = c_d/c_v（草稿/验证器单 token 成本比） */
  costRatio: number;
  /** 实测接受率 γ */
  gamma: number;
  /** 建议草稿深度 k*（0 = 不投机，直通） */
  optimalK: number;
  /** k* 处每轮期望产出 token 数 */
  tokensPerRound: number;
  /** k* 处加速比（相对验证器直通） */
  speedup: number;
  /** 临界接受率（k*=0 时按 k=1 口径——即判退门槛 r） */
  breakEven: number;
  /** 安全边际 γ − γ_be（正 = 接受率有余量） */
  margin: number;
  /** 是否采纳 draft-verify 通道（S(k*) > 1） */
  adopt: boolean;
  /** k* 是否触到扫描上限 */
  capped: boolean;
  basis: 'closed-form';
  interpretation: string;
}

/**
 * 配对经济性裁决: 快模型打草稿、强模型批量校验是否值得（51.0 的
 * 调度语义入口）。
 *
 * r = drafter.costPerToken / verifier.costPerToken，γ = 实测接受率；
 * 产出最优深度 k*、加速比、临界接受率与安全边际。γ ≤ r 时诚实判退
 * （adopt=false，k*=0）——「越跑越亏」的配对一步被数学终止。
 */
export function speculativeEconomy(
  drafter: DrafterStats,
  verifier: VerifierStats,
  options?: OptimalDraftOptions,
): SpeculativeEconomyVerdict {
  if (typeof drafter.id !== 'string' || drafter.id.length === 0) {
    throw new Error('speculativeEconomy: drafter.id 非空字符串');
  }
  if (typeof verifier.id !== 'string' || verifier.id.length === 0) {
    throw new Error('speculativeEconomy: verifier.id 非空字符串');
  }
  if (!Number.isFinite(drafter.costPerToken) || drafter.costPerToken <= 0) {
    throw new Error('speculativeEconomy: drafter.costPerToken > 0');
  }
  if (!Number.isFinite(verifier.costPerToken) || verifier.costPerToken <= 0) {
    throw new Error('speculativeEconomy: verifier.costPerToken > 0');
  }
  if (!Number.isFinite(drafter.acceptanceRate) || drafter.acceptanceRate < 0 || drafter.acceptanceRate > 1) {
    throw new Error('speculativeEconomy: drafter.acceptanceRate ∈ [0,1]');
  }
  const costRatio = drafter.costPerToken / verifier.costPerToken;
  const gamma = drafter.acceptanceRate;
  const opt = optimalDraftLength(gamma, costRatio, options);
  const be = breakEvenGamma(costRatio, opt.k >= 1 ? opt.k : 1);
  return {
    pair: `${drafter.id}→${verifier.id}`,
    costRatio: round(costRatio),
    gamma: round(gamma),
    optimalK: opt.k,
    tokensPerRound: opt.tokensPerRound,
    speedup: opt.speedup,
    breakEven: round(be),
    margin: round(gamma - be),
    adopt: opt.worthwhile,
    capped: opt.capped,
    basis: 'closed-form',
    interpretation: `[${drafter.id}→${verifier.id}] ${opt.interpretation}`,
  };
}

// ─────────────────────────── 确定性仿真（交叉验证口径） ───────────────────────────

/** 一轮仿真统计 */
export interface RoundSimulation {
  rounds: number;
  seed: number;
  /** 实测每轮平均产出 token 数（大数定律 → N(k,γ)） */
  meanTokensPerRound: number;
  /** 实测每轮平均被接受的草稿 token 数（大数定律 → Σ_{i=1}^{k} γ^i） */
  meanAcceptedDraftTokens: number;
}

/**
 * 确定性投机轮仿真（文件内 mulberry32，同 seed 同输出）。
 *
 * 每轮逐 token 以概率 γ 接受直到首个拒绝或打满 k 个，产出
 * 「接受数 + 1」个 token——闭式 N(k,γ) 的大数定律对照（验证锚点⑥）。
 *
 * @param gamma 接受率 γ ∈ [0,1]
 * @param k 草稿深度（非负整数）
 * @param rounds 仿真轮数（≥1 整数）
 * @param seed 种子（非负整数）
 */
export function simulateRounds(gamma: number, k: number, rounds: number, seed: number): RoundSimulation {
  if (!Number.isFinite(gamma) || gamma < 0 || gamma > 1) {
    throw new Error('simulateRounds: γ ∈ [0,1]');
  }
  if (!Number.isInteger(k) || k < 0) {
    throw new Error('simulateRounds: k 为非负整数');
  }
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error('simulateRounds: rounds 为 ≥1 整数');
  }
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error('simulateRounds: seed 为非负整数');
  }
  const rng = mulberry32(seed);
  let tokens = 0;
  let acceptedTotal = 0;
  for (let r = 0; r < rounds; r += 1) {
    let accepted = 0;
    while (accepted < k && rng() < gamma) accepted += 1;
    tokens += accepted + 1;
    acceptedTotal += accepted;
  }
  return {
    rounds,
    seed,
    meanTokensPerRound: tokens / rounds,
    meanAcceptedDraftTokens: acceptedTotal / rounds,
  };
}

// ─────────────────────────── 工具 ───────────────────────────

/** 确定性 RNG（mulberry32；内核自备，不依赖 Math.random） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 六位小数圆整（项目统一展示口径；核心闭式不圆整，保验证精度） */
function round(x: number): number {
  return Number(x.toFixed(6));
}

/* ── 接线建议 ──
 * 建议挂载引擎:
 *   1) 模型调度器——「多模型并行执行」的 drafter→verifier 配对裁决:
 *      并行下发前调 speculativeEconomy(草稿模型画像, 强模型画像)，
 *      adopt=true 才开 draft-verify 通道，否则维持既有单模型直通；
 *   2) 任务执行器——采纳后按 verdict.optimalK 设定每轮草稿深度，
 *      并随 costRatio / γ 遥测变化重算（optimalDraftLength 纯函数可
 *      每轮调度时调用，无状态可热更）。
 * 缺省关闭旗标: speculativeDecodingEnabled（缺省 false——未开启时
 *   调度路径与既有单模型直通逐位一致，本内核零介入）。
 * 挂载后改变的决策点:
 *   1) 「哪两个模型并行」从能力画像（50.0 冷启动外推）升级为
 *      能力 × 经济双裁决: γ、r 不达标的配对不再占用并行通道；
 *   2) 「草稿打多深」从魔数 k=4 升级为闭式 k*（随 γ、r 单调响应）;
 *   3) 新增判退线: γ 遥测跌破 breakEven（k=1 口径即 r）时一步退回
 *      直通——低接受率配对「越跑越亏」被数学终止而非经验发现；
 *   4) γ 由引擎遥测供给（草稿接受率滑动统计），内核不采集、不存
 *      状态——零漂移口径: 纯函数、同输入同输出、无 I/O 无时钟。
 */
