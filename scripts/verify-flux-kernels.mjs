/**
 * verify-flux-kernels.mjs — 41.0→45.0 川流层五内核纯数学验证
 *
 * 验证锚点：
 *   41.0 排队网络：两站串联 M/M/1 事件模拟 → 端到端逗留 = Σ 解析值、
 *         Jackson 边际独立性（相关性 ≈ 0）、瓶颈站 = 最大 ρ
 *   42.0 谱周期：FFT 往返恒等 / Parseval / 已知周期恢复 / Fisher g
 *         纯噪声不显著、注入周期显著
 *   43.0 最大流：手算网络 max-flow=4、随机图 200 例与穷举最小割同解、
 *         割证书（割边全饱和 + 割容量 = 流值）
 *   44.0 公平分配：教科书注水解 [4/3,4/3,4/3,1]、公平支配性审计、
 *         加权按比例、等权重退化为经典、需求全满足时各取所需
 *   45.0 OCBA：Monte Carlo P(CS) 对照（OCBA ≥ 均匀）、预算守恒、
 *         下限保障、预算不足诚实退化
 *
 * 运行：npm run build && node scripts/verify-flux-kernels.mjs
 */

import {
  tandemNetwork,
  jacksonIndependenceAudit,
  minimalStableServers,
  bottleneckInsight,
  fft,
  ifft,
  periodogram,
  seasonalFactor,
  fisherGUpperTail,
  maxFlow,
  minCutCertificate,
  bruteForceMinCut,
  capacityFrontier,
  maxMinFair,
  weightedMaxMinFair,
  fairnessAudit,
  ocbaAllocate,
  monteCarloCorrectSelection,
} from '../dist/index.mjs';

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
function section(title) {
  console.log(`\n■ ${title}`);
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

// ═══════════════════ 41.0 排队网络 ═══════════════════

section('41.0 排队网络：串联 M/M/1 模拟对照 + Jackson 独立性');

{
  // 解析：站1 λ=0.5 μ=1（ρ=.5, Wq=1, 逗留 2）；站2 μ=2（ρ=.25, Wq=1/6, 逗留 2/3）
  const report = tandemNetwork([
    { name: 's1', lambdaPerMs: 0.5, muPerMs: 1, servers: 1 },
    { name: 's2', lambdaPerMs: 0.5, muPerMs: 2, servers: 1 },
  ]);
  ok(report.stable && Math.abs(report.endToEndSojournMs - 8 / 3) < 1e-9,
    `端到端逗留 = Σ(Wq + 1/μ) 解析值 8/3（实际 ${report.endToEndSojournMs.toFixed(6)}）`);
  ok(report.bottleneck?.name === 's1' && Math.abs(report.bottleneck.rho - 0.5) < 1e-9,
    `瓶颈站 = 最大 ρ（s1, ρ=${report.bottleneck ? report.bottleneck.rho : '—'}）`);
  ok(minimalStableServers([{ name: 'a', lambdaPerMs: 0.9, muPerMs: 0.4 }])[0] === 3,
    '最小服务员反解 ⌈λ/μ⌉ = 3');

  // 事件模拟：两站串联 M/M/1（FIFO），验证稳态队长边际独立 + 平均逗留
  const rng = mulberry32(20261013);
  const exp = (rate) => -Math.log(1 - Math.min(0.999999, rng())) / rate;
  let q1 = [];
  let q2 = [];
  let t = 0;
  let nextArrival = exp(0.5);
  let s1Busy = 0;
  let s2Busy = 0;
  const samples = [];
  const sojourns = [];
  for (let ev = 0; ev < 120_000; ev += 1) {
    const options = [
      { t: nextArrival, kind: 'arr' },
      ...(s1Busy > 0 ? [{ t: s1Busy, kind: 's1done' }] : []),
      ...(s2Busy > 0 ? [{ t: s2Busy, kind: 's2done' }] : []),
    ].sort((a, b) => a.t - b.t);
    const next = options[0];
    t = next.t;
    if (next.kind === 'arr') {
      q1.push(t);
      nextArrival = t + exp(0.5);
    } else if (next.kind === 's1done') {
      const arrived = q1.shift();
      if (arrived !== undefined) q2.push({ at: arrived, mid: t });
      s1Busy = 0;
    } else {
      const item = q2.shift();
      if (item !== undefined) sojourns.push(t - item.at);
      s2Busy = 0;
    }
    if (s1Busy === 0 && q1.length > 0) {
      s1Busy = t + exp(1);
    }
    if (s2Busy === 0 && q2.length > 0) s2Busy = t + exp(2);
    if (ev % 97 === 0 && ev > 20_000) samples.push([q1.length, q2.length]);
  }
  const audit = jacksonIndependenceAudit(samples);
  ok(Math.abs(audit.correlation) < 0.15,
    `Jackson 边际独立性：稳态队长相关性 ≈ 0（r=${audit.correlation.toFixed(3)}，n=${audit.samples}）`);
  const meanSojourn = sojourns.reduce((a, b) => a + b, 0) / sojourns.length;
  ok(Math.abs(meanSojourn - 8 / 3) < 0.15,
    `模拟平均逗留 ≈ 解析 2.667（${meanSojourn.toFixed(3)}，${sojourns.length} 顾客）`);

  const unstable = tandemNetwork([{ name: 'x', lambdaPerMs: 1.2, muPerMs: 1, servers: 1 }]);
  const insight = bottleneckInsight(unstable, 0.85);
  ok(insight !== undefined && insight.message.includes('不可稳定'),
    `λ > μc 时诚实给出不可稳定洞察（ρ=${unstable.bottleneck ? unstable.bottleneck.rho.toFixed(2) : '—'}）`);
}

// ═══════════════════ 42.0 谱周期 ═══════════════════

section('42.0 谱周期：FFT 恒等式 + 周期恢复 + Fisher g');

{
  const rng = mulberry32(20261014);
  const x = Array.from({ length: 128 }, () => rng() * 2 - 1);
  const spec = fft(x);
  const roundTrip = ifft(spec);
  const maxErr = Math.max(...x.map((v, i) => Math.abs(v - roundTrip[i])));
  ok(maxErr < 1e-9, `FFT 往返恒等（最大偏差 ${maxErr.toExponential(2)}）`);
  // Parseval: Σ_k |X_k|² = n · Σ x_t²
  const specEnergy = spec.reduce((s, c) => s + c.re * c.re + c.im * c.im, 0);
  const timeEnergy = 128 * x.reduce((s, v) => s + v * v, 0);
  ok(Math.abs(specEnergy - timeEnergy) / timeEnergy < 1e-9,
    `Parseval 定理（谱能量 ${specEnergy.toFixed(3)} = 时域 ${timeEnergy.toFixed(3)}）`);

  // 已知周期：k=8（周期 16 bins）+ 噪声 → 显著且频率恢复
  const g = mulberry32(20261015);
  const periodic = Array.from({ length: 128 }, (_, t) => 1 + 0.8 * Math.cos((2 * Math.PI * 8 * t) / 128) + 0.25 * (g() - 0.5));
  const report = periodogram(periodic);
  ok(report.significant && report.peaks[0] && Math.abs(report.peaks[0].frequency - 8) <= 1,
    `注入周期恢复（峰频 k=${report.peaks[0] ? report.peaks[0].frequency : '—'} ≈ 8，g=${report.g.toFixed(3)}, p=${report.pValue.toExponential(1)}）`);
  // 季节因子：信号 x_t = 1+0.8cos(2π·8t/128) 峰在 t≡0 (mod 16)，谷在 t≡8
  const factorAt = (phase) => seasonalFactor(periodic, ((phase % 128) + 128) % 128).factor;
  const f0 = factorAt(0);
  const f8 = factorAt(8);
  const f16 = factorAt(16);
  ok(f0 > f8 && f16 > f8, `相位感知季节因子（峰相位 t=0: ${f0.toFixed(2)} / t=16: ${f16.toFixed(2)} > 谷相位 t=8: ${f8.toFixed(2)}）`);

  // 纯噪声不显著（固定种子确定性）
  const noise = Array.from({ length: 128 }, () => g());
  const noiseReport = periodogram(noise);
  ok(!noiseReport.significant,
    `白噪声 Fisher g 不显著（g=${noiseReport.g.toFixed(3)}, p=${noiseReport.pValue.toFixed(3)} ≥ 0.05——诚实无节律）`);
  ok(seasonalFactor(noise, 5).factor === 1, `无显著周期 → 季节因子恒 1（零介入）`);
  // Fisher g 上侧概率边界：g→1 → p→0；g 小 → p→1
  ok(fisherGUpperTail(0.999, 20) < 1e-6 && fisherGUpperTail(0.01, 20) > 0.99, 'g 极端值单调正确');
}

// ═══════════════════ 43.0 最大流 ═══════════════════

section('43.0 最大流：手算网络 + 随机对照 + 割证书');

{
  // 手算：0→1(3), 0→2(2), 1→3(2), 2→3(3) → max-flow 4
  const cap = [
    [0, 3, 2, 0],
    [0, 0, 0, 2],
    [0, 0, 0, 3],
    [0, 0, 0, 0],
  ];
  const net = { nodes: 4, source: 0, sink: 3, capacity: cap, labels: ['s', 'a', 'b', 't'] };
  const result = maxFlow(net);
  ok(result.flowValue === 4, `手算网络 max-flow = 4（实际 ${result.flowValue}）`);
  const cert = minCutCertificate(net, result);
  ok(cert.saturated && cert.equalsFlow && cert.cutCapacity === 4,
    `割证书：割边全饱和、割容量 = 流值 = 4（Ford-Fulkerson 定理）`);

  // 随机 8 节点网络 vs 穷举最小割
  const rng = mulberry32(20261016);
  let agree = true;
  let certOk = true;
  for (let trial = 0; trial < 200; trial += 1) {
    const n = 8;
    const capacity = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (i !== j && rng() < 0.25) capacity[i][j] = 1 + Math.floor(rng() * 9);
      }
    }
    const r = maxFlow({ nodes: n, source: 0, sink: n - 1, capacity });
    const brute = bruteForceMinCut({ nodes: n, source: 0, sink: n - 1, capacity });
    if (Math.abs(r.flowValue - brute) > 1e-9) agree = false;
    const c = minCutCertificate({ nodes: n, source: 0, sink: n - 1, capacity }, r);
    if (!c.saturated || !c.equalsFlow) certOk = false;
  }
  ok(agree, `随机 200 例 max-flow = 穷举最小割（2^8 枚举对照）`);
  ok(certOk, `全部随机例割证书成立（饱和 + 容量等式）`);

  // 容量前沿：2 类型需求 [3,2] × 2 模型容量 [2,2] 全可达 → maxDispatch 4
  const frontier = capacityFrontier(
    [
      { type: 'a', count: 3 },
      { type: 'b', count: 2 },
    ],
    [
      { id: 'm1', capacity: 2 },
      { id: 'm2', capacity: 2 },
    ],
    () => true,
  );
  ok(frontier.maxDispatch === 4, `容量前沿 = 可立即满足的最大并发（${frontier.maxDispatch}）`);
  const restricted = capacityFrontier(
    [{ type: 'a', count: 3 }],
    [
      { id: 'm1', capacity: 2 },
      { id: 'm2', capacity: 2 },
    ],
    (_t, m) => m === 'm1',
  );
  ok(restricted.maxDispatch === 2 && restricted.modelLimited >= 1,
    `可达性受限时前沿收缩 + 模型侧钳制归因（${restricted.maxDispatch}，模型割边 ${restricted.modelLimited}）`);
}

// ═══════════════════ 44.0 公平分配 ═══════════════════

section('44.0 公平分配：教科书注水 + 支配性审计 + 加权');

{
  // 教科书例（Bertsekas–Gallager）：demands [2, 4, 2.4, 1]，容量 5
  const alloc = maxMinFair([2, 4, 2.4, 1], 5);
  const expect = [4 / 3, 4 / 3, 4 / 3, 1];
  ok(alloc.shares.every((s, i) => Math.abs(s - expect[i]) < 1e-9),
    `教科书注水解 [4/3, 4/3, 4/3, 1]（实际 [${alloc.shares.map((s) => s.toFixed(3)).join(', ')}]，水位 ${alloc.waterLevel.toFixed(3)}）`);
  const audit = fairnessAudit([2, 4, 2.4, 1], alloc.shares);
  ok(audit.fair, `公平支配性审计 0 违反（增长必挤更穷者）`);
  ok(alloc.shares.reduce((a, b) => a + b, 0) === 5, `份额守恒 = 容量 5`);

  // 需求全小于容量 → 各取所需
  const free = maxMinFair([1, 2, 0.5], 10);
  ok(free.shares.every((s, i) => Math.abs(s - [1, 2, 0.5][i]) < 1e-9) && free.deficit === 0,
    `容量充足时各取所需（无赤字）`);

  // 加权：[1,2] 权重、需求 [10,10]、容量 3 → [1,2]
  const weighted = weightedMaxMinFair([10, 10], [1, 2], 3);
  ok(Math.abs(weighted.shares[0] - 1) < 1e-9 && Math.abs(weighted.shares[1] - 2) < 1e-9,
    `加权注水按权重比例（[${weighted.shares.map((s) => s.toFixed(3)).join(', ')}]）`);
  // 等权重退化为经典
  const eqW = weightedMaxMinFair([2, 4, 2.4, 1], [1, 1, 1, 1], 5);
  ok(eqW.shares.every((s, i) => Math.abs(s - expect[i]) < 1e-6),
    `等权重加权口径 = 经典 max-min（退化一致性）`);
  const wAudit = fairnessAudit([10, 10], weighted.shares, [1, 2]);
  ok(wAudit.fair, `加权支配性审计（相对份额口径）0 违反`);
}

// ═══════════════════ 45.0 OCBA ═══════════════════

section('45.0 OCBA：P(CS) 对照 + 守恒 + 退化');

{
  // 延迟择优（越小越好）：best = idx 4（50ms）；非最优者等方差，
  // 公式方向干净——n_i ∝ (σ/δ)²，差距大者少分
  const candidates = [
    { name: 'a', mean: 100, std: 10 },
    { name: 'b', mean: 95, std: 10 },
    { name: 'c', mean: 90, std: 10 },
    { name: 'd', mean: 85, std: 10 },
    { name: 'e', mean: 50, std: 10 },
  ];
  const means = candidates.map((c) => c.mean);
  const stds = candidates.map((c) => c.std);
  const budget = 200;
  const plan = ocbaAllocate(candidates, budget, { biggerIsBetter: false, minSamples: 2 });
  ok(plan.total === budget && plan.counts.every((c) => c >= 2),
    `预算守恒（Σ=${plan.total} = ${budget}）且每候选 ≥ 下限`);
  ok(plan.best === 4, `最优者识别正确（idx=${plan.best}，50ms）`);
  ok(plan.counts[4] === Math.max(...plan.counts),
    `最优者（σ 最大）获得最多确认样本（best=${plan.counts[4]} vs 其余最大 ${Math.max(...plan.counts.slice(0, 4))}）`);
  ok(plan.counts[0] < plan.counts[3],
    `分配方向正确：等方差下差距大的 a（δ=${plan.gaps[0].toFixed(0)}）少于紧邻竞争者 d（δ=${plan.gaps[3].toFixed(0)}）：${plan.counts[0]} < ${plan.counts[3]}`);

  const uniform = Array.from({ length: 5 }, () => budget / 5);
  const pcsOcba = monteCarloCorrectSelection(means, stds, plan.counts, false, 3000);
  const pcsUniform = monteCarloCorrectSelection(means, stds, uniform, false, 3000);
  ok(pcsOcba >= pcsUniform - 0.005,
    `Monte Carlo P(CS)：OCBA ${pcsOcba.toFixed(3)} ≥ 均匀 ${pcsUniform.toFixed(3)}（3000 次）`);

  // 预算不足：诚实均匀退化
  const tiny = ocbaAllocate(candidates, 5, { minSamples: 2 });
  ok(tiny.counts.every((c) => c === 1) && tiny.total === 5, `预算 < k×下限 → 均匀最小分配退化`);
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n──────────────────────────────────────────────────────────');
if (failed === 0) {
  console.log(`✓ 川流层 41.0→45.0 五内核全部验证通过（${passed} 项断言）`);
} else {
  console.error(`✗ ${failed} 项失败（${passed} 项通过）`);
  process.exit(1);
}
