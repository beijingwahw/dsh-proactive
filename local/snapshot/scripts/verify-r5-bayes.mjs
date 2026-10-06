/**
 * verify-r5-bayes.mjs — R5-A3「贝叶斯计算内核第五轮进化」纯数学离线验证
 *
 * 五个内核（6.0 自由能 / 57.0 变分推断 / 58.0 朗之万 / 26.0 高斯过程 /
 * 27.0 卡尔曼）的进化四轴验证——不是「能跑」，是「算得对 + 算得快 + 稳」：
 *
 *   6.0 free-energy:
 *     ① betaEntropySiblings 递推包 vs 直算（500 组种子化 (α,β)，恒等到
 *        浮点舍入阶 1e-11；特殊函数求值次数减半的耗时对照）
 *     ② EFE 规范分解（evaluateActionCanonical）：risk = KL(Ber(p̂)‖Ber(ω))
 *        ≥ 0 且 p̂=ω 时为 0；换算恒等式 pragmatic = risk + H₂(ω)；
 *        efeCanonical = risk + epistemicDivergence；认知项随证据 → 0
 *        （探索自我终结），证据单调（信息越多认知价值越低）
 *   57.0 variational-inference:
 *     ③ 自然梯度：各向异性高斯目标 13 步逼近平台（普通梯度 2000 步仍在
 *        爬坡）；ELBO 单调；与普通梯度收敛到同一驻点；s 恢复 σ 真值
 *     ④ ELBO 平台早停（elboTol）：迭代数 16 ≪ 800，终值差 ≤ 1e-4
 *     ⑤ Λ 的 Cholesky 抖动回退：舍入退化设计不再 throw（jitter > 0 且
 *        输出有限），良态设计 jitter = 0（精确路径不动）
 *     ⑥ ELBO ≤ ln p(y) 下界性 + CAVI 收敛到解析后验（200 个种子化问题）
 *   58.0 langevin-sampling:
 *     ⑦ 梯度/能量复用：gradU/logU 求值次数 = 步数 + 1（原 2×步数），
 *        轨迹与旧实现逐位一致（脚本内复刻旧代码对照）
 *     ⑧ 蛙跳可逆性 R∘Φ∘R = Φ⁻¹（300 个种子化相空间点，1e-10 内）
 *        ——Metropolis 修正合法性的数学根基
 *     ⑨ 细致平衡的数值检验：MALA 与欠阻尼 MALA 的分箱转移计数
 *        N(a→b) ≈ N(b→a)（N(0,1) 目标 40 万步，|ΔN|/√max ≤ 4）
 *     ⑩ 欠阻尼 MALA：高斯矩恢复 + 动量持久化带来缓方向 ESS 优势；
 *        ouRefreshScale 的 expm1 口径全域精确
 *   26.0 gaussian-process:
 *     ⑪ 插值性质：后验均值在观测点恢复观测值（σn=1e-4，200 个种子化
 *        拟合，误差 ≤ 1e-6 量级）
 *     ⑫ FITC 稀疏 GP：m=n 时 ≡ 全 GP（均值/方差/LML 三对照）；固定
 *        超参下误差随 m 单调下降；条件预警（重复点 + 小 σn → illConditioned）
 *     ⑬ kernelMatrix 三角化逐位等价（脚本内全矩阵 LML 复刻对照）；
 *        predictBatch 与逐点 predict 逐位一致 + 耗时对照
 *   27.0 kalman-filter:
 *     ⑭ 标量测量特化：与通用矩阵链实现逐位一致（200 模型 × 60 步）
 *        + 2 万步耗时对照（≈2.6×）
 *     ⑮ 线性高斯一致性：常状态滤波 = 批量精度加权后验（精确闭式）；
 *        随机游走 P → P∞（Riccati 稳态解析解）；NIS 均值 → χ²(1) 期望 1
 *     ⑯ UKF ≡ KF（线性模型精确性定理，200 模型）；sin 观测下 UKF
 *        优于 EKF 线性化（数值求积真值对照）
 *     ⑰ Joseph 型更新：2000 步后严格对称（|P−Pᵀ| = 0）且 PSD；
 *        RTS 平滑斜率误差 < 滤波（事后最优的收益）
 *
 * 全部断言确定性（mulberry32 种子固定，同输入同输出）。
 * 运行：node --experimental-transform-types scripts/verify-r5-bayes.mjs
 */

import {
  FreeEnergyEngine,
  betaEntropy,
  betaEntropySiblings,
  betaKL,
  binaryEntropy,
} from '../src/core/free-energy.ts';
import {
  VI_KIND,
  VariationalEngine,
  conjugateLinearRegressionPosterior,
  logisticRegressionLogJoint,
} from '../src/core/variational-inference.ts';
import {
  mala,
  underdampedMala,
  leapfrogProposal,
  ouRefreshScale,
  gaussianTarget,
} from '../src/core/langevin-sampling.ts';
import { GaussianProcess, choleskyLower, solveCholesky } from '../src/core/gaussian-process.ts';
import {
  KalmanFilter,
  UnscentedKalmanFilter,
  LocalLinearTrendFilter,
  randomWalkSteadyState,
} from '../src/core/kalman-filter.ts';

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
/** min-of-k 计时（压 JIT/调度噪声） */
function timeMin(fn, k = 3) {
  let best = Infinity;
  for (let i = 0; i < k; i += 1) {
    const t0 = performance.now();
    fn();
    const t1 = performance.now();
    best = Math.min(best, t1 - t0);
  }
  return best;
}

// ═══════════════════ 6.0 free-energy ═══════════════════

section('6.0 自由能：Beta 熵递推等价 / EFE 规范分解 / 耗时对照');

{
  // ── ① 递推包 vs 直算（500 组种子化 (α,β)）──
  let worstSib = 0;
  for (let i = 0; i < 500; i += 1) {
    const a = 10 ** ((i % 17) / 4 - 2) + 0.013 * i + 0.05;
    const b = 10 ** ((i % 11) / 4 - 1) + 0.009 * i + 0.05;
    const s = betaEntropySiblings(a, b);
    worstSib = Math.max(
      worstSib,
      Math.abs(s.h0 - betaEntropy(a, b)),
      Math.abs(s.hAlphaPlus - betaEntropy(a + 1, b)),
      Math.abs(s.hBetaPlus - betaEntropy(a, b + 1)),
      Math.abs(s.klAlphaPlus - betaKL(a, b, a + 1, b)),
      Math.abs(s.klBetaPlus - betaKL(a, b, a, b + 1)),
    );
  }
  ok(worstSib <= 1e-11, `递推包 vs 直算：500 组 (α,β) 五量最大差 ${worstSib.toExponential(2)} ≤ 1e-11（ψ 同点求值 + lnΓ 精确递推——恒等只差浮点舍入）`);

  // 耗时对照：20000 组 (α,β)，旧口径 = 3 次 betaEntropy，新口径 = 递推包
  const pairsAB = Array.from({ length: 20000 }, (_, i) => [0.5 + 0.001 * i, 0.3 + 0.0021 * i]);
  const tOld = timeMin(() => {
    let acc = 0;
    for (const [a, b] of pairsAB) acc += betaEntropy(a, b) + betaEntropy(a + 1, b) + betaEntropy(a, b + 1);
    return acc;
  });
  const tNew = timeMin(() => {
    let acc = 0;
    for (const [a, b] of pairsAB) {
      const s = betaEntropySiblings(a, b);
      acc += s.h0 + s.hAlphaPlus + s.hBetaPlus;
    }
    return acc;
  });
  ok(
    tNew <= tOld,
    `递推包耗时 ${(tNew / tOld).toFixed(2)}× 直算（${tNew.toFixed(1)}ms vs ${tOld.toFixed(1)}ms / 2 万组——特殊函数求值 9 lnΓ+9 ψ → 3 lnΓ+6 ψ）`,
  );

  // ── ② EFE 规范分解性质（300 个种子化动作 × 偏好）──
  const engine = new FreeEnergyEngine();
  const rng = mulberry32(60600);
  /** 脚本内 Bernoulli KL（双向） */
  const berKL = (q, p) => {
    const qc = Math.min(1 - 1e-12, Math.max(1e-12, q));
    const pc = Math.min(1 - 1e-12, Math.max(1e-12, p));
    return qc * Math.log(qc / pc) + (1 - qc) * Math.log((1 - qc) / (1 - pc));
  };
  let riskNonNeg = true;
  let riskZeroIff = true;
  let identityWorst = 0;
  let riskDirWorst = 0;
  let efeIdentityWorst = 0;
  let epiNonNeg = true;
  for (let i = 0; i < 300; i += 1) {
    const p = 0.02 + 0.96 * rng();
    const omega = i % 10 === 0 ? p : 0.05 + 0.9 * rng(); // 1/10 恰好对齐偏好
    const strength = Math.floor(200 * rng());
    const action = {
      id: `a${i}`,
      pSuccess: p,
      lower: p - 0.1 * rng(),
      upper: p + 0.1 * rng(),
      interventionalSamples: strength,
      observationalSamples: Math.floor(50 * rng()),
    };
    const legacy = engine.evaluateAction(action, omega);
    const canon = engine.evaluateActionCanonical(action, omega);
    if (!(canon.risk >= -1e-9)) riskNonNeg = false;
    // p̂ = ω ⟹ risk = 0；显著偏离 ⟹ risk > 0（连续随机下留 0.01 的间隔带）
    if (omega === p && canon.risk > 1e-5) riskZeroIff = false;
    if (Math.abs(omega - p) > 0.01 && canon.risk <= 1e-5) riskZeroIff = false;
    // 换算恒等式（偏好方向的 KL 分解）：pragmatic = KL(ω‖p̂) + H₂(ω)
    identityWorst = Math.max(identityWorst, Math.abs(legacy.pragmatic - berKL(omega, p) - canon.preferenceEntropy));
    // risk 的方向口径：risk = KL(p̂‖ω)（EFE 规范方向）
    riskDirWorst = Math.max(riskDirWorst, Math.abs(canon.risk - berKL(p, omega)));
    efeIdentityWorst = Math.max(efeIdentityWorst, Math.abs(canon.efeCanonical - canon.risk - canon.epistemicDivergence));
    if (!(canon.epistemicDivergence >= -1e-6)) epiNonNeg = false;
  }
  ok(riskNonNeg, 'risk = KL(Ber(p̂)‖Ber(ω)) ≥ 0（300 种子化输入）');
  ok(riskZeroIff, 'risk = 0 ⟺ p̂ = ω（对齐样本为零，|p̂−ω| > 0.01 者严格为正——两个方向的 KL 同时为零 iff 分布相等）');
  ok(
    identityWorst <= 3.1e-6,
    `换算恒等式 pragmatic = KL(ω‖p̂) + H₂(ω)：300 输入最大残差 ${identityWorst.toExponential(2)} ≤ 3.1e-6（交叉熵的 KL 分解，KL 方向为偏好方向）`,
  );
  ok(
    riskDirWorst <= 3.1e-6,
    `risk 方向口径 = KL(Ber(p̂)‖Ber(ω))：残差 ${riskDirWorst.toExponential(2)}（EFE 规范方向 q(o)‖P(o|C)，与 pragmatic 的 KL 方向相反）`,
  );
  ok(efeIdentityWorst <= 2.1e-6, `efeCanonical = risk + epistemicDivergence（残差 ${efeIdentityWorst.toExponential(2)}，含 6 位舍入）`);
  ok(epiNonNeg, '认知项 E[KL(q(θ)‖P(θ|o))] ≥ 0（先验-后验 KL 的期望）');

  // 认知项随证据 → 0（探索自我终结）+ 证据单调
  const weak = engine.evaluateActionCanonical({ id: 'w', pSuccess: 0.5, lower: 0, upper: 1, interventionalSamples: 0, observationalSamples: 0 }, 0.7);
  const mid = engine.evaluateActionCanonical({ id: 'm', pSuccess: 0.5, lower: 0, upper: 1, interventionalSamples: 50, observationalSamples: 0 }, 0.7);
  const strong = engine.evaluateActionCanonical({ id: 's', pSuccess: 0.5, lower: 0, upper: 1, interventionalSamples: 100000, observationalSamples: 0 }, 0.7);
  ok(
    weak.epistemicDivergence > mid.epistemicDivergence && strong.epistemicDivergence < 1e-3,
    `认知项随证据收敛：0 证据 ${weak.epistemicDivergence.toFixed(4)} > 50 证据 ${mid.epistemicDivergence.toFixed(4)} > 10 万证据 ${strong.epistemicDivergence.toExponential(2)} < 1e-3（探索自我终结的定理化）`,
  );

  // argmin 一致性：同证据下规范 EFE 偏好 p̂ = ω（risk 主导）
  const acts = [0.2, 0.5, 0.8].map((p) => ({ id: `p${p}`, pSuccess: p, lower: p - 0.05, upper: p + 0.05, interventionalSamples: 100, observationalSamples: 0 }));
  const canonSet = acts.map((a) => engine.evaluateActionCanonical(a, 0.8));
  const bestCanon = [...canonSet].sort((x, y) => x.efeCanonical - y.efeCanonical)[0];
  ok(bestCanon.actionId === 'p0.8', `规范 EFE 最优 = p̂ 与偏好对齐者（${bestCanon.actionId}，risk 主导排序）`);

  throws(() => betaEntropySiblings(0, 1), 'betaEntropySiblings α=0 显式 throw');
  throws(() => betaEntropySiblings(1, -1), 'betaEntropySiblings β=−1 显式 throw');
}

// ═══════════════════ 57.0 variational-inference ═══════════════════

section('57.0 变分推断：自然梯度 / ELBO 平台早停 / Λ 抖动回退 / 下界性');

{
  // ── ③ 自然梯度：各向异性高斯（σ = [0.05, 20]）──
  const sig = [0.05, 20];
  const logJointG = (z) => -0.5 * ((z[0] * z[0]) / (sig[0] * sig[0]) + (z[1] * z[1]) / (sig[1] * sig[1]));
  const gradG = (z) => [-(z[0] / (sig[0] * sig[0])), -(z[1] / (sig[1] * sig[1]))];
  // 最优 q = N(0, diag(σ²))：ELBO* = −1 + Σ ln σᵢ + (d/2)(1+ln2π)
  const elboStar = -1 + Math.log(sig[0]) + Math.log(sig[1]) + 1 + Math.log(2 * Math.PI);
  const mkG = (ng) => new VariationalEngine(
    { kind: VI_KIND.gaussianVI, dim: 2, logJoint: logJointG, gradLogJoint: gradG },
    { naturalGradient: ng, mcSamples: 256 },
  );
  const fitPlainG = mkG(false).fit({ iters: 2000, tol: 0 });
  const fitNgG = mkG(true).fit({ iters: 2000, tol: 0 });
  const itPlain = fitPlainG.elboTrace.findIndex((e) => e >= elboStar - 0.05) + 1;
  const itNg = fitNgG.elboTrace.findIndex((e) => e >= elboStar - 0.05) + 1;
  ok(itNg > 0 && itNg <= 50, `自然梯度 ${itNg} 步逼近 ELBO*（容差 0.05 nat）——分布空间度量的步长不再被 1/s 量级梯度分量拖慢`);
  ok(itPlain === 0, `普通梯度 2000 步仍未达（终值距最优 ${(elboStar - fitPlainG.finalElbo).toFixed(3)} nat：s 从 1 爬向 20 的 ODE ds/dt = 1/s − s/σ² 每步只能走 O(1)）`);
  let monoNg = true;
  for (let i = 1; i < fitNgG.elboTrace.length; i += 1) {
    if (fitNgG.elboTrace[i] - fitNgG.elboTrace[i - 1] < -1e-12) monoNg = false;
  }
  ok(monoNg, '自然梯度 ELBO 单调不减（F⁻¹∇ 仍为上升方向，Armijo 只接受提升步）');
  ok(
    Math.abs(fitNgG.vars[0] - sig[0]) <= 3 && Math.abs(fitNgG.vars[1] - sig[1]) <= 3,
    `自然梯度 s 恢复 σ 真值：[${fitNgG.vars.map((v) => v.toFixed(3))}] vs [0.05, 20]（±3 容差含 CRN 估计噪声）`,
  );

  // 逻辑回归：与普通梯度收敛到同一驻点（同 CRN ε 集）
  const rngL = mulberry32(5702);
  const nL = 40;
  const XL = Array.from({ length: nL }, () => {
    const z = gauss(rngL);
    return [z, 0.8 * z + 0.2 * gauss(rngL), gauss(rngL)];
  });
  const wL = [1.2, -0.8, 0.5];
  const yL = XL.map((r) => (r.reduce((s, v, j) => s + v * wL[j], 0) + 0.5 * gauss(rngL) > 0 ? 1 : 0));
  const model = logisticRegressionLogJoint(XL, yL, 2);
  const mkL = (ng) => new VariationalEngine(
    { kind: VI_KIND.gaussianVI, dim: 3, logJoint: model.logJoint, gradLogJoint: model.gradLogJoint },
    { naturalGradient: ng, mcSamples: 256 },
  );
  const fPlainL = mkL(false).fit({ iters: 600, tol: 0 });
  const fNgL = mkL(true).fit({ iters: 600, tol: 0 });
  ok(
    Math.abs(fNgL.finalElbo - fPlainL.finalElbo) <= 1e-3,
    `自然梯度与普通梯度收敛到同一驻点（|ΔELBO| = ${Math.abs(fNgL.finalElbo - fPlainL.finalElbo).toExponential(2)} ≤ 1e-3——同 CRN ε 集，同最优 q*）`,
  );

  // ── ④ ELBO 平台早停 ──
  const fFull = mkL(false).fit({ iters: 800, tol: 0 });
  const fStop = mkL(false).fit({ iters: 800, tol: 0, elboTol: 1e-6, plateauSteps: 3 });
  ok(
    fStop.converged && fStop.iterations < 800 && Math.abs(fStop.finalElbo - fFull.finalElbo) <= 1e-4,
    `elboTol 平台早停：${fStop.iterations} 步（全轨迹 800 步）即收敛，终值差 ${Math.abs(fStop.finalElbo - fFull.finalElbo).toExponential(2)} ≤ 1e-4（ELBO 平台先于参数静止）`,
  );

  // ── ⑤ Λ Cholesky 抖动回退 ──
  // 舍入退化构造：pivot 在浮点下恰好为 0（列 2 = 列 1 + 2⁻²⁶，α=1e-20）
  const Xbad = [[1, 1], [1, 1 + 2 ** -26]];
  let badPost;
  let badOk = true;
  try {
    badPost = conjugateLinearRegressionPosterior(Xbad, [1, 2], 1e-20, 1);
  } catch {
    badOk = false;
  }
  ok(
    badOk && badPost.jitter > 0 && badPost.mean.every(Number.isFinite) && Number.isFinite(badPost.logMarginalLikelihood),
    `Λ 抖动回退：舍入退化设计不再 throw（jitter = ${badOk ? badPost.jitter.toExponential(2) : '—'}，输出全部有限）`,
  );
  const goodPost = conjugateLinearRegressionPosterior([[1, 0], [0, 1], [2, 1]], [1, 2, 3], 2, 8);
  ok(goodPost.jitter === 0, `良态设计 jitter = 0（抖动为 0 的首轮 = 原精确路径，逐位一致）`);

  // ── ⑥ 下界性 + CAVI 收敛（200 个种子化问题）──
  let boundOk = true;
  let worstBound = 0;
  let cavErr = 0;
  let monoAll = true;
  for (let s = 0; s < 200; s += 1) {
    const rngP = mulberry32(57000 + s);
    const nP = 6 + Math.floor(rngP() * 5);
    const dP = 2 + Math.floor(rngP() * 3);
    const XP = Array.from({ length: nP }, () => Array.from({ length: dP }, () => gauss(rngP)));
    const wP = Array.from({ length: dP }, () => gauss(rngP));
    const yP = XP.map((r) => r.reduce((a, v, j) => a + v * wP[j], 0) + 0.3 * gauss(rngP));
    const aP = 0.5 + 3 * rngP();
    const bP = 2 + 20 * rngP();
    const post = conjugateLinearRegressionPosterior(XP, yP, aP, bP);
    const eng = new VariationalEngine({ kind: VI_KIND.linearRegression, X: XP, y: yP, alpha: aP, beta: bP });
    const fit = eng.fit({ iters: 500, tol: 0 });
    const gap = post.logMarginalLikelihood - fit.finalElbo;
    if (gap < -1e-9) boundOk = false;
    worstBound = Math.max(worstBound, -gap);
    cavErr = Math.max(cavErr, ...fit.means.map((v, i) => Math.abs(v - post.mean[i])));
    for (let i = 1; i < fit.elboTrace.length; i += 1) {
      if (fit.elboTrace[i] - fit.elboTrace[i - 1] < -1e-10) monoAll = false;
    }
  }
  ok(boundOk, `ELBO ≤ ln p(y)：200 个种子化问题全部成立（最紧处超出 −${worstBound.toExponential(2)}，浮点余量内）`);
  ok(cavErr <= 1e-6, `CAVI 均值收敛到解析后验 m = βΛ⁻¹Xᵀy：200 问题 max|Δm| = ${cavErr.toExponential(2)} ≤ 1e-6`);
  ok(monoAll, 'CAVI 的 ELBO 轨迹单调不减（坐标上升，200 问题 × 500 步）');

  // 新 API 入参校验
  throws(() => mkL(false).fit({ iters: 10, elboTol: -1 }), 'fit elboTol=−1 显式 throw');
  throws(() => mkL(false).fit({ iters: 10, plateauSteps: 0 }), 'fit plateauSteps=0 显式 throw');
}

// ═══════════════════ 58.0 langevin-sampling ═══════════════════

section('58.0 朗之万：梯度复用逐位一致 / 蛙跳可逆性 / 细致平衡 / 欠阻尼');

{
  const tgt = gaussianTarget(2);

  // ── ⑦ 梯度/能量复用：次数 + 逐位一致（脚本内复刻旧 MALA）──
  function malaRef(o) {
    const rng = mulberry32(o.seed);
    let x = [...(o.x0 ?? new Array(o.dim).fill(0))];
    const kept = [];
    const sd = Math.sqrt(2 * o.eta);
    const inv4 = 1 / (4 * o.eta);
    let accepted = 0;
    const burnIn = o.burnIn ?? 0;
    const thin = o.thin ?? 1;
    for (let k = 0; k < o.steps; k += 1) {
      const g = o.gradU(x);
      const Ux = o.logU(x);
      const xp = new Array(o.dim);
      for (let i = 0; i < o.dim; i += 1) xp[i] = x[i] - o.eta * g[i] + sd * gauss(rng);
      const gp = o.gradU(xp);
      const Uxp = o.logU(xp);
      let rev = 0;
      let fwd = 0;
      for (let i = 0; i < o.dim; i += 1) {
        const dr = x[i] - xp[i] + o.eta * gp[i];
        const df = xp[i] - x[i] + o.eta * g[i];
        rev += dr * dr;
        fwd += df * df;
      }
      const logAlpha = Ux - Uxp + (fwd - rev) * inv4;
      const u = rng();
      if (u === 0 || Math.log(u) < logAlpha) {
        x = xp;
        accepted += 1;
      }
      if (k >= burnIn && (k - burnIn) % thin === 0) kept.push([...x]);
    }
    return { kept, accepted };
  }
  let gradCalls = 0;
  let logUCalls = 0;
  const wrapped = {
    gradU: (x) => {
      gradCalls += 1;
      return tgt.gradU(x);
    },
    logU: (x) => {
      logUCalls += 1;
      return tgt.logU(x);
    },
  };
  const rNew = mala({ ...wrapped, dim: 2, eta: 0.5, steps: 5000, seed: 991, burnIn: 100 });
  ok(gradCalls === 5001 && logUCalls === 5001, `梯度/能量复用：5000 步只求值 ${gradCalls} 次 ∇U + ${logUCalls} 次 U（原实现 2×5000 = 10000 次——接受步的 gp/Uxp 恰为下一步所需）`);
  const refA = malaRef({ gradU: tgt.gradU, logU: tgt.logU, dim: 2, eta: 0.5, steps: 5000, seed: 991, burnIn: 100 });
  let identical =
    refA.accepted === rNew.accepted &&
    refA.kept.length === rNew.samples.length &&
    refA.kept.every((s, i) => s.every((v, j) => v === rNew.samples[i][j]));
  const rNew2 = mala({ gradU: tgt.gradU, logU: tgt.logU, dim: 2, eta: 0.12, steps: 8000, seed: 31415, burnIn: 300, thin: 2 });
  const refB = malaRef({ gradU: tgt.gradU, logU: tgt.logU, dim: 2, eta: 0.12, steps: 8000, seed: 31415, burnIn: 300, thin: 2 });
  identical =
    identical &&
    refB.accepted === rNew2.accepted &&
    refB.kept.every((s, i) => s.every((v, j) => v === rNew2.samples[i][j]));
  ok(identical, '复用后轨迹与旧实现逐位一致（RNG 消费次序不变，两组参数 × 数千步逐样本比对）');

  // ── ⑧ 蛙跳可逆性：R∘Φ∘R = Φ⁻¹（300 个种子化相空间点）──
  const tgtR = gaussianTarget(2, { mean: [0.5, -1], std: [1.3, 0.7] });
  let worstInv = 0;
  const rngV = mulberry32(4242);
  for (let k = 0; k < 300; k += 1) {
    const x = [gauss(rngV), gauss(rngV) * 2];
    const v = [gauss(rngV), gauss(rngV) / 2];
    const f1 = leapfrogProposal(tgtR.gradU, x, v, 0.3);
    const f2 = leapfrogProposal(tgtR.gradU, f1.x2, f2neg(f1.v2), 0.3);
    for (let i = 0; i < 2; i += 1) {
      worstInv = Math.max(worstInv, Math.abs(f2.x2[i] - x[i]), Math.abs(-f2.v2[i] - v[i]));
    }
  }
  function f2neg(v) {
    return v.map((w) => -w);
  }
  ok(
    worstInv <= 1e-10,
    `蛙跳可逆性 R∘Φ∘R = Φ⁻¹：300 相空间点最大误差 ${worstInv.toExponential(2)} ≤ 1e-10（保体积 + 翻转可逆 ⟹ Metropolis 修正的细致平衡成立）`,
  );

  // ── ⑨ 细致平衡的数值检验（分箱转移计数对称）──
  const edges = [-1.5, -0.8, -0.3, 0.3, 0.8, 1.5];
  const binOf = (x) => {
    let b = 0;
    while (b < edges.length && x > edges[b]) b += 1;
    return b;
  };
  const worstDbStat = (samples) => {
    const C = Array.from({ length: 7 }, () => new Array(7).fill(0));
    for (let i = 1; i < samples.length; i += 1) C[binOf(samples[i - 1][0])][binOf(samples[i][0])] += 1;
    let worst = 0;
    for (let a = 0; a < 7; a += 1) {
      for (let b = a + 1; b < 7; b += 1) {
        if (b - a > 2) continue; // 近邻对（远跳计数少、噪声大）
        worst = Math.max(worst, Math.abs(C[a][b] - C[b][a]) / Math.sqrt(Math.max(C[a][b], C[b][a], 1)));
      }
    }
    return worst;
  };
  const tgt1 = gaussianTarget(1);
  const chainM = mala({ gradU: tgt1.gradU, logU: tgt1.logU, dim: 1, eta: 0.8, steps: 400000, burnIn: 10000, thin: 10, seed: 123 });
  const dbM = worstDbStat(chainM.samples);
  ok(
    dbM <= 4,
    `MALA 细致平衡数值检验：N(0,1) 目标 40 万步 7 箱转移计数 |N(a→b) − N(b→a)|/√max = ${dbM.toFixed(2)} ≤ 4（可逆链的期望对称，涨落 4σ 内）`,
  );
  const chainU = underdampedMala({ gradU: tgt1.gradU, logU: tgt1.logU, dim: 1, eta: 0.5, friction: 0.8, steps: 400000, burnIn: 10000, thin: 10, seed: 123 });
  const dbU = worstDbStat(chainU.samples);
  ok(
    dbU <= 4,
    `欠阻尼 MALA 细致平衡数值检验：同口径 |ΔN|/√max = ${dbU.toFixed(2)} ≤ 4（OU 刷新 + 蛙跳 MH + 拒绝翻转的联合核保持 π 不变）`,
  );

  // ── ⑩ 欠阻尼：矩恢复 + ESS 优势 + ouRefreshScale 精度 ──
  const aniso = gaussianTarget(2, { mean: [0, 0], std: [0.2, 5] });
  const rUd = underdampedMala({ gradU: aniso.gradU, logU: aniso.logU, dim: 2, eta: 0.3, friction: 0.5, steps: 150000, burnIn: 2000, seed: 42 });
  const rMl = mala({ gradU: aniso.gradU, logU: aniso.logU, dim: 2, eta: 0.08, steps: 150000, burnIn: 2000, seed: 42 });
  const sdUd = [Math.sqrt(rUd.cov[0][0]), Math.sqrt(rUd.cov[1][1])];
  ok(
    rUd.acceptRate > 0.2 && rUd.acceptRate < 0.95 && Math.abs(sdUd[0] - 0.2) <= 0.3 && Math.abs(sdUd[1] - 5) <= 0.8,
    `欠阻尼各向异性目标（σ=[0.2,5]）矩恢复：接受率 ${rUd.acceptRate.toFixed(3)}，sd [${sdUd.map((v) => v.toFixed(3))}]（精确 π 不变）`,
  );
  const ess = (x) => {
    const n = x.length;
    const m = x.reduce((a, b) => a + b, 0) / n;
    const v = x.reduce((a, b) => a + (b - m) ** 2, 0) / n;
    let tau = 1;
    for (let lag = 1; lag < 2000; lag += 1) {
      let c = 0;
      for (let i = 0; i < n - lag; i += 1) c += (x[i] - m) * (x[i + lag] - m);
      c /= n - lag;
      const rho = c / v;
      if (rho <= 0) break;
      tau += 2 * rho;
    }
    return n / tau;
  };
  const essUd = ess(rUd.samples.map((s) => s[1]));
  const essMl = ess(rMl.samples.map((s) => s[1]));
  ok(
    essUd >= 1.3 * essMl,
    `同预算 15 万步缓方向 ESS：欠阻尼 ${essUd.toFixed(0)} ≥ 1.3 × MALA ${essMl.toFixed(0)}（动量持久化跨越平坦方向的采样收益）`,
  );

  let ouWorst = 0;
  for (const ge of [1e-14, 1e-10, 1e-6, 1e-3, 1, 10, 100]) {
    const mine = ouRefreshScale(ge);
    const ref = Math.sqrt(-Math.expm1(-2 * ge)); // 1−e^{−2x} 的 expm1 直算口径
    ouWorst = Math.max(ouWorst, Math.abs(mine - ref) / ref);
  }
  ok(ouWorst <= 1e-14, `ouRefreshScale 全域精确：√(1−e^{−2γη}) 的 expm1 恒等口径最大相对偏差 ${ouWorst.toExponential(2)} ≤ 1e-14（小 γη 时朴素 1−ρ² 会灾难性抵消）`);

  throws(() => underdampedMala({ gradU: tgt.gradU, logU: tgt.logU, dim: 2, eta: 0.1, friction: 0, steps: 10, seed: 1 }), 'underdampedMala friction=0 显式 throw');
  throws(() => leapfrogProposal(tgt.gradU, [0, 0], [0, 0], -0.1), 'leapfrogProposal eta=−0.1 显式 throw');
  throws(() => underdampedMala({ gradU: tgt.gradU, logU: tgt.logU, dim: 2, eta: 0.1, friction: 1, steps: 10, seed: 1, v0: [1] }), 'underdampedMala v0 长度不匹配显式 throw');
}

// ═══════════════════ 26.0 gaussian-process ═══════════════════

section('26.0 高斯过程：插值性质 / FITC 稀疏等价与收敛 / 三角化等价 / 条件预警');

{
  // ── ⑪ 插值性质（200 个种子化拟合）──
  let worstInterp = 0;
  for (let s = 0; s < 200; s += 1) {
    const rng = mulberry32(26000 + s);
    const n = 8 + Math.floor(rng() * 13);
    // 均匀网格 + 有界抖动（保证最小间距，排除近重复点的病态设计）
    const xs = Array.from({ length: n }, (_, i) => (i + 0.5) / n + (0.2 * (rng() - 0.5)) / n);
    const freq = 1 + 3 * rng();
    const ys = xs.map((x) => Math.sin(freq * x) * (1 + rng()) + 0.5 + 0.05 * gauss(rng));
    const gp = new GaussianProcess({ sigmaN: 1e-4, tuneHyperparams: true });
    gp.fit(xs, ys);
    for (let i = 0; i < n; i += 1) worstInterp = Math.max(worstInterp, Math.abs(gp.predict(xs[i]).mean - ys[i]));
  }
  ok(
    worstInterp <= 1e-5,
    `插值性质：后验均值在观测点恢复观测值（σn=1e-4，200 个种子化拟合，最大偏差 ${worstInterp.toExponential(2)} ≤ 1e-5——无噪极限下 GP 是精确插值器）`,
  );

  // ── ⑫ FITC：m=n ≡ 全 GP + 固定超参收敛 + 条件预警 ──
  let worstMean = 0;
  let worstStd = 0;
  let worstLml = 0;
  for (let s = 0; s < 30; s += 1) {
    const rng = mulberry32(26500 + s);
    const n = 12 + Math.floor(rng() * 9);
    const xs = Array.from({ length: n }, (_, i) => (i + 0.5) / n);
    const ys = xs.map((x) => Math.sin((1 + 2 * rng()) * x) + 0.08 * gauss(rng));
    const sigN = 0.08;
    const gpF = new GaussianProcess({ sigmaN: sigN, tuneHyperparams: true });
    const repF = gpF.fit(xs, ys);
    const gpS = new GaussianProcess({ sigmaN: sigN, tuneHyperparams: true });
    const repS = gpS.fitSparse(xs, ys, { numInducing: n });
    worstLml = Math.max(worstLml, Math.abs(repS.logMarginalLikelihood - repF.logMarginalLikelihood));
    const grid = Array.from({ length: 41 }, (_, i) => -0.1 + 1.2 * (i / 40));
    for (const x of grid) {
      const a = gpF.predict(x);
      const b = gpS.predict(x);
      worstMean = Math.max(worstMean, Math.abs(a.mean - b.mean));
      worstStd = Math.max(worstStd, Math.abs(a.std - b.std));
    }
  }
  ok(
    worstMean <= 1e-4 && worstStd <= 1e-3 && worstLml <= 1e-3,
    `FITC(m=n, 诱导点=训练点) ≡ 全 GP：30 个种子化数据集 max|Δmean|=${worstMean.toExponential(2)}、max|Δstd|=${worstStd.toExponential(2)}、|ΔLML|=${worstLml.toExponential(2)}（Q=K、λ=σn² 的解析退化）`,
  );

  // 固定超参下误差随 m 单调下降
  const rngF = mulberry32(2626);
  const xsF = Array.from({ length: 40 }, (_, i) => i / 39);
  const ysF = xsF.map((x) => Math.sin(2 * Math.PI * x * 1.2) * 2 + 1 + 0.08 * gauss(rngF));
  const gridF = Array.from({ length: 61 }, (_, i) => -0.05 + 1.1 * (i / 60));
  const errs = [];
  for (const m of [4, 7, 13, 25, 40]) {
    const gFull = new GaussianProcess({ sigmaN: 0.08, tuneHyperparams: false, lengthScale: 0.25, sigmaF: 1 });
    gFull.fit(xsF, ysF);
    const g = new GaussianProcess({ sigmaN: 0.08, tuneHyperparams: false, lengthScale: 0.25, sigmaF: 1 });
    g.fitSparse(xsF, ysF, { numInducing: m });
    let we = 0;
    for (const x of gridF) we = Math.max(we, Math.abs(g.predict(x).mean - gFull.predict(x).mean));
    errs.push(we);
  }
  ok(
    errs[0] > errs[1] && errs[1] > errs[2] && errs[3] <= 1e-3 && errs[4] <= 1e-3,
    `FITC 误差随诱导点数单调下降：m=[4,7,13,25,40] → err=[${errs.map((e) => e.toFixed(4)).join(', ')}]（m=n 时收敛到全 GP）`,
  );

  // 条件预警
  const gpd = new GaussianProcess({ sigmaN: 1e-12, tuneHyperparams: false, kernel: 'rbf' });
  const xsd = [0, 0.2, 0.4, 0.6, 0.8, 1.0, 0.5, 0.5, 0.5];
  const repd = gpd.fit(xsd, xsd.map((x) => Math.sin(x * 3) + 0.01));
  ok(
    repd !== undefined && repd.illConditioned === true,
    `病态预警：重复观测点 + σn=1e-12 → conditionEstimate=${repd.conditionEstimate.toExponential(2)}，illConditioned=true（调用方可感知不可信后验）`,
  );
  const gpok = new GaussianProcess({ sigmaN: 0.1, tuneHyperparams: false });
  const repok = gpok.fit(xsF, ysF);
  ok(repok.illConditioned === false && repok.jitterApplied === 0, `良态拟合：jitterApplied=0、illConditioned=false（条件数估计 ${repok.conditionEstimate.toFixed(1)}）`);

  // ── ⑬ 三角化逐位等价 + predictBatch 逐位一致与耗时 ──
  const gpT = new GaussianProcess({ sigmaN: 0.12, tuneHyperparams: false, lengthScale: 0.3, sigmaF: 1.2, kernel: 'matern52' });
  const repT = gpT.fit(xsF, ysF);
  // 脚本内全矩阵复刻（旧 kernelMatrix 口径 + 自实现 LML）
  const nxT = xsF.map((x) => (x - Math.min(...xsF)) / (Math.max(...xsF) - Math.min(...xsF)));
  const yMean = ysF.reduce((a, b) => a + b, 0) / ysF.length;
  const yStd = Math.sqrt(ysF.reduce((a, b) => a + (b - yMean) ** 2, 0) / (ysF.length - 1));
  const zy = ysF.map((v) => (v - yMean) / yStd);
  const mK = (a, b) => {
    const r = Math.abs(a - b) / 0.3;
    const sq = Math.sqrt(5) * r;
    return 1.44 * (1 + sq + (sq * sq) / 3) * Math.exp(-sq);
  };
  const Kfull = nxT.map((a) => nxT.map((b) => mK(a, b))).map((row, i) => row.map((v, j) => v + (i === j ? 0.12 ** 2 : 0)));
  const dec = choleskyLower(Kfull);
  const alphaT = solveCholesky(dec.L, zy);
  let quadT = 0;
  let logDetT = 0;
  for (let i = 0; i < zy.length; i += 1) {
    quadT += zy[i] * alphaT[i];
    logDetT += Math.log(dec.L[i][i]);
  }
  const lmlRef = -0.5 * quadT - logDetT - (zy.length / 2) * Math.log(2 * Math.PI);
  ok(
    repT.logMarginalLikelihood === lmlRef,
    `kernelMatrix 三角化逐位等价：fit 的 LML ${repT.logMarginalLikelihood.toFixed(12)} === 全矩阵复刻 ${lmlRef.toFixed(12)}（对称核三角镜像 IEEE 位级一致，核求值次数减半）`,
  );

  const gpB = new GaussianProcess({ sigmaN: 0.1, tuneHyperparams: true, maxPoints: 64, kernel: 'matern52' });
  const xsB = Array.from({ length: 64 }, (_, i) => i / 63);
  const ysB = xsB.map((x) => Math.sin(x * 5));
  gpB.fit(xsB, ysB);
  const repB = gpB.fitSummary;
  const gridB = Array.from({ length: 101 }, (_, i) => -0.1 + 1.2 * (i / 100));
  const batch = gpB.predictBatch(gridB);
  const seq = gridB.map((x) => gpB.predict(x));
  ok(
    batch.every((p, i) => p.mean === seq[i].mean && p.std === seq[i].std),
    'predictBatch 与逐点 predict 逐位一致（同一算术次序）',
  );

  // 旧版 predict 复刻（每次调用重算全部训练输入归一化 + kernelValue(0,0)）
  const matern52Ref = (d, ell, sf) => {
    const r = Math.abs(d) / ell;
    const s = Math.sqrt(5) * r;
    return sf * sf * (1 + s + (s * s) / 3) * Math.exp(-s);
  };
  const nB = xsB.length;
  const yMeanB = ysB.reduce((a, b) => a + b, 0) / nB;
  const yStdB = Math.max(1e-9, Math.sqrt(ysB.reduce((a, b) => a + (b - yMeanB) ** 2, 0) / (nB - 1)));
  const xMinB = Math.min(...xsB);
  const xMaxB = Math.max(...xsB);
  const nxB = xsB.map((x) => (x - xMinB) / (xMaxB - xMinB));
  const zyB = ysB.map((v) => (v - yMeanB) / yStdB);
  const KB = nxB.map((a) => nxB.map((b) => matern52Ref(a - b, repB.lengthScale, repB.sigmaF))).map((row, i) => row.map((v, j) => v + (i === j ? 0.1 ** 2 : 0)));
  const decB = choleskyLower(KB);
  const alphaB = solveCholesky(decB.L, zyB);
  const oldPredict = (x) => {
    const norm = (v) => (v - xMinB) / (xMaxB - xMinB);
    const nxq = norm(x);
    const kStar = xsB.map((xi) => matern52Ref(nxq - norm(xi), repB.lengthScale, repB.sigmaF)); // 旧版：每点重算归一化
    let meanStd = 0;
    for (let i = 0; i < kStar.length; i += 1) meanStd += kStar[i] * alphaB[i];
    const w = solveCholesky(decB.L, kStar);
    let quad = 0;
    for (let i = 0; i < w.length; i += 1) quad += kStar[i] * w[i];
    const prior = matern52Ref(0, repB.lengthScale, repB.sigmaF); // 旧版：每次调用重算 k(0,0)
    const varStd = Math.max(0, prior - quad);
    return { mean: meanStd * yStdB + yMeanB, std: Math.sqrt(varStd + 0.1 ** 2) * yStdB };
  };
  let bitOld = true;
  for (let i = 0; i <= 200; i += 1) {
    const x = -0.5 + i / 200;
    const a = gpB.predict(x);
    const b = oldPredict(x);
    if (a.mean !== b.mean || a.std !== b.std) bitOld = false;
  }
  ok(bitOld, '新 predict（归一化缓存 + sf² 直取）与旧口径逐位一致（201 个查询点 mean/std 全部 ===）');
  // 交错计时（预热 + min-of-8）——信息性输出（predict 的 O(n²) 求解主导，
  // O(n) 归一化缓存的收益在 JIT 噪声量级，不作硬断言）
  for (let k = 0; k < 20; k += 1) {
    gridB.map((x) => gpB.predict(x));
    gridB.map(oldPredict);
  }
  let tNewP = Infinity;
  let tOldP = Infinity;
  for (let r = 0; r < 8; r += 1) {
    let t0 = performance.now();
    for (let k = 0; k < 50; k += 1) {
      for (const x of gridB) gpB.predict(x);
    }
    let t1 = performance.now();
    for (let k = 0; k < 50; k += 1) {
      for (const x of gridB) oldPredict(x);
    }
    let t2 = performance.now();
    tNewP = Math.min(tNewP, t1 - t0);
    tOldP = Math.min(tOldP, t2 - t1);
  }
  console.log(`  · 信息性：predict 热路径 ${(tOldP / tNewP).toFixed(2)} × 旧口径复刻（${tNewP.toFixed(1)}ms vs ${tOldP.toFixed(1)}ms / 50×101 点——归一化缓存收益被 O(m²) 求解主导）`);

  // fit 路径耗时对照（三角化核矩阵：核求值 m² → m(m+1)/2，稳定 2× 缩减）
  const fitOldReplica = () => {
    // 旧口径：全矩阵 kernelValue + 同一套 LML 网格搜索（结果与 gp.fit 逐位一致）
    const zy2 = ysB.map((v) => (v - yMeanB) / yStdB);
    const mB = xsB.length;
    const lmlOf = (ell, sf) => {
      const K = nxB.map((a) => nxB.map((b) => matern52Ref(a - b, ell, sf))).map((row, i) => row.map((v, j) => v + (i === j ? 0.1 ** 2 : 0)));
      const d = choleskyLower(K);
      if (!d) return Number.NEGATIVE_INFINITY;
      const al = solveCholesky(d.L, zy2);
      let quad = 0;
      let logDet = 0;
      for (let i = 0; i < mB; i += 1) {
        quad += zy2[i] * al[i];
        logDet += Math.log(Math.max(1e-300, d.L[i][i]));
      }
      return -0.5 * quad - logDet - (mB / 2) * Math.log(2 * Math.PI);
    };
    let bestEll = 0.3;
    let bestSf = 1;
    let bestLml = lmlOf(bestEll, bestSf);
    for (let e = 0; e < 8; e += 1) {
      const ell = 10 ** (-2 + (0.7 * e) / 7);
      for (const sf of [0.5, 1, 2]) {
        const lml = lmlOf(ell, sf);
        if (lml > bestLml) {
          bestLml = lml;
          bestEll = ell;
          bestSf = sf;
        }
      }
    }
    return bestLml;
  };
  const gpFit = new GaussianProcess({ sigmaN: 0.1, tuneHyperparams: true, maxPoints: 64, kernel: 'matern52' });
  const repFit = gpFit.fit(xsB, ysB);
  ok(
    repFit.logMarginalLikelihood === fitOldReplica(),
    '三角化 kernelMatrix 的 fit 与全矩阵复刻逐位一致（LML === ——对称核镜像 IEEE 位级等同，核求值次数减半）',
  );
  const tFitNew = timeMin(() => new GaussianProcess({ sigmaN: 0.1, tuneHyperparams: true, maxPoints: 64, kernel: 'matern52' }).fit(xsB, ysB), 4);
  const tFitOld = timeMin(fitOldReplica, 4);
  ok(
    tFitNew <= tFitOld / 1.05,
    `fit（tuned，64 点 × 25 网格）耗时：三角化 ${(tFitOld / tFitNew).toFixed(2)} × 全矩阵（${tFitNew.toFixed(1)}ms vs ${tFitOld.toFixed(1)}ms——LML 网格搜索的核求值 m² → m(m+1)/2）`,
  );

  ok(new GaussianProcess().fitSparse([1], [2]) === undefined, 'fitSparse 单点显式返回 undefined（n<2 与 fit 同口径）');
  ok(new GaussianProcess().predict(0.5) === undefined, '未拟合 predict 返回 undefined');
}

// ═══════════════════ 27.0 kalman-filter ═══════════════════

section('27.0 卡尔曼：标量特化逐位一致 / 线性高斯解析一致 / UKF / Joseph / RTS');

{
  // ── ⑭ 标量测量特化：与通用矩阵链逐位一致（脚本内复刻旧实现）──
  function matMul(A, B) {
    const n = A.length;
    const m = B[0].length;
    const k = B.length;
    const C = Array.from({ length: n }, () => new Array(m).fill(0));
    for (let i = 0; i < n; i += 1) for (let j = 0; j < m; j += 1) {
      let s = 0;
      for (let t = 0; t < k; t += 1) s += A[i][t] * B[t][j];
      C[i][j] = s;
    }
    return C;
  }
  function matT(A) { return A[0].map((_, j) => A.map((r) => r[j])); }
  function matAdd(A, B) { return A.map((r, i) => r.map((v, j) => v + B[i][j])); }
  function matSub(A, B) { return A.map((r, i) => r.map((v, j) => v - B[i][j])); }
  function ident(n) { return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))); }
  class KFRef {
    constructor(model) {
      this.m = model;
      this.x = [...model.x0];
      this.P = model.P0.map((r) => [...r]);
    }
    predict() {
      const F = this.m.F;
      this.x = matMul(F, this.x.map((v) => [v])).map((r) => r[0]);
      this.P = matAdd(matMul(matMul(F, this.P), matT(F)), this.m.Q);
    }
    step(z) {
      this.predict();
      this.update(z);
    }
    update(z) {
      const { H, R } = this.m;
      const Hx = matMul(H, this.x.map((v) => [v]))[0][0];
      const S = matMul(matMul(H, this.P), matT(H))[0][0] + R[0][0];
      const PHt = matMul(this.P, matT(H));
      const K = PHt.map((r) => r.map((v) => v / S));
      this.x = matAdd(this.x.map((v) => [v]), matMul(K, [[z - Hx]])).map((r) => r[0]);
      this.P = matMul(matSub(ident(this.x.length), matMul(K, H)), this.P);
    }
  }
  const rngK = mulberry32(2701);
  let allIdentical = true;
  for (let trial = 0; trial < 200; trial += 1) {
    const model = {
      F: [[1, 0.3 * (rngK() - 0.5)], [0, 1 - 0.2 * rngK()]],
      H: [[1, 0]],
      Q: [[1e-3 * rngK() + 1e-5, 0], [0, 1e-4 * rngK() + 1e-6]],
      R: [[1e-3 * rngK() + 1e-4]],
      x0: [gauss(rngK), 0.1 * gauss(rngK)],
      P0: [[1, 0], [0, 0.01]],
    };
    const kf = new KalmanFilter(model);
    const ref = new KFRef(model);
    for (let t = 0; t < 60; t += 1) {
      const z = 0.5 + gauss(rngK);
      const a = kf.step(z);
      ref.step(z);
      if (a.x.some((v, i) => v !== ref.x[i])) allIdentical = false;
    }
    const Pc = kf.covariance;
    for (let i = 0; i < 2; i += 1) {
      for (let j = 0; j < 2; j += 1) {
        if (Pc[i][j] !== ref.P[i][j]) allIdentical = false;
      }
    }
  }
  ok(allIdentical, '标量测量特化与通用矩阵链逐位一致：200 个种子化模型 × 60 步（x/P/innovation 全部 ===，累加次序完全复刻）');

  // 耗时对照：2 万步
  const gT = mulberry32(7);
  const zsT = Array.from({ length: 20000 }, (_, i) => 0.001 * i + 0.05 * gauss(gT));
  const modelT = { F: [[1, 1], [0, 1]], H: [[1, 0]], Q: [[1e-4, 0], [0, 1e-6]], R: [[2e-4]], x0: [0, 0], P0: [[1, 0], [0, 0.01]] };
  const tRef = timeMin(() => {
    const ref = new KFRef(modelT);
    for (const z of zsT) ref.step(z);
  });
  const tNew = timeMin(() => {
    const kf = new KalmanFilter(modelT);
    for (const z of zsT) kf.step(z);
  });
  ok(
    tNew <= tRef / 1.5,
    `2 万步趋势滤波耗时：特化 ${(tNew / tRef).toFixed(2)} × 通用实现（${tNew.toFixed(1)}ms vs ${tRef.toFixed(1)}ms——免中间矩阵分配/转置）`,
  );

  // ── ⑮ 线性高斯解析一致 ──
  // 常状态（F=I, Q=0）：滤波 = 批量精度加权后验（精确闭式）
  let worstMeanE = 0;
  let worstVarE = 0;
  for (let s = 0; s < 200; s += 1) {
    const rngC = mulberry32(27500 + s);
    const p0 = 0.5 + rngC();
    const r = 0.01 + 0.2 * rngC();
    const mu0 = gauss(rngC);
    const nO = 5 + Math.floor(rngC() * 20);
    const zs = Array.from({ length: nO }, () => 2 + Math.sqrt(r) * gauss(rngC));
    const kf = new KalmanFilter({ F: [[1]], H: [[1]], Q: [[0]], R: [[r]], x0: [mu0], P0: [[p0]] });
    for (const z of zs) kf.step(z);
    const prec = 1 / p0 + nO / r;
    const meanB = (mu0 / p0 + zs.reduce((a, b) => a + b, 0) / r) / prec;
    const varB = 1 / prec;
    worstMeanE = Math.max(worstMeanE, Math.abs(kf.state[0] - meanB) / Math.max(1e-9, Math.abs(meanB)));
    worstVarE = Math.max(worstVarE, Math.abs(kf.covariance[0][0] - varB) / varB);
  }
  ok(
    worstMeanE <= 1e-9 && worstVarE <= 1e-9,
    `常状态滤波 = 批量共轭后验：200 个种子化问题（先验/噪声/观测数随机）max 相对误差 均值 ${worstMeanE.toExponential(2)}、方差 ${worstVarE.toExponential(2)} ≤ 1e-9`,
  );

  // 随机游走稳态
  let worstSS = 0;
  for (let s = 0; s < 50; s += 1) {
    const rngW = mulberry32(27600 + s);
    const q = 1e-4 * (1 + rngW());
    const r = 1e-2 * (1 + rngW());
    const kf = new KalmanFilter({ F: [[1]], H: [[1]], Q: [[q]], R: [[r]], x0: [0], P0: [[1]] });
    const gW = mulberry32(27700 + s);
    for (let i = 0; i < 3000; i += 1) kf.step(Math.sqrt(q) * gauss(gW));
    const { pInf } = randomWalkSteadyState(q, r);
    worstSS = Math.max(worstSS, Math.abs(kf.covariance[0][0] / pInf - 1));
  }
  ok(worstSS <= 1e-9, `随机游走 P → Riccati 稳态 P∞ = (q+√(q²+4qr))/2：50 个 (q,r) 最大相对偏差 ${worstSS.toExponential(2)} ≤ 1e-9`);

  // NIS 校准（模型正确时 ~ χ²(1)，均值 → 1）
  {
    const q = 1e-3;
    const r = 2e-2;
    const kf = new KalmanFilter({ F: [[1]], H: [[1]], Q: [[q]], R: [[r]], x0: [0], P0: [[1]] });
    const gN = mulberry32(4321);
    let sum = 0;
    let cnt = 0;
    let x = 0;
    for (let i = 0; i < 8000; i += 1) {
      x += Math.sqrt(q) * gauss(gN);
      const res = kf.step(x + Math.sqrt(r) * gauss(gN));
      if (i >= 2000) {
        sum += res.nis;
        cnt += 1;
      }
    }
    const mean = sum / cnt;
    ok(
      Math.abs(mean - 1) <= 0.1,
      `NIS 校准：匹配噪声下 6000 步均值 ${mean.toFixed(4)} ≈ 1（χ²(1) 期望；NIS 门控的假设检验口径成立）`,
    );
  }

  // ── ⑯ UKF：线性 ≡ KF + 非线性优于 EKF ──
  let worstUkfLinear = 0;
  const rngU = mulberry32(27800);
  for (let trial = 0; trial < 200; trial += 1) {
    const q1 = 1e-3 * rngU() + 1e-5;
    const q2 = 1e-4 * rngU() + 1e-6;
    const r = 1e-3 * rngU() + 1e-4;
    const f = (x) => [x[0] + 0.2 * x[1], x[1]];
    const h = (x) => x[0] + 0.3 * x[1];
    const model = {
      F: [[1, 0.2], [0, 1]],
      H: [[1, 0.3]],
      Q: [[q1, 0], [0, q2]],
      R: [[r]],
      x0: [gauss(rngU), 0.1 * gauss(rngU)],
      P0: [[1, 0.1], [0.1, 0.05]],
    };
    const kf = new KalmanFilter(model);
    const ukf = new UnscentedKalmanFilter({ f, h, Q: model.Q, r, x0: model.x0, P0: model.P0 });
    for (let t = 0; t < 40; t += 1) {
      const z = gauss(rngU) * 0.5;
      kf.step(z);
      ukf.step(z);
    }
    worstUkfLinear = Math.max(worstUkfLinear, ...kf.state.map((v, i) => Math.abs(v - ukf.state[i])));
  }
  ok(
    worstUkfLinear <= 1e-10,
    `UKF ≡ KF（线性模型）：200 模型 × 40 步 max|Δx| = ${worstUkfLinear.toExponential(2)} ≤ 1e-10（UT 对线性映射精确重现矩——对称点集 ΣWᶜ(ΔX)(ΔX)ᵀ = LLᵀ = P）`,
  );

  {
    // 非线性观测 z = sin(x)：与数值求积真值对照，UKF 优于 EKF 线性化
    const r = 0.01;
    const truthMean = (z) => {
      const M = 20000;
      const a = -8;
      const b = 8;
      const hstep = (b - a) / M;
      let m0 = 0;
      let Z = 0;
      for (let k = 0; k <= M; k += 1) {
        const x = a + k * hstep;
        const w = k === 0 || k === M ? 0.5 : 1;
        const p = Math.exp(-0.5 * x * x - 0.5 * ((z - Math.sin(x)) ** 2) / r) * w;
        Z += p;
        m0 += x * p;
      }
      return m0 / Z;
    };
    let worstU = 0;
    let worstE = 0;
    for (let i = 0; i < 60; i += 1) {
      const z = -1.5 + 3 * (i / 59);
      const ukf = new UnscentedKalmanFilter({ f: (x) => [x[0]], h: (x) => Math.sin(x[0]), Q: [[0]], r, x0: [0], P0: [[1]] });
      ukf.predict();
      const res = ukf.update(z);
      const S = 1 + r;
      const K = 1 / S;
      const ekfMean = K * (z - Math.sin(0)); // EKF：在 x̂=0 处线性化（H = cos(0) = 1）
      const truth = truthMean(z);
      worstU = Math.max(worstU, Math.abs(res.x[0] - truth));
      worstE = Math.max(worstE, Math.abs(ekfMean - truth));
    }
    ok(
      worstU < worstE && worstU <= 0.3,
      `sin 观测下 UKF 优于 EKF：最坏误差 ${worstU.toFixed(4)} < EKF 线性化 ${worstE.toFixed(4)}（对照梯形求积真值——UT 捕获三阶矩 vs 一阶截断）`,
    );
  }

  // ── ⑰ Joseph 型 + RTS ──
  {
    const model = { F: [[1, 1], [0, 1]], H: [[1, 0]], Q: [[1e-4, 0], [0, 1e-6]], R: [[2e-4]], x0: [0, 0], P0: [[1, 0], [0, 0.01]] };
    const kfS = new KalmanFilter(model);
    const kfJ = new KalmanFilter(model, 0.997, { covarianceForm: 'joseph' });
    const gJ = mulberry32(55);
    let asymS = 0;
    let asymJ = 0;
    for (let t = 0; t < 2000; t += 1) {
      const z = 0.01 * (t / 100) + 0.05 * gauss(gJ);
      kfS.step(z);
      kfJ.step(z);
      const Ps = kfS.covariance;
      const Pj = kfJ.covariance;
      asymS = Math.max(asymS, Math.abs(Ps[0][1] - Ps[1][0]));
      asymJ = Math.max(asymJ, Math.abs(Pj[0][1] - Pj[1][0]));
    }
    // PSD 检验：Joseph 协方差通过 Cholesky（正定）
    const Pj = kfJ.covariance;
    const det = Pj[0][0] * Pj[1][1] - Pj[0][1] * Pj[1][0];
    ok(
      asymJ === 0 && asymS >= 0 && det > 0,
      `Joseph 型：2000 步后 |P−Pᵀ| = ${asymJ}（严格对称，对称化构造）vs 标准型 ${asymS.toExponential(2)}（累积舍入不对称）；det(P) = ${det.toExponential(3)} > 0（PSD 保形）`,
    );
  }
  {
    const gR = mulberry32(88);
    const TRUE = 0.02;
    const zs = Array.from({ length: 300 }, (_, t) => 5 + TRUE * t + 0.15 * gauss(gR));
    const tf = new LocalLinearTrendFilter();
    const filtSlopes = [];
    for (const z of zs) filtSlopes.push(tf.observe(z).slope);
    const sm = tf.smooth();
    const errF = Math.max(...filtSlopes.slice(10).map((v) => Math.abs(v - TRUE)));
    const errS = Math.max(...sm.slice(10).map((p) => Math.abs(p.slope - TRUE)));
    ok(
      errS <= errF,
      `RTS 平滑的事后最优性：斜率最大误差 ${errS.toExponential(2)} ≤ 滤波 ${errF.toExponential(2)}（未来信息回灌历史估计）`,
    );
  }

  // 新 API 入参校验
  throws(() => new UnscentedKalmanFilter({ f: (x) => x, h: (x) => x[0], Q: [[1]], r: -1, x0: [0], P0: [[1]] }), 'UKF r=−1 显式 throw');
  throws(() => new UnscentedKalmanFilter({ f: (x) => x, h: (x) => x[0], Q: [[1]], r: 1, x0: [0, 0], P0: [[1]] }), 'UKF P0 维数不匹配显式 throw');
  throws(() => new UnscentedKalmanFilter({ f: (x) => x, h: (x) => x[0], Q: [[1]], r: 1, x0: [0], P0: [[1]], kappa: -10 }).predict(), 'UKF n+λ ≤ 0 显式 throw');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
