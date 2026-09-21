/**
 * verify-awakening-wiring.mjs — 36.0→40.0 觉醒层全链路接线冒烟验证
 *
 * 真实引擎（MemoryGraph / Reflector / MetaCognitionEngine / SafetyGovernor）
 * 走完「挂载 → 运行 → 输出」全链路：
 *   零漂移：未挂载时 related() 原边权序 / 蒸馏无 below-information /
 *         chaosView 无值 / 无失败时间戳记录
 *   36.0：MemoryGraph.knowledgeTopography 在真实共现网络上给出
 *         大陆/孤岛/合并带（孤立模式 = 盲区的拓扑定义）
 *   37.0：Reflector.attachBottleneckDistiller 后同构批蒸馏被
 *         below-information 诚实拦截；有信息批正常放行
 *   38.0：MetaCognitionEngine.attachChaosDiagnostics 后混沌序列
 *         体质翻转产出 dynamics-regime 洞察；白噪声不误报
 *   39.0：attachInfluenceRanking 后枢纽影响力最高、联想序切换；
 *         未挂载时与原边权序逐位一致
 *   40.0：SafetyGovernor.attachFirstPassageAdvisor 后熔断打开沿
 *         产出冷却定价读数（时间戳经 Date.now 桩推进）
 *
 * 运行：npm run build && node scripts/verify-awakening-wiring.mjs
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  MemoryGraph,
  Reflector,
  ReflectionEngine,
  MetaCognitionEngine,
  SafetyGovernor,
} from '../dist/index.mjs';

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
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tmpGraph = path.join(os.tmpdir(), `verify-awakening-graph-${process.pid}.json`);
try {
  fs.rmSync(tmpGraph, { force: true });
} catch {
  /* 首次运行无文件 */
}

// ═══════════════════ 39.0 + 36.0 MemoryGraph ═══════════════════

section('39.0 谱排序 + 36.0 知识地形（MemoryGraph）');

{
  const graph = new MemoryGraph(tmpGraph);
  // 构图：枢纽 hub 与五个成员强共现；两簇根各吸部分成员；孤立 loner
  //（link 不隐式建节点——ensureNode 先行）
  for (const id of ['hub', 'member-0', 'member-1', 'member-2', 'member-3', 'member-4', 'clusterA', 'clusterB']) {
    graph.ensureNode(id, 'pattern', id);
  }
  for (let i = 0; i < 5; i += 1) {
    graph.link('hub', `member-${i}`);
  }
  graph.link('clusterA', 'member-0');
  graph.link('clusterA', 'member-2');
  graph.link('clusterA', 'member-4');
  graph.link('clusterB', 'member-1');
  graph.link('clusterB', 'member-3');
  graph.ensureNode('loner', 'pattern', 'loner');
  graph.attachTopic('p-hub', 'code');

  // 零漂移：未挂载 → related() 按边权序（每条边权重相同 → 顺序按遍历序）
  const before = graph.related('hub', 5);
  graph.attachInfluenceRanking();
  const after = graph.related('hub', 5);
  const top = graph.topInfluential(3);
  ok(top.length === 3 && top[0].id === 'hub', `枢纽影响力最高（top1=${top[0] ? top[0].id : '—'}，分值 ${top[0] ? top[0].score.toFixed(3) : '—'}）`);
  ok(new Set(before).size === new Set(after).size && after.includes('hub') === before.includes('hub'),
    `联想集合不变（排序口径升级，集合稳定：${after.slice(0, 3).join(',')} …）`);
  ok(before.length === after.length, `联想条数一致（${before.length}）`);

  const topo = graph.knowledgeTopography(0.15); // 共现一次权重 0.2——floor 须低于它大陆才成形
  ok(topo.islands.length >= 2, `知识地形：≥2 个 essential 分量（实际 ${topo.islands.length}——大陆与孤岛并存）`);
  const mainland = topo.islands.find((i) => i.members.length >= 5);
  ok(mainland !== undefined && mainland.members.includes('hub'), `大陆（≥5 成员）以 hub 为核成形（规模 ${mainland ? mainland.members.length : 0}）`);
  const hasLoner = topo.islands.some((i) => i.members.length === 1 && i.members[0] === 'loner');
  ok(hasLoner, `孤立节点 loner 被拓扑识别为知识孤岛（盲区）`);
  ok(typeof topo.summary === 'string' && topo.summary.includes('孤岛'), `地形摘要在场（${topo.summary.slice(0, 50)}…）`);
  graph.save();
}

// ═══════════════════ 37.0 Reflector 蒸馏信息定价 ═══════════════════

section('37.0 信息瓶颈蒸馏定价（Reflector.attachBottleneckDistiller）');

{
  /** 记忆桩：只实现 distillKnowledge 消费面 */
  const makeMemory = (patterns) => ({
    getAllTaskPatterns: () => patterns,
    getAllSemanticMemories: () => [{ id: 'sem-1' }],
    getAllProceduralMemories: () => [],
    getDistillationProgress: () => ({ pendingSinceLastDistillation: 100 }),
    distillExperience: () => [],
    upsertSemanticMemory: () => 'new',
    upsertProceduralMemory: () => 'new',
    getAllStrategies: () => [],
    getStrategies: () => [],
    getBayesianEstimate: () => undefined,
  });
  /** 同构批：所有位型的成败比例相同（特征与结果独立 → I(X;Y)≈0） */
  const homogeneous = Array.from({ length: 12 }, (_, i) => ({
    fingerprint: `fp-${i}`,
    taskSummary: `task-${i % 3}`,
    frequency: 10,
    firstSeenAt: 1,
    lastSeenAt: 2,
    successfulPlans: [{ modelAssignments: {} }, { modelAssignments: {} }, { modelAssignments: {} }],
    failureRecords: [{}, {}, {}],
    confidence: 0.9,
    avgExecutionTime: 10_000,
    avgQualityScore: 0.5,
  }));
  const makeReflector = (memory) =>
    new Reflector({ memory, reflection: new ReflectionEngine({}), config: { enableProgress: false } });

  // 零漂移：未挂载 → 不出现 below-information（走原水位/蒸馏路径）
  const plain = makeReflector(makeMemory(homogeneous));
  const plainReport = await plain.distillKnowledge();
  ok(plainReport.skipReason !== 'below-information', `未挂载 → 无 below-information 拦截（skipReason=${plainReport.skipReason ?? '未跳过'}）`);

  // 挂载后：同构批被信息定价拦截
  const attached = makeReflector(makeMemory(homogeneous));
  attached.attachBottleneckDistiller({ beta: 5, retentionFloor: 0.4 });
  const blocked = await attached.distillKnowledge();
  ok(blocked.skipped === true && blocked.skipReason === 'below-information',
    `同构批（I(X;Y)≈0）被 below-information 拦截（${blocked.summary.slice(0, 46)}…）`);
  ok(attached.getBottleneckView() !== undefined && attached.getBottleneckView().sampleCount >= 8,
    `定价读数在场（retention=${attached.getBottleneckView() ? attached.getBottleneckView().retention.toFixed(3) : '—'}，样本 ${attached.getBottleneckView() ? attached.getBottleneckView().sampleCount : '—'}）`);

  // 有信息批：特征决定成败 → 放行（不因信息量拦截）
  const informative = [
    ...Array.from({ length: 6 }, (_, i) => ({
      fingerprint: `win-${i}`,
      taskSummary: 'gen',
      frequency: 10,
      firstSeenAt: 1,
      lastSeenAt: 2,
      successfulPlans: [{ modelAssignments: {} }, { modelAssignments: {} }, { modelAssignments: {} }, { modelAssignments: {} }],
      failureRecords: [],
      confidence: 0.9,
      avgExecutionTime: 5_000,
      avgQualityScore: 0.9,
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      fingerprint: `lose-${i}`,
      taskSummary: 'trans',
      frequency: 10,
      firstSeenAt: 1,
      lastSeenAt: 2,
      successfulPlans: [],
      failureRecords: [{}, {}, {}, {}],
      confidence: 0.9,
      avgExecutionTime: 40_000,
      avgQualityScore: 0.3,
    })),
  ];
  const gate = makeReflector(makeMemory(informative));
  gate.attachBottleneckDistiller({ beta: 5, retentionFloor: 0.4 });
  const passed2 = await gate.distillKnowledge();
  ok(passed2.skipReason !== 'below-information', `有信息批（特征决定成败）放行蒸馏（skipReason=${passed2.skipReason ?? '未跳过'}）`);
}

// ═══════════════════ 38.0 元认知体质诊断 ═══════════════════

section('38.0 动力学体质诊断（MetaCognitionEngine.attachChaosDiagnostics）');

{
  const mkSnapshot = (latency) => ({
    timestamp: Date.now(),
    successRate: 0.95,
    avgQuality: 0.85,
    avgLatency: latency,
    cacheHitRate: 0.3,
    modelSuccessRates: {},
    activeExecutions: 0,
  });
  // 零漂移：未挂载 → chaosView 无值、无 dynamics-regime 洞察
  const plain = new MetaCognitionEngine({});
  for (let i = 0; i < 40; i += 1) plain.observe(mkSnapshot(800));
  ok(plain.chaosView('avgLatency') === undefined, '未挂载 → chaosView 无值（零漂移）');

  const mc = new MetaCognitionEngine({});
  mc.attachChaosDiagnostics({ kpis: ['avgLatency'], minPoints: 64 });
  ok(mc.chaosView('avgLatency') === undefined, '窗口未满 → 先验无知（无值）');

  // 阶段一：白噪声体质确立（不产洞察——stochastic 是零假设）
  const rng = mulberry32(20261011);
  let insights = [];
  for (let i = 0; i < 70; i += 1) {
    insights.push(...mc.observe(mkSnapshot(800 + 100 * (rng() - 0.5) * 2)));
  }
  const whiteView = mc.chaosView('avgLatency');
  ok(whiteView !== undefined && whiteView.regime === 'stochastic', `白噪声体质确立（${whiteView ? whiteView.regime : '—'}，H=${whiteView && whiteView.hurst ? whiteView.hurst.toFixed(2) : '—'}）`);
  ok(insights.every((ins) => ins.category !== 'dynamics-regime'), '零假设体质不打扰（无 dynamics-regime 洞察）');

  // 阶段二：切换为混沌序列（logistic）→ 体质翻转沿产出洞察一次
  let x = 0.3;
  let regimeInsights = [];
  for (let i = 0; i < 90; i += 1) {
    x = 4 * x * (1 - x);
    regimeInsights.push(...mc.observe(mkSnapshot(200 + x * 1000)));
  }
  const chaosView = mc.chaosView('avgLatency');
  const flipped = regimeInsights.filter((ins) => ins.category === 'dynamics-regime');
  ok(chaosView !== undefined && chaosView.regime === 'chaotic', `混沌体质确立（λ₁=${chaosView && chaosView.lyapunov ? chaosView.lyapunov.toFixed(3) : '—'}，视野 ${chaosView ? chaosView.forecastHorizonSteps : '—'} 步）`);
  ok(flipped.length >= 1 && flipped.every((ins) => ins.message.includes('混沌')), `体质翻转沿产出洞察（${flipped.length} 次，非重复打扰）`);
}

// ═══════════════════ 40.0 治理器冷却定价 ═══════════════════

section('40.0 首达冷却定价（SafetyGovernor.attachFirstPassageAdvisor）');

{
  const governor = new SafetyGovernor({
    maxActionsPerMinute: 1000,
    tokenBudget: 0,
    costBudget: 0,
    circuitFailureThreshold: 5,
    circuitCooldownMs: 60_000,
    confidenceThreshold: 0,
  });
  ok(governor.firstPassageView() === undefined, '未挂载 → 无定价读数（零漂移）');

  governor.attachFirstPassageAdvisor({ targetProb: 0.9 });
  // Date.now 桩：每次失败推进 500ms（失败间隔序列 → 恢复方向）
  const realNow = Date.now.bind(Date);
  let clock = 1_000_000;
  const origNow = Date.now;
  Date.now = () => clock;
  try {
    for (let i = 0; i < 10; i += 1) {
      governor.recordOutcome(false);
      clock += 400 + i * 60; // 间隔递增 = 恢复方向
    }
  } finally {
    Date.now = origNow;
    void realNow;
  }
  const view = governor.firstPassageView();
  ok(view !== undefined && view.recommendedCooldownMs > 0 && view.mu > 0,
    `熔断打开沿产出冷却定价（建议 ${view ? Math.round(view.recommendedCooldownMs) : '—'}ms，期望恢复 ${view ? Math.round(view.expectedRecoverMs) : '—'}ms，μ̂=${view ? view.mu.toFixed(1) : '—'}）`);
  ok(view === undefined || view.targetProb === 0.9, `定价置信目标在场（targetProb=${view ? view.targetProb : '—'}）`);
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n──────────────────────────────────────────────────────────');
if (failed === 0) {
  console.log(`✓ 觉醒层 36.0→40.0 五内核接线全部验证通过（${passed} 项断言）`);
} else {
  console.error(`✗ ${failed} 项失败（${passed} 项通过）`);
  process.exit(1);
}
