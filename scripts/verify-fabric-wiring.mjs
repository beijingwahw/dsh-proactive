/**
 * verify-fabric-wiring.mjs — 46.0→50.0 经纬层全链路接线冒烟验证
 *
 * 真实引擎（RaftEngine / DistributedSync / CryptoEngine /
 * MetaCognitionEngine / ModelScheduler）走完「挂载 → 运行 → 输出」：
 *   46.0：RaftEngine.quorumAudit 在真实集群配置上给出闭式安全读数
 *   47.0：DistributedSync CRDT 通道：两实例乱序 gossip → 收敛一致
 *   48.0：CryptoEngine shardKey/combineKeyShares 真实分形重建 +
 *         auditKeyEntropy 密钥原料审计
 *   49.0：MetaCognitionEngine.attachWaveletView 后多尺度读数在场
 *         （零漂移：未挂载无值）
 *   50.0：ModelScheduler.attachLatentFactors 后能力矩阵补全 + 冷启动
 *         外推可用（零漂移：未挂载无值）
 *
 * 运行：npm run build && node scripts/verify-fabric-wiring.mjs
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

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
function section(title) {
  console.log(`\n■ ${title}`);
}

const tmpBase = path.join(os.tmpdir(), `verify-fabric-${process.pid}`);
fs.rmSync(tmpBase, { recursive: true, force: true });
fs.mkdirSync(tmpBase, { recursive: true });

// ═══════════════════ 46.0 Raft 法定人数审计 ═══════════════════

section('46.0 Raft 法定人数审计（RaftEngine.quorumAudit）');

{
  const { RaftEngine } = await import('../dist/index.mjs');
  const engine = new RaftEngine({
    localNodeId: 'n1',
    cluster: ['n1', 'n2', 'n3', 'n4', 'n5'].map((id) => ({ id, host: '127.0.0.1', port: 9000 })),
    electionTimeoutMin: 150,
    electionTimeoutMax: 300,
    heartbeatInterval: 50,
    consensusPort: 9000,
    logPath: path.join(tmpBase, 'raft.json'),
  });
  const audit = engine.quorumAudit();
  ok(audit.nodes === 5 && audit.quorumSize === 3 && audit.minIntersection === 1,
    `五节点集群闭式读数（q=${audit.quorumSize}，最小交集 ${audit.minIntersection}——多数派安全性被检查而非相信）`);
  ok(audit.crashFaultTolerance === 2 && audit.byzantineTolerance === 0,
    `容错读数（崩溃 ${audit.crashFaultTolerance}，拜占庭 ${audit.byzantineTolerance}——n=5 容不下拜占庭双坏）`);
  ok(typeof audit.verdict === 'string' && audit.verdict.length > 0, `审计结论文本在场（${audit.verdict.slice(0, 40)}…）`);
}

// ═══════════════════ 47.0 Sync CRDT 收敛通道 ═══════════════════

section('47.0 分布式同步 CRDT 通道（DistributedSync）');

{
  const { DistributedSync, LongTermMemory } = await import('../dist/index.mjs');
  const mkSync = (nodeId) =>
    new DistributedSync(nodeId, new LongTermMemory(path.join(tmpBase, `mem-${nodeId}.json`)), path.join(tmpBase, `sync-${nodeId}.json`));
  const a = mkSync('node-a');
  const b = mkSync('node-b');
  a.attachCrdtChannel(['executions', 'lessons']);
  b.attachCrdtChannel(['executions', 'lessons']);
  // 双方乱序递增
  a.incrementCrdtCounter('executions', 3);
  b.incrementCrdtCounter('executions', 2);
  a.incrementCrdtCounter('lessons', 1);
  b.incrementCrdtCounter('lessons', 5);
  // 乱序 + 重复合并的 gossip
  a.mergeCrdtState(b.crdtState());
  b.mergeCrdtState(a.crdtState());
  a.mergeCrdtState(b.crdtState()); // 重复投递
  const canonDeep = (obj) => {
    const out = {};
    for (const k of Object.keys(obj).sort()) {
      const v = obj[k];
      out[k] = typeof v === 'object' && v !== null ? canonDeep(v) : v;
    }
    return out;
  };
  const sa = JSON.stringify(canonDeep(a.crdtState()));
  const sb = JSON.stringify(canonDeep(b.crdtState()));
  const execA = Object.values(a.crdtState().executions ?? {}).reduce((s, v) => s + v, 0);
  const execB = Object.values(b.crdtState().executions ?? {}).reduce((s, v) => s + v, 0);
  ok(sa === sb, `乱序 + 重复 gossip 后两副本状态逐位一致（强最终一致性）`);
  ok(execA === 5 && execB === 5, `计数收敛到全局真值 5（a=${execA}, b=${execB}）`);
}

// ═══════════════════ 48.0 Crypto 秘密共享 ═══════════════════

section('48.0 加密引擎秘密共享（CryptoEngine）');

{
  const { CryptoEngine } = await import('../dist/index.mjs');
  const engine = new CryptoEngine({ enabled: true, masterKey: 'a'.repeat(64), algorithm: 'aes-256-gcm', sensitiveFields: [] });
  const keyHex = CryptoEngine.generateKey();
  const shares = engine.shardKey(keyHex, 5, 3);
  ok(shares.length === 5, `主密钥分形为 5 份（阈值 3）`);
  const rebuilt = engine.combineKeyShares([shares[1], shares[3], shares[4]]);
  ok(rebuilt === keyHex, `任意 3 份（2,4,5 号）重建精确成功`);
  const audit = engine.auditKeyEntropy(keyHex);
  ok(audit.passed && audit.bytes === 32, `密钥原料随机性审计通过（频数+游程，${audit.bytes} 字节）`);
}

// ═══════════════════ 49.0 元认知小波视图 ═══════════════════

section('49.0 元认知多尺度视图（MetaCognitionEngine）');

{
  const { MetaCognitionEngine } = await import('../dist/index.mjs');
  const mkSnapshot = (latency, t) => ({
    timestamp: t,
    successRate: 0.95,
    avgQuality: 0.85,
    avgLatency: latency,
    cacheHitRate: 0.3,
    modelSuccessRates: {},
    activeExecutions: 0,
  });
  const plain = new MetaCognitionEngine({});
  for (let t = 0; t < 80; t += 1) plain.observe(mkSnapshot(800, t));
  ok(plain.waveletView('avgLatency') === undefined, '未挂载 → 无多尺度读数（零漂移）');

  const mc = new MetaCognitionEngine({});
  mc.attachWaveletView({ kpis: ['avgLatency'], minPoints: 64 });
  ok(mc.waveletView('avgLatency') === undefined, '窗口未满 → 先验无知（无值）');
  // 慢趋势 + 末端突发
  for (let t = 0; t < 90; t += 1) {
    const latency = 800 + (t === 87 ? 5000 : 0); // 单点大幅突发（与基线能量可比）
    mc.observe(mkSnapshot(latency, t));
  }
  const view = mc.waveletView('avgLatency');
  ok(view !== undefined && view.burstShare > 0.02,
    `末端突发被最细尺度捕获（burstShare=${view ? view.burstShare.toFixed(2) : '—'}，趋势水平 ${view ? Math.round(view.trendLevel) : '—'}ms）`);
}

// ═══════════════════ 50.0 调度器潜因子 ═══════════════════

section('50.0 调度器潜因子补全（ModelScheduler.attachLatentFactors）');

{
  const { LLMClient, ModelScheduler } = await import('../dist/index.mjs');
  const llm = new LLMClient();
  // 低秩构造：模型按两个潜能力族给分；model-new 只在两个类型上有观测
  llm.registerModel({ id: 'm1', endpoint: 'x', initialCapabilities: { taskScores: { code: 0.9, doc: 0.85, trans: 0.4 } } });
  llm.registerModel({ id: 'm2', endpoint: 'x', initialCapabilities: { taskScores: { code: 0.88, doc: 0.83, trans: 0.42 } } });
  llm.registerModel({ id: 'm3', endpoint: 'x', initialCapabilities: { taskScores: { code: 0.45, doc: 0.5, trans: 0.9 } } });
  llm.registerModel({ id: 'm-new', endpoint: 'x', initialCapabilities: { taskScores: { code: 0.89, doc: 0.84 } } }); // trans 未知
  const memory = { getBayesianEstimate: () => undefined };
  const scheduler = new ModelScheduler({ llm, memory, config: { explorationEnabled: false } });

  ok(scheduler.getLatentFactorReport() === undefined && scheduler.coldStartEstimate('m-new', 'trans') === undefined,
    '未挂载 → 无补全读数（零漂移）');
  scheduler.attachLatentFactors({ rank: 2 });
  const report = scheduler.getLatentFactorReport();
  ok(report !== undefined && report.lowRankShare > 0.8,
    `能力矩阵低秩补全在场（lowRankShare=${report ? report.lowRankShare.toFixed(2) : '—'}，RMSE=${report ? report.trainRmse.toFixed(3) : '—'}）`);
  const estimate = scheduler.coldStartEstimate('m-new', 'trans');
  const m1Trans = scheduler.coldStartEstimate('m1', 'trans');
  ok(estimate !== undefined && estimate < 0.6,
    `冷启动外推：m-new 的 trans 能力预测 ≈ ${estimate !== undefined ? estimate.toFixed(2) : '—'}（低——它属于 code/doc 强族，与 m1 的 ${m1Trans !== undefined ? m1Trans.toFixed(2) : '—'} 同族）`);
}

// 临时目录不即时删除（LongTermMemory 后台持久化与清理竞态；os.tmpdir 由系统回收）

// ═══════════════════ 汇总 ═══════════════════
console.log('\n──────────────────────────────────────────────────────────');
if (failed === 0) {
  console.log(`✓ 经纬层 46.0→50.0 五内核接线全部验证通过（${passed} 项断言）`);
} else {
  console.error(`✗ ${failed} 项失败（${passed} 项通过）`);
  process.exit(1);
}
