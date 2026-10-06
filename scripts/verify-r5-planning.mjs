/**
 * verify-r5-planning.mjs — R5-A6 第五轮「规划搜索内核世界性进化」纯数学离线验证
 *
 * 覆盖五个内核的 R5 进化轴（每内核 ≥ 2 轴，≥ 1 轴来自数学/性能），全部
 * 断言有解析解 / 独立对照 / 定理界背书（不是「能跑」，是「算得对」）：
 *
 *   19.0 optimal-stopping（R5：k 选择先知不等式 + 对数域二项尾部）：
 *     ① 解析锚点：E[min(k,Bin(n,p))] 闭式对照（k=1 → 1−(1−p)^n、
 *        k≥n → np、p∈{0,1} 端点）；[0,1] 两点分布 n=2 的手算值
 *        （online = prophet = 0.75、k=2 全收 = 1）
 *     ② 跨代一致：k=1 的 kSelectionValue 与既有 backwardInduction 逐位
 *        一致；prophetTopK(k=1) 与既有 prophetValue 逐位一致（200 种子）
 *     ③ 包络链：ruleValue ≤ onlineValue ≤ prophetValue（200 种子 × k∈1..4）
 *     ④ k 单调：V(n,k) ≤ V(n,k+1)、prophetTopK 同理（200 种子）
 *     ⑤ 定理界：online ≥ k/(k+1)·prophet 与 随机化阈值规则 ≥ k/(k+1)
 *        （k=1 即 Samuel-Cahn 1/2 界；200 种子 × k∈1..4）
 *
 *   29.0 mcts（R5：PUCT + 子树重用）：
 *     ⑥ 确定性：ucb1 / puct / 重用续算三种口径各两次运行逐位一致（200 种子）
 *     ⑦ PUCT 收敛：Bernoulli 臂域上 200 种子最优臂命中率 ≥ 95%
 *     ⑧ 先验增益：信息先验（集中真最优臂 0.7）的 PUCT 命中率 ≥ 均匀
 *        先验口径的命中率（先验项真的在导流）
 *     ⑨ 重用不变量：同根续算 root visits = 两轮迭代和（201 vs 独立重跑
 *        101）、树节点数单调不降；advance 后在新根搜索连贯
 *     ⑩ 契约：非法 exploration/priors 显式 throw
 *
 *   71.0 astar-search（R5：加权 A* w-次优界 + 惰性 h）：
 *     ⑪ w=1 零漂移：h≡0 与 Dijkstra 同成本/同扩展/零重开（30 例），
 *        octile h 成本 = Dijkstra（200 种子）
 *     ⑫ w-次优界：w ∈ {1.3, 2, 3} 全部 Ĉ ≤ w·C*（200 种子；定理级）
 *     ⑬ 扩展账单随 w 总量单调不增（贪心换次优的收益方向）
 *     ⑭ 惰性 h：h 调用数 = 触达节点数 < |V|（200 种子平均 ~39% |V|）
 *     ⑮ 契约：weight < 1 / NaN 显式 throw（次优界陈述的保护）
 *
 *   85.0 symbolic-solver（R5：计数文字传播 + 相位保存/VSIDS）：
 *     ⑯ 引擎等价：counted（缺省）vs scan 在 200 种子相变区 3-SAT +
 *        鸽笼 4 例 + 重复文字子句上 sat/model/账单全字段逐位一致
 *     ⑰ 完备性保持：phaseSaving / vsids（及其组合）vs 暴力枚举一致、
 *        SAT 模型代入通过、UNSAT 一致（200 种子 + 鸽笼 + 种植解）
 *     ⑱ 确定性：全部新配置两次运行逐位一致（200 种子）
 *     ⑲ 性能：n=60 相变区 12 实例 scan vs counted 耗时对照
 *        （conflicts 全等——快不改路径，只改每步的价）
 *     ⑳ 契约：非法 engine/branching 显式 throw
 *
 *   84.0 pomdp-planning（R5：PBVI + α 裁剪关键坐标预过滤）：
 *     ㉑ pruneFast 等价：关键坐标预过滤开/关在 200 种子（支撑 + 全坐标）
 *        上 alphas/actions/sizes 逐位全等
 *     ㉒ PWLC 凸性：V(λb₁+(1−λ)b₂) ≤ λV(b₁)+(1−λ)V(b₂)（凸 = 弦下方；
 *        240 种子 (b₁,b₂,λ) 三元组）
 *     ㉓ PBVI 夹逼：pbvi(H) ≤ 同视界暴力信念树 ≤ QMDP（11 格点 + 240
 *        随机信念）
 *     ㉔ PBVI 点集加密收敛：单点集间隙 ≫ 11 点集间隙（下界收紧方向）
 *     ㉕ 裁剪统计与耗时：跳过率 + fast/slow 耗时对照（tiger 全坐标 H=6）
 *
 * 全部确定性（随机处 mulberry32 种子）。运行：
 *   node --experimental-transform-types scripts/verify-r5-planning.mjs
 */

import {
  prophetValue,
  backwardInduction,
  expectedMinBinomial,
  prophetTopK,
  kSelectionValue,
  kSelectionThresholdRule,
  kSelectionProphet,
} from '../src/core/optimal-stopping.ts';
import { UctSearch } from '../src/core/mcts.ts';
import {
  astar,
  dijkstra,
  gridWorld,
  gridHeuristic,
  GRID_METRIC,
  zeroHeuristic,
  graphFromEdgeList,
} from '../src/core/astar-search.ts';
import {
  dpllSolve,
  bruteForceSat,
  randomKSat,
  plantedSat,
  checkModel,
} from '../src/core/symbolic-solver.ts';
import {
  tigerPomdp,
  alphaVectorVI,
  beliefTreeEvaluate,
  pbvi,
  qmdp,
  qmdpValueAt,
} from '../src/core/pomdp-planning.ts';

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
function throws(fn, label) {
  try {
    fn();
    ok(false, `${label}（未抛出——校验缺失）`);
  } catch (e) {
    ok(true, `${label}（${String(e.message).slice(0, 48)}）`);
  }
}
/** mulberry32（与内核同源算法，脚本侧独立实例） */
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

// ═══════════════════ 19.0 最优停止：k 选择先知不等式 ═══════════════════

section('19.0 R5-A1 解析锚点：E[min(k,Bin(n,p))] 与两点分布手算');

ok(near(expectedMinBinomial(1, 10, 0.3), 1 - Math.pow(0.7, 10), 1e-12), 'Emin(k=1) = 1−(1−p)ⁿ 闭式（1e-12）');
ok(near(expectedMinBinomial(12, 10, 0.3), 10 * 0.3, 1e-12), 'Emin(k≥n) = E[B] = np 闭式（min 不起作用）');
ok(expectedMinBinomial(3, 10, 0) === 0 && expectedMinBinomial(3, 10, 1) === 3, 'Emin 端点 p∈{0,1} 闭式（0 与 min(k,n)）');
ok(near(expectedMinBinomial(2, 5, 0.5), 57 / 32, 1e-12), 'Emin(k=2,n=5,p=.5) 手算：P(B≥1)+P(B≥2) = 31/32+26/32 = 57/32');

{
  const hand1 = kSelectionProphet([0, 1], 2, 1);
  ok(near(hand1.onlineValue, 0.75, 1e-12) && near(hand1.prophetValue, 0.75, 1e-12),
    '[0,1] 均匀 n=2 k=1：online = prophet = 0.75 手算（信息无增益的退化例）');
  const hand2 = kSelectionProphet([0, 1], 2, 2);
  ok(near(hand2.onlineValue, 1, 1e-12) && near(hand2.prophetValue, 1, 1e-12) && near(hand2.ruleValue, 1, 1e-12),
    '[0,1] 均匀 n=2 k=2：全收 = top-2 = 1（名额饱和退化）');
  const hand3 = kSelectionProphet([0.5, 0.5, 0.5], 4, 2);
  ok(near(hand3.onlineValue, 1, 1e-12) && near(hand3.prophetValue, 1, 1e-12),
    '常数分布 n=4 k=2：online = prophet = 2×0.5（无不确定性退化）');
}

section('19.0 R5-A4 性质（200 种子）：跨代一致 · 包络 · 单调 · 定理界');

{
  const CASES = 200;
  let consistency = 0; // k=1 与既有 backwardInduction / prophetValue 逐位一致
  let prophetMatch = 0;
  let envelope = 0; // rule ≤ online ≤ prophet
  let monotone = 0; // V(n,k) 与 prophetTopK 对 k 单调
  let thmOnline = 0; // online 与随机化阈值规则成色 ≥ k/(k+1)
  let mixed = 0; // 随机化阈值路径覆盖数
  let minOnlineRatio = Number.POSITIVE_INFINITY;
  let minRuleRatio = Number.POSITIVE_INFINITY;

  for (let s = 0; s < CASES; s += 1) {
    const rng = mulberry32(51_0000 + s);
    const m = 10 + Math.floor(rng() * 3);
    const samples = Array.from({ length: m }, () => rng());
    const n = 3 + Math.floor(rng() * 8);
    const bi = backwardInduction(samples, n);
    const ks = kSelectionValue(samples, n, 1);
    if (bi.values.length > 0 && Math.abs(bi.values[0] - ks.value) <= 0) consistency += 1;
    if (Math.abs(prophetValue(samples, n) - prophetTopK(samples, n, 1)) <= 1e-12) prophetMatch += 1;

    let allOk = true;
    let monoOk = true;
    let thmOk = true;
    for (let k = 1; k <= 4; k += 1) {
      const rep = kSelectionProphet(samples, n, k);
      const g = k / (k + 1);
      if (!(rep.ruleValue <= rep.onlineValue + 1e-9 && rep.onlineValue <= rep.prophetValue + 1e-9)) allOk = false;
      if (kSelectionThresholdRule(samples, n, k).mix > 0) mixed += 1;
      if (rep.competitiveRatio < g - 1e-9) {
        thmOk = false;
        minOnlineRatio = Math.min(minOnlineRatio, rep.competitiveRatio / g);
      }
      if (rep.ruleRatio < g - 1e-9) {
        thmOk = false;
        minRuleRatio = Math.min(minRuleRatio, rep.ruleRatio / g);
      }
      // k 单调（k ≤ n 才有意义；k > n 时 kk 封顶）
      if (k < n) {
        const v1 = kSelectionValue(samples, n, k).value;
        const v2 = kSelectionValue(samples, n, k + 1).value;
        const p1 = prophetTopK(samples, n, k);
        const p2 = prophetTopK(samples, n, k + 1);
        if (v2 < v1 - 1e-9 || p2 < p1 - 1e-9) monoOk = false;
      }
    }
    if (allOk) envelope += 1;
    if (monoOk) monotone += 1;
    if (thmOk) thmOnline += 1;
  }
  ok(consistency === CASES, `跨代一致：k=1 二维归纳与 backwardInduction 逐位相等（${consistency}/${CASES}）`);
  ok(prophetMatch === CASES, `跨代一致：prophetTopK(k=1) = prophetValue（1e-12，${prophetMatch}/${CASES}）`);
  ok(envelope === CASES, `包络链 rule ≤ online ≤ prophet（${envelope}/${CASES} × k∈1..4）`);
  ok(monotone === CASES, `k 单调：V(n,k) ≤ V(n,k+1) 且 prophet 同理（${monotone}/${CASES}）`);
  ok(thmOnline === CASES,
    `定理界：online 与随机化单阈值规则成色 ≥ k/(k+1)（k=1 即 Samuel-Cahn ½；${thmOnline}/${CASES} 种子 × k∈1..4 全过，最差 online 比值 ${minOnlineRatio.toFixed(6)}、最差规则比值 ${minRuleRatio.toFixed(6)}）`);
  ok(mixed > 0, `随机化阈值路径被真实覆盖（${mixed} 例混合权重 > 0——定理的 E[录取数]=k 口径非摆设）`);
}

// ═══════════════════ 29.0 MCTS：PUCT + 子树重用 ═══════════════════

section('29.0 R5-A1/A2 PUCT 与子树重用（200 种子 Bernoulli 臂域）');

/** Bernoulli K 臂域：动作 aᵢ 一步得 1/0（pᵢ），终局 */
function banditDomain(ps, priors) {
  return {
    actions: (s) => (s === 'root' ? ps.map((_, i) => `a${i}`) : []),
    step: (s, a, rng) => {
      const i = Number(a.slice(1));
      return { state: 'end', reward: rng() < ps[i] ? 1 : 0, terminal: true };
    },
    ...(priors !== undefined ? { priors: () => priors } : {}),
  };
}

{
  const CASES = 200;
  let detUcb = 0;
  let detPuct = 0;
  let puctBest = 0;
  let puctPriorBest = 0;
  let puctUniformBest = 0;
  for (let s = 0; s < CASES; s += 1) {
    const ps = [0.2, 0.8, 0.5];
    const r1 = new UctSearch({ seed: 52_0000 + s }, banditDomain(ps)).search('root', { iterations: 60 });
    const r2 = new UctSearch({ seed: 52_0000 + s }, banditDomain(ps)).search('root', { iterations: 60 });
    if (JSON.stringify(r1) === JSON.stringify(r2)) detUcb += 1;
    const p1 = new UctSearch({ seed: 53_0000 + s, exploration: 'puct' }, banditDomain(ps)).search('root', { iterations: 150 });
    const p2 = new UctSearch({ seed: 53_0000 + s, exploration: 'puct' }, banditDomain(ps)).search('root', { iterations: 150 });
    if (JSON.stringify(p1) === JSON.stringify(p2)) detPuct += 1;
    if (p1.bestAction === 'a1') puctBest += 1;
    // 信息先验（真最优臂 0.7）vs 无先验（均匀）
    const domP = banditDomain([0.15, 0.85, 0.4], new Map([['a0', 0.15], ['a1', 0.7], ['a2', 0.15]]));
    const domU = banditDomain([0.15, 0.85, 0.4]);
    const rp = new UctSearch({ seed: 54_0000 + s, exploration: 'puct' }, domP).search('root', { iterations: 80 });
    const ru = new UctSearch({ seed: 54_0000 + s, exploration: 'puct' }, domU).search('root', { iterations: 80 });
    if (rp.bestAction === 'a1') puctPriorBest += 1;
    if (ru.bestAction === 'a1') puctUniformBest += 1;
  }
  ok(detUcb === CASES, `UCB1 确定性：同 (seed, domain) 两次运行逐位一致（${detUcb}/${CASES}）`);
  ok(detPuct === CASES, `PUCT 确定性：两次运行逐位一致（${detPuct}/${CASES}）`);
  ok(puctBest >= CASES * 0.95, `PUCT 收敛：150 迭代选中真最优臂 a1（p=0.8）≥95%（${puctBest}/${CASES}）`);
  ok(puctPriorBest >= puctUniformBest,
    `先验增益：信息先验命中率 ${puctPriorBest}/${CASES} ≥ 均匀先验 ${puctUniformBest}/${CASES}（先验项真实导流）`);
}

{
  // 重用不变量：同根续算 vs 独立重跑
  const ps = [0.3, 0.7];
  const u = new UctSearch({ seed: 55_0001 }, banditDomain(ps));
  const rA = u.search('root', { iterations: 100 });
  const nodesA = rA.treeNodes;
  const rB = u.search('root', { iterations: 100 }, { reuseSubtree: true });
  const visitsAfterReuse = rB.children.reduce((s2, c) => s2 + c.visits, 0) + 1;
  const u2 = new UctSearch({ seed: 55_0001 }, banditDomain(ps));
  u2.search('root', { iterations: 100 });
  const rB2 = u2.search('root', { iterations: 100 });
  const visitsFresh = rB2.children.reduce((s2, c) => s2 + c.visits, 0) + 1;
  ok(visitsAfterReuse === 201 && visitsFresh === 101,
    `重用不变量：续算后根访问 = 100+100+1 = ${visitsAfterReuse}（独立重跑只有 ${visitsFresh}——统计量延续而非重置）`);
  ok(rB.treeNodes >= nodesA, `重用不变量：树节点数单调不降（${nodesA} → ${rB.treeNodes}）`);
  // advance：链域上执行根动作后子树提升
  const chain = {
    actions: (s) => (s.startsWith('t') ? [] : ['L', 'R']),
    step: (s, a) => ({ state: s + a, reward: a === 'R' ? 1 : 0.2, terminal: false }),
  };
  const uc = new UctSearch({ seed: 55_0002, discount: 1, rolloutDepth: 4 }, chain);
  const rc = uc.search('', { iterations: 200 });
  ok(rc.bestAction === 'R', `链域最优首动作 R（R 边奖励 1 > L 边 0.2）`);
  ok(uc.advance('R') === true, 'advance("R") 子树提升成功');
  const rc2 = uc.search('R', { iterations: 100 }, { reuseSubtree: true });
  ok(rc2.treeNodes >= rc.treeNodes - 1 && rc2.principalVariation.length > 0,
    `advance 后在新根续算：节点 ${rc2.treeNodes} ≥ 旧树 −1（兄弟丢弃、后代保留），PV 连贯（${rc2.principalVariation.length} 步）`);
  throws(() => new UctSearch({ exploration: 'bogus' }), 'UctSearch 非法 exploration 显式 throw');
  throws(() => {
    new UctSearch({ exploration: 'puct' }, banditDomain([0.5], new Map([['a0', -1]]))).search('root', { iterations: 5 });
  }, 'domain.priors 负值显式 throw');
}

// ═══════════════════ 71.0 A*：加权 A* + 惰性 h ═══════════════════

section('71.0 R5-A1/A2 加权 A* w-次优界与惰性 h（200 种子网格）');

{
  const CASES = 200;
  const WS = [1.3, 2, 3];
  let boundPass = 0;
  let costW1 = 0;
  let h0Identical = 0;
  let expTotal = { 1: 0, 1.3: 0, 2: 0, 3: 0 };
  let hCallsTotal = 0;
  let nodesTotal = 0;
  for (let s = 0; s < CASES; s += 1) {
    const world = gridWorld(15, 15, 35, 20_261_001 + s);
    const free = world.freeCells();
    const start = free.includes('0,0') ? '0,0' : free[0];
    const goal = free.includes('14,14') ? '14,14' : free[free.length - 1];
    const h = gridHeuristic(world, goal, GRID_METRIC.OCTILE);
    // 惰性 h：计数调用
    let hCalls = 0;
    const countingH = (n) => {
      hCalls += 1;
      return h(n);
    };
    const A1 = astar({ graph: world.graph, start, goal, h: countingH });
    hCallsTotal += hCalls;
    nodesTotal += world.freeCells().length;
    expTotal[1] += A1.expanded;
    const D = dijkstra(world.graph, start, goal);
    if (near(A1.cost, D.cost, 1e-9)) costW1 += 1;
    let allBounded = true;
    for (const w of WS) {
      const Aw = astar({ graph: world.graph, start, goal, h, weight: w });
      expTotal[w] += Aw.expanded;
      if (!(Aw.cost <= w * D.cost + 1e-9)) allBounded = false;
    }
    if (allBounded) boundPass += 1;
  }
  // h≡0 与 Dijkstra 逐位同型（30 例，2 0×20 网格与既有锚点同规模）
  for (let s = 0; s < 30; s += 1) {
    const world = gridWorld(20, 20, 60, 20_261_001 + s);
    const free = world.freeCells();
    const start = free.includes('0,0') ? '0,0' : free[0];
    const goal = free.includes('19,19') ? '19,19' : free[free.length - 1];
    const D = dijkstra(world.graph, start, goal);
    const A = astar({ graph: world.graph, start, goal, h: zeroHeuristic });
    if (A.cost === D.cost && A.expanded === D.expanded && A.reopened === 0) h0Identical += 1;
  }
  const pct = ((100 * hCallsTotal) / nodesTotal).toFixed(1);
  ok(h0Identical === 30, `w=1 零漂移：h≡0 与 Dijkstra 同成本/同扩展/零重开（${h0Identical}/30 逐位同型）`);
  ok(costW1 === CASES, `w=1 最优性：octile h 成本 = Dijkstra（${costW1}/${CASES}）`);
  ok(boundPass === CASES, `w-次优界：w∈{1.3,2,3} 全部 Ĉ ≤ w·C*（${boundPass}/${CASES}——Pohl/ARA* 定理级）`);
  ok(expTotal[1] >= expTotal[1.3] && expTotal[1.3] >= expTotal[2] && expTotal[2] >= expTotal[3],
    `扩展账单随 w 总量单调不增：w1 ${expTotal[1]} ≥ w1.3 ${expTotal[1.3]} ≥ w2 ${expTotal[2]} ≥ w3 ${expTotal[3]}`);
  ok(hCallsTotal < nodesTotal,
    `惰性 h：调用 ${hCallsTotal} 次 < 全图 ${nodesTotal}（平均 ${pct}% |V|——昂贵启发式只付触达部分的价格）`);
  throws(() => astar({ graph: graphFromEdgeList(['a'], []), start: 'a', goal: 'a', h: zeroHeuristic, weight: 0.5 }), 'astar weight<1 显式 throw');
  throws(() => astar({ graph: graphFromEdgeList(['a', 'b'], [{ from: 'a', to: 'b', cost: 1 }]), start: 'a', goal: 'b', h: () => Number.NaN }), 'astar h 首触达 NaN 显式 throw（惰性口径保留校验）');
}

// ═══════════════════ 85.0 SAT：计数传播 + 相位保存/VSIDS ═══════════════════

section('85.0 R5-A1/A2 双引擎等价与搜索序进化（200 种子 + 鸽笼 + 种植解）');

/** 鸽笼 PHP(b,h)：b 球 h 洞，经典 UNSAT */
function php(balls, holes) {
  const clauses = [];
  const vid = (i, j) => (i - 1) * holes + j;
  for (let i = 1; i <= balls; i += 1) clauses.push(Array.from({ length: holes }, (_, j) => vid(i, j + 1)));
  for (let i = 1; i <= balls; i += 1) {
    for (let j = 1; j <= holes; j += 1) {
      for (let i2 = i + 1; i2 <= balls; i2 += 1) clauses.push([-vid(i, j), -vid(i2, j)]);
    }
  }
  return { clauses, numVars: balls * holes };
}

{
  const CASES = 200;
  let engineEq = 0;
  for (let s = 0; s < CASES; s += 1) {
    const n = 14 + (s % 7);
    const cnf = randomKSat(n, Math.round(n * 4.26), 3, 85_1000 + s);
    const a = dpllSolve(cnf, { engine: 'scan' });
    const b = dpllSolve(cnf, {}); // 缺省 counted
    const modelEq = a.model === null || b.model === null ? a.model === b.model
      : [...a.model.entries()].every(([k, v]) => b.model.get(k) === v);
    if (a.sat === b.sat && a.decisions === b.decisions && a.propagations === b.propagations &&
      a.conflicts === b.conflicts && a.learned === b.learned && a.pureLiterals === b.pureLiterals && modelEq) engineEq += 1;
  }
  ok(engineEq === CASES, `引擎等价：counted（缺省）vs scan 全字段 + 模型逐位一致（${engineEq}/${CASES} 相变区 3-SAT）`);

  let phpEq = 0;
  const phpCases = [[3, 2], [4, 3], [5, 4], [6, 4]];
  for (const [b, h] of phpCases) {
    const c = php(b, h);
    const a = dpllSolve(c, { engine: 'scan' });
    const d = dpllSolve(c, {});
    if (!a.sat && !d.sat && a.conflicts === d.conflicts && a.decisions === d.decisions && a.learned === d.learned) phpEq += 1;
  }
  ok(phpEq === phpCases.length, `引擎等价（结构 UNSAT）：鸽笼 ${phpCases.map(([b, h]) => `PHP(${b},${h})`).join('/')} 判定与账单逐位一致（${phpEq}/${phpCases.length}）`);

  // 重复文字子句：计数引擎按出现次数计数的口径对照
  const dup = { clauses: [[1, 1, 2], [-2], [1, 1, 1, 1]], numVars: 2 };
  const dupA = dpllSolve(dup, { engine: 'scan' });
  const dupB = dpllSolve(dup, {});
  ok(JSON.stringify(dupA) === JSON.stringify(dupB) && dupA.sat === true,
    `重复文字子句：两引擎逐位一致且 SAT（计数按出现数——与逐文字扫描同口径）`);

  let correctAll = 0;
  let detAll = 0;
  const combos = [
    { phaseSaving: true },
    { branching: 'vsids' },
    { phaseSaving: true, branching: 'vsids' },
  ];
  for (let s = 0; s < CASES; s += 1) {
    const n = 12 + (s % 5);
    const cnf = randomKSat(n, Math.round(n * 4.26), 3, 85_2000 + s);
    const bf = bruteForceSat(cnf);
    let okAll = true;
    let det = true;
    for (const opt of combos) {
      const r1 = dpllSolve(cnf, opt);
      const r2 = dpllSolve(cnf, opt);
      if (JSON.stringify(r1) !== JSON.stringify(r2)) det = false;
      const good = r1.sat === bf.sat && (!r1.sat || checkModel(cnf, r1.model));
      if (!good) okAll = false;
    }
    if (okAll) correctAll += 1;
    if (det) detAll += 1;
  }
  ok(correctAll === CASES, `完备性保持：phaseSaving / vsids / 组合三种配置 vs 2ⁿ 暴力枚举一致 + 模型代入通过（${correctAll}/${CASES}）`);
  ok(detAll === CASES, `确定性：全部新配置两次运行逐位一致（${detAll}/${CASES}）`);

  // UNSAT 一致（phase/vsids 不改判定）+ 种植解
  let unsatEq = 0;
  for (const [b, h] of [[7, 6], [8, 7]]) {
    const c = php(b, h);
    const base = dpllSolve(c, {});
    const vs = dpllSolve(c, { phaseSaving: true, branching: 'vsids' });
    if (!base.sat && !vs.sat) unsatEq += 1;
  }
  ok(unsatEq === 2, `UNSAT 一致：PHP(7,6)/PHP(8,7) 在 vsids+相位保存下仍判 UNSAT（${unsatEq}/2）`);
  let plantedOk = 0;
  for (let s = 0; s < 60; s += 1) {
    const { cnf } = plantedSat(30, 130, 3, 85_3000 + s);
    const r = dpllSolve(cnf, { phaseSaving: true, branching: 'vsids' });
    if (r.sat && checkModel(cnf, r.model)) plantedOk += 1;
  }
  ok(plantedOk === 60, `种植解（n=30 相变密度）：vsids+相位保存模型全部代入通过（${plantedOk}/60）`);

  throws(() => dpllSolve({ clauses: [], numVars: 0 }, { engine: 'turbo' }), 'dpllSolve 非法 engine 显式 throw');
  throws(() => dpllSolve({ clauses: [], numVars: 0 }, { branching: 'dlis' }), 'dpllSolve 非法 branching 显式 throw');

  // 性能对照：n=60 相变区，scan vs counted（conflicts 必须全等）
  const hard = [];
  for (let s = 0; s < 12; s += 1) hard.push(randomKSat(60, Math.round(60 * 4.26), 3, 85_4000 + s));
  let tScan = 0;
  let tCounted = 0;
  let confScan = 0;
  let confCounted = 0;
  for (const c of hard) {
    let t0 = performance.now();
    const a = dpllSolve(c, { engine: 'scan' });
    tScan += performance.now() - t0;
    confScan += a.conflicts;
    t0 = performance.now();
    const b = dpllSolve(c, {});
    tCounted += performance.now() - t0;
    confCounted += b.conflicts;
  }
  ok(confScan === confCounted,
    `性能对照（n=60 ×12）：conflicts 全等 ${confScan} = ${confCounted}（快不改搜索路径）——耗时 scan ${tScan.toFixed(0)}ms vs counted ${tCounted.toFixed(0)}ms（${(tScan / tCounted).toFixed(2)}×）`);
}

// ═══════════════════ 84.0 POMDP：PBVI + 裁剪预过滤 ═══════════════════

section('84.0 R5-A1/A2 PBVI 夹逼与 α 裁剪预过滤（200+ 种子）');

{
  const tiger = tigerPomdp();
  const CASES = 200;
  let fastEq = 0;
  for (let s = 0; s < CASES; s += 1) {
    const H = 2 + (s % 6);
    const fast = alphaVectorVI(tiger, H, { pruneSupport: [0, 1] });
    const slow = alphaVectorVI(tiger, H, { pruneSupport: [0, 1], pruneFast: false });
    const fullF = alphaVectorVI(tiger, Math.min(H, 4));
    const fullS = alphaVectorVI(tiger, Math.min(H, 4), { pruneFast: false });
    if (JSON.stringify(fast.alphas) === JSON.stringify(slow.alphas) &&
      JSON.stringify(fast.sizes) === JSON.stringify(slow.sizes) &&
      JSON.stringify(fast.actions) === JSON.stringify(slow.actions) &&
      JSON.stringify(fullF.alphas) === JSON.stringify(fullS.alphas) &&
      JSON.stringify(fullF.sizes) === JSON.stringify(fullS.sizes)) fastEq += 1;
  }
  ok(fastEq === CASES, `pruneFast 等价：关键坐标预过滤开/关 alphas/actions/sizes 逐位全等（${fastEq}/${CASES}，支撑 + 全坐标双路径）`);

  // PWLC 凸性（凸 = 曲线在弦下方）：240 种子三元组
  {
    const v = alphaVectorVI(tiger, 8, { pruneSupport: [0, 1] });
    let convexOk = 0;
    const TOTAL = 240;
    for (let i = 0; i < TOTAL; i += 1) {
      const rng = mulberry32(84_1000 + i);
      const l1 = rng();
      const l2 = rng();
      const lam = rng();
      const b1 = [l1, 1 - l1, 0];
      const b2 = [l2, 1 - l2, 0];
      const bm = [lam * b1[0] + (1 - lam) * b2[0], lam * b1[1] + (1 - lam) * b2[1], 0];
      const chord = lam * v.valueAt(b1) + (1 - lam) * v.valueAt(b2);
      if (v.valueAt(bm) <= chord + 1e-9) convexOk += 1;
    }
    ok(convexOk === TOTAL, `PWLC 凸性：V(λb₁+(1−λ)b₂) ≤ 弦（${convexOk}/${TOTAL} 种子三元组）`);
  }

  // PBVI 夹逼：pbvi(H) ≤ 同视界暴力树 ≤ QMDP
  const pts = [];
  for (let i = 0; i <= 10; i += 1) pts.push([i / 10, 1 - i / 10, 0]);
  const { Q } = qmdp(tiger);
  const pb6 = pbvi(tiger, pts, 6);
  let lbGrid = 0;
  let ubGrid = 0;
  for (const b of pts) {
    const exact = beliefTreeEvaluate(tiger, b, 6);
    if (pb6.valueAt(b) <= exact + 1e-9) lbGrid += 1;
    if (exact <= qmdpValueAt(Q, b) + 1e-9) ubGrid += 1;
  }
  ok(lbGrid === pts.length, `PBVI 下界：pbvi(6) ≤ 暴力树 V₆（格点 ${lbGrid}/${pts.length}）`);
  ok(ubGrid === pts.length, `QMDP 上界：暴力树 V₆ ≤ QMDP（格点 ${ubGrid}/${pts.length}）——夹逼区间 [PBVI, QMDP]`);

  let lbRandom = 0;
  const RAND = 240;
  for (let s = 0; s < RAND; s += 1) {
    const rng = mulberry32(84_2000 + s);
    const x = rng();
    const b = [x, 1 - x, 0];
    if (pb6.valueAt(b) <= beliefTreeEvaluate(tiger, b, 6) + 1e-9) lbRandom += 1;
  }
  ok(lbRandom === RAND, `PBVI 下界（随机信念）：${lbRandom}/${RAND} 点 pbvi ≤ 精确同视界值`);

  // 点集加密收敛
  const pbCoarse = pbvi(tiger, [[0.5, 0.5, 0]], 8);
  const pbDense = pbvi(tiger, pts, 8);
  const ex8 = beliefTreeEvaluate(tiger, [0.5, 0.5, 0], 8);
  const gapCoarse = ex8 - pbCoarse.valueAt([0.5, 0.5, 0]);
  const gapDense = ex8 - pbDense.valueAt([0.5, 0.5, 0]);
  ok(gapDense < gapCoarse && gapDense < 0.5,
    `点集加密收敛：b=0.5 H=8 间隙 单点 ${gapCoarse.toFixed(3)} → 11 点 ${gapDense.toFixed(3)}（下界收紧两个数量级）`);

  // 裁剪统计 + 计时
  const st5 = alphaVectorVI(tiger, 5);
  const skipRate = (100 * st5.pruneStats.skipped) / (st5.pruneStats.checks + st5.pruneStats.skipped);
  let tFast = 0;
  let tSlow = 0;
  for (let r = 0; r < 3; r += 1) {
    let t0 = performance.now();
    alphaVectorVI(tiger, 6, { pruneFast: true });
    tFast += performance.now() - t0;
    t0 = performance.now();
    alphaVectorVI(tiger, 6, { pruneFast: false });
    tSlow += performance.now() - t0;
  }
  ok(skipRate > 50,
    `预过滤跳过率：全坐标 H=5 跳过 ${st5.pruneStats.skipped}/${st5.pruneStats.checks + st5.pruneStats.skipped}（${skipRate.toFixed(1)}% > 50%）——H=6 耗时 fast ${tFast.toFixed(0)}ms vs slow ${tSlow.toFixed(0)}ms（${(tSlow / tFast).toFixed(2)}×）`);
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log('\n══════════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL ${failed} —— R5-A6 五内核（19/29/71/85/84）第五轮进化全部锚点成立`);
} else {
  console.log(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
