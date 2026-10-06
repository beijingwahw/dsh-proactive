/**
 * 78.0 多源对齐内核 —— 典型相关分析（CCA）：异构证据源的公共坐标系
 *
 * 动机: 世界模型与记忆系统同时收着多路异构证据——多个模型的评分向量
 * （模型视角）、多源信号特征（环境视角）、反馈序列（结果视角）……各源
 * 各说各话。逐列配对相关（第 j 列对第 k 列）是**局部口径**：被各自噪声
 * 污染，也看不到「两个源作为整体共享多少信息」。CCA（Hotelling 1936）
 * 把对齐升维为整体最大化问题：
 *
 *   ρ(a, b) = corr(Xa, Yb) → max
 *
 * 最优方向对 (a₁, b₁) 是两源各自空间里「最能互相看见」的投影轴；逐对
 * 求解得典型相关谱 ρ₁ ≥ ρ₂ ≥ … ≥ 0——**两源公共坐标系的全部容量**：
 * ρ 高的方向是共享潜因子（两源看见的是同一件事的不同投影），ρ ≈ 0 的
 * 方向是各自私有噪声。多源融合第一次有了「先对齐、再融合」的数学地基
 * （56.0 置信传播的连续版前置：离散势表之前，先把连续证据源对齐到
 * 公共潜坐标）。
 *
 * 数学: 白化归约。样本协方差分块 Σxx、Σyy（对称半正定）→ 谱分解取
 * 满秩部分 Wx = Vx Λx^{−1/2}（满足 Wxᵀ Σxx Wx = I），Wy 同理；
 *
 *   K = Wxᵀ Σxy Wy（白化域互协方差，rx × ry）
 *   ρ_i² = (K Kᵀ) 的第 i 大特征值（截到 [0,1]）
 *   a_i = Wx u_i（u_i 为 KKᵀ 特征向量），b_i = Wy (Kᵀ u_i / ρ_i)
 *
 * 全部线性代数（Jacobi 对称旋转，二次收敛到机器精度）文件内自实现，
 * 零依赖。高维小样本（p+q > n）时样本协方差秩亏、白化放大噪声方向，
 * min(rank) 个典型相关全部 ≈ 1（过拟合完美相关）——岭正则
 * （Σxx + λI, Σyy + λI）把病态方向压平，λ > 0 时恒有有限解。
 *
 * 约定: 方向向量取单位（正则化）协方差口径 aᵀ Σxx a = 1（scores 样本
 * 方差 1）；符号双重钉死——a 的最大绝对分量 ≥ 0 且 corr(xs, ys) ≥ 0
 * （CCA 方向天然带 ±号与尺度自由度，断言与下游消费统一用 |cos| / ρ 的
 * 不变口径）。
 *
 * 验证锚点（scripts/verify-alignment-manifold.mjs，全部确定性断言）:
 *   ① 已知潜变量恢复: X = AZ + ε₁、Y = BZ + ε₂（Z 二维潜因子、A/B
 *      正交载荷、种子化噪声 σx = σy = 0.3、信噪比 α²/σ² ≈ 3.3~11），
 *      总体真值有闭式 ρ_i = αᵢβᵢ/√((αᵢ²+σx²)(βᵢ²+σy²))——n = 600
 *      下恢复误差 ≤ 0.03，方向对齐 |cos| > 0.98（符号/尺度不变口径）;
 *   ② 典型变量正交: variates 互相关矩阵近似对角（非对角 < 0.05），
 *      对角线 = ρ_i（±0.02），每个 scores 样本方差 = 1（±0.02）;
 *   ③ 不变性: X → XM（M 可逆、条件数 ≤ 4）后典型相关谱不变（1e-9）
 *      ——公共信息量与坐标选取无关;
 *   ④ 岭正则: p = q = 50 > n = 40——无正则时 min(rank) = 39 个 ρ 全
 *      部 ≈ 1（诚实报告崩溃：白化把噪声方向放大成完美相关），ridgeCCA
 *      λ=1 谱有界单调、中位数 < 0.5，且首典型相关仍贴近真信号。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入
 *
 * R5-A11 进化（四轴）:
 *   [数学] kernelCCA——核典型相关分析（RKHS 白化归约）: X/Y 先经核
 *     映射（RBF / 多项式 / 线性）成中心化 Gram 阵（双重中心化 H·K·H），
 *     再走同一套白化 + Jacobi CCA 管线——「典型相关」从线性投影推广到
 *     任意函数空间。验证锚点: ①线性核 KCCA 的 ρ 谱与线性 CCA 一致
 *     （min-rank 截断内，≤1e-6——口径不变性）; ②非线性依赖检验:
 *     Y = X² 时线性 ρ₁ ≈ 0 而高斯核 ρ₁ > 0.8（相关从「线性共变」升维
 *     为「泛函依赖」——多源证据对齐不再被线性假设卡住）。归约本身就是
 *     性能口径: 核化零新增线性代数（Gram 阵直接喂既有管线）。
 *   [数值稳健性] jacobiEigen 特征值平局显式按下标定序（旋转主循环与
 *     升级前逐位一致——零漂移）; kernelCCA 的核参数校验（σ 非正/
 *     degree 非法显式拒绝）; RBF 带宽缺省走成对距离中位数（确定性
 *     启发式，非随机）。
 */

// ─────────────────── 基础矩阵工具（文件内自实现，零依赖） ───────────────────

/** 二维数值矩阵口径（外层为行） */
type Matrix = ReadonlyArray<ReadonlyArray<number>>;

/**
 * 入参校验: 非空二维数组、各行等长、元素有限。
 * 返回 { rows, cols }；违规显式 throw。
 */
function validateMatrix(m: Matrix, name: string): { rows: number; cols: number } {
  if (!Array.isArray(m) || m.length === 0) throw new Error(`${name}: 需要非空二维数组（得到长度 ${m.length}）`);
  const cols = m[0].length;
  if (!Number.isInteger(cols) || cols < 1) throw new Error(`${name}: 列数需为 ≥1 的整数（得到 ${cols}）`);
  for (let i = 0; i < m.length; i += 1) {
    const row = m[i];
    if (!Array.isArray(row) || row.length !== cols) throw new Error(`${name}: 第 ${i} 行长度 ${row?.length} ≠ 首行 ${cols}（需矩形）`);
    for (let j = 0; j < cols; j += 1) {
      const v = row[j];
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name}: [${i}][${j}] = ${v} 不是有限数`);
    }
  }
  return { rows: m.length, cols };
}

/** 列中心化（返回中心化副本与列均值） */
function centerColumns(m: Matrix): { centered: number[][]; means: number[] } {
  const n = m.length;
  const cols = m[0].length;
  const means = Array.from({ length: cols }, (_, j) => {
    let s = 0;
    for (let i = 0; i < n; i += 1) s += m[i][j];
    return s / n;
  });
  const centered = m.map((row) => row.map((v, j) => v - means[j]));
  return { centered, means };
}

/** 交叉协方差 (1/(n−1))·Acᵀ·Bc（输入须已中心化、行数一致） */
function crossCovariance(ac: Matrix, bc: Matrix): number[][] {
  const n = ac.length;
  const p = ac[0].length;
  const q = bc[0].length;
  const out: number[][] = Array.from({ length: p }, () => new Array<number>(q).fill(0));
  const scale = 1 / Math.max(1, n - 1);
  for (let i = 0; i < p; i += 1) {
    for (let j = 0; j < q; j += 1) {
      let s = 0;
      for (let t = 0; t < n; t += 1) s += ac[t][i] * bc[t][j];
      out[i][j] = s * scale;
    }
  }
  return out;
}

/** vᵀ·S·v（S 方阵） */
function quadForm(s: Matrix, v: ReadonlyArray<number>): number {
  let out = 0;
  const n = s.length;
  for (let i = 0; i < n; i += 1) {
    let rowAcc = 0;
    const row = s[i];
    for (let j = 0; j < n; j += 1) rowAcc += row[j] * v[j];
    out += v[i] * rowAcc;
  }
  return out;
}

// ─────────────────── 对称特征分解（Jacobi 旋转，导出供验证） ───────────────────

/** 对称特征分解结果（values 降序；vectors[k] 为第 k 个单位特征向量） */
export interface JacobiEigenResult {
  values: number[];
  vectors: number[][];
}

/**
 * 循环 Jacobi 对称特征分解: A = V·diag(values)·Vᵀ。
 *
 * 每轮扫描全部非对角 (p,q) 用 Givens 旋转消零，非对角能量单调下降、
 * 二次收敛（~6–15 轮到机器精度）。输入取对称部分（非对称残余忽略）；
 * 结果与输入同输入同输出（逐位确定）。
 */
export function jacobiEigen(input: Matrix, maxSweeps = 60, tol = 1e-12): JacobiEigenResult {
  const n = input.length;
  if (n === 0) return { values: [], vectors: [] };
  for (const row of input) if (row.length !== n) throw new Error('jacobiEigen: 需要方阵');
  const a = input.map((row) => [...row]);
  // q 累积旋转，q[k][i] = 第 k 个基向量（转置口径）
  const q: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let offDiag = 0;
    for (let p = 0; p < n; p += 1) for (let s = p + 1; s < n; s += 1) offDiag += a[p][s] * a[p][s];
    if (offDiag <= tol * tol) break;
    for (let p = 0; p < n - 1; p += 1) {
      for (let s = p + 1; s < n; s += 1) {
        const aps = a[p][s];
        if (Math.abs(aps) < 1e-300) continue;
        // 经典 Jacobi 角度（数值稳定形式）
        const theta = (a[s][s] - a[p][p]) / (2 * aps);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cos = 1 / Math.sqrt(t * t + 1);
        const sin = t * cos;
        for (let k = 0; k < n; k += 1) {
          const akp = a[k][p];
          const aks = a[k][s];
          a[k][p] = cos * akp - sin * aks;
          a[k][s] = sin * akp + cos * aks;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = a[p][k];
          const ask = a[s][k];
          a[p][k] = cos * apk - sin * ask;
          a[s][k] = sin * apk + cos * ask;
        }
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
  // 平局确定性: 浮点相等的特征值按下标升序（显式 tiebreak）
  const order = values.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v || x.i - y.i);
  return {
    values: order.map((o) => o.v),
    vectors: order.map((o) => q.map((row) => row[o.i])),
  };
}

// ─────────────────── 白化（导出供验证与下游复用） ───────────────────

/** 白化结果：matrix 为 n×r 因子 W（列 = 特征向量/√λ），满足 WᵀMW = I_r */
export interface WhitenResult {
  /** n×r 白化因子（r = rank；rank=0 时为空数组） */
  matrix: number[][];
  /** 保留下来的特征值个数 r */
  rank: number;
  /** 全部特征值（降序，截断前） */
  eigenvalues: number[];
  /** 截断阈值（rankTol × λmax） */
  tolerance: number;
}

/**
 * 对称半正定矩阵白化: W = V_r Λ_r^{−1/2}，Wᵀ M W = I_r。
 *
 * 秩截断: 特征值 ≤ rankTol × λmax 的方向丢弃（默认 1e-10，近奇异方向
 * 不放大——高维小样本的安全带）。
 */
export function whiten(m: Matrix, rankTol = 1e-10): WhitenResult {
  const { rows, cols } = validateMatrix(m, 'whiten');
  if (rows !== cols) throw new Error(`whiten: 需要方阵（得到 ${rows}×${cols}）`);
  if (!(rankTol > 0) || !Number.isFinite(rankTol)) throw new Error(`whiten: rankTol 需为正有限数（得到 ${rankTol}）`);
  const eigen = jacobiEigen(m);
  const lambdaMax = eigen.values[0];
  if (!(lambdaMax > 0)) return { matrix: [], rank: 0, eigenvalues: eigen.values, tolerance: 0 };
  const threshold = rankTol * lambdaMax;
  const kept = eigen.values.map((v, i) => ({ v, i })).filter((e) => e.v > threshold);
  const n = rows;
  const r = kept.length;
  const w: number[][] = Array.from({ length: n }, () => new Array<number>(r).fill(0));
  for (let k = 0; k < r; k += 1) {
    const scale = 1 / Math.sqrt(kept[k].v);
    const vec = eigen.vectors[kept[k].i];
    for (let i = 0; i < n; i += 1) w[i][k] = vec[i] * scale;
  }
  return { matrix: w, rank: r, eigenvalues: eigen.values, tolerance: threshold };
}

// ─────────────────── 典型相关分析（CCA） ───────────────────

export interface CcaOptions {
  /** 岭正则强度 λ（加到 Σxx、Σyy 对角；缺省 0 = 普通 CCA） */
  l2?: number;
  /** 白化秩截断相对阈值（缺省 1e-10） */
  rankTol?: number;
}

/** CCA 结果（k = 第 k 对典型方向/变量；下标自 0 起，按 ρ 降序） */
export interface CcaResult {
  /** 典型相关 ρ₁ ≥ ρ₂ ≥ … ≥ 0（长度 min(rankX, rankY)） */
  canonicalCorrelations: number[];
  /** X 侧方向（xVectors[k] 长 p，口径 aᵀ(Σxx+λI)a = 1） */
  xVectors: number[][];
  /** Y 侧方向（yVectors[k] 长 q，口径 bᵀ(Σyy+λI)b = 1） */
  yVectors: number[][];
  /** X 侧典型变量得分（xScores[k] 长 n，样本方差 ≈ 1） */
  xScores: number[][];
  /** Y 侧典型变量得分（yScores[k] 长 n） */
  yScores: number[][];
  rankX: number;
  rankY: number;
  /** 使用的岭正则 λ */
  l2: number;
  n: number;
  p: number;
  q: number;
}

/**
 * 典型相关分析（CCA，可选岭正则）。
 *
 * X: n×p、Y: n×q（行 = 样本）。白化 + Jacobi 归约（见文件头数学节）。
 * 符号约定: xVectors[k] 最大绝对分量 ≥ 0，且 corr(xScores[k], yScores[k])
 * ≥ 0——同输入同输出（逐位确定）。秩亏侧（如全常數列）秩截断后诚实
 * 缩短典型相关谱；两侧秩均为 0 时返回空结果。
 */
export function cca(x: Matrix, y: Matrix, options?: CcaOptions): CcaResult {
  const l2 = options?.l2 ?? 0;
  if (!Number.isFinite(l2) || l2 < 0) throw new Error(`cca: l2 需为 ≥0 的有限数（得到 ${l2}）`);
  const rankTol = options?.rankTol ?? 1e-10;
  if (!(rankTol > 0) || !Number.isFinite(rankTol)) throw new Error(`cca: rankTol 需为正有限数（得到 ${rankTol}）`);
  const sx = validateMatrix(x, 'cca: X');
  const sy = validateMatrix(y, 'cca: Y');
  const n = sx.rows;
  const p = sx.cols;
  const q = sy.cols;
  if (sy.rows !== n) throw new Error(`cca: X 与 Y 行数需一致（${n} vs ${sy.rows}）`);
  if (n < 2) throw new Error(`cca: 至少需要 2 个样本（得到 ${n}）`);

  const xc = centerColumns(x).centered;
  const yc = centerColumns(y).centered;
  const sxx = crossCovariance(xc, xc);
  const syy = crossCovariance(yc, yc);
  const sxy = crossCovariance(xc, yc);
  if (l2 > 0) {
    for (let i = 0; i < p; i += 1) sxx[i][i] += l2;
    for (let j = 0; j < q; j += 1) syy[j][j] += l2;
  }

  const wx = whiten(sxx, rankTol);
  const wy = whiten(syy, rankTol);
  const rx = wx.rank;
  const ry = wy.rank;
  const m = Math.min(rx, ry);
  const empty: CcaResult = {
    canonicalCorrelations: [], xVectors: [], yVectors: [], xScores: [], yScores: [],
    rankX: rx, rankY: ry, l2, n, p, q,
  };
  if (m === 0) return empty;

  // K = Wxᵀ Σxy Wy（rx × ry）
  const kMat: number[][] = Array.from({ length: rx }, () => new Array<number>(ry).fill(0));
  for (let a = 0; a < rx; a += 1) {
    for (let b = 0; b < ry; b += 1) {
      let s = 0;
      for (let i = 0; i < p; i += 1) {
        const wxi = wx.matrix[i][a];
        if (wxi === 0) continue;
        const srow = sxy[i];
        let inner = 0;
        for (let j = 0; j < q; j += 1) inner += srow[j] * wy.matrix[j][b];
        s += wxi * inner;
      }
      kMat[a][b] = s;
    }
  }
  // G = K Kᵀ（rx × rx 对称半正定），ρ² = G 的特征值
  const g: number[][] = Array.from({ length: rx }, () => new Array<number>(rx).fill(0));
  for (let i = 0; i < rx; i += 1) {
    for (let j = i; j < rx; j += 1) {
      let s = 0;
      for (let b = 0; b < ry; b += 1) s += kMat[i][b] * kMat[j][b];
      g[i][j] = s;
      g[j][i] = s;
    }
  }
  const eigen = jacobiEigen(g);

  const canonicalCorrelations: number[] = [];
  const xVectors: number[][] = [];
  const yVectors: number[][] = [];
  const xScores: number[][] = [];
  const yScores: number[][] = [];

  for (let idx = 0; idx < m; idx += 1) {
    const rho = Math.sqrt(Math.min(1, Math.max(0, eigen.values[idx])));
    const u = eigen.vectors[idx];
    // a = Wx u（p 维），再钉死单位（正则化）协方差方差
    const aRaw = new Array<number>(p).fill(0);
    for (let i = 0; i < p; i += 1) {
      let s = 0;
      const row = wx.matrix[i];
      for (let a = 0; a < rx; a += 1) s += row[a] * u[a];
      aRaw[i] = s;
    }
    const va = quadForm(sxx, aRaw);
    const aScale = va > 1e-300 ? 1 / Math.sqrt(va) : 1;
    const a = aRaw.map((v) => v * aScale);
    // b: ρ > 0 时取 Wy·(Kᵀu/ρ)；ρ ≈ 0（私有噪声方向）取 Wy 第 idx 列的确定性退化口径
    let b: number[];
    if (rho > 1e-10) {
      // w = Kᵀu / ρ（ry 维）→ b = Wy w
      const w = new Array<number>(ry).fill(0);
      for (let b2 = 0; b2 < ry; b2 += 1) {
        let ktu = 0;
        for (let a = 0; a < rx; a += 1) ktu += kMat[a][b2] * u[a];
        w[b2] = ktu / rho;
      }
      const bRaw = new Array<number>(q).fill(0);
      for (let j = 0; j < q; j += 1) {
        let s = 0;
        const row = wy.matrix[j];
        for (let b2 = 0; b2 < ry; b2 += 1) s += row[b2] * w[b2];
        bRaw[j] = s;
      }
      const vb = quadForm(syy, bRaw);
      const bScale = vb > 1e-300 ? 1 / Math.sqrt(vb) : 1;
      b = bRaw.map((v) => v * bScale);
    } else {
      const bRaw = wy.matrix.map((row) => row[idx]);
      const vb = quadForm(syy, bRaw);
      const bScale = vb > 1e-300 ? 1 / Math.sqrt(vb) : 1;
      b = bRaw.map((v) => v * bScale);
    }
    // scores（中心化数据投影）
    const xs = xc.map((row) => {
      let s = 0;
      for (let j = 0; j < p; j += 1) s += row[j] * a[j];
      return s;
    });
    const ys = yc.map((row) => {
      let s = 0;
      for (let j = 0; j < q; j += 1) s += row[j] * b[j];
      return s;
    });
    // 符号约定: ① a 的最大绝对分量 ≥ 0（a、b、xs、ys 同翻）② corr(xs,ys) ≥ 0（只翻 b 侧）
    let maxIdx = 0;
    for (let j = 1; j < p; j += 1) if (Math.abs(a[j]) > Math.abs(a[maxIdx])) maxIdx = j;
    if (a[maxIdx] < 0) {
      for (let j = 0; j < p; j += 1) a[j] = -a[j];
      for (let j = 0; j < q; j += 1) b[j] = -b[j];
      for (let i2 = 0; i2 < n; i2 += 1) {
        xs[i2] = -xs[i2];
        ys[i2] = -ys[i2];
      }
    }
    let cross = 0;
    for (let i2 = 0; i2 < n; i2 += 1) cross += xs[i2] * ys[i2];
    if (cross < 0) {
      for (let j = 0; j < q; j += 1) b[j] = -b[j];
      for (let i2 = 0; i2 < n; i2 += 1) ys[i2] = -ys[i2];
    }
    canonicalCorrelations.push(rho);
    xVectors.push(a);
    yVectors.push(b);
    xScores.push(xs);
    yScores.push(ys);
  }
  return { canonicalCorrelations, xVectors, yVectors, xScores, yScores, rankX: rx, rankY: ry, l2, n, p, q };
}

/**
 * 岭正则 CCA: (Σxx + λI) / (Σyy + λI) 白化口径。
 *
 * p + q > n（高维小样本）时样本协方差秩亏、无正则 CCA 的白化放大噪声
 * 方向（典型相关谱塌向 1）；λ > 0 恒有有限解。λ = 0 等价 cca(X, Y)。
 */
export function ridgeCCA(x: Matrix, y: Matrix, lambda: number): CcaResult {
  if (!Number.isFinite(lambda) || lambda < 0) throw new Error(`ridgeCCA: lambda 需为 ≥0 的有限数（得到 ${lambda}）`);
  return cca(x, y, { l2: lambda });
}

// ─────────────────── R5: 核典型相关分析（kernel CCA） ───────────────────

export interface KernelCcaOptions {
  /** 核类型: 'rbf'（缺省）| 'poly' | 'linear' */
  kernel?: 'rbf' | 'poly' | 'linear';
  /** X 侧高斯带宽（缺省: X 成对距离的中位数——确定性启发式） */
  sigmaX?: number;
  /** Y 侧高斯带宽（缺省: Y 成对距离的中位数） */
  sigmaY?: number;
  /** 多项式核次数（缺省 2；仅 poly 生效） */
  degree?: number;
  /** 岭正则 λ（加到中心化 Gram 对角；缺省 1e-2——核空间维数 = n，正则是必需品） */
  l2?: number;
  /** 白化秩截断（缺省 1e-10） */
  rankTol?: number;
}

/** 核 CCA 结果（对偶系数口径: 第 k 对典型变量 f_k = Σᵢ αᵏᵢ k(xᵢ, ·)） */
export interface KernelCcaResult {
  /** 典型相关 ρ₁ ≥ ρ₂ ≥ … ≥ 0 */
  canonicalCorrelations: number[];
  /** 训练样本上的 X 侧典型变量得分（xScores[k][t]） */
  xScores: number[][];
  /** 训练样本上的 Y 侧典型变量得分 */
  yScores: number[][];
  /** X 侧对偶系数（xDual[k] 长 n） */
  xDual: number[][];
  /** Y 侧对偶系数 */
  yDual: number[][];
  kernel: 'rbf' | 'poly' | 'linear';
  sigmaX: number;
  sigmaY: number;
  l2: number;
  n: number;
}

/** 成对欧氏距离的中位数（确定性带宽启发式） */
function medianPairwiseDistance(m: Matrix): number {
  const { rows, cols } = validateMatrix(m, 'medianPairwiseDistance');
  const dists: number[] = [];
  for (let i = 0; i < rows; i += 1) {
    for (let j = i + 1; j < rows; j += 1) {
      let s = 0;
      for (let k = 0; k < cols; k += 1) {
        const d = m[i][k] - m[j][k];
        s += d * d;
      }
      dists.push(Math.sqrt(s));
    }
  }
  if (dists.length === 0) return 1;
  dists.sort((a, b) => a - b);
  const mid = dists.length >> 1;
  return dists.length % 2 === 1 ? dists[mid] : (dists[mid - 1] + dists[mid]) / 2;
}

/** 核矩阵（对称、对角 k(x,x) 口径） */
function gramMatrix(m: Matrix, kernel: 'rbf' | 'poly' | 'linear', sigma: number, degree: number): number[][] {
  const { rows, cols } = validateMatrix(m, 'kernelCCA');
  const k: number[][] = Array.from({ length: rows }, () => new Array<number>(rows).fill(0));
  for (let i = 0; i < rows; i += 1) {
    for (let j = i; j < rows; j += 1) {
      let dot = 0;
      for (let t = 0; t < cols; t += 1) dot += m[i][t] * m[j][t];
      let v: number;
      if (kernel === 'linear') v = dot;
      else if (kernel === 'poly') v = Math.pow(1 + dot, degree);
      else v = Math.exp(-dot / (2 * sigma * sigma));
      k[i][j] = v;
      k[j][i] = v;
    }
  }
  return k;
}

/** RKHS 中心化（双重中心化 H K H; H = I − 11ᵀ/n） */
function centerGram(k: Matrix): number[][] {
  const n = k.length;
  const rowMean = k.map((row) => row.reduce((s, v) => s + v, 0) / n);
  let grand = 0;
  for (const v of rowMean) grand += v / n;
  return k.map((row, i) => row.map((v, j) => v - rowMean[i] - rowMean[j] + grand));
}

/**
 * 核典型相关分析（KCCA; Akaho 2001 / Bach–Jordan 2002 口径）。
 *
 * 归约: 核映射后的 CCA = 中心化 Gram 阵（视为 n 样本 × n 特征的数据
 * 阵）上的岭 CCA——典型变量 f = Σ αᵢ k(xᵢ, ·) 的对偶系数就是 cca 的
 * 方向向量，全套白化/符号/秩截断口径与线性版一致。线性核时 ρ 谱与
 * cca(X, Y) 一致（min-rank 截断内——口径不变性锚点）；高斯核捕捉
 * 任意泛函依赖（Y = X² 的经典对照）。
 */
export function kernelCCA(x: Matrix, y: Matrix, options?: KernelCcaOptions): KernelCcaResult {
  const kernel = options?.kernel ?? 'rbf';
  if (kernel !== 'rbf' && kernel !== 'poly' && kernel !== 'linear') {
    throw new Error(`kernelCCA: kernel 需为 'rbf' | 'poly' | 'linear'（得到 ${kernel}）`);
  }
  const sx = validateMatrix(x, 'kernelCCA: X');
  const sy = validateMatrix(y, 'kernelCCA: Y');
  const n = sx.rows;
  if (sy.rows !== n) throw new Error(`kernelCCA: X 与 Y 行数需一致（${n} vs ${sy.rows}）`);
  const sigmaX = options?.sigmaX ?? medianPairwiseDistance(x);
  const sigmaY = options?.sigmaY ?? medianPairwiseDistance(y);
  if (kernel === 'rbf') {
    if (!(sigmaX > 0) || !Number.isFinite(sigmaX)) throw new Error(`kernelCCA: sigmaX 需为正有限数（得到 ${sigmaX}）`);
    if (!(sigmaY > 0) || !Number.isFinite(sigmaY)) throw new Error(`kernelCCA: sigmaY 需为正有限数（得到 ${sigmaY}）`);
  }
  const degree = options?.degree ?? 2;
  if (!Number.isInteger(degree) || degree < 1 || degree > 4) {
    throw new Error(`kernelCCA: degree 需为 1..4 的整数（得到 ${degree}）`);
  }
  const l2 = options?.l2 ?? 1e-2;
  if (!Number.isFinite(l2) || l2 < 0) throw new Error(`kernelCCA: l2 需为 ≥0 的有限数（得到 ${l2}）`);
  const kx = centerGram(gramMatrix(x, kernel, sigmaX, degree));
  const ky = centerGram(gramMatrix(y, kernel, sigmaY, degree));
  const res = cca(kx, ky, { l2, rankTol: options?.rankTol ?? 1e-10 });
  const m = res.canonicalCorrelations.length;
  return {
    canonicalCorrelations: res.canonicalCorrelations,
    xScores: res.xScores.slice(0, m),
    yScores: res.yScores.slice(0, m),
    xDual: res.xVectors,
    yDual: res.yVectors,
    kernel,
    sigmaX,
    sigmaY,
    l2,
    n,
  };
}

/* ── 接线建议 ──
 * 挂载引擎: 世界模型（多源证据融合）+ 记忆系统（跨表示检索）
 * 1. 世界模型异构证据对齐（56.0 置信传播的连续版前置）: 各模型评分面板
 *    为 X（模型 × 任务特征）、多源信号特征为 Y（信号 × 任务快照），
 *    cca() 给出公共潜坐标系——canonicalCorrelations 是「两源共享多少
 *    信息」的谱（高 ρ 方向 = 共享因子，低 ρ = 私有噪声）；证据融合先
 *    投影到典型变量（xScores/yScores）再做加权，替代异构列硬拼接。
 * 2. 记忆跨表示检索: 同一经验的两种表示（摘要向量 / 行为轨迹特征）做
 *    CCA，xVectors/yVectors 是互译字典——用 A 表示存的记忆可以被 B
 *    表示的查询检索（跨表示语义对齐）。
 * 3. 高维小样本护栏: 观测少而特征多（早期积累期）一律走 ridgeCCA
 *    （λ 取 0.5~1 起步），并检查 rankX/rankY 与谱形状——min(rank) 个
 *    全 ≈1 的谱是过拟合警报而非「完美相关」。
 * 4. 缺省关闭旗标: config.kernels.ccaEnabled = false（未开启时上述
 *    路径零介入——纯分析内核只读）。
 * 5. 挂载后改变的决策点: ①多源证据融合权重（从各源独立打分变为典型
 *    变量空间联合加权——私有噪声方向自动降权）；②记忆检索入口（从
 *    单表示相似变为跨表示典型变量对齐）；③证据源可信度（某源的典型
 *    相关谱整体塌陷 = 该源与其余世界模型脱锚，触发校准/下线检查）。
 */
