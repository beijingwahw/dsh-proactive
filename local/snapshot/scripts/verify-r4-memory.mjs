/**
 * verify-r4-memory.mjs — 第四轮模块域升级：记忆子系统「激活与深化」新旧行为对照验证
 *
 * 五项全新维度升级各配「旧世界 vs 新世界」的构造对照（不是「改了」，是「证明更好」）：
 *   ① 冲突记忆仲裁：同主题新旧结论相反时，（证据量 × 新鲜度 × 来源质量）三因子
 *      几何加权裁决——败方降级「历史观点」不删除。旧世界（upsert 1.5 倍支撑硬门槛）：
 *      16 支撑/0 天/6 源的新鲜证据 vs 20 支撑在位者 → 16 < 30 → 'duplicate' 直接丢弃；
 *      新世界：仲裁分 0.8049 vs 0.3633 翻转胜出，旧结论降级留档（supportCount 20 完整
 *      保留、demotedBy 审计在案、findSemanticMemory 切换到新结论）。另验卫冕（证据
 *      厚度顶住新鲜度）、同分保守、批量复审、降级经 SQLite 后端持久化。
 *   ② 记忆老化温度曲线：温度 = 0.5^(有效年龄/半衰期)，有效年龄 = 年龄/(1+保温系数)，
 *      保温 = 访问增益×log2(1+访问) + 引用增益×log2(1+引用)。保温 vs 荒废分岔流：
 *      同龄 90 天双胞胎——30 次访问 + 5 次被引用者 0.439（温层驻留 keep），
 *      1 次访问 0 引用者 0.051（冻结层 archive/evict-candidate）。旧世界线性年龄模型
 *      对两者读数完全相同（各 0.25，Δ=0）——保温完全不可见；新世界 Δ≈0.388。
 *   ③ 经验因果链溯源：每条沉淀登记「信号→执行→(反思)→洞察」因果链，跨沉淀链式
 *      衍生（derivedFromMemoryId）——三次沉淀三级衍生，trace 深度 3 逐级回溯到
 *      根信号 sig-101；缺要素链诚实降级 complete=false；环状衍生防死循环。
 *   ④ 记忆健康审计：已知缺陷库（近邻重复对/同主题反结论对/孤岛/陈旧条目/类型构成
 *      漂移）五类指标全检出 + 综合健康分手算对照（66.25 = 100×(1-0.3375)）；
 *      健康孪生库全零缺陷得 100 分；旧世界只有裸计数摘要（getMemorySummary），
 *      对缺陷完全失明。
 *   ⑤ 跨任务迁移映射（加分）：任务类型间知识借用学习表——Wilson 95% 下界评分
 *      （10 借 9 成 ≈ 0.596 / 5 借 1 成 ≈ 0.036），可迁移对发现 + 去向建议排序；
 *      无借用史回退结构相关度对折（learned=false 诚实标注）；方向性（A→B ≠ B→A）。
 *   ⑥ 零漂移 + 集成：全部新 API 未挂载时 undefined/空态；仲裁降级经导出→导入
 *      往返无损（bypassConflictGate——迁移是传输不是裁决）；空库审计无 NaN。
 *
 * 确定性：全脚本注入固定时钟（FIXED = 1.7e12），无 Math.random / 真实时间依赖；
 * 三因子分 / 温度 / Wilson 下界均在脚本侧用独立公式实现 oracle 手算对照。
 *
 * 运行：npm run build && node scripts/verify-r4-memory.mjs
 */

import {
  LongTermMemory,
  MigrationTool,
  TransferMap,
  temperatureOf,
} from '../dist/index.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
function near(a, b, tol = 1e-4) {
  return Math.abs(a - b) <= tol;
}
function section(title) {
  console.log(`\n■ ${title}`);
}

// ─────────────────────────── 固定时钟与工厂 ───────────────────────────
const FIXED = 1_700_000_000_000;
const DAY = 86_400_000;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-r4-memory-'));
const memories = [];
function openMemory(name) {
  const m = new LongTermMemory(path.join(workDir, `${name}.json`));
  memories.push(m);
  return m;
}
function makePattern(fingerprint, taskSummary, confidence, opts = {}) {
  return {
    fingerprint,
    taskSummary,
    frequency: opts.frequency ?? 3,
    firstSeenAt: opts.firstSeenAt ?? FIXED - DAY,
    lastSeenAt: opts.lastSeenAt ?? FIXED - DAY,
    successfulPlans: [],
    failureRecords: [],
    confidence,
    avgExecutionTime: 0,
    avgQualityScore: 0,
  };
}
function makeSemantic(id, value, supportCount, distilledAt, sourceFingerprints, extra = {}) {
  return {
    id,
    domain: 'model-affinity',
    statement: `${id}: 长代码任务适合 ${value}`,
    taskTypes: ['code-generation'],
    conditions: [{ dimension: 'feature', operator: 'contains', value: 'code' }],
    conclusion: { type: 'model-preference', value, rationale: '验证样本' },
    confidence: extra.confidence ?? 0.85,
    supportCount,
    sourceFingerprints,
    distilledAt,
    appliedTotal: 0,
    appliedSuccesses: 0,
    ...extra,
  };
}

// 脚本侧三因子 oracle（与实现独立的同一公式，手算口径）
function oracleArbitrationScore(supportCount, ageDays, distinctSources) {
  const evidenceMass = supportCount / (supportCount + 5);
  const freshness = Math.pow(0.5, ageDays / 30);
  const sourceQuality = distinctSources / (distinctSources + 3);
  return Math.pow(evidenceMass, 0.5) * Math.pow(freshness, 0.3) * Math.pow(sourceQuality, 0.2);
}
// 脚本侧 Wilson 95% 下界 oracle
function oracleWilsonLower(successes, failures) {
  const z = 1.96;
  const n = successes + failures;
  if (n <= 0) return 0;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

// ═══════════════════ ① 冲突记忆仲裁：新证据推翻旧结论 ═══════════════════
section('① 冲突记忆仲裁：三因子加权裁决，败方降级历史观点不删除');

{
  const m = openMemory('arbiter');
  // 旧结论在位者：20 支撑 / 90 天前沉淀 / 单一溯源来源
  const incumbent = makeSemantic('sem-old', 'model-x', 20, FIXED - 90 * DAY, ['fp-solo']);
  ok(m.upsertSemanticMemory(incumbent) === 'created', '旧结论在位者入库（sem-old → model-x）');

  // ── 旧世界：upsert 1.5 倍支撑硬门槛 ──
  const challenger = makeSemantic('sem-new', 'model-y', 16, FIXED, ['fp-1', 'fp-2', 'fp-3', 'fp-4', 'fp-5', 'fp-6']);
  const oldWorld = m.upsertSemanticMemory(challenger);
  ok(oldWorld === 'duplicate', `旧世界：16 支撑 < 20×1.5=30 → '${oldWorld}'（0 天新鲜 + 6 源多样的新证据被直接丢弃）`);
  ok(m.getAllSemanticMemories().length === 1, '旧世界：挑战者未入库（丢弃即无痕——矛盾未被裁决，只是被无视）');

  // ── 新世界：三因子仲裁准入 ──
  ok(m.admitWithArbitration(challenger) === undefined, '未挂载仲裁器 → admitWithArbitration undefined（零介入）');
  ok(m.arbitrateConflicts() === undefined, '未挂载仲裁器 → arbitrateConflicts undefined（零介入）');
  m.attachArbiter({ now: () => FIXED });
  const verdict1 = m.admitWithArbitration(challenger);
  const scoreOld = oracleArbitrationScore(20, 90, 1); // ≈ 0.3633
  const scoreNew = oracleArbitrationScore(16, 0, 6); // ≈ 0.8049
  ok(verdict1?.outcome === 'arbitrated' && verdict1.challengerStatus === 'active',
    `仲裁翻转：挑战者留任现役（${verdict1?.verdict.winner.score} vs ${verdict1?.verdict.loser.score}）`);
  ok(near(verdict1?.verdict.winner.score ?? 0, scoreNew) && near(verdict1?.verdict.loser.score ?? 0, scoreOld),
    `三因子分与 oracle 手算一致（新 ${scoreNew.toFixed(4)} / 旧 ${scoreOld.toFixed(4)}——证据 0.762×新鲜 1.0×来源 0.667 击败 0.8×0.125×0.25）`);
  ok(verdict1?.verdict.flipped === true, 'flipped=true（更晚沉淀者胜出——新证据推翻旧结论）');
  ok(verdict1?.verdict.rawSupportUpset === true, 'rawSupportUpset=true（裸支撑 16<20 仍胜——加权口径击败纯证据量口径）');

  // 败方不删除：历史观点完整保留可查
  const views = m.historicalViews('semantic');
  ok(views.length === 1 && views[0].id === 'sem-old', '败方降级为历史观点（status=historical，记录仍在库）');
  ok(views[0].supportCount === 20 && views[0].conclusion.value === 'model-x', '旧观点数据完整保留（20 支撑 / model-x 结论未删一字）');
  ok(views[0].demotedBy?.winnerId === 'sem-new' && near(views[0].demotedBy?.winnerScore ?? 0, scoreNew), `降级审计在案（被 ${views[0].demotedBy?.winnerId} 以 ${views[0].demotedBy?.winnerScore?.toFixed(4)} 分击败）`);
  ok(m.findSemanticMemory('code-generation', { features: ['code'] })?.id === 'sem-new', '检索切换到新结论（findSemanticMemory → sem-new）');
  ok(!m.getSemanticMemories('code-generation').some((x) => x.id === 'sem-old'), '历史观点不再进入现役推荐（getSemanticMemories 过滤 historical）');

  // ── 卫冕：证据厚度顶住新鲜度 ──
  const strongman = makeSemantic('sem-strong', 'model-z', 50, FIXED - 10 * DAY, ['fp-a', 'fp-b', 'fp-c', 'fp-d', 'fp-e', 'fp-f', 'fp-g', 'fp-h']);
  strongman.conditions = [{ dimension: 'feature', operator: 'contains', value: 'sql' }];
  strongman.statement = 'sem-strong: SQL 任务适合 model-z';
  m.upsertSemanticMemory(strongman);
  const weakChallenger = makeSemantic('sem-weak-challenger', 'model-w', 16, FIXED, ['fp-1', 'fp-2', 'fp-3', 'fp-4', 'fp-5', 'fp-6']);
  weakChallenger.conditions = [{ dimension: 'feature', operator: 'contains', value: 'sql' }];
  weakChallenger.statement = 'sem-weak-challenger: SQL 任务适合 model-w';
  const verdict2 = m.admitWithArbitration(weakChallenger);
  const scoreStrong = oracleArbitrationScore(50, 10, 8); // ≈ 0.8347
  const scoreWeak = oracleArbitrationScore(16, 0, 6); // ≈ 0.8049
  ok(verdict2?.outcome === 'arbitrated' && verdict2.challengerStatus === 'historical',
    `卫冕成立：0.8347 > 0.8049，在位者留任（挑战者败——但入库留档而非丢弃）`);
  ok(near(verdict2?.verdict.winner.score ?? 0, scoreStrong), `胜者分与 oracle 一致（${scoreStrong.toFixed(4)}——50 支撑/10 天/8 源的证据厚度顶住满新鲜度）`);
  ok(verdict2?.verdict.flipped === false, 'flipped=false（旧结论卫冕——仲裁不是无条件偏新）');
  const views2 = m.historicalViews('semantic');
  ok(views2.length === 2 && views2.some((v) => v.id === 'sem-weak-challenger'), '挑战者败方同样降级留档（2 条历史观点：翻转载 + 卫冕败）');
  ok(views2.find((v) => v.id === 'sem-weak-challenger')?.demotedBy?.winnerId === 'sem-strong', '败方审计指向卫冕者（翻转/卫冕两方向都有审计轨迹）');

  // ── 持久化：降级状态经 SQLite 后端重启存活 ──
  m.flushSync();
  const dbFile = path.join(workDir, 'arbiter.json');
  m.dispose();
  memories.splice(memories.indexOf(m), 1);
  const reopened = new LongTermMemory(dbFile);
  memories.push(reopened);
  const persisted = reopened.historicalViews('semantic');
  ok(persisted.length === 2 && persisted.every((v) => v.status === 'historical' && v.demotedBy),
    `降级状态持久化：进程重启后历史观点仍在（${persisted.length} 条，demotedBy 审计完整）`);
  ok(reopened.findSemanticMemory('code-generation', { features: ['code'] })?.id === 'sem-new', '重启后现役结论仍是新证据（裁决跨会话生效）');

  // ── 同分保守 + 批量复审（arbitrateConflicts 全库扫描） ──
  const m2 = openMemory('arbiter-batch');
  const twin1 = makeSemantic('sem-twin-1', 'model-t1', 10, FIXED - 30 * DAY, ['p1', 'p2', 'p3', 'p4']);
  const twin2 = makeSemantic('sem-twin-2', 'model-t2', 10, FIXED - 30 * DAY, ['q1', 'q2', 'q3', 'q4']);
  twin2.conditions = [{ dimension: 'feature', operator: 'contains', value: 'rust' }];
  twin2.statement = 'sem-twin-2: rust 任务适合 model-t2';
  twin1.conditions = [{ dimension: 'feature', operator: 'contains', value: 'rust' }];
  twin1.statement = 'sem-twin-1: rust 任务适合 model-t1';
  m2.upsertSemanticMemory(twin1);
  m2.attachArbiter({ now: () => FIXED });
  const tieVerdict = m2.admitWithArbitration(twin2);
  ok(tieVerdict?.outcome === 'tie' && m2.historicalViews('semantic').length === 0,
    '同分保守：证据分毫相差 → 双方都留任现役（证据不足不翻案，无降级）');
  // 复审时钟推进 30 天：twin-2 有 lastAppliedAt 保温、twin-1 无 → 分差拉开，批量仲裁裁决
  const twin2Applied = makeSemantic('sem-twin-2', 'model-t2', 10, FIXED - 30 * DAY, ['q1', 'q2', 'q3', 'q4'], { lastAppliedAt: FIXED });
  twin2Applied.conditions = [{ dimension: 'feature', operator: 'contains', value: 'rust' }];
  twin2Applied.statement = 'sem-twin-2: rust 任务适合 model-t2';
  m2.upsertSemanticMemory(twin2Applied, { bypassConflictGate: true }); // 补上 lastAppliedAt（同 id 覆盖）
  m2.attachArbiter({ now: () => FIXED + 30 * DAY });
  const batch = m2.arbitrateConflicts();
  ok(batch !== undefined && batch.conflictsConsidered === 1 && batch.demotedCount === 1,
    `批量复审裁决 1 对（conflictsConsidered=${batch?.conflictsConsidered}，demoted=${batch?.demotedCount}——共存现役对的批量再仲裁通道）`);
  const scoreT1 = oracleArbitrationScore(10, 60, 4);
  const scoreT2 = oracleArbitrationScore(10, 30, 4);
  ok(near(batch?.verdicts[0]?.winner.score ?? 0, scoreT2) && near(batch?.verdicts[0]?.loser.score ?? 0, scoreT1),
    `复审分与 oracle 一致（保温者 ${scoreT2.toFixed(4)} > 荒废者 ${scoreT1.toFixed(4)}——新鲜度按 lastAppliedAt 计）`);
  ok(m2.historicalViews('semantic').map((v) => v.id).join(',') === 'sem-twin-1', '复审败方降级（twin-1 历史化，twin-2 留任）');
}

// ═══════════════════ ② 记忆老化温度曲线：保温 vs 荒废分岔 ═══════════════════
section('② 记忆老化温度曲线：非线性冷却，访问/引用保温，温度驱动处置建议');

{
  // 纯函数手算对照（与实现独立的公式 oracle）
  const oracleTemperature = (ageDays, accesses, citations) => {
    const warmth = 0.5 * Math.log2(1 + accesses) + 0.75 * Math.log2(1 + citations);
    const effectiveAge = ageDays / (1 + warmth);
    return { warmth, temperature: Math.pow(0.5, effectiveAge / 14) };
  };

  const pure = temperatureOf({ ageDays: 90, accesses: 30, citations: 5 });
  const oracleKept = oracleTemperature(90, 30, 5);
  ok(near(pure.temperature, oracleKept.temperature, 1e-5) && pure.band === 'warm',
    `纯函数手算对照：90 天 + 30 访问 + 5 引用 → 温度 ${pure.temperature}（warm 层——保温折慢时钟）`);
  const pureFrozen = temperatureOf({ ageDays: 90, accesses: 1, citations: 0 });
  ok(pureFrozen.band === 'frozen' && near(pureFrozen.temperature, Math.pow(0.5, 60 / 14), 1e-5),
    `同龄荒废条目 → ${pureFrozen.temperature}（frozen——有效年龄 60 天全速冷却）`);

  const m = openMemory('temperature');
  ok(m.temperatureProfile() === undefined, '未挂载温度模型 → temperatureProfile undefined（零介入）');
  // 分岔流：五条模式，引用计数走缺省溯源统计（语义记忆 sourceFingerprints）
  m.upsertPattern(makePattern('kept::0.5::code', '常青知识：长代码任务方案', 0.9, { firstSeenAt: FIXED - 90 * DAY, lastSeenAt: FIXED - 90 * DAY, frequency: 30 }));
  m.upsertPattern(makePattern('neglect::0.5::code', '荒废知识：一次性实验', 0.2, { firstSeenAt: FIXED - 90 * DAY, lastSeenAt: FIXED - 90 * DAY, frequency: 1 }));
  m.upsertPattern(makePattern('archive::0.5::misc', '高龄高信条目', 0.8, { firstSeenAt: FIXED - 90 * DAY, lastSeenAt: FIXED - 90 * DAY, frequency: 1 }));
  m.upsertPattern(makePattern('hot::0.5::web', '灼热新知识', 0.95, { firstSeenAt: FIXED - 5 * DAY, lastSeenAt: FIXED - 1 * DAY, frequency: 40 }));
  m.upsertPattern(makePattern('cooling::0.5::db', '中龄缓冷条目', 0.7, { firstSeenAt: FIXED - 70 * DAY, lastSeenAt: FIXED - 70 * DAY, frequency: 2 }));
  // 缺省引用计数：5 条语义记忆各自引用 kept（5 次）；1 条引用 hot（1 次）
  for (let i = 1; i <= 5; i += 1) {
    m.upsertSemanticMemory({
      id: `cite-kept-${i}`, domain: 'feature-correlation', statement: `引用 kept 的规律 ${i}`, taskTypes: [],
      conditions: [], conclusion: { type: 'parameter-tuning', value: 1, rationale: '引用' },
      confidence: 0.8, supportCount: 2, sourceFingerprints: ['kept::0.5::code'], distilledAt: FIXED - DAY, appliedTotal: 0, appliedSuccesses: 0,
    });
  }
  m.upsertSemanticMemory({
    id: 'cite-hot-1', domain: 'feature-correlation', statement: '引用 hot 的规律', taskTypes: [],
    conditions: [], conclusion: { type: 'parameter-tuning', value: 1, rationale: '引用' },
    confidence: 0.8, supportCount: 2, sourceFingerprints: ['hot::0.5::web'], distilledAt: FIXED - DAY, appliedTotal: 0, appliedSuccesses: 0,
  });
  m.attachTemperatureModel({ now: () => FIXED });
  const profile = m.temperatureProfile();
  ok(profile !== undefined, '挂载温度模型 → 剖面可用');

  const byFp = new Map((profile?.entries ?? []).map((e) => [e.fingerprint, e]));
  const kept = byFp.get('kept::0.5::code');
  const neglect = byFp.get('neglect::0.5::code');
  const hot = byFp.get('hot::0.5::web');
  const archive = byFp.get('archive::0.5::misc');
  const cooling = byFp.get('cooling::0.5::db');
  ok(kept?.citations === 5 && hot?.citations === 1 && neglect?.citations === 0,
    `缺省引用计数走溯源统计（kept 被引 5 次 / hot 1 次 / neglect 0 次）`);
  ok(near(kept?.temperature ?? 0, oracleTemperature(90, 30, 5).temperature, 1e-5) && kept?.band === 'warm',
    `保温条目：${kept?.temperature}（warm）——90 天龄被折成有效 ${(kept?.effectiveAgeDays ?? 0).toFixed(1)} 天`);
  ok(near(neglect?.temperature ?? 0, Math.pow(0.5, 60 / 14), 1e-5) && neglect?.band === 'frozen',
    `荒废条目：${neglect?.temperature}（frozen）——同龄但无保温全速冷却`);
  ok(hot?.band === 'hot' && hot?.suggestion === 'keep', `灼热新知识 ${hot?.temperature} → hot/keep`);
  ok(kept?.suggestion === 'keep' && neglect?.suggestion === 'evict-candidate' && archive?.suggestion === 'archive' && cooling?.suggestion === 'compress',
    `温度驱动建议分档：keep（保温）/ compress（${cooling?.temperature} 冷层）/ archive（冻结高信 ${archive?.temperature}）/ evict-candidate（冻结低信 ${neglect?.temperature}）`);

  // 新旧世界数字对照：线性年龄模型 vs 保温非线性模型
  const linearT = (ageDays) => Math.max(0, 1 - ageDays / 120);
  const oldKept = linearT(90);
  const oldNeglect = linearT(90);
  const newDivergence = (kept?.temperature ?? 0) - (neglect?.temperature ?? 0);
  console.log(`    数字对照：同龄 90 天双胞胎——线性模型（旧）kept=${oldKept} / neglect=${oldNeglect}（Δ=0，保温不可见）`);
  console.log(`    数字对照：非线性模型（新）kept=${kept?.temperature} / neglect=${neglect?.temperature}（Δ=${newDivergence.toFixed(4)}，分岔显现）`);
  ok(near(oldKept - oldNeglect, 0, 1e-9), '旧世界：线性年龄模型对保温/荒废读数完全相同（Δ=0）');
  ok(newDivergence > 0.38, `新世界：同龄双胞胎 Δ=${newDivergence.toFixed(4)} > 0.38（保温 vs 荒芜分岔被量化）`);
  ok((profile?.divergence ?? 0) > 0.85, `同库温度极差 ${profile?.divergence?.toFixed(4)}（灼热 0.946 ↔ 冻结 0.051——维护焦点一目了然）`);
  ok(profile?.bands.hot === 1 && profile.bands.warm === 1 && profile.bands.cold === 1 && profile.bands.frozen === 2,
    `温层分布 hot=1 / warm=1 / cold=1 / frozen=2（建议 keep=${profile?.suggestions.keep} compress=${profile?.suggestions.compress} archive=${profile?.suggestions.archive} evict=${profile?.suggestions.evictCandidate}）`);
}

// ═══════════════════ ③ 经验因果链溯源：三次沉淀三级衍生 ═══════════════════
section('③ 经验因果链溯源：信号 → 执行 → 反思 → 洞察 → 沉淀，链式衍生回溯到信号');

{
  const m = openMemory('provenance');
  ok(m.traceCausality('any') === undefined && m.causalityStats().chains === 0, '空库：trace undefined / 统计全零');

  // 三次沉淀：m1 源头直沉淀（含反思），m2 衍生自 m1（无反思——反思可选），m3 衍生自 m2
  ok(m.noteCausality('mem-1', { signalId: 'sig-101', executionId: 'exec-201', reflectionId: 'ref-301', insightId: 'ins-401', recordedAt: FIXED }) === 'created', '沉淀 1：信号 sig-101 → 执行 exec-201 → 反思 ref-301 → 洞察 ins-401');
  ok(m.noteCausality('mem-2', { signalId: 'sig-102', executionId: 'exec-202', insightId: 'ins-402', derivedFromMemoryId: 'mem-1', recordedAt: FIXED + DAY }) === 'created', '沉淀 2：衍生自 mem-1（洞察复用上游经验）');
  ok(m.noteCausality('mem-3', { signalId: 'sig-103', executionId: 'exec-203', reflectionId: 'ref-303', insightId: 'ins-403', derivedFromMemoryId: 'mem-2', recordedAt: FIXED + 2 * DAY }) === 'created', '沉淀 3：再衍生自 mem-2（三级链）');

  const trace3 = m.traceCausality('mem-3');
  ok(trace3?.depth === 3 && trace3.path.map((s) => s.memoryId).join('→') === 'mem-3→mem-2→mem-1',
    `三级回溯路径完整（${trace3?.path.map((s) => s.memoryId).join('→')}）`);
  ok(trace3?.rootSignalId === 'sig-101', `回溯到根信号 ${trace3?.rootSignalId}（第三次沉淀仍可追到最初信号）`);
  ok(trace3?.complete === true && trace3.path.every((s) => s.complete), '全链环节完备（signal/execution/insight 一条不少——反思为可选环节）');
  ok(trace3?.path[0].chain.insightId === 'ins-403' && trace3.path[2].chain.insightId === 'ins-401', '逐级洞察可指认（ins-403 ← ins-402 ← ins-401）');
  const trace1 = m.traceCausality('mem-1');
  ok(trace1?.depth === 1 && trace1.rootSignalId === 'sig-101', '源头直沉淀深度 1（自身即根）');

  // 缺要素链诚实降级
  m.noteCausality('mem-broken', { signalId: '', executionId: 'exec-204', insightId: 'ins-404', recordedAt: FIXED });
  const traceBroken = m.traceCausality('mem-broken');
  ok(traceBroken?.complete === false, '缺信号 id 的链 → complete=false（诚实降级，不假造完整性）');

  // 环状衍生防死循环
  m.noteCausality('mem-cycle-a', { signalId: 'sig-a', executionId: 'exec-a', insightId: 'ins-a', derivedFromMemoryId: 'mem-cycle-b', recordedAt: FIXED });
  m.noteCausality('mem-cycle-b', { signalId: 'sig-b', executionId: 'exec-b', insightId: 'ins-b', derivedFromMemoryId: 'mem-cycle-a', recordedAt: FIXED });
  const traceCycle = m.traceCausality('mem-cycle-a');
  ok(traceCycle !== undefined && traceCycle.path.length <= 2, `环状衍生不死循环（路径截断在 ${traceCycle?.path.length} 步）`);

  // 覆盖更新 + 统计
  ok(m.noteCausality('mem-broken', { signalId: 'sig-repaired', executionId: 'exec-204', insightId: 'ins-404', recordedAt: FIXED }) === 'updated', '同 memoryId 重登记 → updated（链可修复）');
  ok(m.traceCausality('mem-broken')?.complete === true, '修复后 complete 转真');
  const stats = m.causalityStats();
  ok(stats.chains === 6 && stats.complete === 6 && stats.maxDepth === 3,
    `统计：6 条链全完备 / 最大溯源深度 ${stats.maxDepth}（三次沉淀三级衍生在案）`);
}

// ═══════════════════ ④ 记忆健康审计：已知缺陷库五类指标全检出 ═══════════════════
section('④ 记忆健康审计：重复/矛盾/孤岛/陈旧/漂移五类缺陷检出 + 健康分手算对照');

{
  const t0 = FIXED - 100 * DAY;
  const t1 = FIXED - 50 * DAY;
  const m = openMemory('health-defect');
  // 已知缺陷库：8 模式
  m.upsertPattern(makePattern('code-gen::0.5::long', '长文本代码生成任务重构认证模块与单元测试覆盖', 0.8, { firstSeenAt: t0, lastSeenAt: FIXED - DAY })); // dup-a
  m.upsertPattern(makePattern('code-gen::0.5::long2', '长文本代码生成任务重构鉴权模块与单元测试覆盖', 0.8, { firstSeenAt: t0, lastSeenAt: FIXED - DAY })); // dup-b（1 字之差）
  m.upsertPattern(makePattern('code-gen::0.4::algo', '数据库索引调优与慢查询执行计划分析', 0.75, { firstSeenAt: t0, lastSeenAt: FIXED - DAY })); // unique-code
  m.upsertPattern(makePattern('doc-gen::0.3::api', 'REST 接口文档自动生成 openapi 规范', 0.7, { firstSeenAt: t1, lastSeenAt: FIXED - DAY })); // unique-doc-1
  m.upsertPattern(makePattern('doc-gen::0.3::guide', '用户操作手册编写与截图标注流程', 0.7, { firstSeenAt: t1, lastSeenAt: FIXED - DAY })); // unique-doc-2
  m.upsertPattern(makePattern('misc::0.2::exp', '一次性部署实验记录', 0.5, { firstSeenAt: t1, lastSeenAt: FIXED - 100 * DAY })); // orphan-stale（孤岛 + 陈旧）
  m.upsertPattern(makePattern('doc-gen::0.5::legacy', '旧版接口文档迁移记录', 0.6, { firstSeenAt: t1, lastSeenAt: FIXED - 100 * DAY })); // stale-keep（陈旧非孤岛）
  m.upsertPattern(makePattern('misc::0.5::fresh', '新近杂项任务', 0.6, { firstSeenAt: t1, lastSeenAt: FIXED - DAY })); // fresh-misc（无缺陷）
  // 引用关系：sem-ref-1 引用 unique-code + fresh-misc；sem-ref-2 引用三个 doc 模式
  const refSemantic = (id, fps) => m.upsertSemanticMemory({
    id, domain: 'feature-correlation', statement: `规律 ${id}`, taskTypes: [],
    conditions: [], conclusion: { type: 'parameter-tuning', value: 1, rationale: '引用' },
    confidence: 0.8, supportCount: 3, sourceFingerprints: fps, distilledAt: FIXED - DAY, appliedTotal: 0, appliedSuccesses: 0,
  });
  refSemantic('sem-ref-1', ['code-gen::0.4::algo', 'misc::0.5::fresh']);
  refSemantic('sem-ref-2', ['doc-gen::0.3::api', 'doc-gen::0.3::guide', 'doc-gen::0.5::legacy']);
  // 同主题反结论对（sql 任务偏好相反模型）——经仲裁通道入库（一个现役一个历史，审计按存量矛盾计）
  m.attachArbiter({ now: () => FIXED });
  const contraA = makeSemantic('sem-contra-a', 'model-p', 12, FIXED - DAY, ['code-gen::0.5::long', 'code-gen::0.5::long2']);
  contraA.conditions = [{ dimension: 'feature', operator: 'contains', value: 'sql' }];
  contraA.statement = 'sem-contra-a: SQL 任务适合 model-p';
  m.upsertSemanticMemory(contraA);
  const contraB = makeSemantic('sem-contra-b', 'model-q', 12, FIXED - DAY, ['code-gen::0.5::long']);
  contraB.conditions = [{ dimension: 'feature', operator: 'contains', value: 'sql' }];
  contraB.statement = 'sem-contra-b: SQL 任务适合 model-q';
  m.admitWithArbitration(contraB);

  const report = m.healthAudit({ now: () => FIXED });
  // ── 重复率 ──
  ok(report.duplicatePairs.length === 1 && report.duplicatePairs[0].a === 'code-gen::0.5::long',
    `重复检出：1 对近邻（distance=${report.duplicatePairs[0]?.distance} ≤ 0.6——1 字之差的同源摘要）`);
  ok(near(report.duplicateRate, 2 / 8, 1e-6), `重复率 = 2/8 = ${report.duplicateRate}（参与近邻对的模式占比）`);
  // ── 矛盾率 ──
  ok(report.contradictions.length === 1 && report.contradictions[0].kind === 'semantic' && report.contradictions[0].ids.join(',') === 'sem-contra-a,sem-contra-b',
    `矛盾检出：同条件反结论对 ${report.contradictions[0]?.ids.join(' vs ')}（含已仲裁降级的存量矛盾——审计看到的是事实全貌）`);
  ok(near(report.contradictionRate, 1 / 4, 1e-6), `矛盾率 = 1 对 / 4 条语义记忆 = ${report.contradictionRate}`);
  // ── 孤岛率 ──
  ok(report.isolated.length === 1 && report.isolated[0] === 'misc::0.2::exp',
    `孤岛检出：${report.isolated[0]}（无蒸馏引用且无图邻接——知识盲区点名）`);
  ok(near(report.isolationRate, 1 / 8, 1e-6), `孤岛率 = 1/8 = ${report.isolationRate}`);
  // ── 陈旧率 ──
  ok(report.stale.length === 2 && report.stale.includes('misc::0.2::exp') && report.stale.includes('doc-gen::0.5::legacy'),
    `陈旧检出：${report.stale.join(', ')}（lastSeenAt 超 45 天）`);
  ok(near(report.stalenessRate, 2 / 8, 1e-6), `陈旧率 = 2/8 = ${report.stalenessRate}`);
  // ── 分布漂移 ──
  ok(near(report.distributionDrift.jsDivergenceBits, 1, 1e-3) && report.distributionDrift.cohorts.early === 3 && report.distributionDrift.cohorts.late === 5,
    `漂移检出：JSD = ${report.distributionDrift.jsDivergenceBits} 比特（满格——早期全 code-gen / 近期 doc-gen+misc，任务构成完全换血）`);
  const codeGenDrift = report.distributionDrift.taskTypes.find((t) => t.type === 'code-gen');
  ok(near(codeGenDrift?.earlyShare ?? 0, 1, 1e-3) && near(codeGenDrift?.lateShare ?? 1, 0, 1e-3),
    `漂移明细：code-gen 早期占比 ${codeGenDrift?.earlyShare} → 近期 ${codeGenDrift?.lateShare}（Δ=${codeGenDrift?.delta}）`);
  // ── 综合健康分手算对照 ──
  const oracleScore = 100 * (1 - (0.2 * (2 / 8) + 0.25 * (1 / 4) + 0.2 * (1 / 8) + 0.2 * (2 / 8) + 0.15 * 1));
  ok(near(report.healthScore, oracleScore, 1e-2), `健康分 ${report.healthScore} = 手算 ${oracleScore.toFixed(2)}（五类缺陷加权扣分 0.2/0.25/0.2/0.2/0.15）`);

  // 旧世界对照：裸计数摘要对缺陷完全失明
  const summary = m.getMemorySummary();
  ok(/任务模式数: 8/.test(summary) && !/重复|矛盾|孤岛|陈旧|漂移/.test(summary),
    `旧世界失明：getMemorySummary 只有裸计数（模式数 8），五类缺陷一个都看不见；健康审计 5/5 全检出（健康分 ${report.healthScore}）`);

  // 图邻接口径注入：共现图有邻居的「孤岛」被豁免
  const withGraph = m.healthAudit({ now: () => FIXED, linkedTo: (fp) => fp === 'misc::0.2::exp' });
  ok(withGraph.isolated.length === 0 && withGraph.isolationRate === 0, 'linkedTo 注入：孤岛在共现图上有邻居 → 孤岛率归零（第二口径可组合）');

  // 健康孪生库：全零缺陷 → 100 分
  const healthy = openMemory('health-clean');
  healthy.upsertPattern(makePattern('deploy::0.5::k8s', '容器化部署滚动更新策略', 0.9, { firstSeenAt: t0, lastSeenAt: FIXED - DAY }));
  healthy.upsertPattern(makePattern('deploy::0.5::helm', 'Helm Chart 发布与回滚', 0.85, { firstSeenAt: t0, lastSeenAt: FIXED - DAY }));
  healthy.upsertPattern(makePattern('deploy::0.4::canary', '金丝雀发布流量切分', 0.8, { firstSeenAt: t0, lastSeenAt: FIXED - DAY }));
  healthy.upsertSemanticMemory({
    id: 'sem-clean', domain: 'feature-correlation', statement: '部署类规律', taskTypes: [],
    conditions: [], conclusion: { type: 'parameter-tuning', value: 1, rationale: '引用' },
    confidence: 0.9, supportCount: 5,
    sourceFingerprints: ['deploy::0.5::k8s', 'deploy::0.5::helm', 'deploy::0.4::canary'],
    distilledAt: FIXED - DAY, appliedTotal: 0, appliedSuccesses: 0,
  });
  const cleanReport = healthy.healthAudit({ now: () => FIXED });
  ok(cleanReport.duplicateRate === 0 && cleanReport.contradictionRate === 0 && cleanReport.isolationRate === 0 && cleanReport.stalenessRate === 0 && cleanReport.distributionDrift.jsDivergenceBits === 0,
    `健康孪生库：五类指标全零（无假阳性——同型不漂移、互异不重复、全引用无孤岛、全新鲜）`);
  ok(cleanReport.healthScore === 100, `健康孪生库健康分 ${cleanReport.healthScore}（满分——缺陷库 66.25 的对照面）`);
}

// ═══════════════════ ⑤ 跨任务迁移映射（加分）：按借用成功率学习 ═══════════════════
section('⑤ 跨任务迁移映射：A 类经验对 B 类的适用度（Wilson 下界学习 + 结构回退）');

{
  const tm = new TransferMap({
    relatedness: (a, b) => (a === 'code-gen' && b === 'doc-rewrite' ? 0.8 : 0),
  });
  // 学习史：code-gen → doc-gen 10 借 9 成；code-gen → sql-tuning 5 借 1 成
  for (let i = 0; i < 9; i += 1) tm.recordBorrow('code-gen', 'doc-gen', true, FIXED + i);
  tm.recordBorrow('code-gen', 'doc-gen', false, FIXED + 9);
  tm.recordBorrow('code-gen', 'sql-tuning', true, FIXED);
  for (let i = 1; i < 5; i += 1) tm.recordBorrow('code-gen', 'sql-tuning', false, FIXED + i);

  const good = tm.transferability('code-gen', 'doc-gen');
  const oracleGood = oracleWilsonLower(9, 1); // ≈ 0.5959
  ok(good.learned && good.trials === 10 && good.successes === 9,
    `可迁移对学习在案（10 借 9 成——learned=true，minTrials=3 门槛已过）`);
  ok(near(good.wilsonLower, oracleGood, 1e-4) && near(good.score, oracleGood, 1e-4),
    `Wilson 下界评分 ${good.wilsonLower} ≈ oracle ${oracleGood.toFixed(4)}（小样本保守：9/10 裸成功率 0.9 不虚标）`);
  const bad = tm.transferability('code-gen', 'sql-tuning');
  const oracleBad = oracleWilsonLower(1, 4); // ≈ 0.0361
  ok(near(bad.score, oracleBad, 1e-4) && bad.score < 0.1, `低成功率对 ${bad.score.toFixed(4)} ≈ oracle ${oracleBad.toFixed(4)}（5 借 1 成——Wilson 下界近乎归零）`);
  console.log(`    数字对照：doc-gen 借用适用度 ${good.wilsonLower} vs sql-tuning ${bad.wilsonLower}（同为 code-gen 经验去向，${(good.wilsonLower / Math.max(bad.wilsonLower, 1e-9)).toFixed(0)} 倍差距——按历史学习而非拍脑袋）`);

  const suggests = tm.suggestTransfers('code-gen');
  ok(suggests.length === 2 && suggests[0].to === 'doc-gen' && suggests[1].to === 'sql-tuning',
    `去向建议排序：doc-gen 第一 / sql-tuning 第二（按适用度降序——冷启动指南）`);
  const discovered = tm.discoverTransferables(0.55);
  ok(discovered.length === 1 && discovered[0].from === 'code-gen' && discovered[0].to === 'doc-gen' && near(discovered[0].score, oracleGood, 1e-4),
    `可迁移对发现：仅 code-gen→doc-gen 过 0.55 线（0.596 入选 / sql-tuning 0.036 被排除——映射表自己长出来的白名单）`);

  // 无借用史：结构相关度回退（对折 + learned=false 诚实标注）
  const unknown = tm.transferability('code-gen', 'doc-rewrite');
  ok(unknown.learned === false && near(unknown.heuristic, 0.8, 1e-6) && near(unknown.score, 0.4, 1e-6),
    `无史回退：结构相关度 0.8 → 对折分 ${unknown.score}（learned=false——「可借但未证」诚实标注而非冒充学习分）`);
  const reverse = tm.transferability('doc-gen', 'code-gen');
  ok(reverse.score === 0 && reverse.learned === false, `方向性：doc-gen→code-gen 无史无相关 → 0（A→B 可迁移不代表 B→A——迁移有方向）`);
  ok(tm.transferability('code-gen', 'doc-gen').heuristic === 0, '已学习对不再咨询结构回退（学习分优先，回退只补盲区）');

  // minTrials 门槛：2 借 2 成也不冒充学习分
  const tm2 = new TransferMap({ minTrials: 5 });
  tm2.recordBorrow('a', 'b', true, FIXED);
  tm2.recordBorrow('a', 'b', true, FIXED);
  const few = tm2.transferability('a', 'b');
  ok(few.learned === false && few.score === 0, `minTrials 门槛：2 借 2 成（全胜）learned=false（样本不足不给学习分——防小样本虚高）`);

  const stats = tm.stats();
  ok(stats.borrows === 15 && stats.pairs === 2 && stats.learnedPairs === 2, `登记统计：15 次借用 / 2 个方向对 / 2 对已学习`);
}

// ═══════════════════ ⑥ 零漂移 + 集成：往返迁移保历史观点 ═══════════════════
section('⑥ 零漂移总检 + 集成：未挂载面全部 undefined，仲裁降级往返迁移无损');

{
  const m = openMemory('zero-drift');
  m.upsertPattern(makePattern('zd::0.5::a', '零漂移样本', 0.8));
  m.upsertSemanticMemory({
    id: 'zd-sem-ref', domain: 'feature-correlation', statement: '零漂移引用', taskTypes: [],
    conditions: [], conclusion: { type: 'parameter-tuning', value: 1, rationale: '引用' },
    confidence: 0.8, supportCount: 2, sourceFingerprints: ['zd::0.5::a'], distilledAt: FIXED - DAY, appliedTotal: 0, appliedSuccesses: 0,
  });
  ok(m.arbitrateConflicts() === undefined && m.admitWithArbitration(makeSemantic('zd-sem', 'v', 1, FIXED, ['zd::0.5::a'])) === undefined, '仲裁器未挂载 → arbitrateConflicts / admitWithArbitration 均 undefined');
  ok(m.temperatureProfile() === undefined, '温度模型未挂载 → temperatureProfile undefined');
  ok(m.traceCausality('zd::0.5::a') === undefined && m.causalityStats().chains === 0, '因果链未登记 → trace undefined / 统计全零');
  ok(m.historicalViews().length === 0, '无降级 → historicalViews 空数组');
  const emptyAudit = m.healthAudit({ now: () => FIXED });
  ok(emptyAudit.healthScore === 100 && emptyAudit.totals.patterns === 1 && Number.isFinite(emptyAudit.distributionDrift.jsDivergenceBits),
    `审计为只读口径（无配置即可用）：单模式库健康分 ${emptyAudit.healthScore}，无 NaN`);
  ok(m.findPattern('zd', 0.5, ['a'])?.fingerprint === 'zd::0.5::a' && m.getSemanticMemories('any-type').length === 1,
    '既有检索语义不变（未仲裁条目照常命中；无 status 字段的通用语义可检索——零漂移）');

  // 集成：仲裁降级（历史观点）经 export → import 往返无损
  const arb = openMemory('roundtrip-arb');
  arb.upsertSemanticMemory(makeSemantic('rt-a', 'model-1', 20, FIXED - 90 * DAY, ['fp-1']));
  arb.attachArbiter({ now: () => FIXED });
  arb.admitWithArbitration(makeSemantic('rt-b', 'model-2', 16, FIXED, ['fp-1', 'fp-2', 'fp-3', 'fp-4', 'fp-5', 'fp-6']));
  ok(arb.historicalViews('semantic').length === 1, `往返源库就绪（1 条历史观点：rt-a 被 rt-b 翻转降级）`);
  const tool = new MigrationTool('verify-r4');
  const target = openMemory('roundtrip-arb-target');
  const pkg = tool.exportFromMemory(arb, { includeGlobalStats: false, includePatterns: false, includeModelProfiles: false, includeFeedback: false });
  const imported = tool.importToMemory(target, JSON.parse(JSON.stringify(pkg)), 'overwrite');
  ok(imported.success && imported.imported.semantic === 2, `迁移导入 2 条语义记忆（${imported.errors.length} 错误——bypassConflictGate 不再二次裁决）`);
  const migrated = target.historicalViews('semantic');
  ok(migrated.length === 1 && migrated[0].id === 'rt-a' && migrated[0].demotedBy?.winnerId === 'rt-b',
    `历史观点迁移无损（rt-a 的降级状态 + demotedBy 审计完整到达目标库）`);
  const roundTrip = tool.verifyRoundTrip(arb, target);
  ok(roundTrip.lossless && roundTrip.checked.semantic === 2, `往返一致：lossless=${roundTrip.lossless}（含 status/demotedBy 新字段的规范化比对）`);
  ok(target.findSemanticMemory('code-generation', { features: ['code'] })?.id === 'rt-b', '目标库现役结论同为 rt-b（裁决语义随迁移传播）');
}

// ═══════════════════ 清理 + 汇总 ═══════════════════
for (const m of memories) {
  try {
    m.dispose();
  } catch {
    /* beforeExit 兜底再 flush 一次无害 */
  }
}
try {
  fs.rmSync(workDir, { recursive: true, force: true });
} catch {
  /* Windows 句柄延迟释放不阻塞结论 */
}

console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— 记忆子系统第四轮五项升级（仲裁/温度/因果链/健康审计/迁移映射）新旧行为对照验证成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
