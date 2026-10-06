/**
 * ledger.ts — 认知能量账本（共生进化架构第五阶段 1/4）
 *
 * 质变设计（相对"agent.energy 公开字段"草案的三重升级）：
 *
 * 1. 能量不可伪造：智能体没有 energy 字段，能量只存在于账本账户中，
 *    只能经 transfer/mint/burn 流转；每笔流转双方平衡（复式记账），
 *    全局守恒律恒成立：Σ(所有账户余额) === initialSupply + minted。
 *
 * 2. 链式哈希审计：每笔转账携带 sha256 链哈希（前序哈希 + 本笔内容），
 *    任何对历史凭证的篡改都会导致 verifyChain() 失败——能量流向可审计、
 *    可回放、不可抵赖。这是"玩具模拟"与"经济系统"的分水岭。
 *
 * 3. 生态健康可观测：giniCoefficient() 度量能量分布集中度——
 *    能量过度集中 = 垄断 = 认知生态死亡信号（单一智能体买断全部资源，
 *    多样性消失，进化停滞）。监管层可据此调节铸币与救济策略。
 *
 * 三轮升级（区块头哈希链）：每 blockSize 笔凭证封块，块内凭证哈希折叠根
 * + 块间 prevHash 链接——篡改历史凭证/块头/顺序分别定位到 entry-root /
 * block-hash / block-link（sealBlock/verifyBlockChain/locateTampering）。
 *
 * 四轮升级（通胀治理）：MonetaryGovernor——流通量目标带货币政策器。
 * 超发 → 铸币税率随带外偏离自动上调 + 央行收缩销毁；通缩 → 税率归零、
 * 分红加成；带内不动。采样史给出流通量趋势（contracting/expanding/
 * 带内回归/穿带计数）——通胀从「无人看管的铸币龙头」变为可观测、
 * 可回归的受控变量。opt-in：不配置 = 既有行为零漂移。
 *
 * 账户语义：
 * - treasury：央行国库（初始供给 + 任务成功铸币收入池），仅 runtime 持有账本引用
 * - burn（INCINERATOR）：燃烧池，burn 的能量退出流通但保留审计痕迹
 * - escrow：行动预扣托管（提案批准 → 预扣；执行完毕 → 燃烧/退还）
 *
 * 权限模型（Phase 1）：EnergyLedger 实例仅由 SymbiosisRuntime / CognitiveMarket
 * 持有；智能体只拿到只读快照（Perception.ownBalance），无法绕过市场直接转账。
 */

import { createHash } from 'node:crypto';

/** 账户 id（智能体 id / 内部账户） */
export type AccountId = string;

/** 央行国库：初始供给与铸币收入池 */
export const TREASURY: AccountId = 'treasury';
/** 燃烧池：burn 的能量退出流通（余额保留供审计） */
export const INCINERATOR: AccountId = 'burn';
/** 行动预扣托管账户 */
export const ESCROW: AccountId = 'escrow';

/** 单笔能量流转凭证（复式记账：from 失去 = to 得到，恒等） */
export interface EnergyTransfer {
  seq: number;
  from: AccountId;
  to: AccountId;
  amount: number;
  reason: string;
  /** 关联对象（资产 id / 提案 id / 交易 seq 等） */
  refId?: string;
  timestamp: number;
  /** 链式哈希：sha256(prevHash + 本笔内容) */
  hash: string;
}

export type TransferError =
  | 'non-positive-amount'
  | 'unknown-account'
  | 'insufficient-funds'
  | 'frozen-account'
  | 'self-transfer';

export interface TransferReceipt {
  ok: boolean;
  error?: TransferError;
  transfer?: EnergyTransfer;
}

export interface LedgerConfig {
  /** 央行初始供给（默认 10000） */
  initialSupply?: number;
  /** 凭证日志上限（默认 2000，超出滑出最旧） */
  journalLimit?: number;
  /** ── 三轮升级：区块头哈希链 ── */
  /** 自动封块阈值：未封存凭证数 ≥ 该值即封块（默认 8；≤1 表示每笔一块） */
  blockSize?: number;
  /** 区块头保留上限（默认与 journalLimit 一致，最旧滑出——其凭证早已裁剪） */
  blockLimit?: number;
}

/**
 * 区块头（三轮升级：复式记账升级为可定位的哈希块链）。
 *
 * 每个区块封存一段连续 seq 的凭证：块内以「凭证哈希折叠链」为根
 * （entryRoot），块间以前块哈希链接（prevBlockHash → hash）——
 * 纯 TS 哈希（djb2 变体 + FNV 混淆 + 长度注入，零依赖），块头本身
 * 的哈希覆盖全部头字段。篡改任一历史凭证 → 该块 entryRoot 失配且
 * 定位到块；篡改块头 → 块哈希失配；篡改 seq 顺序 → 链接断裂。
 */
export interface LedgerBlockHeader {
  /** 块高（1 起，创世后单调递增） */
  index: number;
  /** 本块首笔凭证 seq */
  firstSeq: number;
  /** 本块末笔凭证 seq（闭区间，entryCount = lastSeq − firstSeq + 1） */
  lastSeq: number;
  entryCount: number;
  /** 块内凭证哈希折叠链根（纯 TS 哈希逐笔折叠） */
  entryRoot: string;
  /** 前块哈希（创世块锚定 GENESIS_HASH） */
  prevBlockHash: string;
  sealedAt: number;
  /** 本块哈希 = mixHash(全部头字段) */
  hash: string;
}

/** 块链审计结论：intact = 链接与块根全通过；broken 给出定位 */
export interface BlockChainAudit {
  intact: boolean;
  blocks: number;
  /** 完整重算块根的块数（凭证仍在 journal 内） */
  verifiedFull: number;
  /** 凭证已被 journalLimit 裁剪、仅验证块头链接的块数 */
  pruned: number;
  /** 首个失配点（intact = false 时给出） */
  broken?: {
    blockIndex: number;
    kind: 'block-hash' | 'entry-root' | 'block-link';
    /** entry-root 失配时定位到的凭证 seq（块内折叠链首个失配笔） */
    seq?: number;
  };
}

/** 篡改定位结果（逐凭证链 + 块链双通道） */
export interface TamperLocation {
  found: boolean;
  /** 逐凭证链首个失配的 seq */
  seq?: number;
  /** 该 seq 所属块高 */
  blockIndex?: number;
  kind?: 'entry-hash' | 'block-hash' | 'entry-root' | 'block-link';
}

export interface LedgerStats {
  /** 守恒总供给 = initialSupply + minted */
  totalSupply: number;
  /** 流通供给（总供给 - 燃烧池余额） */
  circulatingSupply: number;
  minted: number;
  burned: number;
  transfers: number;
  accounts: number;
  frozenAccounts: number;
  /** 能量分布基尼系数（默认不含 treasury/内部账户） */
  gini: number;
  chainHead: string;
  chainIntact: boolean;
}

/** 账本可持久化快照（同时服务测试篡改注入） */
export interface LedgerSnapshot {
  balances: Array<[AccountId, number]>;
  frozen: AccountId[];
  journal: EnergyTransfer[];
  seqCounter: number;
  minted: number;
  initialSupply: number;
  /** 链锚点（journalLimit 裁剪后与创世哈希解耦；旧快照缺省回退 GENESIS） */
  chainAnchor?: string;
  /** ── 三轮升级：区块头链（旧快照缺省为空——空块链同样合法）── */
  blocks?: LedgerBlockHeader[];
}

const GENESIS_HASH = '0'.repeat(64);
/** 块链创世锚（与 GENESIS_HASH 等长但独立命名，语义分离） */
const GENESIS_BLOCK_ROOT = '0'.repeat(64);

export class EnergyLedger {
  private balances = new Map<AccountId, number>();
  private frozen = new Set<AccountId>();
  private journal: EnergyTransfer[] = [];
  private chainHead = GENESIS_HASH;
  /** 链锚点：被裁剪的最后一条凭证哈希（verifyChain 由此起验） */
  private chainAnchor: string = GENESIS_HASH;
  private seqCounter = 0;
  private mintedTotal = 0;
  private readonly initialSupply: number;
  private readonly journalLimit: number;
  /** ── 三轮升级：区块头哈希链 ── */
  private blockJournal: LedgerBlockHeader[] = [];
  /** 已封存的最大 seq（0 = 尚未封块） */
  private lastSealedSeq = 0;
  private readonly blockSize: number;
  private readonly blockLimit: number;

  constructor(config: LedgerConfig = {}) {
    this.initialSupply = Math.max(0, config.initialSupply ?? 10_000);
    this.journalLimit = Math.max(10, config.journalLimit ?? 2_000);
    this.blockSize = Math.min(Math.max(1, config.blockSize ?? 8), this.journalLimit);
    this.blockLimit = Math.max(this.blockSize, config.blockLimit ?? this.journalLimit);
    this.balances.set(TREASURY, this.initialSupply);
    this.balances.set(INCINERATOR, 0);
    this.balances.set(ESCROW, 0);
  }

  /** 开户（零余额；初始注资由调用方经 treasury transfer 完成） */
  openAccount(id: AccountId): boolean {
    if (this.balances.has(id)) return false;
    this.balances.set(id, 0);
    return true;
  }

  hasAccount(id: AccountId): boolean {
    return this.balances.has(id);
  }

  balance(id: AccountId): number {
    return this.balances.get(id) ?? 0;
  }

  isFrozen(id: AccountId): boolean {
    return this.frozen.has(id);
  }

  freeze(id: AccountId): void {
    if (this.balances.has(id)) this.frozen.add(id);
  }

  unfreeze(id: AccountId): void {
    this.frozen.delete(id);
  }

  /** 原子转账：余额不足/冻结/非法金额全部拒绝，拒绝时状态零变更 */
  transfer(from: AccountId, to: AccountId, amount: number, reason: string, refId?: string): TransferReceipt {
    if (!(amount > 0) || !Number.isFinite(amount)) {
      return { ok: false, error: 'non-positive-amount' };
    }
    if (from === to) return { ok: false, error: 'self-transfer' };
    if (!this.balances.has(from) || !this.balances.has(to)) {
      return { ok: false, error: 'unknown-account' };
    }
    if (this.frozen.has(from)) return { ok: false, error: 'frozen-account' };
    if ((this.balances.get(from) ?? 0) < amount) {
      return { ok: false, error: 'insufficient-funds' };
    }
    this.balances.set(from, (this.balances.get(from) ?? 0) - amount);
    this.balances.set(to, (this.balances.get(to) ?? 0) + amount);
    const entry = this.appendEntry(from, to, amount, reason, refId);
    return { ok: true, transfer: entry };
  }

  /** 央行铸币：向 to 增发能量（对应真实价值注入：任务成功/知识生效）。
   *  仅 runtime 持有账本引用时调用；破坏守恒律的唯一入口且被显式记账。 */
  mint(to: AccountId, amount: number, reason: string, refId?: string): TransferReceipt {
    if (!(amount > 0) || !Number.isFinite(amount)) {
      return { ok: false, error: 'non-positive-amount' };
    }
    if (!this.balances.has(to)) return { ok: false, error: 'unknown-account' };
    this.balances.set(to, (this.balances.get(to) ?? 0) + amount);
    this.mintedTotal += amount;
    const entry = this.appendEntry('(mint)', to, amount, reason, refId);
    return { ok: true, transfer: entry };
  }

  /** 燃烧：能量转入燃烧池退出流通（余额保留供审计与守恒校验） */
  burn(from: AccountId, amount: number, reason: string, refId?: string): TransferReceipt {
    return this.transfer(from, INCINERATOR, amount, reason, refId);
  }

  /** 已燃烧总量 */
  burned(): number {
    return this.balance(INCINERATOR);
  }

  /** 央行铸币总量 */
  minted(): number {
    return this.mintedTotal;
  }

  /** 守恒总供给 = initialSupply + minted */
  totalSupply(): number {
    return this.initialSupply + this.mintedTotal;
  }

  /** 流通供给 = 总供给 - 燃烧池余额 - 托管余额 */
  circulatingSupply(): number {
    return this.totalSupply() - this.balance(INCINERATOR) - this.balance(ESCROW);
  }

  /**
   * 基尼系数（0 完全平等 → 1 完全垄断）。
   * 默认只统计智能体账户（排除 treasury/burn/escrow 内部账户）——
   * 内部账户是基础设施而非生态成员，计入会稀释真实集中度信号。
   * 零余额账户**保留**在统计内：这是基尼系数的标准口径（零收入人口
   * 计入分母）——饿死归零 / 尚未入场的智能体都是生态成员，「很多
   * 零余额者」本身就是分布的事实而非统计噪声，剔除会系统性低估
   * 集中度（[100,0] 标准值 0.5，剔除后虚降为 0）
   */
  giniCoefficient(includeInternal = false): number {
    const INTERNAL = new Set([TREASURY, INCINERATOR, ESCROW]);
    const values: number[] = [];
    for (const [id, bal] of this.balances) {
      if (!includeInternal && INTERNAL.has(id)) continue;
      values.push(bal);
    }
    const n = values.length;
    if (n === 0) return 0;
    const total = values.reduce((a, b) => a + b, 0);
    if (total <= 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    let weightedSum = 0;
    for (let i = 0; i < n; i++) weightedSum += (i + 1) * sorted[i]!;
    return Math.max(0, (2 * weightedSum) / (n * total) - (n + 1) / n);
  }

  /** 最近 limit 条凭证（拷贝，外部修改不影响账本） */
  audit(limit = 50): EnergyTransfer[] {
    return this.journal.slice(-limit).map((t) => ({ ...t }));
  }

  /** 守恒律校验：Σ(所有账户余额) === initialSupply + minted */
  verifyConservation(): boolean {
    let sum = 0;
    for (const bal of this.balances.values()) sum += bal;
    return Math.abs(sum - this.totalSupply()) < 1e-9;
  }

  /** 链完整性校验：重算全链哈希，任何历史篡改即刻暴露 */
  verifyChain(): boolean {
    // 从链锚点起验：journalLimit 裁剪掉创世段后，链头与 GENESIS 不再
    // 直连——固定从 GENESIS 起验会让 chainIntact 在首次裁剪后永久 false
    let prev = this.chainAnchor;
    for (const entry of this.journal) {
      const expected = hashEntry(prev, entry);
      if (expected !== entry.hash) return false;
      prev = entry.hash;
    }
    return true;
  }

  // ─────────────── 三轮升级：区块头哈希链审计 ───────────────

  /** 已封块数（观测/审计用） */
  blockCount(): number {
    return this.blockJournal.length;
  }

  /** 区块头清单（拷贝；从旧到新） */
  blocks(): LedgerBlockHeader[] {
    return this.blockJournal.map((b) => ({ ...b }));
  }

  /** 尚未封存的凭证数 */
  unsealedCount(): number {
    return Math.max(0, this.seqCounter - this.lastSealedSeq);
  }

  /**
   * 手动封块：把当前全部未封存凭证封入一个区块（自动封块之外的显式入口，
   * 如「一轮结算完成」这类业务边界）。无未封存凭证时返回 undefined。
   */
  sealBlock(): LedgerBlockHeader | undefined {
    const unsealed = this.journal.filter((e) => e.seq > this.lastSealedSeq);
    if (unsealed.length === 0) return undefined;
    const root = this.foldEntryRoot(unsealed);
    const header: LedgerBlockHeader = {
      index: this.blockJournal.length + 1,
      firstSeq: unsealed[0]!.seq,
      lastSeq: unsealed[unsealed.length - 1]!.seq,
      entryCount: unsealed.length,
      entryRoot: root,
      prevBlockHash: this.blockJournal.length > 0 ? this.blockJournal[this.blockJournal.length - 1]!.hash : GENESIS_HASH,
      sealedAt: Date.now(),
      hash: '',
    };
    header.hash = blockHash(header);
    this.blockJournal.push(header);
    this.lastSealedSeq = header.lastSeq;
    if (this.blockJournal.length > this.blockLimit) this.blockJournal.splice(0, this.blockJournal.length - this.blockLimit);
    return { ...header };
  }

  /**
   * 块内凭证折叠根（本轮补完修正）：逐笔**重算**链式哈希
   * hashEntry(prev, entry)（覆盖凭证全部字段——含 amount/from/to）
   * 后折叠——块根承诺的是「凭证内容」而非「存储的 hash 字段」：
   * 篡改凭证内容而保留 hash 字段的伪造同样使块根失配（与逐凭证链
   * sha256 双通道独立检出）。
   */
  private foldEntryRoot(entries: EnergyTransfer[]): string {
    let prev = this.prevHashOf(entries[0]!.seq);
    let root = GENESIS_BLOCK_ROOT;
    for (const entry of entries) {
      const h = hashEntry(prev, entry);
      root = mixHash(`${root}|${h}`);
      prev = h;
    }
    return root;
  }

  /** seq 的前一笔哈希（journal 内按 seq 倒查；块首笔即 journal 首笔 → chainAnchor 裁剪锚） */
  private prevHashOf(seq: number): string {
    for (let i = this.journal.length - 1; i >= 0; i -= 1) {
      if (this.journal[i]!.seq === seq - 1) return this.journal[i]!.hash;
      if (this.journal[i]!.seq < seq - 1) break;
    }
    return this.chainAnchor;
  }

  /**
   * 块链完整性审计：块头哈希自洽 + 块间链接 + （凭证仍在 journal 的块）
   * 块内凭证哈希折叠根重算。被 journalLimit 裁剪的旧块只验块头（其凭证
   * 已不可复核——裁剪本就是显式的审计窗口收缩，块头链仍连续可验）。
   */
  verifyBlockChain(): BlockChainAudit {
    let verifiedFull = 0;
    let pruned = 0;
    // 块头链锚：块保留上限滑出最旧块后，首个保留块的前块哈希即新锚
    // （其自身哈希覆盖其字段——被滑出的前缀如同 journalLimit 裁剪一样
    // 是显式的审计窗口收缩，保留段仍连续可验）
    let prevHash =
      this.blockJournal.length > 0 && this.blockJournal[0]!.index > 1 ? this.blockJournal[0]!.prevBlockHash : GENESIS_HASH;
    for (let i = 0; i < this.blockJournal.length; i += 1) {
      const block = this.blockJournal[i]!;
      if (block.prevBlockHash !== prevHash) {
        return { intact: false, blocks: this.blockJournal.length, verifiedFull, pruned, broken: { blockIndex: block.index, kind: 'block-link' } };
      }
      if (blockHash(block) !== block.hash) {
        return { intact: false, blocks: this.blockJournal.length, verifiedFull, pruned, broken: { blockIndex: block.index, kind: 'block-hash' } };
      }
      // 块内凭证折叠根：凭证段完整在场才重算（重算口径 = foldEntryRoot，
      // 与封块同一函数——凭证内容或 hash 字段的任何篡改都使根失配）
      const journalFirstSeq = this.journal.length > 0 ? this.journal[0]!.seq : Number.POSITIVE_INFINITY;
      if (block.firstSeq < journalFirstSeq) {
        pruned += 1; // 凭证已被裁剪——块头链仍连续，但块根无法复核
      } else {
        const entries = this.journal.filter((e) => e.seq >= block.firstSeq && e.seq <= block.lastSeq);
        const root = this.foldEntryRoot(entries);
        if (root !== block.entryRoot) {
          // 折叠根失配：结合逐凭证哈希链定位首个失配笔
          const mismatchSeq = this.firstEntryHashMismatchInRange(block.firstSeq, block.lastSeq) ?? block.firstSeq;
          return { intact: false, blocks: this.blockJournal.length, verifiedFull, pruned, broken: { blockIndex: block.index, kind: 'entry-root', seq: mismatchSeq } };
        }
        verifiedFull += 1;
      }
      prevHash = block.hash;
    }
    return { intact: true, blocks: this.blockJournal.length, verifiedFull, pruned };
  }

  /**
   * 篡改定位（逐凭证链优先 + 块链复核）：
   * - 改一笔历史凭证 → 逐凭证 sha256 链在该 seq 失配 → 同时给出所属块高；
   * - 改块头（如 entryRoot/hash）→ 逐凭证链全通过 → 块链审计定位失配块。
   */
  locateTampering(): TamperLocation {
    let prev = this.chainAnchor;
    for (const entry of this.journal) {
      const expected = hashEntry(prev, entry);
      if (expected !== entry.hash) {
        return { found: true, seq: entry.seq, blockIndex: this.blockIndexOf(entry.seq), kind: 'entry-hash' };
      }
      prev = entry.hash;
    }
    const audit = this.verifyBlockChain();
    if (!audit.intact && audit.broken) {
      return { found: true, seq: audit.broken.seq, blockIndex: audit.broken.blockIndex, kind: audit.broken.kind };
    }
    return { found: false };
  }

  /** seq → 块高（未封存返回 undefined） */
  private blockIndexOf(seq: number): number | undefined {
    for (const block of this.blockJournal) {
      if (seq >= block.firstSeq && seq <= block.lastSeq) return block.index;
    }
    return undefined;
  }

  /** [from, to] 区间内逐凭证链的首个失配 seq（预验链与记录链双算对照） */
  private firstEntryHashMismatchInRange(from: number, to: number): number | undefined {
    // 从 journal 首笔重放哈希链到区间起点（保持与 verifyChain 同一起点）
    let prev = this.chainAnchor;
    for (const entry of this.journal) {
      if (entry.seq > to) break;
      const expected = hashEntry(prev, entry);
      if (entry.seq >= from && expected !== entry.hash) return entry.seq;
      prev = entry.hash;
    }
    return undefined;
  }

  stats(): LedgerStats {
    return {
      totalSupply: this.totalSupply(),
      circulatingSupply: this.circulatingSupply(),
      minted: this.mintedTotal,
      burned: this.balance(INCINERATOR),
      transfers: this.journal.length,
      accounts: this.balances.size,
      frozenAccounts: this.frozen.size,
      gini: this.giniCoefficient(),
      chainHead: this.chainHead,
      chainIntact: this.verifyChain(),
    };
  }

  /** 导出快照（持久化 / 测试篡改注入用） */
  snapshotState(): LedgerSnapshot {
    return {
      balances: [...this.balances.entries()],
      frozen: [...this.frozen],
      journal: this.journal.map((t) => ({ ...t })),
      seqCounter: this.seqCounter,
      minted: this.mintedTotal,
      initialSupply: this.initialSupply,
      chainAnchor: this.chainAnchor,
      blocks: this.blockJournal.map((b) => ({ ...b })),
    };
  }

  /** 导入快照（原子整体替换） */
  restoreState(snap: LedgerSnapshot): void {
    this.balances = new Map(snap.balances);
    this.frozen = new Set(snap.frozen);
    this.journal = snap.journal.map((t) => ({ ...t }));
    this.seqCounter = snap.seqCounter;
    this.mintedTotal = snap.minted;
    this.chainAnchor = snap.chainAnchor ?? GENESIS_HASH;
    this.blockJournal = (snap.blocks ?? []).map((b) => ({ ...b }));
    this.lastSealedSeq = this.blockJournal.length > 0 ? this.blockJournal[this.blockJournal.length - 1]!.lastSeq : 0;
    this.chainHead = this.journal.length > 0 ? this.journal[this.journal.length - 1]!.hash : GENESIS_HASH;
  }

  private appendEntry(from: AccountId, to: AccountId, amount: number, reason: string, refId?: string): EnergyTransfer {
    const entry: EnergyTransfer = {
      seq: ++this.seqCounter,
      from,
      to,
      amount,
      reason,
      refId,
      timestamp: Date.now(),
      hash: '',
    };
    entry.hash = hashEntry(this.chainHead, entry);
    this.chainHead = entry.hash;
    this.journal.push(entry);
    if (this.journal.length > this.journalLimit) {
      // 滑出最旧凭证：锚点前移到最后一条被裁剪者，保留的链段仍连续可验。
      // 封块保护：blockSize ≤ journalLimit 保证未封存段永远够不到裁剪沿，
      // 这里再显式兜底——裁剪前先把在途凭证全部封块（防御配置漂移）。
      if (this.journal[this.journal.length - this.journalLimit - 1]!.seq > this.lastSealedSeq) this.sealBlock();
      const overflow = this.journal.length - this.journalLimit;
      this.chainAnchor = this.journal[overflow - 1]!.hash;
      this.journal.splice(0, overflow);
    }
    // 自动封块：未封存凭证数达阈值即封（业务侧亦可用 sealBlock() 显式封）
    if (this.seqCounter - this.lastSealedSeq >= this.blockSize) this.sealBlock();
    return entry;
  }
}

function hashEntry(prevHash: string, entry: Omit<EnergyTransfer, 'hash'>): string {
  return createHash('sha256')
    .update(`${prevHash}|${entry.seq}|${entry.from}|${entry.to}|${entry.amount}|${entry.reason}|${entry.refId ?? ''}|${entry.timestamp}`)
    .digest('hex');
}

// ═══════════════════════ 四轮升级：通胀治理（铸币税 × 收缩销毁） ═══════════════════════

/**
 * 通胀治理配置（流通量目标带货币政策；opt-in——不配置 = 央行不干预，零漂移）。
 *
 * 机制：流通量围绕目标带 [T·(1−tol), T·(1+tol)] 动态平衡——
 * - 超出上沿（超发）：铸币税率按带外偏离比例自动上调（分红被税）、
 *   央行按敏感度从国库收缩销毁（treasury → burn）；
 * - 跌破下沿（通缩）：税率归零、分红按偏离加成（反向放大注入）；
 * - 带内：基础税率（缺省 0），既不收缩也不加成。
 */
export interface MonetaryPolicyConfig {
  /** 流通量目标（能量） */
  targetCirculating: number;
  /** 目标带半宽比例（默认 0.1 → [0.9T, 1.1T]） */
  bandTolerance?: number;
  /** 带内基础铸币税率 0~1（默认 0） */
  baseTaxRate?: number;
  /** 铸币税率上限（默认 0.5） */
  maxTaxRate?: number;
  /** 税率敏感度：带外偏离每达目标的此比例追加全额增量（默认 0.25——偏离 25% 即到顶） */
  taxSensitivity?: number;
  /** 通缩分红加成上限（默认 1.5——最多 1.5 倍注入） */
  boostCap?: number;
  /** 超发收缩销毁敏感度（0~1；每 1 单位「相对目标中枢」偏离销毁此比例；默认 0.5） */
  contractionSensitivity?: number;
}

/** 流通量相对目标带的位置 */
export type MonetaryZone = 'below' | 'within' | 'above';

/** 单次政策评估（纯计算，无副作用——可离线推演） */
export interface MonetaryAssessment {
  /** 评估时流通量 */
  circulating: number;
  target: number;
  /** 流通量 / 目标（>1 超发、<1 通缩） */
  ratio: number;
  zone: MonetaryZone;
  /** 本评估适用的铸币税率（分红按 1 − tax 缩放） */
  mintTaxRate: number;
  /** 分红缩放系数（超发 <1 被税、通缩 >1 加成、带内 1） */
  dividendScale: number;
  /** 建议收缩销毁量（能量；仅 above 时 > 0；锚定目标中枢偏离，调用方从 treasury 销毁） */
  contraction: number;
}

/** 流通量趋势（采样史的可观测读数） */
export interface MonetaryTrend {
  /** 采样数 */
  samples: number;
  /** 前半段均值 */
  firstHalfMean: number;
  /** 后半段均值 */
  secondHalfMean: number;
  /** 斜率方向（后半 − 前半 超过目标的 2% 才定性） */
  slope: 'contracting' | 'expanding' | 'stable';
  /** 最新样本是否已回到带内 */
  insideBand: boolean;
  /** 观测窗内穿越目标带的次数（政策振荡信号） */
  bandCrossings: number;
}

/** 采样点（history() 拷贝导出） */
export interface MonetarySample {
  circulating: number;
  zone: MonetaryZone;
  mintTaxRate: number;
  timestamp: number;
}

const MONETARY_HISTORY_LIMIT = 64;

/**
 * 央行货币政策器（四轮升级）：流通量目标带的铸币税/收缩销毁调节器。
 *
 * 纯函数评估（assess）+ 采样史（record/trend）——评估无副作用可离线推演，
 * 执行面（税率作用于分红、contraction 从国库销毁）由 runtime 持有账本时
 * 落地；未配置 = 既有铸币/分红行为逐位不变（零漂移）。
 */
export class MonetaryGovernor {
  private readonly cfg: Required<MonetaryPolicyConfig>;
  private samples: MonetarySample[] = [];

  constructor(config: MonetaryPolicyConfig) {
    const target = Math.max(1, config.targetCirculating);
    this.cfg = {
      targetCirculating: target,
      bandTolerance: clamp(config.bandTolerance ?? 0.1, 0.01, 1),
      baseTaxRate: clamp(config.baseTaxRate ?? 0, 0, 1),
      maxTaxRate: clamp(config.maxTaxRate ?? 0.5, 0, 1),
      taxSensitivity: clamp(config.taxSensitivity ?? 0.25, 0.01, 10),
      boostCap: clamp(config.boostCap ?? 1.5, 1, 10),
      contractionSensitivity: clamp(config.contractionSensitivity ?? 0.5, 0, 1),
    };
  }

  /** 目标带边界（读取用） */
  band(): { low: number; high: number } {
    return {
      low: this.cfg.targetCirculating * (1 - this.cfg.bandTolerance),
      high: this.cfg.targetCirculating * (1 + this.cfg.bandTolerance),
    };
  }

  /**
   * 纯评估：给定流通量 → 税率/分红缩放/收缩建议（无状态写入）。
   *
   * 两个口径刻意不同：
   * - 税率按**带沿偏离**计（(circulating − high)/target）：刚出带即轻税、
   *   深度超发重税——惩罚力度与越界程度成比例；
   * - 收缩按**目标中枢偏离**计（(circulating − target) × sens）：只锚定
   *   带沿会让收缩恰好抵消铸币流入、停在带外平衡点（数学死锁）；
   *   锚定中枢保证带外流通量净回落进带（收缩覆盖注入）。
   */
  assess(circulating: number): MonetaryAssessment {
    const { targetCirculating: target } = this.cfg;
    const { low, high } = this.band();
    const ratio = circulating / target;
    if (circulating > high) {
      // 超发：偏离比例 = (circulating − high)/target，按 taxSensitivity 线性折算到税率增量
      const overshoot = (circulating - high) / target;
      const mintTaxRate = Math.min(this.cfg.maxTaxRate, this.cfg.baseTaxRate + overshoot / this.cfg.taxSensitivity);
      return {
        circulating,
        target,
        ratio,
        zone: 'above',
        mintTaxRate,
        dividendScale: Math.max(0, 1 - mintTaxRate),
        contraction: Math.floor((circulating - target) * this.cfg.contractionSensitivity),
      };
    }
    if (circulating < low) {
      // 通缩：税率归零、分红按偏离加成（封顶 boostCap）
      const undershoot = (low - circulating) / target;
      const boost = Math.min(this.cfg.boostCap, 1 + undershoot / this.cfg.taxSensitivity);
      return { circulating, target, ratio, zone: 'below', mintTaxRate: 0, dividendScale: boost, contraction: 0 };
    }
    return { circulating, target, ratio, zone: 'within', mintTaxRate: this.cfg.baseTaxRate, dividendScale: 1 - this.cfg.baseTaxRate, contraction: 0 };
  }

  /** 评估并采样入史（每次政策执行/心跳观测调用；环窗保留最近 64 点） */
  record(circulating: number, now: number = Date.now()): MonetaryAssessment {
    const assessment = this.assess(circulating);
    this.samples.push({ circulating, zone: assessment.zone, mintTaxRate: assessment.mintTaxRate, timestamp: now });
    if (this.samples.length > MONETARY_HISTORY_LIMIT) this.samples.splice(0, this.samples.length - MONETARY_HISTORY_LIMIT);
    return assessment;
  }

  /** 流通量趋势：前/后半段均值对比 + 带内回归 + 穿带计数（可观测性） */
  trend(): MonetaryTrend {
    const { low, high } = this.band();
    const n = this.samples.length;
    if (n === 0) return { samples: 0, firstHalfMean: 0, secondHalfMean: 0, slope: 'stable', insideBand: false, bandCrossings: 0 };
    const half = Math.max(1, Math.floor(n / 2));
    const first = this.samples.slice(0, n - half);
    const second = this.samples.slice(n - half);
    const mean = (arr: MonetarySample[]): number => (arr.length === 0 ? 0 : arr.reduce((a, s) => a + s.circulating, 0) / arr.length);
    const firstHalfMean = mean(first);
    const secondHalfMean = mean(second);
    const delta = secondHalfMean - firstHalfMean;
    const threshold = this.cfg.targetCirculating * 0.02;
    let crossings = 0;
    for (let i = 1; i < n; i += 1) {
      const prevIn = this.samples[i - 1]!.circulating >= low && this.samples[i - 1]!.circulating <= high;
      const curIn = this.samples[i]!.circulating >= low && this.samples[i]!.circulating <= high;
      if (prevIn !== curIn) crossings += 1;
    }
    const latest = this.samples[n - 1]!.circulating;
    return {
      samples: n,
      firstHalfMean,
      secondHalfMean,
      slope: delta < -threshold ? 'contracting' : delta > threshold ? 'expanding' : 'stable',
      insideBand: latest >= low && latest <= high,
      bandCrossings: crossings,
    };
  }

  /** 采样史拷贝（观测/审计用） */
  history(): MonetarySample[] {
    return [...this.samples];
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

// ── 纯 TS 哈希（块链专用；零依赖确定性）──

/**
 * mixHash — djb2 变体 × FNV-1a 混淆 + 长度注入的双 32 位轨道哈希。
 *
 * 设计目标（不引依赖的前提下尽量抗碰撞）：
 * - 轨道 1：FNV-1a 逐字符乘素数 0x01000193 后接 djb2 式 13 位旋转——
 *   乘法扩散（雪崩）+ 旋转打破低位聚集；
 * - 轨道 2：djb2 变体（h = imul(h + c, 33) ⊕ h>>>15）——经典字符串哈希；
 * - 长度注入：两轨道末轮混入 len（"ab" 与 "ababab…" 不因折叠截断碰撞）；
 * - 终轮雪崩：xor-shift 乘混合（Murmur3 finalizer 风格），输出 16 hex。
 */
function mixHash(input: string): string {
  const n = input.length;
  let h1 = 0x811c9dc5; // FNV offset basis
  let h2 = 0x00001505; // djb2 seed (5381)
  for (let i = 0; i < n; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h1 = ((h1 << 13) | (h1 >>> 19)) >>> 0;
    h2 = (Math.imul(h2 + c, 33) ^ (h2 >>> 15)) >>> 0;
  }
  h1 = (h1 ^ Math.imul(n, 0x9e3779b1)) >>> 0;
  h2 = (h2 ^ Math.imul(n, 0x85ebca6b) ^ (h1 >>> 13)) >>> 0;
  h1 = (Math.imul(h1 ^ (h1 >>> 16), 0x7feb352d) ^ Math.imul(h2, 0x846ca68b)) >>> 0;
  h2 = (Math.imul(h2 ^ (h2 >>> 13), 0xc2b2ae35) ^ h1) >>> 0;
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
}

/** 区块头哈希：覆盖除自身外的全部头字段（全大写十六进制，与 mixHash 区分口径） */
function blockHash(header: Omit<LedgerBlockHeader, 'hash'>): string {
  return mixHash(
    `B|${header.index}|${header.firstSeq}|${header.lastSeq}|${header.entryCount}|${header.entryRoot}|${header.prevBlockHash}|${header.sealedAt}`,
  ).toUpperCase();
}
