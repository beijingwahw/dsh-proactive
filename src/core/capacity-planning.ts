/**
 * 25.0 排队论容量规划内核 —— Erlang-C 精解 + Kingman 重尾近似 + Little 定律
 *
 * 模型: 每个模型组 = 一个 c 台服务池(c = maxConcurrency); 到达率 λ̂ 来自世界模型预测,
 * 服务时间分布 S 由 LLM 统计估计(μ̂ = 稳健平均延迟, SCV C_s² = σ̂²/μ̂², 重尾时 > 1)。
 *
 * M/M/c 精确解(Erlang-C):
 *     a = λ/μ(提供负载), ρ = a/c < 1
 *     Erlang-B 递推: B(0)=1, B(k) = a·B(k−1)/(k + a·B(k−1))
 *     等待概率 C = B(c) / (1 − ρ·(1 − B(c)))
 *     Wq = C / (cμ − λ),  Lq = λ·Wq
 *   c=1 时 C = ρ, Wq = ρ/(μ−λ) 恰为 M/M/1 精确解(自检锚点)。
 *
 * M/G/c 无闭式 → Kingman 重尾近似(负载越高越准):
 *     Wq ≈ ((C_a² + C_s²)/2) · (ρ/(1−ρ)) · E[S]/c,  泊松到达 C_a² = 1
 *   c=1 且 C_s²=1 时退化为 M/M/1 精确解(第二个自检锚点)。
 *
 * 容量反解: Wq(c) 关于 c 单调下降 → 二分求最小 c 使 Wq(c) ≤ W*(目标等待)。
 *   输出建议并发/预计等待/利用率 ρ/余量 —— 把「提前预留容量」从口号变成不等式。
 *
 * Little 定律自检: L = λ·W(实测在途数 vs 理论队长), 偏差过大说明模型失配(如非平稳到达)。
 *
 * 零漂移: 未挂载时自主循环不产生任何容量洞察。
 */

export interface QueueMetrics {
  /** 服务台数 */
  servers: number;
  /** 利用率 ρ = λ/(cμ) */
  rho: number;
  /** 系统稳定(ρ < 1) */
  stable: boolean;
  /** 等待概率(Erlang-C) */
  waitProbability: number;
  /** 平均排队等待(与输入时间单位一致) */
  avgWait: number;
  /** 平均队列长 Lq = λ·Wq */
  avgQueueLength: number;
  basis: 'erlang-c' | 'kingman' | 'unstable' | 'invalid';
}

export interface CapacityPlan {
  recommendedConcurrency: number;
  currentConcurrency: number;
  rho: number;
  expectedWaitMs: number;
  targetWaitMs: number;
  feasible: boolean;
  /** 余量 = 建议/当前, > 1.2 触发扩容洞察 */
  headroom: number;
  basis: string;
  metricsAtRecommended: QueueMetrics;
}

export interface CapacityPlannerConfig {
  /** 目标平均等待(毫秒) */
  targetWaitMs: number;
  /** 搜索并发上限 */
  maxConcurrency: number;
  /** 服务 SCV 未知时的缺省(指数服务 = 1; LLM 重尾建议 2~4) */
  defaultScv: number;
}

export const DEFAULT_CAPACITY_CONFIG: CapacityPlannerConfig = {
  targetWaitMs: 5000,
  maxConcurrency: 64,
  defaultScv: 2.0,
};

/** M/M/c Erlang-C 精确指标。λ 每单位时间到达数, μ 单台每单位时间服务率, c 台 */
export function erlangC(lambda: number, mu: number, servers: number): QueueMetrics {
  if (!(lambda > 0) || !(mu > 0) || servers < 1) {
    return { servers, rho: 0, stable: false, waitProbability: 0, avgWait: 0, avgQueueLength: 0, basis: 'invalid' };
  }
  const a = lambda / mu;
  const c = Math.floor(servers);
  const rho = a / c;
  if (rho >= 1) {
    return { servers: c, rho: round(rho), stable: false, waitProbability: 1, avgWait: Infinity, avgQueueLength: Infinity, basis: 'unstable' };
  }
  // Erlang-B 递推
  let b = 1;
  for (let k = 1; k <= c; k++) {
    b = (a * b) / (k + a * b);
  }
  const waitProb = b / (1 - rho * (1 - b));
  const avgWait = waitProb / (c * mu - lambda);
  return {
    servers: c,
    rho: round(rho),
    stable: true,
    waitProbability: round(waitProb),
    avgWait,
    avgQueueLength: round(lambda * avgWait),
    basis: 'erlang-c',
  };
}

/** M/G/c Kingman 重尾近似; scv = 服务时间平方变异系数 C_s² */
export function kingmanWq(lambda: number, mu: number, servers: number, scv: number): number {
  const c = Math.max(1, Math.floor(servers));
  const a = lambda / mu;
  const rho = a / c;
  if (rho >= 1) return Infinity;
  const ca2 = 1; // 泊松到达
  return ((ca2 + Math.max(0, scv)) / 2) * (rho / (1 - rho)) * (1 / mu) / c;
}

/** Little 定律自检: 返回实测与理论在途数之比(< 0.5 或 > 2 提示模型失配) */
export function littleCheck(lambda: number, avgSojournMs: number, observedInFlight: number): {
  theoretical: number; observed: number; ratio: number;
} {
  const theoretical = lambda * avgSojournMs;
  return {
    theoretical: round(theoretical),
    observed: observedInFlight,
    ratio: theoretical > 1e-9 ? round(observedInFlight / theoretical) : 0,
  };
}

/** 容量规划器: 由预测到达率与服务统计反解最小并发 */
export class CapacityPlanner {
  private readonly config: Required<CapacityPlannerConfig>;

  constructor(config?: Partial<CapacityPlannerConfig>) {
    this.config = { ...DEFAULT_CAPACITY_CONFIG, ...config } as Required<CapacityPlannerConfig>;
  }

  getConfig(): Readonly<Required<CapacityPlannerConfig>> {
    return this.config;
  }

  /**
   * @param input.predictedArrivalPerSec 预测到达率(次/秒, 世界模型 predictArrivals ÷ horizon 秒)
   * @param input.serviceMeanMs 稳健平均服务时长(毫秒, 建议 23.0 robustMean)
   * @param input.serviceScv 服务 SCV(σ̂²/μ̂², 缺省 defaultScv)
   * @param input.currentConcurrency 当前该池并发上限
   */
  plan(input: {
    predictedArrivalPerSec: number;
    serviceMeanMs: number;
    serviceScv?: number;
    currentConcurrency: number;
  }): CapacityPlan {
    const lambda = Math.max(0, input.predictedArrivalPerSec);
    const meanMs = Math.max(1e-3, input.serviceMeanMs);
    const scv = Math.max(0.01, input.serviceScv ?? this.config.defaultScv);
    const current = Math.max(1, Math.floor(input.currentConcurrency));
    // 统一单位: 服务率 μ = 1000/meanMs(每秒), Wq 换算回毫秒
    const mu = 1000 / meanMs;

    const waitMs = (c: number): number => {
      const wqSec = scv === 1 ? erlangC(lambda, mu, c).avgWait : kingmanWq(lambda, mu, c, scv);
      return wqSec * 1000;
    };

    // ρ ≥ 1 的台数上限: c > λ/μ 才可能稳定
    const minStable = Math.floor(lambda / mu) + 1;
    let lo = Math.max(1, minStable);
    let hi = Math.max(this.config.maxConcurrency, current, minStable);
    if (waitMs(hi) > this.config.targetWaitMs) {
      // 上限也无法达标: 诚实返回不可行
      return this.build(lambda, mu, scv, hi, current, false, waitMs(hi));
    }
    // 二分最小可行 c
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (waitMs(mid) <= this.config.targetWaitMs) hi = mid; else lo = mid + 1;
    }
    return this.build(lambda, mu, scv, lo, current, true, waitMs(lo));
  }

  private build(lambda: number, mu: number, scv: number, recommended: number, current: number,
    feasible: boolean, waitMs: number): CapacityPlan {
    const metrics = scv === 1
      ? erlangC(lambda, mu, recommended)
      : {
        servers: recommended,
        rho: round(lambda / (recommended * mu)),
        stable: lambda / (recommended * mu) < 1,
        waitProbability: NaN,
        avgWait: waitMs / 1000,
        avgQueueLength: round((lambda * waitMs) / 1000),
        basis: 'kingman' as const,
      };
    return {
      recommendedConcurrency: recommended,
      currentConcurrency: current,
      rho: metrics.rho,
      expectedWaitMs: round(waitMs),
      targetWaitMs: this.config.targetWaitMs,
      feasible,
      headroom: round(recommended / Math.max(1, current)),
      basis: feasible
        ? (scv === 1 ? 'erlang-c 精解二分反解' : `Kingman(SCV=${scv.toFixed(2)}) 二分反解`)
        : '并发上限内无法满足目标等待(需扩容或降载)',
      metricsAtRecommended: metrics,
    };
  }
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
