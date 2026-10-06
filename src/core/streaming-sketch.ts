/**
 * 80.0 流式概要内核 —— 单遍 O(小内存) 四件套：Count-Min / 蓄水池 / 指数直方图 / Misra–Gries
 *
 * 动机: 识别层面对的是海啸级信号流——每秒上万条信号、上万级键。把全量流
 * 存下来再统计（精确 Map / 窗口数组）在内存与延迟上是 O(N) 的豪赌；而调度
 * 真正需要的只是几个聚合读数: 该键出现了多少次（重信号识别）、窗口内到了
 * 多少条（到达率）、最近一段流的等概率样本（回放/审计）、谁是重元素
 * （Top 频率）。流式概要（streaming sketches）用 O(小内存) 单遍结构给出
 * 这些读数，且每个读数自带可证明的误差界——不是「大致准」，是「错也错
 * 不过 ε，以 1−δ 概率」。与 55.0 Hawkes 互补: Hawkes 管强度模型（事件
 * 激发事件的参数结构），本内核管原始流的概要统计——建模之前，先得有一份
 * 不爆内存的感官缓冲。
 *
 * 数学:
 *   ① Count-Min Sketch（Cormode–Muthukrishnan 2005）: d×w 非负计数矩阵，
 *     每行一个哈希，估计取 d 行最小。非负更新下每行只加不减 ⟹ 估计 ≥ 真值
 *     恒成立（只高不低）；且 P[估计 ≤ 真值 + ε‖a‖₁] ≥ 1−δ。尺寸公式
 *     w = ⌈e/ε⌉, d = ⌈ln(1/δ)⌉：单行 E[超出] ≤ ‖a‖₁/w，Markov 给
 *     P[单行超出 ε‖a‖₁] ≤ 1/(εw) ≤ 1/e，d 行（近似独立）取 min 后
 *     ≤ e^{−d} ≤ δ。哈希族: 自实现双散列 h_j(x) = (h₁(x)+j·h₂(x)) 的
 *     原料经**逐行 murmur 终混频**后落列（fmix32(h₁+j·h₂) mod w）。
 *     注意纯线性双散列 (h₁+j·h₂) mod w 不够: 键对以 1/w² 概率全行
 *     碰撞——Zipf 对抗流下重键撞车直接击穿 ε‖a‖₁ 界（实证: 10 万事件
 *     超出 13739 > 界 2000）；逐行混频把行间解耦后全行碰撞 ~w^{−d}，
 *     同流 5 种子全键最大超出降至 473 ≪ 2000（h₁/h₂ 由 FNV-1a 双通道
 *     散出，h₂ 取奇）。
 *   ② 蓄水池抽样（Vitter 1985, Algorithm R）: 前 k 个直接入池；第 i 个
 *     （0 基）以 k/(i+1) 概率替换池中均匀随机一格。归纳可证每个元素最终
 *     在池中的概率**精确**等于 k/n——不是近似相等，是精确（可按计数频次
 *     做证明性检验: 重复 T 次统计每元素入选频次 vs k/n）。
 *   ③ 指数直方图（Datar–Gindich–Rajagopalan–Upfal 滑动窗口计数）: 1 的
 *     桶序列（计数窗 = 最近 W 个元素），桶大小为 2 的幂、随年龄单调不减；
 *     同类桶达 m+2 个时合并最老两个到上一类（m = ⌈1/ε⌉）。窗口查询 =
 *     全桶求和 − 最老桶一半: 误差全部来自跨窗口边界的最老桶（大小 2^J），
 *     |N̂ − N₁| ≤ 2^{J−1}；而最老桶之下每类 ≥ m 桶 ⟹ N₁ ≥ m(2^J−1) ≥
 *     m·2^{J−1}（J ≥ 1）⟹ 相对误差 ≤ 1/m ≤ ε；J = 0 时绝对误差 ≤ 0.5。
 *     故任意位置 |N̂ − N₁| ≤ max(εN₁, 0.5)，且 N₁ ≥ m 时相对误差 ≤ ε。
 *     合不变量（逐步可查）: 桶大小 2 的幂、随年龄单调、同类 ≤ m+1。
 *     内存 O((1/ε)·log W) 桶 vs 朴素窗口数组的 W 格。
 *   ④ Misra–Gries（1982）: k 个计数器；未见键遇空位入表，满表则全体 −1、
 *     零值出局。每轮满表抵消消耗 k+1 个流元素 ⟹ 总抵消轮数 D ≤ N/(k+1)，
 *     从而任意键 计数 ≥ f − N/(k+1)（计数下界），且 f > N/(k+1) 的重元素
 *     必在输出——100% 捕获，确定性保证（非启发式）。
 *
 * R5-A17 世界性进化（数学轴 + 性能轴 + 稳健轴，2026-10）:
 *   ⑤ CountSketch（Charikar–Chen–Farach-Colton 2002）: 行哈希落列 + 符号
 *     哈希 s(x) ∈ {±1}，更新加 s(x)·c，估计取 d 行**中位数**。
 *     单行 Var ≤ ‖a‖₂²/w ⟹ Chebyshev P[|est−f| > ε‖a‖₂] ≤ 1/(wε²)；
 *     w = ⌈4/ε²⌉ 使单行失败 ≤ 1/4，d = 奇数 ⌈2·ln(1/δ)/ln(4/3)⌉ 使中位数
 *     失败 ≤ (4p(1−p))^{d/2} = (3/4)^{d/2} ≤ δ——**‖a‖₂ 口径**（CMS 是
 *     ‖a‖₁ 口径，偏斜流下 ‖a‖₂ ≪ ‖a‖₁）且**无符号更新**（负计数 = 删除，
 *     CMS 做不到）；代价是双侧误差（中位数无偏，不保证只高不低）。
 *     同种子同形状的两个 CountSketch 可做内积估计（误差 ε‖a‖₂‖b‖₂ 口径）。
 *   ⑥ CMS 哈希对缓存（opt-in）: hashCacheSize > 0 时 memoize 键 → (h₁,h₂)
 *     对（容量满即整体清空——确定性淘汰）。散列值逐位不变 ⟹ 全部估计与
 *     无缓存路径**逐位一致**；重复键流（信号流的常态）省掉重复 FNV+murmur。
 *
 *   验证锚点（scripts/verify-streaming-sketch.mjs）:
 *     ① CMS: Zipf(1.5) 对抗流 10 万事件 × 5 种子: 全键只高不低、超出
 *        ≤ ε‖a‖₁、稀有键误差同样受控；单键零碰撞精确恢复；w/d 尺寸与
 *        闭式 ⌈e/ε⌉·⌈ln(1/δ)⌉ 逐位一致；宽松配置 (w=28,d=3) 违例率
 *        ≤ 1% < δ=5%（δ 语义的实证: 概率界逐键成立而非全键联合）。
 *     ② 蓄水池: n=10⁵, k=50 × 300 次: 总入选 = T·k 精确闭合、离散比与
 *        极值守卫；强统计版 n=10³ × 40000 次: 每元素入选频率 vs k/n 最大
 *        偏差 < 0.005、χ²/dof ∈ [0.85, 1.15]（等概率的证明性检验；
 *        重复试验种子须散布——mulberry32 顺序种子流间相关，实证 χ²
 *        过度离散至 1.19，按 7919·t 散布后回到 1.0 附近）。
 *     ③ 指数直方图: 三态突发位流 10 万、W=1000、ε=0.1——滑窗全位置扫描
 *        |N̂−N₁| ≤ max(εN₁, 0.5) 处处成立（含稀疏位）、稠密位（N₁ ≥ m）
 *        相对误差 ≤ ε；桶合不变量全程成立；内存节省倍数报告。
 *     ④ Misra–Gries: >20% 频率元素 100% 捕获（k=4）、>10%（k=9）双口径；
 *        计数下界 ∀ 键成立；纯均匀流无假阳性重元素。
 *     ⑤ verifySketches 一站式四段全过 + 内存上界公式 vs 实测
 *        （w·d / k / (m+1)(⌊log₂W⌋+2) / k）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────── 缺省口径（const 对象，非 enum——strip-types 兼容） ───────────────────

export const STREAMING_SKETCH_DEFAULTS = {
  /** CMS 缺省 ε：估计超出 ≤ 0.02·‖a‖₁ */
  cmsEps: 0.02,
  /** CMS 缺省 δ：保证以 ≥ 99% 概率成立 */
  cmsDelta: 0.01,
  /** 蓄水池缺省池容量 */
  reservoirK: 50,
  /** 蓄水池证明性检验的缺省重复次数 */
  reservoirTrials: 200,
  /** 指数直方图缺省 ε */
  histogramEps: 0.1,
  /** 指数直方图缺省窗口（元素数） */
  histogramWindow: 1000,
  /** Misra–Gries 缺省计数器数（保证阈 N/10） */
  misraGriesK: 9,
} as const;

// ─────────────────── 确定性随机源与哈希 ───────────────────

/** mulberry32——本内核唯一随机源（蓄水池抽样用；同 seed 逐位复现） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32 位（字符串 → uint32；seed 混入偏移，同串异种子异散列） */
function fnv1a32(text: string, seed: number): number {
  let h = (2166136261 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** murmur3 终混频（雪崩整流：相邻输入均匀散开） */
function fmix32(x: number): number {
  let h = x >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** 键规范化: number → string（1 与 '1' 同键，文档化口径） */
function normalizeKey(key: string | number): string {
  return typeof key === 'number' ? String(key) : key;
}

// ─────────────────── ① Count-Min Sketch ───────────────────

export interface CountMinSketchOptions {
  /** 误差率 ε ∈ (0,1]：估计超出 ≤ ε·‖a‖₁ */
  eps: number;
  /** 失败率 δ ∈ (0,1)：保证以 ≥ 1−δ 概率成立 */
  delta: number;
  /** 哈希族种子（缺省 0；同种子同表——确定性） */
  seed?: number;
  /**
   * R5 哈希对缓存容量（缺省 0 = 关闭）。> 0 时 memoize 规范化键 → (h₁,h₂)
   * （容量满即整体清空——确定性淘汰，无 LRU 随机性）。散列值逐位不变，
   * 全部估计与无缓存路径**逐位一致**；重复**长键**流（信号键的常态——
   * FNV-1a 代价随键长线性增长，而引擎的字符串哈希有缓存）省掉重复
   * FNV-1a + murmur 终混（短键场景哈希本来就便宜，缓存得不偿失——保持 0）。
   */
  hashCacheSize?: number;
}

export interface CountMinSketchStats {
  eps: number;
  delta: number;
  /** 宽 w = ⌈e/ε⌉ */
  width: number;
  /** 深 d = ⌈ln(1/δ)⌉ */
  depth: number;
  /** 内存格数 w·d */
  cells: number;
  /** 累计更新权重 ‖a‖₁（非负更新口径） */
  total: number;
}

/** 尺寸闭式: w = ⌈e/ε⌉, d = ⌈ln(1/δ)⌉（Markov + 独立行的标准推导） */
export function countMinSketchShape(
  eps: number,
  delta: number,
): { width: number; depth: number; cells: number } {
  if (!Number.isFinite(eps) || !(eps > 0) || eps > 1) {
    throw new Error(`countMinSketchShape: eps ∈ (0,1] 必需（得到 ${eps}）`);
  }
  if (!Number.isFinite(delta) || !(delta > 0) || delta >= 1) {
    throw new Error(`countMinSketchShape: delta ∈ (0,1) 必需（得到 ${delta}）`);
  }
  const width = Math.ceil(Math.E / eps);
  const depth = Math.max(1, Math.ceil(Math.log(1 / delta)));
  return { width, depth, cells: width * depth };
}

export class CountMinSketch {
  private readonly eps: number;
  private readonly delta: number;
  private readonly width: number;
  private readonly depth: number;
  private readonly seed: number;
  private readonly table: Float64Array;
  private totalWeight = 0;
  /** R5: 键 → [h1, h2] 缓存（hashCacheSize > 0 时启用；满即清空） */
  private readonly hashCache: Map<string, [number, number]> | null;
  private readonly hashCacheSize: number;

  constructor(options: CountMinSketchOptions) {
    const shape = countMinSketchShape(options.eps, options.delta);
    const seed = options.seed ?? 0;
    if (!Number.isFinite(seed)) {
      throw new Error(`CountMinSketch: seed 必须为有限数（得到 ${seed}）`);
    }
    const hashCacheSize = options.hashCacheSize ?? 0;
    if (!Number.isInteger(hashCacheSize) || hashCacheSize < 0) {
      throw new Error(`CountMinSketch: hashCacheSize 须为 ≥0 整数（得到 ${hashCacheSize}）`);
    }
    this.eps = options.eps;
    this.delta = options.delta;
    this.width = shape.width;
    this.depth = shape.depth;
    this.seed = seed;
    this.table = new Float64Array(shape.cells);
    this.hashCacheSize = hashCacheSize;
    this.hashCache = hashCacheSize > 0 ? new Map<string, [number, number]>() : null;
  }

  /** 注入计数 c（缺省 1；非负）。返回 this 便于链式 */
  update(key: string | number, c?: number): this {
    const weight = c ?? 1;
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`CountMinSketch.update: c ≥ 0 必需（得到 ${weight}）`);
    }
    const { h1, h2 } = this.keyHashes(key);
    for (let j = 0; j < this.depth; j += 1) {
      const col = this.columnOf(h1, h2, j);
      this.table[j * this.width + col] += weight;
    }
    this.totalWeight += weight;
    return this;
  }

  /** 点查询估计: d 行取 min——只高不低，且以 ≥ 1−δ 概率 ≤ 真值 + ε‖a‖₁ */
  estimate(key: string | number): number {
    const { h1, h2 } = this.keyHashes(key);
    let best = Infinity;
    for (let j = 0; j < this.depth; j += 1) {
      const v = this.table[j * this.width + this.columnOf(h1, h2, j)];
      if (v < best) best = v;
    }
    return best;
  }

  stats(): CountMinSketchStats {
    return {
      eps: this.eps,
      delta: this.delta,
      width: this.width,
      depth: this.depth,
      cells: this.width * this.depth,
      total: this.totalWeight,
    };
  }

  /** 双散列对 (h₁, h₂): h₂ 强制为奇数（行序列整周期倾向）；R5: 可选缓存 */
  private keyHashes(key: string | number): { h1: number; h2: number } {
    if (this.hashCache !== null) {
      const cached = this.hashCache.get(normalizeKey(key));
      if (cached !== undefined) return { h1: cached[0], h2: cached[1] };
    }
    const text = normalizeKey(key);
    const h1 = fmix32(fnv1a32(text, this.seed));
    const h2 = fmix32(fnv1a32(text, (this.seed ^ 0x9e3779b9) >>> 0)) | 1;
    if (this.hashCache !== null) {
      if (this.hashCache.size >= this.hashCacheSize) this.hashCache.clear(); // 确定性淘汰
      this.hashCache.set(text, [h1, h2]);
    }
    return { h1, h2 };
  }

  /**
   * 第 j 行列号: 双散列原料 (h₁+j·h₂) mod 2³² 经 murmur 终混频后落列。
   * 纯线性 (h₁+j·h₂) mod w 的行碰撞结构相关（键对以 1/w² 全行碰撞，
   * 重键撞车击穿 ε‖a‖₁ 界）；逐行混频解耦行间后全行碰撞 ~w^{−d}。
   */
  private columnOf(h1: number, h2: number, j: number): number {
    return fmix32((h1 + j * h2) >>> 0) % this.width;
  }
}

// ─────────────────── ⑤ R5: CountSketch（带符号计数 + 中位数估计 + ‖a‖₂ 界） ───────────────────

export interface CountSketchOptions {
  /** 误差率 ε ∈ (0,1]：|est − f| ≤ ε·‖a‖₂（以 ≥ 1−δ 概率） */
  eps: number;
  /** 失败率 δ ∈ (0,1) */
  delta: number;
  /** 哈希族种子（缺省 0） */
  seed?: number;
}

export interface CountSketchStats {
  eps: number;
  delta: number;
  /** 宽 w = ⌈4/ε²⌉（单行 Chebyshev 失败 ≤ 1/4） */
  width: number;
  /** 深 d = 奇数 ⌈2·ln(1/δ)/ln(4/3)⌉（中位数失败 ≤ (3/4)^{d/2} ≤ δ） */
  depth: number;
  cells: number;
  /** Σ|c| 口径的总注入权重绝对值和（诊断用） */
  totalAbsWeight: number;
}

/**
 * 尺寸闭式（CountSketch）: w = ⌈4/ε²⌉, d = 奇数 ⌈2·ln(1/δ)/ln(4/3)⌉。
 * 单行 est = c_x + 碰撞噪声，Var ≤ ‖a‖₂²/w（符号哈希零均值两两独立）；
 * Chebyshev ⟹ 单行失败 ≤ 1/(wε²) ≤ 1/4；d 行中位数失败
 * ≤ (4p(1−p))^{d/2} = (3/4)^{d/2} ≤ δ。
 */
export function countSketchShape(eps: number, delta: number): { width: number; depth: number; cells: number } {
  if (!Number.isFinite(eps) || !(eps > 0) || eps > 1) {
    throw new Error(`countSketchShape: eps ∈ (0,1] 必需（得到 ${eps}）`);
  }
  if (!Number.isFinite(delta) || !(delta > 0) || delta >= 1) {
    throw new Error(`countSketchShape: delta ∈ (0,1) 必需（得到 ${delta}）`);
  }
  const width = Math.ceil(4 / (eps * eps));
  const rawDepth = Math.ceil((2 * Math.log(1 / delta)) / Math.log(4 / 3));
  const depth = rawDepth % 2 === 1 ? rawDepth : rawDepth + 1; // 奇数行——中位数无插补歧义
  return { width, depth, cells: width * depth };
}

/**
 * CountSketch（Charikar–Chen–Farach-Colton 2002）: 更新 (key, c) 加
 * s_j(key)·c 到各行列格（符号哈希 ±1）；估计 = d 行 s_j(key)·cell 的中位数。
 *
 * 与 CMS 的分工: CMS 只高不低但只吃非负计数、误差按 ‖a‖₁ 计；CountSketch
 * **带符号**（负计数 = 删除，精确对消可验）、无偏（中位数双侧）、误差按
 * ‖a‖₂ 计（偏斜流下 ‖a‖₂ ≪ ‖a‖₁——同等格数时误差口径更紧）。
 * 内积估计 innerProduct: 同种子同形状的两个 sketch 共享哈希 ⟹
 * ⟨a,b⟩̂ = Σ_cells tableA[cell]·tableB[cell]，误差 ε·‖a‖₂·‖b‖₂ 口径。
 */
export class CountSketch {
  private readonly eps: number;
  private readonly delta: number;
  private readonly width: number;
  private readonly depth: number;
  private readonly seed: number;
  private readonly table: Float64Array;
  private totalAbsWeight = 0;

  constructor(options: CountSketchOptions) {
    const shape = countSketchShape(options.eps, options.delta);
    const seed = options.seed ?? 0;
    if (!Number.isFinite(seed)) {
      throw new Error(`CountSketch: seed 必须为有限数（得到 ${seed}）`);
    }
    this.eps = options.eps;
    this.delta = options.delta;
    this.width = shape.width;
    this.depth = shape.depth;
    this.seed = seed;
    this.table = new Float64Array(shape.cells);
  }

  /** 注入计数 c（缺省 1；**任意有限数**——负 = 删除/回退）。返回 this */
  update(key: string | number, c?: number): this {
    const weight = c ?? 1;
    if (!Number.isFinite(weight)) {
      throw new Error(`CountSketch.update: c 需为有限数（得到 ${weight}）`);
    }
    const text = normalizeKey(key);
    const h1 = fmix32(fnv1a32(text, this.seed));
    const h2 = fmix32(fnv1a32(text, (this.seed ^ 0x5bd1e995) >>> 0)) | 1;
    for (let j = 0; j < this.depth; j += 1) {
      const col = fmix32((h1 + j * h2) >>> 0) % this.width;
      const sign = this.signOf(h1, h2, j);
      this.table[j * this.width + col] += sign * weight;
    }
    this.totalAbsWeight += Math.abs(weight);
    return this;
  }

  /** 点查询估计: d 行 s_j·cell 取中位数（无偏、双侧） */
  estimate(key: string | number): number {
    const text = normalizeKey(key);
    const h1 = fmix32(fnv1a32(text, this.seed));
    const h2 = fmix32(fnv1a32(text, (this.seed ^ 0x5bd1e995) >>> 0)) | 1;
    const rows: number[] = [];
    for (let j = 0; j < this.depth; j += 1) {
      const col = fmix32((h1 + j * h2) >>> 0) % this.width;
      rows.push(this.signOf(h1, h2, j) * this.table[j * this.width + col]);
    }
    rows.sort((a, b) => a - b);
    return rows[(rows.length - 1) >> 1]!;
  }

  /**
   * 内积估计 ⟨a,b⟩̂ = (1/d)·Σ_cells tableA·tableB（d 行平均——期望恰为
   * ⟨a,b⟩，方差 ≤ ‖a‖₂²‖b‖₂²/(w·d)；要求同 seed 同形状——哈希族共享是
   * 内积口径的前提，不同哈希的格积只是噪声）。误差 ε‖a‖₂‖b‖₂ 口径。
   */
  innerProduct(other: CountSketch): number {
    if (!(other instanceof CountSketch)) throw new Error('CountSketch.innerProduct: 参数需为 CountSketch');
    if (other.width !== this.width || other.depth !== this.depth || other.seed !== this.seed) {
      throw new Error('CountSketch.innerProduct: 需同 seed 同形状（哈希族共享）');
    }
    let acc = 0;
    for (let i = 0; i < this.table.length; i += 1) acc += this.table[i]! * other.table[i]!;
    return acc / this.depth;
  }

  stats(): CountSketchStats {
    return {
      eps: this.eps,
      delta: this.delta,
      width: this.width,
      depth: this.depth,
      cells: this.width * this.depth,
      totalAbsWeight: this.totalAbsWeight,
    };
  }

  /** 第 j 行符号哈希 s_j(x) ∈ {−1,+1}（独立通道散出后取奇偶） */
  private signOf(h1: number, h2: number, j: number): number {
    return (fmix32((h1 + (j + 1) * (h2 ^ 0x85ebca6b)) >>> 0) & 1) === 0 ? 1 : -1;
  }
}

// ─────────────────── ② 蓄水池抽样 ───────────────────

/**
 * 蓄水池抽样（Vitter 1985, Algorithm R）。
 * 前 k 个直接入池；第 i 个（0 基）以 k/(i+1) 概率替换池中均匀随机一格。
 * 归纳: P(元素 i 最终在池中) = k/n **精确**——等概率不是渐近性质。
 */
export class ReservoirSampler<T = unknown> {
  private readonly k: number;
  private readonly reservoir: T[] = [];
  private seenTotal = 0;
  private readonly rand: () => number;

  constructor(k: number, seed = 1) {
    if (!Number.isInteger(k) || k < 1) {
      throw new Error(`ReservoirSampler: k 须为 ≥1 整数（得到 ${k}）`);
    }
    if (!Number.isFinite(seed)) {
      throw new Error(`ReservoirSampler: seed 必须为有限数（得到 ${seed}）`);
    }
    this.k = k;
    this.rand = mulberry32(seed);
  }

  /** 喂入第 n 个元素（O(1)；替换决策用文件内 mulberry32） */
  feed(x: T): this {
    this.seenTotal += 1;
    if (this.reservoir.length < this.k) {
      this.reservoir.push(x);
      return this;
    }
    const j = Math.floor(this.rand() * this.seenTotal); // 均匀于 [0, n)
    if (j < this.k) this.reservoir[j] = x;
    return this;
  }

  /** 当前蓄水池快照（拷贝；长度 = min(n, k)） */
  sample(): T[] {
    return this.reservoir.slice();
  }

  /** 池容量 k（内存上界：k 格） */
  get capacity(): number {
    return this.k;
  }

  /** 已喂入元素数 n */
  get seen(): number {
    return this.seenTotal;
  }

  /** 当前池内元素数 */
  get poolSize(): number {
    return this.reservoir.length;
  }
}

// ─────────────────── ③ 指数直方图 ───────────────────

export interface ExponentialHistogramOptions {
  /** 相对误差 ε ∈ (0,0.5]（m = ⌈1/ε⌉ ≥ 2） */
  eps: number;
  /** 计数窗 W（最近 W 个已插入元素；≥1 整数） */
  window: number;
}

export interface ExponentialHistogramStats {
  eps: number;
  window: number;
  /** m = ⌈1/ε⌉（同类桶合并阈值 m+2 的 m） */
  m: number;
  /** 当前桶数 */
  buckets: number;
  /** 峰值桶数（内存实测口径） */
  peakBuckets: number;
  /** 内存上界 (m+1)(⌊log₂W⌋+2) 桶 */
  memoryBound: number;
  /** 累计合并次数 */
  merges: number;
  /** 已插入元素数 */
  inserted: number;
  /** 已插入 1 的个数 */
  ones: number;
  /** 合不变量当前是否成立（2 的幂 / 随年龄单调 / 同类 ≤ m+1） */
  invariantHolds: boolean;
}

/** 桶数上界公式: (m+1)(⌊log₂W⌋+2)——非跨界桶 ≤ W 格 ⟹ 类数 ≤ ⌊log₂W⌋+2 */
export function exponentialHistogramMemoryBound(eps: number, window: number): number {
  if (!Number.isFinite(eps) || !(eps > 0) || eps > 0.5) {
    throw new Error(`exponentialHistogramMemoryBound: eps ∈ (0,0.5] 必需（得到 ${eps}）`);
  }
  if (!Number.isInteger(window) || window < 1) {
    throw new Error(`exponentialHistogramMemoryBound: window 须为 ≥1 整数（得到 ${window}）`);
  }
  const m = Math.ceil(1 / eps);
  return (m + 1) * (Math.floor(Math.log2(window)) + 2);
}

/** 桶: size 个连续 1（2 的幂），newest = 桶内最新 1 的插入位次（1 基） */
interface EHBucket {
  size: number;
  newest: number;
}

export class ExponentialHistogram {
  private readonly eps: number;
  private readonly windowSize: number;
  private readonly m: number;
  private buckets: EHBucket[] = []; // index 0 = 最老（最大桶）；新桶 push 在尾
  private insertedTotal = 0;
  private onesTotal = 0;
  private mergesTotal = 0;
  private peakBuckets = 0;

  constructor(options: ExponentialHistogramOptions) {
    const { eps, window } = options;
    if (!Number.isFinite(eps) || !(eps > 0) || eps > 0.5) {
      throw new Error(
        `ExponentialHistogram: eps ∈ (0,0.5] 必需（得到 ${eps}——ε>0.5 时 m=⌈1/ε⌉<2，相对误差界退化）`,
      );
    }
    if (!Number.isInteger(window) || window < 1) {
      throw new Error(`ExponentialHistogram: window 须为 ≥1 整数（得到 ${window}）`);
    }
    this.eps = eps;
    this.windowSize = window;
    this.m = Math.ceil(1 / eps);
  }

  /**
   * 插入一个元素: x 为载荷（直方图只计数不存值，参数保留以符合流式口径），
   * isOne 标记该元素是否计入窗口计数。计数窗 = 最近 window 个已插入元素。
   */
  insert(x: unknown, isOne: boolean): this {
    if (typeof isOne !== 'boolean') {
      throw new Error(`ExponentialHistogram.insert: isOne 必须为 boolean（得到 ${typeof isOne}）`);
    }
    this.insertedTotal += 1;
    if (isOne) {
      this.onesTotal += 1;
      this.buckets.push({ size: 1, newest: this.insertedTotal });
      this.rebalance();
    }
    this.expire();
    if (this.buckets.length > this.peakBuckets) this.peakBuckets = this.buckets.length;
    return this;
  }

  /** 滑窗计数估计: 全桶求和 − 最老桶一半（|N̂−N₁| ≤ max(εN₁, 0.5)） */
  windowCount(): number {
    this.expire();
    if (this.buckets.length === 0) return 0;
    let sum = 0;
    for (let i = 1; i < this.buckets.length; i += 1) sum += this.buckets[i].size;
    return sum + this.buckets[0].size / 2;
  }

  stats(): ExponentialHistogramStats {
    return {
      eps: this.eps,
      window: this.windowSize,
      m: this.m,
      buckets: this.buckets.length,
      peakBuckets: this.peakBuckets,
      memoryBound: exponentialHistogramMemoryBound(this.eps, this.windowSize),
      merges: this.mergesTotal,
      inserted: this.insertedTotal,
      ones: this.onesTotal,
      invariantHolds: this.invariantHolds(),
    };
  }

  /** 合不变量: 桶大小 2 的幂、随年龄单调不减（index 0 最大）、同类 ≤ m+1 */
  private invariantHolds(): boolean {
    let prevSize = Infinity;
    let runLength = 0;
    for (const b of this.buckets) {
      if (b.size < 1 || (b.size & (b.size - 1)) !== 0) return false;
      if (b.size > prevSize) return false;
      if (b.size === prevSize) {
        runLength += 1;
        if (runLength > this.m + 1) return false;
      } else {
        runLength = 1;
      }
      prevSize = b.size;
    }
    return true;
  }

  /** 同类桶达 m+2 → 反复合并最老两个到上一类（计数落回 ≥ m，误差界由此而生） */
  private rebalance(): void {
    for (;;) {
      const at = this.findOverflowRun();
      if (at < 0) return;
      const oldest = this.buckets[at];
      const newer = this.buckets[at + 1];
      this.buckets.splice(at, 2, { size: oldest.size * 2, newest: newer.newest });
      this.mergesTotal += 1;
    }
  }

  /** 第一个长度 ≥ m+2 的同类桶区段起点（无则 −1）；区段内最老两个在最左 */
  private findOverflowRun(): number {
    let i = 0;
    while (i < this.buckets.length) {
      let j = i + 1;
      while (j < this.buckets.length && this.buckets[j].size === this.buckets[i].size) j += 1;
      if (j - i >= this.m + 2) return i;
      i = j;
    }
    return -1;
  }

  /** 惰性过期: 桶内最新 1 已离开窗口（位次 ≤ total−W）则整桶出队 */
  private expire(): void {
    const cutoff = this.insertedTotal - this.windowSize;
    while (this.buckets.length > 0 && this.buckets[0].newest <= cutoff) this.buckets.shift();
  }
}

// ─────────────────── ④ Misra–Gries 重元素 ───────────────────

export interface MisraGriesCandidate<K = string | number> {
  key: K;
  /** 结束时仍在表的计数（真值 f 的下界: ≥ f − N/(k+1)，且 ≤ f） */
  count: number;
}

export interface MisraGriesResult<K = string | number> {
  /** 候选重元素（按计数降序；长度 ≤ k） */
  candidates: MisraGriesCandidate<K>[];
  /** 流长 N */
  n: number;
  /** 计数器数 k */
  counters: number;
  /** 保证阈 N/(k+1): f > 阈 ⟹ 必在 candidates（100% 捕获） */
  threshold: number;
}

/**
 * Misra–Gries 重元素（1982）: k 个计数器；未见键遇空位入表，满表则全体
 * −1、零值出局。每轮满表抵消消耗 k+1 个流元素 ⟹ 抵消轮数 ≤ N/(k+1)，
 * 从而 计数 ≥ f − N/(k+1) 且 f > N/(k+1) 的元素必在输出。
 */
export function misraGries<K>(stream: ReadonlyArray<K>, k: number): MisraGriesResult<K> {
  if (!Array.isArray(stream)) throw new Error('misraGries: stream 必须为数组');
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`misraGries: k 须为 ≥1 整数（得到 ${k}）`);
  }
  const counters = new Map<K, number>();
  for (const key of stream) {
    const current = counters.get(key);
    if (current !== undefined) {
      counters.set(key, current + 1);
    } else if (counters.size < k) {
      counters.set(key, 1);
    } else {
      for (const [existing, value] of counters) {
        if (value <= 1) counters.delete(existing);
        else counters.set(existing, value - 1);
      }
    }
  }
  const candidates: MisraGriesCandidate<K>[] = [...counters.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
  const n = stream.length;
  return { candidates, n, counters: k, threshold: n / (k + 1) };
}

// ─────────────────── ⑤ 一站式检验工具 ───────────────────

export interface VerifySketchesInput {
  /** 键流（CMS / 蓄水池 / Misra–Gries 的检验输入；每事件权重 1） */
  stream: ReadonlyArray<string | number>;
  /** CMS 段配置（缺省 ε=0.02, δ=0.01, seed=0） */
  cms?: { eps?: number; delta?: number; seed?: number };
  /** 蓄水池段配置（缺省 k=50, trials=200, seed=7919；要求 k ≤ n） */
  reservoir?: { k?: number; trials?: number; seed?: number };
  /** 指数直方图段（提供 bits 才运行；缺省 ε=0.1, W=1000） */
  histogram?: { eps?: number; window?: number; bits?: ReadonlyArray<number> };
  /** Misra–Gries 段配置（缺省 k=9） */
  misraGries?: { k?: number };
}

export interface CmsProbeSection {
  eps: number;
  delta: number;
  width: number;
  depth: number;
  cells: number;
  l1: number;
  /** 保证上界 ε·‖a‖₁ */
  bound: number;
  /** 全键最大超出（估计 − 真值） */
  worstExcess: number;
  worstKey: string;
  /** 只高不低性质（∀ 键 估计 ≥ 真值——确定性，非概率） */
  oneSidedHolds: boolean;
  boundHolds: boolean;
  passed: boolean;
}

export interface ReservoirProbeSection {
  k: number;
  trials: number;
  n: number;
  /** 期望入选率 k/n */
  expectedRate: number;
  totalPicked: number;
  totalExpected: number;
  /** 总入选 = 试验数×k 精确闭合（每试验恰选 k 个的确定性自检） */
  totalExact: boolean;
  maxCount: number;
  maxCountBound: number;
  /** 计数方差/期望 vs 1−p（二项离散比；λ ≥ 5 时另算 χ²/dof） */
  dispersion: number;
  chiSquareOverDof: number | null;
  passed: boolean;
}

export interface HistogramProbeSection {
  eps: number;
  window: number;
  m: number;
  /** 扫描的滑窗位置数（从第 1 个元素起全位置） */
  scanned: number;
  /** 稠密位（N₁ ≥ m）最大相对误差 */
  maxRelErrorDense: number;
  densePositions: number;
  /** 全位置最大绝对误差 */
  maxAbsError: number;
  boundHolds: boolean;
  invariantHolds: boolean;
  bucketsPeak: number;
  memoryBound: number;
  naiveCells: number;
  savingFactor: number;
  passed: boolean;
}

export interface MisraGriesProbeSection {
  k: number;
  threshold: number;
  /** 真频率 > 阈的键（规范化字符串） */
  heavyKeys: string[];
  /** 漏捕的重元素（保证下应为空） */
  missingHeavies: string[];
  /** 报告为重但真频率 ≤ 阈的键（保证下应为空） */
  falseHeavies: (string | number)[];
  /** ∀ 键 计数 ≥ f − N/(k+1) */
  countLowerBoundHolds: boolean;
  candidatesWithinSlots: boolean;
  passed: boolean;
}

export interface VerifySketchesReport {
  n: number;
  distinct: number;
  l1: number;
  cms: CmsProbeSection;
  reservoir: ReservoirProbeSection;
  histogram: HistogramProbeSection | null;
  misraGries: MisraGriesProbeSection;
  allPassed: boolean;
}

/**
 * 一站式概要自检: 对给定键流（及可选位流）同时跑四结构，用精确计数
 * （Map / 前缀和）做地面真值，逐条检查各自的教学保证:
 *   CMS 只高不低 + ε‖a‖₁ 界；蓄水池 精确闭合 + 极值/离散守卫；
 *   指数直方图 max(εN₁,0.5) 全位置界 + 合不变量；MG 重元素 100% 捕获 +
 *   计数下界。全部确定性（内部 mulberry32，seed 可注入）。
 */
export function verifySketches(input: VerifySketchesInput): VerifySketchesReport {
  if (input === null || typeof input !== 'object') {
    throw new Error('verifySketches: input 必须为对象');
  }
  const stream = input.stream;
  if (!Array.isArray(stream)) throw new Error('verifySketches: stream 必须为数组');
  const n = stream.length;
  if (n === 0) throw new Error('verifySketches: stream 不能为空');
  const truth = new Map<string, number>();
  for (const key of stream) {
    const normalized = normalizeKey(key);
    truth.set(normalized, (truth.get(normalized) ?? 0) + 1);
  }
  const l1 = n;

  // ── CMS 段 ──
  const eps = input.cms?.eps ?? STREAMING_SKETCH_DEFAULTS.cmsEps;
  const delta = input.cms?.delta ?? STREAMING_SKETCH_DEFAULTS.cmsDelta;
  const seed = input.cms?.seed ?? 0;
  const sketch = new CountMinSketch({ eps, delta, seed });
  for (const key of stream) sketch.update(key);
  let worstExcess = -Infinity;
  let worstKey = '';
  let oneSidedHolds = true;
  for (const [key, trueCount] of truth) {
    const est = sketch.estimate(key);
    if (est < trueCount) oneSidedHolds = false;
    if (est - trueCount > worstExcess) {
      worstExcess = est - trueCount;
      worstKey = key;
    }
  }
  const bound = eps * l1;
  const stats = sketch.stats();
  const cmsSection: CmsProbeSection = {
    eps,
    delta,
    width: stats.width,
    depth: stats.depth,
    cells: stats.cells,
    l1,
    bound,
    worstExcess,
    worstKey,
    oneSidedHolds,
    boundHolds: worstExcess <= bound,
    passed: oneSidedHolds && worstExcess <= bound,
  };

  // ── 蓄水池段（对元素下标抽样，统计每元素入选计数） ──
  const k = input.reservoir?.k ?? STREAMING_SKETCH_DEFAULTS.reservoirK;
  const trials = input.reservoir?.trials ?? STREAMING_SKETCH_DEFAULTS.reservoirTrials;
  const reservoirSeed = input.reservoir?.seed ?? 7919;
  if (!Number.isInteger(trials) || trials < 1 || trials > 1000000) {
    throw new Error(`verifySketches: reservoir.trials 须为 [1,10⁶] 整数（得到 ${trials}）`);
  }
  if (k > n) {
    throw new Error(`verifySketches: reservoir.k=${k} 不得超过流长 n=${n}`);
  }
  const counts = new Float64Array(n);
  // 试验种子按 7919·t 散布: mulberry32 顺序种子流间相关（实证 χ² 过度
  // 离散至 1.19），散布后重复试验才近似独立、χ² 检验才有效
  for (let t = 0; t < trials; t += 1) {
    const sampler = new ReservoirSampler<number>(k, (reservoirSeed + t * 7919) >>> 0);
    for (let i = 0; i < n; i += 1) sampler.feed(i);
    for (const idx of sampler.sample()) counts[idx] += 1;
  }
  const p = k / n;
  const lambda = trials * p;
  let totalPicked = 0;
  let sumSq = 0;
  let maxCount = 0;
  for (let i = 0; i < n; i += 1) {
    totalPicked += counts[i];
    sumSq += counts[i] * counts[i];
    if (counts[i] > maxCount) maxCount = counts[i];
  }
  const mean = totalPicked / n;
  const variance = (sumSq - n * mean * mean) / (n - 1);
  const dispersion = variance / lambda; // 期望 → 1 − p（二项离散）
  // 极值守卫: λ + 5√(λ+1) + 4（小 λ 时 Poisson 偏斜由 +4 承接）
  const maxCountBound = lambda + 5 * Math.sqrt(lambda + 1) + 4;
  let chiSquareOverDof: number | null = null;
  if (lambda >= 5) {
    let chi = 0;
    for (let i = 0; i < n; i += 1) chi += ((counts[i] - lambda) ** 2) / (lambda * (1 - p));
    chiSquareOverDof = chi / (n - 1);
  }
  const totalExact = totalPicked === trials * k;
  const reservoirSection: ReservoirProbeSection = {
    k,
    trials,
    n,
    expectedRate: p,
    totalPicked,
    totalExpected: trials * k,
    totalExact,
    maxCount,
    maxCountBound,
    dispersion,
    chiSquareOverDof,
    passed:
      totalExact &&
      maxCount <= maxCountBound &&
      Math.abs(dispersion - (1 - p)) <= 0.25 &&
      (chiSquareOverDof === null || (chiSquareOverDof >= 0.85 && chiSquareOverDof <= 1.15)),
  };

  // ── 指数直方图段（提供 bits 才运行；朴素前缀和做地面真值） ──
  let histogramSection: HistogramProbeSection | null = null;
  const bits = input.histogram?.bits;
  if (bits !== undefined) {
    const hEps = input.histogram?.eps ?? STREAMING_SKETCH_DEFAULTS.histogramEps;
    const hWindow = input.histogram?.window ?? STREAMING_SKETCH_DEFAULTS.histogramWindow;
    if (!Array.isArray(bits)) throw new Error('verifySketches: histogram.bits 必须为数组');
    for (let i = 0; i < bits.length; i += 1) {
      if (bits[i] !== 0 && bits[i] !== 1) {
        throw new Error(`verifySketches: histogram.bits[${i}] 必须为 0/1（得到 ${bits[i]}）`);
      }
    }
    if (!Number.isInteger(hWindow) || hWindow < 1 || hWindow > bits.length) {
      throw new Error(
        `verifySketches: histogram.window 须为 [1, bits.length=${bits.length}] 整数（得到 ${hWindow}）`,
      );
    }
    const hist = new ExponentialHistogram({ eps: hEps, window: hWindow });
    const prefix = new Float64Array(bits.length + 1);
    for (let i = 0; i < bits.length; i += 1) prefix[i + 1] = prefix[i] + bits[i];
    const m = Math.ceil(1 / hEps); // N₁ ≥ m ⟹ 相对误差 ≤ 1/m ≤ ε
    let maxRelErrorDense = 0;
    let densePositions = 0;
    let maxAbsError = 0;
    let boundHolds = true;
    let invariantHolds = true;
    let bucketsPeak = 0;
    for (let i = 0; i < bits.length; i += 1) {
      hist.insert(null, bits[i] === 1);
      const hStats = hist.stats();
      if (!hStats.invariantHolds) invariantHolds = false;
      if (hStats.buckets > bucketsPeak) bucketsPeak = hStats.buckets;
      const t = i + 1;
      const trueCount = prefix[t] - prefix[Math.max(0, t - hWindow)];
      const err = Math.abs(hist.windowCount() - trueCount);
      if (err > maxAbsError) maxAbsError = err;
      if (err > Math.max(hEps * trueCount, 0.5)) boundHolds = false;
      if (trueCount >= m) {
        densePositions += 1;
        if (err / trueCount > maxRelErrorDense) maxRelErrorDense = err / trueCount;
      }
    }
    const memoryBound = exponentialHistogramMemoryBound(hEps, hWindow);
    histogramSection = {
      eps: hEps,
      window: hWindow,
      m,
      scanned: bits.length,
      maxRelErrorDense,
      densePositions,
      maxAbsError,
      boundHolds,
      invariantHolds,
      bucketsPeak,
      memoryBound,
      naiveCells: hWindow,
      savingFactor: hWindow / Math.max(1, bucketsPeak),
      passed: boundHolds && invariantHolds && maxRelErrorDense <= hEps && bucketsPeak <= memoryBound,
    };
  }

  // ── Misra–Gries 段 ──
  const mgK = input.misraGries?.k ?? STREAMING_SKETCH_DEFAULTS.misraGriesK;
  const mg = misraGries(stream, mgK);
  const storedNorm = new Map<string, number>();
  for (const c of mg.candidates) storedNorm.set(normalizeKey(c.key), c.count);
  const heavyKeys: string[] = [];
  for (const [key, trueCount] of truth) {
    if (trueCount > mg.threshold) heavyKeys.push(key);
  }
  const missingHeavies = heavyKeys.filter((key) => !storedNorm.has(key));
  const falseHeavies: (string | number)[] = mg.candidates
    .filter((c) => c.count > mg.threshold && (truth.get(normalizeKey(c.key)) ?? 0) <= mg.threshold)
    .map((c) => c.key);
  let countLowerBoundHolds = true;
  for (const [key, trueCount] of truth) {
    if ((storedNorm.get(key) ?? 0) < trueCount - mg.threshold) countLowerBoundHolds = false;
  }
  const misraGriesSection: MisraGriesProbeSection = {
    k: mgK,
    threshold: mg.threshold,
    heavyKeys,
    missingHeavies,
    falseHeavies,
    countLowerBoundHolds,
    candidatesWithinSlots: mg.candidates.length <= mgK,
    passed:
      missingHeavies.length === 0 &&
      falseHeavies.length === 0 &&
      countLowerBoundHolds &&
      mg.candidates.length <= mgK,
  };

  const allPassed =
    cmsSection.passed &&
    reservoirSection.passed &&
    (histogramSection === null || histogramSection.passed) &&
    misraGriesSection.passed;
  return {
    n,
    distinct: truth.size,
    l1,
    cms: cmsSection,
    reservoir: reservoirSection,
    histogram: histogramSection,
    misraGries: misraGriesSection,
    allPassed,
  };
}

// ─────────────────── 接线建议 ───────────────────
// 1. Sentinel 感官缓冲: 信号入口挂 CountMinSketch({eps:0.02, delta:0.01}) +
//    ExponentialHistogram({eps:0.1, window:1000})——键频与滑窗计数以
//    O(680 格 + ~百桶) 内存常驻，识别层在海啸级信号流下不再丢弃关键统计。
//    重信号键读 estimate（只高不低，上界 ε‖a‖₁），到达率读 windowCount。
//    与 55.0 Hawkes 互补: Hawkes 管强度模型（激发/传染参数），本内核管
//    原始流概要（键频/窗口计数/样本）——建模之前的感官层。
// 2. 审计与回放: ReservoirSampler(50) 滚动保留等概率样本（每元素入选
//    概率精确 k/n），事后取证不依赖全量日志；misraGries(signals, 9) 给出
//    频率 > N/10 的重元素——比 Top-K 堆强在它有 100% 捕获保证而非启发式。
// 3. 自检: verifySketches({ stream: 最近一段信号键流, histogram: { bits } })
//    一站式跑四结构保证检查（引擎启动自测/巡检）；allPassed=false 时拒绝
//    发布该概要读数（诚实降级），并按 section 定位是哪个结构的保证破了。
// 4. 缺省关闭旗标: config.streamingSketchGuard（缺省 false）。打开后仅
//    新增只读概要供 Sentinel 展示与告警辅助，不改变任何调度决策路径；
//    旗标关闭时与现状逐位一致。
