/**
 * correlated-equilibrium.ts — 64.0 相关均衡内核 —— 信号灯协调与无悔学习（Aumann 1974 / Hart–Mas-Colell 2000）
 *
 * 升级前的根本局限（多智能体协调只有 Nash 一条窄门）：
 * - Nash 均衡假设各方**独立**混同：没有通讯、没有信号，协调只能靠
 *   「猜别人怎么随机」——猜硬币只能 50/50 对着输，两车路口只能以
 *   正概率对撞（混合 Nash 的期望收益低到离谱）；
 * - 现实协调靠**公共信号**：红绿灯不传递私人信息，只是让所有人的
 *   随机性相关起来——「你走我停 / 你停我走」各半，比任何独立混合都
 *   好。Aumann 的相关均衡（correlated equilibrium, CE）就是这种
 *   「服从信号本身构成均衡」的分布：相关装置按 P 抽联合建议，服从
 *   是每个人的最优反应 ⟺ 线性不等式组
 *     ∀i, a_i, a_i′: Σ_{a_{−i}} P(a_i, a_{−i})·(u_i(a_i, a_{−i}) − u_i(a_i′, a_{−i})) ≥ 0
 *   CE ⊇ Nash（独立混合是退化的相关分布），且是**可达成**的解概念——
 *   Hart–Mas-Colell 定理：人人无悔学习（regret matching）的时间平均
 *   联合分布必收敛到 CE 集，不需要任何人对博弈有全局认知；
 * - 62.0 机制设计管「事前定价的激励相容」，本内核管「事后协调的可
 *   达成性」：独立心智经由信号设备达成无通讯协调——深思 7.0 的
 *   博弈论落地。
 *
 * 数学：
 * 1. 相关均衡（Aumann 1974）：P ∈ Δ(A₁×…×A_n) 是 CE ⟺ 无人有
 *    偏离建议的动机（上式全体成立）——纯线性不等式，可精确检查；
 *    每个 Nash 均衡都是 CE；CE 集是凸多面体（Nash 集一般不是）。
 * 2. Regret Matching（Hart–Mas-Colell 2000）：玩家 i 维护对每个行动
 *    a 的累计外部后悔
 *      R_i(a) = Σ_t [u_i(a, a_{−i}(t)) − u_i(a_i(t), a_{−i}(t))]
 *    行动概率取正后悔的归一化：σ_i(a) = R_i⁺(a)/Σ_b R_i⁺(b)
 *    （全非正时取均匀）。Blackwell 可接近性 ⟹ 每人外部后悔
 *    o(T)，时间平均联合分布 → CE 集；均匀随机化的实现用文件内
 *    mulberry32(seed)——同种子同轨迹，验证可复现。
 * 3. 混合 Nash 对照（双人支撑枚举）：对每个支撑对 (S₁, S₂) 解
 *    「支撑内无差异 + 归一」线性方程组（高斯消元），校验支撑外无
 *    改进、支撑内概率非负——小双矩阵博弈的 Nash 全枚举（纯 Nash
 *    对任意人数直接扫剖面）。
 * 4. 经验分布的 CE 逼近度：max 偏离收益 ≤ max_i 外部后悔/T
 *    （无悔定理的定量面）——T = 10⁴ 时每轮后悔 < 0.01，
 *    isCorrelatedEquilibrium 的容差即由此定标。
 *
 * 验证锚点（scripts/verify-game-kernels.mjs）：
 *   ① 猜硬币（零和）：RM 学习 5000 步，时间平均收益 → 0（博弈值），
 *      经验联合分布 → 均匀（各格 1/4），双人混合 Nash = (1/2, 1/2)；
 *   ② 囚徒困境：CE 检查器验证纯 Nash (D,D) 是 CE；数学上 PD 的
 *      CE 集只含 (D,D)——「红绿灯」分布（(C,C)/(D,D) 各半，被建议
 *      C 时对方必 C，偏离 D 净赚 5−3=2）被正确拒绝（违反量恰 1.0）：
 *      一次性 PD 里信号救不了合作，这是 CE 纪律的诚实面；「信号灯
 *      Pareto 优于混合 Nash」的对照落在③的协调博弈（那里它合法）；
 *   ③ 交通灯协调博弈（两车两路）：构造的红绿灯分布 P(Go,Stop) =
 *      P(Stop,Go) = 1/2 是 CE（违反量 0），期望收益 1.5/人，双方
 *      Pareto 优于混合 Nash（p*=q*=2/13，收益 2/13 ≈ 0.154/人，
 *      差 9.75 倍）；RM 学习 10⁴ 步的经验分布期望收益 > 混合 Nash；
 *   ④ 外部后悔 ‖R‖/T 随 T 递减（100 → 1000 → 10⁴），T = 10⁴ 时
 *      < 0.01/轮；
 *   ⑤ isCorrelatedEquilibrium 对已知 CE 通过（红绿灯分布、纯 Nash），
 *      对构造的破坏分布正确拒绝（PD 红绿灯 1.0、猜硬币 δ_{HH} = 2.0、
 *      交通灯均匀分布 = 2.25——违反量均有解析值）；
 *   ⑥ enumerateNash 对照：PD 恰 1 个纯 Nash；交通灯 2 纯 + 1 混合
 *     (2/13, 2/13)；猜硬币恰 1 个混合 (1/2, 1/2)。
 *
 * R5 进化（第五轮·世界性升级，数学+性能+性质三轴）:
 *   数学轴——粗糙相关均衡（coarse CE，Moulin–Vial 1978 / Young 2004）:
 *     P 是 CCE ⟺ ∀i ∀a′: Σ_j P(j)·(u_i(a′, j₋ᵢ) − u_i(j)) ≤ ε
 *     ——偏离决策在**看到建议之前**做出（承诺口径）。CE 要求「服从每条
 *     建议都最优」（事中口径），CCE 只要求「事前承诺服从不劣于任何固定
 *     偏离」——严格更弱 ⟹ CE ⊆ CCE（Nash ⊆ CE ⊆ CCE 三层包含）。无悔
 *     学习的时间平均**天然**只保证收敛到 CCE 集（外部后悔 o(T) 直接是
 *     CCE 不等式左边），收敛到 CE 需更强的内部无悔——两个口径分开检查
 *     才能诚实报告「学到的是哪一层」。equilibriumGaps 同时给出两个 ε
 *     （ε-均衡松弛的可观测面: 最小可宣称的 ε）。
 *   性能轴——learnCEFast: learnCE 的零分配孪生（同 RNG 消耗序、同算术
 *     序——输出逐位相同; 概率分布-采样融合为单遍累加、反事实收益复用
 *     预分配缓冲），≥50 随机博弈逐位对照 + 耗时比。
 *
 * 应用：多模型议会 / 共生立法——独立心智经由「信号设备」达成无通讯
 * 协调：议题二元化 → 正则型博弈；历史交互收益 → 效用表；learnCE 跑
 * 无悔动态得可自执行的协调分布；isCorrelatedEquilibrium 审计任何
 * 「日程/仲裁方案」是否抗单方偏离——比 Nash 更宽的解概念 = 更强的
 * 可达成性（深思 7.0 的博弈论落地）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入
 */

// ─────────────────────────── 确定性随机源 ───────────────────────────

/** mulberry32：32 位种子 → [0,1) 均匀流（同种子同序列——验证可复现） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从离散分布按 r ∈ [0,1) 采样下标（末下标兜底浮点） */
function sampleIndex(probabilities: ReadonlyArray<number>, r: number): number {
  let cumulative = 0;
  for (let i = 0; i < probabilities.length; i += 1) {
    cumulative += probabilities[i];
    if (r < cumulative) return i;
  }
  return probabilities.length - 1;
}

// ─────────────────────────── 正则型博弈 ───────────────────────────

/**
 * 正则型（策略型）博弈：n 方、各方行动数 actions[i]、效用表
 * utilities[i][j] = 玩家 i 在联合行动 j 下的收益。
 * 联合索引 j 混合进制（末位玩家最快）：
 *   j = a₀·(m₁···m_{n−1}) + a₁·(m₂···m_{n−1}) + … + a_{n−1}
 */
export interface NormalGame {
  readonly players: number;
  readonly actions: ReadonlyArray<number>;
  readonly utilities: ReadonlyArray<ReadonlyArray<number>>;
  /** 玩家 i 的步长（联合索引 = Σ aᵢ·strides[i]） */
  readonly strides: ReadonlyArray<number>;
  readonly jointCount: number;
}

/** 联合行动表规模上限（纯数学内核的务实护栏） */
export const MAX_JOINT_ACTIONS = 1_000_000;

export function normalGame(
  actions: ReadonlyArray<number>,
  utilities: ReadonlyArray<ReadonlyArray<number>>,
): NormalGame {
  const players = actions.length;
  if (players < 2) throw new Error(`normalGame: 至少两个玩家（收到 ${players}）`);
  let jointCount = 1;
  for (let i = 0; i < players; i += 1) {
    const m = actions[i];
    if (!Number.isInteger(m) || m < 1) {
      throw new Error(`normalGame: 每方行动数必须是正整数（第 ${i} 方收到 ${m}）`);
    }
    jointCount *= m;
    if (jointCount > MAX_JOINT_ACTIONS) {
      throw new Error(`normalGame: 联合行动表规模 ${jointCount} 超上限 ${MAX_JOINT_ACTIONS}`);
    }
  }
  if (utilities.length !== players) {
    throw new Error(`normalGame: 效用表必须每人一张（期望 ${players} 张，收到 ${utilities.length} 张）`);
  }
  for (let i = 0; i < players; i += 1) {
    const row = utilities[i];
    if (row.length !== jointCount) {
      throw new Error(`normalGame: 第 ${i} 方效用表长度必须为 ${jointCount}（收到 ${row.length}）`);
    }
    for (const u of row) {
      if (!Number.isFinite(u)) throw new Error(`normalGame: 第 ${i} 方效用含非有限值 ${String(u)}`);
    }
  }
  const strides: number[] = new Array<number>(players).fill(1);
  for (let i = players - 2; i >= 0; i -= 1) strides[i] = strides[i + 1] * actions[i + 1];
  return { players, actions: [...actions], utilities: utilities.map((row) => [...row]), strides, jointCount };
}

function requireJointIndex(game: NormalGame, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= game.jointCount) {
    throw new Error(`联合行动索引必须是 [0, ${game.jointCount - 1}] 的整数（收到 ${index}）`);
  }
}

function requireProfile(game: NormalGame, profile: ReadonlyArray<number>): void {
  if (profile.length !== game.players) {
    throw new Error(`行动剖面长度必须等于玩家数 ${game.players}（收到 ${profile.length}）`);
  }
  for (let i = 0; i < game.players; i += 1) {
    const a = profile[i];
    if (!Number.isInteger(a) || a < 0 || a >= game.actions[i]) {
      throw new Error(`第 ${i} 方行动必须是 [0, ${game.actions[i] - 1}] 的整数（收到 ${a}）`);
    }
  }
}

/** 行动剖面 → 联合索引 */
export function jointIndexOf(game: NormalGame, profile: ReadonlyArray<number>): number {
  requireProfile(game, profile);
  let index = 0;
  for (let i = 0; i < game.players; i += 1) index += profile[i] * game.strides[i];
  return index;
}

/** 联合索引 → 行动剖面 */
export function profileOfJoint(game: NormalGame, index: number): number[] {
  requireJointIndex(game, index);
  const profile: number[] = new Array<number>(game.players).fill(0);
  let rest = index;
  for (let i = game.players - 1; i >= 0; i -= 1) {
    profile[i] = rest % game.actions[i];
    rest = (rest - profile[i]) / game.actions[i];
  }
  return profile;
}

/** u_i(剖面) */
export function payoffOf(game: NormalGame, player: number, profile: ReadonlyArray<number>): number {
  if (!Number.isInteger(player) || player < 0 || player >= game.players) {
    throw new Error(`玩家下标必须是 [0, ${game.players - 1}] 的整数（收到 ${player}）`);
  }
  requireProfile(game, profile);
  return game.utilities[player][jointIndexOf(game, profile)];
}

/**
 * 反事实收益表：cf[a] = u_i(a, profile_{−i})——固定他人行动，
 * 玩家 i 改打每个行动 a 的即时收益（profile[i] 本身被忽略）。
 */
export function counterfactualPayoffs(game: NormalGame, player: number, profile: ReadonlyArray<number>): number[] {
  if (!Number.isInteger(player) || player < 0 || player >= game.players) {
    throw new Error(`玩家下标必须是 [0, ${game.players - 1}] 的整数（收到 ${player}）`);
  }
  requireProfile(game, profile);
  const m = game.actions[player];
  const stride = game.strides[player];
  const base = jointIndexOf(game, profile) - profile[player] * stride;
  const cf: number[] = new Array<number>(m).fill(0);
  for (let a = 0; a < m; a += 1) cf[a] = game.utilities[player][base + a * stride];
  return cf;
}

// ─────────────────────────── Regret Matching ───────────────────────────

/**
 * 正后悔归一分布：σ(a) = R⁺(a)/Σ R⁺(b)；全非正时均匀
 * （Hart–Mas-Colell 的两条规则，一行不差）。
 */
export function positiveRegretDistribution(regrets: ReadonlyArray<number>): number[] {
  if (regrets.length === 0) throw new Error('positiveRegretDistribution: 后悔向量不能为空');
  let positiveSum = 0;
  for (const r of regrets) {
    if (!Number.isFinite(r)) throw new Error(`positiveRegretDistribution: 后悔值必须有限（收到 ${String(r)}）`);
    if (r > 0) positiveSum += r;
  }
  if (positiveSum <= 0) return new Array<number>(regrets.length).fill(1 / regrets.length);
  const probs: number[] = new Array<number>(regrets.length).fill(0);
  for (let a = 0; a < regrets.length; a += 1) probs[a] = regrets[a] > 0 ? regrets[a] / positiveSum : 0;
  return probs;
}

export interface RegretMatchingStep {
  /** 由输入 regrets 决定的本轮行动分布（先采样后更新） */
  readonly probabilities: ReadonlyArray<number>;
  /** regrets[a] + payoffs[a] − payoffs[chosen]（累计外部后悔） */
  readonly regrets: ReadonlyArray<number>;
}

/** RM 原子步：旧后悔 → 本轮分布；按实际所选行动 chosen 结转新后悔 */
export function regretMatchingStep(
  regrets: ReadonlyArray<number>,
  payoffs: ReadonlyArray<number>,
  chosen: number,
): RegretMatchingStep {
  if (regrets.length === 0 || payoffs.length !== regrets.length) {
    throw new Error(`regretMatchingStep: 后悔/收益向量必须等长非空（${regrets.length} vs ${payoffs.length}）`);
  }
  if (!Number.isInteger(chosen) || chosen < 0 || chosen >= regrets.length) {
    throw new Error(`regretMatchingStep: chosen 必须是 [0, ${regrets.length - 1}] 的整数（收到 ${chosen}）`);
  }
  for (const p of payoffs) {
    if (!Number.isFinite(p)) throw new Error(`regretMatchingStep: 收益必须有限（收到 ${String(p)}）`);
  }
  const updated = regrets.map((r, a) => r + payoffs[a] - payoffs[chosen]);
  return { probabilities: positiveRegretDistribution(regrets), regrets: updated };
}

// ─────────────────────────── CE 检查 ───────────────────────────

export interface CEDeviation {
  readonly player: number;
  readonly from: number;
  readonly to: number;
  /** Σ P(a_i,a_{−i})·(u_i(a_i′,a_{−i}) − u_i(a_i,a_{−i}))——按建议服从的净损失 */
  readonly gain: number;
}

export interface CECheck {
  readonly isCE: boolean;
  /** 最大单方偏离收益（≤ tolerance 即 CE；解析可验） */
  readonly worstViolation: number;
  readonly worst: CEDeviation | null;
  readonly totalMass: number;
}

/** 分布合同校验：长度对、数值有限、非负（容 −1e-9 尘埃）、总质量 ≈ 1 */
function validatedDistribution(distribution: ReadonlyArray<number>, game: NormalGame): number[] {
  if (distribution.length !== game.jointCount) {
    throw new Error(`分布长度必须等于联合行动数 ${game.jointCount}（收到 ${distribution.length}）`);
  }
  const p: number[] = new Array<number>(distribution.length).fill(0);
  let total = 0;
  for (let j = 0; j < distribution.length; j += 1) {
    const v = distribution[j];
    if (!Number.isFinite(v)) throw new Error(`分布第 ${j} 项非有限（${String(v)}）`);
    if (v < -1e-9) throw new Error(`分布第 ${j} 项为负（${v}）——相关装置不发负概率建议`);
    p[j] = v > 0 ? v : 0;
    total += p[j];
  }
  if (Math.abs(total - 1) > 1e-6) {
    throw new Error(`分布总质量必须为 1（收到 ${total}）——请先归一化`);
  }
  return p;
}

/**
 * 相关均衡检查（Aumann 不等式组全量扫描）：
 * ∀i ∀a_i ∀a_i′：Σ_{a_{−i}} P(a_i,a_{−i})·(u_i(a_i′,a_{−i}) − u_i(a_i,a_{−i})) ≤ tolerance
 * ——对固定 (i, a_i → a_i′) 先对他人行动求和，再比大小（不是逐格取最大）。
 */
export function isCorrelatedEquilibrium(
  distribution: ReadonlyArray<number>,
  game: NormalGame,
  tolerance = 1e-9,
): CECheck {
  const p = validatedDistribution(distribution, game);
  let worstGain = 0;
  let worst: CEDeviation | null = null;
  for (let i = 0; i < game.players; i += 1) {
    const m = game.actions[i];
    const stride = game.strides[i];
    const utils = game.utilities[i];
    // gains[a][a′] = Σ_j [own_j = a] P(j)·(u(j′) − u(j)), j′ = j 换 i 的行动为 a′
    const gains: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
    for (let j = 0; j < game.jointCount; j += 1) {
      const mass = p[j];
      if (mass <= 0) continue;
      const own = Math.floor(j / stride) % m;
      const stay = utils[j];
      for (let alt = 0; alt < m; alt += 1) {
        if (alt === own) continue;
        gains[own][alt] += mass * (utils[j + (alt - own) * stride] - stay);
      }
    }
    for (let a = 0; a < m; a += 1) {
      for (let alt = 0; alt < m; alt += 1) {
        if (gains[a][alt] > worstGain) {
          worstGain = gains[a][alt];
          worst = { player: i, from: a, to: alt, gain: worstGain };
        }
      }
    }
  }
  let total = 0;
  for (const v of p) total += v;
  return { isCE: worstGain <= tolerance, worstViolation: worstGain, worst, totalMass: total };
}

/** 分布 P 下的期望收益向量：Σ_j P(j)·u_i(j) */
export function expectedPayoffsUnder(distribution: ReadonlyArray<number>, game: NormalGame): number[] {
  const p = validatedDistribution(distribution, game);
  const out: number[] = new Array<number>(game.players).fill(0);
  for (let i = 0; i < game.players; i += 1) {
    let acc = 0;
    for (let j = 0; j < game.jointCount; j += 1) acc += p[j] * game.utilities[i][j];
    out[i] = acc;
  }
  return out;
}

// ─────────────────────────── learnCE：无悔学习 ───────────────────────────

export interface LearnCEResult {
  readonly steps: number;
  /** 联合行动计数与频率（时间平均分布——Hart–Mas-Colell 收敛到 CE 集） */
  readonly jointCounts: ReadonlyArray<number>;
  readonly jointFreq: ReadonlyArray<number>;
  /** 实现收益的时间平均（每轮真实所得） */
  readonly avgPayoffs: ReadonlyArray<number>;
  /** 经验分布下的期望收益 Σ P̂·u */
  readonly expectedPayoffs: ReadonlyArray<number>;
  /** 每人平均外部后悔 max_a R_i(a)/T（无悔性：→ 0） */
  readonly externalRegret: ReadonlyArray<number>;
  /** 末期累计后悔矩阵 regretSums[i][a] */
  readonly regretSums: ReadonlyArray<ReadonlyArray<number>>;
  /** 经验分布在 CE 不等式下的最大违反（≤ max regret/T + 尘埃） */
  readonly empiricalCeViolation: number;
  /** 下一轮将用的 RM 分布（末期后悔的正部归一） */
  readonly finalStrategies: ReadonlyArray<ReadonlyArray<number>>;
}

/**
 * Regret Matching 学习：各方同时跑 RM，每步独立采样联合行动、
 * 观测反事实收益、更新后悔。时间平均联合分布 → CE 集。
 * 确定性：mulberry32(seed)，玩家 0..n−1 顺序各消耗一个随机数。
 */
export function learnCE(game: NormalGame, steps: number, seed: number): LearnCEResult {
  if (!Number.isInteger(steps) || steps < 1) {
    throw new Error(`learnCE: 步数必须是正整数（收到 ${String(steps)}）`);
  }
  const rng = mulberry32(seed);
  const regrets: number[][] = game.actions.map((m) => new Array<number>(m).fill(0));
  const jointCounts: number[] = new Array<number>(game.jointCount).fill(0);
  const realized: number[] = new Array<number>(game.players).fill(0);
  const profile: number[] = new Array<number>(game.players).fill(0);

  for (let t = 0; t < steps; t += 1) {
    for (let i = 0; i < game.players; i += 1) {
      profile[i] = sampleIndex(positiveRegretDistribution(regrets[i]), rng());
    }
    jointCounts[jointIndexOf(game, profile)] += 1;
    for (let i = 0; i < game.players; i += 1) {
      const cf = counterfactualPayoffs(game, i, profile);
      const got = cf[profile[i]];
      realized[i] += got;
      const r = regrets[i];
      for (let a = 0; a < cf.length; a += 1) r[a] += cf[a] - got;
    }
  }

  const jointFreq = jointCounts.map((c) => c / steps);
  const externalRegret = regrets.map((r) => Math.max(...r) / steps);
  return {
    steps,
    jointCounts,
    jointFreq,
    avgPayoffs: realized.map((v) => v / steps),
    expectedPayoffs: expectedPayoffsUnder(jointFreq, game),
    externalRegret,
    regretSums: regrets,
    empiricalCeViolation: isCorrelatedEquilibrium(jointFreq, game, 0).worstViolation,
    finalStrategies: regrets.map((r) => positiveRegretDistribution(r)),
  };
}

// ─────────────────────────── Nash 对照枚举 ───────────────────────────

export interface NashEquilibrium {
  /** 每人混合策略（纯均衡是单位向量） */
  readonly strategies: ReadonlyArray<ReadonlyArray<number>>;
  readonly payoffs: ReadonlyArray<number>;
  readonly pure: boolean;
}

/** 高斯消元（部分主元浮点）；奇异返回 null */
function solveLinearSystem(matrix: ReadonlyArray<ReadonlyArray<number>>, rhs: ReadonlyArray<number>): number[] | null {
  const n = rhs.length;
  const a: number[][] = matrix.map((row, r) => [...row, rhs[r]]);
  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    let best = Math.abs(a[col][col] ?? 0);
    for (let r = col + 1; r < n; r += 1) {
      const v = Math.abs(a[r][col]);
      if (v > best) {
        best = v;
        pivotRow = r;
      }
    }
    if (best < 1e-12) return null;
    const tmp = a[col];
    a[col] = a[pivotRow];
    a[pivotRow] = tmp;
    const head = a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= head;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor === 0) continue;
      for (let j = col; j <= n; j += 1) a[r][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}

/** 混合策略剖面是否 Nash：每人每个纯行动对他人混合的期望 ≤ 均衡期望 + tol */
function isMixedNash(game: NormalGame, strategies: ReadonlyArray<ReadonlyArray<number>>, tolerance: number): boolean {
  const { players, actions, utilities, strides, jointCount } = game;
  for (let i = 0; i < players; i += 1) {
    if (strategies[i].length !== actions[i]) return false;
    let mixed = 0;
    for (let j = 0; j < jointCount; j += 1) {
      let weight = 1;
      for (let k = 0; k < players; k += 1) {
        weight *= strategies[k][Math.floor(j / strides[k]) % actions[k]];
      }
      mixed += weight * utilities[i][j];
    }
    // 玩家 i 单独改打纯行动 a 的期望
    for (let a = 0; a < actions[i]; a += 1) {
      let pure = 0;
      for (let j = 0; j < jointCount; j += 1) {
        if (Math.floor(j / strides[i]) % actions[i] !== a) continue;
        let weight = 1;
        for (let k = 0; k < players; k += 1) {
          if (k === i) continue;
          weight *= strategies[k][Math.floor(j / strides[k]) % actions[k]];
        }
        pure += weight * utilities[i][j];
      }
      if (pure > mixed + tolerance) return false;
    }
  }
  return true;
}

function profilePayoffs(game: NormalGame, strategies: ReadonlyArray<ReadonlyArray<number>>): number[] {
  const out: number[] = new Array<number>(game.players).fill(0);
  for (let i = 0; i < game.players; i += 1) {
    let acc = 0;
    for (let j = 0; j < game.jointCount; j += 1) {
      let weight = 1;
      for (let k = 0; k < game.players; k += 1) {
        weight *= strategies[k][Math.floor(j / game.strides[k]) % game.actions[k]];
      }
      acc += weight * game.utilities[i][j];
    }
    out[i] = acc;
  }
  return out;
}

function strategiesClose(a: ReadonlyArray<ReadonlyArray<number>>, b: ReadonlyArray<ReadonlyArray<number>>): boolean {
  for (let i = 0; i < a.length; i += 1) {
    for (let k = 0; k < a[i].length; k += 1) {
      if (Math.abs(a[i][k] - b[i][k]) > 1e-6) return false;
    }
  }
  return true;
}

/**
 * Nash 枚举（小博弈对照用）：
 * - 纯 Nash：任意人数，全剖面扫描（无人可单独改进）；
 * - 混合 Nash：仅双人，支撑枚举（支撑内无差异 + 归一 → 高斯消元，
 *   支撑外不得改进，非负校验）——支持内概率退化到 0 的重复解被去重。
 */
export function enumerateNash(game: NormalGame): NashEquilibrium[] {
  const { players, actions, utilities, strides, jointCount } = game;
  const equilibria: NashEquilibrium[] = [];

  pure: for (let j = 0; j < jointCount; j += 1) {
    const ownActions: number[] = new Array<number>(players).fill(0);
    let rest = j;
    for (let i = players - 1; i >= 0; i -= 1) {
      ownActions[i] = rest % actions[i];
      rest = (rest - ownActions[i]) / actions[i];
    }
    for (let i = 0; i < players; i += 1) {
      const u = utilities[i][j];
      for (let a = 0; a < actions[i]; a += 1) {
        if (utilities[i][j + (a - ownActions[i]) * strides[i]] > u + 1e-9) continue pure;
      }
    }
    const strategies = ownActions.map((a, i) => {
      const unit = new Array<number>(actions[i]).fill(0);
      unit[a] = 1;
      return unit;
    });
    equilibria.push({ strategies, payoffs: utilities.map((row) => row[j]), pure: true });
  }

  if (players === 2) {
    const m1 = actions[0];
    const m2 = actions[1];
    const A = utilities[0];
    const B = utilities[1];
    for (let s1 = 1; s1 < 1 << m1; s1 += 1) {
      const sup1: number[] = [];
      for (let a = 0; a < m1; a += 1) if (s1 & (1 << a)) sup1.push(a);
      for (let s2 = 1; s2 < 1 << m2; s2 += 1) {
        const sup2: number[] = [];
        for (let b = 0; b < m2; b += 1) if (s2 & (1 << b)) sup2.push(b);
        const k = sup1.length + sup2.length;
        const matrix: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
        const rhs: number[] = new Array<number>(k).fill(0);
        let row = 0;
        // 玩家 1 在 S1 上无差异：(A[a₀] − A[a])·q = 0
        for (let t = 1; t < sup1.length; t += 1, row += 1) {
          for (let bi = 0; bi < sup2.length; bi += 1) {
            matrix[row][sup1.length + bi] = A[sup1[0] * m2 + sup2[bi]] - A[sup1[t] * m2 + sup2[bi]];
          }
        }
        // 玩家 2 在 S2 上无差异：(B[·b₀] − B[·b])·p = 0
        for (let t = 1; t < sup2.length; t += 1, row += 1) {
          for (let ai = 0; ai < sup1.length; ai += 1) {
            matrix[row][ai] = B[sup1[ai] * m2 + sup2[0]] - B[sup1[ai] * m2 + sup2[t]];
          }
        }
        for (let ai = 0; ai < sup1.length; ai += 1) matrix[k - 2][ai] = 1; // Σp = 1
        rhs[k - 2] = 1;
        for (let bi = 0; bi < sup2.length; bi += 1) matrix[k - 1][sup1.length + bi] = 1; // Σq = 1
        rhs[k - 1] = 1;
        const solution = solveLinearSystem(matrix, rhs);
        if (solution === null) continue;
        if (solution.some((v) => v < -1e-9 || !Number.isFinite(v))) continue;
        const p = new Array<number>(m1).fill(0);
        const q = new Array<number>(m2).fill(0);
        let ps = 0;
        let qs = 0;
        for (let ai = 0; ai < sup1.length; ai += 1) {
          p[sup1[ai]] = Math.max(0, solution[ai]);
          ps += p[sup1[ai]];
        }
        for (let bi = 0; bi < sup2.length; bi += 1) {
          q[sup2[bi]] = Math.max(0, solution[sup1.length + bi]);
          qs += q[sup2[bi]];
        }
        if (ps <= 0 || qs <= 0) continue;
        for (let ai = 0; ai < sup1.length; ai += 1) p[sup1[ai]] /= ps;
        for (let bi = 0; bi < sup2.length; bi += 1) q[sup2[bi]] /= qs;
        if (!isMixedNash(game, [p, q], 1e-7)) continue;
        if (equilibria.some((eq) => strategiesClose(eq.strategies, [p, q]))) continue;
        equilibria.push({ strategies: [p, q], payoffs: profilePayoffs(game, [p, q]), pure: false });
      }
    }
  }

  return equilibria;
}

// ─────────────────────────── R5 进化: 粗糙相关均衡（coarse CE） ───────────────────────────

/** 粗糙均衡偏离证人: 玩家 i 在看到建议前固定改打 to */
export interface CCEDeviation {
  readonly player: number;
  readonly to: number;
  /** Σ_j P(j)·(u_i(to, j₋ᵢ) − u_i(j))——事前承诺偏离的净收益 */
  readonly gain: number;
}

export interface CCECheck {
  readonly isCCE: boolean;
  /** 最大事前偏离收益（≤ tolerance 即 CCE）*/
  readonly worstViolation: number;
  readonly worst: CCEDeviation | null;
}

/**
 * 粗糙相关均衡检查（Moulin–Vial 承诺口径）：
 * ∀i, a′: Σ_{a_{−i}} P(a_i, a_{−i})·(u_i(a′, a_{−i}) − u_i(a_i, a_{−i})) ≤ tolerance
 * 即 E_P[u_i(j)] ≥ E_P[u_i(a′, j₋ᵢ)]——分布的期望收益不劣于任何**事前固定**
 * 偏离。与 CE 的差别: CE 逐条建议条件化（服从每条建议都是最优反应），
 * CCE 只比无条件期望——严格更弱，CE ⊆ CCE。实现: 先算 E_P[u_i(j)] 与
 * 各固定行动 a′ 对他人边缘分布的期望（单遍扫联合行动），再取最大差。
 */
export function isCoarseCorrelatedEquilibrium(
  distribution: ReadonlyArray<number>,
  game: NormalGame,
  tolerance = 1e-9,
): CCECheck {
  const p = validatedDistribution(distribution, game);
  let worstGain = 0;
  let worst: CCEDeviation | null = null;
  for (let i = 0; i < game.players; i += 1) {
    const m = game.actions[i];
    const stride = game.strides[i];
    const utils = game.utilities[i];
    // base = E_P[u_i(j)]; fixed[a'] = Σ_j P(j)·u_i(a', j_{-i})
    const fixed = new Array<number>(m).fill(0);
    let base = 0;
    for (let j = 0; j < game.jointCount; j += 1) {
      const mass = p[j];
      if (mass <= 0) continue;
      base += mass * utils[j];
      const own = Math.floor(j / stride) % m;
      for (let alt = 0; alt < m; alt += 1) {
        if (alt === own) {
          fixed[alt] += mass * utils[j]; // j 本身即 i 打 alt 的剖面
        } else {
          fixed[alt] += mass * utils[j + (alt - own) * stride];
        }
      }
    }
    for (let alt = 0; alt < m; alt += 1) {
      const gain = fixed[alt] - base;
      if (gain > worstGain) {
        worstGain = gain;
        worst = { player: i, to: alt, gain };
      }
    }
  }
  return { isCCE: worstGain <= tolerance, worstViolation: worstGain, worst };
}

/** 双口径 ε-均衡松弛: 把分布宣称成 ε-CE / ε-CCE 各需的最小 ε（≥ 0）*/
export interface EquilibriumGaps {
  /** ε-CE 所需最小 ε（= CE 不等式最大违反——逐条建议条件化）*/
  readonly ceGap: number;
  /** ε-CCE 所需最小 ε（= CCE 不等式最大违反——事前承诺口径）*/
  readonly cceGap: number;
  readonly isCE: boolean;
  readonly isCCE: boolean;
}

/**
 * 一次审计两层的 ε 松弛: ceGap 与 cceGap 各自独立报告（精确违反量,
 * 不受容差影响）。层次关系: isCE ⟹ isCCE（CE ⊆ CCE）; 两个 ε 之间
 * **没有单向序**——无条件偏离收益 = 各条件收益按建议概率加权和，同号的
 * 条件违反会叠加（每方行动数 m 的界: cceGap ≤ maxᵢ mᵢ · ceGap）。
 * 布尔判定用 1e-9 容差（ Nash 积分布在浮点下常有 ~1e-16 尘埃, 零容差
 * 会把精确均衡误判为非均衡）。
 */
export function equilibriumGaps(distribution: ReadonlyArray<number>, game: NormalGame): EquilibriumGaps {
  const ce = isCorrelatedEquilibrium(distribution, game, 1e-9);
  const cce = isCoarseCorrelatedEquilibrium(distribution, game, 1e-9);
  return { ceGap: ce.worstViolation, cceGap: cce.worstViolation, isCE: ce.isCE, isCCE: cce.isCCE };
}

// ─────────────────────────── R5 进化: learnCEFast（learnCE 的零分配孪生） ───────────────────────────

/**
 * learnCE 的零分配孪生（性能进化）——**输出与 learnCE 逐位相同**：
 * ① RNG 消耗序相同（每步按玩家 0..n−1 各一个随机数）;
 * ② 算术序相同: 正后悔归一 σ(a) = R⁺(a)/ΣR⁺ 与 sampleIndex 的逐项累加
 *    融合为单遍（除法/加法的操作数与顺序不变，浮点结果逐位一致）;
 *    反事实收益与后悔更新写入预分配缓冲（同表达式）。
 * 省去每步每玩家的分布数组、反事实数组与 jointIndexOf 重算——
 * 大步数 / 多玩家 / 大行动集场景的常数因子收益。
 */
export function learnCEFast(game: NormalGame, steps: number, seed: number): LearnCEResult {
  if (!Number.isInteger(steps) || steps < 1) {
    throw new Error(`learnCEFast: 步数必须是正整数（收到 ${String(steps)}）`);
  }
  const rng = mulberry32(seed);
  const n = game.players;
  const regrets: number[][] = game.actions.map((m) => new Array<number>(m).fill(0));
  const jointCounts: number[] = new Array<number>(game.jointCount).fill(0);
  const realized: number[] = new Array<number>(n).fill(0);
  const profile: number[] = new Array<number>(n).fill(0);
  for (let t = 0; t < steps; t += 1) {
    for (let i = 0; i < n; i += 1) {
      const r = regrets[i];
      let positiveSum = 0;
      for (let a = 0; a < r.length; a += 1) if (r[a] > 0) positiveSum += r[a];
      const roll = rng();
      let chosenAction = r.length - 1;
      if (positiveSum <= 0) {
        // 均匀分布采样（与 positiveRegretDistribution 全非正分支同算术）
        let cumulative = 0;
        for (let a = 0; a < r.length - 1; a += 1) {
          cumulative += 1 / r.length;
          if (roll < cumulative) {
            chosenAction = a;
            break;
          }
        }
      } else {
        let cumulative = 0;
        for (let a = 0; a < r.length - 1; a += 1) {
          cumulative += r[a] > 0 ? r[a] / positiveSum : 0;
          if (roll < cumulative) {
            chosenAction = a;
            break;
          }
        }
      }
      profile[i] = chosenAction;
    }
    let joint = 0;
    for (let i = 0; i < n; i += 1) joint += profile[i] * game.strides[i];
    jointCounts[joint] += 1;
    for (let i = 0; i < n; i += 1) {
      const m = game.actions[i];
      const stride = game.strides[i];
      const own = profile[i];
      const base = joint - own * stride;
      const utils = game.utilities[i];
      const got = utils[base + own * stride];
      const r = regrets[i];
      realized[i] += got;
      for (let a = 0; a < m; a += 1) {
        const u = utils[base + a * stride];
        r[a] += u - got;
      }
    }
  }
  const jointFreq = jointCounts.map((c) => c / steps);
  const externalRegret = regrets.map((r) => Math.max(...r) / steps);
  return {
    steps,
    jointCounts,
    jointFreq,
    avgPayoffs: realized.map((v) => v / steps),
    expectedPayoffs: expectedPayoffsUnder(jointFreq, game),
    externalRegret,
    regretSums: regrets,
    empiricalCeViolation: isCorrelatedEquilibrium(jointFreq, game, 0).worstViolation,
    finalStrategies: regrets.map((r) => positiveRegretDistribution(r)),
  };
}

/* ── 接线建议 ──
 * 1. 建议挂载引擎: src/core/deliberation.ts 深思内核（7.0）与
 *    src/symbiosis/runtime.ts 议会/立法协调——本内核是它们的
 *    「可自执行协调」理论核：
 *    a) 多模型议会表决僵局（互投反对票、无 Nash 纯策略稳定点）时，
 *       把议题二元化为正则型博弈（行动 = 立场，效用 = 历史交互收益的
 *       经验表），learnCE 跑无悔动态得协调分布——比 Nash 更宽的
 *       解概念 = 更强的可达成性（独立心智经由「信号设备」达成无通讯
 *       协调，信号可以是轮值仲裁者、时间片、任务签名摘要）；
 *    b) 任何「日程/仲裁/路由方案」上线前先过 isCorrelatedEquilibrium
 *       审计：worstViolation > 0 ⟹ 存在单方偏离动机，方案会被理性
 *       代理自然瓦解——审计不通过就改方案，而不是祈望服从；
 *    c) 交通灯模式落地：竞争性资源（GPU 时间片 / 热门模型配额）的
 *       「你用我停」相关分配 vs 各自独立重试——期望收益差额即信号灯
 *       协调收益，进共生账本记为协调红利。
 * 2. 缺省关闭旗标名: SymbiosisBridgeConfig 新增
 *    `correlatedEquilibrium?: { enabled?: boolean }`（缺省 false，
 *    影子计算，不改变主链路——与 62.0/63.0 旗标同款）。
 * 3. 挂载后改变的决策点：
 *    - deliberation.ts 的僵局破除：随机重试 → CE 分布采样（无悔动态
 *      背书的可自执行方案）；
 *    - 议会记录携带 empiricalCeViolation 与 worst 偏离者身份
 *      （谁、从哪个建议偏离到哪个、净赚多少）——协调失败第一次有
 *      数学尸检报告；
 *    - learnCE 的效用表来源必须可审计（历史收益经验的只读视图），
 *      不得由被协调方单方申报（防效用表投毒）；
 *    - 未启用时行为与本内核加入前逐位一致（零漂移）。
 * 4. 成本注记: isCorrelatedEquilibrium 是 O(Πmᵢ·Σmᵢ) 的线性扫描，
 *    learnCE 每步 O(Σmᵢ·n)；支撑枚举只对双人小博弈开放（混合 Nash
 *    枚举是 NP-hard 的，双人之外的对照走外部求解器）。
 */
