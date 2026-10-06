/**
 * novelty-search.ts — 91.0 新奇搜索内核 —— 抛弃目标、只追新奇的行为空间搜索
 *
 * 动机: 14.0 质量-多样性（MAP-Elites）用网格精英制给「点亮行为地图」
 * 定了规矩，但地图的扩张仍靠变异随机播种，且 niche 内部仍是适应度
 * 竞争——目标（哪怕只是局部目标）依然是进化的方向盘。欺骗性地形
 * 正是利用这一点：「离目标越来越近」的启发梯度一路把种群领进大空腔
 * 死路（梯度尽头是墙），真解却藏在「必须先远离目标」的绕行道上。
 * 一切更聪明的目标优化器都翻不过这道坎，因为坎就是目标本身。好奇
 * 心引擎同样受制：69.0 Mapper 能发现行为空间的拓扑盲区（空洞），但
 * 「向盲区定向探索」缺一台不认目标、只认新奇的搜索发动机。
 *
 * 数学（Lehman & Stanley 新奇搜索）:
 *   个体不携带适应度，只有行为描述子 b(x)。新奇分
 *       ρ(x) = (1/k) · Σ_{i=1..k} dist(b(x), n_i)
 *   其中 n_1..n_k 是「归档 ∪ 当前种群」全部行为点中距 b(x) 最近的
 *   k 个（k 近邻平均距离；池小于 k 时对全池取平均）。ρ 大 = 我周围
 *   的行为空间空旷 = 这种活法还没人试过。选择压完全来自 ρ（锦标赛）。
 *   基因型→行为的平滑性是累积进化的命门：整数移动指令序列的一次
 *   重抽会打散整条尾段（子代行为不像亲代，进化退化为随机扩散），
 *   本内核用连续转向增量基因组（heading += gene 的乌龟轨迹）——
 *   小变异 = 路径微弯 = 末位行为落在亲代邻域，前沿才能被选择压
 *   平滑外推（这正是原版用神经网络控制器的理由）。
 *   归档纪律: 每代把【当代最低新奇】个体入档——在种群最密集处留
 *   一枚面包屑；种群搬离后面包屑仍压低旧地的 ρ，结构上杜绝回头路
 *   振荡。档案限容，满员随机淘汰。欺骗被绕开的机理不需要任何领域
 *   知识：「靠近目标」的信号被整体删除后，死路空腔一旦被踩过就
 *   失去新奇性，选择压自动转向从未涉足的绕行走廊。
 *   MCNS（最小准则新奇搜索）= 新奇 + 可行性门槛: minCriterion 不过
 *   的个体失去被选资格、不入档（新奇分照算）——探索被约束在可行
 *   边界内定向，lethal 诱饵区再新奇也吸不走选择预算。
 *
 *   R5 进化（拓扑动力内核第五轮）: 档案精简（密度控制）——archivePolicy:
 *   'density' 满员时驱逐**档案内最稠密**的面包屑（对档案同侪的平均 k 近邻
 *   距离最小者, 平局驱先进档者——确定性）而非随机淘汰。随机淘汰的期望
 *   损耗均匀撒在全档案, 密度控制把损耗集中在冗余处: 等容量下档案覆盖的
 *   行为格更多、直径维持更久——同样的面包屑预算, 铺更远的地。缺省
 *   'random' 保持既有行为逐位不变（向后兼容）。
 *
 * 验证锚点:
 *   ① 招牌实验（欺骗迷宫 100 种子）: 迷宫构造 = 贪婪启发（末位欧氏
 *      距离目标）的梯度直通大空腔死路、真路径须沿外环先远离目标；
 *      新奇搜索成功率 ≥ 0.8，纯适应度搜索（同一变异/交叉算子、
 *      选择压 = 启发距离）≤ 0.1——先自证适应度搜索会困死（末代
 *      种群挤在空腔、行为覆盖塌缩），再证新奇结构性绕开。
 *   ② 档案多样性单调增长: 行为格覆盖数非降且最终点亮全部可行格
 *      （110/110）；归档直径（增量精确维护）非降、终值铺满全图
 *      （≥ 24 ≈ 跨度上限 25.8 的 93%）。
 *   ③ MCNS 门槛必要性: 死亡区迷宫（内部流沙海 lethal 诱饵）下
 *      minCriterion 版成功率显著高于纯新奇（后者被 lethal 高新奇
 *      区吸走选择预算）。
 *   ④ 新奇分精确性: 手工小档案 k 近邻平均距离的解析对照；引擎
 *      内部口径与导出 noveltyScore 口径逐位一致；同种子全程确定。
 *   ⑤ 诚实代价报告: 无欺骗平滑地形（开阔地）上新奇同样能解，但
 *      平均首解代数多于适应度搜索——新奇不是免费的。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 类型与配置 ───────────────────────────

/** 基因组（连续基因序列；迷宫场景 = 逐步转向增量） */
export type Genome = number[];

/**
 * 基因组空间（连续基因盒 + 高斯步长变异 + 一点交叉——三者共同保证
 * 基因型→行为映射的平滑性：小变异 → 末位行为落在亲代邻域）
 */
export interface GenomeSpace {
  /** 基因组长度 */
  dim: number;
  /** 基因盒 [min,max]（缺省 [−π,π]——转向增量天然周期） */
  geneRange?: [number, number];
  /** 每基因变异概率（缺省 min(0.15, 6/dim)） */
  mutateRate?: number;
  /** 变异步长 σ（高斯；缺省 0.25） */
  mutateSigma?: number;
  /** 一点交叉概率（缺省 0.5；否则克隆单亲） */
  crossoverRate?: number;
}

/** 新奇搜索配置 */
export interface NoveltySearchConfig {
  genomeSpace: GenomeSpace;
  /** 行为描述子 b(x)：基因组 → 行为空间坐标（无适应度目标） */
  behaviorOf: (genome: ReadonlyArray<number>) => number[];
  /** 进化代数 */
  generations: number;
  /** 种群规模 */
  popSize: number;
  /** k 近邻的 k */
  k: number;
  /** 档案限容（满员随机淘汰） */
  archiveCap: number;
  /** 随机种子（mulberry32；同种子同输出） */
  seed: number;
  /** MCNS 最小准则：不过者失去被选资格、不入档（缺省无门槛） */
  minCriterion?: (genome: ReadonlyArray<number>) => boolean;
  /** 解判定（命中即入 solutions；缺省永不判定） */
  solved?: (genome: ReadonlyArray<number>) => boolean;
  /** 命中解后提前终止（缺省 false——跑满全程拿完整 trace） */
  stopWhenSolved?: boolean;
  /** 锦标赛规模（缺省 3） */
  tournamentSize?: number;
  /** 行为格量化步长（覆盖度统计用；缺省 1） */
  cellSize?: number;
  /** 档案满员精简策略（R5）: 'random' = 随机淘汰（缺省, 向后兼容）;
   *  'density' = 驱逐档案内最稠密面包屑（对同侪平均 k 近邻距离最小, 平局驱先进档者） */
  archivePolicy?: 'random' | 'density';
}

/** 归档条目（当代最低新奇个体的面包屑） */
export interface ArchiveEntry {
  genome: Genome;
  behavior: number[];
  /** 入档时的 ρ */
  novelty: number;
  /** 入档代数 */
  generation: number;
}

/** 种群个体（末代快照 / 中间代内部结构） */
export interface NoveltyIndividual {
  genome: Genome;
  behavior: number[];
  /** 新奇分 ρ（对「归档 ∪ 本代种群（除自身）」的 k 近邻平均距离） */
  novelty: number;
  /** 是否过 minCriterion（无门槛恒 true） */
  feasible: boolean;
  /** 是否命中解 */
  solved: boolean;
  generation: number;
}

/** 每代踪迹（多样性的可审计曲线） */
export interface NoveltyTraceEntry {
  generation: number;
  /** 本代平均 / 最大新奇分 */
  meanNovelty: number;
  maxNovelty: number;
  /** 档案容量占用 */
  archiveSize: number;
  /** 归档行为点直径（增量精确维护；触发淘汰后为历史峰值口径） */
  archiveDiameter: number;
  /** 行为格累计覆盖数（归档 ∪ 历代种群，单调不减） */
  cellsCovered: number;
  /** 累计解数 */
  solutions: number;
}

/** 解命中记录 */
export interface SolutionRecord {
  genome: Genome;
  /** 命中者行为（适应度对照引擎无行为口径，为可选） */
  behavior?: number[];
  /** 首次命中代数 */
  generation: number;
}

/** 新奇搜索结果 */
export interface NoveltySearchResult {
  archive: ArchiveEntry[];
  lastPopulation: NoveltyIndividual[];
  noveltyTrace: NoveltyTraceEntry[];
  solutions: SolutionRecord[];
  /** 首个解的代数（无解为 null） */
  firstSolvedGeneration: number | null;
}

/** 纯适应度对照搜索配置（同变异/交叉算子，选择压 = fitness 越大越好） */
export interface FitnessSearchConfig {
  genomeSpace: GenomeSpace;
  /** 适应度（越大越好；欺骗场景 = −末位启发距离） */
  fitnessOf: (genome: ReadonlyArray<number>) => number;
  generations: number;
  popSize: number;
  seed: number;
  solved?: (genome: ReadonlyArray<number>) => boolean;
  stopWhenSolved?: boolean;
  tournamentSize?: number;
}

export interface FitnessIndividual {
  genome: Genome;
  fitness: number;
  solved: boolean;
  generation: number;
}

export interface FitnessTraceEntry {
  generation: number;
  meanFitness: number;
  bestFitness: number;
  solutions: number;
}

export interface FitnessSearchResult {
  lastPopulation: FitnessIndividual[];
  fitnessTrace: FitnessTraceEntry[];
  solutions: SolutionRecord[];
  firstSolvedGeneration: number | null;
}

// ─────────────────────────── 通用工具 ───────────────────────────

/** 确定性 RNG（mulberry32；内核自带——同种子同序列） */
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

function round(x: number): number {
  return Number(x.toFixed(6));
}

function dist(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i]! - b[i]!;
    s += d * d;
  }
  return Math.sqrt(s);
}

function assertIntAtLeast(value: number, min: number, label: string): void {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`novelty-search: ${label} 需为 ≥ ${min} 的整数（得到 ${String(value)}）`);
  }
}

/** 升序插入（平局插在等值之后——先到先得，保持与遍历序无关的稳定和） */
function insertSorted(arr: number[], v: number): void {
  let i = arr.length;
  while (i > 0 && arr[i - 1]! > v) {
    arr[i] = arr[i - 1]!;
    i -= 1;
  }
  arr[i] = v;
}

interface ResolvedSpace {
  dim: number;
  geneMin: number;
  geneMax: number;
  span: number;
  mutateRate: number;
  mutateSigma: number;
  crossoverRate: number;
}

function resolveSpace(space: GenomeSpace): ResolvedSpace {
  if (space === null || typeof space !== 'object') {
    throw new Error('novelty-search: genomeSpace 不能为空');
  }
  assertIntAtLeast(space.dim, 1, 'genomeSpace.dim');
  const range = space.geneRange ?? [-Math.PI, Math.PI];
  if (!Array.isArray(range) || range.length !== 2 || !Number.isFinite(range[0]) || !Number.isFinite(range[1]) || range[0] >= range[1]) {
    throw new Error(`novelty-search: geneRange 需为 [min,max] 且 min < max（得到 ${String(range)}）`);
  }
  const mutateRate = space.mutateRate ?? Math.min(0.15, 6 / space.dim);
  if (!Number.isFinite(mutateRate) || mutateRate <= 0 || mutateRate > 1) {
    throw new Error(`novelty-search: mutateRate 需 ∈ (0,1]（得到 ${String(space.mutateRate)}）`);
  }
  const mutateSigma = space.mutateSigma ?? 0.25;
  if (!Number.isFinite(mutateSigma) || mutateSigma <= 0) {
    throw new Error(`novelty-search: mutateSigma 需为正数（得到 ${String(space.mutateSigma)}）`);
  }
  const crossoverRate = space.crossoverRate ?? 0.5;
  if (!Number.isFinite(crossoverRate) || crossoverRate < 0 || crossoverRate >= 1) {
    throw new Error(`novelty-search: crossoverRate 需 ∈ [0,1)（得到 ${String(space.crossoverRate)}）`);
  }
  return {
    dim: space.dim,
    geneMin: range[0],
    geneMax: range[1],
    span: range[1] - range[0],
    mutateRate,
    mutateSigma,
    crossoverRate,
  };
}

function randomGenome(space: ResolvedSpace, rng: () => number): Genome {
  const g: number[] = [];
  for (let i = 0; i < space.dim; i += 1) g.push(space.geneMin + rng() * space.span);
  return g;
}

/** 原位变异：每基因以 mutateRate 概率高斯扰动并回卷进基因盒（平滑性之源） */
function mutateGenome(space: ResolvedSpace, genome: Genome, rng: () => number): void {
  for (let i = 0; i < genome.length; i += 1) {
    if (rng() < space.mutateRate) {
      const v = genome[i]! + space.mutateSigma * gaussian(rng);
      genome[i] = space.geneMin + (((v - space.geneMin) % space.span) + space.span) % space.span;
    }
  }
}

/** 一点交叉：A 的路径前缀 + B 的增量后缀（保结构的轨迹混合） */
function crossoverGenomes(a: ReadonlyArray<number>, b: ReadonlyArray<number>, rng: () => number): Genome {
  if (a.length < 2) return [...a];
  const cut = 1 + Math.floor(rng() * (a.length - 1));
  const child: number[] = a.slice(0, cut);
  for (let i = cut; i < b.length; i += 1) child.push(b[i]!);
  return child;
}

/** 锦标赛：有放回抽 size 个，得分高者胜（平局先抽者胜） */
function tournament<T>(pool: ReadonlyArray<T>, scoreOf: (x: T) => number, size: number, rng: () => number): T {
  let best = pool[Math.floor(rng() * pool.length)]!;
  for (let i = 1; i < size; i += 1) {
    const cand = pool[Math.floor(rng() * pool.length)]!;
    if (scoreOf(cand) > scoreOf(best)) best = cand;
  }
  return best;
}

// ─────────────────────────── 新奇分（导出口径） ───────────────────────────

/**
 * 新奇分 ρ(b) = 距 b 最近的 k 个池内行为点的平均距离
 * （池 = 归档 ∪ 当前种群；池小于 k 时对全池取平均）。
 * 与引擎内部批量口径逐位一致（同样的候选序 + 同样的升序求和序）。
 */
export function noveltyScore(
  behavior: ReadonlyArray<number>,
  pool: ReadonlyArray<ReadonlyArray<number>>,
  k: number,
): number {
  if (!Array.isArray(behavior) || behavior.length === 0) {
    throw new Error('novelty-search: behavior 需为非空数值数组');
  }
  for (const v of behavior) {
    if (!Number.isFinite(v)) throw new Error('novelty-search: behavior 含非有限值');
  }
  if (!Array.isArray(pool) || pool.length === 0) {
    throw new Error('novelty-search: pool（归档 ∪ 种群）不能为空');
  }
  assertIntAtLeast(k, 1, 'k');
  const kk = Math.min(k, pool.length);
  const best: number[] = [];
  for (const p of pool) {
    if (!Array.isArray(p) || p.length !== behavior.length) {
      throw new Error(`novelty-search: 池内行为维度 ${String(p?.length)} 与查询维度 ${behavior.length} 不一致`);
    }
    const d = dist(behavior, p);
    if (best.length < kk) insertSorted(best, d);
    else if (d < best[kk - 1]!) {
      best.pop();
      insertSorted(best, d);
    }
  }
  let sum = 0;
  for (const v of best) sum += v;
  return sum / kk;
}

/**
 * 批量口径热路径：flat 为 rows 个行为点（行主序），query 与第 skipRow
 * 行同点（排除自身）。候选序 = 行序（归档行在前、种群行在后），
 * 与 noveltyScore 对同序池的计算逐位一致。
 */
function meanKnnFlat(
  flat: Float64Array,
  rows: number,
  dim: number,
  k: number,
  skipRow: number,
  query: ReadonlyArray<number>,
): number {
  const kk = Math.min(k, rows - 1);
  if (kk <= 0) return 0;
  const best: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    if (row === skipRow) continue;
    const off = row * dim;
    let s = 0;
    for (let d = 0; d < dim; d += 1) {
      const diff = flat[off + d]! - query[d]!;
      s += diff * diff;
    }
    const dd = Math.sqrt(s);
    if (best.length < kk) insertSorted(best, dd);
    else if (dd < best[kk - 1]!) {
      best.pop();
      insertSorted(best, dd);
    }
  }
  let sum = 0;
  for (const v of best) sum += v;
  return sum / kk;
}

// ─────────────────────────── 新奇搜索引擎 ───────────────────────────

/**
 * 新奇搜索主循环（Lehman–Stanley）：
 *   初始种群 → 每代 {按 ρ 锦标赛选亲 → 变异/交叉出子代 → 旧代最低
 *   新奇者入档 → 子代对「归档 ∪ 子代」重算 ρ → 换代}。
 * 选择压完全来自新奇分——没有任何适应度目标参与进化。
 * MCNS：给出 minCriterion 时，被选资格与入档资格都限定在可行个体。
 */
export function noveltySearch(config: NoveltySearchConfig): NoveltySearchResult {
  if (config === null || typeof config !== 'object') {
    throw new Error('novelty-search: config 不能为空');
  }
  const space = resolveSpace(config.genomeSpace);
  if (typeof config.behaviorOf !== 'function') {
    throw new Error('novelty-search: behaviorOf 需为函数');
  }
  if (config.minCriterion !== undefined && typeof config.minCriterion !== 'function') {
    throw new Error('novelty-search: minCriterion 需为函数');
  }
  if (config.solved !== undefined && typeof config.solved !== 'function') {
    throw new Error('novelty-search: solved 需为函数');
  }
  assertIntAtLeast(config.generations, 1, 'generations');
  assertIntAtLeast(config.popSize, 4, 'popSize');
  assertIntAtLeast(config.k, 1, 'k');
  assertIntAtLeast(config.archiveCap, 1, 'archiveCap');
  if (!Number.isFinite(config.seed)) {
    throw new Error(`novelty-search: seed 需为有限数（得到 ${String(config.seed)}）`);
  }
  const tournamentSize = config.tournamentSize ?? 3;
  assertIntAtLeast(tournamentSize, 2, 'tournamentSize');
  const cellSize = config.cellSize ?? 1;
  if (!Number.isFinite(cellSize) || cellSize <= 0) {
    throw new Error(`novelty-search: cellSize 需为正数（得到 ${String(cellSize)}）`);
  }
  const archivePolicy = config.archivePolicy ?? 'random';
  if (archivePolicy !== 'random' && archivePolicy !== 'density') {
    throw new Error(`novelty-search: archivePolicy ∈ {random, density}（得到 ${String(config.archivePolicy)}）`);
  }
  const stopWhenSolved = config.stopWhenSolved ?? false;

  const rng = mulberry32(config.seed);
  const behaviorOf = config.behaviorOf;
  const minCriterion = config.minCriterion;
  const solvedOf = config.solved;

  const archive: ArchiveEntry[] = [];
  const solutions: SolutionRecord[] = [];
  const trace: NoveltyTraceEntry[] = [];
  const covered = new Set<string>();
  let archiveDiameter = 0;
  let firstSolved: number | null = null;
  let behaviorDim = -1;

  const cellKey = (b: ReadonlyArray<number>): string => {
    const parts: string[] = [];
    for (const v of b) parts.push(String(Math.floor(v / cellSize)));
    return parts.join(',');
  };

  /** 评估新基因组：行为 + 可行性 + 解命中（行为维度首见即锁定） */
  const evaluate = (genome: Genome, generation: number): NoveltyIndividual => {
    const behavior = behaviorOf(genome);
    if (!Array.isArray(behavior) || behavior.length === 0) {
      throw new Error('novelty-search: behaviorOf 需返回非空数值数组');
    }
    for (const v of behavior) {
      if (!Number.isFinite(v)) throw new Error('novelty-search: behaviorOf 返回含非有限值');
    }
    if (behaviorDim < 0) behaviorDim = behavior.length;
    else if (behavior.length !== behaviorDim) {
      throw new Error(`novelty-search: 行为维度漂移（首见 ${behaviorDim}，现 ${behavior.length}）`);
    }
    return {
      genome,
      behavior,
      novelty: 0,
      feasible: minCriterion ? minCriterion(genome) === true : true,
      solved: solvedOf ? solvedOf(genome) === true : false,
      generation,
    };
  };

  /** 批量新奇分：池 = 归档 ∪ 本代个体（各自排除自身）——noveltyScore 同口径 */
  const assignNovelty = (list: NoveltyIndividual[]): void => {
    if (list.length === 0) return;
    const rows = archive.length + list.length;
    const flat = new Float64Array(rows * behaviorDim);
    for (let e = 0; e < archive.length; e += 1) {
      const b = archive[e]!.behavior;
      for (let d = 0; d < behaviorDim; d += 1) flat[e * behaviorDim + d] = b[d]!;
    }
    for (let i = 0; i < list.length; i += 1) {
      const b = list[i]!.behavior;
      const off = (archive.length + i) * behaviorDim;
      for (let d = 0; d < behaviorDim; d += 1) flat[off + d] = b[d]!;
    }
    for (let i = 0; i < list.length; i += 1) {
      list[i]!.novelty = meanKnnFlat(flat, rows, behaviorDim, config.k, archive.length + i, list[i]!.behavior);
    }
  };

  /** 收割解：命中个体按发现顺序入册 */
  const harvest = (population: NoveltyIndividual[]): boolean => {
    let found = false;
    for (const ind of population) {
      if (ind.solved) {
        solutions.push({ genome: ind.genome, behavior: ind.behavior, generation: ind.generation });
        found = true;
      }
    }
    if (found && firstSolved === null) firstSolved = population[0]!.generation;
    return found;
  };

  /**
   * 归档纪律：当代最低新奇（MCNS 下为可行者中最低新奇）个体入档——
   * 在种群最密集处留面包屑。满员先淘汰一枚再入（random = 随机；density =
   * 驱逐最稠密面包屑——对档案同侪的平均 k 近邻距离最小者, 平局驱先进
   * 档者, 全序确定）。直径增量精确维护（新直径只可能出现在新点 × 旧点
   * 的对上; 淘汰不可能产生新的最大对, 峰值口径不受影响）。
   */
  const evictOne = (): void => {
    if (archive.length < config.archiveCap) return;
    if (archivePolicy === 'random') {
      archive.splice(Math.floor(rng() * archive.length), 1);
      return;
    }
    // density: 驱逐「对同侪的平均 k 近邻距离」最小者（最不稀疏 = 最冗余）
    const kk = Math.max(1, Math.min(config.k, archive.length - 1));
    let worstIdx = 0;
    let worstSparsity = Number.POSITIVE_INFINITY;
    for (let i = 0; i < archive.length; i += 1) {
      const ds: number[] = [];
      for (let j = 0; j < archive.length; j += 1) {
        if (j === i) continue;
        insertSorted(ds, dist(archive[i]!.behavior, archive[j]!.behavior));
        if (ds.length > kk) ds.pop();
      }
      let s = 0;
      for (const d of ds) s += d;
      const sparsity = s / ds.length;
      // 平局（含 1e-15 容差）驱先进档者——下标小者先被淘汰, 确定序
      if (sparsity < worstSparsity - 1e-15) {
        worstSparsity = sparsity;
        worstIdx = i;
      }
    }
    archive.splice(worstIdx, 1);
  };
  const admit = (population: NoveltyIndividual[], generation: number): void => {
    const candidates = minCriterion ? population.filter((p) => p.feasible) : population;
    if (candidates.length === 0) return;
    let pick = candidates[0]!;
    for (const c of candidates) {
      if (c.novelty < pick.novelty) pick = c;
    }
    evictOne();
    if (archive.length > 0) {
      let far = 0;
      for (const e of archive) {
        const d = dist(pick.behavior, e.behavior);
        if (d > far) far = d;
      }
      if (far > archiveDiameter) archiveDiameter = far;
    }
    archive.push({ genome: pick.genome, behavior: pick.behavior, novelty: pick.novelty, generation });
    covered.add(cellKey(pick.behavior));
  };

  const pushTrace = (generation: number, population: NoveltyIndividual[]): void => {
    let mean = 0;
    let max = Number.NEGATIVE_INFINITY;
    for (const ind of population) {
      covered.add(cellKey(ind.behavior));
      mean += ind.novelty;
      if (ind.novelty > max) max = ind.novelty;
    }
    mean /= population.length;
    trace.push({
      generation,
      meanNovelty: round(mean),
      maxNovelty: round(max),
      archiveSize: archive.length,
      archiveDiameter: round(archiveDiameter),
      cellsCovered: covered.size,
      solutions: solutions.length,
    });
  };

  // 初始种群（归档为空，ρ 只对种群算）
  let population: NoveltyIndividual[] = [];
  for (let i = 0; i < config.popSize; i += 1) {
    population.push(evaluate(randomGenome(space, rng), 0));
  }
  assignNovelty(population);
  harvest(population);
  pushTrace(0, population);

  for (let gen = 1; gen <= config.generations; gen += 1) {
    // MCNS 选择基：可行子集（不足 2 人退回全种群——绝不空转）
    let base = population;
    if (minCriterion) {
      const feasible = population.filter((p) => p.feasible);
      if (feasible.length >= 2) base = feasible;
    }
    const children: NoveltyIndividual[] = [];
    for (let i = 0; i < config.popSize; i += 1) {
      const pa = tournament(base, (x) => x.novelty, tournamentSize, rng);
      let genome: Genome;
      if (rng() < space.crossoverRate) {
        const pb = tournament(base, (x) => x.novelty, tournamentSize, rng);
        genome = crossoverGenomes(pa.genome, pb.genome, rng);
      } else {
        genome = [...pa.genome];
      }
      mutateGenome(space, genome, rng);
      children.push(evaluate(genome, gen));
    }
    admit(population, gen); // 旧代面包屑先入档，子代 ρ 的池即含它
    assignNovelty(children);
    population = children;
    const found = harvest(population);
    pushTrace(gen, population);
    if (stopWhenSolved && found) break;
  }

  return {
    archive,
    lastPopulation: population,
    noveltyTrace: trace,
    solutions,
    firstSolvedGeneration: firstSolved,
  };
}

// ─────────────────────────── 纯适应度对照引擎 ───────────────────────────

/**
 * 纯适应度搜索（欺骗自证对照组）：与 noveltySearch 完全相同的
 * 变异/交叉/锦标赛骨架，唯一差别是选择压 = fitnessOf（越大越好，
 * 欺骗场景即「末位启发距离取负」的贪婪启发）。两条引擎唯一的
 * 自由度差异就是选择压——分水岭实验因此是公平的。
 */
export function fitnessOnlySearch(config: FitnessSearchConfig): FitnessSearchResult {
  if (config === null || typeof config !== 'object') {
    throw new Error('novelty-search: config 不能为空');
  }
  const space = resolveSpace(config.genomeSpace);
  if (typeof config.fitnessOf !== 'function') {
    throw new Error('novelty-search: fitnessOf 需为函数');
  }
  if (config.solved !== undefined && typeof config.solved !== 'function') {
    throw new Error('novelty-search: solved 需为函数');
  }
  assertIntAtLeast(config.generations, 1, 'generations');
  assertIntAtLeast(config.popSize, 4, 'popSize');
  if (!Number.isFinite(config.seed)) {
    throw new Error(`novelty-search: seed 需为有限数（得到 ${String(config.seed)}）`);
  }
  const tournamentSize = config.tournamentSize ?? 3;
  assertIntAtLeast(tournamentSize, 2, 'tournamentSize');
  const stopWhenSolved = config.stopWhenSolved ?? false;

  const rng = mulberry32(config.seed);
  const solutions: SolutionRecord[] = [];
  const trace: FitnessTraceEntry[] = [];
  let firstSolved: number | null = null;

  const evaluate = (genome: Genome, generation: number): FitnessIndividual => {
    const fitness = config.fitnessOf(genome);
    if (!Number.isFinite(fitness)) {
      throw new Error('novelty-search: fitnessOf 需返回有限数');
    }
    return {
      genome,
      fitness,
      solved: config.solved ? config.solved(genome) === true : false,
      generation,
    };
  };

  const harvest = (population: FitnessIndividual[]): boolean => {
    let found = false;
    for (const ind of population) {
      if (ind.solved) {
        solutions.push({ genome: ind.genome, generation: ind.generation });
        found = true;
      }
    }
    if (found && firstSolved === null) firstSolved = population[0]!.generation;
    return found;
  };

  const pushTrace = (generation: number, population: FitnessIndividual[]): void => {
    let mean = 0;
    let best = Number.NEGATIVE_INFINITY;
    for (const ind of population) {
      mean += ind.fitness;
      if (ind.fitness > best) best = ind.fitness;
    }
    trace.push({
      generation,
      meanFitness: round(mean / population.length),
      bestFitness: round(best),
      solutions: solutions.length,
    });
  };

  let population: FitnessIndividual[] = [];
  for (let i = 0; i < config.popSize; i += 1) {
    population.push(evaluate(randomGenome(space, rng), 0));
  }
  harvest(population);
  pushTrace(0, population);

  for (let gen = 1; gen <= config.generations; gen += 1) {
    const children: FitnessIndividual[] = [];
    for (let i = 0; i < config.popSize; i += 1) {
      const pa = tournament(population, (x) => x.fitness, tournamentSize, rng);
      let genome: Genome;
      if (rng() < space.crossoverRate) {
        const pb = tournament(population, (x) => x.fitness, tournamentSize, rng);
        genome = crossoverGenomes(pa.genome, pb.genome, rng);
      } else {
        genome = [...pa.genome];
      }
      mutateGenome(space, genome, rng);
      children.push(evaluate(genome, gen));
    }
    population = children;
    const found = harvest(population);
    pushTrace(gen, population);
    if (stopWhenSolved && found) break;
  }

  return { lastPopulation: population, fitnessTrace: trace, solutions, firstSolvedGeneration: firstSolved };
}

// ─────────────────────────── 迷宫实验床 ───────────────────────────

/** 网格迷宫（walls/lethal 均为行主序 0/1 阵；lethal=踏入即不可行） */
export interface GridMaze {
  name: string;
  width: number;
  height: number;
  start: [number, number];
  goal: [number, number];
  walls: Uint8Array;
  lethal: Uint8Array;
}

/** 一次迷宫行走的完整记录 */
export interface MazeWalk {
  /** 行为描述子 = 末位位置（经典 Lehman–Stanley 迷宫口径） */
  behavior: [number, number];
  finalCell: [number, number];
  /** 途中是否抵达目标半径内（解判定，与末位无关） */
  hitGoal: boolean;
  /** 是否踏入死亡格（MCNS 可行性判定） */
  died: boolean;
  /** 末位到目标的欧氏距离（贪婪启发） */
  finalDist: number;
  /** 途中到目标的最小欧氏距离 */
  minDist: number;
  steps: number;
}

/** 迷宫任务包：随机基因组 / 行走模拟 / 行为 / 贪婪启发 / 解 / 可行 */
export interface MazeTask {
  maze: GridMaze;
  genomeLength: number;
  /** 可直接传给搜索引擎的基因组空间（连续转向增量，缺省基因盒） */
  genomeSpace: GenomeSpace;
  randomGenome: (rng: () => number) => Genome;
  simulate: (genome: ReadonlyArray<number>) => MazeWalk;
  behaviorOf: (genome: ReadonlyArray<number>) => number[];
  /** 贪婪启发适应度 = −末位距离（离目标越近越好——欺骗的源头） */
  fitnessOf: (genome: ReadonlyArray<number>) => number;
  solved: (genome: ReadonlyArray<number>) => boolean;
  feasible: (genome: ReadonlyArray<number>) => boolean;
}

/** 目标命中半径（格单位）：必须真正走进目标格才算解 */
const GOAL_RADIUS = 0.75;

/** 步长（格单位）：每步尝试前进一格 */
const STEP_LEN = 1;

/**
 * 连续乌龟轨迹模拟：heading += gene[i]，每步前进一格；撞墙不停车
 * 而是【沿墙滑动】（先试全步，堵则试水平分量，再堵试垂直分量）——
 * 贴墙滑行使单宽走廊的行进对航向误差鲁棒，基因型→行为映射在墙
 * 附近依然平滑（小变异 = 路径微弯 = 末位落在亲代邻域，前沿才能被
 * 选择压平滑外推）。
 */
function simulateMazeWalk(maze: GridMaze, genome: ReadonlyArray<number>): MazeWalk {
  const w = maze.width;
  const h = maze.height;
  const walls = maze.walls;
  const blocked = (px: number, py: number): boolean =>
    px < 0 || py < 0 || px >= w || py >= h || walls[py * w + px] === 1;
  const gx = maze.goal[0] + 0.5;
  const gy = maze.goal[1] + 0.5;
  let x = maze.start[0] + 0.5;
  let y = maze.start[1] + 0.5;
  let heading = 0; // 初始朝上（正对目标——对两台引擎同样公平的起点）
  let hit = Math.hypot(x - gx, y - gy) < GOAL_RADIUS;
  let died = false;
  let minDist = Math.hypot(x - gx, y - gy);
  for (const gene of genome) {
    heading += gene;
    const nx = x + STEP_LEN * Math.sin(heading);
    const ny = y - STEP_LEN * Math.cos(heading);
    if (!blocked(Math.floor(nx), Math.floor(ny))) {
      x = nx;
      y = ny;
    } else if (!blocked(Math.floor(nx), Math.floor(y))) {
      x = nx; // 垂直堵死 → 水平滑
    } else if (!blocked(Math.floor(x), Math.floor(ny))) {
      y = ny; // 水平堵死 → 垂直滑
    }
    if (maze.lethal[Math.floor(y) * w + Math.floor(x)] === 1) died = true;
    const d = Math.hypot(x - gx, y - gy);
    if (d < minDist) minDist = d;
    if (!hit && d < GOAL_RADIUS) hit = true;
  }
  return {
    behavior: [x, y],
    finalCell: [Math.floor(x), Math.floor(y)],
    hitGoal: hit,
    died,
    finalDist: round(Math.hypot(x - gx, y - gy)),
    minDist: round(minDist),
    steps: genome.length,
  };
}

function mazeTask(maze: GridMaze, genomeLength: number, minGenomeLength: number): MazeTask {
  assertIntAtLeast(genomeLength, minGenomeLength, 'genomeLength');
  // 单槽 memo：引擎对同一基因组对象连续调用 behaviorOf/solved/fitnessOf，
  // 共享一次模拟（基因组在评估后绝不再被改写，引用即安全键）
  let memoGenome: ReadonlyArray<number> | null = null;
  let memoWalk: MazeWalk | null = null;
  const walk = (genome: ReadonlyArray<number>): MazeWalk => {
    if (memoGenome !== genome || memoWalk === null) {
      memoGenome = genome;
      memoWalk = simulateMazeWalk(maze, genome);
    }
    return memoWalk;
  };
  return {
    maze,
    genomeLength,
    genomeSpace: { dim: genomeLength },
    randomGenome: (rng: () => number): Genome => {
      const g: number[] = [];
      for (let i = 0; i < genomeLength; i += 1) g.push(-Math.PI + rng() * 2 * Math.PI);
      return g;
    },
    simulate: (genome: ReadonlyArray<number>): MazeWalk => walk(genome),
    behaviorOf: (genome: ReadonlyArray<number>): number[] => walk(genome).behavior,
    fitnessOf: (genome: ReadonlyArray<number>): number => -walk(genome).finalDist,
    solved: (genome: ReadonlyArray<number>): boolean => walk(genome).hitGoal,
    feasible: (genome: ReadonlyArray<number>): boolean => !walk(genome).died,
  };
}

export interface DeceptiveMazeOptions {
  /** 死亡区版：内部变 153 格流沙海（MCNS 必要性实验的 lethal 诱饵） */
  lethal?: boolean;
  /** 决策步数（缺省 128；最短真路径 36 步，绕行+滑动损耗需足量冗余） */
  genomeLength?: number;
}

/**
 * 经典欺骗迷宫（23×17，Lehman–Stanley hard maze 的网格化重构；
 * # 墙，S 起点 (11,15)，G 目标 (11,3)，. 可行格）：
 *
 *   #######################   y=0   外墙
 *   #.....................#   y=1   外环上走廊（真路径末段）
 *   #.#########.#########.#   y=2   目标凹室上段
 *   #.#########G#########.#   y=3   G——唯一入口在上走廊
 *   #.###################.#   y=4   凹室与空腔之间的死墙
 *   #.######.......######.#   y=5
 *   #.######.......######.#   y=6
 *   #.######.......######.#   y=7   大空腔（仅烟囱一口进出）；
 *   #.######.......######.#   y=8   lethal 版 = 内部 x∈[3,19] y∈[5,13]
 *   #.######.......######.#   y=9   变 153 格流沙海（见代码内 lethal 注）
 *   #.#########.#########.#   y=10
 *   #.#########.#########.#   y=11
 *   #.#########.#########.#   y=12  烟囱 x=11（欺骗入口——
 *   #.#########.#########.#   y=13  起点正上方直通空腔）
 *   #.#########.#########.#   y=14
 *   #..........S..........#   y=15  起点在外环下走廊正中
 *   #######################   y=16  外墙
 *
 * 欺骗机理：起点正上方就是烟囱→大空腔，贪婪启发（末位欧氏距离）
 * 从起点 12 一路降到空腔顶 2——梯度尽头是凹室与空腔之间的死墙；
 * 真路径必须先【远离】目标沿外环走 10+14+10 步再折回凹室（最短
 * 36 步）。适应度搜索被梯度锁进空腔；新奇搜索无目标信号，空腔
 * 踩过即失新奇，压力自动转向外环。
 */
export function deceptiveMaze(options: DeceptiveMazeOptions = {}): MazeTask {
  if (options === null || typeof options !== 'object') {
    throw new Error('novelty-search: options 不能为空');
  }
  if (options.lethal !== undefined && typeof options.lethal !== 'boolean') {
    throw new Error(`novelty-search: lethal 需为布尔（得到 ${String(options.lethal)}）`);
  }
  const lethal = options.lethal ?? false;
  const width = 23;
  const height = 17;
  const walls = new Uint8Array(width * height).fill(1);
  const lethalCells = new Uint8Array(width * height);
  const carve = (x0: number, x1: number, y0: number, y1: number): void => {
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) walls[y * width + x] = 0;
    }
  };
  const markLethal = (x0: number, x1: number, y0: number, y1: number): void => {
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) lethalCells[y * width + x] = 1;
    }
  };
  carve(1, 21, 1, 1); // 外环上走廊
  carve(1, 21, 15, 15); // 外环下走廊
  carve(1, 1, 1, 15); // 外环左走廊
  carve(21, 21, 1, 15); // 外环右走廊
  carve(11, 11, 2, 3); // 目标凹室（唯一真入口在上走廊）
  if (lethal) {
    // 死亡区版（流沙海）：内部 x∈[3,19], y∈[5,13] 全开放且全灭
    //（153 格 lethal vs 可行 ~70 格），与外环之间以墙隔离、仅经起点
    // 正上方的 1 格烟囱门 (11,14) 进入——纯新奇的扩散波前从起点一步
    // 就灌进海里，行为预算被吸走大半；MCNS 门槛把选择压全部约束在
    // 外环上（环内壁有墙，可行走廊不打滑）。凹室下方死墙（y=4 行）
    // 保证真路径仍只有外环一条。
    carve(11, 11, 14, 14); // 烟囱门（可行格）
    carve(3, 19, 5, 13); // 流沙海
    markLethal(3, 19, 5, 13);
  } else {
    carve(11, 11, 10, 14); // 烟囱（欺骗入口）
    carve(8, 14, 5, 9); // 大空腔（死路陷阱）
  }
  const maze: GridMaze = {
    name: lethal ? '欺骗迷宫·死亡区版' : '欺骗迷宫',
    width,
    height,
    start: [11, 15],
    goal: [11, 3],
    walls,
    lethal: lethalCells,
  };
  return mazeTask(maze, options.genomeLength ?? 128, 40);
}

export interface OpenFieldMazeOptions {
  /** 决策步数（缺省 72；直线路径约 29 步——不得低于 32） */
  genomeLength?: number;
}

/**
 * 开阔地（无欺骗对照，锚点⑤）：41×29 全开（仅边界墙），起点 (20,27)
 * 右下、目标 (2,2) 左上——直线约 29 步，贪婪启发全程单调无陷阱。
 * 用途：诚实报告新奇的代价（能解，但平均首解代数多于适应度搜索——
 * 新奇把预算撒向全图，目标只是被覆盖到的区域之一）。
 */
export function openFieldMaze(options: OpenFieldMazeOptions = {}): MazeTask {
  if (options === null || typeof options !== 'object') {
    throw new Error('novelty-search: options 不能为空');
  }
  const width = 41;
  const height = 29;
  const walls = new Uint8Array(width * height).fill(1);
  for (let y = 1; y <= 27; y += 1) {
    for (let x = 1; x <= 39; x += 1) walls[y * width + x] = 0;
  }
  const maze: GridMaze = {
    name: '开阔地（无欺骗对照）',
    width,
    height,
    start: [20, 27],
    goal: [2, 2],
    walls,
    lethal: new Uint8Array(width * height),
  };
  return mazeTask(maze, options.genomeLength ?? 72, 32);
}

// ─────────────────────────── 招牌实验统计 ───────────────────────────

/** 批量搜索结果摘要 */
export interface SearchSummary {
  runs: number;
  successes: number;
  successRate: number;
  /** 成功种子的平均首解代数（无成功为 null） */
  meanFirstGeneration: number | null;
  maxFirstGeneration: number | null;
}

export interface HardMazeOptions {
  generations?: number;
  popSize?: number;
  k?: number;
  archiveCap?: number;
  genomeLength?: number;
  lethal?: boolean;
}

export interface HardMazeStatsResult {
  seeds: number;
  novelty: SearchSummary;
  fitness: SearchSummary;
  settings: Required<HardMazeOptions>;
}

function summarize(runs: ReadonlyArray<number | null>, total: number): SearchSummary {
  const hits = runs.filter((g): g is number => g !== null);
  if (hits.length === 0) {
    return { runs: total, successes: 0, successRate: 0, meanFirstGeneration: null, maxFirstGeneration: null };
  }
  const mean = hits.reduce((a, b) => a + b, 0) / hits.length;
  return {
    runs: total,
    successes: hits.length,
    successRate: round(hits.length / total),
    meanFirstGeneration: round(mean),
    maxFirstGeneration: Math.max(...hits),
  };
}

/**
 * 招牌实验（锚点①）：欺骗迷宫上新奇搜索 vs 纯适应度搜索，各跑
 * seeds 个种子（seed = 1..seeds），同一预算、同一变异/交叉算子，
 * 唯一差异是选择压（新奇分 vs 贪婪启发）。命中即停。
 */
export function hardMazeStats(seeds: number, options: HardMazeOptions = {}): HardMazeStatsResult {
  assertIntAtLeast(seeds, 1, 'seeds');
  if (options === null || typeof options !== 'object') {
    throw new Error('novelty-search: options 不能为空');
  }
  const settings: Required<HardMazeOptions> = {
    generations: options.generations ?? 200,
    popSize: options.popSize ?? 50,
    k: options.k ?? 10,
    archiveCap: options.archiveCap ?? 220,
    genomeLength: options.genomeLength ?? 128,
    lethal: options.lethal ?? false,
  };
  assertIntAtLeast(settings.generations, 1, 'generations');
  assertIntAtLeast(settings.popSize, 4, 'popSize');
  assertIntAtLeast(settings.k, 1, 'k');
  assertIntAtLeast(settings.archiveCap, 1, 'archiveCap');
  assertIntAtLeast(settings.genomeLength, 40, 'genomeLength');
  if (typeof settings.lethal !== 'boolean') {
    throw new Error(`novelty-search: lethal 需为布尔（得到 ${String(settings.lethal)}）`);
  }
  const task = deceptiveMaze({ lethal: settings.lethal, genomeLength: settings.genomeLength });
  const noveltyRuns: Array<number | null> = [];
  const fitnessRuns: Array<number | null> = [];
  for (let s = 1; s <= seeds; s += 1) {
    const ns = noveltySearch({
      genomeSpace: task.genomeSpace,
      behaviorOf: task.behaviorOf,
      solved: task.solved,
      generations: settings.generations,
      popSize: settings.popSize,
      k: settings.k,
      archiveCap: settings.archiveCap,
      seed: s,
      stopWhenSolved: true,
    });
    noveltyRuns.push(ns.firstSolvedGeneration);
    const fs = fitnessOnlySearch({
      genomeSpace: task.genomeSpace,
      fitnessOf: task.fitnessOf,
      solved: task.solved,
      generations: settings.generations,
      popSize: settings.popSize,
      seed: s,
      stopWhenSolved: true,
    });
    fitnessRuns.push(fs.firstSolvedGeneration);
  }
  return { seeds, novelty: summarize(noveltyRuns, seeds), fitness: summarize(fitnessRuns, seeds), settings };
}

/* ── 接线建议 ──
 * 挂载引擎: 好奇心引擎 + 策略进化（第二探索轴）+ dashboard
 * 1. 好奇心引擎「向盲区定向」: 69.0 Mapper 的空洞边界（cycleBasis
 *    成员节点的质心）给出行为空间的盲区坐标；把探索预算从「随机
 *    噪声 + 简单好奇分」升级为 91.0 的新奇定向——b(x) 取经验轨迹
 *    的表示向量（或 Mapper 节点坐标），noveltyScore 高的方向 =
 *    没人活过的活法，向其定向采样。
 * 2. 策略进化的第二条跳出局部最优之路: 66.0 模拟退火管参数空间
 *    （温度跳出）；91.0 管行为空间（新奇跳出）——策略进化收敛
 *    （QD 覆盖停止增长）时把选择压切到 ρ，行为空间扩散后再切回
 *    目标优化。novelty ↔ objective 交替 = 欺骗地形的结构性解法。
 * 3. MCNS 可行性门槛: 有硬约束的场景（预算禁区 / 安全边界 / 供应
 *    商黑名单）挂 minCriterion——新奇探索被约束在可行域内定向，
 *    不为「新奇但致死」的活法烧选择预算（锚点③的必要性构造）。
 * 4. 缺省关闭旗标: config.kernels.noveltySearchEnabled = false
 *    （未开启时上述路径零介入——纯分析内核只读）。
 * 5. 挂载后改变的决策点: 好奇心采样目标（噪声 → 行为空间空白
 *    定向）、策略进化选择压（适应度 ↔ 新奇分切换）、探索预算
 *    分配（noveltyTrace 的 archiveDiameter / cellsCovered 停长 =
 *    行为空间饱和信号，可回切目标优化）。诚实口径（锚点⑤）:
 *    平滑无欺骗地形上新奇慢于目标搜索——两台引擎按地形切换，
 *    而非永久抛弃目标。
 */
