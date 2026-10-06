/**
 * 89.0 安全策略改进内核 —— HCPI 式高置信策略改进（离线策略评估的「守门员」）
 *
 * 动机: 88.0 解决「不上线就精确估值」，本内核解决「没有统计证书不上线」。
 *   策略进化沙盒的现行门禁是「沙盒跑分 gainLCB ≥ 0」——但那条 LCB 是对
 *   **模拟器**的统计，而模拟器与操作环之间存在保真度缺口（校准滞后、任务分布
 *   漂移、噪声模型失配）；且门禁的样本量、置信度、阈值之间没有联动数学——
 *   噪声大时也敢放行，样本不足时也敢定罪。HCPI（High Confidence Policy
 *   Improvement, Thomas et al. 2015）把「上线」变成一个被浓度不等式背书的
 *   决策: 只当改进量 Δ = J(π_cand) − J(π_base) 的置信下界 LCB > 0 时才接受
 *   候选。「错误接受真退步」的概率被 δ 一刀钉死，与样本量、噪声尺度、阈值
 *   拍脑袋全部解耦——进化环的上线安全从工程判断升级为数理统计。
 *
 * 数学:
 *   逐轨迹配对差: Δ_i = Ĵ_i(π_cand) − Ĵ_i(π_base) —— 同一轨迹、同一估计器；
 *   配对消去环境的公共噪声（两策略估计高度正相关），Var(Δ_i) 远低于「各自
 *   独立评估再相减」。
 *   浓度不等式: 经验伯恩斯坦（Maurer–Pontil 2009，与 12.0/88.0 同源）单侧界
 *     P( Δ ≥ Δ̂ − r ) ≥ 1 − δ，
 *     r = σ̂·√(2·ln(3/δ)/n) + 7·(b−a)·ln(3/δ)/(3·(n−1))，
 *     LCB = Δ̂ − r，半宽 = O(√(ln(1/δ)/n)) —— 样本翻倍、半径 ×1/√2。
 *   决策规则: accepted ⟺ n ≥ minSamples ∧ LCB > 0
 *     ⟹ P(accepted | Δ ≤ 0) ≤ P(LCB > 0 | Δ ≤ 0) ≤ P(LCB > Δ) ≤ δ。
 *   边际行为: 真改进 Δ>0 时，LCB 随 n 以 √n 速度爬向 Δ —— 边缘候选自动从
 *   「保守拒绝」翻转为「有证书的接受」，无需人工调阈值；δ 越小越保守
 *   （radius 随 ln(3/δ) 单调增 → 同数据上接受集单调缩）。
 *   估计器注入: 配对差用「逐轨迹价值估计器」计算，缺省内置逐决策重要性采样
 *   （PDIS，无模型依赖）；88.0 的 drPerEpisode(…, qModel) 可按同一函数形状
 *   直接注入——Q 模型越好 σ̂ 越小、证书越早下发。本内核零 import，与 88.0 的
 *   组合靠结构化类型（Episode / DiscretePolicy 同形）在调用侧完成。
 *
 * 验证锚点（scripts/verify-ope-spi.mjs）:
 *   ① 真改进候选（J 差 ≥ +0.2）: 样本充足时接受率 ≥ 0.95（证书不误伤好策略）;
 *   ② 真退步候选: 500 种子实证违反率 ≤ δ + 统计容差、拒绝率 ≥ 1−δ;
 *   ③ 边缘候选（0 < Δ ≪ 半径量级）: 同一生长数据集上 LCB 随 n 单调收紧、
 *      决策从保守拒绝翻转为接受（√n 收缩的直接后果）;
 *   ④ CI 半宽 ∝ n^(−1/2): 浓度曲线双对数斜率 ≈ −0.5（含 1/n 修正项的渐近）;
 *   ⑤ δ 缩小 ⟹ 半径增大 ⟹ 同数据集接受集单调缩小（数学保证，非经验结论）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 基础类型（与 88.0 同形，零 import 结构化兼容） ───────────────────────────

/** 一条轨迹: states 长 T+1，actions / rewards 长 T */
export interface Episode {
  states: number[];
  actions: number[];
  rewards: number[];
}

/** 离散动作随机策略: prob(s, a) = π(a|s)，须满足 Σ_a prob(s, a) = 1 */
export interface DiscretePolicy {
  numActions: number;
  prob: (state: number, action: number) => number;
}

/**
 * 逐轨迹单策略价值估计器: 给一条 μ 采集的轨迹，返回 J(π) 的无偏贡献项。
 * 缺省内置 PDIS；88.0 的 pdisPerEpisode / drPerEpisode(…, qModel) 可直接注入。
 */
export type EpisodeValueEstimator = (
  episode: Episode,
  target: DiscretePolicy,
  behavior: DiscretePolicy,
  gamma: number,
) => number;

// ─────────────────────────── 确定性随机源 ───────────────────────────

/** 文件内 mulberry32 —— 浓度曲线 bootstrap 的唯一随机源（同 seed 同输出） */
function mulberry32(seed: number): () => number {
  if (!Number.isFinite(seed)) throw new Error('mulberry32: seed 必须为有限数');
  let a = Math.floor(seed) >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────── 内置缺省估计器（逐决策 IS） ───────────────────────────

/**
 * 内置逐轨迹 PDIS 价值估计: Σ_t γ^t·ρ_{0:t}·r_t（与 88.0 pdisPerEpisode 同式；
 * 本内核零 import，故文件内自含实现）。无偏、无模型依赖。
 */
export function pdisEpisodeValue(
  episode: Episode,
  target: DiscretePolicy,
  behavior: DiscretePolicy,
  gamma: number,
): number {
  if (!episode || !Array.isArray(episode.states) || !Array.isArray(episode.actions) || !Array.isArray(episode.rewards)) {
    throw new Error('pdisEpisodeValue: episode 缺少 states/actions/rewards 数组');
  }
  const T = episode.actions.length;
  if (T < 1) throw new Error('pdisEpisodeValue: episode 至少包含一个决策步');
  if (episode.states.length !== T + 1 || episode.rewards.length !== T) {
    throw new Error('pdisEpisodeValue: 轨迹数组长度不一致');
  }
  if (!Number.isFinite(gamma) || gamma <= 0 || gamma > 1) {
    throw new Error('pdisEpisodeValue: γ 必须 ∈ (0, 1]');
  }
  for (const policy of [target, behavior]) {
    if (!policy || typeof policy.prob !== 'function' || !Number.isInteger(policy.numActions) || policy.numActions < 1) {
      throw new Error('pdisEpisodeValue: 策略必须含正整数 numActions 与 prob 函数');
    }
  }
  const checked = new Set<string>();
  let cumulative = 1;
  let value = 0;
  for (let t = 0; t < T; t += 1) {
    const s = episode.states[t];
    const a = episode.actions[t];
    if (!Number.isInteger(s) || s < 0 || !Number.isInteger(a) || a < 0) {
      throw new Error('pdisEpisodeValue: 状态/动作须为非负整数');
    }
    if (a >= target.numActions || a >= behavior.numActions) {
      throw new Error('pdisEpisodeValue: 动作超出策略动作空间');
    }
    for (const [label, policy] of [['target', target], ['behavior', behavior]] as const) {
      const key = `${label}:${s}`;
      if (!checked.has(key)) {
        let sum = 0;
        for (let k = 0; k < policy.numActions; k += 1) {
          const p = policy.prob(s, k);
          if (!Number.isFinite(p) || p < -1e-12 || p > 1 + 1e-12) {
            throw new Error(`pdisEpisodeValue: ${label} 策略概率非法`);
          }
          sum += Math.max(0, p);
        }
        if (Math.abs(sum - 1) > 1e-6) {
          throw new Error(`pdisEpisodeValue: ${label} 策略在 s=${s} 概率和 ${sum} ≠ 1`);
        }
        checked.add(key);
      }
    }
    const pMu = behavior.prob(s, a);
    if (!(pMu > 1e-12)) {
      throw new Error(`pdisEpisodeValue: 绝对连续性违反 —— μ(a=${a}|s=${s}) = ${pMu}`);
    }
    cumulative *= target.prob(s, a) / pMu;
    value += Math.pow(gamma, t) * cumulative * episode.rewards[t];
  }
  if (!Number.isFinite(value)) throw new Error('pdisEpisodeValue: 估计值非有限');
  return value;
}

// ─────────────────────────── 浓度半径 ───────────────────────────

/**
 * 经验伯恩斯坦单侧半径（Maurer–Pontil 2009）:
 *   r(σ̂, b−a, n, δ) = σ̂·√(2·ln(3/δ)/n) + 7·(b−a)·ln(3/δ)/(3·(n−1))
 * 与 88.0 的 empiricalBernsteinCI 同源；此处 δ 直用（单侧 LCB 有效覆盖 ≥ 1−δ）。
 */
export function ebRadius(sigma: number, range: number, n: number, delta: number): number {
  if (!Number.isFinite(sigma) || sigma < 0) throw new Error('ebRadius: sigma 必须 ≥ 0');
  if (!Number.isFinite(range) || range < 0) throw new Error('ebRadius: range 必须 ≥ 0');
  if (!Number.isInteger(n) || n < 2) throw new Error('ebRadius: n 必须 ≥ 2');
  if (!Number.isFinite(delta) || delta <= 0 || delta >= 1) throw new Error('ebRadius: δ 必须 ∈ (0, 1)');
  const logTerm = Math.log(3 / delta);
  return sigma * Math.sqrt((2 * logTerm) / n) + (7 * range * logTerm) / (3 * (n - 1));
}

// ─────────────────────────── 安全策略改进决策 ───────────────────────────

export interface SafePolicyImproveInput {
  /** 行为策略 μ 采集的轨迹（生产数据 / 沙盒回放） */
  episodes: Episode[];
  /** 候选策略 π_cand */
  candidate: DiscretePolicy;
  /** 基线策略 π_base（通常即行为策略本身） */
  baseline: DiscretePolicy;
  /** 行为策略 μ（重要性权重的分母来源） */
  behavior: DiscretePolicy;
  /** 置信参数 δ ∈ (0,1): P(错误接受真退步) ≤ δ（缺省 0.05） */
  delta?: number;
  /** 最小样本量（低于此只报数不做决策，缺省 30） */
  minSamples?: number;
  /** 折扣因子（缺省 1） */
  gamma?: number;
  /** 逐轨迹价值估计器（缺省内置 PDIS；88.0 的 drPerEpisode 可注入） */
  estimator?: EpisodeValueEstimator;
  /** 配对差 |Δ_i| 的已知界（缺省用经验范围） */
  diffBounds?: { lower: number; upper: number };
}

export type SafeImproveReason =
  | 'accepted-lcb-positive'
  | 'rejected-lcb-nonpositive'
  | 'insufficient-samples';

export interface SafeImproveResult {
  accepted: boolean;
  /** Δ̂ = mean_i Δ_i（配对差点估计） */
  delta: number;
  /** 所用置信参数 δ */
  deltaParam: number;
  lcb: number;
  ucb: number;
  radius: number;
  sigma: number;
  n: number;
  reason: SafeImproveReason;
}

/**
 * HCPI 式高置信策略改进决策:
 *   Δ̂ = (1/n)·Σ [Ĵ_i(π_cand) − Ĵ_i(π_base)]（逐轨迹配对差），
 *   LCB = Δ̂ − ebRadius(σ̂, b−a, n, δ)，accepted ⟺ n ≥ minSamples ∧ LCB > 0。
 */
export function safePolicyImprove(input: SafePolicyImproveInput): SafeImproveResult {
  const { episodes, candidate, baseline, behavior } = input;
  const delta = input.delta ?? 0.05;
  const minSamples = input.minSamples ?? 30;
  const gamma = input.gamma ?? 1;
  const estimator = input.estimator ?? pdisEpisodeValue;
  if (!Array.isArray(episodes) || episodes.length < 2) {
    throw new Error('safePolicyImprove: episodes 必须为至少 2 条轨迹的数组');
  }
  if (!Number.isFinite(delta) || delta <= 0 || delta >= 1) {
    throw new Error('safePolicyImprove: δ 必须 ∈ (0, 1)');
  }
  if (!Number.isInteger(minSamples) || minSamples < 2) {
    throw new Error('safePolicyImprove: minSamples 必须 ≥ 2');
  }
  if (!Number.isFinite(gamma) || gamma <= 0 || gamma > 1) {
    throw new Error('safePolicyImprove: γ 必须 ∈ (0, 1]');
  }
  for (const [label, policy] of [['candidate', candidate], ['baseline', baseline], ['behavior', behavior]] as const) {
    if (!policy || typeof policy.prob !== 'function' || !Number.isInteger(policy.numActions) || policy.numActions < 1) {
      throw new Error(`safePolicyImprove: ${label} 策略必须含正整数 numActions 与 prob 函数`);
    }
  }
  if (input.diffBounds) {
    const { lower, upper } = input.diffBounds;
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) {
      throw new Error('safePolicyImprove: diffBounds 非法（lower ≤ upper 且有限）');
    }
  }
  const n = episodes.length;
  const diffs: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const cand = estimator(episodes[i], candidate, behavior, gamma);
    const base = estimator(episodes[i], baseline, behavior, gamma);
    if (!Number.isFinite(cand) || !Number.isFinite(base)) {
      throw new Error(`safePolicyImprove: 第 ${i} 条轨迹的估计值非有限`);
    }
    const d = cand - base;
    if (!Number.isFinite(d)) {
      throw new Error(`safePolicyImprove: 第 ${i} 条轨迹的配对差非有限（估计器数值溢出）`);
    }
    diffs.push(d);
  }
  let deltaHat = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of diffs) {
    deltaHat += d;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  deltaHat /= n;
  let variance = 0;
  for (const d of diffs) variance += (d - deltaHat) * (d - deltaHat);
  const sigma = Math.sqrt(variance / (n - 1));
  if (input.diffBounds) {
    lo = input.diffBounds.lower;
    hi = input.diffBounds.upper;
  }
  const radius = ebRadius(sigma, hi - lo, n, delta);
  const lcb = deltaHat - radius;
  const ucb = deltaHat + radius;
  const enough = n >= minSamples;
  const accepted = enough && lcb > 0;
  const reason: SafeImproveReason = !enough
    ? 'insufficient-samples'
    : accepted
      ? 'accepted-lcb-positive'
      : 'rejected-lcb-nonpositive';
  return { accepted, delta: deltaHat, deltaParam: delta, lcb, ucb, radius, sigma, n, reason };
}

// ─────────────────────────── 浓度曲线（半宽 vs 样本量） ───────────────────────────

export interface ConcentrationPoint {
  n: number;
  /** bootstrap 平均 EB 半宽 */
  halfWidth: number;
  /** √(ln/n) 项（渐近主导） */
  sqrtTerm: number;
  /** 1/n 项（有限样本修正） */
  linearTerm: number;
}

/**
 * 浓度曲线: 对配对差样本池做有放回 bootstrap，绘制 EB 半宽随 n 的收缩律。
 * 半宽 = A/√n + B/n → 双对数斜率介于 −1 与 −1/2、渐近 −1/2（样本充足时
 * √ 项主导，即「样本翻倍、半径 ×1/√2」）。
 */
export function concentrationCurve(
  diffSamples: number[],
  sizes: number[],
  options?: { delta?: number; repetitions?: number; seed?: number },
): ConcentrationPoint[] {
  const delta = options?.delta ?? 0.05;
  const repetitions = options?.repetitions ?? 40;
  const seed = options?.seed ?? 1;
  if (!Array.isArray(diffSamples) || diffSamples.length < 2) {
    throw new Error('concentrationCurve: diffSamples 必须为至少 2 个样本的数组');
  }
  for (const x of diffSamples) {
    if (!Number.isFinite(x)) throw new Error('concentrationCurve: 样本含非有限值');
  }
  if (!Array.isArray(sizes) || sizes.length === 0) {
    throw new Error('concentrationCurve: sizes 必须为非空数组');
  }
  for (const n of sizes) {
    if (!Number.isInteger(n) || n < 2) throw new Error('concentrationCurve: 每个样本量必须 ≥ 2');
  }
  if (!Number.isFinite(delta) || delta <= 0 || delta >= 1) {
    throw new Error('concentrationCurve: δ 必须 ∈ (0, 1)');
  }
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new Error('concentrationCurve: repetitions 必须 ≥ 1');
  }
  const rng = mulberry32(seed);
  const pool = diffSamples.length;
  const logTerm = Math.log(3 / delta);
  return sizes.map((n) => {
    let accHalf = 0;
    let accSqrt = 0;
    let accLinear = 0;
    for (let r = 0; r < repetitions; r += 1) {
      let mean = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < n; i += 1) {
        const x = pool > 1 ? diffSamples[Math.floor(rng() * pool)] : diffSamples[0];
        mean += x;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      mean /= n;
      let variance = 0;
      for (let i = 0; i < n; i += 1) {
        const x = pool > 1 ? diffSamples[Math.floor(rng() * pool)] : diffSamples[0];
        variance += (x - mean) * (x - mean);
      }
      const sigma = Math.sqrt(variance / (n - 1));
      const sqrtTerm = sigma * Math.sqrt((2 * logTerm) / n);
      const linearTerm = (7 * (hi - lo) * logTerm) / (3 * (n - 1));
      accHalf += sqrtTerm + linearTerm;
      accSqrt += sqrtTerm;
      accLinear += linearTerm;
    }
    return { n, halfWidth: accHalf / repetitions, sqrtTerm: accSqrt / repetitions, linearTerm: accLinear / repetitions };
  });
}

// ─────────────────────────── 多种子仿真（违反率校准） ───────────────────────────

export interface RejectionTrial {
  candidate: DiscretePolicy;
  baseline: DiscretePolicy;
  behavior: DiscretePolicy;
}

export interface RejectionRateOptions {
  seeds: number;
  delta?: number;
  minSamples?: number;
  gamma?: number;
  estimator?: EpisodeValueEstimator;
}

export interface RejectionRateResult {
  seeds: number;
  acceptedRate: number;
  rejectedRate: number;
  /** 每个种子的接受标志（真值已知时可用于统计「违反」= 接受了真退步） */
  acceptedFlags: boolean[];
  meanDeltaHat: number;
}

/**
 * 多种子接受率仿真: 每个 seed 用注入的数据工厂（如 88.0 环境的
 * sampleEpisodes(policy, n, seed)）采一批新鲜轨迹，跑一次完整的
 * safePolicyImprove 决策。真退步候选的 acceptedRate 即「证书违反率」，
 * 校准锚点: 违反率 ≤ δ + 统计容差。
 */
export function rejectionRate(
  makeEpisodes: (seed: number) => Episode[],
  trial: RejectionTrial,
  options: RejectionRateOptions,
): RejectionRateResult {
  if (typeof makeEpisodes !== 'function') {
    throw new Error('rejectionRate: makeEpisodes 必须为 (seed) => episodes 的数据工厂');
  }
  if (!options || !Number.isInteger(options.seeds) || options.seeds < 1) {
    throw new Error('rejectionRate: seeds 必须为正整数');
  }
  if (!trial || !trial.candidate || !trial.baseline || !trial.behavior) {
    throw new Error('rejectionRate: trial 必须含 candidate/baseline/behavior');
  }
  const acceptedFlags: boolean[] = [];
  let accepted = 0;
  let deltaSum = 0;
  for (let s = 0; s < options.seeds; s += 1) {
    const episodes = makeEpisodes(s);
    const result = safePolicyImprove({
      episodes,
      candidate: trial.candidate,
      baseline: trial.baseline,
      behavior: trial.behavior,
      delta: options.delta,
      minSamples: options.minSamples,
      gamma: options.gamma,
      estimator: options.estimator,
    });
    acceptedFlags.push(result.accepted);
    if (result.accepted) accepted += 1;
    deltaSum += result.delta;
  }
  const acceptedRate = accepted / options.seeds;
  return { seeds: options.seeds, acceptedRate, rejectedRate: 1 - acceptedRate, acceptedFlags, meanDeltaHat: deltaSum / options.seeds };
}

// ─────────────────── R5 进化：多候选并发证书（多重检验的 union bound 精确化） ───────────────────
//
// 动机: 策略进化器每轮产生的候选不止一个——k 个候选各自做一次 89.0 的
// LCB 检验，「错误接受任一真退步」（FWER）会按 union bound 膨胀到 k·δ。
// 两种精确化:
//
//   ① Bonferroni（无序候选）: 每个候选用 δ/k 检验。
//      P(任一真退步被接受) ≤ Σ_j δ/k ≤ δ —— union bound 的精确均分，
//      候选间相关性无关（任意相关下有效）。
//   ② 固定序（fixed-sequence，有先验排序的候选——如沙盒分降序）: 按给定
//      序逐个用**全额 δ** 检验，首次拒绝即停（接受集 = 前缀）。
//      P(任一真退步被接受) = P(首个被接受者是真退步) ≤ δ——**k 个候选
//      不付任何多重检验税**（比 Bonferroni 严格更省样本），代价是必须
//      预先给出排序且只能接受前缀。
//
// 共享基线（性能轴）: 全部候选与基线的配对差共用同一批轨迹——基线贡献
// 只算一遍（k+1 遍估计器扫完，而非 2k 遍），结果与逐个调用
// safePolicyImprove(δ/k) 一致（等价证明在验证脚本）。
// 数值轴: 配对差的均值/方差用单遍 Welford（与两遍口径等价）。

/** 多重检验校正方式（const 对象 + 类型，strip-types 兼容） */
export const MULTI_CORRECTION = {
  /** Bonferroni: 每候选 δ/k（无序候选的 union bound 精确均分） */
  bonferroni: 'bonferroni',
  /** 固定序: 按序全额 δ、首次拒绝即停（有先验排序——零多重检验税） */
  fixedSequence: 'fixed-sequence',
} as const;

export type MultiCorrection = (typeof MULTI_CORRECTION)[keyof typeof MULTI_CORRECTION];

/** Bonferroni 均分: 每候选置信参数 δ/k（整数候选数、δ ∈ (0,1) 校验） */
export function bonferroniDelta(delta: number, candidates: number): number {
  if (!Number.isFinite(delta) || delta <= 0 || delta >= 1) {
    throw new Error(`bonferroniDelta: δ 必须 ∈ (0, 1)`);
  }
  if (!Number.isInteger(candidates) || candidates < 1) {
    throw new Error(`bonferroniDelta: candidates 必须为正整数`);
  }
  return delta / candidates;
}

export interface SafePolicyImproveMultiInput extends Omit<SafePolicyImproveInput, 'candidate' | 'delta' | 'diffBounds'> {
  /** 候选策略列表（≥1; fixed-sequence 按数组序检验） */
  candidates: DiscretePolicy[];
  /** 总置信预算 δ ∈ (0,1): FWER ≤ δ（缺省 0.05） */
  delta?: number;
  /** 校正方式（缺省 bonferroni） */
  correction?: MultiCorrection;
  /** 配对差 |Δ_i| 的已知界（缺省用经验范围） */
  diffBounds?: { lower: number; upper: number };
}

/** 单候选结果（与 SafeImproveResult 同构 + 序号; 固定序首拒后的候选为 not-tested） */
export interface CandidateDecision {
  index: number;
  accepted: boolean;
  delta: number;
  deltaHat: number;
  lcb: number;
  ucb: number;
  radius: number;
  sigma: number;
  reason: SafeImproveReason | 'not-tested';
}

export interface SafeImproveMultiResult {
  correction: MultiCorrection;
  /** 校正后的每候选置信参数（Bonferroni: δ/k; 固定序: δ） */
  perCandidateDelta: number;
  results: CandidateDecision[];
  /** 被接受的候选下标（固定序 = 前缀; Bonferroni = 各自独立） */
  acceptedIndices: number[];
  /** 样本量 n（全候选共用同一批轨迹） */
  n: number;
}

/**
 * 多候选安全策略改进: 同一批轨迹上并发检验 k 个候选，FWER ≤ δ。
 *
 * Bonferroni: 每候选独立 δ/k（接受集无结构约束）; 固定序: 按序全额 δ、
 * 首拒即停（接受集 = 前缀）。n < minSamples 时全部 insufficient-samples。
 */
export function safePolicyImproveMulti(input: SafePolicyImproveMultiInput): SafeImproveMultiResult {
  const { episodes, candidates, baseline, behavior } = input;
  const delta = input.delta ?? 0.05;
  const minSamples = input.minSamples ?? 30;
  const gamma = input.gamma ?? 1;
  const estimator = input.estimator ?? pdisEpisodeValue;
  const correction: MultiCorrection = input.correction ?? MULTI_CORRECTION.bonferroni;
  if (correction !== MULTI_CORRECTION.bonferroni && correction !== MULTI_CORRECTION.fixedSequence) {
    throw new Error(`correction 须为 bonferroni/fixed-sequence（收到 ${String(correction)}）`);
  }
  if (!Array.isArray(candidates) || candidates.length < 1) {
    throw new Error('safePolicyImproveMulti: candidates 必须为非空数组');
  }
  const k = candidates.length;
  if (!Number.isFinite(delta) || delta <= 0 || delta >= 1) {
    throw new Error('safePolicyImproveMulti: δ 必须 ∈ (0, 1)');
  }
  if (!Array.isArray(episodes) || episodes.length < 2) {
    throw new Error('safePolicyImproveMulti: episodes 必须为至少 2 条轨迹的数组');
  }
  if (!Number.isInteger(minSamples) || minSamples < 2) {
    throw new Error('safePolicyImproveMulti: minSamples 必须 ≥ 2');
  }
  if (!Number.isFinite(gamma) || gamma <= 0 || gamma > 1) {
    throw new Error('safePolicyImproveMulti: γ 必须 ∈ (0, 1]');
  }
  for (const [label, policy] of [['baseline', baseline], ['behavior', behavior]] as const) {
    if (!policy || typeof policy.prob !== 'function' || !Number.isInteger(policy.numActions) || policy.numActions < 1) {
      throw new Error(`safePolicyImproveMulti: ${label} 策略必须含正整数 numActions 与 prob 函数`);
    }
  }
  for (let j = 0; j < k; j += 1) {
    const cand = candidates[j];
    if (!cand || typeof cand.prob !== 'function' || !Number.isInteger(cand.numActions) || cand.numActions < 1) {
      throw new Error(`safePolicyImproveMulti: candidates[${j}] 必须含正整数 numActions 与 prob 函数`);
    }
  }
  if (input.diffBounds) {
    const { lower, upper } = input.diffBounds;
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) {
      throw new Error('safePolicyImproveMulti: diffBounds 非法（lower ≤ upper 且有限）');
    }
  }
  const n = episodes.length;
  // 共享基线贡献（性能轴: 基线只扫一遍——k+1 遍而非 2k 遍）
  const baseContrib = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    const v = estimator(episodes[i], baseline, behavior, gamma);
    if (!Number.isFinite(v)) throw new Error(`safePolicyImproveMulti: 第 ${i} 条轨迹的基线估计非有限`);
    baseContrib[i] = v;
  }
  const perCandidateDelta = correction === MULTI_CORRECTION.bonferroni ? delta / k : delta;
  const results: CandidateDecision[] = [];
  const acceptedIndices: number[] = [];
  const enough = n >= minSamples;
  let stopped = false;
  for (let j = 0; j < k; j += 1) {
    if (stopped) {
      results.push({
        index: j,
        accepted: false,
        delta: perCandidateDelta,
        deltaHat: Number.NaN,
        lcb: Number.NaN,
        ucb: Number.NaN,
        radius: Number.NaN,
        sigma: Number.NaN,
        reason: 'not-tested',
      });
      continue;
    }
    const diffs = new Array<number>(n);
    for (let i = 0; i < n; i += 1) {
      const cand = estimator(episodes[i], candidates[j], behavior, gamma);
      if (!Number.isFinite(cand)) throw new Error(`safePolicyImproveMulti: 第 ${i} 条轨迹对候选 ${j} 的估计非有限`);
      diffs[i] = cand - baseContrib[i];
      if (!Number.isFinite(diffs[i])) throw new Error(`safePolicyImproveMulti: 候选 ${j} 第 ${i} 条配对差非有限`);
    }
    // 单遍 Welford（均值/方差一遍扫完——数值轴）
    let count = 0;
    let mean = 0;
    let m2 = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const d of diffs) {
      count += 1;
      const deltaStep = d - mean;
      mean += deltaStep / count;
      m2 += deltaStep * (d - mean);
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    const sigma = count > 1 ? Math.sqrt(m2 / (count - 1)) : 0;
    if (input.diffBounds) {
      lo = input.diffBounds.lower;
      hi = input.diffBounds.upper;
    }
    const radius = ebRadius(sigma, hi - lo, n, perCandidateDelta);
    const lcb = mean - radius;
    const ucb = mean + radius;
    const accepted = enough && lcb > 0;
    const reason: CandidateDecision['reason'] = !enough
      ? 'insufficient-samples'
      : accepted
        ? 'accepted-lcb-positive'
        : 'rejected-lcb-nonpositive';
    results.push({ index: j, accepted, delta: perCandidateDelta, deltaHat: mean, lcb, ucb, radius, sigma, reason });
    if (accepted) acceptedIndices.push(j);
    else if (correction === MULTI_CORRECTION.fixedSequence && enough) stopped = true; // 首拒即停
  }
  return { correction, perCandidateDelta, results, acceptedIndices, n };
}

/* ─────────────────────────── 接线建议 ───────────────────────────
 *
 * 1. 金丝雀门控（策略进化器的上线安全阀）:
 *    src/policy/policy-evolver.ts 的候选晋升从「沙盒跑分高就上」升级为
 *    safePolicyImprove({ episodes, candidate, baseline: 当前生产策略,
 *    behavior: 当前生产策略, delta: 0.05, minSamples }) —— accepted 才进入
 *    金丝雀发布。episodes 取操作环真实轨迹（行为策略数据天然免费），
 *    estimator 注入 88.0 的 drPerEpisode(…, qModel)（Q 由世界模型/校准表给出）。
 *
 * 2. 与 88.0 的组合方式: 两内核零 import、靠结构化类型在调用侧拼装 ——
 *      import { drPerEpisode } from './off-policy-evaluation.js';
 *      import { safePolicyImprove } from './safe-policy-improvement.js';
 *      const est = (ep, target, behavior, gamma) =>
 *        drPerEpisode(ep, target, behavior, qModelOf(target), gamma);
 *    （qModelOf 按策略对象缓存 88.0 exactQModel / 世界模型 Q 表）。
 *
 * 3. 证据链三件套闭环: 12.0 任意时刻证据（进化环结论纪律）+ 13.0 保形
 *    （预测区间覆盖率）+ 88.0 离线评估（反事实估值）→ 89.0 在三者之上给出
 *    「有统计证书才上线」的决策；δ 是唯一的风险旋钮（预算 0.05 = 每次上线
 *    决策 5% 的错误接受上限），concentrationCurve 用于回答「还差多少样本
 *    才能下发证书」。
 *
 * 4. concentrationCurve 的运维读法: 把当前候选的配对差样本喂入，读
 *    halfWidth(n) 与 |Δ̂| 的交点 —— 即达到证书门槛所需样本量的预估，
 *    可作为「继续收集 or 换候选」的分派依据（与 7.0 预算分配内核衔接）。
 *
 * 5. 零漂移承诺: 本内核只有纯函数；未挂载前系统行为与升级前逐位一致。
 * ──────────────────────────────────────────────────────────── */
