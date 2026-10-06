/**
 * verify-mod-integration.mjs — 第三轮「全部模块世界性升级」集成回归（19/20）
 *
 * 前序 18 个模块域工程师各自 verify-mod-*.mjs 全绿（域内零回归）；本脚本做
 * **跨域联合冒烟**——四条穿透多个域升级边界的数据流，验证升级后的模块拼
 * 回一起仍然口径一致、数据贯通：
 *
 *   ① 信号→决策→调度→执行→反思 主链路纯数据流水（A1/A2/A3/A4/A6 五域联动）
 *      真实组件：Sentinel（聚合 flush 交付）→ DecisionEngine（规则 C defer +
 *      启发式 execute 双路）→ ModelScheduler（推荐 model-a）→ TaskExecutor
 *      （注入 nodeRunner 零网络执行 + 执行审计事件流）→ Reflector（经验沉淀
 *      进真实 LongTermMemory 临时文件）。断言五域交接面的数据逐级贯通：
 *      批次信号全数获裁决、execute 信号走完计划执行、成功结果沉淀出任务
 *      模式、决策审计与执行审计双双在案。
 *
 *   ② 遥测事件总线 ↔ 主链路审计轨迹口径一致性 + 根入口接线（A18 × A16/A17）
 *      A18 四文件（TelemetryBus/MetricsRegistry/AuditLog/Tracer）已由本脚本
 *      口径从 dist/index.mjs 根入口导入（index.ts re-export，消歧别名
 *      TelemetrySeqGap/TelemetryAuditEntry）——断言接线在位；随后把 ① 的
 *      执行审计事件流逐条发布进 TelemetryBus：信封六字段（type/source/ts/
 *      seq/payload/isFinal）逐位、seq 总线级单调、通配订阅 `exec.audit.*`
 *      拉取守恒、终态事件（plan-complete）isFinal 必达；口径一致性对照
 *      A16 契约 EventEnvelope（createEventEnvelope/isEventEnvelope）——同一
 *      审计事实映射为契约信封后核心五字段（type/source/ts/seq/payload）
 *      名称与语义逐位对齐（两条信封规范共享同一骨架）；MetricsRegistry
 *      计数执行事件、AuditLog 把 ① 的执行结果入账并整链校验。
 *
 *   ③ 共生结算→账本哈希链→记忆沉淀 跨模块数据流（A11 × A5 纯构造）
 *      ① 的执行结果（model-a 成功节点）→ SymbiosisBridge.settleTask 铸币
 *      分红 → EnergyLedger 哈希链（块间 prevHash 链接 + 整链校验 intact +
 *      生态守恒）→ 同一任务再沉淀进 LongTermMemory（recordSuccess 计数
 *      累积）→ bridge.attachMemory 后心跳驱动记忆智能体把高置信模式挂上
 *      认知市场（listed ≥ 1）——「执行 → 结算 → 链上可验 → 知识变资产」。
 *
 *   ④ 仪表盘数据端点函数结构断言（A15）
 *      kernelMapPayload / gwtBusPayload / attentionMarketPayload 三个纯函数
 *      （未从根入口导出——直连 src/dashboard/index.ts，A10 直连 src 先例同款）：
 *      空态（undefined → 未挂载诚实降级）与常态（98 内核 × 20 层 / 旗标合并 /
 *      广播流步序降序 / VCG 支付按源聚合）双口径结构逐位。
 *
 * 确定性：无网络（LLM endpoint 指向 mock.local 且 nodeRunner 全注入）、
 * 无真定时器依赖（Sentinel 用 flush() 同步交付；sentinel 内部窗口定时器被
 * flush 清除）；共生桥 heartbeat 需要异步 tick 但输入固定；Dashboard/遥测
 * 全为注入时钟或纯函数。遥测时钟注入 ManualClock，逐位可重放。
 *
 * 运行：npm run build && node --experimental-transform-types scripts/verify-mod-integration.mjs
 *（统一口径说明：第三轮起全套件以 --experimental-transform-types 运行——它是
 *  strip-types 的超集，兼容 dsh-host.ts 等使用 TS 参数属性的直连源脚本）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  // ① 主链路五域真实组件
  Sentinel,
  DecisionEngine,
  ModelScheduler,
  TaskExecutor,
  Reflector,
  ReflectionEngine,
  LongTermMemory,
  LLMClient,
  // ② 遥测四件套（A18 根入口 re-export 接线验证）+ A16 契约信封
  TelemetryBus,
  createManualClock,
  MetricsRegistry,
  AuditLog,
  Tracer,
  createEventEnvelope,
  isEventEnvelope,
  // ③ 共生结算域
  SymbiosisBridge,
} from '../dist/index.mjs';
// ④ A15 仪表盘载荷构造器（纯函数，未从根入口导出——直连 src 源，A10 先例同款）
import { kernelMapPayload, gwtBusPayload, attentionMarketPayload } from '../src/dashboard/index.ts';

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
function section(title) {
  console.log(`\n■ ${title}`);
}
function near(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}

// ═══════════════════ ① 信号→决策→调度→执行→反思 主链路纯数据流水 ═══════════════════

section('① 主链路五域联动：信号聚合 → 战略决策 → 模型调度 → 并行执行 → 反思沉淀（无网络）');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-integration-'));
const pipeline = {};
try {
  // —— 记忆与模型注册（真实组件；LLM endpoint 指向 mock 主机，全程零网络）——
  const memory = new LongTermMemory(path.join(tmpDir, 'memory.json'));
  const llm = new LLMClient();
  llm.registerModel({ id: 'model-a', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { deploy: 0.6 } } });
  const scheduler = new ModelScheduler({ llm, memory });
  const executor = new TaskExecutor({
    config: { qualityThreshold: 0.7, maxRetries: 1, globalTimeout: 30_000, nodeTimeout: 10_000, enableProgress: false, verbose: false },
    llm,
    modelScheduler: scheduler,
    nodeRunner: async (p) => ({ output: `out-${p.node.id}`, quality: 0.93, tokensUsed: 12 }),
  });

  // —— A1 Sentinel：三信号入哨（同类型 ×2 触发聚合 + 异类型 ×1），flush 同步交付 ——
  const batches = [];
  const sentinel = new Sentinel(
    { watchCodeChanges: false, watchErrors: false, watchPerformance: false, aggregationWindow: 10 },
    (b) => batches.push(b),
  );
  const T0 = 1_700_000_000_000;
  sentinel.ingest({ type: 'integration-deploy', description: '发布窗口异常排查', payload: { service: 'api' }, source: 'verify', urgency: 0.9, receivedAt: T0, occurrences: 1 });
  sentinel.ingest({ type: 'integration-deploy', description: '发布窗口异常排查', payload: { service: 'api' }, source: 'verify', urgency: 0.8, receivedAt: T0 + 100, occurrences: 1 });
  sentinel.ingest({ type: 'integration-doc', description: '低价值文档刷新', payload: {}, source: 'verify', urgency: 0.15, receivedAt: T0 + 200, occurrences: 1 });
  sentinel.flush('integration');
  ok(batches.length === 1 && batches[0].reason === 'integration', `Sentinel flush 同步交付恰 1 批（reason=integration，实际 ${batches.length} 批）`);
  const batch = batches[0];
  const batchTypes = new Set(batch.signals.map((s) => s.type));
  ok(batchTypes.has('integration-deploy') && batchTypes.has('integration-doc'), `批次覆盖两类信号（${batch.signals.map((s) => s.type).join(',')}）`);
  pipeline.batch = batch;

  // —— A2 DecisionEngine：高紧急度无历史 → 启发式 execute；低紧急度高成本历史 → 规则 C defer ——
  const decisionEngine = new DecisionEngine();
  const history = new Map([
    ['integration-doc', { totalDecisions: 30, successRate: 0.5, avgExecutionTime: 5_000, avgTokenCost: 20_000 }],
  ]);
  const decisions = await decisionEngine.decide(batch.signals, history);
  ok(decisions.size === batch.signals.length, `决策面全数覆盖（${decisions.size}/${batch.signals.length}——每个信号都有裁决，无孤儿）`);
  const deployDecision = [...decisions.values()].find((d) => d.action === 'execute');
  const docDecision = [...decisions.values()].find((d) => d.action === 'defer');
  ok(deployDecision !== undefined && deployDecision.urgency >= 0.5, `高紧急度信号裁决 execute（source=${deployDecision?.source}，urgency ${deployDecision?.urgency?.toFixed(2)}）`);
  ok(docDecision !== undefined && docDecision.source === 'rule' && (docDecision.deferMs ?? 0) > 0, `低紧急度高成本信号规则 C 裁决 defer（source=rule，deferMs=${docDecision?.deferMs}——滞后/成本闸门口径跨域可用）`);
  pipeline.deployDecision = deployDecision;

  // —— A3/A4 调度 + 执行：execute 信号 → 离线兜底计划 → 注入 runner 零网络执行 ——
  const deploySignal = batch.signals.find((s) => s.type === 'integration-deploy');
  const plan = executor.buildPlan(deploySignal.description, undefined, 'deploy');
  ok(plan.nodes.length >= 1 && plan.source === 'fallback', `计划生成（strategist 缺席走离线兜底，${plan.nodes.length} 节点）`);
  const report = await executor.executePlan(deploySignal, plan);
  ok(report.success === true && report.avgQuality >= 0.7, `计划执行成功（success=${report.success}，avgQuality=${report.avgQuality?.toFixed(2)} ≥ 阈值 0.7）`);
  const nodeResult = report.nodeResults[0];
  ok(nodeResult.modelId === 'model-a', `调度域贯通：节点由注册模型执行（modelId=${nodeResult.modelId}——ModelScheduler 推荐链路生效，零网络）`);
  const audit = executor.exportAuditTrail();
  ok(
    audit.some((e) => e.type === 'plan-start') && audit.some((e) => e.type === 'plan-complete') && audit.some((e) => e.type === 'node-complete'),
    `执行审计事件流在案（${audit.length} 条：plan-start/node-complete/plan-complete 齐备）`,
  );
  pipeline.plan = plan;
  pipeline.report = report;
  pipeline.audit = audit;

  // —— A6/A5 反思沉淀：执行结果 → Reflector → 真实 LongTermMemory ——
  const reflection = new ReflectionEngine();
  const reflector = new Reflector({ memory, reflection, config: { enableProgress: false } });
  reflector.reflectOnOutcome({ signal: deploySignal, plan, result: report });
  const patterns = memory.getAllTaskPatterns();
  ok(patterns.length === 1 && patterns[0].taskSummary === deploySignal.description, `经验沉淀贯通（记忆库新增任务模式「${patterns[0]?.taskSummary}」，frequency=${patterns[0]?.frequency}）`);
  ok(patterns[0].successfulPlans.length >= 1 && patterns[0].avgQualityScore >= 0.7, `沉淀内容完整（成功计划入档 ${patterns[0].successfulPlans.length} 条，平均质量 ${patterns[0].avgQualityScore?.toFixed(2)}）`);
  const decisionAudit = decisionEngine.getAudit(50);
  ok(decisionAudit.length >= 1 && decisionAudit.some((e) => batch.signals.some((s) => s.id === e.signalId)), `决策审计在案（${decisionAudit.length} 条 DecisionAuditEntry，signalId 与批次信号对得上）`);
  pipeline.memory = memory;
  pipeline.deploySignal = deploySignal;
  pipeline.pattern = patterns[0];
  pipeline.patternFrequency = patterns[0].frequency; // 原始值快照（pattern 为活引用，后续 recordSuccess 会就地累积）

  // ═══════════════════ ② 遥测事件总线 ↔ 审计轨迹口径一致性 + 根入口接线 ═══════════════════

  section('② A18 遥测总线 × A16 契约信封 × A17 执行审计：口径一致性（根入口接线验证）');

  {
    // —— 接线在位：A18 四件套经根入口可导入（index.ts re-export 后的运行时验证）——
    ok(typeof TelemetryBus === 'function' && typeof MetricsRegistry === 'function' && typeof AuditLog === 'function' && typeof Tracer === 'function', '根入口接线：TelemetryBus/MetricsRegistry/AuditLog/Tracer 四类可从 dist/index.mjs 导入');
    ok(typeof createManualClock === 'function', '根入口接线：createManualClock 工厂在位');

    // —— 把 ① 的执行审计事件流发布进遥测总线（注入时钟，逐位可重放）——
    const clock = createManualClock(T0);
    const bus = new TelemetryBus({ clock, bufferCapacity: 64 });
    const sub = bus.subscribe('exec.audit.*', { maxQueue: 64 });
    for (const event of pipeline.audit) {
      bus.publish(`exec.audit.${event.type}`, 'task-executor', event, { isFinal: event.type === 'plan-complete' });
    }
    ok(bus.stats().publishedTotal === pipeline.audit.length && bus.stats().lastSeq === pipeline.audit.length, `总线发布守恒（${bus.stats().publishedTotal} 条，lastSeq=${bus.stats().lastSeq}）`);
    const taken = sub.take();
    ok(taken.length === pipeline.audit.length, `通配订阅 \`exec.audit.*\` 守恒拉取（发布 ${pipeline.audit.length} 条 / 订阅收到 ${taken.length} 条——点分通配口径跨模块一致）`);
    ok(taken.every((e, i) => e.seq === i + 1) && taken.every((e) => Number.isFinite(e.ts)), `信封六字段口径：seq 总线级单调 1..${taken.length}、ts 全部来自注入时钟（有限数）`);
    ok(taken.every((e) => e.source === 'task-executor' && typeof e.type === 'string' && e.type.startsWith('exec.audit.')), '信封 type/source 口径：事件类型点分命名 + 来源模块标识逐条在案');
    ok(taken.filter((e) => e.isFinal).every((e) => e.type === 'exec.audit.plan-complete') && taken.some((e) => e.isFinal), '终态标记口径：恰 plan-complete 标 isFinal（背压必达语义的交接面）');

    // —— 口径一致性：同一审计事实 ↔ A16 契约 EventEnvelope 核心五字段逐位对齐 ——
    const fact = pipeline.audit.find((e) => e.type === 'node-complete');
    const telemetryEnv = taken.find((e) => e.type === 'exec.audit.node-complete');
    const contractEnv = createEventEnvelope({
      type: telemetryEnv.type,
      payload: telemetryEnv.payload,
      source: telemetryEnv.source,
      seq: telemetryEnv.seq,
      ts: telemetryEnv.ts,
    });
    ok(isEventEnvelope(contractEnv) === true, '契约信封窄化守卫通过（isEventEnvelope——A16 校验器认可 A18 信封的映射）');
    ok(
      contractEnv.type === telemetryEnv.type
        && contractEnv.source === telemetryEnv.source
        && contractEnv.ts === telemetryEnv.ts
        && contractEnv.seq === telemetryEnv.seq
        && JSON.stringify(contractEnv.payload) === JSON.stringify(telemetryEnv.payload),
      '两条信封规范共享同一骨架：type/source/ts/seq/payload 五字段名与值逐位对齐（遥测侧仅增量 isFinal 背压语义）',
    );
    ok(fact !== undefined && contractEnv.payload === fact, '载荷原样承载审计事实（payload 即 ExecutorAuditEvent 本体，无有损翻译）');

    // —— MetricsRegistry：执行事件计数（遥测侧指标口径）——
    const metrics = new MetricsRegistry();
    const eventsCounter = metrics.counter('dsh_executor_audit_events_total');
    const finalsCounter = metrics.counter('dsh_executor_finals_total');
    for (const e of taken) eventsCounter.inc();
    for (const e of taken.filter((x) => x.isFinal)) finalsCounter.inc();
    const snap1 = metrics.toJSON();
    const snap2 = metrics.toJSON();
    ok(snap1 === snap2, '指标快照确定性（两次 toJSON 逐位全等——遥测读数可回归）');
    const registry = metrics.snapshot();
    const findValue = (name) => registry.metrics.find((m) => m.name === name)?.series[0]?.value;
    ok(registry.metrics.length === 2 && findValue('dsh_executor_audit_events_total') === taken.length && findValue('dsh_executor_finals_total') === taken.filter((x) => x.isFinal).length, `指标计数与审计流对账（events=${findValue('dsh_executor_audit_events_total')} / finals=${findValue('dsh_executor_finals_total')}——遥测口径吃主链路事实）`);

    // —— AuditLog：① 的执行结果入账 → 哈希链整链校验 ——
    const auditLog = new AuditLog({ clock });
    auditLog.append({
      actor: 'task-executor',
      action: 'plan-execute',
      target: pipeline.deploySignal.id,
      before: { status: 'pending' },
      after: { status: report.success ? 'success' : 'failed', avgQuality: report.avgQuality },
      reason: '集成冒烟：主链路计划执行',
    });
    auditLog.append({
      actor: 'reflector',
      action: 'experience-settle',
      target: pipeline.pattern.fingerprint,
      after: { taskSummary: pipeline.pattern.taskSummary, frequency: pipeline.pattern.frequency },
      reason: '集成冒烟：经验沉淀',
    });
    const chain = auditLog.verify();
    ok(chain.valid === true && chain.checkedCount === 2, `审计账哈希链完整（2 条入账整链校验 valid——执行与沉淀两大事实可防篡改追溯）`);
    const roundTrip = AuditLog.fromJSON(auditLog.exportJSON());
    ok(AuditLog.verifyChain(roundTrip).valid === true, '导出往返后仍可独立验链（exportJSON → fromJSON → verifyChain）');

    // —— Tracer：主链路五步嵌套跟踪（跨域步骤树）——
    const tracer = new Tracer({ clock });
    const root = tracer.begin('pipeline', { kind: 'integration' });
    const steps = ['sentinel', 'decision', 'schedule', 'execute', 'reflect'];
    for (const s of steps) {
      const span = tracer.begin(s, { domain: s });
      clock.advance(5);
      tracer.end(span);
    }
    clock.advance(3);
    tracer.end(root);
    const tree = tracer.tree();
    ok(Array.isArray(tree) && tree.length === 1 && tree[0].name === 'pipeline' && tree[0].children.length === 5, `五域步骤在同一跟踪树（根 pipeline + 子 ${tree[0]?.children?.map((c) => c.name).join('/')}）`);
    ok(tree[0].children.every((c) => c.duration === 5) && tree[0].duration >= 28, `注入时钟下逐域耗时逐位（子步各 5ms，父步含子 ${tree[0].duration}ms）`);
  }

  // ═══════════════════ ③ 共生结算 → 账本哈希链 → 记忆沉淀 ═══════════════════

  section('③ A11 共生结算 × A5 记忆沉淀：执行结果铸币 → 链上可验 → 知识变资产');

  {
    const bridge = new SymbiosisBridge();
    bridge.registerModel('model-a');

    // —— ① 的执行结果（model-a 成功节点）→ 央行铸币分红 ——
    const dist = bridge.settleTask({
      success: pipeline.report.success,
      nodeResults: pipeline.report.nodeResults.map((n) => ({ modelId: n.modelId, success: n.success, quality: n.quality })),
    });
    ok(dist.totalDistributed > 0 && dist.shares.some((s) => s.agentId === 'model:model-a' && s.amount > 0), `任务结算铸币贯通（分发 ${dist.totalDistributed}，model-a 分得 ${dist.shares.find((s) => s.agentId === 'model:model-a')?.amount}）`);

    // —— 账本哈希链：显式封块（业务边界）→ 块间链接 + 整链校验 + 生态守恒 ——
    const ledger = bridge.runtime.ledger;
    const unsealed = ledger.unsealedCount();
    const sealed = ledger.sealBlock();
    const blocks = ledger.blocks();
    ok(sealed !== undefined && sealed.entryCount === unsealed && ledger.unsealedCount() === 0, `结算凭证封块入链（${unsealed} 笔在途凭证 → 块 #${sealed?.index}，entryCount=${sealed?.entryCount}）`);
    ok(blocks.length >= 1 && blocks.every((b, i) => (i === 0 ? b.prevBlockHash === '0'.repeat(64) : b.prevBlockHash === blocks[i - 1].hash)), `块间 prevHash 链接完整（${blocks.length} 块，创世锚 64×0）`);
    ok(ledger.verifyBlockChain().intact === true, '账本哈希链整链校验 intact（结算事实防篡改）');
    ok(ledger.verifyConservation() === true, '生态能量守恒（铸币无中生有检测通过）');

    // —— 记忆沉淀：同一任务再次成功 → frequency 累积；attachMemory 后挂卖上市场 ——
    const complexity = Math.min(1, pipeline.plan.nodes.length / 5);
    pipeline.memory.recordSuccess({
      taskType: 'deploy',
      complexity,
      features: ['deploy'],
      taskSummary: pipeline.deploySignal.description,
      plan: { objective: pipeline.plan.objective, nodes: pipeline.plan.nodes.map((n) => ({ id: n.id, description: n.description, type: n.type, dependsOn: n.dependsOn })), parallelismStrategy: pipeline.plan.parallelismStrategy },
      modelAssignments: Object.fromEntries(pipeline.report.nodeResults.map((n) => [n.nodeId, n.modelId])),
      totalLatency: pipeline.report.totalTime,
      qualityScores: Object.fromEntries(pipeline.report.nodeResults.map((n) => [n.nodeId, n.quality])),
      tokenCost: pipeline.report.totalTokens,
    });
    const pattern2 = pipeline.memory.getAllTaskPatterns()[0];
    ok(pattern2.frequency === pipeline.patternFrequency + 1, `同任务二次沉淀累积（frequency ${pipeline.patternFrequency} → ${pattern2.frequency}——记忆域幂等累积口径）`);

    bridge.attachMemory(pipeline.memory, { listingFrequencyThreshold: 1 });
    const kpi = {
      timestamp: T0,
      successRate: 0.9,
      avgQuality: 0.9,
      avgLatency: 900,
      cacheHitRate: 0.3,
      modelSuccessRates: { 'model-a': 0.95 },
      activeExecutions: 0,
    };
    await bridge.heartbeat(kpi);
    const marketSnap = bridge.runtime.market.snapshot();
    ok(marketSnap.listed >= 1, `记忆智能体把高置信模式挂上认知市场（listed=${marketSnap.listed}——沉淀知识成为可交易资产）`);
    const status = bridge.status();
    ok(status.conservationIntact === true && status.registeredModels.includes('model-a'), `共生生态状态健康（守恒 intact，注册模型 [${status.registeredModels.join(',')}]）`);
    const econ = bridge.economicSignals();
    ok(econ.has('model-a') && econ.get('model-a').multiplier > 0, `能量反哺调度数据源（model-a 经济信号：health ${econ.get('model-a').health.toFixed(2)}，乘数 ${econ.get('model-a').multiplier.toFixed(2)}——③→③ 调度闭环的交接面）`);
  }

  // ═══════════════════ ④ 仪表盘数据端点函数结构断言 ═══════════════════

  section('④ A15 仪表盘数据端点：kernel-map / gwt-bus / attention-market 载荷结构');

  {
    // —— kernel-map：空态（未注入旗标源）与常态（旗标合并）——
    const emptyMap = kernelMapPayload(undefined);
    ok(emptyMap.total === 98 && emptyMap.layers.length === 20 && emptyMap.flagged === 50 && emptyMap.enabled === 0, `内核地图空态：98 内核 × 20 层，50 旗标全缺省关（total=${emptyMap.total}）`);
    ok(emptyMap.note.includes('静态地图'), '空态说明诚实标注数据源缺席（introspect 未注入）');
    const boundMap = kernelMapPayload([{ name: 'attentionEconomy', enabled: true }, { name: 'globalWorkspace', enabled: true }, { name: 'attentionEconomy', enabled: false }]);
    ok(boundMap.enabled === 1 && boundMap.note.includes('introspect'), `旗标绑定合并（同名后写覆盖 + 仅 true 计开：enabled=${boundMap.enabled}/50）`);
    const layer20 = boundMap.layers.find((l) => l.index === 20);
    ok(
      layer20 !== undefined
        && layer20.kernels.some((k) => k.version === '96.0' && k.enabled === true)
        && layer20.kernels.some((k) => k.version === '99.0' && k.enabled === false)
        && layer20.kernels.every((k) => k.hasFlag === Boolean(k.flagName)),
      '第 20 层意识层五内核（96~100）在位：globalWorkspace 开 / attentionEconomy 被同名后写关闭 / hasFlag 与 flagName 同真值',
    );

    // —— gwt-bus：空态与常态（广播流步序降序）——
    const emptyBus = gwtBusPayload(undefined);
    ok(emptyBus.available === false && emptyBus.broadcasts.length === 0 && emptyBus.emptyState.length > 0, 'GWT 总线空态：未挂载诚实降级 + 提示语');
    const busView = gwtBusPayload({
      steps: 12,
      ignitionRatio: 0.25,
      entropy: 2.3,
      winCounts: [{ id: 'goal', wins: 5 }, { id: 'world', wins: 3 }],
      recentBroadcasts: [
        { step: 12, winner: 'goal', effectiveBid: 0.8, tags: ['self-heal'], ignited: true },
        { step: 11, winner: undefined, tags: [], ignited: false },
        { step: 10, winner: 'world', effectiveBid: 0.6, tags: ['drift'], ignited: true },
      ],
    });
    ok(busView.available === true && busView.steps === 12 && busView.ignitionRatio === 0.25 && busView.winCounts.length === 2, `GWT 总线常态：标量透传（steps/ignitionRatio/winCounts）`);
    ok(busView.broadcasts.map((b) => b.step).join(',') === '12,11,10', `广播流步序降序（最新在前：${busView.broadcasts.map((b) => b.step).join(',')}——96.0 绑定口径）`);

    // —— attention-market：空态与常态（VCG 支付按源聚合）——
    const emptyMarket = attentionMarketPayload(undefined);
    ok(emptyMarket.available === false && emptyMarket.rows.length === 0 && emptyMarket.emptyState.length > 0, '注意力市场空态：未挂载诚实降级 + 提示语');
    const market = attentionMarketPayload({
      slots: 3,
      awards: [
        { sourceId: 'errors', slotNumber: 1, marginal: 0.9 },
        { sourceId: 'errors', slotNumber: 2, marginal: 0.7 },
        { sourceId: 'curiosity', slotNumber: 3, marginal: 0.5 },
      ],
      payments: [
        { sourceId: 'errors', payment: 1.2 },
        { sourceId: 'curiosity', payment: 0.4 },
        { sourceId: 'idle-src', payment: 0.1 },
      ],
      marginalPrice: 0.3,
      idleSlots: 0,
      revenue: 1.7,
      insight: '读数句',
    });
    ok(market.available === true && market.slots === 3 && market.awarded === 3 && market.marginalPrice === 0.3 && market.revenue === 1.7, `注意力市场常态：槽位/边际价/收入透传（awarded=${market.awarded}/3）`);
    ok(market.rows.length === 3 && market.rows[0].sourceId === 'errors' && market.rows[0].slots === 2 && near(market.rows[0].totalMarginal, 1.6) && near(market.rows[0].payment, 1.2), `按源聚合：errors 2 槽边际合计 1.6 / VCG 支付 1.2 置顶（总边际降序）`);
    ok(market.rows.some((r) => r.sourceId === 'idle-src' && r.slots === 0 && r.payment === 0.1), '未获槽但被计支付的源保留完整账面（0 槽 0 边际仍可见）');
  }
} finally {
  // —— 清理：先关记忆库句柄（Windows 下 .db 文件占用中 unlink 会 EBUSY），再删临时目录 ——
  try {
    pipeline.memory?.dispose();
  } catch {
    /* 尽力而为：清理失败不影响断言结论 */
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 句柄释放竞态时遗留临时目录（os.tmpdir 下无害） */
  }
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— 第三轮 18 域升级跨域联合冒烟成立（主链路五域流水 / 遥测口径一致性 / 共生结算链上沉淀 / 仪表盘端点结构）`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
