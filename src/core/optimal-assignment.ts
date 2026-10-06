/**
 * 32.0 全局指派内核 —— 匈牙利算法（Kuhn–Munkres）：批内全局最优匹配 + 对偶证书
 *
 * 动机: 计划执行按「就绪层」分批并行，批内每个节点各自调用调度器选型——
 * **逐节点贪心**。三个同层节点都看到「模型 A 最优」，就都拿 A：最优模型
 * 被超订（并发挤兑）、次优模型闲置，批的总质量/成本是局部视角的拼贴。
 * 线性和指派问题（LSAP）问的是全局:
 *
 *   max Σ_i P_{i,σ(i)}   （批内节点 i 指派给模型 σ(i)，互不冲突）
 *
 *   匈牙利算法在 O(n³) 内**精确**求解（Kuhn 1955 / Munkres 1957；
 *   Jonker–Volgenant 最短增广路 + 位势实现）。贪心没有任何近似比——
 *   反例可以任意坏（所有节点挤同一个模型）；精确解自带最优性。
 *
 *   证明携带（与 15.0 同一哲学）: 算法维护 LP 对偶位势 (u, v) 满足
 *     u_i + v_j ≤ c_ij（对偶可行性）且匹配边上 u_i + v_j = c_ij（互补松弛）
 *   → 弱对偶: 任意可行指派成本 ≥ Σu + Σv = 本算法成本 —— **对偶证书**。
 *   验证脚本逐位断言对偶可行性，最优性不靠信任，靠检查。
 *
 *   语义: 批量分配是「一次装袋」而不是「逐个抢座位」——同一批任务在
 *   模型组合上的总收益先全局最优，再谈个体；模型并发容量、批质量、
 *   调度评分全部进入收益矩阵，一视同仁。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致（逐节点贪心原样）。
 */

export interface AssignmentResult {
  /** row → col（-1 = 未指派，行数超过列数时剩余行留给原路径） */
  assignment: number[];
  /** 指派边的代价总和（min 口径） */
  totalCost: number;
  rows: number;
  cols: number;
  /** 对偶位势（互补松弛证书的原料；undefined = 未求解对偶） */
  dual?: { u: number[]; v: number[] };
}

export interface AssignmentCertificate {
  /** 对偶可行性：∀i,j u_i + v_j ≤ c_ij + tol */
  dualFeasible: boolean;
  /** 互补松弛：匹配边 u_i + v_j = c_ij（±tol） */
  complementarySlackness: boolean;
  /** 弱对偶间隙（应为 0：Σu + Σv = 指派成本） */
  dualityGap: number;
  /** 证书成立 = 指派最优性被证明 */
  optimal: boolean;
  maxConstraintViolation: number;
}

/**
 * 线性和指派（最小化）——Jonker–Volgenant 风格 O(n³)。
 *
 * cost 为 rows × cols 矩阵（rows ≤ cols 直接解；rows > cols 自动转置后
 * 原地还原）。空矩阵 / 零行零列安全返回。非有限代价显式 throw（R5: 原来
 * 静默产出垃圾对偶，现在诚实拒绝）。
 */
export function solveAssignment(cost: ReadonlyArray<ReadonlyArray<number>>): AssignmentResult {
  if (cost.length === 0 || cost[0].length === 0) {
    return { assignment: [], totalCost: 0, rows: cost.length, cols: cost[0]?.length ?? 0 };
  }
  const n = cost.length;
  const m = cost[0].length;
  for (const row of cost) if (row.length !== m) throw new Error('solveAssignment: 代价矩阵必须为矩形');
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      if (!Number.isFinite(cost[i][j])) throw new Error(`solveAssignment: cost[${i}][${j}]=${String(cost[i][j])} 必须为有限数（禁边请用 solveAssignmentSparse）`);
    }
  }

  const transposed = n > m;
  const R = transposed ? m : n; // 行数（少的维度）
  const C = transposed ? n : m; // 列数（多的维度）
  const c = (i: number, j: number): number => (transposed ? cost[j][i] : cost[i][j]);

  // 1-indexed JV 位势法（u[0] 行位势 / v[0] 列位势；p[j] = 匹配到列 j 的行）
  const u = new Array<number>(R + 1).fill(0);
  const v = new Array<number>(C + 1).fill(0);
  const p = new Array<number>(C + 1).fill(0);
  const way = new Array<number>(C + 1).fill(0);

  for (let i = 1; i <= R; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(C + 1).fill(Infinity);
    const used = new Array<boolean>(C + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= C; j += 1) {
        if (used[j]) continue;
        const cur = c(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      if (!Number.isFinite(delta)) break; // 剩余列全被用过（理论不达；防御）
      for (let j = 0; j <= C; j += 1) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  // colOfRow[i] = 列（0-based；-1 = 未指派）
  const colOfRow = new Array<number>(R).fill(-1);
  for (let j = 1; j <= C; j += 1) {
    if (p[j] > 0) colOfRow[p[j] - 1] = j - 1;
  }
  let totalCost = 0;
  for (let i = 0; i < R; i += 1) {
    if (colOfRow[i] >= 0) totalCost += c(i, colOfRow[i]);
  }

  // 对偶位势还原到原坐标系。
  // 直接情形: u（行位势）= u[1..R]，v（列位势）= v[1..C]，满足 u_i + v_j ≤ c_ij。
  // 转置情形（原行数 > 列数，求解的是 c' = cᵀ）: 约束 u'_{k+1} + v'_{r+1} ≤ c(r,k)
  //   → 原行位势 U[r] = v'[r+1]，原列位势 V[k] = u'[k+1]。
  let dualU: number[];
  let dualV: number[];
  if (transposed) {
    dualU = v.slice(1, n + 1);
    dualV = u.slice(1, m + 1);
  } else {
    dualU = u.slice(1, R + 1);
    dualV = v.slice(1, C + 1);
  }

  // 还原到原坐标系（转置情形: 原 rows = C 列 → 行位势取 v，列位势取 u）
  const assignment = new Array<number>(n).fill(-1);
  if (transposed) {
    for (let i = 0; i < R; i += 1) assignment[colOfRow[i]] = i;
  } else {
    for (let i = 0; i < R; i += 1) assignment[i] = colOfRow[i];
  }

  return {
    assignment,
    totalCost,
    rows: n,
    cols: m,
    dual: { u: dualU, v: dualV },
  };
}

/** 最大化指派（收益矩阵 → 取负 → 最小化）。
 *
 * 返回的 dual 为**最大化口径**证书：u_i + v_j ≥ p_ij 对一切 (i,j) 成立、
 * 匹配边上取等（弱对偶：任意指派的收益 ≤ Σu + Σv = 本解收益）。
 * 最小化口径的 assignmentCertificate 请与 solveAssignment 配套使用。
 */
export function solveAssignmentMax(profit: ReadonlyArray<ReadonlyArray<number>>): AssignmentResult & { totalProfit: number } {
  const neg = profit.map((row) => row.map((x) => -x));
  const result = solveAssignment(neg);
  return { ...result, totalCost: -result.totalCost, dual: result.dual ? { u: result.dual.u.map((x) => -x), v: result.dual.v.map((x) => -x) } : undefined, totalProfit: -result.totalCost };
}

/**
 * 对偶证书检查（证明携带）:
 *   可行 ∀i,j: u_i + v_j ≤ c_ij + tol；松弛：匹配边等号；间隙 = |Σu+Σv−成本|。
 * 三项全过 → optimal = true：本次指派的最优性被数学证明，而非被声称。
 */
export function assignmentCertificate(
  cost: ReadonlyArray<ReadonlyArray<number>>,
  result: AssignmentResult,
  tol = 1e-6,
): AssignmentCertificate {
  const { assignment, dual } = result;
  if (!dual) {
    return { dualFeasible: false, complementarySlackness: false, dualityGap: Infinity, optimal: false, maxConstraintViolation: Infinity };
  }
  const n = cost.length;
  let maxViolation = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < cost[i].length; j += 1) {
      const slack = dual.u[i] + dual.v[j] - cost[i][j];
      if (slack > tol) maxViolation = Math.max(maxViolation, slack);
    }
  }
  let slackViolation = 0;
  let dualSum = 0;
  let primalSum = 0;
  for (let i = 0; i < n; i += 1) {
    dualSum += dual.u[i];
    const j = assignment[i];
    if (j === undefined || j < 0) continue;
    primalSum += cost[i][j];
    slackViolation = Math.max(slackViolation, Math.abs(dual.u[i] + dual.v[j] - cost[i][j]));
  }
  for (let j = 0; j < dual.v.length; j += 1) dualSum += dual.v[j];
  const gap = Math.abs(dualSum - primalSum);
  const dualFeasible = maxViolation <= tol;
  const complementarySlackness = slackViolation <= tol;
  return {
    dualFeasible,
    complementarySlackness,
    dualityGap: gap,
    optimal: dualFeasible && complementarySlackness && gap <= tol * Math.max(1, n),
    maxConstraintViolation: maxViolation,
  };
}

/** 穷举最优（验证锚点；n ≤ 8 适用，排列枚举） */
export function bruteForceAssignment(cost: ReadonlyArray<ReadonlyArray<number>>): { assignment: number[]; totalCost: number } {
  const n = cost.length;
  const m = n > 0 ? cost[0].length : 0;
  if (n === 0 || m === 0) return { assignment: [], totalCost: 0 };
  if (n > m) throw new Error('bruteForceAssignment: 仅支持 rows ≤ cols');
  let best: number[] = [];
  let bestCost = Infinity;
  const perm: number[] = [];
  const used = new Array<boolean>(m).fill(false);
  const rec = (): void => {
    if (perm.length === n) {
      let c = 0;
      for (let i = 0; i < n; i += 1) c += cost[i][perm[i]];
      if (c < bestCost) {
        bestCost = c;
        best = [...perm];
      }
      return;
    }
    for (let j = 0; j < m; j += 1) {
      if (used[j]) continue;
      used[j] = true;
      perm.push(j);
      rec();
      perm.pop();
      used[j] = false;
    }
  };
  rec();
  return { assignment: best, totalCost: bestCost };
}

/**
 * 批内收益矩阵 → 全局指派（32.0 接线辅助）。
 *
 * profit[i][j] = 节点 i 给模型 j 的调度评分；返回 节点 → 模型 指派
 * （未覆盖节点返回 -1，交还逐节点原路径——行数超过列数时的诚实降级）。
 */
export function assignBatch(profit: ReadonlyArray<ReadonlyArray<number>>): { modelOfNode: number[]; totalProfit: number } {
  if (profit.length === 0) return { modelOfNode: [], totalProfit: 0 };
  const result = solveAssignmentMax(profit);
  return { modelOfNode: result.assignment, totalProfit: result.totalProfit };
}

// ══════════════════════ R5 进化（第五轮·世界性进化） ══════════════════════
//
// 轴 1（数学）: 稀疏线性和指派（结构性禁边的新问题类）。
//   调度的真实形态不是满矩阵——节点 i 只对模型子集 J(i) 有评分（其余
//   「不可派」= 代价 +∞）。稠密口径只能用大 M 填充伪装禁边（M 要足够大
//   才不改变最优解，且 O(n³) 照付全矩阵）; 稀疏口径把 LP
//     min Σ c_ij x_ij  s.t.  Σ_j∈J(i) x_ij = 1 ∀i,  Σ_i∈I(j) x_ij ≤ 1 ∀j, x ≥ 0
//   的**结构**交给算法: JV 最短增广路的 Dijkstra 只扫邻接表（每行 O(deg)
//   次代价比较而非 O(cols)），位势 (u,v) 仍满足对偶可行性 u_i + v_j ≤ c_ij
//   （仅在允许边上约束——禁边上无约束，恰是该 LP 的对偶形状）与互补松弛
//   → 完美匹配存在时解精确最优，证书在「允许边 + M 填充」矩阵上照常成立。
//
// 轴 2（性能）: 稀疏 JV 的增广只经过允许边——稠密 M 填充 Hungarian 的
//   O(n³) 与稀疏度无关，稀疏版在 |E| ≪ n² 时快一个量级（大规模随机
//   实例耗时对照 + 同解等价证明，验证脚本消费）。
//
// 轴 4（性质）: 完美匹配性（Hall 定理的构造性检查）——先跑 Kuhn 增广路
//   求最大基数匹配，最大基数 < min(rows, cols) ⟹ 显式 throw（缺口数即
//   Hall 缺口），绝不静默返回残缺指派; 种子化 ≥200 随机实例（置换嵌入
//   保证完美匹配 + 随机加边）全部行行有派、列不冲突、成本 = 稠密最优。
// ══════════════════════════════════════════════════════════

/** 稀疏指派条目（row→col 的允许边与代价; 未列出的 (i,j) = 禁边 +∞） */
export interface SparseAssignmentEntry {
  row: number;
  col: number;
  cost: number;
}

/** 稀疏指派结果 */
export interface SparseAssignmentResult {
  /** row → col（rows ≤ cols 时行行有派; rows > cols 时多余行 −1） */
  assignment: number[];
  totalCost: number;
  rows: number;
  cols: number;
  /** 允许边数 |E|（稀疏度口径） */
  entries: number;
  /** Kuhn 最大基数匹配的匹配数（= min(rows, cols)，否则已 throw） */
  matchingSize: number;
  /** JV 主循环处理行时 Dijkstra 扫过的邻接条目总数（工作量审计） */
  scannedEntries: number;
}

/**
 * 最大基数二部匹配（Kuhn 增广路，O(V·E)）——稀疏指派的 Hall 可行性检查:
 * 返回 (rowOfCol)，匹配数 < 目标 ⟹ 无完美匹配（Hall 缺口 = 目标 − 匹配数）。
 */
function kuhnMaxMatching(R: number, C: number, adjByRow: ReadonlyArray<ReadonlyArray<number>>): { rowOfCol: Int32Array; size: number } {
  const rowOfCol = new Int32Array(C + 1).fill(0); // 1-indexed 行; 0 = 未匹配
  const visited: Uint8Array = new Uint8Array(C + 1);
  const tryAugment = (i: number): boolean => {
    for (const j of adjByRow[i - 1]) {
      if (visited[j] === 1) continue;
      visited[j] = 1;
      if (rowOfCol[j] === 0 || tryAugment(rowOfCol[j])) {
        rowOfCol[j] = i;
        return true;
      }
    }
    return false;
  };
  let size = 0;
  for (let i = 1; i <= R; i += 1) {
    visited.fill(0);
    if (tryAugment(i)) size += 1;
  }
  return { rowOfCol, size };
}

/**
 * 稀疏线性和指派（最小化）——JV 最短增广路的邻接表版本。
 *
 * rows × cols 的问题只允许 entries 列出的边（其余 = 禁边）; rows > cols
 * 自动转置后映射回原坐标。先做 Hall 检查（无完美匹配 → 显式 throw），
 * 再跑位势法: 每行的 Dijkstra 只扫该行的邻接表，u/v 在允许边上维持
 * u_i + v_j ≤ c_ij 与互补松弛（对偶证书与稠密版同构）。
 */
export function solveAssignmentSparse(
  rows: number,
  cols: number,
  entries: ReadonlyArray<SparseAssignmentEntry>,
): SparseAssignmentResult {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 0 || cols < 0) {
    throw new Error(`solveAssignmentSparse: rows=${String(rows)} / cols=${String(cols)} 需为非负整数`);
  }
  if (!Array.isArray(entries)) throw new Error('solveAssignmentSparse: entries 需为数组');
  if (rows === 0 || cols === 0) {
    return { assignment: new Array<number>(rows).fill(-1), totalCost: 0, rows, cols, entries: entries.length, matchingSize: 0, scannedEntries: 0 };
  }
  const seen = new Set<number>();
  for (let k = 0; k < entries.length; k += 1) {
    const e = entries[k];
    if (e === null || typeof e !== 'object' || !Number.isInteger(e.row) || !Number.isInteger(e.col) || !Number.isFinite(e.cost)) {
      throw new Error(`solveAssignmentSparse: entries[${k}] 需为 { row, col, cost: finite }`);
    }
    if (e.row < 0 || e.row >= rows || e.col < 0 || e.col >= cols) {
      throw new Error(`solveAssignmentSparse: entries[${k}] (${e.row}, ${e.col}) 越界（${rows}×${cols}）`);
    }
    const key = e.row * cols + e.col;
    if (seen.has(key)) throw new Error(`solveAssignmentSparse: 重复边 (${e.row}, ${e.col})`);
    seen.add(key);
  }

  // 转置口径: 行 = 少的一侧（与稠密版一致）
  const transposed = rows > cols;
  const R = transposed ? cols : rows;
  const C = transposed ? rows : cols;
  // 邻接表成对数组（行 i 的允许列 j 与代价对齐存放——热循环零哈希查找）
  const adjJ: number[][] = Array.from({ length: R }, () => []);
  const adjC: number[][] = Array.from({ length: R }, () => []);
  for (const e of entries) {
    const i = transposed ? e.col : e.row; // 0-indexed 求解行
    const j = transposed ? e.row : e.col; // 0-indexed 求解列
    adjJ[i].push(j + 1);
    adjC[i].push(e.cost);
  }

  // Hall 检查: 无完美匹配诚实 throw（缺口数 = Hall 缺口）
  const { rowOfCol, size } = kuhnMaxMatching(R, C, adjJ);
  if (size < R) {
    throw new Error(`solveAssignmentSparse: 无完美匹配（最大基数 ${size} < ${R}，Hall 缺口 ${R - size}）——允许边结构不支持行行有派`);
  }

  // JV 位势法（稀疏 Dijkstra: 只扫当前行 i₀ = p[j₀] 的邻接表）
  const u = new Array<number>(R + 1).fill(0);
  const v = new Array<number>(C + 1).fill(0);
  const p = new Array<number>(C + 1).fill(0);
  const way = new Array<number>(C + 1).fill(0);
  let scanned = 0;

  for (let i = 1; i <= R; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(C + 1).fill(Infinity);
    const used = new Array<boolean>(C + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      const nbrs = adjJ[i0 - 1];
      const nbrsCost = adjC[i0 - 1];
      scanned += nbrs.length;
      const ui0 = u[i0];
      for (let k = 0; k < nbrs.length; k += 1) {
        const j = nbrs[k];
        if (used[j]) continue;
        const cur = nbrsCost[k] - ui0 - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
      }
      for (let j = 1; j <= C; j += 1) {
        if (used[j]) continue;
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      if (!Number.isFinite(delta)) throw new Error('solveAssignmentSparse: 增广路被阻断（Hall 检查已过——内部一致性错误）');
      for (let j = 0; j <= C; j += 1) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  // 还原到原坐标系（转置情形: 求解行 = 原列、求解列 = 原行）
  const assignment = new Array<number>(rows).fill(-1);
  let totalCost = 0;
  for (let j = 1; j <= C; j += 1) {
    if (p[j] > 0) {
      const solveRow = p[j] - 1; // 0-indexed
      const solveCol = j - 1;
      const originalRow = transposed ? solveCol : solveRow;
      const originalCol = transposed ? solveRow : solveCol;
      assignment[originalRow] = originalCol;
      const nbrs = adjJ[solveRow];
      const nbrsCost = adjC[solveRow];
      for (let k = 0; k < nbrs.length; k += 1) {
        if (nbrs[k] === j) totalCost += nbrsCost[k];
      }
    }
  }
  return { assignment, totalCost, rows, cols, entries: entries.length, matchingSize: size, scannedEntries: scanned };
}
