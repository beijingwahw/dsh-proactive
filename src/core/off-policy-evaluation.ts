/**
 * 88.0 离线评估内核 —— 离线策略评估（OPE）四阶梯：朴素 / OIS / WIS+PDIS / DR
 *
 * 动机: 策略进化沙盒的「跑分」是**在环测量**——候选策略必须真的跑一遍才知道
 * 好坏，而跑一遍的噪声（任务抽样、模型随机性）会把 0.2 的真实改进淹成 ±0.5 的
 * 观测差。「沙盒跑分高就上」的上线判据本质上是单次测量的点估计。另一面，系统
 * 每天在行为策略 μ（当前生产策略）下产生海量轨迹，这些数据对**没跑过**的目标
 * 策略 π 蕴含同样的信息——离线策略评估（Off-Policy Evaluation, OPE）把「评一个
 * 策略」从「跑一遍」变成「算一遍」：不上线就给出 J(π) 的无偏估计与置信区间。
 *
 * 数学（四阶梯，有限视界 T、折扣 γ、逐轨迹形式）:
 *   记号: ρ_t = π(a_t|s_t)/μ(a_t|s_t)（重要性比），ρ_{0:t} = Π_{k≤t} ρ_k，
 *         G = Σ_t γ^t·r_t（折扣回报），行为策略 μ 采集 n 条轨迹。
 *   ① 朴素均值:  J_naive = (1/n)·Σ G_i —— 把 μ 的回报当 π 的价值，有偏，
 *      偏差 = J(μ) − J(π)（策略差距大时系统性失准，回答不了「如果当初…」）。
 *   ② 普通重要性采样 OIS: J_OIS = (1/n)·Σ (Π_t ρ_t)·G_i —— 无偏，但轨迹权重
 *      是 T 个比值的连乘，方差随视界指数爆炸（重尾：单个轨迹可主导整个估计）。
 *   ③ 加权 WIS / 逐决策 PDIS:
 *      WIS  = Σ w_i·G_i / Σ w_i（w_i = Π_t ρ_t）—— 自归一化，权重凸组合保证
 *      估计始终落在观测回报范围内（有界）、有偏一致（偏差 O(1/n)）、方差大降；
 *      PDIS = (1/n)·Σ_i Σ_t γ^t·ρ_{0:t}·r_t —— 每个奖励项只累积到时刻 t 的
 *      比值乘积（后续比值与已实现奖励无关），非负奖励下 Var(PDIS) ≤ Var(OIS)
 *      （Precup 等），且保持无偏。
 *   ④ 双重稳健 DR（Jiang & Li; Thomas & Brunskill）:
 *      J_DR = (1/n)·Σ_i [ V̂(s_0^i) + Σ_t γ^t·ρ_{0:t}·( r_t + γ·V̂(s_{t+1}^i) − Q̂(s_t^i,a_t^i) ) ]
 *      其中 V̂(t,s) = Σ_a π(a|s)·Q̂(t,s,a)。**Q̂ 模型与 IS 权重只要有一个对，
 *      DR 就无偏**（双重稳健性）；Q̂ 精确时 IS 修正项逐条期望为零——方差被压到
 *      四阶梯最低（确定性环境 + 精确 Q 时修正项恒为零，DR 逐轨迹等于真值）。
 *   置信区间: 经验伯恩斯坦（Maurer–Pontil 2009，与 12.0 同源）
 *      |μ̂ − μ| ≤ σ̂·√(2·ln(3/β)/n) + 7·(b−a)·ln(3/β)/(3·(n−1))
 *      经验方差 σ̂ 替代 Hoeffding 的全范围——低方差流上半径窄一个量级；
 *      本内核双侧区间每侧取 β = δ/2（联合覆盖 ≥ 1−δ）。
 *   真值对照: makeChainMdp / makeCliffWorld 构造**转移与奖励解析已知**的
 *      有限视界 MDP，exactValue 用反向归纳精确计算 J(π)（非仿真近似），
 *      估计器误差因此有解析分母；sampleEpisodes 用文件内 mulberry32 确定性采样。
 *
 * 验证锚点（scripts/verify-ope-spi.mjs）:
 *   ① 误差阶梯: 真值已知、策略差距 ≥ 10% 的 π≠μ 下，多种子中位误差
 *      DR(精确Q) < WIS < OIS < 朴素均值；
 *   ② OIS/PDIS 无偏性: 多个大样本数据集的均值 → 真值（|均值−真值| ≤ 4·SE），
 *      且朴素均值偏差 = J(μ) − J(π)（偏差公式对照）；
 *   ③ Var(PDIS) ≤ Var(OIS)（同一数据集、非负奖励链环境实证）+ WIS 有界性；
 *   ④ 经验伯恩斯坦 CI 覆盖率: 200 种子 ≥ 名义 1−δ（90% 名义落在 0.88–1.00），
 *      半径随 n 收缩；
 *   ⑤ π=μ 退化自检: 权重恒 1，OIS=WIS=PDIS=DR(无Q)=朴素均值逐位一致；
 *      DR(精确Q) 收敛同值（确定性环境下逐轨迹恒等于真值）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 基础类型 ───────────────────────────

/** 一条轨迹: states 长 T+1（含最后状态），actions / rewards 长 T（r_t 为 s_t 上执行 a_t 后的即时奖励） */
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

/** 时间层 Q 模型: qModel(t, s, a) ≈ Q_t(s, a)。任意近似都不破坏 DR 无偏性（只影响方差） */
export type QModel = (step: number, state: number, action: number) => number;

/** 重要性权重轨迹: 逐步比值 / 累积乘积 / 整条轨迹权重 / 折扣回报 */
export interface ImportanceTrace {
  stepRatios: number[];
  cumulative: number[];
  trajectory: number;
  discountedReturn: number;
}

// ─────────────────────────── 确定性随机源 ───────────────────────────

/** 文件内 mulberry32 —— 环境采样的唯一随机源（同 seed 同轨迹，零宿主依赖） */
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

// ─────────────────────────── 策略工厂 ───────────────────────────

/** 均匀随机策略 π(a|s) = 1/|A| */
export function uniformPolicy(numActions: number): DiscretePolicy {
  if (!Number.isInteger(numActions) || numActions < 1) {
    throw new Error('uniformPolicy: numActions 必须为正整数');
  }
  return { numActions, prob: () => 1 / numActions };
}

/** 表格策略: table[s][a]，每行须为合法概率分布（和为 1，容差 1e-6） */
export function tabularPolicy(table: number[][]): DiscretePolicy {
  if (!Array.isArray(table) || table.length === 0) {
    throw new Error('tabularPolicy: table 必须为非空二维数组');
  }
  const numActions = table[0].length;
  if (!Number.isInteger(numActions) || numActions < 1) {
    throw new Error('tabularPolicy: 动作数必须为正整数');
  }
  const frozen: number[][] = [];
  for (const row of table) {
    if (!Array.isArray(row) || row.length !== numActions) {
      throw new Error('tabularPolicy: 每行长度必须一致');
    }
    let sum = 0;
    const copy: number[] = [];
    for (const p of row) {
      if (!Number.isFinite(p) || p < 0 || p > 1) {
        throw new Error('tabularPolicy: 概率必须 ∈ [0, 1]');
      }
      sum += p;
      copy.push(p);
    }
    if (Math.abs(sum - 1) > 1e-6) {
      throw new Error(`tabularPolicy: 第 ${frozen.length} 行概率和为 ${sum} ≠ 1`);
    }
    frozen.push(copy);
  }
  return {
    numActions,
    prob: (state, action) => {
      if (!Number.isInteger(state) || state < 0 || state >= frozen.length) {
        throw new Error(`tabularPolicy: 状态 ${state} 越界`);
      }
      if (!Number.isInteger(action) || action < 0 || action >= numActions) {
        throw new Error(`tabularPolicy: 动作 ${action} 越界`);
      }
      return frozen[state][action];
    },
  };
}

/** 偏置策略: 以概率 p 执行 action，其余 1−p 均摊到其他动作（numActions=2 时即 [1−p, p]） */
export function constantActionPolicy(numActions: number, action: number, p: number): DiscretePolicy {
  if (!Number.isInteger(numActions) || numActions < 2) {
    throw new Error('constantActionPolicy: numActions 必须 ≥ 2');
  }
  if (!Number.isInteger(action) || action < 0 || action >= numActions) {
    throw new Error('constantActionPolicy: action 越界');
  }
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error('constantActionPolicy: p 必须 ∈ [0, 1]');
  }
  const rest = (1 - p) / (numActions - 1);
  return { numActions, prob: (_state, a) => (a === action ? p : rest) };
}

// ─────────────────────────── 校验 ───────────────────────────

function validateGamma(gamma: number, where: string): void {
  if (!Number.isFinite(gamma) || gamma <= 0 || gamma > 1) {
    throw new Error(`${where}: 折扣因子 γ 必须 ∈ (0, 1]`);
  }
}

function validateEpisode(episode: Episode, where: string): number {
  if (!episode || !Array.isArray(episode.states) || !Array.isArray(episode.actions) || !Array.isArray(episode.rewards)) {
    throw new Error(`${where}: episode 缺少 states/actions/rewards 数组`);
  }
  const T = episode.actions.length;
  if (T < 1) throw new Error(`${where}: episode 至少包含一个决策步`);
  if (episode.states.length !== T + 1) {
    throw new Error(`${where}: states 长度 ${episode.states.length} ≠ actions 长度 + 1`);
  }
  if (episode.rewards.length !== T) {
    throw new Error(`${where}: rewards 长度 ${episode.rewards.length} ≠ actions 长度`);
  }
  for (let t = 0; t <= T; t += 1) {
    const s = episode.states[t];
    if (!Number.isFinite(s) || !Number.isInteger(s) || s < 0) {
      throw new Error(`${where}: states[${t}] = ${s} 非法（须为非负整数）`);
    }
  }
  for (let t = 0; t < T; t += 1) {
    const a = episode.actions[t];
    if (!Number.isFinite(a) || !Number.isInteger(a) || a < 0) {
      throw new Error(`${where}: actions[${t}] = ${a} 非法（须为非负整数）`);
    }
    if (!Number.isFinite(episode.rewards[t])) {
      throw new Error(`${where}: rewards[${t}] 非有限`);
    }
  }
  return T;
}

function validatePolicyShape(policy: DiscretePolicy, label: string): void {
  if (!policy || typeof policy.prob !== 'function' || !Number.isInteger(policy.numActions) || policy.numActions < 1) {
    throw new Error(`${label}: 策略必须含正整数 numActions 与 prob 函数`);
  }
}

function validatePolicyAt(policy: DiscretePolicy, state: number, label: string): void {
  validatePolicyShape(policy, label);
  let sum = 0;
  for (let a = 0; a < policy.numActions; a += 1) {
    const p = policy.prob(state, a);
    if (!Number.isFinite(p) || p < -1e-12 || p > 1 + 1e-12) {
      throw new Error(`${label}: π(a=${a}|s=${state}) = ${p} 非法`);
    }
    sum += Math.max(0, p);
  }
  if (Math.abs(sum - 1) > 1e-6) {
    throw new Error(`${label}: Σ_a π(a|s=${state}) = ${sum} ≠ 1`);
  }
}

// ─────────────────────────── 权重与回报 ───────────────────────────

/** 单条轨迹的重要性权重（π/μ 逐决策比值、累积乘积、轨迹权重、折扣回报） */
function traceOf(episode: Episode, pi: DiscretePolicy, mu: DiscretePolicy, gamma: number, where: string): ImportanceTrace {
  const T = validateEpisode(episode, where);
  validateGamma(gamma, where);
  validatePolicyShape(pi, `${where}: π`);
  validatePolicyShape(mu, `${where}: μ`);
  const checkedPi = new Set<number>();
  const checkedMu = new Set<number>();
  const stepRatios: number[] = [];
  const cumulative: number[] = [];
  let trajectory = 1;
  let discountedReturn = 0;
  for (let t = 0; t < T; t += 1) {
    const s = episode.states[t];
    const a = episode.actions[t];
    if (a >= pi.numActions || a >= mu.numActions) {
      throw new Error(`${where}: 动作 ${a} 超出策略动作空间`);
    }
    if (!checkedPi.has(s)) {
      validatePolicyAt(pi, s, `${where}: π`);
      checkedPi.add(s);
    }
    if (!checkedMu.has(s)) {
      validatePolicyAt(mu, s, `${where}: μ`);
      checkedMu.add(s);
    }
    const pMu = mu.prob(s, a);
    if (!(pMu > 1e-12)) {
      throw new Error(`${where}: 绝对连续性违反 —— μ(a=${a}|s=${s}) = ${pMu}，OPE 要求 μ 覆盖 π 的支撑`);
    }
    const rho = pi.prob(s, a) / pMu;
    if (!Number.isFinite(rho)) {
      throw new Error(`${where}: 重要性比非有限`);
    }
    trajectory *= rho;
    discountedReturn += Math.pow(gamma, t) * episode.rewards[t];
    stepRatios.push(rho);
    cumulative.push(trajectory);
  }
  return { stepRatios, cumulative, trajectory, discountedReturn };
}

/** 批量重要性权重（含逐步 π/μ 分布校验与绝对连续性检查） */
export function importanceWeights(episodes: Episode[], pi: DiscretePolicy, mu: DiscretePolicy, gamma = 1): ImportanceTrace[] {
  if (!Array.isArray(episodes) || episodes.length === 0) {
    throw new Error('importanceWeights: episodes 必须为非空数组');
  }
  return episodes.map((ep, i) => traceOf(ep, pi, mu, gamma, `importanceWeights(#${i})`));
}

/** 折扣回报 G = Σ_t γ^t·r_t */
export function returnOf(episode: Episode, gamma = 1): number {
  validateGamma(gamma, 'returnOf');
  const T = validateEpisode(episode, 'returnOf');
  let g = 0;
  for (let t = 0; t < T; t += 1) g += Math.pow(gamma, t) * episode.rewards[t];
  return g;
}

// ─────────────────────────── 四阶梯估计器 ───────────────────────────

/** ① 朴素均值: 行为数据的回报均值当作 J(π) —— 有偏（偏差 = J(μ) − J(π)），π=μ 时唯一正确 */
export function naiveMean(episodes: Episode[], gamma = 1): number {
  if (!Array.isArray(episodes) || episodes.length === 0) {
    throw new Error('naiveMean: episodes 必须为非空数组');
  }
  let sum = 0;
  for (let i = 0; i < episodes.length; i += 1) sum += returnOf(episodes[i], gamma);
  return sum / episodes.length;
}

/** ② 逐轨迹 OIS 贡献: (Π_t ρ_t)·G_i —— 无偏、重尾（89.0 配对差原料） */
export function oisPerEpisode(episode: Episode, pi: DiscretePolicy, mu: DiscretePolicy, gamma = 1): number {
  const tr = traceOf(episode, pi, mu, gamma, 'oisPerEpisode');
  return tr.trajectory * tr.discountedReturn;
}

/** ② 普通重要性采样: 逐轨迹权重 × 回复的均值 —— 无偏、方差随视界指数爆炸 */
export function ois(episodes: Episode[], pi: DiscretePolicy, mu: DiscretePolicy, gamma = 1): number {
  const traces = importanceWeights(episodes, pi, mu, gamma);
  let sum = 0;
  for (const tr of traces) sum += tr.trajectory * tr.discountedReturn;
  return sum / traces.length;
}

/** ③ 加权重要性采样 WIS: 自归一化加权和 —— 有偏一致（偏差 O(1/n)）、估计有界、方差大降 */
export function wis(episodes: Episode[], pi: DiscretePolicy, mu: DiscretePolicy, gamma = 1): number {
  const traces = importanceWeights(episodes, pi, mu, gamma);
  let sumW = 0;
  let sumWG = 0;
  for (const tr of traces) {
    sumW += tr.trajectory;
    sumWG += tr.trajectory * tr.discountedReturn;
  }
  if (!(sumW > 0)) {
    throw new Error('wis: 轨迹权重和为零（数值下溢或绝对连续性破坏）');
  }
  return sumWG / sumW;
}

/** ③ 逐轨迹 PDIS: Σ_t γ^t·ρ_{0:t}·r_t —— 无偏（89.0 注入 89.0 的缺省估计器同式） */
export function pdisPerEpisode(episode: Episode, pi: DiscretePolicy, mu: DiscretePolicy, gamma = 1): number {
  const tr = traceOf(episode, pi, mu, gamma, 'pdisPerEpisode');
  let v = 0;
  for (let t = 0; t < tr.cumulative.length; t += 1) {
    v += Math.pow(gamma, t) * tr.cumulative[t] * episode.rewards[t];
  }
  return v;
}

/** ③ 逐决策重要性采样 PDIS: 每个奖励项只累积到当步的比值乘积 —— 无偏且方差 ≤ OIS（非负奖励） */
export function pdis(episodes: Episode[], pi: DiscretePolicy, mu: DiscretePolicy, gamma = 1): number {
  if (!Array.isArray(episodes) || episodes.length === 0) {
    throw new Error('pdis: episodes 必须为非空数组');
  }
  let sum = 0;
  for (let i = 0; i < episodes.length; i += 1) sum += pdisPerEpisode(episodes[i], pi, mu, gamma);
  return sum / episodes.length;
}

/** ④ 逐轨迹双重稳健 DR: V̂(s_0) + Σ_t γ^t·ρ_{0:t}·(r_t + γV̂(s_{t+1}) − Q̂(s_t,a_t))。
 *  Q̂ 与 IS 权重只要一个对就无偏；qModel 缺省为零模型（此时 DR ≡ PDIS）。 */
export function drPerEpisode(
  episode: Episode,
  pi: DiscretePolicy,
  mu: DiscretePolicy,
  qModel?: QModel,
  gamma = 1,
): number {
  const tr = traceOf(episode, pi, mu, gamma, 'drPerEpisode');
  const T = episode.actions.length;
  const vOf = (t: number, s: number): number => {
    if (!qModel) return 0;
    let v = 0;
    for (let a = 0; a < pi.numActions; a += 1) {
      const q = qModel(t, s, a);
      if (!Number.isFinite(q)) throw new Error('drPerEpisode: qModel 返回非有限值');
      v += pi.prob(s, a) * q;
    }
    return v;
  };
  const qOf = (t: number, s: number, a: number): number => {
    if (!qModel) return 0;
    const q = qModel(t, s, a);
    if (!Number.isFinite(q)) throw new Error('drPerEpisode: qModel 返回非有限值');
    return q;
  };
  let est = vOf(0, episode.states[0]);
  for (let t = 0; t < T; t += 1) {
    const s = episode.states[t];
    const a = episode.actions[t];
    const residual = episode.rewards[t] + gamma * vOf(t + 1, episode.states[t + 1]) - qOf(t, s, a);
    est += Math.pow(gamma, t) * tr.cumulative[t] * residual;
  }
  if (!Number.isFinite(est)) throw new Error('drPerEpisode: 估计值非有限');
  return est;
}

/** ④ 双重稳健估计（数据集均值）: drEstimate(…, qModel) —— 四阶梯顶端 */
export function drEstimate(
  episodes: Episode[],
  pi: DiscretePolicy,
  mu: DiscretePolicy,
  qModel?: QModel,
  gamma = 1,
): number {
  if (!Array.isArray(episodes) || episodes.length === 0) {
    throw new Error('drEstimate: episodes 必须为非空数组');
  }
  let sum = 0;
  for (let i = 0; i < episodes.length; i += 1) sum += drPerEpisode(episodes[i], pi, mu, qModel, gamma);
  return sum / episodes.length;
}

// ─────────────────────────── 经验伯恩斯坦置信区间 ───────────────────────────

export interface EmpiricalBernsteinCI {
  n: number;
  mean: number;
  sigma: number;
  lower: number;
  upper: number;
  radius: number;
  range: number;
}

/**
 * 经验伯恩斯坦置信区间（Maurer–Pontil 2009）:
 *   P( μ ∈ [μ̂ − r, μ̂ + r] ) ≥ 1 − δ，双侧每侧 δ/2，
 *   r = σ̂·√(2·ln(3/(δ/2))/n) + 7·(b−a)·ln(3/(δ/2))/(3·(n−1))。
 * [a,b] 缺省用经验 min/max，可用 bounds 显式给已知界。
 */
export function empiricalBernsteinCI(
  samples: number[],
  delta: number,
  bounds?: { lower: number; upper: number },
): EmpiricalBernsteinCI {
  const n = samples.length;
  if (!Array.isArray(samples) || n < 2) {
    throw new Error('empiricalBernsteinCI: 至少需要 2 个样本');
  }
  if (!Number.isFinite(delta) || delta <= 0 || delta >= 1) {
    throw new Error('empiricalBernsteinCI: δ 必须 ∈ (0, 1)');
  }
  let mean = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of samples) {
    if (!Number.isFinite(x)) throw new Error('empiricalBernsteinCI: 样本含非有限值');
    mean += x;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  mean /= n;
  let variance = 0;
  for (const x of samples) variance += (x - mean) * (x - mean);
  const sigma = Math.sqrt(variance / (n - 1));
  if (bounds) {
    if (!Number.isFinite(bounds.lower) || !Number.isFinite(bounds.upper) || bounds.lower > bounds.upper) {
      throw new Error('empiricalBernsteinCI: bounds 非法（lower ≤ upper 且有限）');
    }
    lo = bounds.lower;
    hi = bounds.upper;
  }
  const range = hi - lo;
  const logTerm = Math.log(3 / (delta / 2));
  const radius = sigma * Math.sqrt((2 * logTerm) / n) + (7 * range * logTerm) / (3 * (n - 1));
  return { n, mean, sigma, lower: mean - radius, upper: mean + radius, radius, range };
}

// ─────────────────────────── 误差度量 ───────────────────────────

export interface ErrorMetrics {
  n: number;
  bias: number;
  mae: number;
  rmse: number;
  medianAbsError: number;
  maxAbsError: number;
  std: number;
}

/** 估计误差全景: 偏差 / MAE / RMSE / 中位绝对误差 / 最大绝对误差 / 标准差 */
export function errorMetrics(estimates: number[], truth: number): ErrorMetrics {
  if (!Array.isArray(estimates) || estimates.length === 0) {
    throw new Error('errorMetrics: estimates 必须为非空数组');
  }
  const n = estimates.length;
  let bias = 0;
  let mae = 0;
  let sq = 0;
  let maxAbsError = 0;
  const absErrors: number[] = [];
  for (const e of estimates) {
    if (!Number.isFinite(e)) throw new Error('errorMetrics: 估计值含非有限数');
    const err = e - truth;
    bias += err;
    mae += Math.abs(err);
    sq += err * err;
    if (Math.abs(err) > maxAbsError) maxAbsError = Math.abs(err);
    absErrors.push(Math.abs(err));
  }
  bias /= n;
  mae /= n;
  const rmse = Math.sqrt(sq / n);
  absErrors.sort((x, y) => x - y);
  const mid = Math.floor(absErrors.length / 2);
  const medianAbsError =
    absErrors.length % 2 === 1 ? absErrors[mid] : (absErrors[mid - 1] + absErrors[mid]) / 2;
  let variance = 0;
  for (const e of estimates) variance += (e - bias - truth) * (e - bias - truth);
  return { n, bias, mae, rmse, medianAbsError, maxAbsError, std: Math.sqrt(variance / Math.max(1, n - 1)) };
}

// ─────────────────────────── 已知真值环境工厂 ───────────────────────────

export interface MdpTransition {
  state: number;
  prob: number;
}

export interface KnownMdpEnv {
  readonly kind: 'chain' | 'cliff';
  readonly numStates: number;
  readonly numActions: number;
  readonly horizon: number;
  readonly gamma: number;
  readonly startState: number;
  /** 转移概率质量（和为 1；确定性转移为单点） */
  transitions(state: number, action: number): MdpTransition[];
  /** 奖励 r(s, a, s') */
  reward(state: number, action: number, next: number): number;
  /** 精确价值 J(π) = V₀(startState)（反向归纳解析计算，非仿真） */
  exactValue(policy: DiscretePolicy): number;
  /** 时间层精确 Q 模型（DR 注入用）: qModel(t, s, a) = Q_t(s, a)，t ≥ horizon 时为 0 */
  exactQModel(policy: DiscretePolicy): QModel;
  /** 行为策略采样（mulberry32(seed) 确定性，同 seed 逐位复现） */
  sampleEpisodes(policy: DiscretePolicy, count: number, seed: number): Episode[];
}

interface EnvCore {
  numStates: number;
  numActions: number;
  horizon: number;
  gamma: number;
  startState: number;
  transitions(state: number, action: number): MdpTransition[];
  reward(state: number, action: number, next: number): number;
}

/** 有限视界反向归纳: V_T ≡ 0，Q_t(s,a) = Σ_{s'} P(s'|s,a)·(r + γ·V_{t+1}(s'))，V_t = Σ_a π(a|s)·Q_t */
function backwardInduction(env: EnvCore, policy: DiscretePolicy): { q: number[][][]; v: number[][] } {
  const { numStates: S, numActions: A, horizon: T, gamma } = env;
  if (policy.numActions !== A) {
    throw new Error(`环境动作数为 ${A}，策略动作数为 ${policy.numActions}（须一致）`);
  }
  for (let s = 0; s < S; s += 1) validatePolicyAt(policy, s, 'exactValue/exactQModel');
  const v: number[][] = Array.from({ length: T + 1 }, () => new Array<number>(S).fill(0));
  const q: number[][][] = Array.from({ length: T }, () =>
    Array.from({ length: S }, () => new Array<number>(A).fill(0)),
  );
  for (let t = T - 1; t >= 0; t -= 1) {
    for (let s = 0; s < S; s += 1) {
      for (let a = 0; a < A; a += 1) {
        let qa = 0;
        for (const tr of env.transitions(s, a)) {
          qa += tr.prob * (env.reward(s, a, tr.state) + gamma * v[t + 1][tr.state]);
        }
        q[t][s][a] = qa;
      }
      let vs = 0;
      for (let a = 0; a < A; a += 1) vs += policy.prob(s, a) * q[t][s][a];
      v[t][s] = vs;
    }
  }
  return { q, v };
}

function makeEnv(kind: 'chain' | 'cliff', core: EnvCore): KnownMdpEnv {
  const sampleAction = (policy: DiscretePolicy, state: number, rng: () => number): number => {
    const u = rng();
    let acc = 0;
    for (let a = 0; a < policy.numActions; a += 1) {
      acc += policy.prob(state, a);
      if (u < acc) return a;
    }
    return policy.numActions - 1;
  };
  const sampleNext = (options: MdpTransition[], rng: () => number): number => {
    const u = rng();
    let acc = 0;
    for (const tr of options) {
      acc += tr.prob;
      if (u < acc) return tr.state;
    }
    return options[options.length - 1].state;
  };
  return {
    kind,
    numStates: core.numStates,
    numActions: core.numActions,
    horizon: core.horizon,
    gamma: core.gamma,
    startState: core.startState,
    transitions: core.transitions,
    reward: core.reward,
    exactValue(policy: DiscretePolicy): number {
      return backwardInduction(core, policy).v[0][core.startState];
    },
    exactQModel(policy: DiscretePolicy): QModel {
      const { q } = backwardInduction(core, policy);
      return (t, s, a) => {
        if (!Number.isInteger(t) || t < 0 || t > core.horizon) {
          throw new Error(`exactQModel: 步 ${t} 越界`);
        }
        if (!Number.isInteger(s) || s < 0 || s >= core.numStates) {
          throw new Error(`exactQModel: 状态 ${s} 越界`);
        }
        if (!Number.isInteger(a) || a < 0 || a >= core.numActions) {
          throw new Error(`exactQModel: 动作 ${a} 越界`);
        }
        return t >= core.horizon ? 0 : q[t][s][a];
      };
    },
    sampleEpisodes(policy: DiscretePolicy, count: number, seed: number): Episode[] {
      validatePolicyShape(policy, 'sampleEpisodes');
      if (policy.numActions !== core.numActions) {
        throw new Error(`环境动作数为 ${core.numActions}，策略动作数为 ${policy.numActions}（须一致）`);
      }
      if (!Number.isInteger(count) || count < 1) {
        throw new Error('sampleEpisodes: count 必须为正整数');
      }
      for (let s = 0; s < core.numStates; s += 1) validatePolicyAt(policy, s, 'sampleEpisodes');
      const rng = mulberry32(seed);
      const episodes: Episode[] = [];
      for (let i = 0; i < count; i += 1) {
        const states: number[] = [core.startState];
        const actions: number[] = [];
        const rewards: number[] = [];
        let s = core.startState;
        for (let t = 0; t < core.horizon; t += 1) {
          const a = sampleAction(policy, s, rng);
          const next = sampleNext(core.transitions(s, a), rng);
          actions.push(a);
          rewards.push(core.reward(s, a, next));
          states.push(next);
          s = next;
        }
        episodes.push({ states, actions, rewards });
      }
      return episodes;
    },
  };
}

export interface ChainMdpOptions {
  /** 状态数 L（缺省 5） */
  length?: number;
  /** 决策步数 T（缺省 10） */
  horizon?: number;
  /** 折扣（缺省 1） */
  gamma?: number;
  /** 推进进入末端状态的奖励（缺省 1；在末端继续推进可持续领取） */
  goalReward?: number;
  /** 起始状态（缺省 0） */
  startState?: number;
}

/**
 * 链 MDP: 状态 0..L−1，动作 1=推进（s→min(s+1, L−1)）、0=后退（s→max(s−1, 0)），
 * 奖励 = 推进且 next=L−1 时 goalReward（末端「扎营」可持续领取），其余 0。
 * 转移确定性 → DR(精确Q) 的逐轨迹修正项恒为零（方差为零的解析特例）。
 */
export function makeChainMdp(options?: ChainMdpOptions): KnownMdpEnv {
  const length = options?.length ?? 5;
  const horizon = options?.horizon ?? 10;
  const gamma = options?.gamma ?? 1;
  const goalReward = options?.goalReward ?? 1;
  const startState = options?.startState ?? 0;
  if (!Number.isInteger(length) || length < 2) throw new Error('makeChainMdp: length 必须 ≥ 2');
  if (!Number.isInteger(horizon) || horizon < 1) throw new Error('makeChainMdp: horizon 必须 ≥ 1');
  validateGamma(gamma, 'makeChainMdp');
  if (!Number.isFinite(goalReward)) throw new Error('makeChainMdp: goalReward 必须为有限数');
  if (!Number.isInteger(startState) || startState < 0 || startState >= length) {
    throw new Error('makeChainMdp: startState 越界');
  }
  const core: EnvCore = {
    numStates: length,
    numActions: 2,
    horizon,
    gamma,
    startState,
    transitions(state, action) {
      if (!Number.isInteger(state) || state < 0 || state >= length) {
        throw new Error(`chain.transitions: 状态 ${state} 越界`);
      }
      if (action === 1) return [{ state: Math.min(state + 1, length - 1), prob: 1 }];
      if (action === 0) return [{ state: Math.max(state - 1, 0), prob: 1 }];
      throw new Error(`chain.transitions: 动作 ${action} 非法（须 0=后退 / 1=推进）`);
    },
    reward(_state, action, next) {
      return action === 1 && next === length - 1 ? goalReward : 0;
    },
  };
  return makeEnv('chain', core);
}

export interface CliffWorldOptions {
  /** 状态数（缺省 7，状态 0..6） */
  length?: number;
  /** 悬崖状态（缺省 length−2，进入即受罚并吸收） */
  cliffState?: number;
  /** 目标状态（缺省 length−1，进入即受奖并吸收） */
  goalState?: number;
  /** 打滑概率: 推进意图 +1，打滑 +2（可能跃过悬崖直抵目标）（缺省 0.2） */
  slip?: number;
  /** 落崖罚金（缺省 −1） */
  cliffPenalty?: number;
  /** 抵达目标奖励（缺省 10） */
  goalReward?: number;
  /** 决策步数（缺省 12） */
  horizon?: number;
  /** 折扣（缺省 1） */
  gamma?: number;
  /** 起始状态（缺省 0） */
  startState?: number;
}

/**
 * 悬崖世界: 一维走廊 0..L−1，悬崖在 goal−1，目标在末端。动作 1=推进
 * （意图 +1，打滑 +2 —— 从悬崖前一格打滑可跃崖直达目标），动作 0=后撤
 * （意图 −1，打滑 −2，地板 0 兜底）。悬崖/目标均为吸收态。
 * 随机转移 → PDIS/DR 的方差阶梯在真实随机性下检验。
 */
export function makeCliffWorld(options?: CliffWorldOptions): KnownMdpEnv {
  const length = options?.length ?? 7;
  const cliffState = options?.cliffState ?? length - 2;
  const goalState = options?.goalState ?? length - 1;
  const slip = options?.slip ?? 0.2;
  const cliffPenalty = options?.cliffPenalty ?? -1;
  const goalReward = options?.goalReward ?? 10;
  const horizon = options?.horizon ?? 12;
  const gamma = options?.gamma ?? 1;
  const startState = options?.startState ?? 0;
  if (!Number.isInteger(length) || length < 3) throw new Error('makeCliffWorld: length 必须 ≥ 3');
  if (!Number.isInteger(cliffState) || cliffState < 1 || cliffState >= length - 1) {
    throw new Error('makeCliffWorld: cliffState 必须 ∈ [1, length−2]');
  }
  if (!Number.isInteger(goalState) || goalState !== length - 1) {
    throw new Error('makeCliffWorld: goalState 必须 = length−1');
  }
  if (!Number.isFinite(slip) || slip < 0 || slip > 1) throw new Error('makeCliffWorld: slip 必须 ∈ [0, 1]');
  if (!Number.isFinite(cliffPenalty) || !Number.isFinite(goalReward)) {
    throw new Error('makeCliffWorld: 奖励参数必须为有限数');
  }
  if (!Number.isInteger(horizon) || horizon < 1) throw new Error('makeCliffWorld: horizon 必须 ≥ 1');
  validateGamma(gamma, 'makeCliffWorld');
  if (!Number.isInteger(startState) || startState < 0 || startState >= cliffState) {
    throw new Error('makeCliffWorld: startState 必须 ∈ [0, cliffState)');
  }
  const absorbing = new Set<number>([cliffState, goalState]);
  const core: EnvCore = {
    numStates: length,
    numActions: 2,
    horizon,
    gamma,
    startState,
    transitions(state, action) {
      if (!Number.isInteger(state) || state < 0 || state >= length) {
        throw new Error(`cliff.transitions: 状态 ${state} 越界`);
      }
      if (absorbing.has(state)) return [{ state, prob: 1 }];
      if (action === 1) {
        return [
          { state: Math.min(state + 1, goalState), prob: 1 - slip },
          { state: Math.min(state + 2, goalState), prob: slip },
        ];
      }
      if (action === 0) {
        return [
          { state: Math.max(state - 1, 0), prob: 1 - slip },
          { state: Math.max(state - 2, 0), prob: slip },
        ];
      }
      throw new Error(`cliff.transitions: 动作 ${action} 非法（须 0=后撤 / 1=推进）`);
    },
    reward(state, _action, next) {
      if (state === next) return 0;
      if (next === goalState) return goalReward;
      if (next === cliffState) return cliffPenalty;
      return 0;
    },
  };
  return makeEnv('cliff', core);
}

// ─────────────────── R5 进化 Ⅰ：switch DR —— 大权重切换到模型（偏差–方差账） ───────────────────
//
// 动机: DR 的 IS 修正项带累积权重 ρ_{0:t}——重尾的根源（单条大权重轨迹主导
// 估计）。switch DR（Su et al. 2020 系）在权重越阈时**切换到模型侧**:
//
//   J_switch = (1/n)·Σ_i [ V̂(s₀ⁱ) + Σ_t γ^t·1{ρ_{0:t} ≤ c}·ρ_{0:t}·(r_t + γV̂(s_{t+1}) − Q̂(s_t,a_t)) ]
//
// 偏差–方差账（本内核的诚实口径）:
//   - 方差: 截断事件 {ρ > c} 恰是重尾来源——剔除后经验方差随 c ↓ 单调不增;
//     c 取累积权重中位数时显著低于完整 DR;
//   - 偏差: 指示 1{ρ_{0:t} ≤ c} 是**前缀可测**的（ρ_{0:t} 在观测 r_t 前已知）。
//     Q̂ 精确时 E[ρ_{0:t}·residual_t | 前缀] = 0 ⇒ 截断保持**精确无偏**
//     （重尾被消除而零偏差——switch 的全部价值）; Q̂ 近似时截掉非零均值项
//     ⇒ 偏差 ≤ Σ_t γ^t·E[ρ·|residual|·1{ρ>c}]，c ↓ 偏差 ↑（权衡账可审计）。
//   - c = ∞ 时逐位退化为 drPerEpisode。

/** switch DR 配置 */
export interface SwitchDROptions {
  /**
   * 权重上限 c ∈ (0, ∞]: ρ_{0:t} > c 的步丢弃 IS 修正（切换到模型侧）。
   * 缺省 Infinity（= 完整 DR）。
   */
  cap?: number;
}

/** switch DR 逐轨迹诊断 */
export interface SwitchDRStepStats {
  /** 总决策步数 */
  steps: number;
  /** 被截断（切换到模型）的步数 */
  switchedSteps: number;
  /** 截断比例 */
  switchedRate: number;
  /** 全程最大累积权重 */
  maxCumulativeWeight: number;
}

/**
 * switch DR 逐轨迹估计: V̂(s₀) + Σ_t γ^t·1{ρ_{0:t} ≤ c}·ρ_{0:t}·residual_t。
 * qModel 缺省为零模型（此时 = 截断 PDIS）。cap = ∞（缺省）逐位等于 drPerEpisode。
 */
export function switchDrPerEpisode(
  episode: Episode,
  pi: DiscretePolicy,
  mu: DiscretePolicy,
  qModel?: QModel,
  gamma = 1,
  cap = Infinity,
): number {
  const capped = validateCap(cap);
  const tr = traceOf(episode, pi, mu, gamma, 'switchDrPerEpisode');
  return switchDrCore(episode, pi, qModel, gamma, capped, tr);
}

/** switch DR 数据集均值 */
export function switchDREstimate(
  episodes: Episode[],
  pi: DiscretePolicy,
  mu: DiscretePolicy,
  qModel?: QModel,
  gamma = 1,
  cap = Infinity,
): number {
  if (!Array.isArray(episodes) || episodes.length === 0) {
    throw new Error('switchDREstimate: episodes 必须为非空数组');
  }
  let sum = 0;
  for (let i = 0; i < episodes.length; i += 1) {
    sum += switchDrPerEpisode(episodes[i], pi, mu, qModel, gamma, cap);
  }
  return sum / episodes.length;
}

/** switch DR 逐步诊断（截断账: 每步累积权重是否越阈） */
export function switchDRStepStats(
  episodes: Episode[],
  pi: DiscretePolicy,
  mu: DiscretePolicy,
  gamma = 1,
  cap = Infinity,
): SwitchDRStepStats {
  if (!Array.isArray(episodes) || episodes.length === 0) {
    throw new Error('switchDRStepStats: episodes 必须为非空数组');
  }
  const capped = validateCap(cap);
  let steps = 0;
  let switched = 0;
  let maxWeight = 0;
  for (const ep of episodes) {
    const tr = traceOf(ep, pi, mu, gamma, 'switchDRStepStats');
    for (let t = 0; t < tr.cumulative.length; t += 1) {
      steps += 1;
      const w = tr.cumulative[t];
      if (w > maxWeight) maxWeight = w;
      if (w > capped) switched += 1;
    }
  }
  return { steps, switchedSteps: switched, switchedRate: steps > 0 ? switched / steps : 0, maxCumulativeWeight: maxWeight };
}

function validateCap(cap: number): number {
  if (cap === Infinity) return cap;
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error(`cap 须 ∈ (0, ∞]（收到 ${String(cap)}）`);
  }
  return cap;
}

// ─────────────────── R5 进化 Ⅱ：流式单遍 OPE（性能轴）+ 对数域权重（数值轴） ───────────────────
//
// 批估计器（ois/wis/pdis/drEstimate）每算一个口径就把全部轨迹重扫一遍、且
// 必须持有整个数组。StreamingOPE 在**单遍推送**里同时维护四个口径的流式
// 累积量（Welford 均值/方差），内存 O(1)、任意时刻可读——与批函数在相同
// 归一化路径下逐位等价（验证脚本 1e-12 对照 + 耗时对照）。
//
// 对数域（数值轴）: 轨迹权重 w = Πρ 的连乘在长视界/小比值下下溢为 0
// （如 ρ = 0.5、T = 2000 → w = 10^{-602}）——朴素 wis() 权重和归零直接
// throw。WIS 的分子分母都在 log 域做 streaming log-sum-exp（正负项分侧、
// 最大值重标度），除法在最后一步回线性域——**自归一化估计免疫下溢**。
// 有界性: WIS 是观测回报的凸组合（权重 ≥ 0、和 = 1），估计恒落
// [min G, max G]（数值下溢下仍成立——验证锚点）。

/** 流式 log-sum-exp 累积器（对数域读出——比值免下溢） */
class LogDomainAccumulator {
  private maxLog = -Infinity;
  private sumExp = 0;

  add(logMagnitude: number): void {
    if (logMagnitude === -Infinity) return;
    if (logMagnitude <= this.maxLog) {
      this.sumExp += Math.exp(logMagnitude - this.maxLog);
    } else {
      this.sumExp = this.sumExp * Math.exp(this.maxLog - logMagnitude) + 1;
      this.maxLog = logMagnitude;
    }
  }

  /** log Σ e^{x_i}（空/全 -Inf 时 -Infinity） */
  logValue(): number {
    if (this.maxLog === -Infinity) return -Infinity;
    return this.maxLog + Math.log(this.sumExp);
  }
}

/** Welford 单遍均值/方差 */
class Welford {
  private n = 0;
  private mean = 0;
  private m2 = 0;

  push(x: number): void {
    this.n += 1;
    const delta = x - this.mean;
    this.mean += delta / this.n;
    this.m2 += delta * (x - this.mean);
  }

  get count(): number {
    return this.n;
  }

  get meanValue(): number {
    return this.mean;
  }

  get variance(): number {
    return this.n > 1 ? this.m2 / (this.n - 1) : 0;
  }
}

export interface StreamingOptions {
  target: DiscretePolicy;
  behavior: DiscretePolicy;
  /** DR/SwitchDR 的 Q 模型（可选; 不给则 DR 退化为 PDIS 截断版） */
  qModel?: QModel;
  /** 折扣（缺省 1） */
  gamma?: number;
  /** switch DR 权重上限（缺省 ∞ = 完整 DR） */
  cap?: number;
}

export interface StreamingSummary {
  n: number;
  naive: number;
  pdis: number;
  dr: number;
  /** 对数域自归一 WIS（下溢免疫） */
  wis: number;
  sigmaPdis: number;
  sigmaDr: number;
  /** PDIS 的经验伯恩斯坦 90% 半径近似（δ = 0.1; 任意时刻可读——经验范围口径） */
  radiusPdis: number;
  /** 下溢防护账: log 域中轨迹权重低到线性域必为 0 的条数（朴素连乘全失真） */
  underflowedWeights: number;
}

/**
 * 流式 OPE: push(episode) 单遍推送（用后即弃，内存 O(1)），summary()
 * 任意时刻读四口径。等价: naive ≡ naiveMean、pdis ≡ pdis、
 * dr ≡ switchDREstimate(cap)、wis ≡ 对数域 wis()（朴素 wis 在权重下溢时
 * throw，此处仍给出有界估计）。
 */
export class StreamingOPE {
  private readonly pi: DiscretePolicy;
  private readonly mu: DiscretePolicy;
  private readonly qModel?: QModel;
  private readonly gamma: number;
  private readonly cap: number;
  private readonly naiveWelford = new Welford();
  private readonly pdisWelford = new Welford();
  private readonly drWelford = new Welford();
  private readonly wisPos = new LogDomainAccumulator();
  private readonly wisNeg = new LogDomainAccumulator();
  private readonly wisDen = new LogDomainAccumulator();
  private underflow = 0;

  constructor(options: StreamingOptions) {
    if (options === null || typeof options !== 'object') throw new Error('StreamingOPE: 需要 options 对象');
    validatePolicyShape(options.target, 'StreamingOPE: π');
    validatePolicyShape(options.behavior, 'StreamingOPE: μ');
    const gamma = options.gamma ?? 1;
    validateGamma(gamma, 'StreamingOPE');
    this.pi = options.target;
    this.mu = options.behavior;
    this.qModel = options.qModel;
    this.gamma = gamma;
    this.cap = options.cap === undefined ? Infinity : validateCap(options.cap);
  }

  /** 单遍推送一条轨迹 */
  push(episode: Episode): void {
    const tr = traceOf(episode, this.pi, this.mu, this.gamma, 'StreamingOPE.push');
    const T = episode.actions.length;
    let pdis = 0;
    for (let t = 0; t < T; t += 1) {
      pdis += Math.pow(this.gamma, t) * tr.cumulative[t] * episode.rewards[t];
    }
    const dr = switchDrCore(episode, this.pi, this.qModel, this.gamma, this.cap, tr);
    this.naiveWelford.push(tr.discountedReturn);
    this.pdisWelford.push(pdis);
    this.drWelford.push(dr);
    // WIS 的 log 域账: w·G 按符号分侧累积（|·| 进对数域，符号在外）
    const g = tr.discountedReturn;
    const logW = tr.stepRatios.reduce((s, r) => s + Math.log(r), 0);
    if (g !== 0) {
      const side = g > 0 ? this.wisPos : this.wisNeg;
      side.add(logW + Math.log(Math.abs(g)));
    }
    this.wisDen.add(logW);
    if (logW < -745) this.underflow += 1; // e^{-745}: 双精度线性域必为 0 的权重
  }

  get n(): number {
    return this.pdisWelford.count;
  }

  summary(): StreamingSummary {
    const n = this.pdisWelford.count;
    // WIS = (Σ⁺ − Σ⁻)/Σ: 比值在 log 域相减后回线性域——分子分母各自下溢时
    // 商仍有定义（e^{logPos − logDen} ≤ max|G| 有界）
    const logDen = this.wisDen.logValue();
    const wis =
      logDen === -Infinity
        ? Number.NaN
        : Math.exp(this.wisPos.logValue() - logDen) - Math.exp(this.wisNeg.logValue() - logDen);
    return {
      n,
      naive: this.naiveWelford.meanValue,
      pdis: this.pdisWelford.meanValue,
      dr: this.drWelford.meanValue,
      wis,
      sigmaPdis: Math.sqrt(this.pdisWelford.variance),
      sigmaDr: Math.sqrt(this.drWelford.variance),
      radiusPdis: n > 1 ? ebRadiusStreaming(this.pdisWelford, n) : Number.NaN,
      underflowedWeights: this.underflow,
    };
  }
}

/** 流式工厂 */
export function streamingOPE(options: StreamingOptions): StreamingOPE {
  return new StreamingOPE(options);
}

function ebRadiusStreaming(w: Welford, n: number): number {
  const sigma = Math.sqrt(w.variance);
  const range = 2 * (Math.abs(w.meanValue) + 3 * sigma + 1e-9); // 经验范围近似（保守口径）
  const logTerm = Math.log(30);
  return sigma * Math.sqrt((2 * logTerm) / n) + (7 * range * logTerm) / (3 * (n - 1));
}

/** switchDR 的核心（复用已算好的 trace——流式路径不重扫轨迹） */
function switchDrCore(
  episode: Episode,
  pi: DiscretePolicy,
  qModel: QModel | undefined,
  gamma: number,
  cap: number,
  tr: ImportanceTrace,
): number {
  const T = episode.actions.length;
  const vOf = (t: number, s: number): number => {
    if (!qModel) return 0;
    let v = 0;
    for (let a = 0; a < pi.numActions; a += 1) {
      const q = qModel(t, s, a);
      if (!Number.isFinite(q)) throw new Error('qModel 返回非有限值');
      v += pi.prob(s, a) * q;
    }
    return v;
  };
  const qOf = (t: number, s: number, a: number): number => {
    if (!qModel) return 0;
    const q = qModel(t, s, a);
    if (!Number.isFinite(q)) throw new Error('qModel 返回非有限值');
    return q;
  };
  let est = vOf(0, episode.states[0]);
  for (let t = 0; t < T; t += 1) {
    const rho = tr.cumulative[t];
    if (rho > cap) continue; // switch: 模型侧兜底（前缀可测——精确 Q 下无偏）
    const s = episode.states[t];
    const a = episode.actions[t];
    const residual = episode.rewards[t] + gamma * vOf(t + 1, episode.states[t + 1]) - qOf(t, s, a);
    est += Math.pow(gamma, t) * rho * residual;
  }
  if (!Number.isFinite(est)) throw new Error('估计值非有限');
  return est;
}

/* ─────────────────────────── 接线建议 ───────────────────────────
 *
 * 1. 金丝雀门控（与 89.0 组成「离线策略评估双件套」）:
 *    策略进化器（src/policy/policy-evolver.ts / sandbox.ts）的上线判据从
 *    「沙盒跑分 gainLCB ≥ 0」升级为双通道:
 *      a) 在环通道（现状）: 沙盒模拟分的稳健下界（23.0 Catoni / 12.0 EB-CS）;
 *      b) 离线通道（本内核）: 用生产行为策略 μ 的真实轨迹离线评估候选 π ——
 *         drEstimate(episodes, π, μ, qModel) + empiricalBernsteinCI，
 *         Q 模型由世界模型或校准表给出（近似 Q 不破坏无偏性，只影响方差）。
 *    两通道任一 LCB ≤ 0 即不放行 —— 上线安全从工程判断升级为数理统计。
 *
 * 2. 证据链三件套: 12.0（任意时刻有效证据——进化环边看边停的结论纪律）、
 *    13.0（保形——预测区间覆盖率）、88.0（离线评估——反事实「如果当初换策略」
 *    的无偏估计）共同构成进化环的证据底座；89.0 在其上做决策（有证书才上线）。
 *
 * 3. 逐轨迹原语（oisPerEpisode / pdisPerEpisode / drPerEpisode）供 89.0 以
 *    结构化类型直接注入（两内核互不 import，组合在调用侧完成）。
 *
 * 4. 零漂移承诺: 本内核只有纯函数与只读工厂；未在任何引擎路径挂载前，
 *    系统行为与升级前逐位一致。
 * ──────────────────────────────────────────────────────────── */
