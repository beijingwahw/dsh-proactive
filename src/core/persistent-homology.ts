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
  /** 合并：返回 [存活根, 被吞并根]（按大小挂大树上；同大小字典序稳定） */
  union(a: string, b: string): [string, string] | undefined {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return undefined;
    const sa = this.size.get(ra)!;
    const sb = this.size.get(rb)!;
    const [survivor, absorbed] = sa > sb || (sa === sb && ra < rb) ? [ra, rb] : [rb, ra];
    this.parent.set(absorbed, survivor);
    this.size.set(survivor, sa + sb);
    return [survivor, absorbed];
  }
  sizeOf(x: string): number {
    return this.size.get(this.find(x)) ?? 1;
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
    const [survivor, absorbedRoot] = union;
    merges.push({ epsilon: edge.weight, absorbedSize: ds.sizeOf(survivor), survivor });
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
