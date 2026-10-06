/**
 * verify-variational-langevin.mjs — 57.0→58.0「推断双件套」内核纯数学离线验证
 *
 * 两个内核的数学核心都有解析解对照（不是「能跑」，是「算得对」）：
 *   57.0 变分推断:
 *     ① CAVI 收敛到解析后验（均值 1e-6 / 方差 = 条件方差 1e-6；方差压缩
 *        s² ≤ Σ_ii；正交设计下一次扫描即精确且 ELBO* = ln p(y)，KL = 0）
 *     ② ELBO 300 步逐差单调不减（CAVI 坐标上升保证）
 *     ③ 逻辑回归 VI：ELBO 单调 + 收敛 + 对称数据后验均值 → 0
 *        （梯度/方向正确性的 razor：镜像数据 ⟹ 偶 logJoint ⟹ m* = 0）
 *     ④ ELBO ≤ ln p(y)（下界性；证据 d 维公式与 n 维 Cholesky 口径
 *        独立互检到 1e-9；相关设计的间隙 = KL(q*‖后验) > 0）
 *   58.0 朗之万采样:
 *     ① ULA 二维标准高斯 25 万步均值/方差恢复（容差 0.05；方差对照
 *        ULA 平稳偏差闭式 1/(1−η/2) —— 偏置理论与采样器同时被验证）
 *     ② tuneStep 标定后 MALA 接受率 ∈ [0.4, 0.7]（目标 0.574）；
 *        η→0 接受率→1 / η 过大崩塌（接受率口径方向的 razor）
 *     ③ 同预算 MALA 均值误差与 W2 均 ≤ ULA（细致平衡的精确性收益）
 *     ④ 双井势（非凸）低温/高温 E|x| 与 P(|x|>0.5) 对照梯形求积真值
 *        （|x| 统计在两井对称下不依赖隧道混合：E_π|x| = E_π[|x|·|x>0]）
 *
 * 全部断言确定性（mulberry32 种子固定，同输入同输出）。
 * 运行：node --experimental-strip-types scripts/verify-variational-langevin.mjs
 */

import {
  VI_KIND,
  VariationalEngine,
  conjugateLinearRegressionPosterior,
  logisticRegressionLogJoint,
} from '../src/core/variational-inference.ts';
import {
  ula,
  mala,
  tuneStep,
  gaussianTarget,
  doubleWellTarget,
  w2Gaussian,
  MALA_OPTIMAL_ACCEPT,
} from '../src/core/langevin-sampling.ts';

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
  } catch {
    passed += 1;
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.error(`  ✗ ${label}`);
}

/** 确定性 RNG（mulberry32，与内核同实现） */
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
function gauss(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ═══════════════════ 57.0 变分推断 ═══════════════════

section('57.0 变分推断：CAVI 收敛 / ELBO 单调 / 非共轭 VI / 下界性');

{
  // ── 种子化确定性数据：n=10, d=3 相关设计的贝叶斯线性回归 ──
  const rng = mulberry32(5701);
  const n = 10;
  const d = 3;
  const X = Array.from({ length: n }, () => Array.from({ length: d }, () => gauss(rng)));
  const wTrue = [0.8, -0.5, 0.3];
  const y = X.map((row) => row.reduce((s, v, j) => s + v * wTrue[j], 0) + 0.3 * gauss(rng));
  const ALPHA = 2;
  const BETA = 10;

  // 解析后验（对照真值）+ 证据 d 维公式
  const post = conjugateLinearRegressionPosterior(X, y, ALPHA, BETA);

  // 证据的独立 n 维口径：y ~ N(0, C)，C = α⁻¹XXᵀ + β⁻¹I（Cholesky 独立实现）
  const C = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      let s = 0;
      for (let k = 0; k < d; k += 1) s += X[i][k] * X[j][k];
      return s / ALPHA + (i === j ? 1 / BETA : 0);
    }),
  );
  const Lc = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let s = C[i][j];
      for (let k = 0; k < j; k += 1) s -= Lc[i][k] * Lc[j][k];
      Lc[i][j] = i === j ? Math.sqrt(s) : s / Lc[j][j];
    }
  }
  const sol = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let s = y[i];
    for (let k = 0; k < i; k += 1) s -= Lc[i][k] * sol[k];
    sol[i] = s / Lc[i][i];
  }
  let quad = 0;
  let logDetC = 0;
  for (let i = 0; i < n; i += 1) {
    quad += sol[i] * sol[i];
    logDetC += 2 * Math.log(Lc[i][i]);
  }
  const logPyN = -0.5 * (quad + logDetC + n * Math.log(2 * Math.PI));
  ok(
    near(post.logMarginalLikelihood, logPyN, 1e-9),
    `ln p(y) 双口径互检：d 维公式 ${post.logMarginalLikelihood.toFixed(9)} = n 维 Cholesky ${logPyN.toFixed(9)}（差 < 1e-9）`,
  );


  // ── ② ① CAVI：300 步全轨迹（tol=0 禁早停）──
  const eng = new VariationalEngine({ kind: VI_KIND.linearRegression, X, y, alpha: ALPHA, beta: BETA });
  const fit = eng.fit({ iters: 300, tol: 0 });
  ok(fit.elboTrace.length === 300, `300 步全轨迹（tol=0 不早停，实得 ${fit.elboTrace.length} 条）`);
  let mono = true;
  let worstDrop = 0;
  for (let i = 1; i < fit.elboTrace.length; i += 1) {
    const diff = fit.elboTrace[i] - fit.elboTrace[i - 1];
    if (diff < -1e-10) mono = false;
    worstDrop = Math.min(worstDrop, diff);
  }
  ok(mono, `ELBO 300 步逐差单调不减（最差步差 ${worstDrop.toExponential(2)} ≥ −1e-10）`);

  const mErr = Math.max(...fit.means.map((v, i) => Math.abs(v - post.mean[i])));
  const vErr = Math.max(...fit.vars.map((v, i) => Math.abs(v - post.condVar[i])));
  ok(mErr <= 1e-6, `CAVI 均值 → 解析后验均值（max|Δm| = ${mErr.toExponential(2)} ≤ 1e-6）`);
  ok(vErr <= 1e-6, `CAVI 方差 → 条件方差 1/Λ_ii（max|Δs²| = ${vErr.toExponential(2)} ≤ 1e-6）`);
  ok(
    fit.vars.every((v, i) => v <= post.cov[i][i] + 1e-9),
    `平均场方差压缩：s_i² ≤ 边缘方差 Σ_ii（相关设计下严格小——平均场已知偏置）`,
  );

  const engTol = new VariationalEngine({ kind: VI_KIND.linearRegression, X, y, alpha: ALPHA, beta: BETA });
  const fitTol = engTol.fit({ iters: 300, tol: 1e-10 });
  ok(
    fitTol.converged && fitTol.iterations < 300,
    `tol 早停：${fitTol.iterations} 步收敛（converged=${fitTol.converged}）`,
  );

  // ── ④ 下界性：ELBO ≤ ln p(y)；相关设计的间隙 = KL > 0 ──
  const gap = post.logMarginalLikelihood - fit.finalElbo;
  ok(
    fit.finalElbo <= post.logMarginalLikelihood + 1e-9,
    `下界性：ELBO* ${fit.finalElbo.toFixed(6)} ≤ ln p(y) ${post.logMarginalLikelihood.toFixed(6)}（+1e-9 浮点余量）`,
  );
  ok(
    gap > 1e-3,
    `相关设计平均场间隙 = KL(q*‖后验) = ${gap.toFixed(4)} nat > 0（后验有相关性 ⟹ 平均场必付代价）`,
  );

  // ── ①b 正交设计：后验可分解 → 一次扫描即精确，ELBO* = ln p(y) ──
  const Xo = [[1, 1], [1, -1], [2, 2], [2, -2]]; // XᵀX = diag(10, 10)
  const yo = [0.9, -0.7, 1.8, -1.9];
  const postO = conjugateLinearRegressionPosterior(Xo, yo, 2, 8);
  const engO = new VariationalEngine({ kind: VI_KIND.linearRegression, X: Xo, y: yo, alpha: 2, beta: 8 });
  const fitO = engO.fit({ iters: 50, tol: 0 });
  const mErrO = Math.max(...fitO.means.map((v, i) => Math.abs(v - postO.mean[i])));
  const vErrO = Math.max(...fitO.vars.map((v, i) => Math.abs(v - postO.cov[i][i])));
  ok(
    mErrO <= 1e-9 && vErrO <= 1e-9,
    `正交设计：一次坐标扫描即精确（max|Δm|=${mErrO.toExponential(2)}，max|Δs²−Σ_ii|=${vErrO.toExponential(2)} ≤ 1e-9；条件方差=边缘方差）`,
  );
  ok(
    near(fitO.elboTrace[0], postO.logMarginalLikelihood, 1e-9),
    `正交设计：ELBO* = ln p(y)（${fitO.elboTrace[0].toFixed(9)} vs ${postO.logMarginalLikelihood.toFixed(9)}，KL=0——ELBO 公式与证据公式两条独立代码路径对齐）`,
  );

  // ── ③ 非共轭：贝叶斯逻辑回归（对称数据 ⟹ 偶 logJoint ⟹ m* = 0）──
  // 偶对称的构造口径：每个 x 同时带两种标签（y=1 与 y=0 各一条），
  // 该 x 对似然的贡献 = ln σ(t)+ln(1−σ(t)) 关于 t → −t 不变 ⟹
  // ln p(w) = ln p(−w)，后验（log-concave）均值恰为 0。
  const Xl = [[1, 0], [1, 0], [-1, 0], [-1, 0], [0, 1], [0, 1], [0, -1], [0, -1]];
  const yl = [1, 0, 1, 0, 1, 0, 1, 0];
  const model = logisticRegressionLogJoint(Xl, yl, 4);
  ok(
    Math.abs(model.logJoint([0.3, -0.2]) - model.logJoint([-0.3, 0.2])) < 1e-12,
    `对称数据的 logJoint 严格偶对称（ln p(w) = ln p(−w)，后验均值必为 0）`,
  );

  const engL = new VariationalEngine({ kind: VI_KIND.gaussianVI, dim: 2, logJoint: model.logJoint, gradLogJoint: model.gradLogJoint });
  const initElbo = engL.elbo(); // 初始 (m=0, s=1) 处的 ELBO（拟合前）
  const fitL300 = engL.fit({ iters: 300, tol: 0 });
  let monoL = true;
  for (let i = 1; i < fitL300.elboTrace.length; i += 1) {
    if (fitL300.elboTrace[i] - fitL300.elboTrace[i - 1] < -1e-12) monoL = false;
  }
  ok(monoL, `逻辑回归 VI：ELBO 300 步单调不减（Armijo 只接受提升步）`);
  ok(
    fitL300.finalElbo - initElbo > 1,
    `ELBO 显著爬升（初始 ${initElbo.toFixed(4)} → 终值 ${fitL300.finalElbo.toFixed(4)}，+${(fitL300.finalElbo - initElbo).toFixed(2)} nat）`,
  );

  const engL2 = new VariationalEngine({ kind: VI_KIND.gaussianVI, dim: 2, logJoint: model.logJoint, gradLogJoint: model.gradLogJoint });
  const fitL2 = engL2.fit({ iters: 500, tol: 1e-7 });
  ok(
    fitL2.converged && fitL2.iterations < 500,
    `逻辑回归 VI 收敛（${fitL2.iterations} 步早停，converged=${fitL2.converged}）`,
  );
  ok(
    Math.max(...fitL2.means.map(Math.abs)) <= 1e-12,
    `对称后验均值 → 0（实测 ‖m‖∞ = ${Math.max(...fitL2.means.map(Math.abs)).toExponential(2)} ≤ 1e-12；antithetic CRN 使估计量严格偶对称——梯度符号错误的核在此翻车）`,
  );
  const engLong = new VariationalEngine({ kind: VI_KIND.gaussianVI, dim: 2, logJoint: model.logJoint, gradLogJoint: model.gradLogJoint });
  const fitLong = engLong.fit({ iters: 2000, tol: 0 });
  ok(
    Math.abs(fitLong.finalElbo - fitL2.finalElbo) <= 1e-3,
    `长程稳定性：2000 步终值与早停终值差 ${Math.abs(fitLong.finalElbo - fitL2.finalElbo).toExponential(2)} ≤ 1e-3（确已收敛到驻点）`,
  );

  // 确定性：同种子两次构造逐位一致
  const engA = new VariationalEngine({ kind: VI_KIND.gaussianVI, dim: 2, logJoint: model.logJoint, gradLogJoint: model.gradLogJoint });
  const engB = new VariationalEngine({ kind: VI_KIND.gaussianVI, dim: 2, logJoint: model.logJoint, gradLogJoint: model.gradLogJoint });
  const ra = engA.fit({ iters: 100, tol: 0 });
  const rb = engB.fit({ iters: 100, tol: 0 });
  ok(
    ra.means.every((v, i) => v === rb.means[i]) && ra.finalElbo === rb.finalElbo,
    `确定性：同种子两次拟合逐位一致（CRN 固定 ε 集）`,
  );

  // ── 入参校验 ──
  throws(() => conjugateLinearRegressionPosterior(X, y, 0, 10), 'α=0 显式 throw（先验精度必须 > 0）');
  throws(() => conjugateLinearRegressionPosterior([[1, 2], [3]], [0.1, 0.2], 1, 1), '参差设计矩阵显式 throw');
  throws(() => new VariationalEngine({ kind: VI_KIND.gaussianVI, dim: 0, logJoint: model.logJoint }), 'dim=0 显式 throw');
  throws(
    () => new VariationalEngine({ kind: VI_KIND.gaussianVI, dim: 2, logJoint: model.logJoint }).fit({ iters: 0 }),
    'iters=0 显式 throw',
  );
  // 合法共轭问题的 caviStep 不应 throw（反向保护：闭式路径可用）
  let caviOk = true;
  try {
    const e0 = new VariationalEngine({ kind: VI_KIND.linearRegression, X: Xl, y: yl, alpha: 2, beta: 10 });
    caviOk = Number.isFinite(e0.caviStep());
  } catch {
    caviOk = false;
  }
  ok(caviOk, '合法共轭问题 caviStep() 可单步调用且返回有限 ELBO（非共轭才 throw）');
}

// ═══════════════════ 58.0 朗之万采样 ═══════════════════

section('58.0 朗之万采样：ULA 恢复 / MALA 精确性 / 接受率调参 / 双井权重');

{
  const tgt = gaussianTarget(2);

  // ── ① ULA 大步数恢复标准高斯（η=0.05，理论平稳方差 1/(1−η/2) ≈ 1.0256）──
  const rU = ula({ gradU: tgt.gradU, dim: 2, eta: 0.05, steps: 250000, burnIn: 5000, thin: 10, seed: 5801 });
  const vU = [rU.cov[0][0], rU.cov[1][1]];
  const etaBias = 1 / (1 - 0.05 / 2);
  ok(
    Math.abs(rU.mean[0]) <= 0.05 && Math.abs(rU.mean[1]) <= 0.05,
    `ULA 25 万步均值恢复：[${rU.mean.map((v) => v.toFixed(4)).join(', ')}]（容差 0.05）`,
  );
  ok(
    Math.abs(vU[0] - 1) <= 0.05 && Math.abs(vU[1] - 1) <= 0.05,
    `ULA 方差恢复：[${vU.map((v) => v.toFixed(4)).join(', ')}]（容差 0.05，含 ULA 平稳偏差）`,
  );
  ok(
    Math.abs(vU[0] - etaBias) <= 0.04 && Math.abs(vU[1] - etaBias) <= 0.04,
    `ULA 平稳偏差闭式对照：方差 → 1/(1−η/2) = ${etaBias.toFixed(4)}（实测 [${vU.map((v) => v.toFixed(4)).join(', ')}] ≤ 0.04——偏置理论与采样器同时被验证）`,
  );

  // ── ①b 工厂偏移目标（MALA 精确采样，非平凡 μ/σ）──
  const tgt2 = gaussianTarget(2, { mean: [1, -2], std: [0.8, 1.25] });
  const rM2 = mala({ gradU: tgt2.gradU, logU: tgt2.logU, dim: 2, eta: 0.4, steps: 100000, burnIn: 2000, seed: 5802 });
  const sdHat = [Math.sqrt(rM2.cov[0][0]), Math.sqrt(rM2.cov[1][1])];
  ok(
    Math.abs(rM2.mean[0] - 1) <= 0.1 && Math.abs(rM2.mean[1] + 2) <= 0.1,
    `MALA 偏移目标均值恢复：[${rM2.mean.map((v) => v.toFixed(3)).join(', ')}] vs [1, −2]`,
  );
  ok(
    Math.abs(sdHat[0] - 0.8) <= 0.1 && Math.abs(sdHat[1] - 1.25) <= 0.15,
    `MALA 偏移目标标准差恢复：[${sdHat.map((v) => v.toFixed(3)).join(', ')}] vs [0.8, 1.25]（无 ULA 偏置）`,
  );

  // ── ② 接受率方向 razor + tuneStep 调参 ──
  const tiny = mala({ gradU: tgt.gradU, logU: tgt.logU, dim: 2, eta: 0.001, steps: 3000, seed: 5803 });
  const huge = mala({ gradU: tgt.gradU, logU: tgt.logU, dim: 2, eta: 5, steps: 3000, seed: 5804 });
  ok(tiny.acceptRate > 0.99, `η→0 接受率 → 1（η=0.001 实测 ${tiny.acceptRate.toFixed(4)}——提议退化为恒等）`);
  ok(huge.acceptRate < 0.1, `η 过大接受率崩塌（η=5 实测 ${huge.acceptRate.toFixed(4)} < 0.1）`);

  const tune = tuneStep({ gradU: tgt.gradU, logU: tgt.logU, dim: 2, targetAccept: MALA_OPTIMAL_ACCEPT, seed: 5805 });
  ok(
    tune.eta > 0.1 && tune.eta < 3,
    `tuneStep 对数域二分 ${tune.probes} 次 → η = ${tune.eta.toFixed(4)}（接受率对 η 单调不增的调参依据）`,
  );
  const rTuned = mala({ gradU: tgt.gradU, logU: tgt.logU, dim: 2, eta: tune.eta, steps: 40000, burnIn: 2000, seed: 5806 });
  ok(
    rTuned.acceptRate >= 0.4 && rTuned.acceptRate <= 0.7,
    `调参后 MALA 接受率 ${rTuned.acceptRate.toFixed(3)} ∈ [0.4, 0.7]（目标 0.574 最优尺度理论）`,
  );

  // ── ③ 同预算对比：MALA（精确）vs ULA（有偏），各 8 万步 ──
  const BUDGET = 80000;
  const rUlaB = ula({ gradU: tgt.gradU, dim: 2, eta: 0.05, steps: BUDGET, burnIn: 4000, seed: 5807 });
  const rMalaB = mala({ gradU: tgt.gradU, logU: tgt.logU, dim: 2, eta: tune.eta, steps: BUDGET, burnIn: 4000, seed: 5808 });
  const I2 = [[1, 0], [0, 1]];
  const w2u = w2Gaussian(rUlaB.samples, tgt.mean, I2);
  const w2m = w2Gaussian(rMalaB.samples, tgt.mean, I2);
  ok(
    w2m.meanErr <= w2u.meanErr,
    `同预算 ${BUDGET} 步：MALA 均值误差 ${w2m.meanErr.toFixed(4)} ≤ ULA ${w2u.meanErr.toFixed(4)}`,
  );
  ok(
    w2m.w2 <= w2u.w2,
    `同预算 W2：MALA ${w2m.w2.toFixed(4)} ≤ ULA ${w2u.w2.toFixed(4)}（细致平衡的精确性收益）`,
  );

  // ── ④ 双井势（非凸）：Boltzmann 权重方向 + 梯形求积真值 ──
  const wellRef = (T) => {
    const a = -4;
    const b = 4;
    const M = 160000;
    const h = (b - a) / M;
    let Z = 0;
    let Ex = 0;
    let Pw = 0;
    for (let k = 0; k <= M; k += 1) {
      const x = a + k * h;
      const w = (k === 0 || k === M ? 0.5 : 1) * Math.exp(-(((x * x - 1) ** 2) / T)) * h;
      Z += w;
      Ex += Math.abs(x) * w;
      if (Math.abs(x) > 0.5) Pw += w;
    }
    return { Ex: Ex / Z, Pwell: Pw / Z };
  };
  const TLOW = 0.5;
  const THIGH = 2;
  const refLow = wellRef(TLOW);
  const refHigh = wellRef(THIGH);
  const wellLow = doubleWellTarget(TLOW);
  const wellHigh = doubleWellTarget(THIGH);
  const chainLow = mala({ gradU: wellLow.gradU, logU: wellLow.logU, dim: 1, eta: 0.06, steps: 100000, burnIn: 1000, seed: 5809 });
  const chainHigh = mala({ gradU: wellHigh.gradU, logU: wellHigh.logU, dim: 1, eta: 0.06, steps: 100000, burnIn: 1000, seed: 5810 });
  const ExLow = chainLow.samples.reduce((s, v) => s + Math.abs(v[0]), 0) / chainLow.samples.length;
  const ExHigh = chainHigh.samples.reduce((s, v) => s + Math.abs(v[0]), 0) / chainHigh.samples.length;
  const PwLow = chainLow.samples.filter((v) => Math.abs(v[0]) > 0.5).length / chainLow.samples.length;
  const PwHigh = chainHigh.samples.filter((v) => Math.abs(v[0]) > 0.5).length / chainHigh.samples.length;
  ok(
    Math.abs(ExLow - refLow.Ex) <= 0.05,
    `双井低温 T=0.5：E|x| = ${ExLow.toFixed(4)} vs 求积真值 ${refLow.Ex.toFixed(4)}（差 ≤ 0.05；|x| 边缘在两井对称下不依赖隧道混合）`,
  );
  ok(
    Math.abs(ExHigh - refHigh.Ex) <= 0.05,
    `双井高温 T=2：E|x| = ${ExHigh.toFixed(4)} vs 求积真值 ${refHigh.Ex.toFixed(4)}（差 ≤ 0.05）`,
  );
  ok(
    Math.abs(PwLow - refLow.Pwell) <= 0.06 && Math.abs(PwHigh - refHigh.Pwell) <= 0.06,
    `双井井内占比：T=0.5 → ${PwLow.toFixed(3)}（真值 ${refLow.Pwell.toFixed(3)}）、T=2 → ${PwHigh.toFixed(3)}（真值 ${refHigh.Pwell.toFixed(3)}）`,
  );
  ok(
    ExLow > ExHigh + 0.02 && PwLow > PwHigh,
    `Boltzmann 权重方向：低温更集中于井（E|x| ${ExLow.toFixed(3)} > ${ExHigh.toFixed(3)}（求积真差 ${(refLow.Ex - refHigh.Ex).toFixed(3)}）、P井 ${PwLow.toFixed(3)} > ${PwHigh.toFixed(3)}）`,
  );

  // ── 确定性 ──
  const rA = ula({ gradU: tgt.gradU, dim: 2, eta: 0.1, steps: 500, seed: 42 });
  const rB = ula({ gradU: tgt.gradU, dim: 2, eta: 0.1, steps: 500, seed: 42 });
  const rC = ula({ gradU: tgt.gradU, dim: 2, eta: 0.1, steps: 500, seed: 43 });
  ok(
    rA.samples.every((s, i) => s.every((v, j) => v === rB.samples[i][j])) && rA.mean[0] === rB.mean[0],
    `确定性：同种子 ULA 逐位一致，异种子不同（mulberry32 + Box–Muller 固定次序）`,
  );
  ok(rA.mean[0] !== rC.mean[0], `异种子产生不同轨迹（非退化随机源）`);

  // ── 入参校验 ──
  throws(() => ula({ gradU: tgt.gradU, dim: 2, eta: 0, steps: 10, seed: 1 }), 'ula η=0 显式 throw');
  throws(() => ula({ gradU: tgt.gradU, dim: 2, eta: 0.1, steps: 10.5, seed: 1 }), 'ula steps 非整数显式 throw');
  throws(() => ula({ gradU: tgt.gradU, dim: 2, eta: 0.1, steps: 10, seed: 1, burnIn: 10 }), 'ula burnIn=steps 显式 throw');
  throws(() => mala({ gradU: tgt.gradU, dim: 2, eta: 0.1, steps: 10, seed: 1 }), 'mala 缺 logU 显式 throw');
  throws(() => gaussianTarget(0), 'gaussianTarget dim=0 显式 throw');
  throws(() => doubleWellTarget(-1), 'doubleWellTarget T=−1 显式 throw');
  throws(() => w2Gaussian([[1, 2]], [0], [[1]]), 'w2Gaussian 维数不匹配显式 throw');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
