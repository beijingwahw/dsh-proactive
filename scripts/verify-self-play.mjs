/**
 * verify-self-play.mjs — 92.0 自我对弈内核纯数学离线验证
 *
 * 每个锚点都有解析解或定理对照（不是「能跑」，是「算得对」）：
 *   ① RPS 虚拟博弈：FP 10⁴ 轮平均策略 → 均匀（偏差 < 0.02，实测
 *      0.005/0.008）、价值 → 0（seed 打破对称后实测 1.2e-5）；无 seed
 *      时动力学对称 + 反对称收益 → 价值轨迹恒 0（Robinson 退化捷径）
 *   ② Kuhn 单卡扑克：行为策略均衡族（α=1/3 与 α=1/6）矩阵化价值
 *      精确 = −1/18（文献值，Kuhn 1950）、exploitability ~ 1e-17；
 *      FP 10⁴ 轮价值收敛到文献值（容差 0.02 文档化，实测误差 ~1e-4）
 *   ③ exploitability 随 FP 迭代下降：最小二乘回归斜率 < 0（RPS 与
 *      Kuhn 双验证；末 10% 均值 < 首 10% 均值——总体趋势单调下降）
 *   ④ 联赛（PSRO-lite）：exploiter 在场时 main 的可剥削度随轮数下降
 *      （RPS 千轮斜率 < 0、终值 0.011；Kuhn 两千轮终值 0.004）；
 *      拆掉 exploiter（对手池冻结）后 main 退化为常数纯策略、轨迹
 *      平坦在解析值（RPS 1.0 / Kuhn 5/6）——下降率恰为零，严格更慢
 *   ⑤ BR 精确性（手算锚）：[[3,0],[1,2]] 平局取首下标 / 非平局 argmax；
 *      RPS BR 到 (0.5,0.3,0.2) = Paper；Nash 对可剥削度 = 0、
 *      (1/2,1/2)/(1/2,1/2) 对 = 0.5（对偶间隙双口径互验）
 *
 * 全部断言确定性（FP/联赛的随机性全部来自内核自带 mulberry32(seed)，
 * 同种子同轨迹；无 seed 时平局恒取首下标）。
 * 运行：node --experimental-strip-types scripts/verify-self-play.mjs
 */

import {
  matrixGame,
  rockPaperScissors,
  kuhnPokerMini,
  kuhnDealPayoff,
  transposeMatrix,
  expectedRowValues,
  valueOf,
  bestResponse,
  bestResponseColumn,
  exploitability,
  fictitiousPlay,
  leaguePlay,
} from '../src/core/self-play.ts';

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
    failed += 1;
    console.error(`  ✗ ${label}（未抛错）`);
  } catch {
    passed += 1;
    console.log(`  ✓ ${label}`);
  }
}
/** 最小二乘回归斜率（趋势方向的标准度量） */
function slope(ys) {
  const n = ys.length;
  const mx = (n - 1) / 2;
  let my = 0;
  for (const y of ys) my += y;
  my /= n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - mx) * (ys[i] - my);
    den += (i - mx) ** 2;
  }
  return num / den;
}
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const fmt = (xs) => `[${xs.map((v) => v.toFixed(4)).join(', ')}]`;

const rps = rockPaperScissors();
const kuhn = kuhnPokerMini();
/** 行为策略（6 位）→ 64 维混合（纯策略概率 = 行为概率之积） */
function behavioral(bet, call) {
  const s = new Array(64).fill(0);
  for (let i = 0; i < 64; i += 1) {
    let p = 1;
    for (let c = 0; c < 3; c += 1) {
      p *= ((i >> c) & 1) === 1 ? bet[c] : 1 - bet[c];
      p *= ((i >> (3 + c)) & 1) === 1 ? call[c] : 1 - call[c];
    }
    s[i] = p;
  }
  return s;
}

// ═══════════════════ 92.0 工厂与 BR 精确性（⑤ 手算锚） ═══════════════════

section('92.0 博弈工厂与精确最优响应（手算锚）');

{
  ok(
    rps.zeroSum && rps.knownValue === 0 && rps.payoffCol.every((row, i) => row.every((v, j) => near(v, -rps.payoffRow[i][j], 1e-12))),
    `RPS 工厂：zeroSum、knownValue=0、payoffCol ≡ −payoffRow`,
  );
  let skew = true;
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) if (!near(rps.payoffRow[i][j], -rps.payoffRow[j][i], 1e-12)) skew = false;
  ok(skew, 'RPS 收益矩阵反对称（Aᵀ = −A，零和对称博弈的签名）');
  ok(
    kuhn.rows === 64 && kuhn.cols === 64 && kuhn.zeroSum && near(kuhn.knownValue, -1 / 18, 1e-12),
    `Kuhn 工厂：64×64 零和矩阵，knownValue = −1/18 = ${(-1 / 18).toFixed(6)}（Kuhn 1950）`,
  );
  ok(kuhnDealPayoff(2, 0, 4, 0) === 1, 'Kuhn 树：K 下注 / J 弃牌 → +1（赢下对方 ante）');
  ok(kuhnDealPayoff(0, 1, 0, 0) === -1, 'Kuhn 树：J 过牌 / Q 过牌 → 摊牌 −1（J 输）');
  ok(kuhnDealPayoff(1, 0, 2, 8) === 2, 'Kuhn 树：Q 下注 / J 跟注 → 摊牌 +2（Q 赢，各再投 1）');
  ok(kuhnDealPayoff(0, 2, 1, 0) === 1, 'Kuhn 树：J 下注诈唬 / K 弃牌 → +1（诈唬成功）');

  const M = [
    [3, 0],
    [1, 2],
  ];
  ok(bestResponse(M, [0.5, 0.5]) === 0, 'BR [[3,0],[1,2]] × (1/2,1/2)：行期望 (1.5,1.5) 平局 → 首下标 0');
  ok(bestResponse(M, [0.2, 0.8]) === 1, 'BR [[3,0],[1,2]] × (0.2,0.8)：行期望 (0.6,1.8) → 1');
  ok(bestResponse(M, [0.8, 0.2]) === 0, 'BR [[3,0],[1,2]] × (0.8,0.2)：行期望 (2.4,1.2) → 0');
  ok(
    near(expectedRowValues(M, [0.5, 0.5])[0], 1.5, 1e-12) && near(expectedRowValues(M, [0.5, 0.5])[1], 1.5, 1e-12)
      && near(expectedRowValues(M, [0.2, 0.8])[0], 0.6, 1e-12) && near(expectedRowValues(M, [0.2, 0.8])[1], 1.8, 1e-12),
    'expectedRowValues 精确线性：(1.5,1.5) 与 (0.6,1.8)（手算）',
  );
  ok(bestResponse(rps.payoffRow, [0.5, 0.3, 0.2]) === 1, 'RPS BR 到 (0.5,0.3,0.2)：u = (−0.1,+0.3,−0.2) → Paper（手算）');
  ok(bestResponseColumn(rps, [0.5, 0.3, 0.2]) === 1, 'RPS 列 BR 到 (0.5,0.3,0.2)：u₂ = (−0.1,+0.3,−0.2) → Paper（转置口径）');
  const rt = transposeMatrix(transposeMatrix(M));
  ok(rt.length === 2 && rt[0].length === 2 && rt.every((row, i) => row.every((v, j) => near(v, M[i][j], 1e-15))), 'transposeMatrix 双转置还原');
}

// ═══════════════════ 92.0 valueOf / exploitability 解析锚 ═══════════════════

section('92.0 价值与可剥削度（Nash 判据 / 对偶间隙双口径）');

{
  // [[3,0],[1,2]] 的混合 Nash：σ₁=(1/4,3/4)、σ₂=(1/2,1/2)、值 1.5（手解）
  const gm = matrixGame({ name: 'mixedSaddle', payoffRow: [[3, 0], [1, 2]], zeroSum: true });
  ok(near(valueOf(gm, [0.25, 0.75], [0.5, 0.5]).p1, 1.5, 1e-12), '混合博弈值：σ₁ᵀAσ₂ = 1.5（支撑内无差分手解）');
  const eqNash = exploitability(gm, [0.25, 0.75], [0.5, 0.5]);
  ok(eqNash.total < 1e-12 && eqNash.isNash, `Nash 对可剥削度 = ${eqNash.total.toExponential(2)} ≈ 0（= 0 ⟺ Nash 的判据面）`);
  const eqBad = exploitability(gm, [0.5, 0.5], [0.5, 0.5]);
  ok(
    near(eqBad.total, 0.5, 1e-12) && near(eqBad.p1Gain, 0, 1e-12) && near(eqBad.p2Gain, 0.5, 1e-12) && eqBad.p2BestResponse === 1,
    `非 Nash 对 (1/2,1/2)：total = 0.5 = p2Gain（列玩家改打纯列 1 净赚 0.5，p1Gain = 0——手算解析）`,
  );
  // 零和双口径：对称和 = 对偶间隙 max_a u₁(e_a,σ₂) − min_b u₁(σ₁,e_b) = 1.5 − 1.0
  const s1 = [0.5, 0.5];
  const upper = Math.max(...expectedRowValues(gm.payoffRow, s1)); // max_a u₁(e_a, σ₂)（σ₂ 同 (1/2,1/2)）
  const lower = Math.min(
    ...gm.payoffRow[0].map((_, j) => s1.reduce((acc, v, i) => acc + v * gm.payoffRow[i][j], 0)),
  ); // min_b u₁(σ₁, e_b)
  ok(
    near(upper, 1.5, 1e-12) && near(lower, 1, 1e-12) && near(eqBad.total, upper - lower, 1e-12),
    `零和口径互验：对称和 0.5 = 对偶间隙 max−min = ${upper.toFixed(1)} − ${lower.toFixed(1)}（两种独立算法同值）`,
  );
  const eqRpsNash = exploitability(rps, [1 / 3, 1 / 3, 1 / 3], [1 / 3, 1 / 3, 1 / 3]);
  ok(eqRpsNash.total < 1e-12 && eqRpsNash.isNash, `RPS 均匀对可剥削度 ≈ 0（均匀 = 唯一 Nash）`);
  const eqPure = exploitability(rps, [1, 0, 0], [0, 1, 0]);
  ok(
    near(eqPure.total, 2, 1e-12) && near(eqPure.p1Gain, 2, 1e-12) && near(eqPure.p2Gain, 0, 1e-12) && eqPure.p1BestResponse === 2,
    `RPS (Rock, Paper)：total = 2（p1 改打 Scissors 净赚 2；Paper 已是列最优）——最弱点对`,
  );
}

// ═══════════════════ 92.0 ① RPS 虚拟博弈 ═══════════════════

section('92.0 ① RPS 虚拟博弈：平均策略 → 均匀、价值 → 0（Robinson）');

{
  const fp = fictitiousPlay(rps, { iters: 10000, seed: 7 });
  const dev1 = Math.max(...fp.avgStrategies[0].map((v) => Math.abs(v - 1 / 3)));
  const dev2 = Math.max(...fp.avgStrategies[1].map((v) => Math.abs(v - 1 / 3)));
  ok(
    dev1 < 0.02 && dev2 < 0.02,
    `FP 10⁴ 轮平均 → 均匀：最大分量偏差 (${dev1.toFixed(4)}, ${dev2.toFixed(4)}) < 0.02（文档化容差）`,
  );
  ok(Math.abs(fp.finalValue) < 0.01, `平均策略对价值 → 0：|v| = ${Math.abs(fp.finalValue).toExponential(2)} < 0.01（seed 打破对称后的真实收敛）`);
  ok(fp.finalExploitability < 0.05, `终态可剥削度 = ${fp.finalExploitability.toFixed(4)} < 0.05（对偶间隙 → 0）`);
  ok(
    fp.valueTrace.length === 10001 && fp.exploitabilityTrace.length === 10001 && fp.purePlays[0].length === 10000 && fp.purePlays[1].length === 10000,
    `轨迹合同：value/exploitability 长 iters+1（[0] = 均匀起点）、purePlays 长 iters`,
  );

  const fp0 = fictitiousPlay(rps, { iters: 10000 });
  const maxAbsV = Math.max(...fp0.valueTrace.map(Math.abs));
  ok(
    maxAbsV < 1e-12,
    `无 seed：价值轨迹恒 0（实测 max|v| = ${maxAbsV.toExponential(2)}）——双方动力学对称 + Aᵀ = −A ⟹ xᵀAx ≡ 0（Robinson 的退化捷径）`,
  );
  ok(
    JSON.stringify(fp0.avgStrategies[0]) === JSON.stringify(fp0.avgStrategies[1]),
    '无 seed：双方平均策略逐位相同（对称博弈 + 同序平局规则锁死镜像轨迹）',
  );
  const again = fictitiousPlay(rps, { iters: 10000, seed: 7 });
  ok(JSON.stringify(again) === JSON.stringify(fp), '确定性：同 seed 两次 FP 全量轨迹逐位相同（mulberry32 复现）');
}

// ═══════════════════ 92.0 ② Kuhn 均衡族锚点 ═══════════════════

section('92.0 ② Kuhn 单卡扑克：均衡族价值精确 = −1/18');

{
  // 行为策略均衡族（α ∈ (0, 1/3]，与树位编码一一对应）：
  //   P1：bet(J,Q,K) = (α, 0, 3α)、call(J,Q,K) = (0, 1/3+α, 1)
  //   P2：bet(J,Q,K) = (1/3, 0, 1)、call(J,Q,K) = (0, 1/3, 1)
  const s2star = behavioral([1 / 3, 0, 1], [0, 1 / 3, 1]);
  for (const alpha of [1 / 3, 1 / 6]) {
    const s1star = behavioral([alpha, 0, 3 * alpha], [0, 1 / 3 + alpha, 1]);
    const v = valueOf(kuhn, s1star, s2star);
    const eq = exploitability(kuhn, s1star, s2star);
    ok(
      near(v.p1, -1 / 18, 1e-9),
      `均衡族 α=${alpha.toFixed(3)}：矩阵化价值 = ${v.p1.toFixed(12)} = −1/18 精确（1e-9）——树编码与文献值互为审计`,
    );
    ok(eq.total < 1e-12 && eq.isNash, `均衡族 α=${alpha.toFixed(3)}：可剥削度 ${eq.total.toExponential(2)} ≈ 0（互为最优响应）`);
  }
}

// ═══════════════════ 92.0 ② FP 收敛到文献值 ═══════════════════

section('92.0 ② Kuhn 虚拟博弈：价值收敛到文献值 −1/18');

{
  const t0 = Date.now();
  const fp = fictitiousPlay(kuhn, { iters: 10000 });
  const err = Math.abs(fp.finalValue - -1 / 18);
  ok(err <= 0.02, `FP 10⁴ 轮价值 = ${fp.finalValue.toFixed(6)}，与 −1/18 差 ${err.toExponential(2)} ≤ 0.02（文档化容差；实测 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  ok(fp.finalExploitability < 0.05, `终态可剥削度 = ${fp.finalExploitability.toFixed(4)} < 0.05（Robinson：对偶间隙 → 0）`);
}

// ═══════════════════ 92.0 ③ exploitability 下降趋势 ═══════════════════

section('92.0 ③ exploitability 随 FP 迭代下降（回归斜率 < 0）');

{
  for (const [game, iters, label] of [[rps, 10000, 'RPS'], [kuhn, 10000, 'Kuhn']]) {
    const fp = fictitiousPlay(game, { iters, seed: 11 });
    const s = slope(fp.exploitabilityTrace);
    const head = mean(fp.exploitabilityTrace.slice(0, Math.floor(iters / 10)));
    const tail = mean(fp.exploitabilityTrace.slice(-Math.floor(iters / 10)));
    ok(s < 0, `${label}：可剥削度轨迹回归斜率 = ${s.toExponential(3)} < 0（总体趋势下降）`);
    ok(tail < head, `${label}：末 10% 均值 ${tail.toFixed(4)} < 首 10% 均值 ${head.toFixed(4)}（趋势在端点也成立）`);
  }
}

// ═══════════════════ 92.0 ④ 联赛：exploiter 磨平弱点 vs 对照 ═══════════════════

section('92.0 ④ 联赛（PSRO-lite）：对抗压力磨平弱点 vs 无 exploiter 对照');

{
  const lg = leaguePlay(rps, { rounds: 1000, seed: 7 });
  const s = slope(lg.exploitabilityTrace);
  ok(s < 0, `RPS 联赛（exploiter 在场）：可剥削度斜率 = ${s.toExponential(3)} < 0（main 平均 → Nash，Robinson 经 FP 等价传递）`);
  ok(lg.finalExploitability < 0.05, `RPS 联赛千轮后可剥削度 = ${lg.finalExploitability.toFixed(4)} < 0.05（弱点被对抗压力磨平）`);
  ok(
    lg.leagueRoster.length === 1001 && lg.leagueRoster[0].role === 'seed' && lg.leagueRoster[0].pureIndex === -1 && lg.leagueRoster.slice(1).every((e) => e.role === 'exploiter' && e.pureIndex >= 0),
    `对手池合同：1 条 seed（均匀）+ 每轮 1 条 exploiter = 1001 条（失败模式档案可审计）`,
  );
  ok(
    near(lg.finalOpponentMixture.reduce((a, b) => a + b, 0), 1, 1e-9) && Math.max(...lg.finalOpponentMixture.map((v) => Math.abs(v - 1 / 3))) < 0.05,
    `末轮训练对手混合 ≈ 均匀（${fmt(lg.finalOpponentMixture)}）——exploiter 压力把 main 推回 Nash 的副产品`,
  );

  // 对照：拆掉 exploiter，对手池冻结在均匀种子
  const lgC = leaguePlay(rps, { rounds: 1000, exploiter: false });
  const flat = Math.max(...lgC.exploitabilityTrace.map((v) => Math.abs(v - 1)));
  const sC = slope(lgC.exploitabilityTrace);
  ok(
    flat < 1e-9,
    `RPS 对照（无 exploiter）：轨迹平坦在解析值 1.0（max 偏差 ${flat.toExponential(2)}）——对手分布冻结 → main 学不到任何鲁棒性`,
  );
  ok(
    lgC.mainPureSequence.every((a) => a === 0) && lgC.mainStrategy[0] === 1,
    `RPS 对照：main 的 BR 恒为 Rock（对均匀目标的贪心 argmax 平局取首下标，平均策略 = 常数纯策略）`,
  );
  ok(
    slope(lg.exploitabilityTrace) < sC && lgC.finalExploitability - lg.finalExploitability > 0.9,
    `对抗压力对照：exploiter 斜率 ${s.toExponential(3)} < 对照 ${sC.toExponential(3)}（下降率 0），终值差 ${lgC.finalExploitability.toFixed(3)} − ${lg.finalExploitability.toFixed(3)} > 0.9——exploiter 是弱点磨平的唯一驱动力`,
  );

  // Kuhn 双口径重复（带 seed 的对照同样冻结）
  const lgK = leaguePlay(kuhn, { rounds: 2000, seed: 7 });
  const lgKC = leaguePlay(kuhn, { rounds: 2000, seed: 7, exploiter: false });
  const flatK = Math.max(...lgKC.exploitabilityTrace.map((v) => Math.abs(v - 5 / 6)));
  ok(
    slope(lgK.exploitabilityTrace) < 0 && lgK.finalExploitability < 0.05,
    `Kuhn 联赛：斜率 ${slope(lgK.exploitabilityTrace).toExponential(3)} < 0、两千轮终值 ${lgK.finalExploitability.toFixed(4)} < 0.05`,
  );
  ok(
    flatK < 1e-9,
    `Kuhn 对照（无 exploiter）：轨迹平坦在解析值 5/6 = ${(5 / 6).toFixed(6)}（max 偏差 ${flatK.toExponential(2)}）——冻结对手池的零进化`,
  );
  const lgAgain = leaguePlay(rps, { rounds: 1000, seed: 7 });
  ok(JSON.stringify(lgAgain) === JSON.stringify(lg), '确定性：同 seed 两次联赛全量输出逐位相同');
}

// ═══════════════════ 92.0 入参合同（显式 throw） ═══════════════════

section('92.0 入参合同（非法输入显式抛错）');

{
  throws(() => matrixGame({ name: 'ragged', payoffRow: [[1, 2], [3]], zeroSum: true }), 'matrixGame 非矩形 payoffRow 抛错');
  throws(
    () => matrixGame({ name: 'badzs', payoffRow: [[1, 0]], payoffCol: [[1, 0]], zeroSum: true }),
    'matrixGame 声明零和但 payoffCol ≠ −payoffRow 抛错',
  );
  throws(() => matrixGame({ name: 'noCol', payoffRow: [[1, 0]] }), 'matrixGame 非零和且缺 payoffCol 抛错');
  throws(() => bestResponse([[1, 0], [0, 1]], [1]), 'bestResponse 对手策略长度不符抛错');
  throws(() => bestResponse([[1, 0], [0, 1]], [0.5, 0.6]), 'bestResponse 策略总质量 ≠ 1 抛错');
  throws(() => bestResponse([[1, 0], [0, Number.NaN]], [0.5, 0.5]), 'bestResponse 矩阵含非有限值抛错');
  throws(() => exploitability(rps, [1 / 3, 1 / 3, 1 / 3], [0.5, 0.5]), 'exploitability 双方策略长度不符抛错');
  throws(() => fictitiousPlay(rps, { iters: 0 }), 'fictitiousPlay iters = 0 抛错');
  throws(() => fictitiousPlay(rps, { iters: 10, seed: 1.5 }), 'fictitiousPlay 非整数 seed 抛错');
  throws(() => leaguePlay(rps, { rounds: 0 }), 'leaguePlay rounds = 0 抛错');
  throws(() => kuhnDealPayoff(1, 1, 0, 0), 'kuhnDealPayoff 同牌抛错（单副牌）');
  throws(() => kuhnDealPayoff(3, 1, 0, 0), 'kuhnDealPayoff 非法牌张抛错');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed === 0) {
  console.log('✅ 92.0 自我对弈内核：FP 收敛（Robinson）、Kuhn −1/18 精确、exploitability 货币与联赛对抗全部数学验证成立');
} else {
  console.error('❌ 92.0 自我对弈内核存在失败断言');
}
process.exitCode = failed > 0 ? 1 : 0;
