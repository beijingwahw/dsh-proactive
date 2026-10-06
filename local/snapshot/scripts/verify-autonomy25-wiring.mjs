/**
 * verify-autonomy25-wiring.mjs — 第二轮创世纪升级 76.0→100.0 全链路接线零漂移验证
 *
 * 用真实引擎（Sentinel / WorldModel / ReflectionEngine / Reflector /
 * DecisionEngine / TaskExecutor / PolicyEvolver / Sandbox / StrategyEvolutionEngine /
 * CuriosityEngine / LongTermMemory / BenchmarkEngine / AutonomyLoop / SelfModel，
 * 全程离线——LLMClient 指向 mock 主机不发真实请求）验证 25 个新内核：
 *   ① dist 导出 25 内核全部符号（含消歧别名 MdlEpisode/SpiEpisode 等的
 *      适配层再导出口径）+ 14 引擎挂载面 + autonomy25 适配层；
 *   ② 每个接线点「旗标关 = 现状（读数缺席 / undefined / 行为逐位不变）」
 *      与「旗标开 = 生效（真实数学读数产出 / 决策口径切换）」对照；
 *   ③ 末尾 PASS n / FAIL m，失败 exit 1。
 *
 * 运行：npm run build && node scripts/verify-autonomy25-wiring.mjs
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import * as root from '../dist/index.mjs';
import {
  LLMClient,
  Sentinel,
  WorldModel,
  ReflectionEngine,
  Reflector,
  DecisionEngine,
  TaskExecutor,
  ModelScheduler,
  PolicyEvolver,
  Sandbox,
  StrategyEvolutionEngine,
  CuriosityEngine,
  LongTermMemory,
  BenchmarkEngine,
  GoalEngine,
  MetaCognitionEngine,
  AutonomyLoop,
  SelfModel,
  mulberry32,
  ConsciousnessBus,
  SentinelNoveltyMonitor,
  PreferenceLedger,
  MetacognitionLedger,
  ReplayConsolidator,
  tigerPomdp,
  makeChain,
  randomPolicy,
  collectEpisodes,
  dagFromEdges,
  sampleLinearSem,
  twoMoons,
  rockPaperScissors,
  makeDomainGap,
  saturationScore,
  simulateEnv,
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

/** 确定性 LCG（verify 内部的独立噪声源——不碰内核 RNG） */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 最小信号对象 */
function mkSignal(type, description, urgency = 0.6) {
  return { id: `sig-${type}-${Math.random()}`, type, description, payload: {}, source: 'test', urgency, receivedAt: Date.now(), occurrences: 1 };
}

/** 记忆 stub（Reflector/TaskExecutor 消费面） */
function stubMemory() {
  return {
    getBayesianEstimate() {
      return undefined;
    },
  };
}

// ═══════════════════ ① dist 导出面 ═══════════════════

section('① dist 导出：25 内核全部符号 + 14 引擎挂载面 + autonomy25 适配层');

{
  const probe = {
    '76.0': ['AdaptiveReferenceWindow', 'CUSUMDetector', 'calibrateThreshold', 'knnNovelty', 'mahalanobisDepth', 'noveltyAUC', 'cusumARLSiegmund', 'normalQuantile'],
    '77.0': ['pcAlgorithm', 'cpdagFromDag', 'cpdagSummary', 'vStructuresOf', 'structuralHammingDistance', 'sampleLinearSem', 'dagFromEdges'],
    '78.0': ['cca', 'ridgeCCA', 'jacobiEigen', 'whiten'],
    '79.0': ['diffusionMaps', 'diffusionDistance', 'isomap', 'knnGraph', 'twoMoons', 'swissRoll'],
    '80.0': ['CountMinSketch', 'ExponentialHistogram', 'ReservoirSampler', 'misraGries', 'verifySketches', 'countMinSketchShape'],
    '81.0': ['argumentFramework', 'groundedExtension', 'acceptance', 'preferredExtensions', 'stableExtensions', 'EXTENSION_SEMANTICS', 'MAX_ENUM_ARGUMENTS', 'formatArgumentSet'],
    '82.0': ['dawidSkene', 'majorityVote', 'weightedMajority', 'reliabilityWeights', 'estimateAccuracy', 'simulateCrowd', 'WORKER_ARCHETYPES'],
    '83.0': ['learnModel', 'valueIteration', 'bellmanResidual', 'successorFeatures', 'dynaQ', 'retarget', 'makeChain', 'collectEpisodes', 'greedyActions', 'qLearning'],
    '84.0': ['alphaVectorVI', 'beliefUpdate', 'beliefValue', 'greedyActionAt', 'qmdp', 'qmdpValueAt', 'tigerPomdp', 'validatePomdp'],
    '85.0': ['dpllSolve', 'countModels', 'checkModel', 'unitPropagate', 'parseDimacsLite', 'randomKSat', 'plantedSat', 'bruteForceSat'],
    '86.0': ['smdpQLearning', 'flatQLearning', 'intraOptionQLearning', 'hallwayOptions', 'primitiveOptions', 'optionBellmanResidual', 'corridorGridworld', 'fourRoomsGridworld', 'solveSmdpExact', 'smokeTestPolicy'],
    '87.0': ['cbfFilter', 'brakeDoubleIntegrator', 'violationReport', 'simulateClosedLoop', 'BARRIER_VIOLATION_TOL'],
    '88.0': ['drEstimate', 'drPerEpisode', 'ois', 'wis', 'pdis', 'oisPerEpisode', 'pdisPerEpisode', 'empiricalBernsteinCI', 'naiveMean', 'importanceWeights', 'makeCliffWorld'],
    '89.0': ['safePolicyImprove', 'concentrationCurve', 'ebRadius', 'rejectionRate', 'pdisEpisodeValue'],
    '90.0': ['bradleyTerryMLE', 'btGoodnessOfFit', 'transitivityCheck', 'rankByUtility', 'predictPair', 'eloSequence', 'eloUpdate', 'heldOutAccuracy', 'thurstoneProbability', 'ELO_SCALE'],
    '91.0': ['noveltyScore', 'noveltySearch', 'fitnessOnlySearch', 'deceptiveMaze', 'hardMazeStats', 'openFieldMaze'],
    '92.0': ['exploitability', 'fictitiousPlay', 'leaguePlay', 'matrixGame', 'bestResponse', 'kuhnPokerMini', 'rockPaperScissors', 'valueOf'],
    '93.0': ['hyperband', 'bracketSchedule', 'spearmanRho', 'learningCurveFactory', 'randomSearchFullBudget', 'saturationScore', 'successiveHalvingUnit'],
    '94.0': ['mmd2', 'energyDistance', 'densityRatioClassifier', 'calibrateSim', 'reweightedStatistic', 'makeDomainGap', 'medianHeuristicGamma', 'weightedMmd2'],
    '95.0': ['takeoverThreshold', 'handoffPolicy', 'interruptedQLearning', 'simulateHandoff', 'alwaysInterruptSchedule', 'makePiecewiseHandoffWorld'],
    '96.0': ['GlobalWorkspace', 'DEFAULT_GLOBAL_WORKSPACE', 'defaultPriority', 'makeLinearPriority', 'shannonEntropyBits', 'DEFAULT_PRIORITY_WEIGHTS'],
    '97.0': ['shouldAsk', 'optimalAskThreshold', 'metaDprime', 'confidenceAccuracyCurve', 'typeOneDprime', 'posteriorErrorProbability', 'probit', 'simulateMetacognition'],
    '98.0': ['PrioritizedReplay', 'WeightedBanditLearner', 'SgdBanditLearner', 'sleepConsolidation', 'continualTaskStream', 'rehearsalVsNone', 'REWARD_MODEL'],
    '99.0': ['allocateAttention', 'concavityCheck', 'saturatingSource', 'geometricSource', 'unitDemandSource', 'misreportGain', 'greedyVsOptimal'],
    '100.0': ['detectAgency', 'identityContinuity', 'doVsObserve', 'contingencyScore', 'simulateEnv'],
  };
  const absentKernels = Object.entries(probe).filter(([, syms]) => syms.some((s) => root[s] === undefined)).map(([k]) => k);
  ok(absentKernels.length === 0, `25 内核全部符号经根入口导出（缺席：${absentKernels.join(',') || '无'}；探测 ${Object.values(probe).flat().length} 符号）`);

  const engineMounts = {
    Sentinel: ['attachNoveltySentinel', 'noveltyView', 'attachStreamingSketch', 'sketchView', 'sketchSelfCheck', 'attachAttentionEconomy', 'attentionMarket'],
    WorldModel: ['attachCausalLens', 'causalDiscoveryView', 'attachCcaLens', 'ccaAlignmentView', 'attachDiffusionLens', 'experienceManifoldView', 'attachModelLearning', 'modelLearningAudit'],
    ReflectionEngine: ['attachArgumentation', 'argumentationVerdict'],
    Reflector: ['attachCrowdAggregation', 'crowdVerdictOf', 'attachPreferenceLearning', 'notePreferencePair', 'preferenceView'],
    DecisionEngine: ['attachPomdpPlanner', 'pomdpActionValue', 'attachHandoffPolicy', 'handoffAdvice', 'attachMetacognitiveConfidence', 'noteMetacognitionPair', 'metacognitionView', 'metacognitiveShouldAsk'],
    TaskExecutor: ['attachSymbolicFeasibility', 'planFeasibility', 'attachOptionsFramework', 'optionsSkillAuditView', 'attachSafetyBarrier', 'barrierFilterAction'],
    PolicyEvolver: ['attachOpeGate', 'offlineEvaluation', 'attachSafeImprovementGate', 'safeImprovementVerdict'],
    Sandbox: ['attachSimCalibration', 'windTunnelReport'],
    StrategyEvolutionEngine: ['attachSelfPlay', 'selfPlayAudit'],
    CuriosityEngine: ['attachNoveltySearch', 'noveltySearchView'],
    LongTermMemory: ['attachExperienceReplay', 'replayPush', 'replayStats', 'sleepConsolidate'],
    BenchmarkEngine: ['attachHyperbandTuner', 'hyperbandTune'],
    AutonomyLoop: ['attachGlobalWorkspace', 'consciousnessStep', 'consciousnessView'],
    SelfModel: ['attachSelfBoundary', 'agencyAudit', 'identityAudit'],
  };
  const absentMounts = Object.entries(engineMounts).flatMap(([cls, methods]) => {
    const C = root[cls];
    if (!C) return [`${cls}（类缺席）`];
    return methods.filter((m) => typeof C.prototype[m] !== 'function').map((m) => `${cls}.${m}`);
  });
  ok(absentMounts.length === 0, `14 个引擎的挂载/读数方法全部在位（缺席：${absentMounts.join(', ') || '无'}）`);

  const adapters = [
    'SentinelNoveltyMonitor', 'SignalSketchBuffer', 'causalStructureView', 'sourceAlignmentView', 'manifoldEmbeddingView',
    'conflictAdjudication', 'crowdVerdict', 'modelLearningView', 'pomdpConsult', 'planFeasibilityCnf', 'planFeasibilityVerdict',
    'optionsSkillAudit', 'quotaBarrierSpec', 'quotaGuardAction', 'offlinePolicyAudit', 'safeImprovementGate', 'PreferenceLedger',
    'noveltyDirectionProbe', 'adversarialPressureAudit', 'hyperbandTune', 'windTunnelAudit', 'askUserHandoffAdvice',
    'ConsciousnessBus', 'MetacognitionLedger', 'shouldAskAdvice', 'ReplayConsolidator', 'attentionAuction',
    'agencyAttribution', 'identityContinuityScore',
  ];
  ok(adapters.every((a) => root[a] !== undefined), `engines-frontier/autonomy25 适配层导出在位（${adapters.length} 适配器/翻译函数）`);
  ok(
    typeof mulberry32 === 'function',
    '消歧纪律保持：根入口 mulberry32 仍为 28.0 规范版（8 个新内核的同名实现显式列表排除）',
  );
}

// ═══════════════════ 零漂移总检（旗标关 = 现状） ═══════════════════

section('零漂移总检：未挂载任何第二轮创世纪内核时新读数全部缺席');

{
  const mkSentinel = () => new Sentinel({ watchCodeChanges: false, watchErrors: false, watchPerformance: false, aggregationWindow: 0.5 }, () => {});
  const sentinel = mkSentinel();
  sentinel.ingest(mkSignal('off-a', 'x'));
  ok(sentinel.noveltyView() === undefined && sentinel.sketchView() === undefined && sentinel.sketchSelfCheck() === undefined && sentinel.attentionMarket([{ id: 's', marginalValue: () => 1 }], 2) === undefined, 'Sentinel：新奇 / 概要 / 注意力读数缺席（信号照常聚合）');
  const world = new WorldModel();
  ok(
    world.causalDiscoveryView({ columns: ['a', 'b'], rows: [[1, 2], [3, 4]] }) === undefined &&
      world.ccaAlignmentView([[1, 2], [3, 4]], [[1, 2], [3, 4]]) === undefined &&
      world.experienceManifoldView([[0, 0], [1, 1]]) === undefined &&
      world.modelLearningAudit(makeChain({ n: 4 }), []) === undefined,
    'WorldModel：因果 / CCA / 流形 / 转移学习读数缺席',
  );
  const reflection = new ReflectionEngine();
  ok(reflection.argumentationVerdict(['a', 'b'], [[0, 1]]) === undefined, 'ReflectionEngine：论证裁决缺席');
  const reflector = new Reflector({ memory: stubMemory(), config: {} });
  ok(reflector.crowdVerdictOf({ workers: ['m1'], classes: 2, labels: [[0]] }) === undefined && reflector.preferenceView() === undefined, 'Reflector：众包聚合 / 偏好效用读数缺席');
  const decision = new DecisionEngine();
  const tiger = tigerPomdp();
  ok(
    decision.pomdpActionValue(tiger, [1 / 3, 1 / 3, 1 / 3]) === undefined &&
      decision.handoffAdvice({ pError: 0.5, costAuto: 100, costHuman: 10 }) === undefined &&
      decision.metacognitionView() === undefined &&
      decision.metacognitiveShouldAsk(0.2, { costError: 100, costAsk: 10, priorError: 0.3 }) === undefined,
    'DecisionEngine：POMDP / 交接 / 元认知读数缺席',
  );
  const executor = new TaskExecutor({
    config: { qualityThreshold: 0.7, maxRetries: 1, globalTimeout: 5_000, nodeTimeout: 3_000, enableProgress: false, verbose: false },
    llm: new LLMClient(),
    modelScheduler: new ModelScheduler({ llm: new LLMClient(), memory: stubMemory() }),
    nodeRunner: async () => ({ output: 'ok', quality: 0.9, tokensUsed: 5 }),
  });
  ok(
    executor.planFeasibility([{ id: 'a' }]) === undefined &&
      executor.optionsSkillAuditView() === undefined &&
      executor.barrierFilterAction({ remaining: 10, burnRate: 1, decelCapacity: 1 }, 5) === undefined,
    'TaskExecutor：可行性 / 技能体检 / 屏障过滤读数缺席',
  );
  const evolver = new PolicyEvolver();
  const uniform = { numActions: 2, prob: () => 0.5 };
  ok(evolver.offlineEvaluation([{ states: [0], actions: [0], rewards: [1] }, { states: [0], actions: [1], rewards: [0] }], uniform, uniform) === undefined && evolver.safeImprovementVerdict([{ states: [0], actions: [0], rewards: [1] }], uniform, uniform, uniform) === undefined, 'PolicyEvolver：离线评估 / 安全改进门控读数缺席');
  const sandbox = new Sandbox({ models: [], tasks: [], config: { evaluationSeeds: 2 } });
  ok(sandbox.windTunnelReport([0.5, 0.6], [0.5, 0.6]) === undefined, 'Sandbox：风洞修正读数缺席');
  const evolution = new StrategyEvolutionEngine({ rng: mulberry32(20261001) });
  ok(evolution.selfPlayAudit([[0, -1], [1, 0]]) === undefined, 'StrategyEvolution：对抗压力读数缺席');
  const curiosity = new CuriosityEngine({ getExposure: () => ({}), getExperienceCounts: () => ({}), getFailureRates: () => ({}) });
  ok(curiosity.noveltySearchView([[0, 0]], [[1, 1]]) === undefined, 'CuriosityEngine：新奇定向读数缺席');
  const bench = new BenchmarkEngine(path.join(os.tmpdir(), `verify-a25-bench-off-${process.pid}`));
  ok(bench.hyperbandTune([{ q: 1 }], () => 1, 9) === undefined, 'BenchmarkEngine：Hyperband 寻优缺席');
  fs.rmSync(path.join(os.tmpdir(), `verify-a25-bench-off-${process.pid}`), { recursive: true, force: true });
}

// ═══════════════════ 76.0 新奇检测 ═══════════════════

section('76.0 新奇检测（Sentinel.attachNoveltySentinel）');

{
  const mkSentinel = () => new Sentinel({ watchCodeChanges: false, watchErrors: false, watchPerformance: false, aggregationWindow: 0.5 }, () => {});
  const feed = (sentinel) => {
    for (let i = 0; i < 24; i += 1) {
      sentinel.ingest({ type: 'novel-a', description: `常规信号 ${i}`, payload: {}, source: 'test', urgency: 0.5, receivedAt: (1_700_000_000 + i) * 1000 });
    }
  };
  const off = mkSentinel();
  feed(off);
  ok(off.noveltyView() === undefined, '旗标关 → 到达流照常聚合、新奇读数缺席（零漂移）');
  const on = mkSentinel();
  on.attachNoveltySentinel({ window: { capacity: 64, halfLife: 64, minSamples: 12 }, changeAlpha: 0.05 });
  feed(on);
  const baseline = on.noveltyView();
  ok(baseline !== undefined && baseline.windows.length === 1 && baseline.windows[0].size >= 12, `旗标开 → 参考窗建立（${baseline ? baseline.windows[0].size : '—'}/${baseline ? baseline.windows[0].effectiveSize.toFixed(1) : '—'} 有效样本）——「已见世界」有了深度口径`);
  // 模式突变：从未见过的特征组合（超高紧急度 + 超长描述 + 高合并数）
  on.ingest({ type: 'novel-a', description: `异常模式 ${'x'.repeat(2000)}`, payload: {}, source: 'test', urgency: 1, receivedAt: 1_700_100_000 * 1000, occurrences: 40 });
  const after = on.noveltyView();
  ok(
    after !== undefined && after.recentNovel.length === 1 && after.recentNovel[0].novel === true,
    `旗标开 → 模式突变被双证据判新（Mahalanobis 门控 + kNN 计数比——「异常」从「幅值超阈」升级为「没见过」）`,
  );
  // 适配层直测：同类流的新奇分序列 CUSUM 变点（系统性预警口径）
  const monitor = new SentinelNoveltyMonitor({ window: { capacity: 64, halfLife: 64, minSamples: 8 }, changeAlpha: 0.05 });
  for (let i = 0; i < 10; i += 1) monitor.observe({ type: 't', urgency: 0.5, descriptionLength: 20, occurrences: 1 });
  const read = monitor.observe({ type: 't', urgency: 0.99, descriptionLength: 400, occurrences: 30 });
  ok(read !== undefined && read.novel === true, `SentinelNoveltyMonitor.observe 直测：同位流突变 novel=${read ? read.novel : '—'}（特征口径 [urgency, log1p(len)/8, log1p(occ), hash/32]）`);
}

// ═══════════════════ 77.0 因果发现 ═══════════════════

section('77.0 因果发现（WorldModel.attachCausalLens）');

{
  const world = new WorldModel();
  const dag = dagFromEdges(3, [[0, 1], [1, 2]]);
  const rows = sampleLinearSem(dag, 3000, { noiseSigma: 0.4 }, 20261001);
  const input = { columns: ['旋钮A', '特征B', 'KPI_C'], rows };
  ok(world.causalDiscoveryView(input) === undefined, '旗标关 → 学图缺席（零漂移）');
  world.attachCausalLens({ alpha: 0.01 });
  const view = world.causalDiscoveryView(input);
  ok(view !== undefined, `旗标开 → PC 学图产出（${view ? view.result.nTests : '—'} 次条件独立检验，${view ? view.result.nVStructures : '—'} 个 v-结构）`);
  ok(
    view !== undefined && view.directedEdges.length + view.undirectedEdges.length >= 2,
    `因果骨架恢复：有向 ${view ? view.directedEdges.map((e) => `${e.from}→${e.to}`).join(' ') || '—' : ''}${view && view.undirectedEdges.length > 0 ? ` / 无向 ${view.undirectedEdges.map((e) => `${e.a}—${e.b}`).join(' ')}` : ''}（真值链 A→B→C 的马尔可夫等价类）`,
  );
  ok(view !== undefined && view.undirectedEdges.every((e) => e.a !== e.b), '无向边保留为「数据说不清」的诚实陈述（接线侧不替它拍方向）');
}

// ═══════════════════ 78.0 典型相关 ═══════════════════

section('78.0 典型相关（WorldModel.attachCcaLens）');

{
  const world = new WorldModel();
  const rand = lcg(20261002);
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rand()))) * Math.cos(2 * Math.PI * Math.max(1e-9, rand()));
  const n = 60;
  const shared = Array.from({ length: n }, () => gauss());
  const x = shared.map((s) => [s + 0.1 * gauss(), 0.3 * gauss()]);
  const y = shared.map((s) => [0.8 * s + 0.2 * gauss(), 0.2 * gauss()]);
  ok(world.ccaAlignmentView(x, y) === undefined, '旗标关 → 对齐读数缺席（零漂移）');
  world.attachCcaLens({ lambda: 0.1 });
  const view = world.ccaAlignmentView(x, y);
  ok(view !== undefined && view.topCorrelation > 0.6, `旗标开 → 第一典型相关 ρ₁=${view ? view.topCorrelation.toFixed(3) : '—'}（共享因子方向可作证据融合的公共坐标系）`);
  ok(view !== undefined && view.cca.xScores[0].length === n && !view.overfitWarning, `谱健康（rank ${view ? view.cca.rankX : '—'}×${view ? view.cca.rankY : '—'}，λ=${view ? view.cca.l2 : '—'} 岭护栏下无全 1 谱过拟合警报）`);
}

// ═══════════════════ 79.0 扩散映射 ═══════════════════

section('79.0 扩散映射（WorldModel.attachDiffusionLens）');

{
  const world = new WorldModel();
  const moons = twoMoons(60, 20261003);
  ok(world.experienceManifoldView(moons.points) === undefined, '旗标关 → 流形读数缺席（零漂移）');
  world.attachDiffusionLens({ k: 8, dims: 2 });
  const view = world.experienceManifoldView(moons.points);
  ok(
    view !== undefined && view.result.embedding.length === 60 && view.result.embedding[0].length === 2,
    `旗标开 → 经验连续嵌入产出（60 点 → 2 维，嵌入欧氏距离 ≈ 扩散距离 = 流形连通难度）`,
  );
  ok(view !== undefined && view.nComponents >= 1 && view.gapIndex >= 2, `结构读数：${view ? view.nComponents : '—'} 个连通分量 / 谱隙@${view ? view.gapIndex : '—'}（双月牙的簇结构进入经验分布预警口径）`);
}

// ═══════════════════ 80.0 流式概要 ═══════════════════

section('80.0 流式概要（Sentinel.attachStreamingSketch）');

{
  const mkSentinel = () => new Sentinel({ watchCodeChanges: false, watchErrors: false, watchPerformance: false, aggregationWindow: 0.5, maxBatchSize: 10_000 }, () => {});
  const feed = (sentinel) => {
    for (let i = 0; i < 120; i += 1) sentinel.ingest({ type: 'hot-key', description: `热键 ${i}`, payload: {}, source: 'test', receivedAt: (1_700_000_000 + i) * 1000 });
    for (let t = 0; t < 4; t += 1) {
      for (let i = 0; i < 20; i += 1) sentinel.ingest({ type: `cold-${t}`, description: `冷键 ${t}-${i}`, payload: {}, source: 'test', receivedAt: (1_700_100_000 + t * 100 + i) * 1000 });
    }
  };
  const off = mkSentinel();
  feed(off);
  ok(off.sketchView() === undefined && off.sketchSelfCheck() === undefined, '旗标关 → 信号照常聚合、概要读数缺席（零漂移）');
  const on = mkSentinel();
  on.attachStreamingSketch({ cmsEps: 0.02, cmsDelta: 0.01, window: 1000 });
  feed(on);
  const view = on.sketchView();
  ok(
    view !== undefined && view.cms.estimate('hot-key') >= 120 && view.cms.estimate('cold-0') >= 20,
    `旗标开 → CMS 键频上界口径（hot ${view ? view.cms.estimate('hot-key') : '—'} ≥ 120 / cold-0 ${view ? view.cms.estimate('cold-0') : '—'} ≥ 20——只高不低，ε‖a‖₁ 上界）`,
  );
  ok(view !== undefined && view.heavyHitters.candidates.some((c) => c.key === 'hot-key'), `Misra–Gries 重元素捕获热键（阈 N/${view ? view.heavyHitters.counters + 1 : '—'} 的 100% 捕获保证）`);
  const check = on.sketchSelfCheck();
  ok(check !== undefined && check.allPassed === true, `四结构保证自检 allPassed=${check ? check.allPassed : '—'}（不通过时拒绝发布该概要读数——诚实降级）`);
}

// ═══════════════════ 81.0 论证 ═══════════════════

section('81.0 论证（ReflectionEngine.attachArgumentation）');

{
  const engine = new ReflectionEngine();
  // A 与 B 互相攻击（争议不可强裁），C 无攻击者（无争议辩护链）
  const conclusions = ['结论A', '结论B', '结论C'];
  const attacks = [[0, 1], [1, 0]];
  ok(engine.argumentationVerdict(conclusions, attacks) === undefined, '旗标关 → 裁决缺席（零漂移）');
  engine.attachArgumentation();
  const view = engine.argumentationVerdict(conclusions, attacks);
  ok(
    view !== undefined && view.groundedIds.length === 1 && view.groundedIds[0] === '结论C',
    `旗标开 → grounded 辩护链 = [${view ? view.groundedIds.join(',') : '—'}]（A/B 互攻无争议辩护、C 无攻击者——最保守裁判只接受无争议闭合链）`,
  );
  const accA = view && view.acceptances.find((a) => a.argument === '结论A');
  const accC = view && view.acceptances.find((a) => a.argument === '结论C');
  ok(accA && accC && accA.sceptical === false && accC.sceptical === true, `疑信接受：C ✓ / A ✗（被拒结论携带致败边——拒绝第一次有了数学尸检报告）`);
}

// ═══════════════════ 82.0 众包聚合 ═══════════════════

section('82.0 众包聚合（Reflector.attachCrowdAggregation）');

{
  const reflector = new Reflector({ memory: stubMemory(), config: {} });
  const rand = lcg(20261004);
  const truth = [0, 1, 0, 1, 0, 1, 0, 1];
  // 两名可靠模型（85% 正确）+ 一名对抗模型（80% 故意标反）
  const labels = [0, 1, 2].map((w) => truth.map((t) => {
    const good = rand() < 0.85;
    if (w === 2) return rand() < 0.8 ? 1 - t : t;
    return good ? t : 1 - t;
  }));
  const input = { workers: ['model-good', 'model-good2', 'model-adv'], classes: 2, labels };
  ok(reflector.crowdVerdictOf(input) === undefined, '旗标关 → 聚合缺席（零漂移）');
  reflector.attachCrowdAggregation();
  const view = reflector.crowdVerdictOf(input, truth);
  ok(
    view !== undefined && view.ds.workerReliability[2] < view.ds.workerReliability[0],
    `旗标开 → EM 学出信任票权（对抗模型 ${view ? view.ds.workerReliability[2].toFixed(3) : '—'} < 可靠模型 ${view ? view.ds.workerReliability[0].toFixed(3) : '—'}——「谁在哪里可信」从记录里自己学出来）`,
  );
  ok(
    view !== undefined && estimateAccOf(view.weightedLabels, truth) >= estimateAccOf(view.majorityLabels, truth),
    `加权多数票不劣于等权多数票（${view ? `${(estimateAccOf(view.weightedLabels, truth) * 100).toFixed(1)}% vs ${(estimateAccOf(view.majorityLabels, truth) * 100).toFixed(1)}%——垃圾/对抗者在 E 步自动出局）` : ''}`,
  );
}
function estimateAccOf(est, truth) {
  let hit = 0;
  for (let i = 0; i < truth.length; i += 1) if (est[i] === truth[i]) hit += 1;
  return hit / truth.length;
}

// ═══════════════════ 83.0 世界模型学习 ═══════════════════

section('83.0 世界模型学习（WorldModel.attachModelLearning）');

{
  const world = new WorldModel();
  const mdp = makeChain({ n: 6 });
  const episodes = collectEpisodes(mdp, randomPolicy(mdp), 16, 20261005);
  ok(world.modelLearningAudit(mdp, episodes) === undefined, '旗标关 → 学模型读数缺席（零漂移）');
  world.attachModelLearning({ prior: 2 });
  const view = world.modelLearningAudit(mdp, episodes);
  ok(
    view !== undefined && view.vi.V.length === mdp.states.length && Number.isFinite(view.residual),
    `旗标开 → T̂/r̂ 学成 + 值迭代收敛（${view ? view.vi.iterations : '—'} 轮，V 表 ${view ? view.vi.V.length : '—'} 态）`,
  );
  ok(view !== undefined && view.residual < 1e-6, `Bellman 残差 ${view ? view.residual.toExponential(1) : '—'} < 1e-6（模型-策略联合健康度——残差大 = 先诊断再动作用）`);
  ok(view !== undefined && view.greedyActions.length === mdp.states.length, `贪心策略表 ${view ? view.greedyActions.length : '—'} 行在案（换目标不重规划的后继特征底座）`);
}

// ═══════════════════ 84.0 POMDP ═══════════════════

section('84.0 POMDP（DecisionEngine.attachPomdpPlanner）');

{
  const engine = new DecisionEngine();
  const tiger = tigerPomdp(); // states: [tiger-left, tiger-right, done]
  const b0 = [0.5, 0.5, 0];
  ok(engine.pomdpActionValue(tiger, b0, 4) === undefined, '旗标关 → 信念规划读数缺席（零漂移）');
  engine.attachPomdpPlanner();
  const view = engine.pomdpActionValue(tiger, b0, 4);
  ok(
    view !== undefined && Number.isFinite(view.beliefValue) && view.infoGap >= 0,
    `旗标开 → 信念价值下界 V(b)=${view ? view.beliefValue.toFixed(2) : '—'}（α-VI H=4）× QMDP 上界 ${view ? view.qmdpUpper.toFixed(2) : '—'}——信息价值间隙 ${view ? view.infoGap.toFixed(2) : '—'}`,
  );
  ok(
    view !== undefined && tiger.actions[view.greedyAction] === 'listen',
    `贪心动作 = ${view ? view.actionName : '—'}（均匀信念下「先听后开」——defer/execute/ask-user 的开销-价值比较有了精确口径）`,
  );
}

// ═══════════════════ 85.0 符号求解 ═══════════════════

section('85.0 符号求解（TaskExecutor.attachSymbolicFeasibility）');

{
  const executor = new TaskExecutor({
    config: { qualityThreshold: 0.7, maxRetries: 1, globalTimeout: 5_000, nodeTimeout: 3_000, enableProgress: false, verbose: false },
    llm: new LLMClient(),
    modelScheduler: new ModelScheduler({ llm: new LLMClient(), memory: stubMemory() }),
    nodeRunner: async () => ({ output: 'ok', quality: 0.9, tokensUsed: 5 }),
  });
  // c 依赖 a/b 至少其一；容量 1 → c 与任一前置并存即超容 → UNSAT
  const nodes = [
    { id: 'a' }, { id: 'b' },
    { id: 'c', dependsOn: ['a', 'b'] },
  ];
  ok(executor.planFeasibility(nodes, { capacity: 1 }) === undefined, '旗标关 → 静态裁决缺席（零漂移）');
  executor.attachSymbolicFeasibility();
  const infeasible = executor.planFeasibility(nodes, { capacity: 1 });
  ok(
    infeasible !== undefined && infeasible.feasible === false && infeasible.solve.conflicts >= 1,
    `旗标开 → 容量 1 判死（UNSAT，${infeasible ? infeasible.solve.conflicts : '—'} 次冲突——动手前判死而非空转重试）`,
  );
  const feasible = executor.planFeasibility(nodes, { capacity: 2 });
  ok(
    feasible !== undefined && feasible.feasible === true && feasible.solutionCount === 2 && feasible.selectedIds.includes('c'),
    `容量 2 判活（SAT，${feasible ? feasible.solutionCount : '—'} 个可行选择 {a,c}/{b,c}——多解 = 有重排余地）`,
  );
}

// ═══════════════════ 86.0 分层技能 ═══════════════════

section('86.0 分层技能（TaskExecutor.attachOptionsFramework）');

{
  const executor = new TaskExecutor({
    config: { qualityThreshold: 0.7, maxRetries: 1, globalTimeout: 5_000, nodeTimeout: 3_000, enableProgress: false, verbose: false },
    llm: new LLMClient(),
    modelScheduler: new ModelScheduler({ llm: new LLMClient(), memory: stubMemory() }),
    nodeRunner: async () => ({ output: 'ok', quality: 0.9, tokensUsed: 5 }),
  });
  ok(executor.optionsSkillAuditView() === undefined, '旗标关 → 技能体检缺席（零漂移）');
  executor.attachOptionsFramework();
  const view = executor.optionsSkillAuditView();
  ok(
    view !== undefined && view.smoke.successRate >= 0.98 && view.compositionEfficiency > 0.9,
    `旗标开 → 技能宏组合体检：贪婪执行成功率 ${(view ? view.smoke.successRate * 100 : 0).toFixed(1)}%，组合效率 ${view ? view.compositionEfficiency.toFixed(3) : '—'}（γ^k 时间信用分配的精确宏模型基准——「子计划值得进主计划」）`,
  );
  ok(view !== undefined && view.residual < 1e-9, `option-Bellman 残差 ${view ? view.residual.toExponential(1) : '—'} < 1e-9（精确解处机器精度——价值表健康度账单）`);
}

// ═══════════════════ 87.0 安全屏障 ═══════════════════

section('87.0 安全屏障（TaskExecutor.attachSafetyBarrier）');

{
  const executor = new TaskExecutor({
    config: { qualityThreshold: 0.7, maxRetries: 1, globalTimeout: 5_000, nodeTimeout: 3_000, enableProgress: false, verbose: false },
    llm: new LLMClient(),
    modelScheduler: new ModelScheduler({ llm: new LLMClient(), memory: stubMemory() }),
    nodeRunner: async () => ({ output: 'ok', quality: 0.9, tokensUsed: 5 }),
  });
  // 配额态：余量 100 / 速率 8 / 减速容量 4（刹车距离 8²/8 = 8）
  const state = { remaining: 100, burnRate: 8, decelCapacity: 4 };
  ok(executor.barrierFilterAction(state, 8) === undefined, '旗标关 → 动作走原钳位路径（零漂移）');
  executor.attachSafetyBarrier({ eta: 0.5 });
  const safe = executor.barrierFilterAction(state, 8, { uMin: 0, uMax: 24 });
  ok(
    safe !== undefined && Math.abs(safe.u[0] - 8) < 1e-9 && !safe.infeasible,
    `旗标开 → 温和动作零修改通过（u=${safe ? safe.u[0].toFixed(1) : '—'}，margin=${safe ? safe.margin.toFixed(1) : '—'} ≥ 0）`,
  );
  const aggressive = executor.barrierFilterAction(state, 24, { uMin: 0, uMax: 24 });
  ok(
    aggressive !== undefined && (aggressive.infeasible || aggressive.u[0] < 24 - 1e-6),
    `激进动作被最小安全修改（期望 24 → 落地 ${aggressive ? aggressive.u[0].toFixed(1) : '—'}${aggressive && aggressive.infeasible ? '（infeasible：即便最优努力仍差 ' + aggressive.minViolation.toFixed(1) + '——须上报总督走熔断路径）' : ''}）`,
  );
}

// ═══════════════════ 88.0 离线评估 ═══════════════════

section('88.0 离线评估（PolicyEvolver.attachOpeGate）');

{
  const evolver = new PolicyEvolver();
  // 行为策略 μ = 均匀；奖励 r=1 仅当 a=0、T=3 步（J(μ)=1.5，J(π_cand)=2.85）
  const rand = lcg(20261006);
  const episodes = Array.from({ length: 200 }, () => {
    const T = 3;
    const states = [];
    const actions = [];
    const rewards = [];
    for (let t = 0; t < T; t += 1) {
      states.push(t % 3);
      const a = rand() < 0.5 ? 0 : 1;
      actions.push(a);
      rewards.push(a === 0 ? 1 : 0);
    }
    states.push(T % 3); // s_0..s_T（states = actions 长度 + 1）
    return { states, actions, rewards };
  });
  const behavior = { numActions: 2, prob: (_s, a) => 0.5 };
  const candidate = { numActions: 2, prob: (_s, a) => (a === 0 ? 0.95 : 0.05) };
  // 一阶 Q 模型（DR 的方差抑制项——近似 Q 不破坏无偏性，只影响方差）
  const qModel = (step, _s, a) => (a === 0 ? 3 - step : 0);
  ok(evolver.offlineEvaluation(episodes, candidate, behavior, qModel) === undefined, '旗标关 → 离线通道缺席（零漂移）');
  evolver.attachOpeGate({ delta: 0.05, gamma: 1 });
  const view = evolver.offlineEvaluation(episodes, candidate, behavior, qModel);
  ok(
    view !== undefined && view.drEstimate > 2.3 && view.drEstimate < 3.4,
    `旗标开 → DR 反事实估值 Ĵ(π)=${view ? view.drEstimate.toFixed(3) : '—'}（真值 2.85；naive ${view ? view.naiveBaseline.toFixed(3) : '—'} 只能看到 μ 的 1.5——「如果当初换策略」的无偏估计）`,
  );
  ok(
    view !== undefined && view.ci.lower > 2 && view.ci.upper < 4,
    `EB-CS 95% 区间 [${view ? view.ci.lower.toFixed(3) : '—'}, ${view ? view.ci.upper.toFixed(3) : '—'}]（反事实的统计证书——LCB ≤ 0 不放行）`,
  );
}

// ═══════════════════ 89.0 安全策略改进 ═══════════════════

section('89.0 安全策略改进（PolicyEvolver.attachSafeImprovementGate）');

{
  const evolver = new PolicyEvolver();
  const rand = lcg(20261007);
  const episodes = Array.from({ length: 200 }, () => {
    const T = 3;
    const states = [];
    const actions = [];
    const rewards = [];
    for (let t = 0; t < T; t += 1) {
      states.push(t % 3);
      const a = rand() < 0.5 ? 0 : 1;
      actions.push(a);
      rewards.push(a === 0 ? 1 : 0);
    }
    states.push(0); // s_0..s_T
    return { states, actions, rewards };
  });
  const behavior = { numActions: 2, prob: (_s, a) => 0.5 };
  const better = { numActions: 2, prob: (_s, a) => (a === 0 ? 0.95 : 0.05) };
  const worse = { numActions: 2, prob: (_s, a) => (a === 0 ? 0.05 : 0.95) };
  const qModel = (step, _s, a) => (a === 0 ? 3 - step : 0);
  ok(evolver.safeImprovementVerdict(episodes, better, behavior, behavior, qModel) === undefined, '旗标关 → 安全阀缺席（零漂移）');
  evolver.attachSafeImprovementGate({ delta: 0.05, minSamples: 30 });
  const accept = evolver.safeImprovementVerdict(episodes, better, behavior, behavior, qModel);
  ok(
    accept !== undefined && accept.verdict.accepted === true && accept.verdict.lcb > 0,
    `旗标开 → 优候选持证放行（Δ̂=${accept ? accept.verdict.delta.toFixed(3) : '—'}，LCB ${accept ? accept.verdict.lcb.toFixed(3) : '—'} > 0，${accept ? accept.verdict.reason : ''}）`,
  );
  const reject = evolver.safeImprovementVerdict(episodes, worse, behavior, behavior, qModel);
  ok(
    reject !== undefined && reject.verdict.accepted === false,
    `劣候选被拒（Δ̂=${reject ? reject.verdict.delta.toFixed(3) : '—'}，LCB ${reject ? reject.verdict.lcb.toFixed(3) : '—'} ≤ 0——「有统计证书才上线」）`,
  );
  ok(accept !== undefined && accept.curve.length >= 3, `集中率曲线 ${accept ? accept.curve.length : '—'} 点在案（回答「还差多少样本才能下发证书」）`);
}

// ═══════════════════ 90.0 偏好学习 ═══════════════════

section('90.0 偏好学习（Reflector.attachPreferenceLearning）');

{
  const reflector = new Reflector({ memory: stubMemory(), config: {} });
  const order = ['策略A', '策略B', '策略C', '策略D'];
  const pairs = [];
  for (let i = 0; i < order.length; i += 1) {
    for (let j = i + 1; j < order.length; j += 1) {
      for (let r = 0; r < 3; r += 1) pairs.push([order[i], order[j]]);
    }
  }
  ok(reflector.preferenceView() === undefined, '旗标关 → 效用读数缺席（零漂移）');
  reflector.attachPreferenceLearning({ minPairs: 8 });
  ok(reflector.preferenceView() === undefined, '样本不足（< minPairs）→ 诚实不输出');
  for (const [w, l] of pairs) reflector.notePreferencePair(w, l);
  const view = reflector.preferenceView();
  ok(
    view !== undefined && view.usable === true && view.ranking && view.ranking[0].utility >= view.ranking[view.ranking.length - 1].utility,
    `旗标开 → B-T 效用学成（${view ? view.pairs : '—'} 对，log-loss ${view && view.fit ? view.fit.logLoss.toFixed(3) : '—'} < ln2=0.693 瞎猜线）——排序可进策略进化适应度`,
  );
  // 环路偏好（石头剪刀布）→ 前置体检拒绝
  const cyclic = new Reflector({ memory: stubMemory(), config: {} });
  cyclic.attachPreferenceLearning({ minPairs: 6 });
  [['A', 'B'], ['B', 'C'], ['C', 'A']].forEach(([w, l]) => { for (let r = 0; r < 4; r += 1) cyclic.notePreferencePair(w, l); });
  const cycleView = cyclic.preferenceView();
  ok(
    cycleView !== undefined && cycleView.usable === false && cycleView.transitivity.cycles.length > 0,
    `环路偏好被前置体检拦截（${cycleView ? cycleView.transitivity.cycles.length : '—'} 个环路组——B-T 效用不得用于决策排序，退回 64.0 相关均衡口径）`,
  );
}

// ═══════════════════ 91.0 新奇搜索 ═══════════════════

section('91.0 新奇搜索（CuriosityEngine.attachNoveltySearch）');

{
  const provider = { getExposure: () => ({}), getExperienceCounts: () => ({}), getFailureRates: () => ({}) };
  const engine = new CuriosityEngine(provider);
  const archive = [[0.1, 0.1], [0.2, 0.05], [-0.1, 0.15], [0.05, 0.2], [0.15, -0.1], [-0.05, -0.15]];
  const candidates = [[0.1, 0.1], [6, 5], [-0.05, 0.1]];
  ok(engine.noveltySearchView(candidates, archive) === undefined, '旗标关 → 新奇定向读数缺席（零漂移）');
  engine.attachNoveltySearch({ k: 3 });
  const view = engine.noveltySearchView(candidates, archive);
  ok(
    view !== undefined && view.scores[1].novelty > view.scores[0].novelty && view.argmax !== 0,
    `旗标开 → kNN 新奇分定向（近档案 ${view ? view.scores[0].novelty.toFixed(2) : '—'} / 远档案 ${view ? view.scores[1].novelty.toFixed(2) : '—'}——探索预算向「没人活过的活法」定向@#${view ? view.argmax : '—'}）`,
  );
  const prior = engine.getExplorations().length;
  engine.recordExploration('a25-ns', true);
  ok(engine.getExplorations().length === prior + 1, '探索派发行为不变（记账不侵入既有路径）');
}

// ═══════════════════ 92.0 自我对弈 ═══════════════════

section('92.0 自我对弈（StrategyEvolutionEngine.attachSelfPlay）');

{
  const engine = new StrategyEvolutionEngine({ rng: mulberry32(20261008) });
  const rps = rockPaperScissors();
  const uniform = [1 / 3, 1 / 3, 1 / 3];
  const pureRock = [1, 0, 0];
  ok(engine.selfPlayAudit(rps.payoffRow) === undefined, '旗标关 → 对抗审计缺席（零漂移）');
  const reportBefore = JSON.stringify(engine.getReport().genomes.map((g) => g.genes));
  engine.attachSelfPlay({ leagueRounds: 40, seed: 9 });
  const nashView = engine.selfPlayAudit(rps.payoffRow, uniform);
  ok(
    nashView !== undefined && nashView.exploitability.total < 1e-6,
    `旗标开 → 均匀混合可剥削度 ${nashView ? nashView.exploitability.total.toExponential(1) : '—'} ≈ 0（RPS 的 Nash——弱点货币的零点校准）`,
  );
  const rockView = engine.selfPlayAudit(rps.payoffRow, pureRock);
  ok(
    rockView !== undefined && rockView.exploitability.total > 0.9,
    `纯石头策略可剥削度 ${rockView ? rockView.exploitability.total.toFixed(3) : '—'} > 0.9（欺负历史数据的偏科生在审计下现形——QD 归档准入升级为「适应度高 ∧ 难以被针对」）`,
  );
  ok(rockView !== undefined && rockView.league !== undefined && rockView.league.exploitabilityTrace.length === 40, `联赛 40 轮 exploiter 档案在案（${rockView && rockView.league ? rockView.league.leagueRoster.length : '—'} 条对手池——可审计的失败模式清单）`);
  const reportAfter = JSON.stringify(engine.getReport().genomes.map((g) => g.genes));
  ok(reportBefore === reportAfter, '影子计算只读：attach 前后种群基因逐位不变（evolve 路径零漂移）');
}

// ═══════════════════ 93.0 AutoML Hyperband ═══════════════════

section('93.0 AutoML Hyperband（BenchmarkEngine.attachHyperbandTuner）');

{
  const dir = path.join(os.tmpdir(), `verify-a25-hb-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const bench = new BenchmarkEngine(dir);
  const configs = [
    { id: 'cfg-a', q: 0.55, rate: 0.30 },
    { id: 'cfg-b', q: 0.95, rate: 0.35 },
    { id: 'cfg-c', q: 0.70, rate: 0.20 },
    { id: 'cfg-d', q: 0.85, rate: 0.10 },
  ];
  // evaluate = 凸饱和学习曲线（score 随 budget 单调不减——接线纪律）
  const evaluate = (config, budget) => saturationScore(config.q, config.rate, budget);
  ok(bench.hyperbandTune(configs, evaluate, 27) === undefined, '旗标关 → 寻优缺席（零漂移）');
  bench.attachHyperbandTuner({ eta: 3, seed: 20261009 });
  const result = bench.hyperbandTune(configs, evaluate, 27);
  ok(
    result !== undefined && result.bestConfig.id === 'cfg-b',
    `旗标开 → 冠军配置 = ${result ? result.bestConfig.id : '—'}（bestScore ${result ? result.bestScore.toFixed(3) : '—'}——渐近最优 q∞=0.95 的配置胜出）`,
  );
  ok(
    result !== undefined && Math.abs(result.totalBudgetSpent - result.schedule.totalBudget) < 1e-9,
    `预算审计守恒（spent ${result ? result.totalBudgetSpent : '—'} === schedule ${result ? result.schedule.totalBudget : '—'}——逐配置预算加和 1e-9 内对账）`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════ 94.0 仿真校准 ═══════════════════

section('94.0 仿真校准（Sandbox.attachSimCalibration）');

{
  const sandbox = new Sandbox({ models: [], tasks: [], config: { evaluationSeeds: 2 } });
  // 风洞：仿真 N(0,1)，真实 N(0.8,1)——域差 0.8 个标准差
  const gap = makeDomainGap({ shift: 0.8, seed: 20261010, nSim: 400, nReal: 400 });
  ok(sandbox.windTunnelReport(gap.sim, gap.real) === undefined, '旗标关 → 风洞读数缺席（零漂移）');
  sandbox.attachSimCalibration();
  const view = sandbox.windTunnelReport(gap.sim, gap.real);
  ok(
    view !== undefined && view.mmd2 > 0.01 && view.energy > 0.1,
    `旗标开 → 域差量化 MMD²=${view ? view.mmd2.toFixed(4) : '—'}（能量距离 ${view ? view.energy.toFixed(3) : '—'}）——「模拟器此刻失真多少」的仪表盘`,
  );
  ok(
    view !== undefined && view.calibration.gapAfter < view.calibration.gapBefore && view.realisticMean > view.simMean,
    `密度比换算生效：gap ${view ? view.calibration.gapBefore.toFixed(4) : '—'} → ${view ? view.calibration.gapAfter.toFixed(4) : '—'}（沙盒均值 ${view ? view.simMean.toFixed(3) : '—'} → 真实口径 ${view ? view.realisticMean.toFixed(3) : '—'}——sim-to-real 进入部署门禁的数学）`,
  );
}

// ═══════════════════ 95.0 中断交接 ═══════════════════

section('95.0 中断交接（DecisionEngine.attachHandoffPolicy）');

{
  const engine = new DecisionEngine();
  ok(engine.handoffAdvice({ pError: 0.5, costAuto: 100, costHuman: 10 }) === undefined, '旗标关 → 交接裁决缺席（零漂移）');
  engine.attachHandoffPolicy();
  const risky = engine.handoffAdvice({ pError: 0.5, costAuto: 100, costHuman: 10 });
  const cheap = engine.handoffAdvice({ pError: 0.05, costAuto: 100, costHuman: 10 });
  ok(
    risky !== undefined && risky.action === 'human',
    `旗标开 → 高风险求助（x = 0.5×100 = 50 > τ* = 10 → ask-user——自动错误的期望代价已超过打扰用户的全成本）`,
  );
  ok(
    cheap !== undefined && cheap.action === 'auto',
    `低风险自动执行（x = 5 < τ* = 10 → execute——不为低风险任务打扰用户）`,
  );
  ok(risky !== undefined && Math.abs(risky.threshold - 10) < 1e-9, `闭式阈值 τ* = c_H + c_delay = ${risky ? risky.threshold : '—'}（95.0 内核的期望成本最优口径）`);
}

// ═══════════════════ 96.0 全局工作空间 ═══════════════════

section('96.0 全局工作空间（AutonomyLoop.attachGlobalWorkspace / ConsciousnessBus）');

{
  // 引擎级挂载面 + 适配层总线直测（AutonomyLoop 构造依赖由最小代表团提供）
  const loop = new AutonomyLoop({
    goalEngine: new GoalEngine(),
    metaCognition: new MetaCognitionEngine(),
    evolution: new StrategyEvolutionEngine({ rng: mulberry32(20261011) }),
    collectKpi: () => ({}),
    dispatchSubtask: () => 'sig-gwt',
    maintainer: { distillExperience: () => 0, applyForgettingCurve: () => 0 },
    lessonProvider: () => [],
  });
  ok(loop.consciousnessStep() === undefined && loop.consciousnessView() === undefined, '旗标关 → 意识总线缺席（心跳零漂移）');
  loop.attachGlobalWorkspace([
    {
      id: 'sentinel',
      bid: (ctx) => ({ novelty: Math.min(1, ctx.signals.length / 8), relevance: ctx.goal ? 0.7 : 0.4, confidence: 0.8, urgency: Math.min(1, ctx.signals.length / 12) }),
      describe: (ctx) => (ctx.signals.length >= 4 ? ['异常爆发'] : ['常规信号流']),
    },
    { id: 'evolution', bid: (ctx) => ({ novelty: 0.3, relevance: ctx.goal ? 0.8 : 0.3, confidence: 0.6, urgency: 0.2 }), describe: () => ['策略突破候选'] },
    { id: 'budget', bid: () => ({ novelty: 0.2, relevance: 0.5, confidence: 0.9, urgency: 0.6 }), describe: () => ['预算告警监视'] },
  ]);
  const quiet = loop.consciousnessStep({ signals: ['routine'], goal: 'daily' });
  const flood = loop.consciousnessStep({ signals: Array.from({ length: 8 }, (_, i) => `sig-${i}`), goal: 'daily' });
  const view = loop.consciousnessView();
  ok(
    flood !== undefined && flood.ignited === true && flood.winner === 'sentinel',
    `旗标开 → 信号洪峰点火（胜者 ${flood ? flood.winner : '—'}，notify ${flood ? flood.notified.length : '—'} 模块——「此刻全员该知道什么」由投标竞争仲裁，不再由代码调用顺序决定）`,
  );
  ok(
    view !== undefined && view.steps === 2 && view.ignitionRatio > 0,
    `总线读数：${view ? view.steps : '—'} 拍 / 点火率 ${view ? (view.ignitionRatio * 100).toFixed(0) : '—'}%（ignitionRatio = 意识负荷 KPI）`,
  );
  // 适配层直测：级联传播（广播后其余模块以广播为上下文重算 relevance）
  const received = [];
  const bus = new ConsciousnessBus(
    [
      { id: 'a', bid: () => ({ novelty: 0.9, relevance: 0.5, confidence: 0.8, urgency: 0.5 }), onBroadcast: (c) => received.push(`a←${c.sourceId}`) },
      { id: 'b', bid: () => ({ novelty: 0.2, relevance: 0.5, confidence: 0.8, urgency: 0.5 }), onBroadcast: (c) => received.push(`b←${c.sourceId}`) },
    ],
    { threshold: 0.5 },
  );
  const first = bus.step({ signals: ['x'] });
  ok(first.ignited && first.winner === 'a' && received.includes('b←a'), `广播级联（b 收到 a 的广播：${received.join(' ') || '—'}）——胜者内容分发全员后重算 relevance`);
}

// ═══════════════════ 97.0 元认知信心 ═══════════════════

section('97.0 元认知信心（DecisionEngine.attachMetacognitiveConfidence）');

{
  const engine = new DecisionEngine();
  ok(engine.metacognitionView() === undefined, '旗标关 → 元认知读数缺席（零漂移）');
  engine.attachMetacognitiveConfidence();
  // 高信心多对 + 低信心多错（信心有分辨力的元认知流）
  for (let i = 0; i < 15; i += 1) engine.noteMetacognitionPair(0.85, true);
  for (let i = 0; i < 10; i += 1) engine.noteMetacognitionPair(0.35, false);
  const view = engine.metacognitionView();
  ok(
    view !== undefined && view.mRatio > 0.3,
    `旗标开 → 元认知效率 M-ratio = ${view ? view.mRatio.toFixed(3) : '—'}（meta-d′ ${view ? view.metaDprime.toFixed(2) : '—'} / d′ ${view ? view.typeOneDprime.toFixed(2) : '—'}——「知道自己不知道」的量化口径）`,
  );
  const ask = engine.metacognitiveShouldAsk(0.2, { costError: 100, costAsk: 10, priorError: 0.3 });
  const skip = engine.metacognitiveShouldAsk(0.95, { costError: 100, costAsk: 10, priorError: 0.3 });
  ok(
    ask !== undefined && ask.ask === true && skip !== undefined && skip.ask === false,
    `闭式求助阈值 c*≈${ask ? ask.threshold.toFixed(2) : '—'}：低信心 0.2 → ask（期望节余 ${ask ? ask.expectedSaving.toFixed(1) : '—'}）/ 高信心 0.95 → 自行处理（过度自信与过度自卑都被成本模型拉回最优）`,
  );
  // 适配层直测：病态信心流（信心与对错无关）M-ratio 崩塌
  const ledger = new MetacognitionLedger();
  const rand = lcg(20261012);
  for (let i = 0; i < 40; i += 1) ledger.note(0.3 + 0.4 * rand(), rand() < 0.5);
  const badView = ledger.view();
  ok(badView !== undefined && Number.isFinite(badView.mRatio) && badView.mRatio < view.mRatio, `病态对照：信心与对错脱钩时 M-ratio 降至 ${badView ? badView.mRatio.toFixed(3) : '—'}（信心不可信 → 求助策略退化为任务难度先验的保守口径）`);
}

// ═══════════════════ 98.0 经验重放 ═══════════════════

section('98.0 经验重放（LongTermMemory.attachExperienceReplay）');

{
  const dir = path.join(os.tmpdir(), `verify-a25-replay-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const memory = new LongTermMemory(path.join(dir, 'memory.json'));
  const rand = lcg(20261013);
  ok(memory.replayStats() === undefined && memory.sleepConsolidate([0.9, 0.3]) === undefined, '旗标关 → 重放读数缺席（零漂移）');
  memory.attachExperienceReplay({ capacity: 256, alpha: 0.6, beta: 0.4, seed: 1 });
  // 白天经验：两个任务域（code / i18n），臂 0 真值 0.9、臂 1 真值 0.3
  for (let i = 0; i < 60; i += 1) {
    const task = i % 2 === 0 ? 'code' : 'i18n';
    const arm = rand() < 0.5 ? 0 : 1;
    const reward = arm === 0 ? 0.9 : 0.3;
    memory.replayPush({ task, arm, reward, tdError: Math.abs(0.6 - reward) });
  }
  const stats = memory.replayStats();
  ok(stats !== undefined && stats.size >= 40 && stats.layers.length === 2, `旗标开 → 分层配额在位（${stats ? stats.size : '—'} 条经验 / ${stats ? stats.layers.length : '—'} 个任务域层——新域流量挤不掉旧域的存活样本）`);
  const sleep = memory.sleepConsolidate([0.9, 0.3], { rounds: 4 });
  ok(
    sleep !== undefined && sleep.samplesUsed > 0 && sleep.freshTransitions === 0,
    `睡眠固化只重放不采新（${sleep ? sleep.samplesUsed : '—'} 样本 / 新样本 0——策略价值 ${sleep ? sleep.policyValueBefore.toFixed(2) : '—'} → ${sleep ? sleep.policyValueAfter.toFixed(2) : '—'}）`,
  );
  memory.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════ 99.0 注意力经济 ═══════════════════

section('99.0 注意力经济（Sentinel.attachAttentionEconomy）');

{
  const sentinel = new Sentinel({ watchCodeChanges: false, watchErrors: false, watchPerformance: false, aggregationWindow: 0.5 }, () => {});
  const sources = [
    { id: 'model-telemetry', marginalValue: (t) => 0.8 / (t + 1) },
    { id: 'log-anomaly', marginalValue: (t) => 0.3 / (t + 1) },
    { id: 'memory-writeback', marginalValue: (t) => 0.1 / (t + 1) },
  ];
  ok(sentinel.attentionMarket(sources, 3) === undefined, '旗标关 → 信息流照常、拍卖读数缺席（零漂移）');
  sentinel.attachAttentionEconomy();
  const view = sentinel.attentionMarket(sources, 3);
  ok(
    view !== undefined && view.allocation.slots.reduce((s, v) => s + v, 0) === 3 && view.winners[0] === 'model-telemetry',
    `旗标开 → 3 槽深看出清（${view ? view.allocation.slots.join('/') : '—'}；最强源 ${view ? view.winners[0] : '—'} 占首——「该看什么」从拍脑袋到机会成本口径）`,
  );
  ok(
    view !== undefined && view.allocation.payments.length === sources.length && view.marginalPrice > 0,
    `VCG 支付向量在案（边际价格 ${view ? view.marginalPrice.toFixed(3) : '—'} = 末槽机会成本——谎报在 VCG 下无利可图）`,
  );
  ok(view !== undefined && view.concavity.concave === true, `凹性巡检通过（边际价值非增 → 贪心 = 穷举最优的定理前提成立）`);
}

// ═══════════════════ 100.0 自我边界 ═══════════════════

section('100.0 自我边界（SelfModel.attachSelfBoundary）');

{
  const collectors = {
    getEvolverStatus: () => new PolicyEvolver().getStatus(),
    getMemoryStats: () => ({ patterns: 0, semantic: 0, procedural: 0, strategies: 0, profiles: 0, feedback: 0 }),
    getGlobalStats: () => ({ totalExecutions: 0, totalSuccesses: 0, totalFailures: 0, totalTokensUsed: 0, totalCostEstimate: 0, averageQualityScore: 0, averageExecutionTime: 0 }),
    getRecentFeedback: () => [],
  };
  const selfModel = new SelfModel({ collectors, config: { persistPath: path.join(os.tmpdir(), `verify-a25-self-${process.pid}-none.json`) } });
  // 内核工厂：自致通道（agencyProb 0.8）+ 伪相关通道 + 外部通道三合一
  const env = simulateEnv({ seed: 20261014, delay: 2, agencyProb: 0.8, spuriousCorr: 0.7, length: 600 });
  ok(selfModel.agencyAudit(env.actions, env.signals) === undefined && selfModel.identityAudit([0.1], [0.2]) === undefined, '旗标关 → 归因/身份读数缺席（零漂移）');
  selfModel.attachSelfBoundary();
  const agency = selfModel.agencyAudit(env.actions, env.signals, { seed: 20261015 });
  ok(
    agency !== undefined && agency.detection.selfCaused[0] === true && agency.detection.selfCaused[2] === false,
    `旗标开 → 归因边界生效（自致通道 ${agency && agency.detection.selfCaused[0] ? '✓' : '✗'} / 外部通道 ${agency && agency.detection.selfCaused[2] ? '误判' : '✓ 正确剔除'}，z=${agency ? agency.detection.score.toFixed(1) : '—'}——非自致通道的波动不揽功，防把环境红利记成自我进步）`,
  );
  const stable = selfModel.identityAudit([0.1, 0.2, 0.3, 0.4], [0.105, 0.198, 0.305, 0.396]);
  const broken = selfModel.identityAudit([0.1, 0.2, 0.3, 0.4], [3.1, -2.2, 5.3, 0.04]);
  ok(
    stable !== undefined && broken !== undefined && stable.breakAlarm === false && broken.breakAlarm === true,
    `身份断点监控（渐进微调 score=${stable ? stable.score.toFixed(3) : '—'} 无警报 / 突变 score=${broken ? broken.score.toFixed(3) : '—'} breakAlarm——连续性崩塌 = 不是学习而是身份突变，联动金丝雀回滚）`,
  );
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— 第二轮创世纪 76.0→100.0 全链路接线零漂移验证成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
