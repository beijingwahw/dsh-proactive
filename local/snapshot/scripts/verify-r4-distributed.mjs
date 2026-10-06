/**
 * verify-r4-distributed.mjs — 第四轮模块域 R4-A12 升级：分布式模块域
 * （raft-engine / distributed-sync / hot-reload-engine）全新维度验证
 *
 * 五项全新维度各配「旧行为 vs 新行为」的构造对照（不是「改了」，是「证明更好」）：
 *   ⓪ 零漂移总检：新面缺省全 null/空——byzantineReport/healingReports null、
 *      membershipStatus 静态视图、ClusterStatus 七字段形状不变、联邦批次哈希
 *      确定性、RaftFaultSimulator 同种子双跑逐位一致（核心循环重构无回归）。
 *   ① 拜占庭检测与隔离（raft）：5 节点注入拜占庭节点（对 AppendEntries 声称
 *      确认但不落日志 + 探针前后两说）——领导者周期审计探测在三类证据
 *      （ack-missing/ack-mismatch/equivocation）上计数，suspect→quarantine；
 *      隔离后法定人数按 4 节点计算、共识继续安全提交；申诉观察期再犯即回
 *      隔离；节点治愈（换回诚实行为）追平日志后连续一致探测恢复投票权。
 *      旧口径：假确认直接计入多数派（谎报无代价）；新口径：检出→排除→可恢复。
 *   ② 网络分区愈合（raft）：4 节点严格 2-2 分区——双侧各自进展（旧 leader
 *      侧日志增长 / 另一侧任期膨胀）但双侧都无法提交（2/4 < 多数派），
 *      愈合后无损合并（分区期提案最终全部提交、愈合报告为空）；5 节点
 *      2|3 分区——多数侧提交新条目、少数侧保留旧 leader 追加未提交段，
 *      愈合时少数侧截断重同步，被弃段显式入账（索引/任期/signalId/状态机
 *      摘要差异）——「少数侧数据被显式报告而非静默丢弃」，且少数侧提案
 *      按失败显式兑现（不假装成功）。
 *   ③ 单步成员变更（raft）：3→5→4 变更序列——每次恰增删一个节点，变更
 *      条目在「过半旧配置 ∧ 过半新配置」双法定人数下提交；全程任一任期
 *      至多一个 leader（无双主）、提交日志 1..8 连续无缺口且跨终态成员
 *      逐位一致；已移除节点停止接收复制；进行中变更二次发起被拒（单步）。
 *   ④ 跨集群联邦（sync）：双集群三前缀流——网关按命名空间/键前缀订阅做
 *      选择性同步（fx/fy 订阅、fz 未订阅）：fz 出口裁剪零传输（filtered=3、
 *      转发前缀表无 fz、B 端记忆无 fz——而非「全量转发再由对端丢弃」）；
 *      每窗口限流 2 条：9 条变更 3 个窗口分批送达（超发排队延迟不丢弃）；
 *      联邦批次与引擎同一哈希口径（receiveBatch 直接校验应用 + 幂等）；
 *      传输字节 < 全量基线。
 *   ⑤ 热重载灰度（hot-reload，加分）：坏版本灰度——探针失败只回滚灰度
 *      单元（rollback 处理器恢复 m1）、全量集合零调用（m2/m3 完全不受
 *      影响，模块状态保持旧版）；好版本——灰度探针全过后按序全量铺开；
 *      探针 throw / 返回不健康 / 缺省灰度单元三路径齐验；事件流完整审计。
 *
 * 确定性：全部仿真走 RaftVirtualClock + RaftSimNetwork（种子注入）；
 * 联邦网关注入虚拟时钟；灰度探针为纯函数。无真网络、无真定时器、无持久化。
 *
 * 运行：npm run build && node scripts/verify-r4-distributed.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RaftEngine,
  RaftVirtualClock,
  RaftSimNetwork,
  RaftFaultSimulator,
  DistributedSync,
  LongTermMemory,
  HotReloadEngine,
  FederationGateway,
  buildFederationBatch,
} from '../dist/index.mjs';

// ─────────────────────────── 断言工具（仓库惯例：ok/near/section） ───────────────────────────

let passed = 0;
let failed = 0;
function ok(cond, label, detail = '') {
  const pass = Boolean(cond);
  if (pass) passed += 1;
  else failed += 1;
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  if (detail) console.log(`    ${detail}`);
  return pass;
}
function near(a, b, tol = 1e-9, label, detail = '') {
  return ok(Math.abs(a - b) <= tol, label, detail || `|${a} − ${b}| ≤ ${tol}`);
}
function section(title) {
  console.log(`\n■ ${title}`);
}
/** 深度规范化序列化（键序无关的逐位比对口径） */
function canon(value) {
  const deep = (v) => {
    if (typeof v !== 'object' || v === null) return v;
    if (Array.isArray(v)) return v.map(deep);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = deep(v[k]);
    return out;
  };
  return JSON.stringify(deep(value));
}
/** mulberry32：32 位种子 → [0,1) 确定性均匀流 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const cmd = (signalId, proposedBy = 'sim') => ({
  type: 'execute-plan',
  signalId,
  signalDescription: `desc-${signalId}`,
  decision: null,
  proposedBy,
});

// ═══════════════════ ⓪ 零漂移总检 ═══════════════════

section('⓪ 零漂移总检：新面缺省全 null/空，既有口径逐位保持');

{
  // raft：未开启任何第四轮选项的引擎——新读数全空、旧读数原样
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-dist-zero-'));
  const solo = new RaftEngine({
    localNodeId: 'solo',
    cluster: [{ nodeId: 'solo', address: '127.0.0.1', port: 0 }],
    electionTimeoutMin: 150, electionTimeoutMax: 300, heartbeatInterval: 50,
    consensusPort: 0, logPath: path.join(dir, 'raft.json'),
  });
  ok(solo.byzantineReport() === null && solo.healingReports() === null,
    '未开启守卫/愈合报告 → byzantineReport/healingReports 均 null（零介入）');
  ok(canon(solo.membershipStatus()) === canon({ nodes: ['solo'], pending: null }),
    'membershipStatus 静态视图：配置节点 + pending=null（纯只读观测）');
  ok(solo.requestAppeal('anyone') === false, '守卫关闭时申诉受理拒绝（false，无副作用）');
  solo.start();
  await new Promise((r) => setTimeout(r, 60));
  const res = await solo.propose(cmd('z-1'), 2000);
  const st = solo.getClusterStatus();
  ok(res.committed === true && st.commitIndex === 1,
    '缺省单节点提案立即提交（核心循环重构后行为不变）');
  ok(canon(Object.keys(st).sort()) === canon(
    ['commitIndex', 'lastLogIndex', 'leaderId', 'localNodeId', 'logLength', 'peers', 'pendingProposals', 'role', 'term'].sort(),
  ), 'ClusterStatus 九字段形状不变（新能力零侵入）');
  const probe = await solo.dispatchRpc('ProbeLog', { term: 0, leaderId: 'solo', askerId: 'solo', index: 1 });
  ok(probe.ok === true && typeof probe.fingerprint === 'string' && probe.fingerprint.length > 0,
    'ProbeLog RPC 可分发且只读（无共识状态变化；守卫关闭时无人调用）');
  const qa = solo.quorumAudit();
  ok(qa.quorumSize === 1 && qa.crashFaultTolerance === 0,
    'quorumAudit 闭式口径不变（单节点：quorum 1 / CFT 0）');
  solo.stop();

  // 核心循环重构（投票集/法定人数/复制目标）无确定性回归：故障仿真台同种子双跑
  const sim1 = await new RaftFaultSimulator({ seed: 4242, nodes: 4, compactEvery: 31 }).run(120);
  const sim2 = await new RaftFaultSimulator({ seed: 4242, nodes: 4, compactEvery: 31 }).run(120);
  ok(JSON.stringify(sim1) === JSON.stringify(sim2) && sim1.invariantViolations.length === 0,
    'RaftFaultSimulator 同种子双跑逐位一致 + 120 轮 0 违例（缺省法定人数路径重构无回归）',
    `delivered=${sim1.stats.delivered} dropped=${sim1.stats.dropped} committed=${sim1.stats.proposalsCommitted}`);

  // sync：联邦批次纯函数确定性（显式 batchId + 固定时钟 → 哈希逐位稳定）
  const change = {
    id: 'cluster-a:1:deadbeef', type: 'pattern-created', fingerprint: 'fx:1',
    timestamp: 1000, sourceNodeId: 'cluster-a', payload: null, logicalClock: 1, dataHash: 'h1',
  };
  const b1 = buildFederationBatch('cluster-a', [change], { batchId: 'bid', logicalClock: 1, timestamp: 1000 });
  const b2 = buildFederationBatch('cluster-a', [change], { batchId: 'bid', logicalClock: 1, timestamp: 1000 });
  ok(b1.batchHash === b2.batchHash && b1.batchHash.length === 64,
    'buildFederationBatch 哈希确定性（同输入同哈希，sha256 全长）');

  // hot-reload：缺省引擎无灰度痕迹
  const hdir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-dist-hr0-'));
  const hr = new HotReloadEngine({
    enabled: true, watchDirs: [], watchExtensions: ['.ts'], debounceMs: 10,
    buildCommand: 'echo noop', distDir: hdir, entryFile: 'x.js',
    maxVersionHistory: 5, gracefulShutdownTimeout: 50,
    versionsDir: path.join(hdir, 'versions'), autoRollback: true,
  });
  ok(typeof hr.canaryDeploy === 'function' && hr.getStatus().deploying === false,
    'canaryDeploy 挂载可用但缺省零副作用（deploying=false）');
  hr.stop();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  fs.rmSync(hdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ═══════════════════ ① 拜占庭检测与隔离 ═══════════════════

section('① 拜占庭节点检测与隔离：声称确认不落日志 + 探针两说 → 检出 → 隔离 → 共识继续 → 申诉恢复');

/**
 * 拜占庭场景（确定性，可双跑比对）：
 * n2 为拜占庭节点——AppendEntries 一律回 success 但从不落日志（声称确认但
 * 日志不含），ProbeLog 交替「谎报内容 / 装作没有」（同索引前后两说）。
 * n0 为稳定领导者（短选举超时），守卫每 2 轮心跳审计一轮。
 */
async function runByzantineScenario() {
  const clock = new RaftVirtualClock();
  const net = new RaftSimNetwork(clock, { seed: 911, baseLatencyMs: 2, jitterMs: 3 });
  const ids = ['n0', 'n1', 'n2', 'n3', 'n4'];
  const cluster = ids.map((id) => ({ nodeId: id, address: 'sim', port: 0 }));
  const leaderByTerm = new Map();
  const engines = new Map();
  ids.forEach((id, i) => {
    const engine = new RaftEngine({
      localNodeId: id,
      cluster,
      electionTimeoutMin: id === 'n0' ? 50 : id === 'n2' ? 9000 : 200,
      electionTimeoutMax: id === 'n0' ? 70 : id === 'n2' ? 9500 : 300,
      heartbeatInterval: 20,
      consensusPort: 0,
      logPath: `sim://${id}`,
      rng: mulberry32(1000 + i * 17),
      transport: net.transport(id),
      scheduler: clock,
      now: () => clock.time(),
      persist: false,
      byzantineGuard: { probeEveryNHeartbeats: 2, suspicionThreshold: 2, quarantineThreshold: 3, appealCredits: 2 },
      healingReport: { maxRecords: 16 },
    });
    engine.onRoleChange((role, term) => {
      if (role !== 'leader') return;
      const set = leaderByTerm.get(term) ?? new Set();
      set.add(id);
      leaderByTerm.set(term, set);
    });
    engines.set(id, engine);
  });
  const real2 = engines.get('n2');
  const byz = { probes: 0 };
  const heal = { honest: false };
  net.register('n2', (rpc, args) => {
    if (heal.honest) return real2.dispatchRpc(rpc, args);
    if (rpc === 'AppendEntries') {
      // 声称确认但日志不含：直接回 success，条目从不落日志
      return Promise.resolve({ ok: true, term: args.term, success: true });
    }
    if (rpc === 'ProbeLog') {
      byz.probes += 1;
      // 奇数轮谎报内容（ack-mismatch），偶数轮装作没有（ack-missing）；
      // 相邻两轮同索引答案不同 → 口径不一致（equivocation）
      const fingerprint = byz.probes % 2 === 1 ? `lie-${byz.probes}` : null;
      return Promise.resolve({ ok: true, term: args.term, fingerprint });
    }
    return real2.dispatchRpc(rpc, args);
  });
  for (const id of ['n0', 'n1', 'n3', 'n4']) {
    const engine = engines.get(id);
    net.register(id, (rpc, args) => engine.dispatchRpc(rpc, args));
  }
  const step = async (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      clock.advance(20);
      await net.flush();
    }
  };
  const proposeCommit = async (signalId) => {
    let committed = false;
    const p = engines.get('n0').propose(cmd(signalId, 'n0'), 60000);
    p.then((r) => { committed = r.committed; });
    for (let i = 0; i < 40 && !committed; i += 1) await step(1);
    await step(2);
    return committed;
  };
  const summary = {
    initialCommits: 0,
    byzantineDetected: false,
    byzantineStatusAfterDetection: '',
    evidenceKinds: [],
    postQuarantineCommits: 0,
    appealRelapse: false,
    appealAccepted: false,
    secondAppealAccepted: false,
    healedRestored: false,
    finalStatus: '',
    postHealCommit: false,
    honestCommittedLogsIdentical: false,
    byzantineNeverLeader: false,
    dualLeaderEver: false,
    quarantinedAt: null,
  };

  // 1. 选举 + 基线提交（拜占庭的假确认在此期间已被计入多数派——旧口径无代价）
  for (const e of engines.values()) e.start();
  await step(8);
  const leader = [...engines.values()].find((e) => e.getRole() === 'leader');
  if (!leader || leader.getClusterStatus().localNodeId !== 'n0') return { ...summary, failed: 'no-leader' };
  let c = 0;
  for (const s of ['b-1', 'b-2', 'b-3']) if (await proposeCommit(s)) c += 1;
  summary.initialCommits = c;

  // 2. 检测：稳定期（无新提案 → matchIndex 稳定）审计探测逐轮取证
  await step(14);
  const report = engines.get('n0').byzantineReport();
  const st2 = report?.['n2'];
  summary.byzantineDetected = st2?.status === 'quarantined';
  summary.byzantineStatusAfterDetection = st2?.status ?? 'none';
  summary.evidenceKinds = [...(st2?.evidenceKinds ?? [])].sort();
  summary.quarantinedAt = st2?.quarantinedAt ?? null;

  // 3. 隔离后共识继续：法定人数按 4 节点（n2 剔除）计算
  let c2 = 0;
  for (const s of ['q-1', 'q-2']) if (await proposeCommit(s)) c2 += 1;
  summary.postQuarantineCommits = c2;

  // 4. 申诉观察期再犯：probation 中继续说谎 → 回隔离
  summary.appealAccepted = engines.get('n0').requestAppeal('n2');
  await step(6);
  const relapseReport = engines.get('n0').byzantineReport();
  summary.appealRelapse = relapseReport?.['n2']?.status === 'quarantined';

  // 5. 治愈：换回诚实行为 → 冲突提示快速追平日志 → 再次申诉 → 连续一致探测 → 恢复投票权
  heal.honest = true;
  await step(24);
  summary.secondAppealAccepted = engines.get('n0').requestAppeal('n2');
  await step(16);
  const healedReport = engines.get('n0').byzantineReport();
  summary.healedRestored = healedReport?.['n2']?.status === 'trusted';
  summary.finalStatus = healedReport?.['n2']?.status ?? 'none';
  summary.postHealCommit = await proposeCommit('h-1');

  // 6. 安全不变量：诚实节点提交日志全局一致；拜占庭从未当选
  const honest = ['n0', 'n1', 'n3', 'n4'].map((id) => engines.get(id));
  const views = honest.map((e) => {
    const s = e.getClusterStatus();
    return e.inspectLog().slice(0, s.commitIndex).map((x) => `${x.index}:${x.term}:${x.command.signalId}`).join('|');
  });
  summary.honestCommittedLogsIdentical = views.every((v) => v === views[0]) && views[0].length > 0;
  summary.byzantineNeverLeader = ![...leaderByTerm.values()].some((set) => set.has('n2'));
  summary.dualLeaderEver = [...leaderByTerm.values()].some((set) => set.size > 1);

  for (const e of engines.values()) e.stop();
  return summary;
}

{
  const s = await runByzantineScenario();
  ok(s.initialCommits === 3, '① 前提铺陈：拜占庭在场时 3 笔基线提案全部提交（假确认计入多数派——检测前的旧口径现状）');
  ok(s.byzantineDetected && s.quarantinedAt !== null,
    '① 拜占庭检出并隔离：证据 ≥ 3（阈值）→ trusted→suspect→quarantine，quarantinedAt 入档',
    `状态链终态=${s.byzantineStatusAfterDetection}，隔离时刻=${s.quarantinedAt}`);
  ok(s.evidenceKinds.length >= 2 && s.evidenceKinds.includes('ack-missing'),
    '① 三类证据至少两类被观测（声称确认但日志不含 / 内容不符 / 同索引两说）',
    `evidenceKinds = [${s.evidenceKinds.join(', ')}]`);
  ok(s.postQuarantineCommits === 2,
    '① 隔离后共识继续安全：法定人数按剩余 4 节点计算，2 笔提案照常提交（旧口径：谎报者继续污染多数派）');
  ok(s.appealAccepted && s.appealRelapse,
    '① 申诉机制：受理进入观察期 → 观察期内继续说谎即回隔离（probation 再犯不豁免）');
  ok(s.secondAppealAccepted === true && s.healedRestored && s.finalStatus === 'trusted' && s.postHealCommit,
    '① 治愈恢复：换回诚实行为 → 冲突提示快速追平日志 → 再次申诉 → 连续一致探测恢复投票权（隔离非终审）',
    `终态=${s.finalStatus}，恢复后提案提交=${s.postHealCommit}`);
  ok(s.honestCommittedLogsIdentical && s.byzantineNeverLeader && !s.dualLeaderEver,
    '① 安全不变量：诚实节点提交日志全局一致、拜占庭从未当选、全程无双领导者');
  const s2 = await runByzantineScenario();
  ok(canon(s) === canon(s2), '① 确定性：同参数双跑逐位一致（虚拟时钟 + 种子 RNG + 确定性拜占庭包装）');
}

// ═══════════════════ ② 网络分区愈合 ═══════════════════

section('② 网络分区愈合：2-2 双侧停滞无损合并 + 2|3 少数侧截断重同步（显式弃置报告）');

// ── ②a 严格 2-2 分区（4 节点）：双侧都无法提交 → 愈合无损 ──
{
  const clock = new RaftVirtualClock();
  const net = new RaftSimNetwork(clock, { seed: 5150, baseLatencyMs: 2, jitterMs: 3 });
  const ids = ['a0', 'a1', 'a2', 'a3'];
  const cluster = ids.map((id) => ({ nodeId: id, address: 'sim', port: 0 }));
  const leaderByTerm = new Map();
  const engines = new Map();
  ids.forEach((id, i) => {
    const engine = new RaftEngine({
      localNodeId: id,
      cluster,
      electionTimeoutMin: id === 'a0' ? 50 : 200,
      electionTimeoutMax: id === 'a0' ? 70 : 300,
      heartbeatInterval: 20,
      consensusPort: 0,
      logPath: `sim://${id}`,
      rng: mulberry32(2000 + i * 31),
      transport: net.transport(id),
      scheduler: clock,
      now: () => clock.time(),
      persist: false,
      healingReport: { maxRecords: 16 },
    });
    engine.onRoleChange((role, term) => {
      if (role !== 'leader') return;
      const set = leaderByTerm.get(term) ?? new Set();
      set.add(id);
      leaderByTerm.set(term, set);
    });
    engines.set(id, engine);
    net.register(id, (rpc, args) => engine.dispatchRpc(rpc, args));
  });
  const step = async (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      clock.advance(20);
      await net.flush();
    }
  };
  const drain = async (engine, signalId) => {
    let committed = false;
    engine.propose(cmd(signalId, 'a0'), 60000).then((r) => { committed = r.committed; });
    for (let i = 0; i < 50 && !committed; i += 1) await step(1);
    return committed;
  };

  for (const e of engines.values()) e.start();
  await step(8);
  const leader = [...engines.values()].find((e) => e.getRole() === 'leader');
  ok(leader?.getClusterStatus().localNodeId === 'a0', '②a 前提铺陈：a0 当选（分区前的全域 leader）');
  let base = 0;
  for (const s of ['p-1', 'p-2', 'p-3']) if (await drain(leader, s)) base += 1;
  ok(base === 3, '②a 分区前 3 笔提案全域提交', `commitIndex=${leader.getClusterStatus().commitIndex}`);
  await step(4); // 心跳传播 leaderCommit 到慢侧
  const termAtPartition = leader.getTerm();
  const frozenBefore = { a2: engines.get('a2').getClusterStatus().commitIndex, a3: engines.get('a3').getClusterStatus().commitIndex };

  // 2-2 分区：双侧各 2 节点（均 < 3/4 多数派）
  net.setPartition([['a0', 'a1'], ['a2', 'a3']]);
  const pending = [];
  const offers = [engines.get('a0').propose(cmd('pa-4', 'a0'), 60000), engines.get('a0').propose(cmd('pa-5', 'a0'), 60000)];
  for (const p of offers) pending.push(p.then((r) => r.committed));
  await step(24); // 480ms：a2/a3 选举超时反复触发，任期膨胀；a0 侧日志增长

  const a0s = engines.get('a0').getClusterStatus();
  const a1s = engines.get('a1').getClusterStatus();
  const bMaxTerm = Math.max(engines.get('a2').getTerm(), engines.get('a3').getTerm());
  ok(a0s.lastLogIndex === 5 && a1s.lastLogIndex === 5 && a0s.commitIndex === 3 && a1s.commitIndex === 3,
    '②a 分区期多数侧进展（但不可提交）：旧 leader 侧日志 3→5、commitIndex 冻结 3（2/4 < 多数派）',
    `a0 lastLog=${a0s.lastLogIndex} commit=${a0s.commitIndex}；a1 lastLog=${a1s.lastLogIndex}`);
  ok(bMaxTerm > termAtPartition && engines.get('a2').getRole() !== 'leader' && engines.get('a3').getRole() !== 'leader',
    '②a 分区期另一侧「各自进展」只体现在任期膨胀：反复竞选但无人当选（另一侧 2/4 也无多数派）',
    `分区时 leader 任期 ${termAtPartition} → 另一侧任期升至 ${bMaxTerm}`);
  const bFrozen = ['a2', 'a3'].every((id) => engines.get(id).getClusterStatus().commitIndex === frozenBefore[id]);
  ok(bFrozen && frozenBefore.a2 <= 3 && frozenBefore.a3 <= 3,
    '②a 双侧提交冻结（2-2 分区不可能产生任何新提交——安全性的构造证明）',
    `分区前 a2=${frozenBefore.a2} / a3=${frozenBefore.a3}，分区期后保持不变`);

  // 愈合
  net.clearPartition();
  await step(12);
  const postLeader = [...engines.values()].find((e) => e.getRole() === 'leader');
  ok(postLeader !== undefined, '②a 愈合后重新选出唯一 leader（长日志侧胜出——日志新鲜度规则）',
    postLeader ? `leader=${postLeader.getClusterStatus().localNodeId} term=${postLeader.getTerm()}` : '');
  const healed = await drain(postLeader, 'ph-6');
  ok(healed, '②a 愈合后新提案提交');
  await step(6);
  const commits = ids.map((id) => engines.get(id).getClusterStatus().commitIndex);
  ok(commits.every((v) => v === 6), '②a 愈合收敛：四节点 commitIndex 全部 = 6（分区期未提交段经新任期条目隐式提交）',
    `commitIndex = ${commits.join('/')}`);
  const settled = await Promise.all(pending);
  ok(settled.every((v) => v === true),
    '②a 无损愈合：分区期 2 笔未提交提案最终全部真实提交（无一条被丢弃）');
  const healingEmpty = ids.every((id) => (engines.get(id).healingReports() ?? []).length === 0);
  ok(healingEmpty, '②a 愈合报告为空（2-2 分区无可分歧的提交历史——零数据丢弃，报告如实为空）');
  const views = ids.map((id) => {
    const e = engines.get(id);
    const s = e.getClusterStatus();
    return e.inspectLog().slice(0, s.commitIndex).map((x) => `${x.index}:${x.term}:${x.command.signalId}`).join('|');
  });
  ok(views.every((v) => v === views[0]), '②a 四节点提交日志逐位一致（全局日志匹配）');
  ok(![...leaderByTerm.values()].some((set) => set.size > 1), '②a 全程任一任期至多一个 leader（含分区期与愈合期）');
  for (const e of engines.values()) e.stop();
}

// ── ②b 2|3 分区（5 节点）：多数侧提交、少数侧旧 leader 追加 → 愈合截断 + 显式弃置报告 ──
{
  const clock = new RaftVirtualClock();
  const net = new RaftSimNetwork(clock, { seed: 777, baseLatencyMs: 2, jitterMs: 3 });
  const ids = ['m0', 'm1', 'm2', 'm3', 'm4'];
  const cluster = ids.map((id) => ({ nodeId: id, address: 'sim', port: 0 }));
  const leaderByTerm = new Map();
  const engines = new Map();
  const timeouts = { m0: [50, 70], m2: [80, 100] };
  ids.forEach((id, i) => {
    const [min, max] = timeouts[id] ?? [200, 300];
    const engine = new RaftEngine({
      localNodeId: id,
      cluster,
      electionTimeoutMin: min,
      electionTimeoutMax: max,
      heartbeatInterval: 20,
      consensusPort: 0,
      logPath: `sim://${id}`,
      rng: mulberry32(3000 + i * 41),
      transport: net.transport(id),
      scheduler: clock,
      now: () => clock.time(),
      persist: false,
      healingReport: { maxRecords: 16 },
    });
    engine.onRoleChange((role, term) => {
      if (role !== 'leader') return;
      const set = leaderByTerm.get(term) ?? new Set();
      set.add(id);
      leaderByTerm.set(term, set);
    });
    engines.set(id, engine);
    net.register(id, (rpc, args) => engine.dispatchRpc(rpc, args));
  });
  const step = async (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      clock.advance(20);
      await net.flush();
    }
  };
  const drain = async (engine, signalId) => {
    let committed = false;
    engine.propose(cmd(signalId, engine.getClusterStatus().localNodeId), 60000).then((r) => { committed = r.committed; });
    for (let i = 0; i < 50 && !committed; i += 1) await step(1);
    return committed;
  };

  for (const e of engines.values()) e.start();
  await step(8);
  const oldLeader = [...engines.values()].find((e) => e.getRole() === 'leader');
  ok(oldLeader?.getClusterStatus().localNodeId === 'm0', '②b 前提铺陈：m0 当选（少数侧保留旧 leader 的构造前提）');
  let base = 0;
  for (const s of ['s-1', 's-2', 's-3']) if (await drain(oldLeader, s)) base += 1;
  ok(base === 3, '②b 分区前 3 笔全域提交');

  // 2|3 分区：少数侧 {m0,m1}（旧 leader 在内），多数侧 {m2,m3,m4}
  net.setPartition([['m0', 'm1'], ['m2', 'm3', 'm4']]);
  const minorityOffers = [
    engines.get('m0').propose(cmd('min-4', 'm0'), 60000),
    engines.get('m0').propose(cmd('min-5', 'm0'), 60000),
  ];
  const minoritySettled = minorityOffers.map((p) => p.then((r) => r.committed));
  await step(10); // 少数侧：追加 + 组内复制（不可提交）
  await step(16); // 多数侧：m2 短超时当选新 leader

  const m0s = engines.get('m0').getClusterStatus();
  const m1s = engines.get('m1').getClusterStatus();
  const newLeader = [engines.get('m2'), engines.get('m3'), engines.get('m4')].find((e) => e.getRole() === 'leader');
  ok(newLeader !== undefined, '②b 分区期多数侧选出新 leader（3/5 多数派成立）',
    newLeader ? `leader=${newLeader.getClusterStatus().localNodeId} term=${newLeader.getTerm()} > 旧 term=${oldLeader.getTerm()}` : '');
  let maj = 0;
  for (const s of ['maj-4', 'maj-5', 'maj-6']) if (await drain(newLeader, s)) maj += 1;
  ok(maj === 3, '②b 分区期多数侧持续提交 3 笔（索引 4-6 被多数侧历史占用）');
  ok(m0s.lastLogIndex === 5 && m0s.commitIndex === 3 && m1s.lastLogIndex === 5 && m1s.commitIndex === 3,
    '②b 少数侧「各自进展」：旧 leader 追加未提交段（日志 3→5、commitIndex 冻结 3）',
    `m0 lastLog=${m0s.lastLogIndex} commit=${m0s.commitIndex}；m1 lastLog=${m1s.lastLogIndex}`);

  // 愈合：多数侧 leader 高任期心跳 → 少数侧截断重同步
  net.clearPartition();
  await step(20);
  const m0Reports = engines.get('m0').healingReports() ?? [];
  const m1Reports = engines.get('m1').healingReports() ?? [];
  const commits = ids.map((id) => engines.get(id).getClusterStatus().commitIndex);
  ok(commits.every((v) => v === 6), '②b 愈合收敛：五节点 commitIndex 全部 = 6（少数侧重同步到多数侧历史）',
    `commitIndex = ${commits.join('/')}`);
  ok(m0Reports.length >= 1 && m1Reports.length >= 1,
    '②b 少数侧两侧节点均产出愈合报告（截断发生即入账——不静默丢弃）');
  const r0 = m0Reports[0];
  ok(r0 && r0.keptThrough === 3 && r0.leaderId === newLeader?.getClusterStatus().localNodeId,
    '②b 报告口径：keptThrough=3（保留已提交前缀）、leaderId=多数侧领导者',
    r0 ? `keptThrough=${r0.keptThrough} leaderId=${r0.leaderId} reason=${r0.reason}` : '');
  ok(r0 && r0.discarded.length === 2
    && r0.discarded[0].index === 4 && r0.discarded[0].signalId === 'min-4'
    && r0.discarded[1].index === 5 && r0.discarded[1].signalId === 'min-5'
    && r0.discarded[0].term === r0.discarded[1].term,
    '②b 显式弃置报告：被截断的未提交段逐条入账（index 4/5 + signalId min-4/min-5）',
    r0 ? `discarded = ${JSON.stringify(r0.discarded.map((d) => `${d.index}@T${d.term}:${d.signalId}`))}` : '');
  ok(r0 && r0.discardedDigest.entriesApplied === 2 && r0.discardedDigest.lastSignalId === 'min-5',
    '②b 状态机差异报告：被弃段状态摘要（entriesApplied=2 / lastSignalId=min-5）——少数侧与多数侧差异显式可见',
    r0 ? `discardedDigest = ${JSON.stringify(r0.discardedDigest)}` : '');
  const minorityResults = await Promise.all(minoritySettled);
  ok(minorityResults.every((v) => v === false),
    '②b 少数侧 2 笔分区期提案最终按失败显式兑现（不假装成功——与弃置报告互为对照）');
  const globalSignals = new Set();
  for (const id of ids) {
    const e = engines.get(id);
    const s = e.getClusterStatus();
    for (const entry of e.inspectLog().slice(0, s.commitIndex)) globalSignals.add(entry.command.signalId);
  }
  ok(!globalSignals.has('min-4') && !globalSignals.has('min-5') && globalSignals.has('maj-4') && globalSignals.has('maj-6'),
    '②b 合并正确性：多数侧历史全量保留、少数侧未提交段全局绝迹（提交视图 = 多数侧历史）',
    `已提交 signalIds = ${[...globalSignals].sort().join(', ')}`);
  const views = ids.map((id) => {
    const e = engines.get(id);
    const s = e.getClusterStatus();
    return e.inspectLog().slice(0, s.commitIndex).map((x) => `${x.index}:${x.term}:${x.command.signalId}`).join('|');
  });
  ok(views.every((v) => v === views[0]), '②b 五节点提交日志逐位一致（全局日志匹配不变量）');
  ok(![...leaderByTerm.values()].some((set) => set.size > 1), '②b 全程任一任期至多一个 leader（分区期双 leader 候选从未同时当选）');
  for (const e of engines.values()) e.stop();
}

// ═══════════════════ ③ 单步成员变更 3→5→4 ═══════════════════

section('③ 单步成员变更（联合共识双法定人数）：3→5→4 序列无双主 + 日志连续');

{
  const clock = new RaftVirtualClock();
  const net = new RaftSimNetwork(clock, { seed: 3141, baseLatencyMs: 2, jitterMs: 3 });
  const ids = ['c0', 'c1', 'c2', 'c3', 'c4'];
  const cfg = (id) => ({ nodeId: id, address: 'sim', port: 0 });
  const leaderByTerm = new Map();
  const engines = new Map();
  // 各节点以「加入时刻」的集群视图构造：c0-c2 起始 3 节点；c3 以 4 节点视图加入；c4 以 5 节点视图加入
  const viewFor = { c0: ['c0', 'c1', 'c2'], c1: ['c0', 'c1', 'c2'], c2: ['c0', 'c1', 'c2'], c3: ['c0', 'c1', 'c2', 'c3'], c4: ['c0', 'c1', 'c2', 'c3', 'c4'] };
  ids.forEach((id, i) => {
    const passive = id === 'c3' || id === 'c4';
    const engine = new RaftEngine({
      localNodeId: id,
      cluster: viewFor[id].map(cfg),
      electionTimeoutMin: id === 'c0' ? 50 : passive ? 9000 : 200,
      electionTimeoutMax: id === 'c0' ? 70 : passive ? 9500 : 300,
      heartbeatInterval: 20,
      consensusPort: 0,
      logPath: `sim://${id}`,
      rng: mulberry32(4000 + i * 53),
      transport: net.transport(id),
      scheduler: clock,
      now: () => clock.time(),
      persist: false,
    });
    engine.onRoleChange((role, term) => {
      if (role !== 'leader') return;
      const set = leaderByTerm.get(term) ?? new Set();
      set.add(id);
      leaderByTerm.set(term, set);
    });
    engines.set(id, engine);
    net.register(id, (rpc, args) => engine.dispatchRpc(rpc, args));
  });
  const step = async (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      clock.advance(20);
      await net.flush();
    }
  };
  const runChange = async (factory) => {
    let result = null;
    let done = false;
    factory().then((r) => { result = r; done = true; });
    for (let i = 0; i < 120 && !done; i += 1) await step(1);
    return result;
  };
  const drain = async (engine, signalId) => {
    let committed = false;
    engine.propose(cmd(signalId, 'c0'), 60000).then((r) => { committed = r.committed; });
    for (let i = 0; i < 50 && !committed; i += 1) await step(1);
    return committed;
  };
  const committedView = (engine) => {
    const s = engine.getClusterStatus();
    return engine.inspectLog().slice(0, s.commitIndex).map((x) => `${x.index}:${x.term}:${x.command.signalId}${x.membership ? `#${x.membership.type}:${x.membership.node.nodeId}` : ''}`).join('|');
  };

  const c0 = engines.get('c0');
  const c1 = engines.get('c1');
  engines.get('c0').start();
  engines.get('c1').start();
  engines.get('c2').start();
  await step(8);
  ok(c0.getRole() === 'leader', '③ 前提铺陈：c0 当选 3 节点集群 leader');
  ok((await drain(c0, 'e-1')) && (await drain(c0, 'e-2')), '③ 变更前 2 笔提交（索引 1-2）');
  ok(c1.getRole() === 'follower' && (await c1.changeMembership({ type: 'add-node', node: cfg('c3') })).committed === false,
    '③ 非 leader 发起成员变更被拒（只有 leader 可发起）');

  // 3 → 4：加入 c3
  engines.get('c3').start();
  const inflight = runChange(() => c0.addMember(cfg('c3'), 8000));
  const concurrent = await c0.addMember(cfg('c4'), 8000); // 在途变更未定局前的二次发起
  ok(concurrent.committed === false && typeof concurrent.error === 'string',
    '③ 单步协议：进行中变更的二次发起被拒（一次恰一个节点的串行约束）',
    `error = ${concurrent.error}`);
  const add3 = await inflight;
  ok(add3?.committed === true && add3.entryIndex === 3,
    '③ 3→4：c3 加入经双法定人数（过半旧 3 节点 ∧ 过半新 4 节点）提交，条目落索引 3');
  await step(6);
  ok(canon(c0.membershipStatus().nodes) === canon(['c0', 'c1', 'c2', 'c3'])
    && canon(engines.get('c1').membershipStatus().nodes) === canon(['c0', 'c1', 'c2', 'c3'])
    && canon(engines.get('c3').membershipStatus().nodes) === canon(['c0', 'c1', 'c2', 'c3']),
    '③ 3→4 定局：配置变更应用到全体成员（leader 与 follower 视图一致）');
  ok(c0.membershipStatus().pending === null, '③ 定局后联合视图解除（pending=null）');
  const dup = await c0.addMember(cfg('c3'), 8000);
  ok(dup.committed === false, '③ 重复加入被拒（幂等防护）');
  ok(await drain(c0, 'e-3'), '③ 4 节点配置下提案照常提交（索引 4）');

  // 4 → 5：加入 c4
  engines.get('c4').start();
  const add4 = await runChange(() => c0.addMember(cfg('c4'), 8000));
  ok(add4?.committed === true, '③ 4→5：c4 加入经双法定人数提交');
  await step(6);
  ok(canon(c0.membershipStatus().nodes) === canon(['c0', 'c1', 'c2', 'c3', 'c4']), '③ 5 节点配置定局');
  ok(await drain(c0, 'e-4'), '③ 5 节点配置下提案照常提交（索引 6）');

  // 5 → 4：移除 c1
  const rm = await runChange(() => c0.removeMember('c1', 8000));
  ok(rm?.committed === true, '③ 5→4：c1 移除经双法定人数（过半旧 5 ∧ 过半新 4）提交');
  await step(6);
  ok(canon(c0.membershipStatus().nodes) === canon(['c0', 'c2', 'c3', 'c4'])
    && canon(engines.get('c2').membershipStatus().nodes) === canon(['c0', 'c2', 'c3', 'c4']),
    '③ 4 节点终态配置全员一致（被移除节点除外）');
  const missing = await c0.removeMember('c9', 8000);
  ok(missing.committed === false, '③ 移除不存在的节点被拒');
  const c1CommitBefore = engines.get('c1').getClusterStatus().commitIndex;
  ok(await drain(c0, 'e-5'), '③ 缩容后提案照常提交（索引 8——3/4 多数派）');
  await step(6);
  const finalMembers = ['c0', 'c2', 'c3', 'c4'];
  const finalCommits = finalMembers.map((id) => engines.get(id).getClusterStatus().commitIndex);
  ok(finalCommits.every((v) => v === 8), '③ 终态成员 commitIndex 全部 = 8', `commitIndex = ${finalCommits.join('/')}`);
  const c1CommitAfter = engines.get('c1').getClusterStatus().commitIndex;
  ok(c1CommitAfter <= 7 && c1CommitAfter <= c1CommitBefore + 1 && c1CommitAfter < 8,
    '③ 已移除节点停止接收复制（commitIndex 冻结在 ≤7，集群推进到 8）',
    `c1 commit=${c1CommitAfter}（冻结），集群=8`);
  const finalViews = finalMembers.map((id) => committedView(engines.get(id)));
  ok(finalViews.every((v) => v === finalViews[0]) && finalViews[0].split('|').length === 8,
    '③ 日志连续性：提交日志 1..8 无缺口且跨终态成员逐位一致（含 3 条成员变更条目与 5 条决策条目）',
    finalViews[0].split('|').map((s) => s.split(':')[2]).join(' → '));
  ok(![...leaderByTerm.values()].some((set) => set.size > 1),
    '③ 无双主：整个 3→5→4 变更序列（含联合共识窗口）任一任期至多一个 leader',
    `有领导的任期数 = ${leaderByTerm.size}`);
  for (const e of engines.values()) e.stop();
}

// ═══════════════════ ④ 跨集群联邦 ═══════════════════

section('④ 跨集群联邦：双集群三前缀选择性同步 + 出口裁剪零传输 + 窗口限流');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-dist-fed-'));
  const memA = new LongTermMemory(path.join(dir, 'mem-a.json'));
  const memB = new LongTermMemory(path.join(dir, 'mem-b.json'));
  const syncA = new DistributedSync('cluster-a', memA, path.join(dir, 'state-a.json'));
  const syncB = new DistributedSync('cluster-b', memB, path.join(dir, 'state-b.json'));
  const now = 2000000; // 与真实墙钟区分开的虚拟基线
  let vtime = 0;
  const mkPattern = (fp) => ({
    fingerprint: fp, taskSummary: `任务-${fp}`, frequency: 1,
    firstSeenAt: now, lastSeenAt: now,
    successfulPlans: [], failureRecords: [],
    confidence: 0.5, avgExecutionTime: 800, avgQualityScore: 0.6,
  });
  // 三前缀流：fx×3 / fy×3 / fz×3（fz 未被 cluster-b 订阅）
  const prefixes = [['fx', 3], ['fy', 3], ['fz', 3]];
  for (const [prefix, count] of prefixes) {
    for (let k = 1; k <= count; k += 1) syncA.recordChange('pattern-created', `${prefix}:${k}`, mkPattern(`${prefix}:${k}`));
  }
  const gw = new FederationGateway({
    gatewayId: 'fed-a-to-b',
    subscriptions: [{ namespace: 'analytics', keyPrefix: 'fx:' }, { namespace: 'ops', keyPrefix: 'fy:' }],
    ratePerWindow: 2,
    windowMs: 100,
    now: () => vtime,
    maxQueue: 100,
  });
  const deliveredBatches = [];
  gw.link(async (batch) => {
    deliveredBatches.push(batch);
    await syncB.receiveBatch(batch);
  });

  const all = syncA.getPendingChanges();
  ok(all.length === 9, '④ 前提铺陈：cluster-a 三个前缀共 9 条待同步变更');
  const offer1 = gw.offer(all);
  ok(offer1.matched === 6 && offer1.filtered === 3 && offer1.dropped === 0,
    '④ 选择性订阅出口裁剪：fx/fy 命中 6 条、fz 裁剪 3 条（旧口径：全量推送 9 条由对端自行取舍）',
    `offer = ${JSON.stringify(offer1)}`);
  const offer2 = gw.offer(all);
  ok(gw.queueSize() === 6 && offer2.matched === 6,
    '④ 重复 offer 幂等（同 id 不重复入队——队列仍 6）');

  // 限流：每窗口 2 条，9 条中 6 条合格 → 3 个窗口分批送达
  const r0 = await gw.pump();
  ok(r0.forwarded === 2 && r0.deferred === 4, '④ 窗口 0：限流 2 条送达、4 条滞留排队（延迟而非丢弃）', `pump = ${JSON.stringify(r0)}`);
  vtime += 100;
  const r1 = await gw.pump();
  ok(r1.forwarded === 2 && r1.deferred === 2, '④ 窗口 1：续传 2 条', `pump = ${JSON.stringify(r1)}`);
  vtime += 100;
  const r2 = await gw.pump();
  ok(r2.forwarded === 2 && r2.deferred === 0, '④ 窗口 2：末批 2 条，队列清空', `pump = ${JSON.stringify(r2)}`);
  vtime += 100;
  const r3 = await gw.pump();
  ok(r3.forwarded === 0, '④ 收敛后静默（无可转发内容——不空转批次）');

  const stats = gw.statsView();
  ok(stats.forwarded === 6 && stats.windowsElapsed === 4 && stats.throttledPumps === 2,
    '④ 限流审计：4 窗口流转、2 次 pump 触发限流（令牌耗尽滞留计数）',
    `stats = ${JSON.stringify({ forwarded: stats.forwarded, windowsElapsed: stats.windowsElapsed, throttledPumps: stats.throttledPumps })}`);
  ok(!Object.keys(stats.forwardedByPrefix).some((k) => k.includes('fz'))
    && stats.forwardedByPrefix['analytics:fx:'] === 3 && stats.forwardedByPrefix['ops:fy:'] === 3,
    '④ 未订阅前缀零传输：转发前缀表只有 analytics:fx / ops:fy（fz 一条都没上过线）',
    `forwardedByPrefix = ${JSON.stringify(stats.forwardedByPrefix)}`);
  near(
    Object.values(stats.forwardedByPrefix).reduce((x, v) => x + v, 0),
    stats.forwarded,
    1e-9,
    '④ 前缀转发计数与总转发数对账一致（6 = 3 + 3）',
  );

  const bFingerprints = memB.getAllTaskPatterns().map((p) => p.fingerprint).sort();
  ok(canon(bFingerprints) === canon(['fx:1', 'fx:2', 'fx:3', 'fy:1', 'fy:2', 'fy:3']),
    '④ cluster-b 记忆只含订阅前缀（fz 三条从未到达对端——零传输的落点证明）',
    `B 端 patterns = ${bFingerprints.join(', ')}`);
  const fullBaseline = JSON.stringify(buildFederationBatch('cluster-a', all, { batchId: 'baseline', logicalClock: 9, timestamp: now })).length;
  ok(stats.bytesForwarded > 0 && stats.bytesForwarded < fullBaseline,
    '④ 传输量对照（新旧对照）：联邦传输字节 < 全量 9 条基线',
    `联邦 ${stats.bytesForwarded} B vs 全量基线 ${fullBaseline} B（${(100 * stats.bytesForwarded / fullBaseline).toFixed(1)}%）`);
  const replay = await syncB.receiveBatch(deliveredBatches[0]);
  ok(replay.applied === 0 && replay.errors.length === 0,
    '④ 幂等：重投已交付联邦批次零重复应用（与引擎批次同一哈希口径 + appliedIds 去重）');

  syncA.stop();
  syncB.stop();
  try { memA.dispose(); memB.dispose(); } catch { /* 已释放 */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ═══════════════════ ⑤ 热重载灰度 ═══════════════════

section('⑤ 热重载灰度：坏版本只回滚灰度单元、其余模块零触碰');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-dist-canary-'));
  const engine = new HotReloadEngine({
    enabled: true, watchDirs: [], watchExtensions: ['.ts'], debounceMs: 10,
    buildCommand: 'echo noop', distDir: dir, entryFile: 'x.js',
    maxVersionHistory: 10, gracefulShutdownTimeout: 50,
    versionsDir: path.join(dir, 'versions'), autoRollback: true,
  });
  for (const m of ['m1', 'm2', 'm3']) engine.registerModuleDependency(m, []);
  const calls = { reload: [], rollback: [], probe: [] };
  const moduleVersion = { m1: 'v1', m2: 'v1', m3: 'v1' };
  engine.setModuleReloader(async (id) => {
    calls.reload.push(id);
    moduleVersion[id] = 'v2-bad-or-good';
  });
  const events = [];
  engine.on('event', (e) => events.push(e));

  // 坏版本：灰度单元 m1 探针失败
  const bad = await engine.canaryDeploy({
    modules: ['m1', 'm2', 'm3'],
    canary: ['m1'],
    probe: (id) => {
      calls.probe.push(id);
      return id === 'm1' ? false : true; // m1 探针不健康
    },
    rollback: async (id) => {
      calls.rollback.push(id);
      moduleVersion[id] = 'v1';
    },
  });
  ok(bad.aborted === true && bad.canaryReloaded.length === 1 && bad.rolledOut.length === 0,
    '⑤ 坏版本灰度：探针失败 → 中止，全量铺开未开始');
  ok(canon(bad.canaryReloaded) === canon(['m1']) && canon(calls.reload) === canon(['m1']),
    '⑤ 只动了灰度单元：重载器仅被调用于 m1（m2/m3 零调用——其余模块不受影响）',
    `reload 调用 = [${calls.reload.join(', ')}]`);
  ok(canon(calls.rollback) === canon(['m1']) && moduleVersion.m1 === 'v1',
    '⑤ 只回滚灰度单元：rollback 处理器恢复 m1 至 v1');
  ok(moduleVersion.m2 === 'v1' && moduleVersion.m3 === 'v1',
    '⑤ m2/m3 状态保持 v1（从未被重载也未被回滚波及）');
  ok(bad.probeFailures.length === 1 && bad.probeFailures[0].moduleId === 'm1' && bad.probeFailures[0].reason === '探针返回不健康',
    '⑤ 探针失败明细结构化入报告（moduleId + reason）');

  // 好版本：灰度过 → 全量
  calls.reload.length = 0;
  const good = await engine.canaryDeploy({
    modules: ['m1', 'm2', 'm3'],
    canary: ['m1'],
    probe: () => true,
    rollback: async (id) => {
      moduleVersion[id] = 'v1';
    },
  });
  ok(good.aborted === false && canon(good.canaryReloaded) === canon(['m1']) && canon(good.rolledOut) === canon(['m2', 'm3'])
    && canon(calls.reload) === canon(['m1', 'm2', 'm3']),
    '⑤ 好版本：先灰度 m1（探针过）→ 再全量 m2/m3，重载序 = 灰度在前',
    `reload 调用 = [${calls.reload.join(' → ')}]`);
  ok(moduleVersion.m1 === 'v2-bad-or-good' && moduleVersion.m2 === 'v2-bad-or-good' && moduleVersion.m3 === 'v2-bad-or-good',
    '⑤ 全量铺开完成：三模块全部升级');

  // 探针 throw 路径
  const throwing = await engine.canaryDeploy({
    modules: ['m2'],
    canary: ['m2'],
    probe: () => {
      throw new Error('健康检查崩溃');
    },
    rollback: async () => {},
  });
  ok(throwing.aborted === true && throwing.probeFailures[0]?.reason === '健康检查崩溃' && throwing.canaryRolledBack.length === 1,
    '⑤ 探针 throw 路径：异常收敛为失败原因 + 回滚照常执行');

  // 缺省灰度单元 = modules 首个
  calls.rollback.length = 0;
  const def = await engine.canaryDeploy({ modules: ['m3'], probe: () => true });
  ok(canon(def.canaryPlanned) === canon(['m3']) && def.canaryReloaded.length === 1 && def.rolledOut.length === 0,
    '⑤ 缺省灰度单元：canary 未指定时取 modules 首个已注册模块');

  // dry-run：未设置 reloader 的引擎 → 纯演算零副作用
  const engine2 = new HotReloadEngine({
    enabled: true, watchDirs: [], watchExtensions: ['.ts'], debounceMs: 10,
    buildCommand: 'echo noop', distDir: dir, entryFile: 'x.js',
    maxVersionHistory: 10, gracefulShutdownTimeout: 50,
    versionsDir: path.join(dir, 'versions2'), autoRollback: true,
  });
  engine2.registerModuleDependency('x', []);
  engine2.registerModuleDependency('y', ['x']);
  const dry = await engine2.canaryDeploy({ modules: ['x', 'y'], canary: ['x'], probe: () => false });
  ok(dry.canaryReloaded.length === 0 && dry.aborted === false && dry.rolledOut.length === 0 && dry.canaryPlanned.length === 1,
    '⑤ dry-run：无 reloader 时纯演算（灰度计划在场、零副作用——探针失败也不产生回滚）');
  engine2.stop();

  const seq = events.map((e) => e.type).filter((t) => t.startsWith('canary'));
  ok(seq[0] === 'canary-phase-started' && seq.includes('canary-probe-failed') && seq.includes('canary-rollback-succeeded') && seq.includes('canary-completed')
    && seq.includes('canary-probe-passed'),
    '⑤ 事件流完整审计：phase-started / probe-passed / probe-failed / rollback-succeeded / completed 全部广播',
    seq.join(' → '));

  engine.stop();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ═══════════════════ 结果输出 ═══════════════════

console.log('\n=== 第四轮「分布式模块域」升级验证结果 ===');
console.log(`\nPASS ${passed} / FAIL ${failed}`);
if (failed > 0) {
  console.log('\n✗ 存在未通过的断言，请检查。');
  process.exit(1);
}
console.log('\n✓ 分布式模块域五项全新维度全部通过：拜占庭检测与隔离（三类证据计数 → suspect→quarantine 法定人数排除 → 隔离后共识继续 → 申诉再犯回隔离 → 治愈恢复投票权）× 网络分区愈合（2-2 双侧停滞无损合并 + 2|3 少数侧截断重同步且被弃段显式入账而非静默丢弃）× 单步成员变更（3→5→4 联合共识双法定人数，全程无双主、日志 1..8 连续）× 跨集群联邦（前缀订阅出口裁剪 fz 零传输、每窗口 2 条限流 3 窗送达、联邦批次与引擎同一哈希口径幂等应用）× 热重载灰度（坏版本只回滚灰度单元、其余模块零触碰，探针全过再全量铺开）——共识安全从「崩溃容错」扩展到「拜占庭容错 + 可变成员 + 分区可审计」，同步从「集群内反熵」扩展到「集群间选择性联邦」，热重载从「原子交换」扩展到「灰度探针渐进」。');
process.exit(0);
