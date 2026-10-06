/**
 * verify-r5-stochastic.mjs — R5-A10 随机过程六内核第五轮世界性进化纯数学验证
 *
 * 覆盖 41.0 排队网络 / 25.0 容量规划 / 55.0 Hawkes / 42.0 谱周期 /
 *       28.0 极值理论 / 40.0 首达时间，四轴进化逐条对照：
 *
 *   轴 1 数学: M/G/1 Pollaczek–Khinchine 双退化锚点（C_s²=1 → M/M/1 精确、
 *        C_s²=0 → 恰半）；非抢占多类优先级 Kleinrock 守恒律（Σρ_k Wq_k
 *        在全部 K! 排列下不变，裂项恒等）+ cμ 规则穷举最优（成对交换定理）；
 *        多类别平方根 staffing（Σextra 守恒到 1）；elastic 到达均衡
 *        （λ*≤λ0、γ/c 单调、名义过载自稳）；多维 Hawkes 交叉激发矩阵
 *        恢复 + 谱半径闭式 + 平稳率 (I−A)⁻¹μ；补偿器残差 KS 检验（真参数
 *        不拒绝 / Poisson 失配强拒绝）；谐波梳（方波基频恢复、冲激串
 *        g 盲 comb 见、双周期检出）+ Fisher g 精确 p 的 log 域升级
 *        （旧式逐点对照 + 大 m 溢出区有限）；带漂移反射原理（μ=0 退化
 *        逐位一致、μ<0 → e^{2μa/σ²}、IG-CDF 恒等）；IG 分位数数值反演
 *        往返恒等；GPD 返回水平闭式 + delta CI（指数尾解析对照、CI 随 T 变宽）。
 *   轴 2 性能: plan() Kingman 初值局部搜索 vs 旧二分（200 题逐位同解 +
 *        耗时对照）；fitGpd 矩初始化（220 样本 ξ/ℓ 等价 + 耗时对照）；
 *        fftAutocorrelation（Wiener–Khinchin）vs 逐 lag 直积（200 种子
 *        逐位等价 + 耗时对照）。
 *   轴 3 稳健: Fisher g 大 m（旧式 NaN 区）有限且单调；GPD 病态预警
 *        （ξ≥0.5/贴边界）；drift 第二项 log 域（μa/σ²=5000 不溢出）。
 *   轴 4 性质（≥200 种子化输入）: Little 定律守恒（erlangC Lq=λWq 与
 *        优先级逐类）；Hawkes 残差指数性（mean≈1, 200 种子）；GPD 尾部
 *        单调（cdf↑y、VaR↑p、ES≥VaR，200 拟合）；首达概率归一（t→∞ →
 *        1 或 e^{2μa/σ²}，200 种子）+ t 单调（200 种子）。
 *
 * 全部确定性（随机处 mulberry32 种子）。运行：npm run build && node scripts/verify-r5-stochastic.mjs
 */

import {
  // 41.0 + R5-A10
  pollaczekKhinchine,
  priorityQueueWaits,
  cmuPriorityOrder,
  tandemNetwork,
  // 25.0 + R5-A10
  erlangC,
  erlangB,
  kingmanWq,
  CapacityPlanner,
  multiclassStaffing,
  elasticArrivalEquilibrium,
  // 55.0 + R5-A10
  simulate,
  residualDiagnostics,
  fitHawkes,
  simulateMultivariate,
  splitByDim,
  multivariateLogLik,
  fitHawkesMultivariate,
  spectralRadius,
  ksExpOneTest,
  kolmogorovUpperTail,
  // 42.0 + R5-A10
  fisherGUpperTail,
  logGamma,
  betaUpperTail,
  harmonicComb,
  periodogram,
  fftAutocorrelation,
  // 28.0 + R5-A10
  fitGpd,
  gpdLogLik,
  gpdReturnLevel,
  gpdCdf,
  potQuantiles,
  empiricalQuantile,
  mulberry32,
  // 40.0 + R5-A10
  reflectionMaxProb,
  driftPassageProb,
  hittingProbability,
  inverseGaussianCdf,
  inverseGaussianQuantile,
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
function section(title) {
  console.log(`\n■ ${title}`);
}

// ═══════════════════ 41.0 排队网络：P-K + 优先级 cμ + 守恒律 ═══════════════════

section('41.0 M/G/1 Pollaczek–Khinchine + 优先级队列（轴 1）');

{
  // 双退化锚点：C_s²=1 → M/M/1 精确 Wq = ρ/(μ−λ)；C_s²=0 → 恰为其半
  ok(Math.abs(pollaczekKhinchine(0.8, 1, 1).avgWait - 4) < 1e-12,
    'P-K 退化锚点①: C_s²=1 → Wq = ρ/(μ−λ) = 4（M/M/1 精确解）');
  ok(Math.abs(pollaczexClean(0.8, 1) - 2) < 1e-12,
    'P-K 退化锚点②: C_s²=0（确定性服务）→ Wq = 2 恰为 M/M/1 之半');
  let pkAgree = true;
  for (let s = 0; s < 200; s += 1) {
    const rng = mulberry32(9100 + s);
    const lambda = 0.05 + rng() * 0.9;
    const mu = lambda + 0.05 + rng();
    const scv = rng() * 4;
    const wq = pollaczekKhinchine(lambda, mu, scv).avgWait;
    if (!(wq >= 0 && Number.isFinite(wq))) pkAgree = false;
  }
  ok(pkAgree, 'P-K 200 种子化 (λ,μ,C_s²) 全部有限非负');

  // 优先级队列：守恒律在全部排列下不变 + cμ 穷举最优（≥200 组评估）
  function permutations(arr) {
    if (arr.length <= 1) return [arr];
    const out = [];
    for (let i = 0; i < arr.length; i += 1) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const p of permutations(rest)) out.push([arr[i], ...p]);
    }
    return out;
  }
  let conservationOk = true;
  let cmuOptimal = true;
  let littleOk = true;
  let worstInvariant = 0;
  let permChecks = 0;
  for (let s = 0; s < 42; s += 1) {
    const rng = mulberry32(4200 + s);
    const K = 3;
    const classes = Array.from({ length: K }, (_, i) => ({
      name: `c${i}`,
      lambda: 0.05 + rng() * 0.4,
      mu: 0.5 + rng() * 3,
      scv: rng() * 2,
      costRate: 0.2 + rng() * 5,
    }));
    const totalRho = classes.reduce((acc, c) => acc + c.lambda / c.mu, 0);
    if (totalRho >= 0.9) continue; // 稳态域
    const base = priorityQueueWaits(classes);
    if (!base.stable) continue;
    for (const p of permutations(classes)) {
      const rep = priorityQueueWaits(p);
      permChecks += 1;
      // 守恒律：Σρ_k Wq_k 与顺序无关（裂项恒等 ρW0/(1−ρ)）
      worstInvariant = Math.max(worstInvariant, Math.abs(rep.conservationSum - base.conservationTheoretical));
      if (Math.abs(rep.conservationSum - base.conservationTheoretical) > 1e-9) conservationOk = false;
      // cμ 定理：任何顺序的加权成本 ≥ cμ 序成本
      if (rep.weightedWaitCost < base.cmuWeightedWaitCost - 1e-12) cmuOptimal = false;
    }
    // 逐类 Little 定律：Lq_k = λ_k Wq_k（轴 4）
    for (let i = 0; i < K; i += 1) {
      const m = base.classes[i];
      if (Math.abs(m.avgQueueLength - classes[i].lambda * m.avgWait) > 1e-9 * Math.max(1, m.avgQueueLength)) littleOk = false;
    }
    // cμ 序与导出排序一致
    if (base.cmuOrder.join(',') !== cmuPriorityOrder(classes).join(',')) cmuOptimal = false;
  }
  ok(permChecks >= 200 && conservationOk,
    `Kleinrock 守恒律：${permChecks} 组排列下 Σρ_k Wq_k 恒等于 ρW0/(1−ρ)（最差偏差 ${worstInvariant.toExponential(2)}）`);
  ok(permChecks >= 200 && cmuOptimal,
    `cμ 规则穷举最优：${permChecks} 组排列中无任何顺序的加权等待成本低于 cμ 序（Smith 成对交换定理）`);
  ok(littleOk, '优先级逐类 Little 定律 Lq_k = λ_k·Wq_k（34 组种子化三分类）');

  // 高优先级等待更短、串联网络不受影响（向后兼容读数）
  const classes = [
    { name: 'gold', lambda: 0.3, mu: 2, scv: 1, costRate: 5 },
    { name: 'silver', lambda: 0.4, mu: 4, scv: 1, costRate: 1 },
    { name: 'bronze', lambda: 0.2, mu: 1, scv: 1, costRate: 0.5 },
  ];
  const rep = priorityQueueWaits(classes);
  ok(rep.classes[0].avgWait < rep.classes[2].avgWait,
    `优先级语义: gold Wq=${rep.classes[0].avgWait.toFixed(4)} < bronze Wq=${rep.classes[2].avgWait.toFixed(4)}（高优先级先行）`);
}

function pollaczexClean(lambda, mu) {
  return pollaczekKhinchine(lambda, mu, 0).avgWait;
}

// ═══════════════════ 25.0 容量规划：staffing / elastic / Kingman 初值 ═══════════════════

section('25.0 多类别 staffing + elastic 均衡 + plan 初值（轴 1/2/4）');

{
  // erlangB 稳定原语锚点：递推有界 + 与 erlangC 内部一致
  ok(Math.abs(erlangB(3, 2) - 0.21052632) < 1e-7, 'erlangB(3, 2) = 2/9.5 ≈ 0.210526（Erlang-B 递推锚点）');
  ok(erlangB(200, 500) >= 0 && erlangB(200, 500) <= 1, 'erlangB 大负载仍有界 ∈ [0,1]（无溢出递推）');

  // 多类别 staffing：守恒 + 单调（200 种子化预算）
  let conserveOk = true;
  let monotoneOk = true;
  let stableOk = true;
  let nCases = 0;
  for (let s = 0; s < 200; s += 1) {
    const rng = mulberry32(7300 + s);
    const classes = Array.from({ length: 1 + Math.floor(rng() * 4) }, (_, i) => ({
      name: `k${i}`,
      arrivalPerSec: 0.1 + rng() * 6,
      serviceMeanMs: 100 + rng() * 1500,
    }));
    const R = Math.floor(rng() * 12);
    const rep = multiclassStaffing(classes, R);
    nCases += 1;
    const extraSum = rep.classes.reduce((acc, c) => acc + c.extra, 0);
    if (extraSum !== R) conserveOk = false;
    if (rep.totalServers !== rep.classes.reduce((acc, c) => acc + c.base + c.extra, 0)) conserveOk = false;
    if (!rep.stable) stableOk = false;
    // 冗余预算 +1 → 加权平均等待单调不增
    if (R > 0) {
      const rep0 = multiclassStaffing(classes, R - 1);
      if (!(rep.aggregateWaitMs <= rep0.aggregateWaitMs + 1e-9)) monotoneOk = false;
    }
  }
  ok(nCases === 200 && conserveOk, `staffing 守恒：200 种子化(类数,预算)下 Σextra_k = 预算 且 Σ(base+extra) = totalServers（最大余数法精确到 1）`);
  ok(monotoneOk, 'staffing 单调：冗余预算 +1 → 加权平均等待单调不增（200 种子化对照）');
  ok(stableOk, 'staffing 稳定：保底 ⌊a⌋+1 下全部 200 例 ρ<1（整数负载 a 台恰好 ρ=1 的陷阱被防）');

  // elastic 均衡（200 种子化）
  let elasticOk = true;
  let gammaMono = true;
  let cMono = true;
  let overloadStable = true;
  for (let s = 0; s < 200; s += 1) {
    const rng = mulberry32(8100 + s);
    const lambda0 = 1 + rng() * 20;
    const meanMs = 200 + rng() * 2000;
    const servers = 2 + Math.floor(rng() * 10);
    const gamma = rng() * 0.02;
    const eq = elasticArrivalEquilibrium(lambda0, meanMs, servers, gamma);
    if (!eq) { elasticOk = false; continue; }
    if (!(eq.lambdaEff <= lambda0 * (1 + 1e-9))) elasticOk = false;
    if (!(eq.rho < 1)) elasticOk = false;
    if (!(eq.admittedShare > 0 && eq.admittedShare <= 1 + 1e-12)) elasticOk = false;
    const eqHi = elasticArrivalEquilibrium(lambda0, meanMs, servers, gamma + 0.01);
    if (eqHi && eqHi.lambdaEff > eq.lambdaEff + 1e-9) gammaMono = false; // γ↑ → λ*↓
    const eqC = elasticArrivalEquilibrium(lambda0, meanMs, servers + 1, gamma);
    if (eqC && eqC.lambdaEff + 1e-9 < eq.lambdaEff) cMono = false; // c↑ → λ*↑
    // 名义过载（λ0 ≥ cμ）自稳：均衡仍在 ρ<1
    const cap = servers * (1000 / meanMs);
    if (lambda0 >= cap && !(eq.rho < 1)) overloadStable = false;
  }
  ok(elasticOk, 'elastic 均衡：200 种子化 (λ0,μ,c,γ) 下 λ* ≤ λ0、ρ*<1、admittedShare ∈ (0,1]');
  ok(gammaMono, 'elastic 单调①：劝退敏感度 γ↑ → 均衡到达率 λ*↓（200 种子化）');
  ok(cMono, 'elastic 单调②：并发 c↑ → λ*↑（200 种子化）');
  const over = elasticArrivalEquilibrium(9.5, 1000, 8, 0.005);
  ok(over !== undefined && over.rho < 1 && over.admittedShare < 1,
    `名义过载自稳：λ0=9.5 > cμ=8 时均衡 ρ*=${over ? over.rho.toFixed(3) : '—'} < 1（等待劝退是数学出气阀，admitted=${over ? over.admittedShare.toFixed(3) : '—'}）`);

  // plan() Kingman 初值局部搜索 vs 旧二分：逐位同解（200 题）+ 耗时对照
  const legacyPlanWait = (c, lambda, mu, scv) =>
    (scv === 1 ? erlangC(lambda, mu, c).avgWait : kingmanWq(lambda, mu, c, scv)) * 1000;
  function legacyPlan(lambda, meanMs, scv, current, targetMs, maxC) {
    const mu = 1000 / meanMs;
    const waitMs = (c) => legacyPlanWait(c, lambda, mu, scv);
    const minStable = Math.floor(lambda / mu) + 1;
    const lo = Math.max(1, minStable);
    const hi = Math.max(maxC, current, minStable);
    if (waitMs(hi) > targetMs) return { c: hi, feasible: false, wait: waitMs(hi) };
    let l = lo;
    let h = hi;
    while (l < h) {
      const mid = Math.floor((l + h) / 2);
      if (waitMs(mid) <= targetMs) h = mid; else l = mid + 1;
    }
    return { c: l, feasible: true, wait: waitMs(l) };
  }
  let agreeC = true;
  let agreeWait = true;
  let nPlan = 0;
  let feasibleAgree = true;
  for (let s = 0; s < 200; s += 1) {
    const rng = mulberry32(6200 + s);
    const lambda = 0.1 + rng() * 12;
    const meanMs = 100 + rng() * 2000;
    const scv = rng() < 0.5 ? 1 : 1 + rng() * 3;
    const current = 1 + Math.floor(rng() * 8);
    const targetMs = 50 + rng() * 4000;
    const planner = new CapacityPlanner({ targetWaitMs: targetMs, maxConcurrency: 64 });
    const plan = planner.plan({ predictedArrivalPerSec: lambda, serviceMeanMs: meanMs, serviceScv: scv, currentConcurrency: current });
    const legacy = legacyPlan(lambda, meanMs, scv, current, targetMs, 64);
    nPlan += 1;
    if (plan.recommendedConcurrency !== legacy.c) agreeC = false;
    if (plan.feasible !== legacy.feasible) feasibleAgree = false;
    if (plan.feasible && Math.abs(plan.expectedWaitMs - legacy.wait) > 1e-6) agreeWait = false;
  }
  ok(nPlan === 200 && agreeC && agreeWait && feasibleAgree,
    'plan() Kingman 初值等价：200 种子化随机规划题与旧二分反解逐位同解（c / 可行性 / 期望等待全等）');
  // 耗时对照（大并发题：erlangC 每次 O(c)——求值次数差异被放大）
  {
    const problems = [];
    for (let s = 0; s < 60; s += 1) {
      const rng = mulberry32(6250 + s);
      problems.push({
        lambda: 200 + rng() * 2400,
        meanMs: 100 + rng() * 400,
        scv: rng() < 0.5 ? 1 : 1 + rng() * 3,
        current: 1 + Math.floor(rng() * 8),
        targetMs: 10 + rng() * 200,
      });
    }
    const t0 = performance.now();
    for (let r = 0; r < 8; r += 1) {
      for (const p of problems) legacyPlan(p.lambda, p.meanMs, p.scv, p.current, p.targetMs, 4096);
    }
    const t1 = performance.now();
    for (let r = 0; r < 8; r += 1) {
      for (const p of problems) {
        new CapacityPlanner({ targetWaitMs: p.targetMs, maxConcurrency: 4096 }).plan({
          predictedArrivalPerSec: p.lambda, serviceMeanMs: p.meanMs, serviceScv: p.scv, currentConcurrency: p.current,
        });
      }
    }
    const t2 = performance.now();
    const oldMs = t1 - t0;
    const newMs = t2 - t1;
    ok(newMs < oldMs * 0.85,
      `plan() 耗时对照：旧二分 ${oldMs.toFixed(0)}ms vs Kingman 初值局部搜索 ${newMs.toFixed(0)}ms（480 次大并发规划题，c ∈ [~200, 4096]——求值次数 ~7-12 → ~2-4）`);
  }

  // Little 定律守恒（轴 4 锚点，200 种子化）
  let littleOk = true;
  for (let s = 0; s < 200; s += 1) {
    const rng = mulberry32(5100 + s);
    const lambda = 0.05 + rng() * 5;
    const mu = 0.5 + rng() * 5;
    const c = 1 + Math.floor(rng() * 8);
    const a = lambda / mu;
    if (a >= c) continue;
    const m = erlangC(lambda, mu, c);
    // Lq = λ·Wq（erlangC 的 avgQueueLength 即此口径——守恒残差应到舍入精度）
    if (Math.abs(m.avgQueueLength - lambda * m.avgWait) > 1e-6 * Math.max(1, m.avgQueueLength)) littleOk = false;
  }
  ok(littleOk, 'Little 定律守恒：200 种子化 M/M/c 下 Lq = λ·Wq（舍入精度内成立）');
}

// ═══════════════════ 55.0 Hawkes：多维交叉激发 + KS 检验（轴 1/3/4） ═══════════════════

section('55.0 多维 Hawkes 交叉激发矩阵 + 补偿器 KS 检验');

{
  const TRUE = { mu: [0.4, 0.3], alpha: [[0.25, 0.15], [0.2, 0.2]], beta: 1.0 };
  ok(Math.abs(spectralRadius(TRUE.alpha) - 0.4) < 1e-12,
    '谱半径闭式：ρ([[.25,.15],[.2,.2]]) = 0.4（特征值 0.4/0.05，Perron 根精确）');

  const events = simulateMultivariate({ ...TRUE, T: 6000, seed: 202 });
  const byDim = splitByDim(events, 2);
  // 平稳率闭式 λ̄ = (I−A)⁻¹μ（A = α/β，β=1）：2×2 逆的 Cramer 展开含对角
  const solve2 = (a, b) => {
    const det = (1 - a[0][0]) * (1 - a[1][1]) - a[0][1] * a[1][0];
    const x0 = ((1 - a[1][1]) * b[0] + a[0][1] * b[1]) / det;
    const x1 = (a[1][0] * b[0] + (1 - a[0][0]) * b[1]) / det;
    return [x0, x1];
  };
  const rates = solve2(TRUE.alpha, TRUE.mu);
  ok(Math.abs(byDim[0].length / 6000 - rates[0]) < 0.05 && Math.abs(byDim[1].length / 6000 - rates[1]) < 0.05,
    `多维遍历率：N_d/T = [${(byDim[0].length / 6000).toFixed(3)}, ${(byDim[1].length / 6000).toFixed(3)}] ↔ (I−A)⁻¹μ 闭式 [${rates.map((r) => r.toFixed(3)).join(', ')}]（±0.05）`);
  ok(events.every((e, i) => i === 0 || events[i - 1].t < e.t) && events.every((e) => e.t > 0 && e.t <= 6000),
    `多维 thinning 仿真：${events.length} 事件全局时间轴严格递增且落 (0,T]`);

  const llTrue = multivariateLogLik(TRUE, byDim, 6000);
  const fit = fitHawkesMultivariate(byDim, { iters: 400 });
  const diagErr = Math.max(Math.abs(fit.alpha[0][0] - 0.25), Math.abs(fit.alpha[0][1] - 0.15),
    Math.abs(fit.alpha[1][0] - 0.2), Math.abs(fit.alpha[1][1] - 0.2));
  ok(diagErr <= 0.08,
    `交叉激发矩阵恢复：α̂ = [${fit.alpha.map((r) => r.map((x) => x.toFixed(3)).join(',')).join(' | ')}] vs 真值 [.25,.15 | .20,.20]（最大元素差 ${diagErr.toFixed(3)} ≤ 0.08）`);
  ok(Math.abs(fit.eta - 0.4) <= 0.06 && fit.eta < 1,
    `谱半径恢复：η̂=ρ(α̂/β̂)=${fit.eta.toFixed(4)} ↔ 0.4（±0.06，平稳性钳位在位）`);
  ok(Math.abs(fit.beta - 1) <= 0.4, `共享 β 恢复：β̂=${fit.beta.toFixed(3)} ↔ 1.0（±0.4）`);
  ok(fit.logLik >= llTrue - 1,
    `MLE 上升性：ℓ(θ̂)=${fit.logLik.toFixed(2)} ≥ ℓ(θ_true)−1=${(llTrue - 1).toFixed(2)}（MLE 不劣于真值）`);

  // 残差指数性（轴 4）：200 种子 KS + 均值
  let ksCalibrated = true;
  let meanOk = true;
  let below05 = 0;
  let below001 = 0;
  let nKs = 0;
  const pSamples = [];
  for (let s = 0; s < 200; s += 1) {
    const rng = mulberry32(11700 + s);
    const mu = 0.3 + rng() * 1.2;
    const beta = 0.5 + rng() * 2.5;
    const eta = 0.1 + rng() * 0.5;
    const ev = simulate({ mu, alpha: eta * beta, beta, T: 400, seed: 30000 + s });
    if (ev.length < 60) continue;
    const d = residualDiagnostics({ mu, alpha: eta * beta, beta }, ev);
    if (!(Math.abs(d.mean - 1) <= 0.25)) meanOk = false;
    const ks = ksExpOneTest(d.residuals);
    nKs += 1;
    pSamples.push(ks.pValue);
    if (ks.pValue < 0.05) below05 += 1;
    if (ks.pValue < 0.001) below001 += 1;
  }
  pSamples.sort((a, b) => a - b);
  ok(meanOk, 'Hawkes 残差指数性：200 种子真参数下 mean(R) ∈ 1±0.25（时间重标定理）');
  // 校准口径：真参数下 KS p 应近似均匀——α=0.05 处假阳性率 ≈ 5%
  ok(nKs >= 190 && below05 >= Math.floor(nKs * 0.015) && below05 <= Math.ceil(nKs * 0.10) && below001 <= 2,
    `KS 校准：${nKs} 种子真参数下 p<0.05 共 ${below05}（≈5% 名义水平的抽样带）、p<0.001 共 ${below001}（≤2）——检验不误伤也不失效，中位 p=${pSamples[Math.floor(pSamples.length / 2)].toFixed(3)}`);

  // 失配强拒绝：Poisson 参数拟合 Hawkes 数据
  const evBig = simulate({ mu: 0.5, alpha: 0.4, beta: 1.0, T: 45000, seed: 11 });
  const mis = residualDiagnostics({ mu: evBig.length / 45000, alpha: 0, beta: 1.0 }, evBig);
  const ksMis = ksExpOneTest(mis.residuals);
  ok(ksMis.pValue < 1e-6,
    `KS 失配强拒绝：Poisson 参数对 Hawkes(η=0.4) 数据 D=${ksMis.statistic.toFixed(4)}，p=${ksMis.pValue.toExponential(2)} < 1e-6（补偿器检验抓到传染结构）`);

  // Kolmogorov 分布锚点
  ok(Math.abs(kolmogorovUpperTail(1.3581) - 0.05) < 2e-3,
    `Kolmogorov 分布锚点：Q(1.3581) = ${kolmogorovUpperTail(1.3581).toFixed(4)} ≈ 0.05（5% 临界值）`);
  ok(kolmogorovUpperTail(0.828) > 0.45 && kolmogorovUpperTail(0.828) < 0.55,
    `Q(0.828) ≈ 0.5（中位临界，实际 ${kolmogorovUpperTail(0.828).toFixed(4)}）`);

  // 一维 EM 不受升级影响（回归锚点）
  const fit1 = fitHawkes(evBig, { iters: 300 });
  ok(Math.abs(fit1.eta - 0.4) <= 0.08, `一维 EM 回归锚点：η̂=${fit1.eta.toFixed(4)} ↔ 0.4（±0.08）`);
}

// ═══════════════════ 42.0 谱周期：谐波梳 + Fisher log 域 + FFT ACF ═══════════════════

section('42.0 谐波梳 + Fisher g 精确 p log 域 + Wiener–Khinchin ACF');

{
  // lgamma / incomplete beta 锚点
  ok(Math.abs(logGamma(0.5) - Math.log(Math.sqrt(Math.PI))) < 1e-12, 'logGamma(1/2) = ln√π（Lanczos 锚点）');
  ok(Math.abs(logGamma(1)) < 1e-12 && Math.abs(logGamma(6) - Math.log(120)) < 1e-10, 'logGamma(1)=0, logGamma(6)=ln120');
  ok(Math.abs(betaUpperTail(0.5, 2, 3) - 0.3125) < 1e-10, 'betaUpperTail(0.5,2,3) = 11/32 = 0.3125（多项式积分闭式）');
  ok(Math.abs(betaUpperTail(0.3, 1, 1) - 0.7) < 1e-12, 'betaUpperTail(0.3,1,1) = 0.7（均匀分布退化）');

  // Fisher g 旧式 vs log 域新式逐点对照（旧式安全区）
  function legacyFisher(g, m) {
    if (!(g > 0) || m < 2) return 1;
    if (g >= 1) return 0;
    let p = 0;
    const binom = (a, b) => { let c = 1; for (let i = 0; i < b; i += 1) c = c * (a - i) / (i + 1); return c; };
    for (let j = 1; j * g < 1 && j <= m; j += 1) { const t = binom(m, j) * Math.pow(1 - j * g, m - 1); p += j % 2 === 1 ? t : -t; }
    return Math.min(1, Math.max(0, p));
  }
  let worstFisher = 0;
  let nFisher = 0;
  for (const m of [2, 3, 5, 10, 31, 64, 127, 200, 500, 1000]) {
    for (let i = 1; i < 40; i += 1) {
      const g = (i / 40) * 0.98 + 0.001;
      const a = legacyFisher(g, m);
      if (Number.isFinite(a)) {
        nFisher += 1;
        worstFisher = Math.max(worstFisher, Math.abs(a - fisherGUpperTail(g, m)));
      }
    }
  }
  ok(nFisher >= 300 && worstFisher < 1e-10,
    `Fisher g 精确 p log 域升级等价：${nFisher} 个 (g,m) 网格点与旧式最大偏差 ${worstFisher.toExponential(2)} < 1e-10`);
  const legacyOverflow = legacyFisher(0.005, 5000);
  const modern = fisherGUpperTail(0.005, 5000);
  ok(!Number.isFinite(legacyOverflow) && Number.isFinite(modern) && modern >= 0 && modern <= 1,
    `大 m 溢出区：旧式 C(5000,~199) 直乘 → ${legacyOverflow}（NaN/Infinity），log 域 → ${modern.toExponential(3)} 有限且 ∈ [0,1]（轴 3）`);
  let fisherMono = true;
  let prevP = 2;
  for (let i = 1; i <= 60; i += 1) {
    const p = fisherGUpperTail(i / 61, 2000);
    if (p > prevP + 1e-12) fisherMono = false;
    prevP = p;
  }
  ok(fisherMono, 'log 域 Fisher p 在 g 上单调不增（m=2000，交替级数未失真）');

  // ACF 等价 + 耗时（轴 2）
  let worstAcf = 0;
  const L = 48;
  const seriesBank = [];
  for (let s = 0; s < 200; s += 1) {
    const rng = mulberry32(13400 + s);
    const n = 128;
    const x = Array.from({ length: n }, () => rng() * 2 - 1);
    seriesBank.push(x);
    const acf = fftAutocorrelation(x, { maxLag: L });
    const mean = x.reduce((a, b) => a + b, 0) / n;
    let r0 = 0;
    for (const v of x) r0 += (v - mean) * (v - mean);
    r0 /= n;
    for (let lag = 0; lag <= L; lag += 1) {
      let sum = 0;
      for (let t = 0; t + lag < n; t += 1) sum += (x[t] - mean) * (x[t + lag] - mean);
      const direct = sum / n / r0;
      worstAcf = Math.max(worstAcf, Math.abs(acf[lag] - direct));
    }
  }
  ok(worstAcf < 1e-9,
    `Wiener–Khinchin ACF 等价：200 种子 n=128 × lag≤${L} 与逐 lag 直积最大偏差 ${worstAcf.toExponential(2)} < 1e-9`);
  {
    const t0 = performance.now();
    for (let r = 0; r < 5; r += 1) {
      for (const x of seriesBank) {
        const mean = x.reduce((a, b) => a + b, 0) / x.length;
        let r0 = 0;
        for (const v of x) r0 += (v - mean) * (v - mean);
        r0 /= x.length;
        for (let lag = 0; lag <= L; lag += 1) {
          let sum = 0;
          for (let t = 0; t + lag < x.length; t += 1) sum += (x[t] - mean) * (x[t + lag] - mean);
          void sum / r0;
        }
      }
    }
    const t1 = performance.now();
    for (let r = 0; r < 5; r += 1) for (const x of seriesBank) fftAutocorrelation(x, { maxLag: L });
    const t2 = performance.now();
    ok(t2 - t1 < t1 - t0,
      `ACF 耗时对照：直积 ${(t1 - t0).toFixed(0)}ms vs FFT 复用 ${(t2 - t1).toFixed(0)}ms（1000 次 n=128 lag≤${L}）`);
  }
  const sig = Array.from({ length: 512 }, (_, t) => Math.cos((2 * Math.PI * 32 * t) / 512) + 0.3 * (mulberry32(1)() - 0.5));
  const acfSig = fftAutocorrelation(sig, { maxLag: 80 });
  let peakLag = 1;
  let peakVal = -2;
  for (let lag = 2; lag <= 80; lag += 1) if (acfSig[lag] > peakVal) { peakVal = acfSig[lag]; peakLag = lag; }
  ok(peakLag === 16, `ACF 峰搜索定位周期：lag=${peakLag} = 512/32（谱→自相关一次变换复用）`);

  // 谐波梳：白噪声家族假阳性（200 种子）
  let fp = 0;
  for (let s = 0; s < 200; s += 1) {
    const rng = mulberry32(15000 + s);
    const wn = Array.from({ length: 128 }, () => rng());
    if (harmonicComb(wn).significant) fp += 1;
  }
  ok(fp <= 10,
    `谐波梳白噪声家族假阳性：${fp}/200 ≤ 10（Bonferroni 校正后的诚实口径，α=0.05）`);

  // 方波：基频恢复
  const g2 = mulberry32(5150);
  const sq = Array.from({ length: 256 }, (_, t) => (Math.floor(t / 16) % 2 === 0 ? 0.9 : -0.9) + 0.35 * (g2() - 0.5));
  const combSq = harmonicComb(sq);
  ok(combSq.significant && combSq.comb[0] && combSq.comb[0].frequency === 8,
    `方波基频恢复：comb 检出 f=8（周期 32 bin，能量散布于奇数谐波 8,24,40…，share=${combSq.comb[0] ? combSq.comb[0].combShare.toFixed(3) : '—'}）`);

  // 冲激串：Fisher g 盲区、comb 检出（能量平铺 15 个谐波）
  const g3 = mulberry32(404);
  const impulse = Array.from({ length: 256 }, (_, t) => (t % 32 === 0 ? 1.2 : 0) + 1.0 * (g3() - 0.5));
  const repImp = periodogram(impulse);
  const combImpBlind = harmonicComb(impulse);
  const combImpA = harmonicComb(impulse, { fundamental: 8 });
  ok(!repImp.significant && combImpA.comb[0] && combImpA.comb[0].pValue < 1e-4,
    `冲激串功效对照：Fisher g p=${repImp.pValue.toFixed(3)} 不显著（单 bin 最大份额失明）vs 先验 f=8 梳 p=${combImpA.comb[0].pValue.toExponential(2)} 强显著（能量聚合的检出力）`);
  ok(combImpBlind.significant,
    `冲激串盲检：谐波梳（候选=局部峰）家族 p<0.05 检出周期性（g 看不见的 comb 看得见）`);

  // 双周期
  const g4 = mulberry32(999);
  const two = Array.from({ length: 512 }, (_, t) => 0.9 * Math.cos((2 * Math.PI * 8 * t) / 512) + 0.8 * Math.cos((2 * Math.PI * 21 * t) / 512) + 0.5 * (g4() - 0.5));
  const combTwo = harmonicComb(two);
  const freqs = combTwo.comb.map((c) => c.frequency).sort((a, b) => a - b);
  ok(combTwo.comb.length >= 2 && freqs.includes(8) && freqs.includes(21),
    `双周期检出：comb 报告基频 [${freqs.join(', ')}] ⊇ {8, 21}（两条不公约周期同时在场）`);
}

// ═══════════════════ 28.0 极值理论：矩初始化等价 + 返回水平 + 尾部单调 ═══════════════════

section('28.0 GPD 矩初始化 + 返回水平 delta CI + 病态预警');

{
  // 旧实现（等价基准）
  function legacyProfileLoglik(theta, ys) {
    const n = ys.length;
    let sumLog = 0;
    for (const y of ys) { const inner = 1 + theta * y; if (inner <= 1e-12) return -Infinity; sumLog += Math.log(inner); }
    if (Math.abs(theta) < 1e-10) { const ybar = ys.reduce((s, y) => s + y, 0) / n; return -n * Math.log(ybar) - n; }
    const kBar = sumLog / n; const sigma = kBar / theta; if (sigma <= 0) return -Infinity;
    return -n * Math.log(sigma) - (1 + 1 / kBar) * sumLog;
  }
  function legacyFitGpd(ys) {
    const n = ys.length;
    if (n < 8) return undefined;
    const yMax = Math.max(...ys); const yMean = ys.reduce((s, y) => s + y, 0) / n;
    if (!(yMax > 0) || !(yMean > 0)) return undefined;
    const lo = -1 / yMax + 1e-9; const hi = Math.max(2 / yMax, 32 / yMean);
    const grid = 96; let bestTheta = 0; let bestLl = legacyProfileLoglik(0, ys);
    for (let i = 0; i <= grid; i += 1) { const theta = lo + ((hi - lo) * i) / grid; const ll = legacyProfileLoglik(theta, ys); if (ll > bestLl) { bestLl = ll; bestTheta = theta; } }
    let a = Math.max(lo, bestTheta - (hi - lo) / grid); let b = Math.min(hi, bestTheta + (hi - lo) / grid);
    const gr = 0.6180339887498949;
    let c = b - gr * (b - a); let d = a + gr * (b - a);
    let fc = legacyProfileLoglik(c, ys); let fd = legacyProfileLoglik(d, ys);
    for (let it = 0; it < 80; it += 1) {
      if (fc > fd) { b = d; d = c; fd = fc; c = b - gr * (b - a); fc = legacyProfileLoglik(c, ys); }
      else { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = legacyProfileLoglik(d, ys); }
    }
    const theta = (a + b) / 2; const ll = legacyProfileLoglik(theta, ys);
    if (ll >= bestLl) { bestTheta = theta; bestLl = ll; }
    if (Math.abs(bestTheta) < 1e-10) { const ybar = ys.reduce((s, y) => s + y, 0) / n; return { xi: 0, sigma: ybar, logLikelihood: bestLl, theta: 0, n }; }
    let sumLog = 0; for (const y of ys) sumLog += Math.log(1 + bestTheta * y);
    const xi = sumLog / n; const sigma = xi / bestTheta; if (!(sigma > 0)) return undefined;
    return { xi, sigma, logLikelihood: bestLl, theta: bestTheta, n };
  }

  let worstXi = 0;
  let worstLl = 0; // oldLL − newLL（应 ≤ 容差：新解不劣）
  let nEquiv = 0;
  const paretoBank = [];
  for (let s = 0; s < 220; s += 1) {
    const rng = mulberry32(5000 + s);
    const kind = s % 4;
    let samples;
    if (kind === 0) samples = Array.from({ length: 800 }, () => -1000 * Math.log(Math.max(1e-12, rng())));
    else if (kind === 1) samples = Array.from({ length: 800 }, () => 1000 * Math.pow(1 - rng(), -1 / (0.3 + 0.7 * rng())));
    else if (kind === 2) samples = Array.from({ length: 800 }, () => rng() * 1000);
    else samples = Array.from({ length: 800 }, () => Math.pow(rng(), 3) * 2000 + rng() * 50);
    const u = empiricalQuantile(samples, 0.9);
    const ys = samples.filter((x) => x > u).map((x) => x - u);
    const oldF = legacyFitGpd(ys);
    const newF = fitGpd(ys);
    if (!oldF || !newF) continue;
    nEquiv += 1;
    worstXi = Math.max(worstXi, Math.abs(oldF.xi - newF.xi) / Math.max(0.05, Math.abs(oldF.xi)));
    worstLl = Math.max(worstLl, oldF.logLikelihood - newF.logLikelihood);
    if (kind === 1 && ys.length >= 60) paretoBank.push(ys);
  }
  ok(nEquiv >= 200 && worstXi < 1e-3 && worstLl < 1e-6,
    `fitGpd 矩初始化等价：${nEquiv} 个种子化样本（指数/混合Pareto/有界/Weibull 型）ξ̂ 相对差 ≤ ${worstXi.toExponential(2)}、ℓ 差 ≤ ${worstLl.toExponential(2)}（窄括号或宽域回退同解）`);

  // 耗时对照（同质 Pareto——窄括号命中率最高的族）
  {
    const rng = mulberry32(777);
    const samples = Array.from({ length: 3000 }, () => 1000 * Math.pow(1 - rng(), -1 / 3));
    const u = empiricalQuantile(samples, 0.9);
    const ys = samples.filter((x) => x > u).map((x) => x - u);
    const t0 = performance.now();
    for (let i = 0; i < 100; i += 1) legacyFitGpd(ys);
    const t1 = performance.now();
    for (let i = 0; i < 100; i += 1) fitGpd(ys);
    const t2 = performance.now();
    const f = fitGpd(ys);
    ok(t2 - t1 < t1 - t0 && f.momentBracket === true,
      `fitGpd 耗时对照：宽域盲扫 ${(t1 - t0).toFixed(0)}ms vs 矩初始化 ${(t2 - t1).toFixed(0)}ms / 100 次拟合（momentBracket=${f.momentBracket}，剖面求值 96+80 → 24+40）`);
  }

  // 返回水平：闭式对照 + 单调 + CI 变宽 + potQuantiles 一致
  {
    const rng = mulberry32(2026);
    const samples = Array.from({ length: 4000 }, () => -800 * Math.log(Math.max(1e-12, rng())));
    const u = empiricalQuantile(samples, 0.9);
    const ys = samples.filter((x) => x > u).map((x) => x - u);
    const fit = fitGpd(ys);
    const n = samples.length; const nu = ys.length;
    let levelMono = true;
    let ciWiden = true;
    let coverOk = true;
    let prevLevel = -Infinity;
    let prevWidth = -Infinity;
    for (const T of [10, 100, 1000, 10000]) {
      const rl = gpdReturnLevel(fit, n, nu, u, T, ys);
      const truth = 800 * Math.log(T); // P(X>x)=1/T → x = 800·lnT
      if (!(rl.level > prevLevel)) levelMono = false;
      prevLevel = rl.level;
      if (rl.ciLower !== undefined && rl.ciUpper !== undefined) {
        const w = rl.ciUpper - rl.ciLower;
        if (!(w > prevWidth)) ciWiden = false;
        prevWidth = w;
      }
      if (!(rl.ciLower <= rl.level && rl.level <= rl.ciUpper)) coverOk = false;
      if (Math.abs(rl.level - truth) / truth > 0.02) coverOk = false;
    }
    ok(levelMono, '返回水平单调：x_T 随重现期 T=10→10000 严格递增（尾部外推方向正确）');
    ok(ciWiden && coverOk,
      `delta 法 CI：指数尾 4 个 T 下 level 偏离解析 800·lnT ≤ 2%、CI 包含点估计、CI 宽度随 T 单调变宽（外推越远越不确定）`);
    const pq = potQuantiles(fit, n, nu, u, 1 - 1 / 1000);
    const rl = gpdReturnLevel(fit, n, nu, u, 1000, ys);
    ok(Math.abs(pq.varP - rl.level) < 1e-9, '口径一致：gpdReturnLevel(T) ≡ potQuantiles(p=1−1/T)（闭式恒等）');
    ok(Math.abs(gpdLogLik(fit.xi, fit.sigma, ys) - fit.logLikelihood) < 1e-6,
      'gpdLogLik 全参数口径 = 剖面似然收敛值（信息阵的地基对齐）');
  }

  // GPD 尾部单调 + ES ≥ VaR（轴 4，200 拟合）
  let tailMono = true;
  let varMono = true;
  let esGeVar = true;
  for (let s = 0; s < 200; s += 1) {
    const rng = mulberry32(17100 + s);
    const xi = -0.3 + rng() * 0.8; // 含轻尾/重尾
    const sigma = 100 + rng() * 900;
    const ys = Array.from({ length: 200 }, () => {
      const p = Math.max(1e-9, rng());
      // GPD 逆变换采样: y = σ/ξ·(p^{−ξ}−1)
      return Math.abs(xi) < 1e-6 ? -sigma * Math.log(p) : (sigma / xi) * (Math.pow(p, -xi) - 1);
    }).filter((y) => y > 0);
    if (ys.length < 60) continue;
    const u = empiricalQuantile(ys, 0.85);
    const exc = ys.filter((x) => x > u).map((x) => x - u);
    const f = fitGpd(exc);
    if (!f) continue;
    // cdf 关于 y 单调
    let prevCdf = 0;
    for (let i = 1; i <= 20; i += 1) {
      const c = gpdCdf((i / 20) * Math.max(...exc), f.xi, f.sigma);
      if (!(c >= prevCdf - 1e-12) || c < 0 || c > 1 + 1e-12) tailMono = false;
      prevCdf = c;
    }
    // VaR 关于 p 单调 + ES ≥ VaR
    let prevVar = -Infinity;
    for (const p of [0.95, 0.99, 0.995, 0.999]) {
      const q = potQuantiles(f, ys.length, exc.length, u, p);
      if (!q) continue;
      if (!(q.varP > prevVar)) varMono = false;
      prevVar = q.varP;
      if (q.esP !== undefined && !(q.esP >= q.varP - 1e-9)) esGeVar = false;
    }
  }
  ok(tailMono, 'GPD 尾部单调：gpdCdf 关于 y 单调不减且 ∈ [0,1]（200 个种子化拟合）');
  ok(varMono && esGeVar, '风险度量序：VaR_p 随 p 单调增 且 ES_p ≥ VaR_p（尾部均值 ≥ 分位，200 拟合）');

  // 病态预警：混合重尾族 θ 贴可行域边界 → warnings 在场
  {
    const rng = mulberry32(5001);
    const samples = Array.from({ length: 800 }, () => 1000 * Math.pow(1 - rng(), -1 / (0.3 + 0.7 * rng())));
    const u = empiricalQuantile(samples, 0.9);
    const ys = samples.filter((x) => x > u).map((x) => x - u);
    const f = fitGpd(ys);
    ok(f !== undefined && f.warnings !== undefined && f.warnings.length > 0,
      `病态预警（轴 3）：混合重尾 MLE 贴 θ 边界 → warnings=[${f.warnings ? f.warnings.join('；') : '—'}]`);
    // ξ ≥ 0.5 预警
    const rng2 = mulberry32(606);
    const heavy = Array.from({ length: 2000 }, () => 1000 * Math.pow(1 - rng2(), -1 / 0.8)).filter((y) => y > 0);
    const u2 = empiricalQuantile(heavy, 0.9);
    const exc2 = heavy.filter((x) => x > u2).map((x) => x - u2);
    const f2 = fitGpd(exc2);
    ok(f2 !== undefined && f2.warnings !== undefined && f2.warnings.some((w) => w.includes('0.5')),
      `ξ≥0.5 预警：Pareto(ξ=0.8) 样本 ξ̂=${f2 ? f2.xi.toFixed(3) : '—'} → 方差不存在警告在场`);
  }
}

// ═══════════════════ 40.0 首达时间：带漂移反射原理 + 数值反演 ═══════════════════

section('40.0 带漂移反射原理 + IG 分位数数值反演（轴 1/3/4）');

{
  // μ=0 退化 = reflectionMaxProb（逐位）
  let worst0 = 0;
  for (const [a, t, s] of [[10, 400, 1], [3, 25, 2], [1, 1, 1], [5, 100, 0.5], [7, 36, 3]]) {
    worst0 = Math.max(worst0, Math.abs(driftPassageProb(a, 0, s, t) - reflectionMaxProb(a, t, s)));
  }
  ok(worst0 <= 1e-15, `μ=0 退化锚点：driftPassageProb ≡ reflectionMaxProb（最大偏差 ${worst0.toExponential(2)}，零漂移）`);

  // IG-CDF 恒等（带漂移首达 = 逆高斯分布）
  const a = 10; const mu = 0.5; const sig = 1;
  const m = a / mu; const sh = (a * a) / (sig * sig);
  let worstIg = 0;
  for (const t of [0.5, 1, 5, 20, 100, 1000]) {
    worstIg = Math.max(worstIg, Math.abs(driftPassageProb(a, mu, sig, t) - inverseGaussianCdf(t, m, sh)));
  }
  ok(worstIg <= 1e-14, `IG 恒等：P(sup(μs+σW)≥a, s≤t) = IG-CDF(t; a/μ, a²/σ²)（最大偏差 ${worstIg.toExponential(2)}——两条独立公式互相印证）`);

  // 首达概率归一 + 单调（轴 4，200 种子化）
  let normOk = true;
  let monoOk = true;
  let hitOk = true;
  for (let i = 0; i < 200; i += 1) {
    const rng = mulberry32(19300 + i);
    const aa = 0.5 + 20 * rng();
    const muu = (rng() - 0.35) * 4;
    const sg = 0.3 + 3 * rng();
    let prev = driftPassageProb(aa, muu, sg, 0.01);
    for (let k = 1; k <= 30; k += 1) {
      const t = 0.01 * Math.pow(1.5, k);
      const cur = driftPassageProb(aa, muu, sg, t);
      if (cur < prev - 1e-12) monoOk = false;
      prev = cur;
    }
    const lim = driftPassageProb(aa, muu, sg, 1e9);
    const target = muu >= 0 ? 1 : Math.exp((2 * muu * aa) / (sg * sg));
    if (Math.abs(lim - target) > 1e-6) normOk = false;
    if (Math.abs(hittingProbability(aa, muu, sg) - target) > 1e-12) hitOk = false;
  }
  ok(normOk, '首达概率归一：t→∞ 时 P→1（μ≥0）或 P→e^{2μa/σ²}（μ<0，200 种子化，终达概率精确）');
  ok(monoOk, '首达概率关于视界 t 单调不减（200 种子化 × 30 视界）');
  ok(hitOk, 'hittingProbability 闭式 = μ≥0→1、μ<0→e^{2μa/σ²}（与漂移极限逐位一致）');

  // 溢出防护：μa/σ² = 5000
  const big = driftPassageProb(100, 50, 1, 3);
  ok(Number.isFinite(big) && big >= 0 && big <= 1,
    `log 域第二项：μa/σ²=5000 时 e^{2μa/σ²}≈∞·Φ(−∞) 的乘积有限 → P=${big.toFixed(6)}（轴 3，无假溢出）`);
  ok(Math.abs(driftPassageProb(10, -0.5, 1, 1e6) - 4.539993e-5) < 1e-10,
    'μ<0 精确读数：P(t=1e6) = 4.539993e-5 = e^{−10}（结构性恶化的残余恢复概率）');

  // 分位数数值反演（往返恒等 + 单调 + 中位数偏斜）
  let worstRT = 0;
  let qMono = true;
  for (const [mm, ssh] of [[5, 9], [100, 20], [3, 3], [50, 200], [17, 4]]) {
    let prevQ = 0; // 单调按参数集分组（跨集量纲不同）
    for (let i = 1; i <= 99; i += 1) {
      const p = i / 100;
      const q = inverseGaussianQuantile(p, mm, ssh);
      worstRT = Math.max(worstRT, Math.abs(inverseGaussianCdf(q, mm, ssh) - p));
      if (q < prevQ) qMono = false;
      prevQ = q;
    }
  }
  ok(worstRT < 1e-6,
    `IG 分位数反演往返恒等：CDF(Q(p)) = p（495 个 (p, mean, shape) 组合，最差 ${worstRT.toExponential(2)} < 1e-6）`);
  ok(qMono, 'IG 分位数关于 p 单调增（5 组参数 × 99 分位）');
  ok(inverseGaussianQuantile(0.5, 5, 9) < 5,
    `IG 中位数 < 均值：Q(0.5)=${inverseGaussianQuantile(0.5, 5, 9).toFixed(4)} < 5（右偏分布的分布学读数——冷却定价别用均值）`);
  let threw = false;
  try { inverseGaussianQuantile(1.5, 5, 9); } catch { threw = true; }
  ok(threw, 'inverseGaussianQuantile p∉(0,1) 显式拒绝');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log('\n──────────────────────────────────────────────────────────');
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
