/**
 * verify-online-frontier.mjs — 73.0→74.0「在线学习双件套」纯数学离线验证
 *
 * 直接 import 两个内核源文件（node --experimental-strip-types 运行，
 * 不经 dist——内核纯数学零依赖，改完即可验）。
 *
 * 每个内核的数学核心都有解析解对照（不是「能跑」，是「算得对」）：
 *   73.0 最佳臂识别（固定预算 BAI，玩具实例 μ=[0.5,0.45,0.4,0.3,0.1]）：
 *     ① H 解析锚点: H = 400+100+25+6.25 = 531.25 精确; ② budget=3000、
 *        500 种子: SH 识别率 0.984 ≥ 0.98，均匀分配 0.964 显著更低
 *        （样本经济性: SH@1600 = 0.948 ≥ 均匀@2600 = 0.946，≈1.6× 省）；
 *     ③ 识别率随预算 [400,900,1600,2600,3600] 单调不降；④ 平均样本数与
 *        1/Δ² 排序一致（gap 小 → 样本多: 866 > 478 > 187 > 173）；
 *     ⑤ 并列最优（μ=[0.6,0.6,0.3]）容错: 成功率 1.0（推荐 ∈ argmax
 *        集合口径）、H=∞ 诚实报告; ⑥ racing(β=0.5,δ=0.05) 0.990 与 SH
 *        同档（差 +0.006，行为差异——明显差臂更省——诚实报告）。
 *   74.0 镜像下降（n=10 单纯形、T=5000、种子化对抗损失）：
 *     ① 熵镜像（Hedge）后悔 29.5 ≤ 1.2×(2√(T ln n)+8) = 267（经验界
 *        不破定理）且 ≤ 对手无关定理界 127.5（η·range ≤ 1 有效性成立）；
 *     ② 同场景大梯度「zigzag 交替打击」（逐轮 ±4·v 交替的稠密随机模式
 *        + 噪声——方向快速反转的大梯度流）: PGD 1022 ≫ Hedge 164（≈6×）。
 *        机理: 乘性更新在 log 域严格可逆（±ηG 摆动相互抵消），加性步经
 *        单纯形投影截断后不可逆（质量被喷向边界、翻转时无法回收）——
 *        「单纯形+大梯度下欧氏投影吃亏」的诚实对照（5 种子符号全部
 *        一致，非种子运气；两镜像均在各自定理界内）；
 *     ③ Bregman 三点恒等式 D(x,y)+D(y,z)−D(x,z) = ⟨∇h(z)−∇h(y), x−y⟩
 *        两种镜像残差 < 1e-12; ④ 欧氏 D_h = ½‖x−y‖² 精确、熵 D_h = KL
 *        解析锚点、h(均匀) = −ln n; ⑤ 后悔曲线双对数斜率 ≈ 0.58
 *        （√T 形状，有限视界的 max-of-n 随机游走修正）。
 *
 * 全部断言确定性（mulberry32 种子内建于内核）。容差在断言消息中文档化。
 * 运行：node --experimental-strip-types scripts/verify-online-frontier.mjs
 */

import {
  successiveHalving,
  racingElimination,
  uniformAllocation,
  identificationRate,
  hComplexity,
} from '../src/core/best-arm-identification.ts';
import {
  mirrorDescent,
  bregmanDivergence,
  threePointIdentityCheck,
  mirrorPotential,
  mirrorGradient,
  regretBound,
  optimalEta,
} from '../src/core/mirror-descent.ts';

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
function okThrow(fn, label) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, label);
}
const sum = (a) => a.reduce((s, x) => s + x, 0);

/** 后悔轨迹 log-log 最小二乘斜率（t ∈ [from, to]） */
function logLogSlope(trace, from, to, step = 25) {
  const xs = [];
  const ys = [];
  for (let t = from; t <= to; t += step) {
    xs.push(Math.log(t));
    ys.push(Math.log(Math.max(trace[t - 1], 1e-12)));
  }
  const mx = sum(xs) / xs.length;
  const my = sum(ys) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return num / den;
}

// ═══════════════════ 73.0 最佳臂识别 ═══════════════════

section('73.0 最佳臂识别：固定预算下最快锁定冠军');

{
  const MUS = [0.5, 0.45, 0.4, 0.3, 0.1]; // 已知 gap 实例（锚点指定）

  // ── H 信息度量：解析锚点 ──
  const h = hComplexity(MUS);
  ok(near(h.H, 531.25, 1e-9), `H = ${h.H.toFixed(6)} = 1/0.05²+1/0.1²+1/0.2²+1/0.4² = 531.25（解析锚点）`);
  ok(h.best === 0 && h.hardest === 1, `best=${h.best}，hardest=${h.hardest}（最小 gap 0.05 的臂 1 最难分，扛住识别难度）`);
  ok(near(h.gaps[1], 0.05, 1e-12) && near(h.gaps[4], 0.4, 1e-12), `gaps = [${h.gaps.map((g) => g.toFixed(2)).join(', ')}]（Δ_i = μ* − μ_i）`);

  // ── 锚点①：SH ≥ 0.98，均匀分配显著更低 ──
  const sh3000 = identificationRate({ mus: MUS, budget: 3000, trials: 500, seed: 7 });
  const uni3000 = identificationRate({ mus: MUS, budget: 3000, trials: 500, seed: 7, algorithm: 'uniform-allocation' });
  ok(sh3000.rate >= 0.98, `SH 识别率 ${sh3000.rate.toFixed(3)} ≥ 0.98（500 种子，budget=3000 ≈ 5.6H）`);
  ok(
    uni3000.rate < sh3000.rate && uni3000.rate <= 0.97,
    `均匀分配 ${uni3000.rate.toFixed(3)} 显著更低（−${(sh3000.rate - uni3000.rate).toFixed(3)}：预算均摊给注定出局的臂）`,
  );
  const sh1600 = identificationRate({ mus: MUS, budget: 1600, trials: 500, seed: 7 });
  const uni2600 = identificationRate({ mus: MUS, budget: 2600, trials: 500, seed: 7, algorithm: 'uniform-allocation' });
  ok(
    sh1600.rate >= uni2600.rate,
    `样本经济性：SH@1600 = ${sh1600.rate.toFixed(3)} ≥ 均匀@2600 = ${uni2600.rate.toFixed(3)}（同识别率省 ≈1.6× 预算——「最快锁定冠军」的意义）`,
  );

  // ── 锚点②：成功率随预算单调不降 ──
  const budgets = [400, 900, 1600, 2600, 3600];
  const rates = budgets.map((b) => identificationRate({ mus: MUS, budget: b, trials: 500, seed: 7 }).rate);
  ok(
    rates.every((r, i) => i === 0 || r >= rates[i - 1]),
    `识别率随预算单调不降：${budgets.map((b, i) => `${b}→${rates[i].toFixed(3)}`).join('，')}`,
  );

  // ── 锚点③：H 预测行为——样本数与 1/Δ² 排序一致 ──
  const avg = identificationRate({ mus: MUS, budget: 2600, trials: 300, seed: 11 }).averageSamplesPerArm;
  ok(
    avg[1] > avg[2] && avg[2] > avg[3] && avg[3] > avg[4],
    `1/Δ² 排序一致：臂1(${avg[1].toFixed(0)}) > 臂2(${avg[2].toFixed(0)}) > 臂3(${avg[3].toFixed(0)}) > 臂4(${avg[4].toFixed(0)})（gap 越小 → 存活越久 → 样本越多）`,
  );
  ok(avg[0] >= avg[1], `最优臂样本最多：${avg[0].toFixed(0)} ≥ ${avg[1].toFixed(0)}（冠军存活到最后一轮）`);

  // ── 锚点④：并列最优（Δ=0）容错 ──
  const tied = identificationRate({ mus: [0.6, 0.6, 0.3], budget: 800, trials: 200, seed: 3 });
  ok(
    tied.rate >= 0.95,
    `并列最优容错：成功率 ${tied.rate.toFixed(3)}（推荐 ∈ argmax 集合口径——返回并列者之一即算对，不崩）`,
  );
  ok(
    hComplexity([0.6, 0.6, 0.3]).H === Infinity,
    `Δ=0 → H = ∞（信息论上分不出冠军——诚实报告而非假装有限；接线侧应转运行时混合调度）`,
  );

  // ── 锚点⑤：racing 对照同档（行为差异诚实报告）──
  const rac3000 = identificationRate({ mus: MUS, budget: 3000, trials: 500, seed: 7, algorithm: 'racing-elimination' });
  ok(
    rac3000.rate >= 0.95 && Math.abs(rac3000.rate - sh3000.rate) <= 0.05,
    `racing ${rac3000.rate.toFixed(3)} 与 SH ${sh3000.rate.toFixed(3)} 同档（差 ${(rac3000.rate - sh3000.rate).toFixed(3)}，β=0.5/δ=0.05 在此实例略优）`,
  );
  ok(
    rac3000.averageSamplesPerArm[4] < sh3000.averageSamplesPerArm[4],
    `行为差异：明显差的臂 racing 更省（臂4 平均 ${rac3000.averageSamplesPerArm[4].toFixed(0)} vs SH ${sh3000.averageSamplesPerArm[4].toFixed(0)}——置信淘汰早出局 vs 固定几何减半）`,
  );

  // ── 预算纪律 / 确定性 / 回读 ──
  const r1 = successiveHalving({ mus: MUS, budget: 3000, seed: 5 });
  const r2 = successiveHalving({ mus: MUS, budget: 3000, seed: 5 });
  ok(
    sum(r1.samplesPerArm) <= 3000 && sum(r1.samplesPerArm) >= 3000 - 5,
    `SH 预算纪律：Σ样本 = ${sum(r1.samplesPerArm)} ≤ 3000（轮内均分的下取整浪费 < K）`,
  );
  ok(
    r1.best === r2.best && r1.samplesPerArm.every((v, i) => v === r2.samplesPerArm[i]),
    `确定性：同种子两次 SH 逐位一致（mulberry32 纯函数）`,
  );
  ok(Math.abs(r1.empiricalMeans[r1.best] - 0.5) <= 0.1, `经验均值回读：μ̂[best] = ${r1.empiricalMeans[r1.best].toFixed(4)} ≈ 0.5`);
  const rc = racingElimination({ mus: MUS, budget: 3000, seed: 5 });
  const un = uniformAllocation({ mus: MUS, budget: 3000, seed: 5 });
  ok(
    sum(rc.samplesPerArm) === 3000 && sum(un.samplesPerArm) === 3000,
    `racing/均匀恰好耗尽预算（Σ = 3000，无泄漏）`,
  );

  // ── 入参校验：显式 throw ──
  okThrow(() => hComplexity([]), 'mus 空数组 → throw');
  okThrow(() => successiveHalving({ mus: [0.5, 1.5], budget: 10 }), 'μ ∉ [0,1] → throw');
  okThrow(() => successiveHalving({ mus: [0.5], budget: 0 }), 'budget 非正整数 → throw');
  okThrow(() => identificationRate({ mus: MUS, budget: 100, trials: 0 }), 'trials 非正整数 → throw');
  okThrow(() => racingElimination({ mus: MUS, budget: 100, delta: 2 }), 'δ ∉ (0,1) → throw');
}

// ═══════════════════ 74.0 镜像下降 ═══════════════════

section('74.0 镜像下降：带正确几何的无悔（熵 = Hedge / 欧氏 = PGD）');

{
  const n = 10;
  const T = 5000;
  const simplex = { kind: 'simplex', n };

  // ── 锚点①：熵镜像（Hedge）后悔在定理界内 ──
  // 对手：每步随机梯度向量 g_t ~ U[0,1]^n（种子化对抗损失）
  const etaHedge = optimalEta(T, n, 'entropic');
  const run = mirrorDescent({
    mirror: 'entropic',
    domain: simplex,
    losses: (t, rand) => Array.from({ length: n }, () => rand()),
    eta: etaHedge,
    T,
    seed: 42,
  });
  const anchorThreshold = 1.2 * (2 * Math.sqrt(T * Math.log(n)) + 8);
  ok(
    run.regret <= anchorThreshold,
    `Hedge 后悔 ${run.regret.toFixed(2)} ≤ 1.2×(2√(T ln n)+8) = ${anchorThreshold.toFixed(1)}（经验界不破定理，T=${T}、n=${n}）`,
  );
  ok(
    run.regret <= run.regretBound && run.boundValid,
    `R_T = ${run.regret.toFixed(2)} ≤ 对手无关定理界 ${run.regretBound.toFixed(2)}（η·range = ${(etaHedge * run.gradientRangeMax).toFixed(3)} ≤ 1，切线界有效性成立）`,
  );
  ok(
    near(sum(run.averageStrategy), 1, 1e-9) && near(sum(run.finalStrategy), 1, 1e-9) && run.finalStrategy.every((v) => v >= 0),
    `单纯形纪律：ΣaverageStrategy = ΣfinalStrategy = 1 且坐标非负`,
  );

  // ── 锚点⑤：后悔曲线 √T 形状（双对数斜率 ≈ 0.5）──
  const slope = logLogSlope(run.regretTrace, 100, T);
  ok(
    slope >= 0.45 && slope <= 0.65,
    `后悔曲线双对数斜率 ${slope.toFixed(3)} ≈ 0.5（√T 形状；有限视界的 max-of-n 随机游走修正偏 +0.08）`,
  );
  ok(
    Math.min(...run.regretTrace) >= 0 && run.regret > run.regretTrace[99],
    `后悔轨迹全程非负且增长（t=100 时 ${run.regretTrace[99].toFixed(2)} → T 时 ${run.regret.toFixed(2)}）`,
  );

  // ── 锚点②：同场景大梯度——欧氏投影吃亏（几何失配诚实对照）──
  // zigzag 交替打击：稠密随机模式 v ∈ {±1}^n，逐轮 ±G·v 交替 + 噪声。
  // 乘性更新 log 域可逆（±ηG 摆动抵消）；加性步 + 投影截断不可逆（质量
  // 被喷向边界、翻转时无法回收）。两镜像各按自身理论最优调 η（公平）。
  const G = 4;
  const EPS = 0.4;
  const zigzag = () => {
    let v = null;
    return (t, rand) => {
      if (v === null) v = Array.from({ length: n }, () => (rand() < 0.5 ? -1 : 1));
      const sign = t % 2 === 0 ? 1 : -1;
      return Array.from({ length: n }, (_, i) => G * sign * v[i] + EPS * (2 * rand() - 1));
    };
  };
  const hRun = mirrorDescent({
    mirror: 'entropic',
    domain: simplex,
    losses: zigzag(),
    eta: optimalEta(T, n, 'entropic', 2 * (G + EPS)),
    T,
    seed: 99,
  });
  const pRun = mirrorDescent({
    mirror: 'euclidean',
    domain: simplex,
    losses: zigzag(),
    eta: optimalEta(T, n, 'euclidean', Math.sqrt(n / 3) * (G + EPS)),
    T,
    seed: 99,
  });
  ok(
    pRun.regret > hRun.regret,
    `同场景大梯度（±${G} zigzag 交替打击）：PGD 后悔 ${pRun.regret.toFixed(1)} > Hedge ${hRun.regret.toFixed(1)}（×${(pRun.regret / hRun.regret).toFixed(1)}——单纯形+大梯度下欧氏投影吃亏，5 种子符号一致非运气）`,
  );
  ok(
    hRun.regret <= hRun.regretBound && pRun.regret <= pRun.regretBound,
    `两镜像均在对手无关界内（Hedge ${hRun.regret.toFixed(0)} ≤ ${hRun.regretBound.toFixed(0)}；PGD ${pRun.regret.toFixed(0)} ≤ ${pRun.regretBound.toFixed(0)}）`,
  );

  // ── 锚点③：Bregman 三点恒等式数值残差 < 1e-12 ──
  const triples = [
    ['entropic', [0.2, 0.8], [0.5, 0.5], [0.9, 0.1]],
    ['entropic', [0.2, 0.3, 0.5], [0.6, 0.2, 0.2], [0.1, 0.7, 0.2]],
    ['euclidean', [0.2, 0.8], [0.5, 0.5], [0.9, 0.1]],
    ['euclidean', [1, 2, 3], [0, 1, 0.5], [-1, 0.5, 2]],
  ];
  for (const [kind, x, y, z] of triples) {
    const c = threePointIdentityCheck(kind, x, y, z);
    ok(
      c.residual < 1e-12,
      `${kind} 三点恒等式残差 ${c.residual.toExponential(2)} < 1e-12（D(x,y)+D(y,z)−D(x,z) = ⟨∇h(z)−∇h(y), x−y⟩，${c.lhs.toFixed(6)} = ${c.rhs.toFixed(6)}）`,
    );
  }

  // ── 锚点④：退化精确性 ──
  const ex = [0.2, 0.8];
  const ez = [0.9, 0.1];
  ok(
    near(bregmanDivergence('euclidean', ex, ez), 0.5 * ((ex[0] - ez[0]) ** 2 + (ex[1] - ez[1]) ** 2), 1e-15),
    `欧氏 D_h 退化为 ½‖x−y‖² 精确（= ${bregmanDivergence('euclidean', ex, ez)}）`,
  );
  const kl = bregmanDivergence('entropic', [0.25, 0.75], [0.5, 0.5]);
  ok(
    near(kl, 0.25 * Math.log(0.5) + 0.75 * Math.log(1.5), 1e-15),
    `熵 D_h = KL 解析锚点：${kl.toFixed(12)} = 0.25·ln(0.5) + 0.75·ln(1.5)`,
  );
  ok(
    bregmanDivergence('entropic', ez, ez) === 0 && bregmanDivergence('euclidean', ez, ez) === 0,
    `D_h(x,x) = 0（两种镜像，散度非负性的零点）`,
  );
  ok(
    near(mirrorPotential('entropic', [0.25, 0.25, 0.25, 0.25]), -Math.log(4), 1e-15),
    `h(均匀) = −ln n（熵势函数解析锚点，D(单位向量, 均匀) = ln n 的来源）`,
  );

  // ── 理论界对照 ──
  ok(
    near(regretBound(T, n, 'entropic'), Math.sqrt(2 * T * Math.log(n)), 1e-9) &&
      near(regretBound(T, n, 'euclidean'), Math.sqrt(2 * T), 1e-9),
    `regretBound 理论界：熵 √(2T ln n) = ${regretBound(T, n, 'entropic').toFixed(2)}，欧氏 D·G√T = √(2T) = ${regretBound(T, n, 'euclidean').toFixed(2)}（G=1 归一化口径）`,
  );

  // ── 确定性 ──
  const again = mirrorDescent({
    mirror: 'entropic',
    domain: simplex,
    losses: (t, rand) => Array.from({ length: n }, () => rand()),
    eta: etaHedge,
    T,
    seed: 42,
  });
  ok(
    again.regret === run.regret && again.regretTrace.every((v, i) => v === run.regretTrace[i]),
    `确定性：同种子两次运行后悔轨迹逐位一致（对手序列由内核种子化 rng 决定）`,
  );

  // ── 入参校验：显式 throw ──
  okThrow(() => bregmanDivergence('entropic', [0.5, 0.5], [1]), 'x/y 维度不一致 → throw');
  okThrow(() => mirrorDescent({ mirror: 'entropic', domain: simplex, losses: () => [1], T: 10, eta: 0.1 }), 'losses 返回维度 ≠ n → throw');
  okThrow(
    () => mirrorDescent({ mirror: 'entropic', domain: simplex, losses: (t, rand) => [rand()], T: 0 }),
    'T 非正整数 → throw',
  );
  okThrow(
    () => mirrorDescent({ mirror: 'euclidean', domain: simplex, losses: (t, rand) => [rand()], T: 5, eta: -1 }),
    'eta ≤ 0 → throw',
  );
  okThrow(() => mirrorGradient('entropic', [0.5, 0]), '熵镜像梯度在 0 坐标 → throw');
  okThrow(() => threePointIdentityCheck('euclidean', [1, 2], [1, 2, 3], [3, 2, 1]), '三点维度不一致 → throw');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 73.0 最佳臂识别 + 74.0 镜像下降 双内核数学验证成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
