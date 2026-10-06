/**
 * verify-mod-executor.mjs — 第三轮·世界性升级 模块域 A4：任务执行器六项质级升级验证
 *
 * 验证对象：src/task-executor.ts（DAG 计划拓扑分层并行执行，10 步链路第 6/7 步）
 *   A4-1 EDF 截止期感知调度：同拓扑层内按最早截止期优先——EDF 满足率 > FIFO
 *   A4-2 尾延迟对冲请求：超 P95 阈值并行副本、先到先得、多余取消、成本有界
 *   A4-3 计划级重试预算：重试风暴被预算截断，超预算诚实上报「部分完成 + 原因」
 *   A4-4 取消传播与部分检查点：中途取消 → 检查点保留 → 续跑复用省时
 *   A4-5 执行审计：start/complete/retry/hedge/cancel/checkpoint 事件流可导出
 *   A4-6 虚拟时钟底座：种子化模拟、注入假执行器推进时间、零真定时器
 *
 * 确定性纪律：全部场景经 attachClock(VirtualClock) 在虚拟时间轴上推进（注入
 * nodeRunner 同步 clock.advance 构造时间，不用真定时器）；随机量全部出自
 * 种子化 LCG——同种子重跑逐位一致。每节附「旧 vs 新」对照数字，末尾
 * PASS n / FAIL m，失败 exit 1。
 *
 * 运行：npm run build && node scripts/verify-mod-executor.mjs
 */

import { LLMClient, ModelScheduler, TaskExecutor, VirtualClock } from '../dist/index.mjs';

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
function near(actual, expected, tolerance, label) {
  const hit = typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
  if (hit) {
    passed += 1;
    console.log(`  ✓ ${label}（实际 ${actual}，期望 ${expected} ±${tolerance}）`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}（实际 ${actual}，期望 ${expected} ±${tolerance}）`);
  }
}
function section(title) {
  console.log(`\n■ ${title}`);
}

/** 种子化 LCG（确定性随机源——同种子同序列） */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** 单模型 LLMClient（endpoint 指向不存在的 mock 主机，不发真实请求） */
function makeLlm() {
  const llm = new LLMClient();
  llm.registerModel({ id: 'model-a', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { exec: 0.5 } } });
  return llm;
}

/** 记忆 stub（ModelScheduler 消费面） */
function stubMemory() {
  return {
    getBayesianEstimate(modelId) {
      if (modelId === 'model-a') {
        return {
          modelId,
          taskType: 'exec',
          alpha: 11,
          beta: 10,
          posteriorMean: 11 / 21,
          wilsonLower: 0.31,
          effectiveSamples: 19,
          rawSuccessRate: 10 / 19,
          drift: 0,
          emaQuality: 0.6,
        };
      }
      return undefined;
    },
  };
}

function mkSignal(type, description, urgency = 0.6) {
  return { id: `sig-${type}-${Math.random().toString(36).slice(2, 8)}`, type, description, payload: {}, source: 'test', urgency, receivedAt: Date.now(), occurrences: 1 };
}

function baseConfig(overrides = {}) {
  return {
    qualityThreshold: 0.7,
    maxRetries: 0,
    globalTimeout: 60_000,
    nodeTimeout: 30_000,
    enableProgress: false,
    verbose: false,
    maxInFlightNodes: 1, // 虚拟时钟口径：串行推进，到达序可精确裁定
    ...overrides,
  };
}

function makeExecutor(config, runner) {
  const llm = makeLlm();
  return new TaskExecutor({
    config: baseConfig(config),
    llm,
    modelScheduler: new ModelScheduler({ llm, memory: stubMemory() }),
    nodeRunner: runner,
  });
}

/** 分位数（最近邻上取整口径） */
function quantile(sortedAsc, q) {
  const idx = Math.min(sortedAsc.length - 1, Math.ceil(q * sortedAsc.length) - 1);
  return sortedAsc[idx];
}

const AUDIT_TYPES = new Set([
  'plan-start', 'plan-complete', 'plan-cancel', 'plan-checkpoint', 'layer-edf',
  'node-start', 'node-complete', 'node-error', 'node-retry', 'node-hedge',
  'hedge-win', 'hedge-cancel', 'node-cancel',
]);

// ═══════════════════ ⓪ 零漂移总检 ═══════════════════

section('⓪ 零漂移总检：未挂载任何 A4 旗标时行为与升级前一致');

{
  // 真实时钟、无任何挂载：报告增量字段全部缺席，audit 在场（纯增量观测）
  const calls = [];
  const plain = makeExecutor({}, async (p) => {
    calls.push(p.node.id);
    return { output: `out-${p.node.id}`, quality: 0.95, tokensUsed: 10 };
  });
  const plan = {
    objective: '零漂移',
    nodes: ['p1', 'p2', 'p3'].map((id) => ({ id, description: id, type: 'exec', dependsOn: [] })),
    parallelismStrategy: 'layered',
    source: 'fallback',
  };
  const report = await plain.executePlan(mkSignal('zd', '零漂移'), plan);
  ok(report.success && report.successCount === 3, '常规计划全部成功（真实时钟路径）');
  ok(report.status === undefined && report.checkpoint === undefined && report.retryBudget === undefined && report.hedging === undefined, '增量字段全部缺席（status/checkpoint/retryBudget/hedging——零漂移）');
  ok(report.scheduling === 'fifo', '缺省调度口径 = FIFO 原序');
  ok(Array.isArray(report.audit) && report.audit.length > 0, '执行审计事件流在场（纯增量观测）');
  ok(calls.join(',') === 'p1,p2,p3', '派发序 = 计划原序（FIFO）');

  // 既有挂载面零漂移：未挂载时全部读数缺席
  ok(
    plain.testTimeComputePlan('exec', 0.9) === undefined
      && plain.backpressureView() === undefined
      && plain.planFeasibility([{ id: 'a' }]) === undefined
      && plain.optionsSkillAuditView() === undefined
      && plain.barrierFilterAction({ remaining: 10, burnRate: 1, decelCapacity: 1 }, 5) === undefined,
    '既有挂载面（52.0/54.0/85.0/86.0/87.0）未挂载读数全部缺席（兼容不变）',
  );
  ok(Array.isArray(plain.exportAuditTrail()) && plain.exportAuditTrail().length === report.audit.length, 'exportAuditTrail() 可导出（浅拷贝）');

  // 传了 deadlines 但未挂载 EDF：不重排（FIFO 原序）
  const clockZd = new VirtualClock(0);
  const orderProbe = [];
  const zdExec = makeExecutor({}, async (p) => {
    orderProbe.push(p.node.id);
    clockZd.advance(10);
    return { output: 'ok', quality: 0.95, tokensUsed: 5, completedAt: clockZd.now() };
  });
  zdExec.attachClock(clockZd);
  const zdPlan = {
    objective: 'edf-off',
    nodes: ['a', 'b', 'c'].map((id) => ({ id, description: id, type: 'exec', dependsOn: [] })),
    parallelismStrategy: 'layered',
    source: 'fallback',
  };
  const zdReport = await zdExec.executePlan(mkSignal('zd2', 'EDF 未挂载'), zdPlan, undefined, { deadlines: { c: 5, a: 50, b: 20 } });
  ok(orderProbe.join(',') === 'a,b,c' && zdReport.scheduling === 'fifo' && !zdReport.audit.some((e) => e.type === 'layer-edf'), '传入 deadlines 但未挂载 EDF → 仍 FIFO 原序（零漂移）');

  // cancelSignal 传入但从未中止：完整执行、无 cancelled 终态
  const cancelIdle = new AbortController();
  const idleExec = makeExecutor({}, async () => ({ output: 'ok', quality: 0.95, tokensUsed: 5 }));
  const idleReport = await idleExec.executePlan(mkSignal('zd3', '取消信号闲置'), zdPlan, undefined, { cancelSignal: cancelIdle.signal });
  ok(idleReport.success && idleReport.status === undefined, 'cancelSignal 闲置不触发取消（零漂移）');
}

// ═══════════════════ A4-6 虚拟时钟底座 ═══════════════════

section('A4-6 虚拟时钟底座：确定性时间推进（不碰真定时器）');

{
  const clock = new VirtualClock(1_000);
  ok(clock.now() === 1_000, '初始时刻可指定');
  const fired = [];
  const t1 = clock.setTimeout(() => fired.push(`t1@${clock.now()}`), 50);
  clock.setTimeout(() => fired.push(`t2@${clock.now()}`), 30);
  t1.cancel();
  clock.advance(100);
  ok(fired.join(' | ') === 't2@1030', `到期的虚拟定时器按时刻精确触发，取消的不触发（${fired.join(' | ')}）`);
  ok(clock.now() === 1_100, '推进落位目标时刻');

  // 重入安全：定时器回调内再 advance 不破坏外层目标
  const clock2 = new VirtualClock(0);
  const seq = [];
  clock2.setTimeout(() => {
    clock2.advance(10); // 内层推进
    seq.push(`inner@${clock2.now()}`);
  }, 5);
  clock2.advance(20);
  seq.push(`outer@${clock2.now()}`);
  ok(seq.join(',') === 'inner@15,outer@20', `定时器回调内重入 advance 安全（${seq.join(',')}）`);

  // 真定时器零参与：虚拟时间推进数百毫秒，墙钟几乎不动
  const wallStart = Date.now();
  const clock3 = new VirtualClock(0);
  for (let i = 0; i < 50; i += 1) clock3.advance(20);
  const wallDelta = Date.now() - wallStart;
  ok(clock3.now() === 1_000 && wallDelta < 400, `虚拟时间推进 1000ms 仅耗墙钟 ${wallDelta}ms（无真定时器参与）`);
}

// ═══════════════════ A4-1 EDF 截止期感知调度 ═══════════════════

section('A4-1 EDF 截止期感知调度：同层最早截止期优先——满足率 6/6 vs FIFO 3/6');

{
  // 场景：6 节点同层、串行执行（单机口径），每节点确定性延迟 30ms；
  // 截止期（绝对时刻 = 计划起点偏移）：n1@100 n2@50 n3@260 n4@110 n5@130 n6@300
  const deadlines = { n1: 100, n2: 50, n3: 260, n4: 110, n5: 130, n6: 300 };
  const plan = {
    objective: 'edf',
    nodes: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map((id) => ({ id, description: id, type: 'exec', dependsOn: [] })),
    parallelismStrategy: 'layered',
    source: 'fallback',
  };
  const runOnce = async (edf) => {
    const clock = new VirtualClock(0);
    const exec = makeExecutor({}, async (p) => {
      clock.advance(30);
      return { output: `out-${p.node.id}`, quality: 0.95, tokensUsed: 5, completedAt: clock.now() };
    });
    exec.attachClock(clock);
    if (edf) exec.attachDeadlineScheduling();
    const report = await exec.executePlan(mkSignal('edf', 'EDF 对照'), plan, undefined, { deadlines });
    const completions = new Map(report.audit.filter((e) => e.type === 'node-complete').map((e) => [e.nodeId, e.t]));
    const dispatch = report.audit.filter((e) => e.type === 'node-start').map((e) => e.nodeId);
    const met = [...completions.entries()].filter(([id, t]) => t <= deadlines[id]).length;
    const metList = Object.keys(deadlines).map((id) => `${id}:${completions.get(id) <= deadlines[id] ? '✓' : '✗'}`).join(' ');
    return { report, completions, dispatch, met, metList, clock };
  };

  const fifo = await runOnce(false);
  const edf = await runOnce(true);

  ok(fifo.report.scheduling === 'fifo' && fifo.dispatch.join(',') === 'n1,n2,n3,n4,n5,n6', `旧口径（FIFO）：派发序 = 计划原序 ${fifo.dispatch.join('→')}`);
  ok(fifo.met === 3, `旧口径（FIFO）满足率 3/6（${fifo.metList}——完成时刻 30/60/90/120/150/180，晚位紧截止期被错过）`);
  ok(edf.report.scheduling === 'edf' && edf.dispatch.join(',') === 'n2,n1,n4,n5,n3,n6', `新口径（EDF）：层内按最早截止期重排 ${edf.dispatch.join('→')}`);
  ok(edf.report.audit.some((e) => e.type === 'layer-edf'), 'EDF 派发序进入审计事件流（layer-edf）');
  ok(edf.met === 6, `新口径（EDF）满足率 6/6（${edf.metList}——紧截止期先行，全部按期）`);
  ok(edf.met > fifo.met && edf.report.success && fifo.report.success, `EDF 满足率 ${edf.met}/6 > FIFO ${fifo.met}/6（两种口径计划本身均成功——对照只差调度序）`);
  near(edf.report.totalTime, 180, 1, 'EDF 总虚拟耗时与 FIFO 相同（180ms——重排不增加工作量，只换序）');
}

// ═══════════════════ A4-2 尾延迟对冲请求 ═══════════════════

section('A4-2 尾延迟对冲：p99 300ms → ≤90ms，成本有界（对冲 2 次 / +10% token）');

{
  // 场景：20 节点串行；正常延迟 20~39ms（种子化），2 个慢尾节点固定 300ms；
  // 对冲阈值 60ms（P95 口径由分布标定），副本延迟 22~27ms（另一条种子流）
  const N = 20;
  const rngPrimary = lcg(20261001);
  const primaryLat = Array.from({ length: N }, () => 20 + Math.floor(rngPrimary() * 20));
  const slowIdx = new Set([4, 15]);
  for (const i of slowIdx) primaryLat[i] = 300;
  const rngHedge = lcg(77001);
  const hedgeLat = Array.from({ length: N }, () => 22 + Math.floor(rngHedge() * 6)); // 22~27ms
  const plan = {
    objective: 'hedging',
    nodes: Array.from({ length: N }, (_, i) => ({ id: `h${i}`, description: `h${i}`, type: 'exec', dependsOn: [] })),
    parallelismStrategy: 'layered',
    source: 'fallback',
  };
  const runOnce = async (hedged) => {
    const clock = new VirtualClock(0);
    const callCount = new Map();
    const exec = makeExecutor({}, async (p) => {
      const k = callCount.get(p.node.id) ?? 0;
      callCount.set(p.node.id, k + 1);
      const lat = k === 0 ? primaryLat[Number(p.node.id.slice(1))] : hedgeLat[Number(p.node.id.slice(1))];
      clock.advance(lat);
      return { output: `out-${p.node.id}`, quality: 0.95, tokensUsed: 10, completedAt: clock.now() };
    });
    exec.attachClock(clock);
    if (hedged) exec.attachHedging({ delayMs: 60, maxHedgesPerNode: 1 });
    const report = await exec.executePlan(mkSignal('hedging', '尾延迟对照'), plan);
    const lats = report.nodeResults.map((r) => r.latency);
    const sorted = [...lats].sort((a, b) => a - b);
    return { report, sorted, lats };
  };

  const oldRun = await runOnce(false);
  const newRun = await runOnce(true);
  const oldP99 = quantile(oldRun.sorted, 0.99);
  const newP99 = quantile(newRun.sorted, 0.99);
  const oldMax = oldRun.sorted[oldRun.sorted.length - 1];
  const newMax = newRun.sorted[newRun.sorted.length - 1];

  ok(oldRun.report.hedging === undefined && oldP99 === 300, `旧口径（无对冲）：p99 = ${oldP99}ms / 最大 ${oldMax}ms——慢尾直接落到用户头上`);
  ok(newRun.report.success && newRun.report.nodeResults.every((r) => r.success), '新口径（对冲挂载）：全部节点成功（先到先得不影响正确性）');
  ok(newP99 <= 90 && newMax <= 90, `新口径：p99 = ${newP99}ms / 最大 ${newMax}ms（慢尾 300ms 被对冲副本救回 ≈ 60ms 阈值 + 副本 22~27ms）`);
  ok(oldP99 / Math.max(1, newP99) >= 3, `p99 改善 ≥3×（${oldP99}ms → ${newP99}ms）`);
  const hedge = newRun.report.hedging;
  ok(hedge.count === 2 && hedge.count <= N * 1, `成本有界：对冲 ${hedge.count} 次 = 慢尾节点数（每节点上限 1，正常节点零对冲）`);
  ok(hedge.extraTokens === 20 && newRun.report.totalTokens === oldRun.report.totalTokens + 20, `额外成本记账诚实：+${hedge.extraTokens} token（+${((hedge.extraTokens / oldRun.report.totalTokens) * 100).toFixed(0)}%），节点 tokensUsed 含副本成本`);
  ok(hedge.savedMs >= 400 && hedge.savedMs <= 440, `节省延迟记账：${hedge.savedMs}ms（2 × (300 − 60 − 副本延迟)）`);
  ok(newRun.report.audit.some((e) => e.type === 'node-hedge') && newRun.report.audit.some((e) => e.type === 'hedge-win'), '对冲事件进入审计流（node-hedge / hedge-win）');
  // 确定性交叉验证：正常节点的延迟两轮逐位一致（对冲只动了慢尾）
  const normalSame = oldRun.lats.every((v, i) => slowIdx.has(i) || newRun.lats[i] === v);
  ok(normalSame, '确定性：正常节点延迟旧新两轮逐位一致（同种子同推进序列）');
}

// ═══════════════════ A4-3 计划级重试预算 ═══════════════════

section('A4-3 计划级重试预算：重试风暴 10 次调用 → 7 次（预算 3 截断）');

{
  // 场景：4 节点（g1/g2 一次成功；f1/f2 质量持续 0.2 不达标），maxRetries=3
  // 旧口径：每个 flaky 节点各耗 4 次尝试（1+4+1+4 = 10 次调用）——节点级
  // 重试叠加成计划级风暴。新口径：planRetryBudget=3 —— f1 用满预算，f2 被截断。
  const plan = {
    objective: 'storm',
    nodes: ['g1', 'f1', 'g2', 'f2'].map((id) => ({ id, description: id, type: 'exec', dependsOn: [] })),
    parallelismStrategy: 'layered',
    source: 'fallback',
  };
  const runOnce = async (budget) => {
    const clock = new VirtualClock(0);
    let calls = 0;
    const exec = makeExecutor({ maxRetries: 3, ...(budget !== undefined ? { planRetryBudget: budget } : {}) }, async (p) => {
      calls += 1;
      clock.advance(5);
      return { output: `out-${p.node.id}`, quality: p.node.id.startsWith('g') ? 0.95 : 0.2, tokensUsed: 10, completedAt: clock.now() };
    });
    exec.attachClock(clock);
    const report = await exec.executePlan(mkSignal('storm', '重试风暴'), plan);
    return { report, calls, exec };
  };

  const oldRun = await runOnce(undefined);
  const newRun = await runOnce(3);

  ok(oldRun.calls === 10 && oldRun.report.retryBudget === undefined, `旧口径（无预算）：${oldRun.calls} 次调用（flaky 各 4 次尝试——重试叠加成风暴），报告无预算账单`);
  ok(newRun.calls === 7 && newRun.calls < oldRun.calls, `新口径（预算 3）：${newRun.calls} 次调用（f2 重试被截断——预算只许 3 次重试，全部被 f1 用尽）`);
  const f2 = newRun.report.nodeResults.find((r) => r.nodeId === 'f2');
  ok(f2 && !f2.success && f2.error.includes('重试预算耗尽'), `超预算诚实上报：f2 错误 =「${f2 ? f2.error : '—'}」`);
  ok(newRun.report.successCount === 2 && newRun.report.success === false && newRun.report.error !== undefined, '部分完成如实报告：2/4 成功 + 原因在场（不谎报全失败也不谎报成功）');
  const budget = newRun.report.retryBudget;
  ok(budget && budget.limit === 3 && budget.used === 3 && budget.exhausted === true, `预算账单：limit=3 / used=${budget ? budget.used : '—'} / exhausted=${budget ? budget.exhausted : '—'}`);
  ok(newRun.report.audit.some((e) => e.type === 'node-retry' && e.detail.includes('预算耗尽')), '预算截断进入审计流（node-retry · 预算耗尽）');
  near(oldRun.report.totalTime, 50, 1, '成本对照（虚拟耗时）：旧口径 50ms（10 次调用 × 5ms）');
  near(newRun.report.totalTime, 35, 1, '成本对照（虚拟耗时）：新口径 35ms（7 次调用 × 5ms——预算截断省 30% 空转）');
}

// ═══════════════════ A4-4 取消传播与部分检查点 ═══════════════════

section('A4-4 取消传播与检查点续跑：中途取消 → 复用 2 节点 → 续跑省 40ms');

{
  // 场景：A(20ms),B(20ms) → C(dep A,B, 60ms), D(dep A, 30ms) → E(dep C, 20ms)
  // 外部取消挂在虚拟时刻 45ms：A/B 已完成保留为检查点，第二层首个节点 D
  // （拓扑序 D→C）在飞被传播中止，C/E 未起跑
  const latencies = { A: 20, B: 20, C: 60, D: 30, E: 20 };
  const plan = {
    objective: 'cancel-resume',
    nodes: [
      { id: 'A', description: 'A', type: 'exec', dependsOn: [] },
      { id: 'B', description: 'B', type: 'exec', dependsOn: [] },
      { id: 'C', description: 'C', type: 'exec', dependsOn: ['A', 'B'] },
      { id: 'D', description: 'D', type: 'exec', dependsOn: ['A'] },
      { id: 'E', description: 'E', type: 'exec', dependsOn: ['C'] },
    ],
    parallelismStrategy: 'layered',
    source: 'fallback',
  };
  const makeRunner = (clock, ledger) => async (p) => {
    (ledger.calls ??= []).push(p.node.id);
    (ledger.contexts ??= {})[p.node.id] = Object.keys(p.context);
    clock.advance(latencies[p.node.id]);
    if (p.abortSignal?.aborted) throw new Error('计划已取消：在途请求中止');
    return { output: `out-${p.node.id}`, quality: 0.95, tokensUsed: 10, completedAt: clock.now() };
  };

  // ── 取消腿 ──
  const clock1 = new VirtualClock(0);
  const ledger1 = {};
  const cancelExec = makeExecutor({}, makeRunner(clock1, ledger1));
  cancelExec.attachClock(clock1);
  const cancelCtl = new AbortController();
  clock1.setTimeout(() => cancelCtl.abort(), 45); // 虚拟时刻 45ms 外部取消
  const cancelled = await cancelExec.executePlan(mkSignal('cancel', '中途取消'), plan, undefined, { cancelSignal: cancelCtl.signal });

  ok(cancelled.status === 'cancelled' && cancelled.success === false && cancelled.successCount === 2, `中途取消：终态 cancelled，部分完成 2/5（A、B 成功）`);
  ok(cancelled.checkpoint && cancelled.checkpoint.completed.map((r) => r.nodeId).join(',') === 'A,B', `部分检查点保留已完成节点（${cancelled.checkpoint ? cancelled.checkpoint.completed.map((r) => r.nodeId).join(',') : '—'}——续跑可复用）`);
  const startedIds = cancelled.audit.filter((e) => e.type === 'node-start').map((e) => e.nodeId);
  ok(startedIds.join(',') === 'A,B,D' && ledger1.calls.join(',') === 'A,B,D', '取消传播：D 在飞被中止，C/E 未起跑（派发即停）');
  ok(cancelled.audit.some((e) => e.type === 'node-cancel'), '节点级取消进入审计流（node-cancel）');
  ok(cancelled.audit.some((e) => e.type === 'plan-cancel') && cancelled.audit.some((e) => e.type === 'plan-checkpoint'), '计划级取消与检查点进入审计流（plan-cancel / plan-checkpoint）');
  const inFlightResult = cancelled.nodeResults.find((r) => r.nodeId === 'D');
  ok(inFlightResult && !inFlightResult.success && inFlightResult.error.includes('计划取消'), `在途节点诚实记因（D：${inFlightResult ? inFlightResult.error : '—'}）`);
  ok(cancelled.audit.every((e) => AUDIT_TYPES.has(e.type)), '取消腿审计事件类型全部合法');

  // ── 续跑腿（复用检查点） vs 从头重跑 ──
  const clock2 = new VirtualClock(0);
  const ledger2 = {};
  const resumeExec = makeExecutor({}, makeRunner(clock2, ledger2));
  resumeExec.attachClock(clock2);
  const resumed = await resumeExec.resumePlan(mkSignal('resume', '检查点续跑'), plan, cancelled.checkpoint);

  const clock3 = new VirtualClock(0);
  const ledger3 = {};
  const freshExec = makeExecutor({}, makeRunner(clock3, ledger3));
  freshExec.attachClock(clock3);
  const rerun = await freshExec.executePlan(mkSignal('rerun', '从头重跑'), plan);

  ok(resumed.success && resumed.resumedFromCount === 2 && ledger2.calls.join(',') === 'D,C,E', `续跑复用检查点 2 节点，只执行剩余 D/C/E（调用序 ${ledger2.calls.join(',')}）`);
  ok(ledger2.contexts.C.join(',') === 'A,B' && ledger2.contexts.D.join(',') === 'A' && ledger2.contexts.E.join(',') === 'C', '上游产出贯通：C 拿到 A+B 产出、D 拿到 A、E 拿到 C（检查点输出即上下文）');
  const reusedA = resumed.nodeResults.find((r) => r.nodeId === 'A');
  ok(reusedA && reusedA.output === 'out-A' && reusedA.latency === 20, '复用节点结果原样入报告（产出/延迟不重测）');
  near(resumed.totalTime, 110, 1, '续跑虚拟耗时 110ms（60+30+20）');
  near(rerun.totalTime, 150, 1, '从头重跑虚拟耗时 150ms（20+20+60+30+20）');
  ok(resumed.totalTime < rerun.totalTime - 30, `复用省时：续跑 ${resumed.totalTime}ms < 重跑 ${rerun.totalTime}ms（省 40ms = A+B 的检查点工作量）`);
  ok(ledger2.calls.length === 3 && ledger3.calls.length === 5, `调用数对照：续跑 3 次 vs 重跑 5 次（省 2 次执行）`);
}

// ═══════════════════ A4-5 执行审计导出 ═══════════════════

section('A4-5 执行审计：全生命周期事件流可导出');

{
  // 用 A4-4 的取消执行器导出（同一份 trail）
  const clock = new VirtualClock(0);
  let trail;
  const exec = makeExecutor({}, async (p) => {
    clock.advance(15);
    return { output: `out-${p.node.id}`, quality: 0.95, tokensUsed: 5, completedAt: clock.now() };
  });
  exec.attachClock(clock);
  await exec.executePlan(mkSignal('audit', '审计基线'), {
    objective: 'audit',
    nodes: [{ id: 'x1', description: 'x1', type: 'exec', dependsOn: [] }, { id: 'x2', description: 'x2', type: 'exec', dependsOn: ['x1'] }],
    parallelismStrategy: 'layered',
    source: 'fallback',
  });
  trail = exec.exportAuditTrail();
  ok(trail.length > 0 && trail.every((e) => typeof e.t === 'number' && AUDIT_TYPES.has(e.type)), `导出 ${trail.length} 条事件全部合法（时刻 + 类型）`);
  const types = new Set(trail.map((e) => e.type));
  ok(types.has('plan-start') && types.has('node-start') && types.has('node-complete') && types.has('plan-complete'), '生命周期全覆盖（plan-start / node-start / node-complete / plan-complete）');
  const monotonic = trail.every((e, i) => i === 0 || e.t >= trail[i - 1].t);
  ok(monotonic, '事件时刻单调不减（虚拟时钟口径下的全序）');
  const before = trail.length;
  trail.push({ t: -1, type: 'plan-start' });
  ok(exec.exportAuditTrail().length === before, '导出为浅拷贝（外部篡改不回写内部审计流）');
}

// ═══════════════════ 汇总 ═══════════════════

console.log('\n──────────────────────────────────────────────────────────');
if (failed === 0) {
  console.log(`✓ A4 任务执行器六项升级全部验证通过（${passed} 项断言）——EDF 满足率 6/6>FIFO 3/6 · p99 300→≤90ms 成本 +10% · 重试风暴 10→7 次调用 · 续跑省 40ms · 审计可导出`);
} else {
  console.error(`✗ ${failed} 项断言失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed} —— 第三轮模块域 A4：task-executor 升级验证`);
process.exit(failed === 0 ? 0 : 1);
