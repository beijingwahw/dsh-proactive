/**
 * nsga2-pareto.ts — 67.0 NSGA-II 帕累托内核（随机优化双件套之二：多目标前沿维持）
 *
 * 动机: 模型调度器面对的从来不是单一目标——「质量要高、成本要低、延迟
 * 要小」三者天然冲突。现状是把三个目标拍一个权重和（wᵀf）再单目标优化：
 * 权重是拍出来的，最优解是权重在**前**、场景在**后**的先验赌博——场景
 * 一变（突发流量要延迟 / 深夜批处理要成本），权重体系推倒重来，且永远
 * 无法回答「多花 2 分钱能省多少毫秒」这种边际问题。帕累托视角把问题
 * 反转：**先**求出互不支配的前沿点集，**后**按场景在前沿上选点——决策
 * 引擎拿到的不再是一个解，而是一张「性价比菜单」。14.0 质量-多样性在
 * **行为空间**保流派（每格留本地最优），本内核在**目标空间**保前沿
 * （每个权衡档留代表）——两种多样性正交互补。
 *
 * 数学（Deb et al. 2002, NSGA-II）:
 * 1. 支配关系 ≼: a 支配 b ⟺ ∀k a_k ≤ b_k 且 ∃j a_j < b_j（全目标不差、
 *    至少一目标严格更好；全最小化口径）。Pareto 前沿 = 种群中互不支配的
 *    极大反链。
 * 2. 快速非支配排序: 经典 O(MN²) 算法——对每个体记支配计数 nᵢ 与被支配
 *    集 Sᵢ，按层剥洋葱（第 1 层 nᵢ=0；剥掉第 k 层后 nⱼ 归零者入第 k+1 层）。
 * 3. 拥挤距离: 同层个体按各目标排序，边界个体置 ∞，内部个体累加两侧
 *    邻居的目标跨度（按各目标极差归一）——「我周围有多空」的无参数密度
 *    估计。锦标赛比较算子 (rank, −crowding): 先比层，同层比空旷——
 *    选择压力与多样性维持由同一算子完成，无需任何距离阈值。
 * 4. 精英 (μ+λ) 截断: 父+子合并 2N，按 (层, 拥挤距离降序) 词典序截断
 *    回 N——最优层永不丢失（HV 单调性的来源），尾层按拥挤度铺开。
 * 5. 2 维超体积 HV: 参考点 r 下被支配区域面积。按 f₁ 升序剔除被支配点后
 *    得阶梯，扫掠增量闭式 HV = Σᵢ (f₁,ᵢ₊₁ − f₁,ᵢ)·(r₂ − f₂,ᵢ)（末点
 *    f₁,ₖ₊₁ := r₁）——O(K log K) 精确，与三角剖分/容斥穷举一致（验证锚点⑤）。
 *
 * 验证锚点（scripts/verify-stochastic-optimization.mjs，ZDT1 型凸前沿玩具
 * 决策 (x,y)∈[0,1]²，f₁=x，g=1+y，f₂=g·(1−√(f₁/g))，真前沿 y=0 即
 * f₂=1−√f₁）:
 * ① 精英归档（历代非支配并集）HV 逐代单调不减（μ+λ 精英的数学必然），
 *    末代种群目标空间散布铺满前沿（f₁ 极差 ≥ 0.9）；
 * ② 末代种群全部互不支配（成对检查 dominates）；
 * ③ 简版 IGD（种群到解析前沿的平均距离）随代数下降 ≥ 一个数量级
 *    （初始 g≈5.5 平均抬升 f₂ 远离前沿，进化把 y→0 拉回曲线）；
 * ④ 对照实验: 固定权重 w=(½,½) 加权和 GA（同算子同预算）种群在目标
 *    空间塌缩到前沿单点（散布 ≪ NSGA-II 的 1/5）——加权和的解是前沿上
 *    一个点，NSGA-II 的解是整条前沿（拥挤度维持多样性的实证）；
 * ⑤ hypervolume2D 与矩形并容斥穷举（2ᵏ⁻¹ 子集精确并面积）在小例上
 * 逐点一致（含被支配内部点 / 参考点外点 / 同 f₁ 平局的边角）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 *
 * ── 第五轮世界性进化（R5-A15，四轴）──
 * 1. [数学] ε-支配归档（Laumanns et al. 2002）：box 下标 b_k(x) =
 *    ⌈x_k/ε_k⌉；x ⪯_ε y ⟺ ∀k: b_k(x) < b_k(y) ∨ (b_k(x) = b_k(y) ∧
 *    x_k ≤ ε_k·b_k(y))。按坐标逐项验证传递性（b 单调携带 + 值条件沿
 *    等箱链闭合）——严格偏序预序。EpsilonParetoArchive 每箱恰留一代表
 *    （同箱按支配关系/箱角距离定去留），代表两两 ε-互不支配：归档
 *    规模 ≤ 与前沿相交的箱数——**前沿的分辨率有界化**（精确 Pareto
 *    集可以无限大，ε-箱化后至多 (range/ε)^M 箱）。被拒收的点必被
 *    在位代表 ε-支配（覆盖性不变差的压缩）。
 * 2. [性能] 秩排序剪枝：fastNonDominatedSort 预按目标词典序排序后
 *    只扫上三角——i <lex j ⟹ 首异维 i 更小 ⟹ j 不可能支配 i，支配边
 *    只沿排序方向（配对减半，输出与原算法逐位一致：层成员由支配计数
 *    唯一决定，层内按下标排序不变）。paretoFront 在 2 维走
 *    O(N log N) 扫掠快速路径（(f₁↑, f₂↑) 排序后支配 ⟺ 前缀存在更小
 *    f₂ 或等 f₂ 且更小 f₁；M ≠ 2 回落原 O(N²)——向后兼容）。
 * 3. [数值] hypervolume2D 累加改 Kahan 补偿求和 + 切宽非负钳制：
 *    大量窄切片的求和误差从 O(n·ulp) 压到 O(ulp)（单调性断言的
 *    数值地基）；除零/退化目标沿用既有守卫。
 * 4. [性质] ε-支配传递性（种子化随机三元组 200 例逐一机器验证）、
 *    归档反链不变量（两两 ε-互不支配 + 每箱一代表）、超体积单调性
 *    （加点不减，Kahan 口径 1e-12）——见 verify-r5-evolutionary.mjs。
 */

// ─────────────────────────── 确定性随机基座 ───────────────────────────

/** mulberry32：32 位确定性伪随机源（种子固定时序列完全可复现） */
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

// ─────────────────────────── 支配关系与排序 ───────────────────────────

/** 目标向量校验: 非空、维数一致、全部有限 */
function validateObjectives(pop: number[][], what: string): number {
  if (!Array.isArray(pop) || pop.length === 0) {
    throw new Error(`nsga2: ${what} 须为非空数组`);
  }
  const m = pop[0]!.length;
  if (m === 0) throw new Error(`nsga2: ${what} 的目标向量不能是零维`);
  for (const p of pop) {
    if (!Array.isArray(p) || p.length !== m) {
      throw new Error(`nsga2: ${what} 内目标维数不一致（期望 ${m}，收到 ${p?.length}）`);
    }
    for (const v of p) {
      if (!Number.isFinite(v)) throw new Error(`nsga2: ${what} 内目标值须为有限数（收到 ${v}）`);
    }
  }
  return m;
}

/**
 * 支配关系（全最小化）: a 支配 b ⟺ ∀k aₖ ≤ bₖ 且 ∃j aⱼ < bⱼ。
 * 注: 自反不成立（a 不支配 a）、相等向量互不支配（帕累托反链性质）。
 */
export function dominates(a: number[], b: number[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    throw new Error(`nsga2: dominates 要求两个等长非空目标向量（收到 ${a?.length} vs ${b?.length}）`);
  }
  let strictlyBetter = false;
  for (let k = 0; k < a.length; k += 1) {
    const av = a[k];
    const bv = b[k];
    if (!Number.isFinite(av) || !Number.isFinite(bv)) {
      throw new Error(`nsga2: dominates 要求有限目标值（收到 ${av}, ${bv}）`);
    }
    if (av > bv) return false;
    if (av < bv) strictlyBetter = true;
  }
  return strictlyBetter;
}

/** 种群的帕累托前沿（互不支配点，保持出现序）——归档/报告用 */
export function paretoFront(points: number[][]): number[][] {
  const m = validateObjectives(points, 'paretoFront 输入');
  if (m === 2) {
    // 第五轮进化 [性能]: 2 维 O(N log N) 扫掠快速路径。
    // (f₁ 升序, f₂ 升序) 排序后：点被支配 ⟺ 前缀存在 f₂ 更小者，或
    // f₂ 相等且 f₁ 严格更小者；保留规则 = f₂ < m 或 (f₂ = m ∧ f₁ = 现行
    // 最小 f₂ 的首次出现者)——与 O(N²) dominates 口径逐位等价（含重复
    // 点/平局：dominates 要求至少一维严格更好，等向量互不支配）。
    const packed = points.map((p, i) => ({ f1: p[0]!, f2: p[1]!, i }));
    packed.sort((a, b) => a.f1 - b.f1 || a.f2 - b.f2 || a.i - b.i);
    const keep = new Array<boolean>(points.length).fill(false);
    let minF2 = Number.POSITIVE_INFINITY;
    let firstF1AtMin = Number.POSITIVE_INFINITY;
    for (const q of packed) {
      if (q.f2 < minF2) {
        keep[q.i] = true;
        minF2 = q.f2;
        firstF1AtMin = q.f1;
      } else if (q.f2 === minF2 && q.f1 === firstF1AtMin) {
        keep[q.i] = true; // 等点重复：互不支配，保留（与 dominates 口径一致）
      }
    }
    return points.filter((_, i) => keep[i]);
  }
  return points.filter((p) => !points.some((q) => dominates(q, p)));
}

/**
 * 快速非支配排序（Deb O(MN²)）: 返回各层（种群下标分组），第 1 层为
 * 帕累托前沿，第 k+1 层 = 剥掉前 k 层后的前沿。同层内按下标升序（确定性）。
 *
 * 第五轮进化 [性能] 词典序预排序剪枝：先按目标向量词典序排序，则
 * i <lex j ⟹ j 支配 i 不可能（首异维上 i 更小，j 需全维 ≤ 不成立）——
 * 支配边只沿排序方向，上三角单趟即得全部支配对（配对比较减半）。
 * 层结果与原算法逐位一致：支配计数/被支配集相同，剥洋葱成员唯一，
 * 层内下标排序不变。
 */
export function fastNonDominatedSort(pop: number[][]): number[][] {
  validateObjectives(pop, 'fastNonDominatedSort 输入');
  const size = pop.length;
  // 词典序排序（一次）：支配边只沿排序方向 → 只扫上三角（配对减半）；
  // 分层在「排序位次空间」进行（无逐对下标间接），末尾映射回原下标。
  const sorted = pop
    .map((p, i) => ({ p, i }))
    .sort((a, b) => {
      const pa = a.p;
      const pb = b.p;
      for (let k = 0; k < pa.length; k += 1) {
        if (pa[k] !== pb[k]) return pa[k]! - pb[k]!;
      }
      return a.i - b.i; // 全等向量按原下标稳定（互不支配，不影响层结果）
    });
  const dominatedBy: number[][] = Array.from({ length: size }, () => [] as number[]);
  const dominationCount = new Array<number>(size).fill(0);
  for (let a = 0; a < size; a += 1) {
    const pi = sorted[a]!.p;
    for (let b = a + 1; b < size; b += 1) {
      const pj = sorted[b]!.p;
      if (dominates(pi, pj)) {
        dominatedBy[a]!.push(b);
        dominationCount[b]! += 1;
      } else if (dominates(pj, pi)) {
        dominatedBy[b]!.push(a);
        dominationCount[a]! += 1;
      }
    }
  }
  const fronts: number[][] = [];
  let current = dominationCount.reduce<number[]>((acc, c, i) => {
    if (c === 0) acc.push(i);
    return acc;
  }, []);
  while (current.length > 0) {
    // 位次 → 原下标，层内按下标升序（与原算法逐位一致）
    fronts.push(current.map((pos) => sorted[pos]!.i).sort((x, y) => x - y));
    const next: number[] = [];
    for (const i of current) {
      for (const j of dominatedBy[i]!) {
        dominationCount[j]! -= 1;
        if (dominationCount[j] === 0) next.push(j);
      }
    }
    current = next;
  }
  return fronts;
}

/**
 * 拥挤距离（Deb 2002）: front 传入目标向量组，返回对齐的拥挤距离。
 * 边界个体（各目标最值）置 ∞；内部个体累加两侧邻居的目标跨度（按该
 * 目标极差归一）。目标极差为 0（该维退化）时跳过该目标——避免任意
 * 排序把全员误置 ∞。|front| ≤ 2 时全员是边界 → 全 ∞。
 */
export function crowdingDistance(front: number[][]): number[] {
  const m = validateObjectives(front, 'crowdingDistance 输入');
  const size = front.length;
  const dist = new Array<number>(size).fill(0);
  if (size === 1) {
    // 单点即该层唯一个体——无邻居可言，按边界个体置 ∞
    dist[0] = Number.POSITIVE_INFINITY;
    return dist;
  }
  for (let k = 0; k < m; k += 1) {
    const order = front.map((p, i) => i).sort((i, j) => front[i]![k]! - front[j]![k]!);
    const fmin = front[order[0]!]![k]!;
    const fmax = front[order[size - 1]!]![k]!;
    if (fmax === fmin) continue; // 该目标维退化: 无跨度可分
    dist[order[0]!] = Number.POSITIVE_INFINITY;
    dist[order[size - 1]!] = Number.POSITIVE_INFINITY;
    for (let r = 1; r < size - 1; r += 1) {
      const i = order[r]!;
      if (Number.isFinite(dist[i]!)) {
        dist[i]! += (front[order[r + 1]!]![k]! - front[order[r - 1]!]![k]!) / (fmax - fmin);
      }
    }
  }
  return dist;
}

// ─────────────────────────── 2 维超体积 ───────────────────────────

/**
 * 2 维超体积（最小化，参考点 ref = (r₁, r₂)）: 种群支配区域
 * [f₁, r₁] × [f₂, r₂] 的并面积。按 f₁ 升序剔除被支配点后阶梯扫掠:
 *   HV = Σᵢ (f₁,ᵢ₊₁ − f₁,ᵢ)·(r₂ − f₂,ᵢ)，f₁,ₖ₊₁ := r₁
 * （阶梯第 i 段的高度由「f₁ 不大于本段起点的点中最低 f₂」决定——
 * 剔除支配点后即本点自身）。参考点外（f₁ ≥ r₁ 或 f₂ ≥ r₂）的点零贡献，
 * 直接剔除。O(K log K) 精确。
 */
export function hypervolume2D(points: number[][], ref: [number, number]): number {
  if (!Array.isArray(points)) throw new Error('nsga2: hypervolume2D 输入须为点数组');
  if (!Number.isFinite(ref[0]) || !Number.isFinite(ref[1])) {
    throw new Error(`nsga2: 参考点须为有限数（收到 (${ref[0]}, ${ref[1]})）`);
  }
  for (const p of points) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      throw new Error(`nsga2: hypervolume2D 的点须为 2 维有限数（收到 [${p?.join(', ')}]）`);
    }
  }
  const effective = points
    .filter((p) => p[0]! < ref[0] && p[1]! < ref[1])
    .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
  const staircase: number[][] = [];
  let minF2SoFar = Number.POSITIVE_INFINITY;
  for (const p of effective) {
    if (p[1]! < minF2SoFar) {
      staircase.push(p);
      minF2SoFar = p[1]!;
    }
  }
  // 第五轮进化 [数值]: Kahan 补偿求和 + 切宽非负钳制——大量窄切片的
  // 舍入误差从 O(n·ulp) 累计压到 O(ulp)（超体积单调性断言的数值地基）
  let hv = 0;
  let compensation = 0;
  for (let i = 0; i < staircase.length; i += 1) {
    const nextF1 = i + 1 < staircase.length ? staircase[i + 1]![0]! : ref[0];
    const slice = Math.max(0, nextF1 - staircase[i]![0]!) * (ref[1] - staircase[i]![1]!);
    const t = hv + slice;
    compensation += hv - t + slice; // 标准 Kahan: 找回 (a+b) 丢失的低阶位
    hv = t;
  }
  return hv + compensation;
}

// ─────────────────────────── ε-支配归档（第五轮进化） ───────────────────────────

/**
 * box 下标（Laumanns et al. 2002）: b_k(x) = ⌈x_k / ε_k⌉。
 * 目标空间被边长 ε 的盒子分割，b(x) 是 x 所在盒子的整数坐标。
 */
export function epsilonBox(point: number[], eps: number[]): number[] {
  if (!Array.isArray(point) || point.length === 0 || !Array.isArray(eps) || eps.length !== point.length) {
    throw new Error(`nsga2: epsilonBox 要求点与 ε 等长非空（收到 ${point?.length} vs ${eps?.length}）`);
  }
  const box: number[] = [];
  for (let k = 0; k < point.length; k += 1) {
    const x = point[k]!;
    const e = eps[k]!;
    if (!Number.isFinite(x) || typeof e !== 'number' || !Number.isFinite(e) || e <= 0) {
      throw new Error(`nsga2: epsilonBox 第 ${k} 维非法（x=${String(x)}, ε=${String(e)}；ε 须为正有限数）`);
    }
    box.push(Math.ceil(x / e));
  }
  return box;
}

/**
 * ε-支配（Laumanns 口径，全最小化）:
 *   a ⪯_ε b ⟺ ∀k: b_k(a) < b_k(b) ∨ (b_k(a) = b_k(b) ∧ a_k ≤ ε_k·b_k(b))
 *
 * 传递性（逐坐标验证）: a ⪯_ε b ∧ b ⪯_ε c ⟹ b_k(a) ≤ b_k(b) ≤ b_k(c)；
 * 若任一严格则首析取支成立；若全等箱，a_k ≤ ε·b_k(b) = ε·b_k(c)，
 * 次析取支成立——故 a ⪯_ε c。注意同箱内两点互相 ε-支配（预序而非
 * 偏序），归档以「每箱一代表」消解（EpsilonParetoArchive）。
 */
export function epsilonDominates(a: number[], b: number[], eps: number[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    throw new Error(`nsga2: epsilonDominates 要求两个等长非空目标向量（收到 ${a?.length} vs ${b?.length}）`);
  }
  const boxA = epsilonBox(a, eps);
  const boxB = epsilonBox(b, eps);
  for (let k = 0; k < a.length; k += 1) {
    const ba = boxA[k]!;
    const bb = boxB[k]!;
    if (ba > bb) return false;
    if (ba === bb && !(a[k]! <= eps[k]! * bb)) return false;
  }
  // 全维 ba ≤ bb 且（严格或值条件成立）——但全等箱且 a=b 时也算支配（预序语义，见上）
  return true;
}

/** ε-归档插入结果 */
export interface EpsilonArchiveInsertResult {
  accepted: boolean;
  /** 'insert' 新箱插入 | 'replace' 同箱换代表 | 'rejected' 被在位者 ε-支配 */
  outcome: 'insert' | 'replace' | 'rejected';
  box: number[];
  /** 本次插入挤掉的旧代表（replace 时恰一个；insert 时可能多个被 ε-支配清除） */
  removedPoints: number[][];
}

/**
 * ε-Pareto 归档（Laumanns ε-dominance archive）：
 * - 每个盒子恰留一个代表；同箱竞争：先比严格支配，无支配关系时留
 *   「离箱角（ε·(b−1)）更近」者（总距平局留旧——稳定性）；
 * - 空箱插入前检查：被任一在位代表 ε-支配 ⟺ 拒收（被拒点被保留者
 *   覆盖——压缩不丢覆盖）；同时清除被新点 ε-支配的既有代表；
 * - 不变量（验证锚点）：任意时刻两两代表 ε-互不支配、每箱一代表、
 *   规模 ≤ 与已见点集相交的箱数（前沿分辨率的有界化）。
 * 插入按到达序处理（确定性）。
 */
export class EpsilonParetoArchive {
  private readonly eps: number[];
  private readonly reps: Array<{ box: number[]; point: number[] }> = [];

  constructor(eps: number[]) {
    if (!Array.isArray(eps) || eps.length === 0) {
      throw new Error(`nsga2: EpsilonParetoArchive 的 eps 须为非空数组（收到 ${eps?.length} 维）`);
    }
    for (const e of eps) {
      if (typeof e !== 'number' || !Number.isFinite(e) || e <= 0) {
        throw new Error(`nsga2: EpsilonParetoArchive 的每维 ε 须为正有限数（收到 ${String(e)}）`);
      }
    }
    this.eps = [...eps];
  }

  /** 当前代表数 */
  size(): number {
    return this.reps.length;
  }

  /** 全部代表（插入序） */
  points(): number[][] {
    return this.reps.map((r) => [...r.point]);
  }

  /** 代表的盒子坐标（插入序） */
  boxes(): number[][] {
    return this.reps.map((r) => [...r.box]);
  }

  private static cornerDistance(point: number[], box: number[], eps: number[]): number {
    let d = 0;
    for (let k = 0; k < point.length; k += 1) {
      const edge = point[k]! - eps[k]! * (box[k]! - 1);
      d += Math.max(0, edge);
    }
    return d;
  }

  /** 插入一个点（返回接受/拒收与清除明细） */
  insert(point: number[]): EpsilonArchiveInsertResult {
    if (!Array.isArray(point) || point.length !== this.eps.length) {
      throw new Error(`nsga2: insert 的点须为 ${this.eps.length} 维（收到 ${point?.length}）`);
    }
    for (const v of point) {
      if (!Number.isFinite(v)) throw new Error(`nsga2: insert 的点须为有限数（收到 ${String(v)}）`);
    }
    const box = epsilonBox(point, this.eps);
    // 同箱竞争：支配关系 → 箱角距离 → 留旧
    const sameBoxIdx = this.reps.findIndex((r) => r.box.every((b, k) => b === box[k]));
    if (sameBoxIdx >= 0) {
      const incumbent = this.reps[sameBoxIdx]!.point;
      if (dominates(point, incumbent)) {
        this.reps.splice(sameBoxIdx, 1);
        this.reps.push({ box, point: [...point] });
        return { accepted: true, outcome: 'replace', box, removedPoints: [[...incumbent]] };
      }
      if (dominates(incumbent, point)) {
        return { accepted: false, outcome: 'rejected', box, removedPoints: [] };
      }
      const dNew = EpsilonParetoArchive.cornerDistance(point, box, this.eps);
      const dOld = EpsilonParetoArchive.cornerDistance(incumbent, box, this.eps);
      if (dNew < dOld) {
        this.reps.splice(sameBoxIdx, 1);
        this.reps.push({ box, point: [...point] });
        return { accepted: true, outcome: 'replace', box, removedPoints: [[...incumbent]] };
      }
      return { accepted: false, outcome: 'rejected', box, removedPoints: [] };
    }
    // 空箱：被任一在位代表 ε-支配 ⟺ 拒收
    for (const r of this.reps) {
      if (epsilonDominates(r.point, point, this.eps)) {
        return { accepted: false, outcome: 'rejected', box, removedPoints: [] };
      }
    }
    // 清除被新点 ε-支配的代表（不同箱），再插入
    const removed: number[][] = [];
    for (let i = this.reps.length - 1; i >= 0; i -= 1) {
      const r = this.reps[i]!;
      if (epsilonDominates(point, r.point, this.eps)) {
        removed.push([...r.point]);
        this.reps.splice(i, 1);
      }
    }
    this.reps.push({ box, point: [...point] });
    return { accepted: true, outcome: 'insert', box, removedPoints: removed.reverse() };
  }
}

// ─────────────────────────── NSGA-II 单步 ───────────────────────────

/** NSGA-II 遗传算子（内核纯数学，算子由调用方注入） */
export interface Nsga2Operators<T> {
  /** 候选者 → 目标向量（全最小化；须纯函数——同候选者同向量） */
  objectives: (candidate: T) => number[];
  /** 交叉: (a, b) → 两个子代（rng 注入保持确定性） */
  crossover: (a: T, b: T, rng: () => number) => [T, T];
  /** 变异: x → x′（rng 注入保持确定性） */
  mutation: (candidate: T, rng: () => number) => T;
}

/** nsga2Step 结果 */
export interface Nsga2StepResult<T> {
  /** 下一代种群（长度 = 亲代长度 N；(μ+λ) 截断后） */
  population: T[];
  /** 下一代目标向量（对齐 population） */
  objectiveValues: number[][];
  /** 下一代的目标向量非支配分层（population 下标） */
  fronts: number[][];
  /** 本步目标函数求值次数（父 N + 子 N——父目标每步重估，算子纯函数假设） */
  evaluations: number;
}

/**
 * NSGA-II 单代进化（μ+λ 精英）:
 *   1. 父代分层 + 拥挤距离；
 *   2. 二元锦标赛（先比层，同层比拥挤距离大者胜）选亲，交叉 + 变异
 *      生成 N 子代（奇数 N 时最后一个子代单亲变异）；
 *   3. 父子合并 2N，按（层序，拥挤距离降序，下标升序）截断回 N；
 *      尾层放不下时按拥挤距离铺开（前沿 + 多样性同一算子维持）。
 * rng 消费纪律: 每个孩子对固定消费 4 次锦标赛抽样（i,j 两两）+ 算子
 * 自身消费——同 (population, seed) 逐位复现。
 */
export function nsga2Step<T>(config: {
  population: T[];
} & Nsga2Operators<T> & {
  rng: () => number;
}): Nsga2StepResult<T> {
  const { population, objectives, crossover, mutation, rng } = config;
  if (!Array.isArray(population) || population.length === 0) {
    throw new Error('nsga2: population 须为非空数组');
  }
  const parentObjectives = population.map((x) => objectives(x));
  const m = validateObjectives(parentObjectives, '亲代目标向量');

  // 1. 父代 (rank, crowding) 锦标赛
  const parentFronts = fastNonDominatedSort(parentObjectives);
  const rank = new Array<number>(population.length).fill(0);
  const crowd = new Array<number>(population.length).fill(0);
  for (let f = 0; f < parentFronts.length; f += 1) {
    const front = parentFronts[f]!;
    const frontObjectives = front.map((i) => parentObjectives[i]!);
    const distances = crowdingDistance(frontObjectives);
    for (let k = 0; k < front.length; k += 1) {
      rank[front[k]!] = f;
      crowd[front[k]!] = distances[k]!;
    }
  }
  const tournament = (): T => {
    const i = Math.floor(rng() * population.length);
    const j = Math.floor(rng() * population.length);
    const ri = rank[i]!;
    const rj = rank[j]!;
    if (ri !== rj) return ri < rj ? population[i]! : population[j]!;
    return crowd[i]! >= crowd[j]! ? population[i]! : population[j]!;
  };

  // 2. 生成 N 子代
  const offspring: T[] = [];
  while (offspring.length < population.length) {
    const room = population.length - offspring.length;
    if (room >= 2) {
      const [c1, c2] = crossover(tournament(), tournament(), rng);
      offspring.push(mutation(c1, rng), mutation(c2, rng));
    } else {
      offspring.push(mutation(tournament(), rng));
    }
  }
  const offspringObjectives = offspring.map((x) => objectives(x));
  validateObjectives(offspringObjectives, '子代目标向量');

  // 3. (μ+λ) 合并截断: 按层填充；尾层按拥挤距离降序（平局下标升序）
  const mergedObjectives = [...parentObjectives, ...offspringObjectives];
  const merged = [...population, ...offspring];
  const mergedFronts = fastNonDominatedSort(mergedObjectives);
  const survivors: number[] = [];
  for (const front of mergedFronts) {
    if (survivors.length + front.length <= population.length) {
      survivors.push(...front);
      continue;
    }
    const room = population.length - survivors.length;
    const frontObjectives = front.map((i) => mergedObjectives[i]!);
    const distances = crowdingDistance(frontObjectives);
    const ordered = front
      .map((i, k) => ({ i, d: distances[k]! }))
      .sort((a, b) => b.d - a.d || a.i - b.i);
    for (let k = 0; k < room; k += 1) survivors.push(ordered[k]!.i);
    break;
  }
  const nextPopulation = survivors.map((i) => merged[i]!);
  const nextObjectives = survivors.map((i) => mergedObjectives[i]!);
  const fronts = fastNonDominatedSort(nextObjectives);
  void m; // m 仅供校验口径（维数一致性）
  return { population: nextPopulation, objectiveValues: nextObjectives, fronts, evaluations: 2 * population.length };
}

// ─────────────────────────── 多代主循环 ───────────────────────────

/** runNSGA2 配置 */
export interface RunNsga2Config<T> extends Nsga2Operators<T> {
  /** 初始种群（决定 N；之后每代 (μ+λ) 截断回 N） */
  initial: T[];
  /** 进化代数（≥ 1） */
  gens: number;
  /** PRNG 种子（内部 mulberry32；缺省 20261001） */
  seed?: number;
  /** 2 维参考点（给定则逐代记录超体积历史；要求目标恰 2 维） */
  referencePoint?: [number, number];
}

/** 每代快照 */
export interface Nsga2GenerationSnapshot {
  gen: number;
  /** 该代种群 2 维超体积（referencePoint 给定时才有意义） */
  hypervolume?: number;
  /** 第 1 层（帕累托前沿）个体数 */
  frontSize: number;
}

/** runNSGA2 结果 */
export interface RunNsga2Result<T> extends Nsga2StepResult<T> {
  history: Nsga2GenerationSnapshot[];
  evaluations: number;
  seed: number;
}

/**
 * NSGA-II 多代运行: 逐代 nsga2Step；给定 referencePoint 时逐代记录
 * hypervolume2D（单调不减期望来自 μ+λ 精英——理论上界，实证见验证脚本①）。
 * 同 (initial, seed) 逐位复现。
 */
export function runNSGA2<T>(config: RunNsga2Config<T>): RunNsga2Result<T> {
  if (!Array.isArray(config.initial) || config.initial.length === 0) {
    throw new Error('nsga2: runNSGA2 的 initial 须为非空数组');
  }
  if (!Number.isInteger(config.gens) || config.gens < 1) {
    throw new Error(`nsga2: gens 须为 ≥ 1 的整数（收到 ${config.gens}）`);
  }
  const seed = config.seed ?? 20261001;
  const rng = mulberry32(seed);
  const firstObjectives = config.initial.map((x) => config.objectives(x));
  const m = validateObjectives(firstObjectives, 'initial 目标向量');
  if (config.referencePoint !== undefined && m !== 2) {
    throw new Error(`nsga2: 超体积历史要求恰 2 个目标（收到 ${m} 维；多维 HV 未实现——诚实拒绝而非降级）`);
  }
  let population = [...config.initial];
  let current: Nsga2StepResult<T> = {
    population,
    objectiveValues: firstObjectives,
    fronts: fastNonDominatedSort(firstObjectives),
    evaluations: config.initial.length,
  };
  const history: Nsga2GenerationSnapshot[] = [
    {
      gen: 0,
      frontSize: current.fronts[0]?.length ?? 0,
      ...(config.referencePoint !== undefined
        ? { hypervolume: hypervolume2D(current.objectiveValues, config.referencePoint) }
        : {}),
    },
  ];
  let evaluations = current.evaluations;
  for (let g = 1; g <= config.gens; g += 1) {
    current = nsga2Step({ population, objectives: config.objectives, crossover: config.crossover, mutation: config.mutation, rng });
    population = current.population;
    evaluations += current.evaluations;
    history.push({
      gen: g,
      frontSize: current.fronts[0]?.length ?? 0,
      ...(config.referencePoint !== undefined
        ? { hypervolume: hypervolume2D(current.objectiveValues, config.referencePoint) }
        : {}),
    });
  }
  return { ...current, history, evaluations, seed };
}

/* ── 接线建议 ──
 * 挂载引擎: model-scheduler（模型调度器）——「质量-成本-延迟」三目标从
 *   加权拍脑袋升级为真 Pareto 前沿: objectives = [风险调整错误率, 单次
 *   调用成本, P95 延迟]（全最小化），候选 = 模型 × 参数档组合；决策引擎
 *   拿到的是前沿点集（(quality, cost, latency) 三元组菜单），按场景
 *   （突发流量 → 延迟档；夜间批处理 → 成本档）在前沿上选点——边际权衡
 *   「多花 2 分钱省多少毫秒」直接从前沿相邻点读出，不再隐式依赖权重。
 * 建议方法: modelScheduler.attachParetoFront(options?)——options:
 *   { popSize, gens, crossover, mutation, seed, refreshPolicy }；前沿
 *   只读输出（决策引擎只消费不动），调度主路径零介入。
 * 缺省关闭旗标: config.kernels.paretoFrontEnabled = false（未开启时
 *   调度器加权评分路径与现状逐位一致——零介入）。
 * 互补关系（谁在前沿、谁在铺开）:
 *   - 与 14.0 QD: QD 在行为空间保流派（结果维多样性），本内核在目标
 *     空间保权衡档（帕累托多样性）——调度器要前沿，策略进化器要地图；
 *   - 与 44.0 公平分配: 前沿给出「可分蛋糕的形状」，注水算法在给定
 *     形状下分蛋糕——先 67.0 后 44.0 的流水线；
 *   - 与 66.0 SA: 单目标全局逃逸 vs 多目标前沿维持——随机优化双件套，
 *     SA 的能量函数可取「NSGA-II 前沿上某加权视图」做单点深挖。
 * 决策点:
 *   - HV 作调度健康度: 前沿 HV 随观测数据刷新的增益低于阈值 → 目标
 *     结构稳定，可降进化频率（任意时刻可停的读出与 8.0 元推理同族）；
 *   - 超体积参考点: 取「三目标各自的最差可接受档」，参考点移动 =
 *     场景切换信号（与 25.0 容量规划的目标等待时间同口径）；
 *   - 降级门: 目标评估含噪声（观测型目标）时，前沿点先经 23.0 稳健
 *     统计清洗再入种群——不干净的目标不配支配关系。
 */
