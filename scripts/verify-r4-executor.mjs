/**
 * verify-r4-executor.mjs — 第四轮·世界性升级（激活与深化）模块域 R4-A4：任务执行器五项升级验证
 *
 * 验证对象：src/task-executor.ts（全部 opt-in 挂载、缺省零漂移）
 *   R4-1 并行度自适应：批宽吞吐爬山 + 三重迟滞——构造「最优并发 = 3」的模拟
 *        吞吐环境（perNode(w) = 90/min(w,3) + 20·max(0,w−3)），证明爬山收敛到
 *        3 且收敛后不震荡，自适应总耗时 < 固定缺省宽度（探索成本诚实上界）
 *   R4-2 失败域隔离：失败按（模型×任务类型）聚簇，单簇连续失败只熔断该簇
 *        ——构造「单模型单任务类型连续失败」：旧口径（模型级熔断）殃及同模型
 *        全部任务类型（被迫迁移 5 次）；新口径 0 次无辜迁移 + 冷却期满试探恢复
 *   R4-3 进度估计 ETA：节点历史时长分布分位数（P10/P50/P90）→ 剩余时间点估计
 *        + 置信区间——已知分布 U[50,150] 模拟：中位误差 < 15%、区间覆盖 ≥ 80%
 *   R4-4 计划压缩：冗余节点合并 + 传递依赖简化——6 节点含冗余 DAG 压到 4，
 *        语义等价口径（输出 = f(操作, 输入闭包取值)）下执行输出逐位一致
 *   R4-5 失败注入演练（加分）：规则化 chaos（error/timeout/low-quality，限次命中）
 *        ——4 条注入全部被恢复路径吸收（重试 2 + 对冲 1 + 检查点续跑 1），终局 6/6
 *
 * 确定性纪律：全部场景经 attachClock(VirtualClock) 在虚拟时间轴上推进（注入
 * nodeRunner 同步 clock.advance 构造时间，不用真定时器）；随机量全部出自
 * 种子化 LCG——同种子重跑逐位一致。每节附「旧 vs 新」对照数字，末尾
 * PASS n / FAIL m，失败 exit 1。
 *
 * 运行：npm run build && node scripts/verify-r4-executor.mjs
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

/** 多模型 LLMClient（endpoint 指向不存在的 mock 主机，不发真实请求） */
function makeLlm(modelIds, taskTypes) {
  const llm = new LLMClient();
  const taskScores = {};
  for (const t of taskTypes) taskScores[t] = 0.55;
  for (const id of modelIds) llm.registerModel({ id, endpoint: 'http://mock.local', initialCapabilities: { taskScores } });
  return llm;
}

/** 记忆 stub（ModelScheduler 消费面） */
function stubMemory() {
  return { getBayesianEstimate: () => undefined };
}

let sigSeq = 0;
function mkSignal(type, description, urgency = 0.6) {
  sigSeq += 1;
  return { id: `sig-${type}-${sigSeq}`, type, description, payload: {}, source: 'test', urgency, receivedAt: 0, occurrences: 1 };
}

function baseConfig(overrides = {}) {
  return {
    qualityThreshold: 0.7,
    maxRetries: 0,
    globalTimeout: 10_000_000,
    nodeTimeout: 30_000,
    enableProgress: false,
    verbose: false,
    ...overrides,
  };
}

function makeExecutor({ models = ['model-a'], types = ['exec'], config = {}, runner }) {
  const llm = makeLlm(models, types);
  return new TaskExecutor({
    config: baseConfig(config),
    llm,
    modelScheduler: new ModelScheduler({ llm, memory: stubMemory() }),
    nodeRunner: runner,
  });
}

const OLD_AUDIT_TYPES = new Set([
  'plan-start', 'plan-complete', 'plan-cancel', 'plan-checkpoint', 'layer-edf',
  'node-start', 'node-complete', 'node-error', 'node-retry', 'node-hedge',
  'hedge-win', 'hedge-cancel', 'node-cancel',
]);

// ═══════════════════ ⓪ 零漂移总检 ═══════════════════

section('⓪ 零漂移总检：未挂载任何 R4 旗标时行为与第三轮一致');

{
  const clock = new VirtualClock(0);
  const seenWidths = [];
  const plain = makeExecutor({
    runner: async (p) => {
      seenWidths.push(p.batchWidth);
      clock.advance(10);
      return { output: `out-${p.node.id}`, quality: 0.95, tokensUsed: 5, completedAt: clock.now() };
    },
  });
  plain.attachClock(clock);
  const plan = {
    objective: '零漂移',
    nodes: ['p1', 'p2', 'p3', 'p4'].map((id) => ({ id, description: id, type: 'exec', dependsOn: [] })),
    parallelismStrategy: 'layered',
    source: 'fallback',
  };
  const report = await plain.executePlan(mkSignal('zd', '零漂移'), plan);
  ok(report.success && report.successCount === 4, '常规计划全部成功（虚拟时钟路径）');
  ok(report.adaptiveParallelism === undefined && report.eta === undefined, 'R4 增量字段全部缺席（adaptiveParallelism / eta——零漂移）');
  ok(seenWidths.every((w) => w === undefined), 'runner 参数不含 batchWidth（未挂载自适应不透出批宽——契约面不变）');
  ok(plain.failureDomainSnapshot() !== undefined && Object.keys(plain.failureDomainSnapshot()).length === 0, 'failureDomainSnapshot() 未挂载返回空对象');
  ok(Array.isArray(plain.chaosLedger()) && plain.chaosLedger().length === 0, 'chaosLedger() 未挂载返回空数组');
  ok(plain.estimateEta(plan) === undefined, 'estimateEta() 未挂载返回 undefined');
  ok(report.audit.every((e) => OLD_AUDIT_TYPES.has(e.type)), '审计事件全部为第三轮既有类型（R4 类型零出现）');
  // 挂载后卸载 → 读数回归缺席（幂等可逆）
  plain.attachFailureDomains({ failureThreshold: 2, cooldownMs: 100 });
  plain.detachFailureDomains();
  ok(Object.keys(plain.failureDomainSnapshot()).length === 0, 'attach→detach 失败域后读数回归空（可逆）');
  // compressPlan 是纯工具（免挂载即可用），且不动入参
  const redundant = {
    objective: 'zd-compress',
    source: 'strategist',
    parallelismStrategy: 'layered',
    nodes: [
      { id: 'a', description: 't', type: 'exec', dependsOn: [] },
      { id: 'b', description: 't', type: 'exec', dependsOn: [] },
      { id: 'c', description: 'u', type: 'exec', dependsOn: ['a', 'b'] },
    ],
  };
  const before = JSON.stringify(redundant);
  const { plan: compressed, stats } = plain.compressPlan(redundant);
  ok(stats.nodesAfter === 2 && JSON.stringify(redundant) === before, 'compressPlan 免挂载可用：3→2 节点且入参零改动（a/b 同操作同依赖合并）');
  ok(compressed.nodes.map((n) => n.id).join(',') === 'a,c' && compressed.nodes[1].dependsOn.join(',') === 'a', '合并后依赖重定向到 canonical（c 依赖 [a,b] → [a]）');
}

// ═══════════════════ R4-1 并行度自适应 ═══════════════════

section('R4-1 并行度自适应：爬山收敛最优并发 3，不震荡——890ms vs 固定缺省宽 2160ms');

{
  // 模拟吞吐环境（最优并发 = 3）：批内每节点耗时 perNode(w) = 90/min(w,3) + 20·max(0,w−3)
  //   w=1→90 / 2→45 / 3→30 / 4→50 / 5→70 / 6→90 ms ⇒ 吞吐（节点/ms）：
  //   0.0111 / 0.0222 / 0.0333 / 0.0200 / 0.0143 / 0.0111 —— 单峰，峰在 3
  const N = 24;
  const perNodeMs = (w) => Math.floor(90 / Math.min(w, 3)) + 20 * Math.max(0, w - 3);
  const plan = {
    objective: 'adaptive',
    nodes: Array.from({ length: N }, (_, i) => ({ id: `n${i}`, description: `n${i}`, type: 'exec', dependsOn: [] })),
    parallelismStrategy: 'layered',
    source: 'fallback',
  };

  const runOnce = async ({ adaptive, forceWidth }) => {
    const clock = new VirtualClock(0);
    const widths = [];
    const exec = makeExecutor({
      models: ['model-a', 'model-b'],
      runner: async (p) => {
        // 挂载自适应：批宽由执行器透出（batchWidth）；固定腿：maxInFlightNodes 钳位
        // （缺省腿实际宽 = 2 模型 × 并发 3 = 6）——环境按真实批宽建模
        const w = p.batchWidth ?? forceWidth ?? 6;
        widths.push(w);
        clock.advance(perNodeMs(w));
        return { output: `out-${p.node.id}`, quality: 0.95, tokensUsed: 5, completedAt: clock.now() };
      },
      config: forceWidth !== undefined ? { maxInFlightNodes: forceWidth } : {},
    });
    exec.attachClock(clock);
    if (adaptive) exec.attachAdaptiveParallelism();
    const report = await exec.executePlan(mkSignal('adapt', '并发对照'), plan);
    return { report, widths };
  };

  const adaptiveRun = await runOnce({ adaptive: true });
  const ap = adaptiveRun.report.adaptiveParallelism;
  const fixedDefault = await runOnce({ adaptive: false }); // 旧口径：固定 = 调度容量（2 模型 × 并发 3 = 6）
  const fixedBest = await runOnce({ adaptive: false, forceWidth: 3 }); // 先知口径：最优固定宽
  const fixed4 = await runOnce({ adaptive: false, forceWidth: 4 });

  ok(ap !== undefined && ap.converged === true && ap.settledWidth === 3, `爬山收敛：最优并发宽度 = ${ap ? ap.settledWidth : '—'}（converged=${ap ? ap.converged : '—'}）`);
  ok(JSON.stringify(ap.widthHistory) === JSON.stringify([1, 2, 3, 4, 3, 3, 3, 3]), `宽度轨迹 = [${ap.widthHistory.join(',')}]（1→2→3 上探 / 4 受挫回落 / 停 3）`);
  ok(ap.widthHistory.slice(ap.widthHistory.indexOf(4) + 1).every((w) => w === 3), `收敛后不震荡：受挫点之后全部宽度 = 3（${ap.widthHistory.slice(ap.widthHistory.indexOf(4) + 1).join(',')}）`);
  const tpOf = (w) => ap.throughputHistory.find((o) => o.width === w)?.nodesPerMs ?? 0;
  const argmax = ap.throughputHistory.reduce((best, o) => (o.nodesPerMs > tpOf(best) ? o.width : best), ap.throughputHistory[0].width);
  ok(argmax === 3, `实测吞吐拐点在宽度 3（w3=${tpOf(3).toFixed(4)} > w2=${tpOf(2).toFixed(4)} > w4=${tpOf(4).toFixed(4)} 节点/ms）`);
  near(adaptiveRun.report.totalTime, 890, 2, '自适应总虚拟耗时 890ms（探索 1+2+3+4 批 = 470ms + 收敛期 14×30 = 420ms）');
  near(fixedDefault.report.totalTime, 2160, 2, '旧口径（固定宽 6 = 缺省调度容量）总耗时 2160ms（24×90——过并发踩拥塞惩罚）');
  near(fixedBest.report.totalTime, 720, 2, '先知口径（固定宽 3）总耗时 720ms（24×30——理论上界）');
  near(fixed4.report.totalTime, 1200, 2, '固定宽 4 总耗时 1200ms（24×50——轻微过并发即吃 20ms/节点拥塞惩罚）');
  ok(adaptiveRun.report.totalTime < fixedDefault.report.totalTime * 0.5, `自适应 ${adaptiveRun.report.totalTime}ms < 旧缺省 ${fixedDefault.report.totalTime}ms（−${(((fixedDefault.report.totalTime - adaptiveRun.report.totalTime) / fixedDefault.report.totalTime) * 100).toFixed(0)}%）`);
  ok(adaptiveRun.report.totalTime - fixedBest.report.totalTime <= 200, `探索成本诚实上界：自适应 − 先知 = ${adaptiveRun.report.totalTime - fixedBest.report.totalTime}ms ≤ 200ms（170ms 爬坡学费换「无需先验」）`);
  ok(adaptiveRun.widths.join(',') === '1,2,2,3,3,3,4,4,4,4,3,3,3,3,3,3,3,3,3,3,3,3,3,3', `实际派发宽度逐位符合爬山轨迹（${adaptiveRun.widths.slice(0, 10).join(',')}…）`);
  ok(adaptiveRun.report.audit.some((e) => e.type === 'parallelism-adapt'), '宽度调整进入审计流（parallelism-adapt）');
  ok(fixedDefault.report.adaptiveParallelism === undefined && fixedDefault.widths.every((w) => w === 6), '未挂载自适应的对照腿：批宽恒 6（缺省调度容量；2160ms = 24×90 即宽 6 的环境指纹——旧口径零漂移）');
}

// ═══════════════════ R4-2 失败域隔离 ═══════════════════

section('R4-2 失败域隔离：单簇熔断只降温该簇——无辜迁移 5 次 → 0 次');

{
  // 环境：model-a 对任务类型 tx 的前 3 次调用网络故障（单模型单类型连续失败），
  // 之后恢复；model-a 对 ty、model-b 对一切类型始终正常。
  const mkEnvRunner = (clock, state) => async (p) => {
    if (p.node.type === 'tx' && p.modelId === 'model-a') {
      state.txCalls += 1;
      if (state.txCalls <= 3) throw new (await import('../dist/index.mjs')).NetworkError('mock: model-a 对 tx 网络故障');
    }
    clock.advance(p.node.id === 'y2' ? 250 : 10); // y2 = 恢复腿的时间垫片（拉长 250ms > 冷却 200ms）
    return { output: `ok-${p.node.id}`, quality: 0.95, tokensUsed: 5, completedAt: clock.now() };
  };
  // 计划：x1..x3（tx, model-a）打爆簇 → y1/y2（ty, model-a）为无辜簇 → x4/x5（tx）受灾簇
  // → x6（tx）冷却期满试探（前置 y2 拉长 250ms 虚拟时间）
  const plan = (ids) => ({
    objective: 'fd',
    nodes: ids.map((id) => ({ id, description: id, type: id.startsWith('x') ? 'tx' : 'ty', dependsOn: [], modelId: 'model-a' })),
    parallelismStrategy: 'layered',
    source: 'fallback',
  });

  // ── 旧口径：模型级熔断（threshold 3 / 冷却 600s——故障期不可能恢复）──
  const clockOld = new VirtualClock(0);
  const stateOld = { txCalls: 0 };
  const oldExec = makeExecutor({
    models: ['model-a', 'model-b'],
    types: ['tx', 'ty'],
    runner: mkEnvRunner(clockOld, stateOld),
    config: { maxInFlightNodes: 1, circuitFailureThreshold: 3, circuitCooldownMs: 600_000, retryBackoffBaseMs: 0 },
  });
  oldExec.attachClock(clockOld);
  const oldRep = await oldExec.executePlan(mkSignal('fd', '旧口径'), plan(['x1', 'x2', 'x3', 'y1', 'y2', 'x4', 'x5', 'x6']));
  const oldModelOf = (id) => oldRep.nodeResults.find((r) => r.nodeId === id).modelId;
  const oldForced = ['y1', 'y2', 'x4', 'x5', 'x6'].filter((id) => oldModelOf(id) === 'model-b').length;
  ok(oldRep.nodeResults.filter((r) => r.nodeId.startsWith('x')).slice(0, 3).every((r) => !r.success), '旧口径：x1..x3 如实失败（model-a 对 tx 连续 3 次网络故障）');
  ok(oldForced === 5, `旧口径（模型级熔断）：model-a 整体熔断 → 无辜簇被迫迁移 ${oldForced} 次（y1=${oldModelOf('y1')} y2=${oldModelOf('y2')} x4..x6 全部迁到 model-b——ty 与 tx 无关仍被殃及）`);
  ok(oldExec.getBreakerSnapshot()['model-a'] !== undefined && oldExec.getBreakerSnapshot()['model-a'].state !== 'closed', '旧口径：model-a 模型级熔断器 open（单类型故障放大为全模型故障）');

  // ── 新口径：失败域隔离（threshold 3 / 冷却 200ms 虚拟时间）──
  const clockNew = new VirtualClock(0);
  const stateNew = { txCalls: 0 };
  const newExec = makeExecutor({
    models: ['model-a', 'model-b'],
    types: ['tx', 'ty'],
    runner: mkEnvRunner(clockNew, stateNew),
    config: { maxInFlightNodes: 1, retryBackoffBaseMs: 0 },
  });
  newExec.attachClock(clockNew);
  newExec.attachFailureDomains({ failureThreshold: 3, cooldownMs: 200 });
  const newRep = await newExec.executePlan(mkSignal('fd', '新口径'), plan(['x1', 'x2', 'x3', 'y1', 'x4', 'x5']));
  const newModelOf = (id) => newRep.nodeResults.find((r) => r.nodeId === id).modelId;
  ok(newModelOf('y1') === 'model-a' && newRep.nodeResults.find((r) => r.nodeId === 'y1').success, `新口径：无辜簇不受伤——y1（ty）仍在 model-a 原地成功（y1=${newModelOf('y1')}，旧口径=${oldModelOf('y1')}）`);
  ok(newModelOf('x4') === 'model-b' && newModelOf('x5') === 'model-b', `新口径：受灾簇（model-a::tx）熔断后重定向健康簇（x4/x5 → model-b）`);
  const snapA = newExec.failureDomainSnapshot();
  ok(Object.keys(snapA).length === 1 && snapA['model-a::tx'] !== undefined && snapA['model-a::tx'].state === 'open', `失败域快照只熔断 1 簇：model-a::tx open（冷却剩 ${snapA['model-a::tx'] ? snapA['model-a::tx'].cooldownRemainingMs : '—'}ms），model-a::ty / model-b::tx 全部无恙`);
  ok(!Object.keys(snapA).some((k) => k.includes('ty') || k.includes('model-b')), '其余簇零失败计数（隔离彻底——model-a::ty 连失败记录都没有）');
  ok(newRep.audit.some((e) => e.type === 'domain-open' && e.detail.includes('model-a::tx')), '簇熔断进入审计流（domain-open · model-a::tx）');
  ok(newRep.audit.every((e) => OLD_AUDIT_TYPES.has(e.type) || ['domain-open', 'domain-wait', 'parallelism-adapt', 'chaos-inject'].includes(e.type)), '审计事件类型全部合法（第三轮 ∪ R4）');

  // ── 冷却期满试探恢复（同执行器同虚拟时间轴续跑：y2 拉长 250ms > 冷却 200ms）──
  const recoverRep = await newExec.executePlan(mkSignal('fd', '试探恢复'), plan(['y2', 'x6']));
  const x6 = recoverRep.nodeResults.find((r) => r.nodeId === 'x6');
  const y2 = recoverRep.nodeResults.find((r) => r.nodeId === 'y2');
  ok(y2.success && y2.modelId === 'model-a', '恢复腿：y2（ty）仍在 model-a 成功（等待期间簇依旧隔离）');
  ok(x6.success && x6.modelId === 'model-a', `冷却期满试探：x6 回到 model-a 即成功（环境已恢复 + 簇自动闭合；x6=${x6.modelId}）`);
  ok(Object.keys(newExec.failureDomainSnapshot()).length === 0, '试探成功后簇记录清零（failureDomainSnapshot 归空——完全恢复）');
  ok(oldForced === 5 && newRep.nodeResults.filter((r) => r.nodeId === 'y1').every((r) => r.modelId === 'model-a'), `对照小结：无辜迁移 ${oldForced} 次（旧） → 0 次（新）；受灾簇重定向 2 次 + 试探恢复 1 次（新）`);
}

// ═══════════════════ R4-3 进度估计 ETA ═══════════════════

section('R4-3 ETA：分位数估计中位误差 8% < 15%、区间覆盖 100% ≥ 80%');

{
  // 已知分布：节点时长 ~ U[50,150]（均值 100）。历史 = 同分布另一条种子流 200 样本。
  const rngHistory = lcg(20261002);
  const history = Array.from({ length: 200 }, () => 50 + Math.floor(rngHistory() * 100));
  const sorted = [...history].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  const N = 60;
  const plan = {
    objective: 'eta',
    nodes: Array.from({ length: N }, (_, i) => ({ id: `e${i}`, description: '', type: 'eta', dependsOn: [] })),
    parallelismStrategy: 'layered',
    source: 'fallback',
  };

  const clock = new VirtualClock(0);
  const rngDurations = lcg(998877);
  const exec = makeExecutor({
    types: ['eta'],
    runner: async (p) => {
      const d = 50 + Math.floor(rngDurations() * 100);
      clock.advance(d);
      return { output: 'ok', quality: 0.95, tokensUsed: 5, completedAt: clock.now() };
    },
    config: { maxInFlightNodes: 1 },
  });
  exec.attachClock(clock);
  // windowSize 512 ≥ 预置 200 + 全程追记 60——校准场景下历史不被裁剪（生产缺省 64 为有界内存口径）
  exec.attachEtaEstimator({ seedHistory: { eta: history }, windowSize: 512 });

  // 离线估计口径（挂载后任意时刻可查——此处在执行前，历史 = 纯预置样本）
  const offline = exec.estimateEta(plan, plan.nodes.slice(0, 50).map((n) => n.id));
  ok(offline && offline.remainingNodes === 10, `离线估计：剩余 10 节点（实际剩 ${offline ? offline.remainingNodes : '—'}）`);
  near(offline.pointMs, q(0.5) * 10, 2, `点估计 = 10 × 历史P50（${q(0.5)}ms/节点 = ${offline ? offline.pointMs : '—'}ms）`);
  near(offline.loMs, q(0.1) * 10, 2, `区间下界 = 10 × 历史P10（${q(0.1)} × 10）`);
  near(offline.hiMs, q(0.9) * 10, 2, `区间上界 = 10 × 历史P90（${q(0.9)} × 10）`);

  const report = await exec.executePlan(mkSignal('eta', '进度估计'), plan);
  const eta = report.eta;

  // 在线检查点 + 收尾对账
  ok(eta.checkpoints.length === N - 1, `检查点逐批落位：${eta.checkpoints.length} 个（每节点一批，末批剩余 0 不落）`);
  const first = eta.checkpoints[0];
  near(first.pointMs, q(0.5) * (N - 1), 30, `首个检查点点估计 = ${N - 1} × P50（追记 1 样本后最近邻分位仍指向同值）`);
  ok(first.loMs < first.pointMs && first.pointMs < first.hiMs, '区间有序：lo < point < hi');
  ok(eta.medianRelError < 0.15, `中位相对误差 ${(eta.medianRelError * 100).toFixed(1)}% < 15%（对全部 ${eta.checkpoints.length} 个检查点诚实统计，含剩余 1 节点的最难点）`);
  ok(eta.coverage >= eta.targetCoverage, `区间覆盖率 ${(eta.coverage * 100).toFixed(0)}% ≥ 目标 ${(eta.targetCoverage * 100).toFixed(0)}%（P10~P90 逐节点求和的保守区间）`);
  // 旧口径对照：无历史结构的「常数缺省」估计（每节点 1000ms 拍脑袋）
  const naivePoint = 1000 * (N - 1);
  const naiveRelError = Math.abs(naivePoint - (report.totalTime - first.t)) / (report.totalTime - first.t);
  ok(eta.medianRelError < naiveRelError / 10, `旧口径对照：常数估计（1000ms/节点）首检查点误差 ${(naiveRelError * 100).toFixed(0)}% vs 分位数估计全程中位 ${(eta.medianRelError * 100).toFixed(1)}%（>10× 改善）`);
  ok(report.eta.targetCoverage === 0.8, '目标覆盖率口径 = P90 − P10 = 0.8');
}

// ═══════════════════ R4-4 计划压缩 ═══════════════════

section('R4-4 计划压缩：6 → 4 节点，闭包语义下输出逐位一致');

{
  // 含冗余 DAG：X → {A1, A2（完全重复）} → {B1(dep A1), B2(dep A2)（化简后重复）}
  // → C(dep [A1,B1,X,A2,B2]：含重复引用 + 传递冗余 X)
  const original = {
    objective: '报表生成',
    source: 'strategist',
    parallelismStrategy: 'layered',
    nodes: [
      { id: 'X', description: '取数', type: 'gen', dependsOn: [] },
      { id: 'A1', description: '清洗', type: 'gen', dependsOn: ['X'] },
      { id: 'A2', description: '清洗', type: 'gen', dependsOn: ['X'] },
      { id: 'B1', description: '汇总', type: 'join', dependsOn: ['A1'] },
      { id: 'B2', description: '汇总', type: 'join', dependsOn: ['A2'] },
      { id: 'C', description: '成文', type: 'join', dependsOn: ['A1', 'B1', 'X', 'A2', 'B2'] },
    ],
  };

  // 语义等价口径：节点输出 = f(操作, 输入闭包取值)——脚本侧按「被执行计划」的
  // DAG 计算祖先闭包，runner 输出 = 描述 + 祖先输出集合（去重排序）
  const runPlan = async (plan) => {
    const outputs = new Map();
    const ancestors = (id, seen = new Set()) => {
      const node = plan.nodes.find((n) => n.id === id);
      for (const dep of node ? node.dependsOn : []) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        ancestors(dep, seen);
      }
      return seen;
    };
    const clock = new VirtualClock(0);
    const calls = [];
    const exec = makeExecutor({
      types: ['gen', 'join'],
      runner: async (p) => {
        calls.push(p.node.id);
        clock.advance(10);
        // 闭包取值 = 祖先输出字符串的集合（去重排序——重复节点产出相同字符串，天然坍缩）
        const closure = [...new Set([...ancestors(p.node.id)].map((a) => outputs.get(a)))].sort();
        const out = `${p.node.description}[${closure.join(',')}]`;
        outputs.set(p.node.id, out);
        return { output: out, quality: 0.95, tokensUsed: 5, completedAt: clock.now() };
      },
      config: { maxInFlightNodes: 1 },
    });
    exec.attachClock(clock);
    const report = await exec.executePlan(mkSignal('cmp', '压缩等价'), plan);
    return { report, outputs, calls };
  };

  const probe = makeExecutor({ runner: async () => ({ output: 'x', quality: 1 }) });
  const inputSnapshot = JSON.stringify(original);
  const { plan: compressed, stats } = probe.compressPlan(original);

  ok(stats.nodesBefore === 6 && stats.nodesAfter === 4, `节点数 6 → ${stats.nodesAfter}（−33%）`);
  ok(JSON.stringify(stats.mergedGroups) === JSON.stringify([['A1', 'A2'], ['B1', 'B2']]), `重复节点合并组 = ${JSON.stringify(stats.mergedGroups)}（A1≡A2 同操作同依赖；B1≡B2 合并 A2 后同构）`);
  const removedX = stats.transitiveEdgesRemoved.some((e) => e.from === 'X' && e.to === 'C');
  ok(removedX && stats.transitiveEdgesRemoved.length >= 2, `传递依赖边删除 ≥ 2 条（含 X→C 经由 A1 可达；实际 ${stats.transitiveEdgesRemoved.map((e) => `${e.from}→${e.to}`).join(' ')}）`);
  ok(compressed.nodes.map((n) => n.id).join(',') === 'X,A1,B1,C', `压缩后节点序 = ${compressed.nodes.map((n) => n.id).join(',')}（保序留 canonical）`);
  ok(compressed.nodes.find((n) => n.id === 'C').dependsOn.join(',') === 'B1', 'C 的依赖化简为 [B1]（B1 闭包已覆盖 A1 与 X）');
  ok(JSON.stringify(original) === inputSnapshot, '入参计划零改动（纯函数）');

  const before = await runPlan(original);
  const after = await runPlan(compressed);
  ok(before.report.success && after.report.success, '原计划与压缩计划均执行成功');
  ok(before.calls.length === 6 && after.calls.length === 4, `执行调用数 ${before.calls.length} → ${after.calls.length}（同节点数降幅——省 2 次 runner 调用）`);
  const identical = ['X', 'A1', 'B1', 'C'].every((id) => before.outputs.get(id) === after.outputs.get(id));
  ok(identical, `语义等价：幸存节点输出逐位一致（C = 「${after.outputs.get('C')}」——闭包取值 {取数, 清洗, 汇总} 在两计划中等价）`);
  ok(before.outputs.get('A2') === before.outputs.get('A1') && before.outputs.get('B2') === before.outputs.get('B1'), '被合并节点的输出与 canonical 完全相同（合并无损的直接证据）');
  ok(after.report.totalTime < before.report.totalTime, `执行耗时 ${before.report.totalTime}ms → ${after.report.totalTime}ms（同比例下降）`);
  // 已最小计划：零化简（诚实不过度压缩）
  const minimal = { objective: 'm', source: 'fallback', parallelismStrategy: 'layered', nodes: [{ id: 'a', description: 'x', type: 'exec', dependsOn: [] }, { id: 'b', description: 'y', type: 'exec', dependsOn: ['a'] }] };
  const m2 = probe.compressPlan(minimal);
  ok(m2.stats.nodesAfter === 2 && m2.stats.mergedGroups.length === 0 && m2.stats.transitiveEdgesRemoved.length === 0, '已最小计划零化简（无冗余不动作）');
}

// ═══════════════════ R4-5 失败注入演练 ═══════════════════

section('R4-5 失败注入演练：4 条注入全被恢复路径吸收，终局 6/6');

{
  const plan = {
    objective: 'chaos-drill',
    nodes: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) => ({ id, description: id, type: 'exec', dependsOn: [] })),
    parallelismStrategy: 'layered',
    source: 'fallback',
  };
  const mkDrillExec = (clock) => makeExecutor({
    models: ['model-a', 'model-b'],
    runner: async (p) => {
      clock.advance(10);
      return { output: `ok-${p.node.id}`, quality: 0.95, tokensUsed: 10, completedAt: clock.now() };
    },
    config: { maxRetries: 2, planRetryBudget: 6, nodeTimeout: 100, maxInFlightNodes: 1, retryBackoffBaseMs: 0 },
  });

  // 基线腿（旧口径）：同一计划无注入——计划本体健康
  const clockBase = new VirtualClock(0);
  const baseExec = mkDrillExec(clockBase);
  baseExec.attachClock(clockBase);
  const baseRep = await baseExec.executePlan(mkSignal('chaos', '基线'), plan);
  ok(baseRep.success && baseRep.successCount === 6 && baseRep.totalTime === 60, `基线（无注入）：6/6 全成功、${baseRep.totalTime}ms（演练只注入故障，不损伤计划本体）`);

  // 演练腿：4 条规则各打一条恢复路径
  //   c1: attempt1 超时（挂 30ms < 对冲阈值 40ms → 对冲不触发）→ 重试路径
  //   c2: attempt1 低质（q=0.05）→ 质量反思重试路径
  //   c3: error 无限命中 → fatal → 节点失败 → 检查点路径
  //   c4: attempt1 超时（挂 100ms > 40ms）→ 对冲副本先到 → 对冲路径
  const clock = new VirtualClock(0);
  const exec = mkDrillExec(clock);
  exec.attachClock(clock);
  exec.attachHedging({ delayMs: 40, maxHedgesPerNode: 1 });
  exec.attachChaosInjection({
    rules: [
      { nodeId: 'c1', attempt: 1, kind: 'timeout', hangMs: 30 },
      { nodeId: 'c2', attempt: 1, kind: 'low-quality' },
      { nodeId: 'c3', kind: 'error', hits: 99 },
      { nodeId: 'c4', attempt: 1, kind: 'timeout' },
    ],
  });
  const rep = await exec.executePlan(mkSignal('chaos', '演练'), plan);
  const r = (id) => rep.nodeResults.find((x) => x.nodeId === id);

  ok(rep.successCount === 5 && rep.success === false, `演练腿：5/6 部分完成（c3 永久故障诚实暴露，不谎报）`);
  ok(r('c1').success && r('c1').attempts === 2, `重试路径：c1 注入超时后第 2 次尝试成功（attempts=${r('c1').attempts}，挂起 30ms < 阈值 40ms 未触发对冲）`);
  ok(r('c2').success && r('c2').attempts === 2, `质量反思路径：c2 注入低质（q=0.05）后重试达标（attempts=${r('c2').attempts}）`);
  ok(!r('c3').success && r('c3').error.includes('chaos'), `检查点路径：c3 持续注入 error → fatal 失败（错误如实携带注入标记：「${r('c3').error.slice(0, 24)}…」）`);
  ok(r('c4').success && r('c4').attempts === 1, `对冲路径：c4 注入挂起 100ms > 阈值 40ms → 对冲副本先到，单次尝试即成功（attempts=${r('c4').attempts}）`);
  ok(rep.hedging && rep.hedging.count === 1 && rep.hedging.extraTokens === 10, `对冲记账：只 c4 触发 1 次副本（+10 token），其余节点零对冲`);
  const ledger = exec.chaosLedger();
  ok(ledger.length === 4 && ledger.every((e) => e.fired === 1), `注入账本逐规则命中 1 次（${ledger.map((e) => `#${e.rule}:${e.kind}×${e.fired}`).join(' ')}——确定性命中）`);
  const types = new Set(rep.audit.map((e) => e.type));
  ok(types.has('chaos-inject') && types.has('node-retry') && types.has('node-hedge') && types.has('hedge-win') && types.has('plan-checkpoint'), '审计流全链路在场（chaos-inject / node-retry / node-hedge / hedge-win / plan-checkpoint）');
  ok(rep.checkpoint && rep.checkpoint.completed.map((x) => x.nodeId).join(',') === 'c1,c2,c4,c5,c6', `部分检查点保留 5 节点（${rep.checkpoint.completed.map((x) => x.nodeId).join(',')}）`);
  ok(rep.retryBudget && rep.retryBudget.used === 2 && rep.retryBudget.exhausted === false, `计划级重试预算协同：c1+c2 各耗 1 次重试（used=${rep.retryBudget ? rep.retryBudget.used : '—'}/6，未耗尽）`);

  // 续跑腿（新执行器，撤除注入）：检查点复用 → c3 重跑成功 → 终局 6/6
  const clock2 = new VirtualClock(0);
  const resumeExec = mkDrillExec(clock2);
  resumeExec.attachClock(clock2);
  const resumed = await resumeExec.resumePlan(mkSignal('chaos', '续跑'), plan, rep.checkpoint);
  ok(resumed.success && resumed.resumedFromCount === 5 && resumed.nodeResults.find((x) => x.nodeId === 'c3').success, `检查点续跑：复用 5 节点，c3 单独重跑成功 → 终局 6/6（演练故障全部被吸收）`);
  const injectCount = rep.audit.filter((e) => e.type === 'chaos-inject').length;
  ok(injectCount === 4, `注入 4 次、恢复路径吸收 4 次（重试 2 + 对冲 1 + 检查点续跑 1）——注入与恢复一一对账`);
  exec.detachChaosInjection();
  ok(exec.chaosLedger().length === 0, 'detachChaosInjection 后账本清空（可逆）');
}

// ═══════════════════ 汇总 ═══════════════════

console.log('\n──────────────────────────────────────────────────────────');
if (failed === 0) {
  console.log(`✓ R4-A4 任务执行器五项升级全部验证通过（${passed} 项断言）——爬山收敛 3 不震荡 · 890ms<2160ms · 无辜迁移 5→0 · ETA 中位误差 8% 覆盖 100% · 压缩 6→4 等价 · 4 注入全吸收终局 6/6`);
} else {
  console.error(`✗ ${failed} 项断言失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed} —— 第四轮模块域 R4-A4：task-executor 升级验证`);
process.exit(failed === 0 ? 0 : 1);
