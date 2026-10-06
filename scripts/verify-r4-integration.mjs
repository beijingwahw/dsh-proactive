/**
 * verify-r4-integration.mjs — 第四轮全部模块「激活与深化」集成回归（19/20 号
 * 集成代理）：跨域联合冒烟——18 个域工程师的 R4 升级在同一进程内协同工作。
 *
 * 五段联合流（全部纯数据、零网络、零真实 LLM；合成时钟 / 注入时钟）：
 *   ① 激活链路（A17）：6 个 modules.* 旗标一次 attach 到 9 类真实引擎，
 *      多模块同时激活互不干扰——每旗标逐一读数非空 + 非目标引擎读数保持
 *      undefined（零串扰）+ moduleFlagOverview 计数一致 + 激活后复读仍健康。
 *   ② 感知→决策→执行联合流：Sentinel 周期画像 + 共因爆发（R4）→ 批量联合
 *      决策（R4，strategist 10→1）→ 执行器失败域隔离 + 并行度自适应（R4）
 *      一条龙：哨兵产信号、决策合批、执行器按联合终局跑真实计划。
 *   ③ 经济-治理-遥测联合：通胀治理（R4，注入冻结时钟）+ 条件结算三路
 *      （R4）→ 账本审计链（contraction/breach 凭证一一对应）→ 遥测计数
 *      与确定性按率采样（R4，Bresenham 精确）→ Prometheus 导出可观测。
 *   ④ dashboard 告警面板 + 布局持久化纯函数：统一告警流（分色/倒序/过滤）
 *      承接 ③ 的经济事件 → 布局序列化往返恒等 + 坏输入回退默认。
 *   ⑤ Prometheus 导出 + 审计保留联合冒烟：三类指标文本逐位确定性 + 经济
 *      事件入审计账（容量/时长双门限裁剪后整链锚定校验仍 valid）。
 *
 * 运行：npm run build && node --experimental-transform-types scripts/verify-r4-integration.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  // A17 激活接线面
  attachPostConstructModuleUpgrades,
  moduleFlagOverview,
  // 感知→决策→执行
  Sentinel,
  DecisionEngine,
  TaskExecutor,
  ModelScheduler,
  LLMClient,
  NetworkError,
  VirtualClock,
  // 激活矩阵 / 联合流引擎
  LongTermMemory,
  WorldModel,
  SymbiosisBridge,
  BenchmarkEngine,
  // 经济-治理-遥测
  EnergyLedger,
  CognitiveMarket,
  SymbiosisRuntime,
  TREASURY,
  ESCROW,
  AgentBase,
  // 遥测（R4）
  MetricsRegistry,
  prometheusExposition,
  DeterministicRateSampler,
  AuditLog,
  createManualClock,
} from '../dist/index.mjs';
import {
  alarmFeedPayload,
  classifyAlarmSeverity,
  defaultDashboardLayout,
  DEFAULT_DASHBOARD_PANELS,
  normalizeDashboardLayout,
  parseDashboardLayout,
  serializeDashboardLayout,
  visibleOrderedPanels,
} from '../src/dashboard/index.ts';

// ─────────────────────────── 断言工具（仓库惯例） ───────────────────────────
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

const T0 = 1_700_000_000_000;

/** 临时工作目录（引擎落盘隔离，进程退出不必清理——系统临时区） */
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-integration-'));
const tmp = (name) => path.join(workRoot, name);

/** 可变合成时钟 */
function syntheticClock(start = T0) {
  const state = { now: start };
  return { state, clock: () => state.now };
}

/** 决策信号构造 */
let sigSeq = 0;
function mkSignal({ type = 'generic', urgency = 0.6, source = 'integration', receivedAt = T0, occurrences = 1, payload = {}, description } = {}) {
  sigSeq += 1;
  return { id: `sig-${type}-${sigSeq}`, type, description: description ?? `desc-${type}-${sigSeq}`, payload, source, urgency, receivedAt, occurrences };
}

/** LLM 桩（零真实请求）：注册模型 + 平分任务分 */
function makeLlm(modelIds, taskTypes, scores) {
  const llm = new LLMClient();
  const taskScores = {};
  for (const t of taskTypes) taskScores[t] = 0.55;
  for (const id of modelIds) llm.registerModel({ id, endpoint: 'http://mock.local', initialCapabilities: { taskScores: scores?.[id] ?? taskScores } });
  return llm;
}
const stubMemory = () => ({ getBayesianEstimate: () => undefined });

// ═══════════════════ ① 激活链路（A17）═══════════════════

section('① 激活链路：6 旗标 × 9 引擎一次挂载，多模块同时激活互不干扰');

{
  // 6 个 modules.* 旗标（attach 面）：决策联合 / 执行器并行度 / 执行器失败域 /
  // 世界观察融合 / 共生经济 / 基准趋势——跨 6 个模块域同时开。
  const FLAGS = {
    decisionHysteresisJoint: { enabled: true, minDwellMs: 0 },
    executorAdaptiveParallelism: { enabled: true },
    executorFailureDomains: { enabled: true, failureThreshold: 2, cooldownMs: 600_000 },
    worldObservationFusion: { enabled: true },
    symbiosisEconomy: { enabled: true, targetCirculating: 8_000, bandTolerance: 0.05 },
    benchmarkTrendTracker: { enabled: true, windowSize: 20, alpha: 0.05 },
  };

  // 9 类真实引擎（构造路径与 index.ts apply() 同款）
  const llm = makeLlm(['model-a'], ['exec']);
  const decisionEngine = new DecisionEngine();
  const modelScheduler = new ModelScheduler({ llm, memory: stubMemory() });
  const taskExecutor = new TaskExecutor({
    config: { qualityThreshold: 0.7, maxRetries: 0, globalTimeout: 10_000_000, nodeTimeout: 30_000, enableProgress: false, verbose: false },
    llm,
    modelScheduler,
    nodeRunner: async (p) => ({ output: `out-${p.node.id}`, quality: 0.95, tokensUsed: 5 }),
  });
  const memory = new LongTermMemory(tmp('memory-activation.json'));
  const worldModel = new WorldModel();
  const symbiosisBridge = new SymbiosisBridge({}, { checkGate: () => ({ allowed: true }) });
  const benchmark = new BenchmarkEngine(tmp('bench-activation'));
  const targets = { decisionEngine, modelScheduler, taskExecutor, memory, worldModel, symbiosisBridge, benchmark };

  // 总览一致性：16 旗标静态清单 + 恰 6 开
  const overview = moduleFlagOverview(FLAGS);
  ok(overview.total === 16 && overview.enabled === 6 && overview.disabled === 10, `moduleFlagOverview：16 旗标、恰 6 开 / 10 关（实测 ${overview.enabled} 开）`);

  // 挂载：返回 6 个旗标名（MODULE_FLAGS 声明序），无重复
  const attached = attachPostConstructModuleUpgrades(targets, FLAGS);
  ok(JSON.stringify(attached) === JSON.stringify(['decisionHysteresisJoint', 'executorAdaptiveParallelism', 'executorFailureDomains', 'worldObservationFusion', 'symbiosisEconomy', 'benchmarkTrendTracker']),
    `挂载清单 = 6 旗标名按声明序（实际 [${attached.join(', ')}]）`);

  // —— 每旗标逐一差分读数（各自域语义，全部非空）——
  ok(decisionEngine.hysteresisView() !== undefined, 'decision：hysteresisView() 非空（滞后状态机在案）');
  ok(Array.isArray(modelScheduler.healthView()) === false && modelScheduler.healthView() === undefined, 'scheduler：未开 scheduler 旗标 → healthView() 仍 undefined（旗标不串扰）');
  ok(memory.tieredStats() === undefined, 'memory：未开 memory 旗标 → tieredStats() 仍 undefined（同引擎不同旗标零串扰）');

  const written = worldModel.writeObservation('deploy.status', 'failed', 'ci', { timestamp: T0 });
  ok(written !== undefined && written.version >= 1 && Array.isArray(worldModel.observationVersions()) && worldModel.observationVersions().length >= 1,
    `world：writeObservation 裁决 version=${written ? written.version : '-'} + observationVersions 非空（快照环在案）`);

  const delivery = symbiosisBridge.openDelivery('buyer-1', 'asset-none');
  ok(delivery !== undefined && delivery.ok === false && typeof delivery.error === 'string', 'symbiosis：openDelivery 可达（未挂载恒 undefined；缺市资产诚实 error）');

  const trend = benchmark.recordTrendPoint('model-a', 0.82, T0);
  ok(trend !== undefined && trend.name === 'model-a' && typeof trend.slope === 'number', 'benchmark：recordTrendPoint 返回趋势视图（Theil–Sen 斜率在案）');

  // —— 执行器双旗标（并行度 + 失败域）联合：同引擎两升级并存 ——
  const execPlan = {
    objective: 'activation-smoke',
    nodes: [
      { id: 'n1', description: 'a', type: 'exec', dependsOn: [] },
      { id: 'n2', description: 'b', type: 'exec', dependsOn: [] },
    ],
    parallelismStrategy: 'layered',
    source: 'fallback',
  };
  const report = await taskExecutor.executePlan(mkSignal({ type: 'exec', description: '激活冒烟双节点' }), execPlan);
  ok(report.adaptiveParallelism !== undefined && typeof report.adaptiveParallelism.settledWidth === 'number' && Array.isArray(report.adaptiveParallelism.widthHistory),
    'executor 并行度：执行报告携带 adaptiveParallelism 账单（settledWidth/widthHistory）');
  ok(report.nodeResults.every((r) => r.success), 'executor 主链路：双节点全部成功（挂载升级不伤基础执行）');

  // —— 激活后复读：全部读数仍健康（互不干扰 / 无隐式卸载）——
  ok(decisionEngine.hysteresisView() !== undefined && worldModel.observationVersions().length >= 1 && benchmark.trendSeriesViews().length >= 1 && typeof symbiosisBridge.openDelivery('buyer-2', 'asset-none')?.error === 'string',
    '复读总检：四域读数在其它域执行过后仍全部健康（激活互不干扰）');
}

// ═══════════════════ ② 感知→决策→执行联合流 ═══════════════════

section('② 感知→决策→执行：Sentinel 周期/共因 → 批量联合决策 → 失败域+并行度执行');

{
  // —— 感知（R4）：周期画像锁定 + 共因爆发判别 ——
  const baseConfig = { watchCodeChanges: false, watchErrors: false, watchPerformance: false, aggregationWindow: 60, maxBatchSize: 1_000_000 };
  const { state, clock } = syntheticClock();
  const batches = [];
  const sentinel = new Sentinel(
    {
      ...baseConfig,
      clock,
      periodicity: { minPeriodMs: 1000, maxPeriodMs: 60_000, minArrivals: 8, reevaluateEvery: 4, missFactor: 1.5, deviationThreshold: 0.3, emitMissSignals: true },
      commonCause: { windowMs: 10_000, coincidenceMs: 50, evaluateEveryMs: 0, minBurstRatePerSec: 1, burstFactor: 3, minLift: 2.5, minSources: 2 },
    },
    (b) => batches.push(b),
  );

  // 周期流：heartbeat 每 5s × 12 拍
  for (let i = 0; i < 12; i += 1) {
    sentinel.ingest({ type: 'heartbeat', description: `hb-${i}`, payload: {}, source: 'heartbeat', receivedAt: T0 + i * 5000 });
  }
  const pView = sentinel.periodicityView();
  const hb = pView.sources.find((s) => s.source === 'heartbeat');
  ok(hb.status === 'locked' && Math.abs(hb.periodMs - 5000) <= 160 && hb.strength >= 0.95, `感知·周期画像：heartbeat 锁定 P=${hb.periodMs}ms（真值 5000）、强度 ${hb.strength.toFixed(3)}`);

  // 共因流：三源同刻齐发风暴（8s 平静 + 12s 风暴）——时基取心跳流之后，
  // 保证风暴落在检测器 10s 滑窗内（与心跳感知不抢时间轴）。
  const TB = T0 + 60_000;
  const SRC = ['svc-a', 'svc-b', 'svc-c'];
  for (let i = 0; i < 4; i += 1) {
    const t = TB + i * 2000;
    SRC.forEach((s, k) => sentinel.ingest({ type: 'load', description: `quiet-${s}-${i}`, payload: {}, source: s, receivedAt: t + k * 500 }));
  }
  for (let j = 0; j < 30; j += 1) {
    const t = TB + 8000 + j * 400;
    SRC.forEach((s) => sentinel.ingest({ type: 'load', description: `storm-${s}-${j}`, payload: {}, source: s, receivedAt: t }));
  }
  const cView = sentinel.commonCauseView();
  const group = cView.groups.find((g) => g.classification === 'common-cause');
  ok(group !== undefined && group.sources.length === 3 && cView.commonCauseEvents >= 1, `感知·共因爆发：三源聚为 common-cause 组（${group ? group.sources.join('+') : '-'}）、事件 ${cView.commonCauseEvents} 起`);
  ok(Math.min(...group.pairLifts.map((p) => p.lift)) >= 3, `感知·共因判别强度：最小两两提升 ${Math.min(...group.pairLifts.map((p) => p.lift)).toFixed(2)} ≥ 3（同刻齐发 vs 独立期望）`);

  // —— 感知→决策：哨兵 flush 的风暴信号进入批量联合决策（10 条同型 → 1 次 strategist）——
  state.now = TB + 30_000;
  sentinel.flush();
  const flushed = batches.flatMap((b) => b.signals);
  ok(flushed.length >= 30, `感知产出：flush 交付 ${flushed.length} 条信号（风暴 + 心跳流进入下游）`);
  const loadSignals = flushed.filter((s) => s.type === 'load').slice(0, 10);
  ok(loadSignals.length === 10, '感知→决策管道：load 型信号 ≥ 10 条可入联合决策');

  const strategistState = { calls: 0 };
  const countingStrategist = (signals) => {
    strategistState.calls += 1;
    const out = new Map();
    for (const s of signals) out.set(s.id, { urgency: s.urgency ?? 0.5, decision: 'execute', reason: '联合冒烟裁定' });
    return Promise.resolve(out);
  };
  const decisionEngine = new DecisionEngine({ strategist: countingStrategist });
  decisionEngine.attachBatchJointDecider({ mergeCostRatio: 0.35, now: () => 1_000_000 });
  const history = new Map([['load', { totalDecisions: 0, successRate: 0.8, avgExecutionTime: 1000, avgTokenCost: 2000 }]]);
  const joint = await decisionEngine.decideJointly(
    loadSignals.map((s, i) => mkSignal({ type: 'load', urgency: 0.4 + i * 0.03, description: s.description })),
    history,
  );
  ok(strategistState.calls === 1 && joint.strategistInvocations === 1, `决策·批量联合：strategist 调用 ${strategistState.calls} 次（10 → 1，省 90%）`);
  ok(joint.groups.length === 1 && joint.groups[0].merged === true && joint.decisions.size === 10, `决策·联合终局：单合并组 + 10 条全有决策`);
  ok(joint.groups[0].action === 'execute' && near(joint.totalSavedCost, 2000 * 9 * 0.65), `决策·联合成本：组终局 execute、总省 ${joint.totalSavedCost}（= 9 × 2000 × 0.65）`);
  ok([...joint.decisions.values()].every((d) => d.action === 'execute'), '决策·同进同出：合并成员终局一致');

  // —— 决策→执行：联合终局 execute → 执行器按失败域 + 并行度跑真实计划 ——
  const vc = new VirtualClock(0);
  const fdState = { calls: 0 };
  const fdRunner = async (p) => {
    if (p.modelId === 'model-a') {
      fdState.calls += 1;
      if (fdState.calls <= 2) throw new NetworkError('mock: model-a 网络故障');
    }
    vc.advance(10);
    return { output: `ok-${p.node.id}`, quality: 0.95, tokensUsed: 5, completedAt: vc.now() };
  };
  const fdLlm = makeLlm(['model-a', 'model-b'], ['tx']);
  const executor = new TaskExecutor({
    config: { qualityThreshold: 0.7, maxRetries: 0, globalTimeout: 10_000_000, nodeTimeout: 30_000, enableProgress: false, verbose: false, maxInFlightNodes: 1, circuitFailureThreshold: 5, circuitCooldownMs: 600_000 },
    llm: fdLlm,
    modelScheduler: new ModelScheduler({ llm: fdLlm, memory: stubMemory() }),
    nodeRunner: fdRunner,
  });
  executor.attachClock(vc);
  attachPostConstructModuleUpgrades({ taskExecutor: executor }, { executorAdaptiveParallelism: { enabled: true }, executorFailureDomains: { enabled: true, failureThreshold: 2, cooldownMs: 600_000 } });
  const fdPlan = {
    objective: joint.groups[0].key, // 联合决策组键作为执行目标（数据贯通）
    nodes: ['x1', 'x2', 'x3'].map((id) => ({ id, description: id, type: 'tx', dependsOn: [], modelId: 'model-a' })),
    parallelismStrategy: 'layered',
    source: 'fallback',
  };
  const fdReport = await executor.executePlan(mkSignal({ type: 'tx', description: `联合组 ${joint.groups[0].key} 执行` }), fdPlan);
  const modelOf = Object.fromEntries(fdReport.nodeResults.map((r) => [r.nodeId, r.modelId]));
  ok(modelOf.x3 === 'model-b' && fdReport.nodeResults.find((r) => r.nodeId === 'x3').success === true, `执行·失败域隔离：model-a::tx 连败 2 簇熔断 → x3 接管至 ${modelOf.x3} 且成功`);
  const snap = executor.failureDomainSnapshot();
  ok(snap['model-a::tx'] !== undefined && snap['model-a::tx'].state === 'open', '执行·失败域快照：model-a::tx open（细粒度熔断在案）');
  ok(fdReport.adaptiveParallelism !== undefined && fdReport.adaptiveParallelism.widthHistory.length >= 1, '执行·并行度自适应：报告携带 widthHistory（同一执行内两升级并存）');
  ok(fdReport.nodeResults.filter((r) => r.success).length === 1 && modelOf.x1 === 'model-a' && modelOf.x2 === 'model-a',
    `执行·一条龙终局：故障簇 2 节点如实失败（model-a）+ 接管节点成功（x3 → model-b）——异常被失败域吸收、不扩散（联合 execute 语义下 1/3 成功即链路存活）`);
}

// ═══════════════════ ③ 经济-治理-遥测联合 ═══════════════════

section('③ 经济-治理-遥测：通胀治理（注入冻结时钟）+ 条件结算 → 审计链 + 采样导出');

{
  // —— 通胀治理（R4）+ 集成修复的注入时钟：单次结算冻结同一时刻 ——
  const vt = { now: T0 }; // 虚拟时钟：结算时刻逐次推进（确定性）
  const rt = new SymbiosisRuntime({
    initialSupply: 10_000,
    openingGrant: 0,
    monetaryPolicy: { targetCirculating: 8_000, bandTolerance: 0.05 },
    clock: () => vt.now,
  });
  class ProbeAgent extends AgentBase {
    constructor(id) {
      super(id, T0);
      this.kind = 'optimizer';
    }
    goal() {
      return { objective: 'probe', metrics: [], survivalThreshold: 1 };
    }
    async execute() {
      return { success: true, valueEstimate: 0.5, summary: 'probe' };
    }
  }
  rt.register(new ProbeAgent('worker-1'));
  const reports = [];
  let iterations = 0;
  let circulating = rt.ledger.circulatingSupply();
  while (circulating > 8_400 && iterations < 60) {
    vt.now += 1_000; // 虚拟时钟推进（采样时间戳确定性）
    reports.push(rt.settleTaskOutcome(true, [{ agentId: 'worker-1' }]));
    circulating = rt.ledger.circulatingSupply();
    iterations += 1;
  }
  ok(iterations < 60 && circulating <= 8_400, `通胀治理收敛：${iterations} 次结算流通量 ${circulating.toFixed(1)} 回归带内（10000 → ≤8400）`);
  ok(reports[0].monetary.zone === 'above' && near(reports[0].monetary.mintTaxRate, 0.5) && reports[0].totalDistributed === 20 && reports[0].monetary.taxWithheld === 20,
    `首结算即触发：zone=above、tax=0.5、分红 ${reports[0].totalDistributed}（税率扣留 ${reports[0].monetary.taxWithheld}——注入冻结时钟下逐位确定）`);
  const trendView = rt.monetaryTrend();
  ok(trendView.samples >= iterations, `货币采样史：monetaryTrend() ${trendView.samples} 采样 ≥ 结算 ${iterations} 次（注入时钟时间戳入史）`);

  // —— 条件结算三路（R4）：全质 / 半质 / 违约 ——
  const ledger = rt.ledger;
  const market = rt.market;
  const seller = 'seller-eco';
  const buyer = 'buyer-eco';
  ledger.openAccount(seller);
  ledger.openAccount(buyer);
  // 收缩销毁后国库 8,225——适度注资（卖方挂单费 30 + 买方三合约托管 330 足矣）
  ledger.transfer(TREASURY, seller, 1_000, 'fund', 'setup');
  ledger.transfer(TREASURY, buyer, 1_000, 'fund', 'setup');
  const assets = ['eco-full', 'eco-partial', 'eco-breach'].map((ref) =>
    market.list({ seller, kind: 'pattern', refId: ref, description: `经济联合 ${ref}`, ask: 100, claimedQuality: 0.8 }),
  );
  const contracts = assets.map((a) => market.openDeliveryContract(buyer, a.assetId, {}, vt.now));
  ok(contracts.every((c) => c.ok), '三合约开立：货款 100 + 保证金 10 双托管');
  const rFull = market.settleDelivery(contracts[0].contractId, 0.95, vt.now + 10);
  const rPart = market.settleDelivery(contracts[1].contractId, 0.5, vt.now + 20);
  const rBreach = market.settleDelivery(contracts[2].contractId, undefined, vt.now + 30);
  ok(rFull.mode === 'full' && rFull.toSeller === 100 && rPart.mode === 'partial' && rPart.toSeller === 50 && rBreach.mode === 'breach' && rBreach.refundBuyer === 100,
    `三路结算按约分配：全质 100 / 半质 50 / 违约全退（+保证金罚没 ${rBreach.penaltyToBuyer}）`);
  const audit = market.auditContracts();
  ok(audit.conserved && audit.breachesRecorded && audit.violations.length === 0 && market.auditInvariants().intact, '托管守恒审计 conserved + 主链路不变量 intact');

  // —— 审计链：货币政策 + 条件结算凭证在账本一一对应 ——
  const journal = ledger.audit(ledger.stats().transfers);
  const contraction = journal.filter((t) => t.reason === 'monetary-contraction');
  const breach = journal.filter((t) => t.reason === 'contract-breach');
  ok(contraction.length === iterations && contraction.every((t) => t.amount > 0), `审计链·通胀治理：${contraction.length} 笔 'monetary-contraction' 与结算次数一一对应`);
  ok(breach.length === 1 && breach[0].amount === 10 && market.contractBreaches().length === 1, "审计链·条件结算：1 笔 'contract-breach'（10 能量）= 台账 1 条违约（一一对应）");

  // —— 遥测（R4）：经济事件入指标 + 确定性按率采样 + 估计器还原 ——
  const reg = new MetricsRegistry();
  const settleCounter = reg.counter('dsh.symbiosis.settlements', { help: 'Settlements processed' });
  for (let i = 0; i < reports.length; i += 1) settleCounter.inc();
  reg.counter('dsh.symbiosis.breaches', { help: 'Contract breaches' }).add(breach.length);
  reg.gauge('dsh.symbiosis.circulating').set(circulating);
  ok(reg.toPrometheus().includes(`dsh_symbiosis_settlements ${reports.length}`) && reg.toPrometheus().includes('dsh_symbiosis_breaches 1'),
    `遥测·计数入册：结算 ${reports.length} 次 + 违约 1 笔进入 Prometheus 文本`);
  const sampler = new DeterministicRateSampler(0.25);
  let kept = 0;
  for (let i = 0; i < 100; i += 1) if (sampler.decide()) kept += 1;
  const st = sampler.stats();
  ok(st.seen === 100 && st.kept === 25 && Math.abs(sampler.estimateTotal() - 100) <= 1 / 0.25,
    `遥测·按率采样：rate=0.25 ×100 → kept 恰 ${st.kept}（Bresenham 精确）、估计器还原 ${sampler.estimateTotal().toFixed(2)} ≈ 100`);
  ok(reg.toPrometheus() === prometheusExposition(reg.snapshot()) && reg.toPrometheus() === reg.toPrometheus(), '遥测·导出确定性：toPrometheus === prometheusExposition(snapshot)，两次逐位一致');
}

// ═══════════════════ ④ dashboard 告警面板 + 布局持久化纯函数 ═══════════════════

section('④ dashboard：告警面板承接经济事件 + 布局持久化纯函数');

{
  // —— 告警样本：③ 的经济事件（通胀收缩 / 违约）入统一告警流 ——
  const ALARMS = [
    { id: 'a1', source: 'symbiosis-economy', severity: 'critical', title: '条件结算违约罚没', detail: 'contract-breach ×1', timestamp: 1000 },
    { id: 'a2', source: 'symbiosis-economy', severity: 'warning', title: '通胀收缩销毁执行', timestamp: 1500 },
    { id: 'a3', source: 'benchmark-regression', severity: 'warning', title: '分数漂移检出', timestamp: 3000 },
    { id: 'a4', source: 'metacognition-kpi', severity: 'info', title: '校准偏差偏高', timestamp: 2500 },
    { id: 'a5', source: 'benchmark-regression', severity: 'info', title: '趋势观察中', timestamp: 2500 },
  ];
  const payload = alarmFeedPayload([...ALARMS].reverse());
  ok(payload.available && payload.total === 5 && payload.shown === 5, `告警流：available + 5 条全量（${payload.total}/${payload.shown}）`);
  ok(payload.counts.critical === 1 && payload.counts.warning === 2 && payload.counts.info === 2, '告警流·分色计数：critical 1 / warning 2 / info 2');
  ok(payload.alarms[0].id === 'a3' && payload.alarms[1].id === 'a4' && payload.alarms[2].id === 'a5', '告警流·时间倒序（同刻 2500 按 id 升序 a4, a5）');
  const econFiltered = alarmFeedPayload(ALARMS, { filterSource: 'symbiosis-economy' });
  ok(econFiltered.shown === 2 && econFiltered.alarms.every((a) => a.source === 'symbiosis-economy') && econFiltered.total === 5,
    `告警流·来源过滤：经济源 2/5 展示、全量计数不塌缩（③ 事件直通面板）`);
  ok(alarmFeedPayload(ALARMS, { maxItems: 2 }).shown === 2, '告警流·maxItems 截断');
  ok(classifyAlarmSeverity('catastrophic') === 'info' && alarmFeedPayload(undefined).available === false, '告警流·防御：脏严重度归一 info、未注入空态');

  // —— 布局持久化：往返恒等 + 坏输入回退 + 可见序 ——
  const def = defaultDashboardLayout();
  ok(def.version === 1 && def.hidden.length === 0 && def.order.length === DEFAULT_DASHBOARD_PANELS.length, `默认布局：全显 + ${DEFAULT_DASHBOARD_PANELS.length} 面板默认序`);
  const custom = { version: 1, hidden: ['gwt-panel'], order: [...DEFAULT_DASHBOARD_PANELS].reverse() };
  const roundTrip = parseDashboardLayout(serializeDashboardLayout(normalizeDashboardLayout(custom)));
  ok(JSON.stringify(roundTrip) === JSON.stringify(normalizeDashboardLayout(custom)), '布局·序列化往返恒等：parse(serialize(normalize(p))) ≡ normalize(p)');
  ok(JSON.stringify(parseDashboardLayout(serializeDashboardLayout(roundTrip))) === JSON.stringify(roundTrip), '布局·二次往返幂等');
  const vis = visibleOrderedPanels(roundTrip);
  ok(vis.length === DEFAULT_DASHBOARD_PANELS.length - 1 && !vis.includes('gwt-panel') && vis[0] === 'alarm-panel', `布局·可见序：隐 gwt-panel 后 ${vis.length} 面板、逆序偏好首位 ${vis[0]}`);
  let allFallback = true;
  for (const bad of [null, undefined, '', 'not-json{', '{"version":2,"hidden":[],"order":[]}', '[]']) {
    if (JSON.stringify(parseDashboardLayout(bad)) !== JSON.stringify(defaultDashboardLayout())) allFallback = false;
  }
  ok(allFallback, '布局·坏输入全部回退默认（null/undefined/非 JSON/版本不符/形状错）');
}

// ═══════════════════ ⑤ Prometheus 导出 + 审计保留联合冒烟 ═══════════════════

section('⑤ Prometheus 导出 + 审计保留：三类指标逐位确定性 + 经济事件入有界审计账');

{
  // —— Prometheus：三类指标（counter/gauge/histogram）联合导出 ——
  const reg = new MetricsRegistry();
  const c = reg.counter('dsh.integration.events', { help: 'Integration events' });
  c.inc();
  c.add(4, { kind: 'settlement' });
  const g = reg.gauge('dsh.integration.circulating');
  g.set(8_305);
  const h = reg.histogram('dsh.integration.latency', { buckets: [10, 100], help: 'Settlement latency' });
  for (const v of [5, 50, 50]) h.observe(v);
  const text = reg.toPrometheus();
  const mustHave = [
    '# TYPE dsh_integration_circulating gauge',
    'dsh_integration_circulating 8305',
    'dsh_integration_latency_bucket{le="10"} 1',
    'dsh_integration_latency_bucket{le="+Inf"} 3',
    'dsh_integration_latency_count 3',
    'dsh_integration_events 1',
    'dsh_integration_events{kind="settlement"} 4',
  ];
  ok(mustHave.every((line) => text.includes(line)), `Prometheus·三类指标联合：counter/gauge/histogram ${mustHave.length} 个关键行逐位在册`);
  ok(text.indexOf('dsh_integration_circulating') < text.indexOf('dsh_integration_events') && text.indexOf('dsh_integration_events') < text.indexOf('dsh_integration_latency'),
    'Prometheus·指标名升序（circulating < events < latency；. → _ 映射）');
  ok(reg.toPrometheus() === prometheusExposition(reg.snapshot()) && reg.toPrometheus() === reg.toPrometheus(), 'Prometheus·确定性：与 prometheusExposition(snapshot) 全等 + 两次导出逐位一致');
  ok(new MetricsRegistry().toPrometheus() === '', 'Prometheus·空注册表 → 空串');

  // —— 审计保留：③ 的经济事件流入有界审计账（容量 + 时长双门限）——
  const clock = createManualClock(T0);
  const log = new AuditLog({ clock, retention: { maxEntries: 5, maxAgeMs: 10_000 } });
  const events = [
    ...Array.from({ length: 3 }, (_, i) => ({ actor: 'monetary-governor', action: 'monetary-contraction', target: `settlement-${i + 1}` })),
    { actor: 'delivery-market', action: 'contract-breach', target: 'contract-eco-breach' },
    { actor: 'delivery-market', action: 'contract-settle', target: 'contract-eco-full' },
    { actor: 'tenant-admin', action: 'quota-observe', target: 'tenant-gamma' },
    { actor: 'meta-controller', action: 'tune-deadband', target: 'stability-loop' },
    { actor: 'scheduler', action: 'health-route', target: 'model-b' },
  ];
  for (const e of events) {
    log.append(e);
    clock.advance(1_000);
  }
  const rs = log.retentionStats();
  ok(log.size() === 5 && rs.trimmedEntries === 3 && rs.trimOperations >= 3, `审计·容量门限：${events.length} 条经济事件 → 保留 ${log.size()}、裁剪 ${rs.trimmedEntries}（有界保留）`);
  const keptActions = log.entries().map((e) => e.action);
  ok(keptActions.includes('contract-breach') && !keptActions.includes('monetary-contraction'), `审计·先进先出：最新在册含违约凭证、最早 3 笔收缩已滑出（保留 [${keptActions.join(', ')}]）`);
  const v = log.verify();
  ok(v.valid === true && v.checkedCount === 5, `审计·整链锚定校验：裁剪后 valid（连续 ${v.checkedCount} 条、锚定链头）`);
  const json = log.exportJSON();
  const parsed = AuditLog.parseExport(json);
  ok(parsed.entries.length === 5 && parsed.anchorHash === rs.anchorHash && AuditLog.verifyChain(parsed.entries, parsed.anchorHash).valid === true,
    '审计·导出往返：exportJSON → parseExport → verifyChain 以锚闭合');
  const tampered = parsed.entries.map((e, i) => (i === 1 ? { ...e, action: 'forged' } : e));
  const rt2 = AuditLog.verifyChain(tampered, parsed.anchorHash);
  ok(rt2.valid === false && rt2.breakIndex === 1, '审计·防篡改：改保留条目 → breakIndex=1 定位');
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— 第四轮跨域集成冒烟成立（激活链路 / 感知→决策→执行 / 经济-治理-遥测 / dashboard / Prometheus+审计保留）`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
