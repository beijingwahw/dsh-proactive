/**
 * verify-test-time-compute.mjs — 52.0 测试时计算内核纯数学离线验证
 *
 * 每个数学核心都有解析解 / 手算对照（不是「能跑」，是「算得对」）：
 *   (a) 自一致性投票：p=0.6,n=5 手算 0.68256（= 10·0.6³·0.4² + 5·0.6⁴·0.4
 *       + 0.6⁵，二项表对照）；p=0.4 对称补 0.31744；p=0.5 任意 n/ρ 恒 0.5
 *       （投票无增益的诚实判定）；独立重算（乘法递推二项和）对照 1e-9；
 *       β-binomial 与 de Finetti 数值积分（Simpson 20 万格，归一化相消，
 *       完全不依赖 Γ 函数）对照；相关性天花板闭式 1 − I_{1/2}(α,β) 与
 *       积分对照 + 收敛收紧；n_eff = 9/(1+8·0.2) = 45/13；
 *       单调性扫描（二分查找的前提被验证而非被相信）。
 *   (b) 幂律拟合：精确数据参数回收（含远渐近线 a=5 的括号自动扩张）；
 *       已知渐近线时 (b, β) 为精确线性解（1e-9）；边际 = 数值导数对照；
 *       噪声数据的诚实 rmse/r2。
 *   (c) 水填充：ΣC_i=B 守恒、两策略边际相等（1e-6）、等 β 闭式比例
 *       (b_i/b_j)^{1/(β+1)}（1e-9）、局部最优性扰动检查（δ 搬预算只降
 *       不升）、单策略退化=全押、下限钉住边际 ≤ λ / 上限钉住 ≥ λ（KKT
 *       不等式方向）、上限留白 slack 诚实暴露、Σmin>B 显式拒绝。
 *   (d) 早停：闭式停机阈值 C* = (bβ/price)^{1/(β+1)} = 50^{2/3} ≈ 13.57
 *       ——预算 B=10 内边际恒高于价格不触发、C=20 超额触发；等号继续约定。
 *
 * 全部断言确定性（无随机源——内核与验证均不需要随机）。
 * 运行：node --experimental-strip-types scripts/verify-test-time-compute.mjs
 */

import {
  majorityAccuracy,
  voteEffectiveSampleSize,
  voteAccuracyCeiling,
  optimalVoteN,
  powerLawFit,
  powerLawQuality,
  powerLawMarginal,
  waterfillBudget,
  earlyStopRule,
} from '../src/core/test-time-compute.ts';

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
    ok(false, `${label}（未抛出）`);
  } catch (e) {
    ok(true, `${label}（${String(e.message).slice(0, 52)}…）`);
  }
}

// 独立 Simpson 积分（对照 β-binomial：分子分母同积分，归一化常数相消——
// 完全不依赖 Γ/Beta 函数，与内核的 log-Γ 逐项求和是两条独立数值路径）
function simpson(f, lo, hi, m) {
  const h = (hi - lo) / m;
  let s = f(lo) + f(hi);
  for (let i = 1; i < m; i += 1) s += f(lo + i * h) * (i % 2 === 1 ? 4 : 2);
  return (s * h) / 3;
}
/** P(Bin(7,θ) ≥ 4)：整数系数表 [C(7,4), C(7,5), C(7,6), C(7,7)] 直接展开 */
function binTail7(theta) {
  const coef = [35, 21, 7, 1];
  let s = 0;
  for (let j = 0; j < 4; j += 1) s += coef[j] * Math.pow(theta, 4 + j) * Math.pow(1 - theta, 3 - j);
  return s;
}

// ═══════════════════ (a) 自一致性投票 ═══════════════════

section('52.0 (a) 自一致性投票：二项精确值 / 对称性 / 相关校正');

{
  // 锚点①：p=0.6, n=5 手算——二项表逐项对照
  // M = 10·0.6³·0.4² + 5·0.6⁴·0.4 + 0.6⁵ = 0.3456 + 0.2592 + 0.07776
  const m5 = majorityAccuracy(0.6, 5);
  ok(near(m5, 0.68256, 1e-12), `M(0.6,5) = ${m5.toPrecision(10)}（手算 0.68256 = 0.3456+0.2592+0.07776）`);
  // 对称补：p=0.4 与 p=0.6 互补（错误多数票 = 正确多数票）
  const m5c = majorityAccuracy(0.4, 5);
  ok(near(m5c, 0.31744, 1e-12) && near(m5 + m5c, 1, 1e-12), `M(0.4,5) = ${m5c.toPrecision(10)} = 1 − 0.68256（对称补）`);
  // p<0.5 时多数票放大错误：M(0.4,5) < 0.4
  ok(m5c < 0.4, `M(0.4,5) = ${m5c.toPrecision(6)} < p = 0.4（多数票放大系统性错误）`);
  // n=7 手算：0.290304 + 0.2612736 + 0.1306368 + 0.0279936
  const m7 = majorityAccuracy(0.6, 7);
  ok(near(m7, 0.710208, 1e-12), `M(0.6,7) = ${m7.toPrecision(10)}（手算 0.710208）`);
  // n=1 退化为单样本
  ok(majorityAccuracy(0.83, 1) === 0.83, 'M(p,1) = p（单样本即自身）');

  // 独立重算：乘法递推二项 pmf（与内核 log-Γ 求和不同的算术路径），p=0.7, n=21
  const p = 0.7;
  const n = 21;
  let pmf = Math.pow(1 - p, n); // i=0 起步，逐步乘 (n−i+1)/i·p/(1−p)
  let cdf0 = pmf;
  for (let i = 1; i <= (n - 1) / 2; i += 1) {
    pmf *= ((n - i + 1) / i) * (p / (1 - p));
    cdf0 += pmf;
  }
  const kernel21 = majorityAccuracy(0.7, 21);
  ok(near(kernel21, 1 - cdf0, 1e-9), `M(0.7,21) = ${kernel21.toPrecision(10)}（乘法递推独立重算 ${ (1 - cdf0).toPrecision(10) }）`);

  // 锚点②：p=0.5 → 任何 n、任何 ρ 都恒 0.5（投票无增益的诚实判定）
  let allHalf = true;
  for (const nn of [1, 3, 5, 31, 101]) {
    if (!near(majorityAccuracy(0.5, nn), 0.5, 1e-12)) allHalf = false;
    if (!near(majorityAccuracy(0.5, nn, 0.15), 0.5, 1e-12)) allHalf = false;
  }
  ok(allHalf, 'M(0.5,n) ≡ 0.5 ∀n∈{1,3,5,31,101}, ρ∈{0,0.15}（对称性——掷硬币投票无增益）');

  // 独立情形单调增益（Condorcet）
  const a1 = majorityAccuracy(0.6, 1);
  const a21 = majorityAccuracy(0.6, 21);
  const a101 = majorityAccuracy(0.6, 101);
  ok(a1 < m5 && m5 < a21 && a21 < a101, `独立多数票单调增益：${a1} < ${m5.toPrecision(6)} < ${a21.toPrecision(6)} < ${a101.toPrecision(6)}（Condorcet）`);

  // 相关校正：ρ>0 压低投票增益 + 有效样本数闭式 9/(1+8·0.2) = 45/13
  const neff = voteEffectiveSampleSize(9, 0.2);
  ok(near(neff, 45 / 13, 1e-12), `n_eff(9, 0.2) = ${neff.toPrecision(10)} = 45/13（相关让 9 路只剩 3.46 路的方差口径）`);
  ok(
    majorityAccuracy(0.6, 9, 0.2) < majorityAccuracy(0.6, 9),
    `ρ=0.2 压低增益：M(0.6,9,0.2)=${majorityAccuracy(0.6, 9, 0.2).toPrecision(6)} < M(0.6,9)=${majorityAccuracy(0.6, 9).toPrecision(6)}`,
  );

  // β-binomial ↔ de Finetti 数值积分对照（Simpson 20 万格，归一化相消）
  // p=0.6, ρ=0.25 → α=1.8, β=1.2；M = ∫ BinTail(7,θ)·θ^{0.8}(1−θ)^{0.2} / ∫ θ^{0.8}(1−θ)^{0.2}
  const M = 200000;
  const num = simpson((t) => binTail7(t) * Math.pow(t, 0.8) * Math.pow(1 - t, 0.2), 0, 1, M);
  const den = simpson((t) => Math.pow(t, 0.8) * Math.pow(1 - t, 0.2), 0, 1, M);
  const simpsonAcc = num / den;
  const bb = majorityAccuracy(0.6, 7, 0.25);
  ok(near(bb, simpsonAcc, 2e-7), `β-binomial M(0.6,7,ρ=0.25) = ${bb.toPrecision(10)}（de Finetti 积分 ${simpsonAcc.toPrecision(10)}，Δ=${Math.abs(bb - simpsonAcc).toExponential(2)}）`);

  // 相关性天花板：闭式 1 − I_{1/2}(2.4,1.6) ↔ 积分 ∫_{0.5}^{1} θ^{1.4}(1−θ)^{0.6} / ∫_0^1
  const ceil = voteAccuracyCeiling(0.6, 0.2);
  const numC = simpson((t) => Math.pow(t, 1.4) * Math.pow(1 - t, 0.6), 0.5, 1, M);
  const denC = simpson((t) => Math.pow(t, 1.4) * Math.pow(1 - t, 0.6), 0, 1, M);
  ok(near(ceil, numC / denC, 1e-8), `ceiling(0.6,0.2) = ${ceil.toPrecision(10)}（积分对照 ${(numC / denC).toPrecision(10)}；ρ=0.2 时投票最多到 0.672，加样本到不了 1）`);
  ok(ceil > 0.6 && ceil < 1, `0.6 < 天花板 < 1（${ceil.toPrecision(6)}：相关仍有增益但增益有界）`);
  // 收敛收紧：|M(n) − ceiling| 随 n 单调收窄且恒 ≤ 0
  const g11 = Math.abs(majorityAccuracy(0.6, 11, 0.2) - ceil);
  const g61 = Math.abs(majorityAccuracy(0.6, 61, 0.2) - ceil);
  const g301 = Math.abs(majorityAccuracy(0.6, 301, 0.2) - ceil);
  ok(g301 < g61 && g61 < g11 && majorityAccuracy(0.6, 301, 0.2) <= ceil, `M→ceiling 从下方收紧：${g11.toExponential(2)} > ${g61.toExponential(2)} > ${g301.toExponential(2)}（M(301)=${majorityAccuracy(0.6, 301, 0.2).toPrecision(8)} ≤ 天花板）`);

  // 单调性扫描：二分查找的前提被验证而非被相信（含 β-binomial）
  let monoAll = true;
  for (const [pp, rr] of [[0.6, 0], [0.6, 0.2], [0.7, 0.1]]) {
    let prev = -1;
    for (let nn = 1; nn <= 61; nn += 2) {
      const v = majorityAccuracy(pp, nn, rr);
      if (v < prev - 1e-12) monoAll = false;
      prev = v;
    }
  }
  ok(monoAll, 'M(p,n,ρ) 对奇数 n 单调不减（p∈{0.6,0.7}, ρ∈{0,0.1,0.2}, n≤61——二分前提）');

  // optimalVoteN：最小 n 的手算锚点（0.68256 < 0.7 ≤ 0.710208 ⟹ n=7）
  ok(optimalVoteN(0.6, 0.7) === 7, `optimalVoteN(0.6, 0.7) = ${optimalVoteN(0.6, 0.7)}（M(5)=0.68256 < 0.7 ≤ M(7)=0.710208）`);
  ok(optimalVoteN(0.8, 0.75) === 1, `optimalVoteN(0.8, 0.75) = ${optimalVoteN(0.8, 0.75)}（单样本已达标 → n=1）`);
  const nR = optimalVoteN(0.6, 0.65, 0.2);
  ok(
    majorityAccuracy(0.6, nR, 0.2) >= 0.65 && majorityAccuracy(0.6, nR - 2, 0.2) < 0.65,
    `optimalVoteN(0.6, 0.65, ρ=0.2) = ${nR}（M(${nR})=${majorityAccuracy(0.6, nR, 0.2).toPrecision(6)} ≥ 0.65 > M(${nR - 2})=${majorityAccuracy(0.6, nR - 2, 0.2).toPrecision(6)}——最小性邻点口径）`,
  );

  // 诚实拒绝：p=0.5 无增益、target 超相关性天花板、入参非法
  throws(() => optimalVoteN(0.5, 0.6), 'optimalVoteN(0.5, 0.6) 抛出（投票无增益，不可达）');
  throws(() => optimalVoteN(0.6, 0.99, 0.2), 'optimalVoteN(0.6, 0.99, ρ=0.2) 抛出（超天花板）');
  throws(() => majorityAccuracy(0.6, 4), 'majorityAccuracy(0.6, 4) 抛出（n 需奇数）');
  throws(() => majorityAccuracy(1.2, 5), 'majorityAccuracy(1.2, 5) 抛出（p ∉ [0,1]）');
  throws(() => majorityAccuracy(0.6, 5, 1), 'majorityAccuracy(0.6, 5, ρ=1) 抛出（ρ ∈ [0,1)）');
}

// ═══════════════════ (b) 质量-算力幂律拟合 ═══════════════════

section('52.0 (b) 幂律拟合：精确回收 / 已知渐近线 / 边际导数对照');

{
  const trueCurve = { a: 0.9, b: 0.4, beta: 0.5 };
  const exactPts = [1, 2, 4, 8, 16].map((C) => ({ compute: C, quality: 0.9 - 0.4 * Math.pow(C, -0.5) }));

  // 未知渐近线：三维 {a,b,β} 精确回收
  const f1 = powerLawFit(exactPts);
  ok(
    near(f1.a, 0.9, 1e-6) && near(f1.b, 0.4, 1e-6) && near(f1.beta, 0.5, 1e-6),
    `精确数据回收 a=${f1.a.toPrecision(10)}, b=${f1.b.toPrecision(10)}, β=${f1.beta.toPrecision(10)}（真值 0.9/0.4/0.5）`,
  );
  ok(f1.rmse < 1e-12 && near(f1.r2, 1, 1e-12), `精确数据 rmse=${f1.rmse.toExponential(2)}, r2=${f1.r2.toPrecision(12)}（残差在浮点尘埃量级）`);

  // 已知渐近线：(b, β) 是 log-log 线性最小二乘的精确解
  const f2 = powerLawFit(exactPts, { asymptote: 0.9 });
  ok(
    near(f2.b, 0.4, 1e-9) && near(f2.beta, 0.5, 1e-9) && f2.asymptoteGiven,
    `已知渐近线 a=0.9：b=${f2.b.toPrecision(12)}, β=${f2.beta.toPrecision(12)}（精确线性解）`,
  );

  // 远渐近线 a=5：括号自动扩张后仍精确回收
  const farPts = [1, 2, 4, 8, 16].map((C) => ({ compute: C, quality: 5 - 3 * Math.pow(C, -0.3) }));
  const f3 = powerLawFit(farPts);
  ok(
    near(f3.a, 5, 1e-5) && near(f3.b, 3, 1e-5) && near(f3.beta, 0.3, 1e-6),
    `远渐近线回收 a=${f3.a.toPrecision(10)}, b=${f3.b.toPrecision(10)}, β=${f3.beta.toPrecision(10)}（真值 5/3/0.3，括号翻倍扩张生效）`,
  );

  // 噪声数据（确定性 ±0.008 交替扰动）：参数接近、rmse 不超噪声水平
  const noisyPts = [1, 2, 4, 8, 16].map((C, i) => ({ compute: C, quality: 0.9 - 0.4 * Math.pow(C, -0.5) + (i % 2 === 0 ? 0.008 : -0.008) }));
  const f4 = powerLawFit(noisyPts);
  ok(
    Math.abs(f4.beta - 0.5) <= 0.15 && Math.abs(f4.a - 0.9) <= 0.1 && f4.r2 > 0.99 && f4.rmse < 0.01,
    `噪声 ±0.008：a=${f4.a.toPrecision(4)}, β=${f4.beta.toPrecision(4)}（近真值），rmse=${f4.rmse.toPrecision(3)} < 噪声水平 0.008，r2=${f4.r2.toPrecision(4)}`,
  );

  // 幂律边际 = 数值导数（中心差分对照）
  const h = 1e-5;
  const C0 = 3.7;
  const numDeriv = (powerLawQuality(trueCurve, C0 + h) - powerLawQuality(trueCurve, C0 - h)) / (2 * h);
  const marg = powerLawMarginal(trueCurve, C0);
  ok(near(marg, numDeriv, 1e-6 * Math.max(1, Math.abs(numDeriv))), `∂Q/∂C(${C0}) = ${marg.toPrecision(8)}（中心差分 ${numDeriv.toPrecision(8)}）`);
  // 边际递减：C→0⁺ 时 +∞、C→∞ 时 →0 的单调口径
  ok(powerLawMarginal(trueCurve, 0.5) > powerLawMarginal(trueCurve, 1) && powerLawMarginal(trueCurve, 1) > powerLawMarginal(trueCurve, 10), '边际严格递减（0.5 → 1 → 10）');

  // 诚实拒绝：点数不足 / 质量平坦 / 质量递减 / 渐近线不高于实测
  throws(() => powerLawFit([{ compute: 1, quality: 0.5 }]), 'powerLawFit(<2 点) 抛出');
  throws(() => powerLawFit([{ compute: 1, quality: 0.5 }, { compute: 2, quality: 0.5 }, { compute: 4, quality: 0.5 }]), 'powerLawFit(质量平坦) 抛出（b→0 退化）');
  throws(() => powerLawFit([{ compute: 1, quality: 0.9 }, { compute: 2, quality: 0.85 }, { compute: 4, quality: 0.7 }]), 'powerLawFit(质量随算力递减) 抛出（β ≤ 0）');
  throws(() => powerLawFit(exactPts, { asymptote: 0.6 }), 'powerLawFit(asymptote ≤ max Q) 抛出');
}

// ═══════════════════ (c) 拉格朗日水填充 ═══════════════════

section('52.0 (c) 水填充：预算守恒 / 边际相等 / 闭式比例 / KKT 方向');

{
  const vote = { id: 'vote', a: 0.9, b: 0.4, beta: 0.5 };
  const refine = { id: 'refine', a: 0.85, b: 0.2, beta: 0.5 };
  const plan = waterfillBudget([vote, refine], 10);
  const [av, ar] = plan.allocations;

  // 锚点③：预算守恒 + 边际相等（1e-6）+ 等 β 闭式比例 (b_i/b_j)^{1/(β+1)}
  ok(near(plan.spent, 10, 1e-9), `ΣC_i = ${plan.spent.toPrecision(12)} = B = 10（预算守恒）`);
  ok(Math.abs(av.marginal - ar.marginal) <= 1e-6 && plan.equalized, `两策略边际相等：λ = ${plan.lambda.toPrecision(6)}（|Δ| = ${Math.abs(av.marginal - ar.marginal).toExponential(2)} ≤ 1e-6）`);
  const w1 = Math.pow(0.4 * 0.5, 2 / 3);
  const w2 = Math.pow(0.2 * 0.5, 2 / 3);
  ok(
    near(av.compute / ar.compute, Math.pow(2, 2 / 3), 1e-9) && near(av.compute, (10 * w1) / (w1 + w2), 1e-8),
    `等 β 闭式比例：C_vote/C_refine = ${(av.compute / ar.compute).toPrecision(10)} = (0.4/0.2)^{2/3} = 2^{2/3}；C_vote = B·w₁/Σw = ${av.compute.toPrecision(8)}`,
  );
  // 渐近线不影响分配（只影响总质量）：a 全体平移后分配不变
  const planShift = waterfillBudget([{ ...vote, a: 1.9 }, { ...refine, a: 0.01 }], 10);
  ok(near(planShift.allocations[0].compute, av.compute, 1e-9), '全体 a_i 平移 → 分配逐位不变（配比只看 b 与 β，KKT 推论的实证）');

  // 局部最优性：把 δ 预算从一策略搬到另一策略，总质量只降不升
  let noImprove = true;
  for (const d of [1e-3, 1e-2, 0.1]) {
    const perturbed =
      powerLawQuality(vote, av.compute + d) + powerLawQuality(refine, ar.compute - d);
    if (perturbed > plan.totalQuality + 1e-12) noImprove = false;
  }
  ok(noImprove, `扰动检查：δ∈{1e-3,1e-2,0.1} 搬预算总质量不增（水填充是局部最优的实证）`);

  // 锚点④：单策略退化 = 全押
  const solo = waterfillBudget([vote], 10);
  ok(near(solo.allocations[0].compute, 10, 1e-9), `单策略退化：C = ${solo.allocations[0].compute.toPrecision(12)}（全押 B=10）`);
  ok(near(solo.totalQuality, powerLawQuality(vote, 10), 1e-9), `单策略总质量 = Q(B) = ${solo.totalQuality.toPrecision(8)}`);

  // 下限钉住：refine min=5 > 自由解 3.865 → 钉在 5，KKT 方向 m_refine(5) ≤ λ
  const floored = waterfillBudget([vote, { ...refine, min: 5 }], 10);
  const [fv, fr] = floored.allocations;
  ok(fr.pinned === 'min' && near(fr.compute, 5, 1e-9) && near(fv.compute, 5, 1e-9), `min=5 钉住：C=[${fv.compute.toPrecision(6)}, ${fr.compute.toPrecision(6)}]（自由解 3.865 被下限顶起）`);
  ok(
    fr.marginal <= floored.lambda + 1e-9 && near(fv.marginal, floored.lambda, 1e-6),
    `KKT 方向：钉下限者边际 ${fr.marginal.toPrecision(4)} ≤ λ = ${floored.lambda.toPrecision(4)}（下限约束的对偶口径）`,
  );

  // 上限钉住：vote max=4 < 自由解 6.135 → 钉在 4，KKT 方向 m_vote(4) ≥ λ
  const capped = waterfillBudget([{ ...vote, max: 4 }, refine], 10);
  const [cv, cr] = capped.allocations;
  ok(cv.pinned === 'max' && near(cv.compute, 4, 1e-9) && near(cr.compute, 6, 1e-9), `max=4 钉住：C=[${cv.compute}, ${cr.compute.toPrecision(6)}]（剩余预算流向 refine）`);
  ok(cv.marginal >= capped.lambda - 1e-9, `KKT 方向：钉上限者边际 ${cv.marginal.toPrecision(4)} ≥ λ = ${capped.lambda.toPrecision(4)}`);

  // 双上限：花不完的预算诚实留白
  const slackPlan = waterfillBudget([{ ...vote, max: 3 }, { ...refine, max: 4 }], 10);
  ok(near(slackPlan.spent, 7, 1e-9) && near(slackPlan.slack, 3, 1e-9), `双上限：spent=7, slack=3（留白暴露而非假装花完）`);

  // 不等 β 三策略：守恒 + 自由边际全等
  const trio = waterfillBudget(
    [
      { id: 'vote', a: 0.9, b: 0.4, beta: 0.5 },
      { id: 'best-of-n', a: 0.95, b: 0.6, beta: 0.9 },
      { id: 'refine', a: 0.85, b: 0.15, beta: 0.25 },
    ],
    20,
  );
  const freeM = trio.allocations.filter((x) => x.pinned === null).map((x) => x.marginal);
  ok(
    near(trio.spent, 20, 1e-8) && freeM.length === 3 && freeM.every((m) => Math.abs(m - trio.lambda) <= 1e-6) && trio.allocations.every((x) => x.compute > 0),
    `不等 β 三策略：spent=${trio.spent.toPrecision(10)}，自由边际全等 λ=${trio.lambda.toExponential(3)}（β 越小（慢饱和）分得越多：${trio.allocations.map((x) => `${x.id}=${x.compute.toPrecision(4)}`).join(', ')}）`,
  );

  // 诚实拒绝：空曲线 / 负预算 / Σmin > B / 重复 id
  throws(() => waterfillBudget([], 10), 'waterfillBudget(空) 抛出');
  throws(() => waterfillBudget([vote], -1), 'waterfillBudget(B<0) 抛出');
  throws(
    () => waterfillBudget([{ ...vote, min: 4 }, { ...refine, min: 3 }], 5),
    'waterfillBudget(Σmin=6 > B=5) 抛出（预算撑不起最小可行配置）',
  );
  throws(() => waterfillBudget([vote, { ...vote, id: 'vote' }], 10), 'waterfillBudget(重复 id) 抛出');
}

// ═══════════════════ (d) 边际收益早停 ═══════════════════

section('52.0 (d) 早停规则：预算内不触发 / 超额触发 / 闭式阈值');

{
  const curve = { a: 0.9, b: 0.4, beta: 0.5 };
  const price = 0.004;
  // 闭式停机阈值：bβ·C*^{−(β+1)} = price ⟹ C* = (bβ/price)^{1/(β+1)} = 50^{2/3} ≈ 13.572
  const cStar = Math.pow((curve.b * curve.beta) / price, 1 / (curve.beta + 1));
  ok(near(cStar, Math.pow(50, 2 / 3), 1e-12), `闭式阈值 C* = (bβ/price)^{1/(β+1)} = ${cStar.toPrecision(10)} = 50^{2/3}`);

  // 锚点⑤：预算 B=10 < C* —— 预算内边际恒高于价格，早停不触发
  const inBudget = earlyStopRule(powerLawMarginal(curve, 2), price);
  const atBudget = earlyStopRule(powerLawMarginal(curve, 10), price);
  ok(
    !inBudget.stop && !atBudget.stop && inBudget.netValue > 0 && atBudget.netValue > 0,
    `预算内不触发：marg(2)=${powerLawMarginal(curve, 2).toPrecision(4)}, marg(10)=${powerLawMarginal(curve, 10).toPrecision(4)} > price=0.004（B=10 < C*=13.57，全程值得算）`,
  );
  // 超额触发：C=20 > C* —— 边际跌破价格，停
  const over = earlyStopRule(powerLawMarginal(curve, 20), price);
  ok(
    over.stop && over.netValue < 0 && powerLawMarginal(curve, 20) < price,
    `超额触发：marg(20)=${powerLawMarginal(curve, 20).toPrecision(4)} < 0.004（C=20 > C*=13.57，再算不值——停）`,
  );
  // 等号约定：增益恰等于价格 → 继续（无差异时不放弃改进）
  ok(earlyStopRule(price, price).stop === false && near(earlyStopRule(price, price).netValue, 0, 1e-15), 'marginalGain = price 时继续（等号不触发，净值为 0）');

  // 诚实拒绝：非法入参
  throws(() => earlyStopRule(0.1, -0.001), 'earlyStopRule(price<0) 抛出');
  throws(() => earlyStopRule(Number.NaN, 0.1), 'earlyStopRule(NaN) 抛出');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed === 0) {
  console.log('✅ 52.0 测试时计算内核 —— 投票 / 幂律水填充 / 早停数学验证成立');
} else {
  console.error('❌ 存在失败断言，见上方 ✗ 标记');
}
process.exitCode = failed === 0 ? 0 : 1;
