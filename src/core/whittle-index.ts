/**
 * 53.0 Whittle 指数内核 —— 不休眠多臂老虎机（RMAB）的一阶松弛调度指数
 *
 * 动机: 21.0 Gittins 指数是最优的，但它的成立前提是「不选的臂冻结演化」——真实调度
 * 里落选的租户/任务并不会暂停：SLA 持续恶化、故障自愈、队列积压增长。落选臂仍在
 * 转移的「不休眠」多臂老虎机（Restless MAB）最优策略是 PSPACE-hard（Papadimitriou
 * & Tsitsiklis 1994 的均义项即已难解），Whittle（1988）的一阶松弛是事实标准：
 * 把「每步恰选 k 个」松弛为「每步平均选 k 个」，每臂独立引入被动补贴 λ 解单臂
 * 补贴 MDP，状态 s 的 Whittle 指数 W(s) = 使主动/被动无差异的 λ；n→∞、k/n 固定时
 * 指数策略渐近最优（Weber–Weiss 1990）。本内核是 21.0 的「不休眠」姊妹篇。
 *
 * 数学（两态臂 {0=bad, 1=good}；转移行向量 P^a/P^p；收益只在 good 态）:
 *   补贴 MDP:  V_λ(s) = max{ R^a(s) + γ·Σ_j P^a[s][j]·V_λ(j),
 *                             R^p(s) + λ + γ·Σ_j P^p[s][j]·V_λ(j) }
 *   其中 R^a(good)=activeReward、R^p(good)=passiveReward（缺省 0）、bad 态两者为 0。
 *   指数:  W(s) = sup{ λ : 主动在 s 最优 }，对 λ 二分（收敛容差 1e-6，区间宽为审计
 *   口径随结果返回）；内层补贴 MDP 的解（R5 升级，见下）由**策略迭代精确求解**。
 *   可索引性（indexability）: 被动最优集 S(λ) = {s : 被动在 s 最优} 必须随 λ 单调
 *   不减，指数才有「无差异阈值」语义——本内核显式扫描 λ 网格检查并诚实上报违反者。
 *
 * ── R5 进化(第五轮, 2026-10) ──────────────────────────────────────────────
 * A1/A2【数学+性能】补贴 MDP 的策略迭代精确解（替换值迭代近似）:
 *   两态 × 两动作只有 4 个确定性平稳策略, 每个策略的值函数是 (I−γP^π)V = r^π_λ
 *   的**精确线性代数解**（2×2 闭式 Cramer; I−γP^π 对角占优恒可逆）。策略迭代
 *   从双主动起步, 每轮「精确评估 + 贪心改进」, 策略空间有限 + 改进严格单调
 *   （标准定理: 要么策略不变终止, 要么值逐点严格提升）⟹ ≤4 轮内精确终止,
 *   无残差容差、无 maxViIterations 界——与值迭代不动点同值（两者都是同一
 *   Bellman 算子的唯一不动点）, 精度从「相对残差 1e-12」升到「浮点精确」。
 *   复杂度对照: 值迭代 γ→1 时需 O(log(1/ε)/log(1/γ)) 次扫描(数万次),
 *   策略迭代 ≤4 次 O(1) 线代——二分内层每档 λ 的求解加速 ~两个数量级。
 * A3【数值稳健】被动判据的并列口径与二分谓词严格一致(passiveOptimal 用
 *   qPassive > qActive 严格大于、activePreferred 用 qActive ≥ qPassive)——
 *   精确线代消除了值迭代残差在无差异点附近翻转判据的浮点风险。
 *
 * 恒可索引性定理（本内核两态收益族的闭式保证）:
 *   若 bad 态收益与动作无关（本 API 恒为 0），则对任意转移矩阵与好态任意（可负）
 *   收益，差值函数 D_s(λ) := Q^a_λ(s) − Q^p_λ(s)（在补贴 λ 的最优价值处取值）关于
 *   λ 严格单调递减 ⟹ 每态存在唯一阈值 W(s) ⟹ 两态臂恒可索引。
 *   证明梗概: 2 态 × 2 动作只有 4 个确定性平稳策略，各策略价值是 λ 的仿射函数，
 *   V_λ = 四者逐点最大 → 凸、连续、逐段仿射；D_s(λ) = c_s − λ + γ·(P^a[s]−P^p[s])·V_λ
 *   亦逐段仿射连续。逐组合算斜率（记 δ¹(s)=P^a[s][1]−P^p[s][1] 为主动升好率增益）:
 *     · 双主动 (A,A)：补贴从不被领取，V_λ 与 λ 无关 → D 斜率 = −1；
 *     · 双被动 (P,P)：两态每步都领补贴，(I−γP^p)m=1 的唯一解 m ≡ 1/(1−γ) → ΔV 斜率 0
 *       → D 斜率 = −1；
 *     · G 被动 B 主动 (P,A)：ΔV 斜率 = 1/(1−γ+γ·a_B+γ·d_G)，其中 a_B=P^a[B][1]、
 *       d_G = 1−P^p[G][1] ≥ δ¹(G)，代回得 D_G 斜率 ≤ −1 + γ·d/(1−γ+γ·d) < 0；
 *     · G 主动 B 被动 (A,P)：对称地 |ΔV 斜率| = 1/(1−γ·a_G+γ·p_B)，代回 D 斜率
 *       需 γ·p > 1 型不等式，恒不可能。∎
 *   因此本 API 内不会出现不可索引臂（验证锚点 ② 的 100% 是定理预言，不是造假）；
 *   检查器与 nonIndexableIds 通路仍保留——API 误用或未来推广（如 bad 态动作相关
 *   收益、多态化）时如实报警，checkPassiveSetMonotonicity 对合成非单调序列的
 *   报警在验证脚本 ② 中实测。
 *
 * 验证锚点（scripts/verify-whittle-index.mjs，全部确定性断言）:
 *   ① 退化闭式: 「被动=坏态吸收、主动自愈回 good」（P^a=I、P^p[G][B]=1、R^p=0）时
 *      λ∈[γR,R] 区间最优策略 = {good 主动、bad 被动}，V(good)=R/(1−γ)、V(bad)=λ/(1−γ)，
 *      good 无差: R/(1−γ)=λ/(1−γ) ⟹ W(good)=R；bad 无差: γ·R/(1−γ)=λ/(1−γ)
 *      ⟹ W(bad)=γR；被动集序列 ∅→{bad}→{bad,good}。动作同动力学臂（P^a=P^p）:
 *      D_s = c_s − λ 与转移无关 ⟹ W(good)=R^a−R^p、W(bad)=0。
 *   ② 种子化随机参数网格 ≥200 组: 可索引性 100%（定理预言）+ 脚本侧独立 λ 扫描
 *      复核被动集与内核逐点一致 + 检查器对合成非单调序列正确报警。
 *   ③ n≤4 臂小实例: 全动作联合 MDP 精确值迭代（2ⁿ 状态 × C(n,k) 动作）对照——
 *      退化闭式族（确定性转移）上 Whittle 恰为最优（差距 0 ≤ 规格 1e-3，多种子
 *      × 全部 2ⁿ 起点态）；随机占优族上与真最优相对差距 ≤ 5%（Weber–Weiss：
 *      指数策略的最优性是 n→∞ 渐近性质，小 n 的跨臂互补性缺口如实报告）。
 *   ④ λ 二分收敛（区间宽 ≤ 1e-6）+ 无差异验证: λ=W(s) 时 |Q^a−Q^p|≈0，
 *      λ=W(s)∓2e-4 时主动/被动严格分侧。
 *   ⑤ 指数随演化速度单调: 主动自愈速度 ↑ ⟹ W(bad) ↑；被动自愈速度 ↑ ⟹ W(bad) ↓；
 *      被动恶化速度 ↑ ⟹ W(good) ↑（演化越快的臂优先级越高直觉的可计算化）。
 *
 * 应用: 模型调度器/租户管理 —— n 个租户只有 k 个能被服务的「部分激活」调度；
 * 落选租户仍在恶化/自愈，正是 RMAB 的定义场景（比 21.0 的冻结臂假设更贴真实）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入
 */

// ─────────────────────────── 常量与类型 ───────────────────────────

/** 臂状态编号（不用 enum: strip-types 兼容） */
export const ARM_STATE = {
  bad: 0,
  good: 1,
} as const;
export type ArmState = (typeof ARM_STATE)[keyof typeof ARM_STATE];

/** 不休眠两态臂: 转移 m[i][j] = P(下一态=j | 当前态=i, 动作)，行随机 */
export interface RestlessArm {
  /** 主动动作转移 2×2（服务/修复该臂时） */
  pa: ReadonlyArray<ReadonlyArray<number>>;
  /** 被动动作转移 2×2（落选放任时: 恶化或自愈） */
  pp: ReadonlyArray<ReadonlyArray<number>>;
  /** good 态主动一步收益（bad 态主动收益恒 0；可为负 = 主动有成本） */
  activeReward: number;
  /** good 态被动一步收益，缺省 0 */
  passiveReward?: number;
  /** 折扣因子 γ ∈ (0,1) */
  discount: number;
}

export interface WhittleSolveOptions {
  /** λ 二分区间宽度容差（默认 1e-6） */
  tolerance: number;
  /** 值迭代相对残差容差（默认 1e-12） */
  viTolerance: number;
  /** 值迭代最大轮数（默认 500000） */
  maxViIterations: number;
}

export const DEFAULT_WHITTLE_OPTIONS: WhittleSolveOptions = {
  tolerance: 1e-6,
  viTolerance: 1e-12,
  maxViIterations: 500000,
};

/** 补贴 λ 下单臂 MDP 的值迭代解（主动/被动 Q 值供无差检验） */
export interface SubsidySolution {
  lambda: number;
  /** 最优价值 [V(bad), V(good)] */
  value: readonly [number, number];
  /** 主动 Q 值（不含补贴） */
  qActive: readonly [number, number];
  /** 被动 Q 值（已含补贴 λ） */
  qPassive: readonly [number, number];
  /** 各态被动是否严格最优（并列判主动，与 sup 语义一致） */
  passiveOptimal: readonly [boolean, boolean];
  iterations: number;
  residual: number;
  converged: boolean;
}

export interface WhittleIndexResult {
  /** [W(bad), W(good)] */
  index: readonly [number, number];
  /** 两态二分均收敛（区间端点语义成立且宽度达标） */
  converged: boolean;
  /** 各态最终二分区间（审计口径: 区间宽 ≤ tolerance） */
  brackets: readonly [readonly [number, number], readonly [number, number]];
}

/** λ 网格上的被动最优集采样点 */
export interface PassiveSetPoint {
  lambda: number;
  passive: readonly [boolean, boolean];
}

export interface IndexabilityResult {
  /** S(λ) 随 λ 单调不减（violations = 0） */
  indexable: boolean;
  /** λ 升序的被动集序列（审计） */
  passiveSetSequence: readonly PassiveSetPoint[];
  /** 随 λ 上升「被动态翻回主动态」的翻转次数 */
  violations: number;
}

/** 调度输入: 臂 + 当前观测态 */
export interface WhittleArm extends RestlessArm {
  id: string;
  state: ArmState;
}

export interface WhittleScheduleEntry {
  id: string;
  state: ArmState;
  /** 当前态的 Whittle 指数 */
  index: number;
  /** 可索引性诚实上报（本 API 内恒 true，见文件头定理） */
  indexable: boolean;
  converged: boolean;
  selected: boolean;
  rank: number;
}

export interface WhittleScheduleResult {
  /** 按指数降序（并列按 id 升序） */
  ranked: readonly WhittleScheduleEntry[];
  selectedIds: readonly string[];
  nonIndexableIds: readonly string[];
  allConverged: boolean;
}

// ─────────────────────────── 内部规范化 ───────────────────────────

interface NormalizedArm {
  /** pa[s] = [P(bad|s,主动), P(good|s,主动)] */
  pa: readonly [readonly [number, number], readonly [number, number]];
  pp: readonly [readonly [number, number], readonly [number, number]];
  /** ra[s] = s 态主动一步收益（bad 态恒 0） */
  ra: readonly [number, number];
  rp: readonly [number, number];
  gamma: number;
}

const STOCH_EPS = 1e-9;

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function mergeOptions(options?: Partial<WhittleSolveOptions>): WhittleSolveOptions {
  const o: WhittleSolveOptions = { ...DEFAULT_WHITTLE_OPTIONS, ...(options ?? {}) };
  if (typeof o.tolerance !== 'number' || !Number.isFinite(o.tolerance) || o.tolerance <= 0 || o.tolerance >= 1) {
    throw new Error(`Whittle 选项: tolerance 必须在 (0,1) 内, 收到 ${o.tolerance}`);
  }
  if (typeof o.viTolerance !== 'number' || !Number.isFinite(o.viTolerance) || o.viTolerance <= 0 || o.viTolerance >= 1) {
    throw new Error(`Whittle 选项: viTolerance 必须在 (0,1) 内, 收到 ${o.viTolerance}`);
  }
  if (!Number.isInteger(o.maxViIterations) || o.maxViIterations < 100) {
    throw new Error(`Whittle 选项: maxViIterations 必须为 ≥100 整数, 收到 ${o.maxViIterations}`);
  }
  return o;
}

function normalizeRow(row: ReadonlyArray<number> | undefined, label: string): [number, number] {
  if (!Array.isArray(row) || row.length !== 2) {
    throw new Error(`${label}: 转移矩阵每行必须是长度 2 的数组`);
  }
  const c0 = row[0];
  const c1 = row[1];
  if (typeof c0 !== 'number' || typeof c1 !== 'number' || !Number.isFinite(c0) || !Number.isFinite(c1)) {
    throw new Error(`${label}: 转移概率必须为有限数`);
  }
  if (c0 < -STOCH_EPS || c0 > 1 + STOCH_EPS || c1 < -STOCH_EPS || c1 > 1 + STOCH_EPS) {
    throw new Error(`${label}: 转移概率必须在 [0,1], 收到 [${c0}, ${c1}]`);
  }
  const sum = c0 + c1;
  if (Math.abs(sum - 1) > STOCH_EPS) {
    throw new Error(`${label}: 转移行和必须为 1, 收到 ${sum}`);
  }
  return [clamp01(c0) / sum, clamp01(c1) / sum];
}

function normalizeArm(arm: RestlessArm, label: string): NormalizedArm {
  if (!arm || typeof arm !== 'object') {
    throw new Error(`${label}: 臂必须为对象`);
  }
  if (!Array.isArray(arm.pa) || arm.pa.length !== 2 || !Array.isArray(arm.pp) || arm.pp.length !== 2) {
    throw new Error(`${label}: pa/pp 必须是 2×2 矩阵（两行、每行两列）`);
  }
  const pa: [[number, number], [number, number]] = [
    normalizeRow(arm.pa[0], `${label}.pa[0]`),
    normalizeRow(arm.pa[1], `${label}.pa[1]`),
  ];
  const pp: [[number, number], [number, number]] = [
    normalizeRow(arm.pp[0], `${label}.pp[0]`),
    normalizeRow(arm.pp[1], `${label}.pp[1]`),
  ];
  if (typeof arm.activeReward !== 'number' || !Number.isFinite(arm.activeReward)) {
    throw new Error(`${label}: activeReward 必须为有限数, 收到 ${arm.activeReward}`);
  }
  const passive = arm.passiveReward === undefined ? 0 : arm.passiveReward;
  if (typeof passive !== 'number' || !Number.isFinite(passive)) {
    throw new Error(`${label}: passiveReward 必须为有限数或缺省, 收到 ${arm.passiveReward}`);
  }
  if (typeof arm.discount !== 'number' || !Number.isFinite(arm.discount) || arm.discount <= 0 || arm.discount >= 1) {
    throw new Error(`${label}: discount 必须在 (0,1) 开区间, 收到 ${arm.discount}`);
  }
  return { pa, pp, ra: [0, arm.activeReward], rp: [0, passive], gamma: arm.discount };
}

// ─────────────────────────── 补贴 MDP 策略迭代（R5: 精确解） ───────────────────────────

/**
 * 补贴 λ 下单臂 MDP 的策略迭代精确解（R5 升级, 替换值迭代）。
 *
 * 两态只有 4 个确定性平稳策略 π = (π_bad, π_good)；每个 π 的折扣值函数是
 *   (I − γ·P^π)·V = r^π_λ
 * 的唯一解——2×2 Cramer 闭式（I−γP^π 严格对角占优: 对角元 ≥ 1−γ·max P^π[s][s] ≥ 1−γ > 0
 * 与非对角 |γ·P^π[s][s̄]| 之和 = 1, 由行随机性非对角占优严格小于对角优势——恒可逆良态）。
 * 策略改进取逐态 argmax（并列判主动, 与 sup 语义一致）, 有限策略空间 + 严格改进
 * ⟹ ≤4 轮终止于最优策略（策略迭代标准定理）, 值与 Bellman 不动点一致到浮点精度。
 *
 * SubsidySolution 口径: iterations = 策略迭代轮数（评估×改进, ≤4）;
 * residual = 收敛后 |V − T_λV|（精确解处为浮点尘埃 ~1e-15, 原值迭代为容差界）;
 * converged = 策略稳定（恒 true, 除非 maxViIterations 安全阀触发）。
 */
function subsidyCore(A: NormalizedArm, lambda: number, o: WhittleSolveOptions): SubsidySolution {
  const g = A.gamma;
  /** 策略评估: 解 (I − γP^π)V = r^π_λ 的 2×2 闭式（Cramer） */
  const evaluate = (actBad: boolean, actGood: boolean): [number, number] => {
    const p00 = actBad ? A.pa[0][0] : A.pp[0][0];
    const p01 = actBad ? A.pa[0][1] : A.pp[0][1];
    const p10 = actGood ? A.pa[1][0] : A.pp[1][0];
    const p11 = actGood ? A.pa[1][1] : A.pp[1][1];
    const r0 = (actBad ? A.ra[0] : A.rp[0]) + (actBad ? 0 : lambda);
    const r1 = (actGood ? A.ra[1] : A.rp[1]) + (actGood ? 0 : lambda);
    const a11 = 1 - g * p00;
    const a12 = -g * p01;
    const a21 = -g * p10;
    const a22 = 1 - g * p11;
    const det = a11 * a22 - a12 * a21;
    return [(r0 * a22 - a12 * r1) / det, (a11 * r1 - a21 * r0) / det];
  };
  let actBad = true;
  let actGood = true;
  let vb = 0;
  let vg = 0;
  let iterations = 0;
  let converged = false;
  while (iterations < o.maxViIterations) {
    iterations += 1;
    [vb, vg] = evaluate(actBad, actGood);
    // 策略改进（并列判主动——与 qActive ≥ qPassive 的 sup 语义一致）
    const qa0 = g * (A.pa[0][0] * vb + A.pa[0][1] * vg);
    const qp0 = lambda + g * (A.pp[0][0] * vb + A.pp[0][1] * vg);
    const qa1 = A.ra[1] + g * (A.pa[1][0] * vb + A.pa[1][1] * vg);
    const qp1 = A.rp[1] + lambda + g * (A.pp[1][0] * vb + A.pp[1][1] * vg);
    const newBad = qa0 >= qp0;
    const newGood = qa1 >= qp1;
    if (newBad === actBad && newGood === actGood) {
      converged = true;
      break;
    }
    actBad = newBad;
    actGood = newGood;
  }
  if (!converged) [vb, vg] = evaluate(actBad, actGood);
  const qActive: [number, number] = [
    g * (A.pa[0][0] * vb + A.pa[0][1] * vg),
    A.ra[1] + g * (A.pa[1][0] * vb + A.pa[1][1] * vg),
  ];
  const qPassive: [number, number] = [
    lambda + g * (A.pp[0][0] * vb + A.pp[0][1] * vg),
    A.rp[1] + lambda + g * (A.pp[1][0] * vb + A.pp[1][1] * vg),
  ];
  // 精确解的 Bellman 残差（浮点尘埃; 原值迭代此处是 1e-12 级容差界）
  const residual = Math.max(
    Math.abs(vb - Math.max(qActive[0], qPassive[0])),
    Math.abs(vg - Math.max(qActive[1], qPassive[1])),
  );
  return {
    lambda,
    value: [vb, vg],
    qActive,
    qPassive,
    passiveOptimal: [qPassive[0] > qActive[0], qPassive[1] > qActive[1]],
    iterations,
    residual,
    converged,
  };
}

/**
 * 补贴 λ 下单臂 MDP 的最优解（策略迭代精确解，2 态）。
 * qPassive 已含补贴 λ；passiveOptimal 并列时判主动（与 W(s)=sup{λ:主动最优} 语义一致）。
 */
export function solveSubsidy(
  arm: RestlessArm,
  lambda: number,
  options?: Partial<WhittleSolveOptions>,
): SubsidySolution {
  if (typeof lambda !== 'number' || !Number.isFinite(lambda)) {
    throw new Error(`solveSubsidy: lambda 必须为有限数, 收到 ${lambda}`);
  }
  const A = normalizeArm(arm, 'solveSubsidy');
  return subsidyCore(A, lambda, mergeOptions(options));
}

// ─────────────────────────── Whittle 指数: 对 λ 二分 ───────────────────────────

interface BisectResult {
  lo: number;
  hi: number;
  converged: boolean;
}

function bisectState(A: NormalizedArm, s: 0 | 1, o: WhittleSolveOptions): BisectResult {
  const activePreferred = (lam: number): boolean => {
    const sol = subsidyCore(A, lam, o);
    return sol.qActive[s] >= sol.qPassive[s];
  };
  // 补贴区间的安全初始半宽: 补贴流 |λ|/(1−γ) 压倒任何收益差所需的量级
  const rBar = Math.max(1, Math.abs(A.ra[1]), Math.abs(A.rp[1]));
  let bound = (2 * rBar + 1) / (1 - A.gamma);
  let hiActive = activePreferred(bound);
  let guard = 0;
  while (hiActive && guard < 48) {
    bound *= 2;
    guard += 1;
    hiActive = activePreferred(bound);
  }
  const hi = bound;
  let loBound = -(2 * rBar + 1) / (1 - A.gamma);
  let loActive = activePreferred(loBound);
  guard = 0;
  while (!loActive && guard < 48) {
    loBound *= 2;
    guard += 1;
    loActive = activePreferred(loBound);
  }
  const lo = loBound;
  // 端点语义不成立（臂在有限补贴域内永不无差）: 诚实上报未收敛
  if (hiActive || !loActive) {
    return { lo, hi, converged: false };
  }
  // D_s(λ) 严格单调递减（文件头定理）⟹ 二分合法
  let a = lo;
  let b = hi;
  while (b - a > o.tolerance) {
    const mid = (a + b) / 2;
    if (activePreferred(mid)) a = mid;
    else b = mid;
  }
  return { lo: a, hi: b, converged: true };
}

function whittleCore(A: NormalizedArm, o: WhittleSolveOptions): WhittleIndexResult {
  const r0 = bisectState(A, 0, o);
  const r1 = bisectState(A, 1, o);
  return {
    index: [(r0.lo + r0.hi) / 2, (r1.lo + r1.hi) / 2],
    converged: r0.converged && r1.converged,
    brackets: [
      [r0.lo, r0.hi],
      [r1.lo, r1.hi],
    ],
  };
}

/** 求两态 Whittle 指数 [W(bad), W(good)]（λ 二分，区间宽 ≤ tolerance） */
export function solveWhittleIndex(
  arm: RestlessArm,
  options?: Partial<WhittleSolveOptions>,
): WhittleIndexResult {
  const o = mergeOptions(options);
  const A = normalizeArm(arm, 'solveWhittleIndex');
  return whittleCore(A, o);
}

// ─────────────────────────── 可索引性检查 ───────────────────────────

/**
 * 被动集序列单调性判定: S(λ) 随 λ 单调不减 ⟺ 任一状态一旦被动，λ 上升后不得翻回主动。
 * （独立导出供外部审计合成序列; 内核 indexabilityCheck 内部同判据。）
 */
export function checkPassiveSetMonotonicity(sequence: ReadonlyArray<PassiveSetPoint>): boolean {
  if (!Array.isArray(sequence)) {
    throw new Error('checkPassiveSetMonotonicity: sequence 必须为数组');
  }
  const pts = sequence
    .map((p) => {
      if (
        !p ||
        typeof p.lambda !== 'number' ||
        !Number.isFinite(p.lambda) ||
        !Array.isArray(p.passive) ||
        p.passive.length !== 2 ||
        typeof p.passive[0] !== 'boolean' ||
        typeof p.passive[1] !== 'boolean'
      ) {
        throw new Error('checkPassiveSetMonotonicity: 每个点必须是 {lambda: number, passive: [boolean, boolean]}');
      }
      return { lambda: p.lambda, passive: p.passive };
    })
    .sort((x, y) => x.lambda - y.lambda);
  for (let i = 1; i < pts.length; i += 1) {
    for (let s = 0; s < 2; s += 1) {
      if (pts[i - 1].passive[s] && !pts[i].passive[s]) return false;
    }
  }
  return true;
}

function indexabilityCore(A: NormalizedArm, o: WhittleSolveOptions): IndexabilityResult {
  const w = whittleCore(A, o);
  // λ 网格: 覆盖 [min(0,W)−1, max(0,W)+1] 的粗网格 + 两态指数邻域细网格（无差带两侧）
  const base = Math.min(0, w.index[0], w.index[1]) - 1;
  const top = Math.max(0, w.index[0], w.index[1]) + 1;
  const pts: number[] = [];
  for (let i = 0; i <= 20; i += 1) {
    pts.push(base + ((top - base) * i) / 20);
  }
  for (const wi of w.index) {
    for (const d of [1e-3, 1e-2, 5e-2, 2e-1]) {
      pts.push(wi - d);
      pts.push(wi + d);
    }
  }
  const uniq = new Map<string, number>();
  for (const x of pts) uniq.set(x.toPrecision(12), x);
  const lambdas = Array.from(uniq.values()).sort((x, y) => x - y);
  const sequence: PassiveSetPoint[] = lambdas.map((lam) => {
    const sol = subsidyCore(A, lam, o);
    return { lambda: lam, passive: [sol.passiveOptimal[0], sol.passiveOptimal[1]] as const };
  });
  let violations = 0;
  for (let i = 1; i < sequence.length; i += 1) {
    for (let s = 0; s < 2; s += 1) {
      if (sequence[i - 1].passive[s] && !sequence[i].passive[s]) violations += 1;
    }
  }
  return { indexable: violations === 0, passiveSetSequence: sequence, violations };
}

/** 可索引性检查: S(λ) 是否随 λ 单调不减（不可索引的臂诚实上报 indexable=false） */
export function indexabilityCheck(
  arm: RestlessArm,
  options?: Partial<WhittleSolveOptions>,
): IndexabilityResult {
  const o = mergeOptions(options);
  const A = normalizeArm(arm, 'indexabilityCheck');
  return indexabilityCore(A, o);
}

// ─────────────────────────── Whittle 调度器 ───────────────────────────

/**
 * 部分激活调度: n 个不休眠臂中选当前态指数最高的 k 个。
 * 不可索引臂仍按其指数排序但经 nonIndexableIds 诚实上报（本 API 内恒空，见文件头定理）;
 * allConverged=false 时指数仅为区间界，调用方应降级处理。
 */
export function whittleScheduler(
  arms: ReadonlyArray<WhittleArm>,
  k: number,
  options?: Partial<WhittleSolveOptions>,
): WhittleScheduleResult {
  if (!Array.isArray(arms)) {
    throw new Error('whittleScheduler: arms 必须为数组');
  }
  if (!Number.isInteger(k) || k < 0 || k > arms.length) {
    throw new Error(`whittleScheduler: k 必须为 0..n 的整数, 收到 ${k}, n=${arms.length}`);
  }
  const o = mergeOptions(options);
  const entries: WhittleScheduleEntry[] = [];
  const nonIndexableIds: string[] = [];
  let allConverged = true;
  for (const arm of arms) {
    if (!arm || typeof arm.id !== 'string' || arm.id === '') {
      throw new Error('whittleScheduler: 每个臂必须有非空字符串 id');
    }
    if (arm.state !== ARM_STATE.bad && arm.state !== ARM_STATE.good) {
      throw new Error(`whittleScheduler: 臂 ${arm.id} 的 state 必须为 0(bad)|1(good), 收到 ${arm.state}`);
    }
    const A = normalizeArm(arm, `whittleScheduler(${arm.id})`);
    const w = whittleCore(A, o);
    const ic = indexabilityCore(A, o);
    entries.push({
      id: arm.id,
      state: arm.state,
      index: w.index[arm.state],
      indexable: ic.indexable,
      converged: w.converged,
      selected: false,
      rank: 0,
    });
    if (!ic.indexable) nonIndexableIds.push(arm.id);
    if (!w.converged) allConverged = false;
  }
  entries.sort((x, y) => y.index - x.index || x.id.localeCompare(y.id));
  entries.forEach((e, i) => {
    e.rank = i + 1;
    e.selected = i < k;
  });
  return {
    ranked: entries,
    selectedIds: entries.filter((e) => e.selected).map((e) => e.id),
    nonIndexableIds,
    allConverged,
  };
}

// ─────────────────── 接线建议 ───────────────────
// 1. 模型调度器/租户管理: n 个租户（臂）每轮只能服务 k 个（GPU 配额/专家容量/人审
//    带宽），落选租户的健康仍在演化（恶化或自愈）——这正是 RMAB 的定义场景。用
//    whittleScheduler(arms, k) 替换现有的轮询/贪心: 每租户维护两态健康
//    （good/bad，可由 SLA 达标率阈值化）与主动/被动转移频率估计（滑动窗口计数
//    归一即为 pa/pp 行），activeReward 取服务一步的效用、passiveReward 缺省 0。
// 2. 与 21.0 Gittins 的关系: 21.0 的 availability 乘法折算是本内核的粗近似
//    （当时即注明「精确 Whittle 不可判定」——两态族下本内核给出精确解，且恒可
//    索引有定理保证）。挂载后 index-scheduling 的 effectiveIndex 路径可由
//    W(state) 精确替代: 落选臂的演化数学第一次进入调度口径。
// 3. 缺省关闭旗标: config.whittleTenantScheduling（缺省 false）。打开后仅改变一处
//    决策点: 调度器每轮「服务哪 k 个租户」从现有规则（轮询/最近最久未服务）改为
//    Whittle top-k；allConverged=false 或 nonIndexableIds 非空时回退旧行为并告警。
//    旗标关闭时调度路径与现状逐位一致（零漂移）。
