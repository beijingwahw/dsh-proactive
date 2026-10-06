/**
 * verify-preference-learning.mjs — 90.0 偏好学习内核（Bradley–Terry/Elo）纯数学离线验证
 *
 * 每个断言有解析解或独立重算对照（不是「能跑」，是「算得对」）:
 *   ① 已知效用 u*=[3,2,1,0.5] 采样 600 对: MLE 排序恢复 100%、
 *      中心化效用以 0.5 容差逼近（B-T 平移不变 → 对照取中心化口径，
 *      容差含抽样噪声，文档化）
 *   ①′ 两物品解析锚: 6 对胜 4 → û₀−û₁ = ln(4/2) = ln2（λ=1e-8）;
 *      GoF df=0 → underdetermined 诚实边界
 *   ② 留出 1/3 预测准确率 ≥ 0.85（信噪比口径 u=[6,4,2,0]、900 对——
 *      真实模型贝叶斯准确率即 0.934，阈值留裕量）
 *   ③ Elo 期望分手算锚: 400 分差 = 10/11（1e-12）; 同构恒等式
 *      E(β·Δu, 0) = σ(Δu); 更新零和守恒、±K/11 精确代入
 *   ④ 同一份 8000 对数据: Elo 在线（K/t^0.6）与 B-T 静态解排序一致、
 *      中心化分差 ≤30 分邻域（实测 11.6），且 2000→4000→8000 对偏差
 *      单调下降——随机逼近收敛的直接证据
 *   ⑤ 石头剪刀布 450 对: 环路检测报警（SCC={0,1,2}）; B-T 效用全塌缩、
 *      logLoss=ln2、X²=3×150、p<1e-20、三对全部系统性残差; 传递对照
 *      拟合优度良好——非传递性代价（ΔlogLoss + Δ准确率）诚实量化
 *      （RPS 留出准确率实测 0.32: 循环平票被训练侧微小不平衡定向，
 *      系统性低于瞎猜 0.5）
 *   ⑥ 数值件解析锚: χ² 上尾 (df=2/4 闭式)、Φ(1.959964)=0.975、
 *      B-T vs Thurstone 全带偏差 <0.045; 工厂同 seed 逐位复现;
 *      入参校验显式 throw
 *
 * 全部断言确定性（mulberry32 种子）。运行:
 *   node --experimental-strip-types scripts/verify-preference-learning.mjs
 */

import {
  mulberry32,
  logistic,
  stdNormalCdf,
  thurstoneProbability,
  ELO_SCALE,
  utilityToEloScale,
  eloScaleToUtility,
  expectedScore,
  predictPair,
  bradleyTerryMLE,
  btLogLoss,
  eloUpdate,
  eloSequence,
  transitivityCheck,
  btGoodnessOfFit,
  chiSquarePValue,
  simulatePreferences,
  heldOutAccuracy,
  rankByUtility,
} from '../src/core/preference-learning.ts';

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
    ok(false, `${label}（未抛出）`);
  } catch {
    ok(true, label);
  }
}
/** 中心化（B-T 平移不变口径的对照基准） */
function centered(v) {
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  return v.map((x) => x - mean);
}

// ═══════════════════ ① B-T MLE 恢复已知效用 ═══════════════════

section('锚点 ①: B-T MLE 从偏好对恢复已知效用（u*=[3,2,1,0.5]，600 对）');

const uStar = [3, 2, 1, 0.5];
const pairs600 = simulatePreferences(uStar, 600, 7);
ok(pairs600.length === 600 && pairs600.every((p) => p.winner !== p.loser), '工厂产出 600 对合法偏好对');
const fit600 = bradleyTerryMLE(pairs600);
ok(fit600.converged, `牛顿收敛（${fit600.iterations} 步，‖∇L‖∞=${fit600.gradientInfinityNorm.toExponential(1)}）`);
ok(fit600.logLoss < Math.LN2, `数据对数损失 ${fit600.logLoss.toFixed(4)} < ln2=${Math.LN2.toFixed(3)}（优于瞎猜基线）`);
ok(near(btLogLoss(pairs600, fit600.utilities), fit600.logLoss, 1e-12), 'btLogLoss 独立重算与拟合报告一致');
const order600 = rankByUtility(fit600.utilities)
  .map((r) => r.index)
  .join(',');
ok(order600 === '0,1,2,3', `排序恢复 100%: 0 ≻ 1 ≻ 2 ≻ 3（${fit600.utilities.map((x) => x.toFixed(3)).join(', ')}）`);
const deviation600 = Math.max(...centered(fit600.utilities).map((x, i) => Math.abs(x - centered(uStar)[i])));
ok(
  deviation600 <= 0.5,
  `中心化效用最大偏差 ${deviation600.toFixed(3)} ≤ 0.5（平移不变口径 + 抽样噪声容差，文档化）`,
);
ok(
  Math.abs(fit600.utilities[0] - fit600.utilities[1]) > 0.5 && Math.abs(fit600.utilities[2] - fit600.utilities[3]) > 0.1,
  '相邻效用间隔显著为正（最难分的 2 vs 3（真实差 0.5）也被正确排序）',
);

// ═══════════════════ ①′ 两物品解析解 ═══════════════════

section('锚点 ①′: 两物品解析 MLE（6 对胜 4 → Δu = ln2）');

const twoItem = [
  ...Array.from({ length: 4 }, () => ({ winner: 0, loser: 1 })),
  ...Array.from({ length: 2 }, () => ({ winner: 1, loser: 0 })),
];
const fit2 = bradleyTerryMLE(twoItem, { l2: 1e-8 });
const gap2 = fit2.utilities[0] - fit2.utilities[1];
ok(fit2.converged, `收敛（${fit2.iterations} 步牛顿）`);
ok(near(gap2, Math.LN2, 1e-5), `û₀−û₁ = ${gap2.toFixed(6)} = ln(4/2) = ln2（解析 MLE: σ(Δ)=4/6）`);
const gof2 = btGoodnessOfFit(twoItem, fit2.utilities);
ok(gof2.underdetermined && Number.isNaN(gof2.pValue), `df = K−(n−1) = 0 → underdetermined=true、pValue=NaN（自由度不足的诚实陈述）`);
ok(gof2.chiSquare < 1e-6, `拟合点残差 X²=${gof2.chiSquare.toExponential(1)} ≈ 0（MLE 恰好吸收观测频率）`);

// ═══════════════════ ② 留出预测准确率 ═══════════════════

section('锚点 ②: 留出对预测准确率（信噪比口径 u=[6,4,2,0]，900 对）');

const uHi = [6, 4, 2, 0];
const pairsHeld = simulatePreferences(uHi, 900, 21);
const held = heldOutAccuracy(pairsHeld, { testFraction: 1 / 3, seed: 99 });
ok(held.nTrain + held.nTest === 900 && held.nTest === 300, `确定性划分: 训练 ${held.nTrain} / 留出 ${held.nTest}`);
ok(
  held.accuracy >= 0.85,
  `留出准确率 ${held.accuracy.toFixed(3)} ≥ 0.85（真实模型贝叶斯准确率 = (3σ(2)+2σ(4)+σ(6))/6 = 0.934，阈值留裕量）`,
);
ok(held.testLogLoss < 0.45, `留出对数损失 ${held.testLogLoss.toFixed(3)} < 0.45（≪ ln2=0.693）`);
const heldAgain = heldOutAccuracy(pairsHeld, { testFraction: 1 / 3, seed: 99 });
ok(
  heldAgain.accuracy === held.accuracy && heldAgain.utilities.every((x, i) => x === held.utilities[i]),
  '同 seed 划分逐位复现（mulberry32 洗牌确定性）',
);

// ═══════════════════ ③ Elo 期望分与更新 ═══════════════════

section('锚点 ③: Elo 期望分公式手算锚（400 分差 = 10/11）');

ok(near(expectedScore(1600, 1200), 10 / 11, 1e-12), `E(1600,1200) = ${expectedScore(1600, 1200).toFixed(12)} = 10/11 = 0.909090…`);
ok(near(expectedScore(1000, 1000), 0.5, 1e-15), '同分对阵 → 0.5');
ok(near(expectedScore(1200, 1600) + expectedScore(1600, 1200), 1, 1e-12), '互补对称 E(a,b) + E(b,a) = 1');
ok(
  near(expectedScore(utilityToEloScale(1.2), 0), logistic(1.2), 1e-12),
  '同构恒等式 E(β·Δu, 0) = σ(Δu)——B-T 与 Elo 是同一模型（β=400/ln10）',
);
ok(
  near(eloScaleToUtility(ELO_SCALE * 1.5), 1.5, 1e-12) && near(utilityToEloScale(1), ELO_SCALE, 1e-12),
  `Elo↔效用换算互逆（β=${ELO_SCALE.toFixed(6)} = 400/ln10）`,
);
ok(
  near(predictPair([1.2, 0], 0, 1) + predictPair([1.2, 0], 1, 0), 1, 1e-12) && near(predictPair([1.2, 0], 0, 1), logistic(1.2), 1e-15),
  'predictPair = σ(u_i−u_j)，正反互补 = 1',
);
const updEven = eloUpdate({ ratings: [1000, 1000], k: 32 }, 0, 1);
ok(
  near(updEven.ratings[0], 1016, 1e-9) && near(updEven.ratings[1], 984, 1e-9),
  '均分对阵 K=32: 胜者 +16 / 败者 −16（E=0.5 手算）',
);
const updStrong = eloUpdate({ ratings: [1400, 1000], k: 32 }, 0, 1);
ok(
  near(updStrong.winnerDelta, 32 / 11, 1e-12) && near(updStrong.loserDelta, -32 / 11, 1e-12),
  `400 分差强队获胜: Δ = ±K·(1/11) = ±${(32 / 11).toFixed(6)}（E=10/11 手算精确代入）`,
);
ok(near(updStrong.ratings[0] + updStrong.ratings[1], 2400, 1e-9), '零和守恒: 更新前后 Σ ratings 不变');
const updUpset = eloUpdate({ ratings: [1400, 1000], k: 32 }, 1, 0);
ok(
  near(updUpset.winnerDelta, 32 * (10 / 11), 1e-9) && updUpset.winnerDelta > 29,
  `爆冷收益 Δ = 32·(1−1/11) = ${(32 * (10 / 11)).toFixed(3)} ≫ 强队赢的 2.91（期望分公式奖冷门）`,
);

// ═══════════════════ ④ Elo 在线收敛到 B-T 静态解邻域 ═══════════════════

section('锚点 ④: Elo 在线收敛到 B-T 静态解邻域（同一份 8000 对数据）');

const pairs8000 = simulatePreferences(uStar, 8000, 8);
const fit8000 = bradleyTerryMLE(pairs8000);
const btElo8000 = centered(fit8000.utilities).map((x) => x * ELO_SCALE);
const eloDeviation = (pairs) => {
  const run = eloSequence(pairs, { k: 64, kDecay: 0.6 });
  return Math.max(...centered(run.ratings).map((x, i) => Math.abs(x - btElo8000[i])));
};
const eloRun = eloSequence(pairs8000, { k: 64, kDecay: 0.6 });
ok(eloRun.steps === 8000 && eloRun.finalK < 0.5, `8000 步在线更新，末步 K=${eloRun.finalK.toFixed(3)}（K/t^0.6 随机逼近: ΣK=∞、ΣK²<∞）`);
const eloOrder = rankByUtility(eloRun.ratings)
  .map((r) => r.index)
  .join(',');
ok(
  eloOrder === '0,1,2,3' && eloOrder === rankByUtility(fit8000.utilities).map((r) => r.index).join(','),
  `Elo 终局排序 ${eloOrder} = B-T 静态排序 = 真实序（排序一致）`,
);
const dev2000 = eloDeviation(pairs8000.slice(0, 2000));
const dev4000 = eloDeviation(pairs8000.slice(0, 4000));
const dev8000 = eloDeviation(pairs8000);
ok(
  dev2000 > dev4000 && dev4000 > dev8000,
  `收敛趋势: 偏差 ${dev2000.toFixed(1)} → ${dev4000.toFixed(1)} → ${dev8000.toFixed(1)} 分单调下降（在线 SGD 与离线 MLE 同一总体最优）`,
);
ok(
  dev8000 <= 30,
  `中心化 Elo 与 B-T 换算解最大分差 ${dev8000.toFixed(1)} ≤ 30 分（≈0.17 效用单位的邻域口径）`,
);

// ═══════════════════ ⑤ 石头剪刀布: 非传递性体检 ═══════════════════

section('锚点 ⑤: 石头剪刀布——环路检测 + B-T 拟合失效信号（诚实量化非传递性代价）');

// 0=石头 1=剪刀 2=布: 石头砸剪刀(0≻1)、剪刀裁布(1≻2)、布包石头(2≻0)
const rps = [];
for (let t = 0; t < 150; t += 1) {
  rps.push({ winner: 0, loser: 1 }, { winner: 1, loser: 2 }, { winner: 2, loser: 0 });
}
const rpsReport = transitivityCheck(rps);
ok(!rpsReport.transitive, '多数偏好图含强连通分量 → 偏好剖面非传递（B-T 前提破坏）');
ok(
  rpsReport.cycles.length === 1 && [...rpsReport.cycles[0]].sort((a, b) => a - b).join(',') === '0,1,2',
  `环路组 {0,1,2}（石头→剪刀→布→石头闭环）`,
);
ok(rpsReport.cyclicItemFraction === 1 && rpsReport.edges.length === 3 && rpsReport.tiedPairs === 0, '全员卷入环路（3 条多数边、无平局）');
const pairsCtl = simulatePreferences(uHi, 450, 33);
const ctlReport = transitivityCheck(pairsCtl);
ok(ctlReport.transitive && ctlReport.cycles.length === 0, '传递对照（u=[6,4,2,0] 采样 450 对）: 无环路');

const fitRps = bradleyTerryMLE(rps);
const rpsSpread = Math.max(...fitRps.utilities) - Math.min(...fitRps.utilities);
ok(rpsSpread <= 1e-9, `B-T 效用全塌缩（spread=${rpsSpread.toExponential(1)}——循环胜负互相抵消，无传递强度可言）`);
ok(near(fitRps.logLoss, Math.LN2, 1e-9), `RPS 拟合 logLoss = ln2 = ${fitRps.logLoss.toFixed(9)}（模型只能 50% 瞎猜）`);

const gofRps = btGoodnessOfFit(rps, fitRps.utilities);
ok(near(gofRps.chiSquare, 450, 1e-6), `X² = ${gofRps.chiSquare.toFixed(2)} = 3×150（每对残差 z = √150 ≈ ±12.25）`);
ok(
  gofRps.degreesOfFreedom === 1 && gofRps.pValue < 1e-20,
  `df = 3−(3−1) = 1，p = ${gofRps.pValue.toExponential(2)} < 1e-20（拟合被数据 decisively 拒绝）`,
);
ok(
  gofRps.systematicCount === 3 && !gofRps.fitOk && gofRps.maxAbsZ > 12,
  `三对全部 |z|>2 系统性残差（max |z| = ${gofRps.maxAbsZ.toFixed(2)}，实测 100%/0% vs 预测 50%）`,
);

const fitCtl = bradleyTerryMLE(pairsCtl);
const gofCtl = btGoodnessOfFit(pairsCtl, fitCtl.utilities);
ok(
  gofCtl.fitOk && gofCtl.pValue >= 0.01 && gofCtl.maxAbsZ <= 3,
  `传递对照拟合优度良好（X²=${gofCtl.chiSquare.toFixed(2)}，df=${gofCtl.degreesOfFreedom}，p=${gofCtl.pValue.toFixed(3)}，max|z|=${gofCtl.maxAbsZ.toFixed(2)}）`,
);
ok(
  fitRps.logLoss - fitCtl.logLoss > 0.4,
  `非传递性代价（对数损失口径）: RPS ${fitRps.logLoss.toFixed(3)} − 传递 ${fitCtl.logLoss.toFixed(3)} = +${(fitRps.logLoss - fitCtl.logLoss).toFixed(3)} nat/对`,
);
const heldRps = heldOutAccuracy(rps, { seed: 5 });
ok(
  heldRps.accuracy <= 0.5,
  `RPS 留出准确率 ${heldRps.accuracy.toFixed(3)} ≤ 0.5（B-T 对循环偏好零信息; 实测低于瞎猜——训练侧微小不平衡把循环平票定向，三个关系只猜中一个 ≈ 1/3）`,
);
ok(
  Math.max(...heldRps.utilities) - Math.min(...heldRps.utilities) < 0.1,
  `RPS 训练侧拟合效用近塌缩（极差 ${(Math.max(...heldRps.utilities) - Math.min(...heldRps.utilities)).toFixed(4)} < 0.1，真实间隔 0.5）`,
);
const heldCtl = heldOutAccuracy(pairsCtl, { seed: 5 });
ok(heldCtl.accuracy >= 0.85, `传递对照留出准确率 ${heldCtl.accuracy.toFixed(3)} ≥ 0.85（对照 RPS 的 0.5）`);

// ═══════════════════ ⑥ 数值件解析锚 ═══════════════════

section('锚点 ⑥: χ² 上尾 / 正态 CDF / Thurstone 对照口径');

ok(near(chiSquarePValue(2, 2), Math.exp(-1), 1e-12), `chiSquarePValue(2,2) = e⁻¹ = ${Math.exp(-1).toFixed(9)}（df=2 闭式）`);
ok(near(chiSquarePValue(4, 2), Math.exp(-2), 1e-12), 'chiSquarePValue(4,2) = e⁻²（df=2 闭式）');
ok(
  near(chiSquarePValue(3, 4), Math.exp(-1.5) * (1 + 1.5), 1e-10),
  `chiSquarePValue(3,4) = e^{−3/2}(1+3/2) = ${(Math.exp(-1.5) * 2.5).toFixed(9)}（df=4 闭式）`,
);
ok(near(stdNormalCdf(1.959964), 0.975, 2e-7), 'Φ(1.959964) = 0.975（A&S 7.1.26 精度 1.5e-7）');
ok(near(thurstoneProbability([0, 0], 0, 1), 0.5, 1e-12), 'Thurstone 零效用差 → 0.5（与 B-T 零点重合）');
let maxCaliberDiff = 0;
let caliberAt = 0;
for (let d = -3; d <= 3.0001; d += 0.01) {
  const diff = Math.abs(logistic(d) - thurstoneProbability([d, 0], 0, 1));
  if (diff > maxCaliberDiff) {
    maxCaliberDiff = diff;
    caliberAt = d;
  }
}
ok(
  maxCaliberDiff < 0.045,
  `|σ(Δ) − Φ(Δ/√2)| 在 |Δ|≤3 全带最大 ${maxCaliberDiff.toFixed(4)}（@ Δ=${caliberAt.toFixed(2)}）< 0.045（两口径同向、零点重合、中带互换、尾部 Thurstone 更重）`,
);
ok(
  thurstoneProbability([1, 0], 0, 1) > 0.5 && thurstoneProbability([-1, 0], 0, 1) < 0.5,
  'Thurstone 概率随效用差单调（与 B-T 同向）',
);

// ═══════════════════ 工厂确定性与噪声 ═══════════════════

section('工厂确定性与感知噪声');

const s1 = simulatePreferences(uStar, 50, 123);
const s2 = simulatePreferences(uStar, 50, 123);
ok(JSON.stringify(s1) === JSON.stringify(s2), '同 seed 逐位复现（mulberry32）');
const s3 = simulatePreferences(uStar, 50, 123, { noiseSigma: 1.5 });
const s3b = simulatePreferences(uStar, 50, 123, { noiseSigma: 1.5 });
ok(JSON.stringify(s3) !== JSON.stringify(s1) && JSON.stringify(s3) === JSON.stringify(s3b), '感知噪声 σ=1.5 改变结果、带噪工厂同 seed 仍逐位复现');
const r1 = mulberry32(42);
const r2 = mulberry32(42);
ok(r1() === r2() && r1() === r2(), 'mulberry32(42) 同种子同序列');
const fitNoisy = bradleyTerryMLE(simulatePreferences(uStar, 600, 55, { noiseSigma: 2.5 }));
const noisySpread = Math.max(...fitNoisy.utilities) - Math.min(...fitNoisy.utilities);
const cleanSpread = Math.max(...fit600.utilities) - Math.min(...fit600.utilities);
ok(
  noisySpread < cleanSpread,
  `感知噪声 σ=2.5 → 效用极差收缩 ${noisySpread.toFixed(3)} < 干净 ${cleanSpread.toFixed(3)}（信号被噪声稀释，B-T 诚实降权）`,
);
ok(
  gofCtl.groups.every((g) => g.predictedRate > 0 && g.predictedRate < 1) && gofCtl.groups.length === 6,
  'GoF 逐对残差覆盖全部 6 个物品对（4 物品 = C(4,2)）',
);

// ═══════════════════ 入参校验 ═══════════════════

section('入参校验（显式 throw）');

throws(() => bradleyTerryMLE([]), 'bradleyTerryMLE: 空数据 throw');
throws(() => bradleyTerryMLE([{ winner: 0, loser: 0 }]), 'bradleyTerryMLE: winner === loser throw');
throws(() => bradleyTerryMLE([{ winner: 0.5, loser: 1 }]), 'bradleyTerryMLE: 非整数下标 throw');
throws(() => bradleyTerryMLE([{ winner: 0, loser: 1 }], { l2: -1 }), 'bradleyTerryMLE: 负 l2 throw');
throws(() => bradleyTerryMLE([{ winner: 0, loser: 1 }], { iters: 0 }), 'bradleyTerryMLE: iters=0 throw');
throws(() => bradleyTerryMLE([{ winner: 0, loser: 2 }], { nItems: 2 }), 'bradleyTerryMLE: nItems 小于数据推断 throw');
throws(() => bradleyTerryMLE([{ winner: 0, loser: 1 }], { l2: 0 }), 'bradleyTerryMLE: l2=0 平移不可辨识 → 牛顿方程奇异 throw');
throws(() => predictPair([0, 0], 0, 0), 'predictPair: i === j throw');
throws(() => predictPair([0, 0], 0, 5), 'predictPair: 下标越界 throw');
throws(() => predictPair([0, Number.NaN], 0, 1), 'predictPair: 效用含 NaN throw');
throws(() => expectedScore(Number.NaN, 100), 'expectedScore: NaN throw');
throws(() => eloUpdate({ ratings: [1000, 1000], k: 0 }, 0, 1), 'eloUpdate: k=0 throw');
throws(() => eloUpdate({ ratings: [1000, 1000], k: 32 }, 0, 0), 'eloUpdate: winner === loser throw');
throws(() => eloUpdate({ ratings: [1000, 1000], k: 32 }, 5, 1), 'eloUpdate: 下标越界 throw');
throws(() => eloUpdate({ ratings: [1000, Number.NaN], k: 32 }, 0, 1), 'eloUpdate: 评分 NaN throw');
throws(() => transitivityCheck([]), 'transitivityCheck: 空数据 throw');
throws(() => transitivityCheck([{ winner: -1, loser: 0 }]), 'transitivityCheck: 负下标 throw');
throws(() => btGoodnessOfFit([{ winner: 0, loser: 1 }], []), 'btGoodnessOfFit: 空效用 throw');
throws(() => btGoodnessOfFit([{ winner: 0, loser: 2 }], [0.1, 0.2]), 'btGoodnessOfFit: 效用长度不足 throw');
throws(() => btGoodnessOfFit([{ winner: 0, loser: 1 }], [0.1, 0.2], { alpha: 2 }), 'btGoodnessOfFit: alpha 越界 throw');
throws(() => chiSquarePValue(-1, 2), 'chiSquarePValue: 负统计量 throw');
throws(() => chiSquarePValue(1, 0), 'chiSquarePValue: df<1 throw');
throws(() => simulatePreferences([1], 10, 1), 'simulatePreferences: 物品数 <2 throw');
throws(() => simulatePreferences(uStar, -1, 1), 'simulatePreferences: 负对数 throw');
throws(() => simulatePreferences(uStar, 10, 1, { noiseSigma: -0.5 }), 'simulatePreferences: 负噪声 throw');
throws(() => heldOutAccuracy([{ winner: 0, loser: 1 }]), 'heldOutAccuracy: 单对无法划分 throw');
throws(() => heldOutAccuracy(pairsHeld, { testFraction: 1 }), 'heldOutAccuracy: testFraction=1 throw');
throws(() => rankByUtility([]), 'rankByUtility: 空数组 throw');

// ─────────────────────────── 汇总 ───────────────────────────
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 90.0 偏好学习内核（Bradley–Terry/Elo）数学验证成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
