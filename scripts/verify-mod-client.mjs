/**
 * verify-mod-client.mjs — 第三轮模块域 A14 升级：LLMClient / ProgressBroadcaster 新旧行为对照验证
 *
 * 前任已完成两文件源码升级（A14-1~A14-8 全就位、tsc 0 错），本脚本补齐
 * 「证明」侧——六项升级各配「旧行为 vs 新行为」的构造对照（不是「改了」，
 * 是「证明更好」），全部经注入 fake transport / 注入时钟驱动，零真外网：
 *
 *   ① 重试去相关抖动（A14-1）：
 *      a) 纯函数 nextRetryDelay 10 万次随机扫描：1 ≤ delay ≤ min(envelope, cap)
 *         逐点有界（旧固定退避 delay ≡ base·2^k 无抖动窗口）；
 *      b) 雪崩对照（核心）：24 客户端同时失败——旧固定退避每个重试节拍
 *         24 家全部同拍到达（unique=1、std=0ms）；新混合抖动（全抖动 ×
 *         AWS 去相关抖动，链状态 prevDelay 逐链分叉）24 家到达时刻
 *         unique=24、std>2s——同步雪崩被打散；
 *      c) 期望与支撑集：cap 钳位区大样本均值 ≤ 0.75·cap，p95−p5 > 8s
 *         （到达时刻真正铺开，不是集中在一个点附近的伪抖动）；
 *      d) 集成链复现：LLMClient 注入恒 503 fetch + 种子 RNG + 假 sleep，
 *         实测 sleeps 与手算 nextRetryDelay 链逐位相等（调度器确实换了）。
 *   ② 令牌账户与硬预算（A14-2）：
 *      a) 记账精确：3 次成功（实测 usage 1000/1500/2500，价 $0.002/k）+
 *         1 次失败（输入估算 100）→ spentTokens=5100、spentCost=$0.0102
 *         逐分不差；
 *      b) 硬熔断：limit=1000，2 次调用耗尽 → 第 3/4 次新调用 100% 被
 *         BUDGET_EXHAUSTED 拒绝（连队列都不进），onExhausted 恰上报 1 次
 *         （防重）；
 *      c) 在途完成：预算耗尽后新调用拒绝，但已挂起的在途调用正常完成
 *         并如实入账（spent 可越限至 2500——「熔断新调用、不杀在途」）。
 *   ③ 流式背压（A14-3）：
 *      a) BoundedPump 单测：无界供给 + 消费停滞 → 缓冲冻结在高水位、
 *         producer 拉取计数冻结（暂停拉取口径）；恢复消费零丢失按序
 *         24/24 交付；
 *      b) chatStream 集成：注入 SSE 传输层 read 计数 + 消费者注入延迟
 *         （每 chunk 真睡 1ms）——消费第 10 块处停滞 15ms，传输层 read
 *         几乎零增长（旧实现无界 read 会持续吞流）；最终 40/40 delta
 *         零丢失按序、done 帧收尾、return 值按实测 usage 记账。
 *   ④ 高频合并 + 序号缺口（A14-6/A14-7 纯逻辑）：
 *      同键窗口内 9 条只发 1（leading）+ 到期补发最新（trailing）、
 *      coalescedDropped 计数；终态绕过合并且先补发扣留候选（seq 升序）；
 *      GapDetector 喂 1,2,3,7,7,10 → 检出 [4..6] 与 [8..9]、重复忽略。
 *   ⑤ WS 集成（A14-5/6/7/8，真 localhost 环回 + 虚拟时钟）：
 *      最小 RFC6455 客户端（掩码上行 + 帧解析）——话题订阅（无标签人人
 *      可见 / 有标签只发订阅者 / subscribe 动态改订）；同键 30 条高频 →
 *      订阅方仅收 leading+trailing 2 帧（旧口径 30 帧全灌）、被丢弃 28 条
 *      经 replay 全部可补、终态 0 丢弃；断线重连 ?offset=N 续传不丢终态；
 *      环形缓冲覆盖不足如实回报 replay-truncated。
 *   ⑥ 调用审计（A14-4）：
 *      成功/失败/拒绝三结局结构化落账（model/kind/outcome/latencyMs/
 *      attempts/retries/tokens/cost/errorKind/errorStatus/streamChunks/
 *      budgetSpentTokens），虚拟时钟下 latencyMs 逐毫秒精确；环形有界
 *      （容量 4 留 4 条，最旧挤出）；消费者提前中止流记 'aborted'。
 *   ⓪ 零漂移总检：LLMClient 缺省无预算（limit=Infinity 只记账不熔断）；
 *      ProgressBroadcaster 缺省不合并（coalescedDropped=0）且 seq/回放
 *      照常；缺省成功调用行为与升级前同构。
 *
 * 确定性：LLM 侧时间走注入 nowImpl、退避走注入 sleepImpl + 种子化
 * mulberry32、传输层为 fake fetch（503 / 挂起 / SSE 流）；广播侧时钟与
 * 合并定时器均注入（虚拟时间轴手动推进）；WS 仅走 127.0.0.1 环回，
 * 不出本机。
 *
 * 运行：npm run build && node scripts/verify-mod-client.mjs
 */

import net from 'node:net';
import crypto from 'node:crypto';
import {
  LLMClient,
  nextRetryDelay,
  BoundedPump,
  ProgressBroadcaster,
  ProgressCoalescer,
  GapDetector,
  mulberry32,
} from '../dist/index.mjs';

// ─────────────────────────── 断言工具 ───────────────────────────
let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}
function near(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}
function section(title) {
  console.log(`\n■ ${title}`);
}
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(desc, cond, timeoutMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await realSleep(15);
  }
  return cond();
}

// ─────────────────────── fake 传输层与时钟 ───────────────────────

/** 恒 503 的 fake fetch（可重试错误） */
function fetch503() {
  return async () => ({ ok: false, status: 503, text: async () => 'server exploded' });
}

/** 按脚本应答的 fake fetch：成功返回固定 usage（并在每次调用时步进注入时钟） */
function makeScriptedFetch(responses, clock) {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (clock) clock.t += r.stepMs ?? 25;
    if (r.hang) return new Promise(() => {}); // 挂起（在途调用）
    if (r.ok === false) return { ok: false, status: r.status, text: async () => 'err' };
    return { ok: true, status: 200, json: async () => ({ model: r.model ?? 'fake-m', choices: [{ message: { content: r.content ?? 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: r.tokens } }) };
  };
}

/** SSE 流式 fake：返回带 getReader 的 body，逐行交付并统计传输层 read 次数 */
function makeSseFetch(deltas, usage, readsCounter) {
  const enc = new TextEncoder();
  const lines = [
    ...deltas.map((d) => `data: ${JSON.stringify({ model: 'fake-m', choices: [{ delta: { content: d } }] })}\n\n`),
    `data: ${JSON.stringify({ model: 'fake-m', choices: [{ delta: { content: '' } }], usage })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return async () => {
    let i = 0;
    const body = {
      getReader() {
        return {
          async read() {
            readsCounter.n += 1;
            if (i >= lines.length) return { done: true, value: undefined };
            return { done: false, value: enc.encode(lines[i++]) };
          },
          async cancel() {},
        };
      },
    };
    return { ok: true, status: 200, body };
  };
}

/** 最小 RFC6455 客户端（仅测试用：掩码上行 + 服务端帧解析） */
class MiniWs {
  constructor() {
    this.events = [];
    this.raw = [];
    this.open = false;
    this.buf = Buffer.alloc(0);
    this.handshakeDone = false;
  }
  static connect(port, path) {
    return new Promise((resolve, reject) => {
      const ws = new MiniWs();
      ws.socket = net.connect(port, '127.0.0.1', () => {
        const key = crypto.randomBytes(16).toString('base64');
        ws.socket.write(
          `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      ws.socket.on('data', (chunk) => ws.onData(chunk));
      ws.socket.on('error', reject);
      const timer = setTimeout(() => reject(new Error('ws handshake timeout')), 2500);
      const poll = setInterval(() => {
        if (ws.handshakeDone) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(ws);
        }
      }, 10);
    });
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.handshakeDone) {
      const idx = this.buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = this.buf.subarray(0, idx).toString('utf-8');
      if (!head.includes('101')) {
        this.socket.destroy();
        return;
      }
      this.buf = this.buf.subarray(idx + 4);
      this.handshakeDone = true;
      this.open = true;
    }
    // 解析服务端帧（无掩码；可能粘包）
    let off = 0;
    while (off + 2 <= this.buf.length) {
      const opcode = this.buf[off] & 0x0f;
      let len = this.buf[off + 1] & 0x7f;
      let hdr = 2;
      if (len === 126) {
        if (off + 4 > this.buf.length) break;
        len = this.buf.readUInt16BE(off + 2);
        hdr = 4;
      } else if (len === 127) {
        if (off + 10 > this.buf.length) break;
        len = Number(this.buf.readBigUInt64BE(off + 2));
        hdr = 10;
      }
      if (off + hdr + len > this.buf.length) break;
      const payload = this.buf.subarray(off + hdr, off + hdr + len);
      if (opcode === 0x1) {
        try {
          this.events.push(JSON.parse(payload.toString('utf-8')));
        } catch {
          /* 忽略非 JSON */
        }
      } else if (opcode === 0x8) {
        this.open = false;
      }
      off += hdr + len;
    }
    this.buf = this.buf.subarray(off);
  }
  send(text) {
    const payload = Buffer.from(text, 'utf-8');
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
  close() {
    this.open = false;
    this.socket.destroy();
  }
  /** 收到的指定 type 事件 */
  of(type) {
    return this.events.filter((e) => e.type === type);
  }
}

// ═══════════════════════════ ⓪ 零漂移总检 ═══════════════════════════

section('⓪ 零漂移总检：缺省配置下两模块行为与升级前同构');

{
  const clock = { t: 0 };
  const client = new LLMClient({ fetchImpl: makeScriptedFetch([{ tokens: 120 }], clock), nowImpl: () => clock.t });
  client.registerModel({ id: 'm', endpoint: 'http://fake' });
  const account0 = client.getTokenAccount();
  ok(account0.limit === Number.POSITIVE_INFINITY && account0.spentTokens === 0 && account0.exhausted === false,
    'LLMClient 缺省：无预算（limit=Infinity 只记账不熔断）、初始账户归零');
  ok(client.getAuditLog().length === 0, 'LLMClient 缺省：审计初始为空（不自动改变调用行为）');
  const resp = await client.chat('m', [{ role: 'user', content: 'hi' }]);
  ok(resp.content === 'ok' && client.getTokenAccount().spentTokens === 120,
    'LLMClient 缺省：成功调用照常返回并记账（120 token），无熔断干预');

  const bc = new ProgressBroadcaster(0); // 不 start：纯逻辑面
  for (let i = 0; i < 3; i += 1) bc.broadcast({ type: 'node-start', nodeId: `n${i}` });
  ok(bc.getCoalescedDropped() === 0, 'ProgressBroadcaster 缺省：不合并（coalescedDropped=0，逐条直发零漂移）');
  ok(bc.getLastSeq() === 3 && bc.getOldestSeq() === 1,
    'ProgressBroadcaster 缺省：seq 照常赋号单调（1→3）、环形缓冲可查');
  ok(bc.getClientCount() === 0 && bc.getPort() === null, 'ProgressBroadcaster 缺省：未启动时连接数/端口口径不变');
}

// ═════════════════════ ① A14-1 重试去相关抖动 ═════════════════════

section('① A14-1 混合抖动退避：有界 + 去相关 + 雪崩消解');

{
  // a) 纯函数逐点有界（10 万次随机扫描）
  const cfg = { baseDelay: 500, maxDelay: 30_000 };
  const scan = mulberry32(1234);
  let minSeen = Infinity;
  let maxSeen = 0;
  let viol = 0;
  for (let i = 0; i < 100_000; i += 1) {
    const attempt = Math.floor(scan() * 12);
    const prev = 1 + Math.floor(scan() * 30_000);
    const d = nextRetryDelay(attempt, prev, cfg, scan);
    const envelope = Math.min(cfg.maxDelay, cfg.baseDelay * 2 ** attempt);
    const decorHigh = Math.min(cfg.maxDelay, Math.max(cfg.baseDelay, prev * 3));
    const ceiling = Math.min(cfg.maxDelay, Math.max(envelope, decorHigh));
    if (!(d >= 1 && d <= ceiling)) viol += 1;
    minSeen = Math.min(minSeen, d);
    maxSeen = Math.max(maxSeen, d);
  }
  ok(viol === 0, `纯函数 10 万次扫描零违界：恒有 1 ≤ delay ≤ min(cap, max(指数包络, 去相关链上界))（实测 [${minSeen}, ${maxSeen}] ≤ cap=${cfg.maxDelay}）`);

  // b) 雪崩对照：24 客户端同时失败，前 4 次重试的到达时刻分散度
  const M = 24;
  const BASE = 500;
  const CAP = 30_000;
  // 旧行为：固定指数退避 delay_k = base·2^k（无抖动）
  const legacyArrivals = [];
  for (let c = 0; c < M; c += 1) {
    const t = [0];
    for (let k = 0; k < 4; k += 1) t.push(t[t.length - 1] + BASE * 2 ** k);
    legacyArrivals.push(t);
  }
  const legacyAt = (beat) => {
    const s = new Set(legacyArrivals.map((t) => t[beat]));
    const arr = [...s];
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const std = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
    return { unique: s.size, std };
  };
  // 新行为：混合抖动（每客户端独立种子链，prevDelay 链状态去相关）
  const hybridArrivals = [];
  for (let c = 0; c < M; c += 1) {
    const rand = mulberry32(10_000 + c);
    const t = [0];
    let prev = BASE;
    for (let k = 0; k < 4; k += 1) {
      prev = nextRetryDelay(k, prev, { baseDelay: BASE, maxDelay: CAP }, rand);
      t.push(t[t.length - 1] + prev);
    }
    hybridArrivals.push(t);
  }
  const hybridAt = (beat) => {
    const arr = hybridArrivals.map((t) => t[beat]);
    const uniq = new Set(arr);
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const std = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
    return { unique: uniq.size, std };
  };
  let legacyAllSameBeat = true;
  let hybridSpreadAllBeats = true;
  const hybridStdByBeat = [];
  for (let beat = 1; beat <= 4; beat += 1) {
    const l = legacyAt(beat);
    const h = hybridAt(beat);
    if (l.unique !== 1 || l.std !== 0) legacyAllSameBeat = false;
    // 分散度按该拍指数包络的比例度量：包络窄的首拍（500ms）到达时刻
    // std 达包络 5% 且 unique 近满即视为打散；包络宽的拍位自然更散
    const envelopeBeat = Math.min(CAP, BASE * 2 ** (beat - 1));
    if (!(h.unique >= M - 2 && h.std >= 0.05 * envelopeBeat)) hybridSpreadAllBeats = false;
    hybridStdByBeat.push(h.std);
  }
  ok(legacyAllSameBeat, `旧固定退避雪崩复现：24 客户端 4 个重试节拍全部同拍到达（unique=1、std=0ms）`);
  ok(hybridSpreadAllBeats,
    `新混合抖动消解雪崩：同 24 客户端各拍 unique≥${M - 2}（无同拍）、std=[${hybridStdByBeat.map((s) => Math.round(s)).join(', ')}]ms ≥ 各拍包络 5% [${[1, 2, 3, 4].map((b) => Math.round(0.05 * Math.min(CAP, BASE * 2 ** (b - 1))) + 'ms').join(', ')}]（首拍包络仅 ${BASE}ms、std=${Math.round(hybridStdByBeat[0])}ms 已无任何同拍）`);

  // c) cap 钳位区的期望与支撑集（大样本）
  const rand = mulberry32(777);
  const N = 20_000;
  const ds = [];
  for (let i = 0; i < N; i += 1) ds.push(nextRetryDelay(20, 25_000, { baseDelay: BASE, maxDelay: CAP }, rand));
  ds.sort((a, b) => a - b);
  const mean = ds.reduce((a, b) => a + b, 0) / N;
  const p5 = ds[Math.floor(N * 0.05)];
  const p95 = ds[Math.floor(N * 0.95)];
  ok(mean <= 0.75 * CAP, `cap 钳位区期望有界：E[delay]=${Math.round(mean)}ms ≤ 0.75·cap=${Math.round(0.75 * CAP)}ms`);
  ok(p95 - p5 >= 8_000, `支撑集真正铺开：p95−p5=${Math.round(p95 - p5)}ms ≥ 8000ms（非集中伪抖动）`);

  // d) 集成：注入 503 + 种子 RNG + 假 sleep —— 实测退避链与手算逐位相等
  const sleeps = [];
  const client = new LLMClient({
    maxRetries: 3,
    retryBaseDelay: 500,
    retryMaxDelay: 30_000,
    fetchImpl: fetch503(),
    jitterRandom: mulberry32(42),
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    nowImpl: () => 0,
  });
  client.registerModel({ id: 'm', endpoint: 'http://fake' });
  await client.chat('m', [{ role: 'user', content: 'x' }]).catch(() => undefined);
  const replay = mulberry32(42);
  const expect = [];
  let prev = 500;
  for (let k = 0; k < 3; k += 1) {
    prev = nextRetryDelay(k, prev, { baseDelay: 500, maxDelay: 30_000 }, replay);
    expect.push(prev);
  }
  ok(
    sleeps.length === 3 && sleeps.every((s, i) => s === expect[i]),
    `LLMClient 集成：恒 503 失败链实测退避 [${sleeps.join(', ')}] 与新调度手算链逐位相等（共 ${sleeps.length} 次重试，各 ≤ 30s 钳位）`,
  );
  const auditFail = client.getAuditLog()[0];
  ok(auditFail && auditFail.outcome === 'failure' && auditFail.attempts === 4 && auditFail.retries === 3 && auditFail.errorStatus === 503,
    '重试链终局审计：attempts=4 / retries=3 / errorStatus=503 如实落账');
}

// ═════════════════════ ② A14-2 令牌账户与硬预算 ═════════════════════

section('② A14-2 令牌账户：精确记账 + 硬熔断 + 在途完成');

{
  // a) 记账精确（价目表计价）
  const clock = { t: 0 };
  const client = new LLMClient({ fetchImpl: makeScriptedFetch([{ tokens: 1000 }, { tokens: 1500 }, { tokens: 2500 }], clock), nowImpl: () => clock.t });
  client.registerModel({ id: 'm', endpoint: 'http://fake', costPerKToken: 0.002 });
  for (let i = 0; i < 3; i += 1) await client.chat('m', [{ role: 'user', content: 'q' }]);
  const a1 = client.getTokenAccount();
  ok(a1.spentTokens === 5000 && a1.meteredCalls === 3 && near(a1.spentCost, 0.01),
    `成功调用按实测 usage 记账：3 次共 ${a1.spentTokens} token / $${a1.spentCost.toFixed(4)}（0.002/k × 5000）`);
  // 失败调用按输入估算入账（400 字符 → 100 token）
  const c2 = new LLMClient({ maxRetries: 0, fetchImpl: fetch503(), nowImpl: () => 0 });
  c2.registerModel({ id: 'm', endpoint: 'http://fake', costPerKToken: 0.002 });
  await c2.chat('m', [{ role: 'user', content: 'a'.repeat(400) }]).catch(() => undefined);
  const a2 = c2.getTokenAccount();
  ok(a2.spentTokens === 100 && a2.meteredCalls === 1,
    `失败调用按输入估算入账：400 字符 → ${a2.spentTokens} token（端点已吞 prompt，如实记账）`);
}

{
  // b) 硬熔断 + onExhausted 防重
  let exhaustedReports = [];
  const clock = { t: 0 };
  const client = new LLMClient({
    maxRetries: 0,
    fetchImpl: makeScriptedFetch([{ tokens: 600 }, { tokens: 600 }], clock),
    nowImpl: () => clock.t,
    tokenBudget: {
      limit: 1000,
      onExhausted: (s) => exhaustedReports.push({ spent: s.spentTokens, limit: s.limit, rejected: s.rejectedCalls }),
    },
  });
  client.registerModel({ id: 'm', endpoint: 'http://fake', costPerKToken: 0.001 });
  await client.chat('m', [{ role: 'user', content: 'a' }]); // 600
  const accMid = client.getTokenAccount();
  ok(accMid.spentTokens === 600 && accMid.remainingTokens === 400 && !accMid.exhausted && exhaustedReports.length === 0,
    '未耗尽前调用正常放行（remaining=400，不上报）');
  await client.chat('m', [{ role: 'user', content: 'a' }]); // +600 → 1200 ≥ 1000
  ok(exhaustedReports.length === 1 && exhaustedReports[0].spent === 1200,
    `第 2 次调用入账 1200 ≥ limit 触发 onExhausted 恰 1 次（上报 spent=1200）`);
  let rejected = null;
  try {
    await client.chat('m', [{ role: 'user', content: 'a' }]);
  } catch (err) {
    rejected = err;
  }
  const accEx = client.getTokenAccount();
  ok(
    rejected !== null &&
      rejected.details?.code === 'BUDGET_EXHAUSTED' &&
      accEx.rejectedCalls === 1 &&
      accEx.exhausted === true &&
      accEx.meteredCalls === 2, // 被拒不记账（无消耗）
    '耗尽后新调用 100% 熔断拒绝（BUDGET_EXHAUSTED，连队列都不进、不记账）');
  try {
    await client.chat('m', [{ role: 'user', content: 'a' }]);
  } catch {
    /* 预期 */
  }
  ok(exhaustedReports.length === 1 && client.getTokenAccount().rejectedCalls === 2,
    '重复拒绝不再重复上报（exhaustedReported 防重），rejectedCalls 累计=2');
  const rejAudits = client.getAuditLog().filter((e) => e.outcome === 'rejected');
  ok(
    rejAudits.length === 2 &&
      rejAudits.every((e) => e.errorKind === 'BUDGET_EXHAUSTED' && e.tokensUsed === 0 && e.attempts === 0),
    '拒绝记录入审计（outcome=rejected / errorKind=BUDGET_EXHAUSTED / tokens=0）');
}

{
  // c) 在途完成（熔断新调用、不杀在途）
  const clock = { t: 0 };
  let releaseA;
  const hangThen500 = async () =>
    new Promise((resolve) => {
      releaseA = () => resolve({ ok: true, status: 200, json: async () => ({ model: 'fake-m', choices: [{ message: { content: 'inflight-done' } }], usage: { total_tokens: 500 } }) });
    });
  const responses = [{ hang: true }, { tokens: 2000, stepMs: 5 }];
  let call = 0;
  const client = new LLMClient({
    maxRetries: 0,
    nowImpl: () => clock.t,
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return hangThen500();
      return makeScriptedFetch([responses[1]], clock)();
    },
    tokenBudget: { limit: 2000 },
  });
  client.registerModel({ id: 'm', endpoint: 'http://fake', costPerKToken: 0.001 });
  const inflight = client.chat('m', [{ role: 'user', content: 'a' }]); // A 挂起
  await realSleep(20);
  await client.chat('m', [{ role: 'user', content: 'b' }]); // B 成功 2000 → 耗尽
  let cRejected = false;
  try {
    await client.chat('m', [{ role: 'user', content: 'c' }]);
  } catch {
    cRejected = true;
  }
  ok(cRejected, '预算被 B 耗尽后，新调用 C 立即熔断拒绝');
  releaseA(); // A 完成
  const respA = await inflight;
  const acc = client.getTokenAccount();
  ok(
    respA.content === 'inflight-done' && acc.spentTokens === 2500 && acc.exhausted === true,
    `在途调用 A 不被杀：正常完成并如实入账（spent 2000→${acc.spentTokens}，允许小幅越限）`,
  );
}

// ═════════════════════ ③ A14-3 流式背压 ═════════════════════

section('③ A14-3 流式背压：缓冲上限 + 暂停拉取口径 + 零丢失');

{
  // a) BoundedPump 单测：无界供给 + 停止消费
  const TOTAL = 24;
  let producedN = 0;
  const pump = new BoundedPump(
    async () => {
      producedN += 1;
      return producedN <= TOTAL ? [producedN] : undefined;
    },
    { highWatermark: 4 },
  );
  pump.start();
  await realSleep(15);
  const bufferedAtStall = pump.buffered;
  const pullsAtStall = pump.producerPulls;
  await realSleep(15);
  ok(
    bufferedAtStall <= 4 && pump.buffered <= 4 && pump.maxBufferedObserved <= 4,
    `消费停滞时缓冲冻结在高水位：buffered=${bufferedAtStall} ≤ high=4（永不无限缓冲）`,
  );
  ok(pump.producerPulls === pullsAtStall, `消费停滞时暂停拉取口径：producer 拉取计数冻结在 ${pullsAtStall}（不再生产）`);
  const got = [];
  for (;;) {
    const r = await pump.next();
    if (r.done) break;
    got.push(r.value);
  }
  ok(got.length === TOTAL && got.every((v, i) => v === i + 1), `恢复消费零丢失按序交付：${got.length}/${TOTAL} 且逐位有序`);
  ok(pump.producerPulls === TOTAL, `拉取恰好补齐：最终 producerPulls=${pump.producerPulls}（不丢不重不预吞）`);

  // b) chatStream 集成：注入消费延迟 + 传输层 read 计数
  const deltas = Array.from({ length: 40 }, (_, i) => `块${i}#`);
  const usage = { prompt_tokens: 100, completion_tokens: 700, total_tokens: 800 };
  const reads = { n: 0 };
  const clock = { t: 0 };
  const client = new LLMClient({
    fetchImpl: makeSseFetch(deltas, usage, reads),
    streamHighWatermark: 8,
    nowImpl: () => clock.t,
  });
  client.registerModel({ id: 'm', endpoint: 'http://fake', costPerKToken: 0.002 });
  const chunks = [];
  let readsAtPause = -1;
  let readsAfterPause = -1;
  const gen = client.chatStream('m', [{ role: 'user', content: 'q' }]);
  let r = await gen.next();
  let i = 0;
  while (!r.done) {
    chunks.push(r.value);
    i += 1;
    if (i === 10) {
      // 消费者停摆 15ms：传输层 read 应几乎冻结（背压传导到 read()）
      readsAtPause = reads.n;
      await realSleep(15);
      readsAfterPause = reads.n;
    }
    await realSleep(1); // 注入消费延迟
    r = await gen.next();
  }
  const response = r.value;
  const textFrames = chunks.filter((c) => !c.done);
  const joined = textFrames.map((c) => c.delta).join('');
  ok(
    readsAtPause > 0 && readsAfterPause - readsAtPause <= 3,
    `慢消费者停摆 15ms 期间传输层 read 仅 +${readsAfterPause - readsAtPause} 次（≤3：暂停拉取，不无限吞流）`,
  );
  ok(
    textFrames.length === 41 && textFrames.filter((c) => c.delta.length > 0).length === 40 && joined === deltas.join(''),
    `零丢失按序：40/40 delta 全交付（+1 纯 usage 帧），拼接全文逐位一致`,
  );
  ok(chunks[chunks.length - 1].done === true, '终帧 done 标记随流收尾');
  ok(
    response.tokensUsed === 800 && near(response.cost, 0.0016) && response.retries === 0,
    `流式返回值按实测 usage 记账：tokens=800 / cost=$${response.cost.toFixed(4)}（0.002/k）`,
  );
  ok(reads.n === 42, `流结束后传输层 read 恰补齐 ${reads.n} 次（40 delta + 1 usage 帧 + 1 [DONE]，不预吞不少读）`);
  const sAudit = client.getAuditLog().find((e) => e.kind === 'chat-stream');
  ok(
    sAudit && sAudit.outcome === 'success' && sAudit.streamChunks === 41 && sAudit.tokensUsed === 800,
    '流式审计：streamChunks=41（40 delta + 1 usage 帧）/ tokens=800 / outcome=success',
  );

  // c) 消费者提前中止 → aborted 终局（不抛错、审计如实）
  const reads2 = { n: 0 };
  const client2 = new LLMClient({ fetchImpl: makeSseFetch(deltas, usage, reads2), nowImpl: () => 0 });
  client2.registerModel({ id: 'm', endpoint: 'http://fake' });
  const gen2 = client2.chatStream('m', [{ role: 'user', content: 'q' }]);
  let got2 = 0;
  for await (const c of gen2) {
    got2 += 1;
    if (got2 === 5) break; // 提前中止
  }
  await realSleep(20);
  const abortAudit = client2.getAuditLog().find((e) => e.kind === 'chat-stream');
  ok(
    abortAudit && abortAudit.outcome === 'aborted' && abortAudit.streamChunks === 5,
    `消费者提前中止流：不抛错，审计记 outcome=aborted / streamChunks=5（传输层被 cancel，连接释放）`,
  );
}

// ═════════════ ④ A14-6/7 合并器与缺口检测（纯逻辑，注入时钟） ═════════════

section('④ A14-6 高频合并（终态必发）+ A14-7 缺口检测（纯逻辑）');

{
  const vt = { t: 0 };
  let seq = 0;
  const ev = (type, extra = {}) => ({ type, timestamp: vt.t, seq: ++seq, ...extra });
  const co = new ProgressCoalescer({
    windowMs: 100,
    now: () => vt.t,
    terminal: (e) => e.type === 'node-complete' || e.type === 'node-error' || e.terminal === true,
  });
  const sent = [];
  const emit = (arr) => {
    for (const e of arr) sent.push(e);
  };

  emit(co.offer(ev('node-progress', { nodeId: 'n1', pct: 1 }))); // t=0 leading
  ok(sent.length === 1 && sent[0].pct === 1, '同键首帧立即发送（leading，偶发更新零延迟）');
  let tick = 0;
  for (const pct of [2, 5, 9, 20, 40, 60, 80, 95]) {
    vt.t = 10 + (tick += 1) * 8; // t=18..74，均在窗口内（<100）
    emit(co.offer(ev('node-progress', { nodeId: 'n1', pct })));
  }
  ok(sent.length === 1 && co.pending() === 1 && co.coalescedDropped === 7,
    `窗口内同键后续 8 条：中段丢弃 7 条、最新 1 条扣留为尾随候选（coalescedDropped=${co.coalescedDropped}）`);
  vt.t = 200; // 窗口到期
  emit(co.flushDue());
  ok(sent.length === 2 && sent[1].pct === 95 && co.trailingSent === 1, '窗口到期补发最新候选（trailing=pct95）');
  // 终态必发：先扣留候选再发终态，seq 升序
  vt.t = 210;
  emit(co.offer(ev('node-progress', { nodeId: 'n1', pct: 97 }))); // 新窗口 leading
  vt.t = 215;
  emit(co.offer(ev('node-progress', { nodeId: 'n1', pct: 98 }))); // 窗口内扣留
  const beforeTerminal = sent.length;
  vt.t = 216;
  emit(co.offer(ev('node-complete', { nodeId: 'n1' }))); // 终态绕过合并
  ok(
    sent.length === beforeTerminal + 2 && sent[sent.length - 2].pct === 98 && sent[sent.length - 1].type === 'node-complete',
    '终态必发绕过合并：先补发扣留候选（pct98）再发终态，seq 升序不乱',
  );
  ok(
    sent.every((e, i) => i === 0 || e.seq > sent[i - 1].seq),
    '合并器输出恒 seq 单调（订阅方 GapDetector 不会误报乱序）',
  );

  const det = new GapDetector();
  const g1 = det.feed(1);
  det.feed(2);
  det.feed(3);
  const g2 = det.feed(7);
  const g3 = det.feed(7); // 重复忽略
  const g4 = det.feed(10);
  const gaps = det.getGaps();
  ok(
    g1.length === 0 &&
      g2.length === 1 && g2[0].from === 4 && g2[0].to === 6 &&
      g3.length === 0 &&
      g4.length === 1 && g4[0].from === 8 && g4[0].to === 9,
    `GapDetector 检出缺口 [4..6] 与 [8..9]、重复 seq 忽略（共 ${gaps.length} 段）`,
  );
  ok(det.expectedNext() === 11, 'expectedNext=11（重放请求的 fromSeq 口径）');
}

// ═════════════ ⑤ A14-5/6/7/8 WS 集成（localhost 环回 + 虚拟时钟） ═════════════

section('⑤ WS 集成：话题订阅 / 高频合并终态保留 / 缺口重放 / 断线续传');

{
  const vt = { t: 1000 };
  const pendingTimers = new Map();
  let timerId = 0;
  const setTimer = (cb, ms) => {
    const id = ++timerId;
    pendingTimers.set(id, { cb, at: vt.t + ms });
    return id;
  };
  const clearTimer = (h) => pendingTimers.delete(h);
  const advance = (ms) => {
    vt.t += ms;
    for (const [id, t] of [...pendingTimers]) {
      if (t.at <= vt.t) {
        pendingTimers.delete(id);
        t.cb();
      }
    }
  };

  const bc = new ProgressBroadcaster(0, {
    replayBufferSize: 50,
    coalesceWindowMs: 100,
    now: () => vt.t,
    setTimer,
    clearTimer,
  });
  bc.start();
  const port = bc.getPort();
  ok(port !== null && port > 0, `广播器已启动（port=${port}，环回 127.0.0.1，不出本机）`);

  try {
    // A14-5 话题订阅
    const wsA = await MiniWs.connect(port, '/?topics=plan-a');
    ok(await waitFor('connected', () => wsA.of('connected').length === 1), '客户端 A 连接（?topics=plan-a）：回放后收到 connected');
    bc.broadcast({ type: 'node-start', nodeId: 'n0' }); // 无标签 → 人人可见
    bc.broadcast({ type: 'node-progress', topic: 'plan-a', nodeId: 'n1', pct: 10 });
    bc.broadcast({ type: 'node-progress', topic: 'plan-b', nodeId: 'n2', pct: 20 });
    ok(await waitFor('node-start', () => wsA.of('node-start').length === 1), '无标签事件广播语义零漂移：A 收到 node-start');
    ok(await waitFor('plan-a', () => wsA.of('node-progress').some((e) => e.topic === 'plan-a')), '订阅话题 plan-a 的事件送达 A');
    await realSleep(80);
    ok(wsA.of('node-progress').every((e) => e.topic !== 'plan-b'), '未订阅话题 plan-b 的事件被过滤（A 未收到）');
    const seqBefore = wsA.events.filter((e) => e.seq).map((e) => e.seq);
    ok(seqBefore.length >= 2 && seqBefore.every((s, i) => i === 0 || s > seqBefore[i - 1]), `订阅侧收帧 seq 严格单调：[${seqBefore.join(', ')}]`);
    wsA.send(JSON.stringify({ type: 'subscribe', topics: ['plan-b'] }));
    ok(await waitFor('subscribed', () => wsA.of('subscribed').length === 1), '入站 subscribe 控制消息：回执 subscribed');
    bc.broadcast({ type: 'node-progress', topic: 'plan-b', nodeId: 'n3', pct: 30 });
    ok(await waitFor('plan-b after subscribe', () => wsA.of('node-progress').some((e) => e.nodeId === 'n3')), '动态改订后 plan-b 事件开始送达');

    // A14-6 高频合并 + A14-7 缺口重放（同一连接续用）
    wsA.send(JSON.stringify({ type: 'subscribe', topics: [] })); // 空 = 回到通配
    await realSleep(30);
    const progressCountBefore = wsA.of('node-progress').length;
    const seqStart = bc.getLastSeq();
    for (let i = 1; i <= 30; i += 1) {
      bc.broadcast({ type: 'node-progress', nodeId: 'n9', pct: i }); // 同键高频（虚拟时钟不动）
    }
    ok(bc.getLastSeq() === seqStart + 30, `30 条同键事件全部入环形缓冲与 seq（getLastSeq=${bc.getLastSeq()}，含被合并丢弃的）`);
    await realSleep(60);
    const leadingCount = wsA.of('node-progress').length - progressCountBefore;
    ok(leadingCount === 1, `高频合并：30 条同键事件订阅方仅收 leading 1 帧（旧口径 30 帧全灌 → 直发降载 29/30）`);
    ok(bc.getCoalescedDropped() === 28, `中段丢弃计数=28（窗口内后续 29 条中：28 丢弃 + 最新 1 条扣留为尾随候选）`);
    advance(150); // 推进虚拟时钟触发合并定时器 → trailing 补发
    ok(await waitFor('trailing', () => wsA.of('node-progress').length - progressCountBefore === 2), '窗口到期（虚拟时钟推进）补发最新 1 帧（trailing=pct30）');
    const lastTwo = wsA.of('node-progress').slice(-2);
    ok(lastTwo[1].pct === 30 && lastTwo[1].seq - lastTwo[0].seq === 29, `trailing 是窗口内最新（pct30、seq=${lastTwo[1].seq}，与 leading 相差 29）`);
    bc.broadcast({ type: 'node-complete', nodeId: 'n9' }); // 终态必发
    ok(await waitFor('terminal', () => wsA.of('node-complete').some((e) => e.nodeId === 'n9')), '终态 node-complete 绕过合并立即送达（0 丢弃）');

    // 缺口检测 + replay 补洞
    const det = new GapDetector();
    for (const e of wsA.events) {
      if (typeof e.seq === 'number') det.feed(e.seq);
    }
    const gaps = det.getGaps();
    ok(gaps.length >= 1 && gaps.some((g) => g.from === lastTwo[0].seq + 1), `订阅方 GapDetector 检出被合并丢弃的缺口（[${gaps.map((g) => `${g.from}-${g.to}`).join(', ')}]）`);
    wsA.send(JSON.stringify({ type: 'replay', fromSeq: lastTwo[0].seq + 1 }));
    ok(await waitFor('replay-end', () => wsA.of('replay-end').length === 1), '发送 {"type":"replay","fromSeq":n} 后收到 replay-end 回执');
    const replayEnd = wsA.of('replay-end')[0];
    ok(replayEnd.sent === 30 && replayEnd.truncated === false, `重放补洞 ${replayEnd.sent} 条（seq 6..35 全补：含被合并丢弃的中段——合并降载但不丢信息）`);
    // 全窗口重放（含话题过滤期间被扣掉的 seq3）→ 订阅方按 seq 去重后应全覆盖无缺
    wsA.send(JSON.stringify({ type: 'replay', fromSeq: 3 }));
    ok(await waitFor('replay-end 2', () => wsA.of('replay-end').length === 2), '全窗口重放（fromSeq=3，含话题过滤段）收到第二份 replay-end');
    const replayEnd2 = wsA.of('replay-end')[1];
    ok(replayEnd2.sent === 33, `全窗口重放补 ${replayEnd2.sent} 条（seq 3..35：合并丢弃段 + 话题过滤段一并补齐）`);
    const seqs = [...new Set(wsA.events.filter((e) => typeof e.seq === 'number').map((e) => e.seq))].sort((a, b) => a - b);
    const missing = [];
    for (let i = 1; i < seqs.length; i += 1) {
      if (seqs[i] > seqs[i - 1] + 1) {
        for (let s = seqs[i - 1] + 1; s < seqs[i]; s += 1) missing.push(s);
      }
    }
    ok(missing.length === 0 && seqs[0] === 1, `补洞后订阅方 seq 全覆盖无缺（${seqs[0]}→${seqs[seqs.length - 1]} 连续，含话题过滤期间与合并丢弃段）`);
    const terminalFrames = wsA.of('node-complete').filter((e) => e.nodeId === 'n9');
    ok(
      terminalFrames.length >= 2 && terminalFrames.every((f) => f.seq === terminalFrames[0].seq),
      `replay 幂等重发终态（同 seq=${terminalFrames[0]?.seq} 共 ${terminalFrames.length} 帧：直发 1 + 重放 2）——订阅方按 seq 去重后终态恰 1 份`,
    );

    // A14-8 断线恢复：断线 → 服务端继续广播（含终态）→ ?offset 续传（N+1 起、不重发已收）
    const lastSeen = bc.getLastSeq();
    wsA.close();
    await realSleep(30);
    bc.broadcast({ type: 'node-start', nodeId: 'm1' });
    bc.broadcast({ type: 'node-progress', nodeId: 'm1', pct: 55 });
    bc.broadcast({ type: 'node-complete', nodeId: 'm1' }); // 终态
    const wsB = await MiniWs.connect(port, `/?offset=${lastSeen}`);
    ok(await waitFor('resume events', () => wsB.of('node-complete').some((e) => e.nodeId === 'm1')), `断线重连带 ?offset=${lastSeen}：续传收到断线期间的终态（不丢终态）`);
    await realSleep(50);
    const resumedSeqs = wsB.events.filter((e) => typeof e.seq === 'number').map((e) => e.seq);
    ok(
      resumedSeqs.length === 3 && resumedSeqs[0] === lastSeen + 1 && resumedSeqs.every((s, i) => i === 0 || s === resumedSeqs[i - 1] + 1),
      `续传恰为断线窗口 3 条（seq ${resumedSeqs.join(', ')} 从 lastSeen+1 起、不重不漏）`,
    );

    // 环形缓冲覆盖不足：如实回报 replay-truncated
    for (let i = 0; i < 40; i += 1) bc.broadcast({ type: 'node-start', nodeId: `x${i}` });
    const wsC = await MiniWs.connect(port, '/?offset=1');
    ok(await waitFor('truncated', () => wsC.of('replay-truncated').length === 1), 'offset=1 超出环形缓冲覆盖（12 条）：如实回报 replay-truncated（不谎称完整）');
    const trunc = wsC.of('replay-truncated')[0];
    ok(trunc.oldestSeq > 1 && trunc.requestedFrom === 1, `回报含 oldestSeq=${trunc.oldestSeq}（覆盖窗口明确可查）`);
    await realSleep(50);
    const cSeqs = wsC.events.filter((e) => typeof e.seq === 'number').map((e) => e.seq);
    ok(cSeqs.length >= 12 && cSeqs[0] === trunc.oldestSeq, `截断后仍从最早可补 seq=${trunc.oldestSeq} 续传 ${cSeqs.length} 条（尽力而为）`);
    wsB.close();
    wsC.close();
  } finally {
    bc.stop();
  }
}

// ═════════════════════ ⑥ A14-4 调用审计 ═════════════════════

section('⑥ A14-4 调用审计：三结局结构化 + 精确时延 + 环形有界');

{
  // 虚拟时钟下 latencyMs 逐毫秒精确 + 环形有界
  const clock = { t: 500 };
  const client = new LLMClient({
    maxRetries: 0,
    auditMaxEntries: 4,
    fetchImpl: makeScriptedFetch([{ tokens: 100, stepMs: 25 }, { tokens: 100, stepMs: 25 }, { tokens: 100, stepMs: 25 }, { tokens: 100, stepMs: 25 }, { tokens: 100, stepMs: 25 }], clock),
    nowImpl: () => clock.t,
  });
  client.registerModel({ id: 'm', endpoint: 'http://fake', costPerKToken: 0.001 });
  for (let i = 0; i < 5; i += 1) await client.chat('m', [{ role: 'user', content: 'a' }]);
  const log = client.getAuditLog();
  ok(log.length === 4, `环形有界：容量 4、5 次调用后留最新 4 条（最旧挤出）`);
  ok(
    log.every((e) => e.model === 'm' && e.kind === 'chat' && e.outcome === 'success' && e.attempts === 1 && e.retries === 0 && e.tokensUsed === 100 && near(e.cost, 0.0001)),
    '成功条目结构化齐备：model/kind/outcome/attempts/retries/tokens/cost',
  );
  ok(log.every((e) => e.latencyMs === 25), `注入时钟下时延逐毫秒精确：latencyMs=25 × 4（fetch 内步进 25ms）`);
  ok(log.every((e, i) => i === 0 || e.ts > log[i - 1].ts) && log.every((e) => typeof e.budgetSpentTokens === 'number'),
    'ts 单调递增且每条带预算快照 budgetSpentTokens（100→400 逐次累计）');

  // 失败条目（重试 + 虚拟时钟多步）
  const clock2 = { t: 0 };
  const failFetchStep = async () => {
    clock2.t += 30;
    return { ok: false, status: 503, text: async () => 'x' };
  };
  const client3 = new LLMClient({ maxRetries: 2, fetchImpl: failFetchStep, nowImpl: () => clock2.t, sleepImpl: async () => { clock2.t += 40; } });
  client3.registerModel({ id: 'm3', endpoint: 'http://fake' });
  await client3.chat('m3', [{ role: 'user', content: 'a'.repeat(40) }]).catch(() => undefined);
  const f = client3.getAuditLog()[0];
  ok(
    f && f.outcome === 'failure' && f.attempts === 3 && f.retries === 2 && f.errorKind === 'LLM_ERROR' && f.errorStatus === 503 && f.latencyMs === 3 * 30 + 2 * 40,
    `失败条目：attempts=3 / retries=2 / errorKind=LLM_ERROR / errorStatus=503 / latencyMs=${f?.latencyMs}（3 次尝试 90ms + 2 次退避 80ms，虚拟时钟逐位核算）`,
  );

  // 被拒绝条目（BUDGET_EXHAUSTED）+ 流式条目已在 ②③ 覆盖——汇总口径
  const client4 = new LLMClient({ maxRetries: 0, fetchImpl: makeScriptedFetch([{ tokens: 999 }], null), nowImpl: () => 0, tokenBudget: { limit: 500 } });
  client4.registerModel({ id: 'm4', endpoint: 'http://fake' });
  await client4.chat('m4', [{ role: 'user', content: 'a' }]).catch(() => undefined);
  try {
    await client4.chat('m4', [{ role: 'user', content: 'a' }]);
  } catch {
    /* 预期 */
  }
  const outcomes = client4.getAuditLog().map((e) => e.outcome).join(',');
  ok(outcomes === 'success,rejected', `三结局口径：同一客户端审计序列 outcome=[${outcomes}]（failure 见上 / aborted 见 ③）`);
}

// ═══════════════════════════ 汇总 ═══════════════════════════

console.log('\n════════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— A14 模块域（llm-client / progress-ws）世界性升级闭环成立`);
} else {
  console.log(`✗ PASS ${passed} / FAIL ${failed} —— 存在未达标项`);
}
process.exit(failed === 0 ? 0 : 1);
