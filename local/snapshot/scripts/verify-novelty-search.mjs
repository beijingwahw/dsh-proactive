/**
 * verify-novelty-search.mjs — 91.0 新奇搜索内核纯数学离线验证
 *
 * 新奇搜索的数学核心都有解析对照（不是「能跑」，是「算得对」）：
 *   ④ 新奇分精确性: k 近邻平均距离的手工解析对照（k=1/2/越界/平局/
 *        二维/维度不一致抛错）；引擎内部批量口径与导出 noveltyScore
 *        口径逐位一致（差恰为 0）；同种子全程确定；档案限容随机淘汰
 *   ① 招牌实验（欺骗迷宫 100 种子）: 贪婪启发（末位欧氏距离）的梯度
 *        从起点 12 一路降到空腔顶 ~1.6——梯度尽头是凹室与空腔之间的
 *        死墙；真路径须先远离目标沿外环绕行 36+ 步。新奇搜索成功率
 *        ≥ 0.8（实测 0.99），纯适应度搜索（同一变异/交叉/预算，选择压
 *        = 启发距离）≤ 0.1（实测 0）——并自证适应度困死形态：末代挤在
 *        死墙下、最优末位距离 1.63 < 2.2（比外环任何有利点都近却永远
 *        过不去）、行为覆盖塌缩到 ~21 格 vs 新奇末代铺开 40+ 格
 *   ② 档案多样性单调增长: 行为格覆盖数非降且终点点亮全部 110 个
 *        可行格；归档直径（增量精确维护）非降、终值 ≥ 24（全图跨度
 *        ~25.8 的 93%）、比第 8 代扩张 ≥ 5
 *   ③ MCNS 门槛必要性: 死亡区迷宫（流沙海 153 格 lethal、烟囱门正对
 *        起点）预算 60 代 50 种子——纯新奇被 lethal 海吸走选择预算
 *        （成功率 ~0.5），minCriterion 版把选择压约束在外环（~0.85），
 *        平均首解代数亦更短
 *   ⑤ 诚实代价报告: 开阔地（41×29 无欺骗、直线 29 步）60 种子——
 *        新奇同样能解（≥ 0.9）但平均首解代数比适应度搜索多 15+ 代
 *        （新奇把预算撒向全图，目标只是被覆盖到的区域之一——新奇
 *        不是免费的）
 *
 * 全部断言确定性（内核自带 mulberry32，同种子同输出）。
 * 运行：node --experimental-strip-types scripts/verify-novelty-search.mjs
 */

import {
  noveltyScore,
  noveltySearch,
  fitnessOnlySearch,
  deceptiveMaze,
  openFieldMaze,
  hardMazeStats,
} from '../src/core/novelty-search.ts';

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
function throws(fn, label) {
  try {
    fn();
    ok(false, label);
  } catch {
    ok(true, label);
  }
}

// ═══════════════════ ④ 新奇分精确对照 ═══════════════════

section('④ 新奇分：k 近邻平均距离的手工解析对照 + 双口径逐位一致');

{
  // 1-D 手工档案：距 [3] 的距离依次 3,2,1,7
  const pool1 = [[0], [1], [2], [10]];
  ok(near(noveltyScore([3], pool1, 2), 1.5), `k=2 → (1+2)/2 = 1.5（实测 ${noveltyScore([3], pool1, 2)}）`);
  ok(near(noveltyScore([3], pool1, 1), 1), `k=1 → 最近邻距离 1（实测 ${noveltyScore([3], pool1, 1)}）`);
  ok(near(noveltyScore([3], pool1, 10), 3.25), `k=10 > 池 4 → 全池平均 (3+2+1+7)/4 = 3.25（实测 ${noveltyScore([3], pool1, 10)}）`);
  // 2-D：距 [3,0] 的距离依次 3, 4, √73
  const pool2 = [[0, 0], [3, 4], [6, 8]];
  ok(near(noveltyScore([3, 0], pool2, 2), 3.5), `二维 k=2 → (3+4)/2 = 3.5（实测 ${noveltyScore([3, 0], pool2, 2)}）`);
  // 平局：距 [1.5] 两边各 0.5
  ok(near(noveltyScore([1.5], [[1], [2]], 2), 0.5), `平局取两等距 (0.5+0.5)/2 = 0.5（实测 ${noveltyScore([1.5], [[1], [2]], 2)}）`);
  // 空旷点的新奇分大于密集点（方向性 sanity）
  const dens = Array.from({ length: 12 }, (_, i) => [i * 0.1]);
  ok(
    noveltyScore([50], dens, 5) > noveltyScore([0.55], dens, 5),
    `远离簇 ρ=${noveltyScore([50], dens, 5).toFixed(3)} > 簇内 ρ=${noveltyScore([0.55], dens, 5).toFixed(3)}（ρ 大 = 周围空旷）`,
  );

  // 入参校验显式抛错
  throws(() => noveltyScore([1], [], 3), '空池抛错（noveltyScore: pool 不能为空）');
  throws(() => noveltyScore([1], [[1]], 0), 'k=0 抛错（需 ≥ 1 整数）');
  throws(() => noveltyScore([1, 2], [[1], [2, 3]], 2), '池内维度不一致抛错');
  throws(() => noveltyScore([], [[1]], 1), '空 behavior 抛错');
  throws(
    () => noveltySearch({ genomeSpace: { dim: 8 }, behaviorOf: (g) => [g[0]], generations: 3, popSize: 3, k: 2, archiveCap: 5, seed: 1 }),
    'noveltySearch popSize=3 抛错（需 ≥ 4）',
  );
  throws(() => deceptiveMaze({ genomeLength: 30 }), 'deceptiveMaze genomeLength=30 抛错（最短真路径 36 步）');
  throws(() => hardMazeStats(0), 'hardMazeStats seeds=0 抛错');

  // 引擎口径 vs 导出口径：末代个体的 novelty 用「终态归档 ∪ 末代（除自身）」重算应逐位相等
  const task = deceptiveMaze();
  const run = noveltySearch({
    genomeSpace: task.genomeSpace,
    behaviorOf: task.behaviorOf,
    solved: task.solved,
    generations: 200,
    popSize: 50,
    k: 10,
    archiveCap: 220,
    seed: 23,
  });
  const pool = [...run.archive.map((e) => e.behavior), ...run.lastPopulation.map((p) => p.behavior)];
  let maxDiff = 0;
  for (let i = 0; i < run.lastPopulation.length; i += 1) {
    const ind = run.lastPopulation[i];
    const sub = pool.filter((_, j) => j !== run.archive.length + i);
    maxDiff = Math.max(maxDiff, Math.abs(noveltyScore(ind.behavior, sub, 10) - ind.novelty));
  }
  ok(maxDiff === 0, `引擎批量口径与导出 noveltyScore 口径逐位一致（末代 50 个体最大差 = ${maxDiff}）`);

  // 同种子确定性
  const again = noveltySearch({
    genomeSpace: task.genomeSpace,
    behaviorOf: task.behaviorOf,
    solved: task.solved,
    generations: 25,
    popSize: 12,
    k: 4,
    archiveCap: 40,
    seed: 42,
  });
  const again2 = noveltySearch({
    genomeSpace: task.genomeSpace,
    behaviorOf: task.behaviorOf,
    solved: task.solved,
    generations: 25,
    popSize: 12,
    k: 4,
    archiveCap: 40,
    seed: 42,
  });
  ok(
    JSON.stringify(again.noveltyTrace) === JSON.stringify(again2.noveltyTrace) &&
      JSON.stringify(again.archive.map((e) => e.behavior)) === JSON.stringify(again2.archive.map((e) => e.behavior)),
    '同种子两次运行 trace 与归档行为完全一致（mulberry32 确定性）',
  );

  // 档案限容随机淘汰：cap=8 全程不超容，30 代后满容
  const capRun = noveltySearch({
    genomeSpace: task.genomeSpace,
    behaviorOf: task.behaviorOf,
    generations: 30,
    popSize: 20,
    k: 5,
    archiveCap: 8,
    seed: 9,
  });
  ok(
    capRun.noveltyTrace.every((e) => e.archiveSize <= 8) && capRun.noveltyTrace.at(-1).archiveSize === 8,
    `档案限容：cap=8 时全程 ≤ 8 且 30 代满容（终值 ${capRun.noveltyTrace.at(-1).archiveSize}）`,
  );

  // ═══════════════════ ② 档案多样性单调增长（沿用 seed 23 全程 run） ═══════════════════

  section('② 档案多样性单调增长：覆盖数/归档直径非降，行为空间铺满全图');

  const tr = run.noveltyTrace;
  let mono = true;
  for (let i = 1; i < tr.length; i += 1) {
    if (tr[i].cellsCovered < tr[i - 1].cellsCovered) mono = false;
    if (tr[i].archiveDiameter < tr[i - 1].archiveDiameter) mono = false;
    if (tr[i].archiveSize < tr[i - 1].archiveSize) mono = false;
  }
  ok(mono, `行为格覆盖数 / 归档直径 / 档案容量全程非降（201 个 trace 点）`);
  let openCells = 0;
  for (let i = 0; i < task.maze.walls.length; i += 1) if (task.maze.walls[i] === 0) openCells += 1;
  ok(
    tr.at(-1).cellsCovered === openCells,
    `行为格覆盖 ${tr[0].cellsCovered}（g0）→ ${tr[8].cellsCovered}（g8）→ ${tr.at(-1).cellsCovered}（g200）= 全部 ${openCells} 个可行格（100% 点亮）`,
  );
  const dFinal = tr.at(-1).archiveDiameter;
  const dEarly = tr[8].archiveDiameter;
  ok(dFinal >= 24, `归档直径 ${dEarly.toFixed(2)}（g8）→ ${dFinal.toFixed(2)}（g200）≥ 24（全图跨度上限 ≈ 25.8，探索铺满整张地图）`);
  ok(dFinal >= dEarly + 5, `直径比第 8 代再扩张 ${dFinal - dEarly >= 5 ? '≥' : '<'} 5（实测 +${(dFinal - dEarly).toFixed(2)}——多样性持续增长而非早早饱和）`);
  ok(tr.at(-1).archiveSize === 200 && run.archive.length === 200, `档案每代 +1 面包屑：200 代 → ${run.archive.length} 条（未触 cap=220 淘汰）`);
}

// ═══════════════════ ① 招牌实验：欺骗迷宫 100 种子 ═══════════════════

section('① 招牌实验：欺骗迷宫 100 种子——新奇 ≥ 0.8 vs 纯适应度 ≤ 0.1');

{
  const stats = hardMazeStats(100);
  console.log(
    `    novelty: ${stats.novelty.successes}/100（mean 首解 ${stats.novelty.meanFirstGeneration} / max ${stats.novelty.maxFirstGeneration}）   fitness: ${stats.fitness.successes}/100`,
  );
  ok(stats.novelty.successRate >= 0.8, `新奇搜索成功率 ${stats.novelty.successRate} ≥ 0.8（${stats.novelty.successes}/100 种子在 ${stats.settings.generations} 代内找到目标）`);
  ok(stats.fitness.successRate <= 0.1, `纯适应度搜索成功率 ${stats.fitness.successRate} ≤ 0.1（${stats.fitness.successes}/100——贪婪启发梯度锁进大空腔）`);

  // ── 自证适应度搜索会困死（同一迷宫同一预算，先证明再对比）──
  const task = deceptiveMaze();
  const fitRun = fitnessOnlySearch({
    genomeSpace: task.genomeSpace,
    fitnessOf: task.fitnessOf,
    solved: task.solved,
    generations: 200,
    popSize: 50,
    seed: 23,
  });
  const fcells = new Set(fitRun.lastPopulation.map((i) => task.simulate(i.genome).finalCell.join(',')));
  const fmean = fitRun.lastPopulation.reduce((s, i) => s + task.simulate(i.genome).finalDist, 0) / fitRun.lastPopulation.length;
  ok(fitRun.solutions.length === 0, `适应度搜索 200 代零解（seed 23 全程跑满，不提前停）`);
  const bestDist = -fitRun.fitnessTrace.at(-1).bestFitness;
  ok(
    bestDist < 2.2,
    `最优个体末位距目标 ${bestDist.toFixed(2)} < 2.2：比外环最高瞭望点 (11,1) 的 2.0 还近——挤在凹室正下方的死墙前，一步之遥永远过不去（局部最优的解剖标本）`,
  );
  ok(fcells.size <= 24, `适应度末代行为覆盖塌缩到 ${fcells.size} 格（种群挤死在空腔/烟囱一带）`);
  ok(fmean <= 5, `适应度末代平均末位启发距离 ${fmean.toFixed(2)} ≤ 5（全部围着死路打转）`);

  // ── 同预算新奇搜索的末代形态对照 ──
  const nsRun = noveltySearch({
    genomeSpace: task.genomeSpace,
    behaviorOf: task.behaviorOf,
    solved: task.solved,
    generations: 200,
    popSize: 50,
    k: 10,
    archiveCap: 220,
    seed: 23,
  });
  const ncells = new Set(nsRun.lastPopulation.map((p) => p.behavior.map(Math.floor).join(',')));
  ok(
    nsRun.solutions.length > 0 && nsRun.firstSolvedGeneration !== null,
    `新奇搜索 seed 23 于第 ${nsRun.firstSolvedGeneration} 代首解，累计 ${nsRun.solutions.length} 个解基因组（发现后目标区被持续覆盖）`,
  );
  ok(
    ncells.size >= 30,
    `新奇末代行为覆盖 ${ncells.size} 格 ≥ 30（对照适应度末代 ${fcells.size} 格——无目标的种群反而铺满地图）`,
  );
}

// ═══════════════════ ③ MCNS 门槛必要性 ═══════════════════

section('③ MCNS：死亡区迷宫（流沙海）下门槛版显著优于纯新奇');

{
  const lethalTask = deceptiveMaze({ lethal: true });
  const BUDGET = 60;
  const SEEDS = 50;
  function batch(minCrit) {
    let succ = 0;
    const gens = [];
    for (let s = 1; s <= SEEDS; s += 1) {
      const r = noveltySearch({
        genomeSpace: lethalTask.genomeSpace,
        behaviorOf: lethalTask.behaviorOf,
        solved: lethalTask.solved,
        minCriterion: minCrit ? lethalTask.feasible : undefined,
        generations: BUDGET,
        popSize: 50,
        k: 10,
        archiveCap: 220,
        seed: s,
        stopWhenSolved: true,
      });
      if (r.firstSolvedGeneration !== null) {
        succ += 1;
        gens.push(r.firstSolvedGeneration);
      }
    }
    const mean = gens.length ? gens.reduce((a, b) => a + b, 0) / gens.length : null;
    return { rate: succ / SEEDS, mean };
  }
  const pure = batch(false);
  const mcns = batch(true);
  console.log(`    纯新奇 ${Math.round(pure.rate * 100)}%（mean ${pure.mean?.toFixed(1)}） vs MCNS ${Math.round(mcns.rate * 100)}%（mean ${mcns.mean?.toFixed(1)}）· 预算 ${BUDGET} 代 × ${SEEDS} 种子`);
  ok(mcns.rate >= 0.8, `MCNS 成功率 ${mcns.rate.toFixed(2)} ≥ 0.8（门槛把选择压全部约束在可行外环上）`);
  ok(pure.rate <= 0.7, `纯新奇成功率 ${pure.rate.toFixed(2)} ≤ 0.7（被 153 格流沙海的高新奇吸走选择预算）`);
  ok(mcns.rate >= pure.rate + 0.15, `门槛优势 ${((mcns.rate - pure.rate) * 100).toFixed(0)} 个百分点 ≥ 15（存活门槛的必要性）`);
  ok(
    pure.mean !== null && mcns.mean !== null && mcns.mean < pure.mean,
    `平均首解代数 MCNS ${mcns.mean.toFixed(1)} < 纯新奇 ${pure.mean.toFixed(1)}（可行域内定向探索更快）`,
  );
}

// ═══════════════════ ⑤ 诚实代价：无欺骗开阔地 ═══════════════════

section('⑤ 诚实代价：开阔地上新奇也能解，但平均首解代数更多');

{
  const easy = openFieldMaze();
  const SEEDS = 60;
  function batch(kind) {
    let succ = 0;
    const gens = [];
    for (let s = 1; s <= SEEDS; s += 1) {
      const cfg = { genomeSpace: easy.genomeSpace, solved: easy.solved, generations: 250, popSize: 40, seed: s, stopWhenSolved: true };
      const r =
        kind === 'ns'
          ? noveltySearch({ ...cfg, behaviorOf: easy.behaviorOf, k: 8, archiveCap: 150 })
          : fitnessOnlySearch({ ...cfg, fitnessOf: easy.fitnessOf });
      if (r.firstSolvedGeneration !== null) {
        succ += 1;
        gens.push(r.firstSolvedGeneration);
      }
    }
    return { succ, mean: gens.reduce((a, b) => a + b, 0) / Math.max(1, gens.length) };
  }
  const ns = batch('ns');
  const fit = batch('fit');
  console.log(`    新奇 ${ns.succ}/${SEEDS}（mean ${ns.mean.toFixed(1)} 代） vs 适应度 ${fit.succ}/${SEEDS}（mean ${fit.mean.toFixed(1)} 代）`);
  ok(ns.succ >= 54, `无欺骗地形新奇搜索照样能解：${ns.succ}/${SEEDS} ≥ 0.9（新奇不是不能收敛，只是不认目标）`);
  ok(fit.succ >= 59, `适应度搜索 ${fit.succ}/${SEEDS}（平滑单调地形是它的主场）`);
  ok(
    ns.mean >= fit.mean + 15,
    `诚实代价：新奇平均首解 ${ns.mean.toFixed(1)} 代 ≥ 适应度 ${fit.mean.toFixed(1)} 代 + 15（新奇把预算撒向全图，目标只是被覆盖到的区域之一）`,
  );
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
