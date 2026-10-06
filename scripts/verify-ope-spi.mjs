/**
 * verify-ope-spi.mjs — 88.0 离线评估 + 89.0 安全策略改进「离线策略评估双件套」纯数学离线验证
 *
 * 每个锚点都有解析真值或定理对照（不是「能跑」，是「算得对」）：
 *   88.0 离线评估（OPE 四阶梯，真值由环境反向归纳解析算出）:
 *        ① 解析锚点：链 L=2/T=1 → J=0.7、悬崖 T=1/slip=0.25 → J=0.25（手算闭式）；
 *           MC 采样均值 → J(μ)（4·SE 自校准容差）；π≠μ 策略差距 ≥ 10%
 *        ② 误差阶梯：40 种子中位误差 DR(精确Q)=0 < WIS < OIS < 朴素
 *           （确定性链 + 精确 Q → DR 逐轨迹修正项恒为零——方差为零的解析特例）
 *        ③ 无偏性：60 数据集 OIS/PDIS 均值 → 真值（|bias| ≤ 4·SE）；
 *           朴素偏差 = J(μ) − J(π)（偏差公式对照）
 *        ④ 方差阶梯：同一数据集 Var(PDIS) ≈ 0.16×Var(OIS)；WIS ∈ [minG, maxG]
 *        ⑤ EB 覆盖率：200 种子 90% 名义覆盖 = 1.00 ∈ [0.88, 1.00]（保守侧），
 *           半径 n=400 < 0.5×半径 n=100
 *        ⑥ π=μ 退化：权重恒 1，OIS=WIS=PDIS=DR(无Q)=朴素逐位一致；
 *           DR(精确Q) = J(π)（1e-9）
 *        ⑦ 悬崖世界（随机转移）：DR(精确Q) 中位误差 < 0.8×朴素中位误差
 *   89.0 安全策略改进（HCPI 证书门控）:
 *        ① 真改进（Δ=+0.41）：DR 注入 100 种子接受率 ≥ 0.95（n=120）；
 *           无模型 PDIS 同样本量拿不到证书（权重重尾 → σ̂ 大）——Q 模型的价值
 *        ② 真退步（Δ=−0.49）：500 种子 PDIS 违反率 0 ≤ δ+容差、拒绝率 ≥ 1−δ；
 *           DR 注入 100 种子违反 0
 *        ③ 边缘候选（Δ=+0.08）：同一生长数据集 LCB 随 n 单调收紧
 *           （−0.207 → 0.032），接受率 0 → 1 翻转；DR 对照即刻证书
 *        ④ 浓度曲线：√(log/n) 主导项双对数斜率 = −0.50；总半宽斜率 ∈ (−1, −1/2)
 *           （含 1/n 修正）；闭式良好条件斜率 −0.52；半宽 ≥ 3.5× 收缩
 *        ⑤ δ ↓ ⟹ 半径 ↑ ⟹ 接受数单调不增 [18,3,0,0]（同数据数学保证）
 *        ⑥ 接线：88.0 pdisPerEpisode 注入 ≡ 内置缺省（逐位一致）；
 *           DR 注入半径 0 < PDIS 半径（同数据集）
 *
 * 全部断言确定性（随机性全部来自内核自带 mulberry32(seed)，同种子同轨迹）。
 * 运行：node --experimental-strip-types scripts/verify-ope-spi.mjs
 */

import {
  constantActionPolicy,
  uniformPolicy,
  tabularPolicy,
  importanceWeights,
  naiveMean,
  returnOf,
  ois,
  wis,
  pdis,
  drEstimate,
  oisPerEpisode,
  pdisPerEpisode,
  drPerEpisode,
  empiricalBernsteinCI,
  errorMetrics,
  makeChainMdp,
  makeCliffWorld,
} from '../src/core/off-policy-evaluation.ts';
import {
  safePolicyImprove,
  concentrationCurve,
  rejectionRate,
  ebRadius,
  pdisEpisodeValue,
} from '../src/core/safe-policy-improvement.ts';

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
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const logLogSlope = (ns, vals) => {
  const xs = ns.map((n) => Math.log(n));
  const ys = vals.map((v) => Math.log(v));
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  xs.forEach((x, i) => {
    num += (x - mx) * (ys[i] - my);
    den += (x - mx) * (x - mx);
  });
  return num / den;
};

// 共享环境与策略
const chain = makeChainMdp({ length: 5, horizon: 10, gamma: 1, goalReward: 1 });
const chainSmall = makeChainMdp({ length: 5, horizon: 10, gamma: 1, goalReward: 0.1 });
const cliff = makeCliffWorld();
const adv = (p) => constantActionPolicy(2, 1, p);
const pi85 = adv(0.85);
const mu50 = adv(0.5);
const Jpi = chain.exactValue(pi85);
const Jmu = chain.exactValue(mu50);

// ═══════════════════ 88.0 离线评估内核 ═══════════════════

section('88.0 真值工厂：解析锚点与 MC 对照');

{
  // 链 L=2/T=1：J = p·1（手算闭式）
  const tiny = makeChainMdp({ length: 2, horizon: 1, goalReward: 1 });
  ok(near(tiny.exactValue(adv(0.7)), 0.7, 1e-12), `链 L=2/T=1: J(推进0.7) = ${tiny.exactValue(adv(0.7))}（闭式 0.7·1）`);
  // 悬崖 T=1/slip=0.25：J = 0.5·(0.75·(−2) + 0.25·8) = 0.25（手算闭式）
  const tinyCliff = makeCliffWorld({
    length: 3, cliffState: 1, goalState: 2, slip: 0.25, cliffPenalty: -2, goalReward: 8, horizon: 1,
  });
  ok(near(tinyCliff.exactValue(adv(0.5)), 0.25, 1e-12), `悬崖 T=1/slip=0.25: J(推进0.5) = ${tinyCliff.exactValue(adv(0.5))}（闭式 0.5·(0.75·(−2)+0.25·8) = 0.25）`);
  // 主环境：策略差距 ≥ 10%
  const gapRatio = Math.abs(Jpi - Jmu) / Math.abs(Jpi);
  ok(gapRatio >= 0.1, `链 L=5/T=10: J(π=0.85)=${Jpi.toFixed(4)} vs J(μ=0.5)=${Jmu.toFixed(4)}，策略差距 ${(gapRatio * 100).toFixed(1)}% ≥ 10%`);
  // MC 对照：采样均值 → J(μ)
  const eps = chain.sampleEpisodes(mu50, 5000, 1);
  const rets = eps.map((e) => returnOf(e));
  const mcDiff = Math.abs(mean(rets) - Jmu);
  ok(mcDiff <= (4 * sd(rets)) / Math.sqrt(rets.length), `MC 对照: 5000 轨迹回报均值 ${mean(rets).toFixed(4)} → J(μ)=${Jmu.toFixed(4)}（差 ${mcDiff.toFixed(4)} ≤ 4·SE）`);
  // 转移分布合法性
  let sumsOk = true;
  for (let s = 0; s < cliff.numStates; s += 1) {
    for (let a = 0; a < cliff.numActions; a += 1) {
      const sum = cliff.transitions(s, a).reduce((acc, tr) => acc + tr.prob, 0);
      if (Math.abs(sum - 1) > 1e-12) sumsOk = false;
    }
  }
  ok(sumsOk, '悬崖世界全部 (s,a) 转移概率和 = 1（解析转移表自检）');
}

section('88.0 锚点①：误差阶梯 DR(精确Q) < WIS < OIS < 朴素（40 种子中位误差）');

{
  const qPi = chain.exactQModel(pi85);
  const errs = { dr: [], wis: [], ois: [], naive: [], pdis: [] };
  for (let s = 0; s < 40; s += 1) {
    const eps = chain.sampleEpisodes(mu50, 60, 1000 + s);
    errs.dr.push(drEstimate(eps, pi85, mu50, qPi) - Jpi);
    errs.wis.push(wis(eps, pi85, mu50) - Jpi);
    errs.ois.push(ois(eps, pi85, mu50) - Jpi);
    errs.naive.push(naiveMean(eps) - Jpi);
    errs.pdis.push(pdis(eps, pi85, mu50) - Jpi);
  }
  const med = (k) => median(errs[k].map(Math.abs));
  ok(
    med('dr') < med('wis') && med('wis') < med('ois') && med('ois') < med('naive'),
    `中位误差阶梯 DR=${med('dr').toFixed(6)} < WIS=${med('wis').toFixed(4)} < OIS=${med('ois').toFixed(4)} < 朴素=${med('naive').toFixed(4)}（PDIS=${med('pdis').toFixed(4)} 居中）`,
  );
  ok(med('dr') <= 1e-9, `DR(精确Q) 中位误差 = ${med('dr').toExponential(2)}（确定性链 + 精确 Q → 逐轨迹 IS 修正项恒为零，方差为零的解析特例）`);
  ok(
    errorMetrics(errs.naive, Jpi).medianAbsError > 0.9 * Math.abs(Jmu - Jpi),
    `朴素中位误差 ${med('naive').toFixed(4)} ≈ 偏差 |J(μ)−J(π)| = ${Math.abs(Jmu - Jpi).toFixed(4)}（把 μ 的回报当 π 的价值）`,
  );
}

section('88.0 锚点②：OIS/PDIS 无偏性 + 朴素偏差公式（60 数据集 × n=400）');

{
  const oisDs = [];
  const pdisDs = [];
  const naiveDs = [];
  for (let s = 0; s < 60; s += 1) {
    const eps = chain.sampleEpisodes(mu50, 400, 2000 + s);
    oisDs.push(ois(eps, pi85, mu50));
    pdisDs.push(pdis(eps, pi85, mu50));
    naiveDs.push(naiveMean(eps));
  }
  const se = (xs) => sd(xs) / Math.sqrt(xs.length);
  const biasOis = mean(oisDs) - Jpi;
  const biasPdis = mean(pdisDs) - Jpi;
  const biasNaive = mean(naiveDs) - Jpi;
  ok(Math.abs(biasOis) <= 4 * se(oisDs), `OIS 无偏: bias = ${biasOis.toFixed(4)} ≤ 4·SE = ${(4 * se(oisDs)).toFixed(4)}（真值 ${Jpi.toFixed(4)}）`);
  ok(Math.abs(biasPdis) <= 4 * se(pdisDs), `PDIS 无偏: bias = ${biasPdis.toFixed(4)} ≤ 4·SE = ${(4 * se(pdisDs)).toFixed(4)}`);
  ok(Math.abs(biasOis) <= 0.15 * Math.abs(biasNaive), `|OIS 偏差| ${Math.abs(biasOis).toFixed(4)} ≪ |朴素偏差| ${Math.abs(biasNaive).toFixed(4)}（重估 vs 有偏）`);
  ok(
    Math.abs(biasNaive - (Jmu - Jpi)) <= 0.1,
    `朴素偏差公式: bias = ${biasNaive.toFixed(4)} = J(μ)−J(π) = ${(Jmu - Jpi).toFixed(4)}（容差 0.1 内）`,
  );
}

section('88.0 锚点③：逐决策 ≤ 普通 IS 的方差（同一数据集）+ WIS 有界性');

{
  const eps = chain.sampleEpisodes(mu50, 400, 7);
  const oisPer = eps.map((e) => oisPerEpisode(e, pi85, mu50));
  const pdisPer = eps.map((e) => pdisPerEpisode(e, pi85, mu50));
  const varOis = sd(oisPer) ** 2;
  const varPdis = sd(pdisPer) ** 2;
  ok(varPdis < varOis, `Var(PDIS)=${varPdis.toFixed(1)} < Var(OIS)=${varOis.toFixed(1)}（同数据集；std 比 ${(Math.sqrt(varOis) / Math.sqrt(varPdis)).toFixed(2)}×——奖励项只累积到当步的比值乘积）`);
  const rets = eps.map((e) => returnOf(e));
  const wisVal = wis(eps, pi85, mu50);
  ok(
    wisVal >= Math.min(...rets) - 1e-12 && wisVal <= Math.max(...rets) + 1e-12,
    `WIS = ${wisVal.toFixed(4)} ∈ [min G, max G] = [${Math.min(...rets).toFixed(2)}, ${Math.max(...rets).toFixed(2)}]（自归一化凸组合，估计永不越出观测范围）`,
  );
}

section('88.0 锚点④：经验伯恩斯坦 CI 覆盖率（200 种子，名义 90%）');

{
  const pi70 = adv(0.7);
  const J70 = chain.exactValue(pi70);
  let covered = 0;
  let radius100 = 0;
  for (let s = 0; s < 200; s += 1) {
    const eps = chain.sampleEpisodes(mu50, 100, 3000 + s);
    const samples = eps.map((e) => pdisPerEpisode(e, pi70, mu50));
    const ci = empiricalBernsteinCI(samples, 0.1);
    if (ci.lower <= J70 && J70 <= ci.upper) covered += 1;
    if (s === 0) radius100 = ci.radius;
  }
  const rate = covered / 200;
  ok(rate >= 0.88 && rate <= 1.001, `覆盖率 = ${rate.toFixed(3)} ∈ [0.88, 1.00]（名义 1−δ = 0.90；EB 在重尾 PDIS 样本上保守侧覆盖）`);
  const eps400 = chain.sampleEpisodes(mu50, 400, 3000);
  const radius400 = empiricalBernsteinCI(eps400.map((e) => pdisPerEpisode(e, pi70, mu50)), 0.1).radius;
  ok(
    radius400 < 0.5 * radius100,
    `半径随 n 收缩: n=100 → ${radius100.toFixed(3)}, n=400 → ${radius400.toFixed(3)}（< 50%；√(log/n) 律）`,
  );
}

section('88.0 锚点⑤：π=μ 退化自检（一切估计器 = 朴素均值）');

{
  const mu60 = adv(0.6);
  const eps = chain.sampleEpisodes(mu60, 200, 3);
  const J60 = chain.exactValue(mu60);
  const traces = importanceWeights(eps, mu60, mu60);
  const maxWeightDev = Math.max(...traces.map((tr) => Math.max(...tr.stepRatios.map((r) => Math.abs(r - 1)))));
  ok(maxWeightDev <= 1e-12, `π=μ 时全部重要性比 ρ = 1（最大偏离 ${maxWeightDev.toExponential(2)}）`);
  const nv = naiveMean(eps);
  ok(
    near(ois(eps, mu60, mu60), nv, 1e-12) && near(wis(eps, mu60, mu60), nv, 1e-12)
      && near(pdis(eps, mu60, mu60), nv, 1e-12) && near(drEstimate(eps, mu60, mu60), nv, 1e-12),
    `OIS = WIS = PDIS = DR(无Q) = 朴素均值 = ${nv.toFixed(6)}（逐位一致，1e-12）`,
  );
  ok(
    near(drEstimate(eps, mu60, mu60, chain.exactQModel(mu60)), J60, 1e-9),
    `DR(精确Q) = J(π) = ${J60.toFixed(6)}（1e-9；确定性环境 + 精确 Q → DR 逐轨迹恒等于真值，朴素均值仍带 MC 噪声 ${nv.toFixed(4)}）`,
  );
}

section('88.0 悬崖世界：随机转移下的 DR（精确Q）对朴素均值');

{
  const bold = adv(0.6);
  const cautious = adv(0.45);
  const truth = cliff.exactValue(bold);
  ok(
    cliff.exactValue(adv(0.8)) > cliff.exactValue(adv(0.45)),
    `悬崖真值方向: J(大胆0.8)=${cliff.exactValue(adv(0.8)).toFixed(4)} > J(谨慎0.45)=${cliff.exactValue(adv(0.45)).toFixed(4)}（越过悬崖口的正期望赌局）`,
  );
  const qBold = cliff.exactQModel(bold);
  const drErrs = [];
  const naiveErrs = [];
  for (let s = 0; s < 25; s += 1) {
    const eps = cliff.sampleEpisodes(cautious, 800, 300 + s);
    drErrs.push(drEstimate(eps, bold, cautious, qBold) - truth);
    naiveErrs.push(naiveMean(eps) - truth);
  }
  const medDr = median(drErrs.map(Math.abs));
  const medNaive = median(naiveErrs.map(Math.abs));
  ok(
    medDr < 0.8 * medNaive,
    `悬崖随机转移: DR 中位误差 ${medDr.toFixed(4)} < 0.8×朴素 ${medNaive.toFixed(4)}（25 种子 × n=800；真值 ${truth.toFixed(4)}）`,
  );
}

section('88.0 入参校验（显式 throw）');

{
  const eps = chain.sampleEpisodes(mu50, 10, 5);
  throws(() => importanceWeights(eps, pi85, adv(0)), 'μ 在实现动作上概率为 0 → 绝对连续性违反 throw');
  throws(() => importanceWeights([{ states: [0], actions: [1], rewards: [0] }], pi85, mu50), 'states/actions 长度不一致 → throw');
  throws(() => ois([], pi85, mu50), '空 episodes → throw');
  throws(() => tabularPolicy([[0.5, 0.6]]), 'tabularPolicy 行概率和 ≠ 1 → throw');
  throws(() => empiricalBernsteinCI([1], 0.1), 'EB CI 样本 < 2 → throw');
  throws(() => empiricalBernsteinCI([1, 2], 1.5), 'EB CI δ ∉ (0,1) → throw');
  throws(() => makeCliffWorld({ length: 7, cliffState: 6 }), 'cliffState 越界（须 < goalState）→ throw');
  ok(uniformPolicy(3).prob(4, 2) === 1 / 3, 'uniformPolicy(3) 任一状态动作概率 = 1/3');
}

// ═══════════════════ 89.0 安全策略改进内核 ═══════════════════

// DR 注入适配器：按策略对象缓存精确 Q（模拟生产中 Q 由世界模型给出）
const qCache = new Map();
const drWithExactQ = (env) => (episode, target, behavior, gamma) => {
  let q = qCache.get(target);
  if (!q) {
    q = env.exactQModel(target);
    qCache.set(target, q);
  }
  return drPerEpisode(episode, target, behavior, q, gamma);
};
const drChain = drWithExactQ(chainSmall);

section('89.0 锚点①：真改进候选（Δ ≥ +0.2）样本充足时接受率 ≥ 0.95');

{
  const candidate = adv(0.85);
  const baseline = adv(0.5);
  const trueDelta = chainSmall.exactValue(candidate) - chainSmall.exactValue(baseline);
  ok(trueDelta >= 0.2, `真值改进量 Δ = ${trueDelta.toFixed(4)} ≥ 0.2（链 goal=0.1：J(0.85)−J(0.5)）`);
  const drTrial = rejectionRate(
    (seed) => chainSmall.sampleEpisodes(baseline, 120, 5000 + seed),
    { candidate, baseline, behavior: baseline },
    { seeds: 100, delta: 0.05, minSamples: 30, estimator: drChain },
  );
  ok(
    drTrial.acceptedRate >= 0.95,
    `DR 注入（n=120, δ=0.05）: 100 种子接受率 ${drTrial.acceptedRate.toFixed(2)} ≥ 0.95（证书不误伤好策略；确定性链 + 精确 Q → σ̂=0，证书即刻下发）`,
  );
  const pdisTrial = rejectionRate(
    (seed) => chainSmall.sampleEpisodes(baseline, 120, 15000 + seed),
    { candidate, baseline, behavior: baseline },
    { seeds: 100, delta: 0.05, minSamples: 30 },
  );
  ok(
    pdisTrial.acceptedRate <= 0.1,
    `无模型 PDIS 同样本量: 接受率 ${pdisTrial.acceptedRate.toFixed(2)}（ρ=1.7 连乘的重尾使 σ̂≈1.2 ≫ Δ̂——没有 Q 模型时 120 条轨迹拿不到证书，须靠数据量或 Q 模型）`,
  );
}

section('89.0 锚点②：真退步候选的违反率 ≤ δ + 统计容差（500 种子）');

{
  const candidate = adv(0.05);
  const baseline = adv(0.85);
  const trueDelta = chainSmall.exactValue(candidate) - chainSmall.exactValue(baseline);
  ok(trueDelta <= -0.2, `真值退步量 Δ = ${trueDelta.toFixed(4)} ≤ −0.2（J(0.05)−J(0.85)）`);
  const trial = rejectionRate(
    (seed) => chainSmall.sampleEpisodes(baseline, 120, 23000 + seed),
    { candidate, baseline, behavior: baseline },
    { seeds: 500, delta: 0.05, minSamples: 30 },
  );
  const violations = trial.acceptedFlags.filter(Boolean).length;
  ok(
    violations / 500 <= 0.05 + 0.03,
    `500 种子实证违反率 = ${(violations / 500).toFixed(4)} ≤ δ+容差 = 0.08（真实违反 ${violations} 次；LCB>0 而真 Δ<0 的事件被浓度不等式钉死）`,
  );
  ok(
    trial.rejectedRate >= 1 - 0.05,
    `拒绝率 = ${trial.rejectedRate.toFixed(4)} ≥ 1−δ = 0.95（真退步几乎必然被拦截；Δ̂ 均值 ${trial.meanDeltaHat.toFixed(4)} ≈ 真值）`,
  );
  const drTrial = rejectionRate(
    (seed) => chainSmall.sampleEpisodes(baseline, 120, 7000 + seed),
    { candidate, baseline, behavior: baseline },
    { seeds: 100, delta: 0.05, minSamples: 30, estimator: drChain },
  );
  ok(
    drTrial.acceptedRate === 0,
    `DR 注入对照: 100 种子违反 0（精确 Q → 零方差配对差，LCB ≡ Δ̂ = ${drTrial.meanDeltaHat.toFixed(4)} < 0）`,
  );
}

section('89.0 锚点③：边缘候选（Δ≈+0.08）LCB 随 n 单调收紧、拒绝→接受翻转');

{
  const candidate = adv(0.6);
  const baseline = adv(0.5);
  const trueDelta = chainSmall.exactValue(candidate) - chainSmall.exactValue(baseline);
  ok(trueDelta > 0 && trueDelta <= 0.12, `边缘候选真值 Δ = ${trueDelta.toFixed(4)} ∈ (0, 0.12]（0.1×(J(0.6)−J(0.5))）`);
  const sizes = [40, 80, 160, 320, 640];
  const seeds = 40;
  const meanLcb = new Array(sizes.length).fill(0);
  const accCounts = new Array(sizes.length).fill(0);
  const drAcc = new Array(sizes.length).fill(0);
  for (let s = 0; s < seeds; s += 1) {
    const eps = chainSmall.sampleEpisodes(baseline, 640, 9000 + s);
    sizes.forEach((n, k) => {
      const r = safePolicyImprove({ episodes: eps.slice(0, n), candidate, baseline, behavior: baseline, delta: 0.05, minSamples: 30 });
      meanLcb[k] += r.lcb / seeds;
      if (r.accepted) accCounts[k] += 1;
      const rd = safePolicyImprove({ episodes: eps.slice(0, n), candidate, baseline, behavior: baseline, delta: 0.05, minSamples: 30, estimator: drChain });
      if (rd.accepted) drAcc[k] += 1;
    });
  }
  let monotone = true;
  for (let k = 1; k < sizes.length; k += 1) {
    if (!(meanLcb[k] - meanLcb[k - 1] >= 0.01)) monotone = false;
  }
  ok(monotone, `平均 LCB 随 n 单调上升（步进 ≥ 0.01）: ${meanLcb.map((x) => x.toFixed(4)).join(' → ')}`);
  ok(
    accCounts[0] <= 2 && accCounts[sizes.length - 1] >= 36,
    `决策翻转: n=40 接受 ${accCounts[0]}/${seeds}（保守拒绝）→ n=640 接受 ${accCounts[sizes.length - 1]}/${seeds}（有证书的接受）`,
  );
  let ratesUp = true;
  for (let k = 1; k < sizes.length; k += 1) {
    if (accCounts[k] < accCounts[k - 1]) ratesUp = false;
  }
  ok(ratesUp, `接受数随 n 单调不增的反向——单调不降: ${accCounts.join(' → ')}（√n 收缩的直接后果，无需人工调阈值）`);
  ok(
    drAcc[0] === seeds,
    `DR(精确Q) 对照: n=40 即刻全票接受 ${drAcc[0]}/${seeds}（零方差 → LCB ≡ Δ̂ > 0；Q 模型质量决定证书早晚）`,
  );
}

section('89.0 锚点④：CI 半宽 ∝ n^(−1/2)（双对数斜率 ≈ −0.5）');

{
  // 配对差样本池：链 goal=0.1，候选 0.6 vs 基线 0.5（PDIS 逐轨迹差）
  const baseline = adv(0.5);
  const candidate = adv(0.6);
  const pool = chainSmall
    .sampleEpisodes(baseline, 4000, 123)
    .map((e) => pdisPerEpisode(e, candidate, baseline) - pdisPerEpisode(e, baseline, baseline));
  const sizes = [1600, 3200, 6400, 12800, 25600];
  const curve = concentrationCurve(pool, sizes, { delta: 0.05, repetitions: 40, seed: 5 });
  const halfWidths = curve.map((c) => c.halfWidth);
  let strictlyDown = true;
  for (let k = 1; k < halfWidths.length; k += 1) {
    if (!(halfWidths[k] < halfWidths[k - 1])) strictlyDown = false;
  }
  ok(strictlyDown, `半宽随 n 严格收缩: ${halfWidths.map((h) => h.toFixed(4)).join(' → ')}`);
  const sqrtSlope = logLogSlope(sizes, curve.map((c) => c.sqrtTerm));
  ok(
    sqrtSlope >= -0.55 && sqrtSlope <= -0.45,
    `√(log/n) 主导项双对数斜率 = ${sqrtSlope.toFixed(4)} ≈ −0.5（样本翻倍、半径 ×1/√2）`,
  );
  const totalSlope = logLogSlope(sizes, halfWidths);
  ok(
    totalSlope < -0.5 && totalSlope > -0.85,
    `总半宽斜率 = ${totalSlope.toFixed(4)} ∈ (−1, −1/2)（总半径 = A/√n + B/n，随 n → −0.5；1/n 修正项在中小 n 拖低斜率）`,
  );
  ok(
    halfWidths[0] / halfWidths[halfWidths.length - 1] >= 3.5,
    `n 增 16×（1600→25600）半宽收缩 ${(halfWidths[0] / halfWidths[halfWidths.length - 1]).toFixed(2)}× ≥ 3.5×（纯 √n 律下恰 4×）`,
  );
  const closedSizes = [10000, 20000, 40000, 80000, 160000];
  const closedSlope = logLogSlope(closedSizes, closedSizes.map((n) => ebRadius(0.5, 1, n, 0.05)));
  ok(
    closedSlope >= -0.55 && closedSlope <= -0.48,
    `闭式良好条件（σ=0.5, b−a=1）斜率 = ${closedSlope.toFixed(4)}（大 n 下 1/n 项消退，收敛到 −0.5）`,
  );
}

section('89.0 锚点⑤：δ 缩小 → 更保守（同数据集接受数单调不增）');

{
  const candidate = adv(0.6);
  const baseline = adv(0.5);
  const deltas = [0.3, 0.1, 0.03, 0.01];
  const counts = deltas.map(() => 0);
  for (let s = 0; s < 30; s += 1) {
    const eps = chainSmall.sampleEpisodes(baseline, 160, 9500 + s);
    deltas.forEach((d, k) => {
      const r = safePolicyImprove({ episodes: eps, candidate, baseline, behavior: baseline, delta: d, minSamples: 30 });
      if (r.accepted) counts[k] += 1;
    });
  }
  let monotone = true;
  for (let k = 1; k < counts.length; k += 1) {
    if (counts[k] > counts[k - 1]) monotone = false;
  }
  ok(
    monotone && counts[0] > counts[counts.length - 1],
    `同 30 数据集接受数随 δ 单调不增: δ=[0.3,0.1,0.03,0.01] → [${counts.join(', ')}]（radius ∝ ln(3/δ)，数学保证非经验）`,
  );
  let radiusUp = true;
  const radii = deltas.map((d) => ebRadius(0.3, 1, 160, d));
  for (let k = 1; k < radii.length; k += 1) {
    if (!(radii[k] > radii[k - 1])) radiusUp = false;
  }
  ok(radiusUp && radii[3] > 1.5 * radii[0], `闭式半径随 δ 缩小严格增大: ${radii.map((r) => r.toFixed(4)).join(' → ')}`);
}

section('89.0 接线：88.0 估计器注入（结构化类型，零 import 组合）');

{
  const candidate = adv(0.6);
  const baseline = adv(0.5);
  const eps = chainSmall.sampleEpisodes(baseline, 320, 42);
  const builtIn = safePolicyImprove({ episodes: eps, candidate, baseline, behavior: baseline, delta: 0.05, minSamples: 30 });
  const injected = safePolicyImprove({
    episodes: eps, candidate, baseline, behavior: baseline, delta: 0.05, minSamples: 30, estimator: pdisPerEpisode,
  });
  ok(
    near(builtIn.delta, injected.delta, 1e-12) && near(builtIn.lcb, injected.lcb, 1e-12) && builtIn.accepted === injected.accepted,
    `88.0 pdisPerEpisode 注入 ≡ 内置缺省 PDIS（Δ̂=${injected.delta.toFixed(6)}, LCB=${injected.lcb.toFixed(6)} 逐位一致）`,
  );
  const withDr = safePolicyImprove({
    episodes: eps, candidate, baseline, behavior: baseline, delta: 0.05, minSamples: 30, estimator: drChain,
  });
  ok(
    withDr.radius < builtIn.radius,
    `DR 注入半径 ${withDr.radius.toExponential(2)} < PDIS 半径 ${builtIn.radius.toFixed(4)}（同数据集；Q 模型只压方差、不改无偏性——证书更早下发）`,
  );
  const short = safePolicyImprove({ episodes: eps.slice(0, 10), candidate, baseline, behavior: baseline, delta: 0.05, minSamples: 30 });
  ok(
    !short.accepted && short.reason === 'insufficient-samples',
    `n=10 < minSamples=30 → reason=${short.reason}（样本不足时只报数不做决策，诚实拒绝）`,
  );
}

section('89.0 入参校验（显式 throw）');

{
  const baseline = adv(0.5);
  const eps = chainSmall.sampleEpisodes(baseline, 40, 11);
  const base = { episodes: eps, candidate: adv(0.85), baseline, behavior: baseline };
  throws(() => safePolicyImprove({ ...base, delta: 0 }), 'δ=0 → throw');
  throws(() => safePolicyImprove({ ...base, delta: 1 }), 'δ=1 → throw');
  throws(() => safePolicyImprove({ ...base, minSamples: 1 }), 'minSamples=1 → throw');
  throws(() => safePolicyImprove({ ...base, episodes: [] }), '空 episodes → throw');
  throws(() => rejectionRate(null, { candidate: adv(0.6), baseline, behavior: baseline }, { seeds: 5 }), 'makeEpisodes 非函数 → throw');
  throws(() => concentrationCurve([1, 2, 3], []), 'concentrationCurve 空 sizes → throw');
  throws(() => ebRadius(0.2, 1, 1, 0.05), 'ebRadius n=1 → throw');
  throws(() => pdisEpisodeValue({ states: [0], actions: [], rewards: [] }, adv(0.6), baseline, 1), '内置估计器空轨迹 → throw');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed === 0) {
  console.log('✅ 88.0 离线评估内核 + 89.0 安全策略改进内核：离线策略评估双件套数学验证成立');
} else {
  console.error('❌ 存在失败断言');
  process.exit(1);
}
