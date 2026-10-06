/**
 * sentinel.ts — 信号感知哨兵（集成层，执行链路第 1~2 步）
 *
 * 职责：主动感知环境变化，统一封装为 Signal 对象并在聚合窗口内合并相关信号
 * - 三种信号源：webhook（HTTP 接入）/ filesystem（文件监听）/ polling（轮询比对）
 * - 手动注入入口（autonomous_execute Tool 与级联触发共用）
 * - 聚合窗口：aggregationWindow 内相关信号合并去重，窗口结束批量交付
 * - 交付回调 onBatch 由 index.ts 编排层消费，进入优先级排序与战略决策
 *
 * 升级点（相对单一 webhook 的质的提升）：
 * 1. 窗口内同源去重：type + dedupeKey 相同的信号合并计数，避免重复决策
 * 2. 批次双触发：窗口到期或达到 maxBatchSize 立即交付，兼顾时延与吞吐
 * 3. 文件监听防抖 + 忽略规则（node_modules / dist / .git），杜绝噪声风暴
 * 4. 轮询源内容哈希比对：仅在内容真实变化时产生信号
 * 5. 全部资源（server / watcher / timer）由 stop() 统一回收，支持 cordis fiber 清理
 *
 * 第三轮模块域升级（世界性升级 · sentinel 独占，全部可选注入、缺省零漂移）：
 * A. 自适应聚合窗口 v2（adaptiveWindow 配置）：滑动强度估计（到达间隔 EWMA）
 *    + 基线对照给出「风暴 / 正常 / 空闲」三态；风暴收缩窗口快速排空（含开窗
 *    中途按比例重排定时器）、空闲收缩窗口消除孤立信号滞留；可只读轮询已挂载
 *    的 55.0 Hawkes 视图作为风暴第二证据（限频拟合，零侵入）。
 *    缺省 undefined = 既有 v1 突发收缩行为原样保留；false = 纯固定窗口（A/B 基线）。
 * B. 紧急度衰减曲线（urgencyHalfLifeMs 配置）：urgency 随年龄半衰期指数衰减，
 *    聚合合并取峰值而非首见覆盖，flush 按「衰减后紧急度」降序交付（新鲜度
 *    进入排序口径——陈年高紧急度不再压住新鲜次紧急度）。
 * C. 入口背压（backpressure 配置）：每源令牌桶（速率上限 + 桶容量），超限
 *    信号进入溢出计数而非静默丢弃；backpressureView() 暴露逐源溢出率。
 * D. 来源溯源链（Signal.parentId）：级联信号「源→父信号→本信号」链解析，
 *    注册表环检测防无限级联 + 链深封顶，聚合保留最长链深，批次可观测
 *    maxProvenanceDepth。
 * E. 近重复去重升级（nearDuplicate 配置）：内容哈希精确去重之外，可注入
 *    相似度比较器（如 1 − NCD）做近重复合并；缺省哈希行为不变。
 * F. 信号指纹统计（attachFingerprintTracker）：按（源 × 类型 × 指纹 FNV-1a）
 *    的滚动统计（次数 / 窗口内计数 / 平均间隔 EMA），供 76.0 新奇检测消费。
 *
 * 第四轮模块域升级（R4 · 全新维度，全部 opt-in、缺省零漂移）：
 * G. 共因爆发检测（commonCause 配置）：时间窗内多源到达的同期性统计——
 *    巧合对提升 = 观测巧合对数 / 独立假设期望（期望 = 2×tol×rate×N，
 *    点过程口径），把「多源同时风暴」按提升连边聚类为共同根因事件：
 *    共因（到达强巧合，提升 ≫ 1）vs 独立风暴（巧合 ≈ 随机，提升 ≈ 1）
 *    的判别口径；commonCauseView() 暴露分组、两两提升与事件史。
 * H. 周期画像（periodicity 配置）：源级周期学习——自相关峰（点过程
 *    回报率谱 score(L) + 基频优选 + 峰值局部细化 + EWMA 精化），
 *    「预期 vs 实际」偏差信号：早到/晚到偏差（周期倍数）与「该来的
 *    没来」负偏离（静默 ≥ missFactor×周期；可选自动注入 period-miss
 *    信号，每错失一个期望周期报一次）。
 * I. 级联优先级继承（cascadePriority 配置）：级联信号继承父信号有效
 *    优先级 × inheritFactor（代际衰减），自报更高优先级被封顶
 *    maxInherit（孙代永不超过祖代的 inheritFactor² —— 防级联放大
 *    风暴），下限 minUrgency 保深链可见性。
 * J. 源质量反馈（attachSourceQuality）：每源「信号→最终结局」滚动
 *    评分（effective/noise 率，Laplace 平滑，因果口径——结局只回溯
 *    早于本次到达的记录）；reportOutcome 回填；autoDiscount 开启时
 *    低质量源 urgency 打折（权重 = minWeight + (1−minWeight)×score）
 *    ——有效信号在排序中提前。
 * K. 风暴预算共享（stormBudget 配置，加分项）：全局风暴判定（跨源
 *    总强度 EWMA vs 平稳基线），风暴期全部令牌桶自动按 tightenFactor
 *    收紧（全局入口预算联动），解除带 holdMs 滞回——风暴期入口预算
 *    从「各源各自为政」到「全局一口锅」。
 *
 * 确定性纪律：新逻辑不引入任何随机源；时间读取统一走可注入 clock
 * （缺省 Date.now —— 与旧行为逐位一致），验证脚本可注入合成时钟。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// 创世纪 55.0：Hawkes 自激发爆发监视（到达相关性的数学口径）
import { HawkesBurstMonitor, type HawkesBurstView } from './engines-frontier/genesis25.js';
// 第二轮创世纪 76.0/80.0/99.0：新奇检测（异常 = 没见过）/ 流式概要缓冲 / 注意力经济拍卖
import {
  SentinelNoveltyMonitor,
  SignalSketchBuffer,
  attentionAuction,
  type AttentionAuctionView,
  type AttentionSource,
} from './engines-frontier/autonomy25.js';

/** 统一信号对象（执行链路第 1 步产物） */
export interface Signal {
  id: string;
  /** 信号类型：code-change / error-detected / performance-degraded / webhook / manual / cascade 等 */
  type: string;
  /** 人类可读描述 */
  description: string;
  /** 原始载荷 */
  payload: Record<string, any>;
  /** 紧急度 0~1（第 3 步由决策模型填充） */
  urgency?: number;
  receivedAt: number;
  /** 来源标识：webhook:9878 / fs:/path / poll:url / manual / cascade */
  source: string;
  /** 聚合去重键（缺省取 type + description） */
  dedupeKey?: string;
  /** 窗口内被合并的原始信号次数 */
  occurrences: number;
  /** 所属租户（多租户路由后填充） */
  tenantId?: string;
  /** 截止时间（毫秒时间戳）：截止时间感知调度依据 */
  deadlineMs?: number;
  /** 富化上下文（哨兵自动附加：到达速率 / 关联信号 / 历史频率） */
  enrichment?: SignalEnrichment;
  /** 溯源：父信号 id（级联信号注入；哨兵解析链深并做环检测，环被切断时置空） */
  parentId?: string;
  /** 溯源链深（根 = 0；哨兵在 ingest 时解析——未知父按深度 0 计，超上限封顶） */
  provenanceDepth?: number;
  /** 入口背压溢出标记（true = 该信号被令牌桶拒绝，仅计入溢出统计，不进入聚合） */
  overflowed?: boolean;
  /** 衰减后紧急度（urgencyHalfLifeMs 配置时由 flush 填充：urgency × 0.5^(年龄/半衰期)） */
  decayedUrgency?: number;
  /** 级联继承标记（cascadePriority 配置时：urgency 被继承规则写入/封顶后出现；缺省不出现该键） */
  inheritedUrgency?: boolean;
  /** 源质量打折权重（attachSourceQuality + autoDiscount 开启时填充；缺省不出现该键） */
  qualityWeight?: number;
}

/** 信号富化上下文（感知环节深度优化产物） */
export interface SignalEnrichment {
  /** 该类型信号最近 1 分钟到达次数（突发检测依据） */
  recentRatePerMin: number;
  /** 该类型信号历史总次数 */
  historicalCount: number;
  /** 是否突发（recentRatePerMin 超过基线 3 倍） */
  isBurst: boolean;
  /** 关联信号 id 列表（时间邻近 + 类型关联） */
  correlatedSignalIds: string[];
  /** 当前生效的聚合窗口（毫秒，自适应） */
  effectiveWindowMs: number;
  /** 负载三态（adaptiveWindow v2 配置时填充；缺省模式不出现该键） */
  loadState?: SentinelLoadState;
  /** 滑动强度估计（次/秒，到达间隔 EWMA；adaptiveWindow v2 配置时填充） */
  intensityPerSec?: number;
}

/** 信号源配置 */
export interface SignalSourceConfig {
  type: 'webhook' | 'polling' | 'filesystem';
  /** webhook 监听端口 */
  port?: number;
  /** polling 间隔（毫秒） */
  interval?: number;
  /** polling 目标 URL */
  url?: string;
  /** filesystem 监听路径 */
  path?: string;
  /** 该源产生的信号类型 */
  signalType: string;
}

/** 负载三态：风暴（到达强度远超基线）/ 正常 / 空闲（长时间无到达） */
export type SentinelLoadState = 'storm' | 'normal' | 'idle';

/**
 * 自适应聚合窗口 v2 配置（强度驱动三态）。
 *
 * 数学口径：
 * - 强度估计 λ̂：逐到达瞬时速率 1000/Δt（Δt 下限 1ms）的 EWMA（α = intensityAlpha）
 * - 平稳基线 λ_base：normal 态对 λ̂ 的慢速 EWMA（β = 0.05，风暴/空闲冻结——基线始终代表平稳期）
 * - storm ⟺ λ̂ ≥ max(minStormRatePerSec, λ_base × stormFactor)（或挂载的 Hawkes 视图 burst）
 * - idle ⟺ 本次到达距上次到达 ≥ idleGapMs
 * - 窗口目标：storm → w×stormShrink；idle → w×idleShrink；normal → w（均下限 minWindowMs）
 * - 靠拢：每次到达向目标逼近 approachFactor（idle 立即收缩——孤立信号无聚合收益可损失）；
 *   开窗中途收缩时按比例重排定时器（风暴快速排空的关键路径）
 */
export interface AdaptiveWindowConfig {
  /** 强度 EWMA 平滑系数（0~1，缺省 0.3——约 3 次到达跟上速率变化） */
  intensityAlpha?: number;
  /** 风暴判定倍率：λ̂ ≥ λ_base × stormFactor（缺省 3） */
  stormFactor?: number;
  /** 风暴判定绝对速率下限（次/秒，缺省 5——零星到达不算风暴） */
  minStormRatePerSec?: number;
  /** 空闲判定间隔（毫秒，缺省 max(3×配置窗, 1000)） */
  idleGapMs?: number;
  /** 风暴期窗口收缩比（缺省 0.125） */
  stormShrink?: number;
  /** 空闲期窗口收缩比（缺省 0.125） */
  idleShrink?: number;
  /** 窗口下限（毫秒，缺省 50） */
  minWindowMs?: number;
  /** 向目标窗口靠拢系数（0~1，缺省 0.5） */
  approachFactor?: number;
  /** Hawkes 视图轮询间隔（毫秒，缺省 1000——挂载 55.0 时的第二证据，限频防 EM 拟合内爆） */
  hawkesPollMs?: number;
}

/** 令牌桶参数（入口背压） */
export interface SourceTokenBucket {
  /** 稳态令牌补充速率（令牌/秒） */
  ratePerSec: number;
  /** 桶容量（缺省 = 1 秒配额 = ratePerSec，下限 1） */
  burst?: number;
}

/** 入口背压配置（缺省不启用——全部信号放行，零介入） */
export interface SentinelBackpressureConfig {
  /** 全源缺省桶（未列入 sources 的源套用；未配置则未列出源不限流） */
  default?: SourceTokenBucket;
  /** 逐源覆盖（按 Signal.source 精确匹配） */
  sources?: Record<string, SourceTokenBucket>;
}

/** 单源背压读数 */
export interface BackpressureSourceView {
  source: string;
  ratePerSec: number;
  burst: number;
  /** 当前桶内令牌（截至最近一次该源到达时的懒补充值） */
  tokens: number;
  admitted: number;
  overflowed: number;
  /** 溢出率 = overflowed / (admitted + overflowed) */
  overflowRate: number;
}

/** 背压总览读数（未配置时 backpressureView() 返回 undefined——诚实降级） */
export interface BackpressureView {
  configured: true;
  bySource: BackpressureSourceView[];
  totalAdmitted: number;
  totalOverflowed: number;
  overflowRate: number;
}

/** 近重复去重配置（缺省不启用——精确哈希去重行为不变） */
export interface NearDuplicateConfig {
  /** 相似度比较器：返回 [0,1]，越大越相似（如 1 − NCD(description)）；仅同类型信号间比较 */
  similarity: (a: Signal, b: Signal) => number;
  /** 合并阈：similarity ≥ threshold 判近重复（0~1） */
  threshold: number;
  /** 候选扫描上限（最近多少条 pending，缺省 16） */
  maxCandidates?: number;
}

/** 单指纹滚动统计（源 × 类型 × 指纹） */
export interface FingerprintStat {
  source: string;
  type: string;
  /** 内容指纹（dedupeKey 缺省取 type:description 的 FNV-1a 32 位十六进制） */
  fingerprint: string;
  /** 追踪期内总到达次数 */
  count: number;
  /** 滚动窗内到达次数 */
  windowCount: number;
  /** 平均到达间隔（毫秒，EMA α=0.2；首次到达为 0——无间隔信息） */
  meanIntervalMs: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** 指纹追踪配置 */
export interface FingerprintTrackerOptions {
  /** 滚动窗（毫秒，缺省 600_000） */
  windowMs?: number;
  /** 键容量上限（缺省 512，最久未更新者淘汰） */
  maxKeys?: number;
  /** 每键窗口时间戳环上限（缺省 64） */
  perKeyWindow?: number;
}

// ─────────────────── 第四轮 R4：全新维度（全部 opt-in，缺省零漂移） ───────────────────

/** 共因爆发检测配置（缺省不启用——无任何多源分析开销） */
export interface CommonCauseConfig {
  /** 分析窗（毫秒，缺省 10_000）：窗内到达参与同期性与速率统计 */
  windowMs?: number;
  /** 巧合判定容差（毫秒，缺省 50）：|t_a − t_b| ≤ coincidenceMs 记一对巧合 */
  coincidenceMs?: number;
  /** 单源风暴判别倍率：窗内速率 ≥ max(minBurstRatePerSec, 基线 × burstFactor)（缺省 3） */
  burstFactor?: number;
  /** 单源风暴绝对速率下限（次/秒，缺省 1） */
  minBurstRatePerSec?: number;
  /** 窗内最少到达数才参与风暴判别（缺省 3） */
  minWindowArrivals?: number;
  /** 同期性提升阈：巧合对数 / 独立期望 ≥ minLift 判同因连边（缺省 2.5） */
  minLift?: number;
  /** 成团最少源数（缺省 2——单源不成「共因」） */
  minSources?: number;
  /** 平稳基线慢速跟踪系数（0~1，缺省 0.02——风暴期冻结，且须显著慢于风暴速率爬升，基线始终代表平稳期） */
  baselineAlpha?: number;
  /** 评估限频（毫秒，缺省 100——到达驱动，仅分析窗内数据） */
  evaluateEveryMs?: number;
  /** 每源到达环容量（缺省 4096） */
  maxArrivalsPerSource?: number;
}

/** 两两同期性读数（风暴源对） */
export interface CommonCausePairLift {
  a: string;
  b: string;
  /** 观测巧合对数（窗内 |t_a − t_b| ≤ coincidenceMs 的到达对） */
  observedPairs: number;
  /** 独立假设下的期望巧合对数（2 × tol秒 × rate_b × N_a 的点过程口径） */
  expectedPairs: number;
  /** 提升 = observed / max(expected, 0.5)（floor 防小样本爆炸） */
  lift: number;
}

/** 爆发聚类分组（共因 vs 独立的判别结果） */
export interface CommonCauseGroupView {
  sources: string[];
  classification: 'common-cause' | 'independent';
  /** 共因组：组内两两提升的最小值（最弱链定组）；独立组：组内两两提升的最大值（诚实口径） */
  groupLift: number;
  pairLifts: CommonCausePairLift[];
}

/** 爆发事件史条目（分组出现/消失的转变沿） */
export interface CommonCauseEvent {
  detectedAt: number;
  kind: 'common-cause' | 'independent';
  sources: string[];
  groupLift: number;
}

/** 共因爆发总览读数（未配置时 commonCauseView() 返回 undefined——诚实降级） */
export interface CommonCauseView {
  /** 最近一次评估时间（到达驱动；view 反映该时刻的窗内状态） */
  evaluatedAt: number;
  windowMs: number;
  burstSources: Array<{ source: string; ratePerSec: number; baselinePerSec: number; arrivals: number; burst: boolean }>;
  groups: CommonCauseGroupView[];
  /** 全部风暴源两两提升（含未成团的独立对——判别的完整证据面） */
  pairLifts: CommonCausePairLift[];
  /** 事件史（保留最近 32 条） */
  events: CommonCauseEvent[];
  commonCauseEvents: number;
  independentStormEvents: number;
}

/** 周期画像配置（缺省不启用） */
export interface PeriodicityConfig {
  /** 候选周期下限（毫秒，缺省 1_000） */
  minPeriodMs?: number;
  /** 候选周期上限（毫秒，缺省 300_000） */
  maxPeriodMs?: number;
  /** 候选网格数（对数等距，缺省 96） */
  gridSteps?: number;
  /** 匹配容差：max(tolFloorMs, tolRatio × L)（缺省 50ms / 5%） */
  tolFloorMs?: number;
  tolRatio?: number;
  /** 起评最少到达数（缺省 8——第 8 次到达即首评） */
  minArrivals?: number;
  /** 周期判定强度阈（0~1，缺省 0.6） */
  minStrength?: number;
  /** 重评节拍：此后每 reevaluateEvery 次到达重评一次（缺省 16） */
  reevaluateEvery?: number;
  /** 漏报判定：静默 ≥ missFactor × 周期（缺省 1.5） */
  missFactor?: number;
  /** 到达偏差异常阈（周期倍数，缺省 0.3） */
  deviationThreshold?: number;
  /** 漏报自动注入 period-miss 信号（缺省 false——纯读数零漂移） */
  emitMissSignals?: boolean;
  /** 每源到达环容量（缺省 512） */
  maxArrivalsPerSource?: number;
}

/** 强度谱点（候选周期 → 回报率得分） */
export interface PeriodicitySpectrumPoint {
  periodMs: number;
  score: number;
}

/** 单源周期画像读数 */
export interface PeriodicitySourceView {
  source: string;
  arrivals: number;
  status: 'learning' | 'locked' | 'overdue';
  periodMs?: number;
  strength?: number;
  firstArrivalAt?: number;
  lastArrivalAt?: number;
  /** 下一期望到达（锁定后 = 上次到达 + 周期） */
  expectedNextAt?: number;
  /** 最近到达偏差（周期倍数：负 = 早到，正 = 晚到） */
  lastDeviationCycles?: number;
  /** 当前静默逾期（周期倍数，0 = 未逾期） */
  overdueCycles: number;
  /** 偏差超阈计数 */
  deviations: number;
  /** 漏报注入计数（emitMissSignals 开启时） */
  misses: number;
  /** 强度谱 top-k（得分降序） */
  spectrum: PeriodicitySpectrumPoint[];
}

/** 周期画像总览（未配置时 periodicityView() 返回 undefined） */
export interface PeriodicityView {
  sources: PeriodicitySourceView[];
}

/** 级联优先级继承配置（缺省不启用——子信号 urgency 原样保留） */
export interface CascadePriorityConfig {
  /** 代际继承因子：未自报 urgency 的子代 = 父代有效 urgency × inheritFactor（缺省 0.6） */
  inheritFactor?: number;
  /** 放大封顶：子代有效 urgency ≤ 父代有效值 × maxInherit（缺省 1.0——跨代永不放大） */
  maxInherit?: number;
  /** 有效 urgency 下限（缺省 0.02——深链不至于完全隐形） */
  minUrgency?: number;
}

/** 级联优先级读数（未配置时 cascadePriorityView() 返回 undefined） */
export interface CascadePriorityView {
  /** 继承生效次数（子代 urgency 被继承规则写入） */
  inherited: number;
  /** 自报优先级被封顶次数（防放大） */
  capped: number;
  /** 观测到的最深继承代际 */
  maxGeneration: number;
  inheritFactor: number;
  maxInherit: number;
  minUrgency: number;
}

/** 源质量追踪配置（attachSourceQuality 挂载） */
export interface SourceQualityOptions {
  /** 结局滚动窗（毫秒，缺省 3_600_000） */
  windowMs?: number;
  /** Laplace 平滑系数（缺省 1——小样本不极端） */
  smoothing?: number;
  /** 每源结局环容量（缺省 1024） */
  maxOutcomesPerSource?: number;
  /** 自动打折：urgency × (minWeight + (1−minWeight) × score)（缺省 false——纯读数零漂移） */
  autoDiscount?: boolean;
  /** 打折权重下限（缺省 0.3——低质量源打折但不抹杀） */
  minWeight?: number;
}

/** 单源质量读数 */
export interface SourceQualityView {
  source: string;
  effective: number;
  noise: number;
  total: number;
  /** 有效率评分（(effective + s) / (total + 2s) 的 Laplace 平滑口径） */
  score: number;
  /** 当前打折权重（autoDiscount 开启时填充） */
  weight?: number;
}

/** 风暴预算共享配置（缺省不启用；与 backpressure 组合才产生收紧效果，风暴判定自身独立生效） */
export interface StormBudgetConfig {
  /** 全局风暴倍率：总强度 ≥ max(minStormRatePerSec, 基线 × stormFactor)（缺省 3） */
  stormFactor?: number;
  /** 全局风暴绝对强度下限（次/秒，缺省 10——基线需平稳期建立） */
  minStormRatePerSec?: number;
  /** 风暴期各令牌桶收紧系数（0~1，缺省 0.5） */
  tightenFactor?: number;
  /** 解除滞回（毫秒，缺省 2_000——强度回落后再保持一段时间才恢复） */
  holdMs?: number;
  /** 总强度 EWMA α（缺省 0.3） */
  intensityAlpha?: number;
}

/** 风暴预算读数（未配置时 stormBudgetView() 返回 undefined） */
export interface StormBudgetView {
  active: boolean;
  intensityPerSec?: number;
  baselinePerSec?: number;
  /** 风暴阈（次/秒） */
  thresholdPerSec: number;
  /** 当前全局入口预算（各桶现行速率之和，次/秒） */
  budgetPerSec: number;
  tightenFactor: number;
  /** 收紧激活次数 */
  tightenings: number;
  sources: Array<{ source: string; ratePerSec: number; originalRatePerSec: number }>;
}

/** 哨兵配置（对应 cordis.patch.yml sentinel 节） */
export interface SentinelConfig {
  watchCodeChanges: boolean;
  watchErrors: boolean;
  watchPerformance: boolean;
  /** 聚合窗口（秒） */
  aggregationWindow: number;
  signalSources?: SignalSourceConfig[];
  /** 文件监听根目录（watchCodeChanges 启用时） */
  watchDir?: string;
  /** 批次大小上限（达到即提前交付） */
  maxBatchSize?: number;
  /** fetch 实现注入（测试用） */
  fetchImpl?: typeof fetch;
  /** 时钟注入（缺省 Date.now——所有内部时间读取统一口径，验证可注入合成时钟） */
  clock?: () => number;
  /** 自适应聚合窗口 v2：undefined = 既有 v1 突发收缩（缺省，零漂移）；false = 纯固定窗口；对象 = 三态强度驱动 */
  adaptiveWindow?: false | AdaptiveWindowConfig;
  /** 紧急度衰减半衰期（毫秒）：配置后合并取峰值 + flush 按衰减后紧急度降序交付；缺省不衰减不排序 */
  urgencyHalfLifeMs?: number;
  /** 入口背压（每源令牌桶；缺省不限流） */
  backpressure?: SentinelBackpressureConfig;
  /** 近重复去重（相似度比较器注入；缺省仅精确哈希去重） */
  nearDuplicate?: NearDuplicateConfig;
  /** R4-G 共因爆发检测（多源同期性聚类：共因 vs 独立风暴判别；缺省不启用） */
  commonCause?: CommonCauseConfig;
  /** R4-H 周期画像（源级周期学习 + 期望偏差/漏报信号；缺省不启用） */
  periodicity?: PeriodicityConfig;
  /** R4-I 级联优先级继承（代际衰减 + 放大封顶；缺省不启用） */
  cascadePriority?: CascadePriorityConfig;
  /** R4-K 风暴预算共享（全局风暴期令牌桶联动收紧；缺省不启用） */
  stormBudget?: StormBudgetConfig;
}

/** 聚合批次（执行链路第 2 步产物） */
export interface SignalBatch {
  signals: Signal[];
  aggregatedAt: number;
  /** 交付原因：窗口到期 / 批量上限 / 手动 flush */
  reason: 'window' | 'max-size' | 'flush';
  /** 本批信号的最长溯源链深（存在级联信号时填充；根信号批次不出现该键） */
  maxProvenanceDepth?: number;
}

/** 哨兵运行时状态 */
export interface SentinelStatus {
  running: boolean;
  pendingSignals: number;
  totalIngested: number;
  totalBatches: number;
  sources: Array<{ type: string; detail: string; active: boolean }>;
  aggregationWindow: number;
  /** 当前自适应窗口（毫秒） */
  effectiveWindowMs: number;
  /** 累计突发次数 */
  burstCount: number;
  /** 各类型信号历史计数 */
  historicalCounts: Record<string, number>;
  /** 负载三态（adaptiveWindow v2 配置时填充；缺省模式不出现该键） */
  loadState?: SentinelLoadState;
  /** 滑动强度估计（次/秒；adaptiveWindow v2 配置时填充） */
  intensityPerSec?: number;
  /** 观测到的最长溯源链深 */
  maxProvenanceDepth: number;
  /** 溯源环检测切断次数（防无限级联） */
  provenanceCycles: number;
  /** 溯源链深封顶次数 */
  provenanceTruncations: number;
  /** 近重复合并次数（nearDuplicate 配置时累计） */
  nearDuplicateMerges: number;
  /** 背压总览（未配置时不出现该键） */
  backpressure?: BackpressureView;
}

/** 文件监听忽略目录 */
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', '.scheduler', '.cache', 'coverage']);
/** 文件监听防抖（毫秒） */
const FS_DEBOUNCE_MS = 300;
/** 默认轮询间隔（毫秒） */
const DEFAULT_POLL_INTERVAL = 30_000;
/** 溯源链深上限（防无限级联的硬顶） */
const PROVENANCE_MAX_DEPTH = 32;
/** 溯源注册表容量（parentOf / depthOf 各自上限，FIFO 淘汰） */
const PROVENANCE_REGISTRY_CAP = 4096;

/** clamp 到 [0,1] */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** FNV-1a 32 位内容指纹（确定性、零依赖——指纹统计口径） */
function fnv1a32hex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 巧合对计数：|a − b| ≤ tolMs 的到达对数（双指针；两序列须升序） */
function countCoincidentPairs(xs: number[], ys: number[], tolMs: number): number {
  let count = 0;
  let j = 0;
  for (const x of xs) {
    while (j < ys.length && ys[j]! < x - tolMs) j += 1;
    let k = j;
    while (k < ys.length && ys[k]! <= x + tolMs) {
      count += 1;
      k += 1;
    }
  }
  return count;
}

/** 连通分量聚类（无向边 = pairLifts 中 lift ≥ minLift 的源对；并查集 + 路径压缩） */
function clusterByEdges(sources: string[], pairLifts: CommonCausePairLift[], minLift: number): string[][] {
  const parent = new Map<string, string>(sources.map((s) => [s, s]));
  const find = (s: string): string => {
    let r = s;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = s;
    while (parent.get(c) !== c) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (const p of pairLifts) {
    if (p.lift >= minLift) {
      const ra = find(p.a);
      const rb = find(p.b);
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const groups = new Map<string, string[]>();
  for (const s of sources) {
    const r = find(s);
    const arr = groups.get(r) ?? [];
    arr.push(s);
    groups.set(r, arr);
  }
  return [...groups.values()].map((g) => g.slice().sort());
}

/** adaptiveWindow v2 解析后的生效配置（缺省值就地固化） */
interface ResolvedAdaptiveWindow {
  intensityAlpha: number;
  stormFactor: number;
  minStormRatePerSec: number;
  idleGapMs?: number;
  stormShrink: number;
  idleShrink: number;
  minWindowMs: number;
  approachFactor: number;
  hawkesPollMs: number;
}

/** 逐源令牌桶运行态 */
interface TokenBucketState {
  ratePerSec: number;
  burst: number;
  tokens: number;
  lastRefillAt: number;
  admitted: number;
  overflowed: number;
}

/** 指纹追踪运行态 */
interface FingerprintTrackerState {
  windowMs: number;
  maxKeys: number;
  perKeyWindow: number;
  stats: Map<string, Omit<FingerprintStat, 'windowCount'> & { windowTs: number[] }>;
}

/**
 * 信号感知哨兵
 *
 * 被 index.ts 持有：start() 后持续产生 SignalBatch，
 * 编排层对每个批次执行第 3~10 步链路。
 */
export class Sentinel {
  private config: SentinelConfig;
  private onBatch: (batch: SignalBatch) => void;
  private fetchImpl: typeof fetch;
  /** 可注入时钟（缺省 Date.now）——全部内部时间读取的统一口径 */
  private clock: () => number;

  private pending: Signal[] = [];
  private dedupeIndex = new Map<string, Signal>();
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  /** 开窗时刻的窗口截止时间（clock 口径——开窗中途收缩时按比例重排定时器） */
  private windowDeadline: number | undefined;

  private webhookServers: http.Server[] = [];
  private fsWatchers: fs.FSWatcher[] = [];
  private pollTimers: Array<ReturnType<typeof setInterval>> = [];
  private pollHashes = new Map<string, string>();
  private fsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private fsPendingPaths = new Set<string>();

  private running = false;
  private totalIngested = 0;
  private totalBatches = 0;

  // ── 感知深度优化：自适应窗口 + 富化状态 ──
  /** 各类型信号到达时间戳环形缓冲（突发检测 / 速率统计） */
  private arrivalHistory = new Map<string, number[]>();
  /** 各类型信号历史总次数 */
  private historicalCounts = new Map<string, number>();
  /** 各类型信号到达速率基线（指数移动平均，次/分钟） */
  private rateBaseline = new Map<string, number>();
  /** 最近注入的信号（关联分析用，保留 50 条；ingest 时即记录，无需等待交付） */
  private recentSignals: Array<{ id: string; type: string; receivedAt: number }> = [];
  /** 当前自适应窗口（毫秒） */
  private currentWindowMs: number;
  /** 突发计数（最近窗口内被判定为突发的次数） */
  private burstCount = 0;
  /** 55.0：Hawkes 爆发监视器（未挂载零介入——只读观测口径） */
  private hawkesMonitor?: HawkesBurstMonitor;
  /** 76.0：新奇监视器（未挂载零介入——只读观测口径） */
  private noveltyMonitor?: SentinelNoveltyMonitor;
  /** 80.0：流式概要缓冲（未挂载零介入——感官层只读口径） */
  private sketchBuffer?: SignalSketchBuffer;
  /** 99.0：注意力经济挂载旗标（未挂载零介入——影子拍卖口径） */
  private attentionEconomyEnabled?: boolean;

  // ── 第三轮升级 A：自适应窗口 v2（三态强度驱动） ──
  /** v2 生效配置（adaptiveWindow 为对象时解析） */
  private adaptiveCfg: ResolvedAdaptiveWindow | undefined;
  /** adaptiveWindow === false：纯固定窗口（禁用一切窗口自适应——A/B 基线口径） */
  private fixedWindowMode = false;
  /** 滑动强度估计 λ̂（次/秒；第二个到达起有值） */
  private intensityPerSec: number | undefined;
  /** 平稳基线 λ_base（次/秒；normal 态慢速跟踪，storm/idle 冻结） */
  private baselinePerSec: number | undefined;
  /** 最近一次到达时间（clock 口径） */
  private lastArrivalAt: number | undefined;
  /** 最近一次判定的负载三态 */
  private loadState: SentinelLoadState = 'normal';
  /** Hawkes 视图最近轮询时间（限频） */
  private lastHawkesPollAt = Number.NEGATIVE_INFINITY;

  // ── 第三轮升级 B：紧急度衰减 ──

  // ── 第三轮升级 C：入口背压（每源令牌桶） ──
  private buckets = new Map<string, TokenBucketState>();

  // ── 第三轮升级 D：来源溯源链 ──
  /** childId → parentId 注册表（环检测上溯用） */
  private parentOf = new Map<string, string>();
  /** signalId → 已解析链深 */
  private depthOf = new Map<string, number>();
  private provenanceCycles = 0;
  private provenanceTruncations = 0;
  private maxProvenanceDepthObserved = 0;
  private windowMaxProvenanceDepth = 0;

  // ── 第三轮升级 E：近重复合并 ──
  private nearDuplicateMerges = 0;

  // ── 第三轮升级 F：指纹统计 ──
  private fingerprintTracker: FingerprintTrackerState | undefined;

  // ── 第四轮 G：共因爆发检测 ──
  /** 逐源到达时间戳环（admitted 口径；配置 commonCause 时维护） */
  private ccArrivals = new Map<string, number[]>();
  /** 逐源平稳基线（次/秒；风暴期冻结） */
  private ccBaselines = new Map<string, number>();
  private ccLastEvalAt: number | undefined;
  private ccLastGroups: CommonCauseGroupView[] = [];
  private ccLastPairLifts: CommonCausePairLift[] = [];
  private ccLastBurst: CommonCauseView['burstSources'] = [];
  private ccEvents: CommonCauseEvent[] = [];
  private ccCommonCauseEvents = 0;
  private ccIndependentStormEvents = 0;
  /** 当前活跃共因分组键（转变检测：新键出现即记事件） */
  private ccActiveCommonKey: string | undefined;
  private ccActiveIndependentKey: string | undefined;

  // ── 第四轮 H：周期画像 ──
  private periodicArrivals = new Map<string, number[]>();
  private periodicModel = new Map<string, {
    periodMs: number;
    strength: number;
    lastArrivalAt?: number;
    lastExpectedAt?: number;
    lastDeviationCycles?: number;
    nextMissReportAt?: number;
    deviations: number;
    misses: number;
    spectrum: PeriodicitySpectrumPoint[];
  }>();

  // ── 第四轮 I：级联优先级继承 ──
  /** signalId → 有效 urgency（级联继承口径；配置 cascadePriority 时维护） */
  private effectiveUrgencyOf = new Map<string, number>();
  private cascadeInheritedCount = 0;
  private cascadeCappedCount = 0;
  private cascadeMaxGeneration = 0;

  // ── 第四轮 J：源质量反馈 ──
  private sourceQuality: {
    windowMs: number;
    smoothing: number;
    maxOutcomes: number;
    autoDiscount: boolean;
    minWeight: number;
    outcomes: Map<string, { ts: number[]; eff: boolean[] }>;
  } | undefined;

  // ── 第四轮 K：风暴预算共享 ──
  private sbIntensityPerSec: number | undefined;
  private sbBaselinePerSec: number | undefined;
  private sbLastArrivalAt: number | undefined;
  private sbActive = false;
  private sbLastAboveAt: number | undefined;
  private sbTightenings = 0;
  /** source → 收紧前原速率（解除时恢复） */
  private sbOriginalRates = new Map<string, number>();

  /**
   * @param config 哨兵配置
   * @param onBatch 批次交付回调（编排层入口）
   */
  constructor(config: SentinelConfig, onBatch: (batch: SignalBatch) => void) {
    this.config = config;
    this.onBatch = onBatch;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.clock = config.clock ?? Date.now;
    this.currentWindowMs = Math.max(0.1, config.aggregationWindow) * 1000;
    if (config.adaptiveWindow === false) {
      this.fixedWindowMode = true;
    } else if (config.adaptiveWindow) {
      const a = config.adaptiveWindow;
      this.adaptiveCfg = {
        intensityAlpha: a.intensityAlpha ?? 0.3,
        stormFactor: a.stormFactor ?? 3,
        minStormRatePerSec: a.minStormRatePerSec ?? 5,
        idleGapMs: a.idleGapMs,
        stormShrink: a.stormShrink ?? 0.125,
        idleShrink: a.idleShrink ?? 0.125,
        minWindowMs: a.minWindowMs ?? 50,
        approachFactor: a.approachFactor ?? 0.5,
        hawkesPollMs: a.hawkesPollMs ?? 1000,
      };
    }
  }

  /** clock 口径的当前时间 */
  private nowMs(): number {
    return this.clock();
  }

  /** 配置窗口（毫秒，下限 100ms——与既有口径一致） */
  private configuredWindowMs(): number {
    return Math.max(0.1, this.config.aggregationWindow) * 1000;
  }

  /**
   * 启动所有信号源
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    for (const source of this.config.signalSources ?? []) {
      try {
        if (source.type === 'webhook') this.startWebhook(source);
        else if (source.type === 'filesystem') this.startFileWatch(source);
        else if (source.type === 'polling') this.startPolling(source);
      } catch (err) {
        // 单个信号源失败不拖垮整体，仅记录
        this.ingest({
          type: 'sentinel-error',
          description: `信号源启动失败(${source.type}): ${(err as Error).message}`,
          payload: { source },
          source: 'sentinel',
        });
      }
    }

    // watchCodeChanges 且未显式配置 filesystem 源时，自动监听 watchDir
    if (this.config.watchCodeChanges && this.config.watchDir) {
      const hasFsSource = (this.config.signalSources ?? []).some((s) => s.type === 'filesystem');
      if (!hasFsSource) {
        this.startFileWatch({ type: 'filesystem', path: this.config.watchDir, signalType: 'code-change' });
      }
    }
  }

  /**
   * 停止所有信号源并清空待处理缓冲（不交付残余信号）
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const server of this.webhookServers) server.close();
    this.webhookServers = [];
    for (const watcher of this.fsWatchers) watcher.close();
    this.fsWatchers = [];
    for (const timer of this.pollTimers) clearInterval(timer);
    this.pollTimers = [];
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    this.windowDeadline = undefined;
    if (this.fsDebounceTimer) {
      clearTimeout(this.fsDebounceTimer);
      this.fsDebounceTimer = null;
    }
    this.pending = [];
    this.dedupeIndex.clear();
    this.fsPendingPaths.clear();
  }

  /**
   * 注入一个信号（手动 / webhook / 文件监听 / 轮询 / 级联统一入口）
   * @param partial 信号字段（id / receivedAt / occurrences 自动补齐）
   * @returns 归一化后的 Signal（被窗口内去重/近重复合并时返回已存在的信号；
   *          被背压令牌桶拒绝时返回带 overflowed 标记的本信号）
   */
  ingest(partial: Omit<Signal, 'id' | 'receivedAt' | 'occurrences'> & Partial<Signal>): Signal {
    const now = this.nowMs();
    const signal: Signal = {
      id: partial.id ?? `sig-${now}-${crypto.randomBytes(3).toString('hex')}`,
      type: partial.type,
      description: partial.description,
      payload: partial.payload ?? {},
      urgency: partial.urgency,
      receivedAt: partial.receivedAt ?? now,
      source: partial.source ?? 'manual',
      dedupeKey: partial.dedupeKey,
      occurrences: 1,
      tenantId: partial.tenantId,
      deadlineMs: partial.deadlineMs,
      parentId: partial.parentId,
    };
    this.totalIngested += 1;

    // ── 第三轮 C：入口背压（每源令牌桶）——超限进入溢出计数而非静默丢弃 ──
    // 注意：溢出信号不进入聚合 / 富化 / 监视器（下游受背压保护），
    // 溢出率经 backpressureView() 单独暴露（风暴的可观测出口）。
    if (!this.admit(signal)) {
      signal.overflowed = true;
      return signal;
    }

    // ── 第三轮 D：溯源链解析（环检测 + 链深封顶，总是开启——纯记账零漂移） ──
    this.resolveProvenance(signal);

    // ── 第四轮 I：级联优先级继承（配置时；先定内在优先级）──
    if (this.config.cascadePriority) this.applyCascadePriority(signal);
    // ── 第四轮 J：源质量打折（挂载且 autoDiscount 时；内在优先级 × 源信任度）──
    if (this.sourceQuality?.autoDiscount) this.applySourceQualityDiscount(signal);

    // ── 第三轮 F：指纹统计（挂载时观测已接纳到达） ──
    this.observeFingerprint(signal);

    // ── 第四轮 G/H：多源同期性 / 周期画像观测（配置时；admitted 口径）──
    this.observeCommonCause(signal);
    this.observePeriodicity(signal);

    // ── 第四轮 H：漏报扫描（emitMissSignals 开启时；置于信号入账后、去重判定前，
    //    期间的嵌套注入看到一致的统计状态；nextMissReportAt 前移保证递归有界）──
    if (this.config.periodicity?.emitMissSignals) this.scanPeriodicityMisses(signal.receivedAt);

    // ── 感知深度优化：富化上下文（速率 / 突发 / 关联 + 第三轮 A 三态/强度） ──
    const enrichment = this.enrich(signal, now);
    signal.enrichment = enrichment;

    // 记录近期信号（关联分析用，保留 50 条）
    this.recentSignals.push({ id: signal.id, type: signal.type, receivedAt: signal.receivedAt });
    if (this.recentSignals.length > 50) {
      this.recentSignals.splice(0, this.recentSignals.length - 50);
    }
    // 55.0：到达时间戳喂入 Hawkes 爆发监视（未挂载零介入——只读观测，
    // 不改变聚合/去重/交付任何路径）
    this.hawkesMonitor?.observe(signal.receivedAt / 1000);
    // 76.0：信号特征喂入新奇监视（未挂载零介入——「异常 = 没见过」的双证据口径）
    this.noveltyMonitor?.observe({
      type: signal.type,
      urgency: typeof signal.urgency === 'number' ? signal.urgency : 0.5,
      descriptionLength: signal.description.length,
      occurrences: signal.occurrences,
    });
    // 80.0：信号键喂入流式概要缓冲（未挂载零介入——键频/滑窗计数/样本概要）
    this.sketchBuffer?.observe(signal.type);

    // 窗口内去重合并（第三轮 B：衰减开启时合并取峰值而非首见覆盖）
    const key = signal.dedupeKey ?? `${signal.type}:${signal.description}`;
    const existing = this.dedupeIndex.get(key);
    if (existing) {
      this.mergeInto(existing, signal, enrichment, now);
      return existing;
    }

    // ── 第三轮 E：近重复去重（配置比较器时在最近 pending 中找近重复） ──
    const near = this.findNearDuplicate(signal);
    if (near) {
      this.mergeInto(near, signal, enrichment, now);
      this.nearDuplicateMerges += 1;
      return near;
    }

    this.pending.push(signal);
    this.dedupeIndex.set(key, signal);
    this.ensureWindowTimer();

    const maxBatchSize = this.config.maxBatchSize ?? 10;
    if (this.pending.length >= maxBatchSize) {
      this.flush('max-size');
    }
    return signal;
  }

  /** 紧急度衰减半衰期（未配置 / 非法时 undefined = 不衰减——旧行为） */
  private urgencyHalfLife(): number | undefined {
    const hl = this.config.urgencyHalfLifeMs;
    return hl !== undefined && Number.isFinite(hl) && hl > 0 ? hl : undefined;
  }

  /**
   * 窗口内合并（精确去重与近重复共用）：
   * - 缺省：仅计数与载荷合并（urgency 保持首见值——既有行为逐位不变）
   * - urgencyHalfLifeMs 配置：urgency 取峰值（衰减排序的合并口径）+ 保留更长溯源链
   */
  private mergeInto(existing: Signal, incoming: Signal, enrichment: SignalEnrichment, now: number): void {
    existing.occurrences += 1;
    if (this.urgencyHalfLife() !== undefined) {
      existing.urgency = Math.max(existing.urgency ?? 0.5, incoming.urgency ?? 0.5);
    }
    existing.payload = { ...existing.payload, lastMergedAt: now, mergedCount: existing.occurrences };
    existing.enrichment = enrichment;
    if ((incoming.provenanceDepth ?? 0) > (existing.provenanceDepth ?? 0)) {
      existing.provenanceDepth = incoming.provenanceDepth;
    }
  }

  /**
   * 第三轮 E：近重复扫描（配置 nearDuplicate 时；精确键未命中后调用）。
   * 仅同类型信号间比较，最多回扫 maxCandidates 条 pending（新鲜优先）。
   */
  private findNearDuplicate(signal: Signal): Signal | undefined {
    const nd = this.config.nearDuplicate;
    if (!nd) return undefined;
    const maxCandidates = nd.maxCandidates ?? 16;
    let compared = 0;
    for (let i = this.pending.length - 1; i >= 0 && compared < maxCandidates; i -= 1) {
      const candidate = this.pending[i]!;
      if (candidate.type !== signal.type) continue;
      compared += 1;
      if (nd.similarity(signal, candidate) >= nd.threshold) return candidate;
    }
    return undefined;
  }

  /**
   * 第三轮 C：令牌桶准入（配置 backpressure 时）。
   * 懒补充：以本信号 receivedAt 为时间轴（验证可注入确定性时间戳），
   * 补充量 = Δt × ratePerSec（Δt < 0 视为 0——乱序到达不奖励）。
   */
  private admit(signal: Signal): boolean {
    // ── 第四轮 K：风暴预算（全局强度跟踪 + 风暴期各桶联动收紧；时间轴 = receivedAt）──
    if (this.config.stormBudget) this.updateStormBudget(signal.receivedAt);
    const bp = this.config.backpressure;
    if (!bp) return true;
    const spec = bp.sources?.[signal.source] ?? bp.default;
    if (!spec || !(spec.ratePerSec > 0)) return true;
    let bucket = this.buckets.get(signal.source);
    if (!bucket) {
      // 风暴激活期新建的桶直接按收紧速率入册（原速率留档备恢复）
      const rate = this.sbActive ? spec.ratePerSec * this.stormTightenFactor() : spec.ratePerSec;
      if (this.sbActive) this.sbOriginalRates.set(signal.source, spec.ratePerSec);
      const burst = Math.max(1, spec.burst ?? Math.round(spec.ratePerSec));
      bucket = { ratePerSec: rate, burst, tokens: burst, lastRefillAt: signal.receivedAt, admitted: 0, overflowed: 0 };
      this.buckets.set(signal.source, bucket);
    } else {
      const dt = Math.max(0, signal.receivedAt - bucket.lastRefillAt);
      if (dt > 0) {
        bucket.tokens = Math.min(bucket.burst, bucket.tokens + (dt / 1000) * bucket.ratePerSec);
        bucket.lastRefillAt = signal.receivedAt;
      }
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      bucket.admitted += 1;
      return true;
    }
    bucket.overflowed += 1;
    return false;
  }

  /** 第三轮 C：背压总览（未配置时 undefined——诚实降级） */
  backpressureView(): BackpressureView | undefined {
    if (!this.config.backpressure) return undefined;
    const bySource: BackpressureSourceView[] = [...this.buckets.entries()].map(([source, b]) => {
      const total = b.admitted + b.overflowed;
      return {
        source,
        ratePerSec: b.ratePerSec,
        burst: b.burst,
        tokens: Math.floor(b.tokens * 1000) / 1000,
        admitted: b.admitted,
        overflowed: b.overflowed,
        overflowRate: total === 0 ? 0 : b.overflowed / total,
      };
    });
    const totalAdmitted = bySource.reduce((s, v) => s + v.admitted, 0);
    const totalOverflowed = bySource.reduce((s, v) => s + v.overflowed, 0);
    const total = totalAdmitted + totalOverflowed;
    return { configured: true, bySource, totalAdmitted, totalOverflowed, overflowRate: total === 0 ? 0 : totalOverflowed / total };
  }

  /**
   * 第三轮 D：溯源链解析——parentOf/depthOf 注册表上溯做环检测
   * （遇本信号 id 即环 → 切断父链按根处理并计数），链深超上限封顶计数。
   * 未知父（不在注册表，如外部级联根）按深度 0 的父处理。
   */
  private resolveProvenance(signal: Signal): void {
    const parentId = signal.parentId;
    if (parentId === undefined || parentId === signal.id) {
      if (parentId !== undefined) {
        this.provenanceCycles += 1;
        signal.parentId = undefined; // 自环切断：按根处理
      }
      signal.provenanceDepth = 0;
      this.registerProvenance(signal, undefined);
      return;
    }
    // 环检测：沿注册表从父上溯，路径回到本信号 id 即成环
    let cursor: string | undefined = parentId;
    const visited = new Set<string>();
    let cyclic = false;
    while (cursor !== undefined && !visited.has(cursor)) {
      if (cursor === signal.id) {
        cyclic = true;
        break;
      }
      visited.add(cursor);
      cursor = this.parentOf.get(cursor);
    }
    if (cyclic) {
      this.provenanceCycles += 1;
      signal.parentId = undefined;
      signal.provenanceDepth = 0;
      this.registerProvenance(signal, undefined);
      return;
    }
    let depth = (this.depthOf.get(parentId) ?? 0) + 1;
    if (depth > PROVENANCE_MAX_DEPTH) {
      this.provenanceTruncations += 1;
      depth = PROVENANCE_MAX_DEPTH;
    }
    signal.provenanceDepth = depth;
    this.registerProvenance(signal, parentId);
  }

  /** 溯源注册（容量上限 FIFO 淘汰）+ 链深极值记账 */
  private registerProvenance(signal: Signal, parentId: string | undefined): void {
    if (parentId !== undefined) this.parentOf.set(signal.id, parentId);
    this.depthOf.set(signal.id, signal.provenanceDepth ?? 0);
    if (this.parentOf.size > PROVENANCE_REGISTRY_CAP) {
      const oldest = this.parentOf.keys().next().value;
      if (oldest !== undefined) this.parentOf.delete(oldest);
    }
    if (this.depthOf.size > PROVENANCE_REGISTRY_CAP) {
      const oldest = this.depthOf.keys().next().value;
      if (oldest !== undefined) this.depthOf.delete(oldest);
    }
    const depth = signal.provenanceDepth ?? 0;
    if (depth > this.maxProvenanceDepthObserved) this.maxProvenanceDepthObserved = depth;
    if (depth > this.windowMaxProvenanceDepth) this.windowMaxProvenanceDepth = depth;
  }

  /** 第三轮 F：指纹观测（挂载追踪器时；事件驱动滚动窗） */
  private observeFingerprint(signal: Signal): void {
    const tracker = this.fingerprintTracker;
    if (!tracker) return;
    const fingerprint = fnv1a32hex(signal.dedupeKey ?? `${signal.type}:${signal.description}`);
    const key = `${signal.source}|${signal.type}|${fingerprint}`;
    const t = signal.receivedAt;
    let stat = tracker.stats.get(key);
    if (!stat) {
      if (tracker.stats.size >= tracker.maxKeys) {
        const oldest = tracker.stats.keys().next().value;
        if (oldest !== undefined) tracker.stats.delete(oldest);
      }
      stat = { source: signal.source, type: signal.type, fingerprint, count: 0, meanIntervalMs: 0, firstSeenAt: t, lastSeenAt: t, windowTs: [] };
      tracker.stats.set(key, stat);
    } else {
      // LRU 刷新（重置插入序）
      tracker.stats.delete(key);
      tracker.stats.set(key, stat);
    }
    const interval = t - stat.lastSeenAt;
    if (stat.count > 0 && interval > 0) {
      stat.meanIntervalMs = stat.meanIntervalMs === 0 ? interval : stat.meanIntervalMs * 0.8 + interval * 0.2;
    }
    stat.count += 1;
    stat.lastSeenAt = Math.max(stat.lastSeenAt, t);
    stat.windowTs.push(t);
    const cutoff = t - tracker.windowMs;
    while (stat.windowTs.length > 0 && (stat.windowTs[0]! < cutoff || stat.windowTs.length > tracker.perKeyWindow)) {
      stat.windowTs.shift();
    }
  }

  /**
   * 信号富化：到达速率统计 + 突发检测 + 关联分析 + 自适应窗口调整
   * @param signal 待富化信号
   * @param now 本轮 ingest 的 clock 时间（与 receivedAt 缺省同源）
   */
  private enrich(signal: Signal, now: number): SignalEnrichment {
    // 到达历史维护（保留最近 5 分钟）
    const history = this.arrivalHistory.get(signal.type) ?? [];
    history.push(now);
    const cutoff = now - 5 * 60_000;
    while (history.length > 0 && history[0] < cutoff) history.shift();
    this.arrivalHistory.set(signal.type, history);

    // 最近 1 分钟速率
    const recentWindow = now - 60_000;
    const recentRatePerMin = history.filter((t) => t >= recentWindow).length;

    // 历史总次数
    const historicalCount = (this.historicalCounts.get(signal.type) ?? 0) + 1;
    this.historicalCounts.set(signal.type, historicalCount);

    // 速率基线（指数移动平均，α=0.1 慢速跟踪，避免基线追平速率导致突发永不触发）
    // 关键：突发检测必须对比"纳入本信号前的基线"，否则基线先被当前速率污染
    const hasBaseline = this.rateBaseline.has(signal.type);
    const prevBaseline = this.rateBaseline.get(signal.type) ?? 0;

    // 突发检测：速率超过前一基线 3 倍且绝对值 ≥ 3
    const isBurst = hasBaseline && recentRatePerMin >= 3 && recentRatePerMin > prevBaseline * 3;
    if (isBurst) this.burstCount += 1;

    // 基线更新：首次观测建立基线；突发期间冻结基线（保持其代表平稳期水平）
    if (!hasBaseline) {
      this.rateBaseline.set(signal.type, recentRatePerMin);
    } else if (!isBurst) {
      this.rateBaseline.set(signal.type, prevBaseline * 0.9 + recentRatePerMin * 0.1);
    }

    // 自适应窗口：v2 强度三态（配置时）或 v1 突发收缩（缺省——原行为）；false = 固定窗口
    if (this.adaptiveCfg) {
      this.updateLoadState(signal);
    } else if (!this.fixedWindowMode) {
      this.adaptWindow(isBurst);
    }

    // 关联分析：最近 30s 内注入的异类型信号（无需等待批次交付）
    const correlatedSignalIds = this.recentSignals
      .filter((s) => s.id !== signal.id && now - s.receivedAt < 30_000 && s.type !== signal.type)
      .slice(-5)
      .map((s) => s.id);

    return {
      recentRatePerMin,
      historicalCount,
      isBurst,
      correlatedSignalIds,
      effectiveWindowMs: this.currentWindowMs,
      ...(this.adaptiveCfg ? { loadState: this.loadState, intensityPerSec: this.intensityPerSec } : {}),
    };
  }

  /**
   * 第三轮 A：负载三态判定 + 窗口目标靠拢（adaptiveWindow v2 配置时）。
   * 时间轴取 signal.receivedAt（到达语义；验证可注入确定性时间戳）。
   */
  private updateLoadState(signal: Signal): void {
    const cfg = this.adaptiveCfg!;
    const t = signal.receivedAt;
    const prevArrival = this.lastArrivalAt;

    // 强度估计 λ̂：瞬时速率 1000/Δt 的 EWMA（Δt 下限 1ms 防同毫秒到达爆Inf）
    if (prevArrival !== undefined && t > prevArrival) {
      const dtMs = Math.max(1, t - prevArrival);
      const instantaneous = 1000 / dtMs;
      this.intensityPerSec =
        this.intensityPerSec === undefined
          ? instantaneous
          : cfg.intensityAlpha * instantaneous + (1 - cfg.intensityAlpha) * this.intensityPerSec;
    }
    this.lastArrivalAt = prevArrival === undefined ? t : Math.max(prevArrival, t);

    const configuredMs = this.configuredWindowMs();
    const idleGapMs = cfg.idleGapMs ?? Math.max(3 * configuredMs, 1000);
    const isIdle = prevArrival !== undefined && t - prevArrival >= idleGapMs;

    let isStorm = false;
    if (!isIdle && this.intensityPerSec !== undefined && this.baselinePerSec !== undefined) {
      isStorm = this.intensityPerSec >= Math.max(cfg.minStormRatePerSec, this.baselinePerSec * cfg.stormFactor);
    }
    // 55.0 Hawkes 只读第二证据（挂载且轮询到期才拟合——限频防 O(n·iters) 内爆；
    // 纯观测调用，不改变 Hawkes 监视器任何状态）
    if (!isIdle && this.hawkesMonitor !== undefined && t - this.lastHawkesPollAt >= cfg.hawkesPollMs) {
      this.lastHawkesPollAt = t;
      const hawkes = this.hawkesMonitor.view();
      if (hawkes !== undefined && hawkes.burst) isStorm = true;
    }
    this.loadState = isIdle ? 'idle' : isStorm ? 'storm' : 'normal';

    // 平稳基线：仅 normal 慢速跟踪（β=0.05）；storm/idle 冻结——基线始终代表平稳期
    if (this.loadState === 'normal' && this.intensityPerSec !== undefined) {
      this.baselinePerSec =
        this.baselinePerSec === undefined ? this.intensityPerSec : this.baselinePerSec * 0.95 + this.intensityPerSec * 0.05;
    }

    // 窗口目标与靠拢（idle 立即收缩——孤立信号无聚合收益可损失）
    const wMin = cfg.minWindowMs;
    const target =
      this.loadState === 'storm'
        ? Math.max(wMin, Math.round(configuredMs * cfg.stormShrink))
        : this.loadState === 'idle'
          ? Math.max(wMin, Math.round(configuredMs * cfg.idleShrink))
          : configuredMs;
    const oldWindow = this.currentWindowMs;
    const next =
      this.loadState === 'idle'
        ? Math.min(oldWindow, target)
        : Math.round(oldWindow + (target - oldWindow) * cfg.approachFactor);
    this.currentWindowMs = Math.max(wMin, Math.min(configuredMs, next));
    // 开窗中途收缩 → 剩余时间按收缩比例重排定时器（风暴快速排空的关键路径）
    if (this.currentWindowMs < oldWindow) this.rearmOpenWindow(t, oldWindow);
  }

  /** 当前三态（v2 模式 getStatus 口径：无到达期可实时判 idle） */
  private loadStateNow(): SentinelLoadState {
    if (this.lastArrivalAt !== undefined && this.adaptiveCfg) {
      const idleGapMs = this.adaptiveCfg.idleGapMs ?? Math.max(3 * this.configuredWindowMs(), 1000);
      if (this.nowMs() - this.lastArrivalAt >= idleGapMs) return 'idle';
    }
    return this.loadState;
  }

  /** 开窗中途窗口收缩：剩余时长按新旧窗口比例缩放重排（下限收缩后窗口本身） */
  private rearmOpenWindow(now: number, oldWindowMs: number): void {
    if (!this.windowTimer || this.windowDeadline === undefined) return;
    const remaining = this.windowDeadline - now;
    if (remaining <= 0) return;
    const scaled = Math.max(this.currentWindowMs, Math.round((remaining * this.currentWindowMs) / oldWindowMs));
    if (scaled >= remaining) return;
    clearTimeout(this.windowTimer);
    this.windowDeadline = now + scaled;
    this.windowTimer = setTimeout(() => {
      this.windowTimer = null;
      this.windowDeadline = undefined;
      this.flush('window');
    }, scaled);
    this.windowTimer.unref?.();
  }

  /** 自适应窗口调整（v1 既有行为——缺省模式逐位保留）：突发 → 缩短至 1/4（下限 50ms）；平稳 → 逐步恢复配置值 */
  private adaptWindow(isBurst: boolean): void {
    const configuredMs = Math.max(0.1, this.config.aggregationWindow) * 1000;
    if (isBurst) {
      this.currentWindowMs = Math.max(50, Math.floor(this.currentWindowMs / 4));
    } else if (this.currentWindowMs < configuredMs) {
      // 平稳期每次向配置值靠拢 25%
      this.currentWindowMs = Math.min(configuredMs, Math.ceil(this.currentWindowMs * 1.25));
    }
  }

  /**
   * 立即交付当前待处理批次（无待处理信号时为空操作）
   * @param reason 交付原因标记
   */
  flush(reason: SignalBatch['reason'] = 'flush'): void {
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    this.windowDeadline = undefined;
    if (this.pending.length === 0) {
      this.windowMaxProvenanceDepth = 0;
      return;
    }

    const now = this.nowMs();
    let signals = this.pending;
    // ── 第三轮 B：紧急度衰减（urgencyHalfLifeMs 配置时）──
    // decayedUrgency = urgency × 0.5^(年龄/半衰期)；批次按其降序交付
    // （新鲜度进入排序口径；缺省不衰减、保持到达序——旧行为）。
    const halfLife = this.urgencyHalfLife();
    if (halfLife !== undefined) {
      signals = signals
        .map((s) => {
          const age = Math.max(0, now - s.receivedAt);
          const base = clamp01(Number.isFinite(s.urgency as number) ? (s.urgency ?? 0.5) : 0.5);
          return { ...s, decayedUrgency: base * Math.pow(0.5, age / halfLife) };
        })
        .sort((a, b) => (b.decayedUrgency ?? 0) - (a.decayedUrgency ?? 0));
    }

    const batch: SignalBatch = {
      signals,
      aggregatedAt: now,
      reason,
      ...(this.windowMaxProvenanceDepth > 0 ? { maxProvenanceDepth: this.windowMaxProvenanceDepth } : {}),
    };
    this.pending = [];
    this.dedupeIndex.clear();
    this.windowMaxProvenanceDepth = 0;
    this.totalBatches += 1;

    try {
      this.onBatch(batch);
    } catch {
      // 编排层异常不影响哨兵存活
    }
  }

  /** 当前待处理信号（只读快照） */
  getPendingSignals(): Signal[] {
    return [...this.pending];
  }

  /**
   * 哨兵运行状态（manage_consensus / model_dashboard 等 Tool 可引用）
   */
  getStatus(): SentinelStatus {
    const sources: SentinelStatus['sources'] = [];
    for (const server of this.webhookServers) {
      const addr = server.address();
      sources.push({ type: 'webhook', detail: `port:${typeof addr === 'object' && addr ? addr.port : '?'}`, active: true });
    }
    for (const source of this.config.signalSources ?? []) {
      if (source.type === 'filesystem') sources.push({ type: 'filesystem', detail: source.path ?? '', active: true });
      if (source.type === 'polling') sources.push({ type: 'polling', detail: source.url ?? '', active: true });
    }
    const backpressure = this.backpressureView();
    return {
      running: this.running,
      pendingSignals: this.pending.length,
      totalIngested: this.totalIngested,
      totalBatches: this.totalBatches,
      sources,
      aggregationWindow: this.config.aggregationWindow,
      effectiveWindowMs: this.currentWindowMs,
      burstCount: this.burstCount,
      historicalCounts: Object.fromEntries(this.historicalCounts),
      ...(this.adaptiveCfg
        ? { loadState: this.loadStateNow(), intensityPerSec: this.intensityPerSec }
        : {}),
      maxProvenanceDepth: this.maxProvenanceDepthObserved,
      provenanceCycles: this.provenanceCycles,
      provenanceTruncations: this.provenanceTruncations,
      nearDuplicateMerges: this.nearDuplicateMerges,
      ...(backpressure !== undefined ? { backpressure } : {}),
    };
  }

  /** 第三轮 F：挂载指纹追踪（幂等覆盖，挂载即生效——只读统计口径，零漂移） */
  attachFingerprintTracker(options?: FingerprintTrackerOptions): void {
    this.fingerprintTracker = {
      windowMs: options?.windowMs ?? 600_000,
      maxKeys: options?.maxKeys ?? 512,
      perKeyWindow: options?.perKeyWindow ?? 64,
      stats: new Map(),
    };
  }

  /**
   * 第三轮 F：指纹滚动统计（源 × 类型 × 指纹，按总次数降序；
   * 未挂载时 undefined——诚实降级）。76.0 新奇检测可用 count /
   * meanIntervalMs 作「没见过 / 罕见」的先验证据源。
   */
  fingerprintStats(): FingerprintStat[] | undefined {
    if (!this.fingerprintTracker) return undefined;
    return [...this.fingerprintTracker.stats.values()]
      .map(({ windowTs, ...rest }) => ({ ...rest, windowCount: windowTs.length }))
      .sort((a, b) => b.count - a.count);
  }

  // ─────────────────── 第四轮 R4 实现 ───────────────────

  /** 第四轮 G：到达入账 + 限频评估（配置 commonCause 时） */
  private observeCommonCause(signal: Signal): void {
    const cfg = this.config.commonCause;
    if (!cfg) return;
    const cap = cfg.maxArrivalsPerSource ?? 4096;
    let buf = this.ccArrivals.get(signal.source);
    if (!buf) {
      buf = [];
      this.ccArrivals.set(signal.source, buf);
    }
    buf.push(signal.receivedAt);
    if (buf.length > cap) buf.splice(0, buf.length - cap);
    if (this.ccLastEvalAt === undefined || signal.receivedAt - this.ccLastEvalAt >= (cfg.evaluateEveryMs ?? 100)) {
      this.evaluateCommonCause(signal.receivedAt, signal.source);
    }
  }

  /**
   * 第四轮 G：多源同期性评估（时间轴 = 到达时刻 t，滚动窗 [t − windowMs, t]）。
   *
   * 判别口径：
   * - 单源风暴 ⟺ 窗内速率 ≥ max(minBurstRatePerSec, 平稳基线 × burstFactor)
   *   且窗内到达数 ≥ minWindowArrivals（基线风暴期冻结）
   * - 两两同期性 = 观测巧合对数 / 独立期望。期望 = 2×tol秒×rate_b×N_a
   *   （独立点过程下 a 的每个到达落入 b 的 ±tol 窗的概率 = 2×tol×rate_b）；
   *   共因根因（同一事件扇出到多源）→ 几乎每个到达都有巧合伙伴 → lift ≫ 1；
   *   各自独立风暴 → 巧合率回到随机水平 → lift ≈ 1
   * - 聚类：风暴源两两 lift ≥ minLift 连边，连通分量 ≥ minSources 判共因组；
   *   无连边的风暴源（或分量不足）判独立
   */
  private evaluateCommonCause(t: number, triggerSource: string): void {
    const cfg = this.config.commonCause!;
    const windowMs = cfg.windowMs ?? 10_000;
    const tolMs = cfg.coincidenceMs ?? 50;
    const burstFactor = cfg.burstFactor ?? 3;
    const minBurstRate = cfg.minBurstRatePerSec ?? 1;
    const minArrivals = cfg.minWindowArrivals ?? 3;
    const minLift = cfg.minLift ?? 2.5;
    const minSources = cfg.minSources ?? 2;
    const baselineAlpha = cfg.baselineAlpha ?? 0.02;
    this.ccLastEvalAt = t;
    const start = t - windowMs;

    const info: Array<{ source: string; arrivals: number[]; ratePerSec: number; baseline?: number; burst: boolean; wouldStorm: boolean }> = [];
    for (const [source, buf] of this.ccArrivals) {
      const arrivals = buf.filter((x) => x >= start).sort((a, b) => a - b);
      const ratePerSec = arrivals.length / (windowMs / 1000);
      const baseline = this.ccBaselines.get(source);
      const wouldStorm = baseline !== undefined && ratePerSec >= Math.max(minBurstRate, baseline * burstFactor);
      const burst = wouldStorm && arrivals.length >= minArrivals;
      info.push({ source, arrivals, ratePerSec, baseline, burst, wouldStorm });
    }
    // 基线更新：仅该源自身到达触发的本评估更新（事件驱动口径——防多源合流
    // 评估把追赶频率放大导致基线吞掉风暴速率）；风暴态（含未达最少到达数的
    // 准风暴）冻结——基线始终代表平稳期
    for (const e of info) {
      if (!e.wouldStorm && e.source === triggerSource) {
        this.ccBaselines.set(
          e.source,
          e.baseline === undefined ? e.ratePerSec : e.baseline * (1 - baselineAlpha) + e.ratePerSec * baselineAlpha,
        );
      }
    }

    // 风暴源两两巧合提升
    const bursting = info.filter((e) => e.burst);
    const pairLifts: CommonCausePairLift[] = [];
    for (let i = 0; i < bursting.length; i += 1) {
      for (let j = i + 1; j < bursting.length; j += 1) {
        const A = bursting[i]!;
        const B = bursting[j]!;
        const observedPairs = countCoincidentPairs(A.arrivals, B.arrivals, tolMs);
        const expectedPairs = 2 * (tolMs / 1000) * B.ratePerSec * A.arrivals.length;
        pairLifts.push({ a: A.source, b: B.source, observedPairs, expectedPairs, lift: observedPairs / Math.max(expectedPairs, 0.5) });
      }
    }

    const groups = clusterByEdges(bursting.map((e) => e.source), pairLifts, minLift);
    const groupViews: CommonCauseGroupView[] = groups.map((sources) => {
      const lifts = pairLifts.filter((p) => sources.includes(p.a) && sources.includes(p.b));
      const common = sources.length >= minSources;
      const groupLift = common
        ? lifts.length > 0
          ? Math.min(...lifts.map((p) => p.lift))
          : Number.POSITIVE_INFINITY
        : lifts.length > 0
          ? Math.max(...lifts.map((p) => p.lift))
          : 0;
      return { sources, classification: common ? 'common-cause' : 'independent', groupLift, pairLifts: lifts };
    });

    // 事件转变沿：共因分组键出现即记事件；独立风暴（无共因组时 ≥minSources 个风暴源）同口径
    const commonGroups = groupViews.filter((g) => g.classification === 'common-cause');
    const commonKey = commonGroups.map((g) => g.sources.join('+')).sort().join(';') || undefined;
    const indepSources = groupViews.filter((g) => g.classification === 'independent').flatMap((g) => g.sources);
    const indepKey = commonKey === undefined && indepSources.length >= minSources ? indepSources.slice().sort().join('+') : undefined;
    if (commonKey !== undefined && commonKey !== this.ccActiveCommonKey) {
      this.ccCommonCauseEvents += 1;
      for (const g of commonGroups) {
        this.ccEvents.push({ detectedAt: t, kind: 'common-cause', sources: g.sources.slice(), groupLift: g.groupLift });
      }
    }
    this.ccActiveCommonKey = commonKey;
    if (indepKey !== undefined && indepKey !== this.ccActiveIndependentKey) {
      this.ccIndependentStormEvents += 1;
      this.ccEvents.push({ detectedAt: t, kind: 'independent', sources: indepSources.slice().sort(), groupLift: 0 });
    }
    this.ccActiveIndependentKey = indepKey;
    if (this.ccEvents.length > 32) this.ccEvents.splice(0, this.ccEvents.length - 32);

    this.ccLastGroups = groupViews;
    this.ccLastPairLifts = pairLifts;
    this.ccLastBurst = info.map((e) => ({
      source: e.source,
      ratePerSec: e.ratePerSec,
      baselinePerSec: e.baseline ?? 0,
      arrivals: e.arrivals.length,
      burst: e.burst,
    }));
  }

  /** 第四轮 G：共因爆发读数（未配置时 undefined——诚实降级） */
  commonCauseView(): CommonCauseView | undefined {
    if (!this.config.commonCause) return undefined;
    return {
      evaluatedAt: this.ccLastEvalAt ?? 0,
      windowMs: this.config.commonCause.windowMs ?? 10_000,
      burstSources: this.ccLastBurst,
      groups: this.ccLastGroups,
      pairLifts: this.ccLastPairLifts,
      events: this.ccEvents.slice(),
      commonCauseEvents: this.ccCommonCauseEvents,
      independentStormEvents: this.ccIndependentStormEvents,
    };
  }

  /** 第四轮 H：到达入账 + 偏差记账 + 节拍重评（配置 periodicity 时） */
  private observePeriodicity(signal: Signal): void {
    const cfg = this.config.periodicity;
    if (!cfg) return;
    const source = signal.source;
    const cap = cfg.maxArrivalsPerSource ?? 512;
    let buf = this.periodicArrivals.get(source);
    if (!buf) {
      buf = [];
      this.periodicArrivals.set(source, buf);
    }
    buf.push(signal.receivedAt);
    if (buf.length > cap) buf.splice(0, buf.length - cap);
    let model = this.periodicModel.get(source);
    if (!model) {
      model = { periodMs: 0, strength: 0, deviations: 0, misses: 0, spectrum: [] };
      this.periodicModel.set(source, model);
    }

    const t = signal.receivedAt;
    if (model.periodMs > 0 && model.lastArrivalAt !== undefined) {
      // 偏差记账：期望 = 上次到达 + 周期（负 = 早到，正 = 晚到）
      const expected = model.lastArrivalAt + model.periodMs;
      model.lastDeviationCycles = (t - expected) / model.periodMs;
      model.lastExpectedAt = expected;
      if (Math.abs(model.lastDeviationCycles) > (cfg.deviationThreshold ?? 0.3)) model.deviations += 1;
      model.nextMissReportAt = undefined; // 到达即解除漏报报文抑制（重新起算）
    }
    model.lastArrivalAt = t;

    const minArrivals = cfg.minArrivals ?? 8;
    const every = cfg.reevaluateEvery ?? 16;
    if (buf.length === minArrivals || (buf.length > minArrivals && (buf.length - minArrivals) % every === 0)) {
      this.evaluatePeriodicity(source, buf, t);
    }
  }

  /**
   * 第四轮 H：自相关峰周期检测（点过程回报率谱，无随机源）。
   *
   * score(L) = #{i : ∃j, |t_j − (t_i + L)| ≤ tol(L)} / #{i : t_i + L + tol ≤ last}
   * （证据约束：只统计有完整后续观察的 i——避免尾部截断虚高）。
   * 基频优选：得分 ≥ max(minStrength, 0.85 × best) 的最小候选 L（谐波
   * 2L/3L 与基频同高分时取最小）；峰值 ±10% 局部细化；跨次评估 EWMA
   * 精化（|Δ| < 20% 平滑吸收抖动，≥ 20% 直接切换——周期漂移可跟随）。
   * 证据约束：候选 L 需 ≤ 观测跨度 / 3（窗内至少 3 个完整周期）。
   */
  private evaluatePeriodicity(source: string, buf: number[], t: number): void {
    const cfg = this.config.periodicity!;
    const ts = buf.slice().sort((a, b) => a - b);
    const minP = cfg.minPeriodMs ?? 1000;
    const maxP = cfg.maxPeriodMs ?? 300_000;
    const steps = Math.max(8, cfg.gridSteps ?? 96);
    const tolFloor = cfg.tolFloorMs ?? 50;
    const tolRatio = cfg.tolRatio ?? 0.05;
    const minStrength = cfg.minStrength ?? 0.6;
    const tolOf = (L: number): number => Math.max(tolFloor, tolRatio * L);
    const span = ts.length >= 2 ? t - ts[0]! : 0;

    const scoreAt = (L: number): number => {
      const tol = tolOf(L);
      let matched = 0;
      let evidence = 0;
      let j = 0;
      for (let i = 0; i < ts.length; i += 1) {
        const target = ts[i]! + L;
        if (target + tol > t) break;
        evidence += 1;
        while (j < ts.length && ts[j]! < target - tol) j += 1;
        if (j < ts.length && ts[j]! <= target + tol) matched += 1;
      }
      return evidence === 0 ? 0 : matched / evidence;
    };

    // 对数等距候选网格
    const candidates: number[] = [];
    if (maxP > minP) {
      const ratio = Math.pow(maxP / minP, 1 / steps);
      for (let v = minP; v <= maxP; v *= ratio) candidates.push(Math.round(v));
    } else {
      candidates.push(minP);
    }

    const scored: PeriodicitySpectrumPoint[] = [];
    let bestL = 0;
    let bestScore = 0;
    for (const L of candidates) {
      if (L * 3 > span) break;
      const s = scoreAt(L);
      scored.push({ periodMs: L, score: s });
      if (s > bestScore) {
        bestScore = s;
        bestL = L;
      }
    }

    let learned: { periodMs: number; strength: number } | undefined;
    if (bestL > 0 && bestScore >= minStrength) {
      // 基频优选：达标候选（≥ max(minStrength, 0.85 × best)）中的最小者
      const cutoff = Math.max(minStrength, bestScore * 0.85);
      let fundamental = bestL;
      for (const L of candidates) {
        if (L * 3 > span) break;
        if (scoreAt(L) >= cutoff) {
          fundamental = L;
          break;
        }
      }
      // 峰值局部细化（±10%，21 步线性扫描）
      let refined = fundamental;
      let refinedScore = scoreAt(fundamental);
      const lo = fundamental * 0.9;
      const hi = fundamental * 1.1;
      for (let k = 0; k <= 20; k += 1) {
        const L = Math.round(lo + ((hi - lo) * k) / 20);
        if (L <= 0) continue;
        const s = scoreAt(L);
        if (s > refinedScore) {
          refinedScore = s;
          refined = L;
        }
      }
      learned = { periodMs: refined, strength: refinedScore };
    }

    const model = this.periodicModel.get(source)!;
    model.spectrum = scored.sort((x, y) => y.score - x.score).slice(0, 5);
    if (learned) {
      model.strength = learned.strength;
      model.periodMs =
        model.periodMs > 0 && Math.abs(learned.periodMs - model.periodMs) / model.periodMs < 0.2
          ? model.periodMs * 0.7 + learned.periodMs * 0.3
          : learned.periodMs;
    } else if (model.periodMs > 0) {
      // 谱证据衰退（诚实口径：强度随证据衰减，跌破一半阈即解锁）
      model.strength *= 0.5;
      if (model.strength < minStrength * 0.5) model.periodMs = 0;
    }
  }

  /** 第四轮 H：漏报扫描（emitMissSignals 开启时；每错失一个期望周期注入一条 period-miss） */
  private scanPeriodicityMisses(t: number): void {
    const cfg = this.config.periodicity!;
    const missFactor = cfg.missFactor ?? 1.5;
    for (const [source, model] of this.periodicModel) {
      if (model.periodMs <= 0 || model.lastArrivalAt === undefined) continue;
      if (model.nextMissReportAt === undefined) model.nextMissReportAt = model.lastArrivalAt + model.periodMs * missFactor;
      if (t >= model.nextMissReportAt) {
        const cyclesSilent = (t - model.lastArrivalAt) / model.periodMs;
        const expectedAt = model.lastArrivalAt + model.periodMs;
        // 先推进漏报槽再注入（嵌套 ingest 会再次扫描——递归必须有界）
        const ordinal = model.misses + 1;
        model.misses += 1;
        model.nextMissReportAt += model.periodMs;
        this.ingest({
          type: 'period-miss',
          // 第 N 报入描述（漏报槽计数）——同槽去重合并、异槽各自成条
          description: `周期源漏报: ${source} 期望 ${expectedAt} 实际静默 ${cyclesSilent.toFixed(2)} 周期（第 ${ordinal} 报）`,
          payload: { target: source, expectedAt, periodMs: model.periodMs, cyclesSilent },
          source: 'sentinel-periodicity',
          urgency: clamp01(0.5 + 0.1 * Math.max(0, cyclesSilent - 1)),
          receivedAt: t,
        });
      }
    }
  }

  /** 第四轮 H：周期画像读数（未配置时 undefined；overdue 按当前 clock 实时判） */
  periodicityView(): PeriodicityView | undefined {
    if (!this.config.periodicity) return undefined;
    const cfg = this.config.periodicity;
    const missFactor = cfg.missFactor ?? 1.5;
    const now = this.nowMs();
    const sources: PeriodicitySourceView[] = [];
    for (const [source, model] of this.periodicModel) {
      const buf = this.periodicArrivals.get(source) ?? [];
      const locked = model.periodMs > 0;
      const overdueCycles =
        locked && model.lastArrivalAt !== undefined ? Math.max(0, (now - model.lastArrivalAt) / model.periodMs - 1) : 0;
      sources.push({
        source,
        arrivals: buf.length,
        status: !locked ? 'learning' : overdueCycles >= missFactor - 1 ? 'overdue' : 'locked',
        ...(locked
          ? {
              periodMs: model.periodMs,
              strength: model.strength,
              ...(buf.length > 0 ? { firstArrivalAt: buf[0] } : {}),
              lastArrivalAt: model.lastArrivalAt,
              expectedNextAt: model.lastArrivalAt! + model.periodMs,
              lastDeviationCycles: model.lastDeviationCycles,
            }
          : {}),
        overdueCycles,
        deviations: model.deviations,
        misses: model.misses,
        spectrum: model.spectrum.slice(),
      });
    }
    return { sources };
  }

  /**
   * 第四轮 I：级联优先级继承（配置时）。
   *
   * 有效 urgency 口径：根 = clamp01(urgency ?? 0.5)；子代 =
   * - 未自报：父代有效值 × inheritFactor（代际衰减）
   * - 自报：min(自报值, 父代有效值 × maxInherit)（放大封顶，超顶计数）
   * 下限 minUrgency。孙代 ≤ 祖代 × inheritFactor²——代际衰减上限，
   * 级联风暴无论多深都不放大。未知父（不在注册表）按根口径处理。
   */
  private applyCascadePriority(signal: Signal): void {
    const cfg = this.config.cascadePriority!;
    const inheritFactor = cfg.inheritFactor ?? 0.6;
    const maxInherit = cfg.maxInherit ?? 1.0;
    const minUrgency = cfg.minUrgency ?? 0.02;
    const parentId = signal.parentId;
    const depth = signal.provenanceDepth ?? 0;
    let effective: number;
    if (parentId !== undefined && depth >= 1) {
      const parentEffective = this.effectiveUrgencyOf.get(parentId) ?? clamp01(signal.urgency ?? 0.5);
      if (signal.urgency === undefined) {
        effective = parentEffective * inheritFactor;
        signal.inheritedUrgency = true;
        this.cascadeInheritedCount += 1;
      } else {
        const cap = parentEffective * maxInherit;
        effective = Math.min(clamp01(signal.urgency), cap);
        if (signal.urgency > cap) {
          signal.inheritedUrgency = true;
          this.cascadeCappedCount += 1;
          this.cascadeInheritedCount += 1;
        }
      }
      effective = Math.max(minUrgency, effective);
      signal.urgency = effective;
      if (depth > this.cascadeMaxGeneration) this.cascadeMaxGeneration = depth;
    } else {
      effective = clamp01(signal.urgency ?? 0.5);
    }
    this.effectiveUrgencyOf.set(signal.id, effective);
    if (this.effectiveUrgencyOf.size > PROVENANCE_REGISTRY_CAP) {
      const oldest = this.effectiveUrgencyOf.keys().next().value;
      if (oldest !== undefined) this.effectiveUrgencyOf.delete(oldest);
    }
  }

  /** 第四轮 I：级联优先级读数（未配置时 undefined） */
  cascadePriorityView(): CascadePriorityView | undefined {
    const cfg = this.config.cascadePriority;
    if (!cfg) return undefined;
    return {
      inherited: this.cascadeInheritedCount,
      capped: this.cascadeCappedCount,
      maxGeneration: this.cascadeMaxGeneration,
      inheritFactor: cfg.inheritFactor ?? 0.6,
      maxInherit: cfg.maxInherit ?? 1.0,
      minUrgency: cfg.minUrgency ?? 0.02,
    };
  }

  /** 第四轮 J：挂载源质量追踪（幂等覆盖；autoDiscount 缺省 false——纯读数零漂移） */
  attachSourceQuality(options?: SourceQualityOptions): void {
    this.sourceQuality = {
      windowMs: options?.windowMs ?? 3_600_000,
      smoothing: options?.smoothing ?? 1,
      maxOutcomes: options?.maxOutcomesPerSource ?? 1024,
      autoDiscount: options?.autoDiscount ?? false,
      minWeight: options?.minWeight ?? 0.3,
      outcomes: new Map(),
    };
  }

  /**
   * 第四轮 J：结局回填（信号 → 最终结局）。effective = 该信号催生了有效
   * 决策/行动；noise = 噪声/误报。atMs 缺省取 clock（验证可注入确定时刻）。
   * 未挂载时静默忽略（诚实降级——评分体系完全 opt-in）。
   */
  reportOutcome(source: string, outcome: 'effective' | 'noise', atMs?: number): void {
    const q = this.sourceQuality;
    if (!q) return;
    const t = atMs ?? this.nowMs();
    let ring = q.outcomes.get(source);
    if (!ring) {
      ring = { ts: [], eff: [] };
      q.outcomes.set(source, ring);
    }
    ring.ts.push(t);
    ring.eff.push(outcome === 'effective');
    const cutoff = t - q.windowMs;
    while (ring.ts.length > 0 && (ring.ts[0]! < cutoff || ring.ts.length > q.maxOutcomes)) {
      ring.ts.shift();
      ring.eff.shift();
    }
  }

  /** 打折权重 = minWeight + (1 − minWeight) × score（低质量打折但不抹杀） */
  private qualityWeightOf(score: number, minWeight: number): number {
    return minWeight + (1 - minWeight) * clamp01(score);
  }

  /** 第四轮 J：源质量读数（按评分降序；未挂载时 undefined） */
  sourceQualityView(): SourceQualityView[] | undefined {
    const q = this.sourceQuality;
    if (!q) return undefined;
    const now = this.nowMs();
    const cutoff = now - q.windowMs;
    const views: SourceQualityView[] = [];
    for (const [source, ring] of q.outcomes) {
      let effective = 0;
      let noise = 0;
      for (let i = 0; i < ring.ts.length; i += 1) {
        if (ring.ts[i]! < cutoff) continue;
        if (ring.eff[i]!) effective += 1;
        else noise += 1;
      }
      const total = effective + noise;
      const score = (effective + q.smoothing) / (total + 2 * q.smoothing);
      views.push({
        source,
        effective,
        noise,
        total,
        score,
        ...(q.autoDiscount ? { weight: this.qualityWeightOf(score, q.minWeight) } : {}),
      });
    }
    return views.sort((a, b) => b.score - a.score);
  }

  /**
   * 第四轮 J：urgency 打折（挂载 + autoDiscount 时）。
   * 因果口径：只统计早于本次到达的结局（未来结局不回溯污染）；无结局
   * 记录的源不打折（新源无罪推定）。打折后记录 qualityWeight 供审计。
   */
  private applySourceQualityDiscount(signal: Signal): void {
    const q = this.sourceQuality!;
    const ring = q.outcomes.get(signal.source);
    if (!ring) return;
    const cutoff = signal.receivedAt - q.windowMs;
    let effective = 0;
    let noise = 0;
    for (let i = 0; i < ring.ts.length; i += 1) {
      if (ring.ts[i]! > signal.receivedAt || ring.ts[i]! < cutoff) continue;
      if (ring.eff[i]!) effective += 1;
      else noise += 1;
    }
    if (effective + noise === 0) return;
    const score = (effective + q.smoothing) / (effective + noise + 2 * q.smoothing);
    const weight = this.qualityWeightOf(score, q.minWeight);
    signal.qualityWeight = weight;
    signal.urgency = clamp01((signal.urgency ?? 0.5) * weight);
  }

  /** 风暴收紧系数（clamp 到 (0,1]） */
  private stormTightenFactor(): number {
    const f = this.config.stormBudget?.tightenFactor ?? 0.5;
    return f > 0 && f <= 1 ? f : Math.min(Math.max(f, 0.05), 1);
  }

  /** 第四轮 K：风暴期收紧——现存全部桶速率 × tightenFactor（原速率留档） */
  private applyStormTightening(): void {
    const f = this.stormTightenFactor();
    for (const [source, bucket] of this.buckets) {
      if (!this.sbOriginalRates.has(source)) this.sbOriginalRates.set(source, bucket.ratePerSec);
      bucket.ratePerSec *= f;
    }
  }

  /** 第四轮 K：解除收紧——各桶恢复留档原速率 */
  private releaseStormTightening(): void {
    for (const [source, original] of this.sbOriginalRates) {
      const bucket = this.buckets.get(source);
      if (bucket) bucket.ratePerSec = original;
    }
    this.sbOriginalRates.clear();
  }

  /**
   * 第四轮 K：全局风暴强度跟踪与预算联动（配置时；时间轴 = receivedAt）。
   *
   * - 总强度 λ̂：逐到达瞬时速率 1000/Δt 的 EWMA（跨源合流——全局视角）
   * - 风暴 ⟺ λ̂ ≥ max(minStormRatePerSec, 平稳基线 × stormFactor)
   *   （基线仅非风暴期慢速跟踪 β=0.05；需平稳期建立——与 adaptiveWindow 同口径）
   * - 激活：全部令牌桶速率 × tightenFactor（全局预算一口锅）；解除带
   *   holdMs 滞回（λ̂ 回落后距最后一次过阈证据 ≥ holdMs 才恢复）
   */
  private updateStormBudget(t: number): void {
    const cfg = this.config.stormBudget!;
    const alpha = cfg.intensityAlpha ?? 0.3;
    const stormFactor = cfg.stormFactor ?? 3;
    const minRate = cfg.minStormRatePerSec ?? 10;
    if (this.sbLastArrivalAt !== undefined && t > this.sbLastArrivalAt) {
      const dtMs = Math.max(1, t - this.sbLastArrivalAt);
      const instantaneous = 1000 / dtMs;
      this.sbIntensityPerSec =
        this.sbIntensityPerSec === undefined
          ? instantaneous
          : alpha * instantaneous + (1 - alpha) * this.sbIntensityPerSec;
    }
    this.sbLastArrivalAt = this.sbLastArrivalAt === undefined ? t : Math.max(this.sbLastArrivalAt, t);

    const threshold = Math.max(minRate, (this.sbBaselinePerSec ?? 0) * stormFactor);
    const above = this.sbIntensityPerSec !== undefined && this.sbIntensityPerSec >= threshold;
    if (above) this.sbLastAboveAt = t;

    if (!this.sbActive) {
      if (above && this.sbBaselinePerSec !== undefined) {
        this.sbActive = true;
        this.sbTightenings += 1;
        this.applyStormTightening();
      } else if (!above && this.sbIntensityPerSec !== undefined) {
        this.sbBaselinePerSec =
          this.sbBaselinePerSec === undefined ? this.sbIntensityPerSec : this.sbBaselinePerSec * 0.95 + this.sbIntensityPerSec * 0.05;
      }
    } else {
      const holdMs = cfg.holdMs ?? 2000;
      const sinceAbove = this.sbLastAboveAt === undefined ? Number.POSITIVE_INFINITY : t - this.sbLastAboveAt;
      if (!above && sinceAbove >= holdMs) {
        this.sbActive = false;
        this.releaseStormTightening();
        this.sbBaselinePerSec = this.sbIntensityPerSec; // 解除后以当前强度重建平稳基线
      }
    }
  }

  /** 第四轮 K：风暴预算读数（未配置时 undefined） */
  stormBudgetView(): StormBudgetView | undefined {
    const cfg = this.config.stormBudget;
    if (!cfg) return undefined;
    let budgetPerSec = 0;
    const sources: StormBudgetView['sources'] = [];
    for (const [source, b] of this.buckets) {
      budgetPerSec += b.ratePerSec;
      sources.push({ source, ratePerSec: b.ratePerSec, originalRatePerSec: this.sbOriginalRates.get(source) ?? b.ratePerSec });
    }
    return {
      active: this.sbActive,
      ...(this.sbIntensityPerSec !== undefined ? { intensityPerSec: this.sbIntensityPerSec } : {}),
      ...(this.sbBaselinePerSec !== undefined ? { baselinePerSec: this.sbBaselinePerSec } : {}),
      thresholdPerSec: Math.max(cfg.minStormRatePerSec ?? 10, (this.sbBaselinePerSec ?? 0) * (cfg.stormFactor ?? 3)),
      budgetPerSec,
      tightenFactor: this.stormTightenFactor(),
      tightenings: this.sbTightenings,
      sources,
    };
  }

  /**
   * 55.0：挂载 Hawkes 爆发监视（幂等覆盖，挂载即生效——只读观测口径）。
   *
   * 信号到达流滚动拟合 μ/α/β（EM），hawkesView() 闭式外推未来窗期望
   * 事件数并给出激发份额——excitationShare 超阈（缺省 >0.5）即「信号
   * 风暴」判定：到达相关性第一次有了数学口径（自激发 vs 独立 Poisson）。
   * 残差诊断漂移时 fit 置空（诚实降级）。挂载后 adaptiveWindow v2 将其
   * 作为风暴第二证据（限频只读轮询）；不改变聚合/去重/交付任何路径。
   */
  attachHawkesBurstGuard(options?: { windowSec?: number; burstShare?: number; minEvents?: number }): void {
    this.hawkesMonitor = new HawkesBurstMonitor(options);
  }

  /** 55.0：爆发读数（未挂载 / 样本不足 / 拟合退化时 undefined） */
  hawkesView(forecastMs?: number): HawkesBurstView | undefined {
    return this.hawkesMonitor?.view(forecastMs);
  }

  /**
   * 76.0：挂载新奇检测监视（幂等覆盖，挂载即生效——只读观测口径）。
   *
   * 每类信号流一个自适应参考窗（Mahalanobis 门控 + kNN 计数比双证据），
   * 「异常」从「幅值超阈」升级为「没见过」；新奇分序列另以 CUSUM 做
   * 系统性变点监测（「世界开始出现更多没见过的东西」的更早预警）。
   * 不改变聚合/去重/交付任何路径（零漂移）。
   */
  attachNoveltySentinel(options?: {
    window?: { capacity?: number; halfLife?: number; minSamples?: number; alpha?: number; k?: number };
    changeAlpha?: number;
  }): void {
    this.noveltyMonitor = new SentinelNoveltyMonitor(options);
  }

  /** 76.0：新奇读数（未挂载 / 未观测时 undefined） */
  noveltyView(): ReturnType<SentinelNoveltyMonitor['view']> {
    return this.noveltyMonitor?.view();
  }

  /**
   * 80.0：挂载流式概要缓冲（幂等覆盖，挂载即生效——感官层只读口径）。
   *
   * 信号入口的键频（CountMinSketch 上界）+ 滑窗计数（指数直方图）+
   * 等概率抽样（蓄水池）+ 重元素（Misra–Gries 100% 捕获）——O(百格)
   * 内存常驻，海啸级信号流下关键统计不再被丢弃。与 55.0 Hawkes 互补
   * （Hawkes 管强度模型，本缓冲管原始流概要）。只读展示与告警辅助，
   * 不改变任何调度决策路径（零漂移）。
   */
  attachStreamingSketch(options?: { cmsEps?: number; cmsDelta?: number; window?: number; reservoirK?: number; heavyHitters?: number }): void {
    this.sketchBuffer = new SignalSketchBuffer(options);
  }

  /** 80.0：概要读数（未挂载时 undefined） */
  sketchView(): ReturnType<SignalSketchBuffer['view']> | undefined {
    return this.sketchBuffer?.view();
  }

  /** 80.0：四结构保证自检（allPassed=false 时拒绝发布该概要读数——诚实降级） */
  sketchSelfCheck(): { allPassed: boolean } | undefined {
    return this.sketchBuffer?.selfCheck();
  }

  /**
   * 99.0：注意力经济拍卖（挂载后可用——信息流的影子市场口径）。
   *
   * 各信息源自报 EVSI 式边际价值（凹性巡检，违规源摘牌），k 个深看
   * 槽位贪心出清（= 穷举最优）+ VCG 支付（谎报无利可图）——信号洪水下
   * 「该看什么」从拍脑袋到机会成本口径。不改变信号交付顺序（零漂移）。
   */
  attachAttentionEconomy(): void {
    this.attentionEconomyEnabled = true;
  }

  /** 99.0：注意力出清读数（未挂载时 undefined） */
  attentionMarket(sources: ReadonlyArray<AttentionSource>, slots: number): AttentionAuctionView | undefined {
    return this.attentionEconomyEnabled ? attentionAuction(sources, slots) : undefined;
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 确保聚合窗口定时器存在（首个信号触发开窗，使用自适应窗口） */
  private ensureWindowTimer(): void {
    if (this.windowTimer) return;
    const duration = Math.max(1, this.currentWindowMs);
    this.windowDeadline = this.nowMs() + duration;
    this.windowTimer = setTimeout(() => {
      this.windowTimer = null;
      this.windowDeadline = undefined;
      this.flush('window');
    }, duration);
    this.windowTimer.unref?.();
  }

  /** 启动 webhook 信号源 */
  private startWebhook(source: SignalSourceConfig): void {
    const port = source.port ?? 9878;
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy(); // 1MB 上限
      });
      req.on('end', () => {
        try {
          const payload = body ? JSON.parse(body) : {};
          const signal = this.ingest({
            // 任务类型透传：body 带 type 字段时优先（真实工作负载的
            // 上下文多样性由此进入学习分桶）；缺省回退源级配置（零漂移）
            type: (typeof payload.type === 'string' && payload.type ? payload.type : source.signalType) || 'webhook',
            description: payload.description ?? payload.title ?? 'webhook 信号',
            payload,
            source: `webhook:${port}`,
            dedupeKey: payload.dedupeKey,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, signalId: signal.id, occurrences: signal.occurrences }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        }
      });
    });
    server.on('error', (err) => {
      // 'error' 监听器内 throw 会成为进程级未捕获异常，直接击穿宿主；
      // 优雅降级：记录日志、摘除失效 server，保住哨兵与其他信号源
      console.error(`[sentinel] webhook 信号源异常（端口 ${port}）: ${err.message}`);
      this.webhookServers = this.webhookServers.filter((s) => s !== server);
    });
    server.listen(port);
    this.webhookServers.push(server);
  }

  /** 启动文件监听信号源（递归监听 + 防抖 + 忽略规则） */
  private startFileWatch(source: SignalSourceConfig): void {
    const target = source.path ?? this.config.watchDir ?? process.cwd();
    if (!fs.existsSync(target)) return;

    const watcher = fs.watch(target, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const normalized = filename.replace(/\\/g, '/');
      if (normalized.split('/').some((seg) => IGNORED_DIRS.has(seg))) return;
      this.fsPendingPaths.add(path.join(target, normalized));

      if (this.fsDebounceTimer) clearTimeout(this.fsDebounceTimer);
      this.fsDebounceTimer = setTimeout(() => {
        const paths = [...this.fsPendingPaths];
        this.fsPendingPaths.clear();
        this.fsDebounceTimer = null;
        if (paths.length === 0) return;
        this.ingest({
          type: source.signalType || 'code-change',
          description: `检测到 ${paths.length} 个文件变更`,
          payload: { files: paths.slice(0, 50), totalFiles: paths.length },
          source: `fs:${target}`,
          dedupeKey: `${source.signalType || 'code-change'}:${target}`,
        });
      }, FS_DEBOUNCE_MS);
      this.fsDebounceTimer.unref?.();
    });
    this.fsWatchers.push(watcher);
  }

  /** 启动轮询信号源（内容哈希比对） */
  private startPolling(source: SignalSourceConfig): void {
    const url = source.url;
    if (!url) return;
    const interval = source.interval ?? DEFAULT_POLL_INTERVAL;

    const timer = setInterval(async () => {
      try {
        const res = await this.fetchImpl(url);
        if (!res.ok) return;
        const text = await res.text();
        const hash = crypto.createHash('sha256').update(text).digest('hex');
        const prev = this.pollHashes.get(url);
        this.pollHashes.set(url, hash);
        if (prev !== undefined && prev !== hash) {
          this.ingest({
            type: source.signalType || 'polling-change',
            description: `轮询目标内容变化: ${url}`,
            payload: { url, previousHash: prev.slice(0, 12), currentHash: hash.slice(0, 12) },
            source: `poll:${url}`,
            dedupeKey: `poll:${url}`,
          });
        }
      } catch {
        // 轮询失败静默跳过，下个周期重试
      }
    }, interval);
    timer.unref?.();
    this.pollTimers.push(timer);
  }
}
