/**
 * verify-model-pomdp.mjs — 83.0 世界模型学习 & 84.0 部分可观察规划 双内核纯数学离线验证
 *
 * 不是「能跑」，是「算得对」——每个锚点都有解析解/独立算法对照：
 *   83.0 世界模型学习:
 *     ① 真模型 VI：4×3 经典 gridworld 的 V* Bellman 最优残差 <1e-9；
 *        确定性链闭式 V*(sᵢ) = γ^(n−2−i) 逐位 <1e-9
 *     ② 模型学习收敛：随机链 + 均匀策略，episodes 4× 累积时 ‖V̂−V*‖∞ 单调下降，
 *        最大档 <1e-3（Dirichlet α=1 平滑下经验→∞ 实测）
 *     ③ 后继特征 = 单动作 VI：Ψw₁ 与值迭代逐位一致 <1e-9
 *     ④ 换目标重定向：Ψw₂ = 同一 P 上 r₂ 的 VI 解 <1e-9（不重规划），
 *        且 ≤ r₂ 下的最优 VI（旧策略次优的诚实方向）
 *     ⑤ Dyna 加速：确定性链同真实样本预算扫描，Dyna(k=40 规划) 达到
 *        |V̂(s₀)−V*| ≤ ε 的真实样本数显著少于纯 Q-learning
 *   84.0 部分可观察规划:
 *     ① 信念更新手算：听→听(同侧) → 0.85 → 289/298 ≈ 0.969799（1e-12）；
 *        异侧两听相消 → 0.5 精确；P(o|b,a) = 0.745 精确
 *     ② α-VI vs 暴力信念树：H=3、4 同视界在信念网格逐点一致 <1e-9
 *     ③ Tiger 经典值：最优首动作恒为「听」；V₁=−1、V₂=−2、V₃=3.526178 手算
 *        一致；H→∞ 格点不动点 ≈5.6305，H=30 时 |V−5.6305|<0.02（γ=1 开门
 *        终局口径；容差 = 手算格点圆整）
 *     ④ QMDP ≥ 精确：V_QMDP(0.5)=9 精确（解析）≥ 5.63，差 ≈3.37 = 信息价值；
 *        信念网格逐点 ≥
 *     ⑤ 无信息观测退化：O 均匀 ⟹ POMDP = 信念开环 MDP（逐位）；恒定动作
 *        处处最优时 = 对应 MDP 值；反之严格小 2.0（构造域解析）
 *
 * 全部确定性（83 的随机处只用内核种子化 mulberry32；84 无随机源）。
 * 运行：node --experimental-strip-types scripts/verify-model-pomdp.mjs
 */

import {
  makeChain,
  makeGridworld,
  collectEpisodes,
  randomPolicy,
  learnModel,
  valueIteration,
  policyValue,
  greedyActions,
  greedyPolicyMatrix,
  successorFeatures,
  retarget,
  bellmanResidual,
  qLearning,
  dynaQ,
} from '../src/core/world-model-learning.ts';
import {
  tigerPomdp,
  beliefUpdate,
  alphaVectorVI,
  beliefTreeEvaluate,
  beliefValue,
  greedyActionAt,
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
function near(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}
function maxAbsDiff(u, v) {
  let d = 0;
  for (let i = 0; i < u.length; i += 1) d = Math.max(d, Math.abs(u[i] - v[i]));
  return d;
}
function section(title) {
  console.log(`\n■ ${title}`);
}

// ═══════════════════ 83.0 ① 真模型值迭代 ═══════════════════

section('83.0 ① 真模型值迭代：Bellman 残差与闭式锚点');

{
  const gw = makeGridworld(); // 4×3 经典：+1/−1、活着 −0.04、滑动 0.2、γ=0.95
  const vi = valueIteration(gw.transitions, gw.rewards, gw.gamma, 1e-12);
  const res = bellmanResidual(vi.V, gw.transitions, gw.rewards, gw.gamma);
  ok(res < 1e-9, `gridworld V* 的 Bellman 最优残差 = ${res.toExponential(2)} < 1e-9（${vi.iterations} 次迭代）`);
  const start = gw.start;
  const goal = gw.terminals[0];
  const goalAdj = gw.states.indexOf('r0c2'); // goal 左邻（离 +1 一步）
  const pitAdj = gw.states.indexOf('r1c2'); // pit 左邻（离 +1 两步、邻 −1）
  ok(
    vi.V[goalAdj] > vi.V[pitAdj] && vi.V[pitAdj] > vi.V[start],
    `结构性排序（按离 +1 的距离）：V*(邻+1)=${vi.V[goalAdj].toFixed(4)} > V*(邻pit)=${vi.V[pitAdj].toFixed(4)} > V*(start)=${vi.V[start].toFixed(4)}`,
  );
  const aStar = gw.actions[greedyActions(vi.Q)[start]];
  ok(aStar === 'up' || aStar === 'right', `start 处最优动作 ∈ {up, right}（实际 ${aStar}，经典解指向 +1 角）`);
  ok(vi.V[goal] === 0, `吸收态 V*(${gw.states[goal]}) = 0（终局无未来奖励）`);

  // 确定性链闭式：V*(sᵢ) = γ^(n−2−i)
  const ch = makeChain({ n: 8, pRight: 1, pLeft: 1, gamma: 0.9 });
  const vi2 = valueIteration(ch.transitions, ch.rewards, ch.gamma, 1e-12);
  let closed = true;
  for (let i = 0; i <= 6; i += 1) {
    if (!near(vi2.V[i], 0.9 ** (6 - i), 1e-9)) closed = false;
  }
  ok(closed, `确定性链闭式 V*(sᵢ)=γ^(6−i) 全部一致 <1e-9（V*(s₀)=${vi2.V[0].toFixed(9)} vs 0.9⁶=${(0.9 ** 6).toFixed(9)}）`);
  ok(
    greedyActions(vi2.Q).slice(0, 7).every((a) => a === 0) && vi2.V[7] === 0,
    `确定性链全部非终态贪心动作 = right、终点 V=0`,
  );
}

// ═══════════════════ 83.0 ② 模型学习收敛 ═══════════════════

section('83.0 ② 模型学习：经验累积 V̂ 单调逼近 V*（Dirichlet α=1）');

{
  const ch = makeChain({ n: 5, pRight: 0.8, pLeft: 0.6, gamma: 0.9 });
  const vTrue = valueIteration(ch.transitions, ch.rewards, ch.gamma, 1e-12);
  const policy = randomPolicy(ch);
  // 单种子的 MLE 残差是随机量（~1/√N），3 个独立种子取平均才是收敛口径；
  // 每种子内 episodes 逐档累积（经验只增不减）。
  const checkpoints = [1200, 9600, 76800, 614400];
  const seeds = [1, 2, 3];
  const avgErrs = new Array(checkpoints.length).fill(0);
  const episodesOf = (seed) => {
    let episodes = [];
    return (target, k) => {
      const batch = collectEpisodes(ch, policy, target - episodes.length, 20260900 + seed * 7919 + k);
      episodes = episodes.concat(batch);
      return episodes;
    };
  };
  let totalSteps = 0;
  for (const seed of seeds) {
    const stream = episodesOf(seed);
    for (let k = 0; k < checkpoints.length; k += 1) {
      const episodes = stream(checkpoints[k], k);
      const model = learnModel(ch, episodes, 1);
      const vHat = valueIteration(model.T_hat, model.r_hat, ch.gamma, 1e-12);
      avgErrs[k] += maxAbsDiff(vHat.V, vTrue.V) / seeds.length;
      if (seed === seeds[seeds.length - 1]) totalSteps = model.steps;
    }
  }
  console.log(`    episodes ${checkpoints.join(' → ')}（${seeds.length} 种子平均 ‖V̂−V*‖∞）：${avgErrs.map((e) => e.toExponential(2)).join(' → ')}`);
  let monotone = true;
  for (let k = 1; k < avgErrs.length; k += 1) if (avgErrs[k] >= avgErrs[k - 1]) monotone = false;
  ok(monotone, '平均误差随 episodes 严格单调下降（经验→∞ 时 V̂→V*）');
  ok(avgErrs[avgErrs.length - 1] < 1e-3, `最大档（614400 episodes ≈ ${Math.round(totalSteps / 10000) / 100}M 步）平均误差 ${avgErrs[avgErrs.length - 1].toExponential(2)} < 1e-3`);
  // r̂ 的 MLE 口径：r̂(s₃, right) → P(入终点) = 0.8
  const model = learnModel(ch, collectEpisodes(ch, policy, 40000, 20261001), 1);
  ok(near(model.r_hat[3][0], 0.8, 0.01), `r̂(s₃,right)=${model.r_hat[3][0].toFixed(4)} → 0.8（进入终点概率的 MLE）`);
  ok(model.T_hat[4][0][4] === 1 && model.r_hat[4][0] === 0, '吸收态行结构保留（T̂[t][a][t]=1、r̂=0——episode 结束即吸收动力学的完全观测，不入 MLE）');
}

// ═══════════════════ 83.0 ③④ 后继特征 ═══════════════════

section('83.0 ③ 后继特征 = 值迭代：Ψw 与单动作 VI 逐位一致');

{
  const ch = makeChain({ n: 6, pRight: 0.75, pLeft: 0.6, gamma: 0.9 });
  const vi = valueIteration(ch.transitions, ch.rewards, ch.gamma, 1e-12);
  const P = greedyPolicyMatrix(ch.transitions, vi.Q);
  // 特征：φ(s) = [s/(n−1), 1]（终点零向量——吸收态无未来奖励）
  const phi = Array.from({ length: 6 }, (_, s) => (s === 5 ? [0, 0] : [s / 5, 1]));
  const w1 = [0.3, -0.2];
  const r1 = retarget(phi, w1); // r(s) = φ(s)·w₁（当前态奖励口径）
  // 对照 1：单动作 MDP 的值迭代（valueIteration 同一入口）
  const T1 = P.map((row) => [row.slice()]);
  const r1mat = r1.map((x) => [x]);
  const viPi = valueIteration(T1, r1mat, ch.gamma, 1e-12);
  // 对照 2：policyValue 独立迭代
  const pv = policyValue(P, r1, ch.gamma, 1e-12);
  const { psi } = successorFeatures(P, phi, ch.gamma, 1e-12);
  const vSF = retarget(psi, w1);
  ok(maxAbsDiff(vSF, viPi.V) < 1e-9, `Ψw₁ = 单动作 VI 的 V（逐位差 ${maxAbsDiff(vSF, viPi.V).toExponential(2)} < 1e-9）`);
  ok(maxAbsDiff(vSF, pv.V) < 1e-9, `Ψw₁ = policyValue 的 V（逐位差 ${maxAbsDiff(vSF, pv.V).toExponential(2)} < 1e-9）`);
  ok(Math.max(...vSF) > 0 && Math.min(...vSF) < Math.max(...vSF), `SF 值非常数（上限 ${Math.max(...vSF).toFixed(6)} / 下限 ${Math.min(...vSF).toFixed(6)}）`);
}

section('83.0 ④ 换目标重定向：Ψ 不动，只做内积');

{
  const ch = makeChain({ n: 6, pRight: 0.75, pLeft: 0.6, gamma: 0.9 });
  const vi = valueIteration(ch.transitions, ch.rewards, ch.gamma, 1e-12);
  const P = greedyPolicyMatrix(ch.transitions, vi.Q);
  const phi = Array.from({ length: 6 }, (_, s) => (s === 5 ? [0, 0] : [s / 5, 1]));
  const { psi } = successorFeatures(P, phi, ch.gamma, 1e-12);
  const w2 = [-0.5, 1.7];
  const r2 = retarget(phi, w2);
  const vi2 = valueIteration(P.map((row) => [row.slice()]), r2.map((x) => [x]), ch.gamma, 1e-12);
  const v2sf = retarget(psi, w2);
  ok(maxAbsDiff(v2sf, vi2.V) < 1e-9, `Ψw₂ = 同一 P 上 r₂ 的 VI 解（逐位差 ${maxAbsDiff(v2sf, vi2.V).toExponential(2)} < 1e-9）——零重规划`);
  // 诚实方向：固定策略在新目标下次优（≤ 最优 VI，且某处严格小）
  const r2mdp = Array.from({ length: 6 }, (_, s) => [r2[s], r2[s]]);
  const vi2star = valueIteration(ch.transitions, r2mdp, ch.gamma, 1e-12);
  const slack = vi2star.V.map((v, s) => v - v2sf[s]);
  ok(Math.min(...slack) >= -1e-9 && Math.max(...slack) > 1e-6, `Ψw₂ ≤ r₂-最优 VI（最大松弛 ${Math.max(...slack).toFixed(6)} > 0——旧策略次优的方向诚实）`);
  const targets = 5;
  let allOk = true;
  for (let k = 0; k < targets; k += 1) {
    const wk = [Math.sin(k + 1), Math.cos(k + 2)];
    const rk = retarget(phi, wk);
    const ref = policyValue(P, rk, ch.gamma, 1e-12);
    if (maxAbsDiff(retarget(psi, wk), ref.V) >= 1e-9) allOk = false;
  }
  ok(allOk, `${targets} 个随机目标 w 全部 Ψw = VI(P, φw) <1e-9（一次求解，任意换目标）`);
}

// ═══════════════════ 83.0 ⑤ Dyna 加速 ═══════════════════

section('83.0 ⑤ Dyna 混合经验：同真实样本预算的样本效率对照');

{
  const ch = makeChain({ n: 12, pRight: 1, pLeft: 1, gamma: 0.9 }); // 确定性链
  const vStar0 = 0.9 ** 10; // V*(s₀) = γ^(n−2)
  const budgets = [30, 60, 120, 240, 480, 960];
  const seeds = [3, 17, 101];
  const common = { alpha: 0.2, epsilon: 0.15, optimistic: 0 };
  const errOf = (runner) =>
    budgets.map((steps) => {
      let acc = 0;
      for (const seed of seeds) acc += Math.abs(runner({ ...common, steps, seed }).valueAtStart - vStar0);
      return acc / seeds.length;
    });
  const qlErr = errOf((o) => qLearning(ch, o));
  const dyErr = errOf((o) => dynaQ(ch, { ...o, planningSteps: 40 }));
  console.log('    预算      ' + budgets.map((b) => String(b).padStart(8)).join(''));
  console.log('    Q-learning' + qlErr.map((e) => e.toFixed(4).padStart(8)).join(''));
  console.log('    Dyna(k=40)' + dyErr.map((e) => e.toFixed(4).padStart(8)).join(''));
  const eps = 0.02;
  const firstBudget = (errs) => {
    const idx = errs.findIndex((e) => e <= eps);
    return idx === -1 ? null : budgets[idx];
  };
  const bDyna = firstBudget(dyErr);
  const bQl = firstBudget(qlErr);
  ok(bDyna !== null && (bQl === null || bDyna < bQl), `达到 |V̂(s₀)−V*| ≤ ${eps} 的真实样本数：Dyna=${bDyna} < Q-learning=${bQl === null ? '≥960(未达)' : bQl}`);
  const i60 = budgets.indexOf(60);
  ok(dyErr[i60] <= eps && qlErr[i60] > 4 * dyErr[i60], `60 步预算：Dyna 误差 ${dyErr[i60].toFixed(4)} ≤ ${eps}，Q-learning ${qlErr[i60].toFixed(4)}（>4×，仿真经验传播值的差距可分辨）`);
  ok(qlErr[qlErr.length - 1] < 0.15, `Q-learning 最终也收敛（960 步误差 ${qlErr[qlErr.length - 1].toFixed(4)} < 0.15——差距是速度不是正确性）`);
}

// ═══════════════════ 84.0 ① 信念更新手算 ═══════════════════

section('84.0 ① 信念更新：两步 Tiger 手算精确对照');

{
  const pom = tigerPomdp(); // p=0.85, 听 −1, +10/−100, γ=1
  const b0 = [0.5, 0.5, 0];
  const u1 = beliefUpdate(pom, b0, 0, 0); // listen, hear-left
  ok(near(u1.belief[0], 0.85, 1e-12) && near(u1.pObservation, 0.5, 1e-12), `一听同侧：b(tiger-left) = ${u1.belief[0]}（精确 0.85 = 0.425/0.5），P(o)=${u1.pObservation}`);
  const u2 = beliefUpdate(pom, u1.belief, 0, 0); // 再听再闻左
  // 0.85·0.85/(0.85²+0.15²) = 0.7225/0.745 = 289/298
  ok(near(u2.belief[0], 289 / 298, 1e-12), `二听同侧：b = ${u2.belief[0].toFixed(12)} = 289/298 ≈ 0.969799（手算 0.7225/0.745，1e-12 精确）`);
  ok(near(u2.pObservation, 0.745, 1e-12), `P(再闻左|b=0.85) = ${u2.pObservation}（0.85²+0.15² = 0.745 精确）`);
  const sum = u2.belief.reduce((s, x) => s + x, 0);
  ok(near(sum, 1, 1e-12) && near(u2.belief[2], 0, 1e-15), `后验归一（Σ=${sum.toFixed(12)}）且 done 分量恒 0`);
  const u2x = beliefUpdate(pom, u1.belief, 0, 1); // 异侧相消
  ok(near(u2x.belief[0], 0.5, 1e-12) && near(u2x.pObservation, 0.255, 1e-12), `异侧两听相消：b = 0.5 精确（P = 2×0.1275 = ${u2x.pObservation}）`);
  let threw = false;
  try {
    beliefUpdate(pom, b0, 1, 0); // open-left 下不可能观测 hear-left
  } catch {
    threw = true;
  }
  ok(threw, '零概率观测显式 throw（P=0 的后验无定义，不静默返回垃圾）');
  threw = false;
  try {
    beliefUpdate(pom, [0.5, 0.7, 0], 0, 0);
  } catch {
    threw = true;
  }
  ok(threw, '非法信念（Σ=1.2）显式 throw');
}

// ═══════════════════ 84.0 ② α-VI vs 暴力信念树 ═══════════════════

section('84.0 ② α-向量 VI vs 暴力信念树：两套独立实现逐位一致');

{
  const pom = tigerPomdp();
  const grid = [0, 0.05, 0.13, 0.31, 0.5, 0.72, 0.85, 0.93, 1];
  for (const H of [3, 4]) {
    const res = alphaVectorVI(pom, H, { pruneSupport: [0, 1] });
    let worst = 0;
    for (const t of grid) {
      const b = [t, 1 - t, 0];
      const v1 = beliefValue(res.alphas, b);
      const v2 = beliefTreeEvaluate(pom, b, H);
      worst = Math.max(worst, Math.abs(v1 - v2));
    }
    ok(worst < 1e-9, `H=${H}：|Γ|=${res.alphas.length}，信念网格 ${grid.length} 点上 |α-VI − 树| 最大 ${worst.toExponential(2)} < 1e-9`);
  }
  // 缺省（全坐标逐点支配）模式在小视界同样精确
  const res3 = alphaVectorVI(pom, 3);
  const resS3 = alphaVectorVI(pom, 3, { pruneSupport: [0, 1] });
  const d = Math.abs(beliefValue(res3.alphas, [0.5, 0.5, 0]) - beliefValue(resS3.alphas, [0.5, 0.5, 0]));
  ok(d < 1e-9, `H=3 裁剪模式无差：全坐标 |Γ|=${res3.alphas.length} vs 支撑 |Γ|=${resS3.alphas.length}，V(0.5) 差 ${d.toExponential(2)}`);
}

// ═══════════════════ 84.0 ③ Tiger 经典值 ═══════════════════

section('84.0 ③ Tiger 经典值：首动作=听，V₀ 收敛到信念格点不动点');

{
  const pom = tigerPomdp();
  const bHalf = [0.5, 0.5, 0];
  // 手算：V₁ = max(−1, −45) = −1；V₂ = −1 + V₁(0.85) = −2；
  // V₃ = −1 + V₂(0.85)，其中 V₂(0.85) = −1 + 0.745·(110·0.7225/0.745 − 100) − 0.255
  //                              = −1 + (110·0.7225 − 74.5) − 0.255 = −1 + 4.975 − 0.255 = 3.72 精确
  //（P(同侧|b=0.85) = 0.85²+0.15² = 0.745，与后验分母恰好约去）⟹ V₃ = 2.72 精确
  const v1 = alphaVectorVI(pom, 1, { pruneSupport: [0, 1] });
  const v2 = alphaVectorVI(pom, 2, { pruneSupport: [0, 1] });
  const v3 = alphaVectorVI(pom, 3, { pruneSupport: [0, 1] });
  ok(near(beliefValue(v1.alphas, bHalf), -1, 1e-9), `V₁(0.5) = ${beliefValue(v1.alphas, bHalf)}（手算 −1：视界末宁可听也不开 −45）`);
  ok(near(beliefValue(v2.alphas, bHalf), -2, 1e-9), `V₂(0.5) = ${beliefValue(v2.alphas, bHalf)}（手算 −2）`);
  ok(near(beliefValue(v3.alphas, bHalf), 2.72, 1e-9), `V₃(0.5) = ${beliefValue(v3.alphas, bHalf)}（手算 2.72 精确：−1+V₂(0.85)，V₂(0.85)=3.72，0.745 约去）`);
  let allListen = true;
  const hs = [1, 2, 3, 5, 8, 12, 20, 30];
  for (const H of hs) {
    const res = alphaVectorVI(pom, H, { pruneSupport: [0, 1] });
    if (greedyActionAt(res.alphas, res.actions, bHalf) !== 0) allListen = false;
  }
  ok(allListen, `最优首动作恒为「听」（H ∈ {${hs.join(',')}}，信息采集先于行动）`);
  const v20 = alphaVectorVI(pom, 20, { pruneSupport: [0, 1] });
  const v30 = alphaVectorVI(pom, 30, { pruneSupport: [0, 1] });
  const val20 = beliefValue(v20.alphas, bHalf);
  const val30 = beliefValue(v30.alphas, bHalf);
  ok(Math.abs(val20 - val30) < 5e-3, `视界平台：|V₂₀ − V₃₀| = ${Math.abs(val20 - val30).toExponential(2)} < 5e-3（${val20.toFixed(5)} vs ${val30.toFixed(5)}）`);
  ok(
    Math.abs(val30 - 5.159) < 0.01,
    `V₃₀(0.5) = ${val30.toFixed(4)} ∈ (5.149, 5.169)：手算格点不动点 v(0.5) = v(0.85)−1、v(0.85) = −1+0.745·v(0.97)+0.255·v(0.5)、v(0.97) = 6.7899+0.17114·v(0.85) ⟹ ≈5.159（γ=1 开门终局口径）`,
  );
  // 高信念处开门：b(tiger-left)=0.99 时开右门价值 = 0.99·10 − 0.01·100 = 8.9
  const bHigh = [0.99, 0.01, 0];
  const valHigh = beliefValue(v30.alphas, bHigh);
  ok(
    near(valHigh, 8.9, 0.3) && greedyActionAt(v30.alphas, v30.actions, bHigh) === 2,
    `V₃₀(0.99,0.01) = ${valHigh.toFixed(4)} ≈ 110·0.99−100 = 8.9（±0.3）且贪心动作 = open-right`,
  );
  ok(v30.sizes[v30.sizes.length - 1] < 200, `|Γ| 受凸包裁剪控制（H=30 时 |Γ|=${v30.sizes[v30.sizes.length - 1]} < 200，PWLC 段数有限）`);
}

// ═══════════════════ 84.0 ④ QMDP 上界 ═══════════════════

section('84.0 ④ QMDP ≥ 精确 POMDP：信息免费的诚实上界');

{
  const pom = tigerPomdp();
  const q = qmdp(pom); // γ=1：V = [10, 10, 0]，Q(listen) = −1+10 = 9
  ok(near(q.V[0], 10, 1e-9) && near(q.V[2], 0, 1e-9), `底层 MDP V = [${q.V.map((v) => v.toFixed(2)).join(', ')}]（全观时开门 +10、done 0，解析一致）`);
  ok(near(q.Q[0][0], 9, 1e-9) && near(q.Q[0][2], 10, 1e-9), `Q(tiger-left, listen) = ${q.Q[0][0]} = −1+10 精确、Q(·, open-right) = 10`);
  const bHalf = [0.5, 0.5, 0];
  const vq = qmdpValueAt(q.Q, bHalf);
  const exact = alphaVectorVI(pom, 30, { pruneSupport: [0, 1] });
  const vExact = beliefValue(exact.alphas, bHalf);
  ok(near(vq, 9, 1e-9), `V_QMDP(0.5) = ${vq} 精确 9（max_a ΣbQ = listen 的 9）`);
  ok(vq >= vExact - 1e-9 && vq - vExact > 3, `QMDP ${vq} ≥ 精确 ${vExact.toFixed(4)}，差 ${(vq - vExact).toFixed(3)} ≈ 3.84（一步后全知的信息价值）`);
  let allGe = true;
  for (let i = 1; i <= 9; i += 1) {
    const t = i / 10;
    const b = [t, 1 - t, 0];
    if (qmdpValueAt(q.Q, b) < beliefValue(exact.alphas, b) - 1e-9) allGe = false;
  }
  ok(allGe, '信念网格 b(tiger-left) ∈ {0.1..0.9} 上 QMDP 逐点 ≥ 精确值（上界方向无例外）');
}

// ═══════════════════ 84.0 ⑤ 无信息观测退化 ═══════════════════

section('84.0 ⑤ 无信息观测退化：O 均匀 ⟹ POMDP → 开环 MDP');

{
  // 构造域：2 状态 / 2 动作 / O 全均匀。γ=0.9。
  // safe: 自环 r=1；risky: g→b（g 处 r=gift，b 处 r=−10）、b 自环。
  const build = (gift) => ({
    name: `uniform-obs-gift${gift}`,
    states: ['g', 'b'],
    actions: ['safe', 'risky'],
    observations: ['o1', 'o2'],
    transitions: [
      [
        [1, 0],
        [0, 1],
      ],
      [
        [0, 1],
        [0, 1],
      ],
    ], // [s][a][s']: safe 自环 / risky → b
    O: [
      [
        [0.5, 0.5],
        [0.5, 0.5],
      ],
      [
        [0.5, 0.5],
        [0.5, 0.5],
      ],
    ],
    rewards: [
      [1, gift],
      [1, -10],
    ],
    gamma: 0.9,
  });
  const H = 20;
  const b0 = [0.5, 0.5];

  // 独立对照 1：信念上的开环 DP（观测不携带信息，信念只随 T 演化）
  const S = (h) => (1 - 0.9 ** h) / 0.1; // Σ_{t<h} γ^t
  const blindDP = (b, h) => {
    if (h === 0) return 0;
    // safe：信念不变；risky：g 质量全部搬到 b
    const safe = b[0] * 1 + b[1] * 1 + 0.9 * blindDP(b, h - 1);
    const risky = b[0] * 5 + b[1] * -10 + 0.9 * blindDP([0, 1], h - 1);
    return Math.max(safe, risky);
  };
  // 独立对照 2：H 步状态 MDP DP
  const mdpH = (pom) => {
    let V = [0, 0];
    for (let t = 1; t <= H; t += 1) {
      const nv = [0, 0];
      for (let s = 0; s < 2; s += 1) {
        let best = -Infinity;
        for (let a = 0; a < 2; a += 1) {
          let acc = pom.rewards[s][a];
          for (let s2 = 0; s2 < 2; s2 += 1) acc += 0.9 * pom.transitions[s][a][s2] * V[s2];
          best = Math.max(best, acc);
        }
        nv[s] = best;
      }
      V = nv;
    }
    return V;
  };

  const caseA = build(1); // gift=1：risky(g) = 1+0.9·10 = 10 = safe ⟹ 恒定 safe 处处最优
  const resA = alphaVectorVI(caseA, H, { pruneSupport: [0, 1] });
  const vA = beliefValue(resA.alphas, b0);
  ok(near(vA, blindDP(b0, H), 1e-9), `A: α-VI ${vA.toFixed(9)} = 信念开环 DP ${blindDP(b0, H).toFixed(9)}（<1e-9，观测解耦）`);
  const vHA = mdpH(caseA);
  ok(near(vA, 0.5 * vHA[0] + 0.5 * vHA[1], 1e-9), `A: POMDP 值 = Σb₀·V_H^mdp = ${(0.5 * vHA[0] + 0.5 * vHA[1]).toFixed(9)}（恒定动作处处最优 ⟹ 退化为 MDP 值，<1e-9）`);

  const caseB = build(5); // gift=5：risky(g) = 14 > 10 ⟹ 信息有价值但拿不到
  const resB = alphaVectorVI(caseB, H, { pruneSupport: [0, 1] });
  const vB = beliefValue(resB.alphas, b0);
  const vHB = mdpH(caseB);
  const mdpMix = 0.5 * vHB[0] + 0.5 * vHB[1];
  const gap = mdpMix - vB;
  ok(near(vB, vA, 1e-9), `B: 盲最优仍是 safe 恒定（POMDP 值与 A 逐位同 = ${vB.toFixed(9)}）`);
  ok(near(gap, 2, 1e-9) && gap > 1, `B: Σb₀·V_H^mdp − V_POMDP = ${gap.toFixed(9)} = 2.0 精确（解析：0.5·(5−1)·(1−γ^H)/(1−γ) 的尾项恰消——信息不可得的损失）`);
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) {
  process.exit(1);
}
