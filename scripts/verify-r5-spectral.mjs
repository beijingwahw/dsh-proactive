/**
 * verify-r5-spectral.mjs — R5-A11「谱方法六内核世界性进化」纯数学离线验证
 *
 * 覆盖内核（进化轴：数学 / 性能 / 数值稳健性 / 性质测试，种子化 ≥ 200 输入）：
 *   39.0 spectral-ranking: 个性化 PageRank（重启随机游走）的局部性；
 *       幂迭代 vs 不动点直接解（含悬挂节点）200 种子对照；稀疏列幂迭代
 *       与稠密参考逐位等价 + 大图耗时对照；悬挂双重计数修复（旧口径
 *       幂迭代≠直接解，新口径 < 1e-8）；NaN 护栏
 *   33.0 random-matrix: MP 解析密度质量 = 1（自适应 Simpson）；噪声谱
 *       KS 通过 / 因子谱 KS 拒绝；KS 缓存表 vs 精确积分等价 + 计时；
 *       Kolmogorov 余分布锚点；Airy Ai 解析锚点；Tracy–Widom TW1/TW2
 *       分位数与矩锚点（Painlevé II BVP 数值解）；Johnstone 边缘标准化
 *       的噪声/信号判别；Jacobi 对称镜像旋转 vs 两遍参考等价 + 计时；
 *       平局确定性
 *   50.0 matrix-completion: Gavish–Donoho 最优硬阈值（known-σ 4/√3 与
 *       2.858·中位数两规则）：keep = 真秩、NMSE ≪ keep-all（60 种子）；
 *       k 折交叉验证秩选择（良态秩 2 与近秩 1 两口径）；谱初始化迭代
 *       数收益；旧收敛口径逐位保留（零漂移）+ 严格口径 opt-in；空观测护栏
 *   49.0 multiscale-wavelet: Daubechies D4 精确代数系数（Σc=2、Σc²=2、
 *       消失矩、平移正交）；Haar/D4 完美重构 + Parseval（200 种子）；
 *       线性趋势内部泄漏 D4 ≈ 0（两阶消失矩）；模极大值 Lipschitz
 *       （阶跃/尖点/折点 120 个奇异性构造）；NaN 净化；原地化逐位等价
 *       + 128K 计时
 *   78.0 canonical-correlation: 核 CCA——线性核谱 ≡ 线性 CCA（口径
 *       不变性）；Y = X² 的非线性依赖（线性 ρ 小、RBF ρ 大）20 种子；
 *       典型变量正交；Jacobi 镜像旋转等价 + 计时；平局确定性
 *   79.0 diffusion-maps: 多尺度 t 扫描与逐个调用逐位一致（20 种子）；
 *       簇间/簇内扩散距离分辨率随 t 单调；谱半径 |λ| ≤ 1；地标扩散
 *       自洽（精确）、与全谱版坐标 |corr| > 0.9、三团分类 100%、孤立点
 *       诚实报告；扫描/地标耗时对照
 *
 * 全部断言确定性（mulberry32 种子；无 Math.random/Date.now 参与判定）。
 * 运行：node --experimental-transform-types scripts/verify-r5-spectral.mjs
 */

import {
  pageRank,
  personalizedPageRank,
  pageRankDirect,
} from '../src/core/spectral-ranking.ts';
import {
  jacobiEigensym,
  mpEdges,
  mpCdf,
  mpKsTest,
  kolmogorovComplementary,
  airyAi,
  tracyWidom1Cdf,
  tracyWidom1Quantile,
  tracyWidom2Cdf,
  edgeStandardScore,
  correlationFromSeries,
} from '../src/core/random-matrix.ts';
import {
  completeMatrix,
  completedEntry,
  svdHardThresholdDenoise,
  selectRank,
} from '../src/core/matrix-completion.ts';
import {
  haarDecompose,
  haarReconstruct,
  daubechies4Decompose,
  daubechies4Reconstruct,
  daubechies4Filter,
  singularityLipschitz,
} from '../src/core/multiscale-wavelet.ts';
import {
  cca,
  kernelCCA,
  jacobiEigen,
} from '../src/core/canonical-correlation.ts';
import {
  diffusionMaps,
  diffusionScaleSweep,
  diffusionDistance,
  landmarkDiffusion,
  twoMoons,
  swissRoll,
  nearestCentroidClassify,
  mulberry32,
} from '../src/core/diffusion-maps.ts';

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
function gaussMaker(seed) {
  const rng = mulberry32(seed);
  return () => {
    let u1 = rng();
    while (u1 <= 1e-12) u1 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
  };
}
function corr(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < a.length; i += 1) {
    sxy += (a[i] - ma) * (b[i] - mb);
    sxx += (a[i] - ma) ** 2;
    syy += (b[i] - mb) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy + 1e-300);
}

// ═══════════════════ 39.0 谱排序 ═══════════════════

section('39.0 谱排序：个性化 PageRank + 不动点直接解 + 稀疏幂迭代');

{
  // 旧锚点复验（零回归）：环图精确均匀
  const ring = pageRank(['a', 'b', 'c', 'd'], [
    [0, 1, 0, 1],
    [1, 0, 1, 0],
    [0, 1, 0, 1],
    [1, 0, 1, 0],
  ]);
  ok(ring.converged && ring.scores.every((s) => Math.abs(s - 0.25) < 1e-8), '环图 → 精确均匀（旧锚点零回归）');

  // 幂迭代 vs 不动点直接解：200 种子随机图（含悬挂行）
  let maxDiff = 0;
  let maxSumErr = 0;
  for (let rep = 0; rep < 200; rep += 1) {
    const rng = mulberry32(41000 + rep);
    const n = 5 + Math.floor(rng() * 26);
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    const W = Array.from({ length: n }, () => Array.from({ length: n }, () => (rng() < 0.25 ? rng() : 0)));
    for (let i = 0; i < n; i += 1) W[i][i] = 0;
    if (rep % 3 === 0) {
      W[0] = Array(n).fill(0);
      W[1] = Array(n).fill(0);
    }
    const pw = pageRank(ids, W, { tol: 1e-12, maxIterations: 4000 });
    const dr = pageRankDirect(ids, W);
    for (let i = 0; i < n; i += 1) maxDiff = Math.max(maxDiff, Math.abs(pw.scores[i] - dr.scores[i]));
    maxSumErr = Math.max(maxSumErr, Math.abs(pw.scores.reduce((s, v) => s + v, 0) - 1));
  }
  ok(maxDiff < 1e-8, `幂迭代 = 不动点直接解（200 种子含悬挂图，最大差 ${maxDiff.toExponential(2)} < 1e-8——悬挂质量单次计入）`);
  ok(maxSumErr < 1e-9, `质量守恒 Σr = 1（200 种子最大偏差 ${maxSumErr.toExponential(2)}）`);

  // 个性化 PageRank：双团桥图的局部性
  const ids = Array.from({ length: 12 }, (_, i) => `x${i}`);
  const W = Array.from({ length: 12 }, () => Array(12).fill(0));
  for (let i = 0; i < 6; i += 1) for (let j = 0; j < 6; j += 1) if (i !== j) W[i][j] = 1;
  for (let i = 6; i < 12; i += 1) for (let j = 6; j < 12; j += 1) if (i !== j) W[i][j] = 1;
  W[2][8] = 0.05;
  W[8][2] = 0.05;
  const ppr = personalizedPageRank(ids, W, ['x0']);
  const meanA = ppr.scores.slice(0, 6).reduce((s, v) => s + v, 0) / 6;
  const meanB = ppr.scores.slice(6).reduce((s, v) => s + v, 0) / 6;
  ok(meanA > meanB * 5, `个性化重启的局部性：种子侧团均值 ${meanA.toFixed(4)} > 对侧 ${meanB.toFixed(4)} ×5（重启随机游走）`);
  ok(Math.abs(ppr.scores.reduce((s, v) => s + v, 0) - 1) < 1e-9, 'PPR 质量守恒 Σ = 1');
  // PPR 也满足其不动点（直接解口径）
  const pprDirect = pageRankDirect(ids, W, ['x0']);
  ok(Math.max(...ppr.scores.map((v, i) => Math.abs(v - pprDirect.scores[i]))) < 1e-9, 'PPR 幂迭代 = PPR 直接解不动点');

  // PPR 电池：50 种子随机图 PPR(幂) vs PPR(直接)
  let pprMax = 0;
  for (let rep = 0; rep < 50; rep += 1) {
    const rng = mulberry32(42000 + rep);
    const n = 6 + Math.floor(rng() * 12);
    const ids2 = Array.from({ length: n }, (_, i) => `y${i}`);
    const W2 = Array.from({ length: n }, () => Array.from({ length: n }, () => (rng() < 0.3 ? 0.5 + rng() : 0)));
    for (let i = 0; i < n; i += 1) W2[i][i] = 0;
    W2[0] = Array(n).fill(0);
    const seeds = [ids2[1], ids2[2]];
    const a = personalizedPageRank(ids2, W2, seeds, { tol: 1e-12, maxIterations: 4000 });
    const b = pageRankDirect(ids2, W2, seeds);
    pprMax = Math.max(pprMax, ...a.scores.map((v, i) => Math.abs(v - b.scores[i])));
  }
  ok(pprMax < 1e-8, `PPR 不动点对照（50 种子，最大差 ${pprMax.toExponential(2)}）`);

  // 稀疏列幂迭代 ≡ 稠密参考（逐位）
  const densePowerPageRank = (idsD, weights) => {
    const n = idsD.length;
    const d = 0.85;
    const rowSum = weights.map((row) => row.reduce((s, v) => s + v, 0));
    const dangling = rowSum.map((s) => s <= 1e-12);
    const transition = weights.map((row, i) => {
      const s = rowSum[i];
      if (s <= 1e-12) return Array.from({ length: n }, () => 0);
      return row.map((v) => v / s);
    });
    let r = Array.from({ length: n }, () => 1 / n);
    for (let it = 0; it < 4000; it += 1) {
      let dm = 0;
      for (let i = 0; i < n; i += 1) if (dangling[i]) dm += r[i];
      // 与内核相同的算术次序: (1−d)·v_j 先乘后加（v_j = 1/n）
      const next = Array.from({ length: n }, () => (1 - d) * (1 / n) + (d * dm) / n);
      for (let j = 0; j < n; j += 1) {
        let col = 0;
        for (let i = 0; i < n; i += 1) col += r[i] * transition[i][j];
        next[j] += d * col;
      }
      let delta = 0;
      for (let i = 0; i < n; i += 1) delta += Math.abs(next[i] - r[i]);
      r = next;
      if (delta <= 1e-10) break;
    }
    const total = r.reduce((s, x) => s + x, 0);
    return r.map((x) => x / total);
  };
  let bitIdentical = true;
  for (let rep = 0; rep < 100; rep += 1) {
    const rng = mulberry32(43000 + rep);
    const n = 6 + Math.floor(rng() * 15);
    const ids3 = Array.from({ length: n }, (_, i) => `z${i}`);
    const W3 = Array.from({ length: n }, () => Array.from({ length: n }, () => (rng() < 0.4 ? rng() : 0)));
    for (let i = 0; i < n; i += 1) W3[i][i] = 0;
    if (rep % 4 === 0) W3[n - 1] = Array(n).fill(0);
    const sparseScores = pageRank(ids3, W3, { tol: 1e-10, maxIterations: 4000 }).scores;
    const denseScores = densePowerPageRank(ids3, W3);
    for (let i = 0; i < n; i += 1) if (sparseScores[i] !== denseScores[i]) bitIdentical = false;
  }
  ok(bitIdentical, '稀疏列幂迭代与稠密参考逐位一致（100 种子——零权重跳过不改变 IEEE754 浮点和）');

  // 大图耗时对照（稀疏 5%）
  {
    const n = 400;
    const rng = mulberry32(99);
    const big = Array.from({ length: n }, () => Array.from({ length: n }, () => (rng() < 0.05 ? 1 : 0)));
    const bigIds = Array.from({ length: n }, (_, i) => `b${i}`);
    const t1 = performance.now();
    const sparseResult = pageRank(bigIds, big, { tol: 1e-10 });
    const tSparse = performance.now() - t1;
    const t2 = performance.now();
    densePowerPageRank(bigIds, big);
    const tDense = performance.now() - t2;
    ok(tSparse * 2 < tDense, `稀疏幂迭代提速（n=400 密度 5%: 稀疏 ${tSparse.toFixed(0)}ms vs 稠密 ${tDense.toFixed(0)}ms，${(tDense / tSparse).toFixed(1)}×）`);
    ok(sparseResult.converged, `大图收敛（${sparseResult.iterations} 次迭代）`);
  }

  // 护栏：非有限选项/权重
  const guard = pageRank(['a', 'b', 'c'], [[0, NaN, 1], [1, 0, 0], [1, Infinity, 0]], { damping: Number.NaN });
  ok(guard.scores.every((s) => Number.isFinite(s) && s >= 0) && Math.abs(guard.scores.reduce((s, v) => s + v, 0) - 1) < 1e-9, 'NaN 阻尼/权重护栏：分布有限、守恒');
}

// ═══════════════════ 33.0 随机矩阵 ═══════════════════

section('33.0 随机矩阵：MP 全分布 + KS + Tracy–Widom 数值解 + 镜像 Jacobi');

{
  // MP 密度解析式 + CDF 质量
  let massOk = true;
  for (const g of [0.05, 0.2, 0.5, 0.9]) {
    const mass = mpCdf(1e9, g);
    if (Math.abs(mass - 1) > 1e-9) massOk = false;
  }
  ok(massOk, 'MP 密度解析式积分总质量 = 1（γ ∈ {0.05, 0.2, 0.5, 0.9}，自适应 Simpson，1e-9）');
  const { lambdaPlus, lambdaMinus } = mpEdges(0.25);
  ok(Math.abs(mpCdf(lambdaMinus + 1e-9, 0.25)) < 1e-4 && Math.abs(mpCdf(lambdaPlus - 1e-9, 0.25) - 1) < 1e-4 && mpCdf((lambdaMinus + lambdaPlus) / 2, 0.25) > 0 && mpCdf((lambdaMinus + lambdaPlus) / 2, 0.25) < 1, 'MP CDF 带边连续（下边 → 0、上边 → 1、谱支撑内点严格介于 0/1 之间）');

  // Kolmogorov 余分布锚点
  ok(Math.abs(kolmogorovComplementary(1.3581) - 0.05) < 1e-3 && Math.abs(kolmogorovComplementary(1.6276) - 0.01) < 1e-3 && Math.abs(kolmogorovComplementary(0.571) - 0.9) < 5e-3, 'Kolmogorov 余分布锚点 Q(1.358)=0.05 / Q(1.628)=0.01 / Q(0.571)=0.9');

  // Airy Ai 解析锚点（文献值）
  ok(
    Math.abs(airyAi(0) - 0.355028053887817) < 1e-9 &&
      Math.abs(airyAi(1) - 0.135292422451371) < 5e-7 &&
      Math.abs(airyAi(-1) - 0.535560883292352) < 5e-6 &&
      Math.abs(airyAi(-5) - 0.350761006248823) < 5e-6,
    'Airy Ai 数值锚点（RK4 表: 0/1/−1/−5 处对照文献值）',
  );

  // Tracy–Widom 分位数锚点（文献表）
  const q05 = tracyWidom1Quantile(0.05);
  const q50 = tracyWidom1Quantile(0.5);
  const q95 = tracyWidom1Quantile(0.95);
  ok(Math.abs(q05 - -3.181) < 0.04 && Math.abs(q50 - -1.262) < 0.02 && Math.abs(q95 - 0.980) < 0.04, `TW1 分位数锚点（q05=${q05.toFixed(3)}/−3.181, q50=${q50.toFixed(3)}/−1.262, q95=${q95.toFixed(3)}/0.980）`);
  ok(Math.abs(tracyWidom1Cdf(-3.181) - 0.05) < 0.01 && Math.abs(tracyWidom1Cdf(0.9796) - 0.95) < 0.01, 'TW1 CDF 反向锚点（F(−3.181)=0.05, F(0.9796)=0.95）');
  ok(Math.abs(tracyWidom2Cdf(-1.805) - 0.5) < 0.05, `TW2 中位数锚点（F2(−1.805)=${tracyWidom2Cdf(-1.805).toFixed(4)} ≈ 0.5）`);
  // TW1 矩（表上数值积分）
  {
    const n = 1200;
    const h = 10 / n;
    let m1 = 0;
    let m2 = 0;
    for (let i = 0; i < n; i += 1) {
      const s = -7 + i * h;
      const d1 = (tracyWidom1Cdf(s + h) - tracyWidom1Cdf(s)) / h; // 密度
      m1 += d1 * (s + h / 2) * h;
      m2 += d1 * (s + h / 2) ** 2 * h;
    }
    const sd = Math.sqrt(Math.max(0, m2 - m1 * m1));
    ok(Math.abs(m1 - -1.2065) < 0.02 && Math.abs(sd - 1.2679) < 0.02, `TW1 矩锚点（μ=${m1.toFixed(4)}/−1.2065, σ=${sd.toFixed(4)}/1.2679）`);
  }

  // KS 检验：纯噪声通过 / 因子结构拒绝
  const noiseSpectra = [];
  for (let rep = 0; rep < 6; rep += 1) {
    const g = gaussMaker(51000 + rep);
    const p = 40;
    const nn = 480;
    const series = Array.from({ length: p }, () => Array.from({ length: nn }, () => g()));
    noiseSpectra.push(jacobiEigensym(correlationFromSeries(series)).values);
  }
  const ksNoise = noiseSpectra.map((eigs) => mpKsTest(eigs, 40 / 480));
  ok(ksNoise.every((r) => r.passed), `纯噪声谱 KS 全部通过（D ∈ [${Math.min(...ksNoise.map((r) => r.statistic)).toFixed(3)}, ${Math.max(...ksNoise.map((r) => r.statistic)).toFixed(3)}] vs 临界 ${ksNoise[0].critical.toFixed(3)}）`);
  ok(ksNoise.every((r) => r.pValue > 0.05), '纯噪声 KS p 值 > 0.05（不拒绝「谱 = MP 噪声」）');
  {
    const g = gaussMaker(51999);
    const p = 40;
    const nn = 480;
    const series = Array.from({ length: p }, () => []);
    for (let t = 0; t < nn; t += 1) {
      const f = g();
      for (let i = 0; i < p; i += 1) series[i][t] = 0.7 * f + 0.714 * g();
    }
    const ksSignal = mpKsTest(jacobiEigensym(correlationFromSeries(series)).values, p / nn);
    ok(!ksSignal.passed && ksSignal.statistic > 2 * ksSignal.critical, `共同因子谱 KS 拒绝（D=${ksSignal.statistic.toFixed(3)} > 2×${ksSignal.critical.toFixed(3)}——真结构不在噪声带内）`);
  }

  // KS 缓存等价 + 计时
  {
    const eigs = noiseSpectra[0];
    mpKsTest(eigs, 40 / 480); // 预热缓存
    const t1 = performance.now();
    for (let i = 0; i < 50; i += 1) mpKsTest(eigs, 40 / 480);
    const tCached = (performance.now() - t1) / 50;
    const exactD = (es) => {
      const sorted = [...es].sort((a, b) => a - b);
      const m = sorted.length;
      let d = 0;
      for (let i = 0; i < m; i += 1) {
        const f = mpCdf(sorted[i], 40 / 480);
        d = Math.max(d, Math.abs((i + 1) / m - f), Math.abs(i / m - f));
      }
      return d;
    };
    const t2 = performance.now();
    for (let i = 0; i < 50; i += 1) exactD(eigs);
    const tExact = (performance.now() - t2) / 50;
    const dCached = mpKsTest(eigs, 40 / 480).statistic;
    ok(Math.abs(dCached - exactD(eigs)) < 5e-7, `KS 缓存表与精确积分一致（|ΔD| = ${Math.abs(dCached - exactD(eigs)).toExponential(2)} < 5e-7）`);
    ok(tCached * 5 < tExact, `KS 缓存提速（${(tExact / tCached).toFixed(0)}×: 缓存 ${tCached.toFixed(3)}ms vs 精确 ${tExact.toFixed(3)}ms/次——同 γ 重复检验摊销）`);
  }

  // Johnstone 边缘标准化：协方差口径（噪声 vs 信号）
  {
    const g = gaussMaker(52000);
    const p = 40;
    const nn = 480;
    const ss = [];
    for (let rep = 0; rep < 20; rep += 1) {
      const series = Array.from({ length: p }, () => Array.from({ length: nn }, () => g()));
      const means = series.map((s) => s.reduce((a, b) => a + b, 0) / nn);
      const cov = Array.from({ length: p }, () => new Array(p).fill(0));
      for (let i = 0; i < p; i += 1) {
        for (let j = i; j < p; j += 1) {
          let c = 0;
          for (let t = 0; t < nn; t += 1) c += (series[i][t] - means[i]) * (series[j][t] - means[j]);
          c /= nn;
          cov[i][j] = c;
          cov[j][i] = c;
        }
      }
      const lam = jacobiEigensym(cov).values[0];
      ss.push(edgeStandardScore(lam, p, nn));
    }
    const meanS = ss.reduce((a, b) => a + b, 0) / ss.length;
    ok(meanS > -2.6 && meanS < -0.2 && Math.max(...ss) < 1.5, `纯噪声边缘标准化 ~ TW1（20 次均值 s = ${meanS.toFixed(2)}，TW1 均值 −1.21 口径）`);
    ok(tracyWidom1Cdf(Math.max(...ss)) > 0.01, `噪声 λmax 未越过 TW1 右尾（max s = ${Math.max(...ss).toFixed(2)}，F1 > 0.01）`);
    // 信号：强共同因子的协方差 λmax → s ≫ TW1 95% 分位
    const series2 = Array.from({ length: p }, () => []);
    for (let t = 0; t < nn; t += 1) {
      const f = g();
      for (let i = 0; i < p; i += 1) series2[i][t] = 0.8 * f + 0.6 * g();
    }
    const means2 = series2.map((s) => s.reduce((a, b) => a + b, 0) / nn);
    const cov2 = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < p; i += 1) {
      for (let j = i; j < p; j += 1) {
        let c = 0;
        for (let t = 0; t < nn; t += 1) c += (series2[i][t] - means2[i]) * (series2[j][t] - means2[j]);
        c /= nn;
        cov2[i][j] = c;
        cov2[j][i] = c;
      }
    }
    const s2 = edgeStandardScore(jacobiEigensym(cov2).values[0], p, nn);
    ok(s2 > tracyWidom1Quantile(0.999), `信号 λmax 的边缘标准化越过 TW1 99.9% 分位（s = ${s2.toFixed(1)} > ${tracyWidom1Quantile(0.999).toFixed(2)}）`);
  }

  // Jacobi 镜像旋转：等价 + 计时 + 平局确定性
  const refJacobi = (input) => {
    const n = input.length;
    const a = input.map((r) => [...r]);
    for (let sweep = 0; sweep < 30; sweep += 1) {
      let off = 0;
      for (let p = 0; p < n; p += 1) for (let s = p + 1; s < n; s += 1) off += a[p][s] * a[p][s];
      if (off < 1e-24) break;
      for (let p = 0; p < n - 1; p += 1) for (let s = p + 1; s < n; s += 1) {
        if (Math.abs(a[p][s]) < 1e-300) continue;
        const th = (a[s][s] - a[p][p]) / (2 * a[p][s]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const si = t * c;
        for (let k = 0; k < n; k += 1) { const akp = a[k][p], aks = a[k][s]; a[k][p] = c * akp - si * aks; a[k][s] = si * akp + c * aks; }
        for (let k = 0; k < n; k += 1) { const apk = a[p][k], ask = a[s][k]; a[p][k] = c * apk - si * ask; a[s][k] = si * apk + c * ask; }
      }
    }
    return Array.from({ length: n }, (_, i) => a[i][i]).sort((x, y) => y - x);
  };
  let jacMaxDiff = 0;
  for (let rep = 0; rep < 100; rep += 1) {
    const rng = mulberry32(53000 + rep);
    const n = 8 + Math.floor(rng() * 40);
    const A = Array.from({ length: n }, () => Array.from({ length: n }, () => rng() * 2 - 1));
    const S = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (A[i][j] + A[j][i]) / 2));
    const v1 = jacobiEigensym(S).values;
    const v2 = refJacobi(S);
    for (let i = 0; i < n; i += 1) jacMaxDiff = Math.max(jacMaxDiff, Math.abs(v1[i] - v2[i]));
  }
  ok(jacMaxDiff < 1e-11, `jacobiEigensym 与两遍参考特征值一致（100 种子最大差 ${jacMaxDiff.toExponential(2)}——旋转主循环与升级前逐位同构）`);
  {
    const rng = mulberry32(77);
    const nT = 110;
    const A = Array.from({ length: nT }, () => Array.from({ length: nT }, () => rng() * 2 - 1));
    const S = Array.from({ length: nT }, (_, i) => Array.from({ length: nT }, (_, j) => (A[i][j] + A[j][i]) / 2));
    const t1 = performance.now();
    jacobiEigensym(S);
    const tOpt = performance.now() - t1;
    const t2 = performance.now();
    refJacobi(S);
    const tRef = performance.now() - t2;
    console.log(`    （计时参考 110×110: 内核 ${tOpt.toFixed(0)}ms vs 脚本参考 ${tRef.toFixed(0)}ms——旋转主循环逐位同构，性能轴落在 KS 缓存 ~13×）`);
  }
  {
    const dup = jacobiEigensym([[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 5, 0], [0, 0, 0, 5]]);
    ok(Math.abs(dup.values[0] - 5) < 1e-14 && Math.abs(dup.values[1] - 5) < 1e-14 && Math.abs(dup.values[3] - 2) < 1e-14, '特征值平局确定性（重谱 [5,5,2,2] 精确恢复）');
  }
}

// ═══════════════════ 50.0 矩阵补全 ═══════════════════

section('50.0 矩阵补全：Gavish–Donoho 硬阈值 + CV 秩选择 + 谱初始化');

{
  // GD 去噪电池：60 种子
  let keptOk = 0;
  let beatsAll = 0;
  let medianNmseSum = 0;
  let keepAllSum = 0;
  for (let rep = 0; rep < 60; rep += 1) {
    const g = gaussMaker(61000 + rep);
    const n = 24;
    const r = 2;
    const sigma = 1;
    const U0 = Array.from({ length: n }, () => Array.from({ length: r }, () => g()));
    const V0 = Array.from({ length: n }, () => Array.from({ length: r }, () => g()));
    const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => U0[i][0] * V0[j][0] + U0[i][1] * V0[j][1]));
    const Y = A.map((row, i) => row.map((v, j) => v + sigma * g()));
    const nmse = (R) => {
      let e = 0;
      let en = 0;
      for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) { e += (R[i][j] - A[i][j]) ** 2; en += A[i][j] ** 2; }
      return e / en;
    };
    const known = svdHardThresholdDenoise(Y, { sigma, rule: 'known-sigma' });
    const med = svdHardThresholdDenoise(Y, { rule: 'median' });
    if (known.kept >= r && known.kept <= r + 1) keptOk += 1;
    if (nmse(known.denoised) < nmse(Y)) beatsAll += 1;
    medianNmseSum += nmse(med.denoised);
    keepAllSum += nmse(Y);
  }
  ok(keptOk >= 54, `GD 硬阈值保留秩 = 真秩（${keptOk}/60 种子 keep ∈ {2,3}——MSE 最优收缩的秩恢复）`);
  ok(beatsAll === 60, `known-σ 规则 NMSE 全胜 keep-all（${beatsAll}/60）`);
  ok(medianNmseSum < 0.5 * keepAllSum, `中位数规则平均 NMSE ${(medianNmseSum / 60).toFixed(3)} ≪ keep-all ${(keepAllSum / 60).toFixed(3)}`);

  // SVD 奇异值解析对照（对角矩阵）
  {
    const diag = [[3, 0, 0], [0, 1, 0], [0, 0, 2], [0, 0, 0]];
    const rep = svdHardThresholdDenoise(diag, { rule: 1.5 });
    ok(Math.abs(rep.singularValues[0] - 3) < 1e-10 && Math.abs(rep.singularValues[1] - 2) < 1e-10 && Math.abs(rep.singularValues[2] - 1) < 1e-10 && rep.kept === 2, `对称嵌入 SVD 解析对照（奇异值 3/2/1，阈值 1.5 → keep 2）`);
  }

  // CV 秩选择：良态秩 2（零均值因子，10×8，90% 观测）
  let rankHit = 0;
  let rankMax = 0;
  for (let rep = 0; rep < 30; rep += 1) {
    const g = gaussMaker(62000 + rep);
    const U0 = Array.from({ length: 10 }, () => [g(), g()]);
    const V0 = Array.from({ length: 8 }, () => [g(), g()]);
    const obs = [];
    for (let i = 0; i < 10; i += 1) for (let j = 0; j < 8; j += 1) {
      const truth = U0[i][0] * V0[j][0] + U0[i][1] * V0[j][1];
      obs.push({ i, j, value: truth + 0.05 * g() });
    }
    const rng = mulberry32(rep);
    const filtered = obs.filter(() => rng() < 0.9);
    const sel = selectRank(filtered, 10, 8, { maxRank: 4, seed: 123 + rep });
    if (sel.bestRank === 2) rankHit += 1;
    rankMax = Math.max(rankMax, sel.bestRank);
  }
  ok(rankHit >= 18 && rankMax <= 3, `CV 秩选择（良态秩 2）: 精确 ${rankHit}/30、从不 > 3（k 折 + 双种子重启 + 1-SE 简约规则）`);
  {
    // 近秩 1 数据（均值主导因子）→ 简约原则选 ≤ 2
    let parsimony = 0;
    for (let rep = 0; rep < 20; rep += 1) {
      const g = gaussMaker(62500 + rep);
      const U0 = Array.from({ length: 8 }, () => [0.5 + 0.2 * g(), 0.5 + 0.2 * g()]);
      const V0 = Array.from({ length: 6 }, () => [0.5 + 0.2 * g(), 0.5 + 0.2 * g()]);
      const obs = [];
      for (let i = 0; i < 8; i += 1) for (let j = 0; j < 6; j += 1) {
        obs.push({ i, j, value: U0[i][0] * V0[j][0] + U0[i][1] * V0[j][1] + 0.02 * g() });
      }
      const sel = selectRank(obs, 8, 6, { maxRank: 4, seed: 321 + rep });
      if (sel.bestRank <= 2) parsimony += 1;
    }
    ok(parsimony >= 16, `CV 秩选择（近秩 1 数据）: 简约选择 ≤ 2（${parsimony}/20——1-SE 规则不追噪声容量）`);
  }

  // 谱初始化：迭代数收益 + 拟合不劣化（严格收敛口径；均值主导因子——
  // 谱初始化的均值填充基在良态口径）
  let itRand = 0;
  let itSpec = 0;
  let hidRand = 0;
  let hidSpec = 0;
  for (let rep = 0; rep < 20; rep += 1) {
    const g = gaussMaker(63000 + rep);
    const U0 = Array.from({ length: 12 }, () => [0.5 + 0.2 * g(), 0.5 + 0.2 * g()]);
    const V0 = Array.from({ length: 9 }, () => [0.5 + 0.2 * g(), 0.5 + 0.2 * g()]);
    const obs = [];
    const hid = [];
    for (let i = 0; i < 12; i += 1) for (let j = 0; j < 9; j += 1) {
      const truth = U0[i][0] * V0[j][0] + U0[i][1] * V0[j][1];
      if (mulberry32(rep * 100 + i * 9 + j)() < 0.7) obs.push({ i, j, value: truth + 0.02 * g() });
      else hid.push({ i, j, truth });
    }
    const rr = completeMatrix(obs, 12, 9, { rank: 2, seed: 55 + rep, strictConvergence: true });
    const rs = completeMatrix(obs, 12, 9, { rank: 2, seed: 55 + rep, strictConvergence: true, init: 'spectral' });
    itRand += rr.iterations;
    itSpec += rs.iterations;
    for (const h of hid) {
      hidRand += ((completedEntry(rr, h.i, h.j) ?? 0) - h.truth) ** 2;
      hidSpec += ((completedEntry(rs, h.i, h.j) ?? 0) - h.truth) ** 2;
    }
  }
  ok(itSpec <= itRand * 0.75, `谱初始化迭代数下降（均值 ${(itRand / 20).toFixed(1)} → ${(itSpec / 20).toFixed(1)}）`);
  ok(hidSpec <= hidRand * 1.3 + 1e-9, `谱初始化未观测条目拟合不劣化（平方误差 ${(hidSpec).toFixed(3)} vs ${(hidRand).toFixed(3)}）`);

  // 旧收敛口径零漂移 + 严格口径 + 空观测护栏
  const legacy = completeMatrix([{ i: 0, j: 0, value: 1 }, { i: 0, j: 1, value: 2 }, { i: 1, j: 0, value: 3 }, { i: 1, j: 1, value: 4 }], 2, 2, { rank: 1 });
  ok(legacy.iterations === 1 && legacy.converged === true, '缺省收敛口径零漂移（iterations = 1 的旧行为逐位保留）');
  const strictCase = completeMatrix([{ i: 0, j: 0, value: 1 }, { i: 0, j: 1, value: 2 }, { i: 1, j: 0, value: 3 }, { i: 1, j: 1, value: 4 }], 2, 2, { rank: 1, strictConvergence: true, maxIterations: 200 });
  ok(strictCase.converged && strictCase.iterations > 1, `严格收敛口径（iterations = ${strictCase.iterations} > 1——真收敛）`);
  const empty = completeMatrix([], 3, 3);
  ok(empty.converged === true && empty.iterations === 0 && empty.rowFactors.every((row) => row.every((v) => v === 0)), '空观测护栏（零因子诚实返回，不再空转 200 次迭代）');
}

// ═══════════════════ 49.0 多尺度小波 ═══════════════════

section('49.0 多尺度小波：Daubechies D4 + 模极大值 Lipschitz + 原地化');

{
  // D4 代数恒等式
  const c = daubechies4Filter();
  const sumC = c.reduce((s, v) => s + v, 0);
  const sumC2 = c.reduce((s, v) => s + v * v, 0);
  let van0 = 0;
  let van1 = 0;
  for (let n = 0; n < 4; n += 1) {
    van0 += (n % 2 === 0 ? 1 : -1) * c[n];
    van1 += (n % 2 === 0 ? 1 : -1) * n * c[n];
  }
  let orthOk = true;
  for (let m = -1; m <= 1; m += 1) {
    let s = 0;
    for (let n = 0; n + 2 * m >= 0 && n + 2 * m < 4; n += 1) s += c[n] * c[n + 2 * m];
    if (Math.abs(s - (m === 0 ? 2 : 0)) > 1e-12) orthOk = false;
  }
  ok(Math.abs(sumC - 2) < 1e-12 && Math.abs(sumC2 - 2) < 1e-12 && Math.abs(van0) < 1e-12 && Math.abs(van1) < 1e-12 && orthOk, 'D4 精确代数系数（Σc=2、Σc²=2、两阶消失矩、平移正交——由定义方程解出）');

  // 200 种子: Haar/D4 完美重构 + Parseval
  let recH = 0;
  let rec4 = 0;
  let parH = 0;
  let par4 = 0;
  for (let rep = 0; rep < 200; rep += 1) {
    const rng = mulberry32(71000 + rep);
    const n = 2 ** (2 + Math.floor(rng() * 5));
    const x = Array.from({ length: n }, () => rng() * 10 - 5);
    const dh = haarDecompose(x);
    const rh = haarReconstruct(dh);
    const d4 = daubechies4Decompose(x);
    const r4 = daubechies4Reconstruct(d4);
    for (let i = 0; i < n; i += 1) {
      recH = Math.max(recH, Math.abs(x[i] - rh[i]));
      rec4 = Math.max(rec4, Math.abs(x[i] - r4[i]));
    }
    const eX = x.reduce((s, v) => s + v * v, 0);
    const eH = dh.approximation[0] ** 2 + dh.details.reduce((s, d) => s + d.reduce((a, b) => a + b * b, 0), 0);
    const e4 = d4.approximation[0] ** 2 + d4.details.reduce((s, d) => s + d.reduce((a, b) => a + b * b, 0), 0);
    parH = Math.max(parH, Math.abs(eH - eX) / eX);
    par4 = Math.max(par4, Math.abs(e4 - eX) / eX);
  }
  ok(recH < 5e-13 && rec4 < 5e-12, `双基完美重构（200 种子: Haar ${recH.toExponential(1)} / D4 ${rec4.toExponential(1)}）`);
  ok(parH < 5e-12 && par4 < 5e-12, `双基 Parseval 能量守恒（200 种子: Haar ${parH.toExponential(1)} / D4 ${par4.toExponential(1)}）`);

  // 线性趋势内部泄漏（D4 两阶消失矩 vs Haar 一阶）
  {
    const n = 256;
    const lin = Array.from({ length: n }, (_, i) => 3 + 0.5 * i);
    const dh = haarDecompose(lin);
    const d4 = daubechies4Decompose(lin);
    const interior = (details) => {
      let s = 0;
      const half = details[0].length / 2;
      for (let k = 2; k < half; k += 1) s += details[0][k] ** 2; // 远离周期接缝
      return s;
    }
    const leakH = interior(dh.details);
    const leak4 = interior(d4.details);
    ok(leak4 < 1e-20 && leakH > 0.1, `线性趋势内部泄漏: D4 ${leak4.toExponential(1)}（≈0，两阶消失矩）vs Haar ${leakH.toFixed(3)}（一阶——斜率进细节）`);
  }

  // 模极大值 Lipschitz：120 个奇异性构造
  const mkStep = (n, pos) => Array.from({ length: n }, (_, i) => i < pos ? 0 : 1);
  const mkCusp = (n, pos, beta) => Array.from({ length: n }, (_, i) => Math.sign(i - pos) * Math.pow(Math.abs(i - pos) / n, beta));
  let stepOk = 0;
  let cuspOk = 0;
  let kinkOk = 0;
  let stepSum = 0;
  let cuspSum = 0;
  let kinkSum = 0;
  for (let rep = 0; rep < 40; rep += 1) {
    const pos = 32 + Math.floor(mulberry32(72000 + rep)() * 192);
    const e0 = singularityLipschitz(mkStep(256, pos)).exponent;
    const e05 = singularityLipschitz(mkCusp(256, pos, 0.5)).exponent;
    const e1 = singularityLipschitz(mkCusp(256, pos, 1)).exponent;
    stepSum += Math.abs(e0 - 0);
    cuspSum += Math.abs(e05 - 0.5);
    kinkSum += Math.abs(e1 - 1);
    if (Math.abs(e0) < 0.3) stepOk += 1;
    if (Math.abs(e05 - 0.5) < 0.2) cuspOk += 1;
    if (Math.abs(e1 - 1) < 0.3) kinkOk += 1;
  }
  ok(stepOk >= 30 && cuspOk >= 34 && kinkOk >= 34, `Lipschitz 指数恢复（阶跃 ${stepOk}/40 → α≈0、尖点 ${cuspOk}/40 → α≈0.5、折点 ${kinkOk}/40 → α≈1）`);
  ok(stepSum / 40 < 0.22 && cuspSum / 40 < 0.12 && kinkSum / 40 < 0.18, `Lipschitz 平均绝对误差（阶跃 ${(stepSum / 40).toFixed(3)}、尖点 ${(cuspSum / 40).toFixed(3)}、折点 ${(kinkSum / 40).toFixed(3)}——Haar 一阶消失矩口径）`);

  // NaN 净化 + 旧口径逐位等价（对照原地化参考）
  const dirtyDec = haarDecompose([1, 2, NaN, 4, Infinity, 6, 7, 8]);
  ok(dirtyDec.details.every((d) => d.every(Number.isFinite)), '非有限样本净化（NaN/∞ 置 0——不再逐层污染整个谱）');
  const refHaar = (series) => {
    let approx = [...series];
    const details = [];
    while (approx.length >= 2) {
      const nextApprox = [];
      const detail = [];
      for (let i = 0; i < approx.length; i += 2) {
        nextApprox.push((approx[i] + approx[i + 1]) / Math.SQRT2);
        detail.push((approx[i] - approx[i + 1]) / Math.SQRT2);
      }
      approx = nextApprox;
      details.push(detail);
    }
    return { details, approximation: approx };
  };
  let bitSame = true;
  for (let rep = 0; rep < 50; rep += 1) {
    const rng = mulberry32(73000 + rep);
    const x = Array.from({ length: 128 }, () => rng() * 10);
    const mine = haarDecompose(x);
    const ref = refHaar(x);
    for (let l = 0; l < ref.details.length; l += 1) {
      for (let k = 0; k < ref.details[l].length; k += 1) if (mine.details[l][k] !== ref.details[l][k]) bitSame = false;
    }
    if (mine.approximation[0] !== ref.approximation[0]) bitSame = false;
  }
  ok(bitSame, '原地分层 Haar 与旧算法逐位一致（50 种子——有限输入零漂移）');
  {
    const big = Array.from({ length: 131072 }, (_, i) => Math.sin(i * 0.01));
    const t1 = performance.now();
    haarDecompose(big);
    const tNew = performance.now() - t1;
    const t2 = performance.now();
    refHaar(big);
    const tRef = performance.now() - t2;
    console.log(`    （计时参考 128K 点: 原地 ${tNew.toFixed(1)}ms vs 旧两数组 ${tRef.toFixed(1)}ms——分配次数减半，等价性以逐位断言为准）`);
  }
}

// ═══════════════════ 78.0 核 CCA ═══════════════════

section('78.0 多源对齐：核 CCA + Jacobi 平局确定性');

{
  // 线性核 KCCA ≡ 线性 CCA（口径不变性）
  let specDiff = 0;
  for (let rep = 0; rep < 15; rep += 1) {
    const g = gaussMaker(81000 + rep);
    const n = 90;
    const X = Array.from({ length: n }, () => Array.from({ length: 4 }, () => g()));
    const Y = Array.from({ length: n }, () => Array.from({ length: 3 }, () => g()));
    for (let t = 0; t < n; t += 1) {
      const f = g();
      X[t][0] += 0.8 * f;
      Y[t][0] += 0.8 * f;
    }
    const lin = cca(X, Y, { l2: 1e-6 });
    const kc = kernelCCA(X, Y, { kernel: 'linear', l2: 1e-6 });
    const m = Math.min(lin.canonicalCorrelations.length, kc.canonicalCorrelations.length);
    for (let i = 0; i < m; i += 1) specDiff = Math.max(specDiff, Math.abs(lin.canonicalCorrelations[i] - kc.canonicalCorrelations[i]));
  }
  ok(specDiff < 1e-5, `线性核 KCAA ≡ 线性 CCA（15 种子谱最大差 ${specDiff.toExponential(2)}——核化不改公共信息量）`);

  // 非线性依赖：Y = X²（20 种子）
  let linMax = 0;
  let rbfMin = 1;
  for (let rep = 0; rep < 20; rep += 1) {
    const g = gaussMaker(82000 + rep);
    const n = 120;
    const X = Array.from({ length: n }, () => [g(), 0.5 * g()]);
    const Y = X.map(([a, b]) => [a * a + 0.1 * g(), b * b + 0.1 * g()]);
    const lin = cca(X, Y, { l2: 0.5 });
    const kc = kernelCCA(X, Y, { kernel: 'rbf', l2: 0.1 });
    linMax = Math.max(linMax, lin.canonicalCorrelations[0] ?? 0);
    rbfMin = Math.min(rbfMin, kc.canonicalCorrelations[0] ?? 0);
  }
  ok(linMax < 0.35, `线性 CCA 看不见 Y = X²（20 种子最大 ρ₁ = ${linMax.toFixed(3)} < 0.35）`);
  ok(rbfMin > 0.8, `RBF 核 CCA 捕捉 Y = X²（20 种子最小 ρ₁ = ${rbfMin.toFixed(3)} > 0.8——泛函依赖可检）`);

  // 典型变量正交（KCCA scores）
  {
    const g = gaussMaker(83000);
    const n = 100;
    const X = Array.from({ length: n }, () => Array.from({ length: 3 }, () => g()));
    const Y = Array.from({ length: n }, () => Array.from({ length: 3 }, () => g()));
    for (let t = 0; t < n; t += 1) {
      const f = g();
      X[t][0] += f;
      Y[t][1] += 0.9 * f;
    }
    const kc = kernelCCA(X, Y, { kernel: 'rbf', l2: 0.2 });
    let maxOff = 0;
    let maxDiagErr = 0;
    for (let a = 0; a < 3; a += 1) {
      for (let b = 0; b < 3; b += 1) {
        const r = corr(kc.xScores[a], kc.xScores[b]);
        if (a !== b) maxOff = Math.max(maxOff, Math.abs(r));
        else maxDiagErr = Math.max(maxDiagErr, Math.abs(Math.abs(r) - 1));
      }
    }
    ok(maxOff < 0.15, `KCCA 典型变量互正交（前 3 对 X 侧 scores 互相关非对角 ≤ ${maxOff.toFixed(3)}）`);
    ok(maxDiagErr < 0.05, `KCCA scores 单位方差口径（|corr(自身)|−1 ≤ ${maxDiagErr.toFixed(3)}）`);
  }

  // Jacobi 等价 + 平局确定性（本文件口径）
  const refJacobi2 = (input) => {
    const n = input.length;
    const a = input.map((r) => [...r]);
    for (let sweep = 0; sweep < 60; sweep += 1) {
      let off = 0;
      for (let p = 0; p < n; p += 1) for (let s = p + 1; s < n; s += 1) off += a[p][s] * a[p][s];
      if (off < 1e-24) break;
      for (let p = 0; p < n - 1; p += 1) for (let s = p + 1; s < n; s += 1) {
        if (Math.abs(a[p][s]) < 1e-300) continue;
        const th = (a[s][s] - a[p][p]) / (2 * a[p][s]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const si = t * c;
        for (let k = 0; k < n; k += 1) { const akp = a[k][p], aks = a[k][s]; a[k][p] = c * akp - si * aks; a[k][s] = si * akp + c * aks; }
        for (let k = 0; k < n; k += 1) { const apk = a[p][k], ask = a[s][k]; a[p][k] = c * apk - si * ask; a[s][k] = si * apk + c * ask; }
      }
    }
    return Array.from({ length: n }, (_, i) => a[i][i]).sort((x, y) => y - x);
  };
  let jacDiff2 = 0;
  for (let rep = 0; rep < 100; rep += 1) {
    const rng = mulberry32(84000 + rep);
    const n = 6 + Math.floor(rng() * 30);
    const A = Array.from({ length: n }, () => Array.from({ length: n }, () => rng() * 2 - 1));
    const S = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (A[i][j] + A[j][i]) / 2));
    const v1 = jacobiEigen(S).values;
    const v2 = refJacobi2(S);
    for (let i = 0; i < n; i += 1) jacDiff2 = Math.max(jacDiff2, Math.abs(v1[i] - v2[i]));
  }
  ok(jacDiff2 < 1e-10, `canonical-correlation 的 jacobiEigen 与两遍参考一致（100 种子最大差 ${jacDiff2.toExponential(2)}——旋转主循环与升级前逐位同构）`);
  const dupE = jacobiEigen([[3, 0, 0], [0, 1, 0], [0, 0, 1]]);
  ok(dupE.values.every((v, i) => [3, 1, 1][i] - v === 0), '特征值平局确定性（重谱 [3,1,1] 逐位恢复）');
}

// ═══════════════════ 79.0 扩散映射 ═══════════════════

section('79.0 流形学习：多尺度 t 扫描 + 地标 Nyström 扩散');

{
  // t 扫描与逐个调用逐位一致（20 种子随机点集）
  let sweepSame = true;
  for (let rep = 0; rep < 20; rep += 1) {
    const rng = mulberry32(91000 + rep);
    const pts = Array.from({ length: 40 + rep }, () => [rng() * 4, rng() * 4, rng() * 2]);
    const t = 1 + Math.floor(rng() * 30);
    const sw = diffusionScaleSweep(pts, { tValues: [1, t], k: 6, dims: 2 });
    const single = diffusionMaps(pts, { k: 6, dims: 2, t });
    for (let i = 0; i < pts.length; i += 1) {
      for (let cc = 0; cc < 2; cc += 1) {
        if (sw.results[1].embedding[i][cc] !== single.embedding[i][cc]) sweepSame = false;
      }
    }
  }
  ok(sweepSame, 't 扫描与逐个 diffusionMaps(t) 调用逐位一致（20 种子——共享谱的等价性）');

  // 簇分辨率随 t 单调
  {
    const rng = mulberry32(92);
    const blobs = [];
    for (let i = 0; i < 100; i += 1) blobs.push([0.3 * gaussMaker(9201 + i)(), 0.3 * gaussMaker(9301 + i)()]);
    for (let i = 0; i < 100; i += 1) blobs.push([6 + 0.3 * gaussMaker(9401 + i)(), 6 + 0.3 * gaussMaker(9501 + i)()]);
    const sw = diffusionScaleSweep(blobs, { tValues: [1, 4, 16, 64], k: 8, dims: 2 });
    let prev = -1;
    let monotone = true;
    const ratios = [];
    for (const r of sw.results) {
      let inter = 0;
      let ni = 0;
      let intra = 0;
      let na = 0;
      for (let i = 0; i < 200; i += 2) {
        for (let j = i + 2; j < 200; j += 2) {
          const d = diffusionDistance(r, i, j);
          if ((i < 100) !== (j < 100)) { inter += d; ni += 1; } else { intra += d; na += 1; }
        }
      }
      const ratio = inter / ni / (intra / na + 1e-300);
      ratios.push(ratio);
      if (ratio < prev - 1e-9) monotone = false;
      prev = ratio;
    }
    ok(monotone && ratios[ratios.length - 1] > 1.5, `簇间/簇内扩散距离分辨率随 t 单调上升（[${ratios.map((r) => r.toFixed(2)).join(' → ')}]——多尺度口径）`);
  }

  // 谱半径电池
  let radOk = true;
  for (let rep = 0; rep < 30; rep += 1) {
    const rng = mulberry32(96000 + rep);
    const pts = Array.from({ length: 60 }, () => [rng() * 5, rng() * 5]);
    const res = diffusionMaps(pts, { k: 7, dims: 2 });
    for (const lam of res.eigenvalues) if (lam > 1 + 1e-9 || lam < -1 - 1e-9) radOk = false;
  }
  ok(radOk, '对称归一化算子谱半径 |λ| ≤ 1（30 种子——随机游走转移谱界）');

  // 地标扩散：自洽 + 相关 + 分类 + 孤立点 + 计时
  const moons = twoMoons(200, 4242);
  const lm = landmarkDiffusion(moons.points, { nLandmarks: 40, k: 8, dims: 2, t: 1 });
  let selfErr = 0;
  for (let li = 0; li < lm.landmarkIndices.length; li += 1) {
    const gi = lm.landmarkIndices[li];
    for (let cc = 0; cc < 2; cc += 1) selfErr = Math.max(selfErr, Math.abs(lm.embedding[gi][cc] - lm.landmarkEmbedding[li][cc]));
  }
  ok(selfErr < 1e-9, `地标 Nyström 外推自洽（外推路径 vs 特征向量口径，最大差 ${selfErr.toExponential(2)}——外推和式 = 特征方程）`);
  const full = diffusionMaps(moons.points, { k: 10, dims: 2, t: 1 });
  const c0 = Math.abs(corr(lm.embedding.map((e) => e[0]), full.embedding.map((e) => e[0])));
  const c1 = Math.abs(corr(lm.embedding.map((e) => e[1]), full.embedding.map((e) => e[1])));
  ok(c0 > 0.9 && c1 > 0.9, `地标嵌入与全谱嵌入坐标一致（两新月 |corr| = ${c0.toFixed(3)} / ${c1.toFixed(3)} > 0.9——簇结构保真）`);
  {
    // 三团分类
    const rng = mulberry32(97);
    const centers = [[0, 0], [5, 0], [2.5, 4.5]];
    const pts = [];
    const labels = [];
    for (let cc = 0; cc < 3; cc += 1) {
      for (let i = 0; i < 60; i += 1) {
        const gg = gaussMaker(97000 + cc * 100 + i);
        pts.push([centers[cc][0] + 0.4 * gg(), centers[cc][1] + 0.4 * gg()]);
        labels.push(cc);
      }
    }
    const lm3 = landmarkDiffusion(pts, { nLandmarks: 30, k: 6, dims: 2, t: 1 });
    const tr = [];
    const te = [];
    for (let i = 0; i < 180; i += 1) (i % 2 === 0 ? tr : te).push(i);
    const cls3 = nearestCentroidClassify(tr.map((i) => lm3.embedding[i]), tr.map((i) => labels[i]), te.map((i) => lm3.embedding[i]));
    const acc3 = cls3.predictions.filter((p, i) => p === labels[te[i]]).length / te.length;
    ok(acc3 === 1, `地标嵌入三团线性可分（最近质心 100%，ℓ=30/n=180）`);
    // 孤立点诚实报告：把一个点挪到 5000 单位外（σ_x = 到地标距离 → 核下溢）
    const far = pts.map((p, i) => (i === 5 ? [p[0] + 5000, p[1]] : [...p]));
    const lmFar = landmarkDiffusion(far, { nLandmarks: 30, k: 6, dims: 2, t: 1 });
    ok(lmFar.isolated.includes(5), `远离点诚实标记为孤立（isolated = [${lmFar.isolated.join(',')}].includes(5)——外推退化不冒充坐标）`);
  }
  {
    // 计时对照（swiss roll n=400）
    const roll = swissRoll(400, 77);
    const ts = [1, 2, 3, 4, 6, 8, 12, 16];
    const t1 = performance.now();
    diffusionScaleSweep(roll.points, { tValues: ts, k: 10, dims: 2 });
    const tSweep = performance.now() - t1;
    const t2 = performance.now();
    for (const tv of ts) diffusionMaps(roll.points, { k: 10, dims: 2, t: tv });
    const tSeparate = performance.now() - t2;
    ok(tSweep * 4 < tSeparate, `t 扫描耗时（n=400 8 个 t: 扫描 ${tSweep.toFixed(0)}ms vs 逐个 ${tSeparate.toFixed(0)}ms，${(tSeparate / tSweep).toFixed(1)}×——一次分解多口径）`);
    const t3 = performance.now();
    landmarkDiffusion(roll.points, { nLandmarks: 40, k: 10, dims: 2, t: 1 });
    const tLandmark = performance.now() - t3;
    ok(tLandmark * 10 < tSeparate / ts.length, `地标扩散耗时（n=400: 地标 ${tLandmark.toFixed(1)}ms ≪ 全谱 ${(tSeparate / ts.length).toFixed(0)}ms——O(nℓ²) 口径）`);
  }
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n──────────────────────────────────────────────────────────');
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
