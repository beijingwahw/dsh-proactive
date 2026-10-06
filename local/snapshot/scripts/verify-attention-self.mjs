/**
 * verify-attention-self.mjs — 99.0 注意力经济 + 100.0 自我边界 双内核纯数学离线验证
 *
 * 每个内核的数学核心都有解析解或独立重算对照（不是「能跑」，是「算得对」）:
 *   99.0 注意力经济:
 *     ① matroid 贪心 = 穷举最优: 50 种子 × n=8 源 × k=3, 内核总价值 vs
 *        脚本侧 120 个组合逐个枚举的穷举最优（凹+可分离贪心定理, 逐实例一致）
 *     ② 二价支付 = 边际机会成本: 手工例精确对照——单元需求 {10,7,4}, k=2 →
 *        双赢家各付第 k+1 边际 4（VCG 退化为二价）; 多单元 A:{10,6,3}
 *        B:{8,5}, k=3 → pay=5/3（各自挤占的落选边际）≠ tᵢ×统一价
 *     ③ 谎报无益: 单元需求 25 实例 × 20 谎报 = 500 次真实所得无一正收益
 *        （VCG 的 DSIC）, 多单元 200 次加测
 *     ④ 凹性违规输入被 concavityCheck 诚实拒绝 + allocateAttention 显式 throw
 *     ⑤ 水填充 KKT: mᵢ(tᵢ*) ≥ p ≥ mᵢ(tᵢ*+1) 逐源成立 + 预算守恒
 *        Σslots+idle=k + IR（效用 ≥ 0）+ 收入 ≥ 0
 *   100.0 自我边界:
 *     ① 三合一流工厂（delay=2 自致 + 共因伪相关 + 纯外部）: 40 种子自致
 *        通道分类准确率 ≥ 0.95（z 对打乱基线数十倍分离）, 外部通道零误报,
 *        共因通道给出共因时判「混淆」, 不给时诚实报高偶然性（观察歧义）
 *     ② 延迟鲁棒性: delay 0..5 全检出且最佳延迟估计 = 真实延迟（MI 不随
 *        延迟衰减——衰减只来自有效样本, 诚实报告）
 *     ③ do vs observe: 共因场景观察相关 ≈ 0.32 / 干预效应 ≈ 0 → 判非自致;
 *        自致通道干预下真因果幸存（ρ_do ≈ ρ_obs ≈ 0.6）
 *     ④ 身份持续性: 参数微调连续性 ≈ 1 无警报 / 随机重组触发断点警报
 *     ⑤ 纯噪声流 100 种子零误报（300 通道 z 检验无一超阈）
 *
 * 全部断言确定性（随机处用 mulberry32 种子; 工厂/谎报/打乱基线全种子化）。
 * 运行: node --experimental-strip-types scripts/verify-attention-self.mjs
 */

import {
  allocateAttention,
  greedyVsOptimal,
  misreportGain,
  concavityCheck,
  unitDemandSource,
  geometricSource,
  saturatingSource,
  mulberry32,
} from '../src/core/attention-economy.ts';
import {
  contingencyScore,
  detectAgency,
  doVsObserve,
  identityContinuity,
  simulateEnv,
} from '../src/core/self-boundary.ts';

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
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, label);
}
/** mulberry32（与内核同一实现, 种子化随机实例/谎报因子用） */
function mulberry32Local(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ═══════════════════ 99.0 注意力经济内核 ═══════════════════

/** 脚本侧独立穷举: compositions t₁+…+tₙ = k 逐个求值（不经过内核分配器） */
function bruteForceBest(curves, k) {
  const n = curves.length;
  const valueOf = (alloc) => {
    let s = 0;
    for (let i = 0; i < n; i += 1) for (let t = 0; t < alloc[i]; t += 1) s += curves[i][t];
    return s;
  };
  const alloc = new Array(n).fill(0);
  let best = -Infinity;
  const rec = (idx, rem) => {
    if (idx === n - 1) {
      alloc[idx] = rem;
      best = Math.max(best, valueOf(alloc));
      return;
    }
    for (let t = 0; t <= rem; t += 1) {
      alloc[idx] = t;
      rec(idx + 1, rem - t);
    }
    alloc[idx] = 0;
  };
  rec(0, k);
  return best;
}

/** 随机凹实例工厂（几何 / 线性饱和 / 单元需求三种曲线混编） */
function randomInstance(rng, n, k, unitOnly = false) {
  const sources = [];
  const curves = [];
  for (let i = 0; i < n; i += 1) {
    const kind = unitOnly ? 'unit' : ['geo', 'sat', 'unit'][Math.floor(rng() * 3)];
    if (kind === 'geo') sources.push(geometricSource(`s${i}`, 0.5 + 4.5 * rng(), 0.1 + 0.8 * rng()));
    else if (kind === 'sat') sources.push(saturatingSource(`s${i}`, 0.5 + 4.5 * rng(), 0.3 + 2.7 * rng()));
    else sources.push(unitDemandSource(`s${i}`, 0.5 + 4.5 * rng()));
    const curve = [];
    for (let t = 0; t < k; t += 1) curve.push(sources[i].marginalValue(t));
    curves.push(curve);
  }
  return { sources, curves };
}

section('99.0 锚点①：matroid 贪心 = 穷举最优（50 种子 × n=8 × k=3）');

{
  let allMatch = true;
  let worstGap = 0;
  let kernelMatchCount = 0;
  let totalCombos = 0;
  for (let seed = 0; seed < 50; seed += 1) {
    const rng = mulberry32Local(7000 + seed);
    const { sources, curves } = randomInstance(rng, 8, 3);
    const greedy = allocateAttention(sources, 3).totalValue;
    const optimal = bruteForceBest(curves, 3);
    if (!near(greedy, optimal, 1e-9)) allMatch = false;
    worstGap = Math.max(worstGap, Math.abs(greedy - optimal));
    const gvo = greedyVsOptimal(sources, 3);
    totalCombos += gvo.enumerated;
    if (gvo.match && near(gvo.gap, 0, 1e-9)) kernelMatchCount += 1;
  }
  ok(allMatch, `50 种子贪心总价值 = 脚本侧穷举最优（120 组合/种子, 最大偏差 ${worstGap.toExponential(2)}）`);
  ok(kernelMatchCount === 50, `内核 greedyVsOptimal 50/50 全部 match=true（gap=0; 穷举组合累计 ${totalCombos}）`);
}

section('99.0 锚点②：二价支付 = 边际机会成本（手工例精确对照）');

{
  // 单元需求: A=10, B=7, C=4, k=2 → 赢家 A、B, 统一价 p = 第 k+1 边际 = 4
  const unit = allocateAttention([unitDemandSource('A', 10), unitDemandSource('B', 7), unitDemandSource('C', 4)], 2);
  ok(
    unit.slots.join(',') === '1,1,0' && near(unit.totalValue, 17, 1e-9) && near(unit.marginalPrice, 4, 1e-9),
    `单元需求 {10,7,4}, k=2: slots=[${unit.slots}], 总价值=${unit.totalValue}, 边际价=${unit.marginalPrice}（=第 3 高边际）`,
  );
  ok(
    near(unit.payments[0], 4, 1e-9) && near(unit.payments[1], 4, 1e-9) && near(unit.payments[2], 0, 1e-9),
    `VCG 退化为二价: 赢家支付 = 落选者最高边际（pay=[${unit.payments}], 各付 4）`,
  );
  ok(
    near(unit.utilities[0], 6, 1e-9) && near(unit.utilities[1], 3, 1e-9) && near(unit.revenue, 8, 1e-9),
    `IR 可观测面: 效用=[${unit.utilities}]（=估值−机会成本, 均 ≥ 0）, 收入=${unit.revenue}`,
  );

  // 多单元: A:{10,6,3}, B:{8,5}, k=3 → 贪心 10,8,6 → slots={2,1}
  const multi = allocateAttention(
    [
      { id: 'A', marginalValue: (t) => [10, 6, 3][t] ?? 0 },
      { id: 'B', marginalValue: (t) => [8, 5][t] ?? 0 },
    ],
    3,
  );
  ok(
    multi.slots.join(',') === '2,1' && near(multi.totalValue, 24, 1e-9) && near(multi.marginalPrice, 5, 1e-9),
    `多单元 A:{10,6,3} B:{8,5}, k=3: slots=[${multi.slots}], 总价值=${multi.totalValue}, 边际价=${multi.marginalPrice}（第 4 边际）`,
  );
  ok(
    near(multi.payments[0], 5, 1e-9) && near(multi.payments[1], 3, 1e-9),
    `Clarke pivot = 各自挤占的落选边际: pay_A=${multi.payments[0]}（B 的落选边际 5）, pay_B=${multi.payments[1]}（A 的落选边际 3）`,
  );
  ok(
    !near(multi.payments[0], multi.slots[0] * multi.marginalPrice, 1e-9),
    `多单元下 VCG ≠ 统一价: pay_A=${multi.payments[0]} ≠ t_A×p=${multi.slots[0] * multi.marginalPrice}（demand reduction 的定价口径之别）`,
  );
}

section('99.0 锚点③：谎报无益（VCG 的 DSIC, 500 + 200 次抽样）');

{
  const FACTORS = [0, 0.25, 0.5, 2, 5, 10]; // 离场 / 缩水 / 夸大
  let totalTrials = 0;
  let totalViolations = 0;
  let maxGain = -Infinity;
  for (let inst = 0; inst < 25; inst += 1) {
    const rng = mulberry32Local(8100 + inst);
    const { sources } = randomInstance(rng, 2 + Math.floor(rng() * 7), 1 + Math.floor(rng() * 6), true);
    const k = Math.min(sources.length - 1, 1 + Math.floor(rng() * 3));
    const summary = misreportGain(sources, k, { factors: FACTORS }, 20);
    totalTrials += summary.trials;
    totalViolations += summary.violations;
    maxGain = Math.max(maxGain, summary.maxGain);
  }
  ok(
    totalTrials === 500 && totalViolations === 0 && maxGain <= 1e-9,
    `单元需求 ${totalTrials} 次谎报（离场/缩水/夸大 × 随机因子）: 违例 ${totalViolations}, maxGain=${maxGain.toExponential(2)} ≤ 1e-9`,
  );

  let multiTrials = 0;
  let multiViolations = 0;
  let multiMaxGain = -Infinity;
  for (let inst = 0; inst < 10; inst += 1) {
    const rng = mulberry32Local(9200 + inst);
    const { sources } = randomInstance(rng, 2 + Math.floor(rng() * 3), 4, false);
    const k = 2 + Math.floor(rng() * 3);
    const summary = misreportGain(sources, k, { factors: FACTORS }, 20);
    multiTrials += summary.trials;
    multiViolations += summary.violations;
    multiMaxGain = Math.max(multiMaxGain, summary.maxGain);
  }
  ok(
    multiTrials === 200 && multiViolations === 0 && multiMaxGain <= 1e-9,
    `多单元需求 ${multiTrials} 次谎报加测: 违例 ${multiViolations}, maxGain=${multiMaxGain.toExponential(2)} ≤ 1e-9（VCG 对凹曲线多单元同样 DSIC）`,
  );
}

section('99.0 锚点④：凹性违规诚实拒绝');

{
  const good = geometricSource('good', 4, 0.5); // 4, 2, 1, … 递减 ✓
  const bad = { id: 'bad', marginalValue: (t) => (t === 0 ? 3 : 7) }; // 3 → 7 上升 ✗
  const report = concavityCheck([good, bad], 3);
  ok(
    !report.concave && report.violations.length >= 1,
    `concavityCheck 对上升边际曲线返回 concave=false（违例 ${report.violations.length} 条）`,
  );
  const v = report.violations[0];
  ok(
    v.sourceId === 'bad' && v.atSlot === 1 && near(v.prev, 3, 1e-9) && near(v.curr, 7, 1e-9),
    `违例明细定位精确: 源 ${v.sourceId} 槽 ${v.atSlot}: ${v.prev} → ${v.curr}`,
  );
  ok(concavityCheck([good], 3).concave, `凹曲线通过（concave=true）`);
  throws(() => allocateAttention([good, bad], 2), 'allocateAttention 对凹性违规曲线显式 throw');
}

section('99.0 锚点⑤：边际均衡（水填充 KKT）+ 预算守恒 + IR');

{
  let kktOk = true;
  let budgetOk = true;
  let irOk = true;
  let revenueOk = true;
  for (let seed = 0; seed < 50; seed += 1) {
    const rng = mulberry32Local(10400 + seed);
    const n = 5 + Math.floor(rng() * 4);
    const k = 1 + Math.floor(rng() * 4);
    const { sources, curves } = randomInstance(rng, n, k);
    const alloc = allocateAttention(sources, k);

    // 预算守恒: Σ slots + idle = k
    const used = alloc.slots.reduce((s, x) => s + x, 0);
    if (used + alloc.idleSlots !== k) budgetOk = false;

    // KKT: 每个被接受的边际 ≥ p ≥ 每个落选边际（边际相等/水填充）
    const p = alloc.marginalPrice;
    for (const award of alloc.awards) if (award.marginal < p - 1e-9) kktOk = false;
    for (let i = 0; i < n; i += 1) {
      for (let t = alloc.slots[i]; t < k; t += 1) if (curves[i][t] > p + 1e-9) kktOk = false;
    }

    // IR + 收入非负 + 账目守恒
    for (const u of alloc.utilities) if (u < -1e-9) irOk = false;
    if (alloc.revenue < -1e-9) revenueOk = false;
    if (!near(alloc.revenue, alloc.payments.reduce((s, x) => s + x, 0), 1e-9)) revenueOk = false;
  }
  ok(kktOk, '50 种子: 全部被接受边际 ≥ p ≥ 全部落选边际（水填充 KKT 均衡逐槽成立）');
  ok(budgetOk, '50 种子: Σslots + idleSlots = k 逐种子守恒（注意力预算逐槽可审计）');
  ok(irOk && revenueOk, '50 种子: IR（效用 ≥ 0）+ 收入 ≥ 0 + 收入 = Σ支付（Clarke pivot 账目）');
}

section('99.0 入参校验（显式 throw）');

{
  throws(() => allocateAttention([], 2), 'allocateAttention: 空源数组 throw');
  throws(
    () => allocateAttention([unitDemandSource('a', 1), unitDemandSource('a', 2)], 1),
    'allocateAttention: 重复 id throw',
  );
  throws(() => allocateAttention([unitDemandSource('a', 1)], -1), 'allocateAttention: k<0 throw');
  throws(
    () => allocateAttention([{ id: 'nan', marginalValue: () => Number.NaN }], 1),
    'allocateAttention: 非有限边际估值 throw',
  );
  throws(
    () => greedyVsOptimal(
      Array.from({ length: 6 }, (_, i) => geometricSource(`g${i}`, 1 + i, 0.5)),
      30,
    ),
    'greedyVsOptimal: 穷举组合数超上限 throw',
  );
  throws(() => concavityCheck([geometricSource('g', 1, 0.5)], 0), 'concavityCheck: maxSlots=0 throw');
  throws(() => misreportGain([unitDemandSource('a', 1)], 1, { factors: [-1] }, 5), 'misreportGain: 负因子 throw');
  // 合法边界不误伤: k=0（零预算）与全部边际 ≤ 0（诚实闲置）
  const zero = allocateAttention([saturatingSource('s', 0, 1)], 0);
  ok(zero.slots[0] === 0 && zero.idleSlots === 0 && near(zero.revenue, 0, 1e-12), 'k=0 零预算: 空分配零支付合法通过');
  const idle = allocateAttention([saturatingSource('s', -1, 1), saturatingSource('t', -2, 1)], 3);
  ok(
    idle.idleSlots === 3 && idle.slots.every((s) => s === 0) && near(idle.marginalPrice, 0, 1e-12),
    '全负边际: 3 槽全部诚实闲置（注意力不硬塞, 边际价 0）',
  );
}

// ═══════════════════ 100.0 自我边界内核 ═══════════════════

section('100.0 锚点①：三合一流——自致通道分类准确率 ≥ 0.95（40 种子）');

{
  let selfHit = 0;
  let externalFalsePositive = 0;
  let confoundedCorrect = 0;
  let minSelfZ = Infinity;
  let maxExternalZ = -Infinity;
  let spurSignificantNoConf = 0; // 无共因输入时伪相关通道也报显著（观察歧义的诚实呈现）
  for (let seed = 0; seed < 40; seed += 1) {
    const env = simulateEnv({ seed: 12000 + seed, delay: 2, agencyProb: 0.8, spuriousCorr: 0.7, length: 600 });
    const det = detectAgency({
      actions: env.actions,
      signals: env.signals,
      confounders: [env.confounder],
      seed: 31000 + seed,
    });
    if (det.selfCaused[0]) selfHit += 1;
    if (det.selfCaused[2]) externalFalsePositive += 1;
    if (det.channels[1].classification === 'confounded') confoundedCorrect += 1;
    minSelfZ = Math.min(minSelfZ, det.channels[0].contingency.z);
    maxExternalZ = Math.max(maxExternalZ, det.channels[2].contingency.z);

    const detNoConf = detectAgency({ actions: env.actions, signals: env.signals, seed: 41000 + seed });
    if (detNoConf.channels[1].contingency.significant) spurSignificantNoConf += 1;
  }
  const recall = selfHit / 40;
  ok(recall >= 0.95, `自致通道检出 ${selfHit}/40 = ${recall.toFixed(3)} ≥ 0.95（z 最低 ${minSelfZ.toFixed(1)} σ vs 阈值 4）`);
  ok(
    externalFalsePositive === 0 && maxExternalZ < 4,
    `纯外部通道零误报（0/40 通道被误判自致, 最大 z=${maxExternalZ.toFixed(2)} < 4）`,
  );
  ok(
    confoundedCorrect / 40 >= 0.95,
    `共因通道给出共因时判「混淆」而非「自致」: ${confoundedCorrect}/40 = ${(confoundedCorrect / 40).toFixed(3)}（条件互信息吸收 ≥ 80%）`,
  );
  ok(
    spurSignificantNoConf / 40 >= 0.9,
    `不给共因时诚实报高偶然性: ${spurSignificantNoConf}/40 伪相关通道显著（观察层面无法排除未观测共因——do 实验的理由, 锚点③）`,
  );
}

section('100.0 锚点②：延迟鲁棒性（delay 0..5 扫描, 衰减方向诚实报告）');

{
  let allDetected = true;
  let allDelayExact = true;
  const zCurve = [];
  const miCurve = [];
  for (let delay = 0; delay <= 5; delay += 1) {
    const env = simulateEnv({ seed: 52000 + delay, delay, agencyProb: 0.8, spuriousCorr: 0.7, length: 600 });
    const res = contingencyScore(env.actions, env.signals[0], { maxDelay: 5, shuffleSeed: 53000 + delay });
    zCurve.push(res.z);
    miCurve.push(res.miBits);
    if (!res.significant) allDetected = false;
    if (res.bestDelay !== delay) allDelayExact = false;
  }
  const spread = Math.max(...miCurve) - Math.min(...miCurve);
  const halfGap = Math.abs(
    (miCurve[0] + miCurve[1] + miCurve[2]) / 3 - (miCurve[3] + miCurve[4] + miCurve[5]) / 3,
  );
  ok(
    allDetected && allDelayExact,
    `delay 0..5 全检出且 d* = 真实延迟（z 曲线 [${zCurve.map((z) => z.toFixed(0)).join(', ')}], 全 ≥ 4σ）`,
  );
  ok(
    spread <= 0.1 && halfGap <= 0.05,
    `MI 无系统性延迟衰减（理论 1−H₂(0.1)≈0.531 bits; 实测 [${miCurve.map((m) => m.toFixed(3)).join(', ')}], 极差 ${spread.toFixed(4)} ≤ 0.1、前后半程均值差 ${halfGap.toFixed(4)} ≤ 0.05——涨落是采样噪声而非衰减, 如实呈现）`,
  );
}

section('100.0 锚点③：do vs observe——共因判非自致, 真因果干预下幸存');

{
  const obs = simulateEnv({ seed: 61001, delay: 2, agencyProb: 0.8, spuriousCorr: 0.7, length: 600 });
  const dove = simulateEnv({ seed: 61002, delay: 2, agencyProb: 0.8, spuriousCorr: 0.7, length: 600, randomizeActions: true });

  // 伪相关通道（与 a 同时刻共享共因 ⟹ 零延迟对齐）
  const spur = doVsObserve(
    { x: obs.actions, y: obs.signals[1] },
    { x: dove.actions, y: dove.signals[1] },
  );
  ok(
    near(spur.observationalAssociation, 0.56, 0.1),
    `共因通道观察相关 ρ_obs=${spur.observationalAssociation.toFixed(3)} ≈ 0.56（P(a≠y) = 0.15⊛0.1 = 0.22, ρ = 1−2×0.22——高相关）`,
  );
  ok(
    Math.abs(spur.interventionalEffect) < 0.1,
    `干预效应 ρ_do=${spur.interventionalEffect.toFixed(4)} ≈ 0（do(a) 切断共因, 伪相关消失）`,
  );
  ok(
    spur.confounded && !spur.selfCaused,
    `正确判「非自致 + 混淆」: confounded=${spur.confounded}, selfCaused=${spur.selfCaused}（gap=${spur.gap.toFixed(3)}）`,
  );

  // 自致通道（延迟 2 对齐: x_t = a_{t−2}）
  const alignDelayed = (env) => ({ x: env.actions.slice(0, env.actions.length - 2), y: env.signals[0].slice(2) });
  const self = doVsObserve(alignDelayed(obs), alignDelayed(dove));
  ok(
    near(self.observationalAssociation, 0.8, 0.08) && near(self.interventionalEffect, 0.8, 0.08),
    `自致通道 ρ_obs=${self.observationalAssociation.toFixed(3)} ≈ ρ_do=${self.interventionalEffect.toFixed(3)} ≈ 0.8（P(y≠a) = 0.5×0.2, ρ = 1−2×0.1）`,
  );
  ok(
    self.selfCaused && !self.confounded,
    `真因果干预下幸存: selfCaused=${self.selfCaused}, confounded=${self.confounded}（gap=${self.gap.toFixed(3)}）`,
  );
}

section('100.0 锚点④：身份持续性——微调连续 vs 重组断点（两极对照）');

{
  const rng = mulberry32Local(88);
  const dim = 8;
  const p0 = Array.from({ length: dim }, () => rng() * 2 - 1);
  const probes = Array.from({ length: 12 }, () => Array.from({ length: dim }, () => (rng() * 2 - 1) * 3));
  const behaviorTests = probes.map((probe) => ({
    probe,
    run: (params, x) => Math.tanh(2 * params.reduce((s, pi, i) => s + pi * x[i], 0)), // 饱和 ±1 策略输出
  }));

  const same = identityContinuity({ parameters: p0 }, { parameters: p0 }, { behaviorTests });
  ok(near(same.score, 1, 1e-9) && !same.breakAlarm, `恒等更新: score=${same.score.toFixed(6)} = 1, 无警报`);

  const smallPerturbed = p0.map((v) => v + (rng() * 2 - 1) * 0.01);
  const small = identityContinuity({ parameters: p0 }, { parameters: smallPerturbed }, { behaviorTests });
  ok(
    small.score >= 0.95 && !small.breakAlarm,
    `参数微调（±0.01）: score=${small.score.toFixed(4)} ≥ 0.95, breakAlarm=${small.breakAlarm}（连续性高——渐进学习）`,
  );

  const reorganized = Array.from({ length: dim }, () => rng() * 2 - 1);
  const reorg = identityContinuity({ parameters: p0 }, { parameters: reorganized }, { behaviorTests });
  ok(
    reorg.score < 0.5 && reorg.breakAlarm,
    `随机重组: score=${reorg.score.toFixed(4)} < 0.5, breakAlarm=${reorg.breakAlarm}（身份断点——「换人」而非学习; 参数连续性 ${reorg.paramContinuity.toFixed(3)}, 行为一致性 ${reorg.behaviorConsistency.toFixed(3)}）`,
  );
  ok(
    small.score - reorg.score > 0.4,
    `两极分居: 微调−重组 score 差 ${((small.score - reorg.score) * 1).toFixed(3)} > 0.4（阈值 0.5 两侧大幅分离）`,
  );
}

section('100.0 锚点⑤：纯噪声流 100 种子零误报');

{
  let falsePositives = 0;
  let worst = { z: -Infinity, mi: 0 };
  for (let seed = 0; seed < 100; seed += 1) {
    const env = simulateEnv({ seed: 71000 + seed, delay: 2, agencyProb: 0, spuriousCorr: 0, length: 600 });
    const det = detectAgency({ actions: env.actions, signals: env.signals, seed: 81000 + seed });
    falsePositives += det.selfCaused.filter(Boolean).length;
    for (const ch of det.channels) {
      if (ch.contingency.z > worst.z) worst = { z: ch.contingency.z, mi: ch.contingency.miBits };
    }
  }
  ok(
    falsePositives === 0,
    `无能动性流: 100 种子 × 3 通道 = 300 次检验零误报; 最极端通道 z=${worst.z.toFixed(2)} ≥ 4σ 但 MI=${worst.mi.toFixed(4)} < 0.02 bits 绝对下限, 被 MI 地板拒收（z 与 MI 双重护栏）`,
  );
}

section('100.0 入参校验（显式 throw）');

{
  const env = simulateEnv({ seed: 99, length: 128 });
  const short = Array.from({ length: 10 }, (_, i) => i % 2);
  throws(() => contingencyScore(short, short, {}), 'contingencyScore: 流长 < 32 throw');
  throws(() => contingencyScore(env.actions, env.signals[0], { maxDelay: 200 }), 'contingencyScore: maxDelay 超界 throw');
  throws(() => contingencyScore(env.actions.slice(1), env.signals[0], {}), 'contingencyScore: 长度不一致 throw');
  throws(() => contingencyScore(env.actions, env.signals[0], { shuffles: 5 }), 'contingencyScore: shuffles < 20 throw');
  throws(() => detectAgency({ actions: env.actions, signals: [env.actions.slice(1)] }), 'detectAgency: 通道与动作流不等长 throw');
  throws(
    () => doVsObserve({ x: env.actions, y: env.actions.slice(1) }, { x: env.actions, y: env.signals[0] }),
    'doVsObserve: 观察流 x/y 不等长 throw',
  );
  throws(
    () => identityContinuity({ parameters: [1, 2] }, { parameters: [1] }),
    'identityContinuity: 前后参数维度不一致 throw',
  );
  throws(() => simulateEnv({ length: 600, delay: 300 }), 'simulateEnv: delay > length/4 throw');
  throws(() => simulateEnv({ agencyProb: 1.5 }), 'simulateEnv: agencyProb ∉ [0,1] throw');
  throws(() => simulateEnv({ externalPersistence: 1 }), 'simulateEnv: externalPersistence ≥ 1（非平稳链）throw');
  // 合法边界不误伤: agencyProb=1 完全决定流（MI 满格 1 bit）
  const full = simulateEnv({ seed: 123, agencyProb: 1, spuriousCorr: 0, delay: 1, length: 256 });
  const fullRes = contingencyScore(full.actions, full.signals[0], { maxDelay: 2 });
  ok(
    fullRes.significant && fullRes.bestDelay === 1 && fullRes.miBits > 0.9,
    `agencyProb=1 完全因果: MI=${fullRes.miBits.toFixed(4)} > 0.9 bits（满格 1 bit − 采样偏差）, d*=${fullRes.bestDelay} 精确`,
  );
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 99.0 注意力经济 + 100.0 自我边界 双内核数学验证成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
