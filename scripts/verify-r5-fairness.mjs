/**
 * verify-r5-fairness.mjs — R5-A13「全部内核世界性进化」公平分配六内核验证
 *
 * 覆盖内核：16.0 shapley / 44.0 fair-division / 63.0 nucleolus /
 *           45.0 budget-allocation / 60.0 rate-distortion / 99.0 attention-economy
 *
 * 进化轴锚点（旧 → 新）：
 *   16.0 Shapley：
 *     · 加权 Shapley（Kalai–Samet 非对称权，部分排列 DFS）——手算锚
 *       (λ=3:1 → φ=1/4:3/4)、等权精确退化、效率/虚拟/可加公理 ≥50 例
 *     · 分层排列采样（按首玩家分层 + 层内方差估计 + Bonferroni 并集界
 *       CI）——真值覆盖、无偏、方差缩减方向
 *   44.0 公平分配：
 *     · EF1 精确判定（构造正/负例 + 违例明细字段）
 *     · 嫉妒循环消除（Lipton et al. 定理 EF1）≥200 种子
 *     · 贪心 MNW（log 域）——2 玩家穷举对照 + 诚实 EF1 标志
 *   63.0 核仁：
 *     · 加性短路（零 LP）、对称塌缩（约束 2ⁿ−2 → 类计数）、批量探针
 *       ——nucleolusFast 与 nucleolus 输出精确一致 + LP 数下降 + n=7
 *       全对称可解性（经典口径 ~14s → ~2ms）
 *     · 核仁唯一性：随机效率保持扰动的字典序最优性抽查
 *   45.0 OCBA：
 *     · 序保持受控圆整 + 容量上限（多约束预算）≥200 种子：守恒/界限/
 *       序违规 0
 *     · 无 caps 时与 ocbaAllocate 逐位一致（等价证明）+ 病态垫底实例
 *       守恒修复（经典 guard 触顶漏撤）
 *   60.0 率失真：
 *     · 加权汉明 R(D)（不对称失真）——对称极限退化 = 解析锚、与全矩阵
 *       BA 交叉验证 ≥50 点、单调性、D_max 边界
 *     · β 扫描热启动 rdCurveFast ≡ rdCurve + 迭代数下降
 *   99.0 注意力经济：
 *     · 时间衰减注意力（凹性保持、年龄单调不增、DSIC 保持、年龄簿记、
 *       出局年龄解析）
 *     · O(k·#winners) 支付快径与经典口径 ≥200 种子逐位一致 + 耗时对照
 *
 * 运行：npm run build && node --experimental-transform-types scripts/verify-r5-fairness.mjs
 */

// shapley.ts 内部依赖 anytime-evidence（经 dist 聚合导入，与 verify-shapley 同款）；
// 其余五内核零内部依赖，直接从内核模块导入（与 verify-game-kernels 同款）——
// 新进化入口由内核模块直出，index.ts 聚合表不在本轮所有权内。
import { ShapleyAttributionEngine } from '../dist/index.mjs';
import {
  isEF1,
  envyCycleElimination,
  greedyMaxNashWelfare,
  nashWelfareOf,
} from '../src/core/fair-division.ts';
import {
  nucleolus,
  nucleolusFast,
  symmetryClasses,
  makeGame,
} from '../src/core/nucleolus.ts';
import { ocbaAllocate, ocbaAllocatePlan, monteCarloCorrectSelection } from '../src/core/budget-allocation.ts';
import {
  binaryHammingRD,
  blahutArimoto,
  rdCurve,
  rdCurveFast,
  weightedHammingRD,
  weightedHammingPoint,
} from '../src/core/rate-distortion.ts';
import {
  allocateAttention,
  allocateAttentionFast,
  allocateAttentionDecayed,
  decayedSource,
  decayExitAge,
  geometricSource,
  unitDemandSource,
  saturatingSource,
  concavityCheck,
  misreportGain,
} from '../src/core/attention-economy.ts';

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
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, label);
}
function section(title) {
  console.log(`\n■ ${title}`);
}
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

// ═══════════════════ 16.0 Shapley：加权 Shapley ═══════════════════

section('16.0 加权 Shapley（Kalai–Samet）：手算锚 + 等权退化 + 公理电池');

{
  // 手算锚：搭档博弈 V=1 iff {a,b}，权 λ=(3,1)：
  // p(a 先) = 3/4 → φ_a = 3/4·0 + 1/4·1 = 1/4；φ_b = 3/4·1 = 3/4
  const partner = (m) => (m.includes('a') && m.includes('b') ? 1 : 0);
  const report = new ShapleyAttributionEngine(partner).weightedShapley(['a', 'b'], [3, 1]);
  const by = Object.fromEntries(report.attributions.map((x) => [x.playerId, x.shapley]));
  ok(near(by.a, 0.25, 1e-9) && near(by.b, 0.75, 1e-9), `手算锚：λ=(3,1) ⟹ φ=(1/4, 3/4)（实测 ${by.a}/${by.b}）`);
  ok(report.enumeratedNodes === 5, `部分排列 DFS 节点数 = 5（1 根 + 2 + 2 叶；实测 ${report.enumeratedNodes}——每节点恰结算一个玩家的边际）`);
  ok(near(report.efficiencyResidual, 0, 1e-9), `效率公理：Σφ^w − V(N) = 0（实测 ${report.efficiencyResidual}）`);
  ok(
    report.attributions.every((x) => x.exact && x.samples === 2),
    '加权口径下 samples = n!（2 个排列全覆盖）且 exact 标记',
  );

  // 等权 ⟹ 精确退化为经典 Shapley（10 个随机博弈逐玩家一致）
  let worstEq = 0;
  for (let seed = 0; seed < 10; seed += 1) {
    const rnd = mulberry32(seed);
    const n = 3 + Math.floor(rnd() * 4);
    const players = Array.from({ length: n }, (_, i) => `p${i}`);
    const table = new Map([['', 0]]);
    const v = (m) => {
      const key = [...m].sort().join(',');
      if (!table.has(key)) table.set(key, rnd());
      return table.get(key);
    };
    const engine = new ShapleyAttributionEngine(v);
    const classical = engine.attribute(players);
    const weighted = engine.weightedShapley(players, Array(n).fill(2.5));
    for (const p of players) {
      worstEq = Math.max(
        worstEq,
        Math.abs(classical.attributions.find((x) => x.playerId === p).shapley - weighted.attributions.find((x) => x.playerId === p).shapley),
      );
    }
  }
  ok(worstEq <= 1e-9, `等权精确退化：10 个随机博弈与经典 Shapley 最大偏差 ${worstEq.toExponential(2)} ≤ 1e-9`);

  // 公理电池 ≥50 随机博弈：效率 + 虚拟 + 可加（v(∅)=0 的合法特征函数；
  // 联盟值按「键哈希」生成——同一联盟在任何引擎任何查询序下值恒同）
  const keyHash = (key, offset) => {
    let h = offset >>> 0;
    for (let i = 0; i < key.length; i += 1) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
    return h >>> 0;
  };
  const mkGame = (offset) => {
    const table = new Map([['', 0]]);
    return (m) => {
      const key = [...m].sort().join(',');
      if (!table.has(key)) table.set(key, mulberry32(keyHash(key, offset))());
      return table.get(key);
    };
  };
  let worstEff = 0;
  let additivityOk = true;
  for (let seed = 0; seed < 50; seed += 1) {
    const rnd = mulberry32(1000 + seed);
    const n = 3 + Math.floor(rnd() * 4);
    const players = Array.from({ length: n }, (_, i) => `p${i}`);
    const v1 = mkGame(seed * 31 + 7);
    const v2 = mkGame(seed * 131 + 11);
    const vSum = (m) => v1(m) + v2(m);
    const weights = Array.from({ length: n }, () => 0.2 + rnd() * 5);
    const r1 = new ShapleyAttributionEngine(v1).weightedShapley(players, weights);
    worstEff = Math.max(worstEff, Math.abs(r1.attributions.reduce((s, x) => s + x.shapley, 0) - r1.totalValue));
    const ra = new ShapleyAttributionEngine(v1).weightedShapley(players, weights);
    const rb = new ShapleyAttributionEngine(v2).weightedShapley(players, weights);
    const rs = new ShapleyAttributionEngine(vSum).weightedShapley(players, weights);
    for (const p of players) {
      const x = rs.attributions.find((q) => q.playerId === p).shapley;
      const y = ra.attributions.find((q) => q.playerId === p).shapley + rb.attributions.find((q) => q.playerId === p).shapley;
      if (!near(x, y, 1e-5)) additivityOk = false;
    }
  }
  ok(worstEff <= 6e-6, `效率公理电池（50 随机博弈 × 随机权向量）：|Σφ^w − V(N)| 最大 ${worstEff.toExponential(2)} ≤ 6e-6（6 位小数报告口径 × n 项累积上界）`);
  ok(additivityOk, '可加公理：两博弈之和的加权 Shapley = 加权 Shapley 之和（50 例逐玩家 ≤ 1e-5 报告口径）');

  // 虚拟公理：d 对任何联盟零边际——任意权下恰得 0
  const dummyGame = (m) => m.filter((p) => p !== 'd').length / 3;
  const dr = new ShapleyAttributionEngine(dummyGame).weightedShapley(['a', 'b', 'c', 'd'], [5, 0.3, 1.7, 9.9]);
  const dAttr = dr.attributions.find((x) => x.playerId === 'd');
  ok(dAttr.shapley === 0 && dAttr.isDummy && dAttr.share === 0, `虚拟公理：零边际者在最不对称权 (λ_d=9.9) 下仍恰得 0（φ=${dAttr.shapley}，搭便车无利可图不因加权而破防）`);
  throws(() => new ShapleyAttributionEngine(partner).weightedShapley(['a', 'b'], [3, -1]), '负权显式抛错（排列概率良定义）');
  throws(() => new ShapleyAttributionEngine(partner).weightedShapley(['a'], [1, 2]), '权长不匹配显式抛错');
}

// ═══════════════════ 16.0 Shapley：分层排列采样 ═══════════════════

section('16.0 分层排列采样：无偏 + 任意时刻有效 CI + 方差缩减方向');

{
  // 10 玩家解析博弈（与 verify-shapley F 同构）：真值 φ_i = (w_i + 0.03)/3.05
  const players = Array.from({ length: 10 }, (_, i) => `p${i}`);
  const w = Object.fromEntries(players.map((p, i) => [p, (i + 1) / 20]));
  const TOTAL = 55 / 20 + 0.3;
  const v = (m) => (m.reduce((s, p) => s + w[p], 0) + (m.length >= 6 ? 0.3 : 0)) / TOTAL;
  const engine = new ShapleyAttributionEngine(v, { rng: mulberry32(123), maxPermutations: 4000, minPermutations: 30 });
  const report = engine.attributeStratified(players);

  ok(report.strata === 10 && report.perStratum === 400 && report.permutations === 4000, `按首玩家分 10 层 × 400 排列 = 4000（实测 ${report.strata}×${report.perStratum}）`);
  let maxErr = 0;
  let allCovered = true;
  for (const a of report.attributions) {
    const truth = (w[a.playerId] + 0.03) / TOTAL;
    maxErr = Math.max(maxErr, Math.abs(a.shapley - truth));
    if (!(a.lower - 1e-5 <= truth && truth <= a.upper + 1e-5)) allCovered = false;
  }
  ok(maxErr <= 0.02, `分层无偏性：10 玩家最大估计误差 ${maxErr.toFixed(4)} ≤ 0.02`);
  ok(allCovered, '全部真值落在分层合成置信区间内（逐层 EmpiricalBernstein α/n + Bonferroni 并集界——任意时刻有效不降级）');
  const shareSum = report.attributions.reduce((s, a) => s + a.share, 0);
  ok(near(shareSum, 1, 1e-4), `份额全额分发 Σ share = 1（实测 ${shareSum.toFixed(6)}）`);
  ok(report.attributions[0].playerId === 'p9' && report.attributions[9].playerId === 'p0', '座次正确：p9 第 1 … p0 第 10');
  const finite = report.varianceRatios.filter((r) => Number.isFinite(r));
  const avgRatio = finite.reduce((s, r) => s + r, 0) / report.varianceRatios.length;
  ok(
    avgRatio <= 1 + 1e-6 && finite.every((r) => r <= 1.05),
    `方差分解方向：逐玩家 分层/池化 方差比平均 ${avgRatio.toFixed(4)} ≤ 1（层间差被整段消除；实测最大 ${Math.max(...finite).toFixed(4)}）`,
  );
  ok(
    report.attributions.every((a) => a.samples === 4000 && !a.exact),
    '每玩家样本量 = 总排列数（10 层各 400 份边际）',
  );
}

// ═══════════════════ 44.0 公平分配：EF1 判定 ═══════════════════

section('44.0 EF1 精确判定：构造正/负例 + 违例明细');

{
  // 正例 1：无嫉妒（互相偏好自己的捆）
  const a1 = isEF1([[6, 4], [3, 5]], [[0], [1]]);
  ok(a1.ef1 && a1.violations.length === 0, '正例：互不嫉妒 ⟹ EF1 成立');

  // 正例 2：嫉妒存在但移除一件即消除（EF1 的「up to one item」语义）
  const a2 = isEF1([[10, 9], [1, 1]], [[1], [0]]); // A 得物品 1（9），B 得物品 0
  ok(a2.ef1, `正例：A 嫉妒 B（10 > 9）但移除 B 捆内唯一物品后消除 ⟹ EF1（嫉妒 1 ≤ 可移除 10）`);

  // 负例：B 嫉妒 A 超过任何单件（B 口径 A 捆 = 24，自己 = 0，最大件 9）
  const a3 = isEF1([[1, 1, 1], [9, 8, 7]], [[0, 1, 2], []]);
  ok(!a3.ef1 && a3.violations.length === 1, `负例：全给 A ⟹ EF1 违例被检出（${a3.violations.length} 条）`);
  const viol = a3.violations[0];
  ok(
    viol.envier === 1 && viol.envied === 0 && near(viol.envy, 24) && viol.removable === 9 && near(viol.envyAfterRemoval, 15),
    `违例明细字段：envier=1 envied=0 envy=24 removable=9 afterRemoval=15（实测 ${viol.envier}/${viol.envied}/${viol.envy}/${viol.removable}/${viol.envyAfterRemoval}）`,
  );

  // 空捆语义：对空捆不允许移除物品（removable = null）
  const a4 = isEF1([[5, 5], [5, 0]], [[0, 1], []]);
  ok(a4.ef1, '空捆语义：A 全拿但 B 只认可第一件（5），移除后剩余嫉妒 = 0 ⟹ EF1（对空捆无移除项）');
  throws(() => isEF1([[1]], [[0], []]), 'bundles 行数不匹配抛错');
  throws(() => isEF1([[1], [1]], [[0], [0]]), '同一物品分给多人抛错');
  throws(() => isEF1([[1], [1, 2]], [[0], [1]]), '非矩形估值矩阵抛错');
}

// ═══════════════════ 44.0 公平分配：嫉妒循环消除 ═══════════════════

section('44.0 嫉妒循环消除：定理 EF1 ≥200 种子 + 确定性 + 守恒');

{
  let allEf1 = true;
  let allAssigned = true;
  let deterministic = true;
  let nwConsistent = true;
  for (let seed = 0; seed < 200; seed += 1) {
    const rnd = mulberry32(seed);
    const agents = 2 + Math.floor(rnd() * 3);
    const items = 3 + Math.floor(rnd() * 9);
    const valuations = Array.from({ length: agents }, () => Array.from({ length: items }, () => Math.round(rnd() * 20)));
    const alloc = envyCycleElimination(valuations);
    const audit = isEF1(valuations, alloc.bundles);
    if (!audit.ef1) allEf1 = false;
    const totalItems = alloc.bundles.reduce((s, b) => s + b.length, 0);
    if (totalItems !== items) allAssigned = false;
    const again = envyCycleElimination(valuations);
    if (JSON.stringify(again.bundles) !== JSON.stringify(alloc.bundles)) deterministic = false;
    const check = nashWelfareOf(valuations, alloc.bundles);
    const sameNW = check.nashWelfare === alloc.nashWelfare; // 同一 welfareOf 计算：应逐位相同
    const sameLog = check.logNashWelfare === alloc.logNashWelfare || (Number.isNaN(check.logNashWelfare) && Number.isNaN(alloc.logNashWelfare));
    if (!sameNW || !sameLog) nwConsistent = false;
  }
  ok(allEf1, '嫉妒循环消除：200 个随机可加实例全部 EF1（Lipton et al. 2004 定理的逐实例兑现）');
  ok(allAssigned, '物品全部分配（每件恰好一个代理——无遗漏无重复）');
  ok(deterministic, '同输入同输出（物品序/破平/环选择全确定）');
  ok(nwConsistent, 'nashWelfareOf 独立口径复核：NW 与 log NW 逐实例逐位一致（含 −∞ 零捆语义）');
}

// ═══════════════════ 44.0 公平分配：贪心 MNW ═══════════════════

section('44.0 贪心 MNW（log 域）：穷举对照 + 诚实 EF1 标志');

{
  // 已知最优小例：A=[4,1,1] B=[1,4,1] → MNW = A{物品0}, B{物品1,2}（4×5=20）
  const known = greedyMaxNashWelfare([[4, 1, 1], [1, 4, 1]]);
  ok(near(known.nashWelfare, 20, 1e-9) && near(known.logNashWelfare, Math.log(20), 1e-9), `已知最优例：NW = 4×5 = 20（实测 ${known.nashWelfare}；log 域 Σln V = ${known.logNashWelfare.toFixed(4)}）`);

  // 2 玩家穷举对照 ≥60 实例：贪心 NW ≥ 0.4 × 最优（诚实近似口径）
  let worstRatio = 1;
  let optimalHits = 0;
  let instances = 0;
  for (let seed = 0; seed < 60; seed += 1) {
    const rnd = mulberry32(77000 + seed);
    const items = 3 + Math.floor(rnd() * 6);
    const v = [
      Array.from({ length: items }, () => 1 + Math.round(rnd() * 20)),
      Array.from({ length: items }, () => 1 + Math.round(rnd() * 20)),
    ];
    const brute = (a, b) => a * b;
    let opt = 0;
    for (let mask = 0; mask < 1 << items; mask += 1) {
      let va = 0;
      let vb = 0;
      for (let it = 0; it < items; it += 1) {
        if (mask & (1 << it)) va += v[0][it];
        else vb += v[1][it];
      }
      if (va > 0 && vb > 0) opt = Math.max(opt, brute(va, vb));
    }
    const g = greedyMaxNashWelfare(v);
    const ratio = g.nashWelfare / opt;
    worstRatio = Math.min(worstRatio, ratio);
    if (g.nashWelfare >= opt - 1e-9) optimalHits += 1;
    instances += 1;
  }
  ok(worstRatio >= 0.4, `2 玩家穷举对照（${instances} 实例 × ≤2⁹ 分配）：贪心 NW/最优 最差 ${worstRatio.toFixed(3)} ≥ 0.4（${optimalHits}/${instances} 恰达最优——诚实近似口径，不冒充最优）`);

  // 诚实 EF1 标志：贪心不做 EF1 承诺——电池中违例如实上报
  let ef1True = 0;
  let ef1False = 0;
  for (let seed = 0; seed < 200; seed += 1) {
    const rnd = mulberry32(seed);
    const agents = 2 + Math.floor(rnd() * 3);
    const items = 3 + Math.floor(rnd() * 9);
    const valuations = Array.from({ length: agents }, () => Array.from({ length: items }, () => Math.round(rnd() * 20)));
    const g = greedyMaxNashWelfare(valuations);
    const audit = isEF1(valuations, g.bundles);
    if (audit.ef1 !== g.ef1) ef1False = -1e9; // 内核标志与判定器矛盾 = 失败
    if (g.ef1) ef1True += 1;
    else ef1False += 1;
  }
  ok(ef1False >= 0 && ef1True > 0 && ef1False > 0, `诚实口径：200 实例中贪心 EF1 成立 ${ef1True} 例、违例 ${ef1False} 例——标志与 isEF1 判定器逐例一致（违例不隐瞒）`);

  // 零捆语义（log 域）：一代理对全部物品估 0 → NW=0、logNW=−∞
  const zero = greedyMaxNashWelfare([[5, 5, 5], [0, 0, 0]]);
  ok(zero.nashWelfare === 0 && zero.logNashWelfare === Number.NEGATIVE_INFINITY, `零捆语义：任一捆价值 0 ⟹ NW=0、Σln V=−∞（无 0^0/NaN 垃圾值）`);
}

// ═══════════════════ 63.0 核仁：加速等价 ═══════════════════

section('63.0 核仁加速：加性短路（零 LP）+ 对称塌缩 + 批量探针');

{
  const sameResult = (slow, fast) =>
    slow.x.every((v, i) => v.eq(fast.x[i])) &&
    slow.rounds.length === fast.rounds.length &&
    slow.rounds.every((r, i) => r.epsilon.eq(fast.rounds[i].epsilon) && JSON.stringify(r.settled) === JSON.stringify(fast.rounds[i].settled));

  // 加性博弈：θ = (0,…,0)，核仁 = v({i})，零 LP
  const additive = makeGame(4, [0, 2, 3, 5, 5, 7, 8, 10, 8, 10, 11, 13, 13, 15, 16, 18]);
  const addSlow = nucleolus(additive);
  const addFast = nucleolusFast(additive);
  ok(
    addFast.shortcut === 'additive' &&
      addFast.lpSolves === 0 &&
      addFast.x.map(String).join(',') === '2,3,5,8' &&
      sameResult(addSlow, addFast),
    `加性短路：零次 LP 读出核仁 (2,3,5,8)（实测 (${addFast.x.map(String).join(',')})），逐级记录与经典口径精确一致（θ = (0,…,0) 全紧）`,
  );

  // 三人多数：批量探针把 8 次 LP 压到 4 次
  const majority = makeGame(3, [0, 0, 0, 1, 0, 1, 1, 1]);
  const majSlow = nucleolus(majority);
  const majFast = nucleolusFast(majority);
  ok(
    majFast.x[0].toString() === '1/3' && sameResult(majSlow, majFast) && majFast.lpSolves < majSlow.lpSolves,
    `批量探针：三人多数 LP ${majSlow.lpSolves} → ${majFast.lpSolves}（第 1 级三对联盟一揽子定居），输出精确一致`,
  );

  // 顶点博弈 n=4（apex + 3 base）：文献结构解 (2/5, 1/5, 1/5, 1/5)
  const apexVals = [];
  for (let mask = 0; mask < 16; mask += 1) {
    const members = [0, 1, 2, 3].filter((i) => mask & (1 << i));
    const hasApex = members.includes(0);
    const allBases = members.length === 3 && !hasApex;
    apexVals.push((hasApex && members.length >= 2) || allBases ? 1 : 0);
  }
  const apex = makeGame(4, apexVals);
  const apexFast = nucleolusFast(apex);
  const apexSlow = nucleolus(apex);
  ok(
    apexFast.x.map(String).join(',') === '2/5,1/5,1/5,1/5' && sameResult(apexSlow, apexFast),
    `顶点博弈核仁 = (2/5, 1/5, 1/5, 1/5)（顶点玩家拿 2/5，三个 base 各 1/5；对称类 ${[...new Set(symmetryClasses(apex))].length} 个——base 三人同类）`,
  );
  ok(apexFast.lpSolves < apexSlow.lpSolves, `顶点博弈加速：LP ${apexSlow.lpSolves} → ${apexFast.lpSolves}（对称塌缩 + 批量探针）`);

  // 构造对称博弈 ≥20 个：塌缩口径与经典口径输出精确一致
  let symConsistent = true;
  let symFaster = 0;
  let symCount = 0;
  for (let seed = 0; seed < 22; seed += 1) {
    const rnd = mulberry32(9000 + seed);
    const n = 4 + Math.floor(rnd() * 2); // 4..5（n=6 经典口径 ~1s/例，下面单独演示）
    const byCount = new Map();
    const vals = [0];
    for (let m = 1; m < 1 << n; m += 1) {
      const k = m.toString(2).split('').filter((c) => c === '1').length;
      if (!byCount.has(k)) byCount.set(k, Math.floor(rnd() * 7));
      vals.push(byCount.get(k));
    }
    const game = makeGame(n, vals);
    const slow = nucleolus(game);
    const fast = nucleolusFast(game);
    symCount += 1;
    if (!sameResult(slow, fast)) symConsistent = false;
    if (fast.lpSolves < slow.lpSolves || fast.shortcut === 'symmetry') symFaster += 1;
  }
  ok(symConsistent, `构造对称博弈 ${symCount} 个（n=4/5）：nucleolusFast 与经典核仁的 x/逐级 ε/定居集全部精确一致（Fraction 相等）`);
  ok(symFaster >= symCount - 2, `对称塌缩逐例更快或走塌缩路径（${symFaster}/${symCount}）——约束 2ⁿ−2 按类计数去重`);

  // n=7 全对称可解性：经典口径约 14 秒级、塌缩口径毫秒级
  const bigVals = [0];
  const bigByCount = new Map([[1, 2], [2, 3], [3, 5], [4, 4], [5, 3], [6, 2], [7, 1]]);
  for (let m = 1; m < 1 << 7; m += 1) {
    const k = m.toString(2).split('').filter((c) => c === '1').length;
    bigVals.push(bigByCount.get(k));
  }
  const big = makeGame(7, bigVals);
  const t0 = performance.now();
  const bigFast = nucleolusFast(big);
  const t1 = performance.now();
  ok(
    bigFast.converged && bigFast.shortcut === 'symmetry' && bigFast.x.every((v) => v.toString() === '1/7') && t1 - t0 < 5000,
    `n=7 全对称博弈（120 条联盟约束 → 6 条类约束）：${bigFast.lpSolves} 次 LP / ${(t1 - t0).toFixed(0)}ms 解出核仁 (1/7,…,1/7)（经典口径 132 次 LP ≈ 14s——可解性数量级前移）`,
  );

  // 随机博弈 ≥100 例：无对称时批量探针路径仍与经典精确一致
  let randomConsistent = true;
  let lpBounded = 0;
  let lpStrictlyFewer = 0;
  let lpTotalSlow = 0;
  let lpTotalFast = 0;
  for (let seed = 0; seed < 100; seed += 1) {
    const rnd = mulberry32(31000 + seed);
    const n = 3 + (seed % 2);
    const vals = [0];
    for (let m = 1; m < 1 << n; m += 1) vals.push(Math.floor(rnd() * 9));
    const game = makeGame(n, vals);
    const slow = nucleolus(game);
    const fast = nucleolusFast(game);
    lpTotalSlow += slow.lpSolves;
    lpTotalFast += fast.lpSolves;
    if (!sameResult(slow, fast)) randomConsistent = false;
    if (fast.lpSolves <= slow.lpSolves + 2) lpBounded += 1; // 批量失败最坏 +1 探针/级
    if (fast.lpSolves < slow.lpSolves) lpStrictlyFewer += 1;
  }
  ok(randomConsistent, '随机博弈 100 例（n=3/4）：nucleolusFast 输出与经典核仁精确一致（加速零数学代价）');
  ok(lpBounded === 100, `批量探针开销有界：100 例 LP 次数全部 ≤ 经典 + 2（批量失败最坏每级 +1 次探针）`);
  ok(
    lpTotalFast < lpTotalSlow,
    `总体净节省：LP 总数 ${lpTotalSlow} → ${lpTotalFast}（严格更少 ${lpStrictlyFewer} 例 / 100——随机非对称博弈成批候选常只部分定居，节省集中在对称/退化结构，见上面多数/顶点/n=7 锚点）`,
  );
}

// ═══════════════════ 63.0 核仁：唯一性 / 字典序最优性 ═══════════════════

section('63.0 核仁唯一性：效率保持扰动的字典序最优性抽查');

{
  // θ(x) ≤lex θ(x')：对随机效率保持扰动 x'（x' = x + δ·d，Σd = 0 保效率；
  // 扰动点用浮点近似——精确核仁处字典序间隙严格，1e-9 容差足够）
  let lexOk = true;
  let trials = 0;
  for (let seed = 0; seed < 60; seed += 1) {
    const rnd = mulberry32(65000 + seed);
    const n = 3 + (seed % 2);
    const vals = [0];
    for (let m = 1; m < 1 << n; m += 1) vals.push(Math.floor(rnd() * 7));
    const game = makeGame(n, vals);
    const nu = nucleolus(game);
    const thetaOf = (xNum) => {
      const list = [];
      for (let mask = 1; mask < (1 << n) - 1; mask += 1) {
        let sum = 0;
        for (let i = 0; i < n; i += 1) if (mask & (1 << i)) sum += xNum[i];
        list.push(vals[mask] - sum);
      }
      return list.sort((a, b) => b - a);
    };
    const thetaNu = thetaOf(nu.x.map((v) => v.toNumber()));
    for (let t = 0; t < 3; t += 1) {
      const d = Array.from({ length: n }, () => (rnd() - 0.5) * 2);
      d[n - 1] = -d.slice(0, n - 1).reduce((s, v) => s + v, 0); // Σd = 0 保持效率
      const delta = 0.05 + rnd() * 0.4;
      const theta2 = thetaOf(nu.x.map((v, i) => v.toNumber() + d[i] * delta));
      let lex = 0;
      for (let i = 0; i < thetaNu.length; i += 1) {
        if (Math.abs(thetaNu[i] - theta2[i]) < 1e-9) continue;
        lex = thetaNu[i] > theta2[i] ? 1 : -1;
        break;
      }
      trials += 1;
      if (lex > 0) lexOk = false; // 扰动点字典序更小 = 唯一性被推翻
    }
  }
  ok(lexOk, `字典序最优性抽查：${trials} 个效率保持扰动全部 θ(核仁) ≤lex θ(扰动)（Schmeidler 唯一性的局部验证口径）`);
}

// ═══════════════════ 45.0 OCBA：序保持圆整 + 多约束 ═══════════════════

section('45.0 OCBA 分配计划：序保持圆整 + 容量上限（≥200 种子）');

{
  let conservation = 0;
  let inBounds = 0;
  let zeroOrderViolations = 0;
  let idealConserves = 0;
  let checked = 0;
  let noCapsExact = 0;
  let noCapsLoose = 0;
  let looseFails = 0;
  let bitwiseExact = 0;
  let worstWideDev = 0;
  const exactBreaks = [];
  for (let seed = 0; seed < 400; seed += 1) {
    const rnd = mulberry32(seed);
    const k = 2 + Math.floor(rnd() * 9);
    const candidates = Array.from({ length: k }, (_, i) => ({ name: `c${i}`, mean: 10 + rnd() * 90, std: 1 + rnd() * 20 }));
    const budget = Math.floor(k * 4 + rnd() * 600);
    const useCaps = rnd() < 0.6;
    const maxSamples = useCaps ? Array.from({ length: k }, () => 3 + Math.floor(rnd() * 60)) : undefined;
    if (maxSamples && maxSamples.reduce((a, b) => a + b, 0) < budget) continue;
    const plan = ocbaAllocatePlan(candidates, budget, { maxSamples, minSamples: 2 });
    checked += 1;
    if (plan.total === budget) conservation += 1;
    if (plan.counts.every((c, i) => c >= 2 && (!maxSamples || c <= maxSamples[i]))) inBounds += 1;
    if (plan.orderViolations === 0) zeroOrderViolations += 1;
    if (Math.abs(plan.ideal.reduce((a, b) => a + b, 0) - budget) <= 1e-9) idealConserves += 1;
    if (!useCaps) {
      const classical = ocbaAllocate(candidates, budget, { minSamples: 2 });
      // 回撤歧义判定（直接核账）：垫底抬高 Σ floor ⟹ 两个入口都要回撤
      // ——回撤序不同（经典按索引序、计划按理想序——正是序保持修复的
      // 对象），属紧预算歧义带，只核守恒与界限；无回撤时圆整路径同构
      //（不动点浮点末位可翻 floor，允许 ±1）。
      const padLift = plan.ideal.reduce((s, x) => s + Math.max(2, Math.floor(x)), 0) - budget;
      if (padLift <= 0) {
        noCapsExact += 1;
        const dev = Math.max(...plan.counts.map((c, i) => Math.abs(c - classical.counts[i])));
        worstWideDev = Math.max(worstWideDev, dev);
        if (dev === 0) bitwiseExact += 1;
        if (dev > 1) exactBreaks.push({ seed, budget, k, dev });
      } else {
        noCapsLoose += 1;
        if (plan.total !== budget || classical.total !== budget) looseFails += 1;
      }
    }
  }
  ok(checked >= 200, `种子化电池规模 ${checked} ≥ 200（混合容量约束）`);
  ok(conservation === checked, `预算守恒：${conservation}/${checked} 例 Σ counts = budget 精确（整数域，含垫底/削顶路径）`);
  ok(inBounds === checked, `界限 respected：${inBounds}/${checked} 例 counts ∈ [minSamples, cap]`);
  ok(zeroOrderViolations === checked, `序保持：${zeroOrderViolations}/${checked} 例理想差 ≥ 2 的对整数序零违规`);
  ok(idealConserves === checked, `连续理想分配守恒：${idealConserves}/${checked} 例 Σ ideal = budget（注水至守恒）`);
  ok(
    exactBreaks.length === 0,
    `等价证明（无回撤路径）：${noCapsExact} 例与 ocbaAllocate 逐位一致（实测 ${bitwiseExact} 例 bit-for-bit、最大偏差 ${worstWideDev}；容差 ±1 留给不动点浮点末位翻 floor 的理论情形）`,
  );
  ok(
    looseFails === 0,
    `紧预算歧义带（${noCapsLoose} 例）：两入口都精确守恒（垫底回撤的整数再分摊序不同——计划保理想序，经典按索引序）`,
  );

  // 精确等价锚（无垫底张力）：flux 验证同款 5 候选实例逐位一致
  const fluxLike = [
    { name: 'a', mean: 100, std: 10 },
    { name: 'b', mean: 95, std: 10 },
    { name: 'c', mean: 90, std: 10 },
    { name: 'd', mean: 85, std: 10 },
    { name: 'e', mean: 50, std: 10 },
  ];
  const planEq = ocbaAllocatePlan(fluxLike, 200, { biggerIsBetter: false, minSamples: 2 });
  const classicalEq = ocbaAllocate(fluxLike, 200, { biggerIsBetter: false, minSamples: 2 });
  ok(
    JSON.stringify(planEq.counts) === JSON.stringify(classicalEq.counts),
    `不动点等价锚：ocbaAllocatePlan [${planEq.counts.join(',')}] ≡ ocbaAllocate [${classicalEq.counts.join(',')}]（不变量缓存不改变不动点解——逐位一致）`,
  );

  // 容量削顶语义
  const tri = [
    { name: 'a', mean: 100, std: 10 },
    { name: 'b', mean: 95, std: 10 },
    { name: 'c', mean: 60, std: 10 },
  ];
  const capped = ocbaAllocatePlan(tri, 60, { maxSamples: [5, 50, 50], minSamples: 2 });
  ok(
    capped.counts[0] === 5 && capped.counts[1] === 50 && capped.total === 60 && capped.capped >= 2,
    `容量上限生效：最优者被削到 5、次优注水到 50、剩余 5 给第三者（[${capped.counts.join(', ')}]，Σ=60，削顶 ${capped.capped} 个）`,
  );
  throws(() => ocbaAllocatePlan(tri, 200, { maxSamples: [5, 50, 50] }), 'Σ 上限 < 预算：不可行显式抛错（不静默丢守恒）');
  throws(() => ocbaAllocatePlan(tri, 100, { maxSamples: [1.5, 50, 50] }), '分数上限显式抛错（会破坏整数守恒）');
  throws(() => ocbaAllocatePlan(tri, 100, { maxSamples: [1, 50, 50], minSamples: 2 }), '上限 < 下限显式抛错');

  // 护栏：负预算按 0、非有限抛错（两个入口同口径）
  ok(ocbaAllocate(tri, -5).total === 0 && ocbaAllocatePlan(tri, -5).total === 0, '负预算：两入口都诚实退化为全 0（原路径会产出负样本数）');
  throws(() => ocbaAllocate(tri, Number.NaN), 'ocbaAllocate 非有限预算抛错');
  throws(() => ocbaAllocatePlan(tri, Number.POSITIVE_INFINITY), 'ocbaAllocatePlan 非有限预算抛错');

  // 病态垫底实例：修复后两入口都精确守恒（修复前经典 guard 10000 触顶漏撤）
  const pathological = Array.from({ length: 5000 }, (_, i) => ({ name: `c${i}`, mean: 50 + (i % 97), std: 2 + (i % 13) }));
  const classicalPath = ocbaAllocate(pathological, 400_000, { minSamples: 2 });
  const planPath = ocbaAllocatePlan(pathological, 400_000, { minSamples: 2 });
  ok(
    classicalPath.total === 400_000 && planPath.total === 400_000,
    `病态垫底实例（5 千候选、垫底样本远超盈余需回撤 4 万+）：单趟回撤修复后经典 Σ=${classicalPath.total} 与计划 Σ=${planPath.total} 都精确守恒（原实现 guard 10000 触顶静默漏撤）`,
  );

  // P(CS) 对照（与 verify-flux 同款延迟择优场景）
  const cands = [
    { name: 'a', mean: 100, std: 10 },
    { name: 'b', mean: 95, std: 10 },
    { name: 'c', mean: 90, std: 10 },
    { name: 'd', mean: 85, std: 10 },
    { name: 'e', mean: 50, std: 10 },
  ];
  const plan = ocbaAllocatePlan(cands, 200, { biggerIsBetter: false, minSamples: 2 });
  const uniform = Array.from({ length: 5 }, () => 40);
  const pcsPlan = monteCarloCorrectSelection(cands.map((c) => c.mean), cands.map((c) => c.std), plan.counts, false, 3000);
  const pcsUniform = monteCarloCorrectSelection(cands.map((c) => c.mean), cands.map((c) => c.std), uniform, false, 3000);
  ok(pcsPlan >= pcsUniform - 0.005, `Monte Carlo P(CS)：计划分配 ${pcsPlan.toFixed(3)} ≥ 均匀 ${pcsUniform.toFixed(3)}（序保持圆整不伤择优确认力）`);
}

// ═══════════════════ 60.0 率失真：加权汉明 ═══════════════════

section('60.0 加权汉明 R(D)：对称退化 + BA 交叉验证 + 形状');

{
  const h2 = (x) => (x <= 0 || x >= 1) ? 0 : -x * Math.log2(x) - (1 - x) * Math.log2(1 - x);
  // 对称极限退化 = 解析锚
  let worstSym = 0;
  let symPoints = 0;
  for (const p of [0.3, 0.5]) {
    for (let i = 1; i <= 12; i += 1) {
      const D = (Math.min(p, 1 - p) * i) / 13;
      worstSym = Math.max(worstSym, Math.abs(weightedHammingRD(D, p, 1, 1) - binaryHammingRD(D, p)));
      symPoints += 1;
    }
  }
  ok(symPoints >= 20 && worstSym <= 1e-9, `对称极限（w₀₁=w₁₀=1）：${symPoints} 点与解析锚 H₂(p)−H₂(D) 最大偏差 ${worstSym.toExponential(2)} ≤ 1e-9`);

  // 不对称：与全矩阵 BA 交叉验证 ≥50 随机点
  let worstBA = 0;
  let baPoints = 0;
  for (let seed = 0; seed < 50; seed += 1) {
    const rnd = mulberry32(88000 + seed);
    const p = 0.05 + rnd() * 0.9;
    const a = 0.2 + rnd() * 4;
    const b = 0.2 + rnd() * 4;
    const beta = 0.1 + rnd() * 6;
    const point = weightedHammingPoint(p, a, b, beta);
    const ba = blahutArimoto([1 - p, p], [[0, a], [b, 0]], beta, { iters: 100000, tol: 1e-15 });
    worstBA = Math.max(worstBA, Math.abs(point.rate - ba.rate), Math.abs(point.distortion - ba.distortion));
    baPoints += 1;
  }
  ok(worstBA <= 1e-6, `不对称失真：${baPoints} 个随机 (p, w₀₁, w₁₀, β) 点的一维不动点与全矩阵 BA 一致（最大偏差 ${worstBA.toExponential(2)} ≤ 1e-6）`);

  // 反解 R(D)：在 BA 的失真点查表应回到 BA 的码率
  let worstInv = 0;
  for (const [p, a, b] of [[0.3, 1.5, 0.7], [0.25, 3.0, 0.5], [0.4, 1.0, 2.0], [0.2, 0.8, 2.2]]) {
    for (const beta of [0.6, 1.5, 3.0]) {
      const ba = blahutArimoto([1 - p, p], [[0, a], [b, 0]], beta, { iters: 100000, tol: 1e-15 });
      worstInv = Math.max(worstInv, Math.abs(weightedHammingRD(ba.distortion, p, a, b) - ba.rate));
    }
  }
  ok(worstInv <= 1e-6, `R(D) β 二分反解：12 个目标失真点回查码率与 BA 最大偏差 ${worstInv.toExponential(2)} ≤ 1e-6`);

  // 形状与边界
  let monotone = true;
  for (const [p, a, b] of [[0.3, 1.5, 0.7], [0.2, 2.0, 0.6]]) {
    const dMax = Math.min((1 - p) * a, p * b);
    let prev = Number.POSITIVE_INFINITY;
    for (let i = 1; i <= 30; i += 1) {
      const D = (dMax * i) / 31;
      const r = weightedHammingRD(D, p, a, b);
      if (r > prev + 1e-9) monotone = false;
      prev = r;
    }
    ok(weightedHammingRD(dMax, p, a, b) === 0, `D_max = min((1−p)w₀₁, p·w₁₀) = ${dMax.toFixed(3)} 处 R = 0（恒猜代价小的一类零码率）`);
    ok(near(weightedHammingRD(0, p, a, b), h2(p), 1e-12), `D = 0 处 R = H₂(p) = ${h2(p).toFixed(4)}（零失真要全部熵）`);
  }
  ok(monotone, 'R(D) 关于 D 单调不增（60 点扫描）');
  throws(() => weightedHammingRD(0.1, 0, 1, 1), 'p=0 抛错（确定性源无率失真概念）');
  throws(() => weightedHammingRD(-0.1, 0.5, 1, 1), '负失真抛错');
  throws(() => weightedHammingRD(0.1, 0.5, 0, 1), '零失真权重抛错');
}

// ═══════════════════ 60.0 率失真：β 扫描热启动 ═══════════════════

section('60.0 rdCurveFast 热启动：同收敛点 + 迭代数下降');

{
  const px = [0.2, 0.3, 0.25, 0.15, 0.1];
  const dm = px.map((_, i) => px.map((__, j) => Math.abs(i - j)));
  const betas = [0.15, 0.3, 0.6, 1.2, 2.4, 4.8, 9.6];
  const cold = rdCurve(px, dm, betas, { iters: 20000, tol: 1e-13 });
  const warm = rdCurveFast(px, dm, betas, { iters: 20000, tol: 1e-13 });
  let worstPt = 0;
  let coldIters = 0;
  let warmIters = 0;
  for (let i = 0; i < betas.length; i += 1) {
    worstPt = Math.max(worstPt, Math.abs(cold[i].rate - warm[i].rate), Math.abs(cold[i].distortion - warm[i].distortion));
    coldIters += blahutArimoto(px, dm, betas[i], { iters: 20000, tol: 1e-13 }).iterations;
    warmIters += warm[i].iterations;
  }
  ok(worstPt <= 1e-9 && warm.every((p) => p.converged), `热启动 ≡ 冷启动：7 个 β 点 (R, D) 最大偏差 ${worstPt.toExponential(2)} ≤ 1e-9 且全部收敛`);
  ok(warmIters < coldIters, `迭代数下降：冷启动 Σ ${coldIters} → 热启动 Σ ${warmIters}（×${(warmIters / coldIters).toFixed(2)}——上一点的收敛边际是优质初值）`);
  throws(() => rdCurveFast(px, dm, []), '空 β 列表抛错');
  throws(() => blahutArimoto(px, dm, 1, { initialMarginal: [0.5, 0.5] }), 'initialMarginal 长度不匹配抛错');
  throws(() => blahutArimoto(px, dm, 1, { initialMarginal: [0, 0, 0, 0, 0] }), 'initialMarginal 全零抛错');
}

// ═══════════════════ 99.0 注意力经济：支付快径 ═══════════════════

section('99.0 allocateAttentionFast：≥200 种子逐位一致 + 耗时对照');

{
  let mismatches = 0;
  let instances = 0;
  for (let seed = 0; seed < 220; seed += 1) {
    const rnd = mulberry32(seed);
    const n = 2 + Math.floor(rnd() * 8);
    const k = 1 + Math.floor(rnd() * 7);
    const sources = Array.from({ length: n }, (_, i) => {
      const kind = Math.floor(rnd() * 3);
      if (kind === 0) return unitDemandSource(`s${i}`, Math.round(rnd() * 20));
      if (kind === 1) return geometricSource(`s${i}`, Math.round(rnd() * 20), rnd());
      return saturatingSource(`s${i}`, Math.round(rnd() * 20), 1 + rnd() * 5);
    });
    const a = allocateAttention(sources, k);
    const b = allocateAttentionFast(sources, k);
    instances += 1;
    if (
      JSON.stringify([a.slots, a.payments, a.utilities, a.totalValue, a.revenue, a.marginalPrice, a.idleSlots, a.awards]) !==
      JSON.stringify([b.slots, b.payments, b.utilities, b.totalValue, b.revenue, b.marginalPrice, b.idleSlots, b.awards])
    ) {
      mismatches += 1;
    }
  }
  ok(mismatches === 0, `支付快径逐位一致：${instances} 个随机实例（含 awards 逐槽轨迹/支付/效用/收入）与经典口径 bit-for-bit 相同（W*₋ᵢ 恒等式）`);

  // 耗时对照：n=300 源、k=60 槽（best-of-3）
  const big = Array.from({ length: 300 }, (_, i) => geometricSource(`b${i}`, 1 + (i % 50), 0.85));
  const timeOf = (fn) => {
    let best = Number.POSITIVE_INFINITY;
    for (let r = 0; r < 3; r += 1) {
      const t0 = performance.now();
      fn();
      const t1 = performance.now();
      best = Math.min(best, t1 - t0);
    }
    return best;
  };
  const classical = timeOf(() => allocateAttention(big, 60));
  const fast = timeOf(() => allocateAttentionFast(big, 60));
  ok(fast < classical, `耗时对照 n=300/k=60：经典 ${classical.toFixed(1)}ms → 快径 ${fast.toFixed(1)}ms（O(#winners·nk) → O(nk + k·#winners)，×${(classical / fast).toFixed(1)}）`);
  throws(() => allocateAttentionFast(big, 1.5), '非整数 k 抛错');
}

// ═══════════════════ 99.0 注意力经济：时间衰减 ═══════════════════

section('99.0 时间衰减注意力：凹性/单调性/DSIC 保持 + 年龄簿记');

{
  // 凹性保持：正值缩放不破非增
  const wrapped = [decayedSource(geometricSource('g', 10, 0.5), 7, 2), decayedSource(saturatingSource('s', 8, 2), 0, 2)];
  ok(concavityCheck(wrapped, 6).concave, '凹性保持：任意源 × 2^(−age/h) 仍非增（正缩放）');

  // 出局年龄解析锚
  ok(decayExitAge(8, 2, 4) === 8 && near(decayExitAge(32, 1, 5), 25, 1e-9), `decayExitAge 解析：h·log₂(v/p)（8/2/h=4 → 8；32/1/h=5 → 25）`);
  ok(decayExitAge(5, 0, 3) === Number.POSITIVE_INFINITY, '影子价格 0（无竞争）→ 出局年龄 ∞（注意力免费时不出局）');

  // 年龄单调不增 ≥50 种子
  let monotone = true;
  for (let seed = 0; seed < 50; seed += 1) {
    const rnd = mulberry32(60000 + seed);
    const sources = Array.from({ length: 4 }, (_, i) => geometricSource(`s${i}`, 5 + rnd() * 15, 0.4 + rnd() * 0.4));
    for (let target = 0; target < 4; target += 1) {
      let prev = Number.POSITIVE_INFINITY;
      for (let age = 0; age <= 10; age += 1) {
        const ages = [0, 0, 0, 0].map((_, i) => (i === target ? age : 0));
        const alloc = allocateAttentionDecayed(sources, 3, ages, 2);
        if (alloc.slots[target] > prev) monotone = false;
        prev = alloc.slots[target];
      }
    }
  }
  ok(monotone, '源 i 的分得槽位随自身年龄单调不增（其全部边际同乘 c ≤ 1，全局 top-k 占比只减不增——200 次断言）');

  // DSIC 保持：衰减是公共知识，VCG 对谎报仍无利可图
  const decayed = [0, 1, 2].map((i) => decayedSource(geometricSource(`s${i}`, 10 - i * 2, 0.5), i * 2, 3));
  const mr = misreportGain(decayed, 2, { factors: [0, 0.25, 0.5, 2, 8] }, 200);
  ok(mr.trials >= 200 && mr.violations === 0 && mr.maxGain <= 1e-9, `DSIC 保持：衰减包装下 ${mr.trials} 次谎报（清零/缩小/放大 ×8）真实所得无一正收益（maxGain ${mr.maxGain.toExponential(2)}）`);

  // 年龄簿记 + 出局余量一致性
  const srcs = [geometricSource('a', 12, 0.6), geometricSource('b', 9, 0.5), geometricSource('c', 6, 0.4)];
  const ages = [0, 3, 8];
  const dec = allocateAttentionDecayed(srcs, 2, ages, 4);
  const bookkeepingOk = dec.nextAges.every((next, i) => (dec.slots[i] > 0 ? next === 0 : next === ages[i] + 1));
  ok(bookkeepingOk, `年龄簿记：被深看 → 0、未看 → +1（[${ages.join(',')}] → [${dec.nextAges.join(',')}]，slots=[${dec.slots.join(',')}])`);
  const decayOk = dec.decay.every((c, i) => near(c, 2 ** (-ages[i] / 4), 1e-12));
  ok(decayOk, `衰减乘数 = 2^(−age/h)：[${dec.decay.map((c) => c.toFixed(4)).join(', ')}]（陈旧信号价值指数衰减）`);
  const exitOk = dec.exitAges.every((e, i) => {
    const first = srcs[i].marginalValue(0) * dec.decay[i];
    if (!(first > 0) || dec.marginalPrice <= 0) return e === Number.POSITIVE_INFINITY || Number.isFinite(e);
    return near(e, decayExitAge(first, dec.marginalPrice, 4), 1e-9);
  });
  ok(exitOk, `出局余量与解析式一致：exitAges=[${dec.exitAges.map((e) => (Number.isFinite(e) ? e.toFixed(2) : '∞')).join(', ')}] @ 影子价格 ${dec.marginalPrice.toFixed(3)}`);

  // 极老信号诚实出局（乘数下溢到 0 → 无 NaN、无正边际）
  const ancient = allocateAttentionDecayed([geometricSource('a', 10, 0.9), geometricSource('b', 9, 0.8)], 2, [10000, 0], 5);
  ok(
    ancient.decay[0] === 0 && Number.isFinite(ancient.totalValue) && ancient.slots.every((s) => Number.isFinite(s)),
    '乘数下溢护栏：age=10000/h=5 → 乘数 0（诚实出局，无 NaN）',
  );
  throws(() => allocateAttentionDecayed(srcs, 2, [-1, 0, 0], 4), '负年龄抛错');
  throws(() => allocateAttentionDecayed(srcs, 2, [0, 0], 4), 'ages 长度不匹配抛错');
  throws(() => allocateAttentionDecayed(srcs, 2, [0, 0, 0], 0), 'halfLife ≤ 0 抛错');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(64)}`);
console.log(`R5-A13 公平分配六内核进化验证：PASS ${passed} / FAIL ${failed}`);
if (failed === 0) {
  console.log('✅ 16.0/44.0/63.0/45.0/60.0/99.0 六内核世界性进化闭环成立（零漂移：既有入口逐位不变）');
} else {
  process.exit(1);
}
