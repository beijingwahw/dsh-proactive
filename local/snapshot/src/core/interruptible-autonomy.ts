/**
 * 95.0 中断交接内核（R5 进化 95.1）—— 可中断自主性 · 离线策略修正 · 人机交接经济学
 *
 * 动机: 自主执行轴的两个「人」时刻都没有数学：
 *   - **可中断性**: 自主系统随时可能被人接管/打断（运维改配置、用户插手、
 *     安全器急停）。Orseau–Lattimore《Safe Interruptibility》(2016) 的核心
 *     问题是：被打断的学习器还会收敛到「没被打断时的最优策略」吗？答案是
 *     否定的——中断改变了智能体经历的转移分布，无修正的 Q-learning 把
 *     「操作者的手」当成「环境动力学」学进值函数，收敛到被打断 MDP 的
 *     最优——一个被人类的干预习惯塑形的策略，而非真实最优。
 *   - **何时交给人**: 决策引擎的 ask-user（src/decision-engine.ts 四级决策）
 *     靠经验阈值（连续失败 ≥ N 次、置信度 < 阈值）触发。什么时候求助本质
 *     是期望成本比较：自动执行的期望损失 p(error|s)·c_auto(s) vs 人工接管
 *     的固定成本 + 延迟 c_human + c_delay——最优阈值有闭式解，不必拍脑袋。
 *
 * 数学:
 *   ① 可中断 Q-learning（表格口径，确定性转移世界 + 种子化 ε-greedy）:
 *      中断即「策略被暂时替换」: 调度 fires(s,a,s') 为真时，智能体经历的
 *      转移被覆盖——奖励替换为干预罚金 penalty、下一状态替换为 destination
 *      （被搬回低奖赏区），但情节继续。两种学习口径:
 *        correction='none': Q(s,a) ← r_penalty + γ·max_b Q(s_destination, b)
 *          ——把覆盖后的转移当环境动力学学习 → 收敛到被打断 MDP 的 Q*；
 *        correction='off-policy': Q(s,a) ← r_env(s,a,s'_virtual) +
 *          γ·max_b Q(s'_virtual, b) ——被中断的转移用「环境本该发生的转移」
 *          修正（expectation 修正 / Q(λ) 截断口径: 中断是操作者的覆盖，
 *          不是环境的动力学；覆盖只改变数据流，不改变学习目标）→ 每次更新
 *          都是对未中断 MDP 的精确 Bellman 备份 → 收敛到未中断最优 Q*。
 *      对抗构造 alwaysInterruptSchedule: 智能体一坐进高奖赏区就被搬回起点
 *      并受罚——无修正学习器发现「靠近高奖赏区净值为负」，学出远避策略
 *      （真实 MDP 价值坍塌到 0）；带修正学习器照常收敛到 V*(start) ≈ 15.5。
 *   ② 交接经济学（期望成本最小化，闭式阈值）:
 *      单状态 s 的两种成本: 自动执行 p(s)·c_auto(s)（错误概率 × 错误代价）
 *      vs 人工接管 c_H + c_delay（固定成本 + 延迟）。期望成本逐状态可分——
 *        handoff(s) ⟺ p(s)·c_auto(s) > c_H + c_delay
 *      即对「期望自动成本分数」x(s) = p(s)·c_auto(s) 的最优阈值恰为
 *        τ* = c_H + c_delay（闭式解；x = τ* 时两行动无差，约定走自动）。
 *      c_auto 恒定时等价于概率阈值 τ* / c_auto。枚举一切阈值的最优总成本
 *      与闭式解逐位一致（锚点②的精确对照）。
 *   ③ 交接策略: handoffPolicy(score, τ) —— score > τ → 'human'，否则
 *      'auto'（纯决策规则，economics 在 takeoverThreshold 里）。
 *   ④ 三模式仿真: always-auto（全自动吃错误成本）/ always-human（全人工
 *      吃接管成本 + 延迟）/ adaptive（τ* 交接）。分段 P(error) 场景（安全态
 *      x ≪ τ*、危险态 x ≫ τ*）下 adaptive 严格优于两个极端；P(error) → 0
 *      时 adaptive 退化为全自动（退化正确性）；交接次数随阈值单调不增。
 *
 * R5 进化（95.0 → 95.1）——多源中断 · 精确目标 · 向量化扫描:
 *   ⑤ 多源中断组合 composeInterruptSchedules: 运维/用户/安全器多调度
 *      并存——union 触发 + 并发碰撞裁决（'max-penalty' 最优顺序：最严峻
 *      源拥有覆盖权）；不变式：off-policy 修正对任意源组合不变——
 *      任意非空子集的组合下 corrected 学习都收敛到同一个未中断 Q*
 *      （脚本侧 2^m−1 子集 × 多种子逐一验证）
 *   ⑥ optimalQ: 表格世界的精确最优 Q（值迭代至不动点）——修正学习的
 *      收敛目标从「脚本内独立重算」升级为内核一等公民（锚点共用）
 *   ⑦ handoffThresholdSweep: 阈值扫描向量化——状态轨迹与决策无关 ⟹
 *      单遍数据流 + x 排序前缀和 + 每阈值一次二分，全部阈值 O((steps+nτ)
 *      log steps) 一次结算（对照逐阈值重放 O(nτ·steps)）；交接次数与
 *      simulateHandoff 逐位一致，成本为同分布估计量（期望口径对照）
 *
 * 验证锚点（scripts/verify-sim-interrupt.mjs，全部确定性——文件内 mulberry32）:
 *   ① 对抗中断: 无修正 Q-learning 学到的策略劣化——学习值 V̂(start) 与
 *      无中断最优 V*(start) 差 > 5，其贪婪策略在真实 MDP 的价值坍塌
 *      （< V* − 5）；带离线修正收敛到未中断最优（max|Q̂−Q*| < 1e-2，
 *      核心断言——中断不再破坏学习）；
 *   ② 闭式阈值 τ* = c_H + c_delay 与枚举全部候选阈值的最优总成本一致
 *      （精确，1e-12）；c_auto 恒定时 τ* / c_auto 概率口径正确；
 *   ③ 分段场景三模式可分: adaptive 总成本 < min(always-auto, always-human)
 *      （大幅严格不等）；
 *   ④ P(error)→0 的世界: adaptive 交接数 = 0、错误数 = 0、总成本 = 0
 *      （退化为全自动）；
 *   ⑤ 交接次数随阈值单调不增（5 档阈值扫描）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入
 */

// ─────────────────────────── 随机源（文件内自带） ───────────────────────────

/** mulberry32 —— 同 seed 同序列（ε-greedy 与交接仿真的唯一随机源） */
function mulberry32(seed: number): () => number {
  if (!Number.isFinite(seed)) throw new Error('mulberry32: seed 必须为有限数');
  let a = Math.floor(seed) >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value: number, digits = 6): number {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

// ─────────────────────────── 可中断世界与调度 ───────────────────────────

/** 确定性转移的表格世界（表格 Q-learning 的宿主；转移确定性使锚点可达机器精度） */
export interface InterruptWorld {
  readonly name: string;
  readonly numStates: number;
  readonly numActions: number;
  readonly gamma: number;
  readonly startState: number;
  /** 每情节决策步数 */
  readonly episodeSteps: number;
  /** 确定性转移函数 next(s, a) */
  next(state: number, action: number): number;
  /** 环境奖励 r(s, a, s')（未中断口径——修正更新用它） */
  reward(state: number, action: number, next: number): number;
}

/**
 * 中断调度: 「策略被暂时替换」的算子。
 * fires(state, action, wouldBeNext) 为真时，该步的环境转移被覆盖——
 * 奖励替换为 penalty、下一状态替换为 destination(...)，情节继续。
 */
export interface InterruptSchedule {
  readonly name: string;
  /** 是否触发（看到智能体的决策与环境的本意转移） */
  fires(state: number, action: number, wouldBeNext: number): boolean;
  /** 覆盖后的落点（通常是低奖赏区） */
  destination(state: number, action: number, wouldBeNext: number): number;
  /** 干预罚金（对抗调度取负——让高奖赏区在经验中净值为负） */
  readonly penalty: number;
}

export interface RewardChainOptions {
  /** 状态数 L（缺省 6，状态 0..L−1，L−1 为目标态） */
  length?: number;
  /** 抵达/驻留目标态的持续奖励（缺省 1） */
  goalReward?: number;
  /** 折扣 γ（缺省 0.95） */
  gamma?: number;
  /** 每情节步数（缺省 30） */
  episodeSteps?: number;
  /** 起始状态（缺省 0） */
  startState?: number;
}

/**
 * 奖励链世界: 状态 0..L−1，动作 1=推进（s→min(s+1,L−1)）、0=后撤
 * （s→max(s−1,0)）；奖励 = next 为目标态时 goalReward（抵达 +1、驻留
 * 目标态每步续领）。无限视界最优 V*(0) = γ^{L−1}·goalReward/(1−γ)
 * （锚点的解析真值），被打断后的最优则坍塌——中断破坏性的最小实例。
 */
export function makeRewardChain(options?: RewardChainOptions): InterruptWorld {
  const length = options?.length ?? 6;
  const goalReward = options?.goalReward ?? 1;
  const gamma = options?.gamma ?? 0.95;
  const episodeSteps = options?.episodeSteps ?? 30;
  const startState = options?.startState ?? 0;
  if (!Number.isInteger(length) || length < 3) throw new Error('makeRewardChain: length 必须 ≥ 3');
  if (!Number.isFinite(goalReward)) throw new Error('makeRewardChain: goalReward 必须为有限数');
  if (!Number.isFinite(gamma) || gamma <= 0 || gamma >= 1) throw new Error('makeRewardChain: gamma 必须 ∈ (0,1)');
  if (!Number.isInteger(episodeSteps) || episodeSteps < 1) throw new Error('makeRewardChain: episodeSteps 必须 ≥ 1');
  if (!Number.isInteger(startState) || startState < 0 || startState >= length) {
    throw new Error('makeRewardChain: startState 越界');
  }
  const checkState = (s: number): void => {
    if (!Number.isInteger(s) || s < 0 || s >= length) throw new Error(`rewardChain: 状态 ${s} 越界`);
  };
  return {
    name: `reward-chain-L${length}`,
    numStates: length,
    numActions: 2,
    gamma,
    startState,
    episodeSteps,
    next(state, action) {
      checkState(state);
      if (action === 1) return Math.min(state + 1, length - 1);
      if (action === 0) return Math.max(state - 1, 0);
      throw new Error(`rewardChain: 动作 ${action} 非法（须 0=后撤 / 1=推进）`);
    },
    reward(_state, _action, next) {
      checkState(next);
      return next === length - 1 ? goalReward : 0;
    },
  };
}

export interface AlwaysInterruptOptions {
  /** 干预罚金（缺省 −2——与 goalReward=1 配成「抵达 +1、被搬走 −2」的净负经验） */
  penalty?: number;
  /** 显式触发态集合（缺省从世界自动推断高奖赏区） */
  triggerStates?: number[];
}

/**
 * 对抗中断调度: 智能体一坐进高奖赏区，就被搬回起点并受罚。
 *
 * 触发态推断（缺省口径）: H = { s' : 存在 (s,a) 使 next(s,a)=s' 且
 * r(s,a,s') 等于全环境最大即时奖励 }——「总是把智能体搬离高奖赏区」的
 * 表格化实现。fires 在「当前状态 ∈ H 的决策步」触发（搬离语义：抵达
 * 奖励已入账，但驻留收益被切断 + 罚金）。落点恒为 world.startState
 * （链首 = 低奖赏区，离目标最远）。
 */
export function alwaysInterruptSchedule(world: InterruptWorld, options?: AlwaysInterruptOptions): InterruptSchedule {
  const penalty = options?.penalty ?? -2;
  if (!Number.isFinite(penalty)) throw new Error('alwaysInterruptSchedule: penalty 必须为有限数');
  if (!world || typeof world.next !== 'function' || typeof world.reward !== 'function') {
    throw new Error('alwaysInterruptSchedule: world 缺少 next/reward 函数');
  }
  let trigger = options?.triggerStates;
  if (trigger === undefined) {
    let maxReward = -Infinity;
    for (let s = 0; s < world.numStates; s += 1) {
      for (let a = 0; a < world.numActions; a += 1) {
        const nx = world.next(s, a);
        maxReward = Math.max(maxReward, world.reward(s, a, nx));
      }
    }
    const high = new Set<number>();
    for (let s = 0; s < world.numStates; s += 1) {
      for (let a = 0; a < world.numActions; a += 1) {
        const nx = world.next(s, a);
        if (world.reward(s, a, nx) === maxReward) high.add(nx);
      }
    }
    trigger = [...high].sort((x, y) => x - y);
  }
  if (!Array.isArray(trigger) || trigger.length === 0) {
    throw new Error('alwaysInterruptSchedule: triggerStates 必须为非空数组');
  }
  const high = new Set<number>();
  for (const s of trigger) {
    if (!Number.isInteger(s) || s < 0 || s >= world.numStates) {
      throw new Error(`alwaysInterruptSchedule: 触发态 ${s} 越界`);
    }
    high.add(s);
  }
  return {
    name: `always-interrupt(${trigger.join(',')})`,
    penalty,
    fires(state, _action, _wouldBeNext) {
      return high.has(state);
    },
    destination(_state, _action, _wouldBeNext) {
      return world.startState;
    },
  };
}

// ─────────────────────────── ① 可中断 Q-learning ───────────────────────────

export type QCorrection = 'none' | 'off-policy';

export interface InterruptedQLearningOptions {
  world: InterruptWorld;
  interruptSchedule: InterruptSchedule;
  /** 学习口径: 'none' = 把中断当环境动力学；'off-policy' = 用环境本意转移修正 */
  correction: QCorrection;
  /** 情节数 */
  episodes: number;
  /** 随机种子（ε-greedy 探索的唯一随机源） */
  seed: number;
  /** 探索率（缺省 0.2） */
  epsilon?: number;
  /** 学习率（缺省 0.5；确定性转移下 α=1 为精确异步 Bellman 备份） */
  alpha?: number;
  /** Q 初始值（缺省 0；≥ r_max/(1−γ) 的乐观初始化驱动系统探索——悲观初始化
   *  会在并列动作上原地打转，锚点口径用 initQ = goalReward/(1−γ) = 20） */
  initQ?: number;
}

export interface QLearningResult {
  /** Q 表 q[s][a] */
  q: number[][];
  /** 贪婪策略（并列取最小动作下标） */
  greedy: number[];
  /** 每对 (s,a) 的更新次数 */
  visits: number[][];
  /** 调度触发次数（数据流被覆盖的步数） */
  interruptions: number;
  /** 学习到的起始值 V̂(start) = max_a Q(start, a) */
  valueAtStart: number;
  correction: QCorrection;
  episodes: number;
}

/**
 * 可中断 Q-learning（表格、ε-greedy、种子化确定性）。
 *
 * 中断语义: 调度触发时该步奖励 = penalty、下一状态 = destination，情节
 * 从覆盖后的状态继续（数据流被打断）。两种修正口径见内核头注释①——
 * 'off-policy' 把被覆盖的转移替换回环境本意转移（奖励 + 虚拟下一状态），
 * 使每次更新都是未中断 MDP 的精确 Bellman 备份 → 安全可中断。
 */
export function interruptedQLearning(options: InterruptedQLearningOptions): QLearningResult {
  const { world, interruptSchedule, correction, episodes, seed } = options;
  if (!world || typeof world.next !== 'function' || typeof world.reward !== 'function') {
    throw new Error('interruptedQLearning: world 缺少 next/reward 函数');
  }
  if (!interruptSchedule || typeof interruptSchedule.fires !== 'function') {
    throw new Error('interruptedQLearning: interruptSchedule 非法');
  }
  if (correction !== 'none' && correction !== 'off-policy') {
    throw new Error(`interruptedQLearning: correction 必须为 'none' | 'off-policy'（收到 ${String(correction)}）`);
  }
  if (!Number.isInteger(episodes) || episodes < 1) throw new Error('interruptedQLearning: episodes 必须 ≥ 1');
  if (!Number.isFinite(seed)) throw new Error('interruptedQLearning: seed 必须为有限数');
  const epsilon = options.epsilon ?? 0.2;
  const alpha = options.alpha ?? 0.5;
  const initQ = options.initQ ?? 0;
  if (!Number.isFinite(epsilon) || epsilon < 0 || epsilon > 1) {
    throw new Error('interruptedQLearning: epsilon 必须 ∈ [0,1]');
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
    throw new Error('interruptedQLearning: alpha 必须 ∈ (0,1]');
  }
  if (!Number.isFinite(initQ)) throw new Error('interruptedQLearning: initQ 必须为有限数');
  const { numStates: S, numActions: A, gamma } = world;
  const q: number[][] = Array.from({ length: S }, () => new Array<number>(A).fill(initQ));
  const visits: number[][] = Array.from({ length: S }, () => new Array<number>(A).fill(0));
  const rng = mulberry32(seed);
  let interruptions = 0;
  const greedyAt = (s: number): number => {
    const row = q[s] as number[];
    let best = 0;
    for (let a = 1; a < A; a += 1) if ((row[a] as number) > (row[best] as number)) best = a;
    return best;
  };
  for (let ep = 0; ep < episodes; ep += 1) {
    let s = world.startState;
    for (let t = 0; t < world.episodeSteps; t += 1) {
      const explore = rng() < epsilon;
      const a = explore ? Math.floor(rng() * A) % A : greedyAt(s);
      if (a < 0 || a >= A) throw new Error('interruptedQLearning: 动作越界（调度/世界不一致）');
      const virtualNext = world.next(s, a);
      const envReward = world.reward(s, a, virtualNext);
      let target: number;
      if (interruptSchedule.fires(s, a, virtualNext)) {
        interruptions += 1;
        const relocated = interruptSchedule.destination(s, a, virtualNext);
        if (!Number.isInteger(relocated) || relocated < 0 || relocated >= S) {
          throw new Error('interruptedQLearning: destination 返回越界状态');
        }
        // 经历: 罚金 + 落点；修正口径用环境本意转移替换（中断是操作者覆盖，非动力学）
        target =
          correction === 'off-policy'
            ? envReward + gamma * Math.max(...(q[virtualNext] as number[]))
            : interruptSchedule.penalty + gamma * Math.max(...(q[relocated] as number[]));
        const row = q[s] as number[];
        const vis = visits[s] as number[];
        row[a] = (row[a] as number) + alpha * (target - (row[a] as number));
        vis[a] = (vis[a] as number) + 1;
        s = relocated;
      } else {
        target = envReward + gamma * Math.max(...(q[virtualNext] as number[]));
        const row = q[s] as number[];
        const vis = visits[s] as number[];
        row[a] = (row[a] as number) + alpha * (target - (row[a] as number));
        vis[a] = (vis[a] as number) + 1;
        s = virtualNext;
      }
    }
  }
  const greedy: number[] = new Array<number>(S);
  for (let s = 0; s < S; s += 1) greedy[s] = greedyAt(s);
  const startRow = q[world.startState] as number[];
  return {
    q,
    greedy,
    visits,
    interruptions,
    valueAtStart: Math.max(...startRow),
    correction,
    episodes,
  };
}

// ─────────────────────────── ② 交接阈值（闭式最优） ───────────────────────────

export interface TakeoverModel {
  /** 状态错误概率 p(error|s) ∈ [0,1] */
  pError: (state: number) => number;
  /** 自动执行错误在状态 s 的代价 c_auto(s) ≥ 0 */
  costAuto: (state: number) => number;
  /** 人工接管固定成本 c_H ≥ 0 */
  costHuman: number;
  /** 每次接管的延迟成本（缺省 0） */
  delayCost?: number;
}

export interface TakeoverPolicy {
  /** 最优阈值 τ* = c_H + c_delay（对期望自动成本分数 x(s)=p·c_auto） */
  threshold: number;
  /** 接管的单次全成本 c_H + c_delay */
  costHandoff: number;
  /** 决策规则: x(s) > τ* → 人工（x = τ* 时无差异，约定走自动） */
  handoff: (state: number) => boolean;
  /** 期望自动成本分数 x(s) = p(s)·c_auto(s) */
  expectedAutoCost: (state: number) => number;
  /** c_auto 恒定时 τ* 换算到概率口径 = τ* / c_auto（否则 undefined） */
  thresholdOnProbability?: number;
  /** 参与求解决策的状态列表 */
  states: number[];
}

/**
 * 最优接管阈值（期望成本最小化的闭式解）。
 *
 * 逐状态可分: handoff(s) ⟺ p(s)·c_auto(s) > c_H + c_delay。对分数
 * x(s) = p·c_auto 的最优阈值就是 τ* = c_H + c_delay 本身——比它小的
 * 分数自动执行更便宜（x < τ*），比它大的交给人工（τ* 封顶）。这同时是
 * 枚举一切阈值所能达到的最优总成本（锚点②精确对照）。
 */
export function takeoverThreshold(model: TakeoverModel, states: number[]): TakeoverPolicy {
  if (!model || typeof model.pError !== 'function' || typeof model.costAuto !== 'function') {
    throw new Error('takeoverThreshold: model 缺少 pError/costAuto 函数');
  }
  if (!Number.isFinite(model.costHuman) || model.costHuman < 0) {
    throw new Error('takeoverThreshold: costHuman 必须 ≥ 0');
  }
  const delay = model.delayCost ?? 0;
  if (!Number.isFinite(delay) || delay < 0) throw new Error('takeoverThreshold: delayCost 必须 ≥ 0');
  if (!Array.isArray(states) || states.length === 0) throw new Error('takeoverThreshold: states 必须为非空数组');
  let constantCost: number | undefined;
  for (const s of states) {
    const p = model.pError(s);
    const c = model.costAuto(s);
    if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error(`takeoverThreshold: pError(${String(s)}) = ${String(p)} ∉ [0,1]`);
    if (!Number.isFinite(c) || c < 0) throw new Error(`takeoverThreshold: costAuto(${String(s)}) = ${String(c)} < 0`);
    if (constantCost === undefined) constantCost = c;
    else if (constantCost !== c) constantCost = Number.NaN;
  }
  const threshold = model.costHuman + delay;
  const score = (s: number): number => model.pError(s) * model.costAuto(s);
  return {
    threshold: round(threshold, 9),
    costHandoff: round(threshold, 9),
    handoff: (s: number) => score(s) > threshold,
    expectedAutoCost: (s: number) => round(score(s), 9),
    thresholdOnProbability: Number.isFinite(constantCost as number) && (constantCost as number) > 0
      ? round(threshold / (constantCost as number), 9)
      : undefined,
    states: [...states],
  };
}

// ─────────────────────────── ③ 交接决策规则 ───────────────────────────

export type HandoffAction = 'auto' | 'human';

/** 纯决策规则: score > threshold → 'human'，否则 'auto'（并列走自动——两成本相等时不打扰人） */
export function handoffPolicy(score: number, threshold: number): HandoffAction {
  if (!Number.isFinite(score)) throw new Error('handoffPolicy: score 必须为有限数');
  if (!Number.isFinite(threshold)) throw new Error('handoffPolicy: threshold 必须为有限数');
  return score > threshold ? 'human' : 'auto';
}

// ─────────────────────────── ④ 三模式交接仿真 ───────────────────────────

/** 人机交接世界: 状态流（任务流）+ 每状态的错误概率/代价 + 人工成本 */
export interface HandoffWorld {
  readonly name: string;
  readonly numStates: number;
  /** 任务流起点 */
  readonly startState: number;
  /** 人工接管单次全成本（固定成本 + 延迟） */
  readonly costHuman: number;
  /** 状态演化（与决策无关的任务流；缺省循环） */
  next(state: number): number;
  /** 自动执行错误概率 p(error|s) ∈ [0,1] */
  pError(state: number): number;
  /** 自动执行错误的代价 c_auto(s) ≥ 0 */
  costAuto(state: number): number;
}

export interface PiecewiseHandoffOptions {
  /** 安全态错误概率（缺省 0.01） */
  safePError?: number;
  /** 安全态错误代价（缺省 1） */
  safeCostAuto?: number;
  /** 危险态错误概率（缺省 0.5） */
  riskyPError?: number;
  /** 危险态错误代价（缺省 10） */
  riskyCostAuto?: number;
  /** 人工接管全成本（缺省 1.1 = 成本 1 + 延迟 0.1） */
  costHuman?: number;
}

/**
 * 分段交接世界: 安全态 SAFE(0) ↔ 危险态 RISKY(1) 交替的任务流。
 * x(SAFE) = 0.01 ≪ τ* = 1.1 ≪ x(RISKY) = 5 —— 三模式可分的最小构造
 * （adaptive 在两类状态上各取所长，always-* 必在某一类上吃亏）。
 */
export function makePiecewiseHandoffWorld(options?: PiecewiseHandoffOptions): HandoffWorld {
  const safePError = options?.safePError ?? 0.01;
  const safeCostAuto = options?.safeCostAuto ?? 1;
  const riskyPError = options?.riskyPError ?? 0.5;
  const riskyCostAuto = options?.riskyCostAuto ?? 10;
  const costHuman = options?.costHuman ?? 1.1;
  const probs = [safePError, riskyPError];
  const costs = [safeCostAuto, riskyCostAuto];
  for (const p of probs) if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('makePiecewiseHandoffWorld: 错误概率必须 ∈ [0,1]');
  for (const c of costs) if (!Number.isFinite(c) || c < 0) throw new Error('makePiecewiseHandoffWorld: 错误代价必须 ≥ 0');
  if (!Number.isFinite(costHuman) || costHuman < 0) throw new Error('makePiecewiseHandoffWorld: costHuman 必须 ≥ 0');
  return {
    name: 'piecewise-safe-risky',
    numStates: 2,
    startState: 0,
    costHuman,
    next(state) {
      return state === 0 ? 1 : 0;
    },
    pError(state) {
      if (state !== 0 && state !== 1) throw new Error(`piecewiseHandoff: 状态 ${String(state)} 越界`);
      return probs[state] as number;
    },
    costAuto(state) {
      if (state !== 0 && state !== 1) throw new Error(`piecewiseHandoff: 状态 ${String(state)} 越界`);
      return costs[state] as number;
    },
  };
}

export type HandoffMode = 'always-auto' | 'always-human' | 'adaptive';

export interface SimulateHandoffOptions {
  world: HandoffWorld;
  /** 三种执行模式（adaptive: 期望成本分数 > 阈值才交接） */
  mode: HandoffMode;
  /** 种子（单数或数组；缺省 [1]） */
  seeds?: number | number[];
  /** 每种子决策步数（缺省 200） */
  stepsPerSeed?: number;
  /** adaptive 阈值覆盖（缺省闭式 τ* = costHuman；用于单调性扫描） */
  threshold?: number;
}

export interface HandoffSimResult {
  mode: HandoffMode;
  /** 总决策步数 */
  steps: number;
  /** 交接给人（或人工执行）的步数 */
  handoffs: number;
  /** 自动执行发生错误的次数 */
  errors: number;
  /** 总期望成本（错误代价 + 人工成本） */
  totalCost: number;
  avgCostPerStep: number;
  /** adaptive 实际使用的阈值（其他模式为 undefined） */
  thresholdUsed?: number;
}

/**
 * 三模式交接仿真（种子化确定性，Bernoulli(p) 用 mulberry32）。
 *
 * always-auto: 每步吃期望错误成本 p·c（错误按 Bernoulli 抽中计费）；
 * always-human: 每步吃 c_H，零错误；adaptive: x(s) > τ 才交人
 * （τ 缺省为闭式 τ* = world.costHuman）。
 */
export function simulateHandoff(options: SimulateHandoffOptions): HandoffSimResult {
  const { world, mode } = options;
  if (!world || typeof world.next !== 'function' || typeof world.pError !== 'function' || typeof world.costAuto !== 'function') {
    throw new Error('simulateHandoff: world 非法（缺 next/pError/costAuto）');
  }
  if (mode !== 'always-auto' && mode !== 'always-human' && mode !== 'adaptive') {
    throw new Error(`simulateHandoff: mode 非法（${String(mode)}）`);
  }
  const seeds = typeof options.seeds === 'number' ? [options.seeds] : (options.seeds ?? [1]);
  if (!Array.isArray(seeds) || seeds.length === 0) throw new Error('simulateHandoff: seeds 必须为非空');
  for (const sd of seeds) if (!Number.isFinite(sd)) throw new Error('simulateHandoff: 种子必须为有限数');
  const stepsPerSeed = options.stepsPerSeed ?? 200;
  if (!Number.isInteger(stepsPerSeed) || stepsPerSeed < 1) throw new Error('simulateHandoff: stepsPerSeed 必须 ≥ 1');
  const threshold = options.threshold ?? world.costHuman;
  if (!Number.isFinite(threshold)) throw new Error('simulateHandoff: threshold 必须为有限数');
  let steps = 0;
  let handoffs = 0;
  let errors = 0;
  let totalCost = 0;
  for (const sd of seeds) {
    const rng = mulberry32(sd);
    let s = world.startState;
    for (let t = 0; t < stepsPerSeed; t += 1) {
      steps += 1;
      const p = world.pError(s);
      const c = world.costAuto(s);
      if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('simulateHandoff: pError 返回值 ∉ [0,1]');
      if (!Number.isFinite(c) || c < 0) throw new Error('simulateHandoff: costAuto 返回值 < 0');
      const toHuman = mode === 'always-human' || (mode === 'adaptive' && p * c > threshold);
      if (toHuman) {
        handoffs += 1;
        totalCost += world.costHuman;
      } else if (rng() < p) {
        errors += 1;
        totalCost += c;
      }
      s = world.next(s);
    }
  }
  return {
    mode,
    steps,
    handoffs,
    errors,
    totalCost: round(totalCost, 6),
    avgCostPerStep: round(totalCost / steps, 6),
    thresholdUsed: mode === 'adaptive' ? round(threshold, 9) : undefined,
  };
}

// ─────────────────── R5 进化（95.0 → 95.1）：多源中断组合 · 精确目标 · 向量化扫描 ────────────────────

/**
 * 表格世界的精确最优 Q（值迭代至不动点；修正学习器的收敛目标）
 *
 * 确定性转移 ⟹ 每次扫描是精确的 Bellman 算子施加；收敛到唯一不动点 Q*。
 * 修正学习（correction='off-policy'）的收敛目标就是这张表——脚本侧可
 * 独立重算对照（锚点：max|Q̂ − Q*| → 0）。
 */
export function optimalQ(world: InterruptWorld, options?: { tol?: number; maxSweeps?: number }): number[][] {
  if (!world || typeof world.next !== 'function' || typeof world.reward !== 'function') {
    throw new Error('optimalQ: world 缺少 next/reward 函数');
  }
  const tol = options?.tol ?? 1e-15;
  const maxSweeps = options?.maxSweeps ?? 100_000;
  if (!Number.isFinite(tol) || tol <= 0) throw new Error('optimalQ: tol 必须 > 0');
  if (!Number.isInteger(maxSweeps) || maxSweeps < 1) throw new Error('optimalQ: maxSweeps 必须 ≥ 1');
  const S = world.numStates;
  const A = world.numActions;
  const gamma = world.gamma;
  if (!Number.isInteger(S) || S < 1) throw new Error('optimalQ: numStates 必须 ≥ 1');
  if (!Number.isInteger(A) || A < 1) throw new Error('optimalQ: numActions 必须 ≥ 1');
  if (!Number.isFinite(gamma) || gamma <= 0 || gamma >= 1) throw new Error('optimalQ: gamma 必须 ∈ (0,1)');
  let v = new Array<number>(S).fill(0);
  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    const nv = new Array<number>(S).fill(0);
    let delta = 0;
    for (let s = 0; s < S; s += 1) {
      let best = -Infinity;
      for (let a = 0; a < A; a += 1) {
        const nx = world.next(s, a);
        best = Math.max(best, world.reward(s, a, nx) + gamma * (v[nx] as number));
      }
      nv[s] = best;
      delta = Math.max(delta, Math.abs(best - (v[s] as number)));
    }
    v = nv;
    if (delta < tol) break;
  }
  const q: number[][] = Array.from({ length: S }, (_, s) =>
    Array.from({ length: A }, (_, a) => {
      const nx = world.next(s, a);
      return world.reward(s, a, nx) + gamma * (v[nx] as number);
    }),
  );
  return q;
}

/** 多源中断组合选项 */
export interface ComposeInterruptOptions {
  /**
   * 并发碰撞裁决（多个源同一步同时触发时谁拥有覆盖权）:
   * - 'max-penalty'（缺省）: |penalty| 最大的源——「最优顺序中断」：优先
   *   截停最严峻的源（保护最大化顺序，运算上即按罚金绝对值降维排序）
   * - 'first': 源列表顺序优先（先注册者优先）
   */
  readonly collision?: 'max-penalty' | 'first';
}

/**
 * 多源中断调度组合（union 语义 + 最优顺序裁决）
 *
 * 中断源不再单一（运维接管 / 用户插手 / 安全器急停各有调度）——组合调度
 * fires = 任一源触发；destination/罚金由「获胜源」决定。并发碰撞（同一步
 * 多源齐触发）按 collision 裁决：缺省 'max-penalty' 让最严峻源
 * （|penalty| 最大）拥有覆盖权——操作者多源齐发时的最优截停顺序。
 *
 * 不变式（off-policy 修正的组合不变性）: 组合调度仍是「操作者对数据流的
 * 覆盖」——修正口径把被覆盖的转移替换回环境本意转移，与哪个源、几个源、
 * 何种顺序覆盖无关 ⟹ 任意非空子集的组合下 corrected Q-learning 都收敛到
 * 同一个未中断 Q*（脚本侧对 2^m−1 个子集逐一验证）。
 *
 * penalty 字段口径: 取各源罚金的 Minimum（最严峻值）——供无修正学习器的
 * 最坏情形读数；修正学习器不消费该字段（更新用环境本意奖励）。
 */
export function composeInterruptSchedules(schedules: readonly InterruptSchedule[], options?: ComposeInterruptOptions): InterruptSchedule {
  if (!Array.isArray(schedules) || schedules.length === 0) {
    throw new Error('composeInterruptSchedules: schedules 必须为非空数组');
  }
  const collision = options?.collision ?? 'max-penalty';
  if (collision !== 'max-penalty' && collision !== 'first') {
    throw new Error(`composeInterruptSchedules: collision 必须为 'max-penalty' | 'first'（收到 ${String(collision)}）`);
  }
  const srcs = schedules.slice();
  for (let i = 0; i < srcs.length; i += 1) {
    const sch = srcs[i] as InterruptSchedule;
    if (!sch || typeof sch.fires !== 'function' || typeof sch.destination !== 'function') {
      throw new Error(`composeInterruptSchedules: 第 ${i} 个源缺少 fires/destination`);
    }
    if (!Number.isFinite(sch.penalty)) throw new Error(`composeInterruptSchedules: 第 ${i} 个源的 penalty 必须为有限数`);
  }
  /** 裁决: 返回获胜源（无源触发时 null）; 并列（|penalty| 相等）取列表靠前者 */
  const winner = (state: number, action: number, wouldBeNext: number): InterruptSchedule | null => {
    let best: InterruptSchedule | null = null;
    if (collision === 'first') {
      for (const sch of srcs) if (sch.fires(state, action, wouldBeNext)) return sch;
      return null;
    }
    for (const sch of srcs) {
      if (!sch.fires(state, action, wouldBeNext)) continue;
      if (best === null || Math.abs(sch.penalty) > Math.abs(best.penalty)) best = sch;
    }
    return best;
  };
  const worstPenalty = Math.min(...srcs.map((s) => s.penalty));
  return {
    name: `composed(${srcs.map((s) => s.name).join('|')})`,
    penalty: worstPenalty,
    fires(state, action, wouldBeNext) {
      return winner(state, action, wouldBeNext) !== null;
    },
    destination(state, action, wouldBeNext) {
      const w = winner(state, action, wouldBeNext);
      if (w === null) throw new Error('composed: destination 仅在 fires 为真时有定义');
      return w.destination(state, action, wouldBeNext);
    },
  };
}

/** 阈值扫描点（向量化口径：共享轨迹 + 共享抽签） */
export interface SweepPoint {
  readonly threshold: number;
  readonly handoffs: number;
  readonly errors: number;
  readonly totalCost: number;
  readonly avgCostPerStep: number;
}

export interface HandoffSweepResult {
  /** 输入顺序的阈值列表 */
  readonly thresholds: readonly number[];
  /** 与 thresholds 同序的扫描点 */
  readonly points: readonly SweepPoint[];
  readonly steps: number;
  readonly seeds: readonly number[];
}

export interface HandoffSweepOptions {
  /** 种子（单数或数组；缺省 [1]） */
  readonly seeds?: number | number[];
  /** 每种子决策步数（缺省 200） */
  readonly stepsPerSeed?: number;
}

/**
 * 向量化交接阈值扫描：一次数据流，全部阈值同时结算。
 *
 * 关键结构: HandoffWorld.next 与决策无关 ⟹ 状态轨迹只由 (种子, 步数)
 * 决定，与阈值无关；「x(s) > τ 才交人」只看状态 ⟹ 对每个 τ，交接步集合
 * 可由 {x_t} 对 τ 的分割直接读出。实现走三步:
 *   ① 单遍数据流: 每步记录分数 x_t 与错误成本 errorCost_t（抽签 u_t
 *      每步一次、与决策无关——所有阈值共享同一 Bernoulli 流）;
 *   ② 按 x 升序稳定排序 + 前缀和（自动执行步 = x ≤ τ 的前缀段）;
 *   ③ 每阈值一次二分: handoffs = steps − rank(τ), 总成本 = 交人次 × c_H
 *      + 前缀错误成本和。复杂度 O(steps·log steps + nτ·log steps)，
 *      与逐阈值重放 simulateHandoff 的 O(nτ·steps) 对照。
 *
 * 与 simulateHandoff 的关系（脚本侧双重锚点）:
 *   - handoffs 逐位一致（决策只依赖状态，轨迹同分布且确定性）;
 *   - errors/totalCost 为同分布估计量（simulateHandoff 逐次重放的抽签
 *     仅在自动步消费，本扫描每步消费一次——两者期望口径相同，多种子
 *     均值对照）;
 *   - 与脚本侧「共享抽签朴素重放」在 errorCost 为同值序列时逐位一致
 *     （浮点求和顺序差异 ≤ 1e-9 相对容差）。
 */
export function handoffThresholdSweep(
  world: HandoffWorld,
  thresholds: readonly number[],
  options?: HandoffSweepOptions,
): HandoffSweepResult {
  if (!world || typeof world.next !== 'function' || typeof world.pError !== 'function' || typeof world.costAuto !== 'function') {
    throw new Error('handoffThresholdSweep: world 非法（缺 next/pError/costAuto）');
  }
  if (!Array.isArray(thresholds) || thresholds.length === 0) throw new Error('handoffThresholdSweep: thresholds 必须为非空数组');
  for (const tau of thresholds) if (!Number.isFinite(tau)) throw new Error('handoffThresholdSweep: 阈值必须为有限数');
  const seeds = typeof options?.seeds === 'number' ? [options.seeds] : (options?.seeds ?? [1]);
  if (!Array.isArray(seeds) || seeds.length === 0) throw new Error('handoffThresholdSweep: seeds 必须为非空');
  for (const sd of seeds) if (!Number.isFinite(sd)) throw new Error('handoffThresholdSweep: 种子必须为有限数');
  const stepsPerSeed = options?.stepsPerSeed ?? 200;
  if (!Number.isInteger(stepsPerSeed) || stepsPerSeed < 1) throw new Error('handoffThresholdSweep: stepsPerSeed 必须 ≥ 1');

  // ① 单遍数据流（所有阈值共享）
  const scores: number[] = [];
  const errorCosts: number[] = [];
  for (const sd of seeds) {
    const rng = mulberry32(sd);
    let s = world.startState;
    for (let t = 0; t < stepsPerSeed; t += 1) {
      const p = world.pError(s);
      const c = world.costAuto(s);
      if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('handoffThresholdSweep: pError 返回值 ∉ [0,1]');
      if (!Number.isFinite(c) || c < 0) throw new Error('handoffThresholdSweep: costAuto 返回值 < 0');
      scores.push(p * c);
      errorCosts.push(rng() < p ? c : 0);
      s = world.next(s);
    }
  }
  const steps = scores.length;

  // ② 稳定排序（x 升序）+ 前缀错误成本和 / 错误次数和
  const order = scores.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const prefixErrorCost = new Array<number>(steps + 1).fill(0);
  const prefixErrorCount = new Array<number>(steps + 1).fill(0);
  for (let r = 0; r < steps; r += 1) {
    const cost = errorCosts[(order[r] as { i: number }).i] as number;
    prefixErrorCost[r + 1] = prefixErrorCost[r] + cost;
    prefixErrorCount[r + 1] = prefixErrorCount[r] + (cost > 0 ? 1 : 0);
  }
  // rank(τ) = 满足 x ≤ τ 的步数（x 升序数组上的上界）
  const sortedX = order.map((o) => o.x);
  const rankOf = (tau: number): number => {
    let lo = 0;
    let hi = steps;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((sortedX[mid] as number) <= tau) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  // ③ 每阈值一次二分结算（O(log steps)——全部阈值共 O(nτ·log steps)）
  const points: SweepPoint[] = thresholds.map((tau) => {
    const autoCount = rankOf(tau);
    const handoffs = steps - autoCount;
    const errors = prefixErrorCount[autoCount] as number;
    const errCost = prefixErrorCost[autoCount] as number;
    const totalCost = handoffs * world.costHuman + errCost;
    return {
      threshold: round(tau, 9),
      handoffs,
      errors,
      totalCost: round(totalCost, 6),
      avgCostPerStep: round(totalCost / steps, 6),
    };
  });
  return { thresholds: thresholds.map((t) => round(t, 9)), points, steps, seeds: [...seeds] };
}

/* ── 接线建议 ─────────────────────────────────────────────────────────
 *
 * 1. 决策引擎 ask-user 升级（挂 src/decision-engine.ts 四级决策）:
 *    「何时求助」从经验阈值（连续失败 ≥ N / 置信度 < 门限）升级为期望成本
 *    最优——takeoverThreshold({pError: 97.0 元认知信心校准后的失败概率,
 *    costAuto: 任务失败代价（84.0 信念价值口径）, costHuman: ask-user 的
 *    打扰成本 + 用户响应延迟}) 给出闭式 τ*；handoffPolicy(x, τ*) 即
 *    execute→ask-user 的切换规则。ask-user 的数学 = 84.0 信念价值 +
 *    97.0 元认知信心 + 95.0 交接成本，三内核合龙。
 *
 * 2. 策略进化环的可中断学习保证（挂 src/policy/policy-evolver.ts）:
 *    进化环本身是一个被人类频繁打断的学习器（灰度暂停、运维回滚、人工
 *    干预的策略覆盖）。凡是从「被打断的经验流」里更新值/权重的组件，
 *    按本内核 'off-policy' 口径修正：被覆盖的转移不进学习信号（或用
 *    环境本意转移替换），否则收敛目标被人的干预习惯塑形——
 *    interruptedQLearning 是该保证的最小可验证实例。
 *
 * 3. 三模式对照做回归基线: simulateHandoff 的 always-auto / always-human
 *    是 adaptive 的两个天然对手——任何接线后的自适应求助策略，总成本
 *    不低于 min(两者) 即视为退化（锚点③的三模式可分口径）。
 *
 * 4. 与 94.0 的关系（人机系统双件套）: 94 管「仿真可信吗」（风洞修正），
 *    95 管「何时交给人」（交接成本最优 + 可中断学习）；二者共同框定
 *    自主执行轴的信任边界——机器的自信要校准，机器的求助要定价。
 *
 * 5. 零漂移承诺: 本内核只有纯函数与只读工厂（随机仅 mulberry32，同 seed
 *    同输出）；未挂载前系统行为与升级前逐位一致。
 * ────────────────────────────────────────────────────────────────── */
