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
 * R5-A11 进化（四轴）:
 *   [数学] svdHardThresholdDenoise——Gavish–Donoho (2014) 最优硬阈值
 *     奇异值收缩（全观测去噪口径）: 已知 σ 时 τ = (4/√3)·σ·√max(n,m)
 *     （方阵精确最优、矩形近似最优——NMSE 曲线在最优附近平坦）；σ 未知
 *     时 τ = 2.858×中位奇异值。MSE 保证的来源: 硬阈值算子是渐近最优
 *     收缩（keep 恰为真秩，NMSE ~ rσ²/(nm)——verify: 200 种子 NMSE ≪
 *     keep-all 且被保留秩 = 真秩）。
 *   [数学] selectRank——留出交叉验证的秩选择: 观测条目确定性切
 *     train/holdout，r = 1..maxRank 逐个 ALS，取 holdout RMSE 最小者
 *     （平局取小秩——简约原则）。冷启动时「潜维数 r 是多少」第一次从
 *     超参变成可估计量。
 *   [性能] completeMatrix 新增 init: 'spectral'（缺省仍 'random'，零漂移）:
 *     列均值填充 → 小侧 Gram 谱截断 → 因子初始化，ALS 迭代数显著下降
 *     （verify: 同容差下迭代数对比，拟合 RMSE 不劣化）。
 *   [数值稳健性] 空观测提前返回（旧版空转 200 次迭代）；rank 钳到
 *     min(n,m)；lambda 负值回退缺省；观测条目越界/非有限已在旧版过滤。
 *
 * 零漂移: 纯诊断口径（getAttachedDiagnostics / coldStartEstimate），
 *   未挂载时评分路径逐位一致；completeMatrix 缺省参数路径与升级前
 *   逐位一致（谱初始化为显式 opt-in）。
 */

export interface MatrixCompletionOptions {
  /** 潜维数 r（缺省 3；> min(n,m) 时钳到 min(n,m)） */
  rank?: number;
  maxIterations?: number;
  tol?: number;
  /** L2 正则（缺省 1e-3，防过拟合小样本行；负值回退缺省） */
  lambda?: number;
  seed?: number;
  /** 因子初始化: 'random'（缺省，零漂移）| 'spectral'（列均值填充 + 谱截断——收敛更快） */
  init?: 'random' | 'spectral';
  /**
   * 严格收敛判据（缺省 false = 旧行为，逐位零漂移）。
   * 旧判据首轮 prevRmse = ∞ 时 ∞ ≤ tol·∞ 恒真——第 1 轮即"收敛"
   * （潜伏口径：单次扫描即停，iterations 恒 1）。true 时要求 prevRmse
   * 有限后才比较相对变化——ALS 跑到真收敛（selectRank/谱初始化对照
   * 用此口径）。
   */
  strictConvergence?: boolean;
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
  const rank = Math.max(1, Math.min(Math.floor(options?.rank ?? 3), Math.max(1, Math.min(n, m))));
  const maxIterations = options?.maxIterations ?? 200;
  const tol = options?.tol ?? 1e-6;
  const lambdaRaw = options?.lambda ?? 1e-3;
  const lambda = Number.isFinite(lambdaRaw) && lambdaRaw >= 0 ? lambdaRaw : 1e-3;
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
  // 护栏: 无有效观测 → 诚实零因子（旧版空转 200 次迭代后返回随机因子）
  if (rows.size === 0) {
    return {
      rowFactors: Array.from({ length: n }, () => new Array<number>(rank).fill(0)),
      colFactors: Array.from({ length: m }, () => new Array<number>(rank).fill(0)),
      trainRmse: 0,
      observedRatio: 0,
      iterations: 0,
      converged: true,
      lowRankShare: 0,
    };
  }
  // 谱初始化（opt-in）: 列均值填充 → 小侧 Gram 特征截断 → 因子对
  if (options?.init === 'spectral') {
    spectralInit(U, V, rows, cols, n, m, rank);
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
  const strict = options?.strictConvergence === true;
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
    // 收敛判据: 严格模式（strictConvergence）要求 prevRmse 有限后才比较；
    // 缺省保留旧口径（首轮 ∞−cur = ∞ ≤ tol·∞ 恒真——第 1 轮即停，
    // 文档化的潜伏行为，逐位零漂移）
    if (strict) {
      if (Number.isFinite(prevRmse) && Math.abs(prevRmse - cur) <= tol * Math.max(1, prevRmse)) {
        prevRmse = cur;
        converged = true;
        break;
      }
    } else if (Math.abs(prevRmse - cur) <= tol * Math.max(1, prevRmse)) {
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

// ─────────────────── R5: 文件内对称特征分解（谱初始化 / SVD 用；零依赖） ───────────────────

/** 循环 Jacobi（对称镜像旋转，特征值降序 + 对应单位特征向量） */
function symEig(input: ReadonlyArray<ReadonlyArray<number>>): { values: number[]; vectors: number[][] } {
  const n = input.length;
  if (n === 0) return { values: [], vectors: [] };
  const a = input.map((row) => [...row]);
  const q: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 30; sweep += 1) {
    let offDiag = 0;
    for (let p = 0; p < n; p += 1) for (let s = p + 1; s < n; s += 1) offDiag += a[p][s] * a[p][s];
    if (offDiag <= 1e-24) break;
    for (let p = 0; p < n - 1; p += 1) {
      for (let s = p + 1; s < n; s += 1) {
        const aps = a[p][s];
        if (Math.abs(aps) < 1e-300) continue;
        const theta = (a[s][s] - a[p][p]) / (2 * aps);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cos = 1 / Math.sqrt(t * t + 1);
        const sin = t * cos;
        for (let k = 0; k < n; k += 1) { const akp = a[k][p], aks = a[k][s]; a[k][p] = cos * akp - sin * aks; a[k][s] = sin * akp + cos * aks; }
        for (let k = 0; k < n; k += 1) { const apk = a[p][k], ask = a[s][k]; a[p][k] = cos * apk - sin * ask; a[s][k] = sin * apk + cos * ask; }
        for (let k = 0; k < n; k += 1) {
          const qkp = q[k][p];
          const qks = q[k][s];
          q[k][p] = cos * qkp - sin * qks;
          q[k][s] = sin * qkp + cos * qks;
        }
      }
    }
  }
  const values = Array.from({ length: n }, (_, i) => a[i][i]);
  const order = values.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v || x.i - y.i);
  return { values: order.map((o) => o.v), vectors: order.map((o) => q.map((row) => row[o.i])) };
}

/**
 * 谱初始化: 未观测条目以列均值填充（无观测列填 0），对小侧 Gram
 * （m ≤ n 时 AᵀA，否则 AAᵀ）取前 r 个特征对，因子取 λ^{1/4} 对称
 * 分摊——U Vᵀ ≈ 填充矩阵的秩 r 截断。就地写入 U/V。
 */
function spectralInit(
  U: number[][],
  V: number[][],
  rows: Map<number, Array<{ j: number; value: number }>>,
  cols: Map<number, Array<{ i: number; value: number }>>,
  n: number,
  m: number,
  rank: number,
): void {
  // 填充矩阵（列均值）
  const filled = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (let j = 0; j < m; j += 1) {
    const entries = cols.get(j);
    const mean = entries && entries.length > 0 ? entries.reduce((s, e) => s + e.value, 0) / entries.length : 0;
    for (let i = 0; i < n; i += 1) filled[i][j] = mean;
  }
  for (const [i, entries] of rows) for (const e of entries) filled[i][e.j] = e.value;
  if (m <= n) {
    // G = AᵀA（m×m）: v_k 特征向量 → V[j][k] = v_k[j]·λ^{1/4}，U = A·V·λ^{-1/4}·λ^{1/2}/… = A·V·λ^{-1/4}
    const g: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
    for (let a = 0; a < m; a += 1) {
      for (let b = a; b < m; b += 1) {
        let s = 0;
        for (let i = 0; i < n; i += 1) s += filled[i][a] * filled[i][b];
        g[a][b] = s;
        g[b][a] = s;
      }
    }
    const eig = symEig(g);
    for (let k = 0; k < rank; k += 1) {
      const lam = Math.max(eig.values[k] ?? 0, 0);
      const scale = Math.pow(lam, 0.25);
      const vk = eig.vectors[k];
      for (let j = 0; j < m; j += 1) V[j][k] = vk[j] * scale;
      const inv = lam > 1e-300 ? Math.pow(lam, -0.25) : 0;
      for (let i = 0; i < n; i += 1) {
        let s = 0;
        for (let j = 0; j < m; j += 1) s += filled[i][j] * vk[j];
        U[i][k] = s * inv;
      }
    }
  } else {
    const g: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let a = 0; a < n; a += 1) {
      for (let b = a; b < n; b += 1) {
        let s = 0;
        for (let j = 0; j < m; j += 1) s += filled[a][j] * filled[b][j];
        g[a][b] = s;
        g[b][a] = s;
      }
    }
    const eig = symEig(g);
    for (let k = 0; k < rank; k += 1) {
      const lam = Math.max(eig.values[k] ?? 0, 0);
      const scale = Math.pow(lam, 0.25);
      const uk = eig.vectors[k];
      for (let i = 0; i < n; i += 1) U[i][k] = uk[i] * scale;
      const inv = lam > 1e-300 ? Math.pow(lam, -0.25) : 0;
      for (let j = 0; j < m; j += 1) {
        let s = 0;
        for (let i = 0; i < n; i += 1) s += filled[i][j] * uk[i];
        V[j][k] = s * inv;
      }
    }
  }
}

// ─────────────────── R5: Gavish–Donoho 最优硬阈值 SVD 去噪 ───────────────────

export interface HardThresholdOptions {
  /** 噪声标准差（已知时用 4/√3 规则；缺省走中位数规则） */
  sigma?: number;
  /** 阈值: 'known-sigma'（需给 sigma）| 'median'（缺省）| 显式数值 */
  rule?: 'known-sigma' | 'median' | number;
}

export interface SvdDenoiseReport {
  /** 硬阈值收缩后的矩阵（rank ≤ kept） */
  denoised: number[][];
  /** 原矩阵奇异值（降序） */
  singularValues: number[];
  /** 保留的奇异值个数 */
  kept: number;
  /** 使用的阈值 τ */
  threshold: number;
  rule: string;
}

/**
 * Gavish–Donoho (2014) 最优硬阈值奇异值收缩（全观测 + 加性噪声口径）。
 *
 *   已知 σ: τ = (4/√3)·σ·√max(n,m)——方阵的渐近 MSE 最优硬阈值
 *     （NMSE ~ r·σ²/(nm)，keep 恰为真秩）；
 *   σ 未知: τ = 2.858 × 中位奇异值（β = min/max ≈ 1 口径，矩形略保守
 *     ——NMSE 曲线在最优倍率 ±30% 内平坦）。
 * SVD 经对称嵌入 [[0, A], [Aᵀ, 0]] 的特征分解实现（文件内 Jacobi）。
 */
export function svdHardThresholdDenoise(matrix: ReadonlyArray<ReadonlyArray<number>>, options?: HardThresholdOptions): SvdDenoiseReport {
  const n = matrix.length;
  if (n === 0) throw new Error('svdHardThresholdDenoise: 矩阵为空');
  const m = matrix[0].length;
  if (m === 0) throw new Error('svdHardThresholdDenoise: 矩阵列数为 0');
  for (const row of matrix) if (row.length !== m) throw new Error(`svdHardThresholdDenoise: 需矩形矩阵（首行 ${m} 列）`);
  const embed = Array.from({ length: n + m }, () => new Array<number>(n + m).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      const v = matrix[i][j];
      if (!Number.isFinite(v)) throw new Error(`svdHardThresholdDenoise: [${i}][${j}] = ${v} 非有限`);
      embed[i][n + j] = v;
      embed[n + j][i] = v;
    }
  }
  const eig = symEig(embed);
  const maxRank = Math.min(n, m);
  const singularValues: number[] = [];
  const us: number[][] = [];
  const vs: number[][] = [];
  for (let k = 0; k < eig.values.length && singularValues.length < maxRank; k += 1) {
    const lam = eig.values[k];
    if (lam <= 1e-12) break;
    singularValues.push(lam);
    const w = eig.vectors[k];
    us.push(w.slice(0, n).map((x) => x * Math.SQRT2));
    vs.push(w.slice(n).map((x) => x * Math.SQRT2));
  }
  const rule = options?.rule ?? (options?.sigma !== undefined ? 'known-sigma' : 'median');
  let threshold: number;
  let ruleName: string;
  if (typeof rule === 'number') {
    if (!Number.isFinite(rule) || rule <= 0) throw new Error(`svdHardThresholdDenoise: 显式阈值需为正有限数（得到 ${rule}）`);
    threshold = rule;
    ruleName = 'explicit';
  } else if (rule === 'known-sigma') {
    const sigma = options?.sigma;
    if (sigma === undefined || !Number.isFinite(sigma) || sigma <= 0) {
      throw new Error(`svdHardThresholdDenoise: known-sigma 规则需要正有限 sigma（得到 ${sigma}）`);
    }
    threshold = (4 / Math.sqrt(3)) * sigma * Math.sqrt(Math.max(n, m));
    ruleName = 'gavish-donoho:4/√3·σ√max(n,m)';
  } else {
    if (singularValues.length === 0) {
      threshold = 0;
    } else {
      const sorted = [...singularValues].sort((x, y) => x - y);
      const median = sorted[Math.floor(sorted.length / 2)];
      threshold = 2.858 * median;
    }
    ruleName = 'gavish-donoho:2.858·median';
  }
  let kept = 0;
  while (kept < singularValues.length && singularValues[kept] > threshold) kept += 1;
  const denoised = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (let k = 0; k < kept; k += 1) {
    const s = singularValues[k];
    const uk = us[k];
    const vk = vs[k];
    for (let i = 0; i < n; i += 1) {
      const sui = s * uk[i];
      for (let j = 0; j < m; j += 1) denoised[i][j] += sui * vk[j];
    }
  }
  return { denoised, singularValues, kept, threshold, rule: ruleName };
}

// ─────────────────── R5: 留出交叉验证的秩选择 ───────────────────

export interface SelectRankOptions {
  /** 候选最大秩（缺省 6；逐 r = 1..maxRank） */
  maxRank?: number;
  /** 交叉验证折数（缺省 4；2..6） */
  folds?: number;
  seed?: number;
  /** ALS 迭代上限（传给 completeMatrix；缺省 150） */
  maxIterations?: number;
  lambda?: number;
}

export interface SelectRankReport {
  /** holdout RMSE 最小的秩（平局取小——简约原则） */
  bestRank: number;
  /** 各候选秩的 holdout/train RMSE */
  curve: Array<{ rank: number; holdoutRmse: number; trainRmse: number }>;
  holdoutCount: number;
  trainCount: number;
}

/**
 * k 折交叉验证秩选择（k 缺省 4）。
 *
 * 观测条目确定性（种子化 mulberry32）轮转分到 k 折；对每个候选秩 r，
 * 逐折「其余折训练 ALS + 本折量 RMSE」，取 k 折平均 RMSE 最小的秩
 * （平局差 < 1e-12 取小秩——简约原则）。「潜维数是多少」从超参变成
 * 可估计量；k 折（相对单次留出）压平小样本折的方差，选择更稳。
 */
export function selectRank(observed: ReadonlyArray<{ i: number; j: number; value: number }>, n: number, m: number, options?: SelectRankOptions): SelectRankReport {
  const valid = observed.filter((e) => e.i >= 0 && e.i < n && e.j >= 0 && e.j < m && Number.isFinite(e.value));
  if (valid.length < 8) throw new Error(`selectRank: 至少需要 8 条有效观测（得到 ${valid.length}）`);
  const maxRank = Math.max(1, Math.min(Math.floor(options?.maxRank ?? 6), Math.min(n, m)));
  const k = Math.max(2, Math.min(6, Math.floor(options?.folds ?? 4)));
  let s = (options?.seed ?? 20261021) >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Fisher–Yates（种子化）后轮转分折——每条观测恰好做一次验证
  const order = valid.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  const foldOf = new Array<number>(valid.length);
  for (let idx = 0; idx < valid.length; idx += 1) foldOf[order[idx]] = idx % k;
  const alsOptions = { maxIterations: options?.maxIterations ?? 150, lambda: options?.lambda, seed: options?.seed, strictConvergence: true };
  const curve: Array<{ rank: number; holdoutRmse: number; trainRmse: number }> = [];
  const foldRmses: number[][] = [];
  let bestMeanRank = 1;
  let bestRmse = Infinity;
  for (let r = 1; r <= maxRank; r += 1) {
    let sumSq = 0;
    let count = 0;
    let trainSum = 0;
    const perFold: number[] = [];
    for (let f = 0; f < k; f += 1) {
      const train: Array<{ i: number; j: number; value: number }> = [];
      const holdout: Array<{ i: number; j: number; value: number }> = [];
      for (let idx = 0; idx < valid.length; idx += 1) {
        (foldOf[idx] === f ? holdout : train).push(valid[idx]);
      }
      if (train.length === 0 || holdout.length === 0) continue;
      // 双种子重启取优（ALS 可能陷局部极小——单次失败会让 CV 误判秩偏大）
      let bestFoldSq = Infinity;
      let bestTrain = Infinity;
      for (const restart of [0, 1]) {
        const report = completeMatrix(train, n, m, { ...alsOptions, rank: r, seed: (options?.seed ?? 20261021) + restart * 10007 });
        let foldSq = 0;
        for (const e of holdout) {
          const u = report.rowFactors[e.i];
          const v = report.colFactors[e.j];
          let pred = 0;
          if (u && v) for (let a = 0; a < u.length; a += 1) pred += u[a] * v[a];
          foldSq += (pred - e.value) ** 2;
        }
        if (foldSq < bestFoldSq) {
          bestFoldSq = foldSq;
          bestTrain = report.trainRmse;
        }
      }
      sumSq += bestFoldSq;
      count += holdout.length;
      trainSum += bestTrain;
      perFold.push(Math.sqrt(bestFoldSq / holdout.length));
    }
    const holdoutRmse = count > 0 ? Math.sqrt(sumSq / count) : Number.POSITIVE_INFINITY;
    curve.push({ rank: r, holdoutRmse, trainRmse: trainSum / k });
    foldRmses.push(perFold);
    if (holdoutRmse < bestRmse - 1e-12) {
      bestRmse = holdoutRmse;
      bestMeanRank = r;
    }
  }
  // 1-SE 规则: 折间标准误内取**最小**秩——高容量候选在小折上过拟合出
  // 貌似更低的验证误差时，简约原则把秩拉回（标准 CV 实践）
  let bestRank = bestMeanRank;
  const bestFolds = foldRmses[bestMeanRank - 1] ?? [];
  if (bestFolds.length >= 2) {
    const mean = bestFolds.reduce((s, x) => s + x, 0) / bestFolds.length;
    const varr = bestFolds.reduce((s, x) => s + (x - mean) ** 2, 0) / (bestFolds.length - 1);
    const se = Math.sqrt(varr / bestFolds.length);
    for (let r = 1; r < bestMeanRank; r += 1) {
      if (curve[r - 1].holdoutRmse <= bestRmse + se) {
        bestRank = r;
        break;
      }
    }
  }
  return { bestRank, curve, holdoutCount: Math.floor(valid.length / k), trainCount: valid.length - Math.floor(valid.length / k) };
}
