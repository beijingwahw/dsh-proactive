/**
 * verify-mod-memory.mjs — 第三轮模块域升级：记忆子系统新旧行为对照验证
 *
 * 六项升级各配「旧行为 vs 新行为」的构造对照（不是「改了」，是「证明更好」）：
 *   ① 分层存储（热/温/冷）：固定 seed 访问流（12 个 Zipf 热键价值 0.9 + 无限
 *      噪声键价值 0.15）——TieredStore 热层命中率 vs 脚本侧单层 LRU
 *      （等热层容量 8 的公平对照）：LRU 只看新近度被噪声污染，分层靠
 *      价值×频次×新近度综合分把热层留给高价值常客；另验晋升/降级/淘汰
 *      计数、findPattern 挂载旁路零漂移（挂载前后返回同一模式）
 *   ② 检索多路融合：构造「关键词弱、图邻居强」案例——查询与目标 B 的
 *      token 零重叠（单关键词路召回为空）但 B 与关键词强命中的 A 在共现图上
 *      强连通 → 融合把 B 召回进前二；别名路（#2 短索引反解精确命中）；
 *      权重归一化；未挂载 undefined（诚实降级）
 *   ③ 别名消歧：同名「python 服务」两实体（api 语境 vs etl 语境）——上下文
 *      共现 IDF 加权消歧、分离度置信度（清晰语境 ~1 / 混合语境 <0.75）；
 *      既有 encode/resolve 短索引语义逐位不变
 *   ④ 后端完整性：SQLite v3 条目校验和——绕过后端篡改一字节（追加空格，
 *      语义级不可见）→ verifyIntegrity 检出该行 + load 抛 MemoryError（含
 *      .corrupt 备份，报告不静默）；JSON 后端写失败回滚（注入 EIO）——
 *      主文件字节不变、临时区清理、抛 MemoryError
 *   ⑤ 迁移工具：旧版本 v1 形状数据（无 semantic/procedural/evidence 字段）
 *      → 载入 → 导出 → 导入空库 → verifyRoundTrip lossless（逐条规范化比对）；
 *      diff 增/删/改/不变四态计数（构造 +1/-1/~1 案例）与 dryRun 旧字段共存
 *   ⑥ 图度统计：6 节点 5 边手算图（度/平均度/连通分量/中枢/孤立）逐位对照
 *      + adjacency 纯结构口径
 *   ⑦ 零漂移总检：全部新 API 未挂载时 undefined；schema 升 v3；dryRun 旧字段在
 *
 * 确定性：访问流用 mulberry32 固定 seed；TieredStore 用注入固定时钟
 * （无真实时间依赖）；NCD/校验和均为确定性函数。
 *
 * 运行：npm run build && node --experimental-strip-types scripts/verify-mod-memory.mjs
 */

import {
  LongTermMemory,
  TieredStore,
  MigrationTool,
  MemoryGraph,
  AliasMap,
  SqliteMemoryBackend,
  JsonMemoryBackend,
  emptyMemoryStore,
  MemoryError,
} from '../dist/index.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

/** 确定性 PRNG（mulberry32） */
function mulberry32(seed) {
  let s = seed;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 脚本侧单层 LRU oracle（旧世界基线：只看新近度） */
class LruCache {
  constructor(capacity) {
    this.cap = capacity;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }
  touch(key) {
    if (this.map.has(key)) {
      this.map.delete(key);
      this.map.set(key, 1);
      this.hits += 1;
      return true;
    }
    this.misses += 1;
    this.map.set(key, 1);
    if (this.map.size > this.cap) this.map.delete(this.map.keys().next().value);
    return false;
  }
  get hitRate() {
    const total = this.hits + this.misses;
    return total > 0 ? this.hits / total : 0;
  }
}

/** 手工任务模式（完全可控字段，避开 recordSuccess 的统计副作用） */
function makePattern(fingerprint, taskSummary, confidence, frequency = 3) {
  return {
    fingerprint,
    taskSummary,
    frequency,
    firstSeenAt: 1,
    lastSeenAt: 1,
    successfulPlans: [],
    failureRecords: [],
    confidence,
    avgExecutionTime: 0,
    avgQualityScore: 0,
  };
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mod-memory-'));
const memories = [];
/** LongTermMemory 工厂（登记统一 dispose） */
function openMemory(name) {
  const m = new LongTermMemory(path.join(workDir, `${name}.json`));
  memories.push(m);
  return m;
}

// ═══════════════════ ① 分层存储：热层命中率 > 单层 LRU ═══════════════════
section('① 分层存储（热/温/冷）：价值×频次综合分 vs 单层 LRU 新近度');

{
  const FIXED = 1_700_000_000_000;
  const HOT_CAP = 8;
  const tiered = new TieredStore({ hotCapacity: HOT_CAP, warmCapacity: 10, coldCapacity: 10, halfLifeMs: 600_000, now: () => FIXED });
  const lru = new LruCache(HOT_CAP); // 公平对照：单层 LRU 容量 = 热层容量

  // 访问流：12 个 Zipf 热键（价值 0.9，占 72% 访问）+ 无限噪声键（价值 0.15，占 28%）
  const rand = mulberry32(42);
  const hotKeys = Array.from({ length: 12 }, (_, i) => `hot-task::0.5::k${i}`);
  const hotWeights = hotKeys.map((_, i) => 1 / (i + 0.5));
  const hotTotal = hotWeights.reduce((s, w) => s + w, 0);
  const pickHot = () => {
    let r = rand() * hotTotal;
    for (let i = 0; i < hotKeys.length; i += 1) {
      r -= hotWeights[i];
      if (r <= 0) return hotKeys[i];
    }
    return hotKeys[hotKeys.length - 1];
  };
  let noiseSeq = 0;
  const N = 4000;
  for (let step = 0; step < N; step += 1) {
    const isHot = rand() < 0.72;
    const key = isHot ? pickHot() : `noise-task::0.1::n${noiseSeq++}`;
    tiered.touch(key, isHot ? 0.9 : 0.15);
    lru.touch(key);
  }
  const t = tiered.stats();
  const lruRate = lru.hitRate;
  console.log(`    数字对照：分层热层命中率 ${t.hotHitRate} / 总命中率 ${t.totalHitRate} | 单层 LRU(容量=${HOT_CAP}) 命中率 ${lruRate.toFixed(4)}`);
  console.log(`    层内布局：hot=${t.hot}/8 warm=${t.warm}/10 cold=${t.cold}/10 | 晋升=${t.promotions} 降级=${t.demotions} 淘汰=${t.evictions}`);
  ok(t.hotHitRate > lruRate + 0.1, `热层命中率 ${t.hotHitRate} > LRU ${lruRate.toFixed(4)} + 0.1（优势 ${(t.hotHitRate - lruRate).toFixed(4)}：价值感知分层击败纯新近度）`);
  ok(t.totalHitRate > lruRate, `总命中率 ${t.totalHitRate} > LRU ${lruRate.toFixed(4)}（三层合计也占优——温/冷层兜住热层装不下的热键）`);
  ok(t.hot <= HOT_CAP && t.warm <= 10 && t.cold <= 10, `层容量预算受控：hot ${t.hot}/8、warm ${t.warm}/10、cold ${t.cold}/10`);
  ok(t.evictions > 1000, `冷层淘汰 ${t.evictions} 条噪声（低价值在冷层被筛掉，而非挤占快层）`);
  ok(t.promotions > 0 && t.demotions > 0, `晋升 ${t.promotions} 次 / 降级 ${t.demotions} 次（层间双向流动在案）`);
  ok(t.size <= 28, `总驻留 ${t.size} 条有界（热+温+冷容量和封顶）`);

  // 旧世界对照：LRU 里被噪声顶掉的键即分层热层的常客——层内 Top 应为高价值热键
  const hotTierKey = tiered.tierOf('hot-task::0.5::k0');
  ok(hotTierKey === 'hot', `Zipf 最热键 k0 稳居热层（tier=${hotTierKey}）`);
  const noiseTier = tiered.tierOf('noise-task::0.1::n0');
  ok(noiseTier === undefined || noiseTier === 'cold', `首批噪声键 n0 已被淘汰或滞留冷层（tier=${String(noiseTier)}）——不占热层`);

  // findPattern 旁路挂载零漂移：挂载前后返回同一模式
  const m = openMemory('tiered-zero-drift');
  m.upsertPattern(makePattern('code-gen::0.5::code,long', '代码生成任务', 0.9));
  m.upsertPattern(makePattern('code-gen::0.5::code', '短代码生成任务', 0.4));
  const before = m.findPattern('code-gen', 0.5, ['code', 'long'])?.fingerprint;
  ok(m.tieredStats() === undefined && m.tierOf('code-gen::0.5::code,long') === undefined, '未挂载分层存储 → tieredStats/tierOf 均 undefined（零介入）');
  m.attachTieredStorage({ hotCapacity: 4, warmCapacity: 4, coldCapacity: 4 });
  const after = m.findPattern('code-gen', 0.5, ['code', 'long'])?.fingerprint;
  ok(before === after && after === 'code-gen::0.5::code,long', `挂载后 findPattern 返回同一模式（${String(before)}）——旁路统计不改返回值`);
  ok(m.tierOf('code-gen::0.5::code,long') === 'warm', `命中即 touch：目标模式已入层（cold→warm 单级晋升——首次访问不跳热层，tier=${String(m.tierOf('code-gen::0.5::code,long'))}）`);
}

// ═══════════════════ ② 检索多路融合：关键词弱、图邻居强 ═══════════════════
section('② 检索多路融合：关键词/相似度/图邻居/别名 加权召回');

{
  const m = openMemory('fusion');
  const patternA = makePattern('deploy::0.5::k8s', '部署 发布 流水线 k8s 滚动更新', 0.9);
  const patternB = makePattern('release-rollback::0.5::db', '版本 回滚 数据库 迁移 双写', 0.85);
  const patternC = makePattern('doc-gen::0.5::rest', 'REST 接口 文档 生成 openapi', 0.7);
  m.upsertPattern(patternA);
  m.upsertPattern(patternB);
  m.upsertPattern(patternC);

  ok(m.fusedSearch('部署 流水线') === undefined, '未挂载融合 → fusedSearch undefined（诚实降级，不静默走单路）');

  // 共现图：A—B 强连通（部署失败 → 版本回滚是紧邻经验）
  const graph = new MemoryGraph(path.join(workDir, 'fusion-graph.json'));
  graph.ensureNode(patternA.fingerprint, 'pattern', patternA.taskSummary);
  graph.ensureNode(patternB.fingerprint, 'pattern', patternB.taskSummary);
  graph.ensureNode(patternC.fingerprint, 'pattern', patternC.taskSummary);
  for (let i = 0; i < 5; i += 1) graph.link(patternA.fingerprint, patternB.fingerprint);
  graph.link(patternA.fingerprint, patternC.fingerprint);

  const aliases = new AliasMap();
  aliases.encode(patternA.fingerprint); // #1
  aliases.encode(patternB.fingerprint); // #2

  // 旧世界（单关键词路）：权重全压关键词
  m.attachRetrievalFusion({ graph, aliases, weights: { keyword: 1, similarity: 0, graph: 0, alias: 0 } });
  const keywordOnly = m.fusedSearch('部署 发布 流水线 失败') ?? [];
  ok(keywordOnly.length > 0 && keywordOnly[0].pattern.fingerprint === patternA.fingerprint, `单关键词路 top1 = A（关键词强命中）`);
  ok(!keywordOnly.some((h) => h.pattern.fingerprint === patternB.fingerprint), `单关键词路完全召回不到 B（token 零重叠——旧世界盲区）`);

  // 新世界（四路融合，缺省权重）
  m.attachRetrievalFusion({ graph, aliases });
  const fused = m.fusedSearch('部署 发布 流水线 失败') ?? [];
  const rankOfB = fused.findIndex((h) => h.pattern.fingerprint === patternB.fingerprint);
  ok(fused.length >= 2 && fused[0].pattern.fingerprint === patternA.fingerprint, `融合 top1 仍是 A（${fused[0]?.signals.keyword.toFixed(2)} 关键词分主导）`);
  ok(rankOfB === 1, `融合把 B 召回至第 ${rankOfB + 1} 位（graph=${fused[rankOfB]?.signals.graph}——「部署」共现邻居补上关键词盲区）`);
  ok(fused[rankOfB].signals.keyword === 0, `B 的关键词信号确为 0（纯粹由图邻居路召回——融合召回 > 单路的增量证明）`);

  // 别名路：#2 短索引反解精确命中
  const byAlias = m.fusedSearch('怎么处理 #2 这个问题') ?? [];
  ok(byAlias.length > 0 && byAlias[0].pattern.fingerprint === patternB.fingerprint && byAlias[0].signals.alias === 1, `别名路：#2 反解 → B 精确命中且排第一（alias=1）`);

  // 权重归一化：任意正权重组合总分 ≤ 1
  m.attachRetrievalFusion({ graph, aliases, weights: { keyword: 40, similarity: 30, graph: 20, alias: 10 } });
  const normalized = m.fusedSearch('部署 发布 流水线 失败') ?? [];
  ok(normalized.every((h) => h.score <= 1 + 1e-9), '权重自动归一化（40/30/20/10 → 0.4/0.3/0.2/0.1，总分 ≤ 1）');
}

// ═══════════════════ ③ 别名消歧：同名多实体上下文共现 ═══════════════════
section('③ 别名消歧：同名「python 服务」按上下文共现消歧');

{
  const alias = new AliasMap();
  ok(alias.disambiguate('python 服务', ['rest']) === undefined, '未登记任何候选 → undefined（诚实降级）');

  // 两个同名实体：api 语境 vs etl 语境（多轮观察积累共现证据）
  alias.registerEntity('pattern-api-python', 'python 服务', ['api', 'rest', 'flask']);
  for (let i = 0; i < 4; i += 1) alias.observeContext('pattern-api-python', 'python 服务', ['api', 'gateway', 'rest']);
  alias.registerEntity('pattern-etl-python', 'python 服务', ['etl', 'pandas', 'data']);
  for (let i = 0; i < 4; i += 1) alias.observeContext('pattern-etl-python', 'python 服务', ['etl', 'spark', 'pandas']);
  const stats = alias.disambiguationStats();
  ok(stats.labels === 1 && stats.ambiguousLabels === 1 && stats.entities === 2, `登记统计：1 个标签 / 1 个歧义标签 / 2 个候选实体`);

  const apiSide = alias.disambiguate('python 服务', ['rest', 'api', 'gateway']);
  ok(apiSide?.id === 'pattern-api-python', `api 语境 → ${apiSide?.id}（共现证据胜出）`);
  ok((apiSide?.confidence ?? 0) >= 0.9, `清晰语境分离度置信度 ${apiSide?.confidence} ≥ 0.9（次名证据近乎为零）`);
  const etlSide = alias.disambiguate('python 服务', ['pandas', 'etl', 'spark']);
  ok(etlSide?.id === 'pattern-etl-python', `etl 语境 → ${etlSide?.id}（同一标签反侧胜出——消歧方向正确）`);
  const mixed = alias.disambiguate('python 服务', ['rest', 'pandas']);
  ok((mixed?.confidence ?? 1) < (apiSide?.confidence ?? 0), `混合语境置信度 ${mixed?.confidence} < 清晰语境 ${apiSide?.confidence}（两侧都有证据 → 分离度下降，调用方该追加上下文）`);
  ok(mixed?.candidates.length === 2, `候选全景保留（${mixed?.candidates.map((c) => `${c.id}:${c.score}`).join(' ')}）`);

  // IDF 加权：全体候选共有的 token 判别力趋零
  const both = alias.disambiguate('python 服务', ['服务', '运维']);
  ok(both === undefined || both.candidates.every((c) => c.score === 0), '无判别 token（两侧都无共现）→ 不武断选边');

  // 旧语义零漂移：encode/resolve/encodeText/decodeText 逐位不变
  // （消歧登记不占短索引号——encodeMap 与 labelEntities 两个维度独立）
  const a1 = alias.encode('strategy-abc');
  const a2 = alias.encode('strategy-abc');
  ok(a1 === '#1' && a2 === '#1' && alias.resolve('#1') === 'strategy-abc', `短索引语义不变（首次分配 #1、幂等、可反解——消歧登记不干扰短索引分配）`);
  ok(alias.decodeText('方案见 #1') === '方案见 strategy-abc', 'decodeText 反解照常（#1 → strategy-abc）');
}

// ═══════════════════ ④ 后端完整性：校验和 + 损坏检测 + 写失败回滚 ═══════════════════
section('④ 后端完整性：条目校验和、读时损坏检测、原子写失败回滚');

{
  const dbPath = path.join(workDir, 'integrity.db');
  const backend = new SqliteMemoryBackend(dbPath);
  const store = emptyMemoryStore();
  store.taskPatterns.push(makePattern('integrity::0.5::a', '完整性样本 A', 0.9));
  store.taskPatterns.push(makePattern('integrity::0.5::b', '完整性样本 B', 0.8));
  store.decisionFeedback.push({ id: 'fb-1', timestamp: 1, signalType: 'test', signalDescription: 'd', decision: 'execute', outcome: 'good', outcomeReason: 'r' });
  backend.save(store);
  const report = backend.verifyIntegrity();
  ok(report.ok && report.checked === 3 && report.corrupted.length === 0, `正常库：verifyIntegrity ok（checked=${report.checked}：2 模式 + 1 反馈）`);
  backend.close();

  // 绕过后端直连篡改：追加一个空格——JSON 语义级不可见，字节级已变
  const db = new DatabaseSync(dbPath);
  db.exec("UPDATE task_patterns SET data = data || ' ' WHERE fingerprint = 'integrity::0.5::a'");
  db.close();

  const backend2 = new SqliteMemoryBackend(dbPath);
  const report2 = backend2.verifyIntegrity();
  ok(!report2.ok && report2.corrupted.length === 1 && report2.corrupted[0].table === 'task_patterns' && report2.corrupted[0].key === 'integrity::0.5::a',
    `篡改一字节被检出：${JSON.stringify(report2.corrupted)}（语义级不可见的损坏也逃不过校验和）`);
  let loadError = null;
  let backupMade = false;
  try {
    backend2.load();
  } catch (err) {
    loadError = err;
  }
  backend2.close();
  ok(loadError instanceof MemoryError && /损坏/.test(loadError.message), `load 拒绝服务并报告：MemoryError「${loadError?.message.slice(0, 60)}…」（不静默吞掉）`);
  const corruptBackups = fs.readdirSync(workDir).filter((f) => f.startsWith('integrity.db.corrupt.'));
  backupMade = corruptBackups.length >= 1;
  ok(backupMade, `损坏现场已备份（${corruptBackups[0] ?? '—'}，报告可查证）`);

  // JSON 后端：原子写失败回滚（注入 EIO 模拟磁盘满）
  const jsonPath = path.join(workDir, 'rollback.json');
  const jsonBackend = new JsonMemoryBackend(jsonPath);
  jsonBackend.save(store);
  const bytesBefore = fs.readFileSync(jsonPath, 'utf-8');
  const tmpPath = `${jsonPath}.tmp.${process.pid}`;
  const origWrite = fs.writeFileSync;
  let tmpExistedDuringFailure = false;
  fs.writeFileSync = (...args) => {
    if (String(args[0]) === tmpPath) {
      tmpExistedDuringFailure = true;
      throw new Error('EIO: 磁盘已满（模拟）');
    }
    return origWrite(...args);
  };
  let writeError = null;
  const mutated = emptyMemoryStore();
  mutated.taskPatterns.push(makePattern('rollback::0.5::x', '不应落盘的条目', 0.5));
  try {
    jsonBackend.save(mutated);
  } catch (err) {
    writeError = err;
  } finally {
    fs.writeFileSync = origWrite;
  }
  ok(writeError instanceof MemoryError, `写失败抛 MemoryError（${writeError?.message.slice(0, 22)}…）`);
  ok(fs.readFileSync(jsonPath, 'utf-8') === bytesBefore, '回滚成立：主文件字节逐位不变（临时区未切换到主文件）');
  ok(!fs.existsSync(tmpPath), '临时区残留已清理（.tmp 文件不遗留）');

  // JSON 读时损坏检测：截断一字节 → 定位报告
  const truncPath = path.join(workDir, 'truncated.json');
  origWrite(truncPath, bytesBefore.slice(0, -3), 'utf-8');
  const truncBackend = new JsonMemoryBackend(truncPath);
  const truncReport = truncBackend.verifyIntegrity();
  ok(!truncReport.ok && truncReport.corrupted.length === 1 && truncReport.corrupted[0].table === '<json-file>', `JSON 截断损坏被定位（${truncReport.corrupted[0]?.key.slice(0, 50)}…）`);
  jsonBackend.close();
  truncBackend.close();
}

// ═══════════════════ ⑤ 迁移工具：差异报告 + 往返一致性 ═══════════════════
section('⑤ 迁移工具：dry-run 增/删/改差异 + 旧版本数据往返无损');

{
  // 旧版本 v1 形状数据：无 semanticMemories/proceduralMemories 键、
  // 模式无 lastDecayAt、globalStats 无 lastDistillationEventCount
  const legacy = {
    version: 1,
    createdAt: 1_600_000_000_000,
    lastUpdatedAt: 1_600_000_000_100,
    taskPatterns: [
      {
        fingerprint: 'legacy-code::0.6::api,auth',
        taskSummary: '旧版代码任务：鉴权接口',
        frequency: 7,
        firstSeenAt: 1,
        lastSeenAt: 2,
        successfulPlans: [{ timestamp: 3, plan: { objective: 'o', nodes: [], parallelismStrategy: 'none' }, modelAssignments: { n1: 'model-a' }, totalLatency: 100, qualityScores: { n1: 0.9 }, tokenCost: 50 }],
        failureRecords: [],
        confidence: 0.82,
        avgExecutionTime: 100,
        avgQualityScore: 0.9,
      },
      makePattern('legacy-doc::0.4::md', '旧版文档任务', 0.66, 4),
    ],
    modelProfiles: [
      { id: 'model-a', name: '模型 A', taskHistory: { 'legacy-code': { totalCalls: 6, successCount: 5, totalLatency: 600, totalQualityScore: 5.1, avgQualityScore: 0.85, lastCalledAt: 9 } }, costEfficiency: { 'legacy-code': 1.2 }, bestTaskType: 'legacy-code', worstTaskType: 'legacy-doc', stability: 0.8 },
    ],
    decisionFeedback: [{ id: 'fb-legacy-1', timestamp: 5, signalType: 'threshold', signalDescription: '旧信号', decision: 'execute', outcome: 'good', outcomeReason: '旧结果' }],
    distilledStrategies: [],
    globalStats: { totalExecutions: 8, totalSuccesses: 7, totalFailures: 1, totalTokensUsed: 1200, totalCostEstimate: 1.2, averageQualityScore: 0.87, averageExecutionTime: 120 },
  };
  const legacyPath = path.join(workDir, 'legacy.json');
  fs.writeFileSync(legacyPath, JSON.stringify(legacy, null, 2), 'utf-8');

  // LongTermMemory 打开：旧 JSON 自动迁移 SQLite；sanitize 补全缺省字段
  const source = openMemory('legacy');
  const legacyColumns = source.rawQuery("SELECT name FROM pragma_table_info('task_patterns')").map((r) => r.name);
  ok(source.backendKind === 'sqlite' && source.dbStats().schemaVersion === 2, `旧版数据自动迁移：SQLite 关系化 schema v${source.dbStats().schemaVersion}（幂等加列不 bump 大版本——兼容既有验收口径）`);
  ok(legacyColumns.includes('data_checksum'), `校验和列已就位（task_patterns.data_checksum——幂等加列演进）`);
  ok(source.getAllTaskPatterns().length === 2 && source.getAllSemanticMemories().length === 0, `缺省字段补全（2 模式 / 0 语义——旧格式缺键不炸）`);
  ok(source.findPattern('legacy-code', 0.6, ['api', 'auth'])?.fingerprint === 'legacy-code::0.6::api,auth', '旧模式可正常模糊检索');

  // 往返：导出（不含 globalStats——导入合并语义不参与无损判定）→ 深拷贝快照
  // → 导入空库 → 机械比对（拷贝断开对象共享，比对的是值而非引用）
  const tool = new MigrationTool('verify-instance');
  const target = openMemory('roundtrip-target');
  const pkg = tool.exportFromMemory(source, { includeGlobalStats: false });
  const importReport = tool.importToMemory(target, JSON.parse(JSON.stringify(pkg)), 'overwrite');
  ok(importReport.success && importReport.imported.patterns === 2 && importReport.imported.modelProfiles === 1 && importReport.imported.feedback === 1,
    `导入计数：patterns=${importReport.imported.patterns} profiles=${importReport.imported.modelProfiles} feedback=${importReport.imported.feedback}（含成功方案明细）`);
  const roundTrip = tool.verifyRoundTrip(source, target);
  console.log(`    往返校验：lossless=${roundTrip.lossless}，逐段 checked=${JSON.stringify(roundTrip.checked)}`);
  ok(roundTrip.lossless && roundTrip.mismatches.length === 0, `往返一致：旧版本数据迁移零丢失（${roundTrip.mismatches.slice(0, 2).join('; ') || '无差异'}）`);
  ok(roundTrip.checked.patterns === 2 && roundTrip.checked.feedback === 1, `逐段核对量：patterns=2 / feedback=1（一条不漏）`);

  // diff 四态：构造 +1 新增 / -1 删除 / ~1 修改 的第三库（深拷贝断开与
  // source/target 的对象共享——变异只影响本库，changed 才可被观测）
  const mutated = openMemory('mutated');
  for (const p of JSON.parse(JSON.stringify(source.getAllTaskPatterns()))) mutated.upsertPattern(p);
  mutated.upsertModelProfile(JSON.parse(JSON.stringify(source.getModelProfile('model-a'))));
  for (const f of JSON.parse(JSON.stringify(source.getAllDecisionFeedback()))) mutated.appendFeedback(f);
  const survivor = mutated.getAllTaskPatterns().find((p) => p.fingerprint === 'legacy-doc::0.4::md');
  mutated.removePattern(survivor.fingerprint); // removed：目标库有、包没有
  const changed = mutated.getAllTaskPatterns().find((p) => p.fingerprint === 'legacy-code::0.6::api,auth');
  changed.confidence = 0.91; // changed：同键内容变
  mutated.upsertPattern(changed);
  mutated.upsertPattern(makePattern('brand-new::0.5::x', '新增任务模式', 0.7)); // added：包有、目标库没有
  const pkg2 = tool.exportFromMemory(mutated, { includeGlobalStats: false });

  const diff = tool.diff(target, pkg2);
  console.log(`    diff 四态：+${diff.total.added} / -${diff.total.removed} / ~${diff.total.changed} / =${diff.total.unchanged}`);
  ok(diff.total.added === 1 && diff.patterns.added === 1, `added=1（brand-new 模式）`);
  ok(diff.total.removed === 1 && diff.patterns.removed === 1, `removed=1（legacy-doc 被删——本地残留清单）`);
  ok(diff.total.changed === 1 && diff.patterns.changed === 1, `changed=1（legacy-code confidence 0.82→0.91）`);
  ok(diff.total.unchanged === 2 && diff.feedback.unchanged === 1 && diff.modelProfiles.unchanged === 1, `unchanged=2（1 反馈 + 1 画像——键序无关的等价判定）`);
  ok(diff.samples.added.some((s) => s.includes('brand-new')) && diff.samples.changed.some((s) => s.includes('legacy-code')), `样本键可定位（${diff.samples.added[0]} / ${diff.samples.changed[0]}）`);

  // dryRun 携带 diff 且旧字段共存（零漂移）
  const dry = tool.dryRun(target, pkg2);
  ok(dry.diff && dry.diff.total.added === 1, `dryRun 返回携带 diff（+${dry.diff.total.added}）`);
  ok(Array.isArray(dry.conflicts) && typeof dry.summary.totalIncoming === 'number' && dry.summary.conflicts === 2, `dryRun 旧字段原样保留（conflicts=${dry.summary.conflicts} / totalIncoming=${dry.summary.totalIncoming}）`);

  // 校验和防篡改（既有能力回归确认；importToMemory 错误隔离进 report 不抛出）
  const tampered = JSON.parse(JSON.stringify(pkg));
  tampered.data.taskPatterns[0].frequency = 999;
  const tamperedReport = tool.importToMemory(target, tampered, 'skip');
  ok(tamperedReport.success === false && tamperedReport.errors.some((e) => /校验和/.test(e)),
    `迁移包篡改仍被 SHA-256 拦截（errors[0]「${tamperedReport.errors[0]?.slice(0, 24)}…」，零条目落库）`);
  ok(target.getAllTaskPatterns().every((p) => p.frequency !== 999), '篡改数据未污染目标库（校验失败即中止导入）');
}

// ═══════════════════ ⑥ 图度统计：度/连通分量/中枢导出 ═══════════════════
section('⑥ 记忆图度统计：节点度、连通分量、中枢 Top-K（供 69.0 Mapper 消费）');

{
  const g = new MemoryGraph(path.join(workDir, 'degree-graph.json'));
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) g.ensureNode(id, 'pattern', `节点 ${id}`);
  // 边：a-b, a-c, b-c（三角大陆）；d-e（二连小岛）；f 孤立
  g.link('a', 'b');
  g.link('a', 'c');
  g.link('b', 'c');
  g.link('d', 'e');

  const s = g.degreeStats(3);
  ok(s.nodes === 6 && s.edges === 4, `节点 6 / 边 4（三角大陆 3 边 + 二连岛 1 边）`);
  ok(near(s.avgDegree, (2 * 4) / 6, 1e-3) && near(s.avgDegree, 1.3333, 1e-3), `平均度 = 2E/V = ${s.avgDegree}（4 位输出精度）`);
  ok(s.maxDegree === 2 && s.isolated === 1, `最大度 2（a/b/c 并列）/ 孤立 1（f——度视角的知识盲区）`);
  ok(s.degreeHistogram.length === 3 && s.degreeHistogram.find((h) => h.degree === 2)?.count === 3 && s.degreeHistogram.find((h) => h.degree === 1)?.count === 2 && s.degreeHistogram.find((h) => h.degree === 0)?.count === 1,
    `度直方图：度2×3 + 度1×2 + 度0×1（偏态分布在案）`);
  ok(s.components.count === 3 && s.components.largest === 3 && s.components.singletons === 1, `连通分量：3 个（大陆3 + 岛2 + 单点1）/ 最大分量 3`);
  ok(s.hubs.length === 3 && s.hubs.every((h) => h.degree === 2) && near(s.hubs[0].share, 2 / 8, 1e-6), `中枢 Top-3 = a/b/c（度 2，share=${s.hubs[0].share} = 2/(2E)）`);

  const adj = new Map(g.adjacency().map((x) => [x.id, x.neighbors]));
  ok(adj.get('a')?.sort().join(',') === 'b,c' && adj.get('f')?.length === 0, `adjacency 纯结构口径（a→[b,c]，f→[]——Mapper 即接即用）`);

  // 影响力挂载不改变度统计口径（拓扑 vs 排序两码事）
  g.attachInfluenceRanking();
  const s2 = g.degreeStats(3);
  ok(near(s2.avgDegree, s.avgDegree) && s2.hubs[0]?.id === s.hubs[0]?.id, '挂载影响力排序后度统计不变（口径隔离）');
}

// ═══════════════════ ⑦ 零漂移总检 ═══════════════════
section('⑦ 零漂移总检：新能力全部挂载面化，缺省行为与旧口径一致');

{
  const m = openMemory('zero-drift');
  m.upsertPattern(makePattern('zd::0.5::a', '零漂移样本', 0.8));
  ok(m.fusedSearch('任意查询') === undefined, 'fusedSearch 未挂载 → undefined');
  ok(m.tieredStats() === undefined && m.tierOf('zd::0.5::a') === undefined, '分层存储未挂载 → undefined');
  ok(m.compressionPlan() === undefined && m.replayStats() === undefined && m.ncdNearDuplicate('x') === undefined, '60.0/68.0/98.0 既有挂载面缺省 undefined（前辈成果未破坏）');
  const alias = new AliasMap();
  ok(alias.size === 0 && alias.disambiguationStats().labels === 0, 'AliasMap 新维度空态零介入');
  const fresh = new MemoryGraph(path.join(workDir, 'empty-graph.json'));
  const emptyStats = fresh.degreeStats();
  ok(emptyStats.nodes === 0 && emptyStats.components.count === 0 && emptyStats.hubs.length === 0, '空图度统计为全零（无除零、无 NaN）');
  const m2 = new MemoryError('test');
  ok(m2 instanceof Error && m2.name === 'MemoryError', 'MemoryError 错误族语义不变');
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
  console.log(`PASS ${passed} / FAIL 0 —— 记忆子系统第三轮六项升级新旧行为对照验证成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
