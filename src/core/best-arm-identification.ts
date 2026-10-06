/**
 * 73.0 最佳臂识别内核 —— 固定预算 BAI：逐次减半 SH / 置信淘汰 racing / 均匀对照
 *
 * 动机: 21.0 Gittins 与 31.0 Hedge 回答的都是「如何无悔地**用**」——累计收益
 * 最优。但基准引擎/模型选型要回答的是另一个正交问题:「**谁是冠军**」。17 个
 * 候选引擎摆在那里，评测预算只够跑 N 条 prompt，选型阶段的目标不是攒收益，
 * 而是以最大概率锁定最优臂、且把样本花在刀刃上（难分的竞争者身上）——
 * 这是固定预算最佳臂识别（Best-Arm Identification, BAI）:
 *   - 无悔 bandit（31.0）: min R_T = L(算法) − L(最优固定臂)——**过程**最优;
 *   - BAI（本内核）: max P(推荐 = 最优臂)——**结论**最优，终局一次性兑现。
 *
 * 数学:
 *   信息度量 H = Σ_{i≠*} 1/Δ_i²，Δ_i = μ* − μ_i（[0,1] 有界奖励的子高斯
 *   口径）: 识别难度由最难分的竞争者决定，样本需求 ~ H·对数因子
 *   （Karnin–Koren–Somekh 2013 的匹配下界口径）。
 *
 *   逐次减半 SH: R = ⌈log₂ K⌉ 轮; 每轮存活臂均分该轮配额 budget/(R·|A_r|)，
 *   只留累计经验均值前 ⌈|A_r|/2⌉（平手小下标优先——确定性）。存活越久
 *   配额越厚 → 样本自动流向小 gap 竞争者，与 1/Δ² 排序一致（锚点③）;
 *   无超参、无置信区间，纯几何淘汰。
 *
 *   置信淘汰 racing（lil'UCB 家族的 successive-elimination 对照）: 全体
 *   存活臂逐相位各采 1 样本; 淘汰半径 β·√(2·ln(1/δ)/nᵢ)，当
 *   μ̂ᵢ + rᵢ < max_j(μ̂ⱼ − rⱼ) 时臂 i 出局（leader 自身豁免）。置信分离
 *   驱动、自适应停止，超参 (β, δ)——与 SH 的固定几何形成行为对照（锚点⑤）。
 *
 *   均匀分配对照: 每臂 budget/K——把预算均摊给注定出局的臂; H 越集中
 *   （一两个小 gap 竞争者扛住全部难度）浪费越大，识别率显著更低（锚点①）。
 *
 * ── R5 进化(第五轮, 2026-10) ──────────────────────────────────────────────
 * A1【数学】LUCB1 乐观追踪 lucbTracking（Kalyanakrishnan–Stone 2010）:
 *   每轮采样两个「最值得分辨」的臂——a = argmax UCB（乐观领袖）、
 *   c = argmax_{i≠a} LCB（悲观挑战者）, 其余臂一律饿死。与 SH/racing 的
 *   「全体存活臂均分」结构对偶: LUCB 把样本全部灌进「最难分辨的对」,
 *   明显差的臂第一相位后即归零（H 越集中越省）。置信半径沿用 racing 家族
 *   r_i = β·√(2·ln(1/δ)/n_i)（子高斯 Hoeffding 口径）; 平局一律小下标优先
 *   （确定性 tie-break 文档化）。
 * A2【性能】SH 的批量执行 successiveHalvingBatched: 每臂每轮的 perArm 个
 *   逐样本伯努利（perArm 次 RNG）换为**一次二项整抽**（1 次 RNG + 二分查
 *   缓存 CDF）。等价性（分布意义, 非逐位）: k 个 iid Bernoulli(μ) 之和
 *   ~ Binomial(k, μ)（全概率展开）; 反演法 F⁻¹(u) 对离散 CDF 精确——两种
 *   采样器同分布, 但 RNG 调用数从 O(Σ perArm) 降到 O(轮×臂) + 缓存命中。
 *   CDF 按 (n, μ) 记忆化: identificationRate 的多种子工作负载中同样的
 *   (n, μ) 反复出现, 摊销后每抽仅 1 次 RNG + O(log n) 查表。逐位口径:
 *   旧 successiveHalving 原样保留（同种子同输出——RNG 流不动, 零漂移）。
 *
 * 验证锚点（scripts/verify-online-frontier.mjs）:
 *   ① μ=[0.5,0.45,0.4,0.3,0.1]、budget=3000、500 种子: SH 识别率 ≥ 0.98，
 *      均匀分配对照显著更低; ② 识别率随预算单调不降; ③ 平均样本数与
 *      1/Δ² 排序一致（gap 小 → 样本多，H 的预测行为）; ④ 并列最优（Δ=0）
 *      容错: 返回并列者之一不崩、H=∞ 诚实报告; ⑤ racing 同预算识别率
 *      与 SH 同档（两算法行为差异诚实报告）。
 *
 * 应用: 基准引擎/模型选型——从「无悔地用」升级为「最快锁定冠军」:
 *   选型阶段用 BAI 锁定冠军引擎（样本经济性），运行阶段交给 21.0 Gittins
 *   开采、31.0 Hedge 对抗兜底。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

/** 算法选择（strip-types 兼容: const 对象 + 类型，不用 enum） */
export const BAI_ALGORITHMS = {
  successiveHalving: 'successive-halving',
  racingElimination: 'racing-elimination',
  uniformAllocation: 'uniform-allocation',
  /** (R5-A1) LUCB1 乐观追踪（Kalyanakrishnan–Stone 2010 的固定预算口径） */
  lucbTracking: 'lucb-tracking',
  /** (R5-A2) 逐次减半的批量执行（每臂每轮一次二项整抽, 分布等价于逐样本伯努利） */
  successiveHalvingBatched: 'successive-halving-batched',
} as const;

export type BaiAlgorithm = (typeof BAI_ALGORITHMS)[keyof typeof BAI_ALGORITHMS];

/** 逐次减半 / 均匀分配共用配置 */
export interface BaiOptions {
  /** 臂均值 μᵢ ∈ [0,1]（Bernoulli 奖励口径; 引擎质量分的 0-1 归一） */
  mus: ReadonlyArray<number>;
  /** 总样本预算（全部臂合计的拉臂次数），正整数 */
  budget: number;
  /** RNG 种子（缺省 1; 同种子同输出——纯函数） */
  seed?: number;
}

/** 置信淘汰（racing）配置 */
export interface RacingOptions extends BaiOptions {
  /** 置信水平 δ ∈ (0,1)，缺省 0.05 */
  delta?: number;
  /** 半径系数 β > 0: 淘汰半径 = β·√(2·ln(1/δ)/nᵢ)，缺省 0.5 */
  beta?: number;
}

export interface BaiResult {
  /** 推荐臂（并列最优时返回并列者之一——平手小下标优先，确定性） */
  best: number;
  /** 各臂实际消耗的样本数（Σ ≤ budget——预算纪律） */
  samplesPerArm: number[];
  /** 各臂经验均值 μ̂ᵢ = 成功数/样本数（0 样本记 0） */
  empiricalMeans: number[];
  /** SH 减半轮数 / racing 采样相位数（均匀分配恒 0） */
  rounds: number;
}

/** H 复杂度读数 */
export interface HComplexityResult {
  /** 事后最优臂（μ 最大; 并列取小下标） */
  best: number;
  /** gaps[i] = μ_best − μ_i（best 位为 0） */
  gaps: number[];
  /** H = Σ_{i≠best} 1/Δ_i²; 任一并列（Δ=0）时为 Infinity——信息论上不可分，诚实报告 */
  H: number;
  /** 最难臂（最小正 gap; 无正 gap 时为 −1） */
  hardest: number;
}

/** 识别率统计 */
export interface IdentificationRateResult {
  algorithm: BaiAlgorithm;
  trials: number;
  budget: number;
  /** 成功率: 推荐 ∈ argmax 集合（并列容错口径——并列者任一都算对） */
  rate: number;
  /** 平均每臂样本数（与 hComplexity 的 1/Δ² 排序对照用） */
  averageSamplesPerArm: number[];
}

// ─────────────────────────── 内部工具 ───────────────────────────

/** 文件内确定性 RNG（mulberry32）——同种子同序列 */
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

function validateMus(mus: ReadonlyArray<number>): number[] {
  if (!Array.isArray(mus) || mus.length === 0) {
    throw new Error(`bestArm: mus 必须是非空数组，收到 ${mus === null || mus === undefined ? String(mus) : `长度 ${mus.length}`}`);
  }
  const out: number[] = [];
  for (let i = 0; i < mus.length; i += 1) {
    const mu = mus[i];
    if (typeof mu !== 'number' || !Number.isFinite(mu) || mu < 0 || mu > 1) {
      throw new Error(`bestArm: mus[${i}] 必须是 [0,1] 内有限数，收到 ${String(mu)}`);
    }
    out.push(mu);
  }
  return out;
}

function validateBudget(budget: number): number {
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 1 || Math.floor(budget) !== budget) {
    throw new Error(`bestArm: budget 必须是正整数，收到 ${String(budget)}`);
  }
  return budget;
}

/** Bernoulli(μ) 单样本 */
function bernoulli(rng: () => number, mu: number): number {
  return rng() < mu ? 1 : 0;
}

// ─────────────────────────── 三种算法 ───────────────────────────

/**
 * 逐次减半（Karnin–Koren–Somekh 2013）。
 *
 * R = ⌈log₂ K⌉ 轮; 第 r 轮每个存活臂配 ⌊剩余/(剩余轮数·|A_r|)⌋（至少 1，
 * 预算耗尽即截断——预算纪律 Σ ≤ budget）个新样本，然后按**累计**经验均值
 * 只留前 ⌈|A_r|/2⌉。K=1 时无需采样直接返回。样本量不足时未采样臂按均值
 * −1 排末位（下标序平手），行为退化但诚实（调用方应给足预算，量级参考
 * hComplexity）。
 */
export function successiveHalving(options: BaiOptions): BaiResult {
  const mus = validateMus(options.mus);
  const budget = validateBudget(options.budget);
  const rng = mulberry32(options.seed ?? 1);
  const K = mus.length;
  if (K === 1) {
    return { best: 0, samplesPerArm: [0], empiricalMeans: [0], rounds: 0 };
  }
  const totalRounds = Math.ceil(Math.log2(K));
  let active = Array.from({ length: K }, (_, i) => i);
  const samples = new Array<number>(K).fill(0);
  const sums = new Array<number>(K).fill(0);
  let remaining = budget;
  let roundsUsed = 0;
  const meanOf = (i: number): number => (samples[i] > 0 ? sums[i] / samples[i] : -1);
  for (let r = 0; r < totalRounds && active.length > 1 && remaining > 0; r += 1) {
    const roundsLeft = totalRounds - r;
    const perArm = Math.max(1, Math.floor(remaining / (roundsLeft * active.length)));
    for (const i of active) {
      for (let s = 0; s < perArm && remaining > 0; s += 1) {
        sums[i] += bernoulli(rng, mus[i]);
        samples[i] += 1;
        remaining -= 1;
      }
    }
    roundsUsed += 1;
    const keep = Math.ceil(active.length / 2);
    active = [...active].sort((a, b) => meanOf(b) - meanOf(a) || a - b).slice(0, keep);
  }
  // active 已按均值降序（平手小下标优先）——首元素即推荐
  return {
    best: active[0],
    samplesPerArm: samples,
    empiricalMeans: samples.map((n, i) => (n > 0 ? sums[i] / n : 0)),
    rounds: roundsUsed,
  };
}

/**
 * 置信淘汰 racing（lil'UCB 家族的 successive-elimination 对照）。
 *
 * 每相位各存活臂采 1 样本（下标序）; 半径 rᵢ = β·√(2·ln(1/δ)/nᵢ)，当
 * μ̂ᵢ + rᵢ < max_j(μ̂ⱼ − rⱼ)（leader 自身豁免）时出局。置信分离驱动:
 * gap 大的臂早出局、省下的预算自动涌向难分对（与 SH 的固定几何相对照，
 * 行为差异由验证锚点⑤诚实报告）。预算耗尽时取存活臂均值最高者。
 */
export function racingElimination(options: RacingOptions): BaiResult {
  const mus = validateMus(options.mus);
  const budget = validateBudget(options.budget);
  const delta = options.delta ?? 0.05;
  if (typeof delta !== 'number' || !Number.isFinite(delta) || delta <= 0 || delta >= 1) {
    throw new Error(`racingElimination: delta 必须在 (0,1) 开区间，收到 ${String(options.delta)}`);
  }
  const beta = options.beta ?? 0.5;
  if (typeof beta !== 'number' || !Number.isFinite(beta) || beta <= 0) {
    throw new Error(`racingElimination: beta 必须为正有限数，收到 ${String(options.beta)}`);
  }
  const rng = mulberry32(options.seed ?? 1);
  const K = mus.length;
  if (K === 1) {
    return { best: 0, samplesPerArm: [0], empiricalMeans: [0], rounds: 0 };
  }
  let active = Array.from({ length: K }, (_, i) => i);
  const samples = new Array<number>(K).fill(0);
  const sums = new Array<number>(K).fill(0);
  let remaining = budget;
  let phases = 0;
  const meanOf = (i: number): number => (samples[i] > 0 ? sums[i] / samples[i] : -1);
  const radiusOf = (i: number): number => beta * Math.sqrt((2 * Math.log(1 / delta)) / samples[i]);
  while (active.length > 1 && remaining > 0) {
    for (const i of active) {
      if (remaining <= 0) break;
      sums[i] += bernoulli(rng, mus[i]);
      samples[i] += 1;
      remaining -= 1;
    }
    phases += 1;
    // leader = 最大 LCB 者; 淘汰一切 UCB 低于 leader LCB 的臂（可一次出局多臂）
    let leader = active[0];
    let bestLcb = -Infinity;
    for (const i of active) {
      const lcb = meanOf(i) - radiusOf(i);
      if (lcb > bestLcb) {
        bestLcb = lcb;
        leader = i;
      }
    }
    const survivors = active.filter((i) => i === leader || meanOf(i) + radiusOf(i) >= bestLcb);
    active = survivors.length > 0 ? survivors : [leader];
  }
  let best = active[0];
  for (const i of active) if (meanOf(i) > meanOf(best)) best = i;
  return {
    best,
    samplesPerArm: samples,
    empiricalMeans: samples.map((n, i) => (n > 0 ? sums[i] / n : 0)),
    rounds: phases,
  };
}

/**
 * 均匀分配对照: 每臂 ⌊budget/K⌋，余数逐臂 +1（下标序——确定性）。
 * 没有任何淘汰机制，预算均摊给注定出局的臂——识别率的下界对照。
 */
export function uniformAllocation(options: BaiOptions): BaiResult {
  const mus = validateMus(options.mus);
  const budget = validateBudget(options.budget);
  const rng = mulberry32(options.seed ?? 1);
  const K = mus.length;
  if (K === 1) {
    return { best: 0, samplesPerArm: [0], empiricalMeans: [0], rounds: 0 };
  }
  const base = Math.floor(budget / K);
  const remainder = budget - base * K;
  const samples = new Array<number>(K).fill(0);
  const sums = new Array<number>(K).fill(0);
  for (let i = 0; i < K; i += 1) {
    const n = base + (i < remainder ? 1 : 0);
    for (let s = 0; s < n; s += 1) sums[i] += bernoulli(rng, mus[i]);
    samples[i] = n;
  }
  let best = 0;
  for (let i = 1; i < K; i += 1) if (sums[i] / samples[i] > sums[best] / samples[best]) best = i;
  return {
    best,
    samplesPerArm: samples,
    empiricalMeans: samples.map((n, i) => (n > 0 ? sums[i] / n : 0)),
    rounds: 0,
  };
}

// ─────────────────── (R5-A1/A2) LUCB 乐观追踪 + 批量 SH ───────────────────

/**
 * (R5-A1) LUCB1 乐观追踪（固定预算口径）。
 *
 * 初始化: 全体臂各采 1 样本; 每轮 a = argmax_i UCB_i（乐观领袖）、
 * c = argmax_{i≠a} LCB_i（最强挑战者）, 各采 1 样本; 预算耗尽即停,
 * 推荐经验均值最高者（平局小下标优先——确定性）。
 *
 * 半径 r_i = β·√(2·ln(1/δ)/n_i)（与 racingElimination 同族, 子高斯口径）。
 * 行为签名: 样本集中于「领袖 × 挑战者」两臂, 明显差的臂首轮后饿死——
 * 与 SH 的固定几何减半、racing 的置信淘汰三方对照（验证脚本锚点）。
 */
export function lucbTracking(options: RacingOptions): BaiResult {
  const mus = validateMus(options.mus);
  const budget = validateBudget(options.budget);
  const delta = options.delta ?? 0.05;
  if (typeof delta !== 'number' || !Number.isFinite(delta) || delta <= 0 || delta >= 1) {
    throw new Error(`lucbTracking: delta 必须在 (0,1) 开区间，收到 ${String(options.delta)}`);
  }
  const beta = options.beta ?? 0.5;
  if (typeof beta !== 'number' || !Number.isFinite(beta) || beta <= 0) {
    throw new Error(`lucbTracking: beta 必须为正有限数，收到 ${String(options.beta)}`);
  }
  const rng = mulberry32(options.seed ?? 1);
  const K = mus.length;
  if (K === 1) {
    return { best: 0, samplesPerArm: [0], empiricalMeans: [0], rounds: 0 };
  }
  const samples = new Array<number>(K).fill(0);
  const sums = new Array<number>(K).fill(0);
  let remaining = budget;
  const meanOf = (i: number): number => (samples[i] > 0 ? sums[i] / samples[i] : -1);
  const radiusOf = (i: number): number => beta * Math.sqrt((2 * Math.log(1 / delta)) / samples[i]);
  // 初始化: 每臂 1 样本（下标序——确定性）
  for (let i = 0; i < K && remaining > 0; i += 1) {
    sums[i] += bernoulli(rng, mus[i]);
    samples[i] += 1;
    remaining -= 1;
  }
  let rounds = 0;
  while (remaining > 0) {
    // 领袖 = 最大 UCB; 挑战者 = 其余臂中最大 LCB（平局小下标优先）
    let leader = -1;
    let leaderUcb = -Infinity;
    for (let i = 0; i < K; i += 1) {
      const u = meanOf(i) + radiusOf(i);
      if (u > leaderUcb + 1e-15) {
        leaderUcb = u;
        leader = i;
      }
    }
    let challenger = -1;
    let challengerLcb = -Infinity;
    for (let i = 0; i < K; i += 1) {
      if (i === leader) continue;
      const l = meanOf(i) - radiusOf(i);
      if (l > challengerLcb + 1e-15) {
        challengerLcb = l;
        challenger = i;
      }
    }
    // 各采 1 样本（预算不足 2 时先采领袖）
    for (const i of challenger >= 0 ? [leader, challenger] : [leader]) {
      if (remaining <= 0) break;
      sums[i] += bernoulli(rng, mus[i]);
      samples[i] += 1;
      remaining -= 1;
    }
    rounds += 1;
  }
  let best = 0;
  for (let i = 1; i < K; i += 1) if (meanOf(i) > meanOf(best)) best = i;
  return {
    best,
    samplesPerArm: samples,
    empiricalMeans: samples.map((n, i) => (n > 0 ? sums[i] / n : 0)),
    rounds,
  };
}

/** (R5-A2) 二项 CDF 的记忆化缓存: key `${n}:${μ 精确圆整}` → 累积分布数组 */
const binomialCdfCache = new Map<string, number[]>();

/**
 * Binomial(n, μ) 的 CDF（pmf 递推 + 累加, 尾项强制 1 消除下溢尘埃）。
 * μ ≤ 0.5 从 i=0 向上递推、μ > 0.5 从 i=n 向下递推（对称换向避免大比值溢出）。
 */
function binomialCdf(n: number, mu: number): number[] {
  const key = `${n}:${mu.toFixed(12)}`;
  const hit = binomialCdfCache.get(key);
  if (hit !== undefined) return hit;
  const pmf = new Array<number>(n + 1).fill(0);
  if (mu <= 0.5) {
    pmf[0] = Math.pow(1 - mu, n);
    for (let i = 0; i < n; i += 1) {
      pmf[i + 1] = (pmf[i] * (n - i) * mu) / ((i + 1) * (1 - mu));
    }
  } else {
    pmf[n] = Math.pow(mu, n);
    for (let i = n; i > 0; i -= 1) {
      pmf[i - 1] = (pmf[i] * i * (1 - mu)) / ((n - i + 1) * mu);
    }
  }
  const cdf = new Array<number>(n + 1);
  let acc = 0;
  for (let i = 0; i <= n; i += 1) {
    acc += Number.isFinite(pmf[i]) ? pmf[i] : 0;
    cdf[i] = acc;
  }
  cdf[n] = 1;
  if (binomialCdfCache.size > 4096) binomialCdfCache.clear(); // 有界缓存（审计口径）
  binomialCdfCache.set(key, cdf);
  return cdf;
}

/**
 * (R5-A2) Binomial(n, μ) 整抽（CDF 反演, 精确离散逆: 最小 k 使 F(k) ≥ u）。
 * 与「n 次独立 Bernoulli(μ) 求和」同分布（iid 伯努利列之和的二项恒等式）,
 * 但只消耗 1 次 RNG + O(log n) 查表。μ∈{0,1} 退化直接短路。
 */
function sampleBinomial(rng: () => number, n: number, mu: number): number {
  if (n <= 0) return 0;
  if (mu <= 0) return 0;
  if (mu >= 1) return n;
  const cdf = binomialCdf(n, mu);
  const u = rng();
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] >= u) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * (R5-A2) 逐次减半的批量执行: 淘汰骨架与 successiveHalving 逐位相同
 * （同预算公式、同累计均值比较、同平手小下标）, 唯一差别是每臂每轮的
 * perArm 个样本用**一次 Binomial(perArm, μ_i) 整抽**产生——分布等价
 * （iid Bernoulli 之和 ≡ Binomial）, RNG 调用 O(轮×臂) 而非 O(预算)。
 */
export function successiveHalvingBatched(options: BaiOptions): BaiResult {
  const mus = validateMus(options.mus);
  const budget = validateBudget(options.budget);
  const rng = mulberry32(options.seed ?? 1);
  const K = mus.length;
  if (K === 1) {
    return { best: 0, samplesPerArm: [0], empiricalMeans: [0], rounds: 0 };
  }
  const totalRounds = Math.ceil(Math.log2(K));
  let active = Array.from({ length: K }, (_, i) => i);
  const samples = new Array<number>(K).fill(0);
  const sums = new Array<number>(K).fill(0);
  let remaining = budget;
  let roundsUsed = 0;
  const meanOf = (i: number): number => (samples[i] > 0 ? sums[i] / samples[i] : -1);
  for (let r = 0; r < totalRounds && active.length > 1 && remaining > 0; r += 1) {
    const roundsLeft = totalRounds - r;
    const perArm = Math.max(1, Math.floor(remaining / (roundsLeft * active.length)));
    for (const i of active) {
      if (remaining < perArm) break; // 预算纪律: 整抽不可截半, 不足一轮配额即停
      const hits = sampleBinomial(rng, perArm, mus[i]);
      sums[i] += hits;
      samples[i] += perArm;
      remaining -= perArm;
    }
    roundsUsed += 1;
    const keep = Math.ceil(active.length / 2);
    active = [...active].sort((a, b) => meanOf(b) - meanOf(a) || a - b).slice(0, keep);
  }
  return {
    best: active[0],
    samplesPerArm: samples,
    empiricalMeans: samples.map((n, i) => (n > 0 ? sums[i] / n : 0)),
    rounds: roundsUsed,
  };
}

// ─────────────────────────── 度量与统计 ───────────────────────────

/**
 * 样本复杂度信息度量 H = Σ_{i≠*} 1/Δ_i²。
 *
 * 任一非最优臂 Δ=0（并列最优）时 H = Infinity——信息论上分不出冠军，
 * 诚实返回 ∞ 而非假装有限（验证锚点④; 接线侧据此切换到运行时混合调度）。
 */
export function hComplexity(mus: ReadonlyArray<number>): HComplexityResult {
  const values = validateMus(mus);
  const best = argmaxIndex(values);
  const gaps = values.map((mu) => values[best] - mu);
  let H = 0;
  let hardest = -1;
  let hardestGap = Infinity;
  for (let i = 0; i < values.length; i += 1) {
    if (i === best) continue;
    const gap = gaps[i];
    if (gap <= 0) {
      // 并列最优: 1/Δ² 发散
      H = Infinity;
      continue;
    }
    H += 1 / (gap * gap);
    if (gap < hardestGap) {
      hardestGap = gap;
      hardest = i;
    }
  }
  return { best, gaps, H, hardest };
}

/**
 * 多种子识别率: 每次独立试验用派生种子跑指定算法，成功率口径为
 * 「推荐 ∈ argmax 集合」（并列容错）。附带平均每臂样本数（锚点③的
 * H 预测行为对照）。种子派生 seed_t = seed + (t+1)·0x9E3779B1（黄金比率
 * 散布，与 budget 无关——跨预算可比）。
 */
export function identificationRate(options: {
  mus: ReadonlyArray<number>;
  budget: number;
  trials?: number;
  seed?: number;
  algorithm?: BaiAlgorithm;
  delta?: number;
  beta?: number;
}): IdentificationRateResult {
  const mus = validateMus(options.mus);
  const budget = validateBudget(options.budget);
  const trials = options.trials ?? 500;
  if (typeof trials !== 'number' || !Number.isFinite(trials) || trials < 1 || Math.floor(trials) !== trials) {
    throw new Error(`identificationRate: trials 必须是正整数，收到 ${String(options.trials)}`);
  }
  const algorithm: BaiAlgorithm = options.algorithm ?? BAI_ALGORITHMS.successiveHalving;
  const known = Object.values(BAI_ALGORITHMS) as string[];
  if (!known.includes(algorithm)) {
    throw new Error(`identificationRate: algorithm 必须是 ${known.join(' / ')}，收到 ${String(algorithm)}`);
  }
  const seed = options.seed ?? 1;
  let maxMu = -Infinity;
  for (const mu of mus) if (mu > maxMu) maxMu = mu;
  const sampleTotals = new Array<number>(mus.length).fill(0);
  let successes = 0;
  for (let t = 0; t < trials; t += 1) {
    const trialSeed = (seed + (t + 1) * 0x9e3779b1) >>> 0;
    const common = { mus, budget, seed: trialSeed };
    let result: BaiResult;
    if (algorithm === BAI_ALGORITHMS.successiveHalving) result = successiveHalving(common);
    else if (algorithm === BAI_ALGORITHMS.racingElimination)
      result = racingElimination({ ...common, delta: options.delta, beta: options.beta });
    else if (algorithm === BAI_ALGORITHMS.lucbTracking)
      result = lucbTracking({ ...common, delta: options.delta, beta: options.beta });
    else if (algorithm === BAI_ALGORITHMS.successiveHalvingBatched)
      result = successiveHalvingBatched(common);
    else result = uniformAllocation(common);
    for (let i = 0; i < mus.length; i += 1) sampleTotals[i] += result.samplesPerArm[i];
    // 并列容错: 推荐臂只要落在 argmax 集合即算成功（μ 经校验有限，精确相等可靠）
    if (mus[result.best] === maxMu) successes += 1;
  }
  return {
    algorithm,
    trials,
    budget,
    rate: successes / trials,
    averageSamplesPerArm: sampleTotals.map((s) => s / trials),
  };
}

function argmaxIndex(values: ReadonlyArray<number>): number {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) if (values[i] > values[best]) best = i;
  return best;
}

// ─────────────────── 73.0 调度接线建议（挂载侧的语义桥） ───────────────────
// 1. 引擎锦标赛（选型阶段）: 候选引擎 → 臂，μ = 归一化质量分 ∈ [0,1];
//    先 hComplexity(先验 μ) 估样本量级（预算 ≳ 2H·log K），再
//    successiveHalving 锁定冠军。与现有内核的分工——BAI 负责「选型」
//    （一次性、结论最优），21.0 Gittins 负责「运行」（持续、折扣收益最优），
//    31.0 Hedge 负责「对抗/非平稳兜底」。
// 2. budget 口径: 1 样本 = 1 次引擎评测（一条 prompt 的质量分）; 预算不足
//    时 SH 按轮内截断诚实耗尽（Σ samplesPerArm ≤ budget 可审计）。
// 3. 并列/近并列引擎（Δ ≈ 0 或 H → ∞）: 信息论上分不出冠军——不要硬选，
//    保留全部并列者交给 31.0/21.0 的运行时口径做混合调度（诚实 ≠ 拍板）。
// 4. racing 的 (β, δ) 语义: β 越大淘汰越保守（错杀率低、样本贵），缺省
//    (0.5, 0.05) 在 H 集中的实例上与 SH 同档（锚点⑤），流式场景（预算
//    在线到达）优先 racing，批量场景优先 SH。
