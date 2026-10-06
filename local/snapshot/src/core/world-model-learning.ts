/**
 * 83.0 世界模型学习内核 —— 模型学习 · 值迭代 · 后继特征 · Dyna 混合经验
 *
 * 动机: 无模型方法（Q-learning 族）每换一个目标就要从头交互——样本随目标数
 * 线性重复计费；21.0/22.0/53.0 的bandit侧是「已知模型算指数」，本内核补上另一
 * 半：从真实经验里把模型本身学出来（T̂, r̂），在其上规划，并让「换目标」退化为
 * 一次矩阵-向量内积（后继特征）。与 77.0 因果发现互补：因果学结构（谁影响谁），
 * 本内核学动态（以多大概率影响多少）；与 84.0 部分可观察规划配套：本内核学到的
 * T̂ 正是 84 的信念更新的转移输入——「基于模型的强化学习双件套」的模型件。
 *
 * 数学（表格口径，|S|×|A| 有限；奖励统一为期望口径 r[s][a]）:
 *   ① 模型学习（MLE + Dirichlet 平滑）:
 *      N(s,a,s') 逐转移计数；T̂(s'|s,a) = (N(s,a,s') + α)/(N(s,a) + α|S|)，
 *      r̂(s,a) = Σr/N(s,a)（未访问对为 0）。α→0 退化为纯 MLE，N→∞ 时
 *      T̂→T、r̂→r；每步参数偏差 O(α/N)，V̂ 偏差受 γ/(1−γ) 放大（锚点②实测）。
 *   ② 值迭代: V_{k+1}(s) = max_a [ r(s,a) + γ Σ_{s'}T(s'|s,a)V_k(s') ]，
 *      压缩映射因子 γ ⟹ ‖V_k − V*‖∞ ≤ γᵏ‖V₀ − V*‖∞；停机准则
 *      Δ∞ < tol·(1−γ)/γ 保证 ‖V − V*‖∞ ≤ tol（γ=1 时退化为 Δ∞ < tol，
 *      仅对正常（proper）MDP 收敛，内核诚实返回残差不冒充收敛）。
 *   ③ 后继特征（Successor Features, Barreto et al. 2017）:
 *      Ψ = (I − γP)⁻¹Φ（P 为固定策略的转移阵，迭代解 Ψ_{k+1} = Φ + γPΨ_k）。
 *      当奖励是状态的线性特征 r(s) = φ(s)·w 时 V^π(s) = Ψ(s)·w——换目标
 *      w→w' 只做内积 Ψw'，不触碰 P、不重规划；d 个目标共享同一 Ψ。
 *   ④ Dyna（Sutton 1991）: 每步真实 (s,a,r,s') 存入计数模型，另做 k 次从模型
 *     采样的 Q 备份——真实经验负责纠模型，仿真经验负责传播值；同样本预算下
 *     值信息沿链回传 ×k 加速（锚点⑤与纯 Q-learning 的样本效率对照）。
 *
 * R5-A17 世界性进化（数学轴 + 性能轴，2026-10）:
 *   ⑤ 优先扫除（Prioritized Sweeping, Moore & Atkeson 1993）:
 *     全扫值迭代对每个状态无差别备份——远端状态（Bellman 误差 ~ 0）与
 *     前线状态花同样的账。优先扫除把更新预算集中给 |TV(s) − V(s)| 最大
 *     的状态（大顶堆 + 前驱表传播: V(s) 更新后只重排「能一步到 s」的状态），
 *     终止判据与 valueIteration 完全同口径（max priority < tol·(1−γ)/γ ⟹
 *     ‖V − V*‖∞ ≤ tol，压缩映射的不变量），收敛点 = 同一 V*（两条路互证）。
 *     更新次数 backups 作为「省了多少次无用备份」的实测口径。
 *   ⑥ randomTabularMDP 工厂: 种子化随机表格 MDP（转移行指数-归一、奖励
 *     正态、可选吸收态），≥200 实例的性质测试的确定性数据源。
 *
 * 验证锚点（scripts/verify-model-pomdp.mjs，全部确定性——随机处只用种子化
 * mulberry32，同种子逐位复现）:
 *   ① 真模型 VI：4×3 经典 gridworld 的 V* 满足 Bellman 最优方程（残差 <1e-9）；
 *      确定性链闭式 V*(sᵢ) = γ^(n−2−i) 逐位一致 <1e-9。
 *   ② 模型学习收敛：随机链 + 均匀策略，episodes 逐档累积（3 种子平均）时
 *      ‖V̂−V*‖∞ 严格单调下降，最大档 <1e-3（经验→∞ 时 V̂→V* 的实证）。
 *   ③ SF 解 = VI 解：贪心策略 P 上 Ψw₁ 与（单动作 MDP 的）值迭代逐位一致 <1e-9。
 *   ④ 换目标重定向：Ψw₂ = 同一 P 上对 r₂ 的（单动作）VI 解 <1e-9——不重规划；
 *      且 Ψw₂ ≤ r₂ 下的最优 VI（旧策略在新目标下次优的方向诚实成立）。
 *   ⑤ Dyna 加速：确定性链、同一真实样本预算扫描，Dyna(每步 40 次规划备份)
 *      达到 |V̂(s₀)−V*| ≤ ε 的真实样本数显著少于纯 Q-learning 对照。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入
 */

// ─────────────────────────── 确定性随机源 ───────────────────────────

/** mulberry32：32 位确定性伪随机（种子固定时序列完全可复现） */
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

// ─────────────────────────── 类型 ───────────────────────────

/** 表格 MDP：转移行随机、奖励期望口径、吸收态自转移零奖励 */
export interface TabularMDP {
  readonly name: string;
  readonly states: string[];
  readonly actions: string[];
  /** T[s][a][s']（每行和 = 1） */
  readonly transitions: number[][][];
  /** r[s][a]：期望即时奖励（奖励按转移概率折入） */
  readonly rewards: number[][];
  readonly gamma: number;
  readonly start: number;
  /** 吸收态列表（工厂保证 T[s][a][s]=1、r=0） */
  readonly terminals: number[];
}

/** 单步经验 (s, a, r, s', terminal) */
export interface StepRecord {
  readonly state: number;
  readonly action: number;
  readonly reward: number;
  readonly nextState: number;
  readonly terminal: boolean;
}

export type Episode = StepRecord[];

/** 策略：状态 + rng → 动作下标（随机策略只许消费传入 rng） */
export type PolicyFn = (state: number, rng: () => number) => number;

/** learnModel 产物：Dirichlet 平滑 MLE 模型 + 计数审计 */
export interface LearnedModel {
  readonly T_hat: number[][][];
  readonly r_hat: number[][];
  readonly counts: number[][][];
  readonly Nsa: number[][];
  readonly prior: number;
  readonly steps: number;
}

export interface VIResult {
  readonly V: number[];
  readonly Q: number[][];
  readonly iterations: number;
  /** 收敛后 ‖max_a(r+γTV) − V‖∞（诚实口径：迭代不收敛时残差如实偏大） */
  readonly residual: number;
}

export interface QLearnOptions {
  /** 真实环境步数预算（公平对照的口径：两法同预算） */
  steps: number;
  /** 学习率 α ∈ (0,1]（缺省 0.2） */
  alpha?: number;
  /** ε-greedy 探索率 ∈ [0,1]（缺省 0.2） */
  epsilon?: number;
  seed: number;
  /** Q 初值（缺省 0；乐观初始化可传 R_max/(1−γ)） */
  optimistic?: number;
}

export interface QLearnResult {
  readonly Q: number[][];
  readonly valueAtStart: number;
  readonly avgReward: number;
  readonly steps: number;
}

export interface DynaOptions extends QLearnOptions {
  /** 每步真实经验后的规划（模型采样 Q 备份）次数（缺省 40） */
  planningSteps?: number;
}

export interface DynaResult extends QLearnResult {
  readonly planningSteps: number;
  readonly modelPairs: number;
}

// ─────────────────────────── 域工厂 ───────────────────────────

export interface ChainOptions {
  /** 状态数（含吸收终点），缺省 8 */
  n?: number;
  /** right 命中概率 ∈ (0,1]（1 = 确定性链），缺省 0.8 */
  pRight?: number;
  /** left 命中概率 ∈ [0,1]，缺省 0.6 */
  pLeft?: number;
  /** 折扣 ∈ (0,1)，缺省 0.9 */
  gamma?: number;
}

/**
 * 随机链：states 0..n−1，n−1 为吸收终点（进入得 +1）。
 * right: →s+1 概率 pRight，原地/后退 (1−pRight)/2 各半；left: →max(s−1,0) 概率 pLeft。
 * pRight=pLeft=1 时闭式 V*(sᵢ) = γ^(n−2−i)（验证锚点①）。
 */
export function makeChain(opts: ChainOptions = {}): TabularMDP {
  const n = opts.n ?? 8;
  const pRight = opts.pRight ?? 0.8;
  const pLeft = opts.pLeft ?? 0.6;
  const gamma = opts.gamma ?? 0.9;
  if (!Number.isInteger(n) || n < 3) throw new Error(`world-model: n 必须为 ≥3 整数（收到 ${n}）`);
  if (!(pRight > 0 && pRight <= 1)) throw new Error(`world-model: pRight ∈ (0,1]（收到 ${pRight}）`);
  if (!(pLeft >= 0 && pLeft <= 1)) throw new Error(`world-model: pLeft ∈ [0,1]（收到 ${pLeft}）`);
  if (!(gamma > 0 && gamma < 1)) throw new Error(`world-model: gamma ∈ (0,1)（收到 ${gamma}）`);

  const goal = n - 1;
  const T: number[][][] = [];
  const R: number[][] = [];
  for (let s = 0; s < n; s += 1) {
    const rows: number[][] = [];
    const rewards: number[] = [];
    // 动作 0 = right, 动作 1 = left
    for (let a = 0; a < 2; a += 1) {
      const row = new Array<number>(n).fill(0);
      if (s === goal) {
        row[goal] = 1;
        rewards.push(0);
      } else if (a === 0) {
        row[s + 1] += pRight;
        row[s] += (1 - pRight) / 2;
        row[Math.max(s - 1, 0)] += (1 - pRight) / 2;
        rewards.push(row[goal]);
      } else {
        row[Math.max(s - 1, 0)] += pLeft;
        row[s] += 1 - pLeft;
        rewards.push(row[goal]);
      }
      rows.push(row);
    }
    T.push(rows);
    R.push(rewards);
  }
  return {
    name: `chain-${n}`,
    states: Array.from({ length: n }, (_, i) => `s${i}`),
    actions: ['right', 'left'],
    transitions: T,
    rewards: R,
    gamma,
    start: 0,
    terminals: [goal],
  };
}

export interface GridworldOptions {
  rows?: number;
  cols?: number;
  /** 垂直滑动概率（两侧各 slip/2），缺省 0.2 */
  slip?: number;
  /** 活着扣分，缺省 −0.04 */
  living?: number;
  goalReward?: number;
  pitReward?: number;
  gamma?: number;
  /** 墙格 [row, col] 列表，缺省 [[1,1]] */
  walls?: Array<readonly [number, number]>;
  goalPos?: readonly [number, number];
  pitPos?: readonly [number, number];
  startPos?: readonly [number, number];
}

/**
 * 4×3 经典 gridworld（Russell & Norvig 口径）：+1/−1 吸收格、−0.04 活着扣分、
 * 0.8/0.1/0.1 滑动转向、撞墙/出界原地。缺省 γ=0.95。
 */
export function makeGridworld(opts: GridworldOptions = {}): TabularMDP {
  const rows = opts.rows ?? 3;
  const cols = opts.cols ?? 4;
  const slip = opts.slip ?? 0.2;
  const living = opts.living ?? -0.04;
  const goalReward = opts.goalReward ?? 1;
  const pitReward = opts.pitReward ?? -1;
  const gamma = opts.gamma ?? 0.95;
  const walls = opts.walls ?? [[1, 1] as const];
  const goalPos = opts.goalPos ?? ([0, cols - 1] as const);
  const pitPos = opts.pitPos ?? ([1, cols - 1] as const);
  const startPos = opts.startPos ?? ([rows - 1, 0] as const);
  if (!Number.isInteger(rows) || rows < 2 || !Number.isInteger(cols) || cols < 2) {
    throw new Error(`world-model: rows/cols 必须 ≥2 整数（收到 ${rows}×${cols}）`);
  }
  if (!(slip >= 0 && slip <= 1)) throw new Error(`world-model: slip ∈ [0,1]（收到 ${slip}）`);
  if (!(gamma > 0 && gamma < 1)) throw new Error(`world-model: gamma ∈ (0,1)（收到 ${gamma}）`);
  const inBounds = (r: number, c: number): boolean => r >= 0 && r < rows && c >= 0 && c < cols && !walls.some((w) => w[0] === r && w[1] === c);
  for (const w of walls) {
    if (w[0] < 0 || w[0] >= rows || w[1] < 0 || w[1] >= cols) {
      throw new Error(`world-model: 墙格 (${w[0]},${w[1]}) 越界`);
    }
  }
  for (const [label, p] of [
    ['goal', goalPos],
    ['pit', pitPos],
    ['start', startPos],
  ] as Array<[string, readonly [number, number]]>) {
    if (!inBounds(p[0], p[1])) throw new Error(`world-model: ${label} 位置 (${p[0]},${p[1]}) 越界或是墙`);
  }
  if (goalPos[0] === pitPos[0] && goalPos[1] === pitPos[1]) throw new Error('world-model: goal 与 pit 重叠');
  if ((startPos[0] === goalPos[0] && startPos[1] === goalPos[1]) || (startPos[0] === pitPos[0] && startPos[1] === pitPos[1])) {
    throw new Error('world-model: start 不得在吸收格上');
  }

  // 状态编号：行优先跳过墙
  const index = new Map<string, number>();
  const states: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (!inBounds(r, c)) continue;
      index.set(`${r},${c}`, states.length);
      states.push(`r${r}c${c}`);
    }
  }
  const idx = (r: number, c: number): number => index.get(`${r},${c}`)!;
  const goalIdx = idx(goalPos[0], goalPos[1]);
  const pitIdx = idx(pitPos[0], pitPos[1]);
  const startIdx = idx(startPos[0], startPos[1]);
  const actionDirs: Array<readonly [number, number]> = [[-1, 0], [0, 1], [1, 0], [0, -1]]; // up/right/down/left
  const nS = states.length;
  const nA = 4;
  const T: number[][][] = [];
  const R: number[][] = [];
  for (let s = 0; s < nS; s += 1) {
    T.push([]);
    R.push([]);
    const label = states[s]!;
    const row0 = Number(label.slice(1, label.indexOf('c')));
    const col0 = Number(label.slice(label.indexOf('c') + 1));
    const isTerminal = s === goalIdx || s === pitIdx;
    for (let a = 0; a < nA; a += 1) {
      const row = new Array<number>(nS).fill(0);
      if (isTerminal) {
        row[s] = 1;
        R[s]!.push(0);
      } else {
        const targets: Array<readonly [number, number, number]> = [
          [row0 + actionDirs[a]![0], col0 + actionDirs[a]![1], 1 - slip],
          [row0 + actionDirs[(a + 1) % 4]![0], col0 + actionDirs[(a + 1) % 4]![1], slip / 2],
          [row0 + actionDirs[(a + 3) % 4]![0], col0 + actionDirs[(a + 3) % 4]![1], slip / 2],
        ];
        for (const [tr, tc, p] of targets) {
          row[inBounds(tr, tc) ? idx(tr, tc) : s] += p;
        }
        // 期望奖励 = living + goalReward·P(入 goal) + pitReward·P(入 pit)（ΣT=1）
        R[s]!.push(living + goalReward * row[goalIdx]! + pitReward * row[pitIdx]!);
      }
      T[s]!.push(row);
    }
  }
  return {
    name: `gridworld-${cols}x${rows}`,
    states,
    actions: ['up', 'right', 'down', 'left'],
    transitions: T,
    rewards: R,
    gamma,
    start: startIdx,
    terminals: [goalIdx, pitIdx],
  };
}

// ─────────────────────────── 采样与模型学习 ───────────────────────────

function validateStateAction(mdp: TabularMDP, s: number, a: number, who: string): void {
  if (!Number.isInteger(s) || s < 0 || s >= mdp.states.length) throw new Error(`${who}: 状态下标越界（收到 ${s}）`);
  if (!Number.isInteger(a) || a < 0 || a >= mdp.actions.length) throw new Error(`${who}: 动作下标越界（收到 ${a}）`);
}

/** 从 MDP 采样一步（只消费传入 rng） */
export function sampleTransition(mdp: TabularMDP, s: number, a: number, rng: () => number): { state: number; reward: number; terminal: boolean } {
  validateStateAction(mdp, s, a, 'world-model/sampleTransition');
  const row = mdp.transitions[s]![a]!;
  const u = rng();
  let cum = 0;
  let next = 0;
  for (let s2 = 0; s2 < row.length; s2 += 1) {
    cum += row[s2]!;
    if (u < cum) {
      next = s2;
      break;
    }
  }
  return { state: next, reward: mdp.rewards[s]![a]!, terminal: mdp.terminals.includes(next) };
}

/** 均匀随机策略 */
export function randomPolicy(mdp: TabularMDP): PolicyFn {
  const nA = mdp.actions.length;
  return (_s, rng) => Math.floor(rng() * nA);
}

/** 贪心策略（对 Q 逐行 argmax，平局取小下标） */
export function greedyPolicyFn(Q: number[][]): PolicyFn {
  return (s) => {
    const row = Q[s];
    if (!row) throw new Error(`world-model/greedyPolicyFn: 状态 ${s} 无 Q 行`);
    let best = 0;
    for (let a = 1; a < row.length; a += 1) if (row[a]! > row[best]!) best = a;
    return best;
  };
}

/** ε-greedy 策略（随机处只消费传入 rng） */
export function epsGreedyPolicyFn(Q: number[][], epsilon: number): PolicyFn {
  if (!(epsilon >= 0 && epsilon <= 1)) throw new Error(`world-model/epsGreedyPolicyFn: epsilon ∈ [0,1]（收到 ${epsilon}）`);
  const greedy = greedyPolicyFn(Q);
  return (s, rng) => (rng() < epsilon ? Math.floor(rng() * Q[s]!.length) : greedy(s, rng));
}

/** 收集 n 条 episodes（起点 mdp.start；到达吸收态或步数上限即结束） */
export function collectEpisodes(mdp: TabularMDP, policy: PolicyFn, n: number, seed: number, maxStepsPerEpisode = 500): Episode[] {
  if (!Number.isInteger(n) || n < 0) throw new Error(`world-model/collectEpisodes: n 必须 ≥0 整数（收到 ${n}）`);
  if (!Number.isInteger(maxStepsPerEpisode) || maxStepsPerEpisode < 1) {
    throw new Error(`world-model/collectEpisodes: maxSteps ≥1（收到 ${maxStepsPerEpisode}）`);
  }
  const rng = mulberry32(seed);
  const episodes: Episode[] = [];
  for (let e = 0; e < n; e += 1) {
    const ep: Episode = [];
    let s = mdp.start;
    for (let t = 0; t < maxStepsPerEpisode; t += 1) {
      const a = policy(s, rng);
      validateStateAction(mdp, s, a, 'world-model/collectEpisodes(策略返回值)');
      const tr = sampleTransition(mdp, s, a, rng);
      ep.push({ state: s, action: a, reward: tr.reward, nextState: tr.state, terminal: tr.terminal });
      if (tr.terminal) break;
      s = tr.state;
    }
    episodes.push(ep);
  }
  return episodes;
}

/**
 * 模型学习：转移/奖励计数 MLE + Dirichlet(α) 平滑。
 * T̂(s'|s,a) = (N+α)/(N_sa+α|S|)；r̂(s,a) = 平均观测奖励（未访问对为 0）。
 * 吸收态行不参与 MLE——「episode 在此结束」本身就是吸收动力学的完全观测，
 * 结构上直接保留 T̂[t][a][t]=1、r̂=0（若按平滑学习会引入 T̂(·|吸收态) 的
 * 均匀泄漏伪影，见验证锚点②的对照注释）。
 */
export function learnModel(mdp: TabularMDP, episodes: Episode[], prior = 1): LearnedModel {
  if (!(prior >= 0 && Number.isFinite(prior))) throw new Error(`world-model/learnModel: prior 必须 ≥0 有限（收到 ${prior}）`);
  const nS = mdp.states.length;
  const nA = mdp.actions.length;
  const counts: number[][][] = Array.from({ length: nS }, () => Array.from({ length: nA }, () => new Array<number>(nS).fill(0)));
  const Nsa: number[][] = Array.from({ length: nS }, () => new Array<number>(nA).fill(0));
  const rewardSum: number[][] = Array.from({ length: nS }, () => new Array<number>(nA).fill(0));
  let steps = 0;
  for (const ep of episodes) {
    for (const st of ep) {
      validateStateAction(mdp, st.state, st.action, 'world-model/learnModel');
      if (!Number.isInteger(st.nextState) || st.nextState < 0 || st.nextState >= nS) {
        throw new Error(`world-model/learnModel: nextState 越界（收到 ${st.nextState}）`);
      }
      if (!Number.isFinite(st.reward)) throw new Error('world-model/learnModel: reward 必须有限');
      counts[st.state]![st.action]![st.nextState]! += 1;
      Nsa[st.state]![st.action]! += 1;
      rewardSum[st.state]![st.action]! += st.reward;
      steps += 1;
    }
  }
  const terminalSet = new Set<number>(mdp.terminals);
  const T_hat: number[][][] = [];
  const r_hat: number[][] = [];
  for (let s = 0; s < nS; s += 1) {
    T_hat.push([]);
    r_hat.push([]);
    for (let a = 0; a < nA; a += 1) {
      if (terminalSet.has(s)) {
        const row = new Array<number>(nS).fill(0);
        row[s] = 1;
        T_hat[s]!.push(row);
        r_hat[s]!.push(0);
        continue;
      }
      const n = Nsa[s]![a]!;
      const denom = n + prior * nS;
      T_hat[s]!.push(counts[s]![a]!.map((c) => (c + prior) / denom));
      r_hat[s]!.push(n > 0 ? rewardSum[s]![a]! / n : 0);
    }
  }
  return { T_hat, r_hat, counts, Nsa, prior, steps };
}

// ─────────────────────────── 规划 ───────────────────────────

function validateTransitionTensor(T: number[][][], r: number[][], gamma: number, who: string): { nS: number; nA: number } {
  if (!Array.isArray(T) || T.length === 0) throw new Error(`${who}: T 非空张量`);
  const nS = T.length;
  const nA = T[0]!.length;
  if (nA === 0) throw new Error(`${who}: 动作维度为空`);
  if (!(gamma > 0 && gamma <= 1)) throw new Error(`${who}: gamma ∈ (0,1]（收到 ${gamma}）`);
  for (let s = 0; s < nS; s += 1) {
    if (T[s]!.length !== nA) throw new Error(`${who}: T[${s}] 动作维度不一致`);
    if (r.length !== nS || r[s]!.length !== nA) throw new Error(`${who}: r 维度与 T 不匹配`);
    for (let a = 0; a < nA; a += 1) {
      const row = T[s]![a]!;
      if (row.length !== nS) throw new Error(`${who}: T[${s}][${a}] 状态维度不一致`);
      let sum = 0;
      for (const p of row) {
        if (!Number.isFinite(p) || p < 0) throw new Error(`${who}: 转移概率必须有限非负`);
        sum += p;
      }
      if (Math.abs(sum - 1) > 1e-6) throw new Error(`${who}: T[${s}][${a}] 行和 ${sum} ≠ 1`);
      if (!Number.isFinite(r[s]![a]!)) throw new Error(`${who}: r[${s}][${a}] 非有限`);
    }
  }
  return { nS, nA };
}

/**
 * 值迭代：V_{k+1} = max_a(r + γTV)。停机 Δ∞ < tol·(1−γ)/γ（γ=1 时 Δ∞ < tol，
 * 仅正常 MDP 收敛——residual 字段诚实回报）。
 */
export function valueIteration(T: number[][][], r: number[][], gamma: number, tol = 1e-11, maxIter = 200000): VIResult {
  const { nS, nA } = validateTransitionTensor(T, r, gamma, 'world-model/valueIteration');
  if (!(tol > 0)) throw new Error(`world-model/valueIteration: tol > 0（收到 ${tol}）`);
  const stopDelta = gamma >= 1 ? tol : (tol * (1 - gamma)) / gamma;
  let V = new Array<number>(nS).fill(0);
  let iterations = 0;
  let delta = Number.POSITIVE_INFINITY;
  while (iterations < maxIter && delta >= stopDelta) {
    iterations += 1;
    delta = 0;
    const next = new Array<number>(nS).fill(0);
    for (let s = 0; s < nS; s += 1) {
      let best = Number.NEGATIVE_INFINITY;
      for (let a = 0; a < nA; a += 1) {
        let acc = r[s]![a]!;
        const row = T[s]![a]!;
        for (let s2 = 0; s2 < nS; s2 += 1) acc += gamma * row[s2]! * V[s2]!;
        if (acc > best) best = acc;
      }
      next[s] = best;
      const d = Math.abs(best - V[s]!);
      if (d > delta) delta = d;
    }
    V = next;
  }
  const Q: number[][] = [];
  let residual = 0;
  for (let s = 0; s < nS; s += 1) {
    Q.push([]);
    let best = Number.NEGATIVE_INFINITY;
    for (let a = 0; a < nA; a += 1) {
      let acc = r[s]![a]!;
      const row = T[s]![a]!;
      for (let s2 = 0; s2 < nS; s2 += 1) acc += gamma * row[s2]! * V[s2]!;
      Q[s]!.push(acc);
      if (acc > best) best = acc;
    }
    const res = Math.abs(best - V[s]!);
    if (res > residual) residual = res;
  }
  return { V, Q, iterations, residual };
}

/** Bellman 最优残差 ‖max_a(r+γTV) − V‖∞（V* 判据的独立口径） */
export function bellmanResidual(V: number[], T: number[][][], r: number[][], gamma: number): number {
  const { nS, nA } = validateTransitionTensor(T, r, gamma, 'world-model/bellmanResidual');
  if (V.length !== nS) throw new Error('world-model/bellmanResidual: V 维度与 T 不匹配');
  let residual = 0;
  for (let s = 0; s < nS; s += 1) {
    let best = Number.NEGATIVE_INFINITY;
    for (let a = 0; a < nA; a += 1) {
      let acc = r[s]![a]!;
      for (let s2 = 0; s2 < nS; s2 += 1) acc += gamma * T[s]![a]![s2]! * V[s2]!;
      if (acc > best) best = acc;
    }
    const res = Math.abs(best - V[s]!);
    if (res > residual) residual = res;
  }
  return residual;
}

/** 单链（固定策略）策略评估：V_{k+1} = r + γPV（与 valueIteration 同停机口径） */
export function policyValue(P: number[][], rVec: number[], gamma: number, tol = 1e-12, maxIter = 200000): { V: number[]; iterations: number } {
  const nS = P.length;
  if (nS === 0) throw new Error('world-model/policyValue: P 非空');
  if (rVec.length !== nS) throw new Error('world-model/policyValue: rVec 维度与 P 不匹配');
  if (!(gamma > 0 && gamma <= 1)) throw new Error(`world-model/policyValue: gamma ∈ (0,1]（收到 ${gamma}）`);
  for (let s = 0; s < nS; s += 1) {
    if (P[s]!.length !== nS) throw new Error('world-model/policyValue: P 必须为方阵');
    let sum = 0;
    for (const p of P[s]!) {
      if (!Number.isFinite(p) || p < 0) throw new Error('world-model/policyValue: 转移概率必须有限非负');
      sum += p;
    }
    if (Math.abs(sum - 1) > 1e-6) throw new Error(`world-model/policyValue: P[${s}] 行和 ${sum} ≠ 1`);
    if (!Number.isFinite(rVec[s]!)) throw new Error('world-model/policyValue: rVec 非有限');
  }
  const stopDelta = gamma >= 1 ? tol : (tol * (1 - gamma)) / gamma;
  let V = new Array<number>(nS).fill(0);
  let iterations = 0;
  let delta = Number.POSITIVE_INFINITY;
  while (iterations < maxIter && delta >= stopDelta) {
    iterations += 1;
    delta = 0;
    const next = new Array<number>(nS).fill(0);
    for (let s = 0; s < nS; s += 1) {
      let acc = 0;
      for (let s2 = 0; s2 < nS; s2 += 1) acc += P[s]![s2]! * V[s2]!;
      next[s] = rVec[s]! + gamma * acc;
      const d = Math.abs(next[s]! - V[s]!);
      if (d > delta) delta = d;
    }
    V = next;
  }
  return { V, iterations };
}

/** 逐行 argmax 动作下标（平局取小下标） */
export function greedyActions(Q: number[][]): number[] {
  return Q.map((row) => {
    let best = 0;
    for (let a = 1; a < row.length; a += 1) if (row[a]! > row[best]!) best = a;
    return best;
  });
}

/** 贪心策略的转移阵：P[s] = T[s][argmax_a Q[s][a]] */
export function greedyPolicyMatrix(T: number[][][], Q: number[][]): number[][] {
  const nS = T.length;
  if (Q.length !== nS) throw new Error('world-model/greedyPolicyMatrix: Q 与 T 状态维度不匹配');
  const actions = greedyActions(Q);
  return actions.map((a, s) => {
    if (T[s]!.length <= a) throw new Error(`world-model/greedyPolicyMatrix: Q[${s}][${a}] 超出动作维度`);
    return T[s]![a]!.slice();
  });
}

/**
 * 后继特征：Ψ = (I − γP)⁻¹Φ，迭代解 Ψ_{k+1} = Φ + γPΨ_k。
 * P 为固定策略转移阵；Φ 为 |S|×d 特征矩阵（吸收态特征应置零向量）。
 */
export function successorFeatures(P: number[][], phi: number[][], gamma: number, tol = 1e-12, maxIter = 200000): { psi: number[][]; iterations: number } {
  const nS = P.length;
  if (nS === 0 || phi.length !== nS) throw new Error('world-model/successorFeatures: P 与 phi 状态维度不匹配');
  const d = phi[0]!.length;
  if (d === 0) throw new Error('world-model/successorFeatures: 特征维度为空');
  if (!(gamma > 0 && gamma < 1)) throw new Error(`world-model/successorFeatures: gamma ∈ (0,1)（收到 ${gamma}）`);
  for (let s = 0; s < nS; s += 1) {
    if (phi[s]!.length !== d) throw new Error('world-model/successorFeatures: phi 各行维度不一致');
    for (const v of phi[s]!) if (!Number.isFinite(v)) throw new Error('world-model/successorFeatures: 特征值非有限');
  }
  for (let s = 0; s < nS; s += 1) {
    let sum = 0;
    for (const p of P[s]!) sum += p;
    if (P[s]!.length !== nS || Math.abs(sum - 1) > 1e-6) throw new Error(`world-model/successorFeatures: P[${s}] 非随机行`);
  }
  const stopDelta = (tol * (1 - gamma)) / gamma;
  let psi: number[][] = Array.from({ length: nS }, () => new Array<number>(d).fill(0));
  let iterations = 0;
  let delta = Number.POSITIVE_INFINITY;
  while (iterations < maxIter && delta >= stopDelta) {
    iterations += 1;
    delta = 0;
    const next: number[][] = Array.from({ length: nS }, () => new Array<number>(d).fill(0));
    for (let s = 0; s < nS; s += 1) {
      for (let k = 0; k < d; k += 1) {
        let acc = 0;
        for (let s2 = 0; s2 < nS; s2 += 1) acc += P[s]![s2]! * psi[s2]![k]!;
        const v = phi[s]![k]! + gamma * acc;
        next[s]![k] = v;
        const dd = Math.abs(v - psi[s]![k]!);
        if (dd > delta) delta = dd;
      }
    }
    psi = next;
  }
  return { psi, iterations };
}

/** 换目标：V(s) = Ψ(s)·w——一次内积，不重规划（r(s)=φ(s)·w 口径） */
export function retarget(psi: number[][], w: number[]): number[] {
  const d = w.length;
  if (d === 0) throw new Error('world-model/retarget: w 非空');
  return psi.map((row) => {
    if (row.length !== d) throw new Error('world-model/retarget: psi 行维度与 w 不匹配');
    let acc = 0;
    for (let k = 0; k < d; k += 1) {
      if (!Number.isFinite(w[k]!)) throw new Error('world-model/retarget: w 非有限');
      acc += row[k]! * w[k]!;
    }
    return acc;
  });
}

// ─────────────────────────── 无模型对照与 Dyna ───────────────────────────

function argmaxQ(row: number[]): number {
  let best = 0;
  for (let a = 1; a < row.length; a += 1) if (row[a]! > row[best]!) best = a;
  return best;
}

function maxQof(row: number[]): number {
  return row[argmaxQ(row)]!;
}

function validateQLearnOptions(mdp: TabularMDP, opts: QLearnOptions, who: string): { alpha: number; epsilon: number; optimistic: number } {
  if (!Number.isInteger(opts.steps) || opts.steps < 1) throw new Error(`${who}: steps ≥1 整数（收到 ${opts.steps}）`);
  const alpha = opts.alpha ?? 0.2;
  const epsilon = opts.epsilon ?? 0.2;
  const optimistic = opts.optimistic ?? 0;
  if (!(alpha > 0 && alpha <= 1)) throw new Error(`${who}: alpha ∈ (0,1]（收到 ${alpha}）`);
  if (!(epsilon >= 0 && epsilon <= 1)) throw new Error(`${who}: epsilon ∈ [0,1]（收到 ${epsilon}）`);
  if (!Number.isFinite(optimistic) || !Number.isFinite(opts.seed)) throw new Error(`${who}: optimistic/seed 必须有限`);
  if (mdp.states.length === 0 || mdp.actions.length === 0) throw new Error(`${who}: 空 MDP`);
  return { alpha, epsilon, optimistic };
}

/** 表格 Q-learning（ε-greedy，episode 结束回到起点；只消费种子 rng） */
export function qLearning(mdp: TabularMDP, opts: QLearnOptions): QLearnResult {
  const { alpha, epsilon, optimistic } = validateQLearnOptions(mdp, opts, 'world-model/qLearning');
  const nS = mdp.states.length;
  const nA = mdp.actions.length;
  const rng = mulberry32(opts.seed);
  const Q: number[][] = Array.from({ length: nS }, () => new Array<number>(nA).fill(optimistic));
  const terminal = (s: number): boolean => mdp.terminals.includes(s);
  let s = mdp.start;
  let rewardSum = 0;
  for (let k = 0; k < opts.steps; k += 1) {
    const a = rng() < epsilon ? Math.floor(rng() * nA) : argmaxQ(Q[s]!);
    const tr = sampleTransition(mdp, s, a, rng);
    const target = tr.terminal ? tr.reward : tr.reward + mdp.gamma * maxQof(Q[tr.state]!);
    Q[s]![a]! += alpha * (target - Q[s]![a]!);
    rewardSum += tr.reward;
    s = tr.terminal ? mdp.start : tr.state;
  }
  return { Q, valueAtStart: maxQof(Q[mdp.start]!), avgReward: rewardSum / opts.steps, steps: opts.steps };
}

/**
 * Dyna-Q：每步真实经验后做 k 次模型采样 Q 备份（模型 = 计数 MLE，
 * (s,a) 均匀抽取、s' 按计数采样）。真实样本数与 qLearning 同口径公平对照。
 */
export function dynaQ(mdp: TabularMDP, opts: DynaOptions): DynaResult {
  const { alpha, epsilon, optimistic } = validateQLearnOptions(mdp, opts, 'world-model/dynaQ');
  const planningSteps = opts.planningSteps ?? 40;
  if (!Number.isInteger(planningSteps) || planningSteps < 0) {
    throw new Error(`world-model/dynaQ: planningSteps ≥0 整数（收到 ${planningSteps}）`);
  }
  const nS = mdp.states.length;
  const nA = mdp.actions.length;
  const rng = mulberry32(opts.seed);
  const Q: number[][] = Array.from({ length: nS }, () => new Array<number>(nA).fill(optimistic));
  const counts: number[][][] = Array.from({ length: nS }, () => Array.from({ length: nA }, () => new Array<number>(nS).fill(0)));
  const Nsa: number[][] = Array.from({ length: nS }, () => new Array<number>(nA).fill(0));
  const rewardSum: number[][] = Array.from({ length: nS }, () => new Array<number>(nA).fill(0));
  const pairs: Array<[number, number]> = [];
  const terminal = (s: number): boolean => mdp.terminals.includes(s);
  let s = mdp.start;
  let rewardTotal = 0;
  for (let k = 0; k < opts.steps; k += 1) {
    const a = rng() < epsilon ? Math.floor(rng() * nA) : argmaxQ(Q[s]!);
    const tr = sampleTransition(mdp, s, a, rng);
    // ① 真实 Q 备份 + 模型记录
    const target = tr.terminal ? tr.reward : tr.reward + mdp.gamma * maxQof(Q[tr.state]!);
    Q[s]![a]! += alpha * (target - Q[s]![a]!);
    if (Nsa[s]![a]! === 0) pairs.push([s, a]);
    counts[s]![a]![tr.state]! += 1;
    Nsa[s]![a]! += 1;
    rewardSum[s]![a]! += tr.reward;
    rewardTotal += tr.reward;
    s = tr.terminal ? mdp.start : tr.state;
    // ② k 次规划：从模型采样备份（值沿链回传 ×k）
    for (let p = 0; p < planningSteps; p += 1) {
      const [ps, pa] = pairs[Math.floor(rng() * pairs.length)]!;
      const row = counts[ps]![pa]!;
      const u = rng() * Nsa[ps]![pa]!;
      let cum = 0;
      let ps2 = 0;
      for (let s2 = 0; s2 < row.length; s2 += 1) {
        cum += row[s2]!;
        if (u < cum) {
          ps2 = s2;
          break;
        }
      }
      const pr = rewardSum[ps]![pa]! / Nsa[ps]![pa]!;
      const ptarget = terminal(ps2) ? pr : pr + mdp.gamma * maxQof(Q[ps2]!);
      Q[ps]![pa]! += alpha * (ptarget - Q[ps]![pa]!);
    }
  }
  return {
    Q,
    valueAtStart: maxQof(Q[mdp.start]!),
    avgReward: rewardTotal / opts.steps,
    steps: opts.steps,
    planningSteps,
    modelPairs: pairs.length,
  };
}

/* ── R5: 优先扫除（值迭代的更新预算聚焦） + 随机 MDP 工厂 ────────────── */

export interface PrioritizedSweepingOptions {
  /** 收敛容差（缺省 1e-11；停机口径与 valueIteration 完全一致） */
  tol?: number;
  /** 最大 V-更新次数（缺省 200000；触顶 = 不收敛，诚实返回） */
  maxUpdates?: number;
}

export interface PrioritizedSweepingResult {
  readonly V: number[];
  readonly Q: number[][];
  /** Bellman V-更新（备份）次数——与全扫 VI 的 iterations×|S| 对照 */
  readonly backups: number;
  /** Bellman 备份求值次数（含优先级计算）——工作量口径 */
  readonly evaluations: number;
  /** 堆内峰值条目数（内存口径） */
  readonly peakQueue: number;
  readonly residual: number;
  readonly converged: boolean;
}

/**
 * 优先扫除（Moore & Atkeson 1993）: 只备份 Bellman 误差 |TV−V| 最大的状态，
 * 更新后沿前驱表传播新优先级。终止 = 堆顶优先级 < tol·(1−γ)/γ——与
 * valueIteration 同判据（此时 ‖V−V*‖∞ ≤ tol，γ=1 时退化为 Δ∞ < tol 的
 * 正常 MDP 口径），收敛点 = 同一 V*（不动点唯一）。
 *
 * 确定性: 堆序 (priority desc, state asc)；惰性删除（版本号过滤陈旧条目）。
 */
export function prioritizedSweeping(
  T: number[][][],
  r: number[][],
  gamma: number,
  options?: PrioritizedSweepingOptions,
): PrioritizedSweepingResult {
  const { nS, nA } = validateTransitionTensor(T, r, gamma, 'world-model/prioritizedSweeping');
  const tol = options?.tol ?? 1e-11;
  if (!(tol > 0)) throw new Error(`world-model/prioritizedSweeping: tol > 0（收到 ${tol}）`);
  const maxUpdates = options?.maxUpdates ?? 200000;
  if (!Number.isInteger(maxUpdates) || maxUpdates < 1) {
    throw new Error(`world-model/prioritizedSweeping: maxUpdates ≥1 整数（收到 ${maxUpdates}）`);
  }
  const stopDelta = gamma >= 1 ? tol : (tol * (1 - gamma)) / gamma;

  // 前驱表: pred[s2] = { s : ∃a, T[s][a][s2] > 0 }（含 s2 自环）
  const pred: Array<Set<number>> = Array.from({ length: nS }, () => new Set<number>());
  for (let s = 0; s < nS; s += 1) {
    for (let a = 0; a < nA; a += 1) {
      const row = T[s]![a]!;
      for (let s2 = 0; s2 < nS; s2 += 1) if (row[s2]! > 0) pred[s2]!.add(s);
    }
  }

  const V = new Array<number>(nS).fill(0);
  /** Bellman 最优备份 max_a(r + γTV)（不写回） */
  const backup = (s: number): number => {
    let best = Number.NEGATIVE_INFINITY;
    for (let a = 0; a < nA; a += 1) {
      let acc = r[s]![a]!;
      const row = T[s]![a]!;
      for (let s2 = 0; s2 < nS; s2 += 1) acc += gamma * row[s2]! * V[s2]!;
      if (acc > best) best = acc;
    }
    return best;
  };

  // 大顶堆: (priority, state, version)；同优先级取小状态号（确定性）
  const heapP: number[] = [];
  const heapS: number[] = [];
  const heapV: number[] = [];
  const version = new Int32Array(nS);
  let evaluations = 0;
  let backups = 0;
  let peakQueue = 0;
  const swapAt = (i: number, j: number): void => {
    const tp = heapP[i]!;
    heapP[i] = heapP[j]!;
    heapP[j] = tp;
    const ts = heapS[i]!;
    heapS[i] = heapS[j]!;
    heapS[j] = ts;
    const tv = heapV[i]!;
    heapV[i] = heapV[j]!;
    heapV[j] = tv;
  };
  const higher = (i: number, j: number): boolean =>
    heapP[i]! > heapP[j]! || (heapP[i]! === heapP[j]! && heapS[i]! < heapS[j]!);
  const push = (priority: number, state: number, ver: number): void => {
    heapP.push(priority);
    heapS.push(state);
    heapV.push(ver);
    let c = heapP.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (higher(c, p)) {
        swapAt(c, p);
        c = p;
      } else break;
    }
    if (heapP.length > peakQueue) peakQueue = heapP.length;
  };
  const popTop = (): void => {
    const last = heapP.length - 1;
    heapP[0] = heapP[last]!;
    heapS[0] = heapS[last]!;
    heapV[0] = heapV[last]!;
    heapP.pop();
    heapS.pop();
    heapV.pop();
    let c = 0;
    for (;;) {
      const l = 2 * c + 1;
      const r = l + 1;
      let best = c;
      if (l < heapP.length && higher(l, best)) best = l;
      if (r < heapP.length && higher(r, best)) best = r;
      if (best === c) break;
      swapAt(c, best);
      c = best;
    }
  };

  // 初始优先级: 全状态一次备份求值（等价一轮全扫的代价，换来此后只扫「有误差的」）
  for (let s = 0; s < nS; s += 1) {
    evaluations += 1;
    const p = Math.abs(backup(s) - V[s]!);
    if (p >= stopDelta) push(p, s, version[s]);
  }

  let converged = false;
  while (heapP.length > 0 && backups < maxUpdates) {
    const topP = heapP[0]!;
    const topS = heapS[0]!;
    const topV = heapV[0]!;
    popTop();
    if (topV !== version[topS]) continue; // 惰性删除: 陈旧条目
    if (topP < stopDelta) {
      // 堆顶（真实当前优先级）已低于停机线 ⟹ 全体低于（大顶堆序）
      push(topP, topS, topV); // 放回（保持终止态可审计）
      converged = true;
      break;
    }
    // ① 备份并写回
    evaluations += 1;
    const nextV = backup(topS);
    V[topS] = nextV;
    backups += 1;
    // ② 前驱 + 自身的优先级传播（值变了才可能变优先级）
    const dirty = [topS, ...pred[topS]!];
    for (const s of dirty) {
      evaluations += 1;
      const p = Math.abs(backup(s) - V[s]!);
      if (p >= stopDelta) {
        version[s] += 1;
        push(p, s, version[s]);
      } else {
        version[s] += 1; // 即使低于停机线也使旧条目失效（诚实口径: 不再可用）
      }
    }
  }
  if (heapP.length === 0) converged = true; // 队列清空 = 全体当前优先级低于停机线

  // 收口: Q 与残差（与 valueIteration 的收口口径逐字相同）
  const Q: number[][] = [];
  let residual = 0;
  for (let s = 0; s < nS; s += 1) {
    Q.push([]);
    let best = Number.NEGATIVE_INFINITY;
    for (let a = 0; a < nA; a += 1) {
      let acc = r[s]![a]!;
      const row = T[s]![a]!;
      for (let s2 = 0; s2 < nS; s2 += 1) acc += gamma * row[s2]! * V[s2]!;
      Q[s]!.push(acc);
      if (acc > best) best = acc;
    }
    const res = Math.abs(best - V[s]!);
    if (res > residual) residual = res;
  }
  return { V, Q, backups, evaluations, peakQueue, residual, converged };
}

export interface RandomMdpOptions {
  /** 折扣 ∈ (0,1)，缺省 0.9 */
  gamma?: number;
  /** 吸收态个数（缺省 1；吸收态自转移零奖励） */
  terminals?: number;
  /** 转移行集中度（缺省 1；越大越接近确定性转移） */
  concentration?: number;
}

/**
 * 种子化随机表格 MDP（性质测试的数据源）: 非吸收行由 concentration·N(0,1)
 * 取指数后归一（softmax 温度口径——行和恒为 1），奖励 ~ N(0,1)，末
 * terminals 个状态为吸收（T[t][a][t]=1、r=0）。同 seed 逐位复现。
 */
export function randomTabularMDP(nS: number, nA: number, seed: number, options?: RandomMdpOptions): TabularMDP {
  if (!Number.isInteger(nS) || nS < 2) throw new Error(`world-model/randomTabularMDP: nS ≥2 整数（收到 ${nS}）`);
  if (!Number.isInteger(nA) || nA < 1) throw new Error(`world-model/randomTabularMDP: nA ≥1 整数（收到 ${nA}）`);
  if (!Number.isFinite(seed)) throw new Error('world-model/randomTabularMDP: seed 需为有限数');
  const gamma = options?.gamma ?? 0.9;
  if (!(gamma > 0 && gamma < 1)) throw new Error(`world-model/randomTabularMDP: gamma ∈ (0,1)（收到 ${gamma}）`);
  const terminals = options?.terminals ?? 1;
  if (!Number.isInteger(terminals) || terminals < 0 || terminals > nS) {
    throw new Error(`world-model/randomTabularMDP: terminals ∈ [0, ${nS}]（收到 ${terminals}）`);
  }
  const concentration = options?.concentration ?? 1;
  if (!Number.isFinite(concentration) || concentration <= 0) {
    throw new Error(`world-model/randomTabularMDP: concentration 需为正有限数（收到 ${concentration}）`);
  }
  const rng = mulberry32(seed);
  const normal = (): number => {
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const T: number[][][] = [];
  const R: number[][] = [];
  for (let s = 0; s < nS; s += 1) {
    const rows: number[][] = [];
    const rewards: number[] = [];
    const isTerminal = s >= nS - terminals;
    for (let a = 0; a < nA; a += 1) {
      if (isTerminal) {
        const row = new Array<number>(nS).fill(0);
        row[s] = 1;
        rows.push(row);
        rewards.push(0);
        continue;
      }
      const logits = Array.from({ length: nS }, () => concentration * normal());
      let maxLogit = Number.NEGATIVE_INFINITY;
      for (const l of logits) maxLogit = Math.max(maxLogit, l);
      const exps = logits.map((l) => Math.exp(l - maxLogit));
      let sum = 0;
      for (const e of exps) sum += e;
      rows.push(exps.map((e) => e / sum));
      rewards.push(normal());
    }
    T.push(rows);
    R.push(rewards);
  }
  return {
    name: `random-${nS}x${nA}-${seed}`,
    states: Array.from({ length: nS }, (_, i) => `s${i}`),
    actions: Array.from({ length: nA }, (_, i) => `a${i}`),
    transitions: T,
    rewards: R,
    gamma,
    start: 0,
    terminals: Array.from({ length: terminals }, (_, i) => nS - 1 - i),
  };
}

/* ── 接线建议 ─────────────────────────────────────────────────────────
 *
 * 1. 世界模型引擎（模型件的在线自学）:
 *    - 把调度轨迹离散化为 (状态=资源画像档, 动作=模型选择/并发档, 奖励=目标特征)，
 *      collectEpisodes 采集、learnModel 学 T̂/r̂；Dirichlet α 即先验强度旋钮——
 *      冷启动用大 α（接近均匀先验），数据量上来后调小让数据说话；
 *    - valueIteration(T̂, r̂) 出策略与 Q 表；bellmanResidual 作模型-策略
 *      联合健康度指标（残差大 = 模型或迭代有问题，先诊断再动作用）。
 *
 * 2. 换目标不重规划（SLA 权重日调）:
 *    - 奖励向量化 r(s) = φ(s)·w（延迟/成本/质量三特征），对当前运行策略 P
 *      一次 successorFeatures 解 Ψ；之后 w → w' 的目标调整只做 retarget 内积，
 *      策略评估 O(|S|·d) 而非重新迭代——A/B 权重实验、敏感性分析全部免费。
 *    - 与 77.0 因果发现互补：因果学结构方向（边），本内核学转移动态（权重），
 *      因果图可做 T̂ 的稀疏先验（只允许因果边上的概率质量）。
 *
 * 3. Dyna 混合经验（影子流量口径）:
 *    - 小流量真实请求 + 模型仿真回放：真实样本只用于纠模型（learnModel），
 *      策略收敛靠 dynaQ 的规划备份加速——同真实流量预算下更快达到 ε-最优，
 *      适合高成本动作（扩容/切流）不能频繁试错的场景。
 *
 * 4. 与 84.0 部分可观察规划联动:
 *    - 本内核学到的 T̂ 直接作为 84 的 POMDP 转移输入（模型 → 信念规划）；
 *      84 的「听」动作（观测）设计反过来决定这里 φ/状态离散化的信息分辨率。
 *
 * 5. 挂载边界（零介入承诺）:
 *    - 只读挂载：引擎调用纯函数获取分析结果，内核不发起调度、不写状态、
 *      不含 I/O 与时间源；未挂载时现有路径逐位一致。
 * ────────────────────────────────────────────────────────────────── */
