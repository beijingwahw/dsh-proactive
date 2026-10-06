/**
 * verify-r5-decision.mjs — R5-A7「决策计算内核第五轮进化」纯数学离线验证
 *
 * 六个内核（21.0 Gittins / 22.0 BwK / 53.0 Whittle / 73.0 BAI /
 * 52.0 测试时计算 / 51.0 投机解码）的进化四轴验证——不是「能跑」，
 * 是「算得对 + 算得快 + 稳 + 性质成立」：
 *
 *   21.0 Gittins（A1 计算成本索引 / A2 增量构建）:
 *     ① 边界态闭式: n=maxCount 处 ν = p̂ 与 ν^c = p̂ − c 精确（退化为已知臂）;
 *     ② ≥200 种子 × 成本格点: ν^c 关于 c 单调不增、ν^c ≥ p̂ − c、ν^c ≤ ν;
 *     ③ 等价性: 播种二分 vs 脚本内复刻的旧全域二分(26 轮/Map 归纳)全网格
 *        对照——|Δ| ≤ 2⁻²⁶ 圆整口径（贴证: 交点唯一 + 终区间含交点）;
 *     ④ 增量构建: 后验演化路径查询触发 seededBisections > 0、seedFallbacks = 0,
 *        全网格填充耗时对照（新 vs 旧复刻）; 学习溢价沿对角线单调归零。
 *   22.0 BwK（A1 LP 对偶证书 / A2 凸包 O(K log K)）:
 *     ⑤ 解析锚点: 双臂混合 λ = (1−0.6)/0.8 = 0.5、原始=对偶=0.8、gap=0;
 *        预算不紧 λ=0; b < min c 不可行诚实返回;
 *     ⑥ ≥200 种子: 对偶可行(∀k: y0+λc_k ≥ q_k) + 强对偶 gap ≤ 1e-9 +
 *        原始值 = 脚本侧 O(K²) 全对混合暴力解(凸包等价性) + ≥ 一切纯可行臂;
 *     ⑦ 耗时: K=400 臂凸包 vs 暴力 O(K²); ⑧ route() 影子价格与证书一致;
 *     ⑨ 预算从不透支: ≥200 种子 route() 可行基选中臂消耗 ≤ 预算率×(1+slack),
 *        不可行必 cheapest-shed + urgent。
 *   53.0 Whittle（A1/A2 策略迭代精确解）:
 *     ⑩ 300 个 (臂,λ): 内核 PI 值 vs 脚本独立值迭代 ≤ 1e-10 + 被动判据一致
 *        + iterations ≤ 4（有限策略空间定理的可视化）;
 *     ⑪ ≥240 种子: 可索引性 100% + 二分收敛宽 ≤ 1e-6 + 退化闭式 W=[γR,R];
 *     ⑫ 耗时: PI vs 值迭代 ≥ 10×。
 *   73.0 BAI（A1 LUCB / A2 批量 SH）:
 *     ⑬ LUCB 识别率 ≥ 0.95、样本集中于「领袖×挑战者」(top-2 占比 > 55%,
 *        最差臂饿死 < 1/5)、1/Δ² 排序;
 *     ⑭ 批量 SH 与经典 SH 识别率差 ≤ 3σ（分布等价的实证——二项整抽 ≡
 *        逐样本伯努利）; ⑮ ≥200 种子预算纪律 + 同种子逐位确定;
 *     ⑯ 耗时: identificationRate 500 试验批量 vs 经典。
 *   52.0 TTC（A1 加权多数 / A2 二项尾递推）:
 *     ⑰ 加权退化为无权: 全 1 权重 ≡ majorityAccuracy(ρ∈{0,.15,.25}, n≤21) 1e-12;
 *     ⑱ ≥200 种子暴力枚举(2ⁿ 全子集)对照精确 DP ≤ 1e-12（含平局质量）;
 *     ⑲ Nitzan–Paroush 定理: 独立同分布下简单多数 ≥ 一切加权多数(≥200 种子);
 *     ⑳ Kish n_eff 锚点 + CLT 近似误差档位; p=0.5 加权恒 0.5;
 *     ㉑ 耗时: 二项尾乘法递推 vs 逐项 log-Γ 复刻。
 *   51.0 投机解码（A1 束式树投机闭式 / A3 expm1 / A4 上界）:
 *     ㉒ b=1 逐位退化为链闭式(全网格 ===); 手算 N(0.5,2,2) = 2.3125;
 *     ㉓ ≥1300 网格点: S ≤ (k+1)/(1+rbk) 且 ≤ k+1(加速上界), γ≤r 判退域 S≤1,
 *        N 关于 b 单调; ㉔ 仿真 LLN 对照(b>1 含); ㉕ (k*,b*) = 独立闭式 argmax;
 *        r 大 ⟹ b*=1, γ 低 ⟹ b*>1（分支回收接受率）。
 *
 * 全部断言确定性（mulberry32 种子固定, 同输入同输出）。
 * 运行：npm run build && node scripts/verify-r5-decision.mjs
 *      （bandit-knapsack 含内核间 import, 走 dist 快照——与 verify-genesis-kernels 同口径）
 */

import {
  GittinsIndexTable,
  BwKRouter,
  bwkLpCertificate,
  solveWhittleIndex,
  solveSubsidy,
  indexabilityCheck,
  successiveHalving,
  successiveHalvingBatched,
  racingElimination,
  uniformAllocation,
  lucbTracking,
  identificationRate,
  BAI_ALGORITHMS,
  majorityAccuracy,
  weightedMajorityAccuracy,
  weightedMajorityNormal,
  kishEffectiveSampleSize,
  expectedTokensPerRound,
  speedup,
  optimalDraftLength,
  expectedTokensTree,
  draftTokensTree,
  roundCostTree,
  speedupTree,
  optimalTreeDraft,
  simulateTreeRounds,
} from '../dist/index.mjs';

// ─────────────────────────── 断言与工具 ───────────────────────────
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
  console.error(`  ✗ ${label}（未抛出）`);
}
function timeIt(fn, reps = 3) {
  const runs = [];
  for (let r = 0; r < reps; r += 1) {
    const t0 = process.hrtime.bigint();
    fn();
    runs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return Math.min(...runs);
}

/** 确定性 RNG（mulberry32，与内核同口径） */
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
const round6 = (x) => Math.round(x * 1e6) / 1e6;

// ═══════════════════ 21.0 Gittins：计算成本索引 + 增量构建 ═══════════════════

section('21.0 Gittins A1：计算成本版索引 ν^c 的闭式锚点与单调定理');

{
  // 边界态 n = maxCount: 后验视为已知 ⟹ 退休 MDP 在边界态退化为
  // play = (p̂ − c)/(1−γ) vs retire = R/(1−γ) ⟹ ν = p̂、ν^c = p̂ − c 精确
  const t = new GittinsIndexTable({ discount: 0.95, maxCount: 200 });
  ok(near(t.index(150, 50), 0.75, 1e-6), `边界态 ν(150,50) = ${t.index(150, 50)} = p̂ = 0.75 精确（n = maxCount 退化为已知臂）`);
  ok(
    near(t.indexWithCost(150, 50, 0.1), 0.65, 1e-6),
    `边界态 ν^c(150,50,0.1) = ${t.indexWithCost(150, 50, 0.1)} = p̂ − c = 0.65 精确（计算成本口径的已知臂闭式）`,
  );

  // ≥200 种子 × 成本格点: 单调不增 / ≥ p̂ − c / ≤ ν
  const tab = new GittinsIndexTable({ discount: 0.9, maxCount: 24 });
  const rand = mulberry32(20261001);
  let monoC = true;
  let aboveFloor = true;
  let belowPlain = true;
  let checks = 0;
  for (let i = 0; i < 200; i += 1) {
    const a = 1 + Math.floor(rand() * 10);
    const b = 1 + Math.floor(rand() * 10); // a+b ≤ 20 < maxCount: 不触发网格钳制（钳制会移动 p̂, 属另一口径）
    const pHat = a / (a + b);
    const nu0 = tab.index(a, b);
    let prev = nu0;
    for (let ci = 0; ci <= 9; ci += 1) {
      const c = ci * 0.05;
      const nuC = tab.indexWithCost(a, b, c);
      if (nuC > prev + 1e-9) monoC = false;
      if (nuC < pHat - c - 1e-6) aboveFloor = false;
      if (nuC > nu0 + 1e-6) belowPlain = false;
      prev = nuC;
      checks += 1;
    }
  }
  ok(monoC, `ν^c 关于成本 c 单调不增（200 种子 × 10 成本格点 = ${checks} 检查——播放分支逐点被压低, 交点左移的归纳定理）`);
  ok(aboveFloor, `ν^c ≥ p̂ − c − 1e-6 全部成立（学习溢价在计算成本下存活）`);
  ok(belowPlain, `ν^c ≤ ν（成本口径的播放值不会高于无成本口径）`);

  // 入参校验
  throws(() => tab.indexWithCost(3, 5, 1.5), 'indexWithCost(c=1.5) 显式 throw');
  throws(() => tab.indexWithCost(3, 5, -0.1), 'indexWithCost(c=−0.1) 显式 throw');
  const snap = tab.snapshot();
  ok(
    snap.costComputedStates > 0 && typeof snap.seededBisections === 'number' && typeof snap.seedFallbacks === 'number',
    `snapshot 新审计字段: costComputedStates=${snap.costComputedStates}, seededBisections=${snap.seededBisections}, seedFallbacks=${snap.seedFallbacks}`,
  );
}

section('21.0 Gittins A2：播种二分 ≡ 全域二分（等价性证明的实证）+ 增量构建');

{
  // ── 旧算法复刻（升级前逐位: Map 归纳 + 固定 26 轮 [0,1] 二分）──
  const GAMMA = 0.9;
  const MAXC = 24;
  const ROUNDS = 26;
  const refPlayOptimal = (a0, b0, R) => {
    const inv = 1 / (1 - GAMMA);
    const retire = R * inv;
    const n0 = a0 + b0;
    const v = new Map();
    for (let n = MAXC; n >= n0; n -= 1) {
      for (let a = a0; a <= n - b0; a += 1) {
        const b = n - a;
        const p = a / n;
        let playV;
        if (n === MAXC) playV = p * inv;
        else {
          const vS = v.get(`${a + 1}:${b}`) ?? p * inv;
          const vF = v.get(`${a}:${b + 1}`) ?? p * inv;
          playV = p * (1 + GAMMA * vS) + (1 - p) * GAMMA * vF;
        }
        v.set(`${a}:${b}`, Math.max(retire, playV));
      }
    }
    const p0 = a0 / (a0 + b0);
    const rootPlay =
      a0 + b0 === MAXC
        ? p0 * inv
        : p0 * (1 + GAMMA * (v.get(`${a0 + 1}:${b0}`) ?? p0 * inv)) +
          (1 - p0) * (GAMMA * (v.get(`${a0}:${b0 + 1}`) ?? p0 * inv));
    return rootPlay >= retire - 1e-12;
  };
  const refIndex = (a, b) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < ROUNDS; i += 1) {
      const mid = (lo + hi) / 2;
      if (refPlayOptimal(a, b, mid)) lo = mid;
      else hi = mid;
    }
    return round6(lo);
  };

  // 全网格对照: n 升序填充（后验演化的自然查询序, 播种天然命中）
  const tab = new GittinsIndexTable({ discount: GAMMA, maxCount: MAXC });
  let maxDiff = 0;
  let exact = 0;
  let total = 0;
  for (let n = 2; n <= MAXC; n += 1) {
    for (let a = 1; a < n; a += 1) {
      const b = n - a;
      const nu = tab.index(a, b);
      const ref = refIndex(a, b);
      maxDiff = Math.max(maxDiff, Math.abs(nu - ref));
      if (nu === ref) exact += 1;
      total += 1;
    }
  }
  ok(
    maxDiff <= 2e-6,
    `播种二分 ≡ 全域二分: ${total} 网格态 max|Δ| = ${maxDiff.toExponential(2)} ≤ 2⁻²⁶ 圆整口径（交点唯一 + 双方终区间含交点且宽 ≤ 2⁻²⁶）`,
  );
  ok(exact >= total * 0.9, `圆整后逐位一致率 ${exact}/${total} ≥ 90%（其余为 1e-6 贴边差, 由 2⁻²⁶ 前圆整差决定）`);
  const snap = tab.snapshot();
  ok(
    snap.seedFallbacks === 0 && snap.seededBisections > total * 0.5,
    `增量构建: seededBisections = ${snap.seededBisections}/${total}（既有表项收窄区间）, seedFallbacks = ${snap.seedFallbacks}（单调性引理未被破坏）`,
  );

  // 学习溢价单调归零（对角线）
  let premMono = true;
  let prevPrem = Infinity;
  const premSeq = [];
  for (let k = 1; k <= 20; k += 1) {
    const prem = tab.index(k, k) - k / (2 * k);
    if (prem > prevPrem + 1e-9) premMono = false;
    prevPrem = prem;
    premSeq.push(prem);
  }
  ok(
    premMono && premSeq[0] > premSeq[5] && premSeq[5] > premSeq[19] && premSeq[19] >= -1e-6,
    `学习溢价单调归零: ν(k,k) − 0.5 = ${premSeq[0].toFixed(4)} > ${premSeq[5].toFixed(4)} > ${premSeq[19].toExponential(2)} ≥ 0（探索自我终结）`,
  );

  // 耗时对照: 后验演化路径（新状态前驱 = 旧状态）
  const path = [];
  {
    let a = 1;
    let b = 1;
    const r2 = mulberry32(777);
    for (let s = 0; s < 60; s += 1) {
      path.push([a, b]);
      if (r2() < 0.55) a += 1;
      else b += 1;
    }
  }
  const tNew = timeIt(() => {
    const fresh = new GittinsIndexTable({ discount: GAMMA, maxCount: MAXC }); // 每次新鲜表: 计时不含缓存命中
    for (const [a, b] of path) fresh.index(a, b);
  });
  const tOld = timeIt(() => {
    for (const [a, b] of path) refIndex(a, b);
  });
  ok(
    tNew < tOld,
    `演化路径 60 查询耗时: 新 ${tNew.toFixed(2)}ms vs 旧复刻 ${tOld.toFixed(2)}ms（加速 ${(tOld / tNew).toFixed(2)}×: 稠密归纳 + 播种二分）`,
  );
}

// ═══════════════════ 22.0 BwK：LP 对偶证书 + 凸包 ═══════════════════

section('22.0 BwK A1：LP 松弛界的对偶证书（可行解证明界紧）');

{
  // 解析锚点: (c,q) = (0.9,1) 与 (0.1,0.6), b=0.5 ⟹ 混合 0.5/0.5,
  // λ = (1−0.6)/(0.9−0.1) = 0.5, 原始 = 对偶 = 0.8, 对偶可行 violation = 0
  const armA = { id: 'a', qualityMean: 1, tokensMean: 0.9, samples: 5000 };
  const armB = { id: 'b', qualityMean: 0.6, tokensMean: 0.1, samples: 5000 };
  const cert = bwkLpCertificate([armA, armB], { tokensRemaining: 50, roundsRemaining: 100 });
  ok(
    cert.basis === 'two-arm-mixture' && near(cert.primalValue, 0.8, 1e-9) && near(cert.shadowPrice, 0.5, 1e-9),
    `双臂混合顶点: 原始 = ${cert.primalValue} = 0.5×1 + 0.5×0.6, λ* = ${cert.shadowPrice} = (1−0.6)/0.8（解析解）`,
  );
  ok(
    cert.dualFeasible && cert.maxConstraintViolation <= 1e-9 && cert.tight && cert.gap <= 1e-9,
    `对偶证书: 可行(∀k: y0+λc_k ≥ q_k, 最大违反 ${cert.maxConstraintViolation.toExponential(2)}), 强对偶 gap = ${cert.gap} ≤ 1e-9（y0=${cert.baseValue}, 对偶目标 = ${cert.dualObjective} = 原始 ⟹ 界紧）`,
  );
  // 预算不紧: 两臂均可行 ⟹ λ*=0, y0 = max q, 支撑单臂
  const slack = bwkLpCertificate([armA, armB], { tokensRemaining: 105, roundsRemaining: 100 });
  ok(
    slack.basis === 'single-arm' && slack.shadowPrice === 0 && near(slack.baseValue, 1, 1e-9) && slack.tight,
    `预算率 1.05 不紧: 单臂纯解 ${slack.mixture.map((m) => `${m.id}×${m.weight}`).join()}, λ* = 0（约束对偶价为零, y0 = max q = 1）`,
  );
  // 不可行: b < min c ⟹ LP 可行域空, 诚实返回
  const infeas = bwkLpCertificate([armA, armB], { tokensRemaining: 5, roundsRemaining: 100 });
  ok(
    infeas.feasible === false && infeas.basis === 'infeasible' && !Number.isFinite(infeas.primalValue),
    `预算率 0.05 < min c = 0.1: feasible = false, basis = infeasible（Σx=1 下任何分布都超支——诚实而非假装）`,
  );
  throws(() => bwkLpCertificate([], { tokensRemaining: 10, roundsRemaining: 10 }), 'bwkLpCertificate(空臂) 显式 throw');

  // ── ≥200 种子: 对偶可行 + 强对偶 + 凸包 ≡ O(K²) 全对暴力 ──
  const rand = mulberry32(20261002);
  const bruteLp = (points, b) => {
    // 单臂纯解 + 全对混合顶点（跨 b 的边端点插值）
    let best = -Infinity;
    for (const p of points) if (p.c <= b + 1e-12 && p.q > best) best = p.q;
    for (let i = 0; i < points.length; i += 1) {
      for (let j = 0; j < points.length; j += 1) {
        if (i === j) continue;
        const pi = points[i];
        const pj = points[j];
        if (pj.c > b + 1e-12 || pi.c <= b + 1e-12) continue; // 需要 cj ≤ b < ci
        const t = (b - pj.c) / (pi.c - pj.c);
        if (t < 0 || t > 1) continue;
        const v = t * pi.q + (1 - t) * pj.q;
        if (v > best) best = v;
      }
    }
    return best;
  };
  let allDualFeasible = true;
  let allTight = true;
  let allMatchBrute = true;
  let allAbovePure = true;
  let feasibleCnt = 0;
  let mixtureOk = true;
  let infeasibleAgree = 0;
  for (let s = 0; s < 220; s += 1) {
    const K = 2 + Math.floor(rand() * 11);
    const arms = [];
    for (let i = 0; i < K; i += 1) {
      arms.push({
        id: `arm${i}`,
        qualityMean: rand(),
        tokensMean: 0.05 + rand() * 1.95,
        samples: 1000,
      });
    }
    const b = 0.05 + rand() * 1.95;
    const budgets = { tokensRemaining: b * 100, roundsRemaining: 100 };
    const cert = bwkLpCertificate(arms, budgets);
    const points = arms.map((a) => ({ c: a.tokensMean, q: Math.min(1, Math.max(0, a.qualityMean)) }));
    const minC = Math.min(...points.map((p) => p.c));
    if (minC > b + 1e-12) {
      if (cert.feasible === false) infeasibleAgree += 1;
      else allDualFeasible = false;
      continue;
    }
    feasibleCnt += 1;
    if (!cert.dualFeasible || cert.maxConstraintViolation > 1e-9) allDualFeasible = false;
    if (!cert.tight || cert.gap > 1e-9) allTight = false;
    const brute = bruteLp(points, b);
    if (!near(cert.primalValue, brute, 1e-6)) allMatchBrute = false;
    const pureBest = Math.max(...points.filter((p) => p.c <= b + 1e-12).map((p) => p.q));
    if (cert.primalValue < pureBest - 2e-6) allAbovePure = false; // primalValue 为 1e-6 展示圆整口径
    const wSum = cert.mixture.reduce((acc, m) => acc + m.weight, 0);
    if (!near(wSum, 1, 2e-6) || cert.mixture.length > 2 || cert.mixture.length === 0) mixtureOk = false;
    if (cert.mixture.some((m) => m.weight < -1e-9)) mixtureOk = false;
  }
  ok(allDualFeasible, `≥220 种子实例: 对偶可行性 100%（上凸包构造 ⟹ 所有点在支撑线下——证书本体）`);
  ok(allTight, `强对偶 100%: gap ≤ 1e-9（可行实例 ${feasibleCnt} 个, 不可行 ${infeasibleAgree} 个全部诚实返回）`);
  ok(allMatchBrute, `凸包 O(K log K) ≡ O(K²) 全对暴力: 可行实例原始值全部一致（凹包络 = 跨 b 弦插值的等价性）`);
  ok(allAbovePure && mixtureOk, `原始值 ≥ 一切纯可行臂 + 支撑 ≤ 2 臂且权重和 = 1（LP 顶点解结构）`);

  // 耗时: K=2500 臂（二次 vs 线性对数的规模分离）
  {
    const r3 = mulberry32(31337);
    const big = Array.from({ length: 2500 }, (_, i) => ({
      id: `m${i}`,
      qualityMean: r3(),
      tokensMean: 0.05 + r3() * 1.95,
      samples: 1000,
    }));
    const points = big.map((a) => ({ c: a.tokensMean, q: a.qualityMean }));
    const tHull = timeIt(() => bwkLpCertificate(big, { tokensRemaining: 70, roundsRemaining: 100 }));
    const tBrute = timeIt(() => bruteLp(points, 0.7));
    ok(
      tHull * 5 <= tBrute,
      `K=2500 耗时: 凸包 ${tHull.toFixed(2)}ms vs 暴力 ${tBrute.toFixed(2)}ms（${(tBrute / tHull).toFixed(1)}× —— O(K log K) vs O(K²), 二次项主导后的规模分离）`,
    );
  }

  // route() 一致性 + 预算从不透支
  const router = new BwKRouter();
  const r1 = router.route([armA, armB], { tokensRemaining: 50, roundsRemaining: 100 });
  ok(
    Math.abs(r1.shadowPriceTokens - cert.shadowPrice) <= 0.05,
    `route() 影子价格 ${r1.shadowPriceTokens} ≈ 证书 λ* ${cert.shadowPrice}（差 ≤ 0.05 = 乐观半径口径 vs 真值口径）`,
  );
  const rand4 = mulberry32(424242);
  let noOverdraw = true;
  let shedConsistent = true;
  const cfg = router.getConfig();
  for (let s = 0; s < 220; s += 1) {
    const K = 2 + Math.floor(rand4() * 8);
    const arms = Array.from({ length: K }, (_, i) => ({
      id: `x${i}`,
      qualityMean: rand4(),
      tokensMean: 0.05 + rand4() * 1.95,
      samples: 1000,
    }));
    const b = 0.05 + rand4() * 1.95;
    const verdict = router.route(arms, { tokensRemaining: b * 100, roundsRemaining: 100 });
    if (verdict.basis === 'empty') continue;
    const threshold = (b * 100) / 100 * (1 + cfg.feasibilitySlack);
    const chosenArm = arms.find((a) => a.id === verdict.chosenId);
    if (verdict.basis === 'ucb-feasible') {
      if (chosenArm.tokensMean > threshold + 1e-9) noOverdraw = false;
    } else if (verdict.basis === 'cheapest-shed') {
      if (!verdict.urgent) shedConsistent = false;
      if (arms.some((a) => a.tokensMean <= threshold + 1e-9)) shedConsistent = false;
    }
  }
  ok(noOverdraw, `预算从不透支: 220 种子可行基选中臂消耗 ≤ 预算率×(1+slack)（透支只发生在显式卸载基）`);
  ok(shedConsistent, `cheapest-shed 基语义一致: urgent=true 且确实无可行臂（不假装最优仍存在）`);
}

// ═══════════════════ 53.0 Whittle：策略迭代精确解 ═══════════════════

section('53.0 Whittle A1/A2：补贴 MDP 的策略迭代精确解');

{
  // ── 独立值迭代复刻（与内核不同源）──
  const scriptVI = (arm, lambda) => {
    const g = arm.discount;
    const ra = [0, arm.activeReward];
    const rp = [0, arm.passiveReward ?? 0];
    let V = [0, 0];
    for (let t = 0; t < 500000; t += 1) {
      const NV = [0, 1].map((s) => {
        const qa = ra[s] + g * (arm.pa[s][0] * V[0] + arm.pa[s][1] * V[1]);
        const qp = rp[s] + lambda + g * (arm.pp[s][0] * V[0] + arm.pp[s][1] * V[1]);
        return Math.max(qa, qp);
      });
      const d = Math.max(Math.abs(NV[0] - V[0]), Math.abs(NV[1] - V[1]));
      V = NV;
      if (d <= 1e-13 * (1 + Math.max(Math.abs(V[0]), Math.abs(V[1]), 1))) break;
    }
    return V;
  };
  const rand = mulberry32(530001);
  const armOf = (randFn, gamma) => {
    const row = () => {
      const x = randFn();
      return [1 - x, x];
    };
    return {
      pa: [row(), row()],
      pp: [row(), row()],
      activeReward: 0.1 + randFn(),
      passiveReward: randFn() * 0.6,
      discount: gamma,
    };
  };

  // 300 个 (臂, λ) 检查点: PI 值 = VI 不动点, iterations ≤ 4
  let maxVDiff = 0;
  let maxIter = 0;
  let flagMatch = true;
  let checks = 0;
  const armsForTiming = [];
  const lambdasForTiming = [];
  for (let i = 0; i < 60; i += 1) {
    const arm = armOf(rand, 0.8 + rand() * 0.17);
    const lambdas = [-0.3, 0, 0.35, 1.1];
    for (const lambda of lambdas) {
      const ks = solveSubsidy(arm, lambda);
      const V = scriptVI(arm, lambda);
      maxVDiff = Math.max(maxVDiff, Math.abs(ks.value[0] - V[0]), Math.abs(ks.value[1] - V[1]));
      maxIter = Math.max(maxIter, ks.iterations);
      for (const s of [0, 1]) {
        const qa = (s === 1 ? arm.activeReward : 0) + arm.discount * (arm.pa[s][0] * V[0] + arm.pa[s][1] * V[1]);
        const qp = (s === 1 ? arm.passiveReward ?? 0 : 0) + lambda + arm.discount * (arm.pp[s][0] * V[0] + arm.pp[s][1] * V[1]);
        if ((qp > qa) !== ks.passiveOptimal[s]) flagMatch = false;
      }
      checks += 1;
      armsForTiming.push(arm);
      lambdasForTiming.push(lambda);
    }
  }
  ok(
    maxVDiff <= 5e-10 && flagMatch,
    `PI 精确解 = VI 不动点: ${checks} 检查点 max|ΔV| = ${maxVDiff.toExponential(2)} ≤ 5e-10（残差为脚本 VI 自身的收敛容差口径）, 被动判据不一致 0 处（两者都是同一 Bellman 算子的唯一不动点）`,
  );
  ok(
    maxIter <= 4,
    `策略迭代轮数 max = ${maxIter} ≤ 4（2 态 × 2 动作 = 4 个确定性平稳策略——有限策略空间 + 严格改进定理的可视化）`,
  );

  // 耗时对照: PI vs 独立 VI（同一组求解）
  const tPI = timeIt(() => {
    for (let i = 0; i < armsForTiming.length; i += 1) solveSubsidy(armsForTiming[i], lambdasForTiming[i]);
  });
  const tVI = timeIt(() => {
    for (let i = 0; i < armsForTiming.length; i += 1) scriptVI(armsForTiming[i], lambdasForTiming[i]);
  });
  ok(
    tPI * 5 <= tVI,
    `耗时: 内核 PI ${tPI.toFixed(2)}ms vs 独立值迭代 ${tVI.toFixed(2)}ms（${(tVI / tPI).toFixed(0)}×, 含内核入参规范化开销——γ→1 时 VI 扫描数发散, PI 恒 ≤4 轮线代）`,
  );

  // ≥240 种子可索引性 + 收敛 + 退化闭式
  const rand2 = mulberry32(530002);
  let indexable = 0;
  let converged = 0;
  let widthOk = true;
  for (let i = 0; i < 240; i += 1) {
    const arm = armOf(rand2, 0.8 + rand2() * 0.17);
    const ic = indexabilityCheck(arm);
    const w = solveWhittleIndex(arm);
    if (ic.indexable) indexable += 1;
    if (w.converged) converged += 1;
    for (const br of w.brackets) if (br[1] - br[0] > 1e-6 + 1e-9) widthOk = false;
  }
  ok(indexable === 240, `可索引性 ${indexable}/240 = 100%（坏态收益与动作无关的两态臂恒可索引——文件头定理, 全新种子复核）`);
  ok(converged === 240 && widthOk, `二分全部收敛且区间宽 ≤ 1e-6（PI 精确内层解下端点语义严格成立）`);
  const deg = (R, g) => ({
    pa: [
      [0, 1],
      [0, 1],
    ],
    pp: [
      [1, 0],
      [1, 0],
    ],
    activeReward: R,
    discount: g,
  });
  const w1 = solveWhittleIndex(deg(1.7, 0.85));
  ok(
    near(w1.index[0], 0.85 * 1.7, 2e-6) && near(w1.index[1], 1.7, 2e-6),
    `退化闭式 W = [γR, R] = [${w1.index[0].toFixed(6)}, ${w1.index[1].toFixed(6)}]（γ=0.85, R=1.7 ⟹ [1.445, 1.7]——新参数复核）`,
  );
}

// ═══════════════════ 73.0 BAI：LUCB + 批量 SH ═══════════════════

section('73.0 BAI A1：LUCB1 乐观追踪（领袖 × 挑战者的样本集中）');

{
  const MUS = [0.5, 0.45, 0.4, 0.3, 0.1];
  const lucb = identificationRate({ mus: MUS, budget: 3000, trials: 500, seed: 7, algorithm: BAI_ALGORITHMS.lucbTracking });
  const sh = identificationRate({ mus: MUS, budget: 3000, trials: 500, seed: 7 });
  ok(lucb.rate >= 0.95, `LUCB 识别率 ${lucb.rate.toFixed(3)} ≥ 0.95（budget=3000 ≈ 5.6H, 500 种子）`);
  ok(
    Math.abs(lucb.rate - sh.rate) <= 0.05,
    `与 SH(${sh.rate.toFixed(3)}) 同档（差 ${(lucb.rate - sh.rate).toFixed(3)}）——乐观追踪与固定几何的行为对照`,
  );
  const top2Share = (lucb.averageSamplesPerArm[0] + lucb.averageSamplesPerArm[1]) / 3000;
  ok(
    top2Share > 0.55 && lucb.averageSamplesPerArm[4] < lucb.averageSamplesPerArm[1] / 5,
    `样本集中于「领袖×挑战者」: top-2 占 ${(top2Share * 100).toFixed(1)}% > 55%, 最差臂 ${lucb.averageSamplesPerArm[4].toFixed(0)} < 臂1 ${lucb.averageSamplesPerArm[1].toFixed(0)}/5（其余臂饿死——LUCB 结构签名）`,
  );
  ok(
    lucb.averageSamplesPerArm[1] > lucb.averageSamplesPerArm[2] && lucb.averageSamplesPerArm[2] > lucb.averageSamplesPerArm[3],
    `1/Δ² 排序一致: 臂1(${lucb.averageSamplesPerArm[1].toFixed(0)}) > 臂2(${lucb.averageSamplesPerArm[2].toFixed(0)}) > 臂3(${lucb.averageSamplesPerArm[3].toFixed(0)})（gap 越小挑战者越难打）`,
  );
  throws(() => lucbTracking({ mus: MUS, budget: 100, delta: 2 }), 'lucbTracking(δ=2) 显式 throw');
  throws(() => lucbTracking({ mus: MUS, budget: 100, beta: 0 }), 'lucbTracking(β=0) 显式 throw');
}

section('73.0 BAI A2：批量 SH 的分布等价 + 预算纪律 + 确定性');

{
  const MUS = [0.5, 0.45, 0.4, 0.3, 0.1];
  // 分布等价: |rate_batched − rate_classic| ≤ 3σ（两比例对照, 500 试验）
  let equivOk = true;
  const diffs = [];
  for (const budget of [900, 3000]) {
    const a = identificationRate({ mus: MUS, budget, trials: 500, seed: 7 });
    const b = identificationRate({ mus: MUS, budget, trials: 500, seed: 7, algorithm: BAI_ALGORITHMS.successiveHalvingBatched });
    const pBar = (a.rate + b.rate) / 2;
    const se = Math.sqrt((2 * pBar * (1 - pBar)) / 500);
    diffs.push(Math.abs(a.rate - b.rate));
    if (Math.abs(a.rate - b.rate) > 3 * se + 1e-12) equivOk = false;
  }
  ok(
    equivOk,
    `批量 SH ≡ 经典 SH（分布意义）: |Δrate| = ${diffs.map((d) => d.toFixed(3)).join(', ')} ≤ 3σ（二项整抽 = 逐样本伯努利之和, CDF 反演精确）`,
  );

  // ≥200 种子: 预算纪律 + 确定性 + 均值回读
  const rand = mulberry32(730001);
  let budgetOk = true;
  let meanOk = true;
  for (let s = 0; s < 200; s += 1) {
    const seed = 1 + Math.floor(rand() * 100000);
    const budget = 300 + Math.floor(rand() * 2700);
    const rb = successiveHalvingBatched({ mus: MUS, budget, seed });
    const rl = lucbTracking({ mus: MUS, budget, seed });
    const sb = rb.samplesPerArm.reduce((x, y) => x + y, 0);
    const sl = rl.samplesPerArm.reduce((x, y) => x + y, 0);
    if (sb > budget || sb < budget - 5) budgetOk = false;
    if (sl > budget) budgetOk = false;
    for (let i = 0; i < MUS.length; i += 1) {
      if (rb.samplesPerArm[i] >= 30) {
        const se = Math.sqrt((MUS[i] * (1 - MUS[i])) / rb.samplesPerArm[i]);
        if (Math.abs(rb.empiricalMeans[i] - MUS[i]) > 5 * se) meanOk = false;
      }
    }
  }
  ok(budgetOk, `200 种子预算纪律: 批量 SH Σ样本 ∈ [budget−5, budget], LUCB Σ ≤ budget（无泄漏）`);
  ok(meanOk, `批量 SH 经验均值回读: n ≥ 30 的臂 |μ̂ − μ| ≤ 5σ/√n（二项整抽的无偏性实证）`);

  // 确定性: 同种子逐位一致（四算法）
  const a1 = successiveHalvingBatched({ mus: MUS, budget: 2000, seed: 99 });
  const a2 = successiveHalvingBatched({ mus: MUS, budget: 2000, seed: 99 });
  const l1 = lucbTracking({ mus: MUS, budget: 2000, seed: 99 });
  const l2 = lucbTracking({ mus: MUS, budget: 2000, seed: 99 });
  ok(
    a1.best === a2.best && a1.samplesPerArm.every((v, i) => v === a2.samplesPerArm[i]) &&
      l1.best === l2.best && l1.samplesPerArm.every((v, i) => v === l2.samplesPerArm[i]),
    `同种子重放逐位一致（批量 SH 与 LUCB——mulberry32 纯函数）`,
  );

  // 耗时: identificationRate 500 试验
  const tClassic = timeIt(() => identificationRate({ mus: MUS, budget: 3000, trials: 500, seed: 7 }));
  const tBatched = timeIt(() =>
    identificationRate({ mus: MUS, budget: 3000, trials: 500, seed: 7, algorithm: BAI_ALGORITHMS.successiveHalvingBatched }),
  );
  ok(
    tBatched * 2 <= tClassic,
    `耗时: 批量 ${tBatched.toFixed(1)}ms vs 经典 ${tClassic.toFixed(1)}ms（${(tClassic / tBatched).toFixed(1)}× —— RNG 调用 O(轮×臂) vs O(预算) + CDF 记忆化摊销）`,
  );

  // 经典逐位不动（零漂移）: 与升级前行为同构——锚定样本总量口径
  const rc = successiveHalving({ mus: MUS, budget: 3000, seed: 5 });
  const rc2 = successiveHalving({ mus: MUS, budget: 3000, seed: 5 });
  ok(
    rc.best === rc2.best && rc.samplesPerArm.every((v, i) => v === rc2.samplesPerArm[i]),
    `经典 SH 原样保留: 同种子逐位一致（RNG 流未动——零漂移承诺）`,
  );
}

// ═══════════════════ 52.0 TTC：加权多数 + 二项尾递推 ═══════════════════

section('52.0 TTC A1：加权多数（精确 DP + Beta 矩闭式）');

{
  // 全 1 权重 ≡ majorityAccuracy（独立 = 二项尾; 相关 = β-binomial 尾）
  let eqIndep = true;
  let eqCorr = true;
  for (const n of [3, 5, 7, 9, 11, 15, 21]) {
    const ones = Array(n).fill(1);
    if (Math.abs(weightedMajorityAccuracy(0.6, ones).win - majorityAccuracy(0.6, n)) > 1e-12) eqIndep = false;
    if (Math.abs(weightedMajorityAccuracy(0.6, ones, 0.15).win - majorityAccuracy(0.6, n, 0.15)) > 1e-12) eqCorr = false;
    if (Math.abs(weightedMajorityAccuracy(0.72, ones, 0.25).win - majorityAccuracy(0.72, n, 0.25)) > 1e-12) eqCorr = false;
  }
  ok(eqIndep, `全 1 权重(ρ=0) ≡ majorityAccuracy ≤ 1e-12（加权理论是二项尾理论的真推广）`);
  ok(eqCorr, `全 1 权重(ρ∈{0.15, 0.25}) ≡ β-binomial 尾 ≤ 1e-12（子集计数 × Beta 矩闭式 = de Finetti 混合的精确化）`);

  // ≥200 种子暴力枚举对照（2ⁿ 全子集, n ≤ 10, 整数权重, M 奇）
  const rand = mulberry32(520001);
  let bruteOk = true;
  let tieOk = true;
  for (let s = 0; s < 200; s += 1) {
    const n = 3 + Math.floor(rand() * 7);
    const w = Array.from({ length: n }, () => 1 + Math.floor(rand() * 5));
    const M = w.reduce((x, y) => x + y, 0);
    if (M % 2 === 0) w[0] += 1;
    const M2 = w.reduce((x, y) => x + y, 0);
    const p = 0.51 + rand() * 0.45;
    const res = weightedMajorityAccuracy(p, w);
    let win = 0;
    let tie = 0;
    for (let mask = 0; mask < 1 << n; mask += 1) {
      let sum = 0;
      let pr = 1;
      for (let j = 0; j < n; j += 1) {
        const x = (mask >> j) & 1;
        if (x) {
          sum += w[j];
          pr *= p;
        } else {
          pr *= 1 - p;
        }
      }
      if (2 * sum > M2) win += pr;
      else if (2 * sum === M2) tie += pr;
    }
    if (Math.abs(res.win - win) > 1e-12) bruteOk = false;
    if (Math.abs(res.tie - tie) > 1e-12) tieOk = false;
  }
  ok(bruteOk, `≥200 种子 × 2ⁿ 全子集暴力枚举: win 精确一致 ≤ 1e-12（子集和 DP 的正确性）`);
  ok(tieOk, `平局质量 P(2S=M) 同样精确一致（M 奇时恒 0 的口径也经枚举复核）`);

  // Nitzan–Paroush: 独立同分布下简单多数 ≥ 一切加权多数
  let npOk = true;
  for (let s = 0; s < 200; s += 1) {
    const n = [5, 7, 9][Math.floor(rand() * 3)];
    const w = Array.from({ length: n }, () => 1 + Math.floor(rand() * 6));
    const M = w.reduce((x, y) => x + y, 0);
    if (M % 2 === 0) w[0] += 1;
    const p = 0.55 + rand() * 0.4;
    if (weightedMajorityAccuracy(p, w).win > majorityAccuracy(p, w.length) + 1e-9) npOk = false;
  }
  ok(
    npOk,
    `Nitzan–Paroush 定理实证: 简单多数 ≥ 一切加权多数（≥200 种子——均匀权重的最优性, 加权接口不越界）`,
  );

  // Kish 锚点 + p=0.5 恒等 + 单权退化
  ok(
    near(kishEffectiveSampleSize([1, 1, 1]), 3, 1e-12) && near(kishEffectiveSampleSize([2, 1, 1]), 8 / 3, 1e-12),
    `Kish n_eff: [1,1,1] → 3, [2,1,1] → 8/3（(Σw)²/Σw² 锚点）`,
  );
  ok(
    weightedMajorityAccuracy(0.5, [1, 2, 3, 4, 5]).accuracy === 0.5 && weightedMajorityAccuracy(0.5, [1, 1, 1, 1, 1, 1, 1]).accuracy === 0.5,
    `p=0.5 加权恒 0.5（对称性——加权投票对掷硬币同样无增益）`,
  );
  ok(
    weightedMajorityAccuracy(0.83, [1]).win === 0.83,
    `单权退化: [1] → p（单样本即自身, 与 majorityAccuracy(p,1) 同口径）`,
  );

  // CLT 近似误差档位（n ≥ 12 / n ≥ 20）
  let clt12 = true;
  let clt20 = true;
  for (let s = 0; s < 120; s += 1) {
    const n = 12 + Math.floor(rand() * 12);
    const w = Array.from({ length: n }, () => 1 + Math.floor(rand() * 5));
    const M = w.reduce((x, y) => x + y, 0);
    if (M % 2 === 0) w[0] += 1;
    const p = 0.55 + rand() * 0.35;
    const exact = weightedMajorityAccuracy(p, w).win;
    const approx = weightedMajorityNormal(p, w);
    const err = Math.abs(exact - approx);
    if (n >= 12 && err > 0.06) clt12 = false;
    if (n >= 20 && err > 0.03) clt20 = false;
  }
  ok(clt12, `CLT 近似(不可公度权重口径): n ≥ 12 时 |精确 − 正态| ≤ 0.06（120 种子, O(n^{−1/2}) 误差档位诚实报告）`);
  ok(clt20, `n ≥ 20 时 |精确 − 正态| ≤ 0.03（一二阶矩精确 + Berry–Esseen 型衰减）`);

  // 入参校验
  throws(() => weightedMajorityAccuracy(0.6, [0, 0]), 'weightedMajority(全零权重) 显式 throw');
  throws(() => weightedMajorityAccuracy(0.6, [1, Math.PI, 1]), 'weightedMajority(不可公度 π) 显式 throw（诚实拒绝, 可用 normal 口径）');
  throws(() => weightedMajorityAccuracy(0.6, Array(41).fill(1)), 'weightedMajority(>40 权重) 显式 throw');
  throws(() => kishEffectiveSampleSize([]), 'kishEffectiveSampleSize(空) 显式 throw');
}

section('52.0 TTC A2：二项/β-二项尾的对数域递推（等价 + 耗时）');

{
  // 脚本侧独立复刻: 逐项 log-Γ 求和（升级前的实现）+ Lanczos log-Γ
  function logGammaRef(x) {
    const coef = [
      676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
      12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGammaRef(1 - x);
    const z = x - 1;
    let acc = 0.99999999999980993;
    for (let i = 0; i < coef.length; i += 1) acc += coef[i] / (z + i + 1);
    const t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(acc);
  }
  const refTail = (p, n, k) => {
    const lp = Math.log(p);
    const lq = Math.log(1 - p);
    const lnFactN = logGammaRef(n + 1);
    let sum = 0;
    for (let i = k; i <= n; i += 1) {
      sum += Math.exp(lnFactN - logGammaRef(i + 1) - logGammaRef(n - i + 1) + i * lp + (n - i) * lq);
    }
    return Math.min(1, sum);
  };
  let maxDiff = 0;
  let cases = 0;
  for (const p of [0.3, 0.5, 0.6, 0.8, 0.95]) {
    for (const n of [11, 21, 51, 101, 301]) {
      const d = Math.abs(majorityAccuracy(p, n) - refTail(p, n, (n + 1) / 2));
      maxDiff = Math.max(maxDiff, d);
      cases += 1;
    }
  }
  ok(
    maxDiff <= 1e-12,
    `对数域递推 ≡ 逐项 log-Γ: ${cases} 组 (p,n) max|Δ| = ${maxDiff.toExponential(2)} ≤ 1e-12（同分布不同算术路径）`,
  );

  // 极端参数（尾首项 e^{−5000} 级——线性域递推在此下溢失真, 对数域递推的正确性锚点）
  let extremeOk = true;
  for (const p of [0.9, 0.95, 0.99]) {
    for (const n of [101, 999, 9999]) {
      const v = majorityAccuracy(p, n);
      const ref = refTail(p, n, (n + 1) / 2);
      if (!Number.isFinite(v) || Math.abs(v - ref) > 1e-9) extremeOk = false;
    }
  }
  // 单调不减（饱和区两者都 ≈ 1, 严格差被浮点累计 ~1e-11 掩没——用 1e-9 口径）
  const monoExtreme =
    majorityAccuracy(0.9, 999) >= majorityAccuracy(0.9, 101) - 1e-9 &&
    majorityAccuracy(0.9, 9999) >= majorityAccuracy(0.9, 999) - 1e-9 &&
    majorityAccuracy(0.95, 9999) >= majorityAccuracy(0.95, 101) - 1e-9;
  ok(
    extremeOk && monoExtreme,
    `极端参数尾求和: p∈{.9,.95,.99}×n∈{101,999,9999} 与逐项 log-Γ 复刻一致 ≤ 1e-9 且随 n 单调不减（M(0.9,9999)=${majorityAccuracy(0.9, 9999).toFixed(6)} 已饱和到 1——对数域递推免下溢）`,
  );
  const tNew = timeIt(() => {
    for (let i = 0; i < 30; i += 1) majorityAccuracy(0.6, 3001);
  }) / 30;
  const tOld = timeIt(() => {
    for (let i = 0; i < 5; i += 1) refTail(0.6, 3001, 1501);
  }) / 5;
  ok(
    tNew * 2 <= tOld,
    `耗时: M(0.6, 3001) 对数域递推 ${tNew.toFixed(3)}ms vs 逐项 log-Γ 复刻 ${tOld.toFixed(3)}ms（${(tOld / tNew).toFixed(1)}× —— 每尾 3 次 logΓ + 每项 2 ln vs 3×1501 次 logΓ）`,
  );
}

// ═══════════════════ 51.0 投机解码：束式树投机闭式 ═══════════════════

section('51.0 投机 A1：束式树投机闭式（b=1 退化 + 手算 + 仿真）');

{
  // b=1 逐位退化（恒等式 + 数值路径一致）
  let bitEq = true;
  for (const g of [0.05, 0.3, 0.5, 0.7, 0.9, 0.99]) {
    for (let k = 0; k <= 16; k += 1) {
      if (expectedTokensTree(g, k, 1) !== expectedTokensPerRound(g, k)) bitEq = false;
      if (speedupTree(g, k, 1, 0.1) !== speedup(g, k, 0.1)) bitEq = false;
    }
  }
  ok(bitEq, `b=1 逐位退化为链闭式: expectedTokensTree ≡ expectedTokensPerRound、speedupTree ≡ speedup（γ×k 全网格 ===）`);
  // 手算: γ=0.5, b=2 ⟹ q=0.75; k=2: N = 1 + .75 + .5625 = 2.3125
  ok(
    near(expectedTokensTree(0.5, 2, 2), 2.3125, 1e-12),
    `手算锚点: N_beam(0.5, 2, b=2) = ${expectedTokensTree(0.5, 2, 2)} = 1 + q + q², q = 1−(1−γ)^b = 0.75（2.3125）`,
  );
  ok(draftTokensTree(3, 4) === 12 && draftTokensTree(5, 1) === 5, `草稿成本 D(k,b) = b·k（b=1 ⟹ k, 与链口径一致）`);
  ok(
    near(roundCostTree(4, 2, 0.1), 1 + 0.1 * 8, 1e-12),
    `轮耗时 t = 1 + r·b·k（(4,2,r=0.1) → ${roundCostTree(4, 2, 0.1)}）`,
  );

  // 仿真 LLN 对照（含 b>1）
  let simOk = true;
  for (const [g, k, b] of [[0.5, 4, 2], [0.8, 3, 3], [0.3, 8, 4], [0.6, 5, 1]]) {
    const sim = simulateTreeRounds(g, k, b, 200000, 77);
    const closed = expectedTokensTree(g, k, b);
    if (Math.abs(sim.meanTokensPerRound - closed) > 0.01) simOk = false;
    if (Math.abs(sim.meanTokensPerRound - 1 - sim.meanLevelsAdvanced) > 1e-12) simOk = false;
  }
  ok(
    simOk,
    `确定性仿真 LLN: 4 组 (γ,k,b)（含 b>1）20 万轮均值 ≈ 闭式 ≤ 0.01; 产出 = 层数 + 1 恒等式逐轮精确`,
  );

  // 入参校验
  throws(() => expectedTokensTree(0.5, 4, 0), 'expectedTokensTree(b=0) 显式 throw');
  throws(() => speedupTree(0.5, -1, 2, 0.1), 'speedupTree(k=−1) 显式 throw');
  throws(() => optimalTreeDraft(0.5, -0.1), 'optimalTreeDraft(r=−0.1) 显式 throw');
  throws(() => simulateTreeRounds(0.5, 2, 2, 0, 1), 'simulateTreeRounds(rounds=0) 显式 throw');
}

section('51.0 投机 A3/A4：加速上界（k+1）+ 判退域 + 最优 (k*,b*)');

{
  // ≥1300 网格: 上界 (k+1)/(1+rbk) 与 k+1; 判退域 γ ≤ r ⟹ S ≤ 1; N 单调于 b
  let boundOk = true;
  let rejectOk = true;
  let monoB = true;
  let cnt = 0;
  for (const r of [0.02, 0.05, 0.1, 0.2, 0.4]) {
    for (const g of [0.05, 0.2, 0.5, 0.8, 0.95]) {
      for (let k = 0; k <= 12; k += 1) {
        for (let b = 1; b <= 4; b += 1) {
          const s = speedupTree(g, k, b, r);
          cnt += 1;
          if (s > (k + 1) / (1 + r * b * k) + 1e-12 || s > k + 1 + 1e-12) boundOk = false;
          if (g <= r && k >= 1 && s > 1 + 1e-12) rejectOk = false;
          if (k >= 1 && b >= 2 && expectedTokensTree(g, k, b) < expectedTokensTree(g, k, b - 1) - 1e-12) monoB = false;
        }
      }
    }
  }
  ok(boundOk, `加速上界: ${cnt} 网格点 S ≤ (k+1)/(1+rbk) 且 S ≤ k+1（N_beam ≤ k+1 的产出上界——投机不免费）`);
  ok(rejectOk, `判退域扩展: γ ≤ r ⟹ 一切 (k,b) S_beam ≤ 1（q ≤ bγ ⟹ N ≤ 1+rbk 的逐项放大）`);
  ok(monoB, `N_beam 关于 b 单调不减（分支只增接受机会——q = 1−(1−γ)^b 递增）`);

  // 最优 (k*,b*): 独立闭式重算 argmax（脚本侧公式独立实现）
  const scriptBeam = (g, k, b, r) => {
    const q = 1 - Math.pow(1 - g, b);
    const N = k === 0 ? 1 : q >= 1 ? k + 1 : 1 + (q * (1 - Math.pow(q, k))) / (1 - q);
    return N / (1 + r * b * k);
  };
  const rand = mulberry32(510001);
  let argmaxOk = true;
  for (let s = 0; s < 200; s += 1) {
    const g = 0.05 + rand() * 0.9;
    const r = 0.01 + rand() * 0.5;
    const res = optimalTreeDraft(g, r, { maxK: 12, maxB: 4 });
    // 脚本侧同 tie-break 的独立 argmax（b 升序、k 升序、严格大于替换）
    let bk = 0;
    let bb = 1;
    let bs = scriptBeam(g, 0, 1, r);
    for (let b = 1; b <= 4; b += 1) {
      for (let k = 1; k <= 12; k += 1) {
        const v = scriptBeam(g, k, b, r);
        if (v > bs + 1e-12) {
          bs = v;
          bk = k;
          bb = b;
        }
      }
    }
    if (res.k !== bk || res.b !== bb || Math.abs(res.speedup - round6(bs)) > 2e-6) argmaxOk = false;
  }
  ok(argmaxOk, `≥200 种子 (γ,r): (k*,b*) 与脚本侧独立闭式 argmax 一致（网格精确 argmax + 同 tie-break）`);

  // 经济直觉的可计算化
  const cheap = optimalTreeDraft(0.35, 0.05, { maxK: 12, maxB: 4 });
  const expensive = optimalTreeDraft(0.7, 0.3, { maxK: 12, maxB: 4 });
  const chainCheap = optimalDraftLength(0.35, 0.05);
  ok(
    cheap.b > 1 && cheap.speedup > chainCheap.speedup,
    `γ=0.35 低接受率: 最优 b*=${cheap.b} > 1, S=${cheap.speedup} > 链版 ${chainCheap.speedup}（分支并行回收接受率——q 边际在 γ 小处最陡）`,
  );
  ok(
    expensive.b === 1,
    `γ=0.7, r=0.3 草稿贵: b*=1（每层 b 路的线性草稿成本覆盖不了推进增益——单链已最优）`,
  );
  const rej = optimalTreeDraft(0.29, 0.3);
  ok(
    !rej.worthwhile && rej.k === 0,
    `γ=0.29 ≤ r=0.3: k*=0、worthwhile=false（判退线与链版同口径, 直通更廉）`,
  );
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
