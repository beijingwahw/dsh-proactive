/**
 * 79.0 流形学习内核 —— 扩散映射：经验流形的内在坐标（谱方法双件套之「找内在坐标」）
 *
 * 动机: 高维观测（模型评分面板、信号特征、表示向量）大多躺在低维流形
 * 上——采样时的自由参数只有几个，其余维度都是它们的函数加噪声。在
 * 原始欧氏空间做距离/密度/检索（76.0 新奇检测、69.0 Mapper 的输入）
 * 会被「流形的弯曲」欺骗：瑞士卷上相邻两圈的点欧氏距离很近、内在距离
 * 却很远。扩散映射（Coifman–Lafon 2006）用**扩散过程定义流形上的
 * 距离**，再把流形等距嵌入低维欧氏空间：
 *
 *   kNN 图 + 高斯核（全局带宽 σ 或局部自适应 σᵢ = 第 k 近邻距离）
 *   → 对称归一化 W~ = D^{−1/2} W D^{−1/2}（随机游走的对称化转移）
 *   → 特征分解 W~ = Σ λₗ ψₗψₗᵀ（λ₁ ≈ 1 平凡常数向量；不相连分量
 *     使 λ ≈ 1 的重数 = 分量数——谱定连通性）
 *   → 扩散映射 Ψₜ(x) = (λₗ^{t/2} ψₗ(x))ₗ（跳过平凡分量）
 *   → 扩散距离 Dₜ(x,y)² = Σₗ λₗᵗ (ψₗ(x) − ψₗ(y))² ≈ 嵌入欧氏距离²
 *     （保距性质: 嵌入距离就是截断谱的扩散距离——流形几何第一次有了
 *     忠实的低维坐标，簇数、密度、测地结构都在谱里）
 *
 * 数值: 特征分解文件内自实现——小图（n ≤ 320）全谱循环 Jacobi 旋转
 * （对称矩阵二次收敛到机器精度）；大图块子空间迭代（种子化确定性初始
 * + Rayleigh–Ritz，内部仍用 Jacobi）——两种路径同输入同输出。带宽是
 * 本方法的第一敏感参数，诚实口径: σ 过小 → 核在采样间距以下看不见
 * 任何邻居（权重下溢）→ 图碎片化；σ 过大 → 簇间边权与簇内无异 →
 * 两簇粘连、多重 1 消失（验证锚点⑤两个方向都有构造例）。附带
 * Isomap-lite（Floyd–Warshall 测地距 + 古典 MDS）作对照口径。
 *
 * 验证锚点（scripts/verify-alignment-manifold.mjs，全部确定性断言）:
 *   ① 瑞士卷 800 点（种子化）: 扩散嵌入第一非平凡坐标与真实内在参数
 *      （卷曲弧长 t）|corr| > 0.95——弯曲流形的内在坐标被找回;
 *   ② 两新月 300 点: 嵌入空间最近质心分类 100%（两月牙在扩散坐标
 *      下线性可分，而在原始欧氏空间互锁）;
 *   ③ 不相连两簇: λ ≈ 1 重数 = 2（nComponents=2）、最大谱隙落在第
 *      2 个特征值后（gapIndex=2）、非平凡特征向量符号 100% 分簇;
 *   ④ 扩散距离 vs 嵌入距离: ≥100 对采样点的秩相关 > 0.9（保距性质;
 *      两新月全谱精确口径 + 瑞士卷截断谱口径双份）;
 *   ⑤ 带宽敏感性: σ=0.01 → 权重下溢、图完全碎片（诚实报告孤立点）；
 *      σ=100 → 两簇粘连（多重 1 消失、gapIndex 回退到 1）——两个
 *      失败方向各一个构造例。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入
 *
 * R5-A11 进化（四轴）:
 *   [数学/性能] diffusionScaleSweep——多尺度扩散 t 扫描: t 是扩散的
 *     「放大镜倍率」（t 小看簇内密度、t 大看簇间连通）。kNN/核/特征
 *     分解只做一次，T 个 t 值共享同一谱（与逐个 diffusionMaps(t) 逐位
 *     一致——verify 等价锚点），成本 O(分解) + O(T·n·dims) 而非
 *     O(T·分解)（verify 计时对照）。簇间/簇内扩散距离分辨率随 t 单调
 *     上升（verify 性质锚点）——尺度-结构曲线替代单点口径。
 *   [数学] landmarkDiffusion——地标扩散（Nyström 外推; Vladymyrov–
 *     Carreira-Perpiñán 风格）: 确定性最远点采样 ℓ 个地标 → 小算子
 *     （ℓ×ℓ，全谱 Jacobi）→ 任意点 ψ_l(x) = (1/λ_l)Σ_m w̃(x,l_m)ψ_l(l_m)
 *     外推。地标点的外推与特征向量**精确**一致（σ 口径对齐——verify
 *     自洽锚点）；嵌入与全谱版在流形基准上 |corr| > 0.9；成本
 *     O(n·ℓ²) ≪ O(n³)——大点集第一次有可扩产的保距口径。
 *   [数值稳健性] 谱半径护栏（|λ| ≤ 1 + 1e-9 的 verify 锚点）；地标
 *     退化（重复点/全零核行）诚实报告 isolated 而非崩溃；最远点采样
 *     平局取小下标（确定性）。
 */

// ─────────────────── 确定性随机源（mulberry32 + Box–Muller） ───────────────────

/** mulberry32: 32 位确定性伪随机源（种子固定时序列逐位可复现，零外部随机源） */
export function mulberry32(seed: number): () => number {
  if (!Number.isFinite(seed)) throw new Error(`mulberry32: seed 必须为有限数（得到 ${seed}）`);
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller 标准正态采样器（配 mulberry32；同随机源状态同输出） */
export function gaussianSampler(rng: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u1 = rng();
    while (u1 <= 1e-12) u1 = rng();
    const u2 = rng();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    spare = r * Math.sin(theta);
    return r * Math.cos(theta);
  };
}

// ─────────────────── 距离与 kNN 图 ───────────────────

type PointCloud = ReadonlyArray<ReadonlyArray<number>>;

function validatePointCloud(points: PointCloud, name: string): { n: number; dim: number } {
  if (!Array.isArray(points) || points.length === 0) throw new Error(`${name}: 需要非空二维点集（得到长度 ${points.length}）`);
  const dim = points[0].length;
  if (!Number.isInteger(dim) || dim < 1) throw new Error(`${name}: 维度需为 ≥1 的整数（得到 ${dim}）`);
  for (let i = 0; i < points.length; i += 1) {
    const row = points[i];
    if (!Array.isArray(row) || row.length !== dim) throw new Error(`${name}: 第 ${i} 点维度 ${row?.length} ≠ 首点 ${dim}（需一致）`);
    for (let j = 0; j < dim; j += 1) {
      const v = row[j];
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name}: 点 ${i} 的第 ${j} 分量 ${v} 不是有限数`);
    }
  }
  return { n: points.length, dim };
}

/** 全对称欧氏距离矩阵（对角 0） */
export function pairwiseDistances(points: PointCloud): number[][] {
  const { n, dim } = validatePointCloud(points, 'pairwiseDistances');
  const out: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      let s = 0;
      for (let k = 0; k < dim; k += 1) {
        const d = points[i][k] - points[j][k];
        s += d * d;
      }
      const dist = Math.sqrt(s);
      out[i][j] = dist;
      out[j][i] = dist;
    }
  }
  return out;
}

/** kNN 图：neighbors[i] 为第 i 点的 k 近邻（不含自身，按距离升序、平手按下标升序） */
export interface KnnGraph {
  n: number;
  dim: number;
  k: number;
  neighbors: Array<Array<{ index: number; distance: number }>>;
}

export function knnGraph(points: PointCloud, k: number): KnnGraph {
  const { n, dim } = validatePointCloud(points, 'knnGraph');
  if (!Number.isInteger(k) || k < 1 || k > n - 1) throw new Error(`knnGraph: k 需为 1..n−1 的整数（n=${n}，得到 ${k}）`);
  const dist = pairwiseDistances(points);
  const neighbors: Array<Array<{ index: number; distance: number }>> = [];
  for (let i = 0; i < n; i += 1) {
    const cand = Array.from({ length: n }, (_, j) => ({ index: j, distance: dist[i][j] })).filter((c) => c.index !== i);
    cand.sort((a, b) => a.distance - b.distance || a.index - b.index);
    neighbors.push(cand.slice(0, k));
  }
  return { n, dim, k, neighbors };
}

// ─────────────────── 对称特征分解（flat Jacobi / 块子空间迭代） ───────────────────

/** n ≤ 此值走全谱 Jacobi（O(n³) 但精确谱隙）；更大走块子空间迭代 */
const JACOBI_FULL_MAX = 320;
/** 古典 MDS 需要全谱（不定矩阵），超过此规模诚实拒绝 */
const MDS_MAX = 400;

/**
 * 循环 Jacobi 对称特征分解（flat 行主序；A = V·diag(values)·Vᵀ）。
 * values 降序；vectors[k] 为第 k 个单位特征向量。只读上三角（对称口径）。
 */
function jacobiFlat(aIn: Float64Array, n: number, maxSweeps = 40, tol = 1e-12): { values: number[]; vectors: number[][] } {
  const a = Float64Array.from(aIn);
  const q = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) q[i * n + i] = 1;
  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let offDiag = 0;
    for (let p = 0; p < n; p += 1) for (let s = p + 1; s < n; s += 1) offDiag += a[p * n + s] * a[p * n + s];
    if (offDiag <= tol * tol) break;
    for (let p = 0; p < n - 1; p += 1) {
      for (let s = p + 1; s < n; s += 1) {
        const aps = a[p * n + s];
        if (Math.abs(aps) < 1e-300) continue;
        const theta = (a[s * n + s] - a[p * n + p]) / (2 * aps);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cos = 1 / Math.sqrt(t * t + 1);
        const sin = t * cos;
        for (let k = 0; k < n; k += 1) {
          const kp = k * n + p;
          const ks = k * n + s;
          const akp = a[kp];
          const aks = a[ks];
          a[kp] = cos * akp - sin * aks;
          a[ks] = sin * akp + cos * aks;
        }
        const pn = p * n;
        const sn = s * n;
        for (let k = 0; k < n; k += 1) {
          const pk = pn + k;
          const sk = sn + k;
          const apk = a[pk];
          const ask = a[sk];
          a[pk] = cos * apk - sin * ask;
          a[sk] = sin * apk + cos * ask;
        }
        for (let k = 0; k < n; k += 1) {
          const kp = k * n + p;
          const ks = k * n + s;
          const qkp = q[kp];
          const qks = q[ks];
          q[kp] = cos * qkp - sin * qks;
          q[ks] = sin * qkp + cos * qks;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => ({ v: a[i * n + i], i })).sort((x, y) => y.v - x.v);
  return {
    values: order.map((o) => o.v),
    vectors: order.map((o) => Array.from({ length: n }, (_, i) => q[i * n + o.i])),
  };
}

/** 列正交化（修正 Gram–Schmidt，两遍再正交；退化列用确定性模式替换） */
function orthonormalizeColumns(z: Float64Array, n: number, m: number): void {
  for (let pass = 0; pass < 2; pass += 1) {
    for (let j = 0; j < m; j += 1) {
      const base = j * n;
      for (let i = 0; i < j; i += 1) {
        const ib = i * n;
        let r = 0;
        for (let k = 0; k < n; k += 1) r += z[ib + k] * z[base + k];
        for (let k = 0; k < n; k += 1) z[base + k] -= r * z[ib + k];
      }
      let norm = 0;
      for (let k = 0; k < n; k += 1) norm += z[base + k] * z[base + k];
      norm = Math.sqrt(norm);
      if (norm < 1e-8) {
        if (pass === 0) continue; // 第二遍再处理
        for (let k = 0; k < n; k += 1) z[base + k] = Math.sin(0.7 * (k + 1) + 1.3 * (j + 2) + 0.11);
        for (let i = 0; i < j; i += 1) {
          const ib = i * n;
          let r = 0;
          for (let k = 0; k < n; k += 1) r += z[ib + k] * z[base + k];
          for (let k = 0; k < n; k += 1) z[base + k] -= r * z[ib + k];
        }
        norm = 0;
        for (let k = 0; k < n; k += 1) norm += z[base + k] * z[base + k];
        norm = Math.sqrt(norm);
        if (norm < 1e-8) throw new Error('diffusionMaps: 子空间正交化退化（内部错误）');
      }
      for (let k = 0; k < n; k += 1) z[base + k] /= norm;
    }
  }
}

/**
 * 对称矩阵前 m 大特征对。
 *
 * 小矩阵全谱 Jacobi；大矩阵块子空间迭代（确定性种子初始 + Rayleigh–
 * Ritz，收敛判据: 前 need 个 Ritz 值稳定到 1e-12 或 maxIter 用尽——
 * need 之外的谱尾只保证 Rayleigh 残差有界，用于距离/间隙的截断口径）。
 */
function topEigenFlat(a: Float64Array, n: number, m: number, need: number): { values: number[]; vectors: number[][] } {
  if (n <= JACOBI_FULL_MAX) {
    const full = jacobiFlat(a, n);
    return { values: full.values.slice(0, m), vectors: full.vectors.slice(0, m) };
  }
  const rng = mulberry32(0x9e3779b9);
  const gauss = gaussianSampler(rng);
  let z = new Float64Array(n * m);
  for (let j = 0; j < m; j += 1) for (let i = 0; i < n; i += 1) z[j * n + i] = gauss();
  orthonormalizeColumns(z, n, m);
  const small = new Float64Array(m * m);
  let theta = new Float64Array(m);
  let eigSmall: { values: number[]; vectors: number[][] } | null = null;
  let converged = false;
  const maxIter = 500;
  for (let iter = 0; iter < maxIter && !converged; iter += 1) {
    // az = A·z（列主序 z：第 j 列在 z[j*n .. j*n+n)）
    const az = new Float64Array(n * m);
    for (let i = 0; i < n; i += 1) {
      const arow = i * n;
      for (let j = 0; j < m; j += 1) {
        const zcol = j * n;
        let s = 0;
        for (let k = 0; k < n; k += 1) s += a[arow + k] * z[zcol + k];
        az[j * n + i] = s;
      }
    }
    if ((iter + 1) % 10 === 0 || iter === maxIter - 1) {
      for (let i = 0; i < m; i += 1) {
        for (let j = i; j < m; j += 1) {
          let s = 0;
          const ic = i * n;
          const jc = j * n;
          for (let k = 0; k < n; k += 1) s += z[ic + k] * az[jc + k];
          small[i * m + j] = s;
          small[j * m + i] = s;
        }
      }
      const es = jacobiFlat(small, m);
      let deltaNeed = 0;
      let deltaAll = 0;
      for (let i = 0; i < m; i += 1) {
        const d = Math.abs(es.values[i] - theta[i]);
        if (i < need) deltaNeed = Math.max(deltaNeed, d);
        deltaAll = Math.max(deltaAll, d);
      }
      theta = Float64Array.from(es.values);
      eigSmall = es;
      if (deltaNeed < 1e-12 || deltaAll < 1e-10) converged = true;
      else z = az; // 未收敛才推进子空间
    } else {
      z = az;
    }
    if (!converged) orthonormalizeColumns(z, n, m);
  }
  const es = eigSmall ?? jacobiFlat(small, m);
  // Ritz 向量: v_i = Z·s_i（Z 与 B = ZᵀAZ 一致——收敛点未推进 z）
  const vectors = es.values.map((_, i) => {
    const out = new Array<number>(n).fill(0);
    for (let c = 0; c < m; c += 1) {
      const sc = es.vectors[i][c];
      if (sc === 0) continue;
      const base = c * n;
      for (let k = 0; k < n; k += 1) out[k] += z[base + k] * sc;
    }
    return out;
  });
  return { values: [...es.values], vectors };
}

// ─────────────────── 扩散映射 ───────────────────

export interface DiffusionMapsOptions {
  /** kNN 邻居数（缺省 10） */
  k?: number;
  /** 全局高斯带宽 σ；缺省走局部自适应（σᵢ = 第 k 近邻距离，Zelnik–Manor 口径） */
  sigma?: number;
  /** 扩散时间 t（λ^t 加权；缺省 1） */
  t?: number;
  /** 嵌入维数（缺省 2） */
  dims?: number;
  /** 计算的特征对个数（缺省 max(dims+8, 16)，截断谱距离口径用） */
  eigenCount?: number;
}

export interface DiffusionMapsResult {
  /** n×dims 嵌入（坐标 = λ^{t/2}·ψ，跳过平凡常数分量） */
  embedding: number[][];
  /** 计算谱的特征值（降序，含平凡 λ₁≈1） */
  eigenvalues: number[];
  /** 对应特征向量（vectors[l][i] = ψₗ(xᵢ)；确定性符号：最大绝对分量 ≥ 0） */
  eigenvectors: number[][];
  /** 平凡（≈常数）特征向量下标（嵌入与扩散距离都跳过） */
  trivialIndices: number[];
  /** 最大相对谱隙 (λᵢ−λᵢ₊₁)/(1−λᵢ₊₁)，i 在 2..min(谱宽−1, 24) 内搜索（簇数口径） */
  spectralGap: number;
  /** 最大相对谱隙位置（1 基：第 gapIndex 个特征值之后；2 = 前 2 个 λ≈1 后大跌 → 2 簇；0 = 谱太短） */
  gapIndex: number;
  /** 连通分量数（λ > 1−1e-6 的个数 + 孤立点；受限于计算谱宽度） */
  nComponents: number;
  /** 孤立点（行和 ≈ 0，带宽过小的诚实标记）下标 */
  isolated: number[];
  /** 局部自适应带宽 σᵢ（全局模式下为空数组） */
  localScale: number[];
  sigmaMode: 'adaptive' | 'global';
  t: number;
  k: number;
  dims: number;
}

/**
 * 扩散映射（Coifman–Lafon 2006）。
 *
 * kNN 稀疏高斯核 → 对称归一化 D^{−1/2}WD^{−1/2} → 特征分解 → Ψₜ。
 * 同输入同输出（大图子空间迭代用固定种子初始）。带宽过小导致全孤立时
 * 诚实返回 isolated 列表与全零核谱（nComponents = n）。
 */
export function diffusionMaps(points: PointCloud, options?: DiffusionMapsOptions): DiffusionMapsResult {
  const { n } = validatePointCloud(points, 'diffusionMaps');
  const k = options?.k ?? 10;
  if (!Number.isInteger(k) || k < 1 || k > n - 1) throw new Error(`diffusionMaps: k 需为 1..n−1 的整数（n=${n}，得到 ${k}）`);
  const t = options?.t ?? 1;
  if (!Number.isFinite(t) || t < 0) throw new Error(`diffusionMaps: t 需为 ≥0 的有限数（得到 ${t}）`);
  const dims = options?.dims ?? 2;
  if (!Number.isInteger(dims) || dims < 1 || dims > n - 1) throw new Error(`diffusionMaps: dims 需为 1..n−1 的整数（n=${n}，得到 ${dims}）`);
  const sigma = options?.sigma;
  let globalSigma = 0; // 0 = 局部自适应；>0 = 全局带宽
  if (sigma !== undefined) {
    if (!Number.isFinite(sigma) || sigma <= 0) throw new Error(`diffusionMaps: sigma 需为正有限数（得到 ${sigma}）`);
    globalSigma = sigma;
  }
  const eigenCount = Math.min(options?.eigenCount ?? Math.max(dims + 8, 16), n);
  if (!Number.isInteger(eigenCount) || eigenCount < dims + 1 || eigenCount > n) {
    throw new Error(`diffusionMaps: eigenCount 需为 dims+1..n 的整数（dims=${dims}, n=${n}，得到 ${eigenCount}）`);
  }

  const graph = knnGraph(points, k);
  const dist = pairwiseDistances(points);
  // 局部自适应带宽：σᵢ = 第 k 近邻距离（下溢保护）
  const localScale = Array.from({ length: n }, (_, i) => Math.max(graph.neighbors[i][k - 1].distance, 1e-12));
  // kNN 邻接（OR 对称化）
  const adjacent = new Uint8Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (const nb of graph.neighbors[i]) adjacent[i * n + nb.index] = 1;
  }
  const symAdjacent = new Uint8Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (adjacent[i * n + j] === 1 || adjacent[j * n + i] === 1) {
        symAdjacent[i * n + j] = 1;
        symAdjacent[j * n + i] = 1;
      }
    }
  }
  // 高斯核权重（对称）；全局: exp(−d²/2σ²)，自适应: exp(−d²/(σᵢσⱼ))
  const w = new Float64Array(n * n);
  const rowSum = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (symAdjacent[i * n + j] === 0) continue;
      const d2 = dist[i][j] * dist[i][j];
      const val = globalSigma > 0 ? Math.exp(-d2 / (2 * globalSigma)) : Math.exp(-d2 / (localScale[i] * localScale[j]));
      w[i * n + j] = val;
      w[j * n + i] = val;
      rowSum[i] += val;
      rowSum[j] += val;
    }
  }
  // 孤立点（带宽过小 → 全部核权重下溢为 0）
  const isolated: number[] = [];
  for (let i = 0; i < n; i += 1) if (rowSum[i] < 1e-12) isolated.push(i);
  // 对称归一化 D^{−1/2} W D^{−1/2}
  const scale = Array.from({ length: n }, (_, i) => (rowSum[i] > 1e-12 ? 1 / Math.sqrt(rowSum[i]) : 0));
  const wt = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) wt[i * n + j] = scale[i] * w[i * n + j] * scale[j];
  }
  // 特征分解（小图全谱 / 大图子空间）
  const eigen = topEigenFlat(wt, n, eigenCount, Math.min(eigenCount, dims + 6));
  let values = eigen.values;
  let vectors = eigen.vectors;

  // λ≈1 重数 ≥2（不相连或近断开）：本征空间内任意正交基都可能不含「准常数」
  // 方向——显式旋转出「准常数方向 + 与其正交的补空间」（补空间成员在两
  // 分量上分段常数且符号互反 → 符号可分簇），谱值统一钉在 1。
  // 注: 对称归一化的平凡向量 ∝ D^{1/2}·1（局部度均匀时 ≈ 常数），判据用
  // |⟨v, 1/√n⟩| 的「准常数」口径而非逐位常数。
  const invSqrtN = 1 / Math.sqrt(n);
  const trivialGroup: number[] = [];
  for (let i = 0; i < values.length && values[i] > 1 - 1e-6; i += 1) trivialGroup.push(i);
  let trivialIndices: number[] = [];
  if (trivialGroup.length >= 2) {
    const pe = new Array<number>(n).fill(0);
    for (const gi of trivialGroup) {
      const v = vectors[gi];
      let c = 0;
      for (let i = 0; i < n; i += 1) c += v[i] * invSqrtN;
      if (c === 0) continue;
      for (let i = 0; i < n; i += 1) pe[i] += c * v[i];
    }
    let nrm = 0;
    for (let i = 0; i < n; i += 1) nrm += pe[i] * pe[i];
    nrm = Math.sqrt(nrm);
    if (nrm > 0.5) {
      const peUnit = pe.map((v) => v / nrm);
      const complement: number[][] = [];
      for (const gi of trivialGroup) {
        const v = vectors[gi];
        let c = 0;
        for (let i = 0; i < n; i += 1) c += v[i] * peUnit[i];
        const u = v.map((x, i) => x - c * peUnit[i]);
        // 对已收集补向量正交化（MGS）
        for (const prev of complement) {
          let r = 0;
          for (let i = 0; i < n; i += 1) r += prev[i] * u[i];
          for (let i = 0; i < n; i += 1) u[i] -= r * prev[i];
        }
        let un = 0;
        for (let i = 0; i < n; i += 1) un += u[i] * u[i];
        un = Math.sqrt(un);
        if (un > 1e-8) complement.push(u.map((x) => x / un));
      }
      const rest = vectors.slice(trivialGroup.length);
      values = [1, ...Array.from({ length: complement.length }, () => 1), ...rest.map((_, i) => values[trivialGroup.length + i])];
      vectors = [peUnit, ...complement, ...rest];
      trivialIndices = [0];
    }
  } else if (trivialGroup.length === 1) {
    const v = vectors[0];
    let c = 0;
    for (let i = 0; i < n; i += 1) c += v[i] * invSqrtN;
    if (Math.abs(c) > 0.98) trivialIndices = [0];
  }
  // 全零核（带宽过小全孤立）：trivialGroup 为空 → 无平凡标记，嵌入取零向量（诚实退化）
  // 确定性符号: 每个特征向量最大绝对分量 ≥ 0
  for (const v of vectors) {
    let maxIdx = 0;
    for (let i = 1; i < n; i += 1) if (Math.abs(v[i]) > Math.abs(v[maxIdx])) maxIdx = i;
    if (v[maxIdx] < 0) for (let i = 0; i < n; i += 1) v[i] = -v[i];
  }

  // 嵌入: 跳过平凡分量，取前 dims 个 λ^{t/2}·ψ
  const embedding: number[][] = Array.from({ length: n }, () => new Array<number>(dims).fill(0));
  let col = 0;
  for (let l = 0; l < vectors.length && col < dims; l += 1) {
    if (trivialIndices.includes(l)) continue;
    const weight = Math.pow(Math.max(values[l], 0), t / 2);
    const v = vectors[l];
    for (let i = 0; i < n; i += 1) embedding[i][col] = weight * v[i];
    col += 1;
  }
  // 相对谱隙（簇数口径）: 在 i ∈ [2, min(谱宽−1, 24)]（1 基）内找最大相对
  // 跌落 (λᵢ − λᵢ₊₁)/(1 − λᵢ₊₁)——相对口径压制谱尾截断的伪隙、并天然
  // 偏向「λ≈1 段之后的大跌」（2 簇 → 第 2 个后大跌 → gapIndex = 2）。
  let spectralGap = 0;
  let gapIndex = 0;
  const gapSearchMax = Math.min(values.length - 1, 24);
  for (let i = 1; i < gapSearchMax; i += 1) {
    // i 为 0 基下标 → 对应 1 基第 i+1 个；从第 2 个（i=1）起搜
    const drop = values[i] - values[i + 1];
    const rel = drop / (1 - values[i + 1] + 1e-15);
    if (rel > spectralGap) {
      spectralGap = rel;
      gapIndex = i + 1;
    }
  }
  let nComp = isolated.length;
  for (const v of values) if (v > 1 - 1e-6) nComp += 1;
  // 孤立点被谱数过一次（零行不产生 λ≈1）——上面 isolated 直接计入，λ≈1 只数非孤立的分量
  return {
    embedding,
    eigenvalues: values,
    eigenvectors: vectors,
    trivialIndices,
    spectralGap,
    gapIndex,
    nComponents: nComp,
    isolated,
    localScale: globalSigma > 0 ? [] : localScale,
    sigmaMode: globalSigma > 0 ? 'global' : 'adaptive',
    t,
    k,
    dims,
  };
}

/**
 * 扩散距离 Dₜ(i,j) = √(Σₗ λₗᵗ (ψₗ(i) − ψₗ(j))²)（跳过平凡分量，
 * 截断到 result 返回的谱——嵌入欧氏距离是其 dims 维截断，保距口径）。
 */
export function diffusionDistance(result: DiffusionMapsResult, i: number, j: number): number {
  const n = result.embedding.length;
  if (!Number.isInteger(i) || i < 0 || i >= n || !Number.isInteger(j) || j < 0 || j >= n) {
    throw new Error(`diffusionDistance: 下标需在 0..${n - 1}（得到 ${i}, ${j}）`);
  }
  let s = 0;
  for (let l = 0; l < result.eigenvalues.length; l += 1) {
    if (result.trivialIndices.includes(l)) continue;
    const diff = result.eigenvectors[l][i] - result.eigenvectors[l][j];
    s += Math.pow(Math.max(result.eigenvalues[l], 0), result.t) * diff * diff;
  }
  return Math.sqrt(s);
}

// ─────────────────── Isomap-lite（Floyd–Warshall 测地距 + 古典 MDS） ───────────────────

/** Floyd–Warshall 全源最短路（输入 n×n 距离/边权矩阵，允许 Infinity 表示无边） */
export function floydWarshall(dist: ReadonlyArray<ReadonlyArray<number>>): number[][] {
  const n = dist.length;
  if (n === 0) return [];
  for (const row of dist) if (row.length !== n) throw new Error(`floydWarshall: 需要方阵（得到 ${n}×${row.length}）`);
  const d = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const v = dist[i][j];
      if ((!Number.isFinite(v) && v !== Infinity) || v < 0 || (i === j && v !== 0)) {
        throw new Error(`floydWarshall: [${i}][${j}] = ${v} 非法（需 ≥0 有限或 Infinity，对角为 0）`);
      }
      d[i * n + j] = v;
    }
  }
  for (let kk = 0; kk < n; kk += 1) {
    const kn = kk * n;
    for (let i = 0; i < n; i += 1) {
      const dik = d[i * n + kk];
      if (dik === Infinity) continue;
      const in_ = i * n;
      for (let j = 0; j < n; j += 1) {
        const alt = dik + d[kn + j];
        if (alt < d[in_ + j]) d[in_ + j] = alt;
      }
    }
  }
  const out: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => d[i * n + j]));
  return out;
}

export interface IsomapOptions {
  /** kNN 邻居数（缺省 10） */
  k?: number;
  /** 嵌入维数（缺省 2） */
  dims?: number;
}

export interface IsomapResult {
  /** 最大连通分量的古典 MDS 嵌入（√λᵢ·vᵢ 坐标；行对应 usedIndices） */
  embedding: number[][];
  /** 所用正特征值（降序） */
  eigenvalues: number[];
  /** 全图 kNN 连通分量数 */
  components: number;
  /** 参与嵌入的点下标（最大分量；其余分量诚实排除） */
  usedIndices: number[];
  k: number;
  dims: number;
}

/** Isomap-lite: kNN 测地图 + Floyd–Warshall 测地距 + 古典 MDS（扩散映射的对照口径） */
export function isomap(points: PointCloud, options?: IsomapOptions): IsomapResult {
  const { n } = validatePointCloud(points, 'isomap');
  const k = options?.k ?? 10;
  if (!Number.isInteger(k) || k < 1 || k > n - 1) throw new Error(`isomap: k 需为 1..n−1 的整数（n=${n}，得到 ${k}）`);
  const dims = options?.dims ?? 2;
  if (!Number.isInteger(dims) || dims < 1 || dims > n - 1) throw new Error(`isomap: dims 需为 1..n−1 的整数（n=${n}，得到 ${dims}）`);
  const graph = knnGraph(points, k);
  const dist = pairwiseDistances(points);
  // 并查集找连通分量
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    let c = x;
    while (parent[c] !== c) {
      const next = parent[c];
      parent[c] = r;
      c = next;
    }
    return r;
  };
  for (let i = 0; i < n; i += 1) {
    for (const nb of graph.neighbors[i]) {
      const ri = find(i);
      const rj = find(nb.index);
      if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
    }
  }
  const compOf = Array.from({ length: n }, (_, i) => find(i));
  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const r = compOf[i];
    const list = members.get(r);
    if (list) list.push(i);
    else members.set(r, [i]);
  }
  let best: number[] = [];
  for (const list of members.values()) if (list.length > best.length) best = list;
  const components = members.size;
  if (best.length > MDS_MAX) {
    throw new Error(`isomap: 最大分量 ${best.length} > ${MDS_MAX}（古典 MDS 需全谱，O(n³)；请子采样后调用）`);
  }
  // 测地距：分量内 kNN 边权 + Floyd–Warshall
  const s = best.length;
  const inComp = new Set(best);
  const geo0 = Array.from({ length: s }, () => new Array<number>(s).fill(Infinity));
  for (let i = 0; i < s; i += 1) {
    geo0[i][i] = 0;
    for (const nb of graph.neighbors[best[i]]) {
      if (!inComp.has(nb.index)) continue;
      const jj = best.indexOf(nb.index);
      geo0[i][jj] = nb.distance;
      geo0[jj][i] = nb.distance;
    }
  }
  const geo = floydWarshall(geo0);
  // 古典 MDS: B = −½ H G H（G = 测地距平方）
  const g2 = geo.map((row) => row.map((v) => v * v));
  const rowMean = g2.map((row) => row.reduce((a, b) => a + b, 0) / s);
  let grand = 0;
  for (const v of rowMean) grand += v / s;
  const b = new Float64Array(s * s);
  for (let i = 0; i < s; i += 1) {
    for (let j = 0; j < s; j += 1) {
      b[i * s + j] = -0.5 * (g2[i][j] - rowMean[i] - rowMean[j] + grand);
    }
  }
  const eigen = jacobiFlat(b, s);
  const used: number[] = [];
  const coords: number[][] = [];
  for (let l = 0; l < eigen.values.length && used.length < dims; l += 1) {
    const lam = eigen.values[l];
    if (lam <= 1e-10) break;
    used.push(lam);
    const root = Math.sqrt(lam);
    coords.push(eigen.vectors[l].map((v) => root * v));
  }
  const embedding = Array.from({ length: s }, (_, i) => coords.map((c) => c[i]));
  return { embedding, eigenvalues: used, components, usedIndices: best, k, dims };
}

// ─────────────────── R5: 多尺度 t 扫描（一次分解，多口径外推） ───────────────────

export interface DiffusionScaleSweepOptions {
  /** 扩散时间列表（≥0，任意顺序；结果按给定顺序返回） */
  tValues: ReadonlyArray<number>;
  /** kNN 邻居数（缺省 10；与 diffusionMaps 同） */
  k?: number;
  /** 全局高斯带宽（缺省走局部自适应，与 diffusionMaps 同） */
  sigma?: number;
  /** 嵌入维数（缺省 2） */
  dims?: number;
  /** 计算的特征对个数（缺省 max(dims+8, 16)） */
  eigenCount?: number;
}

export interface DiffusionScaleSweepResult {
  tValues: number[];
  /** 每个 t 一份完整 DiffusionMapsResult——谱与特征向量共享同一次分解
   *  （与逐个调用 diffusionMaps(t) 逐位一致），只有 λ^{t/2} 嵌入权重不同 */
  results: DiffusionMapsResult[];
}

/**
 * 多尺度扩散 t 扫描: 一次 kNN/核/特征分解，产出多个扩散时间的嵌入与
 * 谱口径。
 *
 * 语义: t 是扩散的「放大镜倍率」——t 小看局部密度（簇内纹理），t 大看
 * 全局连通（簇间结构）。D_t 的簇间/簇内分辨率随 t 单调上升（verify
 * 锚点），但过度放大把次级结构抹平——扫描给出**尺度-结构曲线**而不是
 * 单点口径。性能: 谱分解只做一次（O(分解) + O(T·n·dims) 外推），T 个
 * t 值的独立调用是 O(T·分解)——实测 ~T 倍差（verify 计时对照）。
 */
export function diffusionScaleSweep(points: PointCloud, options: DiffusionScaleSweepOptions): DiffusionScaleSweepResult {
  const ts = [...options.tValues];
  if (ts.length === 0) throw new Error('diffusionScaleSweep: tValues 不能为空');
  for (const t of ts) {
    if (!Number.isFinite(t) || t < 0) throw new Error(`diffusionScaleSweep: t 需为 ≥0 的有限数（得到 ${t}）`);
  }
  const shared = { k: options.k, sigma: options.sigma, dims: options.dims, eigenCount: options.eigenCount };
  const base = diffusionMaps(points, { ...shared, t: ts[0] });
  const results: DiffusionMapsResult[] = [base];
  const n = base.embedding.length;
  const dims = base.dims;
  const trivial = base.trivialIndices;
  for (let ti = 1; ti < ts.length; ti += 1) {
    const t = ts[ti];
    const embedding: number[][] = Array.from({ length: n }, () => new Array<number>(dims).fill(0));
    let col = 0;
    for (let l = 0; l < base.eigenvectors.length && col < dims; l += 1) {
      if (trivial.includes(l)) continue;
      const weight = Math.pow(Math.max(base.eigenvalues[l], 0), t / 2);
      const v = base.eigenvectors[l];
      for (let i = 0; i < n; i += 1) embedding[i][col] = weight * v[i];
      col += 1;
    }
    results.push({ ...base, t, embedding });
  }
  return { tValues: ts, results };
}

// ─────────────────── R5: landmark 扩散（Nyström 外推） ───────────────────

export interface LandmarkDiffusionOptions {
  /** 地标数（缺省 min(64, n−1)；3..n−1） */
  nLandmarks?: number;
  /** 地标图 kNN 邻居数（缺省 10；1..ℓ−1） */
  k?: number;
  /** 嵌入维数（缺省 2） */
  dims?: number;
  /** 扩散时间（缺省 1） */
  t?: number;
}

export interface LandmarkDiffusionResult {
  /** 地标点下标（最远点采样——确定性：从 0 号点出发，平局取小下标） */
  landmarkIndices: number[];
  /** 全体 n 点的嵌入（地标 = 特征向量口径，其余 = Nyström 外推） */
  embedding: number[][];
  /** 地标嵌入（ℓ × dims，特征向量口径——外推的自洽锚点） */
  landmarkEmbedding: number[][];
  /** 地标扩散算子谱（降序，含平凡 λ₁ ≈ 1） */
  eigenvalues: number[];
  /** 地标特征向量（行 = 地标下标序） */
  eigenvectors: number[][];
  /** Nyström 外推退化的点（对地标核全零——孤立点诚实标记） */
  isolated: number[];
  nLandmarks: number;
  k: number;
  dims: number;
  t: number;
}

/**
 * 地标扩散映射（Nyström 外推; Vladymyrov–Carreira-Perpiñán 风格）。
 *
 * ①确定性最远点采样选 ℓ 个地标；②地标间距离上建与 diffusionMaps 同
 * 构的 kNN + 局部自适应带宽 + 对称归一化算子 W̃ = D^{−1/2}WD^{−1/2}，
 * 小矩阵全谱 Jacobi；③任意点 x 的特征向量经 Nyström 外推
 * ψ_l(x) = (1/λ_l)Σ_m w̃(x, l_m)ψ_l(l_m)（σ_x = x 到第 k 近地标的距离
 * ——与地标的 σᵢ 同口径，地标点的外推与特征向量**精确**一致）。
 * 成本 O(n·ℓ²) ≪ 全谱 O(n³)——大点集的保距嵌入第一次有可扩产的口径。
 */
export function landmarkDiffusion(points: PointCloud, options?: LandmarkDiffusionOptions): LandmarkDiffusionResult {
  const { n } = validatePointCloud(points, 'landmarkDiffusion');
  const ell = Math.floor(options?.nLandmarks ?? Math.min(64, n - 1));
  if (!Number.isInteger(ell) || ell < 3 || ell > n - 1) {
    throw new Error(`landmarkDiffusion: nLandmarks 需为 3..n−1 的整数（n=${n}，得到 ${ell}）`);
  }
  const dims = options?.dims ?? 2;
  if (!Number.isInteger(dims) || dims < 1 || dims > ell - 1) {
    throw new Error(`landmarkDiffusion: dims 需为 1..ℓ−1 的整数（ℓ=${ell}，得到 ${dims}）`);
  }
  const k = Math.min(Math.floor(options?.k ?? 10), ell - 1);
  if (!Number.isInteger(k) || k < 1 || k > ell - 1) {
    throw new Error(`landmarkDiffusion: k 需为 1..ℓ−1 的整数（ℓ=${ell}，得到 ${k}）`);
  }
  const t = options?.t ?? 1;
  if (!Number.isFinite(t) || t < 0) throw new Error(`landmarkDiffusion: t 需为 ≥0 的有限数（得到 ${t}）`);

  const dist = pairwiseDistances(points);
  // 最远点采样（确定性: 起点 0，平局取小下标）
  const landmarks: number[] = [0];
  const nearest = new Float64Array(n).fill(Infinity);
  for (let i = 0; i < n; i += 1) nearest[i] = dist[0][i];
  while (landmarks.length < ell) {
    let best = -1;
    let bestD = -1;
    for (let i = 0; i < n; i += 1) {
      if (nearest[i] > bestD + 1e-15) {
        bestD = nearest[i];
        best = i;
      }
    }
    if (best < 0 || bestD <= 1e-15) {
      // 全零距离退化（重复点）：按序补齐剩余下标
      for (let i = 0; i < n && landmarks.length < ell; i += 1) if (!landmarks.includes(i)) landmarks.push(i);
      break;
    }
    landmarks.push(best);
    for (let i = 0; i < n; i += 1) if (dist[best][i] < nearest[i]) nearest[i] = dist[best][i];
  }

  // 局部自适应带宽（地标口径）: σᵢ = 第 k 近**地标**距离。诚实口径:
  // 地标扩散在簇结构/离散流形上高保真（两新月坐标与全谱版 |corr| > 0.9），
  // 但连续单流形的细粒度参数化（瑞士卷 t 坐标）在中等 ℓ 下退化（ℓ=200
  // 时 max|corr| ≈ 0.86、ℓ 增大缓升）——粗化算子对近简并谱敏感。文档化
  // 而非掩盖; 簇结构任务用本口径，精细几何回到全谱版。
  const sigmaOf = (row: ReadonlyArray<number>): number => {
    const cand = [...row].sort((a, b) => a - b);
    return Math.max(cand[Math.min(k, cand.length - 1)], 1e-12); // 第 k 近（自身距离 0 占首位）
  };
  const dl: number[][] = landmarks.map((li) => landmarks.map((lj) => dist[li][lj]));
  const localScale = dl.map((row) => sigmaOf(row));
  const adj: Uint8Array[] = dl.map(() => new Uint8Array(ell));
  for (let i = 0; i < ell; i += 1) {
    const order = dl[i].map((d, j) => ({ d, j })).sort((a, b) => a.d - b.d || a.j - b.j);
    for (let idx = 1; idx <= Math.min(k, ell - 1) && idx < order.length; idx += 1) {
      adj[i][order[idx].j] = 1;
    }
  }
  const w = new Float64Array(ell * ell);
  const rowSum = new Float64Array(ell);
  // OR-对称化邻接（i、j 任一方向 kNN 相邻即连边）——外推的地标行走此
  // 邻接（与算子行严格同构：入边也计入——自洽锚点的关键）
  const symAdj: Uint8Array[] = Array.from({ length: ell }, () => new Uint8Array(ell));
  for (let i = 0; i < ell; i += 1) {
    for (let j = i + 1; j < ell; j += 1) {
      if (adj[i][j] === 1 || adj[j][i] === 1) {
        symAdj[i][j] = 1;
        symAdj[j][i] = 1;
        const d2 = dl[i][j] * dl[i][j];
        const val = Math.exp(-d2 / (localScale[i] * localScale[j]));
        w[i * ell + j] = val;
        w[j * ell + i] = val;
        rowSum[i] += val;
        rowSum[j] += val;
      }
    }
  }
  const scale = Array.from({ length: ell }, (_, i) => (rowSum[i] > 1e-12 ? 1 / Math.sqrt(rowSum[i]) : 0));
  const wt = new Float64Array(ell * ell);
  for (let i = 0; i < ell; i += 1) {
    for (let j = 0; j < ell; j += 1) wt[i * ell + j] = scale[i] * w[i * ell + j] * scale[j];
  }
  const eigen = jacobiFlat(wt, ell);
  const values = eigen.values;
  let vectors = eigen.vectors;
  // 确定性符号
  for (const v of vectors) {
    let maxIdx = 0;
    for (let i = 1; i < ell; i += 1) if (Math.abs(v[i]) > Math.abs(v[maxIdx])) maxIdx = i;
    if (v[maxIdx] < 0) for (let i = 0; i < ell; i += 1) v[i] = -v[i];
  }
  // 平凡分量（准常数 λ≈1）
  const invSqrtEll = 1 / Math.sqrt(ell);
  const trivial: number[] = [];
  for (let i = 0; i < values.length && values[i] > 1 - 1e-6; i += 1) {
    const v = vectors[i];
    let c = 0;
    for (let x of v) c += x * invSqrtEll;
    if (Math.abs(c) > 0.98) trivial.push(i);
  }
  // Nyström 外推: ψ_l(x) = (1/λ_l) Σ_m w̃(x, l_m) ψ_l(l_m)
  // 外推行与算子行**同构**: 只在 x 的 k 近地标上取核值（算子的 kNN 邻接
  // 同一规则——地标行的外推 = 特征方程，verify 自洽锚点到舍入阶）。
  // x 本身是地标时自项跳过（算子无自环）。
  const embedding: number[][] = Array.from({ length: n }, () => new Array<number>(dims).fill(0));
  const isolated: number[] = [];
  const trivialSet = new Set(trivial);
  const kAdj = Math.min(k, ell - 1);
  const landmarkIndexOf = new Map<number, number>();
  landmarks.forEach((li, idx) => landmarkIndexOf.set(li, idx));
  for (let x = 0; x < n; x += 1) {
    const dlRow = landmarks.map((li) => dist[x][li]);
    const sigmaX = sigmaOf(dlRow);
    let neighborsOfX: Set<number>;
    const rowOfX = landmarkIndexOf.get(x);
    if (rowOfX !== undefined) {
      // 地标点: 算子的 OR-对称化邻接行（严格同构——外推和式 = 特征方程）
      neighborsOfX = new Set<number>();
      for (let m = 0; m < ell; m += 1) if (symAdj[rowOfX][m] === 1 && m !== rowOfX) neighborsOfX.add(m);
    } else {
      // 非地标: x 的 kAdj 近地标（平局取小下标——确定性；与算子 kNN 同规则）
      const order = dlRow.map((d, m) => ({ d, m })).sort((a, b) => a.d - b.d || a.m - b.m);
      neighborsOfX = new Set<number>();
      for (let idx = 0; idx <= kAdj && idx < order.length; idx += 1) neighborsOfX.add(order[idx].m);
    }
    let dx = 0;
    const wrow = new Float64Array(ell);
    for (const m of neighborsOfX) {
      const val = Math.exp(-(dlRow[m] * dlRow[m]) / (sigmaX * localScale[m]));
      wrow[m] = val;
      dx += val;
    }
    if (dx < 1e-12) {
      isolated.push(x);
      continue; // 嵌入保持 0（诚实退化）
    }
    const normX = 1 / Math.sqrt(dx);
    let col = 0;
    for (let l = 0; l < vectors.length && col < dims; l += 1) {
      if (trivialSet.has(l)) continue;
      const lam = Math.max(values[l], 1e-300);
      const psi = vectors[l];
      let s = 0;
      for (let m = 0; m < ell; m += 1) {
        const wtilde = normX * wrow[m] * scale[m]; // D^{−1/2} W D^{−1/2} 行口径
        if (wtilde !== 0) s += wtilde * psi[m];
      }
      embedding[x][col] = Math.pow(Math.max(values[l], 0), t / 2) * (s / lam);
      col += 1;
    }
  }
  // 地标点的嵌入直接取特征向量口径（与外推一致——verify 自洽锚点）
  const landmarkEmbedding: number[][] = Array.from({ length: ell }, () => new Array<number>(dims).fill(0));
  {
    let col = 0;
    for (let l = 0; l < vectors.length && col < dims; l += 1) {
      if (trivialSet.has(l)) continue;
      const weight = Math.pow(Math.max(values[l], 0), t / 2);
      for (let i = 0; i < ell; i += 1) landmarkEmbedding[i][col] = weight * vectors[l][i];
      col += 1;
    }
  }
  // 注: 地标点的 embedding 保持外推路径的结果——外推在 m ≠ x 的和式
  // 正是算子的特征方程，与 landmarkEmbedding（特征向量口径）一致到
  // 舍入（verify 的自洽锚点是两条独立代码路径的对照，非平凡）。
  return { landmarkIndices: landmarks, embedding, landmarkEmbedding, eigenvalues: values, eigenvectors: vectors, isolated, nLandmarks: ell, k, dims, t };
}

// ─────────────────── 数据工厂（种子化流形基准） ───────────────────

/** 瑞士卷数据（内在参数: t 卷曲弧长参数 ∈ [1.5π, 4.5π]、height ∈ [0, 15]） */
export interface SwissRollData {
  points: number[][];
  t: number[];
  height: number[];
}

/**
 * 瑞士卷: (t·cos t, h, t·sin t) + 轻噪，t ∈ [1.5π, 4.5π]、h ∈ [0, 15]
 * （二维内在参数 (t, h)；弧长 ∝ √(1+t²)，均匀 t 采样会外疏内密——此处
 * 按弧长均匀采样（解析弧长 s(t) = ½(t√(1+t²)+asinh t) 二分反演），
 * 密度均匀 → 邻距均匀，kNN/带宽口径稳定）。
 */
export function swissRoll(n: number, seed: number): SwissRollData {
  if (!Number.isInteger(n) || n < 1) throw new Error(`swissRoll: n 需为 ≥1 的整数（得到 ${n}）`);
  if (!Number.isFinite(seed)) throw new Error(`swissRoll: seed 需为有限数（得到 ${seed}）`);
  const rng = mulberry32(seed);
  const gauss = gaussianSampler(rng);
  const tMin = 1.5 * Math.PI;
  const tMax = 4.5 * Math.PI;
  const arcLength = (t: number): number => 0.5 * (t * Math.sqrt(1 + t * t) + Math.asinh(t));
  const sMin = arcLength(tMin);
  const sMax = arcLength(tMax);
  const invertArc = (s: number): number => {
    let lo = tMin;
    let hi = tMax;
    for (let it = 0; it < 60; it += 1) {
      const mid = 0.5 * (lo + hi);
      if (arcLength(mid) < s) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  };
  const points: number[][] = [];
  const ts: number[] = [];
  const hs: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = invertArc(sMin + (sMax - sMin) * rng());
    const h = 15 * rng();
    points.push([t * Math.cos(t) + 0.1 * gauss(), h + 0.1 * gauss(), t * Math.sin(t) + 0.1 * gauss()]);
    ts.push(t);
    hs.push(h);
  }
  return { points, t: ts, height: hs };
}

/** 两新月数据（标签 0 = 上月牙、1 = 下月牙；标准互锁构造 + 噪声 σ=0.08） */
export interface TwoMoonsData {
  points: number[][];
  labels: number[];
}

/** 两新月: (cosθ, sinθ) 与 (1−cosθ, 0.5−sinθ)，θ ~ U(0,π)，噪声 σ=0.08 */
export function twoMoons(n: number, seed: number): TwoMoonsData {
  if (!Number.isInteger(n) || n < 2) throw new Error(`twoMoons: n 需为 ≥2 的整数（得到 ${n}）`);
  if (!Number.isFinite(seed)) throw new Error(`twoMoons: seed 需为有限数（得到 ${seed}）`);
  const rng = mulberry32(seed);
  const gauss = gaussianSampler(rng);
  const noise = 0.08;
  const points: number[][] = [];
  const labels: number[] = [];
  const half = Math.ceil(n / 2);
  for (let i = 0; i < n; i += 1) {
    const theta = Math.PI * rng();
    const label = i < half ? 0 : 1;
    if (label === 0) points.push([Math.cos(theta) + noise * gauss(), Math.sin(theta) + noise * gauss()]);
    else points.push([1 - Math.cos(theta) + noise * gauss(), 0.5 - Math.sin(theta) + noise * gauss()]);
    labels.push(label);
  }
  return { points, labels };
}

// ─────────────────── 工具：最近质心分类 ───────────────────

export interface CentroidClassifyResult {
  /** test 各点的预测标签（最近质心；平手取较小标签——确定性） */
  predictions: number[];
  centroids: Array<{ label: number; center: number[]; count: number }>;
}

/** 最近质心分类（标签升序聚质心；欧氏距离） */
export function nearestCentroidClassify(
  train: PointCloud,
  labels: ReadonlyArray<number>,
  test: PointCloud,
): CentroidClassifyResult {
  const { n, dim } = validatePointCloud(train, 'nearestCentroidClassify: train');
  if (labels.length !== n) throw new Error(`nearestCentroidClassify: labels 长度 ${labels.length} ≠ train 行数 ${n}`);
  for (const v of labels) if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`nearestCentroidClassify: 标签 ${v} 不是有限数`);
  const { n: m, dim: testDim } = validatePointCloud(test, 'nearestCentroidClassify: test');
  if (testDim !== dim) throw new Error(`nearestCentroidClassify: test 维度 ${testDim} ≠ train 维度 ${dim}`);
  const unique = [...new Set(labels)].sort((a, b) => a - b);
  const centroids = unique.map((label) => {
    const idx = labels.map((v, i) => (v === label ? i : -1)).filter((i) => i >= 0);
    const center = Array.from({ length: dim }, (_, j) => {
      let s = 0;
      for (const i of idx) s += train[i][j];
      return s / idx.length;
    });
    return { label, center, count: idx.length };
  });
  const predictions: number[] = [];
  for (let i = 0; i < m; i += 1) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let c = 0; c < centroids.length; c += 1) {
      let s = 0;
      for (let j = 0; j < dim; j += 1) {
        const d = test[i][j] - centroids[c].center[j];
        s += d * d;
      }
      if (s < bestDist - 1e-15) {
        bestDist = s;
        bestIdx = c;
      }
    }
    predictions.push(centroids[bestIdx].label);
  }
  return { predictions, centroids };
}

/* ── 接线建议 ──
 * 挂载引擎: 世界模型（经验流形层）+ 76.0 新奇检测 + dashboard
 * 1. 世界模型「经验连续嵌入」（与 69.0 Mapper 成对: Mapper 给离散骨架、
 *    本内核给连续坐标）: 经验条目的表示向量（评分面板 / 信号特征 / CCA
 *    典型变量——78.0 的公共坐标系正是这里的输入口径）作为 points，
 *    diffusionMaps 产出 Ψₜ 低维坐标；记忆检索与新经验落点第一次有了
 *    保距的流形地图（嵌入欧氏距离 ≈ 扩散距离 = 流形上的连通难度）。
 * 2. 76.0 新奇检测的低维前端: 原始高维空间做深度/密度既贵又被流形弯曲
 *    欺骗；先扩散映射降到 dims=8~16 再算 kNN 深度——成本降一个数量级，
 *    且「沿流形远、欧氏近」的伪邻居不再误报。谱隙/nComponents 兼作
 *    经验分布的结构预警（分量分裂/合并 = 行为模式事件）。
 * 3. 簇数与探索定向: gapIndex 给谱隙位置、nComponents 给连通分量数、
 *    非平凡特征向量的符号结构给软分簇——好奇心引擎向「嵌入空间稀疏
 *    带」定向采样（与 69.0 的空洞派单同源、坐标系更细）。
 * 4. 带宽纪律: 缺省自适应（局部 σᵢ）优先；切全局 σ 时必须对照锚点⑤
 *    两个失败方向做敏感性检查（碎片化 / 粘连），采信结论前先看
 *    isolated 与 nComponents 是否健康。
 * 5. 缺省关闭旗标: config.kernels.diffusionMapsEnabled = false（未开启
 *    时上述路径零介入——纯分析内核只读）。
 * 6. 挂载后改变的决策点: ①记忆检索度量（原始欧氏 → 扩散嵌入欧氏）；
 *    ②新奇检测输入空间（高维原始 → 低维嵌入，降本且去弯曲偏差）；
 *    ③探索目标选择（均匀 → 嵌入稀疏带定向）；④经验视图（列表 → 流形
 *    地图，dashboard 直接画 embedding）。
 */
