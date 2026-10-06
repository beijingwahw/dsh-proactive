/**
 * mapper-graph.ts — 69.0 Mapper 图内核 —— 高维经验流形的可解释拓扑骨架
 *
 * 动机: 36.0 持续同调给出知识地形的**谱**（跨尺度持久的结构是形状），
 * 但持久图不可读、不可导航——dashboard 上画不出一张持久图让人按图索骥。
 * 世界模型真正需要的是一张**能看的地图**：把高维经验（轨迹嵌入/表示
 * 向量）压成低维骨架——节点是一团相似经验，边是团与团的接壤，空洞
 * 一眼可见。Mapper 构造（Singh–Mémoli–Carlsson 2007）就是这个压缩：
 *
 * 数学（Mapper 构造四步）:
 *   1. 滤镜 f: X → ℝ —— 把高维数据投影成一个可读标量（坐标、密度
 *      估计、到原型的距离……滤镜是「地图的投影方向」）；
 *   2. 值域覆盖 {I_k} —— f(X) 的等宽 n 区间覆盖，相邻重叠率 p ∈ (0,1)；
 *   3. 纤维聚类 —— 每个纤维 f⁻¹(I_k) 内做 ε-单链聚类（或 ε-完全链），
 *      同一纤维内的每个簇 = 一个节点（并排的两簇 = 该高度带的左右两块
 *      区域——环状流形在 y 滤镜下中段必裂为左右两链，这就是环的来源）；
 *   4. 神经（nerve）—— 两节点有公共点即连边；结果是无向图。
 *
 *   Nerve 引理: 好覆盖（所有非空有限交可缩）时神经复形与原空间同伦
 *   等价——Mapper 图是原流形的可解释低维骨架：连通分量数 = 经验大陆
 *   数（H₀ 代理），圈基维数 E − V + C = 经验环数（H₁ 代理）。经验空洞
 *   = 探索盲区的拓扑定义：好奇心从「随机噪声」升级为「按洞派单」。
 *
 *   口径注记（诚实边界）: 图的圈基只统计「图上可见的环」（生成森林的
 *   基本圈），是 H₁ 的下界代理——真 H₁ 需 2-复形单纯同调；对 S¹ 型
 *   流形恰好相等（验证锚点①）。覆盖重叠不足会撕裂图（锚点③诚实示警：
 *   重叠 × 密度联合调参，结论才可信）。
 *
 * 验证锚点: ①圆环 300 点 + y 滤镜（10 区间 30% 重叠）→ 图恰含 1 环
 *   （圈基 = 1；36.0 H₀ 口径同点云 1 块大陆——H₀=ℤ + H₁=ℤ 合起来才是
 *   S¹ 的同调，两内核互证）②两分离高斯团 → 恰 2 分量、0 假环（多种子）
 *   ③重叠 5% 圆环断裂（分量 > 2）；密度补偿（3000 点恢复含环连通）
 *   ④单链 vs 完全链的链式效应 razor（0.9+0.9 链起 1.27 的远对）
 *   ⑤好参数下分量数 = 真簇数（k=2,3,4 × 多种子，nerve 引理直觉）。
 *
 * R5 进化（拓扑动力内核第五轮）:
 *   · 分位数（平衡）覆盖 quantileCover + buildMapper(cover:'balanced')——
 *     偏斜滤镜值域下等宽覆盖会把纤维挤成空/爆，平衡覆盖按秩切分保证每
 *     纤维 ≈ n/m 点（重叠预算 = 秩口径），平局按 (值, 下标) 确定排序；
 *   · 单链聚类的网格加速 singleLinkageFast——d(p,q) ≤ ε ⟹ 每维格号差 ≤ 1
 *     （格宽 ε），候选对 ⊇ 真对 + 真距过滤，连通分量与 O(n²) 逐对逐位
 *     一致（等价证明见函数注），buildMapper 内部自动启用（欧氏 + dim ≤ 3）；
 *   · MapperStats 增加 coverKind 字段（缺省 'uniform'——向后兼容）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

/** 聚类方法（const 对象 + 类型；无 enum——strip-types 兼容） */
export const CLUSTER_METHOD = {
  /** ε-单链：ε-邻域图连通分量（允许链式生长，对拉长簇友好；标准 Mapper 缺省） */
  single: 'single',
  /** ε-完全链：贪心凝聚，簇内最大点对距离 ≤ ε（直径纪律，抗链式噪声） */
  complete: 'complete',
} as const;
export type ClusterMethod = (typeof CLUSTER_METHOD)[keyof typeof CLUSTER_METHOD];

/** 点间度量（缺省欧氏；纯函数注入） */
export type MetricFn = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => number;

export interface MapperNode {
  /** 所属区间下标 k ∈ [0, intervals) */
  interval: number;
  /** 成员点下标（升序；重叠区的点合法地出现在相邻区间多个节点里） */
  members: number[];
  /** 成员质心（原始空间坐标，dashboard 画图用） */
  centroid: number[];
}

export interface MapperStats {
  intervals: number;
  overlap: number;
  clusterEps: number;
  clusterMethod: ClusterMethod;
  nodeCount: number;
  edgeCount: number;
  /** 连通分量数（经验大陆数 = H₀ 代理） */
  components: number;
  /** 圈基维数 E − V + C（经验环/空洞数 = H₁ 代理） */
  cycleRank: number;
  lensRange: { min: number; max: number };
  intervalWidth: number;
  /** 每个区间的节点数直方图（中段 =2 是 y 滤镜下环的左右两链指纹） */
  intervalHistogram: number[];
  maxNodeSize: number;
  meanNodeSize: number;
  /** 至少落入一个节点的点比例（等宽覆盖下应为 1——诚实核对而非假设） */
  coverage: number;
  /** 覆盖口径（R5）：'uniform' = 等宽区间（缺省，向后兼容）；'balanced' = 分位数秩窗口 */
  coverKind?: 'uniform' | 'balanced';
}

export interface MapperGraph {
  nodes: MapperNode[];
  edges: Array<[number, number]>;
  stats: MapperStats;
}

export interface CoverInterval {
  start: number;
  end: number;
  center: number;
  width: number;
}

/** 图工具入参：nodeCount 或直接传 MapperGraph（nodes.length 即节点数） */
export interface GraphLike {
  nodes: number | ReadonlyArray<unknown>;
  edges: ReadonlyArray<readonly [number, number]>;
}

export interface CycleBasisReport {
  nodeCount: number;
  edgeCount: number;
  components: number;
  /** 圈基维数 = E − V + C（H₁ 代理） */
  cycleRank: number;
  /** 基本圈（BFS 生成森林 + 每条非树边一圈；节点下标序列，确定性） */
  cycles: number[][];
}

export interface MapperParams {
  points: ReadonlyArray<ReadonlyArray<number>>;
  filter: (p: ReadonlyArray<number>) => number;
  intervals: number;
  overlap: number;
  clusterEps: number;
  clusterMethod?: ClusterMethod;
  metric?: MetricFn;
  /** 覆盖口径（R5）：'uniform' = 等宽区间（缺省，向后兼容）；'balanced' = 分位数秩窗口（偏斜滤镜自适应） */
  cover?: 'uniform' | 'balanced';
}

export interface BlobsOptions {
  /** 簇心所在圆半径（缺省 4：σ=1 时簇间距 ≥ 5.6，远大于常用 ε） */
  radius?: number;
  /** 每簇高斯标准差（缺省 1） */
  sigma?: number;
}

/** mulberry32 确定性 RNG（文件内自带；同种子同序列） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller 高斯（确定性；u1 ∈ (0,1] 保证 log 安全） */
function gaussian(rng: () => number): number {
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** 欧氏距离（缺省度量） */
export function euclidean(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

/** 点集校验（非空、同维、有限数）；返回维度 */
function validatePoints(points: ReadonlyArray<ReadonlyArray<number>>, who: string): number {
  if (points.length === 0) throw new Error(`${who}: points 至少 1 个点`);
  const dim = points[0].length;
  if (dim < 1) throw new Error(`${who}: 点维度 ≥ 1 必需（得到 ${dim}）`);
  for (const p of points) {
    if (p.length !== dim) throw new Error(`${who}: 所有点同维（期望 ${dim}，得到 ${p.length}）`);
    for (const x of p) {
      if (!Number.isFinite(x)) throw new Error(`${who}: 点坐标须为有限数（得到 ${String(x)}）`);
    }
  }
  return dim;
}

/**
 * 等宽区间覆盖：n 个区间覆盖 [min, max]，相邻重叠率 p ∈ (0,1)。
 *
 * 宽度闭式: w·(1 + (n−1)(1−p)) = span ⟹ w = span/(1 + (n−1)(1−p))；
 * 相邻位移 (1−p)·w，重叠带宽恰为 p·w。重叠保证相邻纤维共享点——
 * 神经边存在性的来源（重叠不足图会碎，锚点③）。
 */
export function intervalCover(min: number, max: number, intervals: number, overlap: number): CoverInterval[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(min < max)) {
    throw new Error(`intervalCover: 需要 min < max（得到 ${String(min)}, ${String(max)}）`);
  }
  if (!Number.isInteger(intervals) || intervals < 1) {
    throw new Error(`intervalCover: intervals 为 ≥ 1 整数（得到 ${String(intervals)}）`);
  }
  if (!Number.isFinite(overlap) || overlap <= 0 || overlap >= 1) {
    throw new Error(`intervalCover: overlap ∈ (0,1) 开区间（得到 ${String(overlap)}）`);
  }
  const span = max - min;
  const width = span / (1 + (intervals - 1) * (1 - overlap));
  const step = (1 - overlap) * width;
  const cover: CoverInterval[] = [];
  for (let k = 0; k < intervals; k += 1) {
    const start = min + k * step;
    cover.push({ start, end: start + width, center: start + width / 2, width });
  }
  return cover;
}

/** 分位数（平衡）覆盖的单个区间 */
export interface QuantileCoverInterval {
  /** 核心秩窗口 [startRank, endRank)（不含重叠扩张的骨架；相邻核心无隙拼满 [0,n)） */
  startRank: number;
  endRank: number;
  /** 实际纤维成员的点下标（含两侧重叠扩张；升序——与 uniform 口径的纤维形状一致） */
  members: number[];
  /** 纤维成员的滤镜值范围（min/max） */
  minValue: number;
  maxValue: number;
}

/**
 * 分位数（平衡）覆盖（R5 轴 1：自适应覆盖）。
 *
 * 动机: 等宽覆盖在偏斜滤镜值域（长尾分布、指数坐标）下会退化——密度高
 * 的窄值域挤在一个区间（纤维爆仓），尾部大段值域落进空纤维（区间白设）。
 * 平衡覆盖按**秩**切分: 排序后第 k 个核心纤维 = 秩窗口 [⌊k·n/m⌋, ⌊(k+1)·n/m⌋)，
 * 每纤维核心恰 ⌈n/m⌉±1 点（与值分布无关的负载均衡）；重叠按秩预算
 * h = ⌊p·n/(2m)⌋ 两侧扩张（相邻纤维共享 2h 个秩——镜像等宽覆盖的
 * p·w 共享带）。
 *
 * 平局确定性（R5 轴 3）: 排序键 (值, 原始下标)——同值点按入参顺序定秩，
 * 同输入同输出；同值点可能被分进相邻纤维（秩口径的诚实边界：神经边
 * 反映秩邻接而非值邻接，覆盖仍是全覆盖）。
 *
 * 诚实边界: intervals > 点数时核心纤维必空 → 显式 throw（等宽覆盖无此
 * 约束但会产出大量空纤维；平衡口径拒绝而非虚设）。
 */
export function quantileCover(
  values: ReadonlyArray<number>,
  intervals: number,
  overlap: number,
): QuantileCoverInterval[] {
  if (!Array.isArray(values) || values.length < 1) {
    throw new Error(`quantileCover: values 至少 1 个（得到 ${values.length}）`);
  }
  const n = values.length;
  for (const v of values) {
    if (!Number.isFinite(v)) throw new Error(`quantileCover: 滤镜值须为有限数（得到 ${String(v)}）`);
  }
  if (!Number.isInteger(intervals) || intervals < 1) {
    throw new Error(`quantileCover: intervals 为 ≥ 1 整数（得到 ${String(intervals)}）`);
  }
  if (intervals > n) {
    throw new Error(`quantileCover: intervals（${intervals}）不能超过点数（${n}）——核心纤维必空的平衡覆盖拒绝虚设`);
  }
  if (!Number.isFinite(overlap) || overlap <= 0 || overlap >= 1) {
    throw new Error(`quantileCover: overlap ∈ (0,1) 开区间（得到 ${String(overlap)}）`);
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a]! - values[b]! || a - b);
  const halfBudget = Math.max(0, Math.floor((overlap * n) / (2 * intervals)));
  const out: QuantileCoverInterval[] = [];
  for (let k = 0; k < intervals; k += 1) {
    const startRank = Math.max(0, Math.floor((k * n) / intervals) - halfBudget);
    const endRank = Math.min(n, Math.floor(((k + 1) * n) / intervals) + halfBudget);
    const members = order.slice(startRank, endRank).sort((a, b) => a - b);
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (const i of members) {
      const v = values[i]!;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    out.push({
      startRank: Math.floor((k * n) / intervals),
      endRank: Math.floor(((k + 1) * n) / intervals),
      members,
      minValue: members.length > 0 ? minV : Number.NaN,
      maxValue: members.length > 0 ? maxV : Number.NaN,
    });
  }
  return out;
}

/**
 * ε-单链聚类：ε-邻域图的连通分量（等价于单链树状图在高度 ε 剪切）。
 *
 * 链式效应: A–B ≤ ε 且 B–C ≤ ε 即并簇（A–C 可以远大于 ε）——
 * 对拉长/弯曲簇友好（锚点④的 razor：0.9 + 0.9 链起 1.27 的远对）。
 * 返回: 簇内成员升序、簇按首成员升序（全确定序）。
 */
export function singleLinkage(
  points: ReadonlyArray<ReadonlyArray<number>>,
  eps: number,
  metric: MetricFn = euclidean,
): number[][] {
  if (!Number.isFinite(eps) || eps < 0) {
    throw new Error(`singleLinkage: eps ≥ 0 必需（得到 ${String(eps)}）`);
  }
  validatePoints(points, 'singleLinkage');
  const n = points.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const size = new Array<number>(n).fill(1);
  const find = (x0: number): number => {
    let root = x0;
    while (parent[root] !== root) root = parent[root];
    let cur = x0;
    while (parent[cur] !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const d = metric(points[i], points[j]);
      if (!Number.isFinite(d) || d < 0) {
        throw new Error(`singleLinkage: metric 须返回有限非负数（得到 ${String(d)}）`);
      }
      if (d <= eps) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) {
          const big = size[ri] >= size[rj] ? ri : rj;
          const small = big === ri ? rj : ri;
          parent[small] = big;
          size[big] += size[small];
        }
      }
    }
  }
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    const bucket = buckets.get(r);
    if (bucket === undefined) buckets.set(r, [i]);
    else bucket.push(i);
  }
  // i 升序扫描 → 簇按最小成员排序、成员升序
  return [...buckets.values()];
}

/**
 * 网格加速的 ε-单链聚类（R5 轴 2：Mapper 聚类的网格加速）。
 *
 * 等价证明: 欧氏度量下 d(p,q) ≤ ε ⟹ 每维坐标差 ≤ ε ⟹ 每维格号
 * （⌊coord/ε⌋）之差 ∈ {−1,0,1}（格宽恰为 ε；|a−b| ≤ ε ⟹ |a/ε − b/ε| ≤ 1
 * ⟹ 格号差 ≤ 1）。于是「自身格 ± 邻域 3^d 格」的候选对集合 ⊇ 全部真对；
 * 候选对再过真距过滤（d ≤ ε）后与 O(n²) 逐对口径的边集完全相同——
 * 并查集在同一边集上的连通分量与输出规范序（簇按最小成员升序、成员
 * 升序）逐位一致。union 顺序不影响分量划分（连通性是边集的函数）。
 *
 * 适用口径: 欧氏度量（缺省）且维度 ≤ 3（高维 3^d 邻域退化——诚实回退
 * 逐对实现）；自定义度量不满足格论证前提，同样回退。
 */
export function singleLinkageFast(
  points: ReadonlyArray<ReadonlyArray<number>>,
  eps: number,
  metric: MetricFn = euclidean,
): number[][] {
  const dim = validatePoints(points, 'singleLinkageFast');
  if (!Number.isFinite(eps) || eps < 0) {
    throw new Error(`singleLinkageFast: eps ≥ 0 必需（得到 ${String(eps)}）`);
  }
  if (metric !== euclidean || dim > 3) return singleLinkage(points, eps, metric);
  const n = points.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const size = new Array<number>(n).fill(1);
  const find = (x0: number): number => {
    let root = x0;
    while (parent[root] !== root) root = parent[root];
    let cur = x0;
    while (parent[cur] !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  if (eps > 0 && n > 1) {
    // 格分箱：key = 各维格号十进制拼接（维度 ≤ 3，分隔符防串位）
    const cells = new Map<string, number[]>();
    const cellOf = (p: ReadonlyArray<number>): string => {
      const parts: string[] = [];
      for (let d = 0; d < dim; d += 1) parts.push(String(Math.floor(p[d]! / eps)));
      return parts.join(',');
    };
    for (let i = 0; i < n; i += 1) {
      const key = cellOf(points[i]!);
      const bucket = cells.get(key);
      if (bucket === undefined) cells.set(key, [i]);
      else bucket.push(i);
    }
    const offsets: number[][] = [];
    for (let d = 0; d < dim; d += 1) offsets.push([-1, 0, 1]);
    const neighborCells = (key: string): string[] => {
      const parts = key.split(',').map((s) => Number(s));
      const out: string[] = [];
      const expand = (d: number, prefix: string[]): void => {
        if (d === dim) {
          out.push(prefix.join(','));
          return;
        }
        for (const off of offsets[d]!) expand(d + 1, [...prefix, String(parts[d]! + off)]);
      };
      expand(0, []);
      return out;
    };
    for (let i = 0; i < n; i += 1) {
      const p = points[i]!;
      for (const cellKey of neighborCells(cellOf(p))) {
        for (const j of cells.get(cellKey) ?? []) {
          if (j <= i) continue; // 每对只查一次
          let s = 0;
          for (let d = 0; d < dim; d += 1) {
            const diff = p[d]! - points[j]![d]!;
            s += diff * diff;
          }
          // 与 euclidean()+`d ≤ eps` 逐位一致的判定（sqrt 比较——不做 s ≤ ε² 代换，避免舍入边界分叉）
          if (Math.sqrt(s) <= eps) {
            const ri = find(i);
            const rj = find(j);
            if (ri !== rj) {
              const big = size[ri] >= size[rj] ? ri : rj;
              const small = big === ri ? rj : ri;
              parent[small] = big;
              size[big] += size[small];
            }
          }
        }
      }
    }
  } else {
    // eps = 0：只有坐标全同的点成簇——直接逐对（退化口径与 singleLinkage 一致）
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let same = true;
        for (let d = 0; d < dim; d += 1) {
          if (points[i]![d]! !== points[j]![d]!) {
            same = false;
            break;
          }
        }
        if (same) {
          const ri = find(i);
          const rj = find(j);
          if (ri !== rj) {
            parent[rj] = ri;
            size[ri] += size[rj];
          }
        }
      }
    }
  }
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    const bucket = buckets.get(r);
    if (bucket === undefined) buckets.set(r, [i]);
    else bucket.push(i);
  }
  const clusters = [...buckets.values()];
  clusters.sort((a, b) => a[0]! - b[0]!); // 簇按最小成员升序（i 升序扫描同款规范序）
  return clusters;
}

/**
 * ε-完全链聚类：贪心凝聚，簇间距离 = 最大点对距离（直径），仅当 ≤ ε
 * 才合并——直径纪律（锚点④：max{0.9, 1.27} = 1.27 > 1 拒并）。
 * 平局按扫描序取先者（确定序）；O(n³) 小纤维适用。
 */
export function completeLinkage(
  points: ReadonlyArray<ReadonlyArray<number>>,
  eps: number,
  metric: MetricFn = euclidean,
): number[][] {
  if (!Number.isFinite(eps) || eps < 0) {
    throw new Error(`completeLinkage: eps ≥ 0 必需（得到 ${String(eps)}）`);
  }
  validatePoints(points, 'completeLinkage');
  const n = points.length;
  const dist: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const d = metric(points[i], points[j]);
      if (!Number.isFinite(d) || d < 0) {
        throw new Error(`completeLinkage: metric 须返回有限非负数（得到 ${String(d)}）`);
      }
      dist[i][j] = d;
      dist[j][i] = d;
    }
  }
  const active: Array<number[] | undefined> = points.map((_, i) => [i]);
  for (;;) {
    let bestA = -1;
    let bestB = -1;
    let bestDist = Infinity;
    for (let a = 0; a < active.length; a += 1) {
      const ca = active[a];
      if (ca === undefined) continue;
      for (let b = a + 1; b < active.length; b += 1) {
        const cb = active[b];
        if (cb === undefined) continue;
        let cd = 0;
        for (const i of ca) {
          for (const j of cb) {
            if (dist[i][j] > cd) cd = dist[i][j];
          }
        }
        if (cd < bestDist) {
          bestDist = cd;
          bestA = a;
          bestB = b;
        }
      }
    }
    if (bestA < 0 || bestDist > eps) break;
    const merged = [...active[bestA]!, ...active[bestB]!].sort((x, y) => x - y);
    active[bestA] = merged;
    active[bestB] = undefined;
  }
  return active.filter((c): c is number[] => c !== undefined);
}

/** 图工具入参校验：节点数非负整数、边端点在界内、无自环（Mapper 神经不产生） */
function graphOrder(graph: GraphLike, who: string): number {
  const n = typeof graph.nodes === 'number' ? graph.nodes : graph.nodes.length;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${who}: nodes 须为非负整数或节点数组（得到 ${String(n)}）`);
  }
  for (const e of graph.edges) {
    const a = e[0];
    const b = e[1];
    if (a === b) throw new Error(`${who}: 自环边 [${a},${a}] 不支持`);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= n || b >= n) {
      throw new Error(`${who}: 边端点须为 [0, ${n}) 整数（得到 [${String(a)}, ${String(b)}]）`);
    }
  }
  return n;
}

function buildAdjacency(n: number, edges: ReadonlyArray<readonly [number, number]>): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    adj[e[0]].push(e[1]);
    adj[e[1]].push(e[0]);
  }
  return adj;
}

/**
 * 连通分量（BFS；返回按最小节点下标序，分量内升序——确定序）。
 * nodes 可直接传 MapperGraph（.nodes.length 即节点数）。
 */
export function connectedComponents(graph: GraphLike): number[][] {
  const n = graphOrder(graph, 'connectedComponents');
  const adj = buildAdjacency(n, graph.edges);
  const seen = new Array<boolean>(n).fill(false);
  const components: number[][] = [];
  for (let s = 0; s < n; s += 1) {
    if (seen[s]) continue;
    seen[s] = true;
    const comp: number[] = [s];
    const queue: number[] = [s];
    for (let head = 0; head < queue.length; head += 1) {
      const u = queue[head];
      for (const v of adj[u]) {
        if (!seen[v]) {
          seen[v] = true;
          comp.push(v);
          queue.push(v);
        }
      }
    }
    comp.sort((x, y) => x - y);
    components.push(comp);
  }
  return components;
}

/**
 * 圈基（H₁ 代理）：BFS 生成森林 + 每条非树边一个基本圈。
 *
 * cycleRank = E − V + C（圈空间维数）；cycles 给出每个环的节点序列
 * （空洞边界成员——好奇心想「去洞边」时按图索骥的依据）。平行边计入
 * 圈基（multigraph 口径）；自环显式 throw。
 */
export function cycleBasis(graph: GraphLike): CycleBasisReport {
  const n = graphOrder(graph, 'cycleBasis');
  const adj = buildAdjacency(n, graph.edges);
  const parent = new Array<number>(n).fill(-1);
  const seen = new Array<boolean>(n).fill(false);
  let components = 0;
  for (let s = 0; s < n; s += 1) {
    if (seen[s]) continue;
    components += 1;
    seen[s] = true;
    const queue: number[] = [s];
    for (let head = 0; head < queue.length; head += 1) {
      const u = queue[head];
      for (const v of adj[u]) {
        if (!seen[v]) {
          seen[v] = true;
          parent[v] = u;
          queue.push(v);
        }
      }
    }
  }
  const pathToRoot = (x: number): number[] => {
    const path: number[] = [];
    for (let cur = x; cur !== -1; cur = parent[cur]) path.push(cur);
    return path;
  };
  const treeUsed = new Array<boolean>(n).fill(false);
  const cycles: number[][] = [];
  for (const e of graph.edges) {
    const a = e[0];
    const b = e[1];
    // 树边判定：端点恰为 parent 关系且该孩子的树边名额未用（平行边只免一条）
    let child = -1;
    if (parent[a] === b) child = a;
    else if (parent[b] === a) child = b;
    if (child >= 0 && !treeUsed[child]) {
      treeUsed[child] = true;
      continue;
    }
    // 非树边：a→root 与 b→root 路径的公共后缀剪到 LCA 为止（LCA 保留在圈内：
    // 当且仅当下一段仍相等才继续剪——两条路径终于同一 root，循环必停在 LCA）
    const pathA = pathToRoot(a);
    const pathB = pathToRoot(b);
    let i = pathA.length - 1;
    let j = pathB.length - 1;
    while (i > 0 && j > 0 && pathA[i - 1] === pathB[j - 1]) {
      i -= 1;
      j -= 1;
    }
    cycles.push([...pathA.slice(0, i + 1), ...pathB.slice(0, j).reverse()]);
  }
  const edgeCount = graph.edges.length;
  return { nodeCount: n, edgeCount, components, cycleRank: edgeCount - n + components, cycles };
}

/**
 * Mapper 构造（Singh–Mémoli–Carlsson）：滤镜 → 等宽重叠覆盖 →
 * 纤维内 ε-聚类 → 公共点连边（神经）。纯函数、确定序。
 *
 * 纤维成员口径: 闭区间（重叠区内的点同时属于相邻两纤维——公共点的
 * 来源）；末区间上界不封口（浮点尘埃下保证 max 点入图）。
 */
export function buildMapper(params: MapperParams): MapperGraph {
  const { points, filter, intervals, overlap, clusterEps } = params;
  const method = params.clusterMethod ?? CLUSTER_METHOD.single;
  const metric = params.metric ?? euclidean;
  const coverKind = params.cover ?? 'uniform';
  if (typeof filter !== 'function') throw new Error('buildMapper: filter 函数必需');
  if (method !== CLUSTER_METHOD.single && method !== CLUSTER_METHOD.complete) {
    throw new Error(`buildMapper: clusterMethod ∈ {single, complete}（得到 ${String(method)}）`);
  }
  if (coverKind !== 'uniform' && coverKind !== 'balanced') {
    throw new Error(`buildMapper: cover ∈ {uniform, balanced}（得到 ${String(coverKind)}）`);
  }
  if (!Number.isInteger(intervals) || intervals < 1) {
    throw new Error(`buildMapper: intervals 为 ≥ 1 整数（得到 ${String(intervals)}）`);
  }
  if (!Number.isFinite(overlap) || overlap <= 0 || overlap >= 1) {
    throw new Error(`buildMapper: overlap ∈ (0,1) 开区间（得到 ${String(overlap)}）`);
  }
  if (!Number.isFinite(clusterEps) || clusterEps < 0) {
    throw new Error(`buildMapper: clusterEps ≥ 0 必需（得到 ${String(clusterEps)}）`);
  }
  const dim = validatePoints(points, 'buildMapper');
  const n = points.length;
  const values = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    const v = filter(points[i]);
    if (!Number.isFinite(v)) {
      throw new Error(`buildMapper: filter 须返回有限数（第 ${i} 点得到 ${String(v)}）`);
    }
    values[i] = v;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === hi) {
    throw new Error('buildMapper: 滤镜值域退化（min === max）——滤镜无信息量，换有变化的滤镜');
  }
  const slack = 1e-12 * Math.max(1, Math.abs(lo), Math.abs(hi));
  const nodes: MapperNode[] = [];
  const intervalHistogram: number[] = [];
  let uniformCover: CoverInterval[] | undefined;
  let balancedCover: QuantileCoverInterval[] | undefined;
  if (coverKind === 'uniform') {
    uniformCover = intervalCover(lo, hi, intervals, overlap);
  } else {
    balancedCover = quantileCover(values, intervals, overlap);
  }
  for (let k = 0; k < intervals; k += 1) {
    const fiber: number[] = [];
    if (uniformCover !== undefined) {
      const iv = uniformCover[k];
      for (let i = 0; i < n; i += 1) {
        const v = values[i];
        if (v >= iv.start - slack && (k === intervals - 1 || v <= iv.end + slack)) fiber.push(i);
      }
    } else {
      fiber.push(...balancedCover![k]!.members); // 平衡覆盖：秩窗口成员（点下标升序）
    }
    const fiberPoints = fiber.map((i) => points[i]);
    const clusters =
      method === CLUSTER_METHOD.single
        ? singleLinkageFast(fiberPoints, clusterEps, metric) // 内部按适用性自动回退 singleLinkage
        : completeLinkage(fiberPoints, clusterEps, metric);
    for (const cluster of clusters) {
      const members = cluster.map((fi) => fiber[fi]);
      const centroid = new Array<number>(dim).fill(0);
      for (const m of members) {
        for (let dd = 0; dd < dim; dd += 1) centroid[dd] += points[m][dd];
      }
      for (let dd = 0; dd < dim; dd += 1) centroid[dd] /= members.length;
      nodes.push({ interval: k, members, centroid });
    }
    intervalHistogram.push(clusters.length);
  }
  // 神经边：公共点 → 边（incidence 追加序 = 节点序 → 端点升序；同区间
  // 聚类划分纤维不可能互享点，边天然只在跨区间节点间）
  const incidence: number[][] = Array.from({ length: n }, () => []);
  nodes.forEach((node, ni) => {
    for (const m of node.members) incidence[m].push(ni);
  });
  const nodeCount = nodes.length;
  const seenEdge = new Set<number>();
  const edges: Array<[number, number]> = [];
  for (const list of incidence) {
    for (let a = 0; a < list.length; a += 1) {
      for (let b = a + 1; b < list.length; b += 1) {
        const ni = list[a];
        const nj = list[b];
        const key = ni * nodeCount + nj;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        edges.push([ni, nj]);
      }
    }
  }
  edges.sort((e, f) => e[0] - f[0] || e[1] - f[1]);
  const edgeCount = edges.length;
  const components = connectedComponents({ nodes, edges }).length;
  let covered = 0;
  for (const list of incidence) if (list.length > 0) covered += 1;
  let maxNodeSize = 0;
  let totalSize = 0;
  for (const node of nodes) {
    totalSize += node.members.length;
    if (node.members.length > maxNodeSize) maxNodeSize = node.members.length;
  }
  const stats: MapperStats = {
    intervals,
    overlap,
    clusterEps,
    clusterMethod: method,
    nodeCount,
    edgeCount,
    components,
    cycleRank: edgeCount - nodeCount + components,
    lensRange: { min: lo, max: hi },
    intervalWidth: uniformCover !== undefined ? uniformCover[0].width : (hi - lo) / intervals,
    intervalHistogram,
    maxNodeSize,
    meanNodeSize: nodeCount > 0 ? totalSize / nodeCount : 0,
    coverage: covered / n,
    coverKind,
  };
  return { nodes, edges, stats };
}

/**
 * 圆环采样（数据工厂）：面积均匀——r = √(r1² + u·(r2²−r1²))，
 * θ 均匀。S¹ 型流形的公认 Mapper 试金石（环 = 圈基 1 的解析预期）。
 */
export function annulus(n: number, r1: number, r2: number, seed: number): number[][] {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`annulus: n 为 ≥ 1 整数（得到 ${String(n)}）`);
  }
  if (!Number.isFinite(r1) || !Number.isFinite(r2) || r1 < 0 || !(r1 < r2)) {
    throw new Error(`annulus: 需要 0 ≤ r1 < r2（得到 ${String(r1)}, ${String(r2)}）`);
  }
  const rng = mulberry32(seed);
  const out: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const r = Math.sqrt(r1 * r1 + rng() * (r2 * r2 - r1 * r1));
    const theta = 2 * Math.PI * rng();
    out.push([r * Math.cos(theta), r * Math.sin(theta)]);
  }
  return out;
}

/**
 * k 个分离高斯团（数据工厂）：簇心均匀分布在半径 radius 的圆上
 * （相邻簇间距 ≥ 2·radius·sin(π/k)，σ=1 时远大于常用 ε），每簇 n 点。
 * 真簇数已知——nerve 引理锚点（好参数下分量数 = k）的地面真值。
 */
export function blobs(k: number, n: number, seed: number, options: BlobsOptions = {}): number[][] {
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`blobs: k 为 ≥ 1 整数（得到 ${String(k)}）`);
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`blobs: n 为 ≥ 1 整数（得到 ${String(n)}）`);
  }
  const radius = options.radius ?? 4;
  const sigma = options.sigma ?? 1;
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new Error(`blobs: radius > 0 必需（得到 ${String(radius)}）`);
  }
  if (!Number.isFinite(sigma) || sigma <= 0) {
    throw new Error(`blobs: sigma > 0 必需（得到 ${String(sigma)}）`);
  }
  const rng = mulberry32(seed);
  const out: number[][] = [];
  for (let c = 0; c < k; c += 1) {
    const cx = radius * Math.cos((2 * Math.PI * c) / k);
    const cy = radius * Math.sin((2 * Math.PI * c) / k);
    for (let i = 0; i < n; i += 1) {
      out.push([cx + sigma * gaussian(rng), cy + sigma * gaussian(rng)]);
    }
  }
  return out;
}

/** 经验地形图摘要（69.0 接线口径：空洞 = 探索盲区的拓扑定义） */
export function mapperInsight(graph: MapperGraph): string {
  const s = graph.stats;
  const head = `${s.nodeCount} 节点 · ${s.edgeCount} 边 · ${s.components} 分量 · 圈基 ${s.cycleRank}`;
  if (s.cycleRank > 0) return `${head} —— ${s.cycleRank} 个经验空洞（探索盲区候选，好奇心按洞定向）`;
  if (s.components > 1) return `${head} —— ${s.components} 块经验大陆，无环`;
  return `${head} —— 单块树状骨架（无洞）`;
}

/* ── 接线建议 ──
 * 挂载引擎: 世界模型（经验流形层）+ 好奇心引擎 + dashboard 可视化
 * 1. 世界模型「经验地形图」: 经验轨迹的表示向量（嵌入/后验摘要）作为
 *    points，滤镜取内在坐标或密度估计，buildMapper 产出经验骨架图——
 *    node.centroid 已备好原始空间坐标，dashboard 直接画；高维经验第
 *    一次有了一张人能看的地图（对比 36.0：持久图是谱，Mapper 是图）。
 * 2. 好奇心引擎按洞派单: cycleBasis().cycles 的成员节点 = 空洞边界
 *    经验集合，好奇心采样从均匀噪声升级为「向空洞边界质心定向」——
 *    探索的拓扑定向；stats.cycleRank 上升 = 新盲区诞生，可触发探索
 *    预算加码。
 * 3. 拓扑预警: 分量数变化 = 行为模式分裂/合并的拓扑事件；经验空洞 =
 *    探索盲区（未访问的状态带）——比统计漂移更早可见，且可定位。
 * 4. 缺省关闭旗标: config.kernels.mapperGraphEnabled = false（未开启
 *    时上述路径零介入——纯分析内核只读）。
 * 5. 挂载后改变的决策点: 好奇心目标选择（均匀 → 空洞边界定向）、
 *    dashboard 经验视图（列表 → 骨架图）、探索预算分配（按 cycleRank
 *    与分量数重加权）。参数敏感口径（锚点③）: overlap × 密度联合
 *    调参，建议运行时多档覆盖对照后再采信拓扑结论。
 */
