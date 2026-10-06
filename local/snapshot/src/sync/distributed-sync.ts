/**
 * distributed-sync.ts — 分布式记忆同步引擎（协作层，依赖 long-term-memory + crypto-engine）
 *
 * 职责：
 * - 将本地记忆变更（模式增删改 / 画像更新 / 反馈新增 / 统计更新）记录为变更日志
 * - 通过逻辑时钟（Lamport Clock）跟踪各节点进度，按 peer 增量生成同步批次
 * - 接收远端批次并幂等应用，检测并自动仲裁并发冲突
 * - 支持 http-poll / file-share 两种传输协议，双向或单向同步
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. Lamport 逻辑时钟：接收批次时 localClock = max(local, remote) + 1，
 *    保证因果序；peer 进度单独跟踪，实现按 peer 的增量推送（不重复传输）
 * 2. 幂等应用：已应用的 changeId 集合持久化，重复批次安全跳过，
 *    网络重传不会造成记忆重复累加
 * 3. 冲突自动仲裁：同指纹并发修改按 (logicalClock, timestamp, sourceNodeId)
 *    三级仲裁，仲裁结果落 SyncConflict 审计记录，无需人工介入
 * 4. 批次完整性：SyncBatch 携带 batchHash（变更链哈希），接收端逐条校验，
 *    损坏批次整体拒收
 * 5. 双协议传输：http-poll（POST push + GET pull）与 file-share（共享目录
 *    交换批次文件），均支持 authToken 鉴权
 * 6. 状态持久化：时钟 / peer 进度 / 待推送变更 / 冲突记录 / 同步日志全部落盘，
 *    重启后无缝续传
 *
 * 第三轮·世界性升级（模块域 A12）：
 * 7. CRDT 反熵协议：状态向量时钟比较（dominates/dominated/concurrent/equal）
 *    + 增量反熵（antiEntropyBatch 只传对方缺的操作——接收端缺口检测保证
 *    按因果序无空洞应用；保留窗滑出时自动降级为全量状态兜底）+ 冲突
 *    CRDT 合并（计数器逐分量 max / add-win 集 / (stamp,writer) 全序寄存器）
 *    ——反熵从「全量状态对撞」升级为「向量时钟裁剪的最小增量流」，
 *    收敛从协议希望变成合并算子的代数性质
 *
 * 第四轮·世界性升级（模块域 A12）：
 * 8. 跨集群联邦：FederationGateway 按命名空间/键前缀订阅做选择性状态
 *    同步（未订阅前缀在出口即被裁剪——零传输，不是「传了再丢」），
 *    每窗口限流（超发排队延迟、不静默丢弃）；buildFederationBatch 纯
 *    函数与引擎批次同一哈希口径——联邦批次直接经 receiveBatch 校验
 *    应用（幂等）。全部新增面独立于既有 DistributedSync 状态（零漂移）
 */

import crypto from 'node:crypto';
import { GCounter } from '../core/crdt.js';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { NetworkError } from '../errors.js';
import type { LongTermMemory, TaskPatternMemory, ModelLongTermProfile, DecisionFeedback, MemoryStore } from '../memory/long-term-memory.js';
import type { CryptoEngine } from '../security/crypto-engine.js';

/**
 * 变更载荷联合类型（按 ChangeEntry.type 判别）：
 * - pattern-created / pattern-updated：完整模式，或反思器产出的轻量变更描述
 * - model-profile-updated：模型画像
 * - feedback-created：决策反馈
 * - stats-updated：全局统计增量
 * - pattern-deleted：无载荷（null）
 */
export type ChangePayload =
  | TaskPatternMemory
  | ModelLongTermProfile
  | DecisionFeedback
  | MemoryStore['globalStats']
  | { taskType: string; complexity: number; outcome: 'success' | 'failure' }
  | null;

/** 同步 HTTP 响应（push/pull 端点统一结构） */
interface SyncHttpResponse {
  ok?: boolean;
  error?: string;
  batch?: SyncBatch;
  [key: string]: unknown;
}

/** 同步节点配置 */
export interface SyncNodeConfig {
  nodeId: string;
  name: string;
  protocol: 'http-poll' | 'websocket' | 'file-share';
  remoteUrl?: string;
  wsUrl?: string;
  sharePath?: string;
  pollInterval?: number;
  authToken?: string;
  bidirectional?: boolean;
  enabled?: boolean;
}

/** 单条变更条目 */
export interface ChangeEntry {
  id: string;
  type:
    | 'pattern-created'
    | 'pattern-updated'
    | 'pattern-deleted'
    | 'model-profile-updated'
    | 'feedback-created'
    | 'stats-updated';
  fingerprint: string;
  timestamp: number;
  sourceNodeId: string;
  payload: ChangePayload;
  logicalClock: number;
  dataHash: string;
}

/** 同步批次 */
export interface SyncBatch {
  batchId: string;
  sourceNodeId: string;
  changes: ChangeEntry[];
  timestamp: number;
  logicalClock: number;
  batchHash: string;
}

/** 同步冲突记录 */
export interface SyncConflict {
  changeId: string;
  fingerprint: string;
  localData: TaskPatternMemory;
  remoteData: ChangePayload;
  localClock: number;
  remoteClock: number;
  resolution: 'local-wins' | 'remote-wins' | 'merged' | 'pending';
  resolvedAt?: number;
  resolutionReason?: string;
}

/** 单次同步日志 */
export interface SyncLogEntry {
  timestamp: number;
  direction: 'push' | 'pull';
  remoteNodeId: string;
  changesSent: number;
  changesReceived: number;
  conflictsDetected: number;
  conflictsResolved: number;
  errors: string[];
  duration: number;
  status: 'success' | 'partial' | 'failed';
}

/** 同步状态（持久化结构） */
export interface SyncState {
  localClock: number;
  peerClocks: Record<string, number>;
  pendingChanges: ChangeEntry[];
  unresolvedConflicts: SyncConflict[];
  syncLog: SyncLogEntry[];
  lastSyncAt: Record<string, number>;
  /** 已应用变更 id（有界 FIFO；跨重启幂等去重的持久化载体） */
  appliedIds?: string[];
  // ── 反熵协议持久化（第三轮；缺席时零介入） ──
  /** 状态向量时钟：origin → 已连续应用的最大操作序号 */
  aeClock?: Record<string, number>;
  /** 反熵中继操作日志（有界；按 (origin, seq) 去重） */
  aeLog?: Array<{ origin: string; seq: number; op: CrdtOperation }>;
  /** 集合/寄存器通道状态（计数器通道复用 crdtCounters，不在此重复） */
  aeChannels?: Record<string, CrdtChannelState>;
}

// ─────────────────────────── 反熵协议类型（第三轮） ───────────────────────────

/** CRDT 通道种类 */
export type CrdtChannelKind = 'counter' | 'set' | 'register';

/**
 * CRDT 操作（op-based；由 (origin, seq) 因果坐标唯一标识）。
 * remove 在 emit 时固化「发起端已见标签集」——add-win 语义的并发安全根源
 */
export type CrdtOperation =
  | { kind: 'increment'; channel: string; by: number }
  | { kind: 'add'; channel: string; element: string; tag?: string }
  | { kind: 'remove'; channel: string; element: string; tags?: string[] }
  | { kind: 'set'; channel: string; value: string; stamp: number };

/** 带因果坐标的操作 */
export interface StampedOperation {
  origin: string;
  seq: number;
  op: CrdtOperation;
}

/** 通道状态快照（全量兜底 / 持久化 / 收敛比对的载体） */
export interface CrdtChannelState {
  kind: CrdtChannelKind;
  /** counter：节点分量 */
  counts?: Record<string, number>;
  /** set：加标签集 / 墓碑集 */
  set?: { added: Record<string, string[]>; removed: Record<string, string[]> };
  /** register：最后写胜全序三元组 */
  register?: { value: string | null; stamp: number; writer: string };
}

/** 反熵批次：向量时钟裁剪出的最小增量流（或全量状态兜底） */
export interface AntiEntropyBatch {
  from: string;
  /** 发送方完整向量时钟（接收端据此裁剪 + 合并） */
  clock: Record<string, number>;
  /** 对方缺的操作（按 origin 分组、seq 升序——接收端逐序应用） */
  ops: StampedOperation[];
  /** 全量状态兜底（发送端保留窗无法覆盖对方缺口时） */
  fullState: boolean;
  state?: Record<string, CrdtChannelState>;
}

/** 向量时钟偏序关系 */
export type VectorClockRelation = 'equal' | 'dominates' | 'dominated' | 'concurrent';

/**
 * 比较两个状态向量时钟（纯函数）：
 * dominates = a 包含 b 的全部因果历史；concurrent = 双方各有对方未见过的操作
 */
export function compareVectorClocks(a: Record<string, number>, b: Record<string, number>): VectorClockRelation {
  let aGreater = false;
  let bGreater = false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    if (av > bv) aGreater = true;
    else if (av < bv) bGreater = true;
  }
  if (aGreater && bGreater) return 'concurrent';
  if (aGreater) return 'dominates';
  if (bGreater) return 'dominated';
  return 'equal';
}

/** add-win 集（自包含实现：removeTags 精确墓碑——并发 add 的标签不被陪葬） */
class AddWinSet {
  private added = new Map<string, Set<string>>();
  private removed = new Map<string, Set<string>>();

  add(element: string, tag: string): void {
    const bucket = this.added.get(element) ?? new Set<string>();
    bucket.add(tag);
    this.added.set(element, bucket);
  }

  removeTags(element: string, tags: string[]): void {
    if (tags.length === 0) return;
    const bucket = this.removed.get(element) ?? new Set<string>();
    for (const t of tags) bucket.add(t);
    this.removed.set(element, bucket);
  }

  /** 元素当前活跃标签（remove 发起时的已见标签快照口径） */
  liveTags(element: string): string[] {
    const added = this.added.get(element);
    if (!added) return [];
    const removed = this.removed.get(element);
    return [...added].filter((t) => !removed?.has(t));
  }

  has(element: string): boolean {
    return this.liveTags(element).length > 0;
  }

  elements(): string[] {
    return [...this.added.keys()].filter((e) => this.has(e)).sort();
  }

  state(): NonNullable<CrdtChannelState['set']> {
    const added: Record<string, string[]> = {};
    const removed: Record<string, string[]> = {};
    for (const [e, tags] of this.added) added[e] = [...tags].sort();
    for (const [e, tags] of this.removed) removed[e] = [...tags].sort();
    return { added, removed };
  }

  mergeState(state: NonNullable<CrdtChannelState['set']>): void {
    for (const [e, tags] of Object.entries(state.added ?? {})) {
      for (const t of tags) this.add(e, t);
    }
    for (const [e, tags] of Object.entries(state.removed ?? {})) {
      this.removeTags(e, tags);
    }
  }
}

/** 最后写胜寄存器（(stamp, writer) 字典序全序——平局确定仲裁） */
class LastWriterRegister {
  private value: string | null = null;
  private stamp = -1;
  private writer = '';

  set(value: string, stamp: number, writer: string): void {
    if (stamp < this.stamp) return;
    if (stamp === this.stamp && writer <= this.writer) return;
    this.value = value;
    this.stamp = stamp;
    this.writer = writer;
  }

  state(): NonNullable<CrdtChannelState['register']> {
    return { value: this.value, stamp: this.stamp, writer: this.writer };
  }

  mergeState(state: NonNullable<CrdtChannelState['register']>): void {
    if (state.value === null || state.value === undefined) return;
    this.set(state.value, state.stamp, state.writer);
  }
}

/** 同步引擎配置 */
interface DistributedSyncOptions {
  /** 状态持久化间隔（毫秒），默认 2000 */
  statePersistInterval?: number;
  /** 已应用变更 id 集合上限（FIFO 淘汰） */
  appliedSetLimit?: number;
  /** 同步日志保留条数 */
  syncLogLimit?: number;
  /** 待推送变更总字节上限（防单条大 payload 撑爆内存），默认 16 MB */
  maxPendingBytes?: number;
}

/** 已应用变更集合上限 */
const DEFAULT_APPLIED_LIMIT = 10_000;
/** 同步日志保留条数 */
const DEFAULT_LOG_LIMIT = 200;
/** 待推送变更上限（防止 peer 长期离线导致无限堆积） */
const MAX_PENDING_CHANGES = 5_000;
/** 待推送变更默认字节上限（条数之外的第二道闸：单条大 payload 场景） */
const DEFAULT_MAX_PENDING_BYTES = 16 * 1024 * 1024;
/** 反熵中继日志上限（FIFO；滑出后反熵自动降级全量状态兜底） */
const DEFAULT_AE_LOG_LIMIT = 4096;

/**
 * 分布式记忆同步引擎
 *
 * 被 index.ts 的 manage_sync Tool 调用（status / sync-now / register-node）。
 */
export class DistributedSync {
  private localNodeId: string;
  private memory: LongTermMemory;
  private statePath: string;
  private cryptoEngine?: CryptoEngine | null;
  private state: SyncState;
  /** 已应用的变更 id（幂等去重） */
  private appliedIds = new Set<string>();
  private nodes = new Map<string, SyncNodeConfig>();
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private options: Required<DistributedSyncOptions>;
  /** 各指纹最近一次本地变更时间戳（并发冲突仲裁的第二级依据） */
  private lastLocalChangeAt = new Map<string, number>();
  /** 待推送队列总字节数（含每条变更近似大小缓存） */
  private pendingBytes = new Map<string, number>();
  private totalPendingBytes = 0;

  // ── 反熵协议状态（第三轮；未使用时零介入） ──
  /** 通道定义（计数器通道状态存 crdtCounters，集合/寄存器存此处的实例） */
  private aeChannels = new Map<string, { kind: CrdtChannelKind; set?: AddWinSet; register?: LastWriterRegister }>();
  /** 反熵中继操作日志（全部 origin 的已见操作，按 (origin,seq) 唯一） */
  private aeLog: StampedOperation[] = [];
  /** 状态向量时钟：origin → 已连续应用的最大序号 */
  private aeClock: Record<string, number> = {};
  /** 本节点已发出的操作数（自身向量时钟分量） */
  private aeOwnSeq = 0;

  /**
   * @param localNodeId 本节点 id
   * @param memory 本节点记忆库
   * @param statePath 同步状态持久化路径
   * @param cryptoEngine 可选加密引擎（状态文件加密落盘）
   */
  constructor(localNodeId: string, memory: LongTermMemory, statePath: string, cryptoEngine?: CryptoEngine | null) {
    this.localNodeId = localNodeId;
    this.memory = memory;
    this.statePath = statePath;
    this.cryptoEngine = cryptoEngine ?? null;
    this.options = {
      statePersistInterval: 2000,
      appliedSetLimit: DEFAULT_APPLIED_LIMIT,
      syncLogLimit: DEFAULT_LOG_LIMIT,
      maxPendingBytes: DEFAULT_MAX_PENDING_BYTES,
    };
    this.state = this.loadState();
    // 幂等集合跨重启恢复：原实现仅驻内存——重启后重投批次（peer 重推 /
    // inbox 未清理的文件）会被再次应用，feedback/stats 双重累加，
    // 「已应用的 changeId 集合持久化，重复批次安全跳过」的承诺落空
    if (Array.isArray(this.state.appliedIds)) {
      this.appliedIds = new Set(this.state.appliedIds.slice(-this.options.appliedSetLimit));
    }
    // 恢复待推队列字节计量（大小是载荷的派生量，无需持久化）
    for (const c of this.state.pendingChanges) {
      const size = this.approxSizeOf(c);
      this.pendingBytes.set(c.id, size);
      this.totalPendingBytes += size;
    }
    // 反熵状态跨重启恢复（向量时钟 + 中继日志 + 通道状态）
    if (this.state.aeClock && typeof this.state.aeClock === 'object') {
      this.aeClock = { ...this.state.aeClock };
      this.aeOwnSeq = this.aeClock[localNodeId] ?? 0;
    }
    if (Array.isArray(this.state.aeLog)) {
      const seen = new Set<string>();
      for (const so of this.state.aeLog) {
        if (!so || !so.op || !so.origin || typeof so.seq !== 'number') continue;
        const key = `${so.origin}:${so.seq}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.aeLog.push({ origin: so.origin, seq: so.seq, op: so.op });
      }
      this.aeLog = this.aeLog.slice(-DEFAULT_AE_LOG_LIMIT);
    }
    if (this.state.aeChannels && typeof this.state.aeChannels === 'object') {
      for (const [channel, st] of Object.entries(this.state.aeChannels)) {
        if (!st || !st.kind) continue;
        this.aeChannels.set(channel, this.channelFromState(channel, st));
      }
    }
  }

  /**
   * 记录一条本地变更（由记忆写入路径调用）
   * @param type 变更类型
   * @param fingerprint 变更对象指纹（pattern 指纹 / 模型 id / 反馈 id）
   * @param payload 变更载荷
   */
  recordChange(type: ChangeEntry['type'], fingerprint: string, payload: ChangePayload): void {
    this.state.localClock += 1;
    const entry: ChangeEntry = {
      id: `${this.localNodeId}:${this.state.localClock}:${crypto.randomBytes(4).toString('hex')}`,
      type,
      fingerprint,
      timestamp: Date.now(),
      sourceNodeId: this.localNodeId,
      payload,
      logicalClock: this.state.localClock,
      dataHash: this.hashPayload(payload),
    };
    // 指纹级本地变更时间：并发冲突仲裁第二级（本地侧）真实依据
    this.lastLocalChangeAt.set(fingerprint, entry.timestamp);
    this.state.pendingChanges.push(entry);
    const size = this.approxSizeOf(entry);
    this.pendingBytes.set(entry.id, size);
    this.totalPendingBytes += size;
    // 双闸淘汰：条数上限 + 字节上限（后者防单条大 payload——完整模式
    // 载荷可达数十 KB，条数闸下 5000 条足以撑出数百 MB 常驻内存）
    while (
      this.state.pendingChanges.length > MAX_PENDING_CHANGES ||
      (this.totalPendingBytes > this.options.maxPendingBytes && this.state.pendingChanges.length > 1)
    ) {
      const evicted = this.state.pendingChanges.shift();
      if (!evicted) break;
      const sz = this.pendingBytes.get(evicted.id);
      if (sz !== undefined) {
        this.totalPendingBytes -= sz;
        this.pendingBytes.delete(evicted.id);
      }
    }
    this.schedulePersist();
  }

  /**
   * 获取待推送给指定 peer 的增量变更（clock > peer 已知进度）
   * @param forPeerId 目标 peer，缺省返回全部待推送变更
   */
  getPendingChanges(forPeerId?: string): ChangeEntry[] {
    if (!forPeerId) return [...this.state.pendingChanges];
    const peerClock = this.state.peerClocks[forPeerId] ?? 0;
    return this.state.pendingChanges.filter((c) => c.logicalClock > peerClock);
  }

  /**
   * 确认 peer 已消费到指定时钟位点（可裁剪已确认变更）
   */
  acknowledgePeer(peerId: string, clock: number): void {
    this.state.peerClocks[peerId] = Math.max(this.state.peerClocks[peerId] ?? 0, clock);
    // 所有 peer 都已确认的变更可安全裁剪（同步回收字节计量）
    const minConfirmed = Math.min(...Object.values(this.state.peerClocks));
    if (Object.keys(this.state.peerClocks).length > 0 && Number.isFinite(minConfirmed)) {
      const before = this.state.pendingChanges.length;
      this.state.pendingChanges = this.state.pendingChanges.filter((c) => c.logicalClock > minConfirmed);
      if (this.state.pendingChanges.length !== before) {
        this.pendingBytes.clear();
        this.totalPendingBytes = 0;
        for (const c of this.state.pendingChanges) {
          const size = this.approxSizeOf(c);
          this.pendingBytes.set(c.id, size);
          this.totalPendingBytes += size;
        }
      }
    }
    this.schedulePersist();
  }

  /**
   * 接收并应用远端批次
   *
   * 流程：批次哈希校验 → 逐条幂等应用 → 冲突检测与仲裁 → 时钟推进
   */
  async receiveBatch(batch: SyncBatch): Promise<{ applied: number; conflicts: SyncConflict[]; errors: string[] }> {
    const errors: string[] = [];
    const conflicts: SyncConflict[] = [];
    let applied = 0;

    // 1. 批次完整性校验
    if (!this.verifyBatchHash(batch)) {
      return { applied: 0, conflicts, errors: ['批次哈希校验失败：数据可能已损坏或被篡改'] };
    }

    // 2. 逐条应用
    for (const change of batch.changes) {
      try {
        // 载荷哈希校验（先于幂等检查：篡改必须暴露，即使 id 已见过）
        if (this.hashPayload(change.payload) !== change.dataHash) {
          errors.push(`变更 ${change.id} 载荷哈希不匹配，已跳过`);
          continue;
        }
        // 幂等：已应用过的变更跳过
        if (this.appliedIds.has(change.id)) continue;
        const conflict = this.applyChange(change);
        if (conflict) conflicts.push(conflict);
        this.appliedIds.add(change.id);
        this.trimAppliedIds();
        applied += 1;
      } catch (err) {
        errors.push(`变更 ${change.id} 应用失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3. Lamport 时钟推进：max(local, remote) + 1
    this.state.localClock = Math.max(this.state.localClock, batch.logicalClock) + 1;
    this.state.lastSyncAt[batch.sourceNodeId] = Date.now();
    this.schedulePersist();

    return { applied, conflicts, errors };
  }

  /**
   * 为指定 peer 创建增量批次（无新变更时返回 null）
   */
  createBatch(forPeerId: string): SyncBatch | null {
    const changes = this.getPendingChanges(forPeerId);
    if (changes.length === 0) return null;
    const batch: SyncBatch = {
      batchId: `${this.localNodeId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      sourceNodeId: this.localNodeId,
      changes,
      timestamp: Date.now(),
      logicalClock: this.state.localClock,
      batchHash: '',
    };
    batch.batchHash = this.computeBatchHash(batch);
    return batch;
  }

  /**
   * 注册同步节点（enabled 的 http-poll 节点自动启动定时拉取）
   */
  registerNode(config: SyncNodeConfig): void {
    this.nodes.set(config.nodeId, config);
    if (config.enabled !== false && config.protocol === 'http-poll' && config.pollInterval && config.pollInterval > 0) {
      this.startPolling(config);
    }
    this.schedulePersist();
  }

  /**
   * 创建 HTTP 同步端点处理器（供集成层挂载到 HTTP 服务）
   *
   * - handlePush: POST 接收远端批次
   * - handlePull: GET 返回本地增量批次（?peerId=xxx&since=clock）
   * - handleStatus: GET 返回同步状态摘要
   */
  createSyncHandlers(): {
    handlePush: (body: unknown) => Promise<Record<string, unknown>>;
    handlePull: (query: { peerId?: string }) => { ok: boolean; batch: SyncBatch | null };
    handleAck: (body: { peerId?: string; clock?: number }) => Record<string, unknown>;
    handleStatus: () => Record<string, unknown>;
  } {
    return {
      handlePush: async (body: unknown) => {
        const batch = body as SyncBatch;
        if (!batch || !Array.isArray(batch.changes)) {
          return { ok: false, error: '非法批次结构' };
        }
        const result = await this.receiveBatch(batch);
        // 注意：此处不可 acknowledgePeer——推送方消费的是「它自己的时钟域」，
        // 而 peerClocks 记录的是「对方已消费我的变更到我的时钟几」。原实现
        // 把 sender 的 logicalClock 记进我的 peerClocks，之后 createBatch 给
        // 该 peer 的增量会错误跳过一批它从未收到的本地变更（永久丢失）
        return { ok: result.errors.length === 0, ...result };
      },
      handlePull: (query: { peerId?: string }) => {
        const peerId = query.peerId ?? 'unknown';
        const batch = this.createBatch(peerId);
        // 交付语义修复：此处不再立即确认进度——批次在拉取方应用失败
        // （传输中断 / 应用异常）时，提前确认会让该批变更永久漏推；
        // 改由拉取方应用成功后显式回执 handleAck（至少一次交付 +
        // 幂等应用 = 恰好一次效果）
        return { ok: true, batch };
      },
      handleAck: (body: { peerId?: string; clock?: number }) => {
        // 拉取方应用成功的显式回执：此刻确认「对方已消费我的时钟域到此」
        if (!body.peerId || typeof body.clock !== 'number' || !Number.isFinite(body.clock)) {
          return { ok: false, error: '非法回执：需要 peerId 与数字 clock' };
        }
        this.acknowledgePeer(body.peerId, body.clock);
        return { ok: true };
      },
      handleStatus: () => ({
        ok: true,
        nodeId: this.localNodeId,
        localClock: this.state.localClock,
        pendingChanges: this.state.pendingChanges.length,
        pendingBytes: this.totalPendingBytes,
        peers: Object.keys(this.state.peerClocks),
        unresolvedConflicts: this.state.unresolvedConflicts.length,
      }),
    };
  }

  /**
   * 立即与指定 peer 同步一次（push 本地增量 + 可选 pull 远端增量）
   * @param peerId 已注册节点 id
   */
  async syncNow(peerId: string): Promise<SyncLogEntry> {
    const startedAt = Date.now();
    const log: SyncLogEntry = {
      timestamp: startedAt,
      direction: 'push',
      remoteNodeId: peerId,
      changesSent: 0,
      changesReceived: 0,
      conflictsDetected: 0,
      conflictsResolved: 0,
      errors: [],
      duration: 0,
      status: 'success',
    };

    const node = this.nodes.get(peerId);
    if (!node) {
      log.status = 'failed';
      log.errors.push(`未注册的节点: ${peerId}`);
      this.appendSyncLog(log);
      return log;
    }

    try {
      if (node.protocol === 'http-poll') {
        await this.syncViaHttp(node, log);
      } else if (node.protocol === 'file-share') {
        await this.syncViaFileShare(node, log);
      } else {
        log.errors.push(`暂不支持的协议: ${node.protocol}`);
        log.status = 'failed';
      }
    } catch (err) {
      log.errors.push(err instanceof Error ? err.message : String(err));
      log.status = 'failed';
    }

    log.duration = Date.now() - startedAt;
    if (log.status !== 'failed' && log.errors.length > 0) log.status = 'partial';
    this.appendSyncLog(log);
    return log;
  }

  /**
   * 停止全部轮询定时器与持久化定时器
   */
  stop(): void {
    for (const timer of this.pollTimers.values()) clearInterval(timer);
    this.pollTimers.clear();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistState();
  }

  /**
   * 获取同步状态摘要（供 manage_sync status 使用）
   */
  /** 同步状态摘要（运维可观测） */
  getStatus(): {
    localNodeId: string;
    localClock: number;
    registeredNodes: Array<{ nodeId: string; name: string; protocol: SyncNodeConfig['protocol']; enabled: boolean }>;
    peerClocks: Record<string, number>;
    pendingChanges: number;
    unresolvedConflicts: number;
    recentSyncs: SyncLogEntry[];
    lastSyncAt: Record<string, number>;
  } {
    return {
      localNodeId: this.localNodeId,
      localClock: this.state.localClock,
      registeredNodes: [...this.nodes.values()].map((n) => ({
        nodeId: n.nodeId,
        name: n.name,
        protocol: n.protocol,
        enabled: n.enabled !== false,
      })),
      peerClocks: { ...this.state.peerClocks },
      pendingChanges: this.state.pendingChanges.length,
      unresolvedConflicts: this.state.unresolvedConflicts.length,
      recentSyncs: this.state.syncLog.slice(-5),
      lastSyncAt: { ...this.state.lastSyncAt },
    };
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /**
   * 应用单条变更到本地记忆库
   * @returns 检测到冲突时返回冲突记录（已自动仲裁）
   */
  private applyChange(change: ChangeEntry): SyncConflict | null {
    switch (change.type) {
      case 'pattern-created':
      case 'pattern-updated': {
        // 边界收窄：模式类变更载荷应为完整模式（轻量变更描述仅用于同步登记，不参与 upsert）
        const pattern = change.payload as TaskPatternMemory;
        const local = this.memory.getAllTaskPatterns().find((p) => p.fingerprint === change.fingerprint);
        if (local && change.type === 'pattern-updated') {
          // 并发修改冲突：三级仲裁 (clock, timestamp, nodeId)
          const localClock = this.state.localClock;
          const localTs = this.lastLocalChangeAt.get(change.fingerprint) ?? 0;
          const remoteWins = this.arbitrate(localClock, change.logicalClock, change.timestamp, localTs, change.sourceNodeId);
          const conflict: SyncConflict = {
            changeId: change.id,
            fingerprint: change.fingerprint,
            localData: local,
            remoteData: change.payload,
            localClock,
            remoteClock: change.logicalClock,
            resolution: remoteWins ? 'remote-wins' : 'local-wins',
            resolvedAt: Date.now(),
            resolutionReason: remoteWins
              ? '远端时钟/时间戳更新'
              : '本地时钟更新，保留本地版本',
          };
          this.state.unresolvedConflicts.push(conflict);
          if (remoteWins) {
            this.memory.upsertPattern(pattern);
          }
          return conflict;
        }
        this.memory.upsertPattern(pattern);
        return null;
      }
      case 'pattern-deleted':
        this.memory.removePattern(change.fingerprint);
        return null;
      case 'model-profile-updated':
        this.memory.upsertModelProfile(change.payload as ModelLongTermProfile);
        return null;
      case 'feedback-created':
        this.memory.appendFeedback(change.payload as DecisionFeedback);
        return null;
      case 'stats-updated':
        this.memory.mergeGlobalStats(change.payload as MemoryStore['globalStats']);
        return null;
      default:
        return null;
    }
  }

  /**
   * 三级仲裁：clock 高者胜 → timestamp 新者胜 → nodeId 字典序大者胜。
   * 第二级原实现用 Date.now() 近似本地变更时间——墙钟在「应用远端批次」
   * 的当下必然新于远端时间戳，等价于「时钟同段时远端恒胜」，仲裁退化为
   * 单级；现改用指纹级真实本地变更时间（recordChange 时记录）。
   * 第三级 nodeId 决胜保证双方独立仲裁结果一致（无分歧收敛）
   */
  private arbitrate(
    localClock: number,
    remoteClock: number,
    remoteTimestamp: number,
    localTimestamp: number,
    remoteNodeId: string,
  ): boolean {
    if (remoteClock !== localClock) return remoteClock > localClock;
    if (remoteTimestamp !== localTimestamp) return remoteTimestamp > localTimestamp;
    return remoteNodeId > this.localNodeId;
  }

  /** http-poll 协议同步：先 push 本地增量，再 pull 远端增量 */
  private async syncViaHttp(node: SyncNodeConfig, log: SyncLogEntry): Promise<void> {
    const baseUrl = node.remoteUrl?.replace(/\/$/, '');
    if (!baseUrl) throw new NetworkError(`节点 ${node.nodeId} 缺少 remoteUrl`);

    // push：本地增量 → 远端
    const outBatch = this.createBatch(node.nodeId);
    if (outBatch) {
      const pushResult = await this.httpRequest(`${baseUrl}/sync/push`, 'POST', outBatch, node.authToken);
      if (pushResult.ok) {
        log.changesSent = outBatch.changes.length;
        this.acknowledgePeer(node.nodeId, outBatch.logicalClock);
      } else {
        log.errors.push(`push 被拒: ${pushResult.error ?? 'unknown'}`);
      }
    }

    // pull：远端增量 → 本地（双向同步时）
    if (node.bidirectional !== false) {
      const pullResult = await this.httpRequest(
        `${baseUrl}/sync/pull?peerId=${encodeURIComponent(this.localNodeId)}`,
        'GET',
        undefined,
        node.authToken,
      );
      if (pullResult.ok && pullResult.batch) {
        const received = await this.receiveBatch(pullResult.batch);
        log.changesReceived = received.applied;
        log.conflictsDetected = received.conflicts.length;
        log.conflictsResolved = received.conflicts.filter((c) => c.resolution !== 'pending').length;
        log.errors.push(...received.errors);
        // 拉回的是对方时钟域的增量：我消费它≠它消费我，不可记入
        // 我对它的 peerClocks（时钟域混记会让后续推送静默跳变更）。
        // 应用干净后显式回执对方的进度确认端点；有错误则不回执——
        // 对方重投整批，已应用部分由 appliedIds 幂等跳过
        if (received.errors.length === 0) {
          await this.httpRequest(
            `${baseUrl}/sync/ack`,
            'POST',
            { peerId: this.localNodeId, clock: pullResult.batch.logicalClock },
            node.authToken,
          ).catch(() => {
            /* 回执失败：对方保持未确认，下轮重投（幂等安全） */
          });
        }
      }
    }
  }

  /** file-share 协议同步：通过共享目录交换批次文件 */
  private async syncViaFileShare(node: SyncNodeConfig, log: SyncLogEntry): Promise<void> {
    const sharePath = node.sharePath;
    if (!sharePath) throw new NetworkError(`节点 ${node.nodeId} 缺少 sharePath`);
    const inboxDir = path.join(sharePath, node.nodeId, 'inbox');
    const outboxDir = path.join(sharePath, this.localNodeId, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });

    // push：写批次文件到对方 inbox
    const outBatch = this.createBatch(node.nodeId);
    if (outBatch) {
      const filePath = path.join(inboxDir, `${outBatch.batchId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(outBatch), 'utf-8');
      log.changesSent = outBatch.changes.length;
      this.acknowledgePeer(node.nodeId, outBatch.logicalClock);
    }

    // pull：消费自己 inbox 中的批次文件
    if (node.bidirectional !== false && fs.existsSync(outboxDir)) {
      for (const file of fs.readdirSync(outboxDir).filter((f) => f.endsWith('.json')).sort()) {
        const filePath = path.join(outboxDir, file);
        try {
          const batch = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SyncBatch;
          const received = await this.receiveBatch(batch);
          log.changesReceived += received.applied;
          log.conflictsDetected += received.conflicts.length;
          log.conflictsResolved += received.conflicts.filter((c) => c.resolution !== 'pending').length;
          log.errors.push(...received.errors);
          // 同上：对方时钟域的进度不可混记进 peerClocks（我的域）。
          // 应用干净才删文件；有错误保留待下轮重试（至少一次交付，
          // 已应用部分由 appliedIds 幂等跳过）——原实现无条件删除，
          // 部分应用失败即静默丢批
          if (received.errors.length === 0) {
            fs.rmSync(filePath);
          } else {
            log.errors.push(`批次 ${file} 部分应用失败，保留待重试`);
          }
        } catch (err) {
          // 解析/读取异常：保留批次文件待下轮重试——原实现无条件删除，
          // 处理中途异常即静默丢批
          log.errors.push(`批次文件处理失败 ${file}（保留待重试）: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  /** 启动 http-poll 定时拉取 */
  private startPolling(node: SyncNodeConfig): void {
    if (this.pollTimers.has(node.nodeId)) return;
    const timer = setInterval(() => {
      this.syncNow(node.nodeId).catch(() => {
        /* 单次轮询失败不中断定时器 */
      });
    }, node.pollInterval! * 1000);
    timer.unref?.();
    this.pollTimers.set(node.nodeId, timer);
  }

  /** 简易 HTTP 请求（走环境代理，JSON 载荷） */
  private httpRequest(url: string, method: 'GET' | 'POST', body?: unknown, authToken?: string): Promise<SyncHttpResponse> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || 80,
          path: parsed.pathname + parsed.search,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          timeout: 10_000,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data || '{}'));
            } catch {
              resolve({ ok: false, error: `非法响应: ${data.slice(0, 100)}` });
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new NetworkError(`请求超时: ${url}`));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** 计算批次哈希（变更 id + dataHash 链式哈希） */
  private computeBatchHash(batch: SyncBatch): string {
    const chain = batch.changes.map((c) => `${c.id}:${c.dataHash}`).join('|');
    return crypto.createHash('sha256').update(`${batch.sourceNodeId}:${batch.logicalClock}:${chain}`).digest('hex');
  }

  /** 校验批次哈希 */
  private verifyBatchHash(batch: SyncBatch): boolean {
    return this.computeBatchHash(batch) === batch.batchHash;
  }

  /** 载荷哈希 */
  private hashPayload(payload: ChangePayload): string {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  /** 变更条目近似字节数（载荷序列化长度 + 条目固定开销） */
  private approxSizeOf(entry: ChangeEntry): number {
    try {
      return JSON.stringify(entry.payload).length + 256;
    } catch {
      return 4096; // 序列化异常（循环引用等）按保守值计
    }
  }
  /** 已应用集合 FIFO 淘汰 */
  private trimAppliedIds(): void {
    if (this.appliedIds.size <= this.options.appliedSetLimit) return;
    const overflow = this.appliedIds.size - this.options.appliedSetLimit;
    const iter = this.appliedIds.values();
    for (let i = 0; i < overflow; i++) {
      const value = iter.next().value;
      if (value !== undefined) this.appliedIds.delete(value);
    }
  }

  /** 追加同步日志（限长） */
  private appendSyncLog(log: SyncLogEntry): void {
    this.state.syncLog.push(log);
    if (this.state.syncLog.length > this.options.syncLogLimit) {
      this.state.syncLog = this.state.syncLog.slice(-this.options.syncLogLimit);
    }
    this.schedulePersist();
  }

  /** 加载同步状态 */
  private loadState(): SyncState {
    const empty: SyncState = {
      localClock: 0,
      peerClocks: {},
      pendingChanges: [],
      unresolvedConflicts: [],
      syncLog: [],
      lastSyncAt: {},
    };
    if (!fs.existsSync(this.statePath)) return empty;
    try {
      let data: any;
      if (this.cryptoEngine) {
        data = this.cryptoEngine.readEncrypted(this.statePath).data;
      } else {
        data = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
      }
      return { ...empty, ...data };
    } catch {
      return empty;
    }
  }

  /** 防抖持久化调度 */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistState();
    }, this.options.statePersistInterval);
    this.persistTimer.unref?.();
  }

  /** 执行状态持久化 */
  private persistState(): void {
    try {
      // 幂等集合随状态落盘（有界，FIFO 截断与内存淘汰口径一致）
      this.state.appliedIds = [...this.appliedIds].slice(-this.options.appliedSetLimit);
      // 反熵状态落盘（向量时钟 + 中继日志 + 集合/寄存器通道；计数器复用 crdtCounters 状态）
      this.state.aeClock = { ...this.aeClock };
      this.state.aeLog = this.aeLog.slice(-DEFAULT_AE_LOG_LIMIT);
      const channels: Record<string, CrdtChannelState> = {};
      for (const [channel, def] of this.aeChannels) {
        if (def.kind === 'counter') channels[channel] = { kind: 'counter', counts: this.crdtCounters.get(channel)?.state() ?? {} };
        else if (def.kind === 'set') channels[channel] = { kind: 'set', set: def.set ? def.set.state() : { added: {}, removed: {} } };
        else channels[channel] = { kind: 'register', register: def.register ? def.register.state() : { value: null, stamp: -1, writer: '' } };
      }
      this.state.aeChannels = channels;
      if (this.cryptoEngine) {
        this.cryptoEngine.writeEncrypted(this.statePath, this.state);
        return;
      }
      const dir = path.dirname(this.statePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.statePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
      fs.renameSync(tmp, this.statePath);
    } catch {
      /* 状态持久化失败不阻塞同步流程 */
    }
  }

  // ─────────────── 47.0 CRDT 收敛通道（缺省零介入） ───────────────

  /** 47.0：跨节点收敛计数器（G-Counter；按通道隔离） */
  private crdtCounters = new Map<string, GCounter>();

  /**
   * 47.0：CRDT 收敛通道（幂等挂载，挂载即生效——纯增量口径）。
   *
   * 网络分区 / 乱序 / 重复送达下的状态收敛从协议希望升级为合并算子
   * 的代数性质（join-semilattice 三律 ⟹ 强最终一致性，Shapiro 2011）：
   * 本地递增 incrementCrdtCounter，远端状态经 mergeCrdtState 合入，
   * crdtState 读取——任何消息顺序都收敛到同一读数。
   */
  attachCrdtChannel(channels: ReadonlyArray<string>): void {
    for (const c of channels) {
      if (!this.crdtCounters.has(c)) this.crdtCounters.set(c, new GCounter());
      if (!this.aeChannels.has(c)) this.aeChannels.set(c, { kind: 'counter' });
    }
  }

  /**
   * 47.0：本地递增（通道不存在时惰性创建）。
   * 第三轮升级：同时以 op-based 形式进反熵日志——增量经由 antiEntropyBatch
   * 传播（mergeCrdtState 的全量对撞通道保留，两者共用同一 G-Counter 状态）
   */
  incrementCrdtCounter(channel: string, by = 1): void {
    this.emitCrdtOperation({ kind: 'increment', channel, by });
  }

  /**
   * 47.0：合入远端 CRDT 状态（交换/幂等——重复合入无害；全量状态通道）。
   *
   * 通道口径约束：同一通道不要同时使用本方法（状态对撞）与反熵增量流
   * （antiEntropyBatch/applyAntiEntropy）——增量 op 非幂等，效果已经由
   * 状态合并到位的 op 会在增量通道被再次相加。两种通道按通道隔离使用
   */
  mergeCrdtState(remote: Record<string, Record<string, number>>): void {
    for (const [channel, counts] of Object.entries(remote)) {
      let counter = this.crdtCounters.get(channel);
      if (!counter) {
        counter = new GCounter();
        this.crdtCounters.set(channel, counter);
      }
      const other = new GCounter();
      for (const [node, v] of Object.entries(counts)) other.increment(node, v);
      counter.merge(other);
    }
  }

  /** 47.0：CRDT 状态快照（计数器通道；可序列化 gossip 载荷） */
  crdtState(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [channel, counter] of this.crdtCounters) out[channel] = counter.state();
    return out;
  }

  // ─────────────── 47.x CRDT 反熵协议（向量时钟 + 增量传播 + 冲突合并） ───────────────

  /**
   * 声明 CRDT 通道种类（计数器通道亦可经 attachCrdtChannel 挂载）。
   * 未声明的通道在首个操作时按操作种类自动创建
   */
  registerCrdtChannels(spec: Record<string, CrdtChannelKind>): void {
    for (const [channel, kind] of Object.entries(spec)) {
      this.channelFor(channel, kind, true);
    }
  }

  /** 本节点状态向量时钟（只读副本） */
  antiEntropyClock(): Record<string, number> {
    return { ...this.aeClock };
  }

  /**
   * 发出一个 CRDT 操作：分配自身因果坐标 (localNodeId, ++seq)、本地应用、
   * 进中继日志。remove 未显式给 tags 时固化「本端当前活跃标签集」——
   * add-win 语义要求墓碑在发起时刻封闭。
   *
   * 通道口径约束：经 emit 的通道应走反熵增量流同步；与 mergeCrdtState
   * 状态对撞混用于同一通道会双计非幂等增量（见 mergeCrdtState 注释）
   */
  emitCrdtOperation(op: CrdtOperation): StampedOperation {
    let operation = op;
    if (op.kind === 'remove' && (!op.tags || op.tags.length === 0)) {
      const channel = this.channelFor(op.channel, 'set');
      operation = { ...op, tags: channel.set ? channel.set.liveTags(op.element) : [] };
    } else {
      // 确保通道存在（计数器/寄存器/集按首个操作定型）
      this.channelFor(op.channel, op.kind === 'increment' ? 'counter' : op.kind === 'set' ? 'register' : 'set');
    }
    this.aeOwnSeq += 1;
    const stamped: StampedOperation = { origin: this.localNodeId, seq: this.aeOwnSeq, op: operation };
    this.aeClock[this.localNodeId] = this.aeOwnSeq;
    this.applyStamped(stamped, true);
    this.rememberOp(stamped);
    this.schedulePersist();
    return stamped;
  }

  /**
   * 增量反熵批次：只含对方向量时钟缺失的操作。
   *
   * - 保留窗缺口检测：对方缺的序号已滑出中继日志时，降级为全量状态兜底
   *   （半格合并与操作流殊途同归——收敛不被保留窗破坏）
   * - ops 按 origin 分组、seq 升序：接收端沿因果序无空洞应用
   */
  antiEntropyBatch(peerClock: Record<string, number>): AntiEntropyBatch {
    const peer = peerClock ?? {};
    // 各 origin 在中继日志中的最早序号（保留窗下界；无保留视为无穷早）
    const oldestByOrigin = new Map<string, number>();
    for (const so of this.aeLog) {
      const cur = oldestByOrigin.get(so.origin);
      if (cur === undefined || so.seq < cur) oldestByOrigin.set(so.origin, so.seq);
    }
    let truncated = false;
    for (const [origin, mine] of Object.entries(this.aeClock)) {
      const theirs = peer[origin] ?? 0;
      const oldest = oldestByOrigin.get(origin) ?? Number.MAX_SAFE_INTEGER;
      if (theirs < mine && theirs < oldest - 1) {
        truncated = true;
        break;
      }
    }
    if (truncated) {
      return { from: this.localNodeId, clock: { ...this.aeClock }, ops: [], fullState: true, state: this.crdtFullState() };
    }
    const ops = this.aeLog.filter((so) => so.seq > (peer[so.origin] ?? 0));
    return { from: this.localNodeId, clock: { ...this.aeClock }, ops, fullState: false };
  }

  /**
   * 应用反熵批次：
   * - 全量兜底：通道状态半格合并（幂等/交换/结合）+ 时钟合并；操作只入
   *   中继日志不再应用（状态已含其效果——重复应用会双计非幂等操作）
   * - 增量流：缺口检测（seq > 水位+1 的操作跳过留待重传，水位不虚进）
   */
  applyAntiEntropy(batch: AntiEntropyBatch): { applied: number; skipped: number; stateMerged: boolean } {
    if (!batch || batch.from === this.localNodeId) return { applied: 0, skipped: 0, stateMerged: false };
    if (batch.fullState) {
      for (const [channel, state] of Object.entries(batch.state ?? {})) {
        if (!state || !state.kind) continue;
        this.mergeChannelState(channel, state);
      }
      for (const so of sortOps(batch.ops)) this.rememberOp(so);
      this.mergeClock(batch.clock);
      this.schedulePersist();
      return { applied: 0, skipped: batch.ops.length, stateMerged: true };
    }
    let applied = 0;
    let skipped = 0;
    for (const so of sortOps(batch.ops)) {
      const watermark = this.aeClock[so.origin] ?? 0;
      if (so.seq <= watermark) {
        skipped += 1; // 重复投递
        continue;
      }
      if (so.seq > watermark + 1) {
        skipped += 1; // 因果缺口：跳过留待重传（水位不虚进——不会假性覆盖）
        continue;
      }
      this.applyStamped(so, false);
      this.aeClock[so.origin] = so.seq;
      this.rememberOp(so);
      applied += 1;
    }
    this.mergeClock(batch.clock);
    this.schedulePersist();
    return { applied, skipped, stateMerged: false };
  }

  /** 通道收敛读数（counter 总和 / set 排序元素 / register 值） */
  crdtRead(channel: string): number | string[] | string | null | undefined {
    const def = this.aeChannels.get(channel);
    if (!def) return undefined;
    if (def.kind === 'counter') return this.crdtCounters.get(channel)?.value() ?? 0;
    if (def.kind === 'set') return def.set ? def.set.elements() : [];
    return def.register ? def.register.state().value : null;
  }

  /** 全部通道状态快照（收敛比对 / 全量兜底载荷；canonical 口径可逐位比对） */
  crdtFullState(): Record<string, CrdtChannelState> {
    const out: Record<string, CrdtChannelState> = {};
    for (const [channel, def] of this.aeChannels) {
      if (def.kind === 'counter') out[channel] = { kind: 'counter', counts: this.crdtCounters.get(channel)?.state() ?? {} };
      else if (def.kind === 'set') out[channel] = { kind: 'set', set: def.set ? def.set.state() : { added: {}, removed: {} } };
      else out[channel] = { kind: 'register', register: def.register ? def.register.state() : { value: null, stamp: -1, writer: '' } };
    }
    return out;
  }

  // ── 反熵内部 ──

  /** 取通道定义；不存在时按 kind 创建（kind 冲突返回既有定义——通道定型不改） */
  private channelFor(
    channel: string,
    kind: CrdtChannelKind,
    force = false,
  ): { kind: CrdtChannelKind; set?: AddWinSet; register?: LastWriterRegister } {
    let def = this.aeChannels.get(channel);
    if (!def) {
      def = kind === 'set' ? { kind, set: new AddWinSet() } : kind === 'register' ? { kind, register: new LastWriterRegister() } : { kind };
      if (kind === 'counter' && !this.crdtCounters.has(channel)) this.crdtCounters.set(channel, new GCounter());
      this.aeChannels.set(channel, def);
      return def;
    }
    if (force && def.kind !== kind) return def; // 通道已定型：拒绝改种
    return def;
  }

  /** 从持久化状态重建通道实例 */
  private channelFromState(channel: string, st: CrdtChannelState): { kind: CrdtChannelKind; set?: AddWinSet; register?: LastWriterRegister } {
    if (st.kind === 'counter') {
      // 计数器分量必须真正回灌 G-Counter（挂空壳会让重启后读数归零）
      const counter = new GCounter();
      for (const [node, v] of Object.entries(st.counts ?? {})) counter.increment(node, v);
      this.crdtCounters.set(channel, counter);
      return { kind: 'counter' };
    }
    if (st.kind === 'set') {
      const set = new AddWinSet();
      set.mergeState(st.set ?? { added: {}, removed: {} });
      return { kind: 'set', set };
    }
    const register = new LastWriterRegister();
    register.mergeState(st.register ?? { value: null, stamp: -1, writer: '' });
    return { kind: 'register', register };
  }

  /** 应用一个已定坐标的操作（本地 emit 与远端批次共用；效果确定性依赖于 op 全量） */
  private applyStamped(stamped: StampedOperation, isLocal: boolean): void {
    const { op } = stamped;
    if (op.kind === 'increment') {
      const def = this.channelFor(op.channel, 'counter');
      if (def.kind !== 'counter') return;
      let counter = this.crdtCounters.get(op.channel);
      if (!counter) {
        counter = new GCounter();
        this.crdtCounters.set(op.channel, counter);
      }
      counter.increment(stamped.origin, Math.max(0, Math.floor(op.by))); // 分量记在 origin 名下
      return;
    }
    if (op.kind === 'add') {
      const def = this.channelFor(op.channel, 'set');
      if (def.kind !== 'set') return;
      if (!def.set) def.set = new AddWinSet();
      def.set.add(op.element, op.tag ?? `${stamped.origin}:${stamped.seq}`);
      return;
    }
    if (op.kind === 'remove') {
      const def = this.channelFor(op.channel, 'set');
      if (def.kind !== 'set') return;
      if (!def.set) def.set = new AddWinSet();
      def.set.removeTags(op.element, op.tags ?? []);
      return;
    }
    // set（寄存器）
    const def = this.channelFor(op.channel, 'register');
    if (def.kind !== 'register') return;
    if (!def.register) def.register = new LastWriterRegister();
    def.register.set(op.value, op.stamp, stamped.origin);
    void isLocal;
  }

  /** 操作入中继日志（调用路径保证 (origin, seq) 不重复；FIFO 限长） */
  private rememberOp(stamped: StampedOperation): void {
    this.aeLog.push(stamped);
    if (this.aeLog.length > DEFAULT_AE_LOG_LIMIT) this.aeLog = this.aeLog.slice(-DEFAULT_AE_LOG_LIMIT);
  }

  /** 合并向量时钟（逐分量 max） */
  private mergeClock(remote: Record<string, number>): void {
    for (const [origin, seq] of Object.entries(remote ?? {})) {
      if (typeof seq !== 'number' || !Number.isFinite(seq)) continue;
      this.aeClock[origin] = Math.max(this.aeClock[origin] ?? 0, seq);
    }
  }

  /** 通道状态半格合并（全量兜底路径） */
  private mergeChannelState(channel: string, state: CrdtChannelState): void {
    const def = this.channelFor(
      channel,
      state.kind,
    );
    if (state.kind === 'counter' && def.kind === 'counter') {
      let counter = this.crdtCounters.get(channel);
      if (!counter) {
        counter = new GCounter();
        this.crdtCounters.set(channel, counter);
      }
      const other = new GCounter();
      for (const [node, v] of Object.entries(state.counts ?? {})) other.increment(node, v);
      counter.merge(other);
      return;
    }
    if (state.kind === 'set' && def.kind === 'set') {
      if (!def.set) def.set = new AddWinSet();
      def.set.mergeState(state.set ?? { added: {}, removed: {} });
      return;
    }
    if (state.kind === 'register' && def.kind === 'register') {
      if (!def.register) def.register = new LastWriterRegister();
      def.register.mergeState(state.register ?? { value: null, stamp: -1, writer: '' });
    }
  }
}

/** 操作流按 (origin, seq) 全序排序（确定性应用序） */
function sortOps(ops: ReadonlyArray<StampedOperation>): StampedOperation[] {
  return [...ops].sort((a, b) => (a.origin === b.origin ? a.seq - b.seq : a.origin < b.origin ? -1 : 1));
}

// ─────────────────────────── 跨集群联邦网关（第四轮，独立新增面） ───────────────────────────

/** 联邦订阅：命名空间 + 键前缀（只订阅指纹匹配前缀的变更） */
export interface FederationSubscription {
  namespace: string;
  keyPrefix: string;
}

/** 联邦网关选项 */
export interface FederationGatewayOptions {
  /** 网关 id（审计标识） */
  gatewayId: string;
  /** 订阅清单（缺省空 = 不转发任何内容） */
  subscriptions?: FederationSubscription[];
  /** 每窗口最多转发的变更条数（限流） */
  ratePerWindow: number;
  /** 窗口长度（毫秒） */
  windowMs: number;
  /** 注入时钟（缺省 Date.now——确定性仿真注入虚拟时钟） */
  now?: () => number;
  /** 待发队列上限（默认 1024；超限丢弃并计数——防洪泛） */
  maxQueue?: number;
}

/** 联邦网关统计（零传输与限流的可验证口径） */
export interface FederationStats {
  /** offer 进网的变更总数 */
  offered: number;
  /** 命中订阅（进入待发队列）的变更数 */
  matched: number;
  /** 未订阅前缀被出口裁剪数（零传输） */
  filtered: number;
  /** 队列超限丢弃数 */
  dropped: number;
  /** 已转发变更数 */
  forwarded: number;
  /** 当前滞留队列长度（限流延迟中） */
  deferred: number;
  /** 已转发批次字节总量（近似序列化长度） */
  bytesForwarded: number;
  /** 按「命名空间:前缀」的转发计数（未订阅前缀不出现——零传输证据） */
  forwardedByPrefix: Record<string, number>;
  /** 已流转的限流窗口数 */
  windowsElapsed: number;
  /** 限流实际生效的次数（有变更因窗口令牌耗尽而滞留的 pump 次数） */
  throttledPumps: number;
}

/**
 * 构建联邦批次（纯函数）：与 DistributedSync.computeBatchHash 同一
 * 哈希口径——产出的批次可直接经 receiveBatch 校验应用（幂等去重生效）。
 * logicalClock 缺省取变更流中的最大逻辑时钟
 */
export function buildFederationBatch(
  sourceNodeId: string,
  changes: ReadonlyArray<ChangeEntry>,
  options: { logicalClock?: number; timestamp?: number; batchId?: string } = {},
): SyncBatch {
  const list = [...changes];
  const logicalClock =
    options.logicalClock ?? list.reduce((m, c) => Math.max(m, typeof c.logicalClock === 'number' ? c.logicalClock : 0), 0);
  const batch: SyncBatch = {
    batchId: options.batchId ?? `fed-${sourceNodeId}-${logicalClock}-${crypto.randomBytes(3).toString('hex')}`,
    sourceNodeId,
    changes: list,
    timestamp: options.timestamp ?? Date.now(),
    logicalClock,
    batchHash: '',
  };
  const chain = list.map((c) => `${c.id}:${c.dataHash}`).join('|');
  batch.batchHash = crypto.createHash('sha256').update(`${batch.sourceNodeId}:${batch.logicalClock}:${chain}`).digest('hex');
  return batch;
}

/**
 * 联邦网关：跨集群间的选择性状态同步出口。
 *
 * - 选择性：offer 的变更按订阅前缀在出口裁剪——未订阅前缀零传输
 *   （filtered 计数 + B 端永不接触），而非「全量转发再由对端丢弃」
 * - 限流：每窗口 ratePerWindow 个令牌；超发排队（deferred）下窗口
 *   续传，不静默丢弃；队列上限防未消费洪泛
 * - 确定性：时钟可注入（虚拟时钟下逐窗口推进，同输入同输出）
 * - 批次口径：buildFederationBatch（与引擎哈希一致）→ 对端
 *   DistributedSync.receiveBatch 直接校验应用（幂等）
 */
export class FederationGateway {
  readonly gatewayId: string;
  private subs: FederationSubscription[];
  private readonly rate: number;
  private readonly windowMs: number;
  private readonly nowFn: () => number;
  private readonly maxQueue: number;
  private queue: ChangeEntry[] = [];
  private queuedIds = new Set<string>();
  private sink: ((batch: SyncBatch) => Promise<unknown> | void) | null = null;
  private lastWindow = -1;
  private tokensUsed = 0;
  private readonly stats: FederationStats;

  constructor(options: FederationGatewayOptions) {
    if (!options || !options.gatewayId) throw new Error('联邦网关需要 gatewayId');
    if (!Number.isFinite(options.ratePerWindow) || options.ratePerWindow < 1) {
      throw new Error('ratePerWindow 必须 ≥ 1');
    }
    if (!Number.isFinite(options.windowMs) || options.windowMs < 1) {
      throw new Error('windowMs 必须 ≥ 1');
    }
    this.gatewayId = options.gatewayId;
    this.subs = (options.subscriptions ?? []).filter((s) => s && typeof s.keyPrefix === 'string' && s.keyPrefix.length > 0);
    this.rate = Math.floor(options.ratePerWindow);
    this.windowMs = Math.floor(options.windowMs);
    this.nowFn = options.now ?? Date.now;
    this.maxQueue = Math.max(1, options.maxQueue ?? 1024);
    this.stats = {
      offered: 0,
      matched: 0,
      filtered: 0,
      dropped: 0,
      forwarded: 0,
      deferred: 0,
      bytesForwarded: 0,
      forwardedByPrefix: {},
      windowsElapsed: 0,
      throttledPumps: 0,
    };
  }

  /** 订阅清单（只读副本） */
  subscriptions(): FederationSubscription[] {
    return this.subs.map((s) => ({ ...s }));
  }

  /** 重设订阅（已在队列中的变更按新订阅重新裁剪） */
  setSubscriptions(subs: FederationSubscription[]): void {
    this.subs = (subs ?? []).filter((s) => s && typeof s.keyPrefix === 'string' && s.keyPrefix.length > 0);
    const kept: ChangeEntry[] = [];
    const keptIds = new Set<string>();
    for (const c of this.queue) {
      if (this.matchSubscription(c.fingerprint)) {
        kept.push(c);
        keptIds.add(c.id);
      }
    }
    this.queue = kept;
    this.queuedIds = keptIds;
  }

  /** 接线对端（联邦批次的交付目标——通常是远端集群的 receiveBatch 桥） */
  link(sink: (batch: SyncBatch) => Promise<unknown> | void): void {
    this.sink = sink;
  }

  /** 待发队列长度 */
  queueSize(): number {
    return this.queue.length;
  }

  /** 网关统计（只读快照） */
  statsView(): FederationStats {
    return { ...this.stats, deferred: this.queue.length, forwardedByPrefix: { ...this.stats.forwardedByPrefix } };
  }

  /**
   * 变更入网：命中订阅进待发队列（重复 id 幂等跳过），未订阅前缀
   * 出口裁剪（零传输），队列超限丢弃并计数
   */
  offer(changes: ReadonlyArray<ChangeEntry>): { matched: number; filtered: number; dropped: number } {
    let matched = 0;
    let filtered = 0;
    let dropped = 0;
    for (const c of changes ?? []) {
      if (!c || typeof c.fingerprint !== 'string') continue;
      this.stats.offered += 1;
      if (!this.matchSubscription(c.fingerprint)) {
        filtered += 1;
        this.stats.filtered += 1;
        continue;
      }
      matched += 1;
      this.stats.matched += 1;
      if (this.queuedIds.has(c.id)) continue; // 重复 offer 幂等
      if (this.queue.length >= this.maxQueue) {
        dropped += 1;
        this.stats.dropped += 1;
        continue;
      }
      this.queue.push(c);
      this.queuedIds.add(c.id);
    }
    return { matched, filtered, dropped };
  }

  /**
   * 推进限流窗口并转发：当前窗口剩余令牌内的队首变更打包为一个联邦
   * 批次交付对端；令牌耗尽时余量滞留（deferred——限流延迟而非丢弃）。
   * 未接线时不消费队列（转发零静默丢失）
   */
  async pump(): Promise<{ forwarded: number; deferred: number }> {
    const window = Math.floor(this.nowFn() / this.windowMs);
    if (window > this.lastWindow) {
      this.stats.windowsElapsed += window - this.lastWindow;
      this.lastWindow = window;
      this.tokensUsed = 0;
    }
    const out: ChangeEntry[] = [];
    while (this.queue.length > 0 && this.tokensUsed < this.rate) {
      const c = this.queue.shift()!;
      this.queuedIds.delete(c.id);
      out.push(c);
      this.tokensUsed += 1;
    }
    if (out.length === 0) {
      return { forwarded: 0, deferred: this.queue.length };
    }
    if (!this.sink) {
      // 未接线：变更退回队列（顺序保持），令牌回滚——不静默丢失
      this.queue = out.concat(this.queue);
      for (const c of out) this.queuedIds.add(c.id);
      this.tokensUsed -= out.length;
      return { forwarded: 0, deferred: this.queue.length };
    }
    if (this.queue.length > 0) this.stats.throttledPumps += 1;
    const batch = buildFederationBatch(out[0]!.sourceNodeId, out, { timestamp: this.nowFn() });
    this.stats.bytesForwarded += JSON.stringify(batch).length;
    for (const c of out) {
      const sub = this.matchSubscription(c.fingerprint)!;
      const key = `${sub.namespace}:${sub.keyPrefix}`;
      this.stats.forwardedByPrefix[key] = (this.stats.forwardedByPrefix[key] ?? 0) + 1;
    }
    this.stats.forwarded += out.length;
    await this.sink(batch);
    return { forwarded: out.length, deferred: this.queue.length };
  }

  /** 命中订阅（首个前缀匹配的订阅；空订阅表 = 永不命中） */
  private matchSubscription(fingerprint: string): FederationSubscription | null {
    for (const sub of this.subs) {
      if (fingerprint.startsWith(sub.keyPrefix)) return sub;
    }
    return null;
  }
}
