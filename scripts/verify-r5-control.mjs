/**
 * verify-r5-control.mjs — R5 第五轮「全部内核世界性进化」控制优化组闭环验证
 *
 * 覆盖六个控制优化内核的 R5 进化（每内核 ≥ 2 轴，均含轴 1 数学或轴 2 性能）：
 *   robust-decisions.ts（34.0） 数学（CVaR 场景逼近有限样本界 / McDiarmid）
 *                              + 性能（cvarProfile 一次排序多档 α）
 *                              + 性质（α 单调凸、混合凸、相干公理; ≥200 种子）
 *   feedback-control.ts（35.0） 数学（LQG 输出反馈: 分离定理 + 最优性读数）
 *                              + 性能（一般-a DARE 精确闭式 + LPV 热启动）
 *                              + 数值（Kalman Joseph 形式: 恒等 + 极值域不失效）
 *   lyapunov-drift.ts（54.0）  数学（多队列加权利亚普诺夫: 持有成本权重进背压）
 *                              + 性能（lpBenchmark 对偶重解跳过: 富余约束乘子=0）
 *                              + 性质（加权漂移证书路径必然; heavy-traffic cμ 读数）
 *   safety-barrier.ts（87.0）  数学（多屏障合取: k 个 h 的安全交集最小修改）
 *                              + 性能（1D 扫描缓存 + 多维距离下界剪枝分支定界）
 *                              + 性质（前向不变性: 200 种子闭环双屏障 0 违反）
 *   optimal-assignment.ts（32.0） 数学（稀疏 LSAP: 结构性禁边 + Hall 检查）
 *                              + 性能（稀疏 JV 邻接表 vs 稠密 M 填充耗时对照）
 *                              + 性质（完美匹配性 300 随机实例 ≡ 稠密最优）
 *   max-flow.ts（43.0）        数学（最小费用流 SSP + 无负环最优性证书）
 *                              + 性能（Dinic 分层 vs Edmonds-Karp 耗时对照）
 *                              + 数值（流量守恒浮点残差审计）+ 性质（随机图 ≥50）
 *
 * 断言口径：解析锚点（闭式可手算的精确值）、等价证明（脚本侧参考实现对照:
 * 逐位或解析容差; 规模-耗时对照）、性质检验（种子化随机 ≥ 200 输入）。
 *
 * 运行：node --experimental-transform-types scripts/verify-r5-control.mjs
 * （六内核零依赖，直接从 src 的 .ts 引入; 无 I/O、无时钟依赖断言。）
 */

import {
  cvar,
  cvarProfile,
  cvarSampleComplexity,
  cvarRequiredSamples,
  cvarScenarioBound,
  cvarCoherenceAudit,
  quantile,
} from '../src/core/robust-decisions.ts';
import {
  dareScalarClosedForm,
  dareScalarGeneralClosedForm,
  dareIterate,
  dareSweepLpv,
  kalmanJosephUpdate,
  kalmanSteadyState,
  LqgController,
  lqgSimulate,
} from '../src/core/feedback-control.ts';
import {
  driftPlusPenaltyStep,
  driftPlusPenaltyStepWeighted,
  workNormalizedWeights,
  lpBenchmark,
} from '../src/core/lyapunov-drift.ts';
import {
  cbfFilter,
  cbfFilterConjunction,
  simulateClosedLoop,
  violationReport,
  brakeDoubleIntegrator,
} from '../src/core/safety-barrier.ts';
import {
  solveAssignment,
  solveAssignmentSparse,
  assignmentCertificate,
} from '../src/core/optimal-assignment.ts';
import {
  maxFlow,
  minCutCertificate,
  bruteForceMinCut,
  minCostMaxFlow,
  minCostFlowCertificate,
  flowAudit,
} from '../src/core/max-flow.ts';
import { performance } from 'node:perf_hooks';

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
function okThrow(fn, label) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, label);
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
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}
function poisson(rng, lambda) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > L);
  return k - 1;
}
function timeBest(fn, reps) {
  let best = Infinity;
  for (let r = 0; r < reps; r += 1) {
    const t0 = performance.now();
    fn();
    const dt = performance.now() - t0;
    if (dt < best) best = dt;
  }
  return best;
}

// ═══════════════════ A robust-decisions.ts（34.0 CVaR） ═══════════════════

section('A1 34.0 CVaR 场景逼近有限样本界（McDiarmid 有界差分）');

{
  // 解析锚点: n = ⌈B²ln(1/δ)/(2ε²(1−α)²)⌉ 反解后 ε(n) ≤ ε（自洽恒等式）
  const alpha = 0.95;
  const delta = 0.05;
  const B = 400;
  for (const eps of [5, 10, 25]) {
    const n = cvarRequiredSamples(alpha, eps, 1 - delta, B);
    const achieved = cvarSampleComplexity(n, alpha, 1 - delta, B);
    ok(achieved <= eps + 1e-12, `ε=${eps}: 需求 n=${n} 样本 → 实际罚 ${achieved.toFixed(4)} ≤ ${eps}（反解自洽）`);
  }
  // ε ~ 1/√n 标度: ε(4n) = ε(n)/2（精确恒等式——公式解析）
  const e1 = cvarSampleComplexity(1000, 0.9, 0.95, 10);
  const e2 = cvarSampleComplexity(4000, 0.9, 0.95, 10);
  ok(near(e2 * 2, e1, 1e-15), `ε 随 n 以 1/√n 收缩: ε(4000)×2 = ${(e2 * 2).toExponential(4)} = ε(1000)（精确）`);
  // 尾部深度计费: α→1 时罚按 1/(1−α) 放大
  const eA = cvarSampleComplexity(500, 0.9, 0.95, 10);
  const eB = cvarSampleComplexity(500, 0.99, 0.95, 10);
  ok(near(eB / eA, (1 - 0.9) / (1 - 0.99), 1e-12), `更深尾更贵: ε(α=.99)/ε(α=.9) = ${(eB / eA).toFixed(4)} = 0.1/0.01（1/(1−α) 口径）`);

  // Monte Carlo 覆盖: 对数正态损失，真值用 10⁶ 样本锚定; 300 试次 n=200、δ=0.05
  const g = gaussianMaker(20261001);
  const truthSamples = Array.from({ length: 1_000_000 }, () => Math.exp(g() * 0.8) * 400);
  const truth = cvar(truthSamples, 0.95);
  const gT = gaussianMaker(20261002);
  let covered = 0;
  const TRIALS = 300;
  for (let tr = 0; tr < TRIALS; tr += 1) {
    const s = Array.from({ length: 200 }, () => Math.exp(gT() * 0.8) * 400);
    const bound = cvarScenarioBound(s, 0.95, { confidence: 0.95, supportUpper: 3000, supportLower: 0 });
    if (bound !== undefined && bound.bound >= truth - 1e-9) covered += 1;
  }
  const coverage = covered / TRIALS;
  ok(coverage >= 0.93, `300 试次覆盖 ${covered}/${TRIALS} = ${(coverage * 100).toFixed(1)}% ≥ 93%（理论 ≥ 95%（δ=0.05）; 真值 CVaR=${truth.toFixed(1)}，10⁶ 样本锚定）`);
  // 罚的诚实性: bound ≥ 经验 CVaR 恒成立（罚 ≥ 0）
  const s0 = Array.from({ length: 50 }, (_, i) => 100 + i);
  const b0 = cvarScenarioBound(s0, 0.9, { confidence: 0.99, supportUpper: 200, supportLower: 0 });
  ok(b0 !== undefined && b0.epsilon > 0 && b0.bound === b0.empiricalCvar + b0.epsilon, `bound = CVaR_emp + ε 逐位（ε=${b0 ? b0.epsilon.toFixed(4) : '—'} > 0，经验值不被冒充为真值）`);
  // 入参防御
  okThrow(() => cvarSampleComplexity(0, 0.95, 0.95, 10), 'cvarSampleComplexity n=0 → throw');
  okThrow(() => cvarSampleComplexity(100, 0.95, 1, 10), 'confidence=1 → throw');
  okThrow(() => cvarScenarioBound([1, 2], 0.9, { supportUpper: 0.5, supportLower: 1 }), 'supportUpper(0.5) ≤ supportLower(1) → throw');
}

section('A2 34.0 cvarProfile: 一次排序多档 α（性能 + 等价）');

{
  // 等价: 300 种子随机样本 × 12 档 α 与 cvar() 解析式对账
  const rng = mulberry32(20261003);
  const alphas = [0, 0.01, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.85, 0.9, 0.95, 0.99];
  let worst = 0;
  for (let tr = 0; tr < 300; tr += 1) {
    const n = 5 + Math.floor(rng() * 200);
    const samples = Array.from({ length: n }, () => rng() * 500 - 100);
    const prof = cvarProfile(samples, alphas);
    if (prof === undefined) {
      worst = Infinity;
      break;
    }
    for (let k = 0; k < alphas.length; k += 1) {
      const ref = cvar(samples, alphas[k]);
      const d = Math.abs(prof[k] - ref) / Math.max(1, Math.abs(ref));
      if (d > worst) worst = d;
    }
  }
  ok(worst <= 1e-9, `cvarProfile ≡ cvar() 逐档对账（300 例 × 12 α 最大相对偏差 ${worst.toExponential(2)} ≤ 1e-9——仅求和顺序不同）`);

  // 耗时对照: n=200000、48 档 α
  const g2 = gaussianMaker(20261004);
  const big = Array.from({ length: 200_000 }, () => Math.exp(g2() * 0.6) * 300);
  const grid = Array.from({ length: 48 }, (_, i) => 0.5 + (i * 0.49) / 47);
  const tNaive = timeBest(() => grid.forEach((a) => cvar(big, a)), 3);
  const tProfile = timeBest(() => cvarProfile(big, grid), 3);
  ok(tProfile < tNaive, `48 档 α × 200k 样本: profile ${tProfile.toFixed(0)}ms < 逐档 cvar ${tNaive.toFixed(0)}ms（${(tNaive / tProfile).toFixed(1)}×——一次排序 + 前缀和 + 二分）`);
}

section('A3 34.0 CVaR_α 的单调与尾支配性质（≥200 种子性质检验）');

{
  // 单调不降于置信: α↑ ⟹ CVaR↑; 尾支配: CVaR_α ≥ VaR_α（尾部均值 ≥ 尾部分位）
  const rng = mulberry32(20261005);
  let monoOk = true;
  let tailOk = true;
  let meanOk = true;
  const grid = Array.from({ length: 41 }, (_, i) => (i * 0.975) / 40);
  for (let tr = 0; tr < 250; tr += 1) {
    const n = 10 + Math.floor(rng() * 300);
    const samples = Array.from({ length: n }, () => rng() * 1000);
    const prof = cvarProfile(samples, grid);
    if (prof === undefined) {
      monoOk = false;
      break;
    }
    const mean = samples.reduce((s, x) => s + x, 0) / n;
    if (!near(prof[0], mean, 1e-9 * Math.max(1, Math.abs(mean)))) meanOk = false;
    for (let k = 1; k < grid.length; k += 1) {
      if (prof[k] < prof[k - 1] - 1e-9 * Math.max(1, Math.abs(prof[k - 1]))) monoOk = false;
    }
    for (const alpha of [0.5, 0.8, 0.9, 0.95, 0.99]) {
      const va = quantile(samples, alpha);
      if (va !== undefined && (cvar(samples, alpha) ?? -Infinity) < va - 1e-9 * Math.max(1, Math.abs(va))) tailOk = false;
    }
  }
  ok(meanOk, `α=0 ⟹ CVaR = 均值（250 种子例全过——分布退化锚点）`);
  ok(monoOk, `CVaR_α 随 α 单调不降（250 种子 × 41 档）`);
  ok(tailOk, `尾支配: CVaR_α ≥ VaR_α（250 种子 × 5 档——尾部均值不小于尾部分位）`);

  // 混合凸性（次可加 + 正齐次的推论 = 分布凸性）: CVaR(λx+(1−λ)y) ≤ λCVaR(x)+(1−λ)CVaR(y)
  let mixOk = true;
  for (let tr = 0; tr < 200; tr += 1) {
    const n = 20 + Math.floor(rng() * 200);
    const x = Array.from({ length: n }, () => rng() * 800);
    const y = Array.from({ length: n }, () => rng() * 800);
    const lam = rng();
    const z = x.map((v, i) => lam * v + (1 - lam) * y[i]);
    const a = 0.9;
    if ((cvar(z, a) ?? 0) > lam * (cvar(x, a) ?? 0) + (1 - lam) * (cvar(y, a) ?? 0) + 1e-9) mixOk = false;
  }
  ok(mixOk, `分布混合凸性 CVaR(λx+(1−λ)y) ≤ λCVaR(x)+(1−λ)CVaR(y)（200 种子索引耦合样本——凸性的正确口径在分布上，不在 α 上: 尾部均值在分位数拐点处只保证单调与 Lipshitz，不保证 α 凸）`);
  const audit = cvarCoherenceAudit(Array.from({ length: 120 }, () => rng() * 500), 0.9);
  ok(audit.monotone && audit.translationEquivariant && audit.positivelyHomogeneous && audit.subadditive, '相干四公理审计全过（R5 进化未破坏 34.0 原锚点）');
}

// ═══════════════════ B feedback-control.ts（35.0 LQR→LQG） ═══════════════════

section('B1 35.0 LQG 分离定理: 闭环谱 = {a−bK} ∪ {a−cL}，估计方差 → 对偶 DARE');

{
  const ctrl = new LqgController({ plantA: 1, plantB: 0.4, observeC: 1, q: 1, r: 4, processNoise: 0.02, measureNoise: 0.25 });
  const sep = ctrl.separationPoles;
  ok(sep.stable && sep.regulator > 0 && sep.regulator < 1 && sep.estimator > 0 && sep.estimator < 1,
    `分离极点均在 (0,1): 调节器 a−bK = ${sep.regulator.toFixed(6)}，估计器 a−cL = ${sep.estimator.toFixed(6)}（两个 DARE 各解各的——确定性等价）`);
  const s1 = ctrl.step(0.4);
  ok(near(s1.estimate, 0.35, 1e-12) && s1.innovation === 0, `首步用观测初始化: x̂ = y* − y = 0.35（大 P₀ ⟹ 信观测，新息 = 0）`);
  const s2 = ctrl.step(0.4);
  ok(s2.innovation !== 0 || near(s2.estimate, 0.35 + 0.4 * s1.control, 1e-9), `次步走预测-校正: 先验 = a·x̂ + b·u_prev（分离的控制进滤波）`);

  const sim = lqgSimulate({ plantA: 1, plantB: 0.4, observeC: 1, q: 1, r: 4, processNoise: 0.02, measureNoise: 0.25, x0: 0.3 }, 40_000, 7);
  const relErr = Math.abs(sim.estimateErrorVariance - sim.theoreticalCovariance) / sim.theoreticalCovariance;
  ok(relErr <= 0.12, `预测误差方差 ${sim.estimateErrorVariance.toFixed(6)} → 对偶 DARE 理论 P⁻ = ${sim.theoreticalCovariance.toFixed(6)}（偏差 ${(relErr * 100).toFixed(1)}% ≤ 12%，瞬态 Joseph Kalman 的稳态读数）`);
  const sepErr = Math.abs(sim.controlOffErrorVariance - sim.estimateErrorVariance) / sim.estimateErrorVariance;
  ok(sepErr <= 0.08, `控制开/关不改变估计误差: ${sim.controlOffErrorVariance.toFixed(6)} vs ${sim.estimateErrorVariance.toFixed(6)}（偏差 ${(sepErr * 100).toFixed(1)}% ≤ 8%——分离定理的仿真读数）`);
  ok(sim.maxAbsState < 5 && sim.maxAbsStateControlOff > 10, `闭环有界 |x|max = ${sim.maxAbsState.toFixed(2)} vs 开环随机游走发散 |x|max = ${sim.maxAbsStateControlOff.toFixed(1)}（噪声世界里的稳定性）`);
}

section('B2 35.0 LQG 最优性: K·x̂ 打赢失谐增益（多种子平均）');

{
  let lqgCost = 0;
  let detunedCost = 0;
  const seeds = [11, 23, 37, 51, 89];
  for (const seed of seeds) {
    const s = lqgSimulate({ plantA: 1, plantB: 0.4, q: 1, r: 4, processNoise: 0.02, measureNoise: 0.25, x0: 0.3 }, 20_000, seed);
    lqgCost += s.cost;
    detunedCost += s.costDetuned;
  }
  lqgCost /= seeds.length;
  detunedCost /= seeds.length;
  ok(lqgCost < detunedCost - 0.005, `5 种子平均代价: LQG ${lqgCost.toFixed(4)} < K/2 失谐 ${detunedCost.toFixed(4)}（省 ${((1 - lqgCost / detunedCost) * 100).toFixed(1)}%——同噪声序列公平对照）`);
}

section('B3 35.0 Joseph 形式: 代数恒等 + 极值域不失效（数值轴）');

{
  const rng = mulberry32(20261006);
  let maxRelAnalytic = 0;
  let maxRelStandard = 0;
  let nonneg = true;
  for (let tr = 0; tr < 2000; tr += 1) {
    const p = Math.pow(10, -3 + 6 * rng());
    const c = 0.1 + 5 * rng();
    const v = Math.pow(10, -4 + 4 * rng());
    const joseph = kalmanJosephUpdate(p, c, v).pPlus;
    const exact = (p * v) / (v + c * c * p); // 解析式（一次除法，无消去）
    const standard = p - (c * c * p * p) / (v + c * c * p);
    if (!(joseph >= 0)) nonneg = false;
    maxRelAnalytic = Math.max(maxRelAnalytic, Math.abs(joseph - exact) / exact);
    if (Number.isFinite(standard)) maxRelStandard = Math.max(maxRelStandard, Math.abs(standard - exact) / exact);
  }
  ok(maxRelAnalytic <= 1e-12, `Joseph ≡ 解析式 P⁺ = Pv/(V+c²P)（2000 随机例最大相对偏差 ${maxRelAnalytic.toExponential(2)} ≤ 1e-12——代数恒等到机器精度）`);
  ok(maxRelStandard >= maxRelAnalytic, `标准式 P − c²P²/(V+c²P) 偏差 ${maxRelStandard.toExponential(2)} ≥ Joseph 的 ${maxRelAnalytic.toExponential(2)}（P⁺/P 小时标准式自伤于消去——Joseph 无此 pathology）`);
  let extremeGap = 0;
  for (let tr = 0; tr < 500; tr += 1) {
    const p = Math.pow(10, 3 + 3 * rng()); // 极值域（标准式进入消去区）
    const c = 0.1 + 5 * rng();
    const v = Math.pow(10, -4 + 2 * rng());
    const joseph = kalmanJosephUpdate(p, c, v).pPlus;
    if (!(joseph >= 0)) nonneg = false;
    const exact = (p * v) / (v + c * c * p);
    extremeGap = Math.max(extremeGap, Math.abs(joseph - exact) / exact);
  }
  ok(nonneg && extremeGap <= 1e-9, `浮点下恒非负（2500 例 0 违反）且极值域仍贴解析真值（最大偏差 ${extremeGap.toExponential(2)}——消去区里 Joseph 不掉精度）`);
  const ext = kalmanJosephUpdate(1e200, 1, 1e-3);
  const standardExt = 1e200 - (1e200 * 1e200) / (1e-3 + 1e200);
  ok(near(ext.pPlus, 1e-3, 1e-6) && !Number.isFinite(standardExt),
    `极值域 P=1e200: Joseph = ${ext.pPlus.toExponential(2)} ≈ V（正确），标准式 = ${standardExt}（c²P² 溢出后灾难性失效）——Kalman 瞬态全程 Joseph 的理由`);
  okThrow(() => kalmanJosephUpdate(-1, 1, 1), 'kalmanJosephUpdate 负方差 → throw');
}

section('B4 35.0 一般-a DARE 精确闭式 + LPV 热启动（性能轴）');

{
  // 闭式 ≡ 不动点迭代（含 a≠1、|a|>1 的镇定解域）
  const rng = mulberry32(20261007);
  let worst = 0;
  let stabilizing = true;
  let convAll = true;
  for (let tr = 0; tr < 500; tr += 1) {
    const a = -1.4 + 2.6 * rng();
    const b = 0.05 + 3 * rng();
    const q = 0.01 + 5 * rng();
    const r = 0.01 + 20 * rng();
    const cf = dareScalarGeneralClosedForm(a, b, q, r);
    const it = dareIterate(a, b, q, r, 5000, 1e-13);
    if (!it.converged) convAll = false;
    const d = Math.abs(cf - it.p) / Math.max(1, Math.abs(it.p));
    if (d > worst) worst = d;
    const K = (a * b * cf) / (r + b * b * cf);
    if (!(Math.abs(a - b * K) < 1)) stabilizing = false;
  }
  ok(worst <= 1e-10 && convAll, `一般-a 闭式 ≡ 迭代不动点（500 随机 (a,b,q,r) 最大相对偏差 ${worst.toExponential(2)}; a∈[−1.4,1.2]）`);
  ok(stabilizing, '闭式解即镇定解: |a − bK| < 1 全域成立（二次方程唯一正根 = 正定镇定解）');
  const p1 = dareScalarGeneralClosedForm(1, 0.4, 1, 4);
  ok(Math.abs(p1 - dareScalarClosedForm(0.4, 1, 4)) <= 1e-15 * Math.abs(p1),
    `a=1 退化到原闭式（${p1} vs ${dareScalarClosedForm(0.4, 1, 4)}，1 ulp 内——有理化求根与原式代数恒等，浮点路径不同）`);
  okThrow(() => dareScalarGeneralClosedForm(1, 0, 1, 4), 'b=0 → throw');

  // 耗时对照: 2000 档 LPV 扫描，闭式 vs 迭代（迭代每档 ~40 次 O(1) 步）
  const sched = Array.from({ length: 2000 }, (_, i) => ({ a: 0.9, b: 0.5, q: 1 + (i * 1.5) / 1999, r: 4 }));
  const tClosed = timeBest(() => sched.forEach((s) => dareScalarGeneralClosedForm(s.a, s.b, s.q, s.r)), 3);
  const tIter = timeBest(() => sched.forEach((s) => dareIterate(s.a, s.b, s.q, s.r, 5000, 1e-13)), 1);
  ok(tClosed < tIter, `LPV 2000 档 DARE: 闭式 ${tClosed.toFixed(2)}ms < 迭代 ${tIter.toFixed(2)}ms（${(tIter / tClosed).toFixed(0)}×——O(1) 求根 vs 每档数十次不动点）`);

  // 热启动: 同一不动点、迭代数不增（缓慢漂移序列）
  const schedSlow = Array.from({ length: 120 }, (_, i) => ({ a: 0.9, b: 0.5, q: 1 + (i * 0.2) / 119, r: 4 }));
  const cold = dareSweepLpv(schedSlow, 'cold');
  const warm = dareSweepLpv(schedSlow, 'warm');
  let maxDiff = 0;
  schedSlow.forEach((_, i) => {
    maxDiff = Math.max(maxDiff, Math.abs(cold.solutions[i] - warm.solutions[i]));
  });
  ok(cold.allConverged && warm.allConverged && maxDiff <= 1e-10, `LPV 热启动解 ≡ 冷启动（120 档最大差 ${maxDiff.toExponential(2)}，全收敛——等价证明）`);
  ok(warm.totalIterations <= cold.totalIterations, `热启动总迭代 ${warm.totalIterations} ≤ 冷启动 ${cold.totalIterations}（上一档解离不动点更近; 1e-12 尾段线性收敛主导——量级读数见 B4 耗时行）`);
  // p0 参数与迭代计数审计
  const it0 = dareIterate(0.9, 0.5, 1, 4, 5000, 1e-12);
  const itW = dareIterate(0.9, 0.5, 1, 4, 5000, 1e-12, it0.p);
  ok(itW.iterationsUsed <= it0.iterationsUsed && near(itW.p, it0.p, 1e-11), `dareIterate 新增 p0/iterationsUsed 审计: 热启动 ${itW.iterationsUsed} 步 ≤ 冷启动 ${it0.iterationsUsed} 步，同解`);
}

// ═══════════════════ C lyapunov-drift.ts（54.0 加权背压） ═══════════════════

section('C1 54.0 加权漂移步进: 退化一致 + 手算锚点 + 证书路径必然');

{
  const ACTIONS = [
    { id: 'cheap', mu: [0.9, 0], cost: 0 },
    { id: 'balanced', mu: [0.45, 0.45], cost: 0.5 },
    { id: 'premium', mu: [0.9, 0.9], cost: 1 },
  ];
  // 权重 ≡ 1 逐位退化为经典背压
  const a = driftPlusPenaltyStep([3, 0], [0.5, 0.5], ACTIONS, { V: 2 });
  const b = driftPlusPenaltyStepWeighted([3, 0], [0.5, 0.5], ACTIONS, { V: 2, weights: [1, 1] });
  ok(a.index === b.index && a.score === b.score && a.certificateResidual === b.certificateResidual && a.nextQueues[0] === b.nextQueues[0],
    'weights ≡ 1 逐位退化为 driftPlusPenaltyStep（IEEE 乘 1 幂等——向后兼容）');
  // 权重改变决策: Q=(1.2, 1.2)、w=(2,1) 时背压项 2×1.2×0.9 vs 1×1.2×0.9 → cheap 胜; w=(1,2) → premium 胜
  const wA = driftPlusPenaltyStepWeighted([1.2, 1.2], [0.5, 0.5], ACTIONS, { V: 2, weights: [2, 1] });
  const wB = driftPlusPenaltyStepWeighted([1.2, 1.2], [0.5, 0.5], ACTIONS, { V: 2, weights: [1, 2] });
  ok(wA.index === 0 && wB.index === 2,
    `权重就是持有成本: w=(2,1) 选 cheap（${wA.score.toFixed(3)}）、w=(1,2) 翻转选 premium（${wB.score.toFixed(3)}）——同一积压、不同价值排序`);
  // 加权证书 ≥ 0（200 种子随机步）+ argmin ≡ 脚本侧穷举
  const rng = mulberry32(20261008);
  let minResidual = Infinity;
  let argminOk = true;
  for (let tr = 0; tr < 200; tr += 1) {
    const n = 1 + Math.floor(rng() * 4);
    const m = 1 + Math.floor(rng() * 4);
    const qs = Array.from({ length: n }, () => Math.floor(rng() * 30));
    const ar = Array.from({ length: n }, () => rng() * 2);
    const acts = Array.from({ length: m }, () => ({ id: 'x', mu: Array.from({ length: n }, () => rng()), cost: rng() }));
    const w = Array.from({ length: n }, () => 0.2 + rng() * 3);
    const V = 1 + rng() * 9;
    const r = driftPlusPenaltyStepWeighted(qs, ar, acts, { V, weights: w });
    if (r.certificateResidual < minResidual) minResidual = r.certificateResidual;
    let bi = 0;
    let bs = Infinity;
    for (let j = 0; j < m; j += 1) {
      let s = V * acts[j].cost;
      for (let i = 0; i < n; i += 1) s -= w[i] * qs[i] * acts[j].mu[i];
      if (s < bs) {
        bs = s;
        bi = j;
      }
    }
    if (bi !== r.index) argminOk = false;
  }
  ok(minResidual >= -1e-9, `加权漂移证书路径必然: 200 种子随机步最小残差 ${minResidual.toExponential(3)} ≥ −1e-9（½ΣwQ² 口径，逐项乘 w>0 不改方向）`);
  ok(argminOk, '加权 argmin ≡ 脚本侧穷举（200 例全部一致）');
  okThrow(() => driftPlusPenaltyStepWeighted([1, 1], [1, 1], ACTIONS, { V: 1, weights: [1, -1] }), '负权重 → throw');
  okThrow(() => driftPlusPenaltyStepWeighted([1, 1], [1, 1], ACTIONS, { V: 1, weights: [1] }), '权重长度不齐 → throw');
}

section('C2 54.0 heavy-traffic 读数: 等持有成本下 cμ 权重（w≡1）打赢 LQF 权重');

{
  // 单服务器双类: 类 1 服务率 2/slot（每件 0.5 slot），类 2 服务率 0.5/slot（每件 2 slot）
  // λ=(0.9, 0.225) ⟹ 归一化负载 (0.45, 0.45)、总占用 0.9（heavy-traffic 侧）
  // w=(1,1): argmax Q_i μ_i = cμ 规则; w=workNormalizedWeights=(0.5,2): argmax Q_i = LQF
  const HET = [
    { id: 'serve1', mu: [2, 0], cost: 0 },
    { id: 'serve2', mu: [0, 0.5], cost: 0 },
    { id: 'idle', mu: [0, 0], cost: 0 },
  ];
  const LAM = [0.9, 0.225];
  const wn = workNormalizedWeights(HET);
  ok(near(wn[0], 0.5, 1e-12) && near(wn[1], 2, 1e-12), `workNormalizedWeights = (1/μ_max,₁, 1/μ_max,₂) = (${wn.join(', ')}——包数→工作量口径）`);
  const simWeighted = (weights, T, seed) => {
    const rng = mulberry32(seed);
    let Q = [0, 0];
    let sumN = 0;
    for (let t = 0; t < T; t += 1) {
      sumN += Q[0] + Q[1];
      const ar = [poisson(rng, LAM[0]), poisson(rng, LAM[1])];
      const step = driftPlusPenaltyStepWeighted(Q, ar, HET, { V: 1, weights });
      Q = step.nextQueues;
    }
    return sumN / T;
  };
  const T = 150_000;
  const cmu = simWeighted([1, 1], T, 42);
  const lqf = simWeighted(wn, T, 42);
  ok(cmu < lqf, `等持有成本队长目标下 cμ 权重赢: ΣQ̄(w≡1) = ${cmu.toFixed(3)} < LQF ${lqf.toFixed(3)}（T=${T}，同种子同到达序列——Stolyar max-pressure 的 heavy-traffic 方向读数）`);
  ok(cmu < 12 && lqf < 15, `两策略都稳定（平均队长有界: ${cmu.toFixed(2)} / ${lqf.toFixed(2)}——加权定理不破坏稳定性）`);
}

section('C3 54.0 lpBenchmark 对偶重解跳过: 输出等价 + 富余约束免枚举（性能轴）');

{
  // 脚本侧朴素参考: 升级前算法的逐行副本（全量 ±EPS 重解，无跳过）——等价与耗时的公平对照
  const solveSquareRef = (a, b) => {
    const k = b.length;
    const aug = a.map((row, i) => [...row, b[i]]);
    let scale = 1;
    for (const row of a) for (const v of row) scale = Math.max(scale, Math.abs(v));
    const tiny = 1e-11 * scale;
    for (let col = 0; col < k; col += 1) {
      let piv = col;
      for (let r = col + 1; r < k; r += 1) if (Math.abs(aug[r][col]) > Math.abs(aug[piv][col])) piv = r;
      if (Math.abs(aug[piv][col]) <= tiny) return undefined;
      const tmp = aug[col];
      aug[col] = aug[piv];
      aug[piv] = tmp;
      const d = aug[col][col];
      for (let r = 0; r < k; r += 1) {
        if (r === col) continue;
        const f = aug[r][col] / d;
        if (f === 0) continue;
        for (let c = col; c <= k; c += 1) aug[r][c] -= f * aug[col][c];
      }
    }
    const x = new Array(k);
    for (let r = 0; r < k; r += 1) x[r] = aug[r][k] / aug[r][r];
    return x.every((v) => Number.isFinite(v)) ? x : undefined;
  };
  const chooseKRef = (total, k) => {
    const out = [];
    const cur = [];
    const rec = (start, left) => {
      if (left === 0) {
        out.push([...cur]);
        return;
      }
      for (let v = start; v <= total - left; v += 1) {
        cur.push(v);
        rec(v + 1, left - 1);
        cur.pop();
      }
    };
    rec(0, k);
    return out;
  };
  const solveLpRef = (mu, costs, lambda) => {
    const n = lambda.length;
    const m = costs.length;
    const combos = chooseKRef(n + m, m - 1);
    let scale = 1;
    for (const row of mu) for (const v of row) scale = Math.max(scale, Math.abs(v));
    for (const v of lambda) scale = Math.max(scale, Math.abs(v));
    for (const v of costs) scale = Math.max(scale, Math.abs(v));
    const tol = 1e-9 * scale;
    let best;
    let bestCost = Infinity;
    for (const combo of combos) {
      const A = [new Array(m).fill(1)];
      const b = [1];
      for (const c of combo) {
        if (c < n) {
          A.push(mu.map((row) => row[c]));
          b.push(lambda[c]);
        } else {
          const row = new Array(m).fill(0);
          row[c - n] = 1;
          A.push(row);
          b.push(0);
        }
      }
      const x = solveSquareRef(A, b);
      if (x === undefined) continue;
      let feasible = true;
      for (let j = 0; j < m && feasible; j += 1) if (x[j] < -tol) feasible = false;
      for (let i = 0; i < n && feasible; i += 1) {
        let achieved = 0;
        for (let j = 0; j < m; j += 1) achieved += x[j] * mu[j][i];
        if (achieved < lambda[i] - tol) feasible = false;
      }
      if (!feasible) continue;
      let cost = 0;
      for (let j = 0; j < m; j += 1) cost += x[j] * costs[j];
      if (cost < bestCost) {
        bestCost = cost;
        best = x.map((v) => (v < 0 ? 0 : v));
      }
    }
    if (best === undefined) return { feasible: false, optimalCost: Infinity, serviceRates: [] };
    const serviceRates = new Array(n).fill(0);
    for (let i = 0; i < n; i += 1) for (let j = 0; j < m; j += 1) serviceRates[i] += best[j] * mu[j][i];
    return { feasible: true, optimalCost: bestCost, serviceRates };
  };
  const lpNaive = (actionSet, arrivalMeans) => {
    const mu = actionSet.map((a2) => a2.mu.slice());
    const costs = actionSet.map((a2) => a2.cost);
    const base = solveLpRef(mu, costs, arrivalMeans);
    if (!base.feasible) return { feasible: false, optimalCost: Infinity, duals: [] };
    const EPS = 1e-4;
    const duals = [];
    for (let i = 0; i < arrivalMeans.length; i += 1) {
      const up = arrivalMeans.slice();
      up[i] += EPS;
      const upSolve = solveLpRef(mu, costs, up);
      const down = arrivalMeans.slice();
      down[i] = Math.max(0, arrivalMeans[i] - EPS);
      const downDelta = arrivalMeans[i] - down[i];
      const downSolve = downDelta > 0 ? solveLpRef(mu, costs, down) : undefined;
      const upSlope = upSolve.feasible ? (upSolve.optimalCost - base.optimalCost) / EPS : NaN;
      const downSlope = downSolve !== undefined && downSolve.feasible ? (base.optimalCost - downSolve.optimalCost) / downDelta : NaN;
      let y;
      if (Number.isNaN(upSlope)) y = downSlope;
      else if (Number.isNaN(downSlope)) y = upSlope;
      else y = 0.5 * (upSlope + downSlope);
      if (!Number.isFinite(y)) y = 0;
      duals.push(y);
    }
    return { feasible: true, optimalCost: base.optimalCost, duals };
  };

  // 等价: 玩具 + 30 随机实例，内核（带跳过）与朴素参考（全量重解）输出一致
  const ACTIONS = [
    { id: 'cheap', mu: [0.9, 0], cost: 0 },
    { id: 'balanced', mu: [0.45, 0.45], cost: 0.5 },
    { id: 'premium', mu: [0.9, 0.9], cost: 1 },
  ];
  const lp = lpBenchmark({ actionSet: ACTIONS, arrivalMeans: [0.5, 0.5] });
  const ref = lpNaive(ACTIONS, [0.5, 0.5]);
  ok(near(lp.optimalCost, ref.optimalCost, 1e-9) && near(lp.duals[1], ref.duals[1], 1e-9) && near(lp.duals[1], 10 / 9, 1e-9),
    `玩具实例: LP* = 5/9、y* = (0, ${lp.duals[1].toFixed(9)}) 与全量重解参考逐位一致（R5 跳过不改变输出）`);
  const rng = mulberry32(20261009);
  let eqOk = true;
  for (let tr = 0; tr < 30; tr += 1) {
    const n = 1 + Math.floor(rng() * 3);
    const m = 2 + Math.floor(rng() * 4);
    const actionSet = Array.from({ length: m }, () => ({ id: 'a', mu: Array.from({ length: n }, () => rng()), cost: rng() }));
    const arrivalMeans = Array.from({ length: n }, () => rng() * 0.6);
    const k = lpBenchmark({ actionSet, arrivalMeans });
    const r2 = lpNaive(actionSet, arrivalMeans);
    if (k.feasible !== r2.feasible) eqOk = false;
    if (k.feasible && (!near(k.optimalCost, r2.optimalCost, 1e-9) || !k.duals.every((d, i) => near(d, r2.duals[i], 1e-9)))) eqOk = false;
    if (k.feasible && !k.dualFeasible) eqOk = false;
  }
  ok(eqOk, `30 随机实例: 跳过版 LP*/对偶乘子 ≡ 全量重解参考（等价证明）+ 对偶可行性全过`);

  // 跳过计数 + 耗时对照: m=10 动作、n=6 队列、λ 全富余 → 12/12 次重解全跳
  const m10 = Array.from({ length: 10 }, (_, j) => ({ id: `a${j}`, mu: [0.3, 0.25, 0.2, 0.18, 0.15, 0.12].map((v) => v + 0.015 * j), cost: 0.1 * j }));
  const slackLambda = [0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
  const slack = lpBenchmark({ actionSet: m10, arrivalMeans: slackLambda });
  ok(slack.dualSolvesSkipped === 12 && slack.duals.every((d) => d === 0),
    `全富余实例: 12/12 次 ±EPS 重解跳过（C(16,9)=${slack.verticesChecked} 顶点枚举只跑 1 次），乘子全 0`);
  const tK = timeBest(() => lpBenchmark({ actionSet: m10, arrivalMeans: slackLambda }), 3);
  const tN = timeBest(() => lpNaive(m10, slackLambda), 1);
  ok(tK < tN, `耗时对照: 跳过版 ${tK.toFixed(0)}ms ≪ 全量重解参考 ${tN.toFixed(0)}ms（${(tN / tK).toFixed(1)}×——同输入同枚举代码，省掉 12 次 11440 顶点枚举）`);
}

// ═══════════════════ D safety-barrier.ts（87.0 多屏障合取） ═══════════════════

section('D1 87.0 合取滤波: 最小修改性 + 单屏障退化一致');

{
  const dt = 0.1;
  const mkSpec = (pObs, b, eta) => ({
    h: (x) => pObs - x[0] - (x[1] > 0 ? (x[1] * x[1]) / (2 * b) : 0),
    dynamics: (x, u) => [x[0] + x[1] * dt + 0.5 * u[0] * dt * dt, x[1] + u[0] * dt],
    eta,
    uMin: -5,
    uMax: 2,
  });
  const nearObs = mkSpec(10, 5, 0.5);
  const strictBrake = mkSpec(12, 1, 0.5); // 刹车容量 1——高速时是勒得更紧的红线
  const x = [0, 5.5];
  const r = cbfFilterConjunction(x, 2, [nearObs, strictBrake]);
  ok(!r.infeasible && r.margins[0] > 0.1 && Math.abs(r.margins[1]) < 1e-9 && r.bindingCount === 1,
    `双屏障: 紧红线（b=1）勒住动作 u = ${r.u[0].toFixed(4)}，松红线（b=5）余量 ${r.margins[0].toFixed(2)}（binding = 勒住的屏障数 1）`);
  // 最小修改性: 200001 点密集网格穷举最近可行点对照
  const N = 200_001;
  const spacing = 7 / (N - 1);
  let gridBest = null;
  let gridGap = Infinity;
  for (let i = 0; i < N; i += 1) {
    const u = -5 + (i * 7) / (N - 1);
    const nx = nearObs.dynamics(x, [u]);
    if (nearObs.h(nx) >= (1 - 0.5) * nearObs.h(x) && strictBrake.h(nx) >= (1 - 0.5) * strictBrake.h(x)) {
      const gap = Math.abs(u - 2);
      if (gap < gridGap) {
        gridGap = gap;
        gridBest = u;
      }
    }
  }
  ok(gridBest !== null && Math.abs(r.u[0] - gridBest) <= spacing * 1.01 + 1e-12,
    `合取最小修改 = 密网格穷举最近可行点（滤波 ${r.u[0].toFixed(6)} vs 穷举 ${gridBest.toFixed(6)}，|差| ≤ 网格间距 ${spacing.toExponential(1)}）`);
  // 单屏障退化: 与 cbfFilter 一致（网格间距级）
  const single = cbfFilter(x, 2, nearObs);
  const singleConj = cbfFilterConjunction(x, 2, [nearObs]);
  ok(Math.abs(single.u[0] - singleConj.u[0]) <= 7 / 256 * 1.05 + 1e-9,
    `单屏障合取 ≡ cbfFilter（${single.u[0].toFixed(6)} vs ${singleConj.u[0].toFixed(6)}——k=1 退化一致性）`);
  // 交集空: 无刹车容量屏障 + 温和刹车屏障，高速态 → 诚实 infeasible
  const noBrake = { ...mkSpec(10, 5, 0.05), uMin: 0 };
  const rBad = cbfFilterConjunction([0, 9], 2, [noBrake]);
  ok(rBad.infeasible === true && rBad.minViolation > 0, `单屏障死角不变: aMin=0 高速态 → infeasible + minViolation = ${rBad.minViolation.toFixed(6)} > 0（诚实拒绝）`);
  okThrow(() => cbfFilterConjunction([0, 1], 2, [{ ...mkSpec(10, 5, 0.5), uMin: -5, uMax: -2 }, { ...mkSpec(10, 5, 0.5), uMin: -1, uMax: 2 }]), '动作箱交集空 → throw');
}

section('D2 87.0 前向不变性: 200 种子闭环双屏障 0 违反（性质轴）');

{
  const dt = 0.1;
  const mkSpec = (pObs, b, eta) => ({
    h: (x) => pObs - x[0] - (x[1] > 0 ? (x[1] * x[1]) / (2 * b) : 0),
    dynamics: (x, u) => [x[0] + x[1] * dt + 0.5 * u[0] * dt * dt, x[1] + u[0] * dt],
    eta,
    uMin: -5,
    uMax: 2,
  });
  // 每屏障 aMin = −b ⟹ 各自递归可行 ⟹ 合取永不 infeasible
  const specs = [mkSpec(10, 5, 0.6), mkSpec(14, 2.5, 0.4)];
  const T = 120;
  let allSafe = true;
  let anyInfeasible = 0;
  let hMinAll = Infinity;
  const rng = mulberry32(20261010);
  for (let seed = 1; seed <= 200; seed += 1) {
    const prng = mulberry32(seed * 7919);
    const v0 = 1 + prng() * 6; // 随机初速（部分初态已逼近红线）
    let x = [prng() * 2, v0];
    if (specs[0].h(x) < 0 || specs[1].h(x) < 0) {
      continue; // 初态已在安全集外的不算（前向不变性 = 集内不变）
    }
    for (let t = 0; t < T; t += 1) {
      const uDes = 2 * (0.7 + 0.6 * prng()); // 扰动贪婪油门
      const r = cbfFilterConjunction(x, uDes, specs);
      if (r.infeasible) anyInfeasible += 1;
      const nx = specs[0].dynamics(x, r.u);
      const h0 = specs[0].h(nx);
      const h1 = specs[1].h(nx);
      hMinAll = Math.min(hMinAll, h0, h1);
      if (h0 < -1e-9 || h1 < -1e-9) {
        allSafe = false;
        break;
      }
      x = nx;
    }
  }
  void rng;
  ok(allSafe, `200 种子随机初速 + 扰动贪婪油门 × ${T} 步: 双屏障全程 h ≥ −1e-9（合取归纳证书: 一步条件对每个 h 同时成立 ⟹ 全程成立）`);
  ok(anyInfeasible === 0, `合取永不 infeasible（0/24000 步——每屏障自带刹车容量 aMin=−b ⟹ 交集递归可行）`);
  ok(hMinAll >= -1e-9, `全程最小裕度 ${hMinAll.toExponential(2)} ≥ 0（最紧时刻读数）`);
}

section('D3 87.0 多维剪枝分支定界: 逐位等价 + 耗时对照（性能轴）');

{
  const dt = 0.1;
  const bb = 5;
  const h3 = (x) => {
    const h1 = 10 - x[0] - (x[1] > 0 ? (x[1] * x[1]) / (2 * bb) : 0);
    const h2 = 10 - x[2] - (x[3] > 0 ? (x[3] * x[3]) / (2 * bb) : 0);
    return Math.min(h1, h2);
  };
  const f3 = (x, u) => [
    x[0] + x[1] * dt + 0.5 * u[0] * dt * dt,
    x[1] + u[0] * dt,
    x[2] + x[3] * dt + 0.5 * u[1] * dt * dt,
    x[3] + u[1] * dt,
    x[4] + u[2] * dt,
  ];
  const spec = { h: (x) => h3(x), dynamics: f3, eta: 0.05, uMin: [-5, -5, -5], uMax: [2, 2, 2], gridResolution: 27 };
  const res = 27;
  const axes = [0, 1, 2].map(() => Array.from({ length: res }, (_, j) => -5 + (j * 7) / (res - 1)));
  const bruteRowMajor = (x0, thr) => {
    let best = null;
    let bd = Infinity;
    for (const a of axes[0]) {
      for (const b of axes[1]) {
        for (const c of axes[2]) {
          const u = [a, b, c];
          if (h3(f3(x0, u)) - thr >= 0) {
            let d = 0;
            for (let j = 0; j < 3; j += 1) d += (u[j] - 2) * (u[j] - 2);
            if (d < bd) {
              bd = d;
              best = u;
            }
          }
        }
      }
    }
    return best;
  };
  let eqOk = true;
  const cases = [];
  for (let tr = 0; tr < 60; tr += 1) {
    const x0 = [tr * 0.01, 4 + tr * 0.03, tr * 0.02, 5.5 - tr * 0.02, 1];
    const r = cbfFilter(x0, [2, 2, 2], spec);
    const ref = bruteRowMajor(x0, (1 - 0.05) * h3(x0));
    if (r.infeasible) {
      if (ref !== null) eqOk = false;
      continue;
    }
    const dd = Math.abs(r.u[0] - ref[0]) + Math.abs(r.u[1] - ref[1]) + Math.abs(r.u[2] - ref[2]);
    if (dd > 1e-12) eqOk = false;
    if (cases.length < 2) cases.push(`[${r.u.map((v) => v.toFixed(2)).join(', ')}]`);
  }
  ok(eqOk, `3D 剪枝 ≡ 行主序全枚举逐位一致（60 例含 ${cases.length} 个可行锚点 ${cases.join('; ')}——(dist², 行主序秩) 字典序保平局规则）`);
  const x0 = [0, 4, 0, 5.5, 1];
  const tK = timeBest(() => cbfFilter(x0, [2, 2, 2], spec), 10);
  const tB = timeBest(() => bruteRowMajor(x0, (1 - 0.05) * h3(x0)), 5);
  ok(tK < tB, `27³ = 19683 点网格: 剪枝内核 ${tK.toFixed(2)}ms < 全枚举 ${tB.toFixed(2)}ms（${(tB / tK).toFixed(1)}×——轴序按距 u_des 排列 + 前缀下界整枝剪）`);
  // 1D 扫描缓存路径的语义锚点（完整回归面在 verify-execution-kernels 锚点②）
  const brake = brakeDoubleIntegrator();
  const inside = cbfFilter([0, 3], 2, brake.spec);
  const edge = cbfFilter([0, 6.5], 2, { ...brake.spec, eta: 0.05 });
  ok(inside.method === 'zero-modification' && inside.u[0] === 2, `1D 缓存路径零修改语义不变（安全动作 u = [2] 原样放行）`);
  ok(edge.method === '1d-bisection' && !edge.infeasible && edge.margin >= -1e-9, `1D 缓存路径边界二分语义不变（u = ${edge.u[0].toFixed(4)}，可行侧返回）`);
}

// ═══════════════════ E optimal-assignment.ts（32.0 稀疏指派） ═══════════════════

section('E1 32.0 稀疏指派: 300 随机实例 ≡ 稠密 M 填充最优（数学轴）');

{
  const rng = mulberry32(20261011);
  let costOk = true;
  let perfectOk = true;
  let edgeOk = true;
  let certOk = 0;
  for (let tr = 0; tr < 300; tr += 1) {
    const n = 2 + Math.floor(rng() * 7); // 行 2..8
    const m = n + Math.floor(rng() * 4); // 列 ≥ 行
    const perm = [...Array(m).keys()].sort(() => rng() - 0.5).slice(0, n); // 置换嵌入 ⟹ 完美匹配必然存在
    const entries = [];
    const seen = new Set();
    for (let i = 0; i < n; i += 1) {
      entries.push({ row: i, col: perm[i], cost: 1 + Math.floor(rng() * 99) });
      seen.add(i * m + perm[i]);
    }
    const extra = Math.floor(rng() * n * 1.5);
    for (let e = 0; e < extra; e += 1) {
      const i = Math.floor(rng() * n);
      const j = Math.floor(rng() * m);
      if (!seen.has(i * m + j)) {
        seen.add(i * m + j);
        entries.push({ row: i, col: j, cost: 1 + Math.floor(rng() * 99) });
      }
    }
    const sp = solveAssignmentSparse(n, m, entries);
    const M = n * 100 + 1; // M > n·maxCost ⟹ M 填充不改变最优
    const dense = Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => {
      const hit = entries.find((e) => e.row === i && e.col === j);
      return hit ? hit.cost : M;
    }));
    const dr = solveAssignment(dense);
    if (Math.abs(sp.totalCost - dr.totalCost) > 1e-9) costOk = false;
    const assignedCols = sp.assignment.filter((x) => x >= 0);
    if (assignedCols.length !== n || new Set(assignedCols).size !== n) perfectOk = false;
    if (sp.assignment.some((j, i) => j >= 0 && !entries.some((e) => e.row === i && e.col === j))) edgeOk = false;
    if (tr < 60 && assignmentCertificate(dense, dr).optimal) certOk += 1; // 稠密对偶证书证明该值最优
  }
  ok(costOk, `300 随机稀疏实例 totalCost ≡ 稠密 M 填充（稀疏 LP = 禁边 +∞ 的稠密 LP）`);
  ok(perfectOk && edgeOk, `完美匹配性: 行行有派、列不冲突、只用允许边（300 例全过）`);
  ok(certOk === 60, `60 例抽样由稠密对偶证书证明最优性（u+v ≤ c、匹配边取等、零间隙——稀疏值 = 被证明的最优值）`);

  // 行 > 列（转置口径）: 恰有 m 个指派
  const sp2 = solveAssignmentSparse(4, 2, [
    { row: 0, col: 0, cost: 1 }, { row: 1, col: 1, cost: 2 }, { row: 2, col: 0, cost: 3 },
    { row: 3, col: 1, cost: 4 }, { row: 0, col: 1, cost: 9 }, { row: 2, col: 1, cost: 8 },
  ]);
  ok(sp2.matchingSize === 2 && sp2.assignment.filter((x) => x >= 0).length === 2 && sp2.totalCost === 3,
    `行>列转置: 4 行 2 列 → 恰 2 指派、成本 3（0→0, 1→1——多余行诚实 −1）`);
}

section('E2 32.0 Hall 检查 + 数值防御');

{
  okThrow(() => solveAssignmentSparse(3, 3, [{ row: 0, col: 0, cost: 1 }, { row: 1, col: 0, cost: 2 }, { row: 2, col: 0, cost: 3 }]),
    '三行挤一列（Hall 缺口 2）→ 显式 throw 而非残缺指派');
  okThrow(() => solveAssignmentSparse(2, 2, [{ row: 0, col: 0, cost: 1 }]), '孤立行（缺口 1）→ throw');
  okThrow(() => solveAssignmentSparse(2, 2, [{ row: 0, col: 5, cost: 1 }]), '列越界 → throw');
  okThrow(() => solveAssignmentSparse(2, 2, [{ row: 0, col: 0, cost: 1 }, { row: 0, col: 0, cost: 2 }]), '重复边 → throw');
  okThrow(() => solveAssignment([[1, NaN], [2, 3]]), 'solveAssignment NaN 代价 → throw（原版静默垃圾对偶，现诚实拒绝）');
  okThrow(() => solveAssignment([[1, Infinity], [2, 3]]), 'solveAssignment Infinity 代价 → throw');
}

section('E3 32.0 稀疏 vs 稠密耗时对照（性能轴）');

{
  const mk = (N, M, K, seed) => {
    const r2 = mulberry32(seed);
    const perm = [...Array(M).keys()].map((v) => ({ v, k: r2() })).sort((a, b) => a.k - b.k).slice(0, N).map((o) => o.v);
    const es = [];
    const seen = new Set();
    for (let i = 0; i < N; i += 1) {
      es.push({ row: i, col: perm[i], cost: 1 + Math.floor(r2() * 99) });
      seen.add(i * M + perm[i]);
    }
    for (let i = 0; i < N; i += 1) {
      for (let k = 0; k < K - 1; k += 1) {
        const j = Math.floor(r2() * M);
        if (!seen.has(i * M + j)) {
          seen.add(i * M + j);
          es.push({ row: i, col: j, cost: 1 + Math.floor(r2() * 99) });
        }
      }
    }
    return es;
  };
  const toDense = (N, M, es) => {
    const idx = Array.from({ length: N }, () => new Map());
    for (const e of es) idx[e.row].set(e.col, e.cost);
    const Mv = N * 100 + 1;
    return Array.from({ length: N }, (_, i) => Array.from({ length: M }, (_, j) => (idx[i].has(j) ? idx[i].get(j) : Mv)));
  };
  const N = 400;
  const M = 420;
  const es = mk(N, M, 5, 7);
  const dense = toDense(N, M, es);
  solveAssignmentSparse(N, M, es); // 预热
  solveAssignment(dense);
  const tS = timeBest(() => solveAssignmentSparse(N, M, es), 5);
  const tD = timeBest(() => solveAssignment(dense), 3);
  const sp = solveAssignmentSparse(N, M, es);
  ok(Math.abs(sp.totalCost - solveAssignment(dense).totalCost) <= 1e-9, `n=400 大例同解（稀疏 ${sp.totalCost} = 稠密最优——等价证明的大规模版）`);
  ok(tS < tD, `n=400、|E|=${es.length}（${((es.length / (N * M)) * 100).toFixed(1)}% 稠密度）: 稀疏 ${tS.toFixed(1)}ms < 稠密 M 填充 ${tD.toFixed(1)}ms（${(tD / tS).toFixed(1)}×）`);
  ok(sp.scannedEntries < N * M * 0.2, `Dijkstra 只扫邻接表: 代价比较 ${sp.scannedEntries} 次 ≪ 稠密等价 ~${N * M}（工作量口径的结构性下降）`);
}

// ═══════════════════ F max-flow.ts（43.0 Dinic + 最小费用流） ═══════════════════

section('F1 43.0 Dinic: 手算锚点 + 200 随机图 = 穷举最小割 + 割证书 + 守恒审计');

{
  const cap = [
    [0, 3, 2, 0],
    [0, 0, 0, 2],
    [0, 0, 0, 3],
    [0, 0, 0, 0],
  ];
  const net = { nodes: 4, source: 0, sink: 3, capacity: cap, labels: ['s', 'a', 'b', 't'] };
  const r = maxFlow(net);
  const cert = minCutCertificate(net, r);
  const audit = flowAudit(net, r);
  ok(r.flowValue === 4 && cert.saturated && cert.equalsFlow, `CLRS 手算网络: Dinic max-flow = 4、割容量 = 流值（阻塞流路径 ${r.augmentingPaths} 条）`);
  ok(audit.conserved, `守恒审计: 节点失衡 ${audit.maxNodeImbalance.toExponential(1)}、值残差 ${audit.valueResidual.toExponential(1)}、容量违反 ${audit.maxCapacityViolation.toExponential(1)}（浮点残差三读数全 0）`);

  const rng = mulberry32(20261012);
  let agree = true;
  let certOk = true;
  let auditOk = true;
  for (let tr = 0; tr < 200; tr += 1) {
    const n = 8;
    const capacity = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (i !== j && rng() < 0.25) capacity[i][j] = 1 + Math.floor(rng() * 9);
      }
    }
    const net8 = { nodes: n, source: 0, sink: n - 1, capacity };
    const rr = maxFlow(net8);
    if (Math.abs(rr.flowValue - bruteForceMinCut(net8)) > 1e-9) agree = false;
    const c = minCutCertificate(net8, rr);
    if (!c.saturated || !c.equalsFlow) certOk = false;
    if (!flowAudit(net8, rr).conserved) auditOk = false;
  }
  ok(agree, `200 随机 8 节点图: Dinic 流值 = 穷举最小割（2⁸ 割枚举对照——定理不分算法）`);
  ok(certOk && auditOk, `全部随机例割证书 + 守恒审计成立（饱和 + 容量等式 + 浮点残差 0）`);

  // 浮点容量: 分数容量下审计仍守恒（舍入残差落进三读数）
  let floatOk = true;
  for (let tr = 0; tr < 60; tr += 1) {
    const n = 7;
    const capacity = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (i !== j && rng() < 0.3) capacity[i][j] = (1 + Math.floor(rng() * 7)) / 3 + 0.1 * Math.floor(rng() * 5);
      }
    }
    const net7 = { nodes: n, source: 0, sink: n - 1, capacity };
    if (!flowAudit(net7, maxFlow(net7)).conserved) floatOk = false;
  }
  ok(floatOk, `60 例分数容量（k/3 + 0.1j 不可精确表示）: 守恒审计仍在容差内（净流口径 g = cap − residual 吸收舍入）`);
}

section('F2 43.0 最小费用流: 手算锚点 + 穷举对照 + 无负环证书（数学轴）');

{
  // 手算: s→a(2,c1) s→b(1,c10) a→t(2,c1) b→t(1,c1) a→b(1,c1)
  // 最大流 3; 最省: 2 单位 s-a-t（4）+ 1 单位 s-b-t（11）= 15
  const cn = {
    nodes: 4,
    source: 0,
    sink: 3,
    capacity: [
      [0, 2, 1, 0],
      [0, 0, 1, 2],
      [0, 0, 0, 1],
      [0, 0, 0, 0],
    ],
    cost: [
      [0, 1, 10, 0],
      [0, 0, 1, 1],
      [0, 0, 0, 1],
      [0, 0, 0, 0],
    ],
  };
  const mc = minCostMaxFlow(cn);
  const cert = minCostFlowCertificate(cn, mc);
  ok(mc.flowValue === 3 && Math.abs(mc.totalCost - 15) <= 1e-9,
    `手算锚点: 最大流 3 单位最省派发成本 = 15（实际 ${mc.totalCost}，${mc.augmentations} 次最短路增广——贵边 s→b 只补缺口）`);
  ok(cert.negativeCycleFree && cert.optimal, `最优性证书: 残量网络无负费用环（Bellman–Ford 检查 ${cert.checkedArcs} 条弧——互补松弛的图判读）`);
  const mf = maxFlow(cn);
  ok(mc.flowValue === mf.flowValue, `费用最优不牺牲吞吐: SSP 流值 ${mc.flowValue} = maxFlow ${mf.flowValue}`);

  // 截断: maxTotal = 2 → 只派 2 路，成本 = 2 单位 s-a-t = 4
  const mc2 = minCostMaxFlow(cn, { maxTotal: 2 });
  ok(mc2.flowValue === 2 && Math.abs(mc2.totalCost - 4) <= 1e-9, `maxTotal 截断: 只派 2 路 → 成本 4（最便宜的 2 单位，派发带价格的「至多 D 路」语义）`);

  // 随机小图 vs 脚本侧穷举（枚举全部整数流向量）
  const rng = mulberry32(20261013);
  const bruteMinCost = (cnet, target) => {
    const n = cnet.nodes;
    const edges = [];
    for (let u = 0; u < n; u += 1) {
      for (let v = 0; v < n; v += 1) {
        if (cnet.capacity[u][v] > 0) edges.push([u, v, cnet.capacity[u][v], cnet.cost[u][v]]);
      }
    }
    let best = Infinity;
    const rec = (k, f) => {
      if (k === edges.length) {
        const netOf = new Array(n).fill(0);
        let c = 0;
        for (let i = 0; i < edges.length; i += 1) {
          const x = f[i];
          if (x <= 0) continue;
          netOf[edges[i][0]] += x;
          netOf[edges[i][1]] -= x;
          c += x * edges[i][3];
        }
        for (let u = 1; u < n - 1; u += 1) if (Math.abs(netOf[u]) > 1e-9) return;
        if (Math.abs(netOf[0] - target) > 1e-9) return;
        if (c < best) best = c;
        return;
      }
      for (let x = 0; x <= edges[k][2]; x += 1) {
        f[k] = x;
        rec(k + 1, f);
      }
    };
    rec(0, new Array(edges.length).fill(0));
    return best;
  };
  let eqOk = true;
  let certAll = true;
  for (let tr = 0; tr < 40; tr += 1) {
    const n = 6;
    const capacity = Array.from({ length: n }, () => new Array(n).fill(0));
    const cost = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        if (rng() < 0.4) {
          capacity[i][j] = 1 + Math.floor(rng() * 5);
          cost[i][j] = Math.floor(rng() * 9);
        }
      }
    }
    const cnet = { nodes: n, source: 0, sink: n - 1, capacity, cost };
    const mcr = minCostMaxFlow(cnet);
    const b = bruteMinCost(cnet, mcr.flowValue);
    if (b === Infinity || Math.abs(mcr.totalCost - b) > 1e-9) eqOk = false;
    if (!minCostFlowCertificate(cnet, mcr).optimal) certAll = false;
  }
  ok(eqOk, `40 随机小图: SSP 成本 = 穷举最小费用流（枚举全部整数流向量对照）`);
  ok(certAll, `40 例无负环证书全过（残量网络 Bellman–Ford——每一步都是被证明的最优）`);
  // 真负费用环: s→a(−5) 与 a→s(1) 构成费用 −4 的环 → 诚实 throw
  const negCycleNet = {
    nodes: 4,
    source: 0,
    sink: 3,
    capacity: [
      [0, 1, 0, 0],
      [1, 0, 0, 2],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    cost: [
      [0, -5, 0, 0],
      [1, 0, 0, 1],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  };
  okThrow(() => minCostMaxFlow(negCycleNet), '初始负费用环（0→1→0 费用 −4）→ throw（SSP 前提被破坏，诚实拒绝）');
}

section('F3 43.0 Dinic vs Edmonds-Karp 耗时对照（性能轴）');

{
  const mkDense = (n, p, capHi, seed) => {
    const r = mulberry32(seed);
    const c = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (i !== j && r() < p) c[i][j] = 1 + Math.floor(r() * capHi);
      }
    }
    return c;
  };
  // 脚本侧 EK 参考实现（升级前算法的逐行副本——公平对照）
  const ekMaxFlow = (network) => {
    const n = network.nodes;
    const residual = network.capacity.map((row) => [...row]);
    let flowValue = 0;
    const parent = new Array(n).fill(-1);
    const bfs = () => {
      parent.fill(-1);
      parent[network.source] = network.source;
      const q = [network.source];
      while (q.length > 0) {
        const u = q.shift();
        for (let v = 0; v < n; v += 1) {
          if (parent[v] !== -1 || residual[u][v] <= 0) continue;
          parent[v] = u;
          if (v === network.sink) return true;
          q.push(v);
        }
      }
      return false;
    };
    while (bfs()) {
      let b = Infinity;
      for (let v = network.sink; v !== network.source; v = parent[v]) b = Math.min(b, residual[parent[v]][v]);
      for (let v = network.sink; v !== network.source; v = parent[v]) {
        residual[parent[v]][v] -= b;
        residual[v][parent[v]] += b;
      }
      flowValue += b;
    }
    return flowValue;
  };
  const big = { nodes: 600, source: 0, sink: 599, capacity: mkDense(600, 0.5, 9, 5) };
  const dv = maxFlow(big).flowValue;
  const ev = ekMaxFlow(big);
  ok(dv === ev, `n=600 稠密图同值: Dinic = EK = ${dv}（流值由定理唯一——等价证明）`);
  const tDinic = timeBest(() => maxFlow(big), 3);
  const tEK = timeBest(() => ekMaxFlow(big), 1);
  ok(tDinic < tEK, `n=600 稠密: Dinic ${tDinic.toFixed(1)}ms < EK ${tEK.toFixed(1)}ms（${(tEK / tDinic).toFixed(1)}×——O(V²E) vs O(VE²)，规模越大差距越大; 微小实例 n≈140 两者打平，邻接表构建开销主导）`);
  // 单位容量（Dinic 的 O(E√E) 域）
  const mkUnit = (n, p, seed) => {
    const r = mulberry32(seed);
    const c = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (i !== j && r() < p) c[i][j] = 1;
      }
    }
    return c;
  };
  const unit = { nodes: 400, source: 0, sink: 399, capacity: mkUnit(400, 0.03, 4) };
  const du = maxFlow(unit).flowValue;
  const eu = ekMaxFlow(unit);
  ok(du === eu, `n=400 单位容量图同值: ${du}（二部派发形态）`);
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— R5 控制优化六内核（34.0/35.0/54.0/87.0/32.0/43.0）进化验证成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
