/**
 * verify-awakening-kernels.mjs — 36.0→40.0 觉醒层五内核纯数学验证
 *
 * 验证锚点（闭式/模拟对照）：
 *   36.0 H₀ 持续同调：双簇+孤岛图的大陆/孤岛判定；瓶颈距离的
 *         自反零、平移上界与稳定性定理（扰动 ≤ δ ⟹ 距离 ≤ δ）
 *   37.0 信息瓶颈：数据处理不等式 I(T;Y) ≤ I(X;Y)（任意 β）；
 *         β→∞ 保留率→1、β→0 塌缩为常数；同构批 retention=0
 *   38.0 非线性动力学：logistic 映射 λ₁ = ln2（解析已知）；
 *         白噪声 H≈0.5、AR(+0.8) H>0.5、AR(−0.8) H<0.5
 *   39.0 谱排序：环图精确均匀、星图枢纽最高、质量守恒 Σ=1
 *   40.0 首达时间：反射原理 vs 离散模拟；逆高斯密度积分/期望闭式对照；
 *         赌徒破产公平口径 i/N；恢复/恶化两方向的冷却定价
 *
 * 运行：npm run build && node scripts/verify-awakening-kernels.mjs
 */

import {
  h0Persistence,
  bottleneckDistance,
  informationBottleneck,
  distillRetention,
  largestLyapunov,
  hurstExponent,
  dynamicsRegime,
  pageRank,
  reflectionMaxProb,
  inverseGaussianPdf,
  inverseGaussianCdf,
  gamblerRuin,
  firstPassageCooldown,
} from '../dist/index.mjs';

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

// ═══════════════════ 36.0 持续同调 ═══════════════════

section('36.0 持续同调：大陆/孤岛 + 瓶颈距离稳定性');

{
  // 双簇（A-B-C 强 / D-E-F 强，桥 0.3）+ 孤立 G
  const nodes = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const edges = [
    { source: 'A', target: 'B', weight: 0.9 },
    { source: 'B', target: 'C', weight: 0.85 },
    { source: 'A', target: 'C', weight: 0.8 },
    { source: 'D', target: 'E', weight: 0.88 },
    { source: 'E', target: 'F', weight: 0.82 },
    { source: 'D', target: 'F', weight: 0.75 },
    { source: 'C', target: 'D', weight: 0.3 },
  ];
  const report = h0Persistence(nodes, edges, 0.5);
  ok(report.islands.length === 3, `floor=0.5（桥 0.3 被排除）→ 3 个 essential 分量（2 大陆 + 1 孤岛；实际 ${report.islands.length}）`);
  const islandSizes = report.islands.map((i) => i.members.length).sort((a, b) => b - a);
  ok(islandSizes[0] === 3 && islandSizes[1] === 3 && islandSizes[2] === 1, `分量规模 [3,3,1]（实际 [${islandSizes.join(',')}]）`);
  const hasGAlone = report.islands.some((i) => i.members.length === 1 && i.members[0] === 'G');
  ok(hasGAlone, `孤立节点 G 独活（盲区的拓扑定义）`);
  // 桥边 0.3 > floor 时合并成 1 块大陆
  const merged = h0Persistence(nodes, edges, 0.1);
  ok(merged.islands.length === 2, `floor=0.1（含桥 0.3）→ 2 个分量（大陆 + G；实际 ${merged.islands.length}）`);

  const d0 = bottleneckDistance(report.diagram, report.diagram);
  ok(d0 === 0, `自反性：同图瓶颈距离 0（${d0}）`);
  const shifted = report.diagram.map((p) => ({ birth: p.birth, death: p.death + 0.1 }));
  const dShift = bottleneckDistance(report.diagram, shifted);
  ok(dShift <= 0.1 + 1e-9 && dShift > 0, `平移 0.1 → 距离 ≤ 0.1（实际 ${dShift.toFixed(4)}，紧致上界）`);
  const rng = mulberry32(20261003);
  const noisy = report.diagram.map((p) => ({ birth: p.birth + (rng() - 0.5) * 0.04, death: p.death + (rng() - 0.5) * 0.04 }));
  const dNoise = bottleneckDistance(report.diagram, noisy);
  ok(dNoise <= 0.02 + 1e-9, `稳定性定理：扰动 ≤ 0.02 ⟹ 距离 ≤ 0.02（实际 ${dNoise.toFixed(5)}）`);
}

// ═══════════════════ 37.0 信息瓶颈 ═══════════════════

section('37.0 信息瓶颈：DPI + β 两端 + 同构批定价');

{
  // 随机联合分布：任意 β 下数据处理不等式与拉格朗日单调收敛
  const rng = mulberry32(20261004);
  const pxy = Array.from({ length: 6 }, () => [rng(), rng(), rng() * 0.3]);
  let dpiOk = true;
  let convergedOk = true;
  for (const beta of [0.05, 1, 5, 50]) {
    const r = informationBottleneck(pxy, { beta });
    if (r.iTY > r.iXY + 1e-6) dpiOk = false;
    if (!r.converged) convergedOk = false;
    if (r.retention > 1 + 1e-9) dpiOk = false;
  }
  ok(dpiOk, `数据处理不等式 I(T;Y) ≤ I(X;Y)（β ∈ {0.05,1,5,50} 全过）`);
  ok(convergedOk, `Blahut-Arimoto 四档 β 全部收敛`);

  // β 两端：强信号联合（X 几乎决定 Y）大 β 高保留；弱信号随机联合
  // 的保留率随 β 单调改善（IB 前沿的可计算轨迹）
  const strong = [
    [0.95, 0.03, 0.02],
    [0.02, 0.95, 0.03],
    [0.03, 0.02, 0.95],
    [0.6, 0.2, 0.2],
    [0.2, 0.6, 0.2],
    [0.2, 0.2, 0.6],
  ];
  const high = informationBottleneck(strong, { beta: 30, clusterCap: 6, maxIterations: 3000 });
  const low = informationBottleneck(pxy, { beta: 0.01 });
  ok(high.retention > 0.9, `强信号 β=30 → 保留率 > 0.9（实际 ${high.retention.toFixed(3)}，T→X）`);
  const mid = informationBottleneck(pxy, { beta: 5 });
  const hiWeak = informationBottleneck(pxy, { beta: 30, maxIterations: 3000 });
  ok(hiWeak.retention > mid.retention, `弱信号保留率随 β 单调改善（β5: ${mid.retention.toFixed(3)} → β30: ${hiWeak.retention.toFixed(3)}——IB 前沿轨迹）`);
  ok(low.clusters === 1 && low.iTY < 0.01, `β=0.01 → T 塌缩为常数（clusters=${low.clusters}，I(T;Y)=${low.iTY.toExponential(1)}）`);

  // 精确零信息联合（行成比例）：诚实返回 retention 0
  const zeroInfo = informationBottleneck(
    [
      [1, 1],
      [2, 2],
      [3, 3],
    ],
    { beta: 5 },
  );
  ok(zeroInfo.iXY === 0 && zeroInfo.retention === 0, `特征与结果独立（行成比例）→ I(X;Y)=0、retention=0（诚实口径）`);

  // 有信息批 vs 同构批（蒸馏定价语义）
  const informative = [];
  for (let i = 0; i < 60; i += 1) {
    informative.push({ features: ['gen', 'fast'], success: true });
    informative.push({ features: ['trans', 'slow'], success: false });
  }
  const info = distillRetention(informative, { beta: 5 });
  ok(info.iXY > 0.6 && info.retention > 0.95, `特征决定成败的批 → I(X;Y)=${info.iXY.toFixed(2)} nat，保留率 ${info.retention.toFixed(3)}（值得立即蒸馏）`);
  const redundant = [];
  for (let i = 0; i < 30; i += 1) {
    redundant.push({ features: ['gen', 'fast'], success: i % 2 === 0 });
    redundant.push({ features: ['gen', 'slow'], success: i % 2 === 1 });
    redundant.push({ features: ['trans', 'fast'], success: i % 3 === 0 });
    redundant.push({ features: ['trans', 'slow'], success: i % 3 !== 0 });
  }
  const red = distillRetention(redundant, { beta: 5 });
  ok(red.iXY < 0.08, `成败与特征独立（同构批）→ I(X;Y)≈0（实际 ${red.iXY.toFixed(4)}）——水位再高也不值得蒸馏`);
}

// ═══════════════════ 38.0 非线性动力学 ═══════════════════

section('38.0 非线性动力学：logistic λ₁=ln2 + Hurst 体质');

{
  // logistic 映射 x → 4x(1−x)：λ₁ = ln 2（解析已知）
  const rng = mulberry32(20261005);
  let x = 0.2 + rng() * 0.6;
  const logistic = [];
  for (let i = 0; i < 2000; i += 1) {
    x = 4 * x * (1 - x);
    if (i > 200) logistic.push(x);
  }
  const lyap = largestLyapunov(logistic);
  ok(lyap !== undefined && Math.abs(lyap.lambda - Math.LN2) < 0.15,
    `logistic 映射 λ₁ ≈ ln2 = 0.693（估计 ${lyap ? lyap.lambda.toFixed(3) : '—'}）`);
  const reg = dynamicsRegime(logistic);
  ok(reg.regime === 'chaotic' && reg.forecastHorizonSteps !== undefined && reg.forecastHorizonSteps <= 3,
    `体质判定混沌，视野 ~1/λ₁ ≤ 3 步（regime=${reg.regime}，horizon=${reg.forecastHorizonSteps}）`);

  // 白噪声 H ≈ 0.5
  const g = gaussianMaker(20261006);
  const white = Array.from({ length: 2048 }, () => g());
  const hWhite = hurstExponent(white);
  ok(hWhite !== undefined && Math.abs(hWhite.hurst - 0.5) < 0.1,
    `白噪声 H ≈ 0.5（实际 ${hWhite ? hWhite.hurst.toFixed(3) : '—'}）`);

  // AR(+0.8) 持续 / AR(−0.8) 反持续
  const makeAR = (phi, seed) => {
    const gg = gaussianMaker(seed);
    const out = [];
    let v = 0;
    for (let i = 0; i < 4096; i += 1) {
      v = phi * v + gg();
      out.push(v);
    }
    return out;
  };
  const hPers = hurstExponent(makeAR(0.8, 20261007));
  const hAnti = hurstExponent(makeAR(-0.8, 20261008));
  ok(hPers !== undefined && hPers.hurst > 0.55, `AR(+0.8) H > 0.55（持续；实际 ${hPers ? hPers.hurst.toFixed(3) : '—'}）`);
  ok(hAnti !== undefined && hAnti.hurst < 0.45, `AR(−0.8) H < 0.45（反持续；实际 ${hAnti ? hAnti.hurst.toFixed(3) : '—'}）`);
  const regWhite = dynamicsRegime(white);
  ok(regWhite.regime === 'stochastic', `白噪声体质 = stochastic（${regWhite.regime}）`);
}

// ═══════════════════ 39.0 谱排序 ═══════════════════

section('39.0 谱排序：环均匀 / 星枢纽 / 质量守恒');

{
  // 环图：PageRank 精确均匀（任何阻尼）
  const ring = pageRank(['a', 'b', 'c', 'd'], [
    [0, 1, 0, 1],
    [1, 0, 1, 0],
    [0, 1, 0, 1],
    [1, 0, 1, 0],
  ]);
  ok(ring.converged && ring.scores.every((s) => Math.abs(s - 0.25) < 1e-8),
    `环图 → 精确均匀 1/4（最大偏差 ${Math.max(...ring.scores.map((s) => Math.abs(s - 0.25))).toExponential(1)}）`);
  const sum = ring.scores.reduce((a, b) => a + b, 0);
  ok(Math.abs(sum - 1) < 1e-9, `质量守恒 Σr = 1（${sum.toFixed(12)}）`);

  // 星图：中心枢纽最高
  const star = pageRank(['hub', 'l1', 'l2', 'l3'], [
    [0, 1, 1, 1],
    [1, 0, 0, 0],
    [1, 0, 0, 0],
    [1, 0, 0, 0],
  ]);
  ok(star.scores[0] === Math.max(...star.scores), `星图中心枢纽最高（hub=${star.scores[0].toFixed(3)} > 叶 ${star.scores[1].toFixed(3)}）`);

  // 悬挂节点：守恒且不崩溃
  const dangling = pageRank(['x', 'y', 'z'], [
    [0, 1, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]);
  const dsum = dangling.scores.reduce((a, b) => a + b, 0);
  ok(Math.abs(dsum - 1) < 1e-9 && dangling.scores.every((s) => s > 0), `悬挂质量重分配守恒（Σ=${dsum.toFixed(9)}，全正）`);
}

// ═══════════════════ 40.0 首达时间 ═══════════════════

section('40.0 首达时间：反射原理模拟对照 + 逆高斯闭式 + 冷却定价');

{
  // 反射原理 vs 离散 Brownian 模拟（σ=0.5 × 400 步，方差合计 100）
  const g = gaussianMaker(20261010);
  const t = 400;
  const sigmaStep = 0.5;
  const a = 10;
  let crossed = 0;
  const paths = 20000;
  for (let p = 0; p < paths; p += 1) {
    let cur = 0;
    let hit = false;
    for (let s = 0; s < t; s += 1) {
      cur += sigmaStep * g();
      if (cur >= a) {
        hit = true;
        break;
      }
    }
    if (hit) crossed += 1;
  }
  const empirical = crossed / paths;
  const analytic = reflectionMaxProb(a, t * sigmaStep * sigmaStep, 1);
  ok(Math.abs(empirical - analytic) < 0.02,
    `反射原理 P(sup ≥ ${a}) = ${analytic.toFixed(4)} vs 模拟 ${empirical.toFixed(4)}（2 万路径，|Δ|<0.02）`);

  // 逆高斯：密度积分 ≈ 1、期望闭式 a/μ
  const mean = 5;
  const shape = 9;
  let integral = 0;
  let expect = 0;
  const lo = 1e-4;
  const hi = mean * 40;
  const steps = 4000;
  const h = (hi - lo) / steps;
  for (let i = 0; i <= steps; i += 1) {
    const tt = lo + i * h;
    const w = i === 0 || i === steps ? 0.5 : 1;
    const f = inverseGaussianPdf(tt, mean, shape);
    integral += w * f * h;
    expect += w * f * tt * h;
  }
  ok(Math.abs(integral - 1) < 0.01, `逆高斯密度 Simpson 积分 ≈ 1（${integral.toFixed(5)}）`);
  ok(Math.abs(expect - mean) < 0.05, `数值期望 ≈ a/μ = ${mean}（${expect.toFixed(3)}）`);
  ok(inverseGaussianCdf(mean, mean, shape) > 0.4 && inverseGaussianCdf(mean, mean, shape) < 0.7,
    `IG Cdf(均值) ≈ 0.5 量级（${inverseGaussianCdf(mean, mean, shape).toFixed(3)}）`);

  // 赌徒破产：公平口径 i/N 精确；偏倚口径公式
  ok(Math.abs(gamblerRuin(3, 10, 0.5) - 0.3) < 1e-12, `公平游走 P = i/N = 0.3（${gamblerRuin(3, 10, 0.5)}）`);
  ok(gamblerRuin(5, 10, 0.6) > 0.85, `p=0.6 优势方 P > 0.85（${gamblerRuin(5, 10, 0.6).toFixed(3)}，闭式 0.884）`);

  // 冷却定价：恢复方向（间隔递增）→ 有定价；恶化方向（间隔递减）→ 不可达
  const recovering = firstPassageCooldown([100, 120, 150, 190, 240]);
  ok(recovering !== undefined && recovering.mu > 0 && recovering.recommendedCooldown !== undefined && recovering.recommendedCooldown > 0,
    `恢复方向（间隔递增）→ 期望恢复 ${recovering ? Math.round(recovering.expectedTime ?? -1) : '—'}ms，推荐冷却 ${recovering ? Math.round(recovering.recommendedCooldown ?? -1) : '—'}ms`);
  const worsening = firstPassageCooldown([240, 190, 150, 120, 100]);
  ok(worsening !== undefined && worsening.mu < 0 && worsening.recommendedCooldown === undefined,
    `恶化方向（间隔递减，μ̂<0）→ 诚实给出不可达（结构性恶化）`);
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n──────────────────────────────────────────────────────────');
if (failed === 0) {
  console.log(`✓ 觉醒层 36.0→40.0 五内核全部验证通过（${passed} 项断言）`);
} else {
  console.error(`✗ ${failed} 项失败（${passed} 项通过）`);
  process.exit(1);
}
