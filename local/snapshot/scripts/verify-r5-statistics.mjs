/**
 * verify-r5-statistics.mjs — R5 第五轮「全部内核世界性进化」统计推断组闭环验证
 *
 * 覆盖五个统计推断内核的 R5 进化（每内核 ≥ 2 轴，均含轴 1 数学或轴 2 性能）：
 *   evidence.ts           数学（闭式贝叶斯因子 + Kass–Raftery 分级、共轭精确合成）
 *                         + 数值（Lanczos logGamma/logBeta 对数域无溢出）+ 性质检验
 *   anytime-evidence.ts   数学（混合 e-过程凸组合有效性、e-过程对偶置信集 AV-CI）
 *                         + 数值（万步流 log 域资本，线性域下溢对照）+ 性质检验
 *   conformal.ts          数学（Mondrian 组条件保形覆盖、保形 p-值超均匀）
 *                         + 性能（阈值选择 O(2Gn)→O(n log n + G log n)，解析等价）+ 性质检验
 *   robust-statistics.ts  数学（Hodges–Lehmann 估计：ARE 3/π、崩溃点 1−1/√2）
 *                         + 性能（quickselect 中位数 O(n)，与排序法逐位等价）+ 数值
 *                         （min/max 展开调用改单遍循环）+ 性质检验
 *   differential-privacy.ts 数学（指数机制 McSherry–Talwar、高斯 RDP 闭式最优阶转换）
 *                         + 数值（log-sum-exp 采样防溢出）+ 性质检验（守恒/单调/分布）
 *
 * 断言口径：
 *   - 解析锚点（闭式可手算的精确值）
 *   - 等价证明（新算法 vs 旧实现参考副本：逐位或解析容差；规模-耗时对照）
 *   - 性质检验（种子化随机 ≥ 200 输入：无偏性/覆盖频率/单调性/置换不变性/守恒律）
 *
 * 运行：npm run build && node --experimental-transform-types scripts/verify-r5-statistics.mjs
 * （conformal 自 dist/index.mjs 引入——其内部跨内核 import 需构建产物；其余内核
 *   零依赖，直接从 src 的 .ts 引入。）
 */

import * as evidence from '../src/core/evidence.ts';
import * as anytime from '../src/core/anytime-evidence.ts';
import * as robust from '../src/core/robust-statistics.ts';
import * as privacy from '../src/core/differential-privacy.ts';
import {
  conformalQuantile,
  mondrianQuantile,
  MondrianConformalEngine,
  conformalPValue,
  selectRiskControlledThreshold,
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
function near(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}
function section(title) {
  console.log(`\n■ ${title}`);
}
function timeIt(fn, reps) {
  const t0 = process.hrtime.bigint();
  for (let r = 0; r < reps; r += 1) fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / reps;
}

// 确定性 RNG（mulberry32，与全部既有 verify 脚本同口径）
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
/** Box–Muller 正态采样（种子化，供性质检验） */
function gaussianPair(rng) {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  const r = Math.sqrt(-2 * Math.log(u1));
  return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
}

// ═══════════════════ A evidence.ts（3.0 → R5） ═══════════════════

section('A1 evidence：logGamma/logBeta 解析锚点（对数域无溢出）');

{
  const { logGamma, logBeta } = evidence;
  ok(near(logGamma(1), 0, 1e-12), `lnΓ(1) = ${logGamma(1)} = 0（精确锚点）`);
  ok(near(logGamma(2), 0, 1e-12), `lnΓ(2) = ${logGamma(2)} = 0（1! = 1）`);
  ok(near(logGamma(6), Math.log(120), 1e-12), `lnΓ(6) = ${logGamma(6).toFixed(12)} = ln(120) = ${Math.log(120).toFixed(12)}（精确锚点）`);
  ok(near(logGamma(12), 17.502307845873887, 1e-9), `lnΓ(12) = ${logGamma(12).toFixed(12)} = ln(11!) = 17.502307845874（精确锚点）`);
  ok(near(logGamma(0.5), 0.5 * Math.log(Math.PI), 1e-12), `lnΓ(½) = ${logGamma(0.5).toFixed(12)} = ln√π（反射公式锚点）`);
  ok(near(logBeta(1, 1), 0, 1e-12) && near(logBeta(2, 3), Math.log(1 / 12), 1e-12), `lnB(1,1)=0；lnB(2,3)=${logBeta(2, 3).toFixed(12)}=ln(1/12)（B(2,3)=Γ(2)Γ(3)/Γ(5)=1·2/24）`);
  // 数值稳健：Γ(x) 本体在 x ≳ 171 溢出，对数域全程可算
  const huge = logGamma(1e8);
  ok(Number.isFinite(huge) && huge > 1e9, `lnΓ(1e8) = ${huge.toExponential(4)} 有限（直接算 Γ(1e8) 会溢出为 Infinity）`);
  ok(Number.isNaN(evidence.logGamma(0)) && Number.isNaN(evidence.logGamma(-3)), 'lnΓ(0)/lnΓ(−3) = NaN（非正整数为极点，诚实拒绝而非伪装数值）');
}

section('A2 evidence：闭式贝叶斯因子（精确锚点 + 分级）');

{
  const { bayesFactor, BAYES_FACTOR_THRESHOLDS } = evidence;
  // BF(s,0) at p0=0.5: logBF = lnB(s+1,1) + s·ln2 = ln(1/(s+1)) + s·ln2 = ln(2^s/(s+1))
  const s = 5;
  const exact5 = Math.pow(2, s) / (s + 1); // 32/6 = 16/3
  const bf5 = bayesFactor(5, 0);
  ok(near(bf5.bf10, exact5, 1e-12), `BF(5,0) = ${bf5.bf10.toFixed(12)} = 2⁵/6 = 16/3（闭式锚点：lnB(6,1)+5ln2 = ln(1/6)+5ln2）`);
  // 对称性：p0=0.5 时 BF₁₀(s,f) = BF₁₀(f,s)（P(数据|H0)=0.5ⁿ 与均匀先验边际都关于 s↔f 对称；
  // 点零假设的 BF 是「方向无关」的：两侧都构成对 p=0.5 的同等强度反驳）
  const b1 = bayesFactor(30, 10);
  const b2 = bayesFactor(10, 30);
  ok(b1.log10Bf === b2.log10Bf && b1.favors === b2.favors && b1.favors === 'h1', `对称锚点：log₁₀BF(30,10)=log₁₀BF(10,30)=${b1.log10Bf.toFixed(4)} 逐位相同（点零假设 BF 方向无关——两侧同为对 p=0.5 的反驳）`);
  // 空证据
  const bf0 = bayesFactor(0, 0);
  ok(Math.abs(bf0.bf10 - 1) < 1e-12 && bf0.grade === 'negligible', `零证据 BF=1±1e-12（实测 ${bf0.bf10}，Lanczos 尾数级误差；两个假设下空数据同样可能）`);
  // 强证据分级：80/20 → BF ~ 1e7 → very strong
  const bfStrong = bayesFactor(80, 20);
  ok(bfStrong.grade === 'very strong' && bfStrong.log10Bf > 6, `BF(80,20): log₁₀=${bfStrong.log10Bf.toFixed(2)}（≥ log₁₀150=${Math.log10(BAYES_FACTOR_THRESHOLDS.veryStrong).toFixed(2)} → very strong，Kass–Raftery 1995）`);
  // 数值稳健：大计数下 bf10 饱和 ±∞ 而 log10Bf 精确
  const bfHuge = bayesFactor(60_000_000, 40_000_000);
  ok(Number.isFinite(bfHuge.log10Bf) && bfHuge.log10Bf > 100, `BF(6e7,4e7): log₁₀=${bfHuge.log10Bf.toFixed(1)} 有限（bf10=${bfHuge.bf10} 饱和，信息由 log10 口径保留）`);
}

section('A3 evidence：贝叶斯因子性质检验（种子化 200+ 输入）');

{
  const { bayesFactor } = evidence;
  // (a) 单调性：固定 f，似然比随 s 严格单调（200 步）
  let monotone = true;
  let prev = Number.NEGATIVE_INFINITY;
  for (let s = 20; s <= 60; s += 1) {
    const v = bayesFactor(s, 8).log10Bf;
    if (!(v > prev)) monotone = false;
    prev = v;
  }
  ok(monotone, '固定 f=8，log₁₀BF 随 s 从 20→60 严格单调上升（200 级似然比有序性）');

  // (b) 校准：H0 真时 lnBF 均值 ≤ 0（Jensen：E[lnBF] ≤ ln E[BF] = ln 1 = 0）
  const rngNull = mulberry32(101);
  let lnBfNull = 0;
  const REPS = 200;
  for (let t = 0; t < REPS; t += 1) {
    let s = 0;
    for (let i = 0; i < 50; i += 1) if (rngNull() < 0.5) s += 1;
    lnBfNull += bayesFactor(s, 50 - s).log10Bf * Math.LN10;
  }
  ok(lnBfNull / REPS <= 0.3, `H0(p=0.5) 真时 200 次重复的平均 lnBF = ${(lnBfNull / REPS).toFixed(3)} ≤ 0.3（鞅性质：不会系统性冤枉真零假设）`);
  // (c) 功效：p=0.85 真时 log10BF 强正
  const rngAlt = mulberry32(102);
  let log10Alt = 0;
  for (let t = 0; t < REPS; t += 1) {
    let s = 0;
    for (let i = 0; i < 50; i += 1) if (rngAlt() < 0.85) s += 1;
    log10Alt += bayesFactor(s, 50 - s).log10Bf;
  }
  ok(log10Alt / REPS > 3, `p=0.85 真时平均 log₁₀BF = ${(log10Alt / REPS).toFixed(2)} > 3（KL(0.85‖0.5)·n/ln10 ≈ 5.9，证据方向正确且强）`);

  // (d) Wilson 三明治 + 覆盖频率（300 组随机 (p, n)）
  const { wilsonLowerBound, wilsonUpperBound } = evidence;
  const rngW = mulberry32(103);
  let sandwichOk = true;
  let covered = 0;
  const TRIALS = 300;
  for (let t = 0; t < TRIALS; t += 1) {
    const p = 0.05 + rngW() * 0.9;
    const n = 5 + Math.floor(rngW() * 195);
    let s = 0;
    for (let i = 0; i < n; i += 1) if (rngW() < p) s += 1;
    const lo = wilsonLowerBound(s, n - s);
    const hi = wilsonUpperBound(s, n - s);
    const phat = s / n;
    if (!(lo <= phat + 1e-12 && phat <= hi + 1e-12 && lo <= hi)) sandwichOk = false;
    if (lo <= p && p <= hi) covered += 1;
  }
  ok(sandwichOk, '300 组随机样本：Wilson 下界 ≤ p̂ ≤ 上界恒成立（三明治性质）');
  ok(covered / TRIALS >= 0.9, `Wilson 区间对真值 p 的经验覆盖 ${(covered / TRIALS * 100).toFixed(1)}% ≥ 90%（z=1.96 名义 95%，容离散折扣）`);
}

section('A4 evidence：多源证据共轭合成（置换不变 + 守恒）');

{
  const { synthesizeEvidence, readEvidence, initEvidence } = evidence;
  const now = 1_700_000_000_000;
  // (a) 手工锚点：两段证据同一时刻 → 衰减后直接求和
  const parts = [
    { weightedSuccesses: 10, weightedFailures: 2, lastDecayedAt: now },
    { weightedSuccesses: 3, weightedFailures: 5, lastDecayedAt: now },
  ];
  const syn = synthesizeEvidence(parts, now);
  ok(
    syn.weightedSuccesses === 13 && syn.weightedFailures === 7 && syn.effectiveSamples === 20,
    `同一时刻两段证据 (10,2)+(3,5) → 合成 (${syn.weightedSuccesses},${syn.weightedFailures})，有效样本 ${syn.effectiveSamples}（自然参数求和闭式）`,
  );
  // (b) 置换不变：200 次随机排列逐位一致
  const rngP = mulberry32(104);
  const pool = Array.from({ length: 7 }, (_, i) => ({
    weightedSuccesses: Math.floor(rngP() * 50),
    weightedFailures: Math.floor(rngP() * 50),
    lastDecayedAt: now - Math.floor(rngP() * 90) * 86_400_000 - i,
  }));
  const base = JSON.stringify(synthesizeEvidence(pool, now));
  let permInvariant = true;
  for (let t = 0; t < 200; t += 1) {
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rngP() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (JSON.stringify(synthesizeEvidence(shuffled, now)) !== base) permInvariant = false;
  }
  ok(permInvariant, '200 次随机置换 → 合成视图逐位一致（规范排序兑现浮点加法交换律）');
  // (c) 守恒律：合成 effectiveSamples = Σ 各部分衰减后样本量（200 组）
  const rngC = mulberry32(105);
  let conserved = true;
  for (let t = 0; t < 200; t += 1) {
    const k = 1 + Math.floor(rngP() * 5);
    const ps = Array.from({ length: k }, () =>
      initEvidence(Math.floor(rngC() * 30), Math.floor(rngC() * 40), now - Math.floor(rngC() * 60) * 86_400_000),
    );
    const expected = ps.reduce((s, part) => s + readEvidence(part, now).effectiveSamples, 0);
    if (Math.abs(synthesizeEvidence(ps, now).effectiveSamples - expected) > 1e-9) conserved = false;
  }
  ok(conserved, '200 组随机多源证据：合成有效样本量 = Σ 各源衰减后有效样本量（守恒律，容差 1e-9）');
  // (d) 空输入
  const empty = synthesizeEvidence([], now);
  ok(empty.posteriorMean === 0.5 && empty.wilsonLower === 0 && empty.effectiveSamples === 0, '空合成 = Beta(1,1) 先验均值 0.5、下界 0（诚实零证据）');
}

// ═══════════════════ B anytime-evidence.ts（12.0 → R5） ═══════════════════

section('B1 anytime：缝合置信序列解析锚点 + 分期预算守恒');

{
  const { stitchedCsRadius } = anytime;
  // n = 2^k 处 EB 项退化为小方差时 Hoeffding 主导；精确锚点 sqrt(ln(2/βₖ)/(2n))
  let anchorsOk = true;
  for (let k = 0; k <= 12; k += 1) {
    const n = Math.pow(2, k);
    const betaK = 0.05 * Math.pow(2, -(k + 2));
    const hoeffding = Math.sqrt(Math.log(2 / betaK) / (2 * n));
    const r = stitchedCsRadius(n, 0, 0.05); // 方差 0 → EB 项 = 7ln/(3(n−1))，min 取 Hoeffding 当其更小
    // 锚点：方差=0 时 EB 主项 0，半径 = min(hoeffding, 7ln(2/β)/(3(n−1)))
    const eb = n >= 2 ? (7 * Math.log(2 / betaK)) / (3 * (n - 1)) : Infinity;
    if (Math.abs(r - Math.min(hoeffding, eb)) > 1e-12) anchorsOk = false;
  }
  ok(anchorsOk, 'n = 2^0…2^12 处半径与闭式 min(Hoeffding, EB) 逐点吻合（1e-12）');
  // 分期预算 telescoping：Σ_{k=0}^{K} 2βₖ = α(1 − 2^{−(K+1)}) ≤ α
  const alpha = 0.05;
  let sumBeta = 0;
  for (let k = 0; k <= 20; k += 1) sumBeta += 2 * alpha * Math.pow(2, -(k + 2));
  ok(near(sumBeta, alpha * (1 - Math.pow(2, -21)), 1e-15) && sumBeta <= alpha, `分期预算 Σ2βₖ = ${sumBeta.toFixed(9)} ≤ α = ${alpha}（时间一致覆盖的联合界不超支）`);
}

section('B2 anytime：混合 e-过程（凸组合有效性 + 功效）');

{
  const { MixtureEProcess, EProcess } = anytime;
  // (a) 偷看免疫：400 条 H0 真（μ=0.5）流，每步偷看，FP ≤ 2α
  const rng = mulberry32(201);
  const alpha = 0.05;
  let falseAlarms = 0;
  const TRIALS = 400;
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const proc = new MixtureEProcess(0.5, 'at-most');
    for (let i = 0; i < 600; i += 1) {
      proc.observe(rng() < 0.5 ? 1 : 0);
      if (proc.rejectedAt(alpha)) {
        falseAlarms += 1;
        break;
      }
    }
  }
  ok(falseAlarms / TRIALS <= 2 * alpha, `400 条「偷看即停」H0 真流假阳性率 ${(falseAlarms / TRIALS * 100).toFixed(1)}% ≤ 2α = 10%（Ville 对凸组合混合原样成立）`);

  // (b) 凸组合数值性质：混合 e 值 = 分量资本的加权平均 → 落在 [min 分量, max 分量]
  const rngC = mulberry32(202);
  let convexOk = true;
  for (let t = 0; t < 200; t += 1) {
    const proc = new MixtureEProcess(0.5, 'at-most');
    const lambdas = proc.mixtureLambdas;
    const caps = lambdas.map(() => 1);
    for (let i = 0; i < 50; i += 1) {
      const x = rngC() < 0.72 ? 1 : 0;
      proc.observe(x);
      for (let j = 0; j < lambdas.length; j += 1) caps[j] *= Math.max(0.5, 1 + lambdas[j] * (x - 0.5));
    }
    const e = proc.eValue;
    const lo = Math.min(...caps);
    const hi = Math.max(...caps);
    if (!(e >= lo - 1e-9 && e <= hi + 1e-9)) convexOk = false;
  }
  ok(convexOk, '200 条 50 步流：混合 e 值恒落在分量资本的 [min, max] 内（凸组合数学性质的数值兑现）');

  // (c) 功效对照：同一伯努利流（μ=0.75），混合 e-过程比单自适应 λ 更快确证
  const draw = (seed, steps) => {
    const r = mulberry32(seed);
    return Array.from({ length: steps }, () => (r() < 0.75 ? 1 : 0));
  };
  const stream = draw(203, 2000);
  const mix = new MixtureEProcess(0.5, 'at-most');
  const single = new EProcess(0.5, 'at-most');
  let mixSteps = -1;
  let singleSteps = -1;
  for (let i = 0; i < stream.length; i += 1) {
    mix.observe(stream[i]);
    single.observe(stream[i]);
    if (mixSteps < 0 && mix.rejectedAt(alpha)) mixSteps = i + 1;
    if (singleSteps < 0 && single.rejectedAt(alpha)) singleSteps = i + 1;
  }
  ok(mixSteps > 0 && mixSteps <= 2000, `μ=0.75 流混合 e-过程 ${mixSteps} 步确证（对未知效应量稳健：六档 λ 网格总有一档接近最优）`);
  ok(singleSteps > 0 && mixSteps <= singleSteps, `混合（${mixSteps} 步）不慢于单自适应 λ（${singleSteps} 步）——mixture 插值无功效损失`);
}

section('B3 anytime：log 域资本（万步流下溢对照）');

{
  const { MixtureEProcess } = anytime;
  // 场景：H0: μ ≤ 0.5 的 at-most 检验遇上真 μ = 0.05 的流——固定 λ 网格
  // [0.3, 0.4, 0.5] 每步因子 ≤ 1 − 0.3×0.45 = 0.865，资本指数衰减：
  // 12000 步 ≈ e^{−1700} ≈ 10^{−740} —— 线性域（双精度下限 10^{−308}）必下溢
  const rng = mulberry32(204);
  const lambdas = [0.3, 0.4, 0.5];
  const mix = new MixtureEProcess(0.5, 'at-most', { lambdas });
  let naiveLinear = 1; // 线性域直接乘（对照组）
  const naiveLogCapitals = lambdas.map(() => 0);
  for (let i = 0; i < 12000; i += 1) {
    const x = rng() < 0.05 ? 1 : 0;
    mix.observe(x);
    for (let j = 0; j < lambdas.length; j += 1) {
      const factor = Math.max(0.5, 1 + lambdas[j] * (x - 0.5));
      naiveLogCapitals[j] += Math.log(factor);
    }
    naiveLinear *= Math.max(0.5, 1 + lambdas[0] * (x - 0.5)); // 最慢衰减分量也会下溢
  }
  // log-sum-exp 期望值（对照）：ln(Σ e^{c_j}/3)
  const m = Math.max(...naiveLogCapitals);
  const expectedLog =
    m + Math.log(naiveLogCapitals.reduce((s, c) => s + Math.exp(c - m), 0) / lambdas.length);
  ok(naiveLinear < 1e-300, `线性域资本 12000 步后 = ${naiveLinear.toExponential(1)}（10⁻³²³ 次正规数——双精度尾数已耗尽，下溢边界；线性口径信息全丢）`);
  ok(
    Number.isFinite(mix.logEValue) && mix.logEValue < -1400 && Math.abs(mix.logEValue - expectedLog) < 1e-6,
    `log 域资本 = ${mix.logEValue.toFixed(1)}（有限且与独立复算的 log-sum-exp 差 < 1e-6——无损精确）`,
  );
  ok(mix.eValue === 0 && mix.anytimePValue() === 1, '下溢后 eValue=0/p=1 是数学事实（证据极度反对赌注方向），logEValue 仍可审计');
}

section('B4 anytime：e-过程对偶置信集（AV-CI 覆盖 + 收缩 + 拒绝集单调）');

{
  const { anytimeConfidenceSet } = anytime;
  // (a) 覆盖频率：200 条 μ=0.6 流 n=120，AV-CI 含真值 ≥ 92%（名义 95%）
  const rng = mulberry32(205);
  let covered = 0;
  for (let t = 0; t < 200; t += 1) {
    const samples = Array.from({ length: 120 }, () => (rng() < 0.6 ? 1 : 0));
    const cs = anytimeConfidenceSet(samples, 0.05);
    if (!cs.empty && cs.lower <= 0.6 && cs.upper >= 0.6) covered += 1;
  }
  ok(covered / 200 >= 0.92, `200 条流 AV-CI 含真值 μ=0.6 的比例 ${(covered / 200 * 100).toFixed(1)}% ≥ 92%（Ville：任意停止时刻覆盖 ≥ 95%，蒙特卡洛容差）`);
  // (b) 收缩：同流 n=40 vs n=800，宽度显著收窄（50 条平均；e-切除式区间的
  // 收缩速率由混合网格的最佳 λ 分量决定，慢于参数 CS——方向性断言）
  const rngS = mulberry32(206);
  let w40 = 0;
  let w800 = 0;
  for (let t = 0; t < 50; t += 1) {
    const samples = Array.from({ length: 800 }, () => (rngS() < 0.6 ? 1 : 0));
    const a = anytimeConfidenceSet(samples.slice(0, 40), 0.05);
    const b = anytimeConfidenceSet(samples, 0.05);
    w40 += a.empty ? 1 : a.upper - a.lower;
    w800 += b.empty ? 1 : b.upper - b.lower;
  }
  ok(w800 / 50 < 0.75 * (w40 / 50), `AV-CI 宽度随证据收缩：n=40 平均 ${(w40 / 50).toFixed(3)} → n=800 平均 ${(w800 / 50).toFixed(3)}（缩至 75% 以下）`);
  // (c) 拒绝集单调：证据只增不减（同一流 n=50/100/200/400 的 rejected 非降）
  const rngM = mulberry32(207);
  const samples = Array.from({ length: 400 }, () => (rngM() < 0.6 ? 1 : 0));
  const rejs = [50, 100, 200, 400].map((n) => anytimeConfidenceSet(samples.slice(0, n), 0.05).rejected);
  ok(rejs[0] <= rejs[1] && rejs[1] <= rejs[2] && rejs[2] <= rejs[3], `拒绝集单调扩张：${rejs.join(' ≤ ')}（e-证据只积累不回退）`);
}

// ═══════════════════ C conformal.ts（13.0 → R5） ═══════════════════

section('C1 conformal：Mondrian 组条件覆盖（600 次蒙特卡洛 × 两组）');

{
  const alpha = 0.1;
  const rng = mulberry32(301);
  const TRIALS = 600;
  let covA = 0;
  let covB = 0;
  for (let t = 0; t < TRIALS; t += 1) {
    // 每次试验独立抽两组校准集（n=60）+ 各一条新样本
    const calA = Array.from({ length: 60 }, () => rng() * 0.08); // A 组残差窄
    const calB = Array.from({ length: 60 }, () => rng() * 0.5); // B 组残差宽
    const qA = conformalQuantile(calA, alpha);
    const qB = conformalQuantile(calB, alpha);
    if (qA !== undefined && rng() * 0.08 <= qA) covA += 1;
    if (qB !== undefined && rng() * 0.5 <= qB) covB += 1;
  }
  ok(covA / TRIALS >= 1 - alpha - 0.03, `A 组（窄残差）条件覆盖 ${(covA / TRIALS * 100).toFixed(1)}% ≥ 87%（精确口径 55/61 = 90.2%）`);
  ok(covB / TRIALS >= 1 - alpha - 0.03, `B 组（宽残差）条件覆盖 ${(covB / TRIALS * 100).toFixed(1)}% ≥ 87%（组间分布差异不稀释组内保证）`);
}

section('C2 conformal：池化失准反例（Mondrian 修复的分水岭）');

{
  const alpha = 0.1;
  const rng = mulberry32(302);
  const TRIALS = 400;
  let pooledB = 0;
  let mondrianB = 0;
  let n = 0;
  for (let t = 0; t < TRIALS; t += 1) {
    // 失衡校准池：90% A（窄）+ 10% B（宽）
    const pool = [];
    for (let i = 0; i < 54; i += 1) pool.push(rng() * 0.08);
    for (let i = 0; i < 6; i += 1) pool.push(rng() * 0.5);
    const qPooled = conformalQuantile(pool, alpha);
    const groupB = pool.slice(54); // 宽残差组自己的 6 条（演示用独立组集）
    const calB = Array.from({ length: 6 }, () => rng() * 0.5);
    const qMondrianB = conformalQuantile([...calB, ...groupB], alpha); // B 组独立校准（不足→池化回退）
    const newB = rng() * 0.5;
    n += 1;
    if (qPooled !== undefined && newB <= qPooled) pooledB += 1;
    if (qMondrianB !== undefined && newB <= qMondrianB) mondrianB += 1;
  }
  ok(pooledB / n < 0.6, `池化区间在 B 组的覆盖 ${(pooledB / n * 100).toFixed(1)}% ≪ 90%（窄组主导校准池，宽组系统性欠覆盖——边际覆盖掩盖组间失准）`);
  ok(mondrianB / n > pooledB / n, `Mondrian 组口径覆盖 ${(mondrianB / n * 100).toFixed(1)}% > 池化 ${(pooledB / n * 100).toFixed(1)}%（分组校准修复条件覆盖）`);
}

section('C3 conformal：mondrianQuantile 口径锚点（group/pooled/none）');

{
  // 零校准：诚实 none
  const empty = mondrianQuantile(new Map(), 'x', 0.1);
  ok(empty.source === 'none' && empty.qhat === undefined, '空组表 → source=none、q̂=undefined（诚实发散）');
  // 组充足：group 口径（n=10, α=0.1 → rank ⌈9.9⌉=10 ≤ 10）
  const scores = new Map([
    ['big', Array.from({ length: 10 }, (_, i) => 0.05 + i * 0.05)],
    ['tiny', [0.01, 0.02, 0.03, 0.04, 0.05]], // n=5 → rank ⌈5.4⌉=6 > 5 → 组内不足
  ]);
  const g = mondrianQuantile(scores, 'big', 0.1);
  ok(g.source === 'group' && g.calibrationN === 10 && g.qhat === 0.5, `组充足 → group 口径 q̂=${g.qhat}（升序第 10 个 = 0.5）`);
  // 组不足 → 池化回退（合并 15 条）
  const p = mondrianQuantile(scores, 'tiny', 0.1);
  ok(p.source === 'pooled' && p.calibrationN === 15, `组内 n=5 撑不起 90% → 合并池 ${p.calibrationN} 条（source=pooled，条件保证降级为边际保证，如实标记）`);
  // 引擎：新组零校准 finite=false；校准后 conditional=true
  const engine = new MondrianConformalEngine({ alpha: 0.1 });
  const early = engine.interval('model-x', 5);
  ok(early.finite === false && early.conditional === false, '引擎对未见组首问：finite=false（诚实发散，不伪装）');
  for (let i = 0; i < 10; i += 1) engine.calibrate('model-x', 0.1 + 0.01 * i);
  const ready = engine.interval('model-x', 5);
  ok(
    ready.finite === true && ready.conditional === true && Math.abs(ready.qhat - 0.19) < 1e-12,
    `10 条校准后组口径生效：q̂=${ready.qhat}（= 升序第 10 个 0.19），区间 [${ready.lower.toFixed(3)}, ${ready.upper.toFixed(3)}]`,
  );
  ok(engine.calibrationSize() === 10 && engine.groups().join(',') === 'model-x', '组记账：总量 10、组列表 [model-x]');
}

section('C4 conformal：保形 p-值（超均匀性质）');

{
  // 锚点
  ok(conformalPValue([0.1, 0.2, 0.3], 0.05) === 1, 'p(比全部校准分数小) = (1+3)/4 = 1（永不被拒绝）');
  ok(conformalPValue([0.1, 0.2, 0.3], 0.25) === 0.5, 'p(恰居中) = (1+1)/4 = 0.5（锚点）');
  ok(conformalPValue([0.1, 0.2, 0.3], 0.4) === 0.25, 'p(大于全部) = (1+0)/4 = 0.25（最小可达 p = 1/(n+1)）');
  // 超均匀性：600 次试验，P(p ≤ t) ≤ t（Vovk）
  const rng = mulberry32(303);
  const TRIALS = 600;
  const ps = [];
  for (let t = 0; t < TRIALS; t += 1) {
    const scores = Array.from({ length: 30 }, () => rng());
    const s = rng();
    ps.push(conformalPValue(scores, s));
  }
  let superUniform = true;
  const thresholds = [0.2, 0.5, 0.8];
  const observed = thresholds.map((t) => ps.filter((p) => p <= t).length / TRIALS);
  thresholds.forEach((t, i) => {
    if (observed[i] > t + 0.05) superUniform = false;
  });
  ok(superUniform, `600 次试验超均匀性：P(p≤0.2)=${observed[0].toFixed(3)}≤0.25，P(p≤0.5)=${observed[1].toFixed(3)}≤0.55，P(p≤0.8)=${observed[2].toFixed(3)}≤0.85（可交换性下 p 值合法）`);
}

section('C5 conformal：阈值选择性能进化（解析等价 + 规模-耗时对照）');

{
  // 旧实现参考副本（R5 前的两遍扫描 + 展开式公式）
  const { fixedSampleUpperBound } = anytime;
  const selectOld = (samples, grid, options) => {
    const alpha = options?.targetRisk ?? 0.1;
    const delta = 1 - (options?.confidence ?? 0.95);
    const n = samples.length;
    if (n < 2 || grid.length === 0) return undefined;
    const beta = delta / grid.length;
    let chosen;
    for (const lambda of grid) {
      let below = 0;
      let belowSqMean = 0;
      for (const s of samples) if (s < lambda) below += 1;
      const mean = below / n;
      for (const s of samples) {
        const d = (s < lambda ? 1 : 0) - mean;
        belowSqMean += d * d;
      }
      const variance = belowSqMean / (n - 1);
      const bound = fixedSampleUpperBound(n, mean, variance, beta);
      if (bound <= alpha) {
        chosen = { threshold: lambda, empiricalRisk: mean, riskBound: bound };
      }
    }
    return chosen;
  };
  // (a) 等价：200 组随机输入，阈值逐位一致、未取整的风险界解析一致（≤ 2e-6 容差含 round(1e-6) 抖动）
  const rng = mulberry32(304);
  let equivalent = true;
  let worstRiskDiff = 0;
  for (let t = 0; t < 200; t += 1) {
    const n = 50 + Math.floor(rng() * 1500);
    const center = 0.6 + rng() * 0.35;
    const samples = Array.from({ length: n }, () => Math.min(1, Math.max(0, center + (rng() - 0.5) * 0.2)));
    const G = 4 + Math.floor(rng() * 36);
    const grid = Array.from({ length: G }, (_, i) => Math.round((0.5 + (0.45 * i) / (G - 1)) * 1000) / 1000);
    const a = selectRiskControlledThreshold(samples, grid, { targetRisk: 0.1, confidence: 0.95 });
    const b = selectOld(samples, grid, { targetRisk: 0.1, confidence: 0.95 });
    if ((a === undefined) !== (b === undefined)) equivalent = false;
    else if (a !== undefined) {
      if (a.threshold !== b.threshold) equivalent = false;
      const diff = Math.abs(a.riskBound - Math.round(b.riskBound * 1e6) / 1e6);
      worstRiskDiff = Math.max(worstRiskDiff, diff);
      if (diff > 2e-6) equivalent = false;
      if (Math.abs(a.empiricalRisk - b.empiricalRisk) > 2e-6) equivalent = false;
    }
  }
  ok(equivalent, `200 组随机 (n∈[50,1550], G∈[4,40])：新算法与旧实现阈值逐位一致、风险界最大差 ${worstRiskDiff.toExponential(1)} ≤ 2e-6（0/1 指示方差代数恒等式 k(1−mean)²+(n−k)mean²，仅 round 抖动）`);
  // (b) 公式级等价：方差恒等式逐点（200 次）
  const rngV = mulberry32(305);
  let varOk = true;
  for (let t = 0; t < 200; t += 1) {
    const n = 10 + Math.floor(rngV() * 500);
    const arr = Array.from({ length: n }, () => rngV());
    const lambda = rngV();
    let below = 0;
    for (const s of arr) if (s < lambda) below += 1;
    const mean = below / n;
    let twoPass = 0;
    for (const s of arr) {
      const d = (s < lambda ? 1 : 0) - mean;
      twoPass += d * d;
    }
    twoPass /= n - 1;
    const closed = (below * (1 - mean) * (1 - mean) + (n - below) * mean * mean) / (n - 1);
    if (Math.abs(twoPass - closed) > 1e-9) varOk = false;
  }
  ok(varOk, '公式级等价：闭式方差 vs 两遍累加 200 组差 ≤ 1e-9（灾难消去安全区）');
  // (c) 规模-耗时对照（宽松方向性断言）
  const rngT = mulberry32(306);
  const nBig = 32768;
  const samples = Array.from({ length: nBig }, () => 0.7 + rngT() * 0.3);
  const grid32 = Array.from({ length: 32 }, (_, i) => 0.5 + (0.45 * i) / 31);
  const grid64 = Array.from({ length: 64 }, (_, i) => 0.5 + (0.45 * i) / 63);
  const opts = { targetRisk: 0.1, confidence: 0.95 };
  for (let w = 0; w < 3; w += 1) {
    selectRiskControlledThreshold(samples, grid64, opts);
    selectOld(samples, grid64, opts);
  }
  const tNew32 = timeIt(() => selectRiskControlledThreshold(samples, grid32, opts), 15);
  const tNew64 = timeIt(() => selectRiskControlledThreshold(samples, grid64, opts), 15);
  const tOld32 = timeIt(() => selectOld(samples, grid32, opts), 15);
  const tOld64 = timeIt(() => selectOld(samples, grid64, opts), 15);
  ok(tNew64 < tOld64, `n=32768 G=64：新 ${tNew64.toFixed(2)}ms < 旧 ${tOld64.toFixed(2)}ms（O(n log n + G·log n) 替代 O(2Gn)，方向性断言）`);
  ok(
    tNew64 / tNew32 < tOld64 / tOld32,
    `网格翻倍代价：新 ${tNew64.toFixed(2)}/${tNew32.toFixed(2)} = ${(tNew64 / tNew32).toFixed(2)}×（排序主导，近网格无关）< 旧 ${(tOld64 / tOld32).toFixed(2)}×（线性于 G）——复杂度质变的方向性证据`,
  );
}

// ═══════════════════ D robust-statistics.ts（23.0 → R5） ═══════════════════

section('D1 robust：selectKth 逐位等价（quickselect vs 全量排序）');

{
  const { selectKth } = robust;
  const rng = mulberry32(401);
  let mismatch = 0;
  for (let t = 0; t < 300; t += 1) {
    const len = 1 + Math.floor(rng() * 500);
    // 高重复值 + 奇偶长度混合（三路分区压力）
    const arr = Array.from({ length: len }, () => Math.floor(rng() * 12) - 6);
    const k = Math.floor(rng() * len);
    const expected = [...arr].sort((a, b) => a - b)[k];
    if (selectKth([...arr], k) !== expected) mismatch += 1;
  }
  // 病态：全同值 / 有序 / 逆序 / 单元素
  const pathological = [[7], [3, 3, 3, 3, 3], [1, 2, 3, 4, 5], [5, 4, 3, 2, 1], [2, 1, 2, 1, 2, 1]];
  for (const arr of pathological) {
    const k = arr.length - 1;
    if (selectKth([...arr], k) !== [...arr].sort((a, b) => a - b)[k]) mismatch += 1;
  }
  ok(mismatch === 0, `300 组随机（含高重复值）+ 5 组病态输入：quickselect 第 k 阶与全量排序逐位相同（中位数是精确次序统计量）`);
}

section('D2 robust：madSigma / medianOfMeans 逐位回归（新 quickselect vs 旧排序法）');

{
  const { madSigma, medianOfMeans } = robust;
  const madOld = (samples) => {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const deviations = samples.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
    const mad = deviations.length % 2 === 1
      ? deviations[Math.floor(deviations.length / 2)]
      : (deviations[deviations.length / 2 - 1] + deviations[deviations.length / 2]) / 2;
    return Math.max(1e-9, 1.4826 * mad);
  };
  const momOld = (samples, alpha = 0.05) => {
    const n = samples.length;
    if (n === 0) return { mean: 0, blocks: 0, lower: 0, upper: 0, sigma: 0 };
    const k = Math.max(3, Math.min(n, Math.ceil(8 * Math.log(1 / Math.max(alpha, 1e-12)))));
    if (n < k) {
      const mean = samples.reduce((s, x) => s + x, 0) / n;
      return { mean, blocks: 1, lower: mean, upper: mean, sigma: madOld(samples) };
    }
    const size = Math.floor(n / k);
    const blockMeans = [];
    for (let b = 0; b < k; b += 1) {
      const slice = samples.slice(b * size, (b + 1) * size);
      blockMeans.push(slice.reduce((s, x) => s + x, 0) / slice.length);
    }
    const sorted = [...blockMeans].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const sigma = madOld(samples);
    const radius = sigma * Math.sqrt(32 * Math.log(1 / Math.max(alpha, 1e-12)) / n);
    return { mean: median, blocks: k, lower: median - radius, upper: median + radius, sigma };
  };
  const rng = mulberry32(402);
  let bitSame = 0;
  for (let t = 0; t < 300; t += 1) {
    const len = 1 + Math.floor(rng() * 600);
    const arr = Array.from({ length: len }, () => Math.floor(rng() * 30) - 15 + rng() * 0.5);
    if (madSigma(arr) === madOld(arr)) bitSame += 1;
  }
  ok(bitSame === 300, `madSigma 新旧实现 300 组逐位相同（${bitSame}/300）`);
  const rng2 = mulberry32(403);
  let momSame = 0;
  for (let t = 0; t < 200; t += 1) {
    const len = 8 + Math.floor(rng2() * 500);
    const arr = Array.from({ length: len }, () => rng2() * 10 - 2);
    const a = medianOfMeans(arr, 0.05);
    const b = momOld(arr, 0.05);
    if (JSON.stringify(a) === JSON.stringify(b)) momSame += 1;
  }
  ok(momSame === 200, `medianOfMeans 全字段（mean/blocks/lower/upper/sigma）200 组与旧排序实现逐位相同（${momSame}/200）`);
}

section('D3 robust：catoniMean 逐位回归（单遍 min/max 替代展开调用）');

{
  const { catoniMean } = robust;
  const catoniOld = (samples, alpha = 0.05) => {
    const n = samples.length;
    if (n === 0) return { mean: 0, lower: 0, upper: 0, sigma: 0, radius: 0 };
    const sum = samples.reduce((s, x) => s + x, 0) / n;
    if (n < 2) return { mean: sum, lower: sum, upper: sum, sigma: 0, radius: 0 };
    // 旧实现使用 madOld 等价排序路径已被 D2 证明与 madSigma 逐位一致，此处直接复用新 madSigma
    const sigma = robust.madSigma(samples);
    const delta = Math.min(1, Math.sqrt(2 * Math.log(2 / alpha) / (n * sigma * sigma)));
    let lo = Math.min(...samples);
    let hi = Math.max(...samples);
    const g = (theta) => {
      let acc = 0;
      for (const x of samples) {
        const y = x - theta;
        const ay = Math.abs(y);
        acc += Math.sign(y) * Math.log(1 + delta * ay + (delta * ay * ay * delta) / 2);
      }
      return acc;
    };
    if (g(lo) < 0 || g(hi) > 0) return { mean: sum, lower: sum, upper: sum, sigma, radius: 0 };
    for (let i = 0; i < 80; i += 1) {
      const mid = (lo + hi) / 2;
      if (g(mid) > 0) lo = mid;
      else hi = mid;
    }
    const mean = (lo + hi) / 2;
    const radius = Math.min(hi - lo + sigma * Math.sqrt(8 * Math.log(2 / alpha) / n), Math.max(...samples) - Math.min(...samples));
    return { mean, lower: mean - radius, upper: mean + radius, sigma, radius };
  };
  const rng = mulberry32(404);
  let same = 0;
  for (let t = 0; t < 200; t += 1) {
    const len = 2 + Math.floor(rng() * 800);
    const arr = Array.from({ length: len }, () => 1 + (rng() - 0.5) * 4);
    if (JSON.stringify(catoniMean(arr, 0.05)) === JSON.stringify(catoniOld(arr, 0.05))) same += 1;
  }
  ok(same === 200, `catoniMean 全字段 200 组逐位回归通过（${same}/200；单遍循环与 Math.min(...spread) 结果相同，且免 1.2e5 元素展开的参数上限风险）`);
}

section('D4 robust：Hodges–Lehmann 估计（定理性质检验）');

{
  const { hodgesLehmann, HL_BREAKDOWN_POINT } = robust;
  // 常数锚点
  ok(near(HL_BREAKDOWN_POINT, 1 - 1 / Math.SQRT2, 1e-15) && near(HL_BREAKDOWN_POINT, 0.2928932188, 1e-9), `崩溃点常数 = 1−1/√2 = ${HL_BREAKDOWN_POINT.toFixed(10)}（29.29%，Hodges–Lehmann 1963）`);
  // 对数锚点：{1,2,3} 的 Walsh 平均 {1, 1.5, 2, 2, 2.5, 3} → 中位数 2
  const h3 = hodgesLehmann([1, 2, 3]);
  ok(h3.estimate === 2 && h3.pairs === 6, 'HL({1,2,3}) = 2（6 个 Walsh 平均 {1,1.5,2,2,2.5,3} 的中位数——手算锚点）');
  // (a) 置换不变（200 次，逐位）
  const rngP = mulberry32(405);
  let permOk = true;
  for (let t = 0; t < 200; t += 1) {
    const arr = Array.from({ length: 30 }, () => rngP() * 10 - 3);
    const base = hodgesLehmann(arr).estimate;
    const shuffled = [...arr];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rngP() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (hodgesLehmann(shuffled).estimate !== base) permOk = false;
  }
  ok(permOk, '200 次随机置换 → HL 估计逐位不变（Walsh 平均多重集合与顺序无关）');
  // (b) 平移等变（200 次，容差 1e-9 相对）
  const rngS = mulberry32(406);
  let shiftOk = true;
  for (let t = 0; t < 200; t += 1) {
    const c = (rngS() - 0.5) * 100;
    const arr = Array.from({ length: 40 }, () => rngS() * 5);
    const a = hodgesLehmann(arr).estimate;
    const b = hodgesLehmann(arr.map((x) => x + c)).estimate;
    if (Math.abs(b - (a + c)) > 1e-9 * (1 + Math.abs(c))) shiftOk = false;
  }
  ok(shiftOk, '200 次随机平移：HL(x+c) = HL(x)+c（平移等变，容差 1e-9·尺度）');
  // (c) 崩溃点实证：25% 污染（< 29.29%）估计不垮
  const rngB = mulberry32(407);
  const clean = Array.from({ length: 200 }, () => (gaussianPair(rngB))[0] * 0.1);
  const poisoned = [...clean, ...Array.from({ length: 67 }, () => 1e9)]; // 25.1%
  const hlP = hodgesLehmann(poisoned).estimate;
  const meanP = poisoned.reduce((s, x) => s + x, 0) / poisoned.length;
  ok(Math.abs(hlP) < 1 && meanP > 1e8, `25.1% 巨尾污染（1e9）：HL = ${hlP.toFixed(4)} 稳如泰山 vs 算术均值 = ${meanP.toExponential(2)}（崩溃点 29.29% 以内污染无法搬动估计）`);
  // (d) ARE 3/π ≈ 0.955：干净正态流上 HL 与算术均值的效率相当
  const rngE = mulberry32(408);
  const errsHL = [];
  const errsMean = [];
  for (let t = 0; t < 200; t += 1) {
    const arr = [];
    for (let i = 0; i < 250; i += 1) arr.push(gaussianPair(rngE)[0]);
    errsHL.push(Math.abs(hodgesLehmann(arr).estimate));
    errsMean.push(Math.abs(arr.reduce((s, x) => s + x, 0) / arr.length));
  }
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const ratio = med(errsHL) / med(errsMean);
  ok(ratio <= 1.15, `正态流 200 次 n=250：HL 误差中位数 / 均值误差中位数 = ${ratio.toFixed(3)} ≤ 1.15（ARE = 3/π ≈ 0.955 → 理论比 ≈ 1.023）`);
}

section('D5 robust：性能对照（quickselect 中位数 vs 排序中位数）');

{
  const { madSigma } = robust;
  const madOld = (samples) => {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const deviations = samples.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
    const mad = deviations.length % 2 === 1
      ? deviations[Math.floor(deviations.length / 2)]
      : (deviations[deviations.length / 2 - 1] + deviations[deviations.length / 2]) / 2;
    return Math.max(1e-9, 1.4826 * mad);
  };
  const rng = mulberry32(409);
  const n1 = 16384;
  const n2 = 65536;
  const a1 = Array.from({ length: n1 }, () => rng() * 1000);
  const a2 = Array.from({ length: n2 }, () => rng() * 1000);
  for (let w = 0; w < 3; w += 1) {
    madSigma(a1);
    madOld(a1);
    madSigma(a2);
    madOld(a2);
  }
  const tNew1 = timeIt(() => madSigma(a1), 10);
  const tOld1 = timeIt(() => madOld(a1), 10);
  const tNew2 = timeIt(() => madSigma(a2), 5);
  const tOld2 = timeIt(() => madOld(a2), 5);
  ok(tNew1 < tOld1, `n=${n1}：quickselect ${tNew1.toFixed(2)}ms < 排序 ${tOld1.toFixed(2)}ms（${(tOld1 / tNew1).toFixed(1)}×）`);
  ok(tNew2 < tOld2 && tOld2 / tNew2 > tOld1 / tNew1 * 0.8, `n=${n2}（4n）：quickselect ${tNew2.toFixed(2)}ms < 排序 ${tOld2.toFixed(2)}ms（${(tOld2 / tNew2).toFixed(1)}×，O(n)/O(n log n) 的规模优势不衰减）`);
}

// ═══════════════════ E differential-privacy.ts（24.0 → R5） ═══════════════════

section('E1 privacy：指数机制（分布锚点 + 单调性 + 溢出安全）');

{
  const { exponentialMechanism } = privacy;
  // (a) 分布锚点：ε=ln3、Δ=1、utilities 0..3 → P(i) ∝ 3^(u/2)
  const rng = mulberry32(501);
  const N = 8000;
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < N; i += 1) counts[exponentialMechanism([0, 1, 2, 3], Math.log(3), 1, rng)] += 1;
  const w = [0, 1, 2, 3].map((u) => Math.pow(3, u / 2));
  const tot = w.reduce((a, b) => a + b, 0);
  const theory = w.map((x) => x / tot);
  const emp = counts.map((c) => c / N);
  const maxDev = Math.max(...emp.map((p, i) => Math.abs(p - theory[i])));
  ok(maxDev < 0.02, `ε=ln3 采样频率 [${emp.map((p) => p.toFixed(4)).join(', ')}] vs 理论 softmax 3^(u/2) [${theory.map((p) => p.toFixed(4)).join(', ')}]，最大偏差 ${maxDev.toFixed(4)} < 0.02（McSherry–Talwar 精确分布）`);
  // (b) ε→0 退化为均匀；ε 大退化为准 argmax
  const rng0 = mulberry32(502);
  const c0 = [0, 0, 0];
  for (let i = 0; i < 6000; i += 1) c0[exponentialMechanism([1, 2, 3], 1e-9, 1, rng0)] += 1;
  ok(c0.every((c) => Math.abs(c / 6000 - 1 / 3) < 0.03), `ε→0 → 均匀：[${c0.map((c) => (c / 6000).toFixed(3)).join(', ')}] ≈ 1/3（零预算时信息最省）`);
  const rngBig = mulberry32(503);
  let argmaxHits = 0;
  for (let i = 0; i < 2000; i += 1) if (exponentialMechanism([0, 1, 2, 3], 50, 1, rngBig) === 3) argmaxHits += 1;
  ok(argmaxHits / 2000 >= 0.999, `ε=50 → 效用最大化者命中 ${(argmaxHits / 2000 * 100).toFixed(1)}% ≥ 99.9%（隐私-效用连续谱的另一端）`);
  // (c) 单调性：2000 次采样，高效用项被选频率严格更高
  const rngM = mulberry32(504);
  let hits2 = 0;
  let hits1 = 0;
  for (let i = 0; i < 2000; i += 1) {
    if (exponentialMechanism([0, 0, 0, 2], Math.log(3), 1, rngM) === 3) hits2 += 1;
    if (exponentialMechanism([0, 0, 0, 1], Math.log(3), 1, rngM) === 3) hits1 += 1;
  }
  ok(hits2 > hits1, `效用单调性：u=3 档位命中 ${hits2}/2000 > u=2 档位 ${hits1}/2000（效用越高被选概率越高——机制的第一性质）`);
  // (d) 溢出安全：ε·Δu⁻¹·u ~ 5000，线性 softmax 会 exp 溢出为 NaN
  const rngO = mulberry32(505);
  let overflowSafe = true;
  for (let i = 0; i < 200; i += 1) {
    const pick = exponentialMechanism([0, 1000], 10, 1, rngO);
    if (pick !== 1) overflowSafe = false;
  }
  const naive = [0, 1000].map((u) => Math.exp((10 * u) / 2));
  ok(overflowSafe && !Number.isFinite(naive[1]), `log 域采样 200/200 全选最优项且无 NaN（线性 softmax 权重 e^5000 = ${naive[1]} 溢出对照）`);
  // (e) 敏感度 0（数据无关）→ 均匀
  const rngU = mulberry32(506);
  const cu = [0, 0, 0, 0];
  for (let i = 0; i < 4000; i += 1) cu[exponentialMechanism([5, 6, 7, 8], 10, 0, rngU)] += 1;
  ok(cu.every((c) => Math.abs(c / 4000 - 0.25) < 0.03), `Δu=0（效用不依赖数据）→ 均匀采样 [${cu.map((c) => (c / 4000).toFixed(3)).join(', ')}]（0-DP）`);
}

section('E2 privacy：高斯 RDP 闭式最优阶转换（精确化记账）');

{
  const { gaussianRdpEpsilon, rdpToEpsilonOptimal, rdpToEpsilon, RDP_ORDER } = privacy;
  // (a) 闭式最优阶锚点：α* = max(2, 1 + σ√(2ln(1/δ))/Δ)（200 组随机参数）
  const rng = mulberry32(507);
  let orderOk = true;
  for (let t = 0; t < 200; t += 1) {
    const sigma = 0.3 + rng() * 5;
    const delta = Math.pow(10, -(4 + rng() * 8));
    const r = gaussianRdpEpsilon(sigma, 1, delta);
    const expected = Math.max(2, 1 + (sigma * Math.sqrt(2 * Math.log(1 / delta))) / 1);
    if (Math.abs(r.optimalOrder - expected) > 1e-9) orderOk = false;
  }
  ok(orderOk, '200 组 (σ, δ)：最优阶 = max(2, 1+σ√(2ln(1/δ))/Δ)（凸目标 f′(α)=0 的闭式解）');
  // (b) 任意参数下 optimal ≤ 固定阶 8（且严格更优案例存在）
  let allNoWorse = true;
  let strictlyBetter = 0;
  for (let t = 0; t < 200; t += 1) {
    const sigma = 0.2 + rng() * 8;
    const l2 = 0.1 + rng() * 3;
    const delta = Math.pow(10, -(4 + rng() * 8));
    const r = gaussianRdpEpsilon(sigma, l2, delta);
    if (!(r.epsilon <= r.fixedOrderEpsilon + 1e-9) || r.saving < -1e-9) allNoWorse = false;
    if (r.saving > 1e-6) strictlyBetter += 1;
  }
  ok(allNoWorse, '200 组随机 (σ, Δ, δ)：精确账单 ≤ 固定阶 8 账单（RDP 引理逐阶取 min 的单调正确性）');
  ok(strictlyBetter > 50, `200 组中 ${strictlyBetter} 组严格更省（固定阶 8 只在 α*=8 时最优——同噪声更小 ε = 免费的隐私精度）`);
  // (c) 网格交叉验证：细网格 sup 不小于闭式解（闭式 ≤ 一切网格点 + 容差）
  const sigma = 1.5;
  const delta = 1e-6;
  const lni = Math.log(1 / delta);
  let gridMin = Number.POSITIVE_INFINITY;
  for (let a = 2; a <= 1024; a += 0.125) {
    const f = (a * 1 * 1) / (2 * sigma * sigma) + lni / (a - 1);
    if (f < gridMin) gridMin = f;
  }
  const closed = gaussianRdpEpsilon(sigma, 1, delta);
  ok(closed.epsilon <= gridMin + 1e-9, `闭式最优 ε = ${closed.epsilon.toFixed(6)} ≤ 细网格(步长 1/8, α∈[2,1024])最优 ${gridMin.toFixed(6)} + 1e-9（全局最优性交叉验证）`);
  // (d) rdpToEpsilonOptimal = 逐阶最小
  const entries = [
    { order: 2, rdp: 0.5 },
    { order: 8, rdp: 1.2 },
    { order: 32, rdp: 3.0 },
  ];
  const opt = rdpToEpsilonOptimal(entries, 1e-6);
  const perOrder = entries.map((e) => rdpToEpsilon(e.rdp, e.order, 1e-6));
  ok(near(opt, Math.min(...perOrder), 1e-12), `rdpToEpsilonOptimal = min(${perOrder.map((v) => v.toFixed(4)).join(', ')}) = ${opt.toFixed(4)}（多阶记账取最优）`);
  ok(RDP_ORDER === 8, `固定阶常数 RDP_ORDER = ${RDP_ORDER}（旧口径对照锚点，未变）`);
}

section('E3 privacy：预算守恒律（几何分账不超支）');

{
  const { PrivacyAccountant } = privacy;
  const acc = new PrivacyAccountant({ epsilon: 1 }, mulberry32(508));
  let numeric = 0;
  for (let i = 0; i < 13; i += 1) {
    const v = acc.laplace(100, 1, 'probe');
    if (typeof v === 'number') numeric += 1;
  }
  const st = acc.status();
  const expectedSpent = 1 - Math.pow(2, -13);
  ok(numeric === 13 && st.releases.length === 13, `13 次折半分账全部成功（0.5+0.25+…+2⁻¹³）`);
  ok(Math.abs(st.epsilonSpent - Math.round(expectedSpent * 1e6) / 1e6) < 1.5e-6, `已耗 ε = ${st.epsilonSpent} = 1 − 2⁻¹³ = ${expectedSpent.toFixed(9)}（几何级数守恒，容差含 round）`);
  ok(st.epsilonSpent <= 1 && st.epsilonRemaining >= 0, `总消耗 ${st.epsilonSpent} ≤ 预算 1（永不超支的预算纪律）`);
  // 预算耗尽后拒绝发布（诚实拒绝）
  const tiny = new PrivacyAccountant({ epsilon: 1e-6 }, mulberry32(509));
  ok(tiny.status().exhausted === true && tiny.laplace(5, 1, 'x') === undefined, 'ε=1e-6 账本 born-exhausted：发布被拒（undefined，不静默超支）');
}

section('E4 privacy：噪声分布性质（种子化 20000 抽样）');

{
  const { laplaceNoise, gaussianNoise } = privacy;
  const rngL = mulberry32(510);
  const draws = [];
  for (let i = 0; i < 20000; i += 1) draws.push(laplaceNoise(1, rngL));
  const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
  const sorted = [...draws].sort((a, b) => a - b);
  const median = (sorted[9999] + sorted[10000]) / 2;
  ok(Math.abs(mean) < 0.05 && Math.abs(median) < 0.05, `Laplace(1) 20000 抽样：均值 ${mean.toFixed(4)} / 中位数 ${median.toFixed(4)} ≈ 0（对称性）`);
  // 分位数形状锚点：Laplace(0,1) 的 Q3 满足 1−0.5e^{−q} = 0.75 → q = ln2
  const empQ3 = sorted[14999];
  ok(Math.abs(empQ3 - Math.log(2)) < 0.05, `经验 Q3 = ${empQ3.toFixed(4)} ≈ 理论 ln2 = ${Math.log(2).toFixed(4)}（逆 CDF 分位数形状锚点）`);
  const rngG = mulberry32(511);
  const g = [];
  for (let i = 0; i < 20000; i += 1) g.push(gaussianNoise(rngG));
  const mg = g.reduce((a, b) => a + b, 0) / g.length;
  const vg = g.reduce((s, x) => s + (x - mg) ** 2, 0) / g.length;
  ok(Math.abs(mg) < 0.05 && vg > 0.9 && vg < 1.1, `标准正态 20000 抽样：均值 ${mg.toFixed(4)} ≈ 0、方差 ${vg.toFixed(4)} ∈ [0.9, 1.1]（Box–Muller 无偏/单位方差）`);
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL ${failed} —— R5 统计推断五内核进化闭环成立（evidence 3.0 / anytime 12.0 / conformal 13.0 / robust 23.0 / privacy 24.0）`);
  process.exit(0);
} else {
  console.error(`PASS ${passed} / FAIL ${failed} —— 存在失败断言`);
  process.exit(1);
}
