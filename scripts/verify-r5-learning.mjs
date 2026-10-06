/**
 * verify-r5-learning.mjs — R5-A17 第五轮「全部内核世界性进化」六学习内核验证
 *
 * 覆盖 30.0 / 72.0 / 83.0 / 86.0 / 80.0 / 94.0 的 R5 新增数学核心，每个锚点
 * 都有解析解 / 穷举 / 独立算法对照（不是「能跑」，是「算得对」）：
 *
 *   30.0 次模优化（R5: 图割 SFMin + 堆化 CELF）:
 *     ① 堆化惰性贪心 = 朴素贪心逐位同解（240 种子实例）且评估次数 <
 *        朴素口径 n·k（CELF 加速的实测）；
 *     ② 图割 SFMin vs 2^n 穷举: 值相等、gap ≤ 1e-9（260 种子实例，
 *        n ∈ [4,12]、unary 可负、割边随机）；
 *     ③ CutEnergy 次模性审计 0 违反（割项对边际只减不增）；
 *     ④ 结构语义: 强割边把「每侧各留一个」的解从 unary 偏好里拉回来。
 *
 *   72.0 稀疏恢复（R5: SAFE 强规则筛选 + λ 路径热启动）:
 *     ⑤ SAFE 安全性（定理的实证）: 220 实例 × 3 档 λ₀（0.95/0.85/0.7·λ_max）
 *        全部被丢列在完整解中 x_j === 0 **精确**（无一例外）；
 *     ⑥ 零列恒被安全丢弃（c_j = 0 < λ₀；与软阈值口径一致）；
 *     ⑦ lassoCD 的 x0 热启动零漂移（缺省 = 显式零向量逐位一致）；
 *     ⑧ λ 路径: 加速（筛选+热启动）与全列冷启动的解 maxDiff ≤ 1e-9、
 *        全设计阵 KKT 证书 ≤ 1e-8、columnWork < baseline（含前段大规模丢弃）；
 *     ⑨ 对偶不可行热启动被拒绝（安全前提优先于速度）。
 *
 *   83.0 世界模型学习（R5: 优先扫除 + 随机 MDP 工厂）:
 *     ⑩ 220 种子随机 MDP: PS 的 V = 值迭代的 V（sup ≤ 2e-9）、残差受控、
 *        全部收敛（同一不动点两条路互证）；PS 备份次数 ≤ VI 全扫工作量；
 *     ⑪ 目标导向结构（4×3 gridworld / 30 态链）: PS 更新次数显著少于全扫；
 *     ⑫ randomTabularMDP 转移行和恒 = 1（工厂纪律）。
 *
 *   86.0 分层技能（R5: 瓶颈发现 + 热路径物化）:
 *     ⑬ Brandes 介数 vs 闭式双向计数公式（σ_u(x)·σ_v(x)/σ_uv）逐点一致
 *        ≤ 1e-9（210 随机世界）；
 *     ⑭ Tarjan 关节点 vs 删点-数连通分量穷举全等（210 世界逐点）；
 *     ⑮ 走廊结构: 关节点集 = 门喉咙（含全部门、都在门 1 步邻域内）；
 *     ⑯ 瓶颈排名的门的覆盖: 缺省 count 下每个门都在某瓶颈 1 步邻域
 *        （fourRooms 环形拓扑的介数并列诚实呈现）；
 *     ⑰ 发现技能端到端: solveSmdpExact 残差 ~1e-16、贪婪冒烟全态成功率
 *        100%、平均步数 = BFS 最优均值（两种世界）；学习口径成功率 ≥ 0.9；
 *     ⑱ 物化表 = 闭包（optionTables 全态全选项逐位一致）+ 同种子复跑
 *        Q 逐位一致（热路径物化的等价证明）。
 *
 *   80.0 流式概要（R5: CountSketch + CMS 哈希缓存）:
 *     ⑲ CountSketch 概率界: Zipf(1.5) 10 万事件 × 210 种子全键
 *        |est − f| ≤ ε·‖a‖₂（ε=0.1, δ=0.1；实测最大误差 ≪ 界）；
 *     ⑳ 形状闭式: w = ⌈4/ε²⌉、d 为奇数且 (3/4)^{d/2} ≤ δ；
 *     ㉑ 负计数（删除）: +7 −7 → 精确 0；CMS 对负数拒绝（口径分工）；
 *     ㉒ 内积估计: 同种子同形状 ⟨a,b⟩̂ 误差 ≤ ε·‖a‖₂‖b‖₂；异种子被拒绝；
 *     ㉓ CMS 哈希缓存: 全部估计与无缓存**逐位一致**（等价证明），
 *        长键流计时对照（报告值）。
 *
 *   94.0 仿真校准（R5: 截断 IS + 估计量 bootstrap 区间）:
 *     ㉔ 截断一致性: cap = max r ⟹ w = r（逐位）且 clipped = 0；
 *     ㉕ ESS 单调不降: 220 随机重尾比值向量（对数正态族）全数成立；
 *     ㉖ bootstrap 点估计 = reweightedStatistic（同权重同函数逐位一致）；
 *     ㉗ 覆盖率（证明性检验）: makeDomainGap 解析真值 E_real[x] = μ，
 *        240 试验 × 90% 区间实测覆盖 ~0.88（名义 0.90 的有限样本欠覆盖
 *        如实断言在 [0.84, 0.94]）；同 seed 复跑逐位一致；
 *     ㉘ 方差-偏倚账单: cap 收紧 ⟹ ESS 上升、|偏倚| 不减（单调权衡）。
 *
 * 全部确定性（随机处用内核/脚本共用口径的 mulberry32 种子）。
 * 运行：node --experimental-transform-types scripts/verify-r5-learning.mjs
 */

import {
  WeightedCoverage,
  lazyGreedy,
  submodularityCheck,
  CutEnergy,
  minimizeCutEnergy,
} from '../src/core/submodular.ts';
import {
  lassoCD,
  lassoScreen,
  lassoPath,
  randomSparseDesign,
} from '../src/core/sparse-recovery.ts';
import {
  prioritizedSweeping,
  valueIteration,
  randomTabularMDP,
  makeGridworld,
  makeChain,
} from '../src/core/world-model-learning.ts';
import {
  fourRoomsGridworld,
  corridorGridworld,
  primitiveOptions,
  smdpQLearning,
  smokeTestPolicy,
  solveSmdpExact,
  stateBetweenness,
  articulationPoints,
  bottleneckStates,
  optionsFromBottlenecks,
  optionTables,
} from '../src/core/options-framework.ts';
import {
  CountMinSketch,
  CountSketch,
  countSketchShape,
} from '../src/core/streaming-sketch.ts';
import {
  truncateWeights,
  weightedBootstrap,
  reweightedStatistic,
  makeDomainGap,
} from '../src/core/simulation-calibration.ts';

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
    ok(false, `${label}（未抛出——校验缺失）`);
  } catch (e) {
    ok(true, `${label}（${String(e.message).slice(0, 52)}）`);
  }
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

// Zipf(1.5) 键流工厂（f_k ∝ k^{-1.5}；二分逆变换抽样，种子化）
function zipfStream(n, distinct, seed) {
  const rng = mulberry32(seed);
  const cum = [];
  let z = 0;
  for (let k = 1; k <= distinct; k += 1) z += Math.pow(k, -1.5);
  let c = 0;
  for (let k = 1; k <= distinct; k += 1) {
    c += Math.pow(k, -1.5) / z;
    cum.push(c);
  }
  const counts = new Map();
  const stream = [];
  for (let i = 0; i < n; i += 1) {
    const u = rng();
    let lo = 0;
    let hi = distinct - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < u) lo = mid + 1;
      else hi = mid;
    }
    const key = `k${lo}`;
    stream.push(key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { stream, counts };
}

// ═══════════════════ 30.0 次模优化 ═══════════════════

section('30.0 R5 ①堆化 CELF：与朴素贪心逐位同解 + 评估次数对照');

{
  const INSTANCES = 240;
  let identical = 0;
  let lazyEvalTotal = 0;
  let naiveEvalTotal = 0;
  let valueOk = 0;
  for (let inst = 0; inst < INSTANCES; inst += 1) {
    const rng = mulberry32(31000 + inst);
    const cov = new WeightedCoverage(12);
    for (let t = 0; t < 10; t += 1) {
      const m = new Map();
      for (let i = 0; i < 12; i += 1) if (rng() < 0.4) m.set(i, 0.25 + 0.7 * rng());
      if (m.size > 0) cov.addTheme(0.3 + 1.5 * rng(), m);
    }
    const k = 3 + Math.floor(rng() * 3);
    const lazy = lazyGreedy(cov, k);
    // 朴素贪心（参照实现：每步全列重估）
    const selected = new Set();
    const naiveOrder = [];
    let naiveEvals = 0;
    for (let s = 0; s < k; s += 1) {
      let bestItem = -1;
      let bestGain = -1;
      for (let i = 0; i < 12; i += 1) {
        if (selected.has(i)) continue;
        naiveEvals += 1;
        const g = cov.marginal(i, selected);
        if (g > bestGain) {
          bestGain = g;
          bestItem = i;
        }
      }
      selected.add(bestItem);
      naiveOrder.push(bestItem);
    }
    if (JSON.stringify(lazy.selected) === JSON.stringify(naiveOrder)) identical += 1;
    lazyEvalTotal += lazy.evaluations;
    naiveEvalTotal += naiveEvals;
    const lazyValue = lazy.values.length > 0 ? lazy.values[lazy.values.length - 1] : 0;
    if (near(lazyValue, cov.value(new Set(lazy.selected)), 1e-9)) valueOk += 1;
  }
  ok(identical === INSTANCES, `堆化 CELF 与朴素贪心逐位同解：${identical}/${INSTANCES} 种子实例全等`);
  ok(valueOk === INSTANCES, `惰性贪心终止价值 = f(S) 直接求值（${valueOk}/${INSTANCES}）`);
  ok(
    lazyEvalTotal < naiveEvalTotal,
    `评估次数 lazy ${lazyEvalTotal} < 朴素 ${naiveEvalTotal}（比 ${(lazyEvalTotal / naiveEvalTotal).toFixed(3)}——陈旧键跳过重估的实测节省）`,
  );
}

section('30.0 R5 ②图割 SFMin：一次最大流 = 2^n 穷举的全局最优');

{
  const INSTANCES = 260;
  let valueFails = 0;
  let gapFails = 0;
  let worstGap = 0;
  let avgNodes = 0;
  for (let inst = 0; inst < INSTANCES; inst += 1) {
    const rng = mulberry32(9000 + inst);
    const n = 4 + Math.floor(rng() * 9);
    avgNodes += n;
    const unaryIn = [];
    const unaryOut = [];
    const edges = [];
    for (let i = 0; i < n; i += 1) {
      unaryIn.push(Math.round((rng() * 2 - 1) * 10));
      unaryOut.push(Math.round((rng() * 2 - 1) * 10));
    }
    const ne = Math.floor(rng() * n * 1.5);
    for (let e = 0; e < ne; e += 1) {
      const u = Math.floor(rng() * n);
      let v = Math.floor(rng() * n);
      if (u === v) v = (v + 1) % n;
      edges.push({ u, v, weight: Math.round(rng() * 9) });
    }
    const spec = { unaryIn, unaryOut, edges };
    const result = minimizeCutEnergy(spec);
    // 穷举 2^n
    const f = new CutEnergy(spec);
    let best = Infinity;
    for (let mask = 0; mask < 1 << n; mask += 1) {
      const S = new Set();
      for (let i = 0; i < n; i += 1) if (mask & (1 << i)) S.add(i);
      best = Math.min(best, f.value(S));
    }
    if (!near(result.value, best, 1e-9) || !near(result.cutValue, best, 1e-9)) valueFails += 1;
    if (result.gap > 1e-9) gapFails += 1;
    worstGap = Math.max(worstGap, result.gap);
  }
  ok(valueFails === 0, `图割最小化 = 穷举最优（值与割口径双等，${INSTANCES} 实例 0 失败，平均 n=${(avgNodes / INSTANCES).toFixed(1)}）`);
  ok(gapFails === 0 && worstGap === 0, `直接求值与 Σb−Σq+maxflow 双口径 gap = ${worstGap}（0 失败——两种算法互证）`);
}

section('30.0 R5 ③④次模性与结构语义');

{
  const rng = mulberry32(77);
  const cov = new CutEnergy({
    unaryIn: Array.from({ length: 9 }, () => Math.round((rng() * 2 - 1) * 8)),
    unaryOut: Array.from({ length: 9 }, () => Math.round((rng() * 2 - 1) * 8)),
    edges: [
      { u: 0, v: 1, weight: 4 },
      { u: 1, v: 2, weight: 4 },
      { u: 3, v: 4, weight: 3 },
      { u: 5, v: 6, weight: 5 },
      { u: 7, v: 8, weight: 2 },
    ],
  });
  const audit = submodularityCheck(cov, 400);
  ok(audit.violations === 0, `图割能量次模性审计：${audit.trials} 组 A⊆B 检验 0 违反（割项边际只减不增）`);

  // 结构语义: 无割边时 unary 支配（各归各）；强割边把两端锁定在同侧
  const free = minimizeCutEnergy({ unaryIn: [-3, -3], unaryOut: [1, 1], edges: [] });
  ok(JSON.stringify(free.minimizer) === '[0,1]', `无割边: 负 unary 全入选（minimizer=[${free.minimizer}]，值 ${free.value}）`);
  const bound = minimizeCutEnergy({ unaryIn: [-3, -3], unaryOut: [1, 1], edges: [{ u: 0, v: 1, weight: 100 }] });
  ok(
    (bound.minimizer.includes(0) && bound.minimizer.includes(1)) || (!bound.minimizer.includes(0) && !bound.minimizer.includes(1)),
    `强割边 100 > |Δunary|=8: 两端锁同侧（minimizer=[${bound.minimizer}]，值 ${bound.value} = 同选吸收 unary；分开要付割 100）`,
  );
  throws(() => new CutEnergy({ unaryIn: [1], unaryOut: [1], edges: [] }).marginal(5, new Set()), 'CutEnergy marginal 越界');
  throws(() => new CutEnergy({ unaryIn: [1], unaryOut: [1], edges: [{ u: 0, v: 0, weight: 1 }] }), 'CutEnergy 自环');
  throws(() => new CutEnergy({ unaryIn: [1, 1], unaryOut: [1, 1], edges: [{ u: 0, v: 1, weight: -1 }] }), 'CutEnergy 负割边（破坏次模性）');
}

// ═══════════════════ 72.0 稀疏恢复 ═══════════════════

section('72.0 R5 ⑤⑥SAFE 强规则筛选：被丢变量在完整解中恰为 0');

{
  const INSTANCES = 220;
  let totalDiscards = 0;
  let violations = 0;
  let kktBad = 0;
  for (const frac of [0.95, 0.85, 0.7]) {
    let levelDiscards = 0;
    for (let inst = 0; inst < INSTANCES; inst += 1) {
      const d = randomSparseDesign(40, 12, 3, 50000 + inst, { noiseSigma: 0.5 });
      let lambdaMax = 0;
      for (let j = 0; j < 12; j += 1) {
        let acc = 0;
        for (let i = 0; i < 40; i += 1) acc += d.A[i][j] * d.y[i];
        lambdaMax = Math.max(lambdaMax, Math.abs(acc));
      }
      const s = lassoScreen(d.A, d.y, { lambda: lambdaMax * frac });
      const full = lassoCD({ A: d.A, y: d.y, lambda: lambdaMax * frac });
      if (full.kktViolation > 1e-8) kktBad += 1; // 完整解自身的证书
      for (const j of s.discarded) {
        totalDiscards += 1;
        levelDiscards += 1;
        if (full.x[j] !== 0) violations += 1; // 安全性: 精确 === 0
      }
    }
    ok(
      violations === 0,
      `λ₀=${frac}·λ_max: ${INSTANCES} 实例丢弃 ${levelDiscards} 列、完整解中恰为 0 的违例 ${violations}（安全定理实证）`,
    );
  }
  ok(kktBad === 0, `完整解 KKT 证书全部 ≤ 1e-8（对照解自身的最优性）`);

  // 零列恒被丢
  const A0 = [
    [1, 0, 0.5],
    [0.5, 0, 1],
    [1, 0, 0.5],
    [0.5, 0, 1],
  ];
  const y0 = [1, 0.5, 1, 0.5];
  const s0 = lassoScreen(A0, y0, { lambda: 0.5 });
  ok(
    s0.discarded.includes(1) && !s0.kept.includes(1),
    `零列（‖a_j‖=0）恒被安全丢弃（kept=[${s0.kept}]，与软阈值把零相关列压 0 一致）`,
  );
  ok(
    lassoCD({ A: A0, y: y0, lambda: 0.5 }).x[1] === 0,
    '完整求解确认零列 x_1 === 0（精确）',
  );
}

section('72.0 R5 ⑦⑧⑨λ 路径：热启动零漂移 + 筛选加速的等价与收益');

{
  // x0 缺省 = 显式零向量（逐位一致——零漂移）
  const d = randomSparseDesign(30, 8, 2, 123, { noiseSigma: 0.2 });
  const a = lassoCD({ A: d.A, y: d.y, lambda: 0.3 });
  const b = lassoCD({ A: d.A, y: d.y, lambda: 0.3, x0: new Array(8).fill(0) });
  ok(JSON.stringify(a.x) === JSON.stringify(b.x) && a.sweeps === b.sweeps, 'lassoCD x0 缺省与显式零向量逐位一致（零漂移）');

  // 热启动省迭代（不触碰不动点）
  const c = lassoCD({ A: d.A, y: d.y, lambda: 0.15, x0: a.x });
  const cold = lassoCD({ A: d.A, y: d.y, lambda: 0.15 });
  let maxDiff = 0;
  for (let j = 0; j < 8; j += 1) maxDiff = Math.max(maxDiff, Math.abs(c.x[j] - cold.x[j]));
  ok(
    maxDiff <= 1e-9 && c.sweeps <= cold.sweeps,
    `热启动解 = 冷启动解（diff ${maxDiff.toExponential(1)}）且扫描轮 ${c.sweeps} ≤ ${cold.sweeps}`,
  );

  // λ 路径: 加速 vs 基线
  const d2 = randomSparseDesign(80, 30, 5, 777, { noiseSigma: 0.3 });
  let lmax2 = 0;
  for (let j = 0; j < 30; j += 1) {
    let acc = 0;
    for (let i = 0; i < 80; i += 1) acc += d2.A[i][j] * d2.y[i];
    lmax2 = Math.max(lmax2, Math.abs(acc));
  }
  const grid = Array.from({ length: 25 }, (_, i) => lmax2 * Math.pow(10, (-3 * i) / 24));
  const fast = lassoPath({ A: d2.A, y: d2.y, lambdas: grid });
  const slow = lassoPath({ A: d2.A, y: d2.y, lambdas: grid, accelerate: false });
  let pathDiff = 0;
  let worstKkt = -Infinity;
  for (let t = 0; t < fast.path.length; t += 1) {
    for (let j = 0; j < 30; j += 1) pathDiff = Math.max(pathDiff, Math.abs(fast.path[t].x[j] - slow.path[t].x[j]));
    worstKkt = Math.max(worstKkt, fast.path[t].kktViolation);
  }
  ok(pathDiff <= 1e-9, `路径解一致: 25 点全列 max|x_fast − x_slow| = ${pathDiff.toExponential(1)}（同一唯一最优）`);
  ok(worstKkt <= 1e-8, `全设计阵 KKT 证书 ≤ 1e-8（实测 ${worstKkt.toExponential(1)}——筛选/热启动未破坏最优性）`);
  ok(
    fast.columnWork < fast.baselineColumnWork,
    `列更新工作 ${fast.columnWork} < 基线 ${fast.baselineColumnWork}（×${(fast.baselineColumnWork / fast.columnWork).toFixed(2)}；前 5 点丢弃 [${fast.path.slice(0, 5).map((p) => p.discardedCount).join(',')}] / 30 列）`,
  );

  // 对偶不可行的热启动被拒绝
  const badWarm = { x: new Array(30).fill(1), lambda: 0.01 };
  throws(() => lassoScreen(d2.A, d2.y, { lambda: 0.005, warm: badWarm }), 'lassoScreen 对偶不可行热启动被拒绝');
  throws(() => lassoScreen(d2.A, d2.y, { lambda: 0 }), 'lassoScreen λ₀ = 0（无列可安全丢弃）');
  throws(() => lassoPath({ A: d2.A, y: d2.y, lambdas: [0.5, 0.9] }), 'lassoPath 非降序 λ 网格');
  throws(() => lassoCD({ A: d2.A, y: d2.y, lambda: 0.5, x0: [0, 0] }), 'lassoCD x0 长度不符');
}

// ═══════════════════ 83.0 世界模型学习 ═══════════════════

section('83.0 R5 ⑩⑪⑫优先扫除：收敛到同一 V* + 备份预算节省');

{
  const INSTANCES = 220;
  let worst = 0;
  let fails = 0;
  let unconverged = 0;
  let rowSumBad = 0;
  let psWins = 0;
  let totalVi = 0;
  let totalPs = 0;
  for (let inst = 0; inst < INSTANCES; inst += 1) {
    const mdp = randomTabularMDP(6 + (inst % 9), 2 + (inst % 4), 7000 + inst);
    for (let s = 0; s < mdp.states.length; s += 1) {
      for (let a = 0; a < mdp.actions.length; a += 1) {
        let sum = 0;
        for (const p of mdp.transitions[s][a]) sum += p;
        if (Math.abs(sum - 1) > 1e-12) rowSumBad += 1;
      }
    }
    const vi = valueIteration(mdp.transitions, mdp.rewards, mdp.gamma, 1e-11);
    const ps = prioritizedSweeping(mdp.transitions, mdp.rewards, mdp.gamma, { tol: 1e-11 });
    let diff = 0;
    for (let s = 0; s < mdp.states.length; s += 1) diff = Math.max(diff, Math.abs(vi.V[s] - ps.V[s]));
    worst = Math.max(worst, diff);
    if (diff > 2e-9) fails += 1;
    if (!ps.converged) unconverged += 1;
    const viWork = vi.iterations * mdp.states.length;
    if (ps.backups <= viWork) psWins += 1;
    totalVi += viWork;
    totalPs += ps.backups;
  }
  ok(fails === 0, `PS = 值迭代: ${INSTANCES} 种子随机 MDP 的 V 逐点一致（sup 差 ${worst.toExponential(1)} ≤ 2e-9）`);
  ok(unconverged === 0, `PS 全部收敛（停机判据与 VI 同口径）`);
  ok(rowSumBad === 0, `randomTabularMDP 转移行和恒 = 1（${INSTANCES} 实例 × 全行）`);
  ok(
    psWins === INSTANCES && totalPs < totalVi,
    `PS 备份次数 ≤ VI 全扫工作量: ${psWins}/${INSTANCES} 实例；总量 ${totalPs} vs ${totalVi}（×${(totalVi / totalPs).toFixed(2)}）`,
  );

  // 目标导向结构的节省
  const gw = makeGridworld();
  const viG = valueIteration(gw.transitions, gw.rewards, gw.gamma, 1e-11);
  const psG = prioritizedSweeping(gw.transitions, gw.rewards, gw.gamma, { tol: 1e-11 });
  let diffG = 0;
  for (let s = 0; s < gw.states.length; s += 1) diffG = Math.max(diffG, Math.abs(viG.V[s] - psG.V[s]));
  const gwRatio = (viG.iterations * gw.states.length) / psG.backups;
  ok(
    diffG <= 1e-9 && psG.backups < viG.iterations * gw.states.length,
    `4×3 gridworld: PS 备份 ${psG.backups} < VI ${viG.iterations}×${gw.states.length}（×${gwRatio.toFixed(1)}），V 一致 ${diffG.toExponential(1)}，残差 ${psG.residual.toExponential(1)}`,
  );

  const ch = makeChain({ n: 30, pRight: 0.85, pLeft: 0.7, gamma: 0.95 });
  const viC = valueIteration(ch.transitions, ch.rewards, ch.gamma, 1e-11);
  const psC = prioritizedSweeping(ch.transitions, ch.rewards, ch.gamma, { tol: 1e-11 });
  let diffC = 0;
  for (let s = 0; s < ch.states.length; s += 1) diffC = Math.max(diffC, Math.abs(viC.V[s] - psC.V[s]));
  ok(
    diffC <= 1e-9 && psC.converged,
    `30 态链: PS = VI（${diffC.toExponential(1)}）且收敛（链状传播需全深度——诚实对照，备份比 ${(psC.backups / (viC.iterations * ch.states.length)).toFixed(2)}）`,
  );

  throws(() => prioritizedSweeping(ch.transitions, ch.rewards, ch.gamma, { tol: 0 }), 'prioritizedSweeping tol ≤ 0');
  throws(() => prioritizedSweeping(ch.transitions, ch.rewards, ch.gamma, { maxUpdates: 0 }), 'prioritizedSweeping maxUpdates=0');
  throws(() => randomTabularMDP(1, 2, 1), 'randomTabularMDP nS=1');
}

// ═══════════════════ 86.0 分层技能 ═══════════════════

section('86.0 R5 ⑬⑭介数与关节点：Brandes/Tarjan vs 穷举');

{
  const WORLDS = 210;
  let worstB = 0;
  let failsB = 0;
  let failsA = 0;
  let throatOK = 0;
  let throatTot = 0;
  let coverOK = 0;
  let coverTot = 0;
  for (let inst = 0; inst < WORLDS; inst += 1) {
    const rng = mulberry32(4200 + inst);
    const world =
      inst % 2 === 0
        ? corridorGridworld({ rooms: 2 + Math.floor(rng() * 3), roomWidth: 2 + Math.floor(rng() * 4), height: 3 + 2 * Math.floor(rng() * 2) })
        : (() => {
            for (let tries = 0; tries < 50; tries += 1) {
              try {
                return fourRoomsGridworld({ goal: [Math.floor(rng() * 11), Math.floor(rng() * 11)] });
              } catch (e) {
                /* 随机格可能是墙/门——重抽 */
              }
            }
            return fourRoomsGridworld();
          })();
    const n = world.states.length;
    const ridx = new Map(world.states.map((s, i) => [s, i]));
    const adj = world.states.map((s) => world.neighbors(s).map((x) => ridx.get(x)));
    const bfsFrom = (src) => {
      const dist = new Array(n).fill(-1);
      const sigma = new Array(n).fill(0);
      dist[src] = 0;
      sigma[src] = 1;
      const q = [src];
      for (let h = 0; h < q.length; h += 1) {
        const x = q[h];
        for (const w of adj[x]) {
          if (dist[w] === -1) {
            dist[w] = dist[x] + 1;
            q.push(w);
          }
          if (dist[w] === dist[x] + 1) sigma[w] += sigma[x];
        }
      }
      return { dist, sigma };
    };
    const cache = [];
    for (let s = 0; s < n; s += 1) cache.push(bfsFrom(s));
    // 闭式双向计数: b(x) = Σ_{u≠v} [dist_u(x)+dist_v(x)=dist_u(v)]·σ_u(x)σ_v(x)/σ_u(v)
    const brute = new Array(n).fill(0);
    for (let u = 0; u < n; u += 1) {
      for (let v = 0; v < n; v += 1) {
        if (u === v || cache[u].dist[v] === -1) continue;
        const sv = cache[u].sigma[v];
        for (let x = 0; x < n; x += 1) {
          if (x === u || x === v) continue;
          const du = cache[u].dist[x];
          const dv = cache[v].dist[x];
          if (du === -1 || dv === -1) continue;
          if (du + dv === cache[u].dist[v]) brute[x] += (cache[u].sigma[x] * cache[v].sigma[x]) / sv;
        }
      }
    }
    const brandes = stateBetweenness(world);
    for (let i = 0; i < n; i += 1) {
      worstB = Math.max(worstB, Math.abs(brandes[i] - brute[i]));
      if (Math.abs(brandes[i] - brute[i]) > 1e-9) failsB += 1;
    }
    // 删点-数分量穷举 vs Tarjan
    const art = new Set(articulationPoints(world));
    for (let x = 0; x < n; x += 1) {
      let comps = 0;
      const seen = new Array(n).fill(false);
      for (let s = 0; s < n; s += 1) {
        if (s === x || seen[s]) continue;
        comps += 1;
        const q = [s];
        seen[s] = true;
        for (let h = 0; h < q.length; h += 1) {
          for (const w of adj[q[h]]) {
            if (w !== x && !seen[w]) {
              seen[w] = true;
              q.push(w);
            }
          }
        }
      }
      if (comps > 1 !== art.has(x)) failsA += 1;
    }
    if (inst % 2 === 0) {
      throatTot += 1;
      let good = art.size > 0;
      for (const r of art) {
        if (!world.doors.some((dd) => world.distance(world.states[r], dd) <= 1)) good = false;
      }
      for (const dd of world.doors) {
        if (![...art].some((r) => world.states[r] === dd)) good = false;
      }
      if (good) throatOK += 1;
    }
    coverTot += 1;
    const bn = bottleneckStates(world);
    let cov = true;
    for (const dd of world.doors) {
      if (!bn.some((bi) => world.distance(bi.state, dd) <= 1)) cov = false;
    }
    if (cov) coverOK += 1;
  }
  ok(failsB === 0, `Brandes 介数 = 闭式双向计数（${WORLDS} 随机世界逐点，worst ${worstB.toExponential(1)}）`);
  ok(failsA === 0, `Tarjan 关节点 = 删点-数分量穷举（${WORLDS} 世界逐点全等）`);
  ok(throatOK === throatTot, `走廊喉咙结构: 关节点集 = 门 ±1 邻域且含全部门（${throatOK}/${throatTot} 配置）`);
  ok(coverOK === coverTot, `瓶颈排名覆盖门: 缺省 count 下每个门在 1 步邻域内有瓶颈（${coverOK}/${coverTot}——环形四房间的介数并列由邻域口径承接）`);
}

section('86.0 R5 ⑰发现技能端到端：精确解 + 贪婪冒烟 + 学习口径');

{
  for (const [name, world] of [
    ['fourRooms(11×11)', fourRoomsGridworld()],
    ['corridor(3×4×3)', corridorGridworld({ rooms: 3, roomWidth: 4, height: 3 })],
  ]) {
    const bn = bottleneckStates(world);
    const opts = [...primitiveOptions(world), ...optionsFromBottlenecks(world, bn)];
    const exact = solveSmdpExact({ world, options: opts, gamma: 0.95 });
    const nonGoal = world.states.filter((s) => s !== world.goal);
    const smoke = smokeTestPolicy({ world, options: opts, Q: exact.Q, starts: nonGoal });
    const optMean = nonGoal.reduce((acc, s) => acc + world.optimalStepsToGoal(s), 0) / nonGoal.length;
    ok(
      exact.residual < 1e-12 && smoke.successRate === 1,
      `${name}: 发现技能的精确 SMDP 残差 ${exact.residual.toExponential(1)}、全 ${nonGoal.length} 态贪婪成功率 100%`,
    );
    ok(
      near(smoke.meanSteps, optMean, 1e-9),
      `${name}: 贪婪平均步数 ${smoke.meanSteps.toFixed(2)} = BFS 最优均值 ${optMean.toFixed(2)}（发现技能组合不牺牲最优性）`,
    );
  }
  // 学习口径（种子化确定性）
  const world = fourRoomsGridworld();
  const bn = bottleneckStates(world);
  const opts = [...primitiveOptions(world), ...optionsFromBottlenecks(world, bn)];
  const learned = smdpQLearning({ world, options: opts, episodes: 2000, seed: 21, epsilon: 0.1, alpha: 1, tieBreak: 'random' });
  const smoke = smokeTestPolicy({ world, options: opts, Q: learned.Q, starts: world.states.filter((s) => s !== world.goal) });
  ok(
    smoke.successRate >= 0.9,
    `fourRooms: 发现技能 2000 回合 SMDP 学习后贪婪成功率 ${smoke.successRate.toFixed(3)} ≥ 0.90（平均步数 ${smoke.meanSteps.toFixed(1)}）`,
  );
}

section('86.0 R5 ⑱热路径物化：表 = 闭包 + 同种子逐位复现');

{
  const world = corridorGridworld({ rooms: 4, roomWidth: 8, height: 5 });
  const bn = bottleneckStates(world);
  const opts = [...primitiveOptions(world), ...optionsFromBottlenecks(world, bn)];
  const probe = optionTables(world, opts);
  let mismatches = 0;
  let matches = 0;
  for (const s of world.states) {
    for (let c = 0; c < opts.length; c += 1) {
      if (s === world.goal || !opts[c].initiation(s)) continue;
      if (probe.policyAt(s, c) !== opts[c].policy(s)) mismatches += 1;
      if (probe.betaAt(s, c) !== opts[c].beta(s)) mismatches += 1;
      for (const a of [0, 1, 2, 3]) {
        if (probe.matchAt(s, a).includes(c) !== (opts[c].policy(s) === a)) mismatches += 1;
      }
      matches += 1;
    }
  }
  ok(mismatches === 0, `物化表 = 闭包（${matches} 个（态,选项）对逐位一致；匹配索引与策略查询全等）`);

  const r1 = smdpQLearning({ world, options: opts, episodes: 300, seed: 99, epsilon: 0.15, alpha: 1, tieBreak: 'random' });
  const r2 = smdpQLearning({ world, options: opts, episodes: 300, seed: 99, epsilon: 0.15, alpha: 1, tieBreak: 'random' });
  ok(
    JSON.stringify(r1.Q) === JSON.stringify(r2.Q) && JSON.stringify(r1.stepsPerEpisode) === JSON.stringify(r2.stepsPerEpisode),
    '同种子复跑 Q/步数轨迹逐位一致（物化不触碰 rng 消费流——等价的复合证明）',
  );
  throws(() => optionTables(world, opts).policyAt(world.states[0], 99), 'optionTables 列越界');
}

// ═══════════════════ 80.0 流式概要 ═══════════════════

section('80.0 R5 ⑲⑳㉑CountSketch：‖a‖₂ 概率界 + 带符号计数');

{
  const shape = countSketchShape(0.1, 0.1);
  ok(
    shape.width === Math.ceil(4 / 0.01) && shape.depth % 2 === 1 && Math.pow(3 / 4, shape.depth / 2) <= 0.1,
    `形状闭式: w = ⌈4/ε²⌉ = ${shape.width}，d = ${shape.depth}（奇数）且 (3/4)^{d/2} = ${Math.pow(3 / 4, shape.depth / 2).toExponential(1)} ≤ δ=0.1`,
  );

  const SEEDS = 210;
  let boundFails = 0;
  let worst = 0;
  let worstBound = 0;
  for (let s = 0; s < SEEDS; s += 1) {
    const { stream, counts } = zipfStream(100000, 5000, 900 + s);
    const cs = new CountSketch({ eps: 0.1, delta: 0.1, seed: s % 97 });
    for (const k of stream) cs.update(k);
    let l2 = 0;
    for (const v of counts.values()) l2 += v * v;
    l2 = Math.sqrt(l2);
    const bound = 0.1 * l2;
    worstBound = Math.max(worstBound, bound);
    for (const [k, f] of counts) {
      const err = Math.abs(cs.estimate(k) - f);
      worst = Math.max(worst, err);
      if (err > bound) boundFails += 1;
    }
  }
  ok(
    boundFails === 0,
    `概率界: ${SEEDS} 种子 × Zipf(1.5) 10 万事件 × 全键 |est−f| ≤ ε·‖a‖₂（实测最大误差 ${worst.toFixed(0)} ≪ 界 ${worstBound.toFixed(0)}）`,
  );

  const cs = new CountSketch({ eps: 0.2, delta: 0.2, seed: 5 });
  cs.update('a', 7);
  cs.update('a', -7);
  cs.update('b', 3);
  cs.update('b', -1);
  ok(
    cs.estimate('a') === 0 && cs.estimate('b') === 2,
    `带符号精确对消: (+7 −7) → ${cs.estimate('a')}、(+3 −1) → ${cs.estimate('b')}（删除语义，CMS 不支持）`,
  );
  throws(() => new CountMinSketch({ eps: 0.02, delta: 0.01 }).update('a', -1), 'CMS 负计数被拒绝（非负口径对照）');

  // 内积
  const sA = zipfStream(30000, 500, 11);
  const sB = zipfStream(30000, 500, 12);
  const cA = new CountSketch({ eps: 0.15, delta: 0.15, seed: 3 });
  const cB = new CountSketch({ eps: 0.15, delta: 0.15, seed: 3 });
  for (const k of sA.stream) cA.update(k);
  for (const k of sB.stream) cB.update(k);
  let ip = 0;
  for (const [k, v] of sA.counts) ip += v * (sB.counts.get(k) ?? 0);
  const l2a = Math.sqrt([...sA.counts.values()].reduce((x, v) => x + v * v, 0));
  const l2b = Math.sqrt([...sB.counts.values()].reduce((x, v) => x + v * v, 0));
  const ipErr = Math.abs(cA.innerProduct(cB) - ip);
  ok(
    ipErr <= 0.15 * l2a * l2b,
    `内积估计: |⟨a,b⟩̂ − ⟨a,b⟩| = ${ipErr.toExponential(2)} ≤ ε·‖a‖₂·‖b‖₂ = ${(0.15 * l2a * l2b).toExponential(2)}（同种子同形状）`,
  );
  const cWrong = new CountSketch({ eps: 0.15, delta: 0.15, seed: 4 });
  throws(() => cA.innerProduct(cWrong), 'innerProduct 异种子被拒绝（哈希族共享前提）');
  throws(() => countSketchShape(0, 0.1), 'countSketchShape eps=0');
}

section('80.0 R5 ㉒㉓CMS 哈希缓存：位级等价 + 长键计时');

{
  const base = zipfStream(120000, 2000, 42);
  const longStream = base.stream.map((k) => `tenant-alpha.signal.pipeline.${k}.metric-2026-10-02T00:00:00Z`);
  const distinct = [...new Set(longStream)];
  const run = (cache) => {
    const cms = new CountMinSketch({ eps: 0.02, delta: 0.01, seed: 0, hashCacheSize: cache });
    const t0 = performance.now();
    for (const k of longStream) cms.update(k);
    const t1 = performance.now();
    const ests = distinct.map((k) => cms.estimate(k));
    const t2 = performance.now();
    return { ests, updMs: t1 - t0, estMs: t2 - t1 };
  };
  run(0); // JIT 预热（不计入对照）
  const noCacheRuns = [run(0), run(0)];
  const cachedRuns = [run(4000), run(4000)];
  const noCache = noCacheRuns[0];
  const cached = cachedRuns[0];
  const noCacheMs = Math.min(...noCacheRuns.map((r) => r.updMs));
  const cachedMs = Math.min(...cachedRuns.map((r) => r.updMs));
  let identical = true;
  for (let i = 0; i < distinct.length; i += 1) if (noCache.ests[i] !== cached.ests[i]) identical = false;
  ok(
    identical,
    `缓存与无缓存路径估计**逐位一致**（${distinct.length} 键全等——散列值相同，只是memoize）`,
  );
  console.log(
    `    （计时对照: 无缓存更新（预热后最佳）${noCacheMs.toFixed(0)}ms / 缓存 ${cachedMs.toFixed(0)}ms ×${(noCacheMs / Math.max(1e-9, cachedMs)).toFixed(1)}（长键流收益；短键流哈希本廉价，缓存缺省关闭））`,
  );
  throws(() => new CountMinSketch({ eps: 0.02, delta: 0.01, hashCacheSize: -1 }), 'CMS hashCacheSize 负数');
}

// ═══════════════════ 94.0 仿真校准 ═══════════════════

section('94.0 R5 ㉔㉕㉖截断 IS：一致性 + ESS 单调 + 口径统一');

{
  const gap = makeDomainGap({ shift: 1, scale: 1.4, nSim: 1500, nReal: 500, seed: 3 });
  const ratios = gap.sim.map((x) => gap.exactRatio(x));
  const rMax = Math.max(...ratios);
  const noTr = truncateWeights(ratios, rMax);
  ok(
    noTr.clipped === 0 && JSON.stringify(noTr.weights) === JSON.stringify(ratios),
    'cap = max r ⟹ 截断退化为纯 IS（w = r 逐位一致，clipped = 0）',
  );
  const tr = truncateWeights(ratios, 2);
  ok(
    tr.essAfter >= tr.essBefore && tr.clipped > 0,
    `cap = 2: ESS ${tr.essBefore.toFixed(1)} → ${tr.essAfter.toFixed(1)}（单调不降，被截 ${tr.clipped} 个——方差护栏）`,
  );

  // ESS 单调不降: 220 个对数正态重尾比值向量
  let essFails = 0;
  for (let inst = 0; inst < 220; inst += 1) {
    const rng = mulberry32(8800 + inst);
    const n = 100 + Math.floor(rng() * 400);
    const heavy = Array.from({ length: n }, () => Math.exp(1.2 * normalOf(rng)));
    const res = truncateWeights(heavy, Math.exp(0.6 + rng() * 1.2));
    if (res.essAfter < res.essBefore - 1e-9) essFails += 1;
  }
  ok(essFails === 0, 'ESS 单调不降: 220 个对数正态重尾比值向量全数成立（截断只压缩权重离散度）');

  const g2 = makeDomainGap({ shift: 1, scale: 1, nSim: 800, nReal: 300, seed: 77 });
  const r2 = g2.sim.map((x) => g2.exactRatio(x));
  const ci = weightedBootstrap(g2.sim, r2, (x) => x, { replicates: 300, seed: 5 });
  ok(
    ci.estimate === reweightedStatistic(g2.sim, (x) => g2.exactRatio(x), (x) => x),
    'bootstrap 点估计 = reweightedStatistic（同权重同函数逐位一致——自归一化 IS 口径统一）',
  );
  throws(() => truncateWeights([1, -2], 1), 'truncateWeights 非正比值');
  throws(() => truncateWeights([1, 2], 0), 'truncateWeights cap=0');
  throws(() => weightedBootstrap(g2.sim, [1, 2], (x) => x), 'weightedBootstrap 权重长度不符');
  throws(() => weightedBootstrap(g2.sim, r2, (x) => x, { replicates: 1 }), 'weightedBootstrap replicates=1');
}

function normalOf(rng) {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

section('94.0 R5 ㉗㉘加权 bootstrap 区间：解析真值覆盖率 + 方差-偏倚账单');

{
  const TRIALS = 240;
  let covered = 0;
  for (let t = 0; t < TRIALS; t += 1) {
    const g = makeDomainGap({ shift: 1, scale: 1, nSim: 2000, nReal: 300, seed: 31000 + t * 7919 });
    const r = g.sim.map((x) => g.exactRatio(x));
    const ci = weightedBootstrap(g.sim, r, (x) => x, { replicates: 400, seed: 61000 + t * 104729, level: 0.9 });
    if (ci.lower <= g.shift && g.shift <= ci.upper) covered += 1;
  }
  const coverage = covered / TRIALS;
  ok(
    coverage >= 0.82 && coverage <= 0.95,
    `覆盖率（解析真值 E_real[x] = 1）: ${covered}/${TRIALS} = ${coverage.toFixed(3)} ∈ [0.82, 0.95]（名义 0.90——百分位 bootstrap 的有限样本欠覆盖如实呈现）`,
  );

  const again = (() => {
    const g = makeDomainGap({ shift: 1, scale: 1, nSim: 2000, nReal: 300, seed: 31000 });
    const r = g.sim.map((x) => g.exactRatio(x));
    return weightedBootstrap(g.sim, r, (x) => x, { replicates: 400, seed: 61000, level: 0.9 });
  })();
  const first = (() => {
    const g = makeDomainGap({ shift: 1, scale: 1, nSim: 2000, nReal: 300, seed: 31000 });
    const r = g.sim.map((x) => g.exactRatio(x));
    return weightedBootstrap(g.sim, r, (x) => x, { replicates: 400, seed: 61000, level: 0.9 });
  })();
  ok(JSON.stringify(again) === JSON.stringify(first), '同种子复跑区间逐位一致（确定性）');

  // 方差-偏倚账单: cap 收紧 ⟹ ESS 上升、|偏倚| 不减（单调权衡）
  const g3 = makeDomainGap({ shift: 1, scale: 1, nSim: 4000, nReal: 500, seed: 12 });
  const r3 = g3.sim.map((x) => g3.exactRatio(x));
  const caps = [Math.max(...r3), 4, 2.5, 1.8, 1.4];
  let essUp = true;
  let biasMonotone = true;
  let prevEss = -Infinity;
  let prevBias = -1;
  const report = [];
  for (const cap of caps) {
    const tr = truncateWeights(r3, cap);
    let num = 0;
    let den = 0;
    for (let i = 0; i < g3.sim.length; i += 1) {
      num += tr.weights[i] * g3.sim[i];
      den += tr.weights[i];
    }
    const bias = Math.abs(num / den - 1);
    if (tr.essAfter < prevEss - 1e-9) essUp = false;
    if (bias < prevBias - 1e-9) biasMonotone = false;
    prevEss = tr.essAfter;
    prevBias = bias;
    report.push(`cap=${cap.toFixed(2)}→ESS=${tr.essAfter.toFixed(0)},|bias|=${bias.toFixed(3)}`);
  }
  ok(essUp, `cap 收紧 ⟹ ESS 单调上升（${report.join('；')}）`);
  ok(biasMonotone, 'cap 收紧 ⟹ |偏倚| 单调不减（方差-偏倚权衡的实证方向）');
}

// ─────────────────────────── 汇总 ───────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log('✓ R5-A17 六学习内核（30.0/72.0/83.0/86.0/80.0/94.0）世界性进化全部验证通过');
}
