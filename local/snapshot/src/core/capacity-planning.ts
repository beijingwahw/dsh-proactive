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
 * 容量反解: Wq(c) 关于 c 单调下降 → 求最小 c 使 Wq(c) ≤ W*(目标等待)。
 *   输出建议并发/预计等待/利用率 ρ/余量 —— 把「提前预留容量」从口号变成不等式。
 *
 * Little 定律自检: L = λ·W(实测在途数 vs 理论队长), 偏差过大说明模型失配(如非平稳到达)。
 *
 * R5-A10 世界性进化（随机过程第五轮）:
 *   轴 1 数学: ① 多类别容量分配 multiclassStaffing——基础并发按类保底
 *     ⌊a_k⌋+1，共享冗余按平方根 staffing 规则 r_k ∝ √a_k（Halfin–Whitt
 *     质量效率体制）分配，最大余数法整数化使 Σextra = 预算**精确守恒**；
 *     ② elastic 需求均衡 elasticArrivalEquilibrium——到达率负载敏感
 *     λ = λ0/(1+γWq)，g(λ)=λ(1+γWq) 单调增 → 不动点唯一，名义过载
 *     λ0 ≥ cμ 也有均衡（等待劝退自稳）。
 *   轴 2 性能: plan() 的盲二分升级为 Kingman 闭式反解初值 + 局部下探/
 *     上探（(c−a)c = ka/(μW*) → c₀=(a+√(a²+4q))/2），与二分解恒等、
 *     erlangC 求值次数 ~减半。
 *   轴 3 稳健: erlangB 独立导出（全程 [0,1] 有界的无溢出递推，公共稳定
 *     原语）；elastic 均衡二分在 [0, cμ(1−1e-12)] 闭区间内永不触碰
 *     不稳定分支。
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

/** M/M/c Erlang-B 递推: B(0)=1, B(k) = a·B(k−1)/(k + a·B(k−1))（全程有界 [0,1]，无溢出——R5-A10 起独立导出为公共稳定原语） */
export function erlangB(servers: number, offeredLoad: number): number {
  const c = Math.floor(servers);
  if (c < 1 || !(offeredLoad >= 0)) return NaN;
  let b = 1;
  for (let k = 1; k <= c; k += 1) {
    b = (offeredLoad * b) / (k + offeredLoad * b);
  }
  return b;
}

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
  // Erlang-B 递推（与 erlangB 同式，内联保持既有算术逐位一致）
  let b = 1;
  for (let k = 1; k <= c; k += 1) {
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
    // R5-A10 轴 2（性能）: Kingman 闭式反解给初值，局部下探/上探替代盲二分。
    //   W*(目标) = k·ρ/(1−ρ)·1/(cμ), k=(1+C_s²)/2 ⇔ (c−a)·c = k·a/(μW*)
    //   → c₀ = (a+√(a²+4q))/2, q = k·a/(μW*)
    // waitMs 关于 c 单调不增（Erlang-C 与 Kingman 皆然）→ 初值邻域内
    // 下探到首个不可行、上探到首个可行即为最小可行 c，与旧二分解**恒等**；
    // 初值离谱时自动退化为线性扫描（正确性不依赖初值质量）。
    const offeredLoad = lambda / mu;
    const targetSec = this.config.targetWaitMs / 1000;
    const q = ((1 + scv) / 2) * offeredLoad / (mu * targetSec);
    const guess = (offeredLoad + Math.sqrt(offeredLoad * offeredLoad + 4 * q)) / 2;
    let c = Math.max(lo, Math.min(hi, Math.ceil(guess)));
    while (c > lo && waitMs(c - 1) <= this.config.targetWaitMs) c -= 1;
    while (c < hi && waitMs(c) > this.config.targetWaitMs) c += 1;
    return this.build(lambda, mu, scv, c, current, true, waitMs(c));
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

// ─────────────────── R5-A10 数学进化 C：多类别平方根 staffing 容量分配 ───────────────────

/** 一个负载类别：到达率与平均服务时长（毫秒） */
export interface StaffingClass {
  name: string;
  /** 到达率（次/秒） */
  arrivalPerSec: number;
  /** 平均服务时长（毫秒） */
  serviceMeanMs: number;
}

export interface StaffingAllocation {
  name: string;
  /** 保底服务员数 ⌊a_k⌋+1（最小可稳定） */
  base: number;
  /** 分得的额外冗余（最大余数法，整数） */
  extra: number;
  servers: number;
  rho: number;
  waitProbability: number;
  avgWaitMs: number;
}

export interface MulticlassStaffingReport {
  classes: StaffingAllocation[];
  /** Σ(base_k + extra_k) */
  totalServers: number;
  /** 冗余预算守恒：Σ extra_k === extraBudget（最大余数法精确到 1） */
  extraBudget: number;
  /** 加权平均等待 Σλ_k Wq_k / Σλ_k（毫秒）——随冗余预算单调不增 */
  aggregateWaitMs: number;
  stable: boolean;
}

/**
 * 多类别容量分配（轴 1 数学进化）：基础并发按类保底 ⌊a_k⌋+1，共享冗余
 * 预算 R 按**平方根 staffing 规则**（Halfin–Whitt / Harrison–Zeevi 质量效率
 * 体制的标准口径）分配：
 *
 *   c_k = a_k + β·√a_k，全局共享 β → r_k ∝ √a_k
 *
 * 直觉：重负载类的波动尺度是 √a_k（泊松涨落），冗余应跟随波动尺度而非
 * 均分——均分把冗余花在本来就不抖的轻类上。整数化用最大余数法（Hamilton
 * 众议院口径）：先取 ⌊r_k⌋，再把剩余名额按小数部分降序逐个发放，
 * **Σextra_k = R 精确守恒**。
 */
export function multiclassStaffing(classes: ReadonlyArray<StaffingClass>, extraBudget: number): MulticlassStaffingReport {
  const valid =
    classes.length > 0 &&
    classes.every((c) => c.arrivalPerSec > 0 && c.serviceMeanMs > 0 && Number.isFinite(c.arrivalPerSec) && Number.isFinite(c.serviceMeanMs));
  const budget = Math.max(0, Math.floor(extraBudget));
  if (!valid) {
    return { classes: [], totalServers: 0, extraBudget: budget, aggregateWaitMs: NaN, stable: false };
  }
  const loads = classes.map((c) => (c.arrivalPerSec * c.serviceMeanMs) / 1000);
  // ⌊a⌋+1：整数负载 a 时 a 台恰好 ρ=1 不可稳定，须 a+1——对一切 a > ρ<1 的最小台数
  const bases = loads.map((a) => Math.floor(a) + 1);
  // √a 比例份额 → 最大余数法整数化（守恒到 1）
  const roots = loads.map((a) => Math.sqrt(a));
  const rootSum = roots.reduce((s, r) => s + r, 0);
  const raw = roots.map((r) => (rootSum > 0 ? (budget * r) / rootSum : 0));
  const floors = raw.map(Math.floor);
  let remaining = budget - floors.reduce((s, f) => s + f, 0);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((x, y) => y.frac - x.frac || x.i - y.i);
  const extras = [...floors];
  for (let j = 0; remaining > 0 && j < order.length; j += 1) {
    extras[order[j].i] += 1;
    remaining -= 1;
  }
  // 轮转兜底（budget > K·大数时 floor 之和可能已超? 不会——Σ⌊r⌋ ≤ Σr = budget）
  let k = 0;
  while (remaining > 0) {
    extras[k % extras.length] += 1;
    remaining -= 1;
    k += 1;
  }
  const allocations: StaffingAllocation[] = classes.map((c, i) => {
    const servers = bases[i] + extras[i];
    const mu = 1000 / c.serviceMeanMs;
    const m = erlangC(c.arrivalPerSec, mu, servers);
    return {
      name: c.name,
      base: bases[i],
      extra: extras[i],
      servers,
      rho: m.rho,
      waitProbability: m.stable ? m.waitProbability : 1,
      avgWaitMs: m.stable ? m.avgWait * 1000 : Infinity,
    };
  });
  const stable = allocations.every((x) => x.rho < 1);
  const lambdaSum = classes.reduce((s, c) => s + c.arrivalPerSec, 0);
  const aggregateWaitMs = lambdaSum > 0
    ? allocations.reduce((s, x, i) => s + classes[i].arrivalPerSec * x.avgWaitMs, 0) / lambdaSum
    : NaN;
  return {
    classes: allocations,
    totalServers: allocations.reduce((s, x) => s + x.servers, 0),
    extraBudget: budget,
    aggregateWaitMs,
    stable,
  };
}

// ─────────────────── R5-A10 数学进化 D：elastic 需求（负载敏感到达均衡） ───────────────────

export interface ElasticEquilibrium {
  /** 均衡有效到达率 λ*（次/秒） */
  lambdaEff: number;
  /** 名义（无摩擦）到达率 λ0 */
  offeredLambda: number;
  /** 准入份额 λ*÷λ0 ∈ (0,1]（等待劝退造成的流失读数） */
  admittedShare: number;
  /** 均衡平均等待 Wq(c, λ*)（毫秒） */
  waitMs: number;
  rho: number;
  servers: number;
  bisectionIterations: number;
}

/**
 * elastic 需求均衡（轴 1 数学进化）：到达率对负载敏感——
 *
 *   λ_eff = λ0 / (1 + γ·Wq(c, λ_eff))，γ ≥ 0（每毫秒等待的劝退敏感度）
 *
 * 不动点存在唯一：g(λ) = λ·(1 + γ·Wq(c,λ)) 在 [0, cμ) 上从 0 单调增到
 * +∞（λ↑ 与 Wq↑ 双单调）→ 与水平线 λ0 恰有一交。均衡即使 λ0 ≥ cμ（名义
 * 过载）也存在——等待劝退把系统**自稳**到 ρ* < 1（thundering herd 的数学
 * 出气阀）。γ=0 退化为普通 M/M/c（λ*=λ0）。
 */
export function elasticArrivalEquilibrium(
  arrivalPerSec: number,
  serviceMeanMs: number,
  servers: number,
  sensitivityPerMs: number,
): ElasticEquilibrium | undefined {
  if (
    !(arrivalPerSec > 0) || !(serviceMeanMs > 0) || !(servers >= 1) ||
    !(sensitivityPerMs >= 0) || !Number.isFinite(arrivalPerSec) || !Number.isFinite(sensitivityPerMs) ||
    !Number.isFinite(serviceMeanMs) || !Number.isFinite(servers)
  ) {
    return undefined;
  }
  const mu = 1000 / serviceMeanMs;
  const c = Math.floor(servers);
  const capacity = c * mu;
  const gamma = sensitivityPerMs;
  if (gamma === 0) {
    // 无摩擦：直接返回普通 M/M/c 读数（λ0 ≥ 容量时无均衡，诚实拒绝）
    if (arrivalPerSec >= capacity) return undefined;
    const m = erlangC(arrivalPerSec, mu, c);
    return {
      lambdaEff: arrivalPerSec, offeredLambda: arrivalPerSec, admittedShare: 1,
      waitMs: m.avgWait * 1000, rho: m.rho, servers: c, bisectionIterations: 0,
    };
  }
  // g(λ) = λ(1+γ·Wq_ms(λ)) 单调增；均衡方程 g(λ*) = λ0
  const g = (lambda: number): number => {
    const m = erlangC(lambda, mu, c);
    const wMs = m.stable ? m.avgWait * 1000 : Infinity;
    return lambda * (1 + gamma * wMs);
  };
  let lo = 0;
  let hi = capacity * (1 - 1e-12); // g(hi) → +∞（Wq → ∞），必有交点
  const iterations = 100;
  for (let it = 0; it < iterations; it += 1) {
    const mid = (lo + hi) / 2;
    if (g(mid) > arrivalPerSec) hi = mid; else lo = mid;
  }
  const lambdaEff = (lo + hi) / 2;
  const m = erlangC(lambdaEff, mu, c);
  return {
    lambdaEff,
    offeredLambda: arrivalPerSec,
    admittedShare: Math.min(1, lambdaEff / arrivalPerSec),
    waitMs: m.avgWait * 1000,
    rho: m.rho,
    servers: c,
    bisectionIterations: iterations,
  };
}
