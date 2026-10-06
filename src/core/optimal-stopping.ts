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
 *
 * ── R5 第五轮世界性进化（四轴）──
 *
 * A1【数学进化】k 选择先知不等式（Samuel-Cahn 1984 的 k 选择推广，
 *    Hajiaghayi–Kleinberg–Sandholm 2007 谱系）：允许在线**至多选 k 个**
 *    机会（k 次行动预算），先知取 n 个 i.i.d. 抽样中最高的 k 个之和。
 *      · prophetTopK：E[top-k 之和] 精确计算——非负值上的线性恒等式
 *          sum-of-top-k = ∫₀^∞ min(k, #{Xᵢ ≥ t}) dt
 *        在经验分布上分段精确（q(t) 阶梯 → 每段 #{X ≥ t} ~ Bin(n, q)，
 *        段宽 × E[min(k, Bin)] 闭式求和，无近似）；
 *      · kSelectionValue：最优在线策略的二维向后归纳
 *          V(j, c) = E[max(V(j−1,c), X + V(j−1,c−1))]
 *        仍是阈值策略（θ(j,c) = V(j−1,c) − V(j−1,c−1)）；k=1 时与既有
 *        backwardInduction 逐位一致（跨代一致性锚点）；
 *      · 单阈值规则（首 k 个 ≥ τ 者即取）的期望所得由强制策略精确
 *        向后归纳逐抽样递推——k/(k+1) 竞争比的定理载体。
 * A3【数值稳健】E[min(k, Bin(n,p))] 的尾部概率 P(B ≥ b) 全程对数域
 *    （b·ln p + (n−b)·ln(1−p)，log1p/expm1 口径；组合数迭代精确到
 *    double）：小 p / 大 n 下 pᵇ(1−p)ⁿ⁻ᵇ 直接连乘会下溢丢尾，对数域
 *    保持满精度（新代码口径；既有函数数值逐位不动）。
 * A4【性质测试】① 包络：V_online(n,k) ≤ prophetTopK(n,k)（任何在线
 *    策略 ≤ 先知）；② k 单调：V(n,k) ≤ V(n,k+1)、prophet 同理；
 *    ③ k=1 与 backwardInduction 逐位一致；④ 成色下界：k=1 时
 *    online/prophet ≥ 1/2（Samuel-Cahn），k ≥ 2 时 ≥ k/(k+1)——
 *    种子化 200+ 例验证（verify-r5-planning.mjs）。
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

// ─────────────────────────── R5：k 选择先知不等式 ───────────────────────────

/**
 * E[min(k, B)]，B ~ Binomial(n, p)——k 选择先知量值的积木。
 *
 * 恒等式：E[min(k,B)] = Σ_{b=1}^{min(k,n)} P(B ≥ b)（min 截断的期望 =
 * 尾概率求和）。尾部概率 P(B ≥ b) = Σ_{j≥b} C(n,j)pʲ(1−p)ⁿ⁻ʲ 走对数域：
 * ln C(n,j) + j·ln p + (n−j)·ln(1−p)（组合数沿 j 迭代连乘，double 内精确；
 * p→0/1 端点闭式处理）——小 p 大 n 下连乘下溢时仍保满精度（轴 3）。
 */
export function expectedMinBinomial(k: number, n: number, p: number): number {
  if (!Number.isFinite(k) || k < 0) throw new Error(`expectedMinBinomial: k=${String(k)} 需为非负数`);
  if (!Number.isInteger(n) || n < 0) throw new Error(`expectedMinBinomial: n=${String(n)} 需为非负整数`);
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error(`expectedMinBinomial: p=${String(p)} 需 ∈ [0,1]`);
  const kk = Math.min(k, n);
  if (kk <= 0 || n === 0) return 0;
  if (p === 0) return 0;
  if (p === 1) return kk;
  if (kk >= n) return n * p; // E[B]（min 不起作用）
  // pmf(j) = C(n,j) p^j (1-p)^(n-j)：j=0 起迭代，尾部概率累加
  const lnP = Math.log(p);
  const ln1mP = Math.log1p(-p);
  let pmf = Math.exp(n * ln1mP); // j = 0
  let binom = 1; // C(n,0)
  let tail = 1; // P(B ≥ 0)
  let sum = 0;
  for (let b = 1; b <= kk; b += 1) {
    // P(B ≥ b) = tail_{b-1} − pmf(b−1)
    const pGeB = Math.max(0, tail - pmf);
    sum += pGeB;
    // 推进到 j = b：pmf(b) = pmf(b−1)·(n−b+1)/b·p/(1−p)（对数域组合更稳）
    binom = (binom * (n - b + 1)) / b;
    pmf = Math.exp(Math.log(binom) + b * lnP + (n - b) * ln1mP);
    tail = pGeB;
  }
  return sum;
}

/**
 * 先知价值 E[n 个 i.i.d. 抽样的 top-k 之和]（k 选择版先知，经验分布精确）。
 *
 * 非负值线性恒等式：Σ_top-k = ∫₀^∞ min(k, #{Xᵢ ≥ t}) dt。经验分布下
 * q(t) = P(X ≥ t) 是阶梯函数（在排序样本的相邻值之间恒定），故积分
 * 分段精确：段 [s_(j−1), s_(j)] 上 q = (m−j+1)/m、N(t) ~ Bin(n, q)。
 * @param samples 经验样本（0~1 机会价值；负值截 0——积分口径需要非负）
 */
export function prophetTopK(samples: readonly number[], n: number, k: number): number {
  const m = samples.length;
  if (!Number.isInteger(n) || n <= 0) throw new Error(`prophetTopK: n=${String(n)} 需为正整数`);
  if (!Number.isInteger(k) || k <= 0) throw new Error(`prophetTopK: k=${String(k)} 需为正整数`);
  if (m === 0) return 0;
  if (k >= n) {
    // 全选：top-n = 之和的期望 = n·E[X]
    return (n * samples.reduce((s, x) => s + Math.max(0, x), 0)) / m;
  }
  const sorted = [...samples].map((x) => Math.max(0, x)).sort((a, b) => a - b);
  let expected = 0;
  for (let j = 1; j <= m; j += 1) {
    const lower = j >= 2 ? sorted[j - 2]! : 0; // 首段下界 0（非负值积分域）
    const width = sorted[j - 1]! - lower;
    if (width <= 0) continue;
    const q = (m - j + 1) / m; // t ∈ (s_(j−1), s_(j)] 上 P(X ≥ t)
    expected += width * expectedMinBinomial(k, n, q);
  }
  return expected;
}

/**
 * 最优在线 k 选择价值 V(n, k)（二维向后归纳，经验测度精确）。
 *
 * V(j, c) = 还剩 j 次抽样、c 个名额的期望所得；
 *   V(0, c) = V(j, 0) = 0；
 *   V(j, c) = E[max(V(j−1,c), X + V(j−1,c−1))]——见值即决的阈值策略：
 *   当前值 ≥ θ(j,c) = V(j−1,c) − V(j−1,c−1) 即收下（占一个名额）。
 * k=1 时 V(j,1) = E[max(V(j−1,1), X)] 与既有 backwardInduction 逐位一致。
 */
export function kSelectionValue(samples: readonly number[], n: number, k: number): { value: number; thresholds: number[][] } {
  const m = samples.length;
  if (!Number.isInteger(n) || n <= 0) throw new Error(`kSelectionValue: n=${String(n)} 需为正整数`);
  if (!Number.isInteger(k) || k <= 0) throw new Error(`kSelectionValue: k=${String(k)} 需为正整数`);
  if (m === 0) return { value: 0, thresholds: [] };
  const kk = Math.min(k, n);
  const xs = samples.map((x) => Math.max(0, x));
  // prev[c] = V(j−1, c)；cur[c] = V(j, c)（c = 0..kk）
  let prev = new Array<number>(kk + 1).fill(0);
  const thresholds: number[][] = [];
  for (let j = 1; j <= n; j += 1) {
    const cur = new Array<number>(kk + 1).fill(0);
    const thetaRow = new Array<number>(kk + 1).fill(0);
    for (let c = 1; c <= kk; c += 1) {
      const theta = prev[c]! - prev[c - 1]!; // 收下门槛（含名额机会成本）
      thetaRow[c] = theta;
      let acc = 0;
      for (const x of xs) acc += Math.max(prev[c]!, x + prev[c - 1]!);
      cur[c] = acc / m;
    }
    thresholds.push(thetaRow);
    prev = cur;
  }
  return { value: prev[kk]!, thresholds };
}

/**
 * k 选择单阈值规则：取首个 ≥ τ 的值（至多收 k 个）。τ 的选取——
 * 经验分布在原子处跳跃，纯确定性 τ 只能做到 E[录取数] ≤ k；定理的
 * 精确口径是 **E[录取数] = k**：取 τ_high = 满足 n·P(X ≥ τ) ≤ k 的最小
 * 样本值、τ_low = 其下一档样本值，以混合权重 α = (k − E_high)/(E_low − E_high)
 * 随机化（规则值对混合概率线性——两次强制策略值的凸组合即精确期望）。
 * 规则期望所得由**强制策略精确向后归纳**逐抽样递推（规则是「见 ≥ τ 即收、
 * 名额满即止」的固定策略）：
 *   W(j, c) = (1/m) Σᵢ [ xᵢ ≥ τ ? xᵢ + W(j−1, c−1) : W(j−1, c) ]
 *（注意：∫ min(k, #{X ≥ max(τ,t)})dt 算的是「截尾值的 top-k」而非
 *  「到达序的前 k 个」——前者是规则值的上界，不是规则值本身；本实现
 *  用逐抽样精确递推，无此歧义）。
 * 定理（HKS 2007 谱系）：E[录取数] = k 的单阈值规则满足
 * E[规则] ≥ k/(k+1)·E[top-k 先知]——k=1 退化为 Samuel-Cahn 的 1/2 界。
 * @returns threshold 主阈值 τ_high；mix = τ_low 的混合权重（0 = 纯 τ_high）
 */
export function kSelectionThresholdRule(samples: readonly number[], n: number, k: number): { threshold: number; ruleValue: number; prophet: number; mix: number } {
  const m = samples.length;
  if (!Number.isInteger(n) || n <= 0) throw new Error(`kSelectionThresholdRule: n=${String(n)} 需为正整数`);
  if (!Number.isInteger(k) || k <= 0) throw new Error(`kSelectionThresholdRule: k=${String(k)} 需为正整数`);
  if (m === 0) return { threshold: 0, ruleValue: 0, prophet: 0, mix: 0 };
  const kk = Math.min(k, n);
  const xs = samples.map((x) => Math.max(0, x));
  const sorted = [...xs].sort((a, b) => a - b);

  /** 强制策略精确递推（c = 0 行恒 0） */
  const forcedRuleValue = (tau: number): number => {
    let prev = new Array<number>(kk + 1).fill(0);
    for (let j = 1; j <= n; j += 1) {
      const cur = new Array<number>(kk + 1).fill(0);
      for (let c = 1; c <= kk; c += 1) {
        const skip = prev[c]!;
        const take = prev[c - 1]!;
        let acc = 0;
        for (const x of xs) acc += x >= tau ? x + take : skip;
        cur[c] = acc / m;
      }
      prev = cur;
    }
    return prev[kk]!;
  };

  // τ_high：最小样本值 s_(i) 使 n·(m−i+1)/m ≤ k（期望录取数 ≤ k）
  let iStar = m; // 缺省取最大值（最保守）
  for (let i = 1; i <= m; i += 1) {
    if ((n * (m - i + 1)) / m <= kk + 1e-12) {
      iStar = i;
      break;
    }
  }
  const tauHigh = sorted[iStar - 1]!;
  const countHigh = (n * (m - iStar + 1)) / m;
  // E[录取数] 已恰为 k（或 τ_low 不存在）→ 纯 τ_high；否则凸组合到 = k
  if (countHigh >= kk - 1e-12 || iStar === 1) {
    return { threshold: tauHigh, ruleValue: forcedRuleValue(tauHigh), prophet: prophetTopK(samples, n, kk), mix: 0 };
  }
  const tauLow = sorted[iStar - 2]!;
  const countLow = (n * (m - iStar + 2)) / m;
  const mix = (kk - countHigh) / (countLow - countHigh);
  const ruleValue = (1 - mix) * forcedRuleValue(tauHigh) + mix * forcedRuleValue(tauLow);
  return { threshold: tauHigh, ruleValue, prophet: prophetTopK(samples, n, kk), mix };
}

/** k 选择先知不等式全景报告（A1 三件套的汇合口径） */
export interface KSelectionReport {
  /** 名额数（有效值 min(k,n)） */
  k: number;
  /** 未来机会抽样次数 */
  n: number;
  /** 最优在线价值（二维向后归纳精确） */
  onlineValue: number;
  /** 先知价值 E[top-k]（积分恒等式精确） */
  prophetValue: number;
  /** 最优在线成色 = online/prophet */
  competitiveRatio: number;
  /** 定理下界 k/(k+1) */
  guarantee: number;
  /** 单阈值规则的 τ */
  threshold: number;
  /** 单阈值规则期望所得（精确） */
  ruleValue: number;
  /** 单阈值规则成色 */
  ruleRatio: number;
}

/**
 * k 选择先知不等式：一次给出最优在线、单阈值规则与先知三个精确量。
 *
 * 包络链：ruleValue ≤ onlineValue ≤ prophetValue（在线 ≤ 先知，规则 ≤
 * 最优在线）；定理成色：onlineValue ≥ (k/(k+1))·prophetValue。
 */
export function kSelectionProphet(samples: readonly number[], n: number, k: number): KSelectionReport {
  const kkRaw = Math.min(k, n);
  const { value: online } = kSelectionValue(samples, n, kkRaw);
  const { threshold, ruleValue, prophet } = kSelectionThresholdRule(samples, n, kkRaw);
  return {
    k: kkRaw,
    n,
    onlineValue: round(online),
    prophetValue: round(prophet),
    competitiveRatio: prophet > 1e-12 ? round(online / prophet) : 0,
    guarantee: kkRaw / (kkRaw + 1),
    threshold: round(threshold),
    ruleValue: round(ruleValue),
    ruleRatio: prophet > 1e-12 ? round(ruleValue / prophet) : 0,
  };
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
    // 继续价值 = 剩 k 次机会的归纳值 V_k。backwardInduction 的 values 按
    // 「剩余机会数降序」存放（values[0] = V_k，末位 = V₁——与 verify-frontier-
    // kernels 的 V₁=values[1]、V₂=values[0] 口径一致）：此前误取 values[k−2]，
    // 对一切 k ≥ 2 恒等于 V₂，k 越大越低估等待价值（违反文档合同
    // act = (value ≥ V_remaining) 与「机会越多越挑剔」的单调性）。
    const continuation = values[0]!;
    const threshold = continuation * this.config.thresholdMultiplier;
    const sc = samuelCahnRule(samples, k);
    const competitiveRatio = sc.prophet > 1e-12 ? sc.ruleValue / sc.prophet : 0;
    const act = v >= threshold;
    const verdict: StoppingVerdict = {
      act,
      threshold: round(threshold),
      value: round(v),
      remaining: k,
      // 文档口径 V_k（剩 k 次机会的归纳值 = values[0]）——与 threshold 同源，
      // 原先误读 values[k−1]（实为 V₁ = 均值）
      optimalValue: round(values[0]!),
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

/** 六位小数圆整（项目统一展示口径） */
function round(x: number): number {
  return Number(x.toFixed(6));
}
