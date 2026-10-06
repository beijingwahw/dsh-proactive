/**
 * 71.0 A* 搜索内核 —— 可采纳启发式下的最优路径搜索
 *
 * 动机: 29.0 MCTS 在「转移未知/随机」的域里靠采样逼近最优动作；本内核处理
 * 对偶情形——「图完全已知、代价确定」时的精确最优路径：计划生成器的 DAG
 * 子计划组合、热重载依赖图的重验证顺序、记忆图上的最优查询路径。贪心组装
 * 在这些场景里只是「可行解」；A* 给出**可证明的最优**，且用启发式把扩展
 * 节点数压到 Dijkstra 的一小部分（同一份最优性，小得多的搜索账单）。
 *
 * 数学（Hart–Nilsson–Raphael 1968 最优性定理）:
 *   f(n) = g(n) + h(n)——已走成本 g 与到终点距离下界 h 之和。
 *   可采纳 h(n) ≤ h*(n)（真剩余距离）且 h(goal)=0 ⟹ 终点弹出时的 g 即
 *   最优成本 C*（弹出即证明：堆里任何 f 都 ≥ 弹出的 C*，而 f ≤ 真成本）。
 *   一致（单调）h(n) ≤ c(n,n′) + h(n′) ⟹ 可采纳的强化，且 f 沿任何路径
 *   单调不减 ⟹ 节点首次弹出即定型，**无需重开**；h 不一致但可采纳时，
 *   允许重开的 A* 仍最优（代价是 reopened > 0 的重复扩展）。
 *   h ≡ 0 ⟹ f = g ⟹ 精确退化为 Dijkstra（本内核提供独立实现的 dijkstra
 *   作对照基准，二者互证）。
 *
 * 平局打破（完全确定性）: 堆键四元组 (f, h, goalPref, pushSeq) 字典序——
 *   f 小者优先；f 同则 h 小者（离终点更近）优先；再同则终点节点优先
 *   （goalPref: 终点=0，其余=1）；最后按入堆序号 FIFO。
 *   goalPref 的两个定理级后果: (a) h≡0 时 astar 与独立实现的 dijkstra
 *   逐位同型（同成本、同扩展数）；(b) 一致 h 下 A* 恰好扩展 {n : f(n) < C*}
 *   （f = C* 的边界节点全部让位于终点弹出），故 h₂ ≥ h₁（逐点）⟹ 扩展集
 *   单调收缩 ⟹ 扩展数不增——「启发式信息量」由此成为可断言的偏序。
 *
 * 验证锚点（scripts/verify-search-sparse.mjs）:
 *   ① 30 例种子化 20×20 网格（8 邻域 1/√2 代价、60 随机障碍）:
 *      曼哈顿(√2/2 缩放)/欧氏/八向 h 下 A* 成本与 Dijkstra 完全相等；
 *   ② 扩展数偏序: octile ≤ euclidean ≤ manhattan ≤ dijkstra（逐例成立）；
 *   ③ h≡0: 与 dijkstra 同成本、同扩展数、reopened=0（30/30）；
 *   ④ 病态衰减 h（可采纳但不一致）: checkConsistent 报警、checkAdmissible
 *      放行、带重开的 A* 仍达 Dijkstra 最优且 reopened > 0（诚实演示）；
 *   ⑤ 不可达: 全墙隔断时有限步内返回 goalReached=false / cost=Infinity /
 *      path=[]（明确结果而非死循环）；
 *   ⑥ DAG 任务计划: 精确 h* 恒一致的定理验证 + A* 只扩展最优路径本身。
 *
 * 确定性: 无随机源（gridWorld 障碍生成用文件内 mulberry32(seed)）；
 *   同输入同输出，无 I/O、无时钟读取。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 *
 * ── R5 第五轮世界性进化（四轴）──
 *
 * A1【数学进化】加权 A*（Pohl 1970；ARA* Likhachev et al. 2003 谱系）
 *    的 w-次优界：options.weight = w ≥ 1 时评估函数改为
 *        f_w(n) = g(n) + w·h(n)
 *    可采纳 h 下弹出终点时的成本 Ĉ 满足 Ĉ ≤ w·C*（最优成本）——
 *    w 换次优性的明码标价：w=1 精确最优（与旧实现逐位一致），w>1
 *    更贪心（扩展集收缩、账单下降），代价是成本上界放宽 w 倍。
 *    weight 缺省 1：f = g + 1·h 与 g+h 逐位相同（IEEE754 乘 1 精确），
 *    既有全部行为零漂移。
 *
 * A2【性能进化】启发式惰性求值：h 不再全图预计算，而是在节点**首次
 *    入堆时**求值并缓存（hCache 命中即免调）。等价性：h 确定性契约下
 *    每个节点的 h 值、堆键 (f,h,goalPref,seq)、弹出/松弛判定与全图
 *    预计算版本逐位一致（verify-r5 以 200+ 种子对照 expanded/cost/
 *    reopened/path 全等）；收益 = h 调用数从 |V| 降到「生成节点数」
 *    （昂贵 h——嵌入相似度、神经距离——在大图上只付触达部分的价格）。
 *    语义边界：h 的有限性校验从「全图先验」收窄为「触达节点逐个」
 *    ——未触达节点的非法 h 不再被提前发现（诚实代价，文档化）。
 *
 * A3【数值稳健】weight 入参校验（有限、≥ 1，否则显式 throw——w<1
 *    会破坏次优界陈述）；g 累计仍为精确浮点加法（与基线同口径）。
 *
 * A4【性质测试】① w=1 与旧口径逐位一致；② w-次优界：200+ 种子网格
 *    上 Ĉ(w) ≤ w·C*（w ∈ {1.3, 2, 3}）；③ 扩展数随 w 总量单调不增；
 *    ④ 一致 h + w=1 下 reopened=0（既有定理不回归）；⑤ 惰性 h 的
 *    h-调用数 ≤ 生成节点数 < |V|（verify-r5-planning.mjs）。
 */

// ─────────────────────────── 确定性 PRNG ───────────────────────────

/** mulberry32——gridWorld 随机障碍的唯一随机源（同 seed 逐位复现） */
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

// ─────────────────────────── 图模型 ───────────────────────────

/** 带权有向边（代价须为有限非负数；非负是 Dijkstra/A* 最优性证明的前提） */
export interface WeightedEdge {
  to: string;
  cost: number;
}

/** 搜索图契约：节点清单 + 邻接表（无后继返回空数组）。边指向未知节点视为构造错误。 */
export interface SearchGraph {
  nodes(): readonly string[];
  neighbors(from: string): readonly WeightedEdge[];
}

interface MaterializedGraph {
  order: string[];
  adj: Map<string, WeightedEdge[]>;
}

/**
 * 图的一次性物化 + 全量校验（显式 throw）：
 * 节点 id 非空且不重复；每条边指向已知节点、代价为有限非负数。
 * 物化同时固定了邻接顺序——遍历顺序成为图定义的一部分（确定性）。
 */
function materialize(graph: SearchGraph, who: string): MaterializedGraph {
  if (!graph || typeof graph.nodes !== 'function' || typeof graph.neighbors !== 'function') {
    throw new Error(`${who}: SearchGraph 需实现 nodes() 与 neighbors()`);
  }
  const order = [...graph.nodes()];
  if (order.length === 0) throw new Error(`${who}: 节点集为空`);
  const seen = new Set<string>();
  for (const id of order) {
    if (typeof id !== 'string' || id.length === 0) throw new Error(`${who}: 节点 id 需为非空字符串`);
    if (seen.has(id)) throw new Error(`${who}: 节点 "${id}" 重复`);
    seen.add(id);
  }
  const adj = new Map<string, WeightedEdge[]>(order.map((id) => [id, [] as WeightedEdge[]]));
  for (const from of order) {
    let index = 0;
    for (const edge of graph.neighbors(from)) {
      if (!edge || typeof edge.to !== 'string') throw new Error(`${who}.neighbors("${from}")[${index}]: 缺少 to`);
      if (!adj.has(edge.to)) throw new Error(`${who}.neighbors("${from}")[${index}]: 指向未知节点 "${edge.to}"`);
      if (typeof edge.cost !== 'number' || !Number.isFinite(edge.cost) || edge.cost < 0) {
        throw new Error(`${who}.neighbors("${from}")[${index}]: 代价 ${String(edge.cost)} 需为有限非负数`);
      }
      adj.get(from)!.push({ to: edge.to, cost: edge.cost });
      index += 1;
    }
  }
  return { order, adj };
}

// ─────────────────────────── 搜索结果 ───────────────────────────

export interface SearchResult {
  /** 是否到达终点（false = 有限步穷尽后确认不可达） */
  goalReached: boolean;
  /** [start..goal] 节点序列；不可达时为 [] */
  path: string[];
  /** 路径总代价；不可达时为 Infinity */
  cost: number;
  /** 弹出并生成后继的节点数（含终点；搜索账单） */
  expanded: number;
  /** 重开次数（一致 h 下恒 0——「无需重开」定理的运行时证据） */
  reopened: number;
}

function unreachableResult(expanded: number): SearchResult {
  return { goalReached: false, path: [], cost: Number.POSITIVE_INFINITY, expanded, reopened: 0 };
}

function reconstructPath(parent: Map<string, string>, start: string, goal: string): string[] {
  const path = [goal];
  const guard = new Set<string>([goal]);
  let cur = goal;
  while (cur !== start) {
    const prev = parent.get(cur);
    if (prev === undefined || guard.has(prev)) throw new Error('astar-search: 路径重建失败（内部不变量破坏）');
    path.push(prev);
    guard.add(prev);
    cur = prev;
  }
  path.reverse();
  return path;
}

// ─────────────────────────── 优先队列 ───────────────────────────

interface QueueItem {
  node: string;
  /** 弹出时应生效的 g（惰性删除：与 gBest 不符即过期） */
  g: number;
  f: number;
  h: number;
  /** 终点偏好：终点=0，其余=1（平局打破第三键） */
  bias: number;
  seq: number;
}

/** 字典序 (f, h, goalPref, pushSeq)——完全全序，堆行为确定 */
function queueLess(a: QueueItem, b: QueueItem): boolean {
  if (a.f !== b.f) return a.f < b.f;
  if (a.h !== b.h) return a.h < b.h;
  if (a.bias !== b.bias) return a.bias < b.bias;
  return a.seq < b.seq;
}

/** 二叉最小堆（数组实现；仅本内核使用，无外部依赖） */
class SearchHeap {
  private items: QueueItem[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: QueueItem): void {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!queueLess(this.items[i]!, this.items[parent]!)) break;
      [this.items[i], this.items[parent]] = [this.items[parent]!, this.items[i]!];
      i = parent;
    }
  }

  pop(): QueueItem | undefined {
    const n = this.items.length;
    if (n === 0) return undefined;
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (n > 1) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && queueLess(this.items[l]!, this.items[m]!)) m = l;
        if (r < this.items.length && queueLess(this.items[r]!, this.items[m]!)) m = r;
        if (m === i) break;
        [this.items[i], this.items[m]] = [this.items[m]!, this.items[i]!];
        i = m;
      }
    }
    return top;
  }
}

// ─────────────────────────── Dijkstra（对照基准） ───────────────────────────

/**
 * Dijkstra 最短路径（独立实现，非 astar 的退化壳——二者互证）。
 * 堆键 (g, 0, goalPref, seq)；g 键单调 ⟹ settled 节点永不改进、永不重开
 * （reopened 恒 0）。终点弹出即停（early exit）。
 */
export function dijkstra(graph: SearchGraph, start: string, goal: string): SearchResult {
  const { adj } = materialize(graph, 'dijkstra');
  if (typeof start !== 'string' || !adj.has(start)) throw new Error(`dijkstra: 起点 "${String(start)}" 不在图中`);
  if (typeof goal !== 'string' || !adj.has(goal)) throw new Error(`dijkstra: 终点 "${String(goal)}" 不在图中`);

  const dist = new Map<string, number>([[start, 0]]);
  const parent = new Map<string, string>();
  const settled = new Set<string>();
  const heap = new SearchHeap();
  let seq = 0;
  heap.push({ node: start, g: 0, f: 0, h: 0, bias: start === goal ? 0 : 1, seq: seq++ });

  let expanded = 0;
  for (;;) {
    const cur = heap.pop();
    if (cur === undefined) return unreachableResult(expanded);
    if (settled.has(cur.node)) continue;
    settled.add(cur.node);
    expanded += 1;
    if (cur.node === goal) {
      return { goalReached: true, path: reconstructPath(parent, start, goal), cost: cur.g, expanded, reopened: 0 };
    }
    for (const edge of adj.get(cur.node)!) {
      const next = cur.g + edge.cost;
      const best = dist.get(edge.to);
      if (best === undefined || next < best) {
        dist.set(edge.to, next);
        parent.set(edge.to, cur.node);
        heap.push({ node: edge.to, g: next, f: next, h: 0, bias: edge.to === goal ? 0 : 1, seq: seq++ });
      }
    }
  }
}

// ─────────────────────────── A* ───────────────────────────

/** 启发函数契约：h(n) 为到终点距离的下界估计（有限数；可采纳 ⟹ 最优性） */
export type Heuristic = (node: string) => number;

export interface AstarOptions {
  graph: SearchGraph;
  start: string;
  goal: string;
  h: Heuristic;
  /**
   * 允许重开（缺省 true）。一致 h 下永不触发（reopened=0）；可采纳但
   * 不一致的 h 下，true 保证最优（代价 reopened>0），false 更快但可能次优。
   */
  allowReopen?: boolean;
  /**
   * R5：加权系数 w ≥ 1（缺省 1 = 精确最优，与旧实现逐位一致）。
   * w > 1 启用加权 A*：f = g + w·h，弹出终点的成本 ≤ w·C*（w-次优界，
   * 可采纳 h 下成立）；扩展集通常收缩（更贪心）。w < 1 / 非有限值 throw
   * （次优界陈述被破坏）。
   */
  weight?: number;
}

/**
 * A* 图搜索。惰性删除堆 + closed 集合：
 *   - 弹出项 g 与 gBest 不符 → 过期跳过；
 *   - 非过期弹出且已 closed：allowReopen 时计入 reopened 并重扩展；
 *   - 终点在**弹出时**判定返回（可采纳 h 下的最优性证明依赖弹出语义，
 *     不能在生成时提前判停）。
 * h 惰性求值（R5）：首次入堆时计算并缓存（等价于确定性 h 的全图预
 * 计算；非法值（NaN/±Infinity）在首触达时显式 throw）。
 * weight（R5）：f = g + weight·h；weight=1 逐位兼容。
 */
export function astar(options: AstarOptions): SearchResult {
  if (!options || typeof options !== 'object') throw new Error('astar: 需传入 { graph, start, goal, h }');
  const { graph, start, goal, h } = options;
  if (typeof h !== 'function') throw new Error('astar: h 需为 (node: string) => number');
  const allowReopen = options.allowReopen ?? true;
  const weight = options.weight ?? 1;
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 1) {
    throw new Error(`astar: weight=${String(weight)} 需为 ≥ 1 的有限数（w-次优界的前提）`);
  }

  const { adj } = materialize(graph, 'astar');
  if (typeof start !== 'string' || !adj.has(start)) throw new Error(`astar: 起点 "${String(start)}" 不在图中`);
  if (typeof goal !== 'string' || !adj.has(goal)) throw new Error(`astar: 终点 "${String(goal)}" 不在图中`);

  // R5 惰性求值：h(id) 首调时校验有限性并缓存（确定性 h 下与全图预
  // 计算逐位等价；h 调用数 = 触达节点数而非 |V|）
  const hCache = new Map<string, number>();
  const hOf = (id: string): number => {
    const hit = hCache.get(id);
    if (hit !== undefined) return hit;
    const v = h(id);
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`astar: h("${id}") = ${String(v)} 需为有限数（可采纳性要求 h ≤ h*，不允许 ±Infinity/NaN）`);
    }
    hCache.set(id, v);
    return v;
  };

  const gBest = new Map<string, number>([[start, 0]]);
  const parent = new Map<string, string>();
  const closed = new Set<string>();
  const heap = new SearchHeap();
  let seq = 0;
  const h0 = hOf(start);
  heap.push({ node: start, g: 0, f: weight === 1 ? h0 : weight * h0, h: h0, bias: start === goal ? 0 : 1, seq: seq++ });

  let expanded = 0;
  let reopened = 0;
  for (;;) {
    const cur = heap.pop();
    if (cur === undefined) return { ...unreachableResult(expanded), reopened };
    // 惰性删除：此条目入堆后 gBest 又被更短路径改小 → 过期
    if (cur.g > (gBest.get(cur.node) ?? Number.POSITIVE_INFINITY)) continue;
    if (closed.has(cur.node)) {
      if (!allowReopen) continue; // 防御分支（不重开时松弛已被拦截）
      reopened += 1; // 以更小 g 重访已扩展节点——不一致 h 的诚实账单
    }
    closed.add(cur.node);
    expanded += 1;
    if (cur.node === goal) {
      return { goalReached: true, path: reconstructPath(parent, start, goal), cost: cur.g, expanded, reopened };
    }
    for (const edge of adj.get(cur.node)!) {
      if (!allowReopen && closed.has(edge.to)) continue;
      const next = cur.g + edge.cost;
      const best = gBest.get(edge.to);
      if (best === undefined || next < best) {
        gBest.set(edge.to, next);
        parent.set(edge.to, cur.node);
        const hv = hOf(edge.to);
        heap.push({ node: edge.to, g: next, f: weight === 1 ? next + hv : next + weight * hv, h: hv, bias: edge.to === goal ? 0 : 1, seq: seq++ });
      }
    }
  }
}

/** h ≡ 0——A* 的 Dijkstra 退化开关（对照/基线用） */
export const zeroHeuristic: Heuristic = () => 0;

// ─────────────────────────── 距离表 / 反图 ───────────────────────────

/** 全图 Dijkstra（无早停）：源点到每个节点的精确距离；不可达 = Infinity。生成 h* 的工具。 */
export function allDistances(graph: SearchGraph, source: string): Map<string, number> {
  const { order, adj } = materialize(graph, 'allDistances');
  if (typeof source !== 'string' || !adj.has(source)) throw new Error(`allDistances: 源点 "${String(source)}" 不在图中`);
  const dist = new Map<string, number>(order.map((id) => [id, Number.POSITIVE_INFINITY]));
  dist.set(source, 0);
  const settled = new Set<string>();
  const heap = new SearchHeap();
  let seq = 0;
  heap.push({ node: source, g: 0, f: 0, h: 0, bias: 1, seq: seq++ });
  for (;;) {
    const cur = heap.pop();
    if (cur === undefined) break;
    if (settled.has(cur.node)) continue;
    settled.add(cur.node);
    for (const edge of adj.get(cur.node)!) {
      const next = cur.g + edge.cost;
      if (next < dist.get(edge.to)!) {
        dist.set(edge.to, next);
        heap.push({ node: edge.to, g: next, f: next, h: 0, bias: 1, seq: seq++ });
      }
    }
  }
  return dist;
}

/** 反图（所有边 (u→v,c) 变 (v→u,c)）。allDistances(reverseGraph(g), goal) 即「到终点的精确距离 h*」。 */
export function reverseGraph(graph: SearchGraph): SearchGraph {
  const { order, adj } = materialize(graph, 'reverseGraph');
  const rev = new Map<string, WeightedEdge[]>(order.map((id) => [id, [] as WeightedEdge[]]));
  for (const from of order) {
    for (const edge of adj.get(from)!) {
      rev.get(edge.to)!.push({ to: from, cost: edge.cost });
    }
  }
  return {
    nodes: () => order,
    neighbors: (from: string): readonly WeightedEdge[] => {
      const list = rev.get(from);
      if (list === undefined) throw new Error(`reverseGraph.neighbors: 未知节点 "${from}"`);
      return list;
    },
  };
}

// ─────────────────────────── 校验工具（小图精确检查） ───────────────────────────

export interface AdmissibilityReport {
  /** h(n) ≤ h*(n) ∀n（含容差） */
  admissible: boolean;
  /** max(h(n) − h*(n))；≤ 0 即可采纳 */
  maxExcess: number;
  /** 违反节点清单（空 = 全部通过） */
  violations: string[];
}

/**
 * 可采纳性精确校验：h(n) ≤ h*(n) + tol 逐节点比对。
 * trueCosts 用 allDistances(reverseGraph(graph), goal) 生成（小图成本可控）。
 */
export function checkAdmissible(h: Heuristic, graph: SearchGraph, trueCosts: Map<string, number>, tol = 1e-9): AdmissibilityReport {
  if (typeof h !== 'function') throw new Error('checkAdmissible: h 需为 (node: string) => number');
  const { order } = materialize(graph, 'checkAdmissible');
  const violations: string[] = [];
  let maxExcess = Number.NEGATIVE_INFINITY;
  for (const id of order) {
    const hv = h(id);
    if (typeof hv !== 'number' || !Number.isFinite(hv)) throw new Error(`checkAdmissible: h("${id}") = ${String(hv)} 需为有限数`);
    const star = trueCosts.get(id);
    if (star === undefined) throw new Error(`checkAdmissible: trueCosts 缺少节点 "${id}"（用 allDistances(reverseGraph(graph), goal) 生成）`);
    if (!Number.isFinite(star)) throw new Error(`checkAdmissible: 节点 "${id}" 的真距离为 ${String(star)}（不可达节点无法校验可采纳性）`);
    const excess = hv - star;
    if (excess > maxExcess) maxExcess = excess;
    if (excess > tol) violations.push(id);
  }
  return { admissible: violations.length === 0, maxExcess, violations };
}

export interface ConsistencyViolation {
  from: string;
  to: string;
  cost: number;
  hFrom: number;
  hTo: number;
  /** h(from) − cost − h(to)；> 0 即违反三角不等式 */
  slack: number;
}

export interface ConsistencyReport {
  /** h(n) ≤ c(n,n′) + h(n′) 对全部边成立（含容差） */
  consistent: boolean;
  /** max(h(u) − c − h(v))；≤ 0 即一致 */
  maxViolation: number;
  violatedEdges: ConsistencyViolation[];
}

/** 一致性精确校验：对每条边 (u,v,c) 检查 h(u) ≤ c + h(v)。一致 ⟹ 可采纳（h(goal)=0 时），且 A* 无需重开。 */
export function checkConsistent(h: Heuristic, graph: SearchGraph, tol = 1e-9): ConsistencyReport {
  if (typeof h !== 'function') throw new Error('checkConsistent: h 需为 (node: string) => number');
  const { order, adj } = materialize(graph, 'checkConsistent');
  const violatedEdges: ConsistencyViolation[] = [];
  let maxViolation = Number.NEGATIVE_INFINITY;
  for (const from of order) {
    const hFrom = h(from);
    if (typeof hFrom !== 'number' || !Number.isFinite(hFrom)) throw new Error(`checkConsistent: h("${from}") = ${String(hFrom)} 需为有限数`);
    for (const edge of adj.get(from)!) {
      const hTo = h(edge.to);
      if (typeof hTo !== 'number' || !Number.isFinite(hTo)) throw new Error(`checkConsistent: h("${edge.to}") = ${String(hTo)} 需为有限数`);
      const slack = hFrom - edge.cost - hTo;
      if (slack > maxViolation) maxViolation = slack;
      if (slack > tol) violatedEdges.push({ from, to: edge.to, cost: edge.cost, hFrom, hTo, slack });
    }
  }
  return { consistent: violatedEdges.length === 0, maxViolation, violatedEdges };
}

// ─────────────────────────── 网格世界工厂 ───────────────────────────

/** 网格度量（const 对象替代 enum）。注意：8 邻域对角步价 √2 < 2，原始曼哈顿会高估距离（不可采纳）——按最险缩放因子 √2/2 折算保可采纳。 */
export const GRID_METRIC = {
  /** (|dx|+|dy|) × √2/2——8 邻域下可采纳且一致的曼哈顿变体（直行步降 1 ≥ √2/2，对角步降 2 与 √2 等比） */
  MANHATTAN: 'manhattan',
  /** √(dx²+dy²)——直线距离，恒 ≤ 任何路径成本 */
  EUCLIDEAN: 'euclidean',
  /** max(dx,dy) + (√2−1)·min(dx,dy)——无障碍 8 邻域的精确距离（最紧的可采纳启发式） */
  OCTILE: 'octile',
} as const;

export type GridMetric = (typeof GRID_METRIC)[keyof typeof GRID_METRIC];

const GRID_NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [1, -1], [-1, 1], [1, 1],
];

export interface GridWorld {
  readonly width: number;
  readonly height: number;
  /** 障碍格集合（"x,y"） */
  readonly blocked: ReadonlySet<string>;
  /** 自由格构成的搜索图（8 邻域；直行代价 1、对角代价 √2） */
  readonly graph: SearchGraph;
  isBlocked(x: number, y: number): boolean;
  nodeId(x: number, y: number): string;
  coordsOf(id: string): { x: number; y: number };
  /** 行序自由格清单（选起点/终点用） */
  freeCells(): readonly string[];
}

function parseCell(cell: string, width: number, height: number, who: string): { x: number; y: number } {
  const match = /^(-?\d+),(-?\d+)$/.exec(cell);
  if (match === null) throw new Error(`${who}: 障碍格 "${cell}" 需为 "x,y" 格式`);
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (x < 0 || x >= width || y < 0 || y >= height) {
    throw new Error(`${who}: 障碍格 "${cell}" 越界（网格 ${width}×${height}）`);
  }
  return { x, y };
}

/**
 * 8 邻域网格世界工厂（A* 的经典试验场 + 计划网格的抽象）。
 * obstacles 为数值时：mulberry32(seed) 局部 Fisher–Yates 抽取等量互异障碍格；
 * 为字符串数组时：显式列出（迷宫/隔断构造用）。图节点 = 自由格；邻接顺序
 * 东西南北→四对角（该顺序参与平局打破，构成确定性的一部分）。
 */
export function gridWorld(width: number, height: number, obstacles: number | readonly string[], seed = 20261001): GridWorld {
  if (!Number.isInteger(width) || width < 1) throw new Error(`gridWorld: width=${String(width)} 需为正整数`);
  if (!Number.isInteger(height) || height < 1) throw new Error(`gridWorld: height=${String(height)} 需为正整数`);
  if (!Number.isFinite(seed)) throw new Error('gridWorld: seed 需为有限数');
  const total = width * height;
  const blocked = new Set<string>();
  const cellId = (i: number): string => `${i % width},${Math.floor(i / width)}`;

  if (typeof obstacles === 'number') {
    if (!Number.isInteger(obstacles) || obstacles < 0 || obstacles > total) {
      throw new Error(`gridWorld: 数值型障碍数 ${String(obstacles)} 需为 [0, ${total}] 的整数`);
    }
    const rng = mulberry32(seed);
    const pool = Array.from({ length: total }, (_, i) => i);
    for (let i = 0; i < obstacles; i += 1) {
      const j = i + Math.floor(rng() * (total - i));
      const tmp = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = tmp;
      blocked.add(cellId(pool[i]!));
    }
  } else if (Array.isArray(obstacles)) {
    for (const cell of obstacles) {
      if (typeof cell !== 'string') throw new Error(`gridWorld: 障碍格 ${String(cell)} 需为 "x,y" 字符串`);
      const { x, y } = parseCell(cell, width, height, 'gridWorld');
      blocked.add(`${x},${y}`);
    }
  } else {
    throw new Error('gridWorld: obstacles 需为障碍数量（number）或障碍格清单（string[]）');
  }

  const order: string[] = [];
  const adj = new Map<string, WeightedEdge[]>();
  const edgesOf = (x: number, y: number): WeightedEdge[] => {
    const list: WeightedEdge[] = [];
    for (const [dx, dy] of GRID_NEIGHBOR_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const id = `${nx},${ny}`;
      if (blocked.has(id)) continue;
      list.push({ to: id, cost: dx === 0 || dy === 0 ? 1 : Math.SQRT2 });
    }
    return list;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const id = `${x},${y}`;
      if (blocked.has(id)) continue;
      order.push(id);
      adj.set(id, edgesOf(x, y));
    }
  }

  const world: GridWorld = {
    width,
    height,
    blocked,
    graph: {
      nodes: () => order,
      neighbors: (from: string): readonly WeightedEdge[] => {
        const list = adj.get(from);
        if (list === undefined) throw new Error(`gridWorld.graph.neighbors: "${from}" 不是自由格`);
        return list;
      },
    },
    isBlocked: (x: number, y: number): boolean => blocked.has(`${x},${y}`),
    nodeId: (x: number, y: number): string => {
      if (x < 0 || x >= width || y < 0 || y >= height) throw new Error(`nodeId: (${x},${y}) 越界`);
      return `${x},${y}`;
    },
    coordsOf: (id: string): { x: number; y: number } => parseCell(id, width, height, 'coordsOf'),
    freeCells: (): readonly string[] => order,
  };
  return world;
}

/** 网格启发式工厂：goal 与度量 → h 函数（直接喂给 astar） */
export function gridHeuristic(world: GridWorld, goal: string, metric: GridMetric): Heuristic {
  if (!world || typeof world.coordsOf !== 'function') throw new Error('gridHeuristic: world 需为 gridWorld() 的产物');
  const { x: gx, y: gy } = world.coordsOf(goal);
  const make = (distance: (dx: number, dy: number) => number): Heuristic => (node: string) => {
    const { x, y } = world.coordsOf(node);
    return distance(Math.abs(x - gx), Math.abs(y - gy));
  };
  switch (metric) {
    case GRID_METRIC.MANHATTAN:
      return make((dx, dy) => Math.SQRT1_2 * (dx + dy));
    case GRID_METRIC.EUCLIDEAN:
      return make((dx, dy) => Math.hypot(dx, dy));
    case GRID_METRIC.OCTILE:
      return make((dx, dy) => Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy));
    default:
      throw new Error(`gridHeuristic: 未知度量 "${String(metric)}"（可用: ${Object.values(GRID_METRIC).join(' / ')}）`);
  }
}

// ─────────────────────────── 边表构造器 ───────────────────────────

export interface GraphEdge {
  from: string;
  to: string;
  cost: number;
}

/** 边表 → 搜索图（DAG 任务计划等小图的便捷入口；重复边=并行边，按给定顺序保留）。 */
export function graphFromEdgeList(nodes: readonly string[], edges: readonly GraphEdge[]): SearchGraph {
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('graphFromEdgeList: nodes 需为非空数组');
  if (!Array.isArray(edges)) throw new Error('graphFromEdgeList: edges 需为数组');
  const known = new Set<string>();
  for (const id of nodes) {
    if (typeof id !== 'string' || id.length === 0) throw new Error(`graphFromEdgeList: 节点 id ${String(id)} 需为非空字符串`);
    if (known.has(id)) throw new Error(`graphFromEdgeList: 节点 "${id}" 重复`);
    known.add(id);
  }
  const adj = new Map<string, WeightedEdge[]>(nodes.map((id) => [id, [] as WeightedEdge[]]));
  let index = 0;
  for (const edge of edges) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') {
      throw new Error(`graphFromEdgeList.edges[${index}]: 需为 { from, to, cost }`);
    }
    if (!known.has(edge.from)) throw new Error(`graphFromEdgeList.edges[${index}]: from "${edge.from}" 不在节点清单中`);
    if (!known.has(edge.to)) throw new Error(`graphFromEdgeList.edges[${index}]: to "${edge.to}" 不在节点清单中`);
    if (typeof edge.cost !== 'number' || !Number.isFinite(edge.cost) || edge.cost < 0) {
      throw new Error(`graphFromEdgeList.edges[${index}]: 代价 ${String(edge.cost)} 需为有限非负数`);
    }
    adj.get(edge.from)!.push({ to: edge.to, cost: edge.cost });
    index += 1;
  }
  const order = [...nodes];
  return {
    nodes: () => order,
    neighbors: (from: string): readonly WeightedEdge[] => {
      const list = adj.get(from);
      if (list === undefined) throw new Error(`graphFromEdgeList.neighbors: 未知节点 "${from}"`);
      return list;
    },
  };
}

/* ── 接线建议 ──
 * 建议挂载引擎: 计划生成器（大计划空间的最优子计划搜索）、热重载协调器
 * （依赖图重排）、记忆子系统（知识图最优查询路径）。
 *   1. 计划生成器: 当前 DAG 计划为贪心组装（可行解）；把任务图交给
 *      graphFromEdgeList（节点=任务/检查点，边=依赖+成本，成本=预计 token
 *      或时延），astar(graph, start, goal, h) 输出最优子计划序列；h 用
 *      关键路径下界（剩余任务的最小串行成本），checkConsistent 上线前
 *      自证一致性（不一致则退回 allowReopen=true 或 h≡0）。
 *   2. 热重载依赖图重排: 模块依赖图上以「受影响需重验证的节点集」为目标
 *      集、边=传播成本，多起点全查 allDistances(reverseGraph(...), 目标)
 *      取影响半径最小的重载顺序；不可达（无依赖路径）直接短路。
 *   3. 记忆图最优查询路径: 记忆节点图（边=检索跳转成本）上 goal=目标记忆，
 *      h=嵌入相似度倒数下界——与 29.0 MCTS 互补：已知图精确最优 / 未知
 *      域采样逼近，按图的可信度分派。
 *   缺省关闭旗标名: enableAstarSearchKernel（缺省 false；旗标关闭时计划
 *      组装/重载顺序/记忆检索全部走原贪心与最近邻路径）。
 *   挂载后改变的决策点: ① 子计划选择（贪心 → 最优）；② 热重载重验证顺序
 *      （拓扑序 → 影响半径最优序）；③ 记忆检索路径（贪心最近邻 → h 引导
 *      最优路径），并新增 expanded/reopened 运行时账单可审计。
 * 未挂载（旗标 false）时以上决策点全部走原路径——行为逐位一致（零漂移）。
 */
