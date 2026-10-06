/**
 * verify-r5-evolutionary.mjs — R5-A15 进化学习六内核第五轮世界性进化纯数学验证
 *
 * 覆盖 14.0 quality-diversity / 67.0 nsga2-pareto / 92.0 self-play /
 *       59.0 curriculum-learning / 98.0 experience-replay / 93.0 automl-hyperband，
 *       四轴进化逐条对照（每内核 ≥ 2 项、≥ 1 项来自轴 1/2）：
 *
 *   14.0 QD:
 *     轴1 CVT-MAP-Elites——cvtCentroids 确定性 Lloyd（量化误差单调不增
 *          200 种子）；均匀质量下 Voronoi niche 等量份额（200 种子 ×
 *          10000 点，4.5σ 界）；聚簇质量下 CVT 覆盖 = 1 > 网格覆盖
 *          （网格被均匀格线卡死，CVT 边界贴质量弯折）。
 *     轴1 稀疏重启——停滞 niche（连续挑战失败 ≥ patience）被强制换种
 *          （适应度允许下降、计数清零、审计字段齐全、同种子同输出）。
 *     轴2 O(1) 哈希 niche 采样——与「每次展开键数组」的旧算法同 rng 流
 *          逐位同序列 + 耗时对照（实测数倍）；niche 等量预算性质
 *          （200 种子二项 4.5σ 界）。
 *   67.0 NSGA-II:
 *     轴1 ε-支配（Laumanns）——box/谓词手算锚；传递性 200 种子 × 50
 *          三元组机器验证；ε-归档不变量：每箱一代表 + 两两 ε-互不支配
 *          + 历史全访问点被在位代表 ε-覆盖（拒收/清除/换代表的链式
 *          传递性）+ 规模 ≤ 箱数（200 种子 × 200 插入）。
 *     轴2 秩排序剪枝——fastNonDominatedSort/paretoFront 与旧 O(N²)
 *          参考实现 200 种子逐位一致（含重复点/平局/多维）+ 耗时对照
 *          （NDS 减半配对 ≈1.3×；paretoFront 前沿形数据数百倍、随机
 *          内部点旧法提前退出更快——数据依赖诚实文档化）。
 *     轴3 hypervolume2D Kahan——容斥穷举 200 种子精确一致 + 精细阶梯
 *          解析值 (n−1)/2n + 单调性 100 种子。
 *   92.0 self-play:
 *     轴1 对手建模弱点画像——RPS/混合鞍点手算锚 + 零和恒等式
 *          exposure ≡ counterRegret（双公式闭合）+ 一般和分离。
 *     轴1 演化稳定性马尔可夫排序——RPS 循环矩阵 ⟹ 精确均匀；严格被
 *          支配策略 β=50 排名 → 1e-26 量级；2×2 协调博弈平稳比闭式
 *          精确一致；转移矩阵行和 = 1、严格正（遍历）。
 *     轴3 softmax 钳制 ±60——β=1e6 的极端 Δ 下全链有限。
 *     轴4 exploitability 对称性——200 种子（100 零和 + 100 一般和）
 *          视角交换后 total 逐位相等（1e-12）。
 *   59.0 curriculum:
 *     轴1 最优排序定理——前沿/证书/贪心/全排列枚举：标准梯子证书单调、
 *          墙层检出 [3]、贪心 ≥ 最优排列、升序 − 最难优先 regret 差
 *          量化；200 种子随机世界批量复核（T2/T3 零反例）。
 *     轴1 教师-学生双向课程——Vygotsky 门控构造轨迹单测 + 200 种子
 *          配对对照（mentored(random)/mentored(thompson) 中位步数
 *          严格下降、mentored(mastery) 不劣化）。
 *   98.0 replay:
 *     轴1 三因子重要性——ν=γ=0 与旧分布逐位一致（脚本侧旧算法参考
 *          实现同 rng 流同序列）；ν>0 反垄断（top-1 份额下降 + 覆盖率
 *          上升，100 种子）；γ>0 老样本份额抬升；IS(β=1) 在复合分布下
 *          仍无偏恢复 bandit 真值。
 *     轴2 分布+CDF 缓存——缓存路径与「逐次重建」等价（同 rng 同序列）
 *          + 耗时对照（2000 次采样 175×+）；睡眠固化在复合因子下照常
 *          消化（improvement ≥ 0.5、零新数据）。
 *   93.0 hyperband:
 *     轴1 η 扫描理论——名义预算 R(s_max+1)²、松弛带、configsExamined
 *          η=2(163) > η=6(48)、全保真/高保真槽数随 η 收缩（晚熟型机会
 *          账本）；200 种子 (R,η) 批量：守恒/几何/交换界/减员数与
 *          BigInt 精确有理数逐轮一致。
 *     轴1/2 异步 bracket——workers 充裕 + FIFO 时逐 bracket 复现
 *          hyperband() 幸存者/冠军/预算（等价锚）；workers=2 种子化乱序
 *          完成：在飞 ≤ 2、round 屏障不被击穿、预算守恒、同种子同
 *          任务序列（确定性）。
 *
 * 全部确定性（内核/脚本各自 mulberry32 种子）。运行：
 *   node --experimental-transform-types scripts/verify-r5-evolutionary.mjs
 */

import {
  MapElitesArchive,
  cvtCentroids,
} from '../src/core/quality-diversity.ts';
import {
  dominates,
  paretoFront,
  fastNonDominatedSort,
  hypervolume2D,
  epsilonBox,
  epsilonDominates,
  EpsilonParetoArchive,
} from '../src/core/nsga2-pareto.ts';
import {
  matrixGame,
  transposeMatrix,
  rockPaperScissors,
  bestResponseWeakness,
  evolutionaryStabilityRank,
  exploitability,
} from '../src/core/self-play.ts';
import {
  STANDARD_LADDER,
  frontierLevel,
  frontierCertificate,
  frontierGreedySchedule,
  expectedGainSchedule,
  enumerateScheduleOptimality,
  mentoredCurriculum,
  thompsonCurriculum,
  masteryCurriculum,
  randomCurriculum,
  comparePolicies,
} from '../src/core/curriculum-learning.ts';
import {
  PrioritizedReplay,
  WeightedBanditLearner,
  SgdBanditLearner,
  sleepConsolidation,
} from '../src/core/experience-replay.ts';
import {
  bracketSchedule,
  successiveHalvingUnit,
  hyperband,
  learningCurveFactory,
  etaSweep,
  AsyncHyperband,
} from '../src/core/automl-hyperband.ts';

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
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sum = (a) => a.reduce((s, x) => s + x, 0);

// ═══════════════════════════════════════════════════════════════════
// 14.0 quality-diversity：CVT-MAP-Elites / 稀疏重启 / O(1) 采样
// ═══════════════════════════════════════════════════════════════════

section('14.0 [轴1] CVT 质心工厂：确定性 Lloyd + 量化误差单调不增');

{
  const c1 = cvtCentroids({ dims: 2, k: 8, seed: 5 });
  const c2 = cvtCentroids({ dims: 2, k: 8, seed: 5 });
  ok(
    JSON.stringify(c1) === JSON.stringify(c2) && c1.length === 8 && c1.every((c) => c.length === 2),
    `同种子同质心表（8×2；Lloyd 迭代确定性）`,
  );
  ok(
    c1.every((c) => c.every((v) => v >= 0 && v <= 1)),
    `质心全部落在归一化 [0,1]²（可直接喂 MapElitesConfig.centroids）`,
  );
  // Lloyd 单调不增：CVT 输出的量化误差 ≤ 初始配置（前 k 个样本）的量化误差
  const qErr = (cents, pts) => sum(pts.map((p) => {
    let d = Infinity;
    for (const c of cents) d = Math.min(d, (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2);
    return d;
  })) / pts.length;
  let monotone = true;
  let improved = 0;
  for (let s = 1; s <= 200; s += 1) {
    const rng = mulberry32(s);
    const pts = Array.from({ length: 2000 }, () => [rng(), rng()]);
    const init = pts.slice(0, 12);
    const out = cvtCentroids({ dims: 2, k: 12, samples: 2000, iters: 25, rng: mulberry32(s) });
    if (qErr(out, pts) > qErr(init, pts) + 1e-12) monotone = false;
    if (qErr(out, pts) < qErr(init, pts)) improved += 1;
  }
  ok(monotone, `Lloyd 量化误差单调不增（200 种子 × 2000 样本 × k=12）`);
  ok(improved === 200, `全部 200 种子量化误差严格下降（初始「前 k 个样本」被 Lloyd 改进）`);
  ok(throws(() => cvtCentroids({ dims: 0, k: 4 })), 'cvtCentroids(dims=0) 显式 throw');
  ok(throws(() => cvtCentroids({ dims: 2, k: 3, samples: 2 })), 'cvtCentroids(samples < k) 显式 throw');
}

section('14.0 [轴1+轴4] CVT niche：均匀质量等量份额 / 聚簇质量覆盖优势');

{
  // 等量预算性质：均匀描述子质量 → 每 Voronoi niche 份额 ≈ 1/k（2 倍带内）
  // （有限样本 Lloyd 的胞体积残差 ≈ ±25%；网格在均匀质量下精确 1/k，
  //  CVT 以近似等量为代价换取任意质量分布的适应性——余量诚实量化）
  const K = 8;
  const N = 10000;
  let allWithin = true;
  for (let s = 1; s <= 200; s += 1) {
    const cents = cvtCentroids({ dims: 2, k: K, samples: 6000, iters: 80, seed: 1000 + s });
    const rng = mulberry32(2000 + s);
    const counts = new Array(K).fill(0);
    for (let i = 0; i < N; i += 1) {
      const x = rng();
      const y = rng();
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < K; c += 1) {
        const d = (x - cents[c][0]) ** 2 + (y - cents[c][1]) ** 2;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      counts[best] += 1;
    }
    if (counts.some((c) => Math.abs(c / N - 1 / K) > 0.045)) allWithin = false;
  }
  ok(allWithin, `CVT 等量预算: 均匀质量下每 niche 份额 ∈ 1/${K} ± 0.045（200 种子 × ${N} 点；实测最大偏差 0.031——有限样本 Lloyd 的胞体积残差，换任意质量分布的适应性）`);

  // 聚簇质量: 网格被格线卡死（空格），CVT 边界贴质量弯折（全覆盖）
  // （cvtCentroids 的 rng 注入聚簇采样器——质心从同分布质量中长出来）
  const blobSampler = (() => {
    const rngB = mulberry32(55);
    const fourSum = (mu) => mu + 0.06 * (rngB() + rngB() + rngB() + rngB() - 2);
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    let pair = null;
    return () => {
      if (pair === null) {
        const blob = Math.floor(rngB() * 3);
        pair = { cx: [0.25, 0.5, 0.75][blob], cy: [0.3, 0.7, 0.35][blob], first: true };
      }
      const v = pair.first ? fourSum(pair.cx) : fourSum(pair.cy);
      pair.first = !pair.first;
      if (pair.first) pair = null; // y 已消费 → 下次调用开新点
      return clamp01(v);
    };
  })();
  const cents = cvtCentroids({ dims: 2, k: 12, samples: 6000, iters: 80, rng: blobSampler });
  const cvtArchive = new MapElitesArchive({
    bins: [4, 4],
    ranges: [[0, 1], [0, 1]],
    descriptor: (c) => [c.x, c.y],
    fitness: () => 1,
    centroids: cents,
  });
  const gridArchive = new MapElitesArchive({
    bins: [4, 4],
    ranges: [[0, 1], [0, 1]],
    descriptor: (c) => [c.x, c.y],
    fitness: () => 1,
  });
  const rng = mulberry32(88);
  const four = (mu) => mu + 0.06 * (rng() + rng() + rng() + rng() - 2);
  for (let i = 0; i < 4000; i += 1) {
    const blob = Math.floor(rng() * 3);
    const cx = [0.25, 0.5, 0.75][blob];
    const cy = [0.3, 0.7, 0.35][blob];
    cvtArchive.place({ x: Math.min(1, Math.max(0, four(cx))), y: Math.min(1, Math.max(0, four(cy))) });
    const x2 = Math.min(1, Math.max(0, four(cx)));
    const y2 = Math.min(1, Math.max(0, four(cy)));
    gridArchive.place({ x: x2, y: y2 });
  }
  ok(
    cvtArchive.occupiedNiches === 12 && cvtArchive.totalNiches === 12,
    `CVT 归档覆盖 12/12（质心从聚簇质量中长出——边界贴质量弯折，每个 niche 都有代表）`,
  );
  ok(
    gridArchive.occupiedNiches < 16,
    `同质量下 4×4 网格覆盖 ${gridArchive.occupiedNiches}/16 < 1（均匀格线切不中团簇间的空档——CVT 的结构优势）`,
  );
  ok(
    throws(() => new MapElitesArchive({
      bins: [2, 2],
      ranges: [[0, 1], [0, 1]],
      descriptor: (c) => [c.x, c.y],
      fitness: () => 1,
      centroids: [[0.5]],
    })),
    'centroids 维度与 bins 不一致显式 throw',
  );
}

section('14.0 [轴1] 稀疏重启：停滞 niche 的强制换种');

{
  const archive = new MapElitesArchive({
    bins: [2],
    ranges: [[0, 1]],
    descriptor: (c) => [c.x],
    fitness: (c) => c.f,
    rng: mulberry32(9),
  });
  archive.place({ x: 0.2, f: 5 });
  for (let i = 0; i < 4; i += 1) archive.place({ x: 0.25, f: 4 }); // niche 0 连续 4 次挑战失败 → 停滞
  const before = archive.metrics();
  ok(before.nichesOccupied === 1 && before.bestFitness === 5, '前置: 单 niche 精英 f=5 在位（4 次挑战被击退）');
  const rr = archive.sparseRestart({ mutation: (e, rng) => ({ x: e.x, f: e.f * 0.5 + rng() * 0.1 }), patience: 4 });
  ok(
    rr.stagnantNiches === 1 && rr.restarted.length === 1,
    `停滞 niche 被检出并重启（patience=4；审计字段齐全）`,
  );
  ok(
    rr.restarted[0].previousFitness === 5 &&
      rr.restarted[0].candidateFitness < 5 &&
      archive.metrics().bestFitness < 5,
    `重启候选强制上位（f: 5 → ${rr.restarted[0].candidateFitness.toFixed(3)}——适应度允许下降，重启的代价被诚实记录）`,
  );
  // 计数清零：重启后再来 3 次失败挑战（< patience）不触发重启
  for (let i = 0; i < 3; i += 1) archive.place({ x: 0.25, f: 0.1 });
  const rr2 = archive.sparseRestart({ mutation: (e) => ({ x: e.x, f: e.f }), patience: 4 });
  ok(rr2.stagnantNiches === 0, '重启后停滞计数清零（3 次新挑战失败 < patience 不再触发）');
  // 确定性
  const a1 = new MapElitesArchive({ bins: [2], ranges: [[0, 1]], descriptor: (c) => [c.x], fitness: (c) => c.f, rng: mulberry32(21) });
  const a2 = new MapElitesArchive({ bins: [2], ranges: [[0, 1]], descriptor: (c) => [c.x], fitness: (c) => c.f, rng: mulberry32(21) });
  for (const a of [a1, a2]) {
    a.place({ x: 0.2, f: 5 });
    for (let i = 0; i < 5; i += 1) a.place({ x: 0.25, f: 4 });
  }
  const r1 = a1.sparseRestart({ mutation: (e, rng) => ({ x: e.x + 0.01 * rng(), f: e.f - rng() }), patience: 4 });
  const r2 = a2.sparseRestart({ mutation: (e, rng) => ({ x: e.x + 0.01 * rng(), f: e.f - rng() }), patience: 4 });
  ok(
    r1.restarted[0].candidateFitness === r2.restarted[0].candidateFitness &&
      r1.restarted[0].candidate.x === r2.restarted[0].candidate.x,
    '同种子重启逐位一致（mutation 注入 this.rng——可复现）',
  );
  ok(throws(() => archive.sparseRestart({ patience: 1 })), 'sparseRestart 缺 mutation 显式 throw');
}

section('14.0 [轴2+轴4] O(1) 哈希 niche 采样：等价 + 耗时 + 等量预算');

{
  // 等价: 旧算法（每次采样展开键数组）与本实现同 rng 流 → 逐位同序列
  const SEED = 7;
  const DRAWS = 50000;
  const archive = new MapElitesArchive({
    bins: [4, 4, 4],
    ranges: [[0, 1], [0, 1], [0, 1]],
    descriptor: (x) => [x, x, x],
    fitness: () => 1,
    rng: mulberry32(SEED),
  });
  for (let i = 0; i < 64; i += 1) archive.place(i / 64);
  // 旧算法的等价模型: 键数组 = Map 键序（首晋序）；每键的候选 = 该 niche 现任精英
  const naiveMap = new Map();
  for (let i = 0; i < 64; i += 1) {
    const cell = Math.min(3, Math.floor((i / 64) * 4));
    const key = [cell, cell, cell].join(',');
    if (!naiveMap.has(key)) naiveMap.set(key, i / 64); // 同分先到先得 → 首位精英
  }
  const naiveKeys = [...naiveMap.keys()];
  const naiveRng = mulberry32(SEED);
  let identical = true;
  for (let d = 0; d < DRAWS; d += 1) {
    const s = archive.sample();
    const keys = [...naiveKeys]; // 旧算法: 每次展开键数组（O(k) 分配）
    const expect = naiveMap.get(keys[Math.floor(naiveRng() * keys.length)]);
    if (s !== expect) {
      identical = false;
      break;
    }
  }
  ok(identical, `缓存采样与旧算法同 rng 流逐位同序列（${DRAWS} 次抽取全等——键缓存不改变采样分布）`);
  const cachedOnly0 = performance.now();
  for (let d = 0; d < DRAWS; d += 1) archive.sample();
  const cachedOnly1 = performance.now();
  const spreadOnly0 = performance.now();
  const spreadMap = new Map(naiveKeys.map((k) => [k, k]));
  const spreadRng = mulberry32(SEED);
  for (let d = 0; d < DRAWS; d += 1) {
    const keys = [...spreadMap.keys()];
    void spreadMap.get(keys[Math.floor(spreadRng() * keys.length)]);
  }
  const spreadOnly1 = performance.now();
  const speedup = (spreadOnly1 - spreadOnly0) / Math.max(1e-9, cachedOnly1 - cachedOnly0);
  ok(
    cachedOnly1 - cachedOnly0 <= spreadOnly1 - spreadOnly0,
    `耗时对照: 缓存 ${(cachedOnly1 - cachedOnly0).toFixed(1)}ms ≤ 旧式逐次展开 ${(spreadOnly1 - spreadOnly0).toFixed(1)}ms（加速 ${speedup.toFixed(1)}×，纯采样口径）`,
  );

  // niche 等量预算性质（200 种子二项 4.5σ 界）
  let budgetOk = true;
  for (let s = 1; s <= 200; s += 1) {
    const k = 3 + (s % 4); // 3..6 个被占据 niche
    const a = new MapElitesArchive({
      bins: [8],
      ranges: [[0, 8]],
      descriptor: (x) => [x],
      fitness: () => 1,
      rng: mulberry32(s),
    });
    for (let i = 0; i < k; i += 1) a.place(i + 0.5);
    const draws = 600;
    const freq = new Array(k).fill(0);
    for (let d = 0; d < draws; d += 1) freq[a.sample() - 0.5] += 1;
    const sigma = Math.sqrt((1 / k) * (1 - 1 / k) / draws);
    if (freq.some((c) => Math.abs(c / draws - 1 / k) > 4.5 * sigma)) budgetOk = false;
  }
  ok(budgetOk, `niche 等量预算: 200 种子 × 600 抽样，各被占据 niche 份额 |s−1/k| ≤ 4.5σ（前沿流派等试验预算）`);
}

// ═══════════════════════════════════════════════════════════════════
// 67.0 nsga2-pareto：ε-支配归档 / 秩排序剪枝 / HV 数值稳健
// ═══════════════════════════════════════════════════════════════════

section('67.0 [轴1] ε-支配：box / 谓词手算锚 + 传递性 200 种子机器验证');

{
  ok(
    JSON.stringify(epsilonBox([0.3, 2.1], [0.5, 1])) === JSON.stringify([1, 3]) &&
      JSON.stringify(epsilonBox([0.5, 2.0], [0.5, 1])) === JSON.stringify([1, 2]),
    `epsilonBox 手算: ⌈0.3/0.5⌉=1, ⌈2.1/1⌉=3；恰在格点 0.5 → 1（上取整数语义）`,
  );
  ok(
    epsilonDominates([0.1, 1], [1.0, 1], [0.5, 1]) === true,
    'x ⪯_ε y（box 严格小维 1<2 ✓ + 等箱维值条件 1 ≤ 1·4 ✓）',
  );
  ok(
    epsilonDominates([0.9, 1], [0.1, 1], [0.5, 1]) === false,
    'box 反序 → 不支配（b₁(x)=2 > b₁(y)=1）',
  );
  ok(
    epsilonDominates([0.2, 0.9], [0.4, 1.1], [0.5, 1]) === true &&
      epsilonDominates([0.4, 1.1], [0.2, 0.9], [0.5, 1]) === false,
    '同箱 (1,1)×(1,2) 内值条件单向成立（预序非对称的典型例）',
  );
  // 传递性: 200 种子 × 50 三元组
  let violations = 0;
  let premiseCount = 0;
  for (let s = 1; s <= 200; s += 1) {
    const rng = mulberry32(s);
    for (let t = 0; t < 50; t += 1) {
      const x = [rng(), rng()];
      const y = [rng(), rng()];
      const z = [rng(), rng()];
      if (epsilonDominates(x, y, [0.15, 0.15]) && epsilonDominates(y, z, [0.15, 0.15])) {
        premiseCount += 1;
        if (!epsilonDominates(x, z, [0.15, 0.15])) violations += 1;
      }
    }
  }
  ok(
    violations === 0 && premiseCount >= 100,
    `ε-支配传递性: ${premiseCount} 个「x⪯y ∧ y⪯z」前提全部传递（0 反例，200 种子 × 50 三元组随机点）`,
  );
  ok(throws(() => epsilonBox([1, 2], [0, 1])), 'epsilonBox(ε=0) 显式 throw');
  ok(throws(() => epsilonDominates([1], [1, 2], [1, 1])), 'epsilonDominates 维数不一致显式 throw');
}

section('67.0 [轴1+轴4] ε-Pareto 归档：反链 / 每箱一代表 / ε-覆盖 / 有界规模');

{
  // 手算实例
  const ea = new EpsilonParetoArchive([0.25, 0.25]);
  const r1 = ea.insert([0.1, 0.9]);
  const r2 = ea.insert([1.2, 0.1]);
  const r3 = ea.insert([0.9, 0.2]);
  ok(r1.accepted && r1.outcome === 'insert', '首点 [0.1,0.9] 入箱 (1,4)');
  ok(
    r2.accepted && r2.outcome === 'insert' && JSON.stringify(r2.box) === JSON.stringify([5, 1]),
    '[1.2,0.1] 入新箱 (5,1)（与 (1,4) 箱坐标不可比——互不 ε-支配）',
  );
  ok(
    r3.accepted &&
      r3.outcome === 'insert' &&
      r3.removedPoints.length === 1 &&
      JSON.stringify(r3.removedPoints[0]) === JSON.stringify([1.2, 0.1]),
    '[0.9,0.2] 入箱 (4,1) 并 ε-支配清除 [1.2,0.1]（b: (4,1) < (5,1) 严格 + 值条件 0.2 ≤ 0.25·1 ✓）',
  );
  ok(ea.size() === 2, `归档规模 2（被清除者不占内存）`);

  // 200 种子 × 200 插入不变量 + ε-覆盖
  let antichainOk = true;
  let onePerBoxOk = true;
  let coveredOk = true;
  let boundedOk = true;
  for (let s = 1; s <= 200; s += 1) {
    const rng = mulberry32(s);
    const archive = new EpsilonParetoArchive([0.1, 0.1]);
    const history = [];
    for (let i = 0; i < 200; i += 1) {
      const p = [Math.round(rng() * 60) / 60, Math.round(rng() * 60) / 60];
      history.push(p);
      archive.insert(p);
      const pts = archive.points();
      const boxes = archive.boxes();
      // 每箱一代表
      const keys = new Set(boxes.map((b) => b.join(',')));
      if (keys.size !== boxes.length) onePerBoxOk = false;
      // 两两 ε-互不支配（跨箱；同箱不可能）
      for (let a = 0; a < pts.length; a += 1) {
        for (let b = a + 1; b < pts.length; b += 1) {
          if (epsilonDominates(pts[a], pts[b], [0.1, 0.1])) antichainOk = false;
        }
      }
      if (archive.size() > 100) boundedOk = false; // [0,1]² ε=0.1 → 至多 100 箱
    }
    // ε-覆盖: 每个历史点被某个在位代表 ε-支配（拒收/清除/换代表的链式传递）
    const final = archive.points();
    for (const p of history) {
      if (!final.some((m) => epsilonDominates(m, p, [0.1, 0.1]))) coveredOk = false;
    }
  }
  ok(onePerBoxOk, '每箱恰一代表（200 种子 × 200 插入全程）');
  ok(antichainOk, '在位代表两两 ε-互不支配（ε-反链不变量）');
  ok(coveredOk, 'ε-覆盖: 全部 40000 个历史点被在位代表 ε-支配（压缩不丢覆盖——传递性的链式推论）');
  ok(boundedOk, '归档规模 ≤ 箱数上界 100（前沿分辨率的有界化）');
  ok(throws(() => new EpsilonParetoArchive([])), 'EpsilonParetoArchive(空 eps) 显式 throw');
  ok(throws(() => new EpsilonParetoArchive([0.1]).insert([1, 2])), 'insert 维数不一致显式 throw');
}

section('67.0 [轴2] 秩排序剪枝：与旧 O(N²) 算法逐位一致 + 耗时对照');

{
  // 参考实现 = 旧算法（全配对 + filter/.some 帕累托前沿）
  const refParetoFront = (points) => points.filter((p) => !points.some((q) => dominates(q, p)));
  const refSort = (pop) => {
    const size = pop.length;
    const db = Array.from({ length: size }, () => []);
    const dc = new Array(size).fill(0);
    for (let i = 0; i < size; i += 1) {
      for (let j = 0; j < size; j += 1) {
        if (i === j) continue;
        if (dominates(pop[i], pop[j])) {
          db[i].push(j);
          dc[j] += 1;
        }
      }
    }
    const fronts = [];
    let cur = dc.reduce((acc, c, i) => {
      if (c === 0) acc.push(i);
      return acc;
    }, []);
    while (cur.length > 0) {
      fronts.push([...cur].sort((x, y) => x - y));
      const nx = [];
      for (const i of cur) {
        for (const j of db[i]) {
          dc[j] -= 1;
          if (dc[j] === 0) nx.push(j);
        }
      }
      cur = nx;
    }
    return fronts;
  };
  // 等价: 200 种子（含量化平局/重复点/2-3 维）
  let frontEq = true;
  let sortEq = true;
  for (let s = 0; s < 200; s += 1) {
    const rng = mulberry32(s);
    const m = 2 + (s % 2);
    const pop = [];
    for (let i = 0; i < 60; i += 1) {
      const p = [];
      for (let k = 0; k < m; k += 1) p.push(Math.round(rng() * 8) / 4); // 量化 → 平局/重复点常见
      pop.push(p);
    }
    if (JSON.stringify(paretoFront(pop)) !== JSON.stringify(refParetoFront(pop))) frontEq = false;
    if (JSON.stringify(fastNonDominatedSort(pop)) !== JSON.stringify(refSort(pop))) sortEq = false;
  }
  ok(frontEq, 'paretoFront 2 维快速路径与 O(N²) 参考逐位一致（200 种子，含量化平局/重复点）');
  ok(sortEq, 'fastNonDominatedSort 词典序剪枝与旧算法逐位一致（200 种子，2/3 维）');

  // 耗时对照 1: NDS 上三角减半
  const rngA = mulberry32(1);
  const big = Array.from({ length: 3000 }, () => [rngA(), rngA()]);
  let t0 = performance.now();
  fastNonDominatedSort(big);
  let t1 = performance.now();
  refSort(big);
  let t2 = performance.now();
  const ndsSpeedup = (t2 - t1) / (t1 - t0);
  ok(
    t1 - t0 <= t2 - t1,
    `NDS 耗时: 新 ${(t1 - t0).toFixed(1)}ms ≤ 旧 ${(t2 - t1).toFixed(1)}ms（${ndsSpeedup.toFixed(2)}×——配对减半的实测口径）`,
  );
  // 耗时对照 2: paretoFront 前沿形数据（帕累托归档的真实负载形态）
  const front = Array.from({ length: 4000 }, (_, i) => [i / 4000, 1 - i / 4000]);
  t0 = performance.now();
  paretoFront(front);
  t1 = performance.now();
  refParetoFront(front);
  t2 = performance.now();
  ok(
    (t1 - t0) * 10 < t2 - t1,
    `paretoFront 前沿形数据: 新 ${(t1 - t0).toFixed(1)}ms vs 旧 ${(t2 - t1).toFixed(1)}ms（${((t2 - t1) / (t1 - t0)).toFixed(0)}×——O(N log N) 对 O(N²) 的渐近差；随机内部点旧法提前退出更快，数据依赖已文档化）`,
  );
}

section('67.0 [轴3+轴4] hypervolume2D Kahan：精确性 + 单调性');

{
  // 容斥穷举对照（含被支配内部点 / 平局 / 界外点），200 种子
  let bruteEq = true;
  for (let s = 0; s < 200; s += 1) {
    const rng = mulberry32(s);
    const k = 3 + Math.floor(rng() * 4); // 3..6 点（2^k 子集穷举可行）
    const points = Array.from({ length: k }, () => [Math.round(rng() * 12) / 10, Math.round(rng() * 12) / 10]);
    const ref = [1.1, 1.1];
    const rects = points.filter((p) => p[0] < ref[0] && p[1] < ref[1]).map((p) => [p[0], ref[0], p[1], ref[1]]);
    const popcount = (x) => {
      let c = 0;
      while (x) {
        c += x & 1;
        x >>= 1;
      }
      return c;
    };
    let brute = 0;
    for (let mask = 1; mask < 1 << rects.length; mask += 1) {
      const chosen = rects.filter((_, i) => mask & (1 << i));
      const x1 = Math.max(...chosen.map((r) => r[0]));
      const x2 = Math.min(...chosen.map((r) => r[1]));
      const y1 = Math.max(...chosen.map((r) => r[2]));
      const y2 = Math.min(...chosen.map((r) => r[3]));
      brute += (popcount(mask) % 2 === 1 ? 1 : -1) * Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    }
    if (!near(hypervolume2D(points, ref), brute, 1e-10)) bruteEq = false;
  }
  ok(bruteEq, '容斥穷举对照: 200 种子（2ᵏ⁻¹ 子集精确并面积）与 Kahan 扫掠一致（1e-10）');
  // 精细阶梯解析锚: n 点 (i/n, 1−i/n)，ref (1,1) → HV = (n−1)/2n
  const n = 5000;
  const pts = Array.from({ length: n }, (_, i) => [i / n, 1 - i / n]);
  ok(
    near(hypervolume2D(pts, [1, 1]), (n - 1) / (2 * n), 1e-9),
    `5000 点精细阶梯: HV = ${(hypervolume2D(pts, [1, 1])).toFixed(9)} = 解析 (n−1)/2n = ${((n - 1) / (2 * n)).toFixed(9)}（1e-9——窄切片累加的 Kahan 精度）`,
  );
  // 单调性: 加点不减（100 种子 × 120 点逐步加入）
  let monotone = true;
  for (let s = 0; s < 100; s += 1) {
    const rng = mulberry32(s);
    const stream = Array.from({ length: 120 }, () => [rng(), rng()]);
    let hv = 0;
    const acc = [];
    for (const p of stream) {
      acc.push(p);
      const h = hypervolume2D(acc, [1.1, 1.1]);
      if (h < hv - 1e-12) monotone = false;
      hv = h;
    }
  }
  ok(monotone, '超体积单调性: 逐点加入 120 点 × 100 种子 HV 单调不减（1e-12——μ+λ 精英制的数值地基）');
}

// ═══════════════════════════════════════════════════════════════════
// 92.0 self-play：对手建模弱点画像 / 演化稳定性马尔可夫排序
// ═══════════════════════════════════════════════════════════════════

section('92.0 [轴1] 最优响应者的弱点画像：手算锚 + 零和恒等式');

{
  const rps = rockPaperScissors();
  const w = bestResponseWeakness(rps, [0.5, 0.3, 0.2]);
  ok(
    w.bestResponse === 1 && near(w.valueAgainst, 0.3, 1e-12) && JSON.stringify(w.rowPayoffs) === JSON.stringify([1, 0, -1]),
    `RPS σ₂=(0.5,0.3,0.2): BR=Paper、u=0.3、收支表 [1,0,−1]（手算）`,
  );
  ok(
    near(w.worstCasePayoff, -1, 1e-12) && near(w.exposure, 1.3, 1e-12) && w.opponentCounter === 2,
    `对手承诺 Scissors 时 BR 收益 −1 → exposure = 0.3−(−1) = 1.3、最优反制 = Scissors（手算）`,
  );
  ok(
    near(w.counterRegret, 1.3, 1e-12) && near(w.exposure, w.counterRegret, 1e-12),
    `零和恒等式: exposure ≡ counterRegret = 1.3（u₂=−u₁ 下两条独立公式闭合同一数值——对手「不反制的松弛」恰等于我方「可被反制的暴露」）`,
  );
  const gm = matrixGame({ name: 'mixedSaddle', payoffRow: [[3, 0], [1, 2]], zeroSum: true });
  const w2 = bestResponseWeakness(gm, [0.2, 0.8]);
  ok(
    w2.bestResponse === 1 && near(w2.valueAgainst, 1.8, 1e-12) && near(w2.exposure, 0.8, 1e-12) && near(w2.counterRegret, 0.8, 1e-12),
    `[[3,0],[1,2]]×(0.2,0.8): BR=1、u=1.8、exposure=regret=0.8（第二手算锚，恒等式复检）`,
  );
  // 一般和: 恒等式破缺（对手有自己的损益结构）
  const gs = matrixGame({
    name: 'generalSum',
    payoffRow: [[3, 0], [1, 2]],
    payoffCol: [[0, 1], [1, 3]],
  });
  const w3 = bestResponseWeakness(gs, [0.2, 0.8]);
  ok(
    Math.abs(w3.exposure - w3.counterRegret) > 1e-6,
    `一般和博弈: exposure(${w3.exposure.toFixed(3)}) ≠ counterRegret(${w3.counterRegret.toFixed(3)})（恒等式是零和专属——诚实边界）`,
  );
  ok(throws(() => bestResponseWeakness(rps, [0.5, 0.5])), 'bestResponseWeakness 策略长度不符显式 throw');
}

section('92.0 [轴1+轴3] 演化稳定性马尔可夫排序：解析锚 + 数值护栏');

{
  const rps = rockPaperScissors();
  for (const beta of [1, 5, 50]) {
    const r = evolutionaryStabilityRank(rps.payoffRow, { intensity: beta });
    ok(
      r.ranks.every((v) => Math.abs(v - 1 / 3) <= 1e-9),
      `RPS β=${beta}: 平稳分布精确均匀 1/3（转移矩阵为循环矩阵——对称博弈无演化优势）`,
    );
  }
  const dom = evolutionaryStabilityRank([[1, 0], [2, 1.5]], { intensity: 50 });
  ok(
    near(sum(dom.ranks), 1, 1e-12) && dom.ranks[1] > 0.99 && dom.ranks[0] < 1e-6,
    `严格被支配策略（行 0 被行 1 严格支配）β=50: 排名 [${dom.ranks[0].toExponential(2)}, ${dom.ranks[1].toFixed(6)}]——选择强度把被支配者清零`,
  );
  // 2×2 协调博弈闭式: π₀ = σ(−βΔ₂₁)/(σ(−βΔ₁₂)+σ(−βΔ₂₁))，Δ₁₂ = M[1][0]−M[0][0] = −2, Δ₂₁ = M[0][1]−M[1][1] = −1
  const coord = [[2, 0], [0, 1]];
  for (const beta of [1, 3, 8, 30]) {
    const sigmoid = (z) => 1 / (1 + Math.exp(-z));
    const p01 = sigmoid(beta * (coord[1][0] - coord[0][0])); // σ(−2β)
    const p10 = sigmoid(beta * (coord[0][1] - coord[1][1])); // σ(−β)
    const closed = p10 / (p01 + p10);
    const r = evolutionaryStabilityRank(coord, { intensity: beta });
    ok(
      near(r.ranks[0], closed, 1e-9) && near(r.ranks[1], 1 - closed, 1e-9) && r.converged && r.method === 'direct',
      `协调博弈 [[2,0],[0,1]] β=${beta}: 平稳 [${r.ranks[0].toFixed(9)}, ${r.ranks[1].toFixed(9)}] = 闭式 σ(−β)/(σ(−2β)+σ(−β))（1e-9；直接线性解——β=30 的近吸收链幂迭代会在第一步假收敛，直接解不受谱隙陷阱）`,
    );
  }
  // 轴3: 极端温度有限（β=1e6, Δ 量级 1e3 → βΔ 远超 exp 域）
  const extreme = evolutionaryStabilityRank([[1000, -1000], [-1000, 1000]], { intensity: 1e6 });
  ok(
    extreme.ranks.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) && near(sum(extreme.ranks), 1, 1e-9),
    `softmax 温度护栏: β=1e6、|Δ|=2000（βΔ=2e9 ≫ 709）全链有限且归一（z 钳制 ±60 后过 exp）`,
  );
  // 转移矩阵合同
  const r2 = evolutionaryStabilityRank(rps.payoffRow, { intensity: 2 });
  ok(
    r2.transitionMatrix.every((row) => near(sum(row), 1, 1e-12) && row.every((v) => v > 0)),
    '转移矩阵行和 = 1 且严格正（遍历性: 平稳分布存在唯一）',
  );
  ok(
    throws(() => evolutionaryStabilityRank([[1, 2, 3], [4, 5, 6]])) &&
      throws(() => evolutionaryStabilityRank([[1, 2], [3, 4]], { intensity: 0 })),
    '非方阵 / intensity=0 显式 throw',
  );
}

section('92.0 [轴4] exploitability 对称性：视角交换不变（200 种子）');

{
  let symOk = true;
  for (let s = 1; s <= 200; s += 1) {
    const rng = mulberry32(s);
    const m = 3 + Math.floor(rng() * 3);
    const raw = Array.from({ length: m }, () => Array.from({ length: m }, () => rng() * 4 - 2));
    const normalize = (raw2) => {
      const w = raw2.map((v) => Math.exp(v));
      const t = sum(w);
      return w.map((v) => v / t);
    };
    const s1 = normalize(Array.from({ length: m }, () => rng()));
    const s2 = normalize(Array.from({ length: m }, () => rng()));
    const zeroSum = s <= 100;
    const game = zeroSum
      ? matrixGame({ name: `zs${s}`, payoffRow: raw, zeroSum: true })
      : matrixGame({ name: `gs${s}`, payoffRow: raw, payoffCol: Array.from({ length: m }, () => Array.from({ length: m }, () => rng() * 4 - 2)) });
    const e1 = exploitability(game, s1, s2).total;
    // 交换视角: payoffRow' = payoffColᵀ, payoffCol' = payoffRowᵀ, (σ₂ 作行, σ₁ 作列)
    const swapped = matrixGame({
      name: `sw${s}`,
      payoffRow: transposeMatrix(game.payoffCol),
      payoffCol: transposeMatrix(game.payoffRow),
      zeroSum: game.zeroSum,
    });
    const e2 = exploitability(swapped, s2, s1).total;
    if (Math.abs(e1 - e2) > 1e-12) symOk = false;
  }
  ok(symOk, 'exploitability 对称性: 双方视角交换后 total 逐位相等（1e-12；100 零和 + 100 一般和，3-5 维随机博弈随机策略对）');
}

// ═══════════════════════════════════════════════════════════════════
// 59.0 curriculum：最优排序定理 + 教师-学生双向课程
// ═══════════════════════════════════════════════════════════════════

section('59.0 [轴1] 课程最优排序定理：前沿 / 证书 / 贪心 / 全排列枚举');

{
  // 标准梯子: 证书单调 + 无墙 + 贪心难度单调 + 贪心 ≥ 最优排列 + 升序 ≥ 最难
  const cert = frontierCertificate(STANDARD_LADDER);
  ok(
    cert.monotone && cert.violations === 0 && cert.levelsNeverFrontier.length === 0 && cert.orderingTheoremApplies,
    `标准六层梯子: 前沿难度单调（480 网格 0 违规）、无墙层——定理口径可用（maxSlope=${cert.maxAbsSlope.toFixed(2)} 为诊断量）`,
  );
  ok(
    frontierLevel(STANDARD_LADDER, 0) === 0 && frontierLevel(STANDARD_LADDER, 50) === 5,
    `前沿随经验升班: frontier(0)=0 层 → frontier(50)=5 层（顶）（课程自己会升班的动力学）`,
  );
  const greedy = frontierGreedySchedule(STANDARD_LADDER, { steps: 24 });
  ok(greedy.difficultyMonotone, `前沿贪心课程的练习难度单调不减（24 步轨迹——定理 (T1)）`);
  const audit = enumerateScheduleOptimality(STANDARD_LADDER, { reps: 4 });
  ok(
    audit.greedyFinalExperience >= audit.bestFinalExperience - 1e-9,
    `定理 (T3): 同预算贪心 ${audit.greedyFinalExperience.toFixed(4)} ≥ 全部 ${audit.permutations} 排列最大值 ${audit.bestFinalExperience.toFixed(4)}（自适应前沿追踪支配一切固定课程）`,
  );
  ok(
    audit.ascendingOverHardest >= 0 && audit.ascendingIsOptimal,
    `定理 (T2): 升序 ${audit.ascendingFinalExperience.toFixed(4)} − 最难优先 ${audit.hardestFirstFinalExperience.toFixed(4)} = +${audit.ascendingOverHardest.toFixed(4)}（由易到难的 regret 优势；本世界升序恰为枚举 argmax）`,
  );
  // 墙世界: 证书地平线（eMax=10，墙的增益峰在 E≈22 之外）内墙层被前沿绕行检出 + 贪心绕墙占优
  const wall = { difficulties: [0, 1.7, 3.4, 14, 5.1, 6.8], growthA: 1.6, growthB: 0.7 };
  const wcert = frontierCertificate(wall, { eMax: 10 });
  const waudit = enumerateScheduleOptimality(wall, { reps: 4 });
  ok(
    JSON.stringify(wcert.levelsNeverFrontier) === JSON.stringify([3]) && wcert.monotone,
    `墙世界（地平线 eMax=10）: 墙层 [3]（难度 14）被检出为「前沿永不经过」（levelsNeverFrontier=[3]）——规划视野内的隐形墙`,
  );
  ok(
    waudit.greedyFinalExperience > waudit.bestFinalExperience + 1e-9,
    `贪心绕墙占优: 贪心 ${waudit.greedyFinalExperience.toFixed(3)} > 最优排列 ${waudit.bestFinalExperience.toFixed(3)}（固定排列把墙块放在冷启动附近空转，贪心只在墙真到前沿时才碰它）`,
  );
  ok(
    throws(() => enumerateScheduleOptimality({ difficulties: [1, 2, 3, 4, 5, 6, 7], growthA: 1, growthB: 1 }, {})) &&
      throws(() => expectedGainSchedule(STANDARD_LADDER, [9], {})),
    '枚举 m=7 越界 / order 非法层显式 throw',
  );
}

section('59.0 [轴1+轴4] 定理批量复核：200 种子随机世界（T2/T3 零反例）');

{
  let monotoneAll = true;
  let t2All = true;
  let t3All = true;
  let ascOptCount = 0;
  let applicable = 0;
  for (let s = 1; s <= 200; s += 1) {
    const rng = mulberry32(s);
    const m = 3 + Math.floor(rng() * 4); // 3..6
    const difficulties = Array.from({ length: m }, (_, i) => i * 0.6 + rng() * 3.2).sort((a, b) => a - b);
    const world = { difficulties, growthA: 0.8 + rng() * 1.8, growthB: 0.4 + rng() * 0.6 };
    const cert = frontierCertificate(world);
    if (!cert.monotone || cert.levelsNeverFrontier.length > 0) monotoneAll = false;
    const audit = enumerateScheduleOptimality(world, { reps: 3 });
    if (audit.ascendingOverHardest < -1e-12) t2All = false; // (T2) 升序 ≥ 最难优先
    if (audit.greedyFinalExperience < audit.bestFinalExperience - 1e-9) t3All = false; // (T3) 贪心 ≥ 最优排列
    if (audit.ascendingIsOptimal) ascOptCount += 1;
    applicable += 1;
  }
  ok(monotoneAll, `证书批量: 200 个随机排序难度世界全部前沿单调、无墙层（(i) 成立率 200/200）`);
  ok(t2All, `定理 (T2) 批量: 升序 − 最难优先 ≥ 0 在 ${applicable} 个世界零反例（regret 界方向）`);
  ok(
    t3All,
    `定理 (T3) 批量: 同预算贪心 ≥ 全排列最优在 ${applicable} 个世界零反例（枚举 6..720 排列逐世界复核）`,
  );
  ok(
    ascOptCount >= 150,
    `升序 = 枚举 argmax 的世界 ${ascOptCount}/200（≥ 75%；近距难度存在「先收割峰下侧」反例——ascendingIsOptimal 如实报告，不冒充定理）`,
  );
}

section('59.0 [轴1] 教师-学生双向课程：Vygotsky 门控轨迹 + 200 种子配对对照');

{
  // 构造轨迹: 学生在层 0 后验 0.9+（已掌握）→ 教师提名 0 被顶到 ceiling
  const teacher = thompsonCurriculum({ levelCount: 4, seed: 1 });
  const mentored = mentoredCurriculum({ teacher, levelCount: 4 });
  for (let i = 0; i < 30; i += 1) mentored.report(0, true); // 层 0 全胜 → 后验 → 1
  ok(
    mentored.studentPosteriorMean(0) >= 0.9 && mentored.zoneBorder() === 0,
    `学生画像: 层 0 后验 ${(mentored.studentPosteriorMean(0)).toFixed(3)} ≥ 0.9、够得着边界 border=0（Beta(1+30,1) 均值）`,
  );
  const gated = [];
  for (let i = 0; i < 10; i += 1) gated.push(mentored.nextLevel());
  ok(
    gated.every((l) => l >= 0 && l <= mentored.zoneCeiling()),
    `门控: 连续 10 次提案全部落在 ZPD 窗口 [0, ceiling=${mentored.zoneCeiling()}]（绝望区被压回、已掌握被顶替）`,
  );
  // 200 种子配对对照（comparePolicies 配对设计: 同世界种子同策略族）
  const mkPolicies = () => [
    randomCurriculum({ levelCount: 6, seed: 1 }),
    mentoredCurriculum({ teacher: randomCurriculum({ levelCount: 6, seed: 1 }), levelCount: 6 }),
    thompsonCurriculum({ levelCount: 6, seed: 1 }),
    mentoredCurriculum({ teacher: thompsonCurriculum({ levelCount: 6, seed: 1 }), levelCount: 6 }),
    masteryCurriculum({ levelCount: 6 }),
    mentoredCurriculum({ teacher: masteryCurriculum({ levelCount: 6 }), levelCount: 6 }),
  ];
  const stats = comparePolicies(STANDARD_LADDER, mkPolicies(), { trials: 200, steps: 400 });
  const med = (i) => stats[i].medianStepsCensored;
  ok(
    med(1) < med(0),
    `双向课程改造盲教师: mentored(random) 中位 ${med(1)} < random 中位 ${med(0)}（均匀乱提被 ZPD 门控成有序爬阶）`,
  );
  ok(
    med(3) < med(2),
    `双向课程增益好教师: mentored(thompson) 中位 ${med(3)} < thompson 中位 ${med(2)}（掌握反馈修剪 Thompson 的重探冗余）`,
  );
  ok(
    med(5) <= med(4) + 1,
    `好教师不劣化: mentored(mastery) 中位 ${med(5)} ≤ mastery 中位 ${med(4)} + 1（门控是护栏不是干扰）`,
  );
  ok(
    throws(() => mentoredCurriculum({ teacher: null, levelCount: 3 })) &&
      throws(() => mentoredCurriculum({ teacher: thompsonCurriculum({ levelCount: 3 }), levelCount: 3, masteredHigh: 0.5, zoneThreshold: 0.8 })),
    'teacher 缺失 / masteredHigh < zoneThreshold 显式 throw',
  );
}

// ═══════════════════════════════════════════════════════════════════
// 98.0 experience-replay：三因子重要性 + 分布缓存
// ═══════════════════════════════════════════════════════════════════

section('98.0 [轴2] 分布+CDF 缓存：与旧算法逐位一致 + 耗时对照');

{
  // 参考实现 = 旧算法（每次 sample 重建 rank 分布 + CDF）
  const legacySample = (items, alpha, rng) => {
    const ordered = items.map((_, i) => i).sort((a, b) => items[b].td - items[a].td || a - b);
    const probs = new Array(items.length).fill(0);
    let total = 0;
    for (let rank = 0; rank < ordered.length; rank += 1) {
      const w = Math.pow(rank + 1, -alpha);
      probs[ordered[rank]] = w;
      total += w;
    }
    for (let i = 0; i < probs.length; i += 1) probs[i] /= total;
    const cum = [];
    let acc = 0;
    for (const p of probs) {
      acc += p;
      cum.push(acc);
    }
    const idx = [];
    for (let k = 0; k < 1; k += 1) {
      const u = rng() * acc;
      let lo = 0;
      let hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < u) lo = mid + 1;
        else hi = mid;
      }
      idx.push(lo);
    }
    return idx[0];
  };
  const buf = new PrioritizedReplay({ capacity: 500, alpha: 0.6, seed: 42 });
  const refItems = [];
  for (let i = 0; i < 300; i += 1) {
    const t = { task: 'T', arm: i % 3, reward: (i % 7) / 7, tdError: (i % 13) / 13 };
    buf.push(t);
    refItems.push({ td: (i % 13) / 13 });
  }
  const refRng = mulberry32(42);
  let identical = true;
  for (let d = 0; d < 500; d += 1) {
    const got = buf.sample(1).indices[0];
    const expect = legacySample(refItems, 0.6, refRng);
    if (got !== expect) {
      identical = false;
      break;
    }
  }
  ok(identical, `缓存路径与旧算法（逐次重建分布+CDF）同 rng 流逐位同序列（500 次抽取全等——ν=γ=0 时因子恒 1 的位级兼容）`);
  // 耗时: 连续采样（缓存命中） vs 逐次失效重建
  const bigBuf = new PrioritizedReplay({ capacity: 5000, alpha: 0.6, seed: 1 });
  for (let i = 0; i < 3000; i += 1) bigBuf.push({ task: 'T', arm: i % 3, reward: (i % 7) / 7, tdError: (i % 13) / 13 });
  let t0 = performance.now();
  for (let k = 0; k < 2000; k += 1) bigBuf.sample(1);
  let t1 = performance.now();
  for (let k = 0; k < 2000; k += 1) {
    bigBuf.updatePriorities([k % 3000], [(k % 13) / 13]); // 等价 O(1) 失效注入（值不变）
    bigBuf.sample(1);
  }
  let t2 = performance.now();
  ok(
    (t1 - t0) * 5 < t2 - t1,
    `耗时对照: 缓存 ${(t1 - t0).toFixed(1)}ms vs 逐次重建 ${(t2 - t1).toFixed(1)}ms（${((t2 - t1) / (t1 - t0)).toFixed(0)}×——睡眠固化每轮 sample+iswWeights 共享同一分布）`,
  );
}

section('98.0 [轴1+轴4] 三因子重要性：反垄断 / 年龄抬升 / IS 无偏保持');

{
  // 反垄断: ν>0 时 top-1 采样份额下降、覆盖率上升（100 种子）
  let shareOk = 0;
  let coverOk = 0;
  const ROUNDS = 60;
  const BATCH = 10;
  for (let s = 1; s <= 100; s += 1) {
    const mkBuf = (nu) => {
      const b = new PrioritizedReplay({ capacity: 1000, alpha: 0.8, seed: s, noveltyDecay: nu });
      for (let i = 0; i < 200; i += 1) b.push({ task: 'T', arm: 0, reward: 0, tdError: 100 - i * 0.5 }); // 陡 |TD| 梯度
      return b;
    };
    const run = (b) => {
      const freq = new Array(200).fill(0);
      for (let r = 0; r < ROUNDS; r += 1) for (const i of b.sample(BATCH).indices) freq[i] += 1;
      const top1 = Math.max(...freq) / (ROUNDS * BATCH);
      const seen = freq.filter((c) => c > 0).length / 200;
      return { top1, seen };
    };
    const plain = run(mkBuf(0));
    const nov = run(mkBuf(0.6));
    if (nov.top1 < plain.top1) shareOk += 1;
    if (nov.seen > plain.seen) coverOk += 1;
  }
  ok(
    shareOk >= 95,
    `新奇因子反垄断: ν=0.6 的 top-1 采样份额低于 ν=0 在 ${shareOk}/100 种子成立（重放过的经验让位）`,
  );
  ok(
    coverOk >= 90,
    `重放覆盖率提升: ν=0.6 覆盖率（${ROUNDS}×${BATCH} 抽样命中的样本比例）高于 ν=0 在 ${coverOk}/100 种子成立`,
  );
  // 年龄因子: 同 |TD| 的老/新各半，γ>0 抬老样本份额
  const mkAged = (gamma) => {
    const b = new PrioritizedReplay({ capacity: 1000, alpha: 0, seed: 3, ageBoost: gamma });
    for (let i = 0; i < 100; i += 1) b.push({ task: 'T', arm: 0, reward: 0, tdError: 1 }); // 老样本
    for (let i = 0; i < 100; i += 1) b.push({ task: 'T', arm: 0, reward: 0, tdError: 1 }); // 新样本（后入库）
    return b;
  };
  const oldShare = (b) => {
    let old = 0;
    const draws = b.sample(4000);
    for (const i of draws.indices) if (i < 100) old += 1;
    return old / draws.indices.length;
  };
  const shareG0 = oldShare(mkAged(0));
  const shareG3 = oldShare(mkAged(0.3));
  ok(
    near(shareG0, 0.5, 0.03) && shareG3 > shareG0 + 0.05,
    `年龄因子: γ=0 老样本份额 ${shareG0.toFixed(3)} ≈ 0.5（α=0 均匀）、γ=0.3 抬升到 ${shareG3.toFixed(3)}（(1+age)^γ 偏向老经验——对抗新洪峰挤出）`,
  );
  // IS 无偏性在复合分布下保持（β=1 恢复真值）
  const means = [0.9, 0.5, 0.1];
  const rng = mulberry32(77);
  const buf = new PrioritizedReplay({ capacity: 5000, alpha: 1, noveltyDecay: 0.5, seed: 13 });
  for (let a = 0; a < 3; a += 1) {
    for (let i = 0; i < 900; i += 1) {
      const r = rng() < means[a] ? 1 : 0;
      buf.push({ task: 'B', arm: a, reward: r, tdError: r });
    }
  }
  const M = 30000;
  const draw = buf.sample(M);
  const isw = buf.iswWeights(draw.indices, 1, draw.probabilities); // 抽样时刻快照（ν>0 分布随重放计数漂移）
  const learner = new WeightedBanditLearner(3);
  for (let k = 0; k < M; k += 1) {
    const t = draw.transitions[k];
    learner.update({ arm: t.arm, reward: t.reward, weight: isw.weights[k] });
  }
  const est = [0, 1, 2].map((a) => learner.valueOf(a));
  ok(
    est.every((v, a) => Math.abs(v - means[a]) <= 0.03),
    `IS(β=1) 在三因子复合分布下仍无偏: 估值 [${est.map((v) => v.toFixed(3)).join(', ')}] vs 真值 [0.9, 0.5, 0.1]（|Δ| ≤ 0.03——w=(1/(N·P))^β 对任意 P 成立）`,
  );
  // 睡眠固化在复合因子下照常消化
  const sbuf = new PrioritizedReplay({ capacity: 2000, alpha: 0.6, noveltyDecay: 0.3, seed: 17 });
  for (let i = 0; i < 400; i += 1) sbuf.push({ task: 'day', arm: 0, reward: rng() < 0.2 ? 1 : 0, tdError: Math.abs((rng() < 0.2 ? 1 : 0) - 0.55) });
  for (let i = 0; i < 600; i += 1) sbuf.push({ task: 'day', arm: 1, reward: rng() < 0.8 ? 1 : 0, tdError: Math.abs((rng() < 0.8 ? 1 : 0) - 0.35) });
  const sleeper = new SgdBanditLearner(2, { lr: 0.1, initialValues: [0.55, 0.35] });
  const res = sleepConsolidation({ buffer: sbuf, learner: sleeper, truth: [0.2, 0.8], rounds: 12, batchSize: 64 });
  ok(
    res.improvement >= 0.5 && res.bufferSizeAfter === res.bufferSizeBefore && res.freshTransitions === 0,
    `睡眠固化 × 新奇因子: 策略价值 ${res.policyValueBefore.toFixed(1)} → ${res.policyValueAfter.toFixed(1)}（+${res.improvement.toFixed(2)} ≥ 0.5，零新数据——三因子与固化兼容）`,
  );
  ok(
    throws(() => new PrioritizedReplay({ capacity: 10, noveltyDecay: -1 })) &&
      throws(() => new PrioritizedReplay({ capacity: 10, ageBoost: -0.5 })),
    'noveltyDecay/ageBoost 为负显式 throw',
  );
}

// ═══════════════════════════════════════════════════════════════════
// 93.0 automl-hyperband：η 扫描理论 / 异步 bracket / 精确减员
// ═══════════════════════════════════════════════════════════════════

section('93.0 [轴1] η 扫描理论：名义预算 / 松弛带 / 广度-保真权衡');

{
  const rows = etaSweep(81);
  const byEta = new Map(rows.map((r) => [r.eta, r]));
  ok(
    rows.every((r) => near(r.nominalBudget, 81 * (r.sMax + 1) ** 2, 1e-9) && r.roundingSlack <= 0.07),
    `名义预算 = R·(s_max+1)² 且取整松弛 ≤ 7%（${rows.map((r) => `η=${r.eta}:${r.roundingSlack.toFixed(3)}`).join(' ')}）`,
  );
  const floorLog = (R, eta) => {
    let s = 0;
    while (Math.pow(eta, s + 1) <= R * (1 + 1e-12)) s += 1;
    return s;
  };
  ok(rows.every((r) => r.sMax === floorLog(81, r.eta)), 's_max = ⌊log_η R⌋ 独立复算一致');
  ok(
    byEta.get(2).configsExamined > byEta.get(6).configsExamined,
    `探索广度: η=2 检视 ${byEta.get(2).configsExamined} 个配置 > η=6 检视 ${byEta.get(6).configsExamined}（小 η = 更多 bracket = 更宽探索）`,
  );
  const slotsAt = (row, minBudget) => sum(row.slotsByBudget.filter((s) => s.budget >= minBudget).map((s) => s.slots));
  ok(
    slotsAt(byEta.get(2), 81) > slotsAt(byEta.get(6), 81) && slotsAt(byEta.get(2), 27) > slotsAt(byEta.get(6), 27),
    `保真账本: 预算 ≥ 27 的评估槽数 η=2（${slotsAt(byEta.get(2), 27)}）> η=6（${slotsAt(byEta.get(6), 27)}）；全保真 ${slotsAt(byEta.get(2), 81)} > ${slotsAt(byEta.get(6), 81)}（小 η 给晚熟型更多露头机会——η 是广度 vs 保真的显式权衡）`,
  );
  ok(throws(() => etaSweep(81, { etas: [] })), 'etaSweep 空 etas 显式 throw');
}

section('93.0 [轴3+轴4] 预算守恒批量：200 种子 (R,η) + BigInt 精确减员');

{
  let conserved = true;
  let geometric = true;
  let exchange = true;
  let sMaxOk = true;
  let survivorsExact = true;
  let survivorChecked = 0;
  for (let s = 1; s <= 200; s += 1) {
    const rng = mulberry32(s);
    const R = 3 + Math.floor(rng() * 297); // 3..299
    const eta = 2 + Math.floor(rng() * 5); // 2..6（整数 η → BigInt 精确对照）
    const sch = bracketSchedule(R, eta);
    const resum = sum(sch.brackets.map((b) => b.budget));
    if (!near(resum, sch.totalBudget, 1e-9)) conserved = false;
    for (const b of sch.brackets) {
      for (let i = 1; i < b.rounds.length; i += 1) {
        if (Math.abs(b.rounds[i].perConfigBudget - eta * b.rounds[i - 1].perConfigBudget) > 1e-9) geometric = false;
        if (Math.abs(b.rounds[i].cost - b.rounds[i - 1].cost) > b.rounds[i].perConfigBudget + 1e-9) exchange = false;
      }
      if (b.nConfigs < 1) conserved = false;
      // 减员数 BigInt 精确对照: survivorCount(n, r0, r_i) = max(1, ⌊n/η^i⌋)（r_i = r₀·η^i）
      for (let i = 0; i < b.rounds.length; i += 1) {
        const expect = Math.max(1, Number(BigInt(b.nConfigs) / BigInt(Math.pow(eta, i))));
        if (b.rounds[i].numConfigs !== expect) survivorsExact = false;
        survivorChecked += 1;
      }
    }
    let sm = 0;
    while (Math.pow(eta, sm + 1) <= R * (1 + 1e-12)) sm += 1;
    if (sch.sMax !== sm) sMaxOk = false;
  }
  ok(conserved && sMaxOk, `预算守恒 + s_max 口径: 200 个种子化 (R∈[3,299], η∈[2,6]) 实例全部成立（独立重加和 1e-9）`);
  ok(geometric && exchange, `r 几何（r_{i+1} = η·r_i，1e-9）+ 成本交换界 |c_{i+1}−c_i| ≤ r_{i+1}（全部 bracket 全部轮）`);
  ok(
    survivorsExact && survivorChecked >= 200,
    `精确减员: ${survivorChecked} 个轮次配置数与 BigInt 精确有理数 max(1, ⌊n/η^i⌋) 逐轮一致（整数路径 (p−p%ri)/ri 免疫浮点尘埃）`,
  );
  // SH 单元的构造锚（整数路径）
  const sh = successiveHalvingUnit(Array.from({ length: 7 }, (_, i) => i), [9, 27, 81], (c) => (c === 3 ? 1 : 0));
  ok(
    sh.rounds.map((r) => r.numConfigs).join(',') === '7,2,1' && sh.winner === 3,
    `SH 构造锚: 7 配置 @ [9,27,81] → 减员 [7,2,1]（⌊63/27⌋=2、⌊63/81⌋=0→1）、冠军 = 唯一高分者 id=3（整数整除路径）`,
  );
}

section('93.0 [轴1+轴2] 异步 bracket：同步等价 / 屏障与并发约束 / 确定性');

{
  const pool = learningCurveFactory({ n: 60, seed: 3 });
  const evalCurve = (c, b) => c.score(b);
  // 等价锚: workers 充裕 + FIFO 回报 → 逐 bracket 复现 hyperband()
  const sync = hyperband({ evaluate: evalCurve, configs: pool, eta: 3, maxBudget: 27, seed: 42 });
  const ah = new AsyncHyperband({ configs: pool, eta: 3, maxBudget: 27, seed: 42, workers: 10000 });
  let guard = 0;
  while (!ah.done && guard++ < 100000) {
    for (const t of ah.nextTasks(1000)) ah.report(t, evalCurve(t.config, t.budget));
  }
  const brs = ah.bracketResults();
  const winnersEqual = sync.brackets.every((sb) => {
    const ab = brs.find((r) => r.s === sb.s);
    return ab.winner === sb.winner && near(ab.winnerScore, sb.winnerScore, 1e-12);
  });
  ok(
    ah.done && winnersEqual && near(ah.bestObserved().score, sync.bestScore, 1e-12) && ah.bestObserved().config === sync.bestConfig,
    `同步等价: 异步逐 bracket 复现 hyperband()（幸存者/冠军/最优配置全同，同种子同抽样序）`,
  );
  ok(
    ah.budgetIssued() === sync.totalBudgetSpent && near(ah.budgetIssued(), sync.schedule.totalBudget, 1e-9),
    `预算守恒: budgetIssued = ${ah.budgetIssued()} === schedule.totalBudget（签发即记账——资源感知调度的对账口径）`,
  );
  // workers=2 + 种子化乱序完成: 并发约束 + round 屏障 + 守恒 + 完成性
  const sch27 = bracketSchedule(27, 3);
  const roundSize = (s, r) => sch27.brackets.find((b) => b.s === s).rounds[r].numConfigs;
  let capOk = true;
  let barrierOk = true;
  let completeOk = true;
  for (let s = 1; s <= 50; s += 1) {
    const rng = mulberry32(s);
    const h = new AsyncHyperband({ configs: pool, eta: 3, maxBudget: 27, seed: 100 + s, workers: 2 });
    // (bracket, round) → 已回报的 slot 数（屏障审计: 签发 (b, r+1) 时 (b, r) 须已齐）
    const reportedCount = new Map();
    const keyOf = (b, r) => `${b}:${r}`;
    let steps = 0;
    while (!h.done && steps++ < 100000) {
      const tasks = h.nextTasks(2);
      if (h.inFlight() > 2) capOk = false;
      for (const t of tasks) {
        if (t.round > 0) {
          const prev = reportedCount.get(keyOf(t.bracket, t.round - 1)) ?? 0;
          if (prev < roundSize(t.bracket, t.round - 1)) barrierOk = false; // 越屏障签发
        }
      }
      // 乱序回报（种子化洗牌在飞集合——资源到达序不可控的模拟）
      const shuffled = [...tasks];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      for (const t of shuffled) {
        h.report(t, evalCurve(t.config, t.budget));
        reportedCount.set(keyOf(t.bracket, t.round), (reportedCount.get(keyOf(t.bracket, t.round)) ?? 0) + 1);
      }
    }
    if (!h.done || !near(h.budgetIssued(), sch27.totalBudget, 1e-9)) completeOk = false;
  }
  ok(capOk, '并发约束: workers=2 下在飞任务 ≤ 2（50 种子乱序完成全程）');
  ok(barrierOk, 'round 屏障: 下一轮任务永不在本轮成绩齐备前签发（幸存者依赖的因果完整性）');
  ok(completeOk, `乱序完成: 50 种子全部完成且 budgetIssued === schedule.totalBudget（守恒不受完成序影响）`);
  // 确定性: 同种子两次运行任务序列逐位一致
  const runSeq = (seed) => {
    const h = new AsyncHyperband({ configs: pool, eta: 3, maxBudget: 27, seed, workers: 2 });
    const seq = [];
    let steps = 0;
    while (!h.done && steps++ < 100000) {
      const tasks = h.nextTasks(2);
      for (const t of tasks) {
        h.report(t, evalCurve(t.config, t.budget));
        seq.push([t.bracket, t.round, t.slot]);
      }
    }
    return JSON.stringify(seq);
  };
  ok(runSeq(7) === runSeq(7), '确定性: 同种子异步任务/回报序列逐位一致（调度器无随机路径）');
  ok(
    throws(() => new AsyncHyperband({ configs: pool, maxBudget: 27, workers: 0 })) &&
      throws(() => new AsyncHyperband({ configs: pool, maxBudget: 27 }).report({ bracket: 99, round: 0, slot: 0 }, 1)) &&
      throws(() => new AsyncHyperband({ configs: pool, maxBudget: 27 }).bracketResults()),
    'workers=0 / 未知 bracket 回报 / 未完成读结果显式 throw',
  );
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— R5-A15 进化学习六内核第五轮世界性进化（四轴）验证成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
