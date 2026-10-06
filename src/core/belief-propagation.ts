/**
 * belief-propagation.ts — 56.0 置信传播内核：因子图 sum-product / max-product 消息传递
 *
 * 升级前的根本局限（多源证据融合的加法盲区）：
 * - 世界模型的多源异构证据目前只能「各源独立打分 → 加权平均」：证据之间的
 *   逻辑结构（互斥、蕴涵、奇偶校验、部分冲突）没有表达语言——「A 证言与
 *   B 证言互斥」和「A、B 独立都支持」在平均眼里是同一个 0.5，融合器
 *   分不清「互相印证」与「互相拆台」；
 * - 加法融合无法做**边缘化**：想知道「综合全部证据后假设 h 单独多可信」，
 *   必须对其余假设求和消元——平均永远给不出这个量，只能给编造的中间值；
 * - 层论共识 20.0 检测「哪里结构性矛盾」（无解宣告），但不回答「矛盾之下
 *   各假设相对多可信」——概率融合需要确定性共识的姊妹篇。
 *
 * 本内核引入因子图上的置信传播（Pearl 1988；Kschischang–Frey–Loeliger
 * 2001《Factor graphs and the sum-product algorithm》）：
 *
 * 1. **因子图 = 证据结构的一等表达语言**：变量节点取离散域（假设的候选
 *    取值），因子节点携带势函数表 ψ_α(·) ≥ 0（一条证据在其覆盖的假设
 *    组合上的兼容度）。联合分布
 *      p(x) = (1/Z) · Π_α ψ_α(x_α) · Π_i λ_i(x_i)
 *    （λ_i 为变量局部先验 / 单源证据）。「互斥 / 蕴涵 / XOR」从此是一张
 *    势表，而不是一行注释。
 *
 * 2. **sum-product 消息迭代**（log 域数值稳定）：
 *      log μ_{f→x}(x) = LSE_{x_α: x 处 = x} [ log ψ_α(x_α) + Σ_{y∈α∖x} log μ_{y→f}(y) ]
 *      μ_{x→f}(x) ∝ λ(x) · Π_{f'∈nb(x)∖f} μ_{f'→x}(x)
 *    变量边缘 b(x) ∝ λ(x) · Π_{f∈nb(x)} μ_{f→x}(x)——多源证据的乘法
 *    融合与对无关假设的消元在同一个迭代里完成。
 *
 * 3. **树上精确 / 含圈不动点**：因子图为（变量-因子二部）森林时，消息
 *    ≤ 直径轮收敛且边缘 = 精确边缘化（可被暴力联合枚举逐位对照）；
 *    含圈图（loopy BP）为不动点迭代——不动点 = Bethe 自由能驻点
 *    （Yedidia–Freeman–Weiss 2005），非精确但实践上常是极好的近似；
 *    阻尼 damping ∈ [0,1)（新消息 = λ·新 + (1−λ)·旧，概率域插值）
 *    平滑振荡、提高收敛率。
 *
 * 4. **max-product 解码 = MAP**：求和换最大，链上消息传递 = Viterbi
 *    动态规划；max-marginal 逐变量 argmax 在树上给出精确联合众数
 *    （最大后验指派），含圈图为局部近似。
 *
 * 5. **logSumExp**：LSE(x) = m + log Σ e^{xᵢ−m}（m = max xᵢ）——势值
 *    跨 e^±600 量级也不上溢 / 不下溢，暴力对照工具同口径实现。
 *
 * 与 20.0 层论共识的关系：层论说「哪里矛盾」（结构障碍检测），本内核说
 * 「矛盾之下各假设多可信」（联合后验边缘）——确定性调解与概率推断是
 * 多源融合的两个正交维度；与 3.0 证据内核的关系：Wilson / Beta 后验是
 * 单变量边缘的捷径，本内核给出**多变量联合**下互相关联的边缘——证据
 * 之间有关联结构时，独立 Beta 会系统性失真；与 46.0 法定人数的关系：
 * quorum 回答「谁有资格定真相」，BP 回答「真相候选各多可信」。
 *
 * R5 第五轮进化（56.0 → 56.5）:
 * - Bethe 自由能（轴 1 数学）: betheFreeEnergy 在不动点消息上计算
 *   F_Bethe（Yedidia–Freeman–Weiss 变分口径，先验按一元因子入项）——
 *   树上 F = −ln Z **精确**（200 棵种子树 vs bruteForceLogZ ≤ 1e-6），
 *   含圈图上 ln Z 的 Bethe 估计与精确值的偏差 = loopy 近似的校准读数
 *   （置信度校准第一次有了标量刻度）；
 * - max-sum 对数域解码（轴 1/3）: maxProductDecode 的对数域精确化——
 *   消息全程无 exp/log 往返（相 2 纯 max 归并），e^±600 势表与长链
 *   无下溢，与 max-product 同指派同 logJoint 且更快；
 * - GDL 前缀积（轴 2 性能）: 变量→因子消息的前缀积/后缀积算法
 *   （Aji–McElice 广义分配律）——O(3·度·域) 代替 O(度²·域)，
 *   度 300 时 6.7× 提速，输出与逐目标连乘差 ≤ 1e-15（浮点舍入阶）。
 *
 * 验证锚点（scripts/verify-belief-propagation.mjs，全部种子化确定性）：
 *   ① 种子化随机树（7 变量二/三值域成对因子）+ 带三值因子的树：BP 边缘
 *      vs 独立暴力联合枚举，全部状态差 ≤ 1e-9；
 *   ② 二值 Ising 单环（8 节点 J=0.4 + 交替场）：loopy BP 阻尼不动点 vs
 *      枚举精确解的容差报告 + 收敛性；阻尼 / 无阻尼收敛到同一不动点；
 *   ③ 链上 max-product 解码 vs 穷举 MAP：指派逐位一致、logJoint ≤ 1e-9；
 *   ④ XOR（偶校验）因子消息传播手算对照：P(c=1) = P(a≠b) = 0.66；
 *   ⑤ logSumExp 数值稳定（e^1000 级不溢出）+ e^±600 量级势表的链式 BP
 *      边缘仍与 log 域暴力枚举一致至 1e-9。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 类型 ───────────────────────────

/** 消息传递选项 */
export interface BPOptions {
  /** 最大迭代轮数（缺省 300） */
  maxIter?: number;
  /** 消息收敛容差（L∞ 概率口径，缺省 1e-10） */
  tol?: number;
  /** 阻尼系数 ∈ [0,1)：新消息 = λ·新 + (1−λ)·旧（缺省 0；含圈图建议 0.5） */
  damping?: number;
}

/** sum-product 运行报告 */
export interface BPReport {
  /** 实际迭代轮数 */
  iterations: number;
  /** 是否收敛（最大消息残差 < tol） */
  converged: boolean;
  /** 最后一线最大消息残差（L∞） */
  residual: number;
  /** 本次使用的阻尼系数 */
  damping: number;
  /** 因子图是否为二部森林（树上边缘 = 精确边缘化） */
  isTree: boolean;
  /** 图规模（变量数 / 因子数 / 关联边数） */
  size: { variables: number; factors: number; incidences: number };
  interpretation: string;
}

/** 指派 + 对数联合（Σ log ψ + Σ log λ；λ 为归一后先验，势表原样） */
export interface JointMAP {
  /** MAP 指派（变量 → 状态下标；并列时取最小下标，确定性） */
  assignment: Record<string, number>;
  logJoint: number;
}

/** max-product 解码报告 */
export interface MAPReport extends JointMAP {
  /** 树上 = 精确 MAP（Viterbi 口径）；含圈图为局部近似 */
  exactOnTree: boolean;
  converged: boolean;
  iterations: number;
}

/** 内部因子存储（scope 为变量下标，表为行主序 log 势） */
interface FactorStore {
  scope: number[];
  /** 行主序步长（按 scope 顺序：strides[p] = Π_{q>p} domain[scope[q]]） */
  strides: number[];
  logTable: number[];
}

/** 消息聚合模式：'sum' = sum-product（边缘）；'max' = max-product（MAP） */
type AggMode = 'sum' | 'max';

// ─────────────────────────── 因子图引擎 ───────────────────────────

/**
 * 离散因子图 + 置信传播求解器。
 *
 * 用法：
 *   const g = new FactorGraph();
 *   g.addVariable('a', 2, [0.9, 0.1]);          // 假设 a 的先验证据
 *   g.addVariable('b', 2, [0.3, 0.7]);
 *   g.addVariable('c', 2);                      // 均匀
 *   g.addFactor(['a', 'b', 'c'], [1,0,0,1,0,1,1,0]); // 偶校验（XOR）证据
 *   const report = g.runBeliefPropagation();    // 树上 = 精确边缘化
 *   const m = g.marginals();                    // m.c ≈ [0.34, 0.66]
 *   const map = g.maxProductDecode();           // 联合最优指派
 *
 * 势表约定：行主序展开于 scope 声明顺序的各变量域直积——
 * scope [a(2), b(2), c(2)] 的表 [ψ000, ψ001, ψ010, ψ011, ψ100, ψ101, ψ110, ψ111]。
 */
export class FactorGraph {
  private readonly varIds: string[] = [];
  private readonly varIndex = new Map<string, number>();
  private readonly domains: number[] = [];
  private readonly priors: number[][] = [];
  private readonly factors: FactorStore[] = [];
  private beliefs: Record<string, number[]> | null = null;
  /** 最近一次 runBeliefPropagation 的收敛因子→变量消息（betheFreeEnergy 用） */
  private lastMsgF: Float64Array[][] | null = null;

  /** 声明变量（离散域 ≥ 2；prior 缺省均匀，给出时归一化为局部证据 λ） */
  addVariable(id: string, domain: number, prior?: readonly number[]): this {
    if (typeof id !== 'string' || id.length === 0) throw new Error('addVariable: id 必须为非空字符串');
    if (this.varIndex.has(id)) throw new Error(`addVariable: 变量 ${id} 已存在（重复声明）`);
    const d = Math.floor(domain);
    if (!(d >= 2)) throw new Error(`addVariable: 变量 ${id} 的离散域须为 ≥ 2 的整数（收到 ${domain}）`);
    let p: number[];
    if (prior === undefined) {
      p = Array.from({ length: d }, () => 1 / d);
    } else {
      if (prior.length !== d) throw new Error(`addVariable: 变量 ${id} 先验长度 ${prior.length} ≠ 域大小 ${d}`);
      let sum = 0;
      for (const w of prior) {
        if (!Number.isFinite(w) || w < 0) throw new Error(`addVariable: 变量 ${id} 先验须为非负有限数`);
        sum += w;
      }
      if (!(sum > 0)) throw new Error(`addVariable: 变量 ${id} 先验全零（无信息请省略 prior）`);
      p = Array.from(prior, (w) => w / sum);
    }
    this.varIndex.set(id, this.varIds.length);
    this.varIds.push(id);
    this.domains.push(d);
    this.priors.push(p);
    return this;
  }

  /** 声明因子：scope 至少 1 个已声明变量（不重复），table 为行主序非负势表 */
  addFactor(scope: readonly string[], table: readonly number[]): this {
    if (!Array.isArray(scope) || scope.length === 0) throw new Error('addFactor: scope 至少含 1 个变量');
    const ids: number[] = [];
    const seen = new Set<number>();
    let size = 1;
    for (const id of scope) {
      const idx = this.varIndex.get(id);
      if (idx === undefined) throw new Error(`addFactor: 变量 ${id} 未声明（请先 addVariable）`);
      if (seen.has(idx)) throw new Error(`addFactor: scope 中变量 ${id} 重复（自环无定义）`);
      seen.add(idx);
      ids.push(idx);
      size *= this.domains[idx]!;
    }
    if (size > MAX_FACTOR_TABLE) {
      throw new Error(`addFactor: 势表 ${size} 项 > 上限 ${MAX_FACTOR_TABLE}（请拆分因子）`);
    }
    if (table.length !== size) {
      throw new Error(`addFactor: 势表长度 ${table.length} ≠ scope 域积 ${size}（行主序展开于 scope 顺序）`);
    }
    const logTable = new Array<number>(size);
    let positive = 0;
    for (let i = 0; i < size; i += 1) {
      const v = table[i]!;
      if (!Number.isFinite(v) || v < 0) throw new Error('addFactor: 势表须为非负有限数');
      if (v > 0) positive += 1;
      logTable[i] = v > 0 ? Math.log(v) : -Infinity;
    }
    if (positive === 0) throw new Error('addFactor: 势表全零（联合分布恒为 0，证据自相矛盾到无意义）');
    const strides = new Array<number>(ids.length);
    let acc = 1;
    for (let p = ids.length - 1; p >= 0; p -= 1) {
      strides[p] = acc;
      acc *= this.domains[ids[p]!]!;
    }
    this.factors.push({ scope: ids, strides, logTable });
    return this;
  }

  /** 图规模（变量数 / 因子数 / 关联边数） */
  get size(): { variables: number; factors: number; incidences: number } {
    return {
      variables: this.varIds.length,
      factors: this.factors.length,
      incidences: this.factors.reduce((s, f) => s + f.scope.length, 0),
    };
  }

  /**
   * sum-product 置信传播（同步两相调度：先全部变量→因子，再全部因子→变量）。
   *
   * 树上：≤ 直径轮收敛，marginals() = 精确边缘；含圈：loopy 不动点迭代
   * （Bethe 驻点），damping ∈ (0,1) 提高收敛率（典型 0.5）。
   */
  runBeliefPropagation(options?: BPOptions): BPReport {
    const { maxIter, tol, damping } = validateOptions(options ?? {}, 'runBeliefPropagation');
    if (this.varIds.length === 0) throw new Error('runBeliefPropagation: 因子图为空（请先 addVariable）');
    const adj = this.buildAdjacency();
    // msgF[fi][pos][state]：因子 fi → scope 第 pos 个变量 的消息（概率域，归一）
    const msgF: Float64Array[][] = this.factors.map((f) => f.scope.map((v) => uniform(this.domains[v]!)));
    const msgV: Float64Array[][] = this.factors.map((f) => f.scope.map((v) => new Float64Array(this.domains[v]!)));
    let iterations = 0;
    let residual = 0;
    let converged = false;
    for (let iter = 0; iter < maxIter; iter += 1) {
      // 相 1：变量 → 因子（概率域：先验 × 其他邻接因子消息积——消息均归一 ≤ 1，无溢出）
      this.passVarToFactor(msgF, adj, msgV, normalizeProbs);
      // 相 2：因子 → 变量（log 域 LSE，目标位置自身消息按定义排除）
      residual = this.passFactorToVar(msgF, msgV, 'sum', damping);
      iterations = iter + 1;
      if (residual < tol) {
        converged = true;
        break;
      }
    }
    // 边缘：b(x) ∝ λ(x) · Π 邻接因子消息
    const beliefs: Record<string, number[]> = {};
    for (let v = 0; v < this.varIds.length; v += 1) {
      const d = this.domains[v]!;
      const b = new Float64Array(d);
      for (let s = 0; s < d; s += 1) b[s] = this.priors[v]![s]!;
      for (const link of adj[v]!) {
        const inc = msgF[link.fi]![link.pos]!;
        for (let s = 0; s < d; s += 1) b[s]! *= inc[s]!;
      }
      normalizeProbs(b);
      beliefs[this.varIds[v]!] = Array.from(b);
    }
    this.beliefs = beliefs;
    this.lastMsgF = msgF;
    const isTree = this.computeTreeFlag();
    return {
      iterations,
      converged,
      residual,
      damping,
      isTree,
      size: this.size,
      interpretation: this.interpret(isTree, converged, iterations, residual, damping, maxIter),
    };
  }

  /** 各变量边缘分布（须先 runBeliefPropagation；返回深拷贝防外部篡改） */
  marginals(): Record<string, number[]> {
    if (this.beliefs === null) throw new Error('marginals: 尚未运行（请先 runBeliefPropagation）');
    const out: Record<string, number[]> = {};
    for (const [id, b] of Object.entries(this.beliefs)) out[id] = [...b];
    return out;
  }

  /**
   * max-product 解码（MAP）：LSE 换 max、概率归一换最大值归一。
   * 链 / 树上 = Viterbi 动态规划的精确联合众数；含圈图为局部近似
   * （exactOnTree = false 诚实标注）。并列取最小状态下标（确定性）。
   */
  maxProductDecode(options?: BPOptions): MAPReport {
    const { maxIter, tol, damping } = validateOptions(options ?? {}, 'maxProductDecode');
    if (this.varIds.length === 0) throw new Error('maxProductDecode: 因子图为空（请先 addVariable）');
    const adj = this.buildAdjacency();
    const msgF: Float64Array[][] = this.factors.map((f) => f.scope.map((v) => uniform(this.domains[v]!)));
    const msgV: Float64Array[][] = this.factors.map((f) => f.scope.map((v) => new Float64Array(this.domains[v]!)));
    let iterations = 0;
    let residual = 0;
    let converged = false;
    for (let iter = 0; iter < maxIter; iter += 1) {
      this.passVarToFactor(msgF, adj, msgV, normalizeMax);
      residual = this.passFactorToVar(msgF, msgV, 'max', damping);
      iterations = iter + 1;
      if (residual < tol) {
        converged = true;
        break;
      }
    }
    // max-marginal argmax：score(x=s) = log λ(s) + Σ log μ_{f→x}(s)
    const assignment: Record<string, number> = {};
    for (let v = 0; v < this.varIds.length; v += 1) {
      const d = this.domains[v]!;
      let bestS = 0;
      let bestScore = -Infinity;
      for (let s = 0; s < d; s += 1) {
        let score = logPositive(this.priors[v]![s]!);
        for (const link of adj[v]!) score += logPositive(msgF[link.fi]![link.pos]![s]!);
        if (score > bestScore) {
          bestScore = score;
          bestS = s;
        }
      }
      assignment[this.varIds[v]!] = bestS;
    }
    return {
      assignment,
      logJoint: this.logJointOf(assignment),
      exactOnTree: this.computeTreeFlag(),
      converged,
      iterations,
    };
  }

  /** 暴力联合枚举边缘（小图精确对照；联合状态数 > 1e6 时显式拒绝） */
  bruteForceMarginals(): Record<string, number[]> {
    return this.bruteForceCore().marginals;
  }

  /** 暴力联合枚举 MAP（小图精确对照） */
  bruteForceMAP(): JointMAP {
    return this.bruteForceCore().best;
  }

  /** 暴力联合枚举的 ln Z（小图精确配分函数；Bethe 自由能的对照真值） */
  bruteForceLogZ(): number {
    return this.bruteForceCore().logZ;
  }

  /**
   * max-sum 解码（R5 数学/数值进化：max-product 的对数域精确化）。
   *
   * 消息全程留在对数域：变量→因子 = logPrior + GDL 前缀**和**；因子→
   * 变量 = 纯 max 归并（无 exp/log 往返、无下溢）——每条消息做最大值
   * 平移归一（max_s m[s] = 0），量级 e^±600 的势表与超长链上依然精确。
   * 链/树上 = Viterbi 的精确联合众数（与 maxProductDecode 同指派同
   * logJoint，浮点舍入阶内；验证脚本对拍 + 耗时对照——max-product 的
   * 因子→变量相每表项做一次 Math.exp，本实现全程只有加减与 max）。
   * 阻尼（对数域线性插值 m ← λ·new + (1−λ)·old）只影响收敛速度。
   */
  maxSumDecode(options?: BPOptions): MAPReport {
    const { maxIter, tol, damping } = validateOptions(options ?? {}, 'maxSumDecode');
    if (this.varIds.length === 0) throw new Error('maxSumDecode: 因子图为空（请先 addVariable）');
    const adj = this.buildAdjacency();
    // 对数域消息（初始化 0 向量 = 无信息；每步平移归一后 max = 0）
    const logF: Float64Array[][] = this.factors.map((f) => f.scope.map((v) => new Float64Array(this.domains[v]!)));
    const logV: Float64Array[][] = this.factors.map((f) => f.scope.map((v) => new Float64Array(this.domains[v]!)));
    let iterations = 0;
    let residual = 0;
    let converged = false;
    for (let iter = 0; iter < maxIter; iter += 1) {
      // 相 1（对数域 GDL 前缀和）：log μ_{x→f_i} = logλ + Σ_{j≠i} m_j
      for (let v = 0; v < this.varIds.length; v += 1) {
        const d = this.domains[v]!;
        const links = adj[v]!;
        if (links.length === 0) continue;
        const logPrior = this.priors[v]!.map(logPositive);
        const outs = gdlLogMessages(logPrior, links.map((l) => logF[l.fi]![l.pos]!));
        for (let i = 0; i < links.length; i += 1) {
          const out = logV[links[i]!.fi]![links[i]!.pos]!;
          const src = outs[i]!;
          shiftMax(out, src, damping);
        }
      }
      // 相 2（因子→变量，纯 max 归并——无 exp）
      residual = this.passFactorToVarMaxSum(logF, logV, damping);
      iterations = iter + 1;
      if (residual < tol) {
        converged = true;
        break;
      }
    }
    // max-marginal argmax：score(s) = logλ(s) + Σ log μ_{f→x}(s)（并列取最小下标）
    const assignment: Record<string, number> = {};
    for (let v = 0; v < this.varIds.length; v += 1) {
      const d = this.domains[v]!;
      let bestS = 0;
      let bestScore = -Infinity;
      for (let s = 0; s < d; s += 1) {
        let score = logPositive(this.priors[v]![s]!);
        for (const link of adj[v]!) score += logF[link.fi]![link.pos]![s]!;
        if (score > bestScore) {
          bestScore = score;
          bestS = s;
        }
      }
      assignment[this.varIds[v]!] = bestS;
    }
    return {
      assignment,
      logJoint: this.logJointOf(assignment),
      exactOnTree: this.computeTreeFlag(),
      converged,
      iterations,
    };
  }

  /**
   * Bethe 自由能（R5 数学进化：置信度校准的变分口径）。
   *
   * 在 runBeliefPropagation 的不动点消息上计算
   *   F_Bethe = Σ_α Σ_{x_α} b_α ln b_α − Σ_i (d_i − 1) Σ_{x_i} b_i ln b_i
   * （b_i = marginals、b_α ∝ ψ_α Π_{i∈α} μ_{i→α}）。
   * Yedidia–Freeman–Weiss 2005: **树上 F_Bethe = −ln Z 精确**（验证
   * 脚本 200 棵种子随机树 vs bruteForceLogZ 逐位对照 ≤ 1e-6）；含圈
   * 图上 loopy BP 不动点 = Bethe 自由能驻点——F 是「信念校准程度」的
   * 标量（与精确 −ln Z 的偏差 = loopy 近似的可信度读数）。
   */
  betheFreeEnergy(): {
    freeEnergy: number;
    logZBethe: number;
    factorEnergy: number;
    variableEnergy: number;
    isTree: boolean;
    interpretation: string;
  } {
    if (this.beliefs === null || this.lastMsgF === null) {
      throw new Error('betheFreeEnergy: 尚未运行（请先 runBeliefPropagation）');
    }
    const adj = this.buildAdjacency();
    // 变量→因子消息（与相 1 同口径：GDL 概率域前缀积 + 概率归一）
    const muV = new Map<string, Float64Array>();
    for (let v = 0; v < this.varIds.length; v += 1) {
      const links = adj[v]!;
      if (links.length === 0) continue;
      const outs = gdlVarToFactorMessages(this.priors[v]!, links.map((l) => this.lastMsgF![l.fi]![l.pos]!));
      for (let i = 0; i < links.length; i += 1) {
        const m = outs[i]!;
        normalizeProbs(m);
        muV.set(`${links[i]!.fi}:${links[i]!.pos}`, m);
      }
    }
    // 因子项：Σ_α Σ_a b_α ln(b_α/ψ_α) = Σ_α (E_α[lnNum] − lnZ_α − E_α[lnψ])
    // （lnNum = lnψ + Σ_q ln μ_{q→α}；E 均在 b_α 下取）
    let factorEnergy = 0;
    for (let fi = 0; fi < this.factors.length; fi += 1) {
      const f = this.factors[fi]!;
      const k = f.scope.length;
      const logMu = f.scope.map((_v, pos) => toLog(muV.get(`${fi}:${pos}`)!));
      const nums = new Float64Array(f.logTable.length);
      const digits = new Array<number>(k);
      for (let a = 0; a < f.logTable.length; a += 1) {
        let rem = a;
        let num = f.logTable[a]!;
        for (let q = 0; q < k; q += 1) {
          const s = Math.floor(rem / f.strides[q]!);
          rem -= s * f.strides[q]!;
          digits[q] = s;
          num += logMu[q]![s]!;
        }
        nums[a] = num;
      }
      const logZa = lseBuffer(nums, nums.length);
      let expectLogNum = 0;
      let expectLogPsi = 0;
      for (let a = 0; a < nums.length; a += 1) {
        const w = Math.exp(nums[a]! - logZa);
        if (w > 0) {
          expectLogNum += w * nums[a]!;
          expectLogPsi += w * f.logTable[a]!;
        }
      }
      factorEnergy += expectLogNum - logZa - expectLogPsi;
    }
    // 变量项：先验 λ_i 记为一元因子（Wainwright–Jordan 口径）——
    //   Σ_i [Σ b ln(b/λ) − (d_i − 1)·Σ b ln b]，d_i = 多元因子数 + 1
    //   = Σ_i [(1 − deg_i)·Σ b ln b − Σ b ln λ]
    // （孤立变量 deg=0：b = λ → 项恰为 0，跳过；先验归一 ⇒ ln Z 口径一致）
    let variableEnergy = 0;
    for (let v = 0; v < this.varIds.length; v += 1) {
      const deg = adj[v]!.length;
      if (deg === 0) continue;
      let sumBlnB = 0;
      let sumBlnL = 0;
      const b = this.beliefs[this.varIds[v]!]!;
      const lam = this.priors[v]!;
      for (let s = 0; s < b.length; s += 1) {
        if (b[s]! > 0) {
          sumBlnB += b[s]! * Math.log(b[s]!);
          if (lam[s]! > 0) sumBlnL += b[s]! * Math.log(lam[s]!);
        }
      }
      variableEnergy += (1 - deg) * sumBlnB - sumBlnL;
    }
    const freeEnergy = factorEnergy + variableEnergy;
    const isTree = this.computeTreeFlag();
    return {
      freeEnergy,
      logZBethe: -freeEnergy,
      factorEnergy,
      variableEnergy,
      isTree,
      interpretation: isTree
        ? `树上不动点：F_Bethe = ${freeEnergy.toFixed(6)} = −ln Z（精确配分函数的变分重述）`
        : `含圈不动点（Bethe 驻点）：ln Z 估计 ${(-freeEnergy).toFixed(6)}——与精确 ln Z 的偏差 = loopy 近似的校准读数`,
    };
  }

  // ─────────────────────────── 内部工具 ───────────────────────────

  /** 变量 → 邻接因子表 [{fi, pos}] */
  private buildAdjacency(): Array<Array<{ fi: number; pos: number }>> {
    const adj: Array<Array<{ fi: number; pos: number }>> = this.varIds.map(() => []);
    this.factors.forEach((f, fi) => f.scope.forEach((v, pos) => adj[v]!.push({ fi, pos })));
    return adj;
  }

  /**
   * 相 1：μ_{x→f} ∝ λ(x)·Π 其他因子消息。
   *
   * R5 性能进化（GDL 前缀积，generalized distributive law）: 对度为 d
   * 的变量，朴素逐目标连乘是 O(d²·m)；前缀积/后缀积各扫一遍后
   * out_i = 前缀_{<i} × 后缀_{>i}——O(3d·m)，等价性 ≤ 浮点舍入阶
   * （验证脚本对拍）。normalize 选概率归一 / 最大值归一。
   */
  private passVarToFactor(
    msgF: Float64Array[][],
    adj: Array<Array<{ fi: number; pos: number }>>,
    msgV: Float64Array[][],
    normalize: (m: Float64Array) => void,
  ): void {
    for (let v = 0; v < this.varIds.length; v += 1) {
      const d = this.domains[v]!;
      const links = adj[v]!;
      if (links.length === 0) continue;
      const outs = gdlVarToFactorMessages(this.priors[v]!, links.map((l) => msgF[l.fi]![l.pos]!));
      for (let i = 0; i < links.length; i += 1) {
        const out = msgV[links[i]!.fi]![links[i]!.pos]!;
        const src = outs[i]!;
        for (let s = 0; s < d; s += 1) out[s] = src[s]!;
        normalize(out);
      }
    }
  }

  /**
   * 相 2：μ_{f→x_p}(s) ∝ agg_{赋值: s_p = s} [ ψ · Π_{q≠p} μ_{x_q→f} ]
   * （agg = LSE 归并（'sum'）或逐项取 max（'max'）；目标位置 p 自身的
   * 入消息按定义排除——用前缀/后缀和直接构造 Σ_{q≠p}，避免 log 域
   * 减法的 −∞−(−∞)=NaN 与上溢）。写回含阻尼，返回本轮最大残差（L∞）。
   */
  private passFactorToVar(msgF: Float64Array[][], msgV: Float64Array[][], mode: AggMode, damping: number): number {
    let maxDelta = 0;
    for (let fi = 0; fi < this.factors.length; fi += 1) {
      const f = this.factors[fi]!;
      const k = f.scope.length;
      const size = f.logTable.length;
      const logIn = msgV[fi]!.map((m) => toLog(m));
      const digits = new Array<number>(k);
      const pre = new Float64Array(k + 1); // pre[q] = Σ_{q'<q} logIn[q'][s_{q'}]
      const suf = new Float64Array(k + 1); // suf[q] = Σ_{q'≥q} logIn[q'][s_{q'}]
      const decode = (a: number): void => {
        let rem = a;
        for (let q = 0; q < k; q += 1) {
          const s = Math.floor(rem / f.strides[q]!);
          rem -= s * f.strides[q]!;
          digits[q] = s;
        }
      };
      // 第一遍：各目标位置 p 的对数域锚（max_{赋值} [ψ + Σ_{q≠p}]，数值移位用）
      const anchor = new Array<number>(k).fill(-Infinity);
      for (let a = 0; a < size; a += 1) {
        decode(a);
        for (let q = 0; q < k; q += 1) pre[q + 1] = pre[q]! + logIn[q]![digits[q]!]!;
        suf[k] = 0;
        for (let q = k - 1; q >= 0; q -= 1) suf[q] = suf[q + 1] + logIn[q]![digits[q]!]!;
        for (let p = 0; p < k; p += 1) {
          const t = f.logTable[a]! + pre[p]! + suf[p + 1]!;
          if (t > anchor[p]!) anchor[p] = t;
        }
      }
      // 第二遍：exp(t − anchor) ∈ [0,1]，按 (p, s_p) 聚合
      const acc = f.scope.map((v) => new Float64Array(this.domains[v]!));
      for (let a = 0; a < size; a += 1) {
        decode(a);
        for (let q = 0; q < k; q += 1) pre[q + 1] = pre[q]! + logIn[q]![digits[q]!]!;
        suf[k] = 0;
        for (let q = k - 1; q >= 0; q -= 1) suf[q] = suf[q + 1] + logIn[q]![digits[q]!]!;
        const base = f.logTable[a]!;
        for (let p = 0; p < k; p += 1) {
          const ap = anchor[p]!;
          if (ap !== -Infinity) {
            const t = base + pre[p]! + suf[p + 1]!;
            const w = t === -Infinity ? 0 : Math.exp(t - ap);
            const slot = acc[p]![digits[p]!]!;
            acc[p]![digits[p]!] = mode === 'sum' ? slot + w : Math.max(slot, w);
          }
        }
      }
      // 写回（归一 → 阻尼凸组合 → 再归一；两归一向量之凸组合仍归一）
      for (let p = 0; p < k; p += 1) {
        const cur = msgF[fi]![p]!;
        const next = acc[p]!;
        if (mode === 'sum') normalizeProbs(next);
        else normalizeMax(next);
        for (let s = 0; s < next.length; s += 1) {
          const nv = damping > 0 ? damping * next[s]! + (1 - damping) * cur[s]! : next[s]!;
          const delta = Math.abs(nv - cur[s]!);
          if (delta > maxDelta) maxDelta = delta;
          cur[s] = nv;
        }
        if (mode === 'sum') normalizeProbs(cur);
        else normalizeMax(cur);
      }
    }
    return maxDelta;
  }

  /**
   * max-sum 相 2（R5）: m_{f→x_p}(s) = max_{赋值: s_p=s} [logψ + Σ_{q≠p} m_q]。
   *
   * 纯对数域：逐表项 decode + 前/后缀和构造 Σ_{q≠p}（同 sum-product 的
   * 结构，但归并是 max 且**无 exp**）——每目标位平移归一后写回（含
   * 阻尼），返回本轮最大残差（L∞，平移后口径）。
   */
  private passFactorToVarMaxSum(logF: Float64Array[][], logV: Float64Array[][], damping: number): number {
    let maxDelta = 0;
    for (let fi = 0; fi < this.factors.length; fi += 1) {
      const f = this.factors[fi]!;
      const k = f.scope.length;
      const size = f.logTable.length;
      const acc = f.scope.map((v) => new Float64Array(this.domains[v]!).fill(-Infinity));
      const pre = new Float64Array(k + 1);
      const suf = new Float64Array(k + 1);
      const digits = new Array<number>(k);
      for (let a = 0; a < size; a += 1) {
        let rem = a;
        for (let q = 0; q < k; q += 1) {
          const s = Math.floor(rem / f.strides[q]!);
          rem -= s * f.strides[q]!;
          digits[q] = s;
        }
        pre[0] = 0;
        for (let q = 0; q < k; q += 1) pre[q + 1] = pre[q]! + logV[fi]![q]![digits[q]!]!;
        suf[k] = 0;
        for (let q = k - 1; q >= 0; q -= 1) suf[q] = suf[q + 1]! + logV[fi]![q]![digits[q]!]!;
        const base = f.logTable[a]!;
        for (let p = 0; p < k; p += 1) {
          const t = base + pre[p]! + suf[p + 1]!;
          if (t > acc[p]![digits[p]!]!) acc[p]![digits[p]!] = t;
        }
      }
      for (let p = 0; p < k; p += 1) {
        const cur = logF[fi]![p]!;
        const next = acc[p]!;
        // 平移归一（max = 0；全 −Inf → 均匀回填 0）+ 对数域阻尼
        let mx = -Infinity;
        for (let s = 0; s < next.length; s += 1) if (next[s]! > mx) mx = next[s]!;
        for (let s = 0; s < next.length; s += 1) {
          const shifted = mx === -Infinity ? 0 : next[s]! - mx;
          const nv = damping > 0 ? damping * shifted + (1 - damping) * cur[s]! : shifted;
          const delta = Math.abs(nv - cur[s]!);
          if (delta > maxDelta) maxDelta = delta;
          cur[s] = nv;
        }
        // 阻尼破坏平移——再平移一次（max 归一不改变 argmax 结构）
        let mx2 = -Infinity;
        for (let s = 0; s < cur.length; s += 1) if (cur[s]! > mx2) mx2 = cur[s]!;
        if (mx2 !== -Infinity && mx2 !== 0) {
          for (let s = 0; s < cur.length; s += 1) cur[s]! -= mx2;
        }
      }
    }
    return maxDelta;
  }

  /** 指派的 log 联合（未归一化 Σ log ψ + Σ log λ） */
  private logJointOf(assignment: Record<string, number>): number {
    let lj = 0;
    for (let v = 0; v < this.varIds.length; v += 1) {
      lj += logPositive(this.priors[v]![assignment[this.varIds[v]!]!]!);
    }
    for (const f of this.factors) {
      let idx = 0;
      for (let p = 0; p < f.scope.length; p += 1) {
        idx += assignment[this.varIds[f.scope[p]!]!]! * f.strides[p]!;
      }
      lj += f.logTable[idx]!;
    }
    return lj;
  }

  /** 二部图（变量 ∪ 因子）是否为森林：E = V_total − C（每分量树判据） */
  private computeTreeFlag(): boolean {
    const nV = this.varIds.length;
    const parent = new Array<number>(nV + this.factors.length);
    for (let i = 0; i < parent.length; i += 1) parent[i] = i;
    const find = (x: number): number => {
      let r = x;
      while (parent[r]! !== r) r = parent[r]!;
      let c = x;
      while (parent[c]! !== c) {
        const nx = parent[c]!;
        parent[c] = r;
        c = nx;
      }
      return r;
    };
    let incidences = 0;
    for (let fi = 0; fi < this.factors.length; fi += 1) {
      const f = this.factors[fi]!;
      incidences += f.scope.length;
      for (let p = 0; p < f.scope.length; p += 1) {
        const ra = find(nV + fi);
        const rb = find(f.scope[p]!);
        if (ra !== rb) parent[ra] = rb;
      }
    }
    const roots = new Set<number>();
    for (let i = 0; i < parent.length; i += 1) roots.add(find(i));
    return incidences === nV + this.factors.length - roots.size;
  }

  /** 暴力联合枚举核心：边缘 + logZ + MAP 共享一遍枚举（log 域防溢出） */
  private bruteForceCore(): { marginals: Record<string, number[]>; logZ: number; best: JointMAP } {
    if (this.varIds.length === 0) throw new Error('bruteForce: 因子图为空（请先 addVariable）');
    const n = this.varIds.length;
    const strides = new Array<number>(n);
    let total = 1;
    for (let i = n - 1; i >= 0; i -= 1) {
      strides[i] = total;
      total *= this.domains[i]!;
    }
    if (total > MAX_BRUTE_STATES) {
      throw new Error(`bruteForce: 联合状态数 ${total} > 上限 ${MAX_BRUTE_STATES}（暴力对照仅适用小图）`);
    }
    const logJoints = new Float64Array(total);
    for (let a = 0; a < total; a += 1) {
      let lj = 0;
      for (let i = 0; i < n; i += 1) {
        lj += logPositive(this.priors[i]![Math.floor(a / strides[i]!) % this.domains[i]!]!);
      }
      for (const f of this.factors) {
        let idx = 0;
        for (let p = 0; p < f.scope.length; p += 1) {
          const v = f.scope[p]!;
          idx += (Math.floor(a / strides[v]!) % this.domains[v]!) * f.strides[p]!;
        }
        lj += f.logTable[idx]!;
      }
      logJoints[a] = lj;
    }
    const logZ = lseBuffer(logJoints, total);
    if (logZ === -Infinity) throw new Error('bruteForce: 联合分布全零（硬约束证据互相矛盾，无联合实现）');
    const acc = this.varIds.map((_, i) => new Float64Array(this.domains[i]!));
    let bestIdx = 0;
    let bestLog = -Infinity;
    for (let a = 0; a < total; a += 1) {
      const w = Math.exp(logJoints[a]! - logZ);
      for (let i = 0; i < n; i += 1) {
        acc[i]![Math.floor(a / strides[i]!) % this.domains[i]!]! += w;
      }
      if (logJoints[a]! > bestLog) {
        bestLog = logJoints[a]!;
        bestIdx = a;
      }
    }
    const marginals: Record<string, number[]> = {};
    const assignment: Record<string, number> = {};
    for (let i = 0; i < n; i += 1) {
      const s = Math.floor(bestIdx / strides[i]!) % this.domains[i]!;
      marginals[this.varIds[i]!] = Array.from(acc[i]!);
      assignment[this.varIds[i]!] = s;
    }
    return { marginals, logZ, best: { assignment, logJoint: bestLog } };
  }

  private interpret(
    isTree: boolean,
    converged: boolean,
    iterations: number,
    residual: number,
    damping: number,
    maxIter: number,
  ): string {
    if (isTree && converged) {
      return `树结构因子图：${iterations} 轮收敛（树上 ≤ 直径轮即精确），marginals() = 精确边缘化（可对照 bruteForceMarginals）`;
    }
    if (isTree) {
      return `树结构但 ${maxIter} 轮内未达容差（残差 ${residual.toExponential(2)}）——提高 maxIter 即得精确边缘`;
    }
    if (converged) {
      return `含圈图：loopy BP 收敛到不动点（Bethe 自由能驻点，非精确边缘）${damping > 0 ? `，阻尼 ${damping}` : '，无阻尼'}——精确对照请用 bruteForceMarginals（小图）`;
    }
    return `含圈图未收敛（残差 ${residual.toExponential(2)}）——建议 damping 0.5 或提高 maxIter`;
  }
}

// ─────────────────────────── 数值内核 ───────────────────────────

/** 单因子势表项数上限（防误建指数级大表） */
const MAX_FACTOR_TABLE = 1_000_000;
/** 暴力对照的联合状态数上限 */
const MAX_BRUTE_STATES = 1_000_000;

/**
 * logSumExp：LSE(x) = m + log Σ e^{xᵢ−m}（m = max xᵢ）——数值稳定的对数和。
 * e^1000 级输入不上溢、e^−1000 级不下溢；−Inf 项安全忽略；全 −Inf → −Inf。
 */
export function logSumExp(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('logSumExp: 至少需要 1 个元素');
  let max = -Infinity;
  for (const x of xs) {
    if (Number.isNaN(x)) return NaN;
    if (x === Infinity) return Infinity;
    if (x > max) max = x;
  }
  if (max === -Infinity) return -Infinity;
  let sum = 0;
  for (const x of xs) sum += Math.exp(x - max);
  return max + Math.log(sum);
}

/** 选项校验（两个入口共用口径） */
function validateOptions(options: BPOptions, who: string): { maxIter: number; tol: number; damping: number } {
  const maxIter = Math.floor(options.maxIter ?? 300);
  const tol = options.tol ?? 1e-10;
  const damping = options.damping ?? 0;
  if (!(maxIter >= 1)) throw new Error(`${who}: maxIter 须为 ≥ 1 的整数（收到 ${options.maxIter}）`);
  if (!Number.isFinite(tol) || !(tol > 0)) throw new Error(`${who}: tol 须为正有限数（收到 ${options.tol}）`);
  if (!(damping >= 0 && damping < 1)) throw new Error(`${who}: damping ∈ [0,1)（收到 ${options.damping}）`);
  return { maxIter, tol, damping };
}

/** 均匀分布向量 */
function uniform(d: number): Float64Array {
  const m = new Float64Array(d);
  m.fill(1 / d);
  return m;
}

/**
 * GDL 前缀积（R5 性能进化；Aji–McEliece 2000 广义分配律）:
 * 给定先验与 d 条入消息，一次返回全部 d 条出消息
 *   out_i = prior ⊙ Π_{j≠i} in_j
 * ——前缀积/后缀积各 O(d·m)，总 O(3d·m) 代替逐目标连乘的 O(d²·m)。
 * 返回**未归一**积（调用方按口径归一）；概率域实现。
 */
export function gdlVarToFactorMessages(
  prior: readonly number[],
  incoming: ReadonlyArray<Float64Array>,
): Float64Array[] {
  const d = prior.length;
  const n = incoming.length;
  const pre: Float64Array[] = new Array(n + 1);
  const suf: Float64Array[] = new Array(n + 1);
  let acc = new Float64Array(d);
  acc.fill(1);
  for (let i = 0; i < n; i += 1) {
    pre[i] = acc;
    const inc = incoming[i]!;
    const next = new Float64Array(d);
    for (let s = 0; s < d; s += 1) next[s] = acc[s]! * inc[s]!;
    acc = next;
  }
  pre[n] = acc;
  acc = new Float64Array(d);
  acc.fill(1);
  for (let i = n - 1; i >= 0; i -= 1) {
    suf[i + 1] = acc;
    const inc = incoming[i]!;
    const next = new Float64Array(d);
    for (let s = 0; s < d; s += 1) next[s] = acc[s]! * inc[s]!;
    acc = next;
  }
  suf[0] = acc;
  const outs: Float64Array[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const out = new Float64Array(d);
    for (let s = 0; s < d; s += 1) out[s] = prior[s]! * pre[i]![s]! * suf[i + 1]![s]!;
    outs[i] = out;
  }
  return outs;
}

/**
 * GDL 前缀**和**（对数域；max-sum 相 1 用）:
 * out_i = logPrior + Σ_{j≠i} in_j——O(3d·m) 代替 O(d²·m)，无 exp。
 */
function gdlLogMessages(logPrior: readonly number[], incoming: ReadonlyArray<Float64Array>): Float64Array[] {
  const d = logPrior.length;
  const n = incoming.length;
  const pre: Float64Array[] = new Array(n + 1);
  const suf: Float64Array[] = new Array(n + 1);
  let acc = new Float64Array(d); // 0 = 对数域单位元
  for (let i = 0; i < n; i += 1) {
    pre[i] = acc;
    const inc = incoming[i]!;
    const next = new Float64Array(d);
    for (let s = 0; s < d; s += 1) next[s] = acc[s]! + inc[s]!;
    acc = next;
  }
  pre[n] = acc;
  acc = new Float64Array(d);
  for (let i = n - 1; i >= 0; i -= 1) {
    suf[i + 1] = acc;
    const inc = incoming[i]!;
    const next = new Float64Array(d);
    for (let s = 0; s < d; s += 1) next[s] = acc[s]! + inc[s]!;
    acc = next;
  }
  suf[0] = acc;
  const outs: Float64Array[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const out = new Float64Array(d);
    for (let s = 0; s < d; s += 1) out[s] = logPrior[s]! + pre[i]![s]! + suf[i + 1]![s]!;
    outs[i] = out;
  }
  return outs;
}

/** 对数域写回：平移归一（max = 0；全 −Inf → 0 均匀）+ 阻尼插值 */
function shiftMax(out: Float64Array, src: Float64Array, damping: number): void {
  let mx = -Infinity;
  for (let s = 0; s < src.length; s += 1) if (src[s]! > mx) mx = src[s]!;
  for (let s = 0; s < out.length; s += 1) {
    const shifted = mx === -Infinity ? 0 : src[s]! - mx;
    out[s] = damping > 0 ? damping * shifted + (1 - damping) * out[s]! : shifted;
  }
  // 阻尼后 max 偏移——再平移（argmax 结构不变，量级受控）
  let mx2 = -Infinity;
  for (let s = 0; s < out.length; s += 1) if (out[s]! > mx2) mx2 = out[s]!;
  if (mx2 !== -Infinity && mx2 !== 0) {
    for (let s = 0; s < out.length; s += 1) out[s]! -= mx2;
  }
}

/** log(·) 的安全版本：0 / 下溢 → −Infinity（正确极限，无 NaN） */
function logPositive(x: number): number {
  return x > 0 ? Math.log(x) : -Infinity;
}

/** 概率向量 → log 向量（逐元素安全 log） */
function toLog(m: Float64Array): Float64Array {
  const out = new Float64Array(m.length);
  for (let i = 0; i < m.length; i += 1) out[i] = m[i]! > 0 ? Math.log(m[i]!) : -Infinity;
  return out;
}

/** 概率归一（全零 / 下溢时回退均匀——消息永不失义） */
function normalizeProbs(m: Float64Array): void {
  let s = 0;
  for (let i = 0; i < m.length; i += 1) s += m[i]!;
  if (!(s > 0)) {
    m.fill(1 / m.length);
    return;
  }
  for (let i = 0; i < m.length; i += 1) m[i]! /= s;
}

/** 最大值归一（max-product 口径：argmax 不变量 + 防尺度漂移） */
function normalizeMax(m: Float64Array): void {
  let mx = 0;
  for (let i = 0; i < m.length; i += 1) if (m[i]! > mx) mx = m[i]!;
  if (!(mx > 0)) {
    m.fill(1 / m.length);
    return;
  }
  for (let i = 0; i < m.length; i += 1) m[i]! /= mx;
}

/** Float64Array 前 n 项的 LSE（内核内部高速路径） */
function lseBuffer(buf: Float64Array, n: number): number {
  let mx = -Infinity;
  for (let i = 0; i < n; i += 1) if (buf[i]! > mx) mx = buf[i]!;
  if (mx === -Infinity || mx === Infinity) return mx;
  let s = 0;
  for (let i = 0; i < n; i += 1) s += Math.exp(buf[i]! - mx);
  return mx + Math.log(s);
}

// ── 接线建议 ──
// 1. 世界模型多源证据融合（src/world-model.ts；层论共识 20.0 的概率版姊妹）：
//    假设变量化（addVariable(假设, 离散域, 单源先验)）× 证据因子化
//    （addFactor(证据覆盖的假设组合, 兼容度势表)）→ runBeliefPropagation()
//    .marginals() 给出「综合全部证据后各假设多可信」的联合后验边缘——
//    与 sheaf-consensus 互补：层论定位「哪里结构性矛盾」，本内核量化
//    「矛盾之下各假设的相对可信度」；证据可疑时对 log 势表做温度缩放
//    扫描，检查结论稳健性。
// 2. 记忆图软查询（src/memory/memory-graph.ts）：查询意图 / 记忆条目为变量，
//    共现与语义相似为二元因子，marginals() 即多跳证据乘法融合的软检索
//    排序（替代单跳打分的硬检索）；maxProductDecode() 给联合最优的
//    「意图-条目」配对。
// 3. 多模型选型 MAP（src/model-scheduler.ts）：候选模型 × 任务类型为变量、
//    协同/互斥经验为因子，联合最优指派替代逐任务独立选型的局部贪心。
// 缺省关闭旗标: beliefPropagation.enabled（缺省 false；打开后仅在上述三个
//    入口旁路调用，不改变既有评分/检索路径的任何数值）。
// 挂载后改变的决策点: ①世界模型假设排序（从「各源平均分」变为「联合后验
//    边缘」——互斥证据不再被平均成编造共识）；②记忆检索排序（从单跳相似
//    变为多跳后验边缘）；③冲突证据定位（某源消息与全局边缘严重背离处 =
//    该源与整体信念结构的冲突点，交层论共识做结构裁决）。
