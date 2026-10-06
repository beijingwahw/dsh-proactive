/**
 * verify-mechanism-design.mjs — 62.0 机制设计内核纯数学离线验证
 *
 * 每个锚点都有解析解或定理对照（不是「能跑」，是「算得对」）：
 *   ① 单物品 2 人退化：VCG 支付 = 第二高价（精确，1e-12）；
 *      加性多物品 = 逐物品二价之和，与 Clarke 外部性公式 W*₋ᵢ−W₋ᵢ(a*)
 *      的独立重算逐 agent 对照（1e-9）
 *   ② DSIC 抽样：1500 组随机剖面 × 每个 agent 随机谎报，按真实估值算的
 *      效用无一超过诚实（VCG / Myerson 正则 / Myerson 铁化三路各测，
 *      谎报确实改变过分配 ≥ 100 次——探测有力，非空转）
 *   ③ 均匀 [0,1] iid：Myerson 保留价 = 0.5（插值精确）；收益
 *      max(r, v₂) ≥ v₂ 点态 ≥ 无保留价二价（4 种子逐种子对照）；
 *      Monte Carlo 期望收益对照理论 5/12（容差 0.01 ≈ 8σ，se≈0.0012），
 *      二价对照 1/3，收益差对照 1/12 ≈ 0.0833
 *   ④ 非单调虚拟值（双峰密度）→ PAVA 铁化输出单调 + 加权质量守恒
 *      Σwⱼφⱼ = Σwⱼφ̄ⱼ
 *   ⑤ 个体理性：支付 ≤ 真实估值恒成立（全样本零违例）
 *   ⑥ VCG 收入非负（500 随机剖面 Revenue ≥ −1e-9）
 *
 * 全部断言确定性（mulberry32 由内核自带导出，同实现保证可复现）。
 * 运行：node --experimental-strip-types scripts/verify-mechanism-design.mjs
 */

import {
  mulberry32,
  makeDistributionGrid,
  uniformUnitGrid,
  virtualValue,
  virtualValueCurve,
  ironVirtualValues,
  myersonReserve,
  myersonAuction,
  secondPrice,
  vcgAllocate,
} from '../src/core/mechanism-design.ts';

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
function near(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}
function section(title) {
  console.log(`\n■ ${title}`);
}

// ═══════════════════ ① VCG：外部性定价 = 逐物品二价 ═══════════════════

section('62.0 VCG：单物品退化 → 第二高价；加性组合 → 逐物品二价');

{
  // 单物品 2 人：VCG 支付 = 第二高价（Vickrey 1961 精确对照）
  const two = vcgAllocate({ bids: [[3], [5]], goods: 1 });
  ok(two.assignment[0] === 1, `bids [[3],[5]]：胜者 = agent ${two.assignment[0]}（高价者）`);
  ok(near(two.payments[1], 3, 1e-12), `VCG 支付 = ${two.payments[1]} = 第二高价 3（精确）`);
  ok(near(two.utilities[0], 0, 1e-12) && near(two.utilities[1], 2, 1e-12), `效用 = [${two.utilities}]（败者 0，胜者 5−3=2）`);

  // 单物品 3 人：仍退化为第二高价（排序 5>4>3 → 第二高价 4）
  const three = vcgAllocate({ bids: [[3], [5], [4]], goods: 1 });
  ok(three.assignment[0] === 1 && near(three.payments[1], 4, 1e-12), `3 人 [3,5,4]：胜者 agent 1 付 ${three.payments[1]} = 第二高价 4（人数退化不变性）`);

  // 加性多物品手工算例：
  //   good0: agent0 出 5 最高、第二高 4 → 付 4
  //   good1: agent2 出 6 最高、第二高 3 → 付 3
  const multi = vcgAllocate({
    bids: [
      [5, 2],
      [4, 3],
      [1, 6],
    ],
    goods: 2,
  });
  ok(
    multi.assignment[0] === 0 && multi.assignment[1] === 2 && near(multi.welfare, 11, 1e-12),
    `多物品 [[5,2],[4,3],[1,6]]：assignment=[${multi.assignment}]，welfare=${multi.welfare}（=5+6 可行最优）`,
  );
  ok(
    near(multi.payments[0], 4, 1e-12) && near(multi.payments[1], 0, 1e-12) && near(multi.payments[2], 3, 1e-12),
    `支付 = [${multi.payments}]（逐物品二价：good0 二价 4 归 agent0，good1 二价 3 归 agent2）`,
  );
  ok(near(multi.revenue, 7, 1e-12), `收入 = ${multi.revenue} ≥ 0（非预算平衡下界）`);

  // Clarke 外部性公式独立重算对照：pay_i = W*₋ᵢ − W₋ᵢ(a*)（50 组随机剖面）
  const rng = mulberry32(62);
  const externalityPayment = (bids, i, assignment) => {
    const agents = bids.length;
    let wMinus = 0;
    let othersActual = 0;
    for (let g = 0; g < bids[0].length; g += 1) {
      let m = 0;
      for (let j = 0; j < agents; j += 1) if (j !== i && bids[j][g] > m) m = bids[j][g];
      wMinus += m;
      if (assignment[g] !== i) othersActual += bids[assignment[g]][g];
    }
    return wMinus - othersActual;
  };
  let externMismatches = 0;
  for (let t = 0; t < 50; t += 1) {
    const bids = [
      [rng(), rng(), rng()],
      [rng(), rng(), rng()],
      [rng(), rng(), rng()],
      [rng(), rng(), rng()],
    ];
    const r = vcgAllocate({ bids, goods: 3 });
    for (let i = 0; i < 4; i += 1) {
      if (!near(externalityPayment(bids, i, r.assignment), r.payments[i], 1e-9)) externMismatches += 1;
    }
  }
  ok(externMismatches === 0, `Clarke 外部性公式 W*₋ᵢ−W₋ᵢ(a*) 独立重算 × 50 剖面 × 4 agent：失配 ${externMismatches} 处（1e-9）`);

  // ⑥ 收入非负 + ⑤ IR + 福利最优（500 剖面，随机重排对照）
  const rng2 = mulberry32(620);
  let revenueViolations = 0;
  let irViolations = 0;
  let welfareViolations = 0;
  for (let t = 0; t < 500; t += 1) {
    const bids = [
      [rng2(), rng2(), rng2()],
      [rng2(), rng2(), rng2()],
      [rng2(), rng2(), rng2()],
    ];
    const r = vcgAllocate({ bids, goods: 3 });
    if (r.revenue < -1e-9) revenueViolations += 1;
    for (const u of r.utilities) if (u < -1e-9) irViolations += 1;
    // 福利最优：30 组随机重排（每物品随机指派给任意 agent）不应超过 VCG 福利
    for (let s = 0; s < 30; s += 1) {
      let w = 0;
      for (let g = 0; g < 3; g += 1) w += bids[Math.floor(rng2() * 3)][g];
      if (w > r.welfare + 1e-9) welfareViolations += 1;
    }
  }
  ok(revenueViolations === 0, `VCG 收入 ≥ 0：500 随机剖面违例 ${revenueViolations}（Myerson–Satterthwaite 的下界侧）`);
  ok(irViolations === 0, `VCG 个体理性（utility ≥ 0 ⟺ 支付 ≤ 所赢真实估值）：500 剖面违例 ${irViolations}`);
  ok(welfareViolations === 0, `VCG 福利最优：500 剖面 × 30 随机重拍，无一超过 VCG 福利（违例 ${welfareViolations}）`);
}

// ═══════════════════ ② VCG DSIC 抽样 ═══════════════════

section('62.0 VCG DSIC：1500 剖面 × 随机谎报，真实效用无一超过诚实');

{
  const rng = mulberry32(1620);
  const AGENTS = 4;
  const GOODS = 3;
  let violations = 0;
  let changedAlloc = 0;
  let maxGain = 0; // 谎报相对诚实的最大「优势」（应为 ≤ 0）
  for (let t = 0; t < 1500; t += 1) {
    const values = [
      [rng(), rng(), rng()],
      [rng(), rng(), rng()],
      [rng(), rng(), rng()],
      [rng(), rng(), rng()],
    ];
    const honest = vcgAllocate({ bids: values, goods: GOODS });
    const liar = Math.floor(rng() * AGENTS);
    const lie = [rng(), rng(), rng()];
    const lieBids = values.map((row, i) => (i === liar ? lie : row));
    const lied = vcgAllocate({ bids: lieBids, goods: GOODS });
    // 按真实估值计算效用：赢得物品的真实价值之和 − 支付
    let trueWonLie = 0;
    for (const g of lied.allocatedGoods[liar]) trueWonLie += values[liar][g];
    const lieUtility = trueWonLie - lied.payments[liar];
    const honestUtility = honest.utilities[liar];
    if (lieUtility > honestUtility + 1e-9) violations += 1;
    maxGain = Math.max(maxGain, lieUtility - honestUtility);
    if (lied.assignment.some((w, g) => w !== honest.assignment[g])) changedAlloc += 1;
  }
  ok(violations === 0, `谎报违例 = ${violations}/1500（最大「优势」 ${maxGain.toExponential(2)} ≤ 1e-9：诚实占优 DSIC）`);
  ok(changedAlloc >= 100, `谎报改变分配 ${changedAlloc} 次 ≥ 100（探测确实有力，非空转）`);
}

// ═══════════════════ ④ 虚拟价值与铁化 ═══════════════════

section('62.0 虚拟价值 φ(v)=2v−1 与 PAVA 铁化');

{
  const uniform = uniformUnitGrid(100);
  ok(near(virtualValue(0.25, uniform), -0.5, 1e-9) && near(virtualValue(0.75, uniform), 0.5, 1e-9), `均匀 [0,1]：φ(0.25)=${virtualValue(0.25, uniform).toFixed(6)} = −0.5，φ(0.75)=${virtualValue(0.75, uniform).toFixed(6)} = +0.5（φ=2v−1）`);
  ok(near(virtualValue(0.5, uniform), 0, 1e-12), `φ(0.5) = ${virtualValue(0.5, uniform)}（信息租 (1−F)/f = 0.5/1，精确零点）`);
  const uniCurve = ironVirtualValues(uniform);
  ok(uniCurve.rawMonotone && uniCurve.pools.length === 0, `均匀分布为正则：raw 单调、无需铁化（pools=${uniCurve.pools.length}）`);

  // 非正则双峰密度：中部密度塌陷 → (1−F)/f 爆起 → φ 非单调（谷形）
  const xs = [];
  const pdf = [];
  for (let j = 0; j <= 50; j += 1) {
    const x = j / 50;
    xs.push(x);
    pdf.push(0.15 + 1.2 * Math.exp(-(((x - 0.25) / 0.08) ** 2)) + 1.2 * Math.exp(-(((x - 0.78) / 0.08) ** 2)));
  }
  // 梯形法累积并归一 → cdf
  const raw = [0];
  for (let j = 1; j <= 50; j += 1) raw.push(raw[j - 1] + ((pdf[j - 1] + pdf[j]) / 2) * (xs[j] - xs[j - 1]));
  const cdf = raw.map((v) => v / raw[50]);
  const bimodal = makeDistributionGrid(xs, cdf, pdf);

  const phi = virtualValueCurve(bimodal);
  let minDrop = 0;
  for (let j = 1; j < phi.length; j += 1) minDrop = Math.min(minDrop, phi[j] - phi[j - 1]);
  ok(minDrop < -1e-9, `双峰密度 → 原始 φ 非单调（最大逐点下落 ${minDrop.toFixed(3)} < 0，谷形虚拟价值）`);

  const ironed = ironVirtualValues(bimodal);
  let maxDip = 0;
  for (let j = 1; j < ironed.ironed.length; j += 1) maxDip = Math.max(maxDip, ironed.ironed[j - 1] - ironed.ironed[j]);
  ok(maxDip <= 1e-12, `铁化输出单调不减（最大下落 ${maxDip.toExponential(2)} ≤ 1e-12）`);
  ok(ironed.pools.length >= 1, `检出铁化池 ${ironed.pools.length} 个（首个 [${ironed.pools[0].lo.toFixed(2)}, ${ironed.pools[0].hi.toFixed(2)}] 池化为 ${ironed.pools[0].value.toFixed(3)}）`);
  // PAVA 合并守恒加权质量：Σw·φ = Σw·φ̄（∫φ dF 不变）
  let massPhi = 0;
  let massIroned = 0;
  for (let j = 0; j < phi.length; j += 1) {
    massPhi += ironed.weights[j] * phi[j];
    massIroned += ironed.weights[j] * ironed.ironed[j];
  }
  ok(near(massPhi, massIroned, 1e-9), `质量守恒 Σwφ = ${massPhi.toFixed(6)} = Σwφ̄ = ${massIroned.toFixed(6)}（铁化只重排不改均值）`);
}

// ═══════════════════ Myerson 均匀锚点 ═══════════════════

section('62.0 Myerson：均匀 [0,1] → 保留价 0.5 的二价拍卖');

{
  const uniform = uniformUnitGrid(100);
  const reserve = myersonReserve(uniform);
  ok(near(reserve, 0.5, 1e-9), `保留价 r = φ⁻¹(0) = ${reserve.toFixed(12)}（φ=2v−1 零点，插值精确）`);

  const a1 = myersonAuction([0.9, 0.6], uniform);
  ok(a1.winner === 0 && near(a1.payment, 0.6, 1e-9), `[0.9, 0.6]：agent 0 胜、付 ${a1.payment.toFixed(6)} = max(r, 二价 0.6)（正则情形 = 带保留价二价）`);
  const a2 = myersonAuction([0.8, 0.3], uniform);
  ok(a2.winner === 0 && near(a2.payment, 0.5, 1e-9), `[0.8, 0.3]：agent 0 胜、付 ${a2.payment.toFixed(6)} = 保留价兜底（φ(0.3)<0 → 阈 0）`);
  const a3 = myersonAuction([0.4, 0.45], uniform);
  ok(!a3.sold && a3.winner === -1 && a3.revenue === 0, `[0.4, 0.45]：最高虚拟价值 ${a3.virtuals[1].toFixed(2)} < 0 → 不成交（低于保留价不卖）`);
  const a4 = myersonAuction([0.7], uniform);
  ok(a4.winner === 0 && near(a4.payment, 0.5, 1e-9), `单人 [0.7]：付保留价 ${a4.payment.toFixed(6)}（垄断者标价 = r）`);
  const sp = secondPrice([0.9, 0.6]);
  ok(sp.winner === 0 && near(sp.payment, 0.6, 1e-12), `对照 secondPrice([0.9,0.6])：付 ${sp.payment}（无保留价口径，高估值区间与 Myerson 重合）`);
}

// ═══════════════════ ② Myerson DSIC 抽样（正则 + 铁化） ═══════════════════

section('62.0 Myerson DSIC：正则与铁化两路抽样，真实效用无一超过诚实');

{
  const uniform = uniformUnitGrid(100);
  const rng = mulberry32(2620);
  let violations = 0;
  let irViolations = 0;
  let maxGain = 0;
  for (let t = 0; t < 1500; t += 1) {
    const values = [rng(), rng(), rng()];
    const honest = myersonAuction(values, uniform);
    const liar = Math.floor(rng() * 3);
    const lie = rng();
    const liedValues = values.map((v, i) => (i === liar ? lie : v));
    const lied = myersonAuction(liedValues, uniform);
    const lieUtility = lied.winner === liar ? values[liar] - lied.payment : 0;
    const honestUtility = honest.winner === liar ? values[liar] - honest.payment : 0;
    if (lieUtility > honestUtility + 1e-9) violations += 1;
    maxGain = Math.max(maxGain, lieUtility - honestUtility);
    if (honest.sold && honest.payment > values[honest.winner] + 1e-9) irViolations += 1;
  }
  ok(violations === 0, `正则（均匀）3 人 × 1500 剖面：谎报违例 = ${violations}（最大优势 ${maxGain.toExponential(2)}）`);
  ok(irViolations === 0, `Myerson 个体理性（支付 ≤ 胜者真实估值）：违例 = ${irViolations}`);

  // 铁化路：从双峰分布逆 CDF 采样（铁化不破坏 DSIC——Myerson 定理）
  const xs = [];
  const pdf = [];
  for (let j = 0; j <= 50; j += 1) {
    const x = j / 50;
    xs.push(x);
    pdf.push(0.15 + 1.2 * Math.exp(-(((x - 0.25) / 0.08) ** 2)) + 1.2 * Math.exp(-(((x - 0.78) / 0.08) ** 2)));
  }
  const raw = [0];
  for (let j = 1; j <= 50; j += 1) raw.push(raw[j - 1] + ((pdf[j - 1] + pdf[j]) / 2) * (xs[j] - xs[j - 1]));
  const bimodal = makeDistributionGrid(xs, raw.map((v) => v / raw[50]), pdf);
  const sampleFromBimodal = (r) => {
    const u = r();
    for (let j = 1; j <= 50; j += 1) {
      if (u <= bimodal.cdf[j]) {
        const span = bimodal.cdf[j] - bimodal.cdf[j - 1];
        const t = span > 1e-15 ? (u - bimodal.cdf[j - 1]) / span : 0;
        return bimodal.xs[j - 1] + t * (bimodal.xs[j] - bimodal.xs[j - 1]);
      }
    }
    return bimodal.xs[50];
  };
  const rng2 = mulberry32(3620);
  let ironViolations = 0;
  let ironMaxGain = 0;
  let sales = 0;
  for (let t = 0; t < 1000; t += 1) {
    const values = [sampleFromBimodal(rng2), sampleFromBimodal(rng2), sampleFromBimodal(rng2)];
    const honest = myersonAuction(values, bimodal);
    if (honest.sold) sales += 1;
    const liar = Math.floor(rng2() * 3);
    const liedValues = values.map((v, i) => (i === liar ? sampleFromBimodal(rng2) : v));
    const lied = myersonAuction(liedValues, bimodal);
    const lieUtility = lied.winner === liar ? values[liar] - lied.payment : 0;
    const honestUtility = honest.winner === liar ? values[liar] - honest.payment : 0;
    if (lieUtility > honestUtility + 1e-9) ironViolations += 1;
    ironMaxGain = Math.max(ironMaxGain, lieUtility - honestUtility);
  }
  ok(ironViolations === 0, `铁化（双峰非正则）3 人 × 1000 剖面（成交 ${sales} 场）：谎报违例 = ${ironViolations}（最大优势 ${ironMaxGain.toExponential(2)}）`);
  ok(ironVirtualValues(bimodal).pools.length >= 1 && myersonAuction([0.9, 0.2], bimodal).ironed, `该路确在铁化分支上（pools=${ironVirtualValues(bimodal).pools.length}，auction.ironed=true）`);
}

// ═══════════════════ ③ 期望收益 Monte Carlo（多种子） ═══════════════════

section('62.0 期望收益：Myerson 5/12 vs 二价 1/3（n=2 均匀，多种子）');

{
  const uniform = uniformUnitGrid(100);
  const SEEDS = [1, 7, 42, 2027];
  const N = 20000;
  let pooledMyerson = 0;
  let pooledSecond = 0;
  const perSeed = [];
  for (const seed of SEEDS) {
    const rng = mulberry32(seed);
    let sumMyerson = 0;
    let sumSecond = 0;
    for (let t = 0; t < N; t += 1) {
      const v1 = rng();
      const v2 = rng();
      sumMyerson += myersonAuction([v1, v2], uniform).revenue;
      sumSecond += secondPrice([v1, v2]).revenue;
    }
    const meanMyerson = sumMyerson / N;
    const meanSecond = sumSecond / N;
    pooledMyerson += sumMyerson;
    pooledSecond += sumSecond;
    perSeed.push({ seed, meanMyerson, meanSecond });
  }
  ok(
    perSeed.every((s) => s.meanMyerson >= s.meanSecond - 1e-9),
    `逐种子 Myerson ≥ 无保留价二价（点态 max(r,v₂) ≥ v₂）：${perSeed.map((s) => `seed${s.seed} ${(s.meanMyerson - s.meanSecond).toFixed(4)}`).join(' / ')}（收益差 > 0）`,
  );
  const total = SEEDS.length * N;
  const meanMyerson = pooledMyerson / total;
  const meanSecond = pooledSecond / total;
  // 理论：E[max(1/2, V₍₂₍)] = 1/3 + r² − (4/3)r³ |_{r=1/2} = 5/12；容差 0.01 ≈ 8σ（se ≈ 0.0012）
  ok(
    near(meanMyerson, 5 / 12, 0.01),
    `Myerson 期望收益 = ${meanMyerson.toFixed(5)} vs 理论 5/12 = ${(5 / 12).toFixed(5)}（|Δ|=${Math.abs(meanMyerson - 5 / 12).toExponential(2)} ≤ 0.01 ≈ 8σ）`,
  );
  ok(near(meanSecond, 1 / 3, 0.01), `二价对照 = ${meanSecond.toFixed(5)} vs 理论 E[V₍₂₍] = ${(1 / 3).toFixed(5)}（|Δ|=${Math.abs(meanSecond - 1 / 3).toExponential(2)} ≤ 0.01）`);
  ok(
    meanMyerson - meanSecond >= 0.06 && meanMyerson - meanSecond <= 0.1,
    `收益差 = ${(meanMyerson - meanSecond).toFixed(5)} vs 理论 1/12 = ${(1 / 12).toFixed(5)}（保留价把信息租收归卖方）`,
  );
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed === 0) {
  console.log('✅ 62.0 机制设计内核：VCG 外部性定价 + Myerson 最优拍卖 数学验证成立');
} else {
  console.error('❌ 存在失败断言');
}
process.exitCode = failed > 0 ? 1 : 0;
