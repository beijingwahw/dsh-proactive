/**
 * verify-hawkes-process.mjs — 55.0 Hawkes 自激发内核纯数学离线验证
 *
 * 内核的数学核心全部有解析解或独立重算对照（不是「能跑」，是「算得对」）：
 *   ① thinning 仿真: (μ=0.5, α=0.4, β=1.0)（η=0.4）N=2167 ≥ 2000 事件，
 *        遍历率 N/T ↔ 平稳率闭式 μ/(1−η)=5/6；同种子逐位确定
 *   ② 强度/补偿器/残差三条路独立对照: O(N) 链式递推 vs O(N²) 暴力求和
 *        （diff ≤ 1e-12）；4 事件手算闭式逐位对上
 *   ③ EM 参数恢复: η̂=0.3967 与真值 0.4 差 0.0033（规格 ≤0.05~0.1）；
 *        ℓ(θ̂) ≥ ℓ(θ_true)（MLE 上升性）、trace 单调不减（EM 性质）、收敛
 *   ④ 时间重标残差（真参数 37475 事件）: mean=1.0004 / var=1.0055 /
 *        lag1=−0.0029 —— 模型正确 ⟹ Exp(1) i.i.d.；拟合参数下同样成立
 *   ⑤ 齐次退化: Poisson 数据（α=0 输入）→ α̂≈9e-6、μ̂↔Poisson MLE N/T、
 *        ℓ̂ ↔ N·log(N/T)−N 闭式
 *   ⑥ burstForecast: 单事件/大 Δ 闭式精确；期望随近邻事件数严格单调增
 *        （自激发直觉可计算化）
 *   ⑦ η≥1 参数全链路构造拒绝（simulate/logLik/compensator/burstForecast）
 *
 * 全部断言确定性（随机处经 simulate(seed) 内置 mulberry32）。
 * 运行：node --experimental-strip-types scripts/verify-hawkes-process.mjs
 */

import {
  simulate,
  intensity,
  logLik,
  fitHawkes,
  compensator,
  stationaryRate,
  residualDiagnostics,
  burstForecast,
} from '../src/core/hawkes-process.ts';

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
function throws(fn, label) {
  try {
    fn();
  } catch {
    ok(true, label);
    return;
  }
  ok(false, `${label}（未抛出）`);
}
function section(title) {
  console.log(`\n■ ${title}`);
}

// ═══════════════════ ① thinning 仿真基础 ═══════════════════

section('① thinning 仿真：遍历率与确定性');

const TRUE = { mu: 0.5, alpha: 0.4, beta: 1.0 }; // η = 0.4
const eventsA = simulate({ ...TRUE, T: 2600, seed: 42 });

ok(eventsA.length >= 2000, `N=${eventsA.length} ≥ 2000 事件（平稳率 μ/(1−η)=5/6 × T=2600 → 期望 2167）`);
ok(eventsA.every((t, i) => i === 0 || t > eventsA[i - 1]), '事件时间严格递增');
ok(eventsA[0] > 0 && eventsA[eventsA.length - 1] <= 2600, `事件全部落在 (0, T]=2600 内（首 ${eventsA[0].toFixed(3)}，末 ${eventsA[eventsA.length - 1].toFixed(3)}）`);
ok(
  near(eventsA.length / 2600, 5 / 6, 0.02),
  `遍历性：N/T=${(eventsA.length / 2600).toFixed(5)} ↔ stationaryRate 闭式 μ/(1−η)=${(5 / 6).toFixed(5)}（差 ≤0.02）`,
);
ok(near(stationaryRate(TRUE), 5 / 6, 1e-12), `stationaryRate(0.5,0.4,1.0)=${stationaryRate(TRUE)} = 5/6（解析）`);
ok(
  JSON.stringify(simulate({ ...TRUE, T: 2600, seed: 42 })) === JSON.stringify(eventsA),
  '同种子同序列（mulberry32 确定性，逐位一致）',
);
ok(
  JSON.stringify(simulate({ ...TRUE, T: 2600, seed: 43 })) !== JSON.stringify(eventsA),
  '异种子异序列（不是常数发生器）',
);
{
  const pois = simulate({ mu: 2, alpha: 0, beta: 1, T: 500, seed: 13 });
  ok(
    Math.abs(pois.length / 500 - 2) <= 0.15,
    `α=0 退化为 Poisson：N/T=${(pois.length / 500).toFixed(4)} ≈ μ=2（N=${pois.length}）`,
  );
}

// ═══════════════════ ② 强度/补偿器/残差 三条独立路径 ═══════════════════

section('② 强度与补偿器：O(N) 递推 vs O(N²) 暴力对照');

{
  const sub = eventsA.slice(0, 400);
  let maxDiffI = 0;
  let maxDiffC = 0;
  for (const t of [0.5, 13.7, sub[100], sub[100] + 0.3, sub[399] + 0.9]) {
    const bruteI = 0.5 + 0.4 * sub.filter((e) => e < t).reduce((s, e) => s + Math.exp(-(t - e)), 0);
    maxDiffI = Math.max(maxDiffI, Math.abs(intensity(TRUE, sub, t) - bruteI));
    const bruteC = 0.5 * t + 0.4 * sub.filter((e) => e <= t).reduce((s, e) => s + (1 - Math.exp(-(t - e))), 0);
    maxDiffC = Math.max(maxDiffC, Math.abs(compensator(TRUE, sub, t) - bruteC));
  }
  ok(maxDiffI <= 1e-12, `intensity 链式递推 = 暴力求和（最大差 ${maxDiffI.toExponential(2)} ≤ 1e-12）`);
  ok(maxDiffC <= 1e-10, `compensator 链式递推 = 暴力求和（最大差 ${maxDiffC.toExponential(2)} ≤ 1e-10）`);
  const diag = residualDiagnostics(TRUE, sub);
  let maxDiffR = 0;
  for (let k = 0; k < 50; k += 1) {
    const diff = compensator(TRUE, sub, sub[k + 1]) - compensator(TRUE, sub, sub[k]);
    maxDiffR = Math.max(maxDiffR, Math.abs(diff - diag.residuals[k]));
  }
  ok(
    maxDiffR <= 1e-9,
    `残差递推 R_k = Λ(t_{k+1})−Λ(t_k) 与补偿器差分一致（最大差 ${maxDiffR.toExponential(2)} ≤ 1e-9）`,
  );
  // 4 事件手算闭式：R_k = μΔ + (α/β)(1−e^{−βΔ})·U_k
  const tiny = [1, 2, 4, 8];
  const hand = [
    0.5 * 1 + 0.4 * (1 - Math.exp(-1)) * 1,
    0.5 * 2 + 0.4 * (1 - Math.exp(-2)) * (1 + Math.exp(-1)),
    0.5 * 4 + 0.4 * (1 - Math.exp(-4)) * (1 + Math.exp(-2) + Math.exp(-3)),
  ];
  const tinyDiag = residualDiagnostics({ mu: 0.5, alpha: 0.4, beta: 1 }, tiny);
  ok(
    tinyDiag.residuals.every((r, i) => near(r, hand[i], 1e-12)),
    `4 事件手算闭式逐位对上（R=[${tinyDiag.residuals.map((r) => r.toFixed(6)).join(', ')}]）`,
  );
}

// ═══════════════════ ③ logLik 解析锚点 ═══════════════════

section('③ logLik：Poisson 退化闭式');

{
  const pois = simulate({ mu: 2, alpha: 0, beta: 1, T: 500, seed: 13 });
  const N = pois.length;
  ok(
    near(logLik({ mu: 2, alpha: 0, beta: 1 }, pois, 500), N * Math.log(2) - 2 * 500, 1e-9),
    `α=0 时 ℓ = N·log μ − μT = ${N}·log2 − 1000 = ${(N * Math.log(2) - 1000).toFixed(4)}（精确）`,
  );
  ok(
    near(logLik({ mu: N / 500, alpha: 0, beta: 1 }, pois, 500), N * Math.log(N / 500) - N, 1e-9),
    `Poisson MLE ℓ* = N·log(N/T) − N = ${(N * Math.log(N / 500) - N).toFixed(4)}（精确闭式）`,
  );
}

// ═══════════════════ ④ EM 参数恢复 ═══════════════════

section('④ EM 参数恢复：η̂ ↔ 0.4（分支比对照）');

const fitA = fitHawkes(eventsA, { iters: 300, trace: true });
const llTrueA = logLik(TRUE, eventsA, 2600);
let minInc = Infinity;
for (let k = 1; k < fitA.logLikTrace.length; k += 1) minInc = Math.min(minInc, fitA.logLikTrace[k] - fitA.logLikTrace[k - 1]);

console.log(
  `  参数恢复对照: 真值 (μ=0.500, α=0.400, β=1.000, η=0.400) → EM (μ̂=${fitA.mu.toFixed(4)}, α̂=${fitA.alpha.toFixed(4)}, β̂=${fitA.beta.toFixed(4)}, η̂=${fitA.eta.toFixed(4)})，ℓ: ${llTrueA.toFixed(2)} → ${fitA.logLik.toFixed(2)}`,
);
ok(
  Math.abs(fitA.eta - 0.4) <= 0.08,
  `|η̂−η|=${Math.abs(fitA.eta - 0.4).toFixed(4)} ≤ 0.08（规格 0.05~0.1；分支比是自激发的可辨识量）`,
);
ok(fitA.mu >= 0.4 && fitA.mu <= 0.6, `μ̂=${fitA.mu.toFixed(4)} ∈ [0.4, 0.6]（真值 0.5）`);
ok(fitA.beta >= 0.7 && fitA.beta <= 1.5, `β̂=${fitA.beta.toFixed(4)} ∈ [0.7, 1.5]（真值 1.0）`);
ok(fitA.logLik >= llTrueA - 0.5, `ℓ(θ̂)=${fitA.logLik.toFixed(2)} ≥ ℓ(θ_true)−0.5=${(llTrueA - 0.5).toFixed(2)}（MLE 不劣于真值，实际 +${(fitA.logLik - llTrueA).toFixed(2)}）`);
ok(minInc >= -1e-9, `EM 每迭代 ℓ 单调不减（最小增量 ${minInc.toExponential(2)} ≥ −1e-9）`);
ok(fitA.converged && fitA.iterations < 300, `EM 收敛（${fitA.iterations} 次迭代 < 上限 300，参数步长 < 1e-10）`);
ok(fitA.eta < 1, `拟合保持平稳性 η̂=${fitA.eta.toFixed(4)} < 1（钳位生效）`);

// ═══════════════════ ⑤ 时间重标残差 ═══════════════════

section('⑤ 时间重标残差：R_k ~ Exp(1) 的均值/方差/自相关');

{
  const eventsB = simulate({ ...TRUE, T: 45000, seed: 11 });
  const diagB = residualDiagnostics(TRUE, eventsB);
  ok(eventsB.length >= 2000, `大样本 N=${eventsB.length}（T=45000 × 5/6）`);
  ok(
    Math.abs(diagB.mean - 1) <= 0.05,
    `真参数残差均值=${diagB.mean.toFixed(4)} ∈ 1±5%（模型正确 → Exp(1)）`,
  );
  ok(
    Math.abs(diagB.variance - 1) <= 0.05,
    `真参数残差方差=${diagB.variance.toFixed(4)} ∈ 1±5%（Poisson 假设会欠离散）`,
  );
  ok(
    Math.abs(diagB.lag1) < 0.05,
    `真参数滞后 1 自相关=${diagB.lag1.toFixed(4)}，|ρ|<0.05（残差无记忆 → 时间重标拉直了自激发）`,
  );
  const diagFit = residualDiagnostics({ mu: fitA.mu, alpha: fitA.alpha, beta: fitA.beta }, eventsA);
  ok(
    Math.abs(diagFit.mean - 1) <= 0.05 && Math.abs(diagFit.variance - 1) <= 0.1 && Math.abs(diagFit.lag1) < 0.1,
    `拟合参数残差（N=${diagFit.n}）：mean=${diagFit.mean.toFixed(4)}、var=${diagFit.variance.toFixed(4)}、lag1=${diagFit.lag1.toFixed(4)}（估计噪声内同样成立）`,
  );
}

// ═══════════════════ ⑥ 齐次退化 ═══════════════════

section('⑥ 齐次退化：α=0 输入 → Poisson MLE');

{
  const pois = simulate({ mu: 2, alpha: 0, beta: 1, T: 500, seed: 13 });
  const N = pois.length;
  const fitP = fitHawkes(pois, { iters: 800 });
  const poisMle = N * Math.log(N / 500) - N;
  console.log(
    `  参数恢复对照: Poisson 数据 N=${N} → EM (μ̂=${fitP.mu.toFixed(6)}, α̂=${fitP.alpha.toExponential(3)}, η̂=${fitP.eta.toExponential(3)})`,
  );
  ok(fitP.alpha <= 0.005, `α̂=${fitP.alpha.toExponential(3)} ≈ 0（数据无传染 → 激发增益自我归零）`);
  ok(fitP.eta <= 0.001, `η̂=${fitP.eta.toExponential(3)} ≈ 0（分支比退化）`);
  ok(
    Math.abs(fitP.mu - N / 500) <= 0.005,
    `μ̂=${fitP.mu.toFixed(6)} ↔ Poisson MLE N/T=${(N / 500).toFixed(6)}（差 ${Math.abs(fitP.mu - N / 500).toExponential(2)} ≤ 0.005）`,
  );
  ok(
    Math.abs(fitP.mu * 500 - N) <= 1,
    `μ̂·T 与事件数闭合：|μ̂T−N|=${Math.abs(fitP.mu * 500 - N).toFixed(3)} ≤ 1（期望移民数 = 全部事件）`,
  );
  ok(
    Math.abs(fitP.logLik - poisMle) <= 1,
    `ℓ(θ̂)=${fitP.logLik.toFixed(4)} ↔ Poisson MLE 闭式 ${poisMle.toFixed(4)}（差 ≤1 nat）`,
  );
}

// ═══════════════════ ⑦ burstForecast ═══════════════════

section('⑦ burstForecast：闭式精确与自激发单调性');

{
  const single = burstForecast({ mu: 0.5, alpha: 0.4, beta: 1 }, [10], 2, { now: 10 });
  ok(
    near(single.expected, 0.5 * 2 + 0.4 * (1 - Math.exp(-2)), 1e-12),
    `单事件闭式 E=μΔ+(α/β)(1−e^{−βΔ})=${single.expected.toFixed(10)}（精确）`,
  );
  const far = burstForecast({ mu: 0.5, alpha: 0.4, beta: 1 }, [10], 200, { now: 10 });
  ok(
    near(far.expected, 0.5 * 200 + 0.4, 1e-9),
    `大 Δ 极限 E→μΔ+α/β=${far.expected.toFixed(6)}（激发总量 = 每事件后代期望 α/β=0.4）`,
  );
  let chainOk = true;
  let prev = -1;
  const readings = [];
  for (let k = 0; k <= 5; k += 1) {
    const events = [100, 105, 110];
    for (let j = 1; j <= k; j += 1) events.push(110 + j * 0.05);
    events.sort((a, b) => a - b);
    const r = burstForecast({ mu: 0.5, alpha: 0.4, beta: 1 }, events, 5, { now: 112 });
    if (!(r.expected > prev) || Math.abs(r.baseline - 2.5) > 1e-12) chainOk = false;
    readings.push(r.expected.toFixed(4));
    prev = r.expected;
  }
  ok(
    chainOk,
    `近邻事件数 0→5 期望严格单调增：[${readings.join(' → ')}]（基底 μΔ 恒 2.5，增量全来自激发）`,
  );
  const d1 = burstForecast({ mu: 0.5, alpha: 0.4, beta: 1 }, [100, 105, 110], 1, { now: 112 });
  const d5 = burstForecast({ mu: 0.5, alpha: 0.4, beta: 1 }, [100, 105, 110], 5, { now: 112 });
  const d25 = burstForecast({ mu: 0.5, alpha: 0.4, beta: 1 }, [100, 105, 110], 25, { now: 112 });
  ok(
    d1.expected < d5.expected && d5.expected < d25.expected,
    `窗口单调: Δ=1→${d1.expected.toFixed(3)} < 5→${d5.expected.toFixed(3)} < 25→${d25.expected.toFixed(3)}`,
  );
  ok(
    d5.rateAtNow > 0.5,
    `rateAtNow=λ(now⁺)=${d5.rateAtNow.toFixed(4)} > μ=0.5（历史事件的激发余温——Sentinel 风暴读数）`,
  );
}

// ═══════════════════ ⑧ 构造校验拒绝 ═══════════════════

section('⑧ 构造校验：η≥1 与非法输入显式拒绝');

throws(() => simulate({ mu: 0.5, alpha: 1, beta: 1, T: 10, seed: 1 }), 'simulate η=1（临界爆炸）被拒绝');
throws(() => simulate({ mu: 0.5, alpha: 2, beta: 1, T: 10, seed: 1 }), 'simulate η=2（超临界）被拒绝');
throws(() => logLik({ mu: 1, alpha: 5, beta: 1 }, [1, 2]), 'logLik η=5 被拒绝');
throws(() => compensator({ mu: 1, alpha: 1, beta: 1 }, [1], 2), 'compensator η=1 被拒绝');
throws(() => residualDiagnostics({ mu: 1, alpha: 3, beta: 1 }, [1, 2, 3, 4]), 'residualDiagnostics η=3 被拒绝');
throws(() => burstForecast({ mu: 1, alpha: 2, beta: 1 }, [1], 1), 'burstForecast η=2 被拒绝');
throws(() => simulate({ mu: 0, alpha: 0.5, beta: 1, T: 10, seed: 1 }), 'simulate μ=0（过程无法启动）被拒绝');
throws(() => simulate({ mu: 0.5, alpha: 0.4, beta: 1, T: 0, seed: 1 }), 'simulate T=0 被拒绝');
throws(() => fitHawkes([1, 2, 3]), 'fitHawkes 事件数 < 8 被拒绝');
throws(() => fitHawkes([3, 2, 1, 4, 5, 6, 7, 8]), 'fitHawkes 事件时间乱序被拒绝');
throws(() => fitHawkes([1, 2, 3, 4, 5, 6, 7, 20], { T: 10 }), 'fitHawkes T < 最后事件被拒绝');
throws(() => fitHawkes([1, 2, 3, 4, 5, 6, 7, 8], { iters: 0 }), 'fitHawkes iters=0 被拒绝');
throws(() => residualDiagnostics(TRUE, [1, 2, 3]), 'residualDiagnostics 事件数 < 4 被拒绝');
throws(() => burstForecast(TRUE, [1], 0), 'burstForecast Δ=0 被拒绝');
throws(() => burstForecast(TRUE, [1, 5], 1, { now: 3 }), 'burstForecast now 早于最后事件被拒绝');

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
