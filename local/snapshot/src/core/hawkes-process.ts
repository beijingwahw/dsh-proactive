/**
 * 55.0 Hawkes 自激发内核 —— 指数核 Hawkes 过程：事件激发事件的传染数学
 *
 * 动机: 调度器历来把「信号到达」当 Poisson——强度恒定、事件独立。但
 * 真实信号是传染的: 一次超时触发重试风暴、一条告警引来关联告警、一
 * 个慢请求拖出连锁降级——每个事件都抬高未来瞬间的到达率。Poisson
 * 假设（方差=均值）系统性低估突发，Hawkes 过程把「事件激发事件」
 * 直接写进强度函数:
 *
 *   一维指数核 Hawkes 过程（Hawkes 1971）:
 *     λ(t) = μ + Σ_{tᵢ<t} α·e^{−β(t−tᵢ)}
 *   基底 μ（移民）+ 每个历史事件的指数衰减激发（后代）。分支比
 *   η = α/β < 1 是平稳性边界: 每事件平均激发 η 个后代，η ≥ 1 时族群
 *   超临界爆炸——构造层显式校验拒绝。
 *
 *   对数似然（[0,T] 观测窗）:
 *     ℓ(μ,α,β) = Σⱼ log λ(tⱼ) − μT − (α/β)Σⱼ(1−e^{−β(T−tⱼ)})
 *   EM 拟合（Veen–Schoenberg 2008 / Lewis–Mohler 2011 口径）: 感染
 *   结构为隐变量，E 步 P_ij = αe^{−β(tⱼ−tᵢ)}/λ(tⱼ)，M 步 μ̂ = ΣP_jj/T，
 *   α̂ 沿 β 轮廓闭式 α̂ = n_off/K(β)（K(β)=Σ(1−e^{−β(T−tᵢ)})/β），
 *   β 由轮廓目标 n_off·log K(β)+β·S 数值极小化——全部 O(N) 链式
 *   递推（激发和 Σe^{−β(tⱼ−tᵢ)} 沿事件链衰减递推，无 O(N²)）。
 *
 *   补偿器与时间重标残差（Ogata 1988，诊断的数学心脏）:
 *     Λ(t) = μt + (α/β)Σ_{tᵢ≤t}(1−e^{−β(t−tᵢ)})
 *     R_k = Λ(t_{k+1}) − Λ(t_k) ~ i.i.d. Exp(1)
 *   模型正确 ⟹ 残差均值=方差=1、无自相关——残差漂移即模型失配哨兵。
 *   爆发预测闭式: E[N(now, now+Δ)] = μΔ + (1−e^{−βΔ})/β·A(now)，
 *   A(now) 为当前激发和——「刚发生的事件越多，下一窗越拥挤」可计算。
 *
 *   验证锚点: ① (μ=0.5,α=0.4,β=1)（η=0.4）≥2000 事件 EM 恢复
 *   |η̂−0.4|≤0.08；② 真参数残差均值/方差≈1（±5%）、滞后 1 自相关
 *   |ρ|<0.05；③ α=0 退化: α̂≈0 且 μ̂ 与 Poisson MLE N/T 一致；
 *   ④ burstForecast 随近邻事件数单调增、单事件/大 Δ 闭式精确；
 *   ⑤ η≥1 参数被构造校验拒绝。
 *
 * R5-A10 世界性进化（随机过程第五轮·轴 1 数学）:
 *   E. 多维 Hawkes（交叉激发矩阵）: λ_d(t) = μ_d + Σ_{d'} α_{dd'}·
 *      A_{d'}(t)，多维 thinning 仿真 + 共享 β 的矩阵 EM（M 步
 *      α̂_{dd'} = n_{dd'}/K_{d'}(β̂) 闭式、β 轮廓极小化）+ 谱半径
 *      ρ(α/β) < 1 平稳性（分支结构从标量 η 升维为矩阵 Perron 根）；
 *   F. 补偿器检验升级: 残差 Exp(1) 假设的 Kolmogorov–Smirnov 检验
 *      （D_n 统计量 + Kolmogorov 渐近分布 Q(λ)=2Σ(−1)^{k−1}e^{−2k²λ²}
 *      确定性级数）——残差诊断从「均值/方差点估计」升维为分布形状检验。
 *   验证锚点: 真参数残差 KS p 不拒绝、失配模型（Poisson 拟合 Hawkes 数据）
 *   p < 0.01 强拒绝；2 维交叉激发矩阵对角/交叉项恢复、谱半径守恒。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

export interface HawkesParams {
  /** 基底强度 μ（移民速率；simulate/logLik 要求 >0，其余 ≥0） */
  mu: number;
  /** 激发增益 α（每事件对强度的瞬时抬升，≥0） */
  alpha: number;
  /** 激发衰减率 β（激发时间常数 1/β，>0） */
  beta: number;
}

export interface HawkesSimulateInput extends HawkesParams {
  /** 观测窗长 T（事件落在 (0, T]） */
  T: number;
  /** 确定性种子（文件内 mulberry32） */
  seed: number;
}

export interface HawkesResidualReport {
  /** 残差个数（N−1，事件间隔数） */
  n: number;
  /** 残差均值（模型正确时 →1） */
  mean: number;
  /** 残差样本方差（模型正确时 →1） */
  variance: number;
  stdDev: number;
  /** 滞后 1 自相关（模型正确时 →0） */
  lag1: number;
  /** 逐事件残差 R_k = Λ(t_{k+1}) − Λ(t_k) */
  residuals: number[];
}

export interface HawkesBurstForecast {
  /** [now, now+Δ] 期望事件数 = μΔ + (1−e^{−βΔ})/β·A(now) */
  expected: number;
  /** 基底部分 μΔ（无激发时的期望） */
  baseline: number;
  /** 激发部分（历史事件的传染贡献） */
  excitation: number;
  /** 激发份额 excitation/expected ∈ [0,1) */
  excitationShare: number;
  /** 当前强度 λ(now⁺) = μ + A(now)（风暴读数） */
  rateAtNow: number;
  window: number;
  now: number;
}

export interface HawkesFitOptions {
  /** EM 迭代上限（缺省 300） */
  iters?: number;
  /** 观测窗终点 T（缺省取最后事件时间） */
  T?: number;
  /** 记录每次迭代后的对数似然轨迹 */
  trace?: boolean;
}

export interface HawkesFit {
  mu: number;
  alpha: number;
  beta: number;
  /** 分支比 α/β（<1 保证） */
  eta: number;
  logLik: number;
  iterations: number;
  converged: boolean;
  /** trace:true 时的对数似然轨迹（EM 单调不减） */
  logLikTrace: number[];
}

/** 拟合缺省口径（const 对象，非 enum——strip-types 兼容） */
export const HAWKES_DEFAULTS = {
  iters: 300,
  /** β 轮廓搜索的对数粗网格点数 */
  betaGrid: 40,
  /** β 轮廓搜索的黄金分割细化迭代数 */
  betaGolden: 60,
  /** 平稳性安全上界：拟合时 α 钳到 η < 0.999 */
  etaCeiling: 0.999,
} as const;

// ─────────────────── 校验（显式 throw） ───────────────────

function validateParams(params: HawkesParams, label: string, requirePositiveMu: boolean): void {
  const { mu, alpha, beta } = params;
  if (!Number.isFinite(mu) || !Number.isFinite(alpha) || !Number.isFinite(beta)) {
    throw new Error(`${label}: μ/α/β 必须为有限数（得到 ${mu}, ${alpha}, ${beta}）`);
  }
  if (requirePositiveMu ? !(mu > 0) : !(mu >= 0)) {
    throw new Error(`${label}: ${requirePositiveMu ? 'μ > 0' : 'μ ≥ 0'} 必需（得到 ${mu}）`);
  }
  if (!(alpha >= 0)) throw new Error(`${label}: α ≥ 0 必需（得到 ${alpha}）`);
  if (!(beta > 0)) throw new Error(`${label}: β > 0 必需（得到 ${beta}）`);
  const eta = alpha / beta;
  if (!(eta < 1)) {
    throw new Error(`${label}: 平稳性要求分支比 η=α/β<1（得到 η=${eta}——超临界过程爆炸，构造层拒绝）`);
  }
}

function validateEvents(events: ReadonlyArray<number>, label: string, minCount: number): void {
  if (events.length < minCount) {
    throw new Error(`${label}: 至少需要 ${minCount} 个事件（得到 ${events.length}）`);
  }
  for (let i = 0; i < events.length; i += 1) {
    const t = events[i];
    if (!Number.isFinite(t) || t < 0) {
      throw new Error(`${label}: 事件时间必须为有限非负数（t[${i}]=${t}）`);
    }
    if (i > 0 && !(t > events[i - 1])) {
      throw new Error(`${label}: 事件时间必须严格递增（t[${i}]=${t} ≤ t[${i - 1}]=${events[i - 1]}）`);
    }
  }
}

/** 观测窗终点：显式 T 优先，缺省取最后事件时间 */
function observationWindow(events: ReadonlyArray<number>, T: number | undefined, label: string): number {
  const tEnd = T ?? (events.length > 0 ? events[events.length - 1] : 0);
  if (!Number.isFinite(tEnd) || tEnd <= 0) throw new Error(`${label}: T > 0 必需（得到 ${tEnd}）`);
  if (events.length > 0 && events[events.length - 1] > tEnd) {
    throw new Error(`${label}: T=${tEnd} 不得小于最后事件时间 ${events[events.length - 1]}`);
  }
  return tEnd;
}

/** 文件内确定性 RNG（mulberry32）——同种子同序列，零外部随机源 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────── 仿真（thinning / Ogata 1979） ───────────────────

/**
 * 指数核 Hawkes 过程仿真（thinning 法）：强度在事件间单调不增 →
 * 当前 μ+A 即候选步长的有效上界；候选点以 λ_new/λ_bound 概率接受。
 * μ=0 时过程无法启动（首事件概率 0），显式拒绝。
 */
export function simulate(input: HawkesSimulateInput): number[] {
  const { mu, alpha, beta, T, seed } = input;
  validateParams({ mu, alpha, beta }, 'simulate', true);
  if (!Number.isFinite(T) || T <= 0) throw new Error(`simulate: T > 0 必需（得到 ${T}）`);
  if (!Number.isFinite(seed)) throw new Error(`simulate: seed 必须为有限数（得到 ${seed}）`);
  const rand = mulberry32(seed);
  const events: number[] = [];
  let t = 0;
  let excitation = 0; // A(t) = Σ_{tᵢ<t} αe^{−β(t−tᵢ)}
  for (;;) {
    const bound = mu + excitation;
    // Exp(bound) 等待: −ln(u)/bound（u ∈ (0,1]，MIN_VALUE 防零）
    const step = -Math.log(Math.max(1 - rand(), Number.MIN_VALUE)) / bound;
    if (step <= 0) continue; // 零步长保护（概率 ~2⁻³²）
    const candidate = t + step;
    if (candidate > T) break;
    const decayed = excitation * Math.exp(-beta * step);
    if (rand() * bound < mu + decayed) {
      events.push(candidate);
      excitation = decayed + alpha;
    } else {
      excitation = decayed;
    }
    t = candidate;
  }
  return events;
}

// ─────────────────── 强度 / 补偿器 / 平稳率 ───────────────────

/** 条件强度 λ(t) = μ + Σ_{tᵢ<t} αe^{−β(t−tᵢ)}（O(N) 链式衰减递推） */
export function intensity(params: HawkesParams, events: ReadonlyArray<number>, t: number): number {
  validateParams(params, 'intensity', false);
  validateEvents(events, 'intensity', 0);
  if (!Number.isFinite(t) || t < 0) throw new Error(`intensity: t ≥ 0 必需（得到 ${t}）`);
  const { mu, alpha, beta } = params;
  let excitation = 0;
  let prev = 0;
  for (const e of events) {
    if (e >= t) break;
    excitation = excitation * Math.exp(-beta * (e - prev)) + alpha;
    prev = e;
  }
  return mu + excitation * Math.exp(-beta * (t - prev));
}

/**
 * 补偿器 Λ(t) = μt + (α/β)Σ_{tᵢ≤t}(1−e^{−β(t−tᵢ)})。
 * 时间重标定理的积分器：Λ 把自激发时钟拉直成单位率 Poisson。
 */
export function compensator(params: HawkesParams, events: ReadonlyArray<number>, t: number): number {
  validateParams(params, 'compensator', false);
  validateEvents(events, 'compensator', 0);
  if (!Number.isFinite(t) || t < 0) throw new Error(`compensator: t ≥ 0 必需（得到 ${t}）`);
  const { mu, alpha, beta } = params;
  let U = 0; // U_j = Σ_{i≤j} e^{−β(t_j−t_i)}（含自身，自身项为 1）
  let prev = 0;
  let m = 0;
  for (const e of events) {
    if (e > t) break;
    U = U * Math.exp(-beta * (e - prev)) + 1;
    prev = e;
    m += 1;
  }
  const tail = U * Math.exp(-beta * (t - prev)); // Σ_{tᵢ≤t} e^{−β(t−tᵢ)}
  return mu * t + (alpha / beta) * (m - tail);
}

/** 平稳期望速率 λ̄ = μ/(1−η)（η<1 时存在；容量规划的长期口径） */
export function stationaryRate(params: HawkesParams): number {
  validateParams(params, 'stationaryRate', false);
  return params.mu / (1 - params.alpha / params.beta);
}

// ─────────────────── 对数似然 ───────────────────

/**
 * 对数似然 ℓ = Σⱼ log λ(tⱼ) − μT − (α/β)Σⱼ(1−e^{−β(T−tⱼ)})。
 * λ 递推: S_j = Σ_{i≤j}e^{−β(t_j−t_i)} 满足 S ← S·e^{−βΔ}+1，
 * λ(tⱼ) = μ + α(S_j−1)（自身不计——事件不能激发自己）。
 * μ>0 必需：μ=0 时 λ(t₁)=0、似然恒 0。
 */
export function logLik(params: HawkesParams, events: ReadonlyArray<number>, T?: number): number {
  validateParams(params, 'logLik', true);
  validateEvents(events, 'logLik', 0);
  const { mu, alpha, beta } = params;
  const tEnd = observationWindow(events, T, 'logLik');
  let S = 0;
  let prev = 0;
  let sumLogLambda = 0;
  for (const e of events) {
    S = S * Math.exp(-beta * (e - prev)) + 1;
    sumLogLambda += Math.log(mu + alpha * (S - 1));
    prev = e;
  }
  let excitationMassSum = 0;
  for (const e of events) excitationMassSum += -Math.expm1(-beta * (tEnd - e));
  return sumLogLambda - mu * tEnd - (alpha / beta) * excitationMassSum;
}

// ─────────────────── EM 拟合 ───────────────────

/** K(β) = Σᵢ(1−e^{−β(T−tᵢ)})/β —— 激发核在剩余窗内的积分质量 */
function excitationMass(beta: number, events: ReadonlyArray<number>, T: number): number {
  let K = 0;
  for (const e of events) K += -Math.expm1(-beta * (T - e));
  return K / beta;
}

/**
 * M 步 β 轮廓目标 f(β) = n_off·log K(β) + β·S 的极小点
 * （α 已轮廓闭式 α*(β)=n_off/K(β)，f 等价于 −Q + 常数）。
 * K 单调减、βS 单调增 → f 典型单峰：对数粗网格定 bracket + 黄金分割细化。
 */
function minimizeProfiledBeta(nOff: number, pairDelaySum: number, events: ReadonlyArray<number>, T: number): number {
  const lo = 0.1 / T;
  const hi = (50 * events.length) / T;
  const objective = (b: number): number => nOff * Math.log(excitationMass(b, events, T)) + b * pairDelaySum;
  const grid = HAWKES_DEFAULTS.betaGrid;
  const step = Math.pow(hi / lo, 1 / grid);
  let best = lo;
  let bestValue = Infinity;
  for (let i = 0; i <= grid; i += 1) {
    const b = i === grid ? hi : lo * Math.pow(step, i);
    const v = objective(b);
    if (v < bestValue) {
      bestValue = v;
      best = b;
    }
  }
  let a = Math.max(lo, best / step);
  let c = Math.min(hi, best * step);
  const invPhi = (Math.sqrt(5) - 1) / 2;
  let x1 = c - invPhi * (c - a);
  let x2 = a + invPhi * (c - a);
  let f1 = objective(x1);
  let f2 = objective(x2);
  for (let i = 0; i < HAWKES_DEFAULTS.betaGolden && c - a > 1e-12 * c; i += 1) {
    if (f1 <= f2) {
      c = x2;
      x2 = x1;
      f2 = f1;
      x1 = c - invPhi * (c - a);
      f1 = objective(x1);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = a + invPhi * (c - a);
      f2 = objective(x2);
    }
  }
  return (a + c) / 2;
}

/**
 * EM 拟合（指数核 Hawkes，O(N)/迭代）。
 *
 * E 步: P_ij = αe^{−β(tⱼ−tᵢ)}/λ(tⱼ)，且 Σ_{i<j}P_ij = 1 − P_jj，
 * 故 n_imm = μΣ1/λⱼ、n_off = N − n_imm；S = ΣP_ij(tⱼ−tᵢ) 由
 * W 递推 W ← (W + Δ·S)·e^{−βΔ} 一次遍历得到。
 * M 步: μ̂ = n_imm/T；β̂ 极小化轮廓目标；α̂ = min(n_off/K(β̂), 0.999β̂)
 * （平稳性钳位）。EM 性质: 每迭代 ℓ 不减（trace 可验）。
 */
export function fitHawkes(events: ReadonlyArray<number>, options?: HawkesFitOptions): HawkesFit {
  validateEvents(events, 'fitHawkes', 8);
  const iters = options?.iters ?? HAWKES_DEFAULTS.iters;
  if (!Number.isInteger(iters) || iters < 1 || iters > 100000) {
    throw new Error(`fitHawkes: iters 须为 [1,100000] 内整数（得到 ${iters}）`);
  }
  const T = observationWindow(events, options?.T, 'fitHawkes');
  const N = events.length;
  // 矩匹配初值: λ̄ = N/T，η₀ = 0.3（β₀ = 平均间隙倒数，μ₀ = λ̄(1−η₀)）
  let mu = Math.max((N / T) * 0.7, 1e-12);
  let beta = N / T;
  let alpha = 0.3 * beta;
  const trace: number[] = [];
  let converged = false;
  let iterations = 0;
  for (let it = 0; it < iters; it += 1) {
    iterations = it + 1;
    // ── E 步（O(N) 链式递推）──
    let S = 0; // Σ_{i≤j} e^{−β(t_j−t_i)}（含自身）
    let W = 0; // Σ_{i<j} (t_j−t_i)e^{−β(t_j−t_i)}（自身距离 0 不贡献）
    let prev = 0;
    let sumInvLambda = 0;
    let sumWOverLambda = 0;
    for (const e of events) {
      const dt = e - prev;
      const decay = Math.exp(-beta * dt);
      const sNext = S * decay + 1;
      W = (W + dt * S) * decay;
      S = sNext;
      const lambda = mu + alpha * (S - 1);
      sumInvLambda += 1 / lambda;
      sumWOverLambda += W / lambda;
      prev = e;
    }
    const nImm = mu * sumInvLambda; // 期望移民数 Σ P_jj
    const nOff = N - nImm; // 期望后代数 Σ_{i<j} P_ij = N − Σ P_jj
    // ── M 步 ──
    const muNew = Math.max(nImm / T, 1e-12);
    let betaNew = beta;
    let alphaNew = 0;
    if (nOff > 1e-12) {
      const pairDelaySum = alpha * sumWOverLambda; // Σ P_ij(t_j−t_i)
      betaNew = minimizeProfiledBeta(nOff, pairDelaySum, events, T);
      const K = excitationMass(betaNew, events, T);
      alphaNew = Math.min(nOff / K, HAWKES_DEFAULTS.etaCeiling * betaNew);
      if (!(alphaNew >= 0)) alphaNew = 0;
    }
    const delta = Math.max(Math.abs(muNew - mu), Math.abs(alphaNew - alpha), Math.abs(betaNew - beta));
    mu = muNew;
    alpha = alphaNew;
    beta = betaNew;
    if (options?.trace) trace.push(logLik({ mu, alpha, beta }, events, T));
    if (delta < 1e-10) {
      converged = true;
      break;
    }
  }
  return {
    mu,
    alpha,
    beta,
    eta: alpha / beta,
    logLik: logLik({ mu, alpha, beta }, events, T),
    iterations,
    converged,
    logLikTrace: trace,
  };
}

// ─────────────────── 残差诊断 ───────────────────

/**
 * 时间重标残差诊断: R_k = Λ(t_{k+1}) − Λ(t_k) ~ i.i.d. Exp(1)。
 * 闭式递推 R = μΔ + (α/β)(1−e^{−βΔ})·U（U 为上一事件处的含自身激发和）。
 * 模型正确 ⟹ mean≈1、variance≈1、lag1≈0；偏离即失配（过离散/欠离散/漏激发）。
 */
export function residualDiagnostics(params: HawkesParams, events: ReadonlyArray<number>): HawkesResidualReport {
  validateParams(params, 'residualDiagnostics', false);
  validateEvents(events, 'residualDiagnostics', 4);
  const { mu, alpha, beta } = params;
  const residuals: number[] = [];
  let U = 0; // U_j = Σ_{i≤j} e^{−β(t_j−t_i)}
  let prev = 0;
  for (let j = 0; j < events.length; j += 1) {
    const e = events[j];
    if (j > 0) {
      const dt = e - prev;
      residuals.push(mu * dt - (alpha / beta) * Math.expm1(-beta * dt) * U);
    }
    U = U * Math.exp(-beta * (e - prev)) + 1;
    prev = e;
  }
  const n = residuals.length;
  const mean = residuals.reduce((a, b) => a + b, 0) / n;
  let ss = 0;
  for (const r of residuals) ss += (r - mean) * (r - mean);
  const variance = ss / (n - 1);
  let lagNum = 0;
  let lagDen = 0;
  for (let k = 0; k + 1 < n; k += 1) {
    lagNum += (residuals[k] - mean) * (residuals[k + 1] - mean);
  }
  for (let k = 0; k < n; k += 1) lagDen += (residuals[k] - mean) * (residuals[k] - mean);
  return {
    n,
    mean,
    variance,
    stdDev: Math.sqrt(variance),
    lag1: lagDen > 0 ? lagNum / lagDen : 0,
    residuals,
  };
}

// ─────────────────── 爆发预测 ───────────────────

/**
 * 未来窗 [now, now+Δ] 期望事件数（闭式）:
 *   E = μΔ + (1−e^{−βΔ})/β·A(now)，A(now) = Σ_{tᵢ≤now} αe^{−β(now−tᵢ)}
 * 自激发直觉: 近邻事件越多 A 越大、期望越高——爆发不是猜的，是积分出来的。
 */
export function burstForecast(
  params: HawkesParams,
  events: ReadonlyArray<number>,
  delta: number,
  options?: { now?: number },
): HawkesBurstForecast {
  validateParams(params, 'burstForecast', false);
  validateEvents(events, 'burstForecast', 1);
  if (!Number.isFinite(delta) || delta <= 0) throw new Error(`burstForecast: Δ > 0 必需（得到 ${delta}）`);
  const { mu, alpha, beta } = params;
  const now = options?.now ?? events[events.length - 1];
  if (!Number.isFinite(now) || now < 0) throw new Error(`burstForecast: now ≥ 0 必需（得到 ${now}）`);
  if (now < events[events.length - 1]) {
    throw new Error(`burstForecast: now=${now} 不得早于最后事件 ${events[events.length - 1]}`);
  }
  let A = 0; // 当前激发和
  let prev = 0;
  for (const e of events) {
    if (e > now) break;
    A = A * Math.exp(-beta * (e - prev)) + alpha;
    prev = e;
  }
  A *= Math.exp(-beta * (now - prev));
  const baseline = mu * delta;
  const expected = baseline + (-Math.expm1(-beta * delta) / beta) * A;
  return {
    expected,
    baseline,
    excitation: expected - baseline,
    excitationShare: expected > 0 ? (expected - baseline) / expected : 0,
    rateAtNow: mu + A,
    window: delta,
    now,
  };
}

// ─────────────────── 接线建议 ───────────────────
// 1. Sentinel 信号层: 对信号/告警到达流滚动 fitHawkes，读
//    burstForecast().rateAtNow 与 excitationShare——激发份额超阈（如
//    >50%）即「信号风暴」判定: 到达相关性第一次有了数学口径；滚动
//    residualDiagnostics 均值/自相关漂移时自动退回 Poisson 假设（诚实降级）。
// 2. 容量规划 25.0 前馈: burstForecast(Δ=预警窗) 的 expected/Δ 作为
//    CapacityPlanner.predictedArrivalPerSec 的非平稳输入（替代平稳外推
//    N/T），爆发预警 → 提前预留并发——「主动预留容量」从口号变成 Δ 窗闭式。
// 3. 缺省关闭旗标: config.hawkesBurstGuard（缺省 false）。打开后仅改变
//    两处决策点: Sentinel 的告警升级阈值（按 excitationShare 加权）与
//    容量规划的到达率输入（μ + 激发项）；旗标关闭时两条路径与现状逐位一致。

// ═══════════════════ R5-A10 数学进化 E：多维 Hawkes（交叉激发矩阵） ═══════════════════

/** 多维指数核 Hawkes 参数：基底 μ_d + 交叉激发矩阵 α_{dd'} + 共享衰减 β */
export interface MultivariateHawkesParams {
  /** 各维基底强度 μ_d（simulate 要求全 >0；其余 ≥0） */
  mu: number[];
  /** D×D 交叉激发矩阵：alpha[d][d'] = d' 维事件对 d 维强度的瞬时增益（≥0） */
  alpha: number[][];
  /** 共享衰减率 β（>0） */
  beta: number;
}

/** 多维事件（全局时间轴 + 维度标签） */
export interface MultivariateEvent {
  t: number;
  dim: number;
}

export interface MultivariateHawkesFit {
  mu: number[];
  alpha: number[][];
  beta: number;
  /** 谱半径 ρ(α̂/β̂)（矩阵分支比的 Perron 根；< 1 平稳） */
  eta: number;
  logLik: number;
  iterations: number;
  converged: boolean;
}

/**
 * 非负矩阵谱半径（幂迭代，确定性 200 步，v₀=全 1）。
 * 分支结构的矩阵推广: η = ρ(α/β)——每事件的后代期望由矩阵 Perron 根给出，
 * η ≥ 1 时多维权群超临界爆炸。
 */
export function spectralRadius(matrix: ReadonlyArray<ReadonlyArray<number>>): number {
  const n = matrix.length;
  if (n === 0) return 0;
  for (const row of matrix) if (row.length !== n) return NaN;
  let v = new Array<number>(n).fill(1 / Math.sqrt(n));
  let estimate = 0;
  for (let it = 0; it < 200; it += 1) {
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      let s = 0;
      for (let j = 0; j < n; j += 1) s += matrix[i][j] * v[j];
      next[i] = s;
    }
    const norm = Math.sqrt(next.reduce((s, x) => s + x * x, 0));
    if (!(norm > 0)) return 0; // 幂零（三角严格下/上三角）→ 谱半径 0 一侧
    estimate = norm; // ‖Bv‖₂/‖v‖₂（v 已单位化）= Rayleigh 型估计
    v = next.map((x) => x / norm);
  }
  return estimate;
}

function validateMultivariate(params: MultivariateHawkesParams, label: string, requirePositiveMu: boolean): void {
  const { mu, alpha, beta } = params;
  const d = mu.length;
  if (d < 1) throw new Error(`${label}: 至少 1 个维度（得到 ${d}）`);
  if (alpha.length !== d || alpha.some((row) => row.length !== d)) {
    throw new Error(`${label}: alpha 须为 ${d}×${d} 方阵`);
  }
  for (const m of mu) {
    if (!Number.isFinite(m)) throw new Error(`${label}: μ 各分量须为有限数`);
    if (requirePositiveMu ? !(m > 0) : !(m >= 0)) {
      throw new Error(`${label}: μ 各分量 ${requirePositiveMu ? '>' : '≥'} 0 必需`);
    }
  }
  for (const row of alpha) {
    for (const a of row) {
      if (!Number.isFinite(a) || a < 0) throw new Error(`${label}: alpha 各元素须为非负有限数`);
    }
  }
  if (!(beta > 0) || !Number.isFinite(beta)) throw new Error(`${label}: β > 0 必需`);
  const eta = spectralRadius(alpha.map((row) => row.map((a) => a / beta)));
  if (!(eta < 1)) {
    throw new Error(`${label}: 平稳性要求谱半径 ρ(α/β)<1（得到 ${eta.toFixed(4)}——超临界多维分支爆炸，构造层拒绝）`);
  }
}

/**
 * 多维 thinning 仿真（叠加口径）：总强度 Λ(t) = Σ_d λ_d(t) 单调不增于
 * 事件间隙 → 总强度为候选步长上界，接受后按 λ_d/Λ 选维。
 * 复杂度 O(D²·N)（选维仅在接受时算，均摊 O(D²) 每事件）。
 */
export function simulateMultivariate(
  input: MultivariateHawkesParams & { T: number; seed: number },
): MultivariateEvent[] {
  const { mu, alpha, beta, T, seed } = input;
  validateMultivariate({ mu, alpha, beta }, 'simulateMultivariate', true);
  if (!(T > 0) || !Number.isFinite(T)) throw new Error(`simulateMultivariate: T > 0 必需（得到 ${T}）`);
  if (!Number.isFinite(seed)) throw new Error(`simulateMultivariate: seed 必须为有限数`);
  const d = mu.length;
  const rand = mulberry32(seed);
  // 列和 w[d'] = Σ_d α[d][d']（常量）——候选步长只需列和，O(D) 每步
  const w = new Array<number>(d).fill(0);
  for (let i = 0; i < d; i += 1) for (let j = 0; j < d; j += 1) w[j] += alpha[i][j];
  const muSum = mu.reduce((s, x) => s + x, 0);
  const events: MultivariateEvent[] = [];
  const a = new Array<number>(d).fill(0); // A[d'] = Σ e^{−β(t−t_i^{d'})}
  let t = 0;
  for (;;) {
    let bound = muSum;
    for (let j = 0; j < d; j += 1) bound += w[j] * a[j];
    const step = -Math.log(Math.max(1 - rand(), Number.MIN_VALUE)) / bound;
    if (step <= 0) continue;
    const candidate = t + step;
    if (candidate > T) break;
    const decay = Math.exp(-beta * step);
    for (let j = 0; j < d; j += 1) a[j] *= decay;
    let total = muSum;
    for (let j = 0; j < d; j += 1) total += w[j] * a[j];
    if (rand() * bound < total) {
      // 选维: λ_d = μ_d + Σ_{d'} α[d][d']·A[d']，按 λ_d/Λ 取样
      const pick = rand() * total;
      let acc = 0;
      let chosen = d - 1;
      for (let i = 0; i < d; i += 1) {
        let lam = mu[i];
        for (let j = 0; j < d; j += 1) lam += alpha[i][j] * a[j];
        acc += lam;
        if (pick < acc) {
          chosen = i;
          break;
        }
      }
      events.push({ t: candidate, dim: chosen });
      a[chosen] += 1;
    }
    t = candidate;
  }
  return events;
}

/** 多维事件流按维拆分（fitHawkesMultivariate 的输入口径） */
export function splitByDim(events: ReadonlyArray<MultivariateEvent>, dims: number): number[][] {
  const out: number[][] = Array.from({ length: dims }, () => []);
  for (const e of events) {
    if (e.dim >= 0 && e.dim < dims) out[e.dim].push(e.t);
  }
  return out;
}

/** 合并多维事件流为全局时间轴（各维内部须递增） */
function mergeByDim(eventsByDim: ReadonlyArray<ReadonlyArray<number>>, label: string): MultivariateEvent[] {
  const heads = eventsByDim.map((xs) => [...xs].sort((x, y) => x - y));
  const merged: MultivariateEvent[] = [];
  const idx = new Array<number>(heads.length).fill(0);
  for (;;) {
    let best = -1;
    for (let d = 0; d < heads.length; d += 1) {
      if (idx[d] < heads[d].length && (best < 0 || heads[d][idx[d]] < heads[best][idx[best]])) best = d;
    }
    if (best < 0) break;
    merged.push({ t: heads[best][idx[best]], dim: best });
    idx[best] += 1;
  }
  if (merged.length > 1) {
    for (let i = 1; i < merged.length; i += 1) {
      if (!(merged[i].t > merged[i - 1].t)) {
        throw new Error(`${label}: 事件时间须严格递增（跨维允许并列拒绝，t=${merged[i].t}）`);
      }
    }
  }
  return merged;
}

/**
 * 多维对数似然（共享 β 指数核）:
 *   ℓ = Σ_d Σ_{j∈d} log λ_d(t_j) − Σ_d μ_d T
 *       − Σ_{d'} (Σ_d α_{dd'})/β · Σ_{i∈d'}(1−e^{−β(T−t_i^{d'})})
 */
export function multivariateLogLik(params: MultivariateHawkesParams, eventsByDim: ReadonlyArray<ReadonlyArray<number>>, T?: number): number {
  validateMultivariate(params, 'multivariateLogLik', true);
  const d = params.mu.length;
  if (eventsByDim.length !== d) throw new Error(`multivariateLogLik: 事件流维度 ${eventsByDim.length} ≠ 参数维度 ${d}`);
  const all = eventsByDim.flat();
  const tEnd = T ?? (all.length > 0 ? Math.max(...all) : 0);
  if (!(tEnd > 0)) throw new Error(`multivariateLogLik: T > 0 必需（得到 ${tEnd}）`);
  for (const xs of eventsByDim) for (let i = 1; i < xs.length; i += 1) {
    if (!(xs[i] > xs[i - 1])) throw new Error('multivariateLogLik: 各维事件时间须严格递增');
  }
  const merged = mergeByDim(eventsByDim, 'multivariateLogLik');
  const { mu, alpha, beta } = params;
  const a = new Array<number>(d).fill(0);
  const lastT = new Array<number>(d).fill(0);
  let sumLog = 0;
  for (const e of merged) {
    for (let j = 0; j < d; j += 1) a[j] *= Math.exp(-beta * (e.t - lastT[j]));
    for (let j = 0; j < d; j += 1) lastT[j] = e.t; // 只更新时间戳，A 不含当前事件
    let lam = mu[e.dim];
    for (let j = 0; j < d; j += 1) lam += alpha[e.dim][j] * a[j];
    if (!(lam > 0)) return Number.NEGATIVE_INFINITY;
    sumLog += Math.log(lam);
    a[e.dim] += 1;
  }
  let penalty = 0;
  for (let j = 0; j < d; j += 1) {
    const colSum = mu.reduce((s, _m, i) => s + alpha[i][j], 0); // Σ_i α_{ij}（j 列和）
    let mass = 0;
    for (const t of eventsByDim[j]) mass += -Math.expm1(-beta * (tEnd - t));
    penalty += (colSum / beta) * mass;
  }
  let muTerm = 0;
  for (let i = 0; i < d; i += 1) muTerm += mu[i] * tEnd;
  return sumLog - muTerm - penalty;
}

/** K_{d'}(β) = Σ_{i∈d'}(1−e^{−β(T−t_i)})/β —— d' 维激发核在剩余窗的积分质量 */
function excitationMassDim(beta: number, times: ReadonlyArray<number>, T: number): number {
  let k = 0;
  for (const t of times) k += -Math.expm1(-beta * (T - t));
  return k / beta;
}

/**
 * 多维 EM 拟合（共享 β，O(D²N)/迭代）。
 * E 步: 事件 j∈dim d 的责任分配 P(移民)=μ_d/λ_d、P(父∈d')=α_{dd'}A_{d'}/λ_d；
 *   n_{dd'} = Σ_{j∈d}（d' 父的期望数），S_{dd'} 对应加权的父-子时距和。
 * M 步: μ̂_d = n_imm,d/T；β̂ 极小化轮廓 Σ n_{dd'}log K_{d'}(β) + βS（α 已
 *   闭式轮廓 α_{dd'}(β) = n_{dd'}/K_{d'}(β)）；α̂ 谱半径钳位 < etaCeiling。
 */
export function fitHawkesMultivariate(
  eventsByDim: ReadonlyArray<ReadonlyArray<number>>,
  options?: { iters?: number; T?: number; init?: Partial<MultivariateHawkesParams> },
): MultivariateHawkesFit {
  const d = eventsByDim.length;
  if (d < 1) throw new Error(`fitHawkesMultivariate: 至少 1 维`);
  for (const xs of eventsByDim) {
    if (xs.length < 8) throw new Error(`fitHawkesMultivariate: 每维至少 8 个事件`);
    for (let i = 0; i < xs.length; i += 1) {
      if (!Number.isFinite(xs[i]) || xs[i] < 0) throw new Error('fitHawkesMultivariate: 事件时间须为非负有限数');
      if (i > 0 && !(xs[i] > xs[i - 1])) throw new Error('fitHawkesMultivariate: 各维事件时间须严格递增');
    }
  }
  const iters = options?.iters ?? HAWKES_DEFAULTS.iters;
  if (!Number.isInteger(iters) || iters < 1 || iters > 100000) {
    throw new Error(`fitHawkesMultivariate: iters 须为 [1,100000] 内整数（得到 ${iters}）`);
  }
  const all = eventsByDim.flat();
  const T = options?.T ?? Math.max(...all);
  if (!(T > 0)) throw new Error(`fitHawkesMultivariate: T > 0 必需`);
  const counts = eventsByDim.map((xs) => xs.length);
  const total = counts.reduce((s, x) => s + x, 0);
  // 矩匹配初值（可被 init 覆盖）
  let beta = options?.init?.beta ?? total / T;
  if (!(beta > 0)) beta = total / T;
  const mu = options?.init?.mu ?? counts.map((n) => Math.max((n / T) * 0.7, 1e-12));
  let alpha: number[][] = options?.init?.alpha
    ? options.init.alpha.map((r) => [...r])
    : Array.from({ length: d }, () => new Array<number>(d).fill((0.3 * beta) / d));
  for (let i = 0; i < d; i += 1) if (!(mu[i] > 0)) mu[i] = 1e-12;
  // 初值谱半径钳位
  let r0 = spectralRadius(alpha.map((row) => row.map((x) => x / beta)));
  if (!(r0 < HAWKES_DEFAULTS.etaCeiling)) {
    const scale = HAWKES_DEFAULTS.etaCeiling / (r0 || 1);
    alpha = alpha.map((row) => row.map((x) => x * scale));
  }
  const merged = mergeByDim(eventsByDim, 'fitHawkesMultivariate');
  let converged = false;
  let iterations = 0;
  for (let it = 0; it < iters; it += 1) {
    iterations = it + 1;
    // ── E 步（链式 O(D²N)：每事件衰减 D 链 + 责任按行展开）──
    const a = new Array<number>(d).fill(0); // A[d']：Σ e^{−β(t−t_i^{d'})}
    const w = new Array<number>(d).fill(0); // W[d']：Σ (t−t_i^{d'})e^{−β(t−t_i^{d'})}
    const lastT = new Array<number>(d).fill(0);
    const nImm = new Array<number>(d).fill(0);
    const nOff = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    const sPair = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    for (const e of merged) {
      for (let j = 0; j < d; j += 1) {
        const dj = Math.exp(-beta * (e.t - lastT[j]));
        w[j] = (w[j] + (e.t - lastT[j]) * a[j]) * dj;
        a[j] *= dj;
        lastT[j] = e.t;
      }
      let lam = mu[e.dim];
      for (let j = 0; j < d; j += 1) lam += alpha[e.dim][j] * a[j];
      if (!(lam > 1e-300)) lam = 1e-300; // 数值保护
      const invLam = 1 / lam;
      nImm[e.dim] += (mu[e.dim] * invLam);
      for (let j = 0; j < d; j += 1) {
        const share = alpha[e.dim][j] * a[j] * invLam; // 期望父数贡献（d'→d）
        nOff[e.dim][j] += share;
        sPair[e.dim][j] += alpha[e.dim][j] * w[j] * invLam; // 加权父-子时距和（β 轮廓用）
      }
      a[e.dim] += 1;
    }
    // ── M 步 ──
    const muNew = mu.map((_m, i) => Math.max(nImm[i] / T, 1e-12));
    const sTotal = sPair.reduce((s, row) => s + row.reduce((x, y) => x + y, 0), 0);
    const nOffTotal = nOff.reduce((s, row) => s + row.reduce((x, y) => x + y, 0), 0);
    let betaNew = beta;
    let alphaNew = alpha.map((row) => row.map((x) => x));
    if (nOffTotal > 1e-12) {
      const objective = (b: number): number => {
        let f = 0;
        for (let j = 0; j < d; j += 1) {
          if (eventsByDim[j].length === 0) continue;
          const k = excitationMassDim(b, eventsByDim[j], T);
          if (!(k > 0)) return Number.POSITIVE_INFINITY;
          let nCol = 0;
          for (let i = 0; i < d; i += 1) nCol += nOff[i][j];
          if (nCol > 0) f += nCol * Math.log(k);
        }
        return f + b * sTotal;
      };
      // 对数粗网格 + 黄金分割（与一维同法）
      const lo = 0.1 / T;
      const hi = (50 * total) / T;
      const grid = HAWKES_DEFAULTS.betaGrid;
      const step = Math.pow(hi / lo, 1 / grid);
      let best = lo;
      let bestValue = Infinity;
      for (let g = 0; g <= grid; g += 1) {
        const b = g === grid ? hi : lo * Math.pow(step, g);
        const v = objective(b);
        if (v < bestValue) {
          bestValue = v;
          best = b;
        }
      }
      let xLo = Math.max(lo, best / step);
      let xHi = Math.min(hi, best * step);
      const invPhi = (Math.sqrt(5) - 1) / 2;
      let x1 = xHi - invPhi * (xHi - xLo);
      let x2 = xLo + invPhi * (xHi - xLo);
      let f1 = objective(x1);
      let f2 = objective(x2);
      for (let g = 0; g < HAWKES_DEFAULTS.betaGolden && xHi - xLo > 1e-12 * xHi; g += 1) {
        if (f1 <= f2) {
          xHi = x2;
          x2 = x1;
          f2 = f1;
          x1 = xHi - invPhi * (xHi - xLo);
          f1 = objective(x1);
        } else {
          xLo = x1;
          x1 = x2;
          f1 = f2;
          x2 = xLo + invPhi * (xHi - xLo);
          f2 = objective(x2);
        }
      }
      betaNew = (xLo + xHi) / 2;
      const alphaEst = Array.from({ length: d }, () => new Array<number>(d).fill(0));
      for (let j = 0; j < d; j += 1) {
        const k = excitationMassDim(betaNew, eventsByDim[j], T);
        for (let i = 0; i < d; i += 1) alphaEst[i][j] = k > 0 ? nOff[i][j] / k : 0;
      }
      // 谱半径钳位（平稳性硬保证）
      const radius = spectralRadius(alphaEst.map((row) => row.map((x) => x / betaNew)));
      const scale = radius >= HAWKES_DEFAULTS.etaCeiling ? HAWKES_DEFAULTS.etaCeiling / (radius || 1) : 1;
      alphaNew = alphaEst.map((row) => row.map((x) => x * scale));
    }
    let delta = 0;
    for (let i = 0; i < d; i += 1) delta = Math.max(delta, Math.abs(muNew[i] - mu[i]));
    for (let i = 0; i < d; i += 1) for (let j = 0; j < d; j += 1) delta = Math.max(delta, Math.abs(alphaNew[i][j] - alpha[i][j]));
    delta = Math.max(delta, Math.abs(betaNew - beta));
    for (let i = 0; i < d; i += 1) mu[i] = muNew[i];
    alpha = alphaNew;
    beta = betaNew;
    if (delta < 1e-10) {
      converged = true;
      break;
    }
  }
  return {
    mu,
    alpha,
    beta,
    eta: spectralRadius(alpha.map((row) => row.map((x) => x / beta))),
    logLik: multivariateLogLik({ mu, alpha, beta }, eventsByDim, T),
    iterations,
    converged,
  };
}

// ═══════════════════ R5-A10 数学进化 F：补偿器残差的 KS 检验升级 ═══════════════════

export interface KsTestReport {
  n: number;
  /** KS 统计量 D_n = sup_x |F_n(x) − F(x)|（F 为 Exp(1) CDF，完全指定） */
  statistic: number;
  /** Kolmogorov 渐近上侧 p 值 Q(√n·D_n)（无参数估计的精确渐近口径） */
  pValue: number;
}

/** Kolmogorov 分布上侧尾 Q(λ) = 2Σ_{k≥1}(−1)^{k−1}e^{−2k²λ²}（确定性级数，交错快收敛） */
export function kolmogorovUpperTail(lambda: number): number {
  if (!(lambda > 0)) return 1;
  if (lambda > 4) return 0; // Q(4) ≈ 3e-15 以下
  let sum = 0;
  for (let k = 1; k <= 500; k += 1) {
    const term = 2 * Math.exp(-2 * k * k * lambda * lambda);
    sum += k % 2 === 1 ? term : -term;
    if (term < 1e-17 * (Math.abs(sum) + 1e-300) && k > 2) break;
  }
  return Math.min(1, Math.max(0, sum));
}

/**
 * 残差 Exp(1) 假设的 Kolmogorov–Smirnov 检验（补偿器检验的分布形状升级）。
 *
 * 时间重标定理只给了 R_k ~ i.i.d. Exp(1)——均值/方差是它的两个点读数，
 * KS 检验整条分布形状: D_n = max(D⁺, D⁻)，
 *   D⁺ = max_i(i/n − F(R_(i)))，D⁻ = max_i(F(R_(i)) − (i−1)/n)
 * 渐近 p = Q(√n·D_n)（参数完全指定口径——真参数或独立标定参数时用）。
 */
export function ksExpOneTest(residuals: ReadonlyArray<number>): KsTestReport {
  const n = residuals.length;
  if (n < 8) return { n, statistic: NaN, pValue: NaN };
  const sorted = [...residuals].filter((r) => Number.isFinite(r) && r >= 0).sort((a, b) => a - b);
  if (sorted.length !== n) return { n, statistic: NaN, pValue: NaN };
  let dPlus = 0;
  let dMinus = 0;
  for (let i = 0; i < n; i += 1) {
    const f = -Math.expm1(-sorted[i]); // 1 − e^{−x}（小 x 精度）
    dPlus = Math.max(dPlus, (i + 1) / n - f);
    dMinus = Math.max(dMinus, f - i / n);
  }
  const statistic = Math.max(dPlus, dMinus);
  return { n, statistic, pValue: kolmogorovUpperTail(Math.sqrt(n) * statistic) };
}
