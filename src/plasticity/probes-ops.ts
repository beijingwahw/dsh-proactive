/**
 * probes-ops.ts — 创世纪 G3 · 探针即公开市场操作（Open-Market Operations）
 *
 * 定位：桶内对照是 τ2 结构固化的数据前提，而纯利用的路由经济学会让
 * 专业臂断流（soak 与生产实测双重确认：46 连胜的在位者独占，新臂
 * 零首发流量）。央行的职责之一是逆周期流动性注入——本模块检测
 * 「对照市场流动性枯竭」并签发探针指令：
 *
 *   starved（饿死）：近窗口内某臂的观测数远低于同侪 → 定向注入；
 *   stale（陈旧）：某臂历史活跃但近 maxAgeMs 无观测 → 证据新鲜度
 *   注入（对抗 30 天半衰期导致的画像僵化）。
 *
 * 探针是**真实的模型调用**（约 10-50 token），绝非伪造结算——每条
 * 探针指令都必须由宿主真实执行后经 bridge.settleTask 入账。预算
 * 限定（滚动每小时 maxPerHour 条）保证央行不绑架实体经济。
 *
 * 零漂移：未配置 = 不签发任何指令，宿主零介入。
 */

import type { TaskOutcomeSignal } from './loop.js';

/** 探针指令（市场操作订单） */
export interface ProbeOrder {
  modelId: string;
  /** 注入目标桶（近窗口最常见的 taskContext；undefined = 全局） */
  taskContext?: string;
  kind: 'starved' | 'stale';
  reason: string;
}

export interface ProbeOpsConfig {
  /** 滚动每小时最多注入条数（缺省 6——央行预算，防绑架实体经济） */
  maxPerHour?: number;
  /** 流动性检测窗口（近 N 条事件；缺省 200） */
  windowEvents?: number;
  /** 窗口内观测数低于此值的活跃桶臂视为饿死（缺省 5） */
  minPerWindow?: number;
  /** 活跃臂超过此时长无观测视为陈旧（缺省 2 小时） */
  maxAgeMs?: number;
  /** 同侪参照：窗口内最大观测数达此值的臂才算「市场活跃」（缺省 20） */
  activeThreshold?: number;
}

const DEFAULTS = {
  maxPerHour: 6,
  windowEvents: 200,
  minPerWindow: 5,
  maxAgeMs: 2 * 3_600_000,
  activeThreshold: 20,
};

/**
 * 市场操作器：检测（纯函数）+ 预算（滚动小时窗计数）。
 * 检测与执行分离——宿主负责真实执行，本模块负责「何时何地需要
 * 流动性」与「预算纪律」。
 */
export class ProbeOperations {
  private readonly cfg: typeof DEFAULTS;
  private executedAt: number[] = [];

  constructor(config: ProbeOpsConfig = {}) {
    this.cfg = {
      maxPerHour: Math.max(1, config.maxPerHour ?? DEFAULTS.maxPerHour),
      windowEvents: Math.max(20, config.windowEvents ?? DEFAULTS.windowEvents),
      minPerWindow: Math.max(1, config.minPerWindow ?? DEFAULTS.minPerWindow),
      maxAgeMs: Math.max(60_000, config.maxAgeMs ?? DEFAULTS.maxAgeMs),
      activeThreshold: Math.max(1, config.activeThreshold ?? DEFAULTS.activeThreshold),
    };
  }

  /**
   * 流动性检测（纯函数）：扫描近窗口事件，签发探针指令。
   * 市场不活跃（无臂达 activeThreshold）时不签发——无人交易的市场
   * 不需要做市（避免在死系统里烧探针预算）。
   */
  due(events: ReadonlyArray<TaskOutcomeSignal>, now: number): ProbeOrder[] {
    const window = events.slice(-this.cfg.windowEvents);
    if (window.length === 0) return [];
    const counts = new Map<string, number>();
    const lastSeen = new Map<string, number>();
    /** 臂的最近一次观测结局（G1 分型口径）——无偿付能力判定依据 */
    const lastOutcome = new Map<string, { ok: boolean; mode?: string }>();
    const ctxSeen = new Map<string, number>();
    for (const e of window) {
      for (const c of e.contributors) {
        counts.set(c.agentId, (counts.get(c.agentId) ?? 0) + 1);
        if (e.at >= (lastSeen.get(c.agentId) ?? 0)) {
          lastSeen.set(c.agentId, e.at);
          lastOutcome.set(c.agentId, { ok: c.success ?? e.success, mode: c.failureMode });
        }
      }
      if (e.taskContext !== undefined) ctxSeen.set(e.taskContext, (ctxSeen.get(e.taskContext) ?? 0) + 1);
    }
    if (counts.size === 0) return [];
    const busiest = Math.max(...counts.values());
    if (busiest < this.cfg.activeThreshold) return []; // 市场不活跃：不做市

    // 央行铁律：不给无偿付能力的银行注入流动性——最近一次观测为
    // 基础设施失败（auth/network/timeout/integrity）的臂当前无法交易，
    // 探针只会烧预算换 401（实测确认）。等它恢复（下次成功观测
    // 刷新 lastOutcome）再谈流动性。
    const INFRA = new Set(['auth', 'network', 'timeout', 'integrity']);
    const solvent = (armId: string): boolean => {
      const last = lastOutcome.get(armId);
      if (!last) return true;
      return !( !last.ok && last.mode !== undefined && INFRA.has(last.mode) );
    };

    // 注入目标桶 = 窗口内最常见的上下文（流动性流向真实存在的市场）
    let topCtx: string | undefined;
    let topCtxN = 0;
    for (const [ctx, n] of ctxSeen) {
      if (n > topCtxN) {
        topCtx = ctx;
        topCtxN = n;
    }
    }
    const strip = (armId: string): string => (armId.startsWith('model:') ? armId.slice('model:'.length) : armId);

    const orders: ProbeOrder[] = [];
    for (const [armId, n] of counts) {
      if (!solvent(armId)) continue;
      if (n < this.cfg.minPerWindow) {
        orders.push({ modelId: strip(armId), taskContext: topCtx, kind: 'starved', reason: `近窗口观测 ${n} < ${this.cfg.minPerWindow}（同侪最忙 ${busiest}）` });
      }
    }
    for (const [armId, at] of lastSeen) {
      if (!solvent(armId)) continue;
      const age = now - at;
      if (age > this.cfg.maxAgeMs) {
        orders.push({ modelId: strip(armId), taskContext: topCtx, kind: 'stale', reason: `证据年龄 ${(age / 3_600_000).toFixed(1)}h > ${(this.cfg.maxAgeMs / 3_600_000).toFixed(0)}h` });
      }
    }
    return orders;
  }

  /** 预算纪律：滚动一小时内的已执行数 < maxPerHour（未超支方可注入） */
  admit(now: number): boolean {
    this.executedAt = this.executedAt.filter((t) => now - t < 3_600_000);
    return this.executedAt.length < this.cfg.maxPerHour;
  }

  /** 记账：一条探针已消耗预算 */
  record(now: number): void {
    this.executedAt.push(now);
  }

  /** 预算用量（可观测口径） */
  used(now: number): number {
    this.executedAt = this.executedAt.filter((t) => now - t < 3_600_000);
    return this.executedAt.length;
  }
}
