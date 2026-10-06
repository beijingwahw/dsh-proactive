/**
 * verify-mod-pipeline.mjs — 第三轮模块域 A17 升级：插件入口（index.ts）与
 * engines-frontier 适配层五项升级的离线结构验证
 *
 * 覆盖面（与 A17 升级目标一一对应）：
 *   ① 10 步链路审计检查点：PIPELINE_STEPS 元数据完备（1~10 唯一）；
 *      PipelineAuditTrail 注入合成时钟 → begin/end 计时逐位可重放、
 *      mark 单点检查点、10 步全覆盖（coveredSteps=[1..10] / missingSteps=[]）、
 *      seq 严格递增且 at 单调不减（monotonic=true）、未知步序静默忽略、
 *      环形缓冲 FIFO 覆盖 + dropped 计数、未配对 end 诚实降级 durationMs=0、
 *      summary 逐步聚合（计数/时长直方图/结局）、reset 复位。
 *   ② ToolRegistry 入参校验与文档：validateToolInput 十二类非法入参全拒
 *      （非对象 / null / 缺必填 / null 必填 / 类型错 ×6 / 非有限数字 /
 *      枚举外）+ 合法入参全通过（必填在场 / 可选缺席 / 额外键放行 /
 *      枚举成员 / array/object/boolean 正型）；registry 级：14 工具注册、
 *      invoke 非法入参进 handler 前被拒（spy 证 handler 未被触碰）、合法
 *      路径 args 逐位透传（零漂移）、schemas() 官方 JSON Schema 文档、
 *      stats() 计数（calls/rejected/failures/lastCalledAt 注入时钟）、
 *      未知工具、register 覆盖重置、unregister、resetStats。
 *   ③ fiber 资源清理审计：ResourceRegistry 注册造册 → disposeAll 按注册
 *      逆序释放（spy 序列证明）、外部 markReleased 跳过（dispose 不再被
 *      调）、漏释放（无句柄未销账）显式 leaked 告警、释放抛错不阻断
 *      （errored 记账 + 后续继续释放）、audit() 只读不动资源、size 计数。
 *   ④ introspect 丰富化结构断言：KERNEL_FLAGS 恰 50 旗标（51.0~100.0
 *      各一次 / wave 1×25 + wave 2×25 / 名字唯一）；kernelFlagOverview
 *      缺省全关（enabled=0）、仅显式 === true 才开、总览结构字段齐备
 *      （total/enabled/disabled/flags）；introspect 三增量字段
 *      （kernelFlags / pipelineAudit / toolCalls）的产出口径结构断言。
 *   ⑤ 适配层建议化：genesis25 ×2（SpeculativePairingAdvisor.bestPair 的
 *      advice 建议结构 + 既有 verdict/drafterId/verifierId 字段保留、
 *      TestTimeComputePlanner.votePlan 的 advice + 既有 votes/ceiling
 *      保留）+ autonomy25 ×2（planFeasibilityVerdict 的 proceed/halt
 *      建议 + 脆弱性分档、askUserHandoffAdvice 的成本分解建议）——
 *      ≥3 适配器从纯数据升级为「建议+理由+置信」，既有字段零破坏。
 *
 * 确定性：全部时间走注入合成时钟；无真定时器、无真网络、无 I/O。
 *
 * 运行：npm run build && node scripts/verify-mod-pipeline.mjs
 */

import {
  PIPELINE_STEPS,
  PipelineAuditTrail,
  ResourceRegistry,
  KERNEL_FLAGS,
  kernelFlagOverview,
  validateToolInput,
  ToolRegistry,
  ToolError,
  SpeculativePairingAdvisor,
  TestTimeComputePlanner,
  planFeasibilityVerdict,
  askUserHandoffAdvice,
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
function near(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}
function section(title) {
  console.log(`\n■ ${title}`);
}
/** 合成时钟：每次读数 +stepMs（逐位可重放） */
function syntheticClock(stepMs = 10, start = 1_000) {
  let t = start;
  return () => {
    t += stepMs;
    return t;
  };
}

// ═══════════════════════════════════════════════════════════════
// ⓪ 10 步链路元数据
// ═══════════════════════════════════════════════════════════════
section('⓪ 10 步链路元数据（PIPELINE_STEPS 唯一事实源）');
ok(Array.isArray(PIPELINE_STEPS) && PIPELINE_STEPS.length === 10, `步序元数据恰 10 步（实际 ${PIPELINE_STEPS.length}）`);
ok(PIPELINE_STEPS.every((s, i) => s.step === i + 1), '步序 1~10 连续且升序');
ok(new Set(PIPELINE_STEPS.map((s) => s.key)).size === 10, '步 key 唯一（检查点归属无歧义）');
ok(PIPELINE_STEPS.every((s) => typeof s.label === 'string' && s.label.length > 0), '每步中文标签在案');

// ═══════════════════════════════════════════════════════════════
// ① PipelineAuditTrail：检查点收集器
// ═══════════════════════════════════════════════════════════════
section('① A17-1 10 步链路审计检查点（注入时钟 / 覆盖 10 步 / 时序单调）');

{
  const clock = syntheticClock(10);
  const trail = new PipelineAuditTrail({ now: clock });

  // begin/end 计时：注入时钟逐位可重放（两次读数差 = 10ms）
  trail.begin('t0', 1);
  const atBefore = 1_010 + 10; // begin 消耗 1 次读数 → end 时已 +20
  trail.end('t0', 1, 'ok', { signals: 3 }, { note: 'intake' });
  const first = trail.export()[0];
  ok(first !== undefined && first.step === 1 && first.stepKey === 'signal-intake', 'begin/end 落账第 1 步（signal-intake）');
  ok(first.at === atBefore && first.durationMs === 10, `注入时钟计时逐位可重放（at=${first.at}, durationMs=${first.durationMs}）`);
  ok(first.trace === 't0' && first.outcome === 'ok', '追踪 id 与结局落账');
  ok(first.decisions?.signals === 3 && first.detail?.note === 'intake', '关键决策值与细节结构化在案');

  // 全 10 步覆盖：mark 单点检查点
  for (let step = 1; step <= 10; step += 1) {
    trail.mark('batch-1', step, step % 3 === 0 ? 'fast-path' : 'ok', { step });
  }
  const summary = trail.summary();
  ok(JSON.stringify(summary.coveredSteps) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), '检查点收集器覆盖全部 10 步');
  ok(summary.missingSteps.length === 0, '缺步清单为空');
  ok(summary.monotonic === true, '导出序列时序单调（seq 严格递增 且 at 单调不减）');
  ok(summary.steps.length === 10 && summary.steps.every((s) => s.count >= 1), 'summary 逐步聚合 10 步齐备');
  ok(summary.steps[2].count === 1 && summary.steps[2].outcomes['fast-path'] === 1, '结局直方图按步聚合（第 3 步恰 1 条 fast-path）');
  ok(summary.steps[0].count === 2 && summary.steps[0].outcomes.ok === 2, '第 1 步跨 trace 双条目聚合（t0 计时 + batch-1 单点）');
  ok(summary.steps[0].totalDurationMs === 10, `逐步时长累加（第 1 步计时 10ms + 单点 0ms = ${summary.steps[0].totalDurationMs}ms）`);
  ok(summary.checkpoints === 11 && summary.dropped === 0, `缓冲计数准确（11 条 / dropped 0）`);

  // seq 严格递增
  const exported = trail.export();
  ok(exported.every((c, i) => i === 0 || c.seq === exported[i - 1].seq + 1), 'seq 全局严格递增（环形导出口径）');
  ok(exported.every((c) => c.durationMs === 0 || c.durationMs === 10), '时长口径一致（注入时钟 10ms/读数）');

  // 未知步序静默忽略（纯记录零行为影响）
  trail.mark('t0', 11, 'ok');
  trail.begin('t0', 0);
  trail.end('t0', 99, 'ok');
  ok(trail.summary().checkpoints === 11, '未知步序（0/11/99）静默忽略——纯记录不抛错不落账');

  // 未配对 end：诚实降级 durationMs = 0
  trail.end('t0', 5, 'orphan');
  const orphan = trail.export().at(-1);
  ok(orphan.step === 5 && orphan.durationMs === 0, '未配对 end 诚实降级（durationMs=0，不臆造时长）');

  // mark 恒 0 时长
  trail.mark('t0', 6, 'ok');
  ok(trail.export().at(-1).durationMs === 0, 'mark 单点检查点恒 0 时长');

  // 交错 trace：同名步互不串扰（openSpans 按 trace:step 隔离）
  const t2 = new PipelineAuditTrail({ now: syntheticClock(5) });
  t2.begin('a', 3);
  t2.begin('b', 3);
  t2.end('a', 3, 'ok');
  t2.end('b', 3, 'ok');
  const pair = t2.export();
  ok(pair.length === 2 && pair.every((c) => c.durationMs === 10), '多 trace 并行 begin/end 互不串扰（各自 10ms）');

  // reset
  trail.reset();
  ok(trail.summary().checkpoints === 0 && trail.summary().coveredSteps.length === 0, 'reset 复位缓冲与覆盖面');
}

{
  // 环形缓冲：容量 16 下限，FIFO 覆盖最旧 + dropped 计数，单调性保持
  const trail = new PipelineAuditTrail({ capacity: 1, now: syntheticClock(1) }); // 1 → 下限钳制 16
  for (let i = 0; i < 30; i += 1) trail.mark('overflow', (i % 10) + 1, 'ok', { i });
  const summary = trail.summary();
  const exported = trail.export();
  ok(exported.length === 16, `环形缓冲 FIFO 覆盖（30 条写入 → 缓冲 ${exported.length} 条）`);
  ok(summary.dropped === 14, `覆盖丢弃累计 ${summary.dropped} 条`);
  ok(summary.monotonic === true, '覆盖后导出序列时序仍单调');
  ok(exported[0].decisions?.i === 14 && exported.at(-1).decisions?.i === 29, '最旧被覆盖、最新保留（FIFO 语义）');
  ok(summary.coveredSteps.length === 10, '覆盖后覆盖面仍全 10 步');
}

// ═══════════════════════════════════════════════════════════════
// ② validateToolInput + ToolRegistry：入参校验与文档
// ═══════════════════════════════════════════════════════════════
section('② A17-2 Tool 入参校验（≥10 例非法全拒 / 合法通过 / schema 文档）');

/** 校验样例参数声明（口径镜像 index.ts 真实工具：必填/可选/枚举/各类型齐备） */
const sampleParams = {
  task: { type: 'string', description: '任务描述', required: true },
  urgency: { type: 'number', description: '紧急度 0~1' },
  query_type: { type: 'string', description: '查询类型', enum: ['overview', 'patterns', 'introspect'] },
  limit: { type: 'number', description: '条数上限' },
  flags: { type: 'array', description: '标签列表' },
  config: { type: 'object', description: '配置对象' },
  dry: { type: 'boolean', description: '演练模式' },
};

// —— 非法入参（12 例 ≥ 10）——
const rejects = [
  ['非对象入参（数组）', validateToolInput(sampleParams, [1, 2])],
  ['null 入参', validateToolInput(sampleParams, null)],
  ['缺必填 task', validateToolInput(sampleParams, { urgency: 0.5 })],
  ['必填显式 null', validateToolInput(sampleParams, { task: null })],
  ['string 型传 number', validateToolInput(sampleParams, { task: 42 })],
  ['number 型传 string', validateToolInput(sampleParams, { task: 't', urgency: 'high' })],
  ['number 型传 NaN', validateToolInput(sampleParams, { task: 't', urgency: Number.NaN })],
  ['number 型传 Infinity', validateToolInput(sampleParams, { task: 't', limit: Number.POSITIVE_INFINITY })],
  ['枚举外取值', validateToolInput(sampleParams, { task: 't', query_type: 'hack' })],
  ['array 型传 string', validateToolInput(sampleParams, { task: 't', flags: 'a,b' })],
  ['object 型传 array', validateToolInput(sampleParams, { task: 't', config: [1] })],
  ['boolean 型传 string', validateToolInput(sampleParams, { task: 't', dry: 'yes' })],
];
for (const [label, rejection] of rejects) {
  ok(typeof rejection === 'string' && rejection.length > 0, `非法入参拒：${label}（理由：「${rejection}」）`);
}
ok(rejects.filter(([, r]) => typeof r === 'string').length >= 10, `非法拒绝用例 ${rejects.filter(([, r]) => typeof r === 'string').length} 例（≥10 达标）`);

// —— 合法入参 ——
const accepts = [
  ['必填在场 + 全可选在场', { task: '部署', urgency: 0.8, query_type: 'overview', limit: 5, flags: ['a'], config: { k: 1 }, dry: true }],
  ['仅必填在场', { task: '部署' }],
  ['可选全缺席', { task: '部署' }],
  ['枚举成员取值', { task: 't', query_type: 'introspect' }],
  ['额外未声明键放行（additionalProperties: true 口径）', { task: 't', extra: '未声明键' }],
  ['零值合法（urgency=0 / limit=0）', { task: 't', urgency: 0, limit: 0 }],
];
for (const [label, args] of accepts) {
  ok(validateToolInput(sampleParams, args) === undefined, `合法入参通过：${label}`);
}

// —— registry 级：14 工具注册 / 拒在 handler 前 / 计数 / schema 文档 ——
section('② A17-2 ToolRegistry（14 工具注册 / 拒于 handler 之前 / 调用计数 / schema 导出）');

/** 14 个真实工具的参数声明镜像（名称/口径与 index.ts tools.register 一致） */
const realToolSpecs = [
  { name: 'autonomous_execute', description: '提交一个自主任务', parameters: { task: { type: 'string', description: '任务描述', required: true }, urgency: { type: 'number', description: '紧急度 0~1，缺省 0.8' } } },
  { name: 'model_dashboard', description: '查看模型状态', parameters: {} },
  { name: 'query_memory', description: '查询记忆库', parameters: { query_type: { type: 'string', description: '查询类型', required: true, enum: ['overview', 'patterns', 'introspect'] }, limit: { type: 'number', description: '返回条数上限' }, task_type: { type: 'string', description: '按任务类型过滤' } } },
  { name: 'query_experience', description: '检索历史经验', parameters: { task_type: { type: 'string', description: '任务类型' }, complexity: { type: 'number', description: '复杂度 0~1' }, features: { type: 'string', description: '特征标签' } } },
  { name: 'distill_knowledge', description: '触发知识蒸馏', parameters: {} },
  { name: 'mental_report', description: '心智报告', parameters: { action: { type: 'string', description: '动作', required: true, enum: ['generate', 'latest', 'history', 'trend', 'formatted'] }, limit: { type: 'number', description: '历史条数' } } },
  { name: 'self_knowledge', description: '自知之明报告', parameters: {} },
  { name: 'meta_cognition', description: '元认知查询', parameters: { metric: { type: 'string', description: '指标名', required: true } } },
  { name: 'maintain_memory', description: '维护记忆库', parameters: { action: { type: 'string', description: '维护动作', required: true, enum: ['prune', 'status'] }, maxAgeDays: { type: 'number', description: '保留天数' } } },
  { name: 'manage_tenants', description: '多租户管理', parameters: { action: { type: 'string', description: '管理动作', required: true, enum: ['list', 'register', 'remove', 'update', 'stats', 'match'] }, config: { type: 'object', description: '租户配置' }, tenantId: { type: 'string', description: '目标租户' } } },
  { name: 'manage_encryption', description: '加密管理', parameters: { action: { type: 'string', description: '动作', required: true, enum: ['status', 'rotate', 'verify'] } } },
  { name: 'memory_migration', description: '记忆迁移', parameters: { direction: { type: 'string', description: '方向', required: true, enum: ['import', 'export'] }, filePath: { type: 'string', description: '文件路径' } } },
  { name: 'manage_sync', description: '分布式同步管理', parameters: { action: { type: 'string', description: '动作', required: true, enum: ['status', 'force', 'metrics'] } } },
  { name: 'manage_consensus', description: '共识管理', parameters: { action: { type: 'string', description: '动作', required: true, enum: ['status', 'campaign', 'step-down'] } } },
];

const fixedNow = syntheticClock(100, 5_000);
let handlerCalls = 0;
const registry = new ToolRegistry({ now: fixedNow });
for (const spec of realToolSpecs) {
  registry.register({ ...spec, handler: async (args) => { handlerCalls += 1; return { echo: args }; } });
}
ok(registry.list().length === 14, `14 工具注册在册（实际 ${registry.list().length}）`);

// 合法路径：args 逐位透传（零漂移——handler 收到与升级前完全一致的入参）
const legal = await registry.invoke('autonomous_execute', { task: '检查部署', urgency: 0.7 });
ok(handlerCalls === 1 && legal.echo.task === '检查部署' && legal.echo.urgency === 0.7, '合法入参通过且 args 逐位透传（合法路径零漂移）');

// 非法入参：进 handler 之前被拒
const beforeCalls = handlerCalls;
let rejectedErr = undefined;
try {
  await registry.invoke('autonomous_execute', { urgency: 'high' });
} catch (e) {
  rejectedErr = e;
}
ok(rejectedErr instanceof ToolError && /入参校验失败/.test(rejectedErr.message), `非法入参以 ToolError 拒（${rejectedErr?.message}）`);
ok(handlerCalls === beforeCalls, '拒绝发生在进入 handler 之前（handler 零触碰）');

// 枚举外：同样被拒
let enumErr = undefined;
try {
  await registry.invoke('maintain_memory', { action: 'purge' });
} catch (e) {
  enumErr = e;
}
ok(enumErr instanceof ToolError && /枚举/.test(enumErr.message), '枚举外取值同样在 handler 前被拒');

// 未知工具
let unknownErr = undefined;
try {
  await registry.invoke('no_such_tool', {});
} catch (e) {
  unknownErr = e;
}
ok(unknownErr instanceof ToolError && /未知 Tool/.test(unknownErr.message), '未知工具名照旧抛 ToolError（既有语义不回归）');

// handler 失败：failures 计数且异常透传
registry.register({ name: 'boom', description: '注定失败', parameters: { x: { type: 'number', description: 'x', required: true } }, handler: async () => { handlerCalls += 1; throw new Error('boom'); } });
let boomErr = undefined;
try {
  await registry.invoke('boom', { x: 1 });
} catch (e) {
  boomErr = e;
}
ok(boomErr instanceof Error && boomErr.message === 'boom', 'handler 异常透传（不吞不换）');

// 计数口径：calls / rejected / failures / lastCalledAt（注入时钟）
const stats = registry.stats();
const byName = Object.fromEntries(stats.tools.map((t) => [t.name, t]));
ok(stats.total === 4, `总调用计数 ${stats.total}（合法 1 + 拒 2 + 炸 1）`);
ok(byName.autonomous_execute.calls === 2 && byName.autonomous_execute.rejected === 1 && byName.autonomous_execute.failures === 0, 'autonomous_execute 计数：calls=2 / rejected=1 / failures=0');
ok(byName.boom.calls === 1 && byName.boom.failures === 1, 'boom 计数：calls=1 / failures=1');
ok(byName.autonomous_execute.lastCalledAt !== undefined && byName.autonomous_execute.lastCalledAt > 5_000, `lastCalledAt 走注入时钟（${byName.autonomous_execute.lastCalledAt}）`);
ok(registry.list().every((t) => stats.tools.some((s) => s.name === t.name)), '每工具计数条目齐备（含 0 调用工具）');

// register 覆盖重置 / unregister / resetStats
registry.register({ name: 'boom', description: '重生', parameters: {}, handler: async () => 'ok' });
ok(registry.stats().tools.find((t) => t.name === 'boom').calls === 0, '重名 register 覆盖时计数重置');
registry.unregister('boom');
ok(!registry.stats().tools.some((t) => t.name === 'boom'), 'unregister 后统计条目移除');
registry.resetStats();
ok(registry.stats().total === 0, 'resetStats 清零调用统计（不动注册表）');

// schemas() 官方 JSON Schema 文档
const schemas = registry.schemas();
ok(schemas.length === 14, `schemas() 导出 14 份文档（实际 ${schemas.length}）`);
const execSchema = schemas.find((s) => s.name === 'autonomous_execute');
ok(execSchema.schema.type === 'object' && execSchema.schema.additionalProperties === true, 'schema 根：object + additionalProperties: true（官方子集口径）');
ok(JSON.stringify(execSchema.schema.required) === JSON.stringify(['task']), 'schema.required 与声明一致（task）');
ok(execSchema.schema.properties.urgency.type === 'number' && execSchema.schema.properties.task.type === 'string', 'schema.properties 类型映射正确');
const memSchema = schemas.find((s) => s.name === 'query_memory');
ok(JSON.stringify(memSchema.schema.properties.query_type.enum) === JSON.stringify(['overview', 'patterns', 'introspect']), 'schema.enum 完整导出');
const objSchema = registry.schemas();
ok(objSchema.every((s) => s.description && typeof s.description === 'string'), '每份 schema 文档附工具描述（introspect 消费面）');

// ═══════════════════════════════════════════════════════════════
// ③ ResourceRegistry：资源清理审计
// ═══════════════════════════════════════════════════════════════
section('③ A17-3 fiber 资源清理审计（逆序释放 / 漏检告警 / 出错不阻断）');

{
  // 场景 A：干净卸载——释放序 = 注册序的逆
  const clock = syntheticClock(50, 10_000);
  const reg = new ResourceRegistry({ now: clock });
  const releaseOrder = [];
  const idA = reg.register('interval', () => releaseOrder.push('interval'), 'tick');
  const idB = reg.register('fiber', () => releaseOrder.push('fiber'), 'autonomy-loop');
  const idC = reg.register('listener', () => releaseOrder.push('listener'), 'host-tool#0');
  const idD = reg.register('persist', () => releaseOrder.push('persist'), 'memory-graph');
  ok(reg.size === 4, `登记造册 4 项资源（id ${idA}~${idD} 连续编号）`);
  const report = reg.disposeAll();
  ok(JSON.stringify(releaseOrder) === JSON.stringify(['persist', 'listener', 'fiber', 'interval']), `disposeAll 按注册逆序释放（${releaseOrder.join(' → ')}）`);
  ok(report.registered === 4 && report.released === 4 && report.leaked === 0 && report.errored === 0 && report.held === 0, `审计报告四态清零核对（released=4 / leaked=0 / errored=0）`);
  ok(JSON.stringify(report.releaseOrder.map((r) => r.label)) === JSON.stringify(['memory-graph', 'host-tool#0', 'autonomy-loop', 'tick']), '报告中 releaseOrder 记录实际逆序释放序列');
  ok(report.entries.every((e) => e.status === 'released' && e.releasedOrder !== undefined && e.releasedAt >= 10_000), '每条登记落销账三件套（status/releasedOrder/releasedAt 注入时钟）');
  ok([report.entries.find((e) => e.id === idD).releasedOrder, report.entries.find((e) => e.id === idA).releasedOrder].join(',') === '1,4', '释放序号 1=最后注册者（逆序的数学口径）');
  ok(reg.size === 0, '释放后 size 归零');
}

{
  // 场景 B：外部销账——已 markReleased 的资源不再被 dispose
  const reg = new ResourceRegistry();
  let disposed = 0;
  reg.register('server', () => { disposed += 1; }, 'raft');
  const external = reg.register('watcher', () => { disposed += 1; }, 'sentinel');
  ok(reg.markReleased(external) === true, 'markReleased 外部销账成功');
  ok(reg.markReleased(external) === false, '重复销账被拒（幂等保护）');
  ok(reg.markReleased(9999) === false, '未知 id 销账被拒');
  const report = reg.disposeAll();
  ok(disposed === 1, '已销账资源的 dispose 句柄不再被调用（防双重释放）');
  ok(report.released === 2 && report.entries.find((e) => e.id === external).releasedOrder !== undefined, '外部销账同样计入 released 与释放序');
}

{
  // 场景 C：漏释放检测——登记无句柄且未销账 → leaked 告警
  const reg = new ResourceRegistry();
  reg.register('interval', undefined, 'tick');
  reg.register('fiber', () => {}, 'loop');
  reg.register('listener', undefined, 'orphan-listener');
  const preAudit = reg.audit();
  ok(preAudit.held === 1 && preAudit.leaked === 2 && preAudit.released === 0, `卸载前审计快照：1 held / 2 leaked 候选`);
  const report = reg.disposeAll();
  ok(report.leaked === 2, `disposeAll 后漏释放显式告警（leaked=2）`);
  const leaked = report.entries.filter((e) => e.status === 'leaked');
  ok(JSON.stringify(leaked.map((e) => e.label)) === JSON.stringify(['tick', 'orphan-listener']), `漏释放名单定位到条目（${leaked.map((e) => `${e.kind}:${e.label}`).join(', ')}）`);
}

{
  // 场景 D：释放抛错不阻断——后续资源继续释放
  const reg = new ResourceRegistry();
  const after = [];
  reg.register('a', () => after.push('a'), 'first');
  reg.register('b', () => { throw new Error('dispose 失败演练'); }, 'bad');
  reg.register('c', () => after.push('c'), 'last');
  const report = reg.disposeAll();
  ok(JSON.stringify(after) === JSON.stringify(['c', 'a']), 'bad 抛错后 a 仍被释放（逆序：c → bad → a，链条不断）');
  ok(report.errored === 1 && report.released === 2, '审计报告 errored=1 / released=2');
  const badEntry = report.entries.find((e) => e.id === 2);
  ok(badEntry.status === 'error' && /演练/.test(badEntry.error), `出错条目 status=error 且错误消息在案（「${badEntry.error}」）`);

  // audit() 只读——不释放任何资源
  const reg2 = new ResourceRegistry();
  let count = 0;
  reg2.register('x', () => { count += 1; }, 'x');
  const snap = reg2.audit();
  ok(count === 0 && snap.held === 1 && snap.releaseOrder.length === 0, 'audit() 只读快照（dispose 零调用、releaseOrder 空）');
}

// ═══════════════════════════════════════════════════════════════
// ④ introspect 丰富化：内核旗标总览（50）+ 结构断言
// ═══════════════════════════════════════════════════════════════
section('④ A17-4 introspect 丰富化（内核旗标总览 50 / 摘要结构 / 计数结构）');

ok(KERNEL_FLAGS.length === 50, `KERNEL_FLAGS 恰 50 个旗标（实际 ${KERNEL_FLAGS.length}）`);
ok(new Set(KERNEL_FLAGS.map((f) => f.name)).size === 50, '旗标名唯一（kernels.* 命名空间无碰撞）');
const versions = KERNEL_FLAGS.map((f) => Number(f.version)).sort((a, b) => a - b);
ok(versions[0] === 51 && versions[49] === 100 && new Set(versions).size === 50, `版本覆盖 51.0~100.0 各恰一次（${versions[0]}.0 → ${versions[49]}.0）`);
ok(KERNEL_FLAGS.filter((f) => f.wave === 1).length === 25 && KERNEL_FLAGS.filter((f) => f.wave === 2).length === 25, '两轮创世纪各 25 旗标（wave 1×25 + wave 2×25）');
ok(KERNEL_FLAGS.every((f) => typeof f.scope === 'string' && f.scope.length > 0), '每旗标标注挂载点引擎（scope）');

// 缺省全关（零漂移的旗标面证明）
const offOverview = kernelFlagOverview(undefined);
ok(offOverview.total === 50 && offOverview.enabled === 0 && offOverview.disabled === 50, '缺省总览：total=50 / enabled=0 / disabled=50（全关）');
ok(offOverview.flags.every((f) => f.enabled === false), '无配置时全部旗标 enabled=false');

// 仅显式 === true 才开
const partial = kernelFlagOverview({
  speculativeDecoding: { enabled: true },
  testTimeCompute: { enabled: false },
  selfBoundary: { enabled: true },
  noveltySentinel: {},
});
ok(partial.enabled === 2 && partial.disabled === 48, '显式 true ×2 → enabled=2（false / 缺席 / 空对象全不计）');
ok(partial.flags.find((f) => f.name === 'speculativeDecoding').enabled === true, '51.0 speculativeDecoding 开启态正确读出');
ok(partial.flags.find((f) => f.name === 'testTimeCompute').enabled === false, '显式 false 不开启（缺省关闭语义）');
ok(partial.flags.find((f) => f.name === 'selfBoundary').enabled === true && partial.flags.find((f) => f.name === 'selfBoundary').version === '100.0', '100.0 selfBoundary（wave 2）开启态正确读出');
ok(partial.flags.every((f) => 'name' in f && 'version' in f && 'wave' in f && 'scope' in f), '旗标态 = 元数据 + enabled（结构完整）');

// introspect 增量字段的结构断言（kernelFlags / pipelineAudit / toolCalls 三产出口径）
ok(['total', 'enabled', 'disabled', 'flags'].every((k) => k in offOverview), 'introspect.kernelFlags 字段在（total/enabled/disabled/flags）');
{
  const trail = new PipelineAuditTrail({ now: syntheticClock(10) });
  for (let s = 1; s <= 10; s += 1) trail.mark('b1', s, 'ok');
  const auditSummary = trail.summary();
  ok(['steps', 'coveredSteps', 'missingSteps', 'checkpoints', 'dropped', 'monotonic'].every((k) => k in auditSummary), 'introspect.pipelineAudit 字段在（审计轨迹摘要六字段）');
  ok(auditSummary.steps.length === 10, '审计轨迹摘要含 10 步聚合');
}
{
  const tools = new ToolRegistry({ now: () => 1 });
  tools.register({ name: 't', description: 'd', parameters: {}, handler: async () => 1 });
  await tools.invoke('t', {});
  const callStats = tools.stats();
  ok(['total', 'tools'].every((k) => k in callStats), 'introspect.toolCalls 字段在（total/tools）');
  ok(callStats.tools[0].calls === 1 && ['name', 'calls', 'rejected', 'failures'].every((k) => k in callStats.tools[0]), '工具调用计数结构齐备（name/calls/rejected/failures）');
}

// ═══════════════════════════════════════════════════════════════
// ⑤ 适配层建议化（engines-frontier genesis25 ×2 + autonomy25 ×2）
// ═══════════════════════════════════════════════════════════════
section('⑤ A17-5 适配层建议化（建议 + 理由 + 置信；既有字段零破坏）');

// —— 51.0 SpeculativePairingAdvisor（genesis25）——
{
  const advisor = new SpeculativePairingAdvisor();
  const good = advisor.bestPair(
    [
      { id: 'cheap', costPerCall: 1, posteriorMean: 0.9 },
      { id: 'strong', costPerCall: 100, posteriorMean: 0.95 },
      { id: 'mid', costPerCall: 50, posteriorMean: 0.7 },
    ],
    'deploy',
  );
  ok(good !== undefined, 'bestPair 产出配对裁决');
  ok(good.drafterId === 'cheap' && good.verifierId === 'strong' && good.taskType === 'deploy', '既有字段保留：drafterId/verifierId/taskType');
  ok(good.verdict !== undefined && typeof good.verdict.adopt === 'boolean', '既有字段保留：verdict（内核经济裁决）');
  const advice = good.advice;
  ok(advice !== undefined && typeof advice.recommend === 'boolean' && advice.recommend === good.verdict.adopt, `建议结构与内核裁决一致（recommend=${advice.recommend}）`);
  ok(typeof advice.reason === 'string' && advice.reason.length > 10, '理由文本在案（闭式经济口径）');
  ok(advice.confidence >= 0 && advice.confidence <= 1, `置信度 ∈ [0,1]（${advice.confidence.toFixed(2)}）`);
  ok(['speedup', 'costRatio', 'breakEvenGamma', 'margin', 'optimalK'].every((k) => k in advice.economics), '建议数值依据（economics 分解）齐备');

  // 拒绝口径：γ̂=0.042 ≪ 盈亏平衡 0.9（贵草稿低接受率）→ recommend=false
  const bad = advisor.bestPair(
    [
      { id: 'weak', costPerCall: 90, posteriorMean: 0.2 },
      { id: 'strong', costPerCall: 100, posteriorMean: 0.95 },
    ],
    'deploy',
  );
  ok(bad.advice.recommend === false && bad.advice.recommend === bad.verdict.adopt, '拒绝场景建议一致（γ 低于盈亏平衡 → 不采纳）');
  ok(bad.advice.confidence >= 0 && bad.advice.confidence <= 1, '拒绝场景置信度仍在 [0,1]');

  // 单候选不足 → undefined（诚实拒绝不变）
  ok(advisor.bestPair([{ id: 'only', costPerCall: 1, posteriorMean: 0.9 }], 't') === undefined, '候选不足照旧诚实返回 undefined（零漂移）');
}

// —— 52.0 TestTimeComputePlanner（genesis25）——
{
  const planner = new TestTimeComputePlanner();
  for (let i = 0; i < 25; i += 1) planner.note('deploy', true);
  const plan = planner.votePlan('deploy', 0.9);
  ok(['taskType', 'urgency', 'p', 'target', 'votes', 'ceiling', 'upgrade', 'rationale'].every((k) => k in plan), '既有字段保留：votes/ceiling/rationale 等八字段');
  const advice = plan.advice;
  ok(advice !== undefined && ['recommend', 'reason', 'confidence', 'reachMargin'].every((k) => k in advice), '建议结构齐备（recommend/reason/confidence/reachMargin）');
  ok(advice.recommend === plan.upgrade, `建议与既有 upgrade 结论一致（${advice.recommend}）`);
  ok(typeof advice.reason === 'string' && advice.reason.length > 10, '理由文本在案（可达性边际口径）');
  ok(advice.confidence >= 0 && advice.confidence <= 1, `置信度 ∈ [0,1]（${advice.confidence.toFixed(2)}）`);
  ok(near(advice.reachMargin, plan.ceiling - plan.target, 5e-3), 'reachMargin = 天花板 − 目标（数值自洽）');

  // 冷启动 p̂=0.5：投票不可达目标 → 建议保持单路
  const cold = new TestTimeComputePlanner().votePlan('cold-type', 0.9);
  ok(cold.upgrade === false && cold.advice.recommend === false, 'p̂=0.5 不可达目标 → 建议保持单路（诚实拒绝建议化）');
  ok(cold.advice.reason.includes('天花板'), '拒绝理由给出不可达解释');
}

// —— 85.0 planFeasibilityVerdict（autonomy25）——
{
  // 可行 DAG：a → b → c（汇 c 强制）
  const feasible = planFeasibilityVerdict([
    { id: 'a' },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['b'] },
  ]);
  ok(feasible !== undefined && feasible.feasible === true, '既有字段保留：feasible 裁决（SAT）');
  ok(feasible.cnf !== undefined && feasible.solve !== undefined && Array.isArray(feasible.selectedIds), '既有字段保留：cnf/solve/selectedIds');
  ok(typeof feasible.insight === 'string', '既有字段保留：insight');
  const advice = feasible.advice;
  ok(['recommend', 'reason', 'confidence', 'fragility'].every((k) => k in advice), '建议结构齐备（recommend/reason/confidence/fragility）');
  ok(advice.recommend === 'proceed' && advice.fragility !== 'infeasible', '可行计划建议 proceed');
  ok(advice.confidence >= 0 && advice.confidence <= 1, `置信度 ∈ [0,1]（${advice.confidence}）`);
  ok(typeof advice.reason === 'string' && advice.reason.length > 10, '理由文本在案（分支/冲突账单口径）');

  // 不可行：a⊥b 互斥且双强制 → UNSAT → halt
  const infeasible = planFeasibilityVerdict(
    [
      { id: 'a', exclusiveWith: ['b'] },
      { id: 'b', exclusiveWith: ['a'] },
    ],
    { mandatory: ['a', 'b'] },
  );
  ok(infeasible.feasible === false && infeasible.advice.recommend === 'halt' && infeasible.advice.fragility === 'infeasible', 'UNSAT 计划建议 halt（动手前判死）');
  ok(infeasible.advice.reason.includes('冲突'), '拒绝理由引用冲突账单');
}

// —— 95.0 askUserHandoffAdvice（autonomy25）——
{
  const ask = askUserHandoffAdvice({ pError: 0.8, costAuto: 100, costHuman: 5, delayCost: 1 });
  ok(ask !== undefined, 'ask-user 裁决产出');
  ok(['policy', 'action', 'expectedAutoCost', 'threshold', 'insight'].every((k) => k in ask), '既有字段保留：policy/action/insight 等');
  const advice = ask.advice;
  ok(['recommend', 'reason', 'confidence', 'costBreakdown'].every((k) => k in advice), '建议结构齐备（recommend/reason/confidence/costBreakdown）');
  ok(advice.recommend === 'ask-user', '高风险（x=80 ≫ τ*=6）建议 ask-user');
  ok(advice.confidence >= 0 && advice.confidence <= 1, `置信度 ∈ [0,1]（${advice.confidence.toFixed(2)}）`);
  const cb = advice.costBreakdown;
  ok(near(cb.expectedAutoCost, 80, 1e-6) && near(cb.handoffFullCost, 6, 1e-6), '成本分解：x=p·c_auto=80 / τ*=c_H+c_delay=6（闭式口径）');
  ok(near(cb.margin, cb.expectedAutoCost - cb.handoffFullCost, 5e-3) && near(cb.expectedSaving, Math.abs(cb.margin), 5e-3), '成本分解自洽（margin = x − τ*；saving = |margin|）');
  ok(advice.recommend === (ask.action === 'human' ? 'ask-user' : 'execute'), '建议与既有 action 结论一致');

  const exec = askUserHandoffAdvice({ pError: 0.01, costAuto: 10, costHuman: 5, delayCost: 1 });
  ok(exec.advice.recommend === 'execute', '低风险（x=0.1 ≪ τ*）建议自动执行');
  ok(exec.advice.reason.includes('低于'), '执行理由给出成本对照');
  ok(askUserHandoffAdvice({ pError: 1.5, costAuto: 10, costHuman: 5 }) === undefined, '非法入参照旧诚实返回 undefined（零漂移）');
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— A17 插件入口五项升级（10 步审计 / 工具校验 / 资源清理审计 / introspect 丰富化 / 适配层建议化）验证成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
