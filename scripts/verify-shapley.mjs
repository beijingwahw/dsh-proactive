/**
 * verify-shapley.mjs — 16.0「Shapley 公平归因」质变闭环离线验证
 *
 * 升级前后的分水岭：
 *   「谁创造了价值」全靠启发式——均分（大锅饭）、末次触达（抢功）、
 *   出现计数（可刷）——对同一份协作产出给出三种互相矛盾的分配，
 *   且全部可被策略性操纵（搭便车者与末位冲刺者拿走真实贡献者的
 *   报酬），点估计无不确定性。
 *   Shapley 值：同时满足效率/对称/虚拟/可加四条公平公理的唯一分配
 *   ——搭便车在数学上无利可图；排列采样的不确定性由 12.0 置信序列
 *   背书（任意时刻读区间均有效，偷看安全）；名次分离即停。
 *
 * 闭环断言：
 *   A 效率公理：Σφ = V(N)，份额全额分发（Σ share = 1）
 *   B 对称公理：可互换玩家分得相等
 *   C 虚拟公理：搭便车者恰得 0（抗操纵的数学骨架）
 *   D 可加公理：两博弈之和的 Shapley = Shapley 之和
 *   E 精确手算：多数博弈 φ = (1/6, 1/6, 2/3)，Banzhaf 关键性 (1/4, 1/4, 3/4)
 *   F 排列采样（分水岭）：无偏估计 + 任意时刻有效 CI 包含真值 + 名次正确
 *   G 提前停止：名次统计分离即停（远未耗尽预算）
 *   H 协同检测：1+1>2 的玩家对曝光为正协同；互相拆台曝光为负协同
 *   I 联盟缓存：2ⁿ 联盟各估值一次，重复归因零重算
 *
 * 运行：npm run build && node scripts/verify-shapley.mjs
 */

import { ShapleyAttributionEngine } from '../dist/index.mjs';

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

/** 确定性随机源（mulberry32） */
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

/** 多数博弈：{a,c} 或 {b,c} 或全体才能成事——c 是关键少数 */
function majorityGame(members) {
  const has = (p) => members.includes(p);
  if (has('a') && has('c')) return 1;
  if (has('b') && has('c')) return 1;
  return 0;
}

// ═══════════════════ A 效率公理 ═══════════════════

section('A 效率公理：价值全额分发，无遗漏无凭空');

{
  const report = new ShapleyAttributionEngine(majorityGame).attribute(['a', 'b', 'c']);
  const sum = report.attributions.reduce((s, x) => s + x.shapley, 0);
  ok(near(sum, 1, 1e-5) && near(report.totalValue, 1), `Σφ = V(N) = 1（实测 Σφ=${sum.toFixed(6)}，6 位小数舍入容差内）`);
  const shareSum = report.attributions.reduce((s, x) => s + x.share, 0);
  ok(near(shareSum, 1, 1e-4), `份额全额分发：Σ share = 1（实测 ${shareSum.toFixed(6)}）`);
  ok(near(report.efficiencyResidual, 0, 1e-6), `效率残差 Σφ − V(N) = 0（实测 ${report.efficiencyResidual}）`);
  ok(report.exact === true && report.stopReason === 'exact', '3 玩家走精确枚举路径');
}

// ═══════════════════ B 对称公理 ═══════════════════

section('B 对称公理：对所有联盟边际贡献相同者分得相等');

{
  // 搭档博弈：a、b 可互换（缺一不可），c 是局外人
  const v = (m) => (m.includes('a') && m.includes('b') ? 1 : 0);
  const report = new ShapleyAttributionEngine(v).attribute(['a', 'b', 'c']);
  const by = Object.fromEntries(report.attributions.map((x) => [x.playerId, x.shapley]));
  ok(near(by.a, 0.5) && near(by.b, 0.5), `可互换的 a、b 各得 0.5（实测 ${by.a} / ${by.b}）`);
  ok(near(by.c, 0, 1e-9), `局外人 c 得 0（实测 ${by.c}）`);
  ok(by.a === by.b, '对称玩家的分配严格相等（不是接近——是恒等）');
}

// ═══════════════════ C 虚拟公理 ═══════════════════

section('C 虚拟公理：搭便车者在数学上无利可图');

{
  // d 出现在大联盟里但从不改变任何联盟的价值——纯搭便车者
  const v = (m) => m.filter((p) => p !== 'd').length / 3;
  const report = new ShapleyAttributionEngine(v).attribute(['a', 'b', 'c', 'd']);
  const by = Object.fromEntries(report.attributions.map((x) => [x.playerId, x]));
  ok(near(by.d.shapley, 0, 1e-9) && by.d.share === 0, `搭便车者 d：φ = 0、份额 = 0（实测 φ=${by.d.shapley}）`);
  ok(by.d.isDummy === true, 'd 被标记为 dummy（所有边际 ≤ 容差）');
  ok(near(by.a.shapley, 1 / 3) && near(by.b.shapley, 1 / 3) && near(by.c.shapley, 1 / 3), '真实贡献者各得 1/3——出现计数会给 d 分 1/4，Shapley 不给一分');
}

// ═══════════════════ D 可加公理 ═══════════════════

section('D 可加公理：两博弈之和的分配 = 分配之和');

{
  const v1 = (m) => (m.includes('a') && m.includes('b') ? 1 : 0); // 搭档博弈
  const w = { a: 0.2, b: 0.3, c: 0.5 };
  const v2 = (m) => m.reduce((s, p) => s + w[p], 0); // 加性博弈
  const v12 = (m) => v1(m) + v2(m);
  const r1 = new ShapleyAttributionEngine(v1).attribute(['a', 'b', 'c']);
  const r2 = new ShapleyAttributionEngine(v2).attribute(['a', 'b', 'c']);
  const r12 = new ShapleyAttributionEngine(v12).attribute(['a', 'b', 'c']);
  const by = (r) => Object.fromEntries(r.attributions.map((x) => [x.playerId, x.shapley]));
  const [x1, x2, x12] = [by(r1), by(r2), by(r12)];
  ok(
    near(x12.a, x1.a + x2.a) && near(x12.b, x1.b + x2.b) && near(x12.c, x1.c + x2.c),
    `φ(a)=${x12.a} = ${x1.a}+${x2.a}，φ(b)=${x12.b}，φ(c)=${x12.c} —— 可加性逐玩家成立`,
  );
  ok(near(r12.totalValue, 2), '联合博弈 V(N) = 1 + 1 = 2');
}

// ═══════════════════ E 精确手算 ═══════════════════

section('E 精确手算：多数博弈的 Shapley 与 Banzhaf 关键性');

{
  const report = new ShapleyAttributionEngine(majorityGame).attribute(['a', 'b', 'c']);
  const by = Object.fromEntries(report.attributions.map((x) => [x.playerId, x]));
  // 手算（a 的边际）：S=∅:0，S={b}:v(ab)−v(b)=0，S={c}:v(ac)−v(c)=1，S={b,c}:v(abc)−v(bc)=0
  // → φ_a = (1/3)·0 + (1/6)·0 + (1/6)·1 + (1/3)·0 = 1/6（b 对称同值；c 是关键少数）
  ok(near(by.a.shapley, 1 / 6) && near(by.b.shapley, 1 / 6) && near(by.c.shapley, 2 / 3), `手算核对：φ = (1/6, 1/6, 2/3)（实测 (${by.a.shapley}, ${by.b.shapley}, ${by.c.shapley})）`);
  ok(by.c.rank === 1 && by.a.rank === 2, '名次：c 第 1（关键少数），a/b 并列其后');
  ok(near(by.a.criticality, 0.25) && near(by.b.criticality, 0.25) && near(by.c.criticality, 0.75), `Banzhaf 关键性 = (1/4, 1/4, 3/4)（实测 (${by.a.criticality}, ${by.b.criticality}, ${by.c.criticality})）——c 在 3/4 的联盟中是摇摆者`);
  ok(by.a.samples === 4, `每玩家覆盖 2^(n−1) = 4 个联盟（实测 ${by.a.samples}）`);
  const syn = report.synergies;
  ok(syn.length === 2 && syn.every((s) => s.kind === 'positive' && near(s.synergy, 1)), '协同对 (a,c)/(b,c) 各 +1（1+1>2 的组队增益曝光）');
}

// ═══════════════════ F 排列采样（分水岭） ═══════════════════

section('F 排列采样：10 玩家无偏估计 + 任意时刻有效 CI + 名次正确');

{
  // 加性底座 + 第 6 位成团奖金：真值 φ_i = (w_i + 0.03) / 3.05（解析可算）
  const players = Array.from({ length: 10 }, (_, i) => `p${i}`);
  const w = Object.fromEntries(players.map((p, i) => [p, (i + 1) / 20]));
  const TOTAL = 55 / 20 + 0.3; // 3.05
  const v = (m) => (m.reduce((s, p) => s + w[p], 0) + (m.length >= 6 ? 0.3 : 0)) / TOTAL;
  const engine = new ShapleyAttributionEngine(v, { rng: mulberry32(123), maxPermutations: 1500, minPermutations: 30 });
  const report = engine.attribute(players);

  ok(report.exact === false && report.permutations === 1500, `10 玩家 > exactThreshold 8 → 排列采样（${report.permutations} 次，预算耗尽诚实汇报）`);
  ok(report.stopReason === 'budget', '间隙过小未达名次分离 → stopReason = budget（区间仍任意时刻有效）');

  let maxErr = 0;
  let allCovered = true;
  for (const a of report.attributions) {
    const truth = (w[a.playerId] + 0.03) / TOTAL;
    maxErr = Math.max(maxErr, Math.abs(a.shapley - truth));
    if (!(a.lower - 1e-5 <= truth && truth <= a.upper + 1e-5)) allCovered = false;
  }
  ok(maxErr <= 0.02, `全部 10 玩家估计误差 ≤ 0.02（实测最大 ${maxErr.toFixed(4)}——排列边际是无偏估计）`);
  ok(allCovered, '全部真值落在任意时刻有效置信区间内（12.0 置信序列背书，偷看安全）');

  ok(
    report.attributions[0].playerId === 'p9' && report.attributions[9].playerId === 'p0' &&
      report.attributions.every((a, i) => a.rank === i + 1),
    '名次全对：p9 第 1 … p0 第 10（rank 连续无并列错位）',
  );
  ok(report.attributions.every((a) => !a.isDummy), '无 dummy 误判');
  ok(report.attributions[0].provablyPositive === true, '头部玩家统计确证正贡献（下界 > 0）');
  const shareSum = report.attributions.reduce((s, a) => s + a.share, 0);
  ok(near(shareSum, 1, 1e-4), `份额合计 = 1（实测 ${shareSum.toFixed(6)}）`);
  ok(
    near(report.efficiencyResidual, 0, 1e-3),
    `效率公理在采样模式仍成立：每次排列的边际 telescoping = V(N)−V(∅)（残差 ${report.efficiencyResidual}）`,
  );
}

// ═══════════════════ G 提前停止 ═══════════════════

section('G 提前停止：名次统计分离即停，不烧完预算');

{
  const V = { p0: 0.05, p1: 0.45, p2: 0.85 }; // 加性零方差、间隙 0.4
  const v = (m) => m.reduce((s, p) => s + V[p], 0);
  const engine = new ShapleyAttributionEngine(v, {
    exactThreshold: 2, // 3 > 2 → 强制采样路径
    maxPermutations: 2000,
    minPermutations: 30,
    alpha: 0.1,
    rng: mulberry32(2024),
  });
  const report = engine.attribute(['p0', 'p1', 'p2']);
  ok(report.stopReason === 'ranking-decided', `名次分离即停（stopReason = ranking-decided）`);
  ok(report.permutations >= 30 && report.permutations <= 300, `消耗 ${report.permutations} 次排列 << 预算 2000（区间分离的瞬间停表）`);
  const by = Object.fromEntries(report.attributions.map((a) => [a.playerId, a]));
  ok(near(by.p0.shapley, 0.05) && near(by.p1.shapley, 0.45) && near(by.p2.shapley, 0.85), '零方差博弈估计即真值（φ = 0.05/0.45/0.85）');
  ok(
    by.p0.lower <= 0.05 && by.p0.upper >= 0.05 && by.p2.lower <= 0.85 && by.p2.upper >= 0.85,
    '区间包含真值（提前停止的判定建立在任意时刻有效区间之上——停表本身偷看安全）',
  );
  ok(by.p2.rank === 1 && by.p1.rank === 2 && by.p0.rank === 3, '座次：p2 > p1 > p0');
}

// ═══════════════════ H 协同检测 ═══════════════════

section('H 协同检测：1+1>2 组队增益与互相拆台同时曝光');

{
  // 正协同：a+b 联手 0.8 > 0.3 + 0.2
  const pos = (m) =>
    0.3 * (m.includes('a') ? 1 : 0) + 0.2 * (m.includes('b') ? 1 : 0) + 0.1 * (m.includes('c') ? 1 : 0) +
    0.5 * (m.includes('a') && m.includes('b') ? 1 : 0);
  const synPos = new ShapleyAttributionEngine(pos).detectSynergies(['a', 'b', 'c']);
  ok(
    synPos.length === 1 && synPos[0].a === 'a' && synPos[0].b === 'b' && synPos[0].kind === 'positive' && near(synPos[0].synergy, 0.5),
    `正协同对 (a,b)：V(a∪b)=1.0 − 0.3 − 0.2 = +0.5（1+1>2，编排应亲和）`,
  );

  // 负协同：a+b 联手 0.5 < 0.4 + 0.4
  const neg = (m) => 0.4 * (m.includes('a') ? 1 : 0) + 0.4 * (m.includes('b') ? 1 : 0) - 0.3 * (m.includes('a') && m.includes('b') ? 1 : 0);
  const synNeg = new ShapleyAttributionEngine(neg).detectSynergies(['a', 'b']);
  ok(synNeg.length === 1 && synNeg[0].kind === 'negative' && near(synNeg[0].synergy, -0.3), '负协同对 (a,b)：0.5 − 0.8 = −0.3（互相拆台，编排应拆散）');
}

// ═══════════════════ I 联盟缓存 ═══════════════════

section('I 联盟缓存：昂贵价值函数的经济学');

{
  let calls = 0;
  const engine = new ShapleyAttributionEngine((m) => {
    calls += 1;
    return majorityGame(m);
  });
  engine.attribute(['a', 'b', 'c']);
  ok(calls === 8, `3 玩家 2³ = 8 个联盟各估值一次（实测 ${calls} 次调用——协同检测全部复用缓存）`);
  ok(engine.cacheHits === 8, `缓存登记 8 条联盟值（实测 ${engine.cacheHits}）`);
  const before = calls;
  engine.attribute(['a', 'b', 'c']);
  ok(calls === before, '重复归因零重算（跨调用缓存复用——价值函数可能是昂贵查询）');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✓ 全部 ${passed} 项断言通过 —— 16.0 Shapley 公平归因质变闭环成立`);
  process.exit(0);
} else {
  console.error(`✗ ${failed} 项失败（${passed} 项通过）`);
  process.exit(1);
}
