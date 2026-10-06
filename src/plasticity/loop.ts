/**
 * loop.ts — 可塑性学习闭环（双系统可塑性 · 第一阶段 τ1）
 *
 * 定位：把「能量账本的结算结局」变成「参数级在线学习信号」的闭合回路。
 * 此前 98 内核与结局的关系是「被编排」——本模块让其中三个天生支持在线
 * 更新的内核**从同一个结局流里持续改变自身状态**：
 *
 *   结局流（settleTaskOutcome / 直接观测）
 *     → ① Beta 后验（evidence.ts）：每臂成功率的可衰减贝叶斯信念
 *     → ② 门控校准器（online-calibration.ts）：预报 p ↔ 结局 y 的
 *          流式校准（失准确证前恒等直通——零漂移承诺）
 *     → ③ 预算赌徒路由（bandit-knapsack.ts）：由学到的臂画像驱动的
 *          乐观可行路由（探索半径随证据收缩）
 *
 * 防遗忘屏障（证伪标准②）：
 *   批次提交前跑冻结探针（probes.ts）；对数损失/ECE 退化超容差 →
 *   拒批回滚。回滚机制 = **事件溯源重建**：全部学习状态（后验/校准器/
 *   消耗统计）都是从结局事件日志确定性重放的派生态——丢弃被拒批次后
 *   重放，状态逐位回到批前（浮点同序同操作 → 精确相等，可断言）。
 *   这与账本哲学同构：不改历史，只追加与回放；审计与回滚是同一机制。
 *
 * 链式审计：每个结局事件携带 sha256(prevHash + 内容) 链哈希——
 * 学习信号流不可抵赖，verifyLearningChain() 重算全链。学习从此
 * 和能量一样：可审计、可回放。
 *
 * 零漂移：本模块不修改任何既有文件的行为；attachPlasticity 是
 * opt-in 的运行时包装（挂载才生效，卸载即还原）。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  type MemoryEvidence,
  initEvidence,
  observeEvidence,
  readEvidence,
} from '../core/evidence.js';
import {
  GatedCalibrator,
  gatedCalibrator,
  type GatedCalibratorOptions,
} from '../core/online-calibration.js';
import {
  BwKRouter,
  type BwKArmStat,
  type BwKBudgets,
  type BwKVerdict,
} from '../core/bandit-knapsack.js';
import { EnergyLedger } from '../symbiosis/ledger.js';
import {
  ForgettingProbeSet,
  freezeProbes,
  probeVerdict,
  type ProbeMetric,
  type ProbeVerdict,
  type ProbeTolerance,
} from './probes.js';

// ─────────────────────────── 信号与配置 ───────────────────────────

/** 单个贡献者（携带该任务的资源消耗——赌徒路由的消耗画像来源） */
export interface OutcomeContributor {
  agentId: string;
  /** 该任务消耗的 token 数（缺省不计入消耗统计） */
  tokens?: number;
  /** 可选第二资源：货币成本 */
  cost?: number;
  /**
   * 节点级真值 override（缺省用任务级 success）：宿主结算常携带
   * 逐节点成败（同一任务里模型A成功、模型B失败）——Beta 证据按节点
   * 真值学习，校准器仍按任务级预报 vs 任务级结局训练（各学各的口径）。
   */
  success?: boolean;
  /**
   * 创世纪 G1 · 失败分账：auth/network/timeout/integrity 是基础设施
   * 与完整性事件——只入可用性科目（计数），**永不触碰能力后验**；
   * quality（含无错误的失败）才是能力科目证据。
   */
  failureMode?: FailureMode;
}

/** 失败模式分型（G1 分账协议的科目分类） */
export type FailureMode = 'auth' | 'network' | 'timeout' | 'integrity' | 'quality';

/** 基础设施类失败（不入能力科目） */
export const INFRA_MODES: ReadonlySet<FailureMode> = new Set(['auth', 'network', 'timeout', 'integrity']);

/**
 * 从节点错误文本分型失败模式（纯函数；创世纪 G1）。
 * 判定次序：auth（凭证）→ timeout → network → integrity（执行器异常）
 * → quality（无错误或不匹配 = 真实质量失败）。
 */
export function classifyFailure(error: string | undefined): FailureMode {
  if (!error) return 'quality';
  const e = error.toLowerCase();
  if (/401|403|unauthorized|authorization|api.?key|身份验证|鉴权|invalid_api_key/.test(e)) return 'auth';
  // 429/限流是瞬态容量事件（稍后重试即恢复），归 timeout 科目——
  // 误归 quality 会让限流风暴毒化能力后验（实测：速率限制命中）
  if (/timeout|timed?\s*out|超时|deadline|etimedout|429|too\s*many\s*requests|rate.?limit|速率限制|频率/.test(e)) return 'timeout';
  // 端点级 HTTP 错误（404/405/5xx、路由不可达）是基础设施故障非模型能力
  if (/econnreset|econnrefused|enotfound|eai_again|fetch\s*failed|network|socket|connection|网络|\b40[45]\b|\b5\d{2}\b|no\s*route/.test(e)) return 'network';
  if (/cannot set properties|cannot read properties|typeerror|referenceerror|is not a function|undefined is not/.test(e)) return 'integrity';
  return 'quality';
}

/** 学习信号的最小单元：一次已结算的任务结局 */
export interface TaskOutcomeSignal {
  taskId: string;
  success: boolean;
  contributors: OutcomeContributor[];
  /** 决策时刻的原始预报 p∈(0,1)（校准器的训练对偶；由调用方在结算前给出） */
  forecastP: number;
  /** 结局时刻（ms）；显式注入保证重放确定性 */
  at: number;
  /** 上下文前提（如信号类型/任务类型）：τ2 固化按此分桶；缺省全局桶 */
  taskContext?: string;
  source?: 'settle-wrapper' | 'direct';
  /** 链哈希（追加时由本模块填充） */
  hash?: string;
}

export interface PlasticityConfig {
  /** 未见过的臂的缺省消耗均值（token；进入路由画像前占位） */
  defaultTokensMean?: number;
  /** 校准器配置（透传 GatedCalibrator） */
  calibrator?: GatedCalibratorOptions;
  /** 探针退化容差 */
  probeTolerance?: ProbeTolerance;
  /** 事件日志上限（超出滑出最旧——审计窗口收缩，重放从保留段起） */
  eventLimit?: number;
  /**
   * 自动遗忘门控（生产形态）：每 window 个事件自动执行一轮
   * 「冻结历史探针 → 批后评分 → 退化即回滚本窗口」。探针取自本窗口
   * 之前的历史（时间前向切分——考卷在开考前印好），种子固定保证
   * 门控决策可复现。未配置 = 逐事件直通（验证/实验口径）。
   */
  autoGate?: {
    /** 每多少事件开一次门 */
    window: number;
    /** 每轮冻结的探针数 */
    probeSize: number;
    /** 历史不足此数时本窗口直通（无考卷不判卷） */
    minHistory?: number;
    /** 探针采样种子（进实验记录才可复现） */
    seed?: number;
  };
  /**
   * 状态持久化路径（如 .scheduler/plasticity.json）：构造时自动加载，
   * 每次状态变更后原子落盘（tmp + rename）。缺省不持久化（内存态）。
   */
  persistPath?: string;
}

/** 单臂学习画像的精确读数（调度消费口径） */
export interface ArmProfileView {
  /** Beta 后验均值（时间衰减后） */
  posteriorMean: number;
  /** 门控校准后的成功率估计 */
  calibratedMean: number;
  effectiveSamples: number;
  /** 实测平均 token 消耗（无观测 0） */
  tokensMean: number;
  /** G1：基础设施事件计数（auth/network/timeout/integrity 累计） */
  availabilityIncidents: number;
}

export interface ArmLearningView {
  agentId: string;
  /** Beta 后验均值（时间衰减后） */
  posteriorMean: number;
  wilsonLower: number;
  effectiveSamples: number;
  /** 门控校准后的成功率估计（探针/路由消费的口径） */
  calibratedMean: number;
  tokensMean: number;
  tokensVar: number;
  costMean: number;
}

export interface PlasticityStats {
  events: number;
  arms: ArmLearningView[];
  calibrator: ReturnType<GatedCalibrator['status']>;
  /** 被探针拒批回滚的批次数 */
  rejectedBatches: number;
  chainHead: string;
  chainIntact: boolean;
}

export interface BatchDecision {
  /** false = 探针判退化，批次已被回滚 */
  committed: boolean;
  verdict: ProbeVerdict;
  rejectedEvents: number;
}

/** 单臂派生态：Beta 证据 + Welford 消耗统计 + 可用性科目（G1 分账） */
class ArmState {
  readonly evidence: MemoryEvidence;
  tokensN = 0;
  tokensMean = 0;
  tokensM2 = 0;
  costSum = 0;
  costN = 0;
  /** G1：基础设施事件计数（auth/network/timeout/integrity——能力科目之外的独立账本） */
  availabilityIncidents = 0;
  lastInfraAt = 0;

  constructor(at: number) {
    this.evidence = initEvidence(1, 2, at);
  }

  observeInfra(at: number): void {
    this.availabilityIncidents += 1;
    this.lastInfraAt = at;
  }

  observeTokens(tokens: number): void {
    this.tokensN += 1;
    const delta = tokens - this.tokensMean;
    this.tokensMean += delta / this.tokensN;
    this.tokensM2 += delta * (tokens - this.tokensMean);
  }

  observeCost(cost: number): void {
    this.costSum += cost;
    this.costN += 1;
  }
}

const GENESIS_HASH = '0'.repeat(64);

// ─────────────────────────── 主回路 ───────────────────────────

export class PlasticityLoop {
  private readonly cfg: Required<Pick<PlasticityConfig, 'defaultTokensMean' | 'eventLimit'>>;
  private readonly calibratorOptions: GatedCalibratorOptions | undefined;
  private readonly probeTol: ProbeTolerance;
  private readonly autoGate: Required<NonNullable<PlasticityConfig['autoGate']>> | undefined;
  private readonly persistPath: string | undefined;
  private readonly autoRand: () => number;
  private events: TaskOutcomeSignal[] = [];
  private chainHead = GENESIS_HASH;
  /** 链锚点：eventLimit 裁剪掉的最旧事件哈希（保留段的验证起点） */
  private chainAnchor = GENESIS_HASH;
  private arms = new Map<string, ArmState>();
  private calibrator: GatedCalibrator;
  private readonly router = new BwKRouter();
  private batchMark = 0;
  private batchBaseline: ProbeMetric | undefined;
  /** 自动门控当前窗口的冻结探针（手动 beginBatch 时与 baseline 同置） */
  private batchProbes: ForgettingProbeSet | undefined;
  private rejections: number = 0;
  /** 自动门控的窗口内事件计数（0 = 窗口关闭，待重启） */
  private autoWindowCount = 0;

  constructor(config: PlasticityConfig = {}) {
    this.cfg = {
      defaultTokensMean: Math.max(1, config.defaultTokensMean ?? 1000),
      eventLimit: Math.max(10, config.eventLimit ?? 10_000),
    };
    this.calibratorOptions = config.calibrator;
    this.probeTol = config.probeTolerance ?? { logLossTol: 0.02, eceTol: 0.05 };
    this.calibrator = gatedCalibrator(config.calibrator ?? {});
    this.persistPath = config.persistPath;
    if (config.autoGate) {
      this.autoGate = {
        window: Math.max(1, Math.floor(config.autoGate.window)),
        probeSize: Math.max(1, Math.floor(config.autoGate.probeSize)),
        minHistory: Math.max(1, Math.floor(config.autoGate.minHistory ?? config.autoGate.window)),
        seed: config.autoGate.seed ?? 0x9e3779b9,
      };
      this.autoRand = mulberry32(this.autoGate.seed);
    } else {
      this.autoGate = undefined;
      this.autoRand = mulberry32(0);
    }
    if (this.persistPath) this.loadFromDisk();
  }

  // ── 读取面（纯查询，不产生学习副作用） ──

  /** 多贡献者的混合后验（按有效样本量加权——证据多的臂话语权大） */
  forecast(agentIds: readonly string[], now: number): number {
    const views = agentIds.map((id) => this.readArm(id, now));
    let wSum = 0;
    let acc = 0;
    for (const v of views) {
      const w = 1 + v.effectiveSamples;
      acc += w * v.posteriorMean;
      wSum += w;
    }
    return wSum === 0 ? 0.5 : acc / wSum;
  }

  /** 校准后的单臂成功率估计（探针 forecaster 的标准口径） */
  predict(agentId: string, now: number): number {
    const raw = this.readArm(agentId, now).posteriorMean;
    return this.calibrator.calibrate(raw);
  }

  /**
   * 单臂学习画像的精确读数（供调度消费——stats() 是四舍五入的观测口径）。
   * 未注册的臂返回 undefined（调用方自行决定回退语义）。
   */
  armProfile(agentId: string, now: number): ArmProfileView | undefined {
    const arm = this.arms.get(agentId);
    if (!arm) return undefined;
    const view = readEvidence(arm.evidence, now);
    return {
      posteriorMean: view.posteriorMean,
      calibratedMean: this.calibrator.calibrate(view.posteriorMean),
      effectiveSamples: view.effectiveSamples,
      tokensMean: arm.tokensMean,
      availabilityIncidents: arm.availabilityIncidents,
    };
  }

  /** 全体臂的混合信念（有效样本加权；无任何证据时 0.5）——相对优势的中性锚 */
  mixtureMean(now: number): number {
    let wSum = 0;
    let acc = 0;
    for (const id of this.arms.keys()) {
      const v = this.readArm(id, now);
      const w = 1 + v.effectiveSamples;
      acc += w * v.posteriorMean;
      wSum += w;
    }
    return wSum === 0 ? 0.5 : acc / wSum;
  }

  /** 纯查询：外部预报的校准值（决策阈值消费） */
  calibrated(p: number): number {
    return this.calibrator.calibrate(p);
  }

  /** 由学习画像驱动的路由裁决（探索半径 = 后验不确定性的函数） */
  route(budgets: BwKBudgets, now: number): BwKVerdict {
    const arms: BwKArmStat[] = [...this.arms.keys()].map((id) => {
      const arm = this.arms.get(id)!;
      const view = readEvidence(arm.evidence, now);
      return {
        id,
        qualityMean: this.calibrator.calibrate(view.posteriorMean),
        tokensMean: arm.tokensMean > 0 ? arm.tokensMean : this.cfg.defaultTokensMean,
        costMean: arm.costN > 0 ? arm.costSum / arm.costN : undefined,
        samples: Math.max(0, Math.round(view.effectiveSamples)),
      };
    });
    return this.router.route(arms, budgets);
  }

  stats(now: number): PlasticityStats {
    return {
      events: this.events.length,
      arms: [...this.arms.keys()].map((id) => {
        const arm = this.arms.get(id)!;
        const view = readEvidence(arm.evidence, now);
        return {
          agentId: id,
          posteriorMean: Number(view.posteriorMean.toFixed(4)),
          wilsonLower: Number(view.wilsonLower.toFixed(4)),
          effectiveSamples: Number(view.effectiveSamples.toFixed(2)),
          calibratedMean: Number(this.calibrator.calibrate(view.posteriorMean).toFixed(4)),
          tokensMean: Number(arm.tokensMean.toFixed(1)),
          tokensVar: Number((arm.tokensM2 / Math.max(1, arm.tokensN - 1)).toFixed(1)),
          costMean: arm.costN > 0 ? Number((arm.costSum / arm.costN).toFixed(4)) : 0,
        };
      }),
      calibrator: this.calibrator.status(),
      rejectedBatches: this.rejections,
      chainHead: this.chainHead,
      chainIntact: this.verifyLearningChain(),
    };
  }

  /** 结局事件日志拷贝（审计导出） */
  eventLog(): TaskOutcomeSignal[] {
    return this.events.map((e) => ({ ...e, contributors: e.contributors.map((c) => ({ ...c })) }));
  }

  // ── 写入面（学习副作用） ──

  /**
   * 注册臂名册：为已知但尚未观测的智能体建立先验占位。
   * 模型/策略名册通常先于使用已知——不注册则路由只能从已观测臂中
   * 选择，新臂永不可发现（发现性依赖名册，不依赖偶然的首次使用）。
   */
  register(agentIds: readonly string[], at: number): void {
    for (const id of agentIds) this.armOf(id, at);
  }

  /**
   * 观测一次任务结局：追加事件（链哈希）并增量更新三内核状态。
   * forecastP 必须由调用方在**结算前**给出（决策时刻的信念）——
   * 校准器学的是「当时的预报 vs 之后的现实」，事后预报是作弊。
   * 配置 autoGate 时自动按窗口执行遗忘门控（退化窗口原地下线）。
   */
  observeTask(signal: TaskOutcomeSignal): number {
    if (!Number.isFinite(signal.forecastP) || signal.forecastP <= 0 || signal.forecastP >= 1) {
      throw new Error('PlasticityLoop.observeTask: forecastP 须为 (0,1) 开区间内的决策时刻预报');
    }
    if (signal.contributors.length === 0) {
      throw new Error('PlasticityLoop.observeTask: 贡献者不能为空');
    }
    if (this.autoGate && this.autoWindowCount === 0) this.openAutoWindow(signal.at);
    const entry = { ...signal, hash: '' };
    entry.hash = hashEvent(this.chainHead, entry);
    this.chainHead = entry.hash;
    this.events.push(entry);
    if (this.events.length > this.cfg.eventLimit) {
      // 滑出最旧事件：锚点前移到最后一条被裁剪者（与账本 chainAnchor 同构）
      const overflow = this.events.length - this.cfg.eventLimit;
      this.chainAnchor = this.events[overflow - 1]!.hash!;
      this.events.splice(0, overflow);
    }
    this.applyEvent(entry);
    if (this.autoGate) {
      this.autoWindowCount += 1;
      if (this.autoWindowCount >= this.autoGate.window) this.closeAutoWindow(entry.at);
    }
    this.persist();
    return this.events.length;
  }

  /** 批次开始：打标记 + 探针基线（当前预测器对冻结事实的得分）。autoGate 启用时勿与手动批次混用 */
  beginBatch(probes: ForgettingProbeSet, now: number): void {
    this.batchMark = this.events.length;
    this.batchBaseline = probes.score((id) => this.predict(id, now));
    this.batchProbes = probes;
  }

  /**
   * 批次结束：探针门控提交。退化 → 丢弃批次事件并从日志确定性重放，
   * 状态逐位回到批前（同序浮点重放的精确相等性是回滚的数学根基）。
   */
  endBatch(probes: ForgettingProbeSet, now: number): BatchDecision {
    if (this.batchBaseline === undefined) throw new Error('PlasticityLoop.endBatch: 须先 beginBatch');
    const after = probes.score((id) => this.predict(id, now));
    const verdict = probeVerdict(this.batchBaseline, after, this.probeTol);
    this.batchBaseline = undefined;
    this.batchProbes = undefined;
    if (!verdict.degraded) return { committed: true, verdict, rejectedEvents: 0 };
    const rejectedEvents = this.events.length - this.batchMark;
    this.events.length = this.batchMark;
    this.rebuildFromLog();
    this.rejections += 1;
    this.persist();
    return { committed: false, verdict, rejectedEvents };
  }

  // ── 自动遗忘门控（生产形态：每 window 事件一轮考卷） ──

  /** 开窗：从**本窗口之前**的历史冻结探针 + 记录批前基线（考卷在开考前印好） */
  private openAutoWindow(at: number): void {
    const gate = this.autoGate!;
    this.batchMark = this.events.length;
    if (this.events.length < gate.minHistory) return; // 无考卷不判卷：本窗口直通
    const history = this.events.map((e) => ({
      contributors: e.contributors.map((c) => ({ agentId: c.agentId, success: c.success ?? e.success })),
      success: e.success,
    }));
    const probes = freezeProbes(history, Math.min(gate.probeSize, history.length), this.autoRand, at);
    this.batchBaseline = probes.score((id) => this.predict(id, at));
    this.batchProbes = probes;
  }

  /** 关窗：批后评分，退化即回滚本窗口（与手动 endBatch 同一机制） */
  private closeAutoWindow(at: number): void {
    this.autoWindowCount = 0;
    const probes = this.batchProbes;
    const baseline = this.batchBaseline;
    this.batchProbes = undefined;
    this.batchBaseline = undefined;
    if (!probes || !baseline) return;
    const after = probes.score((id) => this.predict(id, at));
    const verdict = probeVerdict(baseline, after, this.probeTol);
    if (!verdict.degraded) return;
    this.events.length = this.batchMark;
    this.rebuildFromLog();
    this.rejections += 1;
  }

  // ── 持久化（原子落盘：tmp + rename；构造时自动加载） ──

  private persist(): void {
    if (!this.persistPath) return;
    try {
      const dir = dirname(this.persistPath);
      mkdirSync(dir, { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.snapshotState()), 'utf8');
      renameSync(tmp, this.persistPath);
    } catch (err) {
      // 持久化失败不阻断学习（内存态仍正确）；下次变更重试
      console.warn(`[plasticity] 状态落盘失败（${this.persistPath}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private loadFromDisk(): void {
    const p = this.persistPath!;
    if (!existsSync(p)) return;
    try {
      const snap = JSON.parse(readFileSync(p, 'utf8')) as ReturnType<PlasticityLoop['snapshotState']>;
      if (!snap || !Array.isArray(snap.events)) throw new Error('快照结构不符');
      this.restoreState(snap);
    } catch (err) {
      // 损坏即诚实重启：保留损坏文件供审计，内存态从零开始
      console.warn(`[plasticity] 状态加载失败，从零开始（${p}）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 审计面 ──

  /** 学习链完整性：重算全链哈希（从裁剪锚点起验） */
  verifyLearningChain(): boolean {
    let prev = this.chainAnchor;
    for (const e of this.events) {
      if (hashEvent(prev, e) !== e.hash) return false;
      prev = e.hash;
    }
    return this.chainHead === prev;
  }

  /**
   * 审计窗口是否已发生裁剪（G5 宪法取证口径）：事件数打满 eventLimit
   * 即裁剪曾发生；未打满时**任何**证据短缺都不可能是裁剪——只能是
   * 虚账。裁剪豁免必须由本客观状态背书，不许自我声明。
   */
  prunedWindow(): boolean {
    return this.events.length >= this.cfg.eventLimit;
  }

  /** 可持久化快照（重启续学 / 审计篡改注入，与 ledger.snapshotState 同构） */
  snapshotState(): { events: TaskOutcomeSignal[]; chainHead: string; chainAnchor: string } {
    return {
      events: this.eventLog(),
      chainHead: this.chainHead,
      chainAnchor: this.chainAnchor,
    };
  }

  /** 导入快照：整体替换事件日志并从日志确定性重放派生态 */
  restoreState(snap: { events: TaskOutcomeSignal[]; chainHead?: string; chainAnchor?: string }): void {
    this.events = snap.events.map((e) => ({ ...e, contributors: e.contributors.map((c) => ({ ...c })) }));
    this.chainAnchor = snap.chainAnchor ?? GENESIS_HASH;
    this.rebuildFromLog();
  }

  /**
   * 与能量账本对账：账本 'task-dividend' 铸币（任务成功的价值注入）与
   * 本回路观测到的成功事件数应一致——学习信号的完备性检查。
   */
  reconcile(ledger: EnergyLedger): { ledgerSuccessMints: number; loopSuccessEvents: number; match: boolean } {
    let ledgerSuccessMints = 0;
    for (const t of ledger.audit(this.cfg.eventLimit)) {
      if (t.reason === 'task-dividend') ledgerSuccessMints += 1;
    }
    const loopSuccessEvents = this.events.filter((e) => e.success).length;
    return { ledgerSuccessMints, loopSuccessEvents, match: ledgerSuccessMints === loopSuccessEvents };
  }

  // ── 内部：应用与重放 ──

  private readArm(id: string, now: number) {
    return readEvidence(this.armOf(id, now).evidence, now);
  }

  private armOf(id: string, now: number): ArmState {
    let arm = this.arms.get(id);
    if (!arm) {
      arm = new ArmState(now);
      this.arms.set(id, arm);
    }
    return arm;
  }

  /** 单事件的三内核增量更新（重放与在线走同一条路——等价性由此保证） */
  private applyEvent(e: TaskOutcomeSignal): void {
    const y = e.success ? 1 : 0;
    // G1 分账：任务被基础设施失败完全审查（task 失败且全体失败贡献者
    // 均为 infra）→ 删失观测，校准器不入账（预报学的是能力条件下的
    // 任务成功，瞬态环境故障不是能力信息）
    const censored =
      !e.success && e.contributors.length > 0 && e.contributors.every((c) => (c.success ?? e.success) === false && c.failureMode !== undefined && INFRA_MODES.has(c.failureMode));
    for (const c of e.contributors) {
      const arm = this.armOf(c.agentId, e.at);
      const nodeOk = c.success ?? e.success;
      const infra = !nodeOk && c.failureMode !== undefined && INFRA_MODES.has(c.failureMode);
      if (infra) {
        // 可用性科目：只计数，不碰能力后验（key 死了 ≠ 模型差了）
        arm.observeInfra(e.at);
      } else {
        // 能力科目：节点级真值优先（同任务里各模型各记各的账）
        observeEvidence(arm.evidence, nodeOk, e.at);
      }
      if (typeof c.tokens === 'number' && Number.isFinite(c.tokens) && c.tokens >= 0) arm.observeTokens(c.tokens);
      if (typeof c.cost === 'number' && Number.isFinite(c.cost) && c.cost >= 0) arm.observeCost(c.cost);
    }
    if (censored) return; // 删失观测：三科目分账完毕，校准器跳过
    // 校准器流协议：calibrateNext(p) → observe(y)（严格成对，任务级口径）
    this.calibrator.calibrateNext(e.forecastP);
    this.calibrator.observe(y);
  }

  /** 从事件日志确定性重建全部派生态（回滚路径；批前状态的精确还原） */
  private rebuildFromLog(): void {
    this.arms = new Map();
    this.calibrator = gatedCalibrator(this.calibratorOptions ?? {});
    this.chainHead = GENESIS_HASH;
    for (const e of this.events) {
      // 保留事件原哈希：重建不改写历史，只重放学习状态
      this.chainHead = e.hash!;
      this.applyEvent(e);
    }
  }
}

// ─────────────────────────── 挂载（零漂移） ───────────────────────────

/** 与 SymbiosisRuntime.settleTaskOutcome 同形的宿主（鸭子类型，便于测试替身） */
export interface SettleHost {
  settleTaskOutcome(success: boolean, contributors: Array<{ agentId: string; weight?: number }>): unknown;
}

/**
 * 把学习闭环挂到结算口上（opt-in，零漂移）：
 * - 调用方触发 settleTaskOutcome(success, …) → 先用**当前**后验生成预报
 *   （尚未被本结局污染），原结算照常执行，随后把结局喂给学习回路；
 * - 返回 detach——卸载后宿主方法逐位还原（含「自身属性 vs 原型方法」的
 *   归位），未挂载时系统行为与本模块不存在完全一致。
 */
export function attachPlasticity(
  host: SettleHost,
  loop: PlasticityLoop,
  now: () => number = Date.now,
): () => void {
  const orig = host.settleTaskOutcome.bind(host);
  const hadOwn = Object.prototype.hasOwnProperty.call(host, 'settleTaskOutcome');
  let seq = 0;
  (host as { settleTaskOutcome: SettleHost['settleTaskOutcome'] }).settleTaskOutcome = (success, contributors) => {
    const t = now();
    const forecastP = loop.forecast(contributors.map((c) => c.agentId), t);
    const result = orig(success, contributors);
    loop.observeTask({
      taskId: `settle-${++seq}-${t}`,
      success,
      contributors: contributors.map((c) => ({ agentId: c.agentId })),
      forecastP,
      at: t,
      source: 'settle-wrapper',
    });
    return result;
  };
  return () => {
    if (hadOwn) {
      (host as { settleTaskOutcome: SettleHost['settleTaskOutcome'] }).settleTaskOutcome = orig as SettleHost['settleTaskOutcome'];
    } else {
      delete (host as Partial<Record<'settleTaskOutcome', unknown>>).settleTaskOutcome;
    }
  };
}

// ─────────────────────────── 链哈希 ───────────────────────────

function hashEvent(prevHash: string, e: Omit<TaskOutcomeSignal, 'hash'>): string {
  const agents = e.contributors
    .map((c) => `${c.agentId}:${c.tokens ?? ''}:${c.cost ?? ''}:${c.success === undefined ? '' : c.success ? 1 : 0}:${c.failureMode ?? ''}`)
    .join(',');
  return createHash('sha256')
    .update(`${prevHash}|${e.taskId}|${agents}|${e.success ? 1 : 0}|${e.forecastP}|${e.at}|${e.taskContext ?? ''}`)
    .digest('hex');
}

/** 与内核验证脚本共用口径的确定性 PRNG（autoGate 探针采样用） */
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
