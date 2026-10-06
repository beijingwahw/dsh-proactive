/**
 * 35.0 反馈控制内核 —— 离散 LQR + Lyapunov 证书：并发极限的闭环驾驭
 *
 * 动机: 25.0 容量规划用排队论**反解**最优并发（Erlang-C / Kingman）——
 * 但那是开环的：模型给一个静态建议，世界变了它不知道。真实的负载是
 * 非平稳的（模型变慢、配额收紧、流量起伏），并发上限需要**闭环**：
 *
 *   反馈律: u_k = u_{k−1} + K·(y* − y_k)     （y = 实测利用率，y* = 目标）
 *   闭环系统 y_{k+1} = (1 − bK)·y_k + bK·y* + 噪声
 *
 *   最优 K 从离散代数 Riccati 方程（DARE）解出:
 *     P = q + a²P − a²b²P²/(r + b²P),   K = abP/(r + b²P)
 *   a = 1（积分器口径）时有**闭式解**（P² − qP − qr/b² = 0）:
 *     P = (q + √(q² + 4qr/b²))/2
 *   ——闭式与不动点迭代逐位对账，控制增益不是调出来的，是解出来的。
 *
 *   Lyapunov 证书（与 15.0「证明携带」同一哲学）: 取 V(x) = P x²，则
 *   DARE 恒等式给出
 *     V(x_{k+1}) − V(x_k) = −(q x_k² + r u_k²) ≤ 0
 *   ——闭环的每一步都被李雅普诺夫函数**证明**不发散（数值上逐位可查），
 *   稳定性不是观察出来的，是代数恒等式。
 *
 *   工程加固: 死区（|e| < ε 不动——抗抖振）、输出钳位 [u_min, u_max]、
 *   增益调度保守化（b 未知时按最坏灵敏度取下界 b_min——保证 0 < bK < 2
 *   的稳定域对真实 b 稳健）。AIMD 式启发式调参从此退役。
 *
 * 零漂移: 未挂载时 computeParallelism 与升级前逐位一致（静态口径）。
 */

/** 标量 DARE（a=1 积分器口径）闭式解：P = (q + √(q² + 4qr/b²))/2 */
export function dareScalarClosedForm(b: number, q: number, r: number): number {
  if (!(b > 0)) throw new Error('dareScalarClosedForm: b 必须 > 0');
  return (q + Math.sqrt(q * q + (4 * q * r) / (b * b))) / 2;
}

/** 标量 DARE 不动点迭代（一般 a；收敛判据 |P_{k+1} − P_k| ≤ tol） */
export function dareIterate(a: number, b: number, q: number, r: number, iterations = 2000, tol = 1e-12, p0?: number): { p: number; converged: boolean; iterationsUsed: number } {
  if (!(r > 0)) throw new Error('dareIterate: r 必须 > 0');
  let p: number;
  if (p0 !== undefined) {
    if (!Number.isFinite(p0) || p0 < 0) throw new Error(`dareIterate: p0=${String(p0)} 必须为有限非负数`);
    p = p0; // 热启动: LPV 参数漂移下复用上一步解（轴 2 性能进化）
  } else {
    p = q; // 从 q 起步（P ≥ q 单调递增到不动点）
  }
  let converged = false;
  let used = 0;
  for (let k = 0; k < iterations; k += 1) {
    used = k + 1;
    const next = q + a * a * p - (a * a * b * b * p * p) / (r + b * b * p);
    if (!Number.isFinite(next)) throw new Error('dareIterate: 迭代发散为非有限值（检查 a/b/q/r）');
    if (Math.abs(next - p) <= tol) {
      p = next;
      converged = true;
      break;
    }
    p = next;
  }
  return { p, converged, iterationsUsed: used };
}

/** LQR 增益 K = abP/(r + b²P)（P 为 DARE 解） */
export function lqrGain(a: number, b: number, p: number, r: number): number {
  return (a * b * p) / (r + b * b * p);
}

/**
 * 一般 a 的标量 DARE **精确闭式解**（R5 轴 2 性能进化）:
 *   P = q + a²P − a²b²P²/(r + b²P)
 * 两边乘 (r + b²P) 展开即二次方程
 *   b²P² − (qb² − r(1−a²))·P − qr = 0，
 * 常数项 −qr < 0 ⟹ 恰有一个正根（= 唯一正定/镇定解）:
 *   P = [c + √(c² + 4b²qr)] / (2b²)，c = qb² − r(1−a²)。
 * a=1 时退化为 dareScalarClosedForm 的 P = (q+√(q²+4qr/b²))/2。
 * 数值口径: c ≥ 0 时用有理化形式 P = 2qr/(√(c²+4b²qr) − c) 避免
 * 大数相消（两个正根公式代数恒等，机器精度内一致）。
 * O(1) 精确解替代 O(收敛率) 次不动点迭代——a≠1 的 LPV 增益调度
 * 从「每档迭代 ~50 次」变成「每档一次求根公式」。
 */
export function dareScalarGeneralClosedForm(a: number, b: number, q: number, r: number): number {
  if (!(b > 0)) throw new Error('dareScalarGeneralClosedForm: b 必须 > 0');
  if (!(q > 0)) throw new Error('dareScalarGeneralClosedForm: q 必须 > 0');
  if (!(r > 0)) throw new Error('dareScalarGeneralClosedForm: r 必须 > 0');
  if (!Number.isFinite(a)) throw new Error('dareScalarGeneralClosedForm: a 必须为有限数');
  const b2 = b * b;
  const c = q * b2 - r * (1 - a * a);
  const disc = Math.sqrt(c * c + 4 * b2 * q * r);
  return c >= 0 ? (2 * q * r) / (disc - c) : (c + disc) / (2 * b2);
}

export interface FeedbackControllerConfig {
  /** 目标利用率 y* ∈ (0,1]（缺省 0.75——留 25% 余量吸收突发） */
  target?: number;
  /** 一阶增益标称被控对象系数 b（灵敏度下界；缺省 0.4） */
  plantGain?: number;
  /** 状态权重 q（缺省 1.0——误差的代价） */
  q?: number;
  /** 控制权重 r（缺省 4.0——动作的代价，越大越保守） */
  r?: number;
  /** 死区半宽（|e| < deadband 不动作；缺省 0.05——抗抖振） */
  deadband?: number;
  /** 输出下限（缺省 1） */
  minOutput?: number;
  /** 输出上限（缺省 16） */
  maxOutput?: number;
  /** 初始输出（缺省 = 上限与下限之间靠上（保守起步）） */
  initialOutput?: number;
}

export interface ControlStep {
  /** 控制输出（本周期并发上限） */
  output: number;
  /** 误差 e = y* − y（正 = 利用率不足，可放并发；负 = 过载） */
  error: number;
  /** 本步增量（死区内为 0） */
  increment: number;
  /** Lyapunov 函数值 V = P·e²（单调不增的证明对象） */
  lyapunov: number;
  /** 增益与闭环极点（审计口径） */
  meta: { gainK: number; closedLoopPole: number; p: number; method: 'closed-form' };
}

/**
 * Lyapunov 稳定的并发反馈控制器。
 *
 * 被控对象口径（积分器）: y_{k+1} = y_k + b·Δu_k；控制 Δu = K·(y*−y)。
 * 输出钳位同时充当抗积分饱和（输出到界后误差继续累计不再积深——
 * 增量直接被钳位截断，无 hidden state）。
 */
export class FeedbackController {
  private readonly target: number;
  private readonly b: number;
  private readonly q: number;
  private readonly r: number;
  private readonly deadband: number;
  private readonly minOutput: number;
  private readonly maxOutput: number;
  private readonly p: number;
  private readonly k: number;
  private output: number;
  private lastError: number | undefined;

  constructor(config?: FeedbackControllerConfig) {
    this.target = clamp(config?.target ?? 0.75, 0.05, 1);
    this.b = clamp(config?.plantGain ?? 0.4, 1e-3, 10);
    this.q = Math.max(1e-6, config?.q ?? 1);
    this.r = Math.max(1e-6, config?.r ?? 4);
    this.deadband = Math.max(0, config?.deadband ?? 0.05);
    this.minOutput = Math.max(1, config?.minOutput ?? 1);
    this.maxOutput = Math.max(this.minOutput, config?.maxOutput ?? 16);
    this.output = clamp(config?.initialOutput ?? Math.ceil((this.minOutput + this.maxOutput) / 2), this.minOutput, this.maxOutput);
    this.p = dareScalarClosedForm(this.b, this.q, this.r);
    this.k = lqrGain(1, this.b, this.p, this.r);
  }

  /** LQR 增益（审计） */
  get gain(): number {
    return this.k;
  }

  /** 闭环极点 1 − bK（|·| < 1 即稳定；本口径 ∈ (0,1)） */
  get closedLoopPole(): number {
    return 1 - this.b * this.k;
  }

  /** DARE 解 P（Lyapunov 函数的系数） */
  get dare(): number {
    return this.p;
  }

  /** 当前输出（只读） */
  get currentOutput(): number {
    return this.output;
  }

  /**
   * 一步反馈：观测当前利用率 measured，返回新输出。
   *
   * Lyapunov: V(e) = P·e²；按被控对象模型 e_{k+1} = (1−bK)e_k，
   * V(e_{k+1}) − V(e_k) = −(q e² + r u²) ≤ 0 —— DARE 恒等式（数值
   * 验证见 verify-equilibrium-kernels）。死区/钳位只会让动作更小
   * （V 降得更慢），不会破坏单调性。
   */
  step(measured: number): ControlStep {
    const y = clamp(measured, 0, 2); // 防御：利用率口径外值收口
    const error = this.target - y;
    const inDeadband = Math.abs(error) < this.deadband;
    const rawIncrement = this.k * error;
    const increment = inDeadband ? 0 : rawIncrement;
    const previous = this.output;
    const next = clamp(this.output + increment, this.minOutput, this.maxOutput);
    this.output = next;
    this.lastError = error;
    return {
      output: next,
      error,
      increment: next - previous,
      lyapunov: this.p * error * error,
      meta: { gainK: this.k, closedLoopPole: this.closedLoopPole, p: this.p, method: 'closed-form' },
    };
  }

  /** 最近一次误差（未 step 时 undefined） */
  get lastStepError(): number | undefined {
    return this.lastError;
  }
}

/**
 * Lyapunov 证书审计（验证锚点）: 在被控对象模型 y_{k+1} = y_k + b·Δu 上
 * 闭环仿真，逐步断言 V(e_{k+1}) − V(e_k) = −(q·e_k² + r·(K·e_k)²)（DARE
 * 恒等式应到机器精度），返回最大残差。
 */
export function lyapunovCertificate(
  config: FeedbackControllerConfig,
  initialY: number,
  steps = 50,
): { maxResidual: number; convergedToTarget: boolean; finalError: number; pole: number } {
  const controller = new FeedbackController(config);
  const b = controller['b'];
  const q = controller['q'];
  const r = controller['r'];
  let y = initialY;
  let maxResidual = 0;
  for (let k = 0; k < steps; k += 1) {
    const before = controller.step(y);
    const e = before.error;
    const u = controller.gain * e;
    // 被控对象积分器动力学
    const nextY = y + b * u;
    const eNext = controller['target'] - nextY;
    const vBefore = controller.dare * e * e;
    const vAfter = controller.dare * eNext * eNext;
    const predictedDrop = q * e * e + r * u * u;
    const residual = Math.abs(vBefore - vAfter - predictedDrop);
    maxResidual = Math.max(maxResidual, residual);
    y = nextY;
  }
  return { maxResidual, convergedToTarget: Math.abs(controller.lastStepError ?? 1) < 0.02, finalError: controller.lastStepError ?? 1, pole: controller.closedLoopPole };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));
}

// ══════════════════════ R5 进化（第五轮·世界性进化） ══════════════════════
//
// 轴 1（数学）: LQG 输出反馈（分离定理的工程化）。
//   35.0 的 LQR 假设状态可测——但真实系统只给**带噪读数** y = c·x + v
//   （利用率测量有采样噪声、延迟遥测有抖动）。LQG = Kalman 滤波 + LQR:
//     滤波器（对偶 DARE）: P_e = W + a²P_e − a²c²P_e²/(V + c²P_e)，
//                          L = a·P_e·c/(V + c²P_e)，x̂⁺ = x̂⁻ + L(y − c·x̂⁻)；
//     调节器（原 DARE）  : u = −K·x̂，K = abP/(r + b²P)。
//   分离定理（确定性等价）: 闭环极点 = {a − bK} ∪ {a − cL}——设计滤波器时
//   可以当控制已知，设计控制时可以当状态已知，两个 DARE 各解各的。
//   数值读数: 估计误差方差 → P_e（a=1 随机游走 + 噪声观测的稳态跟踪），
//   且**控制开/关不改变它**（估计误差动态 e' = (a−cL)e + w − Lv 与 u
//   无关——分离定理的仿真读数）。
//
// 轴 2（性能）: LPV（线性变参数）增益调度的 Riccati 迭代复用。
//   参数（q 随负载档、b 随模型组合）缓慢漂移时，每档从 q 冷启动迭代到
//   1e-12 需数十次; 以上一档的解作初值（dareIterate 新增 p0 热启动），
//   不动点只挪了一点点，2–4 次收敛——同一不动点，迭代数一个量级下降。
//
// 轴 3（数值）: Kalman 协方差更新的 Joseph 形式。
//   标准式 P⁺ = P − c²P²/(V + c²P) 是两近似大数的差——P 大 V 小时
//   catastrophic cancellation（P ≳ 1e154 时 c²P² 溢出为 ∞ → NaN/负数）。
//   Joseph 形式 P⁺ = (1−Lc)²P + L²V 与标准式**代数恒等**，但是两个非负项
//   的平方和结构: 浮点下恒 ≥ 0、不溢出（L = cP/(V+c²P) 本身是良态比值）。
//   瞬态滤波全程 Joseph，稳态方差与对偶 DARE 不动点对账。
// ══════════════════════════════════════════════════════════

/** 确定性 PRNG（mulberry32；LQG 闭环仿真的唯一随机源，同 seed 逐位复现） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller 标准正态（过程/测量噪声采样） */
function gaussianNoise(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * 标量 Kalman 协方差更新（Joseph 形式，轴 3 数值进化）:
 *   L = cP/(V + c²P)，P⁺ = (1−Lc)²P + L²V。
 * 与标准式 P⁺ = P − c²P²/(V + c²P) 代数恒等，但为非负项平方和——
 * 浮点下恒非负、极值域（P ≫ V 或 c²P² 溢出）不失效。要求 P ≥ 0、V > 0。
 */
export function kalmanJosephUpdate(p: number, c: number, v: number): { pPlus: number; gain: number } {
  if (!Number.isFinite(p) || p < 0) throw new Error(`kalmanJosephUpdate: p=${String(p)} 必须为有限非负数`);
  if (!(v > 0) || !Number.isFinite(v)) throw new Error(`kalmanJosephUpdate: v=${String(v)} 必须为 >0 有限数`);
  if (!Number.isFinite(c)) throw new Error(`kalmanJosephUpdate: c=${String(c)} 必须为有限数`);
  const denom = v + c * c * p;
  const l = (c * p) / denom;
  const oneMinusLc = 1 - l * c;
  return { pPlus: oneMinusLc * oneMinusLc * p + l * l * v, gain: l };
}

/**
 * Kalman 稳态（对偶 DARE）: P⁻ = W + a²P⁻ − a²c²P⁻²/(V + c²P⁻) 的不动点
 * （P⁻ = 预测误差协方差），稳态 Kalman 增益 L = P⁻·c/(V + c²P⁻)，
 * 估计器极点 a(1 − Lc)（预测误差动态 ẽ' = a(1−Lc)ẽ + w − Lv 的谱）。
 * 与 dareIterate 同一迭代（b←c、q←W、r←V），收敛判据一致。
 */
export function kalmanSteadyState(
  a: number,
  c: number,
  processNoise: number,
  measureNoise: number,
): { p: number; gain: number; pole: number; converged: boolean } {
  if (!(measureNoise > 0)) throw new Error(`kalmanSteadyState: measureNoise=${String(measureNoise)} 必须 > 0`);
  if (!(processNoise >= 0)) throw new Error(`kalmanSteadyState: processNoise=${String(processNoise)} 必须 ≥ 0`);
  if (!Number.isFinite(a) || !Number.isFinite(c) || c === 0) throw new Error('kalmanSteadyState: 需有限 a 与非零 c');
  const it = dareIterate(a, c, processNoise, measureNoise);
  return {
    p: it.p,
    gain: (it.p * c) / (measureNoise + c * c * it.p),
    pole: a - (a * it.p * c * c) / (measureNoise + c * c * it.p),
    converged: it.converged,
  };
}

/** LQG 配置（输出反馈; 与 FeedbackControllerConfig 同域） */
export interface LqgConfig {
  /** 目标利用率 y*（缺省 0.75） */
  target?: number;
  /** 被控对象系数 a（缺省 1——积分器口径） */
  plantA?: number;
  /** 控制系数 b（缺省 0.4） */
  plantB?: number;
  /** 观测系数 c（缺省 1——误差信号直接可读） */
  observeC?: number;
  /** 状态权重 q（缺省 1） */
  q?: number;
  /** 控制权重 r（缺省 4） */
  r?: number;
  /** 过程噪声方差 W ≥ 0（缺省 0.02——负载漂移） */
  processNoise?: number;
  /** 测量噪声方差 V > 0（缺省 0.25——遥测抖动） */
  measureNoise?: number;
  /** 初始真实状态 x₀（仅 lqgSimulate 消费; 缺省 0.3——欠载缺口） */
  x0?: number;
}

/** LQG 一步（估计 + 控制 + 审计） */
export interface LqgStep {
  /** 状态估计 x̂（先预测后校正的当前后验） */
  estimate: number;
  /** 控制量 u = K·x̂（并发增量; 与 FeedbackController 的 Δu = K·e 同号口径） */
  control: number;
  /** 新息 y − c·x̂⁻（滤波器的驱动残差） */
  innovation: number;
  /** 当前估计方差（稳态口径: 对偶 DARE 解 P_e） */
  covariance: number;
  meta: { kalmanGain: number; regulatorGain: number; estimatorPole: number; regulatorPole: number };
}

/**
 * LQG 输出反馈控制器（分离定理的工程化: Kalman + LQR，稳态增益口径）。
 * 每步: 预测 x̂⁻ = a·x̂ + b·u_prev → 读带噪观测 y = target − measuredY（c=1
 * 口径）→ 校正 x̂ = x̂⁻ + L·(y − x̂⁻) → 控制 u = K·x̂。测量噪声由对偶 DARE
 * 定价进增益——「读数抖多少，滤波器就信多少」，不再需要手工平滑窗口。
 */
export class LqgController {
  private readonly a: number;
  private readonly b: number;
  private readonly q: number;
  private readonly r: number;
  private readonly target: number;
  private readonly steady: { p: number; gain: number; pole: number; converged: boolean };
  private readonly k: number;
  private xHat: number;
  private lastU: number;
  private booted = false;

  constructor(config?: LqgConfig) {
    this.target = clamp(config?.target ?? 0.75, -1e9, 1e9);
    this.a = clamp(config?.plantA ?? 1, 0.05, 2);
    this.b = clamp(config?.plantB ?? 0.4, 1e-3, 10);
    this.q = Math.max(1e-6, config?.q ?? 1);
    this.r = Math.max(1e-6, config?.r ?? 4);
    const w = Math.max(0, config?.processNoise ?? 0.02);
    const v = Math.max(1e-9, config?.measureNoise ?? 0.25);
    this.steady = kalmanSteadyState(this.a, 1, w, v);
    this.k = lqrGain(this.a, this.b, dareIterate(this.a, this.b, this.q, this.r).p, this.r);
    this.xHat = 0;
    this.lastU = 0;
  }

  /** Kalman 稳态增益 L（审计） */
  get kalmanGain(): number {
    return this.steady.gain;
  }

  /** 调节器增益 K = abP/(r + b²P)（审计） */
  get regulatorGain(): number {
    return this.k;
  }

  /** 估计器极点 a − cL（|·| < 1 即滤波器稳定; 本口径 ∈ (0,1)） */
  get estimatorPole(): number {
    return this.steady.pole;
  }

  /** 调节器闭环极点 a − bK */
  get regulatorPole(): number {
    return this.a - this.b * this.k;
  }

  /** 分离定理读数: 闭环谱 = {a − bK} ∪ {a − cL}，两极点都在开单位圆内 ⟹ LQG 稳定 */
  get separationPoles(): { regulator: number; estimator: number; stable: boolean } {
    return {
      regulator: this.regulatorPole,
      estimator: this.estimatorPole,
      stable: Math.abs(this.regulatorPole) < 1 && Math.abs(this.estimatorPole) < 1,
    };
  }

  /** 稳态估计方差（对偶 DARE 解） */
  get steadyCovariance(): number {
    return this.steady.p;
  }

  /** 当前估计（只读） */
  get currentEstimate(): number {
    return this.xHat;
  }

  /** 一步 LQG: 读带噪利用率，出最优增量（确定性给定调用序列） */
  step(measuredY: number): LqgStep {
    const y = clamp(this.target - clamp(measuredY, -1e6, 1e6), -1e6, 1e6); // x 的带噪观测（c=1）
    const prior = this.booted ? this.a * this.xHat + this.b * this.lastU : y; // 首步用观测初始化（大 P₀ ⟹ 信观测）
    this.booted = true;
    const innovation = y - prior;
    this.xHat = prior + this.steady.gain * innovation;
    const control = this.k * this.xHat;
    this.lastU = control;
    return {
      estimate: this.xHat,
      control,
      innovation,
      covariance: this.steady.p,
      meta: {
        kalmanGain: this.steady.gain,
        regulatorGain: this.k,
        estimatorPole: this.estimatorPole,
        regulatorPole: this.regulatorPole,
      },
    };
  }
}

/** LQG 闭环仿真结果（分离定理与最优性的数值读数对象） */
export interface LqgSimResult {
  /** 稳态窗**预测误差**样本方差（x − x̂⁻；其理论值就是对偶 DARE 的 P⁻） */
  estimateErrorVariance: number;
  /** 对偶 DARE 理论稳态方差 P_e */
  theoreticalCovariance: number;
  /** 控制关闭对照（同噪声序列）的估计误差方差——分离定理: 与上面一致 */
  controlOffErrorVariance: number;
  /** 时间平均代价 Σ(qx² + ru²)/T（LQG 增益） */
  cost: number;
  /** 失调增益（gainScale·K）对照的时间平均代价 */
  costDetuned: number;
  regulatorPole: number;
  estimatorPole: number;
  /** 瞬态协方差全程非负（Joseph 形式的浮点保证） */
  covarianceNonnegative: boolean;
  maxAbsState: number;
  maxAbsStateControlOff: number;
  finalState: number;
}

/**
 * LQG 闭环仿真（确定性，种子化噪声）:
 *   x' = a·x + b·u + w（w ~ N(0,W)），y = c·x + v（v ~ N(0,V)）
 *   滤波: 瞬态 Kalman（Joseph 形式，P₀ = 10 大先验不确定性，一般 c）
 *   控制: u = −K·x̂（LQG）及 u = −gainScale·K·x̂（失调对照; 同 seed 保证
 *   同一噪声序列——公平对照）
 * 烧掉前 1/4 步的瞬态后统计稳态窗误差方差与时间平均代价。
 */
export function lqgSimulate(config: LqgConfig, steps: number, seed: number, options?: { gainScale?: number }): LqgSimResult {
  if (!Number.isInteger(steps) || steps < 1000) throw new Error(`lqgSimulate: steps=${String(steps)} 需为 ≥1000 的整数`);
  if (!Number.isInteger(seed) || seed < 0) throw new Error('lqgSimulate: seed 需为非负整数');
  const a = clamp(config.plantA ?? 1, 0.05, 2);
  const b = clamp(config.plantB ?? 0.4, 1e-3, 10);
  const c = clamp(config.observeC ?? 1, 1e-3, 10);
  const q = Math.max(1e-6, config.q ?? 1);
  const r = Math.max(1e-6, config.r ?? 4);
  const w = Math.max(0, config.processNoise ?? 0.02);
  const v = Math.max(1e-9, config.measureNoise ?? 0.25);
  const x0 = Number.isFinite(config.x0) ? (config.x0 as number) : 0.3;
  const gainScale = options?.gainScale ?? 1;
  if (!Number.isFinite(gainScale) || gainScale <= 0) throw new Error('lqgSimulate: gainScale 需为 >0 有限数');
  const est = kalmanSteadyState(a, c, w, v);
  const k = lqrGain(a, b, dareIterate(a, b, q, r).p, r);
  if (!(Math.abs(a - b * gainScale * k) < 1)) {
    throw new Error(`lqgSimulate: 失调极点 |a − b·gainScale·K| = ${Math.abs(a - b * gainScale * k)} ≥ 1（对照增益不稳定，换 gainScale）`);
  }

  const sweep = (uScale: number): { predErr2: number[]; cost: number; maxAbs: number; finalX: number; pNonNeg: boolean } => {
    const rng = mulberry32(seed >>> 0); // 同 seed ⟹ 同噪声序列（公平对照）
    let x = x0;
    let xHat = 0; // 无偏先验（滤波瞬态由 burn 窗烧掉）
    let p = 0.1; // 后验方差初值
    let pNonNeg = true;
    let lastU = 0;
    let cost = 0;
    let maxAbs = 0;
    const burn = Math.floor(steps / 4);
    const predErr2: number[] = [];
    for (let t = 0; t < steps; t += 1) {
      const y = c * x + Math.sqrt(v) * gaussianNoise(rng);
      // 预测: x̂⁻ = a·x̂ + b·u_prev；P⁻ = a²P + W（时间更新——噪声进方差）
      const priorX = a * xHat + b * lastU;
      const pPred = a * a * p + w;
      // 校正: L = P⁻c/(V + c²P⁻)；Joseph 形式测度更新（恒非负）
      const lT = (pPred * c) / (v + c * c * pPred);
      const { pPlus } = kalmanJosephUpdate(pPred, c, v);
      predErr2.push((x - priorX) * (x - priorX)); // 预测误差（其方差 → DARE 的 P⁻）
      xHat = priorX + lT * (y - c * priorX);
      p = pPlus;
      if (!(p >= 0)) pNonNeg = false;
      const u = -uScale * k * xHat;
      lastU = u;
      cost += q * x * x + r * u * u;
      x = a * x + b * u + (w > 0 ? Math.sqrt(w) * gaussianNoise(rng) : 0);
      if (Math.abs(x) > maxAbs) maxAbs = Math.abs(x);
    }
    return { predErr2, cost, maxAbs, finalX: x, pNonNeg };
  };

  const main = sweep(gainScale);
  const detuned = sweep(0.5); // 对照取 K/2（a − bK ∈ (0,1) ⟹ a − bK/2 ∈ (0,1) 稳定且次优）
  const off = sweep(0); // 控制关闭: a=1 时 x 随机游走发散，但估计误差方差不变（分离定理）
  const meanTail = (xs: number[]): number => {
    const tail = xs.slice(Math.floor(xs.length / 3)); // 末端稳态窗（烧掉滤波瞬态）
    return tail.reduce((s, z) => s + z, 0) / tail.length;
  };
  return {
    estimateErrorVariance: meanTail(main.predErr2),
    theoreticalCovariance: est.p,
    controlOffErrorVariance: meanTail(off.predErr2),
    cost: main.cost / steps,
    costDetuned: detuned.cost / steps,
    regulatorPole: a - b * k,
    estimatorPole: est.pole,
    covarianceNonnegative: main.pNonNeg && detuned.pNonNeg && off.pNonNeg,
    maxAbsState: main.maxAbs,
    maxAbsStateControlOff: off.maxAbs,
    finalState: main.finalX,
  };
}

/**
 * LPV 增益调度扫描（轴 2 性能进化的验证对象）: 沿参数漂移序列逐档解 DARE，
 * cold 每档从 q 起步，warm 复用上一档解。同一 tol 下两口径解一致，
 * warm 的总迭代数应低一个量级（漂移越慢差距越大）。
 */
export function dareSweepLpv(
  schedule: ReadonlyArray<{ a: number; b: number; q: number; r: number }>,
  mode: 'cold' | 'warm',
  tol = 1e-12,
): { solutions: number[]; totalIterations: number; allConverged: boolean } {
  if (!Array.isArray(schedule) || schedule.length === 0) throw new Error('dareSweepLpv: schedule 必须非空');
  const solutions: number[] = [];
  let totalIterations = 0;
  let allConverged = true;
  let prev: number | undefined;
  for (const s of schedule) {
    const it = dareIterate(s.a, s.b, s.q, s.r, 2000, tol, mode === 'warm' ? prev : undefined);
    solutions.push(it.p);
    totalIterations += it.iterationsUsed;
    if (!it.converged) allConverged = false;
    prev = it.p;
  }
  return { solutions, totalIterations, allConverged };
}
