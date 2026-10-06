/**
 * verify-belief-propagation.mjs — 56.0 置信传播内核纯数学离线验证
 *
 * 每个锚点都有独立重算对照（不是「能跑」，是「算得对」）——地面真值由
 * 本脚本自带的对数域暴力联合枚举给出（与内核实现零共享代码）：
 *   ① 种子化随机树（7 变量二/三值域成对因子）+ 三值因子树：BP 边缘
 *      vs 暴力联合枚举 ≤ 1e-9（树上 = 精确边缘化的逐位实证）
 *   ② 二值 Ising 单环（8 节点 J=0.4 + 交替场 ±0.12）：loopy BP 阻尼
 *      不动点 vs 枚举精确解的容差报告 + 收敛性；阻尼/无阻尼同不动点
 *      （单环不动点唯一，收敛快慢不同、答案相同）
 *   ③ 链上 max-product 解码 = Viterbi：指派与穷举 MAP 逐位一致，
 *      logJoint ≤ 1e-9
 *   ④ XOR（偶校验）因子消息传播手算对照：P(c=1) = P(a≠b) = 0.66，
 *      强证据变量边缘保持先验（均匀回灌不改写）；软 XOR 与枚举一致
 *   ⑤ logSumExp 数值稳定（e^1000 级不溢出 / e^−1000 级不下溢 /
 *      −Inf 安全）+ e^±600 量级势表链式 BP 边缘仍与枚举一致至 1e-9
 *   ⑥ API 入参校验：非法入参全部显式 throw（域/先验/势表/选项/空图）
 *
 * 全部断言确定性（随机处 mulberry32 种子固定）。
 * 运行：node --experimental-strip-types scripts/verify-belief-propagation.mjs
 */

import { FactorGraph, logSumExp } from '../src/core/belief-propagation.ts';

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

/** 确定性 RNG（mulberry32） */
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

// ─────────────── 独立地面真值：对数域暴力联合枚举（与内核零共享） ───────────────

/**
 * vars: [{ id, domain, prior? }]（prior 缺省均匀）
 * factors: [{ scope: [id...], table }]（行主序展开于 scope 顺序）
 * 返回 { marginals: {id: number[]}, map: { assignment, logJoint } }
 */
function bruteForceGraph(vars, factors) {
  const n = vars.length;
  const strides = new Array(n).fill(1);
  for (let i = n - 2; i >= 0; i -= 1) strides[i] = strides[i + 1] * vars[i + 1].domain;
  const posOf = new Map(vars.map((v, i) => [v.id, i]));
  const fmeta = factors.map((f) => {
    const idxOf = f.scope.map((id) => posOf.get(id));
    const jointStride = f.scope.map((id) => strides[posOf.get(id)]);
    const tableStride = new Array(f.scope.length).fill(1);
    for (let p = f.scope.length - 2; p >= 0; p -= 1) tableStride[p] = tableStride[p + 1] * vars[idxOf[p + 1]].domain;
    return { idxOf, jointStride, tableStride, logTable: f.table.map((t) => (t > 0 ? Math.log(t) : -Infinity)) };
  });
  // 与内核同语义：先验先归一（λ 是局部证据权重，只有相对值有意义）
  const logPrior = vars.map((v) => {
    const p = v.prior ?? Array(v.domain).fill(1);
    const s = p.reduce((x, y) => x + y, 0);
    return p.map((t) => (t > 0 ? Math.log(t / s) : -Infinity));
  });
  let total = 1;
  for (const v of vars) total *= v.domain;
  const logJoint = new Float64Array(total);
  for (let a = 0; a < total; a += 1) {
    let lj = 0;
    for (let i = 0; i < n; i += 1) lj += logPrior[i][Math.floor(a / strides[i]) % vars[i].domain];
    for (const f of fmeta) {
      let tidx = 0;
      for (let p = 0; p < f.idxOf.length; p += 1) {
        const s = Math.floor(a / f.jointStride[p]) % vars[f.idxOf[p]].domain;
        tidx += s * f.tableStride[p];
      }
      lj += f.logTable[tidx];
    }
    logJoint[a] = lj;
  }
  const mx = Math.max(...logJoint);
  let zs = 0;
  for (let a = 0; a < total; a += 1) zs += Math.exp(logJoint[a] - mx);
  const logZ = mx + Math.log(zs);
  const acc = vars.map((v) => new Float64Array(v.domain));
  let bestIdx = 0;
  let bestLog = -Infinity;
  for (let a = 0; a < total; a += 1) {
    const w = Math.exp(logJoint[a] - logZ);
    for (let i = 0; i < n; i += 1) acc[i][Math.floor(a / strides[i]) % vars[i].domain] += w;
    if (logJoint[a] > bestLog) {
      bestLog = logJoint[a];
      bestIdx = a;
    }
  }
  const marginals = {};
  const assignment = {};
  for (let i = 0; i < n; i += 1) {
    const s = Math.floor(bestIdx / strides[i]) % vars[i].domain;
    marginals[vars[i].id] = Array.from(acc[i]);
    assignment[vars[i].id] = s;
  }
  return { marginals, map: { assignment, logJoint: bestLog } };
}

/** 用同一份图数据构建内核 FactorGraph */
function buildGraph(vars, factors) {
  const g = new FactorGraph();
  for (const v of vars) g.addVariable(v.id, v.domain, v.prior);
  for (const f of factors) g.addFactor(f.scope, f.table);
  return g;
}

/** 两组边缘分布的最大偏差（L∞） */
function maxDev(m1, m2) {
  let d = 0;
  for (const id of Object.keys(m1)) {
    const a = m1[id];
    const b = m2[id];
    for (let s = 0; s < a.length; s += 1) d = Math.max(d, Math.abs((a[s] ?? 0) - (b[s] ?? 0)));
  }
  return d;
}

/** 各边缘求和均为 1 */
function allNormalized(m, tol = 1e-12) {
  return Object.values(m).every((p) => Math.abs(p.reduce((s, x) => s + x, 0) - 1) <= tol);
}

// ═══════════════════ ① 随机树：BP = 精确边缘化 ═══════════════════

section('① 种子化随机树：sum-product 边缘 vs 暴力联合枚举');

{
  const rng = mulberry32(20261001);
  const randPositive = () => 0.05 + rng() * 1.95;
  const vars = Array.from({ length: 7 }, (_, i) => {
    const domain = rng() < 0.5 ? 2 : 3;
    const usePrior = rng() < 0.6;
    return {
      id: `x${i}`,
      domain,
      prior: usePrior ? Array.from({ length: domain }, randPositive) : undefined,
    };
  });
  // 随机父挂接树：x_i 挂在 x_0..x_{i-1} 之一（6 条成对因子，连通无圈）
  const factors = [];
  for (let i = 1; i < 7; i += 1) {
    const parent = Math.floor(rng() * i);
    const size = vars[parent].domain * vars[i].domain;
    factors.push({ scope: [vars[parent].id, vars[i].id], table: Array.from({ length: size }, randPositive) });
  }
  const truth = bruteForceGraph(vars, factors);
  const g = buildGraph(vars, factors);
  const report = g.runBeliefPropagation({ maxIter: 200, tol: 1e-12 });
  const m = g.marginals();
  ok(report.isTree && report.converged, `随机树：isTree=${report.isTree}，${report.iterations} 轮收敛（残差 ${report.residual.toExponential(2)}）`);
  const dev = maxDev(m, truth.marginals);
  ok(dev <= 1e-9, `BP 边缘 vs 暴力联合枚举 最大偏差 ${dev.toExponential(2)} ≤ 1e-9（7 变量、二/三值域、6 成对因子）`);
  ok(allNormalized(m), `全部边缘归一（Σ=1，容差 1e-12）`);
  const selfDev = maxDev(g.bruteForceMarginals(), truth.marginals);
  ok(selfDev <= 1e-9, `内核 bruteForceMarginals 与独立枚举一致（${selfDev.toExponential(2)} ≤ 1e-9）`);
  console.log(`    ${report.interpretation}`);

  // 第二棵树：含三值域因子（scope=3），测高阶消息路径；仍为二部树
  const rng2 = mulberry32(56);
  const rp2 = () => 0.05 + rng2() * 1.95;
  const vars2 = Array.from({ length: 6 }, (_, i) => ({
    id: `y${i}`,
    domain: rng2() < 0.5 ? 2 : 3,
    prior: Array.from({ length: 3 }, rp2),
  })).map((v) => ({ ...v, prior: v.prior.slice(0, v.domain) }));
  const ternarySize = vars2[0].domain * vars2[1].domain * vars2[2].domain;
  const factors2 = [
    { scope: ['y0', 'y1', 'y2'], table: Array.from({ length: ternarySize }, rp2) },
    { scope: ['y2', 'y3'], table: Array.from({ length: vars2[2].domain * vars2[3].domain }, rp2) },
    { scope: ['y3', 'y4'], table: Array.from({ length: vars2[3].domain * vars2[4].domain }, rp2) },
    { scope: ['y3', 'y5'], table: Array.from({ length: vars2[3].domain * vars2[5].domain }, rp2) },
  ];
  const truth2 = bruteForceGraph(vars2, factors2);
  const g2 = buildGraph(vars2, factors2);
  const report2 = g2.runBeliefPropagation({ maxIter: 200, tol: 1e-12 });
  ok(report2.isTree && report2.converged, `三值因子树：isTree=${report2.isTree}，${report2.iterations} 轮收敛`);
  const dev2 = maxDev(g2.marginals(), truth2.marginals);
  ok(dev2 <= 1e-9, `三值因子（scope=3）树上 BP 边缘 vs 枚举 最大偏差 ${dev2.toExponential(2)} ≤ 1e-9`);
}

// ═══════════════════ ② Ising 单环：loopy BP 不动点 ═══════════════════

section('② 二值 Ising 单环（8 节点）：loopy BP 不动点 vs 精确解');

{
  const J = 0.4;
  const n = 8;
  // 自旋 s = 2x−1；耦合 e^{J·s_i·s_j}（铁磁），交替场 ±0.12
  const ivars = Array.from({ length: n }, (_, i) => {
    const h = 0.12 * (i % 2 === 0 ? 1 : -1);
    return { id: `s${i}`, domain: 2, prior: [Math.exp(-h), Math.exp(h)] };
  });
  const ifactors = Array.from({ length: n }, (_, i) => ({
    scope: [`s${i}`, `s${(i + 1) % n}`],
    table: [Math.exp(J), Math.exp(-J), Math.exp(-J), Math.exp(J)],
  }));
  const truth = bruteForceGraph(ivars, ifactors);
  const ig = buildGraph(ivars, ifactors);
  const ibp = ig.runBeliefPropagation({ maxIter: 2000, tol: 1e-12, damping: 0.5 });
  ok(!ibp.isTree && ibp.converged, `含圈图识别正确（isTree=${ibp.isTree}），阻尼 0.5 于 ${ibp.iterations} 轮收敛`);
  const idev = maxDev(ig.marginals(), truth.marginals);
  ok(idev <= 0.01, `loopy BP 不动点 vs 枚举精确解 最大偏差 ${idev.toExponential(2)} ≤ 0.01（单环 O(tanh(J)^L) 口径：tanh(0.4)^8 ≈ 4.3e-4）`);
  const ig2 = buildGraph(ivars, ifactors);
  const ibp2 = ig2.runBeliefPropagation({ maxIter: 2000, tol: 1e-12, damping: 0 });
  ok(ibp2.converged, `无阻尼同样收敛（${ibp2.iterations} 轮 vs 阻尼 ${ibp.iterations} 轮——阻尼只改收敛速度）`);
  ok(maxDev(ig.marginals(), ig2.marginals()) <= 1e-6, `阻尼 / 无阻尼收敛到同一不动点（边缘差 ≤ 1e-6，正势单环不动点唯一）`);
  console.log(`    ${ibp.interpretation}`);
}

// ═══════════════════ ③ 链上 max-product = Viterbi MAP ═══════════════════

section('③ 链上 max-product 解码 vs 穷举 MAP（Viterbi 口径）');

{
  const rng = mulberry32(777);
  const rp = () => 0.05 + rng() * 1.95;
  const vars3 = Array.from({ length: 6 }, (_, i) => {
    const domain = rng() < 0.5 ? 2 : 3;
    const usePrior = rng() < 0.6;
    return { id: `c${i}`, domain, prior: usePrior ? Array.from({ length: domain }, rp) : undefined };
  });
  const factors = [];
  for (let i = 1; i < 6; i += 1) {
    const size = vars3[i - 1].domain * vars3[i].domain;
    factors.push({ scope: [`c${i - 1}`, `c${i}`], table: Array.from({ length: size }, rp) });
  }
  const truth = bruteForceGraph(vars3, factors);
  const g = buildGraph(vars3, factors);
  const dec = g.maxProductDecode({ maxIter: 300, tol: 1e-12 });
  ok(dec.exactOnTree && dec.converged, `链解码：exactOnTree=${dec.exactOnTree}，${dec.iterations} 轮收敛（链 = Viterbi 动态规划）`);
  const sameAssign = vars3.every((v) => dec.assignment[v.id] === truth.map.assignment[v.id]);
  ok(sameAssign, `指派与穷举 MAP 逐位一致（${vars3.map((v) => `${v.id}=${dec.assignment[v.id]}`).join(', ')}）`);
  ok(near(dec.logJoint, truth.map.logJoint, 1e-9), `logJoint=${dec.logJoint.toFixed(9)} = 穷举 MAP logJoint（差 ≤ 1e-9）`);
}

// ═══════════════════ ④ XOR 因子消息传播 ═══════════════════

section('④ XOR（偶校验）因子：消息传播手算对照');

{
  // 硬 XOR：ψ(a,b,c) = [a⊕b⊕c == 0]；先验 a=[0.9,0.1]、b=[0.3,0.7]、c 均匀
  // 手算：P(c=1) = P(a≠b) = 0.9·0.7 + 0.1·0.3 = 0.66；均匀回灌不改写强证据
  const g = new FactorGraph();
  g.addVariable('a', 2, [0.9, 0.1]);
  g.addVariable('b', 2, [0.3, 0.7]);
  g.addVariable('c', 2);
  g.addFactor(['a', 'b', 'c'], [1, 0, 0, 1, 0, 1, 1, 0]);
  const report = g.runBeliefPropagation({ maxIter: 100, tol: 1e-12 });
  const m = g.marginals();
  ok(report.isTree && report.converged, `XOR 图为树（星形），${report.iterations} 轮收敛`);
  ok(near(m.c[0], 0.34, 1e-9) && near(m.c[1], 0.66, 1e-9), `P(c) = [${m.c.map((x) => x.toFixed(6)).join(', ')}] —— 手算 P(c=1)=P(a≠b)=0.9·0.7+0.1·0.3=0.66 ✓`);
  ok(near(m.a[0], 0.9, 1e-9) && near(m.a[1], 0.1, 1e-9), `a 边缘保持先验 [0.9, 0.1]（回灌消息均匀，不改写强证据）`);
  ok(near(m.b[0], 0.3, 1e-9) && near(m.b[1], 0.7, 1e-9), `b 边缘保持先验 [0.3, 0.7]`);

  // 软 XOR（势 1 vs 0.15）：与独立枚举对照
  const xvars = [
    { id: 'a', domain: 2, prior: [0.9, 0.1] },
    { id: 'b', domain: 2, prior: [0.3, 0.7] },
    { id: 'c', domain: 2, prior: undefined },
  ];
  const xfactors = [{ scope: ['a', 'b', 'c'], table: [1, 0.15, 0.15, 1, 0.15, 1, 1, 0.15] }];
  const xtruth = bruteForceGraph(xvars, xfactors);
  const xg = buildGraph(xvars, xfactors);
  xg.runBeliefPropagation({ maxIter: 100, tol: 1e-12 });
  const xdev = maxDev(xg.marginals(), xtruth.marginals);
  ok(xdev <= 1e-9, `软 XOR（w=0.15）BP 边缘 vs 枚举 最大偏差 ${xdev.toExponential(2)} ≤ 1e-9`);
}

// ═══════════════════ ⑤ logSumExp 数值稳定 ═══════════════════

section('⑤ logSumExp 数值稳定：e^1000 级不溢出');

{
  const l1 = logSumExp([Math.log(1e6), Math.log(1e6), Math.log(1e6)]);
  ok(near(l1, Math.log(3e6), 1e-9), `LSE(ln1e6 ×3) = ${l1.toFixed(9)} = ln(3e6)（朴素求和 3e6 直接可加，锚定公式正确性）`);
  const l2 = logSumExp([1000, 1001]);
  ok(near(l2, 1001 + Math.log(1 + Math.exp(-1)), 1e-9), `LSE(1000,1001) = ${l2.toFixed(9)}（朴素 e^1001 = Infinity 上溢，此处精确）`);
  const l3 = logSumExp([-1000, -999]);
  ok(near(l3, -999 + Math.log(1 + Math.exp(-1)), 1e-9), `LSE(−1000,−999) = ${l3.toFixed(9)}（朴素 e^−1000 = 0 下溢成 −Inf，此处精确）`);
  ok(logSumExp([-Infinity, 3]) === 3, `−Inf 项被安全忽略（LSE([−Inf, 3]) = 3）`);
  ok(logSumExp([-Infinity, -Infinity]) === -Infinity, `全 −Inf → −Inf（硬约束空支持的正确极限）`);

  // e^±600 量级势表：朴素概率乘积必上溢，log 域 BP 与 log 域枚举一致
  const rng = mulberry32(5);
  const hvars = Array.from({ length: 4 }, (_, i) => ({ id: `h${i}`, domain: 2, prior: undefined }));
  const hfactors = [];
  for (let i = 1; i < 4; i += 1) {
    hfactors.push({
      scope: [`h${i - 1}`, `h${i}`],
      table: Array.from({ length: 4 }, () => Math.exp(rng() * 1200 - 600)),
    });
  }
  const htruth = bruteForceGraph(hvars, hfactors);
  const hg = buildGraph(hvars, hfactors);
  const hbp = hg.runBeliefPropagation({ maxIter: 200, tol: 1e-12 });
  const hdev = maxDev(hg.marginals(), htruth.marginals);
  ok(hbp.converged && hdev <= 1e-9, `e^±600 量级势表链式 BP（log 域）vs log 域枚举 最大偏差 ${hdev.toExponential(2)} ≤ 1e-9（朴素口径早已上溢 Infinity）`);
}

// ═══════════════════ ⑥ API 入参校验 ═══════════════════

section('⑥ API 入参校验：非法入参显式 throw');

{
  ok(throws(() => new FactorGraph().addVariable('', 2)), `空 id 拒绝`);
  ok(throws(() => new FactorGraph().addVariable('x', 1)), `离散域 < 2 拒绝`);
  const vg = new FactorGraph();
  vg.addVariable('x', 2);
  ok(throws(() => vg.addVariable('x', 2)), `重复变量拒绝`);
  ok(throws(() => vg.addVariable('y', 2, [1])), `先验长度 ≠ 域大小拒绝`);
  ok(throws(() => vg.addVariable('y', 2, [-1, 1])), `负先验拒绝`);
  ok(throws(() => vg.addVariable('y', 2, [0, 0])), `全零先验拒绝`);
  ok(throws(() => vg.addFactor(['nope'], [1, 1])), `未声明变量拒绝`);
  ok(throws(() => vg.addFactor([], [1])), `空 scope 拒绝`);
  ok(throws(() => vg.addFactor(['x'], [1])), `势表长度 ≠ 域积拒绝`);
  ok(throws(() => vg.addFactor(['x'], [1, -1])), `负势拒绝`);
  ok(throws(() => vg.addFactor(['x'], [0, 0])), `全零势表拒绝`);
  ok(throws(() => new FactorGraph().runBeliefPropagation()), `空图运行拒绝`);
  ok(throws(() => vg.marginals()), `未运行先取 marginals 拒绝`);
  ok(throws(() => vg.runBeliefPropagation({ damping: 1 })), `damping ≥ 1 拒绝`);
  ok(throws(() => vg.runBeliefPropagation({ maxIter: 0 })), `maxIter < 1 拒绝`);
  ok(throws(() => logSumExp([])), `logSumExp 空数组拒绝`);
  // 暴力对照的规模护栏：20 个二值变量 = 2^20 = 1,048,576 > 1e6 上限
  const bg = new FactorGraph();
  for (let i = 0; i < 20; i += 1) {
    bg.addVariable(`v${i}`, 2);
    if (i > 0) bg.addFactor([`v${i - 1}`, `v${i}`], [1, 2, 3, 4]);
  }
  ok(throws(() => bg.bruteForceMarginals()), `联合状态数 2^20 > 1e6 时暴力对照拒绝（大图走 BP，不走枚举）`);
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed === 0) {
  console.log('✅ 56.0 置信传播内核：树上精确边缘化 / loopy 不动点 / max-product MAP / logSumExp 稳定性 全部数学锚点成立');
} else {
  process.exit(1);
}
