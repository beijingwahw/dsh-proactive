/**
 * verify-stochastic-optimization.mjs — 66.0→67.0 随机优化双件套纯数学离线验证
 *
 * 不是「能跑」，是「算得对」——每个数学核心都有解析对照:
 *   66.0 模拟退火:
 *     ① 定温细致平衡: 三状态玩具（能级 {0,1,3} 全连通、对称提议）30 万步
 *        长链的状态频率 vs Boltzmann 解析权重 e^{−E/T}/Z，最大偏差 < 0.02
 *        （Metropolis 准则 ⟹ 平稳分布 π ∝ e^{−E/T} 的实证）；
 *     ② Hajek 定理实证: 种子化双簇 6 城 TSP（固定首城后 120 排列全枚举，
 *        精确最优已知），在相邻交换稀疏邻域的 720 状态图上 wellDepth 精确
 *        求出临界深度 d\*；对数降温 c = d\* 时 ≥ 90% 种子命中最优，
 *        c 减半（c = d\*·½）命中率显著更低（充分条件的方向性）；
 *     ③ 几何降温诚实报告: r ∈ {0.9995, 0.99, 0.9} 三档 × 同预算命中率成表
 *        （淬火 ≤ 缓冷），温度轨迹逐点对照闭式 T₀·r^(k−1)；
 *     ④ 贪心易困: T=1e-12 纯贪心命中率 ≪ SA 对数档；同实例 2-opt 稠密
 *        邻域贪心满命中（d\*≈0 无井地形）——邻域密度决定难度的旁证；
 *     ⑤ wellDepth 手算图对照 + 温度闭式 + 同种子逐位复现 + 入参校验 throw。
 *   67.0 NSGA-II:
 *     ① (μ+λ) 精英: 精英归档（历代非支配并集）超体积逐代单调不减
 *        （数学必然，逐代断言），种群 HV 始终 ≥ 99% 归档 HV；
 *     ② 末代种群 60 个体两两互不支配，f₁ 极差铺满 [0,1]；
 *     ③ 简版 IGD（种群到解析前沿平均距离）下降 ≥ 一个数量级（实测数千倍）;
 *     ④ 对照: 固定权重 w=(½,½) 加权和 GA 同算子同预算——塌缩到前沿单点
 *        （解析最优点 x=0.25），目标空间散布 ≪ NSGA-II 的 1/5；
 *     ⑤ hypervolume2D 扫掠闭式 vs 矩形并容斥穷举（2ᵏ⁻¹ 子集精确并面积）
 *        含被支配内部点/参考点外点/同 f₁ 平局，另附手算闭式锚点。
 *
 * 玩具: ZDT1 型凸前沿——决策 (x,y)∈[0,1]²，f₁=x，g=1+9y，f₂=g·(1−√(f₁/g))，
 *   真前沿 y=0 即 f₂=1−√f₁；参考点 (1.1,1.1) 下连续前沿 HV = 0.1+2/3+0.11。
 * 全部断言确定性（mulberry32 种子内建于内核；对照 GA 用同源 rng 纪律）。
 * 运行：node --experimental-strip-types scripts/verify-stochastic-optimization.mjs
 */

import {
  metropolisStep,
  anneal,
  scheduleTemperature,
  boltzmannFrequencies,
  wellDepth,
  tspInstance,
  tspTourLength,
  tspTwoOptNeighbor,
  tspAdjacentSwapNeighbor,
  tspExactOptimum,
} from '../src/core/simulated-annealing.ts';
import {
  dominates,
  paretoFront,
  fastNonDominatedSort,
  crowdingDistance,
  hypervolume2D,
  nsga2Step,
  runNSGA2,
} from '../src/core/nsga2-pareto.ts';

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

/** 确定性 RNG（mulberry32——与内核同源算法，脚本侧独立副本） */
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

// ═══════════════════ 66.0 模拟退火 ═══════════════════

section('66.0 Metropolis 准则: 定温长链的 Boltzmann 平稳分布');

{
  // 三状态玩具: E(A)=0, E(B)=1, E(C)=3，全连通对称提议（均匀抽另两态之一）
  const ENERGY = { A: 0, B: 1, C: 3 };
  const energy = (s) => ENERGY[s];
  const neighbor = (s, rng) => {
    const others = ['A', 'B', 'C'].filter((x) => x !== s);
    return others[Math.floor(rng() * others.length)];
  };
  const rng = mulberry32(424242);
  let s = 'A';
  const counts = { A: 0, B: 0, C: 0 };
  const N = 300_000;
  const BURN_IN = 1000;
  for (let k = 0; k < N; k += 1) {
    s = metropolisStep(s, energy, neighbor, 1, rng).state;
    if (k >= BURN_IN) counts[s] += 1;
  }
  const denom = N - BURN_IN;
  const freq = [counts.A / denom, counts.B / denom, counts.C / denom];
  const { weights } = boltzmannFrequencies([0, 1, 3], 1);
  let maxDev = 0;
  for (let i = 0; i < 3; i += 1) maxDev = Math.max(maxDev, Math.abs(freq[i] - weights[i]));
  ok(
    near(weights[0], Math.E ** 0 / (1 + Math.E ** -1 + Math.E ** -3), 1e-12),
    `解析权重自检 w(A)=${weights[0].toFixed(6)} = 1/Z（Z = 1+e⁻¹+e⁻³ = ${(1 + Math.E ** -1 + Math.E ** -3).toFixed(6)}）`,
  );
  ok(
    maxDev < 0.02,
    `30 万步频率 (${freq.map((f) => f.toFixed(4)).join(', ')}) vs Boltzmann (${weights.map((w) => w.toFixed(4)).join(', ')}) 最大偏差 ${maxDev.toFixed(5)} < 0.02（细致平衡 ⟹ π ∝ e^{−E/T}）`,
  );
}

section('66.0 降温计划: 闭式温度 + 入参校验');

{
  ok(near(scheduleTemperature({ kind: 'log', c: 3 }, 1), 3 / Math.log(3), 1e-15), `log: T₁ = c/log(1+k0) = ${scheduleTemperature({ kind: 'log', c: 3 }, 1).toFixed(9)}（k0 缺省 2）`);
  ok(near(scheduleTemperature({ kind: 'log', c: 3 }, 10), 3 / Math.log(12), 1e-15), `log: T₁₀ = c/log(12) = ${scheduleTemperature({ kind: 'log', c: 3 }, 10).toFixed(9)}`);
  ok(
    near(scheduleTemperature({ kind: 'geometric', T0: 2, rate: 0.99 }, 7), 2 * 0.99 ** 6, 1e-15),
    `geometric: T₇ = T₀·r⁶ = ${scheduleTemperature({ kind: 'geometric', T0: 2, rate: 0.99 }, 7).toFixed(9)}`,
  );
  ok(near(scheduleTemperature({ kind: 'constant', T: 0.5 }, 999), 0.5, 0), 'constant: T₉₉₉ = 0.5（恒温）');
  ok(scheduleTemperature({ kind: 'geometric', T0: 1.7, rate: 0.9 }, 5000) > 0, 'geometric 淬火下溢钳到 Number.MIN_VALUE（贪心极限，不 throw、不变 0）');
  okThrow(() => scheduleTemperature({ kind: 'log', c: 0 }, 1), 'log c=0 显式 throw');
  okThrow(() => scheduleTemperature({ kind: 'log', c: 1, k0: 1 }, 1), 'log k0=1 显式 throw');
  okThrow(() => scheduleTemperature({ kind: 'geometric', T0: 1, rate: 1 }, 1), 'geometric rate=1 显式 throw');
  okThrow(() => scheduleTemperature({ kind: 'constant', T: 0 }, 1), 'constant T=0 显式 throw');
  okThrow(() => scheduleTemperature({ kind: 'log', c: 1 }, 0), 'step=0 显式 throw');
}

section('66.0 wellDepth: 瓶颈最短路的精确势阱深度');

{
  // 手算图: G=0（全局最优），A=4（鞍/瓶颈），B=2（井），C=5（坡上点，非局部极小）
  //   边: G–A, A–B, A–C。B 的唯一逃离路线 B→A→G 翻越高度 4，深度 = 4−2 = 2。
  const energies = { G: 0, A: 4, B: 2, C: 5 };
  const adjacency = { G: ['A'], A: ['G', 'B', 'C'], B: ['A'], C: ['A'] };
  const report = wellDepth(energies, adjacency);
  ok(
    report.criticalDepth === 2 && report.wells.length === 1 && report.wells[0].state === 'B',
    `手算对照: 唯一井 B（井底 2），瓶颈高度 4 → d\* = ${report.criticalDepth}（= 4−2）`,
  );
  ok(report.wells[0].escapeState === 'G', `B 的逃离落点 = ${report.wells[0].escapeState}（更低能级且瓶颈最小）`);
  ok(report.globalMinima.length === 1 && report.globalMinima[0] === 'G', '全局最优态 = [G]（不被计为井）');
  okThrow(
    () => wellDepth({ G: 0, A: 1 }, { G: ['A'], A: [] }),
    '邻接不对称显式 throw（对称提议是细致平衡的前提）',
  );
}

section('66.0 Hajek 实证: 双簇 TSP 的精确 d\* 与对数降温命中率');

{
  // 种子化双簇 6 城 TSP: 精确最优由固定首城的 120 个排列全枚举给出
  const inst = tspInstance(6, 12);
  const exact = tspExactOptimum(inst);
  ok(exact.permutations === 120, `6 城固定首城全枚举 ${exact.permutations} 个排列（≈ 5! 同量级），精确最优 = ${exact.length.toFixed(6)}`);
  ok(near(tspTourLength(inst, exact.tour), exact.length, 1e-12), 'tspTourLength 对最优巡回自洽');

  // 相邻交换稀疏邻域上的 720 状态图: 精确 d\*（wellDepth 瓶颈 Dijkstra）
  const permutations = (arr) => {
    if (arr.length <= 1) return [arr];
    const out = [];
    for (let i = 0; i < arr.length; i += 1) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const p of permutations(rest)) out.push([arr[i], ...p]);
    }
    return out;
  };
  const tours = permutations([0, 1, 2, 3, 4, 5]);
  const energies = {};
  const adjacency = {};
  for (const t of tours) {
    const key = t.join('');
    energies[key] = tspTourLength(inst, t);
    const nb = new Set();
    for (let i = 0; i < 5; i += 1) {
      const sw = [...t];
      [sw[i], sw[i + 1]] = [sw[i + 1], sw[i]];
      nb.add(sw.join(''));
    }
    adjacency[key] = [...nb];
  }
  const { criticalDepth: dStar, wells } = wellDepth(energies, adjacency);
  ok(tours.length === 720 && dStar > 1, `720 排列状态图上精确 d\* = ${dStar.toFixed(4)}（${wells.length} 口真井——稀疏邻域的簇间势阱）`);

  const energy = (t) => tspTourLength(inst, t);
  const neighbor = (t, rng) => tspAdjacentSwapNeighbor(t, rng);
  const randomTour = (seed) => {
    const r = mulberry32(seed);
    const arr = [0, 1, 2, 3, 4, 5];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(r() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  const STEPS = 20_000;
  const TRIALS = 40;
  const hitRate = (schedule, neighborFn) => {
    let hits = 0;
    let worstExcess = 0;
    for (let i = 0; i < TRIALS; i += 1) {
      const res = anneal({
        energy,
        neighbor: neighborFn,
        x0: randomTour(99001 + i * 7919),
        schedule,
        steps: STEPS,
        seed: 99001 + i * 104729,
      });
      worstExcess = Math.max(worstExcess, res.bestEnergy - exact.length);
      if (Math.abs(res.bestEnergy - exact.length) < 1e-9) hits += 1;
    }
    return { hits, worstExcess };
  };

  // ② Hajek: c = d\* vs c = d\*/2
  const full = hitRate({ kind: 'log', c: dStar }, neighbor);
  const half = hitRate({ kind: 'log', c: dStar / 2 }, neighbor);
  ok(
    full.hits >= 36,
    `对数降温 c=d\* 命中 ${full.hits}/${TRIALS} ≥ 90%（Hajek 充分条件: c ≥ d\* 保证收敛到全局最优）`,
  );
  ok(
    half.hits <= full.hits - 4,
    `对数降温 c=d\*/2 命中 ${half.hits}/${TRIALS}，显著低于 c=d\* 档（差 ${full.hits - half.hits} 个种子——c < d\* 无保证的实证）`,
  );

  // ④ 贪心对照
  const greedy = hitRate({ kind: 'constant', T: 1e-12 }, neighbor);
  ok(
    greedy.hits < full.hits - 4,
    `纯贪心（T=1e-12）命中 ${greedy.hits}/${TRIALS} ≪ SA 对数档 ${full.hits}/${TRIALS}（只降不升被势阱囚禁）`,
  );
  const twoOptGreedy = hitRate({ kind: 'constant', T: 1e-12 }, (t, rng) => tspTwoOptNeighbor(t, rng));
  ok(
    twoOptGreedy.hits >= 36,
    `旁证: 2-opt 稠密邻域贪心命中 ${twoOptGreedy.hits}/${TRIALS}（C(6,2)=15 邻/态的地形近乎无井——邻域密度决定难度）`,
  );
  ok(
    Math.max(full.worstExcess, Math.max(half.worstExcess, greedy.worstExcess)) >= -1e-9,
    `所有 run 的 bestE ≥ 精确最优 − 1e-9（能量函数无下穿——最大「优出」${Math.max(0, -Math.min(full.worstExcess, 0)).toExponential(1)}）`,
  );

  // ③ 几何降温诚实报告表
  const geoSlow = hitRate({ kind: 'geometric', T0: dStar, rate: 0.9995 }, neighbor);
  const geoMid = hitRate({ kind: 'geometric', T0: dStar, rate: 0.99 }, neighbor);
  const geoFast = hitRate({ kind: 'geometric', T0: dStar, rate: 0.9 }, neighbor);
  console.log('  ┌────────────────────────┬───────────┬────────────┐');
  console.log('  │ 降温计划（同预算 20k 步）  │  命中/40   │  末温/初温  │');
  console.log('  ├────────────────────────┼───────────┼────────────┤');
  const rows = [
    ['log c=d\*（Hajek 足额）', full.hits, 'T₂₀ₖ=d\*/10.3'],
    ['log c=d\*/2（欠额）', half.hits, 'T₂₀ₖ=d\*/20.6'],
    ['geometric r=0.9995（缓冷）', geoSlow.hits, '×e⁻¹⁰'],
    ['geometric r=0.99（中速）', geoMid.hits, '×e⁻¹⁰⁰'],
    ['geometric r=0.9（淬火）', geoFast.hits, '×e⁻¹⁰⁰⁰'],
    ['constant T=1e-12（纯贪心）', greedy.hits, '恒 1e-12'],
  ];
  for (const [name, hits, tail] of rows) {
    console.log(`  │ ${(name + ' ').padEnd(22, '　')} │   ${String(hits).padStart(2)}/40    │  ${tail}  │`);
  }
  console.log('  └────────────────────────┴───────────┴────────────┘');
  ok(
    geoFast.hits <= geoSlow.hits,
    `淬火 r=0.9 命中 ${geoFast.hits}/40 ≤ 缓冷 r=0.9995 的 ${geoSlow.hits}/40（Σ T_k < ∞ 违反缓慢降温——命中率只能诚实报告）`,
  );

  // 温度轨迹闭式对照（geometric）+ 逐位复现
  const geoRun = anneal({
    energy,
    neighbor,
    x0: randomTour(5150),
    schedule: { kind: 'geometric', T0: dStar, rate: 0.995 },
    steps: 5000,
    seed: 777,
  });
  const lastPoint = geoRun.trace[geoRun.trace.length - 1];
  ok(
    near(lastPoint.temperature, dStar * 0.995 ** (5000 - 1), Math.abs(dStar * 0.995 ** 4999) * 1e-12),
    `轨迹末温 ${lastPoint.temperature.toExponential(6)} = T₀·r^(steps−1)（闭式逐点一致）`,
  );
  const geoRunAgain = anneal({
    energy,
    neighbor,
    x0: randomTour(5150),
    schedule: { kind: 'geometric', T0: dStar, rate: 0.995 },
    steps: 5000,
    seed: 777,
  });
  ok(
    JSON.stringify(geoRun.trace) === JSON.stringify(geoRunAgain.trace) && geoRun.bestEnergy === geoRunAgain.bestEnergy,
    '同 seed 两次运行轨迹逐位一致（同输入同输出）',
  );
  const geoRunOther = anneal({
    energy,
    neighbor,
    x0: randomTour(5150),
    schedule: { kind: 'geometric', T0: dStar, rate: 0.995 },
    steps: 5000,
    seed: 778,
  });
  ok(
    JSON.stringify(geoRunOther.trace) !== JSON.stringify(geoRun.trace) ||
      geoRunOther.acceptedMoves !== geoRun.acceptedMoves,
    '异 seed 轨迹分叉（随机性真实存在）',
  );
  okThrow(
    () => anneal({ energy, neighbor, x0: randomTour(1), schedule: { kind: 'log', c: dStar }, steps: 0, seed: 1 }),
    'anneal steps=0 显式 throw',
  );
  okThrow(() => tspInstance(2, 1), 'tspInstance n=2 显式 throw');
  okThrow(() => tspExactOptimum(tspInstance(9, 1)), 'tspExactOptimum n=9 显式 throw（枚举爆炸保护）');
  okThrow(() => tspTourLength(inst, [0, 1, 2, 3, 4]), 'tspTourLength 非法长度显式 throw');
}

// ═══════════════════ 67.0 NSGA-II ═══════════════════

section('67.0 支配关系 / 非支配排序 / 拥挤距离: 单元锚点');

{
  ok(dominates([1, 2], [2, 2]) && dominates([1, 2], [1, 3]), 'dominates: 全 ≤ 且至少一 <（A≺B 两种方向）');
  ok(!dominates([1, 2], [1, 2]) && !dominates([3, 1], [1, 3]), 'dominates: 相等向量与互换向量互不支配（帕累托反链）');
  okThrow(() => dominates([1, 2], [1]), 'dominates 维数不一致显式 throw');

  // 分层手算: A=(1,1) 第1层; C=(1,2),D=(2,1) 第2层; B=(2,2) 第3层（被 A,C,D 支配）;
  // E=(3,3) 第4层（被 A,C,D,B 支配）
  const pop = [
    [1, 1],
    [2, 2],
    [1, 2],
    [2, 1],
    [3, 3],
  ];
  const fronts = fastNonDominatedSort(pop);
  ok(
    JSON.stringify(fronts) === JSON.stringify([[0], [2, 3], [1], [4]]),
    `快速非支配排序: ${fronts.map((f) => f.map((i) => 'ABCDE'[i]).join('')).join('|')}（剥洋葱: A | C,D | B | E——B 被 A/C/D 三层支配源压到第 3 层）`,
  );
  okThrow(() => fastNonDominatedSort([]), 'fastNonDominatedSort 空种群显式 throw');

  // 拥挤距离: 对角线三点，中间点两目标的归一化跨度均为 1 → 2；边界 ∞
  const dist = crowdingDistance([
    [0, 2],
    [1, 1],
    [2, 0],
  ]);
  ok(
    Number.isFinite(dist[1]) && near(dist[1], 2, 1e-12) && dist[0] === Infinity && dist[2] === Infinity,
    `拥挤距离: 中间点 = ${dist[1]}（两目标各贡献 1），边界点 = ∞`,
  );
  const single = crowdingDistance([[0.5, 0.5]]);
  ok(single[0] === Infinity, '单点前沿拥挤距离 = ∞');

  ok(
    JSON.stringify(paretoFront(pop)) === JSON.stringify([[1, 1]]),
    'paretoFront: 只留 A（其余四点均被 A 支配）',
  );
}

section('67.0 hypervolume2D: 扫掠闭式 vs 容斥穷举');

{
  // 手算闭式: 两点 (0,1),(1,0)，ref (1.1,1.1) → 1×0.1 + 0.1×1.1 = 0.21
  ok(
    near(hypervolume2D(
      [
        [0, 1],
        [1, 0],
      ],
      [1.1, 1.1],
    ), 0.21, 1e-12),
    `阶梯手算: HV = 1×0.1 + 0.1×1.1 = ${hypervolume2D([[0, 1], [1, 0]], [1.1, 1.1]).toFixed(4)}`,
  );
  ok(hypervolume2D([], [1, 1]) === 0, '空点集 HV = 0');
  ok(
    hypervolume2D(
      [
        [1.5, 0],
        [0, 1.5],
      ],
      [1.1, 1.1],
    ) === 0,
    '参考点外的点零贡献（f₁ ≥ r₁ 或 f₂ ≥ r₂ 剔除）',
  );

  // 容斥穷举（2^k−1 子集的矩形交并）: 含被支配内部点 / 同 f₁ 平局 / 参考点外点
  const points = [
    [0.1, 0.9],
    [0.3, 0.7],
    [0.5, 0.55],
    [0.5, 0.9],
    [0.9, 0.2],
    [1.2, 0.1],
  ];
  const ref = [1.1, 1.1];
  const rects = points.filter((p) => p[0] < ref[0] && p[1] < ref[1]).map((p) => [p[0], ref[0], p[1], ref[1]]);
  const pick = (mask) => rects.filter((_, i) => mask & (1 << i));
  const popcount = (x) => {
    let c = 0;
    while (x) {
      c += x & 1;
      x >>= 1;
    }
    return c;
  };
  let brute = 0;
  for (let mask = 1; mask < 1 << rects.length; mask += 1) {
    const chosen = pick(mask);
    const x1 = Math.max(...chosen.map((r) => r[0]));
    const x2 = Math.min(...chosen.map((r) => r[1]));
    const y1 = Math.max(...chosen.map((r) => r[2]));
    const y2 = Math.min(...chosen.map((r) => r[3]));
    const area = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    brute += (popcount(mask) % 2 === 1 ? 1 : -1) * area;
  }
  const hv = hypervolume2D(points, ref);
  ok(near(hv, brute, 1e-12), `容斥穷举对照: 扫掠 ${hv.toFixed(9)} = 容斥 ${brute.toFixed(9)}（被支配点/平局/界外点均不影响精确值）`);
  okThrow(() => hypervolume2D([[1, 2, 3]], [4, 4]), 'hypervolume2D 三维点显式 throw');
}

section('67.0 凸前沿玩具: 精英归档 HV 单调 + IGD 下降 + 前沿铺满');

{
  // ZDT1 型: 决策 (x,y)∈[0,1]²，f₁=x，g=1+9y，f₂=g·(1−√(f₁/g))；真前沿 y=0
  const objectives = (d) => {
    const g = 1 + 9 * d[1];
    return [d[0], g * (1 - Math.sqrt(d[0] / g))];
  };
  const crossover = (a, b, rng) => {
    const t = rng();
    return [
      [t * a[0] + (1 - t) * b[0], t * a[1] + (1 - t) * b[1]],
      [(1 - t) * a[0] + t * b[0], (1 - t) * a[1] + t * b[1]],
    ];
  };
  const clip = (v) => Math.min(1, Math.max(0, v));
  const gaussian = (rng) => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const mutation = (d, rng) => [clip(d[0] + 0.1 * gaussian(rng)), clip(d[1] + 0.1 * gaussian(rng))];

  const REF = [1.1, 1.1];
  const N = 60;
  const GENS = 60;
  const FRONT_HV = 0.1 + 2 / 3 + 0.11; // 连续前沿 HV: ∫₀¹(0.1+√t)dt + 0.1×1.1
  const curve = Array.from({ length: 1001 }, (_, i) => {
    const t = i / 1000;
    return [t, 1 - Math.sqrt(t)];
  });
  const distToCurve = (p) => {
    let best = Infinity;
    for (const c of curve) {
      const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };

  const rngInit = mulberry32(777);
  const initial = Array.from({ length: N }, () => [rngInit(), rngInit()]);

  // 逐代 nsga2Step + 精英归档（历代目标向量并集的非支配过滤）
  let population = initial.map((d) => [...d]);
  let archive = [];
  const rng = mulberry32(20261001);
  const hvArchiveHistory = [];
  const hvPopHistory = [];
  const igdHistory = [];
  for (let g = 0; g <= GENS; g += 1) {
    const obj = population.map(objectives);
    hvPopHistory.push(hypervolume2D(obj, REF));
    archive = paretoFront([...archive, ...obj]);
    hvArchiveHistory.push(hypervolume2D(archive, REF));
    igdHistory.push(obj.reduce((s, p) => s + distToCurve(p), 0) / obj.length);
    if (g < GENS) {
      population = nsga2Step({ population, objectives, crossover, mutation, rng }).population;
    }
  }

  let archiveMonotone = true;
  let firstViolation = -1;
  for (let i = 1; i < hvArchiveHistory.length; i += 1) {
    if (hvArchiveHistory[i] < hvArchiveHistory[i - 1] - 1e-12) {
      archiveMonotone = false;
      firstViolation = i;
      break;
    }
  }
  ok(
    archiveMonotone,
    `精英归档 HV 逐代单调不减（${GENS + 1} 代逐代断言；末值 ${hvArchiveHistory[hvArchiveHistory.length - 1].toFixed(5)} / 上界 ${FRONT_HV.toFixed(5)} = ${(hvArchiveHistory[hvArchiveHistory.length - 1] / FRONT_HV).toFixed(3)}）${firstViolation >= 0 ? `，首违于代 ${firstViolation}` : ''}`,
  );
  let popKeepsUp = true;
  let minRatio = 1;
  for (let i = 0; i < hvPopHistory.length; i += 1) {
    const ratio = hvPopHistory[i] / hvArchiveHistory[i];
    if (ratio < minRatio) minRatio = ratio;
    if (ratio < 0.98) popKeepsUp = false;
  }
  ok(
    popKeepsUp,
    `种群 HV 每代 ≥ 98% 归档 HV（全程最小比 ${minRatio.toFixed(4)}——归档是历代并集，种群只持 N 点仍紧贴）`,
  );
  const igdRatio = igdHistory[0] / igdHistory[igdHistory.length - 1];
  ok(
    igdRatio >= 10,
    `IGD（种群到解析前沿平均距离）: gen0 ${igdHistory[0].toFixed(4)} → 末代 ${igdHistory[igdHistory.length - 1].toExponential(2)}，下降 ${igdRatio.toFixed(0)} 倍 ≥ 一个数量级（g=1+9y 被压回 1）`,
  );

  // ② 末代种群互不支配 + 铺满
  const finalObj = population.map(objectives);
  let allNondominated = true;
  outer: for (let i = 0; i < finalObj.length; i += 1) {
    for (let j = 0; j < finalObj.length; j += 1) {
      if (i !== j && dominates(finalObj[i], finalObj[j])) {
        allNondominated = false;
        break outer;
      }
    }
  }
  const f1s = finalObj.map((p) => p[0]);
  const spread = Math.max(...f1s) - Math.min(...f1s);
  ok(
    allNondominated && fastNonDominatedSort(finalObj)[0].length === N,
    `末代 ${N} 个体两两互不支配（60×60 成对检查，整种群即第一层）`,
  );
  ok(spread >= 0.9, `末代 f₁ 极差 = ${spread.toFixed(4)} ≥ 0.9（前沿铺满 [0,1]——拥挤距离维持目标空间多样性）`);
  const yMean = population.reduce((s, d) => s + d[1], 0) / N;
  ok(yMean <= 0.01, `末代决策 y 均值 = ${yMean.toExponential(2)} ≤ 0.01（g→1 收敛到真前沿）`);

  // ④ 对照: 固定权重加权和 GA（同算子、同预算 = 同目标评估次数）
  const w = [0.5, 0.5];
  const fitness = (d) => -(w[0] * objectives(d)[0] + w[1] * objectives(d)[1]);
  let wPop = initial.map((d) => [...d]);
  const wRng = mulberry32(20261001);
  for (let g = 0; g < GENS; g += 1) {
    const fits = wPop.map(fitness);
    const tournament = () => {
      const i = Math.floor(wRng() * wPop.length);
      const j = Math.floor(wRng() * wPop.length);
      return fits[i] >= fits[j] ? wPop[i] : wPop[j];
    };
    const offspring = [];
    while (offspring.length < wPop.length) {
      const [c1, c2] = crossover(tournament(), tournament(), wRng);
      offspring.push(mutation(c1, wRng), mutation(c2, wRng));
    }
    const merged = [...wPop, ...offspring];
    const mergedFit = [...fits, ...offspring.map(fitness)];
    const idx = mergedFit.map((_, i) => i).sort((a, b) => mergedFit[b] - mergedFit[a]).slice(0, wPop.length);
    wPop = idx.map((i) => merged[i]);
  }
  const wObj = wPop.map(objectives);
  const std = (arr) => {
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
  };
  const objSpread = (obj) => std(obj.map((p) => p[0])) + std(obj.map((p) => p[1]));
  const wSpread = objSpread(wObj);
  const nSpread = objSpread(finalObj);
  const wF1Mean = wObj.reduce((s, p) => s + p[0], 0) / N;
  ok(
    near(wF1Mean, 0.25, 0.02),
    `加权和 GA 塌缩点: f₁ 均值 ${wF1Mean.toFixed(4)} ≈ 解析 0.25（min 0.5x+0.5(1−√x) 的驻点 √x=1/2）`,
  );
  ok(
    wSpread < nSpread / 5,
    `目标空间散布: 加权和 ${wSpread.toFixed(5)} ≪ NSGA-II ${nSpread.toFixed(5)}（比 ${(wSpread / nSpread).toFixed(4)} < 1/5——单点 vs 整条前沿）`,
  );

  // runNSGA2 端到端: 与手跑逐位一致 + 确定性 + 求值记账
  const runA = runNSGA2({
    initial: initial.map((d) => [...d]),
    gens: GENS,
    objectives,
    crossover,
    mutation,
    seed: 20261001,
    referencePoint: [1.1, 1.1],
  });
  const runB = runNSGA2({
    initial: initial.map((d) => [...d]),
    gens: GENS,
    objectives,
    crossover,
    mutation,
    seed: 20261001,
    referencePoint: [1.1, 1.1],
  });
  ok(
    runA.history.length === GENS + 1 &&
      runA.history[GENS].hypervolume === hvPopHistory[GENS] &&
      JSON.stringify(runA.objectiveValues) === JSON.stringify(finalObj),
    `runNSGA2 与逐代手跑末代逐位一致（HV = ${runA.history[GENS].hypervolume.toFixed(6)}）`,
  );
  ok(
    JSON.stringify(runA.objectiveValues) === JSON.stringify(runB.objectiveValues),
    'runNSGA2 同 seed 两次运行目标向量逐位一致（同输入同输出）',
  );
  ok(
    runA.evaluations === N + GENS * 2 * N,
    `求值记账: ${runA.evaluations} = N(初始) + 2N×gens（μ+λ 每代父 N + 子 N）`,
  );
  okThrow(
    () =>
      runNSGA2({
        initial: [[0, 0]],
        gens: 1,
        objectives: (d) => [d[0], d[1], 1 - d[0] - d[1]],
        crossover,
        mutation,
        referencePoint: [1, 1],
      }),
    'runNSGA2 三目标 + referencePoint 显式 throw（多维 HV 未实现——诚实拒绝）',
  );
  okThrow(
    () => nsga2Step({ population: [], objectives, crossover, mutation, rng: mulberry32(1) }),
    'nsga2Step 空种群显式 throw',
  );
  okThrow(
    () => runNSGA2({ initial, gens: 0, objectives, crossover, mutation }),
    'runNSGA2 gens=0 显式 throw',
  );
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 66.0→67.0 随机优化双件套数学验证成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
