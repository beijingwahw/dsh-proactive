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
 * 零漂移: 未挂载时 related() 与升级前逐位一致。
 */

export interface PageRankOptions {
  /** 阻尼系数（缺省 0.85） */
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

/**
 * 加权 PageRank（无向图：对称权重矩阵按行归一）。
 *
 * ids 与 weights（|ids|×|ids|，非负）由调用方给出；悬挂节点（全零行）
 * 的质量均匀重分配（守恒）。空图安全返回。
 */
export function pageRank(ids: ReadonlyArray<string>, weights: ReadonlyArray<ReadonlyArray<number>>, options?: PageRankOptions): PageRankResult {
  const n = ids.length;
  if (n === 0) return { ids: [], scores: [], iterations: 0, converged: true };
  const d = Math.min(0.999, Math.max(0, options?.damping ?? 0.85));
  const tol = options?.tol ?? 1e-10;
  const maxIterations = options?.maxIterations ?? 200;
  // 行归一转移矩阵 + 悬挂标记
  const rowSum = weights.map((row) => row.reduce((s, v) => s + Math.max(0, v), 0));
  const dangling = rowSum.map((s) => s <= 1e-12);
  const transition = weights.map((row, i) => {
    const s = rowSum[i];
    if (s <= 1e-12) return Array.from({ length: n }, () => 1 / n);
    return row.map((v) => Math.max(0, v) / s);
  });
  let r = Array.from({ length: n }, () => 1 / n);
  let converged = false;
  let iterations = 0;
  for (iterations = 1; iterations <= maxIterations; iterations += 1) {
    let danglingMass = 0;
    for (let i = 0; i < n; i += 1) if (dangling[i]) danglingMass += r[i];
    const next = Array.from({ length: n }, () => (1 - d) / n + (d * danglingMass) / n);
    for (let j = 0; j < n; j += 1) {
      let col = 0;
      for (let i = 0; i < n; i += 1) col += r[i] * transition[i][j];
      next[j] += d * col;
    }
    let delta = 0;
    for (let i = 0; i < n; i += 1) delta += Math.abs(next[i] - r[i]);
    r = next;
    if (delta <= tol) {
      converged = true;
      break;
    }
  }
  // 质量守恒归一（数值口径）
  const total = r.reduce((s, x) => s + x, 0);
  if (total > 0) r = r.map((x) => x / total);
  return { ids: [...ids], scores: r, iterations, converged };
}

/** 按 PageRank 降序的前 k 节点（39.0 接线口径：知识骨架清单） */
export function topInfluential(result: PageRankResult, k: number): Array<{ id: string; score: number }> {
  return result.ids
    .map((id, i) => ({ id, score: result.scores[i] }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(0, k));
}
