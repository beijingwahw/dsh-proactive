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
