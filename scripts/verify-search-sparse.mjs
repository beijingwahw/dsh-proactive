/**
 * verify-search-sparse.mjs — 71.0/72.0「创世纪升级」双内核纯数学离线验证
 *
 * 每个内核的数学核心都有解析解对照（不是「能跑」，是「算得对」）：
 *   71.0 A* 搜索（Hart–Nilsson–Raphael 最优性定理）：
 *        30 例种子化 20×20 网格（8 邻域 1/√2、60 随机障碍），曼哈顿
 *        （√2/2 可采纳缩放）/欧氏/八向三种 h 下 A* 成本与独立实现的
 *        Dijkstra 完全相等（最优性）；扩展数对 Dijkstra 逐例不增、总量
 *        随 h 信息量严格递减（octile 1682 < euclid 1985 < manhattan 2912
 *        ≪ dijkstra 10198；注：octile≤euclid 仅总量成立——f=C* 边界链
 *        的平局次序可在个例翻转，故逐例只断言对 Dijkstra 的偏序）；
 *        h≡0 与 Dijkstra 同成本同扩展数同零重开（30/30 逐位同型）；
 *        病态衰减 h（可采纳但不一致）——checkConsistent 报警 227 条边、
 *        checkAdmissible 放行、带重开的 A* 仍达最优且 reopened=2（诚实
 *        演示「不换重开就买不回最优性保证」）；全墙隔断有限步返回
 *        goalReached=false；DAG 任务计划接入点：精确 h* 恒一致（定理），
 *        A* 只扩展最优路径本身（expanded=5=路径长）。
 *   72.0 稀疏恢复（Lasso KKT / OMP 支撑恢复）：
 *        无噪 3-稀疏 60×10 OMP 支撑+数值精确恢复（1e-9）；Lasso CD 收敛
 *        解 KKT 最大违反 −5e-15 < 1e-8（凸问题 KKT 充要——最优性证书，
 *        不是「跑完了」）；目标函数轨迹单调不增；λ ≥ λ_max=‖Aᵀy‖∞ 时
 *        解逐分量 === 0（闭式阈值精确断言，一轮收敛）；σ=0.1 噪声 100
 *        种子 OMP 支撑恢复率 100% ≥ 95%；CV 选 λ 的验证误差 ≤ 同折
 *        真支撑最小二乘（oracle）误差 × 1.10（实测相对差距 4.5%）。
 *
 * 全部断言确定性（随机处用 mulberry32 种子，内核自带数据工厂）。
 * 运行：node --experimental-strip-types scripts/verify-search-sparse.mjs
 */

import {
  dijkstra,
  astar,
  zeroHeuristic,
  gridWorld,
  gridHeuristic,
  GRID_METRIC,
  graphFromEdgeList,
  reverseGraph,
  allDistances,
  checkAdmissible,
  checkConsistent,
} from '../src/core/astar-search.ts';
import {
  softThreshold,
  lassoCD,
  kktMaxViolation,
  omp,
  cvLasso,
  randomSparseDesign,
  leastSquares,
} from '../src/core/sparse-recovery.ts';

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

// ═══════════════════ 71.0 A* 搜索 ═══════════════════

section('71.0 A*：30 例种子化网格上与 Dijkstra 的最优性/效率/退化对照');

{
  const CASES = 30;
  const METRICS = [GRID_METRIC.MANHATTAN, GRID_METRIC.EUCLIDEAN, GRID_METRIC.OCTILE];
  let costMatch = 0;
  let reached = 0;
  let pathValid = 0;
  let expOctLeDij = 0;
  let expEucLeDij = 0;
  let expManLeDij = 0;
  let h0Identical = 0;
  let sumDij = 0;
  let sumMan = 0;
  let sumEuc = 0;
  let sumOct = 0;

  for (let i = 0; i < CASES; i += 1) {
    const world = gridWorld(20, 20, 60, 20261001 + i);
    const free = world.freeCells();
    const start = free.includes('0,0') ? '0,0' : free[0];
    const goal = free.includes('19,19') ? '19,19' : free[free.length - 1];
    const D = dijkstra(world.graph, start, goal);
    if (D.goalReached) reached += 1;

    const expansions = {};
    for (const metric of METRICS) {
      const A = astar({ graph: world.graph, start, goal, h: gridHeuristic(world, goal, metric) });
      if (A.goalReached && near(A.cost, D.cost, 1e-9)) costMatch += 1;
      expansions[metric] = A.expanded;
      if (metric === GRID_METRIC.OCTILE) {
        // 路径有效性：首末正确、无重复、沿邻接表重算成本一致
        let okPath = A.goalReached && A.path[0] === start && A.path[A.path.length - 1] === goal
          && new Set(A.path).size === A.path.length;
        let recomputed = 0;
        for (let p = 1; okPath && p < A.path.length; p += 1) {
          const edge = world.graph.neighbors(A.path[p - 1]).find((e) => e.to === A.path[p]);
          if (edge === undefined) okPath = false;
          else recomputed += edge.cost;
        }
        if (okPath && near(recomputed, A.cost, 1e-9)) pathValid += 1;
      }
    }

    const A0 = astar({ graph: world.graph, start, goal, h: zeroHeuristic });
    if (A0.cost === D.cost && A0.expanded === D.expanded && A0.reopened === 0) h0Identical += 1;

    const { manhattan: man, euclidean: euc, octile: oct } = expansions;
    if (oct <= D.expanded) expOctLeDij += 1;
    if (euc <= D.expanded) expEucLeDij += 1;
    if (man <= D.expanded) expManLeDij += 1;
    sumDij += D.expanded;
    sumMan += man;
    sumEuc += euc;
    sumOct += oct;
  }

  ok(
    reached === CASES && costMatch === CASES * METRICS.length,
    `最优性：${CASES}/${CASES} 例可达，三种 h × ${CASES} 例 A* 成本与 Dijkstra 全部相等（${costMatch}/${CASES * METRICS.length}）`,
  );
  ok(
    pathValid === CASES,
    `路径有效性：${pathValid}/${CASES} 例首末正确、无重复、沿邻接重算成本一致（1e-9）`,
  );
  ok(
    expOctLeDij === CASES && expEucLeDij === CASES && expManLeDij === CASES,
    `扩展数不增（逐例）：octile≤Dijkstra ${expOctLeDij}/${CASES}，euclidean≤Dijkstra ${expEucLeDij}/${CASES}，manhattan≤Dijkstra ${expManLeDij}/${CASES}`,
  );
  ok(
    sumOct < sumEuc && sumEuc < sumMan && sumMan < sumDij,
    `信息量偏序（总量）：octile ${sumOct} < euclidean ${sumEuc} < manhattan ${sumMan} ≪ Dijkstra ${sumDij}`,
  );
  ok(
    h0Identical === CASES,
    `h≡0 退化：${h0Identical}/${CASES} 例与 Dijkstra 同成本、同扩展数、reopened=0（逐位同型）`,
  );
}

// ── 一致性/可采纳性校验器 + 重开的诚实演示 ──
{
  const wall = [];
  for (let y = 0; y < 12; y += 1) if (y !== 5) wall.push(`6,${y}`);
  const world = gridWorld(12, 12, wall);
  const start = '1,10';
  const goal = '10,1';
  const trueCosts = allDistances(reverseGraph(world.graph), goal);
  const hOct = gridHeuristic(world, goal, GRID_METRIC.OCTILE);
  const cOct = checkConsistent(hOct, world.graph);
  const aOct = checkAdmissible(hOct, world.graph, trueCosts);
  ok(
    cOct.consistent && cOct.maxViolation <= 1e-9 && aOct.admissible,
    `八向 h 基线：consistent=true（maxViolation=${cOct.maxViolation.toExponential(2)}，浮点尘埃内）、admissible=true`,
  );

  // 病态衰减 h：棋盘格上一半节点 h=0（压低 → 仍可采纳），但与相邻满值 h 的边
  // 严重违反三角不等式 → 不一致。A* 提前弹出这些「免费」节点，之后更短路径
  // 到达时必须重开——可采纳性保最优、一致性保「无需重开」，二者缺一不可。
  const hDip = (node) => {
    const [x, y] = node.split(',').map(Number);
    return (x + y) % 2 === 0 ? 0 : hOct(node);
  };
  const cDip = checkConsistent(hDip, world.graph);
  const aDip = checkAdmissible(hDip, world.graph, trueCosts);
  ok(
    !cDip.consistent && cDip.violatedEdges.length > 0 && cDip.maxViolation > 1,
    `衰减 h 不一致：checkConsistent 报警 ${cDip.violatedEdges.length} 条边（maxViolation=${cDip.maxViolation.toFixed(3)}）`,
  );
  ok(aDip.admissible, `衰减 h 仍可采纳：checkAdmissible 放行（maxExcess=${aDip.maxExcess} ≤ 0）——最优性还在，重开不可避免`);
  const D = dijkstra(world.graph, start, goal);
  const R = astar({ graph: world.graph, start, goal, h: hDip, allowReopen: true });
  const N = astar({ graph: world.graph, start, goal, h: hDip, allowReopen: false });
  ok(
    R.goalReached && near(R.cost, D.cost, 1e-9) && R.reopened > 0,
    `带重开的 A* 仍最优：cost=${R.cost.toFixed(9)} = Dijkstra（重开 ${R.reopened} 次 > 0——不一致 h 的诚实账单）`,
  );
  ok(
    N.cost >= D.cost - 1e-9,
    `禁止重开不劣于最优（本例侥幸同成本 ${N.cost.toFixed(9)}，但保证已失去——理论只承诺 ≥）`,
  );

  // 不可采纳负对照：h = h* + 5 逐点高估
  const hBad = (node) => (node === goal ? 0 : trueCosts.get(node) + 5);
  const aBad = checkAdmissible(hBad, world.graph, trueCosts);
  ok(
    !aBad.admissible && near(aBad.maxExcess, 5, 1e-9) && aBad.violations.length > 0,
    `负对照 h*+5：checkAdmissible 正确报警（maxExcess=${aBad.maxExcess.toFixed(12)}，违反 ${aBad.violations.length} 节点）`,
  );
}

// ── 不可达：明确结果而非死循环 ──
{
  const wall = [];
  for (let y = 0; y < 8; y += 1) wall.push(`4,${y}`);
  const world = gridWorld(8, 8, wall);
  const D = dijkstra(world.graph, '1,1', '6,6');
  const A = astar({ graph: world.graph, start: '1,1', goal: '6,6', h: zeroHeuristic });
  ok(
    !D.goalReached && D.cost === Number.POSITIVE_INFINITY && D.path.length === 0,
    `Dijkstra 不可达：goalReached=false、cost=Infinity、path=[]（有限步穷尽，非死循环）`,
  );
  ok(
    D.expanded === 32,
    `Dijkstra 不可达扩展数 = 左侧连通块节点数 32（实测 ${D.expanded}——全部弹出后堆空终止）`,
  );
  ok(
    !A.goalReached && A.cost === Number.POSITIVE_INFINITY && A.path.length === 0 && A.expanded === 32,
    `A*(h≡0) 不可达：同构返回（expanded=${A.expanded === 32 ? '32' : A.expanded}，同样有限终止）`,
  );
}

// ── DAG 任务计划接入点 ──
{
  // 节点=任务阶段，边=依赖转移，成本=预计 token/时延。最优子计划 =
  // start→goal 最短路径。手工枚举候选：start→index→rerank→compose→goal
  // = 1.5+1+3+0.5 = 6.0 为最小（retrieve 路线 8.0、cite 路线 7.0/10.5）。
  const nodes = ['start', 'index', 'retrieve', 'rerank', 'compose', 'cite', 'goal'];
  const edges = [
    { from: 'start', to: 'index', cost: 1.5 },
    { from: 'start', to: 'retrieve', cost: 2.0 },
    { from: 'index', to: 'rerank', cost: 1.0 },
    { from: 'retrieve', to: 'rerank', cost: 2.5 },
    { from: 'index', to: 'cite', cost: 5.0 },
    { from: 'rerank', to: 'compose', cost: 3.0 },
    { from: 'rerank', to: 'cite', cost: 0.5 },
    { from: 'compose', to: 'goal', cost: 0.5 },
    { from: 'cite', to: 'goal', cost: 4.0 },
  ];
  const graph = graphFromEdgeList(nodes, edges);
  const hStarMap = allDistances(reverseGraph(graph), 'goal');
  const hStar = (n) => hStarMap.get(n);
  const cStar = checkConsistent(hStar, graph);
  ok(
    cStar.consistent,
    `定理验证：精确距离 h* 恒一致（checkConsistent maxViolation=${cStar.maxViolation.toExponential(2)}）`,
  );
  const A = astar({ graph, start: 'start', goal: 'goal', h: hStar });
  const D = dijkstra(graph, 'start', 'goal');
  ok(
    A.goalReached && near(A.cost, 6.0, 1e-12) && A.path.join('→') === 'start→index→rerank→compose→goal',
    `DAG 最优子计划：cost=6.0，路径 start→index→rerank→compose→goal（手工枚举 5 条候选的最小值）`,
  );
  ok(
    A.expanded === A.path.length && A.reopened === 0,
    `精确 h* 的极致信息量：expanded=${A.expanded} = 路径长度（只扩展最优路径本身；Dijkstra 需 ${D.expanded}）`,
  );
  ok(
    near(astar({ graph, start: 'start', goal: 'goal', h: zeroHeuristic }).cost, D.cost, 1e-12),
    `同一 DAG 上 h≡0 与 Dijkstra 一致（cost=${D.cost}）`,
  );
}

// ═══════════════════ 72.0 稀疏恢复 ═══════════════════

section('72.0 稀疏恢复：OMP 精确恢复 / Lasso KKT 证书 / 闭式阈值 / 噪声鲁棒性 / CV');

{
  // 软阈值算子原子
  ok(
    softThreshold(3, 1) === 2 && softThreshold(-0.5, 1) === 0 && softThreshold(5, 0) === 5 && softThreshold(2, 0.5) === 1.5,
    `softThreshold：S(3,1)=${softThreshold(3, 1)}、S(−0.5,1)=${softThreshold(-0.5, 1)}（精确 0）、S(5,0)=${softThreshold(5, 0)}（λ=0 恒等）、S(2,0.5)=${softThreshold(2, 0.5)}`,
  );

  // ① 无噪 OMP 精确恢复
  const clean = randomSparseDesign(60, 10, 3, 20261001);
  const ompRun = omp({ A: clean.A, y: clean.y, k: 3 });
  const maxCoeffErr = Math.max(...ompRun.x.map((v, j) => Math.abs(v - clean.xStar[j])));
  ok(
    JSON.stringify([...ompRun.support].sort((a, b) => a - b)) === JSON.stringify(clean.support),
    `OMP 无噪支撑恢复：support=[${ompRun.support.join(',')}] = 真支撑 [${clean.support.join(',')}]`,
  );
  ok(
    maxCoeffErr < 1e-9 && ompRun.residualNorm < 1e-9 && ompRun.steps === 3,
    `OMP 无噪数值恢复：max|x−x*|=${maxCoeffErr.toExponential(2)}、‖残差‖=${ompRun.residualNorm.toExponential(2)}（1e-9 内）、3 步后残差无相关方向提前停`,
  );

  // ②③ Lasso CD：KKT 证书 + 单调轨迹
  const noisy = randomSparseDesign(60, 10, 3, 20261005, { noiseSigma: 0.1 });
  const lambdaMax = Math.max(
    ...Array.from({ length: 10 }, (_, j) => Math.abs(noisy.A.reduce((s, row, i) => s + row[j] * noisy.y[i], 0))),
  );
  const fit = lassoCD({ A: noisy.A, y: noisy.y, lambda: 0.1 * lambdaMax });
  ok(
    fit.converged && fit.kktViolation < 1e-8,
    `Lasso 最优性证书：收敛后 KKT 最大违反 ${fit.kktViolation.toExponential(2)} < 1e-8（凸问题 KKT 充要——证明了到最优点，而非仅跑完 ${fit.sweeps} 轮）`,
  );
  ok(
    JSON.stringify(fit.activeSet) === JSON.stringify(noisy.support),
    `Lasso active 集 [${fit.activeSet.join(',')}] = 真支撑 [${noisy.support.join(',')}]（λ=0.1·λ_max=${(0.1 * lambdaMax).toFixed(3)}）`,
  );
  let monotone = true;
  for (let i = 1; i < fit.objectiveTrace.length; i += 1) {
    if (fit.objectiveTrace[i] > fit.objectiveTrace[i - 1] + 1e-9) monotone = false;
  }
  ok(
    monotone && fit.objectiveTrace.length === fit.sweeps + 1,
    `目标函数单调不增：${fit.objectiveTrace.length} 个轨迹点（初值+每轮）全程非升（坐标精确极小化的定理行为）`,
  );
  const fitSmall = lassoCD({ A: noisy.A, y: noisy.y, lambda: 0.01 * lambdaMax, iters: 2000 });
  let monotone2 = true;
  for (let i = 1; i < fitSmall.objectiveTrace.length; i += 1) {
    if (fitSmall.objectiveTrace[i] > fitSmall.objectiveTrace[i - 1] + 1e-9) monotone2 = false;
  }
  ok(
    monotone2 && fitSmall.kktViolation < 1e-8,
    `小 λ（0.01·λ_max）长轨迹同样单调且 KKT=${fitSmall.kktViolation.toExponential(2)} < 1e-8（${fitSmall.sweeps} 轮）`,
  );

  // ④ λ ≥ λ_max ⟹ 全零（闭式阈值）
  const zeroSeed = randomSparseDesign(60, 10, 3, 20261007);
  const lm = Math.max(
    ...Array.from({ length: 10 }, (_, j) => Math.abs(zeroSeed.A.reduce((s, row, i) => s + row[j] * zeroSeed.y[i], 0))),
  );
  const fitAtMax = lassoCD({ A: zeroSeed.A, y: zeroSeed.y, lambda: lm });
  const fitAbove = lassoCD({ A: zeroSeed.A, y: zeroSeed.y, lambda: 1.5 * lm });
  ok(
    fitAtMax.x.every((v) => v === 0) && fitAtMax.sweeps === 1 && fitAtMax.converged && fitAtMax.kktViolation === 0,
    `λ = λ_max=${lm.toFixed(3)}：解逐分量 === 0（闭式阈值）、一轮收敛、KKT 违反恰为 0（x=0 是全活跃候选的双闸边界）`,
  );
  ok(
    fitAbove.x.every((v) => v === 0) && fitAbove.kktViolation < 0 && near(fitAbove.objectiveTrace[1], 0.5 * zeroSeed.y.reduce((s, v) => s + v * v, 0), 1e-9),
    `λ = 1.5·λ_max：全零（KKT=${fitAbove.kktViolation.toFixed(2)} < 0），目标 = ½‖y‖²（正则项为 0）`,
  );

  // ⑤ 噪声下 100 种子支撑恢复率
  let hits = 0;
  for (let s = 0; s < 100; s += 1) {
    const d = randomSparseDesign(60, 10, 3, 20262000 + s, { noiseSigma: 0.1, minMagnitude: 0.5 });
    const r = omp({ A: d.A, y: d.y, k: 3 });
    if (JSON.stringify([...r.support].sort((a, b) => a - b)) === JSON.stringify(d.support)) hits += 1;
  }
  ok(
    hits >= 95,
    `σ=0.1 噪声 100 种子：OMP 支撑恢复率 ${hits}% ≥ 95%（幅值下限 0.5——低于可探测度的因素不算恢复失败）`,
  );

  // ⑥ CV 选 λ 对照真支撑 oracle
  const cvData = randomSparseDesign(100, 12, 3, 20261009, { noiseSigma: 0.5 });
  const cv = cvLasso({ A: cvData.A, y: cvData.y, folds: 5, seed: 20261111 });
  let oracleTotal = 0;
  for (const fold of cv.folds) {
    const test = new Set(fold);
    const trainRows = [];
    const trainY = [];
    for (let i = 0; i < cvData.A.length; i += 1) {
      if (!test.has(i)) {
        trainRows.push(cvData.A[i]);
        trainY.push(cvData.y[i]);
      }
    }
    const subA = trainRows.map((row) => cvData.support.map((j) => row[j]));
    const coef = leastSquares(subA, trainY);
    for (const i of fold) {
      let pred = 0;
      for (let a = 0; a < cvData.support.length; a += 1) pred += cvData.A[i][cvData.support[a]] * coef[a];
      oracleTotal += (pred - cvData.y[i]) ** 2;
    }
  }
  const oracle = oracleTotal / cvData.A.length;
  const relGap = (cv.cvError - oracle) / oracle;
  ok(
    cv.cvError <= oracle * 1.10 + 1e-9,
    `CV 选 λ 对照 oracle：cvError=${cv.cvError.toFixed(6)} ≤ 真支撑 LS（同折）${oracle.toFixed(6)} × 1.10（相对差距 ${(relGap * 100).toFixed(1)}%——收缩偏置在噪声方差内的代价）`,
  );
  ok(
    cv.curve.length === 25 && cv.curve.every((p) => p.cvError >= cv.cvError - 1e-12),
    `CV 曲线纪律：25 点网格、bestLambda=${cv.bestLambda.toFixed(4)} 的误差确为全网格最小（平局取更大 λ 的稀疏偏好）`,
  );
}

// ═══════════════════ 入参校验（显式 throw） ═══════════════════

section('入参校验：非法输入显式 throw（铁律 5）');

{
  const world = gridWorld(5, 5, []);
  throws(() => astar({ graph: world.graph, start: '99,99', goal: '0,0', h: zeroHeuristic }), 'astar 未知起点');
  throws(() => astar({ graph: world.graph, start: '0,0', goal: '0,0', h: () => Number.NaN }), 'astar h 返回 NaN');
  throws(() => graphFromEdgeList(['a', 'b'], [{ from: 'a', to: 'ghost', cost: 1 }]), 'graphFromEdgeList 指向未知节点');
  throws(() => graphFromEdgeList(['a', 'b'], [{ from: 'a', to: 'b', cost: -1 }]), 'graphFromEdgeList 负代价');
  throws(() => gridWorld(5, 5, ['9,0']), 'gridWorld 障碍越界');
  throws(() => dijkstra(graphFromEdgeList(['a'], []), 'a', 'a') && checkAdmissible(zeroHeuristic, world.graph, new Map()), 'checkAdmissible trueCosts 缺失');

  const d = randomSparseDesign(20, 5, 2, 1);
  throws(() => softThreshold(1, -1), 'softThreshold 负阈值');
  throws(() => lassoCD({ A: d.A, y: d.y, lambda: -0.5 }), 'lassoCD 负 λ');
  throws(() => omp({ A: d.A, y: d.y, k: 0 }), 'omp k=0');
  throws(() => omp({ A: d.A, y: d.y, k: 6 }), 'omp k > n');
  throws(() => kktMaxViolation(d.A, d.y, [0, 0], 1), 'kktMaxViolation x 长度不符');
  throws(() => randomSparseDesign(10, 5, 6, 1), 'randomSparseDesign k > n');
  throws(() => cvLasso({ A: d.A, y: d.y, folds: 1 }), 'cvLasso folds=1');
  throws(() => lassoCD({ A: [[1, 2], [3]], y: [1, 2], lambda: 1 }), 'lassoCD 非矩形 A');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) {
  process.exitCode = 1;
}
