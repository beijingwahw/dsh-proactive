/**
 * verify-streaming-sketch.mjs — 80.0 流式概要内核纯数学离线验证
 *
 * 四个结构的数学保证全部有独立对照（不是「能跑」，是「算得对」）：
 *   ① Count-Min Sketch: Zipf(1.5) 对抗流 10 万事件 × 5 种子——全键只高
 *        不低（确定性性质）+ 超出 ≤ ε‖a‖₁（ε,δ 概率保证的实证）+ 稀有键
 *        误差受控；单键零碰撞精确恢复；w/d 尺寸与闭式逐位一致；宽松
 *        配置 28×3 违例率 ≤ 1% ≪ δ=5%（δ 逐键语义的实证）
 *   ② 蓄水池抽样: n=10⁵, k=50 × 300 次——总入选 = T·k 精确闭合、离散比
 *        与极值守卫；强统计版 n=10³ × 40000 次——每元素入选频率 vs k/n
 *        最大偏差 < 0.005、χ²/dof ∈ [0.85, 1.15]（等概率的证明性检验；
 *        试验种子按 7919·t 散布——顺序种子流间相关会 χ² 过度离散）
 *   ③ 指数直方图: 三态突发位流 10 万、W=1000、ε=0.1——滑窗全位置扫描
 *        |N̂−N₁| ≤ max(εN₁, 0.5) 处处成立（含稀疏位）、稠密位（N₁ ≥ m）
 *        相对误差 ≤ ε；桶合不变量全程成立；峰值桶数 ≤ 公式上界 + 内存
 *        节省倍数报告（vs 朴素窗口计数）
 *   ④ Misra–Gries: Zipf 流 >20% 频率元素 100% 捕获（k=4）、>10%（k=9）
 *        双口径；计数下界 ≥ f − N/(k+1) ∀ 键；纯均匀流无假阳性重元素
 *   ⑤ verifySketches 一站式四段全过；四结构内存上界公式 vs 实测对照
 *        （w·d / k / (m+1)(⌊log₂W⌋+2) / k）
 *
 * 全部断言确定性（随机处用脚本内 mulberry32 / 内核自带 mulberry32）。
 * 运行：node --experimental-strip-types scripts/verify-streaming-sketch.mjs
 */

import {
  CountMinSketch,
  countMinSketchShape,
  ReservoirSampler,
  ExponentialHistogram,
  exponentialHistogramMemoryBound,
  misraGries,
  verifySketches,
} from '../src/core/streaming-sketch.ts';

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
function throws(fn, label) {
  try {
    fn();
  } catch {
    ok(true, label);
    return;
  }
  ok(false, `${label}（未抛出）`);
}
function section(title) {
  console.log(`\n■ ${title}`);
}

/** 确定性 RNG（mulberry32，与内核同款） */
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

/** Zipf(s) 键流: 键 key-0..key-(nKeys-1)，P(rank i) ∝ (i+1)^(−s)（逆 CDF + 二分） */
function zipfStream(nKeys, n, s, seed) {
  const rand = mulberry32(seed);
  const cum = new Float64Array(nKeys);
  let acc = 0;
  for (let i = 0; i < nKeys; i += 1) {
    acc += Math.pow(i + 1, -s);
    cum[i] = acc;
  }
  const out = new Array(n);
  for (let j = 0; j < n; j += 1) {
    const u = rand() * acc;
    let lo = 0;
    let hi = nKeys - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < u) lo = mid + 1;
      else hi = mid;
    }
    out[j] = `key-${lo}`;
  }
  return out;
}

/** 三态突发位流: 概率体制 {0.8, 0.05, 0.002} 间马尔可夫切换（切换率 0.4%） */
function burstyBits(n, seed) {
  const rand = mulberry32(seed);
  const probs = [0.8, 0.05, 0.002];
  let regime = 0;
  const bits = new Array(n);
  for (let i = 0; i < n; i += 1) {
    if (rand() < 0.004) regime = Math.floor(rand() * 3);
    bits[i] = rand() < probs[regime] ? 1 : 0;
  }
  return bits;
}

// ── 共享对抗流: Zipf(1.5)、1000 键、10 万事件（①④⑤ 段复用；真值精确 Map） ──
const N_KEYS = 1000;
const N_EVENTS = 100000;
const zipf = zipfStream(N_KEYS, N_EVENTS, 1.5, 7);
const zipfTruth = new Map();
for (const k of zipf) zipfTruth.set(k, (zipfTruth.get(k) ?? 0) + 1);
const zipfSorted = [...zipfTruth.entries()].sort((a, b) => b[1] - a[1]);
const topKey = zipfSorted[0][0];
const topTrue = zipfSorted[0][1];
const L1 = N_EVENTS;

// ═══════════════════ ① Count-Min Sketch ═══════════════════

section('① Count-Min Sketch：ε,δ 保证与 Zipf 对抗流');

{
  // 尺寸闭式: w = ⌈e/ε⌉, d = ⌈ln(1/δ)⌉
  const s1 = countMinSketchShape(0.02, 0.01);
  ok(s1.width === 136 && s1.depth === 5 && s1.cells === 680, `w/d 闭式: ⌈e/0.02⌉=${s1.width}, ⌈ln(100)⌉=${s1.depth}, w·d=${s1.cells}`);
  const s2 = countMinSketchShape(0.1, 0.05);
  ok(s2.width === 28 && s2.depth === 3, `w/d 闭式: ⌈e/0.1⌉=${s2.width}, ⌈ln(20)⌉=${s2.depth}`);

  // 单键零碰撞: 无他键 ⟹ 每行只有自身计数，估计精确
  const single = new CountMinSketch({ eps: 0.02, delta: 0.01, seed: 3 });
  single.update('alpha', 7);
  single.update('alpha');
  ok(single.estimate('alpha') === 8, `单键精确: estimate('alpha')=${single.estimate('alpha')} === 8（零碰撞）`);
  ok(single.estimate('beta') === 0, `未注入键 estimate('beta')=${single.estimate('beta')} === 0`);
  ok(single.stats().total === 8, `‖a‖₁ 累计 = ${single.stats().total} === 8`);

  // Zipf(1.5) 对抗流（模块级共享 zipf/zipfTruth）：界 = ε‖a‖₁
  const EPS = 0.02;
  const DELTA = 0.01;
  const l1 = L1;
  const bound = EPS * l1;
  const rareKeys = zipfSorted.filter(([, c]) => c <= 20);
  const stream = zipf;
  const truth = zipfTruth;

  let allOneSided = true;
  let worstExcess = -Infinity;
  let worstKey = '';
  let rareWorst = -Infinity;
  let topRelWorst = 0;
  for (const seed of [101, 202, 303, 404, 505]) {
    const cms = new CountMinSketch({ eps: EPS, delta: DELTA, seed });
    for (const k of stream) cms.update(k);
    let seedWorst = -Infinity;
    for (const [k, tc] of truth) {
      const est = cms.estimate(k);
      if (est < tc) allOneSided = false;
      const ex = est - tc;
      if (ex > worstExcess) {
        worstExcess = ex;
        worstKey = k;
      }
      if (ex > seedWorst) seedWorst = ex;
      if (tc <= 20 && ex > rareWorst) rareWorst = ex;
      if (k === topKey && ex / tc > topRelWorst) topRelWorst = ex / tc;
    }
    console.log(`  种子 ${seed}: 全键最大超出 ${seedWorst.toFixed(1)} / 界 ${bound.toFixed(0)}`);
  }
  ok(
    allOneSided,
    `只高不低: 5 种子 × 全部 ${N_KEYS} 键 估计 ≥ 真值（非负更新的确定性性质，0 违例）`,
  );
  ok(
    worstExcess <= bound,
    `ε‖a‖₁ 上界: 全局最大超出 ${worstExcess.toFixed(1)}（${worstKey}）≤ ε‖a‖₁ = ${bound.toFixed(0)}`,
  );
  ok(
    rareWorst <= bound,
    `稀有键受控: ${rareKeys.length} 个真值 ≤20 的键最大超出 ${rareWorst.toFixed(1)} ≤ ${bound.toFixed(0)}`,
  );
  ok(
    topRelWorst <= 0.02,
    `重键质量: 最重键 ${topKey}（真值 ${topTrue}）相对误差最大 ${(topRelWorst * 100).toFixed(3)}% ≤ 2%`,
  );
  ok(
    new CountMinSketch({ eps: EPS, delta: DELTA, seed: 9 }).stats().cells === 680 && 680 < N_KEYS,
    `内存: w·d = 680 格 < 精确 Map ${N_KEYS} 键（对抗流下概要小于精确表）`,
  );

  // 宽松配置 (ε=0.1, δ=0.05 → 28×3): δ 是逐键概率语义——极少数键可违例，
  // 但违例率应远低于 δ（实测 0.07%）；只高不低仍是确定性性质
  let looseViolations = 0;
  let looseChecks = 0;
  let looseOneSided = true;
  for (const seed of [11, 22, 33]) {
    const loose = new CountMinSketch({ eps: 0.1, delta: 0.05, seed });
    for (const k of stream) loose.update(k);
    for (const [k, tc] of truth) {
      const est = loose.estimate(k);
      if (est < tc) looseOneSided = false;
      if (est - tc > 0.1 * l1) looseViolations += 1;
      looseChecks += 1;
    }
  }
  ok(
    looseOneSided,
    `宽松配置只高不低: 28×3 × 3 种子全 ${looseChecks} 键 估计 ≥ 真值（确定性性质不随精度放松）`,
  );
  ok(
    looseViolations / looseChecks <= 0.01,
    `宽松配置 δ 语义: 违例 ${looseViolations}/${looseChecks} = ${(looseViolations / looseChecks * 100).toFixed(3)}% ≤ 1% ≪ δ=5%（概率界逐键成立，非全键联合）`,
  );

  // 确定性: 同种子同估计；异种子哈希族不同
  const dA = new CountMinSketch({ eps: EPS, delta: DELTA, seed: 7 });
  const dB = new CountMinSketch({ eps: EPS, delta: DELTA, seed: 7 });
  const dC = new CountMinSketch({ eps: EPS, delta: DELTA, seed: 8 });
  for (const k of stream.slice(0, 5000)) {
    dA.update(k);
    dB.update(k);
    dC.update(k);
  }
  const probeKeys = [topKey, 'key-500', 'key-999'];
  ok(
    probeKeys.every((k) => dA.estimate(k) === dB.estimate(k)),
    '同种子同估计（确定性，逐位一致）',
  );
  ok(
    probeKeys.some((k) => dA.estimate(k) !== dC.estimate(k)),
    '异种子哈希族不同（至少一探针键估计相异）',
  );
}

// ═══════════════════ ② 蓄水池抽样 ═══════════════════

section('② 蓄水池抽样：k/n 精确等概率的证明性检验');

{
  // 规格口径: n=100000, k=50, 300 次重复——结构 + 精确闭合 + 离散比
  const N = 100000;
  const K = 50;
  const TRIALS = 300;
  const counts = new Float64Array(N);
  let determinismOk = true;
  let membershipOk = true;
  let distinctOk = true;
  const refSampler = new ReservoirSampler(K, 31337);
  for (let i = 0; i < N; i += 1) refSampler.feed(i);
  const firstSample = JSON.stringify(refSampler.sample());
  for (let t = 0; t < TRIALS; t += 1) {
    // 种子按 7919·t 散布（顺序种子流间相关，实证见内核注释）
    const s = new ReservoirSampler(K, (31337 + t * 7919) >>> 0);
    for (let i = 0; i < N; i += 1) s.feed(i);
    const sample = s.sample();
    if (sample.length !== K) membershipOk = false;
    const set = new Set(sample);
    if (set.size !== sample.length) distinctOk = false;
    for (const idx of sample) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= N) membershipOk = false;
      counts[idx] += 1;
    }
    if (t === 0 && JSON.stringify(sample) !== firstSample) determinismOk = false;
  }
  const p = K / N;
  let total = 0;
  let sumSq = 0;
  let maxCount = 0;
  for (let i = 0; i < N; i += 1) {
    total += counts[i];
    sumSq += counts[i] * counts[i];
    if (counts[i] > maxCount) maxCount = counts[i];
  }
  const mean = total / N;
  const variance = (sumSq - N * mean * mean) / (N - 1);
  const lambda = TRIALS * p;
  const maxCountBound = lambda + 5 * Math.sqrt(lambda + 1) + 4;
  ok(membershipOk, `结构: 每次样本恰 ${K} 个、全部属于流、无重复`);
  ok(distinctOk && determinismOk, `确定性: 同种子逐位同样本；池内 ${K} 格互异`);
  ok(
    total === TRIALS * K,
    `精确闭合: 总入选 ${total} === 试验数×k = ${TRIALS}×${K}（每试验恰选 k 个）`,
  );
  ok(
    near(variance / lambda, 1 - p, 0.05),
    `离散比: 计数方差/期望 = ${(variance / lambda).toFixed(4)} ↔ 1−p = ${(1 - p).toFixed(4)}（±0.05，二项离散）`,
  );
  ok(
    maxCount <= maxCountBound,
    `极值守卫: 单元素最大入选 ${maxCount} 次 ≤ λ+5√(λ+1)+4 = ${maxCountBound.toFixed(1)}（λ=${lambda.toFixed(1)}）`,
  );
  ok(
    new ReservoirSampler(K).capacity === K && new ReservoirSampler(K).seen === 0,
    `内存上界: 池容量 k=${K} 格（seen 初始 0）`,
  );

  // 强统计版: n=1000, k=50, 40000 次——每元素入选频率 vs k/n 的最大偏差 + χ²
  const N2 = 1000;
  const K2 = 50;
  const T2 = 40000;
  const counts2 = new Float64Array(N2);
  for (let t = 0; t < T2; t += 1) {
    const s = new ReservoirSampler(K2, (90210 + t * 7919) >>> 0);
    for (let i = 0; i < N2; i += 1) s.feed(i);
    for (const idx of s.sample()) counts2[idx] += 1;
  }
  const p2 = K2 / N2;
  const lambda2 = T2 * p2;
  let chi2 = 0;
  let maxDev = 0;
  let total2 = 0;
  for (let i = 0; i < N2; i += 1) {
    chi2 += ((counts2[i] - lambda2) ** 2) / (lambda2 * (1 - p2));
    const dev = Math.abs(counts2[i] / T2 - p2);
    if (dev > maxDev) maxDev = dev;
    total2 += counts2[i];
  }
  const chiOverDof = chi2 / (N2 - 1);
  console.log(
    `  强统计: n=${N2}, k=${K2}, T=${T2} → χ²/dof=${chiOverDof.toFixed(4)}, 最大频率偏差=${maxDev.toFixed(5)} (期望 ${p2})`,
  );
  ok(
    total2 === T2 * K2 && maxDev < 0.005,
    `等概率证明性检验: 每元素入选频率 vs k/n=${p2} 最大偏差 ${(maxDev * 100).toFixed(3)}% < 0.5%（总入选 ${total2} 精确闭合）`,
  );
  ok(
    chiOverDof >= 0.85 && chiOverDof <= 1.15,
    `χ² 检验: χ²/dof = ${chiOverDof.toFixed(4)} ∈ [0.85, 1.15]（二项频次分布与 k/n 无偏一致）`,
  );
}

// ═══════════════════ ③ 指数直方图 ═══════════════════

section('③ 指数直方图：滑窗全位置 ε 保证与内存节省');

{
  const BITS = burstyBits(100000, 77);
  const EPS = 0.1;
  const W = 1000;
  const M = Math.ceil(1 / EPS); // N₁ ≥ m ⟹ 相对误差 ≤ 1/m ≤ ε
  const hist = new ExponentialHistogram({ eps: EPS, window: W });
  const prefix = new Float64Array(BITS.length + 1);
  for (let i = 0; i < BITS.length; i += 1) prefix[i + 1] = prefix[i] + BITS[i];

  let boundHolds = true;
  let worstMargin = Infinity; // max(εN₁, 0.5) − |err| 的最小余量
  let maxRelDense = 0;
  let densePositions = 0;
  let sparsePositions = 0;
  let maxAbsError = 0;
  let invariantAlways = true;
  let peak = 0;
  for (let i = 0; i < BITS.length; i += 1) {
    hist.insert(null, BITS[i] === 1);
    const st = hist.stats();
    if (!st.invariantHolds) invariantAlways = false;
    if (st.buckets > peak) peak = st.buckets;
    const t = i + 1;
    const trueCount = prefix[t] - prefix[Math.max(0, t - W)];
    const err = Math.abs(hist.windowCount() - trueCount);
    const boundNow = Math.max(EPS * trueCount, 0.5);
    if (err > boundNow) boundHolds = false;
    if (boundNow - err < worstMargin) worstMargin = boundNow - err;
    if (err > maxAbsError) maxAbsError = err;
    if (trueCount >= M) {
      densePositions += 1;
      if (err / trueCount > maxRelDense) maxRelDense = err / trueCount;
    } else if (trueCount <= 2) sparsePositions += 1;
  }
  const onesTotal = prefix[BITS.length];
  const memBound = exponentialHistogramMemoryBound(EPS, W);
  console.log(
    `  位流: ${BITS.length} 元素 / ${onesTotal} 个 1（三态突发）；稠密位 ${densePositions}、稀疏位（N₁≤2）${sparsePositions}`,
  );
  console.log(
    `  扫描: 最大绝对误差 ${maxAbsError.toFixed(2)}、稠密位最大相对误差 ${(maxRelDense * 100).toFixed(3)}%、最紧余量 ${worstMargin.toFixed(3)}`,
  );
  ok(boundHolds, `全位置界: |N̂−N₁| ≤ max(εN₁, 0.5) 在全部 ${BITS.length} 个滑窗位置成立（含稀疏位）`);
  ok(
    maxRelDense <= EPS,
    `稠密位相对误差: N₁ ≥ m=${M} 的位置最大 ${(maxRelDense * 100).toFixed(3)}% ≤ ε = 10%`,
  );
  ok(sparsePositions > 0, `稀疏位真实经历: ${sparsePositions} 个 N₁ ≤ 2 的位置走过绝对误差分支（非死代码）`);
  ok(invariantAlways, `桶合不变量: 2 的幂 / 随年龄单调 / 同类 ≤ m+1，全程 ${BITS.length} 步无违例`);
  ok(
    peak <= memBound,
    `内存实测 ${peak} 桶 ≤ 公式上界 (m+1)(⌊log₂W⌋+2) = ${memBound}`,
  );
  console.log(
    `  内存: 朴素滑窗计数 ${W} 格 vs 峰值 ${peak} 桶 → 节省 ${(W / peak).toFixed(1)}×`,
  );
  ok(W / peak > 5, `内存节省倍数 ${(W / peak).toFixed(1)}× > 5×（O((1/ε)logW) vs O(W)）`);

  // 手工小例（ε=0.5 → m=2）: 窗口满覆盖时逐桶可算
  const tiny = new ExponentialHistogram({ eps: 0.5, window: 10 });
  for (let i = 0; i < 6; i += 1) tiny.insert(null, true);
  const tinyStats = tiny.stats();
  ok(
    tinyStats.m === 2 && tinyStats.invariantHolds && tiny.windowCount() === 5,
    `手工例: 6 个 1、m=2 → 桶 [2,2,1,1]，windowCount = 2+1+1+2/2 = ${tiny.windowCount()}（误差 1 = 2^{J−1}, J=1 界）`,
  );
}

// ═══════════════════ ④ Misra–Gries ═══════════════════

section('④ Misra–Gries：重元素 100% 捕获与计数下界');

{
  const stream = zipf;
  const truth = zipfTruth;

  // k=4 → 保证阈 N/5 = 20%: Zipf(1.5) 首键 ≈39% 必被捕获
  const mg4 = misraGries(stream, 4);
  const inMg4 = new Set(mg4.candidates.map((c) => c.key));
  ok(
    inMg4.has(topKey) && topTrue > mg4.threshold,
    `>20% 捕获: 首键 ${topKey}（频率 ${(topTrue / mg4.n * 100).toFixed(1)}% > 阈 ${mg4.threshold}）100% 在候选`,
  );
  ok(mg4.candidates.length <= 4, `候选 ≤ k: ${mg4.candidates.length} ≤ 4（内存上界 k 格）`);

  // k=9 → 保证阈 N/10 = 10%: Zipf 前两键（≈39%、≈14%）都必须在
  const mg9 = misraGries(stream, 9);
  const stored9 = new Map(mg9.candidates.map((c) => [c.key, c.count]));
  const heavies9 = [...truth.entries()].filter(([, c]) => c > mg9.threshold).map(([k]) => k);
  const missing = heavies9.filter((k) => !stored9.has(k));
  ok(
    heavies9.length >= 2 && missing.length === 0,
    `>10% 捕获（k=9）: 真重元素 ${heavies9.length} 个（${heavies9.slice(0, 3).join(', ')}${heavies9.length > 3 ? '…' : ''}）全部在候选（0 漏捕）`,
  );

  // 计数下界与上界: stored ∈ [f − N/(k+1), f] ∀ 键（含未入表键 stored=0）
  let lowerOk = true;
  let upperOk = true;
  for (const [k, f] of truth) {
    const stored = stored9.get(k) ?? 0;
    if (stored > f) upperOk = false;
    if (stored < f - mg9.threshold) lowerOk = false;
  }
  ok(upperOk, `只少不多: 全部 ${truth.size} 键 计数 ≤ 真值（0 上越界）`);
  ok(
    lowerOk,
    `计数下界: 全部 ${truth.size} 键 计数 ≥ f − N/(k+1) = f − ${mg9.threshold.toFixed(0)}（0 下越界）`,
  );
  const topStored = stored9.get(topKey);
  ok(
    topStored >= topTrue - mg9.threshold && topStored <= topTrue,
    `首键估计: ${topStored} ∈ [${(topTrue - mg9.threshold).toFixed(0)}, ${topTrue}]（真实 ${topTrue}）`,
  );

  // 纯均匀流: 1000 键 10 万事件——无真重元素 ⟹ 报告集为空（无假阳性）
  const rand = mulberry32(555);
  const uniform = Array.from({ length: 100000 }, () => `u-${Math.floor(rand() * 1000)}`);
  const mgU = misraGries(uniform, 10);
  const reported = mgU.candidates.filter((c) => c.count > mgU.threshold);
  const maxStored = mgU.candidates.length > 0 ? mgU.candidates[0].count : 0;
  ok(
    reported.length === 0,
    `均匀流无假阳性: 0 个候选越过阈 N/11 = ${mgU.threshold.toFixed(0)}（最大计数 ${maxStored}）`,
  );
  ok(mgU.candidates.length <= 10, `均匀流候选规模: ${mgU.candidates.length} ≤ k=10（无大集合涌现）`);
}

// ═══════════════════ ⑤ verifySketches 一站式 + 内存公式 ═══════════════════

section('⑤ verifySketches 一站式自检与内存公式对照');

{
  const stream = zipf;
  const bits = burstyBits(100000, 77);
  const report = verifySketches({
    stream,
    cms: { eps: 0.02, delta: 0.01, seed: 5 },
    reservoir: { k: 50, trials: 120, seed: 424242 },
    histogram: { eps: 0.1, window: 1000, bits },
    misraGries: { k: 9 },
  });
  console.log(
    `  报告: n=${report.n}, 去重键 ${report.distinct}, ‖a‖₁=${report.l1} | CMS 超出 ${report.cms.worstExcess.toFixed(1)}/${report.cms.bound.toFixed(0)} | 蓄水池 χ²/dof=${report.reservoir.chiSquareOverDof === null ? '—(λ<5)' : report.reservoir.chiSquareOverDof.toFixed(3)} | 直方图稠密最大相对误差 ${(report.histogram.maxRelErrorDense * 100).toFixed(3)}%`,
  );
  ok(report.cms.passed, `CMS 段: 只高不低 ${report.cms.oneSidedHolds} + 超出 ${report.cms.worstExcess.toFixed(1)} ≤ ${report.cms.bound.toFixed(0)}`);
  ok(
    report.reservoir.passed && report.reservoir.totalExact,
    `蓄水池段: 总入选 ${report.reservoir.totalPicked} === ${report.reservoir.totalExpected} 精确闭合 + 离散比 ${(report.reservoir.dispersion).toFixed(4)} ↔ 1−p=${(1 - report.reservoir.expectedRate).toFixed(4)}`,
  );
  ok(
    report.histogram.passed,
    `直方图段: 全位置界 ${report.histogram.boundHolds} + 合不变量 ${report.histogram.invariantHolds} + 稠密相对误差 ≤ 10%`,
  );
  ok(
    report.misraGries.passed && report.misraGries.missingHeavies.length === 0,
    `MG 段: 重元素 ${report.misraGries.heavyKeys.length} 个全捕获、假阳性 ${report.misraGries.falseHeavies.length}、计数下界 ${report.misraGries.countLowerBoundHolds}`,
  );
  ok(report.allPassed, `一站式 allPassed = true（四段保证同时成立）`);

  // 四结构内存上界公式 vs 实测
  const cmsCells = countMinSketchShape(0.02, 0.01).cells;
  const hist = new ExponentialHistogram({ eps: 0.1, window: 1000 });
  for (const b of bits) hist.insert(null, b === 1);
  const histStats = hist.stats();
  const mg = misraGries(stream, 9);
  ok(
    report.cms.cells === cmsCells && cmsCells === 136 * 5,
    `CMS 内存: 实测 ${report.cms.cells} 格 === 公式 w·d = ${cmsCells}（136×5）`,
  );
  ok(
    new ReservoirSampler(50, 1).capacity === 50,
    `蓄水池内存: 实测 50 格 === 公式 k = 50`,
  );
  ok(
    histStats.peakBuckets <= histStats.memoryBound,
    `直方图内存: 实测峰值 ${histStats.peakBuckets} 桶 ≤ 公式 (m+1)(⌊log₂W⌋+2) = ${histStats.memoryBound}`,
  );
  ok(
    mg.candidates.length <= 9,
    `MG 内存: 实测 ${mg.candidates.length} 计数器 ≤ 公式 k = 9`,
  );
}

// ═══════════════════ 构造校验拒绝 ═══════════════════

section('构造校验：非法输入显式拒绝');

throws(() => new CountMinSketch({ eps: 0, delta: 0.01 }), 'CMS eps=0 被拒绝');
throws(() => new CountMinSketch({ eps: 1.5, delta: 0.01 }), 'CMS eps=1.5 被拒绝');
throws(() => new CountMinSketch({ eps: 0.02, delta: 0 }), 'CMS delta=0 被拒绝');
throws(() => new CountMinSketch({ eps: 0.02, delta: 1 }), 'CMS delta=1 被拒绝');
throws(() => new CountMinSketch({ eps: 0.02, delta: 0.01, seed: NaN }), 'CMS seed=NaN 被拒绝');
throws(() => new CountMinSketch({ eps: 0.02, delta: 0.01 }).update('k', -1), 'CMS update c=−1 被拒绝');
throws(() => new CountMinSketch({ eps: 0.02, delta: 0.01 }).update('k', Infinity), 'CMS update c=∞ 被拒绝');
throws(() => new ReservoirSampler(0), 'ReservoirSampler k=0 被拒绝');
throws(() => new ReservoirSampler(2.5), 'ReservoirSampler k=2.5 被拒绝');
throws(() => new ReservoirSampler(5, NaN), 'ReservoirSampler seed=NaN 被拒绝');
throws(() => new ExponentialHistogram({ eps: 0.6, window: 10 }), 'EH eps=0.6（m<2 界退化）被拒绝');
throws(() => new ExponentialHistogram({ eps: 0, window: 10 }), 'EH eps=0 被拒绝');
throws(() => new ExponentialHistogram({ eps: 0.1, window: 0 }), 'EH window=0 被拒绝');
throws(() => new ExponentialHistogram({ eps: 0.1, window: 10.5 }), 'EH window=10.5 被拒绝');
throws(() => new ExponentialHistogram({ eps: 0.1, window: 10 }).insert(null, 'yes'), 'EH insert isOne 非布尔被拒绝');
throws(() => misraGries(['a'], 0), 'misraGries k=0 被拒绝');
throws(() => misraGries('abc', 2), 'misraGries 非数组流被拒绝');
throws(() => exponentialHistogramMemoryBound(0.1, 0), 'memoryBound window=0 被拒绝');
throws(
  () => verifySketches({ stream: ['a'], histogram: { bits: [0, 2] } }),
  'verifySketches bits 含 2 被拒绝',
);
throws(
  () => verifySketches({ stream: ['a'], histogram: { bits: [1], window: 5 } }),
  'verifySketches window > bits.length 被拒绝',
);
throws(() => verifySketches({ stream: [] }), 'verifySketches 空流被拒绝');
throws(
  () => verifySketches({ stream: ['a', 'b'], reservoir: { k: 5 } }),
  'verifySketches reservoir.k > n 被拒绝',
);

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
