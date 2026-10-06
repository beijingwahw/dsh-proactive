/**
 * 41.0 排队网络内核 —— Jackson 乘积形式 + 串联逗留 + 瓶颈站：吞吐链路成为网络
 *
 * 动机: 25.0 容量规划把「一个模型」当一台 M/M/c 排队机反解并发；但一次
 * 调度要穿过**一条链**：入队 → 模型调用 → 反思回流——端到端延迟与吞吐
 * 上限由整条串联网络决定，瓶颈站在哪一站是排队网络的问题。
 *
 *   Jackson 定理 (1957): 串联（更一般地，乘积形式网络）各站的稳态
 *   边际分布相互独立、每站各自是 M/M/c：
 *     π(n₁,…,n_K) = Π_k π_k(n_k)，π_k 为该站独立的 M/M(c_k) 稳态
 *   → 端到端逗留时间 = Σ_k (Wq_k + 1/μ_k)；**瓶颈站 = ρ 最大者**，
 *     ρ_k = λ/(c_k μ_k) → 1 时全网排队爆炸（其他站再快也无济于事）。
 *
 *   单站口径复用 25.0 的 erlangC（等待概率 / 平均等待闭式）——内核间
 *   协同：25.0 反解「要多少并发」，41.0 回答「链路瓶颈在哪、端到端
 *   要多久」。验证锚点: 两站串联 M/M/1 的边际独立性（模拟对照乘积
 *   形式）、端到端逗留 = 各站之和。
 *
 * R5-A10 世界性进化（随机过程第六轮·轴 1 数学）:
 *   A. M/G/1 Pollaczek–Khinchine 变换公式——任意服务分布的**精确**
 *      Wq = λE[S²]/(2(1−ρ))（Kingman 在 c=1 时的精确化；C_s²=1 退化
 *      M/M/1、C_s²=0 恰为其半——双解析锚点）；
 *   B. 非抢占多类优先级 M/G/1（Cobham 1954）+ Kleinrock 守恒律
 *      Σρ_k Wq_k = ρW0/(1−ρ)（裂项恒等，对任意工守恒序不变）+
 *      cμ 规则（Smith 成对交换）最优性——「谁先服务」从 FIFO 猜想
 *      升维为带成本率的最优排序定理。
 *   验证锚点: 守恒量在全部 K! 排列下逐位不变、cμ 序成本 ≤ 一切排列
 *   （≥200 种子化穷举）、P-K 双退化锚点、逐类 Little 定律 Lq=λWq。
 *
 * 零漂移: 未挂载时心跳与调度行为与升级前逐位一致。
 */

import { erlangC } from './capacity-planning.js';

/** 网络中的一站（M/M/c 口径） */
export interface QueueStation {
  /** 站名（诊断输出用） */
  name: string;
  /** 到达率 λ（每毫秒；串联网络各站同 λ） */
  lambdaPerMs: number;
  /** 单服务员服务率 μ（每毫秒；1/平均服务时长） */
  muPerMs: number;
  /** 并行服务员数（并发容量） */
  servers: number;
}

export interface StationMetrics {
  name: string;
  rho: number;
  stable: boolean;
  /** 平均等待 Wq（毫秒） */
  avgWaitMs: number;
  /** 平均逗留 Wq + 1/μ（毫秒） */
  avgSojournMs: number;
  /** 等待概率（Erlang-C） */
  waitProbability: number;
}

export interface NetworkReport {
  stations: StationMetrics[];
  /** 端到端平均逗留（Σ 各站，Jackson 乘积形式下各站独立） */
  endToEndSojournMs: number;
  /** 瓶颈站（ρ 最大；不稳定站优先） */
  bottleneck: StationMetrics | undefined;
  /** 全网是否稳定（所有站 ρ < 1） */
  stable: boolean;
}

/** 串联排队网络分析（Jackson 乘积形式；各站独立 M/M/c 边际） */
export function tandemNetwork(stations: ReadonlyArray<QueueStation>): NetworkReport {
  const metrics: StationMetrics[] = stations.map((s) => {
    const q = erlangC(s.lambdaPerMs, s.muPerMs, s.servers);
    return {
      name: s.name,
      rho: q.rho,
      stable: q.stable,
      avgWaitMs: q.avgWait,
      avgSojournMs: q.avgWait + 1 / Math.max(1e-12, s.muPerMs),
      waitProbability: q.waitProbability,
    };
  });
  const stable = metrics.every((m) => m.stable);
  let bottleneck: StationMetrics | undefined;
  for (const m of metrics) {
    if (!bottleneck || (!m.stable && bottleneck.stable) || (m.stable === bottleneck.stable && m.rho > bottleneck.rho)) {
      bottleneck = m;
    }
  }
  return {
    stations: metrics,
    endToEndSojournMs: stable ? metrics.reduce((s, m) => s + m.avgSojournMs, 0) : Number.POSITIVE_INFINITY,
    bottleneck,
    stable,
  };
}

/** 网络可稳定的最小服务员配置（逐站反解 ⌈λ/μ⌉ + 1，与 25.0 反解同口径） */
export function minimalStableServers(stations: Omit<QueueStation, 'servers'>[]): number[] {
  return stations.map((s) => Math.ceil(s.lambdaPerMs / Math.max(1e-12, s.muPerMs) - 1e-9) || 1);
}

/**
 * Jackson 乘积形式审计（验证锚点）：给定各站队长样本，检验两站边际
 * 的经验相关性 ≈ 0（独立性的有限样本读数）。
 */
export function jacksonIndependenceAudit(
  queueSamples: ReadonlyArray<[number, number]>,
): { correlation: number; samples: number } {
  const n = queueSamples.length;
  if (n < 8) return { correlation: Number.NaN, samples: n };
  const xs = queueSamples.map((p) => p[0]);
  const ys = queueSamples.map((p) => p[1]);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) * (xs[i] - mx);
    dy += (ys[i] - my) * (ys[i] - my);
  }
  return { correlation: dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0, samples: n };
}

// ─────────────────── R5-A10 数学进化 A：M/G/1 Pollaczek–Khinchine 精解 ───────────────────

export interface Mg1Metrics {
  /** 利用率 ρ = λ·E[S] = λ/μ */
  rho: number;
  stable: boolean;
  /** 平均排队等待 Wq = λE[S²]/(2(1−ρ))（对**任意**服务分布精确） */
  avgWait: number;
  /** 平均队长 Lq = λ·Wq */
  avgQueueLength: number;
  /** 平均逗留 W = Wq + E[S] */
  avgSojourn: number;
  basis: 'pollaczek-khinchine' | 'unstable' | 'invalid';
}

/**
 * M/G/1 Pollaczek–Khinchine 变换公式（1930）——一般服务分布的精确平均等待：
 *
 *   Wq = λ·E[S²] / (2(1−ρ))，  E[S²] = (1+C_s²)/μ²
 *
 * 与 25.0 的关系：Kingman 是 M/G/c 的重负载近似，M/G/1 下本式**精确**。
 * 两个解析退化锚点：
 *   C_s²=1（指数服务）→ Wq = λ/(μ²(1−ρ)) = ρ/(μ−λ)，即 M/M/1 精确解；
 *   C_s²=0（确定性服务）→ Wq 恰为 M/M/1 的一半（无服务抖动可等）。
 */
export function pollaczekKhinchine(lambda: number, mu: number, scv = 1): Mg1Metrics {
  if (!(lambda > 0) || !(mu > 0) || !(scv >= 0)) {
    return { rho: 0, stable: false, avgWait: 0, avgQueueLength: 0, avgSojourn: 0, basis: 'invalid' };
  }
  const rho = lambda / mu;
  if (rho >= 1) {
    return { rho, stable: false, avgWait: Infinity, avgQueueLength: Infinity, avgSojourn: Infinity, basis: 'unstable' };
  }
  const secondMoment = (1 + scv) / (mu * mu);
  const avgWait = (lambda * secondMoment) / (2 * (1 - rho));
  return {
    rho,
    stable: true,
    avgWait,
    avgQueueLength: lambda * avgWait,
    avgSojourn: avgWait + 1 / mu,
    basis: 'pollaczek-khinchine',
  };
}

// ─────────────────── R5-A10 数学进化 B：非抢占多类优先级队列（cμ 规则） ───────────────────

/** 一个优先级类：泊松到达 λ、服务率 μ、服务 SCV、单位时间持有成本率 c（缺省 1） */
export interface PriorityClass {
  name: string;
  /** 到达率（每单位时间） */
  lambda: number;
  /** 平均服务率（1/E[S]） */
  mu: number;
  /** 服务时间平方变异系数（指数服务 = 1） */
  scv?: number;
  /** 每任务每单位时间的持有成本率（cμ 规则的权重） */
  costRate?: number;
}

export interface PriorityClassMetrics {
  name: string;
  rho: number;
  /** 该类平均等待 Wq_k = W0/((1−σ_{k−1})(1−σ_k))（Cobham 1954，非抢占精确） */
  avgWait: number;
  avgSojourn: number;
  avgQueueLength: number;
}

export interface PriorityQueueReport {
  /** 按**传入顺序**（索引 0 = 最高优先级）给出的各类指标 */
  classes: PriorityClassMetrics[];
  stable: boolean;
  /** 均值剩余工作 W0 = Σλ_k E[S_k²]/2（顺序无关量） */
  residualWork: number;
  /** Kleinrock 守恒量 Σρ_k·Wq_k（实测求和） */
  conservationSum: number;
  /** 守恒量解析值 ρ·W0/(1−ρ)——对一切工守恒非抢占序**恒等** */
  conservationTheoretical: number;
  /** cμ 规则最优顺序（c_k·μ_k 降序）——最小化 Σc_k λ_k Wq_k 的类名序列 */
  cmuOrder: string[];
  /** 当前顺序下的加权等待成本 Σ c_k λ_k Wq_k */
  weightedWaitCost: number;
  /** cμ 顺序下的加权等待成本（定理保证 ≤ 任何其他顺序） */
  cmuWeightedWaitCost: number;
}

/**
 * 非抢占多类 M/G/1 优先级队列（Kleinrock 卷一 §3.5 口径）：
 *
 *   W0 = Σ_k λ_k E[S_k²]/2（平均剩余服务工作量）
 *   Wq_k = W0 / ((1−σ_{k−1})(1−σ_k))，σ_k = Σ_{j≤k} ρ_j
 *
 *   Kleinrock 守恒律: Σ_k ρ_k Wq_k = ρW0/(1−ρ) 对一切工守恒非抢占纪律
 *   **不变**（优先级只重新分配等待，不消灭等待）——σ_k−σ_{k−1}=ρ_k 的
 *   裂项求和逐位成立：
 *     Σ ρ_k/((1−σ_{k−1})(1−σ_k)) = Σ [1/(1−σ_k) − 1/(1−σ_{k−1})] = ρ/(1−ρ)
 *
 *   cμ 规则（Smith 型成对交换论证）: 按 c_k·μ_k 降序服务最小化
 *   Σ c_k λ_k Wq_k——相邻对 (k,k+1) 交换的成本差 ∝ (c_{k+1}μ_{k+1} − c_kμ_k)
 *   × 正因子，故最优序即 cμ 降序（确定性调度的 WSPT 定理在排队稳态的镜像）。
 */
export function priorityQueueWaits(classes: ReadonlyArray<PriorityClass>): PriorityQueueReport {
  const K = classes.length;
  if (K === 0 || classes.some((c) => !(c.lambda > 0) || !(c.mu > 0) || !((c.scv ?? 1) >= 0))) {
    return {
      classes: [], stable: false, residualWork: 0, conservationSum: 0, conservationTheoretical: 0,
      cmuOrder: [], weightedWaitCost: NaN, cmuWeightedWaitCost: NaN,
    };
  }
  const rhos = classes.map((c) => c.lambda / c.mu);
  const rho = rhos.reduce((s, r) => s + r, 0);
  const stable = rho < 1;
  const w0 = classes.reduce((s, c) => s + (c.lambda * (1 + (c.scv ?? 1))) / (c.mu * c.mu) / 2, 0);
  if (!stable) {
    const metrics: PriorityClassMetrics[] = classes.map((c, i) => ({
      name: c.name, rho: rhos[i], avgWait: Infinity, avgSojourn: Infinity, avgQueueLength: Infinity,
    }));
    return {
      classes: metrics, stable: false, residualWork: w0, conservationSum: Infinity,
      conservationTheoretical: Infinity, cmuOrder: cmuPriorityOrder(classes),
      weightedWaitCost: Infinity, cmuWeightedWaitCost: Infinity,
    };
  }
  const metrics: PriorityClassMetrics[] = [];
  let sigmaPrev = 0; // σ_{k−1}
  let conservationSum = 0;
  let weightedCost = 0;
  for (let k = 0; k < K; k += 1) {
    const sigma = sigmaPrev + rhos[k];
    const wq = w0 / ((1 - sigmaPrev) * (1 - sigma));
    metrics.push({
      name: classes[k].name,
      rho: rhos[k],
      avgWait: wq,
      avgSojourn: wq + 1 / classes[k].mu,
      avgQueueLength: classes[k].lambda * wq,
    });
    conservationSum += rhos[k] * wq;
    weightedCost += (classes[k].costRate ?? 1) * classes[k].lambda * wq;
    sigmaPrev = sigma;
  }
  const cmuOrder = cmuPriorityOrder(classes);
  // cμ 序下的成本（同公式按重排顺序重算）
  const reordered = cmuOrder.map((n) => classes.find((c) => c.name === n)) as PriorityClass[];
  let sigma2 = 0;
  let cmuCost = 0;
  for (const c of reordered) {
    const sigma = sigma2 + c.lambda / c.mu;
    const wq = w0 / ((1 - sigma2) * (1 - sigma));
    cmuCost += (c.costRate ?? 1) * c.lambda * wq;
    sigma2 = sigma;
  }
  return {
    classes: metrics,
    stable: true,
    residualWork: w0,
    conservationSum,
    conservationTheoretical: (rho * w0) / (1 - rho),
    cmuOrder,
    weightedWaitCost: weightedCost,
    cmuWeightedWaitCost: cmuCost,
  };
}

/** cμ 规则排序：按 c_k·μ_k 降序（最小化线性持有成本的成对交换最优序） */
export function cmuPriorityOrder(classes: ReadonlyArray<PriorityClass>): string[] {
  return [...classes]
    .map((c, i) => ({ name: c.name, key: (c.costRate ?? 1) * c.mu, i }))
    .sort((a, b) => (b.key - a.key) || (a.i - b.i))
    .map((e) => e.name);
}

// ─────────────────── 41.0 心跳接线口径（瓶颈站洞察的语义桥） ───────────────────

/** 瓶颈站洞察构造（autonomy-loop 2.9 段消费） */
export function bottleneckInsight(report: NetworkReport, rhoThreshold = 0.85): { message: string; suggestion: string; severity: number } | undefined {
  const b = report.bottleneck;
  if (!b || (b.stable && b.rho < rhoThreshold)) return undefined;
  if (!b.stable) {
    return {
      message: `排队网络不可稳定：瓶颈站 ${b.name} 利用率 ρ=${b.rho.toFixed(2)} ≥ 1——到达率超出服务能力，队列无界增长（其他站再快也无济于事）`,
      suggestion: '立即降载（收紧哨兵聚合 / 降低派发并发）或扩容瓶颈站并发上限；按 minimalStableServers 反解最小可行服务员数',
      severity: 0.9,
    };
  }
  return {
    message: `排队网络瓶颈站：${b.name} 利用率 ρ=${b.rho.toFixed(2)}（等待概率 ${(b.waitProbability * 100).toFixed(0)}%，端到端逗留 ${Math.round(report.endToEndSojournMs)}ms）——接近饱和，波动将被指数放大`,
    suggestion: '把下一批低价值信号的派发错峰到瓶颈站冷却后，或上调该站并发上限（其余站有富余）',
    severity: Math.min(0.85, 0.5 + (b.rho - rhoThreshold) * 2),
  };
}
