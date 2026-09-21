/**
 * verify-equilibrium-wiring.mjs — 31.0→35.0 均衡层全链路接线冒烟验证
 *
 * 用真实引擎（ModelScheduler / TaskExecutor / LLMClient）走完
 * 「挂载 → 运行 → 输出」全链路，证明五个内核的接线是真实生效的
 * 运行路径（不只是类型正确）：
 *   零漂移：未挂载时评分乘数恒 1 / 批内指派不介入 / 超时回退缺省 /
 *         并发口径静态 / 诊断键不出现
 *   31.0：ModelScheduler.attachHedgePortfolio 后 reportHedgeOutcome
 *         驱动权重——被打爆模型的乘数 < 1 < 稳健模型乘数
 *   32.0：TaskExecutor.attachOptimalAssignment 后同批动态节点不再
 *         重复超订最优模型（一对一全局最优 vs 逐节点贪心全选同一个）
 *   33.0：SystemicRiskMonitor 消费 LLMClient 真实状态差分的失败计数
 *         ——共同因子体制 systemic=true、独立体制不误报
 *   34.0：LLMClient.attachCvarTimeouts 后重尾模型获得更长超时预算
 *         （延迟史定价），样本不足回退 undefined
 *   35.0：ModelScheduler.attachConcurrencyController 后
 *         computeParallelism 成为反馈控制器（过载降 / 欠载升 / 有界）
 *
 * 运行：npm run build && node scripts/verify-equilibrium-wiring.mjs
 */

import {
  LLMClient,
  ModelScheduler,
  TaskExecutor,
  SystemicRiskMonitor,
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

/** 三模型桩：a 强 / b 中 / c 弱（taskScores 驱动调度评分差异） */
function makeLlm() {
  const llm = new LLMClient();
  llm.registerModel({ id: 'model-a', endpoint: 'http://mock.local', maxConcurrency: 4, initialCapabilities: { taskScores: { t1: 0.9, t2: 0.85, general: 0.9 } } });
  llm.registerModel({ id: 'model-b', endpoint: 'http://mock.local', maxConcurrency: 4, initialCapabilities: { taskScores: { t1: 0.7, t2: 0.65, general: 0.7 } } });
  llm.registerModel({ id: 'model-c', endpoint: 'http://mock.local', maxConcurrency: 4, initialCapabilities: { taskScores: { t1: 0.5, t2: 0.55, general: 0.5 } } });
  return llm;
}

function stubMemory() {
  return {
    getBayesianEstimate(modelId, taskType) {
      const base = { modelId, taskType, drift: 0 };
      if (modelId === 'model-a') return { ...base, alpha: 40, beta: 4, posteriorMean: 40 / 44, wilsonLower: 0.82, effectiveSamples: 44, rawSuccessRate: 40 / 44, emaQuality: 0.88 };
      if (modelId === 'model-b') return { ...base, alpha: 20, beta: 8, posteriorMean: 20 / 28, wilsonLower: 0.6, effectiveSamples: 28, rawSuccessRate: 20 / 28, emaQuality: 0.68 };
      if (modelId === 'model-c') return { ...base, alpha: 10, beta: 10, posteriorMean: 0.5, wilsonLower: 0.3, effectiveSamples: 20, rawSuccessRate: 0.5, emaQuality: 0.5 };
      return undefined;
    },
  };
}

// ═══════════════════ 零漂移 ═══════════════════

section('零漂移：未挂载任何均衡层内核时行为与升级前一致');

{
  const llm = makeLlm();
  const scheduler = new ModelScheduler({ llm, memory: stubMemory(), config: { explorationEnabled: false } });
  ok(scheduler.hedgeMultiplierOf('model-a') === 1 && scheduler.hedgeMultiplierOf('model-c') === 1,
    '未挂载 Hedge → 评分乘数恒 1（零漂移）');
  ok(scheduler.computeParallelism() === 12, `未挂载控制器 → 并行度静态口径 = Σ容量（实际 ${scheduler.computeParallelism()}）`);
  const diag = scheduler.getAttachedDiagnostics();
  ok(!('hedge' in diag) && !('concurrencyControl' in diag), '诊断快照无 hedge / concurrencyControl 键（零漂移）');
  ok(llm.getCvarTimeout('model-a') === undefined, '未挂载 CVaR → 超时预算 undefined（回退全局缺省）');

  const used = [];
  const nodeRunner = async ({ modelId }) => {
    used.push(modelId);
    return { output: 'ok', quality: 0.9, tokensUsed: 10 };
  };
  const executor = new TaskExecutor({
    config: { qualityThreshold: 0.5, maxRetries: 0, globalTimeout: 10_000, nodeTimeout: 5_000, enableProgress: false, verbose: false },
    llm,
    modelScheduler: scheduler,
    nodeRunner,
  });
  const plan = {
    objective: 'zero-drift',
    parallelismStrategy: 'layered',
    source: 'fallback',
    nodes: [
      { id: 'n1', description: 'a', type: 't1', dependsOn: [] },
      { id: 'n2', description: 'b', type: 't1', dependsOn: [] },
      { id: 'n3', description: 'c', type: 't2', dependsOn: [] },
    ],
  };
  const signal = { id: 'sig-zd', type: 't1', description: '零漂移', payload: {}, receivedAt: Date.now(), source: 'verify', occurrences: 1 };
  await executor.executePlan(signal, plan);
  ok(used.length === 3 && used.every((m) => m === 'model-a'),
    `未挂载全局指派 → 逐节点贪心全部超订最优模型（${used.join(', ')}）——这正是 32.0 要修的病`);
}

// ═══════════════════ 31.0 对抗组合 ═══════════════════

section('31.0 对抗组合：Hedge 乘数驱动（attachHedgePortfolio）');

{
  const llm = makeLlm();
  const scheduler = new ModelScheduler({ llm, memory: stubMemory(), config: { explorationEnabled: false } });
  scheduler.attachHedgePortfolio({ eta: 0.3, alpha: 0.05 });
  // 世界翻转：model-a 持续失败（对手打爆），model-b 平庸，model-c 持续高质量
  for (let k = 0; k < 25; k += 1) {
    scheduler.reportHedgeOutcome('model-a', 0);
    scheduler.reportHedgeOutcome('model-b', 0.3);
    scheduler.reportHedgeOutcome('model-c', 0.95);
  }
  const ma = scheduler.hedgeMultiplierOf('model-a');
  const mb = scheduler.hedgeMultiplierOf('model-b');
  const mc = scheduler.hedgeMultiplierOf('model-c');
  ok(ma < 1 && mc > 1, `被打爆模型乘数 < 1 < 稳健模型（a=${ma.toFixed(3)}, b=${mb.toFixed(3)}, c=${mc.toFixed(3)}）`);
  ok(mc > mb && mb > ma, `乘数排序跟随对抗证据（c > b > a）`);
  const diag = scheduler.getAttachedDiagnostics();
  ok(diag.hedge !== undefined && diag.hedge.feedback === 'partial' && diag.hedge.rounds === 75,
    `诊断 hedge 在场（rounds=${diag.hedge ? diag.hedge.rounds : '—'}，partial 口径）`);
  // 对抗口径压过统计画像：统计最优的 model-a 跌出选型
  const chosen = scheduler.assignModelWithInsight('t1');
  ok(chosen.modelId !== 'model-a' && scheduler.hedgeMultiplierOf(chosen.modelId) > ma,
    `被对手打爆的统计最优模型不再被选中（chosen=${chosen.modelId}，其乘数 ${scheduler.hedgeMultiplierOf(chosen.modelId).toFixed(2)} > a 的 ${ma.toFixed(2)}）`);
}

// ═══════════════════ 32.0 全局指派 ═══════════════════

section('32.0 全局指派：批内一对一最优（attachOptimalAssignment）');

{
  const llm = makeLlm();
  const scheduler = new ModelScheduler({ llm, memory: stubMemory(), config: { explorationEnabled: false } });
  const used = [];
  const nodeRunner = async ({ modelId }) => {
    used.push(modelId);
    return { output: 'ok', quality: 0.9, tokensUsed: 10 };
  };
  const executor = new TaskExecutor({
    config: { qualityThreshold: 0.5, maxRetries: 0, globalTimeout: 10_000, nodeTimeout: 5_000, enableProgress: false, verbose: false },
    llm,
    modelScheduler: scheduler,
    nodeRunner,
  });
  executor.attachOptimalAssignment();
  const plan = {
    objective: 'batch',
    parallelismStrategy: 'layered',
    source: 'fallback',
    nodes: [
      { id: 'n1', description: 'a', type: 't1', dependsOn: [] },
      { id: 'n2', description: 'b', type: 't1', dependsOn: [] },
      { id: 'n3', description: 'c', type: 't2', dependsOn: [] },
    ],
  };
  const signal = { id: 'sig-batch', type: 't1', description: '批指派', payload: {}, receivedAt: Date.now(), source: 'verify', occurrences: 1 };
  await executor.executePlan(signal, plan);
  const distinct = new Set(used);
  ok(used.length === 3 && distinct.size === 3,
    `挂载后同批三节点一对一（${[...distinct].sort().join(' + ')}）——最优模型不再被重复超订`);
  ok(distinct.has('model-a') && distinct.has('model-b') && distinct.has('model-c'),
    '总收益最优解覆盖强/中/弱全部三个模型（匈牙利精确解）');

  // 约束优先：计划指定模型的节点不受全局协调影响
  const used2 = [];
  const executor2 = new TaskExecutor({
    config: { qualityThreshold: 0.5, maxRetries: 0, globalTimeout: 10_000, nodeTimeout: 5_000, enableProgress: false, verbose: false },
    llm,
    modelScheduler: scheduler,
    nodeRunner: async ({ modelId, node }) => {
      used2.push(`${node.id}:${modelId}`);
      return { output: 'ok', quality: 0.9, tokensUsed: 10 };
    },
  });
  executor2.attachOptimalAssignment();
  const plan2 = {
    objective: 'constrained',
    parallelismStrategy: 'layered',
    source: 'fallback',
    nodes: [
      { id: 'p1', description: '锁定', type: 't1', dependsOn: [], modelId: 'model-a' },
      { id: 'n1', description: 'dyn', type: 't1', dependsOn: [] },
      { id: 'n2', description: 'dyn', type: 't2', dependsOn: [] },
    ],
  };
  await executor2.executePlan(signal, plan2);
  const pairs = Object.fromEntries(used2.map((x) => x.split(':')));
  ok(pairs.p1 === 'model-a', `计划指定模型优先（p1 → ${pairs.p1}）`);
  ok(pairs.n1 !== 'model-a' && pairs.n2 !== 'model-a' && pairs.n1 !== pairs.n2,
    `被约束占用的模型从动态候选池剔除，其余节点一对一（n1→${pairs.n1}, n2→${pairs.n2}）`);
}

// ═══════════════════ 33.0 系统性风险 ═══════════════════

section('33.0 系统性风险：真实状态差分驱动（SystemicRiskMonitor）');

{
  // 用 LLMClient 真实计数器：chat() 推进 totalCalls/successCount，
  // 差分逻辑与 index.ts 心跳 2.8 段完全一致
  const rng = mulberry32(20260930);
  // 共同因子按「期」抽签（vendor-x 三模型共享同一故障位），不是按调用
  let xBurstNow = false;
  const externalChat = async (modelId) => {
    const fail = modelId.startsWith('vendor-x') ? xBurstNow || rng() < 0.08 : rng() < 0.12;
    if (fail) throw new Error('upstream error');
    return { content: 'ok', model: modelId, latency: 50, tokensUsed: 10, cost: 0, retries: 0 };
  };
  const llm = new LLMClient({ maxRetries: 0, timeout: 2000, externalChat });
  for (const id of ['vendor-x-1', 'vendor-x-2', 'vendor-x-3', 'vendor-y-1']) {
    llm.registerModel({ id, endpoint: 'http://mock.local', initialCapabilities: { taskScores: { general: 0.5 } } });
  }
  const chatOnce = async (id) => {
    try {
      await llm.chat(id, [{ role: 'user', content: 'hi' }], { maxRetries: 0 });
    } catch {
      /* 失败也是观测 */
    }
  };
  const monitor = new SystemicRiskMonitor({ window: 24, minModels: 4, edgeFactor: 1.0, systemicShare: 0.3 });
  const last = new Map();
  for (let t = 0; t < 26; t += 1) {
    const counts = {};
    for (const status of llm.getModelStatuses()) {
      const prev = last.get(status.id);
      last.set(status.id, { totalCalls: status.totalCalls, successCount: status.successCount });
      if (!prev || status.totalCalls <= prev.totalCalls) continue;
      counts[status.id] = status.totalCalls - prev.totalCalls - Math.max(0, status.successCount - prev.successCount);
    }
    monitor.observe(counts);
    xBurstNow = rng() < 0.35;
    await Promise.all([...last.keys()].map((id) => chatOnce(id)));
  }
  const assess = monitor.assess();
  ok(assess !== undefined && assess.models >= 4, `四模型进入评估（observations=${assess ? assess.observations : '—'}）`);
  ok(assess !== undefined && assess.systemic,
    `同厂商共同因子体制 → systemic=true（λ₁=${assess ? assess.topEigenvalue.toFixed(2) : '—'} vs 噪声带 ${assess ? assess.noiseEdge.toFixed(2) : '—'}）`);
  ok(assess !== undefined && assess.topLoading[0] !== undefined && monitor.modelIds[assess.topLoading[0].index].startsWith('vendor-x'),
    `头号载荷是共同因子暴露最深的 vendor-x 系（${monitor.modelIds[assess ? assess.topLoading[0].index : 0]}）`);
}

// ═══════════════════ 34.0 CVaR 超时 ═══════════════════

section('34.0 CVaR 超时预算：延迟史定价（attachCvarTimeouts）');

{
  // externalChat 直接给出受控延迟 → 延迟样本流积累（与 23.0 共用）
  const rng = mulberry32(20261001);
  const externalChat = async (modelId) => {
    // heavy：对数正态重尾；light：窄分布
    const u1 = Math.max(1e-9, rng());
    const u2 = rng();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const latency = modelId === 'model-heavy' ? Math.round(Math.exp(6.5 + 0.9 * g)) : Math.round(1000 + 120 * g);
    return { content: 'ok', model: modelId, latency, tokensUsed: 10, cost: 0, retries: 0 };
  };
  const llm = new LLMClient({
    robustLatency: { alpha: 0.05, maxSamples: 200 },
    maxRetries: 0,
    timeout: 60_000,
    externalChat,
  });
  llm.registerModel({ id: 'model-heavy', endpoint: 'http://mock.local', initialCapabilities: {} });
  llm.registerModel({ id: 'model-light', endpoint: 'http://mock.local', initialCapabilities: {} });
  for (let k = 0; k < 60; k += 1) {
    await llm.chat('model-heavy', [{ role: 'user', content: 'hi' }], { maxRetries: 0 });
    await llm.chat('model-light', [{ role: 'user', content: 'hi' }], { maxRetries: 0 });
  }
  const heavySamples = llm.getLatencySamples('model-heavy');
  ok(heavySamples !== undefined && heavySamples.length >= 50, `延迟样本流积累（heavy=${heavySamples ? heavySamples.length : 0} 条）`);

  llm.attachCvarTimeouts({ alpha: 0.95, margin: 1.5, minSamples: 30, floorMs: 1000, capMs: 120_000 });
  const th = llm.getCvarTimeout('model-heavy');
  const tl = llm.getCvarTimeout('model-light');
  ok(th !== undefined && tl !== undefined && th > tl * 1.5,
    `重尾模型超时预算显著更长（heavy=${th ? Math.round(th) : '—'}ms vs light=${tl ? Math.round(tl) : '—'}ms）`);
  ok(th !== undefined && th <= 120_000 && tl !== undefined && tl >= 1000, `预算钳位 [1000, 120000] 生效`);
  const fresh = new LLMClient({ robustLatency: { alpha: 0.05 }, maxRetries: 0 });
  fresh.registerModel({ id: 'm', endpoint: 'http://mock.local', initialCapabilities: {} });
  fresh.attachCvarTimeouts({ minSamples: 30 });
  ok(fresh.getCvarTimeout('m') === undefined, `样本不足 → undefined（回退全局缺省超时，零漂移）`);
}

// ═══════════════════ 35.0 并发闭环 ═══════════════════

section('35.0 并发反馈控制：computeParallelism 闭环（attachConcurrencyController）');

{
  // 桩 llm：可控 activeRequests（利用率被控量）
  const llm = makeLlm();
  const realStatuses = llm.getModelStatuses.bind(llm);
  let utilization = 0;
  llm.getModelStatuses = () =>
    realStatuses().map((s) => ({ ...s, activeRequests: Math.round(utilization * s.maxConcurrency) }));
  const scheduler = new ModelScheduler({ llm, memory: stubMemory(), config: { explorationEnabled: false } });
  scheduler.attachConcurrencyController({ target: 0.75, plantGain: 0.4, q: 1, r: 4, deadband: 0.05, minOutput: 1, maxOutput: 16, initialOutput: 12 });

  utilization = 1.0; // 持续过载：多步反馈跨越舍入边界
  const overSeq = [];
  for (let k = 0; k < 12; k += 1) overSeq.push(scheduler.computeParallelism());
  ok(overSeq[11] < 12, `持续过载 → 并行度下调（12 → ${overSeq[11]}）`);
  ok(overSeq.every((x, i) => i === 0 || x <= overSeq[i - 1]), `过载期间单调不升（${overSeq.join(' → ')}）`);
  utilization = 0.1; // 欠载
  const rises = [];
  for (let k = 0; k < 10; k += 1) rises.push(scheduler.computeParallelism());
  ok(rises[0] > overSeq[11] || rises[9] > overSeq[11], `欠载（利用率 10%）→ 并行度回调（${overSeq[11]} → ${rises[9]}）`);
  ok(rises.every((x) => x >= 1 && x <= 16), `全程钳位 [1,16]（抗饱和）`);
  utilization = 0.75; // 死区
  const before = scheduler.computeParallelism();
  const hold = scheduler.computeParallelism();
  ok(hold === before, `死区内（|e|<0.05）输出不动（${before}）——抗抖振`);
  const diag = scheduler.getAttachedDiagnostics();
  ok(diag.concurrencyControl !== undefined && diag.concurrencyControl.error === 0,
    `诊断 concurrencyControl 在场（闭环末误差 ${diag.concurrencyControl ? diag.concurrencyControl.error : '—'}）`);
  // 静态口径回归（对照）：未挂载时逐位一致已在零漂移段验证
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n──────────────────────────────────────────────────────────');
if (failed === 0) {
  console.log(`✓ 均衡层 31.0→35.0 五内核接线全部验证通过（${passed} 项断言）`);
} else {
  console.error(`✗ ${failed} 项失败（${passed} 项通过）`);
  process.exit(1);
}
