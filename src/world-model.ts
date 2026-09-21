/**
 * world-model.ts — 世界模型（自主智能"预见"支柱）
 *
 * 职责：让系统对"外部世界如何运转"建立内部模型，从而具备预见能力——
 * 不是被动等待信号到来，而是提前预判信号到达、负载趋势与类型关联，
 * 为决策引擎、心跳循环与元认知提供前瞻性依据。
 *
 * 能力矩阵：
 * 1. 信号到达规律学习：按类型维护到达时间序列（滑动窗口），
 *    计算到达率、到达间隔分布、时段热度（小时直方图）
 * 2. 到达预测：基于历史到达率 + 时段热度 + 突发趋势，
 *    预测未来窗口内各类型信号的期望到达数（含置信区间）
 * 3. 类型关联矩阵：统计类型对的共现频率（时间邻近窗口内），
 *    识别"A 类型信号常伴随 B 类型信号"的规律，供级联与预取决策
 * 4. 预测校准：记录每次预测与实际到达的偏差，
 *    计算校准误差（MAE），误差过大时降低预测置信度并提示重学
 * 5. 趋势检测：对到达率做线性回归，识别上升/下降/平稳趋势，
 *    上升趋势触发负载预警洞察（交给元认知/目标引擎）
 *
 * 设计要点：
 * - 全部为纯统计学习，无需 LLM，开销极低，可在每次信号到达时增量更新
 * - 时间序列窗口有界（每类型最多保留 N 个到达时间戳），内存可控
 */
import { GpSeriesCalibrator, type ConstructorOptionsGpSeries } from './core/gaussian-process.js';
import { seasonalFactor } from './core/spectral-periodicity.js';

/** 单类型信号的到达统计 */
export interface ArrivalStats {
  type: string;
  /** 到达时间戳（滑动窗口，最新在尾部） */
  timestamps: number[];
  /** 小时直方图（0~23 时段的到达计数） */
  hourHistogram: number[];
  /** 总到达数 */
  totalCount: number;
  /** 首次观测时间 */
  firstSeenAt: number;
  /** 最近观测时间 */
  lastSeenAt: number;
}

/** 到达预测结果 */
export interface ArrivalPrediction {
  type: string;
  /** 预测窗口内期望到达数 */
  expectedCount: number;
  /** 置信区间下界 */
  lowerBound: number;
  /** 置信区间上界 */
  upperBound: number;
  /** 预测置信度 0~1（由校准误差驱动） */
  confidence: number;
  /** 趋势方向 */
  trend: 'rising' | 'falling' | 'stable';
  /**
   * 13.0：保形区间（分布无关精确覆盖保证，attachConformalCalibrator 后输出）。
   * 挂载后 lowerBound/upperBound 即保形口径（P(实际 ∈ [lower, upper]) ≥ 1−α，
   * 精确有限样本保证，零分布假设）；finite=false 表示校准不足——
   * 区间诚实发散（+∞），而非伪装确定。
   */
  conformal?: { lower: number; upper: number; finite: boolean; qhat: number; calibrationN: number; alpha: number };
  /**
   * 26.0：GP 校准修正（attachGpCalibrator 后输出）。factor 为乘性修正
   * （从校准史的 actual/predicted 比值序列 GP 回归而来，含不确定度）；
   * expectedCount 已乘 factor，lowerBound/upperBound 已按 std 拓宽。
   */
  gp?: { factor: number; std: number; points: number };
}

/** 预测校准记录 */
export interface CalibrationRecord {
  type: string;
  predicted: number;
  actual: number;
  error: number;
  timestamp: number;
}

/** 类型关联（共现） */
export interface TypeCorrelation {
  typeA: string;
  typeB: string;
  /** 共现次数 */
  coOccurrences: number;
  /** 关联强度 0~1（共现数 / min(各自总数)） */
  strength: number;
}

/** 世界模型配置 */
export interface WorldModelConfig {
  /** 每类型保留的到达时间戳上限 */
  maxTimestampsPerType: number;
  /** 关联共现判定窗口（毫秒） */
  coOccurrenceWindowMs: number;
  /** 趋势检测最少样本数 */
  minSamplesForTrend: number;
  /** 上升趋势判定斜率阈值（每分钟到达数增量） */
  risingSlopeThreshold: number;
  /** 校准误差超过该值视为预测失准 */
  calibrationErrorThreshold: number;
}

/** 默认配置 */
export const DEFAULT_WORLD_MODEL_CONFIG: WorldModelConfig = {
  maxTimestampsPerType: 500,
  coOccurrenceWindowMs: 60_000,
  minSamplesForTrend: 6,
  risingSlopeThreshold: 0.05,
  calibrationErrorThreshold: 2,
};

/** 世界模型摘要（运维可观测） */
export interface WorldModelSummary {
  trackedTypes: number;
  totalArrivals: number;
  types: Array<{ type: string; totalCount: number; lastSeenAt: number; recentRatePerMin: number }>;
  correlations: TypeCorrelation[];
  trends: Array<{ type: string; trend: 'rising' | 'falling' | 'stable'; slopePerMin: number }>;
  calibrationError: number;
  /** 5.0：混杂指纹（观测共现 ≠ 因果的证伪现场） */
  confoundedPairs?: Array<{ typeA: string; typeB: string; observationalStrength: number; causalEffect: number; divergence: number }>;
  /** 13.0：保形校准状态（attachConformalCalibrator 后输出） */
  conformal?: import('./core/conformal.js').ConformalStatus;
}

/**
 * 世界模型
 *
 * 被 index.ts 持有：哨兵每次 ingest 后调用 observeArrival() 增量学习；
 * 心跳循环定期调用 predictArrivals() 获取前瞻预测，detectTrends() 产出负载预警。
 *
 * 5.0 质变（因果升级）：挂载 CausalKernel 后，本模型从「相关性预测器」
 * 升级为「因果预见器」——predictInterventionEffect(action, kpi) 直接回答
 * 「若我对系统实施 do(action)，目标 KPI 期望变化几何（含不确定性区间）」。
 * 相关矩阵负责「看见规律」，因果图负责「预见干预后果」——
 * 二者的显著背离（混杂指纹）在 getSummary() 中显式曝光。
 */
export class WorldModel {
  private config: WorldModelConfig;
  private stats = new Map<string, ArrivalStats>();
  private calibrations: CalibrationRecord[] = [];
  /** 待校准的预测（type → 预测值，窗口结束后对账） */
  private pendingPredictions = new Map<
    string,
    {
      predicted: number;
      windowEnd: number;
      /** 13.0：发出预测时的保形区间（对账覆盖监测用） */
      conformalInterval?: { lower: number; upper: number; finite: boolean };
    }
  >();
  /** 5.0：因果内核（可选挂载） */
  private causal?: import('./core/causal-kernel.js').CausalKernel;
  /** 13.0：保形校准引擎（可选挂载） */
  private conformalEngine?: import('./core/conformal.js').ConformalIntervalEngine;
  /** 26.0：每类型 GP 校准器（可选挂载；attachGpCalibrator 后惰性创建） */
  private gpCalibrators?: Map<string, import('./core/gaussian-process.js').GpSeriesCalibrator>;

  constructor(config?: Partial<WorldModelConfig>) {
    this.config = { ...DEFAULT_WORLD_MODEL_CONFIG, ...config };
  }

  /**
   * 26.0：挂载 GP 序列校准器开关（幂等）。
   *
   * 挂载后每次 settleCalibrations 把 actual/predicted 比值喂入该类型的
   * GP 时间序列；predictArrivals 的期望乘以 GP 后验均值因子、区间按
   * 后验标准差拓宽——趋势修正的 1.25/0.75 魔数由「从对账结果学出来的
   * 修正」接管（校准史充分前 factor 恒 1，早期零漂移）。
   */
  attachGpCalibrator(options?: ConstructorOptionsGpSeries): void {
    this.gpOptions = options;
    this.gpCalibrators = this.gpCalibrators ?? new Map();
  }

  private gpOptions?: ConstructorOptionsGpSeries;

  private gpFor(type: string): GpSeriesCalibrator | undefined {
    if (!this.gpCalibrators) return undefined;
    let cal = this.gpCalibrators.get(type);
    if (!cal) {
      cal = new GpSeriesCalibrator(this.gpOptions);
      this.gpCalibrators.set(type, cal);
    }
    return cal;
  }

  /** 26.0：GP 校准状态（未挂载返回 undefined） */
  getGpCalibrationStatus(): Array<{ type: string; points: number }> | undefined {
    if (!this.gpCalibrators) return undefined;
    return [...this.gpCalibrators.entries()].map(([type, cal]) => ({ type, points: cal.size }));
  }

  /**
   * 5.0：挂载因果内核（幂等）。
   *
   * 挂载后：
   * - 类型共现自动作为观测证据写入因果图（银级证据）；
   * - predictInterventionEffect 提供因果预见（黄金口径）。
   */
  attachCausalKernel(kernel: import('./core/causal-kernel.js').CausalKernel): void {
    this.causal = kernel;
    // 把既有共现规律回灌为观测证据（一次性迁移，非逐拍重复）
    for (const corr of this.getCorrelations(0.05)) {
      for (let k = 0; k < Math.min(corr.coOccurrences, 20); k += 1) {
        kernel.observe(`signal:${corr.typeA}`, `signal:${corr.typeB}`, true, true);
      }
    }
  }

  /**
   * 13.0：挂载保形校准引擎（幂等）。
   *
   * 挂载后 predictArrivals 的区间从 sqrt(λ) 泊松近似升级为保形区间：
   * 精确有限样本覆盖 ≥ 1−α，零分布假设（可交换性即可）；每次
   * settleCalibrations 的残差自动入校准集，覆盖漂移由 e-过程监测
   * （失准确证 → status().drift.drifting，应重校准）。
   */
  attachConformalCalibrator(engine: import('./core/conformal.js').ConformalIntervalEngine): void {
    this.conformalEngine = engine;
  }

  /** 13.0：保形校准状态（未挂载返回 undefined） */
  getConformalStatus(): import('./core/conformal.js').ConformalStatus | undefined {
    return this.conformalEngine?.status();
  }

  /**
   * 5.0：因果预见 ——「若实施 do(action)，目标指标期望如何变化」。
   *
   * 与 predictArrivals 的本质区别：那是「世界自己会怎样」（外推），
   * 这是「我们主动干预后世界会怎样」（因果阶梯第二层）。
   * 无因果证据时诚实返回 null，而非伪装成知道。
   */
  predictInterventionEffect(
    action: string,
    targetKpi: string,
  ): import('./core/causal-kernel.js').CausalEffect | null {
    if (!this.causal) return null;
    const eff = this.causal.effect(action, targetKpi);
    if (eff.interventionalSamples + eff.observationalSamples === 0) return null;
    return eff;
  }

  /** 5.0：登记一次真实干预（A/B 切换 / 参数实验的黄金证据） */
  recordIntervention(
    action: string,
    targetKpi: string,
    setTo: boolean,
    observedY: boolean,
    actor: string,
    hypothesis?: string,
  ): void {
    this.causal?.intervene(action, targetKpi, setTo, observedY, actor, hypothesis);
  }

  /**
   * 观察一次信号到达（增量学习入口）
   * @param type 信号类型
   * @param timestamp 到达时间戳（缺省当前时间）
   */
  observeArrival(type: string, timestamp = Date.now()): void {
    let entry = this.stats.get(type);
    if (!entry) {
      entry = {
        type,
        timestamps: [],
        hourHistogram: new Array(24).fill(0),
        totalCount: 0,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
      };
      this.stats.set(type, entry);
    }
    entry.timestamps.push(timestamp);
    if (entry.timestamps.length > this.config.maxTimestampsPerType) {
      entry.timestamps.splice(0, entry.timestamps.length - this.config.maxTimestampsPerType);
    }
    entry.hourHistogram[new Date(timestamp).getHours()] += 1;
    entry.totalCount += 1;
    entry.lastSeenAt = timestamp;
  }

  /**
   * 预测未来窗口内各类型信号的到达数
   * @param horizonMs 预测窗口（毫秒，缺省 5 分钟）
   * @returns 各类型的到达预测（按期望到达数降序）
   */
  predictArrivals(horizonMs = 5 * 60_000): ArrivalPrediction[] {
    const now = Date.now();
    const predictions: ArrivalPrediction[] = [];

    for (const [type, entry] of this.stats) {
      const ratePerMs = this.recentRate(entry, now);
      const trend = this.trendOf(entry, now);
      // 趋势修正：上升趋势上浮预测，下降趋势下调
      const trendFactor = trend === 'rising' ? 1.25 : trend === 'falling' ? 0.75 : 1;
      const expected = ratePerMs * horizonMs * trendFactor;

      // 时段热度修正：目标时段相对全天均值的权重
      // 42.0：挂载谱日历后，小时直方图（周期被预设为一天）升级为
      // 从到达史解出的频谱——Fisher g 显著时用谐波重构的季节因子
      // （相位感知，可捕捉非昼夜节律）；不显著时回退原直方图口径。
      const hourFactor = this.spectralCalendar
        ? (this.spectralFactorOf(entry, now + horizonMs / 2) ?? this.hourFactor(entry, now + horizonMs / 2))
        : this.hourFactor(entry, now + horizonMs / 2);
      const adjustedRaw = expected * hourFactor;

      const confidence = this.calibrationConfidence(type);

      // 13.0：保形区间升级——泊松 sqrt(λ) 近似是「假装高斯」；
      // 保形区间给出精确有限样本覆盖保证（≥ 1−α，零分布假设）。
      // 校准不足时 finite=false（诚实发散），回退泊松近似区间。
      // 26.0：GP 校准修正——期望乘以从校准史学出的比值因子（含不确定度），
      // 区间按后验标准差拓宽；校准史不足时 factor=1（零漂移）。
      const gpCorrection = this.gpFor(type)?.predictAt(now);
      const gpFactor = gpCorrection?.factor ?? 1;
      const gpStd = gpCorrection?.std ?? 0;
      const adjusted = adjustedRaw * gpFactor;
      const gpSpread = gpStd * adjustedRaw;
      // 置信区间：基于到达间隔的波动性（泊松近似，std≈sqrt(mean)）；
      // GP 不确定度在区间端点上单独叠加（避免与泊松口径重复计价）
      const spread = Math.sqrt(Math.max(adjusted, 0.5));

      let prediction: ArrivalPrediction;
      if (this.conformalEngine) {
        const interval = this.conformalEngine.interval(adjusted);
        prediction = {
          type,
          expectedCount: Number(adjusted.toFixed(2)),
          lowerBound: interval.finite ? Number(Math.max(0, interval.lower - gpSpread).toFixed(2)) : Math.max(0, Number((adjusted - spread - gpSpread).toFixed(2))),
          upperBound: interval.finite ? Number(Math.max(0, interval.upper + gpSpread).toFixed(2)) : Number((adjusted + spread + gpSpread).toFixed(2)),
          confidence,
          trend,
          conformal: {
            lower: interval.finite ? Number(Math.max(0, interval.lower - gpSpread).toFixed(2)) : Number.POSITIVE_INFINITY,
            upper: interval.finite ? Number(Math.max(0, interval.upper + gpSpread).toFixed(2)) : Number.POSITIVE_INFINITY,
            finite: interval.finite,
            qhat: interval.qhat,
            calibrationN: interval.calibrationN,
            alpha: interval.alpha,
          },
          ...(gpCorrection ? { gp: { factor: Number(gpFactor.toFixed(3)), std: Number(gpStd.toFixed(3)), points: gpCorrection.points } } : {}),
        };
        this.pendingPredictions.set(type, {
          predicted: adjusted,
          windowEnd: now + horizonMs,
          conformalInterval: interval.finite ? { lower: interval.lower, upper: interval.upper, finite: true } : undefined,
        });
      } else {
        prediction = {
          type,
          expectedCount: Number(adjusted.toFixed(2)),
          lowerBound: Math.max(0, Number((adjusted - spread - gpSpread).toFixed(2))),
          upperBound: Number((adjusted + spread + gpSpread).toFixed(2)),
          confidence,
          trend,
          ...(gpCorrection ? { gp: { factor: Number(gpFactor.toFixed(3)), std: Number(gpStd.toFixed(3)), points: gpCorrection.points } } : {}),
        };
        this.pendingPredictions.set(type, { predicted: adjusted, windowEnd: now + horizonMs });
      }
      predictions.push(prediction);
    }

    return predictions.sort((a, b) => b.expectedCount - a.expectedCount);
  }

  /**
   * 对账预测与实际到达（校准）
   * @returns 本轮新增的校准记录
   */
  settleCalibrations(now = Date.now()): CalibrationRecord[] {
    const settled: CalibrationRecord[] = [];
    for (const [type, pending] of this.pendingPredictions) {
      if (pending.windowEnd > now) continue;
      const entry = this.stats.get(type);
      // 统计预测窗口内的实际到达数
      const windowStart = pending.windowEnd - this.lastHorizonMs;
      const actualCount = entry ? entry.timestamps.filter((t) => t > windowStart && t <= pending.windowEnd).length : 0;
      const record: CalibrationRecord = {
        type,
        predicted: Number(pending.predicted.toFixed(2)),
        actual: actualCount,
        error: Number(Math.abs(pending.predicted - actualCount).toFixed(2)),
        timestamp: now,
      };
      this.calibrations.push(record);
      settled.push(record);
      // 26.0：比值入 GP 校准器（actual/predicted 序列 → 预测修正因子）
      const gp = this.gpFor(type);
      if (gp && record.predicted > 0) {
        gp.push(now, Math.max(0.05, Math.min(20, record.actual / record.predicted)));
      }
      // 13.0：残差入保形校准集 + 覆盖监测（发出过有限区间才对账覆盖）
      if (this.conformalEngine) {
        this.conformalEngine.calibrate(record.error);
        if (pending.conformalInterval?.finite) {
          this.conformalEngine.recordCovered(
            actualCount >= pending.conformalInterval.lower && actualCount <= pending.conformalInterval.upper,
          );
        }
      }
      this.pendingPredictions.delete(type);
    }
    if (this.calibrations.length > 200) this.calibrations.splice(0, this.calibrations.length - 200);
    return settled;
  }

  /**
   * 类型关联矩阵（共现强度）
   * @param minStrength 最低关联强度过滤
   * @returns 类型对关联列表（按强度降序）
   */
  getCorrelations(minStrength = 0.1): TypeCorrelation[] {
    const types = [...this.stats.keys()];
    const correlations: TypeCorrelation[] = [];
    for (let i = 0; i < types.length; i += 1) {
      for (let j = i + 1; j < types.length; j += 1) {
        const a = this.stats.get(types[i])!;
        const b = this.stats.get(types[j])!;
        const coOccurrences = this.countCoOccurrences(a.timestamps, b.timestamps);
        if (coOccurrences === 0) continue;
        const strength = coOccurrences / Math.max(1, Math.min(a.totalCount, b.totalCount));
        if (strength >= minStrength) {
          correlations.push({ typeA: types[i], typeB: types[j], coOccurrences, strength: Number(strength.toFixed(3)) });
        }
      }
    }
    return correlations.sort((x, y) => y.strength - x.strength);
  }

  /**
   * 趋势检测：识别到达率上升的类型（负载预警）
   * @returns 上升趋势的类型列表（含斜率）
   */
  detectTrends(): Array<{ type: string; trend: 'rising' | 'falling' | 'stable'; slopePerMin: number }> {
    const now = Date.now();
    const results: Array<{ type: string; trend: 'rising' | 'falling' | 'stable'; slopePerMin: number }> = [];
    for (const [type, entry] of this.stats) {
      const slope = this.slopeOf(entry, now);
      const trend = slope > this.config.risingSlopeThreshold ? 'rising' : slope < -this.config.risingSlopeThreshold ? 'falling' : 'stable';
      results.push({ type, trend, slopePerMin: Number(slope.toFixed(4)) });
    }
    return results.sort((a, b) => b.slopePerMin - a.slopePerMin);
  }

  /** 世界模型摘要 */
  getSummary(): WorldModelSummary {
    const types = [...this.stats.keys()];
    return {
      trackedTypes: types.length,
      totalArrivals: types.reduce((sum, t) => sum + this.stats.get(t)!.totalCount, 0),
      types: types.map((t) => {
        const entry = this.stats.get(t)!;
        return { type: t, totalCount: entry.totalCount, lastSeenAt: entry.lastSeenAt, recentRatePerMin: Number((this.recentRate(entry, Date.now()) * 60_000).toFixed(3)) };
      }),
      correlations: this.getCorrelations().slice(0, 10),
      trends: this.detectTrends().filter((t) => t.trend !== 'stable'),
      calibrationError: this.meanCalibrationError(),
      // 5.0：混杂指纹 —— 观测共现强但因果效应弱的类型对（伪规律证伪现场）
      confoundedPairs: this.causal
        ? this.causal
            .detectConfounding()
            .filter((e) => e.from.startsWith('signal:') && e.to.startsWith('signal:'))
            .slice(0, 5)
            .map((e) => ({
              typeA: e.from.replace('signal:', ''),
              typeB: e.to.replace('signal:', ''),
              observationalStrength: e.observationalAssociation,
              causalEffect: e.ate,
              divergence: e.divergence,
            }))
        : undefined,
      // 13.0：保形校准状态（区间保证 + 覆盖漂移监测）
      conformal: this.conformalEngine ? this.conformalEngine.status() : undefined,
    };
  }

  /** 平均校准误差（MAE） */
  meanCalibrationError(): number {
    if (this.calibrations.length === 0) return 0;
    return Number((this.calibrations.reduce((sum, c) => sum + c.error, 0) / this.calibrations.length).toFixed(3));
  }

  /** 序列化 */
  serialize(): { stats: ArrivalStats[]; calibrations: CalibrationRecord[] } {
    return { stats: [...this.stats.values()], calibrations: [...this.calibrations] };
  }

  /** 反序列化 */
  deserialize(data: { stats: ArrivalStats[]; calibrations: CalibrationRecord[] }): void {
    this.stats.clear();
    for (const entry of data.stats) this.stats.set(entry.type, entry);
    this.calibrations = [...data.calibrations];
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 最近到达率（每毫秒），基于最近 5 分钟窗口 */
  private recentRate(entry: ArrivalStats, now: number): number {
    const windowMs = 5 * 60_000;
    const recent = entry.timestamps.filter((t) => t >= now - windowMs);
    if (recent.length === 0) return 0;
    return recent.length / windowMs;
  }

  /** 时段热度因子：目标时段计数 / 全天均值 */
  /**
   * 42.0：挂载谱日历（幂等覆盖，挂载即生效）。
   *
   * 时段热度从「预设为一天的小时直方图」升级为谱分析：到达时间戳按
   * 小时分桶为时间序列，FFT 周期图 + Fisher g 检验判定是否存在显著
   * 周期（任意周期——分钟回环/小时批处理/昼夜/周节律）；显著时
   * predictArrivals 的热度因子切换为谐波重构的季节因子（相位感知），
   * 不显著时逐位回退原直方图口径。未挂载零漂移。
   */
  attachSpectralCalendar(options?: { bins?: number }): void {
    this.spectralCalendar = { bins: Math.max(32, Math.floor(options?.bins ?? 128)) };
  }

  /** 42.0：谱日历配置（未挂载 undefined） */
  private spectralCalendar?: { bins: number };

  /** 42.0：谱季节因子（显著周期时数值；不显著 / 样本不足 → undefined 回退） */
  private spectralFactorOf(entry: ArrivalStats, targetTimestamp: number): number | undefined {
    const bins = this.spectralCalendar?.bins ?? 128;
    if (entry.timestamps.length < 16) return undefined;
    const hourMs = 3_600_000;
    const newest = entry.timestamps[entry.timestamps.length - 1];
    const baseHour = Math.floor(newest / hourMs);
    const counts = new Array<number>(bins).fill(0);
    let firstCovered = -1;
    for (const t of entry.timestamps) {
      const hourIndex = Math.floor(t / hourMs) - (baseHour - bins + 1);
      if (hourIndex >= 0 && hourIndex < bins) {
        counts[hourIndex] += 1;
        if (firstCovered < 0 || hourIndex < firstCovered) firstCovered = hourIndex;
      }
    }
    if (firstCovered < 0) return undefined;
    // 裁剪到覆盖段（前导零空洞会注入伪低频能量）
    const covered = counts.slice(firstCovered);
    const phase = ((Math.floor(targetTimestamp / hourMs) - (baseHour - bins + 1) - firstCovered) % covered.length + covered.length) % covered.length;
    const seasonal = seasonalFactor(covered, phase);
    this.lastSpectral = {
      bins,
      samples: entry.timestamps.length,
      significant: seasonal.significant,
      periodHours: seasonal.period,
    };
    return seasonal.significant ? seasonal.factor : undefined;
  }

  /** 42.0：谱日历状态（纯读取；未挂载/未评估时 undefined） */
  getSpectralCalendarStatus(): { bins: number; samples: number; significant: boolean; periodHours: number | undefined } | undefined {
    return this.lastSpectral ? { ...this.lastSpectral } : undefined;
  }

  private lastSpectral?: { bins: number; samples: number; significant: boolean; periodHours: number | undefined };

  private hourFactor(entry: ArrivalStats, targetTimestamp: number): number {
    const total = entry.hourHistogram.reduce((a, b) => a + b, 0);
    if (total === 0) return 1;    const hour = new Date(targetTimestamp).getHours();
    const mean = total / 24;
    if (mean === 0) return 1;
    // 限制因子范围，避免冷启动时段过度放大
    return Math.max(0.5, Math.min(2, entry.hourHistogram[hour] / mean));
  }

  /** 趋势方向（由斜率判定） */
  private trendOf(entry: ArrivalStats, now: number): 'rising' | 'falling' | 'stable' {
    const slope = this.slopeOf(entry, now);
    if (slope > this.config.risingSlopeThreshold) return 'rising';
    if (slope < -this.config.risingSlopeThreshold) return 'falling';
    return 'stable';
  }

  /** 到达率线性回归斜率（每分钟到达数 / 分钟） */
  private slopeOf(entry: ArrivalStats, now: number): number {
    const windowMs = 10 * 60_000;
    const recent = entry.timestamps.filter((t) => t >= now - windowMs);
    if (recent.length < this.config.minSamplesForTrend) return 0;
    // 将窗口切成两半，比较前后半的到达率
    const mid = now - windowMs / 2;
    const firstHalf = recent.filter((t) => t < mid).length;
    const secondHalf = recent.filter((t) => t >= mid).length;
    const halfMinutes = windowMs / 2 / 60_000;
    return (secondHalf - firstHalf) / halfMinutes / halfMinutes;
  }

  /** 共现计数：两序列中时间邻近的配对数 */
  private countCoOccurrences(a: number[], b: number[]): number {
    let count = 0;
    let j = 0;
    for (let i = 0; i < a.length; i += 1) {
      while (j < b.length && b[j] < a[i] - this.config.coOccurrenceWindowMs) j += 1;
      for (let k = j; k < b.length && b[k] <= a[i] + this.config.coOccurrenceWindowMs; k += 1) {
        count += 1;
      }
    }
    return count;
  }

  /** 预测置信度（由该类型历史校准误差驱动） */
  private calibrationConfidence(type: string): number {
    const records = this.calibrations.filter((c) => c.type === type);
    if (records.length === 0) return 0.5; // 无校准数据时中等置信
    const mae = records.reduce((sum, c) => sum + c.error, 0) / records.length;
    if (mae > this.config.calibrationErrorThreshold) return 0.3;
    return Math.max(0.4, Math.min(0.95, 1 - mae / (this.config.calibrationErrorThreshold * 2)));
  }

  /** 最近一次预测窗口（用于对账，简化为固定 5 分钟） */
  private get lastHorizonMs(): number {
    return 5 * 60_000;
  }
}
