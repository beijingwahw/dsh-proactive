/**
 * verify-prophet-kernels.mjs — 26.0→30.0「先知层」五内核纯数学离线验证
 *
 * 每个内核的数学核心都有解析解对照（不是「能跑」，是「算得对」）：
 *   26.0 高斯过程：训练点恢复（含噪 GP 后验 ≈ 观测）、线性函数插值
 *        误差 < 5e-3、外推不确定度 > 内插不确定度、EI 解析式 vs
 *        蒙特卡洛（1e5 样本，偏差 < 2%）、贝叶斯优化定位已知最优
 *        （|x̂ − x*| < 0.05）、序列校准器收敛到常数比值
 *   27.0 卡尔曼滤波：随机游走 Riccati 迭代收敛到闭式
 *        P∞ = (q+√(q²+4qr))/2（误差 < 1e-6）、χ² 分位数表精确值 +
 *        Wilson-Hilferty 对照（df=5: 11.070）、常数序列 level 收敛 /
 *        斜率归零、斜坡序列 slope ≈ 梯度、10σ 突变 NIS 门控触发 /
 *        稳态不触发、RTS 平滑的首点斜率比纯滤波更接近真值
 *   28.0 极值理论：指数样本 GPD ξ̂ ≈ 0 且 p99 外推 ≈ 解析分位数
 *        −θln(0.01)（<8%）、Pareto(α=3) Hill α̂ ≈ 3、GPD Cdf 精确
 *        恒等式 cdf(σ(2^ξ−1)/ξ) = 0.5、VaR 单调、bootstrap CI 有序
 *   29.0 MCTS：确定性三臂收敛最优（visits 排序 = 价值排序）、折扣
 *        语义（γ=0.5 选快赢 0.6、γ=1 选远优 0.9）、伯努利两臂 3000
 *        迭代均值估计 < 0.1 误差、同种子逐位复现、渐进加宽树尺寸
 *        受限
 *   30.0 次模优化：随机次模性审计 0 违反、惰性贪心与朴素贪心逐位
 *        同解、n=10/k=3 穷举对照贪心 ≥ (1−1/e)·OPT、冗余第二选
 *        边际 (1−c)·w < 互补项 w、曲率保证因子 ∈ [1−1/e, 1]
 *
 * 全部断言确定性（随机处用 mulberry32 种子，内核与脚本共用实现）。
 * 运行：npm run build && node scripts/verify-prophet-kernels.mjs
 */

import {
  GaussianProcess,
  GpSeriesCalibrator,
  expectedImprovement,
  BayesianOptimizer,
  normalCdf,
  choleskyLower,
} from '../dist/index.mjs';
import {
  KalmanFilter,
  LocalLinearTrendFilter,
  randomWalkSteadyState,
  chiSquareQuantile,
} from '../dist/index.mjs';
import {
  TailRiskMonitor,
  hillEstimator,
  fitGpd,
  gpdCdf,
  potQuantiles,
  empiricalQuantile,
  mulberry32,
} from '../dist/index.mjs';
import { UctSearch } from '../dist/index.mjs';
import {
  WeightedCoverage,
  coverageFromTokens,
  lazyGreedy,
  bruteForceBest,
  submodularityCheck,
  curvatureEstimate,
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
function near(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}
function section(title) {
  console.log(`\n■ ${title}`);
}

// ═══════════════════════════ 26.0 高斯过程 ═══════════════════════════

section('26.0 高斯过程内核');

{
  // 线性函数 y = 2x + 1 的稠密插值：RBF GP 应几乎精确恢复
  const gp = new GaussianProcess({ sigmaN: 1e-4, tuneHyperparams: true });
  const xs = Array.from({ length: 13 }, (_, i) => i / 12);
  const ys = xs.map((x) => 2 * x + 1);
  const fit = gp.fit(xs, ys);
  ok(fit !== undefined && fit.points === 13, `拟合 13 点（LML=${fit ? fit.logMarginalLikelihood.toFixed(1) : '—'}）`);
  let maxErr = 0;
  for (const x of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    const p = gp.predict(x);
    maxErr = Math.max(maxErr, Math.abs(p.mean - (2 * x + 1)));
  }
  ok(maxErr < 5e-3, `线性插值误差 < 5e-3（实际 ${maxErr.toExponential(2)}）`);
  const atTrain = gp.predict(0.5);
  ok(Math.abs(atTrain.mean - 2) < 1e-3, `训练点后验恢复观测（|μ−y| = ${Math.abs(atTrain.mean - 2).toExponential(2)}）`);
  const nearData = gp.predict(0.3);
  const farData = gp.predict(3.5);
  ok(farData.std > nearData.std, `外推不确定度 > 内插不确定度（${farData.std.toFixed(3)} > ${nearData.std.toFixed(3)}）`);
}

{
  // Cholesky：A = L·Lᵀ 精确重建
  const A = [
    [2.0, 0.3, 0.1],
    [0.3, 1.5, 0.2],
    [0.1, 0.2, 1.1],
  ];
  const { L } = choleskyLower(A);
  let maxErr = 0;
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      let s = 0;
      for (let k = 0; k <= Math.min(i, j); k += 1) s += L[i][k] * L[j][k];
      maxErr = Math.max(maxErr, Math.abs(s - A[i][j]));
    }
  }
  ok(maxErr < 1e-12, `Cholesky 重建 A = L·Lᵀ（误差 ${maxErr.toExponential(2)}）`);
}

{
  // EI 解析式 vs 蒙特卡洛（1e5 样本）
  const mu = 0.3;
  const sigma = 0.45;
  const best = 0.1;
  const eiAna = expectedImprovement(mu, sigma, best, 0.01);
  const rng = mulberry32(42);
  // Box-Muller 正态采样
  const gauss = () => {
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  let acc = 0;
  const N = 100_000;
  for (let i = 0; i < N; i += 1) acc += Math.max(0, mu + sigma * gauss() - best - 0.01);
  const eiMc = acc / N;
  ok(Math.abs(eiAna - eiMc) / eiMc < 0.02, `EI 解析 ${eiAna.toFixed(4)} ≈ MC ${eiMc.toFixed(4)}（偏差 < 2%）`);
  ok(near(normalCdf(1.959964), 0.975, 1e-4), 'normalCdf(1.96) = 0.975');
}

{
  // 贝叶斯优化定位已知最优：f(x) = 1 − (x−0.37)²（GP 噪声由 sigmaN 吸收）
  const f = (x) => 1 - (x - 0.37) ** 2;
  const bo = new BayesianOptimizer({ sigmaN: 0.02 });
  const candidates = Array.from({ length: 41 }, (_, i) => i / 40);
  bo.observe(0, f(0));
  bo.observe(0.6, f(0.6));
  for (let round = 0; round < 8; round += 1) {
    const s = bo.suggest(candidates);
    if (!s) break;
    bo.observe(s.x, f(s.x));
  }
  const { bestX } = bo.state;
  ok(bestX !== undefined && Math.abs(bestX - 0.37) < 0.03, `BO 定位最优 x*≈0.37（bestX=${bestX?.toFixed(3)}）`);
}

{
  // 序列校准器：常数比值 1.25 → 修正因子收敛 1.25；早期 < minPoints → 不修正
  const cal = new GpSeriesCalibrator({ minPoints: 6, maxPoints: 32 });
  const t0 = 1_000_000;
  for (let i = 0; i < 12; i += 1) cal.push(t0 + i * 60_000, 1.25);
  const c = cal.predictAt(t0 + 12 * 60_000);
  ok(c !== undefined && near(c.factor, 1.25, 0.05), `常数比值修正收敛 1.25（factor=${c ? c.factor.toFixed(3) : '—'}）`);
  const fresh = new GpSeriesCalibrator({ minPoints: 6 });
  for (let i = 0; i < 5; i += 1) fresh.push(t0 + i * 60_000, 2.0);
  ok(fresh.predictAt(t0) === undefined, '校准史不足 minPoints → 先验无知不修正（零漂移）');
}

// ═══════════════════════════ 27.0 卡尔曼滤波 ═══════════════════════════

section('27.0 卡尔曼滤波内核');

{
  // 随机游走稳态：Riccati 迭代收敛到闭式 P∞ = (q+√(q²+4qr))/2
  const q = 0.01;
  const r = 0.25;
  const { pInf, kInf } = randomWalkSteadyState(q, r);
  const f = new KalmanFilter({ F: [[1]], H: [[1]], Q: [[q]], R: [[r]], x0: [0], P0: [[1]] });
  const rng = mulberry32(99);
  for (let i = 0; i < 400; i += 1) f.step(rng() - 0.5);
  const pConv = f.covariance[0][0];
  ok(near(pConv, pInf, 1e-6), `Riccati 收敛闭式：P∞=${pInf.toFixed(6)}，迭代=${pConv.toFixed(6)}`);
  // 稳态增益：K = P∞/(P∞+r)
  const kConv = pConv / (pConv + r);
  ok(near(kConv, kInf, 1e-6), `稳态增益 K∞=${kInf.toFixed(6)}（迭代 ${kConv.toFixed(6)}）`);
}

{
  // χ² 分位数：表值精确 + Wilson-Hilferty 近似对照
  ok(near(chiSquareQuantile(0.95, 1), 3.8415, 1e-3), 'χ²(1,0.95) = 3.8415');
  ok(near(chiSquareQuantile(0.99, 1), 6.6349, 1e-3), 'χ²(1,0.99) = 6.6349');
  ok(near(chiSquareQuantile(0.997, 1), 8.8097, 5e-3), 'χ²(1,0.997) = 8.8097（NIS 门控缺省阈值）');
  ok(near(chiSquareQuantile(0.95, 2), 5.9915, 1e-3), 'χ²(2,0.95) = 5.9915');
  ok(near(chiSquareQuantile(0.95, 5), 11.070, 0.05), 'χ²(5,0.95) ≈ 11.070（W-H 近似）');
}

{
  // 局部线性趋势：常数序列 level 收敛 / slope 归零；斜坡 slope ≈ 梯度
  const flat = new LocalLinearTrendFilter();
  for (let i = 0; i < 120; i += 1) flat.observe(0.8);
  const fr = flat.lastRead;
  ok(Math.abs(fr.level - 0.8) < 0.01 && Math.abs(fr.slope) < 0.005, `常数序列：level=${fr.level.toFixed(4)}，slope=${fr.slope.toExponential(2)}`);
  ok(!fr.gated, '稳态观测不触发门控');

  const ramp = new LocalLinearTrendFilter();
  for (let i = 0; i < 200; i += 1) ramp.observe(0.5 + 0.002 * i);
  const rr = ramp.lastRead;
  ok(Math.abs(rr.slope - 0.002) < 0.0005, `斜坡序列：slope=${rr.slope.toFixed(5)} ≈ 0.002`);

  // RTS 平滑：斜坡首点斜率比纯滤波更接近真值（未来信息回灌）
  const smoothed = ramp.smooth();
  const filteredSlopeAt10 = rampFilterSlopeAt(ramp, 10);
  ok(Math.abs(smoothed[10].slope - 0.002) <= Math.abs(filteredSlopeAt10 - 0.002) + 1e-6,
    `RTS 平滑首段斜率误差 ≤ 滤波（平滑 ${Math.abs(smoothed[10].slope - 0.002).toFixed(5)} vs 滤波 ${Math.abs(filteredSlopeAt10 - 0.002).toFixed(5)}）`);

  // 突变门控：稳态后 10σ 跳变必触发
  const jump = new LocalLinearTrendFilter();
  for (let i = 0; i < 80; i += 1) jump.observe(0.5);
  const jumped = jump.observe(0.9);
  ok(jumped.gated, `10σ 突变 NIS 门控触发（NIS=${jumped.nis.toFixed(1)} > ${jumped.threshold.toFixed(1)}）`);
}
function rampFilterSlopeAt(filter, idx) {
  // 重建：smoothing 依赖内部历史——这里用独立滤波器重放前 idx+1 点取滤波斜率
  const ref = new LocalLinearTrendFilter();
  for (let i = 0; i <= idx; i += 1) ref.observe(0.5 + 0.002 * i);
  return ref.lastRead.slope;
}

// ═══════════════════════════ 28.0 极值理论 ═══════════════════════════

section('28.0 极值理论内核');

{
  // 指数样本（θ=1000ms）：GPD ξ̂≈0，p99 外推 ≈ −θ·ln(0.01)=4605
  const rng = mulberry32(2026);
  const theta = 1000;
  const n = 3000;
  const samples = Array.from({ length: n }, () => -theta * Math.log(Math.max(1e-12, rng())));
  const u = empiricalQuantile(samples, 0.9);
  const ys = samples.filter((x) => x > u).map((x) => x - u);
  const gpd = fitGpd(ys);
  ok(gpd !== undefined && Math.abs(gpd.xi) < 0.15, `指数尾：ξ̂ = ${gpd ? gpd.xi.toFixed(3) : '—'} ≈ 0`);
  const q99 = potQuantiles(gpd, n, ys.length, u, 0.99);
  const exact99 = -theta * Math.log(0.01);
  ok(Math.abs(q99.varP - exact99) / exact99 < 0.08, `p99 外推 ${Math.round(q99.varP)} ≈ 解析 ${Math.round(exact99)}（误差 < 8%）`);
}

{
  // Pareto(α=3, xm=1000)：Hill α̂ ≈ 3；GPD ξ̂ ≈ 1/3
  const rng = mulberry32(31);
  const alpha = 3;
  const xm = 1000;
  const samples = Array.from({ length: 4000 }, () => xm * Math.pow(1 - rng(), -1 / alpha));
  const hill = hillEstimator(samples, 400);
  ok(hill !== undefined && Math.abs(hill.alpha - alpha) < 0.5, `Pareto Hill：α̂ = ${hill ? hill.alpha.toFixed(2) : '—'} ≈ 3`);
  const u = empiricalQuantile(samples, 0.9);
  const ys = samples.filter((x) => x > u).map((x) => x - u);
  const gpd = fitGpd(ys);
  ok(gpd !== undefined && Math.abs(gpd.xi - 1 / alpha) < 0.15, `Pareto GPD：ξ̂ = ${gpd ? gpd.xi.toFixed(3) : '—'} ≈ ${(1 / alpha).toFixed(3)}`);
}

{
  // GPD CDF 精确恒等式：y = σ(2^ξ − 1)/ξ 处 cdf = 0.5
  const xi = 0.3;
  const sigma = 1000;
  const yHalf = (sigma * (Math.pow(2, xi) - 1)) / xi;
  ok(near(gpdCdf(yHalf, xi, sigma), 0.5, 1e-9), 'GPD CDF 恒等式：cdf(σ(2^ξ−1)/ξ) = 0.5');
}

{
  // TailRiskMonitor：p999 ≥ p99、CI 有序、Hill 只在重尾出现
  const rng = mulberry32(77);
  // 对数正态体 + Pareto 尾（重尾混合）
  const gauss = () => {
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const monitor = new TailRiskMonitor({ minExceedances: 30, bootstrap: 120 });
  for (let i = 0; i < 1500; i += 1) {
    const heavy = rng() < 0.04;
    monitor.observe(heavy ? 5000 * Math.pow(1 - rng(), -1 / 2.5) : Math.exp(6 + gauss()));
  }
  const rep = monitor.fit();
  ok(rep !== undefined, `拟合成功（${rep ? rep.exceedances : 0} 超出量 / ${rep ? rep.samples : 0} 样本）`);
  ok(rep.p999 > rep.p99, `VaR 单调：p99=${Math.round(rep.p99)} < p999=${Math.round(rep.p999)}`);
  ok(rep.p999Ci === undefined || rep.p999Ci.lower <= rep.p999Ci.upper, 'bootstrap CI 有序 lower ≤ upper');
  ok(rep.hill !== undefined, `重尾样本 Hill 估计在场（α̂=${rep.hill ? rep.hill.alpha.toFixed(2) : '—'}）`);
}

// ═══════════════════════════ 29.0 蒙特卡洛树搜索 ═══════════════════════════

section('29.0 蒙特卡洛树搜索内核');

{
  // 确定性三臂（一步终局）：奖励 0.9/0.5/0.1
  const domain = {
    actions: () => ['a', 'b', 'c'],
    step: (_s, action) => ({ state: 'T', reward: { a: 0.9, b: 0.5, c: 0.1 }[action], terminal: true }),
  };
  const res = new UctSearch({ seed: 5 }, domain).search('root', { iterations: 800 });
  ok(res.bestAction === 'a', `确定性三臂收敛最优（best=${res.bestAction}）`);
  const visits = Object.fromEntries(res.children.map((c) => [c.action, c.visits]));
  ok(visits.a > visits.b && visits.b > visits.c, `访问排序 = 价值排序（a=${visits.a} > b=${visits.b} > c=${visits.c}）`);
  ok(Math.abs(res.children.find((c) => c.action === 'a').meanValue - 0.9) < 1e-9, '确定性臂均值 = 真值 0.9（终局本地回报）');
}

{
  // 折扣语义：quick 即时 0.6 vs slow 两步后 0.9
  const mkDomain = () => ({
    actions: (s) => (s === 's2' ? [] : ['quick', 'slow']),
    step: (s, a) => {
      if (a === 'quick') return { state: 'done', reward: 0.6, terminal: true };
      return s === 'root'
        ? { state: 's1', reward: 0, terminal: false }
        : { state: 's2', reward: 0.9, terminal: true };
    },
  });
  const quickWins = new UctSearch({ discount: 0.5, seed: 11 }, mkDomain()).search('root', { iterations: 600 });
  ok(quickWins.bestAction === 'quick', 'γ=0.5：快赢 0.6 > 远优 0.9×0.5=0.45（折扣语义）');
  const slowWins = new UctSearch({ discount: 1.0, seed: 11 }, mkDomain()).search('root', { iterations: 600 });
  ok(slowWins.bestAction === 'slow', 'γ=1.0：远优 0.9 > 快赢 0.6（无折扣语义）');
}

{
  // 伯努利两臂收敛 + 同种子逐位复现
  const mkDomain = (rng0) => {
    const rng = mulberry32(rng0);
    return {
      actions: () => ['hi', 'lo'],
      step: (_s, a) => {
        const p = a === 'hi' ? 0.7 : 0.3;
        return rng() < p ? { state: 'T', reward: 1, terminal: true } : { state: 'T', reward: 0, terminal: true };
      },
    };
  };
  const res = new UctSearch({ seed: 3 }, mkDomain(9)).search('root', { iterations: 3000 });
  ok(res.bestAction === 'hi', `伯努利两臂 3000 迭代收敛 hi（best=${res.bestAction}）`);
  const hi = res.children.find((c) => c.action === 'hi');
  ok(Math.abs(hi.meanValue - 0.7) < 0.08, `均值估计 ${hi.meanValue.toFixed(3)} ≈ 0.7`);
  const res2 = new UctSearch({ seed: 3 }, mkDomain(9)).search('root', { iterations: 3000 });
  ok(JSON.stringify(res.children) === JSON.stringify(res2.children), '同 (seed, domain) 逐位复现');
}

{
  // 渐进加宽：大动作集下树尺寸受限
  const actions20 = Array.from({ length: 20 }, (_, i) => `a${i}`);
  const domain = {
    actions: () => actions20,
    step: (_s, a) => ({ state: 'T', reward: (parseInt(a.slice(1), 10) + 1) / 21, terminal: true }),
  };
  const wide = new UctSearch({ progressiveWidenK: 1, seed: 1 }, domain).search('root', { iterations: 300 });
  const full = new UctSearch({ progressiveWidenK: 0, seed: 1 }, domain).search('root', { iterations: 300 });
  ok(wide.treeNodes < full.treeNodes, `渐进加宽树更小（${wide.treeNodes} < ${full.treeNodes}）`);
  ok(wide.bestAction === 'a19', `加宽下仍收敛最优（best=${wide.bestAction}）`);
}

// ═══════════════════════════ 30.0 次模优化 ═══════════════════════════

section('30.0 次模优化内核');

{
  // 随机覆盖函数的次模性审计：0 违反
  const rng = mulberry32(13);
  const cov = new WeightedCoverage(9);
  for (let t = 0; t < 7; t += 1) {
    const covers = new Map();
    for (let i = 0; i < 9; i += 1) if (rng() < 0.45) covers.set(i, 0.3 + 0.6 * rng());
    if (covers.size > 0) cov.addTheme(0.5 + rng(), covers);
  }
  const audit = submodularityCheck(cov, 400);
  ok(audit.violations === 0, `随机加权覆盖次模性审计：${audit.trials} 组 A⊆B 检验 0 违反`);
}

{
  // 惰性贪心 = 朴素贪心（逐位同解）+ ≥ (1−1/e)·OPT（穷举对照）
  const rng = mulberry32(21);
  const cov = new WeightedCoverage(10);
  for (let t = 0; t < 9; t += 1) {
    const covers = new Map();
    for (let i = 0; i < 10; i += 1) if (rng() < 0.4) covers.set(i, 0.25 + 0.7 * rng());
    if (covers.size > 0) cov.addTheme(0.3 + 1.5 * rng(), covers);
  }
  const lazy = lazyGreedy(cov, 3);
  // 朴素贪心（参照实现）
  const selected = new Set();
  const naiveOrder = [];
  for (let k = 0; k < 3; k += 1) {
    let bestItem = -1;
    let bestGain = -1;
    for (let i = 0; i < 10; i += 1) {
      if (selected.has(i)) continue;
      const g = cov.marginal(i, selected);
      if (g > bestGain) {
        bestGain = g;
        bestItem = i;
      }
    }
    selected.add(bestItem);
    naiveOrder.push(bestItem);
  }
  ok(JSON.stringify(lazy.selected) === JSON.stringify(naiveOrder), `CELF 与朴素贪心逐位同解（${lazy.selected.join(',')}）`);
  const opt = bruteForceBest(cov, 3);
  const lazyValue = lazy.values[lazy.values.length - 1];
  const ratio = lazyValue / opt.value;
  ok(ratio >= 1 - 1 / Math.E - 1e-9, `贪心 ${lazyValue.toFixed(4)} ≥ (1−1/e)·OPT（OPT=${opt.value.toFixed(4)}，比值 ${ratio.toFixed(3)}）`);
}

{
  // 知识覆盖语义：冗余第二选边际 (1−c)·w < 互补项 w
  const items = [
    { tokens: ['generate', 'code'], weight: 1.0 },
    { tokens: ['review', 'code'], weight: 0.95 },
    { tokens: ['translate', 'doc'], weight: 0.9 },
  ];
  const cov = coverageFromTokens(items, 0.7);
  // f({i}) = w_i + Σ_{j~i} c·w_j：自身知识全得 + 近邻知识被部分「顺带学会」
  ok(near(cov.value(new Set([0])), 1.0 + 0.7 * 0.95, 1e-9), 'f({i}) = w_i + c·Σ近邻 w（自身主题 + 部分覆盖近邻）');
  const redundant = cov.marginal(1, new Set([0]));
  const complementary = cov.marginal(2, new Set([0]));
  ok(redundant < 0.95 * 0.31 && near(redundant, 0.95 * 0.3, 0.02), `冗余第二选边际 = (1−c)·w = ${redundant.toFixed(3)}（被顺带学会的衰减）`);
  ok(complementary > redundant, `互补项边际 ${complementary.toFixed(3)} > 冗余项 ${redundant.toFixed(3)}`);
  const greedy = lazyGreedy(cov, 2);
  ok(greedy.selected.includes(2), `k=2 贪心选中互补项（选择 {${greedy.selected.join(',')}}，top-k 会选 {0,1}）`);
}

{
  // 曲率修正保证：因子 ∈ [1−1/e, 1]
  const rng = mulberry32(5);
  const cov = new WeightedCoverage(8);
  for (let t = 0; t < 6; t += 1) {
    const covers = new Map();
    for (let i = 0; i < 8; i += 1) if (rng() < 0.5) covers.set(i, 0.4 + 0.5 * rng());
    if (covers.size > 0) cov.addTheme(0.5 + rng(), covers);
  }
  const cur = curvatureEstimate(cov);
  ok(cur.guaranteeFactor >= 1 - 1 / Math.E - 1e-9 && cur.guaranteeFactor <= 1 + 1e-9,
    `曲率保证因子 ${cur.guaranteeFactor.toFixed(3)} ∈ [${(1 - 1 / Math.E).toFixed(3)}, 1]（c=${cur.curvature.toFixed(3)}）`);
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(56)}`);
if (failed === 0) {
  console.log(`✓ 先知层 26.0→30.0 五内核全部验证通过（${passed} 项断言）`);
  process.exit(0);
} else {
  console.error(`✗ ${failed} 项断言失败（${passed} 项通过）`);
  process.exit(1);
}
