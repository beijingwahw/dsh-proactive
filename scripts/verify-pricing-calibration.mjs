/**
 * verify-pricing-calibration.mjs — 65.0/75.0「学习定价 + 在线校准」双内核纯数学离线验证
 *
 * 直接 import 两个内核源文件（node --experimental-strip-types 运行，
 * 不经 dist 构建）。每个断言都有解析解或构造轨迹对照：
 *
 *   65.0 动态定价内核（线性基准 d(p)=1−p ⇒ p*=0.5、R*=0.25 解析锚）：
 *     - 市场：解析最优精确命中 / 自定义曲线 d=1−p² 数值最优 ≈ 1/√3 对照 /
 *       同种子购买序列逐位复现
 *     - 固定价 0.3：期望遗憾 = 1000×(0.25−0.21) = 40 精确（期望收益口径
 *       消掉伯努利噪声——遗憾逐位确定）
 *     - 三算法 200 种子（checkpoints 500/1000/2000/5000）：
 *       ① regret/T 递减（中位 + 逐种子配对 ≥90%）；√T 粗检
 *          regret(5000)/regret(500)：学习算法 < 5，固定价对照恰 = 10
 *       ② 学习中位 |p̂_final − 0.5| < 0.05
 *       ③ 中位遗憾序 Thompson ≤ UCB ≤ 固定价
 *       ④ UCB 双对数斜率 ∈ [0.4, 0.7]（√T 率实证）；Thompson 斜率 < 0.8
 *
 *   75.0 在线校准内核（失准流：真 p=0.7、预报恒 0.5、种子化伯努利）：
 *     - ECE 度量：失准流 ≈0.2 / 完美流 < 0.06 / 非法输入显式 throw
 *     - PAVA 手工精确解：[3,1,2]→[2,2,2]、[4,4,1,1,4]→[2.5,2.5,2.5,2.5,4]、
 *       加权池化 [5,1,1]×w[1,1,3]→[1.8]³、[1,3,2]×w[1,2,1]→[1,8/3,8/3]、
 *       已单调序列不动
 *     - 随机 40 例：输出单调不减 + 变分性质（加权 SSE ≤ 排序解/常数解/
 *       累积最大解——投影最优性的逐例对照）
 *     - 在线 Platt：常预报 z=0 下 a 恰不被扰动；σ(a·logit 0.5+b) ≈ 0.7
 *       （b → logit(0.7)）；对数损失显著下降
 *     - 窗口 isotonic：并列池化 → 常预报流输出 = 窗口均值 ≈ 0.7；
 *       ECE 修复；映射单调
 *     - 混合门控：失准流 ECE 下降 ≥ 80%（哨兵 n≈150 确证激活）；
 *       完美流哨兵零误触发、输出逐位恒等（ECE 一分不涨——零漂移性质）
 *
 * 全部断言确定性（mulberry32 种子）。运行：
 *   node --experimental-strip-types scripts/verify-pricing-calibration.mjs
 */

import {
  LINEAR_OPTIMUM,
  makeMarketplace,
  FixedPricePolicy,
  ucbPricing,
  thompsonPricing,
  runTrial,
  regretCurve,
  logLogSlope,
} from '../src/core/dynamic-pricing.ts';
import {
  calibrationError,
  pava,
  onlinePlatt,
  windowedIsotonic,
  CalibrationDriftDetector,
  gatedCalibrator,
} from '../src/core/online-calibration.ts';

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

/** 确定性 RNG（mulberry32） */
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
function bernoulli(rng, p) {
  return rng() < p ? 1 : 0;
}
function vecEq(a, b, tol = 1e-9) {
  return a.length === b.length && a.every((v, i) => near(v, b[i], tol));
}

/** 失准流：真 p=0.7、预报恒 0.5（系统性保守偏置） */
function biasedStream(seed, n) {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => ({ p: 0.5, y: bernoulli(rng, 0.7) }));
}
/** 完美校准流：p_t 本身就是真实概率（y_t ~ Bernoulli(p_t)，p_t 种子化抽取） */
function perfectStream(seed, n) {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => {
    const p = rng();
    return { p, y: bernoulli(rng, p) };
  });
}

// ═══════════════════ 65.0 动态定价 ═══════════════════

section('65.0 学习定价：市场模拟器解析锚与确定性');

{
  const market = makeMarketplace({ noiseSeed: 1 });
  ok(
    near(market.optimum.price, LINEAR_OPTIMUM.price, 1e-12) && near(market.optimum.revenue, LINEAR_OPTIMUM.revenue, 1e-12),
    `线性基准市场最优 p*=0.5、R*=0.25 精确命中（得到 ${market.optimum.price}/${market.optimum.revenue}）`,
  );
  ok(near(market.trueDemand(0.3), 0.7, 1e-12), `真需求 d(0.3)=0.7（1−p 精确）`);
  const m1 = makeMarketplace({ noiseSeed: 42 });
  const m2 = makeMarketplace({ noiseSeed: 42 });
  let same = true;
  for (let i = 0; i < 50; i += 1) if (m1.offer(0.5) !== m2.offer(0.5)) same = false;
  ok(same, '同 noiseSeed 购买序列逐位复现（50 期报价 0.5 对照）');
  // 自定义曲线 d(p) = 1 − p²：R(p) = p − p³，p* = 1/√3 ≈ 0.57735，R* = 2/(3√3) ≈ 0.38490
  const custom = makeMarketplace({ demand: (p) => 1 - p * p, noiseSeed: 3 });
  ok(
    near(custom.optimum.price, 1 / Math.sqrt(3), 5e-4) && near(custom.optimum.revenue, 2 / (3 * Math.sqrt(3)), 5e-4),
    `自定义需求 d=1−p²：数值最优 ${custom.optimum.price.toFixed(5)}/${custom.optimum.revenue.toFixed(5)} ≈ 解析 1/√3=${(1 / Math.sqrt(3)).toFixed(5)}、2/(3√3)=${(2 / (3 * Math.sqrt(3))).toFixed(5)}`,
  );
  let threw = false;
  try {
    makeMarketplace({ noiseSeed: 1, demand: (p) => p * 2 });
  } catch {
    threw = true;
  }
  ok(threw, '需求曲线输出越界 [0,1] 显式 throw');
}

section('65.0 固定价对照：期望收益口径的确定性遗憾');

{
  const result = runTrial(new FixedPricePolicy(0.3), 1000, 7);
  ok(
    near(result.regret, 1000 * (0.25 - 0.3 * 0.7), 1e-9),
    `固定价 0.3 遗憾 = ${result.regret.toFixed(6)} = 1000×(0.25−0.21) 精确（期望口径消掉伯努利噪声）`,
  );
  ok(
    result.finalPrice === 0.3 && near(result.averageRegret, 0.04, 1e-12) && result.estimatedOptimalPrice === undefined,
    `finalPrice=0.3、平均遗憾 0.04/期、无需求信念（estimate=undefined）`,
  );
}

section('65.0 三算法 200 种子：遗憾曲线 / 收敛价 / 序关系 / √T 率');

{
  const seeds = Array.from({ length: 200 }, (_, i) => 1000 + i);
  const checkpoints = [500, 1000, 2000, 5000];
  const t0 = Date.now();
  const ucb = regretCurve({ policy: () => ucbPricing({}), seeds, checkpoints });
  const tsp = regretCurve({ policy: (s) => thompsonPricing({ seed: s }), seeds, checkpoints });
  const fix = regretCurve({ policy: () => new FixedPricePolicy(0.3), seeds, checkpoints });
  const at = (report, t) => report.points.find((pt) => pt.t === t);
  console.log(
    `  · 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s｜中位累计遗憾 @500/@1000/@2000/@5000：UCB ${ucb.points.map((p) => p.medianRegret.toFixed(1)).join('/')}、Thompson ${tsp.points.map((p) => p.medianRegret.toFixed(1)).join('/')}、固定 ${fix.points.map((p) => p.medianRegret.toFixed(1)).join('/')}`,
  );

  // ① regret(T)/T 递减 + 逐种子配对
  ok(
    at(ucb, 5000).medianAvgRegret < at(ucb, 500).medianAvgRegret &&
      at(tsp, 5000).medianAvgRegret < at(tsp, 500).medianAvgRegret,
    `① regret(T)/T 递减：UCB ${at(ucb, 500).medianAvgRegret.toFixed(4)}→${at(ucb, 5000).medianAvgRegret.toFixed(4)}、Thompson ${at(tsp, 500).medianAvgRegret.toFixed(4)}→${at(tsp, 5000).medianAvgRegret.toFixed(4)}（@500→@5000）`,
  );
  ok(
    at(ucb, 5000).improvingFraction >= 0.9 && at(tsp, 5000).improvingFraction >= 0.9,
    `① 逐种子配对递减占比：UCB ${(at(ucb, 5000).improvingFraction * 100).toFixed(0)}%、Thompson ${(at(tsp, 5000).improvingFraction * 100).toFixed(0)}%（≥90% 种子平均遗憾 @5000 ≤ @500）`,
  );

  // ① √T 率粗检：学习算法显著低于线性 10 倍，固定价恰为 10 倍
  const ratioU = at(ucb, 5000).medianRegret / at(ucb, 500).medianRegret;
  const ratioT = at(tsp, 5000).medianRegret / at(tsp, 500).medianRegret;
  const ratioF = at(fix, 5000).medianRegret / at(fix, 500).medianRegret;
  ok(
    ratioU < 5 && ratioT < 5,
    `① √T 粗检：regret(5000)/regret(500)——UCB ${ratioU.toFixed(2)}、Thompson ${ratioT.toFixed(2)}（显著 < 线性 10；√T 参考 √10≈3.16）`,
  );
  ok(
    near(ratioF, 10, 1e-6),
    `① 对照：固定价 ${ratioF.toFixed(4)} = 10.0000（无学习遗憾严格线性——学习算法 5 倍内的差异即学习证据）`,
  );

  // ② 收敛价
  ok(
    ucb.finalPriceErrorMedian < 0.05 && tsp.finalPriceErrorMedian < 0.05,
    `② 收敛价：中位 |p̂_final−0.5|——UCB ${ucb.finalPriceErrorMedian.toFixed(4)}（p̂=${ucb.finalPriceMedian.toFixed(3)}）、Thompson ${tsp.finalPriceErrorMedian.toFixed(4)}（p̂=${tsp.finalPriceMedian.toFixed(3)}）均 < 0.05`,
  );

  // ③ 中位遗憾序
  ok(
    at(tsp, 5000).medianRegret <= at(ucb, 5000).medianRegret && at(ucb, 5000).medianRegret <= at(fix, 5000).medianRegret,
    `③ 中位遗憾序 Thompson ${at(tsp, 5000).medianRegret.toFixed(1)} ≤ UCB ${at(ucb, 5000).medianRegret.toFixed(1)} ≤ 固定价 ${at(fix, 5000).medianRegret.toFixed(1)}（@5000）`,
  );

  // ④ 双对数斜率
  const slopeU = logLogSlope(ucb.points.map((pt) => ({ t: pt.t, value: pt.medianRegret })));
  const slopeT = logLogSlope(tsp.points.map((pt) => ({ t: pt.t, value: pt.medianRegret })));
  const slopeF = logLogSlope(fix.points.map((pt) => ({ t: pt.t, value: pt.medianRegret })));
  ok(
    slopeU >= 0.4 && slopeU <= 0.7,
    `④ UCB 双对数斜率 ${slopeU.toFixed(3)} ∈ [0.4, 0.7]（√T 率实证；线性=1.0）`,
  );
  ok(
    slopeT >= 0.4 && slopeT <= 0.7,
    `④ Thompson 双对数斜率 ${slopeT.toFixed(3)} ∈ [0.4, 0.7]（√T 率实证；固定价对照 ${slopeF.toFixed(3)} ≈ 1）`,
  );
}

// ═══════════════════ 75.0 在线校准 ═══════════════════

section('75.0 校准误差 ECE：失准度量与输入校验');

{
  const biased = biasedStream(7, 2000);
  const raw = calibrationError(biased);
  ok(
    raw.ece > 0.17 && raw.ece < 0.23 && raw.buckets[5].n === 2000,
    `失准流（预报 0.5/真 0.7）ECE = ${raw.ece.toFixed(4)}（实测频率 ${raw.buckets[5].empirical.toFixed(3)}，2000 点全落 [0.5,0.6) 桶）`,
  );
  const perfectReport = calibrationError(perfectStream(13, 2000));
  ok(
    perfectReport.ece < 0.06,
    `完美校准流 ECE = ${perfectReport.ece.toFixed(4)} < 0.06（只剩抽样噪声量级）`,
  );
  let threw = false;
  try {
    calibrationError([]);
  } catch {
    threw = true;
  }
  ok(threw, '空观测流显式 throw');
  threw = false;
  try {
    calibrationError([{ p: 1.2, y: 0 }]);
  } catch {
    threw = true;
  }
  ok(threw, 'p ∉ [0,1] 显式 throw');
  threw = false;
  try {
    calibrationError([{ p: 0.5, y: 0.5 }]);
  } catch {
    threw = true;
  }
  ok(threw, 'y ∉ {0,1} 显式 throw');
}

section('75.0 PAVA：手工已知解精确对照');

{
  ok(vecEq(pava([3, 1, 2]), [2, 2, 2]), `pava([3,1,2]) = [${pava([3, 1, 2]).join(',')}]（3,1 违序池化为 2，恰与 2 齐平）`);
  const cascade = pava([4, 4, 1, 1, 4]);
  ok(
    vecEq(cascade, [2.5, 2.5, 2.5, 2.5, 4]),
    `pava([4,4,1,1,4]) = [${cascade.join(',')}]（级联池化：4,4,1,1 → 2.5×4，尾 4 独立成块）`,
  );
  const weighted = pava([5, 1, 1], [1, 1, 3]);
  ok(
    vecEq(weighted, [1.8, 1.8, 1.8]),
    `pava([5,1,1], w=[1,1,3]) = [${weighted.join(',')}]（加权池化 (5+1+1·3)/5 = 1.8 精确）`,
  );
  const partial = pava([1, 3, 2], [1, 2, 1]);
  ok(
    vecEq(partial, [1, 8 / 3, 8 / 3]),
    `pava([1,3,2], w=[1,2,1]) = [${partial.map((v) => v.toFixed(4)).join(',')}]（仅 3,2 池化 → (3·2+2)/3 = 8/3，首 1 不动）`,
  );
  ok(vecEq(pava([1, 2, 3]), [1, 2, 3]) && vecEq(pava([7]), [7]), '已单调序列逐位不动（[1,2,3]、[7]）');
  let threw = false;
  try {
    pava([]);
  } catch {
    threw = true;
  }
  ok(threw, '空序列显式 throw');
  threw = false;
  try {
    pava([1, 2], [1]);
  } catch {
    threw = true;
  }
  ok(threw, 'weights 长度失配显式 throw');
}

section('75.0 PAVA：随机序列的单调性与变分性质');

{
  const rng = mulberry32(99);
  let allMonotone = true;
  let allVariational = true;
  let worstSlack = Number.NEGATIVE_INFINITY;
  const sse = (values, weights, target) => {
    let s = 0;
    for (let i = 0; i < values.length; i += 1) s += weights[i] * (target[i] - values[i]) ** 2;
    return s;
  };
  for (let trialIdx = 0; trialIdx < 40; trialIdx += 1) {
    const n = 5 + Math.floor(rng() * 20);
    const values = Array.from({ length: n }, () => rng());
    const weights = Array.from({ length: n }, () => 1 + Math.floor(rng() * 5));
    const fitted = pava(values, weights);
    for (let i = 1; i < n; i += 1) if (fitted[i] < fitted[i - 1] - 1e-12) allMonotone = false;
    // 变分性质：PAVA 解的加权 SSE ≤ 任意单调候选（排序解 / 常数解 / 累积最大解）。
    // slack = PAVA_SSE − 候选SSE ≤ 0（最大者 = 最逼近违例的一次对照）
    const pavaSse = sse(values, weights, fitted);
    const sortedAsc = [...values].sort((a, b) => a - b);
    const constant = Array.from({ length: n }, () => values.reduce((s, v, i) => s + v * weights[i], 0) / weights.reduce((s, w) => s + w, 0));
    let runMax = Number.NEGATIVE_INFINITY;
    const cummax = values.map((v) => (runMax = Math.max(runMax, v)));
    for (const candidate of [sortedAsc, constant, cummax]) {
      const slack = pavaSse - sse(values, weights, candidate);
      if (slack > 1e-9) allVariational = false;
      worstSlack = Math.max(worstSlack, slack);
    }
  }
  ok(allMonotone, '随机 40 例（长度 5–24、整数权 1–5）：输出全部单调不减');
  ok(
    allVariational,
    `变分性质：PAVA 解加权 SSE ≤ 排序解/常数解/累积最大解（最大松弛 ${worstSlack.toExponential(2)} ≤ 1e-9——到单调锥的投影最优）`,
  );
}

section('75.0 在线 Platt：参数方向与收敛');

{
  const platt = onlinePlatt({ lr: 0.05 });
  const pairs = biasedStream(11, 2000);
  const calibrated = [];
  for (const pair of pairs) {
    const phat = platt.calibrateNext(pair.p);
    platt.observe(pair.y);
    calibrated.push(phat);
  }
  const stats = platt.stats();
  ok(
    near(stats.a, 1, 1e-12),
    `⑤ 常预报 z=logit(0.5)=0：梯度对 a 的分量为 0，a 逐位保持 1（a=${stats.a}，${stats.steps} 步 SGD）`,
  );
  const atHalf = platt.calibrate(0.5);
  ok(
    Math.abs(atHalf - 0.7) <= 0.06,
    `⑤ σ(a·logit(0.5)+b) = ${atHalf.toFixed(4)} ≈ 0.7（|偏差| ${(Math.abs(atHalf - 0.7)).toFixed(4)} ≤ 0.06；b=${stats.b.toFixed(4)} → logit(0.7)=${Math.log(0.7 / 0.3).toFixed(4)}）`,
  );
  ok(
    stats.b > 0.4,
    `⑤ b=${stats.b.toFixed(4)} > 0.4：参数收敛方向正确（恒等 b=0 → 上调至真实 logit）`,
  );
  const logLoss = (ps) => {
    let s = 0;
    for (let i = 0; i < ps.length; i += 1) {
      const p = Math.min(1 - 1e-9, Math.max(1e-9, ps[i]));
      s += -(pairs[2000 - ps.length + i].y * Math.log(p) + (1 - pairs[2000 - ps.length + i].y) * Math.log(1 - p));
    }
    return s / ps.length;
  };
  const rawTail = pairs.slice(500).map((pair) => pair.p);
  const calTail = calibrated.slice(500);
  ok(
    logLoss(calTail) < logLoss(rawTail) - 0.02,
    `对数损失：校准后 ${logLoss(calTail).toFixed(4)} < 原始 ${logLoss(rawTail).toFixed(4)} − 0.02（后 1500 点；0.693=ln2 恒报 0.5 的下界方向）`,
  );
}

section('75.0 窗口 isotonic：并列池化与 ECE 修复');

{
  const iso = windowedIsotonic({ window: 300, minPoints: 30 });
  const pairs = biasedStream(17, 2000);
  const calibrated = [];
  for (const pair of pairs) {
    calibrated.push(iso.calibrateNext(pair.p));
    iso.observe(pair.y);
  }
  const tail = calibrated.slice(500);
  const mean = tail.reduce((s, v) => s + v, 0) / tail.length;
  ok(
    Math.abs(mean - 0.7) <= 0.05,
    `并列池化：常预报流的映射 = 窗口均值 ${mean.toFixed(4)} ≈ 0.7（|偏差| ≤ 0.05，后 1500 点）`,
  );
  const eceAfter = calibrationError(tail.map((p, i) => ({ p, y: pairs[500 + i].y })));
  ok(
    eceAfter.ece < 0.06,
    `isotonic 校准后 ECE = ${eceAfter.ece.toFixed(4)} < 0.06（原始 ≈ 0.2；窗口均值口径）`,
  );
  const fit = iso.currentFit();
  let monotone = fit !== undefined;
  for (let i = 1; i < fit.length; i += 1) if (fit[i].fitted < fit[i - 1].fitted - 1e-12) monotone = false;
  ok(
    monotone && Math.abs(iso.map(0.5) - 0.7) <= 0.05,
    `当前映射单调不减（${fit.length} 组并列池化点）且 map(0.5) = ${iso.map(0.5).toFixed(4)} ≈ 0.7`,
  );
}

section('75.0 失准检测器与混合门控：修失准 + 恒等无伤害');

{
  // 哨兵单独确证：失准流应在 ~200 点内确证（4σ × 连续 2 检）
  const detector = new CalibrationDriftDetector({});
  const pairs = biasedStream(23, 2000);
  let confirmedAt = -1;
  for (let i = 0; i < pairs.length; i += 1) {
    const view = detector.observe(pairs[i].p, pairs[i].y);
    if (view.miscalibrated && confirmedAt < 0) confirmedAt = view.n;
  }
  ok(
    confirmedAt > 0 && confirmedAt <= 200,
    `失准确证：连续 2 次 z>4 在 n=${confirmedAt} ≤ 200 触发（最差桶 z=${detector.view().worstZ.toFixed(2)}、gap=${detector.view().worstGap.toFixed(3)}）`,
  );

  // 门控修失准：ECE 下降 ≥ 80%
  const gate = gatedCalibrator({});
  const outputs = [];
  let activatedAt = undefined;
  for (const pair of pairs) {
    const phat = gate.calibrateNext(pair.p);
    gate.observe(pair.y);
    outputs.push(phat);
    if (activatedAt === undefined && gate.status().active) activatedAt = gate.status().activatedAt;
  }
  const rawEce = calibrationError(pairs).ece;
  const afterEce = calibrationError(outputs.map((p, i) => ({ p, y: pairs[i].y }))).ece;
  const drop = 1 - afterEce / rawEce;
  ok(
    gate.status().active && activatedAt <= 200,
    `混合门控在 n=${activatedAt} 激活（≤ 200；激活后走 Platt 路由）`,
  );
  ok(
    drop >= 0.8,
    `① 失准流校准：ECE ${rawEce.toFixed(4)} → ${afterEce.toFixed(4)}（下降 ${(drop * 100).toFixed(1)}% ≥ 80%；真 p=0.7、预报恒 0.5、2000 点）`,
  );

  // 门控恒等无伤害：完美校准流（多种子——零误触发不是单种子运气）
  let allIdentical = true;
  let anyActivated = false;
  let totalChecks = 0;
  let worstEceDelta = Number.NEGATIVE_INFINITY;
  for (const seed of [31, 37, 41, 53, 61]) {
    const perfect = perfectStream(seed, 2000);
    const gate2 = gatedCalibrator({});
    const outputs2 = [];
    let identical = true;
    for (const pair of perfect) {
      const phat = gate2.calibrateNext(pair.p);
      if (phat !== pair.p) identical = false;
      gate2.observe(pair.y);
      outputs2.push(phat);
    }
    const inEce = calibrationError(perfect).ece;
    const outEce = calibrationError(outputs2.map((p, i) => ({ p, y: perfect[i].y }))).ece;
    worstEceDelta = Math.max(worstEceDelta, outEce - inEce);
    allIdentical = allIdentical && identical;
    anyActivated = anyActivated || gate2.status().active;
    totalChecks += gate2.status().drift.checks;
    if (seed === 31) {
      ok(outEce <= inEce + 1e-15, `② 恒等无伤害（种子 31 细看）：输出 ECE ${outEce.toFixed(6)} ≤ 输入 ECE ${inEce.toFixed(6)}`);
    }
  }
  ok(
    !anyActivated && allIdentical,
    `② 完美校准流 ×5 种子：哨兵共 ${totalChecks} 次检查零误触发，输出全部逐位恒等（2000 点/种子）`,
  );
  ok(
    worstEceDelta <= 1e-15,
    `② 零漂移性质：多种子最差 ECE 增量 ${worstEceDelta.toExponential(2)} ≤ 0（完美预报不被改坏）`,
  );
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
