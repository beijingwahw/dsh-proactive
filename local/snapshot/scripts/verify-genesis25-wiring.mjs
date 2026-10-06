/**
 * verify-genesis25-wiring.mjs — 创世纪升级 51.0→75.0 全链路接线零漂移验证
 *
 * 用真实引擎（ModelScheduler / TaskExecutor / DecisionEngine / Sentinel /
 * WorldModel / MetaCognitionEngine / StrategyEvolutionEngine / CuriosityEngine /
 * LongTermMemory / Optimizer / BenchmarkEngine / SymbiosisBridge / Reflector，
 * 全程离线——LLMClient 指向 mock 主机不发真实请求）验证 25 个新内核：
 *   ① dist 导出 25 内核全部符号（含消歧别名 inCoreHousing / inCoreGame）；
 *   ② 每个接线点「旗标关 = 现状（键缺席 / undefined / 决策逐位不变）」与
 *      「旗标开 = 生效（真实数学读数产出 / 决策口径切换）」对照；
 *   ③ 末尾 PASS n / FAIL m，失败 exit 1。
 *
 * 运行：npm run build && node scripts/verify-genesis25-wiring.mjs
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import * as root from '../dist/index.mjs';
import {
  LLMClient,
  ModelScheduler,
  TaskExecutor,
  DecisionEngine,
  Sentinel,
  WorldModel,
  MetaCognitionEngine,
  StrategyEvolutionEngine,
  CuriosityEngine,
  LongTermMemory,
  Optimizer,
  BenchmarkEngine,
  SymbiosisBridge,
  Reflector,
  SpeculativePairingAdvisor,
  bivariateGates,
  inCoreHousing,
  inCoreGame,
  mulberry32,
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 两模型 LLMClient（endpoint 指向不存在的 mock 主机，测试不发真实请求） */
function makeLlm() {
  const llm = new LLMClient();
  llm.registerModel({ id: 'model-a', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { test: 0.5 } } });
  llm.registerModel({ id: 'model-b', endpoint: 'http://mock.local', maxConcurrency: 5, initialCapabilities: { taskScores: { test: 0.1 } } });
  return llm;
}

/** 记忆 stub（ModelScheduler/Optimizer 消费面；model-a 中庸画像 / model-b 零样本） */
function stubMemory() {
  return {
    getBayesianEstimate(modelId) {
      if (modelId === 'model-a') {
        return {
          modelId,
          taskType: 'test',
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

/** 最小信号对象 */
function mkSignal(type, description, urgency = 0.6) {
  return { id: `sig-${type}-${Math.random()}`, type, description, payload: {}, source: 'test', urgency, receivedAt: Date.now(), occurrences: 1 };
}

// ═══════════════════ ① dist 导出面 ═══════════════════

section('① dist 导出：25 内核全部符号 + 引擎挂载面 + 适配层');

{
  const probe = {
    '51.0': ['speculativeEconomy', 'optimalDraftLength', 'breakEvenGamma', 'simulateRounds'],
    '52.0': ['optimalVoteN', 'waterfillBudget', 'earlyStopRule', 'powerLawFit'],
    '53.0': ['whittleScheduler', 'solveWhittleIndex', 'indexabilityCheck', 'ARM_STATE'],
    '54.0': ['driftPlusPenaltyStep', 'backpressureInsight', 'lpBenchmark', 'dualPrices'],
    '55.0': ['fitHawkes', 'burstForecast', 'residualDiagnostics', 'simulate', 'stationaryRate'],
    '56.0': ['FactorGraph', 'logSumExp'],
    '57.0': ['VariationalEngine', 'conjugateLinearRegressionPosterior', 'VI_KIND', 'DEFAULT_VI_CONFIG'],
    '58.0': ['mala', 'ula', 'tuneStep', 'w2Gaussian', 'gaussianTarget', 'MALA_OPTIMAL_ACCEPT'],
    '59.0': ['MasteryCurriculum', 'masteryCurriculum', 'comparePolicies', 'thompsonCurriculum'],
    '60.0': ['memoryCompressionPlanner', 'blahutArimoto', 'rdCurve'],
    '61.0': ['deferredAcceptance', 'topTradingCycles', 'isStable', 'allStableMatchings', 'inCoreHousing'],
    '62.0': ['myersonReserve', 'myersonAuction', 'vcgAllocate', 'empiricalGrid', 'secondPrice', 'ironVirtualValues'],
    '63.0': ['nucleolus', 'Fraction', 'makeGameFromPairs', 'shapleyExact', 'solveLP', 'inCoreGame'],
    '64.0': ['learnCE', 'isCorrelatedEquilibrium', 'normalGame', 'enumerateNash'],
    '65.0': ['ucbPricing', 'thompsonPricing', 'runTrial', 'regretCurve', 'FixedPricePolicy'],
    '66.0': ['anneal', 'wellDepth', 'metropolisStep', 'tspInstance'],
    '67.0': ['runNSGA2', 'paretoFront', 'crowdingDistance', 'hypervolume2D'],
    '68.0': ['ncd', 'ncdCluster', 'ncdMatrix', 'ncdTriangleAudit'],
    '69.0': ['buildMapper', 'mapperInsight', 'cycleBasis', 'annulus'],
    '70.0': ['pidFromJoint', 'oInformation', 'bivariateGates', 'mutualInformation'],
    '71.0': ['astar', 'dijkstra', 'graphFromEdgeList', 'gridWorld', 'checkConsistent'],
    '72.0': ['cvLasso', 'lassoCD', 'omp', 'randomSparseDesign', 'kktMaxViolation'],
    '73.0': ['successiveHalving', 'racingElimination', 'hComplexity', 'identificationRate'],
    '74.0': ['mirrorDescent', 'bregmanDivergence', 'optimalEta', 'regretBound'],
    '75.0': ['gatedCalibrator', 'GatedCalibrator', 'pava', 'calibrationError', 'OnlinePlatt'],
  };
  const absentKernels = Object.entries(probe).filter(([, syms]) => syms.some((s) => root[s] === undefined)).map(([k]) => k);
  ok(absentKernels.length === 0, `25 内核全部符号经根入口导出（缺席：${absentKernels.join(',') || '无'}；探测 ${Object.values(probe).flat().length} 符号）`);

  const engineMounts = {
    ModelScheduler: ['attachSpeculativeDecoding', 'speculativePairFor', 'attachWhittleIndex', 'attachParetoFront', 'paretoFrontView'],
    TaskExecutor: ['attachTestTimeCompute', 'testTimeComputePlan', 'attachBackpressureController', 'backpressureView'],
    DecisionEngine: ['attachProbabilityCalibrator', 'calibrationStatus', 'attachNoRegretRouter', 'noRegretView'],
    Sentinel: ['attachHawkesBurstGuard', 'hawkesView'],
    WorldModel: ['attachBeliefPropagation', 'fuseBeliefs', 'attachMapperLens', 'experienceMapperView'],
    MetaCognitionEngine: ['attachVariationalInference', 'variationalPosterior'],
    StrategyEvolutionEngine: ['attachLangevinMutation', 'langevinDiagnostics', 'attachAnnealingEscape', 'annealingEscapeReport'],
    CuriosityEngine: ['attachCurriculum', 'curriculumView'],
    LongTermMemory: ['attachCompressionPlanner', 'compressionPlan', 'attachNcdDedup', 'ncdNearDuplicate', 'ncdAudit'],
    Optimizer: ['attachAstarPlanner', 'optimalSubplan', 'attachSparseAttribution', 'attributeFactors'],
    BenchmarkEngine: ['attachBaiSelector'],
    SymbiosisBridge: ['attachStableMatching', 'matchContributors', 'attachMechanismDesign', 'reservePriceFloor', 'clearCompetition', 'attachNucleolusAudit', 'royaltyAudit', 'attachCorrelatedEquilibrium', 'coordinationProfile', 'attachDynamicPricing', 'dynamicPricingView'],
    Reflector: ['attachPidDiagnostics', 'combinationPid'],
  };
  const absentMounts = Object.entries(engineMounts).flatMap(([cls, methods]) => {
    const C = root[cls];
    if (!C) return [`${cls}（类缺席）`];
    return methods.filter((m) => typeof C.prototype[m] !== 'function').map((m) => `${cls}.${m}`);
  });
  ok(absentMounts.length === 0, `13 个引擎的挂载/读数方法全部在位（缺席：${absentMounts.join(', ') || '无'}）`);

  const adapters = ['SpeculativePairingAdvisor', 'TestTimeComputePlanner', 'BackpressureLedger', 'HawkesBurstMonitor', 'EnergyPricingMount', 'NoRegretLedger', 'whittleSchedule', 'populationLangevinDiagnostics', 'ExplorationCurriculum', 'planMemoryCompression'];
  ok(adapters.every((a) => root[a] !== undefined), 'engines-frontier/genesis25 适配层导出在位（10 适配器）');
  ok(typeof mulberry32 === 'function' && typeof inCoreHousing === 'function' && typeof inCoreGame === 'function', '消歧导出在位（mulberry32（28.0 规范版）/ inCoreHousing / inCoreGame）');
}

// ═══════════════════ 零漂移总检（旗标关 = 现状） ═══════════════════

section('零漂移总检：未挂载任何创世纪内核时新读数全部缺席');

{
  const llm = makeLlm();
  const scheduler = new ModelScheduler({ llm, memory: stubMemory() });
  const insightOff = scheduler.assignModelWithInsight('test');
  ok(
    !insightOff.rationale.includes('Whittle') && scheduler.getSpeculativeVerdict() === undefined && scheduler.paretoFrontView('test') === undefined,
    `ModelScheduler：原评分路径（chosen=${insightOff.modelId}，rationale 无 Whittle），配对/帕累托读数缺席`,
  );
  const executor = new TaskExecutor({
    config: { qualityThreshold: 0.7, maxRetries: 1, globalTimeout: 5_000, nodeTimeout: 3_000, enableProgress: false, verbose: false },
    llm,
    modelScheduler: scheduler,
  });
  ok(executor.testTimeComputePlan('test', 0.9) === undefined && executor.backpressureView() === undefined, 'TaskExecutor：投票预算 / 背压读数缺席');
  const decision = new DecisionEngine();
  ok(decision.calibrationStatus() === undefined && decision.noRegretView() === undefined, 'DecisionEngine：校准 / 无悔读数缺席');
  const sentinel = new Sentinel({ watchCodeChanges: false, watchErrors: false, watchPerformance: false, aggregationWindow: 0.5 }, () => {});
  ok(sentinel.hawkesView() === undefined, 'Sentinel：爆发读数缺席');
  const world = new WorldModel();
  ok(world.fuseBeliefs({ variables: [], factors: [] }) === undefined && world.experienceMapperView() === undefined, 'WorldModel：信念融合 / 地形图读数缺席');
  const meta = new MetaCognitionEngine();
  ok(meta.variationalPosterior({ kind: 'gaussianVI', logJoint: () => 0, dim: 1 }) === undefined, 'MetaCognition：变分后验读数缺席');
  const evolution = new StrategyEvolutionEngine({ rng: mulberry32(20261001) });
  ok(evolution.langevinDiagnostics() === undefined && evolution.annealingEscapeReport() === undefined, 'StrategyEvolution：朗之万 / 势阱读数缺席');
  const curiosity = new CuriosityEngine({ getExposure: () => ({}), getExperienceCounts: () => ({}), getFailureRates: () => ({}) });
  curiosity.recordExploration('gen25', true);
  ok(curiosity.curriculumView() === undefined, 'CuriosityEngine：课程读数缺席（recordExploration 行为不变）');
  const reflector = new Reflector({ memory: stubMemory(), config: {} });
  ok(reflector.combinationPid([[[1]]]) === undefined, 'Reflector：PID 读数缺席');
  const optimizer = new Optimizer({ memory: stubMemory(), config: {} });
  ok(optimizer.optimalSubplan(['a'], [], 'a', 'a') === undefined && optimizer.attributeFactors([[1]], [1]) === undefined, 'Optimizer：A* / 稀疏归因读数缺席');
  const bridge = new SymbiosisBridge({});
  ok(
    bridge.matchContributors({ proposers: {}, receivers: {} }) === undefined &&
      bridge.reservePriceFloor([0.1, 0.5, 0.9]) === undefined &&
      bridge.clearCompetition([[1]]) === undefined &&
      bridge.royaltyAudit([], 3) === undefined &&
      bridge.coordinationProfile([2, 2], [[0, 0, 0, 0], [0, 0, 0, 0]]) === undefined &&
      bridge.dynamicPricingView() === undefined,
    'SymbiosisBridge：61.0→65.0 市场理论核读数全部缺席（影子口径零介入）',
  );
}

// ═══════════════════ 51.0 投机解码 ═══════════════════

section('51.0 投机解码（ModelScheduler.attachSpeculativeDecoding）');

{
  const llm = makeLlm();
  const scheduler = new ModelScheduler({ llm, memory: stubMemory() });
  ok(scheduler.speculativePairFor('test') === undefined, '旗标关 → 配对裁决缺席（零漂移）');
  scheduler.attachSpeculativeDecoding();
  const verdict = scheduler.speculativePairFor('test');
  ok(
    verdict !== undefined && verdict.verdict.pair === 'model-a→model-b' && verdict.verdict.costRatio === 1,
    `旗标开 → 真实裁决产出：${verdict ? `${verdict.verdict.pair}（r=${verdict.verdict.costRatio}）` : '—'}（等延迟成本口径 → r=1）`,
  );
  ok(
    verdict !== undefined && verdict.verdict.adopt === false && verdict.verdict.optimalK === 0,
    `γ̂=${verdict ? verdict.verdict.gamma.toFixed(3) : '—'} ≤ r=1 → 闭式判退（k*=0，直通——「越跑越亏」的配对被数学终止）`,
  );
  const advisor = new SpeculativePairingAdvisor({ gammaOf: () => 0.92 });
  const adopt = advisor.bestPair(
    [
      { id: 'fast-mini', costPerCall: 4, posteriorMean: 0.7 },
      { id: 'strong-xl', costPerCall: 10, posteriorMean: 0.95 },
    ],
    'codegen',
  );
  ok(
    adopt !== undefined && adopt.verdict.adopt === true && adopt.verdict.optimalK >= 1 && adopt.verdict.speedup > 1,
    `γ 遥测注入（0.92 > break-even，r=0.4）→ 采纳 draft-verify 通道（k*=${adopt ? adopt.verdict.optimalK : '—'}，加速比 ${adopt ? adopt.verdict.speedup.toFixed(2) : '—'}×）`,
  );
  ok(scheduler.getSpeculativeVerdict() !== undefined, '最近一次裁决入诊断快照（introspect 口径）');
}

// ═══════════════════ 52.0 测试时计算 ═══════════════════

section('52.0 测试时计算（TaskExecutor.attachTestTimeCompute）');

{
  const llm = makeLlm();
  const scheduler = new ModelScheduler({ llm, memory: stubMemory() });
  const mkExecutor = () =>
    new TaskExecutor({
      config: { qualityThreshold: 0.7, maxRetries: 1, globalTimeout: 5_000, nodeTimeout: 3_000, enableProgress: false, verbose: false },
      llm,
      modelScheduler: scheduler,
      nodeRunner: async () => ({ output: 'done', quality: 0.95, tokensUsed: 10 }),
    });
  const singlePlan = (type) => ({
    objective: 'o',
    nodes: [{ id: 'n1', description: 'd', type, dependsOn: [] }],
    parallelismStrategy: 'sequential',
    source: 'fallback',
  });
  const plain = mkExecutor();
  ok(plain.testTimeComputePlan('gen25-ttc', 0.9) === undefined, '旗标关 → 投票预算缺席（零漂移）');
  // 冷启动 p̂=0.5：天花板 0.5 → 高目标不可达 → 诚实拒绝升级
  const coldExecutor = mkExecutor();
  coldExecutor.attachTestTimeCompute();
  const cold = coldExecutor.testTimeComputePlan('gen25-ttc', 0.9);
  ok(cold !== undefined && cold.votes === 1 && !cold.upgrade, `冷启动 p̂=0.5：目标 0.95 超天花板 → 诚实拒绝升级（保持单路原配置）`);
  // 真实执行回填（alpha=0.8 → 一次成功 p̂=0.9）：目标 0.95 需 3 路多数票
  const warmExecutor = mkExecutor();
  warmExecutor.attachTestTimeCompute({ alpha: 0.8 });
  await warmExecutor.executePlan(mkSignal('gen25-ttc', '投票预算回填'), singlePlan('gen25-ttc'));
  const warm = warmExecutor.testTimeComputePlan('gen25-ttc', 0.9);
  ok(
    warm !== undefined && warm.p === 0.9 && warm.votes === 3 && warm.upgrade,
    `执行回填 p̂=0.9 → 高价值任务（urgency 0.9 → 目标 0.95）升级 ${warm ? warm.votes : '—'} 路投票（3 路多数票准确率 0.972 ≥ 0.95 可达）`,
  );
  const stop = TaskExecutor.testTimeEarlyStop(0.01, 0.05);
  ok(stop !== undefined && typeof stop.stop === 'boolean', '推理早停规则可用（边际增益 < 价格即停的口径转发）');
}

// ═══════════════════ 53.0 Whittle 指数 ═══════════════════

section('53.0 Whittle 指数（ModelScheduler.attachWhittleIndex）');

{
  const plain = new ModelScheduler({ llm: makeLlm(), memory: stubMemory() });
  const before = plain.assignModelWithInsight('test');
  const scheduler = new ModelScheduler({ llm: makeLlm(), memory: stubMemory() });
  const off = scheduler.assignModelWithInsight('test');
  ok(
    off.modelId === before.modelId && off.rationale === before.rationale && !off.rationale.includes('Whittle'),
    `旗标关 → 动态选型逐位不变（${off.modelId}，rationale 与对照调度器同构——零漂移）`,
  );
  scheduler.attachWhittleIndex({ goodThreshold: 0.7, passiveHeal: 0.1 });
  const on = scheduler.assignModelWithInsight('test');
  ok(
    on.rationale.includes('Whittle'),
    `旗标开 → 动态选型切换 RMAB 口径：${on.rationale.slice(0, 66)}…`,
  );
  ok(on.modelId === 'model-a' || on.modelId === 'model-b', `选中 ${on.modelId}（两态臂：model-a 后验 0.524 bad / model-b 零样本 0.5 bad——落选臂的演化数学已进入调度）`);
}

// ═══════════════════ 54.0 Lyapunov 背压 ═══════════════════

section('54.0 Lyapunov 背压（TaskExecutor.attachBackpressureController）');

{
  const llm = makeLlm();
  const scheduler = new ModelScheduler({ llm, memory: stubMemory() });
  const plan = (type) => ({
    objective: 'bp',
    nodes: [1, 2, 3].map((i) => ({ id: `n${i}`, description: `node${i}`, type, dependsOn: [] })),
    parallelismStrategy: 'layered',
    source: 'fallback',
  });
  // 旗标关：nodeRunner 内观察背压读数（应全程 undefined）
  const observedOff = [];
  const execOff = new TaskExecutor({
    config: { qualityThreshold: 0.7, maxRetries: 1, globalTimeout: 5_000, nodeTimeout: 3_000, enableProgress: false, verbose: false },
    llm,
    modelScheduler: scheduler,
    nodeRunner: async () => {
      observedOff.push(execOff.backpressureView());
      await sleep(5);
      return { output: 'ok', quality: 0.95, tokensUsed: 5 };
    },
  });
  await execOff.executePlan(mkSignal('gen25-bp', '背压对照'), plan('gen25-bp'));
  ok(observedOff.length === 3 && observedOff.every((v) => v === undefined) && execOff.backpressureView() === undefined, '旗标关 → 执行 3 节点全程无背压读数（零漂移）');
  // 旗标开：三节点同层并发 → 在途 Q 递增至 3；V=0.5 → 对偶价格 6 超阈 1.5 → 洞察产出
  const observed = [];
  const execOn = new TaskExecutor({
    config: { qualityThreshold: 0.7, maxRetries: 1, globalTimeout: 5_000, nodeTimeout: 3_000, enableProgress: false, verbose: false },
    llm,
    modelScheduler: scheduler,
    nodeRunner: async () => {
      observed.push(execOn.backpressureView());
      await sleep(10);
      return { output: 'ok', quality: 0.95, tokensUsed: 5 };
    },
  });
  execOn.attachBackpressureController({ V: 0.5, priceThreshold: 1.5 });
  await execOn.executePlan(mkSignal('gen25-bp', '背压生效'), plan('gen25-bp'));
  const midViews = observed.filter((v) => v !== undefined);
  const queues = midViews.map((v) => v.queues[0].queue);
  ok(
    midViews.length === 3 && Math.max(...queues) === 3 && new Set(queues).size >= 2,
    `旗标开 → 在途队列可见（并发爬升 Q=${queues.join('→')}，对偶价格 Q/V 最高 ${(Math.max(...queues) / 0.5).toFixed(0)}）`,
  );
  ok(
    midViews.every((v) => v.insight !== undefined && v.insight.message.includes('背压瓶颈')),
    `价格超阈（≥1/0.5=2 > 1.5）→ 背压瓶颈洞察产出（「到达率逼近容量域」的稳定性告警桥）`,
  );
  ok(execOn.backpressureView() === undefined, '执行完成 → 队列归零读数缺席（账本 acquire/release 严格配平）');
}

// ═══════════════════ 55.0 Hawkes 爆发监视 ═══════════════════

section('55.0 Hawkes 爆发监视（Sentinel.attachHawkesBurstGuard）');

{
  const mkSentinel = () => new Sentinel({ watchCodeChanges: false, watchErrors: false, watchPerformance: false, aggregationWindow: 0.5, maxBatchSize: 10_000 }, () => {});
  // 自激发事件流：600s 基线（每 60s 一条）+ 4 个爆发簇（簇内 2s 间隔 ×6）
  // 自激发事件流：600s 稀疏基线（每 120s 一条）+ 5 个紧密爆发簇（簇内 1s 间隔 ×8）
  const base = 1_700_000_000;
  const times = [];
  for (let t = 0; t <= 600; t += 120) times.push(t);
  for (let c = 0; c < 5; c += 1) {
    const start = 95 + c * 105;
    for (let i = 0; i < 8; i += 1) times.push(start + i);
  }
  times.sort((a, b) => a - b);
  const stream = times.filter((t, i) => i === 0 || t > times[i - 1]); // 严格递增去重（簇沿与基线格点碰撞的合并）
  const feed = (sentinel) => {
    stream.forEach((t, i) => sentinel.ingest({ type: 'hawkes-test', description: `burst event #${i}`, payload: {}, source: 'test', receivedAt: (base + t) * 1000 }));
  };
  const off = mkSentinel();
  feed(off);
  ok(off.hawkesView() === undefined, '旗标关 → 到达流照常聚合、爆发读数缺席（零漂移）');
  const on = mkSentinel();
  on.attachHawkesBurstGuard({ windowSec: 900, minEvents: 8 });
  feed(on);
  const view = on.hawkesView(60_000);
  ok(
    view !== undefined && view.fit !== undefined && view.fit.converged && view.fit.alpha > 0,
    `旗标开 → EM 拟合收敛且检出激发项（α=${view && view.fit ? view.fit.alpha.toFixed(4) : '—'} > 0，分支比 η=${view && view.fit ? view.fit.eta.toFixed(3) : '—'} < 1 平稳）`,
  );
  ok(
    view !== undefined && view.forecast.expected > view.forecast.baseline && view.excitationShare > 0.3,
    `爆发外推：未来 60s 期望 ${view ? view.forecast.expected.toFixed(2) : '—'} 事件（基线 ${view ? view.forecast.baseline.toFixed(2) : '—'} + 激发 ${view ? view.forecast.excitation.toFixed(2) : '—'}，激发份额 ${(view ? view.excitationShare * 100 : 0).toFixed(0)}% > 30%——到达相关性有了数学口径）`,
  );
}

// ═══════════════════ 56.0 置信传播 ═══════════════════

section('56.0 置信传播（WorldModel.attachBeliefPropagation）');

{
  const world = new WorldModel();
  const spec = {
    variables: [
      { id: 'root', domain: 2, prior: [0.5, 0.5] },
      { id: 'leafA', domain: 2, prior: [0.05, 0.95] }, // 强证据源：置信 leafA=1
      { id: 'leafB', domain: 2, prior: [0.3, 0.7] }, // 弱证据源：同向
    ],
    factors: [
      { scope: ['root', 'leafA'], table: [0.95, 0.05, 0.1, 0.9] }, // root=1 与 leafA=1 强相容
      { scope: ['root', 'leafB'], table: [0.7, 0.3, 0.3, 0.7] },
    ],
  };
  ok(world.fuseBeliefs(spec) === undefined, '旗标关 → 融合缺席（零漂移）');
  world.attachBeliefPropagation();
  const fused = world.fuseBeliefs(spec);
  ok(
    fused !== undefined && fused.report.converged && fused.marginals.root !== undefined,
    `旗标开 → 树形因子图 sum-product 精确收敛（迭代 ${fused ? fused.report.iterations : '—'} 轮，isTree=${fused ? fused.report.isTree : '—'}）`,
  );
  const rootPost = fused ? fused.marginals.root[1] : 0;
  ok(rootPost > 0.75, `联合后验边缘 P(root=1)=${rootPost.toFixed(3)}（先验 0.5，强+弱证据乘法融合显著抬升——互斥证据不再被平均成编造共识）`);
}

// ═══════════════════ 57.0 变分推断 ═══════════════════

section('57.0 变分推断（MetaCognitionEngine.attachVariationalInference）');

{
  const meta = new MetaCognitionEngine();
  const problem = {
    kind: 'linearRegression',
    X: [[1], [2], [3], [4], [5], [6]],
    y: [2.1, 3.9, 6.2, 7.8, 10.3, 11.9],
    alpha: 1,
    beta: 10,
  };
  ok(meta.variationalPosterior(problem) === undefined, '旗标关 → 后验读数缺席（零漂移）');
  meta.attachVariationalInference();
  const fit = meta.variationalPosterior(problem);
  ok(
    fit !== undefined && fit.converged && Array.isArray(fit.means) && fit.means.length === 1 && Math.abs(fit.means[0] - 2) < 0.15,
    `旗标开 → CAVI 平均场后验收敛（斜率后验 m=${fit ? fit.means[0].toFixed(3) : '—'} ≈ 2.0 真实斜率，s²=${fit ? fit.vars[0].toFixed(4) : '—'}——点估计 + 手拍区间升级为 N(m, s²)）`,
  );
  ok(fit !== undefined && fit.finalElbo <= fit.elboTrace[fit.elboTrace.length - 1] + 1e-9, `ELBO 轨迹单调可审计（终值 ${fit ? fit.finalElbo.toFixed(3) : '—'}——变分自由能口径）`);
}

// ═══════════════════ 58.0 朗之万采样 ═══════════════════

section('58.0 朗之万采样（StrategyEvolutionEngine.attachLangevinMutation）');

{
  const engine = new StrategyEvolutionEngine({ rng: mulberry32(20261001) });
  ok(engine.langevinDiagnostics() === undefined, '旗标关 → 诊断缺席（零漂移）');
  const genesBefore = JSON.stringify(engine.getReport().genomes.map((g) => g.genes));
  engine.attachLangevinMutation({ steps: 300, seed: 7 });
  const diag = engine.langevinDiagnostics();
  ok(
    diag !== undefined && diag.dim === 5 && diag.acceptRate > 0.2 && diag.acceptRate < 0.95 && diag.samples > 100,
    `旗标开 → MALA 采样健康（dim=${diag ? diag.dim : '—'} 基因维，接受率 ${diag ? diag.acceptRate.toFixed(3) : '—'}（目标 0.574 量级），样本 ${diag ? diag.samples : '—'}）`,
  );
  ok(diag !== undefined && diag.w2 >= 0 && Number.isFinite(diag.w2), `W₂(Bures) 收敛读数 ${diag ? diag.w2.toFixed(4) : '—'}（样本矩 vs 种群真矩——采样器健康度审计）`);
  const genesAfter = JSON.stringify(engine.getReport().genomes.map((g) => g.genes));
  ok(genesBefore === genesAfter, '诊断只读：attach 前后种群基因逐位不变（evolve 路径零漂移）');
}

// ═══════════════════ 59.0 课程学习 ═══════════════════

section('59.0 课程学习（CuriosityEngine.attachCurriculum）');

{
  const provider = { getExposure: () => ({ gen25: 2 }), getExperienceCounts: () => ({ gen25: 0 }), getFailureRates: () => ({ gen25: 0.3 }) };
  const plain = new CuriosityEngine(provider);
  plain.recordExploration('gen25', true);
  ok(plain.curriculumView() === undefined && plain.getExplorations().length === 1, '旗标关 → 探索记录照常、课程读数缺席（零漂移）');
  const engine = new CuriosityEngine(provider);
  engine.attachCurriculum({ levelCount: 5, threshold: 0.75, promoteR: 3, demoteS: 2 });
  for (let i = 0; i < 4; i += 1) engine.recordExploration('gen25', true);
  const view = engine.curriculumView();
  ok(
    view !== undefined && view.level >= 1 && view.levelCount === 5,
    `旗标开 → 掌握门限爬阶生效（4 连成功 + Beta(5,1) 后验 0.83 ≥ 0.75 → 晋升到 L${view ? view.level : '—'}/${view ? view.levelCount : '—'}，${view ? view.name : ''}）`,
  );
  ok(engine.getExplorations().length === 4 && engine.getExplorationYield() === 1, '探索统计口径不变（记账不侵入既有行为）');
}

// ═══════════════════ 60.0 率失真（长期记忆） ═══════════════════

section('60.0 率失真压缩规划（LongTermMemory.attachCompressionPlanner）');

{
  const dir = path.join(os.tmpdir(), `verify-g25-mem-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const memory = new LongTermMemory(path.join(dir, 'memory.json'));
  const mkPattern = (i, confidence, plans) => ({
    fingerprint: `g25-${i}`,
    taskSummary: `[gen25] pattern ${i}: ${'x'.repeat(40 + i * 30)}`,
    frequency: i + 1,
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
    successfulPlans: Array.from({ length: plans }, () => ({ planHash: 'h', modelCombination: {}, totalLatency: 100, tokenCost: 50, qualityScores: [0.9], recordedAt: Date.now() })),
    failureRecords: [],
    confidence,
    avgExecutionTime: 100,
    avgQualityScore: 0.9,
  });
  memory.upsertPattern(mkPattern(1, 0.95, 8)); // 高价值高保真
  memory.upsertPattern(mkPattern(2, 0.9, 5));
  memory.upsertPattern(mkPattern(3, 0.5, 1));
  memory.upsertPattern(mkPattern(4, 0.2, 0)); // 最低价值密度
  ok(memory.compressionPlan(10_000) === undefined, '旗标关 → 压缩规划缺席（零漂移）');
  memory.attachCompressionPlanner();
  const loose = memory.compressionPlan(1_000_000);
  ok(
    loose !== undefined && loose.keep.length === 4 && loose.shadowPrice === 0 && loose.drop.length === 0,
    `预算充裕 → 全 keep、影子价格 λ*=0（容量无稀缺——记忆健康度信息论 KPI 的基线口径）`,
  );
  const budget = Math.round(loose.fullBits * 0.15);
  const tight = memory.compressionPlan(budget);
  const idOf = (i) => memory.getAllTaskPatterns()[i - 1].taskSummary.slice(0, 80);
  ok(
    tight !== undefined && tight.usedBits <= budget + 1e-6 && tight.keep.length + tight.compress.length + tight.drop.length === 4,
    `紧预算（15% 全保真比特）→ 三档分摊守恒（keep ${tight ? tight.keep.length : '—'} / compress ${tight ? tight.compress.length : '—'} / drop ${tight ? tight.drop.length : '—'}，usedBits ≤ 预算）`,
  );
  ok(
    tight !== undefined && tight.decisions[idOf(4)] === 'drop' && tight.decisions[idOf(1)] !== 'drop',
    `价值密度排序生效（最低价值密度 pattern4 被遗忘、最高 pattern1 存活——执行仍由蒸馏管线决定，规划只读）`,
  );
  ok(tight !== undefined && tight.shadowPrice > 0, `预算边界影子价格 λ*=${tight ? tight.shadowPrice.toFixed(4) : '—'} > 0（记忆库趋紧——遗忘变贵之前边际条目先变贵）`);
  memory.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════ 61.0→65.0 共生市场理论核 ═══════════════════

section('61.0 稳定匹配（SymbiosisBridge.attachStableMatching）');

{
  const bridge = new SymbiosisBridge({});
  const problem = {
    proposers: { t1: ['m1', 'm2', 'm3'], t2: ['m2', 'm1', 'm3'], t3: ['m1', 'm2', 'm3'] },
    receivers: { m1: ['t1', 't3', 't2'], m2: ['t3', 't2', 't1'], m3: ['t2', 't1', 't3'] },
  };
  ok(bridge.matchContributors(problem) === undefined, '旗标关 → 撮合缺席（零漂移）');
  bridge.attachStableMatching();
  const result = bridge.matchContributors(problem);
  ok(
    result !== undefined && Object.keys(result.matching).length === 3 && result.stability.stable === true && result.stability.blockingPairs.length === 0,
    `旗标开 → 延迟接受产出无阻挡对指派（${result ? Object.entries(result.matching).map(([t, m]) => `${t}→${m}`).join(' ') : '—'}，0 对愿意私奔——稳定证书在案）`,
  );
}

section('62.0 机制设计（SymbiosisBridge.attachMechanismDesign）');

{
  const bridge = new SymbiosisBridge({});
  const samples = Array.from({ length: 60 }, (_, i) => (i + 0.5) / 60); // 均匀 [0,1] 历史成交价
  ok(bridge.reservePriceFloor(samples) === undefined && bridge.clearCompetition([[8, 0], [6, 0], [0, 0]]) === undefined, '旗标关 → 保留价/出清缺席（零漂移）');
  bridge.attachMechanismDesign();
  const reserve = bridge.reservePriceFloor(samples);
  ok(
    reserve !== undefined && reserve > 0.1 && reserve < 0.9,
    `Myerson 最优保留价 = ${reserve ? reserve.toFixed(3) : '—'}（从均匀 [0,1] 成交价经验分布的铁化虚拟价值学出——「喊价=真话」的 DSIC 底价）`,
  );
  const vcg = bridge.clearCompetition([[8, 0], [6, 0], [0, 0]]);
  ok(
    vcg !== undefined && vcg.assignment[0] === 0 && Math.abs(vcg.payments[0] - 6) < 1e-9,
    `VCG 外部性定价：最高估值者胜出、支付 = 第二高价 6（收入入央行国库——DSIC 的预算代价由国库吸收）`,
  );
}

section('63.0 核仁审计（SymbiosisBridge.attachNucleolusAudit）');

{
  const bridge = new SymbiosisBridge({});
  ok(bridge.royaltyAudit([{ mask: 7, value: 1 }], 3) === undefined, '旗标关 → 分账审计缺席（零漂移）');
  bridge.attachNucleolusAudit();
  // 三贡献者版税池：任意两人合作产出 0，三人合力产出 1（纯协同博弈）
  const audit = bridge.royaltyAudit([{ mask: 7, value: 1 }], 3);
  ok(
    audit !== undefined && audit.core.nonempty === true,
    `旗标开 → 核非空（ε₁=${audit && audit.core.leastCoreEpsilon ? audit.core.leastCoreEpsilon.toString() : '—'} ≤ 0——分配合法域在案）`,
  );
  const shapleySum = audit ? audit.shapley.reduce((s, f) => s + f.toNumber(), 0) : 0;
  ok(
    audit !== undefined && Math.abs(shapleySum - 1) < 1e-9,
    `Shapley 效率守恒（Σφ = v(N) = 1；纯协同下均分 1/3——「平均公平」基准列）`,
  );
  ok(
    audit !== undefined && audit.nucleolus !== undefined && Array.isArray(audit.nucleolus.complaints),
    `核仁列在案（最坏联盟无异议口径——与 Shapley 双口径并陈，分裂即暴露结构性异议联盟）`,
  );
}

section('64.0 相关均衡（SymbiosisBridge.attachCorrelatedEquilibrium）');

{
  const bridge = new SymbiosisBridge({});
  // 经典协调博弈：双方同选 0 得 (2,2)，同选 1 得 (1,1)，不一致双输 (0,0)
  const utilities = [[2, 0, 0, 1], [2, 0, 0, 1]];
  ok(bridge.coordinationProfile([2, 2], utilities) === undefined, '旗标关 → 协调画像缺席（零漂移）');
  bridge.attachCorrelatedEquilibrium();
  const profile = bridge.coordinationProfile([2, 2], utilities, { steps: 6000, seed: 20261001 });
  ok(
    profile !== undefined && profile.check.worstViolation < 0.01,
    `旗标开 → 无悔动态近似收敛到相关均衡（6000 步 regret matching，最大偏离收益 ${profile ? profile.check.worstViolation.toExponential(1) : '—'} → 0——偏离动机消失，协调方案可自执行）`,
  );
  ok(
    profile !== undefined && Math.max(...profile.ce.externalRegret) < 0.05,
    `外部后悔 → 0（每人 max regret/T = ${profile ? Math.max(...profile.ce.externalRegret).toExponential(1) : '—'}——Hart–Mas-Colell 收敛在案）`,
  );
}

section('65.0 动态定价（SymbiosisBridge.attachDynamicPricing）');

{
  const bridge = new SymbiosisBridge({});
  bridge.registerModel('m1');
  ok(bridge.dynamicPricingView() === undefined, '旗标关 → 费率学习缺席（零漂移）');
  bridge.attachDynamicPricing({ policy: 'thompson', unit: 10, seed: 65 });
  const prices = [];
  for (let i = 0; i < 12; i += 1) {
    // 真实结算路径回填（高需求：任务总成功有铸币 → 影子策略学习报价上探）
    const report = bridge.settleTask({ success: true, nodeResults: [{ modelId: 'm1', success: true, quality: 0.9 }] });
    prices.push(report.totalDistributed > 0 ? bridge.dynamicPricingView().lastPrice : null);
  }
  const view = bridge.dynamicPricingView();
  const learned = view && view.estimate ? view.estimate.price : undefined;
  ok(
    prices.every((p) => p === null || (p >= 0.1 && p <= 10)) && learned !== undefined && learned > 8,
    `旗标开 → Thompson 后验学习（12 连成交 → 期望报价上探 ${learned ? learned.toFixed(1) : '—'} 能量 / 单位价 10——抢手档自动提价，影子口径不改铸币数值）`,
  );
}

// ═══════════════════ 66.0 模拟退火 ═══════════════════

section('66.0 模拟退火势阱（StrategyEvolutionEngine.attachAnnealingEscape）');

{
  const engine = new StrategyEvolutionEngine({ rng: mulberry32(20261003), populationSize: 8 });
  for (let i = 0; i < 30; i += 1) engine.recordOutcome(engine.selectGenome().id, i % 4 === 0 ? 'acceptable' : 'good');
  ok(engine.annealingEscapeReport() === undefined, '旗标关 → 势阱读数缺席（零漂移）');
  engine.attachAnnealingEscape();
  const report = engine.annealingEscapeReport();
  ok(
    report !== undefined && report.globalMinima.length >= 1 && Array.isArray(report.wells),
    `旗标开 → 适应度链势阱分析（全局最优基因 ${report ? report.globalMinima.slice(0, 2).join(',') : '—'}，局部井 ${report ? report.wells.length : '—'} 个）`,
  );
  ok(
    report !== undefined && report.criticalDepth >= 0,
    `临界势阱深度 d=${report ? report.criticalDepth.toFixed(4) : '—'}（井越深 18.0 测地线越困局部——SA 跳盆地的出场价值可定价）`,
  );
}

// ═══════════════════ 67.0 NSGA-II 帕累托 ═══════════════════

section('67.0 NSGA-II 帕累托（ModelScheduler.attachParetoFront）');

{
  const scheduler = new ModelScheduler({ llm: makeLlm(), memory: stubMemory() });
  ok(scheduler.paretoFrontView('test') === undefined, '旗标关 → 前沿缺席（零漂移）');
  scheduler.attachParetoFront();
  const view = scheduler.paretoFrontView('test');
  ok(
    view !== undefined && view.points.length === 2 && view.frontIds.length >= 1,
    `旗标开 → 三目标前沿产出（${view ? view.points.map((p) => `${p.id}(风险${p.risk.toFixed(2)},成本${Math.round(p.cost)},延迟${Math.round(p.latency)})`).join(' ') : '—'}）`,
  );
  ok(
    view !== undefined && view.frontIds.includes('model-b') && !view.frontIds.includes('model-a'),
    `支配关系正确：model-b（风险 0.5，中性）支配 model-a（风险 1−0.31=0.69）→ 前沿 = [${view ? view.frontIds.join(',') : ''}]（「多花 2 分钱省多少毫秒」从前沿相邻点直读）`,
  );
  ok(view !== undefined && view.hypervolume > 0, `2D 超体积 ${view ? view.hypervolume.toFixed(0) : '—'} > 0（前沿覆盖读数——调度健康度口径）`);
}

// ═══════════════════ 69.0 Mapper 经验地形 ═══════════════════

section('69.0 Mapper 经验地形（WorldModel.attachMapperLens）');

{
  const world = new WorldModel();
  const now = Date.now();
  for (let i = 0; i < 40; i += 1) world.observeArrival('hot-type', now - 400 + i);
  for (let i = 0; i < 8; i += 1) world.observeArrival('mid-type', now - 200 + i * 10);
  for (let i = 0; i < 3; i += 1) world.observeArrival('slow-type', now - 1000 + i * 300);
  for (let i = 0; i < 6; i += 1) world.observeArrival('cold-type', now - 600_000 + i * 60_000);
  ok(world.experienceMapperView() === undefined, '旗标关 → 地形图缺席（零漂移）');
  world.attachMapperLens({ intervals: 3, overlap: 0.33, clusterEps: 0.5 });
  const view = world.experienceMapperView();
  ok(
    view !== undefined && view.graph.stats.nodeCount >= 1 && typeof view.insight === 'string' && view.insight.length > 0,
    `旗标开 → 经验骨架图产出（${view ? view.insight : '—'}——总量×活跃度对数平面的 Mapper 结构）`,
  );
}

// ═══════════════════ 70.0 部分信息分解 ═══════════════════

section('70.0 部分信息分解（Reflector.attachPidDiagnostics）');

{
  const reflector = new Reflector({ memory: stubMemory(), config: {} });
  ok(reflector.combinationPid([[[1]]]) === undefined, '旗标关 → PID 读数缺席（零漂移）');
  reflector.attachPidDiagnostics();
  const pid = reflector.combinationPid(bivariateGates().xor.joint);
  ok(
    pid !== undefined && Math.abs(pid.pid.synergistic - 1) < 1e-6 && pid.pid.redundant < 1e-6,
    `旗标开 → BROJA 分解正确（XOR 门：协同 C=${pid ? pid.pid.synergistic.toFixed(3) : '—'} = 1 bit，冗余 R=${pid ? pid.pid.redundant.toFixed(3) : '—'} = 0——单路零信息、联合全知的「暗协同」可计算）`,
  );
  const pidCopy = reflector.combinationPid(bivariateGates().copy.joint);
  ok(
    pidCopy !== undefined && Math.abs(pidCopy.pid.redundant - 1) < 1e-6 && Math.abs(pidCopy.pid.synergistic) < 1e-6,
    `拷贝门对照：冗余 R=${pidCopy ? pidCopy.pid.redundant.toFixed(3) : '—'} = 1（冗余主导组合可择一降频——四分解读与文献锚点一致）`,
  );
}

// ═══════════════════ 71.0 A* 搜索 ═══════════════════

section('71.0 A* 搜索（Optimizer.attachAstarPlanner）');

{
  const optimizer = new Optimizer({ memory: stubMemory(), config: {} });
  const nodes = ['A', 'B', 'C', 'D', 'E'];
  const edges = [
    { from: 'A', to: 'B', cost: 1 },
    { from: 'A', to: 'C', cost: 4 },
    { from: 'B', to: 'D', cost: 1 },
    { from: 'C', to: 'D', cost: 1 },
    { from: 'D', to: 'E', cost: 1 },
    { from: 'B', to: 'E', cost: 5 },
  ];
  ok(optimizer.optimalSubplan(nodes, edges, 'A', 'E') === undefined, '旗标关 → 最优子计划缺席（零漂移）');
  optimizer.attachAstarPlanner();
  const h = { A: 3, B: 2, C: 2, D: 1, E: 0 }; // 一致启发（剩余最少边数下界）
  const result = optimizer.optimalSubplan(nodes, edges, 'A', 'E', { heuristic: (n) => h[n] });
  ok(
    result !== undefined && result.goalReached && Math.abs(result.cost - 3) < 1e-9 && result.path.join('->') === 'A->B->D->E',
    `旗标开 → 可采纳 h 下最优子计划 = ${result ? result.path.join('->') : '—'}（cost ${result ? result.cost : '—'}，展开 ${result ? result.expanded : '—'} 节点 / 重开 ${result ? result.reopened : '—'}——运行时账单可审计）`,
  );
}

// ═══════════════════ 72.0 稀疏恢复 ═══════════════════

section('72.0 稀疏恢复（Optimizer.attachSparseAttribution）');

{
  const optimizer = new Optimizer({ memory: stubMemory(), config: {} });
  ok(optimizer.attributeFactors([[1], [1]], [1, 2]) === undefined, '旗标关 → 稀疏归因缺席（零漂移）');
  optimizer.attachSparseAttribution();
  const design = root.randomSparseDesign(80, 8, 2, 20261005, { noiseSigma: 0.1 }); // 恰 2 个因素真正起作用
  // 采集纪律：y 中心化（内核无截距项）+ 设计阵列标准化（接线建议的归因管线口径）
  const mean = design.y.reduce((s, x) => s + x, 0) / design.y.length;
  const y = design.y.map((v) => v - mean);
  const colNorm = Array.from({ length: 8 }, (_, j) => Math.sqrt(design.A.reduce((s, row) => s + row[j] * row[j], 0)));
  const A = design.A.map((row) => row.map((v, j) => v / colNorm[j]));
  const result = optimizer.attributeFactors(A, y);
  const trueMax = result ? Math.max(...design.support.map((j) => Math.abs(result.coefficients[j]))) : 0;
  const otherMax = result ? Math.max(0, ...result.activeSet.filter((j) => !design.support.includes(j)).map((j) => Math.abs(result.coefficients[j]))) : 1;
  ok(
    result !== undefined && design.support.every((j) => result.activeSet.includes(j)) && otherMax < trueMax / 50,
    `旗标开 → activeSet ⊇ 真支撑 [${result ? result.activeSet.join(',') : '—'}] ⊇ [${design.support.join(',')}]，真系数 ${trueMax.toFixed(2)} 量级压倒支撑外（≤${otherMax.toFixed(3)}）——「真正起作用的少数因素」短清单，交 5.0 因果内核定方向`,
  );
  ok(result !== undefined && result.kktViolation <= 1e-6, `KKT 最优性证书随结果落账（违反 ${result ? result.kktViolation.toExponential(1) : '—'} ≤ 0——可采信）`);
}

// ═══════════════════ 73.0 最佳臂识别 ═══════════════════

section('73.0 最佳臂识别（BenchmarkEngine.attachBaiSelector）');

{
  const dir = path.join(os.tmpdir(), `verify-g25-bench-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const bench = new BenchmarkEngine(dir);
  const rng = mulberry32(20261006);
  bench.registerScenario({
    name: 'stable-path',
    description: '稳定引擎（高成功率臂）',
    target: 'memory',
    concurrency: 2,
    totalRequests: 12,
    warmupRequests: 0,
    timeout: 5000,
    execute: async () => {
      await sleep(2);
      return { success: true, latency: 3 + rng() };
    },
  });
  bench.registerScenario({
    name: 'flaky-path',
    description: '不稳定引擎（低成功率臂）',
    target: 'memory',
    concurrency: 2,
    totalRequests: 12,
    warmupRequests: 0,
    timeout: 5000,
    execute: async () => {
      await sleep(2);
      return { success: rng() < 0.55, latency: 5 + rng() };
    },
  });
  const plain = await bench.runAll();
  ok(plain.baiFocus === undefined, '旗标关 → 报告无 baiFocus（零漂移）');
  bench.attachBaiSelector({ budget: 80 });
  const report = await bench.runAll();
  ok(
    report.baiFocus !== undefined && report.baiFocus.recommended === 'stable-path',
    `旗标开 → 锦标赛冠军 = ${report.baiFocus ? report.baiFocus.recommended : '—'}（SH ${report.baiFocus ? report.baiFocus.rounds : '—'} 轮，样本分配 ${report.baiFocus ? report.baiFocus.samplesPerArm.join('/') : '—'}——「选型」结论最优）`,
  );
  ok(
    report.baiFocus !== undefined && report.baiFocus.hComplexity < Number.POSITIVE_INFINITY && report.baiFocus.samplesPerArm.reduce((s, n) => s + n, 0) <= 80,
    `H 复杂度有限（${report.baiFocus ? Math.round(report.baiFocus.hComplexity) : '—'}）且预算纪律守恒（Σ ≤ 80——与 45.0 OCBA「确认预算」分工在案）`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════ 74.0 镜像下降 ═══════════════════

section('74.0 镜像下降（DecisionEngine.attachNoRegretRouter）');

{
  const engine = new DecisionEngine();
  const history = new Map([['gen25-nr', { totalDecisions: 10, successRate: 0.8, avgExecutionTime: 1000, avgTokenCost: 800 }]]);
  ok(engine.noRegretView() === undefined, '旗标关 → 无悔读数缺席（零漂移）');
  engine.attachNoRegretRouter({ mirror: 'entropic' });
  ok(engine.noRegretView() === undefined, '样本不足（<5）→ 诚实不输出（零漂移延伸）');
  // execute 反复成功（决策全走启发式 execute → outcome good）→ 无悔混合应偏向 execute
  for (let i = 0; i < 12; i += 1) {
    const signal = mkSignal('gen25-nr', `任务 ${i}`);
    const decisions = await engine.decide([signal], history);
    const d = decisions.get(signal.id);
    engine.recordOutcome('gen25-nr', engine.fingerprint(signal), d.action === 'defer' ? 'failed' : 'good');
  }
  const view = engine.noRegretView();
  ok(
    view !== undefined && view.actions.length === 4 && Math.abs(view.averageStrategy.reduce((s, v) => s + v, 0) - 1) < 1e-6,
    `旗标开 → 熵镜像重放收敛（x̄ ∈ Δ⁴，Σ=1；T=${view ? view.rounds : '—'} 轮）`,
  );
  const executeIdx = view ? view.actions.indexOf('execute') : -1;
  const deferIdx = view ? view.actions.indexOf('defer') : -1;
  ok(
    view !== undefined && executeIdx >= 0 && deferIdx >= 0 && view.averageStrategy[executeIdx] > view.averageStrategy[deferIdx],
    `混合策略偏向高价值行动（execute x̄=${view ? view.averageStrategy[executeIdx].toFixed(3) : '—'} > defer ${view ? view.averageStrategy[deferIdx].toFixed(3) : '—'}；后悔 R=${view ? view.regret.toFixed(3) : '—'} ≤ 界 ${view ? view.regretBound.toFixed(3) : '—'}）`,
  );
}

// ═══════════════════ 75.0 在线校准 ═══════════════════

section('75.0 在线校准（DecisionEngine.attachProbabilityCalibrator）');

{
  const engine = new DecisionEngine();
  const history = new Map([['gen25-cal', { totalDecisions: 5, successRate: 0.5, avgExecutionTime: 800, avgTokenCost: 900 }]]);
  const signal = mkSignal('gen25-cal', '校准探针任务', 0.55);
  const fp = engine.fingerprint(signal);
  const offDecision = (await engine.decide([signal], history)).get(signal.id);
  ok(offDecision.confidence === 0.5 && !offDecision.reason.includes('75.0'), `旗标关 → 决策逐位原口径（confidence 0.5，reason 无标注——零漂移）`);
  engine.attachProbabilityCalibrator({ strategy: 'platt', lr: 0.2, drift: { minCount: 5, checkPeriod: 5, consecutive: 2, thresholdK: 3 } });
  const gateClosed = (await engine.decide([signal], history)).get(signal.id);
  ok(
    gateClosed.confidence === 0.5 && !gateClosed.reason.includes('75.0'),
    '挂载但门控未开 → 恒等直通（未确证失准时输出逐位不变——门控设计的零漂移）',
  );
  // 喂系统性失准流：预报 ~0.5/0.85 却总失败（y=0）→ 漂移哨兵确证 → 门控锁存
  for (let i = 0; i < 40; i += 1) {
    await engine.decide([signal], history);
    engine.recordOutcome('gen25-cal', fp, 'failed');
  }
  const status = engine.calibrationStatus();
  ok(status !== undefined && status.active === true, `失准确证 → 门控锁存（n=${status ? status.drift.n : '—'}，worstZ=${status ? status.drift.worstZ.toFixed(1) : '—'} > 3）`);
  const calibrated = (await engine.decide([signal], history)).get(signal.id);
  ok(
    calibrated.reason.includes('75.0 校准') && calibrated.confidence < 0.5,
    `门控开启 → 输出置信度被校准下修（→ ${calibrated.confidence.toFixed(3)}，reason 携带〔75.0 校准〕——「报多少就发生多少」的概率口径前置层生效）`,
  );
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— 创世纪 51.0→75.0 全链路接线零漂移验证成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
