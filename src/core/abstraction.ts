/**
 * abstraction.ts — 抽象内核（项目 9.0「抽象心智」质变基座：类比结构映射）
 *
 * 升级前的根本局限（8.0 元认知心智的天花板）：
 * 转移模型把每个状态键当**孤立符号**——`trapB#s0` 与 `trapA#s0`
 * 哪怕结构完全相同也互不相干；新任务域永远从 Beta(1,1) 完全无知
 * 开始，深思搜索在陌生域只能凭认知价值乱试探。系统**学不会
 * 举一反三**：经验被锁死在它被采集的具体状态键里。
 *
 * 本内核引入结构映射类比（Structure Mapping, Gentner 1983）+
 * 分层贝叶斯收缩（hierarchical partial pooling）：
 *
 * 1. **状态骨架分解**：state = `${domain}#${skeleton}`——域是
 *    「对象标签」（code-gen / translation / trapA / trapB），
 *    骨架是「关系角色」（#s0 起步 / #dead 死路 / #rich 富态）。
 *    抽象 = 保关系、换对象。
 *
 * 2. **域结构相似度**：域画像 = 观测过的 (骨架, 行动) 集合；
 *    sim(d1,d2) = Jaccard(画像)。两个结构相同的陷阱域相似度 1，
 *    无关域相似度 0——**结构同构可度量，类比有了闸门**。
 *
 * 3. **分层先验链**（全部排除自身叶子证据，防双计）：
 *    L1 类比层：结构相似的别域在同骨架同行动上的后验（sim 加权）
 *    L2 域边际层：本域其他骨架对同一行动的经验（域难度）
 *    L3 全局骨架层：所有域在该骨架行动上的无权池化
 *    L4 均匀层：Beta(1,1)（strength=2，与未挂载时严格等价）
 *
 * 4. **后继继承**（结构映射的核心）：冷叶子不仅继承边缘概率，
 *    还继承**转移结构**——别域 (骨架, 行动) 的 MAP 后继骨架映射
 *    回本域（trapA 的 bait→#dead 迁移成 trapB 的 bait→#dead）。
 *    陷阱的本质在后继结构里，不在边缘概率里——不继承结构
 *    就谈不上类比规划。
 *
 * 5. **抽象技能**：同一骨架同一行动序列在 ≥2 个域整体成功 →
 *    晋升为跨域宏技能（`*#${skeleton}` 触发），第三个同构域
 *    冷启动即可复用——「怎么做」的知识第一次跨域通用。
 *
 * 与 6/7/8.0 的关系：6.0 定价行动、7.0 定价计划、8.0 定价思考，
 * 本内核让三者**跨域泛化**——经验不再是一次性的。
 * 抽象心智 = 元认知心智 × 举一反三。
 *
 * ── R5 第五轮世界性进化（四轴）──
 *
 * A1【数学进化】抽象层的率失真最优粒度（rateDistortionFrontier）：
 *    把 N 条骨架级结构边的后验均值视作信源，K 级抽象（把 N 条边量化
 *    为 K 个等价类）为码本。加权 MSE 口径下最优标量量化 = 按均值排序
 *    的连续段划分（Lloyd 最优性条件的 1-D 特例），全局最优由 DP 求得：
 *      D(K) = min_{划分} Σ_g Σ_{i∈g} wᵢ(p̂ᵢ − c_g)²，c_g = 组内加权均值
 *    率取分组指派熵 R(K) = H(组质量)。产出完整 R-D 前沿（K = 1..上限）
 *    与肘点粒度（边际畸变下降 < ε 即停）——「抽象到多细」第一次有了
 *    信息论定价而非拍脑袋分层。
 *
 * A2【性能进化】①分层先验 L1 的等价类索引：hierarchicalPrior /
 *    inheritedSuccessor 不再全表扫描 skeletonEdges，改走
 *    (skeleton, action) 倒排索引（插入序保持 → 遍历顺序与旧全表扫描
 *    的过滤结果完全同序 → 结果逐位相等，verify 脚本 ≥200 种子以脚本侧
 *    全表扫描独立复算对照 + 扫描计数审计字段 priorScanAudit 证明）。
 *    ②行为等价类的并查集化（behaviorEquivalenceClasses）：同 MAP 后继
 *    骨架 + 均值差 ≤ tol 的传递闭包等价类，按后继桶内排序 + 相邻 union
 *    的并查集 O(n log n + nα) 求解，与 O(n²) 逐对闭包的暴力口径一致
 *    （脚本侧 BFS 闭包对照 ≥200 种子）。
 *
 * A4【性质进化】商结构一致性：projectToSkeleton 是幂等投影
 *    （project∘project = project，≥200 种子逐位断言）；quotientSystem
 *    给出骨架商转移系统（池化后验 + 模态后继骨架），其状态集恰为投影
 *    的像，边端点封闭于状态集——「抽象两次 = 抽象一次」的商代数性质
 *    首次可机检。
 */

// ─────────────────────────── 数据结构 ───────────────────────────

/** 分层先验（叶子证据之外的一切知识来源） */
export interface HierarchicalPrior {
  /** 先验均值（域间迁移来的成功率估计） */
  mean: number;
  /** 先验强度（伪计数；均匀层 = 2 与 Beta(1,1) 严格等价） */
  strength: number;
  /** 来源层标注（audit：analogy(domain) / domain-marginal / global-skeleton / uniform） */
  source: string;
  /** L1 层实际参与融合的域（结构映射的证人） */
  witnessDomains?: string[];
}

/** 抽象技能（跨域宏动作；在 deliberation 中包装为 Skill 参与 beam 种子） */
export interface AbstractSkillEntry {
  id: string;
  /** 触发骨架（任意域匹配） */
  skeleton: string;
  actions: string[];
  /** 成功域数（晋升证据） */
  domains: number;
  /** 总成功次数 */
  successes: number;
  value: number;
}

/** 抽象统计（meta-cognition KPI 用） */
export interface AbstractionStats {
  /** 已观测域数 */
  domains: number;
  /** 骨架级结构边数 */
  structuralEdges: number;
  /** 零样本应答：冷叶子拿到非均匀先验的次数（真正发生的举一反三） */
  zeroShotAnswers: number;
  /** 类比迁移启用次数（L1 命中） */
  analogyTransfers: number;
  /** 后继结构继承次数 */
  successorInheritances: number;
  /** 抽象技能数 */
  abstractSkills: number;
  interpretation: string;
}

// ─────────────── R5：率失真 / 行为等价类 / 商结构 数据结构 ───────────────

/** R-D 前沿单点：K 级抽象的畸变与率 */
export interface RateDistortionPoint {
  /** 抽象级数 K */
  levels: number;
  /** 归一化加权 MSE（每条边的期望畸变） */
  distortion: number;
  /** 分组指派熵（bit/边） */
  rateBits: number;
}

/** R5·A1 率失真最优粒度报告 */
export interface RateDistortionReport {
  points: RateDistortionPoint[];
  /** 肘点粒度（边际畸变下降 ≤ relativeDrop·D 的首个 K） */
  optimalLevels: number;
  elbow: { levels: number; marginalDrop: number };
  /** D(K) 关于 K 单调不增 */
  monotone: boolean;
  /** 信源边数（未去重） */
  sourceEdges: number;
  /** 去重后的信源符号数 */
  distinctMeans: number;
}

/** R5·A2 行为等价类报告 */
export interface EquivalenceClassReport {
  tolerance: number;
  classes: Array<{
    size: number;
    /** 类内后验均值极差（≤ tolerance 的传递闭包口径） */
    meanRange: number;
    totalEvidence: number;
    /** 成员键 `${domain}#${skeleton}|${action}` */
    members: string[];
  }>;
  /** 并查集 union 次数（性能审计） */
  unions: number;
  totalEdges: number;
}

/** R5·A4 商转移系统边 */
export interface QuotientEdge {
  /** `#${skeleton}` 投影口径 */
  from: string;
  action: string;
  to: string;
  /** 池化后验均值 (1+Σ成功)/(2+Σ证据) */
  pSuccess: number;
  evidence: number;
  /** 该 (骨架, 行动) 池化自几个域（跨域复验度） */
  domains: number;
}

/** R5·A4 骨架商转移系统 */
export interface QuotientSystem {
  /** 状态集 = projectToSkeleton 的像 */
  states: string[];
  edges: QuotientEdge[];
}


// ─────────────────────────── 配置 ───────────────────────────

export interface AbstractionConfig {
  /** L1 类比层先验强度（伪计数，缺省 6） */
  analogyStrength: number;
  /** L2 域边际层先验强度（缺省 4） */
  domainStrength: number;
  /** L3 全局骨架层先验强度（缺省 3） */
  globalStrength: number;
  /** 结构相似度门槛（Jaccard，缺省 0.3——低于此不迁移） */
  minSimilarity: number;
  /** 抽象技能晋升所需跨域成功数（缺省 2） */
  abstractSkillDomains: number;
  /** 域画像最大容量（防爆内存；缺省 4096） */
  maxProfileSize: number;
}

export const DEFAULT_ABSTRACTION_CONFIG: AbstractionConfig = {
  analogyStrength: 6,
  domainStrength: 4,
  globalStrength: 3,
  minSimilarity: 0.3,
  abstractSkillDomains: 2,
  maxProfileSize: 4096,
};

// ─────────────────────────── 内部记账 ───────────────────────────

interface EdgeCounts {
  successes: number;
  failures: number;
  /** 后继分布（真实状态键 → 成功转移计数） */
  successors: Map<string, number>;
}

/** 骨架级键：domain \0 skeleton \0 action（= 叶子键，用于排除自身） */
function skKey(domain: string, skeleton: string, action: string): string {
  return `${domain}\u0000${skeleton}\u0000${action}`;
}

/** R5：倒排索引键 (skeleton, action) */
function idxKey(skeleton: string, action: string): string {
  return `${skeleton}\u0000${action}`;
}

/** 域×行动键（域边际层） */
function domKey(domain: string, action: string): string {
  return `${domain}\u0000${action}`;
}

/** 全局骨架×行动键 */
function globKey(skeleton: string, action: string): string {
  return `${skeleton}\u0000${action}`;
}

// ─────────────────────────── 内核实现 ───────────────────────────

/**
 * 抽象内核：状态骨架分解 + 域结构相似度 + 分层先验链 + 后继继承
 * + 抽象技能晋升。
 *
 * 挂载于 DeliberationEngine（attachAbstraction）：observe 喂入证据、
 * posterior 经分层先验收缩、冷叶子继承别域后继结构、搜索种子合并
 * 抽象技能。未挂载时对既有行为零影响（先验链不参与）。
 */
export class AbstractionEngine {
  private config: AbstractionConfig;
  /** 骨架级证据（域, 骨架, 行动）——L1 目标 + 画像 + 自身排除基数 */
  private skeletonEdges = new Map<string, EdgeCounts>();
  /**
   * R5：L1 等价类索引 (skeleton, action) → 同构边列表（插入序）。
   * hierarchicalPrior / inheritedSuccessor 的倒排索引——取代全表扫描；
   * 列表元素与 skeletonEdges 的插入序一致 → 累加顺序与旧口径逐位相同。
   */
  private skeletonIndex = new Map<string, Array<{ domain: string; edge: EdgeCounts }>>();
  /** R5：索引扫描审计（等价性 + 性能证明的读出） */
  private lastScannedEdges = 0;
  private totalPriorQueries = 0;
  private totalScannedEdges = 0;
  /** 域×行动边际（L2） */
  private domainAction = new Map<string, { successes: number; failures: number }>();
  /** 全局骨架×行动（L3） */
  private globalSkeleton = new Map<string, { successes: number; failures: number }>();
  /** 域画像（域 → 观测过的 skeleton|action 集合）——相似度原料 */
  private profiles = new Map<string, Set<string>>();
  /** 抽象技能晋升追踪（骨架||签名 → 跨域成功） */
  private skillLadder = new Map<string, { skeleton: string; actions: string[]; domains: Set<string>; successes: number }>();
  private abstractSkills: AbstractSkillEntry[] = [];
  private skillCounter = 0;
  // KPI 计数
  private zeroShotAnswers = 0;
  private analogyTransfers = 0;
  private successorInheritances = 0;

  constructor(config?: Partial<AbstractionConfig>) {
    this.config = { ...DEFAULT_ABSTRACTION_CONFIG, ...config };
  }

  // ─────────────────────────── 证据喂入 ───────────────────────────

  /**
   * 登记一次观测（与 DeliberationEngine.observe 同步调用）。
   * @param nextState 成功时的后继状态（后继继承的原料）
   */
  observe(state: string, action: string, success: boolean, nextState?: string): void {
    const { domain, skeleton } = decompose(state);
    const key = skKey(domain, skeleton, action);
    let edge = this.skeletonEdges.get(key);
    if (!edge) {
      edge = { successes: 0, failures: 0, successors: new Map() };
      this.skeletonEdges.set(key, edge);
      // R5：倒排索引登记（插入序 = skeletonEdges 的插入序）
      const ik = idxKey(skeleton, action);
      const list = this.skeletonIndex.get(ik);
      if (list) list.push({ domain, edge });
      else this.skeletonIndex.set(ik, [{ domain, edge }]);
    }
    const dk = domKey(domain, action);
    const dm = this.domainAction.get(dk) ?? { successes: 0, failures: 0 };
    const gk = globKey(skeleton, action);
    const gm = this.globalSkeleton.get(gk) ?? { successes: 0, failures: 0 };
    if (success) {
      edge.successes += 1;
      dm.successes += 1;
      gm.successes += 1;
      if (nextState) edge.successors.set(nextState, (edge.successors.get(nextState) ?? 0) + 1);
    } else {
      edge.failures += 1;
      dm.failures += 1;
      gm.failures += 1;
    }
    this.domainAction.set(dk, dm);
    this.globalSkeleton.set(gk, gm);
    // 域画像更新（成功失败都算「观测到该结构」）
    let profile = this.profiles.get(domain);
    if (!profile) {
      profile = new Set();
      this.profiles.set(domain, profile);
    }
    if (profile.size < this.config.maxProfileSize) profile.add(`${skeleton}|${action}`);
  }

  // ─────────────────────────── 分层先验链 ───────────────────────────

  /**
   * 查询 (state, action) 的分层先验（叶子证据之外的一切）。
   *
   * 优先级：L1 类比（结构相似域同骨架）→ L2 域边际（本域其他骨架）
   * → L3 全局骨架（无权跨域）→ L4 均匀。各层均排除查询叶子自身
   * 的证据（防双计——deliberation 会把叶子证据加回后验）。
   */
  hierarchicalPrior(state: string, action: string): HierarchicalPrior {
    const { domain, skeleton } = decompose(state);
    const own = this.skeletonEdges.get(skKey(domain, skeleton, action));
    const ownS = own?.successes ?? 0;
    const ownF = own?.failures ?? 0;

    // R5 审计：本次查询扫描的边数（倒排索引口径；旧口径 = 全表大小）
    this.totalPriorQueries += 1;
    this.lastScannedEdges = this.skeletonIndex.get(idxKey(skeleton, action))?.length ?? 0;
    this.totalScannedEdges += this.lastScannedEdges;

    // L1 类比层：结构相似域在 (同骨架, 同行动) 上的后验，sim 加权
    // R5：倒排索引直达同 (骨架, 行动) 等价类（插入序遍历 → 与旧全表
    // 扫描的过滤序列完全同序，累加结果逐位相等）
    const candidates: Array<{ domain: string; sim: number; post: number; obs: number }> = [];
    for (const { domain: d, edge } of this.skeletonIndex.get(idxKey(skeleton, action)) ?? []) {
      if (d === domain) continue;
      const sim = this.structuralSimilarity(domain, d, skeleton, action);
      if (sim < this.config.minSimilarity) continue;
      const obs = edge.successes + edge.failures;
      if (obs < 1) continue;
      // 平滑后验（Beta(1,1) 口径）× 相似度权重
      candidates.push({
        domain: d,
        sim,
        post: (1 + edge.successes) / (2 + obs),
        obs,
      });
    }
    if (candidates.length > 0) {
      let wSum = 0;
      let acc = 0;
      let top = candidates[0]!;
      for (const c of candidates) {
        const w = c.sim * (c.obs / (c.obs + 2)); // 观测越多可信度越高
        acc += w * c.post;
        wSum += w;
        if (c.sim > top.sim) top = c;
      }
      if (wSum > 0) {
        this.analogyTransfers += 1;
        if (ownS + ownF === 0) this.zeroShotAnswers += 1;
        return {
          mean: acc / wSum,
          strength: this.config.analogyStrength,
          source: `analogy(${top.domain})`,
          witnessDomains: [...new Set(candidates.map((c) => c.domain))],
        };
      }
    }

    // L2 域边际层：本域其他骨架对同一行动的经验（排除自身叶子）
    const dm = this.domainAction.get(domKey(domain, action));
    if (dm) {
      const dmS = dm.successes - ownS;
      const dmF = dm.failures - ownF;
      if (dmS + dmF >= 2) {
        if (ownS + ownF === 0) this.zeroShotAnswers += 1;
        return {
          mean: (1 + dmS) / (2 + dmS + dmF),
          strength: this.config.domainStrength,
          source: 'domain-marginal',
        };
      }
    }

    // L3 全局骨架层：所有别域在该 (骨架, 行动) 上的无权池化
    const gm = this.globalSkeleton.get(globKey(skeleton, action));
    if (gm) {
      const gS = gm.successes - ownS;
      const gF = gm.failures - ownF;
      if (gS + gF >= 2) {
        if (ownS + ownF === 0) this.zeroShotAnswers += 1;
        return {
          mean: (1 + gS) / (2 + gS + gF),
          strength: this.config.globalStrength,
          source: 'global-skeleton',
        };
      }
    }

    // L4 均匀层：strength=2 与 Beta(1,1) 严格等价（挂载零数据时零漂移）
    return { mean: 0.5, strength: 2, source: 'uniform' };
  }

  // ─────────────────────────── 后继继承 ───────────────────────────

  /**
   * 冷叶子的后继结构继承：类比域 (骨架, 行动) 的 MAP 后继骨架
   * 映射回本域（trapA#s0 --bait--> trapA#dead ⟹ trapB#s0 --bait--> trapB#dead）。
   * 陷阱的本质在后继结构里——不继承结构就谈不上类比规划。
   * @returns 继承的后继状态；无可继承时 undefined
   */
  inheritedSuccessor(state: string, action: string): string | undefined {
    const { domain, skeleton } = decompose(state);
    let best: { successor: string; score: number } | undefined;
    // R5：倒排索引遍历（插入序与旧全表扫描过滤序列同序——平票裁决不变）
    for (const { domain: d, edge } of this.skeletonIndex.get(idxKey(skeleton, action)) ?? []) {
      if (d === domain) continue;
      const sim = this.structuralSimilarity(domain, d, skeleton, action);
      if (sim < this.config.minSimilarity) continue;
      // 该类比域的 MAP 后继（sim 加权票数）
      for (const [succ, count] of edge.successors) {
        const score = sim * count;
        if (!best || score > best.score) best = { successor: succ, score };
      }
    }
    if (!best) return undefined;
    // 骨架映射回本域：别域后继的骨架部分 + 本域标签
    const { skeleton: succSkeleton, hasSkeleton } = decompose(best.successor);
    if (!hasSkeleton) return undefined; // 单段状态无骨架可言，不跨域映射
    this.successorInheritances += 1;
    return `${domain}#${succSkeleton}`;
  }

  // ─────────────────────────── 域结构相似度 ───────────────────────────

  /** 域画像 Jaccard：观测过的 (骨架, 行动) 集合重合度——结构同构可度量 */
  domainSimilarity(d1: string, d2: string): number {
    if (d1 === d2) return 1;
    const p1 = this.profiles.get(d1);
    const p2 = this.profiles.get(d2);
    if (!p1 || !p2 || p1.size === 0 || p2.size === 0) return 0;
    let inter = 0;
    for (const k of p1) if (p2.has(k)) inter += 1;
    return inter / (p1.size + p2.size - inter);
  }

  /**
   * 查询口径的结构相似度（含冷域首触规则）：
   * - 查询域已有画像：严格 Jaccard（闸门防误迁移；一旦发现域并非
   *   同构，相似度跌破门槛，类比自动停止——错误类比自纠）
   * - 查询域全冷（无任何观测）：对方在**恰好这个结构位置**
   *   (骨架, 行动) 上有经验即为证人（sim=1）——处女域相信任何
   *   走过同一条结构路的前辈；先验强度（6 伪计数）约束借用幅度，
   *   自身证据积累后严格闸门接管
   */
  private structuralSimilarity(domain: string, other: string, skeleton: string, action: string): number {
    const p1 = this.profiles.get(domain);
    if (p1 && p1.size > 0) return this.domainSimilarity(domain, other);
    const p2 = this.profiles.get(other);
    if (!p2) return 0;
    return p2.has(`${skeleton}|${action}`) ? 1 : 0;
  }

  /** 已观测域列表（audit） */
  domains(): string[] {
    return [...this.profiles.keys()];
  }

  // ─────────────────────────── 抽象技能 ───────────────────────────

  /**
   * 计划结局入账（与 DeliberationEngine.settle 同步）：
   * 同一骨架同一行动序列在多个域整体成功 → 跨域宏技能晋升。
   */
  notePlanOutcome(firstState: string, actions: string[], success: boolean): void {
    if (actions.length === 0) return;
    const { domain, skeleton } = decompose(firstState);
    const sig = actions.join('|');
    const key = `${skeleton}||${sig}`;
    let entry = this.skillLadder.get(key);
    if (!entry) {
      entry = { skeleton, actions: [...actions], domains: new Set(), successes: 0 };
      this.skillLadder.set(key, entry);
    }
    if (success) {
      entry.domains.add(domain);
      entry.successes += 1;
      if (
        entry.domains.size >= this.config.abstractSkillDomains &&
        !this.abstractSkills.some((s) => s.skeleton === entry!.skeleton && s.actions.join('|') === sig)
      ) {
        this.abstractSkills.push({
          id: `abs-skill-${++this.skillCounter}`,
          skeleton: entry.skeleton,
          actions: [...entry.actions],
          domains: entry.domains.size,
          successes: entry.successes,
          value: round(entry.successes / (entry.successes + 1)),
        });
      }
    } else {
      entry.domains.delete(domain); // 失败域不再作证（抽象技能靠跨域复验）
      entry.successes = Math.max(0, entry.successes - 1);
    }
  }

  /** 检索：匹配状态骨架的抽象技能（跨域宏动作） */
  abstractSkillsFor(state: string): AbstractSkillEntry[] {
    const { skeleton } = decompose(state);
    return this.abstractSkills.filter((s) => s.skeleton === skeleton);
  }

  /** 全部抽象技能（audit） */
  allAbstractSkills(): AbstractSkillEntry[] {
    return [...this.abstractSkills];
  }

  // ─────────────────────────── KPI ───────────────────────────

  stats(): AbstractionStats {
    const zeroShot = this.zeroShotAnswers;
    const interpretation =
      this.profiles.size === 0
        ? '无跨域证据：抽象待命'
        : this.abstractSkills.length > 0
          ? `已晋升 ${this.abstractSkills.length} 个跨域宏技能（举一反三成型）`
          : this.analogyTransfers > 0
            ? `类比迁移 ${this.analogyTransfers} 次、零样本应答 ${zeroShot} 次（经验跨域流动中）`
            : `${this.profiles.size} 个域已观测，尚无同构结构相遇（相似度 < ${this.config.minSimilarity}）`;
    return {
      domains: this.profiles.size,
      structuralEdges: this.skeletonEdges.size,
      zeroShotAnswers: zeroShot,
      analogyTransfers: this.analogyTransfers,
      successorInheritances: this.successorInheritances,
      abstractSkills: this.abstractSkills.length,
      interpretation,
    };
  }

  // ─────────────────────────── R5：率失真最优粒度 / 行为等价类 / 商结构 ───────────────────────────

  /**
   * R5 审计读出：骨架级结构边的只读清单（脚本侧独立复算分层先验 /
   * 等价类 / 商结构的原料——等价性证明的对照数据源）。
   */
  structuralEdgeList(): Array<{
    domain: string;
    skeleton: string;
    action: string;
    successes: number;
    failures: number;
    /** MAP 后继状态（无后继证据时 undefined） */
    mapSuccessor: string | undefined;
  }> {
    const out: Array<{
      domain: string;
      skeleton: string;
      action: string;
      successes: number;
      failures: number;
      mapSuccessor: string | undefined;
    }> = [];
    for (const [key, edge] of this.skeletonEdges) {
      const [domain, skeleton, action] = key.split('\u0000');
      let mapSuccessor: string | undefined;
      let bestCount = 0;
      for (const [succ, count] of edge.successors) {
        if (count > bestCount) {
          bestCount = count;
          mapSuccessor = succ;
        }
      }
      out.push({ domain: domain!, skeleton: skeleton!, action: action!, successes: edge.successes, failures: edge.failures, mapSuccessor });
    }
    return out;
  }

  /** R5 审计读出：倒排索引扫描统计（新口径扫描数 vs 旧口径全表大小的证据） */
  priorScanAudit(): { lastScannedEdges: number; totalPriorQueries: number; totalScannedEdges: number; totalEdges: number } {
    return {
      lastScannedEdges: this.lastScannedEdges,
      totalPriorQueries: this.totalPriorQueries,
      totalScannedEdges: this.totalScannedEdges,
      totalEdges: this.skeletonEdges.size,
    };
  }

  /**
   * R5·A1 率失真最优粒度：K 级抽象的完整 R-D 前沿 + 肘点粒度。
   *
   * 信源 = 全部骨架级结构边的后验均值 p̂ᵢ = (1+sᵢ)/(2+nᵢ)，权重
   * wᵢ = 2+nᵢ（后验集中度）。加权 MSE 下 K 级最优标量量化 = 排序后的
   * 连续段划分（1-D Lloyd 条件），DP 全局最优：
   *   dp[j][k] = min_{i<j} dp[i][k−1] + SSE(i..j)
   * 组内 SSE 由前缀和 O(1) 给出：SSE = Σw·p̂² − (Σw·p̂)²/Σw。
   * 率 R(K) = 分组指派熵 H(组质量)（bit/边）。D(K) 关于 K 单调不增
   * （划分 refinements 性质）；肘点 = 边际下降首次 ≤ relativeDrop 的 K。
   */
  rateDistortionFrontier(opts?: {
    maxLevels?: number;
    /** 肘点判据：D(K−1)−D(K) ≤ relativeDrop·D(K−1) 的首个 K */
    relativeDrop?: number;
  }): RateDistortionReport {
    const maxLevels = Math.max(1, Math.min(opts?.maxLevels ?? 16, 64));
    const relativeDrop = Math.min(1, Math.max(0, opts?.relativeDrop ?? 0.05));
    // 信源：精确去重（相同均值合并权重——量化结果不变，DP 规模收缩）
    const items: Array<{ mean: number; weight: number }> = [];
    const byMean = new Map<string, { mean: number; weight: number }>();
    for (const [, edge] of this.skeletonEdges) {
      const n = edge.successes + edge.failures;
      const mean = (1 + edge.successes) / (2 + n);
      const weight = 2 + n;
      const key = mean.toFixed(12);
      const slot = byMean.get(key);
      if (slot) slot.weight += weight;
      else byMean.set(key, { mean, weight });
    }
    for (const slot of byMean.values()) items.push(slot);
    if (items.length === 0) {
      return { points: [], optimalLevels: 0, elbow: { levels: 0, marginalDrop: 0 }, monotone: true, sourceEdges: 0, distinctMeans: 0 };
    }
    items.sort((a, b) => a.mean - b.mean);
    const n = items.length;
    const K = Math.min(maxLevels, n);
    // 前缀和
    const W = new Array<number>(n + 1).fill(0);
    const S = new Array<number>(n + 1).fill(0);
    const Q = new Array<number>(n + 1).fill(0);
    for (let i = 0; i < n; i += 1) {
      const it = items[i]!;
      W[i + 1] = W[i]! + it.weight;
      S[i + 1] = S[i]! + it.weight * it.mean;
      Q[i + 1] = Q[i]! + it.weight * it.mean * it.mean;
    }
    const sse = (i: number, j: number): number => {
      // 段 [i, j)（0 起，左闭右开）的加权 SSE
      const w = W[j]! - W[i]!;
      const s = S[j]! - S[i]!;
      const q = Q[j]! - Q[i]!;
      return Math.max(0, q - (s * s) / w);
    };
    // dp[k][j]：前 j 项分 k 组的最小总畸变（滚动数组）
    const INF = Number.POSITIVE_INFINITY;
    let dp = new Array<number>(n + 1).fill(INF);
    dp[0] = 0;
    const distortions: number[] = [];
    const rates: number[] = [];
    const partitions: number[][] = [];
    for (let k = 1; k <= K; k += 1) {
      const next = new Array<number>(n + 1).fill(INF);
      const arg = new Array<number>(n + 1).fill(-1);
      next[0] = 0;
      for (let j = 1; j <= n; j += 1) {
        let best = INF;
        let bestI = -1;
        for (let i = k - 1; i < j; i += 1) {
          const prev = dp[i]!;
          if (prev === INF) continue;
          const v = prev + sse(i, j);
          if (v < best) {
            best = v;
            bestI = i;
          }
        }
        next[j] = best;
        arg[j] = bestI;
      }
      dp = next;
      // 回溯分组（组界）
      const bounds: number[] = [];
      let cur = n;
      for (let kk = k; kk >= 1; kk -= 1) {
        bounds.unshift(cur);
        cur = arg[cur] ?? 0;
      }
      bounds.unshift(0);
      partitions.push(bounds);
      const totalW = W[n]!;
      distortions.push(round(dp[n]! / totalW)); // 归一化加权 MSE
      // 指派熵率 H(组质量)
      let h = 0;
      for (let g = 1; g < bounds.length; g += 1) {
        const wg = W[bounds[g]!]! - W[bounds[g - 1]!]!;
        const p = wg / totalW;
        if (p > 0) h -= p * Math.log2(p);
      }
      rates.push(round(h));
    }
    const points: RateDistortionPoint[] = distortions.map((d, idx) => ({
      levels: idx + 1,
      distortion: d,
      rateBits: rates[idx]!,
    }));
    // 单调性（划分加细 ⟹ 畸变不增——DP 最优值的必要性质）
    let monotone = true;
    for (let i = 1; i < distortions.length; i += 1) {
      if (distortions[i]! > distortions[i - 1]! + 1e-12) monotone = false;
    }
    // 肘点：边际下降首次 ≤ relativeDrop·D(K−1)
    let elbowLevels = 1;
    let elbowDrop = 0;
    for (let i = 1; i < distortions.length; i += 1) {
      const prev = distortions[i - 1]!;
      const drop = prev - distortions[i]!;
      if (drop <= relativeDrop * prev) {
        elbowLevels = i; // i 组已够（第 i+1 级的边际收益过低）
        elbowDrop = round(drop);
        break;
      }
      elbowLevels = i + 1;
    }
    return {
      points,
      optimalLevels: elbowLevels,
      elbow: { levels: elbowLevels, marginalDrop: elbowDrop },
      monotone,
      sourceEdges: this.skeletonEdges.size,
      distinctMeans: n,
    };
  }

  /**
   * R5·A2 行为等价类（并查集）：
   * 同 MAP 后继骨架 且 后验均值差 ≤ tolerance 的传递闭包等价类。
   *
   * 实现：先按后继骨架分桶（关系的前置条件），桶内按均值排序后相邻
   * 差 ≤ tol 即 union——区间关系的传递闭包 = 排序扫描的相邻并集，
   * 并查集路径压缩近 O(nα)；与 O(n²) 逐对建图 + BFS 闭包的暴力口径
   * 等价（verify 脚本 ≥200 种子对照）。
   */
  behaviorEquivalenceClasses(tolerance = 0.1): EquivalenceClassReport {
    if (!Number.isFinite(tolerance) || tolerance < 0) {
      throw new Error(`behaviorEquivalenceClasses: tolerance 须为 ≥0 有限数（收到 ${tolerance}）`);
    }
    const edges = this.structuralEdgeList().map((e) => ({
      key: `${e.domain}#${e.skeleton}|${e.action}`,
      domain: e.domain,
      skeleton: e.skeleton,
      action: e.action,
      mean: (1 + e.successes) / (2 + e.successes + e.failures),
      evidence: e.successes + e.failures,
      successorSkeleton: e.mapSuccessor !== undefined ? decompose(e.mapSuccessor).skeleton : '',
    }));
    if (edges.length === 0) {
      return { tolerance, classes: [], unions: 0, totalEdges: 0 };
    }
    // 后继骨架分桶
    const buckets = new Map<string, typeof edges>();
    for (const e of edges) {
      const list = buckets.get(e.successorSkeleton);
      if (list) list.push(e);
      else buckets.set(e.successorSkeleton, [e]);
    }
    // 并查集
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root)!;
      // 路径压缩
      let cur = x;
      while (parent.get(cur) !== root) {
        const next = parent.get(cur)!;
        parent.set(cur, root);
        cur = next;
      }
      return root;
    };
    for (const e of edges) parent.set(e.key, e.key);
    let unions = 0;
    for (const [, list] of buckets) {
      list.sort((a, b) => a.mean - b.mean || (a.key < b.key ? -1 : 1));
      for (let i = 1; i < list.length; i += 1) {
        if (Math.abs(list[i]!.mean - list[i - 1]!.mean) <= tolerance + 1e-15) {
          const ra = find(list[i - 1]!.key);
          const rb = find(list[i]!.key);
          if (ra !== rb) {
            // 按字典序合并根（确定性）
            const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
            parent.set(drop, keep);
            unions += 1;
          }
        }
      }
    }
    // 汇类
    const classMap = new Map<string, Array<(typeof edges)[number]>>();
    for (const e of edges) {
      const root = find(e.key);
      const list = classMap.get(root);
      if (list) list.push(e);
      else classMap.set(root, [e]);
    }
    const classes = [...classMap.values()].map((members) => {
      const means = members.map((m) => m.mean);
      return {
        size: members.length,
        meanRange: round(Math.max(...means) - Math.min(...means)),
        totalEvidence: members.reduce((s, m) => s + m.evidence, 0),
        members: members.map((m) => m.key).sort(),
      };
    });
    classes.sort((a, b) => b.size - a.size || (a.members[0]! < b.members[0]! ? -1 : 1));
    return { tolerance, classes, unions, totalEdges: edges.length };
  }

  /**
   * R5·A4 商结构：骨架商转移系统（quotient system）。
   *
   * 把全部域投影到骨架（projectToSkeleton），按 (骨架, 行动) 池化：
   *   p̂ = (1+Σ成功)/(2+Σ证据)，to = 模态后继骨架（平票取首遇——
   *   插入序确定），无后继证据时 to = from。
   * 状态集 = 投影的像；边端点封闭于状态集（商结构一致性）。
   */
  quotientSystem(): QuotientSystem {
    const edges = this.structuralEdgeList();
    const pooled = new Map<string, { skeleton: string; action: string; successes: number; failures: number; succCounts: Map<string, number> }>();
    for (const e of edges) {
      const key = `${e.skeleton}\u0000${e.action}`;
      let slot = pooled.get(key);
      if (!slot) {
        slot = { skeleton: e.skeleton, action: e.action, successes: 0, failures: 0, succCounts: new Map() };
        pooled.set(key, slot);
      }
      slot.successes += e.successes;
      slot.failures += e.failures;
      if (e.mapSuccessor !== undefined) {
        const sk = decompose(e.mapSuccessor).skeleton;
        slot.succCounts.set(sk, (slot.succCounts.get(sk) ?? 0) + 1);
      }
    }
    const states = new Set<string>();
    for (const e of edges) {
      states.add(projectToSkeleton(`${e.domain}#${e.skeleton}`));
      if (e.mapSuccessor !== undefined && decompose(e.mapSuccessor).hasSkeleton) {
        states.add(projectToSkeleton(e.mapSuccessor));
      }
    }
    const quotientEdges: QuotientEdge[] = [];
    for (const slot of pooled.values()) {
      let to = slot.skeleton;
      let best = 0;
      for (const [sk, count] of slot.succCounts) {
        if (count > best) {
          best = count;
          to = sk;
        }
      }
      states.add(projectToSkeleton(`#${slot.skeleton}`));
      states.add(projectToSkeleton(`#${to}`));
      quotientEdges.push({
        from: projectToSkeleton(`#${slot.skeleton}`),
        action: slot.action,
        to: projectToSkeleton(`#${to}`),
        pSuccess: round((1 + slot.successes) / (2 + slot.successes + slot.failures)),
        evidence: slot.successes + slot.failures,
        domains: 0,
      });
    }
    // 域计数（池化证据来自几个域——跨域复验度）
    const domainCount = new Map<string, Set<string>>();
    for (const e of edges) {
      const key = `${e.skeleton}\u0000${e.action}`;
      const set = domainCount.get(key) ?? new Set<string>();
      set.add(e.domain);
      domainCount.set(key, set);
    }
    for (const edge of quotientEdges) {
      const skeleton = edge.from.slice(1); // from = `#${skeleton}`
      edge.domains = domainCount.get(`${skeleton}\u0000${edge.action}`)?.size ?? 0;
    }
    return { states: [...states].sort(), edges: quotientEdges.sort((a, b) => (a.from + a.action < b.from + b.action ? -1 : 1)) };
  }

  // ─────────────────────────── 序列化 ───────────────────────────

  serialize(): {
    skeletonEdges: Array<{ domain: string; skeleton: string; action: string; successes: number; failures: number; successors: Array<[string, number]> }>;
    domainAction: Array<{ domain: string; action: string; successes: number; failures: number }>;
    globalSkeleton: Array<{ skeleton: string; action: string; successes: number; failures: number }>;
    abstractSkills: AbstractSkillEntry[];
    counters: { zeroShotAnswers: number; analogyTransfers: number; successorInheritances: number };
  } {
    const skeletonEdges: Array<{ domain: string; skeleton: string; action: string; successes: number; failures: number; successors: Array<[string, number]> }> = [];
    for (const [key, edge] of this.skeletonEdges) {
      const [domain, skeleton, action] = key.split('\u0000');
      skeletonEdges.push({ domain: domain!, skeleton: skeleton!, action: action!, successes: edge.successes, failures: edge.failures, successors: [...edge.successors] });
    }
    const domainAction = [...this.domainAction].map(([key, v]) => {
      const [domain, action] = key.split('\u0000');
      return { domain: domain!, action: action!, successes: v.successes, failures: v.failures };
    });
    const globalSkeleton = [...this.globalSkeleton].map(([key, v]) => {
      const [skeleton, action] = key.split('\u0000');
      return { skeleton: skeleton!, action: action!, successes: v.successes, failures: v.failures };
    });
    return {
      skeletonEdges,
      domainAction,
      globalSkeleton,
      abstractSkills: [...this.abstractSkills],
      counters: { zeroShotAnswers: this.zeroShotAnswers, analogyTransfers: this.analogyTransfers, successorInheritances: this.successorInheritances },
    };
  }

  deserialize(data: ReturnType<AbstractionEngine['serialize']>): void {
    this.skeletonEdges.clear();
    this.skeletonIndex.clear();
    this.lastScannedEdges = 0;
    this.totalPriorQueries = 0;
    this.totalScannedEdges = 0;
    this.domainAction.clear();
    this.globalSkeleton.clear();
    this.profiles.clear();
    this.skillLadder.clear();
    this.abstractSkills = [];
    for (const e of data.skeletonEdges) {
      const edge: EdgeCounts = { successes: e.successes, failures: e.failures, successors: new Map(e.successors) };
      this.skeletonEdges.set(skKey(e.domain, e.skeleton, e.action), edge);
      // R5：倒排索引随反序列化重建（插入序保持）
      const ik = idxKey(e.skeleton, e.action);
      const list = this.skeletonIndex.get(ik);
      if (list) list.push({ domain: e.domain, edge });
      else this.skeletonIndex.set(ik, [{ domain: e.domain, edge }]);
      const profile = this.profiles.get(e.domain) ?? new Set<string>();
      profile.add(`${e.skeleton}|${e.action}`);
      this.profiles.set(e.domain, profile);
    }
    for (const d of data.domainAction) this.domainAction.set(domKey(d.domain, d.action), { successes: d.successes, failures: d.failures });
    for (const g of data.globalSkeleton) this.globalSkeleton.set(globKey(g.skeleton, g.action), { successes: g.successes, failures: g.failures });
    this.abstractSkills = [...data.abstractSkills];
    this.skillCounter = this.abstractSkills.length;
    const c = data.counters;
    this.zeroShotAnswers = c?.zeroShotAnswers ?? 0;
    this.analogyTransfers = c?.analogyTransfers ?? 0;
    this.successorInheritances = c?.successorInheritances ?? 0;
    // 技能阶梯重建（后续晋升判定用）
    for (const s of this.abstractSkills) {
      this.skillLadder.set(`${s.skeleton}||${s.actions.join('|')}`, {
        skeleton: s.skeleton,
        actions: [...s.actions],
        domains: new Set(this.domains()),
        successes: s.successes,
      });
    }
  }
}

// ─────────────────────────── 工具 ───────────────────────────

/**
 * 状态分解：`${domain}#${skeleton...}`（'#' 后全部视为骨架，支持多段）。
 * 无 '#' 时骨架为空串（单段状态——相似度闸门防误迁移）。
 */
export function decompose(state: string): { domain: string; skeleton: string; hasSkeleton: boolean } {
  const idx = state.indexOf('#');
  if (idx < 0) return { domain: state, skeleton: '', hasSkeleton: false };
  return { domain: state.slice(0, idx), skeleton: state.slice(idx + 1), hasSkeleton: true };
}

/**
 * R5·A4 骨架投影（幂等）：`domain#skeleton → '#skeleton'`，无 '#' 的
 * 单段状态 → '#'。保关系、换对象——抽象的代数定义即此投影。
 * 幂等性：projectToSkeleton(projectToSkeleton(x)) === projectToSkeleton(x)
 * 对一切 x 成立（'#s' 的 domain 为空串、骨架不变 → 再投影原样返回）。
 */
export function projectToSkeleton(state: string): string {
  const idx = state.indexOf('#');
  if (idx < 0) return '#';
  return `#${state.slice(idx + 1)}`;
}

function round(x: number): number {
  return Number(x.toFixed(6));
}
