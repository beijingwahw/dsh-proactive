/**
 * langevin-sampling.ts — 58.0 朗之万采样内核（推断双件套之二：随机采样）
 *
 * 动机: 57.0 给出后验的确定性近似（一个高斯），但系统真正需要的往往不是
 * 「后验长什么样」，而是「从后验里抽一个」——Thompson 采样的免费午餐
 * 来自按后验走，而连续参数空间一直缺采样引擎；18.0 信息几何把变异搬上
 * Fisher 流形，但采样分布仍是盲目高斯，不携带「后验认为哪里值得去」的
 * 任何信息。朗之万动力学把「按后验采样」变成「梯度 + 噪声」：
 *
 *   dX_t = −∇U(X_t)·dt + √2·dW_t    （U = −ln π：目标密度的负对数）
 *
 *   不变分布恰为 Boltzmann π(x) ∝ e^{−U(x)}：梯度把轨道拉向高密度区，
 *   噪声保证不塌缩进众数。本内核两条离散化 + 度量 + 调参：
 *
 * 数学（ULA，最廉价但有偏）:
 *   x⁺ = x − η∇U(x) + √(2η)·ξ —— 欧拉离散，每步 O(d) 最廉价，但**有偏**：
 *   离散化使平稳分布偏离 π。标准高斯目标下偏差有闭式——平稳方差
 *   = 1/(1−η/2)（本内核的验证锚点直接对照这条式子）。强对数凹目标
 *   指数收敛；稳定域 η < 2/λmax(∇²U)。
 *
 * 数学（MALA，精确靶向）:
 *   ULA 提议 + Metropolis–Hastings 接受修正。提议密度**前向不对称**
 *   （均值随 x 移动），接受率必须带提议密度比。口径推导（文档化）:
 *     q(x′|x) = N(x′; x − η∇U(x), 2ηI)
 *     ln α = ln π(x′) − ln π(x) + ln q(x|x′) − ln q(x′|x)
 *          = U(x) − U(x′) + [‖x′ − x + η∇U(x)‖² − ‖x − x′ + η∇U(x′)‖²]/(4η)
 *   两个平方项的口径: 第一个是「从 x 正向跳到 x′」的马氏距离（正向提议
 *   密度 ln q(x′|x) 的核），第二个是「站在 x′ 用 x′ 的局部梯度**反向**跳
 *   回 x」的距离（反向核 ln q(x|x′)）；接受率 = 目标密度比 × (反向核/正向
 *   核)，除以 4η = 2·(2η) 正是协方差 2ηI 的二次型口径。注意符号方向:
 *   **正向减反向**——梯度把提议拉向高密度区，反向跳回更难 ⟹ 接受率被
 *   修正提升。接受-拒绝满足细致平衡 ⟹ π **精确**不变（ULA 的离散化
 *   偏置消失，代价是每步两次梯度求值）。
 *   调参理论: d→∞ 时最优接受率 → 0.574（Roberts–Rosenthal 最优尺度
 *   理论；一维高斯的最优步长即由此标定）；接受率对 η 单调不增 →
 *   tuneStep 在 ln η 上二分逼近目标接受率。
 *
 * 数学（W2 度量）: 采样器质量用高斯闭式 2-Wasserstein 度量
 *   W2²(N(m̂,Σ̂), N(m,Σ)) = ‖m̂−m‖² + tr Σ̂ + tr Σ − 2·tr((Σ^{1/2}Σ̂Σ^{1/2})^{1/2})
 *   对称特征分解（Jacobi 旋转，文件内自带）取矩阵平方根；同时输出
 *   均值误差与协方差 Frobenius 误差两个可读分量。
 *
 * 验证锚点: ①ULA 二维标准高斯 25 万步均值/方差恢复（容差 0.05，且方差
 *   对照平稳偏差闭式 1/(1−η/2)）；②MALA 接受率调参 ∈ [0.4,0.7]，且
 *   η→0 接受率→1 / η 过大接受率崩塌（接受率口径方向的 razor）；③同预算
 *   MALA 均值误差与 W2 均 ≤ ULA（细致平衡换精确性的收益）；④双井势
 *   （非凸）低温/高温的 |x| 边缘与 Boltzmann 权重（数值求积真值）一致
 *   且方向正确（低温集中于井、高温摊平——|x| 统计在两井对称下不依赖
 *   隧道混合：E_π|x| = E_π[|x| | x>0]，单井内的链恰好精确采样它）。
 *
 * ── R5-A3 世界性进化（第五轮）──
 * 数学进化（欠阻尼朗之万）: underdampedMala——动量持久化的精确采样器。
 *   相空间目标 Π(x,v) ∝ e^{−U(x)}·N(v;0,I)（哈密顿量 H = U + ‖v‖²/2）。
 *   每步三段（文档化推导）:
 *     ① 部分动量刷新（精确 OU 步）: v ← ρ·v + √(1−ρ²)·ξ，ρ = e^{−γη}——
 *        v 的 N(0,I) 边缘不变（OU 过程的不变分布），γ→∞ 退化为全刷新
 *        （MALA 型），γ→0 动量完全持久（无摩擦牛顿流）；
 *     ② 蛙跳提议 B-A-B: v½ = v − (η/2)∇U(x)，x′ = x + η·v½，
 *        v′ = v½ − (η/2)∇U(x′)——保体积且在动量翻转下可逆的确定性映射；
 *     ③ Metropolis 修正: ln α = H(x,v) − H(x′,v′)，拒绝时 v ← −v
 *        （involution R(x,v)=(x,−v) 保持核的可逆性 ⟹ Π 精确不变；随后
 *        的 OU 刷新使翻转无害）。x 边缘恰为目标 π。
 *   动量持久 ⟹ 各向异性/缓方向上的有效样本量（ESS）显著高于逐步
 *   独立提议的 MALA（验证脚本做同预算 ESS 对照）。
 *
 * 性能进化（梯度/能量复用）: MALA 每步原本求值 2 次 ∇U + 2 次 U，但接受
 *   步的 ∇U(x′)/U(x′) 恰是下一步的 ∇U(x)/U(x)（拒绝步 x 不变，缓存仍
 *   有效）——缓存传递后每步恰好 1 次新梯度 + 1 次新 U（≈2× 提速），
 *   RNG 消费次序不变 ⟹ 轨迹与原实现逐位一致（验证脚本逐位对照）。
 *
 * 数值稳健性: OU 刷新幅度 √(1−e^{−2γη}) 在小 γη 时遭遇灾难性抵消
 *   （1−ρ² 两个近似量相减），改用恒等式 1−ρ² = −expm1(−γη)·(1+ρ)
 *   （expm1 保相对精度）——浮点上精确到机器精度。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 确定性随机基座 ───────────────────────────

/** mulberry32：32 位确定性伪随机源（种子固定时序列完全可复现） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller 标准正态（随机源注入，保持确定性） */
function gaussianNoise(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ─────────────────────────── 目标规格 ───────────────────────────

/** 朗之万目标：U(x) = −ln π(x)，gradU 必需，logU 供 MALA 接受率 */
export interface LangevinTarget {
  /** ∇U(x)（长度 dim） */
  gradU: (x: number[]) => number[];
  /** U(x)（MALA 必需；ULA 不用） */
  logU: (x: number[]) => number;
}

/** 一维最优尺度理论的目标接受率（Roberts–Rosenthal） */
export const MALA_OPTIMAL_ACCEPT = 0.574;

// ─────────────────────────── 入参校验与工具 ───────────────────────────

interface CommonChain {
  dim: number;
  eta: number;
  steps: number;
  burnIn: number;
  thin: number;
  x0: number[];
}

function validateCommon(
  label: string,
  o: { dim: number; eta: number; steps: number; seed: number; x0?: number[]; burnIn?: number; thin?: number },
): CommonChain {
  if (!Number.isInteger(o.dim) || o.dim < 1) throw new Error(`${label}: dim 需为 ≥ 1 的整数`);
  if (!(o.eta > 0) || !Number.isFinite(o.eta)) throw new Error(`${label}: eta 必须 > 0`);
  if (!Number.isInteger(o.steps) || o.steps < 1 || o.steps > 50_000_000) {
    throw new Error(`${label}: steps 需为 1..5e7 的整数`);
  }
  if (!Number.isFinite(o.seed)) throw new Error(`${label}: seed 需为有限数`);
  const burnIn = o.burnIn ?? 0;
  if (!Number.isInteger(burnIn) || burnIn < 0 || burnIn >= o.steps) {
    throw new Error(`${label}: burnIn 需为 0..steps−1 的整数（至少保留一个样本）`);
  }
  const thin = o.thin ?? 1;
  if (!Number.isInteger(thin) || thin < 1) throw new Error(`${label}: thin 需为 ≥ 1 的整数`);
  let x0 = o.x0;
  if (x0 === undefined) {
    x0 = new Array<number>(o.dim).fill(0);
  } else if (!Array.isArray(x0) || x0.length !== o.dim || x0.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error(`${label}: x0 需为长度 dim 的有限数值数组`);
  }
  return { dim: o.dim, eta: o.eta, steps: o.steps, burnIn, thin, x0: [...x0] };
}

function callGrad(gradU: (x: number[]) => number[], x: number[], dim: number): number[] {
  const g = gradU(x);
  if (!Array.isArray(g) || g.length !== dim || g.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error('langevin: gradU 需返回长度 dim 的有限数值数组');
  }
  return g;
}

function callLogU(logU: (x: number[]) => number, x: number[]): number {
  const v = logU(x);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('langevin: logU 需返回有限数值');
  return v;
}

/** 样本均值与协方差（MLE 口径 1/N——W2 公式的经验高斯矩） */
export function empiricalMeanCov(samples: number[][]): { mean: number[]; cov: number[][] } {
  if (!Array.isArray(samples) || samples.length < 2) throw new Error('empiricalMeanCov: 至少需要 2 个样本');
  const n = samples.length;
  const d = samples[0].length;
  if (!Number.isInteger(d) || d < 1) throw new Error('empiricalMeanCov: 样本需为等长向量');
  for (const s of samples) {
    if (!Array.isArray(s) || s.length !== d || s.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      throw new Error('empiricalMeanCov: 样本需为等长有限数值向量');
    }
  }
  const mean = new Array<number>(d).fill(0);
  for (const s of samples) {
    for (let j = 0; j < d; j += 1) mean[j] += s[j] / n;
  }
  const cov: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (const s of samples) {
    for (let i = 0; i < d; i += 1) {
      for (let j = 0; j < d; j += 1) cov[i][j] += ((s[i] - mean[i]) * (s[j] - mean[j])) / n;
    }
  }
  return { mean, cov };
}

// ─────────────────────────── 采样器 ───────────────────────────

export interface UlaOptions {
  /** ∇U（U = −ln π） */
  gradU: (x: number[]) => number[];
  dim: number;
  /** 步长 η（稳定域 η < 2/λmax(∇²U)；偏置 ∝ η） */
  eta: number;
  /** 总步数（含 burnIn） */
  steps: number;
  seed: number;
  /** 初始点（缺省原点） */
  x0?: number[];
  /** 预热步数（缺省 0，不保留） */
  burnIn?: number;
  /** 稀疏保留间隔（缺省 1 全保留） */
  thin?: number;
}

export interface UlaResult {
  /** 预热后按 thin 保留的样本（samples[k][i]） */
  samples: number[][];
  /** 样本均值 */
  mean: number[];
  /** 样本协方差（MLE） */
  cov: number[][];
}

/**
 * ULA（Unadjusted Langevin Algorithm）：
 *   x⁺ = x − η∇U(x) + √(2η)·ξ
 * 每步一次梯度求值，最快但带 O(η) 平稳偏置（标准高斯下平稳方差
 * 1/(1−η/2)）。适合粗混出候选 / MALA 的 warm start。
 */
export function ula(o: UlaOptions): UlaResult {
  const c = validateCommon('ula', o);
  if (typeof o.gradU !== 'function') throw new Error('ula: gradU 需为函数');
  const rng = mulberry32(o.seed);
  const x = [...c.x0];
  const kept: number[][] = [];
  const sd = Math.sqrt(2 * c.eta);
  for (let k = 0; k < c.steps; k += 1) {
    const g = callGrad(o.gradU, x, c.dim);
    for (let i = 0; i < c.dim; i += 1) x[i] = x[i] - c.eta * g[i] + sd * gaussianNoise(rng);
    if (k >= c.burnIn && (k - c.burnIn) % c.thin === 0) kept.push([...x]);
  }
  const { mean, cov } = empiricalMeanCov(kept);
  return { samples: kept, mean, cov };
}

export interface MalaOptions extends UlaOptions {
  /** U(x)（接受率必需） */
  logU: (x: number[]) => number;
}

export interface MalaResult extends UlaResult {
  /** 接受率（accepted / steps） */
  acceptRate: number;
  /** 接受步数 */
  accepted: number;
}

/**
 * MALA（Metropolis-adjusted Langevin Algorithm）：ULA 提议 +
 * 前向/反向提议密度不对称修正的 Metropolis 接受，细致平衡 ⟹ 精确 π：
 *   ln α = U(x) − U(x′) + [‖x′ − x + η∇U(x)‖² − ‖x − x′ + η∇U(x′)‖²]/(4η)
 * 每步两次梯度 + 两次 U。接受率是链混合的健康度（目标 ≈ 0.574）。
 *
 * R5-A3 梯度/能量复用：接受步的 gp/Uxp 恰为下一步的 g/Ux（拒绝步 x 不变，
 * 缓存仍有效）——缓存传递后每步 1 次新 ∇U + 1 次新 U（原 2+2）。
 * RNG 消费次序不变 ⟹ 轨迹/接受率与原实现逐位一致（假设 gradU/logU 为
 * 纯函数——接口契约本就如此）。
 */
export function mala(o: MalaOptions): MalaResult {
  const c = validateCommon('mala', o);
  if (typeof o.gradU !== 'function') throw new Error('mala: gradU 需为函数');
  if (typeof o.logU !== 'function') throw new Error('mala: logU 需为函数');
  const rng = mulberry32(o.seed);
  let x = [...c.x0];
  const kept: number[][] = [];
  const sd = Math.sqrt(2 * c.eta);
  const inv4 = 1 / (4 * c.eta);
  let accepted = 0;
  let g = callGrad(o.gradU, x, c.dim);
  let Ux = callLogU(o.logU, x);
  for (let k = 0; k < c.steps; k += 1) {
    const xp = new Array<number>(c.dim);
    for (let i = 0; i < c.dim; i += 1) xp[i] = x[i] - c.eta * g[i] + sd * gaussianNoise(rng);
    const gp = callGrad(o.gradU, xp, c.dim);
    const Uxp = callLogU(o.logU, xp);
    // logq(x|x′) − logq(x′|x) = (‖正向跳距‖² − ‖反向跳距‖²)/(4η) 的分子
    let rev = 0;
    let fwd = 0;
    for (let i = 0; i < c.dim; i += 1) {
      const dr = x[i] - xp[i] + c.eta * gp[i];
      const df = xp[i] - x[i] + c.eta * g[i];
      rev += dr * dr;
      fwd += df * df;
    }
    const logAlpha = Ux - Uxp + (fwd - rev) * inv4;
    const u = rng();
    if (u === 0 || Math.log(u) < logAlpha) {
      x = xp;
      g = gp;
      Ux = Uxp;
      accepted += 1;
    }
    if (k >= c.burnIn && (k - c.burnIn) % c.thin === 0) kept.push([...x]);
  }
  const { mean, cov } = empiricalMeanCov(kept);
  return { samples: kept, mean, cov, acceptRate: accepted / c.steps, accepted };
}

// ─────────────────────────── 欠阻尼朗之万（R5-A3） ───────────────────────────

/** 蛙跳提议的返回：提议点 (x2,v2) 与提议点梯度（供采样器复用） */
export interface LeapfrogProposal {
  x2: number[];
  v2: number[];
  /** ∇U(x2)（已求值，underdampedMala 接受后传递给下一步） */
  gradX2: number[];
}

/**
 * 单步 B-A-B 蛙跳提议（保体积、动量翻转下可逆）：
 *   v½ = v − (η/2)∇U(x)，x2 = x + η·v½，v2 = v½ − (η/2)∇U(x2)。
 * 可逆性口径（验证锚点）：R(x,v) = (x,−v) 时 R∘Φ∘R = Φ⁻¹——
 * 从翻转动量出发蛙跳再翻转，恰好回到原点（浮点 1e-10 内）。
 * @param gradX 可选的 ∇U(x)（已算过则复用；缺省现场求值）
 */
export function leapfrogProposal(
  gradU: (x: number[]) => number[],
  x: number[],
  v: number[],
  eta: number,
  gradX?: number[],
): LeapfrogProposal {
  const dim = x.length;
  if (!Array.isArray(v) || v.length !== dim || v.some((t) => typeof t !== 'number' || !Number.isFinite(t))) {
    throw new Error('leapfrogProposal: v 需为长度 dim 的有限数值数组');
  }
  if (!(eta > 0) || !Number.isFinite(eta)) throw new Error('leapfrogProposal: eta 必须 > 0');
  const g = gradX ?? callGrad(gradU, x, dim);
  const vHalf = new Array<number>(dim);
  const x2 = new Array<number>(dim);
  for (let i = 0; i < dim; i += 1) vHalf[i] = v[i] - (eta / 2) * g[i];
  for (let i = 0; i < dim; i += 1) x2[i] = x[i] + eta * vHalf[i];
  const gradX2 = callGrad(gradU, x2, dim);
  const v2 = new Array<number>(dim);
  for (let i = 0; i < dim; i += 1) v2[i] = vHalf[i] - (eta / 2) * gradX2[i];
  return { x2, v2, gradX2 };
}

/**
 * OU 刷新幅度 √(1−e^{−2γη})（R5-A3 数值稳健性）：小 γη 时 1−ρ² 直接
 * 相减损失有效数字，改用 1−ρ² = −expm1(−γη)·(1+ρ)（ρ = e^{−γη}，
 * expm1 保相对精度）——任何 γη > 0 都精确到机器精度。
 */
export function ouRefreshScale(gammaEta: number): number {
  if (!(gammaEta > 0) || !Number.isFinite(gammaEta)) throw new Error('ouRefreshScale: gammaEta 必须 > 0');
  const rho = Math.exp(-gammaEta);
  return Math.sqrt(-Math.expm1(-gammaEta) * (1 + rho));
}

export interface UnderdampedOptions {
  /** ∇U(x)（U = −ln π） */
  gradU: (x: number[]) => number[];
  /** U(x)（MH 接受率必需） */
  logU: (x: number[]) => number;
  dim: number;
  /** 步长 η */
  eta: number;
  /** 摩擦系数 γ（γ→∞ 退化为全刷新/MALA 型；γ→0 动量完全持久） */
  friction: number;
  steps: number;
  seed: number;
  /** 初始位置（缺省原点） */
  x0?: number[];
  /** 初始速度（缺省标准正态，由种子驱动） */
  v0?: number[];
  burnIn?: number;
  thin?: number;
}

export interface UnderdampedResult extends UlaResult {
  /** 接受率（accepted / steps） */
  acceptRate: number;
  /** 接受步数 */
  accepted: number;
}

/**
 * 欠阻尼 MALA（R5-A3）：OU 部分动量刷新 + 蛙跳提议 + 相空间 Metropolis
 * 修正——动量持久化的**精确** π 采样器：
 *   ① v ← ρ·v + √(1−ρ²)·ξ（ρ = e^{−γη}，精确 OU 步，v 边缘不变）
 *   ② (x′,v′) = Leapfrog(x, v)
 *   ③ ln α = H(x,v) − H(x′,v′)，H = U(x) + ‖v‖²/2；拒绝时 v ← −v
 * ①是保持 Π 不变的合法 MCMC 核；②③为 involution 框架下的可逆 MH
 * （R∘Φ∘R = Φ⁻¹）⟹ 联合核细致平衡，Π(x,v) 精确不变，x 边缘 = π。
 * 动量持久 ⟹ 缓方向 ESS 显著优于逐步独立提议。
 */
export function underdampedMala(o: UnderdampedOptions): UnderdampedResult {
  const c = validateCommon('underdampedMala', o);
  if (typeof o.gradU !== 'function') throw new Error('underdampedMala: gradU 需为函数');
  if (typeof o.logU !== 'function') throw new Error('underdampedMala: logU 需为函数');
  if (!(o.friction > 0) || !Number.isFinite(o.friction)) throw new Error('underdampedMala: friction 必须 > 0');
  const rng = mulberry32(o.seed);
  let x = [...c.x0];
  let v: number[];
  if (o.v0 !== undefined) {
    if (!Array.isArray(o.v0) || o.v0.length !== c.dim || o.v0.some((t) => typeof t !== 'number' || !Number.isFinite(t))) {
      throw new Error('underdampedMala: v0 需为长度 dim 的有限数值数组');
    }
    v = [...o.v0];
  } else {
    v = Array.from({ length: c.dim }, () => gaussianNoise(rng));
  }
  const rho = Math.exp(-o.friction * c.eta);
  const refresh = ouRefreshScale(o.friction * c.eta);
  const kept: number[][] = [];
  let accepted = 0;
  let g = callGrad(o.gradU, x, c.dim);
  let Ux = callLogU(o.logU, x);
  let vEnergy = 0;
  for (let i = 0; i < c.dim; i += 1) vEnergy += v[i] * v[i];
  for (let k = 0; k < c.steps; k += 1) {
    // ① 精确 OU 刷新（v 的 N(0,I) 边缘不变）
    for (let i = 0; i < c.dim; i += 1) v[i] = rho * v[i] + refresh * gaussianNoise(rng);
    vEnergy = 0;
    for (let i = 0; i < c.dim; i += 1) vEnergy += v[i] * v[i];
    // ② 蛙跳提议（∇U(x) 复用缓存 g）
    const { x2, v2, gradX2 } = leapfrogProposal(o.gradU, x, v, c.eta, g);
    const Ux2 = callLogU(o.logU, x2);
    let v2Energy = 0;
    for (let i = 0; i < c.dim; i += 1) v2Energy += v2[i] * v2[i];
    // ③ 相空间 MH：ln α = H(x,v) − H(x′,v′)；拒绝时翻转动量（可逆性）
    const logAlpha = Ux + 0.5 * vEnergy - Ux2 - 0.5 * v2Energy;
    const u = rng();
    if (u === 0 || Math.log(u) < logAlpha) {
      x = x2;
      v = v2;
      g = gradX2;
      Ux = Ux2;
      accepted += 1;
    } else {
      for (let i = 0; i < c.dim; i += 1) v[i] = -v[i];
    }
    if (k >= c.burnIn && (k - c.burnIn) % c.thin === 0) kept.push([...x]);
  }
  const { mean, cov } = empiricalMeanCov(kept);
  return { samples: kept, mean, cov, acceptRate: accepted / c.steps, accepted };
}

// ─────────────────────────── 步长调参 ───────────────────────────

export interface TuneStepOptions {
  gradU: (x: number[]) => number[];
  logU: (x: number[]) => number;
  dim: number;
  /** 试点种子（缺省 58；所有试点同种子 = 公共随机数，接受率对 η 单调性更干净） */
  seed?: number;
  /** 目标接受率（缺省 0.574，最优尺度理论值） */
  targetAccept?: number;
  /** 每个试点 MALA 步数（缺省 400；前 1/4 作预热） */
  pilotSteps?: number;
  /** η 搜索下/上界（缺省 1e-3 / 10，对数域二分） */
  etaMin?: number;
  etaMax?: number;
}

export interface TuneStepResult {
  /** 标定步长 */
  eta: number;
  /** 该 η 的试点接受率 */
  acceptRate: number;
  /** 二分试探次数 */
  probes: number;
}

/**
 * 步长调参：接受率对 η 单调不增 → ln η 域二分逼近目标接受率。
 * 每个试点固定同一种子（CRN），22 次二分把 ln η 区间缩到 ~1e-7 相对宽。
 */
export function tuneStep(o: TuneStepOptions): TuneStepResult {
  if (typeof o.gradU !== 'function' || typeof o.logU !== 'function') {
    throw new Error('tuneStep: gradU 与 logU 需为函数');
  }
  if (!Number.isInteger(o.dim) || o.dim < 1) throw new Error('tuneStep: dim 需为 ≥ 1 的整数');
  const target = o.targetAccept ?? MALA_OPTIMAL_ACCEPT;
  if (!(target > 0 && target < 1)) throw new Error('tuneStep: targetAccept 需在 (0,1)');
  const pilot = o.pilotSteps ?? 400;
  if (!Number.isInteger(pilot) || pilot < 20 || pilot > 100_000) {
    throw new Error('tuneStep: pilotSteps 需为 20..1e5 的整数');
  }
  const seed = o.seed ?? 58;
  let lo = o.etaMin ?? 1e-3;
  let hi = o.etaMax ?? 10;
  if (!(lo > 0) || !(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    throw new Error('tuneStep: 需 0 < etaMin < etaMax');
  }
  const burn = Math.floor(pilot / 4);
  const x0 = new Array<number>(o.dim).fill(0);
  let best: TuneStepResult = { eta: Math.sqrt(lo * hi), acceptRate: 1, probes: 0 };
  let probes = 0;
  for (let k = 0; k < 22; k += 1) {
    const eta = Math.sqrt(lo * hi);
    const r = mala({ gradU: o.gradU, logU: o.logU, dim: o.dim, eta, steps: pilot, seed, x0, burnIn: burn });
    probes += 1;
    best = { eta, acceptRate: r.acceptRate, probes };
    if (r.acceptRate > target) lo = eta; // 接受率偏高 → 加大步长
    else hi = eta;
  }
  return best;
}

// ─────────────────────────── 目标工厂 ───────────────────────────

export interface GaussianTargetOptions {
  /** 均值（缺省全 0） */
  mean?: number[];
  /** 各维标准差（缺省全 1，对角协方差） */
  std?: number[];
}

export interface GaussianTarget extends LangevinTarget {
  mean: number[];
  std: number[];
}

/**
 * 高斯目标工厂：U(x) = ½Σ((x_i−μ_i)/σ_i)²（强对数凹，朗之万收敛理论
 * 的标准测试床；∇U_i = (x_i−μ_i)/σ_i²）。
 */
export function gaussianTarget(dim: number, opts?: GaussianTargetOptions): GaussianTarget {
  if (!Number.isInteger(dim) || dim < 1) throw new Error('gaussianTarget: dim 需为 ≥ 1 的整数');
  const mean = opts?.mean ?? new Array<number>(dim).fill(0);
  const std = opts?.std ?? new Array<number>(dim).fill(1);
  if (!Array.isArray(mean) || mean.length !== dim || mean.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error('gaussianTarget: mean 需为长度 dim 的有限数值数组');
  }
  if (!Array.isArray(std) || std.length !== dim || std.some((v) => !(v > 0) || !Number.isFinite(v))) {
    throw new Error('gaussianTarget: std 需为长度 dim 的正有限数组');
  }
  const logU = (x: number[]): number => {
    if (!Array.isArray(x) || x.length !== dim) throw new Error('gaussianTarget: 传入向量长度不匹配');
    let s = 0;
    for (let i = 0; i < dim; i += 1) {
      const z = (x[i] - mean[i]) / std[i];
      s += z * z;
    }
    return 0.5 * s;
  };
  const gradU = (x: number[]): number[] => {
    if (!Array.isArray(x) || x.length !== dim) throw new Error('gaussianTarget: 传入向量长度不匹配');
    return x.map((v, i) => (v - mean[i]) / (std[i] * std[i]));
  };
  return { gradU, logU, mean: [...mean], std: [...std] };
}

/**
 * 双井势工厂（1 维非凸测试台）：U(x) = (x²−1)²/T。
 * 井底 ±1（U=0），垒高 1/T——温度 T 低则质量集中于两井，高则摊平；
 * 井底曲率 8/T（稳定步长 η < T/4）。Boltzmann 权重的方向检验用 |x|
 * 统计（两井对称下不依赖隧道混合）。
 */
export function doubleWellTarget(temperature: number): LangevinTarget {
  if (!(temperature > 0) || !Number.isFinite(temperature)) throw new Error('doubleWellTarget: temperature 必须 > 0');
  const logU = (x: number[]): number => {
    if (!Array.isArray(x) || x.length !== 1 || typeof x[0] !== 'number' || !Number.isFinite(x[0])) {
      throw new Error('doubleWellTarget: 需传入长度 1 的有限数值向量');
    }
    const s = x[0] * x[0] - 1;
    return (s * s) / temperature;
  };
  const gradU = (x: number[]): number[] => {
    if (!Array.isArray(x) || x.length !== 1 || typeof x[0] !== 'number' || !Number.isFinite(x[0])) {
      throw new Error('doubleWellTarget: 需传入长度 1 的有限数值向量');
    }
    const v = x[0];
    return [(4 * v * (v * v - 1)) / temperature];
  };
  return { gradU, logU };
}

// ─────────────────────────── 对称特征分解与 W2 度量 ───────────────────────────

/** Jacobi 旋转法对称特征分解（A = V·diag(values)·Vᵀ，V 列为特征向量） */
function jacobiEigen(Ain: number[][]): { values: number[]; vectors: number[][] } {
  const n = Ain.length;
  const A = Ain.map((r) => [...r]);
  const V: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let sweep = 0; sweep < 100; sweep += 1) {
    let off = 0;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) off += A[i][j] * A[i][j];
    }
    if (off < 1e-24) break;
    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        if (Math.abs(A[p][q]) < 1e-18) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k += 1) {
          const akp = A[k][p];
          const akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = A[p][k];
          const aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: A.map((row, i) => row[i]), vectors: V };
}

/** 对称 PSD 矩阵平方根（特征分解口径，负特征值截 0） */
function sqrtmSym(S: number[][]): number[][] {
  const n = S.length;
  const { values, vectors } = jacobiEigen(S);
  const sq = values.map((v) => Math.sqrt(Math.max(0, v)));
  const R: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      let s = 0;
      for (let k = 0; k < n; k += 1) s += vectors[i][k] * sq[k] * vectors[j][k];
      R[i][j] = s;
    }
  }
  return R;
}

export interface W2Report {
  /** 高斯闭式 2-Wasserstein 距离（越小采样器越准） */
  w2: number;
  w2Squared: number;
  /** 均值误差 ‖m̂ − μ‖₂ */
  meanErr: number;
  /** 协方差误差 ‖Σ̂ − Σ‖_F */
  covFrob: number;
}

/**
 * 经验样本高斯矩 vs 真高斯的闭式 2-Wasserstein（Bures 度量）：
 *   W2² = ‖m̂−m‖² + tr Σ̂ + tr Σ − 2·tr((Σ^{1/2}Σ̂Σ^{1/2})^{1/2})
 */
export function w2Gaussian(samples: number[][], trueMean: number[], trueCov: number[][]): W2Report {
  const d = trueMean.length;
  if (!Number.isInteger(d) || d < 1) throw new Error('w2Gaussian: trueMean 需为非空向量');
  if (!Array.isArray(trueCov) || trueCov.length !== d || trueCov.some((r) => !Array.isArray(r) || r.length !== d)) {
    throw new Error('w2Gaussian: trueCov 需为 d×d 矩阵');
  }
  if (
    trueMean.some((v) => typeof v !== 'number' || !Number.isFinite(v)) ||
    trueCov.some((r) => r.some((v) => typeof v !== 'number' || !Number.isFinite(v)))
  ) {
    throw new Error('w2Gaussian: 真值需为有限数值');
  }
  if (samples.length > 0 && samples[0].length !== d) {
    throw new Error('w2Gaussian: 样本维数与真值维数不匹配');
  }
  const { mean, cov } = empiricalMeanCov(samples);
  let meanErrSq = 0;
  for (let i = 0; i < d; i += 1) meanErrSq += (mean[i] - trueMean[i]) ** 2;
  let covFrobSq = 0;
  for (let i = 0; i < d; i += 1) {
    for (let j = 0; j < d; j += 1) covFrobSq += (cov[i][j] - trueCov[i][j]) ** 2;
  }
  // B = Σ^{1/2}·Σ̂·Σ^{1/2}（随后对称化压浮点尘埃）
  const S = sqrtmSym(trueCov);
  const tmp: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (let i = 0; i < d; i += 1) {
    for (let j = 0; j < d; j += 1) {
      let s = 0;
      for (let k = 0; k < d; k += 1) s += S[i][k] * cov[k][j];
      tmp[i][j] = s;
    }
  }
  const B: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (let i = 0; i < d; i += 1) {
    for (let j = 0; j < d; j += 1) {
      let s = 0;
      for (let k = 0; k < d; k += 1) s += tmp[i][k] * S[j][k];
      B[i][j] = s;
    }
  }
  const symB: number[][] = Array.from({ length: d }, (_, i) =>
    Array.from({ length: d }, (_, j) => 0.5 * (B[i][j] + B[j][i])),
  );
  const eig = jacobiEigen(symB);
  let cross = 0;
  for (let k = 0; k < d; k += 1) cross += Math.sqrt(Math.max(0, eig.values[k]));
  let trHat = 0;
  let trTrue = 0;
  for (let i = 0; i < d; i += 1) {
    trHat += cov[i][i];
    trTrue += trueCov[i][i];
  }
  const w2sq = Math.max(0, meanErrSq + trHat + trTrue - 2 * cross);
  return { w2: Math.sqrt(w2sq), w2Squared: w2sq, meanErr: Math.sqrt(meanErrSq), covFrob: Math.sqrt(covFrobSq) };
}

/* ── 接线建议 ──
 * 挂载引擎: strategy-evolution（策略进化器）——18.0 信息几何的采样引擎：
 *   U 取适应度地形的负对数（或 57.0 后验的负对数高斯），变异分布从
 *   「盲目高斯噪声」升级为「按后验 π ∝ e^{−U} 行走的朗之万样本」——
 *   变异第一次知道哪里值得去；MALA 的细致平衡保证变异分布精确等于
 *   目标后验（无 ULA 的离散化偏置），ULA 可作粗混 warm start。
 * 建议方法: strategyEvolution.attachLangevinMutation(options?)——对照
 *   18.0 attachInformationGeometry 的接线模式；options:
 *   { steps, thin, targetAccept, seed }，挂载后变异只读替换噪声源。
 * 缺省关闭旗标: config.kernels.langevinMutationEnabled = false
 *   （未开启时进化器变异路径与现状逐位一致——零介入）。
 * 决策点:
 *   - 变异步长: tuneStep 自标定（目标接受率 0.574）；接受率由进化器
 *     监控作为链混合健康度——接受率崩塌 = 适应度地形曲率突变信号；
 *   - 温度: 非凸地形（双井型）的温度由系统平均不确定性内生（不确定
 *     高 → 高温跨井探索，低 → 低温井内精修），对应 doubleWellTarget(T)；
 *   - 升级门: w2Gaussian 的 W2 超阈（样本高斯矩偏离后验矩）时回退
 *     18.0 原路径（采样器不健康就诚实降级，不污染进化池）。
 */
