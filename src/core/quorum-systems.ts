/**
 * 46.0 法定人数内核 —— Quorum 交叉 + 拜占庭口径 + 负载：共识安全性可检查
 *
 * 动机: Raft 的安全性靠「多数派两两相交」这条组合性质——但它从未被
 * 系统检查过，只是被相信。法定人数系统（quorum systems）把共识安全
 * 变成可验证的组合对象:
 *
 *   交叉性质: 任意两个法定人数相交 ⟹ 读到的写者集合非空
 *   （一致性）。多数派 quorum 交 |V|/2（崩溃容错 f < n/2 的根源）。
 *
 *   拜占庭口径: 任意两个 quorum 相交于 ≥ f+1 个节点 ⟹ 交集含至少
 *   一个诚实节点（谎言无法同时骗过两个 quorum）——Q² 系统
 *   （n > 3f 时的经典构造）。f ≥ n/3 时不存在这样的系统——
 *   「3f+1 下界」不是工程建议，是不存在性定理。
 *
 *   负载 (Naor–Wool): 系统负载 L = max_Q |Q|/n——读放大的稳态代价；
 *   多数派系统 L = (⌊n/2⌋+1)/n，值得知道而非接受。
 *
 *   验证锚点: 多数派两两相交（枚举）、奇偶 n 的界、拜占庭 n>3f 可行/
 *   n≤3f 不可行的判别、负载闭式。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

export interface QuorumAudit {
  nodes: number;
  /** 法定人数大小（多数派口径 ⌊n/2⌋+1） */
  quorumSize: number;
  /** 容错上界 f = quorumSize − 1（崩溃口径：非交集部分全坏仍安全） */
  crashFaultTolerance: number;
  /** 两两 quorum 的最小交集大小 */
  minIntersection: number;
  /** 交集性质是否成立 */
  intersects: boolean;
  /** 拜占庭口径：最小交集 ≥ f_byz+1 所容许的最大 f_byz */
  byzantineTolerance: number;
  /** 系统负载 max|Q|/n（多数派闭式） */
  load: number;
}

/**
 * 多数派法定人数审计（n ≥ 1）。
 *
 * minIntersection = 2q − n（q = ⌊n/2⌋+1）；拜占庭容错 = minIntersection−1
 * （交集 ≥ f+1 ⟺ f ≤ 交−1）；n ≤ 3f ⟹ 拜占庭容错 < f——诚实给出。
 */
export function majorityQuorumAudit(n: number): QuorumAudit {
  const nodes = Math.floor(n);
  if (nodes < 1) throw new Error('majorityQuorumAudit: n ≥ 1');
  const quorumSize = Math.floor(nodes / 2) + 1;
  const minIntersection = 2 * quorumSize - nodes;
  const crashFaultTolerance = quorumSize - 1;
  const byzantineTolerance = Math.max(0, minIntersection - 1);
  return {
    nodes,
    quorumSize,
    crashFaultTolerance,
    minIntersection,
    intersects: minIntersection >= 1,
    byzantineTolerance,
    load: quorumSize / nodes,
  };
}

/** 枚举所有 ⌊n/2⌋+1 子集的两两最小交集（验证锚点；n ≤ 15 适用） */
export function bruteForceMinIntersection(n: number, quorumSize = Math.floor(n / 2) + 1): number {
  const subsets: number[] = [];
  const combo: number[] = [];
  const rec = (start: number): void => {
    if (combo.length === quorumSize) {
      subsets.push(combo.reduce((mask, i) => mask | (1 << i), 0));
      return;
    }
    for (let i = start; i < n; i += 1) {
      combo.push(i);
      rec(i + 1);
      combo.pop();
    }
  };
  rec(0);
  let min = Infinity;
  for (let a = 0; a < subsets.length; a += 1) {
    for (let b = a + 1; b < subsets.length; b += 1) {
      const inter = popcount(subsets[a] & subsets[b]);
      if (inter < min) min = inter;
    }
  }
  return min;
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c += 1;
  }
  return c;
}

/**
 * 拜占庭可行性判别（n > 3f 存在性口径）：给定 n 与目标拜占庭容错 f，
 * 最优 quorum 构造 q = ⌈(n+f+1)/2⌉ 是否给出 ≥ f+1 交集——n ≥ 3f+1
 * 时可行（经典构造）；n ≤ 3f 时诚实 false——3f+1 下界（不存在性定理，
 * 换任何 quorum 系统都救不了）。
 */
export function byzantineFeasible(n: number, f: number): boolean {
  if (f < 1 || n < 3 * f + 1) return false;
  const q = Math.ceil((n + f + 1) / 2);
  if (q > n) return false;
  return 2 * q - n >= f + 1;
}

/**
 * Raft 集群安全审计（46.0 接线口径，纯读取）。
 *
 * members: 集群节点数（Raft 配置口径）；产出多数派交叉、容错上界与
 * 负载——共识安全性从「被相信」升级为「被检查」。
 */
export function raftSafetyAudit(members: number): QuorumAudit & { verdict: string } {
  const audit = majorityQuorumAudit(members);
  const verdict = audit.intersects
    ? `多数派两两相交（最小交集 ${audit.minIntersection}）：崩溃容错 ${audit.crashFaultTolerance}，拜占庭容错 ${audit.byzantineTolerance}${members <= 3 * audit.byzantineTolerance + 1 && audit.byzantineTolerance > 0 ? '' : ''}，负载 ${(audit.load * 100).toFixed(0)}%`
    : 'n=1 单节点（无共识可验证）';
  return { ...audit, verdict };
}
