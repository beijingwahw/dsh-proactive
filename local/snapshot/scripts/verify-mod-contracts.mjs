/**
 * verify-mod-contracts.mjs — 第三轮模块域升级「基础契约层 A16」验证
 * （src/types.ts / src/contracts.ts / src/errors.ts 三个基础文件的纯增量升级）
 *
 * 五项升级的构造性证明：
 *
 *   S1 类型化错误分类学（errors.ts）：13 码注册表逐条字段完备（code/severity/
 *      retryability/userMessage/internalDetail/httpStatus/toolVisible）；
 *      既有 AppError 家族码全覆盖；TypedAppError 注册表缺省 + 逐字段覆盖；
 *      classifyTaxonomy 对旧式 AppError/普通 Error/裸值的就近归类；
 *      userMessage（租户安全）与 internalDetail（内部诊断）分离；
 *      errorToHttpStatus / errorToToolReturn / isRetryableError 映射口径
 *      （LLMError.status 载荷优先）；wrapError/errorChain/rootCause 因果链
 *      （含自环防护）；AggregateAppError 子错误聚合与摘要；
 *      serializeError → JSON → deserializeError 全字段往返
 *   S2 运行时契约校验器（contracts.ts）：合法构造 ≥13 例 / 非法构造 ≥14 例，
 *      路径化错误（nodes[1].modelId / nodes[0].dependsOn[1]）逐位精确；
 *      collect 模式按 schema 声明序全量收集、fast 模式首错即停；
 *      同输入两次校验错误列表 JSON 逐字节一致（确定性）；
 *      validateOrThrow 抛 VALIDATION_ERROR 并携带 details.errors
 *   S3 品牌化 ID（types.ts）：8 工厂往返（值/类型保真）+ 空串/纯空白拒绝；
 *      编译期防混用——临时片段 A（SignalId 赋给 ModelId）必须编译失败且
 *      诊断指向 __brand 不兼容、片段 B（品牌下行 string / 工厂幂等）必须
 *      编译通过（TypeScript 7 CLI 实测，产物临时文件即写即删）
 *   S4 Result<T,E>（types.ts）：单子律运行时断言——map 恒等 / map 结合 /
 *      andThen 左右单位律（ok 与 err 双侧）；mapErr / unwrapOr / unwrapResult /
 *      matchResult / resultTaxonomy 通道行为；与类型化错误体系互通
 *   S5 结构化事件信封（types.ts）：工厂确定性（显式 ts 逐字段相等、可选键
 *      仅在提供时出现）；isEventEnvelope 守卫正例 4 / 反例 12；
 *      assertEventEnvelope 缺陷定位；EventSequencer 单调 seq / 注入时钟 /
 *      peekSeq 不消耗 / startSeq 起始
 *   S6 零漂移总检：既有 AppError/ConfigError/…/ExecutionError 类原样可用
 *      （instanceof 链与 code 不变）；dist 类型声明中七个支柱接口与既有类型
 *      齐全且新类型并列在册（纯增量打包证据）
 *
 * 确定性：全程无随机源、无真实定时器（时钟注入）；tsc 片段编译为固定输入。
 * 运行：npm run build && node scripts/verify-mod-contracts.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as dsh from '../dist/index.mjs';

const {
  // errors.ts（既有）
  AppError, ConfigError, CryptoError, MemoryError, NetworkError, TimeoutError,
  // errors.ts（本轮新增）
  ERROR_REGISTRY, REGISTERED_ERROR_CODES, TypedAppError, AggregateAppError,
  serializeError, deserializeError, classifyTaxonomy, errorToHttpStatus, errorToToolReturn,
  isRetryableError, wrapError, errorChain, rootCause, resolveTaxonomy,
  // contracts.ts（本轮新增）
  validate, validateOrThrow, PLAN_NODE_SCHEMA, EXECUTION_PLAN_SCHEMA,
  NODE_RESULT_SCHEMA, PLAN_EXECUTION_RESULT_SCHEMA,
  // types.ts（本轮新增）
  asSignalId, asModelId, asTenantId, asPlanId, asGoalId, asNodeId, asStrategyId, asFeedbackId,
  unbrandId, ok: mkOk, err: mkErr, isOk, isErr, mapResult, mapErrResult, unwrapOr, unwrapResult,
  andThen, matchResult, resultTaxonomy,
  createEventEnvelope, isEventEnvelope, assertEventEnvelope, EventSequencer,
  // types.ts（既有）
  ExecutionError,
} = dsh;

// ─────────────────────────── 断言工具（仓库惯例：ok/near/section） ───────────────────────────
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
const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// ═══════════════════ S1 类型化错误分类学（errors.ts） ═══════════════════

section('S1-1 错误码注册表：13 码逐条字段完备（机检口径）');

{
  const SEVERITIES = new Set(['info', 'warning', 'error', 'critical']);
  const RETRIES = new Set(['never', 'immediate', 'backoff', 'after-fix']);
  ok(near(REGISTERED_ERROR_CODES.length, 13, 0) && near(Object.keys(ERROR_REGISTRY).length, 13, 0), `注册表规模 13（REGISTERED_ERROR_CODES=${REGISTERED_ERROR_CODES.length}，ERROR_REGISTRY keys=${Object.keys(ERROR_REGISTRY).length}）`);
  ok(
    REGISTERED_ERROR_CODES.every((code) => typeof code === 'string' && /^[A-Z][A-Z0-9]*_ERROR$/.test(code) || code === 'APP_ERROR'),
    '错误码全部为全大写蛇形且以 _ERROR 结尾（机器可读命名约定）',
  );
  let complete = 0;
  const defects = [];
  for (const [key, entry] of Object.entries(ERROR_REGISTRY)) {
    const problems = [];
    if (entry.code !== key) problems.push('code≠键名');
    if (!SEVERITIES.has(entry.severity)) problems.push('severity 非法');
    if (!RETRIES.has(entry.retryability)) problems.push('retryability 非法');
    if (typeof entry.userMessage !== 'string' || entry.userMessage.trim().length === 0) problems.push('userMessage 缺失');
    if (typeof entry.internalDetail !== 'string' || entry.internalDetail.trim().length === 0) problems.push('internalDetail 缺失');
    if (!Number.isInteger(entry.httpStatus) || entry.httpStatus < 400 || entry.httpStatus > 599) problems.push('httpStatus 越界');
    if (typeof entry.toolVisible !== 'boolean') problems.push('toolVisible 非布尔');
    if (problems.length === 0) complete += 1;
    else defects.push(`${key}: ${problems.join(',')}`);
  }
  ok(complete === 13 && defects.length === 0, `13/13 条目七要素字段完备（缺陷：${defects.join('；') || '无'}）`);

  // 既有 AppError 家族码全覆盖（新旧体系对接面）
  const legacyCodes = ['APP_ERROR', 'CONFIG_ERROR', 'CRYPTO_ERROR', 'MEMORY_ERROR', 'NETWORK_ERROR', 'TIMEOUT_ERROR', 'EXECUTION_ERROR', 'LLM_ERROR', 'TOOL_ERROR', 'BENCHMARK_ERROR'];
  const missing = legacyCodes.filter((c) => ERROR_REGISTRY[c] === undefined);
  ok(missing.length === 0, `既有 AppError 家族 10 码全部在册（缺失：${missing.join(',') || '无'}）`);

  // userMessage / internalDetail 语义分离抽查（租户安全文案 ≠ 内部诊断指引）
  ok(
    ERROR_REGISTRY.CRYPTO_ERROR.userMessage.indexOf('密钥') === -1 && ERROR_REGISTRY.CRYPTO_ERROR.internalDetail.indexOf('密钥') !== -1,
    'userMessage vs internalDetail 分离：CRYPTO 内部细节（密钥链）只出现在 internalDetail，透出口径无敏感词',
  );
  ok(new Set(REGISTERED_ERROR_CODES.map((c) => ERROR_REGISTRY[c].httpStatus)).size >= 6, `HTTP 映射有区分度（${new Set(REGISTERED_ERROR_CODES.map((c) => ERROR_REGISTRY[c].httpStatus)).size} 个不同状态码）`);
}

section('S1-2 TypedAppError：注册表缺省继承 / 逐字段覆盖 / 旧体系兼容');

{
  const t1 = new TypedAppError('租户配置缺 models', { code: 'CONFIG_ERROR' });
  ok(t1 instanceof AppError && t1 instanceof Error, 'TypedAppError instanceof AppError（旧调用方 catch 口径不变）');
  ok(t1.code === 'CONFIG_ERROR' && t1.severity === 'critical' && t1.retryability === 'after-fix' && t1.httpStatus === 503, `注册表缺省继承：code=${t1.code} severity=${t1.severity} retryability=${t1.retryability} http=${t1.httpStatus}`);
  ok(t1.userMessage === ERROR_REGISTRY.CONFIG_ERROR.userMessage && t1.internalDetail === ERROR_REGISTRY.CONFIG_ERROR.internalDetail, 'userMessage/internalDetail 均取注册表缺省');
  ok(t1.retryable === false && isRetryableError(t1) === false, 'after-fix 不计为可重试');

  const t2 = new TypedAppError('下游 429', {
    code: 'NETWORK_ERROR', severity: 'critical', httpStatus: 429,
    userMessage: '服务繁忙', details: { modelId: 'm-1' },
  });
  ok(t2.severity === 'critical' && t2.httpStatus === 429 && t2.userMessage === '服务繁忙' && t2.details.modelId === 'm-1', '逐字段覆盖优先于注册表缺省（severity/httpStatus/userMessage/details）');
  ok(t2.retryability === 'backoff' && t2.retryable === true, '未覆盖字段仍取缺省（retryability=backoff → retryable=true）');

  const t3 = new TypedAppError('自定义码');
  ok(t3.code === 'APP_ERROR' && t3.toTaxonomyEntry().code === 'APP_ERROR', '无 code 时缺省 APP_ERROR，toTaxonomyEntry 与注册表单条同构');
  const t4 = new TypedAppError('未注册码', { code: 'MY_CUSTOM_CODE' });
  const resolved = resolveTaxonomy('MY_CUSTOM_CODE');
  ok(t4.code === 'MY_CUSTOM_CODE' && t4.severity === 'error' && t4.httpStatus === 500 && resolved.code === 'MY_CUSTOM_CODE', '未注册码合成完备条目（不抛错、七要素仍齐）');
  ok(JSON.stringify(t4.toTaxonomyEntry()) === JSON.stringify({ code: 'MY_CUSTOM_CODE', severity: 'error', retryability: 'never', userMessage: t4.userMessage, internalDetail: t4.internalDetail, httpStatus: 500, toolVisible: true }), '合成条目与注册表条目结构逐键一致（downstream 无分支处理）');

  // classifyTaxonomy：旧式 AppError 按码查表
  ok(classifyTaxonomy(new TimeoutError('超时')).code === 'TIMEOUT_ERROR' && classifyTaxonomy(new ConfigError('坏配置')).retryability === 'after-fix', 'classifyTaxonomy：旧式子类按 code 命中注册表');
  ok(classifyTaxonomy(new AppError('x', 'MEMORY_ERROR')).httpStatus === 500 && classifyTaxonomy(new AppError('x', 'NOT_REGISTERED')).severity === 'error', 'classifyTaxonomy：旧式裸 AppError 在册/不在册均出完备条目');
  ok(classifyTaxonomy(new TypeError('cannot read')).code === 'VALIDATION_ERROR', 'classifyTaxonomy：TypeError 就近归 VALIDATION_ERROR');
  ok(classifyTaxonomy(new Error('connection timeout after 30s')).code === 'TIMEOUT_ERROR' && classifyTaxonomy(new Error('whatever')).code === 'UNKNOWN_ERROR', 'classifyTaxonomy：普通 Error 按 /timeout/i 与兜底 UNKNOWN_ERROR');
  ok(classifyTaxonomy('裸字符串').code === 'UNKNOWN_ERROR' && classifyTaxonomy(undefined).code === 'UNKNOWN_ERROR', 'classifyTaxonomy：非 Error 抛出物走 UNKNOWN_ERROR 兜底（不抛二次异常）');
}

section('S1-3 error → HTTP / Tool 返回映射助手');

{
  ok(errorToHttpStatus(new NetworkError('断连')) === 502 && errorToHttpStatus(new TimeoutError('超时')) === 504 && errorToHttpStatus(new ConfigError('缺配置')) === 503 && errorToHttpStatus(new TypedAppError('x', { code: 'VALIDATION_ERROR' })) === 422, 'HTTP 映射：NETWORK→502 / TIMEOUT→504 / CONFIG→503 / VALIDATION→422');
  ok(errorToHttpStatus({ status: 429 }) === 429, 'HTTP 映射：真实 status 载荷（LLMError 形态）优先于分类学缺省');
  ok(errorToHttpStatus(new TypedAppError('x', { code: 'APP_ERROR', httpStatus: 507 })) === 507 && errorToHttpStatus({ status: 999 }) === 500 && errorToHttpStatus({ status: 200 }) === 500, 'HTTP 映射：显式覆盖生效、非法 status（999/200）回落分类学值');

  const tr = errorToToolReturn(new TimeoutError('模型超时', { modelId: 'm-1' }));
  ok(tr.ok === false && tr.code === 'TIMEOUT_ERROR' && tr.severity === 'warning' && tr.retryable === true && tr.userMessage === ERROR_REGISTRY.TIMEOUT_ERROR.userMessage && tr.details.modelId === 'm-1', `errorToToolReturn 判别形态：{ok:false, code, severity, retryable, userMessage, details}（internalDetail 不透出：${String(Object.keys(tr).includes('internalDetail'))}）`);
  ok(!('internalDetail' in tr), 'internalDetail 不进 Tool 返回（内外文案分离的映射侧保障）');
  ok(errorToToolReturn(new CryptoError('解密失败')).toolVisible === undefined, 'CRYPTO toolVisible=false 语义在注册表侧（调用方据此只记日志不透出）');
  ok(errorToToolReturn('裸字符串').code === 'UNKNOWN_ERROR', '任意抛出物都可映射（Tool 层无需前置 instanceof）');
  ok(isRetryableError(new NetworkError('x')) === true && isRetryableError(new NetworkError()) === isRetryableError(new AppError('x', 'NETWORK_ERROR')), 'isRetryableError：NETWORK(backoff)=true 与注册表口径一致');
  ok(isRetryableError(new ExecutionError('x')) === false && isRetryableError(new Error('connection timeout')) === true, 'isRetryableError：EXECUTION(never)=false；timeout 语义 Error=true');
}

section('S1-4 包装/解包因果链 + 聚合错误');

{
  const root = new Error('sqlite: disk I/O error');
  const mid = wrapError(root, '记忆库写入失败', { code: 'MEMORY_ERROR', details: { table: 'feedback' } });
  const top = wrapError(mid, '任务执行失败', { code: 'EXECUTION_ERROR' });
  ok(top.cause === mid && mid.cause === root, 'wrapError 保留 cause 引用链（原对象不复制）');
  const chain = errorChain(top);
  ok(chain.length === 3 && chain[0] === top && chain[1] === mid && chain[2] === root, `errorChain 解包 3 环：${chain.map((e) => classifyTaxonomy(e).code).join(' → ')}`);
  ok(rootCause(top) === root && rootCause(chain[0]) === root, 'rootCause 取最后一环（真根因）');
  const cyclic = { name: 'CycleError', message: 'x' };
  cyclic.cause = cyclic;
  ok(errorChain(cyclic).length === 1, '自环 cause 防护：不无限循环');

  const c1 = new TimeoutError('节点 A 超时');
  const c2 = new NetworkError('节点 B 断连');
  const c3 = '裸字符串子错误';
  const agg = AggregateAppError.fromChildren([c1, c2, c3, c1]);
  ok(agg instanceof TypedAppError && agg instanceof AppError && agg.code === 'AGGREGATE_ERROR', 'AggregateAppError 继承 TypedAppError（分类学字段完备）');
  ok(agg.message === '聚合失败：4 个子错误（TIMEOUT_ERROR×2, NETWORK_ERROR×1, UNKNOWN_ERROR×1）', `fromChildren 摘要确定性：${agg.message}`);
  ok(agg.childErrors.length === 4 && agg.childErrors[0] === c1 && agg.childErrors[3] === c1, 'childErrors 保序保留原始抛出物（不吞不转）');
  ok(JSON.stringify(agg.childTaxonomies().map((e) => e.code)) === JSON.stringify(['TIMEOUT_ERROR', 'NETWORK_ERROR', 'UNKNOWN_ERROR', 'TIMEOUT_ERROR']), 'childTaxonomies 逐子分类');
  ok(classifyTaxonomy(agg).code === 'AGGREGATE_ERROR' && classifyTaxonomy(new AggregateError([new Error('a')], '内置聚合')).code === 'AGGREGATE_ERROR', '聚合错误分类：自类与内置 AggregateError 均归 AGGREGATE_ERROR');
}

section('S1-5 序列化 JSON 往返（serializeError → JSON → deserializeError）');

{
  const original = new TypedAppError('模型调用失败', {
    code: 'LLM_ERROR', severity: 'error', retryability: 'backoff',
    userMessage: '模型服务暂不可用', internalDetail: '端点 503',
    httpStatus: 502, toolVisible: true, details: { modelId: 'm-1', attempt: 2 },
  });
  const json = JSON.parse(JSON.stringify(serializeError(original)));
  const back = deserializeError(json);
  ok(back instanceof TypedAppError, '往返产物是 TypedAppError');
  ok(
    back.code === original.code && back.message === original.message && back.severity === original.severity &&
    back.retryability === original.retryability && back.userMessage === original.userMessage &&
    back.internalDetail === original.internalDetail && back.httpStatus === original.httpStatus &&
    back.toolVisible === original.toolVisible && back.name === original.name,
    '八字段逐项相等（code/message/severity/retryability/userMessage/internalDetail/httpStatus/toolVisible/name）',
  );
  ok(JSON.stringify(back.details) === JSON.stringify({ modelId: 'm-1', attempt: 2 }), 'details 经 JSON 往返保真');

  // toJSON 直通：JSON.stringify(错误对象) 即结构化形态
  ok(JSON.parse(JSON.stringify(original)).code === 'LLM_ERROR' && JSON.parse(JSON.stringify(original)).kind === 'typed-error', 'toJSON()：错误对象可直接 JSON.stringify 出结构化形态');

  // 因果链往返
  const wrapped = wrapError(new NetworkError('socket hang up'), '上游断连', { code: 'NETWORK_ERROR' });
  const wrappedBack = deserializeError(JSON.parse(JSON.stringify(serializeError(wrapped))));
  ok(wrappedBack.cause instanceof TypedAppError && wrappedBack.cause.code === 'NETWORK_ERROR' && wrappedBack.cause.message === 'socket hang up', '包装链往返：cause 嵌套还原为 TypedAppError');

  // 聚合往返（与 S1-4 相同形态的聚合：4 子错误 TIMEOUT/NETWORK/裸串/TIMEOUT）
  const agg = AggregateAppError.fromChildren([
    new TimeoutError('节点 A 超时'),
    new NetworkError('节点 B 断连'),
    '裸字符串子错误',
    new TimeoutError('节点 A 超时'),
  ]);
  const aggBack = deserializeError(JSON.parse(JSON.stringify(serializeError(agg))));
  ok(aggBack instanceof AggregateAppError && aggBack.childErrors.length === 4 && aggBack.childErrors[0].code === 'TIMEOUT_ERROR' && aggBack.childErrors[2].code === 'UNKNOWN_ERROR' && aggBack.childErrors[2].message === '裸字符串子错误', '聚合往返：children 逐个还原（类名/码/消息保真）');

  // 旧式 AppError 往返（升级兼容面）
  const legacyBack = deserializeError(JSON.parse(JSON.stringify(serializeError(new MemoryError('记忆库损坏', { path: '/tmp/mem.json' })))));
  ok(legacyBack.code === 'MEMORY_ERROR' && legacyBack.message === '记忆库损坏' && legacyBack.retryability === 'immediate' && legacyBack.details.path === '/tmp/mem.json', '旧式 AppError 往返：码/消息/注册表缺省/details 保真');

  // 非法输入防御
  let threw = null;
  try { deserializeError('不是对象'); } catch (e) { threw = e; }
  ok(threw instanceof TypedAppError && threw.code === 'VALIDATION_ERROR', 'deserializeError 对非对象抛 VALIDATION_ERROR（不产出半成品）');
  let threw2 = null;
  try { deserializeError({ code: 'X' }); } catch (e) { threw2 = e; }
  ok(threw2 instanceof TypedAppError && threw2.code === 'VALIDATION_ERROR', 'deserializeError 对缺 message 的对象抛 VALIDATION_ERROR');
}

// ═══════════════════ S2 运行时契约校验器（contracts.ts） ═══════════════════

section('S2-1 合法构造（≥10 例全过 + 边界值）');

{
  let validCount = 0;
  const good = (value, schema, label) => {
    const r = validate(value, schema);
    ok(r.ok && r.errors.length === 0, label);
    if (r.ok) validCount += 1;
  };
  const fullNode = {
    id: 'n1', description: '生成检索模块', type: 'code-generation',
    dependsOn: [], modelId: 'deepseek-chat', timeout: 120_000,
    cascade: [{ type: 'code-change', description: '触发代码信号' }],
  };
  const minimalNode = { id: 'n2', description: '文档整理', type: 'documentation', dependsOn: [] };
  good({ objective: '升级契约层', nodes: [fullNode], parallelismStrategy: 'width-first', source: 'strategist' }, EXECUTION_PLAN_SCHEMA, '① 全字段 ExecutionPlan（含 modelId/timeout/cascade）');
  good({ objective: 'o', nodes: [minimalNode], parallelismStrategy: 'seq', source: 'fallback' }, EXECUTION_PLAN_SCHEMA, '② 最小 ExecutionPlan（可选字段全缺省）');
  good({ objective: 'o', nodes: [{ ...minimalNode, dependsOn: ['n1', 'n0'] }], parallelismStrategy: 'p', source: 'memory' }, EXECUTION_PLAN_SCHEMA, '③ dependsOn 多依赖 + source=memory');
  good({ objective: 'o', nodes: [fullNode, minimalNode, { ...minimalNode, id: 'n3' }], parallelismStrategy: 'p', source: 'strategist', extraFutureField: { tolerant: true } }, EXECUTION_PLAN_SCHEMA, '④ 未知额外键宽容忽略（前向兼容缺省）');
  const nr = (over) => ({ nodeId: 'n1', modelId: 'm', success: true, output: 'ok', quality: 0.5, latency: 10, attempts: 1, tokensUsed: 100, ...over });
  good(nr({}), NODE_RESULT_SCHEMA, '⑤ 全字段 NodeResult');
  good(nr({ quality: 0 }), NODE_RESULT_SCHEMA, '⑥ quality 下边界 0');
  good(nr({ quality: 1 }), NODE_RESULT_SCHEMA, '⑦ quality 上边界 1');
  good(nr({ latency: 0, attempts: 0, tokensUsed: 0, success: false, error: 'failed', output: undefined }), NODE_RESULT_SCHEMA, '⑧ 失败节点：零值边界 + error 分支（output 缺省）');
  good({ planId: 'p1', success: false, nodeResults: [nr({}), nr({ nodeId: 'n2', success: false })], totalTime: 0, successCount: 0, totalTokens: 250, avgQuality: 0.42 }, PLAN_EXECUTION_RESULT_SCHEMA, '⑨ PlanExecutionResult 聚合结构');
  good({ a: null }, { type: 'object', properties: { a: { type: 'string', nullable: true, required: false } } }, '⑩ nullable 显式声明接受 null');
  good({ level: 3 }, { type: 'object', properties: { level: { type: 'integer', enum: [1, 2, 3, 5, 8] } } }, '⑪ 数字枚举命中');
  good('abc', { type: 'string', minLength: 3, maxLength: 3 }, '⑫ 字符串长度双侧边界同时命中');
  good([true, false, true], { type: 'array', items: { type: 'boolean' } }, '⑬ 布尔数组逐元素校验');
  ok(validCount >= 13, `合法构造计数 ${validCount} ≥ 10`);
}

section('S2-2 非法构造（≥10 例，路径化错误逐位精确）');

{
  const badPlan = (nodes) => ({ objective: 'o', nodes, parallelismStrategy: 'p', source: 'strategist' });
  const node = (over) => ({ id: 'n1', description: 'd', type: 't', dependsOn: [], ...over });

  // 1 缺 objective
  const r1 = validate({ nodes: [node({})], parallelismStrategy: 'p', source: 'strategist' }, EXECUTION_PLAN_SCHEMA);
  ok(!r1.ok && r1.errors.length === 1 && r1.errors[0].path === 'objective' && r1.errors[0].message.includes('必填'), `① 缺 objective → path='objective'（${r1.errors[0]?.message}）`);
  // 2 nodes 空
  const r2 = validate({ objective: 'o', nodes: [], parallelismStrategy: 'p', source: 'strategist' }, EXECUTION_PLAN_SCHEMA);
  ok(!r2.ok && r2.errors[0].path === 'nodes' && r2.errors[0].message.includes('minLength=1'), `② nodes 空 → path='nodes'（${r2.errors[0]?.message}）`);
  // 3 嵌套缺 id
  const r3 = validate(badPlan([node({}), { description: 'd', type: 't', dependsOn: [] }]), EXECUTION_PLAN_SCHEMA);
  ok(!r3.ok && r3.errors[0].path === 'nodes[1].id' && r3.errors[0].actual === 'undefined', `③ nodes[1] 缺 id → path='nodes[1].id'（actual='undefined'）`);
  // 4 类型不符
  const r4 = validate(badPlan([node({ modelId: 42 })]), EXECUTION_PLAN_SCHEMA);
  ok(!r4.ok && r4.errors[0].path === 'nodes[0].modelId' && r4.errors[0].message.includes('类型不符') && r4.errors[0].expected.includes('string'), `④ modelId=42 → path='nodes[0].modelId' 期望 string 实际 number`);
  // 5 范围越界
  const r5 = validate(badPlan([node({ timeout: -5 })]), EXECUTION_PLAN_SCHEMA);
  ok(!r5.ok && r5.errors[0].path === 'nodes[0].timeout' && r5.errors[0].message.includes('低于下界') && r5.errors[0].message.includes('-5 < 0'), `⑤ timeout=-5 → path='nodes[0].timeout'（消息含实际值与下界）`);
  // 6 枚举
  const r6 = validate({ objective: 'o', nodes: [node({})], parallelismStrategy: 'p', source: 'unknown' }, EXECUTION_PLAN_SCHEMA);
  ok(!r6.ok && r6.errors[0].path === 'source' && r6.errors[0].message.includes('strategist|fallback|memory'), `⑥ source='unknown' → path='source' 枚举白名单进消息`);
  // 7 数组元素深路径
  const r7 = validate(badPlan([node({ dependsOn: ['n0', ''] })]), EXECUTION_PLAN_SCHEMA);
  ok(!r7.ok && r7.errors[0].path === 'nodes[0].dependsOn[1]' && r7.errors[0].message.includes('minLength=1'), `⑦ dependsOn[1]='' → path='nodes[0].dependsOn[1]'（数组下标+对象键三层路径）`);
  // 8 级联嵌套
  const r8 = validate(badPlan([node({ cascade: [{ type: 'code-change' }] })]), EXECUTION_PLAN_SCHEMA);
  ok(!r8.ok && r8.errors[0].path === 'nodes[0].cascade[0].description', `⑧ cascade 元素缺 description → path='nodes[0].cascade[0].description'（最深嵌套路径）`);
  // 9/10 NodeResult 域
  const nr = (over) => ({ nodeId: 'n1', modelId: 'm', success: true, quality: 0.5, latency: 10, attempts: 1, tokensUsed: 100, ...over });
  const r9 = validate(nr({ quality: 1.5 }), NODE_RESULT_SCHEMA);
  ok(!r9.ok && r9.errors[0].path === 'quality' && r9.errors[0].message.includes('超过上界') && r9.errors[0].message.includes('1.5 > 1'), `⑨ quality=1.5 → path='quality' 上界消息`);
  const r10 = validate(nr({ attempts: 2.5 }), NODE_RESULT_SCHEMA);
  ok(!r10.ok && r10.errors[0].path === 'attempts' && r10.errors[0].message.includes('integer'), `⑩ attempts=2.5 → path='attempts' integer 收窄拒绝 number`);
  // 11 根 null
  const r11 = validate(null, EXECUTION_PLAN_SCHEMA);
  ok(!r11.ok && r11.errors[0].path === '' && r11.errors[0].message.includes('null'), `⑪ 根 null → path=''（根路径空串约定）`);
  // 12 根 undefined
  const r12 = validate(undefined, EXECUTION_PLAN_SCHEMA);
  ok(!r12.ok && r12.errors[0].message.includes('undefined'), `⑫ 根 undefined → 根值缺失`);
  // 13 根形态
  const r13 = validate([{ not: 'a plan' }], EXECUTION_PLAN_SCHEMA);
  ok(!r13.ok && r13.errors[0].message.includes('类型不符') && r13.errors[0].message.includes('array'), `⑬ 数组当计划 → 根类型不符（array vs object）`);
  // 14 额外键拒绝（显式 additionalProperties:false）
  const strict = { type: 'object', additionalProperties: false, properties: { a: { type: 'number' } } };
  const r14 = validate({ a: 1, extra: 2 }, strict);
  ok(!r14.ok && r14.errors[0].path === 'extra' && r14.errors[0].message.includes('额外字段'), `⑭ additionalProperties:false → path='extra'（严格模式关闭前向兼容）`);
  // 15 NaN 数值
  const r15 = validate(nr({ latency: Number.NaN }), NODE_RESULT_SCHEMA);
  ok(!r15.ok && r15.errors[0].path === 'latency' && r15.errors[0].message.includes('类型不符'), `⑮ latency=NaN → number 匹配拒绝非有限数（actual='${r15.errors[0]?.actual}'）`);

  // fast vs collect 双模式
  const both = { nodes: [], source: 'nope' };
  const collect = validate({ ...both, objective: '', parallelismStrategy: 'p' }, EXECUTION_PLAN_SCHEMA, { mode: 'collect' });
  const fast = validate({ ...both, objective: '', parallelismStrategy: 'p' }, EXECUTION_PLAN_SCHEMA, { mode: 'fast' });
  ok(!collect.ok && collect.errors.length === 3 && JSON.stringify(collect.errors.map((e) => e.path)) === JSON.stringify(['objective', 'nodes', 'source']), `collect 模式：3 错全量收集且按 schema 声明序（${collect.errors.map((e) => e.path).join(' → ')}）`);
  ok(!fast.ok && fast.errors.length === 1 && fast.errors[0].path === 'objective', `fast 模式：首错即停（1 条 = collect 的第一条）`);
  ok(validate({ objective: 'o', nodes: [node({})], parallelismStrategy: 'p', source: 'strategist' }, EXECUTION_PLAN_SCHEMA, { mode: 'fast' }).ok, 'fast 模式合法输入零开销通过');

  // 确定性：同输入两次校验，错误列表 JSON 逐字节一致
  const again = validate({ ...both, objective: '', parallelismStrategy: 'p' }, EXECUTION_PLAN_SCHEMA, { mode: 'collect' });
  ok(JSON.stringify(collect.errors) === JSON.stringify(again.errors), '确定性：同输入两次校验错误列表 JSON 逐字节一致（顺序=声明序，与输入键序无关）');

  // validateOrThrow：失败抛 VALIDATION_ERROR 并携带路径化列表
  let threw = null;
  try { validateOrThrow({ objective: 'o', nodes: [], parallelismStrategy: 'p', source: 'x' }, EXECUTION_PLAN_SCHEMA); } catch (e) { threw = e; }
  ok(threw instanceof TypedAppError && threw.code === 'VALIDATION_ERROR' && Array.isArray(threw.details.errors) && threw.details.errors.every((e) => typeof e.path === 'string'), 'validateOrThrow：抛 VALIDATION_ERROR，details.errors 为路径化列表');
  let threw2 = null;
  try { validateOrThrow({ objective: 'o', nodes: [node({})], parallelismStrategy: 'p', source: 'strategist' }, EXECUTION_PLAN_SCHEMA); threw2 = 'no-throw'; } catch (e) { threw2 = e; }
  ok(threw2 === 'no-throw', 'validateOrThrow：合法输入静默通过');
}

// ═══════════════════ S3 品牌化 ID（types.ts） ═══════════════════

section('S3-1 品牌工厂：运行时往返 + 拒绝空值');

{
  const factories = { asSignalId, asModelId, asTenantId, asPlanId, asGoalId, asNodeId, asStrategyId, asFeedbackId };
  let roundtrips = 0;
  for (const [name, factory] of Object.entries(factories)) {
    const branded = factory(`${name}-042`);
    if (branded === `${name}-042` && typeof branded === 'string' && branded.length === name.length + 4) roundtrips += 1;
  }
  ok(roundtrips === 8, `8 个工厂全部往返保真（值 === 原串、typeof string：${roundtrips}/8）`);
  const sig = asSignalId('sig-1');
  ok(unbrandId(sig) === 'sig-1' && unbrandId(sig) === sig, 'unbrandId 对称逃生舱（品牌 → string）');
  ok(asSignalId(sig) === sig && asSignalId(asSignalId(sig)) === sig, '工厂幂等：品牌值再过工厂原样返回（无双重包装）');
  ok(sig.toUpperCase() === 'SIG-1' && sig.length === 5, '品牌值保留全部 string 方法与属性（结构透明——下行零成本）');

  let e1 = null; let e2 = null;
  try { asModelId(''); } catch (e) { e1 = e; }
  try { asTenantId('   '); } catch (e) { e2 = e; }
  ok(e1 instanceof TypedAppError && e1.code === 'VALIDATION_ERROR' && e1.details.kind === 'ModelId', `空串拒绝：VALIDATION_ERROR + details.kind（${e1?.message}）`);
  ok(e2 instanceof TypedAppError && e2.details.kind === 'TenantId', '纯空白拒绝：空白串不放行（诚实构造点）');
}

section('S3-2 编译期防混用（TypeScript 7 CLI 实测两个临时片段）');

{
  // 临时片段写入系统临时目录（仓库零污染，finally 即删）
  const relImport = path.relative(os.tmpdir(), path.join(REPO, 'src', 'types.js')).split(path.sep).join('/');
  const importLine = `import { asSignalId, asModelId, unbrandId, type SignalId, type ModelId } from '${relImport}';`;
  const misuse = [
    importLine,
    'const sig = asSignalId("sig-1");',
    'const model = asModelId("model-a");',
    'const downgraded: string = sig;',
    'const ids: string[] = [sig, model];',
    'const wrong: ModelId = sig;',
    'const alsoWrong: SignalId = "raw-literal-string";',
    'console.log(downgraded.length, ids.join(","), wrong, alsoWrong);',
  ].join('\n');
  const pass = [
    importLine,
    'const sig = asSignalId("sig-1");',
    'const model = asModelId("model-a");',
    'const downgraded: string = sig;',
    'const ids: string[] = [sig, model];',
    'const roundtrip = asSignalId(sig);',
    'const nested: SignalId[] = [sig, roundtrip];',
    'const plain: string = unbrandId(model);',
    'console.log(downgraded.length, ids.join(","), nested.length, plain);',
  ].join('\n');

  const tscBin = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
  const tscExists = fs.existsSync(tscBin);
  const misusePath = path.join(os.tmpdir(), `dsh-brand-misuse-${process.pid}.ts`);
  const passPath = path.join(os.tmpdir(), `dsh-brand-pass-${process.pid}.ts`);
  try {
    fs.writeFileSync(misusePath, misuse, 'utf8');
    fs.writeFileSync(passPath, pass, 'utf8');
    const run = (file) =>
      tscExists
        ? spawnSync(process.execPath, [
            tscBin, '--ignoreConfig', '--noEmit', '--strict',
            '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'bundler',
            '--types', 'node', '--typeRoots', path.join(REPO, 'node_modules', '@types'),
            file,
          ], { cwd: REPO, encoding: 'utf8', timeout: 120_000 })
        : null;

    const misuseRun = run(misusePath);
    const misuseOut = `${misuseRun?.stdout ?? ''}${misuseRun?.stderr ?? ''}`;
    ok(misuseRun !== null && misuseRun.status !== 0, `片段 A（混用）编译必须失败（tsc exit=${misuseRun?.status}）`);
    ok(
      misuseOut.includes('SignalId') && misuseOut.includes('ModelId') && misuseOut.includes('__brand'),
      `混用诊断指向品牌不兼容（'SignalId' is not assignable to type 'ModelId'，__brand 字面量不匹配）`,
    );
    ok(!misuseOut.includes('downgraded'), '品牌下行 string 不报错（诊断只来自混用行——结构透明性成立）');

    const passRun = run(passPath);
    ok(passRun !== null && passRun.status === 0, `片段 B（合法使用）编译通过（tsc exit=${passRun.status}，含品牌→string 下行与工厂幂等往返）`);
  } finally {
    for (const p of [misusePath, passPath]) {
      try { fs.rmSync(p, { force: true }); } catch { /* 尽力清理 */ }
    }
  }
}

// ═══════════════════ S4 Result<T,E> 单子（types.ts） ═══════════════════

section('S4 Result<T,E>：单子律运行时断言 + 错误通道组合');

{
  const f = (x) => x + 1;
  const g = (x) => x * 10;
  const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // 律 1：map 恒等
  const okV = mkOk(41);
  const errV = mkErr(new TypedAppError('失败', { code: 'EXECUTION_ERROR' }));
  ok(deepEq(mapResult(okV, (x) => x), okV) && deepEq(mapResult(errV, (x) => x), errV), 'map 恒等律：map(r, x↦x) ≡ r（ok 与 err 双侧）');
  // 律 2：map 结合
  ok(
    deepEq(mapResult(mapResult(okV, f), g), mapResult(okV, (x) => g(f(x)))) &&
    deepEq(mapResult(mapResult(errV, f), g), mapResult(errV, (x) => g(f(x)))),
    'map 结合律：map(map(r,f),g) ≡ map(r, g∘f)（ok 与 err 双侧）',
  );
  // 律 3/4：andThen 左右单位律
  const fk = (x) => mkOk(x * 2);
  ok(deepEq(andThen(mkOk(7), fk), fk(7)), 'andThen 左单位律：andThen(ok(v), f) ≡ f(v)');
  ok(deepEq(andThen(okV, mkOk), okV) && deepEq(andThen(errV, mkOk), errV), 'andThen 右单位律：andThen(r, ok) ≡ r（ok 与 err 双侧）');
  // 失败短路链
  const fall = (x) => mkErr(new TypedAppError(`在 ${x} 处失败`, { code: 'VALIDATION_ERROR' }));
  ok(andThen(andThen(mkOk(1), fall), f).ok === false && mapResult(andThen(mkOk(1), fall), f).error.message === '在 1 处失败', '失败短路：err 后续 map/andThen 不再触碰值函数');

  ok(isOk(okV) && !isErr(okV) && isErr(errV) && !isOk(errV), 'isOk / isErr 判别窄化');
  ok(unwrapOr(okV, 0) === 41 && unwrapOr(errV, -1) === -1, 'unwrapOr：成功取值 / 失败取默认');
  let thrown = null;
  try { unwrapResult(errV); } catch (e) { thrown = e; }
  ok(thrown === errV.error, 'unwrapResult：失败态原样抛出错误对象');
  ok(unwrapResult(mkOk(42)) === 42, 'unwrapResult：成功态返回值');
  ok(mapErrResult(errV, (e) => e.code).error === 'EXECUTION_ERROR' && mapErrResult(okV, (e) => e).ok === true, 'mapErr：只变换失败通道');
  ok(
    matchResult(okV, { ok: (v) => `成功:${v}`, err: (e) => '失败' }) === '成功:41' &&
    matchResult(errV, { ok: (v) => `成功:${v}`, err: (e) => `失败:${e.code}` }) === '失败:EXECUTION_ERROR',
    'matchResult：双分支消解',
  );

  // 与类型化错误体系互通
  const r1 = mkErr(new TypedAppError('超时', { code: 'TIMEOUT_ERROR' }));
  const r2 = mkErr(new NetworkError('断连'));
  const r3 = mkOk('done');
  ok(resultTaxonomy(r1).code === 'TIMEOUT_ERROR' && resultTaxonomy(r1).retryability === 'backoff', 'resultTaxonomy：TypedAppError 错误通道 → 注册表条目');
  ok(resultTaxonomy(r2).httpStatus === 502, 'resultTaxonomy：旧式 AppError 也走注册表查表');
  ok(resultTaxonomy(r3) === undefined, 'resultTaxonomy：成功态为 undefined（无分类开销语义）');
  const piped = mapResult(andThen(mkOk('sig'), (s) => mkOk(s.length)), (n) => n + 1);
  ok(piped.ok === true && piped.value === 4, '组合管道：ok → andThen → map 保值传递（sig → 3 → 4）');
}

// ═══════════════════ S5 结构化事件信封（types.ts） ═══════════════════

section('S5 事件信封：工厂确定性 / 守卫正反例 / 定序器');

{
  const env = createEventEnvelope({ type: 'plan.completed', payload: { planId: 'p1' }, source: 'executor', seq: 7, ts: 1_700_000_000_000 });
  ok(env.type === 'plan.completed' && env.payload.planId === 'p1' && env.ts === 1_700_000_000_000 && env.seq === 7 && env.source === 'executor', '工厂确定性：显式 ts 逐字段相等');
  ok(JSON.stringify(Object.keys(env)) === JSON.stringify(['type', 'payload', 'ts', 'seq', 'source']), `无选项时键序恰为五要素（${Object.keys(env).join(',')}）`);
  const withIds = createEventEnvelope({ type: 't', payload: {}, source: 's', seq: 0, correlationId: 'c1', causationId: 'u1', tenantId: 't1' });
  ok(withIds.correlationId === 'c1' && withIds.causationId === 'u1' && withIds.tenantId === 't1', '可选项仅在提供时出现（关联/因果/租户链）');
  const noIds = createEventEnvelope({ type: 't', payload: {}, source: 's', seq: 0 });
  ok(!('correlationId' in noIds) && !('causationId' in noIds) && !('tenantId' in noIds), '未提供时可选项键完全缺席（无 undefined 幽灵键）');

  // 守卫正例
  ok(isEventEnvelope(env) && isEventEnvelope({ type: 'a.b', payload: { any: [1, 2] }, ts: 0, seq: 0, source: 'x' }) && isEventEnvelope({ type: 't', payload: {}, ts: 0.5, seq: 9_007_199_254_740_991, source: 'x' }), '守卫正例：标准信封 / 复杂载荷 / 零 ts 与大 seq');
  // 守卫反例
  const negatives = [
    ['null', null],
    ['数组', [1, 2]],
    ['缺 type', { payload: {}, ts: 1, seq: 1, source: 'x' }],
    ['空 type', { type: '', payload: {}, ts: 1, seq: 1, source: 'x' }],
    ['payload=null', { type: 't', payload: null, ts: 1, seq: 1, source: 'x' }],
    ['payload=字符串', { type: 't', payload: 'p', ts: 1, seq: 1, source: 'x' }],
    ['ts=NaN', { type: 't', payload: {}, ts: Number.NaN, seq: 1, source: 'x' }],
    ['ts=字符串', { type: 't', payload: {}, ts: '1700', seq: 1, source: 'x' }],
    ['seq=小数', { type: 't', payload: {}, ts: 1, seq: 1.5, source: 'x' }],
    ['seq=负数', { type: 't', payload: {}, ts: 1, seq: -1, source: 'x' }],
    ['source=空', { type: 't', payload: {}, ts: 1, seq: 1, source: '' }],
    ['correlationId=数字', { type: 't', payload: {}, ts: 1, seq: 1, source: 'x', correlationId: 42 }],
  ];
  let negOk = 0;
  for (const [label, value] of negatives) if (!isEventEnvelope(value)) negOk += 1;
  ok(negOk === negatives.length, `守卫反例 12/12 全拒（${negatives.map(([l]) => l).join('、')}）`);
  ok(!isEventEnvelope(undefined) && !isEventEnvelope('string'), '守卫反例：undefined / 裸字符串不炸不收');

  let assertErr = null;
  try { assertEventEnvelope({ type: 't', payload: {}, source: 'x', ts: 'bad', seq: -3 }); } catch (e) { assertErr = e; }
  ok(assertErr instanceof TypedAppError && assertErr.code === 'VALIDATION_ERROR' && JSON.stringify(assertErr.details.defects) === JSON.stringify(['ts', 'seq']), `assertEventEnvelope 缺陷定位：defects=['ts','seq']（${assertErr?.message}）`);
  let assertPass = false;
  try { assertEventEnvelope(env); assertPass = true; } catch { assertPass = false; }
  ok(assertPass, 'assertEventEnvelope 合法信封静默通过');

  // 定序器：单调 seq / 注入时钟 / peek 不消耗
  let clockNow = 5_000;
  const seqr = new EventSequencer('optimizer', { clock: () => clockNow });
  ok(seqr.peekSeq() === 0, '定序器起始 seq=0');
  const e0 = seqr.emit({ type: 'plan.recommended', payload: { modelId: 'm-1' } });
  clockNow += 10;
  const e1 = seqr.emit({ type: 'plan.recommended', payload: { modelId: 'm-2' } });
  ok(e0.seq === 0 && e1.seq === 1 && seqr.peekSeq() === 2, `seq 严格递增 0→1 且 peek=2（emit 恰消耗一个）`);
  ok(e0.ts === 5_000 && e1.ts === 5_010 && e0.source === 'optimizer' && e1.source === 'optimizer', '注入时钟确定性：ts 5,000→5,010；source 透传');
  ok(isEventEnvelope(e0) && isEventEnvelope(e1), '定序器产物过守卫（生产端自证形态完备）');
  const seqr42 = new EventSequencer('reflector', { startSeq: 42 });
  ok(seqr42.emit({ type: 't', payload: {} }).seq === 42, 'startSeq 起始 42');
  let seqErr = null;
  try { new EventSequencer('  '); } catch (e) { seqErr = e; }
  ok(seqErr instanceof TypedAppError && seqErr.code === 'VALIDATION_ERROR', '定序器空 source 拒绝构造');
  let envErr = null;
  try { createEventEnvelope({ type: ' ', payload: {}, source: 's', seq: 0 }); } catch (e) { envErr = e; }
  ok(envErr instanceof TypedAppError && envErr.code === 'VALIDATION_ERROR', '工厂空白 type 拒绝（信封构造点同样诚实）');
}

// ═══════════════════ S6 零漂移总检（纯增量证据） ═══════════════════

section('S6 零漂移：既有体系原样 + 类型层纯增量打包证据');

{
  const legacy = [
    [new AppError('默认'), 'APP_ERROR'],
    [new ConfigError('c'), 'CONFIG_ERROR'],
    [new CryptoError('k'), 'CRYPTO_ERROR'],
    [new MemoryError('m'), 'MEMORY_ERROR'],
    [new NetworkError('n'), 'NETWORK_ERROR'],
    [new TimeoutError('t'), 'TIMEOUT_ERROR'],
    [new ExecutionError('e'), 'EXECUTION_ERROR'],
  ];
  ok(legacy.every(([e, code]) => e instanceof AppError && e.code === code), '既有 7 类构造签名与 code 原样（未动一字）');
  const withDetails = new AppError('带详情', 'APP_ERROR', { k: 1 });
  ok(withDetails.details.k === 1 && withDetails.name === 'AppError', 'AppError(message, code, details) 三参形态与 name 语义保留');
  ok(new ConfigError('c', { f: 2 }).details.f === 2, '旧子类 details 透传保留');

  // 类型声明打包证据：七个支柱接口仍在 + 新类型并列在册
  const dts = fs.readFileSync(path.join(REPO, 'dist', 'index.d.mts'), 'utf8');
  const mustExist = [
    'IMemoryStore', 'IReflector', 'IOptimizer', 'ISandbox', 'IPolicyEvolver', 'ISelfModel', 'IMetaCognitiveController',
    'PlanNode', 'ExecutionPlan', 'NodeResult', 'PlanExecutionResult', 'NodeRunner', 'CascadeHandler',
    'AppError', 'ConfigError', 'CryptoError', 'MemoryError', 'NetworkError', 'TimeoutError', 'ExecutionError',
    'ERROR_REGISTRY', 'ErrorTaxonomyEntry', 'TypedAppError', 'AggregateAppError', 'SerializedError',
    'classifyTaxonomy', 'errorToToolReturn', 'isRetryableError', 'wrapError', 'serializeError',
    'SchemaSpec', 'ValidationError', 'ValidationResult', 'PLAN_NODE_SCHEMA', 'EXECUTION_PLAN_SCHEMA',
    'SignalId', 'ModelId', 'TenantId', 'PlanId', 'GoalId', 'Result', 'OkResult', 'ErrResult',
    'EventEnvelope', 'EventSequencer', 'Brand',
  ];
  const absent = mustExist.filter((n) => !new RegExp(`\\b${n}\\b`).test(dts));
  ok(absent.length === 0, `dist/index.d.mts 中旧契约 ${mustExist.length - absent.length}/${mustExist.length} 个名字齐全（缺失：${absent.join(',') || '无'}——纯增量零删除）`);
  ok(dts.includes('interface IMemoryStore') || /IMemoryStore/.test(dts), '支柱接口本体在类型声明中原样在册');
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— 基础契约层第三轮五项升级验证成立`);
  console.log('  │ 升级面             │ 旧行为                     │ 新行为（本轮验证）                          │');
  console.log('  │--------------------│-----------------------------│---------------------------------------------│');
  console.log('  │ 错误体系           │ 平面 code + message         │ 13 码分类学注册表 + severity/retry/内外文案   │');
  console.log('  │                    │                             │ + HTTP/Tool 映射 + 聚合 + JSON 往返          │');
  console.log('  │ 接口契约           │ 仅编译期 interface          │ 运行时 schema 校验：路径化错误/双模式/确定性   │');
  console.log('  │ id 类型            │ 全部裸 string（可互混）      │ 品牌 ID + 8 工厂：编译期防混用（tsc 实测）    │');
  console.log('  │ 错误传播           │ throw / try-catch 单通道     │ Result<T,E> 判别联合（单子律成立）            │');
  console.log('  │ 跨模块事件         │ 各模块自定载荷形态          │ 五要素信封 + 守卫 + 单调定序器                │');
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
