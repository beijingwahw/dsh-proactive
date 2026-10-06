/**
 * progress-ws.ts — WebSocket 进度广播器（基础层，无内部依赖）
 *
 * 职责：向前端 Dashboard 实时广播执行链路的 13 种进度事件
 * （signal-received / batch-start / strategist-thinking / plan-start /
 *   node-start / node-complete / node-error / node-reflect /
 *   cascade-trigger / plan-complete / role-change / plugin-reloaded / connected）
 *
 * 升级点（相对基础实现的质的提升）：
 * 1. 零第三方依赖：基于 node:http + node:crypto 原生实现 RFC 6455 服务端，
 *    严格遵守"仅使用已声明依赖"的架构约束（不需要 ws 包）
 * 2. 连接即回放：新客户端连接后先回放最近 N 条事件环形缓冲，再收 connected，
 *    Dashboard 刷新后不丢失执行上下文
 * 3. 心跳保活：30s 服务端 ping + 死连接回收，防止半开连接堆积
 * 4. 背压保护：单连接写缓冲超限时主动断开慢客户端，避免拖垮广播循环
 *
 * 第三轮模块域 A14 升级（世界性）：
 * A14-5 话题订阅：客户端可按 plan/task 话题订阅（连接查询参数 ?topics=a,b
 *       或入站 {"type":"subscribe","topics":[...]} 消息），未打话题标签的
 *       事件仍发给所有人（广播语义零漂移），打标签事件只发给订阅者与
 *       通配（未订阅=全收）连接。
 * A14-6 高频更新合并：同键窗口内只发最新（首帧立即发 + 窗口内中段丢弃 +
 *       窗口到期补发最新 + 终态必发绕过合并），合并器 ProgressCoalescer
 *       独立导出、时钟可注入（确定性可测）；默认关闭（零漂移）。
 * A14-7 序号 + 缺口检测 + 重放：每条 broadcast 事件赋全局单调 seq 并入
 *       环形缓冲（含被合并丢弃的事件——终态/历史可补发）；订阅方用
 *       GapDetector 发现丢消息后发送 {"type":"replay","fromSeq":n}
 *       按序重放缺口。
 * A14-8 断线恢复：客户端重连时带 ?offset=N（或发 {"type":"resume","offset":N}，
 *       N = 已收到的最后 seq），从环形缓冲按 seq 续传（N+1 起、不重发已收、
 *       不丢终态）；{"type":"replay","fromSeq":n} 则含起点补洞（n 为缺失的
 *       第一条）；缓冲覆盖不足时如实回报 replay-truncated（不谎称完整）。
 *
 * 第四轮模块域 R4-A14 升级（全新维度）：
 * R4-9 广播快照 API：宿主经 setSnapshotProvider 注册「当前全量状态」投影，
 *       新订阅者连接 ?snapshot=1（或入站 {"type":"snapshot"}）即先拿一份
 *       快照（携带 snapshotSeq = 快照捕获点的全局序号），再从环形缓冲补发
 *       seq > snapshotSeq 的事件、随后进入实时增量流——「快照 + 增量」无缝
 *       （无缺无重）：状态读取与 lastSeq 捕获在同一同步段完成，不存在
 *       竞缝。未注册提供器时如实回报 snapshot-unavailable（不谎称有快照）；
 *       不带 ?snapshot=1 的连接行为逐位不变（零漂移）。
 */

import http from 'node:http';
import crypto from 'node:crypto';

/** 进度事件（type 为附录协议中的 13 种事件名，可自由扩展） */
export interface ProgressEvent {
  type: string;
  timestamp: number;
  /** A14-7：广播器赋予的全局单调序号（1 起）；仅在经广播器发出后存在 */
  seq?: number;
  /** A14-5：话题标签（plan id / task id 等）；无标签 = 广播给所有人 */
  topic?: string;
  [key: string]: unknown;
}

/** WebSocket 握手魔数（RFC 6455 §4.2.2） */
const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** 回放缓冲上限 */
const REPLAY_BUFFER_SIZE = 50;
/** 心跳间隔（毫秒） */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** 单连接写缓冲上限（字节），超限视为慢客户端 */
const MAX_BUFFERED_BYTES = 1024 * 1024;
/** 单连接入站半包缓冲上限（字节），超限视为恶意/异常客户端 */
const MAX_INBOUND_BUFFER = 64 * 1024;

/** A14-6 默认终态事件类型集合（合并豁免——终态必发） */
const DEFAULT_TERMINAL_TYPES = ['node-complete', 'node-error', 'plan-complete'];

/**
 * A14 广播器可注入项（时钟与定时器——验证脚本在虚拟时间轴上确定性驱动）
 */
export interface ProgressBroadcasterOptions {
  /** 环形缓冲条数（默认 50；断线续传的覆盖窗口） */
  replayBufferSize?: number;
  /**
   * A14-6 高频合并窗口（毫秒）；0 / 未配置 = 不合并（逐条直发，零漂移）。
   * 启用后同键事件窗口内只发最新（首帧立即 + 中段丢弃 + 到期补发最新），
   * 终态事件绕过合并立即发送。
   */
  coalesceWindowMs?: number;
  /** 终态事件类型集合（默认 node-complete / node-error / plan-complete；event.terminal === true 恒为终态） */
  terminalTypes?: string[];
  /** 合并键提取（默认 topic|coalesceKey|key|nodeId|taskId|type 依次取值） */
  coalesceKeyOf?: (event: ProgressEvent) => string;
  /** 时钟注入（默认 Date.now） */
  now?: () => number;
  /** 定时器注入（默认 setTimeout；返回句柄交回 clearTimer） */
  setTimer?: (callback: () => void, ms: number) => unknown;
  /** 定时器取消（默认 clearTimeout） */
  clearTimer?: (handle: unknown) => void;
}

/** 缺口区间（左闭右闭，seq 升序） */
export interface SeqGap {
  from: number;
  to: number;
}

/**
 * A14-7 客户端缺口检测器（订阅侧使用；纯逻辑、确定性）。
 *
 * 依次喂入收到的 seq：发现 seq 跳跃即记录缺口区间；重复/过期 seq 忽略。
 * 订阅方凭 gaps() 向广播器发 {"type":"replay","fromSeq": gap.from} 补洞。
 */
export class GapDetector {
  private lastSeq: number | null = null;
  private readonly gaps: SeqGap[] = [];

  /** 喂入一个收到的 seq，返回本次新检出的缺口区间 */
  feed(seq: number): SeqGap[] {
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return [];
    const found: SeqGap[] = [];
    if (this.lastSeq !== null) {
      if (seq > this.lastSeq + 1) {
        const gap: SeqGap = { from: this.lastSeq + 1, to: seq - 1 };
        this.gaps.push(gap);
        found.push(gap);
      }
      if (seq > this.lastSeq) this.lastSeq = seq;
    } else {
      this.lastSeq = seq;
    }
    return found;
  }

  /** 期望的下一个 seq */
  expectedNext(): number {
    return this.lastSeq === null ? 1 : this.lastSeq + 1;
  }

  /** 累计检出缺口（拷贝） */
  getGaps(): SeqGap[] {
    return this.gaps.map((g) => ({ ...g }));
  }
}

/**
 * A14-6 高频更新合并器（纯逻辑；时钟注入，确定性可测）。
 *
 * 窗口语义（leading + trailing + 终态绕过）：
 * - 键的窗口起点由该键第一条事件开启，首条**立即发送**（偶发更新零延迟）；
 * - 窗口内同键后续事件只保留最新一条为「尾随候选」，中段事件被丢弃；
 * - 窗口到期（flushDue / 定时器）补发最新候选，窗口关闭；
 * - 终态事件（terminal() 为真）无条件立即发送，并关闭该键窗口
 *   （先补发该键被扣留的尾随候选，保持 seq 升序）。
 *
 * 被丢弃的中段事件仍已进入广播器环形缓冲（含 seq）——订阅方可用
 * GapDetector 检出缺口并 replay 补取，实现「合并降载但不丢信息」。
 */
export class ProgressCoalescer {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly terminal: (e: ProgressEvent) => boolean;
  private readonly keyOf: (e: ProgressEvent) => string;
  private readonly windows = new Map<string, { start: number; pending?: ProgressEvent }>();
  /** 被合并丢弃（未直发）的事件计数（旧 vs 新对照的核心读数） */
  public coalescedDropped = 0;
  /** 补发（尾随）事件计数 */
  public trailingSent = 0;

  constructor(options: {
    windowMs: number;
    now: () => number;
    terminal?: (e: ProgressEvent) => boolean;
    keyOf?: (e: ProgressEvent) => string;
  }) {
    this.windowMs = Math.max(0, options.windowMs);
    this.now = options.now;
    this.terminal = options.terminal ?? ((e) => e.terminal === true);
    this.keyOf = options.keyOf ?? defaultCoalesceKey;
  }

  /**
   * 输入一条新事件，返回应「立即发送」的事件（seq 升序：
   * 可能先补发该键被扣留的尾随候选，再发新事件本身）。
   */
  offer(event: ProgressEvent): ProgressEvent[] {
    const key = this.keyOf(event);
    if (this.windowMs <= 0 || this.terminal(event)) {
      const win = this.windows.get(key);
      this.windows.delete(key);
      // 终态前先补发该键被扣留的尾随候选（若有），保证订阅方先见旧态再见终态
      return win?.pending ? [win.pending, event] : [event];
    }
    const win = this.windows.get(key);
    const t = this.now();
    if (win && t - win.start < this.windowMs) {
      // 窗口内：只保留最新（中段丢弃，计数）
      if (win.pending) this.coalescedDropped += 1;
      win.pending = event;
      return [];
    }
    // 新窗口开启：首帧立即发送
    this.windows.set(key, { start: t });
    return [event];
  }

  /** 冲刷到期的尾随候选（窗口关闭；返回事件按 seq 升序） */
  flushDue(): ProgressEvent[] {
    const t = this.now();
    const out: ProgressEvent[] = [];
    for (const [key, win] of [...this.windows.entries()]) {
      if (!win.pending) {
        if (t - win.start >= this.windowMs) this.windows.delete(key);
        continue;
      }
      if (t - win.start >= this.windowMs) {
        out.push(win.pending);
        this.trailingSent += 1;
        this.windows.delete(key);
      }
    }
    out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return out;
  }

  /** 当前被扣留的尾随候选数 */
  pending(): number {
    let n = 0;
    for (const win of this.windows.values()) if (win.pending) n += 1;
    return n;
  }

  /** 距最近的窗口到期还有多少毫秒（无活动窗口返回 undefined） */
  nextDueIn(): number | undefined {
    let min: number | undefined;
    const t = this.now();
    for (const win of this.windows.values()) {
      if (!win.pending) continue;
      const due = win.start + this.windowMs - t;
      if (min === undefined || due < min) min = due;
    }
    return min === undefined ? undefined : Math.max(0, min);
  }
}

/** 默认合并键：topic | coalesceKey | key | nodeId | taskId | type 依次取值 */
function defaultCoalesceKey(e: ProgressEvent): string {
  const explicit = (e.coalesceKey ?? e.key) as string | undefined;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const owner = (e.nodeId ?? e.taskId) as string | undefined;
  if (typeof owner === 'string' && owner.length > 0) return `${e.topic ?? ''}|${owner}`;
  return `${e.topic ?? ''}|${e.type}`;
}

/** 内部连接记录 */
interface WsConnection {
  socket: import('node:net').Socket;
  /** 是否已完成关闭握手 */
  closed: boolean;
  /** 最近一次收到该连接任何入站帧（pong/上行）的时间 */
  lastPongAt: number;
  /** 跨 TCP 分片累积的未完整帧数据（处理粘包/半包） */
  pendingData: Buffer;
  /** A14-5：话题订阅（null = 通配，收一切） */
  topics: Set<string> | null;
  /** A14 入站分片累积（FIN=0 的 continuation 拼接） */
  fragBuffer: Buffer | null;
  fragOpcode: number | null;
}

/**
 * WebSocket 进度广播器
 *
 * 独立监听一个 HTTP 端口并升级为 WebSocket 服务。
 * 被 index.ts 集成层持有，执行链路各阶段调用 broadcast() 推送事件。
 */
export class ProgressBroadcaster {
  private port: number;
  private server: http.Server | null = null;
  private connections = new Set<WsConnection>();
  /** 环形回放缓冲（A14-7：含被合并丢弃的事件，元素带 seq） */
  private replayBuffer: ProgressEvent[] = [];
  private replayBufferSize: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  /** 可选 HTTP 请求处理器（dashboard 等静态页面复用本端口；返回 true 表示已响应） */
  private httpHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => boolean) | null = null;

  // ── A14 注入项与升级状态 ──
  private readonly now: () => number;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly coalescer: ProgressCoalescer;
  private readonly terminalTypes: Set<string>;
  /** A14-7：全局单调序号（从 1 起；0 表示尚未广播过） */
  private lastSeq = 0;
  /** A14-6：合并窗口到期定时器句柄（单一，重设前清旧） */
  private coalesceTimer: unknown = null;
  /** R4-9：全量状态快照提供器（宿主注册；null = 不提供，如实回报不可用） */
  private snapshotProvider: (() => Record<string, unknown> | null) | null = null;
  /** R4-9：已服务快照次数（旧 vs 新读数：无请求恒 0） */
  private snapshotServed = 0;

  /**
   * @param port 监听端口，默认 9877（与 cordis.patch.yml progressPort 一致）
   * @param options A14 升级项（全部可选；缺省 = 升级前行为 + seq 字段）
   */
  constructor(port: number = 9877, options: ProgressBroadcasterOptions = {}) {
    this.port = port;
    this.replayBufferSize = Math.max(1, Math.floor(options.replayBufferSize ?? REPLAY_BUFFER_SIZE));
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.terminalTypes = new Set(options.terminalTypes ?? DEFAULT_TERMINAL_TYPES);
    this.coalescer = new ProgressCoalescer({
      windowMs: options.coalesceWindowMs ?? 0,
      now: this.now,
      terminal: (e) => e.terminal === true || this.terminalTypes.has(e.type),
      keyOf: options.coalesceKeyOf,
    });
  }

  /**
   * 注册 HTTP 请求处理器（非 WebSocket 升级请求优先交给它）
   * @param handler 返回 true 表示已处理该请求；返回 false 走默认健康检查响应
   */
  setHttpHandler(handler: ((req: http.IncomingMessage, res: http.ServerResponse) => boolean) | null): void {
    this.httpHandler = handler;
  }

  /**
   * 启动 WebSocket 服务
   * 监听失败（端口冲突等）通过 'error' 事件降级停机并记录，
   * 不抛出——EventEmitter 回调内 throw 会成为进程级未捕获异常
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.server = http.createServer((req, res) => {
      // 优先交给自定义 HTTP 处理器（dashboard 页面等）
      if (this.httpHandler && this.httpHandler(req, res)) return;
      // 非升级请求返回健康检查信息
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          service: 'dsh-proactive/progress-ws',
          clients: this.connections.size,
          bufferedEvents: this.replayBuffer.length,
          lastSeq: this.lastSeq,
          coalescedDropped: this.coalescer.coalescedDropped,
        }),
      );
    });

    this.server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket as import('node:net').Socket));
    this.server.on('error', (err) => {
      // 运维事件（EADDRINUSE / 网络异常）优雅降级：记录并复位启动位，
      // 允许宿主换端口重启；绝不在此 throw——'error' 监听器内的
      // 异常无人可捕获，会直接击穿宿主进程
      console.error(`[progress-ws] 进度广播服务异常（端口 ${this.port}），已降级停机: ${err.message}`);
      this.stop();
    });

    this.server.listen(this.port);

    // 心跳：定期 ping 所有客户端，回收无响应连接。
    // pong 超时检测：仅靠「写 ping 失败」回收不了半开连接（写缓冲照常
    // 吞下 ping，对端已死）——连续 2 个心跳周期无任何入站帧即判死线
    this.heartbeatTimer = setInterval(() => {
      const deadline = this.now() - 2 * HEARTBEAT_INTERVAL_MS;
      for (const conn of [...this.connections]) {
        if (conn.lastPongAt < deadline) {
          this.dropConnection(conn);
          continue;
        }
        try {
          this.sendFrame(conn.socket, Buffer.alloc(0), 0x9); // ping
        } catch {
          this.dropConnection(conn);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  /**
   * 广播事件给在线客户端，并写入回放缓冲
   *
   * A14 语义（在升级前行为上的纯增量）：
   * - 事件赋全局单调 seq 并入环形缓冲（含被合并丢弃的事件）；
   * - 未启用合并（缺省）时逐条直发——与升级前逐位一致（仅多 seq 字段）；
   * - 启用合并后：同键窗口内只发最新、终态绕过合并立即发。
   *
   * @param event 进度事件（timestamp 缺省时自动补当前时间）
   */
  broadcast(event: ProgressEvent): void {
    const full: ProgressEvent = {
      ...event,
      timestamp: event.timestamp ?? this.now(),
      seq: (this.lastSeq += 1),
    };

    // 环形缓冲（终态/历史补发数据源）
    this.replayBuffer.push(full);
    if (this.replayBuffer.length > this.replayBufferSize) {
      this.replayBuffer.shift();
    }

    // 合并器：先冲刷到期尾随（旧 seq 在前），再裁决新事件
    for (const e of [...this.coalescer.flushDue(), ...this.coalescer.offer(full)]) {
      this.fanOut(e);
    }
    this.scheduleCoalesceFlush();
  }

  /**
   * 停止服务：关闭所有连接与监听
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.coalesceTimer !== null) {
      this.clearTimer(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    for (const conn of [...this.connections]) {
      try {
        this.sendFrame(conn.socket, Buffer.alloc(0), 0x8); // close frame
      } catch {
        /* 忽略 */
      }
      conn.socket.destroy();
    }
    this.connections.clear();
    this.server?.close();
    this.server = null;
  }

  /** 当前在线连接数 */
  getClientCount(): number {
    return this.connections.size;
  }

  /** A14：实际监听端口（listen(0) 时为内核分配值；未启动返回 null） */
  getPort(): number | null {
    const addr = this.server?.address();
    return typeof addr === 'object' && addr !== null ? addr.port : null;
  }

  /** A14：最新全局序号（已广播事件数） */
  getLastSeq(): number {
    return this.lastSeq;
  }

  /** A14：环形缓冲中最旧的 seq（缓冲空返回 null） */
  getOldestSeq(): number | null {
    return this.replayBuffer.length > 0 ? (this.replayBuffer[0]!.seq ?? null) : null;
  }

  /** A14：被合并丢弃的事件计数（旧 vs 新对照读数） */
  getCoalescedDropped(): number {
    return this.coalescer.coalescedDropped;
  }

  // ─────────────────────── R4-A14-9 广播快照 ───────────────────────

  /**
   * R4-9：注册全量状态快照提供器。
   *
   * 提供器在每次快照请求时被同步调用、返回当前全量状态（任意可 JSON
   * 序列化对象；null = 当前无状态可给，如实回报 snapshot-empty）。
   * 广播器在**同一同步段**内读取提供器与 lastSeq——快照与其增量流
   * 之间不存在事件竞缝（Node 单线程保证），订阅方据此实现
   * 「快照（截至 snapshotSeq）+ 补发（seq > snapshotSeq）+ 实时流」
   * 的无缝衔接。传 null 注销。
   */
  setSnapshotProvider(provider: (() => Record<string, unknown> | null) | null): void {
    this.snapshotProvider = provider;
  }

  /** R4-9：已服务快照次数 */
  getSnapshotServedCount(): number {
    return this.snapshotServed;
  }

  /**
   * R4-9：向连接服务一份快照 + 增量衔接。
   *
   * 1. 同步段内原子捕获：snapshotSeq = lastSeq、state = provider()；
   * 2. 发送 {type:'snapshot', snapshotSeq, state}（不经话题过滤——快照是
   *    连接级状态视图，非话题事件）；
   * 3. 从环形缓冲补发 seq > snapshotSeq 的事件（经话题过滤，与订阅语义
   *    一致），随后自然进入实时增量流。
   * 未注册提供器 → snapshot-unavailable（如实）；提供器抛错 →
   * snapshot-error（如实，不吞异常）。
   */
  private serveSnapshot(conn: WsConnection): { snapshotSeq: number; sent: number } | null {
    if (!this.snapshotProvider) {
      this.deliver(conn, {
        type: 'snapshot-unavailable',
        timestamp: this.now(),
        message: '服务端未注册快照提供器（setSnapshotProvider）',
      });
      return null;
    }
    const snapshotSeq = this.lastSeq;
    let state: Record<string, unknown> | null | undefined;
    try {
      state = this.snapshotProvider();
    } catch (err) {
      this.deliver(conn, {
        type: 'snapshot-error',
        timestamp: this.now(),
        message: `快照提供器抛错: ${(err as Error)?.message ?? String(err)}`,
      });
      return null;
    }
    this.snapshotServed += 1;
    // 快照事件不走 broadcast（无全局 seq——它是状态视图而非事件）；
    // 也绕过话题过滤（连接级视图），直接成帧发送
    const snapshotEvent: ProgressEvent = {
      type: 'snapshot',
      timestamp: this.now(),
      snapshotSeq,
      state: state ?? null,
      ...(state === null || state === undefined ? { empty: true } : {}),
    };
    try {
      this.sendFrame(conn.socket, Buffer.from(JSON.stringify(snapshotEvent), 'utf-8'), 0x1);
    } catch {
      this.dropConnection(conn);
      return null;
    }
    // 增量衔接：补发快照捕获点之后的事件（seq > snapshotSeq，不重不漏）
    const { sent } = this.replayFrom(conn, snapshotSeq, false);
    return { snapshotSeq, sent };
  }

  // ─────────────────────────── 内部实现 ───────────────────────────

  /** 单连接投递：话题过滤 + 写缓冲背压保护 */
  private deliver(conn: WsConnection, event: ProgressEvent): void {
    if (conn.closed) return;
    if (!this.matchesSubscription(conn, event)) return;
    try {
      this.sendFrame(conn.socket, Buffer.from(JSON.stringify(event), 'utf-8'), 0x1); // text frame
    } catch {
      this.dropConnection(conn);
    }
  }

  /** 话题过滤：无标签事件人人可见；有标签事件发给通配连接与订阅者 */
  private matchesSubscription(conn: WsConnection, event: ProgressEvent): boolean {
    if (conn.topics === null || event.topic === undefined) return true;
    return conn.topics.has(event.topic);
  }

  /** 对所有在线连接投递（慢客户端按写缓冲超限断开） */
  private fanOut(event: ProgressEvent): void {
    const frame = Buffer.from(JSON.stringify(event), 'utf-8');
    for (const conn of this.connections) {
      if (conn.closed) continue;
      if (!this.matchesSubscription(conn, event)) continue;
      // 背压保护：慢客户端直接断开
      if (conn.socket.writableLength > MAX_BUFFERED_BYTES) {
        this.dropConnection(conn);
        continue;
      }
      try {
        this.sendFrame(conn.socket, frame, 0x1); // text frame
      } catch {
        this.dropConnection(conn);
      }
    }
  }

  /** A14-6：有尾随候选时安排窗口到期补发（单一定时器，重设前清旧） */
  private scheduleCoalesceFlush(): void {
    if (this.coalesceTimer !== null) {
      this.clearTimer(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    const dueIn = this.coalescer.nextDueIn();
    if (dueIn === undefined) return;
    this.coalesceTimer = this.setTimer(() => {
      this.coalesceTimer = null;
      for (const e of this.coalescer.flushDue()) this.fanOut(e);
      this.scheduleCoalesceFlush();
    }, dueIn);
  }

  /** RFC 6455 握手（A14：解析 ?offset / ?topics 查询参数） */
  private handleUpgrade(req: http.IncomingMessage, socket: import('node:net').Socket): void {
    const key = req.headers['sec-websocket-key'];
    if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(key + WS_MAGIC_GUID).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'),
    );

    // A14-5/A14-8：连接参数（offset 断线续传起点 / topics 话题订阅）
    let query: URLSearchParams | null = null;
    try {
      query = new URL(req.url ?? '/', 'http://progress.local').searchParams;
    } catch {
      query = null;
    }
    const topicsParam = query?.get('topics');
    const topics = topicsParam
      ? new Set(topicsParam.split(',').map((t) => t.trim()).filter((t) => t.length > 0))
      : null;
    const offsetRaw = query?.get('offset');
    const offset = offsetRaw !== null && Number.isFinite(Number(offsetRaw)) ? Number(offsetRaw) : null;
    // R4-9：?snapshot=1 请求全量状态快照（优先于 offset 回放——快照 +
    // 其后增量衔接的语义涵盖断线续传；两者同带时以快照为准）
    const snapshotRaw = query?.get('snapshot');
    const wantsSnapshot = snapshotRaw === '1' || snapshotRaw === 'true';

    const conn: WsConnection = {
      socket,
      closed: false,
      lastPongAt: this.now(),
      pendingData: Buffer.alloc(0),
      topics,
      fragBuffer: null,
      fragOpcode: null,
    };
    this.connections.add(conn);

    // 回放历史事件 → 再发 connected（附录协议）
    // A14-8：带 offset 时从该 seq 之后续传（offset = 客户端已收到的最后
    // seq，续传 N+1 起不重发；环形缓冲覆盖不足则如实回报截断）
    if (wantsSnapshot) {
      this.serveSnapshot(conn);
    } else if (offset !== null && offset > 0) {
      this.replayFrom(conn, offset, false);
    } else {
      for (const past of this.replayBuffer) {
        this.deliver(conn, past);
      }
    }
    const connectedEvent: ProgressEvent = {
      type: 'connected',
      timestamp: this.now(),
      clientCount: this.connections.size,
      lastSeq: this.lastSeq,
      oldestSeq: this.getOldestSeq(),
    };
    this.sendFrame(socket, Buffer.from(JSON.stringify(connectedEvent), 'utf-8'), 0x1);

    socket.on('data', (chunk: Buffer) => this.handleData(conn, chunk));
    socket.on('close', () => this.dropConnection(conn));
    socket.on('error', () => this.dropConnection(conn));
  }

  /**
   * A14-7/A14-8：按 seq 从环形缓冲重放给指定连接（覆盖不足如实回报截断）。
   *
   * @param fromSeq 起点序号
   * @param inclusive true = 重放 seq ≥ fromSeq（replay 补洞：fromSeq 是缺失的第一条）；
   *                  false = 重放 seq > fromSeq（resume/offset 续传：fromSeq 是
   *                  客户端已收到的最后一条，续传不重发）
   */
  private replayFrom(conn: WsConnection, fromSeq: number, inclusive = true): { sent: number; truncated: boolean } {
    const oldest = this.getOldestSeq();
    const truncated = oldest !== null && fromSeq < oldest;
    if (truncated) {
      this.deliver(conn, {
        type: 'replay-truncated',
        timestamp: this.now(),
        requestedFrom: fromSeq,
        oldestSeq: oldest,
        message: `环形缓冲最早保留 seq=${oldest}，请求的 seq=${fromSeq} 之前的消息不可补发`,
      });
    }
    const lowerBound = inclusive ? fromSeq : fromSeq + 1;
    let sent = 0;
    for (const past of this.replayBuffer) {
      if ((past.seq ?? 0) >= lowerBound) {
        this.deliver(conn, past);
        sent += 1;
      }
    }
    return { sent, truncated };
  }

  /**
   * A14-5/A14-7：入站控制消息处理（subscribe / unsubscribe / replay / resume）
   */
  private handleControlMessage(conn: WsConnection, text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      this.deliver(conn, { type: 'error', timestamp: this.now(), message: '入站消息不是合法 JSON' });
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'subscribe': {
        const list = Array.isArray(msg.topics) ? msg.topics.filter((t: unknown): t is string => typeof t === 'string') : null;
        conn.topics = list && list.length > 0 ? new Set(list) : null;
        this.deliver(conn, { type: 'subscribed', timestamp: this.now(), topics: conn.topics ? [...conn.topics] : null });
        return;
      }
      case 'unsubscribe': {
        const list = Array.isArray(msg.topics) ? msg.topics.filter((t: unknown): t is string => typeof t === 'string') : [];
        if (list.length === 0) conn.topics = null;
        else {
          if (conn.topics) for (const t of list) conn.topics.delete(t);
          if (conn.topics && conn.topics.size === 0) conn.topics = null;
        }
        this.deliver(conn, { type: 'unsubscribed', timestamp: this.now(), topics: conn.topics ? [...conn.topics] : null });
        return;
      }
      case 'replay': {
        // replay 补洞：fromSeq 是缺失的第一条 → 含起点重放
        const raw = msg.fromSeq;
        const fromSeq = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 1;
        const { sent, truncated } = this.replayFrom(conn, fromSeq, true);
        this.deliver(conn, {
          type: 'replay-end',
          timestamp: this.now(),
          fromSeq,
          sent,
          truncated,
          lastSeq: this.lastSeq,
          oldestSeq: this.getOldestSeq(),
        });
        return;
      }
      case 'resume': {
        // resume 续传：offset 是客户端已收到的最后一条 → 从 offset+1 起不重发
        const raw = msg.offset;
        const offset = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
        const { sent, truncated } = this.replayFrom(conn, offset, false);
        this.deliver(conn, {
          type: 'replay-end',
          timestamp: this.now(),
          fromSeq: offset + 1,
          sent,
          truncated,
          lastSeq: this.lastSeq,
          oldestSeq: this.getOldestSeq(),
        });
        return;
      }
      case 'snapshot': {
        // R4-9：按需快照——先拿全量状态（截至 snapshotSeq），再补发其后事件
        const result = this.serveSnapshot(conn);
        if (result) {
          this.deliver(conn, {
            type: 'snapshot-end',
            timestamp: this.now(),
            snapshotSeq: result.snapshotSeq,
            sent: result.sent,
            lastSeq: this.lastSeq,
          });
        }
        return;
      }
      default:
        this.deliver(conn, { type: 'error', timestamp: this.now(), message: `无法识别的入站消息类型: ${String(msg.type)}` });
    }
  }

  /**
   * 解析入站帧（客户端帧必带掩码）
   * 控制帧：close(0x8) / ping(0x9) / pong(0xA)；
   * A14：文本帧(0x1) 携带订阅/重放控制消息（掩码解除 + 分片拼接）。
   *
   * TCP 不保证报文边界：一个 WebSocket 帧可能跨多个 data 事件到达（分片），
   * 多个帧也可能挤在同一个 chunk 里（粘包）。因此维护 pendingData 缓冲，
   * 每次仅消费完整帧，未消费的余量留给下一个 data 事件拼接。
   */
  private handleData(conn: WsConnection, chunk: Buffer): void {
    conn.lastPongAt = this.now(); // 任何入站帧都证明对端存活
    const buffer = conn.pendingData.length > 0 ? Buffer.concat([conn.pendingData, chunk]) : chunk;
    let offset = 0;
    while (offset + 2 <= buffer.length) {
      const firstByte = buffer[offset]!;
      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const masked = (buffer[offset + 1]! & 0x80) !== 0;
      let payloadLength = buffer[offset + 1]! & 0x7f;
      let headerSize = 2;

      if (payloadLength === 126) {
        if (offset + 4 > buffer.length) break;
        payloadLength = buffer.readUInt16BE(offset + 2);
        headerSize = 4;
      } else if (payloadLength === 127) {
        if (offset + 10 > buffer.length) break;
        payloadLength = Number(buffer.readBigUInt64BE(offset + 2));
        headerSize = 10;
      }

      const maskSize = masked ? 4 : 0;
      const frameEnd = offset + headerSize + maskSize + payloadLength;
      if (frameEnd > buffer.length) break; // 半包：等待更多数据

      if (opcode === 0x8) {
        // close：回应并断开
        try {
          this.sendFrame(conn.socket, Buffer.alloc(0), 0x8);
        } catch {
          /* 忽略 */
        }
        conn.pendingData = Buffer.alloc(0);
        conn.socket.end();
        return;
      }
      if (opcode === 0x9) {
        // ping → pong
        this.sendFrame(conn.socket, Buffer.alloc(0), 0xa);
        offset = frameEnd;
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        // 数据帧：解除掩码，拼接分片
        const mask = masked ? buffer.subarray(offset + headerSize, offset + headerSize + 4) : null;
        const payload = buffer.subarray(offset + headerSize + maskSize, frameEnd);
        const data = mask ? unmask(payload, mask) : Buffer.from(payload);
        if (opcode !== 0x0) conn.fragOpcode = opcode;
        conn.fragBuffer = conn.fragBuffer ? Buffer.concat([conn.fragBuffer, data]) : data;
        if (fin) {
          const text = conn.fragBuffer.toString('utf-8');
          const wasText = conn.fragOpcode === 0x1;
          conn.fragBuffer = null;
          conn.fragOpcode = null;
          if (wasText && text.length > 0) this.handleControlMessage(conn, text);
        }
        offset = frameEnd;
        continue;
      }
      // pong(0xA) 等其余帧无需处理
      offset = frameEnd;
    }
    // 余量留存：半包数据等下一个 data 事件拼接
    conn.pendingData = buffer.subarray(offset);
    // 半包超限：客户端声称的帧长度远超合理控制帧尺寸（且拒不补齐），按异常断开
    if (conn.pendingData.length > MAX_INBOUND_BUFFER) {
      this.dropConnection(conn);
    }
  }

  /** 发送未掩码服务端帧 */
  private sendFrame(socket: import('node:net').Socket, payload: Buffer, opcode: number): void {
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  }

  /** 清理连接 */
  private dropConnection(conn: WsConnection): void {
    if (conn.closed) return;
    conn.closed = true;
    this.connections.delete(conn);
    conn.socket.destroy();
  }
}

/** RFC 6455 §5.3：解除客户端掩码 */
function unmask(payload: Buffer, mask: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    out[i] = payload[i]! ^ mask[i & 3]!;
  }
  return out;
}
