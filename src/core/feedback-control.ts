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
export function dareIterate(a: number, b: number, q: number, r: number, iterations = 2000, tol = 1e-12): { p: number; converged: boolean } {
  if (!(r > 0)) throw new Error('dareIterate: r 必须 > 0');
  let p = q; // 从 q 起步（P ≥ q 单调递增到不动点）
  let converged = false;
  for (let k = 0; k < iterations; k += 1) {
    const next = q + a * a * p - (a * a * b * b * p * p) / (r + b * b * p);
    if (Math.abs(next - p) <= tol) {
      p = next;
      converged = true;
      break;
    }
    p = next;
  }
  return { p, converged };
}

/** LQR 增益 K = abP/(r + b²P)（P 为 DARE 解） */
export function lqrGain(a: number, b: number, p: number, r: number): number {
  return (a * b * p) / (r + b * b * p);
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
