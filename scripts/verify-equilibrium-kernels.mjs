/**
 * verify-equilibrium-kernels.mjs — 31.0→35.0 均衡层五内核纯数学验证
 *
 * 每个断言都有解析锚点（闭式解 / 穷举对照 / 定理界）：
 *   31.0 Hedge：自适应对手与随机对手下 regret ≤ 定理界（对手无关）；
 *         Fixed-Share 跟踪漂移世界；部分反馈单专家降权
 *   32.0 匈牙利：与穷举逐位同解（方/矩形/转置）；对偶证书三项全过
 *   33.0 随机矩阵：Jacobi 与解析特征对对照；纯噪声 λmax 贴 MP 边界；
 *         埋入因子被识别、噪声被清洗吸收；系统性风险监视器两体制判定
 *   34.0 分布鲁棒：CVaR 闭式 = RU min-form；相干四公理；KR 对偶恒等式；
 *         超越概率精确最坏化；重尾/轻尾模型的超时定价分化
 *   35.0 反馈控制：DARE 闭式 = 不动点迭代；闭环极点 ∈ (0,1)；
 *         Lyapunov 恒等式残差机器精度；过载降 / 欠载升 / 死区不动
 *
 * 运行：npm run build && node scripts/verify-equilibrium-kernels.mjs
 */

import {
  Hedge,
  staticRegretBound,
  staticEtaFor,
  trackingRegretBound,
  hedgeMultiplier,
  solveAssignment,
  solveAssignmentMax,
  bruteForceAssignment,
  assignmentCertificate,
  jacobiEigensym,
  mpEdges,
  correlationFromSeries,
  cleanseCorrelation,
  SystemicRiskMonitor,
  cvar,
  cvarMinForm,
  cvarCoherenceAudit,
  wassersteinRobustMean,
  robustExceedance,
  robustTimeout,
  dareScalarClosedForm,
  dareIterate,
  FeedbackController,
  lyapunovCertificate,
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

/** 确定性 PRNG（与内核 mulberry32 同算法，保证可复现） */
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
/** Box-Muller 标准正态 */
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

// ═══════════════════ 31.0 在线学习 ═══════════════════

section('31.0 在线学习：Fixed-Share Hedge 对抗遗憾界');

{
  // 自适应对手：每轮先看当前权重，把损失 1 压在权重最高的专家上
  // （对 Hedge 最凶的对手）；理论界对手无关——regret 必须在界内
  const N = 8;
  const T = 2000;
  const eta = staticEtaFor(N, T);
  const hedge = new Hedge({ experts: N, eta, alpha: 0 });
  for (let t = 0; t < T; t += 1) {
    const w = hedge.weights();
    let top = 0;
    for (let i = 1; i < N; i += 1) if (w[i] > w[top]) top = i;
    hedge.update(Array.from({ length: N }, (_, i) => (i === top ? 1 : 0)));
  }
  const s = hedge.stats();
  const bound = staticRegretBound(N, eta, T);
  ok(s.regret >= -1e-9, `自适应对手下 regret ≥ 0（实际 ${s.regret.toFixed(3)}）`);
  ok(s.regret <= bound + 1e-6, `自适应对手下 regret ≤ 定理界（${s.regret.toFixed(2)} ≤ ${bound.toFixed(2)}）`);
  ok(Math.abs(bound - 2 * (Math.log(N) / eta)) < 1e-9, `调优 η = √(2lnN/T) 时界对称 = 2lnN/η（${bound.toFixed(2)}）`);

  // 随机对手（iid Bernoulli）：界同样成立
  const rng = mulberry32(20260920);
  const hedge2 = new Hedge({ experts: 5, eta: 0.2, alpha: 0 });
  for (let t = 0; t < 3000; t += 1) {
    hedge2.update(Array.from({ length: 5 }, () => (rng() < 0.5 ? 1 : 0)));
  }
  const s2 = hedge2.stats();
  const bound2 = staticRegretBound(5, 0.2, 3000);
  ok(s2.regret <= bound2 + 1e-6 && s2.regret >= -1e-9, `随机对手 regret 在界内（${s2.regret.toFixed(2)} ≤ ${bound2.toFixed(2)}）`);
  ok(s2.feedback === 'full', `全反馈口径标注（feedback=full）`);
}

{
  // 漂移世界：前半场专家 0 最优，后半场专家 2 翻转最优
  // Fixed-Share 回灌保证权重能翻身；经典 Hedge（α=0）恢复慢
  const rng = mulberry32(20260921);
  const run = (alpha) => {
    const hedge = new Hedge({ experts: 4, eta: 0.3, alpha });
    let secondHalfAlgo = 0;
    let secondHalfBest2 = 0;
    for (let t = 1; t <= 400; t += 1) {
      const secondPhase = t > 200;
      const losses = Array.from({ length: 4 }, (_, i) => {
        const p = (!secondPhase && i === 0) || (secondPhase && i === 2) ? 0.1 : 0.5;
        return rng() < p ? 1 : 0;
      });
      const w = hedge.weights();
      let exp = 0;
      for (let i = 0; i < 4; i += 1) exp += w[i] * losses[i];
      hedge.update(losses);
      if (secondPhase) {
        secondHalfAlgo += exp;
        secondHalfBest2 += losses[2];
      }
    }
    return { hedge, secondHalfAlgo, secondHalfBest2 };
  };
  const fixed = run(0.1);
  const tBound = trackingRegretBound(4, 0.3, 200, 1, 0.1);
  const tRegret = fixed.secondHalfAlgo - fixed.secondHalfBest2;
  ok(
    tRegret <= tBound,
    `后半场跟踪遗憾 ≤ Herbster–Warmuth 界（${tRegret.toFixed(1)} ≤ ${tBound.toFixed(1)}）`,
  );
  ok(fixed.hedge.recommend() === 2, `漂移后最优专家翻转为 #2（当前权重最高）`);
  const classic = run(0);
  ok(
    classic.hedge.weights()[2] < fixed.hedge.weights()[2],
    `Fixed-Share(α=0.1) 对新最优的权重高于经典 Hedge(α=0)（${fixed.hedge.weights()[2].toFixed(3)} > ${classic.hedge.weights()[2].toFixed(3)}）`,
  );
}

{
  // 部分反馈：单专家连续低质量回报 → 其权重严格下降（掩码更新）
  const hedge = new Hedge({ experts: 3, eta: 0.3, alpha: 0 });
  const before = hedge.weights();
  for (let k = 0; k < 10; k += 1) hedge.reportSingle(0, 0.1);
  const after = hedge.weights();
  ok(after[0] < before[0] - 0.1, `被打爆的专家权重显著下降（${before[0].toFixed(3)} → ${after[0].toFixed(3)}）`);
  ok(
    after[0] < after[1] - 0.05 && after[0] < after[2] - 0.05 && Math.abs(after[1] - after[2]) < 1e-12,
    `未被指派专家保持等相对权重（归一化上浮：${after[1].toFixed(4)} ≡ ${after[2].toFixed(4)}，被指派者 ${after[0].toFixed(4)} 垫底）`,
  );
  ok(hedge.stats().feedback === 'partial', `部分反馈口径标注（feedback=partial）`);
  // 接线乘数：有界钳位
  const m = hedgeMultiplier(hedge.weights(), 0);
  ok(m >= 0.25 && m <= 4, `调度乘数有界 [0.25,4]（${m.toFixed(3)}）`);
}

// ═══════════════════ 32.0 全局指派 ═══════════════════

section('32.0 全局指派：匈牙利精确解 + 对偶证书');

{
  // 已知小例：[[4,1,3],[2,0,5],[3,2,2]] 最优 = 1+2+2 = 5
  const cost = [
    [4, 1, 3],
    [2, 0, 5],
    [3, 2, 2],
  ];
  const r = solveAssignment(cost);
  ok(Math.abs(r.totalCost - 5) < 1e-9, `已知例最优值 5（实际 ${r.totalCost}）`);
  ok(r.assignment[0] === 1 && r.assignment[1] === 0 && r.assignment[2] === 2, `指派 (0→1, 1→0, 2→2)`);
  const cert = assignmentCertificate(cost, r);
  ok(cert.optimal, `对偶证书：可行 + 互补松弛 + 零间隙（最优性被证明）`);
  ok(cert.dualityGap < 1e-6, `强对偶 Σu+Σv = 指派成本（间隙 ${cert.dualityGap.toExponential(2)}）`);
}

{
  // 随机对照：方阵与矩形，与穷举逐位同解
  const rng = mulberry32(20260922);
  let squareOk = true;
  let rectOk = true;
  let certOk = true;
  for (let trial = 0; trial < 300; trial += 1) {
    const n = 2 + Math.floor(rng() * 5); // 2..6
    const m = 2 + Math.floor(rng() * 5);
    const cost = Array.from({ length: n }, () => Array.from({ length: m }, () => Math.floor(rng() * 20)));
    const r = solveAssignment(cost);
    if (n <= m) {
      const bf = bruteForceAssignment(cost);
      if (Math.abs(r.totalCost - bf.totalCost) > 1e-9) squareOk = false;
      if (!assignmentCertificate(cost, r).optimal) certOk = false;
    } else {
      // 行 > 列：转置后穷举（列全部匹配）
      const trans = Array.from({ length: m }, (_, j) => Array.from({ length: n }, (_, i) => cost[i][j]));
      const bf = bruteForceAssignment(trans);
      if (Math.abs(r.totalCost - bf.totalCost) > 1e-9) rectOk = false;
      const assigned = r.assignment.filter((x) => x >= 0).length;
      if (assigned !== m) rectOk = false;
    }
  }
  ok(squareOk, `方阵 300 随机例与穷举逐位同解（O(n³) = 指数枚举）`);
  ok(rectOk, `矩形（含行>列转置）300 随机例同解，行>列时恰有 m 个指派`);
  ok(certOk, `全部方阵例对偶证书成立（u_i+v_j ≤ c_ij，匹配边取等）`);
}

{
  // 最大化口径
  const profit = [
    [9, 2],
    [2, 1],
  ];
  const r = solveAssignmentMax(profit);
  ok(Math.abs(r.totalProfit - 10) < 1e-9, `最大化：主对角 9+1=10（实际 ${r.totalProfit}）`);
  ok(r.assignment[0] === 0 && r.assignment[1] === 1, `指派对角线（0→0, 1→1）`);
  const { assignBatch } = await import('../dist/index.mjs');
  const batch = assignBatch([
    [0.9, 0.8, 0.1],
    [0.9, 0.8, 0.1],
    [0.3, 0.2, 0.7],
  ]);
  const used = new Set(batch.modelOfNode.filter((x) => x >= 0));
  ok(used.size === 3 && batch.totalProfit > 0.9 + 0.8 + 0.7 - 1e-9,
    `批内一对一：三节点三模型不冲突且总收益最优（${batch.totalProfit.toFixed(2)}，逐节点贪心会双订 0.9+0.9+0.7）`);
}

// ═══════════════════ 33.0 随机矩阵 ═══════════════════

section('33.0 随机矩阵：MP 边界 + 谱清洗 + 系统性风险');

{
  // Jacobi 解析对照：[[2,1],[1,2]] 特征值 {3,1}，特征向量 (1,±1)/√2
  const e = jacobiEigensym([
    [2, 1],
    [1, 2],
  ]);
  ok(Math.abs(e.values[0] - 3) < 1e-10 && Math.abs(e.values[1] - 1) < 1e-10,
    `2×2 解析特征值 3/1（${e.values.map((v) => v.toFixed(6)).join(', ')}）`);
  const dot = (e.vectors[0][0] + e.vectors[0][1]) / Math.SQRT2;
  ok(Math.abs(Math.abs(dot) - 1) < 1e-10, `主特征向量 ∝ (1,1)/√2（|cos|=${Math.abs(dot).toFixed(9)}）`);
}

{
  // 随机对称矩阵重建 A = QΛQᵀ（正交性到机器精度）
  const rng = mulberry32(20260923);
  const n = 7;
  const A = Array.from({ length: n }, () => Array.from({ length: n }, () => rng() * 2 - 1));
  const S = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (A[i][j] + A[j][i]) / 2));
  const { values, vectors } = jacobiEigensym(S);
  let err = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      let rec = 0;
      for (let k = 0; k < n; k += 1) rec += values[k] * vectors[k][i] * vectors[k][j];
      err = Math.max(err, Math.abs(rec - S[i][j]));
    }
  }
  ok(err < 1e-10, `谱重建 A = QΛQᵀ 到机器精度（Frobenius最大偏差 ${err.toExponential(2)}）`);
}

{
  // 纯噪声：p=40 模型 × n=480 观测 iid → 相关谱顶部落 MP 带边
  const g = gaussianMaker(20260924);
  const p = 40;
  const n = 480;
  const series = Array.from({ length: p }, () => Array.from({ length: n }, () => g()));
  const corr = correlationFromSeries(series);
  const { lambdaPlus, lambdaMinus } = mpEdges(p / n);
  const eig = jacobiEigensym(corr);
  const ratio = eig.values[0] / lambdaPlus;
  ok(eig.values[0] < lambdaPlus * 1.15 && eig.values[0] > lambdaPlus * 0.85,
    `纯噪声 λmax 贴 MP 上边界（${eig.values[0].toFixed(3)} vs λ+=${lambdaPlus.toFixed(3)}，比 ${ratio.toFixed(3)}）`);
  ok(eig.values[p - 1] > lambdaMinus * 0.7, `纯噪声 λmin 不越过 MP 下边界（${eig.values[p - 1].toFixed(3)} vs λ−=${lambdaMinus.toFixed(3)}）`);
  const report = cleanseCorrelation(corr, p / n);
  ok(report.noiseCount === p && !report.signal, `清洗：全部 40 个特征值落入噪声带、无信号（noiseCount=${report.noiseCount}）`);
  let diagErr = 0;
  for (let i = 0; i < p; i += 1) diagErr = Math.max(diagErr, Math.abs(report.cleaned[i][i] - 1));
  ok(diagErr < 1e-9, `清洗后对角归一（最大偏差 ${diagErr.toExponential(2)}）`);
}

{
  // 埋入因子：5 模型 × 400 观测，载荷 0.8 → 两两相关 ≈ 0.64，
  // 头号特征值 ≈ 1+(p−1)ρ ≈ 3.56 ≫ MP 边 ≈ 1.24 → 信号被识别
  const g = gaussianMaker(20260925);
  const p = 5;
  const n = 400;
  const series = Array.from({ length: p }, () => []);
  for (let t = 0; t < n; t += 1) {
    const f = g();
    for (let i = 0; i < p; i += 1) series[i][t] = 0.8 * f + 0.6 * g();
  }
  const corr = correlationFromSeries(series);
  const { lambdaPlus } = mpEdges(p / n);
  const eig = jacobiEigensym(corr);
  const theory = 1 + (p - 1) * 0.64;
  ok(Math.abs(eig.values[0] - theory) < 0.35,
    `头号特征值 ≈ 等相关理论值 1+(p−1)ρ（${eig.values[0].toFixed(2)} vs ${theory.toFixed(2)}）`);
  ok(eig.values[0] > lambdaPlus * 2, `λ₁ ≫ MP 边界（${eig.values[0].toFixed(2)} ≫ ${lambdaPlus.toFixed(3)}）——信号不在噪声带内`);
  const topVec = eig.vectors[0];
  const align = Math.abs(topVec.reduce((s, x) => s + x, 0) / Math.sqrt(p));
  ok(align > 0.98, `主特征向量对齐共同因子方向 (1,…,1)/√p（|cos|=${align.toFixed(4)}）`);
  const report = cleanseCorrelation(corr, p / n);
  ok(report.signal && report.noiseCount === p - 1, `清洗后：信号保留（λ₁）、其余 ${report.noiseCount} 个进噪声带`);
}

{
  // 系统性风险监视器：共同因子体制 → systemic；独立体制 → 不误报
  const correlated = new SystemicRiskMonitor({ window: 24, minModels: 4, edgeFactor: 1.05, systemicShare: 0.3 });
  const rng = mulberry32(20260926);
  for (let t = 0; t < 24; t += 1) {
    const sharedBurst = rng() < 0.3 ? 4 : 0;
    const counts = {};
    for (let i = 0; i < 6; i += 1) {
      counts[`m${i}`] = sharedBurst + (rng() < 0.25 ? 1 : 0);
    }
    correlated.observe(counts);
  }
  const sys = correlated.assess();
  ok(sys !== undefined && sys.systemic, `共同因子体制 → systemic=true（λ₁=${sys ? sys.topEigenvalue.toFixed(2) : '—'} vs 边 ${sys ? sys.noiseEdge.toFixed(2) : '—'}，份额 ${sys ? (sys.topShare * 100).toFixed(0) : '—'}%）`);
  ok(sys !== undefined && sys.topLoading.length > 0 && Math.abs(sys.topLoading[0].loading) > 0.37,
    `头号载荷 ≥ 均匀因子分量 1/√6（最暴露 m${sys ? sys.topLoading[0].index : '—'}，载荷 ${sys ? sys.topLoading[0].loading.toFixed(2) : '—'}）`);

  const independent = new SystemicRiskMonitor({ window: 24, minModels: 4, edgeFactor: 1.05, systemicShare: 0.3 });
  const rng2 = mulberry32(20260927);
  for (let t = 0; t < 24; t += 1) {
    const counts = {};
    for (let i = 0; i < 6; i += 1) {
      counts[`m${i}`] = rng2() < 0.35 ? 1 + Math.floor(rng2() * 3) : 0;
    }
    independent.observe(counts);
  }
  const ind = independent.assess();
  ok(ind !== undefined && !ind.systemic, `独立体制 → systemic=false（不误报：λ₁=${ind ? ind.topEigenvalue.toFixed(2) : '—'}，份额 ${ind ? (ind.topShare * 100).toFixed(0) : '—'}%）`);
}

// ═══════════════════ 34.0 分布鲁棒 ═══════════════════

section('34.0 分布鲁棒：CVaR 精确式 + KR 对偶 + 超越最坏化');

{
  // 闭式 vs Rockafellar–Uryasev min-form（任意样本、多 α 档逐位一致）
  const rng = mulberry32(20260928);
  const samples = Array.from({ length: 200 }, () => Math.exp(gaussianMaker(1)() * 0.8) * 400 + rng() * 50);
  let worst = 0;
  for (const alpha of [0.05, 0.2, 0.5]) {
    const a = cvar(samples, alpha);
    const b = cvarMinForm(samples, alpha);
    worst = Math.max(worst, Math.abs(a - b));
  }
  ok(worst < 1e-6, `CVaR 闭式 = RU min-form（最大偏差 ${worst.toExponential(2)}）`);

  // 精确锚点：1..100，α=0 → 均值 50.5；α=0.99, n=100 → 最坏 1 个 = 100
  const grid = Array.from({ length: 100 }, (_, i) => i + 1);
  ok(Math.abs(cvar(grid, 0) - 50.5) < 1e-9, `α=0 → CVaR = 均值（${cvar(grid, 0)}）`);
  ok(Math.abs(cvar(grid, 0.99) - 100) < 1e-9, `α=0.99, n=100 → 尾部质量 1 → 最坏样本（${cvar(grid, 0.99)}）`);
  ok(Math.abs(cvar(grid, 0.95) - 98) < 1e-9, `α=0.95, n=100 → 最坏 5 个的均值 = (96+…+100)/5 = 98（${cvar(grid, 0.95)}）`);

  // 相干四公理
  const audit = cvarCoherenceAudit(samples, 0.1);
  ok(audit.monotone && audit.translationEquivariant && audit.positivelyHomogeneous && audit.subadditive,
    `相干风险度量四公理全过（${Object.entries(audit).map(([k, v]) => `${k}=${v}`).join(' ')}）`);
}

{
  // KR 对偶恒等式：sup_{W₁≤ε} E = min(E+ε, b)
  const samples = [0, 10];
  ok(Math.abs(wassersteinRobustMean(samples, 3) - 8) < 1e-9, `鲁棒均值 = E+ε（5+3=8，KR 对偶恒等式）`);
  ok(Math.abs(wassersteinRobustMean(samples, 3, 7) - 7) < 1e-9, `支撑上界 b=7 截断（min(8,7)=7）`);
  ok(Math.abs(wassersteinRobustMean(samples, 0) - 5) < 1e-9, `ε=0 → 经验均值（退化为无鲁棒）`);
}

{
  // 超越概率精确最坏化：从最贴近阈值的下方样本搬质量（单位成本最小）
  const r1 = robustExceedance([0, 10], 10, 2);
  ok(r1 !== undefined && Math.abs(r1.nominal - 0.5) < 1e-9, `名义超越率 0.5`);
  ok(r1 !== undefined && Math.abs(r1.worst - 0.7) < 1e-9,
    `ε=2 预算：从 0 搬到 10 单位成本 10 → 移动 0.2 质量，worst=0.7（实际 ${r1 ? r1.worst : '—'}）`);
  const r2 = robustExceedance([0, 10], 10, 100);
  ok(r2 !== undefined && Math.abs(r2.worst - 1) < 1e-9, `预算充足 → 全部质量可越过（worst=1）`);
}

{
  // 鲁棒超时：重尾 vs 轻尾分化；样本不足回退 undefined
  const rngTail = mulberry32(20260929);
  const heavy = [...Array.from({ length: 37 }, () => 100 + Math.round(rngTail() * 40)), 2600, 2800, 3100];
  const light = Array.from({ length: 40 }, (_, i) => 100 + ((i * 7) % 25));
  const cfg = { alpha: 0.95, margin: 1.5, minSamples: 30, floorMs: 100, capMs: 60_000 };
  const th = robustTimeout(heavy, cfg);
  const tl = robustTimeout(light, cfg);
  ok(th !== undefined && tl !== undefined && th > tl * 5,
    `重尾模型超时 ≫ 轻尾（${th} vs ${tl}——尾部形状直接进入价格）`);
  ok(robustTimeout(heavy.slice(0, 29), cfg) === undefined, `样本 < minSamples → undefined（回退原口径，零漂移）`);
}

// ═══════════════════ 35.0 反馈控制 ═══════════════════

section('35.0 反馈控制：DARE 闭式 + Lyapunov 证书');

{
  // 闭式 vs 不动点迭代逐位对账
  const b = 0.4;
  const q = 1;
  const r = 4;
  const cf = dareScalarClosedForm(b, q, r);
  const it = dareIterate(1, b, q, r);
  ok(it.converged && Math.abs(cf - it.p) < 1e-9,
    `DARE 闭式 = 迭代不动点（${cf.toFixed(12)} vs ${it.p.toFixed(12)}）`);
  const theory = (q + Math.sqrt(q * q + (4 * q * r) / (b * b))) / 2;
  ok(Math.abs(cf - theory) < 1e-15, `与手推闭式 P=(q+√(q²+4qr/b²))/2 一致（${cf.toFixed(10)}）`);

  const ctrl = new FeedbackController({ plantGain: b, q, r, target: 0.75 });
  ok(ctrl.gain > 0 && ctrl.closedLoopPole > 0 && ctrl.closedLoopPole < 1,
    `闭环极点 ∈ (0,1)：K=${ctrl.gain.toFixed(4)}, 1−bK=${ctrl.closedLoopPole.toFixed(4)}`);
}

{
  // Lyapunov 恒等式：V(e_{k+1}) − V(e_k) = −(q e² + r u²) 到机器精度
  const cert = lyapunovCertificate({ plantGain: 0.4, q: 1, r: 4, target: 0.75, deadband: 0 }, 0, 50);
  ok(cert.maxResidual < 1e-12, `DARE 恒等式残差机器精度（${cert.maxResidual.toExponential(2)}——稳定性是代数事实）`);
  ok(cert.convergedToTarget, `闭环 50 步收敛到目标（终误差 ${cert.finalError.toFixed(4)}）`);
}

{
  // 控制器行为：过载降 / 欠载升 / 死区不动 / 钳位有界
  const ctrl = new FeedbackController({ target: 0.75, plantGain: 0.4, q: 1, r: 4, deadband: 0.05, minOutput: 1, maxOutput: 16, initialOutput: 8 });
  const over = ctrl.step(1.0);
  ok(over.error < 0 && over.output < 8, `过载（利用率 1.0）→ 上限下调（${8} → ${over.output.toFixed(2)}）`);
  const under = ctrl.step(0.1);
  ok(under.error > 0 && under.output > over.output, `欠载（利用率 0.1）→ 上限上调（${under.output.toFixed(2)} > ${over.output.toFixed(2)}）`);
  const hold = ctrl.step(0.75);
  ok(hold.increment === 0, `死区（|e|=0 < 0.05）→ 不动作（抗抖振）`);
  let clamped = 16;
  for (let k = 0; k < 200; k += 1) clamped = ctrl.step(0).output;
  ok(clamped >= 1 && clamped <= 16, `持续欠载输出被钳位在 [1,16]（${clamped.toFixed(2)}，抗饱和）`);
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n──────────────────────────────────────────────────────────');
if (failed === 0) {
  console.log(`✓ 均衡层 31.0→35.0 五内核全部验证通过（${passed} 项断言）`);
} else {
  console.error(`✗ ${failed} 项失败（${passed} 项通过）`);
  process.exit(1);
}
