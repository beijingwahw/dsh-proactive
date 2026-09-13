/**
 * verify-conformal.mjs — 13.0「保形预测与风险控制」质变闭环离线验证
 *
 * 升级前后的分水岭：
 *   世界模型的 sqrt(λ) 泊松区间：没有覆盖率保证——名义 95% 实际
 *   覆盖多少无人知晓（偏斜/过散时系统性失准）；反思引擎 ±0.02 步进
 *   阈值：重试率全凭运气，重试风暴与漏放低质量交替发生。
 *   分裂保形区间：P(实际 ∈ 区间) ≥ 1−α 精确有限样本保证（零分布
 *   假设）；风险受控阈值：P(未来重试率 ≤ targetRisk) ≥ confidence
 *   ——预测与阈值第一次被钉在数学上限之内。
 *
 * 闭环断言：
 *   A 保形分位数：⌈(n+1)(1−α)⌉ 次序统计量的精确秩计算
 *   B 蒙特卡洛覆盖（分水岭）：偏斜双峰分布下经验覆盖 ≥ 1−α
 *   C 校准不足诚实发散：小样本 → finite=false（+∞，不伪装确定）
 *   D 覆盖漂移 e-监测：良好覆盖不漂移；分布突变持续欠覆盖 → 确证
 *   E 风险受控阈值：优质历史选出带保证阈值；垃圾历史诚实拒绝
 *   F 世界模型集成：预测携带保形区间；校准对账回流引擎
 *   G 反思引擎集成：阈值升级为风险受控选择 + basis 可审计
 *   H 缺省零漂移：不挂载 → 无保形字段、阈值走既有步进路径
 *
 * 运行：npm run build && node scripts/verify-conformal.mjs
 */

import {
  conformalQuantile,
  ConformalIntervalEngine,
  CoverageDriftMonitor,
  selectRiskControlledThreshold,
  WorldModel,
  ReflectionEngine,
} from '../dist/index.mjs';

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
function section(title) {
  console.log(`\n■ ${title}`);
}

// 确定性 RNG（mulberry32）
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

// ═══════════════════ A 保形分位数 ═══════════════════

section('A 保形分位数：⌈(n+1)(1−α)⌉ 次序统计量');

{
  const scores = [0.1, 0.5, 0.3, 0.9, 0.7, 0.2, 0.8, 0.4, 0.6, 0.05]; // n=10
  const q90 = conformalQuantile(scores, 0.1);
  // rank = ⌈11×0.9⌉ = ⌈9.9⌉ = 10 → 升序第 10 个 = 0.9
  ok(q90 === 0.9, `n=10, α=0.1 → 秩 10 → q̂=0.9（实测 ${q90}）`);
  const q50 = conformalQuantile(scores, 0.5);
  // rank = ⌈11×0.5⌉ = 6 → 升序第 6 个 = 0.5
  ok(q50 === 0.5, `n=10, α=0.5 → 秩 6 → q̂=0.5（实测 ${q50}）`);
  // 校准集太小撑不起置信度：n=2, α=0.05 → rank=⌈3×0.95⌉=3 > 2 → undefined
  ok(conformalQuantile([0.5, 0.6], 0.05) === undefined, 'n=2 撑不起 95% 覆盖 → undefined（诚实发散）');
}

// ═══════════════════ B 蒙特卡洛覆盖（分水岭） ═══════════════════

section('B 蒙特卡洛覆盖：偏斜双峰分布下经验覆盖 ≥ 1−α');

{
  // 分布无关性是保形的核心卖点：用高度非正态的分布做交换对——
  // 预测 ŷ=0.5 恒定，噪声为双峰偏斜：80% 概率 +[0, 0.1]，20% 概率 +[0.3, 0.5]
  const alpha = 0.1;
  const rng = mulberry32(88);
  const TRIALS = 4000;
  let covered = 0;
  for (let trial = 0; trial < TRIALS; trial += 1) {
    // 每次试验重新抽取校准集（15 条）+ 1 条新样本
    const calibration = [];
    const drawResidual = () => (rng() < 0.8 ? rng() * 0.1 : 0.3 + rng() * 0.2);
    for (let i = 0; i < 15; i += 1) calibration.push(drawResidual());
    const q = conformalQuantile(calibration, alpha);
    if (q === undefined) continue; // 校准不足的试验不计入（诚实发散）
    const newResidual = drawResidual();
    if (newResidual <= q) covered += 1;
  }
  const rate = covered / TRIALS;
  ok(rate >= 1 - alpha - 0.01, `偏斜双峰残差下经验覆盖 ${(rate * 100).toFixed(1)}% ≥ 名义 ${(1 - alpha) * 100}%（${TRIALS} 次试验）`);
  ok(rate <= 0.995, `覆盖不过度保守（实测 ${(rate * 100).toFixed(1)}%，非 100% 全包）`);
}

// ═══════════════════ C 校准不足诚实发散 ═══════════════════

section('C 校准不足：finite=false 而非伪装确定');

{
  const engine = new ConformalIntervalEngine({ alpha: 0.1 });
  const early = engine.interval(5.0);
  ok(early.finite === false, '零校准 → 区间诚实发散（finite=false）');
  ok(early.lower === Number.NEGATIVE_INFINITY && early.upper === Number.POSITIVE_INFINITY, '发散区间 = (−∞, +∞)（不伪装确定）');
  for (let i = 0; i < 12; i += 1) engine.calibrate(0.5);
  const ready = engine.interval(5.0);
  ok(ready.finite === true, '12 条校准后区间生效（finite=true）');
  ok(ready.calibrationN === 12, `校准样本量正确记账（${ready.calibrationN}）`);
  ok(ready.lower === 5 - ready.qhat && ready.upper === 5 + ready.qhat, `区间以 q̂=${ready.qhat} 为半径对称包住点预测`);
}

// ═══════════════════ D 覆盖漂移 e-监测 ═══════════════════

section('D 覆盖漂移监测：良好覆盖不漂移；持续欠覆盖 → e-过程确证');

{
  // 良好覆盖（确定性精确 90% vs 目标 90%）→ 不应确证漂移
  const good = new CoverageDriftMonitor(0.1, 0.01);
  for (let i = 0; i < 2000; i += 1) good.observe(i % 10 < 9);
  ok(!good.view().drifting, `覆盖率达标（精确 90% vs 目标 90%）2000 次观测不确证漂移（e=${good.view().eValue.toFixed(2)}）`);

  // 持续欠覆盖（确定性精确 60% vs 目标 90%，交错排布）→ 资本指数上升 → 确证
  const bad = new CoverageDriftMonitor(0.1, 0.01);
  let driftAt = -1;
  for (let i = 0; i < 2000; i += 1) {
    const view = bad.observe(i % 5 !== 1 && i % 5 !== 4); // 每 5 次 3 次覆盖 = 精确 60%
    if (view.drifting && driftAt < 0) driftAt = i + 1;
  }
  ok(bad.view().drifting, `实际覆盖 60% vs 目标 90% → 漂移确证（第 ${driftAt} 次观测，e=${bad.view().eValue.toExponential(2)} ≥ 100）`);
  ok(Math.abs(bad.view().empiricalCoverage - 0.6) < 0.05, `经验覆盖 EMA 锚定真值（${bad.view().empiricalCoverage.toFixed(3)} vs 0.600，交错模式的 EMA 收敛带内）`);
}

// ═══════════════════ E 风险受控阈值 ═══════════════════

section('E 风险受控阈值：优质历史选出带保证阈值；垃圾历史诚实拒绝');

{
  // 优质历史：质量大多 ≥ 0.8（经验伯恩斯坦上界随 n 收敛——200 条样本
  // 足以在 95% 置信下认证零风险阈值）→ 可选出较严的阈值且风险上界受控
  const goodSamples = Array.from({ length: 200 }, (_, i) => 0.8 + ((i * 7) % 15) / 100); // 0.80~0.94
  const grid = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85];
  const result = selectRiskControlledThreshold(goodSamples, grid, { targetRisk: 0.1, confidence: 0.95 });
  ok(result !== undefined, `优质历史选出阈值（${result ? result.threshold : '无'}）`);
  ok(result && result.riskBound <= 0.1, `风险上界 ${(result ? result.riskBound * 100 : 0).toFixed(1)}% ≤ 目标 10%`);
  ok(result && result.threshold >= 0.8, `选出的是较严门槛（λ=${result?.threshold}，非最松的 0.5）——风险余量换取质量追求`);
  ok(result && /Bonferroni/.test(result.interpretation), 'basis 携带可读依据（Bonferroni 分摊说明）');

  // 垃圾历史：质量全 0.3 → 连最低门槛的经验风险都是 100% → 诚实 undefined
  const badSamples = Array.from({ length: 40 }, () => 0.3);
  const rejected = selectRiskControlledThreshold(badSamples, grid, { targetRisk: 0.1, confidence: 0.95 });
  ok(rejected === undefined, '垃圾历史无合格阈值 → undefined（诚实拒绝，宁可不调不可越界）');
}

// ═══════════════════ F 世界模型集成 ═══════════════════

section('F 世界模型集成：预测携带保形区间 + 校准对账回流');

{
  const world = new WorldModel();
  const engine = new ConformalIntervalEngine({ alpha: 0.2, maxCalibration: 100 });
  world.attachConformalCalibrator(engine);
  const now = Date.now();

  // 零校准时：预测的 conformal 字段 finite=false（诚实发散）
  for (let i = 0; i < 8; i += 1) world.observeArrival('error-spike', now - (10 - i) * 60_000);
  const early = world.predictArrivals(5 * 60_000).find((p) => p.type === 'error-spike');
  ok(early && early.conformal && early.conformal.finite === false, '校准不足时保形字段诚实发散（finite=false）');

  // 多轮「预测 → 到达 → 对账」循环：校准集积累后区间生效
  const rng = mulberry32(77);
  for (let cycle = 0; cycle < 6; cycle += 1) {
    const horizon = 5 * 60_000;
    const base = now + cycle * horizon;
    world.predictArrivals(horizon);
    // 模拟窗口内实际到达 2~6 个
    const arrivals = 2 + Math.floor(rng() * 5);
    for (let i = 0; i < arrivals; i += 1) world.observeArrival('error-spike', base + (i + 1) * 30_000);
    world.settleCalibrations(base + horizon);
  }
  const late = world.predictArrivals(5 * 60_000).find((p) => p.type === 'error-spike');
  ok(late && late.conformal && late.conformal.finite === true, `6 轮对账后保形区间生效（calibrationN=${late?.conformal?.calibrationN}）`);
  ok(late && late.lowerBound >= 0, `区间下界非负（[${late?.lowerBound}, ${late?.upperBound}]）`);

  const status = world.getConformalStatus();
  ok(status !== undefined && status.calibrationN >= 5, `世界模型暴露保形状态（校准 ${status?.calibrationN} 条）`);
  ok(status && status.drift && status.drift.n > 0, `覆盖监测已积累观测（n=${status?.drift?.n}）`);
  ok(world.getSummary().conformal !== undefined, 'getSummary 携带 conformal 面板');
}

// ═══════════════════ G 反思引擎集成 ═══════════════════

section('G 反思引擎集成：阈值升级为风险受控选择');

{
  const engine = new ReflectionEngine({ qualityThreshold: 0.7, calibrationMinSamples: 10, thresholdRange: [0.5, 0.95] });
  engine.attachRiskController({ targetRisk: 0.15, confidence: 0.95, gridSteps: 18 });

  // 喂优质历史 150 批（0.8~0.95；RCPS 认证需样本深度 ≳94 使上界收敛）：
  // 阈值应被推向带保证的较严位置
  for (let i = 0; i < 150; i += 1) engine.recordExecution('codegen', 0.8 + (i % 4) * 0.05, true);
  const threshold = engine.getCurrentThreshold();
  const basis = engine.getThresholdBasis();
  ok(basis !== undefined, `阈值选择产出风险依据（${basis ? basis.interpretation.slice(0, 50) + '…' : '无'}）`);
  ok(basis && basis.riskBound <= 0.15, `风险上界 ${(basis ? basis.riskBound * 100 : 0).toFixed(1)}% ≤ 目标 15%`);
  ok(threshold >= 0.75, `阈值收紧到较严位置（${threshold}）——优质历史换取质量追求`);
  const summary = engine.getTrendSummary();
  ok(summary.basis !== undefined, '趋势摘要携带 basis（审计通道）');
}

// ═══════════════════ H 缺省零漂移 ═══════════════════

section('H 缺省零漂移：不挂载 → 无保形字段、阈值走既有路径');

{
  const world = new WorldModel();
  world.observeArrival('x', Date.now());
  const p = world.predictArrivals()[0];
  ok(p.conformal === undefined, '未挂载时预测无 conformal 字段（零漂移）');
  ok(world.getConformalStatus() === undefined, '未挂载时无保形状态');
  ok(world.getSummary().conformal === undefined, '未挂载时摘要无 conformal 面板');

  const engine = new ReflectionEngine({ qualityThreshold: 0.7, calibrationMinSamples: 10 });
  for (let i = 0; i < 25; i += 1) engine.recordExecution('codegen', 0.9, true);
  ok(engine.getThresholdBasis() === undefined, '未挂载时无风险依据（走既有 ±0.02 步进路径）');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✓ 全部 ${passed} 项断言通过 —— 13.0 保形预测与风险控制质变闭环成立`);
  process.exit(0);
} else {
  console.error(`✗ ${failed} 项失败（${passed} 项通过）`);
  process.exit(1);
}
