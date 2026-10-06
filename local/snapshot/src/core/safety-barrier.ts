/**
 * 87.0 安全屏障内核 —— 离散时间控制屏障函数（CBF）安全滤波：逐动作的微分安全
 *
 * 动机: 安全总督是**熔断级**——异常时拉闸、降级、回滚，粒度是「事件」。但自主
 * 执行的日常是**连续的**: 引擎每个决策周期都输出「动作」（并发数、限流值、重试
 * 数、预算），每个动作落地前都有一个细粒度问题——「这一步会不会把安全裕度烧
 * 穿？」朴素截断（把动作钳到上下界）回答不了这个问题: 危险的是动作**方向**，
 * 不是它的模长。控制屏障函数（Ames et al. 连续 / Agrawal–Panagou 离散）给每个
 * 动作一道微分级防线: 期望动作 u_des 尽量保留，仅当屏障条件不满足时做**最小
 * 修改**; 无可行修改时诚实拒绝（infeasible + 最小违反量）——绝不静默截断。
 *
 * 数学:
 *   安全集 C = {x : h(x) ≥ 0}（h = 安全裕度函数: 位置余量/预算余量/水位时限）。
 *   离散屏障条件: h(x_{k+1}) ≥ (1−η)·h(x_k)，η ∈ (0,1]。
 *   归纳安全（一步条件 ⟹ 全程安全）: h_k ≥ (1−η)^k·h_0 > 0 对任意 k 成立——
 *     任何 η 都给出几何下界（永不触零）; η 小 = 每步须保留更多裕度 = 保守，
 *     η→1 = 允许指数衰减逼近零（最宽松，但仍不触零）。η 是「裕度消耗率」旋钮。
 *   安全滤波（QP-lite）: u = argmin ‖u − u_des‖ s.t. h(f(x,u)) ≥ (1−η)·h(x)，
 *     一维动作: 扫描 + 符号二分精确到机器精度（边界点 1e-15 量级）;
 *     多维动作: 网格枚举 QP-lite（行序确定，平局取先遇者——可复现）。
 *   无可行 → 诚实拒绝: 返回 infeasible + 最小违反量
 *     minViolation = (1−η)·h(x) − max_u h(f(x,u)) > 0（以及最优努力 u）——
 *     上层（安全总督）拿到的是「差多少」而非被粉饰过的截断值。
 *   刹车屏障（双积分器工厂）: h(p,v) = (p_obs − p) − max(v,0)²/(2b)——
 *     剩余距离减去刹车距离（v>0 时）。精确代数性质: u = −b 一步作用下
 *     h(f(x,−b)) = h(x) **恒等**（展开式两项相消），故 aMin ≤ −b 时
 *     g(uMin) = η·h(x) ≥ 0——h ≥ 0 处滤波器**永不** infeasible（证书闭环:
 *     刹车容量以内，屏障条件总有解）。执行器弱于证书假设（|aMin| < b）时
 *     死角诚实暴露（验证锚点③的构造）。
 *
 * 验证锚点（scripts/verify-execution-kernels.mjs）:
 *   ① 闭环安全: 贪婪危险策略（持续满加速）+ 12 种子扰动下 CBF 滤波全程
 *      h ≥ 0（0 违反、0 infeasible）; 朴素截断对照在某些速度下越界
 *      （构造违反例 ≥ 1 个，诚实展示差异）; 安全策略下滤波零修改（不保守）;
 *   ② 最小修改性: cbfFilter 输出 = 安全集中距 u_des 最近者（20001 点一维
 *      网格枚举精确对照，含可行域内部=零修改/边界=二分精确两档）;
 *   ③ 无可行死角: 无刹车执行器（aMin = 0）高速场景 → infeasible + 最小
 *      违反量 = (1−η)h₀ − h(f(x,0)) 精确断言（构造值 0.805）;
 *   ④ 屏障裕度随 η 单调: η ∈ {0.05,0.2,0.4,0.6} 扫描 min-h 非降
 *      （η 小 → 保守 → 裕度大; 方向断言 + 全程安全）; 2D 动作网格 QP-lite
 *      与暴力枚举逐位一致（含平局规则）。
 *
 * 确定性: 随机源仅文件内 mulberry32(seed)（闭环仿真的策略扰动; 配 Box–Muller
 *   gaussianNoise 供挂载侧同源高斯噪声复用）; 无 I/O、无时钟、同输入同输出。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 确定性 PRNG ───────────────────────────

/** mulberry32——闭环仿真策略扰动的唯一随机源（同 seed 逐位复现） */
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

/** Box–Muller 标准正态（本内核闭环仿真仅用均匀流; 导出供挂载侧共享随机口径） */
export function gaussianNoise(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** 违反判定容差（浮点消去的尘埃口径; 与 35.0/54.0 内核证书同量级哲学） */
export const BARRIER_VIOLATION_TOL = 1e-9;

// ─────────────────────────── 屏障规格与滤波 ───────────────────────────

/**
 * 屏障规格: h（安全裕度）、dynamics（离散动力学 x_{k+1} = f(x,u)）、
 * η（每步裕度消耗率 ∈ (0,1]）、动作箱约束 [uMin,uMax]。
 */
export interface BarrierSpec {
  /** 安全裕度函数 h: C = {x : h(x) ≥ 0}（须返回有限数） */
  readonly h: (x: readonly number[]) => number;
  /** ∇h（可选; 提供时作为一阶展开候选种子参与搜索——仍以精确 h 验收） */
  readonly gradH?: (x: readonly number[]) => number[];
  /** 离散动力学 x_{k+1} = f(x,u)（须返回与 x 同长的有限数数组） */
  readonly dynamics: (x: readonly number[], u: readonly number[]) => number[];
  /** 屏障衰减率 η ∈ (0,1]: 条件 h(x') ≥ (1−η)·h(x); η 小 = 保守 */
  readonly eta: number;
  /** 动作下界（标量广播或逐维向量） */
  readonly uMin: number | readonly number[];
  /** 动作上界（标量广播或逐维向量; 逐维 uMin < uMax） */
  readonly uMax: number | readonly number[];
  /** 网格分辨率（1D 扫描缺省 257 / 多维每维缺省 33; 多维总点数封顶 20001） */
  readonly gridResolution?: number;
}

export interface CbfResult {
  /** 落地动作（infeasible 时 = 最优努力: 最大化 h(x') 的动作） */
  u: number[];
  /** 期望动作（回显） */
  uDesired: number[];
  /** h(x)（滤波前裕度） */
  hNow: number;
  /** h(f(x,u))（滤波后下一步裕度） */
  hNext: number;
  /** 屏障余量 = hNext − (1−η)·hNow（可行时 ≥ ~0; infeasible 时 < 0） */
  margin: number;
  /** 无可行动作（诚实拒绝旗标） */
  infeasible: boolean;
  /** 最小违反量 = (1−η)h(x) − max_u h(x') > 0（仅 infeasible 时给出） */
  minViolation?: number;
  method: 'zero-modification' | '1d-bisection' | 'grid-qp-lite' | 'best-effort-1d' | 'best-effort-grid';
  /** 实际使用的扫描/网格分辨率（审计） */
  resolutionUsed: number;
}

interface NormalizedSpec {
  dim: number;
  uMin: number[];
  uMax: number[];
  eta: number;
  gridResolution: number;
  h: (x: readonly number[]) => number;
  dynamics: (x: readonly number[], u: readonly number[]) => number[];
  gradH?: (x: readonly number[]) => number[];
}

/** 规格归一化 + 全量校验（显式 throw; cbfFilter/simulateClosedLoop 共用） */
function normalizeSpec(spec: BarrierSpec, who: string): NormalizedSpec {
  if (!spec || typeof spec.h !== 'function' || typeof spec.dynamics !== 'function') {
    throw new Error(`${who}: BarrierSpec 需实现 h 与 dynamics`);
  }
  const eta = spec.eta;
  if (typeof eta !== 'number' || !(eta > 0) || !(eta <= 1)) throw new Error(`${who}: eta 需 ∈ (0,1]，收到 ${String(eta)}`);
  const asVector = (v: number | readonly number[], name: string): number[] => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error(`${who}: ${name} 需为有限数`);
      return [v];
    }
    if (!Array.isArray(v) || v.length === 0 || !v.every((d) => typeof d === 'number' && Number.isFinite(d))) {
      throw new Error(`${who}: ${name} 需为非空有限数数组`);
    }
    return [...v];
  };
  const rawMin = asVector(spec.uMin, 'uMin');
  const rawMax = asVector(spec.uMax, 'uMax');
  let dim: number;
  if (rawMin.length === 1 && rawMax.length === 1) dim = 1;
  else if (rawMin.length === rawMax.length && rawMin.length > 1) dim = rawMin.length;
  else if (rawMin.length === 1) dim = rawMax.length;
  else if (rawMax.length === 1) dim = rawMin.length;
  else throw new Error(`${who}: uMin(${rawMin.length}) 与 uMax(${rawMax.length}) 维度不匹配`);
  const uMin = new Array<number>(dim).fill(0).map((_, i) => rawMin[Math.min(i, rawMin.length - 1)]);
  const uMax = new Array<number>(dim).fill(0).map((_, i) => rawMax[Math.min(i, rawMax.length - 1)]);
  for (let i = 0; i < dim; i += 1) {
    if (!(uMin[i] < uMax[i])) throw new Error(`${who}: 需 uMin[${i}]=${uMin[i]} < uMax[${i}]=${uMax[i]}`);
  }
  const gridResolution = spec.gridResolution ?? (dim === 1 ? 257 : 33);
  if (!Number.isInteger(gridResolution) || gridResolution < 5) throw new Error(`${who}: gridResolution 需为 ≥5 的整数`);
  return { dim, uMin, uMax, eta, gridResolution, h: spec.h, dynamics: spec.dynamics, gradH: spec.gradH };
}

function validateState(x: readonly number[], who: string): void {
  if (!Array.isArray(x) || x.length === 0 || !x.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new Error(`${who}: 状态需为非空有限数数组`);
  }
}

/**
 * CBF 安全滤波: u = argmin ‖u−u_des‖ s.t. h(f(x,u)) ≥ (1−η)h(x)。
 * 一维: u_des 可行 → 零修改（精确等值）; 不可行 → 扫描定位 + 符号二分求最近
 * 边界（60 次迭代到 1e-16 量级）; 全不可行 → 黄金分割求 max h(f(x,u)) 的
 * 最优努力 + 最小违反量。多维: 行序网格 QP-lite（总点数封顶 20001）。
 */
export function cbfFilter(x: readonly number[], uDesired: number | readonly number[], spec: BarrierSpec): CbfResult {
  validateState(x, 'cbfFilter');
  const ns = normalizeSpec(spec, 'cbfFilter');
  const ud: number[] = typeof uDesired === 'number' ? [uDesired] : [...(uDesired as readonly number[])];
  if (ud.length !== ns.dim) throw new Error(`cbfFilter: uDesired 维度 ${ud.length} ≠ 控制维度 ${ns.dim}`);
  if (!ud.every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error('cbfFilter: uDesired 需为有限数');
  const xNext0 = ns.dynamics(x, ud);
  if (!Array.isArray(xNext0) || xNext0.length !== x.length || !xNext0.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new Error('cbfFilter: dynamics 须返回与状态同长的有限数数组');
  }
  const hNow = ns.h(x);
  if (typeof hNow !== 'number' || !Number.isFinite(hNow)) throw new Error('cbfFilter: h(x) 需为有限数');
  const threshold = (1 - ns.eta) * hNow;
  const hAt = (u: number[]): number => {
    const xn = ns.dynamics(x, u);
    const hv = ns.h(xn);
    if (typeof hv !== 'number' || !Number.isFinite(hv)) throw new Error('cbfFilter: h(dynamics(x,u)) 需为有限数');
    return hv;
  };

  if (ns.dim === 1) {
    const lo = ns.uMin[0];
    const hi = ns.uMax[0];
    const d0 = ud[0];
    const g = (u: number): number => hAt([u]) - threshold;
    // ── 可行域内部: u_des 本身安全 → 零修改（最保守也最不保守的一步: 不动） ──
    if (d0 >= lo && d0 <= hi && g(d0) >= 0) {
      return { u: [d0], uDesired: ud, hNow, hNext: hAt([d0]), margin: g(d0), infeasible: false, method: 'zero-modification', resolutionUsed: 0 };
    }
    // ── 扫描定位可行集（g 连续假设; 分辨率内的最近可行点作锚）──
    // R5 性能进化: 一次扫描缓存全部 g 网格值——后续候选比较复用缓存，
    // h/dynamics 求值次数减半（输出逐位不变: 比较的对象是同一批数）
    const N = ns.gridResolution;
    const step = (hi - lo) / (N - 1);
    const gridU = new Array<number>(N);
    const gridG = new Array<number>(N);
    for (let i = 0; i < N; i += 1) {
      gridU[i] = lo + (i * (hi - lo)) / (N - 1);
      gridG[i] = g(gridU[i]);
    }
    let bestFeasible = -Infinity;
    let bestGap = Infinity;
    for (let i = 0; i < N; i += 1) {
      if (gridG[i] >= 0) {
        const gap = Math.abs(gridU[i] - d0);
        if (gap < bestGap) {
          bestGap = gap;
          bestFeasible = gridU[i];
        }
      }
    }
    if (Number.isFinite(bestFeasible)) {
      // 最近可行点必在 [d0, 锚] 的边界上——符号二分到机器精度（返回可行侧）
      const clampedD = Math.min(hi, Math.max(lo, d0));
      let bFeasible = bestFeasible;
      if (g(clampedD) < 0) {
        let a = clampedD;
        let b = bestFeasible;
        for (let it = 0; it < 60; it += 1) {
          const m = (a + b) / 2;
          if (g(m) >= 0) b = m;
          else a = m;
        }
        bFeasible = b;
      }
      // 候选 = 二分边界 ∪ 全部可行扫描点（缓存值）; 取距 u_des 最近（平局优先边界——精确性）
      let chosen = bFeasible;
      let chosenGap = Math.abs(chosen - d0);
      for (let i = 0; i < N; i += 1) {
        if (gridG[i] >= 0) {
          const gap = Math.abs(gridU[i] - d0);
          if (gap < chosenGap - 1e-15) {
            chosenGap = gap;
            chosen = gridU[i];
          }
        }
      }
      return { u: [chosen], uDesired: ud, hNow, hNext: hAt([chosen]), margin: g(chosen), infeasible: false, method: '1d-bisection', resolutionUsed: N };
    }
    // ── 无可行: 最优努力（黄金分割最大化 h(x')，粗扫定支架）+ 最小违反量 ──
    let coarseBest = lo;
    let coarseBestG = gridG[0];
    for (let i = 1; i < N; i += 1) {
      if (gridG[i] > coarseBestG) {
        coarseBestG = gridG[i];
        coarseBest = gridU[i];
      }
    }
    const phi = (Math.sqrt(5) - 1) / 2;
    let gl = Math.max(lo, coarseBest - 2 * step);
    let gh = Math.min(hi, coarseBest + 2 * step);
    let c = gh - phi * (gh - gl);
    let dd = gl + phi * (gh - gl);
    for (let it = 0; it < 80; it += 1) {
      if (g(c) > g(dd)) {
        gh = dd;
        dd = c;
        c = gh - phi * (gh - gl);
      } else {
        gl = c;
        c = dd;
        dd = gl + phi * (gh - gl);
      }
    }
    const uBest = (gl + gh) / 2;
    const gBest = g(uBest);
    return {
      u: [uBest],
      uDesired: ud,
      hNow,
      hNext: hAt([uBest]),
      margin: gBest,
      infeasible: true,
      minViolation: -gBest > 0 ? -gBest : 0,
      method: 'best-effort-1d',
      resolutionUsed: N,
    };
  }

  // ── 多维: 网格 QP-lite（可行点中距 u_des 最近; 行序确定，平局取先遇者）──
  // R5 性能进化: 距离下界剪枝的分支定界。总序 = (dist², 行主序秩) 字典序——
  // 与原行主序枚举的平局规则**逐位一致**（先按距离严格更小替换，距离相等时
  // 行主序先者胜）; 每轴值按距 u_des 升序访问（前缀距离单调升 ⟹ 一旦剪枝
  // 即可 break 本轴）。剪枝条件 prefix + 尾轴下界 > bestDist（严格 >）:
  // 被剪枝的点距离**严格大于**当前最优——在原枚举中永远不会替换最优，
  // 选择结果不变; 无可行点时 bestDist = ∞ 永不剪枝 ⟹ bestEffort 全枚举不变。
  let res = ns.gridResolution;
  while (res > 5 && Math.pow(res, ns.dim) > 20001) res -= 1;
  const axes: number[][] = [];
  for (let i = 0; i < ns.dim; i += 1) {
    const axis: number[] = [];
    for (let j = 0; j < res; j += 1) axis.push(ns.uMin[i] + (j * (ns.uMax[i] - ns.uMin[i])) / (res - 1));
    axes.push(axis);
  }
  // 每轴值的访问顺序: 距 u_des 分量升序（稳定——距离相等按原下标升序）
  const orderOf: number[][] = axes.map((axis, i) =>
    axis.map((v, j) => [Math.abs(v - ud[i]), j] as [number, number]).sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0])).map((p) => p[1]),
  );
  // 轴 j 及之后的距离下界（u_des 分量在轴范围外时到最近端点的距离）
  const minDistRemain = new Array<number>(ns.dim + 1).fill(0);
  for (let j = ns.dim - 1; j >= 0; j -= 1) {
    const dv = ud[j] < ns.uMin[j] ? ns.uMin[j] - ud[j] : ud[j] > ns.uMax[j] ? ud[j] - ns.uMax[j] : 0;
    minDistRemain[j] = minDistRemain[j + 1] + dv * dv;
  }
  // 行主序秩的每轴权重（平局决胜用——与原枚举次序一致）
  const rankStride: number[] = new Array<number>(ns.dim).fill(1);
  for (let j = ns.dim - 2; j >= 0; j -= 1) rankStride[j] = rankStride[j + 1] * res;
  let bestFeasible: number[] | null = null;
  let bestDist = Infinity;
  let bestRank = Infinity;
  let bestG: number[] | null = null;
  let bestGv = -Infinity;
  const enumerate = (u: number[], rank: number): void => {
    const gv = hAt(u) - threshold;
    if (gv >= 0) {
      let dist = 0;
      for (let i = 0; i < ns.dim; i += 1) dist += (u[i] - ud[i]) * (u[i] - ud[i]);
      if (dist < bestDist || (dist === bestDist && rank < bestRank)) {
        bestDist = dist;
        bestRank = rank;
        bestFeasible = [...u];
      }
    }
    if (gv > bestGv) {
      bestGv = gv;
      bestG = [...u];
    }
  };
  const walk = (i: number, u: number[], prefixDist: number, prefixRank: number): void => {
    if (i === ns.dim) {
      enumerate(u, prefixRank);
      return;
    }
    for (const j of orderOf[i]) {
      const d = axes[i][j] - ud[i];
      const pd = prefixDist + d * d;
      if (pd + minDistRemain[i + 1] > bestDist) break; // 本轴按距离升序 ⟹ 后续更远，整枝剪掉
      u.push(axes[i][j]);
      walk(i + 1, u, pd, prefixRank + j * rankStride[i]);
      u.pop();
    }
  };
  walk(0, [], 0, 0);
  if (bestFeasible !== null) {
    const chosen = bestFeasible!;
    return { u: chosen, uDesired: ud, hNow, hNext: hAt(chosen), margin: hAt(chosen) - threshold, infeasible: false, method: 'grid-qp-lite', resolutionUsed: res };
  }
  const bestEffort = bestG!;
  return {
    u: bestEffort,
    uDesired: ud,
    hNow,
    hNext: hAt(bestEffort),
    margin: bestGv,
    infeasible: true,
    minViolation: -bestGv > 0 ? -bestGv : 0,
    method: 'best-effort-grid',
    resolutionUsed: res,
  };
}

// ══════════════════════ R5 进化（第五轮·世界性进化） ══════════════════════
//
// 轴 1（数学）: 多屏障合取（多个 h 的安全交集）。
//   k 个屏障 h₁…h_k（各自 η_i、动力学 f_i、箱约束），安全集 = 交集
//   C = ⋂ᵢ {x : hᵢ(x) ≥ 0}。合取滤波:
//     u = argmin ‖u − u_des‖  s.t.  hᵢ(fᵢ(x,u)) ≥ (1−ηᵢ)·hᵢ(x) ∀i。
//   一步条件对**每个** i 同时成立 ⟹ 归纳法逐屏障生效 ⟹ 全程 hᵢ ≥ 0 ∀i
//   （前向不变性的合取版本）。实现（一维动作）:
//     · 动作箱 = 各屏障箱的交集 [max uMinᵢ, min uMaxᵢ];
//     · 候选 = u_des（全可行时零修改）∪ 每屏障二分边界 ∪ 共享网格点，
//       在全部条件下可行的候选中取距 u_des 最近（确定性平局: 先出者胜）;
//     · 交集空 → 诚实 infeasible + minViolation = maxᵢ 缺口（最坏屏障差多少）。
//   语义: 「预算红线」与「延迟红线」双屏障下，动作要同时不穿透任何一条——
//   单屏障滤波器串联做不到（各自最优修改可能互相破坏），合取一步到位。
//
// 轴 4（性质）: 前向不变性——种子化 ≥200 个随机初态 + 随机扰动危险策略下，
//   合取滤波全程 hᵢ(xₜ) ≥ −tol ∀i（归纳证书的仿真读数）; 每屏障单独具备
//   刹车容量（aMin ≤ −bᵢ）时合取**永不** infeasible（递归可行性）。
// ══════════════════════════════════════════════════════════

/** 多屏障合取滤波结果 */
export interface ConjunctionResult {
  /** 落地动作（infeasible 时 = 最优努力: 最大化最坏屏障余量） */
  u: number[];
  uDesired: number[];
  /** 各屏障 hᵢ(x)（滤波前裕度） */
  hNow: number[];
  /** 各屏障 hᵢ(fᵢ(x,u))（滤波后下一步裕度） */
  hNext: number[];
  /** 各屏障余量 hNextᵢ − (1−ηᵢ)·hNowᵢ（可行时全部 ≥ ~0） */
  margins: number[];
  /** minᵢ margins（最紧屏障的读数） */
  worstMargin: number;
  infeasible: boolean;
  /** 无可行时的最小违反量 = maxᵢ[(1−ηᵢ)hᵢ(x) − max_u min_j 条件缺口]（>0） */
  minViolation?: number;
  /** 余量贴 tol 内的屏障数（哪条红线在勒） */
  bindingCount: number;
  resolutionUsed: number;
}

/**
 * 多屏障合取 CBF 滤波（一维动作）: k 个 BarrierSpec 的安全交集上的
 * 最小修改。全部 spec 须为一维; 动作箱取交集。确定性（网格 + 每屏障
 * 二分边界候选、先出者胜的平局规则）。
 */
export function cbfFilterConjunction(x: readonly number[], uDesired: number | readonly number[], specs: readonly BarrierSpec[]): ConjunctionResult {
  validateState(x, 'cbfFilterConjunction');
  if (!Array.isArray(specs) || specs.length === 0) throw new Error('cbfFilterConjunction: specs 需为非空 BarrierSpec 数组');
  const nsList = specs.map((s, i) => normalizeSpec(s, `cbfFilterConjunction: specs[${i}]`));
  for (let i = 0; i < nsList.length; i += 1) {
    if (nsList[i].dim !== 1) throw new Error(`cbfFilterConjunction: specs[${i}] 需为一维动作（dim=1）`);
  }
  const ud: number[] = typeof uDesired === 'number' ? [uDesired] : [...(uDesired as readonly number[])];
  if (ud.length !== 1 || typeof ud[0] !== 'number' || !Number.isFinite(ud[0])) throw new Error('cbfFilterConjunction: uDesired 需为一维有限数');
  const lo = Math.max(...nsList.map((s) => s.uMin[0]));
  const hi = Math.min(...nsList.map((s) => s.uMax[0]));
  if (!(lo < hi)) throw new Error(`cbfFilterConjunction: 动作箱交集为空（[${lo}, ${hi}]）`);
  const k = nsList.length;
  const hNow = nsList.map((s) => s.h(x));
  for (let i = 0; i < k; i += 1) {
    if (!Number.isFinite(hNow[i])) throw new Error(`cbfFilterConjunction: specs[${i}].h(x) 需为有限数`);
  }
  const threshold = nsList.map((s, i) => (1 - s.eta) * hNow[i]);
  const gOf = (i: number, u: number): number => {
    const xn = nsList[i].dynamics(x, [u]);
    const hv = nsList[i].h(xn);
    if (typeof hv !== 'number' || !Number.isFinite(hv)) throw new Error(`cbfFilterConjunction: specs[${i}].h(dynamics(x,u)) 需为有限数`);
    return hv - threshold[i];
  };
  const allFeasibleAt = (u: number): boolean => {
    for (let i = 0; i < k; i += 1) if (gOf(i, u) < 0) return false;
    return true;
  };
  const N = Math.min(...nsList.map((s) => s.gridResolution ?? 257));
  const gridU = new Array<number>(N);
  for (let j = 0; j < N; j += 1) gridU[j] = lo + (j * (hi - lo)) / (N - 1);
  const d0 = ud[0];

  // ── 可行域内部（全部条件满足）: 零修改 ──
  if (d0 >= lo && d0 <= hi && allFeasibleAt(d0)) {
    return {
      u: [d0],
      uDesired: ud,
      hNow,
      hNext: nsList.map((s) => s.h(s.dynamics(x, [d0]))),
      margins: nsList.map((_, i) => gOf(i, d0)),
      worstMargin: Math.min(...nsList.map((_, i) => gOf(i, d0))),
      infeasible: false,
      bindingCount: nsList.map((_, i) => gOf(i, d0)).filter((m) => m < 1e-9).length,
      resolutionUsed: 0,
    };
  }

  // ── 每屏障的最近可行边界（扫描锚 + 符号二分到机器精度）与共享网格缓存 ──
  const gridG: number[][] = nsList.map(() => new Array<number>(N));
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < N; j += 1) gridG[i][j] = gOf(i, gridU[j]);
  }
  const candidates: number[] = [Math.min(hi, Math.max(lo, d0))];
  for (let i = 0; i < k; i += 1) {
    let anchor = NaN;
    let anchorGap = Infinity;
    for (let j = 0; j < N; j += 1) {
      if (gridG[i][j] >= 0) {
        const gap = Math.abs(gridU[j] - d0);
        if (gap < anchorGap) {
          anchorGap = gap;
          anchor = gridU[j];
        }
      }
    }
    if (Number.isFinite(anchor)) {
      const clampedD = Math.min(hi, Math.max(lo, d0));
      let a = clampedD;
      let b = anchor;
      if (gOf(i, clampedD) < 0) {
        for (let it = 0; it < 60; it += 1) {
          const m = (a + b) / 2;
          if (gOf(i, m) >= 0) b = m;
          else a = m;
        }
      }
      candidates.push(b);
    }
  }
  let chosen: number | undefined;
  let chosenGap = Infinity;
  for (const c of candidates) {
    if (allFeasibleAt(c)) {
      const gap = Math.abs(c - d0);
      if (gap < chosenGap) {
        chosenGap = gap;
        chosen = c;
      }
    }
  }
  for (let j = 0; j < N; j += 1) {
    if (gridG.every((row) => row[j] >= 0)) {
      const gap = Math.abs(gridU[j] - d0);
      if (gap < chosenGap - 1e-15) {
        chosenGap = gap;
        chosen = gridU[j];
      }
    }
  }
  if (chosen !== undefined) {
    const u = chosen;
    const margins = nsList.map((_, i) => gOf(i, u));
    return {
      u: [u],
      uDesired: ud,
      hNow,
      hNext: nsList.map((s) => s.h(s.dynamics(x, [u]))),
      margins,
      worstMargin: Math.min(...margins),
      infeasible: false,
      bindingCount: margins.filter((m) => m < 1e-9).length,
      resolutionUsed: N,
    };
  }

  // ── 交集空: 最优努力 = 最大化最坏余量 minᵢ gᵢ（粗扫 + 黄金分割细化）──
  const worstAt = (u: number): number => {
    let worst = Infinity;
    for (let i = 0; i < k; i += 1) {
      const gi = gOf(i, u);
      if (gi < worst) worst = gi;
    }
    return worst;
  };
  let coarseBest = gridU[0];
  let coarseBestW = -Infinity;
  for (let j = 0; j < N; j += 1) {
    let w = Infinity;
    for (let i = 0; i < k; i += 1) if (gridG[i][j] < w) w = gridG[i][j];
    if (w > coarseBestW) {
      coarseBestW = w;
      coarseBest = gridU[j];
    }
  }
  const step = (hi - lo) / (N - 1);
  const phi = (Math.sqrt(5) - 1) / 2;
  let gl = Math.max(lo, coarseBest - 2 * step);
  let gh = Math.min(hi, coarseBest + 2 * step);
  let c = gh - phi * (gh - gl);
  let dd = gl + phi * (gh - gl);
  for (let it = 0; it < 80; it += 1) {
    if (worstAt(c) > worstAt(dd)) {
      gh = dd;
      dd = c;
      c = gh - phi * (gh - gl);
    } else {
      gl = c;
      c = dd;
      dd = gl + phi * (gh - gl);
    }
  }
  const uBest = (gl + gh) / 2;
  const wBest = worstAt(uBest);
  const margins = nsList.map((_, i) => gOf(i, uBest));
  return {
    u: [uBest],
    uDesired: ud,
    hNow,
    hNext: nsList.map((s) => s.h(s.dynamics(x, [uBest]))),
    margins,
    worstMargin: wBest,
    infeasible: true,
    minViolation: -wBest > 0 ? -wBest : 0,
    bindingCount: margins.filter((m) => m < 1e-9).length,
    resolutionUsed: N,
  };
}

// ─────────────────────────── 刹车屏障工厂（双积分器） ───────────────────────────

/** 双积分器刹车屏障配置 */
export interface BrakeConfig {
  /** 障碍物位置 p_obs（缺省 10） */
  obstaclePosition?: number;
  /** 离散步长 dt（缺省 0.1） */
  dt?: number;
  /** 加速度下界 aMin（缺省 −5; aMin ≤ −brakingCapacity 时 h≥0 处永不 infeasible） */
  aMin?: number;
  /** 加速度上界 aMax（缺省 2） */
  aMax?: number;
  /** 证书假设的刹车容量 b > 0（缺省 5; h 的「刹车距离」用它折算） */
  brakingCapacity?: number;
  /** 屏障 η（缺省 0.6） */
  eta?: number;
}

export interface BrakeBarrier {
  spec: BarrierSpec;
  obstaclePosition: number;
  dt: number;
  aMin: number;
  aMax: number;
  brakingCapacity: number;
  /** h(p,v)（诊断直通） */
  h: (x: readonly number[]) => number;
}

/**
 * 双积分器刹车屏障: 状态 x = [p, v]（位置/速度），动作 u = [a]（加速度），
 * 精确离散动力学 p' = p + v·dt + ½u·dt²，v' = v + u·dt。
 * h(p,v) = (p_obs − p) − max(v,0)²/(2b)——剩余距离 − 刹车距离。
 * 代数恒等式: u = −b 时 h(f(x,u)) = h(x)（两项相消），机器精度可验。
 */
export function brakeDoubleIntegrator(config?: BrakeConfig): BrakeBarrier {
  const obstaclePosition = config?.obstaclePosition ?? 10;
  const dt = config?.dt ?? 0.1;
  const aMin = config?.aMin ?? -5;
  const aMax = config?.aMax ?? 2;
  const brakingCapacity = config?.brakingCapacity ?? 5;
  const eta = config?.eta ?? 0.6;
  if (!Number.isFinite(obstaclePosition)) throw new Error('brakeDoubleIntegrator: obstaclePosition 需为有限数');
  if (!(dt > 0) || !Number.isFinite(dt)) throw new Error('brakeDoubleIntegrator: dt 需 > 0');
  if (!(aMin < aMax) || !Number.isFinite(aMin) || !Number.isFinite(aMax)) throw new Error('brakeDoubleIntegrator: 需 aMin < aMax');
  if (!(brakingCapacity > 0)) throw new Error('brakeDoubleIntegrator: brakingCapacity 需 > 0');
  if (!(eta > 0 && eta <= 1)) throw new Error('brakeDoubleIntegrator: eta 需 ∈ (0,1]');
  const h = (x: readonly number[]): number => {
    const [p, v] = x;
    return obstaclePosition - p - (v > 0 ? (v * v) / (2 * brakingCapacity) : 0);
  };
  const dynamics = (x: readonly number[], u: readonly number[]): number[] => {
    const [p, v] = x;
    const a = u[0];
    return [p + v * dt + 0.5 * a * dt * dt, v + a * dt];
  };
  const spec: BarrierSpec = { h, dynamics, eta, uMin: [aMin], uMax: [aMax] };
  return { spec, obstaclePosition, dt, aMin, aMax, brakingCapacity, h };
}

// ─────────────────────────── 闭环仿真与违反报告 ───────────────────────────

/** 闭环策略: 读状态与步号，输出期望动作（滤波前; 随机策略用 rng 保持可复现） */
export type ClosedLoopPolicy = (x: number[], t: number, rng: () => number) => number | number[];

export interface ClosedLoopStep {
  t: number;
  /** 本步开始时的状态 x_k */
  x: number[];
  /** 本步后的状态 x_{k+1} */
  xNext: number[];
  uDesired: number[];
  uApplied: number[];
  hBefore: number;
  hNext: number;
  /** hNext − (1−η)·hBefore（CBF 模式下 ≥ ~0; clamp-only 模式下可为负——这就是越界） */
  margin: number;
  infeasible: boolean;
  method: string;
}

export interface ClosedLoopResult {
  steps: number;
  trajectory: ClosedLoopStep[];
  /** 全程（含初值）最小 h */
  hMin: number;
  /** h(x_{k+1}) < −tol 的步号清单（tol = BARRIER_VIOLATION_TOL） */
  violationSteps: number[];
  /** 滤波器报告 infeasible 的步数（CBF 模式才可能 > 0） */
  infeasibleCount: number;
  finalX: number[];
  /** 滤波模式回显 */
  filter: 'cbf' | 'clamp-only';
}

export interface SimulateOptions {
  /**
   * 'cbf'（缺省）: 每步过 cbfFilter;
   * 'clamp-only': 朴素截断对照——只把动作钳到 [uMin,uMax] 不过屏障
   * （验证锚点①的对照组: 该模式下越界是**预期行为**，诚实记录）。
   */
  filter?: 'cbf' | 'clamp-only';
}

function clampVector(u: number[], uMin: number[], uMax: number[]): number[] {
  return u.map((v, i) => Math.min(uMax[i], Math.max(uMin[i], v)));
}

/**
 * 闭环仿真: 状态按真实动力学演化，策略只给**期望**动作，落地前逐动作过滤。
 * 同 seed 同轨迹（mulberry32 是唯一随机源）。
 */
export function simulateClosedLoop(
  x0: readonly number[],
  policy: ClosedLoopPolicy,
  spec: BarrierSpec,
  T: number,
  seed?: number,
  options?: SimulateOptions,
): ClosedLoopResult {
  validateState(x0, 'simulateClosedLoop');
  if (typeof policy !== 'function') throw new Error('simulateClosedLoop: policy 需为函数');
  if (!Number.isInteger(T) || T < 0) throw new Error(`simulateClosedLoop: T 需为非负整数，收到 ${String(T)}`);
  const ns = normalizeSpec(spec, 'simulateClosedLoop');
  const filter = options?.filter ?? 'cbf';
  if (filter !== 'cbf' && filter !== 'clamp-only') throw new Error(`simulateClosedLoop: filter 需为 'cbf'|'clamp-only'，收到 ${String(filter)}`);
  const rng = mulberry32(seed ?? 1);
  let x = [...x0];
  const trajectory: ClosedLoopStep[] = [];
  const violationSteps: number[] = [];
  let hMin = ns.h(x);
  if (!Number.isFinite(hMin)) throw new Error('simulateClosedLoop: h(x0) 需为有限数');
  let infeasibleCount = 0;
  for (let t = 0; t < T; t += 1) {
    const hBefore = ns.h(x);
    const rawU = policy([...x], t, rng);
    const uDesired = typeof rawU === 'number' ? [rawU] : [...(rawU as number[])];
    if (uDesired.length !== ns.dim || !uDesired.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new Error(`simulateClosedLoop: policy(t=${t}) 返回非法动作（需 ${ns.dim} 维有限数）`);
    }
    let uApplied: number[];
    let margin: number;
    let infeasible = false;
    let method: string;
    if (filter === 'cbf') {
      const r = cbfFilter(x, uDesired, spec);
      uApplied = r.u;
      margin = r.margin;
      infeasible = r.infeasible;
      method = r.method;
      if (infeasible) infeasibleCount += 1;
    } else {
      uApplied = clampVector(uDesired, ns.uMin, ns.uMax);
      const hAfter = ns.h(ns.dynamics(x, uApplied));
      margin = hAfter - (1 - ns.eta) * hBefore;
      method = 'clamp-only';
    }
    const xNext = ns.dynamics(x, uApplied);
    if (!Array.isArray(xNext) || !xNext.every((v) => Number.isFinite(v))) throw new Error(`simulateClosedLoop: dynamics(t=${t}) 返回非有限状态`);
    const hAfter = ns.h(xNext);
    if (hAfter < hMin) hMin = hAfter;
    if (hAfter < -BARRIER_VIOLATION_TOL) violationSteps.push(t);
    trajectory.push({ t, x: [...x], xNext: [...xNext], uDesired: [...uDesired], uApplied: [...uApplied], hBefore, hNext: hAfter, margin, infeasible, method });
    x = [...xNext];
  }
  return { steps: T, trajectory, hMin, violationSteps, infeasibleCount, finalX: [...x], filter };
}

/** 违反报告: 一步条件如何被破坏的诚实读数（喂给安全总督的升级载荷） */
export interface ViolationReport {
  steps: number;
  /** 违反步数（h(x_{k+1}) < −tol） */
  violations: number;
  /** 全程最小 h（负值即穿透深度） */
  hMin: number;
  /** 最小 h 出现的步号（无轨迹时 −1） */
  worstStep: number;
  /** 最坏屏障余量（hNext − (1−η)hBefore 的最小值） */
  worstMargin: number;
  infeasibleCount: number;
  /** violations === 0 且 infeasibleCount === 0 */
  safe: boolean;
  tolerance: number;
}

export function violationReport(run: ClosedLoopResult): ViolationReport {
  if (!run || !Array.isArray(run.trajectory)) throw new Error('violationReport: 需传入 simulateClosedLoop 的返回值');
  // 最小 h 的**首个**出现步（含初值口径: run.hMin 已含 h(x₀)，worstStep 指向轨迹内）
  let worstStep = -1;
  let minH = Infinity;
  let worstMargin = Infinity;
  for (let i = 0; i < run.trajectory.length; i += 1) {
    if (run.trajectory[i].hNext < minH) {
      minH = run.trajectory[i].hNext;
      worstStep = i;
    }
    if (run.trajectory[i].margin < worstMargin) worstMargin = run.trajectory[i].margin;
  }
  const hMin = run.trajectory.length === 0 ? run.hMin : Math.min(run.hMin, minH);
  return {
    steps: run.steps,
    violations: run.violationSteps.length,
    hMin,
    worstStep,
    worstMargin: Number.isFinite(worstMargin) ? worstMargin : 0,
    infeasibleCount: run.infeasibleCount,
    safe: run.violationSteps.length === 0 && run.infeasibleCount === 0,
    tolerance: BARRIER_VIOLATION_TOL,
  };
}

/* ── 接线建议 ──
 * 建议挂载引擎: 任务执行器的逐动作安全过滤层（引擎任何「动作」落地前的
 * 微分安全关卡）——与安全总督构成两级: 总督是熔断级（事件驱动的拉闸/降级/
 * 回滚），屏障是微分级（逐动作连续修正），前者管「停不停」，后者管「这一步
 * 怎么改」。
 *   1. 动作屏障化: 引擎输出的动作向量（并发上限、每秒限流、重试次数、
 *      本轮预算）先过 cbfFilter 再落地。BarrierSpec 的 h 取运维安全裕度:
 *      h₁ = 配额余量 − 当前消耗速率的「刹车距离」（消耗速率²/(2·减速容量)，
 *      与刹车屏障同构——预算也要能在红线前刹得住）; h₂ = 队列水位到红线的
 *      时间余量; dynamics = 动作对裕度的一阶/二阶预测模型。uMin/uMax 即
 *      各动作的运维箱约束（原钳位边界直接复用为箱，屏障条件叠加其上）。
 *   2. η 旋钮 = 裕度消耗率: 关键配额（预算/合规）用小 η（每步保留 95%+，
 *      逼近前向不变）; 可再生资源（并发/缓存）用大 η（允许指数逼近但永不
 *      触零）。方向: η 小 = 保守 = 提前刹车（验证锚点④的单调读数即调参依据）。
 *   3. infeasible 的升级语义: 滤波器返回 infeasible + minViolation = 「即便
 *      最优努力仍差多少」——此时禁止静默截断，必须上报安全总督走熔断路径
 *      （降级/暂停/人工），minViolation 是给总督的定量载荷（差 5% 和差 50%
 *      的处置不同）。这是本内核与朴素钳位的本质差异（锚点①③的构造演示）。
 *   4. 与 86.0 分层技能内核的关系: 86 给任务执行器的宏动作（DAG 节点=option）
 *      做时间信用分配，87 给每个动作（含宏内的原步）做安全过滤——
 *      「敢做」与「不越界」正交，双件套合体即自主执行轴。
 *   5. 缺省关闭旗标名: enableSafetyBarrierKernel（缺省 false; 关闭时动作
 *      走原钳位路径，行为逐位一致——纯分析内核零介入）。
 *   6. 挂载后改变的决策点: ① 动作落地（钳位 → 最小安全修改）; ② 越界处置
 *      （静默截断 → infeasible 上报总督）; ③ 运维参数（静态上限 → η +
 *      裕度函数的显式安全语义）。运行时账单: 每步 margin/方法名可审计
 *      （violationReport 即巡检报表）。
 * 未挂载（旗标 false）时以上决策点全部走原路径——行为逐位一致（零漂移）。
 */
