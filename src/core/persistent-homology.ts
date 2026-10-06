/**
 * 36.0 持续同调内核 —— H₀ 持续图 + 瓶颈距离：知识的形状跨尺度可见
 *
 * 动机: 记忆图（共现网络 + 主题树）只知道「谁连着谁」，不知道**自己在
 * 什么尺度上是什么形状**。把边权视为相似度、阈值 ε 从高往低扫：
 *
 *   ε = ∞: 每条知识自成一个分量（群岛）；ε 下降: 强相似先合并，
 *   分量逐个死去——单连接合并过程就是 H₀ 的持久图（persistence diagram）。
 *
 *   拓扑数据处理（Edelsbrunner–Letscher–Zomorodian 2002）的洞见：
 *   **只在一个尺度上出现的结构是噪声，跨尺度持久的结构是形状**。
 *   - 死得早（高 ε 就被吞并）的分量 = 聚类内部的普通成员；
 *   - 持久到低 ε 的分量 = 稳定的知识大陆；
 *   - 永不合并（essential class）的分量 = 知识孤岛——与任何主题都不
 *     共现的记忆，正是好奇心该去的地方（盲区的拓扑定义）。
 *
 *   瓶颈距离（Cohen-Steiner–Edelsbrunner–Harer 稳定性定理）:
 *   两张持久图的瓶颈距离 ≤ 输入度量的扰动——**知识地形的变化本身
 *   有了 Lipschitz 稳定的度量**：记忆重组前后地形漂移多少，一个数字。
 *
 *   实现口径: 并查集单连接（H₀ 精确，O(E log E)）；瓶颈距离用
 *   阈值化二分 + 增广路匹配（精确，小图适用）。
 *
 *   R5 进化（拓扑动力内核第五轮）: ① H₁ 持续同调 + 代表圈提取（h1Persistence
 *   ——标准边界矩阵消元，洞第一次有了可定位的成员序列）；② clearing 加速
 *   （H₀ 负边的并查集折叠——配对不变、消元次数确定性减少，engine:'matrix'
 *   全矩阵消元逐条对照）；③ Euler–Poincaré 一致性（complexBetti:
 *   χ = V−E+F = β₀−β₁+β₂）；④ 过滤平局的确定性排序（权重降序、维数升序、
 *   字典序——同输入同输出与输入边序无关）。
 *
 * 零漂移: 纯分析内核，未挂载时调用方行为与升级前逐位一致。
 */

/** 一次合并事件（一个 H₀ 类的死亡） */
export interface MergeEvent {
  /** 合并发生的相似度阈值（该边权重） */
  epsilon: number;
  /** 被吞并侧的大小（young 类的成员数——分量大小的「死因」） */
  absorbedSize: number;
  /** 存活侧的代表（并查集根，节点 id） */
  survivor: string;
}

export interface TopographyReport {
  /** 节点数 */
  nodes: number;
  /** essential 类（永不合并的分量 = 知识孤岛；阈值降到 floor 仍独活） */
  islands: Array<{ members: string[] }>;
  /** 合并事件按 ε 降序（知识大陆的成形史） */
  merges: MergeEvent[];
  /** 有限持久点 (birth, death) = (1, 合并 ε)：death 越小越早被吞并 */
  diagram: Array<{ birth: number; death: number }>;
  /** 最持久的合并阈值带（大陆间连接强度分布的分位数） */
  landscape: { p50: number; p90: number; continentCount: number };
}

/** 并查集（带分量大小） */
class DisjointSet {
  private parent = new Map<string, string>();
  private size = new Map<string, number>();
  add(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.size.set(x, 1);
    }
  }
  find(x: string): string {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // 路径压缩
    let cur = x;
    while (this.parent.get(cur) !== cur) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  /** 合并：返回 [存活根, 被吞并根, 被吞并侧合并前的大小]（按大小挂大树上；同大小字典序稳定） */
  union(a: string, b: string): [string, string, number] | undefined {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return undefined;
    const sa = this.size.get(ra)!;
    const sb = this.size.get(rb)!;
    const [survivor, absorbed, absorbedSize] = sa > sb || (sa === sb && ra < rb) ? [ra, rb, sb] : [rb, ra, sa];
    this.parent.set(absorbed, survivor);
    this.size.set(survivor, sa + sb);
    return [survivor, absorbed, absorbedSize];
  }
}

/**
 * H₀ 持续同调（相似度口径：阈值 ε 从 1 降到 floor）。
 *
 * nodes: 参与节点 id；edges: {source, target, weight ∈ (0,1]}（相似度）。
 * essential 类 = 阈值降到 floor 仍独活的分量（含完全孤立的节点）。
 */
export function h0Persistence(
  nodes: ReadonlyArray<string>,
  edges: ReadonlyArray<{ source: string; target: string; weight: number }>,
  floor = 0,
): TopographyReport {
  const ds = new DisjointSet();
  for (const id of nodes) ds.add(id);
  const sorted = [...edges].sort((a, b) => b.weight - a.weight);
  const merges: MergeEvent[] = [];
  const diagram: Array<{ birth: number; death: number }> = [];
  for (const edge of sorted) {
    if (edge.weight <= floor) continue;
    const union = ds.union(edge.source, edge.target);
    if (!union) continue; // 同分量内的冗余边（环）
    const [survivor, , absorbedSize] = union; // 被吞并侧合并前的成员数（young 类的「死因」）
    merges.push({ epsilon: edge.weight, absorbedSize, survivor });
    diagram.push({ birth: 1, death: edge.weight }); // H₀ 出生于满阈值
  }
  // essential 类：按根聚合
  const components = new Map<string, string[]>();
  for (const id of nodes) {
    const root = ds.find(id);
    const bucket = components.get(root) ?? [];
    bucket.push(id);
    components.set(root, bucket);
  }
  const islands = [...components.values()].map((members) => ({ members })).sort((a, b) => b.members.length - a.members.length);
  const deaths = diagram.map((d) => d.death).sort((a, b) => a - b);
  const quantile = (p: number): number => {
    if (deaths.length === 0) return 0;
    const idx = Math.min(deaths.length - 1, Math.max(0, Math.ceil(p * deaths.length) - 1));
    return deaths[idx];
  };
  return {
    nodes: nodes.length,
    islands,
    merges,
    diagram,
    landscape: { p50: quantile(0.5), p90: quantile(0.9), continentCount: islands.length },
  };
}

/**
 * 瓶颈距离（L∞ 匹配口径，含对角线）。
 *
 * ε-匹配可行性：A_i ↔ B_j（‖·‖∞ ≤ ε）或 A_i ↔ 对角线（distToDiag ≤ ε），
 * B_j 同理可留对角线。二分候选 ε（成对距离 ∪ 对角距离），增广路判可行。
 * 稳定性定理（Cohen-Steiner et al.）: 输入扰动 δ → 瓶颈距离 ≤ δ。
 */
export function bottleneckDistance(
  pointsA: ReadonlyArray<{ birth: number; death: number }>,
  pointsB: ReadonlyArray<{ birth: number; death: number }>,
): number {
  if (pointsA.length === 0 && pointsB.length === 0) return 0;
  const diag = (p: { birth: number; death: number }): number => Math.abs(p.death - p.birth) / 2;
  const dist = (p: { birth: number; death: number }, q: { birth: number; death: number }): number =>
    Math.max(Math.abs(p.birth - q.birth), Math.abs(p.death - q.death));
  // 候选 ε：所有 A-B 距离 ∪ 所有到对角线距离
  const candidates = new Set<number>();
  for (const a of pointsA) {
    candidates.add(diag(a));
    for (const b of pointsB) candidates.add(dist(a, b));
  }
  for (const b of pointsB) candidates.add(diag(b));
  const sorted = [...candidates].sort((x, y) => x - y);
  // 可行性：ε-匹配要覆盖**双侧强制点**（diag > ε、不可去对角线的点）。
  // 双侧强制是带下界的匹配问题（最大匹配的覆盖集不唯一——Kuhn 单侧
  // 跑法不充分）：强制 A 回溯指派（候选少者优先剪枝），剩余强制 B
  // 经强制 A 未占用的 B + 可选 A 做单侧 Kuhn 覆盖判定。搜索节点超限时
  // 保守返回 true（高估 ε——距离的保守口径）。
  const feasible = (eps: number): boolean => {
    const mustA: number[] = [];
    for (let i = 0; i < pointsA.length; i += 1) if (diag(pointsA[i]) > eps) mustA.push(i);
    const mustB: number[] = [];
    for (let j = 0; j < pointsB.length; j += 1) if (diag(pointsB[j]) > eps) mustB.push(j);
    if (mustA.length > pointsB.length || mustB.length > pointsA.length) return false;
    // 每个 mustA 的候选 B（ε 内）
    const domains = mustA
      .map((i) => ({
        i,
        cands: Array.from({ length: pointsB.length }, (_, j) => j).filter((j) => dist(pointsA[i], pointsB[j]) <= eps),
      }))
      .sort((a, b) => a.cands.length - b.cands.length);
    if (domains.some((d) => d.cands.length === 0)) return false;
    const usedB = new Set<number>();
    let budget = 200_000;
    const remainingMustBCoverable = (): boolean => {
      // 强制 A 未占用的强制 B，能否全部由可选 A 匹配（单侧 Kuhn：
      // 只迭代强制 B，可选 A 无约束 → 增广路正确）
      const freeA: number[] = [];
      for (let i = 0; i < pointsA.length; i += 1) if (!mustA.includes(i)) freeA.push(i);
      const matchOfA = new Map<number, number>();
      const tryMatch = (j: number, visited: Set<number>): boolean => {
        for (const i of freeA) {
          if (visited.has(i)) continue;
          if (dist(pointsA[i], pointsB[j]) > eps) continue;
          visited.add(i);
          const held = matchOfA.get(i);
          if (held === undefined || tryMatch(held, visited)) {
            matchOfA.set(i, j);
            return true;
          }
        }
        return false;
      };
      for (const j of mustB) {
        if (usedB.has(j)) continue;
        if (!tryMatch(j, new Set())) return false;
      }
      return true;
    };
    const rec = (k: number): boolean => {
      if (budget <= 0) return true; // 保守高估（距离上界口径）
      if (k === domains.length) return remainingMustBCoverable();
      const domain = domains[k];
      for (const j of domain.cands) {
        if (usedB.has(j)) continue;
        budget -= 1;
        usedB.add(j);
        if (rec(k + 1)) return true;
        usedB.delete(j);
      }
      return false;
    };
    return rec(0);
  };
  let lo = 0;
  let hi = sorted.length - 1;
  let best = sorted[hi] ?? 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (feasible(sorted[mid]!)) {
      best = sorted[mid]!;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return best;
}

/** 知识地形摘要（36.0 接线口径：孤岛 = 盲区的拓扑定义） */
export function topographyInsight(report: TopographyReport): string {
  const bigIslands = report.islands.filter((isl) => isl.members.length >= 2).length;
  const lonely = report.nodes - report.islands.reduce((s, isl) => s + isl.members.length, 0);
  return `${report.nodes} 节点 · 大陆 ${bigIslands} 块（成员 ≥2）· 孤岛成员 ${report.islands.filter((i) => i.members.length === 1).length} 个 · 合并带 p50=${report.landscape.p50.toFixed(2)}/p90=${report.landscape.p90.toFixed(2)}${lonely > 0 ? ` · 未入图 ${lonely}` : ''}`;
}

// ═══════════════════ R5 内核进化：H₁ 持续同调（代表圈）+ clearing 加速 ═══════════════════
//
// 旧→新: 36.0 只有 H₀（连通分量的生死）——看得见「几块大陆」，看不见「洞」。
// R5 补上 H₁（圈的生死 + 代表圈提取）:
//   · 复形口径: 输入边集视为 1-骨架，三角形 = 三边齐备的二元组全体（Vietoris–
//     Rips 截断到 dim ≤ 2 的相似度版本：ε 从 1 降到 floor，单纯形在 ε 越过
//     其权重时出现；三角形权重 = 三边最小权重——先出现的面先于余面，过滤合法）。
//   · 标准列消元（Edelsbrunner–Letscher–Zomorodian）: 边界矩阵按过滤序排列，
//     列从左到右消元，low(列) 配对 (birth, death)；H₁ 条 = (闭合成圈的边,
//     填死圈的三角形)，essential H₁ = 永不被填死的圈——跨尺度持久的洞，
//     知识地形第一次有了「洞的可定位成员」（代表圈的节点序列）。
//   · clearing 加速（Bauer–Kerber–Reininghaus）: H₀ 的负边（合并分量的边）
//     的配对由并查集直接给出（elder rule——合并时年轻分量的根即矩阵消元的
//     low），其列消元可整体跳过；三角列消元只与三角列碰撞（低维列的 low
//     是顶点，永远不可能等于三角列的 low（边）），矩阵配对不变——等价性
//     由 engine:'matrix'（朴素全矩阵消元）逐条对照验证。
//   · 代表圈: 正边（端点已连通的边）诞生 H₁ 类，其代表圈 = 诞生边 ⊕
//     合并边森林（H₀ 负边全体恰构成生成森林）上两端点的唯一路径——
//     生成林的基本圈（BFS 提取，邻接按过滤序插入 → 确定序）。

/** H₁ 持久条（一个圈从成形到被填死的完整档案） */
export interface H1Bar {
  /** 圈诞生：闭合成圈的边的相似度（ε 降到该值时圈成形；birth ≥ death——相似度口径下死亡在更低的 ε） */
  birth: number;
  /** 圈被填死：三角形三边最小权重（ε 再降到该值时洞被糊上）；essential 时 = floor */
  death: number;
  /** 是否存活到 floor（essential H₁ = 跨尺度持久的洞——真形状，不是噪声） */
  essential: boolean;
  /** 闭合成圈的边（端点 id） */
  bornAt: [string, string];
  /** 代表圈（节点 id 序列，首尾相接闭合成环；matrix 引擎给空数组——它只算条不追踪 V 列） */
  representative: string[];
  /** 填死该圈的三角形（顶点 id 三元组；essential 为 undefined） */
  killedBy: [string, string, string] | undefined;
}

export interface H1PersistenceOptions {
  /** 忽略 weight ≤ floor 的单纯形（与 h0Persistence 同口径；缺省 0） */
  floor?: number;
  /** 计算引擎：'clearing' = 并查集折叠（缺省）；'matrix' = 朴素全矩阵消元（等价性对照 + 计量口径） */
  engine?: 'clearing' | 'matrix';
  /** 三角形枚举上限（缺省 200000；超出显式 throw——枚举爆炸保护，与 tspExactOptimum 同哲学） */
  triangleLimit?: number;
}

export interface H1PersistenceReport {
  /** H₁ 持久条（birth 降序，平局按 bornAt 字典序——确定序） */
  bars: H1Bar[];
  /** essential H₀ 类数（过滤终点仍有几块大陆——与 h0Persistence().islands.length 互证） */
  beta0: number;
  finiteBars: number;
  essentialBars: number;
  /** 参与过滤的单纯形计数（Euler 特征量 χ = V − E + F 的原料） */
  simplexCounts: { vertices: number; edges: number; triangles: number };
  /** 列消元（对称差）次数——引擎间等价性的确定性计量（非墙钟；clearing 应 ≤ matrix） */
  reductionOps: number;
  engine: 'clearing' | 'matrix';
}

/** 过滤单纯形（dim ≤ 2；顶点权重 +∞ 最先出现） */
interface FiltrationSimplex {
  dim: 0 | 1 | 2;
  weight: number;
  /** 节点下标（升序填充，未用位补 −1） */
  ids: [number, number, number];
}

/** 降序整数数组的对称差（列消元的一步；返回仍降序） */
function xorDesc(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i]!;
    const y = b[j]!;
    if (x > y) {
      out.push(x);
      i += 1;
    } else if (x < y) {
      out.push(y);
      j += 1;
    } else {
      i += 1;
      j += 1;
    }
  }
  while (i < a.length) {
    out.push(a[i]!);
    i += 1;
  }
  while (j < b.length) {
    out.push(b[j]!);
    j += 1;
  }
  return out;
}

/**
 * 构造 VR(dim ≤ 2) 过滤：单纯形按（权重降序, 维数升序, 节点字典序）排列——
 * 平局确定性：同权重时面严格先于余面（三角形的权重 = 其最小边权重，
 * 该最小边必在同权重处先出现）。平行边取最大权重（先出现者生效）；
 * 自环剔除；weight ≤ floor 的单纯形不参与。
 */
function buildVrFiltration(
  nodes: ReadonlyArray<string>,
  edges: ReadonlyArray<{ source: string; target: string; weight: number }>,
  floor: number,
  triangleLimit: number,
): { simplices: FiltrationSimplex[]; names: string[] } {
  const names = [...nodes];
  const index = new Map<string, number>();
  names.forEach((nm, i) => index.set(nm, i));
  const n = names.length;
  // 边去重（取最大权重）+ 邻接表（三角形枚举）
  const bestEdge = new Map<number, number>(); // key = i*n + j (i<j) → weight
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    if (!index.has(e.source) || !index.has(e.target)) {
      throw new Error(`h1Persistence: 边端点不在节点表中（${e.source}–${e.target}）`);
    }
    if (!Number.isFinite(e.weight)) throw new Error('h1Persistence: 边权重须为有限数');
    if (e.source === e.target || e.weight <= floor) continue;
    const i = index.get(e.source)!;
    const j = index.get(e.target)!;
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    const key = a * n + b;
    const prev = bestEdge.get(key);
    if (prev === undefined) {
      bestEdge.set(key, e.weight);
      adj[a].push(b);
      adj[b].push(a);
    } else if (e.weight > prev) {
      bestEdge.set(key, e.weight);
    }
  }
  // 三角形：a < b < c，三边齐备；权重 = 三边最小（过滤序里面先于三角形）
  const triangles: FiltrationSimplex[] = [];
  for (const [key, wAb] of bestEdge) {
    const a = Math.floor(key / n);
    const b = key % n;
    const inA = new Set(adj[a]!);
    for (const c of adj[b]!) {
      if (c <= b || !inA.has(c)) continue;
      const wAc = bestEdge.get(Math.min(a, c) * n + Math.max(a, c))!;
      const wBc = bestEdge.get(Math.min(b, c) * n + Math.max(b, c))!;
      const w = Math.min(wAb, wAc, wBc);
      if (w > floor) triangles.push({ dim: 2, weight: w, ids: [a, b, c] });
    }
    if (triangles.length > triangleLimit) {
      throw new Error(`h1Persistence: 三角形数超过上限 ${triangleLimit}（提高 triangleLimit 或收窄 floor）——枚举爆炸保护`);
    }
  }
  const simplices: FiltrationSimplex[] = [];
  for (let i = 0; i < n; i += 1) simplices.push({ dim: 0, weight: Number.POSITIVE_INFINITY, ids: [i, -1, -1] });
  for (const [key, w] of bestEdge) {
    if (w > floor) simplices.push({ dim: 1, weight: w, ids: [Math.floor(key / n), key % n, -1] });
  }
  simplices.push(...triangles);
  const lex = (x: FiltrationSimplex, y: FiltrationSimplex): number => {
    for (let t = 0; t < 3; t += 1) {
      if (x.ids[t] !== y.ids[t]) return x.ids[t]! - y.ids[t]!;
    }
    return 0;
  };
  simplices.sort((x, y) => y.weight - x.weight || x.dim - y.dim || lex(x, y));
  return { simplices, names };
}

/**
 * H₁ 持续同调（精确小规模实现）：输入与 h0Persistence 同一口径的加权边集，
 * 输出每个圈的 (birth, death, 代表圈, 填死三角形) + essential H₀ 计数。
 *
 * clearing 引擎（缺省）: 并查集折叠给出 H₀ 配对（负边 = 合并边，配年轻根
 * ——elder rule 与矩阵消元 low 一致）；三角列只与三角列消元（低维列的 low
 * 不可能撞上）。代表圈 = 正边 ⊕ 森林路径（生成林基本圈）。
 * matrix 引擎: 朴素全矩阵消元（顶点/边/三角列全部照章消元）——只产出条
 * （不追踪 V 列故无代表圈），用于与 clearing 逐条对照（等价性证明的
 * 实证侧）与消元次数计量。
 */
export function h1Persistence(
  nodes: ReadonlyArray<string>,
  edges: ReadonlyArray<{ source: string; target: string; weight: number }>,
  options?: H1PersistenceOptions,
): H1PersistenceReport {
  if (nodes.length === 0) throw new Error('h1Persistence: 节点表非空必需');
  const floor = options?.floor ?? 0;
  if (!Number.isFinite(floor) || floor < 0) {
    throw new Error(`h1Persistence: floor 须为非负有限数（得到 ${String(floor)}）`);
  }
  const engine = options?.engine ?? 'clearing';
  if (engine !== 'clearing' && engine !== 'matrix') {
    throw new Error(`h1Persistence: engine ∈ {clearing, matrix}（得到 ${String(engine)}）`);
  }
  const triangleLimit = options?.triangleLimit ?? 200_000;
  if (!Number.isInteger(triangleLimit) || triangleLimit < 1) {
    throw new Error(`h1Persistence: triangleLimit 须为 ≥ 1 整数（得到 ${String(triangleLimit)}）`);
  }
  const { simplices, names } = buildVrFiltration(nodes, edges, floor, triangleLimit);
  const m = simplices.length;
  const edgeCount = simplices.filter((s) => s.dim === 1).length;
  const triCount = simplices.filter((s) => s.dim === 2).length;

  // 单纯形定位表（"dim:a:b:c" → 过滤序下标）
  const simplexId = new Map<string, number>();
  simplices.forEach((s, i) => simplexId.set(`${s.dim}:${s.ids[0]}:${s.ids[1]}:${s.ids[2]}`, i));
  const vertexKey = (v: number): number => simplexId.get(`0:${v}:-1:-1`) ?? -1;
  const edgeKey = (a: number, b: number): number => simplexId.get(`1:${Math.min(a, b)}:${Math.max(a, b)}:-1`) ?? -1;

  interface RawBar {
    birthSimplex: number;
    deathSimplex: number | undefined; // undefined = essential
  }
  let bars: RawBar[];
  let ops = 0;
  let beta0: number;

  if (engine === 'matrix') {
    // 朴素全矩阵消元: 顶点/边/三角列全部照章消元（等价性对照 + 计量口径）
    const facesOf = (s: FiltrationSimplex): number[] => {
      if (s.dim === 0) return [];
      if (s.dim === 1) return [vertexKey(s.ids[0]), vertexKey(s.ids[1])].sort((x, y) => y - x);
      return [edgeKey(s.ids[0], s.ids[1]), edgeKey(s.ids[0], s.ids[2]), edgeKey(s.ids[1], s.ids[2])].sort((x, y) => y - x);
    };
    const pivotRow = new Map<number, number>(); // 行号 → 持有该 low 的列
    const reduced: number[][] = [];
    bars = [];
    const barOf = new Map<number, RawBar>(); // birth 单纯形 → 条（死亡裁决用）
    for (let j = 0; j < m; j += 1) {
      let col = facesOf(simplices[j]!);
      while (col.length > 0) {
        const low = col[0]!;
        const owner = pivotRow.get(low);
        if (owner === undefined) {
          pivotRow.set(low, j);
          break;
        }
        col = xorDesc(col, reduced[owner]!);
        ops += 1;
      }
      reduced.push(col); // 空列 = 正单纯形（birth；是否 essential 由后续 pivot 裁决）
      if (col.length === 0) {
        const bar: RawBar = { birthSimplex: j, deathSimplex: undefined };
        bars.push(bar);
        barOf.set(j, bar);
      }
    }
    for (const [low, j] of pivotRow) {
      const bar = barOf.get(low);
      if (bar !== undefined) bar.deathSimplex = j; // 该 birth 死于列 j
      else bars.push({ birthSimplex: low, deathSimplex: j });
    }
    beta0 = countComponents(simplices);
  } else {
    // clearing 引擎: 并查集（不压缩）折叠 H₀ 负边 + 三角列消元
    const parent = Array.from({ length: nodes.length }, (_, i) => i);
    const size = new Array<number>(nodes.length).fill(1);
    const find = (x: number): number => {
      let r = x;
      while (parent[r] !== r) r = parent[r]!;
      return r;
    };
    bars = [];
    for (let i = 0; i < m; i += 1) {
      const s = simplices[i]!;
      if (s.dim !== 1) continue;
      const ra = find(s.ids[0]);
      const rb = find(s.ids[1]);
      if (ra === rb) {
        bars.push({ birthSimplex: i, deathSimplex: undefined }); // 正边（暂记 essential，由三角列裁决）
      } else if (size[ra] >= size[rb]) {
        parent[rb] = ra;
        size[ra] += size[rb];
      } else {
        parent[ra] = rb;
        size[rb] += size[ra];
      }
    }
    beta0 = 0;
    for (let v = 0; v < nodes.length; v += 1) if (find(v) === v) beta0 += 1;
    // 三角列消元（只与三角列碰撞——低维列的 low 是顶点，永不与三角列的 low（边）相撞）
    const pivotRow = new Map<number, number>();
    const reduced = new Map<number, number[]>(); // 三角形下标 → 消元后的列
    for (let j = 0; j < m; j += 1) {
      const s = simplices[j]!;
      if (s.dim !== 2) continue;
      let col = [edgeKey(s.ids[0], s.ids[1]), edgeKey(s.ids[0], s.ids[2]), edgeKey(s.ids[1], s.ids[2])].sort((x, y) => y - x);
      while (col.length > 0) {
        const low = col[0]!;
        const owner = pivotRow.get(low);
        if (owner === undefined) {
          pivotRow.set(low, j);
          const bar = bars.find((b) => b.birthSimplex === low && b.deathSimplex === undefined);
          if (bar === undefined) {
            throw new Error('h1Persistence: 内部不变量破坏（三角列 pivot 落在非正边上）——请回报');
          }
          bar.deathSimplex = j;
          break;
        }
        col = xorDesc(col, reduced.get(owner)!);
        ops += 1;
      }
      reduced.set(j, col);
    }
  }

  // 整理输出（只保留 dim 1 的 birth = H₁ 条）
  const outBars: H1Bar[] = [];
  for (const b of bars) {
    const birth = simplices[b.birthSimplex]!;
    if (birth.dim !== 1) continue;
    const deathW = b.deathSimplex === undefined ? floor : simplices[b.deathSimplex]!.weight;
    const tri = b.deathSimplex === undefined ? undefined : simplices[b.deathSimplex]!.ids;
    // 代表圈 = 诞生时刻的基本圈（合并边森林路径 ⊕ 诞生边）——有限条与 essential 条同口径
    const representative = engine === 'clearing' ? forestPathBfs(simplices, b.birthSimplex).map((idx) => names[idx]!) : [];
    outBars.push({
      birth: birth.weight,
      death: deathW,
      essential: b.deathSimplex === undefined,
      bornAt: [names[birth.ids[0]]!, names[birth.ids[1]]!],
      representative,
      killedBy: tri === undefined ? undefined : [names[tri[0]]!, names[tri[1]]!, names[tri[2]]!],
    });
  }
  outBars.sort(
    (x, y) =>
      y.birth - x.birth ||
      (x.bornAt[0] < y.bornAt[0] ? -1 : x.bornAt[0] > y.bornAt[0] ? 1 : 0) ||
      (x.bornAt[1] < y.bornAt[1] ? -1 : x.bornAt[1] > y.bornAt[1] ? 1 : 0) ||
      x.death - y.death,
  );
  return {
    bars: outBars,
    beta0,
    finiteBars: outBars.filter((b) => !b.essential).length,
    essentialBars: outBars.filter((b) => b.essential).length,
    simplexCounts: { vertices: nodes.length, edges: edgeCount, triangles: triCount },
    reductionOps: ops,
    engine,
  };
}

/**
 * 诞生边端点在「合并边森林」上的路径（代表圈的环身; 圈序 u→…→v，闭合边 = 诞生边）。
 *
 * 合并边（H₀ 负边）全体恰构成一张生成森林——正边端点在其分量内必有唯一
 * 路径。BFS 逐层扩展（邻接按过滤序插入 → 访问序确定）。注意不能用并查集
 * 的 parent 指针树直接读路径: 按大小挂树把远亲挂到根上, 指针树的边不是
 * 图的边（c→a 的指针实际对应合并边 (b,c) 经过的路径 c→b→a）。
 */
function forestPathBfs(simplices: readonly FiltrationSimplex[], birthSimplex: number): number[] {
  const birth = simplices[birthSimplex]!;
  const u = birth.ids[0];
  const v = birth.ids[1];
  let n = 0;
  for (const s of simplices) if (s.dim === 0) n += 1;
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < birthSimplex; i += 1) {
    const s = simplices[i]!;
    if (s.dim !== 1) continue;
    adj[s.ids[0]]!.push(s.ids[1]);
    adj[s.ids[1]]!.push(s.ids[0]);
  }
  const prev = new Array<number>(n).fill(-2); // -2 = 未达, -1 = 起点
  prev[u] = -1;
  const queue: number[] = [u];
  for (let head = 0; head < queue.length; head += 1) {
    const x = queue[head]!;
    if (x === v) break;
    for (const w of adj[x]!) {
      if (prev[w] !== -2) continue;
      prev[w] = x;
      queue.push(w);
    }
  }
  const path: number[] = [];
  for (let cur = v; cur !== -1; cur = prev[cur]!) path.push(cur); // v→u
  return path.reverse(); // u→…→v（闭合边 = 诞生边 (u,v)）
}

/** matrix 引擎的 β₀（过滤终点的连通分量数——重放并查集） */
function countComponents(simplices: readonly FiltrationSimplex[]): number {
  let n = 0;
  for (const s of simplices) if (s.dim === 0) n += 1;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    return r;
  };
  for (const s of simplices) {
    if (s.dim !== 1) continue;
    const ra = find(s.ids[0]);
    const rb = find(s.ids[1]);
    if (ra !== rb) parent[ra] = rb;
  }
  let c = 0;
  for (let v = 0; v < n; v += 1) if (find(v) === v) c += 1;
  return c;
}

/** 复形的 Betti 数与 Euler 特征量（threshold 口径：只统计 weight > threshold 的单纯形） */
export interface ComplexBettiReport {
  threshold: number;
  vertices: number;
  edges: number;
  faces: number;
  /** χ = V − E + F */
  chi: number;
  /** β₀：连通分量数（大陆数） */
  beta0: number;
  /** β₁：essential H₁ 数（洞数） */
  beta1: number;
  /** β₂ = χ − β₀ + β₁（dim ≤ 2 截断复形的诚实推论；应为 ≥ 0——负值即内部不变量破坏） */
  beta2: number;
}

/**
 * 截断复形（weight > threshold）的 Betti 数与 Euler 特征量。
 *
 * 一致性锚点: χ = V − E + F = β₀ − β₁ + β₂（Euler–Poincaré 公式）。
 * dim ≤ 2 截断复形的 β₂ 由 χ 反推（K4 的四张三角面无 3-单纯形填充时会
 * 出现 β₂ > 0 的诚实情形——截断口径的已知边界，不是错误）。
 */
export function complexBetti(
  nodes: ReadonlyArray<string>,
  edges: ReadonlyArray<{ source: string; target: string; weight: number }>,
  threshold = 0,
): ComplexBettiReport {
  const r = h1Persistence(nodes, edges, { floor: threshold });
  const { vertices, edges: e, triangles: f } = r.simplexCounts;
  const chi = vertices - e + f;
  const beta1 = r.essentialBars;
  const beta2 = chi - r.beta0 + beta1;
  return {
    threshold,
    vertices,
    edges: e,
    faces: f,
    chi,
    beta0: r.beta0,
    beta1,
    beta2,
  };
}
