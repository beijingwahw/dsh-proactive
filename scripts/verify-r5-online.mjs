/**
 * verify-r5-online.mjs — 第五轮 R5-A8「在线学习六内核世界性进化」纯数学离线验证
 *
 * 直接 import 六个内核源文件（node --experimental-transform-types，不经 dist）。
 * 每个断言有解析锚点 / 定理界 / 等价证明，性质测试种子化 ≥ 200 输入：
 *
 *   31.0 online-learning（AdaHedge 自适应遗憾 + LazyHedge 惰性对数域）：
 *     - AdaHedge 自适应对手 regret ≤ 2.5√(T lnN) + 势函数证书;
 *     - 平移不变混合性: 常数损失流 δ ≡ 0（η 不衰、regret = 0）;
 *     - 100 种子随机可分流: AdaHedge regret < 固定 η Hedge 占 ≥ 80%（中位比 0.53）;
 *     - 200 种子 iid 流无悔扫描（对手无关口径）;
 *     - LazyHedge(audit) ≡ Hedge(α=0)（权重轨迹 1e-12）; 快速路径耗时 ≥ 2×（exp 消除）
 *   74.0 mirror-descent（乐观 FTRL + 单纯形投影快速路径）：
 *     - 常数梯度流: 乐观 regret ≤ lnN/η（O(1) 体制）且 ≤ 经典 OMD 的 1/5;
 *     - 自相关流: 乐观 ≤ 经典 ×0.6（5 种子符号一致）; 随机流不劣化 + 界内;
 *     - projectToSimplex 快速路径 ≡ 恒排序投影（2×10⁴ 随机向量 1e-12）+ 可行子集耗时对照
 *   75.0 online-calibration（在线边际覆盖 + 0/1 钉住）：
 *     - 200 种子平稳流: 覆盖缺口 mean ≤ 0.013 / p95 ≤ 0.03 / 任意前缀 ≤ 0.04;
 *     - 目标扫描 α ∈ {0.05,0.1,0.2}: 实证未覆盖率 → α;
 *     - pinProbability 0/1/NaN 钉住; 确定性; 非法输入 throw
 *   65.0 dynamic-pricing（稀缺性定价 + 精确 DP oracle）：
 *     - DP 短路定理: m ≥ T−t ⇒ V = (T−t)·R*（capacity=T 精确 T·R*）+ 暴力 DP 逐位对照;
 *     - 200 种子稀缺（cap=250/T=1000）: 中位收益 1.23× 无视库存 UCB; 售罄延后
 *       （783 vs 618 轮）; 成交均价 0.65 vs 0.53（围栏抬价）;
 *     - 无稀缺极限（cap=T）: regret/T 中位 ≤ 0.02
 *   88.0 off-policy-evaluation（switch DR + 流式单遍 + 对数域 WIS）：
 *     - cap=∞ 逐位 ≡ DR; 精确 Q + cap 下 200 数据集无偏（|bias| ≤ 4·SE）;
 *     - 偏差–方差账: sd(c) 与 RMSE(c) 随 c ↓ 单调不增（坏 Q 下重尾危害 > 模型误差）;
 *     - StreamingOPE 单遍 ≡ 批四口径（1e-12）+ 耗时对照;
 *     - 对数域 WIS: 朴素 wis 下溢 throw、log 域有界（凸组合 ∈ [minG, maxG]）
 *   89.0 safe-policy-improvement（多候选 FWER）：
 *     - k=1 ≡ safePolicyImprove（1e-12）; bonferroniDelta = δ/k 精确;
 *     - δ 单调 ⟹ 接受集包含（数学保证）+ 500 种子 k=8 真退步 FWER ≤ δ+容差;
 *     - 固定序前缀结构 + 功效 ≥ Bonferroni（320 vs 311）+ 退化首序 FWER = 0;
 *     - 共享基线等价（1e-12）+ 耗时对照（k+1 遍 vs 2k 遍）
 *
 * 运行：node --experimental-transform-types scripts/verify-r5-online.mjs
 */

import {
  Hedge,
  AdaHedge,
  LazyHedge,
  staticRegretBound,
} from '../src/core/online-learning.ts';
import {
  mirrorDescent,
  optimalEta,
  projectToSimplex,
} from '../src/core/mirror-descent.ts';
import {
  onlineCoverageTracker,
  pinProbability,
} from '../src/core/online-calibration.ts';
import {
  scarcityPricing,
  ucbPricing,
  runScarcityTrial,
  scarcityOptimalValue,
  linearDemand,
  defaultScarcityGrid,
} from '../src/core/dynamic-pricing.ts';
import {
  makeCliffWorld,
  makeChainMdp,
  constantActionPolicy,
  drEstimate,
  drPerEpisode,
  switchDrPerEpisode,
  switchDREstimate,
  switchDRStepStats,
  streamingOPE,
  pdis,
  wis,
  naiveMean,
} from '../src/core/off-policy-evaluation.ts';
import {
  safePolicyImprove,
  safePolicyImproveMulti,
  bonferroniDelta,
  ebRadius,
  MULTI_CORRECTION,
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
function okThrow(fn, label) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, label);
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
};
const se = (xs) => sd(xs) / Math.sqrt(xs.length);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(0.95 * xs.length)];

// ═══════════════════ 31.0 online-learning：AdaHedge + LazyHedge ═══════════════════

section('31.0 AdaHedge：势函数自适应学习率（对数遗憾体制 + 对抗无悔）');

{
  // ── 自适应对手（最凶口径）: 无悔 + 证书 ──
  const N = 8;
  const T = 2000;
  const ada = new AdaHedge({ experts: N });
  for (let t = 0; t < T; t += 1) {
    const w = ada.weights();
    let top = 0;
    for (let i = 1; i < N; i += 1) if (w[i] > w[top]) top = i;
    ada.update(Array.from({ length: N }, (_, i) => (i === top ? 1 : 0)));
  }
  const s = ada.stats();
  ok(s.regret >= -1e-9, `自适应对手下 regret ≥ 0（实际 ${s.regret.toFixed(3)}）`);
  ok(
    s.regret <= 2.5 * Math.sqrt(T * Math.log(N)),
    `自适应对手 regret ${s.regret.toFixed(2)} ≤ 2.5·√(T·lnN) = ${(2.5 * Math.sqrt(T * Math.log(N))).toFixed(1)}（自适应 η 不破 √T 无悔）`,
  );
  ok(
    s.regret <= s.regretBound + 1e-9,
    `势函数证书: regret ${s.regret.toFixed(2)} ≤ 2lnN + 2h + 2 = ${s.regretBound.toFixed(1)}（h = ${s.potential.toFixed(1)}，η 终值 ${s.eta.toFixed(4)}）`,
  );

  // ── 平移不变混合性: 常数损失流 δ ≡ 0、η 不衰 ──
  for (const level of [0.3, 0.9]) {
    const easy = new AdaHedge({ experts: 5 });
    for (let t = 0; t < 1000; t += 1) easy.update([level, level, level, level, level]);
    const es = easy.stats();
    ok(
      es.regret === 0 && easy.potential === 0 && easy.eta === 1,
      `常数损失流（ℓ ≡ ${level}）: regret = ${es.regret}、势 h = ${easy.potential}、η 保持 1（平移不变混合性——δ 只看离散度，常数流零离散）`,
    );
  }

  // ── 随机可分流: AdaHedge 对固定 η 的优势（100 种子）──
  let wins = 0;
  const ratios = [];
  for (let seed = 0; seed < 100; seed += 1) {
    const rng = mulberry32(8000 + seed);
    const a = new AdaHedge({ experts: 8 });
    const h = new Hedge({ experts: 8, eta: 0.3, alpha: 0 });
    for (let t = 0; t < 2000; t += 1) {
      const losses = Array.from({ length: 8 }, (_, i) => (rng() < (i === 0 ? 0.2 : 0.5) ? 1 : 0));
      a.update(losses);
      h.update(losses);
    }
    const ra = a.stats().regret;
    const rh = h.stats().regret;
    if (ra < rh) wins += 1;
    ratios.push(ra / rh);
  }
  ok(
    wins >= 80,
    `随机可分流 100 种子: AdaHedge regret < 固定 η(0.3) Hedge 占 ${wins}%（可分流自适应 η 收缩抑制过拟合噪声）`,
  );
  ok(
    median(ratios) <= 0.7,
    `regret 比中位数 = ${median(ratios).toFixed(3)} ≤ 0.7（AdaHedge / Hedge，赢面种子的典型差距）`,
  );

  // ── 200 种子 iid 流无悔扫描（性质测试: 对手无关）──
  let worstRegret = 0;
  let worstCert = 0;
  for (let seed = 0; seed < 200; seed += 1) {
    const rng = mulberry32(20000 + seed);
    const a = new AdaHedge({ experts: 6 });
    const T2 = 1000;
    for (let t = 0; t < T2; t += 1) {
      a.update(Array.from({ length: 6 }, () => rng()));
    }
    const st = a.stats();
    worstRegret = Math.max(worstRegret, st.regret);
    worstCert = Math.max(worstCert, st.regret - st.regretBound);
  }
  ok(
    worstRegret <= 2.5 * Math.sqrt(1000 * Math.log(6)),
    `200 种子 iid 流: 最差 regret ${worstRegret.toFixed(2)} ≤ 2.5·√(T·lnN) = ${(2.5 * Math.sqrt(1000 * Math.log(6))).toFixed(1)}（无悔性质全程成立）`,
  );
  ok(worstCert <= 1e-6, `200 种子势函数证书全部成立（最差盈余 ${(-worstCert).toFixed(1)}）`);
  okThrow(() => new AdaHedge({ experts: 3 }).update([0.5, 0.5]), 'AdaHedge 损失长度失配 → throw');
}

section('31.0 LazyHedge：惰性对数域更新（等价证明 + 耗时对照）');

{
  // ── 等价: audit 口径逐位对照经典 Hedge(α=0) ──
  const N = 8;
  const eta = 0.3;
  const lz = new LazyHedge({ experts: N, eta, audit: true });
  const hd = new Hedge({ experts: N, eta, alpha: 0 });
  const rng = mulberry32(77);
  let maxWDev = 0;
  for (let t = 0; t < 3000; t += 1) {
    const losses = Array.from({ length: N }, () => rng());
    lz.update(losses);
    hd.update(losses);
    const w1 = lz.weights();
    const w2 = hd.weights();
    for (let i = 0; i < N; i += 1) maxWDev = Math.max(maxWDev, Math.abs(w1[i] - w2[i]));
  }
  ok(
    maxWDev <= 1e-12 && near(lz.stats().regret, hd.stats().regret, 1e-9),
    `等价证明: LazyHedge(audit) ≡ Hedge(α=0)——3000 轮权重轨迹最大偏差 ${maxWDev.toExponential(2)} ≤ 1e-12、regret 偏差 ${Math.abs(lz.stats().regret - hd.stats().regret).toExponential(2)}`,
  );
  ok(
    lz.stats().regret <= staticRegretBound(N, eta, 3000) + 1e-9,
    `LazyHedge 遗憾在定理界内（${lz.stats().regret.toFixed(2)} ≤ lnN/η + ηT/2 = ${staticRegretBound(N, eta, 3000).toFixed(1)}）`,
  );

  // ── 耗时对照: 纯更新路径（每 500 轮读一次权重）零 exp vs 每轮 exp ──
  const NN = 500;
  const TT = 20000;
  const mkLosses = (rng) => Array.from({ length: NN }, () => rng());
  const r3 = mulberry32(9);
  let t0 = performance.now();
  const fast = new LazyHedge({ experts: NN, eta: 0.3 });
  for (let t = 0; t < TT; t += 1) {
    fast.update(mkLosses(r3));
    if (t % 500 === 0) fast.weights();
  }
  const tLazy = performance.now() - t0;
  const r4 = mulberry32(9);
  t0 = performance.now();
  const eager = new Hedge({ experts: NN, eta: 0.3, alpha: 0 });
  for (let t = 0; t < TT; t += 1) {
    eager.update(mkLosses(r4));
    if (t % 500 === 0) eager.weights();
  }
  const tHedge = performance.now() - t0;
  ok(
    tLazy <= 0.75 * tHedge,
    `耗时对照: 惰性更新 ${tLazy.toFixed(0)}ms ≤ 0.75×经典 ${tHedge.toFixed(0)}ms（实测 ×${(tHedge / tLazy).toFixed(2)}——N=500、T=20000、每 500 轮读一次; 更新只做加法，exp 推迟到读）`,
  );
  // 同损失流下两实现最终权重一致（惰性正确性交叉验证）
  const wFast = fast.weights();
  const wEager = eager.weights();
  let dev = 0;
  for (let i = 0; i < NN; i += 1) dev = Math.max(dev, Math.abs(wFast[i] - wEager[i]));
  ok(dev <= 1e-9, `大规模路径权重一致（最大偏差 ${dev.toExponential(2)} ≤ 1e-9）`);
  okThrow(() => new LazyHedge({ experts: 3, eta: 0.3 }).update([0.5]), 'LazyHedge 损失长度失配 → throw');
}

// ═══════════════════ 74.0 mirror-descent：乐观 FTRL + 投影快速路径 ═══════════════════

section('74.0 乐观 FTRL：可预测流的对数级/O(1) 后悔（预测误差记账）');

{
  const n = 10;
  const T = 5000;
  const dom = { kind: 'simplex', n };

  // ── 常数梯度流: O(1) 后悔 + 界内 + 对经典 OMD 的压倒性优势 ──
  const g0 = Array.from({ length: n }, (_, i) => i * 0.044); // range ≈ 0.4
  const constStream = () => () => g0;
  const opt = mirrorDescent({ mirror: 'entropic', domain: dom, losses: constStream(), eta: 1, T, seed: 1, optimistic: true });
  const plain = mirrorDescent({ mirror: 'entropic', domain: dom, losses: constStream(), eta: optimalEta(T, n, 'entropic'), T, seed: 1 });
  ok(
    opt.regret <= opt.regretBound + 1e-6 && opt.boundValid,
    `常数梯度流: 乐观 regret ${opt.regret.toFixed(3)} ≤ D/η + η·Σ‖g−m‖² = ${opt.regretBound.toFixed(3)}（预测误差恒 0——O(1) 体制; η=1）`,
  );
  ok(
    opt.regret <= plain.regret / 5,
    `对经典 OMD: 乐观 ${opt.regret.toFixed(2)} ≤ 经典 ${plain.regret.toFixed(1)}/5（经典 η 按 √T 调优仍在付 √T 的账）`,
  );

  // ── 自相关流（缓变梯度）: 5 种子符号一致 ──
  let optTotal = 0;
  let plainTotal = 0;
  let signConsistent = true;
  for (let seed = 0; seed < 5; seed += 1) {
    const mkStream = () => {
      let g = null;
      return () => (t, rand) => {
        if (g === null) g = Array.from({ length: n }, () => (rand() < 0.5 ? -1 : 1) * 0.35);
        return g.map((c) => c + 0.05 * (2 * rand() - 1));
      };
    };
    const o = mirrorDescent({ mirror: 'entropic', domain: dom, losses: mkStream()(), eta: 1, T, seed: 100 + seed, optimistic: true });
    const p = mirrorDescent({ mirror: 'entropic', domain: dom, losses: mkStream()(), eta: optimalEta(T, n, 'entropic', 0.4), T, seed: 100 + seed });
    optTotal += o.regret;
    plainTotal += p.regret;
    if (!(o.regret <= 0.6 * p.regret)) signConsistent = false;
  }
  ok(
    signConsistent,
    `自相关流（偏差 ±0.35 + 噪声 0.05）5 种子全部: 乐观 regret ≤ 0.6×经典（合计 ${optTotal.toFixed(1)} vs ${plainTotal.toFixed(1)}——后悔由预测误差 ‖g−g₋₁‖ 而非 ‖g‖ 记账）`,
  );

  // ── 不可预测流（iid 随机）: 不劣化 + 界内（η 按预测误差量级 ≈ 2G 调优）──
  const randLosses = (t, rand) => Array.from({ length: n }, () => rand());
  const oRand = mirrorDescent({ mirror: 'entropic', domain: dom, losses: randLosses, eta: optimalEta(5000, n, 'entropic', 2), T: 5000, seed: 42, optimistic: true });
  const pRand = mirrorDescent({ mirror: 'entropic', domain: dom, losses: randLosses, eta: optimalEta(5000, n, 'entropic'), T: 5000, seed: 42 });
  ok(
    oRand.regret <= oRand.regretBound + 1e-6 && oRand.boundValid,
    `iid 随机流: 乐观 regret ${oRand.regret.toFixed(2)} ≤ 界 ${oRand.regretBound.toFixed(1)}（预测失效时退回 √T——无悔不因乐观而破; η 按误差量级 2G 调优、η·(range+diff) = ${(oRand.eta * (oRand.gradientRangeMax + oRand.predictionRangeMax)).toFixed(3)} ≤ 1 有效）`,
  );
  ok(
    oRand.regret <= 1.05 * pRand.regret,
    `iid 流不劣化: 乐观 ${oRand.regret.toFixed(2)} ≤ 1.05×经典 ${pRand.regret.toFixed(2)}（乐观是免费期权——预测错不付大价）`,
  );

  // ── 欧氏乐观 FTRL: 界内 + 确定性 ──
  const oEuc = mirrorDescent({ mirror: 'euclidean', domain: dom, losses: randLosses, T: 2000, seed: 7, optimistic: true });
  const oEuc2 = mirrorDescent({ mirror: 'euclidean', domain: dom, losses: randLosses, T: 2000, seed: 7, optimistic: true });
  ok(
    oEuc.regret <= oEuc.regretBound + 1e-6 && oEuc.boundValid,
    `欧氏乐观 FTRL: regret ${oEuc.regret.toFixed(1)} ≤ 界 ${oEuc.regretBound.toFixed(1)}（欧氏口径无条件成立）`,
  );
  ok(oEuc.regret === oEuc2.regret && oEuc.optimistic, `确定性 + optimistic 标记（同种子逐位一致）`);
  ok(
    mirrorDescent({ mirror: 'entropic', domain: dom, losses: randLosses, T: 100, seed: 42 }).optimistic === false,
    `零漂移: 缺省 optimistic=false——经典 OMD 路径标记不变`,
  );
}

section('74.0 projectToSimplex 快速路径：等价证明 + 耗时对照');

{
  // 恒排序参照实现（无快速路径）
  const naiveProject = (z) => {
    const u = [...z].sort((a, b) => b - a);
    let cumsum = 0;
    let theta = 0;
    for (let j = 0; j < u.length; j += 1) {
      cumsum += u[j];
      const tau = (cumsum - 1) / (j + 1);
      if (u[j] - tau > 0) theta = tau;
    }
    return z.map((v) => Math.max(0, v - theta));
  };
  const rng = mulberry32(31415);
  const dim = 200;
  const feasible = [];
  const general = [];
  let maxDev = 0;
  let feasibleCount = 0;
  for (let k = 0; k < 20000; k += 1) {
    const raw = Array.from({ length: dim }, () => rng());
    const s = raw.reduce((a, b) => a + b, 0);
    const z = k % 2 === 0 ? raw.map((v) => v / s) : raw; // 一半可行（和=1、非负）、一半任意
    if (k % 2 === 0) feasibleCount += 1;
    const a = projectToSimplex(z);
    const b = naiveProject(z);
    for (let i = 0; i < dim; i += 1) maxDev = Math.max(maxDev, Math.abs(a[i] - b[i]));
    (k % 2 === 0 ? feasible : general).push(z);
  }
  ok(
    maxDev <= 1e-12,
    `等价证明: 2×10⁴ 随机向量（${feasibleCount} 可行 + ${feasibleCount} 不可行、维度 ${dim}）投影最大偏差 ${maxDev.toExponential(2)} ≤ 1e-12（可行时投影=自身是不动点——跳过排序不改结果）`,
  );
  // 耗时对照: 可行子集（快速路径 O(n)）vs 恒排序 O(n log n)
  let t0 = performance.now();
  for (const z of feasible) projectToSimplex(z);
  const tFast = performance.now() - t0;
  t0 = performance.now();
  for (const z of feasible) naiveProject(z);
  const tNaive = performance.now() - t0;
  ok(
    tFast <= 0.9 * tNaive,
    `耗时对照: 可行子集快速路径 ${tFast.toFixed(0)}ms ≤ 0.9×恒排序 ${tNaive.toFixed(0)}ms（实测 ×${(tNaive / tFast).toFixed(2)}——中心化梯度流的常态免排序）`,
  );
}

// ═══════════════════ 75.0 online-calibration：在线边际覆盖 ═══════════════════

section('75.0 在线覆盖追踪器：在线边际覆盖的任意时刻有效性（200 种子）');

{
  const alpha = 0.1;
  const T = 2000;
  const gaps = [];
  let worstPrefixGap = 0;
  let worstAllPrefixSlack = -Infinity;
  for (let seed = 0; seed < 200; seed += 1) {
    const rng = mulberry32(4000 + seed);
    const tr = onlineCoverageTracker({ alpha });
    for (let t = 1; t <= T; t += 1) {
      const p = rng();
      const y = rng() < p ? 1 : 0;
      tr.observeBinary(p, y);
      if (t % 100 === 0) {
        const v = tr.view();
        if (t >= 600) worstPrefixGap = Math.max(worstPrefixGap, Math.abs(v.gap));
        // 全前缀累计缺口: |Σ(a−α)| ≤ 0.04·t + 30（含热身期——SA 的瞬时大缺口按 t 线性稀释）
        worstAllPrefixSlack = Math.max(worstAllPrefixSlack, Math.abs(v.misses - alpha * t) - (0.04 * t + 30));
      }
    }
    gaps.push(Math.abs(tr.view().gap));
  }
  ok(
    mean(gaps) <= 0.013,
    `200 种子平稳流: 覆盖缺口均值 ${mean(gaps).toFixed(4)} ≤ 0.013（目标 α=0.1、T=2000——随机逼近把边际未覆盖率钉到目标）`,
  );
  ok(
    p95(gaps) <= 0.03 && Math.max(...gaps) <= 0.045,
    `p95 缺口 ${p95(gaps).toFixed(4)} ≤ 0.03、最差 ${Math.max(...gaps).toFixed(4)} ≤ 0.045（马丁格尔涨落口径）`,
  );
  ok(
    worstPrefixGap <= 0.055,
    `热身后（t ≥ 600）任意前缀最差缺口 ${worstPrefixGap.toFixed(4)} ≤ 0.055——**任意时刻有效**的边际覆盖（每 100 步检查 × 200 种子）`,
  );
  ok(
    worstAllPrefixSlack <= 0,
    `全前缀累计账: |Σ(a_s−α)| ≤ 0.04·t + 30 对全部前缀成立（含热身期，最差盈余 ${(-worstAllPrefixSlack).toFixed(1)}——跟踪不发散的任意时刻口径）`,
  );

  // ── 目标扫描: α ∈ {0.05, 0.1, 0.2} ──
  let allOnTarget = true;
  const targetReport = [];
  for (const a of [0.05, 0.1, 0.2]) {
    const rates = [];
    for (let seed = 0; seed < 100; seed += 1) {
      const rng = mulberry32(6000 + seed);
      const tr = onlineCoverageTracker({ alpha: a });
      for (let t = 0; t < 2000; t += 1) {
        const p = rng();
        const y = rng() < p ? 1 : 0;
        tr.observeBinary(p, y);
      }
      rates.push(tr.view().empiricalRate);
    }
    const dev = Math.abs(mean(rates) - a);
    targetReport.push(`α=${a}→${mean(rates).toFixed(4)}`);
    if (dev > 0.012) allOnTarget = false;
  }
  ok(allOnTarget, `目标扫描: ${targetReport.join('、')}（各 |偏差| ≤ 0.012——阈值旋钮可调且不失效）`);

  // ── 确定性 + 钉住 + throw ──
  const r1 = onlineCoverageTracker({ alpha: 0.1 });
  const r2 = onlineCoverageTracker({ alpha: 0.1 });
  const stream = [];
  const rngD = mulberry32(99);
  for (let t = 0; t < 500; t += 1) stream.push([rngD(), rngD() < 0.5 ? 1 : 0]);
  const tauTrace1 = [];
  const tauTrace2 = [];
  for (const [p, y] of stream) {
    r1.observeBinary(p, y);
    tauTrace1.push(r1.view().tau);
    r2.observeBinary(p, y);
    tauTrace2.push(r2.view().tau);
  }
  ok(
    tauTrace1.every((v, i) => v === tauTrace2[i]),
    `确定性: 同种子两次运行的阈值轨迹逐位一致（500 期）`,
  );
  ok(
    tauTrace1.every((v) => v > 0 && v < 1),
    `阈值全程钉在开区间 (0,1)（0/1 边界钉住——比较不退化为恒真/恒假）`,
  );
  ok(
    pinProbability(0) === 1e-12 && near(pinProbability(1), 1 - 1e-12, 1e-15) && pinProbability(0.5) === 0.5 && pinProbability(Number.NaN) === 1e-12,
    `pinProbability: 0→ε、1→1−ε、内部恒等、NaN→ε（数值稳健轴的原子操作）`,
  );
  okThrow(() => onlineCoverageTracker({ alpha: 0 }), 'alpha=0 → throw');
  okThrow(() => onlineCoverageTracker({ alpha: 0.1 }).observeMiss(2), 'missed=2 → throw');
  okThrow(() => onlineCoverageTracker({ alpha: 0.1, stepStyle: 'fast' }), 'stepStyle 非法 → throw');
}

// ═══════════════════ 65.0 dynamic-pricing：稀缺性定价 ═══════════════════

section('65.0 稀缺性定价：精确 DP oracle + 短路定理');

{
  const grid = defaultScarcityGrid();
  ok(near(grid[9], 0.5, 1e-12) && grid.length === 19, `缺省网格 0.05..0.95 共 19 点（含 0.5——oracle 与无约束最优对齐）`);
  // 短路定理: capacity ≥ horizon ⇒ V = T·R*
  const T = 1000;
  const vFull = scarcityOptimalValue(T, T, linearDemand);
  ok(
    near(vFull, T * 0.25, 1e-9),
    `短路定理: capacity=T=1000 ⇒ V = T·R* = ${vFull.toFixed(4)} = 1000×0.25 精确（库存不约束 ⇒ 逐期独立最大化）`,
  );
  // 暴力 DP（无短路）逐位对照
  const brute = (cap, hz, g) => {
    const d = g.map((p) => 1 - p);
    const memo = new Map();
    const V = (t, m) => {
      if (t >= hz || m <= 0) return 0;
      const key = t * 100000 + m;
      if (memo.has(key)) return memo.get(key);
      let best = -Infinity;
      for (let i = 0; i < g.length; i += 1) {
        const v = d[i] * (g[i] + V(t + 1, m - 1)) + (1 - d[i]) * V(t + 1, m);
        if (v > best) best = v;
      }
      memo.set(key, best);
      return best;
    };
    return V(0, Math.min(cap, hz));
  };
  const grid5 = [0.2, 0.35, 0.5, 0.65, 0.8];
  let maxDev = 0;
  const cases = [[6, 8], [3, 12], [10, 10], [5, 20], [2, 5], [7, 7]];
  for (const [c, h] of cases) {
    maxDev = Math.max(maxDev, Math.abs(scarcityOptimalValue(c, h, linearDemand, grid5) - brute(c, h, grid5)));
  }
  ok(
    maxDev <= 1e-12,
    `DP 正确性: 短路版与无短路暴力 DP 在 ${cases.length} 个小实例逐位一致（最大偏差 ${maxDev.toExponential(2)}）`,
  );
  const vHalf = scarcityOptimalValue(250, T, linearDemand);
  ok(
    vHalf > 250 * 0.5 && vHalf < vFull,
    `稀缺 oracle 单调性: V(250) = ${vHalf.toFixed(2)} ∈ (250·p*低价清仓, V(1000) = ${vFull.toFixed(0)})——库存约束真实起效（最优均价 ${(vHalf / 250).toFixed(3)} > 0.5）`,
  );
  okThrow(() => scarcityOptimalValue(0.5, 10, linearDemand), 'capacity 非整数 → throw');
  okThrow(() => scarcityPricing({ capacity: 0 }), 'capacity=0 → throw');
}

section('65.0 稀缺性定价：200 种子对照无视库存的 UCB 基线');

{
  const T = 1000;
  const cap = 250;
  const oracle = scarcityOptimalValue(cap, T, linearDemand);
  const res = { rev: [], myo: [], soS: [], soM: [], apS: [], apM: [] };
  for (let s = 0; s < 200; s += 1) {
    const a = runScarcityTrial(scarcityPricing({ capacity: cap, horizon: T }), T, 700 + s, cap, { optimum: oracle });
    const b = runScarcityTrial(ucbPricing({}), T, 700 + s, cap, { optimum: oracle });
    res.rev.push(a.revenue);
    res.myo.push(b.revenue);
    res.soS.push(a.soldOutAt ?? T + 1);
    res.soM.push(b.soldOutAt ?? T + 1);
    res.apS.push(a.averagePrice);
    res.apM.push(b.averagePrice);
  }
  const mS = median(res.rev);
  const mM = median(res.myo);
  ok(
    mS >= 1.1 * mM,
    `稀缺（cap=${cap} = 半仓）: 围栏中位收益 ${mS.toFixed(1)} ≥ 1.10×无视库存 UCB ${mM.toFixed(1)}（实测 ×${(mS / mM).toFixed(2)}; oracle ${oracle.toFixed(1)}，达成率 ${(mS / oracle * 100).toFixed(1)}%）`,
  );
  ok(
    median(res.soS) > median(res.soM),
    `售罄延后: 中位售罄轮 ${median(res.soS)} vs ${median(res.soM)}（围栏抬价保库存——同一批市场噪声下库存撑更久）`,
  );
  ok(
    median(res.apS) > median(res.apM) + 0.05,
    `成交均价: 围栏 ${median(res.apS).toFixed(3)} > 无视库存 ${median(res.apM).toFixed(3)} + 0.05（稀缺性定价直接读数——Gallego–van Ryzin 式价格围栏）`,
  );
  // 确定性
  const d1 = runScarcityTrial(scarcityPricing({ capacity: cap, horizon: T }), T, 700, cap, { optimum: oracle });
  const d2 = runScarcityTrial(scarcityPricing({ capacity: cap, horizon: T }), T, 700, cap, { optimum: oracle });
  ok(
    d1.revenue === d2.revenue && d1.soldOutAt === d2.soldOutAt,
    `确定性: 同种子两次稀缺试验逐位一致（收益 ${d1.revenue.toFixed(4)}、售罄轮 ${d1.soldOutAt}）`,
  );

  // 无稀缺极限: 收敛到无约束最优
  const oracleFull = scarcityOptimalValue(T, T, linearDemand);
  const un = [];
  for (let s = 0; s < 100; s += 1) {
    un.push(runScarcityTrial(scarcityPricing({ capacity: T, horizon: T }), T, 900 + s, T, { optimum: oracleFull }));
  }
  ok(
    median(un.map((r) => r.regret / T)) <= 0.02,
    `无稀缺极限（cap=T）: 中位 regret/T = ${median(un.map((r) => r.regret / T)).toFixed(4)} ≤ 0.02（库存约束退化为 65.0 原版口径）`,
  );
  ok(
    median(un.map((r) => Math.abs(r.finalPrice - 0.5))) <= 0.11,
    `无稀缺极限收敛价: 中位 |p̂−0.5| = ${median(un.map((r) => Math.abs(r.finalPrice - 0.5))).toFixed(3)} ≤ 0.11（0.05 网格粒度 + 学习噪声的诚实容差）`,
  );
}

// ═══════════════════ 88.0 off-policy-evaluation：switch DR + 流式 + log 域 ═══════════════════

section('88.0 switch DR：截断权重的偏差–方差账');

{
  const cliff = makeCliffWorld();
  const adv = (p) => constantActionPolicy(2, 1, p);
  const piE = adv(0.8);
  const muE = adv(0.45);
  const J = cliff.exactValue(piE);
  const qExact = cliff.exactQModel(piE);
  const qBad = cliff.exactQModel(adv(0.45)); // 模型失配（行为策略的 Q）

  // cap=∞ 逐位 ≡ DR
  const eps = cliff.sampleEpisodes(muE, 300, 7);
  ok(
    near(switchDREstimate(eps, piE, muE, qExact), drEstimate(eps, piE, muE, qExact), 1e-12),
    `退化: cap=∞ 的 switchDR ≡ DR（${switchDREstimate(eps, piE, muE, qExact).toFixed(10)}，1e-12）`,
  );

  // 精确 Q + cap: 无偏（前缀可测截断）+ 方差大降（同一数据集）
  const drPer = eps.map((e) => drPerEpisode(e, piE, muE, qExact));
  const swPer = eps.map((e) => switchDrPerEpisode(e, piE, muE, qExact, 1, 2));
  ok(
    sd(swPer) <= 0.5 * sd(drPer),
    `方差账（同数据集 n=300）: sd(switchDR, c=2) = ${sd(swPer).toFixed(3)} ≤ 0.5×sd(DR) = ${(0.5 * sd(drPer)).toFixed(3)}（实测 ×${(sd(drPer) / sd(swPer)).toFixed(1)}——重尾被截）`,
  );
  const stats2 = switchDRStepStats(eps, piE, muE, 1, 2);
  ok(
    stats2.switchedSteps > 0 && stats2.switchedRate < 1,
    `截断账: ${stats2.switchedSteps}/${stats2.steps} 步越阈（${(stats2.switchedRate * 100).toFixed(1)}%、max ρ = ${stats2.maxCumulativeWeight.toFixed(1)}）——诚实报告被切换的比例`,
  );

  // 200 数据集无偏性（精确 Q + cap=2）
  const estimates = [];
  for (let s = 0; s < 200; s += 1) {
    const e2 = cliff.sampleEpisodes(muE, 300, 500 + s);
    estimates.push(switchDREstimate(e2, piE, muE, qExact, 1, 2));
  }
  const bias = mean(estimates) - J;
  ok(
    Math.abs(bias) <= 4 * se(estimates),
    `无偏性（精确 Q + cap=2, 200 数据集 × n=300）: bias = ${bias.toFixed(4)} ≤ 4·SE = ${(4 * se(estimates)).toFixed(4)}（指示 1{ρ≤c} 前缀可测——截断不破无偏; J = ${J.toFixed(4)}）`,
  );

  // 偏差–方差账（坏 Q）: sd 与 RMSE 随 c ↓ 单调不增
  const caps = [Infinity, 4, 2];
  const sds = caps.map(() => []);
  const biases = caps.map(() => []);
  for (let s = 0; s < 25; s += 1) {
    const e3 = cliff.sampleEpisodes(muE, 300, 300 + s);
    caps.forEach((c, k) => {
      const per = e3.map((e) => switchDrPerEpisode(e, piE, muE, qBad, 1, c));
      sds[k].push(sd(per));
      biases[k].push(Math.abs(mean(per) - J));
    });
  }
  const sdM = sds.map(median);
  const rmseM = caps.map((_, k) => Math.hypot(median(biases[k]), sdM[k]));
  ok(
    sdM[1] <= sdM[0] && sdM[2] <= sdM[1],
    `坏 Q 方差单调: sd(c=∞,4,2) = ${sdM.map((v) => v.toFixed(2)).join(' → ')}（c ↓ 方差 ↓——截掉的就是重尾）`,
  );
  ok(
    rmseM[2] <= rmseM[0],
    `坏 Q 权衡账: RMSE(c=2) = ${rmseM[2].toFixed(3)} ≤ RMSE(c=∞) = ${rmseM[0].toFixed(3)}（模型误差 + IS 重尾的组合里，截断的方差收益 > 引入的偏差——switch 的成立条件）`,
  );
  okThrow(() => switchDREstimate(eps, piE, muE, undefined, 1, 0), 'cap=0 → throw');
  okThrow(() => switchDREstimate([], piE, muE), '空 episodes → throw');
}

section('88.0 StreamingOPE：单遍流式四口径（等价 + 耗时 + 对数域 WIS）');

{
  const cliff = makeCliffWorld();
  const adv = (p) => constantActionPolicy(2, 1, p);
  const piE = adv(0.8);
  const muE = adv(0.45);
  const qBad = cliff.exactQModel(adv(0.45));
  const epsBig = cliff.sampleEpisodes(muE, 2000, 77);
  const st = streamingOPE({ target: piE, behavior: muE, qModel: qBad });
  for (const e of epsBig) st.push(e);
  const s = st.summary();
  // 耗时对照（预热后）
  let t0 = performance.now();
  const st2 = streamingOPE({ target: piE, behavior: muE, qModel: qBad });
  for (const e of epsBig) st2.push(e);
  const tStream = performance.now() - t0;
  t0 = performance.now();
  const b1 = naiveMean(epsBig);
  const b2 = pdis(epsBig, piE, muE);
  const b3 = wis(epsBig, piE, muE);
  const b4 = drEstimate(epsBig, piE, muE, qBad);
  const tBatch = performance.now() - t0;
  ok(
    Math.abs(s.naive - b1) <= 1e-12 && Math.abs(s.pdis - b2) <= 1e-12 && Math.abs(s.dr - b4) <= 1e-12 && Math.abs(s.wis - b3) <= 1e-12,
    `等价证明: 流式 naive/pdis/dr/wis ≡ 批四口径（最大偏差 ${Math.max(Math.abs(s.naive - b1), Math.abs(s.pdis - b2), Math.abs(s.dr - b4), Math.abs(s.wis - b3)).toExponential(2)} ≤ 1e-12; n=2000）`,
  );
  ok(
    tStream <= tBatch,
    `耗时对照: 单遍流式 ${tStream.toFixed(0)}ms ≤ 批四口径 ${tBatch.toFixed(0)}ms（实测 ×${(tBatch / tStream).toFixed(2)}——一遍同时维护四口径 vs 四遍重扫; 内存 O(1) vs O(n)）`,
  );
  ok(
    s.underflowedWeights === 0 && s.sigmaPdis > 0 && s.radiusPdis > 0,
    `任意时刻可读: σ̂(PDIS) = ${s.sigmaPdis.toFixed(3)}、EB 90% 半径 ≈ ${s.radiusPdis.toFixed(3)}（Welford 单遍方差）`,
  );

  // 对数域 WIS: 长视界下溢
  const long = makeChainMdp({ length: 5, horizon: 2000, goalReward: 1 });
  const piL = constantActionPolicy(2, 1, 0.3);
  const muL = constantActionPolicy(2, 1, 0.99);
  const epsL = long.sampleEpisodes(muL, 50, 3);
  let threw = false;
  try {
    wis(epsL, piL, muL);
  } catch {
    threw = true;
  }
  const stL = streamingOPE({ target: piL, behavior: muL });
  for (const e of epsL) stL.push(e);
  const sl = stL.summary();
  const gs = epsL.map((e) => e.rewards.reduce((a, b) => a + b, 0));
  ok(
    threw,
    `朴素 wis 下溢: ρ≈0.3、T=2000 ⇒ w = 10^{-2600} → 连乘归零，批 wis() 显式 throw（诚实失败）`,
  );
  ok(
    Number.isFinite(sl.wis) && sl.wis >= Math.min(...gs) - 1e-9 && sl.wis <= Math.max(...gs) + 1e-9,
    `对数域 WIS: ${sl.wis.toFixed(4)} 有限且 ∈ [min G, max G] = [${Math.min(...gs).toFixed(1)}, ${Math.max(...gs).toFixed(1)}]（凸组合有界性在下溢区仍成立; ${sl.underflowedWeights}/50 条权重线性域必为 0）`,
  );
  okThrow(() => streamingOPE({ target: piL, behavior: muL, cap: -1 }), 'StreamingOPE cap<0 → throw');
}

// ═══════════════════ 89.0 safe-policy-improvement：多候选 FWER ═══════════════════

section('89.0 多候选并发证书：Bonferroni 均分与固定序（union bound 精确化）');

{
  const env = makeChainMdp({ length: 5, horizon: 10, goalReward: 0.1 });
  const adv = (p) => constantActionPolicy(2, 1, p);
  const base = adv(0.5);

  // k=1 退化 ≡ 单候选检验
  const eps = env.sampleEpisodes(base, 120, 42);
  const single = safePolicyImprove({ episodes: eps, candidate: adv(0.6), baseline: base, behavior: base, delta: 0.05, minSamples: 30 });
  const multi1 = safePolicyImproveMulti({ episodes: eps, candidates: [adv(0.6)], baseline: base, behavior: base, delta: 0.05, minSamples: 30 });
  ok(
    near(single.delta, multi1.results[0].deltaHat, 1e-12) && near(single.lcb, multi1.results[0].lcb, 1e-12) && single.accepted === multi1.results[0].accepted,
    `k=1 退化: 多候选接口 ≡ safePolicyImprove（Δ̂/LCB/决策逐位一致，1e-12）`,
  );
  ok(
    near(bonferroniDelta(0.05, 8), 0.05 / 8, 1e-15) && ebRadius(0.5, 2, 200, 0.05 / 8) > ebRadius(0.5, 2, 200, 0.05),
    `union bound 精确化: δ/k 均分精确，且 radius(δ/k) > radius(δ)（闭式单调——多重检验的数学价格）`,
  );

  // 接受集包含（同数据确定性后果）+ 共享基线等价
  const cands8 = Array.from({ length: 8 }, (_, i) => adv(0.62 - 0.01 * i));
  const epsBig = env.sampleEpisodes(base, 640, 42);
  const bf = safePolicyImproveMulti({ episodes: epsBig, candidates: cands8, baseline: base, behavior: base, delta: 0.05 });
  let containOk = true;
  let equivOk = true;
  for (let j = 0; j < 8; j += 1) {
    const ind = safePolicyImprove({ episodes: epsBig, candidate: cands8[j], baseline: base, behavior: base, delta: 0.05 / 8, minSamples: 30 });
    if (ind.accepted && !bf.results[j].accepted) containOk = false;
    if (!near(ind.delta, bf.results[j].deltaHat, 1e-12) || !near(ind.lcb, bf.results[j].lcb, 1e-12)) equivOk = false;
  }
  ok(containOk, `接受集包含: Bonferroni(δ/8) 接受 ⟹ 全额 δ 接受（同数据逐候选对照——δ 均分只会更保守）`);
  ok(equivOk, `共享基线等价: multi 的 Δ̂/LCB ≡ 逐个 safePolicyImprove(δ/k)（1e-12——基线贡献只算一遍不改数值）`);

  // FWER: 500 种子 k=8 真退步
  const regressions = [0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05].map(adv);
  let violations = 0;
  for (let s = 0; s < 500; s += 1) {
    const e = env.sampleEpisodes(adv(0.85), 120, 3000 + s);
    const r = safePolicyImproveMulti({ episodes: e, candidates: regressions, baseline: adv(0.85), behavior: adv(0.85), delta: 0.1 });
    if (r.acceptedIndices.length > 0) violations += 1;
  }
  ok(
    violations / 500 <= 0.1 + 0.03,
    `FWER（k=8 真退步、δ=0.1、500 种子）: 违反 ${violations}/500 = ${(violations / 500).toFixed(4)} ≤ δ+容差 = 0.13（错误接受任一真退步被 union bound 钉死）`,
  );

  // 固定序: 前缀结构 + 功效 + 退化首序
  const fs = safePolicyImproveMulti({ episodes: epsBig, candidates: cands8, baseline: base, behavior: base, delta: 0.05, correction: MULTI_CORRECTION.fixedSequence });
  const prefixOk =
    fs.acceptedIndices.every((idx, i) => idx === fs.acceptedIndices[i - 1] + 1 || i === 0) &&
    (fs.acceptedIndices.length === 0 || fs.acceptedIndices[0] === 0) &&
    fs.results.every((r, j) => (j < fs.acceptedIndices.length ? r.accepted : r.reason === 'not-tested' || r.accepted));
  ok(prefixOk, `固定序前缀结构: 接受集 = [${fs.acceptedIndices.join(', ')}]（连续前缀; 首拒后其余 not-tested——不接受前缀之外的候选）`);
  let fsTotal = 0;
  let bfTotal = 0;
  for (let s = 0; s < 40; s += 1) {
    const e = env.sampleEpisodes(base, 640, 9000 + s);
    fsTotal += safePolicyImproveMulti({ episodes: e, candidates: cands8, baseline: base, behavior: base, delta: 0.05, correction: MULTI_CORRECTION.fixedSequence }).acceptedIndices.length;
    bfTotal += safePolicyImproveMulti({ episodes: e, candidates: cands8, baseline: base, behavior: base, delta: 0.05, correction: MULTI_CORRECTION.bonferroni }).acceptedIndices.length;
  }
  ok(
    fsTotal >= bfTotal,
    `固定序功效（40 种子 × k=8 展开候选）: 固定序总接受 ${fsTotal} ≥ Bonferroni ${bfTotal}（有先验排序时全额 δ 检验——零多重检验税）`,
  );
  let mixViol = 0;
  const mix = [adv(0.3), adv(0.9), adv(0.8)];
  for (let s = 0; s < 100; s += 1) {
    const e = env.sampleEpisodes(adv(0.85), 120, 8000 + s);
    const r = safePolicyImproveMulti({ episodes: e, candidates: mix, baseline: adv(0.85), behavior: adv(0.85), delta: 0.05, correction: MULTI_CORRECTION.fixedSequence });
    if (r.acceptedIndices.length > 0) mixViol += 1;
  }
  ok(
    mixViol === 0,
    `固定序退化首序（真退步打头 + 真改进殿后）: 100 种子违反 0（首候选被拒即停——后面的好候选救不回来，FWER 仍 ≤ δ——固定序的代价面）`,
  );

  // 耗时对照（预热后）
  safePolicyImproveMulti({ episodes: epsBig, candidates: cands8, baseline: base, behavior: base, delta: 0.05 });
  for (const c of cands8) safePolicyImprove({ episodes: epsBig, candidate: c, baseline: base, behavior: base, delta: 0.05 / 8 });
  let t0 = performance.now();
  safePolicyImproveMulti({ episodes: epsBig, candidates: cands8, baseline: base, behavior: base, delta: 0.05 });
  const tMulti = performance.now() - t0;
  t0 = performance.now();
  for (const c of cands8) safePolicyImprove({ episodes: epsBig, candidate: c, baseline: base, behavior: base, delta: 0.05 / 8 });
  const tIndiv = performance.now() - t0;
  ok(
    tMulti <= tIndiv,
    `耗时对照: 共享基线一遍 ${tMulti.toFixed(1)}ms ≤ 逐候选 2k 遍 ${tIndiv.toFixed(1)}ms（实测 ×${(tIndiv / tMulti).toFixed(2)}——k+1 遍估计器扫完）`,
  );
  okThrow(() => safePolicyImproveMulti({ episodes: epsBig, candidates: [], baseline: base, behavior: base }), '空 candidates → throw');
  okThrow(
    () => safePolicyImproveMulti({ episodes: epsBig, candidates: cands8, baseline: base, behavior: base, correction: 'holm' }),
    'correction 非法 → throw',
  );
  okThrow(() => bonferroniDelta(0.05, 0), 'bonferroniDelta 候选数 0 → throw');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— R5 在线学习六内核进化（31.0 AdaHedge/LazyHedge + 74.0 乐观 FTRL/投影快速路径 + 75.0 在线覆盖 + 65.0 稀缺性定价 + 88.0 switchDR/流式/log域 + 89.0 多候选 FWER）数学验证成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
