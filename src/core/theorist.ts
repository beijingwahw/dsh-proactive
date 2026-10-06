/**
 * theorist.ts — 理论内核（项目 11.0「理论心智」质变基座：从数据到定律）
 *
 * 升级前的根本局限（10.0 科学家心智的天花板）：
 * 系统高效地获取知识（EIG 最优实验），但知识始终是**散落的边统计**——
 * 每条边各自维护一份 Beta 后验，互不相识：
 * - K 条结构相同的边（同族模型对同一结局的效应）各自从 Beta(1,1)
 *   独立学习——每条边都要交满学费，证据从不共享；
 * - 一个新成员进入家族，即使全族经验丰富，它仍从全无知起步——
 *   知识不复合、不迁移、不成体系；
 * - 没有任何机制把 K 条边的规律**压缩成一条定律**——
 *   「第谷积累了毕生的观测数据，开普勒一行公式就让它们过时」，
 *   而系统永远停在第谷：只有数据，没有定律。
 *
 * 本内核引入层级贝叶斯 + MDL（理解即压缩）：
 *
 * 1. **定律归纳（借力收缩）**：同族 (family(from) → to) 的 K 条边
 *    汇聚为一条定律 Beta(1+Σs, 1+Σf)——每条边第一次能用全族的
 *    证据说话（partial pooling）；定律区间严格窄于任何单边
 *    （个体不确定，集体确定——统计学的规模智慧）。
 *
 * 2. **压缩定价（理解即压缩，精确贝叶斯模型比较）**：
 *      compression = ln B(1+Σs, 1+Σf) − Σ ln B(1+sᵢ, 1+fᵢ)
 *    = 「一条定律解释全部数据」vs「每条边各自一个参数」的对数
 *    贝叶斯因子（组合项两边抵消）。> 0（nat）定律才配存在——
 *    「理解」第一次有了严格定义：省下的描述长度。数据同质时
 *    汇聚后验的预测力碾压 K 份独立先验；数据异质时偏离代价
 *    自动否决定律——定异数学内生于账目。
 *
 * 3. **零样本预测（定律的泛化）**：定律作用域内的新边（臂证据
 *    稀疏）直接以定律后验作预测——新成员入族即继承全族知识，
 *    不再从 Beta(1,1) 起步。冷启动问题在定律覆盖处消失。
 *
 * 4. **反常侦测（定律的免疫系统）**：单边偏离代价超过其独立
 *    残差熵 = 「单独描述比服从定律更便宜」= 该边是定律的反常者
 *    （contested 状态）——它不属于这条定律。
 *
 * 5. **范式转移（库恩跃迁）**：整条定律 compression ≤ 0 时，
 *    驱逐最大偏离者为 outlier 后重算——定律为幸存成员重建；
 *    被驱逐者成为新范式的种子。「一次反常是噪声，一组反常是
 *    新范式」第一次有了算术。
 *
 * 与 5-10.0 的关系：5.0 回答「是不是它造成的」，10.0 定价「一次
 * 实验换来多少知识」，本内核回答「K 条边的知识能否压缩为一条
 * 定律、定律能否预言未测之边、反常何时推翻定律」。
 * 理论心智 = 科学家心智 × 知识的压缩与体系化。
 *
 * 审计性：归纳是因果图当前状态的纯函数（确定性），可重放；
 * 每条定律携带成员明细、偏离代价、反常者与压缩账目——
 * 「为什么信这条定律」可逐边追溯。
 *
 * R5 · 12.0 进化（第五轮·世界性进化）：
 * A. MDL 两部码显式分解（数学轴）—— 压缩账目从单一贝叶斯因子
 *    拆为「模型码 × 残差码」两部：
 *      compressionNat = modelCodeSavingNat − residualHeterogeneityNat
 *    - 模型码部分 modelCodeSavingNat = Σ regret_i − regret_池：K 个
 *      独立参数 → 1 个共享参数省下的描述长度（regret = 通用码 −
 *      最优码 = Beta(1,1) 边际似然 − MLE 似然，≈ ½·ln n 量级）；
 *    - 残差码部分 residualHeterogeneityNat = Σ nᵢ·KL(p̂ᵢ‖p̂)：共享
 *      参数拟合损失（Gibbs 不等式保证 ≥ 0，恰为成员对池的 KL 散度）。
 *    恒等式逐位可验——「定律值得多少」第一次分解为「省了几个参数」
 *    对「数据有多不合群」的显式对账。
 * B. 定律合并的信息论判据（数学轴）—— mergeGain：两条定律并集的
 *    单参数码 vs 各自两参数分码，Δ = compression(A∪B) −
 *    (compression(A)+compression(B)) > 0 ⇔ 两族共享一个参数更省码长
 *    （族边界不携带信息——合并是数据驱动的范畴收敛）。
 * C. 定律索引（性能轴）—— coveringTheory 从 O(定律数) 线性扫描
 *    改为 (family→to) 哈希索引 O(1)；归纳时重建。语义与线性扫描
 *    逐位一致（键唯一）。
 */

import type { CausalKernel } from './causal-kernel.js';
import { lnGamma } from './free-energy.js';
import { wilsonLowerBound, wilsonUpperBound } from './evidence.js';

// ─────────────────────────── 数据结构 ───────────────────────────

/** 定律成员（作用域内一条边的归纳明细） */
export interface TheoryMember {
  from: string;
  to: string;
  /** do=1 臂衰减证据 */
  successes: number;
  failures: number;
  /** MLE 成功率（归纳投票口径） */
  phat: number;
  /**
   * 入伙收益（nat）：该边数据在定律下的边际对数似然（其余成员的
   * 汇聚后验作预测先验）− 自立门户的先验预测对数似然。
   * ≤ 0 = 反常者——它的数据用全族知识解释还不如自己单干。
   */
  fitsLawNat: number;
  /** 自立门户的先验预测对数似然（nat）：ln B(1+s, 1+f) */
  standaloneLogMlNat: number;
  /** 反常者：fitsLawNat ≤ 0（不属于这条定律——新范式的种子） */
  anomalous: boolean;
}

/** 归纳出的定律 */
export interface Theory {
  /** 作用域标识 family→to */
  id: string;
  /** from 节点的族（id 冒号前缀；无冒号即整体） */
  family: string;
  to: string;
  /** 定律后验 Beta(1+Σs, 1+Σf) */
  lawAlpha: number;
  lawBeta: number;
  /** 定律成功率（后验均值） */
  lawP: number;
  /** 定律 Wilson 区间（比任何单边窄——借力收缩） */
  lawLower: number;
  lawUpper: number;
  /** 幸存成员（构成定律的证据） */
  members: TheoryMember[];
  /** 范式转移中被驱逐的 outlier（新范式的种子） */
  outliers: TheoryMember[];
  /**
   * 定律 vs 各自为政的精确对数贝叶斯因子（nat；>0 定律才配存在）：
   * ln B(1+Σs, 1+Σf) − Σ ln B(1+sᵢ, 1+fᵢ)
   * 共享 θ 用一个参数解释全部数据 vs 每条边各自付一个参数的代价。
   */
  compressionNat: number;
  /**
   * R5·12.0 两部码·模型部分（nat，≥0）：Σ regretᵢ − regret_池，
   * regret(s,f) = LL(θ̂) − ln B(1+s,1+f) = 通用码长减最优码长的
   * 「编码后悔量」——K 参数 → 1 参数省下的描述长度。
   */
  modelCodeSavingNat: number;
  /**
   * R5·12.0 两部码·残差部分（nat，≥0，Gibbs 不等式）：
   * Σ LLᵢ(θ̂ᵢ) − LL_池(θ̂) = Σ nᵢ·KL(p̂ᵢ‖p̂)——共享参数的拟合损失，
   * 成员对池的 KL 散度总和（「数据有多不合群」）。
   * 恒等式：compressionNat = modelCodeSavingNat − residualHeterogeneityNat。
   */
  residualHeterogeneityNat: number;
  /** 本次归纳是否发生范式转移（驱逐重建） */
  paradigmShift: boolean;
  /** law：全员一致；contested：存在反常者（定律存疑） */
  status: 'law' | 'contested';
  inducedAt: number;
}

/** R5·12.0：定律合并评估（信息论判据） */
export interface MergeAssessment {
  /** 参与合并的定律 A 的作用域标识 */
  aId: string;
  /** 定律 B 的作用域标识 */
  bId: string;
  /** 分离压缩账目 = compression(A) + compression(B)（nat） */
  separateCompressionNat: number;
  /** 并集单定律压缩账目（nat；成员为两定律幸存者之并） */
  mergedCompressionNat: number;
  /** Δ = merged − separate（>0 ⇒ 合并更省码长 ⇔ mergeable） */
  deltaNat: number;
  /** Δ > 0：两族共享一个参数在 MDL 口径下更优 */
  mergeable: boolean;
}

/** 定律零样本预测（作用域内臂证据稀疏的边） */
export interface TheoryPrediction {
  theoryId: string;
  p: number;
  lower: number;
  upper: number;
}

/** 理论前沿（meta-cognition 第六层 KPI） */
export interface TheoryFrontier {
  /** 在世定律数 */
  theories: number;
  /** 被定律压缩的边数（不再各自为政） */
  compressedEdges: number;
  /** outlier 边数（新范式种子） */
  outlierEdges: number;
  /** 全部定律累计压缩（nat——理解的总账） */
  compressionNat: number;
  /** 零样本预测次数（定律泛化的使用量） */
  zeroShotPredictions: number;
  /** 范式转移累计次数 */
  paradigmShifts: number;
  interpretation: string;
}

// ─────────────────────────── 配置 ───────────────────────────

export interface TheoristConfig {
  /** 立定律的最小成员数（缺省 3：两条边的一致不足以称定律） */
  minMembers: number;
  /** 零样本预测的臂证据门槛：n ≥ 该值的边用自己的后验（缺省 1） */
  zeroShotMaxArmSamples: number;
}

export const DEFAULT_THEORIST_CONFIG: TheoristConfig = {
  minMembers: 3,
  zeroShotMaxArmSamples: 1,
};

// ─────────────────────────── 内核实现 ───────────────────────────

/**
 * 理论内核：定律归纳 + MDL 压缩定价 + 零样本预测 + 反常/范式转移。
 *
 * 数据流：
 *   kernel.allEdgesEvidence（原料）→ induce（按 family→to 分组、
 *   MDL 仲裁、范式转移）→ predict（定律零样本）→ frontier（第六层 KPI）
 *
 * 归纳是因果图的纯函数（确定性、可重放）；缓存仅避免重复计算。
 */
export class TheoristEngine {
  private config: TheoristConfig;
  private kernel: CausalKernel;
  private cached: Theory[] = [];
  /** R5·12.0：作用域索引 `${family}→${to}` → 定律（coveringTheory O(1)） */
  private scopeIndex = new Map<string, Theory>();
  private induced = false;
  private zeroShotCount = 0;
  private paradigmShiftCount = 0;
  /** 各作用域上次范式转移的成员签名（同状态重复归纳不重复计数） */
  private shiftSignatures = new Map<string, string>();

  constructor(kernel: CausalKernel, config?: Partial<TheoristConfig>) {
    this.kernel = kernel;
    this.config = { ...DEFAULT_THEORIST_CONFIG, ...config };
  }

  /**
   * 归纳定律：扫描因果图全边，按 (family(from) → to) 分组，
   * 每组做 MDL 仲裁——compression > 0 才立定律；
   * 整组不抵代价时驱逐最大偏离者（范式转移）为幸存者重建。
   */
  induce(now = Date.now()): Theory[] {
    const groups = new Map<string, { family: string; to: string; members: TheoryMember[] }>();
    for (const ev of this.kernel.allEdgesEvidence(now)) {
      const n = ev.doXSuccess + ev.doXFailure;
      if (n < 1) continue; // 无处理臂证据的边不投票（可被零样本覆盖）
      const family = familyOf(ev.from);
      const key = `${family}→${ev.to}`;
      let group = groups.get(key);
      if (!group) {
        group = { family, to: ev.to, members: [] };
        groups.set(key, group);
      }
      group.members.push({
        from: ev.from,
        to: ev.to,
        successes: ev.doXSuccess,
        failures: ev.doXFailure,
        phat: ev.doXSuccess / n,
        fitsLawNat: 0,
        standaloneLogMlNat: lnBeta(1 + ev.doXSuccess, 1 + ev.doXFailure),
        anomalous: false,
      });
    }

    const theories: Theory[] = [];
    for (const [key, group] of groups) {
      if (group.members.length < this.config.minMembers) continue;

      let current = group.members.map((m) => ({ ...m }));
      const outliers: TheoryMember[] = [];
      let paradigmShift = false;
      let t = this.evaluate(current);

      // 范式转移：定律不抵代价 → 驱逐入伙收益最差者 → 为幸存者重建
      while (t.compressionNat <= 0 && current.length > this.config.minMembers) {
        const worst = current.reduce((a, b) => (b.fitsLawNat < a.fitsLawNat ? b : a));
        outliers.push(worst);
        current = current.filter((m) => m !== worst);
        paradigmShift = true;
        t = this.evaluate(current);
      }
      if (t.compressionNat <= 0) continue; // 驱逐到底仍不抵代价：该组无定律可立

      // 范式转移计数去重：按幸存者+驱逐者签名判定「新事件」——
      // 同一图状态重复归纳（KPI 心跳刷新）不重复计数；定律恢复
      // 健康后清除签名，下次同键转移重新计为事件
      if (paradigmShift) {
        const sig = `${current.map((m) => m.from).sort().join(',')}|${outliers.map((m) => m.from).sort().join(',')}`;
        if (this.shiftSignatures.get(key) !== sig) {
          this.paradigmShiftCount += 1;
          this.shiftSignatures.set(key, sig);
        }
      } else {
        this.shiftSignatures.delete(key);
      }
      theories.push({ ...t, id: key, family: group.family, to: group.to, outliers, paradigmShift, inducedAt: now });
    }

    this.cached = theories;
    this.scopeIndex = new Map(theories.map((t) => [`${t.family}→${t.to}`, t] as const));
    this.induced = true;
    return theories;
  }

  /** 覆盖 (from → to) 的在世定律（无缓存时惰性归纳；R5·12.0 起经作用域索引 O(1)） */
  coveringTheory(from: string, to: string, now = Date.now()): Theory | undefined {
    if (!this.induced) this.induce(now);
    return this.scopeIndex.get(`${familyOf(from)}→${to}`);
  }

  /**
   * 定律零样本预测：作用域内臂证据稀疏的边直接拿定律后验说话。
   * 新成员入族即继承全族知识——定律覆盖处无冷启动。
   */
  predict(from: string, to: string, now = Date.now()): TheoryPrediction | undefined {
    const theory = this.coveringTheory(from, to, now);
    if (!theory) return undefined;
    const ev = this.kernel.armEvidence(from, to, now);
    const n = ev ? ev.doXSuccess + ev.doXFailure : 0;
    if (n >= this.config.zeroShotMaxArmSamples) return undefined; // 有自己的证据：用自己的后验
    this.zeroShotCount += 1;
    return { theoryId: theory.id, p: theory.lawP, lower: theory.lawLower, upper: theory.lawUpper };
  }

  /** 在世定律只读视图 */
  allTheories(): Theory[] {
    return this.cached.map((t) => ({ ...t, members: t.members.map((m) => ({ ...m })), outliers: [...t.outliers] }));
  }

  /**
   * R5·12.0：定律合并的信息论判据——两条定律的数据并起来用一条定律
   * 描述，还是各用各的更省码长？
   *
   * Δ = compression(A∪B) − [compression(A) + compression(B)]
   *   = [模型码：2 参数 → 1 参数再省一个] − [残差码：跨族异质性新增的
   *     KL 拟合损失]
   * Δ > 0 ⇔ 两族共享一个参数在 MDL 口径下更优 ⇔ 族边界（from 前缀）
   * 不携带信息——范畴由数据裁决而非人来划分。Δ ≤ 0 保持分立。
   *
   * 纯函数：只读两条定律的幸存成员计数，不改动图、不产生新定律。
   */
  mergeGain(a: Theory, b: Theory): MergeAssessment {
    const members = [...a.members, ...b.members].map((m) => ({ ...m }));
    const separate = a.compressionNat + b.compressionNat;
    // 复用 evaluate 的纯函数账目（在本地副本上计算，不动内核）
    const mergedEval = this.evaluate(members);
    const merged = mergedEval.compressionNat;
    return {
      aId: a.id,
      bId: b.id,
      separateCompressionNat: round(separate),
      mergedCompressionNat: merged,
      deltaNat: round(merged - separate),
      mergeable: merged - separate > 0,
    };
  }

  /**
   * 理论前沿报告（第六层 KPI：知识的压缩与体系化）。
   * 每次读取都基于当前因果图重归纳——KPI 永不呈现过期定律，
   * 且宿主无需显式调用 induce（挂载即生效；归纳是纯函数，
   * 心跳粒度重算成本 O(边数)，范式转移计数已去重防虚增）。
   */
  frontier(now = Date.now()): TheoryFrontier {
    this.induce(now);
    const compression = this.cached.reduce((a, t) => a + t.compressionNat, 0);
    const compressed = this.cached.reduce((a, t) => a + t.members.length, 0);
    const outliers = this.cached.reduce((a, t) => a + t.outliers.length, 0);
    const contested = this.cached.filter((t) => t.status === 'contested').length;
    const interpretation =
      this.cached.length === 0
        ? '无在世定律：知识仍是散落的边统计（induce 归纳或证据不足）'
        : `${this.cached.length} 条定律压缩 ${compressed} 条边（省 ${compression.toFixed(2)} nat）` +
          (contested > 0 ? `；${contested} 条存疑（反常者待裁决）` : '') +
          (outliers > 0 ? `；${outliers} 个 outlier（新范式种子）` : '');
    return {
      theories: this.cached.length,
      compressedEdges: compressed,
      outlierEdges: outliers,
      compressionNat: round(compression),
      zeroShotPredictions: this.zeroShotCount,
      paradigmShifts: this.paradigmShiftCount,
      interpretation,
    };
  }

  // ─────────────────────────── 内部 ───────────────────────────

  /** 对一组成员计算定律与模型比较账目（纯函数） */
  private evaluate(members: TheoryMember[]): Omit<Theory, 'id' | 'family' | 'to' | 'outliers' | 'paradigmShift'> {
    const S = members.reduce((a, m) => a + m.successes, 0);
    const F = members.reduce((a, m) => a + m.failures, 0);
    const lawP = (1 + S) / (2 + S + F);

    // 定律 vs 各自为政：精确对数贝叶斯因子（组合项两边抵消）
    // compression = ln B(1+S, 1+F) − Σ ln B(1+s_i, 1+f_i)
    const lawLogMl = lnBeta(1 + S, 1 + F);
    const separateLogMl = members.reduce((a, m) => a + m.standaloneLogMlNat, 0);
    const compressionNat = lawLogMl - separateLogMl;

    // R5·12.0 两部码显式分解（恒等式：compression = 模型码 − 残差码）：
    //   通用码 = ln B(1+s,1+f) = 最优码 LL(θ̂) + regret（编码后悔量）
    //   compression = [Σ LL_i(θ̂_i) − LL_池(θ̂)] + [Σ regret_i − regret_池]
    //               = 残差码（异质性，≥0）的负值 + 模型码（省参数，≥0）
    const modelCodeSavingNat = members.reduce((a, m) => a + regretOf(m.successes, m.failures), 0) - regretOf(S, F);
    const residualHeterogeneityNat =
      members.reduce((a, m) => a + logLikAtMle(m.successes, m.failures), 0) - logLikAtMle(S, F);

    // 成员入伙收益：该边数据在「其余成员汇聚后验」下的预测对数似然
    // − 自立门户先验预测对数似然（去偏：剔除自身对汇聚的影响）
    for (const m of members) {
      const othersLogMl = lnBeta(1 + S - m.successes, 1 + F - m.failures);
      m.fitsLawNat = round(lawLogMl - othersLogMl - m.standaloneLogMlNat);
      m.anomalous = m.fitsLawNat <= 0;
    }

    return {
      lawAlpha: 1 + S,
      lawBeta: 1 + F,
      lawP: round(lawP),
      lawLower: round(wilsonLowerBound(S, F)),
      lawUpper: round(wilsonUpperBound(S, F)),
      members,
      compressionNat: round(compressionNat),
      modelCodeSavingNat: round(modelCodeSavingNat),
      residualHeterogeneityNat: round(residualHeterogeneityNat),
      status: members.some((m) => m.anomalous) ? 'contested' : 'law',
      inducedAt: 0,
    };
  }
}

/** ln B(α, β) = lnΓ(α) + lnΓ(β) − lnΓ(α+β)（先验预测对数似然的核） */
function lnBeta(alpha: number, beta: number): number {
  return lnGamma(alpha) + lnGamma(beta) - lnGamma(alpha + beta);
}

/**
 * R5·12.0：MLE 对数似然 LL(θ̂) = s·ln θ̂ + f·ln(1−θ̂)，θ̂ = s/(s+f)。
 * 数值口径（对数域稳健）：s=0 或 f=0 时对应项按 0·ln 0 = 0 约定取 0
 * （不产生 −∞）；n=0（空数据）似然恒 0。
 */
function logLikAtMle(s: number, f: number): number {
  const n = s + f;
  if (n === 0) return 0;
  const theta = s / n;
  const termS = s > 0 ? s * Math.log(theta) : 0;
  const termF = f > 0 ? f * Math.log(1 - theta) : 0;
  return termS + termF;
}

/**
 * R5·12.0：编码后悔量（码长口径）= 通用码长 − 最优码长
 *   = [−ln B(1+s,1+f)] − [−LL(θ̂)] = LL(θ̂) − ln B(1+s,1+f) ≥ 0
 * （通用码（Beta(1,1) 先验预测）永不短于已知 θ̂ 的最优码——每参数
 * ≈ ½·ln n 的多余码长，正是「付一个参数的价」）。
 */
function regretOf(s: number, f: number): number {
  return logLikAtMle(s, f) - lnBeta(1 + s, 1 + f);
}

// ─────────────────────────── 工具 ───────────────────────────

/** 族名 = 节点 id 冒号前缀（`model:m-1` → `model`；无冒号即整体） */
function familyOf(id: string): string {
  const idx = id.indexOf(':');
  return idx > 0 ? id.slice(0, idx) : id;
}

function round(x: number): number {
  return Number(x.toFixed(6));
}
