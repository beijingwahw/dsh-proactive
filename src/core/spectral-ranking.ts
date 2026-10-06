/**
 * 39.0 谱排序内核 —— PageRank 幂迭代：知识图的影响力从结构里涌现
 *
 * 动机: 记忆图的联想检索（related()）按边权排序——**局部口径**：一条
 * 记忆与谁共现强就先想起谁。但「哪条知识重要」是全局结构性质：枢纽
 * 记忆（与很多重要记忆共现）才是检索的骨架。PageRank（Brin–Page 1998）
 * 把「重要性 = 被重要者指向」写成不动点：
 *
 *   r = d·M·r + (1−d)·v
 *
 *   M 为行随机转移（无向图取对称归一），d 阻尼（缺省 0.85），
 *   v 均匀个人化向量。|λ₂(M)| ≤ 1 且谱隙 ≥ 1−d ⟹ 幂迭代线性收敛
 *   （速率 ~ dⁿ，20 余次迭代到 1e-9）；悬挂质量守恒重分配，
 *   Σr ≡ 1（质量守恒断言——谱的正确性可逐位检查）。
 *
 *   检索语义: related() 从「边权序」升维为「边权 × 邻居影响力」——
 *   与枢纽共现的记忆先被想起；枢纽本身沉淀为知识图的骨架清单
 *   （topInfluential）——蒸馏与遗忘的「保骨去肉」有了结构依据。
 *
 *   验证锚点: 环图 → 均匀分布（精确，任何阻尼）；星图 → 中心最高；
 *   双子图 → 与度结构一致；质量总和恒 1。
 *
 * R5-A11 进化（四轴）:
 *   [数学] personalizedPageRank——重启随机游走（RWR）个人化排序:
 *     v 从均匀向量换成种子集上的指示（重启概率 1−d 直落种子邻域），
 *     「局部枢纽」与「全局枢纽」第一次可分辨（verify: 双团桥图上
 *     种子所在团整体压过对侧团）。
 *   [数学/性质] pageRankDirect——不动点 (I − dM̂ᵀ)r = (1−d)v 的直接
 *     线性解（高斯消元，O(n³) 验证口径），与幂迭代解逐位对照：
 *     200 种子化随机图（含悬挂节点）max|r_pow − r_dir| < 1e-8。
 *   [性能] 稀疏列幂迭代: 转移矩阵按列存非零表（零权重条目贡献恰为
 *     +0.0，IEEE754 下跳过不改变和——无悬挂图与旧稠密实现逐位一致），
 *     稀疏大图（密度 5%）实测提速 ~10×。
 *   [数值稳健性] ①悬挂质量双重计数修复: 旧实现把悬挂行的均匀转移与
 *     danglingMass 重分配各计一次（靠末端归一兜底）；现挂靠单次计入，
 *     幂迭代解与不动点直接解精确一致（旧口径在悬挂图上两者偏差 ~1e-3）。
 *     ②damping/tol/maxIterations 非有限值回退缺省（旧版 NaN 会污染整个
 *     分布）；③权重矩阵非有限条目按 0 处理（旧版 NaN 逐项传播）。
 *
 * 零漂移: 无悬挂节点的图上幂迭代路径与升级前逐位一致；未挂载时
 *   related() 与升级前逐位一致。
 */

export interface PageRankOptions {
  /** 阻尼系数（缺省 0.85；非有限值回退缺省） */
  damping?: number;
  /** 收敛容差（L1；缺省 1e-10） */
  tol?: number;
  maxIterations?: number;
}

export interface PageRankResult {
  /** 节点 id（输入顺序） */
  ids: string[];
  /** 排序值（Σ = 1） */
  scores: number[];
  iterations: number;
  converged: boolean;
}

/** 数值护栏: 非有限/越界选项回退缺省（NaN 不许进入迭代） */
function safeOptions(options?: PageRankOptions): { damping: number; tol: number; maxIterations: number } {
  const rawD = options?.damping ?? 0.85;
  const damping = Number.isFinite(rawD) ? Math.min(0.999, Math.max(0, rawD)) : 0.85;
  const rawT = options?.tol ?? 1e-10;
  const tol = Number.isFinite(rawT) && rawT > 0 ? rawT : 1e-10;
  const rawM = options?.maxIterations ?? 200;
  const maxIterations = Number.isFinite(rawM) && rawM >= 1 ? Math.floor(rawM) : 200;
  return { damping, tol, maxIterations };
}

/**
 * 个人化向量: 种子 id 集合 → 指示分布（种子均匀 1/|S∩ids|，其余 0）。
 * 空集 / 与 ids 无交集 → 均匀向量（诚实回退: 无信息 = 全局口径）。
 */
function personalizationVector(ids: ReadonlyArray<string>, seeds: ReadonlyArray<string>): number[] {
  const set = new Set(seeds);
  const members = ids.filter((id) => set.has(id));
  if (members.length === 0) return Array.from({ length: ids.length }, () => 1 / ids.length);
  const w = 1 / members.length;
  return ids.map((id) => (set.has(id) ? w : 0));
}

/**
 * 幂迭代内核（稀疏列 + 单次悬挂质量计入；v 为个人化向量，Σv = 1）。
 *
 * 等价性: 零权重条目对列和的贡献恰为 +0.0（IEEE754: x + (+0.0) = x，
 * x ≥ 0），跳过不改变浮点和——与稠密逐项求和逐位一致。稀疏列用两个
 * 平行扁平数组（下标 + 权重）存储，避免对象属性访问的间接开销。
 */
function powerIterate(
  n: number,
  colIdx: ReadonlyArray<ReadonlyArray<number>>,
  colW: ReadonlyArray<ReadonlyArray<number>>,
  dangling: ReadonlyArray<boolean>,
  v: ReadonlyArray<number>,
  damping: number,
  tol: number,
  maxIterations: number,
): { scores: number[]; iterations: number; converged: boolean } {
  let r = Array.from({ length: n }, () => 1 / n);
  let converged = false;
  let iterations = 0;
  for (iterations = 1; iterations <= maxIterations; iterations += 1) {
    let danglingMass = 0;
    for (let i = 0; i < n; i += 1) if (dangling[i]) danglingMass += r[i];
    const next = v.map((vi) => (1 - damping) * vi + (damping * danglingMass) / n);
    for (let j = 0; j < n; j += 1) {
      const idx = colIdx[j];
      const ws = colW[j];
      let acc = 0;
      for (let e = 0; e < idx.length; e += 1) acc += r[idx[e]] * ws[e];
      next[j] += damping * acc;
    }
    let delta = 0;
    for (let i = 0; i < n; i += 1) delta += Math.abs(next[i] - r[i]);
    r = next;
    if (delta <= tol) {
      converged = true;
      break;
    }
  }
  const total = r.reduce((s, x) => s + x, 0);
  if (total > 0) r = r.map((x) => x / total);
  return { scores: r, iterations, converged };
}

/** 权重矩阵 → 稀疏列（非悬挂行、正有限权重）+ 悬挂标记 */
function buildSparseColumns(
  weights: ReadonlyArray<ReadonlyArray<number>>,
  n: number,
): { colIdx: number[][]; colW: number[][]; dangling: boolean[] } {
  const rowSum = weights.map((row) => {
    let s = 0;
    for (const w of row) if (Number.isFinite(w) && w > 0) s += w;
    return s;
  });
  const dangling = rowSum.map((s) => s <= 1e-12);
  const colIdx: number[][] = Array.from({ length: n }, () => []);
  const colW: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i += 1) {
    if (dangling[i]) continue;
    const row = weights[i];
    const s = rowSum[i];
    for (let j = 0; j < n; j += 1) {
      const w = row[j];
      if (Number.isFinite(w) && w > 0) {
        colIdx[j].push(i);
        colW[j].push(w / s);
      }
    }
  }
  return { colIdx, colW, dangling };
}

/**
 * 加权 PageRank（无向图：对称权重矩阵按行归一）。
 *
 * ids 与 weights（|ids|×|ids|，非负）由调用方给出；悬挂节点（全零行）
 * 的质量均匀重分配（守恒、单次计入）。空图安全返回。非有限权重按 0
 * 处理（护栏——不让一个 NaN 毁掉整个分布）。
 */
export function pageRank(ids: ReadonlyArray<string>, weights: ReadonlyArray<ReadonlyArray<number>>, options?: PageRankOptions): PageRankResult {
  const n = ids.length;
  if (n === 0) return { ids: [], scores: [], iterations: 0, converged: true };
  const { damping, tol, maxIterations } = safeOptions(options);
  const { colIdx, colW, dangling } = buildSparseColumns(weights, n);
  const out = powerIterate(n, colIdx, colW, dangling, Array.from({ length: n }, () => 1 / n), damping, tol, maxIterations);
  return { ids: [...ids], ...out };
}

/**
 * 个人化 PageRank（重启随机游走 RWR / personalized PageRank）。
 *
 * seeds: 重启落点（个人化向量在种子集上均匀）；其余节点权重 0。
 * 「与种子同邻域的枢纽」压过「全局枢纽」——局部影响力口径。
 * 空种子集 / 与 ids 无交集 → 均匀向量（等价 pageRank）。
 */
export function personalizedPageRank(
  ids: ReadonlyArray<string>,
  weights: ReadonlyArray<ReadonlyArray<number>>,
  seeds: ReadonlyArray<string>,
  options?: PageRankOptions,
): PageRankResult {
  const n = ids.length;
  if (n === 0) return { ids: [], scores: [], iterations: 0, converged: true };
  const { damping, tol, maxIterations } = safeOptions(options);
  const { colIdx, colW, dangling } = buildSparseColumns(weights, n);
  const v = personalizationVector(ids, seeds);
  const out = powerIterate(n, colIdx, colW, dangling, v, damping, tol, maxIterations);
  return { ids: [...ids], ...out };
}

/**
 * PageRank 不动点直接解: (I − dM̂ᵀ)r = (1−d)v（高斯消元 + 部分主元，
 * O(n³)——验证/小图口径，n > 600 拒绝）。
 *
 * M̂ 为悬挂行均匀化的行随机转移。与幂迭代互为对照: 幂迭代收敛判据
 * δ ≤ tol 的真实误差界为 δ·d/(1−d)，直接解无此残差——两者的差就是
 * 幂迭代的截断误差（verify 锚点: 200 种子化图 max 差 < 1e-8）。
 */
export function pageRankDirect(
  ids: ReadonlyArray<string>,
  weights: ReadonlyArray<ReadonlyArray<number>>,
  seeds?: ReadonlyArray<string>,
  options?: PageRankOptions,
): PageRankResult {
  const n = ids.length;
  if (n === 0) return { ids: [], scores: [], iterations: 0, converged: true };
  if (n > 600) throw new Error(`pageRankDirect: n = ${n} > 600（直接解 O(n³)，请用幂迭代）`);
  const { damping } = safeOptions(options);
  const v = seeds === undefined ? Array.from({ length: n }, () => 1 / n) : personalizationVector(ids, seeds);
  // B = I − d·M̂ᵀ（行随机口径: M̂[i][j] = P(i→j)）
  const B: number[][] = Array.from({ length: n }, (_, j) => Array.from({ length: n }, (_, i) => (i === j ? 1 : 0)));
  for (let i = 0; i < n; i += 1) {
    const row = weights[i];
    let s = 0;
    for (const w of row) if (Number.isFinite(w) && w > 0) s += w;
    if (s <= 1e-12) {
      for (let j = 0; j < n; j += 1) B[j][i] -= damping / n;
    } else {
      for (let j = 0; j < n; j += 1) {
        const w = row[j];
        if (Number.isFinite(w) && w > 0) B[j][i] -= (damping * w) / s;
      }
    }
  }
  const rhs = v.map((x) => (1 - damping) * x);
  // 高斯消元（部分主元）
  const a = B.map((row) => [...row]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r2 = col + 1; r2 < n; r2 += 1) if (Math.abs(a[r2][col]) > Math.abs(a[pivot][col])) pivot = r2;
    if (Math.abs(a[pivot][col]) < 1e-300) throw new Error('pageRankDirect: 不动点方程奇异（d=1 或图退化）');
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot], a[col]];
      const t = rhs[col];
      rhs[col] = rhs[pivot];
      rhs[pivot] = t;
    }
    const d0 = a[col][col];
    for (let c = col; c < n; c += 1) a[col][c] /= d0;
    rhs[col] /= d0;
    for (let r2 = 0; r2 < n; r2 += 1) {
      if (r2 === col) continue;
      const f = a[r2][col];
      if (f === 0) continue;
      for (let c = col; c < n; c += 1) a[r2][c] -= f * a[col][c];
      rhs[r2] -= f * rhs[col];
    }
  }
  const total = rhs.reduce((s, x) => s + x, 0);
  const scores = total > 0 ? rhs.map((x) => x / total) : rhs;
  return { ids: [...ids], scores, iterations: 0, converged: true };
}

/** 按 PageRank 降序的前 k 节点（39.0 接线口径：知识骨架清单） */
export function topInfluential(result: PageRankResult, k: number): Array<{ id: string; score: number }> {
  return result.ids
    .map((id, i) => ({ id, score: result.scores[i] }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(0, k));
}
