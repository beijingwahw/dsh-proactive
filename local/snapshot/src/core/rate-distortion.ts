/**
 * rate-distortion.ts — 率失真内核（项目 60.0「忘什么有了信息论定价」质变基座）
 *
 * 升级前的根本局限（记忆压缩的经验主义天花板）：
 * 长期记忆的「保留多少」从来没有第一性定价——
 * - **水位魔数**：蒸馏/淘汰看样本计数与时间窗，度量的是「来得
 *   多不多」，不是「值不值得记」；高频噪声与低频金句被同一把
 *   尺子对待；
 * - **压缩比是拍的**：存 1/4 还是存 1/8 从未从失真预算解出来；
 * - **该忘谁没有货币**：条目之间没有统一的价值/比特兑换率，
 *   「预算紧张时先忘谁」只能靠排序启发式。
 *
 * 本内核引入率失真理论（Shannon 1948/1959；Cover & Thomas ch.10；
 * Blahut 1972 / Arimoto 1972 的可计算形式）：
 *
 * 1. **R(D) 的定义**：
 *      R(D) = min_{p(x̂|x): E[d(x,x̂)] ≤ D} I(X; X̂)
 *    ——在给定保真度 D 下压缩信源所需的极限比特率。R(D) 是
 *    单调不增、凸的：保真度越宽松，需要的比特越少，且边际递减。
 *
 * 2. **解析锚（可信的尺子）**：
 *    - 二值源 Hamming 失真：R(D) = H₂(p) − H₂(D)，D ≤ D_max =
 *      min(p, 1−p)（均匀源退化为 1 − H₂(D)，D_max = 1/2）；
 *    - 高斯源 MSE：R(D) = ½·log₂(σ²/D)（D ≥ σ² 时 R = 0）。
 *
 * 3. **Blahut–Arimoto 迭代（一般离散源的可计算 RD 曲线）**：
 *    固定斜率参数 β，交替更新至自洽：
 *      p(x̂|x) ∝ q(x̂)·e^{−β·d(x,x̂)}（行归一化）
 *      q(x̂)   = Σ_x p(x)·p(x̂|x)
 *    每个 β 收敛到 RD 曲线（凸包）上斜率为 −β 的点；β 扫描扫出
 *    整条曲线。拉格朗日量 L = R + (β/ln2)·D（bit 口径）在交替
 *    更新下单调不增——两条更新各是坐标方向的最小化，这是 BA
 *    收敛性的经典证明路径，也是本内核的验证锚点。
 *
 * 4. **记忆压缩规划器（keep/compress/drop 的率失真分摊）**：
 *    每个记忆条目三档选择——keep（全保真 b bit，价值 v）、
 *    compress（c bit，价值 ρ·v）、drop（0 bit，0 价值）。对影子
 *    价格 λ（价值/bit）做凸包扫描：各档边际净收益 v−λb / ρv−λc /
 *    0 取大者；λ 从高到低走，总比特随 λ 下降单调上升，与预算
 *    相交处的 λ* 就是「遗忘的边际价格」；剩余预算再贪心填充
 *    （Δ价值/Δ比特降序）。**「该忘什么」第一次有了价格**：
 *    λ* 之上（低价值密度）忘、之下保——与 22.0 BwK 的影子价格
 *    同一思想换了货币（token → bit）。
 *
 * 与既有内核的关系：37.0 信息瓶颈是本内核的「相关变体」（IB 压缩
 * X 保对 Y 的相关，共用 Blahut–Arimoto 交替结构，目标泛函不同）；
 * 37.0 回答「表征里该留什么结构」，本内核回答「记忆预算该怎么摊」；
 * 24.0 差分隐私花 ε 买隐私，本内核花 bit 买保真——三种货币三种
 * 预算纪律。
 *
 * ── R5-A13 世界性进化（第五轮）──
 *
 * 6. **加权汉明失真的率失真函数（自定义失真度量）**: 对称 Hamming 把
 *    两类错误等价（d = 1）；真实记忆/诊断场景两类错误代价天然不对称
 *    （漏记关键证据 ≫ 多记一条噪声）。binaryHammingRD 的解析锚
 *    R(D) = H₂(p) − H₂(D) 只在对称失真下成立；本进化给出**不对称
 *    失真矩阵 [[0, w₀₁],[w₁₀, 0]] 的可计算 R(D)**：测试信道只有两个
 *    自由度（u = P(x̂=1|x=0)、v = P(x̂=0|x=1)），BA 的自洽方程塌缩为
 *    重现边际 q 的一维不动点 q = (1−p)u(q) + p(1−v(q))——每 β 一次
 *    1-D 迭代（无矩阵运算），目标失真 D 由 β 二分反解。对称极限
 *    w₀₁ = w₁₀ 精确回到 H₂(p) − H₂(D)；D_max = min((1−p)w₀₁, p·w₁₀)
 *    （恒猜某一类即零码率的失真上界）。
 *
 * 7. **β 扫描热启动 + log 域不变量缓存**: rdCurve 的每个 β 独立冷启动
 *    （均匀边际）——相邻 β 的 RD 点在曲线上相邻，上个点的收敛边际是
 *    下个点的优质初值。rdCurveFast 按 β 降序扫描、逐点热启动（新增
 *    initialMarginal 选项），同容差下迭代数大幅下降且收敛点一致；
 *    blahutArimoto 的条件更新把 Math.log(q[j]) 逐行重算——q 在行间
 *    不变，提升到行循环外（逐位一致的不变量缓存，大字母表实测提速）。
 *
 * 零漂移: 既有函数（binaryHammingRD / blahutArimoto / rdCurve /
 * memoryCompressionPlanner）对既有调用逐位不变；本节为新增入口。
 *
 * 验证锚点：
 * ① BA 在均匀二值 Hamming 源上与解析 R(D)=1−H₂(D) 吻合至 1e-6
 *   （β 扫 ≥5 点；非均匀源对照 H₂(p)−H₂(D) 同锚）；② BA 拉格朗日
 *   量逐迭代单调不增；③ 高斯 σ²=1, D=0.5 → R=0.5 bit 精确；
 * ④ rdCurve 的 R(D) 关于 D 单调不增、中点在弦下方（凸性方向）；
 * ⑤ 记忆规划器 8 条目：预算从宽到紧，保留集合按价值密度逐级
 *   前缀收缩，永不超预算。
 *
 * 应用：长期记忆分层压缩——记忆蒸馏的经验规则升级为率失真预算
 * 分摊；记忆库按 bit 预算自动分层 keep/compress/drop。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 解析锚 ───────────────────────────

/** 二值熵 H₂(x) = −x·log₂x − (1−x)·log₂(1−x)（约定 H₂(0)=H₂(1)=0） */
function binaryEntropy(x: number): number {
  if (x <= 0 || x >= 1) return 0;
  return -x * Math.log2(x) - (1 - x) * Math.log2(1 - x);
}

/**
 * 二值源 Hamming 失真的率失真函数（bit）：R(D) = H₂(p) − H₂(D)。
 *
 * D ∈ [0, D_max]（D_max = min(p, 1−p)，均匀源 = 1/2）；D ≥ D_max 时
 * 诚实返回 0（恒猜众数类即达零失真上限，无需任何比特）。
 * 非均匀源调用例：binaryHammingRD(0.1, 0.3) = H₂(0.3) − H₂(0.1)。
 */
export function binaryHammingRD(D: number, p = 0.5): number {
  if (!(p > 0 && p < 1) || !Number.isFinite(p)) {
    throw new Error(`rate-distortion: 二值源参数 p 必须在 (0,1)（收到 ${p}）`);
  }
  if (!Number.isFinite(D) || D < 0) throw new Error(`rate-distortion: 失真 D 必须 ≥ 0（收到 ${D}）`);
  const dMax = Math.min(p, 1 - p);
  if (D >= dMax) return 0;
  return binaryEntropy(p) - binaryEntropy(D);
}

/**
 * 高斯源 MSE 的率失真函数（bit）：R(D) = ½·log₂(σ²/D)。
 *
 * D ≥ σ² 时诚实返回 0（用方差 σ² 的零均值估计即可达失真 σ²）。
 * 逆用即率失真码率反解失真：D = σ²·2^{−2R}（保多少比特定多少失真）。
 */
export function gaussianMseRD(D: number, sigma2: number): number {
  if (!(sigma2 > 0) || !Number.isFinite(sigma2)) {
    throw new Error(`rate-distortion: 方差 sigma2 必须 > 0（收到 ${sigma2}）`);
  }
  if (!Number.isFinite(D) || D <= 0) throw new Error(`rate-distortion: 失真 D 必须 > 0（收到 ${D}）`);
  if (D >= sigma2) return 0;
  return 0.5 * Math.log2(sigma2 / D);
}

// ─────────────────────────── Blahut–Arimoto ───────────────────────────

/** Blahut–Arimoto 迭代选项 */
export interface BlahutArimotoOptions {
  /** 迭代上限（缺省 20000） */
  iters?: number;
  /** 边际收敛容差（缺省 1e-13，max|Δq|） */
  tol?: number;
  /**
   * 重现边际初值 q₀（缺省均匀）。热启动口径：相邻 β 的 RD 点共享
   * 曲线邻域，上一点的收敛边际是本点的优质初值（rdCurveFast 用）。
   * 长度必须等于重现字母数、分量非负有限、总和 > 0（内部归一化）。
   */
  initialMarginal?: ReadonlyArray<number>;
}

/** Blahut–Arimoto 结果 */
export interface BlahutArimotoResult {
  /** 速率 R = I(X; X̂)（bit）——该斜率点的极限压缩码率 */
  rate: number;
  /** 达成的期望失真 D = E[d(x, x̂)] */
  distortion: number;
  /** 最优测试信道 p(x̂|x)（|X| × |X̂|，行归一化） */
  conditional: number[][];
  /** 重现字母边际 q(x̂) */
  marginal: number[];
  /** 斜率参数 β（nat/失真单位） */
  beta: number;
  /** 拉格朗日量 L = R + (β/ln2)·D（bit；单调不增轨迹见 lagrangianTrace） */
  lagrangian: number;
  /** 拉格朗日量逐迭代轨迹（验证锚点②：单调不增） */
  lagrangianTrace: number[];
  iterations: number;
  converged: boolean;
}

/**
 * Blahut–Arimoto 率失真迭代（一般离散源）。
 *
 * px: 源分布（自动归一化）；distortionMatrix: d[x][x̂] ≥ 0（行 = 源
 * 符号，列 = 重现符号，两者维数可不同）；beta: RD 曲线斜率参数
 * （β 越大越保真，点越靠左上）。
 *
 * 条件更新在 log 域做 max-shift softmax（大 β / 大失真尺度不下溢）；
 * 初始 q 取均匀（确定性）。收敛判据：边际逐坐标变化 < tol。
 */
export function blahutArimoto(
  px: ReadonlyArray<number>,
  distortionMatrix: ReadonlyArray<ReadonlyArray<number>>,
  beta: number,
  options?: BlahutArimotoOptions,
): BlahutArimotoResult {
  const nX = px.length;
  if (nX < 2) throw new Error(`rate-distortion: 源至少需要 2 个符号（收到 ${nX}）`);
  if (distortionMatrix.length !== nX) {
    throw new Error(`rate-distortion: 失真矩阵行数 ${distortionMatrix.length} ≠ 源符号数 ${nX}`);
  }
  const nXhat = distortionMatrix[0].length;
  if (nXhat < 1) throw new Error(`rate-distortion: 重现字母不能为空`);
  let pTotal = 0;
  for (const v of px) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`rate-distortion: 源分布含非法分量 ${v}`);
    pTotal += v;
  }
  if (!(pTotal > 0)) throw new Error('rate-distortion: 源分布全为零');
  for (const row of distortionMatrix) {
    if (row.length !== nXhat) throw new Error('rate-distortion: 失真矩阵行宽不一致');
    for (const d of row) {
      if (!Number.isFinite(d) || d < 0) throw new Error(`rate-distortion: 失真必须为有限非负数（收到 ${d}）`);
    }
  }
  if (!(beta > 0) || !Number.isFinite(beta)) throw new Error(`rate-distortion: beta 必须 > 0（收到 ${beta}）`);
  const iters = Math.floor(options?.iters ?? 20000);
  const tol = options?.tol ?? 1e-13;
  if (!(iters >= 1)) throw new Error(`rate-distortion: iters 必须 ≥ 1（收到 ${options?.iters}）`);
  if (!(tol > 0)) throw new Error(`rate-distortion: tol 必须 > 0（收到 ${options?.tol}）`);

  const p = px.map((v) => v / pTotal);
  let q: number[];
  if (options?.initialMarginal !== undefined) {
    const q0 = options.initialMarginal;
    if (q0.length !== nXhat) {
      throw new Error(`rate-distortion: initialMarginal 长度 ${q0.length} 必须等于重现字母数 ${nXhat}`);
    }
    let qSum = 0;
    for (const v of q0) {
      if (!Number.isFinite(v) || v < 0) throw new Error(`rate-distortion: initialMarginal 含非法分量 ${v}`);
      qSum += v;
    }
    if (!(qSum > 0)) throw new Error('rate-distortion: initialMarginal 全为零');
    q = q0.map((v) => v / qSum);
  } else {
    q = new Array<number>(nXhat).fill(1 / nXhat);
  }
  const conditional: number[][] = Array.from({ length: nX }, () => new Array<number>(nXhat).fill(0));
  const trace: number[] = [];
  let iterations = 0;
  let converged = false;
  for (let t = 1; t <= iters; t += 1) {
    // 条件更新：p(x̂|x) ∝ q(x̂)·e^{−β·d(x,x̂)}（log 域 softmax，防下溢）。
    // log q 在行间不变——提升到行循环外（不变量缓存，逐位一致）。
    const logQ = new Array<number>(nXhat);
    for (let j = 0; j < nXhat; j += 1) logQ[j] = Math.log(q[j] > 0 ? q[j] : 1e-300);
    for (let i = 0; i < nX; i += 1) {
      const row = distortionMatrix[i];
      let rowMax = -Infinity;
      const logW = new Array<number>(nXhat);
      for (let j = 0; j < nXhat; j += 1) {
        logW[j] = logQ[j] - beta * row[j];
        if (logW[j] > rowMax) rowMax = logW[j];
      }
      let z = 0;
      for (let j = 0; j < nXhat; j += 1) {
        const w = Math.exp(logW[j] - rowMax);
        conditional[i][j] = w;
        z += w;
      }
      for (let j = 0; j < nXhat; j += 1) conditional[i][j] /= z;
    }
    // 边际更新：q(x̂) = Σ_x p(x)·p(x̂|x)
    const qNext = new Array<number>(nXhat).fill(0);
    for (let i = 0; i < nX; i += 1) {
      for (let j = 0; j < nXhat; j += 1) qNext[j] += p[i] * conditional[i][j];
    }
    // 拉格朗日量（bit 口径）——交替更新的单调下降轨道
    const { rate, distortion } = rateDistortionOf(p, conditional, distortionMatrix, qNext);
    trace.push(rate + (beta / Math.LN2) * distortion);
    iterations = t;
    let maxDelta = 0;
    for (let j = 0; j < nXhat; j += 1) maxDelta = Math.max(maxDelta, Math.abs(qNext[j] - q[j]));
    q = qNext;
    if (maxDelta < tol) {
      converged = true;
      break;
    }
  }
  const { rate, distortion } = rateDistortionOf(p, conditional, distortionMatrix, q);
  return {
    rate,
    distortion,
    conditional,
    marginal: q,
    beta,
    lagrangian: rate + (beta / Math.LN2) * distortion,
    lagrangianTrace: trace,
    iterations,
    converged,
  };
}

/** 由条件分布与边际计算 (R bit, D) */
function rateDistortionOf(
  p: ReadonlyArray<number>,
  conditional: ReadonlyArray<ReadonlyArray<number>>,
  d: ReadonlyArray<ReadonlyArray<number>>,
  q: ReadonlyArray<number>,
): { rate: number; distortion: number } {
  let rate = 0;
  let distortion = 0;
  for (let i = 0; i < p.length; i += 1) {
    for (let j = 0; j < q.length; j += 1) {
      const pc = conditional[i][j];
      if (pc <= 0) continue;
      distortion += p[i] * pc * d[i][j];
      rate += p[i] * pc * Math.log2(pc / (q[j] > 0 ? q[j] : 1e-300));
    }
  }
  return { rate: Math.max(0, rate), distortion };
}

// ─────────────────────────── RD 曲线 ───────────────────────────

/** RD 曲线上的一个点 */
export interface RdCurvePoint {
  /** 斜率参数 β（nat/失真单位；β↓ → 点向右下移） */
  beta: number;
  /** 期望失真 D */
  distortion: number;
  /** 极限码率 R(D)（bit） */
  rate: number;
  /** BA 是否在该点收敛 */
  converged: boolean;
}

/**
 * β 扫描的率失真曲线（按失真升序返回点集）。
 *
 * betas 须非空且全为正；每个 β 独立跑一次 BA。曲线性质（验证锚点④）：
 * D 升序时 R 单调不增，且任意相邻三点中点位于弦的下方（凸性方向）。
 */
export function rdCurve(
  px: ReadonlyArray<number>,
  distortionMatrix: ReadonlyArray<ReadonlyArray<number>>,
  betas: ReadonlyArray<number>,
  options?: BlahutArimotoOptions,
): RdCurvePoint[] {
  if (betas.length === 0) throw new Error('rate-distortion: betas 不能为空');
  for (const b of betas) {
    if (!(b > 0) || !Number.isFinite(b)) throw new Error(`rate-distortion: beta 必须 > 0（收到 ${b}）`);
  }
  const points = betas.map((beta) => {
    const r = blahutArimoto(px, distortionMatrix, beta, options);
    return { beta, distortion: r.distortion, rate: r.rate, converged: r.converged };
  });
  points.sort((a, b) => a.distortion - b.distortion);
  return points;
}

// ─────────────────────────── R5-A13：加权汉明失真 + 热启动扫描 ───────────────────────────

/** 加权汉明 RD 曲线点（半解析口径的观测面） */
export interface WeightedHammingPoint {
  /** 斜率参数 β（nat/失真单位） */
  beta: number;
  /** 期望失真 D = (1−p)·w₀₁·u + p·w₁₀·v */
  distortion: number;
  /** 码率 R = H₂(q) − (1−p)·H₂(u) − p·H₂(v)（bit） */
  rate: number;
  /** 重现边际 q = P(x̂=1)（一维不动点） */
  marginal: number;
  iterations: number;
}

/**
 * 加权汉明失真的 RD 点（固定 β）：不对称失真矩阵 [[0, w₀₁],[w₁₀, 0]]。
 *
 * 二值测试信道只有两个自由度——u = P(x̂=1|x=0) 与 v = P(x̂=0|x=1)。
 * BA 的自洽方程在此塌缩为重现边际 q 的一维不动点：
 *   u(q) = q·e^{−βw₀₁} / (1−q + q·e^{−βw₀₁})
 *   v(q) = (1−q)·e^{−βw₁₀} / ((1−q)·e^{−βw₁₀} + q)
 *   q ← (1−p)·u(q) + p·(1−v(q))
 * 从 q₀ = 1/2 起迭代至自洽（与 2×2 BA 全矩阵迭代同一轨迹，无矩阵开销），
 * 然后 D = (1−p)w₀₁u + p·w₁₀v、R = H₂(q) − (1−p)H₂(u) − pH₂(v)。
 */
export function weightedHammingPoint(
  p: number,
  w01: number,
  w10: number,
  beta: number,
  options?: { iters?: number; tol?: number },
): WeightedHammingPoint {
  validateWeightedHamming(p, w01, w10, beta);
  const iters = Math.floor(options?.iters ?? 200000);
  const tol = options?.tol ?? 1e-15;
  let q = 0.5;
  let u = 0;
  let v = 0;
  let used = 0;
  for (let t = 1; t <= iters; t += 1) {
    const eA = Math.exp(-beta * w01);
    const eB = Math.exp(-beta * w10);
    u = (q * eA) / (1 - q + q * eA);
    v = ((1 - q) * eB) / ((1 - q) * eB + q);
    const qNext = (1 - p) * u + p * (1 - v);
    used = t;
    if (Math.abs(qNext - q) < tol) {
      q = qNext;
      break;
    }
    q = qNext;
  }
  // 收敛点处的信道与 (R, D)
  const eA = Math.exp(-beta * w01);
  const eB = Math.exp(-beta * w10);
  u = (q * eA) / (1 - q + q * eA);
  v = ((1 - q) * eB) / ((1 - q) * eB + q);
  const distortion = (1 - p) * w01 * u + p * w10 * v;
  const rate = Math.max(0, binaryEntropy(q) - (1 - p) * binaryEntropy(u) - p * binaryEntropy(v));
  return { beta, distortion, rate, marginal: q, iterations: used };
}

function validateWeightedHamming(p: number, w01: number, w10: number, beta: number): void {
  if (!(p > 0 && p < 1) || !Number.isFinite(p)) {
    throw new Error(`rate-distortion: 加权汉明源参数 p 必须在 (0,1)（收到 ${p}）`);
  }
  if (!Number.isFinite(w01) || w01 <= 0 || !Number.isFinite(w10) || w10 <= 0) {
    throw new Error(`rate-distortion: 失真权重 w₀₁/w₁₀ 必须为正有限数（收到 ${w01}/${w10}）`);
  }
  if (!(beta > 0) || !Number.isFinite(beta)) {
    throw new Error(`rate-distortion: beta 必须 > 0（收到 ${beta}）`);
  }
}

/**
 * 加权（不对称）汉明失真的率失真函数 R(D)（bit）。
 *
 * 对称失真（w₀₁ = w₁₀）时精确退化为 H₂(p) − H₂(D)；不对称时无初等
 * 闭式——D(β) 严格递减（β↑ ⟹ 更保真），由 β 二分反解目标失真，
 * 每次 D(β) 求值是一维不动点迭代（weightedHammingPoint）。
 * D ≥ D_max = min((1−p)w₀₁, p·w₁₀) 时诚实返回 0（恒猜代价小的一类
 * 即零失真上限）；D = 0 返回 H₂(p)（二值源零失真要全部熵）。
 */
export function weightedHammingRD(D: number, p: number, w01: number, w10: number): number {
  validateWeightedHamming(p, w01, w10, 1);
  if (!Number.isFinite(D) || D < 0) throw new Error(`rate-distortion: 失真 D 必须 ≥ 0（收到 ${D}）`);
  const dMax = Math.min((1 - p) * w01, p * w10);
  if (D >= dMax) return 0;
  if (D === 0) return binaryEntropy(p);
  // β 括号扩展：D(β) 从 D_max（β→0⁺）单调降到 0（β→∞）
  let lo = 1e-6;
  let hi = 1e6;
  for (let guard = 0; guard < 2000; guard += 1) {
    if (weightedHammingPoint(p, w01, w10, hi).distortion <= D) break;
    lo = hi;
    hi *= 2;
  }
  for (let guard = 0; guard < 2000; guard += 1) {
    if (weightedHammingPoint(p, w01, w10, lo).distortion >= D) break;
    hi = lo;
    lo /= 2;
  }
  // 二分至失真命中（D(β) 连续严格递减）
  for (let step = 0; step < 200; step += 1) {
    const mid = Math.sqrt(lo * hi); // 对数尺度二分（β 跨多个数量级）
    const dm = weightedHammingPoint(p, w01, w10, mid).distortion;
    if (Math.abs(dm - D) <= 1e-14 * Math.max(1, dMax)) {
      return weightedHammingPoint(p, w01, w10, mid).rate;
    }
    if (dm > D) lo = mid;
    else hi = mid;
  }
  return weightedHammingPoint(p, w01, w10, Math.sqrt(lo * hi)).rate;
}

/** 热启动 β 扫描点（rdCurveFast 的返回口径与 RdCurvePoint 一致 + 迭代数） */
export interface RdCurveFastPoint extends RdCurvePoint {
  /** 该 β 的 BA 迭代数（与冷启动对照的加速证据） */
  iterations: number;
}

/**
 * β 扫描热启动（R5-A13）：β 降序逐点跑 BA，上一点的收敛边际作下一点
 * 初值（RD 曲线上相邻点的测试信道连续）——同容差下迭代数显著下降，
 * 收敛点与冷启动 rdCurve 一致（BA 的 Lagrangian 最小化对内点初值全局
 * 收敛）。返回按失真升序，与 rdCurve 同构（附迭代数）。
 */
export function rdCurveFast(
  px: ReadonlyArray<number>,
  distortionMatrix: ReadonlyArray<ReadonlyArray<number>>,
  betas: ReadonlyArray<number>,
  options?: Omit<BlahutArimotoOptions, 'initialMarginal'>,
): RdCurveFastPoint[] {
  if (betas.length === 0) throw new Error('rate-distortion: betas 不能为空');
  for (const b of betas) {
    if (!(b > 0) || !Number.isFinite(b)) throw new Error(`rate-distortion: beta 必须 > 0（收到 ${b}）`);
  }
  const descending = [...betas].sort((a, b) => b - a);
  const points: RdCurveFastPoint[] = [];
  let warm: ReadonlyArray<number> | undefined;
  for (const beta of descending) {
    const r = blahutArimoto(px, distortionMatrix, beta, { ...options, initialMarginal: warm });
    points.push({ beta, distortion: r.distortion, rate: r.rate, converged: r.converged, iterations: r.iterations });
    warm = r.marginal;
  }
  points.sort((a, b) => a.distortion - b.distortion);
  return points;
}

// ─────────────────────────── 记忆压缩规划器 ───────────────────────────

/** 记忆条目（率失真分摊的原子：价值 + 三档比特代价） */
export interface MemoryEntry {
  /** 条目标识（输出 keep/compress/drop 名单用） */
  id: string;
  /** 条目价值 v ≥ 0（访问权重 × 重要性，调度方口径） */
  value: number;
  /** 全保真存储代价 b（bit） */
  sizeBits: number;
  /** 压缩档代价 c（bit；缺省 sizeBits/4） */
  compressedBits?: number;
  /** 压缩档价值留存率 ρ ∈ [0,1]（缺省 0.6） */
  retention?: number;
}

/** 压缩档决策（const 对象 + 字面量类型，strip 兼容） */
export type MemoryDecision = 'keep' | 'compress' | 'drop';

/** 压缩规划结果 */
export interface CompressionPlan {
  /** 全保真名单（按价值密度 v/b 降序） */
  keep: string[];
  /** 压缩档名单（按价值密度降序） */
  compress: string[];
  /** 遗忘名单（按价值密度降序——最先被忘的在最后） */
  drop: string[];
  /** 规划实际使用的比特 */
  usedBits: number;
  /** 规划保留的总价值（Σ keep: v + compress: ρv） */
  retainedValue: number;
  /** 全条目总价值（对照口径） */
  totalValue: number;
  /** 全保真总比特（对照口径） */
  fullBits: number;
  /**
   * 影子价格 λ*（价值/bit）：预算边界处的边际价值密度——
   * λ* 之上（低价值密度条目）被降档/遗忘，之下被保留。
   * 预算充裕（全 keep）时 λ* = 0（无影子价格，与 22.0 BwK 同语义）。
   */
  shadowPrice: number;
  /** 逐条目决策 */
  decisions: Record<string, MemoryDecision>;
}

/**
 * 记忆压缩规划器：预算约束下 keep/compress/drop 的率失真最优分摊。
 *
 * 三档的 (比特, 价值) 选择用影子价格 λ 扫描凸包：决策
 *   argmax{ v − λ·b, ρv − λ·c, 0 }（平手保高档——保真优先），
 * 总比特随 λ 下降单调上升，从全遗忘（λ=∞，0 bit）走到全保留
 * （λ=0，Σb bit）；取满足预算的最小 λ 为基点，剩余预算按
 * Δ价值/Δ比特降序贪心升档填充。均匀条目下即「按价值密度逐级
 * 前缀收缩」——预算越紧，留下的越是高价值密度条目。
 */
export function memoryCompressionPlanner(entries: ReadonlyArray<MemoryEntry>, budgetBits: number): CompressionPlan {
  if (entries.length === 0) throw new Error('rate-distortion: entries 不能为空');
  if (!Number.isFinite(budgetBits) || budgetBits < 0) {
    throw new Error(`rate-distortion: budgetBits 必须 ≥ 0（收到 ${budgetBits}）`);
  }
  const seen = new Set<string>();
  const items = entries.map((entry) => {
    if (!entry.id || seen.has(entry.id)) throw new Error(`rate-distortion: 条目 id 缺失或重复（${entry.id}）`);
    seen.add(entry.id);
    const value = entry.value;
    const sizeBits = entry.sizeBits;
    const compressed = entry.compressedBits ?? entry.sizeBits / 4;
    const retention = entry.retention ?? 0.6;
    if (!Number.isFinite(value) || value < 0) throw new Error(`rate-distortion: 条目 ${entry.id} 价值必须 ≥ 0（收到 ${value}）`);
    if (!Number.isFinite(sizeBits) || sizeBits <= 0) {
      throw new Error(`rate-distortion: 条目 ${entry.id} sizeBits 必须 > 0（收到 ${sizeBits}）`);
    }
    if (!Number.isFinite(compressed) || compressed < 0 || compressed > sizeBits) {
      throw new Error(`rate-distortion: 条目 ${entry.id} compressedBits 必须在 [0, sizeBits]（收到 ${compressed}）`);
    }
    if (!Number.isFinite(retention) || retention < 0 || retention > 1) {
      throw new Error(`rate-distortion: 条目 ${entry.id} retention 必须在 [0,1]（收到 ${retention}）`);
    }
    return { id: entry.id, value, sizeBits, compressed, retention };
  });

  // 候选影子价格：各条目三档两两无差异的临界 λ（含 ∞ 与 0 端点）
  const lambdas: number[] = [Number.POSITIVE_INFINITY, 0];
  for (const it of items) {
    if (it.sizeBits > it.compressed) {
      lambdas.push((it.value * (1 - it.retention)) / (it.sizeBits - it.compressed)); // keep ↔ compress
    }
    if (it.compressed > 0) {
      lambdas.push((it.retention * it.value) / it.compressed); // compress ↔ drop
    }
    lambdas.push(it.value / it.sizeBits); // keep ↔ drop
  }
  lambdas.sort((a, b) => b - a);

  const decisionAt = (lambda: number): MemoryDecision[] =>
    items.map((it) => {
      const sKeep = it.value - lambda * it.sizeBits;
      const sCompress = it.retention * it.value - lambda * it.compressed;
      const sDrop = 0;
      // 平手偏向高档（保真优先）：keep > compress > drop
      if (sKeep >= sCompress - 1e-12 && sKeep >= sDrop - 1e-12) return 'keep';
      if (sCompress >= sDrop - 1e-12) return 'compress';
      return 'drop';
    });
  const bitsOf = (decisions: ReadonlyArray<MemoryDecision>): number => {
    let bits = 0;
    for (let i = 0; i < decisions.length; i += 1) {
      if (decisions[i] === 'keep') bits += items[i].sizeBits;
      else if (decisions[i] === 'compress') bits += items[i].compressed;
    }
    return bits;
  };

  // λ 凸包扫描（降序）：bits(λ) 随 λ 单调不增——自 ∞（全 drop，恒可行）
  // 一路下降，**持续更新到仍满足预算的最小 λ**（最紧计划）；
  // 首次超预算即停（单调性保证其下全部超支）。λ* 即预算边界处的
  // 影子价格：低于它的任何计划都买不起。
  let chosen: MemoryDecision[] = decisionAt(Number.POSITIVE_INFINITY); // 全 drop（0 bit），恒可行
  let shadowPrice = Number.POSITIVE_INFINITY;
  for (const lambda of lambdas) {
    const decisions = decisionAt(lambda);
    if (bitsOf(decisions) <= budgetBits + 1e-9) {
      chosen = decisions;
      shadowPrice = lambda;
    } else {
      break;
    }
  }

  // 剩余预算贪心升档（Δ价值/Δ比特 降序；平手按条目序，确定性）
  let remaining = budgetBits - bitsOf(chosen);
  const order = items
    .map((it, index) => {
      const toCompress = it.retention * it.value; // drop → compress
      const bitsCompress = it.compressed;
      const toKeep = it.value - it.retention * it.value; // compress → keep
      const bitsKeep = it.sizeBits - it.compressed;
      return { index, toCompress, bitsCompress, toKeep, bitsKeep };
    })
    .filter((u) => chosen[u.index] === 'drop' || chosen[u.index] === 'compress');
  // 每轮选全局最优升档（按价值密度 Δv/Δb；n 小，重复扫描保持简单确定）
  let improved = true;
  while (improved) {
    improved = false;
    let bestIndex = -1;
    let bestDensity = 0;
    let bestDeltaBits = 0;
    for (const u of order) {
      const dc = u.bitsCompress > 0 ? u.toCompress / u.bitsCompress : u.toCompress > 0 ? Infinity : 0;
      const dk = u.bitsKeep > 0 ? u.toKeep / u.bitsKeep : u.toKeep > 0 ? Infinity : 0;
      if (chosen[u.index] === 'drop' && u.bitsCompress <= remaining + 1e-9 && dc > bestDensity + 1e-12) {
        bestIndex = u.index;
        bestDensity = dc;
        bestDeltaBits = u.bitsCompress;
        improved = true;
      }
      if (chosen[u.index] === 'compress' && u.bitsKeep <= remaining + 1e-9 && dk > bestDensity + 1e-12) {
        bestIndex = u.index;
        bestDensity = dk;
        bestDeltaBits = u.bitsKeep;
        improved = true;
      }
    }
    if (improved && bestIndex >= 0) {
      chosen[bestIndex] = chosen[bestIndex] === 'drop' ? 'compress' : 'keep';
      remaining -= bestDeltaBits;
    }
  }

  const decisions: Record<string, MemoryDecision> = {};
  let usedBits = 0;
  let retainedValue = 0;
  let totalValue = 0;
  let fullBits = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    decisions[it.id] = chosen[i];
    totalValue += it.value;
    fullBits += it.sizeBits;
    if (chosen[i] === 'keep') {
      usedBits += it.sizeBits;
      retainedValue += it.value;
    } else if (chosen[i] === 'compress') {
      usedBits += it.compressed;
      retainedValue += it.retention * it.value;
    }
  }
  const densityOf = (i: number): number => items[i].value / items[i].sizeBits;
  const byDensity = items.map((_, i) => i).sort((a, b) => densityOf(b) - densityOf(a) || (a < b ? -1 : 1));
  const keep: string[] = [];
  const compress: string[] = [];
  const drop: string[] = [];
  for (const i of byDensity) {
    if (chosen[i] === 'keep') keep.push(items[i].id);
    else if (chosen[i] === 'compress') compress.push(items[i].id);
    else drop.push(items[i].id);
  }
  return {
    keep,
    compress,
    drop,
    usedBits: round(usedBits),
    retainedValue: round(retainedValue),
    totalValue: round(totalValue),
    fullBits: round(fullBits),
    shadowPrice: shadowPrice === Number.POSITIVE_INFINITY ? 0 : round(shadowPrice),
    decisions,
  };
}

// ─────────────────────────── 工具 ───────────────────────────

function round(x: number): number {
  return Number(x.toFixed(6));
}

/* ── 接线建议 ─────────────────────────────────────────────────────────
 *
 * 1. 长期记忆分层压缩（升级现有记忆蒸馏的经验规则）：
 *    - 蒸馏周期把记忆条目按 (访问权重 × 重要性) 估价值 v，按存储
 *      实测估 b（原文 token 数 × 每 token 比特）；压缩档 c/ρ 由
 *      蒸馏器的能力标定（如摘要长度与任务保持率）；
 *    - 预算 = 记忆库容量 − 已用；memoryCompressionPlanner 直接给出
 *      keep/compress/drop 三档与影子价格 λ*。
 *
 * 2. 遗忘的价格仪表：
 *    - λ* 逐周期追踪：λ* 上升 = 记忆库趋紧（遗忘变贵之前先变贵了
 *      边际条目）；λ* = 0 = 容量充裕。这是记忆健康度的第一条
 *      信息论 KPI（对照 22.0 BwK 的影子价格仪表）。
 *
 * 3. 保真度预算决策（rdCurve 的直接应用）：
 *    - 记忆条目价值分布 → 离散源 px；压缩档间失真 → d(x, x̂)；
 *      rdCurve 给出「预算比特 ↔ 可保失真」的前沿，容量规划时
 *      直接查表（该花多少 bit 买多少保真）。
 *
 * 4. 挂载边界（零介入承诺）：
 *    - 只读挂载：内核不发起任何删除/压缩动作，仅返回规划与定价；
 *      执行仍由记忆蒸馏管线决定；未挂载时现有水位规则逐位一致。
 * ────────────────────────────────────────────────────────────────── */
