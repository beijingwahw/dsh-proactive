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
 *
 * ── R5 进化（第五轮·世界性进化）──
 *   轴 2（性能）: maxFlow 内核换 Dinic 分层算法（BFS 分层 + 阻塞流），
 *   O(V²E) 对 EK 的 O(VE²)——同值同证书（流值由定理唯一; 最小割取自
 *   终态残量网络，割证书照常成立），大规模随机实例耗时对照。
 *   轴 1（数学）: 最小费用流（逐次最短路 SSP + 位势 Dijkstra）——
 *   「吞吐最大的派发方案里选总费用最小的」，残量网络无负环 = 最优性
 *   证书（互补松弛的图判读，证明携带）。轴 3（数值）: 流量守恒与容量
 *   可行性的浮点残差审计（flowAudit）。
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

/**
 * 最大流（R5: Dinic 分层算法——BFS 建 level 图 + 带弧指针的 DFS 阻塞流，
 * O(V²E)（邻接矩阵口径），对 EK 的 O(VE²)）。邻接表一次 O(V²) 构建后
 * BFS/DFS 均走表（含动态反向弧: cap[u][v] 与 cap[v][u] 任一非零则双向入表）。
 * 返回残量网络与最小割（= 终态残量网络中源可达集，割容量 = 流值——
 * Ford–Fulkerson 定理，与增广次序无关）。
 */
export function maxFlow(network: FlowNetwork): MaxFlowResult {
  const n = network.nodes;
  if (!Number.isInteger(n) || n < 2) throw new Error(`maxFlow: nodes=${String(n)} 需为 ≥2 的整数`);
  if (!Number.isInteger(network.source) || network.source < 0 || network.source >= n) throw new Error(`maxFlow: source=${String(network.source)} 越界`);
  if (!Number.isInteger(network.sink) || network.sink < 0 || network.sink >= n) throw new Error(`maxFlow: sink=${String(network.sink)} 越界`);
  if (network.source === network.sink) throw new Error('maxFlow: source 与 sink 必须不同');
  const residual = network.capacity.map((row, i) => {
    if (row.length !== n) throw new Error(`maxFlow: capacity[${i}] 长度 ${row.length} ≠ nodes ${n}`);
    return [...row];
  });
  const label = (i: number): string => network.labels?.[i] ?? String(i);
  let flowValue = 0;
  let paths = 0;

  // 邻接表（含镜像反向弧——残量网络动态反边的静态超集）
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let u = 0; u < n; u += 1) {
    for (let v = 0; v < n; v += 1) {
      if (u !== v && (network.capacity[u][v] > 0 || network.capacity[v][u] > 0)) adj[u].push(v);
    }
  }
  const level = new Array<number>(n).fill(-1);
  const arcPtr = new Array<number>(n).fill(0);

  const bfsLevels = (): boolean => {
    level.fill(-1);
    level[network.source] = 0;
    const queue: number[] = [network.source];
    for (let head = 0; head < queue.length; head += 1) {
      const u = queue[head];
      for (const v of adj[u]) {
        if (level[v] === -1 && residual[u][v] > 0) {
          level[v] = level[u] + 1;
          queue.push(v);
        }
      }
    }
    return level[network.sink] !== -1;
  };

  const dfsBlocking = (u: number, pushed: number): number => {
    if (u === network.sink) return pushed;
    const list = adj[u];
    for (; arcPtr[u] < list.length; arcPtr[u] += 1) {
      const v = list[arcPtr[u]];
      if (level[v] === level[u] + 1 && residual[u][v] > 0) {
        const amount = dfsBlocking(v, Math.min(pushed, residual[u][v]));
        if (amount > 0) {
          residual[u][v] -= amount;
          residual[v][u] += amount;
          return amount;
        }
      }
    }
    return 0;
  };

  while (bfsLevels()) {
    arcPtr.fill(0);
    for (;;) {
      const pushed = dfsBlocking(network.source, Number.POSITIVE_INFINITY);
      if (pushed <= 0) break;
      flowValue += pushed;
      paths += 1;
    }
  }
  // 最小割 = 残量网络中源可达集
  const reachable = new Set<number>([network.source]);
  const stack = [network.source];
  while (stack.length > 0) {
    const u = stack.pop()!;
    for (const v of adj[u]) {
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

// ══════════════════════ R5 进化（第五轮·世界性进化） ══════════════════════
//
// 轴 1（数学）: 最小费用流（逐次最短路 SSP + Johnson 位势 Dijkstra）。
//   问题: max-flow 值的诸多实现里选**总费用最小**的派发——
//     min Σ_(u,v) c_uv·f_uv  s.t. f 反对称净流、容量可行、源净出 = F。
//   定理（最优性证书）: 可行流最优 ⟺ 残量网络**无负费用环**
//   （LP 互补松弛的图判读——minCostFlowCertificate 用 Bellman–Ford 逐位
//   检查，最优性不靠信任，靠检查）。SSP 每轮沿最短路增广 ⟹ 每一步的
//   前缀流都满足无负环（归纳: 最短路增广不引入负环）⟹ 终态即最优。
//   实现: 初始位势 h 用 Bellman–Ford（允许负费用边），此后 Dijkstra 用
//   归约费用 w(u,v) + h[u] − h[v] ≥ 0 保持非负; 增广后 h[v] += dist[v]。
//   调度语义: 同样派 12 路并发，「便宜的模型多派、贵的只补缺口」——
//   派发计划第一次带价格。
//
// 轴 3（数值）: 流量守恒的浮点残差审计（flowAudit）。
//   净流 g(u,v) = cap(u,v) − residual(u,v)（反对称口径）; 审计三项:
//   节点失衡 |Σ_v g(u,v)|（内部节点应 = 0）、流值残差 |Σ_v g(s,v) − F|、
//   容量可行性 max(g − cap, −g − cap_rev, 0)——浮点增广的舍入全部
//   落在这三个读数里，容差随规模缩放。
// ══════════════════════════════════════════════════════════

/** 费用流网络（capacity 同 FlowNetwork; cost[u][v] = 边 (u,v) 单位费用） */
export interface CostFlowNetwork {
  nodes: number;
  source: number;
  sink: number;
  capacity: ReadonlyArray<ReadonlyArray<number>>;
  cost: ReadonlyArray<ReadonlyArray<number>>;
  labels?: ReadonlyArray<string>;
}

/** 最小费用流结果 */
export interface MinCostFlowResult {
  /** 达成流值（= maxTotal 截断时 < 最大流; 否则 = 最大流） */
  flowValue: number;
  /** 总费用 Σ c_uv·f_uv（f > 0 部分） */
  totalCost: number;
  /** 反对称净流矩阵 f[u][v] = −f[v][u]（0 ≤ |f| ≤ 各向容量） */
  flow: number[][];
  /** 增广轮数（= SSP 最短路次数） */
  augmentations: number;
}

function validateCostNetwork(network: CostFlowNetwork): void {
  const n = network.nodes;
  if (!Number.isInteger(n) || n < 2) throw new Error(`minCostMaxFlow: nodes=${String(n)} 需为 ≥2 的整数`);
  if (!Number.isInteger(network.source) || network.source < 0 || network.source >= n) throw new Error(`minCostMaxFlow: source=${String(network.source)} 越界`);
  if (!Number.isInteger(network.sink) || network.sink < 0 || network.sink >= n) throw new Error(`minCostMaxFlow: sink=${String(network.sink)} 越界`);
  if (network.source === network.sink) throw new Error('minCostMaxFlow: source 与 sink 必须不同');
  if (!Array.isArray(network.capacity) || !Array.isArray(network.cost)) throw new Error('minCostMaxFlow: 需要 capacity 与 cost 矩阵');
  for (let u = 0; u < n; u += 1) {
    const cr = network.capacity[u];
    const ct = network.cost[u];
    if (!Array.isArray(cr) || cr.length !== n || !Array.isArray(ct) || ct.length !== n) {
      throw new Error(`minCostMaxFlow: capacity/cost[${u}] 需为 ${n}×${n} 矩阵`);
    }
    for (let v = 0; v < n; v += 1) {
      if (!Number.isFinite(cr[v]) || cr[v] < 0) throw new Error(`minCostMaxFlow: capacity[${u}][${v}]=${String(cr[v])} 需为非负有限数`);
      if (cr[v] > 0 && !Number.isFinite(ct[v])) throw new Error(`minCostMaxFlow: 容量 >0 的边 cost[${u}][${v}] 需为有限数`);
    }
  }
}

/**
 * 最小费用（最大）流——逐次最短路 + Johnson 位势 Dijkstra。
 * options.maxTotal: 截断在给定流值（派发语义「至多派 D 路」）; 缺省送到最大流。
 * 初始网络若含负费用环 → 显式 throw（SSP 的前提被破坏，诚实拒绝）。
 */
export function minCostMaxFlow(network: CostFlowNetwork, options?: { maxTotal?: number }): MinCostFlowResult {
  validateCostNetwork(network);
  const n = network.nodes;
  const cap = network.capacity.map((row) => [...row]);
  const cost = network.cost;
  const s = network.source;
  const t = network.sink;
  const maxTotal = options?.maxTotal;
  if (maxTotal !== undefined && !(maxTotal >= 0)) throw new Error(`minCostMaxFlow: maxTotal=${String(maxTotal)} 需为 ≥0`);

  // 初始位势: Bellman–Ford（负费用边合法）; 负环 → throw
  const h = new Array<number>(n).fill(0);
  for (let round = 0; round < n; round += 1) {
    let changed = false;
    for (let u = 0; u < n; u += 1) {
      for (let v = 0; v < n; v += 1) {
        if (cap[u][v] > 0 && h[u] + cost[u][v] < h[v] - 1e-12) {
          h[v] = h[u] + cost[u][v];
          changed = true;
          if (round === n - 1) throw new Error('minCostMaxFlow: 初始网络含负费用环——SSP 前提被破坏（先消除负环）');
        }
      }
    }
    if (!changed) break;
  }

  const f = Array.from({ length: n }, () => new Array<number>(n).fill(0)); // 反对称净流
  let flowValue = 0;
  let augmentations = 0;

  for (;;) {
    if (maxTotal !== undefined && flowValue >= maxTotal - 1e-12) break;
    // 残量弧 u→v 有两条平行弧: 前向（剩余容量 cap[u][v] − f[u][v]，费用
    // c[u][v]）与反向退流（f[v][u] > 0 时可抵消 v→u 的流，费用 −c[v][u]）。
    // Dijkstra 松弛取两者中**可用的更便宜者**（多弧图的合法松弛），父链
    // 记录弧向，瓶颈按所选弧的残量计。
    const dist = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
    const prevU = new Array<number>(n).fill(-1);
    const usedBackward = new Array<boolean>(n).fill(false); // 到达 v 的弧是「反向退流」
    dist[s] = 0;
    const done = new Array<boolean>(n).fill(false);
    for (;;) {
      let u = -1;
      let best = Number.POSITIVE_INFINITY;
      for (let v = 0; v < n; v += 1) {
        if (!done[v] && dist[v] < best) {
          best = dist[v];
          u = v;
        }
      }
      if (u === -1) break;
      done[u] = true;
      for (let v = 0; v < n; v += 1) {
        if (v === u) continue;
        const fwd = cap[u][v] - f[u][v]; // 前向残量
        const bwd = f[v][u] > 0 ? f[v][u] : 0; // 反向退流残量（u→v 抵消 v→u 流）
        let w: number | undefined;
        let back = false;
        if (fwd > 1e-15 && (bwd <= 1e-15 || cost[u][v] <= -cost[v][u])) {
          w = cost[u][v];
        } else if (bwd > 1e-15) {
          w = -cost[v][u];
          back = true;
        }
        if (w === undefined) continue;
        const nd = dist[u] + w + h[u] - h[v];
        if (nd < dist[v] - 1e-12) {
          dist[v] = nd;
          prevU[v] = u;
          usedBackward[v] = back;
        }
      }
    }
    if (!Number.isFinite(dist[t])) break; // 源汇不通（或截断后无可行增广）
    // 沿父链回溯瓶颈（区分前向/反向弧的残量）
    let bottleneck = Number.POSITIVE_INFINITY;
    for (let v = t; v !== s; v = prevU[v]) {
      const u = prevU[v];
      const r = usedBackward[v] ? f[v][u] : cap[u][v] - f[u][v];
      if (r < bottleneck) bottleneck = r;
    }
    if (maxTotal !== undefined) bottleneck = Math.min(bottleneck, maxTotal - flowValue);
    if (!(bottleneck > 1e-15)) break;
    for (let v = t; v !== s; v = prevU[v]) {
      const u = prevU[v];
      if (usedBackward[v]) {
        f[v][u] -= bottleneck; // 退流
      } else {
        f[u][v] += bottleneck;
      }
    }
    flowValue += bottleneck;
    augmentations += 1;
    for (let v = 0; v < n; v += 1) {
      if (Number.isFinite(dist[v])) h[v] += dist[v];
    }
  }

  let totalCost = 0;
  for (let u = 0; u < n; u += 1) {
    for (let v = 0; v < n; v += 1) {
      if (f[u][v] > 0) totalCost += f[u][v] * cost[u][v];
    }
  }
  return { flowValue, totalCost, flow: f, augmentations };
}

/** 最小费用流最优性证书: 残量网络无负费用环（Bellman–Ford 全源松驰） */
export function minCostFlowCertificate(
  network: CostFlowNetwork,
  result: MinCostFlowResult,
): { negativeCycleFree: boolean; optimal: boolean; checkedArcs: number } {
  const n = network.nodes;
  const f = result.flow;
  let checkedArcs = 0;
  // 虚拟源全零初始化的 Bellman–Ford: 第 n 轮仍可松驰 ⟹ 存在负环
  const dist = new Array<number>(n).fill(0);
  for (let round = 0; round < n; round += 1) {
    let changed = false;
    for (let u = 0; u < n; u += 1) {
      for (let v = 0; v < n; v += 1) {
        if (v === u) continue;
        const fwd = network.capacity[u][v] - f[u][v];
        const bwd = f[v][u] > 0 ? f[v][u] : 0;
        const arcs: Array<[number, boolean]> = [];
        if (fwd > 1e-9) arcs.push([network.cost[u][v], false]);
        if (bwd > 1e-9) arcs.push([-network.cost[v][u], true]);
        for (const [w] of arcs) {
          checkedArcs += 1;
          if (dist[u] + w < dist[v] - 1e-9) {
            dist[v] = dist[u] + w;
            changed = true;
          }
        }
      }
    }
    if (!changed) return { negativeCycleFree: true, optimal: true, checkedArcs };
    if (round === n - 1) return { negativeCycleFree: false, optimal: false, checkedArcs };
  }
  return { negativeCycleFree: true, optimal: true, checkedArcs };
}

/** 流量守恒审计结果（轴 3: 浮点残差的三读数） */
export interface FlowAuditResult {
  /** 内部节点最大失衡 |Σ_v g(u,v)|（应 = 0） */
  maxNodeImbalance: number;
  /** 源净出流 − 流值 的残差（应 = 0） */
  valueResidual: number;
  /** 净流超出容量的最大违反（应 = 0; g(u,v) ≤ cap(u,v) 且 −g(u,v) ≤ cap(v,u)） */
  maxCapacityViolation: number;
  /** 三读数全在容差内 */
  conserved: boolean;
  tolerance: number;
}

/**
 * 流量守恒与容量可行性的浮点残差审计: 净流 g(u,v) = cap(u,v) − residual(u,v)
 * （反对称口径，residual 为 maxFlow 返回的残量矩阵）。容差按容量规模缩放。
 */
export function flowAudit(network: FlowNetwork, result: MaxFlowResult, tol = 1e-9): FlowAuditResult {
  const n = network.nodes;
  let scale = 1;
  for (let u = 0; u < n; u += 1) for (let v = 0; v < n; v += 1) scale = Math.max(scale, Math.abs(network.capacity[u][v]));
  const tolerance = tol * scale;
  const g = (u: number, v: number): number => network.capacity[u][v] - result.residual[u][v];
  let maxNodeImbalance = 0;
  for (let u = 0; u < n; u += 1) {
    if (u === network.source || u === network.sink) continue;
    let net = 0;
    for (let v = 0; v < n; v += 1) net += g(u, v);
    maxNodeImbalance = Math.max(maxNodeImbalance, Math.abs(net));
  }
  let srcNet = 0;
  for (let v = 0; v < n; v += 1) srcNet += g(network.source, v);
  let maxCapacityViolation = 0;
  for (let u = 0; u < n; u += 1) {
    for (let v = 0; v < n; v += 1) {
      const guv = g(u, v);
      if (guv > network.capacity[u][v] + tolerance) maxCapacityViolation = Math.max(maxCapacityViolation, guv - network.capacity[u][v]);
      if (-guv > network.capacity[v][u] + tolerance) maxCapacityViolation = Math.max(maxCapacityViolation, -guv - network.capacity[v][u]);
    }
  }
  return {
    maxNodeImbalance,
    valueResidual: Math.abs(srcNet - result.flowValue),
    maxCapacityViolation,
    conserved: maxNodeImbalance <= tolerance && Math.abs(srcNet - result.flowValue) <= tolerance && maxCapacityViolation <= tolerance,
    tolerance,
  };
}
