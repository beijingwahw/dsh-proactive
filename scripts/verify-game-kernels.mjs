/**
 * verify-game-kernels.mjs — 63.0→64.0「博弈论双件套」纯数学离线验证
 *
 * 每个锚点都有解析解或定理对照（不是「能跑」，是「算得对」）：
 *   63.0 核仁（Schmeidler）：精确有理数（Fraction，BigInt 分子分母）+
 *        手写两阶段精确单纯形 + 逐级 LP（Kopelowitz 程序，探针判定
 *        「在每个最优点上都紧」）——手套博弈 (0,0,1) 文献精确解、
 *        三人多数 (1/3,1/3,1/3) 对称解、逐级 ε₁/ε₂ 精确、效率精确、
 *        核非空⟹核仁∈核、核空诚实报告 ε₁=1/3>0、Shapley 对照双口径
 *   64.0 相关均衡（Aumann / Hart–Mas-Colell）：CE 不等式检查器对已知
 *        CE 通过、对构造破坏分布以解析值拒绝（PD 红绿灯=1.0、猜硬币
 *        δHH=2.0、交通灯均匀=2.25）；RM 学习：猜硬币收益→0、经验分布
 *        →均匀；交通灯 RM 收敛分布期望收益 ≫ 混合 Nash 2/13（信号灯
 *        协调收益）；外部后悔随 T 递减至 <0.01/轮；混合 Nash 支撑
 *        枚举对照（2/13 精确）
 *
 * 全部断言确定性（63.0 精确分数相等；64.0 的随机性全部来自内核自带
 * mulberry32(seed)，同种子同轨迹）。
 * 运行：node --experimental-strip-types scripts/verify-game-kernels.mjs
 */

import {
  Fraction,
  frac,
  solveLP,
  makeGame,
  nucleolus,
  leastCore,
  core,
  inCore,
  isImputation,
  shapleyExact,
  excess,
  excessVector,
  coalitionMask,
} from '../src/core/nucleolus.ts';
import {
  normalGame,
  learnCE,
  isCorrelatedEquilibrium,
  expectedPayoffsUnder,
  enumerateNash,
  positiveRegretDistribution,
  regretMatchingStep,
  jointIndexOf,
  profileOfJoint,
} from '../src/core/correlated-equilibrium.ts';

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
    failed += 1;
    console.error(`  ✗ ${label}（未抛错）`);
  } catch {
    passed += 1;
    console.log(`  ✓ ${label}`);
  }
}
const fs = (x) => x.toString(); // Fraction → 展示

// ═══════════════════ 63.0 Fraction 精确有理数 ═══════════════════

section('63.0 Fraction：BigInt 有理数的四则与规范化');

{
  const half = frac(3, 6);
  ok(half.num === 1n && half.den === 2n, `frac(3,6) gcd 约分 = ${fs(half)}（分子分母互素）`);
  const neg = frac(-2, 4);
  ok(neg.num === -1n && neg.den === 2n, `frac(-2,4) = ${fs(neg)}（负号归分子、分母恒正）`);
  ok(frac(1, 2).add(frac(1, 3)).eq(frac(5, 6)), `1/2 + 1/3 = ${fs(frac(1, 2).add(frac(1, 3)))} 精确`);
  ok(frac(1, 2).sub(frac(1, 3)).eq(frac(1, 6)), `1/2 − 1/3 = ${fs(frac(1, 2).sub(frac(1, 3)))} 精确`);
  ok(frac(2, 3).mul(frac(3, 2)).eq(Fraction.ONE), `2/3 × 3/2 = 1 精确（无浮点尘埃）`);
  ok(frac(1, 2).div(frac(3, 4)).eq(frac(2, 3)), `(1/2)/(3/4) = ${fs(frac(1, 2).div(frac(3, 4)))} 精确`);
  ok(frac(2, 3).cmp(frac(3, 5)) > 0, `cmp: 2/3 > 3/5（交叉相乘精确比较）`);
  ok(Fraction.of(0.5).eq(frac(1, 2)) && Fraction.of(-0.25).eq(frac(-1, 4)), `Fraction.of: 0.5→1/2、−0.25→−1/4（double 的二进制真值精确有理化）`);
  const dyadic = Fraction.of(0.1);
  ok(!dyadic.eq(frac(1, 10)) && dyadic.sub(frac(1, 10)).abs().toNumber() < 1e-15, `Fraction.of(0.1) ≠ 1/10（double 0.1 本就不是 1/10——诚实反映其二进制真值，差 < 1e-15）`);
  ok(Fraction.of(2n).eq(frac(2)), `Fraction.of(2n) = 2（BigInt 直取）`);
  throws(() => frac(1, 2).div(Fraction.ZERO), '除以零显式抛错（合同校验）');
  throws(() => frac(1, 0), 'frac(1,0) 零分母显式抛错');
}

// ═══════════════════ 63.0 精确单纯形 ═══════════════════

section('63.0 solveLP：精确两阶段单纯形（最优 / 不可行 / 无界三分）');

{
  // max x+y s.t. x+y ≤ 3, x ≤ 2（以 min −x−y 求解）——顶点 (2,1)，最优 −3
  const lp1 = solveLP({
    objective: [frac(-1), frac(-1)],
    matrix: [[frac(1), frac(1)], [frac(1), frac(0)]],
    rhs: [frac(3), frac(2)],
    senses: ['<=', '<='],
  });
  ok(
    lp1.status === 'optimal' && lp1.objective.eq(frac(-3)) && lp1.x[0].add(lp1.x[1]).eq(frac(3)),
    `max x+y = 3 精确（目标 ${fs(lp1.objective)}，x+y = ${fs(lp1.x[0].add(lp1.x[1]))}——顶点 (2,1) 有理数精确）`,
  );
  // 分数顶点：min x+y s.t. x ≥ 1/3, y ≥ 1/6, x+y ≤ 1/2 → 最优恰 1/2
  const lp2 = solveLP({
    objective: [frac(1), frac(1)],
    matrix: [[frac(1), frac(0)], [frac(0), frac(1)], [frac(1), frac(1)]],
    rhs: [frac(1, 3), frac(1, 6), frac(1, 2)],
    senses: ['>=', '>=', '<='],
  });
  ok(
    lp2.status === 'optimal' && lp2.objective.eq(frac(1, 2)),
    `分数约束 LP 最优 = ${fs(lp2.objective)}（1/3+1/6 紧到 1/2——浮点单纯形在此会出 0.4999999999）`,
  );
  const lp3 = solveLP({
    objective: [frac(1)],
    matrix: [[frac(1)], [frac(1)]],
    rhs: [frac(1), frac(2)],
    senses: ['<=', '>='],
  });
  ok(lp3.status === 'infeasible', `x ≤ 1 ∧ x ≥ 2 → ${lp3.status}（Phase-1 人工变量残留 1 > 0）`);
  const lp4 = solveLP({
    objective: [frac(1)],
    matrix: [[frac(1)]],
    rhs: [frac(1)],
    senses: ['<='],
  });
  ok(lp4.status === 'unbounded', `min x s.t. x ≤ 1（x 自由）→ ${lp4.status}（可向 −∞ 漂移）`);
  const lp5 = solveLP({
    objective: [frac(1), frac(0)],
    matrix: [[frac(1), frac(1)], [frac(1), frac(0)]],
    rhs: [frac(2), frac(1)],
    senses: ['=', '>='],
  });
  ok(
    lp5.status === 'optimal' && lp5.objective.eq(Fraction.ONE),
    `等式约束 x+y=2、x≥1：min x = ${fs(lp5.objective)} 精确（y 吸收剩余）`,
  );
  throws(
    () =>
      solveLP({
        objective: [frac(1)],
        matrix: [[frac(1), frac(1)]],
        rhs: [frac(1)],
        senses: ['<='],
      }),
    'solveLP 行系数长度 ≠ 变量数显式抛错（合同校验）',
  );
}

// ═══════════════════ 63.0 手套博弈 ═══════════════════

section('63.0 核仁·锚点①③④⑥：手套博弈（2 左 1 右）');

{
  // bit0=L1, bit1=L2（左手套）, bit2=R（右手套）：v(S) = min(左数, 右数)
  // 掩码值表: {L1R}=101₂=5 → 1, {L2R}=110₂=6 → 1, N=111₂=7 → 1，其余 0
  const glove = makeGame(3, [0, 0, 0, 0, 0, 1, 1, 1]);
  const nu = nucleolus(glove);
  ok(
    nu.x[0].eq(Fraction.ZERO) && nu.x[1].eq(Fraction.ZERO) && nu.x[2].eq(Fraction.ONE),
    `①核仁 = (${nu.x.map(fs).join(', ')})——与文献已知解精确一致（稀缺右手套持有者拿走全部剩余 1）`,
  );
  const sum = nu.x[0].add(nu.x[1]).add(nu.x[2]);
  ok(sum.eq(Fraction.ONE), `③大联盟效率 Σ Nu = ${fs(sum)} = v(N) = 1 精确（Fraction 相等，非容差）`);
  ok(nu.leastCoreEpsilon.eq(Fraction.ZERO), `最小核 ε₁ = ${fs(nu.leastCoreEpsilon)}（核非空——手套博弈核是单点 (0,0,1)）`);
  ok(core(glove).nonempty === true && core(glove).witness !== null, `core() 判非空并给出核内见证点`);
  ok(
    nu.inCore && nu.complaints.every((c) => !c.excess.isPositive()),
    `④核非空 ⟹ 核仁 ∈ 核：全部联盟过剩 ≤ 0（最大过剩 = ${fs(nu.complaints[0].excess)}——无任何活着的异议）`,
  );
  ok(
    nu.rounds.length === 2 &&
      nu.rounds[0].epsilon.eq(Fraction.ZERO) &&
      JSON.stringify(nu.rounds[0].settled) === '[1,2,3,5,6]' &&
      nu.rounds[1].epsilon.eq(frac(-1)) &&
      JSON.stringify(nu.rounds[1].settled) === '[4]',
    `逐级程序精确：ε₁=${fs(nu.rounds[0].epsilon)} 定居 {L1,L2,L1L2,L1R,L2R}，ε₂=${fs(nu.rounds[1].epsilon)} 定居 {R}（抱怨字典序逐轮安抚）`,
  );
  const sh = shapleyExact(glove);
  ok(
    sh[0].eq(frac(1, 6)) && sh[1].eq(frac(1, 6)) && sh[2].eq(frac(2, 3)),
    `⑥Shapley 对照 = (${sh.map(fs).join(', ')}) 精确（排列枚举分数版）`,
  );
  const shSum = sh[0].add(sh[1]).add(sh[2]);
  ok(
    shSum.eq(Fraction.ONE) && !sh[2].eq(nu.x[2]),
    `⑥双口径互补：核仁 R=1 ≠ Shapley R=2/3（分配不同），但两者都精确满足效率（Σφ = ${fs(shSum)} = 1）——Shapley 管平均公平，核仁管最坏联盟异议`,
  );
  ok(nu.isImputation && isImputation(glove, nu.x), `核仁是转归（效率 + 个体理性）`);
  ok(nu.converged && nu.coreNonempty, `逐级程序收敛完成（全部联盟安居）`);
  ok(
    excess(glove, coalitionMask([0, 2]), nu.x).eq(Fraction.ZERO),
    `过剩函数对照：e({L1,R}, x) = v−(x₁+x_R) = ${fs(excess(glove, coalitionMask([0, 2]), nu.x))}（核内紧约束）`,
  );
  throws(() => makeGame(3, [1, 0, 0, 0, 0, 1, 1, 1]), 'makeGame v(∅) ≠ 0 显式抛错（特征函数公理）');
  throws(() => makeGame(2, [0, 1]), 'makeGame 值表长度 ≠ 2ⁿ 显式抛错');
}

// ═══════════════════ 63.0 三人简单多数 ═══════════════════

section('63.0 核仁·锚点②③⑤：三人简单多数博弈（权重 51/50/50，配额 100）');

{
  // 加权多数博弈程序化生成：联盟权重和 ≥ 100（配额）即获胜 v=1
  const weights = [51, 50, 50];
  const quota = 100;
  const table = [];
  for (let mask = 0; mask < 8; mask += 1) {
    let w = 0;
    for (let i = 0; i < 3; i += 1) if (mask & (1 << i)) w += weights[i];
    table.push(w >= quota ? 1 : 0);
  }
  ok(
    JSON.stringify(table) === '[0,0,0,1,0,1,1,1]',
    `权重 51/50/50 × 配额 100 ⟹ 恰好每两人获胜、单人失利的对称多数博弈（值表 ${table.join('')}）`,
  );
  const maj = makeGame(3, table);
  const nu = nucleolus(maj);
  ok(
    nu.x[0].eq(frac(1, 3)) && nu.x[1].eq(frac(1, 3)) && nu.x[2].eq(frac(1, 3)),
    `②核仁 = (${nu.x.map(fs).join(', ')})——对称解精确（无否决者的多数博弈里字典序把抱怨摊平）`,
  );
  const sum = nu.x[0].add(nu.x[1]).add(nu.x[2]);
  ok(sum.eq(Fraction.ONE), `③效率 Σ Nu = ${fs(sum)} = v(N) = 1 精确`);
  ok(
    nu.leastCoreEpsilon.eq(frac(1, 3)) && nu.leastCoreEpsilon.isPositive(),
    `⑤最小核 ε₁ = ${fs(nu.leastCoreEpsilon)} > 0（三对联盟能各抱怨 1/3，核空被诚实报告——不假装稳定存在）`,
  );
  ok(
    core(maj).nonempty === false && core(maj).witness === null && nu.coreNonempty === false && !nu.inCore,
    `⑤core() = 空、无见证点、核仁 ∉ 核（最大过剩 ${fs(nu.complaints[0].excess)} = 1/3 > 0，{12}{13}{23} 是活着的异议联盟）`,
  );
  ok(
    nu.rounds.length === 2 &&
      nu.rounds[0].epsilon.eq(frac(1, 3)) &&
      JSON.stringify(nu.rounds[0].settled) === '[3,5,6]' &&
      nu.rounds[1].epsilon.eq(frac(-1, 3)) &&
      JSON.stringify(nu.rounds[1].settled) === '[1,2,4]',
    `逐级字典序精确：ε₁=1/3 定居三对联盟 {12,13,23}，ε₂=−1/3 定居三单例（先安抚最响的抱怨，再安抚次响的）`,
  );
  const sh = shapleyExact(maj);
  ok(
    sh[0].eq(frac(1, 3)) && sh[1].eq(frac(1, 3)) && sh[2].eq(frac(1, 3)) && sh.every((v, i) => v.eq(nu.x[i])),
    `⑥对称博弈双口径重合：Shapley = 核仁 = (1/3, 1/3, 1/3)（对照猜手套博弈的分裂——对称性把两个解概念焊在一起）`,
  );
  ok(nu.isImputation && nu.converged, `核仁仍是转归且逐级程序收敛（核空不影响核仁存在唯一）`);
  ok(
    leastCore(maj).epsilon.eq(frac(1, 3)),
    `leastCore 独立入口与 nucleolus 的 ε₁ 一致（1/3 精确）`,
  );
  const ev = excessVector(maj, nu.x);
  ok(ev.length === 6 && ev[0].excess.eq(frac(1, 3)) && ev[5].excess.eq(frac(-1, 3)), `过剩向量降序排列（抱怨榜头 = 1/3，末 = −1/3）`);
}

// ═══════════════════ 64.0 猜硬币 ═══════════════════

section('64.0 RM 学习·锚点①：猜硬币（零和）——收益趋博弈值 0、分布趋均匀');

{
  const pennies = normalGame([2, 2], [[1, -1, -1, 1], [-1, 1, 1, -1]]);
  ok(
    pennies.utilities[0].every((u, j) => u + pennies.utilities[1][j] === 0),
    '零和检验：u₁ = −u₂ 处处成立（博弈值 = 混合 Nash 值 = 0）',
  );
  const nash = enumerateNash(pennies);
  ok(
    nash.length === 1 &&
      !nash[0].pure &&
      nash[0].strategies.every((s) => near(s[0], 0.5, 1e-9) && near(s[1], 0.5, 1e-9)) &&
      nash[0].payoffs.every((v) => near(v, 0, 1e-9)),
    `唯一 Nash = 混合 (1/2, 1/2)×(1/2, 1/2)，支付 (0, 0)（支撑枚举精确解）`,
  );
  const rm = learnCE(pennies, 5000, 2026);
  ok(
    rm.avgPayoffs.every((v) => Math.abs(v) < 0.05),
    `RM 5000 步时间平均收益 = (${rm.avgPayoffs.map((v) => v.toFixed(4))}) → 0（±0.05 内，实测 |·| ≤ 0.006）`,
  );
  ok(
    near(rm.avgPayoffs[0], -rm.avgPayoffs[1], 1e-12),
    '零和守恒：两人平均收益严格互为相反数',
  );
  ok(
    rm.jointFreq.every((f) => Math.abs(f - 0.25) < 0.05),
    `经验联合分布 → 均匀（各格 ${rm.jointFreq.map((f) => f.toFixed(3))}，偏差 < 0.05，实测 ≤ 0.012）`,
  );
  ok(
    rm.empiricalCeViolation <= Math.max(...rm.externalRegret) + 1e-9,
    `经验分布的 CE 违反 (${rm.empiricalCeViolation.toFixed(5)}) ≤ 最大外部后悔 (${Math.max(...rm.externalRegret).toFixed(5)})——Hart–Mas-Colell 定理的定量面`,
  );
}

// ═══════════════════ 64.0 囚徒困境 ═══════════════════

section('64.0 CE 检查器·锚点②：囚徒困境——纯 Nash 是 CE、「红绿灯」被诚实拒绝');

{
  const pd = normalGame([2, 2], [[3, 0, 5, 1], [3, 5, 0, 1]]); // (C,C)(C,D)(D,C)(D,D)
  const nash = enumerateNash(pd);
  ok(
    nash.length === 1 && nash[0].pure && JSON.stringify(nash[0].strategies) === '[[0,1],[0,1]]' && nash[0].payoffs[0] === 1,
    `恰 1 个 Nash：纯 (D,D)，支付 (1,1)（严格劣势使全支撑混合无解——支撑枚举拒绝所有合作支撑）`,
  );
  const deltaDD = isCorrelatedEquilibrium([0, 0, 0, 1], pd);
  ok(deltaDD.isCE && deltaDD.worstViolation === 0, `纯 Nash 是 CE：δ_{(D,D)} 违反量 = 0（每个 Nash 均衡都是退化的相关均衡）`);
  const redlight = isCorrelatedEquilibrium([0.5, 0, 0, 0.5], pd);
  ok(
    !redlight.isCE && near(redlight.worstViolation, 1.0, 1e-12),
    `「红绿灯」分布 (C,C)/(D,D) 各半被正确拒绝：违反量 = ${redlight.worstViolation} 恰等于解析值 0.5×(5−3) = 1（被建议 C 时对方必 C，偏离 D 净赚 2×0.5）`,
  );
  ok(
    redlight.worst !== null && redlight.worst.player === 0 && redlight.worst.from === 0 && redlight.worst.to === 1,
    `最坏偏离定位：玩家 0 从建议 C(0) 偏离到 D(1)——审计报告直指谁在什么建议下想叛逃`,
  );
  // 数学诚实面：PD 的 CE 集只含 (D,D)——一次性囚徒困境里信号救不了合作
  const rm = learnCE(pd, 10000, 2026);
  ok(
    Math.abs(rm.avgPayoffs[0] - 1) < 0.01 && Math.abs(rm.avgPayoffs[1] - 1) < 0.01,
    `RM 在 PD 上收敛到 (D,D)：平均收益 (${rm.avgPayoffs.map((v) => v.toFixed(4))}) → 1（±0.01 内，实测 1.0002）`,
  );
}

// ═══════════════════ 64.0 交通灯协调博弈 ═══════════════════

section('64.0 信号灯协调·锚点③：交通灯博弈——相关装置 Pareto 优于混合 Nash');

{
  // (Go,Go) 撞车 −10/−10；(Go,Stop) 2/1；(Stop,Go) 1/2；(Stop,Stop) 0/0
  const traffic = normalGame([2, 2], [[-10, 2, 1, 0], [-10, 1, 2, 0]]);
  const nash = enumerateNash(traffic);
  const pureCount = nash.filter((e) => e.pure).length;
  const mixedEq = nash.find((e) => !e.pure);
  ok(
    nash.length === 3 && pureCount === 2,
    `Nash 全景：2 纯（(Go,Stop)→(2,1)、(Stop,Go)→(1,2)）+ 1 混合`,
  );
  ok(
    mixedEq !== undefined &&
      mixedEq.strategies.every((s) => near(s[0], 2 / 13, 1e-6) && near(s[1], 11 / 13, 1e-6)) &&
      mixedEq.payoffs.every((v) => near(v, 2 / 13, 1e-6)),
    `混合 Nash = (${mixedEq.strategies[0].map((v) => v.toFixed(6))}) 各持 Go 概率 2/13 = ${(2 / 13).toFixed(6)}，支付各 2/13 ≈ 0.1538（支撑枚举对照解析解）`,
  );
  const light = [0, 0.5, 0.5, 0];
  const check = isCorrelatedEquilibrium(light, traffic);
  ok(
    check.isCE && check.worstViolation <= 1e-9,
    `红绿灯相关分布 P(Go,Stop)=P(Stop,Go)=1/2 是 CE（违反量 0：被建议 Go 者抢行得 −10、被建议 Stop 者抢行得不偿失——服从即最优反应）`,
  );
  const lightPayoffs = expectedPayoffsUnder(light, traffic);
  ok(
    lightPayoffs.every((v) => near(v, 1.5, 1e-12)) && lightPayoffs.every((v) => v > 2 / 13),
    `红绿灯期望收益 (${lightPayoffs.map((v) => v.toFixed(3))}) vs 混合 Nash ${(2 / 13).toFixed(4)}——双方 Pareto 优（9.75 倍）：信号灯把「猜对方」变成「信灯」`,
  );
  const rm = learnCE(traffic, 10000, 2026);
  ok(
    rm.expectedPayoffs.every((v) => v > 0.5 && v > 2 / 13),
    `RM 10⁴ 步收敛分布期望收益 (${rm.expectedPayoffs.map((v) => v.toFixed(4))}) ≫ 混合 Nash 0.1538（RM 自发学会轮流协调，落在纯均衡附近）`,
  );
  ok(
    rm.empiricalCeViolation < 0.01,
    `RM 经验分布已是 0.01-CE（实测最大违反 ${rm.empiricalCeViolation.toFixed(5)} ≤ max regret/T）`,
  );
  const rm7 = learnCE(traffic, 10000, 7);
  ok(
    rm7.expectedPayoffs.every((v) => v > 0.5) &&
      Math.abs(rm7.expectedPayoffs[0] - rm.expectedPayoffs[0]) > 0.5,
    `种子决定对称破缺方向：seed=7 收敛到另一纯均衡（(${rm7.expectedPayoffs.map((v) => v.toFixed(3))}) vs seed=2026 的 (${rm.expectedPayoffs.map((v) => v.toFixed(3))})）——两条路都远超混合 Nash`,
  );
}

// ═══════════════════ 64.0 无悔性 ═══════════════════

section('64.0 无悔性·锚点④：外部后悔 ‖R‖/T 随 T 递减');

{
  const games = {
    囚徒困境: normalGame([2, 2], [[3, 0, 5, 1], [3, 5, 0, 1]]),
    交通灯: normalGame([2, 2], [[-10, 2, 1, 0], [-10, 1, 2, 0]]),
    猜硬币: normalGame([2, 2], [[1, -1, -1, 1], [-1, 1, 1, -1]]),
  };
  for (const [name, game] of Object.entries(games)) {
    const r100 = Math.max(...learnCE(game, 100, 2026).externalRegret);
    const r1000 = Math.max(...learnCE(game, 1000, 2026).externalRegret);
    const r10000 = Math.max(...learnCE(game, 10000, 2026).externalRegret);
    ok(
      r100 > r1000 && r1000 > r10000,
      `${name}：平均外部后悔 ${r100.toFixed(4)} → ${r1000.toFixed(4)} → ${r10000.toFixed(4)} 单调递减（100→1000→10⁴ 步）`,
    );
    if (name !== '猜硬币') {
      ok(
        r10000 < 0.01,
        `${name}：T=10⁴ 时每轮外部后悔 = ${r10000.toFixed(5)} < 0.01（无悔阈值）`,
      );
    }
  }
  const r30k = Math.max(...learnCE(games.猜硬币, 30000, 2026).externalRegret);
  ok(
    r30k < 0.01,
    `猜硬币：零和振荡使后悔衰减带慢因子，T=10⁴ 时 0.0176 尚未过线，T=3×10⁴ = ${r30k.toFixed(5)} < 0.01（无悔是渐近性质，趋势与过线时刻都被如实报告）`,
  );
}

// ═══════════════════ 64.0 CE 检查器通过与拒绝 ═══════════════════

section('64.0 CE 检查器·锚点⑤：已知 CE 全过、构造破坏分布按解析值拒收');

{
  const pennies = normalGame([2, 2], [[1, -1, -1, 1], [-1, 1, 1, -1]]);
  const traffic = normalGame([2, 2], [[-10, 2, 1, 0], [-10, 1, 2, 0]]);
  const pd = normalGame([2, 2], [[3, 0, 5, 1], [3, 5, 0, 1]]);
  ok(isCorrelatedEquilibrium([0.25, 0.25, 0.25, 0.25], pennies).isCE, `通过：猜硬币均匀分布（= 混合 Nash，Nash ⊆ CE）`);
  ok(isCorrelatedEquilibrium([0, 0.5, 0.5, 0], traffic).isCE, `通过：交通灯红绿灯分布（信号灯协调）`);
  ok(isCorrelatedEquilibrium([0, 0, 0, 1], pd).isCE, `通过：囚徒困境纯 Nash (D,D)`);
  const v1 = isCorrelatedEquilibrium([0.5, 0, 0, 0.5], pd).worstViolation;
  ok(near(v1, 1.0, 1e-12), `拒绝：PD「红绿灯」违反量 = ${v1}（解析值 0.5×(5−3) = 1）`);
  const v2 = isCorrelatedEquilibrium([1, 0, 0, 0], pennies).worstViolation;
  ok(near(v2, 2.0, 1e-12), `拒绝：猜硬币 δ_{(H,H)} 违反量 = ${v2}（列玩家被建议 H 后改 T：1−(−1)=2）`);
  const v3 = isCorrelatedEquilibrium([0.25, 0.25, 0.25, 0.25], traffic).worstViolation;
  ok(near(v3, 2.25, 1e-12), `拒绝：交通灯均匀分布违反量 = ${v3}（被建议 Go 者 1/4 概率撞车，改 Stop 净赚 0.25×11−0.25×2 = 2.25——Aumann 不等式先对 a₋ᵢ 求和再比较）`);
}

// ═══════════════════ 64.0 原语与确定性 ═══════════════════

section('64.0 RM 原语、索引往返与确定性');

{
  ok(
    JSON.stringify(positiveRegretDistribution([0, 0])) === '[0.5,0.5]' &&
      near(positiveRegretDistribution([1, 3])[0], 0.25, 1e-12) &&
      near(positiveRegretDistribution([1, 3])[1], 0.75, 1e-12),
    '正后悔归一：全非正 → 均匀；[1,3] → (0.25, 0.75)（Hart–Mas-Colell 两规则）',
  );
  const step = regretMatchingStep([0, 0], [3, 1], 0);
  ok(
    JSON.stringify(step.probabilities) === '[0.5,0.5]' && step.regrets[0] === 0 && step.regrets[1] === -2,
    `regretMatchingStep：旧后悔 [0,0] → 本轮均匀；选 0 后新后悔 = (${step.regrets.join(', ')})（= cf − cf[chosen]）`,
  );
  const game = normalGame([2, 3], [
    [1, 2, 3, 4, 5, 6],
    [6, 5, 4, 3, 2, 1],
  ]);
  ok(
    Array.from({ length: 6 }, (_, j) => jointIndexOf(game, profileOfJoint(game, j)) === j).every(Boolean),
    '联合索引 ↔ 行动剖面往返一致（末位玩家最快的混合进制）',
  );
  const a = learnCE(pennies5(), 500, 42);
  const b = learnCE(pennies5(), 500, 42);
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    '同种子两次 learnCE 逐位一致（mulberry32 确定性——同输入同输出）',
  );
  throws(() => normalGame([1], [[0]]), 'normalGame 单玩家显式抛错');
  throws(() => normalGame([2, 2], [[1, 2, 3]]), 'normalGame 效用表长度不符显式抛错');
  throws(() => learnCE(pennies5(), 0, 1), 'learnCE 零步数显式抛错');
  throws(() => isCorrelatedEquilibrium([0.5, 0.5], pennies5()), 'isCorrelatedEquilibrium 分布长度不符显式抛错');
  throws(() => isCorrelatedEquilibrium([0.5, 0.5, 0.5, 0.5], pennies5()), 'isCorrelatedEquilibrium 总质量 ≠ 1 显式抛错（测试向量求和 = 2，0.3+0.3+0.2+0.2 在浮点下恰为 1 不作数）');

  function pennies5() {
    return normalGame([2, 2], [[1, -1, -1, 1], [-1, 1, 1, -1]]);
  }
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed === 0) {
  console.log('✅ 63.0 核仁内核 + 64.0 相关均衡内核：合作/非合作博弈双件套数学验证成立');
} else {
  console.error('❌ 存在失败断言');
}
process.exitCode = failed > 0 ? 1 : 0;
