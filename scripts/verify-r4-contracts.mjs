/**
 * verify-r4-contracts.mjs — 第四轮模块域升级「基础契约层 R4-A16」验证
 * （src/types.ts / src/contracts.ts / src/errors.ts 三个基础文件的纯增量升级）
 *
 * 五项升级的构造性证明：
 *
 *   S1 API 版本化（contracts.ts）：parseApiVersion 严格三段式解析（前导零/
 *      v 前缀/两段/四段全拒）；formatApiVersion 互逆；compareApiVersions
 *      全序；classifyVersionPair 四分类原子（exact/satisfies/downgrade/
 *      incompatible）；declareApiVersions 声明点校验（空集/重复/乱序拒绝
 *      并升序规范化）；negotiateApiVersion 15 组合协商矩阵（含 exact 命中、
 *      最小可用升级、minor 平界 patch 任意、提供方过旧 fallback、
 *      major 不匹配明确拒绝、空集拒绝）逐位断言
 *   S2 模式演化（contracts.ts）：v1→v2→v3 链——加字段带缺省（无损）、
 *      删字段按弃用声明（graceVersions）；migrateUp v1→v3 途经记账、
 *      migrateDown v3→v1 诚实报告丢失字段（lossless=false + 逐字段
 *      notes + 出口过 v1 严格 schema）；运行时诚实性审计：未声明删除/
 *      删而不记/降级丢字段谎报无损 全部抛错；链注册纪律（断裂/弃用声明
 *      畸形）拒绝；入口/出口 schema 校验兜底
 *   S3 声明式不变量库（contracts.ts）：3 条不变量（预算非负/seq 单调/
 *      摘要非空）健康对象全过；违例对象出按注册序的违例清单（带描述）；
 *      assertInvariants 抛聚合错误（childErrors 带 invariantId）；
 *      谓词抛错按违例记账不炸断；重复 id 拒绝；注册表/裸数组双入口
 *   S4 类型依赖图（types.ts）：6 类型自定义注册表（含前向引用+未注册
 *      外部叶）——names/dependenciesOf/dependentsOf/reachableFrom/
 *      topologicalOrder 逐位断言（Kahn 稳定序）；环图 detectCycles +
 *      topologicalOrder 抛错；describe()/toDot() 确定性；CORE_TYPE_REGISTRY
 *      9 核心类型拓扑序程序化验证（依赖恒在前）
 *   S5 错误重试策略声明（errors.ts）：四分法缺省表（never/immediate/
 *      backoff/after-fix → none/immediate/backoff/escalate）；8 种错误
 *      流策略路由（含未注册码保守缺省不重试）；shouldRetry 边界
 *      （attemptsMade 达上限即停）；retryDelayMs 纯指数计算+封顶（无抖动
 *      确定性）；planRetries 完整计划展开；registerRetryPolicy 覆盖/
 *      撤销/畸形拒绝；needsHumanEscalation 升级人工判定
 *   S6 零漂移总检：第三轮既有面（ERROR_REGISTRY 13 码 / validate 预设
 *      schema / TypedAppError 覆盖语义）原样可用；dist 类型声明中新旧
 *      名字并列在册（纯增量打包证据）
 *
 * 确定性：无随机源、无真实定时器；重试延迟为纯函数计算；拓扑序为稳定
 * Kahn（注册序平局裁决）；同一输入两次运行输出逐字节一致。
 * 运行：npm run build && node scripts/verify-r4-contracts.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dsh from '../dist/index.mjs';

  const {
  // 既有（第三轮）
  AppError, ConfigError, MemoryError, NetworkError, TimeoutError, TypedAppError,
  AggregateAppError, ERROR_REGISTRY, REGISTERED_ERROR_CODES, isRetryableError, classifyTaxonomy,
  validate, EXECUTION_PLAN_SCHEMA,
  // S1 API 版本化（本轮）
  parseApiVersion, formatApiVersion, compareApiVersions, classifyVersionPair,
  declareApiVersions, negotiateApiVersion,
  // S2 模式演化（本轮）
  SchemaMigrationChain,
  // S3 不变量库（本轮）
  invariant, createInvariantRegistry, checkInvariants, assertInvariants, InvariantRegistry,
  // S4 类型依赖图（本轮）
  TypeRegistry, createTypeRegistry, CORE_TYPE_REGISTRY,
  // S5 重试策略（本轮）
  RETRY_POLICY_DEFAULTS, CONSERVATIVE_RETRY_POLICY, registerRetryPolicy,
  unregisterRetryPolicy, registeredRetryPolicyCodes, retryPolicyFor, shouldRetry,
  retryDelayMs, planRetries, needsHumanEscalation,
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
function throws(fn, label, match) {
  try {
    fn();
    failed += 1;
    console.error(`  ✗ ${label}（未抛错）`);
    return null;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (match === undefined || match.test(text)) {
      passed += 1;
      console.log(`  ✓ ${label}（抛：${text.slice(0, 70)}）`);
      return error;
    }
    failed += 1;
    console.error(`  ✗ ${label}（文案不匹配 /${match.source}/：${text.slice(0, 90)}）`);
    return error;
  }
}
function section(title) {
  console.log(`\n■ ${title}`);
}
/** 错误流路由标签：码 + 本地形态名（进断言文案，失败时一眼定位） */
function classifyLabel(error) {
  const code = classifyTaxonomy(error).code;
  const shape = error instanceof Error ? error.constructor.name : typeof error;
  return `${shape}(${code})`;
}
const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// ═══════════════════ S1 API 版本化（contracts.ts） ═══════════════════

section('S1-1 版本解析：严格三段式 + 互逆 + 全序');

{
  const v = parseApiVersion('1.4.2');
  ok(v.major === 1 && v.minor === 4 && v.patch === 2, "parseApiVersion('1.4.2') → {1,4,2}");
  ok(formatApiVersion(v) === '1.4.2' && formatApiVersion({ major: 0, minor: 0, patch: 0 }) === '0.0.0', 'formatApiVersion 互逆（含全零段）');
  ok(
    parseApiVersion('0.0.0').major === 0 && parseApiVersion('12.34.56').minor === 34,
    '边界：0.0.0 与两位数段 12.34.56 合法',
  );
  for (const bad of ['1.2', '1.2.3.4', 'v1.2.3', '1.2.x', '-1.2.3', '1.02.3', '  ', '']) {
    let err = null;
    try { parseApiVersion(bad); } catch (e) { err = e; }
    ok(err instanceof TypedAppError && err.code === 'VALIDATION_ERROR', `非法版本 ${JSON.stringify(bad || '')} 拒绝（VALIDATION_ERROR）`);
  }
  ok(parseApiVersion('  2.1.0  ').major === 2, '首尾空白宽容（trim 后解析）');

  const c = compareApiVersions;
  ok(
    c({ major: 1, minor: 2, patch: 3 }, { major: 1, minor: 2, patch: 3 }) === 0 &&
    c({ major: 1, minor: 2, patch: 3 }, { major: 1, minor: 2, patch: 4 }) === -1 &&
    c({ major: 1, minor: 3, patch: 0 }, { major: 1, minor: 2, patch: 9 }) === 1 &&
    c({ major: 2, minor: 0, patch: 0 }, { major: 1, minor: 9, patch: 9 }) === 1,
    'compareApiVersions 全序：major → minor → patch（-1/0/1）',
  );

  // 单对分类原子
  const pair = (a, b) => classifyVersionPair(parseApiVersion(a), parseApiVersion(b));
  ok(pair('1.4.2', '1.4.2') === 'exact', 'classify：三段全等 → exact');
  ok(pair('1.2.0', '1.4.1') === 'satisfies' && pair('1.4.9', '1.4.0') === 'satisfies', 'classify：同 major 且提供方 minor ≥ 请求方 → satisfies（minor 平界时 patch 任意）');
  ok(pair('1.5.0', '1.4.1') === 'downgrade', 'classify：同 major 但提供方更旧 → downgrade');
  ok(pair('1.5.0', '2.0.0') === 'incompatible' && pair('0.9.0', '1.0.0') === 'incompatible', 'classify：major 不同 → incompatible（含 0.x 试点期）');
}

section('S1-2 版本集声明：解析 / 去重 / 排序规范化');

{
  const set = declareApiVersions('dsh.scheduler-tools', ['2.0.0', '1.2.0', '1.4.1']);
  ok(set.name === 'dsh.scheduler-tools', '版本集携带能力名');
  ok(JSON.stringify(set.versions) === JSON.stringify(['1.2.0', '1.4.1', '2.0.0']), `乱序输入升序规范化（${set.versions.join(' → ')}）`);
  throws(() => declareApiVersions('x', []), '空版本集拒绝', /至少要声明一个版本/);
  throws(() => declareApiVersions('x', ['1.0.0', '1.0.0']), '重复版本拒绝', /重复版本 1\.0\.0/);
  throws(() => declareApiVersions('x', ['1.0.0', 'oops']), '成员格式非法在声明点即拒', /格式非法/);
  throws(() => declareApiVersions('  ', ['1.0.0']), '空能力名拒绝', /name 不能为空/);
}

section('S1-3 协商矩阵：15 组合逐位断言（exact / 最小升级 / 降级建议 / 明确拒绝）');

{
  let n = 0;
  const cases = [
    // [请求方, 提供方集, 期望 ok, 期望 compatibility, 期望 chosen, 期望 fallback, 期望 reason]
    ['1.2.0', ['1.2.0', '1.4.1', '2.0.0'], true, 'exact', '1.2.0', undefined, undefined],           // ① 精确命中（低）
    ['1.4.1', ['1.2.0', '1.4.1', '2.0.0'], true, 'exact', '1.4.1', undefined, undefined],           // ② 精确命中（中）
    ['2.0.0', ['1.2.0', '1.4.1', '2.0.0'], true, 'exact', '2.0.0', undefined, undefined],           // ③ 精确命中（高）
    ['1.0.0', ['1.2.0', '1.4.1', '2.0.0'], true, 'satisfies', '1.2.0', undefined, undefined],       // ④ 旧请求打新服务：最小可用升级 1.2.0
    ['1.3.9', ['1.2.0', '1.4.1', '2.0.0'], true, 'satisfies', '1.4.1', undefined, undefined],       // ⑤ minor 夹缝：跳过 1.2.0 取 1.4.1
    ['1.2.5', ['1.2.0', '1.4.1', '2.0.0'], true, 'satisfies', '1.2.0', undefined, undefined],       // ⑥ minor 平界 patch 更高：规则 minor≥ 即兼容，取最近 1.2.0
    ['2.0.1', ['1.2.0', '1.4.1', '2.0.0'], true, 'satisfies', '2.0.0', undefined, undefined],       // ⑦ 新 major 请求 patch 更高：minor 平界兼容
    ['2.0.3', ['2.0.1', '2.0.7', '2.2.0'], true, 'satisfies', '2.0.1', undefined, undefined],       // ⑧ 同 minor 多 patch：取最小 patch（不过度超前）
    ['1.5.0', ['1.2.0', '1.4.1', '2.0.0'], false, 'downgrade', undefined, '1.4.1', 'provider-too-old'], // ⑨ 提供方过旧：拒绝 + 双方最大公共版本
    ['1.9.9', ['1.2.0', '1.4.1', '2.0.0'], false, 'downgrade', undefined, '1.4.1', 'provider-too-old'], // ⑩ 远超提供方：仍给同 major 最大公共版本
    ['2.1.0', ['2.0.5'], false, 'downgrade', undefined, '2.0.5', 'provider-too-old'],               // ⑪ 单版本提供方过旧
    ['3.0.0', ['1.2.0', '1.4.1', '2.0.0'], false, 'incompatible', undefined, undefined, 'major-mismatch'], // ⑫ major 不在提供方集：明确拒绝无 fallback
    ['0.9.0', ['1.2.0', '1.4.1', '2.0.0'], false, 'incompatible', undefined, undefined, 'major-mismatch'], // ⑬ 0.x 试点 major 同样拒绝
    ['2.0.0', ['1.9.9', '3.0.0'], false, 'incompatible', undefined, undefined, 'major-mismatch'],    // ⑭ 提供方跳 major：无公共语言
    ['1.0.0', [], false, 'none', undefined, undefined, 'empty-supported'],                           // ⑮ 空集拒绝
  ];
  for (const [requested, supported, expOk, expCompat, expChosen, expFallback, expReason] of cases) {
    n += 1;
    const r = negotiateApiVersion(requested, supported);
    const parts = [
      r.ok === expOk,
      r.compatibility === expCompat,
      r.chosen === expChosen,
      (r.fallback ?? null) === (expFallback ?? null),
      (r.reason ?? null) === (expReason ?? null),
      typeof r.message === 'string' && r.message.length > 0,
    ];
    ok(parts.every(Boolean), `组合 ${n}：请求 ${requested} vs [${supported.join(', ')}] → ok=${r.ok}/${expCompat}${r.chosen !== undefined ? ` chosen=${r.chosen}` : ''}${r.fallback !== undefined ? ` fallback=${r.fallback}` : ''}${r.reason !== undefined ? ` reason=${r.reason}` : ''}`);
  }
  ok(n >= 10, `协商矩阵组合数 ${n} ≥ 10（含 exact/satisfies/downgrade/incompatible/空集五类边界）`);

  const good = negotiateApiVersion('1.0.0', ['1.2.0']);
  ok(good.message.includes('1.0.0') && good.message.includes('1.2.0'), '成功消息含双方版本（审计可读）');
  const bad = negotiateApiVersion('1.5.0', ['1.4.1']);
  ok(bad.message.includes('降级') && bad.message.includes('1.4.1'), '降级建议消息含 fallback 版本与动作指引');
  throws(() => negotiateApiVersion('banana', ['1.0.0']), '请求串非法在协商入口即抛（诚实构造点）', /格式非法/);
  throws(() => negotiateApiVersion('1.0.0', ['1.0.0', 'x.y.z']), '提供方集成员非法即抛', /格式非法/);

  // 确定性：同输入两次协商结果逐字节一致
  const a = negotiateApiVersion('1.3.0', ['1.2.0', '1.4.1', '2.0.0']);
  const b = negotiateApiVersion('1.3.0', ['1.2.0', '1.4.1', '2.0.0']);
  ok(JSON.stringify(a) === JSON.stringify(b), '确定性：同输入两次协商 JSON 逐字节一致');
}

// ═══════════════════ S2 模式演化（contracts.ts） ═══════════════════

section('S2-1 v1→v2→v3 链构造：加字段带缺省 / 删字段按弃用声明');

{
  // 领域样例：记忆条目 schema 的三个版本
  const V1 = {
    type: 'object', description: 'MemoryEntry@v1', additionalProperties: false,
    properties: {
      id: { type: 'string', minLength: 1 },
      content: { type: 'string', minLength: 1 },
      score: { type: 'number', min: 0, max: 1 },
    },
  };
  const V2 = {
    type: 'object', description: 'MemoryEntry@v2',
    properties: {
      id: { type: 'string', minLength: 1 },
      content: { type: 'string', minLength: 1 },
      score: { type: 'number', min: 0, max: 1 },
      tags: { type: 'array', items: { type: 'string' } },
      priority: { type: 'number', min: 0 },
    },
  };
  const V3 = {
    type: 'object', description: 'MemoryEntry@v3', additionalProperties: false,
    properties: {
      id: { type: 'string', minLength: 1 },
      content: { type: 'string', minLength: 1 },
      tags: { type: 'array', items: { type: 'string' } },
      priority: { type: 'number', min: 0 },
    },
  };

  const chain = new SchemaMigrationChain('memory-entry')
    .defineVersion('v1', V1)
    .defineVersion('v2', V2)
    .defineVersion('v3', V3)
    .register({
      from: 'v1', to: 'v2', description: 'v2：新增 tags（缺省 []）与 priority（缺省 0）——向后兼容加字段',
      up: (data) => ({
        value: { ...data, tags: [], priority: 0 },
        lossless: true,
        notes: ['tags ← 缺省 []（v2 新增字段）', 'priority ← 缺省 0（v2 新增字段）'],
      }),
      down: (data) => ({
        value: { id: data.id, content: data.content, score: data.score },
        lossless: false,
        notes: ['tags 已丢弃（v1 无此字段）', 'priority 已丢弃（v1 无此字段）'],
      }),
    })
    .register({
      from: 'v2', to: 'v3', description: 'v3：移除 score（v2 弃用、宽限 1 版后移除）',
      removals: [{ field: 'score', deprecatedSince: 'v2', graceVersions: 1 }],
      up: (data) => {
        const { score, ...rest } = data;
        return {
          value: rest,
          lossless: score === undefined,
          notes: score === undefined ? [] : [`score 已按弃用声明移除（v2 起弃用，宽限 1 版后于 v3 移除；原值 ${String(score)}）`],
        };
      },
      down: (data) => ({
        value: { ...data, score: 0 },
        lossless: false,
        notes: ['score 无法从 v3 恢复（已弃用移除），以 0 回填'],
      }),
    });

  ok(chain.versions().join('→') === 'v1→v2→v3' && chain.latestVersion() === 'v3', '链版本序列 v1→v2→v3（注册连续性成立）');
  ok(chain.schemaFor('v2')?.properties?.tags !== undefined && chain.schemaFor('v4') === undefined, 'defineVersion 的 schema 可查（未知版本 undefined）');

  // 升级 v1 → v2：无损 + 缺省回填记账 + 出口过 v2 schema
  const legacy = { id: 'm-1', content: '记忆条目', score: 0.8 };
  const up1 = chain.migrateUp(legacy, { from: 'v1', to: 'v2' });
  ok(up1.lossless === true && up1.value.tags !== undefined && JSON.stringify(up1.value.tags) === '[]' && up1.value.priority === 0 && up1.value.score === 0.8, '升级 v1→v2：旧字段原样保留 + tags=[]/priority=0 缺省回填');
  ok(up1.notes.length === 2 && up1.notes[0] === '[v1→v2] tags ← 缺省 []（v2 新增字段）', '升级记账带步序前缀且逐字段说明');
  ok(up1.validation !== undefined && up1.validation.ok === true, '出口契约：产物通过 v2 schema 校验');

  // 升级 v1 → v3（缺省到最新）：途经两步、score 按声明移除 → 有损诚实
  const up2 = chain.migrateUp(legacy);
  ok(up2.fromVersion === 'v1' && up2.toVersion === 'v3' && JSON.stringify(up2.path) === JSON.stringify(['v1', 'v2', 'v3']), '缺省迁移：从链基到最新，path 记录途经版本');
  ok(up2.value.score === undefined && up2.value.tags !== undefined && up2.value.priority === 0, 'v1→v3：score 按弃用声明移除、v2 新增字段就位');
  ok(up2.lossless === false && up2.notes.some((s) => s.includes('score') && s.includes('0.8')), '升级移除已弃用字段 → lossless=false 且 notes 记录原值（无损迁移旧数据到新 schema 的例外仅限声明弃用）');

  // 恒等迁移：from === to
  const idem = chain.migrateUp(legacy, { from: 'v1', to: 'v1' });
  ok(idem.path.length === 1 && idem.lossless === true && idem.notes.length === 0, '恒等迁移（v1→v1）：零步零记账');

  // 降级 v3 → v1：诚实报告丢失字段 + 出口过 v1 严格 schema（additionalProperties:false）
  const fresh = { id: 'm-9', content: '新格式条目', tags: ['a', 'b'], priority: 3 };
  const down = chain.migrateDown(fresh, { from: 'v3', to: 'v1' });
  ok(down.value.id === 'm-9' && down.value.content === '新格式条目' && down.value.score === 0, '降级 v3→v1：途经 v2（score 回填 0）最终 v1 三字段齐备');
  ok(down.lossless === false, '降级全程有损（各步 lossless 之与）');
  const droppedMentioned = ['tags', 'priority', 'score'].every((f) => down.notes.some((s) => s.includes(f)));
  ok(down.notes.length === 3 && droppedMentioned, `降级逐字段记账：tags/priority/score 全部出现在 notes（${down.notes.length} 条 = 途经两步）`);
  ok(down.validation !== undefined && down.validation.ok === true, '降级出口契约：产物通过 v1 严格 schema（新字段被诚实剥除而非静默透传）');

  // 入口契约：输入不符合起始版本 schema 即拒
  throws(() => chain.migrateUp({ id: '', content: 'x', score: 0.5 }, { from: 'v1' }), '入口校验：非法 v1 输入拒绝', /迁移输入不符合 v1/);
  // 方向误用与未知版本
  throws(() => chain.migrateUp(legacy, { from: 'v2', to: 'v1' }), 'migrateUp 不允许降级方向', /方向非法.*migrateDown/);
  throws(() => chain.migrateDown(legacy, { from: 'v1', to: 'v3' }), 'migrateDown 不允许升级方向', /方向非法.*migrateUp/);
  throws(() => chain.migrateUp(legacy, { from: 'v9' }), '未知版本拒绝（附链版本清单）', /v9 不在迁移链/);

  // 注册纪律
  throws(() => chain.register({ from: 'v1', to: 'v2', description: '断裂', up: (d) => ({ value: d, lossless: true, notes: [] }), down: (d) => ({ value: d, lossless: true, notes: [] }) }), '非链尾衔接拒绝注册', /迁移链断裂/);
  const broken = new SchemaMigrationChain('broken');
  throws(() => broken.register({ from: 'v1', to: 'v2', description: '缺函数', up: undefined, down: undefined }), '缺 up/down 拒绝注册', /up\/down/);
  throws(
    () => new SchemaMigrationChain('x').register({
      from: 'v1', to: 'v2', description: '畸形弃用声明',
      removals: [{ field: 'score', deprecatedSince: 'v2', graceVersions: -1 }],
      up: (d) => ({ value: d, lossless: true, notes: [] }),
      down: (d) => ({ value: d, lossless: true, notes: [] }),
    }),
    'graceVersions 负数拒绝（弃用期声明强制）',
    /graceVersions 必须为非负整数/,
  );
  throws(
    () => new SchemaMigrationChain('x').register({
      from: 'v1', to: 'v2', description: '缺弃用起点',
      removals: [{ field: 'score', deprecatedSince: '', graceVersions: 0 }],
      up: (d) => ({ value: d, lossless: true, notes: [] }),
      down: (d) => ({ value: d, lossless: true, notes: [] }),
    }),
    '缺 deprecatedSince 拒绝',
    /deprecatedSince/,
  );

  // 运行时诚实性审计
  const sneaky = new SchemaMigrationChain('sneaky').register({
    from: 'v1', to: 'v2', description: '未声明删除',
    up: (d) => { const { secret, ...rest } = d; return { value: rest, lossless: true, notes: [] }; },
    down: (d) => ({ value: d, lossless: true, notes: [] }),
  });
  throws(() => sneaky.migrateUp({ a: 1, secret: 'x' }), '升级未声明删除字段 → 审计抛错', /未声明的字段删除.*secret/);

  const liarDown = new SchemaMigrationChain('liar').register({
    from: 'v1', to: 'v2', description: '降级谎报无损',
    up: (d) => ({ value: { ...d, extra: 1 }, lossless: true, notes: ['extra ← 缺省 1'] }),
    down: (d) => { const { extra, ...rest } = d; return { value: rest, lossless: true, notes: [] }; },
  });
  throws(() => liarDown.migrateDown({ a: 1, extra: 2 }, { from: 'v2', to: 'v1' }), '降级丢字段谎报 lossless=true → 审计抛错', /lossless=true/);

  const silentDown = new SchemaMigrationChain('silent').register({
    from: 'v1', to: 'v2', description: '降级丢字段不记账',
    up: (d) => ({ value: { ...d, extra: 1 }, lossless: true, notes: ['extra ← 缺省 1'] }),
    down: (d) => { const { extra, ...rest } = d; return { value: rest, lossless: false, notes: ['丢了点东西'] }; },
  });
  throws(() => silentDown.migrateDown({ a: 1, extra: 2 }, { from: 'v2', to: 'v1' }), '降级丢字段未逐字段记账 → 审计抛错', /extra.*未出现在 notes/);

  const badExit = new SchemaMigrationChain('bad-exit')
    .defineVersion('v1', { type: 'object', properties: { a: { type: 'number' } } })
    .defineVersion('v2', { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } })
    .register({
      from: 'v1', to: 'v2', description: '产物类型错',
      up: (d) => ({ value: { ...d, b: 'high' }, lossless: true, notes: ['b ← 缺省 high'] }),
      down: (d) => ({ value: { a: d.a }, lossless: false, notes: ['b 已丢弃'] }),
    });
  throws(() => badExit.migrateUp({ a: 1 }), '出口校验：迁移产物违反目标 schema 即拒', /迁移产物不符合 v2/);

  // 确定性：同数据两次迁移产物逐字节一致
  const r1 = chain.migrateUp(legacy);
  const r2 = chain.migrateUp(legacy);
  ok(JSON.stringify(r1) === JSON.stringify(r2), '确定性：同输入两次迁移 JSON 逐字节一致');
}

// ═══════════════════ S3 声明式不变量库（contracts.ts） ═══════════════════

section('S3-1 三条不变量：健康对象全过 / 违例清单带描述');

{
  const budgetInvariants = [
    invariant('预算必须非负', (s) => s.budget >= 0, 'budget.nonneg'),
    invariant('seq 序列严格单调递增', (s) => s.seqs.every((v, i) => i === 0 || v > s.seqs[i - 1]), 'seq.monotonic'),
    invariant('摘要必须非空', (s) => typeof s.summary === 'string' && s.summary.trim().length > 0, 'summary.nonempty'),
  ];
  const registry = createInvariantRegistry('budget-report').registerAll(budgetInvariants);

  ok(registry.kind === 'budget-report' && registry.specs().length === 3, '注册表 kind 与 3 条声明（注册序）');
  ok(budgetInvariants[0].id === 'budget.nonneg' && invariant('描述即 id', () => true).id === '描述即 id', 'invariant：显式 id 优先，缺省 id 取 description（报告可读且稳定）');

  const healthy = { budget: 120.5, seqs: [1, 2, 5, 9], summary: '本周预算执行' };
  const goodReport = registry.check(healthy);
  ok(goodReport.ok === true && goodReport.total === 3 && goodReport.passedCount === 3 && goodReport.violations.length === 0, '健康对象：3/3 全过');
  ok(registry.assert(healthy).ok === true, 'assert：健康对象不抛');

  const sick = { budget: -5, seqs: [1, 1, 3], summary: '   ' };
  const badReport = registry.check(sick);
  ok(badReport.ok === false && badReport.total === 3 && badReport.passedCount === 0 && badReport.violations.length === 3, '全面违例：0/3 通过');
  ok(
    badReport.violations.map((v) => v.id).join(',') === 'budget.nonneg,seq.monotonic,summary.nonempty' &&
    badReport.violations.every((v) => typeof v.description === 'string' && v.description.length > 0),
    `违例清单按注册序且逐条带描述（${badReport.violations.map((v) => v.description).join('；')}）`,
  );

  const partial = { budget: 10, seqs: [3, 2], summary: 'ok' };
  const partialReport = registry.check(partial);
  ok(partialReport.ok === false && partialReport.passedCount === 2 && partialReport.violations.length === 1 && partialReport.violations[0].id === 'seq.monotonic', '部分违例：2/3 通过、仅 seq 单调性入清单');

  // assert 抛聚合错误：childErrors 带 invariantId
  let thrown = null;
  try { registry.assert(sick); } catch (e) { thrown = e; }
  ok(thrown instanceof AggregateAppError && thrown.code === 'AGGREGATE_ERROR', 'assert 违例抛 AggregateAppError');
  const expectedIds = new Set(['budget.nonneg', 'seq.monotonic', 'summary.nonempty']);
  ok(thrown !== null && thrown.childErrors.length === 3 && thrown.childErrors.every((c) => expectedIds.has(c.details.invariantId)), 'childErrors 逐违例携带 invariantId');
  ok(thrown !== null && ['预算必须非负', 'seq 序列严格单调递增', '摘要必须非空'].every((d) => thrown.message.includes(d) || thrown.childErrors.some((c) => c.message.includes(d))), '失败清单带描述（消息级可读）');

  // 谓词抛错按违例记账（不炸断整批）
  const exploding = createInvariantRegistry('exploding').registerAll([
    invariant('预算非负', (s) => s.budget >= 0, 'a'),
    invariant('会炸的检查', (s) => { if (s.boom) throw new Error('谓词内部错误'); return true; }, 'b'),
    invariant('恒真', () => true, 'c'),
  ]);
  const boomReport = exploding.check({ budget: 1, boom: true });
  ok(boomReport.violations.length === 1 && boomReport.violations[0].id === 'b' && boomReport.violations[0].error === '谓词内部错误', '谓词抛错 → 按违例记账并附 error 摘要（其余检查继续）');

  throws(() => registry.register(invariant('重复', () => true, 'budget.nonneg')), '重复 id 拒绝注册', /重复注册.*budget.nonneg/);
  throws(() => createInvariantRegistry('  '), '空 kind 拒绝', /kind 不能为空/);
  throws(() => invariant('', () => true), '空 description 拒绝', /description 不能为空/);

  // 一次性双入口（裸数组 / 注册表实例）
  const inlineOk = checkInvariants(healthy, budgetInvariants);
  ok(inlineOk.ok === true && inlineOk.total === 3, 'checkInvariants(subject, specs) 轻量入口');
  throws(() => assertInvariants(sick, budgetInvariants), 'assertInvariants(subject, specs)：违例即抛', /不变量检查失败：3\/3/);
  ok(assertInvariants(healthy, registry).ok === true, 'assertInvariants(subject, registry) 注册表入口');
  ok(InvariantRegistry !== undefined, 'InvariantRegistry 类导出（扩展自定义注册表可用）');
}

// ═══════════════════ S4 类型依赖图（types.ts） ═══════════════════

section('S4-1 六类型注册表：图结构查询逐位断言（含前向引用与外部叶）');

{
  const reg = createTypeRegistry('test-graph').registerAll([
    { name: 'Signal', kind: 'interface', description: '信号', fields: [{ name: 'type', type: 'string' }], dependencies: [] },
    { name: 'Plan', kind: 'interface', description: '计划', fields: [{ name: 'signal', type: 'Signal' }, { name: 'steps', type: 'string[]' }], dependencies: ['Signal'] },
    { name: 'Run', kind: 'interface', description: '执行（前向引用 Clock）', fields: [{ name: 'plan', type: 'Plan' }, { name: 'clock', type: 'Clock', optional: true }], dependencies: ['Plan', 'Clock'] },
    { name: 'Clock', kind: 'type-alias', description: '时钟', fields: [], dependencies: [] },
    { name: 'Report', kind: 'interface', description: '报告（菱形汇聚）', fields: [{ name: 'run', type: 'Run' }, { name: 'signal', type: 'Signal' }], dependencies: ['Run', 'Signal'] },
    { name: 'Audit', kind: 'class', description: '审计', fields: [], dependencies: ['Report'] },
    { name: 'Metric', kind: 'interface', description: '指标（引用未注册外部类型 Telemetry）', fields: [{ name: 'src', type: 'Telemetry' }], dependencies: ['Telemetry'] },
  ]);

  ok(reg.name === 'test-graph' && reg.size === 7 && JSON.stringify(reg.names()) === JSON.stringify(['Signal', 'Plan', 'Run', 'Clock', 'Report', 'Audit', 'Metric']), '7 类型注册（≥5；names 按注册序）');
  ok(JSON.stringify(reg.dependenciesOf('Run')) === JSON.stringify(['Plan', 'Clock']), 'dependenciesOf：Run → [Plan, Clock]（前向引用在注册后可查）');
  ok(JSON.stringify(reg.dependentsOf('Signal')) === JSON.stringify(['Plan', 'Report']), 'dependentsOf：Signal 的直接反向依赖 [Plan, Report]（注册序）');
  ok(JSON.stringify(reg.dependentsOf('Plan')) === JSON.stringify(['Run']), 'dependentsOf：Plan → [Run]');
  ok(JSON.stringify(reg.reachableFrom('Audit')) === JSON.stringify(['Report', 'Run', 'Signal', 'Plan', 'Clock']), `reachableFrom('Audit') 传递闭包：${reg.reachableFrom('Audit').join(' → ')}`);
  ok(reg.has('Telemetry') === false && reg.get('Telemetry') === undefined && reg.get('Signal')?.fields.length === 1, 'get/has：未注册外部叶判空、在册元数据可查（字段清单）');

  throws(() => reg.register({ name: 'Signal', kind: 'interface', fields: [], dependencies: [] }), '重复注册拒绝', /重复注册.*Signal/);
  throws(() => reg.register({ name: 'Self', kind: 'interface', fields: [], dependencies: ['Self'] }), '自依赖拒绝', /不允许依赖自身/);
  throws(() => reg.dependenciesOf('NoSuchType'), '未注册名查询依赖拒绝（附在册清单）', /NoSuchType 未注册/);

  const order = reg.topologicalOrder();
  ok(JSON.stringify(order) === JSON.stringify(['Signal', 'Plan', 'Clock', 'Run', 'Report', 'Audit', 'Metric']), `topologicalOrder 稳定序逐位断言：${order.join(' → ')}`);
  const orderOk = order.every((name, idx) => (reg.get(name)?.dependencies ?? []).every((dep) => !reg.has(dep) || order.indexOf(dep) < idx));
  ok(orderOk, '程序化复核：每个类型的在册依赖均排在其之前（未注册叶视为外部）');
  const again = reg.topologicalOrder();
  ok(JSON.stringify(order) === JSON.stringify(again), '确定性：两次拓扑序逐字节一致');

  const desc = reg.describe();
  ok(desc.registry === 'test-graph' && desc.nodes.length === 7 && desc.edges.some((e) => e.from === 'Run' && e.to === 'Clock' && e.registered === true), 'describe()：节点+边快照（dashboard 消费形态）');
  ok(desc.edges.filter((e) => e.to === 'Telemetry').every((e) => e.registered === false), '未注册依赖边标记 registered=false（外部叶显式可辨）');
  const dot = reg.toDot();
  ok(dot.startsWith('digraph "test-graph" {') && dot.includes('"Report" -> "Signal";') && dot.includes('"Metric" -> "Telemetry" [style=dashed];') && dot.endsWith('}'), 'toDot()：确定性 DOT 导出（外部叶虚线边）');
  ok(reg.toDot() === dot, 'toDot() 两次调用逐字节一致');
}

section('S4-2 环检测：detectCycles + topologicalOrder 拒绝');

{
  const cyclic = createTypeRegistry('cyclic').registerAll([
    { name: 'A', kind: 'interface', fields: [], dependencies: ['B'] },
    { name: 'B', kind: 'interface', fields: [], dependencies: ['C'] },
    { name: 'C', kind: 'interface', fields: [], dependencies: ['A'] },
    { name: 'D', kind: 'interface', fields: [], dependencies: [] },
  ]);
  const cycles = cyclic.detectCycles();
  ok(cycles.length === 1 && cycles[0][0] === 'A' && cycles[0].includes('B') && cycles[0].includes('C') && cycles[0][cycles[0].length - 1] === 'A', `detectCycles：A → B → C → A 完整环路径（${cycles[0]?.join(' → ') ?? '无'}）`);
  throws(() => cyclic.topologicalOrder(), '有环图无拓扑序：抛错且消息含环路径', /存在 1 个环.*A → B → C → A/);
  ok(cyclic.dependentsOf('D').length === 0, '无环节点 D 反向依赖为空（环外部分照常可查）');
}

section('S4-3 CORE_TYPE_REGISTRY：9 核心类型预置 + 拓扑序程序化验证');

{
  const reg = CORE_TYPE_REGISTRY;
  const expected = ['NodeId', 'ModelId', 'AppError', 'PlanNode', 'ExecutionPlan', 'NodeResult', 'PlanExecutionResult', 'EventEnvelope', 'ExecutionError'];
  ok(reg.size === 9 && expected.every((n) => reg.has(n)), `核心注册表 9 类型齐全（${reg.names().join('、')}）`);
  ok(JSON.stringify(reg.dependenciesOf('ExecutionPlan')) === JSON.stringify(['PlanNode']) && JSON.stringify(reg.dependenciesOf('ExecutionError')) === JSON.stringify(['AppError']), '核心依赖边：ExecutionPlan→PlanNode、ExecutionError→AppError');
  ok(JSON.stringify(reg.dependentsOf('PlanNode')) === JSON.stringify(['ExecutionPlan']) && reg.dependentsOf('NodeId').includes('PlanNode'), '核心反向依赖：PlanNode ← ExecutionPlan；NodeId ← PlanNode/NodeResult');
  const order = reg.topologicalOrder();
  const valid = order.every((name, idx) => (reg.get(name)?.dependencies ?? []).every((dep) => order.indexOf(dep) < idx));
  ok(order.length === 9 && valid, `核心拓扑序程序化验证：全部在册依赖排在前（${order.join(' → ')}）`);
  ok(order.indexOf('AppError') < order.indexOf('ExecutionError') && order.indexOf('PlanNode') < order.indexOf('ExecutionPlan') && order.indexOf('NodeResult') < order.indexOf('PlanExecutionResult'), '关键偏序抽查：AppError<ExecutionError、PlanNode<ExecutionPlan、NodeResult<PlanExecutionResult');
  ok(reg.toDot().includes('digraph "dsh-core" {'), '核心注册表 DOT 标题 dsh-core（文档生成直消费）');
}

// ═══════════════════ S5 错误重试策略声明（errors.ts） ═══════════════════

section('S5-1 策略缺省表：retryability → 运维动作的声明式派生');

{
  ok(
    RETRY_POLICY_DEFAULTS.never.kind === 'none' && RETRY_POLICY_DEFAULTS.never.maxAttempts === 1 &&
    RETRY_POLICY_DEFAULTS.immediate.kind === 'immediate' && RETRY_POLICY_DEFAULTS.immediate.maxAttempts === 3 &&
    RETRY_POLICY_DEFAULTS.backoff.kind === 'backoff' && RETRY_POLICY_DEFAULTS.backoff.backoffBaseMs === 500 && RETRY_POLICY_DEFAULTS.backoff.backoffCapMs === 30000 &&
    RETRY_POLICY_DEFAULTS['after-fix'].kind === 'escalate' && RETRY_POLICY_DEFAULTS['after-fix'].maxAttempts === 1,
    '四分类缺省表字段完备：never→none / immediate→immediate / backoff→backoff(500ms 起、封顶 30s) / after-fix→escalate',
  );
  ok(CONSERVATIVE_RETRY_POLICY.kind === 'none' && CONSERVATIVE_RETRY_POLICY.maxAttempts === 1, '保守缺省：未注册码不重试（宁可少做不误做）');
  ok(Object.values(RETRY_POLICY_DEFAULTS).every((p) => typeof p.description === 'string' && p.description.length > 0), '每条缺省策略带说明（审计可读）');
}

section('S5-2 错误流策略路由：8 形态逐位断言（含未注册码保守缺省）');

{
  const stream = [
    [new TimeoutError('模型超时'), 'backoff'],
    [new NetworkError('断连'), 'backoff'],
    [new ConfigError('缺配置'), 'escalate'],
    [new AppError('x', 'MEMORY_ERROR'), 'immediate'],
    [new TypedAppError('x', { code: 'VALIDATION_ERROR' }), 'none'],
    [new Error('connection timeout after 30s'), 'backoff'],
    [new AppError('x', 'TOTALLY_UNKNOWN_CODE'), 'none'],
    [new TypedAppError('x', { code: 'WEIRD_UNREGISTERED' }), 'none'],
  ];
  let routed = 0;
  for (const [error, expectedKind] of stream) {
    const policy = retryPolicyFor(error);
    const hit = policy.kind === expectedKind;
    if (hit) routed += 1;
    ok(hit, `路由：${classifyLabel(error)} → ${policy.kind}（期望 ${expectedKind}）`);
  }
  ok(routed === stream.length, `错误流 ${stream.length} 形态全部按声明路由（在册走注册表派生、未注册码走保守缺省）`);
  ok(retryPolicyFor('裸字符串').kind === 'immediate' && retryPolicyFor(undefined).kind === 'immediate', '非 Error 抛出物经 UNKNOWN_ERROR(immediate) 就近派生');
  ok(stream.slice(0, 6).every(([error]) => isRetryableError(error) === (retryPolicyFor(error).kind === 'immediate' || retryPolicyFor(error).kind === 'backoff')), '与第三轮 isRetryableError 口径一致（kind immediate|backoff ⇔ 可重试）');
  ok(retryPolicyFor(new AppError('x', 'TOTALLY_UNKNOWN_CODE')).description.includes('未注册'), '保守缺省 description 诚实报告需要补注册');
}

section('S5-3 shouldRetry 边界 / retryDelayMs 纯指数 / planRetries 展开');

{
  const to = new TimeoutError('超时');
  ok(shouldRetry(to, 1) === true && shouldRetry(to, 2) === true && shouldRetry(to, 3) === true && shouldRetry(to, 4) === false, 'Timeout(backoff, max=4)：attemptsMade 1~3 续、4 停');
  ok(shouldRetry(new ConfigError('x'), 1) === false, 'Config(escalate)：永不自动重试');
  const mem = new AppError('x', 'MEMORY_ERROR');
  ok(shouldRetry(mem, 1) === true && shouldRetry(mem, 2) === true && shouldRetry(mem, 3) === false, 'Memory(immediate, max=3)：1~2 续、3 停');
  ok(shouldRetry(new AppError('x', 'UNKNOWN_X'), 1) === false, '未注册码保守缺省：不重试');
  throws(() => shouldRetry(to, 0), 'attemptsMade=0 拒绝', /attemptsMade 必须/);
  throws(() => shouldRetry(to, 1.5), 'attemptsMade 非整数拒绝', /attemptsMade 必须/);

  ok(retryDelayMs(to, 1) === 500 && retryDelayMs(to, 2) === 1000 && retryDelayMs(to, 3) === 2000, '指数退避：500 → 1000 → 2000（base × 2^(n-1)，无抖动确定性）');
  const capped = registerRetryPolicy('LLM_ERROR_SLOW', { kind: 'backoff', maxAttempts: 5, backoffBaseMs: 10000, backoffCapMs: 25000, description: '慢退避' });
  const slow = new AppError('x', 'LLM_ERROR_SLOW');
  ok(capped.kind === 'backoff' && retryDelayMs(slow, 1) === 10000 && retryDelayMs(slow, 2) === 20000 && retryDelayMs(slow, 3) === 25000, '封顶：min(cap, base×2^(n-1)) → 10000/20000/25000');
  ok(retryDelayMs(mem, 1) === 0 && retryDelayMs(new ConfigError('x'), 1) === 0, 'immediate 延迟 0；escalate/none 延迟 0');
  unregisterRetryPolicy('LLM_ERROR_SLOW');

  const plan = planRetries(to);
  ok(
    plan.code === 'TIMEOUT_ERROR' && plan.policy.kind === 'backoff' &&
    JSON.stringify(plan.steps) === JSON.stringify([{ attempt: 2, delayMs: 500 }, { attempt: 3, delayMs: 1000 }, { attempt: 4, delayMs: 2000 }]),
    `planRetries 完整展开：${plan.steps.map((s) => `#${s.attempt}@${s.delayMs}ms`).join(' → ')}`,
  );
  ok(planRetries(new ConfigError('x')).steps.length === 0 && planRetries(new AppError('x', 'X_CODE')).steps.length === 0, 'escalate/保守缺省计划为空（不自动重试）');
  ok(JSON.stringify(planRetries(to)) === JSON.stringify(planRetries(to)), '确定性：同错误两次计划逐字节一致');
}

section('S5-4 覆盖注册 / 撤销 / 畸形拒绝 / 升级人工判定');

{
  const to = new TimeoutError('超时');
  const llm = new AppError('x', 'LLM_ERROR');
  ok(retryPolicyFor(llm).kind === 'backoff', '覆盖前：LLM_ERROR 走注册表派生 backoff');
  registerRetryPolicy('LLM_ERROR', { kind: 'immediate', maxAttempts: 2, description: '降级到立即重试（热修）' });
  ok(retryPolicyFor(llm).kind === 'immediate' && shouldRetry(llm, 1) === true && shouldRetry(llm, 2) === false, '显式覆盖生效：LLM_ERROR → immediate(max=2)');
  ok(registeredRetryPolicyCodes().includes('LLM_ERROR'), 'registeredRetryPolicyCodes 枚举覆盖表');
  ok(unregisterRetryPolicy('LLM_ERROR') === true && retryPolicyFor(llm).kind === 'backoff' && unregisterRetryPolicy('LLM_ERROR') === false, '撤销覆盖回退派生缺省（再撤销=false）');

  throws(() => registerRetryPolicy('X', { kind: 'sometimes', maxAttempts: 2, description: 'x' }), 'kind 非法拒绝', /kind 非法/);
  throws(() => registerRetryPolicy('X', { kind: 'backoff', maxAttempts: 0, description: 'x' }), 'maxAttempts<1 拒绝', /maxAttempts 必须/);
  throws(() => registerRetryPolicy('X', { kind: 'backoff', maxAttempts: 3, description: 'x' }), 'backoff 缺 backoffBaseMs 拒绝', /backoffBaseMs/);
  throws(() => registerRetryPolicy('X', { kind: 'none', maxAttempts: 3, description: 'x' }), 'none 且 maxAttempts≠1 拒绝（不自动重试）', /maxAttempts 必须为 1/);
  throws(() => registerRetryPolicy('X', { kind: 'immediate', maxAttempts: 2, description: '' }), '缺 description 拒绝', /description/);
  throws(() => registerRetryPolicy('  ', { kind: 'none', maxAttempts: 1, description: 'x' }), '空错误码拒绝', /错误码不能为空/);

  ok(needsHumanEscalation(new ConfigError('x'), 0) === true, 'escalate 策略恒升级人工');
  ok(needsHumanEscalation(to, 3) === false && needsHumanEscalation(to, 4) === true, 'Timeout：连续失败 <escalateAfter(4) 不升级、≥4 升级');
  const net = new NetworkError('x');
  ok(needsHumanEscalation(net, 3) === false && needsHumanEscalation(net, 4) === true, 'Network 同为 backoff 缺省：阈值 4');
  ok(needsHumanEscalation(new AppError('x', 'UNKNOWN_Z'), 1) === true, '保守缺省兜底：无 escalateAfter 时按 maxAttempts=1（首次失败即升级）');
  throws(() => needsHumanEscalation(to, -1), 'consecutiveFailures 负数拒绝', /consecutiveFailures 必须/);

  // 错误流 → 策略全景路由表（模拟一次调度失败处理管道）
  const pipeline = [
    new TimeoutError('t'), new NetworkError('n'), new ConfigError('c'),
    new AppError('m', 'MEMORY_ERROR'), new TypedAppError('v', { code: 'VALIDATION_ERROR' }),
  ];
  const routed = pipeline.map((e) => {
    const policy = retryPolicyFor(e);
    const retries = [];
    for (let made = 1; made <= policy.maxAttempts; made += 1) {
      if (shouldRetry(e, made)) retries.push(retryDelayMs(e, made));
    }
    return { code: planRetries(e).code, kind: policy.kind, retries, human: needsHumanEscalation(e, policy.maxAttempts) };
  });
  ok(
    JSON.stringify(routed) === JSON.stringify([
      { code: 'TIMEOUT_ERROR', kind: 'backoff', retries: [500, 1000, 2000], human: true },
      { code: 'NETWORK_ERROR', kind: 'backoff', retries: [500, 1000, 2000], human: true },
      { code: 'CONFIG_ERROR', kind: 'escalate', retries: [], human: true },
      { code: 'MEMORY_ERROR', kind: 'immediate', retries: [0, 0], human: true },
      { code: 'VALIDATION_ERROR', kind: 'none', retries: [], human: true },
    ]),
    `错误流策略路由全景：${routed.map((r) => `${r.code}=${r.kind}${r.retries.length ? `[${r.retries.join('/')}]` : ''}`).join('；')}`,
  );
}

// ═══════════════════ S6 零漂移总检（纯增量证据） ═══════════════════

section('S6 零漂移：第三轮既有面原样 + 新类型并列打包');

{
  ok(REGISTERED_ERROR_CODES.length === 13 && Object.keys(ERROR_REGISTRY).length === 13, '错误码注册表仍为 13 码（本轮零增删）');
  const t = new TypedAppError('x', { code: 'CONFIG_ERROR', httpStatus: 507 });
  ok(t.severity === 'critical' && t.httpStatus === 507 && t.retryable === false, 'TypedAppError 注册表缺省+逐字段覆盖语义原样');
  const plan = { objective: 'o', nodes: [{ id: 'n1', description: 'd', type: 't', dependsOn: [] }], parallelismStrategy: 'p', source: 'strategist' };
  ok(validate(plan, EXECUTION_PLAN_SCHEMA).ok === true && validate({ ...plan, source: 'bad' }, EXECUTION_PLAN_SCHEMA).ok === false, '第三轮校验器与预设 schema 行为原样');
  const agg = AggregateAppError.fromChildren([new TimeoutError('a'), new TimeoutError('b')]);
  ok(agg.message === '聚合失败：2 个子错误（TIMEOUT_ERROR×2）', 'AggregateAppError 摘要确定性原样');

  const dts = fs.readFileSync(path.join(REPO, 'dist', 'index.d.mts'), 'utf8');
  const legacyNames = ['IMemoryStore', 'IReflector', 'IOptimizer', 'SchemaSpec', 'validate', 'TypedAppError', 'ERROR_REGISTRY', 'SignalId', 'Result', 'EventEnvelope', 'EventSequencer'];
  const newNames = ['ApiVersion', 'parseApiVersion', 'negotiateApiVersion', 'VersionNegotiation', 'classifyVersionPair', 'declareApiVersions',
    'SchemaMigration', 'SchemaMigrationChain', 'MigrationResult', 'FieldRemovalDeclaration',
    'InvariantSpec', 'invariant', 'InvariantRegistry', 'assertInvariants', 'checkInvariants',
    'TypeMeta', 'TypeRegistry', 'CORE_TYPE_REGISTRY', 'createTypeRegistry',
    'RetryPolicy', 'RETRY_POLICY_DEFAULTS', 'retryPolicyFor', 'shouldRetry', 'retryDelayMs', 'planRetries', 'needsHumanEscalation'];
  const absent = [...legacyNames, ...newNames].filter((n) => !new RegExp(`\\b${n}\\b`).test(dts));
  ok(absent.length === 0, `dist/index.d.mts 新旧 ${legacyNames.length + newNames.length} 个名字齐全（缺失：${absent.join(',') || '无'}——纯增量零删除）`);
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— 基础契约层第四轮五项升级验证成立`);
  console.log('  │ 升级面             │ 旧行为                     │ 新行为（本轮验证）                          │');
  console.log('  │--------------------│-----------------------------│---------------------------------------------│');
  console.log('  │ API 版本            │ 无协商（隐式同版本假设）      │ 语义版本协商矩阵：exact/最小升级/降级建议/拒绝 │');
  console.log('  │ schema 变更         │ 手工改字段、旧数据靠猜       │ 迁移链：缺省回填/弃用声明/升降级诚实审计      │');
  console.log('  │ 健康规约            │ 散落的 if 断言              │ 不变量注册表：一次检查全部、违例清单带描述    │');
  console.log('  │ 类型元数据          │ 仅编译期（运行时不可见）      │ 类型依赖图：拓扑序/影响分析/DOT 导出          │');
  console.log('  │ 重试决策            │ retryability 二值粗分       │ 策略四分法+覆盖表+确定性退避计划+升级人工     │');
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
