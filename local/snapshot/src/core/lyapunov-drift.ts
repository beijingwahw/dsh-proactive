/**
 * 54.0 Lyapunov 漂移加罚内核 —— 背压调度 + 对偶价格涌现：积压本身就是调度信号
 *
 * 动机: 41.0 排队网络指出瓶颈在哪、25.0 容量规划反解要多少并发——但「这一槽
 * 该把服务分给谁、要不要为省钱让队列等一等」是一个**在线序贯**决策：到达是
 * 随机的、动作有成本、队列会积压。拍脑袋的静态优先级既不保证队列稳定，也
 * 不保证成本最优。漂移加罚（Neely 2010 随机网络优化）用一个二次型 Lyapunov
 * 函数把两件事一次解决：**队列积压自动成为优先级权重**，稳定性是定理背书，
 * 成本对 LP 最优的偏差随 V 可控——优先级从配置项变成数学量。
 *
 * 数学: 队列向量 Q(t) ∈ R^N_+（未服务工作量），每槽:
 *   1) 观测 Q(t)，从有限动作集 A 选 α(t)（服务分配 μ(α) ≥ 0、成本 cost(α)）;
 *   2) 到达 a(t)（mulberry32 种子化随机，E[a_i] = λ_i，与 α 独立）;
 *   3) 演化 Q_i(t+1) = [Q_i(t) − μ_i(α) + a_i(t)]⁺。
 *
 *   Lyapunov 函数 V(t) = Σ_i Q_i(t)²。逐槽代数恒等式（钳位只减不增）:
 *     [Q−μ+a]⁺² ≤ Q² + μ² + a² + 2Q(a−μ)
 *   （等号当且仅当 a·μ = 0 且不触底——路径必然成立，机器精度可验）。
 *   取条件期望（a 与 α 独立）得漂移上界（以 ½ΣQ² 为口径时系数恰为 1）:
 *     Δ = E[V(t+1)−V(t)|Q] ≤ B − Σ_i Q_i·(μ_i(α) − λ_i),  B = ½Σ_i(μ_max,i² + a_max,i²)
 *   漂移加罚 = 漂移 + V·cost(α)，最小化之并丢弃与 α 无关的项（B、λ）:
 *     α* = argmin_α [ V·cost(α) − Σ_i Q_i·μ_i(α) ]
 *   队列越深，把服务拨给它的收益越大（背压权重 = Q_i 本身）。
 *
 *   定理（[O(1/V) 次优, O(V) 队长] 权衡）: 若 λ 严格落在容量域内部，则
 *     时间平均成本 ≤ LP* + O(B/V)，平均总队长 = O(V)
 *   其中 LP* = min E[cost(α)] s.t. E[μ_i(α)] ≥ λ_i ∀i——动作单纯形上的线性
 *   规划，小实例可枚举顶点精确求解（lpBenchmark）。对偶价格
 *     p_i(t) = Q_i(t)/V
 *   随 t 收敛到该 LP 的最优拉格朗日乘子——影子价格不是估出来的，是队列深度
 *   自己长出来的（瓶颈约束乘子 > 0，富余约束乘子 → 0）。
 *
 * 验证锚点（scripts/verify-lyapunov-drift.mjs）: 玩具实例 = 2 队列 3 动作
 * （cheap/balanced/premium，μ = (0.9,0)/(0.45,0.45)/(0.9,0.9)，
 * cost = 0/0.5/1，λ = (0.5, 0.5)）:
 *   ① LP 顶点枚举最优 = 5/9（cheap:premium = 4:5 分时共享），对偶乘子
 *      y* = (0, 10/9)；仿真时间平均成本 → 5/9 ± 0.01，且严格优于一切纯动作
 *      策略（最优稳定纯策略 premium 恒定成本 1；cheap/balanced 不稳定）——
 *      漂移加罚自动发现「分时」这一 LP 混合策略;
 *   ② V ∈ {1,2,4,…,128} 扫描: 平均成本随 V 单调不增、平均队长随 V 单调不减
 *      （[O(1/V) 次优, O(V) 队长] 权衡的两方向读数）;
 *   ③ 队列稳定: 平均队长随 T 次线性增长（T=10⁴ 与 T=10³ 比值 < 10，实测
 *      ≈ 1.1；对照恒定 cheap 策略线性增长，比值 ≈ 10）;
 *   ④ 对偶价格: 轨迹末端窗口均值 p̄ → LP 乘子（|p̄₂ − 10/9| ≤ 0.03、
 *      p̄₂ > p̄₁ 方向断言；偏差来源 = 冷启动爬坡 + 边界锯齿，脚本内文档化）;
 *   ⑤ 逐槽漂移证书: realized Δ(½ΣQ²) ≤ ½Σ(μ²+a²) − ΣQ(μ−a) 路径必然
 *      成立（残差 = Σa_iμ_i + ½Σ[触底]D_i² ≥ 0，全程 ≥ 0 断言）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 基础类型与常量 ───────────────────────────

/** 动作 α：服务分配 μ(α) 与成本 cost(α)（LP 可行域 = 动作单纯形凸包的支配闭包） */
export interface LyapunovAction {
  /** 动作标识（诊断输出用） */
  id: string;
  /** 服务分配 μ_i(α) ≥ 0（本槽给队列 i 的服务量） */
  mu: number[];
  /** 动作成本（token/延迟/配额折算；越大越贵，允许 0 不允许非有限） */
  cost: number;
}

/** 漂移加罚步进选项 */
export interface DriftStepOptions {
  /** 罚权重 V > 0（[O(1/V) 次优, O(V) 队长] 的旋钮） */
  V: number;
  /** 成本覆盖函数（缺省取 action.cost；接线侧动态计价用） */
  cost?: (action: LyapunovAction) => number;
}

/** 一步决策与审计（纯函数，不修改入参） */
export interface DriftStepResult {
  /** 选中动作（平局取动作集先出者——动作集顺序即次级优先级） */
  action: LyapunovAction;
  /** 选中动作下标 */
  index: number;
  /** Q(t+1) = [Q − μ(α) + a]⁺ */
  nextQueues: number[];
  /** 对偶价格 p_i = Q_i(t)/V（决策时刻口径） */
  prices: number[];
  /** 目标值 V·cost(α) − Σ_i Q_i·μ_i(α)（argmin 对象） */
  score: number;
  /** 罚项 V·cost(α) */
  penalty: number;
  /** 背压项 Σ_i Q_i·μ_i(α) */
  backpressure: number;
  /** 漂移证书（½ΣQ² 口径）: 上界 ≥ 实况，路径必然；residual = Σa_iμ_i + ½Σ[触底]D_i² ≥ 0 */
  driftBound: number;
  driftRealized: number;
  certificateResidual: number;
}

/** 到达过程（const 对象 + 值联合类型——strip-types 兼容，不用 enum） */
export const ARRIVAL_MODES = {
  /** Poisson 到达（Knuth 乘积法；要求 0 ≤ λ_i ≤ 64） */
  poisson: 'poisson',
  /** 确定性到达 a_i(t) = λ_i（漂移证书等号情形的对照） */
  deterministic: 'deterministic',
  /** 突发到达：每槽以 10% 概率到 10λ_i，否则 0（均值不变、方差 ×90 的压力测试） */
  bursty: 'bursty',
} as const;
/** 到达模式取值集（'poisson' | 'deterministic' | 'bursty'） */
export type ArrivalMode = (typeof ARRIVAL_MODES)[keyof typeof ARRIVAL_MODES];

/** 策略模式（const 对象 + 值联合类型） */
export const POLICY_MODES = {
  /** 漂移加罚贪心（本内核主角） */
  driftPlusPenalty: 'drift-plus-penalty',
  /** 恒定动作（LP 顶点 / 纯策略对照） */
  fixed: 'fixed',
} as const;
/** 策略取值集（'drift-plus-penalty' | 'fixed'） */
export type PolicyMode = (typeof POLICY_MODES)[keyof typeof POLICY_MODES];

const ARRIVAL_MODE_VALUES: readonly ArrivalMode[] = Object.values(ARRIVAL_MODES);
const POLICY_MODE_VALUES: readonly PolicyMode[] = Object.values(POLICY_MODES);

/** 仿真配置（T 与 seed 是 simulatePolicy 的显式参数） */
export interface LyapunovSimConfig {
  /** 初始队列 Q(0) ≥ 0 */
  queues0: number[];
  /** 动作集 A */
  actionSet: LyapunovAction[];
  /** 到达率 λ_i（各到达模式的期望到达） */
  arrivalMeans: number[];
  /** 罚权重 V > 0 */
  V: number;
  /** 到达过程（缺省 poisson） */
  arrivalMode?: ArrivalMode;
  /** 策略（缺省 drift-plus-penalty） */
  policy?: PolicyMode;
  /** policy='fixed' 时的动作下标（其余策略忽略） */
  fixedActionIndex?: number;
  /** 对偶价格末端窗口宽（缺省 256，钳到 T） */
  sampleWindow?: number;
  /** 成本覆盖（缺省 action.cost） */
  cost?: (action: LyapunovAction) => number;
}

/** 仿真轨迹统计 */
export interface LyapunovSimResult {
  steps: number;
  V: number;
  policy: PolicyMode;
  arrivalMode: ArrivalMode;
  finalQueues: number[];
  /** 时间平均队长（槽始口径，含 t=0） */
  avgQueues: number[];
  avgQueueTotal: number;
  maxQueueTotal: number;
  /** 时间平均成本（[O(1/V) 次优] 的读数对象） */
  avgCost: number;
  /** 时间平均服务率（守恒口径: ≈ λ 若稳定） */
  avgService: number[];
  avgArrival: number[];
  /** 全程时间平均价格 avgQueues/V（含冷启动偏差） */
  avgPrices: number[];
  /** 末端瞬时价格 finalQueues/V（边界附近锯齿振荡，非收敛对象） */
  finalPrices: number[];
  /** 末端窗口平均价格（收敛到 LP 乘子的正规对象） */
  dualPrices: number[];
  /** 末端窗口内的队长样本（dualPrices 的原料） */
  queueTail: number[][];
  /** 各动作被选中的时间占比（LP 混合 π 的经验对照） */
  actionShares: number[];
  /** 漂移证书全程最小残差（≥ 0 应恒成立；< 0 即实现有 bug） */
  certificateMinResidual: number;
  /** B = ½Σ_i(μ_max,i² + a_max,i²)（μ 取动作集静态最大、a 取经验最大） */
  driftConstantB: number;
}

/** LP 基准配置 */
export interface LyapunovLpConfig {
  actionSet: LyapunovAction[];
  arrivalMeans: number[];
  cost?: (action: LyapunovAction) => number;
}

/** LP 顶点枚举结果（min Σπ·cost s.t. Σπ·μ ≥ λ, Σπ = 1, π ≥ 0） */
export interface LpBenchmarkResult {
  /** λ 是否落在容量域（动作凸包的支配闭包）内 */
  feasible: boolean;
  /** LP*（不可行时 +∞） */
  optimalCost: number;
  /** 最优混合 π（某顶点；最优面可能是边——枚举取先出顶点） */
  pi: number[];
  /** 达成服务率 Σ_j π_j·μ_ij */
  serviceRates: number[];
  /** 服务约束的最优拉格朗日乘子 y*（对偶价格 p = Q/V 的收敛目标；非紧约束 → 0） */
  duals: number[];
  /** 单纯形约束乘子 ν（强对偶: y·λ + ν = LP*） */
  simplexDual: number;
  /** 对偶可行性审计: y ≥ 0 且 yᵀμ_j + ν ≤ cost_j ∀j */
  dualFeasible: boolean;
  /** 枚举的候选顶点组合数 C(n+m, m−1) */
  verticesChecked: number;
  /** 解出且可行的组合数（退化顶点会被多条约束组合复现，为组合口径计数） */
  feasibleVertices: number;
  /** R5: 严格松弛约束跳过的 ±EPS 重解次数（富余约束乘子精确为 0，无需枚举） */
  dualSolvesSkipped: number;
}

/** 顶点枚举规模上限（小实例契约；超出显式 throw） */
const MAX_LP_VERTICES = 20000;
/** Poisson 到达率上限（Knuth 乘积法期望迭代 λ+1，上限即复杂度护栏） */
const MAX_POISSON_LAMBDA = 64;
/** 仿真槽数上限（防误用挂死） */
const MAX_SIM_STEPS = 10_000_000;

// ─────────────────────────── 入参校验 ───────────────────────────

function requireVector(xs: readonly number[] | undefined, what: string): void {
  if (!Array.isArray(xs) || xs.length === 0) {
    throw new Error(`${what}: 必须是非空数值数组`);
  }
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i];
    if (!Number.isFinite(x) || x < 0) {
      throw new Error(`${what}[${i}]=${x}: 必须是有限非负数`);
    }
  }
}

function requireActionSet(actionSet: readonly LyapunovAction[] | undefined, n: number, what: string): void {
  if (!Array.isArray(actionSet) || actionSet.length === 0) {
    throw new Error(`${what}: 动作集必须非空`);
  }
  for (let j = 0; j < actionSet.length; j += 1) {
    const a = actionSet[j];
    if (a === null || typeof a !== 'object' || typeof a.id !== 'string' || !Array.isArray(a.mu) || a.mu.length !== n) {
      throw new Error(`${what}[${j}]: 需要 { id: string, mu: number[${n}], cost: number }`);
    }
    for (let i = 0; i < n; i += 1) {
      if (!Number.isFinite(a.mu[i]) || a.mu[i] < 0) {
        throw new Error(`${what}[${j}].mu[${i}]=${a.mu[i]}: 必须是有限非负数`);
      }
    }
    if (!Number.isFinite(a.cost)) {
      throw new Error(`${what}[${j}].cost=${a.cost}: 必须是有限数`);
    }
  }
}

function requireOptionsShape(options: DriftStepOptions | undefined, what: string): void {
  if (options === null || typeof options !== 'object') {
    throw new Error(`${what}: options 必须是对象`);
  }
  if (!Number.isFinite(options.V) || options.V <= 0) {
    throw new Error(`${what}: V=${options.V} 必须是 > 0 的有限数`);
  }
  if (options.cost !== undefined && typeof options.cost !== 'function') {
    throw new Error(`${what}: cost 覆盖必须是函数`);
  }
}

// ─────────────────────────── 确定性随机 ───────────────────────────

/** 确定性 PRNG（mulberry32；同种子同序列——同输入同输出契约的随机基座） */
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

/** Poisson 采样（Knuth 乘积法；0 ≤ λ ≤ 64，期望迭代 λ+1 次） */
function poissonSample(rng: () => number, lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > L);
  return k - 1;
}

// ─────────────────────────── 核心: 漂移加罚一步 ───────────────────────────

/**
 * 背压贪心一步: α* = argmin_α [V·cost(α) − Σ_i Q_i·μ_i(α)]，
 * 队列更新 Q(t+1) = [Q − μ(α*) + a]⁺，附对偶价格与逐槽漂移证书。
 */
export function driftPlusPenaltyStep(
  queues: readonly number[],
  arrivals: readonly number[],
  actionSet: readonly LyapunovAction[],
  options: DriftStepOptions,
): DriftStepResult {
  requireVector(queues, 'driftPlusPenaltyStep: queues');
  requireVector(arrivals, 'driftPlusPenaltyStep: arrivals');
  if (queues.length !== arrivals.length) {
    throw new Error(`driftPlusPenaltyStep: queues(${queues.length}) 与 arrivals(${arrivals.length}) 长度必须一致`);
  }
  requireActionSet(actionSet, queues.length, 'driftPlusPenaltyStep: actionSet');
  requireOptionsShape(options, 'driftPlusPenaltyStep');
  const n = queues.length;
  const V = options.V;
  const costOf = (a: LyapunovAction): number => (options.cost !== undefined ? options.cost(a) : a.cost);

  let index = 0;
  let score = Number.POSITIVE_INFINITY;
  let penalty = 0;
  let backpressure = 0;
  for (let j = 0; j < actionSet.length; j += 1) {
    const action = actionSet[j];
    const p = V * costOf(action);
    let bp = 0;
    for (let i = 0; i < n; i += 1) bp += queues[i] * action.mu[i];
    const s = p - bp;
    if (s < score) {
      score = s;
      index = j;
      penalty = p;
      backpressure = bp;
    }
  }
  const chosen = actionSet[index];
  const nextQueues = queues.map((q, i) => Math.max(q - chosen.mu[i] + arrivals[i], 0));

  // ½ΣQ² 口径漂移证书（路径必然不等式，见文件头）
  let halfNow = 0;
  let halfNext = 0;
  let driftBound = 0;
  for (let i = 0; i < n; i += 1) {
    halfNow += 0.5 * queues[i] * queues[i];
    halfNext += 0.5 * nextQueues[i] * nextQueues[i];
    driftBound += 0.5 * (chosen.mu[i] * chosen.mu[i] + arrivals[i] * arrivals[i]) - queues[i] * (chosen.mu[i] - arrivals[i]);
  }
  const driftRealized = halfNext - halfNow;
  return {
    action: chosen,
    index,
    nextQueues,
    prices: queues.map((q) => q / V),
    score,
    penalty,
    backpressure,
    driftBound,
    driftRealized,
    certificateResidual: driftBound - driftRealized,
  };
}

/**
 * 逐槽漂移证书（验证锚点⑤）: 对单步演化 Q⁺ = [Q−μ+a]⁺，
 *   ½ΣQ⁺² − ½ΣQ² ≤ ½Σ(μ²+a²) − ΣQ(μ−a)
 * 是与到达分布无关的**路径必然**代数不等式；残差 = Σa_iμ_i + ½Σ[触底]D_i² ≥ 0。
 */
export function driftCertificate(
  queues: readonly number[],
  nextQueues: readonly number[],
  mu: readonly number[],
  arrivals: readonly number[],
): { bound: number; realized: number; residual: number } {
  requireVector(queues, 'driftCertificate: queues');
  requireVector(nextQueues, 'driftCertificate: nextQueues');
  requireVector(mu, 'driftCertificate: mu');
  requireVector(arrivals, 'driftCertificate: arrivals');
  const n = queues.length;
  if (nextQueues.length !== n || mu.length !== n || arrivals.length !== n) {
    throw new Error('driftCertificate: 四个数组长度必须一致');
  }
  let realized = 0;
  let bound = 0;
  for (let i = 0; i < n; i += 1) {
    realized += 0.5 * (nextQueues[i] * nextQueues[i] - queues[i] * queues[i]);
    bound += 0.5 * (mu[i] * mu[i] + arrivals[i] * arrivals[i]) - queues[i] * (mu[i] - arrivals[i]);
  }
  return { bound, realized, residual: bound - realized };
}

// ─────────────────────────── 仿真 ───────────────────────────

/**
 * 策略仿真: 每槽到达（种子化随机）→ 按策略选动作 → 队列演化 → 累计统计。
 * 返回时间平均成本/队长/服务率、动作占比、对偶价格（末端窗口）与漂移证书。
 */
export function simulatePolicy(T: number, config: LyapunovSimConfig, seed: number): LyapunovSimResult {
  if (!Number.isInteger(T) || T < 1 || T > MAX_SIM_STEPS) {
    throw new Error(`simulatePolicy: T=${T} 必须是 [1, ${MAX_SIM_STEPS}] 内的整数`);
  }
  if (config === null || typeof config !== 'object') {
    throw new Error('simulatePolicy: config 必须是对象');
  }
  requireVector(config.queues0, 'simulatePolicy: queues0');
  requireVector(config.arrivalMeans, 'simulatePolicy: arrivalMeans');
  if (config.queues0.length !== config.arrivalMeans.length) {
    throw new Error(`simulatePolicy: queues0(${config.queues0.length}) 与 arrivalMeans(${config.arrivalMeans.length}) 长度必须一致`);
  }
  requireActionSet(config.actionSet, config.queues0.length, 'simulatePolicy: actionSet');
  requireOptionsShape(config, 'simulatePolicy');
  if (config.cost !== undefined && typeof config.cost !== 'function') {
    throw new Error('simulatePolicy: cost 覆盖必须是函数');
  }
  const arrivalMode: ArrivalMode = config.arrivalMode ?? 'poisson';
  if (!ARRIVAL_MODE_VALUES.includes(arrivalMode)) {
    throw new Error(`simulatePolicy: 未知到达模式 ${String(arrivalMode)}（可选 ${ARRIVAL_MODE_VALUES.join('/')}）`);
  }
  const policy: PolicyMode = config.policy ?? 'drift-plus-penalty';
  if (!POLICY_MODE_VALUES.includes(policy)) {
    throw new Error(`simulatePolicy: 未知策略 ${String(policy)}（可选 ${POLICY_MODE_VALUES.join('/')}）`);
  }
  let fixedIndex = -1;
  if (policy === 'fixed') {
    fixedIndex = config.fixedActionIndex ?? -1;
    if (!Number.isInteger(fixedIndex) || fixedIndex < 0 || fixedIndex >= config.actionSet.length) {
      throw new Error(`simulatePolicy: fixed 策略需要 [0, ${config.actionSet.length}) 内的 fixedActionIndex（收到 ${String(config.fixedActionIndex)}）`);
    }
  }
  if (arrivalMode === 'poisson') {
    for (let i = 0; i < config.arrivalMeans.length; i += 1) {
      if (config.arrivalMeans[i] > MAX_POISSON_LAMBDA) {
        throw new Error(`simulatePolicy: poisson 模式要求 λ ≤ ${MAX_POISSON_LAMBDA}（λ[${i}]=${config.arrivalMeans[i]}）`);
      }
    }
  }
  if (config.sampleWindow !== undefined && (!Number.isInteger(config.sampleWindow) || config.sampleWindow < 1)) {
    throw new Error(`simulatePolicy: sampleWindow=${String(config.sampleWindow)} 必须是 ≥ 1 的整数`);
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error('simulatePolicy: seed 必须是 [0, 2³²) 内的整数');
  }

  const n = config.queues0.length;
  const m = config.actionSet.length;
  const lambdas = config.arrivalMeans;
  const rng = mulberry32(seed);
  const costOf = (a: LyapunovAction): number => (config.cost !== undefined ? config.cost(a) : a.cost);
  const queues = [...config.queues0];
  const queueSum = new Array<number>(n).fill(0);
  const serviceSum = new Array<number>(n).fill(0);
  const arrivalSum = new Array<number>(n).fill(0);
  const arrivalMax = new Array<number>(n).fill(0);
  const muMax = new Array<number>(n).fill(0);
  const actionCount = new Array<number>(m).fill(0);
  let costSum = 0;
  let maxQueueTotal = 0;
  let certificateMinResidual = Number.POSITIVE_INFINITY;
  const window = Math.min(config.sampleWindow ?? 256, T);
  const tail: number[][] = Array.from({ length: window }, () => new Array<number>(n).fill(0));
  let tailPos = 0;
  let tailCount = 0;

  for (let j = 0; j < m; j += 1) {
    for (let i = 0; i < n; i += 1) {
      if (config.actionSet[j].mu[i] > muMax[i]) muMax[i] = config.actionSet[j].mu[i];
    }
  }

  const drawArrivals = (): number[] => {
    if (arrivalMode === 'deterministic') return [...lambdas];
    const out = new Array<number>(n);
    for (let i = 0; i < n; i += 1) {
      if (arrivalMode === 'bursty') out[i] = rng() < 0.1 ? 10 * lambdas[i] : 0;
      else out[i] = poissonSample(rng, lambdas[i]);
    }
    return out;
  };

  for (let t = 0; t < T; t += 1) {
    let queueTotal = 0;
    for (let i = 0; i < n; i += 1) {
      queueTotal += queues[i];
      queueSum[i] += queues[i];
    }
    if (queueTotal > maxQueueTotal) maxQueueTotal = queueTotal;
    tail[tailPos] = [...queues];
    tailPos = (tailPos + 1) % window;
    if (tailCount < window) tailCount += 1;

    const arrivals = drawArrivals();
    let chosen: LyapunovAction;
    let chosenIndex: number;
    let nextQueues: number[];
    if (policy === 'drift-plus-penalty') {
      const step = driftPlusPenaltyStep(queues, arrivals, config.actionSet, { V: config.V, cost: config.cost });
      chosen = step.action;
      chosenIndex = step.index;
      nextQueues = step.nextQueues;
      if (step.certificateResidual < certificateMinResidual) certificateMinResidual = step.certificateResidual;
    } else {
      chosen = config.actionSet[fixedIndex];
      chosenIndex = fixedIndex;
      nextQueues = queues.map((q, i) => Math.max(q - chosen.mu[i] + arrivals[i], 0));
      const cert = driftCertificate(queues, nextQueues, chosen.mu, arrivals);
      if (cert.residual < certificateMinResidual) certificateMinResidual = cert.residual;
    }
    actionCount[chosenIndex] += 1;
    costSum += costOf(chosen);
    for (let i = 0; i < n; i += 1) {
      arrivalSum[i] += arrivals[i];
      if (arrivals[i] > arrivalMax[i]) arrivalMax[i] = arrivals[i];
      serviceSum[i] += chosen.mu[i];
      queues[i] = nextQueues[i];
    }
  }

  const avgQueues = queueSum.map((s) => s / T);
  const queueTail: number[][] = [];
  for (let k = 0; k < tailCount; k += 1) {
    queueTail.push(tail[(tailPos - tailCount + k + window) % window]);
  }
  let driftConstantB = 0;
  for (let i = 0; i < n; i += 1) {
    driftConstantB += 0.5 * (muMax[i] * muMax[i] + arrivalMax[i] * arrivalMax[i]);
  }
  return {
    steps: T,
    V: config.V,
    policy,
    arrivalMode,
    finalQueues: queues,
    avgQueues,
    avgQueueTotal: avgQueues.reduce((a, b) => a + b, 0),
    maxQueueTotal,
    avgCost: costSum / T,
    avgService: serviceSum.map((s) => s / T),
    avgArrival: arrivalSum.map((s) => s / T),
    avgPrices: avgQueues.map((q) => q / config.V),
    finalPrices: queues.map((q) => q / config.V),
    dualPrices: dualPrices(queueTail, config.V),
    queueTail,
    actionShares: actionCount.map((c) => c / T),
    certificateMinResidual,
    driftConstantB,
  };
}

// ─────────────────────────── 对偶价格 ───────────────────────────

/**
 * 对偶价格（轨迹末端口径）: p̄_i = mean_tail(Q_i(t)) / V。
 * 时间平均 Q/V 是收敛到 LP 乘子的正规对象（瞬时 Q/V 在容量边界附近锯齿振荡）。
 */
export function dualPrices(tailQueueSamples: ReadonlyArray<readonly number[]>, V: number): number[] {
  if (!Array.isArray(tailQueueSamples) || tailQueueSamples.length === 0) {
    throw new Error('dualPrices: 轨迹末端样本必须非空');
  }
  if (!Number.isFinite(V) || V <= 0) {
    throw new Error(`dualPrices: V=${String(V)} 必须是 > 0 的有限数`);
  }
  const n = tailQueueSamples[0].length;
  const sums = new Array<number>(n).fill(0);
  for (let k = 0; k < tailQueueSamples.length; k += 1) {
    const sample = tailQueueSamples[k];
    if (!Array.isArray(sample) || sample.length !== n) {
      throw new Error(`dualPrices: 样本[${k}] 长度必须一致（${n}）`);
    }
    for (let i = 0; i < n; i += 1) {
      if (!Number.isFinite(sample[i])) {
        throw new Error(`dualPrices: 样本[${k}][${i}] 必须是有限数`);
      }
      sums[i] += sample[i];
    }
  }
  return sums.map((s) => s / tailQueueSamples.length / V);
}

// ─────────────────────────── LP 基准（顶点枚举） ───────────────────────────

/** 高斯消元（列主元；奇异/非有限返回 undefined） */
function solveSquare(a: number[][], b: number[]): number[] | undefined {
  const k = b.length;
  if (k === 0 || a.length !== k) return undefined;
  const aug = a.map((row, i) => [...row, b[i]]);
  let scale = 1;
  for (const row of a) {
    for (const v of row) scale = Math.max(scale, Math.abs(v));
  }
  const tiny = 1e-11 * scale;
  for (let col = 0; col < k; col += 1) {
    let piv = col;
    for (let r = col + 1; r < k; r += 1) {
      if (Math.abs(aug[r][col]) > Math.abs(aug[piv][col])) piv = r;
    }
    if (Math.abs(aug[piv][col]) <= tiny) return undefined;
    const tmp = aug[col];
    aug[col] = aug[piv];
    aug[piv] = tmp;
    const d = aug[col][col];
    for (let r = 0; r < k; r += 1) {
      if (r === col) continue;
      const f = aug[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c <= k; c += 1) aug[r][c] -= f * aug[col][c];
    }
  }
  const x = new Array<number>(k);
  for (let r = 0; r < k; r += 1) x[r] = aug[r][k] / aug[r][r];
  return x.every((v) => Number.isFinite(v)) ? x : undefined;
}

/** C(n, k)（乘积公式） */
function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i += 1) r = (r * (n - k + i)) / i;
  return r;
}

/** {0..total−1} 的所有 k 元子集（字典序） */
function chooseK(total: number, k: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const rec = (start: number, left: number): void => {
    if (left === 0) {
      out.push([...cur]);
      return;
    }
    for (let v = start; v <= total - left; v += 1) {
      cur.push(v);
      rec(v + 1, left - 1);
      cur.pop();
    }
  };
  rec(0, k);
  return out;
}

interface LpSolveOutcome {
  feasible: boolean;
  optimalCost: number;
  pi: number[];
  serviceRates: number[];
  verticesChecked: number;
  feasibleVertices: number;
}

/**
 * 顶点枚举求 LP：单纯形 {π ≥ 0, Σπ = 1} 上的顶点由 m−1 条活性约束（n 条
 * 服务约束 / m 条非负约束）确定，枚举所有组合解 m×m 线性方程组取可行最小。
 * 可行域是有界多面体 → 无可行顶点 ⟺ 不可行（退化顶点被多条组合复现，无害）。
 * mu 为 m×n（动作 × 队列）。内部函数，入参已在上层校验。
 */
function solveLpVertices(mu: number[][], costs: number[], lambda: number[]): LpSolveOutcome {
  const n = lambda.length;
  const m = costs.length;
  const candidates = binom(n + m, m - 1);
  if (candidates > MAX_LP_VERTICES) {
    throw new Error(`lpBenchmark: 候选顶点 C(${n + m},${m - 1})=${candidates} > ${MAX_LP_VERTICES}——顶点枚举只面向小实例（建议 n+m ≤ 16）`);
  }
  const combos = chooseK(n + m, m - 1);
  let scale = 1;
  for (const row of mu) {
    for (const v of row) scale = Math.max(scale, Math.abs(v));
  }
  for (const v of lambda) scale = Math.max(scale, Math.abs(v));
  for (const v of costs) scale = Math.max(scale, Math.abs(v));
  const tol = 1e-9 * scale;
  let best: number[] | undefined;
  let bestCost = Number.POSITIVE_INFINITY;
  let feasibleVertices = 0;
  for (const combo of combos) {
    const A: number[][] = [new Array<number>(m).fill(1)];
    const b: number[] = [1];
    for (const c of combo) {
      if (c < n) {
        // 服务约束 i 活性: Σ_j μ_ji·π_j = λ_i
        A.push(mu.map((row) => row[c]));
        b.push(lambda[c]);
      } else {
        // 非负约束 j 活性: π_j = 0
        const row = new Array<number>(m).fill(0);
        row[c - n] = 1;
        A.push(row);
        b.push(0);
      }
    }
    const x = solveSquare(A, b);
    if (x === undefined) continue;
    let feasible = true;
    for (let j = 0; j < m && feasible; j += 1) {
      if (x[j] < -tol) feasible = false;
    }
    for (let i = 0; i < n && feasible; i += 1) {
      let achieved = 0;
      for (let j = 0; j < m; j += 1) achieved += x[j] * mu[j][i];
      if (achieved < lambda[i] - tol) feasible = false;
    }
    if (!feasible) continue;
    feasibleVertices += 1;
    let cost = 0;
    for (let j = 0; j < m; j += 1) cost += x[j] * costs[j];
    if (cost < bestCost) {
      bestCost = cost;
      best = x.map((v) => (v < 0 ? 0 : v));
    }
  }
  if (best === undefined) {
    return { feasible: false, optimalCost: Number.POSITIVE_INFINITY, pi: [], serviceRates: [], verticesChecked: combos.length, feasibleVertices: 0 };
  }
  const serviceRates = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) serviceRates[i] += best[j] * mu[j][i];
  }
  return { feasible: true, optimalCost: bestCost, pi: best, serviceRates, verticesChecked: combos.length, feasibleVertices };
}

/**
 * LP 基准（小实例精确解）: 枚举动作单纯形顶点求
 *   LP* = min Σπ·cost  s.t.  Σπ·μ_i ≥ λ_i ∀i, Σπ = 1, π ≥ 0。
 * 对偶乘子取 LP* 对 λ_i 的有限差分方向导数——LP 分段线性，同一线性片内
 * 差分**精确**；λ 在拐点时左右导数的凸平均仍是 LP 最优乘子集的成员。
 * ν = LP* − y·λ（强对偶恒等式口径），并审计对偶可行性 y ≥ 0、yᵀμ_j + ν ≤ cost_j。
 */
export function lpBenchmark(config: LyapunovLpConfig): LpBenchmarkResult {
  if (config === null || typeof config !== 'object') {
    throw new Error('lpBenchmark: config 必须是对象');
  }
  requireVector(config.arrivalMeans, 'lpBenchmark: arrivalMeans');
  requireActionSet(config.actionSet, config.arrivalMeans.length, 'lpBenchmark: actionSet');
  if (config.cost !== undefined && typeof config.cost !== 'function') {
    throw new Error('lpBenchmark: cost 覆盖必须是函数');
  }
  const n = config.arrivalMeans.length;
  const mu = config.actionSet.map((a) => a.mu.slice());
  const costs = config.actionSet.map((a) => (config.cost !== undefined ? config.cost(a) : a.cost));
  const base = solveLpVertices(mu, costs, config.arrivalMeans);
  if (!base.feasible) {
    return {
      feasible: false,
      optimalCost: Number.POSITIVE_INFINITY,
      pi: [],
      serviceRates: [],
      duals: new Array<number>(n).fill(0),
      simplexDual: 0,
      dualFeasible: false,
      verticesChecked: base.verticesChecked,
      feasibleVertices: 0,
      dualSolvesSkipped: 0,
    };
  }

  const EPS = 1e-4;
  let scale2 = 1;
  for (let i = 0; i < n; i += 1) scale2 = Math.max(scale2, Math.abs(config.arrivalMeans[i]));
  const guardTol = 1e-9 * scale2;
  const duals: number[] = [];
  let dualSolvesSkipped = 0;
  for (let i = 0; i < n; i += 1) {
    // R5 性能进化: 约束 i 严格松弛（π 对 ±EPS 扰动仍可行）⟹ 任一最优对偶
    // y*_i = 0（互补松弛）⟹ LP*(λ±EPS·e_i) = LP*(λ)（对偶可行性与 λ 无关、
    // c·π = y*·λ' + ν*）⟹ 两侧斜率精确为 0——跳过两次全量顶点枚举。
    if (base.serviceRates[i] >= config.arrivalMeans[i] + EPS + guardTol) {
      duals.push(0);
      dualSolvesSkipped += 2;
      continue;
    }
    const up = config.arrivalMeans.slice();
    up[i] += EPS;
    const upSolve = solveLpVertices(mu, costs, up);
    const down = config.arrivalMeans.slice();
    down[i] = Math.max(0, config.arrivalMeans[i] - EPS);
    const downDelta = config.arrivalMeans[i] - down[i];
    const downSolve = downDelta > 0 ? solveLpVertices(mu, costs, down) : undefined;
    const upSlope = upSolve.feasible ? (upSolve.optimalCost - base.optimalCost) / EPS : Number.NaN;
    const downSlope = downSolve !== undefined && downSolve.feasible ? (base.optimalCost - downSolve.optimalCost) / downDelta : Number.NaN;
    let y: number;
    if (Number.isNaN(upSlope)) {
      y = downSlope; // λ 在容量边界: 右侧不可行，取左导数（乘子下界）
    } else if (Number.isNaN(downSlope)) {
      y = upSlope; // λ_i = 0: 只能右差分
    } else {
      y = 0.5 * (upSlope + downSlope);
    }
    if (!Number.isFinite(y)) y = 0;
    duals.push(y);
  }

  let dualDot = 0;
  for (let i = 0; i < n; i += 1) dualDot += duals[i] * config.arrivalMeans[i];
  const simplexDual = base.optimalCost - dualDot;
  let dualFeasibleFlag = true;
  for (let i = 0; i < n; i += 1) {
    if (duals[i] < -1e-6) dualFeasibleFlag = false;
  }
  for (let j = 0; j < mu.length; j += 1) {
    let lhs = simplexDual;
    for (let i = 0; i < n; i += 1) lhs += duals[i] * mu[j][i];
    if (lhs > costs[j] + 1e-6 * Math.max(1, Math.abs(costs[j]))) dualFeasibleFlag = false;
  }
  return {
    feasible: true,
    optimalCost: base.optimalCost,
    pi: base.pi,
    serviceRates: base.serviceRates,
    duals,
    simplexDual,
    dualFeasible: dualFeasibleFlag,
    verticesChecked: base.verticesChecked,
    feasibleVertices: base.feasibleVertices,
    dualSolvesSkipped,
  };
}

// ─────────────────── 54.0 接线桥（背压洞察的语义桥） ───────────────────

/**
 * 背压洞察构造（autonomy-loop 消费；旗标关闭时调用方根本不会调到这里——零介入）。
 * 对偶价格 p_i = Q_i/V 持续超阈 = 该来源到达率逼近/超出容量域——背压已把它
 * 顶到最高优先级，此时该动的是容量或负载，不是优先级。
 */
export function backpressureInsight(
  queues: readonly number[],
  V: number,
  context?: { names?: readonly string[]; priceThreshold?: number },
): { message: string; suggestion: string; severity: number } | undefined {
  requireVector(queues, 'backpressureInsight: queues');
  if (!Number.isFinite(V) || V <= 0) {
    throw new Error(`backpressureInsight: V=${String(V)} 必须是 > 0 的有限数`);
  }
  const threshold = context?.priceThreshold ?? 1.5;
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error(`backpressureInsight: priceThreshold=${String(threshold)} 必须是 > 0 的有限数`);
  }
  let hot = 0;
  let hotPrice = 0;
  for (let i = 0; i < queues.length; i += 1) {
    const p = queues[i] / V;
    if (p > hotPrice) {
      hotPrice = p;
      hot = i;
    }
  }
  if (hotPrice < threshold) return undefined;
  const name = context?.names?.[hot] ?? `队列#${hot}`;
  return {
    message: `背压瓶颈：${name} 对偶价格 p=Q/V=${hotPrice.toFixed(2)} 超阈 ${threshold}——到达率逼近或超出服务容量，队列稳定性告警（其余队列价格 ${queues.map((q) => (q / V).toFixed(2)).join('/')}`,
    suggestion: '用 lpBenchmark 核对容量域（λ 是否仍在动作凸包支配域内）；持续超阈则对该来源降载/错峰，或扩容其服务动作的 μ——无需调优先级，背压已把它顶到最高',
    severity: Math.min(0.9, 0.5 + 0.15 * hotPrice),
  };
}

// ══════════════════════ R5 进化（第五轮·世界性进化） ══════════════════════
//
// 轴 1（数学）: 多队列加权利亚普诺夫（权重进入背压权重）。
//   V_w(t) = ½·Σ_i w_i·Q_i(t)²，w > 0。逐槽代数恒等式逐项乘 w_i 后逐项
//   保持（w_i > 0 不改变不等号方向）:
//     Δ(½ΣwQ²) ≤ ½Σw(μ²+a²) − Σ w·Q·(μ−a)
//   漂移加罚 argmin 变为 α* = argmin_α [V·cost(α) − Σ_i w_i·Q_i·μ_i(α)]。
//   权重的语义 = **持有成本** c_i（Stolyar 2004 max-pressure: 加权背压
//   argmax Σ c_i Q_i μ_i 在平衡负载的 heavy-traffic 极限下对加权队长目标
//   Σ c_i Q_i 最优）。等权重 w ≡ 1 逐位退化为经典背压（IEEE 乘 1 幂等）;
//   异质服务率场景 cμ 规则 = w=(1,1,…,1) 的加权背压（μ 进了 μ_i 项）。
//   附 workNormalizedWeights: w_i = 1/μ_max,i——队长从「包数」换成
//   「工作量」口径（交换机文献的经典口径切换，供对比/诊断）。
//
// 轴 2（性能）: lpBenchmark 对偶乘子的重解跳过。
//   原实现对每个 λ_i 都做 ±EPS 两次全量顶点枚举（2n 次额外 LP）。但:
//   若最优 π 对约束 i **严格松弛**（Σπμ_i ≥ λ_i + EPS），则 π 对扰动 λ±EPS·e_i
//   仍可行，且任一基问题最优对偶 (y*,ν*) 满足互补松弛 y*_i = 0 ⟹
//   (y*,ν*) 对 λ' 仍对偶可行且 c·π = y*·λ' + ν* ⟹ LP*(λ') = LP*(λ)
//   ——两侧斜率精确为 0，乘子 y_i = 0，**无需重解**。富余约束（对偶乘子
//   为 0 的那些）全部跳过，只有紧约束才重解——输出与全量重解逐位一致
//   （验证脚本带脚本侧朴素参考实现对账）。
// ══════════════════════════════════════════════════════════

/** 加权漂移加罚选项（weights 缺省全 1 = 经典背压） */
export interface WeightedDriftStepOptions extends DriftStepOptions {
  /** 队列权重 w_i > 0（持有成本口径; 长度须与队列数一致） */
  weights?: readonly number[];
}

/** 加权漂移加罚一步结果（在 DriftStepResult 上附权重回显） */
export interface WeightedDriftStepResult extends DriftStepResult {
  weights: number[];
}

/**
 * 加权背压贪心一步: α* = argmin_α [V·cost(α) − Σ_i w_i·Q_i·μ_i(α)]，
 * 漂移证书为加权二次型 ½ΣwQ² 的路径必然不等式（残差 ≥ 0 与经典版同证——
 * 逐项乘 w_i > 0 不改变不等号方向）。weights ≡ 1 时与 driftPlusPenaltyStep 逐位一致。
 */
export function driftPlusPenaltyStepWeighted(
  queues: readonly number[],
  arrivals: readonly number[],
  actionSet: readonly LyapunovAction[],
  options: WeightedDriftStepOptions,
): WeightedDriftStepResult {
  requireVector(queues, 'driftPlusPenaltyStepWeighted: queues');
  requireVector(arrivals, 'driftPlusPenaltyStepWeighted: arrivals');
  if (queues.length !== arrivals.length) {
    throw new Error(`driftPlusPenaltyStepWeighted: queues(${queues.length}) 与 arrivals(${arrivals.length}) 长度必须一致`);
  }
  requireActionSet(actionSet, queues.length, 'driftPlusPenaltyStepWeighted: actionSet');
  requireOptionsShape(options, 'driftPlusPenaltyStepWeighted');
  const n = queues.length;
  const weights = options.weights !== undefined ? [...options.weights] : new Array<number>(n).fill(1);
  if (weights.length !== n) {
    throw new Error(`driftPlusPenaltyStepWeighted: weights(${weights.length}) 长度须与队列数(${n})一致`);
  }
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(weights[i]) || weights[i] <= 0) {
      throw new Error(`driftPlusPenaltyStepWeighted: weights[${i}]=${String(weights[i])} 必须是 > 0 的有限数`);
    }
  }
  const V = options.V;
  const costOf = (a: LyapunovAction): number => (options.cost !== undefined ? options.cost(a) : a.cost);

  let index = 0;
  let score = Number.POSITIVE_INFINITY;
  let penalty = 0;
  let backpressure = 0;
  for (let j = 0; j < actionSet.length; j += 1) {
    const action = actionSet[j];
    const p = V * costOf(action);
    let bp = 0;
    for (let i = 0; i < n; i += 1) bp += weights[i] * queues[i] * action.mu[i];
    const s = p - bp;
    if (s < score) {
      score = s;
      index = j;
      penalty = p;
      backpressure = bp;
    }
  }
  const chosen = actionSet[index];
  const nextQueues = queues.map((q, i) => Math.max(q - chosen.mu[i] + arrivals[i], 0));

  // 加权漂移证书: ½ΣwQ² 口径（逐项乘 w 的路径必然不等式）
  let halfNow = 0;
  let halfNext = 0;
  let driftBound = 0;
  for (let i = 0; i < n; i += 1) {
    halfNow += 0.5 * weights[i] * queues[i] * queues[i];
    halfNext += 0.5 * weights[i] * nextQueues[i] * nextQueues[i];
    driftBound += 0.5 * weights[i] * (chosen.mu[i] * chosen.mu[i] + arrivals[i] * arrivals[i]) - weights[i] * queues[i] * (chosen.mu[i] - arrivals[i]);
  }
  const driftRealized = halfNext - halfNow;
  return {
    action: chosen,
    index,
    nextQueues,
    prices: queues.map((q) => q / V),
    score,
    penalty,
    backpressure,
    driftBound,
    driftRealized,
    certificateResidual: driftBound - driftRealized,
    weights,
  };
}

/**
 * 工作量口径权重: w_i = 1/μ_max,i（μ_max,i = max_j μ_j,i——队列 i 可被服务的
 * 最大速率）。把背压的队长从「包数」换成「工作量」（每队列一个速率归一），
 * 交换机 max-weight 文献的经典口径切换; μ_max,i = 0（该队列无任何动作可
 * 服务）时权重取 1（对不可服务队列加权无意义，诚实保留）。
 */
export function workNormalizedWeights(actionSet: readonly LyapunovAction[]): number[] {
  if (!Array.isArray(actionSet) || actionSet.length === 0) throw new Error('workNormalizedWeights: actionSet 必须非空');
  const n = actionSet[0].mu.length;
  const muMax = new Array<number>(n).fill(0);
  for (const a of actionSet) {
    if (!Array.isArray(a.mu) || a.mu.length !== n) throw new Error(`workNormalizedWeights: 动作 ${a.id} 的 mu 长度须为 ${n}`);
    for (let i = 0; i < n; i += 1) {
      const v = a.mu[i];
      if (!Number.isFinite(v) || v < 0) throw new Error(`workNormalizedWeights: 动作 ${a.id}.mu[${i}]=${String(v)} 必须是有限非负数`);
      if (v > muMax[i]) muMax[i] = v;
    }
  }
  return muMax.map((m) => (m > 0 ? 1 / m : 1));
}

// ─────────────────────────── 接线建议 ───────────────────────────
// 1) 建议挂载引擎: 任务执行器（src/task-executor.ts 派发回路）的背压调度——
//    每个派发槽把「候选执行池 × 各池积压（未完成工作量）」折算成动作集
//    LyapunovAction（μ = 本槽可完成量，cost = 预计 token/延迟成本），调
//    driftPlusPenaltyStep 得 α。积压本身就是优先级，队列稳定性由
//    [O(1/V), O(V)] 定理背书；同构可挂 src/tenant/tenant-manager.ts 的
//    租户公平（每租户一队列，cost 计入配额消耗——公平与成本一次 argmin 联合优化）。
// 2) 缺省关闭旗标: LYAPUNOV_BACKPRESSURE_ENABLED（缺省 false）——关闭时执行
//    器走原有派发路径，心跳零增量、行为逐位一致（纯分析内核，零介入）。
// 3) 挂载后改变的决策点: （a）派发优先级从静态权重 → 背压权重 Q_i/V;
//    （b）V 成为成本-延迟旋钮（V↑ 平均成本贴近 LP 最优、平均队长升；
//    V↓ 响应快、成本次优）——按租户 SLO 分档; （c）对偶价格 p_i 持续高位
//    = 到达率逼近容量域边界，作为容量告警喂给 41.0 瓶颈洞察与 25.0 扩容反解
//    （backpressureInsight 即该桥）。
// 4) 只读伴生: lpBenchmark / dualPrices 供规划侧离线核算容量域与影子价格，
//    不进任何热路径。
