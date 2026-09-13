/**
 * verify-quality-diversity.mjs — 14.0「质量-多样性进化」质变闭环离线验证
 *
 * 升级前后的分水岭：
 *   纯适应度进化只有一个目标——「谁平均分高谁活」。环境一变脸，
 *   早已收敛到旧最优小邻域的种群全军覆没；全局平庸但活法独特的
 *   候选者被无条件杀死；种群的多样性没有度量、不可审计。
 *   MAP-Elites 归档：在自己的 niche 里赢过现任就能上位——多样性
 *   的保护是结构性的；QD-score/coverage 让「点亮多少种活法」
 *   第一次可度量；前沿均匀采样让每种活法获得等量试验预算。
 *
 * 闭环断言：
 *   A 归档准入：niche 定位、更高者上位驱逐前任、同分先到先得防抖动
 *   B niche 保护（分水岭）：全局垫底但本地独特者存活（纯精英进化必杀）
 *   C QD 指标：qdScore/coverage/best/mean/placements/promotions 精确对账
 *   D 前沿均匀采样：各被占据 niche 获得等量预算（频率均衡）
 *   E 行为描述子：极端基因映射行为角点 [1,1,1]/[0,0,0]，不同活法落不同 niche
 *   F 策略进化集成：attachQualityDiversity → qdMetrics/report.qd；
 *     进化后归档占据数单调不减（不塌缩）
 *   G 缺省零漂移：不挂载 → 无 QD 字段，行为与升级前完全一致
 *
 * 运行：npm run build && node scripts/verify-quality-diversity.mjs
 */

import {
  MapElitesArchive,
  STRATEGY_BEHAVIOR_SPACE,
  strategyBehaviorDescriptor,
  StrategyEvolutionEngine,
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

/** 确定性随机源（mulberry32） */
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

// ═══════════════════ A 归档准入 ═══════════════════

section('A 归档准入：在自己的 niche 里赢过现任就能上位');

{
  const archive = new MapElitesArchive({
    bins: [2],
    ranges: [[0, 1]],
    descriptor: (c) => [c.x],
    fitness: (c) => c.f,
    rng: mulberry32(1),
  });

  const first = { x: 0.2, f: 0.5 };
  let out = archive.place(first);
  ok(out.becameElite && out.niche === '0' && out.displaced === undefined, '空缺 niche 首次占据即精英');

  out = archive.place({ x: 0.25, f: 0.4 });
  ok(!out.becameElite, '低适应度挑战失败（现任留任）');

  const challenger = { x: 0.25, f: 0.6 };
  out = archive.place(challenger);
  ok(out.becameElite && out.displaced === first, '高适应度上位并驱逐前任（disposed 可追溯）');

  out = archive.place({ x: 0.25, f: 0.6 });
  ok(!out.becameElite, '同分挑战失败（先到先得，防抖动）');

  out = archive.place({ x: 0.9, f: 0.3 });
  ok(out.becameElite && out.niche === '1', '第二 niche 被点亮（跨 niche 永不比较）');

  // 越界饱和：坐标超范围饱和到边界格
  out = archive.place({ x: 5, f: 0.9 });
  ok(out.niche === '1', '越界坐标饱和到边界格（不抛错不丢失）');
}

// ═══════════════════ B niche 保护（分水岭） ═══════════════════

section('B niche 保护：全局垫底但活法独特者存活（纯精英进化必杀）');

{
  const archive = new MapElitesArchive({
    bins: [2],
    ranges: [[0, 1]],
    descriptor: (c) => [c.x],
    fitness: (c) => c.f,
  });
  archive.place({ x: 0.1, f: 0.9 }); // niche 0 强者
  archive.place({ x: 0.2, f: 0.3 }); // niche 0 平庸（被 0.9 压制）
  archive.place({ x: 0.9, f: 0.25 }); // niche 1 独特但全局垫底

  const m = archive.metrics();
  ok(m.nichesOccupied === 2 && m.bestFitness === 0.9, '两个 niche 各有现任（全局最优 0.9 在位）');
  const elites = archive.eliteCandidates();
  ok(
    elites.some((e) => e.f === 0.25) && !elites.some((e) => e.f === 0.3),
    '全局最低分 0.25 因 niche 独特存活；同 niche 的 0.3 被淘汰——保护的是独特性而非弱者',
  );
  ok(near(m.qdScore, 1.15), `QD-score = 0.9 + 0.25 = 1.15（每个 niche 的最优都计入集体财富，实测 ${m.qdScore}）`);
}

// ═══════════════════ C QD 指标对账 ═══════════════════

section('C QD 指标：可审计的多样性——每个数字都对得上账');

{
  const archive = new MapElitesArchive({
    bins: [2, 2],
    ranges: [
      [0, 1],
      [0, 1],
    ],
    descriptor: (c) => [c.x, c.y],
    fitness: (c) => c.f,
  });
  // 精确落格：(x,y) → 归一化 → floor(·2)
  archive.place({ x: 0.1, y: 0.1, f: 0.4 }); // (0,0)
  archive.place({ x: 0.9, y: 0.1, f: 0.7 }); // (1,0)
  archive.place({ x: 0.1, y: 0.9, f: 0.6 }); // (0,1)
  archive.place({ x: 0.9, y: 0.9, f: 0.2 }); // (1,1)
  archive.place({ x: 0.95, y: 0.95, f: 0.5 }); // (1,1) 挑战成功

  const m = archive.metrics();
  ok(m.totalNiches === 4 && m.nichesOccupied === 4, '二维 2×2 网格全部点亮');
  ok(near(m.coverage, 1), 'coverage = 1');
  ok(near(m.qdScore, 0.4 + 0.7 + 0.6 + 0.5), `qdScore = 各 niche 精英之和 ${m.qdScore}`);
  ok(near(m.bestFitness, 0.7) && near(m.meanFitness, 2.2 / 4), 'bestFitness=0.7，meanFitness=0.55');
  ok(m.placements === 5 && m.promotions === 5, `placements=${m.placements} / promotions=${m.promotions}（五次放置五次上位）`);
  ok(near(m.qdScore / 4, m.meanFitness), 'qdScore / 占据数 = meanFitness（内部一致）');
}

// ═══════════════════ D 前沿均匀采样 ═══════════════════

section('D 前沿均匀采样：每个活法流派获得等量试验预算');

{
  const archive = new MapElitesArchive({
    bins: [3],
    ranges: [[0, 3]],
    descriptor: (x) => [x],
    fitness: () => 0.5,
    rng: mulberry32(99),
  });
  archive.place(0.5); // → niche 0
  archive.place(1.5); // → niche 1
  archive.place(2.5); // → niche 2

  const counts = [0, 0, 0];
  const DRAWS = 6000;
  for (let i = 0; i < DRAWS; i += 1) {
    const s = archive.sample();
    counts[Math.round(s - 0.5)] += 1;
  }
  ok(
    counts.every((c) => Math.abs(c - DRAWS / 3) <= 150),
    `均匀采样三 niche（期望 ${DRAWS / 3}±150，实测 ${counts.join(' / ')}——按适应度加权会偏向单一流派）`,
  );
  ok(archive.sample() !== undefined, '采样始终返回在位精英');
}

// ═══════════════════ E 行为描述子 ═══════════════════

section('E 行为描述子：策略基因 → 敢为 × 节俭 × 警觉 三维活法');

{
  const bold = {
    suppressionWindowMs: 30_000,
    failureEscalationThreshold: 1,
    lowConfidenceThreshold: 0.2,
    costDeferRatio: 10,
    burstOccurrences: 2,
  };
  const d1 = strategyBehaviorDescriptor(bold);
  ok(near(d1[0], 1) && near(d1[1], 1) && near(d1[2], 1), `激进节俭高敏基因 → 行为角点 [1,1,1]（实测 [${d1.map((v) => v.toFixed(3))}]）`);

  const timid = {
    suppressionWindowMs: 15 * 60_000,
    failureEscalationThreshold: 8,
    lowConfidenceThreshold: 0.7,
    costDeferRatio: 1,
    burstOccurrences: 12,
  };
  const d2 = strategyBehaviorDescriptor(timid);
  ok(near(d2[0], 0) && near(d2[1], 0) && near(d2[2], 0), `保守散漫迟钝基因 → 行为角点 [0,0,0]（实测 [${d2.map((v) => v.toFixed(3))}]）`);

  const archive = new MapElitesArchive({
    bins: STRATEGY_BEHAVIOR_SPACE.defaultBins,
    ranges: STRATEGY_BEHAVIOR_SPACE.ranges,
    descriptor: (g) => strategyBehaviorDescriptor(g),
    fitness: () => 0.5,
  });
  ok(
    archive.nicheOf(bold) === '3,3,3' && archive.nicheOf(timid) === '0,0,0',
    `两种极端活法落入对角 niche（${archive.nicheOf(bold)} vs ${archive.nicheOf(timid)}）——行为地图的对角线被点亮`,
  );
  ok(STRATEGY_BEHAVIOR_SPACE.dims.join(',') === 'boldness,frugality,vigilance', '行为空间三维声明完整');
}

// ═══════════════════ F 策略进化集成 ═══════════════════

section('F 策略进化集成：挂载后探索升级为前沿采样，进化不塌缩归档');

{
  const engine = new StrategyEvolutionEngine({ rng: mulberry32(42) });
  engine.attachQualityDiversity({ rng: mulberry32(7) });

  // 驱动 40 次决策回写（优秀/良好混合）
  for (let i = 0; i < 40; i += 1) {
    const genome = engine.selectGenome();
    engine.recordOutcome(genome.id, i % 3 === 0 ? 'excellent' : 'good');
  }

  const before = engine.qdMetrics();
  ok(before !== undefined && before.totalNiches === 64, `挂载即输出 QD 指标（4×4×4 = 64 niche，实测 totalNiches=${before?.totalNiches}）`);
  ok(before.nichesOccupied >= 1 && before.coverage > 0, `初始种群点亮 ${before.nichesOccupied} 个 niche`);

  const report = engine.evolve(true);
  ok(report !== null && report.generation === 1, `进化一代完成（新出生 ${report.born.length} 个基因组）`);

  const after = engine.qdMetrics();
  ok(
    after.nichesOccupied >= before.nichesOccupied,
    `进化后归档占据数单调不减（${before.nichesOccupied} → ${after.nichesOccupied}，MAP-Elites 结构性防塌缩）`,
  );
  ok(engine.getReport().qd !== undefined, '演化报告携带 qd 面板（运维可观测）');
}

// ═══════════════════ G 缺省零漂移 ═══════════════════

section('G 缺省零漂移：不挂载 → 无 QD 字段，行为与升级前一致');

{
  const engine = new StrategyEvolutionEngine({ rng: mulberry32(5) });
  const genome = engine.selectGenome();
  engine.recordOutcome(genome.id, 'excellent');
  const report = engine.getReport();
  ok(report.qd === undefined, '未挂载时演化报告无 qd 字段（零漂移）');
  ok(engine.qdMetrics() === undefined, '未挂载时 qdMetrics 返回 undefined');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✓ 全部 ${passed} 项断言通过 —— 14.0 质量-多样性质变闭环成立`);
  process.exit(0);
} else {
  console.error(`✗ ${failed} 项失败（${passed} 项通过）`);
  process.exit(1);
}
