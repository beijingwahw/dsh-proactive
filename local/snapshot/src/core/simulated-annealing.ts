/**
 * simulated-annealing.ts — 66.0 模拟退火内核（随机优化双件套之一：单目标全局逃逸）
 *
 * 动机: 18.0 信息几何把策略进化器的变异搬上 Fisher 流形（局部精修），
 * 58.0 朗之万采样让变异「按后验走」——但两者都在**单个吸引盆地内部**做
 * 精细工作，谁也不负责「跳出当前盆地」。适应度地形一旦多峰（策略空间
 * 的常态而非例外），所有只降不升的局部方法都被势阱囚禁：贪心爬山在
 * 第一个局部最优处永久驻留，进化变异靠盲目噪声撞大运。系统缺一台
 * 「温度计 + 跳坑许可证」：前期高温敢于上山（接受劣化解），后期低温
 * 冷凝精修——而且降温的快慢本身是一则有收敛定理的纪律，不是拍脑袋。
 *
 * 数学:
 * 1. Metropolis 准则（1953）: 在状态 x 提议邻居 x′，ΔE = E(x′) − E(x)，
 *      ΔE ≤ 0 必接受；ΔE > 0 以概率 exp(−ΔE/T) 接受。
 *    对称提议（q(x′|x) = q(x|x′)）+ 该准则 ⟹ 鮸尔可夫链满足细致平衡
 *      π(x)·P(x→x′) = π(x′)·P(x′→x)，π(x) ∝ e^{−E(x)/T}（Boltzmann）。
 *    温度 T 是「劣性容忍度」：T→∞ 均匀随机游走，T→0 纯贪心，
 *    中间温度 = 在「利用当前盆地」与「探索未知盆地」之间按能级差定价。
 *
 * 2. Hajek 定理（1988）: 对数降温 T_k = c / log(k + k₀)（k₀ ≥ 2 保
 *    T₁ > 0 且衰减充分慢）下，链收敛到全局最优集 **当且仅当 c 不小于
 *    势阱深度 d\*（实例的临界深度）**。c 过小时存在正概率被深于 c 的
 *    井永久捕获——降温快不是「快而略差」，是「没有保证」；几何降温
 *    T_k = T₀·r^k 在有限步内必然冻死（Σ T_k < ∞ 违反缓慢降温条件），
 *    命中率只能诚实报告。本内核对小实例**精确计算 d\***：势阱深度 =
 *    逃离局部极小所需的最小爬升高度（minimax 路径高度 − 井底能级），
 *    在状态图上用瓶颈最短路（Dijkstra 变体：dist = 路径上最大能级）
 *    精确求解——Hajek 条件第一次不是纸面常数，而是可枚举可断言的量。
 *
 * 3. TSP 实例工厂: 种子化**双簇**欧氏距离矩阵（mulberry32 城市坐标，
 *    紧簇制造量级为簇间距的真实势阱），2-opt 邻域（段反转——对称提议，
 *    细致平衡成立）；n ≤ 8 时全排列枚举给出精确最优（固定首城
 *    (n−1)! 个排列），SA 的命中率有了真值分母——「命中全局最优」
 *    从口头变成可数事件。
 *
 * 验证锚点（scripts/verify-stochastic-optimization.mjs）:
 * ① 三状态玩具（能级 {0,1,3} 全连通）定温 T=1 长链（30 万步）:
 *    状态频率 vs boltzmannFrequencies 解析权重的最大偏差 < 0.02
 *    （细致平衡 ⟹ Boltzmann 平稳分布的实证）；
 * ② 种子化双簇 TSP（6 城，固定首城后恰 120 个排列全枚举最优已知）:
 *    相邻交换稀疏邻域的 720 状态图上精确计算 d\*，对数降温 c = d\* 时
 *    ≥ 90% 种子命中最优，c 减半命中率显著更低（Hajek 充分条件的实证）；
 * ③ 几何降温多档（r=0.9995 缓冷 / 0.99 / 0.9 淬火）命中率诚实报告成表
 *    （淬火 ≤ 缓冷），温度轨迹逐点对照闭式 T₀·r^(k−1)；
 * ④ 同实例纯贪心（T=1e-12）易困局部最优: 命中率 ≪ SA 对数档；同实例
 *    2-opt 稠密邻域贪心即满命中（d\* ≈ 0 的无井地形）——邻域密度
 *    决定地形难度的旁证；
 * ⑤ wellDepth 手算图对照（瓶颈高度 4 − 井底 2 = 深度 2）+ 同种子
 *    逐位复现（同输入同输出）。
 *
 * R5 进化（拓扑动力内核第五轮）:
 * ⑥ 并行回火 parallelTempering（replica exchange, Swendsen–Wang 1986）:
 *    R 条副本各守一档温度（几何阶梯），各自 Metropolis 推进；每隔
 *    swapEvery 步相邻副本尝试**交换状态**（冷副本收留低能态、热副本
 *    背走高能态继续翻山）。交换接受率 min(1, exp((βᵢ−βⱼ)(Eᵢ−Eⱼ)))
 *    以纯 log 域裁决（min(0,·) 钳位 + log u 比较——大 |ΔE·Δβ| 无 exp
 *    溢出）。单链几何降温的 Σ T_k < ∞ 冻死问题被结构性解决: 热副本
 *    永远高温可翻任意井，冷副本通过交换**免费获得**翻越后的低能态。
 * ⑦ Luby 通用最优重启序列 lubySequence（Luby–Sinclair–Zuckerman 1993）
 *    + annealWithRestarts: 未知运行时长分布（重尾情形含无界均值）下，
 *    2 的幂次倍增重启序列是竞争比意义下的通用最优——重启步长第一次
 *    不是拍脑袋，而是带定理的纪律。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
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

// ─────────────────────────── 降温计划 ───────────────────────────

/** 降温计划（判别联合类型；strip-types 兼容，不用 enum） */
export type AnnealSchedule =
  | { kind: 'log'; c: number; k0?: number }
  | { kind: 'geometric'; T0: number; rate: number }
  | { kind: 'constant'; T: number };

/** 校验降温计划并返回规范化副本（缺省 k0=2；违反约束显式 throw） */
function validateSchedule(schedule: AnnealSchedule): AnnealSchedule {
  switch (schedule.kind) {
    case 'log': {
      if (!Number.isFinite(schedule.c) || schedule.c <= 0) {
        throw new Error(`simulated-annealing: log 降温要求 c > 0（收到 ${schedule.c}；Hajek 定理的 c 应 ≥ 势阱深度 d）`);
      }
      const k0 = schedule.k0 ?? 2;
      if (!Number.isInteger(k0) || k0 < 2) {
        throw new Error(`simulated-annealing: log 降温要求整数 k0 ≥ 2（收到 ${k0}；保 T₁ = c/log(1+k0) > 0 且衰减充分慢）`);
      }
      return { kind: 'log', c: schedule.c, k0 };
    }
    case 'geometric': {
      if (!Number.isFinite(schedule.T0) || schedule.T0 <= 0) {
        throw new Error(`simulated-annealing: geometric 降温要求 T0 > 0（收到 ${schedule.T0}）`);
      }
      if (!Number.isFinite(schedule.rate) || schedule.rate <= 0 || schedule.rate >= 1) {
        throw new Error(`simulated-annealing: geometric 降温要求 0 < rate < 1（收到 ${schedule.rate}；rate=1 是常数温度，请用 kind:'constant'）`);
      }
      return { kind: 'geometric', T0: schedule.T0, rate: schedule.rate };
    }
    case 'constant': {
      if (!Number.isFinite(schedule.T) || schedule.T <= 0) {
        throw new Error(`simulated-annealing: constant 降温要求 T > 0（收到 ${schedule.T}；T=0 的贪心极限请用极小正温度代替）`);
      }
      return { kind: 'constant', T: schedule.T };
    }
    default:
      throw new Error(`simulated-annealing: 未知降温计划 kind '${(schedule as { kind?: string }).kind}'`);
  }
}

/**
 * 第 k 步温度（k 从 1 起，闭式）:
 *   log:       T_k = c / log(k + k0)      —— Hajek 对数降温
 *   geometric: T_k = T0 · rate^(k−1)      —— 指数淬火（下溢到 0 时钳到
 *                Number.MIN_VALUE——淬火的诚实极限即贪心，不 throw）
 *   constant:  T_k = T
 */
export function scheduleTemperature(schedule: AnnealSchedule, step: number): number {
  const s = validateSchedule(schedule);
  if (!Number.isInteger(step) || step < 1) {
    throw new Error(`simulated-annealing: 温度下标 step 须为 ≥ 1 的整数（收到 ${step}）`);
  }
  switch (s.kind) {
    case 'log':
      return s.c / Math.log(step + (s.k0 ?? 2));
    case 'geometric':
      return s.T0 * Math.pow(s.rate, step - 1) || Number.MIN_VALUE;
    case 'constant':
      return s.T;
    default:
      throw new Error('simulated-annealing: 不可达分支');
  }
}

// ─────────────────────────── Metropolis 准则 ───────────────────────────

/** 单步 Metropolis 结果 */
export interface MetropolisOutcome<T> {
  /** 接受则为新状态，拒绝则原状态 */
  state: T;
  /** 结果状态的能级 */
  energy: number;
  /** 提议的能级增量 ΔE = E(候选) − E(当前) */
  deltaE: number;
  /** 是否接受（ΔE ≤ 0 必接受；ΔE > 0 按 exp(−ΔE/T) 抽签） */
  accepted: boolean;
  /** 本步接受概率（ΔE ≤ 0 时为 1） */
  acceptanceProbability: number;
}

/**
 * Metropolis 单步：propose → 计能 → 按 exp(−ΔE/T) 裁决。
 * rng 消费纪律: neighbor 内部消费次数由其自身决定；接受判定恒消费恰好一次
 * u ~ U(0,1)（ΔE ≤ 0 时该抽样不参与结果但照常消耗——保证同种子同轨迹）。
 */
export function metropolisStep<T>(
  state: T,
  energy: (x: T) => number,
  neighbor: (x: T, rng: () => number) => T,
  temperature: number,
  rng: () => number,
): MetropolisOutcome<T> {
  if (!Number.isFinite(temperature) || temperature <= 0) {
    throw new Error(`simulated-annealing: Metropolis 温度须为正有限数（收到 ${temperature}）`);
  }
  const candidate = neighbor(state, rng);
  const e0 = energy(state);
  const e1 = energy(candidate);
  if (!Number.isFinite(e0) || !Number.isFinite(e1)) {
    throw new Error(`simulated-annealing: 能级须为有限数（E(x)=${e0}, E(x')=${e1}）`);
  }
  const deltaE = e1 - e0;
  const acceptanceProbability = deltaE <= 0 ? 1 : Math.exp(-deltaE / temperature);
  const u = rng();
  const accepted = deltaE <= 0 || u < acceptanceProbability;
  return {
    state: accepted ? candidate : state,
    energy: accepted ? e1 : e0,
    deltaE,
    accepted,
    acceptanceProbability,
  };
}

// ─────────────────────────── Boltzmann 解析权重 ───────────────────────────

/** Boltzmann 解析权重: w_i = e^{−E_i/T} / Z（定温细致平衡的平稳分布） */
export function boltzmannFrequencies(energies: number[], temperature: number): { weights: number[]; partition: number } {
  if (!Array.isArray(energies) || energies.length === 0) {
    throw new Error('simulated-annealing: energies 须为非空数组');
  }
  if (!Number.isFinite(temperature) || temperature <= 0) {
    throw new Error(`simulated-annealing: Boltzmann 温度须为正有限数（收到 ${temperature}）`);
  }
  // 数值稳定: 以最小能级为零点重整（权重对公共平移不变）
  const minE = Math.min(...energies);
  const unnormalized = energies.map((e) => {
    if (!Number.isFinite(e)) throw new Error(`simulated-annealing: 能级须为有限数（收到 ${e}）`);
    return Math.exp(-(e - minE) / temperature);
  });
  const partition = unnormalized.reduce((s, w) => s + w, 0);
  return { weights: unnormalized.map((w) => w / partition), partition };
}

// ─────────────────────────── 势阱深度（小图精确） ───────────────────────────

/** 单个局部极小的井报告 */
export interface WellReport {
  state: string;
  /** 井底能级 */
  energy: number;
  /** 逃离该井的最小爬升高度 = minimax 路径高度 − 井底能级 */
  depth: number;
  /** 翻越瓶颈后到达的首个更低能级状态 */
  escapeState: string | null;
}

/** wellDepth 结果 */
export interface WellDepthReport {
  /** 临界势阱深度 d = max(各局部极小深度)；无局部极小井时为 0 */
  criticalDepth: number;
  /** 各局部极小的井报告（按深度降序） */
  wells: WellReport[];
  /** 全局最优状态集 */
  globalMinima: string[];
}

/**
 * 精确势阱深度（Hajek 的临界深度 d）——离散小图专用。
 *
 * 输入: energies（各状态能级）+ adjacency（对称邻接表；须与 Metropolis
 * 的提议结构一致——对称性是细致平衡的前提）。
 *
 * 算法: 对每个「邻域内无更低能级」的局部极小 s（全局最优除外），
 *   以 s 为源做**瓶颈最短路**（Dijkstra 变体: dist[v] = 路径上最大能级
 *   的最小值，O(V²) 线性扫最小点），到达任一更低能级状态 y 的瓶颈高度
 *   记 H(s)；depth(s) = H(s) − E(s)。不可达任何更低能级时深度 = ∞
 *   （非连通图的诚实报告）。
 */
export function wellDepth(energies: Record<string, number>, adjacency: Record<string, string[]>): WellDepthReport {
  const states = Object.keys(energies);
  if (states.length === 0) throw new Error('simulated-annealing: energies 须为非空映射');
  for (const s of states) {
    if (!Number.isFinite(energies[s])) {
      throw new Error(`simulated-annealing: 状态 ${s} 的能级须为有限数（收到 ${energies[s]}）`);
    }
  }
  // 邻接表校验: 覆盖、已知状态、对称
  for (const [u, neighbors] of Object.entries(adjacency)) {
    if (!Object.prototype.hasOwnProperty.call(energies, u)) {
      throw new Error(`simulated-annealing: 邻接表含未知状态 '${u}'（不在 energies 中）`);
    }
    for (const v of neighbors) {
      if (!Object.prototype.hasOwnProperty.call(energies, v)) {
        throw new Error(`simulated-annealing: 状态 '${u}' 的邻居 '${v}' 不在 energies 中`);
      }
      const back = adjacency[v];
      if (!Array.isArray(back) || !back.includes(u)) {
        throw new Error(`simulated-annealing: 邻接不对称（${v} 的邻居表缺 ${u}）——对称提议是细致平衡的前提`);
      }
    }
  }
  const minE = Math.min(...states.map((s) => energies[s]));
  const globalMinima = states.filter((s) => energies[s] === minE);

  // 局部极小: 邻域内无严格更低能级（且本身非全局最优才可能有正深度）
  const localMinima = states.filter((s) => {
    const nb = adjacency[s] ?? [];
    return nb.every((v) => energies[v] >= energies[s]);
  });

  const wells: WellReport[] = [];
  for (const s of localMinima) {
    if (energies[s] === minE) continue; // 全局最优不是井
    // 瓶颈 Dijkstra: dist[v] = 从 s 出发路径上（含端点）最大能级的最小值
    const dist = new Map<string, number>();
    for (const v of states) dist.set(v, Number.POSITIVE_INFINITY);
    dist.set(s, energies[s]);
    const settled = new Set<string>();
    let bottleneck: { target: string; height: number } | null = null;
    while (true) {
      let current: string | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const v of states) {
        if (!settled.has(v) && dist.get(v)! < bestDist) {
          bestDist = dist.get(v)!;
          current = v;
        }
      }
      if (current === null) break;
      settled.add(current);
      if (energies[current] < energies[s]) {
        // 首次以最小瓶颈高度触达更低能级——瓶颈 Dijkstra 的贪心序保证最优
        bottleneck = { target: current, height: bestDist };
        break;
      }
      for (const w of adjacency[current] ?? []) {
        if (settled.has(w)) continue;
        const cand = Math.max(bestDist, energies[w]);
        if (cand < dist.get(w)!) dist.set(w, cand);
      }
    }
    wells.push({
      state: s,
      energy: energies[s],
      depth: bottleneck === null ? Number.POSITIVE_INFINITY : bottleneck.height - energies[s],
      escapeState: bottleneck === null ? null : bottleneck.target,
    });
  }
  wells.sort((a, b) => b.depth - a.depth);
  const criticalDepth = wells.length > 0 ? wells[0]!.depth : 0;
  return { criticalDepth, wells, globalMinima };
}

// ─────────────────────────── 主退火循环 ───────────────────────────

/** anneal 配置 */
export interface AnnealConfig<T> {
  /** 能级函数 E(x)（越低越好） */
  energy: (x: T) => number;
  /** 邻提议 x → x′（须对称: q(x′|x) = q(x|x′)，细致平衡的前提） */
  neighbor: (x: T, rng: () => number) => T;
  /** 初始状态 */
  x0: T;
  /** 降温计划（log / geometric / constant） */
  schedule: AnnealSchedule;
  /** 总步数（≥ 1） */
  steps: number;
  /** PRNG 种子（内部 mulberry32；同 (输入, seed) 逐位复现） */
  seed: number;
  /** 轨迹抽样间隔（缺省 max(1, ⌊steps/40⌋)；另记第 0 步与末步） */
  traceEvery?: number;
}

/** 轨迹采样点 */
export interface AnnealTracePoint {
  step: number;
  temperature: number;
  /** 当前态能级 */
  energy: number;
  /** 迄今最优能级 */
  bestEnergy: number;
}

/** anneal 结果 */
export interface AnnealResult<T> {
  /** 迄今最优状态（严格更优才更新——并列保持先到者） */
  best: T;
  bestEnergy: number;
  /** 末态（马尔可夫链终点，可能是次优解） */
  finalState: T;
  finalEnergy: number;
  iterations: number;
  /** 接受步数与接受率（链健康度: 过高=白噪声游走，过低=冻死） */
  acceptedMoves: number;
  acceptanceRate: number;
  trace: AnnealTracePoint[];
  schedule: AnnealSchedule;
  seed: number;
}

/**
 * 模拟退火主循环: 第 k 步温度 T_k = scheduleTemperature(schedule, k)，
 * metropolisStep 推进；记录 best-so-far 与稀疏轨迹。
 * 能量/邻居函数须把状态当不可变值（内核持有引用但不修改）。
 */
export function anneal<T>(config: AnnealConfig<T>): AnnealResult<T> {
  const schedule = validateSchedule(config.schedule);
  if (!Number.isInteger(config.steps) || config.steps < 1) {
    throw new Error(`simulated-annealing: steps 须为 ≥ 1 的整数（收到 ${config.steps}）`);
  }
  const traceEvery = config.traceEvery ?? Math.max(1, Math.floor(config.steps / 40));
  if (!Number.isInteger(traceEvery) || traceEvery < 1) {
    throw new Error(`simulated-annealing: traceEvery 须为 ≥ 1 的整数（收到 ${traceEvery}）`);
  }
  const rng = mulberry32(config.seed);
  let state = config.x0;
  let e = config.energy(config.x0);
  if (!Number.isFinite(e)) throw new Error(`simulated-annealing: 初始能级须为有限数（收到 ${e}）`);
  let best = config.x0;
  let bestEnergy = e;
  let accepted = 0;
  const trace: AnnealTracePoint[] = [{ step: 0, temperature: scheduleTemperature(schedule, 1), energy: e, bestEnergy: e }];
  for (let k = 1; k <= config.steps; k += 1) {
    const T = scheduleTemperature(schedule, k);
    const step = metropolisStep(state, config.energy, config.neighbor, T, rng);
    state = step.state;
    e = step.energy;
    if (step.accepted) accepted += 1;
    if (e < bestEnergy) {
      bestEnergy = e;
      best = state;
    }
    if (k % traceEvery === 0 || k === config.steps) {
      trace.push({ step: k, temperature: T, energy: e, bestEnergy });
    }
  }
  return {
    best,
    bestEnergy,
    finalState: state,
    finalEnergy: e,
    iterations: config.steps,
    acceptedMoves: accepted,
    acceptanceRate: accepted / config.steps,
    trace,
    schedule,
    seed: config.seed,
  };
}

// ─────────────────────────── 种子化 TSP 实例 ───────────────────────────

/** 种子化欧氏 TSP 实例（城市坐标 ∈ [0,1]²，距离矩阵预计算） */
export interface TspInstance {
  n: number;
  seed: number;
  cities: Array<{ x: number; y: number }>;
  /** 距离矩阵（对称，对角 0） */
  distance: (i: number, j: number) => number;
}

/**
 * 构造种子化**双簇**欧氏 TSP 实例（n ≥ 3 座城市；同 seed 逐位复现）:
 * 城市按奇偶下标分属左下/右上两个半径 0.06 的紧簇（簇心距 ≈ 0.79）。
 * 设计动机: 均匀随机小实例的 2-opt 地形近乎无井（d* → 0，SA 与贪心
 * 无差别——Hajek 条件无从实证）；双簇结构迫使「修好簇间穿插」的 2-opt
 * 移动暂时容忍更长的巡回，形成量级为「簇间距 − 簇内距」的真实势阱
 * ——对数降温的 c 与 d\* 才有可观测的对照差。
 */
export function tspInstance(n: number, seed: number): TspInstance {
  if (!Number.isInteger(n) || n < 3) {
    throw new Error(`simulated-annealing: TSP 城市数须为 ≥ 3 的整数（收到 ${n}）`);
  }
  const rng = mulberry32(seed);
  const CENTERS: Array<[number, number]> = [
    [0.22, 0.22],
    [0.78, 0.78],
  ];
  const RADIUS = 0.06;
  const cities = Array.from({ length: n }, (_, i) => {
    const [cx, cy] = CENTERS[i % 2]!;
    return { x: cx + (rng() - 0.5) * 2 * RADIUS, y: cy + (rng() - 0.5) * 2 * RADIUS };
  });
  const matrix: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const dx = cities[i]!.x - cities[j]!.x;
      const dy = cities[i]!.y - cities[j]!.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      matrix[i]![j] = d;
      matrix[j]![i] = d;
    }
  }
  return {
    n,
    seed,
    cities,
    distance: (i, j) => {
      if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= n || j >= n) {
        throw new Error(`tsp: 城市下标越界 (${i}, ${j})，合法范围 [0, ${n})`);
      }
      return matrix[i]![j]!;
    },
  };
}

/** 闭环巡回长度: Σ d(t_k, t_{k+1 mod n})（tour 须为 0..n−1 的排列） */
export function tspTourLength(instance: TspInstance, tour: number[]): number {
  if (!Array.isArray(tour) || tour.length !== instance.n) {
    throw new Error(`tsp: tour 长度须等于城市数 ${instance.n}（收到 ${tour?.length}）`);
  }
  const seen = new Set<number>();
  let length = 0;
  for (let k = 0; k < tour.length; k += 1) {
    const city = tour[k];
    if (!Number.isInteger(city) || city < 0 || city >= instance.n || seen.has(city)) {
      throw new Error(`tsp: tour 位置 ${k} 的 ${city} 非法（须为 0..${instance.n - 1} 的不重复排列）`);
    }
    seen.add(city);
    length += instance.distance(city, tour[(k + 1) % tour.length]!);
  }
  return length;
}

/**
 * 2-opt 邻提议: 均匀抽 a ≠ b，反转 tour[min..max] 段（含端点）。
 * 段反转是**对合**（再反转一次回到原巡回）⟹ 对称提议 q(x′|x)=q(x|x′)，
 * Metropolis 细致平衡成立。rng 消费: 拒绝重抽直至 a≠b（期望 2 次以内）。
 * 邻域稠密（每态 C(n,2) 级邻）——小实例地形近乎无井（d* ≈ 0，
 * 贪心与 SA 无差别）；要实证 Hajek 条件请用稀疏的相邻交换邻域。
 */
export function tspTwoOptNeighbor(tour: number[], rng: () => number): number[] {
  const n = tour.length;
  if (n < 3) throw new Error(`tsp: 2-opt 至少需要 3 座城市（收到 ${n}）`);
  let a = Math.floor(rng() * n);
  let b = Math.floor(rng() * n);
  while (a === b) {
    a = Math.floor(rng() * n);
    b = Math.floor(rng() * n);
  }
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const next = [...tour];
  for (let k = 0; k <= hi - lo; k += 1) next[lo + k] = tour[hi - k]!;
  return next;
}

/**
 * 相邻交换邻提议: 均匀抽 i ∈ [0, n−2)，交换 tour[i] 与 tour[i+1]。
 * 交换是**对合** ⟹ 对称提议，细致平衡成立。邻域稀疏（每态恰 n−1 邻）
 * ——小实例也有真井（簇间穿插的修复须逐步换位、途经更差巡回），
 * 是 Hajek 对数降温条件可实证的 TSP 地形；rng 消费恒一次。
 */
export function tspAdjacentSwapNeighbor(tour: number[], rng: () => number): number[] {
  const n = tour.length;
  if (n < 3) throw new Error(`tsp: 相邻交换至少需要 3 座城市（收到 ${n}）`);
  const i = Math.floor(rng() * (n - 1));
  const next = [...tour];
  const tmp = next[i]!;
  next[i] = next[i + 1]!;
  next[i + 1] = tmp;
  return next;
}

/** 全排列枚举精确最优（固定首城 0 消旋转对称，(n−1)! 个排列；n ≤ 8 防爆炸） */
export function tspExactOptimum(instance: TspInstance): { tour: number[]; length: number; permutations: number } {
  if (instance.n > 8) {
    throw new Error(`tsp: 全枚举仅支持 n ≤ 8（收到 ${instance.n}）——大实例请用 anneal + tspTwoOptNeighbor`);
  }
  const rest: number[] = [];
  for (let c = 1; c < instance.n; c += 1) rest.push(c);
  let bestTour: number[] = [0, ...rest];
  let bestLength = Number.POSITIVE_INFINITY;
  let count = 0;
  const visit = (prefix: number[], remaining: number[]): void => {
    if (remaining.length === 0) {
      count += 1;
      const tour = [...prefix];
      const len = tspTourLength(instance, tour);
      if (len < bestLength) {
        bestLength = len;
        bestTour = tour;
      }
      return;
    }
    for (let i = 0; i < remaining.length; i += 1) {
      visit([...prefix, remaining[i]!], [...remaining.slice(0, i), ...remaining.slice(i + 1)]);
    }
  };
  visit([0], rest);
  return { tour: bestTour, length: bestLength, permutations: count };
}

// ─────────────────────────── R5: 并行回火（replica exchange） ───────────────────────────

/** 并行回火配置 */
export interface ParallelTemperingConfig<T> {
  /** 能级函数 E(x)（越低越好） */
  energy: (x: T) => number;
  /** 对称邻提议（与 anneal 同口径: q(x′|x) = q(x|x′)） */
  neighbor: (x: T, rng: () => number) => T;
  /** 初始状态（全部副本同起点；T 本身可为数组——不与 x0s 混淆） */
  x0: T;
  /** 每副本独立起点（可选; 长度须 = replicas, 提供时覆盖 x0） */
  x0s?: T[];
  /** 副本数 ≥ 2 */
  replicas: number;
  /** 温度阶梯: 升序正数数组（长度 = replicas）或 {tMin, tMax}（几何阶梯 tMin·(tMax/tMin)^(i/(R−1))） */
  ladder: number[] | { tMin: number; tMax: number };
  /** 每副本步数 ≥ 1 */
  steps: number;
  /** 每多少步尝试一轮相邻交换 ≥ 1 */
  swapEvery: number;
  /** PRNG 种子（同 (输入, seed) 逐位复现） */
  seed: number;
}

/** 并行回火结果 */
export interface ParallelTemperingResult<T> {
  /** 全副本迄今最优状态 */
  best: T;
  bestEnergy: number;
  /** 温度阶梯（升序） */
  ladder: number[];
  /** 各副本末态（温度升序; acceptanceRate = 本副本接受步数/总步数） */
  replicasFinal: Array<{ temperature: number; energy: number; acceptanceRate: number }>;
  /** 各副本全程平均能级（单调性锚点: 温度越高平均能级应越高） */
  meanEnergies: number[];
  swapsAttempted: number;
  swapsAccepted: number;
  /** 交换接受率（健康阶梯应在 (0,1) 开区间内——0 = 阶梯断开, 1 = 温差白设） */
  swapRate: number;
  iterations: number;
  seed: number;
}

/**
 * 并行回火（Swendsen–Wang 1985/86）: R 条副本各守一档温度并行 Metropolis,
 * 周期性相邻交换——交换的细致平衡在**联合状态空间**上成立:
 *   目标 π(x₁..x_R) ∝ Πᵢ e^{−E(xᵢ)/Tᵢ}（副本独立 Boltzmann 的乘积）,
 *   交换 xᵢ ↔ xⱼ 的接受率 = min(1, e^{(βᵢ−βⱼ)(Eᵢ−Eⱼ)})——冷副本（β 大）
 *   偏爱收留低能态, 热副本把高能态背走继续翻山; 单链几何降温 ΣT_k < ∞
 *   必然冻死的结构性解法。
 *
 * 数值纪律（R5 轴 3）: 交换裁决纯 log 域——logP = min(0, (βᵢ−βⱼ)(Eᵢ−Eⱼ)),
 * 抽签比较 Math.log(u) < logP（大 |ΔE·Δβ| 时 exp 上溢/下溢都不发生;
 * u=0 的 log 为 −∞, 对应必然接受的正确极限）。交换轮次交替升序/降序扫描
 * （偶轮 i 升、奇轮 i 降）——并行回火文献的 odd-even 约定, 序确定。
 */
export function parallelTempering<T>(config: ParallelTemperingConfig<T>): ParallelTemperingResult<T> {
  const R = config.replicas;
  if (!Number.isInteger(R) || R < 2) {
    throw new Error(`simulated-annealing: replicas 须为 ≥ 2 的整数（收到 ${R}）`);
  }
  if (!Number.isInteger(config.steps) || config.steps < 1) {
    throw new Error(`simulated-annealing: steps 须为 ≥ 1 的整数（收到 ${config.steps}）`);
  }
  if (!Number.isInteger(config.swapEvery) || config.swapEvery < 1) {
    throw new Error(`simulated-annealing: swapEvery 须为 ≥ 1 的整数（收到 ${config.swapEvery}）`);
  }
  if (!Number.isFinite(config.seed)) throw new Error(`simulated-annealing: seed 须为有限数`);
  let ladder: number[];
  if (Array.isArray(config.ladder)) {
    if (config.ladder.length !== R) {
      throw new Error(`simulated-annealing: ladder 数组长度须等于 replicas（${R} vs ${config.ladder.length}）`);
    }
    ladder = [...config.ladder];
  } else {
    const { tMin, tMax } = config.ladder;
    if (!Number.isFinite(tMin) || !Number.isFinite(tMax) || !(tMin > 0) || !(tMax > tMin)) {
      throw new Error(`simulated-annealing: ladder 几何阶梯须 0 < tMin < tMax（收到 ${tMin}, ${tMax}）`);
    }
    ladder = Array.from({ length: R }, (_, i) => tMin * Math.pow(tMax / tMin, i / (R - 1)));
  }
  for (const t of ladder) {
    if (!Number.isFinite(t) || !(t > 0)) throw new Error(`simulated-annealing: 阶梯温度须为正有限数（收到 ${t}）`);
  }
  for (let i = 1; i < ladder.length; i += 1) {
    if (!(ladder[i]! > ladder[i - 1]!)) throw new Error('simulated-annealing: 阶梯温度须严格升序');
  }
  const betas = ladder.map((t) => 1 / t);
  const states: T[] = config.x0s !== undefined ? [...config.x0s] : Array.from({ length: R }, () => config.x0);
  if (states.length !== R) {
    throw new Error(`simulated-annealing: x0s 长度须等于 replicas（${R} vs ${states.length}）`);
  }
  const rng = mulberry32(config.seed);
  const energies = states.map((s) => config.energy(s));
  for (const e of energies) {
    if (!Number.isFinite(e)) throw new Error(`simulated-annealing: 初始能级须为有限数（收到 ${e}）`);
  }
  let best: T = states[0]!;
  let bestEnergy = energies[0]!;
  for (let i = 1; i < R; i += 1) {
    if (energies[i]! < bestEnergy) {
      bestEnergy = energies[i]!;
      best = states[i]!;
    }
  }
  const acceptedCounts = new Array<number>(R).fill(0);
  const energySums = [...energies];
  let swapsAttempted = 0;
  let swapsAccepted = 0;
  for (let k = 1; k <= config.steps; k += 1) {
    for (let i = 0; i < R; i += 1) {
      const step = metropolisStep(states[i]!, config.energy, config.neighbor, ladder[i]!, rng);
      states[i] = step.state;
      energies[i] = step.energy;
      if (step.accepted) acceptedCounts[i]! += 1;
      if (step.energy < bestEnergy) {
        bestEnergy = step.energy;
        best = step.state;
      }
    }
    for (let i = 0; i < R; i += 1) energySums[i]! += energies[i]!;
    if (k % config.swapEvery === 0) {
      const ascending = (k / config.swapEvery) % 2 === 1; // 偶轮升序、奇轮降序（odd-even 约定）
      for (let idx = 0; idx < R - 1; idx += 1) {
        const i = ascending ? idx : R - 2 - idx;
        const j = i + 1;
        swapsAttempted += 1;
        // log 域裁决: logP = min(0, (βᵢ−βⱼ)(Eᵢ−Eⱼ)); 接受 ⟺ log u < logP
        const logP = Math.min(0, (betas[i]! - betas[j]!) * (energies[i]! - energies[j]!));
        const u = rng();
        const accept = logP >= 0 ? u < 1 : Math.log(u === 0 ? Number.MIN_VALUE : u) < logP;
        if (accept) {
          const tmpS = states[i]!;
          states[i] = states[j]!;
          states[j] = tmpS;
          const tmpE = energies[i]!;
          energies[i] = energies[j]!;
          energies[j] = tmpE;
          swapsAccepted += 1;
        }
      }
    }
  }
  const iterations = config.steps;
  return {
    best,
    bestEnergy,
    ladder,
    replicasFinal: ladder.map((t, i) => ({
      temperature: t,
      energy: energies[i]!,
      acceptanceRate: acceptedCounts[i]! / iterations,
    })),
    meanEnergies: energySums.map((s) => s / (iterations + 1)),
    swapsAttempted,
    swapsAccepted,
    swapRate: swapsAttempted > 0 ? swapsAccepted / swapsAttempted : 0,
    iterations,
    seed: config.seed,
  };
}

// ─────────────────────────── R5: Luby 通用最优重启序列 ───────────────────────────

/**
 * Luby 重启序列（Luby–Sinclair–Zuckerman 1993）:
 *   s(1)=1; s(n) = 2^(k−1) 若 n = 2^k − 1, 否则 s(n) = s(n − 2^⌊log₂n⌋ + 1)
 *   ⟹ 1,1,2,1,1,2,4,1,1,2,1,1,2,4,8,…
 *
 * 定理（最优重启）: 对未知求解时长分布（含重尾/无界均值）的随机算法，
 * 以 s(n)·base 为第 n 次重启步长的期望完成时间是所有重启策略的下确界
 * 的 O(log) 因子内——不假设分布的通用最优。返回前 length 项（base 倍乘）。
 */
export function lubySequence(length: number, base = 1): number[] {
  if (!Number.isInteger(length) || length < 1 || length > 1_000_000) {
    throw new Error(`simulated-annealing: length 须为 1..1000000 的整数（收到 ${length}）`);
  }
  if (!Number.isFinite(base) || base <= 0) {
    throw new Error(`simulated-annealing: base 须为正数（收到 ${base}）`);
  }
  const out: number[] = [];
  for (let n = 1; n <= length; n += 1) out.push(lubyAt(n) * base);
  return out;
}

/** Luby 序列第 n 项（1,1,2,1,1,2,4,…; O(log n) 递归深度） */
function lubyAt(n: number): number {
  if (n === 1) return 1;
  let k = 1;
  while ((1 << (k + 1)) - 1 <= n) k += 1; // 最大 k 使 2^k − 1 ≤ n
  if (n === (1 << k) - 1) return 1 << (k - 1);
  return lubyAt(n - (1 << k) + 1);
}

/** annealWithRestarts 结果 */
export interface AnnealWithRestartsResult<T> {
  best: T;
  bestEnergy: number;
  /** 实际执行的重启段数（预算截断的末段照常计入） */
  restarts: number;
  /** 各段步长（Luby 序列 × baseRun——预算耗尽即止） */
  segmentSteps: number[];
  /** 各段末的迄今最优能级（单调非增） */
  segmentBestEnergies: number[];
  /** 消耗的总步数 ≤ totalSteps */
  totalSteps: number;
}

/**
 * Luby 重启退火: 把 totalSteps 预算按 Luby 序列切成段（第 n 段长
 * luby(n)·baseRun）, 每段从 config.x0 重新起跑（重启定理的口径: 从头
 * 再来, 而非从当前最优续跑）, 段内用 config.schedule 退火; 种子按段派生
 * （seed + 段号·104729——段间独立可复现）。全局最优跨段保持。
 * 与单段长退火的分水岭: 几何降温单链冻死后不可逆, 重启至少把链拉回
 * 高温重来; Luby 步长保证不会在错误的时间尺度上过度重复。
 */
export function annealWithRestarts<T>(
  config: AnnealConfig<T> & { totalSteps: number; baseRun?: number },
): AnnealWithRestartsResult<T> {
  if (!Number.isInteger(config.totalSteps) || config.totalSteps < 1) {
    throw new Error(`simulated-annealing: totalSteps 须为 ≥ 1 的整数（收到 ${config.totalSteps}）`);
  }
  const baseRun = config.baseRun ?? Math.max(1, Math.floor(config.totalSteps / 8));
  if (!Number.isInteger(baseRun) || baseRun < 1) {
    throw new Error(`simulated-annealing: baseRun 须为 ≥ 1 的整数（收到 ${baseRun}）`);
  }
  let spent = 0;
  let restarts = 0;
  let best = config.x0;
  let bestEnergy = Number.POSITIVE_INFINITY;
  const segmentSteps: number[] = [];
  const segmentBestEnergies: number[] = [];
  const schedule = validateSchedule(config.schedule);
  for (let n = 1; spent < config.totalSteps; n += 1) {
    const steps = Math.min(lubyAt(n) * baseRun, config.totalSteps - spent);
    const run = anneal({
      energy: config.energy,
      neighbor: config.neighbor,
      x0: config.x0,
      schedule,
      steps,
      seed: config.seed + restarts * 104729,
    });
    spent += steps;
    restarts += 1;
    segmentSteps.push(steps);
    if (run.bestEnergy < bestEnergy) {
      bestEnergy = run.bestEnergy;
      best = run.best;
    }
    segmentBestEnergies.push(bestEnergy);
  }
  return { best, bestEnergy, restarts, segmentSteps, segmentBestEnergies, totalSteps: spent };
}

/* ── 接线建议 ──
 * 挂载引擎: strategy-evolution（策略进化器）——66.0 的全局逃逸引擎：
 *   18.0 信息几何在当前吸引盆地内沿测地线精修（局部），SA 在温度许可下
 *   接受劣化基因跳盆地（全局）——混合优化器 = 「梯度下山 × 温度上山」，
 *   变异调度从此不止高斯噪声一档。
 * 建议方法: strategyEvolution.attachAnnealingEscape(options?)——对照
 *   18.0 attachInformationGeometry 的接线模式；options:
 *   { schedule, steps, seed, restartFromBest }，挂载后每代进化前以当前
 *   最优基因为 x0 跑一段短退火（读 best，不写种群——纯分析旁路）。
 * 缺省关闭旗标: config.kernels.annealingEscapeEnabled = false
 *   （未开启时进化器路径与现状逐位一致——零介入）。
 * 决策点:
 *   - 势阱深度在线估计: 大状态空间无法精确枚举临界深度，可用轨迹上
 *     「最长停留井的逃离爬升」经验分位数近似（保守取分位数 + 20% 余量作 c）；
 *   - 温度与不确定性耦合: 系统平均不确定性高（26.0 GP 后验方差大 /
 *     12.0 证据水位低）→ 抬高 T（多探索）；环境平稳且证据充足 → 降温
 *     冷凝（与 58.0 朗之万的双井温度内生同一哲学）；
 *   - 升级门: 接受率 < 2% 判冻死、> 80% 判白噪（两界之外健康）；
 *     冻死时自动升温重退火（reheat），退化核才默默返回局部最优。
 */
