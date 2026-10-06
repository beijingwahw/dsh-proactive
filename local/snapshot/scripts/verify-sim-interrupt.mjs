/**
 * verify-sim-interrupt.mjs — 94.0/95.0「仿真校准 + 中断交接」双内核纯数学离线验证
 *
 * 直接 import 两个内核源文件（node --experimental-strip-types 运行，
 * 不经 dist 构建）。每个断言都有解析解或独立重算对照：
 *
 *   94.0 仿真校准内核：
 *     - MMD²/能量距离解析总体对照：N(0,1) vs N(1,1) 的总体 MMD²
 *       （γ=1）= 2/√5·(1−e^{−1/5}) = 0.162148；能量距离 =
 *       2(E|N(1,2)| − 2/√π) = 0.541848（Φ(1/√2)=0.7602496 手算锚）；
 *       无偏 MMD² 在 sim=sim（同数组）时微负（|值| < 0.005，无偏性代价）
 *     - 域差单调性：位移 5 档 0→2，MMD² 与能量距离严格单调增
 *     - 密度比闭式对照：位移域差下分类器斜率 ŵ ≈ μ（总体精确解）；
 *       缩放域差下二次系数 ŵ₂ ≈ ½−1/(2σ²)；log r̂ 与闭式 log r 的
 *       Pearson 相关 > 0.95（文档化口径）
 *     - 再加权统计：再加权后仿真均值/方差 → 真实均值/方差（0.05 级容差），
 *       未加权均值对照偏差 > 0.5
 *     - calibrateSim：gapAfter < gapBefore/5（大幅缩小）+ 同输入逐位复现
 *     - 同分布退化：r ≈ 1、再加权统计 ≈ 裸统计（零伤害）
 *
 *   95.0 中断交接内核：
 *     - 对抗中断：无修正 Q-learning 学习值 V̂(start) 与贪婪策略真实价值
 *       均坍塌（与无中断最优 V*(0)=γ⁵/(1−γ) 的值差 > 5）；带离线修正
 *       收敛到未中断最优 Q*（max|Q̂−Q*| < 1e-2——核心断言：中断不再破坏学习）
 *       ——Q* 由脚本内独立值迭代重算（不调内核）
 *     - 交接阈值：闭式 τ* = c_H + c_delay 的总成本与枚举全部候选阈值的
 *       最优总成本一致（精确 1e-9）；均匀 c_auto 时 τ* / c_auto 概率口径
 *     - 三模式对照：分段场景 adaptive 总成本 < min(always-auto,
 *       always-human)（大幅严格不等）
 *     - 退化：P(error)→0 时 adaptive 交接数 = 错误数 = 总成本 = 0
 *     - 单调：交接次数随阈值 5 档扫描单调不增
 *
 * 全部断言确定性（两内核各自文件内 mulberry32 种子）。运行：
 *   node --experimental-strip-types scripts/verify-sim-interrupt.mjs
 */

import {
  mmd2,
  energyDistance,
  densityRatioClassifier,
  reweightedStatistic,
  calibrateSim,
  makeDomainGap,
} from '../src/core/simulation-calibration.ts';
import {
  makeRewardChain,
  alwaysInterruptSchedule,
  interruptedQLearning,
  takeoverThreshold,
  handoffPolicy,
  makePiecewiseHandoffWorld,
  simulateHandoff,
} from '../src/core/interruptible-autonomy.ts';

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
    console.error(`  ✗ ${label}（未抛出异常）`);
  } catch {
    passed += 1;
    console.log(`  ✓ ${label}`);
  }
}
function pearson(xs, ys) {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i += 1) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

// ═══════════════════ 94.0 仿真校准内核 ═══════════════════

section('94.0 MMD² / 能量距离：解析总体对照 + 无偏性诚实负值');

{
  // 解析总体值（γ=1、σ²=1）: MMD² = 2/√(1+4γ)·(1 − e^{−γΔ²/(1+4γ)})，
  // Δ=1 → 2/√5·(1−e^{−1/5}) = 0.1621479。无偏估计量单次抽样噪声 ~±0.012
  // （交叉核项的两样本涨落），按仓库惯例取 8 种子均值再对解析值断言
  const popMmd = (2 / Math.sqrt(5)) * (1 - Math.exp(-1 / 5));
  const anchorSeeds = [7, 13, 29, 41, 53, 67, 79, 97];
  const mmdEstimates = anchorSeeds.map((sd) => {
    const g = makeDomainGap({ shift: 1, seed: sd, nSim: 4000, nReal: 4000 });
    return mmd2(g.sim, g.real, { gamma: 1 });
  });
  const mmdMean = mmdEstimates.reduce((s, v) => s + v, 0) / mmdEstimates.length;
  ok(
    Math.abs(mmdMean - popMmd) < 0.02,
    `mmd2(N(0,1), N(1,1)) 8 种子均值 = ${mmdMean.toFixed(6)} ≈ 解析总体值 ${popMmd.toFixed(6)}（差 ${Math.abs(mmdMean - popMmd).toExponential(2)} < 0.02；单次抽样 ${mmdEstimates[0].toFixed(4)}）`,
  );
  // 无偏 U 统计量在零假设下期望 0、估计量可微负：同一数组对比差 ≈ −(1−Ek)/(m−1)
  const gap1 = makeDomainGap({ shift: 1, seed: 7, nSim: 4000, nReal: 4000 });
  const selfMmd = mmd2(gap1.sim, gap1.sim, { gamma: 1 });
  ok(
    Math.abs(selfMmd) < 0.005 && selfMmd < 0,
    `mmd2(sim, sim 同数组) = ${selfMmd.toExponential(3)}（微负——无偏估计量的诚实代价，|值| < 0.005）`,
  );
  // 能量距离解析值: E|N(m,2)| = (2/√π)·e^{−m²/4} + m·(2Φ(m/√2)−1)；
  // Δ=1 → ℰ = 2(E|N(1,2)| − 2/√π) = 0.5418480（Φ(1/√2) = 0.7602496）——8 种子均值
  const half = 2 / Math.sqrt(Math.PI);
  const eAbs12 = half * Math.exp(-0.25) + (2 * 0.7602496 - 1);
  const popEnergy = 2 * (eAbs12 - half);
  const energyMean =
    anchorSeeds.reduce((s, sd) => {
      const g = makeDomainGap({ shift: 1, seed: sd, nSim: 4000, nReal: 4000 });
      return s + energyDistance(g.sim, g.real);
    }, 0) / anchorSeeds.length;
  ok(
    Math.abs(energyMean - popEnergy) < 0.03,
    `energyDistance(N(0,1), N(1,1)) 8 种子均值 = ${energyMean.toFixed(6)} ≈ 解析总体值 ${popEnergy.toFixed(6)}（差 ${Math.abs(energyMean - popEnergy).toExponential(2)} < 0.03）`,
  );

  // 域差单调性：位移 5 档，MMD² 与能量距离严格单调增
  const shifts = [0, 0.5, 1.0, 1.5, 2.0];
  const gaps = shifts.map((s) => makeDomainGap({ shift: s, seed: 11, nSim: 2000, nReal: 2000 }));
  const mmdLadder = gaps.map((g) => mmd2(g.sim, g.real, { gamma: 1 }));
  const energyLadder = gaps.map((g) => energyDistance(g.sim, g.real));
  let mmdMono = true;
  let energyMono = true;
  for (let i = 1; i < shifts.length; i += 1) {
    if (!(mmdLadder[i] > mmdLadder[i - 1])) mmdMono = false;
    if (!(energyLadder[i] > energyLadder[i - 1])) energyMono = false;
  }
  ok(mmdMono, `MMD² 随位移单调增：${mmdLadder.map((v) => v.toFixed(4)).join(' < ')}`);
  ok(energyMono, `能量距离随位移单调增：${energyLadder.map((v) => v.toFixed(4)).join(' < ')}`);
}

section('94.0 密度比分类器：与闭式比对照（位移线性 / 缩放二次）');

{
  // 位移域差: log r(x) = μx − μ²/2 → 分类器斜率总体精确 = μ
  const shiftGap = makeDomainGap({ shift: 1.2, scale: 1, seed: 21, nSim: 4000, nReal: 4000 });
  const modelShift = densityRatioClassifier(shiftGap.sim, shiftGap.real);
  const logRhat = shiftGap.sim.map((x) => modelShift.logRatio(x));
  const logRstar = shiftGap.sim.map((x) => shiftGap.exactLogRatio(x));
  const corrShift = pearson(logRhat, logRstar);
  ok(
    corrShift > 0.95,
    `位移域差（μ=1.2）: log r̂ 与闭式 log r 的 Pearson 相关 = ${corrShift.toFixed(6)} > 0.95（文档化口径）`,
  );
  ok(
    Math.abs(modelShift.coefficients[0] - 1.2) <= 0.1 && Math.abs(modelShift.coefficients[1]) <= 0.05,
    `系数恢复：ŵ₁ = ${modelShift.coefficients[0].toFixed(4)} ≈ μ = 1.2（±0.1），ŵ₂ = ${modelShift.coefficients[1].toFixed(4)} ≈ 0（±0.05）`,
  );
  ok(modelShift.converged, `IRLS 收敛（${modelShift.iterations} 次迭代），训练准确率 = ${modelShift.accuracy.toFixed(4)}`);

  // 缩放域差: log r(x) = (½ − 1/(2σ²))·x² − ln σ → 二次系数总体精确
  const scaleGap = makeDomainGap({ shift: 0, scale: 1.5, seed: 22, nSim: 4000, nReal: 4000 });
  const modelScale = densityRatioClassifier(scaleGap.sim, scaleGap.real);
  const corrScale = pearson(
    scaleGap.sim.map((x) => modelScale.logRatio(x)),
    scaleGap.sim.map((x) => scaleGap.exactLogRatio(x)),
  );
  const w2star = 0.5 - 1 / (2 * 1.5 * 1.5);
  ok(
    corrScale > 0.95 && Math.abs(modelScale.coefficients[1] - w2star) <= 0.05,
    `缩放域差（σ=1.5）: 相关 = ${corrScale.toFixed(6)} > 0.95，ŵ₂ = ${modelScale.coefficients[1].toFixed(4)} ≈ ½−1/(2σ²) = ${w2star.toFixed(4)}（±0.05）`,
  );
}

section('94.0 再加权统计：仿真样本换算真实均值/方差');

{
  const gap = makeDomainGap({ shift: 0.75, scale: 1, seed: 31, nSim: 12000, nReal: 12000 });
  const model = densityRatioClassifier(gap.sim, gap.real);
  const plainMean = gap.sim.reduce((s, x) => s + x, 0) / gap.sim.length;
  const reMean = reweightedStatistic(gap.sim, (x) => model(x), (x) => x);
  const reVar = reweightedStatistic(gap.sim, (x) => model(x), (x) => (x - reMean) * (x - reMean));
  const realMean = gap.real.reduce((s, x) => s + x, 0) / gap.real.length;
  ok(
    Math.abs(plainMean) < 0.05 && Math.abs(plainMean - 0.75) > 0.5,
    `未加权仿真均值 = ${plainMean.toFixed(4)} ≈ 0（与真实均值 0.75 偏差 > 0.5——域差未修正的系统性偏差）`,
  );
  ok(
    Math.abs(reMean - 0.75) <= 0.05,
    `再加权后仿真均值 = ${reMean.toFixed(4)} → 真实均值 0.75（容差 0.05）`,
  );
  ok(
    Math.abs(reVar - 1) <= 0.05,
    `再加权后仿真方差 = ${reVar.toFixed(4)} → 真实方差 1（容差 0.05）`,
  );
  ok(
    Math.abs(realMean - 0.75) < 0.05,
    `真实样本均值自检 = ${realMean.toFixed(4)} ≈ 0.75（样本口径健康）`,
  );
}

section('94.0 calibrateSim：校准后残差 MMD 大幅缩小 + 逐位复现');

{
  const gap = makeDomainGap({ shift: 1, scale: 1, seed: 41, nSim: 6000, nReal: 6000 });
  const r1 = calibrateSim(gap.sim, gap.real);
  const r2 = calibrateSim(gap.sim, gap.real);
  ok(
    r1.gapAfter < r1.gapBefore / 5,
    `gapAfter = ${r1.gapAfter.toFixed(6)} < gapBefore/5 = ${(r1.gapBefore / 5).toFixed(6)}（gapBefore = ${r1.gapBefore.toFixed(6)}，缩减 ${(r1.reduction * 100).toFixed(1)}%）`,
  );
  ok(
    r1.reduction > 0.8 && r1.gapBefore > 0.1,
    `缩减比例 = ${r1.reduction.toFixed(4)} > 0.8（gapBefore > 0.1 确认域差显著）`,
  );
  ok(
    Math.abs(r1.reweightedMean - 1) <= 0.1 && Math.abs(r1.reweightedVar - 1) <= 0.1,
    `管线内再加权均值/方差 = ${r1.reweightedMean.toFixed(4)} / ${r1.reweightedVar.toFixed(4)} → 真实口径 1（±0.1）`,
  );
  ok(
    JSON.stringify(r1) === JSON.stringify(r2),
    `同输入逐位复现（两次 calibrateSim 输出 JSON 相同；ESS = ${r1.ess.toFixed(1)}/${r1.essFraction.toFixed(3)}）`,
  );
}

section('94.0 同分布退化：r ≈ 1、统计不变（零伤害）');

{
  const gap = makeDomainGap({ shift: 0, scale: 1, seed: 51, nSim: 2000, nReal: 2000 });
  const report = calibrateSim(gap.sim, gap.real);
  ok(
    report.ratioMean > 0.85 && report.ratioMean < 1.15,
    `同分布下比值均值 = ${report.ratioMean.toFixed(4)}（r ≈ 1，校准器不制造假域差）`,
  );
  ok(
    Math.abs(report.reweightedMean - report.plainMean) < 0.03 && Math.abs(report.reweightedVar / report.plainVar - 1) < 0.1,
    `再加权均值 = ${report.reweightedMean.toFixed(4)} ≈ 裸均值 ${report.plainMean.toFixed(4)}，再加权方差比 = ${(report.reweightedVar / report.plainVar).toFixed(4)} ≈ 1（零伤害）`,
  );
  ok(
    report.gapAfter <= report.gapBefore * 1.5 + 1e-6 && report.gapBefore < 0.02,
    `gapAfter = ${report.gapAfter.toFixed(6)} ≈ gapBefore = ${report.gapBefore.toFixed(6)}（同分布下加权不放大差异，且 gap 本身 ≈ 0）`,
  );

  throws(() => mmd2([1], [1, 2]), 'mmd2: 样本 < 2 抛出');
  throws(() => energyDistance([1, NaN, 2], [1, 2, 3]), 'energyDistance: 非有限样本抛出');
  throws(() => makeDomainGap({ scale: 0 }), 'makeDomainGap: scale = 0 抛出');
  throws(() => reweightedStatistic([1, 2, 3], () => 0, (x) => x), 'reweightedStatistic: 零权重抛出');
  throws(() => mmd2([1, 2], [1, 2], { gamma: -1 }), 'mmd2: γ ≤ 0 抛出');
}

// ═══════════════════ 95.0 中断交接内核 ═══════════════════

section('95.0 可中断学习：对抗中断下 无修正劣化 / 离线修正恢复最优');

{
  // ── 独立重算（不调内核）：奖励链 L=6、γ=0.95 的真值 ──
  // 动作 1=推进 / 0=后撤；奖励 = next=5 时 +1；V*(5) = 1/(1−γ) = 20，
  // V*(0) = γ⁴·20 = 16.290125（0..3 四次零奖赏推进后，第 5 次出发入账
  // 折扣 γ⁴——脚本内独立值迭代逐位核对）
  const L = 6;
  const GAMMA = 0.95;
  const nextOf = (s, a) => (a === 1 ? Math.min(s + 1, L - 1) : Math.max(s - 1, 0));
  const rewardOf = (_s, _a, nx) => (nx === L - 1 ? 1 : 0);
  const valueIteration = (policy) => {
    let v = new Array(L).fill(0);
    for (let it = 0; it < 20000; it += 1) {
      const nv = new Array(L).fill(0);
      let delta = 0;
      for (let s = 0; s < L; s += 1) {
        const a = policy === null ? null : policy[s];
        if (policy === null) {
          let best = -Infinity;
          for (let act = 0; act < 2; act += 1) {
            const nx = nextOf(s, act);
            best = Math.max(best, rewardOf(s, act, nx) + GAMMA * v[nx]);
          }
          nv[s] = best;
        } else {
          const nx = nextOf(s, a);
          nv[s] = rewardOf(s, a, nx) + GAMMA * v[nx];
        }
        delta = Math.max(delta, Math.abs(nv[s] - v[s]));
      }
      v = nv;
      if (delta < 1e-14) break;
    }
    return v;
  };
  const vStar = valueIteration(null);
  const qStar = Array.from({ length: L }, (_, s) =>
    Array.from({ length: 2 }, (_, a) => {
      const nx = nextOf(s, a);
      return rewardOf(s, a, nx) + GAMMA * vStar[nx];
    }),
  );
  const vStarAnalytic = Math.pow(GAMMA, L - 2) / (1 - GAMMA);
  ok(
    near(vStar[0], vStarAnalytic, 1e-9),
    `独立值迭代 V*(0) = ${vStar[0].toFixed(9)} = 解析值 γ⁴/(1−γ) = ${vStarAnalytic.toFixed(9)}（真值自证）`,
  );

  const world = makeRewardChain();
  const schedule = alwaysInterruptSchedule(world);
  ok(
    schedule.penalty === -2 && schedule.fires(5, 1, 5) && !schedule.fires(4, 1, 5),
    `对抗调度：penalty = ${schedule.penalty}，fires(高奖赏态 5) = true、fires(4) = false（抵达入账、驻留被搬走 + 受罚）`,
  );

  // 乐观初始化 initQ = r_max/(1−γ) = 20 驱动系统探索（悲观 0 初始化会在
  // 并列动作上原地打转）；α=1 = 精确异步 Bellman 备份（确定性转移）
  const runOpts = { world, interruptSchedule: schedule, episodes: 3000, seed: 7, epsilon: 0.2, alpha: 1, initQ: 20 };
  const naive = interruptedQLearning({ ...runOpts, correction: 'none' });
  const corrected = interruptedQLearning({ ...runOpts, correction: 'off-policy' });

  // 无修正：学习值与贪婪策略真实价值双双坍塌
  const vNaivePolicy = valueIteration(naive.greedy);
  ok(
    naive.valueAtStart < vStar[0] - 5,
    `无修正学习值 V̂(start) = ${naive.valueAtStart.toFixed(4)} ≪ V*(0) = ${vStar[0].toFixed(4)}（值差 ${(vStar[0] - naive.valueAtStart).toFixed(4)} > 5）`,
  );
  ok(
    vNaivePolicy[0] < vStar[0] - 5,
    `无修正贪婪策略在真实 MDP 的价值 = ${vNaivePolicy[0].toFixed(4)} < V*(0) − 5（策略劣化——学会了远避高奖赏区）`,
  );
  let naiveBias = 0;
  for (let s = 0; s < L; s += 1) {
    for (let a = 0; a < 2; a += 1) naiveBias = Math.max(naiveBias, Math.abs(naive.q[s][a] - qStar[s][a]));
  }
  ok(
    naiveBias > 0.5,
    `无修正 Q 表最大偏差 = ${naiveBias.toFixed(4)} > 0.5（Q*(5,·) = 20 vs 学到 ≈ −2——把操作者的手当成了环境动力学）`,
  );

  // 离线修正：收敛到未中断最优（核心断言）
  let correctedErr = 0;
  for (let s = 0; s < L; s += 1) {
    for (let a = 0; a < 2; a += 1) correctedErr = Math.max(correctedErr, Math.abs(corrected.q[s][a] - qStar[s][a]));
  }
  ok(
    correctedErr < 1e-2,
    `离线修正后 max|Q̂ − Q*| = ${correctedErr.toExponential(2)} < 1e-2（核心断言：中断不再破坏学习——修正更新 = 未中断 Bellman 备份）`,
  );
  ok(
    Math.abs(corrected.valueAtStart - vStar[0]) < 1e-2,
    `修正后 V̂(start) = ${corrected.valueAtStart.toFixed(6)} → V*(0) = ${vStar[0].toFixed(6)}（±1e-2）`,
  );
  ok(
    naive.interruptions > 300 && corrected.interruptions > 5000,
    `两口径数据流同受对抗中断（触发 ${naive.interruptions} / ${corrected.interruptions} 次——naive 学会后避开高奖赏区、corrected 持续冲击目标：中断对修正学习器只是数据流扰动）`,
  );  const rerun = interruptedQLearning({ ...runOpts, correction: 'off-policy' });
  ok(
    JSON.stringify(rerun.q) === JSON.stringify(corrected.q),
    `同种子逐位复现（seed = 7 的 Q 表两次运行 JSON 相同）`,
  );
}

section('95.0 交接阈值：闭式 τ* = c_H + c_delay 与枚举最优一致（精确）');

{
  const states = [0, 1, 2, 3, 4, 5];
  const pList = [0.01, 0.05, 0.2, 0.4, 0.6, 0.9];
  const cList = [10, 10, 4, 3, 2, 8];
  const costHandoff = 1.2; // c_H = 1 + 延迟 0.2
  const policy = takeoverThreshold(
    { pError: (s) => pList[s], costAuto: (s) => cList[s], costHuman: 1, delayCost: 0.2 },
    states,
  );
  ok(
    near(policy.threshold, 1.2, 1e-9),
    `闭式阈值 τ* = c_H + c_delay = ${policy.threshold}（期望成本最小化的闭式解）`,
  );
  // 枚举对照：对每个候选阈值 τ 计算总成本，取最优 —— 应与闭式策略逐位一致
  const scores = states.map((s) => pList[s] * cList[s]);
  let enumMin = Infinity;
  let enumBestTau = -Infinity;
  for (const tau of [-1, ...scores, policy.threshold, 1e9]) {
    let cost = 0;
    for (const x of scores) cost += x > tau ? costHandoff : x;
    if (cost < enumMin - 1e-12) {
      enumMin = cost;
      enumBestTau = tau;
    }
  }
  const kernelCost = states.reduce((s, st) => s + (policy.handoff(st) ? costHandoff : scores[st]), 0);
  ok(
    near(kernelCost, enumMin, 1e-9),
    `闭式策略总成本 = ${kernelCost.toFixed(6)} = 枚举最优 ${enumMin.toFixed(6)}（最优阈值 ${enumBestTau}；精确一致）`,
  );
  ok(
    states.every((s) => policy.handoff(s) === scores[s] > 1.2),
    `逐状态决策 = (p·c_auto > τ*)：${states.map((s) => `${scores[s].toFixed(1)}${policy.handoff(s) ? '→人' : '→自动'}`).join(' ')}`,
  );
  // 均匀 c_auto → 概率口径阈值 τ*/c_auto
  const uniform = takeoverThreshold({ pError: (s) => [0.05, 0.2, 0.5][s], costAuto: () => 10, costHuman: 1, delayCost: 0.2 }, [0, 1, 2]);
  ok(
    near(uniform.thresholdOnProbability, 0.12, 1e-9) && uniform.handoff(2) && uniform.handoff(1) && !uniform.handoff(0),
    `均匀 c_auto = 10 时概率口径阈值 = ${uniform.thresholdOnProbability} = 1.2/10（p = 0.05 自动、p = 0.2 与 0.5 交人）`,
  );
  ok(
    handoffPolicy(1.2, 1.2) === 'auto' && handoffPolicy(1.3, 1.2) === 'human' && handoffPolicy(0, 1.2) === 'auto',
    `handoffPolicy 并列约定：score = τ → 'auto'（成本无差不打扰人），score > τ → 'human'`,
  );
}

section('95.0 三模式对照：adaptive < min(always-auto, always-human)');

{
  const world = makePiecewiseHandoffWorld();
  const opts = { world, seeds: [1, 2, 3], stepsPerSeed: 200 };
  const auto = simulateHandoff({ ...opts, mode: 'always-auto' });
  const human = simulateHandoff({ ...opts, mode: 'always-human' });
  const adaptive = simulateHandoff({ ...opts, mode: 'adaptive' });
  ok(
    human.handoffs === 600 && auto.handoffs === 0 && adaptive.handoffs === 300,
    `交接次数：always-human = ${human.handoffs} / always-auto = ${auto.handoffs} / adaptive = ${adaptive.handoffs}（分段场景各取一半）`,
  );
  ok(
    auto.errors > 100 && adaptive.errors < 20,
    `自动执行错误：always-auto = ${auto.errors} 次 ≫ adaptive = ${adaptive.errors} 次（危险态交人止损）`,
  );
  ok(
    adaptive.totalCost < human.totalCost - 200 && adaptive.totalCost < auto.totalCost - 500,
    `总成本：adaptive = ${adaptive.totalCost} < always-human = ${human.totalCost} − 200 且 < always-auto = ${auto.totalCost} − 500（期望成本最优的实证）`,
  );
  ok(
    near(adaptive.thresholdUsed, world.costHuman, 1e-9),
    `adaptive 使用闭式阈值 τ* = world.costHuman = ${adaptive.thresholdUsed}（x(SAFE)=0.01 自动、x(RISKY)=5 交人）`,
  );
}

section('95.0 退化正确性与单调性');

{
  // P(error) → 0：adaptive 退化为全自动
  const zeroWorld = {
    name: 'zero-error',
    numStates: 2,
    startState: 0,
    costHuman: 1.1,
    next: (s) => (s === 0 ? 1 : 0),
    pError: () => 1e-12,
    costAuto: () => 10,
  };
  const z = simulateHandoff({ world: zeroWorld, mode: 'adaptive', seeds: [5], stepsPerSeed: 400 });
  ok(
    z.handoffs === 0 && z.errors === 0 && z.totalCost === 0,
    `P(error)→0 世界：adaptive 交接 = ${z.handoffs}、错误 = ${z.errors}、总成本 = ${z.totalCost}（退化为全自动）`,
  );
  // 交接次数随阈值单调不增
  const world = makePiecewiseHandoffWorld();
  const taus = [-1, 0.05, 1.1, 5.5, 1e9];
  const counts = taus.map((t) => simulateHandoff({ world, mode: 'adaptive', seeds: [1], stepsPerSeed: 400, threshold: t }).handoffs);
  let mono = true;
  for (let i = 1; i < counts.length; i += 1) if (counts[i] > counts[i - 1]) mono = false;
  ok(
    mono && counts[0] === 400 && counts[4] === 0,
    `交接次数随阈值单调不增：τ = [${taus.join(', ')}] → [${counts.join(', ')}]（τ → −1 全交人、τ → ∞ 全自动）`,
  );

  throws(
    () => interruptedQLearning({ world, interruptSchedule: alwaysInterruptSchedule(world), correction: 'bogus', episodes: 10, seed: 1 }),
    "interruptedQLearning: 非法 correction 抛出",
  );
  throws(
    () => interruptedQLearning({ world, interruptSchedule: alwaysInterruptSchedule(world), correction: 'none', episodes: 0, seed: 1 }),
    'interruptedQLearning: episodes = 0 抛出',
  );
  throws(() => takeoverThreshold({ pError: () => 1.5, costAuto: () => 1, costHuman: 1 }, [0]), 'takeoverThreshold: p ∉ [0,1] 抛出');
  throws(() => handoffPolicy(Number.NaN, 1), 'handoffPolicy: NaN score 抛出');
  throws(() => makeRewardChain({ length: 2 }), 'makeRewardChain: length = 2 抛出');
  throws(() => alwaysInterruptSchedule(world, { triggerStates: [] }), 'alwaysInterruptSchedule: 空触发态抛出');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL ${failed} —— 94.0/95.0 双内核数学验证成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
}
process.exitCode = failed === 0 ? 0 : 1;
