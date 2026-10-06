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
 *   R5 第五轮进化（轴 1 数学）:
 *   - 读写法定人数: R+W>n 一致性定理的分析器（读写交集 = R+W−n，
 *     Dynamo 口径的强一致/最终一致判别）+ 随机读写序列的模拟试验；
 *   - 栅格法定人数: n=k² 的 Cheung 构造（quorum = 行∪列，2k−1 节点，
 *     两两交 ≥ 2，负载 (2k−1)/k² ≈ 2/√n ≪ 多数派 ≈ 1/2）——
 *     法定人数从默认值变成可设计的选择空间。
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
    ? `多数派两两相交（最小交集 ${audit.minIntersection}）：崩溃容错 ${audit.crashFaultTolerance}，拜占庭容错 ${audit.byzantineTolerance}，负载 ${(audit.load * 100).toFixed(0)}%`
    : 'n=1 单节点（无共识可验证）';
  return { ...audit, verdict };
}

// ═══════════════════ R5 第五轮进化：读法定人数 + 栅格法定人数 ═══════════════════

/** 读写法定人数审计（R/W quorum 口径；R5 数学进化） */
export interface ReadWriteQuorumAudit {
  nodes: number;
  /** 读法定人数大小 R */
  readQuorum: number;
  /** 写法定人数大小 W */
  writeQuorum: number;
  /** 读写一致性条件 R + W > n 是否成立 */
  consistent: boolean;
  /** R + W − n（每对读写法定人数的最小交集——读写一致的 slack） */
  overlap: number;
  /** 读可用容错 n − R（这么多个节点宕机仍可读） */
  readAvailability: number;
  /** 写可用容错 n − W */
  writeAvailability: number;
  /** 读负载 R/n */
  readLoad: number;
  /** 写负载 W/n */
  writeLoad: number;
  verdict: string;
}

/**
 * 读写法定人数分析器（R5 数学进化）。
 *
 * 读写一致性定理（可重述的多数派交集）: 写者写 W 个节点、读者读 R 个
 * 节点，读者**必然**看到最新写 ⟺ R + W > n——因为任何 R 子集与任何
 * W 子集的交集 ≥ R + W − n（容斥原理）；R + W ≤ n 时存在不相交的
 * 读/写集合——读者可被完全欺骗。这是 Dynamo/Quorum 读写的数学心脏：
 *   R + W > n ⟹ 强一致（读写交集非空）
 *   R + W ≤ n ⟹ 允许读到陈旧值（交集可为空，非错误而是口径）
 * 与「法定人数系统的优化设计空间」：R = n、W = 1（写一次读全部）
 * 或 R = W = ⌊n/2⌋+1（多数派/majority）是同一条件下的两个极端。
 */
export function readWriteQuorumAudit(n: number, readQuorum: number, writeQuorum: number): ReadWriteQuorumAudit {
  const nodes = Math.floor(n);
  const r = Math.floor(readQuorum);
  const w = Math.floor(writeQuorum);
  if (nodes < 1) throw new Error('readWriteQuorumAudit: n ≥ 1');
  if (r < 1 || r > nodes) throw new Error(`readWriteQuorumAudit: R ∈ [1, n]（收到 ${readQuorum}）`);
  if (w < 1 || w > nodes) throw new Error(`readWriteQuorumAudit: W ∈ [1, n]（收到 ${writeQuorum}）`);
  const overlap = r + w - nodes;
  const consistent = overlap >= 1;
  return {
    nodes,
    readQuorum: r,
    writeQuorum: w,
    consistent,
    overlap: Math.max(0, overlap),
    readAvailability: nodes - r,
    writeAvailability: nodes - w,
    readLoad: r / nodes,
    writeLoad: w / nodes,
    verdict: consistent
      ? `R+W = ${r}+${w} = ${r + w} > ${nodes}：读写交集 ≥ ${overlap}，读者必然命中最新写（强一致）`
      : `R+W = ${r}+${w} = ${r + w} ≤ ${nodes}：存在不相交的读/写集合——允许读到陈旧值（最终一致口径）`,
  };
}

/** 栅格法定人数报告（grid quorum；R5 数学进化） */
export interface GridQuorumReport {
  /** 节点总数 n = k² */
  nodes: number;
  /** 栅格边长 k = √n */
  side: number;
  /** 法定人数大小 = 2k − 1（一行 ∪ 一列） */
  quorumSize: number;
  /** 两两最小交集（构造证明：不同行列的两个 quorum 交于 2 个节点） */
  minIntersection: number;
  /** 策略负载（均匀选 quorum 口径）：max 节点被选概率 = (2k−1)/k² */
  load: number;
  /** 与多数派负载 (⌊n/2⌋+1)/n 的比值（< 1 = 更省） */
  loadVsMajority: number;
  /** 构造合法性（n 为完全平方数且 k ≥ 2） */
  valid: boolean;
  /** 全部 quorum（行 i ∪ 列 j；k² 个，按 (i,j) 行主序）——位掩码口径 */
  quorums: number[];
  verdict: string;
}

/**
 * 栅格法定人数构造（grid quorum；R5 数学进化）。
 *
 * n = k² 个节点排成 k×k 栅格，法定人数 = Q(i,j) = 第 i 行 ∪ 第 j 列
 * （|Q| = 2k−1，中心 (i,j) 只计一次）。Cheung–MacGregor–Kannan 构造：
 *   两两相交（构造证明）: Q(i,j) ∩ Q(i',j') ⊇ {(i,j'), (i',j)}——
 *     i≠i' 且 j≠j' 时交集恰为 2；同行（或同列）时交出整行 k 个；
 *   负载（Naor–Wool 口径）: 节点 (i,j) 属于第 i 行的全部 k 个 quorum
 *     与第 j 列的全部 k 个 quorum、中心重复计 1——恰 (2k−1)/k² 个，
 *     均匀策略下 load = (2k−1)/k² ≈ 2/√n ≪ 多数派的 ≈ 1/2——
 *     大集群下读放大从 n/2 降到 2√n（数量级改进，代价是容错结构
 *     从「任意 f < n/2」弱化为策略相关——诚实给出）。
 * 与 46.0 多数派的关系：多数派是「负载最差的通用构造」，栅格是
 * 「负载换容错形状」的第一个非平凡设计点——法定人数系统从此是
 * 可选择的设计空间，不是一个默认值。
 */
export function gridQuorumAudit(n: number): GridQuorumReport {
  const nodes = Math.floor(n);
  const side = Math.round(Math.sqrt(nodes));
  const valid = side * side === nodes && side >= 2;
  if (!valid) throw new Error(`gridQuorumAudit: n 须为完全平方数 k²（k ≥ 2，收到 ${n}）`);
  const quorumSize = 2 * side - 1;
  // 全部 k² 个 quorum 的位掩码（Q(i,j) = 行 i ∪ 列 j）
  const quorums: number[] = [];
  for (let i = 0; i < side; i += 1) {
    for (let j = 0; j < side; j += 1) {
      let mask = 0;
      for (let c = 0; c < side; c += 1) mask |= 1 << (i * side + c); // 行 i
      for (let r2 = 0; r2 < side; r2 += 1) mask |= 1 << (r2 * side + j); // 列 j
      quorums.push(mask);
    }
  }
  // 闭式负载：每节点恰在 2k−1 个 quorum 中（k 个含其行 + k 个含其列 − 1 重复）
  const load = quorumSize / nodes;
  const majorityLoad = (Math.floor(nodes / 2) + 1) / nodes;
  return {
    nodes,
    side,
    quorumSize,
    minIntersection: 2,
    load,
    loadVsMajority: load / majorityLoad,
    valid,
    quorums,
    verdict: `栅格 ${side}×${side}：quorum = 行∪列（${quorumSize} 节点），两两交 ≥ 2，负载 ${(load * 100).toFixed(1)}%（多数派 ${(majorityLoad * 100).toFixed(1)}% 的 ${(load / majorityLoad).toFixed(2)} 倍）`,
  };
}

/**
 * 读写一致性单次试验（R5 性质测试锚点；确定性——rng 由调用方注入）。
 *
 * 模拟一次「写后读」：写者向随机 W 节点写入版本号 v+1，读者从随机
 * R 节点读版本。R+W>n 时读到的最大版本必然 = 最新版本（交集定理的
 * 实验读数）；R+W≤n 时存在读到旧版本的可能。纯组合模拟、无 I/O。
 */
export function rwConsistencyTrial(
  n: number,
  readQuorum: number,
  writeQuorum: number,
  rng: () => number,
): { staleRead: boolean; observedVersion: number; latestVersion: number } {
  const nodes = Math.floor(n);
  const r = Math.floor(readQuorum);
  const w = Math.floor(writeQuorum);
  if (nodes < 1 || r < 1 || r > nodes || w < 1 || w > nodes) {
    throw new Error('rwConsistencyTrial: 1 ≤ R, W ≤ n');
  }
  const versions = new Array<number>(nodes).fill(0);
  const pick = (k: number): number[] => {
    const pool = Array.from({ length: nodes }, (_, i) => i);
    for (let i = 0; i < k; i += 1) {
      const j = i + Math.floor(rng() * (nodes - i));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    return pool.slice(0, k);
  };
  let latest = 0;
  for (const idx of pick(w)) {
    versions[idx] = latest + 1;
  }
  latest += 1;
  let observed = 0;
  for (const idx of pick(r)) {
    observed = Math.max(observed, versions[idx]!);
  }
  return { staleRead: observed < latest, observedVersion: observed, latestVersion: latest };
}
