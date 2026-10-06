/**
 * metrics.ts — 遥测审计总线 · 指标注册表（基础设施之二）
 *
 * 统一的 counter / gauge / histogram 三类指标与有限基数护栏：
 * - counter：inc / add（单调，拒绝负增量）；gauge：set / inc（可升可降）
 * - histogram：桶边界可配（≥1 个严格递增有限数），维护 count/sum/min/max 与
 *   p50/p95/p99（桶内线性插值）+ 累积分布（le 从小到大，末端 '+Inf'）
 * - 标签集：每指标内不同标签组合数受 maxLabelCardinality 护栏；
 *   超限「拒绝并计数」（默认 reject：不记样本、累计 cardinalityRejections；
 *   可选 throw：显式抛错并计数）——防标签组合爆炸
 * - snapshot：确定性导出（指标名升序、序列按规范化标签键升序、
 *   标签对象键升序、固定字段序）；同一操作序列两次导出逐位一致
 * - reset：清空全部指标与护栏计数
 *
 * R4 二期深化（缺省零漂移——全部为纯增量）：
 * - 滑动窗口聚合 SlidingWindowAggregator：按时间桶滚动的窗口聚合
 *   （windowMs 必须为 bucketMs 整数倍；窗口内 count/sum/avg/min/max、
 *   ratePerMs=count/windowMs 与 sumPerMs=sum/windowMs、逐桶读数按 startMs
 *   升序）；整桶在窗口起点之前即过期（读取 stats() 前先裁剪——过期数据
 *   不残留），过期桶数与陈旧样本丢弃数可观测；适用于 counter 增量流
 *   （observe(增量)）与 gauge 读数流（observe(读数)）
 * - Prometheus 文本导出 prometheusExposition(snapshot)（纯函数）与
 *   MetricsRegistry.toPrometheus()：标准 exposition format——# HELP/# TYPE
 *   行、指标名 '.'→'_' 映射、标签 {k="v"} 序列化（\、" 与换行转义）、
 *   counter/gauge 单值行、histogram 的 _bucket{le=…}/_sum/_count 行；
 *   NaN/+Inf/-Inf 按规范拼写；注册时可给 help 文案（缺省 `${name} (${kind})`）
 *
 * 零依赖：纯内存、零 I/O、不使用 Date.now / Math.random；入参显式 throw。
 */

import { createManualClock, type TelemetryClock } from './event-bus.js';

// ─────────────────────────── 标签集 ───────────────────────────

/** 标签集：字符串键值对（值必须为 string，键非空） */
export type LabelSet = Readonly<Record<string, string>>;

/** 标签值转义：保证规范化键 `k=v,k=v` 的无歧义性 */
function escapeLabelPart(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/,/g, '\\,');
}

/** 校验并规范化标签集：undefined → {}；值必须全为 string、键非空 */
function normalizeLabels(labels: LabelSet | undefined, api: string): Record<string, string> {
  if (labels === undefined) return {};
  if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) {
    throw new TypeError(`${api}: labels 必须为字符串键值对象，收到 ${String(labels)}`);
  }
  const normalized: Record<string, string> = {};
  for (const key of Object.keys(labels)) {
    if (key.length === 0) throw new TypeError(`${api}: 标签键不允许为空字符串`);
    const value: unknown = labels[key];
    if (typeof value !== 'string') {
      throw new TypeError(`${api}: 标签 '${key}' 的值必须为 string，收到 ${typeof value}`);
    }
    normalized[key] = value;
  }
  return normalized;
}

/** 规范化标签键（序列排序依据）：键升序的 `k=v` 逗号连接（含转义） */
function canonicalLabelKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${escapeLabelPart(key)}=${escapeLabelPart(labels[key] as string)}`)
    .join(',');
}

/** 构造键升序的标签对象副本（snapshot 确定性用） */
function sortedLabels(labels: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(labels).sort()) sorted[key] = labels[key];
  return sorted;
}

// ─────────────────────────── 序列与指标条目 ───────────────────────────

interface CounterSeries {
  readonly labels: Record<string, string>;
  readonly key: string;
  value: number;
}

interface GaugeSeries {
  readonly labels: Record<string, string>;
  readonly key: string;
  value: number;
}

interface HistogramSeries {
  readonly labels: Record<string, string>;
  readonly key: string;
  /** 各桶内计数（含边界；超出最后有限边界的观测只计入 count，不入桶数组） */
  readonly bucketCounts: number[];
  count: number;
  sum: number;
  min: number;
  max: number;
}

interface CounterEntry {
  readonly kind: 'counter';
  readonly name: string;
  readonly series: Map<string, CounterSeries>;
  /** Prometheus 导出的 HELP 文案（缺省 `${name} (${kind})`） */
  help: string | undefined;
  rejections: number;
}

interface GaugeEntry {
  readonly kind: 'gauge';
  readonly name: string;
  readonly series: Map<string, GaugeSeries>;
  help: string | undefined;
  rejections: number;
}

interface HistogramEntry {
  readonly kind: 'histogram';
  readonly name: string;
  readonly series: Map<string, HistogramSeries>;
  readonly buckets: readonly number[];
  help: string | undefined;
  rejections: number;
}

type MetricEntry = CounterEntry | GaugeEntry | HistogramEntry;

/** 注册时的可选文案：Prometheus 导出 # HELP 行使用（首次给出即生效） */
export interface MetricHelpOptions {
  /** HELP 文案（单行；换行与反斜杠导出时转义） */
  readonly help?: string;
}

/** histogram 注册配置（首次注册必须给 buckets；重获取可省略或须与已注册一致） */
export interface HistogramConfig extends MetricHelpOptions {
  /** 桶边界（≥1 个严格递增有限数；首桶含 0 口径见分位数实现） */
  readonly buckets?: readonly number[];
}

// ─────────────────────────── 句柄与快照接口 ───────────────────────────

/** counter 句柄：单调递增计数（inc 默认 +1；add 拒绝负/非有限增量） */
export interface CounterHandle {
  readonly name: string;
  /** +1（可带标签） */
  inc(labels?: LabelSet): void;
  /** +value（必须为 ≥0 的有限数，默认 1） */
  add(value?: number, labels?: LabelSet): void;
}

/** gauge 句柄：瞬时值（set 覆盖；inc 增减，可为负） */
export interface GaugeHandle {
  readonly name: string;
  /** 覆盖为 value（必须有限） */
  set(value: number, labels?: LabelSet): void;
  /** 增减 delta（默认 +1，必须有限，可为负） */
  inc(delta?: number, labels?: LabelSet): void;
}

/** histogram 统计读数 */
export interface HistogramStats {
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

/** 累积分布点：le 为桶上界（'+Inf' 为末端） */
export interface DistributionPoint {
  readonly le: number | '+Inf';
  readonly count: number;
}

/** histogram 句柄 */
export interface HistogramHandle {
  readonly name: string;
  /** 记录一次观测（必须为有限数） */
  observe(value: number, labels?: LabelSet): void;
  /** 统计读数（序列不存在时返回全 0 读数，不抛错） */
  stats(labels?: LabelSet): HistogramStats;
  /** 累积分布：le 升序，末端 {le:'+Inf', count:总数}；序列不存在返回 [] */
  distribution(labels?: LabelSet): ReadonlyArray<DistributionPoint>;
}

export type MetricKind = 'counter' | 'gauge' | 'histogram';

export interface MetricSeriesSnapshot {
  /** 键升序的标签对象（确定性字段序） */
  readonly labels: Readonly<Record<string, string>>;
  /** counter / gauge 的当前值 */
  readonly value?: number;
  /** histogram 的完整读数（统计 + 累积分布） */
  readonly histogram?: Readonly<HistogramStats> & { readonly distribution: ReadonlyArray<DistributionPoint> };
}

export interface MetricSnapshot {
  readonly name: string;
  readonly kind: MetricKind;
  /** 注册时给出的 HELP 文案（未给出时缺省——零漂移：不产生本键） */
  readonly help?: string;
  /** 序列按规范化标签键升序 */
  readonly series: ReadonlyArray<MetricSeriesSnapshot>;
  /** 本指标被基数护栏拒绝的样本数 */
  readonly cardinalityRejections: number;
}

export interface MetricsSnapshot {
  /** 按指标名升序 */
  readonly metrics: ReadonlyArray<MetricSnapshot>;
  readonly stats: {
    readonly metricCount: number;
    readonly seriesTotal: number;
    readonly cardinalityRejections: number;
  };
}

// ─────────────────────────── 注册表 ───────────────────────────

/** 基数护栏超限策略 */
export type CardinalityPolicy = 'reject' | 'throw';

export interface MetricsRegistryOptions {
  /** 每指标允许的最大不同标签组合数（≥1 整数，默认 64） */
  maxLabelCardinality?: number;
  /** 超限策略：'reject'（默认，拒样本并计数）| 'throw'（抛错并计数） */
  onCardinalityExceeded?: CardinalityPolicy;
}

/**
 * MetricsRegistry — 指标注册表。
 *
 * 同名同类型重复注册返回同一句柄；同名不同类型抛错；
 * histogram 重复注册时桶配置必须逐位一致，否则抛错。
 */
export class MetricsRegistry {
  private readonly metrics = new Map<string, MetricEntry>();
  private readonly maxCardinality: number;
  private readonly policy: CardinalityPolicy;
  private cardinalityRejections = 0;

  constructor(options: MetricsRegistryOptions = {}) {
    const max = options.maxLabelCardinality ?? 64;
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`MetricsRegistry: maxLabelCardinality 必须为 ≥1 的整数，收到 ${String(max)}`);
    }
    const policy = options.onCardinalityExceeded ?? 'reject';
    if (policy !== 'reject' && policy !== 'throw') {
      throw new TypeError(
        `MetricsRegistry: onCardinalityExceeded 必须为 'reject' | 'throw'，收到 ${String(policy)}`,
      );
    }
    this.maxCardinality = max;
    this.policy = policy;
  }

  /** 注册/获取 counter（options.help 为 Prometheus # HELP 文案） */
  counter(name: string, options?: MetricHelpOptions): CounterHandle {
    const entry = this.ensureCounterEntry(name, options);
    return {
      name,
      inc: (labels?: LabelSet): void => this.counterAdd(entry, 1, labels),
      add: (value = 1, labels?: LabelSet): void => this.counterAdd(entry, value, labels),
    };
  }

  /** 注册/获取 gauge（options.help 为 Prometheus # HELP 文案） */
  gauge(name: string, options?: MetricHelpOptions): GaugeHandle {
    const entry = this.ensureGaugeEntry(name, options);
    return {
      name,
      set: (value: number, labels?: LabelSet): void => {
        assertFiniteValue(value, `gauge('${name}').set`);
        const series = this.gaugeSeries(entry, labels, `gauge('${name}').set`);
        if (series !== undefined) series.value = value;
      },
      inc: (delta = 1, labels?: LabelSet): void => {
        assertFiniteValue(delta, `gauge('${name}').inc`);
        const series = this.gaugeSeries(entry, labels, `gauge('${name}').inc`);
        if (series !== undefined) series.value += delta;
      },
    };
  }

  /**
   * 注册/获取 histogram（新注册时 config.buckets 必填：≥1 个严格递增有限数）；
   * 重获取时 config 可省略（沿用已注册桶配置），给出 buckets 则必须与已注册桶
   * 逐位一致；config.help 为 Prometheus # HELP 文案（无不变量约束，后给覆盖）。
   */
  histogram(name: string, config?: HistogramConfig): HistogramHandle {
    const entry = this.ensureHistogramEntry(name, config);
    return {
      name,
      observe: (value: number, labels?: LabelSet): void => {
        assertFiniteValue(value, `histogram('${name}').observe`);
        const series = this.histogramSeries(entry, labels, `histogram('${name}').observe`);
        if (series === undefined) return;
        series.count += 1;
        series.sum += value;
        if (value < series.min) series.min = value;
        if (value > series.max) series.max = value;
        for (let i = 0; i < entry.buckets.length; i += 1) {
          if (value <= (entry.buckets[i] as number)) {
            series.bucketCounts[i] = (series.bucketCounts[i] ?? 0) + 1;
            break;
          }
        }
      },
      stats: (labels?: LabelSet): HistogramStats => {
        const key = canonicalLabelKey(normalizeLabels(labels, `histogram('${name}').stats`));
        const series = entry.series.get(key);
        return series === undefined ? zeroHistogramStats() : histogramStatsOf(entry.buckets, series);
      },
      distribution: (labels?: LabelSet): ReadonlyArray<DistributionPoint> => {
        const key = canonicalLabelKey(normalizeLabels(labels, `histogram('${name}').distribution`));
        const series = entry.series.get(key);
        return series === undefined ? [] : cumulativeDistribution(entry.buckets, series);
      },
    };
  }

  /** 确定性快照（指标名升序 / 序列键升序 / 标签键升序 / 固定字段序） */
  snapshot(): MetricsSnapshot {
    const snapshots: MetricSnapshot[] = [];
    let seriesTotal = 0;
    for (const name of [...this.metrics.keys()].sort()) {
      const entry = this.metrics.get(name);
      if (entry === undefined) continue;
      const seriesSnapshots: MetricSeriesSnapshot[] = [];
      if (entry.kind === 'histogram') {
        const seriesList = [...entry.series.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        for (const series of seriesList) {
          seriesSnapshots.push({
            labels: sortedLabels(series.labels),
            histogram: {
              ...histogramStatsOf(entry.buckets, series),
              distribution: cumulativeDistribution(entry.buckets, series),
            },
          });
        }
        seriesTotal += seriesList.length;
      } else {
        // counter / gauge：序列类型都有 value 字段
        const seriesList = [...entry.series.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        for (const series of seriesList) {
          seriesSnapshots.push({ labels: sortedLabels(series.labels), value: series.value });
        }
        seriesTotal += seriesList.length;
      }
      snapshots.push({
        name: entry.name,
        kind: entry.kind,
        ...(entry.help !== undefined ? { help: entry.help } : {}),
        series: seriesSnapshots,
        cardinalityRejections: entry.rejections,
      });
    }
    return {
      metrics: snapshots,
      stats: {
        metricCount: snapshots.length,
        seriesTotal,
        cardinalityRejections: this.cardinalityRejections,
      },
    };
  }

  /** 确定性 JSON 导出（同一操作序列两次导出逐位一致） */
  toJSON(): string {
    return JSON.stringify(this.snapshot());
  }

  /** Prometheus 文本导出（标准 exposition format；确定性与 snapshot 同序） */
  toPrometheus(): string {
    return prometheusExposition(this.snapshot());
  }

  /** 清空全部指标与护栏计数 */
  reset(): void {
    this.metrics.clear();
    this.cardinalityRejections = 0;
  }

  /** 注册表级统计 */
  registryStats(): { metricCount: number; seriesTotal: number; cardinalityRejections: number } {
    let seriesTotal = 0;
    for (const entry of this.metrics.values()) seriesTotal += entry.series.size;
    return { metricCount: this.metrics.size, seriesTotal, cardinalityRejections: this.cardinalityRejections };
  }

  // ── 内部：注册 ──

  private ensureCounterEntry(name: string, options?: MetricHelpOptions): CounterEntry {
    assertMetricName(name);
    const existing = this.metrics.get(name);
    if (existing !== undefined) {
      if (existing.kind !== 'counter') {
        throw new Error(`指标 '${name}' 已注册为 ${existing.kind}，不能重复注册为 counter`);
      }
      if (options?.help !== undefined) existing.help = options.help;
      return existing;
    }
    const entry: CounterEntry = { kind: 'counter', name, series: new Map(), help: options?.help, rejections: 0 };
    this.metrics.set(name, entry);
    return entry;
  }

  private ensureGaugeEntry(name: string, options?: MetricHelpOptions): GaugeEntry {
    assertMetricName(name);
    const existing = this.metrics.get(name);
    if (existing !== undefined) {
      if (existing.kind !== 'gauge') {
        throw new Error(`指标 '${name}' 已注册为 ${existing.kind}，不能重复注册为 gauge`);
      }
      if (options?.help !== undefined) existing.help = options.help;
      return existing;
    }
    const entry: GaugeEntry = { kind: 'gauge', name, series: new Map(), help: options?.help, rejections: 0 };
    this.metrics.set(name, entry);
    return entry;
  }

  private ensureHistogramEntry(name: string, config?: HistogramConfig): HistogramEntry {
    assertMetricName(name);
    const existing = this.metrics.get(name);
    if (existing !== undefined) {
      if (existing.kind !== 'histogram') {
        throw new Error(`指标 '${name}' 已注册为 ${existing.kind}，不能重复注册为 histogram`);
      }
      if (config === undefined || config.buckets === undefined) {
        if (config?.help !== undefined) existing.help = config.help;
        return existing; // 幂等重获取：沿用已注册桶配置
      }
      const buckets = normalizeBuckets({ buckets: config.buckets }, name);
      if (existing.buckets.join(',') !== buckets.join(',')) {
        throw new Error(
          `histogram('${name}'): 重复注册且桶配置不一致（已有 [${existing.buckets.join(',')}]，新给 [${buckets.join(',')}])`,
        );
      }
      if (config.help !== undefined) existing.help = config.help;
      return existing;
    }
    if (config === undefined || config.buckets === undefined) {
      throw new TypeError(`histogram('${name}'): 首次注册必须提供 config.buckets（≥1 个严格递增有限数）`);
    }
    const buckets = normalizeBuckets(config as { buckets: readonly number[] }, name);
    const entry: HistogramEntry = {
      kind: 'histogram', name, series: new Map(), buckets, help: config.help, rejections: 0,
    };
    this.metrics.set(name, entry);
    return entry;
  }

  // ── 内部：序列获取（含基数护栏） ──

  private counterAdd(entry: CounterEntry, value: number, labels: LabelSet | undefined): void {
    if (!Number.isFinite(value)) {
      throw new TypeError(`counter('${entry.name}').add: 必须为有限数，收到 ${String(value)}`);
    }
    if (value < 0) {
      throw new RangeError(`counter('${entry.name}').add: 计数器只增不减，拒绝负增量 ${String(value)}`);
    }
    const series = this.counterSeries(entry, labels, `counter('${entry.name}')`);
    if (series !== undefined) series.value += value;
  }

  private counterSeries(entry: CounterEntry, labels: LabelSet | undefined, api: string): CounterSeries | undefined {
    const normalized = normalizeLabels(labels, api);
    const key = canonicalLabelKey(normalized);
    const existing = entry.series.get(key);
    if (existing !== undefined) return existing;
    if (!this.admitNewSeries(entry, key, api)) return undefined;
    const created: CounterSeries = { labels: normalized, key, value: 0 };
    entry.series.set(key, created);
    return created;
  }

  private gaugeSeries(entry: GaugeEntry, labels: LabelSet | undefined, api: string): GaugeSeries | undefined {
    const normalized = normalizeLabels(labels, api);
    const key = canonicalLabelKey(normalized);
    const existing = entry.series.get(key);
    if (existing !== undefined) return existing;
    if (!this.admitNewSeries(entry, key, api)) return undefined;
    const created: GaugeSeries = { labels: normalized, key, value: 0 };
    entry.series.set(key, created);
    return created;
  }

  private histogramSeries(
    entry: HistogramEntry,
    labels: LabelSet | undefined,
    api: string,
  ): HistogramSeries | undefined {
    const normalized = normalizeLabels(labels, api);
    const key = canonicalLabelKey(normalized);
    const existing = entry.series.get(key);
    if (existing !== undefined) return existing;
    if (!this.admitNewSeries(entry, key, api)) return undefined;
    const created: HistogramSeries = {
      labels: normalized,
      key,
      bucketCounts: new Array<number>(entry.buckets.length).fill(0),
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
    };
    entry.series.set(key, created);
    return created;
  }

  /**
   * 基数护栏：新标签组合将使序列数超过 maxLabelCardinality 时触发——
   * 'reject' 返回 false（样本被拒）；'throw' 抛错；
   * 两种策略都累计 registry.cardinalityRejections 与该指标的 rejections。
   */
  private admitNewSeries(entry: MetricEntry, key: string, api: string): boolean {
    if (entry.series.size >= this.maxCardinality) {
      this.cardinalityRejections += 1;
      entry.rejections += 1;
      if (this.policy === 'throw') {
        throw new Error(
          `${api}: 标签基数超限（已有 ${entry.series.size}/${this.maxCardinality} 个组合），拒绝新标签集 '${key}'`,
        );
      }
      return false;
    }
    return true;
  }
}

// ─────────────────────────── 纯函数 ───────────────────────────

function assertMetricName(name: string): void {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(name)) {
    throw new TypeError(`指标名必须匹配 /^[A-Za-z][A-Za-z0-9_.]*$/（收到 ${String(name)}）`);
  }
}

function assertFiniteValue(value: number, api: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${api}: 必须为有限数，收到 ${String(value)}`);
  }
}

function normalizeBuckets(config: { buckets: readonly number[] }, name: string): readonly number[] {
  const buckets = config?.buckets;
  if (!Array.isArray(buckets) || buckets.length === 0) {
    throw new TypeError(`histogram('${name}'): config.buckets 必须为 ≥1 个元素的数组`);
  }
  for (let i = 0; i < buckets.length; i += 1) {
    const bound = buckets[i];
    if (typeof bound !== 'number' || !Number.isFinite(bound)) {
      throw new TypeError(`histogram('${name}'): 桶边界必须全为有限数，第 ${i + 1} 个为 ${String(bound)}`);
    }
    const previous = i > 0 ? buckets[i - 1] : undefined;
    if (previous !== undefined && bound <= previous) {
      throw new RangeError(
        `histogram('${name}'): 桶边界必须严格递增（第 ${i} 个 ${String(previous)} ≥ 第 ${i + 1} 个 ${String(bound)}）`,
      );
    }
  }
  return buckets.slice();
}

function zeroHistogramStats(): HistogramStats {
  return { count: 0, sum: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
}

/**
 * 分位数（桶内线性插值）：
 * - rank = q × count；找首个累积计数 ≥ rank 的桶，在
 *   [上一桶边界（首桶取 0——观测按非负口径设计）, 本桶边界] 内线性插值；
 * - 落入 +Inf 桶（超出最后有限边界）返回最后一个有限边界；
 * - 空序列返回 0（确定性口径）。q 必须在 [0,1]。
 */
function histogramQuantile(buckets: readonly number[], series: HistogramSeries, q: number): number {
  if (!Number.isFinite(q) || q < 0 || q > 1) {
    throw new RangeError(`分位数 q 必须在 [0,1]，收到 ${String(q)}`);
  }
  if (series.count === 0) return 0;
  const rank = q * series.count;
  let cumulative = 0;
  let lower = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    const bucketCount = series.bucketCounts[i] ?? 0;
    const nextCumulative = cumulative + bucketCount;
    if (nextCumulative >= rank) {
      if (bucketCount === 0) return lower;
      const upper = buckets[i] as number;
      return lower + ((upper - lower) * (rank - cumulative)) / bucketCount;
    }
    cumulative = nextCumulative;
    lower = buckets[i] as number;
  }
  return buckets[buckets.length - 1] as number;
}

function histogramStatsOf(buckets: readonly number[], series: HistogramSeries): HistogramStats {
  return {
    count: series.count,
    sum: series.sum,
    min: series.min === Number.POSITIVE_INFINITY ? 0 : series.min,
    max: series.max === Number.NEGATIVE_INFINITY ? 0 : series.max,
    p50: histogramQuantile(buckets, series, 0.5),
    p95: histogramQuantile(buckets, series, 0.95),
    p99: histogramQuantile(buckets, series, 0.99),
  };
}

/** 累积分布：逐桶累加（le 升序），末端补 {le:'+Inf', count:总观测数} */
function cumulativeDistribution(
  buckets: readonly number[],
  series: HistogramSeries,
): ReadonlyArray<DistributionPoint> {
  const result: DistributionPoint[] = [];
  let cumulative = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    cumulative += series.bucketCounts[i] ?? 0;
    result.push({ le: buckets[i] as number, count: cumulative });
  }
  result.push({ le: '+Inf', count: series.count });
  return result;
}

// ─────────────────────────── 滑动窗口聚合（R4 二期） ───────────────────────────

/** 滑动窗口选项 */
export interface SlidingWindowOptions {
  /** 窗口时长（≥bucketMs 的整数毫秒；必须为 bucketMs 的整数倍） */
  readonly windowMs: number;
  /** 桶粒度（≥1 整数毫秒） */
  readonly bucketMs: number;
  /** 注入时钟（缺省为 createManualClock(0)——确定性默认） */
  readonly clock?: TelemetryClock;
}

/** 单桶读数（桶区间 [startMs, startMs+bucketMs)） */
export interface SlidingWindowBucketStat {
  /** 桶起点（⌊ts/bucketMs⌋×bucketMs） */
  readonly startMs: number;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  /** 桶内首样本时刻 */
  readonly firstMs: number;
  /** 桶内末样本时刻 */
  readonly lastMs: number;
}

/** 窗口聚合读数（读取即裁剪：过期桶先移除，窗口外数据不残留） */
export interface SlidingWindowStats {
  readonly windowMs: number;
  readonly bucketMs: number;
  /** 窗口桶数 = windowMs / bucketMs */
  readonly bucketCount: number;
  /** 窗口内样本数 */
  readonly count: number;
  /** 窗口内样本和 */
  readonly sum: number;
  /** 窗口内均值（count=0 时为 0——确定性口径） */
  readonly avg: number;
  readonly min: number;
  readonly max: number;
  /** 事件密度 = count / windowMs（按整窗均匀口径） */
  readonly ratePerMs: number;
  /** 值速率 = sum / windowMs（按整窗均匀口径） */
  readonly sumPerMs: number;
  /** 逐桶读数（startMs 升序，只含仍在窗口内的桶） */
  readonly buckets: ReadonlyArray<SlidingWindowBucketStat>;
  /** 窗口内最老样本时刻（无样本为 undefined） */
  readonly oldestSampleMs: number | undefined;
  /** 窗口内最新样本时刻（无样本为 undefined） */
  readonly newestSampleMs: number | undefined;
  /** 累计 observe 次数（含陈旧丢弃） */
  readonly observedTotal: number;
  /** 累计过期移除的桶数 */
  readonly expiredBuckets: number;
  /** 累计被丢弃的陈旧样本数（at 早于窗口起点的 observe） */
  readonly staleDiscarded: number;
}

interface WindowBucket {
  readonly startMs: number;
  count: number;
  sum: number;
  min: number;
  max: number;
  firstMs: number;
  lastMs: number;
}

/**
 * SlidingWindowAggregator — 按时间桶滚动的滑动窗口聚合器。
 *
 * 口径：
 * - 样本经 observe(value, at?) 记入 at 所在桶（缺省 at=时钟当前值）；
 * - 过期规则：整桶在窗口起点（now − windowMs）之前即过期
 *   （bucketStart + bucketMs ≤ now − windowMs）；stats()/prune() 按当前时钟
 *   裁剪——过期数据不残留；
 * - 陈旧样本（at < now − windowMs，连所在桶都已整体出窗）直接丢弃并计数
 *   staleDiscarded（不造零头桶）；
 * - 确定性：同一时钟序列 + 同一 observe 序列 → 逐位相同读数。
 *
 * counter 增量流：observe(每次增量)；gauge 读数流：observe(每次读数)——
 * 窗口 sum/rate/avg 即该流的窗口内聚合。
 */
export class SlidingWindowAggregator {
  private readonly windowMsValue: number;
  private readonly bucketMsValue: number;
  private readonly clock: TelemetryClock;
  private readonly buckets = new Map<number, WindowBucket>();
  private observedTotal = 0;
  private expiredBucketsCount = 0;
  private staleDiscardedCount = 0;

  constructor(options: SlidingWindowOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError(`SlidingWindowAggregator: options 必须为对象，收到 ${String(options)}`);
    }
    const { windowMs, bucketMs } = options;
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new RangeError(`SlidingWindowAggregator: windowMs 必须为 ≥1 的整数，收到 ${String(windowMs)}`);
    }
    if (!Number.isInteger(bucketMs) || bucketMs < 1) {
      throw new RangeError(`SlidingWindowAggregator: bucketMs 必须为 ≥1 的整数，收到 ${String(bucketMs)}`);
    }
    if (windowMs % bucketMs !== 0) {
      throw new RangeError(
        `SlidingWindowAggregator: windowMs 必须为 bucketMs 的整数倍（收到 ${String(windowMs)} % ${String(bucketMs)} = ${String(windowMs % bucketMs)}）`,
      );
    }
    this.windowMsValue = windowMs;
    this.bucketMsValue = bucketMs;
    this.clock = options.clock ?? createManualClock(0);
  }

  /**
   * 记录一个样本：at 缺省取时钟当前值；at 已早于窗口起点的陈旧样本丢弃并
   * 计数（不入桶）。value 必须为有限数；at 必须为有限数。
   */
  observe(value: number, at?: number): void {
    assertFiniteValue(value, 'SlidingWindowAggregator.observe(value)');
    const ts = at === undefined ? this.clock.now() : at;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) {
      throw new TypeError(`SlidingWindowAggregator.observe: at 必须为有限数，收到 ${String(ts)}`);
    }
    const now = this.clock.now();
    if (!Number.isFinite(now)) {
      throw new TypeError(`SlidingWindowAggregator.observe: 时钟返回非有限时间戳 ${String(now)}`);
    }
    this.observedTotal += 1;
    if (ts < now - this.windowMsValue) {
      this.staleDiscardedCount += 1;
      return;
    }
    this.pruneExpired(now);
    const startMs = Math.floor(ts / this.bucketMsValue) * this.bucketMsValue;
    let bucket = this.buckets.get(startMs);
    if (bucket === undefined) {
      bucket = { startMs, count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, firstMs: ts, lastMs: ts };
      this.buckets.set(startMs, bucket);
    }
    bucket.count += 1;
    bucket.sum += value;
    if (value < bucket.min) bucket.min = value;
    if (value > bucket.max) bucket.max = value;
    if (ts < bucket.firstMs) bucket.firstMs = ts;
    if (ts > bucket.lastMs) bucket.lastMs = ts;
  }

  /** 显式裁剪：移除全部过期桶，返回本次移除数（发布外手动驱动的口径） */
  prune(): number {
    const now = this.clock.now();
    if (!Number.isFinite(now)) {
      throw new TypeError(`SlidingWindowAggregator.prune: 时钟返回非有限时间戳 ${String(now)}`);
    }
    return this.pruneExpired(now);
  }

  /** 窗口聚合读数（先按当前时钟裁剪过期桶；逐桶 startMs 升序） */
  stats(): SlidingWindowStats {
    this.prune();
    let count = 0;
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let oldestSampleMs: number | undefined;
    let newestSampleMs: number | undefined;
    const bucketStats: SlidingWindowBucketStat[] = [];
    for (const startMs of [...this.buckets.keys()].sort((a, b) => a - b)) {
      const bucket = this.buckets.get(startMs) as WindowBucket;
      bucketStats.push({ ...bucket });
      count += bucket.count;
      sum += bucket.sum;
      if (bucket.min < min) min = bucket.min;
      if (bucket.max > max) max = bucket.max;
      if (oldestSampleMs === undefined || bucket.firstMs < oldestSampleMs) oldestSampleMs = bucket.firstMs;
      if (newestSampleMs === undefined || bucket.lastMs > newestSampleMs) newestSampleMs = bucket.lastMs;
    }
    return {
      windowMs: this.windowMsValue,
      bucketMs: this.bucketMsValue,
      bucketCount: this.windowMsValue / this.bucketMsValue,
      count,
      sum,
      avg: count === 0 ? 0 : sum / count,
      min: min === Number.POSITIVE_INFINITY ? 0 : min,
      max: max === Number.NEGATIVE_INFINITY ? 0 : max,
      ratePerMs: count / this.windowMsValue,
      sumPerMs: sum / this.windowMsValue,
      buckets: bucketStats,
      oldestSampleMs,
      newestSampleMs,
      observedTotal: this.observedTotal,
      expiredBuckets: this.expiredBucketsCount,
      staleDiscarded: this.staleDiscardedCount,
    };
  }

  /** 内部裁剪：整桶终点（startMs+bucketMs）≤ now − windowMs 即过期移除 */
  private pruneExpired(now: number): number {
    const threshold = now - this.windowMsValue;
    let removed = 0;
    for (const startMs of this.buckets.keys()) {
      if (startMs + this.bucketMsValue <= threshold) {
        this.buckets.delete(startMs);
        removed += 1;
      }
    }
    this.expiredBucketsCount += removed;
    return removed;
  }
}

// ─────────────────────────── Prometheus 文本导出（R4 二期） ───────────────────────────

/** 指标名 '.' → '_' 映射 + 合法性校验（Prometheus 名字集 [a-zA-Z_:][a-zA-Z0-9_:]*） */
function prometheusMetricName(name: string): string {
  const mapped = name.replace(/\./g, '_');
  if (!/^[A-Za-z_:][A-Za-z0-9_:]*$/.test(mapped)) {
    throw new TypeError(`prometheusExposition: 指标名 '${name}' 映射 '${mapped}' 后仍不符合 Prometheus 命名集`);
  }
  return mapped;
}

/** 标签值转义：反斜杠、双引号、换行（exposition format 规范） */
function escapePrometheusLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** HELP 文案转义：反斜杠与换行（HELP 行必须单行） */
function escapePrometheusHelp(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** 样本值拼写：NaN / +Inf / -Inf 按规范，其余 String() */
function formatPrometheusValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

/** 标签集序列化：键升序 `{k="v",k2="v2"}`；extraLe 追加 le 标签在末位；空 → '' */
function formatPrometheusLabels(labels: Readonly<Record<string, string>>, extraLe?: string): string {
  const parts: string[] = [];
  for (const key of Object.keys(labels).sort()) {
    parts.push(`${key}="${escapePrometheusLabelValue(labels[key] as string)}"`);
  }
  if (extraLe !== undefined) parts.push(`le="${escapePrometheusLabelValue(extraLe)}"`);
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

/**
 * prometheusExposition — 把快照导出为 Prometheus 标准文本格式（纯函数）。
 *
 * 逐行口径（与 snapshot 同序：指标名升序、序列按规范化标签键升序）：
 * - 每指标先 `# HELP <名> <文案>`（快照未带文案时缺省 `<原名> (<kind>)`）
 *   与 `# TYPE <名> <kind>`；
 * - counter / gauge：`<名>{标签} 值`（无标签时省略 {}）；
 * - histogram：每序列 `<名>_bucket{…,le="桶界"} 计数`（le 升序，末端 '+Inf'）、
 *   `<名>_sum{…} 和`、`<名>_count{…} 数`；
 * - 指标名 '.'→'_' 映射（Prometheus 命名集不含 '.'）——不同注册名可能映射
 *   到同一导出名，由调用方避免；
 * - 空快照导出空字符串；非空导出以单个换行结尾。确定性：同快照逐位一致。
 */
export function prometheusExposition(snapshot: MetricsSnapshot): string {
  if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.metrics)) {
    throw new TypeError(`prometheusExposition: 必须为 MetricsSnapshot，收到 ${String(snapshot)}`);
  }
  const lines: string[] = [];
  for (const metric of snapshot.metrics) {
    const name = prometheusMetricName(metric.name);
    const help = escapePrometheusHelp(metric.help ?? `${metric.name} (${metric.kind})`);
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${metric.kind}`);
    for (const series of metric.series) {
      if (metric.kind === 'histogram' && series.histogram !== undefined) {
        for (const point of series.histogram.distribution) {
          const le = point.le === '+Inf' ? '+Inf' : formatPrometheusValue(point.le);
          lines.push(`${name}_bucket${formatPrometheusLabels(series.labels, le)} ${formatPrometheusValue(point.count)}`);
        }
        lines.push(`${name}_sum${formatPrometheusLabels(series.labels)} ${formatPrometheusValue(series.histogram.sum)}`);
        lines.push(`${name}_count${formatPrometheusLabels(series.labels)} ${formatPrometheusValue(series.histogram.count)}`);
      } else if (series.value !== undefined) {
        lines.push(`${name}${formatPrometheusLabels(series.labels)} ${formatPrometheusValue(series.value)}`);
      }
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
