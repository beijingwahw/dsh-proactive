/**
 * verify-mapper-graph.mjs — 69.0 Mapper 图内核纯数学离线验证
 *
 * Mapper 构造的数学核心都有解析对照（不是「能跑」，是「算得对」）：
 *   覆盖几何: 等宽 n 区间 + 重叠率 p 的闭式（宽度 w = span/(1+(n−1)(1−p))，
 *        相邻重叠恰为 p·w，首尾贴合 [min,max]）
 *   ④ 聚类单元: ε-单链链式合并（0.9+0.9 链起 1.27 的远对）vs ε-完全链
 *        直径纪律拆开——同一点集两种口径的 razor 级差异；输出确定序
 *   图工具: 连通分量/圈基对解析小图精确（路径/四边形/双三角/哑铃/
 *        平行边 multigraph 口径），圈基 = E − V + C 闭式
 *   ① 圆环锚点: 300 点圆环 + y 滤镜（10 区间 30% 重叠）→ Mapper 图恰
 *        含 1 个环（圈基 = 1，基本圈 10 节点）；36.0 H₀ 口径同点云
 *        1 块大陆——H₀=ℤ + H₁=ℤ 合起来正是 S¹ 的同调（两内核互证）
 *   ② 两分离高斯团: 恰 2 分量、0 假环（多种子；完全链口径同判）
 *   ③ 重叠不足 5%: 圆环断裂（分量 6 > 2）——参数敏感性诚实示警；
 *        密度补偿（3000 点同 5% 重叠恢复 1 分量 / 圈基 1）
 *   ⑤ nerve 引理直觉: 好参数下分量数 = 真簇数（k=2,3,4 × 3 种子全中）
 *
 * 全部断言确定性（数据工厂 mulberry32 种子固定，同输入同输出）。
 * 运行：node --experimental-strip-types scripts/verify-mapper-graph.mjs
 */

import {
  buildMapper,
  intervalCover,
  singleLinkage,
  completeLinkage,
  connectedComponents,
  cycleBasis,
  annulus,
  blobs,
  mapperInsight,
} from '../src/core/mapper-graph.ts';
import { h0Persistence } from '../src/core/persistent-homology.ts';

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

// ═══════════════════ 覆盖几何闭式 ═══════════════════

section('覆盖几何：等宽区间 + 重叠率 p 的闭式');

{
  const cover = intervalCover(-2, 2, 10, 0.3);
  const w = 4 / (1 + 9 * 0.7); // span/(1+(n−1)(1−p))
  ok(cover.length === 10, `10 个区间`);
  ok(
    cover.every((iv) => near(iv.width, w, 1e-12) && near(iv.end - iv.start, w, 1e-12)),
    `等宽 w = span/(1+(n−1)(1−p)) = ${w.toFixed(9)}`,
  );
  ok(near(cover[0].start, -2, 1e-12) && near(cover[9].end, 2, 1e-9), `首尾贴合 [min, max]（无缝覆盖）`);
  ok(
    cover.slice(1).every((iv, i) => near(cover[i].end - iv.start, 0.3 * w, 1e-9)),
    `相邻重叠带宽恰为 p·w = ${(0.3 * w).toFixed(9)}（重叠区点双属相邻纤维——神经边的来源）`,
  );
  ok(cover.every((iv) => near(iv.center, (iv.start + iv.end) / 2, 1e-15)), `center = 区间中点`);
  throws(() => intervalCover(2, -2, 5, 0.3), 'min ≥ max 显式 throw');
  throws(() => intervalCover(-2, 2, 0, 0.3), 'intervals=0 显式 throw');
  throws(() => intervalCover(-2, 2, 2.5, 0.3), 'intervals 非整数显式 throw');
  throws(() => intervalCover(-2, 2, 10, 0), 'overlap=0 显式 throw（开区间）');
  throws(() => intervalCover(-2, 2, 10, 1), 'overlap=1 显式 throw（开区间）');
}

// ═══════════════════ 数据工厂 ═══════════════════

section('数据工厂：圆环与高斯团（确定性 + 几何界）');

{
  const ring = annulus(300, 1, 2, 7);
  ok(ring.length === 300 && ring.every((p) => p.length === 2), 'annulus(300,1,2) 300 点二维');
  const radii = ring.map(([x, y]) => Math.hypot(x, y)).sort((a, b) => a - b);
  ok(
    radii[0] >= 1 - 1e-12 && radii[299] <= 2 + 1e-12,
    `面积均匀采样：所有半径 ∈ [1,2]（实测 [${radii[0].toFixed(4)}, ${radii[299].toFixed(4)}]）`,
  );
  ok(JSON.stringify(ring) === JSON.stringify(annulus(300, 1, 2, 7)), '同种子逐位一致（mulberry32 确定性）');
  ok(JSON.stringify(ring) !== JSON.stringify(annulus(300, 1, 2, 8)), '异种子序列不同（非平凡随机）');

  const two = blobs(2, 150, 5);
  ok(two.length === 300, 'blobs(2,150) 共 300 点（每簇 150）');
  const mean = (arr, dim) => arr.reduce((s, p) => s + p[dim], 0) / arr.length;
  const a = two.slice(0, 150);
  const b = two.slice(150);
  ok(
    near(mean(a, 0), 4, 0.3) && near(mean(a, 1), 0, 0.3),
    `簇 A 质心 ≈ (4,0)（实测 (${mean(a, 0).toFixed(3)}, ${mean(a, 1).toFixed(3)})，σ/√150≈0.08）`,
  );
  ok(near(mean(b, 0), -4, 0.3) && near(mean(b, 1), 0, 0.3), `簇 B 质心 ≈ (−4,0)（实测 (${mean(b, 0).toFixed(3)}, ${mean(b, 1).toFixed(3)})）`);
  throws(() => annulus(10, 2, 1, 1), 'annulus r1 ≥ r2 显式 throw');
  throws(() => annulus(0, 1, 2, 1), 'annulus n=0 显式 throw');
  throws(() => annulus(10.5, 1, 2, 1), 'annulus n 非整数显式 throw');
  throws(() => blobs(0, 10, 1), 'blobs k=0 显式 throw');
  throws(() => blobs(2, 10, 1, { sigma: 0 }), 'blobs sigma=0 显式 throw');
}

// ═══════════════════ ④ 单链 vs 完全链 ═══════════════════

section('④ ε-单链 vs ε-完全链：链式效应 razor');

{
  const pts = [
    [0, 0],
    [0.9, 0],
    [0, 0.9],
    [5, 5],
    [5.9, 5],
    [10, 0],
  ];
  // 点 1、2 到点 0 均 0.9 ≤ 1，但 1–2 相距 √1.62 ≈ 1.27 > 1
  const sl = singleLinkage(pts, 1);
  ok(
    JSON.stringify(sl) === JSON.stringify([[0, 1, 2], [3, 4], [5]]),
    `ε-单链 [[0,1,2],[3,4],[5]]：0.9+0.9 链式合并 1.27 的远对（链式效应）`,
  );
  const cl = completeLinkage(pts, 1);
  ok(
    JSON.stringify(cl) === JSON.stringify([[0, 1], [2], [3, 4], [5]]),
    `ε-完全链 [[0,1],[2],[3,4],[5]]：直径纪律 max{0.9,1.27}=1.27 > 1 拒并（razor）`,
  );
  ok(JSON.stringify(singleLinkage(pts, 10)) === JSON.stringify([[0, 1, 2, 3, 4, 5]]), 'eps=10 单链全并');
  ok(
    JSON.stringify(singleLinkage(pts, 0.1)) === JSON.stringify([[0], [1], [2], [3], [4], [5]]),
    'eps=0.1 全散',
  );
  ok(
    sl.every((c) => c.every((m, i) => i === 0 || c[i - 1] < m)) && sl[0][0] < sl[1][0] && sl[1][0] < sl[2][0],
    '输出确定序：成员升序、簇按首成员升序',
  );
  throws(() => singleLinkage([], 1), '空点集显式 throw');
  throws(() => singleLinkage([[1, 2], [3]], 1), '维度不一致显式 throw');
  throws(() => singleLinkage([[1, NaN]], 1), 'NaN 坐标显式 throw');
  throws(() => singleLinkage([[0], [1]], -1), 'eps < 0 显式 throw');
  throws(() => singleLinkage([[0], [1]], 1, () => -5), 'metric 返回负数显式 throw');
  throws(() => completeLinkage([[0], [1]], -1), 'completeLinkage eps < 0 显式 throw');
}

// ═══════════════════ 图工具：连通分量 + 圈基 ═══════════════════

section('图工具：连通分量 + 圈基（解析小图精确对照）');

{
  const path = { nodes: 4, edges: [[0, 1], [1, 2], [2, 3]] };
  const sq = { nodes: 4, edges: [[0, 1], [1, 2], [2, 3], [3, 0]] };
  const twoSq = { nodes: 9, edges: [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3], [7, 8]] };
  const barbell = { nodes: 7, edges: [[0, 1], [1, 2], [2, 0], [2, 3], [3, 4], [4, 5], [5, 6], [6, 4]] };
  ok(
    connectedComponents(path).length === 1 && cycleBasis(path).cycleRank === 0,
    '路径图: 1 分量 / 圈基 0',
  );
  const cb = cycleBasis(sq);
  ok(
    cb.components === 1 && cb.cycleRank === 1 && cb.cycles.length === 1 && cb.cycles[0].length === 4,
    `四边形: 圈基 1，基本圈 4 节点（${cb.cycles[0].join('→')}）`,
  );
  const d = cycleBasis(twoSq);
  ok(
    d.components === 4 && d.cycleRank === 2 && d.cycles.every((c) => c.length === 3),
    '双三角 + 孤立点对: 4 分量 / 圈基 2（两圈各 3 节点）',
  );
  const bb = cycleBasis(barbell);
  ok(bb.components === 1 && bb.cycleRank === 2, '哑铃（两三角一路相连）: 1 分量 / 圈基 2（E−V+C = 8−7+1）');
  const par = cycleBasis({ nodes: 3, edges: [[0, 1], [0, 1], [1, 2]] });
  ok(
    par.cycleRank === 1 && par.cycles.length === 1 && par.cycles[0].length === 2,
    '平行边计一圈（multigraph 口径：E−V+C = 3−3+1）',
  );
  const disc = connectedComponents({ nodes: 6, edges: [[0, 2], [2, 4], [1, 3]] });
  ok(
    disc.length === 3 && JSON.stringify(disc[0]) === JSON.stringify([0, 2, 4]),
    `分量成员正确（${disc.map((c) => `[${c.join(',')}]`).join(' ')}）`,
  );
  throws(() => cycleBasis({ nodes: 2, edges: [[0, 2]] }), '边端点越界显式 throw');
  throws(() => cycleBasis({ nodes: 2, edges: [[2, 0]] }), '端点 = 节点数（越界）显式 throw');
  throws(() => cycleBasis({ nodes: 2, edges: [[0, 1], [1, 1]] }), '自环显式 throw（Mapper 神经不产生）');
  throws(() => cycleBasis({ nodes: 2, edges: [[0, 0.5]] }), '非整数端点显式 throw');
  throws(() => connectedComponents({ nodes: -1, edges: [] }), '负节点数显式 throw');
}

// ═══════════════════ ① 圆环锚点：Mapper 图含环 ═══════════════════

section('① 圆环 300 点：y 滤镜 Mapper 图恰含 1 环（H₁ 显形，36.0 互证）');

{
  const ring = annulus(300, 1, 2, 7);
  const m = buildMapper({ points: ring, filter: (p) => p[1], intervals: 10, overlap: 0.3, clusterEps: 0.6 });
  ok(m.stats.coverage === 1, '覆盖完整：300 点全部落入 ≥1 节点（等宽闭区间覆盖的诚实核对）');
  ok(m.stats.components === 1, `圆环 Mapper 图连通（1 分量）`);
  ok(
    m.stats.cycleRank === 1,
    `圈基恰 1（图含一个环——H₁(S¹)=ℤ 显形；E=${m.stats.edgeCount}, V=${m.stats.nodeCount}, C=1）`,
  );
  const cb = cycleBasis(m);
  ok(
    cb.cycles.length === 1 && cb.cycles[0].length >= 8,
    `基本圈 ${cb.cycles[0].length} 节点（空洞边界节点 = 探索盲区的可定位成员）`,
  );
  ok(
    m.stats.intervalHistogram.some((c) => c === 2),
    `中段区间分裂为左右 2 簇（直方图 ${m.stats.intervalHistogram.join('')}）——y 滤镜下环的左右两链指纹`,
  );
  // 结构不变量
  ok(
    m.edges.every(([a, b]) => a < b && m.nodes[a].interval !== m.nodes[b].interval),
    '边不变量: 端点 i<j 且跨区间（同区间聚类划分纤维，不可能互享点）',
  );
  ok(new Set(m.edges.map(([a, b]) => `${a},${b}`)).size === m.edges.length, '边去重（共享多点只连一次）');
  ok(
    m.stats.cycleRank === m.stats.edgeCount - m.stats.nodeCount + m.stats.components &&
      cb.cycleRank === m.stats.cycleRank,
    '圈基 = E − V + C 闭式（buildMapper 与 cycleBasis 双口径一致）',
  );
  ok(
    m.nodes.every(
      (nd) =>
        nd.interval >= 0 &&
        nd.interval < 10 &&
        nd.members.every((x, i) => i === 0 || nd.members[i - 1] < x) &&
        nd.centroid.every((c) => Number.isFinite(c)),
    ),
    '节点不变量: 区间下标合法、成员升序、质心有限',
  );
  ok(
    connectedComponents(m).length === m.stats.components,
    'connectedComponents 直接吃 MapperGraph（GraphLike 接口兼容）',
  );
  // 36.0 互证：同点云单连接 H₀ 口径——1 块大陆（环连通无碎裂）；
  // H₀=ℤ（1 大陆）+ Mapper 圈基 1（H₁=ℤ）合起来 = S¹ 的同调
  const ids = ring.map((_, i) => `p${i}`);
  const edges36 = [];
  for (let i = 0; i < ring.length; i += 1) {
    for (let j = i + 1; j < ring.length; j += 1) {
      const dx = ring[i][0] - ring[j][0];
      const dy = ring[i][1] - ring[j][1];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 0.8) edges36.push({ source: ids[i], target: ids[j], weight: 1 - d / 2 });
    }
  }
  const topo = h0Persistence(ids, edges36, 0.6);
  ok(
    topo.landscape.continentCount === 1,
    `36.0 H₀ 口径互证: 同点云阈值扫描到 ε≈0.8 仍 1 块大陆（无碎裂）——H₀=ℤ + 圈基 1 = S¹ 同调`,
  );
  // 多种子稳健性（拓扑结论不靠挑种子）
  const ranks = [11, 23, 42, 99].map(
    (seed) =>
      buildMapper({ points: annulus(300, 1, 2, seed), filter: (p) => p[1], intervals: 10, overlap: 0.3, clusterEps: 0.6 })
        .stats.cycleRank,
  );
  ok(ranks.every((r) => r === 1), `多种子稳健: 圈基全 1（种子 11/23/42/99 → [${ranks.join(',')}]）`);
}

// ═══════════════════ ② 两分离高斯团 ═══════════════════

section('② 两分离高斯团：恰 2 分量、0 假环');

{
  for (const seed of [5, 11, 23]) {
    const m = buildMapper({
      points: blobs(2, 150, seed, { sigma: 0.4 }),
      filter: (p) => p[1],
      intervals: 5,
      overlap: 0.3,
      clusterEps: 1,
    });
    ok(
      m.stats.components === 2 && m.stats.cycleRank === 0,
      `种子 ${seed}: 恰 2 分量、0 假环（V=${m.stats.nodeCount}, E=${m.stats.edgeCount}——nerve 不制造幻影环）`,
    );
  }
  const comp = buildMapper({
    points: blobs(2, 150, 5, { sigma: 0.3 }),
    filter: (p) => p[1],
    intervals: 5,
    overlap: 0.3,
    clusterEps: 2,
    clusterMethod: 'complete',
  });
  ok(
    comp.stats.components === 2 && comp.stats.cycleRank === 0,
    `完全链口径同判: 紧致团（σ=0.3, ε=2）2 分量 0 环（V=${comp.stats.nodeCount}）`,
  );
}

// ═══════════════════ ③ 覆盖重叠不足 ═══════════════════

section('③ 重叠不足 5%：圆环断裂（参数敏感性诚实示警）+ 密度补偿');

{
  const ring = annulus(300, 1, 2, 7);
  const thin = buildMapper({ points: ring, filter: (p) => p[1], intervals: 10, overlap: 0.05, clusterEps: 0.6 });
  ok(
    thin.stats.components > 2,
    `重叠 5%: 圆环断裂为 ${thin.stats.components} 分量（> 2，圈基 ${thin.stats.cycleRank}）——重叠带太窄共享点缺失，图被诚实撕开`,
  );
  const dense = buildMapper({
    points: annulus(3000, 1, 2, 7),
    filter: (p) => p[1],
    intervals: 10,
    overlap: 0.05,
    clusterEps: 0.6,
  });
  ok(
    dense.stats.components === 1 && dense.stats.cycleRank === 1,
    `密度补偿: 3000 点同 5% 重叠恢复 1 分量 / 圈基 1（V=${dense.stats.nodeCount}）——断裂是 overlap×密度联合参数，不是内核缺陷`,
  );
}

// ═══════════════════ ⑤ nerve 引理直觉 ═══════════════════

section('⑤ nerve 引理直觉：好参数下分量数 = 真簇数（k=2,3,4 × 3 种子）');

{
  for (const k of [2, 3, 4]) {
    const seeds = [1, 2, 3];
    const stats = seeds.map((seed) =>
      buildMapper({ points: blobs(k, 120, seed, { sigma: 0.4 }), filter: (p) => p[1], intervals: 5, overlap: 0.3, clusterEps: 1 })
        .stats,
    );
    ok(
      stats.every((s) => s.components === k && s.cycleRank === 0),
      `k=${k}: 3 种子全部 ${k} 分量 / 0 环（${stats.map((s) => `C=${s.components},β₁=${s.cycleRank}`).join('; ')}）`,
    );
  }
}

// ═══════════════════ buildMapper 入参校验 ═══════════════════

section('buildMapper 入参校验与退化分支');

{
  const pts = annulus(50, 1, 2, 3);
  const base = { filter: (p) => p[1], intervals: 10, overlap: 0.3, clusterEps: 1 };
  throws(() => buildMapper({ ...base, points: [] }), '空点集显式 throw');
  throws(() => buildMapper({ ...base, points: [[1, 2], [3]] }), '维度不一致显式 throw');
  throws(() => buildMapper({ ...base, points: [[1, Infinity]] }), '非有限坐标显式 throw');
  throws(() => buildMapper({ points: pts, filter: () => NaN, intervals: 10, overlap: 0.3, clusterEps: 1 }), 'filter 返回 NaN 显式 throw');
  throws(() => buildMapper({ points: pts, filter: () => 1, intervals: 10, overlap: 0.3, clusterEps: 1 }), '常值滤镜（值域退化 min===max）显式 throw');
  throws(() => buildMapper({ points: pts, filter: (p) => p[1], intervals: 0, overlap: 0.3, clusterEps: 1 }), 'intervals=0 显式 throw');
  throws(() => buildMapper({ points: pts, filter: (p) => p[1], intervals: 10.5, overlap: 0.3, clusterEps: 1 }), 'intervals 非整数显式 throw');
  throws(() => buildMapper({ points: pts, filter: (p) => p[1], intervals: 10, overlap: 0, clusterEps: 1 }), 'overlap=0 显式 throw');
  throws(() => buildMapper({ points: pts, filter: (p) => p[1], intervals: 10, overlap: 1.2, clusterEps: 1 }), 'overlap>1 显式 throw');
  throws(() => buildMapper({ points: pts, filter: (p) => p[1], intervals: 10, overlap: 0.3, clusterEps: -1 }), 'clusterEps<0 显式 throw');
  throws(
    () => buildMapper({ points: pts, filter: (p) => p[1], intervals: 10, overlap: 0.3, clusterEps: 1, clusterMethod: 'average' }),
    "未知 clusterMethod 'average' 显式 throw",
  );
  // intervals=1：无重叠结构，退化为纯聚类（nerve 无边可连）
  const one = buildMapper({ points: [[0, 0], [0.5, 0], [9, 9]], filter: (p) => p[0], intervals: 1, overlap: 0.3, clusterEps: 1 });
  ok(one.stats.nodeCount === 2 && one.stats.edgeCount === 0, 'intervals=1 退化为纯聚类: 2 节点 0 边');
  // 自定义滤镜（非坐标）：径向距离——每个纤维是完整圆环带（单簇），
  // 神经退化为路径：径向滤镜看不见洞。滤镜方向决定可见形状（诚实口径）。
  const ringBand = buildMapper({
    points: annulus(300, 1, 2, 7),
    filter: (p) => Math.hypot(p[0], p[1]),
    intervals: 4,
    overlap: 0.3,
    clusterEps: 1.5,
  });
  ok(
    ringBand.stats.components === 1 && ringBand.stats.cycleRank === 0 && ringBand.stats.nodeCount === 4,
    `径向滤镜: 环被压成路径（V=4, E=${ringBand.stats.edgeCount}, 圈基 0）——y 滤镜见洞、径向滤镜见壳层，滤镜方向决定可见形状`,
  );
  const insight = mapperInsight(
    buildMapper({ points: annulus(300, 1, 2, 7), filter: (p) => p[1], intervals: 10, overlap: 0.3, clusterEps: 0.6 }),
  );
  ok(/经验空洞/.test(insight), `mapperInsight 含空洞预警（「${insight}」）`);
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
