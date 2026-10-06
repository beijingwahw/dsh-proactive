/**
 * self-boundary.ts — 100.0 自我边界内核（R5 进化 100.1）—— 能动性检测与自我/环境因果边界
 *
 * 动机: 系统一边行动一边观察世界, 收到的每路信号都要回答同一个归因问题:
 * 「这是**我**造成的, 还是世界自己发生的?」答错的代价真实存在——把环境
 * 波动归功于自己 = 自我评估虚高（进化环把运气记成功绩）; 把自己的破坏
 * 归咎环境 = 永不修正错误策略。5.0 因果内核管外部变量间的因果边（A/B
 * 干预证据）, 本内核把镜头转回自身: ①哪些信号是我的动作的效应（时间
 * 偶然性 contingency: 信号与自身动作的延迟互信息显著高于打乱基线）;
 * ②观察到的相关哪些在干预下幸存（do-calculus 口径: 只有自发随机动作
 * 造成的相关才是因果, 共因驱动的伪相关在干预下消失）; ③自我模型的
 * 连续性——策略进化改自我时的身份断点监控（大改 = 「我还是我吗」的
 * 可计算警报）。第 100 号封顶内核: 自我意识的可计算边界——不是哲学,
 * 是三个可检验的统计量。
 *
 * 数学:
 * 1. 时间偶然性（contingency）: 二值化（中位数劈分）后, 对延迟 d 算
 *      MI_d = I(a_{t-d} ; y_t)（bits, 经验联合分布）
 *    取 d* = argmax_d MI_d; 显著性 = 打乱基线 z 分: 把动作流循环移位
 *    （保边际与自相关, 毁对齐）, 同一估计器重算 max_d MI, B 次得基线
 *    μ/σ, z = (MI_{d*} − μ)/σ。z 大 ⟹ 「我做主的效应」显著高于环境
 *    自发结构——能动性的可操作定义（婴儿实验的同款范式: mobile-
 *    contingency detection）。
 * 2. 共因吸收（confounder absorption）: 观察到 I(a;y) > 0 有两种来源——
 *    a→y（自致）或 c→a, c→y（共因伪相关）。条件互信息分辨之:
 *      I(a;y|c) ≈ I(a;y) ⟹ 给定共因后依赖仍在 ⟹ 自致;
 *      I(a;y|c) ≈ 0（被吸收）⟹ 依赖全由共因解释 ⟹ 非自致。
 * 3. 干预与观察之别（do-calculus）: 观察相关 ρ_obs 与随机化干预效应
 *    ρ_do（do(a) 注入纯随机探索, a ⊥ c）之差 = 混淆的指纹:
 *    ρ_obs 高而 ρ_do ≈ 0 ⟹ 伪相关; ρ_do 高 ⟹ 真因果（干预下幸存）。
 *    观察永远无法排除未观测共因——这正是需要主动实验（探索注入）的
 *    数学理由, 内核对此诚实（无共因输入时只报 contingency, 不装懂）。
 * 4. 身份持续性: 参数距离 1 − ||p_b−p_a||/(||p_b||+||p_a||)（对称有界,
 *    量纲无关）× 行为一致性（探针上前后输出的一致率, 机会水平 0.5
 *    折算为 0）→ 连续性分; 低于阈值 = 身份断点警报（自我模型被「换人」,
 *    非渐进学习）。
 *
 * 验证锚点（scripts/verify-attention-self.mjs）:
 * ① 工厂流（delay=2 强引起 + spurious 共因噪声 + 纯外部事件三合一）:
 *    detectAgency 对自致通道分类准确率 ≥ 0.95（40 种子; vs 打乱基线
 *    z ≈ 数十倍的显著分离）; 外部通道零误报; 共因通道给出共因时正确
 *    判「混淆」而非「自致」, 不给共因时诚实报高偶然性（观察歧义）;
 * ② 延迟鲁棒性: delay 0..5 扫描检出全保持（z ≥ 阈且 d* = 真实延迟,
 *    MI 不随延迟衰减——衰减只来自有效样本 N=T−d 的减少, 诚实报告）;
 * ③ do vs observe: 共因场景观察相关 ≈ 0.56（P(a≠y) = 0.15⊛0.1 = 0.22,
 *    ρ = 1−2×0.22）、干预效应 ≈ 0 → 正确判「非自致 + 混淆」; 自致通道
 *    干预注入下真因果保持（ρ_do ≈ ρ_obs ≈ 0.8, P(y≠a) = 0.1）;
 * ④ 身份持续性: 参数微调连续性 ≈ 1 无警报, 随机重组触发 breakAlarm
 *    （两极对照, 阈值 0.5 两侧大幅分居）;
 * ⑤ 纯噪声流（agencyProb=0, spuriousCorr=0）: 100 种子零误报
 *    （300 通道 × z 检验无一超阈）。
 *
 * R5 进化（100.0 → 100.1）——多步因果边界 · 他者模型 · 增量偶然性:
 * ⑥ multiStepAttribution + simulateChain: 效应经中介链传导的传递归因
 *    ——目标依赖被中介吸收（Markov 链上 CMI=0）时, 看吸收者的延迟
 *    方向: 正延迟跟随我的动作 ⟹ transmitted-self（chainDelay = 首链
 *    + 次链延迟的传递估计）; 仅零延迟共变 ⟹ mediated-external
 *    （传递需要时间——零延迟依赖是共因的指纹, 不是我的效应）;
 *    沿链满足数据处理不等式（I(a;x1) ≥ … ≥ I(a;y)）;
 * ⑦ otherAgentModel + simulateOtherAgent: 信号源是否也是能动主体——
 *    反应性（b 在正延迟跟随我）+ 反应方向（镜像 = 合作 / 反制 = 对手
 *    意图的最低限度推断）+ 自主结构（AR 可预测性; 不理会我但带策略的
 *    主体仍被识别）; 时间方向不对称是护栏——角色对调后一切非负延迟
 *    MI 归零（对称注入鲁棒, 谁因谁果由时间戳说话）;
 * ⑧ IncrementalContingency: 偶然性检验的增量计算——流式维护列联计数
 *    （push 均摊 O(maxDelay), 观测曲线与 contingencyScore 批量口径
 *    逐位一致）, 对照批量重扫的 O(T·D) 每次结算。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 常量与类型 ───────────────────────────

/** 最短流长（MI 估计的样本下限; 更短的流偶然性不可辨识） */
const MIN_STREAM = 32;
/** 打乱基线的标准差下限（退化流防 0 除; z 有界化） */
const SD_FLOOR = 1e-6;

/** contingencyScore 结果 */
export interface ContingencyResult {
  /** 最佳延迟处的互信息（bits; ≥ 0） */
  readonly miBits: number;
  /** argmax 延迟（并列取最小 d——最早效应优先） */
  readonly bestDelay: number;
  /** 各延迟 0..maxDelay 的 MI 曲线（bits） */
  readonly delayCurve: readonly number[];
  /** 打乱基线均值（含 MI 有限样本正偏差, 同估计器口径） */
  readonly baselineMean: number;
  readonly baselineSd: number;
  /** (miBits − baselineMean)/baselineSd */
  readonly z: number;
  /** z ≥ zThreshold 且 miBits ≥ minMiBits */
  readonly significant: boolean;
}

/** 通道归类 */
export type AgencyClassification = 'self' | 'confounded' | 'external';

/** detectAgency 输入 */
export interface DetectAgencyInput {
  /** 自身动作流（任意数值; 内部中位数二值化） */
  readonly actions: readonly number[];
  /** 待归因的信号通道（每通道与 actions 等长） */
  readonly signals: ReadonlyArray<readonly number[]>;
  /** 已观测的共因候选流（可选; 给出时启用条件互信息吸收检验） */
  readonly confounders?: ReadonlyArray<readonly number[]>;
  /** 打乱种子（基线可复现） */
  readonly seed?: number;
  /** 延迟扫描上限（缺省 4） */
  readonly maxDelay?: number;
  /** 打乱次数（缺省 200） */
  readonly shuffles?: number;
  /** z 阈值（缺省 4） */
  readonly zThreshold?: number;
  /** MI 绝对下限 bits（缺省 0.02; 防微小但显著的伪阳性） */
  readonly minMiBits?: number;
  /** 共因吸收比例阈（缺省 0.8: 被吸收 ≥ 80% 判混淆） */
  readonly confoundAbsorbFrac?: number;
}

/** 单通道检测明细 */
export interface ChannelReport {
  readonly channelIndex: number;
  readonly contingency: ContingencyResult;
  /** 各共因的吸收比例（共因未给出时为空） */
  readonly absorbedBy: readonly number[];
  readonly classification: AgencyClassification;
  readonly selfCaused: boolean;
}

/** detectAgency 结果 */
export interface AgencyDetection {
  /** 逐通道「自致」判定 */
  readonly selfCaused: boolean[];
  readonly channels: readonly ChannelReport[];
  /** 全通道最大 z（能动性总强度） */
  readonly score: number;
  /** 全通道基线均值（有限样本偏差的可观测面） */
  readonly baseline: number;
}

/** 成对观测/干预流 */
export interface PairedStream {
  readonly x: readonly number[];
  readonly y: readonly number[];
}

/** doVsObserve 结果 */
export interface DoVsObserveResult {
  /** 观察相关 ρ_obs（Pearson; 延迟效应需调用方先对齐） */
  readonly observationalAssociation: number;
  /** 随机化干预效应 ρ_do（do(x) 注入下 x⊥c, 相关即因果） */
  readonly interventionalEffect: number;
  /** |ρ_obs| − |ρ_do|（混淆指纹） */
  readonly gap: number;
  /** gap > 阈 ⟹ 观察相关被混淆通胀 */
  readonly confounded: boolean;
  /** |ρ_do| ≥ 阈 ⟹ 干预下幸存的真因果（x 是 y 的原因） */
  readonly selfCaused: boolean;
}

/** 自我模型快照（参数向量） */
export interface SelfSnapshot {
  readonly parameters: readonly number[];
  readonly label?: string;
}

/** 行为测试: 探针 + 模型运行器（注入） */
export interface BehaviorTest {
  readonly probe: readonly number[];
  readonly run: (parameters: readonly number[], probe: readonly number[]) => number;
}

/** identityContinuity 结果 */
export interface IdentityContinuity {
  /** 1 − ||Δp||/(||p_b||+||p_a||)（对称有界 [0,1]; 量纲无关） */
  readonly paramContinuity: number;
  /** 机会校正后的行为一致率（无测试时 undefined） */
  readonly behaviorConsistency?: number;
  /** 综合连续性分（有测试 = 参数与行为各半权） */
  readonly score: number;
  /** score < breakThreshold ⟹ 身份断点（重组而非学习） */
  readonly breakAlarm: boolean;
  readonly threshold: number;
}

/** 信号通道种类（工厂三合一流） */
export type SimulatedChannelKind = 'self' | 'spurious' | 'external';

/** simulateEnv 结果 */
export interface SimulatedEnv {
  readonly actions: readonly number[];
  /** 通道顺序恒为 [self, spurious, external] */
  readonly signals: ReadonlyArray<readonly number[]>;
  readonly channelKinds: readonly SimulatedChannelKind[];
  /** 隐藏共因流（doVsObserve / 条件 MI 检验的素材） */
  readonly confounder: readonly number[];
  readonly delay: number;
}

/** simulateEnv 参数 */
export interface SimulateEnvOptions {
  /** 流长（缺省 600; ≥ 128） */
  readonly length?: number;
  /** 自致效应延迟（缺省 2; 0..length/4） */
  readonly delay?: number;
  /** 能动性概率: 动作以该概率引起信号, 否则信号自发（缺省 0.8;
   *  MI(a;y) = 1 − H₂((1−p)/2), p=0 ⟹ 纯噪声零偶然性） */
  readonly agencyProb?: number;
  /** 共因耦合率: 动作以该概率跟随共因 c, 否则自发探索比特（缺省 0.7;
   *  P(a≠c) = (1−s)/2 = 0.15） */
  readonly spuriousCorr?: number;
  /** 共因通道复制保真度（缺省 0.9, y = c⊕Bern(1−f)） */
  readonly confounderFidelity?: number;
  /** 外部事件自相关（缺省 0.5, 二值 AR: y_t = y_{t−1} w.p. r 否则新比特） */
  readonly externalPersistence?: number;
  /** do(a) 注入: 动作纯随机、脱离共因（缺省 false = 观察流） */
  readonly randomizeActions?: boolean;
  readonly seed?: number;
}

// ─────────────────────────── 确定性随机源 ───────────────────────────

/** 确定性 PRNG（mulberry32; 验证脚本与内核共用同一实现保证可复现） */
export function mulberry32(seed: number): () => number {
  if (!Number.isFinite(seed)) throw new Error('mulberry32: seed 必须为有限数');
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────── 基础统计工具 ───────────────────────────

/** 数值流基本校验（长度 ≥ min, 全有限） */
function validateStream(values: readonly number[], label: string, min: number): void {
  if (values.length < min) throw new Error(`${label}: 流长 ${values.length} < 下限 ${min}`);
  for (const v of values) {
    if (!Number.isFinite(v)) throw new Error(`${label}: 含非有限值`);
  }
}

/**
 * 中位数劈分二值化: v ≥ 中位数 → 1。
 * 中位数被下端质量占据时（偏斜二元流: 零多于半, 中位数 = min, naive
 * 「≥ 中位数」会把全流映成 1）退化为「严格大于最小值 → 1」——仍把
 * 流劈在两类之间。常数流 → 全 0 → 零信息（MI 诚实返回 0）。
 */
function binarize(values: readonly number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const lo = sorted[0];
  const threshold = sorted[Math.floor(sorted.length / 2)];
  if (threshold <= lo) return values.map((v) => (v > lo ? 1 : 0));
  return values.map((v) => (v >= threshold ? 1 : 0));
}

/**
 * 列联计数 → 二元互信息（bits; 0·log0 = 0 约定）
 *
 * 从 (n11, n10, n01, n00) 计数直接结算——批量（binaryMi）与增量
 * （IncrementalContingency）共用同一算术路径，保证两种口径逐位一致。
 */
function miFromCounts(n11: number, n10: number, n01: number, n00: number): number {
  const n = n11 + n10 + n01 + n00;
  if (n <= 0) return 0;
  const n1x = n11 + n10;
  const nx1 = n11 + n01;
  const p = (count: number): number => count / n;
  const contrib = (joint: number, margA: number, margB: number): number => {
    if (joint <= 0 || margA <= 0 || margB <= 0) return 0;
    return p(joint) * Math.log2(p(joint) / (margA / n) / (margB / n));
  };
  return (
    contrib(n11, n1x, nx1) + contrib(n10, n1x, n01 + n00) + contrib(n01, n10 + n00, nx1) + contrib(n00, n10 + n00, n01 + n00)
  );
}

/** 二元互信息（bits; 0·log0 = 0 约定） */
function binaryMi(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  let n11 = 0;
  let n1x = 0;
  let nx1 = 0;
  for (let t = 0; t < n; t += 1) {
    if (a[t] === 1) {
      n1x += 1;
      if (b[t] === 1) n11 += 1;
    }
    if (b[t] === 1) nx1 += 1;
  }
  const n10 = n1x - n11;
  const n01 = nx1 - n11;
  const n00 = n - n11 - n10 - n01;
  return miFromCounts(n11, n10, n01, n00);
}

/** 二元条件互信息 I(a;b|g)（bits; 8 格经验联合） */
function binaryCmi(a: readonly number[], b: readonly number[], g: readonly number[]): number {
  const n = a.length;
  const cell = new Array<number>(8).fill(0); // (g<<2)|(a<<1)|b
  for (let t = 0; t < n; t += 1) cell[(g[t] << 2) | (a[t] << 1) | b[t]] += 1;
  const cnt = (mask: number, value: number): number => {
    let s = 0;
    for (let k = 0; k < 8; k += 1) if ((k & mask) === value) s += cell[k];
    return s;
  };
  let total = 0;
  for (let k = 0; k < 8; k += 1) {
    if (cell[k] === 0) continue;
    const pK = cell[k] / n;
    // 被积项: p(a,b,g)·log[ p(a,b|g)/(p(a|g)p(b|g)) ]
    //   = pK·log[ pK·p(g)/(p(ag)·p(bg)) ]  （计数比: cell·nG/(nAG·nBG)）
    const gBit = (k >> 2) & 1;
    const aBit = (k >> 1) & 1;
    const bBit = k & 1;
    // 位选择: a 在 bit1、b 在 bit0 —— nAG 锁 (g,a) 两位（掩码 0b110），
    // nBG 锁 (g,b) 两位（掩码 0b101）；掩码与值的位必须一一对应
    const nG = cnt(0b100, gBit << 2);
    const nAG = cnt(0b110, (gBit << 2) | (aBit << 1));
    const nBG = cnt(0b101, (gBit << 2) | bBit);
    if (nAG === 0 || nBG === 0 || nG === 0) continue;
    total += pK * Math.log2((cell[k] * nG) / (nAG * nBG));
  }
  return total;
}

/** Pearson 相关系数（零方差 → 0） */
function pearson(x: readonly number[], y: readonly number[]): number {
  const n = x.length;
  let sx = 0;
  let sy = 0;
  for (let t = 0; t < n; t += 1) {
    sx += x[t];
    sy += y[t];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let t = 0; t < n; t += 1) {
    sxy += (x[t] - mx) * (y[t] - my);
    sxx += (x[t] - mx) ** 2;
    syy += (y[t] - my) ** 2;
  }
  if (sxx <= 0 || syy <= 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

/** 延迟对齐取样: (a[t−d], y[t]) 对, t = d..T−1 */
function alignedPairs(a: readonly number[], y: readonly number[], d: number): { aSeg: number[]; ySeg: number[] } {
  const aSeg: number[] = [];
  const ySeg: number[] = [];
  for (let t = d; t < y.length; t += 1) {
    aSeg.push(a[t - d]);
    ySeg.push(y[t]);
  }
  return { aSeg, ySeg };
}

/** max-over-delays MI 估计器（观测与打乱基线共用同一口径——z 可比） */
function maxOverDelays(actionsBin: readonly number[], signalBin: readonly number[], maxDelay: number): { mi: number; delay: number } {
  let best = -Infinity;
  let bestDelay = 0;
  for (let d = 0; d <= maxDelay; d += 1) {
    const { aSeg, ySeg } = alignedPairs(actionsBin, signalBin, d);
    const mi = binaryMi(aSeg, ySeg);
    if (mi > best) {
      best = mi;
      bestDelay = d;
    }
  }
  return { mi: best, delay: bestDelay };
}

// ─────────────────────────── ① 时间偶然性 ───────────────────────────

/**
 * 偶然性分数: 自身动作与信号流的延迟互信息, 相对打乱基线的 z 分。
 *
 * 基线 = 动作流循环移位（保边际/自相关, 毁偶然对齐）后同一估计器
 * （max over delays）的 B 次重算——有限样本 MI 正偏差与延迟扫描的
 * 最大化偏差被基线同口径吸收, z 只剩「偶然性」本身。
 */
export function contingencyScore(
  actions: readonly number[],
  signals: readonly number[],
  options: { maxDelay?: number; shuffles?: number; shuffleSeed?: number; zThreshold?: number; minMiBits?: number } = {},
): ContingencyResult {
  validateStream(actions, 'contingencyScore.actions', MIN_STREAM);
  validateStream(signals, 'contingencyScore.signals', MIN_STREAM);
  if (actions.length !== signals.length) throw new Error('contingencyScore: actions 与 signals 必须等长');
  const maxDelay = options.maxDelay ?? 4;
  const shuffles = options.shuffles ?? 200;
  const shuffleSeed = options.shuffleSeed ?? 12345;
  const zThreshold = options.zThreshold ?? 4;
  const minMiBits = options.minMiBits ?? 0.02;
  if (!Number.isInteger(maxDelay) || maxDelay < 0 || maxDelay > Math.floor(actions.length / 4)) {
    throw new Error(`contingencyScore: maxDelay 必须为 [0, ${Math.floor(actions.length / 4)}] 的整数`);
  }
  if (!Number.isInteger(shuffles) || shuffles < 20) throw new Error('contingencyScore: shuffles 至少 20（基线方差的样本下限）');
  if (!Number.isFinite(shuffleSeed)) throw new Error('contingencyScore: shuffleSeed 必须为有限数');
  if (zThreshold < 0 || minMiBits < 0) throw new Error('contingencyScore: 阈值必须 ≥ 0');

  const actionsBin = binarize(actions);
  const signalBin = binarize(signals);

  // 观测: 各延迟 MI 曲线 + 最佳延迟
  const delayCurve: number[] = [];
  for (let d = 0; d <= maxDelay; d += 1) {
    const { aSeg, ySeg } = alignedPairs(actionsBin, signalBin, d);
    delayCurve.push(binaryMi(aSeg, ySeg));
  }
  let bestDelay = 0;
  for (let d = 1; d <= maxDelay; d += 1) if (delayCurve[d] > delayCurve[bestDelay]) bestDelay = d;
  const miBits = delayCurve[bestDelay];

  // 打乱基线: 循环移位毁对齐, 同估计器（max over delays）
  const rng = mulberry32(shuffleSeed);
  const n = actionsBin.length;
  const baseline: number[] = [];
  for (let b = 0; b < shuffles; b += 1) {
    const shift = 1 + Math.floor(rng() * (n - 1));
    const shifted = new Array<number>(n);
    for (let t = 0; t < n; t += 1) shifted[t] = actionsBin[(t + shift) % n];
    baseline.push(maxOverDelays(shifted, signalBin, maxDelay).mi);
  }
  const baselineMean = baseline.reduce((s, v) => s + v, 0) / shuffles;
  let variance = 0;
  for (const v of baseline) variance += (v - baselineMean) ** 2;
  const baselineSd = Math.max(Math.sqrt(variance / shuffles), SD_FLOOR);
  const z = (miBits - baselineMean) / baselineSd;

  return {
    miBits,
    bestDelay,
    delayCurve,
    baselineMean,
    baselineSd,
    z,
    significant: z >= zThreshold && miBits >= minMiBits,
  };
}

// ─────────────────────────── ② 能动性检测 ───────────────────────────

/**
 * 能动性检测: 逐通道判「这路信号是我的动作造成的吗」。
 *
 * 判定链: contingency z 显著（偶然性高于打乱基线）
 *   → 给出共因时检验吸收: I(a;y|c) 被某共因吸收 ≥ confoundAbsorbFrac
 *     ⟹ 'confounded'（非自致——相关是共因的影子, 锚点 ③ 的判据）
 *   → 否则 'self'（自致）; z 不显著 ⟹ 'external'。
 * 未给出共因时不装懂: 高偶然性照报 'self'（观察层面无法排除未观测
 * 共因——这正是 doVsObserve 存在的理由, 见内核头注 3）。
 */
export function detectAgency(input: DetectAgencyInput): AgencyDetection {
  const { actions, signals } = input;
  validateStream(actions, 'detectAgency.actions', MIN_STREAM);
  if (signals.length < 1) throw new Error('detectAgency: 至少 1 个信号通道');
  for (const ch of signals) {
    validateStream(ch, 'detectAgency.signals', MIN_STREAM);
    if (ch.length !== actions.length) throw new Error('detectAgency: 每通道必须与 actions 等长');
  }
  const confounders = input.confounders ?? [];
  for (const g of confounders) {
    validateStream(g, 'detectAgency.confounders', MIN_STREAM);
    if (g.length !== actions.length) throw new Error('detectAgency: 共因流必须与 actions 等长');
  }
  const seed = input.seed ?? 12345;
  const maxDelay = input.maxDelay ?? 4;
  const shuffles = input.shuffles ?? 200;
  const zThreshold = input.zThreshold ?? 4;
  const minMiBits = input.minMiBits ?? 0.02;
  const absorbFrac = input.confoundAbsorbFrac ?? 0.8;
  if (absorbFrac < 0 || absorbFrac > 1) throw new Error('detectAgency: confoundAbsorbFrac 必须 ∈ [0,1]');

  const actionsBin = binarize(actions);
  const channels: ChannelReport[] = [];
  for (let c = 0; c < signals.length; c += 1) {
    const contingency = contingencyScore(actions, signals[c], {
      maxDelay,
      shuffles,
      shuffleSeed: seed + 1000 * c,
      zThreshold,
      minMiBits,
    });

    // 共因吸收检验（在该通道的最佳延迟处条件化）
    const signalBin = binarize(signals[c]);
    const confounderBins = confounders.map((g) => binarize(g));
    const absorbedBy: number[] = [];
    for (let g = 0; g < confounders.length; g += 1) {
      const d = contingency.bestDelay;
      const aSeg: number[] = [];
      const ySeg: number[] = [];
      const gSeg: number[] = [];
      for (let t = d; t < actions.length; t += 1) {
        aSeg.push(actionsBin[t - d]);
        ySeg.push(signalBin[t]);
        gSeg.push(confounderBins[g][t - d]);
      }
      const cmi = binaryCmi(aSeg, ySeg, gSeg);
      const absorbed = contingency.miBits > 1e-9 ? (contingency.miBits - cmi) / contingency.miBits : 0;
      if (absorbed >= absorbFrac) absorbedBy.push(g);
    }

    let classification: AgencyClassification = 'external';
    if (contingency.significant) classification = absorbedBy.length > 0 ? 'confounded' : 'self';
    channels.push({
      channelIndex: c,
      contingency,
      absorbedBy,
      classification,
      selfCaused: classification === 'self',
    });
  }

  const selfCaused = channels.map((ch) => ch.selfCaused);
  const score = channels.reduce((m, ch) => Math.max(m, ch.contingency.z), -Infinity);
  const baseline = channels.reduce((s, ch) => s + ch.contingency.baselineMean, 0) / channels.length;
  return { selfCaused, channels, score, baseline };
}

// ─────────────────────────── ③ 干预 vs 观察 ───────────────────────────

/**
 * do-calculus 口径的混淆检测: 观察相关 ρ_obs vs 随机化干预效应 ρ_do。
 *
 * 观察流可能被共因污染（c→x, c→y）; 干预流由调用方以 do(x)（纯随机
 * 注入, x⊥c）采集——其相关即因果效应。延迟效应需先对齐（x_t ← x_{t−d}）。
 * gap = |ρ_obs| − |ρ_do| > confoundGapThreshold ⟹ 混淆; |ρ_do| ≥
 * causalThreshold ⟹ 真因果（干预下幸存）。
 */
export function doVsObserve(
  observational: PairedStream,
  interventional: PairedStream,
  options: { confoundGapThreshold?: number; causalThreshold?: number } = {},
): DoVsObserveResult {
  validateStream(observational.x, 'doVsObserve.observational.x', 8);
  if (observational.x.length !== observational.y.length) throw new Error('doVsObserve: 观察流 x/y 必须等长');
  validateStream(observational.y, 'doVsObserve.observational.y', 8);
  validateStream(interventional.x, 'doVsObserve.interventional.x', 8);
  if (interventional.x.length !== interventional.y.length) throw new Error('doVsObserve: 干预流 x/y 必须等长');
  validateStream(interventional.y, 'doVsObserve.interventional.y', 8);
  const confoundGapThreshold = options.confoundGapThreshold ?? 0.15;
  const causalThreshold = options.causalThreshold ?? 0.15;
  if (confoundGapThreshold < 0 || causalThreshold < 0) throw new Error('doVsObserve: 阈值必须 ≥ 0');

  const observationalAssociation = pearson(observational.x, observational.y);
  const interventionalEffect = pearson(interventional.x, interventional.y);
  const gap = Math.abs(observationalAssociation) - Math.abs(interventionalEffect);
  return {
    observationalAssociation,
    interventionalEffect,
    gap,
    confounded: gap > confoundGapThreshold,
    selfCaused: Math.abs(interventionalEffect) >= causalThreshold,
  };
}

// ─────────────────────────── ④ 身份持续性 ───────────────────────────

/**
 * 自我模型连续性: 更新前后参数距离 × 行为一致性 → 连续性分 + 断点警报。
 *
 * paramContinuity = 1 − ||p_b−p_a||/(||p_b||+||p_a||+ε)（对称, [0,1]）;
 * behaviorConsistency: 各探针上输出一致率的机会校正
 *   (agree − chance)/(1 − chance), chance 缺省 0.5（±1 输出两策略的
 *   期望一致率; 随机重组折为 ≈ 0, 微调折为 ≈ 1）;
 * score = 有测试时参数/行为各半权, 否则即参数连续性;
 * breakAlarm = score < breakThreshold（缺省 0.5）——大改是「换人」而非学习。
 */
export function identityContinuity(
  before: SelfSnapshot,
  after: SelfSnapshot,
  options: {
    behaviorTests?: readonly BehaviorTest[];
    breakThreshold?: number;
    chanceAgreement?: number;
  } = {},
): IdentityContinuity {
  const pB = before.parameters;
  const pA = after.parameters;
  if (pB.length < 1 || pA.length < 1) throw new Error('identityContinuity: 参数向量至少 1 维');
  if (pB.length !== pA.length) throw new Error('identityContinuity: 前后参数向量必须同维');
  for (const v of pB) if (!Number.isFinite(v)) throw new Error('identityContinuity: before 含非有限参数');
  for (const v of pA) if (!Number.isFinite(v)) throw new Error('identityContinuity: after 含非有限参数');
  const tests = options.behaviorTests ?? [];
  const breakThreshold = options.breakThreshold ?? 0.5;
  const chance = options.chanceAgreement ?? 0.5;
  if (breakThreshold <= 0 || breakThreshold >= 1) throw new Error('identityContinuity: breakThreshold 必须 ∈ (0,1)');
  if (chance < 0 || chance >= 1) throw new Error('identityContinuity: chanceAgreement 必须 ∈ [0,1)');

  let sqSum = 0;
  let normB = 0;
  let normA = 0;
  for (let i = 0; i < pB.length; i += 1) {
    sqSum += (pB[i] - pA[i]) ** 2;
    normB += pB[i] ** 2;
    normA += pA[i] ** 2;
  }
  const paramContinuity = Math.max(0, 1 - Math.sqrt(sqSum) / (Math.sqrt(normB) + Math.sqrt(normA) + 1e-12));

  let behaviorConsistency: number | undefined;
  if (tests.length > 0) {
    let agreeSum = 0;
    for (const test of tests) {
      if (test.probe.length < 1) throw new Error('identityContinuity: 探针至少 1 维');
      for (const v of test.probe) if (!Number.isFinite(v)) throw new Error('identityContinuity: 探针含非有限值');
      const oB = test.run(pB, test.probe);
      const oA = test.run(pA, test.probe);
      if (!Number.isFinite(oB) || !Number.isFinite(oA)) throw new Error('identityContinuity: run 输出必须为有限数');
      const agree = 1 - Math.abs(oB - oA) / (Math.abs(oB) + Math.abs(oA) + 1e-12);
      agreeSum += Math.max(0, Math.min(1, agree));
    }
    const meanAgree = agreeSum / tests.length;
    behaviorConsistency = Math.max(0, Math.min(1, (meanAgree - chance) / (1 - chance)));
  }

  const score = behaviorConsistency === undefined ? paramContinuity : 0.5 * paramContinuity + 0.5 * behaviorConsistency;
  return {
    paramContinuity,
    behaviorConsistency,
    score,
    breakAlarm: score < breakThreshold,
    threshold: breakThreshold,
  };
}

// ─────────────────────────── ⑤ 环境工厂 ───────────────────────────

/**
 * 三合一流工厂: 自身动作延时效应 + 共因伪相关 + 纯外部事件。
 *
 *   c_t ~ Bern(1/2)                        隐藏共因
 *   a_t = c_t w.p. spuriousCorr 否则探索比特   （randomizeActions = true
 *        时 a_t 恒为纯探索比特 = do(a) 干预注入, a ⊥ c）
 *   self 通道: y_t = a_{t−d} w.p. agencyProb 否则自发比特
 *             （MI = 1 − H₂((1−p)/2); p = 0 ⟹ 纯噪声）
 *   spurious 通道: y_t = c_t ⊕ Bern(1−f)    与 a 的相关全由 c 解释
 *   external 通道: y_t = y_{t−1} w.p. r 否则新比特（有结构无偶然性）
 */
export function simulateEnv(options: SimulateEnvOptions = {}): SimulatedEnv {
  const length = options.length ?? 600;
  const delay = options.delay ?? 2;
  const agencyProb = options.agencyProb ?? 0.8;
  const spuriousCorr = options.spuriousCorr ?? 0.7;
  const confounderFidelity = options.confounderFidelity ?? 0.9;
  const externalPersistence = options.externalPersistence ?? 0.5;
  const seed = options.seed ?? 7;
  if (!Number.isInteger(length) || length < 128) throw new Error('simulateEnv: length 必须 ≥ 128');
  if (!Number.isInteger(delay) || delay < 0 || delay > Math.floor(length / 4)) {
    throw new Error(`simulateEnv: delay 必须为 [0, ${Math.floor(length / 4)}] 的整数`);
  }
  for (const [name, v] of [
    ['agencyProb', agencyProb],
    ['spuriousCorr', spuriousCorr],
    ['confounderFidelity', confounderFidelity],
  ] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`simulateEnv: ${name} 必须 ∈ [0,1]`);
  }
  if (!Number.isFinite(externalPersistence) || externalPersistence < 0 || externalPersistence >= 1) {
    throw new Error('simulateEnv: externalPersistence 必须 ∈ [0,1)');
  }
  if (!Number.isFinite(seed)) throw new Error('simulateEnv: seed 必须为有限数');

  const rng = mulberry32(seed);
  const bit = (p: number): number => (rng() < p ? 1 : 0);

  const confounder: number[] = [];
  const actions: number[] = [];
  const selfCh: number[] = [];
  const spuriousCh: number[] = [];
  const externalCh: number[] = [];
  let prevExternal = bit(0.5);
  for (let t = 0; t < length; t += 1) {
    const c = bit(0.5);
    confounder.push(c);
    // 动作: 观察流下以 spuriousCorr 跟随共因（c→a）, 其余为自发探索;
    // 干预流（do(a)）下恒为纯探索 → a ⊥ c
    const exploration = bit(0.5);
    actions.push(options.randomizeActions === true ? exploration : rng() < spuriousCorr ? c : exploration);
    // 自致通道: 动作以 agencyProb 在 delay 后生效, 否则世界自发
    const cause = t >= delay ? actions[t - delay] : bit(0.5);
    selfCh.push(rng() < agencyProb ? cause : bit(0.5));
    // 共因通道: c 的含噪拷贝（与 a 同时刻共享 c ⟹ 零延迟伪相关）
    spuriousCh.push(c ^ bit(1 - confounderFidelity));
    // 外部通道: 二值 AR（自相关结构, 与 a 无偶然对齐）
    prevExternal = rng() < externalPersistence ? prevExternal : bit(0.5);
    externalCh.push(prevExternal);
  }

  return {
    actions,
    signals: [selfCh, spuriousCh, externalCh],
    channelKinds: ['self', 'spurious', 'external'],
    confounder,
    delay,
  };
}

// ═══════════════════════════════════════════════════════════════════
// R5 进化（100.0 → 100.1）—— 多步因果链传递归因 · 他者模型 · 增量偶然性
// 纯数学区：确定性（mulberry32 种子化），零时钟零 I/O
// ═══════════════════════════════════════════════════════════════════

/**
 * 增量偶然性计数器: 流式维护各延迟的 2×2 列联计数（性能进化）
 *
 * contingencyScore 每次调用重扫全历史（O(T·D)）；流式监控（Sentinel 每
 * 周期推一对观测）只需增量维护计数——push 一对 (action, signal) 花
 * O(maxDelay)，任意时刻 snapshot 的观测延迟曲线与 contingencyScore
 * 对同一前缀的 delayCurve **逐位一致**（同一 miFromCounts 算术路径，
 * 整数计数无舍入）。打乱基线（z 分）是全量口径，流式场景按需用
 * contingencyScore 结算。
 *
 * 输入须为预二值化 0/1（调用方在线二值化；kernel 的 binarize 对 0/1
 * 流是恒等映射，故与 contingencyScore 等价锚点成立）。
 */
export class IncrementalContingency {
  private readonly capacity: number;
  private readonly actionRing: number[];
  /** tables[d] = 对 (a[t−d], y[t]) 的累计列联计数 */
  private readonly tables: Array<{ n: number; n11: number; n1x: number; nx1: number }>;
  private count = 0;

  constructor(maxDelay: number) {
    if (!Number.isInteger(maxDelay) || maxDelay < 0) {
      throw new Error('IncrementalContingency: maxDelay 必须 ≥ 0 的整数');
    }
    this.capacity = maxDelay + 1;
    this.actionRing = new Array<number>(this.capacity).fill(0);
    this.tables = Array.from({ length: maxDelay + 1 }, () => ({ n: 0, n11: 0, n1x: 0, nx1: 0 }));
  }

  /** 已接收样本数 */
  get length(): number {
    return this.count;
  }

  /** 推入一对观测（0/1）；均摊 O(maxDelay) */
  push(action: number, signal: number): void {
    if (action !== 0 && action !== 1) throw new Error('IncrementalContingency: action 必须为 0/1（预二值化）');
    if (signal !== 0 && signal !== 1) throw new Error('IncrementalContingency: signal 必须为 0/1（预二值化）');
    const t = this.count;
    const slot = t % this.capacity;
    this.actionRing[slot] = action;
    for (let d = 0; d < this.tables.length; d += 1) {
      if (t - d < 0) break;
      const aPast = this.actionRing[(t - d) % this.capacity] as number;
      const tab = this.tables[d] as { n: number; n11: number; n1x: number; nx1: number };
      tab.n += 1;
      if (aPast === 1) {
        tab.n1x += 1;
        if (signal === 1) tab.n11 += 1;
      }
      if (signal === 1) tab.nx1 += 1;
    }
    this.count = t + 1;
  }

  /** 批量推入（等长校验） */
  pushMany(actions: readonly number[], signals: readonly number[]): void {
    if (actions.length !== signals.length) throw new Error('IncrementalContingency: actions 与 signals 必须等长');
    for (let i = 0; i < actions.length; i += 1) this.push(actions[i] as number, signals[i] as number);
  }

  /** 观测延迟曲线（bits; 与 contingencyScore.delayCurve 同口径） */
  delayCurve(): number[] {
    return this.tables.map((tab) => {
      const n10 = tab.n1x - tab.n11;
      const n01 = tab.nx1 - tab.n11;
      const n00 = tab.n - tab.n1x - tab.nx1 + tab.n11;
      return miFromCounts(tab.n11, n10, n01, n00);
    });
  }

  /** 观测曲线的最优点（miBits = max, bestDelay = 首个 argmax） */
  observed(): { miBits: number; bestDelay: number; delayCurve: number[] } {
    const delayCurve = this.delayCurve();
    let bestDelay = 0;
    for (let d = 1; d < delayCurve.length; d += 1) if ((delayCurve[d] as number) > (delayCurve[bestDelay] as number)) bestDelay = d;
    return { miBits: delayCurve[bestDelay] as number, bestDelay, delayCurve };
  }
}

// ─────────────────────────── ⑥ 多步因果边界（延迟效应链的传递归因） ───────────────────────────

/** 延迟效应链工厂参数 */
export interface SimulateChainOptions {
  /** 流长（缺省 600; ≥ 256） */
  readonly length?: number;
  /** 中介数 m ≥ 1（缺省 2; a → x1 → … → xm → y） */
  readonly links?: number;
  /** 每链延迟 d ≥ 1（缺省 1; 总延迟 = (m+1)·d） */
  readonly delayPerLink?: number;
  /** 逐链复制保真度 ∈ (0,1]（缺省 0.9） */
  readonly fidelity?: number;
  /** true: 链头换成隐藏外源 c（动作以 followProb **同步**跟随 c——观察歧义流） */
  readonly externalDrive?: boolean;
  /** externalDrive 时动作跟随外源的概率（缺省 0.8） */
  readonly followProb?: number;
  readonly seed?: number;
}

/** 延迟效应链工厂输出 */
export interface SimulatedChain {
  readonly actions: readonly number[];
  /** 中介流 x1..xm（因果序） */
  readonly mediators: ReadonlyArray<readonly number[]>;
  /** 链尾目标 y */
  readonly target: readonly number[];
  /** externalDrive 时的隐藏外源流 */
  readonly hiddenExternal?: readonly number[];
  readonly delayPerLink: number;
  /** a → y 的总延迟 (m+1)·d */
  readonly totalDelay: number;
}

/**
 * 延迟效应链工厂: a → x1 → … → xm → y，每链延迟 d、复制保真度 f。
 *
 *   自致链: a_t ~ Bern(1/2)（我的探索比特）; x^j_t = x^{j−1}_{t−d} w.p. f
 *           否则新比特; y_t = x^m_{t−d} w.p. f 否则新比特
 *           —— Markov 链 ⟹ I(a; y | x^j) = 0（总体）: 中介完全中介;
 *             x1 在正延迟 d 上跟随我（链头自致指纹）
 *   外源链: c_t ~ Bern(1/2) iid（隐藏外源）; a_t = c_t w.p. s（同步跟随
 *           ——同一环境上下文）; x1_t = c_t 的含噪拷贝（**零延迟**）;
 *           其余链与 y 照常逐链延迟
 *           —— a_{t−D} 与 y_t 仍有依赖（都指向 c_{t−D}）但 x1 只在零延迟
 *              与我共变: 传递需要时间，链头零延迟共变 = 同步共因指纹
 *              （下游中介继承延迟指纹是链传导的伪影——归因看链头）
 */
export function simulateChain(options: SimulateChainOptions = {}): SimulatedChain {
  const length = options.length ?? 600;
  const links = options.links ?? 2;
  const delayPerLink = options.delayPerLink ?? 1;
  const fidelity = options.fidelity ?? 0.9;
  const externalDrive = options.externalDrive === true;
  const followProb = options.followProb ?? 0.8;
  const seed = options.seed ?? 7;
  if (!Number.isInteger(length) || length < 256) throw new Error('simulateChain: length 必须 ≥ 256');
  if (!Number.isInteger(links) || links < 1 || links > 6) throw new Error('simulateChain: links 必须 ∈ [1,6] 的整数');
  if (!Number.isInteger(delayPerLink) || delayPerLink < 1 || delayPerLink * (links + 1) > Math.floor(length / 4)) {
    throw new Error(`simulateChain: delayPerLink 必须 ≥ 1 且总延迟 (m+1)·d ≤ length/4 = ${Math.floor(length / 4)}`);
  }
  for (const [name, v] of [
    ['fidelity', fidelity],
    ['followProb', followProb],
  ] as const) {
    if (!Number.isFinite(v) || v <= 0 || v > 1) throw new Error(`simulateChain: ${name} 必须 ∈ (0,1]`);
  }
  if (!Number.isFinite(seed)) throw new Error('simulateChain: seed 必须为有限数');

  const rng = mulberry32(seed);
  const bit = (p: number): number => (rng() < p ? 1 : 0);
  const actions: number[] = [];
  const external: number[] = [];
  const levels: number[][] = Array.from({ length: links }, () => []);
  const target: number[] = [];
  for (let t = 0; t < length; t += 1) {
    // 隐藏外源: iid 比特（无自相关——自相关外源会把共因泄漏进正延迟,
    // 使观察层面与自致链不可分, 见 multiStepAttribution 头注的诚实边界）
    const c = bit(0.5);
    external.push(c);
    // 我的动作: 外源模式下以 followProb 同步跟随 c（零延迟共变），否则纯探索比特
    actions.push(externalDrive && rng() < followProb ? c : bit(0.5));
    // 链: 第 1 层 = 链头（外源模式下零延迟拷贝 c; 自致模式下延迟拷贝 a）,
    // 其余层 = 前一层延迟 d 的含噪拷贝
    for (let j = 0; j < links; j += 1) {
      if (j === 0 && externalDrive) {
        (levels[0] as number[]).push(rng() < fidelity ? c : bit(0.5));
        continue;
      }
      const source = j === 0 ? actions : (levels[j - 1] as number[]);
      (levels[j] as number[]).push(t >= (j + (externalDrive ? 0 : 1)) * delayPerLink && rng() < fidelity ? (source[t - delayPerLink] as number) : bit(0.5));
    }
    const last = levels[links - 1] as number[];
    target.push(t >= links * delayPerLink + delayPerLink && rng() < fidelity ? (last[t - delayPerLink] as number) : bit(0.5));
  }
  return {
    actions,
    mediators: levels,
    target,
    hiddenExternal: externalDrive ? external : undefined,
    delayPerLink,
    totalDelay: (links + 1) * delayPerLink,
  };
}

/** 多步归因的中介检验明细 */
export interface ChainLinkReport {
  /** 中介下标（mediators 顺序，0 = x1） */
  readonly index: number;
  /** 中介是否与我的动作有显著偶然性 */
  readonly selfSignificant: boolean;
  /** 中介的自身偶然性最佳延迟（正延迟 = 我的效应在链上; 0 = 同步共变指纹） */
  readonly delay: number | null;
  /** 中介 → 目标的第二链延迟（argmax_d I(x_j[t−d]; y_t)） */
  readonly downstreamDelay: number | null;
  /** 目标对动作的依赖被该中介吸收的比例 (MI − CMI)/MI */
  readonly absorbedFraction: number;
  /** 正延迟自致（延迟效应链上的「我的效应」环节） */
  readonly isSelfLink: boolean;
}

/** 多步因果边界分类 */
export type ChainClassification = 'direct-self' | 'transmitted-self' | 'mediated-external' | 'external';

/** multiStepAttribution 结果 */
export interface ChainAttribution {
  readonly classification: ChainClassification;
  /** 目标通道对动作的偶然性（无中介时即直接归因） */
  readonly targetContingency: ContingencyResult;
  /** 逐中介检验明细 */
  readonly links: readonly ChainLinkReport[];
  /** 传递归因的链延迟估计（首个自致链中介的 delay + downstreamDelay; 无则 null） */
  readonly chainDelay: number | null;
  /** 分类 ∈ {direct-self, transmitted-self} */
  readonly selfCaused: boolean;
}

/**
 * 多步因果边界: 「这路信号是我的动作**经由延迟效应链**造成的吗」
 *
 * 单步偶然性只回答直接效应；效应经中介链传导时（a → x → … → y），
 * 目标与我的动作既相关又隔了链——归因必须回答三件事:
 *   ① 目标显著吗（不显著 → external，诚实边界）;
 *   ② 依赖被中介吸收吗: absorbed = (I(a; y) − I(a; y | x_j)) / I(a; y)
 *      ≥ absorbFrac —— Markov 链上总体 CMI = 0（完全中介）;
 *   ③ 吸收者的「自致性」看**延迟方向**: 中介在正延迟 d ≥ 1 上跟随我的
 *      动作 ⟹ 链上流动的是我的效应（transmitted-self, chainDelay =
 *      d_j + d2_j 传递延迟）; 中介只在零延迟与动作共变 ⟹ 同步共因
 *      指纹——链上流动的是外源（mediated-external——传递需要时间,
 *      零延迟依赖在物理上不可能是我的因果效应）。
 * 判定链: external → (无吸收者 → direct-self) → **链头判性**（最早吸收者
 * 在正延迟自致 → transmitted-self, chainDelay = d_j + d2_j 传递估计;
 * 仅零延迟共变 → mediated-external——下游中介的正延迟依赖是外源经链
 * 传导的伪影, 归因看链头）。数据处理不等式沿链可验
 * （I(a; x1) ≥ I(a; x2) ≥ … ≥ I(a; y)，脚本侧锚点）。
 *
 * 诚实边界: 隐藏外源若自相关, 观察层面与自致链不可分（共因经自相关
 * 渗进正延迟）——simulateChain 的外源用 iid c, 该歧义正是 doVsObserve
 * （主动干预）存在的理由。
 */
export function multiStepAttribution(input: {
  readonly actions: readonly number[];
  readonly mediators?: ReadonlyArray<readonly number[]>;
  readonly target: readonly number[];
  readonly seed?: number;
  readonly maxDelay?: number;
  readonly shuffles?: number;
  readonly zThreshold?: number;
  readonly minMiBits?: number;
  /** 吸收比例阈（缺省 0.7） */
  readonly absorbFrac?: number;
}): ChainAttribution {
  const { actions, target } = input;
  validateStream(actions, 'multiStepAttribution.actions', MIN_STREAM);
  validateStream(target, 'multiStepAttribution.target', MIN_STREAM);
  if (actions.length !== target.length) throw new Error('multiStepAttribution: actions 与 target 必须等长');
  const mediators = input.mediators ?? [];
  for (const m of mediators) {
    validateStream(m, 'multiStepAttribution.mediators', MIN_STREAM);
    if (m.length !== actions.length) throw new Error('multiStepAttribution: 每条中介流必须与 actions 等长');
  }
  const seed = input.seed ?? 12345;
  const maxDelay = input.maxDelay ?? Math.max(4, Math.floor(actions.length / 16));
  const shuffles = input.shuffles ?? 200;
  const zThreshold = input.zThreshold ?? 4;
  const minMiBits = input.minMiBits ?? 0.02;
  const absorbFrac = input.absorbFrac ?? 0.7;
  if (absorbFrac < 0 || absorbFrac > 1) throw new Error('multiStepAttribution: absorbFrac 必须 ∈ [0,1]');

  const targetContingency = contingencyScore(actions, target, {
    maxDelay,
    shuffles,
    shuffleSeed: seed,
    zThreshold,
    minMiBits,
  });
  const D = targetContingency.bestDelay;
  const actionsBin = binarize(actions);
  const targetBin = binarize(target);

  const links: ChainLinkReport[] = [];
  for (let j = 0; j < mediators.length; j += 1) {
    const mediator = mediators[j] as readonly number[];
    // 中介自身的偶然性（对动作）: 延迟方向是自致链 vs 同步共因的判据
    const selfCont = contingencyScore(actions, mediator, {
      maxDelay,
      shuffles,
      shuffleSeed: seed + 1000 * (j + 1),
      zThreshold,
      minMiBits,
    });
    // 第二链延迟: argmax_d I(x_j[t−d]; y_t)
    const mediatorBin = binarize(mediator);
    let downstreamDelay: number | null = null;
    let bestDownMi = -Infinity;
    for (let d = 0; d <= maxDelay; d += 1) {
      const xSeg: number[] = [];
      const ySeg: number[] = [];
      for (let t = d; t < target.length; t += 1) {
        xSeg.push(mediatorBin[t - d] as number);
        ySeg.push(targetBin[t] as number);
      }
      const mi = binaryMi(xSeg, ySeg);
      if (mi > bestDownMi) {
        bestDownMi = mi;
        downstreamDelay = d;
      }
    }
    // 吸收检验: I(a_{t−D}; y_t | x_j[t−d2]) 相对 I(a_{t−D}; y_t)
    const aSeg: number[] = [];
    const ySeg2: number[] = [];
    const gSeg: number[] = [];
    const d2 = downstreamDelay as number;
    for (let t = Math.max(D, d2); t < actions.length; t += 1) {
      aSeg.push(actionsBin[t - D] as number);
      ySeg2.push(targetBin[t] as number);
      gSeg.push(mediatorBin[t - d2] as number);
    }
    const cmi = binaryCmi(aSeg, ySeg2, gSeg);
    const absorbedFraction = targetContingency.miBits > 1e-9
      ? Math.max(0, Math.min(1, (targetContingency.miBits - cmi) / targetContingency.miBits))
      : 0;
    links.push({
      index: j,
      selfSignificant: selfCont.significant,
      delay: selfCont.significant ? selfCont.bestDelay : null,
      downstreamDelay,
      absorbedFraction,
      isSelfLink: selfCont.significant && (selfCont.bestDelay as number) >= 1,
    });
  }

  let classification: ChainClassification;
  let chainDelay: number | null = null;
  if (!targetContingency.significant) {
    classification = 'external';
  } else {
    // 链头判性: 因果自链头进入——**最早的**吸收者定调整条链。链头在正延迟
    // 跟随我 ⟹ transmitted-self（下游继承延迟指纹是传导）; 链头仅零延迟
    // 共变 ⟹ mediated-external（同步共因指纹——下游的正延迟依赖是
    // 外源经链传导的伪影, 不是我的效应）。
    const absorbers = links.filter((l) => l.absorbedFraction >= absorbFrac);
    const head = absorbers.length > 0 ? (absorbers[0] as ChainLinkReport) : undefined;
    if (head !== undefined && head.isSelfLink) {
      classification = 'transmitted-self';
      chainDelay = (head.delay as number) + (head.downstreamDelay as number);
    } else if (head !== undefined) {
      classification = 'mediated-external';
    } else {
      classification = 'direct-self';
    }
  }
  return {
    classification,
    targetContingency,
    links,
    chainDelay,
    selfCaused: classification === 'direct-self' || classification === 'transmitted-self',
  };
}

// ─────────────────────────── ⑦ 他者模型（other-agent 检测与最低限度意图推断） ───────────────────────────

/** 他者流种类 */
export type OtherAgentKind = 'mirror' | 'counter' | 'independent-agent' | 'environment';

/** 他者流工厂参数 */
export interface SimulateOtherOptions {
  /** 他者种类（必填） */
  readonly kind: OtherAgentKind;
  /** 流长（缺省 600; ≥ 128） */
  readonly length?: number;
  /** 反应延迟 ≥ 1（mirror/counter 用; 缺省 2） */
  readonly delay?: number;
  /** 反应强度 r ∈ [0,1]（mirror/counter 用; 缺省 0.8） */
  readonly responsiveness?: number;
  /** independent-agent 的自相关（缺省 0.7, 二值 AR） */
  readonly persistence?: number;
  readonly seed?: number;
}

/**
 * 他者流工厂: 我（iid 探索比特）与一路观察流的四种关系。
 *
 *   mirror:  b_t = a_{t−d} w.p. r 否则新比特（模仿者——合作意图指纹）
 *   counter: b_t = 1 − a_{t−d} w.p. r 否则新比特（对抗者——对手意图指纹）
 *   independent-agent: 二值 AR（自相关 p）——有策略结构但不理会我
 *   environment: iid 比特（无结构无反应——纯环境噪声）
 */
export function simulateOtherAgent(options: SimulateOtherOptions): { actions: readonly number[]; other: readonly number[] } {
  const { kind } = options;
  if (kind !== 'mirror' && kind !== 'counter' && kind !== 'independent-agent' && kind !== 'environment') {
    throw new Error(`simulateOtherAgent: kind 非法（${String(kind)}）`);
  }
  const length = options.length ?? 600;
  const delay = options.delay ?? 2;
  const responsiveness = options.responsiveness ?? 0.8;
  const persistence = options.persistence ?? 0.7;
  const seed = options.seed ?? 7;
  if (!Number.isInteger(length) || length < 128) throw new Error('simulateOtherAgent: length 必须 ≥ 128');
  if (!Number.isInteger(delay) || delay < 1 || delay > Math.floor(length / 4)) {
    throw new Error(`simulateOtherAgent: delay 必须 ∈ [1, ${Math.floor(length / 4)}] 的整数`);
  }
  if (!Number.isFinite(responsiveness) || responsiveness < 0 || responsiveness > 1) {
    throw new Error('simulateOtherAgent: responsiveness 必须 ∈ [0,1]');
  }
  if (!Number.isFinite(persistence) || persistence < 0 || persistence >= 1) {
    throw new Error('simulateOtherAgent: persistence 必须 ∈ [0,1)');
  }
  if (!Number.isFinite(seed)) throw new Error('simulateOtherAgent: seed 必须为有限数');
  const rng = mulberry32(seed);
  const bit = (p: number): number => (rng() < p ? 1 : 0);
  const actions: number[] = [];
  const other: number[] = [];
  let prev = bit(0.5);
  for (let t = 0; t < length; t += 1) {
    const a = bit(0.5);
    actions.push(a);
    if (kind === 'mirror') {
      other.push(t >= delay && rng() < responsiveness ? (actions[t - delay] as number) : bit(0.5));
    } else if (kind === 'counter') {
      other.push(t >= delay && rng() < responsiveness ? 1 - (actions[t - delay] as number) : bit(0.5));
    } else if (kind === 'independent-agent') {
      prev = rng() < persistence ? prev : bit(0.5);
      other.push(prev);
    } else {
      other.push(bit(0.5));
    }
  }
  return { actions, other };
}

/** 他者模型检测结果 */
export interface OtherAgentReport {
  /** 观察流是能动主体的证据（对我的反应 或 自身策略结构） */
  readonly isAgent: boolean;
  /** b 在正延迟上跟随我的动作（偶然性显著高于打乱基线） */
  readonly reactsToMe: boolean;
  readonly reactionDelay: number | null;
  /** Pearson(a[t−d*], b[t])（二值化口径）——反应方向的最低限度读数 */
  readonly responseCorrelation: number;
  readonly responseStrength: number;
  /** 'mirror'（corr > 阈）/ 'counter'（corr < −阈）/ 'neutral' */
  readonly intent: 'mirror' | 'counter' | 'neutral';
  /** 自身策略结构: max(0, 2·P(b_t = b_{t−1}) − 1)（机会校正的可预测性） */
  readonly selfStructure: number;
  readonly contingency: ContingencyResult;
}

/**
 * 他者模型: 信号源也是能动主体吗——对手意图的最低限度推断。
 *
 * 三条证据链（每条都有「不是主体」的对照）:
 *   ① 反应性: contingencyScore(a, b) 显著 ⟹ b 在 d* 延迟上系统跟随我
 *      ——环境不会针对你（对照 environment: iid ⟹ z 落回基线）;
 *   ② 方向: 反应延迟处的 Pearson 符号——正 = 镜像（合作/模仿），负 =
 *      反制（对抗意图的最低限度读数: 「它在系统性抵消我的动作」）;
 *   ③ 自主结构: b 的下一比特可预测性超出机会的部分（二值 AR 检验）——
 *      有策略但不理会我的主体（independent-agent）仍被识别为 agent。
 *      阈 0.2 ≈ 600 长 iid 流上 ~5σ（match 率 σ ≈ 0.020 → 结构 σ ≈ 0.041）,
 *      百通道量级的零误报口径。
 * 时间方向的不对称是归因的护栏（对称注入鲁棒性）: mirror/counter 的
 * 依赖是 b_t ← a_{t−d}——把两条流角色对调（b 当「我的动作」）后一切
 * 非负延迟上的 MI 归零 ⟹ 谁因谁果由时间戳说话，不是相关系数说话。
 */
export function otherAgentModel(
  myActions: readonly number[],
  otherStream: readonly number[],
  options: {
    maxDelay?: number;
    shuffles?: number;
    seed?: number;
    zThreshold?: number;
    minMiBits?: number;
    intentThreshold?: number;
    structureThreshold?: number;
  } = {},
): OtherAgentReport {
  validateStream(myActions, 'otherAgentModel.myActions', MIN_STREAM);
  validateStream(otherStream, 'otherAgentModel.otherStream', MIN_STREAM);
  if (myActions.length !== otherStream.length) throw new Error('otherAgentModel: 两条流必须等长');
  const maxDelay = options.maxDelay ?? 4;
  const shuffles = options.shuffles ?? 200;
  const seed = options.seed ?? 12345;
  const zThreshold = options.zThreshold ?? 4;
  const minMiBits = options.minMiBits ?? 0.02;
  const intentThreshold = options.intentThreshold ?? 0.15;
  const structureThreshold = options.structureThreshold ?? 0.2;
  if (intentThreshold < 0 || intentThreshold >= 1) throw new Error('otherAgentModel: intentThreshold 必须 ∈ [0,1)');
  if (structureThreshold < 0 || structureThreshold >= 1) throw new Error('otherAgentModel: structureThreshold 必须 ∈ [0,1)');

  const contingency = contingencyScore(myActions, otherStream, { maxDelay, shuffles, shuffleSeed: seed, zThreshold, minMiBits });
  const reactsToMe = contingency.significant;
  const reactionDelay = reactsToMe ? contingency.bestDelay : null;

  // 反应方向: 在最佳延迟处的延迟对齐 Pearson（二值化口径）
  const aBin = binarize(myActions);
  const bBin = binarize(otherStream);
  let responseCorrelation = 0;
  if (reactionDelay !== null) {
    const { aSeg, ySeg } = alignedPairs(aBin, bBin, reactionDelay);
    responseCorrelation = pearson(aSeg, ySeg);
  }

  // 自主结构: 下一比特可预测性的机会校正（AR 检验）
  let match = 0;
  let pairs = 0;
  for (let t = 1; t < bBin.length; t += 1) {
    if ((bBin[t] as number) === (bBin[t - 1] as number)) match += 1;
    pairs += 1;
  }
  const selfStructure = Math.max(0, (2 * match) / pairs - 1);

  const intent: 'mirror' | 'counter' | 'neutral' = !reactsToMe
    ? 'neutral'
    : responseCorrelation > intentThreshold
      ? 'mirror'
      : responseCorrelation < -intentThreshold
        ? 'counter'
        : 'neutral';
  return {
    isAgent: reactsToMe || selfStructure >= structureThreshold,
    reactsToMe,
    reactionDelay,
    responseCorrelation,
    responseStrength: Math.abs(responseCorrelation),
    intent,
    selfStructure,
    contingency,
  };
}

/* ── 接线建议 ──
 * 1. 建议挂载引擎: src/meta/self-model.ts（元认知自我模型）——
 *    「哪些变化是我造成的」的因果归因边界与身份断点监控:
 *    a) 归因边界: 编排层把每个决策周期的「自身动作流」（模型切换/
 *       调参/进化部署事件序列）与「信号通道」（成功率/延迟/token 消耗
 *       遥测）喂给 detectAgency——自致通道的改进记入 improvementEvidence
 *       （策略升级的真功绩）, 非自致通道的波动不揽功（防把环境红利
 *       记成自我进步）; 已知共因（任务难度/时段负载）作为 confounders
 *       注入, 被吸收的相关从功绩里剔除;
 *    b) do(a) 注入: 冒险度旋钮的随机探索窗口（meta-controller 已有的
 *       试验步长天然是 do(a)）期间采集的遥测走 doVsObserve——观察归因
 *       与干预归因分账, 与 5.0 causal-kernel 的双流证据同款口径
 *       （5.0 管外部因果边, 100.0 管「自我作为原因」的边界）;
 *    c) 身份断点: policy-evolver 部署新策略版本时, 前后参数向量 +
 *       行为探针集（金丝雀流量的抽样子集）跑 identityContinuity——
 *       breakAlarm 联动金丝雀回滚（连续性崩塌 = 不是渐进学习而是
 *       身份突变, 按最高风险处置）; score 一并写入 MentalReport 的
 *       evolverEfficiency 视图;
 *    d) Sentinel 接线: 动作流 = 主动巡检/预热动作时间线, 信号 = 告警
 *       通道——contingencyScore 区分「我的巡检触发的告警」（自归因,
 *       可闭环调优）与「外部事件」（环境, 走异常处置链）。
 * 2. 缺省关闭旗标名: SelfModelConfig 新增
 *    `selfBoundary?: { enabled?: boolean }`（缺省 false, 与
 *    mechanismDesign / attentionEconomy 旗标同款——影子计算, 不改变
 *    主链路; 编排层桥接 collectors, 内核保持纯数学零 I/O）。
 * 3. 挂载后改变的决策点:
 *    - self-model 的 improvementEvidence 归因口径（自致过滤）;
 *    - policy-evolver 金丝雀的回滚判据增加身份断点信号;
 *    - 未启用时报告内容与本内核加入前逐位一致（零漂移）。
 */
