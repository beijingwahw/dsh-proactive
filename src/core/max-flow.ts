/**
 * 43.0 最大流内核 —— Edmonds-Karp + 最小割证书：吞吐上限与其钳制者
 *
 * 动机: 「现在最多能同时派发多少」不是各模型并发上限的简单求和——
 * 任务有类型偏好、模型有能力画像，可行并发是**流网络**的值:
 *
 *   源 → 任务类型节点（容量 = 该类型待执行需求） → 模型节点
 *        （类型-模型边存在当且仅当评分 > 0） → 汇（容量 = maxConcurrency）
 *
 *   Ford–Fulkerson 定理 (1956): 最大流 = 最小割。Edmonds-Karp 用
 *   BFS 增广（O(VE²)），终止时残量网络中源可达集 S 与不可达集 T̄ 构成
 *   **最小割**——割容量恰等于流值（弱对偶 + 构造性等式 = 证书：
 *   最优性可逐位检查，与 32.0 对偶证书同一品味）。
 *
 *   调度语义: max-flow = 当前可立即满足的最大并发派发；min-cut 指认
 *   **钳制者**——割边落在类型侧（需求过剩：该类任务在饿）还是模型侧
 *   （容量不足：该模型是独木桥）。吞吐上限与瓶颈归因第一次同时可算。
 *
 *   验证锚点: 经典 CLRS 网络、随机图与穷举所有割对照（小图精确）、
 *   割容量 = 流值恒等式。
 *
 * 零漂移: 未挂载时调度与执行行为与升级前逐位一致（诊断口径挂载）。
 */

/** 流网络（邻接表 + 残量矩阵；节点 0..n-1，source=0，sink=n-1） */
export interface FlowNetwork {
  nodes: number;
  source: number;
  sink: number;
  /** capacity[u][v] ≥ 0（0 = 无边） */
  capacity: ReadonlyArray<ReadonlyArray<number>>;
  /** 节点标签（诊断输出用） */
  labels?: ReadonlyArray<string>;
}

export interface MaxFlowResult {
  /** 最大流值（= 最小割容量——Ford-Fulkerson 定理） */
  flowValue: number;
  /** 残量网络（capacity − flow + 反向） */
  residual: number[][];
  /** 最小割（源可达集 S；割 = S → V∖S 的满容量边） */
  minCut: { sourceSide: number[]; sinkSide: number[]; edges: Array<{ from: string; to: string; capacity: number }> };
  augmentingPaths: number;
}

/** Edmonds-Karp 最大流（BFS 增广；返回残量网络与最小割） */
export function maxFlow(network: FlowNetwork): MaxFlowResult {
  const n = network.nodes;
  const residual = network.capacity.map((row) => [...row]);
  const label = (i: number): string => network.labels?.[i] ?? String(i);
  let flowValue = 0;
  let paths = 0;
  const parent = new Array<number>(n).fill(-1);
  const bfs = (): boolean => {
    parent.fill(-1);
    parent[network.source] = network.source;
    const queue: number[] = [network.source];
    while (queue.length > 0) {
      const u = queue.shift()!;
      for (let v = 0; v < n; v += 1) {
        if (parent[v] !== -1 || residual[u][v] <= 0) continue;
        parent[v] = u;
        if (v === network.sink) return true;
        queue.push(v);
      }
    }
    return false;
  };
  while (bfs()) {
    paths += 1;
    // 沿增广路径找瓶颈容量
    let bottleneck = Infinity;
    for (let v = network.sink; v !== network.source; v = parent[v]) {
      bottleneck = Math.min(bottleneck, residual[parent[v]][v]);
    }
    for (let v = network.sink; v !== network.source; v = parent[v]) {
      residual[parent[v]][v] -= bottleneck;
      residual[v][parent[v]] += bottleneck;
    }
    flowValue += bottleneck;
  }
  // 最小割 = 残量网络中源可达集
  const reachable = new Set<number>([network.source]);
  const stack = [network.source];
  while (stack.length > 0) {
    const u = stack.pop()!;
    for (let v = 0; v < n; v += 1) {
      if (!reachable.has(v) && residual[u][v] > 0) {
        reachable.add(v);
        stack.push(v);
      }
    }
  }
  const sourceSide: number[] = [];
  const sinkSide: number[] = [];
  const edges: MaxFlowResult['minCut']['edges'] = [];
  for (let u = 0; u < n; u += 1) {
    if (reachable.has(u)) sourceSide.push(u);
    else sinkSide.push(u);
  }
  for (const u of sourceSide) {
    for (const v of sinkSide) {
      if (network.capacity[u][v] > 0) {
        edges.push({ from: label(u), to: label(v), capacity: network.capacity[u][v] });
      }
    }
  }
  return { flowValue, residual, minCut: { sourceSide, sinkSide, edges }, augmentingPaths: paths };
}

/** 割证书审计（验证锚点）：割边全饱和（残量 0）且割容量 = 流值 */
export function minCutCertificate(network: FlowNetwork, result: MaxFlowResult): { saturated: boolean; cutCapacity: number; equalsFlow: boolean } {
  let cutCapacity = 0;
  let saturated = true;
  for (const u of result.minCut.sourceSide) {
    for (const v of result.minCut.sinkSide) {
      if (network.capacity[u][v] > 0) {
        cutCapacity += network.capacity[u][v];
        if (result.residual[u][v] > 1e-9) saturated = false;
      }
    }
  }
  return { saturated, cutCapacity, equalsFlow: Math.abs(cutCapacity - result.flowValue) <= 1e-9 };
}

/** 穷举最小割（验证锚点；2^n 枚举，n ≤ 16 适用） */
export function bruteForceMinCut(network: FlowNetwork): number {
  const n = network.nodes;
  let best = Infinity;
  for (let mask = 0; mask < 1 << n; mask += 1) {
    if (!(mask & (1 << network.source)) || mask & (1 << network.sink)) continue;
    let cut = 0;
    for (let u = 0; u < n; u += 1) {
      if (!(mask & (1 << u))) continue;
      for (let v = 0; v < n; v += 1) {
        if (mask & (1 << v)) continue;
        cut += network.capacity[u][v];
      }
    }
    best = Math.min(best, cut);
  }
  return best;
}

// ─────────────────── 43.0 调度接线口径（容量前沿） ───────────────────

export interface CapacityFrontier {
  /** 可立即满足的最大并发派发（max-flow 值） */
  maxDispatch: number;
  /** 割边归因（哪些类型在饿 / 哪些模型是独木桥） */
  bindingConstraints: Array<{ from: string; to: string; capacity: number }>;
  /** 归因侧统计 */
  demandStarved: number;
  modelLimited: number;
}

/**
 * 类型需求 × 模型容量的流前沿（43.0 接线口径）。
 *
 * demands: taskType → 待执行数量；modelCapacities: modelId → maxConcurrency；
 * eligibility: (taskType, modelId) => boolean（评分 > 0 视为可达）。
 * 网络: 源 → 类型（容量 = 需求）→ 模型（可达边容量 ∞）→ 汇（容量 = 并发）。
 */
export function capacityFrontier(
  demands: ReadonlyArray<{ type: string; count: number }>,
  modelCapacities: ReadonlyArray<{ id: string; capacity: number }>,
  eligibility: (taskType: string, modelId: string) => boolean,
): CapacityFrontier {
  const typeCount = demands.length;
  const modelCount = modelCapacities.length;
  const n = 2 + typeCount + modelCount;
  const capacity: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const labels: string[] = ['source', ...demands.map((d) => `type:${d.type}`), ...modelCapacities.map((m) => `model:${m.id}`), 'sink'];
  demands.forEach((d, i) => {
    capacity[0][1 + i] = Math.max(0, d.count);
  });
  demands.forEach((d, i) => {
    modelCapacities.forEach((m, j) => {
      if (eligibility(d.type, m.id)) capacity[1 + i][1 + typeCount + j] = Number.MAX_SAFE_INTEGER / 4;
    });
  });
  modelCapacities.forEach((m, j) => {
    capacity[1 + typeCount + j][n - 1] = Math.max(0, m.capacity);
  });
  const result = maxFlow({ nodes: n, source: 0, sink: n - 1, capacity, labels });
  const bindingConstraints = result.minCut.edges
    .filter((e) => e.capacity < Number.MAX_SAFE_INTEGER / 8 || e.from.startsWith('type:'))
    .slice(0, 8);
  return {
    maxDispatch: result.flowValue,
    bindingConstraints,
    demandStarved: result.minCut.edges.filter((e) => e.from === 'source').length,
    modelLimited: result.minCut.edges.filter((e) => e.to === 'sink').length,
  };
}
