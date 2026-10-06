/**
 * verify-r4-client.mjs — 第四轮模块域 R4-A14 升级：llm-client / progress-ws 全新维度验证
 *
 * 五项全新维度各配「旧行为 vs 新行为」的构造对照（不是「改了」，是「证明更好」），
 * 全部经注入 fake transport / 注入时钟 / 注入虚拟定时器驱动，零真外网、零墙钟依赖
 * （WS 集成仅走 127.0.0.1 环回）：
 *
 *   ⓪ 零漂移总检：全部 R4 面 opt-in 缺省——无账本时 reconcile()=undefined、
 *      未探测模型 capabilities 键不出现、未启用 priorityQueue 时优先级被忽略
 *      （纯 FIFO 逐位保持）、无中断时 chatStreamResumable 与 chatStream 同构、
 *      ProgressBroadcaster 无提供器时 ?snapshot=1 如实回报 snapshot-unavailable
 *      且 getSnapshotServedCount()=0、普通连接（不带 ?snapshot）行为不变。
 *   ① R4-1 模型能力探测：全能 / 残缺 / 半能三假模型（请求感知 fake fetch）——
 *      全能 3/3 位全真；残缺 0/3 且失败项带原因（HTTP 400 拒绝 tools、暗号
 *      未召回、JSON 不符——探测失败的能力一律 false 不虚标）；半能位分化
 *      {structuredOutput:true, toolCalling:false, longContext:false}；
 *      selectModelsByCapabilities 按位过滤（未探测模型不入选=能力未知≠具备）；
 *      statuses.capabilities 仅探测后出现。
 *   ② R4-2 请求优先级队列：并发 1 + 手动门控 fetch——混合优先级流
 *      到达序 [B(0), C(9), D(5), E(0)] → 出队序 A→C→D→B→E（高优先先出、
 *      同优先 FIFO：B 先于 E）；旧 FIFO 口径同场景出队序 A→B→C→D→E
 *      （零漂移对照）；抢占计数 2 vs 0；排队超时（虚拟定时器推进 300ms）
 *      诚实拒绝 QUEUE_TIMEOUT（waitedMs=300 逐毫秒精确、审计 rejected/
 *      QUEUE_TIMEOUT、槽位不被虚耗——后续 C 照常继承）；队列满 429 保持。
 *   ③ R4-3 流式中断续传：接缝纯函数三分支（clean / overlap-trimmed /
 *      restart）；集成——流中断后续传请求携带前缀全文（assistant 消息
 *      逐位相等）+ 末尾 32 字符指令口径；重叠接缝剥离（seamTrimmed=4，
 *      全文逐位一致）；续传被协议拒绝（HTTP 400）→ 诚实回退全量重试
 *      （restart 标记块显式告知重置，净内容=全文，绝不静默重复交付）；
 *      模型无视前缀从头重写 → 接缝检出 restart → 同样诚实回退；
 *      零交付失败直接上抛（不伪装恢复）；重传量对照：续传净增 8 字符
 *      vs 全量重试 20 字符（-60%）。
 *   ④ R4-4 广播快照 API：快照提供器 + ?snapshot=1 —— 新订阅者先拿快照
 *      （snapshotSeq=捕获点全局序号、state=捕获点全量状态），随后实时
 *      增量流 seq=snapshotSeq+1..N 恰好一次（GapDetector 零缺口零重复，
 *      终态不丢）；控制消息 {"type":"snapshot"} 按需快照 + snapshot-end
 *      回执（sent=0：捕获即最新，无竞缝——原子性可观测）；快照绕过话题
 *      过滤（连接级状态视图）而增量流尊重话题订阅；不带 ?snapshot 的
 *      连接零漂移。
 *   ⑤ R4-5 成本对账（加分项）：账本流（2 模型 × 3 任务类型 × 3 时段桶）
 *      聚合逐分不差；四路交叉核对（账本↔硬预算账户 / 账本↔模型统计 /
 *      重定价 / 内部↔外部账单）全 ok；注入外部账单差异 → internal-vs-
 *      external mismatch + 告警（Δtoken 精确）；价目表演化（重注册涨价）→
 *      repricing mismatch + 成本漂移告警；周期自动对账（虚拟定时器推进）
 *      按期回调 onReconciliation；未启用账本 reconcile()=undefined（旧口径
 *      静默无对账 vs 新口径四路核对）。
 *
 * 运行：npm run build && node scripts/verify-r4-client.mjs
 */

import net from 'node:net';
import crypto from 'node:crypto';
import {
  LLMClient,
  ProgressBroadcaster,
  GapDetector,
  joinContinuationSeam,
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
async function waitFor(desc, cond, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await realSleep(10);
  }
  return cond();
}

// ─────────────────────── 注入基础设施 ───────────────────────

/** 虚拟定时器（R4-2 排队超时 / R4-5 周期对账共用；零真定时器） */
function makeVirtualTimers(clock) {
  const timers = new Map();
  let id = 0;
  const setTimer = (cb, ms) => {
    const h = ++id;
    timers.set(h, { cb, at: clock.t + ms });
    return h;
  };
  const clearTimer = (h) => timers.delete(h);
  const advance = (ms) => {
    const target = clock.t + ms;
    for (;;) {
      let next = null;
      for (const [h, t] of timers) {
        if (t.at <= target && (next === null || t.at < next.at)) next = { h, ...t };
      }
      if (!next) break;
      timers.delete(next.h);
      clock.t = Math.max(clock.t, next.at);
      next.cb();
    }
    clock.t = target;
  };
  return { setTimer, clearTimer, advance, size: () => timers.size };
}

/** 手动门控 fetch：并发 1 场景下逐个放行，记录开始序（优先级出队序的可观测面） */
function makeGatedFetch(clock) {
  const gate = { startOrder: [], pending: null };
  const fetchImpl = async (_url, init) => {
    const label = JSON.parse(init.body).messages.at(-1).content;
    gate.startOrder.push(label);
    await new Promise((resolve) => {
      gate.pending = resolve;
    });
    clock.t += 5;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'm',
        choices: [{ message: { content: label } }],
        usage: { total_tokens: 7 },
      }),
    };
  };
  return { gate, fetchImpl };
}

/** SSE 脚本化 fake：按调用次序执行脚本；breakAfter=在交付该行数后 read() 抛错 */
function makeScriptedSseFetch(script, capture, clock) {
  const enc = new TextEncoder();
  let callIdx = 0;
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const plan = script[Math.min(callIdx, script.length - 1)];
    callIdx += 1;
    if (capture) capture.push(body);
    if (clock && plan.stepMs) clock.t += plan.stepMs;
    if (plan.reject) {
      return { ok: false, status: plan.status ?? 400, text: async () => plan.text ?? 'rejected' };
    }
    const lines = [
      ...plan.deltas.map((d) => `data: ${JSON.stringify({ model: 'm', choices: [{ delta: { content: d } }] })}\n\n`),
      `data: ${JSON.stringify({ model: 'm', choices: [{ delta: { content: '' } }], usage: plan.usage ?? { prompt_tokens: 9, completion_tokens: 9, total_tokens: 18 } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    let i = 0;
    const body_ = {
      getReader() {
        return {
          async read() {
            if (plan.breakAfter !== undefined && i === plan.breakAfter) {
              throw new Error('connection reset mid-stream');
            }
            if (i >= lines.length) return { done: true, value: undefined };
            return { done: false, value: enc.encode(lines[i++]) };
          },
          async cancel() {},
        };
      },
    };
    return { ok: true, status: 200, body: body_ };
  };
}

/** 能力探测 fake fetch：按端点（模型）路由人格，按请求特征应答 */
function makeProbeFetch(personaOf, clock) {
  return async (url, init) => {
    const persona = personaOf(url);
    const body = JSON.parse(init.body);
    clock.t += 10;
    const json = (content, extra = {}) => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'm',
        choices: [{ message: { content, ...extra } }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }),
    });
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      if (persona.tools === 'reject') return { ok: false, status: 400, text: async () => 'tools parameter not supported' };
      if (persona.tools === 'ok') {
        return json('', {
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'probe_tool', arguments: '{"x":42}' } }],
        });
      }
      return json('I cannot use tools, here is prose instead.');
    }
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    if (lastUser.includes('secret codeword')) {
      return json(persona.longContext ? 'DSH-PROBE-CODEWORD-7Q4Z9' : '抱歉，我不记得段落内容。');
    }
    if (lastUser.includes('Reply with ONLY this exact JSON')) {
      return json(persona.structured ? '{"probe":"structured-output","values":[1,2,3]}' : '好的，这是您要的 JSON……大概吧。');
    }
    return json('ok');
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
      const timer = setTimeout(() => reject(new Error('ws handshake timeout')), 3000);
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
  of(type) {
    return this.events.filter((e) => e.type === type);
  }
}

// ═══════════════════════════ ⓪ 零漂移总检 ═══════════════════════════

section('⓪ 零漂移总检：全部 R4 面 opt-in，缺省行为与升级前同构');

{
  // LLMClient 缺省：无账本 / 无能力位 / 优先级被忽略 / 无中断时续传流同构
  const clock = { t: 0 };
  const client = new LLMClient({ fetchImpl: makeGatedFetch(clock).fetchImpl, nowImpl: () => clock.t });
  client.registerModel({ id: 'm', endpoint: 'http://fake' });
  ok(client.reconcile() === undefined, '缺省无账本：reconcile()=undefined（无账可对，诚实——旧口径静默）');
  ok(client.getModelCapabilities('m') === undefined, '缺省未探测：getModelCapabilities=undefined（不猜测）');
  ok(!('capabilities' in client.getModelStatuses()[0]), '缺省 statuses：capabilities 键不出现（零漂移）');
  ok(client.getQueueMetrics().length === 1 && client.getQueueMetrics()[0].priorityPreemptions === 0,
    '缺省排队指标：priorityPreemptions=0（纯 FIFO 读数如实）');

  const deltas = ['ABCD', 'EFGH', 'IJKL', 'MNOP', 'QRST'];
  const fullText = deltas.join('');
  const clientA = new LLMClient({ fetchImpl: makeScriptedSseFetch([{ deltas }], null, clock), nowImpl: () => clock.t });
  clientA.registerModel({ id: 'm', endpoint: 'http://fake' });
  const plainChunks = [];
  for await (const c of clientA.chatStream('m', [{ role: 'user', content: 'q' }])) plainChunks.push(c);
  const clientB = new LLMClient({ fetchImpl: makeScriptedSseFetch([{ deltas }], null, clock), nowImpl: () => clock.t });
  clientB.registerModel({ id: 'm', endpoint: 'http://fake' });
  const resumableChunks = [];
  const gen = clientB.chatStreamResumable('m', [{ role: 'user', content: 'q' }]);
  for (;;) {
    const r = await gen.next();
    if (r.done) {
      var resumeResult = r.value;
      break;
    }
    resumableChunks.push(r.value);
  }
  ok(
    resumableChunks.every((c) => c.phase === 'initial') &&
      resumeResult.resumes === 0 &&
      resumeResult.restarts === 0 &&
      resumeResult.finalPhase === 'initial' &&
      resumeResult.content === plainChunks.map((c) => c.delta).join('') &&
      resumeResult.content === fullText,
    '无中断时 chatStreamResumable 与 chatStream 同构（phase=initial、resumes=0、内容逐位一致）',
  );

  const bc = new ProgressBroadcaster(0);
  bc.start();
  try {
    const port = bc.getPort();
    const ws = await MiniWs.connect(port, '/?snapshot=1');
    ok(await waitFor('unavailable', () => ws.of('snapshot-unavailable').length === 1),
      '无快照提供器：?snapshot=1 如实回报 snapshot-unavailable（不谎称有快照）');
    ok(bc.getSnapshotServedCount() === 0, '快照服务计数如实：未成功服务任何快照（=0）');
    ws.close();
    const ws2 = await MiniWs.connect(port, '/');
    await waitFor('connected', () => ws2.of('connected').length === 1);
    bc.broadcast({ type: 'node-start', nodeId: 'z' });
    ok(await waitFor('plain', () => ws2.of('node-start').some((e) => e.nodeId === 'z')),
      '普通连接（不带 ?snapshot）行为零漂移：正常回放 + 实时事件');
    ws2.close();
  } finally {
    bc.stop();
  }
}

// ═════════════════════ ① R4-1 模型能力探测 ═════════════════════

section('① R4-1 模型能力探测：全能/残缺/半能分化 + 失败不虚标 + 调度消费');

{
  const clock = { t: 0 };
  const personaOf = (url) => {
    if (url.includes('full')) return { structured: true, longContext: true, tools: 'ok' };
    if (url.includes('broken')) return { structured: false, longContext: false, tools: 'reject' };
    if (url.includes('partial')) return { structured: true, longContext: false, tools: 'ignore' };
    return { structured: false, longContext: false, tools: 'ignore' }; // 从不探测
  };
  const client = new LLMClient({ fetchImpl: makeProbeFetch(personaOf, clock), nowImpl: () => clock.t });
  client.registerModel({ id: 'full-model', endpoint: 'http://full', costPerKToken: 0.001 });
  client.registerModel({ id: 'broken-model', endpoint: 'http://broken' });
  client.registerModel({ id: 'partial-model', endpoint: 'http://partial' });
  client.registerModel({ id: 'unprobed-model', endpoint: 'http://unprobed' });

  const full = await client.probeModel('full-model');
  ok(
    full.passedCount === 3 && full.totalCount === 3 &&
      full.capabilities.longContext === true && full.capabilities.toolCalling === true && full.capabilities.structuredOutput === true,
    `全能假模型：3/3 探测全过，能力位 {longContext,toolCalling,structuredOutput} 全真（durationMs=${full.durationMs}）`,
  );
  ok(full.probes.every((p) => p.passed && p.detail.length > 0), '全能模型每项探测携带判定依据（detail 非空）');

  const broken = await client.probeModel('broken-model');
  const brokenTool = broken.probes.find((p) => p.id === 'tool-calling');
  const brokenLong = broken.probes.find((p) => p.id === 'long-context');
  const brokenJson = broken.probes.find((p) => p.id === 'structured-output');
  ok(
    broken.passedCount === 0 &&
      broken.capabilities.longContext === false && broken.capabilities.toolCalling === false && broken.capabilities.structuredOutput === false,
    `残缺假模型：0/3 探测全败，能力位全 false（不虚标）`,
  );
  ok(
    brokenTool.passed === false && /400/.test(brokenTool.detail) && /不虚标/.test(brokenTool.detail),
    `工具探测被端点拒绝（HTTP 400）→ 不虚标（detail="${brokenTool.detail}"）`,
  );
  ok(brokenLong.passed === false && /暗号未召回/.test(brokenLong.detail), `长上下文暗号未召回 → 不虚标（detail 含原因）`);
  ok(brokenJson.passed === false && /字段不符|不可解析/.test(brokenJson.detail), `结构化输出特征不符 → 不虚标`);

  const partial = await client.probeModel('partial-model');
  ok(
    partial.capabilities.structuredOutput === true &&
      partial.capabilities.toolCalling === false &&
      partial.capabilities.longContext === false &&
      partial.passedCount === 1,
    `半能假模型位分化：{structuredOutput:true, toolCalling:false, longContext:false}（1/3）`,
  );

  // 探测调用与常规调用同口径（审计/入账）；能力位进入 statuses 供调度消费
  const statuses = client.getModelStatuses();
  const st = Object.fromEntries(statuses.map((s) => [s.id, s]));
  ok(st['full-model'].capabilities && st['full-model'].capabilities.toolCalling === true, 'statuses.capabilities 探测后出现（调度消费面）');
  ok(!('capabilities' in st['unprobed-model']), '未探测模型的 statuses 无 capabilities 键（零漂移）');
  ok(client.getModelCapabilities('partial-model').structuredOutput === true, 'getModelCapabilities 缓存可查（重探测前持久）');
  ok(
    JSON.stringify(client.selectModelsByCapabilities({})) === JSON.stringify(['full-model', 'broken-model', 'partial-model']),
    'selectModelsByCapabilities({})：全部已探测模型入选',
  );
  ok(
    JSON.stringify(client.selectModelsByCapabilities({ structuredOutput: true })) === JSON.stringify(['full-model', 'partial-model']),
    '按 structuredOutput=true 过滤：[full-model, partial-model]（broken 被淘汰）',
  );
  ok(
    JSON.stringify(client.selectModelsByCapabilities({ structuredOutput: true, toolCalling: true })) === JSON.stringify(['full-model']),
    '按多能力位过滤（AND）：仅 full-model 同时具备结构化输出 + 工具调用',
  );
  ok(
    !client.selectModelsByCapabilities({ longContext: true }).includes('unprobed-model'),
    '未探测模型不入选（能力未知 ≠ 具备——调度侧不冒险）',
  );
  const probeAudits = client.getAuditLog().filter((a) => a.model === 'full-model');
  ok(probeAudits.length === 3 && probeAudits.every((a) => a.outcome === 'success'),
    `探测调用与常规调用同口径：full-model 3 次探测全部入审计（token 如实入账 ${client.getTokenAccount().spentTokens}）`);
}

// ═════════════════════ ② R4-2 请求优先级队列 ═════════════════════

section('② R4-2 优先级队列：出队序 / 抢占 / 排队超时诚实 / 零漂移对照');

{
  // a) 优先级出队序 + 抢占计数（新口径）
  const clock = { t: 0 };
  const { gate, fetchImpl } = makeGatedFetch(clock);
  const client = new LLMClient({
    fetchImpl,
    nowImpl: () => clock.t,
    priorityQueue: {},
    defaultMaxConcurrency: 1,
    maxRetries: 0,
  });
  client.registerModel({ id: 'm', endpoint: 'http://fake', maxConcurrency: 1 });
  const calls = {
    A: client.chat('m', [{ role: 'user', content: 'A' }]).catch((e) => `ERR:${e.message}`),
    B: client.chat('m', [{ role: 'user', content: 'B' }], { priority: 0 }).catch((e) => `ERR:${e.message}`),
    C: client.chat('m', [{ role: 'user', content: 'C' }], { priority: 9 }).catch((e) => `ERR:${e.message}`),
    D: client.chat('m', [{ role: 'user', content: 'D' }], { priority: 5 }).catch((e) => `ERR:${e.message}`),
    E: client.chat('m', [{ role: 'user', content: 'E' }], { priority: 0 }).catch((e) => `ERR:${e.message}`),
  };
  await waitFor('A start', () => gate.startOrder.length >= 1);
  for (let i = 1; i <= 4; i += 1) {
    gate.pending(); // 放行当前占用者 → 槽位按优先级继承
    await waitFor(`start #${i + 1}`, () => gate.startOrder.length >= i + 1);
    await realSleep(5);
  }
  gate.pending();
  await Promise.allSettled(Object.values(calls));
  ok(
    JSON.stringify(gate.startOrder) === JSON.stringify(['A', 'C', 'D', 'B', 'E']),
    `新口径出队序 A→C(9)→D(5)→B(0)→E(0)：高优先先出、同优先 FIFO（B 先于 E）`,
  );
  const m = client.getQueueMetrics().find((x) => x.model === 'm');
  ok(m.priorityPreemptions === 2 && m.queueTimeouts === 0 && m.waiting === 0,
    `低优先未开始槽位被高优先抢占 2 次（C、D 各一次），排队队列清零`);

  // b) 旧口径对照（未启用 priorityQueue：优先级被忽略，纯 FIFO——零漂移）
  const clock2 = { t: 0 };
  const legacy = makeGatedFetch(clock2);
  const client2 = new LLMClient({ fetchImpl: legacy.fetchImpl, nowImpl: () => clock2.t, defaultMaxConcurrency: 1, maxRetries: 0 });
  client2.registerModel({ id: 'm', endpoint: 'http://fake', maxConcurrency: 1 });
  const launches = [
    client2.chat('m', [{ role: 'user', content: 'A' }]).catch(() => 'ERR'),
    client2.chat('m', [{ role: 'user', content: 'B' }], { priority: 0 }).catch(() => 'ERR'),
    client2.chat('m', [{ role: 'user', content: 'C' }], { priority: 9 }).catch(() => 'ERR'),
  ];
  await waitFor('legacy A', () => legacy.gate.startOrder.length >= 1);
  for (let i = 1; i <= 2; i += 1) {
    legacy.gate.pending();
    await waitFor(`legacy #${i + 1}`, () => legacy.gate.startOrder.length >= i + 1);
    await realSleep(5);
  }
  legacy.gate.pending();
  await Promise.allSettled(launches);
  ok(
    JSON.stringify(legacy.gate.startOrder) === JSON.stringify(['A', 'B', 'C']),
    `旧口径零漂移对照：同场景（C 带 priority=9）出队序仍 A→B→C 纯 FIFO——优先级仅在 opt-in 后生效`,
  );
  ok(client2.getQueueMetrics()[0].priorityPreemptions === 0, '旧口径抢占计数=0');

  // c) 排队超时：虚拟定时器精确推进，诚实拒绝且不虚耗槽位
  const clock3 = { t: 100 };
  const vt = makeVirtualTimers(clock3);
  const gated3 = makeGatedFetch(clock3);
  const client3 = new LLMClient({
    fetchImpl: gated3.fetchImpl,
    nowImpl: () => clock3.t,
    setTimerImpl: vt.setTimer,
    clearTimerImpl: vt.clearTimer,
    priorityQueue: {},
    defaultMaxConcurrency: 1,
    maxRetries: 0,
  });
  client3.registerModel({ id: 'm', endpoint: 'http://fake', maxConcurrency: 1 });
  const callA = client3.chat('m', [{ role: 'user', content: 'A' }]).catch((e) => e);
  await waitFor('timeout A start', () => gated3.gate.startOrder.includes('A'));
  const callB = client3.chat('m', [{ role: 'user', content: 'B' }], { queueTimeoutMs: 300 }).catch((e) => e);
  const callC = client3.chat('m', [{ role: 'user', content: 'C' }], { priority: 5 }).catch((e) => e);
  await realSleep(10); // B、C 已入队（到达序 B→C）
  clock3.t += 300; // 虚拟时间推进 300ms（排队计时到期）
  const timersFired = vt.size();
  vt.advance(0); // 触发已到期定时器
  const errB = await callB;
  ok(
    errB instanceof Error && errB.details?.code === 'QUEUE_TIMEOUT' && errB.details?.waitedMs === 300 && errB.details?.priority === 0,
    `排队超时诚实拒绝：B 等待恰 300ms（虚拟时钟逐毫秒）→ QUEUE_TIMEOUT（waitedMs=300 如实上报）`,
  );
  gated3.gate.pending(); // A 完成 → 槽位应继承给 C（B 的超时未虚耗槽位）
  await waitFor('timeout C start', () => gated3.gate.startOrder.includes('C'));
  gated3.gate.pending(); // 放行 C
  const respC = await callC;
  await callA;
  ok(respC.content === 'C' && gated3.gate.startOrder.join('') === 'AC',
    `超时者不虚耗槽位：B 被拒后槽位由 C 正常继承（实际开始序 ${gated3.gate.startOrder.join('→')}）`);
  const timeoutAudits = client3.getAuditLog().filter((a) => a.errorKind === 'QUEUE_TIMEOUT');
  ok(
    timeoutAudits.length === 1 && timeoutAudits[0].outcome === 'rejected' && timeoutAudits[0].latencyMs === 300 && timeoutAudits[0].tokensUsed === 0,
    '超时拒绝入审计：outcome=rejected / QUEUE_TIMEOUT / latencyMs=300（排队等待时长，不含服务时长）',
  );
  ok(client3.getQueueMetrics()[0].queueTimeouts === 1, 'queueTimeouts 计数=1（读数与审计一致）');
  ok(timersFired >= 1 && vt.size() === 0, '虚拟定时器全部清算（已出队调用的超时定时器被正确取消，零悬挂）');

  // d) 出队后超时定时器取消：未超时的排队者获得槽位后不会被误杀
  const clock4 = { t: 0 };
  const vt4 = makeVirtualTimers(clock4);
  const gated4 = makeGatedFetch(clock4);
  const client4 = new LLMClient({
    fetchImpl: gated4.fetchImpl,
    nowImpl: () => clock4.t,
    setTimerImpl: vt4.setTimer,
    clearTimerImpl: vt4.clearTimer,
    priorityQueue: { defaultQueueTimeoutMs: 1000 },
    defaultMaxConcurrency: 1,
    maxRetries: 0,
  });
  client4.registerModel({ id: 'm', endpoint: 'http://fake', maxConcurrency: 1 });
  const pA = client4.chat('m', [{ role: 'user', content: 'A' }]).catch((e) => e);
  await waitFor('d A', () => gated4.gate.startOrder.includes('A'));
  const pB = client4.chat('m', [{ role: 'user', content: 'B' }]).catch((e) => e);
  await realSleep(5);
  gated4.gate.pending(); // A 完成 → B 获槽位（其超时定时器必须被取消）
  await waitFor('d B start', () => gated4.gate.startOrder.includes('B'));
  gated4.gate.pending(); // 放行 B
  const respB = await pB;
  await pA;
  vt4.advance(2000); // 若定时器未取消，此刻 B 已被误杀（respB 会是错误）
  ok(respB.content === 'B' && client4.getQueueMetrics()[0].queueTimeouts === 0,
    '获得槽位即取消排队定时器：B 正常完成（推进 2000ms 后无误杀、queueTimeouts=0）');

  // e) 队列满拒绝在优先级模式下保持（429 口径不变）
  const clock5 = { t: 0 };
  const gated5 = makeGatedFetch(clock5);
  const client5 = new LLMClient({
    fetchImpl: gated5.fetchImpl,
    nowImpl: () => clock5.t,
    priorityQueue: {},
    defaultMaxConcurrency: 1,
    maxQueueSize: 2,
    maxRetries: 0,
  });
  client5.registerModel({ id: 'm', endpoint: 'http://fake', maxConcurrency: 1 });
  const hold = client5.chat('m', [{ role: 'user', content: 'A' }]).catch((e) => e);
  await waitFor('e A', () => gated5.gate.startOrder.includes('A'));
  const q1 = client5.chat('m', [{ role: 'user', content: 'B' }], { priority: 1 }).catch((e) => e);
  const q2 = client5.chat('m', [{ role: 'user', content: 'C' }], { priority: 1 }).catch((e) => e);
  const q3 = client5.chat('m', [{ role: 'user', content: 'D' }], { priority: 9 }).catch((e) => e);
  const errFull = await q3;
  gated5.gate.pending(); // A 完成 → B 继承
  await waitFor('e B start', () => gated5.gate.startOrder.includes('B'));
  gated5.gate.pending(); // B 完成 → C 继承
  await waitFor('e C start', () => gated5.gate.startOrder.includes('C'));
  gated5.gate.pending(); // 放行 C
  await Promise.allSettled([hold, q1, q2]);
  ok(errFull instanceof Error && errFull.status === 429 && /队列已满/.test(errFull.message),
    '优先级模式下队列满仍 429 快速失败（过载保护口径不变）');
}

// ═════════════════════ ③ R4-3 流式中断续传 ═════════════════════

section('③ R4-3 流式中断续传：接缝校验 / 前缀传递 / 诚实回退全量重试');

{
  // a) 接缝纯函数三分支
  ok(
    JSON.stringify(joinContinuationSeam('ABCDEFGHIJKL', 'IJKLMNOP', { seamOverlapMaxChars: 96, restartDetectChars: 32 })) ===
      JSON.stringify({ text: 'MNOP', kind: 'overlap-trimmed', trimmed: 4 }),
    '接缝纯函数 overlap-trimmed：续写开头重复前缀末尾 4 字符 → 剥离后净续写 MNOP',
  );
  ok(
    joinContinuationSeam('ABCDEFGHIJKL', 'QRSTUVWXYZ', { seamOverlapMaxChars: 96, restartDetectChars: 32 }).kind === 'clean',
    '接缝纯函数 clean：无重叠、无重启特征 → 自然衔接（最小检查不做语义判断）',
  );
  const longPrefix = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCD'; // 40 字符（> 检测窗 32）
  ok(
    joinContinuationSeam(longPrefix, longPrefix.slice(0, 32) + '-rest', { seamOverlapMaxChars: 96, restartDetectChars: 32 }).kind === 'restart',
    '接缝纯函数 restart：续写开头=整个前缀开头（模型无视前缀从头重写）→ 检出重启',
  );
  ok(joinContinuationSeam('ABC', '', { seamOverlapMaxChars: 96, restartDetectChars: 32 }).kind === 'clean',
    '空续写 → clean（不误判）');

  const T = 'ABCDEFGHIJKLMNOPQRST'; // 20 字符全文
  const PREFIX = T.slice(0, 12); // 中断点：已收 12 字符

  // b) 续传成功 + 前缀传递正确 + 重叠剥离（旧全量重传 20 字符 → 新净增 8 字符）
  const capture = [];
  const clock = { t: 0 };
  const client = new LLMClient({
    fetchImpl: makeScriptedSseFetch(
      [
        { deltas: ['ABCD', 'EFGH', 'IJKL'], breakAfter: 3 }, // 初次流：交付 3 块后连接中断
        { deltas: ['IJKL', 'MNOP', 'QRST'] }, // 续写：首块重复前缀末尾（重叠接缝）
      ],
      capture,
      clock,
    ),
    nowImpl: () => clock.t,
    maxRetries: 0,
  });
  client.registerModel({ id: 'm', endpoint: 'http://fake' });
  const chunks = [];
  const gen = client.chatStreamResumable('m', [{ role: 'user', content: '写一首诗' }]);
  for (;;) {
    const r = await gen.next();
    if (r.done) {
      var result = r.value;
      break;
    }
    chunks.push(r.value);
  }
  const contReq = capture[1];
  const assistantMsg = contReq.messages.find((m) => m.role === 'assistant');
  const resumeMsg = [...contReq.messages].reverse().find((m) => m.role === 'user' && /interrupted/.test(m.content));
  ok(
    contReq.messages.length === 3 && assistantMsg.content === PREFIX,
    `续传请求携带已接收前缀全文：assistant 消息逐位等于前缀（12 字符，无丢失无篡改）`,
  );
  ok(
    resumeMsg !== undefined && resumeMsg.content.includes(PREFIX.slice(-32)) && /EXACTLY/.test(resumeMsg.content),
    '续写指令含前缀末尾 32 字符原文（接缝口径可被传输层检视验证）',
  );
  const firstCont = chunks.find((c) => c.phase === 'continuation');
  ok(
    firstCont.delta === 'MNOP' && firstCont.seamTrimmed === 4,
    `接缝最小校验生效：续写首块重叠 4 字符被剥离（seamTrimmed=4，消费者拿到净续写）`,
  );
  ok(
    result.content === T && result.resumes === 1 && result.restarts === 0 && result.finalPhase === 'continuation',
    `续传闭环：全文 20 字符逐位一致（前缀 12 + 净续写 8）、resumes=1、finalPhase=continuation`,
  );
  const contChars = capture[1].messages.find((m) => m.role === 'assistant').content.length; // 前缀以上下文携带
  ok(
    chunks.filter((c) => c.phase === 'initial').length === 3 && chunks.filter((c) => c.phase === 'continuation').length === 4,
    `流分段如实：initial 3 块（中断前）+ continuation 4 块（含剥离后的净首块与终帧）`,
  );
  ok(
    contChars === 12 && T.length - PREFIX.length === 8,
    `重传量对照：续传净请求新增 8 字符（前缀 12 字符以消息上下文携带一次）；旧全量重试须重发全部 20 字符（-60%）`,
  );
  // 各段调用如实分别入账（续写不免费）；中断尝试沿用既有 'aborted' 审计口径（不改既有语义）
  const streamAudits = client.getAuditLog().filter((a) => a.kind === 'chat-stream');
  ok(
    streamAudits.length === 2 &&
      streamAudits[0].outcome === 'aborted' && streamAudits[0].streamChunks === 3 && streamAudits[0].tokensUsed > 0 &&
      streamAudits[1].outcome === 'success',
    '中断与续写两次底层调用分别入审计（中断尝试 aborted+3chunk+输入估算入账，续写 success）——恢复的额外成本如实可见',
  );

  // c) 协议不支持续传 → 诚实回退全量重试（restart 标记 + 全文重放，绝不静默重复）
  const capture2 = [];
  const client2 = new LLMClient({
    fetchImpl: makeScriptedSseFetch(
      [
        { deltas: ['ABCD', 'EFGH', 'IJKL'], breakAfter: 3 }, // 初次流中断
        { reject: true, status: 400, text: 'continuation is not supported by this endpoint' }, // 续写被协议拒绝
        { deltas: ['ABCD', 'EFGH', 'IJKL', 'MNOP', 'QRST'] }, // 全量重试成功
      ],
      capture2,
      clock,
    ),
    nowImpl: () => clock.t,
    maxRetries: 0,
  });
  client2.registerModel({ id: 'm', endpoint: 'http://fake' });
  const chunks2 = [];
  const gen2 = client2.chatStreamResumable('m', [{ role: 'user', content: '写一首诗' }]);
  for (;;) {
    const r = await gen2.next();
    if (r.done) {
      var result2 = r.value;
      break;
    }
    chunks2.push(r.value);
  }
  const marker = chunks2.find((c) => c.restart === true);
  ok(
    marker !== undefined && marker.delta === '' && marker.phase === 'restart',
    '不可续传时诚实回退：显式 restart 标记块（delta 空、phase=restart）告知消费者重置',
  );
  const idxMarker = chunks2.indexOf(marker);
  const netText = chunks2.slice(idxMarker).map((c) => c.delta).join('');
  const naiveText = chunks2.map((c) => c.delta).join('');
  ok(
    netText === T && naiveText === PREFIX + T,
    `重置语义下净内容=全文 20 字符恰好一次；无视标记的朴素拼接=${naiveText.length} 字符（前缀+全文重复）——标记是必要且诚实的`,
  );
  ok(
    result2.restarts === 1 && result2.resumes === 1 && result2.finalPhase === 'restart' && result2.content === T,
    `回退统计如实：resumes=1（尝试过续传被 400 拒）+ restarts=1（全量重试）+ finalPhase=restart`,
  );
  ok(
    capture2[1].messages.some((m) => m.role === 'assistant') && !capture2[2].messages.some((m) => m.role === 'assistant'),
    '请求口径分化：第 2 次=续写（带 assistant 前缀，被拒），第 3 次=原样全量重试（无前缀注入）',
  );

  // d) 模型无视前缀从头重写 → 接缝检出 restart → 同样诚实回退
  const client3 = new LLMClient({
    fetchImpl: makeScriptedSseFetch(
      [
        { deltas: ['ABCD', 'EFGH', 'IJKL'], breakAfter: 3 },
        { deltas: ['ABCDEFGHIJKLMNOP', 'QRST'] }, // 续写=从头重写全文（前缀一致性破坏）
        { deltas: ['ABCD', 'EFGH', 'IJKL', 'MNOP', 'QRST'] },
      ],
      null,
      clock,
    ),
    nowImpl: () => clock.t,
    maxRetries: 0,
  });
  client3.registerModel({ id: 'm', endpoint: 'http://fake' });
  const chunks3 = [];
  const gen3 = client3.chatStreamResumable('m', [{ role: 'user', content: '写一首诗' }], {}, { restartDetectChars: 8 });
  for (;;) {
    const r = await gen3.next();
    if (r.done) {
      var result3 = r.value;
      break;
    }
    chunks3.push(r.value);
  }
  const marker3 = chunks3.find((c) => c.restart === true);
  const net3 = chunks3.slice(chunks3.indexOf(marker3)).map((c) => c.delta).join('');
  ok(
    marker3 !== undefined && net3 === T && result3.restarts === 1 && result3.finalPhase === 'restart',
    `模型从头重写被接缝校验检出（restart）→ 诚实回退全量重试，净内容=全文（前缀末尾一致性守恒）`,
  );
  ok(
    !chunks3.some((c) => c.phase === 'continuation' && c.delta.length > 0),
    '重启特征的续写内容零交付（检出即弃——消费者永远看不到自相矛盾的两段全文）',
  );

  // e) 零交付失败 → 直接上抛（不伪装恢复）
  const client4 = new LLMClient({
    fetchImpl: makeScriptedSseFetch([{ reject: true, status: 400, text: 'bad request' }], null, clock),
    nowImpl: () => clock.t,
    maxRetries: 0,
  });
  client4.registerModel({ id: 'm', endpoint: 'http://fake' });
  let threw4 = null;
  const gen4 = client4.chatStreamResumable('m', [{ role: 'user', content: 'q' }]);
  try {
    for (;;) {
      const r = await gen4.next();
      if (r.done) break;
    }
  } catch (err) {
    threw4 = err;
  }
  ok(
    threw4 !== null && /400/.test(threw4.message),
    '零交付即失败：原样上抛 HTTP 400（无前缀可续、不空转重试、不伪装成功）',
  );
}

// ═════════════════════ ④ R4-4 广播快照 API ═════════════════════

section('④ R4-4 广播快照 API：快照 + 增量无缝（无缺无重）');

{
  const vt = { t: 1000 };
  const bc = new ProgressBroadcaster(0, { now: () => vt.t, replayBufferSize: 50 });
  const state = { phase: 'idle', nodes: {} };
  bc.setSnapshotProvider(() => ({ phase: state.phase, nodes: { ...state.nodes } }));
  bc.start();
  const port = bc.getPort();
  try {
    // 造 3 条历史（状态投影随事件演化——宿主语义：先改状态再广播）
    state.nodes.n1 = 'running';
    bc.broadcast({ type: 'node-start', nodeId: 'n1' });
    state.nodes.n1 = 'done';
    bc.broadcast({ type: 'node-complete', nodeId: 'n1' });
    state.nodes.n2 = 'running';
    bc.broadcast({ type: 'node-start', nodeId: 'n2' });

    // 新订阅者：先拿快照（截至 snapshotSeq=3 的全量状态），不回放原始事件
    const ws = await MiniWs.connect(port, '/?snapshot=1');
    ok(await waitFor('snapshot', () => ws.of('snapshot').length === 1), '?snapshot=1 连接：收到快照');
    const snap = ws.of('snapshot')[0];
    ok(
      snap.snapshotSeq === 3 &&
        snap.state.phase === 'idle' &&
        snap.state.nodes.n1 === 'done' &&
        snap.state.nodes.n2 === 'running',
      `快照内容=捕获点全量状态（n1=done、n2=running）且 snapshotSeq=${snap.snapshotSeq}=捕获点全局序号`,
    );
    await waitFor('connected', () => ws.of('connected').length === 1);
    ok(
      ws.events.filter((e) => typeof e.seq === 'number' && e.seq <= 3).length === 0,
      '快照订阅者不回放原始事件（seq 1..3 不重发——状态视图取代事件回放，避免只靠回放重建）',
    );

    // 快照之后进入增量流：seq 4..6 恰好一次、无缺无重、终态不丢
    state.nodes.n2 = 'done';
    bc.broadcast({ type: 'node-complete', nodeId: 'n2' });
    state.nodes.n3 = 'running';
    bc.broadcast({ type: 'node-start', nodeId: 'n3', topic: 'plan-a' });
    state.phase = 'plan-done';
    bc.broadcast({ type: 'plan-complete' }); // 终态
    await waitFor('seq 6', () => ws.events.some((e) => e.seq === 6));
    const seqs = ws.events.filter((e) => typeof e.seq === 'number').map((e) => e.seq);
    const det = new GapDetector();
    for (const s of seqs) det.feed(s);
    ok(
      JSON.stringify(seqs) === JSON.stringify([4, 5, 6]) && det.getGaps().length === 0,
      `快照+增量无缝：增量恰为 [${seqs.join(',')}]（=snapshotSeq+1..6 连续），零缺口零重复`,
    );
    ok(ws.of('plan-complete').length === 1, '终态 plan-complete 恰好一次送达（不缺不重）');

    // 控制消息按需快照：捕获点即最新（原子性——sent=0 佐证无竞缝）
    const ws2 = await MiniWs.connect(port, '/');
    await waitFor('ws2 connected', () => ws2.of('connected').length === 1);
    ws2.send(JSON.stringify({ type: 'snapshot' }));
    ok(await waitFor('snapshot-end', () => ws2.of('snapshot-end').length === 1), '入站 {"type":"snapshot"}：收到快照+回执');
    const end = ws2.of('snapshot-end')[0];
    const snap2 = ws2.of('snapshot')[0];
    ok(
      snap2.snapshotSeq === 6 && end.snapshotSeq === 6 && end.sent === 0 && end.lastSeq === 6,
      `按需快照原子性：snapshotSeq=lastSeq=6、补发 sent=0（状态读取与序号捕获同同步段，无事件竞缝）`,
    );
    ok(
      snap2.state.phase === 'plan-done' && snap2.state.nodes.n3 === 'running',
      '按需快照反映最新全量状态（phase=plan-done）',
    );
    bc.broadcast({ type: 'node-start', nodeId: 'n4' }); // 快照后增量继续无缝
    ok(await waitFor('seq 7', () => ws2.events.some((e) => e.seq === 7)),
      '快照之后的实时增量照常衔接（seq=7 送达）');

    // 快照绕过话题过滤（连接级状态视图），增量流尊重话题订阅
    const ws3 = await MiniWs.connect(port, '/?topics=plan-b&snapshot=1');
    await waitFor('ws3 snapshot', () => ws3.of('snapshot').length === 1);
    ok(ws3.of('snapshot')[0].state !== null && ws3.of('snapshot')[0].snapshotSeq === 7,
      '话题订阅连接仍获全量快照（快照绕过话题过滤——状态视图人人可得）');
    bc.broadcast({ type: 'node-progress', topic: 'plan-a', nodeId: 'n9', pct: 1 });
    bc.broadcast({ type: 'node-progress', topic: 'plan-b', nodeId: 'n8', pct: 2 });
    await waitFor('plan-b', () => ws3.of('node-progress').length === 1);
    await realSleep(80);
    ok(
      ws3.of('node-progress').every((e) => e.topic === 'plan-b'),
      '快照后的增量流尊重话题过滤（plan-a 被滤除、plan-b 送达）',
    );
    const snapCount = bc.getSnapshotServedCount();
    ok(snapCount === 3, `快照服务计数=${snapCount}（?snapshot=1 ×2 + 控制消息 ×1，读数与请求一致）`);
    ws.close();
    ws2.close();
    ws3.close();
  } finally {
    bc.stop();
  }
}

// ═════════════════════ ⑤ R4-5 成本对账（加分项） ═════════════════════

section('⑤ R4-5 成本对账：聚合精确 / 四路交叉核对 / 差异检出 / 周期对账');

{
  const clock = { t: 1000 };
  const vt = makeVirtualTimers(clock);
  const reports = [];
  let fetchStep = 0;
  const steps = [700, 1000, 150, 1070]; // 显式推进 ts 至 1700/2100+1000/…（多时段桶）
  const chatFetch = async () => {
    clock.t += steps[Math.min(fetchStep, steps.length - 1)];
    const i = Math.min(fetchStep, 3);
    fetchStep += 1;
    if (i === 3) return { ok: false, status: 503, text: async () => 'err' };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: i === 1 ? 'm2' : 'm1',
        choices: [{ message: { content: 'x' } }],
        usage: { total_tokens: [1000, 2000][i === 1 ? 1 : 0] },
      }),
    };
  };
  const sseFetch = async () => {
    clock.t += 150; // ts → 2850（第 3 笔：m1 流式成功 500）
    fetchStep = 3; // 流式调用消耗第 3 个脚本位（第 4 位留给失败调用）
    const enc = new TextEncoder();
    const lines = [
      `data: ${JSON.stringify({ model: 'm1', choices: [{ delta: { content: 'hi' } }] })}\n\n`,
      `data: ${JSON.stringify({ model: 'm1', choices: [{ delta: { content: '' } }], usage: { total_tokens: 500 } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              if (i >= lines.length) return { done: true, value: undefined };
              return { done: false, value: enc.encode(lines[i++]) };
            },
            async cancel() {},
          };
        },
      },
    };
  };
  let mode = 'chat';
  const client = new LLMClient({
    fetchImpl: async (url, init) => (mode === 'stream' ? sseFetch() : chatFetch()),
    nowImpl: () => clock.t,
    setTimerImpl: vt.setTimer,
    clearTimerImpl: vt.clearTimer,
    costLedger: { bucketMs: 1000, autoReconcileMs: 5000, onReconciliation: (r) => reports.push(r) },
    maxRetries: 0,
  });
  client.registerModel({ id: 'm1', endpoint: 'http://fake', costPerKToken: 0.002 });
  client.registerModel({ id: 'm2', endpoint: 'http://fake', costPerKToken: 0.001 });

  // 账目流：m1/code 成功 1000；m2/doc 成功 2000；m1/default 流式成功 500；m1/code 失败（400 字符→估算 100）
  await client.chat('m1', [{ role: 'user', content: 'a' }], { taskType: 'code' }); // ts 1700
  await client.chat('m2', [{ role: 'user', content: 'b' }], { taskType: 'doc' }); // ts 2700
  mode = 'stream';
  for await (const c of client.chatStream('m1', [{ role: 'user', content: 'c' }])) void c; // ts 3550? 由 fetch 步进
  mode = 'chat';
  await client.chat('m1', [{ role: 'user', content: 'd'.repeat(400) }], { taskType: 'code' }).catch(() => undefined); // 失败

  const r0 = client.reconcile();
  ok(r0 !== undefined, '账本启用：reconcile() 出报告（对照缺省 undefined——旧口径静默无对账）');
  const byModel = Object.fromEntries(r0.byModel.map((x) => [x.model, x]));
  ok(
    byModel.m1.tokens === 1600 && near(byModel.m1.cost, 0.0032, 1e-12) && byModel.m2.tokens === 2000 && near(byModel.m2.cost, 0.002, 1e-12),
    `按模型聚合逐分不差：m1=1600tok/$0.0032（1000+500 成功 + 100 失败估算）、m2=2000tok/$0.002`,
  );
  const byTask = Object.fromEntries(r0.byTaskType.map((x) => [x.taskType, x]));
  ok(
    byTask.code.tokens === 1100 && byTask.doc.tokens === 2000 && byTask.default.tokens === 500,
    `按任务类型聚合：code=1100（1000 成功+100 失败）、doc=2000、default=500`,
  );
  ok(
    r0.byBucket.length === 3 && r0.byBucket.every((b) => b.bucketStart % 1000 === 0),
    `按时段桶聚合：${r0.byBucket.length} 个桶（ts 1700/2700/2850/3920 跨桶，桶宽 1000ms）`,
  );
  const check = (name) => r0.crossChecks.find((c) => c.name === name);
  ok(
    check('ledger-vs-account').status === 'ok' && check('ledger-vs-account').ledgerValue === 3600,
    `交叉核对 1（账本↔硬预算账户）：3600 token 逐位相等（成功实测+失败估算同源同刻）`,
  );
  ok(check('ledger-vs-model-stats').status === 'ok', '交叉核对 2（账本↔模型统计，成功口径 1500/2000）：ok');
  ok(check('repricing').status === 'ok', '交叉核对 3（重定价）：价目表未演化 → ok');
  ok(
    check('internal-vs-external').status === 'ok' && /无外部账单/.test(check('internal-vs-external').detail),
    '交叉核对 4（内部↔外部）：无账单登记时如实标注跳过',
  );
  ok(r0.alerts.length === 0, '账目平：0 告警');

  // 周期自动对账（虚拟定时器推进：t=3920 → 推进 5000 → 触发点 6000 处回调 1 次）
  vt.advance(5000);
  ok(reports.length === 1 && reports[0].alerts.length === 0 && reports[0].generatedAt === 6000,
    `周期自动对账：虚拟时钟推进 5000ms → onReconciliation 恰回调 1 次（触发点 t=6000=起点+5000，与注入时钟一致；0 告警）`);

  // 外部账单核对：先平 → 注入差异 → 检出
  client.reportExternalCost({ source: 'provider-invoice', model: 'm1', periodStart: 0, periodEnd: 10_000, tokens: 1600, cost: 0.0032 });
  const r1 = client.reconcile();
  ok(
    r1.crossChecks.find((c) => c.name === 'internal-vs-external').status === 'ok',
    '外部账单与内部记账一致（1600tok/$0.0032）→ internal-vs-external ok',
  );
  client.reportExternalCost({ source: 'provider-invoice', model: 'm2', periodStart: 0, periodEnd: 10_000, tokens: 2000, cost: 0.0024 });
  const r2 = client.reconcile();
  const ext = r2.crossChecks.find((c) => c.name === 'internal-vs-external');
  ok(
    ext.status === 'mismatch' && r2.alerts.some((a) => a.includes('外部账单对不平') && a.includes('m2')),
    `注入差异检出：外部账单 m2 多记 $0.0004 → internal-vs-external mismatch + 告警（Δcost=${ext.delta.toFixed(8)} 如实）`,
  );

  // 价目表演化（重注册涨价）→ 重定价检出
  client.registerModel({ id: 'm1', endpoint: 'http://fake', costPerKToken: 0.003 });
  const r3 = client.reconcile();
  const reprice = r3.crossChecks.find((c) => c.name === 'repricing');
  ok(
    reprice.status === 'mismatch' && r3.alerts.some((a) => a.includes('成本漂移')),
    `价目表演化检出：m1 涨价 0.002→0.003 后重定价 mismatch（记账 $0.0032 vs 当前价 $0.0048）+ 成本漂移告警`,
  );
  ok(
    r3.crossChecks.find((c) => c.name === 'ledger-vs-model-stats').status === 'ok',
    '重注册保留统计：ledger-vs-model-stats 仍平（重定价只报价格漂移，不误报账目不平）',
  );
  ok(near(reprice.otherValue, 0.0068, 1e-12), '重定价口径数值精确（m1 1600tok×$0.003/k=$0.0048 + m2 未涨 $0.002 = $0.0068）');
  client.stopAutoReconcile();
  vt.advance(12000); // 若未停：11000/16000/20000 三个触发点会补发报告
  ok(reports.length === 1, 'stopAutoReconcile 后周期回调停止（虚拟推进 12000ms 跨过 3 个原触发点，无新报告）');

  // 窗口对账（from/to 只约束聚合）
  const r4 = client.reconcile({ from: 2000, to: 4000 });
  const wTokens = r4.byModel.reduce((a, x) => a + x.tokens, 0);
  ok(
    wTokens === 2600 && r4.window.from === 2000,
    `窗口对账：ts∈[2000,4000) 恰含 m2(2000)+m1 流式(500)+m1 失败估算(100)=${wTokens} token（窗口只约束聚合，交叉核对恒全量口径）`,
  );
}

// ═══════════════════════════ 汇总 ═══════════════════════════

console.log('\n════════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— R4-A14 模块域（llm-client / progress-ws）第四轮全新维度升级闭环成立`);
} else {
  console.log(`✗ PASS ${passed} / FAIL ${failed} —— 存在未达标项`);
}
process.exit(failed === 0 ? 0 : 1);
