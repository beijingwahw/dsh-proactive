/**
 * verify-r5-topology.mjs — R5-A12 拓扑动力六内核第五轮进化纯数学离线验证
 *
 * 覆盖内核（旧→新的「新」侧全部有解析对照或确定性计量，不是「能跑」，是「算得对」）:
 *   36.0 持续同调（R5: H₁ 代表圈 + clearing 加速）
 *     · H₁ 解析小图: 方框+对角线 2 条有限 H₁ 条（含 (0.9,0.5) 与零长条
 *       (0.5,0.5)）、纯方框 essential 1 条 + 代表圈逐边在图；
 *     · clearing = 朴素全矩阵消元（60 随机图逐条对照——等价性证明的实证侧），
 *       消元次数 clearing ≤ matrix（三角列阶段两引擎逐位同构, matrix 额外
 *       消元顶点/边列——确定性计量而非墙钟）;
 *     · Euler–Poincaré: χ = V−E+F = β₀−β₁+β₂ —— 24 点圆周（带三角剖分）
 *       β₂=0 精确成立; K4 截断复形 β₂=1（2-球面边界——dim≤2 截断的诚实边界）;
 *     · 圆环 80 点 essential H₁ = 1（洞的代表圈）; β₀ 与 h0Persistence 互证;
 *     · 瓶颈距离度量公理（自反/对称/三角不等式, 200 种子随机持久图）。
 *   69.0 Mapper（R5: 分位数覆盖 + 网格加速）
 *     · quantileCover: 核心秩窗口无重无漏拼满 [0,n)、相邻纤维共享秩、偏斜
 *       值域下纤维规模 max/min ≤ 2（等宽覆盖 > 5 倍失衡的对照）、平局确定性;
 *     · balanced 口径圆环仍恰 1 环 / 高斯团仍 2 分量（拓扑不因覆盖口径漂移）;
 *     · singleLinkageFast = singleLinkage（多种子/维度/eps 逐位一致, 含 eps=0、
 *       自定义度量与 4 维回退）+ n=2000 耗时对照。
 *   38.0 非线性动力学（R5: Wolf 法）
 *     · logistic r=4: λ₁ ≈ ln2（Rosenstein 同系列对照）; 周期窗 r=3.2/3.5:
 *       λ₁ ≈ 0; r=2.5 吸引子塌缩 → undefined（诚实报告而非假数）;
 *     · 参数扫描 200 输入（40 r × 5 种子）: 阈值化混沌判定与解析轨迹平均
 *       逐点对符号一致率 ≥ 95%; 全程 log 域（重复值零分离步不产生 NaN）。
 *   76.0 新奇检测（R5: LOF + 半空间深度）
 *     · 完美网格内点 LOF = 1（精确锚点）; 双密度世界: 孤立外点 LOF ≫ 两簇
 *       内点最大 LOF（稀疏簇不被全局口径误伤）, lofAUC = 1;
 *     · 对称注入 200 种子: LOF(注入点) > max LOF(内点) 的种子占比 ≥ 95%;
 *     · Tukey 深度: 中位 ≈ 0.5、单调远离中心、出值域 = 0。
 *   91.0 新奇搜索（R5: 档案密度控制精简）
 *     · 合成均匀行为空间 15 种子: density 档案平均最近邻距 > random（≥12/15
 *       种子占优）——同样的面包屑预算铺得更开;
 *     · 欺骗迷宫 30 种子诚实对照表: 两策略成功率同档（≥ 0.8）, density 成功
 *       时平均首解代数更短; 缺省 'random' 逐位向后兼容;
 *     · 描述子消融: 2D 行为描述子覆盖 ≫ 1D 投影（行为空间的特征化选择）。
 *   66.0 模拟退火（R5: 并行回火 + Luby 重启）
 *     · 并行回火: 副本平均能级随温度单调、交换率健康（断梯 → 0）、
 *       同总预算下 PT ≥ 单链几何降温 ≥≫ 贪心、逐位确定性;
 *     · Luby 序列精确前缀（1,1,2,1,1,2,4,…）+ annealWithRestarts 预算守恒、
 *       段最优单调非增、冻死几何链被重启救回。
 *
 * 全部断言确定性（内核/脚本自带 mulberry32, 种子固定, 同输入同输出）。
 * 运行: node --experimental-transform-types scripts/verify-r5-topology.mjs
 */

import {
  h1Persistence,
  complexBetti,
  h0Persistence,
  bottleneckDistance,
} from '../src/core/persistent-homology.ts';
import {
  buildMapper,
  quantileCover,
  intervalCover,
  singleLinkage,
  singleLinkageFast,
  annulus,
  blobs,
} from '../src/core/mapper-graph.ts';
import {
  wolfLyapunov,
  largestLyapunov,
  determinismScore,
} from '../src/core/nonlinear-dynamics.ts';
import {
  localOutlierFactor,
  lofAUC,
  halfspaceDepth1D,
  mulberry32,
  gaussianNoise,
} from '../src/core/novelty-detection.ts';
import {
  noveltySearch,
  deceptiveMaze,
  openFieldMaze,
} from '../src/core/novelty-search.ts';
import {
  parallelTempering,
  lubySequence,
  annealWithRestarts,
  anneal,
  tspInstance,
  tspAdjacentSwapNeighbor,
  tspTourLength,
  tspExactOptimum,
  wellDepth,
} from '../src/core/simulated-annealing.ts';

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
  } catch {
    passed += 1;
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${label}`);
}

// ═══════════════════ 36.0 持续同调: H₁ 代表圈 + clearing ═══════════════════

section('36.0 R5 · H₁ 解析小图: 方框/对角线/纯方框/K4 的生死档案');

{
  // 方框 + 对角线: 对角线出现时圈诞生, 三角形随后填死——2 条有限 H₁ 条
  const nodes = ['a', 'b', 'c', 'd'];
  const squareDiag = [
    { source: 'a', target: 'b', weight: 0.9 },
    { source: 'b', target: 'c', weight: 0.9 },
    { source: 'c', target: 'd', weight: 0.9 },
    { source: 'd', target: 'a', weight: 0.9 },
    { source: 'a', target: 'c', weight: 0.5 },
  ];
  const r = h1Persistence(nodes, squareDiag);
  ok(
    r.finiteBars === 2 && r.essentialBars === 0,
    `方框+对角线: 2 条有限 H₁ 条、0 essential（洞被两张三角形填死; 实测 finite=${r.finiteBars}, essential=${r.essentialBars}）`,
  );
  ok(
    r.bars.some((b) => near(b.birth, 0.9) && near(b.death, 0.5)) &&
      r.bars.some((b) => near(b.birth, 0.5) && near(b.death, 0.5)),
    `条权重 (0.9→0.5) 与零长条 (0.5→0.5) 各一（${r.bars.map((b) => `${b.birth}→${b.death}`).join('; ')}——对角线自身闭合成圈又立刻被填）`,
  );
  ok(
    r.bars.every((b) => b.killedBy !== undefined && b.killedBy.length === 3),
    '填死方（killedBy）逐条给出三角形三顶点',
  );

  // 纯方框: essential H₁ = 1, 代表圈是图上的真实环
  const squareOnly = squareDiag.slice(0, 4);
  const r2 = h1Persistence(nodes, squareOnly);
  const essBar = r2.bars.find((b) => b.essential);
  ok(
    r2.essentialBars === 1 && essBar !== undefined,
    `纯方框: essential H₁ 恰 1（圈永不被填死——无三角形）`,
  );
  const edgeSet = new Set(squareOnly.map((e) => [e.source, e.target].sort().join('|')));
  const cycleOk =
    essBar !== undefined &&
    essBar.representative.length >= 3 &&
    essBar.representative.every((v, i) => edgeSet.has([v, essBar.representative[(i + 1) % essBar.representative.length]].sort().join('|')));
  ok(
    cycleOk,
    `代表圈 [${essBar ? essBar.representative.join('→') : '—'}→闭合] 每条边都在输入图里（可定位的洞边界成员）`,
  );

  // K4: dim ≤ 2 截断复形的诚实边界——β₂ = 1（2-球面边界, 无 3-单纯形填充）
  const k4 = complexBetti(['a', 'b', 'c', 'd'], [
    { source: 'a', target: 'b', weight: 0.9 },
    { source: 'a', target: 'c', weight: 0.9 },
    { source: 'a', target: 'd', weight: 0.9 },
    { source: 'b', target: 'c', weight: 0.9 },
    { source: 'b', target: 'd', weight: 0.9 },
    { source: 'c', target: 'd', weight: 0.9 },
  ]);
  ok(
    k4.chi === 2 && k4.beta0 === 1 && k4.beta1 === 0 && k4.beta2 === 1,
    `K4 截断复形: χ = 4−6+4 = 2 = β₀−β₁+β₂（β₂=1——四张三角面围成的 2-球面, Z₂ 口径诚实呈现）`,
  );

  // 入参校验
  throws(() => h1Persistence([], []), '空节点表显式 throw');
  throws(() => h1Persistence(['a'], [{ source: 'a', target: 'z', weight: 1 }]), '边端点不在节点表显式 throw');
  throws(() => h1Persistence(['a', 'b'], [{ source: 'a', target: 'b', weight: NaN }]), 'NaN 权重显式 throw');
  throws(() => h1Persistence(['a', 'b'], [], { engine: 'fast' }), "未知 engine 'fast' 显式 throw");
  throws(() => h1Persistence(['a', 'b'], [{ source: 'a', target: 'b', weight: 0.9 }], { floor: -1 }), '负 floor 显式 throw');
}

section('36.0 R5 · Euler–Poincaré 一致性 + 圆环洞的代表圈 + β₀ 互证');

{
  // 24 点圆周（等距, 半径 1）: 1 跳/2 跳弦 → 带三角剖分的 S¹
  const n = 24;
  const ids = Array.from({ length: n }, (_, i) => `v${i}`);
  const xy = ids.map((_, i) => [Math.cos((2 * Math.PI * i) / n), Math.sin((2 * Math.PI * i) / n)]);
  const edges = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const d = Math.hypot(xy[i][0] - xy[j][0], xy[i][1] - xy[j][1]);
      if (d < 0.55) edges.push({ source: ids[i], target: ids[j], weight: 1 - d / 2 });
    }
  }
  const cb = complexBetti(ids, edges, 1 - 0.55 / 2);
  ok(
    cb.faces > 0 && cb.chi === 0 && cb.beta0 === 1 && cb.beta1 === 1 && cb.beta2 === 0,
    `圆周 24 点（E=${cb.edges}, F=${cb.faces} 三角剖分）: χ = V−E+F = 0 = β₀−β₁+β₂（1−1+0）——Euler–Poincaré 精确成立`,
  );
  const rc = h1Persistence(ids, edges, { floor: 1 - 0.55 / 2 });
  const essBar = rc.bars.find((b) => b.essential);
  ok(
    rc.essentialBars === 1 && essBar !== undefined && essBar.representative.length >= 3,
    `圆周 essential H₁ = 1（洞跨尺度持久）, 代表圈 ${essBar ? essBar.representative.length : '—'} 节点`,
  );

  // 圆环 80 点（面均匀采样）: essential H₁ = 1, β₀ 与 h0Persistence 互证
  const ring = annulus(80, 1, 2, 7);
  const rids = ring.map((_, i) => `p${i}`);
  const redges = [];
  for (let i = 0; i < 80; i += 1) {
    for (let j = i + 1; j < 80; j += 1) {
      const d = Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
      if (d < 0.8) redges.push({ source: rids[i], target: rids[j], weight: 1 - d / 2 });
    }
  }
  const ra = h1Persistence(rids, redges);
  ok(
    ra.beta0 === 1 && ra.essentialBars === 1 && ra.finiteBars > 0,
    `圆环 80 点: β₀=1（连通）、essential H₁=1（中央洞）、${ra.finiteBars} 条短命有限条（带内瞬态圈被三角填死）`,
  );
  ok(
    ra.beta0 === h0Persistence(rids, redges, 0).islands.length,
    'β₀ 互证: h1Persistence 的并查集分量数 = h0Persistence 的 essential 分量数（两套独立实现同答）',
  );
  const ringEss = ra.bars.find((b) => b.essential);
  ok(
    ringEss !== undefined && ringEss.representative.length >= 4 &&
      ringEss.representative.every((v, i) =>
        redges.some((e) => {
          const w = ringEss.representative[(i + 1) % ringEss.representative.length];
          return (e.source === v && e.target === w) || (e.source === w && e.target === v);
        }),
      ),
    `圆环洞的代表圈 ${ringEss ? ringEss.representative.length : '—'} 节点逐边在图（好奇心想「去洞边」时的可定位成员）`,
  );
}

section('36.0 R5 · clearing 与朴素矩阵消元: 等价性 + 确定性计量（60 随机图）');

{
  let mismatches = 0;
  let opsLess = 0;
  let strictLess = 0;
  let h0CrossOk = 0;
  const t0 = Date.now();
  for (let s = 1; s <= 60; s += 1) {
    const rng = mulberry32(s * 7919);
    const n = 5 + Math.floor(rng() * 10);
    const nodes = Array.from({ length: n }, (_, i) => `v${i}`);
    const edges = [];
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        if (rng() < 0.5) edges.push({ source: `v${i}`, target: `v${j}`, weight: Math.round(rng() * 100) / 100 + 0.005 });
      }
    }
    const c = h1Persistence(nodes, edges, { engine: 'clearing' });
    const mtx = h1Persistence(nodes, edges, { engine: 'matrix' });
    const key = (b) => `${b.birth.toFixed(6)}>${b.death.toFixed(6)}:${b.essential}`;
    if (c.bars.map(key).sort().join('|') !== mtx.bars.map(key).sort().join('|')) mismatches += 1;
    if (c.beta0 !== mtx.beta0) mismatches += 1;
    if (c.reductionOps <= mtx.reductionOps) opsLess += 1;
    if (c.reductionOps < mtx.reductionOps) strictLess += 1;
    if (h0Persistence(nodes, edges, 0).islands.length === c.beta0) h0CrossOk += 1;
  }
  const dt = Date.now() - t0;
  ok(mismatches === 0, `60 随机图: 两引擎 H₁ 条 (birth,death,essential) 与 β₀ 逐条全同（0 处不一致——clearing 的等价性证明实证侧）`);
  ok(
    opsLess === 60 && strictLess >= 40,
    `消元计量: clearing ≤ matrix 60/60（其中严格更少 ${strictLess}/60）——三角列阶段两引擎逐位同构, matrix 额外消元顶点/边列（${dt}ms 全部跑完）`,
  );
  ok(h0CrossOk === 60, '60 随机图 β₀ 三方互证: clearing = matrix = h0Persistence（并查集折叠不改变 H₀ 配对——elder rule）');
  // 平局确定性: 打乱边输入序不改变输出（过滤序与输入序无关）
  const rng = mulberry32(12345);
  const nodes = Array.from({ length: 8 }, (_, i) => `u${i}`);
  const edges = [];
  for (let i = 0; i < 8; i += 1) {
    for (let j = i + 1; j < 8; j += 1) edges.push({ source: `u${i}`, target: `u${j}`, weight: Math.round(rng() * 4) / 4 + 0.1 });
  }
  const shuffled = [...edges];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const k = (b) => `${b.birth}>${b.death}:${b.essential}:${b.bornAt.join('-')}`;
  ok(
    h1Persistence(nodes, edges).bars.map(k).join('|') === h1Persistence(nodes, shuffled).bars.map(k).join('|'),
    '过滤平局确定性: 同权重边按 (维数, 字典序) 定序——打乱输入边序输出逐位不变',
  );
}

section('36.0 R5 · 瓶颈距离度量公理（200 种子随机持久图）');

{
  let bad = 0;
  for (let s = 1; s <= 200; s += 1) {
    const rng = mulberry32(s * 104729 + 7);
    const mk = () =>
      Array.from({ length: 3 + Math.floor(rng() * 6) }, () => ({
        birth: Math.round(rng() * 100) / 100,
        death: Math.round(rng() * 100) / 100,
      }));
    const A = mk();
    const B = mk();
    const C = mk();
    if (bottleneckDistance(A, A) !== 0 || bottleneckDistance(B, B) !== 0) bad += 1;
    const dAB = bottleneckDistance(A, B);
    const dBA = bottleneckDistance(B, A);
    if (Math.abs(dAB - dBA) > 1e-12) bad += 1;
    const dAC = bottleneckDistance(A, C);
    const dBC = bottleneckDistance(B, C);
    if (dAC > dAB + dBC + 1e-9) bad += 1;
  }
  ok(bad === 0, '自反性 d(A,A)=0、对称性 d(A,B)=d(B,A)、三角不等式 d(A,C) ≤ d(A,B)+d(B,C)——200 种子 0 违例（瓶颈距离是度量）');
}

// ═══════════════════ 69.0 Mapper: 分位数覆盖 + 网格加速 ═══════════════════

section('69.0 R5 · 分位数（平衡）覆盖: 秩窗口拼满 + 偏斜值域自适应 + 平局');

{
  // 对数正态偏斜值域: 等宽覆盖纤维爆/空 vs 平衡覆盖纤维均衡
  const rng = mulberry32(20261002);
  const skew = Array.from({ length: 600 }, () => Math.exp(gaussianNoise(rng) * 1.2));
  const qc = quantileCover(skew, 8, 0.3);
  ok(qc.length === 8, 'quantileCover 8 区间');
  const sizes = qc.map((q) => q.members.length);
  const coreSizes = qc.map((q) => q.endRank - q.startRank);
  ok(
    coreSizes.reduce((a, b) => a + b, 0) === 600 && coreSizes.every((c, i) => i === 0 || qc[i].startRank >= qc[i - 1].endRank),
    `核心秩窗口无重无漏拼满 [0,600)（${coreSizes.join('+')} = 600）`,
  );
  ok(
    Math.max(...sizes) / Math.min(...sizes) <= 2,
    `偏斜值域下平衡纤维规模 max/min = ${(Math.max(...sizes) / Math.min(...sizes)).toFixed(2)} ≤ 2（实测 [${Math.min(...sizes)}, ${Math.max(...sizes)}]）`,
  );
  // 等宽覆盖对照: 同值域等宽区间的纤维规模失衡
  const lo = Math.min(...skew);
  const hi = Math.max(...skew);
  const uni = intervalCover(lo, hi, 8, 0.3);
  const uniSizes = uni.map((iv, k) => skew.filter((v) => v >= iv.start && (k === 7 || v <= iv.end)).length);
  ok(
    Math.max(...uniSizes) / Math.min(...uniSizes) > 5,
    `同值域等宽覆盖纤维规模 max/min = ${(Math.max(...uniSizes) / Math.min(...uniSizes)).toFixed(1)} > 5（[${uniSizes.join(', ')}]——尾部区间白设, 密集区爆仓: 平衡覆盖的自适应对象）`,
  );
  // 相邻纤维共享（秩重叠 = 神经边的来源）
  let shared = 0;
  for (let k = 1; k < 8; k += 1) {
    const a = new Set(qc[k - 1].members);
    if (qc[k].members.some((m) => a.has(m))) shared += 1;
  }
  ok(shared === 7, `相邻纤维全部共享成员（7/7——神经边存在性的来源, 秩预算 2h = ⌊0.3·600/16⌋×2）`);
  // 平局确定性 + 全覆盖
  const ties = quantileCover([1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3], 4, 0.3);
  const allCovered = new Set();
  for (const q of ties) for (const m of q.members) allCovered.add(m);
  ok(
    allCovered.size === 12 && ties.every((q) => q.members.length >= 2) &&
      JSON.stringify(ties) === JSON.stringify(quantileCover([1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3], 4, 0.3)),
    `重值平局: 全覆盖（12/12）、无空纤维、两次调用逐位一致（排序键 (值, 下标)——秩确定）`,
  );
  throws(() => quantileCover([1, 2], 3, 0.3), 'intervals > 点数显式 throw（核心纤维必空拒绝虚设）');
  throws(() => quantileCover([1, 2, 3], 2, 0), 'overlap=0 显式 throw（开区间）');
  throws(() => quantileCover([1, 2, 3], 2, 1), 'overlap=1 显式 throw（开区间）');
  throws(() => quantileCover([1, NaN, 3], 2, 0.3), 'NaN 滤镜值显式 throw');
}

section('69.0 R5 · balanced 口径拓扑不漂移 + 网格加速等价/耗时');

{
  // 圆环: balanced 覆盖仍恰 1 环; 高斯团仍 2 分量
  for (const kind of ['uniform', 'balanced']) {
    const m = buildMapper({ points: annulus(300, 1, 2, 7), filter: (p) => p[1], intervals: 10, overlap: 0.3, clusterEps: 0.6, cover: kind });
    ok(
      m.stats.components === 1 && m.stats.cycleRank === 1 && m.stats.coverKind === kind,
      `圆环 300 点 ${kind} 口径: 1 分量 / 圈基 1（S¹ 同调不因覆盖口径漂移）`,
    );
  }
  const bal = buildMapper({ points: blobs(2, 150, 5, { sigma: 0.4 }), filter: (p) => p[1], intervals: 5, overlap: 0.3, clusterEps: 1, cover: 'balanced' });
  ok(
    bal.stats.components === 2 && bal.stats.cycleRank === 0 && bal.stats.coverage === 1,
    `高斯两团 balanced: 恰 2 分量 / 0 假环 / 覆盖 1（平衡覆盖也是全覆盖）`,
  );
  throws(
    () => buildMapper({ points: annulus(20, 1, 2, 3), filter: (p) => p[1], intervals: 5, overlap: 0.3, clusterEps: 1, cover: 'weird' }),
    "未知 cover 'weird' 显式 throw",
  );

  // 网格加速等价: 多种子/维度/eps 逐位一致（含 eps=0、自定义度量与 4 维回退）
  let eq = 0;
  let tot = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const rng = mulberry32(seed);
    for (const [n, dim] of [[50, 2], [200, 2], [300, 3], [120, 1], [60, 3]]) {
      const pts = Array.from({ length: n }, () => Array.from({ length: dim }, () => rng() * 4));
      for (const eps of [0.1, 0.5, 1.2, 0]) {
        tot += 1;
        if (JSON.stringify(singleLinkage(pts, eps)) === JSON.stringify(singleLinkageFast(pts, eps))) eq += 1;
      }
    }
  }
  const manhattan = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);
  const pts3 = Array.from({ length: 80 }, (_, i) => [i % 9, (i / 9) % 9, i % 5]);
  ok(
    eq === tot &&
      JSON.stringify(singleLinkageFast(pts3, 2, manhattan)) === JSON.stringify(singleLinkage(pts3, 2, manhattan)) &&
      JSON.stringify(singleLinkageFast(Array.from({ length: 12 }, (_, i) => [i, i, i, i]), 3)) === JSON.stringify(singleLinkage(Array.from({ length: 12 }, (_, i) => [i, i, i, i]), 3)),
    `网格加速逐位等价 ${eq}/${tot} + 自定义度量回退一致 + 4 维回退一致（d ≤ ε ⟹ 每维格号差 ≤ 1 的格论证）`,
  );
  throws(() => singleLinkageFast([[0], [1]], -1), 'singleLinkageFast eps<0 显式 throw');

  // 耗时对照（等价性之上才是性能）
  const rng2 = mulberry32(777);
  const big = Array.from({ length: 2000 }, () => [rng2() * 100, rng2() * 100]);
  const t0 = Date.now();
  const a = JSON.stringify(singleLinkage(big, 1.0));
  const t1 = Date.now();
  const b = JSON.stringify(singleLinkageFast(big, 1.0));
  const t2 = Date.now();
  ok(
    a === b && t2 - t1 <= 0.75 * (t1 - t0),
    `n=2000 耗时对照: 逐对 ${t1 - t0}ms → 网格 ${t2 - t1}ms（结果逐位一致, ≥25% 加速; 3^d 邻域候选 ⊇ 真对 + 真距过滤）`,
  );
}

// ═══════════════════ 38.0 非线性动力学: Wolf 法 ═══════════════════

section('38.0 R5 · Wolf 法: logistic 锚点 + 参数扫描 200 输入');

{
  const logisticSeries = (r, seed, len = 1500, burn = 300) => {
    const rng = mulberry32(seed);
    let x = 0.2 + rng() * 0.6;
    const out = [];
    for (let i = 0; i < len + burn; i += 1) {
      x = r * x * (1 - x);
      if (i >= burn) out.push(x);
    }
    return out;
  };
  // 解析对照: 轨迹平均 ln|r(1−2x)| → 真 λ₁
  const analyticLambda = (r, series) => series.reduce((s, x) => s + Math.log(Math.abs(r * (1 - 2 * x))), 0) / series.length;

  const s4a = wolfLyapunov(logisticSeries(4.0, 101));
  const s4b = wolfLyapunov(logisticSeries(4.0, 202));
  const ros = largestLyapunov(logisticSeries(4.0, 101));
  ok(
    s4a !== undefined && Math.abs(s4a.lambda - Math.LN2) < 0.08 && s4b !== undefined && Math.abs(s4b.lambda - Math.LN2) < 0.08,
    `logistic r=4: Wolf λ₁ = ${s4a ? s4a.lambda.toFixed(3) : '—'}/${s4b ? s4b.lambda.toFixed(3) : '—'} ≈ ln2 = 0.693（重整化直接法; Rosenstein 同系列 ${ros ? ros.lambda.toFixed(3) : '—'}）`,
  );
  const p32 = wolfLyapunov(logisticSeries(3.2, 11));
  const p35 = wolfLyapunov(logisticSeries(3.5, 12));
  ok(
    p32 !== undefined && Math.abs(p32.lambda) <= 0.05 && p35 !== undefined && Math.abs(p35.lambda) <= 0.05,
    `周期窗 r=3.2/3.5: λ₁ ≈ 0（${p32 ? p32.lambda.toFixed(4) : '—'}/${p35 ? p35.lambda.toFixed(4) : '—'} ≤ 0.05——周期轨道上分离不增长; 一维可观测看不见横向收缩的诚实边界）`,
  );
  ok(
    wolfLyapunov(logisticSeries(2.5, 13)) === undefined,
    'r=2.5: 吸引子塌缩到不动点（分离恒零, 有效步不足）→ undefined 诚实报告（无假数）',
  );
  ok(
    JSON.stringify(wolfLyapunov(logisticSeries(3.9, 55))) === JSON.stringify(wolfLyapunov(logisticSeries(3.9, 55))),
    '同输入逐位一致（纯 log 域 + 确定最近邻平局规则）',
  );
  // 零分离护栏: 构造带重复段的序列不产生 NaN
  const dup = [...logisticSeries(3.9, 77), 0.42, 0.42, 0.42, 0.42, 0.42, 0.42, 0.42, 0.42];
  const wd = wolfLyapunov(dup);
  ok(
    wd === undefined || Number.isFinite(wd.lambda),
    `重复值零分离步: 跳过不贡献（λ=${wd ? wd.lambda.toFixed(3) : 'undefined'}——无 NaN/无 ±∞ 污染）`,
  );

  // 参数扫描: 40 r × 5 种子 = 200 输入, 阈值化混沌判定 vs 解析轨迹平均
  let agree = 0;
  let total = 0;
  for (let i = 0; i < 40; i += 1) {
    const r = 3.6 + (i / 39) * 0.4;
    for (let seed = 1; seed <= 5; seed += 1) {
      const series = logisticSeries(r, seed * 77 + 13);
      const a = analyticLambda(r, series);
      const w = wolfLyapunov(series);
      total += 1;
      const clsA = a > 0.05;
      const clsW = w !== undefined && w.lambda > 0.05;
      if (clsA === clsW) agree += 1;
    }
  }
  ok(
    agree >= 190,
    `参数扫描 ${total} 输入: 阈值化混沌判定（λ > 0.05）与解析轨迹平均一致 ${agree}/${total} ≥ 95%（不一致集中在混沌 onset 边界 r≈3.70/3.74 的解析值 0.05−0.08 区）`,
  );
  // 噪声门纪律: 白噪声的 Wolf 大正数必须被 determinism 门拦下（与 Rosenstein 同防线）
  const rngN = mulberry32(9);
  const noise = Array.from({ length: 2000 }, () => rngN());
  ok(
    wolfLyapunov(noise).lambda > 3 && determinismScore(noise) > 0.5,
    `白噪声: Wolf λ = ${wolfLyapunov(noise).lambda.toFixed(1)}（无穷维混沌假象）但 determinismScore = ${determinismScore(noise).toFixed(2)} > 0.5——噪声门先行的纪律不变`,
  );
  throws(() => wolfLyapunov([0.5, 0.5, 1], { replacementThreshold: -1 }), '负替换阈值显式 throw');
}

// ═══════════════════ 76.0 新奇检测: LOF + 半空间深度 ═══════════════════

section('76.0 R5 · LOF: 精确锚点 + 双密度世界 + 对称注入 200 种子');

{
  // 完美网格内点: k-距全等 → LOF 精确 = 1
  const grid = [];
  for (let x = 0; x < 7; x += 1) for (let y = 0; y < 7; y += 1) grid.push([x, y]);
  const interior = localOutlierFactor(grid, [3, 3], { k: 4 });
  ok(
    Math.abs(interior.lof - 1) < 1e-12,
    `完美网格内点 LOF = ${interior.lof.toPrecision(15)} 精确 = 1（均匀局部密度比的解析锚点）`,
  );
  // 网格角点: 邻居密度同样均匀但自身处于边界 → LOF ≈ 1 量级（非离群）
  const corner = localOutlierFactor(grid, [0, 0], { k: 4 });
  ok(
    corner.lof > 0.8 && corner.lof < 2.5,
    `网格角点 LOF = ${corner.lof.toFixed(3)} ∈ (0.8, 2.5)（边界效应温和, 不误报）`,
  );

  // 双密度世界: 密簇 σ0.15 + 疏簇 σ0.6 + 孤立外点
  const rng = mulberry32(20261001);
  const dense = Array.from({ length: 120 }, () => [gaussianNoise(rng) * 0.15, gaussianNoise(rng) * 0.15]);
  const sparse = Array.from({ length: 120 }, () => [5 + gaussianNoise(rng) * 0.6, gaussianNoise(rng) * 0.6]);
  const ref = [...dense, ...sparse];
  const lofOut = localOutlierFactor(ref, [2.5, 2.5], { k: 8 });
  const lofDense = dense.slice(0, 40).map((p) => localOutlierFactor(ref, p, { k: 8 }).lof);
  const lofSparse = sparse.slice(0, 40).map((p) => localOutlierFactor(ref, p, { k: 8 }).lof);
  ok(
    lofOut.lof > 4 && lofOut.lof > Math.max(...lofDense) && lofOut.lof > Math.max(...lofSparse),
    `双密度世界: 孤立外点 LOF = ${lofOut.lof.toFixed(2)} > max(密簇 ${Math.max(...lofDense).toFixed(2)}, 疏簇 ${Math.max(...lofSparse).toFixed(2)})`,
  );
  ok(
    (lofSparse.reduce((a, b) => a + b, 0) / 40) < 1.7 && (lofDense.reduce((a, b) => a + b, 0) / 40) < 1.7,
    `疏簇成员均值 LOF = ${(lofSparse.reduce((a, b) => a + b, 0) / 40).toFixed(2)} ≈ 密簇 ${(lofDense.reduce((a, b) => a + b, 0) / 40).toFixed(2)} ≈ 1（局部口径: 邻居同稀疏则不离群）`,
  );
  const kth = (p) => ref.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])).sort((a, b) => a - b)[7];
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const denseKth = mean(dense.slice(0, 40).map(kth));
  const sparseKth = mean(sparse.slice(0, 40).map(kth));
  ok(
    sparseKth / denseKth > 2,
    `全局口径对照: 疏簇成员平均第 k 距 = 密簇的 ${(sparseKth / denseKth).toFixed(1)}× > 2（kNN 密度比会把他们推向高新奇, LOF 不会——分水岭）`,
  );
  const auc = lofAUC(
    ref,
    [...dense.slice(40, 80), ...sparse.slice(40, 80)],
    Array.from({ length: 30 }, (_, i) => [2.5 + Math.cos(i) * 0.3, 2.5 + Math.sin(i) * 0.3]),
    { k: 8 },
  );
  ok(
    auc.auc === 1 && auc.outlierMinLof > auc.inlierMaxLof,
    `lofAUC = 1（完全分离: min 外点 LOF ${auc.outlierMinLof.toFixed(2)} > max 内点 ${auc.inlierMaxLof.toFixed(2)}）`,
  );

  // 对称注入 200 种子: 高斯云 + 随机方向 5σ 注入, LOF(注入) > max LOF(内点)
  let detected = 0;
  for (let s = 1; s <= 200; s += 1) {
    const r2 = mulberry32(s * 7919);
    const cloud = Array.from({ length: 100 }, () => [gaussianNoise(r2), gaussianNoise(r2), gaussianNoise(r2), gaussianNoise(r2)]);
    const theta = 2 * Math.PI * r2();
    const phi = Math.acos(2 * r2() - 1);
    const injected = [5 * Math.sin(phi) * Math.cos(theta), 5 * Math.sin(phi) * Math.sin(theta), 5 * Math.cos(phi), 0];
    const inMax = Math.max(...cloud.map((p) => localOutlierFactor(cloud, p, { k: 6 }).lof));
    if (localOutlierFactor(cloud, injected, { k: 6 }).lof > inMax) detected += 1;
  }
  ok(
    detected >= 190,
    `对称注入: 200 种子中 ${detected} 个 LOF(注入点) > max LOF(内点)（≥ 95%）`,
  );
  ok(
    JSON.stringify(localOutlierFactor(ref, [2.5, 2.5], { k: 8 })) === JSON.stringify(localOutlierFactor(ref, [2.5, 2.5], { k: 8 })),
    'LOF 确定性（邻居平局按下标序）',
  );
  throws(() => localOutlierFactor(ref, [2.5], { k: 8 }), '维度不一致显式 throw');
  throws(() => localOutlierFactor(ref, [2.5, 2.5], { k: 0 }), 'k=0 显式 throw');

  // Tukey 深度
  const ref1 = Array.from({ length: 101 }, (_, i) => i - 50);
  ok(
    near(halfspaceDepth1D(ref1, 0), 51 / 101, 1e-12) &&
      near(halfspaceDepth1D(ref1, 25), 26 / 101, 1e-12) &&
      near(halfspaceDepth1D(ref1, -25), 26 / 101, 1e-12) &&
      halfspaceDepth1D(ref1, 100) === 0 &&
      halfspaceDepth1D(ref1, 7) > halfspaceDepth1D(ref1, 25),
    `Tukey 深度: 中位 51/101 ≈ 1/2、±25 对称 26/101、出值域 0、单调远离中心`,
  );
  throws(() => halfspaceDepth1D([], 1), '空基准显式 throw');
  throws(() => halfspaceDepth1D([1, NaN], 1), 'NaN 观测显式 throw');
}

// ═══════════════════ 91.0 新奇搜索: 档案密度控制 ═══════════════════

section('91.0 R5 · 档案密度精简: 均匀空间的铺展优势 + 迷宫诚实对照');

{
  // 合成均匀行为空间: 行为 = 基因组（[0,100]²), 档案 40% 容量持续承压
  const space = { dim: 2, geneRange: [0, 100] };
  const behaviorOf = (g) => [g[0], g[1]];
  const meanNn = (archive) => {
    let nnSum = 0;
    for (let i = 0; i < archive.length; i += 1) {
      let nn = Infinity;
      for (let j = 0; j < archive.length; j += 1) {
        if (i === j) continue;
        const d = Math.hypot(archive[i].behavior[0] - archive[j].behavior[0], archive[i].behavior[1] - archive[j].behavior[1]);
        if (d < nn) nn = d;
      }
      nnSum += nn;
    }
    return nnSum / archive.length;
  };
  let dNn = [];
  let rNn = [];
  for (let seed = 1; seed <= 15; seed += 1) {
    const d = noveltySearch({ genomeSpace: space, behaviorOf, generations: 80, popSize: 30, k: 5, archiveCap: 20, seed, archivePolicy: 'density', cellSize: 5 });
    const r = noveltySearch({ genomeSpace: space, behaviorOf, generations: 80, popSize: 30, k: 5, archiveCap: 20, seed, archivePolicy: 'random', cellSize: 5 });
    dNn.push(meanNn(d.archive));
    rNn.push(meanNn(r.archive));
  }
  const dMean = dNn.reduce((a, b) => a + b, 0) / 15;
  const rMean = rNn.reduce((a, b) => a + b, 0) / 15;
  const wins = dNn.filter((v, i) => v >= rNn[i]).length;
  ok(
    dMean > rMean && wins >= 12,
    `均匀空间 15 种子: density 档案平均最近邻距 ${dMean.toFixed(2)} > random ${rMean.toFixed(2)}（${wins}/15 种子占优——驱逐最稠密面包屑, 同预算铺更开）`,
  );

  // 欺骗迷宫 30 种子诚实对照（确定性固定种子）
  const dm = deceptiveMaze();
  let dW = 0;
  let rW = 0;
  const dFirst = [];
  const rFirst = [];
  for (let seed = 1; seed <= 30; seed += 1) {
    const d = noveltySearch({ genomeSpace: dm.genomeSpace, behaviorOf: dm.behaviorOf, generations: 120, popSize: 40, k: 10, archiveCap: 40, seed, archivePolicy: 'density', solved: dm.solved, stopWhenSolved: true });
    const r = noveltySearch({ genomeSpace: dm.genomeSpace, behaviorOf: dm.behaviorOf, generations: 120, popSize: 40, k: 10, archiveCap: 40, seed, archivePolicy: 'random', solved: dm.solved, stopWhenSolved: true });
    if (d.firstSolvedGeneration !== null) {
      dW += 1;
      dFirst.push(d.firstSolvedGeneration);
    }
    if (r.firstSolvedGeneration !== null) {
      rW += 1;
      rFirst.push(r.firstSolvedGeneration);
    }
  }
  const dMeanFirst = dFirst.reduce((a, b) => a + b, 0) / dFirst.length;
  const rMeanFirst = rFirst.reduce((a, b) => a + b, 0) / rFirst.length;
  console.log('  ┌──────────────────┬─────────┬────────────┐');
  console.log('  │ 精简策略（迷宫30种子） │ 成功率   │ 平均首解代数 │');
  console.log('  ├──────────────────┼─────────┼────────────┤');
  console.log(`  │ density（密度控制）   │  ${dW}/30   │   ${dMeanFirst.toFixed(1)}    │`);
  console.log(`  │ random（随机淘汰）    │  ${rW}/30   │   ${rMeanFirst.toFixed(1)}    │`);
  console.log('  └──────────────────┴─────────┴────────────┘');
  ok(
    dW >= 24 && rW >= 24,
    `欺骗迷宫: 两策略成功率同档（density ${dW}/30, random ${rW}/30, 均 ≥ 0.8）——密度精简不伤欺骗绕行能力`,
  );
  ok(
    dMeanFirst <= rMeanFirst,
    `成功时 density 平均首解更快（${dMeanFirst.toFixed(1)} ≤ ${rMeanFirst.toFixed(1)} 代）——面包屑铺展更远, 前沿外推更顺`,
  );

  // 缺省策略逐位向后兼容
  const t = openFieldMaze();
  const noPolicy = noveltySearch({ genomeSpace: t.genomeSpace, behaviorOf: t.behaviorOf, generations: 10, popSize: 20, k: 5, archiveCap: 10, seed: 9, solved: t.solved });
  const explicitRandom = noveltySearch({ genomeSpace: t.genomeSpace, behaviorOf: t.behaviorOf, generations: 10, popSize: 20, k: 5, archiveCap: 10, seed: 9, archivePolicy: 'random', solved: t.solved });
  ok(
    JSON.stringify(noPolicy.noveltyTrace) === JSON.stringify(explicitRandom.noveltyTrace),
    "缺省 archivePolicy='random' 与旧路径逐位一致（向后兼容零漂移）",
  );
  throws(
    () => noveltySearch({ genomeSpace: t.genomeSpace, behaviorOf: t.behaviorOf, generations: 2, popSize: 10, k: 3, archiveCap: 5, seed: 1, archivePolicy: 'lru' }),
    "未知 archivePolicy 'lru' 显式 throw",
  );

  // 描述子消融: 2D 行为 vs 1D 投影的覆盖（特征化选择的意义）
  let cov2d = 0;
  let cov1d = 0;
  for (let seed = 1; seed <= 6; seed += 1) {
    const b2 = noveltySearch({ genomeSpace: t.genomeSpace, behaviorOf: t.behaviorOf, generations: 50, popSize: 30, k: 6, archiveCap: 40, seed });
    const b1 = noveltySearch({ genomeSpace: t.genomeSpace, behaviorOf: (g) => t.behaviorOf(g).slice(0, 1), generations: 50, popSize: 30, k: 6, archiveCap: 40, seed });
    cov2d += b2.noveltyTrace[b2.noveltyTrace.length - 1].cellsCovered;
    cov1d += b1.noveltyTrace[b1.noveltyTrace.length - 1].cellsCovered;
  }
  ok(
    cov2d > cov1d * 5,
    `描述子消融: 2D 行为平均覆盖 ${(cov2d / 6).toFixed(0)} 格 ≫ 1D 投影 ${(cov1d / 6).toFixed(0)} 格（投影丢维 = 行为空间塌缩——特征化选择是覆盖的第一决定量）`,
  );
}

// ═══════════════════ 66.0 模拟退火: 并行回火 + Luby 重启 ═══════════════════

section('66.0 R5 · 并行回火: 单调能级 / 健康交换率 / 同预算对照 / 确定性');

{
  // 双簇 TSP + 相邻交换稀疏邻域（真井地形——d* 可精确枚举）
  const inst = tspInstance(6, 42);
  const exact = tspExactOptimum(inst);
  const permutations = (arr) =>
    arr.length <= 1 ? [arr] : arr.flatMap((x, i) => permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]));
  const tours = permutations([0, 1, 2, 3, 4, 5]);
  const energies = {};
  const adjacency = {};
  for (const t of tours) {
    const key = t.join('');
    energies[key] = tspTourLength(inst, t);
    const nb = new Set();
    for (let i = 0; i < 5; i += 1) {
      const sw = [...t];
      [sw[i], sw[i + 1]] = [sw[i + 1], sw[i]];
      nb.add(sw.join(''));
    }
    adjacency[key] = [...nb];
  }
  const { criticalDepth: dStar } = wellDepth(energies, adjacency);
  const energy = (t) => tspTourLength(inst, t);
  const neighbor = (t, rng) => tspAdjacentSwapNeighbor(t, rng);
  const randomTour = (seed) => {
    const r = mulberry32(seed);
    const a = [0, 1, 2, 3, 4, 5];
    for (let i = 5; i > 0; i -= 1) {
      const j = Math.floor(r() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // 副本能级单调 + 交换率健康 + 断梯对照
  const pt = parallelTempering({ energy, neighbor, x0: randomTour(5150), replicas: 5, ladder: { tMin: 0.01, tMax: dStar * 2 }, steps: 8000, swapEvery: 5, seed: 777 });
  ok(
    JSON.stringify(pt.meanEnergies) === JSON.stringify([...pt.meanEnergies].sort((a, b) => a - b)),
    `副本全程平均能级随温度单调非降（[${pt.meanEnergies.map((e) => e.toFixed(2)).join(' ≤ ')}]——冷副本收留低能态的实证）`,
  );
  ok(
    pt.swapRate > 0.05 && pt.swapRate < 0.95,
    `交换率 ${pt.swapRate.toFixed(3)} ∈ (0.05, 0.95)（阶梯连通: 0 = 断梯, 1 = 温差白设）`,
  );
  const broken = parallelTempering({ energy, neighbor, x0: randomTour(5150), replicas: 2, ladder: [0.001, 50], steps: 4000, swapEvery: 5, seed: 7 });
  ok(
    broken.swapRate < 0.05,
    `断梯对照: [0.001, 50] 温差 swapRate = ${broken.swapRate.toFixed(4)} < 0.05（log 域裁决 min(0, Δβ·ΔE) 几乎必拒——阶梯设计的可观测后果）`,
  );
  const ptAgain = parallelTempering({ energy, neighbor, x0: randomTour(5150), replicas: 5, ladder: { tMin: 0.01, tMax: dStar * 2 }, steps: 8000, swapEvery: 5, seed: 777 });
  ok(
    JSON.stringify(pt) === JSON.stringify(ptAgain),
    '同种子逐位复现（rng 消费纪律: 每副本每步 1 次接受抽签 + 每次交换尝试 1 次）',
  );

  // 同总预算对照: PT 4×300 vs 单链几何 1200 vs 贪心 1200 × 40 种子
  const TRIALS = 40;
  const STEPS = 300;
  const R = 4;
  let ptHits = 0;
  let geoHits = 0;
  let greedyHits = 0;
  for (let i = 0; i < TRIALS; i += 1) {
    const x0 = randomTour(31001 + i * 7919);
    const p = parallelTempering({ energy, neighbor, x0, replicas: R, ladder: { tMin: 0.02, tMax: dStar * 2 }, steps: STEPS, swapEvery: 10, seed: 31001 + i * 104729 });
    if (Math.abs(p.bestEnergy - exact.length) < 1e-9) ptHits += 1;
    const g = anneal({ energy, neighbor, x0, schedule: { kind: 'geometric', T0: dStar * 2, rate: 0.992 }, steps: STEPS * R, seed: 31001 + i * 104729 });
    if (Math.abs(g.bestEnergy - exact.length) < 1e-9) geoHits += 1;
    const gr = anneal({ energy, neighbor, x0, schedule: { kind: 'constant', T: 1e-12 }, steps: STEPS * R, seed: 31001 + i * 104729 });
    if (Math.abs(gr.bestEnergy - exact.length) < 1e-9) greedyHits += 1;
  }
  console.log('  ┌─────────────────────────────┬──────────┐');
  console.log('  │ 同总预算 1200 步（40 种子）      │ 命中率    │');
  console.log('  ├─────────────────────────────┼──────────┤');
  console.log(`  │ 并行回火 4 副本 × 300 步        │   ${ptHits}/40   │`);
  console.log(`  │ 单链几何降温 1200 步            │   ${geoHits}/40   │`);
  console.log(`  │ 纯贪心 1200 步                 │   ${greedyHits}/40   │`);
  console.log('  └─────────────────────────────┴──────────┘');
  ok(
    ptHits >= 38 && ptHits >= geoHits,
    `并行回火命中 ${ptHits}/40 ≥ 单链几何 ${geoHits}/40（≥95%: 热副本常驻高温翻井, 冷副本交换免费获得低能态——ΣT_k<∞ 冻死的结构性解法）`,
  );
  ok(
    greedyHits <= ptHits - 20,
    `贪心 ${greedyHits}/40 ≪ 并行回火（d*=${dStar.toFixed(2)} 的真井地形: 只降不升被囚禁）`,
  );
  throws(
    () => parallelTempering({ energy, neighbor, x0: [0, 1, 2], replicas: 1, ladder: [1], steps: 10, swapEvery: 1, seed: 1 }),
    'replicas=1 显式 throw（交换无从谈起）',
  );
  throws(
    () => parallelTempering({ energy, neighbor, x0: [0, 1, 2], replicas: 2, ladder: [1, 0.5], steps: 10, swapEvery: 1, seed: 1 }),
    '阶梯非升序显式 throw',
  );
  throws(
    () => parallelTempering({ energy, neighbor, x0: [0, 1, 2], replicas: 2, ladder: { tMin: 2, tMax: 1 }, steps: 10, swapEvery: 1, seed: 1 }),
    'tMin > tMax 显式 throw',
  );
}

section('66.0 R5 · Luby 重启序列 + annealWithRestarts');

{
  ok(
    JSON.stringify(lubySequence(15)) === JSON.stringify([1, 1, 2, 1, 1, 2, 4, 1, 1, 2, 1, 1, 2, 4, 8]) &&
      JSON.stringify(lubySequence(6, 100)) === JSON.stringify([100, 100, 200, 100, 100, 200]),
    'Luby 序列精确前缀 1,1,2,1,1,2,4,1,1,2,1,1,2,4,8 + base 倍乘（Luby–Sinclair–Zuckerman 定义的逐项对照）',
  );
  throws(() => lubySequence(0), 'length=0 显式 throw');
  throws(() => lubySequence(2, -1), '负 base 显式 throw');

  // annealWithRestarts: 预算守恒 + 段长模式 + 段最优单调 + 救回冻死几何链
  const inst = tspInstance(6, 42);
  const exact = tspExactOptimum(inst);
  const energy = (t) => tspTourLength(inst, t);
  const neighbor = (t, rng) => tspAdjacentSwapNeighbor(t, rng);
  const randomTour = (seed) => {
    const r = mulberry32(seed);
    const a = [0, 1, 2, 3, 4, 5];
    for (let i = 5; i > 0; i -= 1) {
      const j = Math.floor(r() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const ar = annealWithRestarts({
    energy,
    neighbor,
    x0: randomTour(5150),
    schedule: { kind: 'geometric', T0: 3, rate: 0.995 },
    totalSteps: 1200,
    baseRun: 500,
    seed: 777,
  });
  ok(
    ar.totalSteps === 1200 &&
      ar.segmentSteps.length === ar.restarts &&
      JSON.stringify(ar.segmentSteps) === JSON.stringify([500, 500, 200]),
    `预算守恒: 段长 [${ar.segmentSteps.join(',')}] = Luby(1,1,2)×500 截断于 1200（${ar.totalSteps} 步不多不少）`,
  );
  ok(
    ar.segmentBestEnergies.every((e, i) => i === 0 || e <= ar.segmentBestEnergies[i - 1] + 1e-12),
    `段最优单调非降（[${ar.segmentBestEnergies.map((e) => e.toFixed(3)).join(' → ')}]）`,
  );
  let arHits = 0;
  let greedyHits = 0;
  for (let i = 0; i < 40; i += 1) {
    const x0 = randomTour(88001 + i * 7919);
    const a = annealWithRestarts({ energy, neighbor, x0, schedule: { kind: 'geometric', T0: 3, rate: 0.995 }, totalSteps: 1200, baseRun: 500, seed: 88001 + i * 104729 });
    if (Math.abs(a.bestEnergy - exact.length) < 1e-9) arHits += 1;
    const g = anneal({ energy, neighbor, x0, schedule: { kind: 'constant', T: 1e-12 }, steps: 1200, seed: 88001 + i * 104729 });
    if (Math.abs(g.bestEnergy - exact.length) < 1e-9) greedyHits += 1;
  }
  ok(
    arHits >= 38 && arHits > greedyHits,
    `Luby 重启 ${arHits}/40 ≫ 同预算贪心 ${greedyHits}/40（几何单段冻死不可逆, 重启把链拉回高温——步长是带定理的纪律而非拍脑袋）`,
  );
  throws(
    () => annealWithRestarts({ energy, neighbor, x0: randomTour(1), schedule: { kind: 'constant', T: 1 }, totalSteps: 0, seed: 1 }),
    'totalSteps=0 显式 throw',
  );
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
