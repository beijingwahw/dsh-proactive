/**
 * verify-r5-infogeo.mjs — R5-A5「信息几何五内核世界性进化」纯数学离线验证
 *
 * 覆盖内核（进化轴：数学 / 性能 / 数值稳健性 / 性质测试，种子化 ≥ 200 输入）：
 *   17.0 optimal-transport：精确一维 W_p（CDF 合并）；W₁ 度量公理（恒等/
 *       对称/三角，250 种子）；Sinkhorn 散度去偏（点测度任意 ε 精确、
 *       S(μ,μ)=0、正性、对称、ε→0 收敛 W₁）；热启动等价与迭代数收益；
 *       边际（KKT）残差；漂移事件确定性逻辑时钟
 *   18.0 information-geometry：symmetricEigen（Jacobi，精确特征对 + 正交性）；
 *       一维 Fisher 测地闭式（双曲锚 + 三角公理 250 种子）；d 维 Fisher
 *       路径长度（Totally-geodesic 切片精确退化、仿射不变 200 种子、对称、
 *       1 维 ≥ 闭式测地的上界性质）；自然梯度（定义性质 / 仿射等变 /
 *       Cauchy–Schwarz 最速锚）；引擎缺省 rng 确定性 + conditionNumber 精确化
 *   37.0 information-bottleneck：IB 曲线凹性 + β 单调 + 全点 DPI；确定性 IB
 *       （松弛界 F_dIB ≥ F_soft、β 两端、H(T)=I(X;T) 账目、贪心确定性）；
 *       200 种子随机联合 DPI 电池
 *   70.0 partial-info-decomposition：BROJA 一阶 KKT 残差证书（内点最优
 *       钉死 / AND 边界最优如实暴露）；线搜索早停等价性 + 求值数节省；
 *       220 种子随机联合守恒/局部一致/界/可行性/单调电池
 *   68.0 compression-distance：LZ77 压缩器（计费恒等式、高重复压得动、
 *       高熵压不动）；NCD 分辨率提升量化（自距离 LZW 0.41 → LZ77 ~0.0x）；
 *       对称/非负 200 种子；压缩缓存（命中审计、FIFO 逐出、逐位等价、
 *       冷/暖墙钟）
 *
 * 全部断言确定性（mulberry32 种子化；无 Math.random/Date.now 参与判定）。
 * 运行：node --experimental-transform-types scripts/verify-r5-infogeo.mjs
 */

import {
  wasserstein1D,
  wassersteinExact1D,
  sinkhorn,
  sinkhornDivergence,
  TransportDriftMonitor,
} from '../src/core/optimal-transport.ts';
import {
  symmetricEigen,
  shrinkageCovariance,
  fisherDistance1D,
  gaussianFisherPathLength,
  naturalGradient,
  FisherGeometryEngine,
} from '../src/core/information-geometry.ts';
import {
  informationBottleneck,
  ibCurve,
  deterministicIB,
} from '../src/core/information-bottleneck.ts';
import { pidFromJoint, bivariateGates } from '../src/core/partial-info-decomposition.ts';
import {
  lzwCompress,
  compressedBits,
  ncd,
  ncdMatrix,
  ncdLz77,
  lz77Compress,
  ncdCacheStats,
  resetNcdCache,
  pseudoRandomString,
} from '../src/core/compression-distance.ts';

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
function gaussianMaker(seed) {
  const rng = mulberry32(seed);
  return () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const maxAbs = (xs) => xs.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

// ═══════════════════════════════════════════════════════════════════
// 17.0 最优传输：精确一维 W_p / Sinkhorn 散度去偏 / 热启动 / KKT 残差
// ═════════════════════════════════════════════════════════════════════════════

section('17.0-① 精确一维 Wasserstein-p：CDF 西北角合并（解析锚）');

ok(near(wassersteinExact1D([0.6, 0.6, 0.6, 0.6], [0.9, 0.9, 0.9, 0.9]), 0.3, 1e-12), `W₁(点测度) = ${wassersteinExact1D([0.6, 0.6, 0.6, 0.6], [0.9, 0.9, 0.9, 0.9])}（精确 0.3，不是网格近似的 0.299…）`);
ok(near(wassersteinExact1D([0, 0, 1, 1], [0.5, 0.5, 1.5, 1.5], 1), 0.5, 1e-12), 'W₁([0,0,1,1],[0.5,0.5,1.5,1.5]) = 0.5（逐秩配对手算锚）');
ok(near(wassersteinExact1D([0, 0, 1, 1], [0.5, 0.5, 1.5, 1.5], 2), 0.5, 1e-12), 'W₂ 同例 = 0.5（|Δ|ᵖ 常数退化手算锚）');
ok(near(wassersteinExact1D([0], [0, 2]), 1, 1e-12), 'W₁([0],[0,2]) = 1（不等样本数：0↔0 一半质量 + 0↔2 一半，CDF 面积手算锚）');
ok(wassersteinExact1D([], [1, 2]) === 0 && wassersteinExact1D([1], []) === 0, '空样本诚实返回 0（边界）');
ok(throwsOk(() => wassersteinExact1D([1], [1], 0)), 'wassersteinExact1D(p=0) throw（p ≥ 1 纪律）');

function throwsOk(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

section('17.0-② W₁ 度量公理：恒等 / 对称 / 三角（250 种子三元组）');

{
  const rng = mulberry32(20261002);
  const randSamples = (n) => Array.from({ length: n }, () => rng() * 10);
  let identityOk = true;
  let symmetryOk = true;
  let triangleExact = true;
  let triangleGrid = true;
  let worstTriangle = 0;
  let gapSum = 0;
  let gapMax = 0;
  for (let trial = 0; trial < 250; trial += 1) {
    const a = randSamples(4 + Math.floor(rng() * 60));
    const b = randSamples(4 + Math.floor(rng() * 60));
    const c = randSamples(4 + Math.floor(rng() * 60));
    if (wassersteinExact1D(a, a) !== 0) identityOk = false;
    const ab = wassersteinExact1D(a, b);
    const ba = wassersteinExact1D(b, a);
    if (ab !== ba) symmetryOk = false;
    const ac = wassersteinExact1D(a, c);
    const bc = wassersteinExact1D(b, c);
    const slack = ac - ab - bc;
    if (slack > worstTriangle) worstTriangle = slack;
    if (slack > 1e-9) triangleExact = false;
    const gab = wasserstein1D(a, b);
    const gac = wasserstein1D(a, c);
    const gbc = wasserstein1D(b, c);
    if (gac - gab - gbc > 1e-9) triangleGrid = false;
    const gap = Math.abs(gab - ab);
    gapSum += gap;
    if (gap > gapMax) gapMax = gap;
  }
  ok(identityOk, '恒等公理：W₁(a,a) = 0（250 种子，逐位精确——排序自配对退化）');
  ok(symmetryOk, '对称公理：W₁(a,b) === W₁(b,a)（250 种子，逐位精确相等）');
  ok(triangleExact, `三角不等式：精确 W₁ 全部满足（250 种子三元组，最坏松弛 ${worstTriangle.toExponential(2)} ≤ 0——精确合并是真度量）`);
  ok(triangleGrid, '三角不等式：网格 W₁ 同样全部满足（固定分位网格逐点 |·| 的三角逐点成立）');
  ok(gapSum / 250 < 0.1, `网格口径 vs 精确口径（数据域 [0,10]）：平均偏差 ${(gapSum / 250).toFixed(4)}（<1% 数据跨度）、最大 ${gapMax.toFixed(4)}（256 网格分位插值的量化尘埃——精确合并版是其零网格极限）`);
}

section('17.0-③ Sinkhorn：热启动等价 + 迭代收益 + 边际（KKT）残差');

{
  const rng = mulberry32(777);
  const n = 6;
  const cost = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Math.abs(i - j) + 0.3 * rng()));
  const a = Array.from({ length: n }, () => 0.1 + rng());
  const b0 = Array.from({ length: n }, () => 0.1 + rng());
  const cfg = { epsilon: 0.03, maxIterations: 5000, tolerance: 1e-12 };
  const cold = sinkhorn(cost, a, b0, cfg);
  ok(cold.converged && cold.marginalResidual < 1e-6, `冷启动收敛：${cold.iterations} 次迭代，对偶势残差 ${cold.residual.toExponential(2)}，边际（KKT）残差 ${cold.marginalResidual.toExponential(2)} < 1e-6（约束满足度直接读数）`);
  // 热启动 1：同一问题从上一解起步 → 一步收敛、同解（不动点唯一）
  const warmSame = sinkhorn(cost, a, b0, { ...cfg, warmStart: cold.potentials });
  const planDiff = maxAbs(cold.plan.flatMap((row, i) => row.map((v, j) => v - warmSame.plan[i][j])));
  ok(warmSame.converged && warmSame.iterations <= 2, `热启动（同问题）：${cold.iterations} → ${warmSame.iterations} 次迭代（对偶势已是不动点，一步判定收敛）`);
  ok(planDiff < 1e-9, `热启动解一致：max|Δπ| = ${planDiff.toExponential(2)} < 1e-9（Hilbert 度量不动点唯一，冷/热同解）`);
  // 热启动 2：邻近问题（质量微扰 5%）——迭代数严格下降
  const b1 = b0.map((v) => v * (1 + 0.05 * (rng() - 0.5)));
  const cold2 = sinkhorn(cost, a, b1, cfg);
  const warm2 = sinkhorn(cost, a, b1, { ...cfg, warmStart: cold.potentials });
  const planDiff2 = maxAbs(cold2.plan.flatMap((row, i) => row.map((v, j) => v - warm2.plan[i][j])));
  ok(
    cold2.converged && warm2.converged && warm2.iterations < cold2.iterations && planDiff2 < 1e-7,
    `热启动（邻近问题，质量微扰 5%）：迭代 ${cold2.iterations} → ${warm2.iterations}（节省 ${(((cold2.iterations - warm2.iterations) / cold2.iterations) * 100).toFixed(0)}%），max|Δπ| = ${planDiff2.toExponential(2)}（序列问题的不动点跟踪）`,
  );
  // 退化输入诚实路径
  const degen = sinkhorn(cost, [], [1], cfg);
  ok(!degen.converged && degen.residual === Infinity && degen.marginalResidual === Infinity, '空质量：converged=false、residual=∞、marginalResidual=∞（诚实退化路径）');
}

section('17.0-④ Sinkhorn 散度（去偏）：点测度精确 / 自零 / 正性 / 对称 / ε→0');

{
  // 点测度（并支撑代价矩阵）：S_ε = W 精确成立（任意 ε——−ε 偏置被自能项各回补 ε/2）
  const unionCost = [
    [0, 0.3],
    [0.3, 0],
  ];
  for (const eps of [2, 0.5, 0.05, 0.005]) {
    const sd = sinkhornDivergence(unionCost, [1, 0], [0, 1], { epsilon: eps, maxIterations: 5000, tolerance: 1e-13 });
    ok(near(sd.divergence, 0.3, 1e-10) && near(sd.biasedCost, 0.3, 1e-10), `点测度 ε=${eps}：S_ε = ${sd.divergence.toFixed(12)}（精确 0.3——OT_ε 主项 ${sd.otEps.toFixed(4)} = 0.3−ε、两自能项 ${sd.selfTermLeft.toFixed(4)} = −ε，去偏对任意 ε 逐位成立）`);
  }
  // 自零：S(μ,μ) = 0
  const rng = mulberry32(4242);
  const mkMass = (n) => {
    const w = Array.from({ length: n }, () => 0.2 + rng());
    const s = sum(w);
    return w.map((v) => v / s);
  };
  let selfMax = 0;
  for (let k = 0; k < 20; k += 1) {
    const mu = mkMass(5);
    const cost = Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (_, j) => Math.abs(i - j) + 0.2 * rng()));
    const sd = sinkhornDivergence(cost, mu, mu, { epsilon: 0.1, maxIterations: 8000, tolerance: 1e-13 });
    selfMax = Math.max(selfMax, Math.abs(sd.divergence));
  }
  ok(selfMax < 1e-6, `自零性：|S_ε(μ,μ)| 最大 ${selfMax.toExponential(2)} < 1e-6（20 种子——带偏 ⟨C,π_ε⟩ 无此性质，去偏的核心收益）`);
  // 正性 + 对称 + ε→0 收敛 W₁
  const positions = [0, 1, 2, 3, 4, 5, 6, 7];
  const wa = mkMass(8);
  const wb = mkMass(8);
  const costGrid = positions.map((x) => positions.map((y) => Math.abs(x - y)));
  // 独立参照：位置空间 CDF 合并 W₁（脚本内第二实现，交叉对照）
  function w1Discrete(xs, w1, ys, w2) {
    const events = [...new Set([...xs, ...ys])].sort((p, q) => p - q);
    let fa = 0;
    let fb = 0;
    let acc = 0;
    let ia = 0;
    let ib = 0;
    let prev = events[0];
    for (const e of events) {
      acc += (e - prev) * Math.abs(fa - fb);
      while (ia < xs.length && xs[ia] <= e) {
        fa += w1[ia];
        ia += 1;
      }
      while (ib < ys.length && ys[ib] <= e) {
        fb += w2[ib];
        ib += 1;
      }
      prev = e;
    }
    return acc;
  }
  const w1True = w1Discrete(positions, wa, positions, wb);
  const errs = [];
  for (const eps of [0.3, 0.1, 0.05, 0.02]) {
    const sd = sinkhornDivergence(costGrid, wa, wb, { epsilon: eps, maxIterations: 30000, tolerance: 1e-13 });
    errs.push(Math.abs(sd.divergence - w1True));
  }
  ok(errs[errs.length - 1] < 0.05 && errs[errs.length - 1] < errs[0], `ε→0 收敛：|S_ε − W₁| 随 ε 下降 [${errs.map((e) => e.toFixed(4)).join(' → ')}]（W₁ 独立参照 ${w1True.toFixed(4)}——去偏散度收敛到真传输距离，带偏 ⟨C,π_ε⟩ 含 O(ε) 膨胀）`);
  // 对称性
  const sAB = sinkhornDivergence(costGrid, wa, wb, { epsilon: 0.08, maxIterations: 30000, tolerance: 1e-13 });
  const sBA = sinkhornDivergence(costGrid, wb, wa, { epsilon: 0.08, maxIterations: 30000, tolerance: 1e-13 });
  ok(Math.abs(sAB.divergence - sBA.divergence) < 1e-7, `对称性：|S(a,b) − S(b,a)| = ${Math.abs(sAB.divergence - sBA.divergence).toExponential(2)} < 1e-7（对称代价 + 紧容差）`);
  // 正性：共享支撑 + 对称代价（Feydy et al. 2019 定理设定）
  let positive = true;
  let posMin = Infinity;
  for (let k = 0; k < 60; k += 1) {
    const m = 3 + Math.floor(rng() * 5);
    const xs = Array.from({ length: m }, () => rng());
    const cSq = xs.map((x) => xs.map((y) => (x - y) * (x - y)));
    const mu = mkMass(m);
    const nu = mkMass(m);
    const sd = sinkhornDivergence(cSq, mu, nu, { epsilon: 0.15, maxIterations: 20000, tolerance: 1e-12 });
    if (sd.divergence <= 0) positive = false;
    posMin = Math.min(posMin, sd.divergence);
  }
  ok(positive, `正性：60 种子共享支撑（C=‖x−y‖² 对称）不同分布对全部 S_ε > 0（最小 ${posMin.toExponential(3)}——Feydy et al. 2019 定理设定的数值见证；一般非对称交叉代价不保证正性，文档已诚实边界化）`);
}

section('17.0-⑤ 漂移监视器：事件审计确定性逻辑时钟（Date.now 移除）');

{
  const runMonitor = () => {
    const m = new TransportDriftMonitor({ windowSize: 30, referenceSize: 120, minSamples: 15 });
    let s = 42;
    const r = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 100; i += 1) m.observe(0.5 + 0.1 * (r() - 0.5));
    for (let i = 0; i < 40; i += 1) m.observe(i % 2 === 0 ? 0.15 : 0.85);
    for (let i = 0; i < 80; i += 1) m.observe(0.5 + 0.1 * (r() - 0.5)); // 回稳 → 第二个翻转沿
    return m.recentEvents(20);
  };
  const ev1 = runMonitor();
  const ev2 = runMonitor();
  const increasing = ev1.every((e, i) => i === 0 || e.at > ev1[i - 1].at);
  ok(ev1.length >= 2 && increasing && Number.isInteger(ev1[0].at), `事件 at = 观测序号（逻辑时钟）：${ev1.map((e) => e.at).join(',')} 严格递增整数（原 Date.now 口径不可复现，现全程确定性）`);
  ok(JSON.stringify(ev1) === JSON.stringify(ev2), '两次相同观测序列 → 事件审计 JSON 逐位相同（内核零墙钟/零随机依赖）');
}

// ═══════════════════════════════════════════════════════════════════
// 18.0 信息几何：Jacobi 特征解 / Fisher 测地距离 / 自然梯度 / 确定性
// ═══════════════════════════════════════════════════════════════════

section('18.0-① symmetricEigen（Jacobi）：精确特征对 + 正交性 + 确定性');

{
  const theta = 0.7;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const Q = [
    [c, -s],
    [s, c],
  ];
  // A = Q diag(2,5) Qᵀ
  const A = [
    [2 * c * c + 5 * s * s, (2 - 5) * c * s],
    [(2 - 5) * c * s, 2 * s * s + 5 * c * c],
  ];
  const eig = symmetricEigen(A);
  ok(near(eig.values[0], 2, 1e-10) && near(eig.values[1], 5, 1e-10), `旋转矩阵特征值 = [${eig.values.map((v) => v.toFixed(9)).join(', ')}]（精确 {2,5}——非对角耦合被 Jacobi 旋转完全消化）`);
  // V 正交（VᵀV = I）
  const v0 = eig.vectors[0];
  const v1 = eig.vectors[1];
  const dot01 = sum(v0.map((x, i) => x * v1[i]));
  ok(Math.abs(dot01) < 1e-10 && near(sum(v0.map((x) => x * x)), 1, 1e-10) && near(sum(v1.map((x) => x * x)), 1, 1e-10), `特征向量正交归一（|⟨v₀,v₁⟩| = ${Math.abs(dot01).toExponential(2)}）`);
  // 重构 A = Σ λ v vᵀ
  const rec = A.map((row, i) => row.map((_, j) => sum(eig.values.map((lv, k) => lv * eig.vectors[k][i] * eig.vectors[k][j]))));
  const recErr = maxAbs(rec.flatMap((row, i) => row.map((v, j) => v - A[i][j])));
  ok(recErr < 1e-10, `谱重构 ‖A − QΛQᵀ‖_max = ${recErr.toExponential(2)} < 1e-10（特征对完备自洽）`);
  ok(JSON.stringify(symmetricEigen(A)) === JSON.stringify(symmetricEigen(A)), '同输入同输出（纯数学确定性——替代随机 Rayleigh 估计）');
}

section('18.0-② 一维 Fisher 测地距离：双曲闭式锚 + 度量公理（250 种子）');

{
  ok(fisherDistance1D(1, 2, 1, 2) === 0, 'd(θ,θ) = 0（恒等）');
  ok(near(fisherDistance1D(0, 2, 0, 6), Math.SQRT2 * Math.log(3), 1e-12), `纯 σ 位移 = √2·|ln(σ₂/σ₁)| = ${(Math.SQRT2 * Math.log(3)).toFixed(10)}（0.5 缩放 AIRM 精确锚）`);
  const meanOnly = fisherDistance1D(0, 1, 2, 1);
  const meanAnchor = Math.SQRT2 * Math.acosh(2); // √2·arccosh(1 + Δμ²/(4σ²)), Δμ=2σ
  ok(near(meanOnly, meanAnchor, 1e-12) && meanOnly < 2, `纯 μ 位移（Δμ=2σ）d = ${meanOnly.toFixed(10)} = √2·arccosh(2) = ${meanAnchor.toFixed(10)} 精确锚，且 < |Δμ|/σ = 2（测地抄近道：双曲面下半圆短于水平线——固定 σ 子流形路径只是上界）`);
  ok(Math.abs(fisherDistance1D(0, 1, 0.01, 1) - 0.01) < 1e-5, `小 Δμ 极限 → |Δμ|/σ（Mahalanobis 一阶）：d = ${fisherDistance1D(0, 1, 0.01, 1).toFixed(8)}`);
  const rng = mulberry32(1818);
  let symOk = true;
  let triOk = true;
  let worstTri = 0;
  for (let k = 0; k < 250; k += 1) {
    const p1 = [rng() * 5 - 2, 0.3 + rng() * 2];
    const p2 = [rng() * 5 - 2, 0.3 + rng() * 2];
    const p3 = [rng() * 5 - 2, 0.3 + rng() * 2];
    const d12 = fisherDistance1D(...p1, ...p2);
    const d21 = fisherDistance1D(...p2, ...p1);
    if (Math.abs(d12 - d21) > 1e-12) symOk = false;
    const d13 = fisherDistance1D(...p1, ...p3);
    const d23 = fisherDistance1D(...p2, ...p3);
    const slack = d13 - d12 - d23;
    if (slack > worstTri) worstTri = slack;
    if (slack > 1e-9) triOk = false;
  }
  ok(symOk, '对称性：250 种子 |d(a,b) − d(b,a)| ≤ 1e-12（闭式对称）');
  ok(triOk, `三角不等式：250 种子全部满足（最坏松弛 ${worstTri.toExponential(2)} ≤ 0——曲率 −½ 双曲面是真度量空间）`);
}

section('18.0-③ d 维 Fisher 路径长度：切片精确退化 + 仿射不变（200 种子）+ 对称 + 上界');

{
  // 切片 1：Σ 固定 → 精确 Mahalanobis
  const Sigma = [
    [2, 0.6],
    [0.6, 1],
  ];
  const mu1 = [0, 0];
  const mu2 = [1, -2];
  // 手算 √(ΔμᵀΣ⁻¹Δμ)
  const det = Sigma[0][0] * Sigma[1][1] - Sigma[0][1] * Sigma[1][0];
  const Sinv = [
    [Sigma[1][1] / det, -Sigma[0][1] / det],
    [-Sigma[1][0] / det, Sigma[0][0] / det],
  ];
  const dmu = [1, -2];
  const maha = Math.sqrt(dmu[0] * (Sinv[0][0] * dmu[0] + Sinv[0][1] * dmu[1]) + dmu[1] * (Sinv[1][0] * dmu[0] + Sinv[1][1] * dmu[1]));
  const L1 = gaussianFisherPathLength(mu1, Sigma, mu2, Sigma);
  ok(near(L1.pathLength, maha, 1e-9), `Σ 固定切片：L = ${L1.pathLength.toFixed(10)} = Mahalanobis ${maha.toFixed(10)}（精确退化，1e-9）`);
  // 切片 2：μ 固定 → 精确 ½AIRM；1 维锚 √2|ln(σ₂/σ₁)|
  const L2 = gaussianFisherPathLength([0, 0], Sigma, [0, 0], [[3, 0.5], [0.5, 2]]);
  // 二次公式独立对照：[[3,0.5],[0.5,2]] 特征值 = (5 ± √2)/2
  const eigRef = { values: [(5 - Math.SQRT2) / 2, (5 + Math.SQRT2) / 2] };
  const eigKernel = symmetricEigen([[3, 0.5], [0.5, 2]]);
  // 广义特征值 λ(Σ₁⁻¹Σ₂)：手算 Σ₂ v = λ Σ₁ v ⇒ 解 2×2 广义问题
  const genEigen = (() => {
    // 求解 (Σ₂ − λΣ₁)v = 0 的行列式零点
    const A = [[Sigma[0][0], Sigma[0][1]], [Sigma[1][0], Sigma[1][1]]];
    const B = [[3, 0.5], [0.5, 2]];
    // det(B − λA) = (b00−λa00)(b11−λa11) − (b01−λa01)(b10−λa10)
    const q = (M) => M[0][0] * M[1][1] - M[0][1] * M[1][0];
    const c2 = q(A);
    const c0 = q(B);
    const c1 = -(B[0][0] * A[1][1] + B[1][1] * A[0][0] - B[0][1] * A[1][0] - B[1][0] * A[0][1]);
    const disc = Math.sqrt(c1 * c1 - 4 * c2 * c0);
    return [(-c1 - disc) / (2 * c2), (-c1 + disc) / (2 * c2)];
  })();
  const airmHalf = Math.sqrt(0.5 * sum(genEigen.map((l) => Math.log(l) ** 2)));
  ok(near(L2.pathLength, airmHalf, 1e-9) && near(L2.covarianceDistance, airmHalf, 1e-9), `μ 固定切片：L = ${L2.pathLength.toFixed(10)} = √(½Σln²λ) = ${airmHalf.toFixed(10)}（½AIRM 精确退化；手算广义特征值 [${genEigen.map((l) => l.toFixed(6)).join(', ')}]）`);
  ok(near(eigKernel.values[0], eigRef.values[0], 1e-12) && near(eigKernel.values[1], eigRef.values[1], 1e-12), `symmetricEigen 二次公式交叉对照：[${eigKernel.values.map((v) => v.toFixed(10)).join(', ')}] vs [(5±√2)/2]（独立验证）`);
  const L1d = gaussianFisherPathLength([0], [[4]], [0], [[9]]);
  ok(near(L1d.pathLength, Math.SQRT2 * Math.log(3 / 2), 1e-12), `1 维 σ 位移：L = ${L1d.pathLength.toFixed(10)} = √2·ln(σ₂/σ₁)（σ=2→3 精确锚）`);
  // 同点归零
  const selfL = gaussianFisherPathLength([1, 2], Sigma, [1, 2], Sigma).pathLength;
  ok(Math.abs(selfL) <= 1e-12, `L(θ,θ) = ${selfL.toExponential(2)} ≈ 0（恒等——浮点上 λ=1±ε 的 ln² 尘埃级）`);
  // 仿射不变 + 对称 + 1 维上界（200 种子）
  const rng = mulberry32(5150);
  const g = gaussianMaker(5151);
  const mkPd = (d) => {
    const M = Array.from({ length: d }, () => Array.from({ length: d }, () => g() * 0.4));
    const MMt = M.map((row, i) => M.map((_, j) => sum(M[i].map((v, k) => v * M[j][k]))));
    return MMt.map((row, i) => row.map((v, j) => v + (i === j ? 0.5 : 0)));
  };
  const matMul = (X, Y) => X.map((row, i) => Y[0].map((_, j) => sum(row.map((v, k) => v * Y[k][j]))));
  const matVec = (X, v) => X.map((row) => sum(row.map((a, j) => a * v[j])));
  const randInvertible = (d) => {
    const M = Array.from({ length: d }, () => Array.from({ length: d }, () => g()));
    return M.map((row, i) => row.map((v, j) => v + (i === j ? 2.5 : 0)));
  };
  const inv2 = (M) => {
    const dt = M[0][0] * M[1][1] - M[0][1] * M[1][0];
    return [
      [M[1][1] / dt, -M[0][1] / dt],
      [-M[1][0] / dt, M[0][0] / dt],
    ];
  };
  const inv3 = (M) => {
    // 伴随法 3×3 逆
    const cof = (i, j) => {
      const rows = [0, 1, 2].filter((r) => r !== i);
      const cols = [0, 1, 2].filter((c) => c !== j);
      const m = (M[rows[0]][cols[0]] * M[rows[1]][cols[1]] - M[rows[0]][cols[1]] * M[rows[1]][cols[0]]) * ((i + j) % 2 === 0 ? 1 : -1);
      return m;
    };
    const dt = M[0][0] * cof(0, 0) + M[0][1] * cof(0, 1) + M[0][2] * cof(0, 2);
    return Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) => cof(j, i) / dt));
  };
  let invOk = true;
  let invWorst = 0;
  let symOk = true;
  let symWorst = 0;
  let boundOk = true;
  let gapSum = 0;
  let gapCount = 0;
  for (let k = 0; k < 200; k += 1) {
    const d = k % 2 === 0 ? 2 : 3;
    const S1 = mkPd(d);
    const S2 = mkPd(d);
    const m1 = Array.from({ length: d }, () => rng() * 2 - 1);
    const m2 = Array.from({ length: d }, () => rng() * 2 - 1);
    const A = randInvertible(d);
    const At = A[0].map((_, j) => A.map((row) => row[j]));
    const AS1A = matMul(matMul(A, S1), At);
    const AS2A = matMul(matMul(A, S2), At);
    const Am1 = matVec(A, m1);
    const Am2 = matVec(A, m2);
    const l0 = gaussianFisherPathLength(m1, S1, m2, S2).pathLength;
    const l1 = gaussianFisherPathLength(Am1, AS1A, Am2, AS2A).pathLength;
    const invGap = Math.abs(l0 - l1);
    if (invGap > invWorst) invWorst = invGap;
    if (invGap > 1e-6) invOk = false;
    const lBack = gaussianFisherPathLength(m2, S2, m1, S1).pathLength;
    if (Math.abs(l0 - lBack) > symWorst) symWorst = Math.abs(l0 - lBack);
    if (Math.abs(l0 - lBack) > 1e-7) symOk = false;
    if (d === 1 || k % 7 === 0) {
      // 1 维对照（上界性质）：路径长度 ≥ 精确测地
      const s1 = 0.4 + rng() * 1.6;
      const s2 = 0.4 + rng() * 1.6;
      const muA = rng() * 2 - 1;
      const muB = rng() * 2 - 1;
      const Ld = gaussianFisherPathLength([muA], [[s1 * s1]], [muB], [[s2 * s2]]).pathLength;
      const dExact = fisherDistance1D(muA, s1, muB, s2);
      if (Ld < dExact - 1e-9) boundOk = false;
      gapSum += Ld / Math.max(dExact, 1e-12);
      gapCount += 1;
    }
  }
  ok(invOk, `仿射不变性：200 种子随机可逆 A，|L(θ) − L(Aθ)| 最大 ${invWorst.toExponential(2)} ≤ 1e-6（d=2/3 混合——路径两段各自协变）`);
  ok(symOk, `对称性：|L(a,b) − L(b,a)| 最大 ${symWorst.toExponential(2)} ≤ 1e-7（AIRM 测地可逆 + 积分区间对称）`);
  ok(boundOk, '上界性质（1 维抽样）：L ≥ d_F 闭式测地全部成立（路径长度 ≥ 测地长度的定义性检验）');
  ok(gapSum / gapCount < 1.25, `上界紧致度：平均 L/d_F = ${(gapSum / gapCount).toFixed(4)} < 1.25（${gapCount} 个抽样——线性 μ 路径相对测地的典型溢价）`);
  // 非法输入
  ok(throwsOk(() => gaussianFisherPathLength([0], [[0]], [0], [[1]])), '奇异协方差 throw（正定性纪律）');
  ok(throwsOk(() => fisherDistance1D(0, -1, 0, 1)), 'fisherDistance1D(σ≤0) throw（边界纪律）');
}

section('18.0-④ 自然梯度（Σ·∇L）：定义性质 / 仿射等变（200 种子）/ Cauchy–Schwarz 最速锚');

{
  const rng = mulberry32(9090);
  const g = gaussianMaker(9091);
  const mkPd = (d) => {
    const M = Array.from({ length: d }, () => Array.from({ length: d }, () => g() * 0.5));
    return M.map((row, i) => row.map((v, j) => sum(M[i].map((x, k) => x * M[j][k])) + (i === j ? 0.3 : 0)));
  };
  // 逆作用 Σ⁻¹·v（脚本侧独立实现：Jacobi-free 的共轭梯度太重，直接 2×2/3×3 闭式/特征）
  const invApply = (S, v) => {
    const d = v.length;
    const eig = symmetricEigen(S);
    const qtv = eig.vectors.map((q) => sum(q.map((x, i) => x * v[i])));
    return Array.from({ length: d }, (_, i) => sum(eig.vectors.map((q, k) => (q[i] * qtv[k]) / Math.max(eig.values[k], 1e-12))));
  };
  // 定义性质：Σ⁻¹·grad = ∇L（⟨grad,v⟩_F = ∇Lᵀv 的矩阵形式）
  let defOk = true;
  let defWorst = 0;
  for (let k = 0; k < 200; k += 1) {
    const d = (k % 3) + 1;
    const S = mkPd(d);
    const grad = Array.from({ length: d }, () => g());
    const ng = naturalGradient(S, grad);
    const resid = maxAbs(invApply(S, ng).map((v, i) => v - grad[i]));
    if (resid > defWorst) defWorst = resid;
    if (resid > 1e-9) defOk = false;
  }
  ok(defOk, `定义性质：max|Σ⁻¹·(Σ∇L) − ∇L| = ${defWorst.toExponential(2)} ≤ 1e-9（200 种子——⟨grad,v⟩_F = ∇Lᵀv 的矩阵形式）`);
  // 仿射等变：F(AΣAᵀ)⁻¹·A⁻ᵀ∇L = A·F(Σ)⁻¹∇L（自然梯度步 y = Aθ 协变）
  const matMul = (X, Y) => X.map((row) => Y[0].map((_, j) => sum(row.map((v, k) => v * Y[k][j]))));
  const matVec = (X, v) => X.map((row) => sum(row.map((a, j) => a * v[j])));
  const inv2 = (M) => {
    const dt = M[0][0] * M[1][1] - M[0][1] * M[1][0];
    return [
      [M[1][1] / dt, -M[0][1] / dt],
      [-M[1][0] / dt, M[0][0] / dt],
    ];
  };
  const transp = (M) => M[0].map((_, j) => M.map((row) => row[j]));
  let equivOk = true;
  let equivWorst = 0;
  for (let k = 0; k < 200; k += 1) {
    const S = mkPd(2);
    const grad = [g(), g()];
    const A = [
      [g() + 2.2, g() * 0.4],
      [g() * 0.4, g() + 1.7],
    ];
    const SA = matMul(matMul(A, S), transp(A));
    const gradY = matVec(transp(inv2(A)), grad); // ∇_yL = A⁻ᵀ∇_xL
    const ngX = naturalGradient(S, grad);
    const ngY = naturalGradient(SA, gradY);
    const expected = matVec(A, ngX);
    const diff = maxAbs(ngY.map((v, i) => v - expected[i]));
    if (diff > equivWorst) equivWorst = diff;
    if (diff > 1e-7) equivOk = false;
  }
  ok(equivOk, `仿射等变：max|F(AΣAᵀ)⁻¹A⁻ᵀ∇L − A·F(Σ)⁻¹∇L| = ${equivWorst.toExponential(2)} ≤ 1e-7（200 种子——自然梯度步 y = Aθ 协变，坐标绑架解除）`);
  // 最速方向（Cauchy–Schwarz 取等）：单位 Fisher 球上 max gᵀv = √(gᵀΣg)，取等方向 ∝ Σg
  let steepestOk = true;
  let csOk = true;
  for (let k = 0; k < 100; k += 1) {
    const S = mkPd(2);
    const grad = [g(), g()];
    const ng = naturalGradient(S, grad); // = Σg（最速方向本体）
    const wNormF = Math.sqrt(Math.abs(sum(ng.map((x, i) => x * invApply(S, ng)[i])))); // ‖Σg‖_F = √((Σg)ᵀΣ⁻¹Σg) = √(gᵀΣg)
    const vStar = ng.map((x) => x / wNormF);
    const gain = sum(grad.map((gg, i) => gg * vStar[i]));
    // Cauchy–Schwarz：max_{‖v‖_F=1} gᵀv = ‖Σg‖_F（取等方向 v* ∝ Σg）
    if (Math.abs(gain - wNormF) > 1e-8) csOk = false;
    for (let t = 0; t < 30; t += 1) {
      const z = [g(), g()];
      const wz = naturalGradient(S, z);
      const zzNormF = Math.sqrt(Math.abs(sum(wz.map((x, i) => x * invApply(S, wz)[i]))));
      const v = wz.map((x) => x / zzNormF);
      if (sum(grad.map((gg, i) => gg * v[i])) > gain + 1e-9) steepestOk = false;
    }
  }
  ok(steepestOk, '最速方向：100 种子 × 30 随机单位 Fisher 方向，无一超过 v* ∝ Σ∇L 的方向导数（黎曼最速上升）');
  ok(csOk, 'Cauchy–Schwarz 取等：gᵀv* = ‖Σ∇L‖_F = √(∇LᵀΣ∇L)（100 种子，1e-8——最优增益解析值精确命中）');
}

section('18.0-⑤ 引擎确定性：缺省 rng 序列 + conditionNumber 精确化');

{
  const points = [
    [0.2, 0.8],
    [0.25, 0.75],
    [0.3, 0.7],
    [0.22, 0.78],
    [0.28, 0.72],
  ];
  const e1 = new FisherGeometryEngine({ klBudget: 1.5 });
  const e2 = new FisherGeometryEngine({ klBudget: 1.5 });
  e1.estimate(points);
  e2.estimate(points);
  const seq1 = Array.from({ length: 5 }, () => e1.naturalMutate([0.25, 0.75], 1).child);
  const seq2 = Array.from({ length: 5 }, () => e2.naturalMutate([0.25, 0.75], 1).child);
  ok(JSON.stringify(seq1) === JSON.stringify(seq2), '未传 rng 的两个引擎 → 变异序列 JSON 逐位相同（缺省 rng 由 Math.random 改为固定种子确定性序列——宪章合规 + 可复现）');
  const rep = e1.report();
  const lam = 2 / (points.length + 2);
  const eigCov = symmetricEigen(shrinkageCovariance(points, lam));
  const kappaRef = eigCov.values[eigCov.values.length - 1] / eigCov.values[0];
  ok(Number.isFinite(rep.conditionNumber) && near(rep.conditionNumber, kappaRef, 1e-4), `report().conditionNumber = ${rep.conditionNumber} = 独立重算 λmax/λmin = ${kappaRef.toFixed(6)}（原随机 Rayleigh 估计随调用漂移——现精确确定）`);
}

// ═══════════════════════════════════════════════════════════════════
// 37.0 信息瓶颈：IB 曲线凹性 + 确定性 IB + 200 种子 DPI 电池
// ═══════════════════════════════════════════════════════════════════

section('37.0-① IB 曲线：凹性 + β 单调 + 全点 DPI');

{
  // 强信号联合（行决定列的混合结构——曲线非平凡）
  const signalJoint = [
    [0.95, 0.03, 0.02],
    [0.02, 0.95, 0.03],
    [0.03, 0.02, 0.95],
    [0.5, 0.3, 0.2],
    [0.2, 0.5, 0.3],
    [0.3, 0.2, 0.5],
  ];
  const curve = ibCurve(signalJoint);
  ok(curve.points.length === 10 && curve.dpiHolds, `10 档 β 全点 DPI：I(T;Y) ≤ I(X;Y) = ${curve.iXY.toFixed(4)} nat（数据处理不等式逐点）`);
  ok(curve.iXTMonotone && curve.iTYMonotone, `β 单调：I(X;T) 与 I(T;Y) 随 β 非降（iXT ${curve.points[0].iXT.toFixed(3)} → ${curve.points[9].iXT.toFixed(3)}，iTY ${curve.points[0].iTY.toFixed(3)} → ${curve.points[9].iTY.toFixed(3)}）`);
  ok(curve.concave && curve.maxSlopeIncrease <= 1e-3, `曲线凹性：按 iXT 升序斜率非增（最大斜率增量 ${curve.maxSlopeIncrease.toExponential(2)} ≤ 1e-3——可达域凸 ⇒ 上边界凹，时间共享混合的数学指纹）`);
  ok(curve.points.every((p) => p.retention <= 1 + 1e-9 && p.retention >= 0), 'retention ∈ [0,1] 全点（压缩不增殖信息）');
  // 曲线极端端点
  ok(curve.points[0].retention < 0.3 && curve.points[9].retention > 0.8, `两端行为：β=0.1 保留 ${curve.points[0].retention.toFixed(3)}（激进压缩）→ β=64 保留 ${curve.points[9].retention.toFixed(3)}（忠实保留）`);
}

section('37.0-② 确定性 IB：松弛界 / β 两端 / H(T) 账目 / 确定性');

{
  const signalJoint = [
    [0.95, 0.03, 0.02],
    [0.02, 0.95, 0.03],
    [0.03, 0.02, 0.95],
    [0.5, 0.3, 0.2],
    [0.2, 0.5, 0.3],
    [0.3, 0.2, 0.5],
  ];
  const d1 = deterministicIB(signalJoint, { beta: 5 });
  const d2 = deterministicIB(signalJoint, { beta: 5 });
  ok(JSON.stringify(d1) === JSON.stringify(d2), '同输入同输出（贪心 + 字典序平局——零随机源）');
  // 软 IB 是 dIB 的松弛 ⇒ F_dIB ≥ F_soft
  let relaxOk = true;
  const relaxDetails = [];
  for (const beta of [1, 5, 20]) {
    const soft = informationBottleneck(signalJoint, { beta, clusterCap: 6 });
    const hard = deterministicIB(signalJoint, { beta });
    if (hard.lagrangian < soft.lagrangian - 1e-6) relaxOk = false;
    relaxDetails.push(`β=${beta}: F_dIB ${hard.lagrangian.toFixed(4)} ≥ F_soft ${soft.lagrangian.toFixed(4)}`);
  }
  ok(relaxOk, `松弛界：${relaxDetails.join('；')}（确定性指派 ⊂ 软条件分布 ⇒ 软最优 ≤ 硬最优——方向性正确性锚）`);
  // β 两端
  const huge = deterministicIB(signalJoint, { beta: 1e6 });
  ok(huge.clusters === 6 && huge.retention > 0.99, `β=1e6：clusters = ${huge.clusters} = 全部可分行、retention = ${huge.retention.toFixed(6)}（T=X 无损——行互异时任何合并都亏）`);
  const tiny = deterministicIB(signalJoint, { beta: 0.001 });
  ok(tiny.clusters === 1 && tiny.retention < 1e-6, `β=0.001：clusters = ${tiny.clusters}、retention = ${tiny.retention.toExponential(2)}（T=常数——全并塌缩）`);
  // H(T) = I(X;T) 账目（硬指派口径）+ DPI
  const counts = new Array(6).fill(0);
  for (const a of d1.assignment) counts[a] += 1;
  const hT = -sum(counts.filter((c) => c > 0).map((c) => (c / 6) * Math.log(c / 6)));
  ok(near(d1.iXT, hT, 1e-9), `I(X;T) = H(T) 账目：${d1.iXT.toFixed(10)} = 独立重算 ${hT.toFixed(10)}（确定性映射下 I(X;T)=H(T)，聚类熵核算一致）`);
  ok(d1.iTY <= d1.iXY + 1e-9, `DPI：I(T;Y) = ${d1.iTY.toFixed(4)} ≤ I(X;Y) = ${d1.iXY.toFixed(4)}（硬指派同样不增殖信息）`);
  // 合并审计：ΔF 全部 < 0 且非降（贪心接受准则）
  ok(d1.merges.length > 0 && d1.merges.every((m) => m.deltaLagrangian < 0), `合并审计 ${d1.merges.length} 步全部 ΔF < 0（[${d1.merges.map((m) => m.deltaLagrangian.toFixed(3)).join(', ')}]——只接受改进）`);
  // 边界：零行（px=0）不 throw、不参与目标
  const withZeroRow = [[0, 0], [0.6, 0.4], [0.2, 0.8]];
  const dz = deterministicIB(withZeroRow, { beta: 3 });
  ok(dz.assignment.length === 3 && dz.iTY <= dz.iXY + 1e-9, '零质量行：不 throw、assignment 全覆盖、DPI 保持（边缘行诚实指派不污染目标）');
  ok(throwsOk(() => deterministicIB([[0.5, -0.1]], { beta: 1 })), '负概率 throw（入参纪律）');
}

section('37.0-③ DPI 电池：200 种子随机联合（I(X;X̂) ≤ I(X;Y)）');

{
  const rng = mulberry32(37037);
  let dpiOk = true;
  let retOk = true;
  let convCount = 0;
  let worstSlack = Infinity;
  for (let k = 0; k < 200; k += 1) {
    const nx = 2 + Math.floor(rng() * 5);
    const ny = 2 + Math.floor(rng() * 3);
    const pxy = Array.from({ length: nx }, () => Array.from({ length: ny }, () => 0.05 + rng()));
    const beta = [0.5, 2, 5, 20][Math.floor(rng() * 4)];
    const r = informationBottleneck(pxy, { beta, maxIterations: 1500 });
    if (r.converged) convCount += 1;
    if (r.iTY > r.iXY + 1e-6) dpiOk = false;
    if (r.retention > 1 + 1e-9) retOk = false;
    if (!r.converged) convOk = false;
    worstSlack = Math.min(worstSlack, r.iXY - r.iTY);
  }
  ok(dpiOk, '200 种子 × 4 档 β：I(T;Y) ≤ I(X;Y) 全部成立（数据处理不等式的随机检验电池）');
  ok(retOk, '200 种子 retention ≤ 1 + 1e-9（保留率上界——I(X;X̂) ≤ I(X;Y) 界的验收口径）');
  ok(convCount >= 196, `Blahut–Arimoto 收敛率 ${convCount}/200 ≥ 98%（三次确定性重启 + 1500 迭代上限；未收敛者为诚实 maxIterations 触顶——不伪装）`);
  ok(worstSlack >= -1e-6, `最坏 DPI 松弛：min(I(X;Y) − I(T;Y)) = ${worstSlack.toExponential(2)} ≥ −1e-6（200 种子无违反样本）`);
}

// ═══════════════════════════════════════════════════════════════════
// 70.0 部分信息分解：KKT 残差证书 + 线搜索早停 + 220 种子守恒电池
// ═══════════════════════════════════════════════════════════════════

section('70.0-① BROJA 一阶 KKT 残差证书：内点最优钉死 / 边界最优如实暴露');

{
  const gates = bivariateGates();
  const pidXor = pidFromJoint(gates.xor.joint);
  const pidCopy = pidFromJoint(gates.copy.joint);
  const pidSrc = pidFromJoint(gates.sourceX.joint);
  const pidAnd = pidFromJoint(gates.and.joint);
  ok(pidXor.solverTrace.maxKktResidual <= 1e-6, `XOR KKT 残差 = ${pidXor.solverTrace.maxKktResidual.toExponential(2)} ≤ 1e-6（独立耦合即内点全局最优——凸问题被证书钉死，不是「看起来收敛」）`);
  ok(pidCopy.solverTrace.maxKktResidual <= 1e-6 && pidSrc.solverTrace.maxKktResidual <= 1e-6, `COPY = ${pidCopy.solverTrace.maxKktResidual.toExponential(2)}、独占 = ${pidSrc.solverTrace.maxKktResidual.toExponential(2)}（可行集单点/切片平凡——证书同样成立）`);
  const noisyXor = [
    [
      [0.9 / 4, 0.1 / 4],
      [0.1 / 4, 0.9 / 4],
    ],
    [
      [0.1 / 4, 0.9 / 4],
      [0.9 / 4, 0.1 / 4],
    ],
  ];
  const pidNoisy = pidFromJoint(noisyXor);
  ok(pidNoisy.solverTrace.maxKktResidual <= 1e-6, `噪声 XOR KKT 残差 = ${pidNoisy.solverTrace.maxKktResidual.toExponential(2)}（对称内点最优——证书覆盖）`);
  ok(pidAnd.solverTrace.maxKktResidual > 0.1, `AND KKT 残差 = ${pidAnd.solverTrace.maxKktResidual.toFixed(3)} > 0.1（最优点在可行线段端点 a*=1/3——支撑边界约束起作用，平稳性残差如实暴露而非伪装收敛；原子值仍精确：R = ${pidAnd.redundant.toFixed(6)} ≈ 0.3113）`);
  ok(Math.abs(pidAnd.redundant - 0.3112781244591328) <= 2e-6 && Math.abs(pidAnd.synergistic - 0.5) <= 2e-6, 'AND 文献锚回归：R ≈ 0.3113、C = 0.5（容差 2e-6——早停改动零回归）');
}

section('70.0-② 线搜索早停：等价性 + 求值数节省（性能轴）');

{
  const gates = bivariateGates();
  const withEarly = pidFromJoint(gates.and.joint);
  const noEarly = pidFromJoint(gates.and.joint, { lineSearchEarlyExit: false });
  const atomDiff = Math.max(
    Math.abs(withEarly.redundant - noEarly.redundant),
    Math.abs(withEarly.synergistic - noEarly.synergistic),
    Math.abs(withEarly.unique1 - noEarly.unique1),
    Math.abs(withEarly.unique2 - noEarly.unique2),
  );
  ok(atomDiff <= 1e-8, `等价性：早停 vs 全额 80 轮的原子差 = ${atomDiff.toExponential(2)} ≤ 1e-8（机器精度早停不改贪心接受点）`);
  ok(
    Math.abs(withEarly.minimizedJointInfo - noEarly.minimizedJointInfo) <= 1e-9 && withEarly.solverTrace.lineSearchEvaluations < noEarly.solverTrace.lineSearchEvaluations,
    `求值数节省：${noEarly.solverTrace.lineSearchEvaluations} → ${withEarly.solverTrace.lineSearchEvaluations}（−${((1 - withEarly.solverTrace.lineSearchEvaluations / noEarly.solverTrace.lineSearchEvaluations) * 100).toFixed(0)}%，目标值差 ≤ 1e-9——区间收缩超出 double 分辨率后的尾段是纯开销）`,
  );
  const r1 = pidFromJoint(gates.and.joint);
  const r2 = pidFromJoint(gates.and.joint);
  ok(JSON.stringify(r1) === JSON.stringify(r2), '确定性保持：两次运行全报告（含新 trace 字段）JSON 逐位相同');
}

section('70.0-③ 守恒电池：220 种子随机联合（守恒 / 局部一致 / 界 / 可行性 / 单调）');

{
  const rng = mulberry32(70707);
  let consOk = true;
  let localOk = true;
  let boundsOk = true;
  let margOk = true;
  let monoOk = true;
  let nonnegOk = true;
  let worstCons = 0;
  let worstLocal = 0;
  let worstMarg = 0;
  for (let k = 0; k < 220; k += 1) {
    const n1 = 2 + Math.floor(rng() * 2);
    const n2 = 2 + Math.floor(rng() * 2);
    const ns = 2 + Math.floor(rng() * 2);
    const joint = Array.from({ length: n1 }, () =>
      Array.from({ length: n2 }, () => Array.from({ length: ns }, () => 0.05 + rng())),
    );
    const r = pidFromJoint(joint);
    const cons = Math.abs(r.redundant + r.unique1 + r.unique2 + r.synergistic - r.total);
    worstCons = Math.max(worstCons, cons);
    if (cons > 1e-9) consOk = false;
    const loc1 = Math.abs(r.redundant + r.unique1 - r.iSource1);
    const loc2 = Math.abs(r.redundant + r.unique2 - r.iSource2);
    worstLocal = Math.max(worstLocal, loc1, loc2);
    if (loc1 > 1e-9 || loc2 > 1e-9) localOk = false;
    const lower = Math.max(r.iSource1, r.iSource2) - 1e-9;
    if (r.minimizedJointInfo < lower || r.minimizedJointInfo > r.total + 1e-9) boundsOk = false;
    worstMarg = Math.max(worstMarg, r.solverTrace.maxMarginalViolation);
    if (r.solverTrace.maxMarginalViolation > 1e-9) margOk = false;
    const tr = r.solverTrace.objectiveTrace;
    for (let i = 1; i < tr.length; i += 1) {
      if (tr[i] > tr[i - 1] + 1e-10) monoOk = false;
    }
    if (r.unique1 < -1e-9 || r.unique2 < -1e-9 || r.synergistic < -1e-9 || r.redundant < -1e-6) nonnegOk = false;
  }
  ok(consOk, `守恒律：220 种子 R+U₁+U₂+C = I（最坏残差 ${worstCons.toExponential(2)} ≤ 1e-9——分解不增殖不湮灭信息）`);
  ok(localOk, `BROJA 局部一致：R+Uᵢ = I(Xᵢ;S)（最坏 ${worstLocal.toExponential(2)} ≤ 1e-9）`);
  ok(boundsOk, 'm ∈ [max(I₁,I₂), I] 理论界全部成立（Uᵢ ≥ 0 与 q=p 可行）');
  ok(margOk, `边缘可行性：最大违反 ${worstMarg.toExponential(2)} ≤ 1e-9（可行方向步进——约束精确保持）`);
  ok(monoOk, '目标序列单调不增（220 种子全轨迹——凸目标 + 精确线搜索的接受准则）');
  ok(nonnegOk, '原子非负：U₁,U₂,C ≥ −1e-9、R ≥ −1e-6（BROJA 口径的符号纪律）');
}

// ═══════════════════════════════════════════════════════════════════
// 68.0 压缩距离：LZ77 分辨率提升量化 + NCD 缓存 + 200 种子对称电池
// ═══════════════════════════════════════════════════════════════════

const familyA = [
  '调度器在多个模型之间分配任务时，优先选择预期收益最高的模型；当预算紧张时，调度器降低探索率并复用历史经验，避免重复交学费。',
  '调度器在多个模型之间分配请求时，优先选择延迟最低的模型；当负载紧张时，调度器降低并发数并复用历史经验，避免重复交学费。',
  '调度器在多个模型之间分配流量时，优先选择质量最好的模型；当配额紧张时，调度器降低重试率并复用历史经验，避免重复交学费。',
  '调度器在多个模型之间分配作业时，优先选择成本最低的模型；当令牌紧张时，调度器降低采样率并复用历史经验，避免重复交学费。',
];
const familyB = [
  '网络代理在跨区域传输数据包时，优先复用已建立的长连接；当超时计数增多时，代理收敛重传窗口并切换备用链路，防止雪崩放大。',
  '网络代理在跨区域传输报文分段时，优先复用已建立的隧道；当丢包计数增多时，代理收敛发送窗口并切换备用链路，防止雪崩放大。',
  '网络代理在跨区域传输媒体流时，优先复用已建立的通道；当抖动计数增多时，代理收敛缓冲水位并切换备用链路，防止雪崩放大。',
  '网络代理在跨区域传输文件块时，优先复用已建立的会话；当重置计数增多时，代理收敛队列深度并切换备用链路，防止雪崩放大。',
];
const familyItems = [...familyA, ...familyB];
const ab2000 = 'ab'.repeat(2000);
const random2048 = pseudoRandomString(2048, 42);

section('68.0-① LZ77 压缩器：计费恒等式 / 高重复压得动 / 高熵压不动');

{
  const r = lz77Compress(ab2000);
  const ratio = r.bits / 8 / r.bytes;
  const lzwRatio = lzwCompress(ab2000).bits / 8 / 2000;
  ok(r.bits === r.literals * 9 + r.matches * 21 && r.longestMatch > 200, `计费恒等式：bits = 9×${r.literals} + 21×${r.matches} = ${r.bits}（最长匹配 ${r.longestMatch} 命中 258 上限区——长匹配编码生效）`);
  ok(ratio <= lzwRatio, `'ab'×2000 压缩比：LZ77 ${(ratio * 100).toFixed(3)}% ≤ LZW ${(lzwRatio * 100).toFixed(3)}%（同口径下更强压缩）`);
  const rr = lz77Compress(random2048);
  const rRatio = rr.bits / 8 / rr.bytes;
  ok(rRatio >= 1.02 && rr.matches / (rr.literals + rr.matches) < 0.02, `伪随机串（2048, seed42）：压缩比 ${(rRatio * 100).toFixed(1)}% ≥ 102%（9 bit/字面量膨胀；匹配占比 ${(100 * rr.matches / (rr.literals + rr.matches)).toFixed(2)}%——高熵压不动）`);
  ok(lz77Compress('').bits === 0, '空串 0 bit（边界）');
  ok(JSON.stringify(lz77Compress(familyA[0])) === JSON.stringify(lz77Compress(familyA[0])), '同输入同输出（哈希链确定性贪心）');
  ok(throwsOk(() => lz77Compress(42)), 'lz77Compress(42) throw（非 string 纪律）');
}

section('68.0-② NCD 分辨率提升量化：非周期内容自距离 LZW 0.5+ → LZ77 ~0.01');

{
  const text = familyItems[0];
  const random600 = pseudoRandomString(600, 9);
  const selfTextLzw = ncd(text, text);
  const selfTextLz77 = ncdLz77(text, text);
  const selfRndLzw = ncd(random600, random600);
  const selfRndLz77 = ncdLz77(random600, random600);
  ok(selfTextLz77 < 0.5 * selfTextLzw, `文本自距离（家族首条）：LZW ${selfTextLzw.toFixed(4)}（√2−1 结构地板）→ LZ77 ${selfTextLz77.toFixed(4)}（第二拷贝由回引覆盖——${(selfTextLzw / selfTextLz77).toFixed(0)}× 分辨率提升）`);
  ok(selfRndLz77 < 0.5 * selfRndLzw, `伪随机串自距离（600B）：LZW ${selfRndLzw.toFixed(4)} → LZ77 ${selfRndLz77.toFixed(4)}（${(selfRndLzw / selfRndLz77).toFixed(0)}×——任意非周期内容受益）`);
  const allSelfLz77 = familyItems.map((s) => ncdLz77(s, s));
  ok(Math.max(...allSelfLz77) < 0.2, `全家族 8 条文本自距离 LZ77 ∈ [${Math.min(...allSelfLz77).toFixed(4)}, ${Math.max(...allSelfLz77).toFixed(4)}] < 0.2（LZW 口径为 0.41–0.55——「和自己最近」的判据带宽大幅贴近 0）`);
  // 近重复（文本 + 尾注）
  const ndLzw = ncd(text, text + '尾注两个汉字');
  const ndLz77 = ncdLz77(text, text + '尾注两个汉字');
  ok(ndLz77 < ndLzw, `近重复（文本 + 6 字节尾注）：LZW ${ndLzw.toFixed(4)} → LZ77 ${ndLz77.toFixed(4)}（查重判别更锐利）`);
  // 诚实边界：完全周期串两口径都有结构地板
  const selfAbLzw = ncd(ab2000, ab2000);
  const selfAbLz77 = ncdLz77(ab2000, ab2000);
  ok(selfAbLz77 > 0.5 && selfAbLzw > 0.4, `完全周期串（'ab'×2000）诚实边界：LZW 自距离 ${selfAbLzw.toFixed(4)}（√2−1）、LZ77 ${selfAbLz77.toFixed(4)}（匹配在首周期内即找到，两份拷贝无差别）——两压缩器在周期内容上都有地板，不掩盖`);
  // 家族分离：两口径并排
  const marginOf = (dist) => {
    let intra = 0;
    let intraN = 0;
    let inter = 0;
    let interN = 0;
    for (let i = 0; i < 8; i += 1) {
      for (let j = i + 1; j < 8; j += 1) {
        const v = dist(familyItems[i], familyItems[j]);
        if ((i < 4) === (j < 4)) {
          intra += v;
          intraN += 1;
        } else {
          inter += v;
          interN += 1;
        }
      }
    }
    return { intra: intra / intraN, inter: inter / interN };
  };
  const mOld = marginOf(ncd);
  const mNew = marginOf(ncdLz77);
  ok(mNew.inter - mNew.intra >= 0.3, `LZ77 家族分离：族内 ${mNew.intra.toFixed(4)} < 族间 ${mNew.inter.toFixed(4)}（间隔 ${(mNew.inter - mNew.intra).toFixed(4)} ≥ 0.3）`);
  ok(mNew.inter - mNew.intra >= (mOld.inter - mOld.intra), `间隔对照：LZW ${(mOld.inter - mOld.intra).toFixed(4)} → LZ77 ${(mNew.inter - mNew.intra).toFixed(4)}（家族语料上 LZ77 间隔同样更大——自距离贴近 0 + 族间高分离，分辨率整体上台阶）`);
  const randPair = ncdLz77(random2048, ab2000);
  ok(randPair > 0.9, `无关串贴顶：NCD₇₇(随机,'ab'×2000) = ${randPair.toFixed(4)} > 0.9（高熵与高重复在新口径下同样互斥）`);
}

section('68.0-③ 对称 / 非负电池：200 种子（LZW 与 LZ77 双口径）');

{
  const rng = mulberry32(68068);
  const corpus = [
    ...familyItems,
    ab2000,
    'ab'.repeat(2100),
    random2048,
    pseudoRandomString(512, 7),
    '调度器优先选择预期收益最高的模型并复用历史经验。',
    '',
    'a',
    'log日志log日志log日志log日志',
  ];
  let symExact = true;
  let nonneg = true;
  let sym77Exact = true;
  for (let k = 0; k < 200; k += 1) {
    const x = corpus[Math.floor(rng() * corpus.length)];
    const y = corpus[Math.floor(rng() * corpus.length)];
    if (ncd(x, y) !== ncd(y, x)) symExact = false;
    if (ncdLz77(x, y) !== ncdLz77(y, x)) sym77Exact = false;
    if (ncd(x, y) < 0 || ncdLz77(x, y) < 0 || Number.isNaN(ncd(x, y)) || Number.isNaN(ncdLz77(x, y))) nonneg = false;
  }
  ok(symExact, 'LZW NCD 对称：200 种子对 d(x,y) === d(y,x) 逐位精确（双向拼接均值口径的内生保证）');
  ok(sym77Exact, 'LZ77 NCD 对称：200 种子对逐位精确（同公式换压缩器——对称性口径迁移无损）');
  ok(nonneg, '双口径非负 + 无 NaN（200 种子——clamp 底线保持）');
}

section('68.0-④ NCD 压缩缓存：命中审计 / FIFO 逐出 / 逐位等价 / 冷暖墙钟');

{
  resetNcdCache();
  const t0 = performance.now();
  const m1 = ncdMatrix(familyItems);
  const coldMs = performance.now() - t0;
  const s1 = ncdCacheStats();
  const t1 = performance.now();
  const m2 = ncdMatrix(familyItems);
  const warmMs = performance.now() - t1;
  const s2 = ncdCacheStats();
  ok(s1.misses === 72 && s1.hits === 8, `首次矩阵：72 未命中 + 8 命中（8 单串 + 28 异对 × 2 方向 + 8 自拼接首算；自拼接 x+x 两方向重复串第二次即命中——调用账目可精确预测）`);
  ok(s2.hits - s1.hits === 80 && s2.misses === s1.misses, `二次矩阵：80 命中 0 未命中（全部 80 次压缩调用全额复用——纯 memo 等价）`);
  ok(JSON.stringify(m1) === JSON.stringify(m2), '缓存命中路径结果逐位一致（memo 化不改任何数值）');
  ok(warmMs <= coldMs, `墙钟：冷 ${coldMs.toFixed(1)} ms → 暖 ${warmMs.toFixed(1)} ms（重复语料二次分析免压缩——矩阵/聚类的重复调用直接受益）`);
  // FIFO 逐出
  resetNcdCache();
  for (let i = 0; i < 600; i += 1) compressedBits(`逐出探针#${i}`);
  const s3 = ncdCacheStats();
  ok(s3.evictions >= 88 && s3.size <= 512, `FIFO 逐出：600 条新串 → 在库 ${s3.size} ≤ 512、逐出 ${s3.evictions}（有界内存——无泄漏）`);
  // 与直算等价（绕过缓存口径的手工公式）
  const x = familyA[0];
  const y = familyB[0];
  const cx = lzwCompress(x).bits;
  const cy = lzwCompress(y).bits;
  const cxy = (lzwCompress(x + y).bits + lzwCompress(y + x).bits) / 2;
  ok(near(ncd(x, y), Math.max(0, (cxy - Math.min(cx, cy)) / Math.max(cx, cy)), 1e-12), 'ncd 与手工公式（直算 lzwCompress）1e-12 一致（缓存透明性）');
  resetNcdCache();
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed === 0) {
  console.log('✅ R5-A5 信息几何五内核进化验证成立（17.0/18.0/37.0/70.0/68.0）');
} else {
  console.error('❌ 存在失败断言');
}
process.exitCode = failed === 0 ? 0 : 1;
