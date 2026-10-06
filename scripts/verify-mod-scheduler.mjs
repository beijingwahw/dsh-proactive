/**
 * verify-mod-scheduler.mjs — 第三轮模块域 A3 升级：ModelScheduler 新旧行为对照验证
 *
 * 五项升级各配「旧行为 vs 新行为」的构造对照（不是「改了」，是「证明更好」）：
 *   ① 健康感知路由（A3-1）：EWMA 延迟/错误率 + 熔断器三态全链——虚拟时钟上
 *      构造故障序列：3 连败跳闸 open（旧口径：故障模型 10/10 仍被选中 vs
 *      新口径 0/10 换切）→ 指数退避（5000→10000→20000ms 逐级翻倍）→
 *      冷却期满 half-open 单探针槽（探活在途不再派活）→ 探活成功复位 /
 *      失败退避翻倍重开；另证纯延迟 EWMA 跳闸线与 EWMA 错误率健康乘数降权
 *      （0.99 分故障缠身模型被 0.85 分干净模型翻盘）、全池熔断强制探活不抛错。
 *   ② 两次选择幂 P2C（A3-2）：4 模型 120 次派发，注入负载读数 + 种子化 RNG——
 *      最大负载 P2C < 纯随机（power of two choices），离差同步收窄；质量门
 *      排除低分模型；未挂载 argmax 120/120 集中单点（旧 vs 新负载对照）。
 *   ③ 成本画像（A3-3）：mock 调用注入差异化 token/延迟统计——无 Pareto 时
 *      画像退化为 costWeight 透传（quality→0 / cost→1 / balanced→原参数逐位
 *      不动，三画像选出三个不同模型）；挂载 67.0 前沿后按画像在前沿选点
 *      （min 风险 / min 成本 / 距理想点最近），'*' 兜底与精确覆盖语义在案。
 *   ④ 每模型重试预算（A3-4）：滑动窗配额原子准入——单模型 2 配额第 3 次拒纳
 *      并计降级；窗口滑出恢复；冲击场景 12 次重试请求恰准入 6 次（旧口径
 *      12/12 无限重试）；超限模型从动态选型/降级候选剔除、全池超限软放行。
 *   ⑤ 调度审计（A3-5）：preferred/scored/profile-pareto 路径结构化落账，
 *      候选集 + 健康快照 + 画像 + 结论齐备；环形有界（4 容量留 4 条、seq
 *      单调）；纯旁路（有审计与无审计的决策逐位相同）。
 *   ⑥ 组合场景：健康闸门 × 重试预算 × P2C × 审计同挂——最优模型重试超限 →
 *      次优熔断 → 三号位接盘，审计候选集同步收缩，全链降级可观测。
 *   ⓪ 零漂移总检：全部 A3 面缺省时读数缺席、argmax/preferred/avoidModels
 *      逐位保持；未挂载时健康回报/重试准入无去处不改行为。
 *
 * 确定性：全部时间走注入虚拟时钟；随机走种子化 mulberry32；无真定时器、
 * 无真网络（LLMClient 经 externalChat 离线注入统计）。
 *
 * 运行：npm run build && node scripts/verify-mod-scheduler.mjs
 */

import { LLMClient, ModelScheduler, mulberry32 } from '../dist/index.mjs';

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

// ─────────────────────────── 构造工具 ───────────────────────────

/** 贝叶斯画像（有效样本 20 → 记忆权重满格 0.6、探索加成关闭——确定性评分） */
function est(posteriorMean, wilsonLower, effectiveSamples = 20, emaQuality = 0.6) {
  return {
    modelId: '',
    taskType: '',
    alpha: posteriorMean * effectiveSamples + 1,
    beta: (1 - posteriorMean) * effectiveSamples + 1,
    posteriorMean,
    wilsonLower,
    effectiveSamples,
    rawSuccessRate: posteriorMean,
    drift: 0,
    emaQuality,
  };
}

/** 记忆 stub（getBayesianEstimate 消费面；未列模型 → undefined） */
function stubMemory(byModel) {
  return { getBayesianEstimate: (id) => byModel[id] };
}

/** 离线 LLMClient（endpoint 指向 mock 主机，不发真实请求） */
function makeLlm(models) {
  const llm = new LLMClient();
  for (const m of models) llm.registerModel({ id: m.id, endpoint: 'http://mock.local', initialCapabilities: { taskScores: m.taskScores } });
  return llm;
}

/**
 * 统计可种子化的 LLMClient：externalChat 离线注入（tokens/延迟精确控制），
 * 虚拟时钟随调用推进——avgTokens / avgLatency 确定性入账（Pareto 成本/延迟口径）。
 */
function makeSeededLlm(models, callsByModel) {
  const clockState = { now: 1_000_000 };
  const queues = new Map(Object.entries(callsByModel).map(([id, list]) => [id, [...list]]));
  const llm = new LLMClient({
    nowImpl: () => clockState.now,
    externalChat: async (modelId) => {
      const q = queues.get(modelId) ?? [];
      const r = q.shift() ?? { tokens: 1000, latencyMs: 300 };
      clockState.now += r.latencyMs;
      return { content: 'ok', model: modelId, latency: r.latencyMs, tokensUsed: r.tokens, cost: 0, retries: 0 };
    },
  });
  for (const m of models) llm.registerModel({ id: m.id, endpoint: 'http://mock.local', initialCapabilities: { taskScores: m.taskScores } });
  return { llm, clockState };
}

/** 虚拟时钟 */
function vclock(start = 1_000_000) {
  const state = { now: start };
  return { state, clock: () => state.now };
}

// ═══════════════════ ⓪ 零漂移总检（缺省 = 旧行为） ═══════════════════

section('⓪ 零漂移总检：全部 A3 面缺省时读数缺席、选型行为逐位保持');

{
  const llm = makeLlm([
    { id: 'm-hi', taskScores: { test: 0.9 } },
    { id: 'm-mid', taskScores: { test: 0.7 } },
    { id: 'm-lo', taskScores: { test: 0.5 } },
  ]);
  const memory = stubMemory({ 'm-hi': est(0.7, 0.6), 'm-mid': est(0.6, 0.5), 'm-lo': est(0.5, 0.4) });
  const s = new ModelScheduler({ llm, memory });

  ok(
    [
      'attachHealthRouting', 'reportModelHealth', 'healthView', 'detachHealthRouting', 'healthMultiplierOf',
      'attachP2C', 'detachP2C', 'lastP2CDecision',
      'bindCostProfile', 'clearCostProfile', 'costProfileOf',
      'attachRetryBudget', 'detachRetryBudget', 'admitRetry', 'retryBudgetView',
      'attachSchedulingAudit', 'getSchedulingAudit',
    ].every((m) => typeof s[m] === 'function'),
    'A3 挂载/读数方法面完整（17 个）',
  );
  ok(
    s.healthView() === undefined && s.retryBudgetView() === undefined && s.getSchedulingAudit() === undefined && s.lastP2CDecision() === undefined,
    '四类读数全部缺席（未挂载 → undefined——诚实降级）',
  );
  ok(s.costProfileOf('test') === undefined, '画像未绑定 → undefined（零漂移）');
  ok(s.healthMultiplierOf('m-hi') === 1, '健康乘数未挂载恒 1（评分链逐位不变）');
  ok(s.assignModel('test') === 'm-hi' && s.rankCandidateScores('test')[0].id === 'm-hi', '未挂载任何 A3 面：argmax = 评分榜首 m-hi（原路径）');
  ok(s.assignModel('test', 'm-lo') === 'm-lo', 'preferred 短路保持（m-lo 被推荐即选中）');
  ok(s.assignModel('test', undefined, undefined, { avoidModels: ['m-hi'] }) === 'm-mid', 'avoidModels 剔除保持（m-hi 规避 → m-mid）');

  for (let i = 0; i < 10; i += 1) s.reportModelHealth('m-hi', { failed: true, latencyMs: 9_999 });
  ok(s.assignModel('test') === 'm-hi', '未挂载健康路由：10 连败回报无去处，m-hi 仍 10/10 被选中（旧口径）');
  ok(s.admitRetry('m-hi').allowed === true && s.admitRetry('m-hi').quota === Number.POSITIVE_INFINITY, '未挂载重试预算：admitRetry 恒放行、配额无穷（旧口径）');

  s.attachParetoFront();
  ok(Array.isArray(s.paretoFrontView('test')?.points), '67.0 帕累托既有挂载面共存无恙（不因 A3 破坏）');
}

// ═══════════════════ ① A3-1 健康感知路由（EWMA + 熔断器三态全链） ═══════════════════

section('① A3-1 健康感知路由：故障序列在虚拟时钟上证开 → 切 → 退避 → 探活 → 复位全链');

{
  const llm = makeLlm([
    { id: 'model-a', taskScores: { test: 0.95 } },
    { id: 'model-b', taskScores: { test: 0.8 } },
    { id: 'model-c', taskScores: { test: 0.6 } },
  ]);
  const memory = stubMemory({ 'model-a': est(0.7, 0.6), 'model-b': est(0.65, 0.55), 'model-c': est(0.6, 0.5) });
  const { state: clk, clock } = vclock();

  // ── 旧口径对照：无健康路由，故障模型永远最高分 ──
  const oldS = new ModelScheduler({ llm, memory });
  for (let i = 0; i < 10; i += 1) oldS.reportModelHealth('model-a', { failed: true, latencyMs: 100 });
  let oldPicks = 0;
  for (let i = 0; i < 10; i += 1) if (oldS.assignModel('test') === 'model-a') oldPicks += 1;
  ok(oldPicks === 10, `旧口径：10 连败遥测下故障模型仍被选中 ${oldPicks}/10（无健康感知）`);

  // ── 新口径：EWMA + 熔断器三态机 ──
  const s = new ModelScheduler({ llm, memory });
  s.attachHealthRouting({ ewmaAlpha: 0.3, failureThreshold: 3, errorThreshold: 0.999, halfOpenAfterMs: 5_000, backoffMultiplier: 2, maxBackoffMs: 60_000, errorPenaltyWeight: 0.5, clock });

  s.reportModelHealth('model-a', { failed: true, latencyMs: 100 });
  s.reportModelHealth('model-a', { failed: true, latencyMs: 100 });
  let view = s.healthView() ?? [];
  ok(view.length === 1 && view[0].breaker === 'closed', '2 连败未达阈值 3：熔断器仍 closed（供电）');
  ok(near(view[0].healthMultiplier, 1 - 0.5 * 0.51, 1e-9), `EWMA 错误率 0.51 → 健康乘数 ${view[0].healthMultiplier.toFixed(3)}（未跳闸先软降权）`);
  ok(s.assignModel('test') === 'model-b', `软降权生效：0.692×${view[0].healthMultiplier.toFixed(3)} < 0.620 → 未跳闸已让位 model-b（分级响应第一级）`);

  clk.now += 1;
  s.reportModelHealth('model-a', { failed: true, latencyMs: 100 });
  view = s.healthView() ?? [];
  const openAt = view[0].openedAt;
  ok(view[0].breaker === 'open' && view[0].backoffMs === 5_000 && openAt === clk.now, `3 连败跳闸：open（退避基准 5000ms，openedAt=${openAt}）`);
  ok(near(view[0].ewmaErrorRate, 0.657, 1e-9) && near(view[0].ewmaLatencyMs, 100, 1e-9), `EWMA 遥测：错误率 ${view[0].ewmaErrorRate.toFixed(3)}（α=0.3 三连败收敛值 0.657）、延迟 ${view[0].ewmaLatencyMs}ms`);

  let newPicks = 0;
  let switched = 0;
  for (let i = 0; i < 10; i += 1) {
    const m = s.assignModel('test');
    if (m === 'model-a') newPicks += 1;
    if (m === 'model-b') switched += 1;
  }
  ok(newPicks === 0 && switched === 10, `新口径：熔断后 10 次派发故障模型 0/10、全部换切 model-b（旧 ${oldPicks}/10 vs 新 ${newPicks}/10）`);

  // ── 指数退避：冷却差 1ms 都不放行，期满惰性转 half-open ──
  clk.now += 4_999;
  ok(s.assignModel('test') === 'model-b', `冷却差 1ms 不放行（4999 < 5000ms 退避中 → model-b）`);
  clk.now += 1;
  ok(s.assignModel('test') === 'model-a', '冷却期满（5000ms）惰性转 half-open：model-a 作为探针候选重回榜首');
  view = s.healthView() ?? [];
  ok(view[0].breaker === 'half-open' && view[0].probeInFlight === true, '探针占槽：选中即 probeInFlight=true（半开单探针）');
  ok(s.assignModel('test') === 'model-b', '探活在途不再派活（单探针槽占用 → model-b 接盘）');

  s.reportModelHealth('model-a', { failed: false, latencyMs: 100 });
  view = s.healthView() ?? [];
  ok(view[0].breaker === 'closed' && view[0].probeInFlight === false && view[0].backoffMs === 5_000, '探活成功：closed 复位、探针槽释放、退避回基准');
  ok(s.assignModel('test') === 'model-b', `复位但信誉未复：EWMA 记忆 ${view[0].ewmaErrorRate.toFixed(3)} → 乘数 ${view[0].healthMultiplier.toFixed(3)}，model-b 暂守（惩罚有界不冤枉）`);
  for (let i = 0; i < 2; i += 1) s.reportModelHealth('model-a', { failed: false, latencyMs: 100 });
  ok(s.assignModel('test') === 'model-b', '连续成功信誉回升中（EWMA 指数衰减 0.46→0.32→0.23，仍未越过 0.62 分位）');
  s.reportModelHealth('model-a', { failed: false, latencyMs: 100 });
  view = s.healthView() ?? [];
  ok(s.assignModel('test') === 'model-a', `信誉恢复夺回榜首：第 4 次成功后乘数 ${view[0].healthMultiplier.toFixed(3)} → 0.692×乘数 > 0.620（软降权可恢复）`);

  // ── 探针失败 → 指数退避翻倍（5000 → 10000 → 20000）──
  const backoffs = [];
  for (let round = 0; round < 2; round += 1) {
    for (let i = 0; i < 3; i += 1) {
      clk.now += 1;
      s.reportModelHealth('model-a', { failed: true, latencyMs: 100 });
    }
    view = s.healthView() ?? [];
    const anchor = view[0].openedAt ?? clk.now;
    ok(view[0].breaker === 'open', `第 ${round + 1} 轮重熔断：open（退避 ${view[0].backoffMs}ms）`);
    clk.now = anchor + view[0].backoffMs - 1;
    ok(s.assignModel('test') === 'model-b', `  退避差 1ms 不放行（${view[0].backoffMs - 1} < ${view[0].backoffMs}ms）`);
    clk.now = anchor + view[0].backoffMs;
    ok(s.assignModel('test') === 'model-a', `  冷却期满转半开探活（model-a 第 ${round + 1} 次探针）`);
    s.reportModelHealth('model-a', { failed: true, latencyMs: 100 });
    view = s.healthView() ?? [];
    backoffs.push(view[0].backoffMs);
  }
  ok(backoffs[0] === 10_000 && backoffs[1] === 20_000, `探针失败指数退避：5000 → ${backoffs[0]} → ${backoffs[1]}ms（逐级翻倍）`);

  // ── 纯延迟 EWMA 跳闸线（零错误但慢死 = 半死） ──
  {
    const slowLlm = makeLlm([
      { id: 'fast', taskScores: { test: 0.9 } },
      { id: 'slow', taskScores: { test: 0.97 } },
    ]);
    const mem = stubMemory({ fast: est(0.6, 0.5), slow: est(0.6, 0.5) });
    const { state: clk2, clock: clock2 } = vclock();
    const ss = new ModelScheduler({ llm: slowLlm, memory: mem });
    ok(ss.assignModel('test') === 'slow', '延迟跳闸前：最高分 slow 0.97 入选（旧口径）');
    ss.attachHealthRouting({ ewmaAlpha: 0.3, failureThreshold: 99, errorThreshold: 0.999, latencyTripMs: 3_000, minObservations: 3, clock: clock2 });
    for (let i = 0; i < 3; i += 1) ss.reportModelHealth('slow', { failed: false, latencyMs: 4_000 });
    let v = ss.healthView() ?? [];
    ok(v[0].breaker === 'open' && near(v[0].ewmaLatencyMs, 4_000, 1e-9), '零错误但 EWMA 延迟 4000ms ≥ 跳闸线 3000ms：slow 熔断 open');
    ok(ss.assignModel('test') === 'fast', '延迟熔断后换切 fast（0.90 接盘 0.97——慢死不再吃流量）');
    ss.reportModelHealth('fast', { failed: false, latencyMs: 1_000 });
    ss.reportModelHealth('fast', { failed: false, latencyMs: 2_000 });
    v = ss.healthView() ?? [];
    const fastEntry = v.find((e) => e.modelId === 'fast');
    ok(near(fastEntry.ewmaLatencyMs, 1_300, 1e-9), `EWMA 延迟平滑：1000 → 2000 后收敛 ${fastEntry.ewmaLatencyMs}（= 0.3×2000 + 0.7×1000）`);
  }

  // ── EWMA 错误率健康乘数降权（未跳闸但劣化 → 先降权后熔断的软着陆） ──
  {
    const flLlm = makeLlm([
      { id: 'flaky', taskScores: { test: 0.99 } },
      { id: 'clean', taskScores: { test: 0.85 } },
    ]);
    const mem = stubMemory({ flaky: est(0.6, 0.5), clean: est(0.6, 0.5) });
    const ss0 = new ModelScheduler({ llm: flLlm, memory: mem });
    ok(ss0.assignModel('test') === 'flaky', '健康乘子未挂载：0.99 分 flaky 稳居榜首（旧口径）');
    const { state: clk3, clock: clock3 } = vclock();
    const ss = new ModelScheduler({ llm: flLlm, memory: mem });
    ss.attachHealthRouting({ ewmaAlpha: 0.5, failureThreshold: 3, errorThreshold: 0.999, errorPenaltyWeight: 0.9, clock: clock3 });
    for (const failed of [true, false, true, false, true]) ss.reportModelHealth('flaky', { failed, latencyMs: 100 });
    let v = ss.healthView() ?? [];
    ok(v[0].breaker === 'closed' && near(v[0].ewmaErrorRate, 0.65625, 1e-9), `交替胜负（F/S/F/S/F）连败不达 3：仍 closed，EWMA 错误率 ${v[0].ewmaErrorRate.toFixed(4)}（= 0.5+0.5×(0+0.5×(0.5+0.5×(0.25)))）`);
    ok(near(v[0].healthMultiplier, 1 - 0.9 * 0.65625, 1e-9), `健康乘数 = 1 − 0.9×${v[0].ewmaErrorRate.toFixed(4)} = ${v[0].healthMultiplier.toFixed(4)}（软降权）`);
    ok(ss.assignModel('test') === 'clean', `软降权翻盘：0.99×${v[0].healthMultiplier.toFixed(3)} < 0.85×1 → clean 入选（未熔断先降权）`);
  }

  // ── 全池熔断强制探活（永不因健康闸门抛新错） ──
  {
    const bothLlm = makeLlm([
      { id: 'x1', taskScores: { test: 0.9 } },
      { id: 'x2', taskScores: { test: 0.8 } },
    ]);
    const mem = stubMemory({ x1: est(0.6, 0.5), x2: est(0.6, 0.5) });
    const { state: clk4, clock: clock4 } = vclock();
    const ss = new ModelScheduler({ llm: bothLlm, memory: mem });
    ss.attachHealthRouting({ failureThreshold: 2, errorThreshold: 0.999, halfOpenAfterMs: 5_000, clock: clock4 });
    for (let i = 0; i < 2; i += 1) ss.reportModelHealth('x1', { failed: true });
    clk4.now += 1;
    for (let i = 0; i < 2; i += 1) ss.reportModelHealth('x2', { failed: true });
    let v = ss.healthView() ?? [];
    ok(v.every((e) => e.breaker === 'open'), '全池熔断：x1/x2 双双 open');
    let threw = false;
    let chosen;
    try {
      chosen = ss.assignModel('test');
    } catch {
      threw = true;
    }
    v = ss.healthView() ?? [];
    const forced = v.find((e) => e.breaker === 'half-open');
    ok(!threw && chosen === 'x1' && forced?.modelId === 'x1', `全池熔断降级：最早熔断者 x1 强制转半开探活（选择 ${chosen}，不抛错）`);
  }
}

// ═══════════════════ ② A3-2 两次选择幂（P2C）负载均衡 ═══════════════════

section('② A3-2 P2C 负载均衡：异构负载下最大负载 < 纯随机（power of two choices）');

{
  const models = ['p1', 'p2', 'p3', 'p4'].map((id) => ({ id, taskScores: { test: 0.9 } }));
  const llm = makeLlm(models);
  const memory = stubMemory(Object.fromEntries(models.map((m) => [m.id, est(0.6, 0.5)])));

  // ── 旧口径：argmax 全部涌向单点 ──
  const oldS = new ModelScheduler({ llm, memory });
  const oldLoads = { p1: 0, p2: 0, p3: 0, p4: 0 };
  for (let i = 0; i < 120; i += 1) oldLoads[oldS.assignModel('test')] += 1;
  const oldMax = Math.max(...Object.values(oldLoads));
  ok(oldMax === 120, `旧口径（argmax 无负载感知）：120 次派发 100% 涌向单点（最大负载 ${oldMax}/120）`);

  // ── 纯随机基线（同种子 RNG 流） ──
  const randomLoads = { p1: 0, p2: 0, p3: 0, p4: 0 };
  const rand = mulberry32(20261002);
  for (let i = 0; i < 120; i += 1) randomLoads[`p${Math.floor(rand() * 4) + 1}`] += 1;
  const randomMax = Math.max(...Object.values(randomLoads));
  const randomSpread = randomMax - Math.min(...Object.values(randomLoads));

  // ── 新口径：P2C ──
  const runP2C = () => {
    const loads = { p1: 0, p2: 0, p3: 0, p4: 0 };
    const s = new ModelScheduler({ llm, memory });
    s.attachP2C({ loadOf: (id) => loads[id], random: mulberry32(20261002), scoreGate: 0.9 });
    for (let i = 0; i < 120; i += 1) loads[s.assignModel('test')] += 1;
    return loads;
  };
  const p2cLoads = runP2C();
  const p2cMax = Math.max(...Object.values(p2cLoads));
  const p2cSpread = p2cMax - Math.min(...Object.values(p2cLoads));
  ok(
    p2cMax < randomMax,
    `P2C 最大负载 ${p2cMax} < 纯随机 ${randomMax}（120 派发 / 4 模型——两次选择幂把尾部压短）`,
  );
  ok(p2cSpread < randomSpread, `负载离差同步收窄：P2C ${p2cSpread} < 随机 ${randomSpread}（p2c 分布 ${JSON.stringify(p2cLoads)}）`);
  ok(p2cMax < oldMax, `对旧口径的数字对照：最大负载 ${p2cMax} vs argmax ${oldMax}（负载感知入调度）`);
  const replay = runP2C();
  ok(JSON.stringify(replay) === JSON.stringify(p2cLoads), '种子化 RNG 确定性：同种子重放逐位复现同一负载分布');

  // ── 微观确定性：受控随机源下两候对比 ──
  {
    const loads = { p1: 0.9, p2: 0.5, p3: 0.5, p4: 0.1 };
    const s = new ModelScheduler({ llm, memory });
    const seq = [0, 0.99];
    s.attachP2C({ loadOf: (id) => loads[id], random: () => seq.shift(), scoreGate: 0.5 });
    const m = s.assignModel('test');
    const d = s.lastP2CDecision();
    ok(
      d.aId === 'p1' && d.bId === 'p4' && near(d.loadA, 0.9) && near(d.loadB, 0.1) && d.chosenId === 'p4' && m === 'p4',
      `受控两候：抽中 p1(0.9) vs p4(0.1) → 取轻者 p4（lastP2CDecision 结构在案）`,
    );
  }

  // ── 质量门：低分模型不因负载均衡入选 ──
  {
    const gatedLlm = makeLlm([...models, { id: 'garbage', taskScores: { test: 0.2 } }]);
    const gatedMemory = stubMemory({ ...Object.fromEntries(models.map((m) => [m.id, est(0.6, 0.5)])), garbage: est(0.6, 0.5) });
    const loads = { p1: 0, p2: 0, p3: 0, p4: 0, garbage: 0 };
    const s = new ModelScheduler({ llm: gatedLlm, memory: gatedMemory });
    s.attachP2C({ loadOf: (id) => loads[id], random: mulberry32(7), scoreGate: 0.9 });
    let garbagePicks = 0;
    for (let i = 0; i < 60; i += 1) {
      const m = s.assignModel('test');
      loads[m] += 1;
      if (m === 'garbage') garbagePicks += 1;
    }
    ok(garbagePicks === 0, `质量门（scoreGate 0.9）：60 次派发 garbage(0.2 分) 0 次入选（负载均衡不以质量为代价）`);

    // 未挂载 P2C → lastP2CDecision 缺席 + argmax 回归
    const s2 = new ModelScheduler({ llm: gatedLlm, memory: gatedMemory });
    ok(s2.lastP2CDecision() === undefined && s2.assignModel('test') === 'p1', '未挂载 P2C：读数缺席、argmax 回归（零漂移）');
  }
}

// ═══════════════════ ③ A3-3 成本画像选择 ═══════════════════

section('③ A3-3 成本画像：quality/cost/balanced 三画像选出三个不同模型');

{
  // 统计种子化：premium 3000 tok/次、mid 1500、cheap 500；延迟一律 300ms
  const spec = [
    { id: 'premium', taskScores: { test: 0.9 } },
    { id: 'mid', taskScores: { test: 0.86 } },
    { id: 'cheap', taskScores: { test: 0.5 } },
  ];
  const calls = {
    premium: [{ tokens: 3000, latencyMs: 300 }, { tokens: 3000, latencyMs: 300 }],
    mid: [{ tokens: 1500, latencyMs: 300 }, { tokens: 1500, latencyMs: 300 }],
    cheap: [{ tokens: 500, latencyMs: 300 }, { tokens: 500, latencyMs: 300 }],
  };
  const { llm } = makeSeededLlm(spec, calls);
  for (const m of spec) {
    await llm.chat(m.id, [{ role: 'user', content: 'x' }]);
    await llm.chat(m.id, [{ role: 'user', content: 'x' }]);
  }
  const stats = Object.fromEntries(llm.getModelStatuses().map((s) => [s.id, { tokens: s.totalTokensUsed / s.totalCalls, latency: s.avgLatency }]));
  ok(stats.premium.tokens === 3000 && stats.mid.tokens === 1500 && stats.cheap.tokens === 500 && stats.premium.latency === 300, `统计种子在案：avgTokens 3000/1500/500、avgLatency 300（externalChat 离线注入）`);

  const memory = stubMemory({ premium: est(0.6, 0.55), mid: est(0.6, 0.55), cheap: est(0.6, 0.55) });
  const s = new ModelScheduler({ llm, memory });

  // ── 退化路径（未挂载 67.0 前沿）：画像透传 costWeight ──
  const unbound = s.assignModel('test');
  ok(unbound === 'mid', `未绑定画像（原参数 costWeight 0.2）：入选 ${unbound}（基准口径）`);
  s.bindCostProfile('test', 'quality');
  ok(s.costProfileOf('test') === 'quality', '画像绑定可读（costProfileOf 精确命中）');
  ok(s.assignModel('test') === 'premium', 'quality 画像（costWeight→0 纯质量）：premium 入选（0.90 分最高）');
  s.bindCostProfile('test', 'cost');
  ok(s.assignModel('test') === 'cheap', 'cost 画像（costWeight→1 纯成本效率）：cheap 入选（500 tok/次最廉）');
  s.bindCostProfile('test', 'balanced');
  ok(s.assignModel('test') === 'mid' && s.assignModel('test') === unbound, `balanced 画像（原参数逐位不动）：mid = 未绑定基线（零漂移）`);
  ok(s.getPolicy().params.costWeight === 0.2, '策略参数本体未被画像污染（bind 只影响解析态）');

  // ── '*' 兜底与精确覆盖 ──
  s.clearCostProfile();
  s.bindCostProfile('*', 'cost');
  ok(s.assignModel('other-task') === 'cheap' && s.costProfileOf('other-task') === 'cost', "'*' 兜底：未精确绑定的类别继承 cost 画像");
  s.bindCostProfile('other-task', 'quality');
  ok(s.costProfileOf('other-task') === 'quality' && s.costProfileOf('nonsense') === 'cost', "精确绑定覆盖兜底（other-task=quality，nonsense 仍走 '*' 兜底→cost）");
  s.clearCostProfile('other-task');
  ok(s.costProfileOf('other-task') === 'cost' && s.costProfileOf('nonsense') === 'cost', '单类别解除后回退兜底');
  s.clearCostProfile();
  ok(s.costProfileOf('nonsense') === undefined && s.assignModel('test') === unbound, 'clearCostProfile() 清空全部：完全回到未绑定基线（零漂移）');

  // ── Pareto 路径（挂载 67.0 前沿）：画像在前沿上选点 ──
  const paretoMemory = stubMemory({ premium: est(0.6, 0.9), mid: est(0.6, 0.7), cheap: est(0.6, 0.4) });
  const ps = new ModelScheduler({ llm, memory: paretoMemory });
  ps.attachParetoFront();
  const view = ps.paretoFrontView('test');
  ok(view.frontIds.length === 3, `Pareto 前沿三点齐备（风险 0.1/0.3/0.6 × 成本 3000/1500/500 全非支配）`);
  ps.bindCostProfile('test', 'quality');
  const qInsight = ps.assignModelWithInsight('test');
  ok(qInsight.modelId === 'premium' && qInsight.rationale.includes('Pareto'), `quality 画像 × 前沿：min 风险 → premium（rationale 走前沿路径）`);
  ps.bindCostProfile('test', 'cost');
  ok(ps.assignModel('test') === 'cheap', 'cost 画像 × 前沿：min 成本 → cheap（500 tok/次）');
  ps.bindCostProfile('test', 'balanced');
  ok(ps.assignModel('test') === 'mid', 'balanced 画像 × 前沿：距理想点最近（归一化 (0.4,0.4)）→ mid 拐点');
  ps.clearCostProfile();
  ok(ps.assignModelWithInsight('test').modelId === 'premium' && !ps.assignModelWithInsight('test').rationale.includes('Pareto'), '前沿挂载但未绑定画像：零漂移回评分路径（rationale 不含前沿口径）');

  // ── 边界：前沿不可用（单模型）时诚实降级 ──
  {
    const oneLlm = makeLlm([{ id: 'solo', taskScores: { test: 0.8 } }]);
    const ss = new ModelScheduler({ llm: oneLlm, memory: stubMemory({ solo: est(0.6, 0.5) }) });
    ss.attachParetoFront();
    ss.bindCostProfile('test', 'cost');
    ok(ss.paretoFrontView('test') === undefined && ss.assignModel('test') === 'solo', '前沿点数 < 2 → 视图 undefined，画像退化评分路径不抛错（诚实降级）');
  }
}

// ═══════════════════ ④ A3-4 每模型重试预算 ═══════════════════

section('④ A3-4 重试预算：滑动窗配额原子准入 + 超限降级换模型');

{
  const llm = makeLlm([
    { id: 'model-a', taskScores: { test: 0.95 } },
    { id: 'model-b', taskScores: { test: 0.8 } },
    { id: 'model-c', taskScores: { test: 0.7 } },
  ]);
  const memory = stubMemory({ 'model-a': est(0.7, 0.6), 'model-b': est(0.65, 0.55), 'model-c': est(0.6, 0.5) });
  const { state: clk, clock } = vclock(50_000);

  // 未挂载：恒放行（旧口径无限重试）
  const oldS = new ModelScheduler({ llm, memory });
  let oldAdmitted = 0;
  for (let i = 0; i < 12; i += 1) if (oldS.admitRetry('model-a').allowed) oldAdmitted += 1;
  ok(oldAdmitted === 12, `旧口径：12 次重试请求全准入 ${oldAdmitted}/12（无预算概念）`);

  const s = new ModelScheduler({ llm, memory });
  ok(s.retryBudgetView() === undefined, '未挂载预算：读数 undefined（诚实降级）');
  s.attachRetryBudget({ windowMs: 10_000, maxRetriesPerModel: 2, clock });

  const r1 = s.admitRetry('model-a');
  const r2 = s.admitRetry('model-a');
  const r3 = s.admitRetry('model-a');
  ok(r1.allowed && r1.used === 1 && r2.allowed && r2.used === 2 && !r3.allowed && r3.used === 2, `单模型配额 2：第 1/2 次准入（used 1→2）、第 3 次拒纳（used 仍 2）`);
  let view = s.retryBudgetView() ?? [];
  const aEntry = view.find((e) => e.modelId === 'model-a');
  ok(aEntry.degraded === 1 && aEntry.quota === 2 && aEntry.windowMs === 10_000, `超限降级计数在案：degraded=1（quota 2 / 窗 10s）`);

  clk.now += 10_001;
  const r4 = s.admitRetry('model-a');
  ok(r4.allowed && r4.used === 1, `窗口滑出恢复：+10_001ms 后旧记账失效（used 回 1）`);
  view = s.retryBudgetView() ?? [];
  ok((view.find((e) => e.modelId === 'model-a') ?? {}).used === 1, '视图与准入同一滑窗口径');

  // ── 冲击场景：3 模型 × 4 请求轮转，恰准入 6 截断 6 ──
  {
    const { state: clk2, clock: clock2 } = vclock(90_000);
    const s2 = new ModelScheduler({ llm, memory });
    s2.attachRetryBudget({ windowMs: 10_000, maxRetriesPerModel: 2, clock: clock2 });
    let admitted = 0;
    let denied = 0;
    for (let i = 0; i < 4; i += 1) {
      for (const id of ['model-a', 'model-b', 'model-c']) {
        if (s2.admitRetry(id).allowed) admitted += 1;
        else denied += 1;
      }
    }
    const v = s2.retryBudgetView() ?? [];
    const totalDegraded = v.reduce((sum, e) => sum + e.degraded, 0);
    ok(admitted === 6 && denied === 6 && totalDegraded === 6, `冲击截断：12 请求恰准入 6 / 拒纳 6（旧 ${oldAdmitted}/12 vs 新 ${admitted}/12），降级计数 6 分摊三模型`);
    ok(v.every((e) => e.used === 2), '配额截断后三模型窗口内均满载（used=2=quota）');
  }

  // ── 超限模型从动态选型剔除 ──
  {
    const { state: clk3, clock: clock3 } = vclock(200_000);
    const s3 = new ModelScheduler({ llm, memory });
    ok(s3.assignModel('test') === 'model-a', '预算挂载前：model-a 最高分入选');
    s3.attachRetryBudget({ windowMs: 60_000, maxRetriesPerModel: 2, clock: clock3 });
    s3.admitRetry('model-a');
    s3.admitRetry('model-a');
    ok(s3.assignModel('test') === 'model-b', 'model-a 窗口内配额耗尽 → 动态选型剔除 → model-b 接盘（超限降级换模型）');
    clk3.now += 60_001;
    ok(s3.assignModel('test') === 'model-a', '窗口滑出后 model-a 恢复资格');
    clk3.now += 60_001;
    s3.admitRetry('model-b');
    s3.admitRetry('model-b');
    ok(s3.pickFallbackModel('test', 'model-a') === 'model-c', 'pickFallbackModel 同步剔除超限 model-b → 降级候选 model-c');
    s3.admitRetry('model-c');
    s3.admitRetry('model-c');
    const relaxed = s3.pickFallbackModel('test', 'model-a');
    ok(relaxed === 'model-b' || relaxed === 'model-c', `全池超限软放行：降级候选不因预算枯竭断供（relaxed → ${relaxed}，软闸门语义）`);
  }
}

// ═══════════════════ ⑤ A3-5 调度审计（旁路有界环形） ═══════════════════

section('⑤ A3-5 调度审计：候选集/健康/画像/决定因子结构化导出');

{
  const llm = makeLlm([
    { id: 'model-a', taskScores: { test: 0.95 } },
    { id: 'model-b', taskScores: { test: 0.8 } },
  ]);
  const memory = stubMemory({ 'model-a': est(0.7, 0.6), 'model-b': est(0.65, 0.55) });
  const { state: clk, clock } = vclock(300_000);

  const s = new ModelScheduler({ llm, memory });
  ok(s.getSchedulingAudit() === undefined, '未挂载审计：导出 undefined（零漂移）');
  s.attachSchedulingAudit({ maxEntries: 4, clock });

  s.assignModel('test', 'model-b'); // preferred 路径
  clk.now += 1;
  s.assignModel('test'); // scored 路径
  clk.now += 1;
  s.assignModel('test'); // scored 路径
  clk.now += 1;
  s.attachParetoFront();
  s.bindCostProfile('test', 'quality');
  s.assignModel('test'); // profile-pareto 路径
  clk.now += 1;
  s.assignModel('test'); // profile-pareto 路径（第 5 条 → 环形淘汰第 1 条）

  let audit = s.getSchedulingAudit() ?? [];
  ok(audit.length === 4, `环形有界：5 次决策容量 4 → 留最近 4 条（内存不随决策数增长）`);
  ok(audit.every((e, i) => i === 0 || e.seq === audit[i - 1].seq + 1), `seq 单调连续（${audit[0].seq} → ${audit[audit.length - 1].seq}）`);
  ok(audit[0].path === 'scored' && audit[audit.length - 1].path === 'profile-pareto', '路径归因：preferred 条目被淘汰后首条 scored、末条 profile-pareto');
  ok(audit[audit.length - 1].profile === 'quality' && audit[audit.length - 1].chosenId === 'model-a', `画像与结论在案（profile=quality → model-a，rationale 含前沿口径）`);
  ok(audit.every((e) => Array.isArray(e.candidateIds) && e.candidateIds.length > 0), '每条记录携带实际候选集');

  // preferred 条目（重新小容量验证）
  {
    const s2 = new ModelScheduler({ llm, memory });
    s2.attachSchedulingAudit({ maxEntries: 8, clock });
    s2.assignModel('test', 'model-b');
    const a2 = s2.getSchedulingAudit() ?? [];
    ok(a2.length === 1 && a2[0].path === 'preferred' && a2[0].preferred === 'model-b' && a2[0].chosenId === 'model-b' && a2[0].candidateIds.length === 1, 'preferred 短路同样落账（path=preferred、候选集=[model-b]）');
  }

  // 健康快照 + 被过滤候选的收缩
  {
    const { state: clk2, clock: clock2 } = vclock(400_000);
    const s3 = new ModelScheduler({ llm, memory });
    s3.attachHealthRouting({ failureThreshold: 3, errorThreshold: 0.999, clock: clock2 });
    s3.attachSchedulingAudit({ maxEntries: 8, clock: clock2 });
    for (let i = 0; i < 3; i += 1) s3.reportModelHealth('model-b', { failed: true });
    s3.assignModel('test');
    const a3 = s3.getSchedulingAudit() ?? [];
    ok(a3[a3.length - 1].health?.['model-b'] === 'open' && a3[a3.length - 1].health?.['model-a'] === undefined, `健康快照入账：model-b:open（model-a 无遥测诚实缺席）`);
    ok(JSON.stringify(a3[a3.length - 1].candidateIds) === JSON.stringify(['model-a']), `候选集反映过滤后实际口径（model-b 熔断被剔除 → ['model-a']）`);
  }

  // 纯旁路：有审计与无审计决策逐位相同
  {
    const sA = new ModelScheduler({ llm, memory });
    const sB = new ModelScheduler({ llm, memory });
    sB.attachSchedulingAudit({ maxEntries: 16, clock });
    let same = true;
    for (let i = 0; i < 8; i += 1) {
      if (sA.assignModel('test') !== sB.assignModel('test')) same = false;
    }
    ok(same && (sB.getSchedulingAudit() ?? []).length === 8, '旁路性：审计挂载不改变任何决策（8/8 逐位相同，8 条落账）');
  }
}

// ═══════════════════ ⑥ 组合场景：健康 × 预算 × P2C × 审计同挂 ═══════════════════

section('⑥ 组合场景：最优重试超限 → 次优熔断 → 三号接盘，全链降级可观测');

{
  const llm = makeLlm([
    { id: 'model-a', taskScores: { test: 0.95 } },
    { id: 'model-b', taskScores: { test: 0.85 } },
    { id: 'model-c', taskScores: { test: 0.7 } },
  ]);
  const memory = stubMemory({ 'model-a': est(0.7, 0.6), 'model-b': est(0.68, 0.55), 'model-c': est(0.6, 0.5) });
  const { state: clk, clock } = vclock(500_000);
  const s = new ModelScheduler({ llm, memory });
  s.attachHealthRouting({ failureThreshold: 3, errorThreshold: 0.999, halfOpenAfterMs: 5_000, clock });
  s.attachRetryBudget({ windowMs: 60_000, maxRetriesPerModel: 2, clock });
  s.attachP2C({ loadOf: () => 0, random: mulberry32(3), scoreGate: 0.9 });
  s.attachSchedulingAudit({ maxEntries: 16, clock });

  const firstPick = s.assignModel('test');
  ok(firstPick === 'model-a' || firstPick === 'model-b', `初始：三面挂载下首派 ${firstPick}（P2C 质量门 0.9 内 a/b 两候取轻——确定性属于 [a,b]）`);
  s.admitRetry('model-a');
  s.admitRetry('model-a');
  ok(s.assignModel('test') === 'model-b', '第 1 级降级：model-a 重试配额耗尽 → model-b');
  for (let i = 0; i < 3; i += 1) s.reportModelHealth('model-b', { failed: true, latencyMs: 50 });
  ok(s.assignModel('test') === 'model-c', '第 2 级降级：model-b 熔断 open → model-c（健康 × 预算双闸门叠加）');
  const audit = s.getSchedulingAudit() ?? [];
  const last = audit[audit.length - 1];
  ok(JSON.stringify(last.candidateIds) === JSON.stringify(['model-c']), `审计候选集同步收缩至 ['model-c']（两级降级全链可观测）`);
  ok(last.health?.['model-b'] === 'open' && last.retryUsed?.['model-a'] === 2, `审计因子齐备：健康快照 model-b:open、重试用度 model-a:2/2`);
  ok(last.path === 'scored' && last.rationale.length > 0, `决策路径与依据在案（path=${last.path}）`);
  ok(s.admitRetry('model-a').allowed === false, '组合面下 admitRetry 语义独立无损（model-a 仍超限拒纳）');
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— ModelScheduler 第三轮 A3 五项升级新旧行为对照验证成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
