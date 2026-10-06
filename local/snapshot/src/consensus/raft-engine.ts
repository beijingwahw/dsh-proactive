/**
 * raft-engine.ts — 分布式共识引擎（协作层，独立模块）
 *
 * 职责：实现 Raft 共识协议，保证多实例部署时调度决策的全局一致性
 * - Leader 选举（随机化选举超时 + RequestVote RPC）
 * - 日志复制（AppendEntries RPC + 多数派 commit）
 * - 决策提案：execute-plan / reject-signal / defer-signal / reassign-model / escalate-to-user
 * - 状态机应用：已提交日志条目通过 onCommit 回调交付上层
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 完整 Raft 核心循环：选举超时随机化（防活锁）、任期单调递增、
 *   投票每任期唯一、日志一致性检查（prevLogIndex/prevLogTerm）
 * 2. 持久化状态：currentTerm / votedFor / log 落盘，重启后状态不丢失
 * 3. 快速降级：candidate/follower 收到更高任期立即让位；
 *   leader 收到 AppendEntries 来自新 leader 时自动降级
 * 4. 单节点集群优化：cluster 只有自己时提案立即提交，零网络开销
 * 5. 提交推进：leader 按 matchIndex 多数派推进 commitIndex，
 *   仅提交当前任期日志（Raft 论文 §5.4.2 安全性约束）
 * 6. HTTP 传输层：内置 consensus 端口服务 RequestVote / AppendEntries / Propose，
 *   支持 priority 加权（高优先级节点选举超时更短，倾向成为 leader）
 *
 * 第三轮·世界性升级（模块域 A12）：
 * 7. 可注入底座（零漂移）：传输层 / 定时器 / RNG / 时钟 / 持久化五个
 *   关注点全部可注入——缺省逐位等于原实现（HTTP RPC + node 定时器 +
 *   Math.random + Date.now + 落盘），注入后同一份 Raft 核心代码可在
 *   离线确定性环境中被穷尽考验
 * 8. 日志压缩与快照：已提交段折叠为 O(1) 快照（含最后应用索引与状态
 *   摘要），InstallSnapshot RPC 让滞后/新节点「快照 + 增量」两段追平；
 *   findByIndex 退化为 O(1) 基址寻址
 * 9. 种子化故障注入仿真台：RaftVirtualClock（离散事件虚拟时钟）+
 *   RaftSimNetwork（延迟/丢失/分区注入）+ RaftFaultSimulator（500 轮
 *   混合故障风暴，逐轮断言四条安全不变量：日志单调、已提交不回滚、
 *   任期内最多一领导、全局日志匹配），同种子逐位复现
 *
 * 第四轮·世界性升级（模块域 A12，全新维度，全部 opt-in、缺省零漂移）：
 * 10. 拜占庭节点检测与隔离：领导者周期审计探测（ProbeLog RPC 对声称进度
 *   matchIndex 做日志指纹核对）——声称确认但日志不含 / 内容不符 / 同索引
 *   前后两说三类证据计数，超阈 trusted→suspect→quarantine；隔离节点从
 *   法定人数计算中排除（共识在剩余诚实多数上继续安全推进），可申诉：
 *   观察期连续一致探测恢复投票权，再犯即回隔离
 * 11. 网络分区愈合报告：少数侧被多数侧领导者截断重同步时，被弃的未提交
 *   段显式入账（索引/任期/signalId/命令类型 + 状态机摘要差异）——
 *   「少数侧数据被显式报告而非静默丢弃」
 * 12. 单步成员变更（联合共识）：一次恰增删一个节点；变更条目在「过半旧
 *   配置 ∧ 过半新配置」双法定人数下提交——两个配置的多数派必相交，
 *   变更期间不可能选出两个各自合法的领导者（防双主）
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { raftSafetyAudit } from '../core/quorum-systems.js';
import http from 'node:http';
import path from 'node:path';
import { NetworkError } from '../errors.js';
import type { Decision } from '../decision-engine.js';

/** 节点角色 */
export type NodeRole = 'leader' | 'follower' | 'candidate';

/**
 * 单步成员变更（第四轮）：一次恰增删一个节点。
 * 变更条目作为普通日志条目复制，在「过半旧配置 ∧ 过半新配置」双法定
 * 人数下提交后才定局（联合共识，Raft 论文 §6 的单步特例——两个配置的
 * 多数派必相交，防双主）
 */
export interface RaftMembershipChange {
  type: 'add-node' | 'remove-node';
  node: ClusterNodeConfig;
}

/** 共识日志条目（决策命令；membership 缺席 = 普通决策条目——持久化格式向后兼容） */
export interface ConsensusLogEntry {
  index: number;
  term: number;
  command: {
    type: 'execute-plan' | 'reject-signal' | 'defer-signal' | 'reassign-model' | 'escalate-to-user';
    signalId: string;
    signalDescription: string;
    decision: Decision | null;
    proposedBy: string;
  };
  timestamp: number;
  /** 成员变更载荷（第四轮；仅经 changeMembership 入账） */
  membership?: RaftMembershipChange;
}

/** 集群状态摘要（运维可观测） */
export interface ClusterStatus {
  localNodeId: string;
  role: NodeRole;
  term: number;
  leaderId: string | null;
  commitIndex: number;
  lastLogIndex: number;
  logLength: number;
  peers: Array<{ nodeId: string; address: string; matchIndex: number; nextIndex: number }>;
  pendingProposals: number;
}

// ─────────────────────────── 可注入底座（零漂移缺省） ───────────────────────────

/** 定时器句柄（注入调度器可返回任意形状） */
export type RaftTimerHandle = unknown;

/**
 * 可注入传输层：sendRpc 语义与 HTTP RPC 完全一致。
 * 缺省实现走 node:http；仿真网络注入后同一份引擎代码离线可跑
 */
export interface RaftTransport {
  sendRpc<T>(peer: ClusterNodeConfig, rpc: string, args: Record<string, unknown>): Promise<T>;
}

/** 可注入定时器调度器（缺省 = node 定时器，自动 unref 不阻进程退出） */
export interface RaftScheduler {
  setTimeout(fn: () => void, ms: number): RaftTimerHandle;
  clearTimeout(handle: RaftTimerHandle): void;
  setInterval(fn: () => void, ms: number): RaftTimerHandle;
  clearInterval(handle: RaftTimerHandle): void;
}

/** 缺省调度器：node 定时器（unref 内建——引擎代码不再各自 unref） */
const defaultRaftScheduler: RaftScheduler = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

// ─────────────────────────── 快照与状态摘要 ───────────────────────────

/**
 * 状态机摘要：已应用日志的 O(1) 折叠（压缩段的「状态」由它承载）。
 * foldRaftState 是纯函数——快照摘要 = 全量重放摘要（逐位）的代数根源
 */
export interface RaftStateDigest {
  /** 已折叠条目数 */
  entriesApplied: number;
  /** 按命令类型计数 */
  commandCounts: Record<string, number>;
  /** 末条已应用条目的 signalId */
  lastSignalId: string | null;
  /** 折叠覆盖到的日志索引 */
  throughIndex: number;
}

/**
 * 日志快照：已提交段 [1, lastIncludedIndex] 的压缩表示。
 * lastApplied 随快照固化——新节点装快照即获得等价于重放全量日志的状态机
 */
export interface RaftSnapshot {
  lastIncludedIndex: number;
  lastIncludedTerm: number;
  lastApplied: number;
  digest: RaftStateDigest;
}

/**
 * 折叠日志条目为状态摘要（纯函数，可叠加 base 增量折叠）。
 * 快照摘要与全量重放摘要的逐位相等由此函数直接保证
 */
export function foldRaftState(entries: ReadonlyArray<ConsensusLogEntry>, base?: RaftStateDigest): RaftStateDigest {
  const digest: RaftStateDigest = base
    ? {
        entriesApplied: base.entriesApplied,
        commandCounts: { ...base.commandCounts },
        lastSignalId: base.lastSignalId,
        throughIndex: base.throughIndex,
      }
    : { entriesApplied: 0, commandCounts: {}, lastSignalId: null, throughIndex: 0 };
  for (const e of entries) {
    digest.entriesApplied += 1;
    digest.commandCounts[e.command.type] = (digest.commandCounts[e.command.type] ?? 0) + 1;
    digest.lastSignalId = e.command.signalId;
    digest.throughIndex = e.index;
  }
  return digest;
}

// ─────────────────────────── 拜占庭守卫 / 愈合报告（第四轮，opt-in） ───────────────────────────

/** 拜占庭证据种类（领导者审计探测的三类观测） */
export type RaftByzantineEvidenceKind = 'ack-missing' | 'ack-mismatch' | 'equivocation';

/** 节点诚信状态机：trusted → suspect → quarantined ⇄ probation（申诉）→ trusted */
export type RaftByzantineNodeStatus = 'trusted' | 'suspect' | 'quarantined' | 'probation';

/** 单节点守卫观测（领导者视角的审计档案） */
export interface RaftByzantineNodeState {
  nodeId: string;
  status: RaftByzantineNodeStatus;
  /** 累计证据数（单调递增；恢复 trusted 时清零） */
  evidence: number;
  /** 已观测到的证据种类（ack-missing = 声称确认但日志不含 / ack-mismatch = 内容不符 / equivocation = 同索引前后两说） */
  evidenceKinds: RaftByzantineEvidenceKind[];
  /** 申诉观察期已连续一致的探测次数 */
  probationCredits: number;
  lastProbeIndex: number;
  lastFingerprint: string | null;
  /** 进入隔离态的时刻（虚拟/墙钟口径由注入时钟决定；未隔离为 null） */
  quarantinedAt: number | null;
}

/** 拜占庭守卫配置（RaftConfig.byzantineGuard 缺席 = 守卫关闭，零漂移） */
export interface RaftByzantineGuardOptions {
  /** 每多少轮心跳做一轮审计探测（默认 2） */
  probeEveryNHeartbeats?: number;
  /** 证据阈值：达到即标记 suspect（默认 2） */
  suspicionThreshold?: number;
  /** 证据阈值：达到即升级 quarantine 并从法定人数排除（默认 3） */
  quarantineThreshold?: number;
  /** 申诉观察期连续一致探测次数：达到即恢复 trusted（默认 2） */
  appealCredits?: number;
}

/** 分区愈合报告：少数侧被截断的未提交段显式入账（不静默丢弃） */
export interface RaftHealingReport {
  /** 记录时刻（注入时钟口径） */
  at: number;
  /** 发生截断的本节点 */
  nodeId: string;
  reason: 'append-conflict';
  /** 合并后保留到的索引（截断点 − 1） */
  keptThrough: number;
  /** 多数侧领导者带来的替代段末索引 */
  replacedThrough: number;
  /** 对端（多数侧领导者）标识 */
  leaderId: string;
  /** 被截断的未提交条目（index/term/signalId/命令类型） */
  discarded: Array<{ index: number; term: number; signalId: string; commandType: string }>;
  /** 被截断段的状态机摘要——少数侧与多数侧的显式差异报告 */
  discardedDigest: RaftStateDigest;
}

/** 愈合报告配置（RaftConfig.healingReport 缺席 = 不记录，零漂移） */
export interface RaftHealingReportOptions {
  /** 报告环上限（默认 32） */
  maxRecords?: number;
}



/** RequestVote 请求参数（Raft §5.2） */
interface RequestVoteArgs {
  term: number;
  candidateId: string;
  lastLogIndex: number;
  lastLogTerm: number;
}

/** RequestVote 响应 */
interface RequestVoteReply {
  ok?: boolean;
  term: number;
  voteGranted: boolean;
}

/** AppendEntries 请求参数（Raft §5.3） */
interface AppendEntriesArgs {
  term: number;
  leaderId: string;
  prevLogIndex: number;
  prevLogTerm: number;
  entries: ConsensusLogEntry[];
  leaderCommit: number;
}

/** AppendEntries 响应 */
interface AppendEntriesReply {
  ok?: boolean;
  term: number;
  success: boolean;
  /** 一致性冲突提示：follower 日志中从该 index 起必然失配（加速 nextIndex 回退） */
  conflictIndex?: number;
}

/** InstallSnapshot 请求参数（Raft §7 快照安装） */
interface InstallSnapshotArgs {
  term: number;
  leaderId: string;
  snapshot: RaftSnapshot;
}

/** InstallSnapshot 响应 */
interface InstallSnapshotReply {
  ok?: boolean;
  term: number;
  success: boolean;
  /** 安装后 follower 的快照边界（leader 据此对齐 nextIndex/matchIndex） */
  lastIndex: number;
}

/** ProbeLog 请求参数（第四轮：守卫审计探测——只读） */
interface ProbeLogArgs {
  term: number;
  leaderId: string;
  askerId: string;
  index: number;
}

/** ProbeLog 响应（fingerprint = 该索引日志条目的命令指纹；快照覆盖段为边界标记；无条目为 null） */
interface ProbeLogReply {
  ok?: boolean;
  term: number;
  fingerprint: string | null;
}

/** 集群节点配置 */
export interface ClusterNodeConfig {
  nodeId: string;
  address: string;
  port: number;
  /** 选举优先级（越大越倾向成为 leader），默认 1 */
  priority?: number;
}

/** Raft 引擎配置 */
export interface RaftConfig {
  localNodeId: string;
  cluster: ClusterNodeConfig[];
  /** 选举超时下限（毫秒） */
  electionTimeoutMin: number;
  /** 选举超时上限（毫秒） */
  electionTimeoutMax: number;
  /** leader 心跳间隔（毫秒） */
  heartbeatInterval: number;
  /** 共识 RPC 监听端口 */
  consensusPort: number;
  /** 持久化状态路径（persist=false 时不触碰文件系统） */
  logPath: string;
  // ── 可注入底座（全部可选，缺省零漂移）──
  /** 选举超时随机源；缺省 Math.random */
  rng?: () => number;
  /** RPC 传输层；缺省 HTTP。注入后不启动 RPC 服务（端口零占用） */
  transport?: RaftTransport;
  /** 定时器调度器；缺省 node 定时器 */
  scheduler?: RaftScheduler;
  /** 时钟（日志条目 timestamp）；缺省 Date.now */
  now?: () => number;
  /** 是否持久化状态；缺省 true（仿真关闭后安全不变量与持久化正交） */
  persist?: boolean;
  // ── 第四轮（全部 opt-in，缺省零漂移） ──
  /** 拜占庭守卫：领导者周期审计探测 → 证据计数 → suspect → quarantine（法定人数排除）→ 申诉恢复 */
  byzantineGuard?: RaftByzantineGuardOptions;
  /** 分区愈合报告：少数侧被截断的未提交段显式入账（缺省不记录） */
  healingReport?: RaftHealingReportOptions;
}

/** 持久化状态 */
interface RaftPersistentState {
  currentTerm: number;
  votedFor: string | null;
  log: ConsensusLogEntry[];
  /** 日志快照（压缩段；无压缩时缺席） */
  snapshot?: RaftSnapshot;
}

/** 提案结果 */
interface ProposeResult {
  committed: boolean;
  decision: Decision | null;
}

/**
 * 分布式共识引擎（Raft）
 *
 * 被 index.ts 的 manage_consensus Tool 调用（status / propose）。
 * 集群模式下，战略决策需经多数派提交后方可执行。
 */
export class RaftEngine {
  private config: RaftConfig;
  private role: NodeRole = 'follower';
  private currentTerm = 0;
  private votedFor: string | null = null;
  private log: ConsensusLogEntry[] = [];
  /** 日志快照（压缩段；log 只保留 lastIncludedIndex 之后的后缀） */
  private snapshot: RaftSnapshot | null = null;
  private commitIndex = 0;
  private lastApplied = 0;
  private leaderId: string | null = null;

  /** leader 专用：各 peer 已知复制的最高日志索引 */
  private matchIndex = new Map<string, number>();
  /** leader 专用：下一条要发送的日志索引 */
  private nextIndex = new Map<string, number>();

  private electionTimer: RaftTimerHandle = null;
  private heartbeatTimer: RaftTimerHandle = null;
  private server: http.Server | null = null;
  private commitCallbacks: Array<(entry: ConsensusLogEntry) => void> = [];
  private roleChangeCallbacks: Array<(role: NodeRole, term: number) => void> = [];
  /** 提案等待队列：logIndex → { term, resolver }（term 防跨任期错配兑现） */
  private pendingProposals = new Map<number, { term: number; resolve: (result: ProposeResult) => void }>();
  private running = false;

  // ── 注入底座（构造期固定）──
  private rng: () => number;
  private transport: RaftTransport | undefined;
  private scheduler: RaftScheduler;
  private now: () => number;
  private persistEnabled: boolean;

  // ── 第四轮（缺省全部惰性——零漂移） ──
  /** 拜占庭守卫（byzantineGuard 缺席 = null：无探测、无隔离、法定人数口径不变） */
  private guard: {
    opts: { probeEveryNHeartbeats: number; suspicionThreshold: number; quarantineThreshold: number; appealCredits: number };
    nodes: Map<string, RaftByzantineNodeState>;
    heartbeatCount: number;
  } | null = null;
  /** 愈合报告环（healingReport 缺席 = null：截断不记账） */
  private healing: { max: number; records: RaftHealingReport[] } | null = null;
  /** 进行中的单步成员变更（联合共识双法定人数；条目提交即定局） */
  private pendingMembership: {
    entryIndex: number;
    old: ClusterNodeConfig[];
    new: ClusterNodeConfig[];
    change: RaftMembershipChange;
  } | null = null;

  constructor(config: RaftConfig) {
    this.config = config;
    this.rng = config.rng ?? Math.random;
    this.transport = config.transport;
    this.scheduler = config.scheduler ?? defaultRaftScheduler;
    this.now = config.now ?? Date.now;
    this.persistEnabled = config.persist !== false;
    this.guard = config.byzantineGuard
      ? {
          opts: {
            probeEveryNHeartbeats: Math.max(1, Math.floor(config.byzantineGuard.probeEveryNHeartbeats ?? 2)),
            suspicionThreshold: Math.max(1, Math.floor(config.byzantineGuard.suspicionThreshold ?? 2)),
            quarantineThreshold: Math.max(2, Math.floor(config.byzantineGuard.quarantineThreshold ?? 3)),
            appealCredits: Math.max(1, Math.floor(config.byzantineGuard.appealCredits ?? 2)),
          },
          nodes: new Map(),
          heartbeatCount: 0,
        }
      : null;
    this.healing = config.healingReport ? { max: Math.max(1, config.healingReport.maxRecords ?? 32), records: [] } : null;
    this.loadPersistentState();
  }

  /**
   * 启动引擎：监听共识端口 + 启动选举定时器
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.transport) this.startRpcServer();
    this.resetElectionTimer();
    // 单节点集群直接成为 leader
    if (this.peers().length === 0) {
      this.becomeLeader();
    }
  }

  /**
   * 停止引擎：关闭服务与全部定时器
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.scheduler.clearTimeout(this.electionTimer);
    this.scheduler.clearInterval(this.heartbeatTimer);
    this.electionTimer = null;
    this.heartbeatTimer = null;
    this.server?.close();
    this.server = null;
    // 拒绝所有等待中的提案
    for (const p of this.pendingProposals.values()) {
      p.resolve({ committed: false, decision: null });
    }
    this.pendingProposals.clear();
    this.persistState();
  }

  /**
   * 提交决策提案
   *
   * - leader：追加本地日志并复制，多数派确认后 resolve
   * - 非 leader：转发给当前 leader；无 leader 时提案失败
   * - 单节点：立即提交
   *
   * @param command 决策命令
   * @param timeoutMs 等待提交的超时（默认 10s）
   */
  async propose(command: ConsensusLogEntry['command'], timeoutMs = 10_000): Promise<ProposeResult> {
    if (!this.running) {
      return { committed: false, decision: null };
    }

    // 非 leader 转发
    if (this.role !== 'leader') {
      if (this.leaderId) {
        return this.forwardPropose(this.leaderId, command, timeoutMs);
      }
      return { committed: false, decision: null };
    }

    // leader 追加日志
    const entry: ConsensusLogEntry = {
      index: this.lastLogIndex() + 1,
      term: this.currentTerm,
      command,
      timestamp: this.now(),
    };
    this.log.push(entry);
    this.persistState();

    // 单节点立即提交
    if (this.peers().length === 0) {
      this.commitIndex = entry.index;
      this.applyCommitted();
      return { committed: true, decision: command.decision };
    }

    // 等待多数派确认
    return new Promise<ProposeResult>((resolve) => {
      const timer = this.scheduler.setTimeout(() => {
        this.pendingProposals.delete(entry.index);
        resolve({ committed: false, decision: null });
      }, timeoutMs);
      this.pendingProposals.set(entry.index, {
        term: this.currentTerm,
        resolve: (result) => {
          this.scheduler.clearTimeout(timer);
          resolve(result);
        },
      });
      // 立即触发一轮心跳加速复制
      this.broadcastHeartbeat();
    });
  }

  /** 当前 leader id（未知返回 null） */
  getLeaderId(): string | null {
    return this.leaderId;
  }

  /** 当前角色 */
  getRole(): NodeRole {
    return this.role;
  }

  /** 当前任期 */
  getTerm(): number {
    return this.currentTerm;
  }

  /**
   * 集群状态摘要（供 manage_consensus status 使用）
   */
  getClusterStatus(): ClusterStatus {
    return {
      localNodeId: this.config.localNodeId,
      role: this.role,
      term: this.currentTerm,
      leaderId: this.leaderId,
      commitIndex: this.commitIndex,
      lastLogIndex: this.lastLogIndex(),
      logLength: this.log.length,
      peers: this.peers().map((p) => ({
        nodeId: p.nodeId,
        address: `${p.address}:${p.port}`,
        matchIndex: this.matchIndex.get(p.nodeId) ?? 0,
        nextIndex: this.nextIndex.get(p.nodeId) ?? 0,
      })),
      pendingProposals: this.pendingProposals.size,
    };
  }

  /** 注册已提交条目回调（状态机应用） */
  onCommit(callback: (entry: ConsensusLogEntry) => void): void {
    this.commitCallbacks.push(callback);
  }

  /** 注册角色变更回调 */
  onRoleChange(callback: (role: NodeRole, term: number) => void): void {
    this.roleChangeCallbacks.push(callback);
  }

  // ─────────────────────────── 快照与压缩（第三轮） ───────────────────────────

  /** 快照边界（无快照 = 0；日志数组只保存边界之后的后缀） */
  snapshotLastIndex(): number {
    return this.snapshot?.lastIncludedIndex ?? 0;
  }

  /** 当前快照（只读副本；无压缩返回 null） */
  snapshotInfo(): RaftSnapshot | null {
    return this.snapshot
      ? {
          ...this.snapshot,
          digest: { ...this.snapshot.digest, commandCounts: { ...this.snapshot.digest.commandCounts } },
        }
      : null;
  }

  /** 保留日志后缀的只读副本（审计/仿真不变量检查用） */
  inspectLog(): ConsensusLogEntry[] {
    return this.log.map((e) => ({ ...e }));
  }

  /**
   * 状态机摘要：快照摘要 + 未压缩提交段的增量折叠。
   * 与「全量重放日志到 commitIndex」逐位相等（foldRaftState 纯函数保证）
   */
  stateMachineDigest(): RaftStateDigest {
    const base = this.snapshotLastIndex();
    const committedSuffix = Math.max(0, this.commitIndex - base);
    return foldRaftState(this.log.slice(0, committedSuffix), this.snapshot?.digest);
  }

  /**
   * 压缩日志：将 [边界+1, throughIndex] 已提交段折叠进快照。
   *
   * - 只压缩已提交段（commitIndex 之内）——未提交条目必须留在日志参与一致性仲裁
   * - 压缩后 log 仅存后缀：findByIndex 退化为 O(1) 基址寻址，
   *   持久化文件体积从 O(全量) 降到 O(未压缩段)
   * - 滞后 peer 的追平通道自动切换：prevLogIndex < 边界时 leader 改发 InstallSnapshot
   */
  compactLog(throughIndex = this.commitIndex): RaftSnapshot | null {
    const base = this.snapshotLastIndex();
    const idx = Math.min(throughIndex, this.commitIndex);
    if (idx <= base) return this.snapshotInfo();
    const segment = this.log.slice(0, idx - base);
    const digest = foldRaftState(segment, this.snapshot?.digest);
    const lastEntry = segment[segment.length - 1]!;
    this.log = this.log.slice(idx - base);
    this.snapshot = {
      lastIncludedIndex: idx,
      lastIncludedTerm: lastEntry.term,
      // 压缩段按已提交且已应用处理（applyCommitted 与提交同步推进）
      lastApplied: Math.max(this.snapshot?.lastApplied ?? 0, this.lastApplied, idx),
      digest,
    };
    this.lastApplied = Math.max(this.lastApplied, idx);
    this.commitIndex = Math.max(this.commitIndex, idx);
    this.persistState();
    return this.snapshotInfo();
  }

  /**
   * 安装快照（新节点/滞后节点两段追平的第一段）。
   * 保留本地快照边界之后的后缀；边界及之前的已提交段由快照摘要承载。
   * 陈旧快照（边界不高于本端）幂等拒绝
   */
  installSnapshot(snapshot: RaftSnapshot): boolean {
    if (
      !snapshot ||
      typeof snapshot.lastIncludedIndex !== 'number' ||
      snapshot.lastIncludedIndex < 0 ||
      !snapshot.digest
    ) {
      return false;
    }
    const base = this.snapshotLastIndex();
    if (snapshot.lastIncludedIndex < base) return false; // 陈旧快照
    if (snapshot.lastIncludedIndex === base) return true; // 已覆盖
    this.log = this.log.filter((e) => e.index > snapshot.lastIncludedIndex);
    this.snapshot = {
      lastIncludedIndex: snapshot.lastIncludedIndex,
      lastIncludedTerm: snapshot.lastIncludedTerm,
      lastApplied: snapshot.lastApplied,
      digest: { ...snapshot.digest, commandCounts: { ...snapshot.digest.commandCounts } },
    };
    this.commitIndex = Math.max(this.commitIndex, snapshot.lastIncludedIndex);
    this.lastApplied = Math.max(this.lastApplied, snapshot.lastIncludedIndex);
    this.persistState();
    return true;
  }

  // ─────────────────────────── 第四轮：拜占庭守卫 / 愈合报告 / 成员变更 ───────────────────────────

  /** 本端守卫观测报告（守卫关闭返回 null——零漂移） */
  byzantineReport(): Record<string, RaftByzantineNodeState> | null {
    if (!this.guard) return null;
    const out: Record<string, RaftByzantineNodeState> = {};
    for (const [id, st] of this.guard.nodes) {
      out[id] = { ...st, evidenceKinds: [...st.evidenceKinds] };
    }
    return out;
  }

  /**
   * 隔离节点申诉：进入观察期（probation）——仍排除在法定人数外，
   * 连续 appealCredits 次一致探测后恢复 trusted（重新计入法定人数），
   * 观察期内再犯即回隔离。仅守卫开启且节点处于 quarantined 时受理
   */
  requestAppeal(nodeId: string): boolean {
    if (!this.guard) return false;
    const st = this.guard.nodes.get(nodeId);
    if (!st || st.status !== 'quarantined') return false;
    st.status = 'probation';
    st.probationCredits = 0;
    return true;
  }

  /** 愈合报告（只读副本；未启用返回 null——零漂移） */
  healingReports(): RaftHealingReport[] | null {
    if (!this.healing) return null;
    return this.healing.records.map((r) => ({
      ...r,
      discarded: r.discarded.map((d) => ({ ...d })),
      discardedDigest: { ...r.discardedDigest, commandCounts: { ...r.discardedDigest.commandCounts } },
    }));
  }

  /** 成员视图（配置节点 + 进行中的联合变更；纯只读观测，任意时刻可用） */
  membershipStatus(): { nodes: string[]; pending: { change: RaftMembershipChange; entryIndex: number } | null } {
    return {
      nodes: this.config.cluster.map((n) => n.nodeId),
      pending: this.pendingMembership
        ? { change: this.pendingMembership.change, entryIndex: this.pendingMembership.entryIndex }
        : null,
    };
  }

  /** 集群扩容（单步：一次恰加一个节点） */
  async addMember(node: ClusterNodeConfig, timeoutMs = 8000): Promise<{ committed: boolean; entryIndex: number; error?: string }> {
    return this.changeMembership({ type: 'add-node', node }, timeoutMs);
  }

  /** 集群缩容（单步：一次恰移一个节点；不支持移除自己——先转移领导权） */
  async removeMember(nodeId: string, timeoutMs = 8000): Promise<{ committed: boolean; entryIndex: number; error?: string }> {
    const node = this.config.cluster.find((n) => n.nodeId === nodeId);
    if (!node) return { committed: false, entryIndex: 0, error: `节点 ${nodeId} 不在配置中` };
    return this.changeMembership({ type: 'remove-node', node }, timeoutMs);
  }

  /**
   * 单步成员变更（联合共识）：
   * - 变更条目作为普通日志条目复制，在「过半旧配置 ∧ 过半新配置」双法定
   *   人数下提交后才定局——两个配置的多数派必相交，变更期间不可能选出
   *   两个各自合法的领导者（防双主）
   * - 联合视图自条目入账起生效（leader 在发起时、follower 在收到条目时），
   *   提交（应用）时定局为新配置；领导权丢失时未提交的变更作废（条目
   *   可被新领导者按日志一致性规则截断，视图随下一次复制重新采纳）
   * - 仅 leader 可发起；已有进行中变更时拒绝（单步串行）
   */
  async changeMembership(
    change: RaftMembershipChange,
    timeoutMs = 8000,
  ): Promise<{ committed: boolean; entryIndex: number; error?: string }> {
    if (!this.running) return { committed: false, entryIndex: 0, error: '引擎未启动' };
    if (this.role !== 'leader') return { committed: false, entryIndex: 0, error: '非 leader 不可发起成员变更' };
    if (this.pendingMembership) return { committed: false, entryIndex: 0, error: '单步协议：已有进行中的成员变更' };
    if (!change || !change.node || !change.node.nodeId) return { committed: false, entryIndex: 0, error: '非法成员变更载荷' };
    const oldCfg = this.config.cluster;
    const exists = oldCfg.some((n) => n.nodeId === change.node.nodeId);
    if (change.type === 'add-node' && exists) {
      return { committed: false, entryIndex: 0, error: `节点 ${change.node.nodeId} 已在配置中` };
    }
    if (change.type === 'remove-node' && !exists) {
      return { committed: false, entryIndex: 0, error: `节点 ${change.node.nodeId} 不在配置中` };
    }
    const newCfg =
      change.type === 'add-node' ? [...oldCfg, change.node] : oldCfg.filter((n) => n.nodeId !== change.node.nodeId);
    if (!newCfg.some((n) => n.nodeId === this.config.localNodeId)) {
      return { committed: false, entryIndex: 0, error: '不支持自我移除（先转移领导权）' };
    }
    const entry: ConsensusLogEntry = {
      index: this.lastLogIndex() + 1,
      term: this.currentTerm,
      command: {
        type: 'execute-plan',
        signalId: `membership:${change.type}:${change.node.nodeId}`,
        signalDescription: `成员变更 ${change.type} ${change.node.nodeId}`,
        decision: null,
        proposedBy: this.config.localNodeId,
      },
      timestamp: this.now(),
      membership: change,
    };
    this.log.push(entry);
    // 联合视图即刻生效（leader 侧）：本条目及其后的提交均需双法定人数
    this.pendingMembership = {
      entryIndex: entry.index,
      old: oldCfg.map((n) => ({ ...n })),
      new: newCfg.map((n) => ({ ...n })),
      change,
    };
    this.persistState();
    if (this.replicationTargets().length === 0) {
      // 单节点集群：立即提交并定局
      this.commitIndex = entry.index;
      this.applyCommitted();
      return { committed: true, entryIndex: entry.index };
    }
    // 双法定人数复制 + 等待提交（与 propose 同一兑现机制，任期防错配）
    return new Promise((resolve) => {
      const timer = this.scheduler.setTimeout(() => {
        this.pendingProposals.delete(entry.index);
        resolve({ committed: false, entryIndex: entry.index, error: '成员变更提交超时（未获双法定人数）' });
      }, timeoutMs);
      this.pendingProposals.set(entry.index, {
        term: this.currentTerm,
        resolve: (result) => {
          this.scheduler.clearTimeout(timer);
          resolve(
            result.committed
              ? { committed: true, entryIndex: entry.index }
              : { committed: false, entryIndex: entry.index, error: '变更条目未获双法定人数提交' },
          );
        },
      });
      this.broadcastHeartbeat();
    });
  }

  // ── 第四轮内部实现 ──

  /** 守卫档案（惰性建档） */
  private guardState(nodeId: string): RaftByzantineNodeState {
    let st = this.guard!.nodes.get(nodeId);
    if (!st) {
      st = {
        nodeId,
        status: 'trusted',
        evidence: 0,
        evidenceKinds: [],
        probationCredits: 0,
        lastProbeIndex: 0,
        lastFingerprint: null,
        quarantinedAt: null,
      };
      this.guard!.nodes.set(nodeId, st);
    }
    return st;
  }

  /**
   * 领导者审计探测：对 peer 的声称进度（matchIndex）做日志指纹核对。
   * 三类证据：ack-missing（声称确认但日志不含）/ ack-mismatch（内容不符）/
   * equivocation（同一索引前后两说——说谎者难以自洽）
   */
  private async probePeer(peer: ClusterNodeConfig): Promise<void> {
    if (!this.guard || this.role !== 'leader') return;
    const index = this.matchIndex.get(peer.nodeId) ?? 0;
    if (index <= 0) return;
    const expected = this.probeFingerprint(index);
    if (expected === null) return;
    const reply = await this.sendRpc<ProbeLogReply>(peer, 'ProbeLog', {
      term: this.currentTerm,
      leaderId: this.config.localNodeId,
      askerId: this.config.localNodeId,
      index,
    });
    if (reply.term > this.currentTerm) {
      this.stepDown(reply.term);
      return;
    }
    if (this.role !== 'leader') return;
    const st = this.guardState(peer.nodeId);
    const got = typeof reply.fingerprint === 'string' ? reply.fingerprint : null;

    // E3 口径不一致：同一索引前后两次探测给出不同指纹
    if (st.lastProbeIndex === index && st.lastFingerprint !== null && got !== null && got !== st.lastFingerprint) {
      this.addEvidence(st, 'equivocation');
    }
    if (got === null) {
      this.addEvidence(st, 'ack-missing'); // E2 声称确认但日志不含
    } else if (got !== expected) {
      this.addEvidence(st, 'ack-mismatch'); // E1 声称确认但内容不符
    } else if (st.status === 'probation') {
      // 申诉观察期：连续一致探测恢复投票权
      st.probationCredits += 1;
      if (st.probationCredits >= this.guard.opts.appealCredits) {
        st.status = 'trusted';
        st.evidence = 0;
        st.probationCredits = 0;
        st.evidenceKinds = [];
        st.quarantinedAt = null;
      }
    }
    st.lastProbeIndex = index;
    st.lastFingerprint = got;
  }

  /** 证据入账与状态机迁移（probation 再犯即回隔离） */
  private addEvidence(st: RaftByzantineNodeState, kind: RaftByzantineEvidenceKind): void {
    st.evidence += 1;
    if (!st.evidenceKinds.includes(kind)) st.evidenceKinds.push(kind);
    if (st.status === 'probation') {
      st.status = 'quarantined';
      st.probationCredits = 0;
      st.quarantinedAt = this.now();
      return;
    }
    if (st.status === 'trusted' && st.evidence >= this.guard!.opts.suspicionThreshold) st.status = 'suspect';
    if ((st.status === 'suspect' || st.status === 'trusted') && st.evidence >= this.guard!.opts.quarantineThreshold) {
      st.status = 'quarantined';
      st.quarantinedAt = this.now();
    }
  }

  /** 探针指纹：日志条目命令哈希；快照覆盖段以边界标记；无内容为 null */
  private probeFingerprint(index: number): string | null {
    if (!Number.isFinite(index) || index <= 0) return null;
    const entry = this.findByIndex(index);
    if (entry) return commandHash(entry);
    const base = this.snapshotLastIndex();
    if (this.snapshot && index <= base) {
      return `snap:${this.snapshot.lastIncludedIndex}:${this.snapshot.lastIncludedTerm}`;
    }
    return null;
  }

  /** 处理 ProbeLog（只读探测，不改变任何共识状态） */
  private handleProbeLog(args: ProbeLogArgs): ProbeLogReply {
    if (args.term > this.currentTerm) this.stepDown(args.term);
    if (args.term < this.currentTerm) return { term: this.currentTerm, fingerprint: null };
    return { term: this.currentTerm, fingerprint: this.probeFingerprint(args.index) };
  }

  /** 愈合报告：被截断的未提交段显式入账（含状态机摘要差异）——不静默丢弃 */
  private recordHealing(cutIndex: number, leaderId: string, replacedThrough: number): void {
    if (!this.healing) return;
    const discarded = this.log.filter((e) => e.index >= cutIndex);
    if (discarded.length === 0) return;
    this.healing.records.push({
      at: this.now(),
      nodeId: this.config.localNodeId,
      reason: 'append-conflict',
      keptThrough: cutIndex - 1,
      replacedThrough,
      leaderId,
      discarded: discarded.map((e) => ({
        index: e.index,
        term: e.term,
        signalId: e.command.signalId,
        commandType: e.command.type,
      })),
      discardedDigest: foldRaftState(discarded),
    });
    if (this.healing.records.length > this.healing.max) {
      this.healing.records = this.healing.records.slice(-this.healing.max);
    }
  }

  /** 成员变更应用（幂等：add 去重 / remove 过滤）——配置定局 */
  private applyMembershipConfig(change: RaftMembershipChange): void {
    if (change.type === 'add-node') {
      if (!this.config.cluster.some((n) => n.nodeId === change.node.nodeId)) {
        this.config.cluster = [...this.config.cluster, change.node];
      }
      return;
    }
    this.config.cluster = this.config.cluster.filter((n) => n.nodeId !== change.node.nodeId);
  }

  /** 成员变更预演（返回新配置；无实际变化返回 null） */
  private membershipPreview(change: RaftMembershipChange): ClusterNodeConfig[] | null {
    const exists = this.config.cluster.some((n) => n.nodeId === change.node.nodeId);
    if (change.type === 'add-node') return exists ? null : [...this.config.cluster, change.node];
    return exists ? this.config.cluster.filter((n) => n.nodeId !== change.node.nodeId) : null;
  }

  // ─────────────────────────── RPC 统一分发（HTTP / 仿真共用一条路径） ───────────────────────────

  /**
   * RPC 统一分发：HTTP 服务与仿真网络共用——两条通道走的是同一份协议代码。
   * 也是仿真台在引擎上打的唯一「孔」
   */
  dispatchRpc(rpc: string, args: unknown): Promise<Record<string, unknown>> {
    // 未启动引擎不分发 RPC——与 HTTP 侧「服务未监听 → 连接拒绝」同语义
    // （仿真网络中晚启动节点在 start() 前不可见）
    if (!this.running) {
      return Promise.resolve({ ok: false, error: `节点 ${this.config.localNodeId} 未启动` });
    }
    return Promise.resolve()
      .then(() => {
        switch (rpc) {
          case 'RequestVote':
            return { ok: true, ...this.handleRequestVote(args as RequestVoteArgs) } as Record<string, unknown>;
          case 'AppendEntries':
            return { ok: true, ...this.handleAppendEntries(args as AppendEntriesArgs) } as Record<string, unknown>;
          case 'InstallSnapshot':
            return { ok: true, ...this.handleInstallSnapshot(args as InstallSnapshotArgs) } as Record<string, unknown>;
          case 'ProbeLog':
            // 第四轮：守卫审计探测（只读——任意时刻可调用，缺省无副作用）
            return { ok: true, ...this.handleProbeLog(args as ProbeLogArgs) } as Record<string, unknown>;
          case 'Propose': {
            const { command } = (args ?? {}) as { command?: ConsensusLogEntry['command'] };
            if (!command || !command.type) {
              return { ok: false, error: '非法提案载荷：缺少 command' } as Record<string, unknown>;
            }
            return this.propose(command, 8000).then((result) => ({ ok: true, ...result }) as Record<string, unknown>);
          }
          case 'Status':
            return { ok: true, ...this.getClusterStatus() } as Record<string, unknown>;
          default:
            return { ok: false, error: `未知 RPC: ${rpc}` } as Record<string, unknown>;
        }
      })
      .catch((err: unknown) => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }));
  }

  // ─────────────────────────── Raft 核心循环 ───────────────────────────

  /** 重置选举定时器（随机化超时，priority 越高超时越短） */
  private resetElectionTimer(): void {
    this.scheduler.clearTimeout(this.electionTimer);
    if (this.role === 'leader' || !this.running) return;
    const priority = this.selfConfig().priority ?? 1;
    const min = this.config.electionTimeoutMin / Math.max(1, priority);
    const max = this.config.electionTimeoutMax / Math.max(1, priority);
    const timeout = min + this.rng() * (max - min);
    this.electionTimer = this.scheduler.setTimeout(() => this.startElection(), timeout);
  }

  /** 发起选举 */
  private startElection(): void {
    if (!this.running || this.role === 'leader') return;
    this.role = 'candidate';
    this.currentTerm += 1;
    this.votedFor = this.config.localNodeId;
    this.leaderId = null;
    this.persistState();
    this.emitRoleChange();
    this.resetElectionTimer();

    const lastLogIdx = this.lastLogIndex();
    const lastLogTerm = this.lastLogTerm();
    // 有效投票集（缺省 = 配置集群；联合共识期 = 旧/新双集；隔离节点剔除）。
    // 双集口径：候选者须同时获得每个集合的过半票——旧配置多数派与新配置
    // 多数派必相交 ⟹ 变更期间不可能选出两个各自合法的领导者
    const sets = this.voteSets();
    const need = sets.map((s) => Math.floor(s.length / 2) + 1);
    const votes = sets.map((s) => (s.some((n) => n.nodeId === this.config.localNodeId) ? 1 : 0));
    const quarantine = this.quarantineIds();
    const peers = this.replicationTargets().filter((p) => !quarantine.has(p.nodeId));

    if (peers.length === 0) {
      if (votes.every((v, i) => v >= need[i]!)) this.becomeLeader();
      return;
    }

    let settled = false;
    for (const peer of peers) {
      this.sendRpc<RequestVoteReply>(peer, 'RequestVote', {
        term: this.currentTerm,
        candidateId: this.config.localNodeId,
        lastLogIndex: lastLogIdx,
        lastLogTerm,
      })
        .then((reply) => {
          if (settled || this.role !== 'candidate') return;
          if (reply.term > this.currentTerm) {
            this.stepDown(reply.term);
            return;
          }
          if (reply.voteGranted) {
            for (let i = 0; i < sets.length; i += 1) {
              if (sets[i]!.some((n) => n.nodeId === peer.nodeId)) votes[i]! += 1;
            }
            if (votes.every((v, i) => v >= need[i]!)) {
              settled = true;
              this.becomeLeader();
            }
          }
        })
        .catch(() => {
          /* 单 peer 失败不影响选举 */
        });
    }
  }

  /** 成为 leader：初始化 nextIndex/matchIndex 并启动心跳 */
  private becomeLeader(): void {
    this.role = 'leader';
    this.leaderId = this.config.localNodeId;
    const next = this.lastLogIndex() + 1;
    for (const peer of this.replicationTargets()) {
      this.nextIndex.set(peer.nodeId, next);
      this.matchIndex.set(peer.nodeId, Math.max(this.matchIndex.get(peer.nodeId) ?? 0, this.snapshotLastIndex()));
    }
    this.emitRoleChange();
    this.scheduler.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = this.scheduler.setInterval(() => this.broadcastHeartbeat(), this.config.heartbeatInterval);
    this.broadcastHeartbeat();
  }

  /** 降级为 follower */
  private stepDown(newTerm: number): void {
    if (newTerm > this.currentTerm) {
      this.currentTerm = newTerm;
      this.votedFor = null;
      this.persistState();
    }
    // 未提交的成员变更随领导权丢失而作废（条目可被新领导者截断）；
    // 条目若仍在本端日志且被再次复制，handleAppendEntries 会重新采纳联合视图
    if (this.pendingMembership && this.pendingMembership.entryIndex > this.commitIndex) {
      this.pendingMembership = null;
    }
    if (this.role !== 'follower') {
      this.role = 'follower';
      this.scheduler.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.emitRoleChange();
    }
    this.resetElectionTimer();
  }

  /** leader 广播心跳 / 日志复制（守卫开启时按周期穿插审计探测） */
  private broadcastHeartbeat(): void {
    if (this.role !== 'leader' || !this.running) return;
    if (this.guard) {
      this.guard.heartbeatCount += 1;
      if (this.guard.heartbeatCount % this.guard.opts.probeEveryNHeartbeats === 0) {
        for (const peer of this.replicationTargets()) {
          this.probePeer(peer).catch(() => {
            /* 单点探测失败下轮重试 */
          });
        }
      }
    }
    for (const peer of this.replicationTargets()) {
      this.replicateTo(peer).catch(() => {
        /* 单 peer 失败下轮重试 */
      });
    }
  }

  /** 向单个 peer 复制日志 */
  private async replicateTo(peer: ClusterNodeConfig): Promise<void> {
    const next = this.nextIndex.get(peer.nodeId) ?? this.lastLogIndex() + 1;
    const prevLogIndex = next - 1;
    // 本端已压缩到快照：增量日志无从谈起 → 直接安装快照（滞后/新节点追平通道）
    if (prevLogIndex < this.snapshotLastIndex()) {
      await this.sendSnapshotTo(peer);
      return;
    }
    const prevEntry = this.findByIndex(prevLogIndex);
    // 边界锚点：prevLogIndex 恰为快照边界时条目已折叠——用快照末任期
    const prevLogTerm =
      prevEntry?.term ??
      (prevLogIndex === this.snapshotLastIndex() && this.snapshot ? this.snapshot.lastIncludedTerm : 0);
    const entries = this.log.filter((e) => e.index >= next);

    const reply = await this.sendRpc<AppendEntriesReply>(peer, 'AppendEntries', {
      term: this.currentTerm,
      leaderId: this.config.localNodeId,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: this.commitIndex,
    });

    if (reply.term > this.currentTerm) {
      this.stepDown(reply.term);
      return;
    }
    if (this.role !== 'leader') return;

    if (reply.success) {
      const newMatch = prevLogIndex + entries.length;
      this.matchIndex.set(peer.nodeId, Math.max(this.matchIndex.get(peer.nodeId) ?? 0, newMatch));
      this.nextIndex.set(peer.nodeId, newMatch + 1);
      this.advanceCommitIndex();
    } else {
      // 一致性失败：优先采用 follower 的冲突索引提示（直接跳到必然失配处），
      // 无提示时退化为逐跳 -1——大日志滞后 follower 逐跳回退可达数百轮心跳
      const fallback = Math.max(1, next - 1);
      const hinted = reply.conflictIndex && reply.conflictIndex >= 1 ? Math.min(next, reply.conflictIndex) : fallback;
      this.nextIndex.set(peer.nodeId, Math.max(1, Math.min(hinted, fallback)));
    }
  }

  /** 向滞后 peer 发送快照（prevLogIndex 已被本端压缩时替代 AppendEntries） */
  private async sendSnapshotTo(peer: ClusterNodeConfig): Promise<void> {
    if (!this.snapshot) return;
    const reply = await this.sendRpc<InstallSnapshotReply>(peer, 'InstallSnapshot', {
      term: this.currentTerm,
      leaderId: this.config.localNodeId,
      snapshot: this.snapshot,
    });
    if (reply.term > this.currentTerm) {
      this.stepDown(reply.term);
      return;
    }
    if (this.role !== 'leader') return;
    if (reply.success) {
      const through = Math.min(reply.lastIndex, this.snapshot.lastIncludedIndex);
      this.matchIndex.set(peer.nodeId, Math.max(this.matchIndex.get(peer.nodeId) ?? 0, through));
      this.nextIndex.set(peer.nodeId, through + 1);
      this.advanceCommitIndex();
    } else {
      this.nextIndex.set(peer.nodeId, Math.max(1, (this.nextIndex.get(peer.nodeId) ?? 2) - 1));
    }
  }

  /**
   * leader 推进 commitIndex（多数派 + 仅提交当前任期日志）。
   * 法定人数按有效投票集计算：缺省 = 配置集群过半；联合共识期 =
   * 旧配置过半 ∧ 新配置过半（双确认防双主）；隔离节点自任何集合剔除
   */
  private advanceCommitIndex(): void {
    const sets = this.voteSets();
    const need = sets.map((s) => Math.floor(s.length / 2) + 1);
    const selfId = this.config.localNodeId;
    for (let n = this.lastLogIndex(); n > this.commitIndex; n--) {
      const entry = this.findByIndex(n);
      if (!entry || entry.term !== this.currentTerm) continue; // §5.4.2 安全性
      const committed = sets.every((set, i) => {
        let replicated = set.some((m) => m.nodeId === selfId) ? 1 : 0;
        for (const p of set) {
          if (p.nodeId === selfId) continue;
          if ((this.matchIndex.get(p.nodeId) ?? 0) >= n) replicated += 1;
        }
        return replicated >= need[i]!;
      });
      if (committed) {
        this.commitIndex = n;
        this.applyCommitted();
        break;
      }
    }
  }

  /** 应用已提交但未应用的日志条目 */
  private applyCommitted(): void {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied += 1;
      const entry = this.findByIndex(this.lastApplied);
      if (!entry) continue;
      // 成员变更条目应用：配置定局（幂等）；联合视图随定局解除
      if (entry.membership) {
        this.applyMembershipConfig(entry.membership);
        if (this.pendingMembership && this.lastApplied >= this.pendingMembership.entryIndex) {
          this.pendingMembership = null;
        }
      }
      for (const cb of this.commitCallbacks) {
        try {
          cb(entry);
        } catch {
          /* 状态机回调异常不阻塞应用循环 */
        }
      }
      // 兑现提案等待：任期必须匹配。原实现按 index 单键兑现——领导者
      // 在任期 T 于 index i 留下的未决提案，可能被任期 T' 的「另一条
      // 不同条目」在同 index 提交时错误兑现（拿别人的 decision 报成功）；
      // 任期不符时该提案已不可能按原样提交，按失败兑现
      const pending = this.pendingProposals.get(entry.index);
      if (pending) {
        this.pendingProposals.delete(entry.index);
        pending.resolve(
          pending.term === entry.term
            ? { committed: true, decision: entry.command.decision }
            : { committed: false, decision: null },
        );
      }
    }
  }

  // ─────────────────────────── RPC 处理 ───────────────────────────

  /** 处理 RequestVote */
  private handleRequestVote(args: RequestVoteArgs): RequestVoteReply {
    if (args.term > this.currentTerm) this.stepDown(args.term);
    // 非成员 / 已移除 / 被本端隔离的候选人（按本端有效投票集口径）不获票——
    // 成员变更与拜占庭隔离的正确性前提（缺省配置下候选人均为成员，行为不变）
    const knownCandidate = this.voteSets().some((set) => set.some((n) => n.nodeId === args.candidateId));
    if (!knownCandidate) {
      return { term: this.currentTerm, voteGranted: false };
    }
    let voteGranted = false;
    if (args.term === this.currentTerm && (this.votedFor === null || this.votedFor === args.candidateId)) {
      // 日志新鲜度检查
      const candidateUpToDate =
        args.lastLogTerm > this.lastLogTerm() ||
        (args.lastLogTerm === this.lastLogTerm() && args.lastLogIndex >= this.lastLogIndex());
      if (candidateUpToDate) {
        this.votedFor = args.candidateId;
        voteGranted = true;
        this.persistState();
        this.resetElectionTimer();
      }
    }
    return { term: this.currentTerm, voteGranted };
  }

  /** 处理 AppendEntries（快照边界感知） */
  private handleAppendEntries(args: AppendEntriesArgs): AppendEntriesReply {
    if (args.term > this.currentTerm) this.stepDown(args.term);
    if (args.term < this.currentTerm) {
      return { term: this.currentTerm, success: false };
    }
    // candidate 收到同任期合法 AppendEntries 必须降级（Raft §5.2）
    if (this.role === 'candidate') {
      this.stepDown(this.currentTerm);
    }
    // 承认 leader
    this.leaderId = args.leaderId;
    this.resetElectionTimer();

    const base = this.snapshotLastIndex();

    // 一致性检查（快照边界三段式）
    if (args.prevLogIndex > 0) {
      if (args.prevLogIndex < base) {
        // 领导者探测点已被本端快照吸收：该段是已提交前缀（多数派保证
        // 全集群一致），提示边界+1 让领导者续传或改发快照
        return { term: this.currentTerm, success: false, conflictIndex: base + 1 };
      }
      if (args.prevLogIndex === base) {
        // 边界锚点：与快照末任期比对（base=0 且无快照时不会进入——prevLogIndex>0）
        if (this.snapshot && args.prevLogTerm !== this.snapshot.lastIncludedTerm) {
          return { term: this.currentTerm, success: false, conflictIndex: base + 1 };
        }
      } else {
        const prevEntry = this.findByIndex(args.prevLogIndex);
        if (!prevEntry || prevEntry.term !== args.prevLogTerm) {
          // 失配时附冲突索引提示（prevEntry 缺失 → 提示 min(本地末尾+1,
          // prevLogIndex)；任期失配 → 提示该任期段首，领导者可一次跳到必然失配处）
          let conflictIndex: number;
          if (!prevEntry) {
            conflictIndex = Math.min(this.lastLogIndex() + 1, args.prevLogIndex);
          } else {
            // 回溯到本地 prevEntry 同任期的最早索引：该任期段内必然全部失配
            let i = args.prevLogIndex;
            while (i > base + 1) {
              const e = this.findByIndex(i - 1);
              if (!e || e.term !== prevEntry.term) break;
              i -= 1;
            }
            conflictIndex = i;
          }
          return { term: this.currentTerm, success: false, conflictIndex };
        }
      }
    }

    // 快照已吸收的条目跳过（该段已提交，多数派一致性由协议保证）
    const entries = base > 0 ? args.entries.filter((e) => e.index > base) : args.entries;

    // 追加 / 覆盖日志（Raft §5.3）：定位首个不一致条目，从该点截断后
    // 整体追加后缀并按索引排序。原实现逐条独立 push——乱序或带空洞的
    // entries 会产生错序日志（lastLogIndex 读尾元素失真，一致性检查
    // 与复制进度全部错位；空洞条目还会绕过冲突截断直接入链）
    let firstConflict = -1;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      const existing = this.findByIndex(entry.index);
      if (!existing || existing.term === entry.term) continue; // 已一致 / 纯新增
      firstConflict = i;
      break;
    }
    let mutated = false;
    if (firstConflict >= 0) {
      const cutIndex = entries[firstConflict]!.index;
      // 分区愈合：本地未提交段与领导者冲突 → 截断重同步；被弃段显式入账
      this.recordHealing(cutIndex, args.leaderId, entries[entries.length - 1]!.index);
      this.log = this.log.filter((e) => e.index < cutIndex);
      for (let i = firstConflict; i < entries.length; i += 1) this.log.push(entries[i]!);
      mutated = true;
    } else {
      // 无冲突：按下标有序插入（日志按 index 升序的不变量由插入点保证，
      // 免去每批 O(n·logn) 全量排序；纯追加路径为 O(1) 尾推）
      for (const entry of entries) {
        if (this.insertOrdered(entry)) mutated = true;
      }
    }
    if (mutated) {
      this.persistState();
    }

    // 成员变更条目入账即采纳联合视图（Raft 论文 §6：配置自入日志起生效；
    // 单步变更下混合视图的安全性由「两个配置的多数派必相交」保证）
    for (const entry of entries) {
      if (entry.membership && entry.index > this.commitIndex) {
        if (!this.pendingMembership || this.pendingMembership.entryIndex < entry.index) {
          const next = this.membershipPreview(entry.membership);
          if (next) {
            this.pendingMembership = {
              entryIndex: entry.index,
              old: this.config.cluster.map((n) => ({ ...n })),
              new: next.map((n) => ({ ...n })),
              change: entry.membership,
            };
          }
        }
      }
    }

    // 推进提交
    if (args.leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(args.leaderCommit, this.lastLogIndex());
      this.applyCommitted();
    }
    return { term: this.currentTerm, success: true };
  }

  /** 处理 InstallSnapshot（滞后/新节点追平第一段） */
  private handleInstallSnapshot(args: InstallSnapshotArgs): InstallSnapshotReply {
    if (args.term > this.currentTerm) this.stepDown(args.term);
    if (args.term < this.currentTerm) {
      return { term: this.currentTerm, success: false, lastIndex: this.snapshotLastIndex() };
    }
    if (this.role === 'candidate') this.stepDown(this.currentTerm);
    this.leaderId = args.leaderId;
    this.resetElectionTimer();
    const installed = this.installSnapshot(args.snapshot);
    return { term: this.currentTerm, success: installed, lastIndex: this.snapshotLastIndex() };
  }

  // ─────────────────────────── HTTP 传输层 ───────────────────────────

  /** 启动共识 RPC 服务（仅缺省传输；注入传输时零端口占用） */
  private startRpcServer(): void {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed: { rpc?: string; args?: unknown };
        try {
          parsed = JSON.parse(body || '{}') as { rpc?: string; args?: unknown };
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          );
          return;
        }
        this.dispatchRpc(String(parsed.rpc ?? ''), parsed.args).then((reply) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(reply));
        });
      });
    });
    this.server.on('error', () => {
      /* 端口冲突等异常不中断引擎，集群功能降级 */
    });
    this.server.listen(this.config.consensusPort);
  }

  /** 发送 RPC 到 peer：注入传输优先，缺省 HTTP（泛型响应类型，JSON 边界处一次性断言） */
  private sendRpc<T>(peer: ClusterNodeConfig, rpc: string, args: Record<string, unknown>): Promise<T> {
    if (this.transport) return this.transport.sendRpc<T>(peer, rpc, args);
    return this.httpRpc<T>(peer, rpc, args);
  }

  /** HTTP RPC 实现（缺省传输） */
  private httpRpc<T>(peer: ClusterNodeConfig, rpc: string, args: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ rpc, args });
      const req = http.request(
        {
          hostname: peer.address,
          port: peer.port,
          method: 'POST',
          path: '/raft',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          timeout: 2000,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data || '{}') as T);
            } catch {
              reject(new NetworkError(`RPC 响应解析失败: ${rpc}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new NetworkError(`RPC 超时: ${rpc} → ${peer.nodeId}`));
      });
      req.write(payload);
      req.end();
    });
  }

  /** 非 leader 转发提案 */
  private async forwardPropose(leaderId: string, command: ConsensusLogEntry['command'], timeoutMs: number): Promise<ProposeResult> {
    const leader = this.config.cluster.find((n) => n.nodeId === leaderId);
    if (!leader) return { committed: false, decision: null };
    let timer: RaftTimerHandle;
    try {
      const reply = await Promise.race([
        this.sendRpc<ProposeResult>(leader, 'Propose', { command }),
        // 超时兜底定时器在成功路径同样会被 finally 清除——原实现仅在
        // reject 时自然结束，每笔成功转发都悬挂一个 timer 到 timeoutMs
        new Promise<never>((_, reject) => {
          timer = this.scheduler.setTimeout(() => reject(new NetworkError('forward timeout')), timeoutMs);
        }),
      ]);
      return { committed: reply.committed === true, decision: reply.decision ?? null };
    } catch {
      return { committed: false, decision: null };
    } finally {
      if (timer !== undefined) this.scheduler.clearTimeout(timer);
    }
  }

  // ─────────────────────────── 工具方法 ───────────────────────────

  /** 除自己外的 peer 列表（配置集群口径——运维观测） */
  private peers(): ClusterNodeConfig[] {
    return this.config.cluster.filter((n) => n.nodeId !== this.config.localNodeId);
  }

  /**
   * 复制目标：联合共识期取旧∪新配置并集（变更条目须同时送达两个配置的
   * 多数派），缺省 = 配置集群；隔离节点保留在目标中（追赶/申诉通道），
   * 但不参与法定人数（voteSets 剔除）。缺省路径与原 peers() 逐位一致
   */
  private replicationTargets(): ClusterNodeConfig[] {
    const seen = new Set<string>();
    const out: ClusterNodeConfig[] = [];
    const add = (list: ClusterNodeConfig[]) => {
      for (const n of list) {
        if (n.nodeId === this.config.localNodeId || seen.has(n.nodeId)) continue;
        seen.add(n.nodeId);
        out.push(n);
      }
    };
    if (this.pendingMembership) {
      add(this.pendingMembership.old);
      add(this.pendingMembership.new);
    } else {
      add(this.config.cluster);
    }
    return out;
  }

  /** 被隔离节点 id 集（quarantine 与申诉观察期 probation 均排除；守卫关闭 = 空集） */
  private quarantineIds(): Set<string> {
    const out = new Set<string>();
    if (this.guard) {
      for (const st of this.guard.nodes.values()) {
        if (st.status === 'quarantined' || st.status === 'probation') out.add(st.nodeId);
      }
    }
    return out;
  }

  /**
   * 有效投票集（法定人数计算的唯一口径）：
   * - 无进行中成员变更：[配置集群 − 隔离节点]
   * - 联合共识期：[旧配置 − 隔离, 新配置 − 隔离]（双法定人数）
   */
  private voteSets(): ClusterNodeConfig[][] {
    const quarantine = this.quarantineIds();
    const strip = (list: ClusterNodeConfig[]) => list.filter((n) => !quarantine.has(n.nodeId));
    if (this.pendingMembership) return [strip(this.pendingMembership.old), strip(this.pendingMembership.new)];
    return [strip(this.config.cluster)];
  }

  /** 自身节点配置 */
  private selfConfig(): ClusterNodeConfig {
    return (
      this.config.cluster.find((n) => n.nodeId === this.config.localNodeId) ?? {
        nodeId: this.config.localNodeId,
        address: '127.0.0.1',
        port: this.config.consensusPort,
      }
    );
  }

  /** 最后一条日志索引（快照边界 + 后缀长度——O(1)） */
  private lastLogIndex(): number {
    return this.snapshotLastIndex() + this.log.length;
  }

  /**
   * 按索引查日志条目：快照基址 O(1) 直取；形态异常时二分兜底。
   * 原实现 Array.find 线性扫描——advanceCommitIndex 每轮对每个 n 都
   * 全表扫，日志增长到数千条后复制心跳的 CPU 开销平方级膨胀；
   * 压缩升级后又从二分进一步退化为基址算术
   */
  private findByIndex(index: number): ConsensusLogEntry | undefined {
    const pos = index - this.snapshotLastIndex() - 1;
    const direct = this.log[pos];
    if (direct && direct.index === index) return direct;
    if (!direct && pos >= this.log.length) return undefined;
    // 防御回退：二分（错序/空洞容错——不变量由插入路径保证）
    let lo = 0;
    let hi = this.log.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = this.log[mid]!;
      if (e.index === index) return e;
      if (e.index < index) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }

  /**
   * 有序插入：索引已存在返回 false；否则按升序插入到正确位次
   * （纯追加路径 index > 尾元素 → O(1) 尾推）
   */
  private insertOrdered(entry: ConsensusLogEntry): boolean {
    const last = this.log[this.log.length - 1];
    if (last) {
      if (last.index === entry.index) return false;
      if (last.index < entry.index) {
        this.log.push(entry);
        return true;
      }
    } else {
      this.log.push(entry);
      return true;
    }
    // 中段插入：二分定位第一个大于 entry.index 的位置
    let lo = 0;
    let hi = this.log.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.log[mid]!.index < entry.index) lo = mid + 1;
      else hi = mid - 1;
    }
    if (this.log[lo]?.index === entry.index) return false;
    this.log.splice(lo, 0, entry);
    return true;
  }

  /** 最后一条日志任期（后缀为空回落到快照末任期） */
  private lastLogTerm(): number {
    return this.log.length > 0 ? this.log[this.log.length - 1]!.term : (this.snapshot?.lastIncludedTerm ?? 0);
  }

  /** 触发角色变更回调 */
  private emitRoleChange(): void {
    for (const cb of this.roleChangeCallbacks) {
      try {
        cb(this.role, this.currentTerm);
      } catch {
        /* 回调异常不阻塞引擎 */
      }
    }
  }

  /** 加载持久化状态 */
  private loadPersistentState(): void {
    if (!this.persistEnabled) return;
    if (!fs.existsSync(this.config.logPath)) return;
    try {
      const state = JSON.parse(fs.readFileSync(this.config.logPath, 'utf-8')) as RaftPersistentState;
      this.currentTerm = state.currentTerm ?? 0;
      this.votedFor = state.votedFor ?? null;
      this.log = Array.isArray(state.log) ? state.log : [];
      if (state.snapshot && typeof state.snapshot.lastIncludedIndex === 'number' && state.snapshot.lastIncludedIndex >= 0) {
        const snap = state.snapshot;
        this.log = this.log.filter((e) => e.index > snap.lastIncludedIndex);
        this.snapshot = snap;
        this.commitIndex = Math.max(this.commitIndex, snap.lastIncludedIndex);
        this.lastApplied = Math.max(this.lastApplied, snap.lastIncludedIndex);
      }
      // 防御：过滤越界条目并按下标升序重建（index 连续性由追加语义保证）
      const base = this.snapshotLastIndex();
      this.log = this.log
        .filter((e) => e && typeof e.index === 'number' && e.index > base)
        .sort((a, b) => a.index - b.index);
    } catch {
      /* 损坏状态从零开始（安全性由任期机制保证） */
    }
  }

  /**
   * 46.0：法定人数安全审计（纯读取，零漂移）。
   *
   * 多数派交叉 / 容错上界 / 拜占庭可行性 / 负载——共识安全性从
   * 「被相信」升级为「被检查」（多数派两两相交是 Raft 安全性的
   * 根基，46.0 内核的闭式口径）。
   */
  quorumAudit(): { nodes: number; quorumSize: number; minIntersection: number; crashFaultTolerance: number; byzantineTolerance: number; load: number; verdict: string } {
    return raftSafetyAudit(this.config.cluster.length);
  }

  /** 持久化状态（原子写入；persist=false 时零文件系统接触） */
  private persistState(): void {
    if (!this.persistEnabled) return;
    try {
      const state: RaftPersistentState = {
        currentTerm: this.currentTerm,
        votedFor: this.votedFor,
        log: this.log,
        ...(this.snapshot ? { snapshot: this.snapshot } : {}),
      };
      const dir = path.dirname(this.config.logPath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.config.logPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf-8');
      fs.renameSync(tmp, this.config.logPath);
    } catch {
      /* 持久化失败不阻塞共识流程 */
    }
  }
}

// ─────────────────────────── 种子化故障注入仿真台（第三轮） ───────────────────────────

/** mulberry32：32 位种子 → [0,1) 确定性均匀流（同种子同序列） */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 虚拟事件（一次性 / 周期性共用；cancel 按 id 追踪最新代际） */
interface VirtualEvent {
  at: number;
  seq: number;
  id: number;
  every?: number;
  fire: () => void;
  cancelled: boolean;
}

/**
 * 离散事件虚拟时钟：实现 RaftScheduler，时间只在 advance() 中流动。
 * 事件按 (at, 入队序) 确定性触发——选举/心跳/超时全部脱离墙钟
 */
export class RaftVirtualClock implements RaftScheduler {
  private timeNow = 0;
  private seq = 0;
  private nextId = 1;
  private events: VirtualEvent[] = [];
  private liveById = new Map<number, VirtualEvent>();

  /** 当前虚拟时间（毫秒） */
  time(): number {
    return this.timeNow;
  }

  setTimeout(fn: () => void, ms: number): RaftTimerHandle {
    return this.schedule(fn, ms, undefined);
  }

  clearTimeout(handle: RaftTimerHandle): void {
    this.cancel(handle);
  }

  setInterval(fn: () => void, ms: number): RaftTimerHandle {
    // 与 node 定时器同口径：非有限/非正间隔钳到 1（NaN 间隔会造成
    // 永不满足的排序比较 → 事件风暴）
    return this.schedule(fn, Math.max(1, Math.floor(ms) || 1), Math.max(1, Math.floor(ms) || 1));
  }

  clearInterval(handle: RaftTimerHandle): void {
    this.cancel(handle);
  }

  /** 推进虚拟时间，按序触发到期事件；返回触发数 */
  advance(by: number): number {
    const target = this.timeNow + Math.max(0, by);
    let fired = 0;
    for (;;) {
      let idx = -1;
      let best: VirtualEvent | null = null;
      for (let i = 0; i < this.events.length; i += 1) {
        const ev = this.events[i]!;
        if (ev.cancelled || ev.at > target) continue;
        if (!best || ev.at < best.at || (ev.at === best.at && ev.seq < best.seq)) {
          best = ev;
          idx = i;
        }
      }
      if (!best) break;
      this.events.splice(idx, 1);
      this.timeNow = Math.max(this.timeNow, best.at);
      fired += 1;
      if (best.every !== undefined) {
        // 周期事件：同 id 重排（clearInterval 能取消最新代际）
        const re: VirtualEvent = { ...best, at: best.at + best.every, seq: (this.seq += 1) };
        this.events.push(re);
        this.liveById.set(re.id, re);
      } else {
        this.liveById.delete(best.id);
      }
      best.fire();
    }
    this.timeNow = target;
    return fired;
  }

  /** 待触发事件数（含周期事件当代） */
  pendingTimers(): number {
    return this.events.filter((e) => !e.cancelled).length;
  }

  private schedule(fn: () => void, ms: number, every: number | undefined): VirtualEvent {
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 1;
    const ev: VirtualEvent = {
      at: this.timeNow + delay,
      seq: (this.seq += 1),
      id: (this.nextId += 1),
      every,
      fire: fn,
      cancelled: false,
    };
    this.events.push(ev);
    this.liveById.set(ev.id, ev);
    return ev;
  }

  private cancel(handle: RaftTimerHandle): void {
    const ev = this.liveById.get((handle as VirtualEvent | undefined)?.id ?? -1);
    if (ev) ev.cancelled = true;
  }
}

/** 仿真网络消息（在途） */
interface SimMessage {
  at: number;
  seq: number;
  from: string;
  to: string;
  rpc: string;
  args: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/** 仿真网络统计 */
export interface RaftSimNetworkStats {
  submitted: number;
  delivered: number;
  dropped: number;
  delayed: number;
  partitionRejects: number;
}

/**
 * 种子化仿真网络：消息延迟/丢失/分区注入。
 * 与 RaftVirtualClock 共享虚拟时间；transport(nodeId) 产出注入版 RaftTransport
 */
export class RaftSimNetwork {
  readonly rng: () => number;
  private readonly clock: RaftVirtualClock;
  private readonly baseLatencyMs: number;
  private readonly jitterMs: number;
  private readonly dispatchers = new Map<string, (rpc: string, args: unknown) => Promise<Record<string, unknown>>>();
  private queue: SimMessage[] = [];
  private nextSeq = 1;
  private partitionGroups: string[][] = [];
  readonly stats: RaftSimNetworkStats = { submitted: 0, delivered: 0, dropped: 0, delayed: 0, partitionRejects: 0 };

  constructor(clock: RaftVirtualClock, options: { seed?: number; baseLatencyMs?: number; jitterMs?: number } = {}) {
    this.clock = clock;
    this.rng = seededRng(options.seed ?? 1);
    this.baseLatencyMs = options.baseLatencyMs ?? 5;
    this.jitterMs = options.jitterMs ?? 10;
  }

  /** 注册节点分发器（引擎侧入口 = dispatchRpc，与 HTTP 同路径） */
  register(nodeId: string, dispatch: (rpc: string, args: unknown) => Promise<Record<string, unknown>>): void {
    this.dispatchers.set(nodeId, dispatch);
  }

  /** 产出该节点的注入传输层 */
  transport(nodeId: string): RaftTransport {
    return {
      sendRpc: <T>(peer: ClusterNodeConfig, rpc: string, args: Record<string, unknown>) =>
        this.submit(nodeId, peer.nodeId, rpc, args) as Promise<T>,
    };
  }

  /** 设置分区（组间断通；组内连通） */
  setPartition(groups: string[][]): void {
    this.partitionGroups = groups.map((g) => [...g]);
  }

  clearPartition(): void {
    this.partitionGroups = [];
  }

  partitioned(): boolean {
    return this.partitionGroups.length > 0;
  }

  /** 投递全部到期消息（按 at,seq 序）；投递时刻跨分区 → 丢弃 */
  drain(): number {
    let delivered = 0;
    for (;;) {
      let idx = -1;
      let best: SimMessage | null = null;
      for (let i = 0; i < this.queue.length; i += 1) {
        const m = this.queue[i]!;
        if (m.at > this.clock.time()) continue;
        if (!best || m.at < best.at || (m.at === best.at && m.seq < best.seq)) {
          best = m;
          idx = i;
        }
      }
      if (!best) break;
      this.queue.splice(idx, 1);
      if (this.crossesPartition(best.from, best.to)) {
        this.stats.dropped += 1;
        best.reject(new NetworkError(`投递时分区: ${best.from} → ${best.to}`));
        continue;
      }
      const target = this.dispatchers.get(best.to);
      if (!target) {
        best.reject(new NetworkError(`未知/未启动节点: ${best.to}`));
        continue;
      }
      this.stats.delivered += 1;
      delivered += 1;
      // 微任务派发：与真实 HTTP 的异步边界语义一致
      Promise.resolve().then(() => target(best.rpc, best.args)).then(best.resolve, best.reject);
    }
    return delivered;
  }

  /** 在途消息故障注入：随机丢弃 / 追加重延迟 */
  injectFaults(dropRate: number, delayRate: number, maxExtraDelayMs: number): void {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const m = this.queue[i]!;
      const r = this.rng();
      if (r < dropRate) {
        this.queue.splice(i, 1);
        this.stats.dropped += 1;
        m.reject(new NetworkError(`注入丢失: ${m.from} → ${m.to} (${m.rpc})`));
      } else if (r < dropRate + delayRate) {
        m.at += 1 + Math.floor(this.rng() * Math.max(1, maxExtraDelayMs));
        this.stats.delayed += 1;
      }
    }
  }

  /** 在途消息数 */
  pending(): number {
    return this.queue.length;
  }

  /**
   * 冲刷异步边界：让已投递消息的 RPC 回调链（微任务）流转，再投递
   * 回执触发的新到期消息。仿真循环必须 await 此方法——否则 Promise
   * 反应堆在同步轮次间永不排空，选举/复制全部停滞
   */
  async flush(): Promise<void> {
    await Promise.resolve();
    this.drain();
    await Promise.resolve();
    this.drain();
  }

  crossesPartition(a: string, b: string): boolean {
    if (this.partitionGroups.length === 0) return false;
    const groupOf = (x: string) => this.partitionGroups.findIndex((g) => g.includes(x));
    return groupOf(a) !== groupOf(b);
  }

  private submit(from: string, to: string, rpc: string, args: Record<string, unknown>): Promise<unknown> {
    this.stats.submitted += 1;
    if (this.crossesPartition(from, to)) {
      this.stats.dropped += 1;
      this.stats.partitionRejects += 1;
      return Promise.reject(new NetworkError(`分区中断: ${from} → ${to} (${rpc})`));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        at: this.clock.time() + this.baseLatencyMs + Math.floor(this.rng() * this.jitterMs),
        seq: (this.nextSeq += 1),
        from,
        to,
        rpc,
        args,
        resolve,
        reject,
      });
    });
  }
}

/** 仿真统计 */
export interface RaftSimulationStats {
  rounds: number;
  nodes: number;
  delivered: number;
  dropped: number;
  delayed: number;
  partitionRounds: number;
  elections: number;
  proposalsProposed: number;
  proposalsCommitted: number;
  proposalsLost: number;
  compactions: number;
}

/** 仿真报告（确定性：同种子逐位复现——无墙钟、无 Math.random、无持久化） */
export interface RaftSimulationReport {
  seed: number;
  rounds: number;
  nodes: number;
  stats: RaftSimulationStats;
  /** 安全不变量违例（空数组 = 全程成立） */
  invariantViolations: string[];
  /** 任期 → 当选 leader（每任期应恰一个） */
  leadersByTerm: Record<number, string>;
  /** 全局提交日志（index 升序；跨节点日志匹配的最终视图） */
  committedLog: Array<{ index: number; term: number; signalId: string; hash: string }>;
  /** 各节点最终 commitIndex */
  commitIndex: Record<string, number>;
}

/** 故障注入仿真台选项 */
export interface RaftFaultSimOptions {
  /** 集群节点数（默认 5） */
  nodes?: number;
  /** 随机种子（决定选举/故障/提案的全部随机性） */
  seed: number;
  /** 选举超时下/上限（虚拟毫秒；默认 90/180） */
  electionTimeoutMin?: number;
  electionTimeoutMax?: number;
  /** 心跳间隔（默认 25） */
  heartbeatInterval?: number;
  /** 每轮推进的虚拟时间（默认 25） */
  tickMs?: number;
  /** 每轮在途消息丢失率（默认 0.08） */
  dropRate?: number;
  /** 每轮在途消息追延迟率（默认 0.12） */
  delayRate?: number;
  /** 每轮触发新分区的概率（默认 0.045） */
  partitionRate?: number;
  /** 分区最长持续轮数（默认 8） */
  partitionMaxRounds?: number;
  /** 每轮提案概率（默认 0.35） */
  proposeRate?: number;
  /** 每 N 轮对 leader 做一次日志压缩（0 = 关闭；默认 0） */
  compactEvery?: number;
}

/**
 * 种子化故障注入仿真台：N 节点 Raft 集群在离散虚拟时间中承受
 * 消息丢失 / 延迟 / 网络分区的混合故障风暴，逐轮断言四条安全不变量：
 *
 *   INV1 日志单调：index 自快照边界+1 连续递增，无空洞无错序
 *   INV2 已提交不回滚：commitIndex 单调不降；已提交 (index → term:hash)
 *       内容永不改变；快照摘要（throughIndex/entriesApplied）单调不回退
 *   INV3 任期内最多一领导：同一任期最多一个节点成为 leader
 *   INV4 全局日志匹配：任一 index 上被提交过的条目全局唯一（term+hash）
 *
 * 安全性从「Raft 论文说成立」升级为「本实现 + 本故障风暴下被穷尽检验」
 */
export class RaftFaultSimulator {
  readonly clock = new RaftVirtualClock();
  readonly network: RaftSimNetwork;
  private readonly rng: () => number;
  private readonly opts: Required<Omit<RaftFaultSimOptions, 'seed'>> & { seed: number };
  private engines: RaftEngine[] = [];
  private nodeIds: string[] = [];
  private leaderTerms = new Map<number, Set<string>>();
  private committedByNode = new Map<string, Map<number, string>>();
  private digestByNode = new Map<string, RaftStateDigest>();
  private commitIndexByNode = new Map<string, number>();
  private globalCommitted = new Map<number, { term: number; hash: string; signalId: string }>();
  private violations: string[] = [];

  constructor(options: RaftFaultSimOptions) {
    this.opts = {
      nodes: options.nodes ?? 5,
      seed: options.seed,
      electionTimeoutMin: options.electionTimeoutMin ?? 90,
      electionTimeoutMax: options.electionTimeoutMax ?? 180,
      heartbeatInterval: options.heartbeatInterval ?? 25,
      tickMs: options.tickMs ?? 25,
      dropRate: options.dropRate ?? 0.08,
      delayRate: options.delayRate ?? 0.12,
      partitionRate: options.partitionRate ?? 0.045,
      partitionMaxRounds: options.partitionMaxRounds ?? 8,
      proposeRate: options.proposeRate ?? 0.35,
      compactEvery: options.compactEvery ?? 0,
    };
    this.rng = seededRng(this.opts.seed ^ 0x5f3759df);
    this.network = new RaftSimNetwork(this.clock, { seed: (this.opts.seed ^ 0x9e3779b9) >>> 0 });

    const n = Math.max(3, this.opts.nodes);
    this.nodeIds = Array.from({ length: n }, (_, i) => `sim-${i}`);
    const cluster: ClusterNodeConfig[] = this.nodeIds.map((id) => ({ nodeId: id, address: 'sim', port: 0 }));
    this.engines = this.nodeIds.map((id, i) => {
      const engine = new RaftEngine({
        localNodeId: id,
        cluster,
        electionTimeoutMin: this.opts.electionTimeoutMin,
        electionTimeoutMax: this.opts.electionTimeoutMax,
        heartbeatInterval: this.opts.heartbeatInterval,
        consensusPort: 0,
        logPath: `sim://${id}`,
        rng: seededRng((this.opts.seed * 7919 + i * 104729 + 11) >>> 0),
        transport: this.network.transport(id),
        scheduler: this.clock,
        now: () => this.clock.time(),
        persist: false,
      });
      this.network.register(id, (rpc, args) => engine.dispatchRpc(rpc, args));
      engine.onRoleChange((role, term) => {
        if (role !== 'leader') return;
        const set = this.leaderTerms.get(term) ?? new Set<string>();
        set.add(id);
        this.leaderTerms.set(term, set);
      });
      return engine;
    });
  }

  /** 仿真集群中的引擎（只读探针：不变量检查外的自定义断言用） */
  engine(nodeId: string): RaftEngine | undefined {
    return this.engines.find((e) => e.getClusterStatus().localNodeId === nodeId);
  }

  /** 全部引擎 */
  enginesList(): RaftEngine[] {
    return [...this.engines];
  }

  /** 运行混合故障风暴（确定性：同种子同轮数 → 逐位相同报告） */
  async run(rounds: number): Promise<RaftSimulationReport> {
    for (const e of this.engines) e.start();
    const proposals: Array<Promise<{ committed: boolean }>> = [];
    let proposed = 0;
    let partitionRemaining = 0;
    const stats: RaftSimulationStats = {
      rounds,
      nodes: this.nodeIds.length,
      delivered: 0,
      dropped: 0,
      delayed: 0,
      partitionRounds: 0,
      elections: 0,
      proposalsProposed: 0,
      proposalsCommitted: 0,
      proposalsLost: 0,
      compactions: 0,
    };

    for (let round = 0; round < rounds; round += 1) {
      // 1. 分区生命周期（注入 → 持续 → 愈合）
      if (partitionRemaining > 0) {
        partitionRemaining -= 1;
        if (partitionRemaining === 0) this.network.clearPartition();
      } else if (this.rng() < this.opts.partitionRate) {
        // 随机少数派隔离（1..⌊n/2⌋）：多数派侧继续工作，少数派侧停滞
        const size = 1 + Math.floor(this.rng() * Math.floor(this.nodeIds.length / 2));
        const order = [...this.nodeIds];
        for (let i = order.length - 1; i > 0; i -= 1) {
          const j = Math.floor(this.rng() * (i + 1));
          [order[i], order[j]] = [order[j]!, order[i]!];
        }
        this.network.setPartition([order.slice(0, size), order.slice(size)]);
        partitionRemaining = 2 + Math.floor(this.rng() * this.opts.partitionMaxRounds);
        stats.partitionRounds += 1;
      }

      // 2. 虚拟时间推进 + 到期投递 + 微任务冲刷（选举/心跳/复制的回复链在此流转）
      this.clock.advance(this.opts.tickMs);
      await this.network.flush();

      // 3. 在途消息故障注入（丢失/重延迟）
      this.network.injectFaults(this.opts.dropRate, this.opts.delayRate, this.opts.tickMs * 4);

      // 4. 随机节点提案（经 leader 直提或非 leader 转发——两条路径都锻炼）
      if (this.rng() < this.opts.proposeRate) {
        const engine = this.engines[Math.floor(this.rng() * this.engines.length)]!;
        proposed += 1;
        stats.proposalsProposed += 1;
        proposals.push(
          engine.propose(this.simCommand(round), this.opts.tickMs * 160),
        );
      }

      // 5. 安全不变量逐轮断言（先于压缩：本轮新提交条目确保被全局日志
      //    匹配记录覆盖，压缩只隐藏「已被至少一轮检查看过」的前缀）
      this.checkInvariants(round);

      // 6. 周期压缩（把快照/增量追平也拉进故障风暴）
      if (this.opts.compactEvery > 0 && round > 0 && round % this.opts.compactEvery === 0) {
        const leader = this.engines.find((e) => e.getRole() === 'leader');
        if (leader) {
          const status = leader.getClusterStatus();
          if (status.commitIndex - leader.snapshotLastIndex() > 5 && leader.compactLog()) {
            stats.compactions += 1;
          }
        }
      }
    }

    // 尾部安定：末轮投递的深层回复链（投递→dispatch→回执→推进的
    // 多层微任务）多跳冲刷后对最终状态再断言——报告读数与不变量
    // 检查覆盖同一状态
    for (let i = 0; i < 6; i += 1) await this.network.flush();
    this.checkInvariants(rounds);

    // 收尾：停机把未决提案按失败兑现，再统计
    for (const e of this.engines) e.stop();
    const results = await Promise.all(proposals);
    for (const r of results) {
      if (r.committed) stats.proposalsCommitted += 1;
      else stats.proposalsLost += 1;
    }
    stats.delivered = this.network.stats.delivered;
    stats.dropped = this.network.stats.dropped;
    stats.delayed = this.network.stats.delayed;
    // 选举次数 = 有 leader 当选过的任期数（同任期重选不可能——任期自增）
    stats.elections = this.leaderTerms.size;

    const committedLog = [...this.globalCommitted.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, v]) => ({ index, term: v.term, signalId: v.signalId, hash: v.hash }));
    const commitIndex: Record<string, number> = {};
    for (const e of this.engines) {
      const st = e.getClusterStatus();
      commitIndex[st.localNodeId] = st.commitIndex;
    }
    const leadersByTerm: Record<number, string> = {};
    for (const [term, leaders] of [...this.leaderTerms.entries()].sort((a, b) => a[0] - b[0])) {
      leadersByTerm[term] = [...leaders].sort().join('&');
    }

    return {
      seed: this.opts.seed,
      rounds,
      nodes: this.nodeIds.length,
      stats,
      invariantViolations: this.violations,
      leadersByTerm,
      committedLog,
      commitIndex,
    };
  }

  private simCommand(round: number): ConsensusLogEntry['command'] {
    const types: ConsensusLogEntry['command']['type'][] = [
      'execute-plan',
      'reject-signal',
      'defer-signal',
      'reassign-model',
      'escalate-to-user',
    ];
    const proposer = this.nodeIds[Math.floor(this.rng() * this.nodeIds.length)]!;
    return {
      type: types[Math.floor(this.rng() * types.length)]!,
      signalId: `sim-sig-r${round}-${Math.floor(this.rng() * 1e6)}`,
      signalDescription: `故障注入仿真信号（round ${round}）`,
      decision: null,
      proposedBy: proposer,
    };
  }

  /** 四条安全不变量逐轮检查（违例记入 violations，附定位信息） */
  private checkInvariants(round: number): void {
    for (const engine of this.engines) {
      const id = engine.getClusterStatus().localNodeId;
      const log = engine.inspectLog();
      const base = engine.snapshotLastIndex();
      const status = engine.getClusterStatus();

      // INV1 日志单调：index = 边界+1+位次，连续递增
      for (let i = 0; i < log.length; i += 1) {
        if (log[i]!.index !== base + 1 + i) {
          this.violations.push(`INV1(日志单调) r${round} ${id}: 位次 ${i} 期待 index ${base + 1 + i}，实为 ${log[i]!.index}`);
          break;
        }
      }

      // INV2 已提交不回滚：commitIndex 单调 + 内容稳定 + 摘要单调
      const prevCommit = this.commitIndexByNode.get(id) ?? 0;
      if (status.commitIndex < prevCommit) {
        this.violations.push(`INV2(已提交不回滚) r${round} ${id}: commitIndex ${prevCommit} → ${status.commitIndex} 回退`);
      }
      this.commitIndexByNode.set(id, status.commitIndex);

      const prev = this.committedByNode.get(id) ?? new Map<number, string>();
      for (const [idx, fingerprint] of prev) {
        if (idx > base) {
          const entry = log[idx - base - 1];
          const current = entry ? `${entry.term}:${commandHash(entry)}` : 'MISSING';
          if (current !== fingerprint) {
            this.violations.push(`INV2(已提交不回滚) r${round} ${id}: index ${idx} 曾 ${fingerprint}，现 ${current}`);
          }
        } else {
          const snap = engine.snapshotInfo();
          if (!snap || snap.lastIncludedIndex < idx) {
            this.violations.push(`INV2(已提交不回滚) r${round} ${id}: 已提交 index ${idx} 既不在日志也不在快照`);
          }
        }
      }
      const current = new Map(prev);
      for (let idx = base + 1; idx <= status.commitIndex; idx += 1) {
        const entry = log[idx - base - 1];
        if (!entry) {
          this.violations.push(`INV1(日志单调) r${round} ${id}: 提交区 index ${idx} 条目缺失`);
          continue;
        }
        const hash = commandHash(entry);
        current.set(idx, `${entry.term}:${hash}`);
        // INV4 全局日志匹配：同 index 的已提交条目全局唯一
        const seen = this.globalCommitted.get(idx);
        if (seen && (seen.term !== entry.term || seen.hash !== hash)) {
          this.violations.push(
            `INV4(日志匹配) r${round} index ${idx}: ${id} 提交 ${entry.term}:${hash}，与既有 ${seen.term}:${seen.hash} 冲突`,
          );
        } else if (!seen) {
          this.globalCommitted.set(idx, { term: entry.term, hash, signalId: entry.command.signalId });
        }
      }
      this.committedByNode.set(id, current);

      const snap = engine.snapshotInfo();
      if (snap) {
        const prevDigest = this.digestByNode.get(id);
        if (
          prevDigest &&
          (snap.digest.throughIndex < prevDigest.throughIndex || snap.digest.entriesApplied < prevDigest.entriesApplied)
        ) {
          this.violations.push(`INV2(已提交不回滚) r${round} ${id}: 快照摘要回退（${prevDigest.throughIndex}/${prevDigest.entriesApplied} → ${snap.digest.throughIndex}/${snap.digest.entriesApplied}）`);
        }
        this.digestByNode.set(id, { ...snap.digest });
      }
    }

    // INV3 任期内最多一领导
    for (const [term, leaders] of this.leaderTerms) {
      if (leaders.size > 1) {
        this.violations.push(`INV3(任期内最多一领导) r${round} term ${term}: ${[...leaders].sort().join(' & ')} 双领导`);
      }
    }
  }
}

/** 命令指纹（跨节点日志匹配不变量的比较口径） */
function commandHash(entry: ConsensusLogEntry): string {
  return crypto.createHash('sha256').update(JSON.stringify(entry.command)).digest('hex').slice(0, 16);
}
