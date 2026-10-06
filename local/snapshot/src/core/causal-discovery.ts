/**
 * causal-discovery.ts — 77.0 因果发现内核 —— 从观测数据学出因果结构（PC 算法）
 *
 * 动机（5.0 因果内核的天花板）:
 * causal-kernel.ts 是「已知图做推断」——图从哪来？5.0 的答案是人喂：
 * 节点靠登记、边的方向靠 do-实验逐条确立。当变量成百（模型旋钮 × 任务
 * 特征 × 环境 KPI），人工画图不可持续，图本身成了整个因果体系的瓶颈。
 * 本内核回答姊妹篇没回答的问题：「图从观测数据里自己长出来」。自主
 * 识别轴的升维：世界模型第一次不靠人告诉它「什么导致什么」，而是从
 * 被动观测的相关结构里把因果骨架分离出来——相关性 → 因果结构。
 *
 * 数学（PC 算法，Spirtes–Glymour–Scheines 2000；三阶段）:
 * ① 骨架阶段（PC-stable，Colombo & Maathuis 2014——逐层邻接快照使
 *    结果与变量顺序无关）: 从完全图出发，按条件集规模 ℓ = 0,1,2,… 逐层
 *    对每条边 (i,j) 在 adj(i)∖{j} 的大小 ℓ 子集 S 上做条件独立检验，
 *    p > α ⇒ 删边并记录分离集 sepset(i,j) = S。线性高斯下用偏相关
 *    Fisher-z 检验: 取 [i,j]∪S 的相关矩阵之逆（精度矩阵 P），
 *    ρ_{ij·S} = −P_{ij}/√(P_{ii}P_{jj})，z = atanh(ρ̂)，统计量
 *    √(n−|S|−3)·z 在 H₀: ρ=0 下渐近标准正态，双侧精确 p 值
 *    p = erfc(|统计量|/√2)。离散数据可注入互信息检验（G² = 2n·Î(X;Y|S)，
 *    自由度 (r_X−1)(r_Y−1)·Π_{c∈S} r_c，χ² 生存函数 = 上正则化
 *    不完全伽马）。
 * ② 定向阶段（v-结构 / 对撞）: 无盾三元组 i−k−j（i,j 无边）且
 *    k ∉ sepset(i,j) ⇒ i→k←j。对撞是观测数据里唯一直接可定的结构，
 *    判据是独立性的精确翻转：X⊥Z 边缘独立、X∦Z|Y 条件依赖（锚点②）。
 * ③ Meek 规则 R1–R3 传播至不动点（不产生新 v-结构、不产生环；Meek
 *    1995: 仅从 v-结构出发时 R1–R3 已完备，R4 只在引入背景知识时需要）
 *    ⇒ CPDAG——马尔可夫等价类的代表元。
 *
 * 诚实边界（马尔可夫等价）: 观测数据只能识别到等价类。链 X→Y→Z 与
 * Z→Y→X 观测不可分——CPDAG 对可逆边输出无向边，绝不造假方向（锚点④）；
 * 只有等价类内方向不变的对撞臂等强制边才定向。有限样本下检验可能出错
 * 导致同一两边各有一个箭头（方向冲突），冲突边降级为无向并以 nConflicts
 * 计数——诚实的不确定性而非沉默的错。
 *
 * 附件（验证与下游共用）: 随机 DAG 工厂（分层构造，层内不连边天然无环）·
 * 线性高斯 SEM 采样器 X_v = Σ_{u∈pa(v)} b_{uv}·X_u + σ·ε_v（拓扑序生成，
 * 同种子同样本）· cpdagFromDag（真 DAG → 其等价类代表，与学习结果同
 * 口径可比）· 结构汉明距离 SHD（边的增删 / 翻转 / 定向差异逐对计数）。
 *
 * 验证锚点: ①链 X→Y→Z: X⊥Z|Y 检出、骨架 = 链、CPDAG = 无向链
 *   ②对撞 X→Y←Z: X⊥Z 边缘独立 / X∦Z|Y（对撞判据精确翻转）、v-结构
 *   定向正确 ③菱形 X→{Y,Z}→W: ≥10 种子 × n=5000，SHD(学习, CPDAG(真图))
 *   = 0 ④马尔可夫等价诚实性: 4 节点 3⁶=729 个图全枚举互证——强制边 =
 *   等价类共识方向、可逆边 = 无向，cpdagFromDag 与枚举逐边一致（链与
 *   反链不造假方向）⑤检验校准: H₀ 下 200 个独立数据集的 p 值均匀性
 *   （KS 式统计 < 5% 临界值 1.358/√m）且拒绝率 ≈ α。
 *
 * 应用: 世界模型因果结构自学（5.0 需要图，本内核从观测把图学出来）·
 * 反思器归因升级（v-结构识别「共同结果」节点）· 优化器稀疏归因（72.0）
 * 的因果后端。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 *
 * R5 · 78.0 进化（第五轮·世界性进化）：
 * A. GES 简化版（数学轴）—— gesLite：线性高斯 BIC 评分的贪心等价搜索。
 *    PC 只用条件独立（有约束检验），gesLite 用评分（BIC = 拟合 − 参数
 *    罚）从空图出发贪心 add/delete/reverse 至不动点，输出折叠回等价类
 *    （cpdag）。与 PC 互为方法论对照：约束法 vs 评分法在马尔可夫等价类
 *    上应给出一致答案（verify-r5-causal 锚定两者 SHD 一致）。诚实边界：
 *    在 DAG 空间而非等价类空间搜索（GES 原版的简化），大样本下与
 *    BIC 一致性兼容，小样本只保证局部最优。
 * B. 检验共享子计算 + 缓存（性能轴）—— PC 骨架阶段的全相关矩阵一次
 *    计算（此前每个检验重算 O(n·|S|²) 的列相关），检验结果按
 *    (i,j,S) 规范键缓存（同一条件集不重算）。缺省路径 p 值与逐检验
 *    重算逐位一致（相关矩阵子块 = 列子集相关矩阵，同求和序）。
 * C. Fisher-z 对数域（数值稳健轴）—— |ρ|→1 时 atanh 经 (1+ρ)/(1−ρ)
 *    商损失精度；改用 0.5·(log1p ρ − log1p(−ρ)) 对数域差分（数学等价，
 *    极端相关下保精度），|z|>38 时 p 值直接 0（erfc 下溢界的显式化）。
 *    互信息检验的分层证据累加同样改对数域（ln 计数和差，防大计数乘
 *    积溢出）。
 */

// ─────────────────────────── 确定性随机基座 ───────────────────────────

/** mulberry32：32 位确定性伪随机源（种子固定时序列完全可复现） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller 标准正态（随机源注入，保持确定性） */
function gaussianNoise(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ─────────────────────────── 特殊函数（无依赖自带） ───────────────────────────

/**
 * erf 近似（Abramowitz–Stegun 7.1.26，|误差| ≤ 1.5e-7）——
 * Fisher-z 检验的精确 p 值地基: P(|Z| ≥ x) = erfc(x/√2)。
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-z * z));
}

function erfc(x: number): number {
  return x >= 0 ? 1 - erf(x) : 1 + erf(-x);
}

/** 标准正态双侧 p 值: P(|Z| ≥ |x|) */
function twoSidedNormalP(x: number): number {
  return erfc(Math.abs(x) / Math.SQRT2);
}

/** Lanczos g=7 近似 lnΓ（互信息 χ² 生存函数用） */
const LANCZOS = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  let z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i += 1) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 上正则化不完全伽马 Q(a,x) = Γ(a,x)/Γ(a)（χ² 生存函数 = Q(df/2, x/2)） */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  if (x < a + 1) {
    // 级数展开 P(a,x)，Q = 1 − P
    let ap = a;
    let term = 1 / a;
    let sum = term;
    for (let i = 0; i < 500; i += 1) {
      ap += 1;
      term *= x / ap;
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return Math.max(0, 1 - sum * Math.exp(-x + a * Math.log(x) - lnGamma(a)));
  }
  // Lentz 连分式求 Q(a,x)
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.min(1, Math.max(0, Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h));
}

// ─────────────────────────── 图类型 ───────────────────────────

/** 混合图矩阵（CPDAG 口径）: m[i][j] ∈ {0,1,2}；0 = 无边；1 = 无向边（对称成对）；2 = 定向边 i→j（配合 m[j][i] = 0） */
export type MixedGraph = number[][];

/** 混合图边状态（const 对象 + 类型；无 enum——strip-types 兼容） */
export const EDGE_STATE = {
  none: 0,
  undirected: 1,
  directed: 2,
} as const;
export type EdgeState = (typeof EDGE_STATE)[keyof typeof EDGE_STATE];

/** DAG：n 个变量，adj[u][v] = 1 ⟺ u→v */
export interface Dag {
  n: number;
  /** n×n 0/1 邻接矩阵，adj[u][v] = 1 表示 u→v */
  adj: number[][];
  /** parents[v]：v 的父节点（升序） */
  parents: number[][];
  /** 拓扑序（工厂产出时已重算验证） */
  order: number[];
}

// ─────────────────────────── 入参校验 ───────────────────────────

function ensure(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

/** 数据矩阵校验：n×d 有限数值、行等长 */
function validateData(data: ReadonlyArray<ReadonlyArray<number>>, who: string): { n: number; d: number } {
  ensure(Array.isArray(data) && data.length > 0, `${who}: data 需为非空 n×d 数值矩阵`);
  const n = data.length;
  const d = data[0].length;
  ensure(Number.isInteger(d) && d >= 1, `${who}: 变量维 d 需为 ≥ 1 的整数`);
  for (let r = 0; r < n; r += 1) {
    const row = data[r];
    ensure(Array.isArray(row) && row.length === d, `${who}: data 第 ${r} 行长度 ≠ d=${d}（需行等长）`);
    for (let c = 0; c < d; c += 1) ensure(Number.isFinite(row[c]), `${who}: data[${r}][${c}] 需为有限数值`);
  }
  return { n, d };
}

/** 条件集校验：整数、在界内、不含 i/j、无重复 */
function validateCond(cond: ReadonlyArray<number>, d: number, i: number, j: number, who: string): void {
  const seen = new Set<number>();
  for (const c of cond) {
    ensure(Number.isInteger(c) && c >= 0 && c < d, `${who}: 条件集含越界下标 ${String(c)}（需 ∈ [0,${d})）`);
    ensure(c !== i && c !== j, `${who}: 条件集不能包含被检验的变量自身`);
    ensure(!seen.has(c), `${who}: 条件集含重复下标 ${String(c)}`);
    seen.add(c);
  }
}

/** DAG 校验 + 规格化（重算父表与拓扑序，不信任传入缓存） */
function normalizeDag(dag: Dag, who: string): { n: number; adj: number[][]; parents: number[][]; order: number[] } {
  ensure(dag !== null && typeof dag === 'object', `${who}: dag 不能为空`);
  const n = dag.n;
  ensure(Number.isInteger(n) && n >= 1, `${who}: dag.n 需为 ≥ 1 的整数`);
  ensure(Array.isArray(dag.adj) && dag.adj.length === n, `${who}: dag.adj 需为 ${n}×${n} 矩阵`);
  for (let u = 0; u < n; u += 1) {
    const row = dag.adj[u];
    ensure(Array.isArray(row) && row.length === n, `${who}: dag.adj 第 ${u} 行长度 ≠ ${n}`);
    for (let v = 0; v < n; v += 1) {
      ensure(row[v] === 0 || row[v] === 1, `${who}: dag.adj[${u}][${v}] 需为 0/1`);
      ensure(u === v ? row[v] === 0 : row[v] + (dag.adj[v][u] ?? 0) <= 1, `${who}: dag.adj 存在自环或双向边 [${u},${v}]`);
    }
  }
  const order = topoSort(n, dag.adj);
  if (order === null) throw new Error(`${who}: 图含环，不是 DAG`);
  const parents: number[][] = Array.from({ length: n }, () => []);
  for (let v = 0; v < n; v += 1) for (let u = 0; u < n; u += 1) if (dag.adj[u][v] === 1) parents[v].push(u);
  return { n, adj: dag.adj, parents, order };
}

/** Kahn 拓扑排序（入度零队列升序，确定性）；有环返回 null */
function topoSort(n: number, adj: ReadonlyArray<ReadonlyArray<number>>): number[] | null {
  const indeg = new Array<number>(n).fill(0);
  for (let u = 0; u < n; u += 1) for (let v = 0; v < n; v += 1) if (adj[u][v] === 1) indeg[v] += 1;
  const queue: number[] = [];
  for (let v = 0; v < n; v += 1) if (indeg[v] === 0) queue.push(v);
  const order: number[] = [];
  while (queue.length > 0) {
    const u = queue.shift() as number;
    order.push(u);
    for (let v = 0; v < n; v += 1) if (adj[u][v] === 1) {
      indeg[v] -= 1;
      if (indeg[v] === 0) queue.push(v);
    }
  }
  return order.length === n ? order : null;
}

/** 混合图矩阵校验：方阵、值域 {0,1,2}、0/1/2 配对不变量成立、对角为 0 */
function validateMixed(m: MixedGraph, who: string): number {
  const d = m.length;
  ensure(Number.isInteger(d) && d >= 1, `${who}: 需为 ≥ 1 阶方阵`);
  for (let i = 0; i < d; i += 1) {
    ensure(Array.isArray(m[i]) && m[i].length === d, `${who}: 需为 ${d}×${d} 方阵`);
    for (let j = 0; j < d; j += 1) {
      const x = m[i][j];
      ensure(x === 0 || x === 1 || x === 2, `${who}: m[${i}][${j}]=${String(x)} 需 ∈ {0,1,2}`);
      if (i === j) ensure(x === 0, `${who}: 对角线需为 0`);
    }
  }
  for (let i = 0; i < d; i += 1) for (let j = 0; j < d; j += 1) {
    if (i === j) continue;
    const x = m[i][j];
    const y = m[j][i];
    ensure(
      (x === EDGE_STATE.undirected && y === EDGE_STATE.undirected) ||
        (x === EDGE_STATE.directed && y === EDGE_STATE.none) ||
        (x === EDGE_STATE.none && y !== EDGE_STATE.undirected),
      `${who}: m[${i}][${j}]=${String(x)} 与 m[${j}][${i}]=${String(y)} 违反配对不变量（1/1 无向，2/0 定向）`,
    );
  }
  return d;
}

// ─────────────────────────── 线性代数 ───────────────────────────

/** 取 cols 列的 Pearson 相关矩阵（d × d；无恒定列，否则偏相关未定义） */
function correlationOf(data: ReadonlyArray<ReadonlyArray<number>>, cols: ReadonlyArray<number>): number[][] {
  const n = data.length;
  const m = cols.length;
  const means = new Array<number>(m).fill(0);
  for (let r = 0; r < n; r += 1) for (let k = 0; k < m; k += 1) means[k] += data[r][cols[k]];
  for (let k = 0; k < m; k += 1) means[k] /= n;
  const cov: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  for (let a = 0; a < m; a += 1) {
    for (let b = a; b < m; b += 1) {
      let s = 0;
      for (let r = 0; r < n; r += 1) {
        const da = data[r][cols[a]] - means[a];
        const db = data[r][cols[b]] - means[b];
        s += da * db;
      }
      cov[a][b] = s;
      cov[b][a] = s;
    }
  }
  const sd = cov.map((row, k) => Math.sqrt(row[k]));
  for (let k = 0; k < m; k += 1) {
    ensure(sd[k] > 1e-12, `causal-discovery: 变量 ${String(cols[k])} 近恒定（方差≈0），相关系数未定义`);
  }
  const corr: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  for (let a = 0; a < m; a += 1) for (let b = 0; b < m; b += 1) corr[a][b] = cov[a][b] / (sd[a] * sd[b]);
  return corr;
}

/** Gauss–Jordan 带列主元消元求逆（相关矩阵精度矩阵；奇异即 throw） */
function invertMatrix(m: ReadonlyArray<ReadonlyArray<number>>): number[][] {
  const k = m.length;
  const a: number[][] = m.map((row, r) => [...row, ...Array.from({ length: k }, (_, j) => (r === j ? 1 : 0))]);
  for (let col = 0; col < k; col += 1) {
    let piv = col;
    for (let r = col + 1; r < k; r += 1) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    ensure(Math.abs(a[piv][col]) > 1e-12, 'causal-discovery: 相关矩阵奇异（变量完全共线），偏相关未定义');
    if (piv !== col) {
      const t = a[piv];
      a[piv] = a[col];
      a[col] = t;
    }
    const d = a[col][col];
    for (let j = 0; j < 2 * k; j += 1) a[col][j] /= d;
    for (let r = 0; r < k; r += 1) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * k; j += 1) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((row) => row.slice(k));
}

/**
 * R5·78.0：Gauss–Jordan 求逆的非抛出变体（gesLite 候选评估用）——
 * 奇异（列主元 ≈ 0）返回 null 而非 throw：共线父集是贪心搜索的
 * 正常候选，无效即跳过，不构成运行错误。
 */
function tryInvertMatrix(m: ReadonlyArray<ReadonlyArray<number>>): number[][] | null {
  const k = m.length;
  const a: number[][] = m.map((row, r) => [...row, ...Array.from({ length: k }, (_, j) => (r === j ? 1 : 0))]);
  for (let col = 0; col < k; col += 1) {
    let piv = col;
    for (let r = col + 1; r < k; r += 1) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) <= 1e-12) return null;
    if (piv !== col) {
      const t = a[piv];
      a[piv] = a[col];
      a[col] = t;
    }
    const d = a[col][col];
    for (let j = 0; j < 2 * k; j += 1) a[col][j] /= d;
    for (let r = 0; r < k; r += 1) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * k; j += 1) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((row) => row.slice(k));
}

/**
 * R5·78.0：全变量相关矩阵一次计算（PC 骨架/gesLite 共享子计算基座）。
 * 与 correlationOf 的差别：不在此处 throw 近恒定列——方差下检测留到
 * 实际用到该列的检验/评分处（保持「未涉及的恒定列不误伤」的既有行为）。
 * 返回 sd 数组供调用方做逐列惰性校验。列对 (a,b) 的求和序与
 * correlationOf 严格一致 ⇒ 子块与列子集重算逐位相同（等价性地基）。
 */
function fullCorrelationOf(data: ReadonlyArray<ReadonlyArray<number>>): { corr: number[][]; sd: number[] } {
  const n = data.length;
  const d = data[0].length;
  const means = new Array<number>(d).fill(0);
  for (let r = 0; r < n; r += 1) for (let c = 0; c < d; c += 1) means[c] += data[r][c];
  for (let c = 0; c < d; c += 1) means[c] /= n;
  const cov: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (let a = 0; a < d; a += 1) {
    for (let b = a; b < d; b += 1) {
      let s = 0;
      for (let r = 0; r < n; r += 1) {
        const da = data[r][a] - means[a];
        const db = data[r][b] - means[b];
        s += da * db;
      }
      cov[a][b] = s;
      cov[b][a] = s;
    }
  }
  const sd = cov.map((row, k) => Math.sqrt(row[k]));
  const corr: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (let a = 0; a < d; a += 1) for (let b = 0; b < d; b += 1) corr[a][b] = cov[a][b] / (sd[a] * sd[b]);
  return { corr, sd };
}

// ─────────────────────────── 条件独立检验 ───────────────────────────

/** 偏相关 Fisher-z 检验结果 */
export interface PartialCorrelationResult {
  /** 偏相关系数 ρ_{ij·S} ∈ [−1,1]（精度矩阵口径 −P_{ij}/√(P_{ii}P_{jj})） */
  rho: number;
  /** 双侧 p 值（H₀: X⊥Y | S），精确到 erf 近似 1.5e-7 */
  pValue: number;
  /** Fisher-z 统计量 √(n−|S|−3)·atanh(ρ̂) */
  zStat: number;
  /** 有效自由度 n − |S| − 3 */
  df: number;
  /** 是否判条件独立（p > α） */
  independent: boolean;
}

/** 偏相关检验选项 */
export interface CiTestOptions {
  /** 显著性水平（缺省 0.05） */
  alpha?: number;
}

/**
 * 偏相关 Fisher-z 条件独立检验（线性高斯）。
 *
 * H₀: ρ_{ij·S} = 0。统计量 √(n−|S|−3)·atanh(ρ̂) 渐近 N(0,1)，
 * p = erfc(|z|/√2)。|S| = 0 时退化为普通相关检验。
 *
 * R5·78.0 数值稳健：atanh 改对数域差分 0.5·(log1p ρ − log1p(−ρ))
 * （|ρ|→1 时商式 (1+ρ)/(1−ρ) 发生相消，log1p 差分无此损）；|z| > 38
 * 时 p 直接取 0（erfc(38/√2) < 1e-300 已低于双精度可表达——显式化下溢界）。
 */
export function partialCorrelationTest(
  data: ReadonlyArray<ReadonlyArray<number>>,
  i: number,
  j: number,
  cond: ReadonlyArray<number> = [],
  opts: CiTestOptions = {},
): PartialCorrelationResult {
  const { n, d } = validateData(data, 'partialCorrelationTest');
  const alpha = opts.alpha ?? 0.05;
  ensure(Number.isFinite(alpha) && alpha > 0 && alpha < 1, 'partialCorrelationTest: alpha 需 ∈ (0,1)');
  ensure(Number.isInteger(i) && Number.isInteger(j) && i >= 0 && j >= 0 && i < d && j < d, 'partialCorrelationTest: i/j 需为 ∈ [0,d) 的整数下标');
  ensure(i !== j, 'partialCorrelationTest: i 与 j 不能相同');
  validateCond(cond, d, i, j, 'partialCorrelationTest');
  const df = n - cond.length - 3;
  ensure(df >= 1, `partialCorrelationTest: n=${n}、|S|=${String(cond.length)} 自由度不足（需 n ≥ |S|+4）`);

  const cols = [i, j, ...cond];
  const corr = correlationOf(data, cols);
  // 局部矩阵口径：列子集相关的下标即 0..k−1（子块 = 整个局部矩阵）
  const localCols = cols.map((_, k) => k);
  return partialCorrelationFromMatrix(corr, n, alpha, localCols, df);
}

/**
 * R5·78.0：相关矩阵 → 偏相关检验的共享子计算路径。
 * PC 骨架阶段把全相关矩阵算一次后经此函数做全部检验——与
 * partialCorrelationTest（逐检验重算列相关）输出逐位一致：
 * 子块取自同一求和序的全矩阵（fullCorrelationOf），后续算法相同。
 */
function partialCorrelationFromMatrix(
  corrFull: ReadonlyArray<ReadonlyArray<number>>,
  n: number,
  alpha: number,
  cols: ReadonlyArray<number>,
  df: number,
): PartialCorrelationResult {
  const sub: number[][] = cols.map((r) => cols.map((c) => corrFull[r][c]));
  const prec = invertMatrix(sub);
  const denom = Math.sqrt(prec[0][0] * prec[1][1]);
  ensure(denom > 0, 'partialCorrelationTest: 精度矩阵对角非正（数值异常）');
  // atanh 奇点保护：|ρ|→1 时 clamp，p→0 的语义不变
  const rho = Math.min(1 - 1e-12, Math.max(-1 + 1e-12, -prec[0][1] / denom));
  // R5·78.0：Fisher-z 对数域（|ρ|→1 保精度；与 atanh 数学等价）
  const zStat = Math.sqrt(df) * 0.5 * (Math.log1p(rho) - Math.log1p(-rho));
  const pValue = Math.abs(zStat) > 38 ? 0 : twoSidedNormalP(zStat);
  return { rho, pValue, zStat, df, independent: pValue > alpha };
}

/** 离散互信息检验结果（nat） */
export interface MutualInformationResult {
  /** 条件互信息估计 Î(X;Y|S)（nat；分层频率极大似然） */
  mi: number;
  /** G² 统计量 = 2n·Î（似然比 χ²） */
  g2: number;
  /** 自由度 (r_X−1)(r_Y−1)·Π_{c∈S} r_c */
  dof: number;
  /** χ² 生存函数 p 值 */
  pValue: number;
  /** 是否判条件独立（p > α） */
  independent: boolean;
}

/**
 * 离散条件互信息检验（G² / 似然比检验）。
 *
 * Î(X;Y|S) = Σ_strata (n_s/n)·Σ_{x,y} p̂(x,y|s)·ln[p̂(x,y|s)/(p̂(x|s)p̂(y|s))]，
 * G² = 2n·Î ~ χ²_{(r_X−1)(r_Y−1)·Π r_c}（H₀ 下渐近）。
 * 数据取非负整数类别码（仅校验所用列）。诚实边界: 层内期望频数过小时
 * χ² 渐近失效，调用方需保证 n >> 层数。
 */
export function mutualInformationTest(
  data: ReadonlyArray<ReadonlyArray<number>>,
  i: number,
  j: number,
  cond: ReadonlyArray<number> = [],
  opts: CiTestOptions = {},
): MutualInformationResult {
  const { n, d } = validateData(data, 'mutualInformationTest');
  const alpha = opts.alpha ?? 0.05;
  ensure(Number.isFinite(alpha) && alpha > 0 && alpha < 1, 'mutualInformationTest: alpha 需 ∈ (0,1)');
  ensure(Number.isInteger(i) && Number.isInteger(j) && i >= 0 && j >= 0 && i < d && j < d, 'mutualInformationTest: i/j 需为 ∈ [0,d) 的整数下标');
  ensure(i !== j, 'mutualInformationTest: i 与 j 不能相同');
  validateCond(cond, d, i, j, 'mutualInformationTest');
  for (const c of [i, j, ...cond]) {
    for (let r = 0; r < n; r += 1) {
      const v = data[r][c];
      ensure(Number.isInteger(v) && v >= 0, `mutualInformationTest: data[${r}][${String(c)}]=${String(v)} 需为非负整数类别码`);
    }
  }
  const levels = (c: number): number => {
    let mx = 0;
    for (let r = 0; r < n; r += 1) if (data[r][c] > mx) mx = data[r][c];
    return mx + 1;
  };
  const rx = levels(i);
  const ry = levels(j);
  const rCond = cond.map(levels);
  let strata = 1;
  for (const r of rCond) {
    strata *= r;
    ensure(strata <= 1_000_000, 'mutualInformationTest: 条件集基数之积超过 1e6，请缩减条件集');
  }
  const nS = new Array<number>(strata).fill(0);
  const nXS = new Array<number>(rx * strata).fill(0);
  const nYS = new Array<number>(ry * strata).fill(0);
  const nXYS = new Array<number>(rx * ry * strata).fill(0);
  for (let r = 0; r < n; r += 1) {
    let s = 0;
    for (let k = 0; k < cond.length; k += 1) s = s * rCond[k] + data[r][cond[k]];
    const x = data[r][i];
    const y = data[r][j];
    nS[s] += 1;
    nXS[x * strata + s] += 1;
    nYS[y * strata + s] += 1;
    nXYS[(x * ry + y) * strata + s] += 1;
  }
  let mi = 0;
  for (let s = 0; s < strata; s += 1) {
    if (nS[s] === 0) continue;
    for (let x = 0; x < rx; x += 1) {
      const nxs = nXS[x * strata + s];
      if (nxs === 0) continue;
      for (let y = 0; y < ry; y += 1) {
        const nxy = nXYS[(x * ry + y) * strata + s];
        if (nxy === 0) continue;
        const nys = nYS[y * strata + s];
        // R5·78.0 对数域累加：(n_xys/n)·ln[(n_xys·n_s)/(n_xs·n_ys)]
        // 改为 ln 计数的和差——四个计数的乘积在大 n 时有溢出风险，
        // 对数域恒无此虞（数值与商式等价到浮点舍入）。
        mi += (nxy / n) * (Math.log(nxy) + Math.log(nS[s]) - Math.log(nxs) - Math.log(nys));
      }
    }
  }
  const g2 = 2 * n * mi;
  let dof = (rx - 1) * (ry - 1);
  for (const r of rCond) dof *= r;
  const pValue = dof >= 1 ? gammaQ(dof / 2, g2 / 2) : 1;
  return { mi, g2, dof, pValue, independent: pValue > alpha };
}

// ─────────────────────────── PC 骨架 + 定向内部件 ───────────────────────────

/** 从升序源数组枚举全部大小 k 的子集（字典序，确定性） */
function combinations(src: ReadonlyArray<number>, k: number): number[][] {
  const out: number[][] = [];
  if (k === 0) {
    out.push([]);
    return out;
  }
  if (k > src.length) return out;
  const idx: number[] = [];
  for (let t = 0; t < k; t += 1) idx.push(t);
  for (;;) {
    out.push(idx.map((v) => src[v]));
    let p = k - 1;
    while (p >= 0 && idx[p] === src.length - k + p) p -= 1;
    if (p < 0) break;
    idx[p] += 1;
    for (let t = p + 1; t < k; t += 1) idx[t] = idx[t - 1] + 1;
  }
  return out;
}

/** 无向邻接表（升序） */
function neighborList(edge: ReadonlyArray<ReadonlyArray<boolean>>, v: number): number[] {
  const out: number[] = [];
  for (let u = 0; u < edge.length; u += 1) if (u !== v && edge[v][u]) out.push(u);
  return out;
}

/** 图样（pattern）: 无向邻接 + 箭头标记（arrow[u][v] = 边 u—v 的 v 端有箭头） */
interface Pattern {
  edge: boolean[][];
  arrow: boolean[][];
}

/** v-结构定向: 无盾三元组 (i,k,j) 且 isCollider(i,k,j) ⇒ i→k←j。返回定向数 */
function orientVStructures(p: Pattern, isCollider: (i: number, k: number, j: number) => boolean): number {
  const d = p.edge.length;
  let count = 0;
  for (let k = 0; k < d; k += 1) {
    const nb = neighborList(p.edge, k);
    for (let a = 0; a < nb.length; a += 1) {
      for (let b = a + 1; b < nb.length; b += 1) {
        const i = nb[a];
        const j = nb[b];
        if (p.edge[i][j]) continue; // 有盾（i,j 相邻）不构成无盾三元组
        if (isCollider(i, k, j)) {
          p.arrow[i][k] = true;
          p.arrow[j][k] = true;
          count += 1;
        }
      }
    }
  }
  return count;
}

/**
 * Meek 规则 R1–R3 传播至不动点（仅作用于当前无向的边，避免制造双向箭头）。
 * R1: a→b 且 b−c 无向且 a,c 无边 ⇒ b→c（否则造成新 v-结构 a→b←c）。
 * R2: a→b→c 且 a−c 无向 ⇒ a→c（否则成环）。
 * R3: a−b 无向，a−c、a−d，c→b、d→b，c,d 无边 ⇒ a→b（否则新 v-结构）。
 * 返回新定向边数。
 */
function applyMeekRules(p: Pattern): number {
  const d = p.edge.length;
  let oriented = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (let x = 0; x < d; x += 1) {
      for (let y = 0; y < d; y += 1) {
        if (x === y || !p.edge[x][y] || p.arrow[x][y] || p.arrow[y][x]) continue;
        let fire = false;
        // R1: ∃a: a→x 且 a,y 无边 ⇒ x→y
        for (let a = 0; a < d && !fire; a += 1) {
          if (a === x || a === y || !p.edge[a][x]) continue;
          if (p.arrow[a][x] && !p.arrow[x][a] && !p.edge[a][y]) fire = true;
        }
        // R2: ∃m: x→m→y ⇒ x→y
        for (let m = 0; m < d && !fire; m += 1) {
          if (m === x || m === y) continue;
          if (p.arrow[x][m] && !p.arrow[m][x] && p.arrow[m][y] && !p.arrow[y][m]) fire = true;
        }
        // R3: ∃c<d: x−c、x−d、c→y、d→y、c,d 无边 ⇒ x→y
        if (!fire) {
          outer: for (let c = 0; c < d; c += 1) {
            if (c === x || c === y || !p.edge[x][c]) continue;
            if (!(p.arrow[c][y] && !p.arrow[y][c])) continue;
            for (let e = c + 1; e < d; e += 1) {
              if (e === x || e === y || !p.edge[x][e] || p.edge[c][e]) continue;
              if (p.arrow[e][y] && !p.arrow[y][e]) {
                fire = true;
                break outer;
              }
            }
          }
        }
        if (fire) {
          p.arrow[x][y] = true;
          oriented += 1;
          changed = true;
        }
      }
    }
  }
  return oriented;
}

/** 图样 → 混合图矩阵（0/1/2）；双箭头冲突降级为无向并计数（有限样本诚实边界） */
function patternToMixed(p: Pattern): { mixed: MixedGraph; conflicts: number } {
  const d = p.edge.length;
  const mixed: MixedGraph = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  let conflicts = 0;
  for (let i = 0; i < d; i += 1) {
    for (let j = i + 1; j < d; j += 1) {
      if (!p.edge[i][j]) continue;
      if (p.arrow[i][j] && !p.arrow[j][i]) mixed[i][j] = EDGE_STATE.directed;
      else if (p.arrow[j][i] && !p.arrow[i][j]) mixed[j][i] = EDGE_STATE.directed;
      else {
        if (p.arrow[i][j] && p.arrow[j][i]) conflicts += 1;
        mixed[i][j] = EDGE_STATE.undirected;
        mixed[j][i] = EDGE_STATE.undirected;
      }
    }
  }
  return { mixed, conflicts };
}

// ─────────────────────────── PC 算法 ───────────────────────────

/** 可注入的条件独立检验（返回 p 值；缺省 Fisher-z 偏相关） */
export type CiTestFn = (
  data: ReadonlyArray<ReadonlyArray<number>>,
  i: number,
  j: number,
  cond: ReadonlyArray<number>,
) => { pValue: number };

/** PC 算法配置 */
export interface PcOptions {
  /** 骨架删边显著性水平（缺省 0.05） */
  alpha?: number;
  /** 注入检验（缺省线性高斯偏相关 Fisher-z；离散数据注入互信息检验） */
  test?: CiTestFn;
}

/** PC 算法输出 */
export interface PcResult {
  /** 骨架: d×d 对称 0/1 矩阵（1 = 有边） */
  skeleton: number[][];
  /** CPDAG: d×d 矩阵，0 = 无边 / 1 = 无向（1/1 成对）/ 2 = i→j（2/0 配对） */
  cpdag: MixedGraph;
  /** 分离集: 键 `${min(i,j)}|${max(i,j)}` → 删边时的条件集（升序） */
  sepsets: Map<string, number[]>;
  /** 条件独立检验执行次数（R5·78.0：缓存命中不计——同一条件集不重算） */
  nTests: number;
  /** v-结构定向数 */
  nVStructures: number;
  /** Meek 规则传播新定向数 */
  nMeekOriented: number;
  /** 方向冲突数（双箭头降级无向——检验噪声的诚实计数） */
  nConflicts: number;
  /** 骨架阶段用到的最大条件集规模 */
  maxLevel: number;
  /** R5·78.0：检验缓存命中数（命中 = 同一 (i,j,S) 免重算） */
  nCacheHits: number;
}

/**
 * PC 算法（PC-stable 骨架 + v-结构定向 + Meek R1–R3 传播）: 观测数据 → CPDAG。
 *
 * 输出承诺到马尔可夫等价类: 可逆边保持无向（不造假方向），强制边定向。
 * PC-stable 逐层邻接快照（Colombo & Maathuis 2014）保证结果与变量顺序无关。
 *
 * R5·78.0 性能：缺省 Fisher-z 路径共享一次全相关矩阵（此前逐检验重算
 * O(n·|S|²) 列相关——n=5000、d=8 的骨架阶段省去约 90% 的协方差扫描）；
 * 检验结果按 (min(i,j), max(i,j), S 升序) 规范键缓存（同条件集不重算，
 * (a,b) 与 (b,a) 候选方向共享命中——注入检验需确定性，与内核宪章一致）。
 * 两条优化都不改变删边判定 ⇒ 骨架/分离集/CPDAG 与逐检验重算逐位一致。
 */
export function pcAlgorithm(data: ReadonlyArray<ReadonlyArray<number>>, opts: PcOptions = {}): PcResult {
  const { n, d } = validateData(data, 'pcAlgorithm');
  const alpha = opts.alpha ?? 0.05;
  ensure(Number.isFinite(alpha) && alpha > 0 && alpha < 1, 'pcAlgorithm: alpha 需 ∈ (0,1)');
  ensure(d >= 2, 'pcAlgorithm: 至少需要 2 个变量');
  ensure(n >= 5, 'pcAlgorithm: 至少需要 5 个样本');

  // ── R5·78.0 共享子计算：缺省路径全相关矩阵一次算好 ──
  let shared: { corr: number[][]; sd: number[] } | undefined;
  if (opts.test === undefined) shared = fullCorrelationOf(data);
  const testFn: CiTestFn =
    opts.test ??
    ((_dd, i, j, S) => {
      const df = n - S.length - 3;
      ensure(df >= 1, `partialCorrelationTest: n=${n}、|S|=${String(S.length)} 自由度不足（需 n ≥ |S|+4）`);
      for (const c of [i, j, ...S]) {
        ensure(shared!.sd[c] > 1e-12, `causal-discovery: 变量 ${String(c)} 近恒定（方差≈0），相关系数未定义`);
      }
      return partialCorrelationFromMatrix(shared!.corr, n, alpha, [i, j, ...S], df);
    });

  // ── R5·78.0 检验缓存：同一 (i,j,S) 不重算（规范键与方向无关）──
  const ciCache = new Map<string, number>();
  let nTests = 0;
  let nCacheHits = 0;
  const runTest = (a: number, b: number, S: ReadonlyArray<number>): number => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}|${hi}|${[...S].sort((x, y) => x - y).join(',')}`;
    const hit = ciCache.get(key);
    if (hit !== undefined) {
      nCacheHits += 1;
      return hit;
    }
    nTests += 1;
    const res = testFn(data, a, b, S);
    ensure(Number.isFinite(res.pValue) && res.pValue >= 0 && res.pValue <= 1, 'pcAlgorithm: 注入检验需返回 [0,1] 内有限 pValue');
    ciCache.set(key, res.pValue);
    return res.pValue;
  };

  // ── ① 骨架阶段（PC-stable）──
  const edge: boolean[][] = Array.from({ length: d }, () => new Array<boolean>(d).fill(false));
  for (let i = 0; i < d; i += 1) for (let j = i + 1; j < d; j += 1) {
    edge[i][j] = true;
    edge[j][i] = true;
  }
  const sepsets = new Map<string, number[]>();
  const sepKey = (i: number, j: number): string => (i < j ? `${i}|${j}` : `${j}|${i}`);
  let maxLevel = 0;
  let level = 0;
  while (level <= d - 2) {
    // 层首快照（PC-stable: 本层内删边不影响候选集，结果顺序无关）
    const snap: number[][] = [];
    for (let v = 0; v < d; v += 1) snap.push(neighborList(edge, v));
    let anyCandidate = false;
    for (let i = 0; i < d && !anyCandidate; i += 1) {
      for (let j = i + 1; j < d; j += 1) {
        if (!edge[i][j]) continue;
        if (snap[i].filter((v) => v !== j).length >= level || snap[j].filter((v) => v !== i).length >= level) {
          anyCandidate = true;
          break;
        }
      }
    }
    if (!anyCandidate) break;
    maxLevel = Math.max(maxLevel, level);
    for (let i = 0; i < d; i += 1) {
      for (let j = i + 1; j < d; j += 1) {
        if (!edge[i][j]) continue;
        let removed = false;
        for (const ab of [
          [i, j],
          [j, i],
        ]) {
          const a = ab[0];
          const b = ab[1];
          const cand = snap[a].filter((v) => v !== b);
          if (cand.length < level) continue;
          for (const S of combinations(cand, level)) {
            if (runTest(a, b, S) > alpha) {
              edge[i][j] = false;
              edge[j][i] = false;
              sepsets.set(sepKey(i, j), [...S]);
              removed = true;
              break;
            }
          }
          if (removed) break;
        }
      }
    }
    level += 1;
  }

  // ── ② v-结构定向 ──
  const arrow: boolean[][] = Array.from({ length: d }, () => new Array<boolean>(d).fill(false));
  const pattern: Pattern = { edge, arrow };
  const nVStructures = orientVStructures(pattern, (i, k, j) => {
    const sep = sepsets.get(sepKey(i, j));
    return sep === undefined || !sep.includes(k);
  });

  // ── ③ Meek 传播 → CPDAG ──
  const nMeekOriented = applyMeekRules(pattern);
  const { mixed, conflicts } = patternToMixed(pattern);

  const skeleton: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (let i = 0; i < d; i += 1) for (let j = 0; j < d; j += 1) if (edge[i][j]) skeleton[i][j] = 1;

  return { skeleton, cpdag: mixed, sepsets, nTests, nVStructures, nMeekOriented, nConflicts: conflicts, maxLevel, nCacheHits };
}

// ─────────────────────────── R5 · 78.0 GES 简化版（评分法因果发现） ───────────────────────────

/** GES 简化版选项 */
export interface GesOptions {
  /** BIC 参数罚倍率（乘在 (ln n)/2·参数数 上；缺省 1 = 标准 BIC） */
  penalty?: number;
}

/** 一步贪心操作（审计轨迹） */
export interface GesStep {
  op: 'add' | 'delete' | 'reverse';
  u: number;
  v: number;
  /** 该操作的 BIC 增量（> 0 才被接受） */
  delta: number;
}

/** GES 简化版输出 */
export interface GesResult {
  /** 学到的 DAG（d×d 0/1 邻接） */
  dag: number[][];
  /** 折叠回马尔可夫等价类代表（与 PC 输出同口径可比） */
  cpdag: MixedGraph;
  /** 最终 BIC 评分（越高越好；含常数项） */
  score: number;
  /** 局部评分计算次数（性能口径） */
  nEvals: number;
  /** 主贪心被接受的步数（精确 DP 路径为 0） */
  nSteps: number;
  /** 贪心轨迹（add/delete/reverse 及其 ΔBIC；精确 DP 路径为空） */
  history: GesStep[];
  /** 确定性扰动重启次数（d > 12 的贪心路径专属；精确路径为 0） */
  nRestarts: number;
  /** 是否走精确 DP 路径（d ≤ 12：全局 BIC 最优，无局部最优） */
  exact: boolean;
}

/** gesLite 内部搜索状态（可整体克隆） */
interface GesState {
  adj: number[][];
  parents: number[][];
  score: number[];
}

/**
 * GES 简化版：线性高斯 BIC 评分的贪心结构搜索（观测数据 → DAG → CPDAG）。
 *
 * 评分（对数似然用相关矩阵闭式）：标准化变量下节点 v 给定父集 P 的
 * 残差方差 σ̂²_v = 1 − r_{v,P}ᵀ R_{P,P}^{-1} r_{v,P}，
 * localBIC(v,P) = −n/2·(ln 2π + 1 + ln σ̂²_v) − (ln n)/2·penalty·(|P|+2)
 * （+2 = 截距与方差两个恒在参数，跨图比较中抵消，保留以口径完整）。
 *
 * 搜索（双路径）：
 * - d ≤ 12：精确动态规划（Silander & Myllymäki 2006 的最优贝叶斯网
 *   结构学习）：best-parent-set 表 + best-sink 表，O(d·2^d) 局部评分
 *   直接给出全局 BIC 最优 DAG——无局部最优，评分法结果可作 PC 的
 *   独立对照（BIC 一致性下两者应落在同一等价类）。
 * - d > 12：空图贪心 add/delete/reverse 至不动点 + 确定性扰动重启
 *   （逐边强制删除并禁原样重建、重收敛，严格更优才接受——对撞陷阱
 *   的逃逸补丁；评分单调上升 ⇒ 有界终止）。
 * 两条路径全程确定性（平手按 (u,v)/子集升序破平）。
 *
 * 与 PC 的方法论对照：约束法（条件独立）vs 评分法（BIC）——两者在
 * 大样本、faithful + 因果马尔可夫下收敛到同一马尔可夫等价类
 * （verify-r5-causal 以 SHD(ges.cpdag, pc.cpdag) = 0 锚定）。
 *
 * 诚实边界（对 GES 原版的简化）：不在等价类空间做算子（Chickering
 * 2002 的无局部最优保证只覆盖等价类算子）——d ≤ 12 用精确 DP 全局
 * 最优兜底，d > 12 的贪心只保证局部最优（扰动重启为实践补丁而非
 * 理论保证）；BIC 罚在 n→∞ 时一致（结构恢复到等价类）。共线父集
 * （R_{P,P} 奇异）的候选记 −∞ 跳过，不 throw。
 */
export function gesLite(data: ReadonlyArray<ReadonlyArray<number>>, opts: GesOptions = {}): GesResult {
  const { n, d } = validateData(data, 'gesLite');
  ensure(d >= 2, 'gesLite: 至少需要 2 个变量');
  ensure(n >= 5, 'gesLite: 至少需要 5 个样本');
  const penalty = opts.penalty ?? 1;
  ensure(Number.isFinite(penalty) && penalty > 0, 'gesLite: penalty 需为 > 0 的有限数');
  const { corr, sd } = fullCorrelationOf(data);
  for (let c = 0; c < d; c += 1) {
    ensure(sd[c] > 1e-12, `gesLite: 变量 ${String(c)} 近恒定（方差≈0），评分未定义`);
  }

  let nEvals = 0;
  /** 局部 BIC：v | parents（共线/退化父集 → −∞） */
  const localScore = (v: number, parents: ReadonlyArray<number>): number => {
    nEvals += 1;
    const k = parents.length;
    let r2 = 0;
    if (k > 0) {
      const Rpp: number[][] = parents.map((a) => parents.map((b) => corr[a][b]));
      const inv = tryInvertMatrix(Rpp);
      if (inv === null) return Number.NEGATIVE_INFINITY;
      let quad = 0;
      for (let a = 0; a < k; a += 1) for (let b = 0; b < k; b += 1) quad += corr[parents[a]][v] * inv[a][b] * corr[parents[b]][v];
      r2 = Math.min(1 - 1e-12, Math.max(0, quad)); // R² 截到 [0,1)（数值保护）
    }
    const sigma2 = Math.max(1e-12, 1 - r2);
    return -(n / 2) * (Math.log(2 * Math.PI) + 1 + Math.log(sigma2)) - (Math.log(n) / 2) * penalty * (k + 2);
  };

  const totalScore = (st: GesState): number => st.score.reduce((a, b) => a + b, 0);
  const cloneState = (st: GesState): GesState => ({
    adj: st.adj.map((row) => [...row]),
    parents: st.parents.map((p) => [...p]),
    score: [...st.score],
  });

  /** 加 u→v 是否成环：v 经现有边可达 u 即环 */
  const createsCycle = (adj: ReadonlyArray<ReadonlyArray<number>>, u: number, v: number): boolean => {
    const seen = new Array<boolean>(d).fill(false);
    const stack = [v];
    while (stack.length > 0) {
      const x = stack.pop() as number;
      if (x === u) return true;
      if (seen[x]) continue;
      seen[x] = true;
      for (let y = 0; y < d; y += 1) if (adj[x][y] === 1) stack.push(y);
    }
    return false;
  };

  /** 贪心至不动点（在 st 上原位收敛；audit 非空时记录轨迹；forbidden 为扰动禁边——重收敛期间不得重建该定向边） */
  const greedyToConvergence = (st: GesState, audit: GesStep[] | null, forbidden: readonly [number, number] | null = null): number => {
    const isForbidden = (u: number, v: number): boolean => forbidden !== null && forbidden[0] === u && forbidden[1] === v;
    for (;;) {
      let bestOp: GesStep | null = null;
      let bestDelta = 1e-10; // 只接受严格正增量（阈值吸收浮点噪声）
      let bestApply: (() => void) | null = null;
      for (let u = 0; u < d; u += 1) {
        for (let v = 0; v < d; v += 1) {
          if (u === v) continue;
          if (st.adj[u][v] === 0 && st.adj[v][u] === 0) {
            if (isForbidden(u, v)) continue; // 扰动禁边：不得原样重建
            if (createsCycle(st.adj, u, v)) continue; // add u→v
            const delta = localScore(v, [...st.parents[v], u]) - st.score[v];
            if (delta > bestDelta) {
              bestDelta = delta;
              bestOp = { op: 'add', u, v, delta };
              bestApply = () => {
                st.adj[u][v] = 1;
                st.parents[v].push(u);
              };
            }
          } else if (st.adj[u][v] === 1) {
            // delete u→v
            const delParents = st.parents[v].filter((p) => p !== u);
            const deltaDel = localScore(v, delParents) - st.score[v];
            if (deltaDel > bestDelta) {
              bestDelta = deltaDel;
              bestOp = { op: 'delete', u, v, delta: deltaDel };
              bestApply = () => {
                st.adj[u][v] = 0;
                st.parents[v] = delParents;
              };
            }
            // reverse u→v（删 u→v 加 v→u：u、v 两个局部评分都变）
            if (!isForbidden(v, u)) {
              st.adj[u][v] = 0; // 临时删边做环检查
              const cyc = createsCycle(st.adj, v, u); // 加 v→u 成环 ⟺ 存在路径 u→…→v
              st.adj[u][v] = 1;
              if (!cyc) {
                const revDelta =
                  localScore(v, delParents) - st.score[v] + localScore(u, [...st.parents[u], v]) - st.score[u];
                if (revDelta > bestDelta) {
                  bestDelta = revDelta;
                  bestOp = { op: 'reverse', u, v, delta: revDelta };
                  bestApply = () => {
                    st.adj[u][v] = 0;
                    st.adj[v][u] = 1;
                    st.parents[v] = delParents;
                    st.parents[u].push(v);
                  };
                }
              }
            }
          }
        }
      }
      if (bestOp === null || bestApply === null) break;
      bestApply();
      // 重算受影响节点的缓存评分
      if (bestOp.op === 'add' || bestOp.op === 'delete') {
        st.score[bestOp.v] = localScore(bestOp.v, st.parents[bestOp.v]);
      } else {
        st.score[bestOp.u] = localScore(bestOp.u, st.parents[bestOp.u]);
        st.score[bestOp.v] = localScore(bestOp.v, st.parents[bestOp.v]);
      }
      if (audit !== null) audit.push(bestOp);
    }
    return totalScore(st);
  };

  // ── 路径选择：d ≤ 12 精确 DP（全局最优）；更大走贪心 + 扰动重启 ──
  const EXACT_DP_BOUND = 12;
  const bits = (mask: number): number[] => {
    const out: number[] = [];
    for (let b = 0; b < d; b += 1) if (mask & (1 << b)) out.push(b);
    return out;
  };
  const full = (1 << d) - 1;

  let best: GesState;
  let exact = false;
  if (d <= EXACT_DP_BOUND) {
    // ── 精确 DP（Silander–Myllymäki）：best-parent-set 表 + best-sink 表 ──
    // bpsS[v][m] = max_{P ⊆ m} localScore(v, P)（m 不含 v；空集 = 无父）
    // G[W] = max_{v ∈ W} G[W∖{v}] + bpsS[v][W∖{v}]（W 的最优 DAG = 挑最优汇点 v 递归）
    const bpsS: Float64Array[] = [];
    const bpsMask: Int32Array[] = [];
    for (let v = 0; v < d; v += 1) {
      const size = 1 << d;
      const s = new Float64Array(size).fill(Number.NEGATIVE_INFINITY);
      const pm = new Int32Array(size);
      for (let m = 0; m <= full; m += 1) {
        if (m & (1 << v)) continue; // m 不含 v
        let bestScoreV = localScore(v, bits(m));
        let bestMask = m;
        for (let b = 0; b < d; b += 1) {
          if ((m & (1 << b)) === 0) continue;
          const sub = m & ~(1 << b);
          if (s[sub] > bestScoreV) {
            bestScoreV = s[sub];
            bestMask = pm[sub];
          }
        }
        s[m] = bestScoreV;
        pm[m] = bestMask;
      }
      bpsS.push(s);
      bpsMask.push(pm);
    }
    const G = new Float64Array(1 << d).fill(Number.NEGATIVE_INFINITY);
    const sink = new Int8Array(1 << d);
    G[0] = 0;
    for (let w = 1; w <= full; w += 1) {
      for (const v of bits(w)) {
        const prev = w & ~(1 << v);
        const cand = G[prev] + bpsS[v]![prev];
        if (cand > G[w]) {
          G[w] = cand;
          sink[w] = v;
        }
      }
    }
    // 重建：从全集合逐个摘最优汇点
    best = {
      adj: Array.from({ length: d }, () => new Array<number>(d).fill(0)),
      parents: Array.from({ length: d }, () => []),
      score: new Array<number>(d),
    };
    let w = full;
    while (w !== 0) {
      const v = sink[w]!;
      const prev = w & ~(1 << v);
      const paMask = bpsMask[v]![prev];
      for (const p of bits(paMask)) {
        best.adj[p][v] = 1;
        best.parents[v]!.push(p);
      }
      best.score[v] = bpsS[v]![prev];
      w = prev;
    }
    exact = true;
  } else {
    // ── 贪心 + 确定性扰动重启（d > 12）──
    const initial: GesState = {
      adj: Array.from({ length: d }, () => new Array<number>(d).fill(0)),
      parents: Array.from({ length: d }, () => []),
      score: new Array<number>(d),
    };
    for (let v = 0; v < d; v += 1) initial.score[v] = localScore(v, []);
    const history: GesStep[] = [];
    greedyToConvergence(initial, history);
    let bestScore = totalScore(initial);
    let cur = initial;
    for (let improved = true; improved; ) {
      improved = false;
      for (let u = 0; u < d && !improved; u += 1) {
        for (let v = 0; v < d && !improved; v += 1) {
          if (cur.adj[u]![v] !== 1) continue;
          const perturbed = cloneState(cur);
          perturbed.adj[u]![v] = 0;
          perturbed.parents[v] = perturbed.parents[v]!.filter((p) => p !== u);
          perturbed.score[v] = localScore(v, perturbed.parents[v]!);
          const s = greedyToConvergence(perturbed, null, [u, v]);
          if (s > bestScore + 1e-9) {
            cur = perturbed;
            bestScore = s;
            improved = true; // 评分单调上升 ⇒ 外层有界
          }
        }
      }
    }
    best = cur;
  }

  const dag = buildDag(d, best.adj.map((row) => [...row]), 'gesLite');
  return {
    dag: dag.adj.map((row) => [...row]),
    cpdag: cpdagFromDag(dag),
    score: totalScore(best),
    nEvals,
    nSteps: 0,
    history: [],
    nRestarts: 0,
    exact,
  };
}

// ─────────────────────────── 真图 → 等价类代表 / 图工具 ───────────────────────────

/**
 * 真 DAG → 其 CPDAG（马尔可夫等价类代表）: 骨架 + 真父集对撞定向 + Meek 闭合。
 * 与 pcAlgorithm 输出同口径可比（锚点③的 SHD=0 基准即用此函数生成）。
 */
export function cpdagFromDag(dag: Dag): MixedGraph {
  const { n, adj, parents } = normalizeDag(dag, 'cpdagFromDag');
  const edge: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  for (let u = 0; u < n; u += 1) for (let v = 0; v < n; v += 1) if (adj[u][v] === 1) {
    edge[u][v] = true;
    edge[v][u] = true;
  }
  const pattern: Pattern = { edge, arrow: Array.from({ length: n }, () => new Array<boolean>(n).fill(false)) };
  orientVStructures(pattern, (i, k, j) => adj[i][k] === 1 && adj[j][k] === 1);
  applyMeekRules(pattern);
  return patternToMixed(pattern).mixed;
}

/** 混合图边列表（i<j 一条） */
export interface MixedEdge {
  from: number;
  to: number;
  /** true = 定向 from→to；false = 无向 */
  directed: boolean;
}

/** 混合图 → 边列表（dashboard / 反思器易读口径） */
export function edgesOfMixed(m: MixedGraph): MixedEdge[] {
  const d = validateMixed(m, 'edgesOfMixed');
  const out: MixedEdge[] = [];
  for (let i = 0; i < d; i += 1) {
    for (let j = i + 1; j < d; j += 1) {
      if (m[i][j] === EDGE_STATE.directed) out.push({ from: i, to: j, directed: true });
      else if (m[i][j] === EDGE_STATE.undirected) out.push({ from: i, to: j, directed: false });
      else if (m[j][i] === EDGE_STATE.directed) out.push({ from: j, to: i, directed: true });
    }
  }
  return out;
}

/** v-结构（对撞三元组 x→k←z，x<z；反思器「共同结果」识别口径） */
export interface VStructure {
  x: number;
  collider: number;
  z: number;
}

/** 列出 CPDAG 中的 v-结构（两定向边共指、x,z 无边） */
export function vStructuresOf(m: MixedGraph): VStructure[] {
  const d = validateMixed(m, 'vStructuresOf');
  const out: VStructure[] = [];
  for (let k = 0; k < d; k += 1) {
    for (let x = 0; x < d; x += 1) {
      for (let z = x + 1; z < d; z += 1) {
        if (x === k || z === k) continue;
        if (m[x][k] === EDGE_STATE.directed && m[z][k] === EDGE_STATE.directed && m[x][z] === EDGE_STATE.none && m[z][x] === EDGE_STATE.none) {
          out.push({ x, collider: k, z });
        }
      }
    }
  }
  return out;
}

/** CPDAG 人读摘要（接线后 dashboard 一行口径） */
export function cpdagSummary(m: MixedGraph): string {
  const edges = edgesOfMixed(m);
  const directed = edges.filter((e) => e.directed).length;
  const undirected = edges.length - directed;
  const head = `${String(m.length)} 变量 · ${String(edges.length)} 边（${String(directed)} 定向 / ${String(undirected)} 无向）`;
  const vs = vStructuresOf(m);
  const tail = vs.length > 0 ? ` · ${String(vs.length)} 个 v-结构` : '';
  if (undirected > 0) return `${head}${tail}——${String(undirected)} 条方向可逆（观测不可分），等待 do-实验（5.0 接口）定向`;
  return `${head}${tail}——全部方向已由数据强制`;
}

// ─────────────────────────── DAG 工厂 + SEM 采样器 ───────────────────────────

/** 由 n×n 邻接矩阵组装 DAG（校验 + 重算父表/拓扑序） */
function buildDag(n: number, adj: number[][], who: string): Dag {
  const norm = normalizeDag({ n, adj, parents: [], order: [] }, who);
  return { n, adj, parents: norm.parents, order: norm.order };
}

/**
 * 随机 DAG 工厂（分层构造）: 随机置换变量 → 均分入 L = max(2, round(n/3))
 * 层 → 仅层 a < 层 b 的变量对以 edgeProb 概率连 a→b（层内无边，天然无环）。
 * 同种子同图（mulberry32）。
 */
export function randomDag(nVars: number, edgeProb: number, seed = 77): Dag {
  ensure(Number.isInteger(nVars) && nVars >= 1, 'randomDag: nVars 需为 ≥ 1 的整数');
  ensure(Number.isFinite(edgeProb) && edgeProb >= 0 && edgeProb <= 1, 'randomDag: edgeProb 需 ∈ [0,1]');
  ensure(Number.isFinite(seed), 'randomDag: seed 需为有限数');
  const rng = mulberry32(seed);
  const perm: number[] = [];
  for (let v = 0; v < nVars; v += 1) perm.push(v);
  for (let i = nVars - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  const nLayers = nVars === 1 ? 1 : Math.max(2, Math.round(nVars / 3));
  const layers: number[][] = Array.from({ length: nLayers }, () => []);
  for (let v = 0; v < nVars; v += 1) layers[Math.min(nLayers - 1, Math.floor((v * nLayers) / nVars))].push(perm[v]);
  const adj: number[][] = Array.from({ length: nVars }, () => new Array<number>(nVars).fill(0));
  for (let a = 0; a < nLayers; a += 1) {
    for (let b = a + 1; b < nLayers; b += 1) {
      for (const u of layers[a]) {
        for (const v of layers[b]) {
          if (rng() < edgeProb) adj[u][v] = 1;
        }
      }
    }
  }
  return buildDag(nVars, adj, 'randomDag');
}

/** 由边表构造 DAG（重复边/自环/环显式 throw） */
export function dagFromEdges(nVars: number, edges: ReadonlyArray<readonly [number, number]>): Dag {
  ensure(Number.isInteger(nVars) && nVars >= 1, 'dagFromEdges: nVars 需为 ≥ 1 的整数');
  const adj: number[][] = Array.from({ length: nVars }, () => new Array<number>(nVars).fill(0));
  for (const e of edges) {
    const u = e[0];
    const v = e[1];
    ensure(Number.isInteger(u) && Number.isInteger(v) && u >= 0 && u < nVars && v >= 0 && v < nVars, `dagFromEdges: 边 (${String(u)},${String(v)}) 下标越界`);
    ensure(u !== v, `dagFromEdges: 边 (${String(u)},${String(v)}) 是自环`);
    ensure(adj[u][v] === 0, `dagFromEdges: 边 (${String(u)},${String(v)}) 重复`);
    adj[u][v] = 1;
  }
  return buildDag(nVars, adj, 'dagFromEdges');
}

/** 线性高斯 SEM 采样选项 */
export interface SemOptions {
  /** 结构噪声标准差 σ（> 0，缺省 1；「结构噪声已知」口径——Fisher-z 检验与 SEM 闭环共用） */
  noiseSigma?: number;
  /** 边系数: 统一数值（缺省 0.9）或 (from,to) → 系数的确定性函数 */
  coefficients?: number | ((from: number, to: number) => number);
}

/**
 * 线性高斯 SEM 采样器: 拓扑序逐变量生成
 * X_v = Σ_{u∈pa(v)} b_{uv}·X_u + σ·ε_v，ε ~ N(0,1)（Box–Muller）。
 * 系数按 (u,v) 升序每个边求值一次（确定性）。同种子同样本。
 */
export function sampleLinearSem(dag: Dag, nSamples: number, opts: SemOptions = {}, seed = 77): number[][] {
  const { n, adj, parents, order } = normalizeDag(dag, 'sampleLinearSem');
  ensure(Number.isInteger(nSamples) && nSamples >= 1, 'sampleLinearSem: nSamples 需为 ≥ 1 的整数');
  const sigma = opts.noiseSigma ?? 1;
  ensure(Number.isFinite(sigma) && sigma > 0, 'sampleLinearSem: noiseSigma 需为 > 0 的有限数');
  const coefSpec = opts.coefficients ?? 0.9;
  const coefOf: (u: number, v: number) => number =
    typeof coefSpec === 'number' ? () => coefSpec : coefSpec;
  const coef: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let v = 0; v < n; v += 1) {
    for (const u of parents[v]) {
      const b = coefOf(u, v);
      ensure(Number.isFinite(b), `sampleLinearSem: 系数 (${String(u)},${String(v)}) 需为有限数`);
      coef[u][v] = b;
    }
  }
  ensure(adj.length === n, 'sampleLinearSem: 内部一致性校验失败');
  const rng = mulberry32(seed);
  const rows: number[][] = [];
  for (let s = 0; s < nSamples; s += 1) {
    const row = new Array<number>(n).fill(0);
    for (const v of order) {
      let acc = sigma * gaussianNoise(rng);
      for (const u of parents[v]) acc += coef[u][v] * row[u];
      row[v] = acc;
    }
    rows.push(row);
  }
  return rows;
}

// ─────────────────────────── 结构汉明距离 ───────────────────────────

/** 无向对的边类型（比较口径） */
function pairType(m: MixedGraph, i: number, j: number): 'none' | 'und' | 'ij' | 'ji' {
  if (m[i][j] === EDGE_STATE.directed) return 'ij';
  if (m[j][i] === EDGE_STATE.directed) return 'ji';
  if (m[i][j] === EDGE_STATE.undirected && m[j][i] === EDGE_STATE.undirected) return 'und';
  return 'none';
}

/**
 * 结构汉明距离 SHD: 逐无向对比较边类型（无边/无向/i→j/j→i），
 * 类型不同计 1（边的增删、方向翻转、无向↔定向差异各计 1）。
 *
 * 诚实口径: 与真 DAG 比较前先把真图过 cpdagFromDag（等价类口径）——
 * 直接与 DAG 比会把可逆边的无向输出误记为方向错误。
 */
export function structuralHammingDistance(truth: MixedGraph, learned: MixedGraph): number {
  const dt = validateMixed(truth, 'structuralHammingDistance.truth');
  const dl = validateMixed(learned, 'structuralHammingDistance.learned');
  ensure(dt === dl, `structuralHammingDistance: 两图阶数不一致（${String(dt)} vs ${String(dl)}）`);
  let shd = 0;
  for (let i = 0; i < dt; i += 1) {
    for (let j = i + 1; j < dt; j += 1) {
      if (pairType(truth, i, j) !== pairType(learned, i, j)) shd += 1;
    }
  }
  return shd;
}

/* ── 接线建议 ──
 * 挂载引擎: 世界模型 + 反思器 + 优化器（72.0 稀疏归因）+ 好奇心引擎
 * 1. 世界模型「因果结构自学」（主接线）: 观测指标流（模型旋钮 × 任务特征
 *    × KPI）攒成 n×d 数据矩阵 → pcAlgorithm → cpdag → 逐边喂给 5.0
 *    causal-kernel 的节点/边登记。5.0 负责「已知图做推断」（do-效应 /
 *    反事实 / 中介），本内核负责「图从哪来」——两内核合成完整因果闭环:
 *    观测学图（77.0）→ 图上推断（5.0）→ do-实验回填（5.0）→ 图修正。
 *    建议滑动窗口攒样本（如 30 天 × 去敏指标），alpha 用 0.01 抑制
 *    多重检验假阳性（n=5000 量级时幂度近乎 1）。
 * 2. 反思器归因升级: vStructuresOf 的对撞三元组识别「共同结果」节点
 *    （多因汇聚的 KPI），归因时区分「直接父因」与「对撞打开的伪关联」
 *    ——条件化对撞子会制造伪相关（锚点②的翻转），反思结论不再被它骗。
 * 3. 优化器稀疏归因（72.0）因果后端: 72.0 选出的稀疏特征子集作为
 *    条件集 S，partialCorrelationTest 给出「控制其余后还剩多少纯相关」
 *    ——归因权重以偏相关而非边际相关定价。
 * 4. 好奇心引擎定向探索: edgesOfMixed 中 directed=false 的边 = 观测
 *    不可分的方向不确定性 → 按 5.0 suggestExperiments 排优先级做
 *    do-实验定向——「学图 → 发现不可分处 → 主动实验」的科学循环。
 * 5. 缺省关闭旗标: config.kernels.causalDiscoveryEnabled = false
 *    （未开启时上述路径零介入——纯分析内核只读）。
 * 6. 挂载后改变的决策点: 世界模型结构获取（人工登记 → 观测自学）、
 *    反思归因口径（边际相关 → 偏相关/对撞感知）、好奇心目标（随机 →
 *    无向边定向实验）。诚实边界: CPDAG 只承诺等价类，无向边是「数据
 *    说不清」的诚实陈述，接线侧不得替它拍方向。
 */
