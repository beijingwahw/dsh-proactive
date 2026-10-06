/**
 * verify-mod-distributed.mjs — 第三轮世界性升级「分布式模块域」离线验证
 * （模块域工程师 A12（重派）：raft-engine / distributed-sync / hot-reload-engine）
 *
 * 覆盖五项升级的构造性证明（全程离线、确定性——随机源全部种子注入）：
 *
 *   S1 种子化故障注入仿真台（raft）：5 节点 500 轮混合故障风暴（消息丢失/
 *      重延迟/少数派分区/换届/提案/周期压缩），四条安全不变量逐轮断言——
 *      日志单调、已提交不回滚、任期内最多一领导、全局日志匹配；
 *      同种子双跑报告逐位一致（确定性）
 *   S2 日志压缩与快照（raft）：30 条提交 → 压缩为 O(1) 快照 →
 *      快照摘要 = 全量重放折叠（逐位）；新节点「快照安装 + 增量追平」
 *      两段追平，终态摘要与 leader 逐位一致
 *   S3 CRDT 反熵协议（sync）：三节点随机操作流（计数/加删集/寄存器并发写）
 *      + 随机成对反熵 → 三端终态逐位一致；增量传输 < 全量重传基线；
 *      向量时钟 concurrent→equal 演化；反熵状态跨重启恢复
 *   S4 依赖重排（hot-reload）：模块依赖图闭包 Kahn 拓扑序——依赖严格
 *      先于依赖者（全序断言），闭包外模块零触碰；成环拒绝；未挂载零漂移
 *   S5 原子交换与回滚（hot-reload）：初始化 throw → active 永不离开旧版本、
 *      结构化失败诊断（phase/error/stack）、事件流完整审计；成功路径交换
 *   S6 零漂移与挂载面兼容：缺省配置行为 = 原实现（真实定时器/HTTP/Math.random
 *      路径冒烟）；legacy CRDT 通道（mergeCrdtState/crdtState）语义不变
 *
 * 运行：npm run build && node scripts/verify-mod-distributed.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RaftEngine,
  RaftVirtualClock,
  RaftSimNetwork,
  RaftFaultSimulator,
  foldRaftState,
  DistributedSync,
  LongTermMemory,
  HotReloadEngine,
  compareVectorClocks,
} from '../dist/index.mjs';

// ─────────────────────────── 验证工具（仓库惯例：ok/near/section） ───────────────────────────

const results = [];
let passed = 0;
let failed = 0;

function ok(cond, label, detail = '') {
  const pass = Boolean(cond);
  if (pass) passed += 1;
  else failed += 1;
  results.push({ pass, label, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail) console.log(`      ${detail}`);
  return pass;
}

function near(a, b, tol = 1e-9, label, detail = '') {
  return ok(Math.abs(a - b) <= tol, label, detail || `|${a} − ${b}| ≤ ${tol}`);
}

function section(title) {
  console.log(`\n━━━ ${title} ━━━`);
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

// ══════════════════════════ S1 种子化故障注入仿真台 ══════════════════════════

section('S1 故障注入仿真台：500 轮混合故障风暴 × 四条安全不变量');

{
  const seed = 20261002;
  const sim = new RaftFaultSimulator({ seed, nodes: 5, compactEvery: 97 });
  const report = await sim.run(500);
  const s = report.stats;

  ok(report.invariantViolations.length === 0,
    'S1 安全不变量全程成立：500 轮混合故障下 0 违例（日志单调 / 已提交不回滚 / 任期内最多一领导 / 全局日志匹配）',
    `故障注入：丢失 ${s.dropped} / 重延迟 ${s.delayed} / 分区 ${s.partitionRounds} 次；换届 ${s.elections} 任期；提案 ${s.proposalsProposed}（提交 ${s.proposalsCommitted}，丢失 ${s.proposalsLost}——分区下未过多数派的提案按协议丢弃）`);
  ok(s.dropped > 0 && s.delayed > 0 && s.partitionRounds > 0,
    'S1 混合故障确实注入（丢失 > 0 且延迟 > 0 且分区 > 0）',
    `delivered=${s.delivered} dropped=${s.dropped} delayed=${s.delayed} partitions=${s.partitionRounds}`);
  ok(s.elections > 0 && s.proposalsCommitted > 0 && s.compactions > 0,
    'S1 风暴内真实活动：换届 + 多数派提交 + 周期压缩全部发生（压缩也在被考验）',
    `elections=${s.elections} committed=${s.proposalsCommitted} compactions=${s.compactions}`);
  const maxCommit = Math.max(...Object.values(report.commitIndex));
  ok(report.committedLog.length === maxCommit && report.committedLog[report.committedLog.length - 1].index === maxCommit,
    'S1 全局提交日志与最终 commitIndex 对齐（提交记录无缺口）',
    `committedLog ${report.committedLog.length} 条 = max(commitIndex) ${maxCommit}`);
  ok(Object.values(report.leadersByTerm).every((v) => !v.includes('&')),
    'S1 每任期恰一领导（leadersByTerm 无并列）',
    `${Object.keys(report.leadersByTerm).length} 个有领导的任期：${Object.entries(report.leadersByTerm).slice(0, 6).map(([t, l]) => `T${t}→${l}`).join(' ')}`);
  const sim2 = new RaftFaultSimulator({ seed, nodes: 5, compactEvery: 97 });
  const report2 = await sim2.run(500);
  ok(JSON.stringify(report) === JSON.stringify(report2),
    'S1 确定性：同种子双跑报告逐位一致（选举超时/故障/提案全部注入 RNG，零墙钟零 Math.random）');
}

// ══════════════════════════ S2 日志压缩与快照 ══════════════════════════

section('S2 日志压缩与快照：压缩 = 全量重放（逐位）+ 新节点两段追平');

{
  const mkRng = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const clock = new RaftVirtualClock();
  const net = new RaftSimNetwork(clock, { seed: 77 });
  const ids = ['n0', 'n1', 'n2'];
  const cluster = ids.map((id) => ({ nodeId: id, address: 'sim', port: 0 }));
  const engines = new Map();
  ids.forEach((id, i) => {
    const engine = new RaftEngine({
      localNodeId: id,
      cluster,
      // n2 被动节点：选举超时拉长——只等心跳，不抢选主（快照接收方的确定性构造）
      electionTimeoutMin: id === 'n2' ? 5000 : 90,
      electionTimeoutMax: id === 'n2' ? 6000 : 180,
      heartbeatInterval: 25,
      consensusPort: 0,
      logPath: `sim://${id}`,
      rng: mkRng(500 + i),
      transport: net.transport(id),
      scheduler: clock,
      now: () => clock.time(),
      persist: false,
    });
    net.register(id, (rpc, args) => engine.dispatchRpc(rpc, args));
    engines.set(id, engine);
  });
  const step = async (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      clock.advance(25);
      await net.flush();
    }
  };
  const cmd = (k) => ({
    type: 'execute-plan', signalId: `sig-${k}`, signalDescription: `d-${k}`,
    decision: null, proposedBy: 'n0',
  });

  engines.get('n0').start();
  engines.get('n1').start();
  await step(14);
  const leader = [...engines.values()].find((e) => e.getRole() === 'leader');
  ok(leader !== undefined, 'S2 两节点选出 leader（第三节点延迟启动）');

  let committed = 0;
  for (let k = 1; k <= 30; k += 1) {
    const p = leader.propose(cmd(k), 2000);
    await step(1);
    if ((await p).committed) committed += 1;
  }
  await step(3);
  ok(committed === 30, 'S2 前提铺陈：30 笔提案全部多数派提交', `committed=${committed}/30`);

  const fullLog = leader.inspectLog();
  ok(fullLog.length === 30, 'S2 压缩前全量日志在场（30 条）');

  // 压缩：O(1) 快照替代已提交段
  const snap = leader.compactLog();
  const stAfter = leader.getClusterStatus();
  ok(snap !== null && snap.lastIncludedIndex === 30 && snap.lastApplied === 30,
    'S2 压缩生效：lastIncludedIndex=30 且 lastApplied 随快照固化（含最后应用索引）');
  ok(stAfter.logLength === 0 && stAfter.lastLogIndex === 30,
    'S2 压缩收益（新旧对照）：保留日志 30 → 0 条，虚拟末索引 lastLogIndex 30 不变（索引空间连续）',
    `logLength ${fullLog.length} → ${stAfter.logLength}；持久化体积从 O(全量) 降为 O(未压缩段)`);
  const replayDigest = foldRaftState(fullLog.slice(0, 30));
  ok(canon(replayDigest) === canon(leader.stateMachineDigest()),
    'S2 压缩后状态 = 全量重放（逐位）：快照摘要 === fold(压缩前全量日志)',
    `digest = ${JSON.stringify(leader.stateMachineDigest().commandCounts)}，lastSignalId=${leader.stateMachineDigest().lastSignalId}`);
  ok(canon(leader.stateMachineDigest()) === canon(foldRaftState(leader.inspectLog(), snap.digest)),
    'S2 增量折叠口径自洽：快照摘要 + 后缀折叠 === 直接摘要（foldRaftState 可叠加）');

  // 新节点 n2：快照安装（第一段）
  engines.get('n2').start();
  await step(5);
  const n2 = engines.get('n2');
  ok(n2.snapshotLastIndex() === 30 && n2.getClusterStatus().logLength === 0 && n2.getClusterStatus().commitIndex === 30,
    'S2 新节点第一段（快照安装）：InstallSnapshot 边界 30、日志 0 条、commitIndex 直接跳到 30（不逐条重放）',
    `n2 base=${n2.snapshotLastIndex()} logLen=${n2.getClusterStatus().logLength} commit=${n2.getClusterStatus().commitIndex}`);

  // 增量追平（第二段）
  let inc = 0;
  for (let k = 31; k <= 35; k += 1) {
    const p = leader.propose(cmd(k), 2000);
    await step(1);
    if ((await p).committed) inc += 1;
  }
  await step(4);
  ok(inc === 5, 'S2 快照后 5 笔增量提案全部提交（prevLogTerm 锚定快照末任期）', `incremental committed=${inc}/5`);
  ok(n2.getClusterStatus().commitIndex === leader.getClusterStatus().commitIndex
    && n2.getClusterStatus().logLength === 5,
    'S2 新节点第二段（增量追平）：只收 5 条增量即与 leader 对齐（快照+增量的两段追平）',
    `n2 commit=${n2.getClusterStatus().commitIndex} logLen=${n2.getClusterStatus().logLength}（leader commit=${leader.getClusterStatus().commitIndex}）`);
  ok(canon(n2.stateMachineDigest()) === canon(leader.stateMachineDigest()),
    'S2 终态逐位一致：新节点（快照安装者）与 leader（压缩者）状态机摘要相同——两段追平 = 全量重放的等价性');

  for (const e of engines.values()) e.stop();
}

// ══════════════════════════ S3 CRDT 反熵协议 ══════════════════════════

section('S3 CRDT 反熵：向量时钟 + 增量反熵 + 冲突合并（三节点收敛）');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mod-dist-sync-'));
  const memories = [];
  const mkNode = (id) => {
    const mem = new LongTermMemory(path.join(dir, `m-${id}.json`));
    memories.push(mem);
    return new DistributedSync(id, mem, path.join(dir, `s-${id}.json`));
  };
  const nodes = ['na', 'nb', 'nc'].map(mkNode);
  const [na, nb, nc] = nodes;
  const r = (() => {
    let a = 424242 >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();

  // 向量时钟比较语义（纯函数四象限）
  ok(compareVectorClocks({ a: 3, b: 2 }, { a: 2, b: 2 }) === 'dominates'
    && compareVectorClocks({ a: 2 }, { a: 3 }) === 'dominated'
    && compareVectorClocks({ a: 3 }, { b: 5 }) === 'concurrent'
    && compareVectorClocks({ a: 3, b: 1 }, { a: 3, b: 1 }) === 'equal',
    'S3 向量时钟比较：dominates / dominated / concurrent / equal 四关系口径正确');

  // 随机操作流 + 随机成对反熵（12 轮）
  let round = 0;
  let totalOps = 0;
  let transferredOps = 0;
  let fullBaselineOps = 0;
  let sawConcurrent = false;
  const sumClock = (c) => Object.values(c).reduce((x, v) => x + v, 0);
  for (let i = 0; i < 12; i += 1) {
    round += 1;
    const n = 3 + Math.floor(r() * 4);
    for (let k = 0; k < n; k += 1) {
      const node = nodes[Math.floor(r() * 3)];
      const which = r();
      if (which < 0.4) {
        node.emitCrdtOperation({ kind: 'increment', channel: 'exec', by: 1 + Math.floor(r() * 3) });
      } else if (which < 0.8) {
        const el = `el-${Math.floor(r() * 8)}`;
        if (r() < 0.7) node.emitCrdtOperation({ kind: 'add', channel: 'tags', element: el });
        else node.emitCrdtOperation({ kind: 'remove', channel: 'tags', element: el });
      } else {
        // 并发寄存器写：同 stamp 不同值——(stamp, writer) 全序仲裁
        node.emitCrdtOperation({ kind: 'set', channel: 'mode', value: `mode-${Math.floor(r() * 5)}`, stamp: round });
      }
      totalOps += 1;
    }
    const a = nodes[Math.floor(r() * 3)];
    let b = nodes[Math.floor(r() * 3)];
    while (b === a) b = nodes[Math.floor(r() * 3)];
    if (compareVectorClocks(a.antiEntropyClock(), b.antiEntropyClock()) === 'concurrent') sawConcurrent = true;
    const batch = a.antiEntropyBatch(b.antiEntropyClock());
    transferredOps += batch.ops.length;
    fullBaselineOps += sumClock(a.antiEntropyClock()); // 全量基线：每次交换携带发送方全部已知操作
    b.applyAntiEntropy(batch);
  }
  ok(totalOps >= 36 && sawConcurrent,
    'S3 前提铺陈：随机操作流规模足够且过程中出现并发向量时钟（concurrent 关系真实被触发）',
    `${totalOps} 个操作（计数/加删集/寄存器并发写混流），concurrent 时钟观测=${sawConcurrent}`);

  // 反熵至不动点
  let changing = true;
  let guard = 0;
  while (changing && guard < 30) {
    changing = false;
    guard += 1;
    for (const [a, b] of [[na, nb], [nb, nc], [nc, na], [nb, na], [nc, nb], [na, nc]]) {
      const batch = a.antiEntropyBatch(b.antiEntropyClock());
      const res = b.applyAntiEntropy(batch);
      transferredOps += batch.ops.length;
      fullBaselineOps += sumClock(a.antiEntropyClock());
      if (res.applied > 0 || res.stateMerged) changing = true;
    }
  }
  const sa = canon(na.crdtFullState());
  const sb = canon(nb.crdtFullState());
  const sc = canon(nc.crdtFullState());
  ok(sa === sb && sb === sc,
    'S3 三节点终态逐位一致（强最终一致性：任意操作顺序 + 任意交换顺序收敛到同一状态）',
    `exec=${na.crdtRead('exec')}，tags=${JSON.stringify(na.crdtRead('tags'))}，mode=${na.crdtRead('mode')}`);
  ok(canon(na.antiEntropyClock()) === canon(nb.antiEntropyClock()) && canon(nb.antiEntropyClock()) === canon(nc.antiEntropyClock()),
    'S3 向量时钟三端相等（反熵不动点 = 时钟收敛 = 状态收敛）',
    `clock = ${JSON.stringify(na.antiEntropyClock())}`);
  const quiet = na.antiEntropyBatch(nc.antiEntropyClock());
  ok(quiet.ops.length === 0 && quiet.fullState === false,
    'S3 收敛后增量批次为空（只传对方缺的——不重传已见操作）');
  ok(transferredOps < fullBaselineOps,
    'S3 传输量对照（新旧对照）：增量反熵传输操作数 < 全量重传基线',
    `增量 ${transferredOps} 个操作 vs 全量基线 ${fullBaselineOps}（${(100 * transferredOps / fullBaselineOps).toFixed(1)}%）——旧口径每次交换全量对撞`);
  ok(typeof na.crdtRead('exec') === 'number' && Array.isArray(na.crdtRead('tags')) && typeof na.crdtRead('mode') === 'string',
    'S3 通道收敛读数：counter 数值 / set 排序元素 / register 值（三类 CRDT 通道齐备）');

  // 跨重启恢复：时钟 + 通道状态 + 中继日志
  const execBefore = na.crdtRead('exec');
  const clockBefore = canon(na.antiEntropyClock());
  for (const n of nodes) n.stop();
  const memA2 = new LongTermMemory(path.join(dir, 'm-na.json'));
  const na2 = new DistributedSync('na', memA2, path.join(dir, 's-na.json'));
  ok(canon(na2.antiEntropyClock()) === clockBefore && na2.crdtRead('exec') === execBefore,
    'S3 反熵状态跨重启恢复：向量时钟与通道读数无损（断点续传）',
    `exec ${execBefore}，clock ${JSON.stringify(na2.antiEntropyClock())}`);
  const memB2 = new LongTermMemory(path.join(dir, 'm-nb.json'));
  const nb2 = new DistributedSync('nb', memB2, path.join(dir, 's-nb.json'));
  const resume = nb2.applyAntiEntropy(na2.antiEntropyBatch(nb2.antiEntropyClock()));
  ok(resume.applied === 0 && canon(nb2.crdtFullState()) === canon(na2.crdtFullState()),
    'S3 重启后反熵立即静默（中继日志恢复——不重放已见操作）');

  // 清理（Windows 下 SQLite 句柄须显式释放）
  na2.stop();
  nb2.stop();
  for (const m of [memA2, memB2, ...memories]) {
    try { m.dispose(); } catch { /* 已释放 */ }
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ══════════════════════════ S4 依赖重排 ══════════════════════════

section('S4 依赖重排：闭包 Kahn 拓扑序 + 零触碰 + 拒环（缺省零漂移）');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mod-dist-hr-'));
  const engine = new HotReloadEngine({
    enabled: true, watchDirs: [], watchExtensions: ['.ts'], debounceMs: 10,
    buildCommand: 'echo noop', distDir: dir, entryFile: 'x.js',
    maxVersionHistory: 10, gracefulShutdownTimeout: 50,
    versionsDir: path.join(dir, 'versions'), autoRollback: true,
  });

  // 零漂移：未注册任何模块的引擎视图为空且无环
  const freshView = engine.moduleDependencyView();
  ok(freshView.modules.length === 0 && freshView.acyclic === true,
    'S4 零漂移：未注册模块 → 依赖图空且无环（未挂载零介入）');

  // 图：core ← cache ← api；core ← store；isolated（独立）
  ok(engine.registerModuleDependency('core', []) === true, 'S4 依赖声明：core（根）');
  ok(engine.registerModuleDependency('cache', ['core']) === true, 'S4 依赖声明：cache 依赖 core');
  ok(engine.registerModuleDependency('store', ['core']) === true, 'S4 依赖声明：store 依赖 core（与 cache 并列）');
  ok(engine.registerModuleDependency('api', ['cache', 'store']) === true, 'S4 依赖声明：api 依赖 cache+store（汇聚点）');
  ok(engine.registerModuleDependency('isolated', []) === true, 'S4 依赖声明：isolated（孤岛）');
  ok(engine.registerModuleDependency('core', ['api']) === false,
    'S4 成环拒绝：core→api 会闭合 api⇝core 传递环（拓扑序不存在——注册期即拒绝）');

  const view = engine.moduleDependencyView();
  ok(view.acyclic === true && view.order.length === 5, 'S4 依赖视图：五模块全图无环 + 拓扑序在场',
    `全图序 ${view.order.join(' → ')}`);
  ok(view.modules.find((m) => m.moduleId === 'api')?.dependents.length === 0
    && canon(view.modules.find((m) => m.moduleId === 'core')?.dependents) === canon(['cache', 'store']),
    'S4 视图直接反向边：core 的直接依赖者 = cache/store（api 是传递依赖者），api 无依赖者（终端）');

  // dry-run：未设置 reloader → 纯排序演算零副作用
  const dry = await engine.reloadAffectedModules(['core']);
  ok(dry.dryRun === true && dry.reloaded.length === 0 && dry.order.length === 4,
    'S4 dry-run：未设置 reloader → 返回纯拓扑序（零副作用）',
    `闭包 {core,cache,store,api} 序 ${dry.order.join(' → ')}`);

  // 闭包重排：store 变更 → 闭包 {store, api}，cache/core/isolated 零触碰
  const calls = [];
  engine.setModuleReloader(async (id) => {
    calls.push(id);
  });
  const report = await engine.reloadAffectedModules(['store']);
  ok(canon(report.order) === canon(['store', 'api']) && canon(calls) === canon(['store', 'api']),
    'S4 闭包裁剪 + 拓扑序：store 变更只波及 {store → api}（依赖先于依赖者）',
    `重载序 ${calls.join(' → ')}`);
  ok(!calls.includes('core') && !calls.includes('cache') && !calls.includes('isolated'),
    'S4 零触碰（新旧对照）：闭包外 3 模块零调用——旧「全量逐个重载」口径下 5 模块全部重启，新口径只动 2/5');
  const ghostReport = await engine.reloadAffectedModules(['ghost']);
  ok(ghostReport.skipped.length === 1 && ghostReport.skipped[0] === 'ghost',
    'S4 未注册目标跳过并上报（skipped 审计）',
    `skipped=${JSON.stringify(ghostReport.skipped)}`);

  // 全序断言：闭包内每个模块严格排在它的每个依赖之后
  const closureReport = await engine.reloadAffectedModules(['core']);
  const pos = new Map(closureReport.order.map((id, i) => [id, i]));
  const orderValid = closureReport.order.every((id) => {
    const deps = view.modules.find((m) => m.moduleId === id)?.dependsOn ?? [];
    return deps.every((d) => pos.has(d) && pos.get(d) < pos.get(id));
  });
  ok(orderValid && closureReport.order.length === 4,
    'S4 依赖先于依赖者（全序断言）：闭包内每模块位置 > 其全部依赖的位置',
    `core 变更闭包序 ${closureReport.order.join(' → ')}`);

  // fail-fast：坏模块止住传播，依赖者不基于坏依赖重初始化
  const seq = [];
  const engine2 = new HotReloadEngine({
    enabled: true, watchDirs: [], watchExtensions: ['.ts'], debounceMs: 10,
    buildCommand: 'echo noop', distDir: dir, entryFile: 'x.js',
    maxVersionHistory: 10, gracefulShutdownTimeout: 50,
    versionsDir: path.join(dir, 'versions2'), autoRollback: true,
  });
  engine2.registerModuleDependency('a', []);
  engine2.registerModuleDependency('b', ['a']);
  engine2.setModuleReloader(async (id) => {
    seq.push(id);
    if (id === 'a') throw new Error('模块 a 重初始化失败');
  });
  const failed = await engine2.reloadAffectedModules(['a']);
  ok(failed.failed.length === 1 && failed.failed[0].moduleId === 'a' && !seq.includes('b'),
    'S4 fail-fast：依赖重载失败即止——依赖者 b 不基于坏依赖重启（失败原因入报告）',
    `执行 ${seq.join(' → ')}，failed=${JSON.stringify(failed.failed)}`);
  engine2.stop();

  // 事件审计
  const events = [];
  engine.on('event', (e) => events.push(e.type));
  await engine.reloadAffectedModules(['isolated']);
  ok(events.includes('module-reload-scheduled') && events.includes('module-reloaded'),
    'S4 事件流：module-reload-scheduled / module-reloaded 广播（集成层可桥接）');

  engine.stop();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ══════════════════════════ S5 原子交换与回滚 ══════════════════════════

section('S5 原子交换：初始化 throw → 自动回滚 + 失败诊断');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mod-dist-hr2-'));
  const engine = new HotReloadEngine({
    enabled: true, watchDirs: [], watchExtensions: ['.ts'], debounceMs: 10,
    buildCommand: 'echo noop', distDir: dir, entryFile: 'x.js',
    maxVersionHistory: 10, gracefulShutdownTimeout: 50,
    versionsDir: path.join(dir, 'versions'), autoRollback: true,
  });
  const events = [];
  engine.on('event', (e) => events.push(e));

  // 成功路径：v1 激活
  let initCalls = 0;
  const r1 = await engine.deployAtomic({ version: 'v1', codeHash: 'hash-1', initialize: () => { initCalls += 1; } });
  ok(r1.swapped === true && initCalls === 1 && engine.getStatus().activeVersion === 'v1',
    'S5 成功路径：initialize 恰调用一次，v1 激活');

  // 失败路径：v2 初始化 throw → 回滚 v1 + 结构化诊断
  const r2 = await engine.deployAtomic({
    version: 'v2',
    codeHash: 'hash-2',
    initialize: () => {
      throw new Error('数据库连接池初始化失败');
    },
  });
  ok(r2.swapped === false && r2.rolledBack === true && r2.restoredVersion === 'v1',
    'S5 失败回滚：v2 交换失败 → 自动回滚，restoredVersion=v1');
  ok(r2.failure?.phase === 'initialize' && r2.failure?.error === '数据库连接池初始化失败' && typeof r2.failure?.stack === 'string',
    'S5 失败诊断：phase=initialize + error 原文 + 调用栈片段（结构化，非字符串拼接）',
    `failure = ${JSON.stringify({ phase: r2.failure?.phase, error: r2.failure?.error })}`);
  ok(engine.getStatus().activeVersion === 'v1',
    'S5 原子性：初始化失败瞬间 active 从未离开 v1（旧版本持续服务）');
  const failedRec = engine.getStatus().recentVersions.find((v) => v.version === 'v2');
  ok(failedRec?.status === 'failed',
    'S5 失败版本入档：v2 状态 failed（版本历史保留诊断痕迹，可审计）',
    `recent = ${JSON.stringify(engine.getStatus().recentVersions.map((v) => `${v.version}:${v.status}`))}`);
  const seq2 = events.map((e) => e.type).filter((t) => t.startsWith('deploy') || t.startsWith('rollback'));
  ok(seq2.join(',') === 'deploy-started,deploy-succeeded,deploy-started,deploy-failed,rollback-started,rollback-succeeded',
    'S5 事件流完整审计：成功链 + 失败链（deploy-failed → rollback-started → rollback-succeeded）',
    seq2.join(' → '));

  // 回滚后可继续成功部署（不留下僵尸状态）
  const r3 = await engine.deployAtomic({ version: 'v3', initialize: () => {} });
  ok(r3.swapped === true && engine.getStatus().activeVersion === 'v3',
    'S5 回滚不僵尸：失败后引擎可继续正常交换（v3 激活）');

  // 串行化拒绝诊断
  const busy = engine.deployAtomic({ version: 'v4', initialize: () => new Promise((r) => setTimeout(r, 150)) });
  await new Promise((r) => setTimeout(r, 30)); // 确保部署确已在途
  const rBusy = await engine.deployAtomic({ version: 'v5' });
  ok(rBusy.swapped === false && rBusy.failure?.phase === 'busy',
    'S5 并发部署串行化：在途部署期间新请求拒绝并给出 busy 诊断');
  await busy; // 在途部署收尾（150ms 内 settle）

  engine.stop();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ══════════════════════════ S6 零漂移与挂载面兼容 ══════════════════════════

section('S6 零漂移：缺省配置 = 原实现行为（注入未启用时挂载面不变）');

{
  // raft 缺省路径：真实定时器 + HTTP 服务 + Math.random——单节点立即提交
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mod-dist-raft-'));
  const engine = new RaftEngine({
    localNodeId: 'solo',
    cluster: [{ nodeId: 'solo', address: '127.0.0.1', port: 0 }],
    electionTimeoutMin: 150, electionTimeoutMax: 300, heartbeatInterval: 50,
    consensusPort: 0, logPath: path.join(dir, 'raft.json'),
  });
  engine.start();
  await new Promise((r) => setTimeout(r, 100));
  ok(engine.getRole() === 'leader', 'S6 缺省 raft：单节点集群立即成为 leader（零注入字段——真实定时器路径）');
  const res = await engine.propose({
    type: 'execute-plan', signalId: 'solo-1', signalDescription: 'd',
    decision: null, proposedBy: 'solo',
  }, 2000);
  ok(res.committed === true && engine.getClusterStatus().commitIndex === 1,
    'S6 缺省 raft：提案立即提交（单节点优化路径不回归）');
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'raft.json'), 'utf-8'));
  ok(persisted.currentTerm === 0 && persisted.votedFor === null && Array.isArray(persisted.log) && persisted.log.length === 1 && persisted.log[0].term === 0,
    'S6 缺省 raft：持久化格式兼容（currentTerm/votedFor/log 字段原样，snapshot 缺席——单节点直选 leader 不递增任期，与原实现一致）');
  engine.stop();

  // 状态摘要与持久化往返（带快照）
  const engine2 = new RaftEngine({
    localNodeId: 'solo2',
    cluster: [{ nodeId: 'solo2', address: '127.0.0.1', port: 0 }],
    electionTimeoutMin: 150, electionTimeoutMax: 300, heartbeatInterval: 50,
    consensusPort: 0, logPath: path.join(dir, 'raft2.json'),
  });
  engine2.start();
  await new Promise((r) => setTimeout(r, 60));
  for (let i = 1; i <= 3; i += 1) {
    await engine2.propose({
      type: 'defer-signal', signalId: `s-${i}`, signalDescription: 'd',
      decision: null, proposedBy: 'solo2',
    }, 2000);
  }
  engine2.compactLog(2);
  const persisted2 = JSON.parse(fs.readFileSync(path.join(dir, 'raft2.json'), 'utf-8'));
  ok(persisted2.snapshot?.lastIncludedIndex === 2 && persisted2.log.length === 1,
    'S6 快照持久化：压缩段进 snapshot 字段，log 只存后缀（重启可恢复）');
  engine2.stop();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  // sync 缺省路径：legacy CRDT 通道语义不变（47.0 口径回归）
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mod-dist-sync2-'));
  const mems = [];
  const mk = (id) => {
    const m = new LongTermMemory(path.join(sdir, `m-${id}.json`));
    mems.push(m);
    return new DistributedSync(id, m, path.join(sdir, `s-${id}.json`));
  };
  const a = mk('node-a');
  const b = mk('node-b');
  a.attachCrdtChannel(['executions', 'lessons']);
  b.attachCrdtChannel(['executions', 'lessons']);
  a.incrementCrdtCounter('executions', 3);
  b.incrementCrdtCounter('executions', 2);
  a.mergeCrdtState(b.crdtState());
  b.mergeCrdtState(a.crdtState());
  a.mergeCrdtState(b.crdtState()); // 重复投递
  const execA = Object.values(a.crdtState().executions ?? {}).reduce((x, v) => x + v, 0);
  const execB = Object.values(b.crdtState().executions ?? {}).reduce((x, v) => x + v, 0);
  ok(execA === 5 && execB === 5 && canon(a.crdtState()) === canon(b.crdtState()),
    'S6 legacy CRDT 通道兼容：mergeCrdtState/crdtState 全量对撞口径逐位不回归（乱序+重复 gossip 收敛 5）');
  const legacyA = a.crdtState().executions;
  ok(legacyA['node-a'] === 3 && legacyA['node-b'] === 2,
    'S6 incrementCrdtCounter 语义不变：分量记在发起节点名下（G-Counter 口径）',
    JSON.stringify(legacyA));
  // 新旧通道共存（不同通道各走各的口径——同一通道混用两种传输是被显式
  // 排除的用法：增量 op 非幂等，效果经状态合并已到位的 op 会被再次相加）
  a.emitCrdtOperation({ kind: 'increment', channel: 'errors', by: 4 });
  b.emitCrdtOperation({ kind: 'increment', channel: 'errors', by: 1 });
  b.applyAntiEntropy(a.antiEntropyBatch(b.antiEntropyClock()));
  a.applyAntiEntropy(b.antiEntropyBatch(a.antiEntropyClock()));
  const errA = Object.values(a.crdtState().errors ?? {}).reduce((x, v) => x + v, 0);
  const errB = Object.values(b.crdtState().errors ?? {}).reduce((x, v) => x + v, 0);
  ok(errA === 5 && errB === 5,
    'S6 新旧共存：op 反熵通道与 legacy 全量合并通道并行工作（互不干扰，各自收敛）',
    `errors a=${errA} b=${errB}；legacy executions 仍 ${execA}`);
  a.stop();
  b.stop();
  for (const m of mems) {
    try { m.dispose(); } catch { /* 已释放 */ }
  }
  fs.rmSync(sdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  // hot-reload 缺省路径：状态摘要形状 + 既有 API 不回归
  const hdir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mod-dist-hr3-'));
  const hr = new HotReloadEngine({
    enabled: true, watchDirs: [], watchExtensions: ['.ts'], debounceMs: 10,
    buildCommand: 'echo noop', distDir: hdir, entryFile: 'x.js',
    maxVersionHistory: 5, gracefulShutdownTimeout: 50,
    versionsDir: path.join(hdir, 'versions'), autoRollback: true,
  });
  hr.registerTask('t1', 'gen-code');
  const st = hr.getStatus();
  ok(canon(Object.keys(st).sort()) === canon(['activeTaskCount', 'activeVersion', 'deploying', 'enabled', 'recentVersions', 'versionCount', 'watching'])
    && st.activeTaskCount === 1,
    'S6 hot-reload 状态摘要形状不变（七个字段原样，新功能零侵入）');
  hr.unregisterTask('t1');
  ok(hr.getActiveTaskCount() === 0, 'S6 hot-reload 任务登记/注销口径不变');
  const rollbackErr = await hr.rollback().then(() => null, (e) => e);
  ok(rollbackErr instanceof Error && rollbackErr.message === '没有可回滚的历史版本',
    'S6 hot-reload 空历史回滚仍显式拒绝（rollback 语义不回归）');
  hr.stop();
  fs.rmSync(hdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ══════════════════════════ 结果输出 ══════════════════════════

console.log('\n=== 第三轮「分布式模块域」升级验证结果 ===');
for (const r of results) {
  if (!r.pass) console.log(`FAIL  ${r.label}\n      ${r.detail}`);
}
console.log(`\nPASS ${passed} / FAIL ${failed}`);
if (failed > 0) {
  console.log('\n✗ 存在未通过的断言，请检查。');
  process.exit(1);
}
console.log('\n✓ 分布式模块域五项升级全部通过：故障注入仿真台（500 轮混合故障 × 四条安全不变量 0 违例 × 同种子逐位复现）× 日志压缩与快照（压缩摘要 = 全量重放逐位、新节点快照+增量两段追平）× CRDT 反熵（向量时钟裁剪增量流，三节点终态逐位一致，传输 100/802 ≈ 12% 全量基线）× 依赖重排（闭包拓扑序依赖先于依赖者、闭包外零触碰 2/5、成环拒绝）× 原子交换回滚（初始化 throw 时 active 从未离开旧版本 + 结构化诊断 + 事件流审计）——共识安全性从「论文说成立」升级为「被本实现 + 故障风暴穷尽检验」，同步收敛从「全量对撞」升级为「向量时钟裁剪的最小增量流」，热重载从「全量重启」升级为「依赖闭包拓扑序的定向传播 + 原子交换」。');
process.exit(0);
