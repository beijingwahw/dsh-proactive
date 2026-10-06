/**
 * verify-novelty-detection.mjs — 76.0 新奇检测内核纯数学离线验证
 *
 * 内核的数学核心全部有解析解、独立重算或蒙特卡洛对照（不是「能跑」，是「算得对」）:
 *   ① 分离锚点: 种子化高斯内点 + 8σ 平移外点（p=4, n=300）——Mahalanobis d²
 *        完全分离（外点最小 d² > 内点最大 d²）、内点 χ² 比 ≈ 0.81（理论 ≈1 的
 *        有偏协方差口径）、外点 p 值中位 6.8e−14; kNN 第 k 近邻距离外点 100%
 *        高于内点（3.913 > 2.608）; noveltyAUC = 1 ≥ 0.95（规格锚点）。
 *   ② CUSUM: 误报率 0.001（ARL₀=1000）校准——Brook–Evans 中点马尔可夫链 ARL
 *        与蒙特卡洛零状态 ARL 相对偏差 ≤ 12%（实测 960 vs 1000, 偏差源自稳健
 *        基线 σ̂ 的估计噪声）; 平稳段实测每步误报率 0.000990 ≤ 校准值 0.001;
 *        Siegmund 闭式对照同数量级（1.013×）; 已知时刻注入 0.5σ 漂移: CUSUM
 *        平均延迟 ~26 ≪ 同误报率朴素单点阈值法 ~206（1/3 以下）且 p90/max
 *        有界; 统计量轨迹逐位精确（max(0,·) 钳位、告警复位、步计数）。
 *   ③ 收缩协方差: p=64 > n=40——显式 shrinkage=0 诚实报告奇异（degenerate,
 *        d²=NaN）; Ledoit–Wolf 自动收缩不崩（强度 0.961 > 0.5, 内点 χ² 比
 *        1.064 ≈ 1, 12σ 外点 χ² 比 3.803 且 p 值 1e−22）; LW 强度对比:
 *        各向同性基准 0.847 vs 强相关基准 0.021（有相关结构值得保留时收缩
 *        自动放松——不是常量插值）。
 *   ④ 自适应基准窗自愈: 每步 0.02σ × 600 步慢漂移后, 末期 150 步自适应窗
 *        误报 1.3% vs 固定基准 100%; 漂移后新位置平稳段自适应 2.0% vs 固定
 *        100%; 窗内均值跟随真实均值（11.98 vs 12.00, 固定基准停在 0）。
 *
 * 全部断言确定性（随机处用内核自带 mulberry32 + Box–Muller, 种子固定）。
 * 运行: node --experimental-strip-types scripts/verify-novelty-detection.mjs
 */

import {
  mulberry32,
  gaussianNoise,
  normalCdf,
  normalQuantile,
  chiSquareUpperTail,
  chiSquareQuantile,
  ledoitWolfIntensity,
  mahalanobisDepth,
  knnNovelty,
  noveltyAUC,
  CUSUMDetector,
  cusumARLSiegmund,
  calibrateThreshold,
  AdaptiveReferenceWindow,
} from '../src/core/novelty-detection.ts';

// ─────────────────── 断言工具 ───────────────────
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
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;
const min = (xs) => Math.min(...xs);
const max = (xs) => Math.max(...xs);

// ═══════════════════ 0. 特殊函数与确定性随机源 ═══════════════════

section('0. 特殊函数解析锚点 + 确定性随机源');

{
  ok(near(normalCdf(0), 0.5, 1e-12), `normalCdf(0) = ${normalCdf(0)}（恒等式锚点）`);
  ok(near(normalCdf(1.96), 0.975, 1e-4), `normalCdf(1.96) = ${normalCdf(1.96).toFixed(7)} ≈ 0.975`);
  ok(near(normalQuantile(0.975), 1.959964, 2e-4), `normalQuantile(0.975) = ${normalQuantile(0.975).toFixed(6)} ≈ 1.959964`);
  ok(near(normalQuantile(0.999), 3.090232, 2e-4), `normalQuantile(0.999) = ${normalQuantile(0.999).toFixed(6)} ≈ 3.090232（朴素阈值法对照用）`);
  // df=2 的 χ² 上尾有闭式 e^{−x/2}——γ 函数底座的精确对照
  ok(near(chiSquareUpperTail(2, 5), Math.exp(-2.5), 1e-9), `chiSquareUpperTail(2,5) = ${chiSquareUpperTail(2, 5).toFixed(10)} = e^{−2.5}（df=2 闭式解）`);
  ok(near(chiSquareUpperTail(4, 13.2767), 0.01, 2e-4), `chiSquareUpperTail(4, 13.2767) = ${chiSquareUpperTail(4, 13.2767).toFixed(6)} ≈ 0.01`);
  ok(near(chiSquareQuantile(4, 0.99), 13.2767, 5e-3), `chiSquareQuantile(4, 0.99) = ${chiSquareQuantile(4, 0.99).toFixed(4)} ≈ 13.2767（χ²₄ 0.99 分位表值）`);
  ok(near(chiSquareQuantile(4, 0.95), 9.4877, 5e-3), `chiSquareQuantile(4, 0.95) = ${chiSquareQuantile(4, 0.95).toFixed(4)} ≈ 9.4877`);

  // mulberry32 确定性: 同种子两条流逐位一致
  const a = mulberry32(76);
  const b = mulberry32(76);
  const seqA = Array.from({ length: 8 }, () => a());
  const seqB = Array.from({ length: 8 }, () => b());
  ok(seqA.every((v, i) => v === seqB[i]), `mulberry32(76) 两条独立流前 8 个输出逐位一致（同输入同输出）`);

  // Box–Muller 统计口径: 30000 抽样
  const rand = mulberry32(5);
  const draws = Array.from({ length: 30000 }, () => gaussianNoise(rand));
  const m = mean(draws);
  const sd = Math.sqrt(mean(draws.map((v) => (v - m) * (v - m))));
  ok(Math.abs(m) <= 0.03, `gaussianNoise 样本均值 = ${m.toFixed(4)}（|μ| ≤ 0.03, SE ≈ 0.006）`);
  ok(Math.abs(sd - 1) <= 0.03, `gaussianNoise 样本标准差 = ${sd.toFixed(4)}（|σ−1| ≤ 0.03）`);
  ok(Math.max(...draws.map(Math.abs)) < 5.5, `gaussianNoise 极值 |z| < 5.5（n=30000 的正态次序统计量口径）`);
}

// ═══════════════════ 1. 分离锚点（Mahalanobis / kNN / AUC） ═══════════════════

section('1. 种子化高斯内点 + 8σ 平移外点: 「见过 vs 没见过」可分离');

{
  const rand = mulberry32(20261001);
  const p = 4;
  const draw = (dim, r) => Array.from({ length: dim }, () => gaussianNoise(r));
  const reference = Array.from({ length: 300 }, () => draw(p, rand));
  const inliers = Array.from({ length: 120 }, () => draw(p, rand));
  // 每分量 +4 → 位移范数 |shift| = 4×√4 = 8σ（各向同性基准下任意方向等价）
  const outliers = Array.from({ length: 120 }, () => draw(p, rand).map((v) => v + 4));

  const inM = inliers.map((s) => mahalanobisDepth(reference, s));
  const outM = outliers.map((s) => mahalanobisDepth(reference, s));

  ok(
    median(inM.map((r) => r.chiSquareRatio)) > 0.6 && median(inM.map((r) => r.chiSquareRatio)) < 1.05,
    `Mahalanobis 内点 χ² 比中位 = ${median(inM.map((r) => r.chiSquareRatio)).toFixed(3)} ∈ (0.6, 1.05)（高斯原假设 d²/p ≈ 1 的有偏协方差口径）`,
  );
  ok(
    median(outM.map((r) => r.chiSquareRatio)) >= 4 * median(inM.map((r) => r.chiSquareRatio)),
    `外点 χ² 比中位 ${median(outM.map((r) => r.chiSquareRatio)).toFixed(2)} ≥ 4× 内点 ${median(inM.map((r) => r.chiSquareRatio)).toFixed(3)}（外点分位数显著更高）`,
  );
  ok(
    median(inM.map((r) => r.pValue)) > 0.25 && median(inM.map((r) => r.pValue)) < 0.75,
    `内点 p 值中位 = ${median(inM.map((r) => r.pValue)).toFixed(3)} ∈ (0.25, 0.75)（χ²₄ 中位 3.36 → 上尾 ≈ 0.5）`,
  );
  ok(
    median(outM.map((r) => r.pValue)) < 1e-6,
    `外点 p 值中位 = ${median(outM.map((r) => r.pValue)).toExponential(2)} < 1e-6（8σ 位移 → d² ≈ 64+4）`,
  );
  ok(
    inM.filter((r) => r.novel).length / inM.length <= 0.05,
    `内点误报率 = ${(inM.filter((r) => r.novel).length / inM.length).toFixed(3)} ≤ 0.05（χ² 0.01 水平的名义覆盖）`,
  );
  ok(
    outM.filter((r) => r.novel).length / outM.length >= 0.99,
    `外点检出率 = ${(outM.filter((r) => r.novel).length / outM.length).toFixed(3)} ≥ 0.99`,
  );
  ok(
    Math.min(...outM.map((r) => r.d2)) > Math.max(...inM.map((r) => r.d2)),
    `d² 完全分离: min(外点) = ${Math.min(...outM.map((r) => r.d2)).toFixed(2)} > max(内点) = ${Math.max(...inM.map((r) => r.d2)).toFixed(2)}`,
  );
  ok(
    median(inM.map((r) => r.depth)) > median(outM.map((r) => r.depth)),
    `深度方向正确: 内点深度中位 ${median(inM.map((r) => r.depth)).toFixed(3)} > 外点 ${median(outM.map((r) => r.depth)).toExponential(2)}（1/(1+d²)）`,
  );

  const inK = inliers.map((s) => knnNovelty(reference, s, { k: 5 }));
  const outK = outliers.map((s) => knnNovelty(reference, s, { k: 5 }));
  const maxInK = Math.max(...inK.map((r) => r.kthDistance));
  const minOutK = Math.min(...outK.map((r) => r.kthDistance));
  ok(
    minOutK > maxInK,
    `kNN 第 k 近邻距离 100% 分离: min(外点) = ${minOutK.toFixed(3)} > max(内点) = ${maxInK.toFixed(3)}`,
  );
  ok(
    min(outK.map((r) => r.score)) > max(inK.map((r) => r.score)),
    `kNN 相对距离比 100% 分离: min(外点 score) = ${min(outK.map((r) => r.score)).toFixed(2)} > max(内点) = ${max(inK.map((r) => r.score)).toFixed(2)}`,
  );
  ok(
    median(outK.map((r) => r.logDensityRatio)) > 2 && median(inK.map((r) => r.logDensityRatio)) < 0.5,
    `密度比方向（新奇向 log(ρ̃/ρ̂) = p·ln(dₖ/median)）: 外点中位 ${median(outK.map((r) => r.logDensityRatio)).toFixed(2)} > 2（更稀）, 内点 ${median(inK.map((r) => r.logDensityRatio)).toFixed(2)} < 0.5`,
  );
  ok(
    inK.filter((r) => r.novel).length / inK.length <= 0.1,
    `kNN 保形计数比内点误报 = ${(inK.filter((r) => r.novel).length / inK.length).toFixed(3)} ≤ 0.1（α=0.05 的可交换覆盖 + 噪声带）`,
  );

  const auc = noveltyAUC(reference, inliers, outliers, { k: 5 });
  ok(
    auc.auc >= 0.95,
    `noveltyAUC = ${auc.auc} ≥ 0.95（规格锚点; 完全分离时应为 1）`,
  );
  ok(auc.margin > 0, `分离边距 margin = ${auc.margin.toFixed(3)} > 0（min 外点分 − max 内点分）`);
}

// ═══════════════════ 2. CUSUM 序贯变点: 校准口径与检测延迟 ═══════════════════

section('2. CUSUM: ARL₀ 校准、平稳误报率与漂移检测延迟');

{
  // 校准: 平稳 N(0,1) 序列 20000 点, 误报率 0.001 → ARL₀ = 1000, k=0.25（瞄准 0.5σ 位移）
  const rand = mulberry32(11);
  const stationary = Array.from({ length: 20000 }, () => gaussianNoise(rand));
  const cal = calibrateThreshold(stationary, 0.001, { k: 0.25 });
  ok(
    cal.converged && near(cal.arlZero, 1000, 2) && near(cal.targetArl, 1000, 1e-9),
    `校准收敛: h = ${cal.h.toFixed(4)}, Markov ARL₀ = ${cal.arlZero.toFixed(2)} = 目标 1000（Brook–Evans 中点链二分反解）`,
  );
  ok(
    cal.h > 5 && cal.h < 12,
    `h = ${cal.h.toFixed(4)} ∈ (5, 12)（k=0.25, ARL₀=1000 的量级健全性）`,
  );
  ok(
    cal.baselineSigma > 0.95 && cal.baselineSigma < 1.06,
    `稳健基线 σ̂ = ${cal.baselineSigma.toFixed(4)}（中位数 + MAD×1.4826; N(0,1) 基准应 ≈ 1）`,
  );
  const siegRatio = cal.arlSiegmund / cal.arlZero;
  ok(
    siegRatio > 0.7 && siegRatio < 1.5,
    `Siegmund 闭式对照 = ${cal.arlSiegmund.toFixed(1)}（比值 ${siegRatio.toFixed(3)} ∈ (0.7, 1.5), 同数量级——只作审计不作校准）`,
  );

  // 平稳段实测每步误报率 ≤ 校准值（300 序列 × 2000 步, 复位续跑）
  let alarms = 0;
  let steps = 0;
  const rRate = mulberry32(555);
  for (let rep = 0; rep < 300; rep += 1) {
    const d = new CUSUMDetector({ k: cal.k, h: cal.h, baselineMean: cal.baselineMean, baselineSigma: cal.baselineSigma });
    for (let t = 0; t < 2000; t += 1) {
      if (d.update(gaussianNoise(rRate)).alarm) alarms += 1;
      steps += 1;
    }
  }
  const rate = alarms / steps;
  ok(
    rate <= 0.001,
    `平稳段实测误报率 = ${rate.toFixed(6)} ≤ 校准值 0.001（${steps} 步; 3σ 噪声带 ≈ 0.00112）`,
  );

  // 蒙特卡洛零状态 ARL vs Markov 口径（600 条首告警序列）
  let total = 0;
  let done = 0;
  const rArl = mulberry32(99);
  for (let rep = 0; rep < 600; rep += 1) {
    const d = new CUSUMDetector({ k: cal.k, h: cal.h, baselineMean: cal.baselineMean, baselineSigma: cal.baselineSigma });
    for (let t = 1; t <= 8000; t += 1) {
      if (d.update(gaussianNoise(rArl)).alarm) {
        total += t;
        done += 1;
        break;
      }
    }
  }
  const mcArl = total / done;
  ok(
    Math.abs(mcArl - 1000) / 1000 <= 0.12,
    `蒙特卡洛零状态 ARL = ${mcArl.toFixed(1)}（600 条全告警）, |MC−1000|/1000 = ${(Math.abs(mcArl - 1000) / 1000).toFixed(3)} ≤ 0.12（MC SE≈41; 残差来自 σ̂ 估计噪声, 非链偏差）`,
  );

  // 统计量轨迹逐位精确: k=0.5, h=4, 无基线（输入即标准化 z, 每步增量 z−k = 1.0）
  const det = new CUSUMDetector({ k: 0.5, h: 4 });
  const traj = [];
  for (let i = 0; i < 5; i += 1) traj.push(det.update(0).c); // 零漂移: C 钳在 0
  for (let i = 0; i < 10; i += 1) traj.push(det.update(1.5).c); // 1,2,3,4,5>4 告警→0,1,2,3,4,5>4 告警→0
  traj.push(det.update(-9).c); // 负增量钳位回 0
  const expectTraj = [0, 0, 0, 0, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 0, 0];
  ok(
    traj.every((v, i) => near(v, expectTraj[i], 1e-12)),
    `Cₜ 轨迹逐位精确: [${traj.join(',')}] = max(0,C+(z−k)) 且告警（5>4）后零状态复位`,
  );
  ok(
    det.alarmCount === 2 && det.iterations === 16,
    `告警计数 = ${det.alarmCount}（两次: 第 5、10 个 1.5 观测）, 迭代数 = ${det.iterations}`,
  );
  det.reset();
  ok(det.alarmCount === 0 && det.statistic === 0 && det.iterations === 0, 'reset() 清零全部状态');

  // 检测延迟: t=60 注入 +0.5σ 均值漂移, CUSUM vs 同误报率朴素单点阈值（Φ⁻¹(0.999)）
  const L = normalQuantile(0.999);
  const cusumDelays = [];
  const naiveDelays = [];
  const rDelay = mulberry32(31337);
  for (let rep = 0; rep < 500; rep += 1) {
    const d = new CUSUMDetector({ k: cal.k, h: cal.h, baselineMean: cal.baselineMean, baselineSigma: cal.baselineSigma });
    let cd = -1;
    let nd = -1;
    for (let t = 0; t < 3000; t += 1) {
      const z = gaussianNoise(rDelay) + (t >= 60 ? 0.5 : 0);
      const read = d.update(z);
      if (t >= 60 && cd < 0 && read.alarm) cd = t - 60;
      if (t >= 60 && nd < 0 && z > L) nd = t - 60;
      if (cd >= 0 && nd >= 0) break;
    }
    cusumDelays.push(cd);
    naiveDelays.push(nd);
  }
  const csMean = mean(cusumDelays);
  const nvMean = mean(naiveDelays);
  const sortedCs = [...cusumDelays].sort((a, b) => a - b);
  const p90 = sortedCs[Math.floor(0.9 * sortedCs.length)];
  const maxDelay = sortedCs[sortedCs.length - 1];
  ok(
    csMean <= nvMean / 3,
    `检测延迟: CUSUM 均值 ${csMean.toFixed(1)} ≤ 朴素阈值法 ${nvMean.toFixed(1)} 的 1/3（比值 ${(nvMean / csMean).toFixed(1)}×——序贯累积对小位移的优势）`,
  );
  ok(
    csMean <= 60 && p90 <= 120 && maxDelay <= 300,
    `CUSUM 延迟有界: 均值 ${csMean.toFixed(1)}, p90 = ${p90}, max = ${maxDelay}（500 条全部检出）`,
  );
  ok(
    nvMean > 140 && nvMean < 280,
    `朴素阈值法延迟健全性: ${nvMean.toFixed(1)}（理论 1/Φ(−(3.0902−0.5)) ≈ 208）`,
  );
  ok(
    throws(() => cusumARLSiegmund(-1, 4)) && throws(() => calibrateThreshold([1, 2], 0.01)),
    'CUSUM 入参校验: 非法 k / 过短基准序列 throw',
  );
}

// ═══════════════════ 3. 收缩协方差: p > n 不崩 + LW 强度自适应 ═══════════════════

section('3. 高维收缩协方差: p=64 > n=40（未收缩奇异诚实报告）');

{
  const rand = mulberry32(767676);
  const draw = (dim, r) => Array.from({ length: dim }, () => gaussianNoise(r));
  const refHD = Array.from({ length: 40 }, () => draw(64, rand));
  const testIn = draw(64, rand);
  const testOut = draw(64, rand).map((v) => v + 1.5); // 每分量 1.5 → |shift| = 1.5×8 = 12σ

  const unshrunk = mahalanobisDepth(refHD, testIn, { shrinkage: 0 });
  ok(
    unshrunk.degenerate === true && Number.isNaN(unshrunk.d2) && unshrunk.novel === true,
    `未收缩（shrinkage=0）: p=64 > 秩≤39 → degenerate=true, d²=NaN, novel=true（诚实报告奇异, 不给假数）`,
  );

  const lwHD = ledoitWolfIntensity(refHD);
  const autoIn = mahalanobisDepth(refHD, testIn);
  const autoOut = mahalanobisDepth(refHD, testOut);
  ok(
    lwHD.intensity > 0.5 && lwHD.intensity <= 1,
    `LW 自动强度 = ${lwHD.intensity.toFixed(4)} > 0.5（n=40 ≪ p=64 → 近满收缩, Σ* 恒正定）`,
  );
  ok(
    Number.isFinite(autoIn.d2) && Number.isFinite(autoOut.d2) && autoIn.degenerate === false && autoOut.degenerate === false,
    `收缩后不崩: 内点 d² = ${autoIn.d2.toFixed(2)}, 外点 d² = ${autoOut.d2.toFixed(2)} 均有限`,
  );
  ok(
    autoIn.chiSquareRatio > 0.7 && autoIn.chiSquareRatio < 1.5,
    `内点 χ² 比 = ${autoIn.chiSquareRatio.toFixed(3)} ∈ (0.7, 1.5)（高维自归一口径仍 ≈ 1）`,
  );
  ok(
    autoOut.chiSquareRatio >= 2.5 * autoIn.chiSquareRatio,
    `外点 χ² 比 = ${autoOut.chiSquareRatio.toFixed(3)} ≥ 2.5× 内点（12σ 位移分离）`,
  );
  ok(
    autoOut.pValue < 1e-10 && autoIn.pValue > 0.05 && autoOut.novel && !autoIn.novel,
    `高维判定正确: 外点 p = ${autoOut.pValue.toExponential(2)} < 1e−10 且 novel, 内点 p = ${autoIn.pValue.toFixed(3)} > 0.05 且非 novel`,
  );

  // LW 强度自适应: 各向同性基准（无相关结构可保留 → 收缩近满）vs 强相关基准（收缩放松）
  const r2 = mulberry32(777);
  const Sigma = [
    [1, 0.8, 0, 0],
    [0.8, 1, 0, 0],
    [0, 0, 1, 0.7],
    [0, 0, 0.7, 1],
  ];
  const corrRef = Array.from({ length: 300 }, () => {
    const z = Array.from({ length: 4 }, () => gaussianNoise(r2));
    return Sigma.map((row) => row.reduce((s, c, j) => s + c * z[j], 0));
  });
  const rand3 = mulberry32(20261002);
  const isoRef = Array.from({ length: 300 }, () => Array.from({ length: 4 }, () => gaussianNoise(rand3)));
  const isoI = ledoitWolfIntensity(isoRef).intensity;
  const corrI = ledoitWolfIntensity(corrRef).intensity;
  ok(
    corrI < 0.1 && corrI < isoI / 2,
    `LW 强度自适应: 各向同性 ${isoI.toFixed(3)} vs 强相关 ${corrI.toFixed(4)}（相关结构值得保留时自动放松, 不是常量插值）`,
  );
}

// ═══════════════════ 4. 自适应基准窗: 概念漂移后自愈 ═══════════════════

section('4. 自适应基准窗: 慢漂移（0.02σ/步 × 600 步）后的自愈');

{
  const rand = mulberry32(909090);
  const gauss = () => gaussianNoise(rand);
  const window = new AdaptiveReferenceWindow({ capacity: 150, halfLife: 40, minSamples: 30, alpha: 0.01 });
  // 固定基准对照（同分布独立 200 样本, 永不更新）
  const fixedRef = Array.from({ length: 200 }, () => [gauss(), gauss()]);

  let earlyAdaptive = 0;
  let earlyN = 0;
  for (let t = 0; t < 200; t += 1) {
    const read = window.observe([gauss(), gauss()]);
    if (t >= 100) {
      earlyN += 1;
      if (read.novel) earlyAdaptive += 1;
    }
  }
  ok(
    earlyAdaptive / earlyN <= 0.05,
    `平稳段自适应误报率 = ${(earlyAdaptive / earlyN).toFixed(3)} ≤ 0.05（χ²₂ 0.01 水平名义覆盖）`,
  );

  // 慢漂移: 均值每步 +0.02σ, 600 步共 12σ
  const adaptFlags = [];
  const fixedFlags = [];
  let drift = [0, 0];
  for (let t = 0; t < 600; t += 1) {
    drift = [drift[0] + 0.02, 0];
    const s = [gauss() + drift[0], gauss()];
    adaptFlags.push(window.observe(s).novel);
    fixedFlags.push(mahalanobisDepth(fixedRef, s, { alpha: 0.01 }).novel);
  }
  const flagRate = (xs) => xs.filter(Boolean).length / xs.length;
  const lateAdapt = flagRate(adaptFlags.slice(-150));
  const lateFixed = flagRate(fixedFlags.slice(-150));
  ok(
    lateAdapt <= 0.08,
    `漂移末期 150 步（总位移 9~12σ）: 自适应误报 = ${lateAdapt.toFixed(3)} ≤ 0.08（旧样本老化出局, 基准跟随新世界）`,
  );
  ok(
    lateFixed >= 0.9,
    `对照固定基准误报 = ${lateFixed.toFixed(3)} ≥ 0.9（世界已换, 静态「已见」失效）`,
  );

  // 漂移停止后新位置平稳段: 新内点不再误报
  const postAdapt = [];
  const postFixed = [];
  for (let t = 0; t < 100; t += 1) {
    const s = [gauss() + drift[0], gauss()];
    postAdapt.push(window.observe(s).novel);
    postFixed.push(mahalanobisDepth(fixedRef, s, { alpha: 0.01 }).novel);
  }
  ok(
    flagRate(postAdapt.slice(-50)) <= 0.05,
    `漂移后新内点（平稳 50 步）: 自适应误报 = ${flagRate(postAdapt.slice(-50)).toFixed(3)} ≤ 0.05（自愈完成）`,
  );
  ok(
    flagRate(postFixed.slice(-50)) >= 0.9,
    `对照固定基准仍误报 = ${flagRate(postFixed.slice(-50)).toFixed(3)} ≥ 0.9（不会自愈）`,
  );

  const view = window.reference();
  const wsum = view.weights.reduce((a, b) => a + b, 0);
  const wxMean = view.samples.reduce((s, smp, i) => s + (view.weights[i] / wsum) * smp[0], 0);
  const fixedMean = fixedRef.reduce((s, smp) => s + smp[0], 0) / fixedRef.length;
  ok(
    Math.abs(wxMean - drift[0]) <= 0.5,
    `窗内加权均值 = ${wxMean.toFixed(3)} 跟随真实均值 ${drift[0].toFixed(2)}（|差| ≤ 0.5σ）`,
  );
  ok(
    Math.abs(fixedMean - drift[0]) >= 9,
    `对照固定基准均值停在 ${fixedMean.toFixed(3)}（离新世界 ${Math.abs(fixedMean - drift[0]).toFixed(1)}σ）`,
  );
  ok(
    view.effectiveSize > 20 && view.effectiveSize <= 150,
    `有效样本量 ESS = ${view.effectiveSize.toFixed(1)} ∈ (20, 150]（衰减口径下小于容量）`,
  );

  // 确定性: 同种子同配置两条窗逐位一致
  const wa = new AdaptiveReferenceWindow({ capacity: 50, halfLife: 10 });
  const wb = new AdaptiveReferenceWindow({ capacity: 50, halfLife: 10 });
  const rd = mulberry32(64);
  for (let t = 0; t < 80; t += 1) {
    const s = [gaussianNoise(rd), gaussianNoise(rd) + 0.01 * t];
    wa.observe(s);
    wb.observe(s);
  }
  ok(
    JSON.stringify(wa.reference()) === JSON.stringify(wb.reference()),
    '同输入同输出: 两个相同配置的窗喂同一序列 → 基准视图逐位一致',
  );
}

// ═══════════════════ 5. 入参校验与纯度 ═══════════════════

section('5. 入参校验（显式 throw）与同输入同输出');

{
  const rand = mulberry32(3);
  const ref = Array.from({ length: 30 }, () => [gaussianNoise(rand), gaussianNoise(rand)]);
  const x = [0.1, -0.2];
  ok(throws(() => mahalanobisDepth([[1, 2]], [1, 2])), 'mahalanobisDepth: 基准集 < 2 样本 → throw');
  ok(throws(() => mahalanobisDepth(ref, [1])), 'mahalanobisDepth: 待测点维度不匹配 → throw');
  ok(throws(() => mahalanobisDepth(ref, [1, NaN])), 'mahalanobisDepth: 非有限待测点 → throw');
  ok(throws(() => mahalanobisDepth(ref, x, { shrinkage: 1.5 })), 'mahalanobisDepth: shrinkage ∉ [0,1) → throw');
  ok(throws(() => mahalanobisDepth(ref, x, { alpha: 0 })), 'mahalanobisDepth: alpha ∉ (0,1) → throw');
  ok(throws(() => mahalanobisDepth(ref, x, { weights: [1, 1] })), 'mahalanobisDepth: 权重长度不匹配 → throw');
  ok(throws(() => knnNovelty(ref, x, { k: 0 })), 'knnNovelty: k < 1 → throw');
  ok(throws(() => knnNovelty(ref, x, { k: ref.length + 1 })), 'knnNovelty: k > n → throw');
  ok(throws(() => knnNovelty(ref, x, { power: 0.5 })), 'knnNovelty: power < 1 → throw');
  ok(throws(() => noveltyAUC(ref, [], [x])), 'noveltyAUC: 空内点集 → throw');
  ok(throws(() => noveltyAUC(ref, [x], [[1, 2, 3]])), 'noveltyAUC: 外点维度不匹配 → throw');
  ok(throws(() => new CUSUMDetector({ k: 0, h: 1 })), 'CUSUMDetector: k ≤ 0 → throw');
  ok(throws(() => new CUSUMDetector({ k: 0.5, h: -1 })), 'CUSUMDetector: h ≤ 0 → throw');
  ok(throws(() => new CUSUMDetector({ k: 0.5, h: 4, baselineSigma: 1 })), 'CUSUMDetector: 基线只给 σ 不给 μ → throw');
  ok(throws(() => calibrateThreshold([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 2)), 'calibrateThreshold: 误报率 ∉ (0,0.5] → throw');
  ok(throws(() => calibrateThreshold(Array.from({ length: 50 }, () => 7), 0.01)), 'calibrateThreshold: 恒定基准序列（零离散）→ throw');
  ok(throws(() => normalQuantile(1)), 'normalQuantile: q=1 越界 → throw');
  ok(throws(() => chiSquareQuantile(4, 0)), 'chiSquareQuantile: q=0 越界 → throw');
  ok(throws(() => ledoitWolfIntensity(ref, [1, -1])), 'ledoitWolfIntensity: 非正权重 → throw');
  ok(throws(() => new AdaptiveReferenceWindow({ capacity: 1 })), 'AdaptiveReferenceWindow: capacity < 2 → throw');
  const win = new AdaptiveReferenceWindow({ capacity: 20, halfLife: 5 });
  win.push([1, 2]);
  ok(throws(() => win.push([1, 2, 3])), 'AdaptiveReferenceWindow.push: 维度不一致 → throw');

  const r1 = mahalanobisDepth(ref, x);
  const r2 = mahalanobisDepth(ref, x);
  ok(JSON.stringify(r1) === JSON.stringify(r2), 'mahalanobisDepth 同输入同输出（JSON 逐位一致）');
  const k1 = knnNovelty(ref, x, { k: 3 });
  const k2 = knnNovelty(ref, x, { k: 3 });
  ok(JSON.stringify(k1) === JSON.stringify(k2), 'knnNovelty 同输入同输出（JSON 逐位一致）');
}

// ─────────────────── 汇总 ───────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exitCode = 1;
