/**
 * 29.0 蒙特卡洛树搜索内核 —— UCT + 折扣回报 + 任意时刻可读
 *
 * 动机: 7.0 beam search 在轨迹空间按「模型评分」剪枝——宽度是资源，深度
 * 受 beam 限制；评估函数（累计 G）是确定性的近视打分。MCTS 把搜索本身
 * 变成**序贯决策问题**：
 *
 *   选择:  UCB1 = Q(s,a)/N(s,a) + c·√(ln N(s) / N(s,a))
 *     ——利用项（均值）与探索项（访问稀缺度）的置信上界平衡，
 *     Hoeffding 界保证收敛到最优动作（Kocsis & Szepesvári 2006）。
 *   扩展: 每次迭代只展开一个未试动作（惰性扩展，树按需生长）；
 *     渐进加宽（可选）⌈k·(N+1)^κ⌉ 限制大动作集的子节点数。
 *   模拟: 随机 rollout 到深度上限，收集折扣回报 Σ γ^t·r_t。
 *   回传: **节点本地回报**——每条边记录进入奖励，回传时按
 *     (R − 前缀折扣奖励)/γ^depth 折算，每个节点的 Q 都是
 *     「从本节点出发的折扣回报」，无深度偏置。
 *
 *   任意时刻性（与 8.0 元推理同族）: 迭代预算 / 时间预算任一耗尽即读出，
 *     访问分布即时可审计（visits 越多 = 证据越多，与 21.0 学习溢价同构）。
 *
 * 确定性: 种子化 mulberry32——同一 (seed, domain) 组合逐位复现；
 *   域内随机必须只消费传入的 rng。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致。
 */

/** 确定性 PRNG（mulberry32） */
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

/**
 * 搜索域：动作清单 + 随机步进。
 * 契约：终局状态的 actions() 必须返回空数组（rollout 依赖此停止）。
 */
export interface MctsDomain {
  actions(state: string): string[];
  /**
   * 一步转移（域内随机只消费传入 rng，保证种子可复现）。
   * @returns 后继状态、即时奖励 r（建议 [0,1] 口径）、是否终局
   */
  step(state: string, action: string, rng: () => number): { state: string; reward: number; terminal: boolean };
}

export interface UctConfig {
  /** UCB1 探索常数 c（缺省 √2） */
  explorationC: number;
  /** 每步折扣 γ（缺省 0.95） */
  discount: number;
  /** rollout 深度上限（缺省 12） */
  rolloutDepth: number;
  /** PRNG 种子（缺省 20260920） */
  seed: number;
  /** 渐进加宽系数 k（子节点上限 ⌈k·(N+1)^κ⌉；0 = 关闭；缺省 0） */
  progressiveWidenK: number;
  /** 渐进加宽指数 κ ∈ (0,1]（缺省 0.5） */
  progressiveWidenKappa: number;
}

export const DEFAULT_UCT_CONFIG: UctConfig = {
  explorationC: Math.SQRT2,
  discount: 0.95,
  rolloutDepth: 12,
  seed: 20260920,
  progressiveWidenK: 0,
  progressiveWidenKappa: 0.5,
};

interface MctsNode {
  state: string;
  parent: MctsNode | null;
  /** 进入该节点的动作（根为 null） */
  action: string | null;
  /** 进入该节点那条边的即时奖励（根为 0）——回传前缀记账用 */
  incomingReward: number;
  children: Map<string, MctsNode>;
  /** 尚未展开的动作（惰性扩展队列） */
  untried: string[];
  visits: number;
  /** 节点本地折扣回报之和 */
  valueSum: number;
  terminal: boolean;
  depth: number;
}

export interface MctsChildStat {
  action: string;
  visits: number;
  meanValue: number;
}

export interface MctsResult {
  /** 访问次数最多的根动作（收敛意义下的最优动作） */
  bestAction: string | undefined;
  /** 根价值（根的本地回报均值） */
  rootValue: number;
  /** 完成迭代数 */
  iterations: number;
  /** 树节点总数 */
  treeNodes: number;
  /** 根子节点统计（visits 降序） */
  children: MctsChildStat[];
  /** 主变化线（最访问链的动作序列） */
  principalVariation: string[];
}

/**
 * UCT 搜索器。bind(domain) 后可反复 search()（每次为独立完整运行，
 * 种子重置——同一预算逐位可复现）。
 */
export class UctSearch {
  private config: UctConfig;
  private domain: MctsDomain | undefined;
  private rng: () => number = mulberry32(1);
  private nodeCount = 0;

  constructor(config?: Partial<UctConfig>, domain?: MctsDomain) {
    // 仅合并未定义键（显式 undefined 不得覆盖缺省值——否则 UCB 系数变 NaN）
    this.config = { ...DEFAULT_UCT_CONFIG };
    if (config) {
      for (const key of Object.keys(config) as Array<keyof UctConfig>) {
        const v = config[key];
        if (v !== undefined) this.config[key] = v;
      }
    }
    this.domain = domain;
  }

  /** 绑定/替换搜索域 */
  bind(domain: MctsDomain): this {
    this.domain = domain;
    return this;
  }

  search(root: string, budget: { iterations?: number; timeMs?: number } = {}): MctsResult {
    if (!this.domain) throw new Error('UctSearch: search 前必须 bind(domain)');
    const iterations = Math.max(1, budget.iterations ?? 400);
    const deadline = budget.timeMs !== undefined ? Date.now() + budget.timeMs : Number.POSITIVE_INFINITY;
    this.rng = mulberry32(this.config.seed);
    this.nodeCount = 1;

    const rootNode: MctsNode = {
      state: root,
      parent: null,
      action: null,
      incomingReward: 0,
      children: new Map(),
      untried: [...this.domain.actions(root)],
      visits: 0,
      valueSum: 0,
      terminal: false,
      depth: 0,
    };
    rootNode.terminal = rootNode.untried.length === 0;

    let done = 0;
    for (; done < iterations; done += 1) {
      if ((done & 15) === 0 && Date.now() > deadline) break;
      this.runEpisode(rootNode);
    }

    const children: MctsChildStat[] = [...rootNode.children.values()]
      .map((c) => ({ action: c.action!, visits: c.visits, meanValue: c.visits > 0 ? c.valueSum / c.visits : 0 }))
      .sort((a, b) => b.visits - a.visits || b.meanValue - a.meanValue);
    return {
      bestAction: children[0]?.action,
      rootValue: rootNode.visits > 0 ? rootNode.valueSum / rootNode.visits : 0,
      iterations: done,
      treeNodes: this.nodeCount,
      children,
      principalVariation: this.extractPv(rootNode),
    };
  }

  // ─────────────────────────── 单次迭代四阶段 ───────────────────────────

  private runEpisode(root: MctsNode): void {
    const gamma = this.config.discount;
    const path: MctsNode[] = [root];
    // edgeReward[j]: 本次轨迹经过「进入 path[j+1] 的边」的新采样奖励
    //（随机域每次经过同一条边都要重抽——首次展开的样本不能冻结臂的价值；
    //  确定性域重采样结果不变，行为零漂移）
    const edgeReward: number[] = [];
    // pathReward: 路径上全部边奖励的（根口径）折扣累计——R 的组成部分
    let pathReward = 0;

    // 1. 选择（带重采样）：UCB1 下降到「可扩展（有未试动作且加宽余量）或终局或叶子」
    let node = root;
    while (!node.terminal && node.children.size > 0 && (node.untried.length === 0 || !this.canWiden(node))) {
      const child = this.selectUcb(node);
      const resampled = this.domain!.step(node.state, child.action!, this.rng);
      path.push(child);
      edgeReward.push(resampled.reward);
      pathReward += Math.pow(gamma, Math.max(0, child.depth - 1)) * resampled.reward;
      node = child;
    }

    // 2. 扩展 + 模拟
    let totalReturn: number;
    if (node.terminal) {
      // 终局无未来奖励：R = 路径边的重采样奖励之和（终局重访不冲稀首展开）
      totalReturn = pathReward;
    } else if (node.untried.length > 0) {
      const idx = Math.floor(this.rng() * node.untried.length);
      const action = node.untried.splice(idx, 1)[0]!;
      const transition = this.domain!.step(node.state, action, this.rng);
      const child: MctsNode = {
        state: transition.state,
        parent: node,
        action,
        incomingReward: transition.reward,
        children: new Map(),
        untried: transition.terminal ? [] : [...this.domain!.actions(transition.state)],
        visits: 0,
        valueSum: 0,
        terminal: transition.terminal,
        depth: node.depth + 1,
      };
      this.nodeCount += 1;
      node.children.set(action, child);
      path.push(child);
      edgeReward.push(transition.reward);
      // 轨迹总回报 = 路径边奖励（含新边，各自按父深度折价）+ rollout（子深度起折价）
      totalReturn =
        pathReward +
        Math.pow(gamma, node.depth) * transition.reward +
        (child.terminal ? 0 : Math.pow(gamma, node.depth + 1) * this.rollout(child));
      pathReward += Math.pow(gamma, node.depth) * transition.reward;
    } else {
      // actions() 曾非空但全部展开且无子（后继集合为空的防御分支）
      totalReturn = pathReward + Math.pow(gamma, node.depth) * this.rollout(node);
    }

    // 3. 回传：节点本地口径 (R − prefix_i) / γ^(depth_i−1)——
    //    节点价值 = 「采取通向该节点的行动」的价值（含自身入边奖励），
    //    UCB 在父节点按此排序（bandit 型一步终局域的 Q = 臂奖励）。
    let prefix = 0;
    for (let i = 0; i < path.length; i += 1) {
      const n = path[i]!;
      const denom = Math.pow(gamma, Math.max(0, n.depth - 1));
      const local = (totalReturn - prefix) / denom;
      n.valueSum += local;
      n.visits += 1;
      // 进入下一节点前：本节点的入边奖励计入其 prefix
      if (i >= 1) prefix += Math.pow(gamma, Math.max(0, n.depth - 1)) * edgeReward[i - 1]!;
    }
  }

  /** UCB1 选择（访问数 0 的子节点视为 +∞——必先展开） */
  private selectUcb(node: MctsNode): MctsNode {
    const logN = Math.log(Math.max(1, node.visits));
    let best: MctsNode | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const child of node.children.values()) {
      const score = child.visits === 0
        ? Number.POSITIVE_INFINITY
        : child.valueSum / child.visits + this.config.explorationC * Math.sqrt(logN / child.visits);
      if (score > bestScore) {
        bestScore = score;
        best = child;
      }
    }
    return best!;
  }

  /** 随机 rollout：深度上限内均匀选动作，收集折扣回报（从该节点视角） */
  private rollout(node: MctsNode): number {
    const gamma = this.config.discount;
    let state = node.state;
    let acc = 0;
    for (let d = 0; d < this.config.rolloutDepth; d += 1) {
      const actions = this.domain!.actions(state);
      if (actions.length === 0) break;
      const action = actions[Math.floor(this.rng() * actions.length)]!;
      const t = this.domain!.step(state, action, this.rng);
      acc += Math.pow(gamma, d) * t.reward;
      state = t.state;
      if (t.terminal) break;
    }
    return acc;
  }

  /** 渐进加宽：子节点数上限 ⌈k·(N+1)^κ⌉（k=0 恒真 = 关闭） */
  private canWiden(node: MctsNode): boolean {
    if (this.config.progressiveWidenK <= 0) return true;
    const cap = Math.ceil(this.config.progressiveWidenK * Math.pow(node.visits + 1, this.config.progressiveWidenKappa));
    return node.children.size < cap;
  }

  /** 主变化线：自根沿最高访问数下降 */
  private extractPv(root: MctsNode): string[] {
    const pv: string[] = [];
    let node: MctsNode | undefined = root;
    const guard = new Set<MctsNode>();
    while (node && node.children.size > 0) {
      let best: MctsNode | undefined;
      let bestVisits = -1;
      for (const child of node.children.values()) {
        if (child.visits > bestVisits) {
          bestVisits = child.visits;
          best = child;
        }
      }
      if (!best || best.visits === 0 || guard.has(best)) break;
      guard.add(best);
      pv.push(best.action!);
      node = best;
    }
    return pv;
  }
}
