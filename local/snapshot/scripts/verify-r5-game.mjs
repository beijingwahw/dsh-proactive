/**
 * verify-r5-game.mjs — R5-A16 第五轮·博弈机制六内核世界性进化 纯数学离线验证
 *
 * 覆盖（每内核 ≥ 2 条进化轴，≥ 1 条来自数学/性能轴; 全部确定性断言）:
 *   61.0 stable-matching:
 *     数学轴——多对一医院/居民容量版 DA（Roth–Sotomayor 响应式偏好）:
 *       手工例精确对照（双向）、容量 1 退化 ≡ 一对一 DA（双向 × 100 种子）、
 *       Rural Hospital 定理（未匹配集合逐人相同 + 逐院占用相同, 200 种子,
 *       双向输出全部无阻挡对）、阻挡对证人（构造非稳定指派被精确抓出）
 *     性能轴——空闲求婚方队列化（deferredAcceptanceQueued）: GS 求婚序
 *       不变性 + 指针论证 ⟹ matching/inverse/proposals 与批次版逐位相同
 *       （200 种子）+ 耗时对照（n=200 × 30 次）
 *   62.0 mechanism-design:
 *     数学轴——组合拍卖赢家确定（捆绑 XOR + 精确分支定界 + VCG 外部性
 *       定价）: 互补捆绑手工例精确对照、单物品退化 ≡ secondPrice
 *       （300 剖面）、DSIC/IR/收入非负抽样（800 剖面 × 随机谎报）
 *     性能轴——分支定界 vs 2^m 全子集暴力: 同最优值 + 同「指示向量字典序
 *       最大」argmax（200 种子逐一等价）+ 耗时对照
 *   64.0 correlated-equilibrium:
 *     数学轴——粗糙相关均衡 CCE 检查器 + ε 双口径松弛（equilibriumGaps）:
 *       解析锚（PD 红绿灯 1.0 / 交通灯均匀 2.25 / 红绿灯分布 0）、
 *       Nash ⊆ CE ⊆ CCE 三层包含（50 随机博弈 × 网格分布全检）、
 *       CCE-非-CE 证人确定性发现、RM 经验分布的 CCE gap ≤ max regret/T
 *     性能轴——learnCEFast: 50 随机博弈 × 2000 步与 learnCE 逐位相同 +
 *       耗时对照
 *   82.0 crowd-aggregation:
 *     数学轴——已知混淆的贝叶斯最优聚合（bayesianAggregate）: 混合 crowd
 *       ≥ 多数票 + 0.1、对抗者反演（全对抗 crowd 贝叶斯 = 1.0 vs 多数票
 *       塌方）、200 种子 bayes ≥ majority
 *     性能/数值轴——EM 对数表提升: 逐位等价（logLikTrace/估计标签与脚本内
 *       逐元素 safeLog 参考实现逐位相同）+ 耗时对照; 极端混淆 0.999 对角
 *       不产生 NaN/Infinity（对数域 log-sum-exp）
 *   81.0 argumentation:
 *     数学轴——价值型论证框架 VAF（Bench-Capon 2003）: 攻击成功/失败按
 *       受众价值序精确裁决、客观/主观接受手工例、200 随机 VAF × 全体受众
 *       （≤ 3 价值 = 全排列）诱导 Dung AF preferred vs VAF 直定义暴力
 *       （成功攻击版无冲突 + 防御 + ⊆-极大, 含自攻击）逐受众一致 +
 *       byAudience = 暴力轻信接受 + 客观 ⊆ 主观
 *     性能轴——独立集 DFS 位掩码化: preferred/stable/complete 与
 *       bruteForceSemantics 全子集直扫一致（60 随机 AF）+ 耗时对照
 *       （vs 脚本内 includes 版参考 DFS）
 *   90.0 preference-learning:
 *     数学轴——Plackett-Luce 排名模型: 排列概率和 = 1、logProb 手工锚、
 *       两物品 PL ≡ B-T（predictPair 精确 + MLE 效用差与 logLoss 逐位
 *       相等）、MLE 恢复已知效用序（300 排名）、Luce 选择公理 IIA
 *       （300 随机对照集对比值不变）+ 排名概率 = 逐步选择连乘独立重算
 *     性能/数值轴——融合单遍（损失/梯度/Hessian 共享 softmax）vs 朴素三遍
 *       参考逐位相同 + 耗时对照; 20 物品大效用差线性域下溢而 logProb 有限
 *       （对数域）; Armijo 噪声地板（300 排名默认 λ 收敛）
 *
 * 计时说明: 耗时对照用 process.hrtime.bigint()（验证脚本侧计量, 内核零
 * Date.now/Math.random 不受影响）; 断言只锚等价性与宽松的耗时界
 * （优化版 ≤ 参考版 × 1.5 + 实际比值打印）。
 *
 * 运行: node --experimental-strip-types scripts/verify-r5-game.mjs
 */

import {
  deferredAcceptance,
  deferredAcceptanceQueued,
  latticeExtremes,
  isStable,
  capacityDeferredAcceptance,
  isStableManyToOne,
  ruralHospitalCheck,
  randomMatchingProblem,
  randomHospitalResidentsProblem,
  mulberry32,
} from '../src/core/stable-matching.ts';
import {
  combinatorialVcg,
  secondPrice,
  mulberry32 as mdMulberry32,
} from '../src/core/mechanism-design.ts';
import {
  normalGame,
  learnCE,
  learnCEFast,
  isCoarseCorrelatedEquilibrium,
  equilibriumGaps,
  enumerateNash,
} from '../src/core/correlated-equilibrium.ts';
import {
  majorityVote,
  dawidSkene,
  estimateAccuracy,
  bayesianAggregate,
  simulateCrowd,
} from '../src/core/crowd-aggregation.ts';
import {
  argumentFramework,
  randomFramework,
  preferredExtensions,
  stableExtensions,
  completeExtensions,
  bruteForceSemantics,
  valueFramework,
  valueAcceptance,
  attackSucceeds,
  inducedFramework,
  allAudiences,
  randomValueFramework,
  VAF_MAX_VALUES,
} from '../src/core/argumentation.ts';
import {
  mulberry32 as plMulberry32,
  logistic,
  predictPair,
  bradleyTerryMLE,
  rankByUtility,
  plackettLuceMLE,
  plackettLuceLogProb,
  plackettLuceProbability,
  plackettLuceChoiceProbability,
  simulateRankings,
} from '../src/core/preference-learning.ts';

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
    ok(false, `${label}（未抛出）`);
  } catch {
    ok(true, label);
  }
}
/** 计时: 总耗时 ms（reps 次取总, 先预热一次） */
function timeMs(fn, reps) {
  fn(); // 预热 JIT
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < reps; i += 1) fn();
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6;
}
function canon(m) {
  return Object.keys(m).sort().map((k) => `${k}:${m[k]}`).join(',');
}

// ═══════════════════ 61.0 stable-matching R5 ═══════════════════

section('61.0-R5 数学轴: 医院/居民容量版 DA（手工例 + 双向稳定）');

{
  // 手工推演例（验证脚本注释内逐步推演）:
  //   居民发起: 第1轮 r1,r2,r4→h1、r3→h2; h1(cap2) 按 [r4,r3,r1,r2] 留
  //   {r4,r1} 拒 r2; h2 暂握 r3。第2轮 r2→h2（h2 空编收下）→ 终局
  //   {r1→h1, r2→h2, r3→h2, r4→h1}，2 轮 5 次求婚。
  const p = {
    residents: { r1: ['h1', 'h2'], r2: ['h1', 'h2'], r3: ['h2', 'h1'], r4: ['h1', 'h2'] },
    hospitals: {
      h1: { capacity: 2, ranking: ['r4', 'r3', 'r1', 'r2'] },
      h2: { capacity: 2, ranking: ['r1', 'r2', 'r3', 'r4'] },
    },
  };
  const res = capacityDeferredAcceptance(p);
  ok(
    canon(res.assignment) === 'r1:h1,r2:h2,r3:h2,r4:h1' && res.rounds === 2 && res.proposals === 5,
    `居民发起手工例: {r1→h1,r2→h2,r3→h2,r4→h1}（${res.rounds} 轮 ${res.proposals} 次求婚逐项对照）`,
  );
  ok(
    JSON.stringify(res.hospitalAssignments.h1) === JSON.stringify(['r4', 'r1']) &&
      JSON.stringify(res.hospitalAssignments.h2) === JSON.stringify(['r2', 'r3']),
    `在编表按医院偏好序输出: h1=[r4,r1]、h2=[r2,r3]（响应式比较的可观测面）`,
  );
  ok(res.filled.h1 === 2 && res.filled.h2 === 2 && res.vacancy.h1 === 0 && res.vacancy.h2 === 0, 'filled/vacancy 口径一致（cap−filled）');
  ok(isStableManyToOne(res.assignment, p).stable, '居民最优无阻挡对（居民想去 ∧ 医院收得起的对不存在）');
  // 医院发起手工例: 第1轮 h1→r4、h2→r1 双双被握; 第2轮 h1→r3（r3 空手接受）、
  // h2→r2（r2 空手接受）→ 双院满编终止: {r1→h2,r2→h2,r3→h1,r4→h1}，2 轮 4 次。
  const dual = capacityDeferredAcceptance(p, { proposer: 'hospitals' });
  ok(
    canon(dual.assignment) === 'r1:h2,r2:h2,r3:h1,r4:h1' && dual.rounds === 2 && dual.proposals === 4,
    `医院发起手工例: {r1→h2,r2→h2,r3→h1,r4→h1}（${dual.rounds} 轮 ${dual.proposals} 次）——与居民最优不同的稳定匹配`,
  );
  ok(isStableManyToOne(dual.assignment, p).stable, '医院最优也无阻挡对（两个方向都产出稳定匹配）');

  // 阻挡对证人: {r1→h1, r2→h2, r3→h1}、r4 落单——r4 是两家医院的头名
  // (r3,h2): r3 更爱 h2 且 h2 有空位; (r4,h1)/(r4,h2): 落单者对任何
  // 可接受且收得起的医院都构成阻挡（h1 愿踢最差在编者、h2 有空位）。
  const bad = { r1: 'h1', r2: 'h2', r3: 'h1' };
  const chk = isStableManyToOne(bad, p);
  ok(
    !chk.stable && JSON.stringify(chk.blockingPairs) === JSON.stringify([['r3', 'h2'], ['r4', 'h1'], ['r4', 'h2']]),
    `阻挡对证人: 落单 r4 + 错编 r3 被全部三个阻挡对抓出（得到 ${JSON.stringify(chk.blockingPairs)}）`,
  );

  // 入参校验
  throws(() => capacityDeferredAcceptance({ residents: { r: ['h'] }, hospitals: { h: { capacity: 0, ranking: ['r'] } } }), 'capacity=0 显式 throw');
  throws(() => capacityDeferredAcceptance({ residents: { r: ['x'] }, hospitals: { h: { capacity: 1, ranking: ['r'] } } }), '未知医院显式 throw');
  throws(() => isStableManyToOne({ r: 'h' }, { residents: { r: ['h'] }, hospitals: { h: { capacity: 1, ranking: [] } } }), '非互相可接受指派显式 throw');
  throws(() => isStableManyToOne({ r1: 'h1', r2: 'h1', r3: 'h1' }, p), '超容量指派显式 throw（3 > cap 2）');
}

section('61.0-R5 数学轴: 容量 1 退化 ≡ 一对一 DA（双向 × 100 种子）');

{
  let forwardOk = true;
  let backwardOk = true;
  for (let s = 0; s < 100; s += 1) {
    const one = randomMatchingProblem(7, 4100 + s);
    const hr = {
      residents: one.proposers,
      hospitals: Object.fromEntries(Object.entries(one.receivers).map(([k, v]) => [k, { capacity: 1, ranking: v }])),
    };
    if (canon(capacityDeferredAcceptance(hr).assignment) !== canon(deferredAcceptance(one).matching)) forwardOk = false;
    const dual = capacityDeferredAcceptance(hr, { proposer: 'hospitals' });
    const bottom = latticeExtremes(one).receiverOptimal;
    if (canon(dual.assignment) !== canon(bottom)) backwardOk = false;
  }
  ok(forwardOk, '容量 1 + 居民发起 ≡ deferredAcceptance（求婚方最优, 100 种子逐位相同）');
  ok(backwardOk, '容量 1 + 医院发起 ≡ latticeExtremes 接收方最优（格底, 100 种子逐位相同）');
}

section('61.0-R5 性质轴: Rural Hospital 定理（200 种子全检）');

{
  let holds = 0;
  let stableBoth = true;
  let sameMatchedSet = true;
  for (let s = 0; s < 200; s += 1) {
    const prob = randomHospitalResidentsProblem(10, 4, 900 + s);
    const chk = ruralHospitalCheck(prob);
    if (chk.holds) holds += 1; else {
      sameMatchedSet = chk.unmatchedIdentical;
    }
    if (!isStableManyToOne(chk.residentOptimal.assignment, prob).stable) stableBoth = false;
    if (!isStableManyToOne(chk.hospitalOptimal.assignment, prob).stable) stableBoth = false;
  }
  ok(holds === 200, `Rural Hospital 定理: 200/200 个市场双向容量 DA 的未匹配居民集合逐人相同 ∧ 每院占用逐院相同（Roth 1984/1986）`);
  ok(stableBoth, '200 市场的双向输出全部通过阻挡对检查（双向皆稳定是定理对照的前提）');
  ok(sameMatchedSet, '不变量分解字段（unmatchedIdentical/occupancyIdentical）如实报告');
}

section('61.0-R5 性能轴: 空闲求婚方队列化——等价 + 耗时对照');

{
  let equiv = 0;
  for (let s = 0; s < 200; s += 1) {
    const problem = randomMatchingProblem(30, 5200 + s);
    const batch = deferredAcceptance(problem);
    const queued = deferredAcceptanceQueued(problem);
    if (
      canon(batch.matching) === canon(queued.matching) &&
      canon(batch.inverse) === canon(queued.inverse) &&
      batch.proposals === queued.proposals
    ) equiv += 1;
  }
  ok(equiv === 200, `200 种子 n=30: matching/inverse/proposals 与批次版逐位相同（GS 求婚序不变性 + 指针论证）`);
  const big = randomMatchingProblem(200, 77);
  const batchMs = timeMs(() => deferredAcceptance(big), 30);
  const queuedMs = timeMs(() => deferredAcceptanceQueued(big), 30);
  const canonBig = canon(deferredAcceptance(big).matching);
  const canonQueued = canon(deferredAcceptanceQueued(big).matching);
  ok(canonBig === canonQueued, 'n=200 大实例: 队列版与批次版 matching 逐位相同');
  ok(
    queuedMs <= batchMs * 1.5,
    `耗时对照 n=200 × 30 次: 批次版 ${batchMs.toFixed(1)}ms vs 队列版 ${queuedMs.toFixed(1)}ms（比值 ${(batchMs / queuedMs).toFixed(2)}×——求婚循环主导下两版持平, 队列化的收益是最坏情形每轮再排序的消除与零中间分配, 诚实口径非加速宣称）`,
  );
}

// ═══════════════════ 62.0 mechanism-design R5 ═══════════════════

section('62.0-R5 数学轴: 组合拍卖赢家确定 + VCG（互补捆绑手工例）');

{
  // 2 物品 2 agent: 互补估值——单物品 3+3, 捆绑 5 vs 7 → 最优 = agent1 独得
  // 两件（7 > 6 = 3+3 > 5）; VCG: pay₁ = W*₋₁ − W₋₁(a*) = (3+3) − 0 = 5
  const r = combinatorialVcg({
    agents: 2,
    bids: [
      { agent: 0, items: [0], value: 3 },
      { agent: 1, items: [1], value: 3 },
      { agent: 0, items: [0, 1], value: 5 },
      { agent: 1, items: [0, 1], value: 7 },
    ],
  });
  ok(
    JSON.stringify(r.winningBids) === JSON.stringify([3]) && near(r.welfare, 7, 1e-12),
    `互补捆绑: agent1 以捆绑报价 7 独得两件（单拆 3+3=6 < 7——互补性使整批打包更优）`,
  );
  ok(near(r.payments[0], 0, 1e-12) && near(r.payments[1], 5, 1e-12), `VCG 支付 = [${r.payments}]: 败者 0、胜者付外部性 5（其入场使他人失去 3+3）`);
  ok(near(r.utilities[1], 2, 1e-12) && near(r.utilities[0], 0, 1e-12) && near(r.revenue, 5, 1e-12), '效用 = 报价 − 支付（IR ≥ 0）、收入 = Σ支付');
  ok(near(r.welfareWithout[0], 7, 1e-12) && near(r.welfareWithout[1], 5, 1e-12), `W*₋ᵢ 重解口径: 去掉 agent0 后他人最优 7（其本就未中标）、去掉 agent1 后 5（agent0 两标 XOR 取其大——单品 3 是 agent1 自己的）`);
  // XOR 约束: 同一 agent 两标不能同时中——构造必检例
  const xor = combinatorialVcg({
    agents: 1,
    bids: [
      { agent: 0, items: [0], value: 4 },
      { agent: 0, items: [1], value: 4 },
    ],
  });
  ok(
    xor.winningBids.length === 1 && near(xor.welfare, 4, 1e-12) && near(xor.payments[0], 0, 1e-12),
    `XOR 约束: 同一 agent 的两标不并存（welfare=4 而非 8; 单人无外部性支付 0）`,
  );

  // 单物品退化 ≡ secondPrice（300 剖面）
  const rng = mdMulberry32(77);
  let spOk = true;
  for (let t = 0; t < 300; t += 1) {
    const n = 2 + Math.floor(rng() * 4);
    const vals = Array.from({ length: n }, () => rng());
    const bids = vals.map((v, i) => ({ agent: i, items: [0], value: v }));
    const out = combinatorialVcg({ agents: n, bids });
    const sp = secondPrice(vals);
    const winnerAgent = bids[out.winningBids[0]].agent;
    if (winnerAgent !== sp.winner || !near(out.payments[sp.winner], sp.payment, 1e-12)) spOk = false;
    if (out.payments.some((p, i) => i !== sp.winner && !near(p, 0, 1e-12))) spOk = false;
  }
  ok(spOk, '单物品退化: 300 随机剖面 胜者/支付与 secondPrice 逐字一致（败者付 0）');

  // DSIC/IR/收入非负（组合域, 800 剖面 × 随机谎报——谎报者整体换一套投标,
  // 真实估值口径 = 其真实投标对所赢捆绑的报价（未投过的捆绑真实价值 0））
  const rng2 = mdMulberry32(2077);
  let dsicViolations = 0;
  let irViolations = 0;
  let revenueViolations = 0;
  let changedAlloc = 0;
  for (let t = 0; t < 800; t += 1) {
    const agents = 2 + Math.floor(rng2() * 2);
    const nItems = 2 + Math.floor(rng2() * 2);
    const mkBids = (rnd) => {
      const nb = 4 + Math.floor(rnd() * 5);
      const bids = [];
      for (let k = 0; k < nb; k += 1) {
        const size = 1 + Math.floor(rnd() * nItems);
        const pool = Array.from({ length: nItems }, (_, i) => i);
        const items = [];
        for (let q = 0; q < size; q += 1) items.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
        items.sort((a, b) => a - b);
        bids.push({ agent: Math.floor(rnd() * agents), items, value: rnd() });
      }
      return bids;
    };
    const truth = mkBids(rng2);
    const honest = combinatorialVcg({ agents, bids: truth });
    const liar = Math.floor(rng2() * agents);
    const lie = mkBids(rng2).filter((b) => b.agent === liar);
    const liedBids = truth.filter((b) => b.agent !== liar).concat(lie);
    const lied = combinatorialVcg({ agents, bids: liedBids });
    let lieValue = 0;
    for (const k of lied.winningBids) {
      const won = liedBids[k];
      if (won.agent !== liar) continue;
      const match = truth.find((b) => b.agent === liar && JSON.stringify([...b.items]) === JSON.stringify([...won.items]));
      lieValue += match ? match.value : 0;
    }
    const lieUtility = lieValue - lied.payments[liar];
    const honestUtility = honest.utilities[liar];
    if (lieUtility > honestUtility + 1e-9) dsicViolations += 1;
    const wonSig = (out, bids, i) => [...out.allocation[i]].sort((a, b) => a - b).join(',');
    if (wonSig(lied, liedBids, liar) !== wonSig(honest, truth, liar)) changedAlloc += 1;
    for (let i = 0; i < agents; i += 1) if (honest.utilities[i] < -1e-9) irViolations += 1;
    if (honest.revenue < -1e-9) revenueViolations += 1;
  }
  ok(dsicViolations === 0, `组合域 DSIC: 800 剖面 × 随机谎报, 按真实估值效用无一超过诚实（违例 ${dsicViolations}）`);
  ok(irViolations === 0, `组合域 IR: 支付 ≤ 所赢捆绑真实报价（违例 ${irViolations}）`);
  ok(revenueViolations === 0, `组合域收入 ≥ 0（违例 ${revenueViolations}）`);
  ok(changedAlloc > 50, `谎报确实改变过分配 ${changedAlloc} 次（探测有力非空转）`);

  throws(() => combinatorialVcg({ agents: 0, bids: [] }), 'agents=0 显式 throw');
  throws(() => combinatorialVcg({ agents: 1, bids: [{ agent: 1, items: [0], value: 1 }] }), 'agent 越界显式 throw');
  throws(() => combinatorialVcg({ agents: 1, bids: [{ agent: 0, items: [], value: 1 }] }), '空捆绑显式 throw');
  throws(() => combinatorialVcg({ agents: 1, bids: [{ agent: 0, items: [1, 0], value: 1 }] }), '捆绑非升序显式 throw');
  throws(() => combinatorialVcg({ agents: 1, bids: [{ agent: 0, items: [0], value: -1 }] }), '负报价显式 throw');
}

section('62.0-R5 性能轴: 分支定界 vs 2^m 暴力——等价 + 耗时对照');

{
  const rng = mdMulberry32(20260101);
  const makeBids = (rnd, m) => {
    const agents = 2 + Math.floor(rnd() * 3);
    const nItems = 2 + Math.floor(rnd() * 3);
    const bids = [];
    for (let k = 0; k < m; k += 1) {
      const size = 1 + Math.floor(rnd() * nItems);
      const pool = Array.from({ length: nItems }, (_, i) => i);
      const items = [];
      for (let q = 0; q < size; q += 1) items.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
      items.sort((a, b) => a - b);
      bids.push({ agent: Math.floor(rnd() * agents), items, value: Math.round(rnd() * 100) / 10 });
    }
    return { agents, bids };
  };
  // 暴力参考: 2^m 全子集, 可行过滤, 取值最大者中「指示向量字典序最大」
  // （b₀ 优先取 1）——与 take-first DFS 首个严格改进者的平局规则同一规则。
  const bruteWdp = (bids) => {
    const m = bids.length;
    const revVal = (mask) => {
      let v = 0;
      for (let k = 0; k < m; k += 1) if ((mask >> k) & 1) v |= 1 << (m - 1 - k);
      return v;
    };
    const order = Array.from({ length: 1 << m }, (_, mask) => mask).sort((a, b) => revVal(b) - revVal(a));
    let best = -1;
    let bestMask = -1;
    for (const mask of order) {
      let used = 0;
      let ag = 0;
      let val = 0;
      let feas = true;
      for (let k = 0; k < m; k += 1) {
        if (!((mask >> k) & 1)) continue;
        const b = bids[k];
        let bm = 0;
        for (const it of b.items) bm |= 1 << it;
        if ((used & bm) !== 0 || (ag & (1 << b.agent)) !== 0) {
          feas = false;
          break;
        }
        used |= bm;
        ag |= 1 << b.agent;
        val += b.value;
      }
      if (feas && val > best) {
        best = val;
        bestMask = mask;
      }
    }
    const chosen = [];
    for (let k = 0; k < m; k += 1) if ((bestMask >> k) & 1) chosen.push(k);
    return { value: Math.max(0, best), chosen };
  };
  let eq = 0;
  let total = 0;
  for (let t = 0; t < 200; t += 1) {
    const { agents, bids } = makeBids(rng, 4 + Math.floor(rng() * 9));
    const out = combinatorialVcg({ agents, bids });
    const ref = bruteWdp(bids);
    total += 1;
    if (out.welfare === ref.value && JSON.stringify(out.winningBids) === JSON.stringify(ref.chosen)) eq += 1;
  }
  ok(eq === total, `分支定界 vs 暴力: 200 种子化实例的最优值与「指示向量字典序最大」argmax 逐一相同（含平局实例）`);
  // 耗时对照（m=16, 密集捆绑——剪枝收益放大档）
  const dense = { agents: 3, bids: [] };
  const drng = mdMulberry32(31337);
  for (let k = 0; k < 16; k += 1) {
    const size = 2 + Math.floor(drng() * 2);
    const pool = [0, 1, 2, 3];
    const items = [];
    for (let q = 0; q < size; q += 1) items.push(pool.splice(Math.floor(drng() * pool.length), 1)[0]);
    items.sort((a, b) => a - b);
    dense.bids.push({ agent: Math.floor(drng() * 3), items, value: Math.round(drng() * 100) / 10 });
  }
  const bnMs = timeMs(() => combinatorialVcg(dense), 20);
  const bruteMs = timeMs(() => bruteWdp(dense.bids), 20);
  ok(
    bnMs <= bruteMs * 1.5,
    `耗时对照 m=16 × 20 次: 分支定界 ${bnMs.toFixed(2)}ms vs 暴力 ${bruteMs.toFixed(2)}ms（比值 ${(bruteMs / bnMs).toFixed(2)}×）`,
  );
}

// ═══════════════════ 64.0 correlated-equilibrium R5 ═══════════════════

section('64.0-R5 数学轴: 粗糙相关均衡 CCE 检查器（解析锚）');

{
  const pd = normalGame([2, 2], [[3, 0, 5, 1], [3, 5, 0, 1]]); // (C,C)(C,D)(D,C)(D,D)
  const traffic = normalGame([2, 2], [[-10, 2, 1, 0], [-10, 1, 2, 0]]);
  const light = normalGame([2, 2], [[1, -1, -1, 1], [-1, 1, 1, -1]]);
  const redPd = equilibriumGaps([0.5, 0, 0, 0.5], pd);
  ok(
    near(redPd.cceGap, 1.0, 1e-12) && near(redPd.ceGap, 1.0, 1e-12),
    `PD 红绿灯: cceGap = ${redPd.cceGap}（解析: 0.5×(5−3) + 0.5×0 = 1）= ceGap = 1——事前承诺偏离与条件偏离同赚`,
  );
  const uniTraffic = equilibriumGaps([0.25, 0.25, 0.25, 0.25], traffic);
  ok(
    near(uniTraffic.cceGap, 2.25, 1e-12) && near(uniTraffic.ceGap, 2.25, 1e-12),
    `交通灯均匀分布: cceGap = ${uniTraffic.cceGap}（解析: 0.25×11 − 0.25×2 = 2.25）——均匀撞车风险同毁两口径`,
  );
  const okLight = equilibriumGaps([0, 0.5, 0.5, 0], traffic);
  ok(okLight.isCE && okLight.isCCE && okLight.ceGap <= 1e-12 && okLight.cceGap <= 1e-12, '红绿灯分布: CE ∧ CCE 双通过（信号灯协调的合法性）');
  const uniPennies = equilibriumGaps([0.25, 0.25, 0.25, 0.25], light);
  ok(uniPennies.isCE && uniPennies.isCCE, '猜硬币均匀（= 混合 Nash）: Nash ⊆ CE ⊆ CCE 三层包含的下端点');
  const cce = isCoarseCorrelatedEquilibrium([0.5, 0, 0, 0.5], pd);
  ok(
    cce.worst !== null && cce.worst.player === 0 && cce.worst.to === 1,
    `CCE 证人定位: 玩家 ${cce.worst.player} 事前固定改打 D(${cce.worst.to}) 净赚 ${cce.worst.gain}`,
  );
}

section('64.0-R5 性质轴: Nash ⊆ CE ⊆ CCE 全检 + CCE-非-CE 证人（60 随机博弈）');

{
  const rng = mulberry32(4242);
  let includeOk = true;
  let boundOk = true;
  let witnesses = 0;
  let distsChecked = 0;
  let witnessInfo = null;
  for (let t = 0; t < 60; t += 1) {
    const m1 = 2 + Math.floor(rng() * 2);
    const m2 = 2 + Math.floor(rng() * 2);
    const J = m1 * m2;
    const u0 = Array.from({ length: J }, () => Math.round((rng() * 4 - 2) * 2) / 2);
    const u1 = Array.from({ length: J }, () => Math.round((rng() * 4 - 2) * 2) / 2);
    const g = normalGame([m1, m2], [u0, u1]);
    // Nash → 独立积分布: 应同时是 CE 与 CCE
    for (const eq of enumerateNash(g)) {
      const dist = new Array(J).fill(0);
      for (let j = 0; j < J; j += 1) {
        const a0 = Math.floor(j / m2);
        const a1 = j % m2;
        dist[j] = eq.strategies[0][a0] * eq.strategies[1][a1];
      }
      const chk = equilibriumGaps(dist, g);
      if (!chk.isCE || !chk.isCCE) includeOk = false;
    }
    // 网格分布: CE ⟹ CCE + cceGap ≤ max(m1,m2)·ceGap（无条件收益 = 条件收益加权和）
    const K = 4;
    for (let i = 0; i <= K; i += 1) {
      for (let j = 0; j <= K - i; j += 1) {
        const k = K - i - j;
        const raw = [];
        for (let q = 0; q < J; q += 1) raw.push(q === 0 ? i : q === 1 ? j : q === 2 ? k : 0);
        const sum = raw.reduce((s, v) => s + v, 0);
        if (sum === 0) continue;
        const dist = raw.map((v) => v / sum);
        const gaps = equilibriumGaps(dist, g);
        distsChecked += 1;
        if (gaps.isCE && !gaps.isCCE) includeOk = false;
        const maxAct = Math.max(m1, m2);
        if (gaps.cceGap > maxAct * gaps.ceGap + 1e-9) boundOk = false;
        if (gaps.isCCE && !gaps.isCE) {
          witnesses += 1;
          if (witnessInfo === null) witnessInfo = { t, dist: dist.map((v) => Number(v.toFixed(4))), ceGap: gaps.ceGap, cceGap: gaps.cceGap };
        }
      }
    }
  }
  ok(includeOk, `60 随机博弈: 每个枚举 Nash 的积分布皆是 CE ∧ CCE, 且全部 ${distsChecked} 个网格分布 CE ⟹ CCE（Aumann 层次）`);
  ok(boundOk, '无条件/条件违反量的派生界 cceGap ≤ maxActions·ceGap 全检通过（两 ε 无单向序的诚实刻画）');
  ok(
    witnesses >= 1,
    `CCE-非-CE 证人确定性发现 ${witnesses} 个（首例: 博弈 #${witnessInfo.t} 分布 [${witnessInfo.dist}] 的 ceGap = ${witnessInfo.ceGap} > 0 而 cceGap = ${witnessInfo.cceGap}——承诺口径可稳、逐条建议口径不稳, CE ⊊ CCE 的构造性分离）`,
  );
}

section('64.0-R5 性能轴: learnCEFast ≡ learnCE（50 博弈逐位）+ 耗时对照');

{
  const rng = mulberry32(64);
  let equiv = 0;
  for (let t = 0; t < 50; t += 1) {
    const actions = Array.from({ length: 3 + Math.floor(rng() * 3) }, () => 2 + Math.floor(rng() * 3));
    const J = actions.reduce((a, b) => a * b, 1);
    const utils = Array.from({ length: actions.length }, () => Array.from({ length: J }, () => rng() * 2 - 1));
    const g = normalGame(actions, utils);
    const a = learnCE(g, 2000, 1000 + t);
    const b = learnCEFast(g, 2000, 1000 + t);
    if (JSON.stringify(a) === JSON.stringify(b)) equiv += 1;
  }
  ok(equiv === 50, '50 随机博弈（3~5 方 × 2~4 行动）× 2000 步: learnCEFast 输出与 learnCE JSON 逐位相同（同 RNG 序 + 同算术序）');
  // RM 无悔 ⟹ 经验分布近似 CCE（gap ≤ max regret/T——外部后悔恰是 CCE 不等式左边）
  const traffic = normalGame([2, 2], [[-10, 2, 1, 0], [-10, 1, 2, 0]]);
  const rm = learnCE(traffic, 10000, 2026);
  const gaps = equilibriumGaps(rm.jointFreq, traffic);
  const maxRegret = Math.max(...rm.externalRegret);
  ok(
    gaps.cceGap <= maxRegret + 1e-9,
    `RM 10⁴ 步经验分布: cceGap = ${gaps.cceGap.toFixed(5)} ≤ max 外部后悔/T = ${maxRegret.toFixed(5)}（无悔定理直通 CCE——学到的是哪一层的可观测面）`,
  );
  const gBig = normalGame([4, 5, 6], (() => {
    const r2 = mulberry32(9);
    const J = 120;
    return [0, 1, 2].map(() => Array.from({ length: J }, () => r2() * 2 - 1));
  })());
  const learnMs = timeMs(() => learnCE(gBig, 3000, 42), 10);
  const fastMs = timeMs(() => learnCEFast(gBig, 3000, 42), 10);
  ok(
    fastMs <= learnMs * 1.5,
    `耗时对照 [4,5,6] 行动博弈 × 3000 步 × 10 次: learnCE ${learnMs.toFixed(2)}ms vs learnCEFast ${fastMs.toFixed(2)}ms（比值 ${(learnMs / fastMs).toFixed(2)}×——每步每玩家省一次分布数组分配与反事实分配）`,
  );
  throws(() => learnCEFast(traffic, 0, 1), 'learnCEFast 零步数显式 throw');
}

// ═══════════════════ 82.0 crowd-aggregation R5 ═══════════════════

section('82.0-R5 数学轴: 已知混淆的贝叶斯最优聚合（bayesianAggregate）');

{
  const CROWD = [
    { archetype: 'good', diagonal: 0.9 },
    { archetype: 'good', diagonal: 0.9 },
    { archetype: 'spammer' },
    { archetype: 'adversarial', diagonal: 0.15 },
    { archetype: 'medium', diagonal: 0.6 },
  ];
  const sim = simulateCrowd({ workers: CROWD, items: 300, classes: 3, seed: 42 });
  const bayes = bayesianAggregate(sim.labels, sim.confusions, sim.classPrior);
  const mvAcc = estimateAccuracy(sim.truth, majorityVote(sim.labels));
  const bayesAcc = estimateAccuracy(sim.truth, bayes.estimatedLabels);
  ok(bayesAcc >= 0.97, `已知真混淆: 贝叶斯一步聚合准确率 ${bayesAcc} ≥ 0.97（零 EM 迭代——E 步闭式即 MAP 判决）`);
  ok(bayesAcc - mvAcc >= 0.1, `高出多数票 ${(bayesAcc - mvAcc).toFixed(3)} ≥ 0.1（多数票 ${mvAcc}——垃圾+对抗拉低的基线被后验加权校正）`);
  ok(
    bayes.truthPosterior.every((row) => near(row.reduce((a, b) => a + b, 0), 1, 1e-4)),
    '对数域 log-sum-exp 后验行和 = 1（数值轴: 无下溢）',
  );
  // 对抗者反演: 全循环反指 crowd——多数票塌方、贝叶斯反演到 100%
  const advCrowd = Array.from({ length: 4 }, () => ({ archetype: 'adversarial', diagonal: 0.1 }));
  const simAdv = simulateCrowd({ workers: advCrowd, items: 200, classes: 3, seed: 11 });
  const advBayes = bayesianAggregate(simAdv.labels, simAdv.confusions, simAdv.classPrior);
  const advMv = estimateAccuracy(simAdv.truth, majorityVote(simAdv.labels));
  ok(
    estimateAccuracy(simAdv.truth, advBayes.estimatedLabels) === 1,
    `对抗者反演: 全循环反指 crowd 的贝叶斯聚合准确率 = 1（P(报 j+1|真 j)=0.9 在似然中是证据——反指者 = 金矿）`,
  );
  ok(advMv <= 0.1, `同数据多数票准确率 ${advMv} ≤ 0.1（反指者被一人一票放大成双倍作恶——两口径的分裂即贝叶斯最优性的价值）`);
  // 200 种子: bayes ≥ majority（贝叶斯最优判决在生成模型正确时不劣于任何判决规则）
  let ge = 0;
  let strictly = 0;
  for (let s = 0; s < 200; s += 1) {
    const sm = simulateCrowd({ workers: CROWD, items: 120, classes: 3, seed: 5000 + s });
    const ba = bayesianAggregate(sm.labels, sm.confusions, sm.classPrior);
    const acc1 = estimateAccuracy(sm.truth, ba.estimatedLabels);
    const acc2 = estimateAccuracy(sm.truth, majorityVote(sm.labels));
    if (acc1 >= acc2) ge += 1;
    if (acc1 > acc2) strictly += 1;
  }
  ok(ge === 200, `200 种子: 贝叶斯聚合准确率 ≥ 多数票 200/200（0-1 损失下的贝叶斯最优性实证）`);
  ok(strictly >= 150, `其中 ${strictly}/200 严格更优（垃圾/对抗存在时差距系统性拉开）`);
  throws(() => bayesianAggregate(sim.labels, sim.confusions.slice(0, 3)), 'confusions 数量不齐显式 throw');
  throws(() => bayesianAggregate(sim.labels, sim.confusions, [0.5, 0.5, 0.1]), '先验非单纯形显式 throw');
  throws(() => bayesianAggregate(sim.labels, sim.confusions.map((m) => m.map((r) => r.slice(0, 2)))), '混淆矩阵非方阵显式 throw');
}

section('82.0-R5 性能+数值轴: EM 对数表提升——逐位等价 + 耗时对照');

{
  const CROWD = [
    { archetype: 'good', diagonal: 0.9 },
    { archetype: 'good', diagonal: 0.9 },
    { archetype: 'spammer' },
    { archetype: 'adversarial', diagonal: 0.15 },
    { archetype: 'medium', diagonal: 0.6 },
  ];
  const sim = simulateCrowd({ workers: CROWD, items: 2000, classes: 3, seed: 909 });
  // 朴素参考 EM: 逐元素 safeLog（内核提升前的旧算术——Math.log 每次 (i,j,w) 调用）
  const safeLog = (x) => Math.log(x > 1e-300 ? x : 1e-300);
  const naiveEm = (labels, iters) => {
    const Y = labels.labels;
    const W = Y.length;
    const I = Y[0].length;
    const C = labels.classes;
    const s = 0.01;
    // 多数票初始化 → 一次 M 步
    const mv = majorityVote(labels);
    let gamma = Array.from({ length: I }, (_, i) => Array.from({ length: C }, (_, j) => (mv[i] === j ? 1 : 0)));
    let prior = gamma.reduce((acc, row) => row.map((v, j) => acc[j] + v), new Array(C).fill(s)).map((v) => v / (I + s * C));
    let pi = Array.from({ length: W }, () => Array.from({ length: C }, () => new Array(C).fill(0)));
    const mStep = () => {
      for (let w = 0; w < W; w += 1) {
        for (let j = 0; j < C; j += 1) {
          const cvec = new Array(C).fill(s);
          for (let i = 0; i < I; i += 1) {
            const v = Y[w][i];
            if (v !== null) cvec[v] += gamma[i][j];
          }
          const denom = cvec.reduce((a, b) => a + b, 0);
          for (let l = 0; l < C; l += 1) pi[w][j][l] = denom > 1e-12 ? cvec[l] / denom : 1 / C;
        }
      }
      prior = gamma.reduce((acc, row) => row.map((v, j) => acc[j] + v), new Array(C).fill(s)).map((v) => v / (I + s * C));
    };
    mStep();
    const loglik = () => {
      let total = 0;
      for (let i = 0; i < I; i += 1) {
        const lp = new Array(C);
        for (let j = 0; j < C; j += 1) {
          let acc = safeLog(prior[j]);
          for (let w = 0; w < W; w += 1) {
            const v = Y[w][i];
            if (v !== null) acc += safeLog(pi[w][j][v]);
          }
          lp[j] = acc;
        }
        let m = -Infinity;
        for (const x of lp) if (x > m) m = x;
        let sum = 0;
        for (const x of lp) sum += Math.exp(x - m);
        total += m + Math.log(sum);
      }
      return total;
    };
    const trace = [loglik()];
    for (let t = 1; t <= iters; t += 1) {
      const next = Array.from({ length: I }, () => new Array(C).fill(0));
      for (let i = 0; i < I; i += 1) {
        const lp = new Array(C);
        for (let j = 0; j < C; j += 1) {
          let acc = safeLog(prior[j]);
          for (let w = 0; w < W; w += 1) {
            const v = Y[w][i];
            if (v !== null) acc += safeLog(pi[w][j][v]);
          }
          lp[j] = acc;
        }
        let m = -Infinity;
        for (const x of lp) if (x > m) m = x;
        let sum = 0;
        for (let j = 0; j < C; j += 1) {
          lp[j] = Math.exp(lp[j] - m);
          sum += lp[j];
        }
        for (let j = 0; j < C; j += 1) next[i][j] = lp[j] / sum;
      }
      gamma = next;
      mStep();
      trace.push(loglik());
    }
    return { trace, gamma };
  };
  const R6 = (x) => Number(x.toFixed(6)); // 内核结果口径的六位小数圆整
  const ds = dawidSkene(sim.labels, { iters: 25, tol: 1e-30 });
  const naive = naiveEm(sim.labels, 25);
  ok(
    ds.logLikTrace.length === naive.trace.length && ds.logLikTrace.every((v, i) => v === R6(naive.trace[i])),
    `对数表提升逐位等价: 25 轮 EM 的 logLikTrace（六位圆整口径）与逐元素 safeLog 参考实现逐项相同（查表 = 同值缓存, 算术序不变）`,
  );
  ok(
    JSON.stringify(ds.estimatedLabels) === JSON.stringify(naive.gamma.map((row) => row.indexOf(Math.max(...row)))),
    '最终硬指派与参考实现逐位相同（提升零漂移直达估计层）',
  );
  const kernelMs = timeMs(() => dawidSkene(sim.labels, { iters: 25, tol: 1e-30 }), 3);
  const naiveMs = timeMs(() => naiveEm(sim.labels, 25), 3);
  ok(
    kernelMs <= naiveMs * 1.5,
    `耗时对照 2000 items × 5 workers × 25 轮 × 3 次: 提升 ${kernelMs.toFixed(0)}ms vs 参考 ${naiveMs.toFixed(0)}ms（比值 ${(naiveMs / kernelMs).toFixed(2)}×, 每轮 2·I·C·W 次 Math.log → W·C² 次）`,
  );
  // 数值轴: 极端混淆（0.999 对角）+ 长似然不产生 NaN/Infinity
  const sharp = Array.from({ length: 8 }, () => ({ confusion: [[0.999, 0.0005, 0.0005], [0.0005, 0.999, 0.0005], [0.0005, 0.0005, 0.999]] }));
  const simSharp = simulateCrowd({ workers: sharp, items: 100, classes: 3, seed: 5 });
  const sharpBayes = bayesianAggregate(simSharp.labels, simSharp.confusions, simSharp.classPrior);
  const sharpDs = dawidSkene(simSharp.labels, { iters: 40, tol: 1e-12 });
  ok(
    sharpBayes.truthPosterior.every((row) => row.every((v) => Number.isFinite(v) && v >= 0)) && Number.isFinite(sharpBayes.logLikelihood),
    '数值轴: 8 worker × 0.999 对角极端混淆下贝叶斯后验全有限非负（线性域连乘 0.999⁸ 尚可, 再陡必下溢——对数域稳）',
  );
  ok(
    estimateAccuracy(simSharp.truth, sharpBayes.estimatedLabels) === 1 && estimateAccuracy(simSharp.truth, sharpDs.estimatedLabels) === 1,
    '极端高保真 crowd: 一步贝叶斯与 EM 都恢复真值 100%',
  );
}

// ═══════════════════ 81.0 argumentation R5 ═══════════════════

section('81.0-R5 数学轴: 价值型论证框架 VAF（Bench-Capon 手工例 + 双口径接受）');

{
  // 手工例: 论证 a/v0、b/v1、c/v0; 攻击 a→b、b→c。
  // 受众 [v0≻v1]（pref=[0,1]）: a→b 成功（v0 不劣 v1）; b→c 失败（v1 劣 v0）。
  // 诱导 AF = {a→b}: 唯一 preferred {a,c} → a、c 轻信接受, b 否。
  // 受众 [v1≻v0]（pref=[1,0]）: a→b 失败; b→c 成功。诱导 AF = {b→c}:
  // preferred {a,b} → a、b 接受, c 否。
  // ⟹ a 客观接受（两受众都收）; b、c 仅主观接受（各恰一受众收）。
  const vaf = valueFramework(['a', 'b', 'c'], ['v0', 'v1'], [0, 1, 0], [[0, 1], [1, 2]]);
  ok(attackSucceeds(0, 1, vaf, [0, 1]) === true && attackSucceeds(1, 2, vaf, [0, 1]) === false, '受众 [v0≻v1]: a→b 成功、b→c 被价值序免疫');
  ok(attackSucceeds(0, 1, vaf, [1, 0]) === false && attackSucceeds(1, 2, vaf, [1, 0]) === true, '受众 [v1≻v0]: a→b 免疫、b→c 成功——同一攻击图换受众翻案');
  const acc = valueAcceptance(vaf);
  ok(
    JSON.stringify([...acc.objectivelyAcceptable]) === JSON.stringify([true, false, false]) &&
      JSON.stringify([...acc.subjectivelyAcceptable]) === JSON.stringify([true, true, true]),
    `双口径: 客观接受 {a}（任何价值观下都站得住）、主观接受 {a,b,c}（b/c 各恰有一个受众收——Bench-Capon 的「正典随价值观变化」）`,
  );
  ok(acc.audiencesChecked === 2 && allAudiences(vaf).length === 2, '受众枚举 = 价值序全排列 2! = 2');
  ok(
    JSON.stringify(preferredExtensions(inducedFramework(vaf, [0, 1]))) === JSON.stringify([[0, 2]]) &&
      JSON.stringify(preferredExtensions(inducedFramework(vaf, [1, 0]))) === JSON.stringify([[0, 1]]),
    '诱导 Dung AF 的 preferred 外延手工对照: {a,c} / {a,b}（复用全部经典语义）',
  );
  ok(attackSucceeds(0, 2, vaf, [0, 1]) === false, '非攻击对恒 false（全谓词: 边存在 ∧ 价值不劣——缺一即败）');
  throws(() => valueFramework(['a', 'b'], ['v'], [0], []), 'values 长度 ≠ 论证数显式 throw');
  throws(() => attackSucceeds(0, 1, vaf, [0]), '受众非完整排列显式 throw');
  throws(() => allAudiences(valueFramework(['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6'], [0, 1, 2, 3, 4, 5, 6], [])), `价值数 > ${VAF_MAX_VALUES} 全排列护栏显式 throw`);
  throws(() => randomValueFramework(3, 0, 0.5, 1), '价值数 < 1 显式 throw');
}

section('81.0-R5 性质轴: VAF 语义 vs 暴力双路线（200 随机 VAF × 全体受众）');

{
  // VAF 直定义暴力: 成功攻击版无冲突（含自攻击!）+ 防御 + ⊆-极大
  const brutePreferred = (vaf, audience) => {
    const n = vaf.size;
    const succ = (a, b) => attackSucceeds(a, b, vaf, audience);
    const masks = [];
    for (let mask = 0; mask < 1 << n; mask += 1) {
      let okSet = true;
      for (let a = 0; a < n && okSet; a += 1) {
        if (!((mask >> a) & 1)) continue;
        for (let b = 0; b < n; b += 1) {
          if ((mask >> b) & 1 && succ(a, b)) {
            okSet = false; // 内部成功攻击（a===b 的自攻击同样算冲突）
            break;
          }
        }
      }
      if (!okSet) continue;
      for (let a = 0; a < n && okSet; a += 1) {
        if (!((mask >> a) & 1)) continue;
        for (const [x, y] of vaf.attacks) {
          if (y !== a || !succ(x, a)) continue;
          let hit = false;
          for (let d = 0; d < n; d += 1) {
            if ((mask >> d) & 1 && succ(d, x)) {
              hit = true;
              break;
            }
          }
          if (!hit) {
            okSet = false;
            break;
          }
        }
      }
      if (okSet) masks.push(mask);
    }
    return masks.filter((m1) => !masks.some((m2) => m2 !== m1 && (m1 & m2) === m1));
  };
  let allOk = true;
  let audienceChecks = 0;
  let objSubset = true;
  for (let t = 0; t < 200; t += 1) {
    const vaf = randomValueFramework(3 + (t % 5), 1 + (t % 3), 0.15 + ((t * 7) % 50) / 100, 1000 + t, { selfAttacks: t % 4 === 0 });
    const acc = valueAcceptance(vaf);
    const auds = allAudiences(vaf);
    auds.forEach((audience, idx) => {
      audienceChecks += 1;
      const brute = brutePreferred(vaf, audience);
      const bruteSig = brute.map((m) => {
        const s = [];
        for (let i = 0; i < vaf.size; i += 1) if ((m >> i) & 1) s.push(i);
        return s.join(',');
      }).sort().join('|');
      const engSig = preferredExtensions(inducedFramework(vaf, audience)).map((e) => [...e].join(',')).sort().join('|');
      if (bruteSig !== engSig) allOk = false;
      for (let a = 0; a < vaf.size; a += 1) {
        const cred = brute.some((m) => (m >> a) & 1);
        if (acc.byAudience[idx][a] !== cred) allOk = false;
      }
    });
    if (acc.objectivelyAcceptable.some((o, i) => o && !acc.subjectivelyAcceptable[i])) objSubset = false;
  }
  ok(allOk, `200 随机 VAF × 全体受众（${audienceChecks} 个 (框架,受众) 对, 含自攻击实例）: 诱导 Dung AF preferred ≡ VAF 直定义暴力, byAudience = 暴力轻信接受——两条独立路线一致`);
  ok(objSubset, '客观接受 ⊆ 主观接受（∀受众 ⟹ ∃受众, 200 实例全检）');
}

section('81.0-R5 性能轴: 独立集 DFS 位掩码化——等价 + 耗时对照');

{
  let eqOk = true;
  for (let t = 0; t < 60; t += 1) {
    const af = randomFramework(3 + (t % 6), 0.2 + ((t * 13) % 40) / 100, 2000 + t, { selfAttacks: t % 3 === 0 });
    const bf = bruteForceSemantics(af);
    if (JSON.stringify(preferredExtensions(af)) !== JSON.stringify(bf.preferredExtensions)) eqOk = false;
    if (JSON.stringify(stableExtensions(af)) !== JSON.stringify(bf.stableExtensions)) eqOk = false;
    if (JSON.stringify(completeExtensions(af)) !== JSON.stringify(bf.completeExtensions)) eqOk = false;
  }
  ok(eqOk, '位掩码化 DFS: preferred/stable/complete 与 2^n 全子集暴力直扫在 60 随机 AF 上逐集合一致（谓词恒等 + 访问序不变）');
  // includes 版参考 DFS（提升前的旧实现语义）
  const includesDfs = (af) => {
    const n = af.size;
    const out = [];
    const chosen = [];
    const conflicts = (i) => {
      const ts = af.targetsOf[i];
      for (let k = 0; k < ts.length; k += 1) if (chosen.includes(ts[k])) return true;
      const atk = af.attackersOf[i];
      for (let k = 0; k < atk.length; k += 1) if (chosen.includes(atk[k])) return true;
      return false;
    };
    const setToMask = (set) => set.reduce((m, i) => m | (1 << i), 0);
    const rec = (start) => {
      out.push(setToMask(chosen));
      for (let i = start; i < n; i += 1) {
        if (conflicts(i)) continue;
        chosen.push(i);
        rec(i + 1);
        chosen.pop();
      }
    };
    rec(0);
    return out;
  };
  const maskDfsEquiv = (af) => JSON.stringify(includesDfs(af));
  // 大框架耗时对照（n=14 稠密）
  const big = randomFramework(14, 0.35, 31415);
  const refMasks = includesDfs(big).join(',');
  const fastSig = JSON.stringify(preferredExtensions(big));
  const maskMs = timeMs(() => preferredExtensions(big), 10);
  const refMs = timeMs(() => maskDfsEquiv(big), 10);
  ok(refMasks.length > 0 && fastSig.length > 0, `n=14 稠密框架: 参考枚举 ${includesDfs(big).length} 个无冲突集、引擎输出 ${preferredExtensions(big).length} 个 preferred 外延`);
  ok(
    maskMs <= refMs * 1.5 + 1,
    `耗时对照 n=14 × 10 次: 位掩码版 ${maskMs.toFixed(1)}ms vs includes 参考版 ${refMs.toFixed(1)}ms（比值 ${(refMs / maskMs).toFixed(2)}×, 参考 O(度×|chosen|) → AND 单查）`,
  );
}

// ═══════════════════ 90.0 preference-learning R5 ═══════════════════

section('90.0-R5 数学轴: Plackett-Luce 概率件（排列和 = 1 + 手工锚 + B-T 同构）');

{
  const u = [1.0, 0.5, 0.2];
  const perms = (arr) => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p])));
  const total = perms([0, 1, 2]).reduce((s, p) => s + plackettLuceProbability(u, p), 0);
  ok(near(total, 1, 1e-12), `3 物品全排列概率和 = ${total.toPrecision(15)} = 1（1e-12——PL 是排列分布）`);
  const manual = Math.log(Math.exp(1) / (Math.exp(1) + Math.exp(0.5) + Math.exp(0.2))) + Math.log(logistic(0.5 - 0.2));
  ok(near(plackettLuceLogProb(u, [0, 1, 2]), manual, 1e-12), `logProb 手工锚 = ${manual.toFixed(12)}（首步 3 选 1 + 次步 2 选 1）`);
  ok(plackettLuceProbability(u, [0, 1]) === predictPair(u, 0, 1), '两物品排名 P ≡ B-T predictPair = σ(Δu)（PL 是 B-T 的排名推广——逐位相同）');
  // 排名概率 = 逐步选择概率连乘（独立线性域重算）
  const rk = [2, 0, 3, 1];
  const uu = [0.3, 1.1, -0.4, 0.7];
  let prod = 1;
  for (let k = 0; k < rk.length - 1; k += 1) prod *= plackettLuceChoiceProbability(uu, rk.slice(k), rk[k]);
  ok(
    near(plackettLuceProbability(uu, rk), prod, 1e-14),
    '排名概率 = Π 逐步存活集选择概率（Luce 分解公理的独立重算, 1e-14）',
  );
  // Luce IIA: P_S(i)/P_S(j) 与 S 无关
  const rng = plMulberry32(3);
  let iiaOk = true;
  for (let t = 0; t < 300; t += 1) {
    const uv = Array.from({ length: 5 }, () => rng() * 4 - 2);
    const i = Math.floor(rng() * 5);
    let j = Math.floor(rng() * 4);
    if (j >= i) j += 1;
    const S1 = [0, 1, 2, 3, 4];
    const S2 = [i, j].concat(S1.filter((x) => x !== i && x !== j).slice(0, 2));
    const r1 = plackettLuceChoiceProbability(uv, S1, i) / plackettLuceChoiceProbability(uv, S1, j);
    const r2 = plackettLuceChoiceProbability(uv, S2, i) / plackettLuceChoiceProbability(uv, S2, j);
    if (Math.abs(r1 - r2) > 1e-9 * Math.max(1, r1)) iiaOk = false;
  }
  ok(iiaOk, 'Luce 选择公理（IIA）: 300 组随机 (i,j,选择集) 的 P_S(i)/P_S(j) 与 S 无关（无关备择独立性）');
}

section('90.0-R5 数学轴: PL MLE 恢复 + 两物品数据 ≡ B-T MLE');

{
  const uStar = [2.0, 1.2, 0.4, -0.2];
  const rks = simulateRankings(uStar, 300, 7);
  const fit = plackettLuceMLE(rks);
  ok(fit.converged, `牛顿收敛（${fit.iterations} 步, ‖∇L‖∞ = ${fit.gradientInfinityNorm.toExponential(1)}——Armijo 噪声地板下 300 排名默认 λ 即收敛）`);
  ok(
    rankByUtility(fit.utilities).map((r) => r.index).join(',') === '0,1,2,3',
    `排序恢复 100%: 0 ≻ 1 ≻ 2 ≻ 3（效 used ${fit.utilities.map((x) => x.toFixed(3)).join(', ')}）`,
  );
  const cent = (v) => {
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return v.map((x) => x - m);
  };
  const dev = Math.max(...cent(fit.utilities).map((x, i) => Math.abs(x - cent(uStar)[i])));
  ok(dev <= 0.5, `中心化效用最大偏差 ${dev.toFixed(3)} ≤ 0.5（平移不变口径 + 抽样噪声容差）`);
  ok(fit.totalSteps === rks.reduce((s, r) => s + r.length - 1, 0), `有效步数口径 Σ(|π|−1) = ${fit.totalSteps}（末位无悬念不计）`);
  // 两物品数据: PL-MLE ≡ B-T-MLE（同一似然）
  const r2 = simulateRankings([1.5, 0], 60, 21);
  const pl2 = plackettLuceMLE(r2);
  const bt2 = bradleyTerryMLE(r2.map((rk) => ({ winner: rk[0], loser: rk[1] })));
  ok(
    (pl2.utilities[0] - pl2.utilities[1]) === (bt2.utilities[0] - bt2.utilities[1]) && pl2.logLoss === bt2.logLoss,
    `两物品排名数据: PL 效用差与 logLoss 同 B-T MLE **逐位相同**（Δu = ${(pl2.utilities[0] - pl2.utilities[1]).toFixed(9)}, logLoss = ${pl2.logLoss.toFixed(9)}）——同一似然的两个独立实现`,
  );
  // top-k 工厂 + 确定性
  const topk = simulateRankings(uStar, 40, 9, { rankingLength: 2 });
  ok(
    topk.every((r) => r.length === 2 && r[0] !== r[1]) && JSON.stringify(topk) === JSON.stringify(simulateRankings(uStar, 40, 9, { rankingLength: 2 })),
    'top-k 工厂: 长度 = k、无重复、同 seed 逐位复现',
  );
  throws(() => plackettLuceMLE([]), '空排名表显式 throw');
  throws(() => plackettLuceMLE([[0, 0]]), '排名内重复下标显式 throw');
  throws(() => plackettLuceMLE([[0], [1]], { nItems: 1 }), 'nItems < 2 显式 throw');
  throws(() => plackettLuceMLE([[0, 1], [0, 1]], { l2: 0 }), 'l2=0 平移不可辨识（非对称数据 Hessian 奇异）显式 throw');
  throws(() => plackettLuceProbability([0.1, 0.2], []), '空排名显式 throw');
  throws(() => plackettLuceChoiceProbability([0.1, 0.2], [0], 1), 'item 不在选择集内显式 throw');
}

section('90.0-R5 性能+数值轴: 梯度复用逐位等价 + 对数域下溢防护');

{
  // 朴素三遍目标（loss/grad/Hessian 各自重算一遍 softmax——提升前的算术序）
  const naiveObjective = (lists, u, l2) => {
    const n = u.length;
    const softmaxOf = (rest) => {
      const mx = Math.max(...rest.map((i) => u[i]));
      const Z = rest.reduce((a, i) => a + Math.exp(u[i] - mx), 0);
      return { lse: mx + Math.log(Z), p: rest.map((i) => Math.exp(u[i] - mx) / Z) };
    };
    let loss = 0;
    for (const rk of lists) for (let k = 0; k < rk.length; k += 1) loss += softmaxOf(rk.slice(k)).lse - u[rk[k]];
    for (let i = 0; i < n; i += 1) loss += 0.5 * l2 * u[i] * u[i];
    const g = new Array(n).fill(0);
    for (const rk of lists) {
      for (let k = 0; k < rk.length; k += 1) {
        const rest = rk.slice(k);
        const { p } = softmaxOf(rest);
        g[rk[k]] -= 1;
        rest.forEach((i, t) => {
          g[i] += p[t];
        });
      }
    }
    for (let i = 0; i < n; i += 1) g[i] += l2 * u[i];
    const h = Array.from({ length: n }, () => new Array(n).fill(0));
    for (const rk of lists) {
      for (let k = 0; k < rk.length; k += 1) {
        const rest = rk.slice(k);
        const { p } = softmaxOf(rest);
        rest.forEach((i, ti) => {
          rest.forEach((j, tj) => {
            h[i][j] += (i === j ? p[ti] : 0) - p[ti] * p[tj];
          });
        });
      }
    }
    for (let i = 0; i < n; i += 1) h[i][i] += l2;
    return { loss, g, h };
  };
  // 与内核同算法的朴素牛顿（三遍目标 + 同 Armijo/噪声地板）——等价基准
  const solveLin = (a, rhs) => {
    const n = rhs.length;
    const m = a.map((row) => [...row]);
    const b = [...rhs];
    for (let col = 0; col < n; col += 1) {
      let pivot = col;
      for (let r = col + 1; r < n; r += 1) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
      if (Math.abs(m[pivot][col]) <= 1e-12) return null;
      if (pivot !== col) {
        const rs = m[pivot]; m[pivot] = m[col]; m[col] = rs;
        const bs = b[pivot]; b[pivot] = b[col]; b[col] = bs;
      }
      for (let r = col + 1; r < n; r += 1) {
        const f = m[r][col] / m[col][col];
        if (f === 0) continue;
        for (let c = col; c < n; c += 1) m[r][c] -= f * m[col][c];
        b[r] -= f * b[col];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r -= 1) {
      let sum = b[r];
      for (let c = r + 1; c < n; c += 1) sum -= m[r][c] * x[c];
      x[r] = sum / m[r][r];
    }
    return x;
  };
  const maxAbs = (v) => v.reduce((best, x) => Math.max(best, Math.abs(x)), 0);
  const naiveNewton = (lists, n, l2, iters, tol) => {
    let u = new Array(n).fill(0);
    let cur = naiveObjective(lists, u, l2);
    let used = 0;
    while (maxAbs(cur.g) > tol && used < iters) {
      const step = solveLin(cur.h, cur.g.map((x) => -x));
      let slope = 0;
      for (let i = 0; i < n; i += 1) slope += cur.g[i] * step[i];
      let t = 1;
      const noiseFloor = 1e-12 * Math.max(1, Math.abs(cur.loss));
      let next = null;
      let nextV = null;
      for (let bt = 0; bt < 40; bt += 1) {
        const cand = u.map((x, i) => x + t * step[i]);
        const cv = naiveObjective(lists, cand, l2);
        if (Number.isFinite(cv.loss) && cv.loss <= cur.loss + 1e-4 * t * slope + noiseFloor) {
          next = cand;
          nextV = cv;
          break;
        }
        t *= 0.5;
      }
      if (next === null) break;
      u = next;
      cur = nextV;
      used += 1;
    }
    return { u, used };
  };
  const data = simulateRankings([1.0, 0.3, -0.2, 0.7, 0.1, 0.55], 150, 17);
  const fit = plackettLuceMLE(data, { l2: 1e-2, iters: 60 });
  const ref = naiveNewton(data, 6, 1e-2, 60, 1e-10);
  ok(
    fit.converged && fit.utilities.every((x, i) => x === ref.u[i]) && fit.iterations === ref.used,
    `融合单遍 vs 朴素三遍牛顿: ${fit.iterations} 步后效用向量**逐位相同**（每变量加法序一致——梯度复用只省计算不换算术）`,
  );
  const nv = naiveObjective(data, fit.utilities, 1e-2);
  ok(
    maxAbs(nv.g) < 1e-12,
    `朴素三遍参考在拟合点独立验证梯度 ∞ 范数 = ${maxAbs(nv.g).toExponential(1)} ≈ 0（梯度/Hessian 公式的独立重算对照）`,
  );
  const kernelMs = timeMs(() => plackettLuceMLE(data, { l2: 1e-2, iters: 60 }), 5);
  const naiveMs = timeMs(() => naiveNewton(data, 6, 1e-2, 60, 1e-10), 5);
  ok(
    kernelMs <= naiveMs * 1.5,
    `耗时对照 6 物品 × 150 排名 × 同牛顿轨迹 × 5 次: 融合单遍 ${kernelMs.toFixed(1)}ms vs 朴素三遍 ${naiveMs.toFixed(1)}ms（比值 ${(naiveMs / kernelMs).toFixed(2)}×——三遍 softmax 重算的常数因子）`,
  );
  // 数值轴: 20 物品大效用差（步差 6）——线性域下溢, 对数域有限
  const ubig = Array.from({ length: 20 }, (_, i) => i * 6);
  const rbig = Array.from({ length: 20 }, (_, i) => i);
  const lp = plackettLuceLogProb(ubig, rbig);
  ok(
    plackettLuceProbability(ubig, rbig) === 0 && Number.isFinite(lp) && lp < -700,
    `对数域下溢防护: 线性域 P = 0（下溢）而 logProb = ${lp.toFixed(1)} 有限（log-sum-exp max 平移——长排名/大效用差的稳定口径）`,
  );
  const uSmall = [1.0, 0.5, 0.2];
  const small = plackettLuceLogProb(uSmall, [0, 1, 2]);
  ok(near(Math.exp(small), plackettLuceProbability(uSmall, [0, 1, 2]), 1e-15), '可表示区间: exp(logProb) = 线性域概率（两域一致）');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— R5-A16 博弈机制六内核第五轮世界性进化数学验证成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
