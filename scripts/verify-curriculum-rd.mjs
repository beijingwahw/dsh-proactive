/**
 * verify-curriculum-rd.mjs — 59.0/60.0「课程学习 + 率失真」双内核纯数学离线验证
 *
 * 直接 import 两个内核源文件（node --experimental-strip-types 运行，
 * 不经 dist 构建）。每个断言都有解析解或构造轨迹对照：
 *
 *   59.0 课程学习内核：
 *     - 学习者定律：σ(0)=0.5 精确；幂律强度 σ(1.6·4^0.7 − d) 手算锚；
 *       增益窗口倒 U 峰值 g(0.5)=1 精确；同种子逐位复现
 *     - 掌握门限状态机：12 步构造轨迹逐层对照（晋升连击 + 后验门限
 *       双条件、防运气晋升、防挫折降级、顶/底钳位）
 *     - 三策略 200 种子：达到顶层试验数中位数（删失口径）
 *       课程 34 < Thompson 44 < 随机 54 < 最难 400；配对胜率
 *       课程>随机 ≥ 0.85、随机>最难 ≥ 0.95
 *     - 困死率（cap=100 收紧预算）：课程 0 < 随机 0.025 < 最难 1
 *     - 墙世界（非单调难度 [0,1.7,3.4,14,5.1,6.8]）：Thompson 100 种子
 *       全达顶层（中位 ≈38），固定阶梯 100% 困死在墙下
 *
 *   60.0 率失真内核：
 *     - 解析锚：高斯 σ²=1, D=0.5 → R=0.5 bit 精确；二值 Hamming
 *       端点 R(0)=1 / R(D_max)=0、非均匀 H₂(p)−H₂(D) 对照
 *     - BA 在二值 Hamming 源上与解析 R(D) 吻合至 1e-6（β 扫 8 点
 *       对准 D∈[0.05,0.45]；非均匀源同锚）
 *     - BA 拉格朗日量 R+(β/ln2)·D 逐迭代单调不增（非均匀源真实迭代）
 *     - rdCurve：R 关于 D 单调不增 + 中点在弦下方（凸性方向）
 *     - 记忆规划器 8 条目（等尺寸、价值 90..20）：预算 800→25 扫描，
 *       保留集合按价值密度前缀收缩、永不超预算、λ* 单调上涨、
 *       充裕预算 λ*=0（与 22.0 BwK 同语义）
 *
 * 全部断言确定性（内核自带 mulberry32 种子）。运行：
 *   node --experimental-strip-types scripts/verify-curriculum-rd.mjs
 */

import {
  STANDARD_LADDER,
  learnerSuccessProb,
  practiceGain,
  simulateLearner,
  comparePolicies,
  masteryCurriculum,
  thompsonCurriculum,
  randomCurriculum,
  hardestFirstCurriculum,
} from '../src/core/curriculum-learning.ts';
import {
  binaryHammingRD,
  gaussianMseRD,
  blahutArimoto,
  rdCurve,
  memoryCompressionPlanner,
} from '../src/core/rate-distortion.ts';

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
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
const h2 = (x) => (x <= 0 || x >= 1 ? 0 : -x * Math.log2(x) - (1 - x) * Math.log2(1 - x));

// ═══════════════════ 59.0 课程学习内核 ═══════════════════

section('59.0 学习者定律：幂律强度 + 逻辑成功 + 倒 U 增益窗口');

{
  ok(near(learnerSuccessProb(STANDARD_LADDER, 0, 0), 0.5, 1e-15), `σ(a·0^b − 0) = 0.5（零经验时首层恰在增益峰值）`);
  // 手算锚：E=4 → 强度 1.6·4^0.7 = 1.6×2.6390158 = 4.2224253；层 1 难度 1.7 → logit 2.5224253
  // → σ = 0.9256990411（sigmoid 与 ½(1+tanh(x/2)) 双公式独立核对一致）
  ok(near(learnerSuccessProb(STANDARD_LADDER, 1, 4), 0.925699, 1e-6), `σ(1.6·4^0.7 − 1.7) = ${learnerSuccessProb(STANDARD_LADDER, 1, 4).toFixed(7)}（手算 0.9256990）`);
  ok(
    learnerSuccessProb(STANDARD_LADDER, 2, 4) < learnerSuccessProb(STANDARD_LADDER, 1, 4) &&
      learnerSuccessProb(STANDARD_LADDER, 1, 8) > learnerSuccessProb(STANDARD_LADDER, 1, 4),
    '成功率随难度升而降、随经验升而升（单调方向）',
  );
  ok(near(practiceGain(STANDARD_LADDER, 0.5), 1, 1e-15), `g(0.5) = 4·0.5·0.5 = 1（倒 U 峰值精确）`);
  ok(near(practiceGain(STANDARD_LADDER, 0.9), 0.36, 1e-15) && near(practiceGain(STANDARD_LADDER, 0.05), 0.19, 1e-15), `g(0.9)=0.36、g(0.05)=0.19（两端衰减精确）`);
  let peakOk = true;
  for (let i = 0; i <= 20; i += 1) {
    const p = i / 20;
    if (practiceGain(STANDARD_LADDER, p) > 1 + 1e-12) peakOk = false;
  }
  ok(peakOk, 'g(p) ≤ 1 对全部 p ∈ [0,1] 网格成立（学习只发生在能力边缘）');

  const r1 = simulateLearner(masteryCurriculum({ levelCount: 6 }), STANDARD_LADDER, { seed: 42, steps: 400 });
  const r2 = simulateLearner(masteryCurriculum({ levelCount: 6 }), STANDARD_LADDER, { seed: 42, steps: 400 });
  ok(
    r1.reachTopAtStep === r2.reachTopAtStep &&
      r1.finalExperience === r2.finalExperience &&
      r1.levelTrace.join('') === r2.levelTrace.join(''),
    `同种子逐位复现（seed=42：T=${r1.reachTopAtStep}，E=${r1.finalExperience}，轨迹 ${r1.levelTrace.length} 步）`,
  );
  ok(
    r1.experienceTrace.every((e, i) => i === 0 || e >= r1.experienceTrace[i - 1] - 1e-12),
    '经验轨迹单调不减（练习永不吃掉已有经验）',
  );
}

section('59.0 掌握门限状态机：构造轨迹单测（晋升连击 × 后验门限双条件）');

{
  // m=4，θ=0.7，r=2，s=2。手工推导的期望层轨迹（每次 report 前读 nextLevel）：
  //   步 1-2：L0 两连胜（第 2 步后验 (1+2)/(2+2)=0.75 ≥ 0.7）→ 升 L1
  //   步 3-4：L1 两连败 → 降回 L0
  //   步 5-6：L0 两连胜（后验 4/5=0.8）→ 升 L1
  //   步 7-12：L1 六连胜才凑够后验 7/10=0.7（两败旧账压低后验——
  //            连击早已 ≥2 但门限拦住：防「运气晋升」）→ 升 L2
  const mc = masteryCurriculum({ levelCount: 4, threshold: 0.7, promoteR: 2, demoteS: 2 });
  const trace = [];
  const feed = (success) => {
    const level = mc.nextLevel();
    trace.push(level);
    mc.report(level, success);
  };
  [true, true, false, false, true, true, true, true, true, true, true, true].forEach(feed);
  ok(
    trace.join(',') === '0,0,1,1,0,0,1,1,1,1,1,1',
    `12 步构造轨迹逐层对照：[${trace.join(',')}]（升/降/门限拦截全部按手推）`,
  );
  ok(mc.currentLevel === 2, `终态 currentLevel=2（第 12 步后验 7/10 达门限后晋升）`);

  // 防运气晋升的净对照：门限放到 0.1，同样的前 4 步两连胜立即晋升
  const loose = masteryCurriculum({ levelCount: 4, threshold: 0.1, promoteR: 2, demoteS: 2 });
  loose.report(0, true);
  loose.report(0, true);
  ok(loose.currentLevel === 1, `θ=0.1 时两连胜立即晋升（证明上面拦住的是后验门限而非连击条件）`);

  // 顶部钳位：升到顶层后继续连胜不再升
  const top = masteryCurriculum({ levelCount: 3, threshold: 0.1, promoteR: 1, demoteS: 5 });
  for (let i = 0; i < 30; i += 1) top.report(top.nextLevel(), true);
  ok(top.currentLevel === 2, `30 连胜停在顶层（currentLevel=${top.currentLevel}，顶钳位）`);
  // 底部钳位：底层连败不降
  const floor = masteryCurriculum({ levelCount: 3, threshold: 0.9, promoteR: 3, demoteS: 2 });
  for (let i = 0; i < 10; i += 1) floor.report(0, false);
  ok(floor.currentLevel === 0, `底层 10 连败仍在 0（currentLevel=${floor.currentLevel}，底钳位）`);
  // reset 回到初始状态
  top.reset();
  ok(top.currentLevel === 0 && near(top.posteriorMean(0), 0.5, 1e-12), 'reset() 后回到 0 层、后验回到 Beta(1,1) 均值 0.5');
}

section('59.0 三策略 200 种子对照：中位数 课程 < Thompson < 随机 < 最难（锚点①）');

{
  const stats = comparePolicies(
    STANDARD_LADDER,
    [
      masteryCurriculum({ levelCount: 6 }),
      thompsonCurriculum({ levelCount: 6 }),
      randomCurriculum({ levelCount: 6 }),
      hardestFirstCurriculum({ levelCount: 6 }),
    ],
    { trials: 200, steps: 400, seedBase: 1 },
  );
  const [mastery, thompson, random, hardest] = stats;
  stats.forEach((s) =>
    console.log(
      `    ${s.name}: 中位(删失)=${s.medianStepsCensored} 均值=${s.meanStepsCensored} p90=${s.p90Steps ?? '—'} 困死率=${s.stuckRate}`,
    ),
  );
  const winRate = (a, b) => {
    let w = 0;
    for (let k = 0; k < a.stepsToTop.length; k += 1) {
      const x = a.stepsToTop[k];
      const y = b.stepsToTop[k];
      if (x !== null && (y === null || x < y)) w += 1;
    }
    return w / a.stepsToTop.length;
  };
  ok(
    mastery.medianStepsCensored < random.medianStepsCensored &&
      random.medianStepsCensored < hardest.medianStepsCensored,
    `中位数（删失口径）：课程 ${mastery.medianStepsCensored} < 随机 ${random.medianStepsCensored} < 最难 ${hardest.medianStepsCensored}`,
  );
  ok(
    winRate(mastery, random) >= 0.85,
    `配对胜率 课程>随机 = ${winRate(mastery, random).toFixed(3)} ≥ 0.85（同种子世界流配对比较）`,
  );
  ok(
    winRate(random, hardest) >= 0.95,
    `配对胜率 随机>最难 = ${winRate(random, hardest).toFixed(3)} ≥ 0.95（最难优先在绝望之谷 400 步内 0/200 达成）`,
  );
  ok(
    thompson.medianStepsCensored < random.medianStepsCensored && winRate(thompson, random) >= 0.65,
    `Thompson 课程也胜随机：中位 ${thompson.medianStepsCensored} < ${random.medianStepsCensored}，配对胜率 ${winRate(thompson, random).toFixed(3)} ≥ 0.65`,
  );
}

section('59.0 困死率：预算收紧（cap=100）后课程法显著最低（锚点②）');

{
  const stats = comparePolicies(
    STANDARD_LADDER,
    [
      masteryCurriculum({ levelCount: 6 }),
      thompsonCurriculum({ levelCount: 6 }),
      randomCurriculum({ levelCount: 6 }),
      hardestFirstCurriculum({ levelCount: 6 }),
    ],
    { trials: 200, steps: 100, seedBase: 1 },
  );
  const [mastery, thompson, random, hardest] = stats;
  console.log(
    `    困死率: 课程=${mastery.stuckRate} Thompson=${thompson.stuckRate} 随机=${random.stuckRate} 最难=${hardest.stuckRate}`,
  );
  ok(
    mastery.stuckRate === 0 && mastery.stuckRate < random.stuckRate && random.stuckRate < hardest.stuckRate,
    `严格序：课程 ${mastery.stuckRate} < 随机 ${random.stuckRate} < 最难 ${hardest.stuckRate}（课程法零困死）`,
  );
}

section('59.0 墙世界（非单调难度）：Thompson 课程自适应绕墙（锚点③）');

{
  // 名义阶梯第 4 层是「墙」（难度 14 ≫ 强度可达范围），墙后第 5 层反而可学。
  // 固定阶梯（掌握课程）必须过墙 → 在墙下反复横跳、经验源枯竭 → 100% 困死；
  // Thompson 对效用采样，墙层信念锁死 θ̂≈0 永不浪费预算，直取墙后可学层。
  const WALL = { difficulties: [0, 1.7, 3.4, 14.0, 5.1, 6.8], growthA: 1.6, growthB: 0.7, gainScale: 1, initialExperience: 0 };
  const stats = comparePolicies(
    WALL,
    [masteryCurriculum({ levelCount: 6 }), thompsonCurriculum({ levelCount: 6 })],
    { trials: 100, steps: 400, seedBase: 1 },
  );
  const [mastery, thompson] = stats;
  let wins = 0;
  for (let k = 0; k < 100; k += 1) {
    const a = thompson.stepsToTop[k];
    const b = mastery.stepsToTop[k];
    if (a !== null && (b === null || a < b)) wins += 1;
  }
  console.log(
    `    固定阶梯: 中位(删失)=${mastery.medianStepsCensored} 困死率=${mastery.stuckRate}；Thompson: 中位=${thompson.medianStepsCensored} 困死率=${thompson.stuckRate}`,
  );
  ok(
    thompson.medianStepsCensored <= 60 && mastery.medianStepsCensored === 400,
    `Thompson 中位 ${thompson.medianStepsCensored} ≤ 60 ≪ 固定阶梯 400（墙下死锁）`,
  );
  ok(mastery.stuckRate === 1 && thompson.stuckRate === 0, `困死率：固定阶梯 ${mastery.stuckRate} vs Thompson ${thompson.stuckRate}（非单调收益层序下自适应胜出）`);
  ok(wins / 100 >= 0.95, `配对胜率 Thompson>固定阶梯 = ${(wins / 100).toFixed(2)} ≥ 0.95`);
}

section('59.0 入参校验（显式 throw）');

{
  ok(throws(() => simulateLearner(masteryCurriculum({ levelCount: 6 }), { difficulties: [], growthA: 1.6, growthB: 0.7 }, { seed: 1, steps: 10 })), '空难度数组 throw');
  ok(throws(() => simulateLearner(masteryCurriculum({ levelCount: 6 }), { difficulties: [0, 1], growthA: 1.6, growthB: 1.5 }, { seed: 1, steps: 10 })), 'growthB > 1 throw');
  ok(throws(() => simulateLearner(masteryCurriculum({ levelCount: 6 }), STANDARD_LADDER, { seed: 1, steps: 0 })), 'steps=0 throw');
  ok(throws(() => masteryCurriculum({ levelCount: 6, threshold: 1 })), 'threshold=1 throw');
  ok(throws(() => thompsonCurriculum({ levelCount: 6, decay: 1.2 })), 'decay>1 throw');
  ok(throws(() => learnerSuccessProb(STANDARD_LADDER, 9, 0)), '越界层查询 throw');
}

// ═══════════════════ 60.0 率失真内核 ═══════════════════

section('60.0 解析锚：高斯 MSE 与二值 Hamming 的闭式 R(D)');

{
  ok(gaussianMseRD(0.5, 1) === 0.5, `gaussianMseRD(0.5, σ²=1) = ${gaussianMseRD(0.5, 1)}（½·log₂2 = 0.5 bit 精确）`);
  ok(near(gaussianMseRD(0.25, 1), 1, 1e-12), `gaussianMseRD(0.25, 1) = 1（½·log₂4）`);
  ok(near(gaussianMseRD(0.125, 1), 1.5, 1e-12), `gaussianMseRD(0.125, 1) = 1.5（½·log₂8）`);
  ok(gaussianMseRD(1, 1) === 0 && gaussianMseRD(2, 1) === 0, `D ≥ σ² 时 R = 0（诚实返回零码率）`);
  ok(near(gaussianMseRD(1, 2), 0.5, 1e-12), `gaussianMseRD(1, σ²=2) = 0.5（尺度平移不变性：D/σ² 才是本质）`);
  ok(near(binaryHammingRD(0, 0.5), 1, 1e-15), `binaryHammingRD(0, 0.5) = 1（零失真要 1 bit）`);
  ok(near(binaryHammingRD(0.5, 0.5), 0, 1e-15), `binaryHammingRD(0.5, 0.5) = 0（D_max = 1/2 处曲线触零）`);
  ok(near(binaryHammingRD(0.1), 1 - h2(0.1), 1e-12), `binaryHammingRD(0.1) = 1 − H₂(0.1) = ${(1 - h2(0.1)).toFixed(9)}`);
  ok(near(binaryHammingRD(0.1, 0.3), h2(0.3) - h2(0.1), 1e-12), `非均匀源 R(D) = H₂(p) − H₂(D) = ${(h2(0.3) - h2(0.1)).toFixed(9)}（p=0.3, D_max=0.3）`);
  ok(binaryHammingRD(0.4, 0.3) === 0, `非均匀源 D > min(p,1−p) 时 R = 0（恒猜众数类即零失真）`);
}

section('60.0 Blahut–Arimoto vs 解析 R(D)：吻合至 1e-6（β 扫 8 点 + 非均匀源）');

{
  const targets = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.45];
  let worstDiff = 0;
  let allConverged = true;
  for (const D of targets) {
    const beta = Math.log((1 - D) / D); // 二值 Hamming 最优点的斜率关系 β = ln((1−D)/D)
    const r = blahutArimoto([0.5, 0.5], [[0, 1], [1, 0]], beta, { iters: 20000, tol: 1e-13 });
    const analytic = 1 - h2(r.distortion);
    worstDiff = Math.max(worstDiff, Math.abs(r.rate - analytic));
    if (!r.converged) allConverged = false;
  }
  ok(targets.length >= 5, `β 扫描点数 = ${targets.length} ≥ 5（D∈[0.05,0.45]）`);
  ok(
    worstDiff <= 1e-6 && allConverged,
    `均匀二值源：BA 与解析 1−H₂(D) 最大偏差 ${worstDiff.toExponential(2)} ≤ 1e-6（8 点全收敛）`,
  );
  const nu = blahutArimoto([0.3, 0.7], [[0, 1], [1, 0]], Math.log(9), { iters: 20000, tol: 1e-13 });
  ok(
    near(nu.rate, h2(0.3) - h2(nu.distortion), 1e-6),
    `非均匀源 p=(0.3,0.7)：BA R=${nu.rate.toFixed(9)} vs 解析 H₂(p)−H₂(D)=${(h2(0.3) - h2(nu.distortion)).toFixed(9)}（D=${nu.distortion.toFixed(6)}）`,
  );
  ok(
    nu.conditional.every((row) => near(row.reduce((s, v) => s + v, 0), 1, 1e-12)),
    '测试信道行归一（p(x̂|x) 是合法条件分布）',
  );
  ok(
    near(nu.marginal.reduce((s, v) => s + v, 0), 1, 1e-12),
    `重现边际归一（q=[${nu.marginal.map((v) => v.toFixed(6)).join(', ')}]，非均匀源最优重现边际偏向众数符号而非 p 本身）`,
  );
  ok(
    near(nu.distortion, 0.1, 1e-6),
    `β=ln9 把 BA 点对准 D=0.1（斜率关系 H₂'(D)=log₂((1−D)/D) 与 p 无关——对任意二值 Hamming 源成立）`,
  );
}

section('60.0 BA 拉格朗日量单调收敛（锚点②）');

{
  // 非均匀源从均匀边际起步不是不动点——真实迭代下降轨道
  for (const [px, d, beta, label] of [
    [[0.3, 0.7], [[0, 1], [1, 0]], Math.log(9), '二值非均匀 β=ln9'],
    [[0.5, 0.3, 0.2], [[0, 1, 1], [1, 0, 1], [1, 1, 0]], 2.0, '三值对称 β=2'],
  ]) {
    const r = blahutArimoto(px, d, beta, { iters: 20000, tol: 1e-13 });
    const t = r.lagrangianTrace;
    let worstRise = 0;
    for (let i = 1; i < t.length; i += 1) worstRise = Math.max(worstRise, t[i] - t[i - 1]);
    ok(
      worstRise <= 1e-10 && t.length >= 5 && r.converged,
      `${label}：L = R + (β/ln2)·D 逐迭代单调不增（最大回升 ${worstRise.toExponential(2)}，${t.length} 次迭代收敛）`,
    );
    ok(
      t.length >= 2 && t[t.length - 1] < t[0],
      `${label}：L 从 ${t[0].toFixed(9)} 降至 ${t[t.length - 1].toFixed(9)}（交替更新各是坐标方向的最小化）`,
    );
  }
}

section('60.0 rdCurve 形状：R(D) 单调不增 + 凸性方向（锚点④）');

{
  const betas = [0.02, 0.05, 0.08, 0.12, 0.18, 0.25, 0.32, 0.4, 0.45, 0.48].map((D) => Math.log((1 - D) / D));
  const curve = rdCurve([0.5, 0.5], [[0, 1], [1, 0]], betas, { iters: 20000, tol: 1e-13 });
  ok(curve.length === betas.length && curve.every((p) => p.converged), `${curve.length} 个 β 点全部收敛（按失真升序返回）`);
  let monotone = true;
  for (let i = 1; i < curve.length; i += 1) {
    if (curve[i].distortion < curve[i - 1].distortion - 1e-12 || curve[i].rate > curve[i - 1].rate + 1e-9) monotone = false;
  }
  ok(monotone, 'D 升序时 R 单调不增（放宽保真度只会更省比特）');
  let convex = true;
  for (let i = 1; i < curve.length - 1; i += 1) {
    const a = curve[i - 1];
    const b = curve[i];
    const c = curve[i + 1];
    const chord = a.rate + ((c.rate - a.rate) * (b.distortion - a.distortion)) / (c.distortion - a.distortion);
    if (b.rate > chord + 1e-9) convex = false;
  }
  ok(convex, '相邻三点中点均在弦下方（R(D) 凸性方向——边际比特递减）');
  let worst = 0;
  for (const p of curve) worst = Math.max(worst, Math.abs(p.rate - (1 - h2(p.distortion))));
  ok(worst <= 1e-6, `曲线逐点对照解析 1−H₂(D)：最大偏差 ${worst.toExponential(2)} ≤ 1e-6`);
}

section('60.0 记忆压缩规划器：8 条目预算扫描的价值密度分摊（锚点⑤）');

{
  // 8 条目等尺寸（100 bit）、压缩档 25 bit/留存 0.5，价值 90..20（价值密度互异）
  const entries = [90, 80, 70, 60, 50, 40, 30, 20].map((value, i) => ({
    id: `m${i + 1}`,
    value,
    sizeBits: 100,
    compressedBits: 25,
    retention: 0.5,
  }));
  const densityOrder = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
  const budgets = [800, 500, 300, 150, 100, 25];
  const plans = budgets.map((b) => memoryCompressionPlanner(entries, b));
  budgets.forEach((b, i) => {
    const p = plans[i];
    console.log(
      `    预算 ${String(b).padStart(3)}：keep=[${p.keep.join(',') || '—'}] compress=[${p.compress.join(',') || '—'}] drop=[${p.drop.join(',') || '—'}] 用 ${p.usedBits}/${b} bit，保值 ${p.retainedValue}/${p.totalValue}，λ*=${p.shadowPrice}`,
    );
  });
  ok(plans.every((p, i) => p.usedBits <= budgets[i] + 1e-9), '所有预算下 usedBits ≤ budget（永不超支）');
  const full = plans[0];
  ok(
    full.keep.join(',') === densityOrder.join(',') && full.usedBits === 800 && full.shadowPrice === 0 && full.retainedValue === 440,
    '宽预算 800：全 keep、λ*=0（容量充裕无影子价格——与 22.0 BwK 同语义）、保值 440/440',
  );
  ok(plans[1].keep.join(',') === 'm1,m2,m3,m4' && plans[1].compress.join(',') === 'm5,m6,m7,m8', '预算 500：keep 高价值密度前 4、compress 后 4（λ*=0.4 处分界）');
  ok(plans[3].keep.length === 0 && plans[3].compress.join(',') === 'm1,m2,m3,m4,m5,m6' && plans[3].drop.join(',') === 'm7,m8', '预算 150：全压缩档，最低密度 m7/m8 先被遗忘');
  ok(plans[5].compress.join(',') === 'm1' && plans[5].usedBits === 25, '预算 25：只剩最高价值密度 m1 的压缩档（一枚压缩档的代价）');
  // 保留集合按价值密度前缀收缩（预算越紧，keep 是越短的前缀；compress 补下一截）
  let prefixOk = true;
  for (let i = 1; i < plans.length; i += 1) {
    const prevKeep = plans[i - 1].keep;
    const curKeep = plans[i].keep;
    if (!curKeep.every((id, k) => prevKeep[k] === id)) prefixOk = false;
  }
  ok(prefixOk, '预算从宽到紧：keep 集合是价值密度降序的前缀且逐级收缩（先忘低价值密度）');
  ok(
    plans[5].drop.join(',') === 'm2,m3,m4,m5,m6,m7,m8' && plans[3].drop.every((id) => densityOrder.indexOf(id) >= 6),
    'drop 名单按价值密度从低到高逐级扩大（m8 最先被忘）',
  );
  let valueMonotone = true;
  let priceMonotone = true;
  for (let i = 1; i < plans.length; i += 1) {
    if (plans[i].retainedValue > plans[i - 1].retainedValue + 1e-9) valueMonotone = false;
    if (plans[i].shadowPrice < plans[i - 1].shadowPrice - 1e-9) priceMonotone = false;
  }
  ok(valueMonotone, '预算越紧保留价值单调不增（分摊是率失真最优的方向）');
  ok(priceMonotone && plans[5].shadowPrice === 1.8, `影子价格随预算收紧单调上涨：[${plans.map((p) => p.shadowPrice).join(' → ')}]（遗忘的边际价格——25 bit 预算时 1.8 价值/bit）`);
  ok(
    plans[1].decisions.m4 === 'keep' && plans[1].decisions.m5 === 'compress' && plans[5].decisions.m1 === 'compress',
    'decisions 逐条目映射与名单一致',
  );
}

section('60.0 入参校验（显式 throw）');

{
  ok(throws(() => binaryHammingRD(-0.1)), 'binaryHammingRD 负失真 throw');
  ok(throws(() => binaryHammingRD(0.1, 1.2)), 'binaryHammingRD 非法 p throw');
  ok(throws(() => gaussianMseRD(0, 1)), 'gaussianMseRD 零失真 throw');
  ok(throws(() => gaussianMseRD(0.5, 0)), 'gaussianMseRD 零方差 throw');
  ok(throws(() => blahutArimoto([1], [[0]], 1)), 'blahutArimoto 单符号源 throw');
  ok(throws(() => blahutArimoto([0.5, 0.5], [[0, 1]], 1)), 'blahutArimoto 失真矩阵行数不匹配 throw');
  ok(throws(() => blahutArimoto([0.5, 0.5], [[0, 1], [1, 0]], 0)), 'blahutArimoto β=0 throw');
  ok(throws(() => blahutArimoto([0.5, 0.5], [[0, -1], [1, 0]], 1)), 'blahutArimoto 负失真 throw');
  ok(throws(() => rdCurve([0.5, 0.5], [[0, 1], [1, 0]], [])), 'rdCurve 空 β 列表 throw');
  ok(throws(() => memoryCompressionPlanner([], 100)), 'memoryCompressionPlanner 空条目 throw');
  ok(throws(() => memoryCompressionPlanner([{ id: 'a', value: 1, sizeBits: 10 }, { id: 'a', value: 1, sizeBits: 10 }], 100)), '重复 id throw');
  ok(throws(() => memoryCompressionPlanner([{ id: 'a', value: 1, sizeBits: 0 }], 100)), 'sizeBits=0 throw');
  ok(throws(() => memoryCompressionPlanner([{ id: 'a', value: 1, sizeBits: 10 }], -1)), '负预算 throw');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
