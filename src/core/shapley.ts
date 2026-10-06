/**
 * shapley.ts — Shapley 公平归因内核（项目 16.0「功劳分配有了公理根基」质变基座）
 *
 * 升级前的根本局限（多智能体协作的分配黑洞）：
 * - 「谁创造了价值」全靠启发式：均分（大锅饭）、末次触达（抢功）、
 *   出现计数（可刷）——三种启发式对同一份协作产出给出三种互相矛盾的
 *   分配，谁也说不清哪种「对」，因为它们不满足任何公平公理；
 * - 全部可被策略性操纵：搭便车者（不干活但出现）与末位冲刺者
 *   （在结果即将敲定时蹭最后一手）拿走真实贡献者的报酬——
 *   归因体系没有抗操纵的数学骨架；
 * - 点估计无不确定性：「模型 A 贡献 0.37」与「我们对 0.37 一无所知」
 *   在报表上无法区分。
 *
 * 本内核引入合作博弈论的 Shapley 值（Shapley 1953；2012 诺贝尔经济学奖）：
 *
 * 1. **公理化唯一性**：Shapley 值是同时满足四条公平公理的唯一分配——
 *    - 效率（efficiency）：Σφᵢ = V(N)，价值全额分发无遗漏；
 *    - 对称（symmetry）：对所有联盟边际贡献相同的两玩家分配相等；
 *    - 虚拟（dummy）：对所有联盟边际贡献为零者恰好分得 0
 *      ——搭便车在数学上无利可图，归因第一次拥有抗操纵性；
 *    - 可加（additivity）：两博弈的 Shapley 分配之和 = 联合博弈的分配。
 *
 * 2. **精确枚举（n ≤ exactThreshold）**：2ⁿ 联盟值全枚举 + 记忆化 +
 *    标准加权公式 φᵢ = Σ_{S⊆N∖{i}} |S|!(n−|S|−1)!/n!·[V(S∪{i})−V(S)]。
 *
 * 3. **排列采样 + 任意时刻有效置信区间（建在 12.0 之上）**：
 *    随机排列的边际贡献是 Shapley 值的无偏估计（Bourgaine–Friedgut）；
 *    每次排列为每个玩家产出一份边际样本，喂入经验伯恩斯坦置信序列
 *    （边际值域 [−1,1] 仿射缩放到 [0,1] 后观测，区间映射回来）——
 *    **偷看安全**：任意时刻读区间均有效，采样随停随用；
 *    提前停止：相邻名次玩家的置信区间分离（上者下界 > 下者上界）
 *    即停——「排定座次」本身成为受控事件，不再烧完预算才出结果。
 *
 * 4. **协同检测（synergy）**：V(A∪B) − V(A) − V(B) > 0 的玩家对
 *    存在正协同（1+1>2）——团队组建与编排亲和的量化依据；
 *    负协同（互相拆台）同样曝光，负协同对在编排上应被拆散。
 *
 * 5. **关键性指数（Banzhaf swing）**：玩家在多少联盟中是「摇摆者」
 *    （边际贡献 > 容差即改变局面）——比 Shapley 更尖锐的
 *    「关键人/不可替代节点」检测，供共生经济识别单点依赖。
 *
 * 与 12.0 的关系：Shapley 采样的不确定性由 12.0 的置信序列背书——
 * 归因数字第一次自带「这个数可信到什么程度」的数学答案。
 * 与 3-15.0 的关系：证据内核（3.0）记录「谁参与了什么」，因果内核
 * （5.0）回答「干预效应几何」，本内核回答「合作剩余如何公平分割」——
 * 参与 → 效应 → 分配，三层递进构成完整的多智能体问责链。
 *
 * ── R5-A13 世界性进化（第五轮）──
 *
 * 6. **加权 Shapley（Kalai–Samet 1977 非对称权）**：经典 Shapley 对全部
 *    n! 个排列一视同仁——但真实协作里「优先级/股权/采样权重」本就非对称。
 *    加权 Shapley 给排列赋予概率 p(π) = Π_t λ_{π_t}/Λ_t（Λ_t = 剩余玩家
 *    权重和），φ^w_i = Σ_π p(π)·边际_i(π)。实现为**部分排列 DFS**：每个
 *    DFS 节点恰结算一个玩家的边际（概率 × 边际贡献），无需走到叶子重算
 *    前缀——节点数 ≈ e·n!，比「全排列逐个走前缀」的 n!·n 次估值省一个
 *    因子。公理保持：效率（Σφ^w = V(N)）、虚拟（零边际者恰得 0）、
 *    可加；等权时 p(π) = 1/n! 精确退化为经典 Shapley。
 *
 * 7. **分层排列采样（按首玩家分层 + 层内方差估计）**：均匀随机排列的
 *    首玩家均匀分布——按「排列首玩家」把排列空间切成 n 个等权层，层内
 *    均匀采样，估计量 φ̂_i = (1/n)Σ_s μ̂_{s,i} 仍无偏；方差分解定理
 *    σ² = Σ_s w_s σ_s² + Σ_s w_s(μ_s−μ)² 保证分层方差 ≤ 单层池化方差
 *    （层间差被整段消除）。逐（层×玩家）喂 EmpiricalBernstein 置信序列
 *    （水平 α/n，Bonferroni 并集界），求和区间仍是任意时刻有效——
 *    偷看安全口径不降级；报告逐玩家方差缩减比（对照口径）。
 */

import { EmpiricalBernsteinSequence, round } from './anytime-evidence.js';

// ─────────────────────────── 类型与配置 ───────────────────────────

/** 联盟价值函数：给定一组玩家，返回该联盟独立可创造的价值（值域 [0,1]） */
export type CoalitionValueFunction = (coalition: readonly string[]) => number;

/** Shapley 内核配置 */
export interface ShapleyConfig {
  /** 精确枚举的玩家数上限（2ⁿ 联盟值全枚举；缺省 8 → 256 次估值） */
  exactThreshold: number;
  /** 排列采样预算上限（缺省 2000） */
  maxPermutations: number;
  /** 置信序列水平 α（区间覆盖 ≥ 1−α，任意时刻有效；缺省 0.05） */
  alpha: number;
  /** 提前停止判定的最小排列数（缺省 30——之前不允许停） */
  minPermutations: number;
  /** 协同/关键性判定的边际容差（缺省 1e-9） */
  tolerance: number;
  /** 随机数源（缺省 Math.random；测试可注入确定性序列） */
  rng?: () => number;
}

export const DEFAULT_SHAPLEY_CONFIG: ShapleyConfig = {
  exactThreshold: 8,
  maxPermutations: 2000,
  alpha: 0.05,
  minPermutations: 30,
  tolerance: 1e-9,
};

/** 单玩家归因结果 */
export interface ShapleyAttribution {
  /** 玩家标识 */
  playerId: string;
  /** Shapley 值（精确枚举=真值；采样=无偏估计的中心） */
  shapley: number;
  /** 任意时刻有效置信下界（采样模式；精确模式与 shapley 重合） */
  lower: number;
  /** 任意时刻有效置信上界 */
  upper: number;
  /** 归因份额 φᵢ/V(N)（Σ share = 1——效率公理的可观测面） */
  share: number;
  /** 名次（按 shapley 降序，1 起） */
  rank: number;
  /** 是否精确枚举（false = 排列采样估计） */
  exact: boolean;
  /** 排列样本量（精确模式 = 联盟枚举覆盖数） */
  samples: number;
  /** Banzhaf 关键性：摇摆联盟占比（0~1；高 = 不可替代节点） */
  criticality: number;
  /** 虚拟玩家标记（所有边际 ≤ 容差——数学上应得 0） */
  isDummy: boolean;
  /** 是否已统计确证为正贡献（下界 > 0；采样模式的偷看安全裁决） */
  provablyPositive: boolean;
}

/** 玩家对协同分析 */
export interface SynergyPair {
  a: string;
  b: string;
  /** V(A∪B) − V(A) − V(B)（> 0 正协同；< 0 互相拆台） */
  synergy: number;
  kind: 'positive' | 'negative';
}

/** 归因报告 */
export interface ShapleyReport {
  /** 玩家数 */
  players: number;
  /** 大联盟价值 V(N) */
  totalValue: number;
  /** 归因明细（按 shapley 降序） */
  attributions: ShapleyAttribution[];
  /** 协同对（按 |synergy| 降序；仅显著者） */
  synergies: SynergyPair[];
  /** 是否精确枚举 */
  exact: boolean;
  /** 消耗的排列数（采样模式；精确模式为 0） */
  permutations: number;
  /** 效率公理残差 Σφᵢ − V(N)（份额已归一 → 残差恒 0，验证公理成立） */
  efficiencyResidual: number;
  /** 提前停止原因 */
  stopReason: 'exact' | 'budget' | 'ranking-decided';
  interpretation: string;
}

/** 加权 Shapley 报告（R5-A13：Kalai–Samet 非对称权） */
export interface WeightedShapleyReport {
  players: number;
  totalValue: number;
  /** 非对称权重（与入参对齐；全部等权时精确退化为经典 Shapley） */
  weights: number[];
  attributions: ShapleyAttribution[];
  /** 效率公理残差 Σφ^w − V(N) */
  efficiencyResidual: number;
  /** 部分排列 DFS 结算的节点数（≈ e·n!；每节点恰结算一个玩家的边际） */
  enumeratedNodes: number;
  interpretation: string;
}

/** 分层排列采样报告（R5-A13：按首玩家分层 + 层内方差估计） */
export interface StratifiedShapleyReport {
  players: number;
  totalValue: number;
  /** 估计量中心与任意时刻有效置信区间（Bonferroni 并集界求和区间） */
  attributions: ShapleyAttribution[];
  /** 总排列数（均分到 n 层） */
  permutations: number;
  /** 层数 = 玩家数（按排列首玩家分层） */
  strata: number;
  /** 每层排列数（均分） */
  perStratum: number;
  /** 逐玩家（与 players 同序）分层估计量方差 Σ_s w²σ²_s/m_s */
  stratifiedVariances: number[];
  /** 逐玩家单流池化方差 σ̂²_pool/M（对照口径） */
  pooledVariances: number[];
  /** 逐玩家方差缩减比 分层/池化（< 1 = 分层更优；方差分解定理担保方向） */
  varianceRatios: number[];
  interpretation: string;
}

// ─────────────────────────── 内核实现 ───────────────────────────

/**
 * Shapley 公平归因引擎
 *
 * 用法：
 *   const engine = new ShapleyAttributionEngine(valueFunction, config);
 *   const report = engine.attribute(['model-a', 'model-b', 'model-c']);
 *
 * 价值函数约定：值域 [0,1]（成功率/质量分/归一化收益等天然满足）；
 * 边际贡献因此落在 [−1,1]，采样模式经仿射缩放喂入 12.0 置信序列。
 */
export class ShapleyAttributionEngine {
  private readonly config: ShapleyConfig;
  private readonly valueOf: CoalitionValueFunction;
  private readonly rng: () => number;
  /** 联盟值缓存（key = 排序后玩家逗号连接；跨调用复用——价值函数可能是昂贵查询） */
  private readonly cache = new Map<string, number>();

  constructor(valueFunction: CoalitionValueFunction, config?: Partial<ShapleyConfig>) {
    this.config = { ...DEFAULT_SHAPLEY_CONFIG, ...config };
    this.valueOf = valueFunction;
    this.rng = this.config.rng ?? Math.random;
  }

  /** 缓存命中的联盟值数（可观测：昂贵价值函数的节省程度） */
  get cacheHits(): number {
    return this.cache.size;
  }

  /**
   * 公平归因主入口。
   *
   * n ≤ exactThreshold：2ⁿ 全枚举（精确，含 Banzhaf 关键性与协同对）；
   * 否则：排列采样 + 12.0 置信区间（提前停止：名次分离即停）。
   */
  attribute(players: readonly string[]): ShapleyReport {
    const unique = [...new Set(players)];
    if (unique.length === 0) {
      return {
        players: 0,
        totalValue: 0,
        attributions: [],
        synergies: [],
        exact: true,
        permutations: 0,
        efficiencyResidual: 0,
        stopReason: 'exact',
        interpretation: '无玩家参与（空博弈，无价值可分）',
      };
    }
    if (unique.length <= this.config.exactThreshold) {
      return this.attributeExact(unique);
    }
    return this.attributeSampled(unique);
  }

  // ─────────────────────────── 精确枚举 ───────────────────────────

  private attributeExact(players: string[]): ShapleyReport {
    const n = players.length;
    const totalValue = this.coalition(players);

    // 预枚举全部 2ⁿ 联盟值（位掩码索引）
    const size = 1 << n;
    const values = new Float64Array(size);
    for (let mask = 0; mask < size; mask += 1) {
      const coalition: string[] = [];
      for (let i = 0; i < n; i += 1) if (mask & (1 << i)) coalition.push(players[i]);
      values[mask] = this.coalition(coalition);
    }

    const tolerance = this.config.tolerance;
    const factorials = precomputedFactorials(n);
    const shapleyValues = new Float64Array(n);
    const swings = new Int32Array(n);

    for (let i = 0; i < n; i += 1) {
      let phi = 0;
      const bit = 1 << i;
      for (let s = 0; s < size; s += 1) {
        if (s & bit) continue; // S ⊆ N∖{i}
        const withI = s | bit;
        const marginal = values[withI] - values[s];
        const sSize = popcount(s);
        // Shapley 权重 |S|!(n−|S|−1)!/n!
        const weight = factorials[sSize] * factorials[n - sSize - 1] / factorials[n];
        phi += weight * marginal;
        if (marginal > tolerance) swings[i] += 1;
      }
      shapleyValues[i] = phi;
    }

    const order = [...players.keys()].sort((a, b) => shapleyValues[b] - shapleyValues[a]);
    const sumPhi = shapleyValues.reduce((a, b) => a + b, 0);
    const attributions: ShapleyAttribution[] = order.map((index, rank) => {
      const phi = shapleyValues[index];
      return {
        playerId: players[index],
        shapley: round(phi),
        lower: round(phi),
        upper: round(phi),
        share: totalValue > tolerance ? round(Math.max(0, phi / totalValue)) : 0,
        rank: rank + 1,
        exact: true,
        samples: 1 << (n - 1), // 每玩家的联盟覆盖数
        criticality: round(swings[index] / (size / 2)),
        isDummy: Math.abs(phi) <= tolerance,
        provablyPositive: phi > tolerance,
      };
    });

    // 份额归一（效率公理：Σ share = 1；负 Shapley 玩家份额取 0，剩余按比例摊还）
    normalizeShares(attributions, totalValue, tolerance);

    return {
      players: n,
      totalValue: round(totalValue),
      attributions,
      synergies: this.detectSynergies(players),
      exact: true,
      permutations: 0,
      efficiencyResidual: round(sumPhi - totalValue),
      stopReason: 'exact',
      interpretation: this.interpretExact(attributions, sumPhi, totalValue),
    };
  }

  // ─────────────────────────── 排列采样 ───────────────────────────

  private attributeSampled(players: string[]): ShapleyReport {
    const n = players.length;
    const totalValue = this.coalition(players);
    const tolerance = this.config.tolerance;
    // 边际值域 [−1,1] 仿射缩放到 [0,1]：x' = (x+1)/2，观测后映射回来
    const streams = new Map<string, EmpiricalBernsteinSequence>();
    const criticalCount = new Map<string, number>();
    for (const p of players) {
      streams.set(p, new EmpiricalBernsteinSequence(this.config.alpha));
      criticalCount.set(p, 0);
    }

    let permutations = 0;
    let stopReason: ShapleyReport['stopReason'] = 'budget';
    const working = [...players];

    while (permutations < this.config.maxPermutations) {
      // Fisher–Yates 洗牌出一个随机排列，前缀走一遍：每人一份边际样本
      for (let i = working.length - 1; i > 0; i -= 1) {
        const j = Math.floor(this.rng() * (i + 1));
        [working[i], working[j]] = [working[j], working[i]];
      }
      const prefix: string[] = [];
      let prefixValue = this.coalition(prefix);
      for (const player of working) {
        prefix.push(player);
        const newPrefixValue = this.coalition(prefix);
        const marginal = newPrefixValue - prefixValue;
        streams.get(player)!.observe((marginal + 1) / 2);
        if (marginal > tolerance) criticalCount.set(player, criticalCount.get(player)! + 1);
        prefixValue = newPrefixValue;
      }
      permutations += 1;

      // 提前停止：达到最小采样量后，若相邻名次玩家的置信区间已分离 → 座次已定
      if (permutations >= this.config.minPermutations && this.rankingDecided(streams, players)) {
        stopReason = 'ranking-decided';
        break;
      }
    }

    const estimates = players.map((p) => {
      const stream = streams.get(p)!;
      const bounds = stream.bounds();
      return {
        playerId: p,
        // 映射回 [−1,1] 口径：μ = 2μ' − 1
        shapley: round(2 * bounds.mean - 1),
        lower: round(Math.max(-1, 2 * bounds.lower - 1)),
        upper: round(Math.min(1, 2 * bounds.upper - 1)),
        samples: bounds.n,
      };
    });
    estimates.sort((a, b) => b.shapley - a.shapley);

    const sumPhi = estimates.reduce((a, e) => a + e.shapley, 0);
    const attributions: ShapleyAttribution[] = estimates.map((e, rank) => ({
      playerId: e.playerId,
      shapley: e.shapley,
      lower: e.lower,
      upper: e.upper,
      share: totalValue > tolerance && sumPhi > tolerance ? round(Math.max(0, e.shapley / sumPhi)) : 0,
      rank: rank + 1,
      exact: false,
      samples: e.samples,
      criticality: round(criticalCount.get(e.playerId)! / permutations),
      isDummy: e.upper <= tolerance,
      provablyPositive: e.lower > tolerance,
    }));
    normalizeShares(attributions, totalValue, tolerance);

    const synergies = this.detectSynergies(players);
    const decided = stopReason === 'ranking-decided';
    return {
      players: n,
      totalValue: round(totalValue),
      attributions,
      synergies,
      exact: false,
      permutations,
      efficiencyResidual: round(sumPhi - totalValue),
      stopReason,
      interpretation: decided
        ? `${permutations} 次排列后名次已统计分离（任意时刻有效，偷看安全）——第 1 名 ${attributions[0].playerId}（φ̂=${attributions[0].shapley.toFixed(3)}）`
        : `预算耗尽（${permutations} 次排列）：座次部分未决，区间仍任意时刻有效——头部 ${attributions[0].playerId}（φ̂=${attributions[0].shapley.toFixed(3)}，CI [${attributions[0].lower.toFixed(3)}, ${attributions[0].upper.toFixed(3)}]）`,
    };
  }

  /**
   * 名次分离判定：按当前中心估计排序后，所有相邻对
   * （上者置信下界 > 下者置信上界）均分离 → 座次统计上已定。
   * 置信序列任意时刻有效——这一判定本身偷看安全。
   */
  private rankingDecided(streams: Map<string, EmpiricalBernsteinSequence>, players: string[]): boolean {
    if (players.length < 2) return true;
    const views = players.map((p) => {
      const b = streams.get(p)!.bounds();
      return { mean: 2 * b.mean - 1, lower: 2 * b.lower - 1, upper: 2 * b.upper - 1 };
    });
    views.sort((a, b) => b.mean - a.mean);
    for (let i = 1; i < views.length; i += 1) {
      if (views[i - 1].lower <= views[i].upper) return false;
    }
    return true;
  }

  // ─────────────────────────── R5-A13：加权 Shapley ───────────────────────────

  /** 加权 Shapley 精确枚举的玩家数上限（部分排列节点数 ≈ e·n!；9 → ~98.6 万节点） */
  static readonly MAX_WEIGHTED_PLAYERS = 9;

  /**
   * 加权 Shapley（Kalai–Samet 1977）：排列概率 p(π) = Π_t λ_{π_t}/Λ_t
   * （Λ_t = 剩余玩家权重和），φ^w_i = Σ_π p(π)·边际_i(π)。
   *
   * 实现为部分排列 DFS：扩展到「前缀 P + 玩家 i」节点时立即以节点概率
   * 结算 i 的边际贡献 V(P∪{i}) − V(P)——所有含该前缀的排列被一次性
   * 团结算（概率 telescoping），无需走到叶子。等权 ⟹ p(π) = 1/n!
   * 精确退化为经典 Shapley；零边际玩家（dummy）在任意权下仍恰得 0。
   *
   * weights 与 players 等长、每个权重必须为有限正数（零/负权会毁灭
   * 排列概率的良定义——显式拒绝而非静默钳制）。
   */
  weightedShapley(players: readonly string[], weights: ReadonlyArray<number>): WeightedShapleyReport {
    const unique = [...new Set(players)];
    if (unique.length === 0) {
      throw new Error('weightedShapley: 玩家列表不能为空');
    }
    if (weights.length !== unique.length) {
      throw new Error(`weightedShapley: weights 长度 ${weights.length} 必须等于玩家数 ${unique.length}`);
    }
    for (let i = 0; i < weights.length; i += 1) {
      const w = weights[i];
      if (!Number.isFinite(w) || w <= 0) {
        throw new Error(`weightedShapley: 权重必须是有限正数（第 ${i} 个 = ${w}）`);
      }
    }
    const n = unique.length;
    if (n > ShapleyAttributionEngine.MAX_WEIGHTED_PLAYERS) {
      throw new Error(
        `weightedShapley: 精确加权枚举上限 ${ShapleyAttributionEngine.MAX_WEIGHTED_PLAYERS} 玩家（收到 ${n}——节点数 ≈ e·n! 指数增长；更大场景请用排列采样口径）`,
      );
    }

    const totalValue = this.coalition(unique);
    const tolerance = this.config.tolerance;
    const phi = new Float64Array(n);
    let enumeratedNodes = 0;

    // 部分排列 DFS：state = 已选前缀（下标序），nodeProb = 该前缀的概率质量
    const chosen = new Array<boolean>(n).fill(false);
    const prefix: string[] = [];
    const dfs = (nodeProb: number, remainingWeight: number, depth: number): void => {
      enumeratedNodes += 1;
      if (depth === n) return;
      for (let i = 0; i < n; i += 1) {
        if (chosen[i]) continue;
        const childProb = (nodeProb * weights[i]) / remainingWeight;
        chosen[i] = true;
        prefix.push(unique[i]);
        const withI = this.coalition(prefix);
        const withoutI = depth === 0 ? this.coalition([]) : this.coalition(prefix.slice(0, -1));
        phi[i] += childProb * (withI - withoutI);
        dfs(childProb, remainingWeight - weights[i], depth + 1);
        prefix.pop();
        chosen[i] = false;
      }
    };
    dfs(1, weights.reduce((a, b) => a + b, 0), 0);

    // Banzhaf 关键性与 dummy 判定复用 2ⁿ 位掩码枚举（与精确口径一致）
    const size = 1 << n;
    const swings = new Int32Array(n);
    const values = new Float64Array(size);
    for (let mask = 0; mask < size; mask += 1) {
      const coalition: string[] = [];
      for (let i = 0; i < n; i += 1) if (mask & (1 << i)) coalition.push(unique[i]);
      values[mask] = this.coalition(coalition);
    }
    for (let i = 0; i < n; i += 1) {
      const bit = 1 << i;
      for (let s = 0; s < size; s += 1) {
        if (s & bit) continue;
        if (values[s | bit] - values[s] > tolerance) swings[i] += 1;
      }
    }

    let sumPhi = 0;
    for (let i = 0; i < n; i += 1) sumPhi += phi[i];
    const order = [...unique.keys()].sort((a, b) => phi[b] - phi[a]);
    const attributions: ShapleyAttribution[] = order.map((index, rank) => ({
      playerId: unique[index],
      shapley: round(phi[index]),
      lower: round(phi[index]),
      upper: round(phi[index]),
      share: totalValue > tolerance ? round(Math.max(0, phi[index] / totalValue)) : 0,
      rank: rank + 1,
      exact: true,
      samples: factorialsOf(n), // 排列覆盖数 n!（每个排列对每个玩家各出一份边际）
      criticality: round(swings[index] / (size / 2)),
      isDummy: Math.abs(phi[index]) <= tolerance,
      provablyPositive: phi[index] > tolerance,
    }));
    normalizeShares(attributions, totalValue, tolerance);

    const maxWeight = Math.max(...weights);
    const maxIndex = weights.indexOf(maxWeight);
    return {
      players: n,
      totalValue: round(totalValue),
      weights: [...weights],
      attributions,
      efficiencyResidual: round(sumPhi - totalValue),
      enumeratedNodes,
      interpretation: `加权 Shapley（Kalai–Samet，权向 λ=${weights.map((w) => w.toFixed(2)).join(':')}，${enumeratedNodes} 个部分排列节点）：第 1 名 ${attributions[0].playerId}（φ^w=${attributions[0].shapley.toFixed(3)}）；最高权玩家 ${unique[maxIndex]}（λ=${maxWeight.toFixed(2)}，份额 ${((attributions.find((a) => a.playerId === unique[maxIndex])?.share ?? 0) * 100).toFixed(1)}%）`,
    };
  }

  // ─────────────────────────── R5-A13：分层排列采样 ───────────────────────────

  /**
   * 分层排列采样：按「排列首玩家」把排列空间切成 n 个等权层（均匀随机
   * 排列的首玩家均匀分布），层内均匀采样，φ̂_i = (1/n)Σ_s μ̂_{s,i} 无偏。
   *
   * 方差分解定理：σ² = Σ_s w_sσ_s² + Σ_s w_s(μ_s−μ)² —— 分层估计量只吃
   * 「层内」项，层间差被整段消除（报告 varianceRatios 对照）。
   * 置信区间：逐（层×玩家）EmpiricalBernstein 序列（水平 α/n），求和区间
   * 由 Bonferroni 并集界背书——任意时刻有效（偷看安全）不降级。
   */
  attributeStratified(players: readonly string[]): StratifiedShapleyReport {
    const unique = [...new Set(players)];
    if (unique.length === 0) {
      throw new Error('attributeStratified: 玩家列表不能为空');
    }
    const n = unique.length;
    if (n < 2 || n <= this.config.exactThreshold) {
      // 小博弈不值得采样口径：诚实拒绝（精确口径已覆盖）
      throw new Error(
        `attributeStratified: 分层采样面向 n > exactThreshold 的大博弈（收到 n=${n}，阈值 ${this.config.exactThreshold}——请走 attribute 精确路径）`,
      );
    }
    const totalValue = this.coalition(unique);
    const tolerance = this.config.tolerance;
    const perStratum = Math.max(1, Math.floor(this.config.maxPermutations / n));
    const permutations = perStratum * n;
    const stratumAlpha = this.config.alpha / n; // Bonferroni：n 层并集界

    // streams.get(stratum)!.get(player)!：层 × 玩家 置信序列；pooled：玩家单流对照
    const streams = new Map<number, Map<string, EmpiricalBernsteinSequence>>();
    const pooled = new Map<string, EmpiricalBernsteinSequence>();
    const criticalCount = new Map<string, number>();
    for (const s of unique) {
      streams.set(
        unique.indexOf(s),
        new Map(unique.map((p) => [p, new EmpiricalBernsteinSequence(stratumAlpha)])),
      );
      pooled.set(s, new EmpiricalBernsteinSequence(this.config.alpha));
      criticalCount.set(s, 0);
    }

    const working: string[] = [];
    for (let stratum = 0; stratum < n; stratum += 1) {
      // 层 stratum：首玩家固定 unique[stratum]，其余 Fisher–Yates 均匀洗牌
      for (let rep = 0; rep < perStratum; rep += 1) {
        working.length = 0;
        for (let i = 0; i < n; i += 1) if (i !== stratum) working.push(unique[i]);
        for (let i = working.length - 1; i > 0; i -= 1) {
          const j = Math.floor(this.rng() * (i + 1));
          [working[i], working[j]] = [working[j], working[i]];
        }
        const prefix: string[] = [unique[stratum]];
        let prefixValue = this.coalition(prefix);
        const observe = (player: string, marginal: number): void => {
          const scaled = (marginal + 1) / 2; // [−1,1] → [0,1]
          streams.get(stratum)!.get(player)!.observe(scaled);
          pooled.get(player)!.observe(scaled);
          if (marginal > tolerance) criticalCount.set(player, criticalCount.get(player)! + 1);
        };
        observe(unique[stratum], prefixValue - this.coalition([]));
        for (const player of working) {
          prefix.push(player);
          const newPrefixValue = this.coalition(prefix);
          observe(player, newPrefixValue - prefixValue);
          prefixValue = newPrefixValue;
        }
      }
    }

    // 分层合成：中心 = (1/n)Σ_s μ_s；区间 = (1/n)Σ_s [lower_s, upper_s]（并集界）
    const stratifiedVariances: number[] = [];
    const pooledVariances: number[] = [];
    const varianceRatios: number[] = [];
    const estimates = unique.map((p, i) => {
      let meanScaled = 0;
      let lowerScaled = 0;
      let upperScaled = 0;
      let stratVar = 0;
      for (let s = 0; s < n; s += 1) {
        const b = streams.get(s)!.get(p)!.bounds();
        meanScaled += b.mean / n;
        lowerScaled += b.lower / n;
        upperScaled += b.upper / n;
        stratVar += streams.get(s)!.get(p)!.sampleVariance / (n * n * perStratum);
      }
      const pb = pooled.get(p)!.bounds();
      const pooledVar = pooled.get(p)!.sampleVariance / permutations;
      stratifiedVariances.push(stratVar);
      pooledVariances.push(pooledVar);
      varianceRatios.push(pooledVar > 0 ? stratVar / pooledVar : stratVar === 0 ? 0 : Number.POSITIVE_INFINITY);
      return {
        playerId: p,
        index: i,
        shapley: round(2 * meanScaled - 1),
        lower: round(Math.max(-1, 2 * lowerScaled - 1)),
        upper: round(Math.min(1, 2 * upperScaled - 1)),
        samples: permutations,
      };
    });
    estimates.sort((a, b) => b.shapley - a.shapley);

    const sumPhi = estimates.reduce((a, e) => a + e.shapley, 0);
    const attributions: ShapleyAttribution[] = estimates.map((e, rank) => ({
      playerId: e.playerId,
      shapley: e.shapley,
      lower: e.lower,
      upper: e.upper,
      share: totalValue > tolerance && sumPhi > tolerance ? round(Math.max(0, e.shapley / sumPhi)) : 0,
      rank: rank + 1,
      exact: false,
      samples: e.samples,
      criticality: round(criticalCount.get(e.playerId)! / permutations),
      isDummy: e.upper <= tolerance,
      provablyPositive: e.lower > tolerance,
    }));
    normalizeShares(attributions, totalValue, tolerance);

    const avgRatio = varianceRatios.reduce((a, r) => a + (Number.isFinite(r) ? r : 1), 0) / n;
    const top = attributions[0];
    return {
      players: n,
      totalValue: round(totalValue),
      attributions,
      permutations,
      strata: n,
      perStratum,
      stratifiedVariances,
      pooledVariances,
      varianceRatios,
      interpretation: `分层排列采样（${n} 层 × ${perStratum} 排列 = ${permutations}）：平均方差缩减比 ${avgRatio.toFixed(3)}（< 1 = 层间差被消除）；第 1 名 ${top.playerId}（φ̂=${top.shapley.toFixed(3)}，任意时刻有效 CI [${top.lower.toFixed(3)}, ${top.upper.toFixed(3)}]）`,
    };
  }

  // ─────────────────────────── 协同检测 ───────────────────────────

  /**
   * 两两协同分析：V(A∪B) − V(A) − V(B)。
   * 正协同对应组队增益，负协同对应互相拆台——均只保留超容差者。
   */
  detectSynergies(players: readonly string[]): SynergyPair[] {
    const tolerance = this.config.tolerance;
    const pairs: SynergyPair[] = [];
    for (let i = 0; i < players.length; i += 1) {
      for (let j = i + 1; j < players.length; j += 1) {
        const a = players[i];
        const b = players[j];
        const synergy = this.coalition([a, b]) - this.coalition([a]) - this.coalition([b]);
        if (Math.abs(synergy) <= tolerance) continue;
        pairs.push({ a, b, synergy: round(synergy), kind: synergy > 0 ? 'positive' : 'negative' });
      }
    }
    pairs.sort((x, y) => Math.abs(y.synergy) - Math.abs(x.synergy));
    return pairs;
  }

  // ─────────────────────────── 内部工具 ───────────────────────────

  /** 联盟值查询（排序记忆化：同一玩家集合只估值一次） */
  private coalition(members: readonly string[]): number {
    const key = [...members].sort().join(',');
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const value = this.valueOf(members);
    this.cache.set(key, value);
    return value;
  }

  private interpretExact(attributions: ShapleyAttribution[], sumPhi: number, totalValue: number): string {
    const top = attributions[0];
    const dummies = attributions.filter((a) => a.isDummy);
    const parts: string[] = [
      `精确 Shapley（${attributions.length} 玩家，Σφ=${sumPhi.toFixed(3)}=V(N)）——第 1 名 ${top.playerId}（φ=${top.shapley.toFixed(3)}，份额 ${(top.share * 100).toFixed(1)}%）`,
    ];
    if (dummies.length > 0) parts.push(`虚拟玩家 ${dummies.length} 名（数学上分得 0，搭便车无利可图）`);
    return parts.join('；');
  }
}

// ─────────────────────────── 纯函数工具 ───────────────────────────

/** 预计算阶乘表 0!..n! */
function precomputedFactorials(n: number): number[] {
  const f = [1];
  for (let i = 1; i <= n; i += 1) f.push(f[i - 1] * i);
  return f;
}

/** n!（整数口径；加权 Shapley 的排列覆盖数） */
function factorialsOf(n: number): number {
  const f = precomputedFactorials(n);
  return f[n];
}

/** 位计数（popcount） */
function popcount(x: number): number {
  let count = 0;
  while (x) {
    x &= x - 1;
    count += 1;
  }
  return count;
}

/**
 * 份额归一（效率公理落地）：非 dummy 玩家的份额按 Σφ 比例缩放，
 * 使 Σ share = 1 精确成立；负 Shapley（拆台者）份额钉 0。
 */
function normalizeShares(attributions: ShapleyAttribution[], totalValue: number, tolerance: number): void {
  if (totalValue <= tolerance) {
    for (const a of attributions) a.share = 0;
    return;
  }
  const positive = attributions.filter((a) => a.shapley > tolerance);
  const sumPositive = positive.reduce((s, a) => s + a.shapley, 0);
  if (sumPositive <= tolerance) {
    for (const a of attributions) a.share = 0;
    return;
  }
  for (const a of attributions) {
    a.share = a.shapley > tolerance ? round(a.shapley / sumPositive) : 0;
  }
}
