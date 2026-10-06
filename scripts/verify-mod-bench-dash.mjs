/**
 * verify-mod-bench-dash.mjs — 第三轮 A15 模块域验证
 *
 * 覆盖 benchmark-engine.ts 与 dashboard/（index.ts + index.html）的第三轮升级：
 *
 * benchmark（基准结论从「点分」到「携带证据」）:
 *   ① 成对统计检验: 符号检验精确二项（8 胜 0 负 p = 2·0.5⁸ = 0.0078125 锚点）+
 *      种子化 bootstrap CI（同种子同区间 / 已知强弱流 CI 不含 0 / 名义 95%
 *      覆盖率 ∈ [0.90, 0.99]×300 试验）；已知强弱分数流（Bernoulli 0.65 vs
 *      0.5，n=300）检验功效 ≥ 0.9、同分布流假阳性 ≤ 0.12
 *   ② e-过程回归检测器: H0: μ ≥ μ0 资本过程 e_t = Π(1+λ(x−μ0))（λ 可预测
 *      ≤ 0——EWMA 背离，因子恒 ≥ 0.5）；平稳段（μ = μ0 = 0.8）300 步逐偷看
 *      200 种子误报率 ≤ 0.08（Ville 上界 α=0.05 + 抽样容差——偷看免疫口径：
 *      任意时刻查看不膨胀假阳性）；回归注入（0.8→0.5）报警功率 ≥ 0.88；
 *      确定性强回归流 30 步内必报警
 *   ③ BAI 聚焦跑分预算: 差距已明确模型集 μ=[0.5,0.45,0.4,0.3,0.1]、
 *      budget=3000、500 种子——SH 锦标赛（73.0 口径自实现）识别率 ≥ 0.95
 *      且 > 均匀分配对照；planBenchmarkBudget 未挂载 → 均匀、挂载 → 聚焦
 *      （Σ ≤ 预算纪律）；runAll 报告附加 budgetPlan
 *   ④ 结构化报告导出: JSON 往返 / 分数 + CI + 检验结论 + 建议齐备
 *   ⑤ 旧挂载面兼容: attachBaiSelector（baiFocus）与 attachHyperbandTuner
 *      （hyperbandTune）行为不变；未挂载任何 attach → 报告无
 *      baiFocus / bottleneckFocus / regressionAlarm（零漂移）
 *
 * dashboard（三个新面板的数据绑定面）:
 *   ⑥ loopback 集成: ProgressBroadcaster 真实 HTTP 端口上 attachDashboard
 *      注入数据源 → /api/kernel-map（20 层 × 98 内核 × 旗标合并）、
 *      /api/gwt-bus（最近广播流步序降序）、/api/attention-market（槽位 +
 *      VCG 支付按源聚合）逐字段断言；撤掉数据源 → 三端点空态；卸载 →
 *      恢复默认健康检查
 *   ⑦ HTML 离线结构断言: 三面板锚点存在、无新外链（无 <link / 外链 src /
 *      script src）、脚本引用的 $('id') 全部存在于文档、四端点路径在案
 *
 * 运行：npm run build && node scripts/verify-mod-bench-dash.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as dsh from '../dist/index.mjs';

const {
  BenchmarkEngine,
  pairedSignTest,
  bootstrapDifferenceCi,
  pairedModelComparison,
  BenchmarkRegressionDetector,
  baiFocusedBudgetAllocation,
  uniformBudgetAllocation,
  ProgressBroadcaster,
  attachDashboard,
} = dsh;

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
/** 验证脚本内确定性 RNG（与内核同款 mulberry32——种子化可复现） */
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
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
function okThrow(fn, label) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, label);
}
function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ═══════════════════ ① 成对统计检验 ═══════════════════

section('① 成对统计检验：符号检验精确二项 + 种子化 bootstrap CI');

{
  // 精确二项锚点：8 胜 0 负 → p = 2·0.5⁸ = 0.0078125（精确、非正态近似）
  const exact = pairedSignTest([1, 1, 1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0, 0, 0]);
  ok(near(exact.pValue, 0.0078125, 1e-12), `符号检验精确二项锚点：8胜0负 p = ${exact.pValue}（= 2·0.5⁸）`);
  ok(exact.significant && exact.direction === 'A-better', '方向裁决 A-better（p < α）');
  ok(exact.n === 8 && exact.ties === 0, 'n = 8、并列 0');

  // 并列剔除口径
  const tie = pairedSignTest([1, 1, 0], [1, 0, 0]);
  ok(tie.n === 1 && tie.ties === 2 && !tie.significant, `并列剔除：胜1负0平2 → n=1、p=${tie.pValue.toFixed(3)} 不显著`);

  // 同分布流 → 不显著
  const same = pairedSignTest([0.5, 0.6, 0.4, 0.55, 0.45], [0.55, 0.45, 0.5, 0.4, 0.6]);
  ok(!same.significant && same.direction === 'tie', `同分布流不硬选方向（p = ${same.pValue.toFixed(3)}）`);

  // 已知强弱分数流：Bernoulli(0.65) vs Bernoulli(0.5)，n=300——检验功效
  //（并列剔除后有效配对 ≈ 150，0.65 vs 0.5 方向概率 → 精确二项功效 ≈ 0.98）
  let hits = 0;
  const TRIALS = 60;
  for (let t = 0; t < TRIALS; t += 1) {
    const rng = mulberry32(20260101 + t);
    const a = [];
    const b = [];
    for (let i = 0; i < 300; i += 1) {
      a.push(rng() < 0.65 ? 1 : 0);
      b.push(rng() < 0.5 ? 1 : 0);
    }
    const r = pairedSignTest(a, b);
    if (r.significant && r.direction === 'A-better') hits += 1;
  }
  ok(hits / TRIALS >= 0.9, `已知强弱流检验功效 = ${hits}/${TRIALS} ≥ 0.9（真差异逃不掉）`);

  // 同分布流假阳性
  let fp = 0;
  for (let t = 0; t < TRIALS; t += 1) {
    const rng = mulberry32(20260201 + t);
    const a = [];
    const b = [];
    for (let i = 0; i < 150; i += 1) {
      a.push(rng() < 0.5 ? 1 : 0);
      b.push(rng() < 0.5 ? 1 : 0);
    }
    if (pairedSignTest(a, b).significant) fp += 1;
  }
  ok(fp / TRIALS <= 0.12, `同分布流假阳性 = ${fp}/${TRIALS} ≤ 0.12（α=0.05 + 抽样容差）`);

  // 种子化 bootstrap CI：确定性
  const rngS = mulberry32(7);
  const sa = [];
  const sb = [];
  for (let i = 0; i < 120; i += 1) {
    sa.push(rngS() < 0.65 ? 1 : 0);
    sb.push(rngS() < 0.5 ? 1 : 0);
  }
  const ci1 = bootstrapDifferenceCi(sa, sb, { seed: 20261002, iterations: 800 });
  const ci2 = bootstrapDifferenceCi(sa, sb, { seed: 20261002, iterations: 800 });
  ok(
    near(ci1.lower, ci2.lower, 0) && near(ci1.upper, ci2.upper, 0) && ci1.seed === ci2.seed,
    `同种子同区间（lower=${ci1.lower.toFixed(4)}, upper=${ci1.upper.toFixed(4)}——种子化可复现审计）`,
  );
  ok(ci1.lower <= ci1.upper, 'CI 区间有序（lower ≤ upper）');
  ok(ci1.excludesZero && ci1.lower > 0, `已知强弱流 CI 不含 0（中心差 ${ci1.observedDifference.toFixed(3)}）`);

  // CI 覆盖率：真差 0.15，名义 95%，300 试验
  let covered = 0;
  const COV = 300;
  for (let t = 0; t < COV; t += 1) {
    const rng = mulberry32(20260301 + t * 17);
    const a = [];
    const b = [];
    for (let i = 0; i < 120; i += 1) {
      a.push(rng() < 0.65 ? 1 : 0);
      b.push(rng() < 0.5 ? 1 : 0);
    }
    const ci = bootstrapDifferenceCi(a, b, { seed: 20260400 + t, iterations: 600 });
    if (0.15 >= ci.lower && 0.15 <= ci.upper) covered += 1;
  }
  const covRate = covered / COV;
  ok(covRate >= 0.9 && covRate <= 0.99, `CI 覆盖率 = ${covRate.toFixed(3)} ∈ [0.90, 0.99]（名义 95%，真差 0.15 被区间覆盖）`);

  // 完整裁决句
  const verdict = pairedModelComparison('model-a', sa, 'model-b', sb, { seed: 1, iterations: 400 });
  ok(
    verdict.conclusion.includes('model-a') && verdict.conclusion.includes('显著') && verdict.signTest.pValue < 0.05,
    'pairedModelComparison 结论句含双方名 + 显著性（机器可读 + 人可读）',
  );

  // 非法输入防御
  okThrow(() => pairedSignTest([1, 2], [1]), 'pairedSignTest: 长度不一致 → throw');
  okThrow(() => bootstrapDifferenceCi([], []), 'bootstrapDifferenceCi: 空数组 → throw');
}

// ═══════════════════ ② e-过程回归检测器 ═══════════════════

section('② e-过程回归检测器：累积证据超阈报警 + 偷看免疫');

{
  // 确定性强回归流：baseline 0.8、全 0.1 → 因子 ≈ 1.12^t，30 步内必报警
  const det = new BenchmarkRegressionDetector({ baseline: 0.8, alpha: 0.05 });
  let alarmStep = -1;
  for (let i = 0; i < 30; i += 1) {
    const v = det.observe(0.1);
    if (v.alarm && alarmStep < 0) alarmStep = i + 1;
  }
  const v30 = det.view();
  ok(v30.alarm && alarmStep > 0, `确定性强回归流第 ${alarmStep} 步报警（e = ${v30.capital} ≥ 1/α = ${v30.threshold}）`);
  ok(v30.anytimeP <= 0.05, `任意时刻有效 p = ${v30.anytimeP} ≤ α（超均匀口径）`);
  ok(near(v30.sampleMean, 0.1, 1e-9), '样本均值口径正确（0.1）');

  // 视图纯读取（不推进状态）
  const vAgain = det.view();
  ok(vAgain.n === v30.n && near(vAgain.capital, v30.capital, 0), 'view() 纯读取（两次读数一致，n 不变）');

  // 平稳段误报率：μ = μ0 = 0.8，300 步逐偷看（每步都查——偷看免疫口径）
  let falseAlarms = 0;
  const S1 = 200;
  for (let s = 0; s < S1; s += 1) {
    const rng = mulberry32(20260500 + s);
    const detS = new BenchmarkRegressionDetector({ baseline: 0.8, alpha: 0.05 });
    let alarmed = false;
    for (let i = 0; i < 300; i += 1) {
      const v = detS.observe(rng() < 0.8 ? 1 : 0);
      if (v.alarm) {
        alarmed = true;
        break;
      }
    }
    if (alarmed) falseAlarms += 1;
  }
  ok(falseAlarms / S1 <= 0.08, `平稳段 300 步逐偷看误报率 = ${falseAlarms}/${S1} ≤ 0.08（Ville：任意时刻 P(e ≥ 1/α) ≤ α = 0.05——边看边查不膨胀假阳性）`);

  // 回归注入检测功率：0.8 平稳 60 步 → 0.5 回归至 300 步
  let detected = 0;
  const S2 = 200;
  for (let s = 0; s < S2; s += 1) {
    const rng = mulberry32(20260600 + s);
    const detR = new BenchmarkRegressionDetector({ baseline: 0.8, alpha: 0.05 });
    let alarmed = false;
    for (let i = 0; i < 300; i += 1) {
      const mu = i < 60 ? 0.8 : 0.5;
      const v = detR.observe(rng() < mu ? 1 : 0);
      if (v.alarm) {
        alarmed = true;
        break;
      }
    }
    if (alarmed) detected += 1;
  }
  ok(detected / S2 >= 0.88, `回归注入（0.8→0.5）报警功率 = ${detected}/${S2} ≥ 0.88（真回归快速越阈）`);

  // 参数防御
  okThrow(() => new BenchmarkRegressionDetector({ baseline: 1.5 }), 'baseline ∉ [0,1] → throw');
  okThrow(() => new BenchmarkRegressionDetector({ baseline: 0.5, alpha: 0 }), 'alpha ∉ (0,1) → throw');
}

// ═══════════════════ ③ BAI 聚焦跑分预算 ═══════════════════

section('③ BAI 聚焦跑分预算：同预算识别率 ≥ 均匀（差距已明确模型集）');

const KNOWN_MUS = [0.5, 0.45, 0.4, 0.3, 0.1];
{
  // 预算纪律 + 确定性
  const p1 = baiFocusedBudgetAllocation(KNOWN_MUS, 3000, 42);
  const p2 = baiFocusedBudgetAllocation(KNOWN_MUS, 3000, 42);
  ok(sum(p1.samplesPerArm) <= 3000, `SH 预算纪律：Σ = ${sum(p1.samplesPerArm)} ≤ 3000`);
  ok(JSON.stringify(p1) === JSON.stringify(p2), 'SH 同种子确定性（逐位一致）');
  ok(p1.rounds >= 1, `SH 减半轮数 = ${p1.rounds}（K=5 → ⌈log₂5⌉ = 3 轮上限）`);

  // 同预算识别率对照：500 种子
  let shHit = 0;
  let uniHit = 0;
  const SEEDS = 500;
  for (let s = 0; s < SEEDS; s += 1) {
    if (baiFocusedBudgetAllocation(KNOWN_MUS, 3000, 910000 + s).best === 0) shHit += 1;
    if (uniformBudgetAllocation(KNOWN_MUS, 3000, 910000 + s).best === 0) uniHit += 1;
  }
  ok(shHit / SEEDS >= 0.95, `SH 锦标赛识别率 = ${(shHit / SEEDS).toFixed(3)} ≥ 0.95（budget=3000）`);
  ok(shHit > uniHit, `同预算识别率 SH ${(shHit / SEEDS).toFixed(3)} > 均匀 ${(uniHit / SEEDS).toFixed(3)}（样本流向难分臂，73.0 口径自实现对齐）`);

  // 均匀对照形态
  const uni = uniformBudgetAllocation(KNOWN_MUS, 3000, 7);
  ok(uni.samplesPerArm.every((n) => n === 600) && uni.rounds === 0, '均匀对照：每臂 ⌊3000/5⌋ = 600、rounds = 0（公平基线）');

  // 输入防御
  okThrow(() => baiFocusedBudgetAllocation([], 100), 'SH: mus 空 → throw');
  okThrow(() => baiFocusedBudgetAllocation([0.5, 1.5], 100), 'SH: μ ∉ [0,1] → throw');
  okThrow(() => uniformBudgetAllocation([0.5], 0), '均匀: budget < 1 → throw');
}

// ═══════════════════ ④⑤ 引擎集成：runAll 附加位 + 结构化导出 + 兼容 ═══════════════════

section('④ 引擎集成：runAll 附加位 / 零漂移 / 结构化导出');

/** 两条快速确定性场景（成功率 1.0 / 0.5——BAI 与统计检验的已知差距） */
function makeEngine(dir) {
  const engine = new BenchmarkEngine(dir);
  engine.registerScenario({
    name: 'alpha-strong',
    description: '已知强场景（成功率 1.0）',
    target: 'memory',
    concurrency: 2,
    totalRequests: 12,
    warmupRequests: 2,
    timeout: 2000,
    execute: async () => ({ success: true, latency: 1 }),
  });
  engine.registerScenario({
    name: 'beta-weak',
    description: '已知弱场景（成功率 0.5）',
    target: 'memory',
    concurrency: 2,
    totalRequests: 12,
    warmupRequests: 2,
    timeout: 2000,
    execute: async (i) => (i % 2 === 0 ? { success: true, latency: 2 } : { success: false, latency: 2, error: 'synthetic-weak' }),
  });
  return engine;
}

const dirPlain = tempDir('dsh-a15-plain-');
const plainEngine = makeEngine(dirPlain);
{
  const report = await plainEngine.runAll();
  ok(report.scenarios.length === 2, 'runAll 执行两条场景');

  // 零漂移：未挂载任何 attach → 三个附加位缺席（与既有 wiring 脚本同口径）
  ok(report.baiFocus === undefined, '未挂载 attachBaiSelector → 无 baiFocus（零漂移）');
  ok(report.bottleneckFocus === undefined, '未挂载 attachOcbaAllocator → 无 bottleneckFocus（零漂移）');
  ok(report.regressionAlarm === undefined, '未挂载 attachRegressionDetector → 无 regressionAlarm（零漂移）');

  // budgetPlan：未挂载 → 均匀（任务口径：attach 则聚焦否则均匀）
  ok(
    report.budgetPlan !== undefined && report.budgetPlan.strategy === 'uniform' && report.budgetPlan.allocation.every((a) => a.count === 60),
    `未挂载 → budgetPlan 均匀分配（每场景 ⌊120/2⌋ = 60）`,
  );

  // 未挂载时手动喂分 → undefined（观察口未开）
  ok(plainEngine.observeBenchmarkScore(0.5) === undefined && plainEngine.regressionAlarmView() === undefined, '未挂载回归检测器 → 喂分/读数均 undefined');

  // planBenchmarkBudget：挂载后 → bai-focus
  plainEngine.attachBaiSelector({ budget: 3000 });
  const focused = plainEngine.planBenchmarkBudget({
    scores: [
      { name: 'm1', score: 0.5 },
      { name: 'm2', score: 0.45 },
      { name: 'm3', score: 0.4 },
      { name: 'm4', score: 0.3 },
      { name: 'm5', score: 0.1 },
    ],
  });
  ok(focused.strategy === 'bai-focus' && focused.totalBudget === 3000, '挂载 attachBaiSelector → budgetPlan 切换 bai-focus（对接 73.0 视图）');
  ok(sum(focused.allocation.map((a) => a.count)) <= 3000, `聚焦分配预算纪律：Σ = ${sum(focused.allocation.map((a) => a.count))} ≤ 3000`);
  ok(focused.allocation[1].count > focused.allocation[4].count, `样本流向难分臂：m2(${focused.allocation[1].count}) > m5(${focused.allocation[4].count})——悬殊臂早停`);
  ok(focused.rationale.includes('73.0'), '聚焦理由注明 73.0 口径');
  const emptyPlan = plainEngine.planBenchmarkBudget({ scores: [] });
  ok(emptyPlan.totalBudget === 0 && emptyPlan.strategy === 'uniform', '无基线分数 → 预算 0（诚实不假装分配）');

  // 结构化导出（含成对检验 extras）
  const rngP = mulberry32(31);
  const sa = [];
  const sb = [];
  for (let i = 0; i < 90; i += 1) {
    sa.push(rngP() < 0.7 ? 1 : 0);
    sb.push(rngP() < 0.45 ? 1 : 0);
  }
  const structured = plainEngine.exportStructuredReport(report, {
    pairwise: [{ aName: 'model-a', aScores: sa, bName: 'model-b', bScores: sb, seed: 5, iterations: 500 }],
  });
  const roundTrip = JSON.parse(JSON.stringify(structured));
  ok(roundTrip.reportId === report.id && roundTrip.scenarios.length === 2, '结构化导出 JSON 往返（reportId / 场景齐备）');
  ok(roundTrip.scenarios.every((s) => typeof s.score === 'number' && Array.isArray(s.thresholdViolations)), '场景分数 + 违反项齐备');
  ok(
    roundTrip.pairwise.length === 1 && roundTrip.pairwise[0].signTest.pValue < 0.05 && roundTrip.pairwise[0].bootstrap.excludesZero,
    '成对检验结论携带 p 值 + CI 不含 0（显著性证据面）',
  );
  ok(Array.isArray(roundTrip.suggestions) && roundTrip.suggestions.length > 0 && roundTrip.suggestions.every((s) => typeof s === 'string'), `建议 ${roundTrip.suggestions.length} 条（可执行行动项）`);
  ok(roundTrip.budgetPlan !== undefined, '结构化导出携带预算计划');

  // 挂载三件套后再跑：附加位齐活 + 导出回显
  const dirFull = tempDir('dsh-a15-full-');
  const fullEngine = makeEngine(dirFull);
  fullEngine.attachBaiSelector({ budget: 120 });
  fullEngine.attachRegressionDetector({ baseline: 0.9, alpha: 0.05 });
  const fullReport = await fullEngine.runAll();
  ok(fullReport.baiFocus !== undefined && fullReport.baiFocus.recommended === 'alpha-strong', `挂载 BAI → 锦标赛冠军 = ${fullReport.baiFocus?.recommended}（已知强场景）`);
  ok(
    fullReport.regressionAlarm !== undefined && fullReport.regressionAlarm.n === 2 && fullReport.regressionAlarm.alarm === false,
    '挂载回归检测器 → 逐场景喂分（n=2），均值 0.75 未越阈不误报',
  );
  ok(fullReport.budgetPlan !== undefined && fullReport.budgetPlan.strategy === 'bai-focus', '挂载态 runAll → budgetPlan = bai-focus');
  const fullStructured = fullEngine.exportStructuredReport(fullReport);
  ok(fullStructured.baiFocus !== undefined && fullStructured.regression !== undefined, '结构化导出回显 baiFocus + 回归视图');
  ok(fullStructured.suggestions.some((s) => s.includes('下一轮跑分预算')), '建议含下一轮预算行动项');

  // ⑤ 旧挂载面兼容：Hyperband（93.0）行为不变
  fullEngine.attachHyperbandTuner({ eta: 3, seed: 11 });
  const hb = fullEngine.hyperbandTune(
    [{ q: 1 }, { q: 2 }, { q: 3 }],
    (c, b) => 1 - Math.exp((-c.q * b) / 10),
    27,
  );
  ok(hb !== undefined && hb.bestConfig.q === 3 && near(hb.totalBudgetSpent, hb.schedule.totalBudget, 1e-9), 'attachHyperbandTuner 兼容：bestConfig = 最强配置、预算对账守恒');
  const noTune = makeEngine(tempDir('dsh-a15-notune-')).hyperbandTune([{ q: 1 }], () => 1, 9);
  ok(noTune === undefined, '未挂载 hyperbandTuner → 寻优缺席（零漂移）');
}

// ═══════════════════ ⑥ Dashboard：loopback 集成 ═══════════════════

section('⑥ Dashboard 数据绑定：/api/kernel-map · /api/gwt-bus · /api/attention-market');

const KERNEL_FLAGS_SAMPLE = [
  { name: 'baiSelector', version: '73.0', enabled: true },
  { name: 'globalWorkspace', version: '96.0', enabled: true },
  { name: 'attentionEconomy', version: '99.0', enabled: true },
  { name: 'selfBoundary', version: '100.0', enabled: false },
];
const GWT_SAMPLE = {
  steps: 42,
  ignitionRatio: 0.5,
  entropy: 0.971,
  winCounts: [
    { id: 'sentinel', wins: 12 },
    { id: 'decision', wins: 9 },
  ],
  recentBroadcasts: [
    { step: 39, tags: [], ignited: false },
    { step: 41, winner: 'sentinel', effectiveBid: 0.62, tags: ['error-burst'], ignited: true },
    { step: 40, winner: 'decision', effectiveBid: 0.55, tags: ['budget-alert'], ignited: true },
  ],
};
const ATTENTION_SAMPLE = {
  slots: 4,
  awards: [
    { sourceId: 'errors', slotNumber: 1, marginal: 0.9 },
    { sourceId: 'errors', slotNumber: 2, marginal: 0.5 },
    { sourceId: 'perf', slotNumber: 1, marginal: 0.4 },
  ],
  payments: [
    { sourceId: 'errors', payment: 0.6 },
    { sourceId: 'perf', payment: 0.3 },
  ],
  marginalPrice: 0.35,
  idleSlots: 1,
  revenue: 0.9,
  insight: '4 槽深看出清：errors / perf，边际价格 0.350',
};

async function startBroadcaster() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = 23180 + Math.floor(Math.random() * 2000);
    const broadcaster = new ProgressBroadcaster(port);
    broadcaster.start();
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i += 1) {
      try {
        const res = await fetch(`${base}/api/none`);
        if (res) return { broadcaster, base };
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    broadcaster.stop();
  }
  throw new Error('无法启动 ProgressBroadcaster 测试端口');
}

const { broadcaster, base } = await startBroadcaster();
try {
  const unmount = attachDashboard(
    broadcaster,
    () => [],
    {
      getKernelFlags: () => KERNEL_FLAGS_SAMPLE,
      getGwtBus: () => GWT_SAMPLE,
      getAttentionMarket: () => ATTENTION_SAMPLE,
    },
  );

  // 页面：三面板锚点
  const page = await (await fetch(`${base}/`)).text();
  ok(
    page.includes('id="kernel-map"') && page.includes('id="gwt-panel"') && page.includes('id="attention-panel"'),
    'GET / 页面含三面板锚点（kernel-map / gwt-panel / attention-panel）',
  );

  // 内核地图端点
  const kmap = await (await fetch(`${base}/api/kernel-map`)).json();
  ok(kmap.total === 98, `内核总数 = ${kmap.total}（3.0→100.0 百数封顶）`);
  ok(kmap.layers.length === 20, `层数 = ${kmap.layers.length}（第 20 层意识层 96–100 封顶）`);
  ok(kmap.flagged === 50, `旗标内核 = ${kmap.flagged}（51.0→100.0 五十旗标）`);
  ok(kmap.enabled === 3, `开启旗标 = ${kmap.enabled}（绑定 3 开 1 关）`);
  const proof = kmap.layers.find((l) => l.index === 15);
  ok(proof !== undefined && proof.name === '证明层' && proof.range === '71.0–75.0', `第 15 层证明层区间 71.0–75.0`);
  const baiKernel = proof?.kernels.find((k) => k.version === '73.0');
  ok(baiKernel !== undefined && baiKernel.enabled === true && baiKernel.flagName === 'baiSelector', '73.0 最佳臂识别旗标 baiSelector 开（introspect 绑定合并）');
  const kernel3 = kmap.layers[0].kernels[0];
  ok(kernel3.version === '3.0' && kernel3.hasFlag === false && kernel3.enabled === false, '3.0 证据：常驻内核无旗标（缺省关显示口径）');
  const mind = kmap.layers.find((l) => l.index === 20);
  ok(mind?.name === '意识层' && mind?.kernels.map((k) => k.version).join(',') === '96.0,97.0,98.0,99.0,100.0', '第 20 层意识层：96→100 五内核封顶');

  // GWT 端点
  const gwt = await (await fetch(`${base}/api/gwt-bus`)).json();
  ok(gwt.available === true && gwt.steps === 42 && near(gwt.ignitionRatio, 0.5, 1e-12), 'GWT 视图回显（步数 / 点火率）');
  ok(gwt.broadcasts.length === 3 && gwt.broadcasts[0].step === 41 && gwt.broadcasts[0].winner === 'sentinel', '最近广播流步序降序（最新在前：步 41 sentinel 胜者）');
  ok(gwt.broadcasts.some((b) => b.ignited && typeof b.effectiveBid === 'number'), '广播行携带胜者 / 优先级 / 点火态');

  // 注意力市场端点
  const attn = await (await fetch(`${base}/api/attention-market`)).json();
  ok(attn.available === true && attn.slots === 4 && attn.awarded === 3 && attn.idleSlots === 1, '槽位面板：4 槽 3 出清 1 空置');
  const errorsRow = attn.rows.find((r) => r.sourceId === 'errors');
  const perfRow = attn.rows.find((r) => r.sourceId === 'perf');
  ok(errorsRow !== undefined && errorsRow.slots === 2 && near(errorsRow.totalMarginal, 1.4, 1e-9) && near(errorsRow.payment, 0.6, 1e-9), 'errors 源聚合：2 槽 / 累计边际 1.4 / VCG 支付 0.6');
  ok(perfRow !== undefined && perfRow.slots === 1 && near(perfRow.payment, 0.3, 1e-9), 'perf 源聚合：1 槽 / 支付 0.3');
  ok(near(attn.marginalPrice, 0.35, 1e-12) && near(attn.revenue, 0.9, 1e-12), '边际价格 0.35 / 拍卖收入 0.9');

  // 模型状态端点（既有口径不回归）
  const models = await (await fetch(`${base}/api/model-status`)).json();
  ok(Array.isArray(models) && models.length === 0, 'GET /api/model-status 既有端点不变（[]）');

  // 撤掉数据源（两参重挂——既有调用形态）→ 三端点空态
  const unmount2 = attachDashboard(broadcaster, () => []);
  const kmapEmpty = await (await fetch(`${base}/api/kernel-map`)).json();
  const gwtEmpty = await (await fetch(`${base}/api/gwt-bus`)).json();
  const attnEmpty = await (await fetch(`${base}/api/attention-market`)).json();
  ok(kmapEmpty.note.includes('未注入') && kmapEmpty.enabled === 0, '撤源 → 内核地图静态空态（旗标缺省关）');
  ok(gwtEmpty.available === false && gwtEmpty.emptyState.includes('未挂载'), '撤源 → GWT 端点空态（未挂载提示）');
  ok(attnEmpty.available === false && attnEmpty.emptyState.includes('未挂载'), '撤源 → 注意力市场端点空态');

  // 卸载 → 恢复默认健康检查
  unmount2();
  const health = await (await fetch(`${base}/`)).json();
  ok(health.service === 'dsh-proactive/progress-ws', '卸载 → 恢复 progress-ws 默认健康检查');
  void unmount;
} finally {
  broadcaster.stop();
}

// ═══════════════════ ⑦ HTML 离线结构断言 ═══════════════════

section('⑦ HTML 离线结构断言：锚点 / 无新外链 / 绑定 id 一致');

{
  const htmlPath = new URL('../src/dashboard/index.html', import.meta.url);
  const html = fs.readFileSync(htmlPath, 'utf-8');

  // 三面板锚点 + 渲染容器
  for (const anchor of ['kernel-map', 'kernel-map-body', 'kernel-flag-badge', 'gwt-panel', 'gwt-feed', 'attention-panel', 'attention-table']) {
    ok(html.includes(`id="${anchor}"`), `面板锚点 id="${anchor}" 存在`);
  }

  // 无新外链（零外部静态资源约束）
  ok(!html.includes('<link'), '无 <link> 外链');
  ok(!/<script[^>]+src=/.test(html), '无外链 <script src=…>');
  ok(!/(src|href)\s*=\s*"https?:/.test(html), '无 http(s) 外链资源');
  ok(!/url\(\s*https?:/.test(html), 'CSS 无外链 url(…)');

  // 脚本引用的 $('id') 全部存在（绑定一致性）
  const refIds = new Set();
  for (const m of html.matchAll(/\$\('([^']+)'\)/g)) refIds.add(m[1]);
  const missing = [...refIds].filter((id) => !html.includes(`id="${id}"`));
  ok(refIds.size > 20 && missing.length === 0, `脚本引用 ${refIds.size} 个 id 全部存在于文档（缺失 ${missing.length}）`);

  // 四端点路径在案
  for (const ep of ['/api/model-status', '/api/kernel-map', '/api/gwt-bus', '/api/attention-market']) {
    ok(html.includes(`'${ep}'`), `端点 ${ep} 在客户端拉取清单`);
  }
  ok(html.includes("'/ws'"), 'WebSocket /ws 通道保持');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 第三轮 A15（benchmark 统计证据面 + dashboard 三面板）升级验证成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
