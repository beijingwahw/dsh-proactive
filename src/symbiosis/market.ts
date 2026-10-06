/**
 * market.ts — 认知市场（共生进化架构第五阶段 3/4）
 *
 * 知识（记忆模式 / 蒸馏策略 / 语义规律 / 程序规则 / 策略基因）作为
 * 可交易资产：卖方挂 ask（付挂单费防垃圾信息），买方出 bid，
 * 价格交叉即成交——连续双向拍卖机制（与股票市场同构）。
 *
 * 两个激励相容关键设计：
 *
 * 1. 挂单费 burn（燃烧而非给市场）：发挂单信息本身有成本，
 *    无限免费挂单会淹没市场；费用随要价比例收取。
 *
 * 2. 售后分成（royalty）由央行国库支付，而非买方支付：
 *    若从买方扣分成，买方有动机谎报「没用上/失败了」逃避抽成；
 *    若由央行对「知识被验证有效」铸币奖励卖方，买方报告零成本，
 *    且使用反馈由运行时在任务结算时自动回填（买卖双方均无法操纵）。
 *    —— 这是解决知识定价「阿罗信息悖论」（买前不知值不值，知道后
 *    不想付钱）的机制化答案：卖方收入 = 成交价 + 持续分成，
 *    只有真正有效的知识才能持续产生分成，劣质知识自然被证据淘汰。
 *
 * 资产级证据：每笔资产携带 MemoryEvidence，使用反馈持续观测——
 * 申报质量（claimedQuality）与实测证据的偏离构成「质量欺骗」信号，
 * 供监管层下架/罚没（Phase 2 扩展点）。
 *
 * 三轮升级（订单簿不变量引擎）：
 * 1. 价格-时间优先级显式化：compareBidsPriceTime（价格降序 → 时间升序 →
 *    全局序号决胜）成为唯一撮合排序准则，同价先到先得从「排序稳定性
 *    的隐式副作用」升格为可测试的显式契约（orderBook/bestBid 可观测）；
 * 2. 撮合后不变量审计：每轮 match() 自动执行 I1~I5 审计（支付=收入、
 *    账实相符、无负持仓、订单簿一致、版税记账），从链式账本 journal
 *    独立重算对账——随机订单流下全部不变量恒成立成为机器可查性质。
 *
 * 四轮升级（全新维度 ×3）：
 * 1. 流动性度量：liquidity()/slippage() 给出最优买卖价差（绝对 + bps）、
 *    买侧深度、给定规模的吃单滑点估计（前 k 档 VWAM 相对最优价的折让，
 *    随规模单调非降）——「这个知识市场好不好成交」第一次有了量化读数；
 * 2. 条件结算合约：openDeliveryContract/settleDelivery——买方货款与
 *    卖方违约保证金双托管，交付确认后按质量三路结算（≥fullQualityAt
 *    全额 / 部分按质量比例 / 违约退款+保证金罚没），违约以 'contract-breach'
 *    凭证入账；auditContracts() 从账本独立重算托管守恒（入 = 出 + 在途）；
 * 3. 市场操纵检测：scanManipulation() 对同主体对敲（卖家在自己资产上
 *    挂买单）与异常短周期交易密度（窗口内同买/卖/资产组合反复成交）
 *    做启发式检出——正常分散交易零误报。
 */

import { initEvidence, observeEvidence, readEvidence, type MemoryEvidence } from '../core/evidence.js';
import type { ListingView, MarketSnapshot } from './agent.js';
import { ESCROW, TREASURY, type AccountId, type EnergyLedger } from './ledger.js';

/** 知识资产种类 */
export type AssetKind = 'pattern' | 'semantic' | 'procedural' | 'strategy' | 'policy-gene' | 'model-profile';

/** 挂单中的知识资产（引用底层知识本体，不复制数据） */
export interface KnowledgeAsset {
  id: string;
  kind: AssetKind;
  seller: AccountId;
  /** 底层知识引用（记忆指纹 / 策略 id 等） */
  refId: string;
  description: string;
  /** 要价（能量） */
  ask: number;
  /** 卖方申报质量（0~1，成交后由使用证据校准） */
  claimedQuality: number;
  /** 售后分成比例（相对最近成交价） */
  royaltyRate: number;
  listedAt: number;
  /** 成交次数 */
  sales: number;
  /** 最近成交价（分成基数） */
  lastPrice: number;
  /** 资产级使用证据 */
  evidence: MemoryEvidence;
}

/** 买单 */
export interface BidOrder {
  id: string;
  bidder: AccountId;
  assetId: string;
  price: number;
  placedAt: number;
  /** 全局单调序号（三轮升级：价格-时间优先级的显式最终决胜键） */
  seq?: number;
}

/**
 * 订单簿价格-时间优先级比较器（三轮升级显式化）。
 *
 * 规则：价格高者优先；同价先到先得（placedAt 早者优先）；
 * 同毫秒并列时按全局序号 seq 决胜（严格全序，杜绝并列歧义）。
 */
export function compareBidsPriceTime(a: BidOrder, b: BidOrder): number {
  if (a.price !== b.price) return b.price - a.price;
  if (a.placedAt !== b.placedAt) return a.placedAt - b.placedAt;
  return (a.seq ?? 0) - (b.seq ?? 0);
}

/**
 * 撮合后不变量审计报告（三轮升级：连续双向拍卖的机器可查守恒律）。
 *
 * I1 支付=收入：Σ(买方支付) === Σ(卖方收入) === 累计成交额（复式守恒）；
 * I2 账实相符：每笔成交记录在链式账本中恰有一张同额同向的 market-trade
 *     凭证（trades ↔ journal 一一对应）；
 * I3 无负持仓：账本全部账户余额 ≥ 0（买单不预锁、成交时原子划转的必然推论）；
 * I4 订单簿一致：存活订单全部 price>0 且指向在市资产；成交后订单簿清空；
 * I5 版税记账：市场累计版税支付 === 账本 royalty 凭证之和（央行支付口径）。
 */
export interface MarketInvariantReport {
  checkedAt: number;
  /** 审计覆盖的成交笔数 */
  tradeCount: number;
  /** I1 支付 === 收入 === volumeTraded */
  paymentsEqualIncome: boolean;
  /** I2 每笔成交有唯一同额账本凭证 */
  tradeReceiptsMatch: boolean;
  /** I3 全账户余额 ≥ 0 */
  noNegativeBalances: boolean;
  /** I4 订单簿与在市资产一致、成交后无残留 */
  bookConsistent: boolean;
  /** I5 版税累计与账本凭证一致 */
  royaltyAccounting: boolean;
  /** 全部不变量成立 */
  intact: boolean;
  /** 违规明细（intact = false 时非空） */
  violations: string[];
}

/** 成交记录 */
export interface TradeRecord {
  seq: number;
  assetId: string;
  assetKind: AssetKind;
  buyer: AccountId;
  seller: AccountId;
  price: number;
  timestamp: number;
}

/** 售后分成支付凭证 */
export interface RoyaltyPayout {
  assetId: string;
  seller: AccountId;
  amount: number;
  /** 有效使用次数（累计） */
  confirmedUses: number;
}

export interface MarketConfig {
  /** 挂单费率（相对 ask，燃烧；默认 0.1） */
  listingFeeRate?: number;
  /** 默认售后分成比例（默认 0.2） */
  defaultRoyaltyRate?: number;
  /** 最大同时挂单数（默认 64） */
  maxAssets?: number;
}

export type ListError = 'non-positive-ask' | 'duplicate-ref' | 'market-full' | 'listing-fee-unaffordable' | 'insufficient-quality';

// ═════════════════ 四轮升级 1：流动性度量（价差/深度/滑点） ═════════════════

/**
 * 资产流动性指标（只读快照；订单簿的「好不好成交」量化读数）。
 *
 * 口径：本市场为单卖方要价 × 多买方竞价的连续双向拍卖——
 * - spread = ask − 最优买价（bestBid 缺席 = 无对手盘，价差记为 ask 本身）；
 * - bidDepth = Σ(全部在簿买单价格)（买侧深度：能承接的卖出总额）；
 * - 滑点估计见 slippage()：卖方吃前 k 档的 VWAP 相对最优价的折让。
 */
export interface LiquidityMetrics {
  assetId: string;
  ask: number;
  /** 最优买价（无买单 undefined） */
  bestBid: number | undefined;
  /** 买卖价差 = ask − bestBid（无买单 = ask） */
  spread: number;
  /** 价差相对中间价的万分比（ask 与 bestBid 均在场时 (ask+bestBid)/2 为中间价） */
  spreadBps: number;
  /** 买侧深度（Σ 在簿买单价格） */
  bidDepth: number;
  /** 在簿买单数 */
  bidCount: number;
}

// ═════════════════ 四轮升级 2：条件结算合约（交付托管制） ═════════════════

/** 合约状态：待交付 → 已结算 / 违约 */
export type DeliveryStatus = 'open' | 'settled' | 'breached';

/** 条件结算合约（可观测视图） */
export interface DeliveryContractView {
  id: string;
  assetId: string;
  buyer: AccountId;
  seller: AccountId;
  /** 托管货款（买方已付入 escrow） */
  price: number;
  /** 卖方违约保证金（已付入 escrow；违约罚没给买方） */
  deposit: number;
  /** 全额结算的质量线（≥ 此值全额，否则按质量比例） */
  fullQualityAt: number;
  status: DeliveryStatus;
  /** 结算时确认的交付质量（违约 = undefined） */
  quality: number | undefined;
  /** 结算付给卖方的货款部分 */
  toSeller: number | undefined;
  /** 退还买方的货款部分 */
  refundedToBuyer: number | undefined;
  /** 违约罚没给买方的保证金 */
  penaltyToBuyer: number | undefined;
  openedAt: number;
  settledAt: number | undefined;
}

/** 三路结算模式 */
export type DeliverySettleMode = 'full' | 'partial' | 'breach';

/** 结算报告（能量分配的全量明细——按约分配的可审计凭证） */
export interface ContractSettlementReport {
  contractId: string;
  assetId: string;
  mode: DeliverySettleMode;
  quality: number | undefined;
  /** 货款中付给卖方的部分 */
  toSeller: number;
  /** 货款中退还买方的部分 */
  refundBuyer: number;
  /** 违约罚没给买方的保证金（仅 breach） */
  penaltyToBuyer: number;
  /** 卖方保证金原路退回（违约除外） */
  depositReturned: number;
}

/** 托管守恒审计报告（合约通道的机器可查守恒律） */
export interface ContractAuditReport {
  checkedAt: number;
  contracts: number;
  open: number;
  breached: number;
  /** 账本口径：Σ(contract-escrow + contract-stake) */
  escrowedIn: number;
  /** 账本口径：Σ(contract-settle + contract-unstake + contract-refund + contract-breach) */
  releasedOut: number;
  /** 合约台账口径：在途托管 = Σ(open 合约的 price + deposit) */
  openEscrowed: number;
  /** 入 − 出 === 在途（两口径独立重算对账） */
  conserved: boolean;
  /** 账本 'contract-breach' 凭证数 === 违约合约数（违约记录入账一一对应） */
  breachesRecorded: boolean;
  violations: string[];
}

export type DeliveryError =
  | 'unknown-asset'
  | 'unknown-account'
  | 'self-dealing'
  | 'non-positive-price'
  | 'insufficient-funds'
  | 'seller-stake-failed'
  | 'unknown-contract'
  | 'not-open';

// ═════════════════ 四轮升级 3：市场操纵检测（对敲/短周期爆发） ═════════════════

/** 操纵检出类型 */
export type ManipulationKind = 'self-dealing' | 'burst-cycling';

/** 单条操纵检出（含证据明细，可审计） */
export interface ManipulationFinding {
  kind: ManipulationKind;
  /** 关联资产（self-dealing）/ 组合主体（burst-cycling） */
  assetId: string;
  participants: string[];
  /** 窗口内证据次数 */
  count: number;
  windowMs: number;
  detail: string;
}

/** 操纵扫描报告（clean = 正常市场零误报） */
export interface ManipulationReport {
  checkedAt: number;
  windowMs: number;
  findings: ManipulationFinding[];
  clean: boolean;
}

/** 操纵扫描配置 */
export interface ManipulationScanConfig {
  /** 短周期窗口宽度（默认 60_000 ms） */
  windowMs?: number;
  /** 窗口内同 (buyer,seller,asset) 成交数阈值（默认 3） */
  cycleThreshold?: number;
  /** 扫描时刻（注入时钟；默认 Date.now()） */
  now?: number;
}

let assetCounter = 0;
let bidCounter = 0;
let tradeCounter = 0;
let contractCounter = 0;

/** 交付合约台账（四轮升级 2；id → 合约） */
interface DeliveryContract {
  id: string;
  assetId: string;
  buyer: AccountId;
  seller: AccountId;
  price: number;
  deposit: number;
  fullQualityAt: number;
  status: DeliveryStatus;
  quality?: number;
  toSeller?: number;
  refundedToBuyer?: number;
  penaltyToBuyer?: number;
  openedAt: number;
  settledAt?: number;
}

export class CognitiveMarket {
  private assets = new Map<string, KnowledgeAsset>();
  private bidsByAsset = new Map<string, BidOrder[]>();
  private trades: TradeRecord[] = [];
  private volumeTraded = 0;
  /** 累计央行版税支付（I5 审计的市场侧计数） */
  private royaltyTotal = 0;
  /** 版税支付的账本 seq 台账（窗口内与 journal 对账用） */
  private royaltyEvents: Array<{ seq: number; amount: number }> = [];
  private lastAudit: MarketInvariantReport | undefined;
  /** ── 四轮升级 2：条件结算合约台账 ── */
  private contracts = new Map<string, DeliveryContract>();
  /** ── 四轮升级 3：挂单审计尾迹（对敲检测证据；环窗 4096） ── */
  private bidTrail: Array<{ bidder: AccountId; assetId: string; ts: number; selfDealing: boolean }> = [];
  private readonly listingFeeRate: number;
  private readonly defaultRoyaltyRate: number;
  private readonly maxAssets: number;

  constructor(
    private readonly ledger: EnergyLedger,
    config: MarketConfig = {},
  ) {
    this.listingFeeRate = Math.max(0, config.listingFeeRate ?? 0.1);
    this.defaultRoyaltyRate = Math.min(1, Math.max(0, config.defaultRoyaltyRate ?? 0.2));
    this.maxAssets = Math.max(1, config.maxAssets ?? 64);
  }

  /** 挂单要价：立即燃烧挂单费（防垃圾信息），同 refId 去重 */
  list(input: {
    seller: AccountId;
    kind: AssetKind;
    refId: string;
    description: string;
    ask: number;
    claimedQuality: number;
    royaltyRate?: number;
  }): { ok: boolean; error?: ListError; assetId?: string; listingFee?: number } {
    if (!(input.ask > 0)) return { ok: false, error: 'non-positive-ask' };
    if (input.claimedQuality < 0 || input.claimedQuality > 1) return { ok: false, error: 'insufficient-quality' };
    for (const asset of this.assets.values()) {
      if (asset.refId === input.refId) return { ok: false, error: 'duplicate-ref' };
    }
    if (this.assets.size >= this.maxAssets) return { ok: false, error: 'market-full' };

    const listingFee = Math.ceil(input.ask * this.listingFeeRate);
    if (listingFee > 0) {
      const fee = this.ledger.transfer(input.seller, 'burn', listingFee, 'listing-fee', input.refId);
      if (!fee.ok) return { ok: false, error: 'listing-fee-unaffordable' };
    }

    assetCounter += 1;
    const asset: KnowledgeAsset = {
      id: `asset-${assetCounter}`,
      kind: input.kind,
      seller: input.seller,
      refId: input.refId,
      description: input.description,
      ask: input.ask,
      claimedQuality: input.claimedQuality,
      royaltyRate: input.royaltyRate ?? this.defaultRoyaltyRate,
      listedAt: Date.now(),
      sales: 0,
      lastPrice: 0,
      evidence: initEvidence(0, 0, Date.now()),
    };
    this.assets.set(asset.id, asset);
    return { ok: true, assetId: asset.id, listingFee };
  }

  /**
   * 出价买单（竞价；撮合时按价格-时间优先级取最优）。
   * @param now 下单时刻（注入时钟；缺省 Date.now()）
   */
  placeBid(bidder: AccountId, assetId: string, price: number, now: number = Date.now()): { ok: boolean; error?: string } {
    const asset = this.assets.get(assetId);
    if (!asset) return { ok: false, error: 'unknown-asset' };
    if (!(price > 0)) return { ok: false, error: 'non-positive-price' };
    if (this.ledger.balance(bidder) < price) return { ok: false, error: 'insufficient-funds' };
    bidCounter += 1;
    const bids = this.bidsByAsset.get(assetId) ?? [];
    bids.push({ id: `bid-${bidCounter}`, bidder, assetId, price, placedAt: now, seq: bidCounter });
    this.bidsByAsset.set(assetId, bids);
    // 四轮升级 3：挂单尾迹（卖家挂自己资产 = 对敲证据，检测期取证用）
    this.bidTrail.push({ bidder, assetId, ts: now, selfDealing: bidder === asset.seller });
    if (this.bidTrail.length > 4096) this.bidTrail.splice(0, this.bidTrail.length - 4096);
    return { ok: true };
  }

  /** 卖家下架（无费用；已付挂单费不退——信息发布成本已发生） */
  delist(seller: AccountId, assetId: string): boolean {
    const asset = this.assets.get(assetId);
    if (!asset || asset.seller !== seller) return false;
    this.assets.delete(assetId);
    this.bidsByAsset.delete(assetId);
    return true;
  }

  /**
   * 某资产的当前最优买价（价格-时间优先级口径；无订单 undefined）
   */
  bestBid(assetId: string): BidOrder | undefined {
    const bids = this.bidsByAsset.get(assetId);
    if (!bids || bids.length === 0) return undefined;
    return { ...([...bids].sort(compareBidsPriceTime)[0]!) };
  }

  /** 订单簿视图（价格-时间优先级排序的拷贝；审计/观测用） */
  orderBook(assetId: string): BidOrder[] {
    const bids = this.bidsByAsset.get(assetId);
    return bids ? [...bids].sort(compareBidsPriceTime).map((b) => ({ ...b })) : [];
  }

  /**
   * 撮合：对每个资产按**价格-时间优先级**取最优买价，price >= ask 则成交。
   * 能量 buyer → seller；成交后该资产买单清空。
   * 每轮撮合后自动执行不变量审计（守恒/账实相符/无负持仓），违规留痕
   * lastAudit() 供监管层读取——撮合引擎自身成为自身的审计员。
   * @param now 成交时刻（注入时钟；缺省 Date.now()）
   */
  match(now: number = Date.now()): TradeRecord[] {
    const executed: TradeRecord[] = [];
    for (const asset of this.assets.values()) {
      const bids = this.bidsByAsset.get(asset.id) ?? [];
      if (bids.length === 0) continue;
      const best = [...bids].sort(compareBidsPriceTime)[0]!;
      if (best.price < asset.ask) continue;
      const receipt = this.ledger.transfer(best.bidder, asset.seller, best.price, 'market-trade', asset.id);
      if (!receipt.ok) continue; // 余额不足等：跳过该资产
      tradeCounter += 1;
      const trade: TradeRecord = {
        seq: tradeCounter,
        assetId: asset.id,
        assetKind: asset.kind,
        buyer: best.bidder,
        seller: asset.seller,
        price: best.price,
        timestamp: now,
      };
      asset.sales += 1;
      asset.lastPrice = best.price;
      this.trades.push(trade);
      this.volumeTraded += best.price;
      this.bidsByAsset.set(asset.id, []);
      executed.push(trade);
    }
    this.lastAudit = this.auditInvariants();
    return executed;
  }

  /**
   * 使用反馈（由运行时在任务结算自动回填，买卖双方无法操纵）：
   * - 观测资产级证据（申报质量的实测校准来源）；
   * - 有效使用 → 央行向卖方支付售后分成（激励相容：买方零成本报告）。
   */
  reportUsage(assetId: string, success: boolean, now: number = Date.now()): RoyaltyPayout | undefined {
    const asset = this.assets.get(assetId);
    if (!asset) return undefined;
    observeEvidence(asset.evidence, success, now);
    if (!success || asset.lastPrice <= 0) return undefined;
    const amount = Math.ceil(asset.lastPrice * asset.royaltyRate);
    if (amount <= 0) return undefined;
    const receipt = this.ledger.transfer(TREASURY, asset.seller, amount, 'royalty', assetId);
    if (!receipt.ok) return undefined; // 国库不足：分成落空但不影响主链路
    this.royaltyTotal += amount;
    this.royaltyEvents.push({ seq: receipt.transfer!.seq, amount });
    if (this.royaltyEvents.length > 4096) this.royaltyEvents.splice(0, this.royaltyEvents.length - 4096);
    return { assetId, seller: asset.seller, amount, confirmedUses: asset.sales };
  }

  getAsset(assetId: string): KnowledgeAsset | undefined {
    const asset = this.assets.get(assetId);
    return asset ? { ...asset, evidence: { ...asset.evidence } } : undefined;
  }

  listAssets(): KnowledgeAsset[] {
    return [...this.assets.values()].map((a) => ({ ...a, evidence: { ...a.evidence } }));
  }

  openBidCount(): number {
    let total = 0;
    for (const bids of this.bidsByAsset.values()) total += bids.length;
    return total;
  }

  tradesLog(limit = 50): TradeRecord[] {
    return this.trades.slice(-limit).map((t) => ({ ...t }));
  }

  /** 累计成交额（能量） */
  volume(): number {
    return this.volumeTraded;
  }

  /** 最近一次撮合后审计快照（撮合自动执行；观测/监管用） */
  lastAuditReport(): MarketInvariantReport | undefined {
    return this.lastAudit ? { ...this.lastAudit, violations: [...this.lastAudit.violations] } : undefined;
  }

  /**
   * 不变量审计（I1~I5，见 MarketInvariantReport 文档）：从链式账本 journal
   * 独立重算，与市场侧簿记逐项对账——撮合引擎的「账实相符」自证。
   * journalLimit 裁剪窗口之外的成交不参与 I2/I5 的逐笔比对（窗口内仍精确）。
   */
  auditInvariants(): MarketInvariantReport {
    const violations: string[] = [];
    const journal = this.ledger.audit(Number.MAX_SAFE_INTEGER);
    const windowFirstSeq = journal.length > 0 ? journal[0]!.seq : Number.POSITIVE_INFINITY;
    const tradeEntries = journal.filter((t) => t.reason === 'market-trade');
    const royaltyEntries = journal.filter((t) => t.reason === 'royalty');

    // I1 守恒：支付 = 收入 = 累计成交额
    const tradesSum = this.trades.reduce((a, t) => a + t.price, 0);
    const paymentsEqualIncome =
      Math.abs(tradesSum - this.volumeTraded) < 1e-9 &&
      (tradeEntries.length === 0 || Math.abs(tradeEntries.reduce((a, t) => a + t.amount, 0) - this.trades.slice(-tradeEntries.length).reduce((a, t) => a + t.price, 0)) < 1e-9);
    if (!paymentsEqualIncome) violations.push(`I1 支付≠收入：trades Σ=${tradesSum} volume=${this.volumeTraded} journal Σ=${tradeEntries.reduce((a, t) => a + t.amount, 0)}`);

    // I2 账实相符：窗口内每笔成交恰有一张同额同向凭证
    let tradeReceiptsMatch = true;
    const windowTrades = this.trades.slice(-tradeEntries.length);
    if (tradeEntries.length !== windowTrades.length) {
      tradeReceiptsMatch = false;
      violations.push(`I2 成交/凭证数失配：journal ${tradeEntries.length} vs trades ${windowTrades.length}`);
    } else {
      for (let i = 0; i < tradeEntries.length; i += 1) {
        const entry = tradeEntries[i]!;
        const trade = windowTrades[i]!;
        if (entry.from !== trade.buyer || entry.to !== trade.seller || Math.abs(entry.amount - trade.price) > 1e-9 || entry.refId !== trade.assetId) {
          tradeReceiptsMatch = false;
          violations.push(`I2 第 ${i} 笔失配：trade#${trade.seq}(${trade.buyer}→${trade.seller} ${trade.price}) vs journal#${entry.seq}(${entry.from}→${entry.to} ${entry.amount})`);
          break;
        }
      }
    }

    // I3 无负持仓：全账户余额 ≥ 0
    let noNegativeBalances = true;
    for (const [id, bal] of this.ledger.snapshotState().balances) {
      if (bal < -1e-9) {
        noNegativeBalances = false;
        violations.push(`I3 负余额：${id} = ${bal}`);
        break;
      }
    }

    // I4 订单簿一致：订单指向在市资产、价格合法、买方账户存在
    let bookConsistent = true;
    for (const [assetId, bids] of this.bidsByAsset) {
      if (bids.length > 0 && !this.assets.has(assetId)) {
        bookConsistent = false;
        violations.push(`I4 悬空订单簿：资产 ${assetId} 已不在市但残留 ${bids.length} 单`);
        break;
      }
      for (const bid of bids) {
        if (!(bid.price > 0) || !this.ledger.hasAccount(bid.bidder)) {
          bookConsistent = false;
          violations.push(`I4 非法订单：${bid.id} price=${bid.price} bidder=${bid.bidder}`);
          break;
        }
      }
      if (!bookConsistent) break;
    }

    // I5 版税记账：市场累计 === 账本 royalty 凭证（窗口内逐笔等额）
    const expectedRoyalty = this.royaltyEvents.filter((e) => e.seq >= windowFirstSeq).reduce((a, e) => a + e.amount, 0);
    const journalRoyalty = royaltyEntries.reduce((a, t) => a + t.amount, 0);
    const royaltyAccounting = Math.abs(expectedRoyalty - journalRoyalty) < 1e-9;
    if (!royaltyAccounting) violations.push(`I5 版税失配：市场口径 ${expectedRoyalty} vs 账本口径 ${journalRoyalty}`);

    return {
      checkedAt: Date.now(),
      tradeCount: this.trades.length,
      paymentsEqualIncome,
      tradeReceiptsMatch,
      noNegativeBalances,
      bookConsistent,
      royaltyAccounting,
      intact: violations.length === 0,
      violations,
    };
  }

  /** 智能体感知用的脱敏挂单视图 */
  listingViews(): ListingView[] {
    return [...this.assets.values()].map((a) => ({
      assetId: a.id,
      kind: a.kind,
      seller: a.seller,
      ask: a.ask,
      claimedQuality: a.claimedQuality,
      sales: a.sales,
    }));
  }

  snapshot(): MarketSnapshot {
    const last = this.trades.length > 0 ? this.trades[this.trades.length - 1]!.price : 0;
    return {
      listed: this.assets.size,
      openBids: this.openBidCount(),
      trades: this.trades.length,
      volume: this.volumeTraded,
      lastPrice: last,
    };
  }

  /** 资产证据视图（监管/审计用） */
  assetEvidence(assetId: string, now: number = Date.now()) {
    const asset = this.assets.get(assetId);
    if (!asset) return undefined;
    return { claimedQuality: asset.claimedQuality, ...readEvidence(asset.evidence, now) };
  }

  // ═══════════════ 四轮升级 1：流动性度量（价差/深度/滑点估计） ═══════════════

  /**
   * 资产流动性指标（只读）：
   * 最优买卖价差（绝对 + 万分比）、买侧深度（Σ 在簿买单价）、在簿单数。
   * 薄簿 → 价差大/深度小；厚簿 → 价差小/深度大（指标分化的两极对照）。
   */
  liquidity(assetId: string): LiquidityMetrics | undefined {
    const asset = this.assets.get(assetId);
    if (!asset) return undefined;
    const bids = [...(this.bidsByAsset.get(assetId) ?? [])].sort(compareBidsPriceTime);
    const bestBid = bids.length > 0 ? bids[0]!.price : undefined;
    const spread = bestBid === undefined ? asset.ask : asset.ask - bestBid;
    const mid = bestBid === undefined ? asset.ask : (asset.ask + bestBid) / 2;
    return {
      assetId,
      ask: asset.ask,
      bestBid,
      spread,
      spreadBps: mid > 0 ? (spread / mid) * 10_000 : 0,
      bidDepth: bids.reduce((a, b) => a + b.price, 0),
      bidCount: bids.length,
    };
  }

  /**
   * 给定规模的吃单滑点估计：卖方一次性吃掉前 size 档买单时，
   * VWAP（成交量加权均价）相对最优价的折让比例（0~1）。
   *
   * 数学性质：买单按价格降序排列 → 前 k 档 VWAP 随 k 单调非增 →
   * 滑点随 size 单调非降（越吃越深、折让越大）。size > 在簿单数 →
   * undefined（流动性不足，诚实上报而非外推）。
   */
  slippage(assetId: string, size: number): number | undefined {
    const asset = this.assets.get(assetId);
    if (!asset || !(Number.isInteger(size) && size >= 1)) return undefined;
    const bids = [...(this.bidsByAsset.get(assetId) ?? [])].sort(compareBidsPriceTime);
    if (size > bids.length) return undefined;
    const best = bids[0]!.price;
    if (!(best > 0)) return undefined;
    const vwap = bids.slice(0, size).reduce((a, b) => a + b.price, 0) / size;
    return Math.max(0, (best - vwap) / best);
  }

  // ═══════════════ 四轮升级 2：条件结算合约（交付托管制） ═══════════════

  /**
   * 开立条件结算合约：买方货款 + 卖方违约保证金双托管进 escrow——
   * 「先付钱」与「先交付」的信任死结由托管解开，交付质量决定分配。
   * @param opts.price 货款（缺省 = 资产当前要价）
   * @param opts.depositRate 违约保证金率（相对货款，缺省 0.1）
   * @param opts.fullQualityAt 全额结算质量线（缺省 0.9；低于按质量比例）
   */
  openDeliveryContract(
    buyer: AccountId,
    assetId: string,
    opts: { price?: number; depositRate?: number; fullQualityAt?: number } = {},
    now: number = Date.now(),
  ): { ok: boolean; error?: DeliveryError; contractId?: string } {
    const asset = this.assets.get(assetId);
    if (!asset) return { ok: false, error: 'unknown-asset' };
    if (!this.ledger.hasAccount(buyer)) return { ok: false, error: 'unknown-account' };
    if (buyer === asset.seller) return { ok: false, error: 'self-dealing' }; // 对敲防线：不得自买自卖
    const price = opts.price ?? asset.ask;
    if (!(price > 0) || !Number.isFinite(price)) return { ok: false, error: 'non-positive-price' };
    const fullQualityAt = Math.min(1, Math.max(0.01, opts.fullQualityAt ?? 0.9));
    const deposit = Math.ceil(price * Math.min(1, Math.max(0, opts.depositRate ?? 0.1)));
    contractCounter += 1;
    const id = `contract-${contractCounter}`;
    // 买方货款托管（先付入 escrow，交付确认前双方都拿不到）
    const escrowed = this.ledger.transfer(buyer, ESCROW, price, 'contract-escrow', id);
    if (!escrowed.ok) return { ok: false, error: 'insufficient-funds' };
    // 卖方保证金托管（违约的代价：保证金罚没给买方——对赌交付质量）
    if (deposit > 0) {
      const staked = this.ledger.transfer(asset.seller, ESCROW, deposit, 'contract-stake', id);
      if (!staked.ok) {
        this.ledger.transfer(ESCROW, buyer, price, 'contract-refund', id); // 原路退回，不留悬空托管
        return { ok: false, error: 'seller-stake-failed' };
      }
    }
    this.contracts.set(id, {
      id,
      assetId,
      buyer,
      seller: asset.seller,
      price,
      deposit,
      fullQualityAt,
      status: 'open',
      openedAt: now,
    });
    return { ok: true, contractId: id };
  }

  /**
   * 三路结算（交付确认驱动）：
   * - full：quality ≥ fullQualityAt → 卖方得全额货款 + 保证金退回；
   * - partial：0 < quality < fullQualityAt → 卖方得 ⌊price×quality⌋（至少 1）、
   *   余额退买方，保证金退回——「按质量比例」的数学化；
   * - breach：quality 缺失/≤0（未交付或交付无价值）→ 货款全额退买方、
   *   保证金罚没给买方（'contract-breach' 凭证入账 = 违约留痕）。
   */
  settleDelivery(contractId: string, quality: number | undefined, now: number = Date.now()): ContractSettlementReport | undefined {
    const contract = this.contracts.get(contractId);
    if (!contract) return undefined;
    if (contract.status !== 'open') return undefined;
    const valid = quality !== undefined && Number.isFinite(quality) && quality > 0;
    const mode: DeliverySettleMode = !valid ? 'breach' : quality! >= contract.fullQualityAt ? 'full' : 'partial';
    let toSeller = 0;
    let refundBuyer = 0;
    let penaltyToBuyer = 0;
    let depositReturned = 0;
    if (mode === 'full') {
      toSeller = contract.price;
      depositReturned = contract.deposit;
      this.ledger.transfer(ESCROW, contract.seller, toSeller, 'contract-settle', contractId);
      if (depositReturned > 0) this.ledger.transfer(ESCROW, contract.seller, depositReturned, 'contract-unstake', contractId);
    } else if (mode === 'partial') {
      // 「至少 1」只作整数托底、不得越过货款：price < 1 时 max(1,·) 会反超
      // contract.price——产生负退款并使托管池超付（托管守恒审计的破口）
      toSeller = Math.min(contract.price, Math.max(1, Math.floor(contract.price * quality!)));
      refundBuyer = contract.price - toSeller;
      depositReturned = contract.deposit;
      this.ledger.transfer(ESCROW, contract.seller, toSeller, 'contract-settle', contractId);
      if (refundBuyer > 0) this.ledger.transfer(ESCROW, contract.buyer, refundBuyer, 'contract-refund', contractId);
      if (depositReturned > 0) this.ledger.transfer(ESCROW, contract.seller, depositReturned, 'contract-unstake', contractId);
    } else {
      refundBuyer = contract.price;
      penaltyToBuyer = contract.deposit;
      this.ledger.transfer(ESCROW, contract.buyer, refundBuyer, 'contract-refund', contractId);
      if (penaltyToBuyer > 0) this.ledger.transfer(ESCROW, contract.buyer, penaltyToBuyer, 'contract-breach', contractId);
    }
    contract.status = mode === 'breach' ? 'breached' : 'settled';
    contract.quality = valid ? quality : undefined;
    contract.toSeller = toSeller;
    contract.refundedToBuyer = refundBuyer;
    contract.penaltyToBuyer = penaltyToBuyer;
    contract.settledAt = now;
    return { contractId, assetId: contract.assetId, mode, quality: valid ? quality : undefined, toSeller, refundBuyer, penaltyToBuyer, depositReturned };
  }

  /** 合约台账视图（拷贝；观测/审计用） */
  deliveryContracts(): DeliveryContractView[] {
    return [...this.contracts.values()].map((c) => ({ ...c, quality: c.quality, toSeller: c.toSeller, refundedToBuyer: c.refundedToBuyer, penaltyToBuyer: c.penaltyToBuyer, settledAt: c.settledAt }));
  }

  /** 违约合约清单（违约留痕的台账侧） */
  contractBreaches(): DeliveryContractView[] {
    return this.deliveryContracts().filter((c) => c.status === 'breached');
  }

  /**
   * 合约托管守恒审计：从链式账本 journal 独立重算合约通道四类流量，
   * 与合约台账对账——
   *   Σ(escrow + stake) − Σ(settle + unstake + refund + breach) === Σ(open 的 price+deposit)，
   * 且账本 'contract-breach' 凭证数 === 违约合约数（违约入账一一对应）。
   */
  auditContracts(): ContractAuditReport {
    const violations: string[] = [];
    const journal = this.ledger.audit(Number.MAX_SAFE_INTEGER);
    let escrowedIn = 0;
    let releasedOut = 0;
    let breachEntries = 0;
    for (const t of journal) {
      if (t.reason === 'contract-escrow' || t.reason === 'contract-stake') escrowedIn += t.amount;
      else if (t.reason === 'contract-settle' || t.reason === 'contract-unstake' || t.reason === 'contract-refund') releasedOut += t.amount;
      else if (t.reason === 'contract-breach') {
        releasedOut += t.amount;
        breachEntries += 1;
      }
    }
    const open = [...this.contracts.values()].filter((c) => c.status === 'open');
    const openEscrowed = open.reduce((a, c) => a + c.price + c.deposit, 0);
    const conserved = Math.abs(escrowedIn - releasedOut - openEscrowed) < 1e-9;
    if (!conserved) violations.push(`托管不守恒：入 ${escrowedIn} − 出 ${releasedOut} ≠ 在途 ${openEscrowed}`);
    const breaches = [...this.contracts.values()].filter((c) => c.status === 'breached').length;
    const breachesRecorded = breachEntries === breaches;
    if (!breachesRecorded) violations.push(`违约凭证失配：账本 ${breachEntries} vs 台账 ${breaches}`);
    return {
      checkedAt: Date.now(),
      contracts: this.contracts.size,
      open: open.length,
      breached: breaches,
      escrowedIn,
      releasedOut,
      openEscrowed,
      conserved,
      breachesRecorded,
      violations,
    };
  }

  // ═══════════════ 四轮升级 3：市场操纵检测（对敲/短周期爆发） ═══════════════

  /**
   * 操纵启发式扫描（只读，不干预交易——检测与执法分离）：
   * - self-dealing（对敲）：卖家在自己挂卖的资产上买单（当前在簿）或
   *   窗口内曾挂单（尾迹取证）——制造虚假需求信号的经典手法；
   * - burst-cycling（短周期循环成交）：窗口内同 (buyer,seller,asset)
   *   组合反复成交 ≥ 阈值——高频对倒刷量、虚假成交额的密度特征。
   * 正常分散交易（不同主体、节奏稀疏）→ clean（零误报）。
   */
  scanManipulation(config: ManipulationScanConfig = {}): ManipulationReport {
    const windowMs = config.windowMs ?? 60_000;
    const cycleThreshold = Math.max(2, config.cycleThreshold ?? 3);
    const now = config.now ?? Date.now();
    const findings: ManipulationFinding[] = [];

    // 对敲：窗口内的挂单尾迹 + 窗口外仍挂在簿上的自买单（去重口径：
    // 窗口内的单已由尾迹计数，只补计 placedAt 早于窗口的存量自买）
    const selfBids = new Map<string, number>();
    for (const [assetId, bids] of this.bidsByAsset) {
      const asset = this.assets.get(assetId);
      if (!asset) continue;
      for (const bid of bids) {
        if (bid.bidder === asset.seller && now - bid.placedAt >= windowMs) selfBids.set(assetId, (selfBids.get(assetId) ?? 0) + 1);
      }
    }
    for (const e of this.bidTrail) {
      if (!e.selfDealing || now - e.ts >= windowMs) continue;
      selfBids.set(e.assetId, (selfBids.get(e.assetId) ?? 0) + 1);
    }
    for (const [assetId, count] of selfBids) {
      const asset = this.assets.get(assetId);
      findings.push({
        kind: 'self-dealing',
        assetId,
        participants: asset ? [asset.seller] : ['(已下架)'],
        count,
        windowMs,
        detail: `卖家在自有资产 ${assetId} 上挂买单 ×${count}（窗口 ${(windowMs / 1000).toFixed(0)}s）——自买自卖制造虚假需求`,
      });
    }

    // 短周期循环成交：窗口内同组合成交密度
    const cycles = new Map<string, { count: number; buyer: string; seller: string; assetId: string }>();
    for (const t of this.trades) {
      if (now - t.timestamp >= windowMs) continue;
      const key = `${t.buyer}|${t.seller}|${t.assetId}`;
      const cur = cycles.get(key) ?? { count: 0, buyer: t.buyer, seller: t.seller, assetId: t.assetId };
      cur.count += 1;
      cycles.set(key, cur);
    }
    for (const c of cycles.values()) {
      if (c.count < cycleThreshold) continue;
      findings.push({
        kind: 'burst-cycling',
        assetId: c.assetId,
        participants: [c.buyer, c.seller],
        count: c.count,
        windowMs,
        detail: `${c.buyer} ⇄ ${c.seller} 在 ${c.assetId} 上窗口内成交 ×${c.count}（阈值 ${cycleThreshold}）——异常短周期交易密度`,
      });
    }

    return { checkedAt: now, windowMs, findings, clean: findings.length === 0 };
  }
}
