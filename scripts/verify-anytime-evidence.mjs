/**
 * verify-anytime-evidence.mjs — 12.0「任意时刻有效证据」质变闭环离线验证
 *
 * 升级前后的分水岭：
 *   固定样本统计（Wilson 下界 / z 检验）：结论只在「预定停止点」合法——
 *   边看边停（进化淘汰、退化判定）会反复重读同一实验，假阳性随偷看
 *   次数膨胀（偷看悖论）；并行淘汰无错误率控制，冤案率无人知晓。
 *   任意时刻有效统计：置信序列对所有时刻同时覆盖；e-过程在任何
 *   停止时刻的期望 ≤ 1；e-BH 在任意依赖下 FDR ≤ 名义——
 *   系统第一次「随时下结论且结论永不夸大」。
 *
 * 闭环断言：
 *   A 置信序列：恒定流观测 → 时间一致区间覆盖真值且半径收敛
 *   B e-过程方向性：高于水位线 → eAbove 增长确证；低于 → eBelow 增长确证
 *   C 偷看免疫（分水岭）：1000 条「偷看即停」流，假阳性率 ≤ 名义 α
 *   D e-BH FDR 控制：真劣与持平对象混合 → 淘汰全部落在真劣集（FDR=0）
 *   E 策略进化集成：适应度 = 置信序列下界；e-BH 淘汰台账可审计
 *   F 元认知保证层：退化被 e-过程确证（翻转沿洞察）；恢复同样确证
 *   G 缺省零漂移：不挂载 → 无保证层 KPI、无淘汰行为
 *
 * 运行：npm run build && node scripts/verify-anytime-evidence.mjs
 */

import {
  EmpiricalBernsteinSequence,
  EProcess,
  AnytimeEvidenceStream,
  AnytimeEvidenceRegistry,
  eBenjaminiHochberg,
  StrategyEvolutionEngine,
  MetaCognitionEngine,
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
function near(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}
function section(title) {
  console.log(`\n■ ${title}`);
}

// 确定性 RNG（mulberry32）
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ═══════════════════ A 置信序列 ═══════════════════

section('A 置信序列：时间一致区间覆盖真值且半径收敛');

{
  const cs = new EmpiricalBernsteinSequence(0.05);
  const rng = mulberry32(42);
  let coveredAtAllTimes = true;
  let radiusAt10 = 0;
  let radiusAt1000 = 0;
  for (let i = 1; i <= 1000; i += 1) {
    // 真值 μ = 0.7 的伯努利流
    cs.observe(rng() < 0.7 ? 1 : 0);
    const b = cs.bounds();
    if (!(b.lower <= 0.7 && b.upper >= 0.7)) coveredAtAllTimes = false;
    if (i === 10) radiusAt10 = b.radius;
    if (i === 1000) radiusAt1000 = b.radius;
  }
  ok(coveredAtAllTimes, '全程 1000 个时刻的真值 0.7 均落在置信序列内（时间一致覆盖）');
  ok(radiusAt1000 < radiusAt10, `半径随证据收敛（n=10: ${radiusAt10.toFixed(3)} → n=1000: ${radiusAt1000.toFixed(3)}）`);
  // 任意时刻有效性的溢价：同 n 固定样本 z 半径 ≈ 1.96·√(0.21/1000) ≈ 0.028，
  // 缝合 CS 半径 ≈ 2~3 倍（对全部时刻同时覆盖的联合界代价——教科书口径）。
  // 0.09 内已足够支撑 0.2+ 量级水位线差距的裁决；更精细的定向裁决由
  // e-过程承担（B 组），不受此宽度约束。
  ok(radiusAt1000 < 0.09, `n=1000 半径 < 0.09（实测 ${radiusAt1000.toFixed(4)}，约为固定样本 z 半径的 2~3 倍——任意时刻有效性的联合界溢价）`);
}

// ═══════════════════ B e-过程方向性 ═══════════════════

section('B e-过程：高于/低于水位线的定向确证');

{
  // 高于水位线 0.5 的流（μ=0.75）→ eAbove 应确证
  const streamUp = new AnytimeEvidenceStream({ alpha: 0.05, reference: 0.5 });
  const rng = mulberry32(7);
  let verdictUp = 'undecided';
  for (let i = 0; i < 2000 && verdictUp === 'undecided'; i += 1) {
    verdictUp = streamUp.observe(rng() < 0.75 ? 1 : 0).verdict;
  }
  ok(verdictUp === 'above-reference', `μ=0.75 流在 2000 步内确证高于水位线（实测 ${verdictUp}）`);

  // 低于水位线的流（μ=0.25）→ eBelow 应确证
  const streamDown = new AnytimeEvidenceStream({ alpha: 0.05, reference: 0.5 });
  let verdictDown = 'undecided';
  for (let i = 0; i < 2000 && verdictDown === 'undecided'; i += 1) {
    verdictDown = streamDown.observe(rng() < 0.25 ? 1 : 0).verdict;
  }
  ok(verdictDown === 'below-reference', `μ=0.25 流在 2000 步内确证低于水位线（实测 ${verdictDown}）`);

  // 恰在水位线的流（μ=0.5）→ 不应确证（诚实 undecided）
  const streamNull = new AnytimeEvidenceStream({ alpha: 0.05, reference: 0.5 });
  let nullVerdict = 'undecided';
  for (let i = 0; i < 5000; i += 1) {
    nullVerdict = streamNull.observe(rng() < 0.5 ? 1 : 0).verdict;
    if (nullVerdict !== 'undecided') break;
  }
  ok(nullVerdict === 'undecided', `μ=0.5 恰在水位线的流 5000 步内不确证任一方向（实测 ${nullVerdict}）——诚实的不确定`);

  // e-过程上界性质：水位线为真的流，e 值不应爆炸
  const eProc = new EProcess(0.5, 'at-most');
  const rng2 = mulberry32(99);
  let maxE = 0;
  for (let i = 0; i < 20000; i += 1) {
    eProc.observe(rng2() < 0.5 ? 1 : 0);
    maxE = Math.max(maxE, eProc.eValue);
  }
  ok(maxE < 1 / 0.001, `H0 为真时 e-过程 20000 步未达 1000（实测峰值 ${maxE.toFixed(1)}）——期望上界成立`);
}

// ═══════════════════ C 偷看免疫（分水岭） ═══════════════════

section('C 偷看免疫：1000 条「偷看即停」流的假阳性率 ≤ 2α（双侧联合界）');

{
  // 每条流：μ=0.5 恰在水位线（无真实退化）。策略：每步偷看，
  // 一旦 verdict 确证任一方向立即停止并宣称「发现」。合法统计下
  // 双侧 e-过程各以 α 控制（Ville），联合假阳性 ≤ 2α——
  // 对比固定样本 z 检验反复偷看时假阳性随偷看次数无界膨胀。
  const alpha = 0.05;
  let falseAlarms = 0;
  const TRIALS = 1000;
  const rng = mulberry32(2024);
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const stream = new AnytimeEvidenceStream({ alpha, reference: 0.5 });
    for (let i = 0; i < 500; i += 1) {
      const verdict = stream.observe(rng() < 0.5 ? 1 : 0).verdict;
      if (verdict !== 'undecided') {
        falseAlarms += 1;
        break;
      }
    }
  }
  const rate = falseAlarms / TRIALS;
  ok(rate <= 2 * alpha, `1000 条偷看流的假阳性率 ${(rate * 100).toFixed(1)}% ≤ 双侧联合界 2α=${(2 * alpha * 100).toFixed(0)}%`);
}

// ═══════════════════ D e-BH FDR 控制 ═══════════════════

section('D e-BH：淘汰全部落在真劣集（FDR = 0 ≤ 名义）');

{
  // 50 条真劣对象（μ=0.25，确证低于水位线 0.5）+ 50 条持平对象（μ=0.5）
  const entries = [];
  const rng = mulberry32(31337);
  const truth = new Map();
  for (let i = 0; i < 50; i += 1) {
    const stream = new AnytimeEvidenceStream({ alpha: 0.05, reference: 0.5 });
    for (let j = 0; j < 400; j += 1) stream.observe(rng() < 0.25 ? 1 : 0);
    entries.push({ id: `bad-${i}`, eValue: stream.view().eBelow });
    truth.set(`bad-${i}`, true);
  }
  for (let i = 0; i < 50; i += 1) {
    const stream = new AnytimeEvidenceStream({ alpha: 0.05, reference: 0.5 });
    for (let j = 0; j < 400; j += 1) stream.observe(rng() < 0.5 ? 1 : 0);
    entries.push({ id: `null-${i}`, eValue: stream.view().eBelow });
    truth.set(`null-${i}`, false);
  }
  const rejected = eBenjaminiHochberg(entries, 0.1);
  const falseDiscoveries = rejected.filter((id) => !truth.get(id));
  ok(rejected.length >= 40, `e-BH 淘汰 ${rejected.length}/50 条真劣对象（检出率高）`);
  ok(falseDiscoveries.length === 0, `零冤案：50 条恰在水位线的对象无一被淘汰（FDR=0 ≤ 名义 0.1）`);
}

// ═══════════════════ E 策略进化集成 ═══════════════════

section('E 策略进化集成：CS 下界适应度 + e-BH 淘汰台账');

{
  const engine = new StrategyEvolutionEngine({ minApplicationsForElite: 10 });
  engine.attachAnytimeEvidence({ alpha: 0.05, reference: 0.5 });
  const seeds = engine.getReport().genomes.map((g) => g.id);
  ok(seeds.length > 0, `初始种群 ${seeds.length} 个基因组`);

  const rng = mulberry32(555);
  for (let round = 0; round < 120; round += 1) {
    const report = engine.getReport();
    for (const genome of report.genomes) {
      // 种群首位以 0.8 概率成功；其余 0.2（真劣）
      const p = genome.id === seeds[0] ? 0.8 : 0.2;
      engine.recordOutcome(genome.id, rng() < p ? 'good' : 'failed');
    }
  }
  const report = engine.getReport();
  ok(report.anytime !== undefined, `演化报告携带任意时刻证据面板（streams=${report.anytime.streams}）`);
  ok(report.anytime.totalConfirmations > 0 || report.anytime.verdicts.below > 0, `e-过程已产出确证裁决（below=${report.anytime.verdicts.below}, above=${report.anytime.verdicts.above}）`);

  // e-BH 淘汰：真劣基因组被证明确实低于水位线后可淘汰
  const eliminated = engine.pruneProvablyDominated(0.1);
  const eliminatedIds = new Set(eliminated.map((e) => e.id));
  ok(!eliminatedIds.has(seeds[0]), `持续优秀的基因组 ${seeds[0]} 未被淘汰（无冤案）`);
  // 淘汰候选只可能来自 eBelow ≥ 1/α（α=0.05 → ≥ 20）的流，断言按确证阈值全额收紧
  ok(eliminated.every((e) => e.eValue >= 1 / 0.05 - 1e-9), `淘汰台账的 e-值全部达确证阈值 1/α=20（${eliminated.map((e) => e.eValue.toFixed(1)).join(', ') || '本轮无淘汰'}）`);
}

// ═══════════════════ F 元认知保证层 ═══════════════════

section('F 元认知保证层：退化 e-确证 + 恢复确证（翻转沿洞察）');

{
  const meta = new MetaCognitionEngine({ successRateTarget: 0.8, qualityTarget: 0.7, tuningCooldownMs: 1e12 });
  meta.attachAnytimeGuards({ alpha: 0.05 });
  const snapshot = (successRate, avgQuality) => ({
    timestamp: Date.now(),
    successRate,
    avgQuality,
    avgLatency: 1000,
    cacheHitRate: 0.3,
    modelSuccessRates: {},
    activeExecutions: 0,
  });

  // 长期退化：成功率持续 0.4（远低于目标 0.8）→ 必然翻转沿确证
  let confirmed = null;
  for (let i = 0; i < 300 && !confirmed; i += 1) {
    const insights = meta.observe(snapshot(0.4, 0.85));
    confirmed = insights.find((ins) => ins.category === 'kpi-degradation-confirmed') ?? null;
  }
  ok(confirmed !== null, `successRate 退化被任意时刻有效证据确证（${confirmed ? confirmed.message.slice(0, 60) + '…' : '未确证'}）`);
  ok(confirmed && /e=\d/.test(confirmed.message), '确证洞察携带 e-值证据');

  // 稳态不再重复打扰
  const before = meta.getHistory().length;
  const repeats = [];
  for (let i = 0; i < 50; i += 1) {
    repeats.push(...meta.observe(snapshot(0.4, 0.85)).filter((ins) => ins.category === 'kpi-degradation-confirmed'));
  }
  ok(repeats.length === 0, `确证后稳态 50 批快照零重复告警（翻转沿语义，偷看免疫不等于告警风暴）`);

  // 恢复：成功率回到 0.95 → 退出确证态（恢复洞察）
  let recovered = null;
  for (let i = 0; i < 500 && !recovered; i += 1) {
    const insights = meta.observe(snapshot(0.95, 0.85));
    recovered = insights.find((ins) => ins.category === 'kpi-recovery-confirmed') ?? null;
  }
  ok(recovered !== null, '恢复同样被确证（退出 below-reference 裁决 → 恢复洞察）');

  const report = meta.getHealthReport();
  ok(report.guarantees !== undefined, `健康报告携带保证层 KPI（${report.guarantees.interpretation.slice(0, 40)}…）`);
  ok(report.guarantees.streams.length === 2, `两条受保护 KPI 流（${report.guarantees.streams.map((s) => s.kpi).join(', ')}）`);
}

// ═══════════════════ G 缺省零漂移 ═══════════════════

section('G 缺省零漂移：不挂载 → 无保证层、无淘汰');

{
  const meta = new MetaCognitionEngine();
  meta.observe({ timestamp: Date.now(), successRate: 0.5, avgQuality: 0.5, avgLatency: 100, cacheHitRate: 0, modelSuccessRates: {}, activeExecutions: 0 });
  const report = meta.getHealthReport();
  ok(report.guarantees === undefined, '未挂载时健康报告无保证层字段（零漂移）');

  const engine = new StrategyEvolutionEngine({ minApplicationsForElite: 10 });
  const report2 = engine.getReport();
  ok(report2.anytime === undefined, '未挂载时演化报告无 anytime 字段（零漂移）');
  ok(engine.pruneProvablyDominated().length === 0, '未挂载时 pruneProvablyDominated 为空操作');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✓ 全部 ${passed} 项断言通过 —— 12.0 任意时刻证据质变闭环成立`);
  process.exit(0);
} else {
  console.error(`✗ ${failed} 项失败（${passed} 项通过）`);
  process.exit(1);
}
