/**
 * optimal-stopping.ts — 最优停止内核（项目 19.0「等待有了数学价格」质变基座）
 *
 * 升级前的根本局限（defer 决策的拍脑袋阈值）：
 * - 「紧急度 < 0.3 且成本 > 5000 → 延迟 5 分钟」——两个魔数没有任何
 *   最优性依据：为什么是 0.3？为什么延迟恰好 5 分钟？延迟之后世界
 *   会更好还是更差？现有口径一概不知，defer 只是「不敢做」的委婉语；
 * - 「现在做」vs「等下一个机会」之间没有价值权衡：信号到达是随机的
 *   流，当前机会的紧急度是一次抽样——如果未来还会来 k 个机会，
 *   当前这次值不值得占坑，是一个标准的最优停止问题，但系统从没
 *   把它当最优停止问题对待过；
 * - 无竞争性保证：任何在线停止策略都至少要回答「最坏比能看到的
 *   最好的差多少」（先知差距）——没有这个下界，defer 策略无法
 *   自证不是在系统性放弃价值。
 *
 * 本内核引入最优停止理论（经典秘书问题谱系：Krengel–Sucheston–
 * Garling 先知不等式；Samuel-Cahn 1984 阈值规则；Bruss 2000 赔率算法）：
 *
 * 1. **精确向后归纳（经验分布上的最优解）**：机会价值 ~ 经验分布
 *      Vₙ = E[X]；V_k = E[max(X, V_{k+1})] = (1/m) Σᵢ max(xᵢ, V_{k+1})
 *    还剩 k 次机会时的期望所得 V_k 逐层精确递推（经验测度下无近似）；
 *    最优策略是阈值策略：当前值 ≥ V_{k−1}（继续价值）即停。
 *
 * 2. **先知基准（prophet value）**：E[max X₁..Xₙ] 由次序统计量精确计算
 *      P(M ≤ x) = F(x)ⁿ ⇒ E[M] = Σᵢ x₍ᵢ₎·[(i/m)ⁿ − ((i−1)/m)ⁿ]
 *    任何在线策略的所得 ≤ 先知所得——先知差距（competitive ratio）
 *    衡量停止策略的成色。
 *
 * 3. **Samuel-Cahn 单阈值规则（分布无关 ½ 保证）**：取 τ = max 的中位数
 *    （F(τ)ⁿ = 1/2 的解），首见 X ≥ τ 即停。对**任意分布**保证
 *      E[规则所得] ≥ ½·E[先知所得]
 *    ——不需要知道分布形状的保守底线，且对适中的 n 常显著超过 ½。
 *
 * 4. **秘书问题与赔率算法（序贯选择的另两把刀）**：
 *    - 1/e 规则（n 已知、只见相对名次）：跳过前 n/e 个，之后取首个
 *      纪录——以恰好 1/e 概率选中全局最优，渐近最优；
 *    - Bruss 赔率算法（独立事件「最后一个成功」）：赔率 r = p/(1−p)，
 *      从最后一个 Σ r ≥ 1 的下标起在首个成功处停——期望停止次数
 *      与最优相差 ≤ 1 的优雅定理。
 *
 * 5. **机会停止器（OpportunityStopper）**：按上下文（信号类型）流式
 *    积累机会价值经验分布，`assess(当前值, 剩余机会数)` 返回
 *    { act, threshold, ruleValue, prophetValue, competitiveRatio }——
 *    defer/execute 第一次由「继续价值的精确阈值」而非拍脑袋魔数裁决。
 *
 * 与 8.0 的关系：8.0 元推理回答「**思考**何时停」（内部计算的最优
 * 分配），本内核回答「**等待**何时停」（外部机会的最优锁定）——
 * 内外两种停止问题共用「继续价值 vs 立即价值」的同一数学骨架；
 * 与 12.0 的关系：12.0 保证「随时下结论不夸大」（证据侧），本内核
 * 保证「何时下结论不吃亏」（行动侧）——结论的有效性与结论的时机
 * 构成决策的完整两面；与 18.0 的关系：18.0 约束单步变异的信息量，
 * 本内核约束单步等待的机会成本——进化与行动都有了自己的最优性口径。
 */

// ─────────────────────────── 精确核心量 ───────────────────────────

/**
 * 先知价值 E[max X₁..Xₙ]（经验分布次序统计量精确计算）。
 *
 * m 个样本的经验分布上：P(Mₙ ≤ x₍ᵢ₎) = (i/m)ⁿ，故
 *   E[Mₙ] = Σᵢ x₍ᵢ₎·[(i/m)ⁿ − ((i−1)/m)ⁿ]
 * @param samples 经验样本（机会价值历史）
 * @param n 未来机会次数
 */
export function prophetValue(samples: readonly number[], n: number): number {
  const m = samples.length;
  if (m === 0 || n <= 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  let expected = 0;
  for (let i = 1; i <= m; i += 1) {
    const cdfJump = Math.pow(i / m, n) - Math.pow((i - 1) / m, n);
    expected += sorted[i - 1]! * cdfJump;
  }
  return expected;
}

/**
 * 向后归纳最优停止价值 V_k（经验测度精确递推）。
 *
 * V_k = 还剩 k 次机会时的期望所得；thresholds[k] = V_{k−1} 为
 * 「剩 k 次时的最优接受阈值」（当前值 ≥ thresholds[k] 即停）。
 * @returns [V₁..Vₙ]（剩 k 次的价值）与对应阈值
 */
export function backwardInduction(
  samples: readonly number[],
  n: number,
): { values: number[]; thresholds: number[] } {
  const m = samples.length;
  if (m === 0 || n <= 0) return { values: [], thresholds: [] };
  const values = new Array<number>(n);
  // Vₙ = E[X]
  let v = samples.reduce((s, x) => s + x, 0) / m;
  values[n - 1] = v;
  for (let k = n - 1; k >= 1; k -= 1) {
    // V_k = E[max(X, V_{k+1})] = (1/m) Σ max(xᵢ, V_{k+1})
    v = samples.reduce((s, x) => s + Math.max(x, v), 0) / m;
    values[k - 1] = v;
  }
  // thresholds[k] = 剩 k+1 次时的继续价值（当前值 ≥ V_k 即停）
  const thresholds = values.slice(0, n - 1).map((x) => x);
  return { values, thresholds };
}

/**
 * Samuel-Cahn 单阈值规则：τ = Mₙ 的中位数（F(τ)ⁿ = 1/2）。
 *
 * 分布无关保证：E[规则所得] ≥ ½·E[先知所得]（任意分布）。
 * @returns 阈值 τ 与规则期望所得
 */
export function samuelCahnRule(samples: readonly number[], n: number): { threshold: number; ruleValue: number; prophet: number } {
  const m = samples.length;
  if (m === 0 || n <= 0) return { threshold: Infinity, ruleValue: 0, prophet: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  // 中位数阈值：最小 x₍ᵢ₎ 使 (i/m)ⁿ ≥ 0.5
  let threshold = sorted[sorted.length - 1]!;
  for (let i = 1; i <= m; i += 1) {
    if (Math.pow(i / m, n) >= 0.5) {
      threshold = sorted[i - 1]!;
      break;
    }
  }
  // 规则期望所得：首见 X ≥ τ 即停
  //   = E[X·1(X≥τ)] · Σ_{j=0}^{n−1} P(前 j 个都 < τ) = E[X·1(X≥τ)]·(1−(1−p)ⁿ)/p
  const p = samples.filter((x) => x >= threshold).length / m;
  const exceedGain = samples.filter((x) => x >= threshold).reduce((s, x) => s + x, 0) / m;
  const ruleValue = p > 0 ? (exceedGain * (1 - Math.pow(1 - p, n))) / p : exceedGain;
  return { threshold, ruleValue, prophet: prophetValue(samples, n) };
}

// ─────────────────────────── 秘书问题与赔率算法 ───────────────────────────

/**
 * 1/e 规则（秘书问题，n 已知）：跳过前 ⌊n/e⌋ 个候选，之后录取首个
 * 纪录（比已见全部更好者）。选中全局最优的概率 → 1/e（渐近最优）。
 * @returns 观察期内应跳过的数量
 */
export function secretarySkipCount(n: number): number {
  if (n <= 1) return 0;
  return Math.max(1, Math.floor(n / Math.E));
}

/**
 * Bruss 赔率算法（最后一个成功问题）：独立事件成功概率 p₁..pₙ，
 * 赔率 r = p/(1−p)。s* = 最大下标使后缀赔差和 Σ_{k≥s} rₖ ≥ 1
 * （从最后一个事件往前累加，和首次达到 1 的下标即 s*）；从 s* 起
 * 在首个成功处停。定理：期望停止次数与最优策略相差 ≤ 1（若存在 s*）。
 * p=1 的臂赔差为 Infinity：后缀和必 ≥ 1，规则自然落在最后一个 p=1
 * 位置处或其后（Infinity 仅参与加法与比较，不产生 NaN）。
 * @returns 起始下标 s*（1 起；无 s* 返回 0 = 全程不押）
 */
export function brussOddsIndex(successProbabilities: readonly number[]): number {
  const n = successProbabilities.length;
  // 后缀和：suffix(s) = Σ_{k≥s} rₖ。从后往前累加，后缀和单调不减，
  // 首次达到 ≥ 1 的下标即最大的 s*（再往前的更大后缀只会更满足）
  let suffix = 0;
  let sStar = 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    const p = Math.max(0, Math.min(1, successProbabilities[i]!));
    const odds = p >= 1 ? Infinity : p / (1 - p);
    suffix += odds;
    if (suffix >= 1) {
      sStar = i + 1;
      break;
    }
  }
  return sStar;
}

// ─────────────────────────── 机会停止器 ───────────────────────────

/** 机会停止器配置 */
export interface OptimalStoppingConfig {
  /** 开始裁决的最小经验样本（缺省 8——之前诚实返回 insufficient） */
  minSamples: number;
  /** 单上下文最大样本记忆（缺省 200，FIFO） */
  maxSamples: number;
  /** 保守系数：接受阈值 = 继续价值 × 该系数（>1 更挑剔；缺省 1） */
  thresholdMultiplier: number;
}

export const DEFAULT_OPTIMAL_STOPPING_CONFIG: OptimalStoppingConfig = {
  minSamples: 8,
  maxSamples: 200,
  thresholdMultiplier: 1,
};

/** 停止裁决视图 */
export interface StoppingVerdict {
  /** 当前机会价值是否 ≥ 继续价值（true = 立即行动数学最优） */
  act: boolean;
  /** 继续价值阈值（剩 k 次机会的最优接受线） */
  threshold: number;
  /** 当前值 */
  value: number;
  /** 剩余机会数（评估口径） */
  remaining: number;
  /** 向后归纳最优价值 V_k（当前持有的期望所得） */
  optimalValue: number;
  /** Samuel-Cahn 规则期望所得 */
  ruleValue: number;
  /** 先知价值 E[max]（任何在线策略的上界） */
  prophet: number;
  /** 成色 = 规则所得 / 先知所得（≥ 0.5 有定理背书） */
  competitiveRatio: number;
  /** 经验样本量 */
  samples: number;
  /** 裁决口径（insufficient = 样本不足，诚实弃权） */
  basis: 'backward-induction' | 'insufficient';
  interpretation: string;
}

/** 上下文状态 */
interface OpportunityContext {
  samples: number[];
}

/**
 * 机会停止器：按上下文流式积累机会价值分布，精确裁决「现在 vs 等待」。
 *
 * 用法：
 *   const stopper = new OpportunityStopper();
 *   stopper.note('deploy-request', 0.62);  // 每次机会到达时喂值
 *   const v = stopper.assess('deploy-request', 0.58, 3);  // 现值 0.58、还会来 ~3 次
 *   if (v.act) 执行(); else 等待();       // 阈值由 V_{k−1} 精确给出
 *
 * 数学保证：act = (value ≥ V_{remaining}) 是经验测度下的精确最优
 * 策略（阈值策略）；competitiveRatio ≥ 0.5 由 Samuel-Cahn 定理背书
 * （报告侧审计用）。
 */
export class OpportunityStopper {
  private readonly config: OptimalStoppingConfig;
  private readonly contexts = new Map<string, OpportunityContext>();
  /** 最近裁决审计 */
  private recent: Array<{ context: string; at: number; act: boolean; value: number; threshold: number; competitiveRatio: number }> = [];

  constructor(config?: Partial<OptimalStoppingConfig>) {
    this.config = { ...DEFAULT_OPTIMAL_STOPPING_CONFIG, ...config };
  }

  /** 记录一次机会价值观测（FIFO 容量控制） */
  note(context: string, value: number): void {
    let ctx = this.contexts.get(context);
    if (!ctx) {
      ctx = { samples: [] };
      this.contexts.set(context, ctx);
    }
    ctx.samples.push(Math.max(0, Math.min(1, value)));
    if (ctx.samples.length > this.config.maxSamples) ctx.samples.shift();
  }

  /** 上下文样本量 */
  sampleCount(context: string): number {
    return this.contexts.get(context)?.samples.length ?? 0;
  }

  /**
   * 裁决「立即行动 vs 等待」。
   *
   * @param context 上下文（如信号类型）
   * @param value 当前机会价值（0~1 口径）
   * @param remaining 预计剩余机会数（缺省 1——等价于最后一搏）
   */
  assess(context: string, value: number, remaining = 1): StoppingVerdict {
    const samples = this.contexts.get(context)?.samples ?? [];
    const v = Math.max(0, Math.min(1, value));
    const k = Math.max(1, Math.floor(remaining));
    const insufficient: StoppingVerdict = {
      act: true,
      threshold: 0,
      value: v,
      remaining: k,
      optimalValue: 0,
      ruleValue: 0,
      prophet: 0,
      competitiveRatio: 0,
      samples: samples.length,
      basis: 'insufficient',
      interpretation: `经验不足（${samples.length}/${this.config.minSamples}）——弃权口径：不阻止行动，先积累机会分布`,
    };
    if (samples.length < this.config.minSamples) {
      return insufficient;
    }
    const { values } = backwardInduction(samples, k);
    const continuation = k >= 2 ? values[k - 2]! : mean(samples);
    const threshold = continuation * this.config.thresholdMultiplier;
    const sc = samuelCahnRule(samples, k);
    const competitiveRatio = sc.prophet > 1e-12 ? sc.ruleValue / sc.prophet : 0;
    const act = v >= threshold;
    const verdict: StoppingVerdict = {
      act,
      threshold: round(threshold),
      value: round(v),
      remaining: k,
      optimalValue: round(values[k - 1]!),
      ruleValue: round(sc.ruleValue),
      prophet: round(sc.prophet),
      competitiveRatio: round(competitiveRatio),
      samples: samples.length,
      basis: 'backward-induction',
      interpretation: act
        ? `现值 ${v.toFixed(3)} ≥ 继续价值 ${threshold.toFixed(3)}（剩 ${k} 次机会的最优接受线，${samples.length} 样本精确归纳）——立即行动即最优`
        : `现值 ${v.toFixed(3)} < 继续价值 ${threshold.toFixed(3)}（等下一个机会期望更优；先知上界 ${sc.prophet.toFixed(3)}，单阈值规则成色 ${(competitiveRatio * 100).toFixed(0)}%）——等待有数学价格`,
    };
    this.recent.push({ context, at: Date.now(), act, value: round(v), threshold: round(threshold), competitiveRatio: round(competitiveRatio) });
    if (this.recent.length > 50) this.recent.shift();
    return verdict;
  }

  /** 最近裁决审计 */
  recentVerdicts(limit = 10) {
    return this.recent.slice(-limit);
  }
}

// ─────────────────────────── 工具 ───────────────────────────

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** 六位小数圆整（项目统一展示口径） */
function round(x: number): number {
  return Number(x.toFixed(6));
}
