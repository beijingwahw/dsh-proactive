/**
 * preference-learning.ts — 90.0 偏好学习内核 —— Bradley–Terry/Elo：从「哪个更好」的偏好对里学出价值序
 * （Bradley–Terry 1952 / Elo 1978 / Thurstone 1927——RLHF 偏好模型与 DPO 损失的同一数学底座）
 *
 * 动机（升级前的根本局限——价值只有「绝对打分」一种口径）:
 * - 调度/进化的「好坏」全靠硬编码指标打分: 绝对分数跨任务不可比（评分漂移、
 *   任务难度不一、评审宽严不一），指标一改历史全作废——价值测量没有不变量；
 * - 人类反馈天然是**相对的**: 「A 比 B 好」不需要绝对标尺，同一评审在同一对
 *   内自对照——成对比较是抗评分漂移的更稳测量，但系统没有从偏好对恢复
 *   价值序的数学件；
 * - A/B 决策缺证据学: 两个方案的历史偏好对攒了一堆，却没有「价值差多大、
 *   置信多少」的推断通道。
 *
 * 数学:
 * 1. Bradley–Terry 模型: P(i ≻ j) = v_i/(v_i+v_j) = σ(u_i−u_j)（v = e^u 的
 *    随机效用极大值化 Gumbel 特例）。与 Elo **同构**: Elo 分差
 *    r_i−r_j = (400/ln10)·(u_i−u_j)——期望胜率公式 1/(1+10^{Δr/400}) 与
 *    σ(Δu) 是同一函数（锚点③的恒等式直接验证）。
 * 2. MLE = 逻辑损失 + L2 正则的凸优化:
 *      L(u) = Σ_m log(1+e^{−(u_{w_m}−u_{l_m})}) + (λ/2)‖u‖²
 *    每对损失是凸的; Hessian = Σ_m p_m(1−p_m)(e_w−e_l)(e_w−e_l)ᵀ + λI ⪰ λI
 *    ——强凸保证唯一解。B-T 本身平移不变（u+c 同似然）: λ=0 时全 1 向量是
 *    Hessian 零空间方向，牛顿方程奇异——内核显式 throw 并说明（λ>0 即钉死
 *    规范）；求解用牛顿法（IRLS）+ Armijo 回溯线搜索，最优解附近二次收敛。
 * 3. Elo 动态评分: E_w = 1/(1+10^{(r_l−r_w)/400});
 *    r_w += K(1−E_w)、r_l += K(0−E_l)——更新**零和**（Σr 守恒，锚点③）。
 *    恒定 K 是围绕真值的随机漫步（跟踪非平稳环境的特性）; K_t = K/t^γ
 *    （γ>0）是随机逼近，收敛到静态 B-T 解的邻域（锚点④: 与离线 MLE 排序
 *    一致、分差落入邻域）。
 * 4. Thurstone Case V 对照口径（高斯感知差）: P(i ≻ j) = Φ((u_i−u_j)/√2)。
 *    与 B-T 同向单调、零点同 0.5、|Δ|≤3 全带最大偏差 < 0.045（锚点⑥）——
 *    中等差距内两口径可互换，大差距处 Thurstone 尾部更重。
 * 5. 非传递性体检（诚实面）: B-T 假设存在传递的潜在强度，石头剪刀布式的
 *    循环偏好违反它——内核给**双信号**:
 *    a) 传递性检查: 多数偏好图（每对取多数方向）Tarjan 强连通分量找环
 *       ——环路组 = 非传递的证据链;
 *    b) 拟合优度: 成对二项标准化残差 z = (w−np̂)/√(np̂(1−p̂))，
 *       Pearson X² = Σz² 对照 χ²_{K−(n−1)}（K = 有比较的对数，in-sample
 *       自由度扣减）; |z|>2 的对 = 模型系统性解释不了的地方（非传递性指纹）。
 *    循环数据下 B-T 效用全塌缩、logLoss = ln2（只能瞎猜）——非传递性代价
 *    被诚实量化而不是被掩盖（锚点⑤）。
 *
 * 验证锚点（scripts/verify-preference-learning.mjs）:
 *   ① u*=[3,2,1,0.5] 采样 600 对: MLE 排序恢复 100%，中心化效用以 0.5
 *      容差逼近真值（B-T 平移不变 → 对照取中心化口径，文档化容差含抽样噪声）;
 *   ①′ 两物品解析锚: 6 对胜 4 → û₀−û₁ = ln(4/2) = ln2（λ=1e-8，1e-5 内）;
 *   ② 留出 1/3 预测准确率 ≥ 0.85（信噪比口径 u=[6,4,2,0]、900 对——真实
 *      模型的贝叶斯准确率即 0.934，阈值留裕量）;
 *   ③ Elo 期望分手算锚: 400 分差 → 10/11 = 0.909090…（1e-12）; 同构恒等式
 *      E(β·1.2, 0) = σ(1.2); 更新零和守恒、±K/11 精确代入;
 *   ④ 同一份 8000 对数据: Elo 在线（K/t^0.6）与 B-T 静态解排序一致、
 *      中心化分差落入 ≤30 分的邻域（实测 11.6; 且 2000→4000→8000 对
 *      偏差单调下降 32→21→12——随机逼近收敛的直接证据）;
 *   ⑤ 石头剪刀布 450 对: 环路检测报警（SCC={0,1,2}）; B-T 效用全塌缩、
 *      logLoss = ln2、X² = 3×150、df=1、p < 1e-20、三对全部系统性残差;
 *      传递对照（u=[6,4,2,0]）拟合优度良好、留出准确率 ≥ 0.85——
 *      非传递性代价 = ΔlogLoss + Δ准确率，诚实量化（RPS 留出准确率
 *      实测 0.32: 训练侧的微小不平衡把循环平票定向，系统性低于瞎猜）;
 *   ⑥ 数值件解析锚: chiSquarePValue(x,2) = e^{−x/2}、(x,4) = e^{−x/2}(1+x/2);
 *      Φ(1.959964) = 0.975（A&S 7.1.26）; B-T vs Thurstone 全带偏差 < 0.045;
 *      工厂同 seed 逐位复现; 入参校验显式 throw。
 *
 * 应用: 反思器/人类反馈通道——从「哪次输出更好」的偏好对学价值函数
 * （RLHF-lite: 策略进化的适应度从硬编码指标升级为「学到的人类偏好」）;
 * A/B 决策的证据学（两个方案的历史偏好对 → predictPair 给价值差点估计、
 * heldOutAccuracy 给预测可信度、btGoodnessOfFit 给「偏好是否可传递建模」
 * 的前提体检——循环偏好下先报警再谈决策）。
 *
 * R5 进化（第五轮·世界性升级，数学+性能+数值+性质四轴）:
 *   数学轴——Plackett-Luce 排名模型（Luce 1959 / Plackett 1975）:
 *     P(排名 π) = Π_k v_{π(k)} / Σ_{j∈k 之后仍存活} v_j——一步式softmax
 *     连乘，是 B-T 从「二元对决」到「整张排名单」的推广（排名第 k 步
 *     恰是从剩余集合做一次 Luce 选择）。MLE = 凸优化: 损失
 *     L(u) = Σ_π Σ_k [LSE_k(u) − u_{π(k)}] + (λ/2)‖u‖²，每步 LSE 项凸、
 *     Hessian = Σ_steps (diag(p) − ppᵀ) + λI ⪰ λI——牛顿法（IRLS）+
 *     Armijo 线搜索，与 bradleyTerryMLE 同构。两物品排名数据下与 B-T
 *     MLE **逐似然等价**（log P(i≻j) = log σ(u_i−u_j)——锚点对照）。
 *   性能轴——梯度复用: 损失/梯度/Hessian 共用同一步 softmax——单遍
 *     扫描同时累积三者（naive 三遍各重算一遍 softmax）; 每变量加法序
 *     不变 ⟹ 数值逐位相同，仅常数因子收益（verify 内 vs 朴素三遍参考
 *     对照 + 耗时比）。
 *   数值轴——全对数域: logProb = Σ_k [u_{π(k)} − LSE(π[k..])]（max 平移
 *     log-sum-exp）; 线性域连乘在长排名/大效用差下必下溢，对数域稳定，
 *     plackettLuceProbability 仅作 exp 包装（可下溢为 0，文档化）。
 *   性质轴——Luce 选择公理（IIA）: P_S(i)/P_S(j) = v_i/v_j 与选择集 S
 *     无关; 排名概率 = 逐步选择概率连乘（定义分解的独立重算对照）;
 *     模拟工厂 + MLE 恢复已知效用序（种子化）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入
 */

// ─────────────────────────── 类型与配置 ───────────────────────────

/** 一次成对比较: winner 被偏好（胜）、loser 被比下去（败）; 下标域 [0, nItems) */
export interface PreferencePair {
  winner: number;
  loser: number;
}

/** B-T MLE 拟合选项 */
export interface BTFitOptions {
  /** L2 正则强度 λ（缺省 1e-3）。λ>0 钉死平移不变性 → 强凸唯一解; λ=0 时 Hessian 沿全 1 向量奇异，显式 throw */
  l2?: number;
  /** 牛顿迭代上限（缺省 100） */
  iters?: number;
  /** 梯度 ∞ 范数收敛容差（缺省 1e-10） */
  tol?: number;
  /** 物品数（缺省 = max(winner, loser)+1 推断; 显式给定可包含零比较物品——λ 正则将其钉在 0） */
  nItems?: number;
}

export const BT_FIT_DEFAULTS = { l2: 1e-3, iters: 100, tol: 1e-10 } as const;

/** B-T MLE 拟合结果 */
export interface BTFitResult {
  nItems: number;
  nPairs: number;
  /** 拟合效用 u（λ 正则向 0 收缩; 平移不变口径下只差可解释） */
  utilities: number[];
  /** 每对平均数据对数损失 −(1/m)Σln σ(u_w−u_l)（不含正则项; 对照锚 ln2 = 瞎猜） */
  logLoss: number;
  /** 牛顿更新次数 */
  iterations: number;
  /** 收敛时梯度 ∞ 范数 */
  gradientInfinityNorm: number;
  converged: boolean;
}

/** Elo 单步更新结果（零和: Σr 更新前后不变） */
export interface EloUpdateResult {
  ratings: number[];
  /** 胜者分变 r_w' − r_w = K(1−E_w) ≥ 0 */
  winnerDelta: number;
  /** 败者分变 r_l' − r_l = −K(1−E_w) ≤ 0（爆冷时 |Δ| 大——期望分公式奖冷门） */
  loserDelta: number;
  /** 赛前胜者期望得分 E_w = 1/(1+10^{(r_l−r_w)/400}) */
  winnerExpected: number;
  /** 更新后总分（守恒不变量） */
  totalRating: number;
}

/** Elo 在线序列选项 */
export interface EloSequenceOptions {
  /** 物品数（缺省由 ratings 或数据推断） */
  nItems?: number;
  /** 基准 K 因子（缺省 32） */
  k?: number;
  /** K 衰减指数 γ: 第 t 步 K_t = K/t^γ（缺省 0.5; 0 = 恒定 K 随机漫步不收敛，γ>0 随机逼近收敛到静态 B-T 解邻域） */
  kDecay?: number;
  /** 初始评分（缺省全 0） */
  ratings?: number[];
}

export const ELO_DEFAULTS = { k: 32, kDecay: 0.5 } as const;

/** Elo 序列运行结果 */
export interface EloSequenceResult {
  ratings: number[];
  steps: number;
  finalK: number;
}

/** 多数偏好图的边（i→j: i 对 j 胜场严格多数） */
export interface MajorityEdge {
  from: number;
  to: number;
  /** from 对 to 的胜场 */
  wins: number;
  /** to 对 from 的胜场（反向） */
  losses: number;
}

/** 传递性体检报告 */
export interface TransitivityReport {
  nItems: number;
  nPairs: number;
  /** 多数偏好图无有向环 ⟺ 偏好剖面传递（B-T 的前提成立） */
  transitive: boolean;
  /** 环路组（|强连通分量| ≥ 2，按大小降序、组内升序）——非传递的证据链 */
  cycles: number[][];
  /** 卷入环路的物品占比（0 = 传递; 1 = 全员循环，如石头剪刀布） */
  cyclicItemFraction: number;
  /** 多数偏好图的全部边 */
  edges: MajorityEdge[];
  /** 两方向胜场相等的对数（无多数边——「说不清」而非「循环」） */
  tiedPairs: number;
}

/** 单个物品对的拟合残差 */
export interface PairGroupResidual {
  /** 较小下标（统计口径: winsOfI 计 i 的胜场） */
  i: number;
  j: number;
  comparisons: number;
  winsOfI: number;
  /** 观测胜率 w/n */
  observedRate: number;
  /** 模型预测率 σ(u_i−u_j) */
  predictedRate: number;
  /** 标准化残差 (w − np̂)/√(np̂(1−p̂))（|z| > systematicZ 判系统性偏差） */
  z: number;
}

/** 拟合优度选项 */
export interface BTGoodnessOfFitOptions {
  /** |z| 超过该值的对判「系统性偏差对」（缺省 2 ≈ 95% 带） */
  systematicZ?: number;
  /** 拟合可接受的整体 p 值阈（缺省 0.01） */
  alpha?: number;
}

export const GOF_DEFAULTS = { systematicZ: 2, alpha: 0.01 } as const;

/** B-T 拟合优度报告（in-sample 残差检验，自由度已按参数量扣减） */
export interface BTGoodnessOfFitReport {
  nItems: number;
  nPairs: number;
  /** 按残差绝对值降序的逐对残差 */
  groups: PairGroupResidual[];
  chiSquare: number;
  /** K − (n−1)（K = 有比较的物品对数，n = 出现过的物品数） */
  degreesOfFreedom: number;
  /** χ² 上尾概率; df < 1 时为 NaN（自由度不足） */
  pValue: number;
  /** df < 1（数据不足以支撑检验——诚实标记而非硬算） */
  underdetermined: boolean;
  maxAbsZ: number;
  worstPair: { i: number; j: number } | null;
  /** |z| > systematicZ 的对数（模型系统性解释不了的地方） */
  systematicCount: number;
  /** !underdetermined && p ≥ alpha && maxAbsZ ≤ 3 */
  fitOk: boolean;
}

/** 偏好采样工厂选项 */
export interface SimulateOptions {
  /** 感知噪声 σ（缺省 0 = 纯 B-T）。>0 时每次比较的效用差叠加 N(0,σ²) 扰动——数据系统性偏离 B-T */
  noiseSigma?: number;
}

/** 留出验证选项 */
export interface HeldOutOptions {
  /** 留出比例（缺省 1/3，∈(0,1)） */
  testFraction?: number;
  /** 划分种子（缺省 2027，mulberry32 确定性洗牌） */
  seed?: number;
  /** 训练侧 MLE 的 λ（缺省 1e-3） */
  l2?: number;
  /** 训练侧 MLE 的迭代上限（缺省 100） */
  iters?: number;
  /** 训练侧 MLE 的收敛容差（缺省 1e-10） */
  tol?: number;
}

/** 留出验证结果 */
export interface HeldOutResult {
  nTrain: number;
  nTest: number;
  /** 预测准确率（p>0.5 计 1，p=0.5 计 0.5——平局半分，口径诚实） */
  accuracy: number;
  /** p=0.5 平局对数（半分贡献的来源） */
  halfCredit: number;
  /** 留出集平均对数损失（对照锚 ln2） */
  testLogLoss: number;
  /** 训练侧拟合效用 */
  utilities: number[];
}

/** 按效用排序的名次条目（rank 1 起） */
export interface UtilityRank {
  index: number;
  utility: number;
  rank: number;
}

// ─────────────────────────── 校验工具 ───────────────────────────

function ensure(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

interface PairsData {
  winners: Int32Array;
  losers: Int32Array;
  nItems: number;
}

/** 成对数据校验: 非空、下标非负整数、winner ≠ loser; 返回紧凑数组与推断的物品数 */
function validatePairs(pairs: readonly PreferencePair[], context: string): PairsData {
  ensure(Array.isArray(pairs), `${context}: pairs 必须是数组`);
  ensure(pairs.length > 0, `${context}: 至少需要一对偏好比较（空数据无法定标效用）`);
  const winners = new Int32Array(pairs.length);
  const losers = new Int32Array(pairs.length);
  let maxIndex = -1;
  for (let m = 0; m < pairs.length; m += 1) {
    const pair = pairs[m];
    ensure(pair !== null && typeof pair === 'object', `${context}: 第 ${m} 对不是对象`);
    const w = Number(pair?.winner);
    const l = Number(pair?.loser);
    ensure(Number.isInteger(w) && w >= 0, `${context}: 第 ${m} 对 winner=${String(w)} 不是非负整数下标`);
    ensure(Number.isInteger(l) && l >= 0, `${context}: 第 ${m} 对 loser=${String(l)} 不是非负整数下标`);
    ensure(w !== l, `${context}: 第 ${m} 对 winner === loser（不能与自己比较）`);
    winners[m] = w;
    losers[m] = l;
    if (w > maxIndex) maxIndex = w;
    if (l > maxIndex) maxIndex = l;
  }
  return { winners, losers, nItems: maxIndex + 1 };
}

/** 效用向量校验: 数组、有限值、长度足够覆盖数据下标 */
function validateUtilities(utilities: readonly number[], nItems: number, context: string): void {
  ensure(Array.isArray(utilities), `${context}: utilities 必须是数组`);
  ensure(utilities.length >= nItems, `${context}: utilities 长度 ${utilities.length} < 数据需要的物品数 ${nItems}`);
  for (let i = 0; i < utilities.length; i += 1) {
    ensure(Number.isFinite(utilities[i]), `${context}: utilities[${i}] 不是有限数`);
  }
}

// ─────────────────────────── 确定性随机源与数值件 ───────────────────────────

/** mulberry32: 32 位确定性伪随机源（种子固定时序列完全可复现） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 标准正态采样（Box–Muller，无缓存版: 每次消耗两个均匀数——流位置确定） */
function standardNormal(rng: () => number): number {
  let u1 = rng();
  if (u1 < 1e-300) u1 = 1e-300;
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** 逻辑函数 σ(x) = 1/(1+e^{−x})（数值稳定分支） */
export function logistic(x: number): number {
  ensure(Number.isFinite(x), 'logistic: x 不是有限数');
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

/** log(1+e^x) 的数值稳定实现（B-T/逻辑损失的基础件） */
function logOnePlusExp(x: number): number {
  if (x > 33.3) return x;
  if (x > -37) return Math.log1p(Math.exp(x));
  return Math.exp(x);
}

/** erf（Abramowitz–Stegun 7.1.26 有理近似，|ε| ≤ 1.5e-7; 原点精确取 0） */
function erf(x: number): number {
  if (x === 0) return 0; // 多项式系数和为 0.999999999——零点显式钉死，保 Φ(0) = 0.5 精确
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** 标准正态 CDF Φ(x) */
export function stdNormalCdf(x: number): number {
  ensure(Number.isFinite(x), 'stdNormalCdf: x 不是有限数');
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

const LANCZOS_G = 7;
const LANCZOS_COEF = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** ln Γ(x)（Lanczos g=7 近似 + x<0.5 反射公式） */
function logGamma(x: number): number {
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = LANCZOS_COEF[0];
  const t = z + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_COEF.length; i += 1) {
    a += LANCZOS_COEF[i] / (z + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** 正则化下不完全 γ 函数 P(a,x) 的级数（x < a+1 分支） */
function lowerGammaSeries(a: number, x: number): number {
  let sum = 1 / a;
  let term = sum;
  let ap = a;
  for (let n = 1; n < 1000; n += 1) {
    ap += 1;
    term *= x / ap;
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/** 正则化上不完全 γ 函数 Q(a,x) 的连分式（Lentz; x ≥ a+1 分支） */
function upperGammaFraction(a: number, x: number): number {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** 正则化上不完全 γ 函数 Q(a,x) = Γ(a,x)/Γ(a) */
function gammaQ(a: number, x: number): number {
  if (x < 0 || a <= 0) return Number.NaN;
  if (x === 0) return 1;
  if (x < a + 1) return 1 - lowerGammaSeries(a, x);
  return upperGammaFraction(a, x);
}

/**
 * χ² 分布上尾概率 P(χ²_df ≥ statistic)。
 * 解析锚: df=2 → e^{−x/2}; df=4 → e^{−x/2}(1+x/2)。
 */
export function chiSquarePValue(statistic: number, df: number): number {
  ensure(Number.isFinite(statistic) && statistic >= 0, 'chiSquarePValue: statistic 必须是非负有限数');
  ensure(Number.isFinite(df) && df >= 1, 'chiSquarePValue: df 必须 ≥ 1');
  return gammaQ(df / 2, statistic / 2);
}

// ─────────────────────────── B-T / Thurstone / Elo 预测件 ───────────────────────────

/** Elo 尺度换算系数: r = (400/ln10)·u ≈ 173.7178·u（B-T 与 Elo 同构的桥梁） */
export const ELO_SCALE = 400 / Math.LN10;

/** B-T 效用 → Elo 分（r_i − r_j = ELO_SCALE·(u_i − u_j)） */
export function utilityToEloScale(u: number): number {
  ensure(Number.isFinite(u), 'utilityToEloScale: u 不是有限数');
  return ELO_SCALE * u;
}

/** Elo 分 → B-T 效用（utilityToEloScale 的逆） */
export function eloScaleToUtility(r: number): number {
  ensure(Number.isFinite(r), 'eloScaleToUtility: r 不是有限数');
  return r / ELO_SCALE;
}

/** Elo 期望得分 E_A = 1/(1+10^{(r_B−r_A)/400}); 手算锚: 400 分差 → 10/11 = 0.909090… */
export function expectedScore(ratingA: number, ratingB: number): number {
  ensure(Number.isFinite(ratingA), 'expectedScore: ratingA 不是有限数');
  ensure(Number.isFinite(ratingB), 'expectedScore: ratingB 不是有限数');
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/** B-T 成对预测 P(i ≻ j) = σ(u_i − u_j) */
export function predictPair(utilities: readonly number[], i: number, j: number): number {
  validateUtilities(utilities, Math.max(i, j) + 1, 'predictPair');
  ensure(Number.isInteger(i) && i >= 0 && i < utilities.length, `predictPair: i=${String(i)} 越界`);
  ensure(Number.isInteger(j) && j >= 0 && j < utilities.length, `predictPair: j=${String(j)} 越界`);
  ensure(i !== j, 'predictPair: i === j（不能与自己比较）');
  return logistic(utilities[i] - utilities[j]);
}

/** Thurstone Case V 成对概率 P(i ≻ j) = Φ((u_i−u_j)/√2)（高斯感知差对照口径） */
export function thurstoneProbability(utilities: readonly number[], i: number, j: number): number {
  validateUtilities(utilities, Math.max(i, j) + 1, 'thurstoneProbability');
  ensure(Number.isInteger(i) && i >= 0 && i < utilities.length, `thurstoneProbability: i=${String(i)} 越界`);
  ensure(Number.isInteger(j) && j >= 0 && j < utilities.length, `thurstoneProbability: j=${String(j)} 越界`);
  ensure(i !== j, 'thurstoneProbability: i === j（不能与自己比较）');
  return stdNormalCdf((utilities[i] - utilities[j]) / Math.SQRT2);
}

/** 给定效用下的每对平均数据对数损失（模型质量口径锚: ln2 = 瞎猜） */
export function btLogLoss(pairs: readonly PreferencePair[], utilities: readonly number[]): number {
  const { winners, losers, nItems } = validatePairs(pairs, 'btLogLoss');
  validateUtilities(utilities, nItems, 'btLogLoss');
  let loss = 0;
  for (let m = 0; m < winners.length; m += 1) {
    loss += logOnePlusExp(-(utilities[winners[m]] - utilities[losers[m]]));
  }
  return loss / winners.length;
}

// ─────────────────────────── Bradley–Terry MLE（牛顿 + Armijo） ───────────────────────────

/** (损失, 梯度): L = Σ log(1+e^{−(u_w−u_l)}) + (λ/2)‖u‖²; g_i = Σ(∂)+λu_i */
function btLossGradient(
  winners: Int32Array,
  losers: Int32Array,
  u: readonly number[],
  l2: number,
): { loss: number; grad: number[] } {
  const n = u.length;
  const grad = new Array<number>(n).fill(0);
  let loss = 0;
  for (let m = 0; m < winners.length; m += 1) {
    const s = u[winners[m]] - u[losers[m]];
    const p = logistic(s);
    loss += logOnePlusExp(-s);
    grad[winners[m]] += p - 1; // 胜者: 欠估则升
    grad[losers[m]] += 1 - p; // 败者: 对偶方向
  }
  for (let i = 0; i < n; i += 1) {
    grad[i] += l2 * u[i];
    loss += 0.5 * l2 * u[i] * u[i];
  }
  return { loss, grad };
}

/** Hessian = Σ p(1−p)(e_w−e_l)(e_w−e_l)ᵀ + λI ⪰ λI（PSD + 对角正则 = 强凸） */
function btHessian(winners: Int32Array, losers: Int32Array, u: readonly number[], l2: number): number[][] {
  const n = u.length;
  const h = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let m = 0; m < winners.length; m += 1) {
    const a = winners[m];
    const b = losers[m];
    const p = logistic(u[a] - u[b]);
    const w = p * (1 - p);
    h[a][a] += w;
    h[b][b] += w;
    h[a][b] -= w;
    h[b][a] -= w;
  }
  for (let i = 0; i < n; i += 1) h[i][i] += l2;
  return h;
}

/** 高斯消元（部分主元）解 A·x = b; 奇异返回 null（不静默正则化——不可辨识就明说） */
function solveLinearSystem(a: readonly (readonly number[])[], rhs: readonly number[]): number[] | null {
  const n = rhs.length;
  const m = a.map((row) => [...row]);
  const b = [...rhs];
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) <= 1e-12) return null;
    if (pivot !== col) {
      const rowSwap = m[pivot];
      m[pivot] = m[col];
      m[col] = rowSwap;
      const bSwap = b[pivot];
      b[pivot] = b[col];
      b[col] = bSwap;
    }
    for (let r = col + 1; r < n; r += 1) {
      const f = m[r][col] / m[col][col];
      if (f === 0) continue;
      for (let c = col; c < n; c += 1) m[r][c] -= f * m[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let sum = b[r];
    for (let c = r + 1; c < n; c += 1) sum -= m[r][c] * x[c];
    x[r] = sum / m[r][r];
  }
  return x;
}

function maxAbsolute(values: readonly number[]): number {
  let best = 0;
  for (const v of values) {
    const a = Math.abs(v);
    if (a > best) best = a;
  }
  return best;
}

/**
 * Bradley–Terry MLE: 牛顿法（IRLS）+ Armijo 回溯线搜索。
 *
 * λ>0: 目标强凸 → 唯一解（缺省 1e-3 收缩可忽略但钉死平移规范）;
 * λ=0: Hessian 沿全 1 向量奇异（B-T 平移不可辨识）→ 显式 throw;
 * 收敛判据: ‖∇L‖∞ ≤ tol。
 */
export function bradleyTerryMLE(pairs: readonly PreferencePair[], options?: BTFitOptions): BTFitResult {
  const { winners, losers, nItems } = validatePairs(pairs, 'bradleyTerryMLE');
  const l2 = options?.l2 ?? BT_FIT_DEFAULTS.l2;
  const iters = options?.iters ?? BT_FIT_DEFAULTS.iters;
  const tol = options?.tol ?? BT_FIT_DEFAULTS.tol;
  ensure(Number.isFinite(l2) && l2 >= 0, `bradleyTerryMLE: l2=${String(l2)} 必须是非负数`);
  ensure(Number.isInteger(iters) && iters >= 1, `bradleyTerryMLE: iters=${String(iters)} 必须是 ≥1 的整数`);
  ensure(Number.isFinite(tol) && tol > 0, `bradleyTerryMLE: tol=${String(tol)} 必须是正数`);
  let n = nItems;
  if (options?.nItems !== undefined) {
    ensure(Number.isInteger(options.nItems) && options.nItems >= 2, `bradleyTerryMLE: nItems=${String(options.nItems)} 必须是 ≥2 的整数`);
    ensure(options.nItems >= nItems, `bradleyTerryMLE: nItems=${options.nItems} 小于数据推断的物品数 ${nItems}`);
    n = options.nItems;
  }

  let u = new Array<number>(n).fill(0);
  let current = btLossGradient(winners, losers, u, l2);
  let iterations = 0;
  let converged = maxAbsolute(current.grad) <= tol;

  while (!converged && iterations < iters) {
    const h = btHessian(winners, losers, u, l2);
    const step = solveLinearSystem(h, current.grad.map((g) => -g));
    if (step === null) {
      throw new Error(
        'bradleyTerryMLE: 牛顿方程奇异——l2=0 时 B-T 效用平移不可辨识（Hessian 沿全 1 向量有零空间）; 请用 l2>0（缺省 1e-3，只钉规范不伤拟合）',
      );
    }
    let slope = 0;
    for (let i = 0; i < n; i += 1) slope += current.grad[i] * step[i];
    // Armijo 回溯: 保证损失单调下降（牛顿方向是下降方向: slope = −gᵀH⁻¹g < 0）
    let t = 1;
    let next: number[] | null = null;
    let nextValue: { loss: number; grad: number[] } | null = null;
    for (let backtrack = 0; backtrack < 40; backtrack += 1) {
      const candidate = u.map((x, i) => x + t * step[i]);
      const candidateValue = btLossGradient(winners, losers, candidate, l2);
      if (Number.isFinite(candidateValue.loss) && candidateValue.loss <= current.loss + 1e-4 * t * slope) {
        next = candidate;
        nextValue = candidateValue;
        break;
      }
      t *= 0.5;
    }
    if (next === null || nextValue === null) break; // 回溯耗尽: 无法继续下降，诚实退出（converged=false）
    u = next;
    current = nextValue;
    iterations += 1;
    converged = maxAbsolute(current.grad) <= tol;
  }

  const dataLoss = btLogLoss(pairs, u);
  return {
    nItems: n,
    nPairs: winners.length,
    utilities: u,
    logLoss: dataLoss,
    iterations,
    gradientInfinityNorm: maxAbsolute(current.grad),
    converged,
  };
}

// ─────────────────────────── Elo 动态评分 ───────────────────────────

/**
 * Elo 单步更新: r_w += K(1−E_w)、r_l += K(0−E_l)。
 * 零和守恒（Σr 不变）; 期望分由赛前评分算出——爆冷 |Δ| 大、强队赢 |Δ| 小。
 * 纯函数: 返回新数组，不改入参。
 */
export function eloUpdate(state: { ratings: readonly number[]; k: number }, winner: number, loser: number): EloUpdateResult {
  const ratings = state.ratings;
  ensure(Array.isArray(ratings) && ratings.length >= 2, 'eloUpdate: ratings 必须是长度 ≥2 的数组');
  for (let i = 0; i < ratings.length; i += 1) {
    ensure(Number.isFinite(ratings[i]), `eloUpdate: ratings[${i}] 不是有限数`);
  }
  const k = state.k;
  ensure(Number.isFinite(k) && k > 0, `eloUpdate: k=${String(k)} 必须是正数`);
  ensure(Number.isInteger(winner) && winner >= 0 && winner < ratings.length, `eloUpdate: winner=${String(winner)} 越界`);
  ensure(Number.isInteger(loser) && loser >= 0 && loser < ratings.length, `eloUpdate: loser=${String(loser)} 越界`);
  ensure(winner !== loser, 'eloUpdate: winner === loser（不能与自己比赛）');
  const winnerExpected = expectedScore(ratings[winner], ratings[loser]);
  const winnerDelta = k * (1 - winnerExpected);
  const loserDelta = -winnerDelta; // E_l = 1−E_w → K(0−E_l) = −K(1−E_w): 零和
  const next = [...ratings];
  next[winner] = ratings[winner] + winnerDelta;
  next[loser] = ratings[loser] + loserDelta;
  let total = 0;
  for (const r of next) total += r;
  return { ratings: next, winnerDelta, loserDelta, winnerExpected, totalRating: total };
}

/**
 * Elo 在线序列: 按数据顺序逐步更新，第 t 步 K_t = K/t^kDecay。
 * kDecay=0: 恒定 K——围绕真值随机漫步（跟踪非平稳）; kDecay>0: 随机逼近
 * 收敛到静态 B-T 解邻域（同一期望损失的在线 SGD 视角）。
 */
export function eloSequence(pairs: readonly PreferencePair[], options?: EloSequenceOptions): EloSequenceResult {
  const { winners, losers, nItems } = validatePairs(pairs, 'eloSequence');
  const k = options?.k ?? ELO_DEFAULTS.k;
  const kDecay = options?.kDecay ?? ELO_DEFAULTS.kDecay;
  ensure(Number.isFinite(k) && k > 0, `eloSequence: k=${String(k)} 必须是正数`);
  ensure(Number.isFinite(kDecay) && kDecay >= 0 && kDecay <= 1, `eloSequence: kDecay=${String(kDecay)} 必须在 [0,1]`);
  let ratings: number[];
  if (options?.ratings !== undefined) {
    ratings = [...options.ratings];
    ensure(ratings.length >= nItems, `eloSequence: ratings 长度 ${ratings.length} < 数据推断的物品数 ${nItems}`);
    for (let i = 0; i < ratings.length; i += 1) {
      ensure(Number.isFinite(ratings[i]), `eloSequence: ratings[${i}] 不是有限数`);
    }
  } else {
    ratings = new Array<number>(nItems).fill(0);
  }
  let state = { ratings, k };
  for (let m = 0; m < winners.length; m += 1) {
    const stepK = k / Math.pow(m + 1, kDecay);
    state = { ratings: state.ratings, k: stepK };
    const updated = eloUpdate(state, winners[m], losers[m]);
    state = { ratings: updated.ratings, k: stepK };
  }
  const finalK = winners.length > 0 ? k / Math.pow(winners.length, kDecay) : k;
  return { ratings: [...state.ratings], steps: winners.length, finalK };
}

// ─────────────────────────── 传递性体检（多数图 SCC 环检测） ───────────────────────────

/** Tarjan 强连通分量（迭代实现——大数据不爆栈） */
function stronglyConnectedComponents(n: number, adjacency: ReadonlyArray<readonly number[]>): number[][] {
  let index = 0;
  const indices = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack: number[] = [];
  const components: number[][] = [];
  for (let root = 0; root < n; root += 1) {
    if (indices[root] !== -1) continue;
    indices[root] = index;
    low[root] = index;
    index += 1;
    stack.push(root);
    onStack[root] = 1;
    const frames: Array<{ v: number; edge: number }> = [{ v: root, edge: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const neighbors = adjacency[frame.v];
      if (frame.edge < neighbors.length) {
        const w = neighbors[frame.edge];
        frame.edge += 1;
        if (indices[w] === -1) {
          indices[w] = index;
          low[w] = index;
          index += 1;
          stack.push(w);
          onStack[w] = 1;
          frames.push({ v: w, edge: 0 });
        } else if (onStack[w] === 1) {
          if (indices[w] < low[frame.v]) low[frame.v] = indices[w];
        }
      } else {
        frames.pop();
        if (frames.length > 0) {
          const parent = frames[frames.length - 1];
          if (low[frame.v] < low[parent.v]) low[parent.v] = low[frame.v];
        }
        if (low[frame.v] === indices[frame.v]) {
          const component: number[] = [];
          for (;;) {
            const w = stack.pop() as number;
            onStack[w] = 0;
            component.push(w);
            if (w === frame.v) break;
          }
          components.push(component);
        }
      }
    }
  }
  return components;
}

/**
 * 传递性体检: 多数偏好图（每对取胜场严格多数的方向; 平局无边）上找有向环。
 * 无环 ⟺ 偏好剖面可被传递强度解释（B-T 的前提）; 有环（如石头剪刀布）
 * 则任何传递效用都无法忠实表达——环路组即非传递的证据链。
 */
export function transitivityCheck(pairs: readonly PreferencePair[]): TransitivityReport {
  const { winners, losers, nItems } = validatePairs(pairs, 'transitivityCheck');
  const counts = new Map<number, { i: number; j: number; winsOfI: number; winsOfJ: number }>();
  for (let m = 0; m < winners.length; m += 1) {
    const a = winners[m];
    const b = losers[m];
    const i = Math.min(a, b);
    const j = Math.max(a, b);
    const key = i * nItems + j;
    const entry = counts.get(key) ?? { i, j, winsOfI: 0, winsOfJ: 0 };
    if (a === i) entry.winsOfI += 1;
    else entry.winsOfJ += 1;
    counts.set(key, entry);
  }
  const edges: MajorityEdge[] = [];
  let tiedPairs = 0;
  const adjacency: number[][] = Array.from({ length: nItems }, () => []);
  for (const entry of counts.values()) {
    if (entry.winsOfI > entry.winsOfJ) {
      edges.push({ from: entry.i, to: entry.j, wins: entry.winsOfI, losses: entry.winsOfJ });
      adjacency[entry.i].push(entry.j);
    } else if (entry.winsOfJ > entry.winsOfI) {
      edges.push({ from: entry.j, to: entry.i, wins: entry.winsOfJ, losses: entry.winsOfI });
      adjacency[entry.j].push(entry.i);
    } else {
      tiedPairs += 1; // 势均力敌: 「说不清」而非「循环」——不算边也不算环
    }
  }
  const cycles = stronglyConnectedComponents(nItems, adjacency)
    .filter((component) => component.length >= 2)
    .map((component) => [...component].sort((a, b) => a - b))
    .sort((x, y) => y.length - x.length);
  const cyclicItems = cycles.reduce((sum, cycle) => sum + cycle.length, 0);
  return {
    nItems,
    nPairs: winners.length,
    transitive: cycles.length === 0,
    cycles,
    cyclicItemFraction: nItems > 0 ? cyclicItems / nItems : 0,
    edges,
    tiedPairs,
  };
}

// ─────────────────────────── B-T 拟合优度（非传递性失效信号） ───────────────────────────

/**
 * B-T 拟合优度: 逐对二项标准化残差 z = (w−np̂)/√(np̂(1−p̂))，
 * Pearson X² = Σz² 对照 χ²_{K−(n−1)}（in-sample 自由度扣减）。
 *
 * 失效信号双口径: 整体 p 值小（模型被数据拒绝）+ |z|>systematicZ 的
 * 系统性偏差对（具体哪几对解释不了——非传递性的指纹: 循环对会以
 * 「实测 100% vs 预测 50%」的极端残差暴露）。
 * df < 1（比较对数少于参数量）→ underdetermined=true、pValue=NaN——
 * 自由度不足的诚实陈述而非硬算。
 */
export function btGoodnessOfFit(
  pairs: readonly PreferencePair[],
  utilities: readonly number[],
  options?: BTGoodnessOfFitOptions,
): BTGoodnessOfFitReport {
  const { winners, losers, nItems } = validatePairs(pairs, 'btGoodnessOfFit');
  validateUtilities(utilities, nItems, 'btGoodnessOfFit');
  const systematicZ = options?.systematicZ ?? GOF_DEFAULTS.systematicZ;
  const alpha = options?.alpha ?? GOF_DEFAULTS.alpha;
  ensure(Number.isFinite(systematicZ) && systematicZ >= 0, `btGoodnessOfFit: systematicZ=${String(systematicZ)} 必须是非负数`);
  ensure(Number.isFinite(alpha) && alpha > 0 && alpha < 1, `btGoodnessOfFit: alpha=${String(alpha)} 必须在 (0,1)`);

  const groups = new Map<number, { i: number; j: number; comparisons: number; winsOfI: number }>();
  const seen = new Set<number>();
  for (let m = 0; m < winners.length; m += 1) {
    const a = winners[m];
    const b = losers[m];
    const i = Math.min(a, b);
    const j = Math.max(a, b);
    seen.add(a);
    seen.add(b);
    const key = i * nItems + j;
    const entry = groups.get(key) ?? { i, j, comparisons: 0, winsOfI: 0 };
    entry.comparisons += 1;
    if (a === i) entry.winsOfI += 1;
    groups.set(key, entry);
  }

  const residuals: PairGroupResidual[] = [];
  let chiSquare = 0;
  for (const entry of groups.values()) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, logistic(utilities[entry.i] - utilities[entry.j])));
    const sd = Math.sqrt(Math.max(entry.comparisons * p * (1 - p), 1e-24));
    const z = (entry.winsOfI - entry.comparisons * p) / sd;
    chiSquare += z * z;
    residuals.push({
      i: entry.i,
      j: entry.j,
      comparisons: entry.comparisons,
      winsOfI: entry.winsOfI,
      observedRate: entry.winsOfI / entry.comparisons,
      predictedRate: p,
      z,
    });
  }
  residuals.sort((x, y) => Math.abs(y.z) - Math.abs(x.z));

  const degreesOfFreedom = groups.size - (seen.size - 1);
  const underdetermined = degreesOfFreedom < 1;
  const pValue = underdetermined ? Number.NaN : chiSquarePValue(chiSquare, degreesOfFreedom);
  const maxAbsZ = residuals.length > 0 ? Math.abs(residuals[0].z) : 0;
  const worst = residuals.length > 0 ? { i: residuals[0].i, j: residuals[0].j } : null;
  const systematicCount = residuals.filter((r) => Math.abs(r.z) > systematicZ).length;
  const fitOk = !underdetermined && pValue >= alpha && maxAbsZ <= 3;
  return {
    nItems,
    nPairs: winners.length,
    groups: residuals,
    chiSquare,
    degreesOfFreedom,
    pValue,
    underdetermined,
    maxAbsZ,
    worstPair: worst,
    systematicCount,
    fitOk,
  };
}

// ─────────────────────────── 偏好采样工厂（确定性） ───────────────────────────

/**
 * B-T 采样工厂: 随机取物品对 (i,j)，按 P = σ(u_i−u_j) 定胜者;
 * noiseSigma>0 时每次比较的效用差叠加 N(0,σ²) 感知噪声——数据系统性
 * 偏离纯 B-T（Thurstone 式扁平化）。mulberry32(seed) 全程驱动:
 * 同 seed 逐位复现。
 */
export function simulatePreferences(
  utilities: readonly number[],
  nPairs: number,
  seed: number,
  options?: SimulateOptions,
): PreferencePair[] {
  ensure(Array.isArray(utilities) && utilities.length >= 2, 'simulatePreferences: utilities 必须是长度 ≥2 的数组');
  for (let i = 0; i < utilities.length; i += 1) {
    ensure(Number.isFinite(utilities[i]), `simulatePreferences: utilities[${i}] 不是有限数`);
  }
  ensure(Number.isInteger(nPairs) && nPairs >= 0, `simulatePreferences: nPairs=${String(nPairs)} 必须是非负整数`);
  const noiseSigma = options?.noiseSigma ?? 0;
  ensure(Number.isFinite(noiseSigma) && noiseSigma >= 0, `simulatePreferences: noiseSigma=${String(noiseSigma)} 必须是非负数`);
  const rng = mulberry32(seed);
  const n = utilities.length;
  const pairs: PreferencePair[] = [];
  for (let m = 0; m < nPairs; m += 1) {
    const i = Math.floor(rng() * n);
    let j = Math.floor(rng() * (n - 1));
    if (j >= i) j += 1; // (i,j) 均匀跑遍全部有序不相等对
    const delta = utilities[i] - utilities[j] + (noiseSigma > 0 ? noiseSigma * standardNormal(rng) : 0);
    const winner = rng() < logistic(delta) ? i : j;
    pairs.push({ winner, loser: winner === i ? j : i });
  }
  return pairs;
}

// ─────────────────────────── 留出验证（预测可信度） ───────────────────────────

/**
 * 留出验证: mulberry32(seed) Fisher–Yates 确定性划分，训练侧 B-T MLE，
 * 留出侧逐对预测。准确率口径: p>0.5 计 1、p=0.5 计 0.5（平局半分）。
 */
export function heldOutAccuracy(pairs: readonly PreferencePair[], options?: HeldOutOptions): HeldOutResult {
  const { winners, losers, nItems } = validatePairs(pairs, 'heldOutAccuracy');
  ensure(winners.length >= 2, 'heldOutAccuracy: 至少 2 对才能划分训练/留出');
  const testFraction = options?.testFraction ?? 1 / 3;
  ensure(Number.isFinite(testFraction) && testFraction > 0 && testFraction < 1, `heldOutAccuracy: testFraction=${String(testFraction)} 必须在 (0,1)`);
  const seed = options?.seed ?? 2027;
  const l2 = options?.l2 ?? BT_FIT_DEFAULTS.l2;
  const iters = options?.iters ?? BT_FIT_DEFAULTS.iters;
  const tol = options?.tol ?? BT_FIT_DEFAULTS.tol;

  const order = Array.from({ length: winners.length }, (_, i) => i);
  const rng = mulberry32(seed);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const swap = order[i];
    order[i] = order[j];
    order[j] = swap;
  }
  const nTest = Math.max(1, Math.min(order.length - 1, Math.floor(order.length * testFraction)));
  const testIndices = new Set(order.slice(0, nTest));
  const train: PreferencePair[] = [];
  const test: PreferencePair[] = [];
  for (let m = 0; m < winners.length; m += 1) {
    const pair = { winner: winners[m], loser: losers[m] };
    if (testIndices.has(m)) test.push(pair);
    else train.push(pair);
  }

  const fit = bradleyTerryMLE(train, { l2, iters, tol });
  let score = 0;
  let halfCredit = 0;
  let lossSum = 0;
  for (const pair of test) {
    const p = predictPair(fit.utilities, pair.winner, pair.loser);
    const clamped = Math.min(1 - 1e-15, Math.max(1e-15, p));
    lossSum += -Math.log(clamped);
    if (p > 0.5) score += 1;
    else if (p === 0.5) {
      score += 0.5; // 平局半分——效用相同的诚实面
      halfCredit += 1;
    }
  }
  return {
    nTrain: train.length,
    nTest: test.length,
    accuracy: score / test.length,
    halfCredit,
    testLogLoss: lossSum / test.length,
    utilities: fit.utilities,
  };
}

// ─────────────────────────── 名次件 ───────────────────────────

/** 按效用降序排名（同值按下标升序破平; rank 从 1 起） */
export function rankByUtility(utilities: readonly number[]): UtilityRank[] {
  ensure(Array.isArray(utilities) && utilities.length > 0, 'rankByUtility: utilities 必须是非空数组');
  for (let i = 0; i < utilities.length; i += 1) {
    ensure(Number.isFinite(utilities[i]), `rankByUtility: utilities[${i}] 不是有限数`);
  }
  return utilities
    .map((utility, index) => ({ index, utility }))
    .sort((a, b) => b.utility - a.utility || a.index - b.index)
    .map((entry, position) => ({ index: entry.index, utility: entry.utility, rank: position + 1 }));
}

// ─────────────────────────── R5 进化: Plackett-Luce 排名模型 ───────────────────────────

/** Plackett-Luce 拟合选项 */
export interface PLFitOptions {
  /** L2 正则 λ（缺省 1e-3）。λ=0 时 Hessian 沿全 1 向量奇异（平移不可辨识）→ 显式 throw */
  l2?: number;
  /** 牛顿迭代上限（缺省 200——排名步的凸性比 B-T 每对更平缓） */
  iters?: number;
  /** 梯度 ∞ 范数收敛容差（缺省 1e-10） */
  tol?: number;
  /** 物品数（缺省按数据推断; 显式给定时零出现物品被 λ 钉在 0） */
  nItems?: number;
}

export const PL_FIT_DEFAULTS = { l2: 1e-3, iters: 200, tol: 1e-10 } as const;

/** Plackett-Luce MLE 拟合结果 */
export interface PLFitResult {
  nItems: number;
  nRankings: number;
  /** 有效选择步数 Σ(|π|−1)（末位无悬念不计; logLoss 的归一分母） */
  totalSteps: number;
  /** 拟合效用（λ 正则向 0 收缩; 平移不变口径下只差可解释） */
  utilities: number[];
  /** 数据对数似然 Σ log P(π)（不含正则项） */
  logLikelihood: number;
  /** 每有效选择步平均负对数似然（两物品排名数据下与 B-T logLoss 同口径，对照锚 ln2） */
  logLoss: number;
  iterations: number;
  gradientInfinityNorm: number;
  converged: boolean;
}

/** 排名数据校验: 非空表、每张排名非空、下标非负整数、排名内无重复; 返回拷贝与推断物品数 */
function validateRankings(rankings: readonly (readonly number[])[], context: string): { lists: number[][]; nItems: number } {
  ensure(Array.isArray(rankings), `${context}: rankings 必须是数组`);
  ensure(rankings.length > 0, `${context}: 至少需要一张排名（空数据无法定标效用）`);
  const lists: number[][] = [];
  let maxIndex = -1;
  for (let r = 0; r < rankings.length; r += 1) {
    const ranking = rankings[r];
    ensure(Array.isArray(ranking), `${context}: 第 ${r} 张排名必须是数组`);
    ensure(ranking.length > 0, `${context}: 第 ${r} 张排名为空（至少含一个物品）`);
    const seen = new Set<number>();
    const row: number[] = [];
    for (let k = 0; k < ranking.length; k += 1) {
      const idx = Number(ranking[k]);
      ensure(Number.isInteger(idx) && idx >= 0, `${context}: 第 ${r} 张排名第 ${k} 位 ${String(ranking[k])} 不是非负整数下标`);
      ensure(!seen.has(idx), `${context}: 第 ${r} 张排名内下标 ${idx} 重复（排名是排列）`);
      seen.add(idx);
      row.push(idx);
      if (idx > maxIndex) maxIndex = idx;
    }
    lists.push(row);
  }
  return { lists, nItems: maxIndex + 1 };
}

/**
 * 排名一步的 softmax（max 平移——log-sum-exp 防溢出）。
 * suffix: 排名从位置 k 起的后缀（= 第 k 步的存活集合）;
 * 返回 LSE(u_suffix) 与逐存活物品的概率 p_i = e^{u_i}/Σ e^{u_j}（写入 probs 全表，非存活位为 0）。
 */
function suffixSoftmax(
  u: readonly number[],
  suffix: readonly number[],
  probs: number[],
): number {
  let m = -Infinity;
  for (let t = 0; t < suffix.length; t += 1) {
    const x = u[suffix[t] as number];
    if (x > m) m = x;
  }
  let sum = 0;
  for (let t = 0; t < suffix.length; t += 1) {
    const e = Math.exp(u[suffix[t] as number] - m);
    probs[suffix[t] as number] = e;
    sum += e;
  }
  const lse = m + Math.log(sum);
  for (let t = 0; t < suffix.length; t += 1) probs[suffix[t] as number] = (probs[suffix[t] as number] as number) / sum;
  return lse;
}

/** 清零 probs 的存活位之外不变——调用方保证传入前已清零 */
function clearProbs(probs: number[], suffix: readonly number[]): void {
  for (let t = 0; t < suffix.length; t += 1) probs[suffix[t] as number] = 0;
}

/**
 * 融合目标（R5 性能轴: 梯度复用）——单遍扫描同时累积损失/梯度/Hessian:
 *   L = Σ_π Σ_k [LSE_k − u_{π(k)}] + (λ/2)‖u‖²
 *   g_i = Σ_steps p_i^{step} − chosen_i + λu_i
 *   H = Σ_steps (diag_S(p) − p_S p_Sᵀ) + λI
 * 逐步 softmax 只算一遍，三路共用（naive 三遍参考实现逐位对照见 verify）。
 */
function plLossGradientHessian(
  lists: readonly (readonly number[])[],
  u: readonly number[],
  l2: number,
): { loss: number; grad: number[]; h: number[][] } {
  const n = u.length;
  const grad = new Array<number>(n).fill(0);
  const h = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const probs = new Array<number>(n).fill(0);
  let loss = 0;
  for (let r = 0; r < lists.length; r += 1) {
    const ranking = lists[r] as readonly number[];
    for (let k = 0; k < ranking.length; k += 1) {
      const suffix = ranking.slice(k);
      const lse = suffixSoftmax(u, suffix, probs);
      const pick = ranking[k] as number;
      loss += lse - u[pick];
      grad[pick] -= 1;
      for (let a = 0; a < suffix.length; a += 1) {
        const i = suffix[a] as number;
        grad[i] += probs[i] as number;
      }
      for (let a = 0; a < suffix.length; a += 1) {
        const i = suffix[a] as number;
        const pi = probs[i] as number;
        for (let b = 0; b < suffix.length; b += 1) {
          const j = suffix[b] as number;
          h[i]![j] += (i === j ? pi : 0) - pi * (probs[j] as number);
        }
      }
      clearProbs(probs, suffix);
    }
  }
  for (let i = 0; i < n; i += 1) {
    grad[i] += l2 * u[i] as number;
    loss += 0.5 * l2 * u[i]! * u[i]!;
    h[i]![i] += l2;
  }
  return { loss, grad, h };
}

/**
 * Plackett-Luce MLE（排名数据）: 牛顿法（IRLS）+ Armijo 回溯。
 *
 * P(π) = Π_k v_{π(k)}/Σ_{存活} v（v = e^u）; log P = Σ_k [u_{π(k)} − LSE_k]。
 * 凸 + λI 强凸 → 唯一解; λ=0 平移不可辨识 → 显式 throw（与 B-T 同款）。
 * 两物品排名 ⟺ B-T 偏好对（log P(i≻j) = log σ(u_i−u_j)）——同一似然。
 */
export function plackettLuceMLE(rankings: readonly (readonly number[])[], options?: PLFitOptions): PLFitResult {
  const { lists, nItems } = validateRankings(rankings, 'plackettLuceMLE');
  const l2 = options?.l2 ?? PL_FIT_DEFAULTS.l2;
  const iters = options?.iters ?? PL_FIT_DEFAULTS.iters;
  const tol = options?.tol ?? PL_FIT_DEFAULTS.tol;
  ensure(Number.isFinite(l2) && l2 >= 0, `plackettLuceMLE: l2=${String(l2)} 必须是非负数`);
  ensure(Number.isInteger(iters) && iters >= 1, `plackettLuceMLE: iters=${String(iters)} 必须是 ≥1 的整数`);
  ensure(Number.isFinite(tol) && tol > 0, `plackettLuceMLE: tol=${String(tol)} 必须是正数`);
  let n = nItems;
  if (options?.nItems !== undefined) {
    ensure(Number.isInteger(options.nItems) && options.nItems >= 2, `plackettLuceMLE: nItems=${String(options.nItems)} 必须是 ≥2 的整数`);
    ensure(options.nItems >= nItems, `plackettLuceMLE: nItems=${String(options.nItems)} 小于数据推断的物品数 ${nItems}`);
    n = options.nItems;
  }

  let u = new Array<number>(n).fill(0);
  let current = plLossGradientHessian(lists, u, l2);
  let iterations = 0;
  let converged = maxAbsolute(current.grad) <= tol;
  while (!converged && iterations < iters) {
    const step = solveLinearSystem(current.h, current.grad.map((g) => -g));
    if (step === null) {
      throw new Error(
        'plackettLuceMLE: 牛顿方程奇异——l2=0 时 PL 效用平移不可辨识（Hessian 沿全 1 向量有零空间）; 请用 l2>0（缺省 1e-3，只钉规范不伤拟合）',
      );
    }
    let slope = 0;
    for (let i = 0; i < n; i += 1) slope += current.grad[i]! * step[i]!;
    let t = 1;
    let next: number[] | null = null;
    let nextValue: { loss: number; grad: number[]; h: number[][] } | null = null;
    // R5 数值轴: Armijo 接受准则加损失尺度的相对噪声地板（1e-12·max(1,|L|)）
    // ——近最优处真实损失增量可能低于双精度可表示差（|L|·εmach），无地板
    // 会把「线搜索无法分辨的下降」误判为失败而提前退出（grad 卡在 ~1e-7）。
    const noiseFloor = 1e-12 * Math.max(1, Math.abs(current.loss));
    for (let backtrack = 0; backtrack < 40; backtrack += 1) {
      const candidate = u.map((x, i) => x + t * step[i]!);
      const candidateValue = plLossGradientHessian(lists, candidate, l2);
      if (
        Number.isFinite(candidateValue.loss) &&
        candidateValue.loss <= current.loss + 1e-4 * t * slope + noiseFloor
      ) {
        next = candidate;
        nextValue = candidateValue;
        break;
      }
      t *= 0.5;
    }
    if (next === null || nextValue === null) break; // 回溯耗尽: 诚实退出（converged=false）
    u = next;
    current = nextValue;
    iterations += 1;
    converged = maxAbsolute(current.grad) <= tol;
  }

  // 数据侧似然（不含正则项）: 逐排名对数域重算
  let totalSteps = 0;
  let ll = 0;
  const probsScratch = new Array<number>(n).fill(0);
  for (const ranking of lists) {
    totalSteps += ranking.length - 1; // 有效选择步（末位无悬念不计）
    for (let k = 0; k < ranking.length; k += 1) {
      const suffix = ranking.slice(k);
      const lse = suffixSoftmax(u, suffix, probsScratch);
      ll += u[ranking[k] as number]! - lse;
      clearProbs(probsScratch, suffix);
    }
  }
  return {
    nItems: n,
    nRankings: lists.length,
    totalSteps,
    utilities: u,
    logLikelihood: ll,
    logLoss: -ll / Math.max(1, totalSteps),
    iterations,
    gradientInfinityNorm: maxAbsolute(current.grad),
    converged,
  };
}

/** P(排名) 的对数域计算: Σ_k [u_{π(k)} − LSE(u_{π(k..)})]（max 平移稳定; 单物品排名 = 0）*/
export function plackettLuceLogProb(utilities: readonly number[], ranking: readonly number[]): number {
  const { lists, nItems } = validateRankings([ranking], 'plackettLuceLogProb');
  validateUtilities(utilities, nItems, 'plackettLuceLogProb');
  const u = utilities;
  const probs = new Array<number>(u.length).fill(0);
  let lp = 0;
  const list = lists[0] as number[];
  for (let k = 0; k < list.length; k += 1) {
    const suffix = list.slice(k);
    lp += u[list[k] as number]! - suffixSoftmax(u, suffix, probs);
    clearProbs(probs, suffix);
  }
  return lp;
}

/** P(排名) = exp(logProb)——线性域包装（长排名连乘可能下溢为 0，稳定口径用 logProb）*/
export function plackettLuceProbability(utilities: readonly number[], ranking: readonly number[]): number {
  return Math.exp(plackettLuceLogProb(utilities, ranking));
}

/**
 * 存活集内单步选择概率 P_S(i) = e^{u_i}/Σ_{j∈S} e^{u_j}（对数域）。
 * Luce 选择公理（IIA）的可观测面: P_S(i)/P_S(j) 与 S 无关。
 */
export function plackettLuceChoiceProbability(
  utilities: readonly number[],
  choiceSet: readonly number[],
  item: number,
): number {
  const { lists, nItems } = validateRankings([choiceSet], 'plackettLuceChoiceProbability');
  validateUtilities(utilities, nItems, 'plackettLuceChoiceProbability');
  ensure(Number.isInteger(item) && item >= 0 && item < utilities.length, `plackettLuceChoiceProbability: item=${String(item)} 越界`);
  ensure((lists[0] as number[]).includes(item), 'plackettLuceChoiceProbability: item 必须在 choiceSet 内');
  const probs = new Array<number>(utilities.length).fill(0);
  const lse = suffixSoftmax(utilities, lists[0] as number[], probs);
  clearProbs(probs, lists[0] as number[]);
  return Math.exp(utilities[item]! - lse);
}

/** 排名采样工厂选项 */
export interface SimulateRankingsOptions {
  /** 排名长度（缺省 = 全排列长度 n; 超过 n 取 n——top-k 排名） */
  rankingLength?: number;
}

/**
 * Plackett-Luce 排名采样（确定性）: 逐步从存活集按 softmax 抽一首位、
 * 移出、重复——产 top-k 或完整排名。每步恰消耗一个 mulberry32 均匀数，
 * 同 seed 逐位复现。
 */
export function simulateRankings(
  utilities: readonly number[],
  nRankings: number,
  seed: number,
  options?: SimulateRankingsOptions,
): number[][] {
  ensure(Array.isArray(utilities) && utilities.length >= 2, 'simulateRankings: utilities 必须是长度 ≥2 的数组');
  for (let i = 0; i < utilities.length; i += 1) {
    ensure(Number.isFinite(utilities[i]), `simulateRankings: utilities[${i}] 不是有限数`);
  }
  ensure(Number.isInteger(nRankings) && nRankings >= 0, `simulateRankings: nRankings=${String(nRankings)} 必须是非负整数`);
  const kFull = options?.rankingLength ?? utilities.length;
  ensure(Number.isInteger(kFull) && kFull >= 1, `simulateRankings: rankingLength=${String(kFull)} 必须是 ≥1 的整数`);
  const rng = mulberry32(seed);
  const n = utilities.length;
  const k = Math.min(kFull, n);
  const out: number[][] = [];
  for (let r = 0; r < nRankings; r += 1) {
    const alive = Array.from({ length: n }, (_, i) => i);
    const probs = new Array<number>(n).fill(0);
    const ranking: number[] = [];
    for (let step = 0; step < k; step += 1) {
      suffixSoftmax(utilities, alive, probs);
      const u = rng();
      let acc = 0;
      let pick = alive[alive.length - 1] as number;
      for (let t = 0; t < alive.length - 1; t += 1) {
        acc += probs[alive[t] as number] as number;
        if (u < acc) {
          pick = alive[t] as number;
          break;
        }
      }
      ranking.push(pick);
      alive.splice(alive.indexOf(pick), 1);
      clearProbs(probs, [pick]);
    }
    out.push(ranking);
  }
  return out;
}

/* ── 接线建议 ──
 * 1. 建议挂载引擎: reflection-engine.ts / reflector.ts（反思器·人类反馈
 *    通道）与 strategy-evolution.ts（策略进化适应度）——本内核是它们的
 *    「学到的人类偏好」理论核:
 *    a) 反思器把人工/用户反馈从「打分」改录为「偏好对」（哪次输出更好），
 *       攒够窗口量后 bradleyTerryMLE 学出候选策略/输出族的效用向量
 *       ——RLHF-lite: 不训练模型权重，只学调度层的价值序;
 *    b) 策略进化的适应度从硬编码指标升级为「学到的人类偏好效用」
 *       （rankByUtility 给名次、predictPair 给两策略对决的胜率）——
 *       指标改版不再作废历史: 偏好对是不变的原始证据，效用随时可重学;
 *    c) A/B 决策证据学: 两个方案的历史偏好对喂 MLE，价值差
 *       Δu = u_A−u_B 给点估计，heldOutAccuracy 给预测可信度;
 *       Δu 的可信前提是 btGoodnessOfFit.fitOk——不通过就别拿它决策。
 * 2. 前置体检（重要）: 任何偏好数据先过 transitivityCheck + btGoodnessOfFit
 *    双信号——环路组非空或系统性残差对超阈值，说明偏好不可传递建模
 *    （评审口味循环/多峰审美），此时 B-T 效用不可用于决策排序，
 *    应按环路组拆分场景分别学效用，或退回 64.0 相关均衡口径协调。
 * 3. Elo 通道: 在线流式反馈（不能攒批重训的场景）走 eloSequence——
 *    K/t^γ 收敛口径适合静态口味; 检测到口味漂移（留出准确率滑落）
 *    时把 γ 归零回到恒定 K 跟踪模式。Elo 分与 B-T 效用经 ELO_SCALE
 *    互转，两通道可对照审计。
 * 4. 缺省关闭旗标名: 反思器配置新增
 *    `preferenceLearning?: { enabled?: boolean; l2?: number; minPairs?: number }`
 *    （缺省 false，影子学习不改变主链路——与 77.0/88.0 旗标同款）。
 * 5. 挂载后改变的决策点: 反思器反馈口径（绝对打分 → 偏好对）、策略
 *    进化适应度（硬编码指标 → 学到效用）、A/B 终判（票数 → 价值差 +
 *    留出可信度 + 拟合优度前置体检）。未启用时行为与本内核加入前
 *    逐位一致（零漂移）。
 * 6. 成本注记: MLE 是 O(iters·(m + n³))（n = 物品数，m = 偏好对数），
 *    n 上百以内毫秒级; transitivityCheck O(n + m); GoF O(m)。
 *    偏好对是最敏感的人类数据——接线侧落盘须走 24.0 差分隐私的
 *    预算记账，效用发布前过 perturbNumbers。
 */
