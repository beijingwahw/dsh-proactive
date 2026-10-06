/**
 * resilience.ts — 弹性内核（项目 4.0「可靠执行」基石；R5 进化 4.1）
 *
 * 勘察结论（升级前）：task-executor 重试紧贴重发（无退避）、错误不分型
 * （网络错与质量错同路径）、无模型级熔断（同一坏模型被反复重试打爆配额）。
 *
 * 本内核把「熔断 + 退避 + 错误分型」做成全链路共享的纯组件：
 * - CircuitBreaker：closed → open（连续失败 ≥ 阈值）→ half-open（冷却后单试探，
 *   并发互斥——同一时刻只放行一个探测请求）→ closed（探测成功）
 * - CircuitBreakerRegistry：按 key（如 modelId）隔离的熔断器集合（容量上限防泄漏）
 * - backoffDelayMs：指数退避 + 全抖动（防惊群），可注入随机源保证测试确定性
 * - abortableSleep：可中止睡眠（全局超时到达时立即中断退避等待）
 * - classifyError：错误分型——可退避重试（网络/超时/限流）/ 立即重试 /
 *   换模型（能力类）/ 终止（不可恢复），驱动差异化重试策略
 *
 * R5 进化（4.0 → 4.1）——弹性从「熔断抢救」前移到「可用性数学」：
 * - Weibull 故障过程：生存/危险率/均值（MTBF = λ·Γ(1+1/k)）/方差/CV 全闭式，
 *   log 域生存函数 exp 溢出免疫；形状参数病态预警（条件数 |ln(t/λ)|·(t/λ)^k
 *   与 CV 退化双口径）——故障建模从「常数失效率」升级到形状可辨识
 * - 更新过程可用性：交替更新定理 A = MTTF/(MTTF+MTTR) 闭式 + log 域口径
 *   （A→1 时无灾难性抵消，1−A 的相对误差从 1e-4 级降到机器精度）
 * - 系统可用性闭式化：串行 ∏ / 并联 1−∏(1−a) / 异质 k-of-n 走精确
 *   Poisson-binomial 动态规划（O(n²)），替代蒙特卡洛的 O(n·N) 采样
 * - 弹性预算的定量分配：每单位预算在「冗余（q→q²）vs 恢复速度（q→q/2）」
 *   两杠杆间择优——闭式交叉点 q* = 1/2；可分离凹 + 整数预算 ⟹ 全局
 *   贪心 = 穷举最优（与 99.0 注意力经济同一贪心定理）
 */

import { TimeoutError, NetworkError } from '../errors.js';

/** 熔断器状态 */
export type BreakerState = 'closed' | 'open' | 'half-open';

/** 熔断器配置 */
export interface CircuitBreakerConfig {
  /** 连续失败进入熔断的阈值 */
  failureThreshold: number;
  /** 熔断冷却期（毫秒），期满转 half-open */
  cooldownMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 60_000,
};

/** 熔断器可执行性探测结果 */
export interface BreakerProbe {
  allowed: boolean;
  state: BreakerState;
  /** open 状态下距下次可试探的剩余毫秒 */
  msUntilRetry: number;
}

/** 熔断器状态快照（可观测性） */
export interface BreakerStatus {
  state: BreakerState;
  consecutiveFailures: number;
}

/**
 * 单 key 熔断器
 *
 * half-open 并发互斥：冷却期满后首个请求获得探测资格，其余请求仍被拒绝——
 * 避免冷却结束瞬间流量洪峰直接打到尚未恢复的下游。
 */
export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  /** half-open 探测互斥：>0 表示已有探测在途 */
  private halfOpenInFlight = 0;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
  }

  /** 探测当前是否放行（open 冷却期满时转入 half-open 并占用探测名额；放行后调用方须成对调用 recordSuccess/recordFailure，无法判定时用 releaseProbe 释放名额） */
  canExecute(now = Date.now()): BreakerProbe {
    if (this.state === 'open') {
      const elapsed = now - this.openedAt;
      if (elapsed < this.config.cooldownMs) {
        return { allowed: false, state: 'open', msUntilRetry: this.config.cooldownMs - elapsed };
      }
      this.state = 'half-open';
    }
    if (this.state === 'half-open') {
      // 并发互斥：已有探测在途时拒绝新请求
      if (this.halfOpenInFlight > 0) {
        return { allowed: false, state: 'half-open', msUntilRetry: this.config.cooldownMs };
      }
      this.halfOpenInFlight += 1;
      return { allowed: true, state: 'half-open', msUntilRetry: 0 };
    }
    return { allowed: true, state: 'closed', msUntilRetry: 0 };
  }

  /**
   * 无副作用检查：纯读取当前可执行性（不获取 half-open 探测名额）
   *
   * 用于候选过滤/展示等「只看不执行」场景——canExecute 在 half-open 态
   * 会占用探测名额，纯检查场景必须用 peek，否则名额泄漏导致永久误判熔断。
   */
  peek(now = Date.now()): BreakerProbe {
    if (this.state === 'open') {
      const elapsed = now - this.openedAt;
      if (elapsed < this.config.cooldownMs) {
        return { allowed: false, state: 'open', msUntilRetry: this.config.cooldownMs - elapsed };
      }
      // 冷却期满：将以 half-open 放行（无在途探测时）
      if (this.halfOpenInFlight > 0) {
        return { allowed: false, state: 'half-open', msUntilRetry: this.config.cooldownMs };
      }
      return { allowed: true, state: 'half-open', msUntilRetry: 0 };
    }
    if (this.state === 'half-open') {
      if (this.halfOpenInFlight > 0) {
        return { allowed: false, state: 'half-open', msUntilRetry: this.config.cooldownMs };
      }
      return { allowed: true, state: 'half-open', msUntilRetry: 0 };
    }
    return { allowed: true, state: 'closed', msUntilRetry: 0 };
  }

  /** 成功回报：清零失败计数，half-open 探测成功 → 恢复闭合 */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === 'half-open') this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    this.state = 'closed';
  }

  /** 失败回报：累计连续失败，达阈值熔断；half-open 探测失败 → 重新熔断 */
  recordFailure(now = Date.now()): void {
    if (this.state === 'half-open') this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.failureThreshold && this.state !== 'open') {
      this.state = 'open';
      this.openedAt = now;
    }
  }

  /** 状态快照（可观测性） */
  getState(): BreakerStatus {
    return { state: this.state, consecutiveFailures: this.consecutiveFailures };
  }

  /** 手动复位 */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.halfOpenInFlight = 0;
  }

  /**
   * 释放 half-open 探测资格（不改变成功/失败统计）
   *
   * 用于「请求已发出但无法判定下游可用性」的场景（如客户端 4xx）：
   * 探测互斥锁必须释放，否则后续请求永久被拒。
   */
  releaseProbe(): void {
    this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
  }
}

/**
 * 按 key 隔离的熔断器注册表
 *
 * 典型 key = modelId（模型 A 熔断不影响模型 B）；容量上限 + 简单 LRU 淘汰，
 * 防止长尾模型 id 导致的无界增长。
 */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();
  private config: CircuitBreakerConfig;
  private capacity: number;

  constructor(config?: Partial<CircuitBreakerConfig> & { capacity?: number }) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
    this.capacity = config?.capacity ?? 256;
  }

  private get(key: string): CircuitBreaker {
    let breaker = this.breakers.get(key);
    if (!breaker) {
      if (this.breakers.size >= this.capacity) {
        // 淘汰最旧条目（Map 迭代序 = 插入序；重访问不保序，容量上限场景足够）
        const oldest = this.breakers.keys().next().value;
        if (oldest !== undefined) this.breakers.delete(oldest);
      }
      breaker = new CircuitBreaker(this.config);
      this.breakers.set(key, breaker);
    }
    return breaker;
  }

  canExecute(key: string, now?: number): BreakerProbe {
    return this.get(key).canExecute(now);
  }

  /** 无副作用检查（纯读取，不占用 half-open 探测名额） */
  peek(key: string, now?: number): BreakerProbe {
    return this.get(key).peek(now);
  }

  recordSuccess(key: string): void {
    this.get(key).recordSuccess();
  }

  recordFailure(key: string): void {
    this.get(key).recordFailure();
  }

  releaseProbe(key: string): void {
    this.get(key).releaseProbe();
  }

  /** 全部熔断器状态（运维可观测） */
  snapshot(): Record<string, BreakerStatus> {
    const out: Record<string, BreakerStatus> = {};
    for (const [key, breaker] of this.breakers) out[key] = breaker.getState();
    return out;
  }

  /** 是否有任一 key 处于熔断（快速检查） */
  hasOpen(): boolean {
    for (const breaker of this.breakers.values()) {
      if (breaker.getState().state !== 'closed') return true;
    }
    return false;
  }

  reset(key?: string): void {
    if (key !== undefined) this.breakers.get(key)?.reset();
    else this.breakers.clear();
  }
}

/** 退避配置 */
export interface BackoffConfig {
  /** 首次退避基数（毫秒） */
  baseMs: number;
  /** 指数因子 */
  factor: number;
  /** 退避上限（毫秒）——防止大重试次数下延迟爆炸 */
  maxMs: number;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseMs: 200,
  factor: 2,
  maxMs: 8_000,
};

/**
 * 指数退避延迟（全抖动：[0, min(base × factor^(attempt-1), max)] 均匀采样）
 *
 * 全抖动（full jitter）相对确定性退避的优势：并发重试错峰，防惊群。
 * @param attempt 本次失败后的重试序号（1 = 第一次重试）
 * @param rng 随机源（测试可注入确定性实现）
 */
export function backoffDelayMs(attempt: number, config?: Partial<BackoffConfig>, rng: () => number = Math.random): number {
  const cfg = { ...DEFAULT_BACKOFF_CONFIG, ...config };
  const ceiling = Math.min(cfg.baseMs * Math.pow(cfg.factor, Math.max(0, attempt - 1)), cfg.maxMs);
  return Math.max(0, Math.round(rng() * ceiling));
}

/**
 * 可中止睡眠：全局超时/中止信号到达时立即返回 false（放弃重试）
 * @returns true = 睡满（可继续重试）；false = 被中止（放弃）
 */
export function abortableSleep(ms: number, abortSignal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!abortSignal?.aborted);
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 错误重试分型 */
export type RetryClass =
  /** 网络抖动/限流/超时：指数退避后原路重试（下游可能恢复） */
  | 'retryable-backoff'
  /** 已知幂等瞬时错：立即重试（如队列争用） */
  | 'retryable-immediate'
  /** 执行到达但产出不达标：重试无益，换模型（能力问题） */
  | 'switch-model'
  /** 不可恢复（配置错/鉴权错/未知错）：停止重试 */
  | 'fatal';

export interface ErrorClassification {
  class: RetryClass;
  /** 机器可读错误类别名 */
  kind: 'timeout' | 'network' | 'rate-limit' | 'server' | 'client' | 'quality' | 'unknown';
  /** 人类可读说明 */
  reason: string;
}

/** LLM 客户端可重试状态码（与 llm-client.ts 口径一致） */
const RETRYABLE_LLM_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * 错误分型（差异化重试的依据）
 *
 * 分型策略：
 * - TimeoutError → retryable-backoff（下游可能过载，退避让路）
 * - NetworkError → retryable-backoff（网络抖动，退避重试）
 * - 携带可重试状态码的 LLMError → retryable-backoff（429/5xx）
 * - 携带 4xx（非 408/429）状态码 → fatal（请求本身有问题，重试无意义）
 * - 质量不达标（由调用方在 verdict 层判定，不走本函数）→ switch-model
 * - 其余未知错误 → fatal（与升级前「非超时不重试」行为一致）
 */
export function classifyError(err: unknown): ErrorClassification {
  if (err instanceof TimeoutError) {
    return { class: 'retryable-backoff', kind: 'timeout', reason: '执行超时，退避后重试' };
  }
  if (err instanceof NetworkError) {
    return { class: 'retryable-backoff', kind: 'network', reason: '网络错误，退避后重试' };
  }
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === 'number') {
    if (status === 429) return { class: 'retryable-backoff', kind: 'rate-limit', reason: `限流（${status}），退避后重试` };
    if (RETRYABLE_LLM_STATUS.has(status)) return { class: 'retryable-backoff', kind: 'server', reason: `服务端错误（${status}），退避后重试` };
    return { class: 'fatal', kind: 'client', reason: `客户端错误（${status}），重试无意义` };
  }
  return { class: 'fatal', kind: 'unknown', reason: '未知错误，保守终止重试' };
}

// ═══════════════════════════════════════════════════════════════════
// R5 进化（4.0 → 4.1）—— Weibull 故障过程 · 更新过程可用性 · 弹性预算
// 纯数学闭式区：零 I/O、零时钟、零随机；全部确定性可复算
// ═══════════════════════════════════════════════════════════════════

/** Weibull 分布参数（形状 k > 0、尺度 λ > 0；k=1 退化为指数分布） */
export interface WeibullParams {
  /** 尺度 λ（特征寿命；S(λ) = e^{−1}） */
  readonly scale: number;
  /** 形状 k（k<1 早期失效、k=1 偶发失效、k>1 耗损耗效） */
  readonly shape: number;
}

function validateWeibull(params: WeibullParams, label: string): void {
  if (!params || !Number.isFinite(params.scale) || params.scale <= 0) {
    throw new Error(`${label}: scale (λ) 必须为有限正数`);
  }
  if (!Number.isFinite(params.shape) || params.shape <= 0) {
    throw new Error(`${label}: shape (k) 必须为有限正数`);
  }
}

/** Lanczos 逼近 Γ（g=7 / 9 系数，双精度全域 ~15 位有效数字；纯数学零依赖） */
const LANCZOS_G = 7;
const LANCZOS_COEFF: readonly number[] = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];
function gammaFn(z: number): number {
  if (!Number.isFinite(z) || z === 0) throw new Error('gammaFn: z 必须为非零有限数');
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
  z -= 1;
  let x = LANCZOS_COEFF[0] as number;
  for (let i = 1; i < LANCZOS_COEFF.length; i += 1) x += (LANCZOS_COEFF[i] as number) / (z + i);
  const t = z + LANCZOS_G + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

/**
 * Weibull 对数域生存函数: ln S(t) = −(t/λ)^k = −exp(k·(ln t − ln λ))
 *
 * 全程 log 域：k·(ln t − ln λ) > 709 时诚实地给出 −Infinity（S 下溢为 0），
 * 绝不经过 (t/λ)^k 的中间 exp 溢出——大形状/大倍数下的稳健路径。
 */
export function weibullLogSurvival(t: number, params: WeibullParams): number {
  validateWeibull(params, 'weibullLogSurvival');
  if (!Number.isFinite(t) || t < 0) throw new Error('weibullLogSurvival: t 必须 ≥ 0');
  if (t === 0) return 0; // S(0) = 1 ⟹ ln 1 = 0
  const exponent = params.shape * (Math.log(t) - Math.log(params.scale));
  return -Math.exp(exponent);
}

/** Weibull 生存函数 S(t) = exp(−(t/λ)^k)（log 域内核 + 下溢保护） */
export function weibullSurvival(t: number, params: WeibullParams): number {
  const logS = weibullLogSurvival(t, params);
  if (logS < -745) return 0; // exp 下溢（S < 5e-324）
  return Math.exp(logS);
}

/**
 * Weibull 危险率 h(t) = (k/λ)·(t/λ)^{k−1}（log 域计算）
 *
 * k=1 常数 1/λ（指数分布的无记忆性）；k>1 单调增（耗损耗效）；
 * k<1 单调减（早期失效）。t=0 且 k<1 时 +Infinity（诚实报告奇点）。
 */
export function weibullHazard(t: number, params: WeibullParams): number {
  validateWeibull(params, 'weibullHazard');
  if (!Number.isFinite(t) || t < 0) throw new Error('weibullHazard: t 必须 ≥ 0');
  // t=0: k<1 → (t/λ)^{k−1} = 0^{负} = +∞（奇点）；k=1 → 1/λ（无记忆常数）；
  // k>1 → (t/λ)^{k−1} = 0 ⟹ h(0) = 0（耗损型故障在起点尚未累积磨损）
  if (t === 0) return params.shape < 1 ? Infinity : params.shape === 1 ? 1 / params.scale : 0;
  const logRatio = Math.log(t) - Math.log(params.scale);
  const logH = Math.log(params.shape) - Math.log(params.scale) + (params.shape - 1) * logRatio;
  if (logH > 709) return Infinity;
  if (logH < -745) return 0;
  return Math.exp(logH);
}

/** Weibull 均值（MTTF/MTBF）= λ·Γ(1 + 1/k)（闭式；k=1 ⟹ λ） */
export function weibullMean(params: WeibullParams): number {
  validateWeibull(params, 'weibullMean');
  return params.scale * gammaFn(1 + 1 / params.shape);
}

/** Weibull 方差 = λ²·[Γ(1+2/k) − Γ²(1+1/k)]（闭式） */
export function weibullVariance(params: WeibullParams): number {
  validateWeibull(params, 'weibullVariance');
  const g1 = gammaFn(1 + 1 / params.shape);
  const g2 = gammaFn(1 + 2 / params.shape);
  return params.scale * params.scale * (g2 - g1 * g1);
}

/**
 * Weibull 变异系数 CV = σ/μ（形状的无量纲指纹）
 *
 * k=1（指数）CV = 1；k→∞ 时 CV → 0（寿命退化为确定性）；CV 只依赖 k。
 */
export function weibullCoefficientOfVariation(params: WeibullParams): number {
  validateWeibull(params, 'weibullCoefficientOfVariation');
  const mean = weibullMean(params);
  if (mean <= 0) throw new Error('weibullCoefficientOfVariation: 均值非正（参数病态）');
  return Math.sqrt(weibullVariance(params)) / mean;
}

/** Weibull 病态预警阈值：ln S 对形状参数的条件数超过 1e12 即病态 */
export const WEIBULL_SHAPE_CONDITION_LIMIT = 1e12;
/** Weibull 寿命退化阈值：CV < 1e-3 视为准确定性寿命（k 病态大） */
export const WEIBULL_CV_DEGENERATE_LIMIT = 1e-3;

/** Weibull 估计的病态诊断（数值稳健性预警） */
export interface WeibullConditionReport {
  readonly t: number;
  /** ln S(t)（log 域，无溢出） */
  readonly logSurvival: number;
  /**
   * ln S 对形状 k 的相对条件数 = |∂(−ln S)/∂ln k| = |ln(t/λ)|·(t/λ)^k
   * ——k 的 1 倍相对扰动在 −ln S 上被放大的倍数
   */
  readonly shapeSensitivity: number;
  /** shapeSensitivity > 1e12：形状参数的微小扰动被放大万亿倍（病态预警） */
  readonly illConditioned: boolean;
  /** CV < 1e-3：寿命分布退化为准确定性（形状病态大，失效率信息坍缩） */
  readonly degenerateLifetime: boolean;
  /** 人类可读预警（0..2 条） */
  readonly warnings: readonly string[];
}

/**
 * Weibull 病态预警：形状参数的两类病态在计算前被点名。
 *
 * ① 条件数病态：|ln(t/λ)|·(t/λ)^k > 1e12 —— 尾部生存概率对 k 极度敏感
 *   （如 t=3λ、k=40 时 ≈ 1.3e19），此时 S 的数值不可信，应改报 logSurvival
 *   或收紧 t/λ 的量程；② CV 退化：k 病态大时寿命趋近确定性（CV→0），
 *   「分布」退化为「定时器」，Weibull 建模失去信息量。
 */
export function weibullDiagnostics(t: number, params: WeibullParams): WeibullConditionReport {
  validateWeibull(params, 'weibullDiagnostics');
  if (!Number.isFinite(t) || t < 0) throw new Error('weibullDiagnostics: t 必须 ≥ 0');
  const logSurvival = weibullLogSurvival(t, params);
  const logRatio = t === 0 ? 0 : Math.abs(Math.log(t) - Math.log(params.scale));
  // (t/λ)^k = exp(k·ln(t/λ))：仅在 < 709 时有限（与 logSurvival 同域无溢出）
  const power = Math.exp(params.shape * (t === 0 ? -Infinity : Math.log(t) - Math.log(params.scale)));
  const shapeSensitivity = logRatio * (Number.isFinite(power) ? power : Infinity);
  const illConditioned = shapeSensitivity > WEIBULL_SHAPE_CONDITION_LIMIT;
  const cv = weibullCoefficientOfVariation(params);
  const degenerateLifetime = cv < WEIBULL_CV_DEGENERATE_LIMIT;
  const warnings: string[] = [];
  if (illConditioned) {
    warnings.push(`形状条件数 ${shapeSensitivity.toExponential(2)} > ${WEIBULL_SHAPE_CONDITION_LIMIT.toExponential(0)}：尾部对 k 极度敏感，优先使用 logSurvival`);
  }
  if (degenerateLifetime) {
    warnings.push(`CV = ${cv.toExponential(2)} < ${WEIBULL_CV_DEGENERATE_LIMIT}：寿命退化为准确定性（k = ${params.shape} 病态大）`);
  }
  return { t, logSurvival, shapeSensitivity, illConditioned, degenerateLifetime, warnings };
}

/** 交替更新过程的速率口径（均值时间） */
export interface RenewalRates {
  /** 平均无故障时间 MTTF ≥ 0（如 weibullMean(λ,k)） */
  readonly mttf: number;
  /** 平均修复时间 MTTR ≥ 0（修复期均值） */
  readonly mttr: number;
}

function validateRates(rates: RenewalRates, label: string): void {
  if (!rates || !Number.isFinite(rates.mttf) || rates.mttf < 0) throw new Error(`${label}: mttf 必须 ≥ 0`);
  if (!Number.isFinite(rates.mttr) || rates.mttr < 0) throw new Error(`${label}: mttr 必须 ≥ 0`);
  if (rates.mttf + rates.mttr <= 0) throw new Error(`${label}: mttf 与 mttr 不可同时为 0`);
}

/**
 * 稳态可用性（交替更新定理）: A = MTTF / (MTTF + MTTR)
 *
 * 不依赖寿命/修复时间的分布形状——只依赖两个均值（更新报酬定理）。
 * Weibull 可靠性与可用性在此接驳：MTTF = weibullMean({scale, shape})。
 */
export function steadyStateAvailability(rates: RenewalRates): number {
  validateRates(rates, 'steadyStateAvailability');
  return rates.mttf / (rates.mttf + rates.mttr);
}

/** log 域可用性（A→1 时无灾难性抵消） */
export interface LogDomainAvailability {
  /** 修复/运行比 ρ = MTTR/MTTF（≥ 0） */
  readonly rho: number;
  /** ln A = −ln1p(ρ)（≤ 0，机器精度） */
  readonly logAvailability: number;
  /** ln(1−A) = ln ρ − ln1p(ρ)（ρ→0 时仍全精度——补 Q 的关键路径） */
  readonly logUnavailability: number;
}

/**
 * log 域可用性: ρ = MTTR/MTTF；A = 1/(1+ρ)，Q = ρ/(1+ρ)。
 *
 * 数值动机：九个 9 的系统 ρ ≈ 1e-12，朴素 Q = 1 − mttf/(mttf+mttr) 在
 * double 上的绝对误差 ≈ ulp(1)/2 ≈ 1.1e-16，相对误差被放大 ~1e4 倍；
 * log 域 Q = exp(ln ρ − ln1p(ρ)) 的相对误差保持机器精度（1e-15 级）。
 */
export function logDomainAvailability(rates: RenewalRates): LogDomainAvailability {
  validateRates(rates, 'logDomainAvailability');
  if (rates.mttf === 0) return { rho: Infinity, logAvailability: -Infinity, logUnavailability: 0 };
  const rho = rates.mttr / rates.mttf;
  if (rho === 0) return { rho: 0, logAvailability: 0, logUnavailability: -Infinity };
  const log1pRho = Math.log1p(rho);
  return { rho, logAvailability: -log1pRho, logUnavailability: Math.log(rho) - log1pRho };
}

/** 系统拓扑（k-of-n 为「n 个异质组件至少 k 个在线」） */
export type SystemTopology =
  | { readonly kind: 'serial' }
  | { readonly kind: 'parallel' }
  | { readonly kind: 'k-of-n'; readonly k: number };

/**
 * 系统可用性闭式（异质组件的精确 Poisson-binomial 动态规划，O(n²)）
 *
 * - serial: k=n ⟹ A = ∏ aᵢ（串联，最弱环节）
 * - parallel: k=1 ⟹ A = 1 − ∏(1−aᵢ)（并联冗余）
 * - k-of-n: A = P(在线数 ≥ k)，异质可用性走精确 Poisson-binomial DP
 *   （逐组件卷积 pExactly[j]，无任何近似或采样）
 * 蒙特卡洛要 n·N 次采样才收敛到 3σ；闭式一次 DP 到机器精度。
 */
export function systemAvailability(availabilities: readonly number[], topology: SystemTopology): number {
  if (!Array.isArray(availabilities) || availabilities.length === 0) {
    throw new Error('systemAvailability: 组件可用性数组必须非空');
  }
  for (const a of availabilities) {
    if (!Number.isFinite(a) || a <= 0 || a >= 1) throw new Error('systemAvailability: 每个组件可用性必须 ∈ (0,1)');
  }
  let k: number;
  if (topology.kind === 'serial') k = availabilities.length;
  else if (topology.kind === 'parallel') k = 1;
  else {
    k = topology.k;
    if (!Number.isInteger(k) || k < 1 || k > availabilities.length) {
      throw new Error(`systemAvailability: k 必须 ∈ [1, n=${availabilities.length}] 的整数（收到 ${String(topology.k)}）`);
    }
  }
  // Poisson-binomial: pExactly[j] = 恰好 j 个组件在线的概率
  let pExactly: number[] = [1 - availabilities[0], availabilities[0]];
  for (let i = 1; i < availabilities.length; i += 1) {
    const a = availabilities[i] as number;
    const next = new Array<number>(pExactly.length + 1).fill(0);
    for (let j = 0; j < pExactly.length; j += 1) {
      next[j] += (pExactly[j] as number) * (1 - a);
      next[j + 1] += (pExactly[j] as number) * a;
    }
    pExactly = next;
  }
  let up = 0;
  for (let j = k; j < pExactly.length; j += 1) up += pExactly[j] as number;
  return up;
}

// ─────────────────────────── 弹性预算（冗余 vs 恢复速度的定量权衡） ───────────────────────────

/**
 * 冗余杠杆增益（闭式）: 再并联一个单元 q → q²，
 * ln(A′/A) = ln((1−q²)/(1−q)) = ln(1+q) —— q 越小增益越小（边际递减）。
 */
export function redundancyGainLog(availability: number): number {
  if (!Number.isFinite(availability) || availability <= 0 || availability >= 1) {
    throw new Error('redundancyGainLog: availability 必须 ∈ (0,1)');
  }
  return Math.log1p(1 - availability);
}

/**
 * 恢复速度杠杆增益（闭式）: 修复时间减半 q → q/2，
 * ln(A′/A) = ln((1−q/2)/(1−q)) = ln(1 + q/(2(1−q)))。
 */
export function repairSpeedGainLog(availability: number): number {
  if (!Number.isFinite(availability) || availability <= 0 || availability >= 1) {
    throw new Error('repairSpeedGainLog: availability 必须 ∈ (0,1)');
  }
  const q = 1 - availability;
  return Math.log1p(q / (2 * (1 - q)));
}

/** 冗余/恢复速度两杠杆增益的闭式交叉点：q* = 1/2（q<q* 冗余占优，q>q* 恢复占优） */
export const REDUNDANCY_REPAIR_CROSSOVER_Q = 0.5;

/** 弹性组件（待改进的串联环节） */
export interface ResilienceComponent {
  readonly id: string;
  /** 当前可用性 A ∈ (0,1)（不可用性 q = 1−A） */
  readonly availability: number;
}

/** 预算动作：在组件上扳一次杠杆 */
export interface ResilienceAction {
  readonly component: string;
  /** 'redundancy'（q→q²，再并联一单元）或 'repair-speed'（q→q/2，修复减半） */
  readonly lever: 'redundancy' | 'repair-speed';
  readonly availabilityBefore: number;
  readonly availabilityAfter: number;
  /** 本动作的系统对数可用性增益 ln(A_after/A_before) */
  readonly gainLogAvailability: number;
}

export interface ResilienceBudgetResult {
  /** 贪心执行序的动作列表（长度 = budget） */
  readonly actions: readonly ResilienceAction[];
  /** 初始系统可用性 = ∏ Aᵢ */
  readonly initialSystemAvailability: number;
  /** 最终系统可用性 = ∏ Aᵢ′ */
  readonly finalSystemAvailability: number;
  /** 逐组件动作数（输入序） */
  readonly allocations: readonly { id: string; count: number }[];
  /** 总对数增益 = ln(最终/初始) */
  readonly totalGainLog: number;
}

function applyLever(availability: number, lever: 'redundancy' | 'repair-speed'): number {
  const q = 1 - availability;
  return 1 - (lever === 'redundancy' ? q * q : q / 2);
}

/**
 * 弹性预算的定量分配（可分离凹 + 整数预算 ⟹ 贪心 = 穷举最优）
 *
 * 每单位预算在组件 i 上二选一：
 *   - redundancy:  q → q²      增益 ln(1+q)
 *   - repair-speed: q → q/2    增益 ln(1 + q/(2(1−q)))
 * 两条闭式引理（脚本侧穷举对照）：
 *   ① 杠杆交叉点 q* = 1/2：q < 1/2 冗余占优、q > 1/2 恢复占优（q = 1/2 恰好相等）；
 *     两杠杆都随 q 减小而增益递减 ⟹ 组件内逐部择优的杠杆序列即该组件最优序列；
 *   ② 组件边际增益单调不增（凹性）+ 系统目标 ∏Aᵢ 的对数可分离 ⟹ 全局逐部
 *     取最大增益的贪心分配 = 一切整数分配的最优（与 99.0 注意力经济同一定理）。
 * 系统口径为串联（∂ ln A_sys/∂ ln Aᵢ = 1，逐组件增益可直接比较）。
 */
export function resilienceBudget(components: readonly ResilienceComponent[], budget: number): ResilienceBudgetResult {
  if (!Array.isArray(components) || components.length === 0) throw new Error('resilienceBudget: components 必须为非空数组');
  if (!Number.isInteger(budget) || budget < 0) throw new Error('resilienceBudget: budget 必须 ≥ 0 的整数');
  const seen = new Set<string>();
  const current: number[] = [];
  for (let i = 0; i < components.length; i += 1) {
    const c = components[i] as ResilienceComponent;
    if (!c || typeof c.id !== 'string' || c.id.length === 0) throw new Error('resilienceBudget: 组件 id 必须为非空字符串');
    if (seen.has(c.id)) throw new Error(`resilienceBudget: 组件 id 重复（${c.id}）`);
    seen.add(c.id);
    if (!Number.isFinite(c.availability) || c.availability <= 0 || c.availability >= 1) {
      throw new Error(`resilienceBudget: 组件 ${c.id} 的 availability 必须 ∈ (0,1)`);
    }
    current.push(c.availability);
  }
  const n = components.length;
  const initialSystem = current.reduce((prod, a) => prod * a, 1);
  const actions: ResilienceAction[] = [];
  for (let step = 0; step < budget; step += 1) {
    // 组件内择优杠杆（并列取 redundancy——q=1/2 时两增益相等，先固化冗余更保守）;
    // 饱和处理: 反复杠杆后 1−q² 可舍入到 1（q 下溢）——内部增益按 0 结算，不触发输入校验
    let bestComp = -1;
    let bestLever: 'redundancy' | 'repair-speed' = 'redundancy';
    let bestGain = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const a = current[i] as number;
      const gR = a >= 1 ? 0 : redundancyGainLog(a);
      const gS = a >= 1 ? 0 : repairSpeedGainLog(a);
      const lever: 'redundancy' | 'repair-speed' = gS > gR ? 'repair-speed' : 'redundancy';
      const gain = Math.max(gR, gS);
      if (gain > bestGain) {
        bestGain = gain;
        bestComp = i;
        bestLever = lever;
      }
    }
    if (bestGain <= 0 && bestComp >= 0 && (current[bestComp] as number) >= 1) {
      // 全部组件饱和（可用性已达 1）: 记录零增益动作后继续（诚实: 预算花在饱和上无收益）
      actions.push({
        component: (components[bestComp] as ResilienceComponent).id,
        lever: bestLever,
        availabilityBefore: 1,
        availabilityAfter: 1,
        gainLogAvailability: 0,
      });
      continue;
    }
    const before = current[bestComp] as number;
    const after = applyLever(before, bestLever);
    current[bestComp] = after;
    actions.push({
      component: (components[bestComp] as ResilienceComponent).id,
      lever: bestLever,
      availabilityBefore: before,
      availabilityAfter: after,
      gainLogAvailability: bestGain,
    });
  }
  const finalSystem = current.reduce((prod, a) => prod * a, 1);
  const allocations = components.map((c) => ({
    id: c.id,
    count: actions.filter((x) => x.component === c.id).length,
  }));
  return {
    actions,
    initialSystemAvailability: initialSystem,
    finalSystemAvailability: finalSystem,
    allocations,
    totalGainLog: Math.log(finalSystem / initialSystem),
  };
}
