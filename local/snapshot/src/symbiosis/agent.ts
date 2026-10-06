/**
 * agent.ts — 智能体契约与信誉基座（共生进化架构第五阶段 2/4）
 *
 * 质变设计（相对草案 IAgent 的三处结构性修正）：
 *
 * 1. 无 energy 字段、无 receiveEnergy/spendEnergy：
 *    能量只存在于 EnergyLedger，智能体无法伪造或绕过市场转账；
 *    智能体对能量的唯一影响路径 = 提案出价（bid）与成交收入。
 *
 * 2. perceive / propose / execute 三段分离（而非单一 act()）：
 *    智能体只「感知 → 提案」，由运行时+市场+监管撮合批准后授予
 *    ExecutionGrant 才能执行——立法与执法分离，kill-switch/熔断在
 *    批准层自然生效（提案-批准分离是能量预算与安全治理的统一）。
 *
 * 3. goal 是结构化契约（关联指标 + 生存线），且信誉（Reputation）
 *    不是自述而是证据：直接复用 core/evidence 统计内核——
 *    贡献成功率的 Wilson 置信下界决定分红权重与定价可信度，
 *    小样本保守、时间衰减、表现差自然饿死休眠。
 *    「把项目的统计内核升级为经济内核」是本阶段的核心突破。
 *
 * 生命周期：active（参与感知/提案/执行）⇄ dormant（饥饿休眠，
 * 不被调度不消耗心跳；可被央行救济或分红唤醒复活）。
 *
 * 三轮升级（信誉衰减与女巫抵抗）：
 * - 观测封顶：recordContribution 按「滑动窗口 × 每窗口计入上限」
 *   受纳观测——女巫集群在同一时间窗内刷一千次成功，证据侧只认
 *   maxObservationsPerWindow 次，Wilson 下界的小样本保守性无法被
 *   高频刷分冲破（信誉只能跨窗口用真实时间积累）；
 * - 冷启动额度：trustView() 给出 spendAllowance = base + per ×
 *   min(有效样本, cap)——有效样本是 30 天半衰期的时间加权量，
 *   新账户额度低、停更账户自然收缩（躺在功劳簿上失效）、
 *   持续贡献者按历史解锁；运行时挂 sybilGuard 后超额出价/行动
 *   被一票拦截（消费面在 runtime，缺省关闭零漂移）。
 *
 * 四轮升级（贡献者三维画像 + 突变检测）：
 * - 生产率 / 质量 / 影响半径三维滚动窗口画像（profile()）：生产率 =
 *   每桶平均受纳贡献数、质量 = 窗口成功率、影响半径 = 窗口内触达的
 *   不同对象数（refId 口径）——「贡献者现在是什么水平」的量化读数；
 * - 画像趋势：窗口前半 vs 后半的桶得分对比（rising/falling/stable）；
 * - 突变检测：最新桶相对基线的质量骤降 / 生产率坍缩 → 风险信号
 *   （长期优秀者突然变差比一直平庸者更值得警惕——退化先于故障）。
 *   opt-in：构造时未配置 profile → 不记录画像数据，profile() 返回
 *   undefined（零漂移）。
 */

import {
  decayFactor,
  initEvidence,
  observeEvidence,
  readEvidence,
  type EvidenceView,
  type MemoryEvidence,
} from '../core/evidence.js';
import type { BeliefView } from './belief.js';

/** 智能体种类（对应认知生态中的角色） */
export type AgentKind = 'memory' | 'reflector' | 'optimizer' | 'evolver' | 'curiosity' | 'world-model' | 'model';

/** 运行模式：活跃 / 饥饿休眠 */
export type AgentMode = 'active' | 'dormant';

/** 信誉等级：由证据统计自动晋级，不可自封 */
export type ReputationTier = 'seed' | 'established' | 'elite';

/** 结构化目标（可机器观测，而非自由文本口号） */
export interface AgentGoal {
  /** 目标陈述（人类可读） */
  objective: string;
  /** 关联的可观测指标名（供心智报告/元认知层归因） */
  metrics: string[];
  /** 能量生存线：低于此值进入休眠 */
  survivalThreshold: number;
}

/** 证据化信誉视图（Wilson 口径，与全层统计语言一致） */
export interface AgentReputation {
  tier: ReputationTier;
  /** 有效样本量（时间衰减后） */
  effectiveSamples: number;
  /** Beta 后验均值 */
  posteriorMean: number;
  /** Wilson 95% 置信下界 —— 分红权重与市场定价可信度的统一度量 */
  wilsonLower: number;
  /** 累计收入（能量） */
  earnings: number;
  /** 累计支出（能量） */
  spend: number;
  /** 净流入 */
  netFlow: number;
  /** ── 三轮升级：冷启动单笔支出限额（女巫抵抗读数；未配 trust 曲线按缺省） ── */
  spendAllowance?: number;
}

/**
 * 信任配置（三轮升级：信誉衰减 × 女巫抵抗的旋钮；缺省不封顶 = 旧行为零漂移）。
 *
 * 女巫抵抗的数学：单窗口高频观测无法快速抬高 Wilson 下界——
 * n=5 全成功下界仅 ≈ 0.578，n=15 才 ≈ 0.78；封顶后刷分者每窗口
 * 最多 +5 有效样本，追上真实贡献者必须消耗真实日历时间。
 */
export interface AgentTrustConfig {
  /** 观测计入的滑动窗口宽度（ms）；窗口内计入达上限后的观测被拒 */
  observationWindowMs?: number;
  /** 每窗口最多计入的观测数（超出拒绝计入证据） */
  maxObservationsPerWindow?: number;
  /** 冷启动额度基线（缺省 10——seed 单笔上限） */
  allowanceBase?: number;
  /** 每有效样本解锁的额度增量（缺省 4） */
  allowancePerSample?: number;
  /** 参与解锁的有效样本上限（缺省 60——额度封顶 base + 60×per = 250） */
  allowanceSampleCap?: number;
  /** 视为「冷启动完成」的有效样本目标（unlockProgress 的分母，缺省 20 = elite 门槛） */
  unlockTargetSamples?: number;
}

/** 信任视图（女巫抵抗 + 信誉衰减的机器可读读数） */
export interface AgentTrustView {
  agentId: string;
  tier: ReputationTier;
  /** 有效样本量（30 天半衰期时间加权——停更自然收缩） */
  effectiveSamples: number;
  /** 距最近一次观测的时间衰减因子（0~1；功劳簿的新鲜度） */
  stalenessFactor: number;
  /** 冷启动单笔支出限额 = base + per × min(有效样本, cap) */
  spendAllowance: number;
  /** 解锁进度 0~1（有效样本 / 解锁目标） */
  unlockProgress: number;
  /** 冷启动是否完成（解锁进度 ≥ 1） */
  established: boolean;
  /** 终身受纳观测数 */
  creditedObservations: number;
  /** 终身拒绝观测数（窗口封顶命中——女巫信号审计读数） */
  rejectedObservations: number;
  /** 当前窗口已计入的观测数 */
  observationsInWindow: number;
}

// ═════════════════ 四轮升级：贡献者三维画像 + 突变检测 ═════════════════

/** 画像配置（opt-in：不配置 = 不记录画像，零漂移） */
export interface ContributorProfileConfig {
  /** 桶宽（ms；默认 3_600_000 = 1 小时） */
  bucketMs?: number;
  /** 桶数（默认 8 → 滚动窗口 8 小时） */
  buckets?: number;
  /** 突变检测：最新桶相对基线的质量骤降阈值（0~1，默认 0.25） */
  shiftQualityDrop?: number;
  /** 突变检测：最新桶与基线各自的最少样本（默认 4） */
  shiftMinSamples?: number;
  /** 突变检测：生产率坍缩比例（最新桶 credits < 基线均值 × 此值 → 突变，默认 0.25） */
  shiftProductivityCollapse?: number;
}

/** 单桶画像读数（观测明细，拷贝导出） */
export interface ProfileBucketView {
  /** 绝对桶序（floor(timestamp / bucketMs)，单调递增） */
  index: number;
  /** 受纳贡献数 */
  credits: number;
  /** 成功数 */
  successes: number;
  /** 触达的不同对象数（无对象数据时 = credits） */
  refs: number;
}

/** 贡献者画像视图（三维 + 趋势 + 突变检测） */
export interface ContributorProfileView {
  agentId: string;
  /** 生产率：窗口内每桶平均受纳贡献数（稀疏活动自然趋 0） */
  productivity: number;
  /** 质量：窗口成功率（0~1；零样本 = 0） */
  quality: number;
  /** 影响半径：窗口内触达的不同对象总数（无对象数据时退化为受纳贡献数） */
  impactRadius: number;
  /** 综合分 = 质量 × ln(1+生产率)（质量一票否决、生产率对数阻尼） */
  composite: number;
  /** 窗口内受纳样本数 */
  samples: number;
  /** 画像趋势：窗口前半 vs 后半的桶产出对比 */
  trend: { firstHalf: number; secondHalf: number; direction: 'rising' | 'falling' | 'stable' };
  /** 突变检测（突然变差 = 风险信号） */
  shift: {
    detected: boolean;
    /** 触发维度（quality = 质量骤降 / productivity = 生产率坍缩） */
    metric?: 'quality' | 'productivity';
    /** 量级（质量：基线−最新；生产率：1 − 最新/基线） */
    magnitude?: number;
    detail?: string;
  };
  /** 窗口桶明细（时间升序，只含有观测的桶） */
  buckets: ProfileBucketView[];
}

/** 市场行情快照（智能体感知的一部分） */
export interface MarketSnapshot {
  listed: number;
  openBids: number;
  trades: number;
  /** 累计成交额（能量） */
  volume: number;
  /** 最近成交均价 */
  lastPrice: number;
}

/** 市场挂单脱敏视图（买方决策依据；不暴露底层知识本体） */
export interface ListingView {
  assetId: string;
  kind: string;
  seller: string;
  ask: number;
  /** 卖方申报质量（成交后由实测证据校准） */
  claimedQuality: number;
  /** 历史成交次数 */
  sales: number;
}

/** 感知：运行时每轮心跳分发的世界状态切片 */
export interface Perception {
  tick: number;
  timestamp: number;
  /** 自身账户余额（只读快照） */
  ownBalance: number;
  /** 自身信誉视图 */
  reputation: AgentReputation;
  /** 市场行情 */
  market: MarketSnapshot;
  /** 市场挂单列表（脱敏） */
  listings: ReadonlyArray<ListingView>;
  /** 信念市场开放资产视图（隐含概率 = 系统对该断言的市场定价；Phase 2） */
  beliefs?: ReadonlyArray<BeliefView>;
  /** 系统信号（成功率/质量/负载等数值观测，键由宿主定义） */
  signals: Readonly<Record<string, number>>;
}

export type ProposalKind =
  | 'list-knowledge' // 挂卖知识（bid=要价 ask）
  | 'buy-knowledge' // 买入知识（bid=出价）
  | 'maintenance' // 记忆维护等低成本行动
  | 'evolution' // 沙盒进化等高成本行动
  | 'exploration' // 好奇探索
  | 'bet-belief' // 信念下注（bid=预算上限；把价格推向自己的估计）
  | 'idle'; // 空转（零成本，维持在线）

/** 智能体提案：意图 + 出价。运行时/市场/监管批准后才生效 */
export interface AgentProposal {
  id: string;
  kind: ProposalKind;
  description: string;
  /** 行动类=愿意支付的能量；list-knowledge=要价；bet-belief=下注预算上限 */
  bid: number;
  /** 关联知识引用（记忆指纹 / 策略 id / 市场 assetId / 信念 assetId） */
  assetRef?: string;
  /** 挂卖时的申报质量（0~1，成交后由使用证据校准） */
  claimedQuality?: number;
  /** 挂卖/购买的资产种类（pattern/semantic/procedural/strategy/policy-gene 等） */
  assetKind?: string;
  /** bet-belief：下注方向 */
  outcome?: 'YES' | 'NO';
  /** bet-belief：自己对该方向的估计概率（把市场价格推到此值，激励相容动作） */
  targetPrice?: number;
  /** 提案有效期（心跳轮数，缺省 1） */
  ttlTicks?: number;
}

/** 执行授权：能量已预扣托管，智能体据此执行被批准的行动 */
export interface ExecutionGrant {
  agentId: string;
  proposal: AgentProposal;
  /** 已托管（escrow）的能量预算 */
  budget: number;
  approvedAt: number;
}

/** 行动结果 */
export interface ActionResult {
  success: boolean;
  /** 申报价值估计（0~1，供分红与信誉观测参考） */
  valueEstimate: number;
  summary: string;
  data?: unknown;
}

/**
 * 智能体契约（共生层第五阶段契约；稳定后可提升至 contracts.ts）。
 *
 * 实现方约束：
 * - propose() 必须为同步纯决策（基于最近一次 perceive 的快照），不得有副作用；
 * - execute() 只在收到 ExecutionGrant 后被调用，重操作全部放在这里；
 * - 不得缓存 Ledger/Market 引用（构造注入仅限只读回调）。
 */
export interface IAgent {
  readonly id: string;
  readonly kind: AgentKind;
  goal(): AgentGoal;
  mode(): AgentMode;
  reputation(now?: number): AgentReputation;
  perceive(p: Perception): void;
  propose(): AgentProposal[];
  execute(grant: ExecutionGrant): Promise<ActionResult>;
}

/** 可选成交回调：买方智能体实现 notePurchase 时，运行时在成交后自动通知（已购去重的数据来源） */
export interface TradeListener {
  notePurchase(assetId: string, refId: string, price: number): void;
}

/** 结构化能力检测（IAgent 可选能力，非破坏性扩展） */
export function isTradeListener(agent: IAgent): agent is IAgent & TradeListener {
  return typeof (agent as Partial<TradeListener>).notePurchase === 'function';
}

/**
 * 运行时托管钩子（AgentBase 统一提供，自定义智能体请继承 AgentBase）：
 * 模式切换 / 贡献观测 / 收支记账均由运行时驱动——智能体自身无法
 * 自增能量、自切模式，能量与信誉的唯一合法来源在宿主侧。
 */
export interface ManagedAgent extends IAgent {
  setMode(mode: AgentMode): void;
  recordContribution(success: boolean, now?: number): void;
  noteEarnings(amount: number): void;
  noteSpend(amount: number): void;
}

/** 信誉晋级门槛 */
const TIER_SEED_MAX_SAMPLES = 5;
const TIER_ELITE_MIN_SAMPLES = 20;
const TIER_ELITE_MIN_WILSON = 0.6;

/** 冷启动额度缺省曲线（未配 trust 时仅作读数，无执行面影响——零漂移） */
const TRUST_DEFAULTS = {
  allowanceBase: 10,
  allowancePerSample: 4,
  allowanceSampleCap: 60,
  unlockTargetSamples: TIER_ELITE_MIN_SAMPLES,
} as const;

/** 画像缺省参数（未配 profile 时不生效——零漂移） */
const PROFILE_DEFAULTS = {
  bucketMs: 3_600_000,
  buckets: 8,
  shiftQualityDrop: 0.25,
  shiftMinSamples: 4,
  shiftProductivityCollapse: 0.25,
} as const;

/**
 * 智能体基座：证据化信誉 + 收支记账 + 模式切换的共享实现。
 * 子类只需实现 goal/propose/execute（perceive 默认存快照）。
 *
 * 三轮升级：可选 trust 配置开启「观测封顶 + 冷启动额度」——
 * recordContribution 返回是否受纳（窗口封顶时 false，证据零污染）；
 * trustView() 给出额度/解锁进度/拒绝计数（运行时 sybilGuard 消费）。
 */
export abstract class AgentBase implements IAgent {
  abstract readonly kind: AgentKind;

  readonly id: string;
  protected lastPerception: Perception | undefined;
  private modeFlag: AgentMode = 'active';
  private readonly evidence: MemoryEvidence;
  private earningsTotal = 0;
  private spendTotal = 0;
  private proposalCounter = 0;
  /** ── 三轮升级：观测封顶台账 ── */
  private readonly trust: Required<Pick<AgentTrustConfig, 'allowanceBase' | 'allowancePerSample' | 'allowanceSampleCap' | 'unlockTargetSamples'>> &
    Pick<AgentTrustConfig, 'observationWindowMs' | 'maxObservationsPerWindow'>;
  /** 当前计入窗口内的观测时间戳 */
  private observationTimestamps: number[] = [];
  private creditedCount = 0;
  private rejectedCount = 0;
  /** ── 四轮升级：三维画像台账（未配置 = undefined，零记录零漂移） ── */
  private readonly profileCfg: Required<ContributorProfileConfig> | undefined;
  private profileBuckets = new Map<number, { credits: number; successes: number; refs: Set<string> }>();

  constructor(id: string, createdAt: number = Date.now(), trust: AgentTrustConfig = {}, profile?: ContributorProfileConfig) {
    this.id = id;
    this.evidence = initEvidence(0, 0, createdAt);
    this.trust = {
      allowanceBase: trust.allowanceBase ?? TRUST_DEFAULTS.allowanceBase,
      allowancePerSample: trust.allowancePerSample ?? TRUST_DEFAULTS.allowancePerSample,
      allowanceSampleCap: trust.allowanceSampleCap ?? TRUST_DEFAULTS.allowanceSampleCap,
      unlockTargetSamples: trust.unlockTargetSamples ?? TRUST_DEFAULTS.unlockTargetSamples,
      observationWindowMs: trust.observationWindowMs,
      maxObservationsPerWindow: trust.maxObservationsPerWindow,
    };
    this.profileCfg = profile
      ? {
          bucketMs: Math.max(1, profile.bucketMs ?? PROFILE_DEFAULTS.bucketMs),
          buckets: Math.max(2, Math.min(64, profile.buckets ?? PROFILE_DEFAULTS.buckets)),
          shiftQualityDrop: Math.min(1, Math.max(0, profile.shiftQualityDrop ?? PROFILE_DEFAULTS.shiftQualityDrop)),
          shiftMinSamples: Math.max(1, profile.shiftMinSamples ?? PROFILE_DEFAULTS.shiftMinSamples),
          shiftProductivityCollapse: Math.min(1, Math.max(0, profile.shiftProductivityCollapse ?? PROFILE_DEFAULTS.shiftProductivityCollapse)),
        }
      : undefined;
  }

  abstract goal(): AgentGoal;

  perceive(p: Perception): void {
    this.lastPerception = p;
  }

  /** 默认空转提案（子类按角色覆写） */
  propose(): AgentProposal[] {
    return [this.proposal('idle', '空转观测', 0)];
  }

  /** 默认 no-op 执行（市场类提案无需 execute，由运行时直接撮合） */
  async execute(grant: ExecutionGrant): Promise<ActionResult> {
    return {
      success: true,
      valueEstimate: 0,
      summary: `no-op:${grant.proposal.kind}`,
    };
  }

  mode(): AgentMode {
    return this.modeFlag;
  }

  /** 模式切换由运行时驱动（休眠/复活），智能体自身只读 */
  setMode(mode: AgentMode): void {
    this.modeFlag = mode;
  }

  /**
   * 贡献观测（由运行时在任务结算时回调）——信誉的唯一来源。
   *
   * 三轮升级（观测封顶）：配置了 observationWindowMs + maxObservationsPerWindow
   * 时，窗口内已计入达上限的观测被拒绝（返回 false、计入拒绝计数、证据零
   * 污染）——同一时间窗内刷一千次成功只认上限次，Wilson 下界的小样本保守
   * 性不可被高频刷分冲破。未配置时恒受纳（旧行为零漂移）。
   *
   * 四轮升级（画像喂料）：受纳观测同步落入画像桶（配置了 profile 时）；
   * impact.refId 记录本次贡献触达的对象（影响半径的 distinct 口径），
   * 缺省不计——调用方零改动零漂移。
   */
  recordContribution(success: boolean, now: number = Date.now(), impact?: { refId?: string }): boolean {
    if (!this.admitObservation(now)) {
      this.rejectedCount += 1;
      return false;
    }
    this.creditedCount += 1;
    observeEvidence(this.evidence, success, now);
    if (this.profileCfg) {
      const idx = Math.floor(now / this.profileCfg.bucketMs);
      const bucket = this.profileBuckets.get(idx) ?? { credits: 0, successes: 0, refs: new Set<string>() };
      bucket.credits += 1;
      if (success) bucket.successes += 1;
      if (impact?.refId) bucket.refs.add(impact.refId);
      this.profileBuckets.set(idx, bucket);
      // 滚动窗口裁剪：只保留最近 buckets 个桶索引
      const oldest = idx - this.profileCfg.buckets + 1;
      for (const key of this.profileBuckets.keys()) {
        if (key < oldest) this.profileBuckets.delete(key);
      }
    }
    return true;
  }

  /**
   * 贡献者三维画像（四轮升级）：生产率 / 质量 / 影响半径 + 趋势 + 突变检测。
   * 未配置 profile（构造缺省）→ undefined——画像能力完全 opt-in。
   *
   * 突变检测口径：最新有观测桶 vs 其余桶基线——
   * - 质量骤降：基线成功率 − 最新成功率 ≥ shiftQualityDrop 且两侧样本
   *   均 ≥ shiftMinSamples（长期 0.9 突然掉到 0.2 → 检出，magnitude=0.7）；
   * - 生产率坍缩：最新桶 credits < 基线均值 × collapse 且基线均值 ≥
   *   shiftMinSamples（产出断崖 → 检出）。
   */
  profile(now: number = Date.now()): ContributorProfileView | undefined {
    if (!this.profileCfg) return undefined;
    const cfg = this.profileCfg;
    const currentIdx = Math.floor(now / cfg.bucketMs);
    const oldest = currentIdx - cfg.buckets + 1;
    const live = [...this.profileBuckets.entries()].filter(([idx]) => idx >= oldest).sort((a, b) => a[0] - b[0]);
    const views: ProfileBucketView[] = live.map(([index, b]) => ({
      index,
      credits: b.credits,
      successes: b.successes,
      refs: b.refs.size > 0 ? b.refs.size : b.credits,
    }));
    const totalCredits = views.reduce((a, b) => a + b.credits, 0);
    const totalSuccesses = views.reduce((a, b) => a + b.successes, 0);
    const productivity = totalCredits / cfg.buckets;
    const quality = totalCredits > 0 ? totalSuccesses / totalCredits : 0;
    const refUnion = new Set<string>();
    let refsProvided = false;
    for (const [, b] of live) {
      if (b.refs.size > 0) refsProvided = true;
      for (const r of b.refs) refUnion.add(r);
    }
    const impactRadius = refsProvided ? refUnion.size : totalCredits;
    const composite = quality * Math.log1p(productivity);

    // 趋势：窗口前半 vs 后半的桶产出（credits × 桶质量 = successes）
    const half = Math.max(1, Math.floor(views.length / 2));
    const firstHalf = views.slice(0, views.length - half);
    const secondHalf = views.slice(views.length - half);
    const meanSuccesses = (arr: ProfileBucketView[]): number => (arr.length === 0 ? 0 : arr.reduce((a, b) => a + b.successes, 0) / arr.length);
    const firstHalfMean = meanSuccesses(firstHalf);
    const secondHalfMean = meanSuccesses(secondHalf);
    const trendThreshold = Math.max(0.5, 0.2 * firstHalfMean);
    const direction = secondHalfMean - firstHalfMean > trendThreshold ? 'rising' : firstHalfMean - secondHalfMean > trendThreshold ? 'falling' : 'stable';

    // 突变检测：最新桶 vs 基线（其余桶）
    let shift: ContributorProfileView['shift'] = { detected: false };
    if (views.length >= 2) {
      const latest = views[views.length - 1]!;
      const baselineViews = views.slice(0, -1);
      const baselineCredits = baselineViews.reduce((a, b) => a + b.credits, 0);
      const baselineSuccesses = baselineViews.reduce((a, b) => a + b.successes, 0);
      const baselineQuality = baselineCredits > 0 ? baselineSuccesses / baselineCredits : 0;
      const latestQuality = latest.credits > 0 ? latest.successes / latest.credits : 0;
      if (baselineCredits >= cfg.shiftMinSamples && latest.credits >= cfg.shiftMinSamples) {
        const drop = baselineQuality - latestQuality;
        if (drop >= cfg.shiftQualityDrop) {
          shift = {
            detected: true,
            metric: 'quality',
            magnitude: drop,
            detail: `质量骤降：基线 ${baselineQuality.toFixed(2)}（${baselineCredits} 样本）→ 最新桶 ${latestQuality.toFixed(2)}（${latest.credits} 样本），Δ${drop.toFixed(2)} ≥ ${cfg.shiftQualityDrop}`,
          };
        }
      }
      if (!shift.detected) {
        const baselineRate = baselineCredits / baselineViews.length;
        if (baselineRate >= cfg.shiftMinSamples && latest.credits < baselineRate * cfg.shiftProductivityCollapse) {
          shift = {
            detected: true,
            metric: 'productivity',
            magnitude: 1 - latest.credits / baselineRate,
            detail: `生产率坍缩：基线均值 ${baselineRate.toFixed(1)}/桶 → 最新桶 ${latest.credits}（< ${Math.round(cfg.shiftProductivityCollapse * 100)}% 基线）`,
          };
        }
      }
    }

    return {
      agentId: this.id,
      productivity,
      quality,
      impactRadius,
      composite,
      samples: totalCredits,
      trend: { firstHalf: firstHalfMean, secondHalf: secondHalfMean, direction },
      shift,
      buckets: views,
    };
  }

  reputation(now: number = Date.now()): AgentReputation {
    const view = readEvidence(this.evidence, now);
    return {
      tier: tierOf(view),
      effectiveSamples: view.effectiveSamples,
      posteriorMean: view.posteriorMean,
      wilsonLower: view.wilsonLower,
      earnings: this.earningsTotal,
      spend: this.spendTotal,
      netFlow: this.earningsTotal - this.spendTotal,
      spendAllowance: this.allowanceAt(view.effectiveSamples),
    };
  }

  /**
   * 信任视图（三轮升级：女巫抵抗 + 信誉衰减的机器可读读数）。
   * spendAllowance 以时间加权有效样本解锁——新账户低额度、停更账户
   * （30 天半衰期）自然收缩、持续贡献者按历史解锁。
   */
  trustView(now: number = Date.now()): AgentTrustView {
    const view = readEvidence(this.evidence, now);
    const effectiveSamples = view.effectiveSamples;
    const stalenessFactor = decayFactor(Math.max(0, now - this.evidence.lastDecayedAt));
    const unlockProgress = Math.min(1, effectiveSamples / Math.max(1, this.trust.unlockTargetSamples));
    return {
      agentId: this.id,
      tier: tierOf(view),
      effectiveSamples,
      stalenessFactor,
      spendAllowance: this.allowanceAt(effectiveSamples),
      unlockProgress,
      established: unlockProgress >= 1,
      creditedObservations: this.creditedCount,
      rejectedObservations: this.rejectedCount,
      observationsInWindow: this.observationTimestamps.length,
    };
  }

  /** 冷启动额度：base + per × min(有效样本, cap)（时间加权样本即衰减联动） */
  private allowanceAt(effectiveSamples: number): number {
    return this.trust.allowanceBase + this.trust.allowancePerSample * Math.min(Math.max(0, effectiveSamples), this.trust.allowanceSampleCap);
  }

  /** 观测窗口准入：滑出过期时间戳后仍有空位才受纳 */
  private admitObservation(now: number): boolean {
    const windowMs = this.trust.observationWindowMs;
    const cap = this.trust.maxObservationsPerWindow;
    if (windowMs === undefined || cap === undefined || !Number.isFinite(windowMs) || !Number.isFinite(cap) || cap <= 0) return true;
    this.observationTimestamps = this.observationTimestamps.filter((t) => now - t < windowMs);
    if (this.observationTimestamps.length >= cap) return false;
    this.observationTimestamps.push(now);
    return true;
  }

  /** 收入记账（由运行时经账本/市场回调，智能体不可自增） */
  noteEarnings(amount: number): void {
    if (amount > 0) this.earningsTotal += amount;
  }

  /** 支出记账 */
  noteSpend(amount: number): void {
    if (amount > 0) this.spendTotal += amount;
  }

  /** 提案 id 生成（id 稳定可追溯） */
  protected proposal(kind: ProposalKind, description: string, bid: number, extra: Partial<AgentProposal> = {}): AgentProposal {
    this.proposalCounter += 1;
    return {
      id: `${this.id}#${this.proposalCounter}`,
      kind,
      description,
      bid,
      ttlTicks: 1,
      ...extra,
    };
  }
}

/** 结构化能力检测：AgentBase 子类（或 duck-type 兼容者）携带 trustView 读数 */
export function hasTrustView(agent: IAgent): agent is IAgent & { trustView(now?: number): AgentTrustView } {
  return typeof (agent as Partial<AgentBase>).trustView === 'function';
}

function tierOf(view: EvidenceView): ReputationTier {
  if (view.effectiveSamples < TIER_SEED_MAX_SAMPLES) return 'seed';
  if (view.effectiveSamples >= TIER_ELITE_MIN_SAMPLES && view.wilsonLower >= TIER_ELITE_MIN_WILSON) return 'elite';
  return 'established';
}
