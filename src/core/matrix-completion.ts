/**
 * 50.0 矩阵补全内核 —— 低秩交替最小二乘：冷启动能力从潜维度涌现
 *
 * 动机: 新模型注册时 taskScores 一片空白——要积累多少次调用才能
 * 知道它擅长什么？如果「模型 × 任务类型」的能力矩阵是**低秩**的
 * （少数几个潜能力维度决定一切——语言能力/推理能力/长文本能力…），
 * 那么观测到的少量条目就足以**补全**整个矩阵:
 *
 *   低秩模型: M ≈ U·Vᵀ（rank r ≪ min(n,m)）；观测 Ω 上的条目
 *   最小化 Σ_{(i,j)∈Ω} (M_ij − (UVᵀ)_ij)² —— 交替最小二乘（ALS）:
 *   固定 V 解 U（每行闭式线性解）、固定 U 解 V，交替至收敛。
 *   恢复条件（Candès–Recht 2009）: 秩 r 与相干性温和、观测密度
 *   |Ω| ≳ r·n·log n 量级时精确恢复（定理背书，非祈祷）。
 *
 *   调度语义: 新模型在若干任务类型上的早期成绩 → ALS 潜因子 →
 *   未测任务类型上的能力预测——**冷启动选型从「零样本瞎选」升级
 *   为潜维度外推**；同时低秩残差大的模型是「能力异常」（不适合
 *   潜维度解释，需单独画像）。
 *
 *   验证锚点: 合成低秩矩阵 + 噪声的部分观测 → 恢复误差 ≪ 观测噪声
 *   的若干倍；满秩随机矩阵诚实高残差（不强行低秩解释）。
 *
 * 零漂移: 纯诊断口径（getAttachedDiagnostics / coldStartEstimate），
 *   未挂载时评分路径逐位一致。
 */

export interface MatrixCompletionOptions {
  /** 潜维数 r（缺省 3） */
  rank?: number;
  maxIterations?: number;
  tol?: number;
  /** L2 正则（缺省 1e-3，防过拟合小样本行） */
  lambda?: number;
  seed?: number;
}

export interface CompletionReport {
  /** 因子矩阵（n×r 与 m×r） */
  rowFactors: number[][];
  colFactors: number[][];
  /** 观测条目上的 RMSE（拟合度） */
  trainRmse: number;
  /** 观测数 / 全矩阵 */
  observedRatio: number;
  iterations: number;
  converged: boolean;
  /** 有效秩读数：拟合能量 / 总能量（低秩假设的成色） */
  lowRankShare: number;
}

/**
 * 低秩矩阵补全（ALS；行/列闭式岭回归交替）。
 *
 * observed: 观测条目列表 [{i, j, value}]；n/m 为矩阵维度。
 * 行/列因子以确定性小扰动初始化（对称破缺）。
 */
export function completeMatrix(observed: ReadonlyArray<{ i: number; j: number; value: number }>, n: number, m: number, options?: MatrixCompletionOptions): CompletionReport {
  const rank = Math.max(1, Math.floor(options?.rank ?? 3));
  const maxIterations = options?.maxIterations ?? 200;
  const tol = options?.tol ?? 1e-6;
  const lambda = options?.lambda ?? 1e-3;
  let s = (options?.seed ?? 20261020) >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const U = Array.from({ length: n }, () => Array.from({ length: rank }, () => rnd() * 0.1 + 0.05));
  const V = Array.from({ length: m }, () => Array.from({ length: rank }, () => rnd() * 0.1 + 0.05));
  const rows = new Map<number, Array<{ j: number; value: number }>>();
  const cols = new Map<number, Array<{ i: number; value: number }>>();
  for (const e of observed) {
    if (e.i < 0 || e.i >= n || e.j < 0 || e.j >= m || !Number.isFinite(e.value)) continue;
    const row = rows.get(e.i) ?? [];
    row.push({ j: e.j, value: e.value });
    rows.set(e.i, row);
    const col = cols.get(e.j) ?? [];
    col.push({ i: e.i, value: e.value });
    cols.set(e.j, col);
  }
  const solveRidge = (entries: Array<{ other: number; value: number }>, factors: number[][]): number[] => {
    // min_w Σ (value − w·f_other)² + λ‖w‖² → (Σ f fᵀ + λI) w = Σ value·f
    const A: number[][] = Array.from({ length: rank }, () => new Array<number>(rank).fill(0));
    const b = new Array<number>(rank).fill(0);
    for (const e of entries) {
      const f = factors[e.other];
      if (!f) continue;
      for (let a = 0; a < rank; a += 1) {
        for (let c = 0; c < rank; c += 1) A[a][c] += f[a] * f[c];
        b[a] += e.value * f[a];
      }
    }
    for (let a = 0; a < rank; a += 1) A[a][a] += lambda + 1e-9;
    // 高斯消元（rank ≤ ~8，闭式解）
    for (let col = 0; col < rank; col += 1) {
      let pivot = col;
      for (let r2 = col + 1; r2 < rank; r2 += 1) if (Math.abs(A[r2][col]) > Math.abs(A[pivot][col])) pivot = r2;
      [A[col], A[pivot]] = [A[pivot], A[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
      const d = A[col][col] || 1e-9;
      for (let c = col; c < rank; c += 1) A[col][c] /= d;
      b[col] /= d;
      for (let r2 = 0; r2 < rank; r2 += 1) {
        if (r2 === col) continue;
        const f = A[r2][col];
        if (!f) continue;
        for (let c = col; c < rank; c += 1) A[r2][c] -= f * A[col][c];
        b[r2] -= f * b[col];
      }
    }
    return b;
  };
  let prevRmse = Infinity;
  let converged = false;
  let iterations = 0;
  const rmse = (): number => {
    let sum = 0;
    let count = 0;
    for (const [i, entries] of rows) {
      for (const e of entries) {
        const u = U[i];
        const v = V[e.j];
        if (!u || !v) continue;
        let pred = 0;
        for (let a = 0; a < rank; a += 1) pred += u[a] * v[a];
        sum += (pred - e.value) ** 2;
        count += 1;
      }
    }
    return count > 0 ? Math.sqrt(sum / count) : 0;
  };
  for (iterations = 1; iterations <= maxIterations; iterations += 1) {
    for (let i = 0; i < n; i += 1) {
      const entries = rows.get(i);
      if (!entries || entries.length === 0) continue;
      U[i] = solveRidge(entries.map((e) => ({ other: e.j, value: e.value })), V);
    }
    for (let j = 0; j < m; j += 1) {
      const entries = cols.get(j);
      if (!entries || entries.length === 0) continue;
      V[j] = solveRidge(entries.map((e) => ({ other: e.i, value: e.value })), U);
    }
    const cur = rmse();
    if (Math.abs(prevRmse - cur) <= tol * Math.max(1, prevRmse)) {
      prevRmse = cur;
      converged = true;
      break;
    }
    prevRmse = cur;
  }
  // 低秩成色：观测总能量中 ALS 拟合解释的份额
  let totalEnergy = 0;
  let fittedEnergy = 0;
  for (const [i, entries] of rows) {
    for (const e of entries) {
      const u = U[i];
      const v = V[e.j];
      if (!u || !v) continue;
      let pred = 0;
      for (let a = 0; a < rank; a += 1) pred += u[a] * v[a];
      totalEnergy += e.value * e.value;
      fittedEnergy += pred * pred;
    }
  }
  return {
    rowFactors: U,
    colFactors: V,
    trainRmse: prevRmse,
    observedRatio: observed.length / Math.max(1, n * m),
    iterations,
    converged,
    lowRankShare: totalEnergy > 0 ? Math.min(1, fittedEnergy / totalEnergy) : 0,
  };
}

/** 补全预测：M_ij ≈ u_i · v_j（观测未覆盖的条目外推） */
export function completedEntry(report: CompletionReport, i: number, j: number): number | undefined {
  const u = report.rowFactors[i];
  const v = report.colFactors[j];
  if (!u || !v) return undefined;
  let pred = 0;
  for (let a = 0; a < u.length; a += 1) pred += u[a] * v[a];
  return pred;
}
