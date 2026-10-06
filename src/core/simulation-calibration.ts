/**
 * 94.0 仿真校准内核 —— sim-to-real 差异量化 · 密度比再加权 · 风洞修正
 *
 * 动机: 策略进化沙盒（src/policy/sandbox.ts）的一切判据都建立在「模拟器 =
 * 真实世界」的隐含假设上。沙盒用历史校准表锚定 baseFit（工程级校准），但
 * 它回答不了两个更根本的问题：
 *   - **仿真到底失真多少？** gainLCB ≥ 0 是仿真口径的分位数——若沙盒分布
 *     与操作环分布存在系统性域差（sim-to-real gap），沙盒头名可能在真实
 *     环境一败涂地，且没有任何统计量能报警；
 *   - **仿真数据还能怎么用？** 沙盒里跑出的海量轨迹被「重跑一遍」式使用，
 *     分布不匹配使它们对真实环境的统计推断天然有偏——除非按密度比再加权。
 * 本内核把「仿真可信吗 / 如何折算」变成两样本统计问题：差异量化给出
 * **可信度的度量**，密度比再加权给出**折算的算子**——进化环从仿真到上线
 * 的「风洞修正」第一次有了数学形式。
 *
 * 数学（一维样本口径，全部无 I/O、同输入同输出）:
 *   ① MMD²（Gretton et al. 2012，高斯核无偏 U 统计量）:
 *      MMD²_u[P_sim, P_real] = 1/(m(m−1))·Σ_{i≠j} k(x_i,x_j)
 *                            + 1/(n(n−1))·Σ_{i≠j} k(y_i,y_j)
 *                            − 2/(mn)·Σ_{i,j} k(x_i,y_j)，
 *      k(x,y) = exp(−γ(x−y)²)。零假设（同分布）下期望为 0，估计量可微负
 *      （无偏性的代价，如实保留）；γ 缺省用中位数启发式（池化样本成对距离
 *      中位数 d_med → γ = 1/(2·d_med²)，确定性子采样保证同输入同输出）。
 *      解析锚点: N(0,1) vs N(Δ,1) 的总体 MMD² = 2/√(1+4γ)·(1−e^{−γΔ²/(1+4γ)})。
 *   ② 能量距离（Székely–Rizzo 两样本 E 统计量，V 统计量口径）:
 *      ℰ = 2/(mn)·ΣΣ|x_i−y_j| − 1/m²·ΣΣ|x_i−x_j| − 1/n²·ΣΣ|y_i−y_j|，
 *      同分布时期望 0、异分布严格正（特征函数距离的单调函数）。
 *   ③ 密度比分类器法（Qin 1998; Harmeling 等——logistic 判别 real/sim）:
 *      以标签 real=1/sim=0 训练逻辑回归，平衡先验下总体最优解满足
 *      log odds η*(x) = log[p_real(x)/p_sim(x)]，故
 *      r̂(x) = e^{η̂(x)}·(n_sim/n_real)（类先验修正）。特征 [x, x², 1]
 *      使高斯位移（log r 线性）与缩放（log r 二次）域差都落在模型类内——
 *      闭式比可对照。拟合用 IRLS（牛顿法，3 参数线性方程组，二次收敛，
 *      ridge ≥ 0 保证 Hessian 正定），无学习率、无早停随机性。
 *   ④ 自归一化再加权统计: Ĵ = Σ r̂(x_i)·f(x_i) / Σ r̂(x_i) —— 用仿真样本
 *      估计真实分布下的 E_real[f]，偏差 O(1/n)、估计有界（权重凸组合）；
 *      有效样本量 ESS = (Σr)²/Σr² 度量再加权的方差代价（重度再加权 =
 *      少数样本主导 = 外推风险，进 warnings）。
 *   ⑤ 加权 MMD²（校准口径的 gap）: sim 侧经验测度按权重 u_i = r_i/Σr 归一，
 *      gap = Σ_{ij}u_iu_jk(x_i,x_j) − 2Σ_{ij}u_i/n·k(x_i,y_j) + 1/n²ΣΣk(y_i,y_j)。
 *      校准前（u 均匀）= 有偏 MMD²，校准后应大幅缩小——「再加权把仿真
 *      经验测度搬回真实分布」的直接检验。
 *
 * R5-A17 世界性进化（数学轴 + 稳健轴，2026-10）:
 *   ⑥ 截断重要性加权（协变量偏移校正的方差护栏）: w_i = min(r_i, cap)——
 *      重尾 r 的少数样本主导估计是再加权的头号方差来源（ESS → 1）；
 *      截断后 ESS 单调不降（可证: 截断只压缩权重离散度），代价是偏倚
 *      O(E[(r−cap)⁺])。cap → ∞ 退化为纯 IS（一致性）；cap = max r 时
 *      与纯 IS **逐位一致**（w = r）。ESS 前后对照给出「方差-偏倚」账单。
 *   ⑦ 加权 bootstrap 区间（校准的置信区间）: 按权重 ∝ w 有放回重采样
 *      （种子化、前缀和 + 二分抽样 O(B·log n)），逐副本算加权统计量 f，
 *      取经验分位数 [q_{(1−level)/2}, q_{(1+level)/2}]——E_real[f] 的
 *      区间估计第一次有了可复现的口径；配合 makeDomainGap 的解析真值
 *      （E_real[x] = μ）可做覆盖率的证明性检验（≥200 试验）。
 *
 * 验证锚点（scripts/verify-sim-interrupt.mjs，全部确定性）:
 *   ① 已知解析域差（高斯 μ 位移 / σ 缩放）: 分类器 r̂ 与闭式比的
 *      Pearson 相关 > 0.95（文档化口径），且线性系数 ŵ ≈ μ / 二次系数
 *      ŵ₂ ≈ ½−1/(2σ²)（总体精确解的有限样本恢复）；
 *   ② 再加权后仿真均值/方差 → 真实均值/方差（容差 0.05 级；未加权均值
 *      对照偏差 > 0.5）；
 *   ③ MMD²/能量距离随域差幅度单调增（5 档位移 0→2，γ 固定），且 MMD²
 *      与解析总体值 0.8944·(1−e^{−Δ²/5}) 吻合、能量距离与
 *      2(E|N(Δ,2)|−2/√π) 吻合；
 *   ④ calibrateSim 后 gapAfter < gapBefore/5（大幅缩小）；
 *   ⑤ 同分布退化（零伤害）: r ≈ 1、再加权统计 ≈ 裸统计、加权 gap ≈
 *      均匀 gap；无偏 MMD² 在 sim=sim 时微负（|值| < 0.005，如实断言）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入
 */

// ─────────────────────────── 随机源（文件内自带） ───────────────────────────

/** mulberry32 —— 同 seed 同序列（本内核唯一随机源，供工厂构造样本） */
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

/** Box–Muller 标准正态（u1 取 1−rng() ∈ (0,1] 防 log(0)） */
function standardNormal(rng: () => number): number {
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ─────────────────────────── 校验与基本统计 ───────────────────────────

function validateSample(values: number[], name: string, minLen = 2): number {
  if (!Array.isArray(values) || values.length < minLen) {
    throw new Error(`${name}: 必须为长度 ≥ ${minLen} 的数组`);
  }
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`${name}: 第 ${i} 个样本非有限（${String(v)}）`);
    }
  }
  return values.length;
}

function mean(values: number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

function variance(values: number[]): number {
  const m = mean(values);
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return s / Math.max(1, values.length - 1);
}

function round(value: number, digits = 6): number {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

// ─────────────────────────── ① MMD²（无偏 U 统计量） ───────────────────────────

export interface Mmd2Options {
  /** 高斯核带宽 γ（k = e^{−γ(x−y)²}）；缺省用中位数启发式 */
  gamma?: number;
}

/**
 * 最大均值差异平方（高斯核、无偏双 U 统计量、一维样本）。
 *
 * 同分布期望 0（估计量可微负——无偏性的诚实代价）；γ 缺省取
 * medianHeuristicGamma(sim ∪ real)。O(m·n)。
 */
export function mmd2(sim: number[], real: number[], options?: Mmd2Options): number {
  const m = validateSample(sim, 'mmd2: sim');
  const n = validateSample(real, 'mmd2: real');
  const gamma = options?.gamma ?? medianHeuristicGamma([...sim, ...real]);
  if (!Number.isFinite(gamma) || gamma <= 0) throw new Error('mmd2: gamma 必须为正有限数');
  const k = (a: number, b: number): number => Math.exp(-gamma * (a - b) * (a - b));
  let kxx = 0;
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < m; j += 1) if (i !== j) kxx += k(sim[i] as number, sim[j] as number);
  }
  let kyy = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) if (i !== j) kyy += k(real[i] as number, real[j] as number);
  }
  let kxy = 0;
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < n; j += 1) kxy += k(sim[i] as number, real[j] as number);
  }
  return kxx / (m * (m - 1)) + kyy / (n * (n - 1)) - (2 * kxy) / (m * n);
}

/** 中位数启发式带宽: 池化成对距离中位数 d → γ = 1/(2d²)（确定性子采样 ≤ 512 点） */
export function medianHeuristicGamma(pool: number[]): number {
  validateSample(pool, 'medianHeuristicGamma: pool', 1);
  const stride = Math.max(1, Math.ceil(pool.length / 512));
  const sub: number[] = [];
  for (let i = 0; i < pool.length; i += stride) sub.push(pool[i] as number);
  const dists: number[] = [];
  for (let i = 0; i < sub.length; i += 1) {
    for (let j = i + 1; j < sub.length; j += 1) dists.push(Math.abs((sub[i] as number) - (sub[j] as number)));
  }
  if (dists.length === 0) return 1;
  dists.sort((a, b) => a - b);
  const mid = Math.floor(dists.length / 2);
  const med =
    dists.length % 2 === 1 ? (dists[mid] as number) : ((dists[mid - 1] as number) + (dists[mid] as number)) / 2;
  if (!(med > 1e-12)) return 1;
  return 1 / (2 * med * med);
}

// ─────────────────────────── ② 能量距离 ───────────────────────────

/**
 * 能量距离 ℰ（两样本 E 统计量，V 统计量口径——对角项为零无妨）:
 *   ℰ = 2/(mn)·ΣΣ|xi−yj| − 1/m²·ΣΣ|xi−xj| − 1/n²·ΣΣ|yi−yj|。
 * 同分布期望 0、异分布严格正；与 Cramér–von Mises 距离同源，一维下
 * 与 Cramér 泛函有解析关系（ℰ = 2·∫∫(F_sim−F_real)² dxdy 相关口径）。
 */
export function energyDistance(sim: number[], real: number[]): number {
  const m = validateSample(sim, 'energyDistance: sim');
  const n = validateSample(real, 'energyDistance: real');
  let axy = 0;
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < n; j += 1) axy += Math.abs((sim[i] as number) - (real[j] as number));
  }
  let axx = 0;
  for (let i = 0; i < m; i += 1) {
    for (let j = i + 1; j < m; j += 1) axx += Math.abs((sim[i] as number) - (sim[j] as number));
  }
  let ayy = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) ayy += Math.abs((real[i] as number) - (real[j] as number));
  }
  return (2 * axy) / (m * n) - (2 * axx) / (m * m) - (2 * ayy) / (n * n);
}

// ─────────────────────────── ③ 密度比分类器（IRLS 逻辑回归） ───────────────────────────

export interface DensityRatioOptions {
  /** IRLS 最大迭代数（缺省 50，二次收敛通常 < 15） */
  iters?: number;
  /** ridge 正则（缺省 1e-6，保证 Hessian 正定；0 允许但奇异数据会中止） */
  ridge?: number;
}

/** 密度比模型: 可调用 r(x)，携带诊断（系数/准确率/对数损失/收敛标志） */
export interface DensityRatioModel {
  /** r̂(x) = e^{η̂(x)}·(n_sim/n_real) —— 密度比 p_real(x)/p_sim(x) 的估计 */
  (x: number): number;
  /** log r̂(x)（先验修正后） */
  logRatio(x: number): number;
  /** 学到的系数 [w_x, w_{x²}, b]（特征 [x, x², 1]） */
  coefficients: number[];
  /** 训练池上的分类准确率 */
  accuracy: number;
  /** 训练池上的平均对数损失 */
  logLoss: number;
  /** 实际 IRLS 迭代数 */
  iterations: number;
  /** 是否在 iters 内收敛（max|Δw| < 1e-12） */
  converged: boolean;
}

/** 3×3 线性方程组 H·Δ = g 的高斯消元（部分主元）；奇异返回 undefined */
function solve3(h: number[][], g: number[]): number[] | undefined {
  const a = [
    [h[0]![0] as number, h[0]![1] as number, h[0]![2] as number, g[0] as number],
    [h[1]![0] as number, h[1]![1] as number, h[1]![2] as number, g[1] as number],
    [h[2]![0] as number, h[2]![1] as number, h[2]![2] as number, g[2] as number],
  ];
  for (let col = 0; col < 3; col += 1) {
    let piv = col;
    for (let r = col + 1; r < 3; r += 1) if (Math.abs((a[r]![col] as number)) > Math.abs((a[piv]![col] as number))) piv = r;
    if (Math.abs((a[piv]![col] as number)) < 1e-14) return undefined;
    const tmp = a[col];
    a[col] = a[piv];
    a[piv] = tmp;
    for (let r = 0; r < 3; r += 1) {
      if (r === col) continue;
      const f = (a[r]![col] as number) / (a[col]![col] as number);
      for (let c = col; c < 4; c += 1) a[r]![c] = (a[r]![c] as number) - f * (a[col]![c] as number);
    }
  }
  return [0, 1, 2].map((i) => (a[i]![3] as number) / (a[i]![i] as number));
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/**
 * 密度比估计（分类器法）: 逻辑回归区分 real(1)/sim(0)，特征 [x, x², 1]，
 * IRLS（牛顿）拟合；r̂(x) = e^{η̂(x)}·n_sim/n_real（类先验修正——平衡
 * 先验下 e^{η̂} 即密度比）。
 *
 * 总体精确性: 标签平衡时最优判别满足 η* = log r，且高斯位移（log r 线性）
 * 与缩放（log r 二次）域差都在特征张成空间内 → 闭式比可对照（锚点①）。
 */
export function densityRatioClassifier(sim: number[], real: number[], options?: DensityRatioOptions): DensityRatioModel {
  const m = validateSample(sim, 'densityRatioClassifier: sim');
  const n = validateSample(real, 'densityRatioClassifier: real');
  const iters = options?.iters ?? 50;
  const ridge = options?.ridge ?? 1e-6;
  if (!Number.isInteger(iters) || iters < 1 || iters > 10000) {
    throw new Error('densityRatioClassifier: iters 必须为 1..10000 的整数');
  }
  if (!Number.isFinite(ridge) || ridge < 0) {
    throw new Error('densityRatioClassifier: ridge 必须为非负有限数');
  }
  const total = m + n;
  // 设计矩阵（每行 [x, x², 1]）与标签（sim=0 在前、real=1 在后）
  const xs: number[] = new Array<number>(total);
  const ys: number[] = new Array<number>(total);
  for (let i = 0; i < m; i += 1) {
    xs[i] = sim[i] as number;
    ys[i] = 0;
  }
  for (let j = 0; j < n; j += 1) {
    xs[m + j] = real[j] as number;
    ys[m + j] = 1;
  }
  const phi = (x: number): number[] => [x, x * x, 1];
  let w = [0, 0, 0];
  let iterations = 0;
  let converged = false;
  for (let it = 0; it < iters; it += 1) {
    iterations = it + 1;
    // 梯度 g = Φᵀ(p − y) + ridge·w；Hessian H = ΦᵀDΦ + ridge·I（D = p(1−p)）
    const g = [0, 0, 0];
    const h = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let i = 0; i < total; i += 1) {
      const f = phi(xs[i] as number);
      const eta = w[0]! * (f[0]! as number) + w[1]! * (f[1]! as number) + w[2]! * (f[2]! as number);
      const p = sigmoid(eta);
      const d = Math.max(1e-8, p * (1 - p));
      const residual = p - (ys[i] as number);
      for (let r = 0; r < 3; r += 1) {
        g[r] = (g[r] as number) + (residual * (f[r]! as number)) as number;
        for (let c = 0; c < 3; c += 1) {
          h[r]![c] = ((h[r]![c] as number) + d * (f[r]! as number) * (f[c]! as number)) as number;
        }
      }
    }
    for (let r = 0; r < 3; r += 1) {
      g[r] = ((g[r] as number) + ridge * (w[r] as number)) as number;
      h[r]![r] = ((h[r]![r] as number) + ridge) as number;
    }
    const delta = solve3(h, g);
    if (delta === undefined) break; // 奇异（数据退化）——保留当前 w
    let maxStep = 0;
    for (let r = 0; r < 3; r += 1) {
      w[r] = ((w[r] as number) - (delta[r] as number)) as number;
      maxStep = Math.max(maxStep, Math.abs(delta[r] as number));
    }
    if (maxStep < 1e-12) {
      converged = true;
      break;
    }
  }
  const priorCorrection = m / n; // r = e^{η}·(n_sim/n_real)
  const logOdds = (x: number): number => (w[0] as number) * x + (w[1] as number) * x * x + (w[2] as number);
  let correct = 0;
  let logLoss = 0;
  for (let i = 0; i < total; i += 1) {
    const eta = logOdds(xs[i] as number);
    const p = sigmoid(eta);
    const y = ys[i] as number;
    if ((p >= 0.5 ? 1 : 0) === y) correct += 1;
    logLoss += -(y * Math.log(Math.max(1e-12, p)) + (1 - y) * Math.log(Math.max(1e-12, 1 - p)));
  }
  const model = ((x: number): number => {
    if (!Number.isFinite(x)) throw new Error('densityRatioModel: x 必须为有限数');
    return Math.exp(logOdds(x) + Math.log(priorCorrection));
  }) as DensityRatioModel;
  model.logRatio = (x: number): number => {
    if (!Number.isFinite(x)) throw new Error('densityRatioModel: x 必须为有限数');
    return logOdds(x) + Math.log(priorCorrection);
  };
  model.coefficients = [w[0] as number, w[1] as number, w[2] as number];
  model.accuracy = correct / total;
  model.logLoss = logLoss / total;
  model.iterations = iterations;
  model.converged = converged;
  return model;
}

// ─────────────────────────── ④ 再加权统计 ───────────────────────────

/**
 * 自归一化再加权统计: Ĵ = Σ r(x_i)·f(x_i) / Σ r(x_i)。
 *
 * 用仿真样本 + 密度比估计真实分布下的 E_real[f]——偏差 O(1/n)、
 * 结果恒落在样本 f 值的凸包内（有界）。锚点: f=id/二阶中心矩 → 真实均值/方差。
 */
export function reweightedStatistic(sim: number[], ratio: (x: number) => number, f: (x: number) => number): number {
  validateSample(sim, 'reweightedStatistic: sim', 1);
  if (typeof ratio !== 'function' || typeof f !== 'function') {
    throw new Error('reweightedStatistic: ratio 与 f 必须为函数');
  }
  let sumW = 0;
  let sumWf = 0;
  for (const x of sim) {
    const w = ratio(x);
    if (!Number.isFinite(w) || w <= 0) throw new Error('reweightedStatistic: ratio(x) 必须为正有限数');
    const fx = f(x);
    if (!Number.isFinite(fx)) throw new Error('reweightedStatistic: f(x) 返回非有限数');
    sumW += w;
    sumWf += w * fx;
  }
  if (!(sumW > 0)) throw new Error('reweightedStatistic: 权重和为零');
  return sumWf / sumW;
}

// ─────────────────────────── ⑤ 加权 MMD² 与校准管线 ───────────────────────────

/**
 * 加权 MMD²（校准 gap 口径，V 统计量形式）:
 * sim 侧按权重归一 u_i = w_i/Σw，real 侧均匀 1/n；
 *   gap = Σ_{ij} u_iu_j k(x_i,x_j) − 2/(n)·Σ_{ij} u_i k(x_i,y_j)/… + …
 * 权重全取 1 时即有偏 MMD²（校准前 gap），换成密度比即校准后 gap。
 */
export function weightedMmd2(sim: number[], real: number[], weights: number[], gamma?: number): number {
  const m = validateSample(sim, 'weightedMmd2: sim');
  const n = validateSample(real, 'weightedMmd2: real');
  if (!Array.isArray(weights) || weights.length !== m) {
    throw new Error('weightedMmd2: weights 长度必须等于 sim 长度');
  }
  let sumW = 0;
  for (const w of weights) {
    if (!Number.isFinite(w) || w <= 0) throw new Error('weightedMmd2: 权重必须为正有限数');
    sumW += w;
  }
  const g = gamma ?? medianHeuristicGamma([...sim, ...real]);
  if (!Number.isFinite(g) || g <= 0) throw new Error('weightedMmd2: gamma 必须为正有限数');
  const k = (a: number, b: number): number => Math.exp(-g * (a - b) * (a - b));
  const u: number[] = new Array<number>(m);
  for (let i = 0; i < m; i += 1) u[i] = (weights[i] as number) / sumW;
  let kxx = 0;
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < m; j += 1) kxx += (u[i] as number) * (u[j] as number) * k(sim[i] as number, sim[j] as number);
  }
  let kyy = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) kyy += k(real[i] as number, real[j] as number);
  }
  let kxy = 0;
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < n; j += 1) kxy += (u[i] as number) * k(sim[i] as number, real[j] as number);
  }
  return kxx - (2 * kxy) / n + kyy / (n * n);
}

export interface CalibrationReport {
  /** 校准前 gap（均匀权重加权 MMD²，即有偏 MMD² 口径） */
  gapBefore: number;
  /** 校准后 gap（密度比再加权 MMD²） */
  gapAfter: number;
  /** 缩减比例 1 − gapAfter/gapBefore（越大越好；≤ 0 表示未改善） */
  reduction: number;
  /** 每个仿真样本的密度比 r(x_i) */
  ratios: number[];
  /** 高斯核带宽 γ（显式传入或中位数启发式） */
  gamma: number;
  /** 有效样本量 ESS = (Σr)²/Σr²（再加权的方差代价） */
  ess: number;
  /** ESS / n_sim（< 0.2 触发重度再加权警告） */
  essFraction: number;
  /** 比值极值/均值 */
  ratioMax: number;
  ratioMean: number;
  /** 裸仿真样本均值/方差（校准前口径） */
  plainMean: number;
  plainVar: number;
  /** 再加权仿真均值/方差（校准后口径 → 应匹配真实均值/方差） */
  reweightedMean: number;
  reweightedVar: number;
  /** 真实样本均值/方差（对照目标） */
  realMean: number;
  realVar: number;
  /** 风险提示（重度再加权 / 极端比值 / 未缩小 / 同分布退化） */
  warnings: string[];
  /** 判别器诊断 */
  classifier: { accuracy: number; logLoss: number; iterations: number; converged: boolean };
}

export interface CalibrateSimOptions extends Mmd2Options, DensityRatioOptions {
  /** 追加警告的 ESS 比例下限（缺省 0.2） */
  minEssFraction?: number;
}

/**
 * 仿真校准管线: 量化域差 → 估计密度比 → 再加权 → 残差复核。
 *
 * 数据流: gapBefore（有偏 MMD²）→ 分类器密度比 r̂ → 再加权统计（均值/方差
 * → 真实口径）→ gapAfter（加权 MMD²）。warnings 提示外推风险：重度再加权
 * （ESS/n 低）、极端比值、校准未缩小（比值模型欠拟合）、同分布退化。
 */
export function calibrateSim(sim: number[], real: number[], options?: CalibrateSimOptions): CalibrationReport {
  const m = validateSample(sim, 'calibrateSim: sim');
  const n = validateSample(real, 'calibrateSim: real');
  const gamma = options?.gamma ?? medianHeuristicGamma([...sim, ...real]);
  if (!Number.isFinite(gamma) || gamma <= 0) throw new Error('calibrateSim: gamma 必须为正有限数');
  const minEss = options?.minEssFraction ?? 0.2;
  if (!Number.isFinite(minEss) || minEss <= 0 || minEss > 1) {
    throw new Error('calibrateSim: minEssFraction 必须 ∈ (0, 1]');
  }
  const gapBefore = weightedMmd2(sim, real, new Array<number>(m).fill(1), gamma);
  const model = densityRatioClassifier(sim, real, { iters: options?.iters, ridge: options?.ridge });
  const ratios = sim.map((x) => model(x));
  const gapAfter = weightedMmd2(sim, real, ratios, gamma);
  const sumR = ratios.reduce((s, r) => s + r, 0);
  const sumR2 = ratios.reduce((s, r) => s + r * r, 0);
  const ess = (sumR * sumR) / sumR2;
  let ratioMax = ratios[0] as number;
  for (const r of ratios) if (r > ratioMax) ratioMax = r;
  const ratioMean = sumR / m;
  const plainMean = mean(sim);
  const plainVar = variance(sim);
  const reweightedMean = reweightedStatistic(sim, (x) => model(x), (x) => x);
  const reweightedVar = reweightedStatistic(sim, (x) => model(x), (x) => (x - reweightedMean) * (x - reweightedMean));
  const warnings: string[] = [];
  const essFraction = ess / m;
  if (essFraction < minEss) {
    warnings.push(`重度再加权：ESS/n = ${round(essFraction, 3)}（少数样本主导估计，外推风险高）`);
  }
  if (ratioMax > 50) {
    warnings.push(`极端密度比：max r = ${round(ratioMax, 2)}（尾部外推不可靠）`);
  }
  if (gapAfter > gapBefore) {
    warnings.push('校准未缩小差异（gapAfter > gapBefore）——比值模型可能欠拟合或样本不足');
  }
  if (Math.abs(ratioMean - 1) < 0.02 && gapBefore < 0.01) {
    warnings.push('同分布口径：比值 ≈ 1、域差 ≈ 0（校准为零操作）');
  }
  return {
    gapBefore: round(gapBefore, 9),
    gapAfter: round(gapAfter, 9),
    reduction: gapBefore > 1e-15 ? round(1 - gapAfter / gapBefore, 6) : 0,
    ratios,
    gamma: round(gamma, 9),
    ess: round(ess, 3),
    essFraction: round(essFraction, 6),
    ratioMax: round(ratioMax, 4),
    ratioMean: round(ratioMean, 6),
    plainMean: round(plainMean, 6),
    plainVar: round(plainVar, 6),
    reweightedMean: round(reweightedMean, 6),
    reweightedVar: round(reweightedVar, 6),
    realMean: round(mean(real), 6),
    realVar: round(variance(real), 6),
    warnings,
    classifier: {
      accuracy: round(model.accuracy, 4),
      logLoss: round(model.logLoss, 6),
      iterations: model.iterations,
      converged: model.converged,
    },
  };
}

// ─────────────────── R5: 截断重要性加权 + 加权 bootstrap 区间 ───────────────────

export interface TruncateWeightsResult {
  /** w_i = min(r_i, cap) */
  weights: number[];
  /** 被截断的权重个数 */
  clipped: number;
  /** 截断阈值（入参回显） */
  cap: number;
  /** (Σr)²/Σr²——截断前有效样本量 */
  essBefore: number;
  /** (Σw)²/Σw²——截断后有效样本量（截断只压缩权重离散度 ⟹ 单调不降） */
  essAfter: number;
  ratioMax: number;
}

function essOf(w: number[]): number {
  let s1 = 0;
  let s2 = 0;
  for (const v of w) {
    s1 += v;
    s2 += v * v;
  }
  return s2 > 0 ? (s1 * s1) / s2 : 0;
}

/**
 * 截断重要性加权: w_i = min(r_i, cap)。重尾比值下纯 IS 的方差无界、
 * ESS → 1（少数样本独裁）；截断以 O(E[(r−cap)⁺]) 偏倚换取方差护栏。
 * cap ≥ max r 时不截断（w = r，与纯 IS 逐位一致）。
 */
export function truncateWeights(ratios: ReadonlyArray<number>, cap: number): TruncateWeightsResult {
  if (!Array.isArray(ratios) || ratios.length === 0) throw new Error('truncateWeights: ratios 需为非空数组');
  for (let i = 0; i < ratios.length; i += 1) {
    const v = ratios[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`truncateWeights: ratios[${i}] = ${String(v)} 需为正有限数`);
    }
  }
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
    throw new Error(`truncateWeights: cap = ${String(cap)} 需为正有限数`);
  }
  const weights = ratios.map((r) => Math.min(r, cap));
  let clipped = 0;
  let ratioMax = ratios[0] as number;
  for (let i = 0; i < ratios.length; i += 1) {
    if (weights[i]! < (ratios[i] as number)) clipped += 1;
    if ((ratios[i] as number) > ratioMax) ratioMax = ratios[i] as number;
  }
  return {
    weights,
    clipped,
    cap,
    essBefore: essOf([...ratios]),
    essAfter: essOf(weights),
    ratioMax,
  };
}

export interface WeightedBootstrapOptions {
  /** 重采样副本数 B（缺省 400；∈ [2, 10⁶]） */
  replicates?: number;
  /** 种子（缺省 20261002——同种子同区间，确定性） */
  seed?: number;
  /** 区间水平（缺省 0.9 ⟹ 5%–95% 经验分位） */
  level?: number;
}

export interface WeightedBootstrapResult {
  /** 点估计: 自归一化加权统计 Σwf/Σw（与 reweightedStatistic 同口径） */
  estimate: number;
  lower: number;
  upper: number;
  replicates: number;
  level: number;
  seed: number;
}

/**
 * 自归一化 IS 估计量的 bootstrap 区间（对**估计量**重采样，非对加权分布）:
 * 每副本以等概率有放回重采 sim 的 n 个下标（(w_i, f_i) 成对——保留权重与
 * 观测的联合随机性），重算自归一化加权均值 J*（分子 Σ w_i f_i，分母 Σ w_i）；
 * B 个副本的经验分位数给区间。该口径的 bootstrap 方差 = (1/n)·Var_sim[w·f]/E_sim[w]²
 * ——与自归一化 IS 估计量的渐近方差一致（对加权分布直接重采样会漏掉 w²
 * 的放大项，区间过窄、覆盖率不足）；权重全同时退化为经典均值 bootstrap。
 * 全部随机性来自种子化 mulberry32——同 seed 逐位复现。
 */
export function weightedBootstrap(
  sim: number[],
  weights: ReadonlyArray<number>,
  f: (x: number) => number,
  options?: WeightedBootstrapOptions,
): WeightedBootstrapResult {
  validateSample(sim, 'weightedBootstrap: sim', 1);
  if (!Array.isArray(weights) || weights.length !== sim.length) {
    throw new Error(`weightedBootstrap: weights 长度 ${Array.isArray(weights) ? weights.length : String(weights)} 需等于 sim 长度 ${sim.length}`);
  }
  if (typeof f !== 'function') throw new Error('weightedBootstrap: f 必须为函数');
  let sumW = 0;
  for (let i = 0; i < weights.length; i += 1) {
    const w = weights[i];
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) {
      throw new Error(`weightedBootstrap: weights[${i}] = ${String(w)} 需为正有限数`);
    }
    sumW += w;
  }
  if (!(sumW > 0)) throw new Error('weightedBootstrap: 权重和为零');
  const replicates = options?.replicates ?? 400;
  if (!Number.isInteger(replicates) || replicates < 2 || replicates > 1000000) {
    throw new Error(`weightedBootstrap: replicates 需为 [2,10⁶] 整数（得到 ${replicates}）`);
  }
  const seed = options?.seed ?? 20261002;
  if (!Number.isFinite(seed)) throw new Error('weightedBootstrap: seed 需为有限数');
  const level = options?.level ?? 0.9;
  if (!Number.isFinite(level) || level <= 0 || level >= 1) {
    throw new Error(`weightedBootstrap: level 需 ∈ (0,1)（得到 ${level}）`);
  }
  const n = sim.length;
  // 点估计（自归一化 IS——与 reweightedStatistic 同式，逐位同值）
  let sumWf = 0;
  for (let i = 0; i < n; i += 1) sumWf += (weights[i] as number) * f(sim[i] as number);
  const estimate = sumWf / sumW;
  const wf = new Float64Array(n);
  const w0 = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    wf[i] = (weights[i] as number) * f(sim[i] as number);
    w0[i] = weights[i] as number;
  }
  const rng = mulberry32(seed);
  const stats = new Float64Array(replicates);
  // 每副本: 等概率有放回重采 n 个下标，重算 Σw*f*/Σw*（成对保留 w 与 f 的联合）
  for (let b = 0; b < replicates; b += 1) {
    let accNum = 0;
    let accDen = 0;
    for (let i = 0; i < n; i += 1) {
      const idx = Math.floor(rng() * n) % n;
      accNum += wf[idx]!;
      accDen += w0[idx]!;
    }
    stats[b] = accDen > 0 ? accNum / accDen : estimate;
  }
  // 经验分位数（线性插值，确定性）
  const sorted = Float64Array.from(stats).sort();
  const quantile = (p: number): number => {
    const pos = p * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo]!;
    return sorted[lo]! + (pos - lo) * (sorted[hi]! - sorted[lo]!);
  };
  return {
    estimate,
    lower: quantile((1 - level) / 2),
    upper: quantile(1 - (1 - level) / 2),
    replicates,
    level,
    seed,
  };
}

// ─────────────────────────── 已知解析域差工厂 ───────────────────────────

export interface DomainGapOptions {
  /** 真实分布均值位移 μ（缺省 1；仿真恒为 N(0,1)） */
  shift?: number;
  /** 真实分布尺度 σ（缺省 1；real ~ N(μ, σ²)） */
  scale?: number;
  /** 仿真样本流种子（缺省 1；真实流用 seed + 1_000_003 独立同构） */
  seed?: number;
  /** 仿真样本数（缺省 2000） */
  nSim?: number;
  /** 真实样本数（缺省 2000） */
  nReal?: number;
}

/** 已知解析域差: 闭式密度比对照的工厂产物 */
export interface DomainGap {
  readonly shift: number;
  readonly scale: number;
  readonly sim: number[];
  readonly real: number[];
  /** 闭式密度比 r(x) = p_real(x)/p_sim(x)（仿真 N(0,1)，真实 N(μ,σ²)） */
  exactRatio(x: number): number;
  /** 闭式 log r(x)（线性 + 二次项，供系数恢复对照） */
  exactLogRatio(x: number): number;
}

/**
 * 高斯位移/缩放域差工厂: sim ~ N(0,1)、real ~ N(μ, σ²)，闭式密度比
 *   r(x) = (1/σ)·exp(x²/2 − (x−μ)²/(2σ²))。
 * μ 位移 → log r 线性（斜率 μ）；σ 缩放 → log r 二次（系数 ½−1/(2σ²)）——
 * 分类器法两类域差都可精确对照。两条样本流独立（不同 mulberry32 种子）。
 */
export function makeDomainGap(options?: DomainGapOptions): DomainGap {
  const shift = options?.shift ?? 1;
  const scale = options?.scale ?? 1;
  const seed = options?.seed ?? 1;
  const nSim = options?.nSim ?? 2000;
  const nReal = options?.nReal ?? 2000;
  if (!Number.isFinite(shift)) throw new Error('makeDomainGap: shift 必须为有限数');
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('makeDomainGap: scale 必须为正有限数');
  if (!Number.isFinite(seed)) throw new Error('makeDomainGap: seed 必须为有限数');
  if (!Number.isInteger(nSim) || nSim < 2 || !Number.isInteger(nReal) || nReal < 2) {
    throw new Error('makeDomainGap: nSim/nReal 必须为 ≥ 2 的整数');
  }
  const sim = new Array<number>(nSim);
  const rngSim = mulberry32(seed);
  for (let i = 0; i < nSim; i += 1) sim[i] = standardNormal(rngSim);
  const real = new Array<number>(nReal);
  const rngReal = mulberry32(seed + 1000003);
  for (let i = 0; i < nReal; i += 1) real[i] = shift + scale * standardNormal(rngReal);
  const exactLogRatio = (x: number): number =>
    -Math.log(scale) + (x * x) / 2 - ((x - shift) * (x - shift)) / (2 * scale * scale);
  return {
    shift,
    scale,
    sim,
    real,
    exactRatio: (x: number) => Math.exp(exactLogRatio(x)),
    exactLogRatio,
  };
}

/* ── 接线建议 ─────────────────────────────────────────────────────────
 *
 * 1. 沙盒「风洞修正」（挂 src/policy/sandbox.ts——进化环从仿真到上线的桥梁）:
 *    沙盒评估产出的 per-task 质量分序列（候选与 baseline 同噪声口径）与
 *    操作环真实质量分构成两样本 → mmd2/energyDistance 量化「模拟器此刻
 *    失真多少」（可信度仪表盘）；密度比 r̂ = densityRatioClassifier(沙盒分,
 *    真实分) 把沙盒统计换算真实口径:
 *      真实口径增益 ≈ reweightedStatistic(沙盒增益序列, r̂, f=id)
 *    上线判据从「沙盒 gainLCB ≥ 0」升级为「真实口径再加权增益的稳健下界
 *    ≥ 0」——sim-to-real 域差第一次进入部署门禁的数学。
 *
 * 2. 校准监测（与 13.0 保形联动）: calibrateSim 的 gapBefore 走势即模拟器
 *    保真度曲线——gap 持续扩大（模型版本更换/任务分布漂移）触发沙盒校准表
 *    重锚定；warnings 的重度再加权提示（ESS/n 低）意味着「沙盒对真实尾部
 *    几乎无覆盖」，此时任何换算都不可信，应回退保守门禁而非外推。
 *
 * 3. 证据链位置: 88.0 回答「如果当初换策略会怎样」（离线评估），本内核回答
 *    「仿真与真实差多少、如何折算」（域差校准）——二者合成「沙盒分数 →
 *    真实口径反事实」的完整换算链；89.0 在其上做有证书的上线决策。
 *
 * 4. 零漂移承诺: 本内核只有纯函数与只读工厂（随机仅工厂内 mulberry32，
 *    同 seed 同输出）；未挂载前系统行为与升级前逐位一致。
 * ────────────────────────────────────────────────────────────────── */
