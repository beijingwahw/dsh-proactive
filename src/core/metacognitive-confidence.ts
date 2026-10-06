/**
 * 97.0 元认知信心内核 —— metacognitive confidence：知道自己不知道（二阶信号检测论）
 *
 * 动机: 系统的「判别力」（一阶：能不能把信号和噪声分开）和「对自己判别的
 * 监察力」（二阶：知不知道这次判对了没有）是两种独立的能力——实验心理学
 * 里同一个人可以在 d′=2.0 的任务上信心全无，也可以在 d′=0.3 的任务上
 * 信心满满。调度系统同理：模型给出的 confidence 若不经过二阶检验，就只是
 * 一个未经对账的内部数值——「什么时候该问用户」（ask-user）这个决策没有
 * 诚实的前提：过度自信的系统永不求助（错到用户头上），过度自卑的系统
 * 事事都问（把成本问爆）。本内核把「信心」变成可测量、可校验、可决策
 * 的二阶统计量：知道 ① 判别力有多少（d′）；② 对判别的自知力有多少
 * （meta-d′ ≤ d′，比值即元认知效率）；③ 每一档信心对应的真实错误率
 * （信心-准确率曲线）；④ 在错误代价与求助代价之间，闭式解出「值得问」
 * 的信心阈值。
 *
 * 数学（二阶信号检测论 Type-2 SDT）:
 *   ① 一阶 d′（对数口径稳定化）: 信号/噪声两类试验，内部证据 x ~
 *      N(±d/2, 1)，判「信号」当 x > 0。命中率 HR = hits/nSignal、虚报率
 *      FAR = fa/nNoise，则 d′ = Z(HR) − Z(FAR)、判定偏置 c =
 *      −(Z(HR)+Z(FAR))/2。小样本下 0/1 率把 Z 打到 ±∞——用 Hautus 对数
 *      线性稳定化 HR = (hits+0.5)/(nSignal+1)（有偏 O(1/n)、方差骤降，
 *      是 SDT 文献的标准口径）。已知 d 的工厂数据上 d̂′ 收敛回 d（锚点①）。
 *   ② meta-d′（Galvin 重叠法 / 面积反演简化口径，推导如下）:
 *      型-2 ROC——以信心为评分、以「本次一阶判别对/错」为类别扫阈值，
 *      得到的 ROC 面积 A₂ = P(conf_对 > conf_错)（Mann–Whitney U 口径，
 *      平局计 0.5）。理想观察者（敏感度 m，信心取 |证据| 的任意单调函数）
 *      的 A₂ 有解析积分：令 μ = m/2，反射对称后两类各归约为
 *      z ~ N(μ,1) 的正确类 z|z>0 与错误类 z|z<0，信心序即 |z| 序，
 *        A₂*(m) = [1/(Φ(μ)·(1−Φ(μ)))] ∫₀^∞ [Φ(−μ) − Φ(−z−μ)]·φ(z−μ) dz
 *      （正确试验的 |z| 压过错误试验 |z| 的概率；分子是「错误类 z<0 的
 *      条件密度落在 (−z_c, 0) 内」对正确类密度的加权积分。m=0 时两类
 *      |z| 同分布 → A₂* = 0.5；m→∞ 时错误试验的 |z| 堆在 0 附近、正确
 *      试验堆在 m 附近 → A₂* → 1）。
 *      meta-d′ := 反演 A₂* 的 m——「多敏感的理想观察者才会给出这样的
 *      信心-对错重叠结构」。数据处理不等式保证：信心读数若带噪
 *      （conf ∝ |x+ε|），则 A₂ ≤ A₂*(d) ⟹ meta-d′ ≤ d′；等号当且仅当
 *      信心无噪地跟随一阶证据。相比 Maniscalco–Lau 的 MLE 拟合（离散
 *      评级、数值易病态），本口径连续、稳健、O(n log n)，偏差来源
 *      （积分离散化 + 抽样噪声）在文件内文档化。
 *   ③ 信心生成的「noisy signal + confidence kernel」工厂: 一阶证据
 *      x ~ N(S·d/2, 1)，二阶读数 y = x + ε，ε ~ N(0, σ²)，信心 =
 *      1 − exp(−|y|)（任意单调核不改变 meta-d′——面积口径只依赖序）。
 *      σ 的标定取启发式 meta-d′ ≈ d/√(1+σ²)（把含噪读数折算成低敏感度
 *      的理想观察者）⟹ σ = √((d/metaD)² − 1)，metaD = d 时 σ = 0（纯
 *      理想观察者）。注意正确性由 sign(x) 定而信心读 |y|，实测 meta-d′
 *      略低于名义目标（方向单调、四象限分离不受影响——锚点只断言分离
 *      与上限，不断言点恢复，诚实边界）。
 *   ④ 最优求助决策（期望成本最小化的闭式阈值）: 设信心 c 为校准的
 *      主观判对概率，当前部署域的先验错误率 q；贝叶斯合成后验判对优势
 *      odds = (c/(1−c))·((1−q)/q)。问（求助）当且仅当
 *        P(error|c)·costError > costAsk
 *      其中 costAsk 已含「问一次的全部代价」（打断 + 等待延迟的折现——
 *      规格 P(该问)×延迟 项与阈值自指，按期望决策论标准折入 costAsk，
 *      二阶项不另列）。解出闭式:
 *        c* = σ( logit(1 − costAsk/costError) − logit(1 − q) )
 *      q = 0.5（无信息先验）时退化为 c* = 1 − costAsk/costError；
 *      错误越罕见（q 小）越不值得问（c* 越低），与全阈值枚举的最优
 *      期望成本一致（锚点③，解析驻点 P(error|c*) = costAsk/costError）。
 *
 * 验证锚点（scripts/verify-metacognition-replay.mjs）:
 *   ① 工厂已知 d′=1.5（及 0.6）: typeOneDprime 从命中/虚报计数恢复
 *      d̂′ = d ± 0.1，命中率 ≈ Φ(d/2)（解析对照）；
 *   ② 四象限分离: (d=1.5, metaD=1.5) 与 (d=0.6, metaD=0.6) 的高元认知
 *      象限 meta-d′̂ ≈ d；同名 d、metaD 压低的象限（1.5/0.5、0.6/0.2）
 *      meta-d′̂ 显著低于 d（判别好但自知差被正确量化）；
 *   ③ 最优 ask 阈值: 与 [0,1] 全阈值枚举的期望成本最小值一致（解析驻点
 *      P(error|c*) = costAsk/costError 精确成立，枚举 argmin 与 c* 贴合
 *      到网格分辨率）；
 *   ④ P(error|c) 随信心分桶单调下降（校准方向的信心-准确率曲线，
 *      Spearman 显著为正；高元认知数据的相关强于低元认知数据）；
 *   ⑤ 退化为 75.0 的接口: (信心, 对错) 对即 75.0 的 CalibrationPair
 *      口径——信心序列做分桶经验重映射（mini 校准器）后 ECE 下降
 *      （ECE 计算在验证脚本内独立实现，不 import 75.0）。
 *
 * 应用: 决策引擎 ask-user 与反思触发——「知道自己不知道」才求助（与
 *   84.0 信念价值、95.0 交接成本合龙）；信心-准确率曲线作为自模型
 *   （meta/self-model）的常驻仪表。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 *
 * ── R5 第五轮世界性进化（四轴）──
 *
 * A1a【数学进化】二阶 ROC 的参数拟合（metaDprimeFit）：型-2 ROC 的
 *   观测点（以信心扫阈值的 (FAR₂, HR₂) 曲线）对理想观察者参数化族做
 *   最小二乘拟合。理想观察者闭式曲线（μ = m/2，t 为证据尺度阈值）：
 *     HR₂(t; μ) = Φ(μ−t)/Φ(μ)      （正确试验 z>0 | z~N(μ,1)）
 *     FAR₂(t; μ) = Φ(−t−μ)/Φ(−μ)   （错误试验 z<0 的 |z| 尾概率）
 *   一维目标 J(μ) = Σ[(HRobs−HRmod)² + (FARobs−FARmod)²] 黄金分割定
 *   量收敛（纯确定性优化）；meta-d′ = 2μ̂。与面积反演（metaDprime 的
 *   Mann–Whitney 口径）互为独立估计——零噪声工厂两者都 ≈ d，含噪时
 *   一致显著低于 d（verify 脚本 ≥200 种子对照）。
 *
 * A1b【数学进化】信心的贝叶斯最优报告（bayesOptimalReport）：给定
 *   「真实判对概率 p 的校准后验」Beta(α,β)，Brier 与对数评分两族
 *   proper scoring rule 下的最优点报告同为后验均值闭式
 *     r* = E[p] = α/(α+β)；且 Brier(r) − Brier(r*) = (r − r*)²（精确恒等式）
 *   已校准代理（r* = 内部信心 c）时报诚实值；未校准时代价恰为平方偏差
 *   ——「报告校准」的信息论价值第一次有精确账目。下游 ask 阈值的决策
 *   一致性（c 与 r* 是否落在阈值同侧）一并读出。
 *
 * A3【数值稳健】posteriorErrorProbability 改为全程对数域：
 *   ln odds(correct) = logit(c) + logit(1−q)，P(error) = σ(−ln odds)——
 *   极端 c/q 组合不再产生中间量下溢/上溢；常规区间与旧公式相差 < 1e-12
 *   （verify 脚本网格对照），既有锚点全部保持。
 */

// ─────────────────────────── 确定性随机源（文件内自带） ───────────────────────────

/** mulberry32 —— 本内核唯一随机源（同 seed 同输出，零宿主依赖） */
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

/** Box–Muller 高斯工厂（缓存副产物 cos/sin 对，期望每样本消耗 1 个均匀数） */
function makeGaussian(seed: number): () => number {
  const rng = mulberry32(seed);
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    do {
      u = rng();
    } while (u <= 1e-12);
    const v = rng();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

// ─────────────────────────── 正态工具（零依赖实现） ───────────────────────────

/** Abramowitz–Stegun 7.1.26 erf 近似（|ε| ≤ 1.5e-7） */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const y = 1 - poly * Math.exp(-ax * ax);
  return sign * y;
}

/** 标准正态 CDF Φ(x)（erf 近似口径，|ε| ≤ 7.5e-8） */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** 标准正态密度 φ(x) */
function normalPdf(x: number): number {
  return Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
}

/**
 * 标准正态分位数函数 Z(p) = Φ⁻¹(p)（Acklam 有理近似 + 一次 Halley 打磨，
 * |ε| ≲ 1e-9）。p 须落在开区间 (0,1)。
 */
export function probit(p: number): number {
  if (!Number.isFinite(p) || !(p > 0) || !(p < 1)) {
    throw new Error(`probit: p 须落在开区间 (0,1)（收到 ${p}）`);
  }
  const a1 = -39.69683028665376;
  const a2 = 220.9460984245205;
  const a3 = -275.9285104469687;
  const a4 = 138.357751867269;
  const a5 = -30.66479806614716;
  const a6 = 2.506628277459239;
  const b1 = -54.47609879822406;
  const b2 = 161.5858368580409;
  const b3 = -155.6989798598866;
  const b4 = 66.80131188771972;
  const b5 = -13.28068155288572;
  const c1 = -7.784894002430293e-3;
  const c2 = -0.3223964580411364;
  const c3 = -2.400758277161838;
  const c4 = -2.549732539343734;
  const c5 = 4.374664141464968;
  const c6 = 2.938163982698783;
  const d1 = 7.784695709041462e-3;
  const d2 = 0.3224671290700398;
  const d3 = 2.445134137142996;
  const d4 = 3.754408661907416;
  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) / ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x =
      (((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q /
      (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
      ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
  }
  // 一次 Halley 打磨：Φ 的近似残差被导数链吸收
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** 12 位小数舍入（参数拟合读出口径） */
function round12(x: number): number {
  return Number(x.toFixed(12));
}

/** logit（p 钳位 [1e-12, 1−1e-12]，避开 ±∞） */
function logit(p: number): number {
  const q = Math.min(1 - 1e-12, Math.max(1e-12, p));
  return Math.log(q / (1 - q));
}

// ─────────────────────────── ① 一阶 d′ ───────────────────────────

/** 一阶信号检测论读出（对数线性稳定化口径） */
export interface TypeOneResult {
  /** d′ = Z(HR) − Z(FAR) */
  dprime: number;
  /** 稳定化命中率 (hits+0.5)/(nSignal+1) */
  hitRate: number;
  /** 稳定化虚报率 (fa+0.5)/(nNoise+1) */
  falseAlarmRate: number;
  /** 判定偏置 c = −(Z(HR)+Z(FAR))/2（0 = 无偏） */
  criterion: number;
  nSignal: number;
  nNoise: number;
  hits: number;
  falseAlarms: number;
  /** 稳定化口径标记 */
  stabilized: 'log-linear';
}

/**
 * ① 一阶判别力 d′：信号命中率与噪声虚报率的 z 差。
 *
 * 对数线性稳定化（Hautus 2008）: HR = (hits+0.5)/(nSignal+1)、
 * FAR = (fa+0.5)/(nNoise+1)——全中/全虚报的退化计数不再把 z 打到 ±∞，
 * 代价 O(1/n) 的有偏（远小于抽样噪声）。d′ = Z(HR) − Z(FAR)。
 */
export function typeOneDprime(
  hits: number,
  falseAlarms: number,
  nSignal: number,
  nNoise: number,
): TypeOneResult {
  for (const [name, v] of [
    ['hits', hits],
    ['falseAlarms', falseAlarms],
    ['nSignal', nSignal],
    ['nNoise', nNoise],
  ] as const) {
    if (!Number.isFinite(v)) throw new Error(`typeOneDprime: ${name} 须为有限数（收到 ${v}）`);
  }
  if (!Number.isInteger(nSignal) || nSignal < 1) {
    throw new Error(`typeOneDprime: nSignal 须为 ≥1 的整数（收到 ${nSignal}）`);
  }
  if (!Number.isInteger(nNoise) || nNoise < 1) {
    throw new Error(`typeOneDprime: nNoise 须为 ≥1 的整数（收到 ${nNoise}）`);
  }
  if (hits < 0 || hits > nSignal) {
    throw new Error(`typeOneDprime: hits 须落在 [0, nSignal]=[0,${nSignal}]（收到 ${hits}）`);
  }
  if (falseAlarms < 0 || falseAlarms > nNoise) {
    throw new Error(`typeOneDprime: falseAlarms 须落在 [0, nNoise]=[0,${nNoise}]（收到 ${falseAlarms}）`);
  }
  const hitRate = (hits + 0.5) / (nSignal + 1);
  const falseAlarmRate = (falseAlarms + 0.5) / (nNoise + 1);
  const zHit = probit(hitRate);
  const zFa = probit(falseAlarmRate);
  return {
    dprime: zHit - zFa,
    hitRate,
    falseAlarmRate,
    criterion: -(zHit + zFa) / 2,
    nSignal,
    nNoise,
    hits,
    falseAlarms,
    stabilized: 'log-linear',
  };
}

// ─────────────────────────── ② meta-d′（型-2 面积反演） ───────────────────────────

/** 曼-惠特尼面积 P(x > y) + 0.5·P(x = y)（二样本排序合并口径） */
function mannWhitneyArea(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): number {
  const sortedY = [...ys].sort((a, b) => a - b);
  let total = 0;
  for (const x of xs) {
    // lowerBound: y < x 的个数；upperBound: y ≤ x 的个数（平均秩平局计 0.5）
    let lo = 0;
    let hi = sortedY.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedY[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    const less = lo;
    let lo2 = lo;
    let hi2 = sortedY.length;
    while (lo2 < hi2) {
      const mid = (lo2 + hi2) >> 1;
      if (sortedY[mid] <= x) lo2 = mid + 1;
      else hi2 = mid;
    }
    const equal = lo2 - less;
    total += less + 0.5 * equal;
  }
  return total / (xs.length * sortedY.length);
}

/** meta-d′ 反演上界（理想观察者敏感度的搜索上界；A₂*(8) > 1 − 1e-8） */
const META_D_MAX = 8;

/**
 * 理想观察者的型-2 ROC 面积 A₂*(m)（头注推导的解析积分，Simpson 数值化）。
 *
 *   A₂*(m) = [1/(Φ(μ)(1−Φ(μ)))] ∫₀^∞ [Φ(−μ) − Φ(−z−μ)]·φ(z−μ) dz，μ = m/2
 *
 * m = 0 时对称退化 A₂* = 0.5；m 增大时单调上升 → 1。积分域 [0,30]、
 * 6000 段 Simpson（h=0.005，误差 ≪ 1e-9，被积函数在 30 处已 < e^{-200}）。
 */
function idealType2Auc(m: number): number {
  const mu = m / 2;
  const pc = normalCdf(mu);
  const pe = 1 - pc;
  const f = (z: number): number => (normalCdf(-mu) - normalCdf(-z - mu)) * normalPdf(z - mu);
  const n = 6000;
  const h = 30 / n;
  let sum = f(0) + f(30);
  for (let i = 1; i < n; i += 1) {
    sum += (i % 2 === 0 ? 2 : 4) * f(i * h);
  }
  return (sum * h) / 3 / (pc * pe);
}

/** meta-d′ 估计读出 */
export interface MetaDprimeResult {
  /** 反演得到的 meta-d′（信心无噪跟随证据时 ≈ 一阶 d′） */
  metaDprime: number;
  /** 型-2 ROC 面积（Mann–Whitney U，正确 vs 错误试验的信心分离度） */
  auc: number;
  nCorrect: number;
  nError: number;
  /** A₂ 超过上界对应面积（meta-d′ 被钳在 META_D_MAX）时为 true */
  saturated: boolean;
}

/**
 * ② meta-d′：正确/错误试验信心分布的分离度（Galvin 重叠法的面积反演口径）。
 *
 * 输入任意单调尺度的信心值（面积口径只依赖序，[0,1] 与原始 |y| 等价）。
 * A₂ = Mann–Whitney U；meta-d′ = 使理想观察者 A₂*(m) = A₂ 的 m（二分
 * 反演）。meta-d′ ≤ d′ 恒成立（数据处理不等式），比值 meta-d′/d′ 即
 * 元认知效率 M-ratio。
 */
export function metaDprime(
  correctConfidences: ReadonlyArray<number>,
  errorConfidences: ReadonlyArray<number>,
): MetaDprimeResult {
  if (!Array.isArray(correctConfidences) || correctConfidences.length === 0) {
    throw new Error('metaDprime: correctConfidences 须为非空数组');
  }
  if (!Array.isArray(errorConfidences) || errorConfidences.length === 0) {
    throw new Error('metaDprime: errorConfidences 须为非空数组（零错误试验的分离度不可估计）');
  }
  for (const [name, arr] of [
    ['correctConfidences', correctConfidences],
    ['errorConfidences', errorConfidences],
  ] as const) {
    for (let i = 0; i < arr.length; i += 1) {
      if (!Number.isFinite(arr[i])) {
        throw new Error(`metaDprime: ${name}[${i}] 须为有限数（收到 ${arr[i]}）`);
      }
    }
  }
  const auc = mannWhitneyArea(correctConfidences, errorConfidences);
  if (auc <= 0.5) {
    // 信心与对错无分离（甚至反向）: 0 效率的诚实读数
    return { metaDprime: 0, auc, nCorrect: correctConfidences.length, nError: errorConfidences.length, saturated: false };
  }
  const aucMax = idealType2Auc(META_D_MAX);
  if (auc >= aucMax) {
    return { metaDprime: META_D_MAX, auc, nCorrect: correctConfidences.length, nError: errorConfidences.length, saturated: true };
  }
  let lo = 0;
  let hi = META_D_MAX;
  for (let iter = 0; iter < 80; iter += 1) {
    const mid = (lo + hi) / 2;
    if (idealType2Auc(mid) < auc) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return {
    metaDprime: (lo + hi) / 2,
    auc,
    nCorrect: correctConfidences.length,
    nError: errorConfidences.length,
    saturated: false,
  };
}

// ─────────────────────────── ②′ R5：型-2 ROC 参数拟合 ───────────────────────────

/** 型-2 ROC 单点：同一信心阈值下的观测与模型曲线对照 */
export interface Type2RocPoint {
  /** 信心阈值（原始信心尺度，分位数口径） */
  confidenceThreshold: number;
  /** 证据尺度阈值 t = −ln(1−c)（单调核 1−exp(−|y|) 的反演） */
  evidenceThreshold: number;
  /** 观测 P(conf > c | 正确试验) */
  observedHitRate: number;
  /** 观测 P(conf > c | 错误试验) */
  observedFalseAlarmRate: number;
  /** 模型 Φ(μ−t)/Φ(μ) */
  modelHitRate: number;
  /** 模型 Φ(−t−μ)/Φ(−μ) */
  modelFalseAlarmRate: number;
}

/** R5·A1a 参数拟合读出 */
export interface MetaDprimeFitResult {
  /** 拟合 meta-d′ = 2μ̂ */
  metaDprime: number;
  /** 拟合信心证据尺度 ŝ（=1 理想观察者；>1 = 信心读数被噪声放大） */
  fittedScale: number;
  /** 拟合残差 RMS（ROC 平面欧氏距离） */
  rmse: number;
  /** 拟合点（审计/画曲线） */
  points: Type2RocPoint[];
  nCorrect: number;
  nError: number;
  /** 与面积反演（metaDprime 的 Mann–Whitney 口径）的一致性参考 */
  aucAreaInversion: number;
}

/**
 * R5·A1a 二阶 ROC 参数拟合：观测 (FAR₂, HR₂) 点列对理想观察者族 +
 * 信心尺度参数的最小二乘拟合（确定性全局网格 + 坐标黄金分割细化）。
 *
 * 参数化族（μ = m/2，s = 信心证据尺度；t 为证据尺度阈值 = −ln(1−c)）：
 *   正确试验 z>0 | z~N(μ,1)，信心读数 ∝ s·|z|
 *     ⟹ HR₂(t; μ,s) = Φ(μ − t/s)/Φ(μ)
 *     ⟹ FAR₂(t; μ,s) = Φ(−t/s − μ)/Φ(−μ)
 * s 吸收信心读数的噪声放大（y = x + ε 的方差 1+σ² ⟹ ŝ ≈ √(1+σ²)）——
 * 没有尺度参数时含噪数据的尾巴概率会把 μ̂ 推向假高值。
 * 目标 J(μ,s) = Σ_k [(HRobs−HRmod)² + (FARobs−FARmod)²]；
 * μ ∈ [0,8] × s ∈ [0.15, 6.66]（对数格）粗网格定谷 + 坐标黄金分割细化
 * 至机器精度——确定性可复算。meta-d′ = 2μ̂；缺省阈值取合并信心分布的
 * 十分位（确定性），可显式注入。
 */
export function metaDprimeFit(
  correctConfidences: ReadonlyArray<number>,
  errorConfidences: ReadonlyArray<number>,
  opts?: { thresholds?: ReadonlyArray<number> },
): MetaDprimeFitResult {
  if (!Array.isArray(correctConfidences) || correctConfidences.length === 0) {
    throw new Error('metaDprimeFit: correctConfidences 须为非空数组');
  }
  if (!Array.isArray(errorConfidences) || errorConfidences.length === 0) {
    throw new Error('metaDprimeFit: errorConfidences 须为非空数组');
  }
  for (const arr of [correctConfidences, errorConfidences] as const) {
    for (let i = 0; i < arr.length; i += 1) {
      if (!Number.isFinite(arr[i])) throw new Error(`metaDprimeFit: 信心值须为有限数（收到 ${arr[i]}）`);
    }
  }
  let thresholds: number[];
  if (opts?.thresholds !== undefined) {
    if (!Array.isArray(opts.thresholds) || opts.thresholds.length === 0) {
      throw new Error('metaDprimeFit: thresholds 须为非空数组');
    }
    thresholds = [...opts.thresholds];
    for (const t of thresholds) {
      if (!Number.isFinite(t) || t <= 0 || t >= 1) {
        throw new Error(`metaDprimeFit: 阈值须落在开区间 (0,1)（收到 ${t}）`);
      }
    }
  } else {
    // 合并信心分布的十分位（k/10，k = 1..9）——确定性分位点
    const pooled = [...correctConfidences, ...errorConfidences].sort((a, b) => a - b);
    thresholds = [];
    for (let k = 1; k <= 9; k += 1) {
      const idx = Math.min(pooled.length - 1, Math.max(0, Math.round((k / 10) * pooled.length) - 1));
      const v = pooled[idx]!;
      if (v > 0 && v < 1 && !thresholds.some((t) => t === v)) thresholds.push(v);
    }
    if (thresholds.length < 2) {
      throw new Error('metaDprimeFit: 合并信心分布过于退化（可用分位阈值 < 2），无法拟合 ROC 曲线');
    }
  }

  // 观测点（conf > c 的严格超越口径）
  const observed = thresholds.map((c) => {
    let hc = 0;
    for (const v of correctConfidences) if (v > c) hc += 1;
    let he = 0;
    for (const v of errorConfidences) if (v > c) he += 1;
    return {
      c,
      t: -Math.log(1 - c),
      hr: hc / correctConfidences.length,
      far: he / errorConfidences.length,
    };
  });

  const modelHr = (t: number, mu: number, s: number): number => {
    const denom = normalCdf(mu);
    return denom <= 1e-300 ? 1 : normalCdf(mu - t / s) / denom;
  };
  const modelFar = (t: number, mu: number, s: number): number => {
    const denom = normalCdf(-mu);
    return denom <= 1e-300 ? 1 : normalCdf(-t / s - mu) / denom;
  };
  const J = (mu: number, s: number): number => {
    let sum = 0;
    for (const p of observed) {
      const dh = p.hr - modelHr(p.t, mu, s);
      const df = p.far - modelFar(p.t, mu, s);
      sum += dh * dh + df * df;
    }
    return sum;
  };
  // 全局确定性最小化（μ,s）：粗网格定谷 + 坐标黄金分割细化。
  // （J 在含噪数据下可多谷——纯下降法不保证全局；网格 × 细化确定性可复算。）
  const MU_GRID = 64;
  const S_GRID = 40;
  const sLo = 0.15;
  const sHi = 6.66;
  let bestMu = 0;
  let bestS = 1;
  let bestJ = Number.POSITIVE_INFINITY;
  for (let gi = 0; gi <= MU_GRID; gi += 1) {
    const mu = (8 * gi) / MU_GRID;
    for (let gj = 0; gj <= S_GRID; gj += 1) {
      const s = sLo * Math.pow(sHi / sLo, gj / S_GRID);
      const j = J(mu, s);
      if (j < bestJ) {
        bestJ = j;
        bestMu = mu;
        bestS = s;
      }
    }
  }
  // 坐标黄金分割细化（μ 与 s 交替，3 轮）
  const invPhi = (Math.sqrt(5) - 1) / 2;
  const refine = (fixed: 'mu' | 's', lo: number, hi: number): { x: number; f: number } => {
    let a = lo;
    let b = hi;
    let x1 = b - invPhi * (b - a);
    let x2 = a + invPhi * (b - a);
    let f1 = fixed === 'mu' ? J(x1, bestS) : J(bestMu, x1);
    let f2 = fixed === 'mu' ? J(x2, bestS) : J(bestMu, x2);
    for (let iter = 0; iter < 200 && b - a > 1e-12; iter += 1) {
      if (f1 <= f2) {
        b = x2;
        x2 = x1;
        f2 = f1;
        x1 = b - invPhi * (b - a);
        f1 = fixed === 'mu' ? J(x1, bestS) : J(bestMu, x1);
      } else {
        a = x1;
        x1 = x2;
        f1 = f2;
        x2 = a + invPhi * (b - a);
        f2 = fixed === 'mu' ? J(x2, bestS) : J(bestMu, x2);
      }
    }
    const x = (a + b) / 2;
    return { x, f: fixed === 'mu' ? J(x, bestS) : J(bestMu, x) };
  };
  const muStep = 8 / MU_GRID;
  const sStep = Math.sqrt((sLo * Math.pow(sHi / sLo, 1 / S_GRID)) / (sLo * Math.pow(sHi / sLo, -1 / S_GRID))); // 相邻格比的开方
  for (let round = 0; round < 3; round += 1) {
    const rMu = refine('mu', Math.max(0, bestMu - muStep), Math.min(8, bestMu + muStep));
    if (rMu.f < bestJ) {
      bestJ = rMu.f;
      bestMu = rMu.x;
    }
    const rS = refine('s', Math.max(sLo, bestS / sStep), Math.min(sHi, bestS * sStep));
    if (rS.f < bestJ) {
      bestJ = rS.f;
      bestS = rS.x;
    }
  }
  const muHat = bestMu;
  const sHat = bestS;
  const points: Type2RocPoint[] = observed.map((p) => ({
    confidenceThreshold: round12(p.c),
    evidenceThreshold: round12(p.t),
    observedHitRate: round12(p.hr),
    observedFalseAlarmRate: round12(p.far),
    modelHitRate: round12(modelHr(p.t, muHat, sHat)),
    modelFalseAlarmRate: round12(modelFar(p.t, muHat, sHat)),
  }));
  const mse = observed.reduce((s, p) => {
    const dh = p.hr - modelHr(p.t, muHat, sHat);
    const df = p.far - modelFar(p.t, muHat, sHat);
    return s + dh * dh + df * df;
  }, 0) / observed.length;
  return {
    metaDprime: round12(2 * muHat),
    fittedScale: round12(sHat),
    rmse: round12(Math.sqrt(mse)),
    points,
    nCorrect: correctConfidences.length,
    nError: errorConfidences.length,
    aucAreaInversion: metaDprime(correctConfidences, errorConfidences).metaDprime,
  };
}

// ─────────────────────────── ③ 信心-准确率曲线 ───────────────────────────

/** 一条型-2 观测：信心值与一阶判别对错 */
export interface ConfidenceOutcomePair {
  confidence: number;
  correct: boolean;
}

/** 信心分桶（type-2 ROC 思想：每一档信心的真实对错频率） */
export interface ConfidenceBucket {
  lo: number;
  hi: number;
  n: number;
  /** 桶内平均信心 */
  meanConfidence: number;
  /** 桶内判对率 P(correct | confidence ∈ bucket) */
  accuracy: number;
}

export interface ConfidenceAccuracyReport {
  t: number;
  bins: number;
  buckets: ConfidenceBucket[];
  overallAccuracy: number;
  /** 非空桶的准确率是否随信心单调不减 */
  monotoneNondecreasing: boolean;
  /** 相邻非空桶准确率下降的违例数 */
  violations: number;
  /** 信心与对错的 Spearman 秩相关（平局取平均秩） */
  spearman: number;
}

/** 平均秩（并列取均值），供 Spearman 使用 */
function averageRanks(sorted: ReadonlyArray<number>): number[] {
  const ranks: number[] = new Array(sorted.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[i]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[k] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Spearman 秩相关（Pearson on ranks，平局平均秩） */
function spearmanCorrelation(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): number {
  const n = xs.length;
  const order = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const rankX = new Array<number>(n);
  const avgX = averageRanks(order.map((o) => o.v));
  for (let pos = 0; pos < n; pos += 1) rankX[order[pos].i] = avgX[pos];
  const orderY = ys.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const rankY = new Array<number>(n);
  const avgY = averageRanks(orderY.map((o) => o.v));
  for (let pos = 0; pos < n; pos += 1) rankY[orderY[pos].i] = avgY[pos];
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += rankX[i];
    sy += rankY[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = rankX[i] - mx;
    const b = rankY[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

/**
 * ③ 信心-准确率曲线：分桶对账「每一档信心下真的对了多少」。
 *
 * P(error|c) 单调下降 ⟺ 非空桶准确率单调不减（校准方向的必要条件；
 * 完全校准 E[accuracy(c)] = c 由 75.0 的 ECE 口径负责，见锚点⑤）。
 * bins 等宽、左闭右开、末桶闭。
 */
export function confidenceAccuracyCurve(
  pairs: ReadonlyArray<ConfidenceOutcomePair>,
  bins = 10,
): ConfidenceAccuracyReport {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error('confidenceAccuracyCurve: pairs 须为非空数组');
  }
  if (!Number.isInteger(bins) || bins < 1 || bins > 1000) {
    throw new Error(`confidenceAccuracyCurve: bins 须为 1..1000 的整数（收到 ${bins}）`);
  }
  const counts = Array.from({ length: bins }, () => 0);
  const sumC = Array.from({ length: bins }, () => 0);
  const sumCorrect = Array.from({ length: bins }, () => 0);
  for (const pair of pairs) {
    if (pair === null || typeof pair !== 'object') {
      throw new Error('confidenceAccuracyCurve: 每条 pair 须为 {confidence, correct} 对象');
    }
    if (!Number.isFinite(pair.confidence) || pair.confidence < 0 || pair.confidence > 1) {
      throw new Error(`confidenceAccuracyCurve: confidence 须落在 [0,1]（收到 ${pair.confidence}）`);
    }
    if (typeof pair.correct !== 'boolean') {
      throw new Error(`confidenceAccuracyCurve: correct 须为 boolean（收到 ${String(pair.correct)}）`);
    }
    const idx = Math.min(bins - 1, Math.floor(pair.confidence * bins));
    counts[idx] += 1;
    sumC[idx] += pair.confidence;
    sumCorrect[idx] += pair.correct ? 1 : 0;
  }
  const buckets: ConfidenceBucket[] = [];
  for (let b = 0; b < bins; b += 1) {
    const n = counts[b];
    buckets.push({
      lo: b / bins,
      hi: (b + 1) / bins,
      n,
      meanConfidence: n === 0 ? Number.NaN : sumC[b] / n,
      accuracy: n === 0 ? Number.NaN : sumCorrect[b] / n,
    });
  }
  let violations = 0;
  const nonEmpty = buckets.filter((b) => b.n > 0);
  for (let i = 1; i < nonEmpty.length; i += 1) {
    if (nonEmpty[i].accuracy < nonEmpty[i - 1].accuracy - 1e-12) violations += 1;
  }
  const spearman = spearmanCorrelation(
    pairs.map((p) => p.confidence),
    pairs.map((p) => (p.correct ? 1 : 0)),
  );
  const totalCorrect = pairs.reduce((s, p) => s + (p.correct ? 1 : 0), 0);
  return {
    t: pairs.length,
    bins,
    buckets,
    overallAccuracy: totalCorrect / pairs.length,
    monotoneNondecreasing: violations === 0,
    violations,
    spearman,
  };
}

// ─────────────────────────── ④ 最优求助决策 ───────────────────────────

/** 求助成本模型 */
export interface AskCostModel {
  /** 判错一次的代价（> 0） */
  costError: number;
  /** 问一次的全部代价（打断 + 延迟折现，≥ 0；≥ costError 时永不值得问） */
  costAsk: number;
  /** 当前部署域的先验错误率 q ∈ (0,1)（0.5 = 无信息先验） */
  priorError: number;
}

/** 闭式求助阈值读出 */
export interface AskPolicy {
  /** 信心低于该阈值才问：c* = σ(logit(1−k) − logit(1−q))，k = costAsk/costError */
  threshold: number;
  /** 错误率容忍度 k = costAsk/costError（阈值处后验错误率恰等于 k） */
  errorTolerance: number;
  priorError: number;
  neverAsk: boolean;
  alwaysAsk: boolean;
}

function validateAskModel(model: AskCostModel): void {
  if (model === null || typeof model !== 'object') {
    throw new Error('求助成本模型须为 {costError, costAsk, priorError} 对象');
  }
  if (!Number.isFinite(model.costError) || model.costError <= 0) {
    throw new Error(`costError 须为 > 0 的有限数（收到 ${model.costError}）`);
  }
  if (!Number.isFinite(model.costAsk) || model.costAsk < 0) {
    throw new Error(`costAsk 须为 ≥ 0 的有限数（收到 ${model.costAsk}）`);
  }
  if (!Number.isFinite(model.priorError) || model.priorError <= 0 || model.priorError >= 1) {
    throw new Error(`priorError 须落在开区间 (0,1)（收到 ${model.priorError}）`);
  }
}

/**
 * ④ 最优求助阈值（期望成本最小化的闭式解）。
 *
 * 问当且仅当 P(error|c)·costError > costAsk。后验错误率由贝叶斯合成
 * （校准信心 c × 域先验 q），解出闭式
 *   c* = σ( logit(1 − costAsk/costError) − logit(1 − priorError) )。
 * 边界: costAsk = 0 → 恒问（threshold 1）；costAsk ≥ costError → 恒不问
 * （threshold 0）。q = 0.5 退化为 c* = 1 − costAsk/costError。
 */
export function optimalAskThreshold(model: AskCostModel): AskPolicy {
  validateAskModel(model);
  const k = model.costAsk / model.costError;
  if (model.costAsk === 0) {
    return { threshold: 1, errorTolerance: 0, priorError: model.priorError, neverAsk: false, alwaysAsk: true };
  }
  if (k >= 1) {
    return { threshold: 0, errorTolerance: k, priorError: model.priorError, neverAsk: true, alwaysAsk: false };
  }
  const threshold = sigmoid(logit(1 - k) - logit(1 - model.priorError));
  return { threshold, errorTolerance: k, priorError: model.priorError, neverAsk: false, alwaysAsk: false };
}

/**
 * 后验错误率 P(error | c)：校准信心 c（参照域口径）经域先验 q 的贝叶斯合成。
 *
 * odds(correct|c) = (c/(1−c))·((1−q)/q)；q = 0.5 时 P(error|c) = 1 − c。
 * R5·A3：全程对数域计算 ln odds = logit(c) + logit(1−q)，
 * P(error) = 1/(1+e^{ln odds}) —— 极端 c/q 不再产生中间量下溢/上溢；
 * 常规区间与旧「odds 乘法」公式相差 < 1e-12（数值等价）。
 */
export function posteriorErrorProbability(confidence: number, priorError: number): number {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`posteriorErrorProbability: confidence 须落在 [0,1]（收到 ${confidence}）`);
  }
  if (!Number.isFinite(priorError) || priorError <= 0 || priorError >= 1) {
    throw new Error(`posteriorErrorProbability: priorError 须落在开区间 (0,1)（收到 ${priorError}）`);
  }
  const c = Math.min(1 - 1e-12, Math.max(1e-12, confidence));
  const logOddsCorrect = Math.log(c / (1 - c)) + Math.log((1 - priorError) / priorError);
  // e^{logOdds} 上溢时 P → 0（除法护栏：1/(1+∞) 良定义）
  return 1 / (1 + Math.exp(logOddsCorrect));
}

/** 单次求助决策读出 */
export interface ShouldAskResult {
  ask: boolean;
  /** 贝叶斯合成的后验错误率 */
  posteriorError: number;
  /** 期望节余 = P(error|c)·costError − costAsk（> 0 即值得问） */
  expectedSaving: number;
  threshold: number;
}

/**
 * ④ shouldAsk：给定信心与成本模型，输出求助决策。
 *
 * ask ⟺ confidence < c*（等价于期望节余 > 0 的同一驻点解）。
 */
export function shouldAsk(confidence: number, model: AskCostModel): ShouldAskResult {
  validateAskModel(model);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`shouldAsk: confidence 须落在 [0,1]（收到 ${confidence}）`);
  }
  const policy = optimalAskThreshold(model);
  const posteriorError = posteriorErrorProbability(confidence, model.priorError);
  const expectedSaving = posteriorError * model.costError - model.costAsk;
  return {
    ask: confidence < policy.threshold,
    posteriorError,
    expectedSaving,
    threshold: policy.threshold,
  };
}

// ─────────────────────────── ④′ R5：信心的贝叶斯最优报告 ───────────────────────────

/** 校准后验：给定内部信心读数时「真实判对概率 p」的后验 Beta(α,β) */
export interface CalibrationPosterior {
  alpha: number;
  beta: number;
}

/** R5·A1b 贝叶斯最优报告读出 */
export interface BayesReportResult {
  /** 最优点报告 r* = α/(α+β)（Brier 与对数评分下同为后验均值） */
  report: number;
  /** 已校准标记（r* 与内部信心一致到 1e-9） */
  honest: boolean;
  /** r* 处的期望 Brier = m(1−m)（闭式，m = E[p]） */
  expectedBrier: number;
  /** 报告原始信心的额外 Brier 代价 = (c − r*)²（精确恒等式 Brier(c)−Brier(r*)） */
  rawReportPenalty: number;
  /** 下游 ask 阈值一致性（给出阈值时读出；否则 undefined） */
  decisionAlignment: { askThreshold: number; rawWouldAsk: boolean; optimalWouldAsk: boolean; aligned: boolean } | undefined;
}

/**
 * R5·A1b 信心的贝叶斯最优报告（proper scoring rule 下的闭式）。
 *
 * y|p ~ Bernoulli(p)、p ~ Beta(α,β)：
 *   Brier:  min_r E[(r−y)²] ⟹ r* = E[p] = α/(α+β)，最小值 = m(1−m)
 *   对数:   min_r E[−y ln r −(1−y)ln(1−r)] ⟹ r* = E[p]（同解）
 * 精确恒等式：E[(r−y)²] − E[(r*−y)²] = (r − r*)²——报未校准原始信心的
 * 代价恰为平方校准偏差，「校准的价值」有精确账目。
 * 下游决策（shouldAsk 阈值 c*）：贝叶斯最优路径按 r* 过阈；若原始
 * 信心与 r* 落在阈值异侧，原始路径会问错（decisionAlignment 读出）。
 */
export function bayesOptimalReport(
  confidence: number,
  posterior: CalibrationPosterior,
  opts?: { askThreshold?: number },
): BayesReportResult {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`bayesOptimalReport: confidence 须落在 [0,1]（收到 ${confidence}）`);
  }
  if (!posterior || typeof posterior !== 'object') {
    throw new Error('bayesOptimalReport: posterior 须为 { alpha, beta } 对象');
  }
  if (!Number.isFinite(posterior.alpha) || posterior.alpha <= 0) {
    throw new Error(`bayesOptimalReport: alpha 须为 > 0 有限数（收到 ${posterior.alpha}）`);
  }
  if (!Number.isFinite(posterior.beta) || posterior.beta <= 0) {
    throw new Error(`bayesOptimalReport: beta 须为 > 0 有限数（收到 ${posterior.beta}）`);
  }
  if (opts?.askThreshold !== undefined && (!Number.isFinite(opts.askThreshold) || opts.askThreshold < 0 || opts.askThreshold > 1)) {
    throw new Error(`bayesOptimalReport: askThreshold 须落在 [0,1]（收到 ${opts.askThreshold}）`);
  }
  const m = posterior.alpha / (posterior.alpha + posterior.beta);
  const diff = confidence - m;
  const decisionAlignment =
    opts?.askThreshold !== undefined
      ? {
          askThreshold: opts.askThreshold,
          rawWouldAsk: confidence < opts.askThreshold,
          optimalWouldAsk: m < opts.askThreshold,
          aligned: confidence < opts.askThreshold === m < opts.askThreshold,
        }
      : undefined;
  return {
    report: round12(m),
    honest: Math.abs(diff) < 1e-9,
    expectedBrier: round12(m * (1 - m)),
    rawReportPenalty: round12(diff * diff),
    decisionAlignment,
  };
}

// ─────────────────────────── ⑤ 工厂：noisy signal + confidence kernel ───────────────────────────

/** 单次试验读出 */
export interface MetacognitionTrial {
  /** +1 信号 / −1 噪声 */
  stimulus: 1 | -1;
  /** 一阶判「是信号」与否（x > 0） */
  respondedSignal: boolean;
  correct: boolean;
  /** 信心 [0,1)（|y| 的单调核 1 − exp(−|y|)） */
  confidence: number;
  /** 一阶证据 x（判别由 sign(x) 定） */
  evidence: number;
  /** 二阶读数 y = x + ε（信心由 |y| 定——ε 即元认知噪声） */
  confidenceEvidence: number;
}

/** 仿真数据集（供 d′ / meta-d′ / 曲线 / 校准锚点消费） */
export interface MetacognitionDataset {
  d: number;
  metaD: number;
  /** 元认知噪声 σ = √((d/metaD)² − 1)（启发式标定，见头注③） */
  sigmaMeta: number;
  trials: MetacognitionTrial[];
  counts: {
    hits: number;
    misses: number;
    falseAlarms: number;
    correctRejections: number;
    nSignal: number;
    nNoise: number;
  };
  /** 正确试验的信心序列（metaDprime 输入一） */
  correctConfidences: number[];
  /** 错误试验的信心序列（metaDprime 输入二） */
  errorConfidences: number[];
  /** 便利视图：{confidence, correct} 对（confidenceAccuracyCurve / ECE 输入） */
  pairs: ConfidenceOutcomePair[];
}

export interface SimulateMetacognitionOptions {
  /** 一阶敏感度 d′ > 0 */
  d: number;
  /** 名义 meta-d′ 目标 ∈ (0, d]（= d 时零元认知噪声——纯理想观察者） */
  metaD: number;
  /** 试验次数（整数 ≥ 1） */
  trials: number;
  /** 随机种子 */
  seed: number;
}

/**
 * ⑤ 信心生成工厂（noisy signal + confidence kernel）。
 *
 * S = ±1 等概率；一阶证据 x ~ N(S·d/2, 1)；判「信号」当 x > 0；
 * 二阶读数 y = x + ε，ε ~ N(0, σ²)；信心 = 1 − exp(−|y|)。
 * σ 由名义 meta-d′ 启发式标定：σ = √((d/metaD)² − 1)。metaD = d 时
 * σ = 0、信心与 |x| 同序——理想观察者（meta-d′̂ → d 的锚点基准）。
 */
export function simulateMetacognition(options: SimulateMetacognitionOptions): MetacognitionDataset {
  if (options === null || typeof options !== 'object') {
    throw new Error('simulateMetacognition: 需要 {d, metaD, trials, seed} options 对象');
  }
  const { d, metaD, trials, seed } = options;
  if (!Number.isFinite(d) || d <= 0) throw new Error(`simulateMetacognition: d 须为 > 0 的有限数（收到 ${d}）`);
  if (!Number.isFinite(metaD) || metaD <= 0) {
    throw new Error(`simulateMetacognition: metaD 须为 > 0 的有限数（收到 ${metaD}）`);
  }
  if (metaD > d) {
    throw new Error(`simulateMetacognition: metaD（${metaD}）不能超过 d（${d}）——元认知效率 ≤ 1 口径`);
  }
  if (!Number.isInteger(trials) || trials < 1 || trials > 1_000_000) {
    throw new Error(`simulateMetacognition: trials 须为 1..1e6 的整数（收到 ${trials}）`);
  }
  if (!Number.isFinite(seed) || seed < 0) {
    throw new Error(`simulateMetacognition: seed 须为 ≥ 0 的数（收到 ${seed}）`);
  }
  const sigmaMeta = metaD >= d ? 0 : Math.sqrt((d / metaD) * (d / metaD) - 1);
  const gauss = makeGaussian(seed);
  const trialsOut: MetacognitionTrial[] = [];
  const correctConfidences: number[] = [];
  const errorConfidences: number[] = [];
  let hits = 0;
  let misses = 0;
  let falseAlarms = 0;
  let correctRejections = 0;
  let nSignal = 0;
  let nNoise = 0;
  for (let i = 0; i < trials; i += 1) {
    const stimulus: 1 | -1 = gauss() < 0 ? -1 : 1;
    if (stimulus === 1) nSignal += 1;
    else nNoise += 1;
    const x = (stimulus * d) / 2 + gauss();
    const respondedSignal = x > 0;
    const correct = respondedSignal === (stimulus === 1);
    const y = x + sigmaMeta * gauss();
    const confidence = 1 - Math.exp(-Math.abs(y));
    if (stimulus === 1 && respondedSignal) hits += 1;
    else if (stimulus === 1 && !respondedSignal) misses += 1;
    else if (stimulus === -1 && respondedSignal) falseAlarms += 1;
    else correctRejections += 1;
    const trial: MetacognitionTrial = {
      stimulus,
      respondedSignal,
      correct,
      confidence,
      evidence: x,
      confidenceEvidence: y,
    };
    trialsOut.push(trial);
    if (correct) correctConfidences.push(confidence);
    else errorConfidences.push(confidence);
  }
  return {
    d,
    metaD,
    sigmaMeta,
    trials: trialsOut,
    counts: { hits, misses, falseAlarms, correctRejections, nSignal, nNoise },
    correctConfidences,
    errorConfidences,
    pairs: trialsOut.map((t) => ({ confidence: t.confidence, correct: t.correct })),
  };
}

// ── 接线建议 ─────────────────────────────────────────────────────────
//
// 1. 决策引擎 ask-user 触发层（知道自己不知道才求助）:
//    - 模型输出自评信心 c → shouldAsk(c, {costError, costAsk, priorError})
//      产 ask 布尔 + 期望节余；costError 挂任务失败重试成本，costAsk 挂
//      用户打断 + 响应延迟（与 95.0 交接成本合龙），priorError 从该任务
//      类型的历史错误率滚动估计（meta/self-model 供数）。
//    - 只有后验错误率越过闭式阈值的低信心试验才触发求助——过度自信与
//      过度自卑都被成本模型拉回最优。
//
// 2. 反思触发与自我模型仪表（meta/self-model 常驻视图）:
//    - 每批决策回填 (confidence, correct) 对 → confidenceAccuracyCurve
//      出「哪一档信心在撒谎」；metaDprime(对错信心序列) 对照 typeOneDprime
//      出元认知效率 M-ratio = meta-d′/d′——自模型把它作为「该不该多问 /
//      该不该少问」的量化依据（M-ratio 低 → 信心不可信 → 求助策略退化
//      为基于任务难度先验的保守口径）。
//
// 3. 与 75.0 在线校准的链路（点概率诚实化的上游）:
//    - 97.0 的 (confidence, correct) 对即 75.0 CalibrationPair 口径：
//      信心先经 75.0 GatedCalibrator 诚实化（报多少对多少），再进本
//      内核的最优 ask 阈值——未校准的信心会让闭式阈值系统性偏移。
//
// 4. 与 84.0 信念价值 / 95.0 交接成本的合龙:
//    - costError 由 84.0 的「错误信念价值损失」供数；costAsk 由 95.0 的
//      交接成本供数——求助决策从单点启发式升级为三方成本合成的期望
//      成本最小化。
//
// 5. 挂载边界（零介入承诺）:
//    - 只读挂载：引擎仅调用只读分析函数与工厂，内核不发起求助、不写
//      引擎状态；未挂载时现有决策路径逐位一致。
// ──────────────────────────────────────────────────────────────────
