/**
 * verify-flux-wiring.mjs — 41.0→45.0 川流层全链路接线冒烟验证
 *
 * 真实引擎（WorldModel / ModelScheduler / TaskExecutor / CuriosityEngine /
 * BenchmarkEngine）走完「挂载 → 运行 → 输出」全链路：
 *   零漂移：未挂载时预测/探索/基准与升级前一致（键不出现）
 *   42.0：WorldModel.attachSpectralCalendar 后昼夜节律被 Fisher g 判定
 *         显著、季节因子启用（period ≈ 24h）；无节律史回退直方图口径
 *   43.0：ModelScheduler.attachCapacityFrontier 后执行批回写真实需求，
 *         getCapacityFrontier 给出 max-flow 值与钳制归因
 *   44.0：CuriosityEngine.attachFairBudget 后多域盲区不再被单域通吃
 *         （每个活跃域拿到 ≥1 名额）；未挂载时原口径
 *   45.0：BenchmarkEngine.attachOcbaAllocator 后 runAll 报告附加
 *         bottleneckFocus（候选 = 最慢场景 + OCBA 分配）
 *
 * 运行：npm run build && node scripts/verify-flux-wiring.mjs
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  WorldModel,
  ModelScheduler,
  TaskExecutor,
  CuriosityEngine,
  BenchmarkEngine,
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

// ═══════════════════ 42.0 世界模型谱日历 ═══════════════════

section('42.0 谱日历（WorldModel.attachSpectralCalendar）');

{
  const rng = mulberry32(20261017);
  // 昼夜节律史：整整 5 天（120 小时，与 24h 周期对齐防低频包络），
  // 每小时到达数 = 10 + 6·sin(2π·hourOfDay/24) + 抖动；最近 10 分钟注入
  const mkModel = () => {
    const wm = new WorldModel();
    const now = Date.now();
    const hourMs = 3_600_000;
    for (let hAgo = 120; hAgo >= 1; hAgo -= 1) {
      const at = now - hAgo * hourMs;
      const hourOfDay = new Date(at).getHours();
      const count = Math.max(0, Math.round(10 + 6 * Math.sin((2 * Math.PI * hourOfDay) / 24) + (rng() - 0.5) * 3));
      for (let c = 0; c < count; c += 1) {
        wm.observeArrival('signal', at + Math.floor(rng() * hourMs));
      }
    }
    for (let m = 0; m < 8; m += 1) {
      wm.observeArrival('signal', now - m * 60_000);
    }
    return wm;
  };

  // 零漂移：未挂载 → 无谱状态
  const plain = mkModel();
  ok(plain.getSpectralCalendarStatus() === undefined, '未挂载 → 无谱状态（零漂移）');

  const spectral = mkModel();
  spectral.attachSpectralCalendar({ bins: 128 });
  const pred = spectral.predictArrivals(5 * 60_000)[0];
  const status = spectral.getSpectralCalendarStatus();
  ok(status !== undefined && status.significant,
    `昼夜节律被 Fisher g 判定显著（period≈${status ? (status.periodHours ?? 0).toFixed(1) : '—'}h，样本 ${status ? status.samples : '—'}）`);
  ok(status !== undefined && (status.periodHours ?? 0) >= 14 && (status.periodHours ?? 0) <= 34,
    `显著周期落在近昼夜带 [14,34]h（实际 ${status ? (status.periodHours ?? 0).toFixed(1) : '—'}h，含补零插值偏差）`);
  ok(pred !== undefined && pred.expectedCount > 0, `预测读数在场（expected=${pred ? pred.expectedCount : '—'}）`);

  // 无节律史：泊松均匀（有抖动，谱良定义）→ 不显著 → 回退直方图口径
  const flat = new WorldModel();
  const now2 = Date.now();
  for (let hAgo = 120; hAgo >= 1; hAgo -= 1) {
    const count = Math.max(0, Math.round(10 + (rng() - 0.5) * 6));
    for (let c = 0; c < count; c += 1) {
      flat.observeArrival('flat', now2 - hAgo * 3_600_000 + Math.floor(rng() * 3_600_000));
    }
  }
  for (let m = 0; m < 8; m += 1) flat.observeArrival('flat', now2 - m * 60_000);
  flat.attachSpectralCalendar({ bins: 128 });
  flat.predictArrivals(5 * 60_000);
  const flatStatus = flat.getSpectralCalendarStatus();
  ok(flatStatus !== undefined && !flatStatus.significant,
    `均匀到达无节律 → 不显著（g 检验诚实回退）`);
}

// ═══════════════════ 43.0 容量前沿（真实执行链路） ═══════════════════

section('43.0 容量前沿（ModelScheduler.attachCapacityFrontier × TaskExecutor）');

{
  const { LLMClient } = await import('../dist/index.mjs');
  const llm = new LLMClient();
  llm.registerModel({ id: 'm1', endpoint: 'http://mock.local', maxConcurrency: 2, initialCapabilities: { taskScores: { t1: 0.9, t2: 0.5 } } });
  llm.registerModel({ id: 'm2', endpoint: 'http://mock.local', maxConcurrency: 2, initialCapabilities: { taskScores: { t1: 0.5, t2: 0.9 } } });
  const memory = { getBayesianEstimate: () => undefined };
  const scheduler = new ModelScheduler({ llm, memory, config: { explorationEnabled: false } });

  ok(scheduler.getCapacityFrontier() === undefined, '未挂载 → 无前沿读数（零漂移）');
  scheduler.attachCapacityFrontier();
  ok(scheduler.getCapacityFrontier() === undefined, '挂载但未执行 → 仍无读数（先验无知）');

  const executor = new TaskExecutor({
    config: { qualityThreshold: 0.5, maxRetries: 0, globalTimeout: 10_000, nodeTimeout: 5_000, enableProgress: false, verbose: false },
    llm,
    modelScheduler: scheduler,
    nodeRunner: async () => ({ output: 'ok', quality: 0.9, tokensUsed: 10 }),
  });
  const plan = {
    objective: 'frontier',
    parallelismStrategy: 'layered',
    source: 'fallback',
    nodes: [
      { id: 'n1', description: 'a', type: 't1', dependsOn: [] },
      { id: 'n2', description: 'b', type: 't1', dependsOn: [] },
      { id: 'n3', description: 'c', type: 't2', dependsOn: [] },
      { id: 'n4', description: 'd', type: 't2', dependsOn: [] },
      { id: 'n5', description: 'e', type: 't2', dependsOn: [] },
    ],
  };
  const signal = { id: 'sig-f', type: 't1', description: '前沿', payload: {}, receivedAt: Date.now(), source: 'verify', occurrences: 1 };
  await executor.executePlan(signal, plan);
  const frontier = scheduler.getCapacityFrontier();
  ok(frontier !== undefined && frontier.maxDispatch === 4,
    `执行批回写真实需求 → 前沿 = 总并发容量 4（实际 ${frontier ? frontier.maxDispatch : '—'}，5 节点需求被容量钳制）`);
  ok(frontier !== undefined && frontier.bindingConstraints.length > 0,
    `钳制归因在场（割边 ${frontier ? frontier.bindingConstraints.length : 0} 条——模型容量侧）`);
}

// ═══════════════════ 44.0 好奇心公平预算 ═══════════════════

section('44.0 公平预算（CuriosityEngine.attachFairBudget）');

{
  // 知识桩：gen-* 三型中高新颖（plain top-k 会通吃 gen 家族）；
  // review 高失败 + 极低接触 → 新颖度反超 gen；translate 低新颖
  const providerMany = {
    getExposure: () => ({ 'gen-a': 5, 'gen-b': 5, 'gen-c': 5, 'review-doc': 1, 'translate-zh': 3 }),
    getExperienceCounts: () => ({ 'gen-a': 0, 'gen-b': 0, 'gen-c': 0, 'review-doc': 0, 'translate-zh': 1 }),
    getFailureRates: () => ({ 'gen-a': 0.7, 'gen-b': 0.7, 'gen-c': 0.7, 'review-doc': 0.95, 'translate-zh': 0.2 }),
  };
  const domainOf = (t) => t.split('-')[0];
  const plain = new CuriosityEngine(providerMany);
  const plainProposals = plain.proposeExplorations(14);
  const fair = new CuriosityEngine(providerMany);
  fair.attachFairBudget();
  const fairProposals = fair.proposeExplorations(14);
  ok(plainProposals.length > 0 && fairProposals.length > 0,
    `两口径均产出探索建议（plain=${plainProposals.length}，fair=${fairProposals.length}）`);
  const plainDomains = new Set(plainProposals.map((p) => domainOf(p.taskType)));
  const fairDomains = new Set(fairProposals.map((p) => domainOf(p.taskType)));
  ok(fairDomains.size >= 2 && fairDomains.size >= plainDomains.size,
    `公平口径覆盖更多域（fair=${[...fairDomains].join('+')} ≥ plain=${[...plainDomains].join('+')}——高权重非 gen 域不再被饿死）`);
  ok(fairProposals.length <= 4, `预算守恒（fair 产出 ${fairProposals.length} ≤ 预算 4）`);
}

// ═══════════════════ 45.0 基准 OCBA 瓶颈聚焦 ═══════════════════

section('45.0 OCBA 瓶颈聚焦（BenchmarkEngine.attachOcbaAllocator）');

{
  const dir = path.join(os.tmpdir(), `verify-flux-bench-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const bench = new BenchmarkEngine(dir);
  const rng = mulberry32(20261018);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  bench.registerScenario({
    name: 'fast-path',
    description: '快场景',
    target: 'memory',
    concurrency: 2,
    totalRequests: 12,
    warmupRequests: 0,
    timeout: 5000,
    execute: async () => {
      await sleep(3);
      return { success: true, latency: 3 + rng() };
    },
  });
  bench.registerScenario({
    name: 'slow-path',
    description: '慢场景（瓶颈候选）',
    target: 'memory',
    concurrency: 2,
    totalRequests: 12,
    warmupRequests: 0,
    timeout: 5000,
    execute: async () => {
      await sleep(15);
      return { success: true, latency: 15 + 8 * rng() };
    },
  });

  // 零漂移：未挂载 → 无 bottleneckFocus 键
  const plainReport = await bench.runAll();
  ok(plainReport.bottleneckFocus === undefined, '未挂载 → 报告无 bottleneckFocus（零漂移）');

  bench.attachOcbaAllocator({ confirmationBudget: 60 });
  const report = await bench.runAll();
  ok(report.bottleneckFocus !== undefined && report.bottleneckFocus.candidate === 'slow-path',
    `瓶颈聚焦候选 = 最慢场景（${report.bottleneckFocus ? report.bottleneckFocus.candidate : '—'}）`);
  const alloc = report.bottleneckFocus ? report.bottleneckFocus.allocation : [];
  ok(alloc.length === 2 && alloc.reduce((s, a) => s + a.count, 0) === 60,
    `OCBA 分配守恒（Σ=${alloc.reduce((s, a) => s + a.count, 0)} = 60）`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n──────────────────────────────────────────────────────────');
if (failed === 0) {
  console.log(`✓ 川流层 41.0→45.0 五内核接线全部验证通过（${passed} 项断言）`);
} else {
  console.error(`✗ ${failed} 项失败（${passed} 项通过）`);
  process.exit(1);
}
