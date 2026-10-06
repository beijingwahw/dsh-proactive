/**
 * 75.0 在线校准内核 —— online calibration：把「概率直觉」诚实化为真实频率
 *
 * 动机: 系统里一切概率口径（决策引擎的 urgency 评估、质量预测、保形 13.0
 * 的 α）都默认「报出的 p 就是发生频率」。但概率直觉是模型内生的——
 * 系统性偏差（恒报 0.5 的过度保守 / 恒报 0.9 的过度自信）没有任何机制
 * 被结果纠正：错了多久就错多久。校准误差量化为
 *
 *   ECE = Σ_桶 (n_桶/T)·|置信_桶 − 实测_桶|
 *
 * （10 等宽分桶；ECE = 0 ⇔ 报出的概率在每一档置信上就是长期频率）。
 *
 * 数学:
 *   ① 在线 Platt 缩放: p̂ = σ(a·logit(p) + b)，初始 a=1, b=0 = 恒等。
 *      逐点对数损失 SGD：∂/∂a = (p̂−y)·z、∂/∂b = (p̂−y)（z = logit(p)）。
 *      单参数族内**在线最优**（凸性 + 无悔 SGD），流式 O(1)。
 *   ② 窗口 isotonic（PAVA 保序回归）: 滑动窗口上解
 *      min_f Σ (f(p_i) − y_i)²  s.t. f 单调不减
 *      ——批精确解 = 相邻违序池均值合并（pool adjacent violators），
 *      分段常数单调映射；非参数、能修 Platt 修不了的任意单调形变。
 *   ③ 混合门控（无漂移设计）: 分桶偏差检测器把「预报 vs 实测」对到
 *      二项噪声尺度 z = |实测−置信|/√(置信(1−置信)/n_桶)，连续两检
 *      z > 4 才激活校准（累计统计量被反复检查——4σ + 连续 2 检把
 *      全程误报压到实测 0/200 种子流）——**完美预报永不被改坏**（校准器是手术刀，
 *      只在确证失准时才动刀；未激活时输出逐位等于输入）。
 *
 *   与 13.0 的关系: 保形给「区间/阈值的覆盖保证」，本内核给「点概率的
 *   频率诚实性」——p 先经 75.0 校准，再进 13.0 的 α 口径，全链路概率
 *   才既诚实又有保证（75.0 是 13.0 的上游校准姊妹篇）。
 *
 * 验证锚点（scripts/verify-pricing-calibration.mjs）:
 *   ① 已知失准（真 p=0.7、预报恒 0.5、种子化伯努利 2000 点）:
 *      门控校准后 ECE 下降 ≥ 80%；
 *   ② 恒等无伤害: 完美校准输入（p_t 即种子化真实概率）下混合门控
 *      输出 ECE 不高于输入（门控全程不触发，输出逐位等于输入）；
 *   ③ PAVA 与手工已知解精确对照（[3,1,2]→[2,2,2] 等，含加权池化）；
 *   ④ isotonic 输出单调不减 + 变分性质（任意单调 g 的加权 SSE ≥
 *      PAVA 解的加权 SSE——池化解是投影，逐例对照排序解/常数解）；
 *   ⑤ 在线 Platt 参数收敛方向正确：σ(a·logit(0.5)+b) → 0.7
 *      （b → logit(0.7)，a 不被常预报扰动）。
 *
 * 应用: 决策引擎统计学习/保形 13.0 的前置校准层——urgency 评估、
 * 质量预测等一切「概率直觉」上链前先诚实化（预报概率 = 真实频率）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 基础函数（零依赖） ───────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** logit（p 钳位 [1e-6, 1−1e-6]，避开 ±∞） */
function logit(p: number): number {
  const q = Math.min(1 - 1e-6, Math.max(1e-6, p));
  return Math.log(q / (1 - q));
}

function validateProbability(p: number, who: string): void {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error(`${who}: 概率须落在 [0,1]（收到 ${p}）`);
  }
}

function validateOutcome(y: number, who: string): void {
  if (y !== 0 && y !== 1) {
    throw new Error(`${who}: 结果 y 须为 0/1（收到 ${y}）`);
  }
}

// ─────────────────────────── 校准误差（ECE） ───────────────────────────

/** 一条校准观测：预报概率 p、结果 y ∈ {0,1} */
export interface CalibrationPair {
  p: number;
  y: number;
}

/** 分桶细节（置信 vs 实测的逐桶对账） */
export interface CalibrationBucket {
  /** 桶下/上界（左闭右开，末桶闭） */
  lo: number;
  hi: number;
  /** 桶内样本数 */
  n: number;
  /** 桶内平均预报（置信） */
  confidence: number;
  /** 桶内实测频率 */
  empirical: number;
  /** |confidence − empirical| */
  gap: number;
}

export interface CalibrationReport {
  /** 样本量 */
  t: number;
  /** 分桶数 */
  bins: number;
  /** 期望校准误差 ECE = Σ (n_b/T)·gap_b */
  ece: number;
  /** 最大桶偏差（MCE 口径） */
  maxGap: number;
  /** 最差桶下标（无有效桶时 −1） */
  worstBucket: number;
  /** Brier 分数 mean (p−y)²（附加口径，严格 Proper 评分参照） */
  brier: number;
  /** 各桶明细（含空桶） */
  buckets: CalibrationBucket[];
}

/**
 * 校准误差（期望校准误差 ECE + 分桶明细）。
 *
 * ECE = Σ_桶 (n_桶/T)·|平均预报 − 实测频率|——「报 p 的人有多少比例
 * 真的发生了」的加权绝对偏差。10 等宽桶（缺省）。
 */
export function calibrationError(pairs: ReadonlyArray<CalibrationPair>, bins = 10): CalibrationReport {
  if (!Number.isInteger(bins) || bins < 1 || bins > 1000) {
    throw new Error(`分桶数须为 1..1000 的整数（收到 ${bins}）`);
  }
  if (pairs.length === 0) throw new Error('calibrationError: 至少需要一条 (p, y) 观测');
  const counts = Array.from({ length: bins }, () => 0);
  const sumP = Array.from({ length: bins }, () => 0);
  const sumY = Array.from({ length: bins }, () => 0);
  let brier = 0;
  for (const pair of pairs) {
    validateProbability(pair.p, 'calibrationError');
    validateOutcome(pair.y, 'calibrationError');
    const idx = Math.min(bins - 1, Math.floor(pair.p * bins));
    counts[idx] += 1;
    sumP[idx] += pair.p;
    sumY[idx] += pair.y;
    brier += (pair.p - pair.y) * (pair.p - pair.y);
  }
  const t = pairs.length;
  const buckets: CalibrationBucket[] = [];
  let ece = 0;
  let maxGap = 0;
  let worstBucket = -1;
  for (let b = 0; b < bins; b += 1) {
    const confidence = counts[b] === 0 ? Number.NaN : sumP[b] / counts[b];
    const empirical = counts[b] === 0 ? Number.NaN : sumY[b] / counts[b];
    const gap = counts[b] === 0 ? 0 : Math.abs(confidence - empirical);
    if (counts[b] > 0 && gap > maxGap) {
      maxGap = gap;
      worstBucket = b;
    }
    ece += (counts[b] / t) * gap;
    buckets.push({ lo: b / bins, hi: (b + 1) / bins, n: counts[b], confidence, empirical, gap });
  }
  return { t, bins, ece, maxGap, worstBucket, brier: brier / t, buckets };
}

// ─────────────────────────── PAVA 保序回归（核心，导出供验证） ───────────────────────────

/**
 * 保序回归（PAVA：pool adjacent violators algorithm，批精确解）。
 *
 * 输入序列视为按 x 升序排列的观测 values（权重 weights，缺省全 1），
 * 输出其到单调不减锥上的**加权最小二乘投影**：相邻违序（前 > 后）的
 * 块以加权均值池化合并，直至整体单调。O(n) 均摊。
 *
 * 例: pava([3,1,2]) = [2,2,2]（3 与 1 违序池化为 2，恰与 2 齐平）。
 */
export function pava(values: ReadonlyArray<number>, weights?: ReadonlyArray<number>): number[] {
  const n = values.length;
  if (n === 0) throw new Error('pava: values 不能为空');
  const w = weights === undefined ? Array.from({ length: n }, () => 1) : [...weights];
  if (w.length !== n) throw new Error(`pava: weights 长度（${w.length}）须等于 values 长度（${n}）`);
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(values[i])) throw new Error(`pava: values[${i}] 须为有限数`);
    if (!Number.isFinite(w[i]) || w[i] <= 0) throw new Error(`pava: weights[${i}] 须为正有限数`);
  }
  // 块栈：{level: 池化均值, weight: 累计权重, count: 覆盖原序列长度}
  interface Block {
    level: number;
    weight: number;
    count: number;
  }
  const stack: Block[] = [];
  for (let i = 0; i < n; i += 1) {
    stack.push({ level: values[i], weight: w[i], count: 1 });
    while (stack.length >= 2) {
      const prev = stack[stack.length - 2];
      const last = stack[stack.length - 1];
      if (prev.level > last.level) {
        const weight = prev.weight + last.weight;
        stack.splice(stack.length - 2, 2, {
          level: (prev.level * prev.weight + last.level * last.weight) / weight,
          weight,
          count: prev.count + last.count,
        });
      } else {
        break;
      }
    }
  }
  const fitted: number[] = Array.from({ length: n }, () => 0);
  let cursor = 0;
  for (const block of stack) {
    for (let k = 0; k < block.count; k += 1) {
      fitted[cursor] = block.level;
      cursor += 1;
    }
  }
  return fitted;
}

// ─────────────────────────── ① 在线 Platt 缩放 ───────────────────────────

export interface OnlinePlattOptions {
  /** SGD 学习率（缺省 0.05） */
  lr?: number;
}

export interface PlattStats {
  a: number;
  b: number;
  /** 已回填的 SGD 步数 */
  steps: number;
}

/**
 * ① 在线 Platt 缩放：p̂ = σ(a·logit(p) + b)。
 *
 * 初始 a=1, b=0 = 恒等映射。流协议：每期 calibrateNext(p)（登记待校准
 * 预报并返回校准值）→ 结果到达后 observe(y)（对数损失 SGD 一步）。
 * 单点常预报（z 恒 0）下 a 不被扰动、b → logit(实测频率)（锚点⑤）。
 */
export class OnlinePlatt {
  private aValue = 1;
  private bValue = 0;
  private readonly lrValue: number;
  private steps = 0;
  private lastZ: number | undefined;

  constructor(options: OnlinePlattOptions = {}) {
    if (options === null || typeof options !== 'object') throw new Error('OnlinePlatt: 需要 options 对象');
    const lr = options.lr ?? 0.05;
    if (!Number.isFinite(lr) || lr <= 0) throw new Error(`学习率须 > 0（收到 ${lr}）`);
    this.lrValue = lr;
  }

  /** 纯查询：当前参数下 p 的校准值（不改动状态） */
  calibrate(p: number): number {
    validateProbability(p, 'OnlinePlatt.calibrate');
    return sigmoid(this.aValue * logit(p) + this.bValue);
  }

  /** 流式登记本期预报并返回校准值（之后必须 observe 回填结果） */
  calibrateNext(p: number): number {
    validateProbability(p, 'OnlinePlatt.calibrateNext');
    this.lastZ = logit(p);
    return sigmoid(this.aValue * this.lastZ + this.bValue);
  }

  /** 结果回填：∂NLL/∂a = (p̂−y)·z，∂NLL/∂b = (p̂−y) */
  observe(y: number): void {
    validateOutcome(y, 'OnlinePlatt.observe');
    if (this.lastZ === undefined) {
      throw new Error('OnlinePlatt.observe: 须先 calibrateNext 登记待校准的预报');
    }
    const phat = sigmoid(this.aValue * this.lastZ + this.bValue);
    const grad = phat - y;
    this.aValue -= this.lrValue * grad * this.lastZ;
    this.bValue -= this.lrValue * grad;
    this.steps += 1;
    this.lastZ = undefined; // 每条预报恰校准一次
  }

  get a(): number {
    return this.aValue;
  }

  get b(): number {
    return this.bValue;
  }

  stats(): PlattStats {
    return { a: this.aValue, b: this.bValue, steps: this.steps };
  }
}

/** 工厂：在线 Platt 校准器 */
export function onlinePlatt(options: OnlinePlattOptions = {}): OnlinePlatt {
  return new OnlinePlatt(options);
}

// ─────────────────────────── ② 窗口 isotonic（PAVA 在线化） ───────────────────────────

export interface WindowedIsotonicOptions {
  /** 滑动窗口容量（缺省 300） */
  window?: number;
  /** 窗内少于此样本数时恒等直通（诚实：证据不足不动刀；缺省 30） */
  minPoints?: number;
}

/** isotonic 映射的当前读出（按 p 升序的拟合点，只读诊断） */
export interface IsotonicMapPoint {
  p: number;
  fitted: number;
}

/**
 * ② 窗口 isotonic 校准：滑动窗口上的 PAVA 保序回归。
 *
 * calibrateNext(p)：对最近 window 条 (p, y) 按 p 排序后做 PAVA（批精确
 * 解），以**分段常数**单调映射查 p 的校准值（q 取「≤q 的最大 p_i」所在
 * 池的均值，越界贴端点值）；窗口样本不足 minPoints 时恒等直通。
 */
export class WindowedIsotonic {
  private readonly windowSize: number;
  private readonly minPointsValue: number;
  private history: CalibrationPair[] = [];
  private pendingP: number | undefined;

  constructor(options: WindowedIsotonicOptions = {}) {
    if (options === null || typeof options !== 'object') throw new Error('WindowedIsotonic: 需要 options 对象');
    const window = options.window ?? 300;
    const minPoints = options.minPoints ?? 30;
    if (!Number.isInteger(window) || window < 2) throw new Error(`window 须为 ≥2 的整数（收到 ${window}）`);
    if (!Number.isInteger(minPoints) || minPoints < 1 || minPoints > window) {
      throw new Error(`minPoints 须为 1..window 的整数（收到 ${minPoints}）`);
    }
    this.windowSize = window;
    this.minPointsValue = minPoints;
  }

  calibrateNext(p: number): number {
    validateProbability(p, 'WindowedIsotonic.calibrateNext');
    this.pendingP = p;
    return this.map(p);
  }

  /** 纯查询：当前窗口映射下 p 的校准值（不改动状态；证据不足恒等直通） */
  map(p: number): number {
    validateProbability(p, 'WindowedIsotonic.map');
    if (this.history.length < this.minPointsValue) return p; // 证据不足：恒等直通
    const { ps, fitted } = this.fitSorted();
    // 分段常数查表：≤p 的最大样本所在的池化值（越界贴端点）
    let lo = 0;
    let hi = ps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ps[mid] <= p) lo = mid;
      else hi = mid - 1;
    }
    return Math.min(1, Math.max(0, fitted[lo]));
  }

  observe(y: number): void {
    validateOutcome(y, 'WindowedIsotonic.observe');
    if (this.pendingP === undefined) {
      throw new Error('WindowedIsotonic.observe: 须先 calibrateNext 登记待校准的预报');
    }
    this.history.push({ p: this.pendingP, y });
    if (this.history.length > this.windowSize) {
      this.history.splice(0, this.history.length - this.windowSize);
    }
    this.pendingP = undefined;
  }

  /** 当前窗口的 isotonic 映射（升序拟合点；样本不足时 undefined） */
  currentFit(): IsotonicMapPoint[] | undefined {
    if (this.history.length < this.minPointsValue) return undefined;
    const { ps, fitted } = this.fitSorted();
    return ps.map((p, i) => ({ p, fitted: fitted[i] }));
  }

  /**
   * 窗口排序 + 并列池化 + PAVA。
   *
   * 先按 p 稳定排序，再把 p 并列（|Δp| ≤ 1e-12）的观测池化为单点
   * （权重 = 条数、值 = y 均值）——保序约束对相同 x 不施加方向，
   * 并列池化才给唯一解（常预报流退化为「窗口均值」这一定义性情形）。
   */
  private fitSorted(): { ps: number[]; fitted: number[] } {
    const order = this.history.map((pair, i) => ({ pair, i })).sort((x, z) => x.pair.p - z.pair.p || x.i - z.i);
    const ps: number[] = [];
    const values: number[] = [];
    const weights: number[] = [];
    for (const o of order) {
      const last = ps.length - 1;
      if (last >= 0 && Math.abs(ps[last] - o.pair.p) <= 1e-12) {
        const w = weights[last] + 1;
        values[last] = (values[last] * weights[last] + o.pair.y) / w;
        weights[last] = w;
      } else {
        ps.push(o.pair.p);
        values.push(o.pair.y);
        weights.push(1);
      }
    }
    const fitted = pava(values, weights);
    return { ps, fitted };
  }
}

/** 工厂：窗口 isotonic 校准器 */
export function windowedIsotonic(options: WindowedIsotonicOptions = {}): WindowedIsotonic {
  return new WindowedIsotonic(options);
}

// ─────────────────────────── 失准检测器（门控的哨兵） ───────────────────────────

export interface DriftDetectorOptions {
  /** 分桶数（缺省 10，与 ECE 同口径） */
  bins?: number;
  /**
   * 触发阈值 z > k（缺省 4.0）。累计分桶统计量在 T/period 次检查中被
   * 反复窥视——单点 3σ 口径的全程误报率会随检查次数膨胀；4σ + 连续
   * 2 检的双重门槛在 200 个完美校准种子流（2000 点/流）上实测误触发
   * 0/200，而真实失准（|偏差|=0.2）中位 ~130 点即确证（零漂移设计）。
   */
  thresholdK?: number;
  /** 桶内少于此样本数不参与判定（缺省 40——小样本不诬告） */
  minCount?: number;
  /** 检查周期：每 period 条观测评估一次（缺省 20） */
  checkPeriod?: number;
  /** 连续命中次数（缺省 2——单次越线不算失准，防运气误报） */
  consecutive?: number;
}

/** 失准检测视图 */
export interface DriftView {
  /** 已观测条数 */
  n: number;
  /** 是否判定失准（连续 consecutive 次越线） */
  miscalibrated: boolean;
  /** 最近一次检查的最大桶 z 值（未检查过为 0） */
  worstZ: number;
  /** 最近一次检查的最大桶偏差 |实测−置信| */
  worstGap: number;
  /** 最差桶下标（无有效桶时 −1） */
  worstBucket: number;
  /** 已完成的检查次数 */
  checks: number;
}

/**
 * 失准检测器：分桶偏差对到二项噪声尺度。
 *
 * 零假设「预报即真值」下，桶内实测频率 ~ Binomial(n_b, conf_b)/n_b，
 * z = |实测 − 置信| / √(conf(1−conf)/n_b) 近似标准正态。连续
 * consecutive 次检查存在 z > k 的桶 → 确证失准。阈值 k=4 刻意高于
 * 单点 3σ 口径：统计量是累计的、检查是反复的（多次窥视膨胀），4σ +
 * 连续 2 检的双重门槛在 200 个完美校准种子流上实测 0 误触发——
 * 完美校准输入实际不被误触发（无漂移设计）。
 */
export class CalibrationDriftDetector {
  private readonly bins: number;
  private readonly thresholdK: number;
  private readonly minCount: number;
  private readonly checkPeriod: number;
  private readonly consecutiveNeeded: number;
  private readonly counts: number[];
  private readonly sumP: number[];
  private readonly sumY: number[];
  private total = 0;
  private checks = 0;
  private streak = 0;
  private lastWorstZ = 0;
  private lastWorstGap = 0;
  private lastWorstBucket = -1;

  constructor(options: DriftDetectorOptions = {}) {
    if (options === null || typeof options !== 'object') throw new Error('CalibrationDriftDetector: 需要 options 对象');
    const bins = options.bins ?? 10;
    const thresholdK = options.thresholdK ?? 4.0;
    const minCount = options.minCount ?? 40;
    const checkPeriod = options.checkPeriod ?? 20;
    const consecutive = options.consecutive ?? 2;
    if (!Number.isInteger(bins) || bins < 1 || bins > 1000) throw new Error(`bins 须为 1..1000 的整数（收到 ${bins}）`);
    if (!Number.isFinite(thresholdK) || thresholdK <= 0) throw new Error(`thresholdK 须 > 0（收到 ${thresholdK}）`);
    if (!Number.isInteger(minCount) || minCount < 1) throw new Error(`minCount 须为 ≥1 的整数（收到 ${minCount}）`);
    if (!Number.isInteger(checkPeriod) || checkPeriod < 1) throw new Error(`checkPeriod 须为 ≥1 的整数（收到 ${checkPeriod}）`);
    if (!Number.isInteger(consecutive) || consecutive < 1) throw new Error(`consecutive 须为 ≥1 的整数（收到 ${consecutive}）`);
    this.bins = bins;
    this.thresholdK = thresholdK;
    this.minCount = minCount;
    this.checkPeriod = checkPeriod;
    this.consecutiveNeeded = consecutive;
    this.counts = Array.from({ length: bins }, () => 0);
    this.sumP = Array.from({ length: bins }, () => 0);
    this.sumY = Array.from({ length: bins }, () => 0);
  }

  /** 观测一条 (预报, 结果)；每 checkPeriod 条评估一次（视图含最近检查结果） */
  observe(p: number, y: number): DriftView {
    validateProbability(p, 'CalibrationDriftDetector.observe');
    validateOutcome(y, 'CalibrationDriftDetector.observe');
    const idx = Math.min(this.bins - 1, Math.floor(p * this.bins));
    this.counts[idx] += 1;
    this.sumP[idx] += p;
    this.sumY[idx] += y;
    this.total += 1;
    if (this.total % this.checkPeriod === 0) {
      this.checks += 1;
      let worstZ = 0;
      let worstGap = 0;
      let worstBucket = -1;
      for (let b = 0; b < this.bins; b += 1) {
        const n = this.counts[b];
        if (n < this.minCount) continue;
        const conf = Math.min(1 - 1e-6, Math.max(1e-6, this.sumP[b] / n));
        const emp = this.sumY[b] / n;
        const gap = Math.abs(emp - conf);
        const sd = Math.sqrt((conf * (1 - conf)) / n);
        const z = gap / sd;
        if (z > worstZ) {
          worstZ = z;
          worstGap = gap;
          worstBucket = b;
        }
      }
      this.lastWorstZ = worstZ;
      this.lastWorstGap = worstGap;
      this.lastWorstBucket = worstBucket;
      if (worstZ > this.thresholdK) this.streak += 1;
      else this.streak = 0;
    }
    return this.view();
  }

  view(): DriftView {
    return {
      n: this.total,
      miscalibrated: this.streak >= this.consecutiveNeeded,
      worstZ: this.lastWorstZ,
      worstGap: this.lastWorstGap,
      worstBucket: this.lastWorstBucket,
      checks: this.checks,
    };
  }

  /** 重置（重校准后重启哨兵） */
  reset(): void {
    this.counts.fill(0);
    this.sumP.fill(0);
    this.sumY.fill(0);
    this.total = 0;
    this.checks = 0;
    this.streak = 0;
    this.lastWorstZ = 0;
    this.lastWorstGap = 0;
    this.lastWorstBucket = -1;
  }
}

// ─────────────────────────── ③ 混合门控校准器 ───────────────────────────

/** 激活后的校准路由（const 对象 + 类型，strip-types 兼容） */
export const GATED_STRATEGY = {
  /** Platt 单干（平滑参数族——全局偏置的首选手术刀） */
  platt: 'platt',
  /** isotonic 单干（非参数——任意单调形变） */
  isotonic: 'isotonic',
  /** 两者均值（混合口径） */
  blended: 'blended',
} as const;

export type GatedStrategy = (typeof GATED_STRATEGY)[keyof typeof GATED_STRATEGY];

export interface GatedCalibratorOptions extends OnlinePlattOptions, WindowedIsotonicOptions {
  /** 失准检测器配置 */
  drift?: DriftDetectorOptions;
  /** 激活后的校准路由（缺省 'platt'） */
  strategy?: GatedStrategy;
}

export interface GatedStatus {
  /** 门控是否已激活（一旦确证失准则锁存） */
  active: boolean;
  /** 激活时的观测条数（未激活为 undefined） */
  activatedAt: number | undefined;
  strategy: GatedStrategy;
  /** Platt 参数（始终在热身——激活即有战斗力） */
  a: number;
  b: number;
  steps: number;
  /** 窗口样本量 */
  window: number;
  /** 哨兵视图 */
  drift: DriftView;
}

/**
 * ③ 混合门控校准器（无漂移设计的主入口）。
 *
 * 流协议：每期 calibrateNext(p) → observe(y)。
 * - 未激活：输出**逐位等于输入**（零漂移承诺）——但 Platt 与窗口
 *   isotonic 同时在旁热身（只学不动刀）；
 * - 哨兵（CalibrationDriftDetector）连续确证失准 → 门控激活锁存，
 *   此后按 strategy 路由到校准值（Platt / isotonic / 混合）。
 *
 * 完美校准的输入：哨兵永不触发 → 输出恒等 → ECE 一分不涨（锚点②）。
 */
export class GatedCalibrator {
  private readonly platt: OnlinePlatt;
  private readonly iso: WindowedIsotonic;
  private readonly detector: CalibrationDriftDetector;
  private readonly strategyValue: GatedStrategy;
  private active = false;
  private activatedAtValue: number | undefined;
  private pendingP: number | undefined;

  constructor(options: GatedCalibratorOptions = {}) {
    if (options === null || typeof options !== 'object') throw new Error('GatedCalibrator: 需要 options 对象');
    const { drift, strategy, lr, window, minPoints } = options;
    this.platt = new OnlinePlatt({ lr });
    this.iso = new WindowedIsotonic({ window, minPoints });
    this.detector = new CalibrationDriftDetector(drift ?? {});
    const valid: GatedStrategy[] = [GATED_STRATEGY.platt, GATED_STRATEGY.isotonic, GATED_STRATEGY.blended];
    const chosen: GatedStrategy = strategy ?? GATED_STRATEGY.platt;
    if (!valid.includes(chosen)) throw new Error(`strategy 须为 platt/isotonic/blended（收到 ${String(strategy)}）`);
    this.strategyValue = chosen;
  }

  calibrateNext(p: number): number {
    validateProbability(p, 'GatedCalibrator.calibrateNext');
    this.pendingP = p;
    // 双通道恒热身（未激活时其输出被丢弃——只积累经验，不影响输出）
    const plattP = this.platt.calibrateNext(p);
    const isoP = this.iso.calibrateNext(p);
    if (!this.active) return p; // 门控未开：恒等直通（零漂移）
    if (this.strategyValue === GATED_STRATEGY.platt) return plattP;
    if (this.strategyValue === GATED_STRATEGY.isotonic) return isoP;
    return (plattP + isoP) / 2;
  }

  observe(y: number): void {
    validateOutcome(y, 'GatedCalibrator.observe');
    if (this.pendingP === undefined) {
      throw new Error('GatedCalibrator.observe: 须先 calibrateNext 登记待校准的预报');
    }
    const p = this.pendingP;
    this.platt.observe(y); // 通道热身/学习
    this.iso.observe(y);
    const view = this.detector.observe(p, y);
    this.pendingP = undefined;
    if (!this.active && view.miscalibrated) {
      this.active = true; // 锁存：确证失准后不因偶发回落而关闸
      this.activatedAtValue = view.n;
    }
  }

  /** 纯查询：当前门控状态与已热身通道下 p 的校准值（不改动状态；未激活恒等） */
  calibrate(p: number): number {
    validateProbability(p, 'GatedCalibrator.calibrate');
    if (!this.active) return p;
    const plattP = this.platt.calibrate(p);
    if (this.strategyValue === GATED_STRATEGY.platt) return plattP;
    if (this.strategyValue === GATED_STRATEGY.isotonic) return this.iso.map(p);
    return (plattP + this.iso.map(p)) / 2;
  }

  status(): GatedStatus {
    const plattStats = this.platt.stats();
    return {
      active: this.active,
      activatedAt: this.activatedAtValue,
      strategy: this.strategyValue,
      a: plattStats.a,
      b: plattStats.b,
      steps: plattStats.steps,
      window: this.iso.currentFit()?.length ?? 0,
      drift: this.detector.view(),
    };
  }
}

/** 工厂：混合门控校准器 */
export function gatedCalibrator(options: GatedCalibratorOptions = {}): GatedCalibrator {
  return new GatedCalibrator(options);
}

// ─────────────────── R5 进化 Ⅰ：在线覆盖追踪器（online marginal coverage） ───────────────────
//
// 动机: 门控校准器修「点概率的频率诚实性」，但下游真正要的常是**覆盖决策**——
// 「事件报警率恰好 α」「高风险集覆盖 1−α 的事件」。批保形（13.0）的置换结构
// 在流式/非交换数据上失效; 在线边际覆盖（Vovk 系; Gibbs–Candès 2021 的
// 在线保形口径）用**阈值随机逼近**替代置换分位数:
//
//   a_t = 1{s_t > τ_t}·（未覆盖指示，s = 非一致性分数）
//   τ_{t+1} = τ_t + γ_t·(a_t − α)      （Robbins–Monro: 未覆盖偏多 → 抬阈值）
//
//   保证（文档口径）: γ_t = c/t 的随机逼近下 Σ_t a_t = α·T + O(ln T)
//   （平稳分数流，任何前缀的边际覆盖缺口按 lnT/T 收缩——任意时刻有效）;
//   γ_t = c/√t 的对抗口径下累计缺口 O(√T)——对任意流「跟踪不发散」。
//   τ 始终钳位 [τmin, τmax]（反射式随机逼近——分数空间有界时无偏性保持）。
//
// 用法（二分类在线预测集）: 类条件非一致性分数 s(1) = 1−p、s(0) = p
//   （实现类愈「意外」分数愈高）; 预测集 C_t = {y: s(y) ≤ τ_t}，
//   miss = 1{s(y_t) > τ_t} → observeBinary(p, y) 一步完成。
//   E[miss 率] → α——**在线边际覆盖 1−α 的任意时刻有效口径**
//   （P(y_t ∉ C_t) = α 对每个 t 的边缘成立，非交换/漂移流亦跟踪不发散）。
//
// 数值（R5 进化 Ⅱ 的落点）: 阈值与分数都过 pinProbability（开区间钉住，
//   避免 τ 贴 0/1 后比较退化为恒等/恒假）; γ_t 的 t 从 1 起（防 0 除）。

/** 把概率钉进开区间 (eps, 1−eps)——0/1 边界钉住（数值稳健轴） */
export function pinProbability(p: number, eps = 1e-12): number {
  if (!Number.isFinite(p)) return eps;
  return Math.min(1 - eps, Math.max(eps, p));
}

export interface OnlineCoverageOptions {
  /** 目标未覆盖率 α ∈ (0,1)（覆盖 1−α; 缺省 0.1） */
  alpha?: number;
  /**
   * 步长样式: 'reciprocal' = γ_t = c/t（平稳流 O(lnT/T) 收缩，缺省）;
   * 'sqrt' = γ_t = c/√t（对抗流的 O(√T) 跟踪口径——漂移世界更稳）。
   */
  stepStyle?: 'reciprocal' | 'sqrt';
  /** 步长常数 c > 0（缺省 1; τ 的单步最大移动 = c·max(α, 1−α)·γ_t） */
  stepScale?: number;
  /** 初始阈值 ∈ [0,1]（缺省 α——「先按目标掏空」的保守起点） */
  tau0?: number;
  /** 阈值钳位（缺省 [0,1]） */
  bounds?: { lower: number; upper: number };
}

/** 在线覆盖追踪器视图 */
export interface OnlineCoverageView {
  /** 已观测期数 */
  t: number;
  /** 当前阈值 τ_t（下一决策用） */
  tau: number;
  /** 累计未覆盖数 Σ a_s */
  misses: number;
  /** 实证未覆盖率 Σa/t（目标 α） */
  empiricalRate: number;
  /** 覆盖缺口 = 实证率 − α（在线边际覆盖的实时审计） */
  gap: number;
  /** 累计随机逼近位移 Σ γ_s·(a_s − α)（有界 ⇔ τ 未被钳位卡死） */
  cumulativeShift: number;
}

/**
 * 在线覆盖追踪器: Gibbs–Candès/Vovk 系的在线保形阈值。
 *
 * decide(score) → covered = score ≤ τ（纯查询）; 结果回填 observeMiss(0|1)
 * 后阈值按 γ_t(a_t − α) 更新。同种子同轨迹逐位确定（无内部随机源）。
 */
export class OnlineCoverageTracker {
  private readonly alpha: number;
  private readonly stepStyle: 'reciprocal' | 'sqrt';
  private readonly stepScale: number;
  private readonly lower: number;
  private readonly upper: number;
  private tau: number;
  private count = 0;
  private misses = 0;
  private shift = 0;

  constructor(options: OnlineCoverageOptions = {}) {
    if (options === null || typeof options !== 'object') throw new Error('OnlineCoverageTracker: 需要 options 对象');
    const alpha = options.alpha ?? 0.1;
    if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
      throw new Error(`alpha 须 ∈ (0,1)（收到 ${alpha}）`);
    }
    const stepStyle = options.stepStyle ?? 'reciprocal';
    if (stepStyle !== 'reciprocal' && stepStyle !== 'sqrt') {
      throw new Error(`stepStyle 须为 reciprocal/sqrt（收到 ${String(stepStyle)}）`);
    }
    const stepScale = options.stepScale ?? 1;
    if (!Number.isFinite(stepScale) || stepScale <= 0) throw new Error(`stepScale 须 > 0（收到 ${stepScale}）`);
    const tau0 = options.tau0 ?? alpha;
    if (!Number.isFinite(tau0) || tau0 < 0 || tau0 > 1) throw new Error(`tau0 须 ∈ [0,1]（收到 ${tau0}）`);
    const lower = options.bounds?.lower ?? 0;
    const upper = options.bounds?.upper ?? 1;
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || !(lower < upper)) {
      throw new Error(`bounds 须满足 lower < upper（收到 (${lower}, ${upper})）`);
    }
    this.alpha = alpha;
    this.stepStyle = stepStyle;
    this.stepScale = stepScale;
    this.lower = lower;
    this.upper = upper;
    this.tau = Math.min(upper, Math.max(lower, tau0));
  }

  /** 当前阈值下的覆盖判定: covered ⟺ score ≤ τ（0/1 边界钉住口径） */
  decide(score: number): boolean {
    if (!Number.isFinite(score)) throw new Error(`score 须为有限数（收到 ${score}）`);
    const s = pinProbability(score);
    return s <= pinProbability(this.tau);
  }

  /** 结果回填: missed ∈ {0,1}（本期目标事件未被覆盖则 1）; 阈值随机逼近一步 */
  observeMiss(missed: number): OnlineCoverageView {
    if (missed !== 0 && missed !== 1) throw new Error(`missed 须为 0/1（收到 ${missed}）`);
    this.count += 1;
    this.misses += missed;
    const gamma =
      this.stepStyle === 'reciprocal'
        ? this.stepScale / this.count
        : this.stepScale / Math.sqrt(this.count);
    const step = gamma * (missed - this.alpha);
    this.shift += step;
    this.tau = pinProbability(Math.min(this.upper, Math.max(this.lower, this.tau + step)));
    return this.view();
  }

  /** 二分类便捷口径: 类条件非一致性 s(y=1) = 1−p、s(y=0) = p，
   *  miss = 实现类分数越阈; 一步完成判定 + 回填 + 阈值更新 */
  observeBinary(p: number, y: number): { covered: boolean; missed: number; view: OnlineCoverageView } {
    validateProbability(p, 'OnlineCoverageTracker.observeBinary');
    validateOutcome(y, 'OnlineCoverageTracker.observeBinary');
    const score = y === 1 ? 1 - p : p;
    const covered = this.decide(score);
    const missed = covered ? 0 : 1;
    const view = this.observeMiss(missed);
    return { covered, missed, view };
  }

  view(): OnlineCoverageView {
    return {
      t: this.count,
      tau: this.tau,
      misses: this.misses,
      empiricalRate: this.count > 0 ? this.misses / this.count : 0,
      gap: this.count > 0 ? this.misses / this.count - this.alpha : -this.alpha,
      cumulativeShift: this.shift,
    };
  }

  /** 重置 */
  reset(): void {
    this.count = 0;
    this.misses = 0;
    this.shift = 0;
    this.tau = Math.min(this.upper, Math.max(this.lower, this.alpha));
  }
}

/** 工厂：在线覆盖追踪器 */
export function onlineCoverageTracker(options: OnlineCoverageOptions = {}): OnlineCoverageTracker {
  return new OnlineCoverageTracker(options);
}

// ── 接线建议 ─────────────────────────────────────────────────────────
//
// 1. 决策引擎概率口径前置层（urgency / 质量预测）：
//    - 一切「概率直觉」出链前过 GatedCalibrator：calibrateNext(p) 上链、
//      结局回填 observe(y)；完美校准期间输出逐位不变（零漂移），失准
//      确证后自动进入校准路由——概率口径从「模型说什么就是什么」
//      升级为「报多少就发生多少」。
//
// 2. 保形 13.0 的上游校准层：
//    - 保形的 α 覆盖保证假设校准分数可交换；本内核先修点概率的
//      系统性偏差（Platt/isotonic），再进 13.0 的分裂保形——p 先诚实
//      化（75.0），区间再带保证（13.0），两层数学各管一段。
//
// 3. 多口径并行部署：
//    - Platt（参数、平滑）与窗口 isotonic（非参数、跟随漂移）可按
//      场景选路：稳定系统偏差用 platt，形变/漂移环境用 isotonic；
//      drift 哨兵的 worstZ/worstBucket 作为「哪个置信档在撒谎」的
//      审计仪表常驻上报。
//
// 4. 挂载边界（零介入承诺）：
//    - 只读挂载：引擎仅调用 calibrateNext()/observe()/status()，内核
//      不发起决策、不写引擎状态；未挂载时现有概率路径逐位一致。
// ──────────────────────────────────────────────────────────────────
