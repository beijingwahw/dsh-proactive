/**
 * verify-speculative-decoding.mjs — 51.0「投机解码内核」纯数学离线验证
 *
 * 每个断言都有解析解/手算对照（不是「能跑」，是「算得对」）：
 *   ① N(0.5,4) = 31/16 = 1.9375 手算逐项对照；独立重算期望和式
 *      Σ(i+1)γ^i(1−γ)+γ^k(k+1) 与闭式 (1−γ^{k+1})/(1−γ) 全网格吻合；
 *   ② k* 关于 γ 单调不减（细网格扫描）；
 *   ③ costRatio→0 时 k* 增大（0.7: r↓ → k* = 2,4,7,9,13,16）、
 *      加速上界→k+1（S(1,32,1e-9) ≈ 33）；免费草稿也有 1/(1−γ) 封顶；
 *   ④ γ 低于 break-even 时 S<1；γ ≤ r 时一切 k 判退（闭式定理
 *      N ≤ 1+kγ ≤ 1+rk），k*=0 诚实返回；
 *   ⑤ S(γ=1) = (k+1)/(1+r·k) 闭式对照；
 *   ⑥ 确定性仿真（内核自带 mulberry32）大数定律对照闭式，
 *      「产出−1 = 接受数」结构恒等式逐轮精确；
 *   ⑦ k* 与暴力 argmax（k=0..64 逐点求 S 最大值）全网格一致——
 *      单峰扫描的精确性不是自称的；一阶边际条件在 k* 处符号翻转；
 *   ⑧ break-even: k=1 闭式 γ_be=r、k=2 求根公式 (−1+√(1+8r))/2、
 *      k=4 二分根处 S=1、随 k 单调递增；
 *   ⑨ speculativeEconomy 配对裁决与 optimalDraftLength 逐字段一致，
 *      亏损配对诚实判退；全部入参校验显式 throw。
 *
 * 全部断言确定性（仿真用文件内 mulberry32 固定种子）。
 * 运行：node --experimental-strip-types scripts/verify-speculative-decoding.mjs
 */

import {
  expectedTokensPerRound,
  roundCost,
  speedup,
  optimalDraftLength,
  breakEvenGamma,
  speculativeEconomy,
  simulateRounds,
} from '../src/core/speculative-decoding.ts';

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
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/** 独立重算：首原理和式 N = Σ_{i=0}^{k−1}(i+1)γ^i(1−γ) + γ^k(k+1)（不信任闭式） */
function sumFormula(g, k) {
  let s = 0;
  for (let i = 0; i < k; i += 1) s += (i + 1) * Math.pow(g, i) * (1 - g);
  s += Math.pow(g, k) * (k + 1);
  return s;
}

// ═══════════════════ ① 期望产出闭式 ═══════════════════

section('① N(k,γ) 闭式：γ=0.5,k=4 手算对照 + 独立和式全网格');

{
  const n54 = expectedTokensPerRound(0.5, 4);
  ok(
    near(n54, 31 / 16, 1e-12),
    `N(0.5,4) = ${n54} = 31/16 = 1.9375（手算: 1×.5 + 2×.25 + 3×.125 + 4×.0625 + 5×.0625）`,
  );
  let maxErr = 0;
  let worst = '';
  for (const g of [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 0.99]) {
    for (let k = 1; k <= 12; k += 1) {
      const err = Math.abs(expectedTokensPerRound(g, k) - sumFormula(g, k));
      if (err > maxErr) {
        maxErr = err;
        worst = `γ=${g},k=${k}`;
      }
    }
  }
  ok(maxErr <= 1e-12, `闭式与首原理和式全网格吻合（max |Δ| = ${maxErr.toExponential(2)}，最差 ${worst}）`);
  ok(near(expectedTokensPerRound(0.7, 4), 2.7731, 1e-12), `N(0.7,4) = ${expectedTokensPerRound(0.7, 4)}（手算 1+.7+.49+.343+.2401 = 2.7731）`);
  ok(near(expectedTokensPerRound(0.9, 2), 2.71, 1e-12), `N(0.9,2) = ${expectedTokensPerRound(0.9, 2)}（手算 1+.9+.81 = 2.71）`);
  ok(
    expectedTokensPerRound(1, 7) === 8 && expectedTokensPerRound(0, 7) === 1 && expectedTokensPerRound(0.42, 0) === 1,
    `边界: γ=1 → k+1（N(1,7)=${expectedTokensPerRound(1, 7)}）；γ=0 → 1；k=0 → 1`,
  );
  let bounded = true;
  let monotone = true;
  for (const g of [0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) {
    for (let k = 1; k <= 12; k += 1) {
      const n = expectedTokensPerRound(g, k);
      if (n > k + 1 + 1e-12 || n > 1 / (1 - g) + 1e-12) bounded = false;
      if (k >= 2 && n <= expectedTokensPerRound(g, k - 1) + 1e-15) monotone = false;
    }
  }
  ok(bounded, `N(k,γ) ≤ min(k+1, 1/(1−γ)) 全网格（产出永远不超草稿+1，也不超几何级数和）`);
  let gammaMono = true;
  for (let i = 1; i <= 48; i += 1) {
    const g = i * 0.02; // g+0.02 ≤ 1.0 恰好取到 γ=1 合法边界
    if (expectedTokensPerRound(g + 0.02, 5) <= expectedTokensPerRound(g, 5) + 1e-15) gammaMono = false;
  }
  ok(gammaMono, `N(k,γ) 关于 γ 严格递增（k=5 细网格）`);
}

// ═══════════════════ ⑥ 确定性仿真交叉 ═══════════════════

section('⑥ 确定性仿真（mulberry32）大数定律对照闭式');

{
  const sim = simulateRounds(0.5, 4, 200000, 2026);
  ok(
    near(sim.meanTokensPerRound, 1.9375, 0.01),
    `20 万轮实测均值 ${sim.meanTokensPerRound.toFixed(6)} ≈ 闭式 1.9375（|Δ|=${Math.abs(sim.meanTokensPerRound - 1.9375).toExponential(2)}）`,
  );
  // E[被接受草稿数] = Σ_{i=1}^{4} γ^i = 0.5+0.25+0.125+0.0625 = 0.9375
  ok(
    near(sim.meanAcceptedDraftTokens, 0.9375, 0.01),
    `实测平均接受草稿 ${sim.meanAcceptedDraftTokens.toFixed(6)} ≈ Σγ^i = 0.9375`,
  );
  ok(
    near(sim.meanTokensPerRound - 1, sim.meanAcceptedDraftTokens, 1e-12),
    `结构恒等式: 每轮产出 = 接受数 + 1（均值差 |Δ|=${Math.abs(sim.meanTokensPerRound - 1 - sim.meanAcceptedDraftTokens)}，逐轮精确）`,
  );
  const sim2 = simulateRounds(0.8, 6, 200000, 77);
  const closed = (1 - Math.pow(0.8, 7)) / 0.2; // = 3.951424
  ok(
    near(sim2.meanTokensPerRound, closed, 0.01),
    `γ=0.8,k=6: 实测 ${sim2.meanTokensPerRound.toFixed(6)} ≈ 闭式 (1−0.8^7)/0.2 = ${closed}`,
  );
  const rerun = simulateRounds(0.5, 4, 200000, 2026);
  ok(
    rerun.meanTokensPerRound === sim.meanTokensPerRound && rerun.meanAcceptedDraftTokens === sim.meanAcceptedDraftTokens,
    `同种子重放逐位一致（同输入同输出，无 Math.random/时钟）`,
  );
}

// ═══════════════════ ⑤ 加速比口径 ═══════════════════

section('⑤ 加速比口径：γ=1 闭式 (k+1)/(1+rk) + 上界与 r→0');

{
  const pairs = [[3, 0.1], [5, 0.05], [7, 0.25], [4, 0.4]];
  let allExact = true;
  for (const [k, r] of pairs) {
    if (!near(speedup(1, k, r), (k + 1) / (1 + r * k), 1e-12)) allExact = false;
  }
  ok(allExact, `S(γ=1,k,r) = (k+1)/(1+rk) 精确成立: ${pairs.map(([k, r]) => `S(1,${k},${r})=${speedup(1, k, r).toFixed(6)}`).join(', ')}`);
  let decomp = true;
  for (const [g, k, r] of [[0.5, 4, 0.1], [0.7, 9, 0.05], [0.95, 16, 0.3]]) {
    if (!near(speedup(g, k, r), expectedTokensPerRound(g, k) / roundCost(k, r), 1e-15)) decomp = false;
  }
  ok(decomp, `S ≡ N / t 分解恒等（roundCost 缺省 B=k+1: t = 1+rk）`);
  ok(roundCost(4, 0.1, 8) === 1.025, `roundCost(4,0.1,B=8) = 0.4 + 5/8 = ${roundCost(4, 0.1, 8)}（一般批加速口径）`);
  ok(near(speedup(1, 4, 0.1, 8), 5 / 1.025, 1e-12), `批加速 B=8: S(1,4,0.1,8) = ${speedup(1, 4, 0.1, 8).toFixed(9)} = 5/1.025`);
  let monoGamma = true;
  for (let i = 0; i <= 18; i += 1) {
    const g = i * 0.05; // g+0.05 ≤ 0.95，远离子边界
    if (speedup(g + 0.05, 4, 0.15) <= speedup(g, 4, 0.15) + 1e-15) monoGamma = false;
  }
  ok(monoGamma, `S(k,γ) 关于 γ 严格递增（k=4, r=0.15 细网格）——接受率只会帮忙`);
  let bounded = true;
  let strictBelow = true;
  for (const r of [0.05, 0.15, 0.4]) {
    for (let k = 1; k <= 10; k += 1) {
      for (const g of [0.2, 0.5, 0.8, 0.99]) {
        const s = speedup(g, k, r);
        if (s > (k + 1) / (1 + r * k) + 1e-12) bounded = false;
        if (g <= 0.99 && s >= (k + 1) / (1 + r * k) - 1e-12) strictBelow = false;
      }
    }
  }
  ok(bounded && strictBelow, `S(γ,k,r) ≤ (k+1)/(1+rk)，仅 γ=1 取等（上界锚点，γ≤0.99 严格在下）`);
  ok(
    near(speedup(1, 32, 1e-9), 33, 1e-5),
    `r→0 上界→k+1: S(1,32,1e-9) = ${speedup(1, 32, 1e-9).toFixed(9)} ≈ 33（|Δ|=${Math.abs(speedup(1, 32, 1e-9) - 33).toExponential(2)}）`,
  );
  ok(
    near(speedup(0.7, 64, 0), 1 / 0.3, 1e-6),
    `诚实封顶: 免费草稿（r=0）也有 1/(1−γ) 上限——S(0.7,64,0) = ${speedup(0.7, 64, 0).toFixed(9)} ≈ ${1 / 0.3}（投机非免费午餐）`,
  );
}

// ═══════════════════ ⑧ break-even 临界接受率 ═══════════════════

section('⑧ break-even：k=1/k=2 解析根对照 + 随 k 递增');

{
  let k1 = true;
  for (const r of [0.05, 0.1, 0.3, 0.7]) {
    if (!near(breakEvenGamma(r, 1), r, 1e-9)) k1 = false;
  }
  ok(k1, `k=1 闭式 γ_be = r: ${[0.05, 0.1, 0.3, 0.7].map((r) => `γ_be(${r})=${breakEvenGamma(r, 1)}`).join(', ')}`);
  ok(
    near(breakEvenGamma(0.1, 2), (Math.sqrt(1.8) - 1) / 2, 1e-9),
    `k=2 求根公式: γ_be(0.1,2) = ${breakEvenGamma(0.1, 2).toFixed(12)} = (−1+√1.8)/2`,
  );
  ok(
    near(breakEvenGamma(0.25, 2), (Math.sqrt(3) - 1) / 2, 1e-9),
    `k=2 求根公式: γ_be(0.25,2) = ${breakEvenGamma(0.25, 2).toFixed(12)} = (−1+√3)/2`,
  );
  const be4 = breakEvenGamma(0.1, 4);
  ok(
    near(speedup(be4, 4, 0.1), 1, 1e-9) && near(be4, 0.287108, 1e-4),
    `k=4 二分根: γ_be(0.1,4) = ${be4.toFixed(12)}，根处 S = ${speedup(be4, 4, 0.1).toFixed(12)}（N=1+rk=1.4 的解）`,
  );
  ok(
    speedup(be4 - 0.01, 4, 0.1) < 1 && speedup(be4 + 0.01, 4, 0.1) > 1,
    `判退线两侧: S(γ_be−0.01) = ${speedup(be4 - 0.01, 4, 0.1).toFixed(4)} < 1 < S(γ_be+0.01) = ${speedup(be4 + 0.01, 4, 0.1).toFixed(4)}（穿越方向正确）`,
  );
  let mono = true;
  let strictRise = true;
  for (const r of [0.05, 0.1, 0.3]) {
    let prev = 0;
    for (let k = 1; k <= 24; k += 1) {
      const be = breakEvenGamma(r, k);
      if (be < prev - 1e-12) mono = false;
      prev = be;
    }
    if (breakEvenGamma(r, 24) <= breakEvenGamma(r, 1) + 0.05) strictRise = false;
  }
  ok(mono && strictRise, `γ_be 随 k 单调递增（k=1..24 × r∈{.05,.1,.3}；更深草稿门槛更高，如 r=0.1: ${breakEvenGamma(0.1, 1).toFixed(3)} → ${breakEvenGamma(0.1, 24).toFixed(3)}）`);
  ok(
    breakEvenGamma(1.2, 4) === 1 && breakEvenGamma(0, 4) === 0,
    `边界: r≥1 → γ_be=1（草稿不比验证器廉，永不回本）；r=0 → 0（永远不吃亏）`,
  );
  let allBelow = true;
  for (const k of [1, 2, 4, 8]) {
    if (speedup(0.99, k, 1.2) >= 1) allBelow = false;
  }
  ok(allBelow, `r=1.2 时 γ=0.99 仍 S<1（k=1,2,4,8 全亏——判退线诚实，不虚假回本）`);
}

// ═══════════════════ ④ 诚实判退定理 ═══════════════════

section('④ 判退定理：γ ≤ r ⇔ 一切 k≥1 都 S≤1（直通更廉）');

{
  let allLose = true;
  for (let k = 1; k <= 30; k += 1) {
    if (speedup(0.29, k, 0.3) >= 1) allLose = false;
  }
  ok(allLose, `γ=0.29 < r=0.3: k=1..30 全部 S<1（闭式定理 N ≤ 1+kγ ≤ 1+rk 的实证）`);
  const reject = optimalDraftLength(0.29, 0.3);
  ok(
    reject.k === 0 && !reject.worthwhile && reject.rejectedByGammaFloor && reject.speedup === 1,
    `optimalDraftLength(0.29,0.3) → k*=0、S=1、判退旗标（直通基线，不投机）`,
  );
  const edge = optimalDraftLength(0.3, 0.3);
  ok(
    edge.k === 0 && !edge.worthwhile,
    `边界 γ=r=0.3: S(1)=1 恰好打平 → 仍 k*=0（无利可图不冒险，缺省不投机）`,
  );
  const indifferent = speedup(0.3, 1, 0.3);
  ok(near(indifferent, 1, 1e-12), `打平点核验: S(0.3,1,0.3) = (1+0.3)/(1+0.3) = ${indifferent}（γ=r 时 k=1 恰好 1×）`);
}

// ═══════════════════ ② ③ ⑦ 最优草稿深度 ═══════════════════

section('②③⑦ k* 精确性：手算锚点 + 暴力 argmax 对照 + 单调性');

{
  const seq = [0.3, 0.5, 0.7, 0.9].map((g) => optimalDraftLength(g, 0.1).k);
  ok(
    seq.join(',') === '1,2,4,10',
    `手算锚点（r=0.1）: k*(0.3)=1, k*(0.5)=2, k*(0.7)=4, k*(0.9)=10（逐点 S(k) 直算比对）`,
  );
  ok(
    near(speedup(0.7, 4, 0.1), (1 - Math.pow(0.7, 5)) / 0.3 / 1.4, 1e-12),
    `k* 处取值: S(0.7,4,0.1) = ${speedup(0.7, 4, 0.1).toFixed(9)} = 2.7731/1.4（闭式重算一致）`,
  );
  // 一阶边际条件 φ(k)=γ^{k+1}(1+rk)−rN(k) 在 k*−1 处为正、k* 处为负（符号翻转）
  const phi = (j) => Math.pow(0.7, j + 1) * (1 + 0.1 * j) - 0.1 * expectedTokensPerRound(0.7, j);
  ok(
    phi(3) > 0 && phi(4) < 0,
    `一阶条件符号翻转: φ(3)=${phi(3).toFixed(6)} > 0 ≥ φ(4)=${phi(4).toFixed(6)}（3→4 值得、4→5 不值得 → k*=4）`,
  );

  // 暴力 argmax 对照（45 组网格）
  let agree = 0;
  let tieMismatch = 0;
  let valueMismatch = 0;
  for (const r of [0.02, 0.05, 0.1, 0.2, 0.4]) {
    for (let g = 0.1; g <= 0.9001; g += 0.1) {
      const res = optimalDraftLength(g, r, { maxK: 64 });
      let bestK = 0;
      let bestS = speedup(g, 0, r);
      for (let k = 1; k <= 64; k += 1) {
        const s = speedup(g, k, r);
        if (s > bestS + 1e-12) {
          bestS = s;
          bestK = k;
        }
      }
      if (res.k === bestK) agree += 1;
      else if (near(speedup(g, res.k, r), bestS, 1e-9)) tieMismatch += 1;
      else valueMismatch += 1;
    }
  }
  ok(
    valueMismatch === 0 && agree >= 40,
    `暴力 argmax 对照（γ×r 45 组）: k* 全一致 ${agree} 组 + 平顶等值 ${tieMismatch} 组，0 组取值落后`,
  );

  // ② k* 关于 γ 单调不减
  let mono = true;
  let monoWorst = '';
  for (const r of [0.05, 0.1, 0.3]) {
    let prev = optimalDraftLength(0.05, r).k;
    for (let g = 0.07; g <= 0.9901; g += 0.02) {
      const k = optimalDraftLength(g, r).k;
      if (k < prev) {
        mono = false;
        monoWorst = `r=${r}, γ=${g.toFixed(2)}: ${prev}→${k}`;
      }
      prev = k;
    }
  }
  ok(mono, `② k*(γ) 单调不减（r∈{.05,.1,.3}，γ=0.05→0.99 步长 0.02${monoWorst ? `，违例 ${monoWorst}` : ''}）`);

  // ③ r↓ ⇒ k* ↑
  const ks = [0.3, 0.1, 0.03, 0.01, 0.003, 0.001].map((r) => optimalDraftLength(0.7, r).k);
  let rMono = true;
  for (let i = 1; i < ks.length; i += 1) if (ks[i] < ks[i - 1]) rMono = false;
  ok(
    rMono && ks.join(',') === '2,4,7,9,13,16',
    `③ γ=0.7 草稿越廉 k* 越深: r=(.3,.1,.03,.01,.003,.001) → k* = [${ks.join(',')}]`,
  );
  ok(
    optimalDraftLength(0.95, 1e-8).capped === true,
    `③ r→1e-8、γ=0.95 时 k* 触到扫描上限 64，capped 如实标记（不假装收敛）`,
  );
  const perfect = optimalDraftLength(1, 0.4, { maxK: 16 });
  ok(
    perfect.k === 16 && perfect.capped && near(perfect.speedup, 17 / 7.4, 1e-6),
    `γ=1, r=0.4: k*=maxK=16（capped），S = 17/(1+6.4) = ${perfect.speedup}（完美接受下草稿永远值得加深）`,
  );
  ok(
    optimalDraftLength(1, 1.5).k === 0 && !optimalDraftLength(1, 1.5).worthwhile,
    `γ=1 但 r=1.5: 完美接受也救不回更贵的草稿 → k*=0 判退`,
  );
  ok(
    optimalDraftLength(0, 0.1).k === 0,
    `γ=0（全拒）: k*=0——纯浪费草稿成本`,
  );
  const free = optimalDraftLength(0.7, 0);
  ok(
    free.capped && free.k === 64,
    `r=0 免费草稿: k* 顶到上限 64（γ^{k+1}≤1e-12 前一直值得加深，capped 诚实标记）`,
  );
}

// ═══════════════════ ⑨ 配对经济性裁决 ═══════════════════

section('⑨ speculativeEconomy：drafter→verifier 配对裁决');

{
  const good = speculativeEconomy(
    { id: 'fast-mini', costPerToken: 1, acceptanceRate: 0.72 },
    { id: 'strong-xl', costPerToken: 20 },
  );
  const ref = optimalDraftLength(0.72, 0.05);
  ok(
    good.pair === 'fast-mini→strong-xl' && good.costRatio === 0.05 && good.adopt && good.basis === 'closed-form',
    `赢利配对: ${good.pair}，r=1/20=0.05，adopt=${good.adopt}（γ=0.72 ≫ 判退线 0.05）`,
  );
  ok(
    good.optimalK === ref.k && good.speedup === ref.speedup && good.tokensPerRound === ref.tokensPerRound,
    `与 optimalDraftLength 逐字段一致: k*=${good.optimalK}、S=${good.speedup}×、每轮 ${good.tokensPerRound} token`,
  );
  ok(
    good.margin > 0 && near(good.breakEven, breakEvenGamma(0.05, good.optimalK), 1e-6),
    `临界口径: γ_be(k*=${good.optimalK})=${good.breakEven}，安全边际 γ−γ_be=${good.margin.toFixed(6)} > 0`,
  );
  const bad = speculativeEconomy(
    { id: 'mid-tier', costPerToken: 8, acceptanceRate: 0.6 },
    { id: 'flagship', costPerToken: 10 },
  );
  ok(
    !bad.adopt && bad.optimalK === 0 && bad.speedup === 1 && bad.costRatio === 0.8,
    `亏损配对: r=8/10=0.8 > γ=0.6 → adopt=false、k*=0、S=1（诚实判退，直通 flagship 更廉）`,
  );
  ok(
    bad.breakEven === 0.8 && near(bad.margin, -0.2, 1e-6),
    `判退门槛按 k=1 口径给全: γ_be=0.8（=r 闭式），边际 −0.2——需要接受率 ≥0.8 才值得投机`,
  );
  ok(
    bad.interpretation.includes('判退') && good.interpretation.includes('采纳'),
    `裁决话术: 亏损→「${bad.interpretation.slice(0, 28)}…」；赢利→「${good.interpretation.slice(0, 26)}…」`,
  );
}

// ═══════════════════ 入参校验 ═══════════════════

section('入参校验：显式 throw（铁律：同错误不静默）');

{
  const cases = [
    ['γ=1.2 越界', () => expectedTokensPerRound(1.2, 3)],
    ['k=2.5 非整数', () => expectedTokensPerRound(0.5, 2.5)],
    ['k=−1 负深度', () => expectedTokensPerRound(0.5, -1)],
    ['roundCost 负深度', () => roundCost(-1, 0.1)],
    ['roundCost 负成本比', () => roundCost(1, -0.1)],
    ['roundCost B=0', () => roundCost(1, 0.1, 0)],
    ['optimalDraft γ 越界', () => optimalDraftLength(1.5, 0.1)],
    ['optimalDraft 负成本比', () => optimalDraftLength(0.7, -1)],
    ['optimalDraft maxK=0', () => optimalDraftLength(0.7, 0.1, { maxK: 0 })],
    ['breakEven k=0', () => breakEvenGamma(0.1, 0)],
    ['breakEven 负成本比', () => breakEvenGamma(-1, 3)],
    ['配对空 id', () => speculativeEconomy({ id: '', costPerToken: 1, acceptanceRate: 0.5 }, { id: 'v', costPerToken: 2 })],
    ['配对草稿成本 0', () => speculativeEconomy({ id: 'd', costPerToken: 0, acceptanceRate: 0.5 }, { id: 'v', costPerToken: 2 })],
    ['配对 γ=1.3', () => speculativeEconomy({ id: 'd', costPerToken: 1, acceptanceRate: 1.3 }, { id: 'v', costPerToken: 2 })],
    ['仿真轮数 0', () => simulateRounds(0.5, 4, 0, 1)],
    ['仿真 γ 越界', () => simulateRounds(2, 4, 10, 1)],
  ];
  const thrown = cases.filter(([name, fn]) => throws(fn)).length;
  ok(thrown === cases.length, `${thrown}/${cases.length} 个非法输入全部显式 throw（${cases.map(([n]) => n).slice(0, 4).join('、')}…）`);
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed === 0) {
  console.log('✅ 51.0 投机解码内核 —— 全部断言通过（闭式/手算/暴力 argmax/仿真 LLN 四重对照）');
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
process.exitCode = failed === 0 ? 0 : 1;
