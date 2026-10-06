/**
 * verify-r4-pipeline.mjs — 第四轮模块域 R4-A17：插件主链路（index.ts +
 * engines-frontier 适配层）「激活接线 + 主链路深化」验证
 *
 * 两大任务七组断言（全部真实引擎构造路径，全程离线——LLM fetchImpl 指向
 * 注入 stub 不发真实请求；仅 dashboard 段用 loopback 本地端口）：
 *
 *   ⓪ 静态清单与旗标总览：MODULE_FLAGS 恰 16 旗标（名字唯一 / wave∈{3,4} /
 *      module+entry 在案）；moduleFlagOverview 缺省全关（enabled=0）、仅显式
 *      === true 才开、全开 = 16；与 KERNEL_FLAGS（50）互不串扰。
 *   ① 激活接线·构造配置半边（零漂移）：五个构造片段在全关旗标下返回 {}
 *      （展开即无操作——构造参数逐位不变）；真实构造对照（Sentinel 同输入
 *      两实例批次逐位一致 / CryptoEngine tieredStatus 缺席 / MetaCognitive
 *      Controller stability 面板缺席 / LLMClient 纯 FIFO）；旗标开后：
 *      sentinel 批次携带 loadState+intensityPerSec 键 + stormBudgetView 定义、
 *      crypto tieredStatus 三级 + 分级加解密闭环、meta 稳定环面板 + 死区行为
 *      差分、symbiosis monetaryView 读数、LLM 高优先先出（dispatch 序列差分）。
 *   ② 激活接线·挂载半边（激活矩阵）：attachPostConstructModuleUpgrades
 *      全关 → 返回 [] 且九类引擎读数全部 undefined；16 旗标全开 → 15 挂载
 *      名返回 + 每旗标逐一差分证据（hysteresisView / decideJointly 抛错→
 *      工作、healthView、admissionView+prewarmSuggestions、执行报告
 *      adaptiveParallelism 在场、失败域隔离后 model-b 上位、tieredStats+
 *      arbitrateConflicts、startABBranch 流量比 0.3（旗标注入）vs 0.2（懒
 *      缺省）、observationVersions、openDelivery undefined→可达、
 *      observeUsage recorded:false→true + forecastQuota、recordTrendPoint
 *      undefined→视图）。
 *   ③ 激活接线·dashboard 告警源：attachDashboard 第三参缺席 →
 *      /api/alarm-feed available:false（零漂移空态）；注入 getAlarms →
 *      available:true + 全字段（旗标在 index.ts 的接线面）。
 *   ④ 主链路深化 1（跨步骤缓存）：PipelineStepCache——真实 sha256 指纹直算
 *      vs 缓存路径逐位一致（hits/misses 记账）；非 pure 条目 bump 后失效
 *      重算、pure 条目跨代仍命中；LRU 容量淘汰；stats 七字段。
 *   ⑤ 主链路深化 2（降级阶梯）：runDegradationLadder——注入异常流 L1 throw→
 *      L2 throw→L3 兜底成功（attempts 按序 [main, simplified, fallback]、
 *      usedRung=3、结果与 L3 直呼逐位一致）；L1 成功无降级；L1 抛 L2 接住；
 *      全抛聚合上抛；async 级支持；空阶梯防御；降级入 PipelineAuditTrail。
 *   ⑥ 主链路深化 3·加分（步骤预取）：StepPrefetcher——代际一致命中（值与
 *      直算逐位一致、recompute spy 零调用）；bump 后失效直算（spy 被调）；
 *      未发起键诚实 miss；虚拟事件循环时延对照：串行 62 单位 vs 预取 50
 *      单位（检索 12 完全藏进执行等待 50）。
 *
 * 确定性：合成时钟 / 注入 fetchImpl / 无随机依赖；无真实模型请求。
 *
 * 运行：npm run build && node scripts/verify-r4-pipeline.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  // 激活接线面
  MODULE_FLAGS,
  moduleFlagOverview,
  KERNEL_FLAGS,
  kernelFlagOverview,
  attachPostConstructModuleUpgrades,
  sentinelModuleUpgradeConfig,
  clientModuleUpgradeConfig,
  cryptoModuleUpgradeConfig,
  symbiosisMonetaryUpgradeConfig,
  metaStabilityUpgradeConfig,
  // 真实引擎（构造路径与 index.ts apply() 同款）
  Sentinel,
  DecisionEngine,
  ModelScheduler,
  TaskExecutor,
  LongTermMemory,
  PolicyEvolver,
  WorldModel,
  SymbiosisBridge,
  TenantManager,
  BenchmarkEngine,
  CryptoEngine,
  LLMClient,
  SelfModel,
  MetaCognitiveController,
  ProgressBroadcaster,
  attachDashboard,
  // 深化三件套
  PipelineStepCache,
  runDegradationLadder,
  StepPrefetcher,
  PipelineAuditTrail,
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
function near(a, b, tol = 1e-9, label) {
  const hit = Math.abs(a - b) <= tol;
  ok(hit, `${label}（实际 ${typeof a === 'number' ? a.toFixed(4) : a}，期望 ${b} ± ${tol}）`);
}
function section(title) {
  console.log(`\n■ ${title}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 临时工作目录（引擎落盘隔离） */
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-pipeline-'));
function tmp(name) {
  return path.join(workRoot, name);
}

/** 合成时钟（可推进） */
function syntheticClock(start = 1_700_000_000_000) {
  const state = { now: start };
  return { state, clock: () => state.now };
}

const T0 = 1_700_000_000_000;
const CYCLES = 400;

let sigSeq = 0;
const mkSignal = (type, description, urgency = 0.6) => {
  sigSeq += 1;
  return { id: `sig-${type}-${sigSeq}-${Math.abs(hashStr(description)) % 1000}`, type, description, payload: {}, source: 'test', urgency, receivedAt: 0, occurrences: 1 };
};
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** 16 旗标全开配置（旗标选项与 index.ts 缺省同款；个别带差分用数值） */
const ALL_ON = {
  sentinelAdaptive: { enabled: true },
  decisionHysteresisJoint: { enabled: true, minDwellMs: 0 },
  schedulerHealthRouting: { enabled: true },
  schedulerColdStart: { enabled: true },
  executorAdaptiveParallelism: { enabled: true },
  executorFailureDomains: { enabled: true, failureThreshold: 2, cooldownMs: 1_000 },
  memoryTieredArbitration: { enabled: true },
  metaStabilityLoop: { enabled: true },
  policyABBranching: { enabled: true, challengerTraffic: 0.3 },
  worldObservationFusion: { enabled: true },
  symbiosisEconomy: { enabled: true },
  cryptoTieredKeys: { enabled: true },
  tenantQuotaForecast: { enabled: true },
  clientPriorityQueue: { enabled: true },
  benchmarkTrendTracker: { enabled: true },
  dashboardAlarmSources: { enabled: true },
};

// ═══════════════════ ⓪ 静态清单与旗标总览 ═══════════════════

section('⓪ 静态清单：MODULE_FLAGS 16 旗标 / 总览缺省全关 / 与 kernels 不串扰');

ok(Array.isArray(MODULE_FLAGS) && MODULE_FLAGS.length === 16, `MODULE_FLAGS 恰 16 旗标（实际 ${MODULE_FLAGS.length}）`);
ok(new Set(MODULE_FLAGS.map((f) => f.name)).size === 16, '旗标名唯一');
ok(MODULE_FLAGS.every((f) => f.wave === 3 || f.wave === 4), '每旗标 wave ∈ {3,4}（第三/四轮溯源）');
ok(MODULE_FLAGS.filter((f) => f.wave === 3).length === 3 && MODULE_FLAGS.filter((f) => f.wave === 4).length === 13, '轮次分布：第三轮 3 + 第四轮 13');
ok(MODULE_FLAGS.every((f) => typeof f.module === 'string' && f.module.length > 0 && typeof f.entry === 'string' && f.entry.length > 0), '每旗标 module 与挂载面 entry 在案');
{
  const off = moduleFlagOverview();
  ok(off.total === 16 && off.enabled === 0 && off.disabled === 16, '总览缺省全关（enabled=0 / disabled=16）');
  ok(off.flags.every((f) => f.enabled === false), '总览 flags 逐项 enabled=false');
  const truthyNotTrue = moduleFlagOverview({ sentinelAdaptive: { enabled: 1 }, decisionHysteresisJoint: { enabled: 'true' } });
  ok(truthyNotTrue.enabled === 0, '非严格 true（1 / "true"）不误开（严格布尔判据）');
  const on = moduleFlagOverview(ALL_ON);
  ok(on.enabled === 16 && on.disabled === 0, '全开 = 16');
  const half = moduleFlagOverview({ sentinelAdaptive: { enabled: true }, benchmarkTrendTracker: { enabled: true } });
  ok(half.enabled === 2 && half.flags.find((f) => f.name === 'sentinelAdaptive').enabled === true, '部分开启计数正确');
}
ok(KERNEL_FLAGS.length === 50 && kernelFlagOverview().enabled === 0, 'kernels 命名空间不受影响（50 旗标照旧、缺省全关）');

// ═══════════════════ ① 构造配置半边：零漂移 + 生效差分 ═══════════════════

section('① 激活接线·构造配置半边：全关片段 {}（构造逐位不变）→ 开后注入生效');

{
  const ALL_OFF = {};
  ok(JSON.stringify(sentinelModuleUpgradeConfig(ALL_OFF)) === '{}', 'sentinel 片段全关 = {}（展开零注入）');
  ok(JSON.stringify(clientModuleUpgradeConfig(ALL_OFF)) === '{}', 'client 片段全关 = {}');
  ok(JSON.stringify(cryptoModuleUpgradeConfig(ALL_OFF)) === '{}', 'crypto 片段全关 = {}');
  ok(JSON.stringify(symbiosisMonetaryUpgradeConfig(ALL_OFF)) === '{}', 'symbiosis 片段全关 = {}');
  ok(JSON.stringify(metaStabilityUpgradeConfig(ALL_OFF)) === '{}', 'meta 片段全关 = {}');
  ok(JSON.stringify(sentinelModuleUpgradeConfig({ clientPriorityQueue: { enabled: true } })) === '{}', '交叉旗标不串扰（开 client 不注入 sentinel 片段）');
  ok(sentinelModuleUpgradeConfig(ALL_ON).adaptiveWindow !== undefined && sentinelModuleUpgradeConfig(ALL_ON).stormBudget !== undefined, '旗标开：sentinel 片段携带 adaptiveWindow + stormBudget');
  ok(cryptoModuleUpgradeConfig(ALL_ON).tiered.tiers.high.algorithm === 'aes-256-gcm', '旗标开：crypto 片段三级密钥（high 级强制认证加密）');

  // —— Sentinel 真实构造对照（index.ts 构造点同款：cfg 展开片段）——
  const baseSentinel = {
    watchCodeChanges: false,
    watchErrors: false,
    watchPerformance: false,
    aggregationWindow: 60,
    maxBatchSize: 1_000_000,
  };
  const deliver = (config) => {
    let delivered = null;
    const s = new Sentinel(config, (batch) => { delivered = batch; });
    s.ingest({ type: 'deploy-check', description: '部署检查失败', source: 'ci', urgency: 0.8 });
    s.ingest({ type: 'deploy-check', description: '部署检查失败', source: 'ci', urgency: 0.8 });
    s.flush();
    return { batch: delivered, sentinel: s };
  };
  const offA = deliver({ ...baseSentinel, clock: syntheticClock().clock, ...sentinelModuleUpgradeConfig(ALL_OFF) });
  const offB = deliver({ ...baseSentinel, clock: syntheticClock().clock });
  // 信号 id 由哨兵内部全局序号生成（两实例必然不同）——归一化后逐位对照
  const normalize = (batch) => batch.signals.map((s) => ({ ...s, id: '<id>' }));
  ok(JSON.stringify(normalize(offA.batch)) === JSON.stringify(normalize(offB.batch)), '全关片段展开 = 不展开：哨兵交付逐位一致（零漂移对照）');
  ok(offA.batch.signals.length === 1 && offA.batch.signals[0].occurrences === 2 && !('loadState' in offA.sentinel.getStatus()), '旧行为：同型信号去重合并（occurrences=2），状态读数无 loadState 键');
  {
    const probe = new Sentinel({ ...baseSentinel, clock: syntheticClock().clock }, () => {});
    ok(probe.stormBudgetView() === undefined, '对照：未注入 stormBudget → stormBudgetView undefined');
  }

  const onSentinel = new Sentinel({ ...baseSentinel, clock: syntheticClock().clock, ...sentinelModuleUpgradeConfig(ALL_ON) }, () => {});
  onSentinel.ingest({ type: 'deploy-check', description: '部署检查失败', source: 'ci', urgency: 0.8, receivedAt: T0 });
  onSentinel.ingest({ type: 'deploy-check', description: '部署检查失败', source: 'ci', urgency: 0.8, receivedAt: T0 + 300 });
  onSentinel.ingest({ type: 'deploy-check', description: '部署检查失败', source: 'ci', urgency: 0.8, receivedAt: T0 + 600 });
  onSentinel.flush();
  ok(onSentinel.getStatus().loadState !== undefined && onSentinel.getStatus().intensityPerSec !== undefined, '旗标开：自适应窗口 v2 生效（状态读数携带负载三态 + 滑动强度键）');
  ok(onSentinel.stormBudgetView() !== undefined && typeof onSentinel.stormBudgetView().thresholdPerSec === 'number', '旗标开：风暴预算读数定义（stormBudgetView 非空）');

  // —— CryptoEngine 构造对照 ——
  const baseCrypto = { enabled: true, masterKey: CryptoEngine.generateKey(), algorithm: 'aes-256-gcm', sensitiveFields: ['apiKey'], fullFileEncryption: false };
  const cryptoOff = new CryptoEngine({ ...baseCrypto, ...cryptoModuleUpgradeConfig(ALL_OFF) });
  ok(cryptoOff.tieredStatus() === undefined, 'crypto 片段全关：tieredStatus undefined（密钥分级缺席）');
  let offEncryptThrew = false;
  try {
    cryptoOff.encryptTiered('x', 'low');
  } catch {
    offEncryptThrew = true;
  }
  ok(offEncryptThrew, '对照：未分级引擎 encryptTiered 结构化拒绝（CryptoError）');
  const cryptoOn = new CryptoEngine({ ...baseCrypto, ...cryptoModuleUpgradeConfig(ALL_ON) });
  const tiers = cryptoOn.tieredStatus();
  ok(Array.isArray(tiers) && tiers.length === 3 && ['low', 'medium', 'high'].every((t) => tiers.some((x) => x.tier === t)), '旗标开：三级密钥在案（low/medium/high）');
  const enc = cryptoOn.encryptTiered('secret-payload', 'high');
  ok(enc.__tiered === true && enc.tier === 'high', '旗标开：分级加密可用（high 级载荷自描述）');
  ok(cryptoOn.decryptTiered(enc) === 'secret-payload', '旗标开：分级解密闭环（密文 → 原文逐位还原）');

  // —— MetaCognitiveController 构造对照（r4-meta 同款迷你 harness）——
  const fb = (id, taskType, outcome, at) => ({ id, timestamp: at, signalType: taskType, signalDescription: `${taskType} 任务`, decision: 'auto', outcome, outcomeReason: 'verify' });
  const makeState = () => ({
    feedback: [fb('g1', 'code-generation', 'good', T0), fb('g2', 'code-generation', 'excellent', T0 + 1)],
    memoryCounts: { patterns: 12, semantic: 5, procedural: 12, strategies: 8, profiles: 2, feedback: 40 },
    globalStats: { totalExecutions: 40, totalSuccesses: 30, totalFailures: 10, totalTokensUsed: 120_000, totalCostEstimate: 0.5, averageQualityScore: 0.78, averageExecutionTime: 1500 },
    distillation: { pendingSinceLastDistillation: 0 },
    evolverStatus: {
      currentPolicy: { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', createdAt: T0 },
      deployedHistory: [{ id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 }],
      population: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      sigmaScale: 0.8,
      canary: undefined,
      totalCandidatesEvaluated: 24,
      totalCycles: 8,
      lastCycle: undefined,
    },
  });
  const collectorsOf = (state) => ({
    getEvolverStatus: () => state.evolverStatus,
    getMemoryStats: () => state.memoryCounts,
    getGlobalStats: () => state.globalStats,
    getDistillationProgress: () => state.distillation,
    getRecentFeedback: (limit) => state.feedback.slice(-limit),
  });
  const simKnob = (store, id = 'sim.gain') => ({ id, label: id, category: 'evolver', min: 0.2, max: 1.0, step: 0.1, integer: false, read: () => store.value, write: (v) => { store.value = v; }, judgeMetric: 'discoveryRate', higherIsBetter: true });
  const setMetric = (state, value) => {
    const dep = Math.max(1, Math.round(value * CYCLES));
    state.evolverStatus = {
      ...state.evolverStatus,
      totalCycles: CYCLES,
      deployedHistory: [
        { id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 },
        ...Array.from({ length: dep }, (_, i) => ({ id: `p-${i}`, version: i + 2, generation: 1, origin: 'mutation', gain: 0.01, deployedAt: T0 + (i + 1) * 60_000 })),
      ],
    };
  };
  const buildController = (flags) => {
    const state = makeState();
    const store = { value: 0.5 };
    const controller = new MetaCognitiveController({
      selfModel: new SelfModel({ collectors: collectorsOf(state), config: { clock: () => T0 } }),
      knobs: [simKnob(store)],
      config: {
        clock: () => T0,
        observationReports: 2,
        degradationTolerance: 0.02,
        maxStepMultiplier: 1,
        breakerThreshold: 50,
        globalBreakerThreshold: 50,
        homeostasisBands: { discoveryRate: { min: 0.4, max: 0.6 } },
        ...metaStabilityUpgradeConfig(flags), // ← index.ts 构造点同款展开
      },
    });
    return { state, store, controller };
  };
  const metaOff = buildController(ALL_OFF);
  ok(metaOff.controller.getState().stability === undefined, 'meta 片段全关：稳定环面板 undefined');
  const metaOn = buildController(ALL_ON);
  ok(metaOn.controller.getState().stability !== undefined && typeof metaOn.controller.getState().stability.deadbandSkips === 'number', '旗标开：稳定环面板定义（getState().stability 非空）');
  ok(metaStabilityUpgradeConfig(ALL_ON).stabilityLoop !== undefined && Object.keys(metaStabilityUpgradeConfig(ALL_ON).stabilityLoop).length >= 0, '旗标开：stabilityLoop 配置片段注入构造（死区稳定环参数定格）');
  ok(metaOff.controller.getState().knobs.length === 1 && metaOn.controller.getState().knobs.length === 1, '对照：注入不改变旋钮面（只补 stabilityLoop 键）');

  // —— SymbiosisBridge 构造对照（货币治理半边）——
  const gate = { checkGate: () => ({ allowed: true }) };
  const bridgeOff = new SymbiosisBridge({ runtime: { ...symbiosisMonetaryUpgradeConfig(ALL_OFF) } }, gate);
  ok(bridgeOff.runtime.monetaryView() === undefined, 'symbiosis 片段全关：monetaryView undefined（央行不干预）');
  const bridgeOn = new SymbiosisBridge({ runtime: { ...symbiosisMonetaryUpgradeConfig(ALL_ON) } }, gate);
  const monetary = bridgeOn.runtime.monetaryView();
  ok(monetary !== undefined && monetary.target === 200 && typeof monetary.ratio === 'number', '旗标开：流通量目标带货币政策器生效（target=200，ratio 在案）');

  // —— LLMClient 优先级队列（注入 fetchImpl，全程离线）——
  async function queueDifferential(priorityOn) {
    const dispatches = [];
    let calls = 0;
    let release;
    const firstGate = new Promise((r) => { release = r; });
    const fetchImpl = async (url, init) => {
      calls += 1;
      const marker = JSON.parse(init.body).messages?.[0]?.content ?? '?';
      dispatches.push(marker);
      if (calls === 1) await firstGate; // 首个调用占满唯一槽位直到放行
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `ok-${marker}` } }], usage: { total_tokens: 3 }, model: 'stub' }) };
    };
    const base = { fetchImpl, timeout: 10_000, maxRetries: 0 };
    const llm = new LLMClient({ ...base, ...clientModuleUpgradeConfig(priorityOn ? ALL_ON : ALL_OFF) });
    llm.registerModel({ id: 'm', endpoint: 'http://mock.local', apiKey: 'k', maxConcurrency: 1 });
    const first = llm.chat('m', [{ role: 'user', content: 'first' }]);
    for (let i = 0; i < 200 && dispatches.length === 0; i += 1) await Promise.resolve(); // 等首个真正占槽
    const low = llm.chat('m', [{ role: 'user', content: 'low' }]); // 先入队，优先级 0（缺省）
    const high = llm.chat('m', [{ role: 'user', content: 'high' }], { priority: 9 }); // 后入队，优先级 9
    for (let i = 0; i < 50; i += 1) await Promise.resolve(); // 等两者都完成入队
    release(); // 放行首个 → 槽位释放
    await Promise.all([first, low, high]);
    llm.dispose();
    return dispatches;
  }
  const fifoOrder = await queueDifferential(false);
  ok(JSON.stringify(fifoOrder) === JSON.stringify(['first', 'low', 'high']), `片段全关：纯 FIFO 派发序（${fifoOrder.join(' → ')}，零漂移）`);
  const prioOrder = await queueDifferential(true);
  ok(JSON.stringify(prioOrder) === JSON.stringify(['first', 'high', 'low']), `旗标开：高优先先出（${prioOrder.join(' → ')}——priority 9 插队）`);
}

// ═══════════════════ ② 激活矩阵：attachPostConstructModuleUpgrades ═══════════════════

section('② 激活矩阵：挂载半边（全关 = 零挂载零读数；全开 = 逐旗标差分证据）');

function makeStubMemory() {
  return { getBayesianEstimate: () => undefined };
}
function makeLlm(modelIds, taskTypes, scores) {
  const llm = new LLMClient();
  const taskScores = {};
  for (const t of taskTypes) taskScores[t] = 0.55;
  for (const id of modelIds) llm.registerModel({ id, endpoint: 'http://mock.local', initialCapabilities: { taskScores: scores?.[id] ?? taskScores } });
  return llm;
}
function makeExecutor({ models = ['model-a'], types = ['exec'], scores, runner }) {
  const llm = makeLlm(models, types, scores);
  return new TaskExecutor({
    config: { qualityThreshold: 0.7, maxRetries: 0, globalTimeout: 10_000_000, nodeTimeout: 30_000, enableProgress: false, verbose: false },
    llm,
    modelScheduler: new ModelScheduler({ llm, memory: makeStubMemory() }),
    nodeRunner: runner,
  });
}

{
  // —— 全关：零挂载 + 九类读数缺席 ——
  const decisionEngine = new DecisionEngine();
  const llm = makeLlm(['model-a'], ['exec']);
  const modelScheduler = new ModelScheduler({ llm, memory: makeStubMemory() });
  const taskExecutor = new TaskExecutor({ config: { qualityThreshold: 0.7, maxRetries: 0, globalTimeout: 10_000_000, nodeTimeout: 30_000, enableProgress: false, verbose: false }, llm, modelScheduler, nodeRunner: async () => ({ output: 'x', quality: 0.9, tokensUsed: 1 }) });
  const memory = new LongTermMemory(tmp('matrix-memory-off.json'));
  const policyEvolver = new PolicyEvolver();
  const worldModel = new WorldModel();
  const symbiosisBridge = new SymbiosisBridge({}, { checkGate: () => ({ allowed: true }) });
  const tenantManager = new TenantManager(tmp('tenants-off'));
  const benchmark = new BenchmarkEngine(tmp('bench-off'));
  const targets = { decisionEngine, modelScheduler, taskExecutor, memory, policyEvolver, worldModel, symbiosisBridge, tenantManager, benchmark };

  const attachedOff = attachPostConstructModuleUpgrades(targets, {});
  ok(JSON.stringify(attachedOff) === '[]', '全关：挂载清单为空（零 attach）');
  ok(
    decisionEngine.hysteresisView() === undefined &&
      modelScheduler.healthView() === undefined &&
      modelScheduler.admissionView() === undefined &&
      modelScheduler.prewarmSuggestions() === undefined &&
      memory.tieredStats() === undefined &&
      memory.arbitrateConflicts() === undefined &&
      worldModel.observationVersions() === undefined &&
      symbiosisBridge.openDelivery('buyer', 'asset-1') === undefined &&
      benchmark.recordTrendPoint('m', 0.5) === undefined,
    '全关：九类引擎读数全部 undefined（零漂移总检）',
  );
  let jointThrew = false;
  try {
    await decisionEngine.decideJointly([mkSignal('t', 'd')], new Map());
  } catch {
    jointThrew = true;
  }
  ok(jointThrew, '全关：decideJointly 抛错（批量联合未挂载）');

  // —— 全开前先固化「对照」读数（全关口径），再挂载 ——
  const observeUsageOff = tenantManager.observeUsage('t1', 'tokens', 10);
  const trendPointOff = benchmark.recordTrendPoint('m', 0.5);

  // —— 全开：激活矩阵逐旗标差分 ——
  const attachedOn = attachPostConstructModuleUpgrades(targets, ALL_ON);
  ok(attachedOn.length === 11, `全开：11 挂载名返回（attach 面 11 旗标 + 构造面 4.5 + dashboard 面 1 = 16；实际 ${attachedOn.length}）`);
  ok(new Set(attachedOn).size === 11, '挂载名无重复');

  // decision：滞后 + 批量联合
  ok(decisionEngine.hysteresisView() !== undefined, 'decisionHysteresisJoint：hysteresisView 定义（滞后状态机在案）');
  const joint = await decisionEngine.decideJointly([mkSignal('joint', '任务甲'), mkSignal('joint', '任务乙')], new Map());
  ok(joint !== undefined && joint.decisions instanceof Map && joint.decisions.size === 2, 'decisionHysteresisJoint：decideJointly 工作（批量联合决策返回双成员）');

  // scheduler：健康路由 + 冷启动准入/预热
  ok(Array.isArray(modelScheduler.healthView()), 'schedulerHealthRouting：healthView() 定义（未挂载恒 undefined——EWMA/熔断遥测面在案）');
  ok(Array.isArray(modelScheduler.admissionView()), 'schedulerColdStart：admissionView() 定义（准入协议在案）');
  ok(Array.isArray(modelScheduler.prewarmSuggestions()), 'schedulerColdStart：prewarmSuggestions() 定义（周期预热在案）');

  // executor：并行度自适应（执行报告账单差分）
  {
    const exec = makeExecutor({
      models: ['model-a'],
      types: ['exec'],
      runner: async (p) => ({ output: `out-${p.node.id}`, quality: 0.95, tokensUsed: 5 }),
    });
    const plan = { objective: 'o', nodes: [
      { id: 'n1', description: 'a', type: 'exec', dependsOn: [] },
      { id: 'n2', description: 'b', type: 'exec', dependsOn: [] },
    ], parallelismStrategy: 'layered', source: 'fallback' };
    const reportOff = await exec.executePlan(mkSignal('exec', '双节点'), plan);
    ok(reportOff.adaptiveParallelism === undefined, '对照（未挂载）：执行报告无 adaptiveParallelism 键');
    attachPostConstructModuleUpgrades({ taskExecutor: exec }, ALL_ON);
    const reportOn = await exec.executePlan(mkSignal('exec', '双节点'), plan);
    ok(reportOn.adaptiveParallelism !== undefined && typeof reportOn.adaptiveParallelism.settledWidth === 'number' && Array.isArray(reportOn.adaptiveParallelism.widthHistory), 'executorAdaptiveParallelism：挂载后执行报告携带 adaptiveParallelism 账单（settledWidth/widthHistory）');
  }

  // executor：失败域隔离（r4-executor 同款环境：model-a::tx 连续网络故障 2 次 → 簇熔断 → model-b 接管）
  {
    const { NetworkError, VirtualClock } = await import('../dist/index.mjs');
    const clock = new VirtualClock(0);
    const modelUsed = (report) => Object.fromEntries(report.nodeResults.map((r) => [r.nodeId, r.modelId]));
    const fdPlan = {
      objective: 'fd',
      nodes: ['x1', 'x2', 'x3'].map((id) => ({ id, description: id, type: 'tx', dependsOn: [], modelId: 'model-a' })),
      parallelismStrategy: 'layered',
      source: 'fallback',
    };
    // 单飞串行（maxInFlightNodes 1）——失败按序计入失败域
    const mkEnvRunner = (state) => async (p) => {
      if (p.modelId === 'model-a') {
        state.calls += 1;
        if (state.calls <= 2) throw new NetworkError('mock: model-a 网络故障');
      }
      clock.advance(10);
      return { output: `ok-${p.node.id}`, quality: 0.95, tokensUsed: 5, completedAt: clock.now() };
    };
    const fdExecutor = (runner) => {
      const llm = makeLlm(['model-a', 'model-b'], ['tx']);
      return new TaskExecutor({
        config: { qualityThreshold: 0.7, maxRetries: 0, globalTimeout: 10_000_000, nodeTimeout: 30_000, enableProgress: false, verbose: false, maxInFlightNodes: 1, circuitFailureThreshold: 5, circuitCooldownMs: 600_000 },
        llm,
        modelScheduler: new ModelScheduler({ llm, memory: makeStubMemory() }),
        nodeRunner: runner,
      });
    };
    // 对照（未挂载）：模型级熔断阈 5 未达 → 三个节点全在 model-a（x3 恢复成功）
    const execOff = fdExecutor(mkEnvRunner({ calls: 0 }));
    execOff.attachClock(clock);
    const offRep = await execOff.executePlan(mkSignal('fd', '对照'), fdPlan);
    const offModelOf = modelUsed(offRep);
    ok(offModelOf.x3 === 'model-a', `对照（未挂载）：无失败域隔离——x3 仍在 model-a（连败 2 未达模型级熔断阈 5）`);
    // 旗标开：failureThreshold 2 → x2 后簇熔断 → x3 重定向 model-b
    const execOn = fdExecutor(mkEnvRunner({ calls: 0 }));
    execOn.attachClock(clock);
    attachPostConstructModuleUpgrades({ taskExecutor: execOn }, ALL_ON);
    const onRep = await execOn.executePlan(mkSignal('fd', '旗标开'), fdPlan);
    const onModelOf = modelUsed(onRep);
    ok(onModelOf.x3 === 'model-b', `executorFailureDomains：model-a::tx 连败 2 次簇熔断 → x3 重定向健康域（x3=${onModelOf.x3}）`);
    const snap = execOn.failureDomainSnapshot();
    ok(snap['model-a::tx'] !== undefined && snap['model-a::tx'].state === 'open', 'executorFailureDomains：失败域快照 model-a::tx open（单簇隔离，其余簇零记录）');
    ok(onRep.nodeResults.find((r) => r.nodeId === 'x3').success === true, 'executorFailureDomains：接管节点执行成功（链路不中断）');
  }

  // memory：分层 + 仲裁
  ok(memory.tieredStats() !== undefined && typeof memory.tieredStats().hot === 'number', 'memoryTieredArbitration：tieredStats() 非空（热/温/冷三级计数在案）');
  ok(memory.arbitrateConflicts() !== undefined, 'memoryTieredArbitration：arbitrateConflicts() 定义（三因子仲裁在案）');

  // policy：AB 分支（旗标注入的流量比 0.3 vs 懒缺省 0.2 差分）
  {
    const lazy = new PolicyEvolver();
    const lazyReport = lazy.startABBranch();
    const configured = new PolicyEvolver();
    attachPostConstructModuleUpgrades({ policyEvolver: configured }, ALL_ON);
    const configuredReport = configured.startABBranch();
    near(configuredReport.trafficRatio, 0.3, 1e-9, 'policyABBranching：旗标注入 challengerTraffic=0.3 生效');
    near(lazyReport.trafficRatio, 0.2, 1e-9, '对照：未挂载懒缺省流量比 0.2（差分证明注入面）');
  }

  // world：观察信念融合
  const written = worldModel.writeObservation('deploy.status', 'failed', 'ci', { timestamp: T0 });
  ok(written !== undefined && written.version >= 1, 'worldObservationFusion：writeObservation 返回裁决（未挂载恒 undefined）');
  ok(Array.isArray(worldModel.observationVersions()) && worldModel.observationVersions().length >= 1, 'worldObservationFusion：observationVersions() 非空（快照环在案）');

  // symbiosis：条件结算
  const delivery = symbiosisBridge.openDelivery('buyer-1', 'asset-none');
  ok(delivery !== undefined && delivery.ok === false && typeof delivery.error === 'string', 'symbiosisEconomy：openDelivery 可达（未挂载恒 undefined；资产不在市按 error 字段诚实返回）');

  // tenant：配额预测（对照读数已在全开挂载前固化）
  ok(observeUsageOff.recorded === false, '对照（未配置）：observeUsage 拒绝记账（recorded=false）');
  const tenantManagerOn = new TenantManager(tmp('tenants-on'));
  attachPostConstructModuleUpgrades({ tenantManager: tenantManagerOn }, ALL_ON);
  ok(tenantManagerOn.observeUsage('t1', 'tokens', 10, T0).recorded === true, 'tenantQuotaForecast：observeUsage 开始记账（recorded=true）');
  tenantManagerOn.observeUsage('t1', 'tokens', 12, T0 + 120_000);
  const forecast = tenantManagerOn.forecastQuota('t1', 'tokens');
  ok(forecast !== undefined && typeof forecast.samples === 'number' && forecast.samples >= 2, 'tenantQuotaForecast：forecastQuota 产出外推读数（samples ≥ 2）');

  // benchmark：趋势追踪（对照读数已在全开挂载前固化）
  ok(trendPointOff === undefined, '对照（未挂载）：recordTrendPoint 恒 undefined');
  const view = benchmark.recordTrendPoint('model-a', 0.55);
  ok(view !== undefined && view.name === 'model-a' && typeof view.slope === 'number', 'benchmarkTrendTracker：挂载后返回趋势视图（Theil–Sen 斜率在案）');
  const view2 = benchmark.recordTrendPoint('model-a', 0.48);
  ok(view2 !== undefined && view2.n === 2, 'benchmarkTrendTracker：视图滚动累计（n=2）');
}

// ═══════════════════ ③ dashboard 告警源接线面 ═══════════════════

section('③ dashboard 告警源：第三参缺席空态（零漂移）→ 注入后全字段');

{
  async function startBroadcaster() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const port = 28540 + Math.floor(Math.random() * 2000);
      const broadcaster = new ProgressBroadcaster(port);
      broadcaster.start();
      const base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 40; i += 1) {
        try {
          const res = await fetch(`${base}/api/none`);
          if (res) return { broadcaster, base };
        } catch {
          await sleep(50);
        }
      }
      broadcaster.stop();
    }
    throw new Error('无法启动 ProgressBroadcaster 测试端口');
  }
  const { broadcaster, base } = await startBroadcaster();
  try {
    // 旗标关：第三参缺席（index.ts 接线同款——dashboardAlarmSources undefined）
    const detachEmpty = attachDashboard(broadcaster, () => []);
    const empty = await (await fetch(`${base}/api/alarm-feed`)).json();
    ok(empty.available === false && String(empty.emptyState).includes('未注入'), '旗标关：/api/alarm-feed 空态（available=false——零漂移）');
    detachEmpty();

    // 旗标开：注入 getAlarms（index.ts 构造的告警源形状——总督/元认知/哨兵三源绑定）
    const ALARMS = [
      { id: 'governor-kill-switch', source: 'safety-governor', severity: 'critical', title: '安全总督 Kill Switch 已触发', timestamp: 200 },
      { id: 'meta-layer-frozen', source: 'metacognition', severity: 'warning', title: '元认知外环全局冻结', timestamp: 300 },
      { id: 'sentinel-storm-budget', source: 'sentinel', severity: 'warning', title: '全局风暴预算收紧中', timestamp: 100 },
    ];
    const detachFed = attachDashboard(broadcaster, () => [], { getAlarms: () => ALARMS });
    const fed = await (await fetch(`${base}/api/alarm-feed`)).json();
    ok(fed.available === true && fed.total === 3, '旗标开：告警流三源全字段（available=true, total=3）');
    ok(fed.counts.critical === 1 && fed.counts.warning === 2, '严重度分布聚合（critical=1 / warning=2）');
    const filtered = await (await fetch(`${base}/api/alarm-feed?source=metacognition`)).json();
    ok(filtered.shown === 1 && filtered.alarms?.[0]?.id === 'meta-layer-frozen', '来源过滤（metacognition 单条）');
    detachFed();
  } finally {
    broadcaster.stop();
  }
}

// ═══════════════════ ④ 深化 1：跨步骤缓存 ═══════════════════

section('④ 深化 1 跨步骤缓存：命中路径与直算逐位一致 / 代际失效 / LRU 淘汰');

{
  const engine = new DecisionEngine();
  const signals = [
    mkSignal('deploy-check', '部署检查失败：镜像拉取超时'),
    mkSignal('deploy-check', '部署检查失败：镜像拉取超时'), // 重复信号（延迟重审回注/同文复发口径——跨批次命中）
    mkSignal('db-alert', '数据库连接数告警'),
  ];
  // 直算口径：每次都调 decisionEngine.fingerprint（sha256 全量重算）
  const direct = signals.map((s) => engine.fingerprint(s));
  // 缓存口径：PipelineStepCache pure 记忆化（index.ts pipelineFingerprint 同款路径）
  const cache = new PipelineStepCache(64);
  const cached = signals.map((s) => {
    const key = `fp:${s.type}:${s.description}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const value = engine.fingerprint(s);
    cache.set(key, value, { pure: true });
    return value;
  });
  ok(JSON.stringify(cached) === JSON.stringify(direct), '缓存命中路径与直算逐位一致（sha256 指纹 ×3，含重复信号）');
  const stats = cache.stats();
  ok(stats.hits === 1 && stats.misses === 2 && stats.size === 2 && stats.pureEntries === 2, `命中/未命中/容量记账准确（hits=${stats.hits}, misses=${stats.misses}, size=${stats.size}）`);

  // 非 pure 条目：bump 后失效（记忆写入点口径）
  cache.set('lk:t:0.5', { layer: 'episodic' });
  ok(cache.get('lk:t:0.5') !== undefined, '非 pure 条目同代命中');
  cache.bump();
  ok(cache.get('lk:t:0.5') === undefined, 'bump 后非 pure 条目失效（反思落盘 → 代数推进 → 重算）');
  ok(cache.get('fp:deploy-check:部署检查失败：镜像拉取超时') !== undefined, 'pure 条目跨代仍命中（纯函数永不陈旧）');

  // LRU 淘汰
  const small = new PipelineStepCache(2);
  small.set('k1', 1);
  small.set('k2', 2);
  small.get('k1'); // k1 变最新 → k2 成最旧
  small.set('k3', 3); // 淘汰 k2
  const s2 = small.stats();
  ok(s2.size === 2 && s2.evictions === 1 && small.get('k1') !== undefined && small.get('k2') === undefined && small.get('k3') !== undefined, 'LRU 淘汰最旧（k2 出局、k1/k3 在册，evictions=1）');
  ok(['hits', 'misses', 'evictions', 'size', 'capacity', 'generation', 'pureEntries'].every((k) => k in s2), 'stats 七字段完整（introspect 口径）');
}

// ═══════════════════ ⑤ 深化 2：降级阶梯 ═══════════════════

section('⑤ 深化 2 降级阶梯：注入异常流按序触发 / 兜底成功 / 全抛上抛 / 入审计');

{
  // 注入异常流：主路径与简化路径全部抛错 → 兜底直通成功
  const ladder = await runDegradationLadder([
    { name: 'main', run: () => { throw new Error('检索数据库损坏'); } },
    { name: 'simplified', run: () => { throw new Error('裸检索亦不可用'); } },
    { name: 'fallback', run: () => ({ policyVersion: 'policy-baseline@v1', memoryLayer: 'none' }) },
  ]);
  ok(ladder.usedRung === 3, '降级至 L3（兜底直通）');
  ok(ladder.attempts.length === 3 && ladder.attempts[0].name === 'main' && ladder.attempts[1].name === 'simplified' && ladder.attempts[2].name === 'fallback', '尝试序列按序 [main → simplified → fallback]');
  ok(ladder.attempts[0].error === '检索数据库损坏' && ladder.attempts[1].error === '裸检索亦不可用' && ladder.attempts[2].error === undefined, '逐级异常消息入账（成功级无 error 键）');
  ok(JSON.stringify(ladder.result) === JSON.stringify({ policyVersion: 'policy-baseline@v1', memoryLayer: 'none' }), '兜底结果与 L3 直呼逐位一致');

  // 主路径成功 → 无降级
  const healthy = await runDegradationLadder([
    { name: 'main', run: () => 'primary' },
    { name: 'simplified', run: () => 'simplified' },
  ]);
  ok(healthy.usedRung === 1 && healthy.attempts.length === 1 && healthy.result === 'primary', '主路径成功：usedRung=1、单次尝试（无降级）');

  // 主路径抛 → 简化路径接住
  const mid = await runDegradationLadder([
    { name: 'main', run: () => { throw new Error('LLM 规划超时'); } },
    { name: 'simplified', run: () => 'offline-fallback' },
    { name: 'fallback', run: () => 'inline' },
  ]);
  ok(mid.usedRung === 2 && mid.result === 'offline-fallback' && mid.attempts.length === 2, '一级降级：L2 接住（L3 不再触发）');

  // 全抛 → 聚合上抛（诚实——上层走既有失败路径）
  let aggregate = null;
  try {
    await runDegradationLadder([
      { name: 'main', run: () => { throw new Error('a'); } },
      { name: 'simplified', run: () => { throw new Error('b'); } },
      { name: 'fallback', run: () => { throw new Error('c'); } },
    ]);
  } catch (err) {
    aggregate = err;
  }
  ok(aggregate !== null && aggregate.message.includes('main') && aggregate.message.includes('simplified') && aggregate.message.includes('fallback'), '全抛：聚合错误携带完整级轨迹上抛');

  // async 级支持（预取消费等异步主路径）
  const asyncLadder = await runDegradationLadder([
    { name: 'main', run: async () => { throw new Error('预取消费失败'); } },
    { name: 'simplified', run: () => 42 },
  ]);
  ok(asyncLadder.usedRung === 2 && asyncLadder.result === 42, 'async 主路径异常同样降级（run 支持 Promise）');

  // 空阶梯防御
  let emptyThrew = false;
  try {
    await runDegradationLadder([]);
  } catch {
    emptyThrew = true;
  }
  ok(emptyThrew, '空阶梯防御性抛错');

  // 降级入审计（index.ts 第 5/6 步审计口径）
  const trail = new PipelineAuditTrail({ capacity: 64 });
  trail.mark('batch-1', 5, 'degraded', { rung: 3, attempts: ladder.attempts.map((a) => `L${a.rung}:${a.name}`) });
  const entry = trail.export().find((c) => c.step === 5);
  ok(entry !== undefined && entry.outcome === 'degraded' && entry.decisions.rung === 3 && Array.isArray(entry.decisions.attempts), '降级检查点落 PipelineAuditTrail（outcome=degraded + rung + 尝试序列）');
}

// ═══════════════════ ⑥ 深化 3·加分：步骤预取（虚拟时钟时延对照） ═══════════════════

section('⑥ 深化 3 步骤预取：代际守卫消费一致 / 虚拟时钟时延 62 → 50');

{
  // —— 结果一致性：命中值与直算逐位一致，recompute 不被调用 ——
  const gen = { value: 0 };
  const prefetcher = new StepPrefetcher(() => gen.value);
  const engine = new DecisionEngine();
  const signal = mkSignal('deploy-check', '部署检查失败：镜像拉取超时');
  const directTrio = {
    fingerprint: engine.fingerprint(signal),
    strategies: ['s1', 's2'],
    lessons: ['l1'],
  };
  let recomputeCalls = 0;
  prefetcher.fire(`step5:${signal.id}`, () => ({ ...directTrio }));
  const consumed = await prefetcher.consume(`step5:${signal.id}`, () => {
    recomputeCalls += 1;
    return { ...directTrio, stale: true };
  });
  ok(consumed.hit === true && JSON.stringify(consumed.value) === JSON.stringify(directTrio), '预取命中：值与直算逐位一致（结果恒同——只降时延）');
  ok(recomputeCalls === 0, '命中路径 recompute 零调用');

  // —— 代际失效：bump 后消费 → 直算新值 ——
  prefetcher.fire('step5:sig-next', () => ({ v: 1 }));
  gen.value += 1; // 记忆写入点（反思落盘 → 代数推进）
  const consumedStale = await prefetcher.consume('step5:sig-next', () => {
    recomputeCalls += 1;
    return { v: 2 };
  });
  ok(consumedStale.hit === false && consumedStale.value.v === 2 && recomputeCalls === 1, '代际失效：bump 后消费 → 直算新值（预取不返回陈旧结果）');

  // —— 未发起的键：消费即直算（诚实 miss）——
  const cold = await prefetcher.consume('step5:not-fired', () => {
    recomputeCalls += 1;
    return { v: 3 };
  });
  ok(cold.hit === false && cold.value.v === 3 && recomputeCalls === 2, '未发起的键：消费即直算（miss 诚实）');

  // —— 批次边界清空：未消费预取作废（消费侧直算，零漂移）——
  prefetcher.fire('step5:stale-entry', () => ({ v: 9 }));
  const statsBefore = prefetcher.stats();
  prefetcher.clear();
  const afterClear = await prefetcher.consume('step5:stale-entry', () => {
    recomputeCalls += 1;
    return { v: 10 };
  });
  ok(afterClear.hit === false && afterClear.value.v === 10 && recomputeCalls === 3, '批次边界 clear()：在途预取作废 → 消费直算（防在途条目无界累积）');
  ok(statsBefore.fired >= 3 && typeof statsBefore.consumed === 'number', `预取读数完整（fired=${statsBefore.fired}, consumed=${statsBefore.consumed}, hits=${statsBefore.hits}）`);

  // —— 虚拟事件循环：串行 62 vs 预取 50 ——
  function virtualEventLoop() {
    const state = { now: 0, tasks: [], seq: 0 };
    const schedule = (units, fn) => state.tasks.push({ resumeAt: state.now + units, fn, seq: state.seq++ });
    const delay = (units) => new Promise((resolve) => schedule(units, resolve));
    const drain = async () => {
      // 推进虚拟时间直至任务清空（每次唤醒后让 continuation 注册后续 delay）
      for (let guard = 0; state.tasks.length > 0 && guard < 10_000; guard += 1) {
        state.tasks.sort((a, b) => a.resumeAt - b.resumeAt || a.seq - b.seq);
        const next = state.tasks.shift();
        state.now = Math.max(state.now, next.resumeAt);
        next.fn();
        await Promise.resolve();
        await Promise.resolve();
      }
    };
    return { state, delay, drain };
  }

  // 串行口径：执行等待 50 → 下一信号检索 12（一步等一步，总墙钟 62）
  const seqLoop = virtualEventLoop();
  const sequentialJob = (async () => {
    await seqLoop.delay(50); // 第 7 步执行等待（信号 i）
    await seqLoop.delay(12); // 第 5 步经验检索（信号 i+1——串行后置）
    return 'done';
  })();
  await seqLoop.drain();
  await sequentialJob;
  const sequentialWall = seqLoop.state.now;

  // 预取口径：执行等待 50 期间检索 12 已完成（微任务在 await 让出时执行 → 完全重叠）
  const preLoop = virtualEventLoop();
  const g2 = { value: 0 };
  const p2 = new StepPrefetcher(() => g2.value);
  const prefetchJob = (async () => {
    p2.fire('next', async () => {
      await preLoop.delay(12); // 下一信号第 5 步检索（预取——藏进等待期）
      return 'lookup-done';
    });
    await preLoop.delay(50); // 第 7 步执行等待（信号 i）
    return p2.consume('next', () => 'recomputed');
  })();
  // 先让微任务面走一轮（fire 的 compute 启动并在 now=0 挂上 12 单位延迟），
  // 再驱动虚拟时钟——检索与执行等待在虚拟时间轴上真正重叠。
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await preLoop.drain();
  const prefetchResult = await prefetchJob;
  const prefetchWall = preLoop.state.now;

  near(sequentialWall, 62, 1e-9, '串行口径虚拟墙钟 = 50 + 12 = 62');
  near(prefetchWall, 50, 1e-9, '预取口径虚拟墙钟 = 50（检索 12 完全藏进执行等待）');
  ok(prefetchResult.hit === true && prefetchResult.value === 'lookup-done', '预取口径结果与串行直算一致（hit=true，只降时延不改结果）');
  ok(prefetchWall < sequentialWall, `时延净降 ${sequentialWall - prefetchWall} 单位（62 → 50）`);
}

// ═══════════════════ 汇总 ═══════════════════

console.log(`\n${'='.repeat(72)}`);
try {
  fs.rmSync(workRoot, { recursive: true, force: true });
} catch {
  // Windows 句柄延迟释放（SQLite 映射）——清理失败不影响判定
}
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— R4-A17 主链路激活接线（16 旗标）+ 深化三件套验证成立`);
  process.exit(0);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
