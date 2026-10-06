/**
 * verify-r4-bench-dash.mjs — 第四轮模块域 R4-A15：benchmark + dashboard 全新维度验证
 *
 *   src/benchmark/benchmark-engine.ts / src/dashboard/index.ts / src/dashboard/index.html
 *
 * 五项全新维度各配「旧世界 vs 新世界」的构造对照（不是「改了」，是「证明更好」）：
 *   ⓪ 零漂移总检：全部 R4 面缺省时 runAll 报告无 trendTracking、
 *      trendSeriesViews()/recommendModel()/recommendationHitStats() 全部
 *      undefined / 空数组——既有第三轮 API（pairedSignTest /
 *      attachRegressionDetector / exportStructuredReport）行为不变。
 *   ① R4-1 长期基准追踪：注入时钟 + 滚动存档。「先稳后降」流（12 点 0.80
 *      ±噪声 → 6 点 0.50 ±噪声）Theil–Sen 斜率 < 0、Mann–Kendall p < α
 *      显著下降、最近 5 次均值 vs 历史基线 Mann–Whitney p < α 显著低于、
 *      driftDetected=true；「缓降 + 噪声」流上旧口径（相邻两点差分）≥ 4 步
 *      误读「无劣化」，新口径一眼看穿；平稳流（特定种子）零误报 + 48 种子
 *      误报率 ≤ 0.12（名义 α=0.05 + 双链单侧各 α/2 的抽样容差）；maxHistory
 *      滚动截断、view() 纯读取、engine 挂载后 runAll 逐场景喂分。
 *   ② R4-2 模型推荐引擎：三型三模型已知特长分布历史表——held-out 12 任务
 *      推荐命中率 12/12 = 1.0 > 随机基线（种子化随机 ≈ 1/3）；零距离档位 →
 *      specialized、档位间 → interpolated（泛化插值仍荐正确）、未知类型 /
 *      极端预算 → global-fallback 诚实回退全局最优（置信封顶 0.5）；
 *      rolling 命中率窗口口径；确定性（两次推荐逐位一致）。
 *   ③ R4-4 基准对比矩阵：3 模型 × 4 场景构造流——每格相对场景最优百分比 +
 *      heat ∈ [0,1] 热力数据 + 显著性标记；标记与第三轮 pairedSignTest 逐对
 *      检验完全一致（同输入同裁决）；long-ctx 场景 0.525 vs 0.500 均值差
 *      ——旧口径宣布「writer 胜出」，新口径 ns（统计上分不出）；非法输入
 *      （不等长 / 未知模型 / 重复观测 / 空流）诚实抛错；Markdown 导出在案。
 *   ④ R4-3 实时告警面板：alarmFeedPayload 纯函数（时间倒序 + 同刻 id 升序
 *      / 严重度分色计数 / 来源 chip 全量口径 / 过滤 + 截断 / 脏严重度按 info）
 *      + loopback 集成（/api/alarm-feed 注入 → 全字段、?source= 过滤、
 *      撤源空态、卸载恢复健康检查）+ HTML 离线结构断言（面板锚点 / 绑定 id /
 *      空态 / 端点清单 / 零外链）。
 *   ⑤ R4-5 布局持久化（加分）：序列化往返恒等 parse(serialize(normalize(p)))
 *      ≡ normalize(p)；坏输入（null / 烂 JSON / 版本不符 / 字段形状错）回退
 *      默认；未知面板 id 过滤 + 缺失面板默认序补齐；visibleOrderedPanels
 *      显隐序口径；新旧面板集演化（新增面板自动可见）。
 *   ⑥ 确定性重放：趋势流 / 推荐表 / 矩阵全量重跑逐位一致（注入时钟 + 种子
 *      化，无 wall-clock 依赖）。
 *
 * 全程离线确定性（mulberry32 / 注入时钟；临时持久化文件用后即删）。
 * 末尾 PASS n / FAIL m，失败 exit 1。
 *
 * 运行：npm run build && node --experimental-transform-types scripts/verify-r4-bench-dash.mjs
 *（dashboard 纯函数未从根入口导出——直连 src/dashboard/index.ts，
 *  verify-mod-integration.mjs 直连 src 先例同款）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as dsh from '../dist/index.mjs';
import {
  alarmFeedPayload,
  classifyAlarmSeverity,
  DASHBOARD_LAYOUT_STORAGE_KEY,
  DEFAULT_DASHBOARD_PANELS,
  defaultDashboardLayout,
  normalizeDashboardLayout,
  serializeDashboardLayout,
  parseDashboardLayout,
  visibleOrderedPanels,
} from '../src/dashboard/index.ts';

const {
  BenchmarkEngine,
  BenchmarkTrendTracker,
  BenchmarkRecommender,
  buildBenchmarkMatrix,
  benchmarkMatrixToMarkdown,
  pairedSignTest,
  ProgressBroadcaster,
  attachDashboard,
} = dsh;

// ─────────────────────────── 断言工具（仓库惯例） ───────────────────────────
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
function near(actual, expected, tol = 1e-9, label) {
  const hit = Math.abs(actual - expected) <= tol;
  ok(hit, `${label}（实际 ${typeof actual === 'number' ? actual.toFixed(6) : actual}，期望 ${typeof expected === 'number' ? expected.toFixed(6) : expected} ± ${tol}）`);
}
function section(title) {
  console.log(`\n■ ${title}`);
}
/** 确定性随机源（mulberry32——与内核同款，种子化可复现） */
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

// ═══════════════════ ⓪ 零漂移总检 + 兼容面 ═══════════════════

section('⓪ 零漂移总检：R4 面缺省时新读数缺席，第三轮 API 行为不变');

/** 两条快速确定性场景（成功率 1.0 / 0.5——既有 verify 同款） */
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

{
  const plain = makeEngine(tempDir('dsh-r4-plain-'));
  const report = await plain.runAll();
  ok(report.trendTracking === undefined, '未挂载 attachTrendTracker → 报告无 trendTracking（零漂移）');
  ok(plain.trendSeriesViews().length === 0, '未挂载 → trendSeriesViews() = []');
  ok(plain.recordTrendPoint('m', 0.5) === undefined, '未挂载 → recordTrendPoint 返回 undefined（观察口未开）');
  ok(plain.recommendModel({ type: 'code', complexity: 0.5, budget: 100 }) === undefined, '未挂载 → recommendModel undefined');
  ok(plain.recommendationHitStats() === undefined, '未挂载 → recommendationHitStats undefined');
  ok(report.budgetPlan !== undefined && report.budgetPlan.strategy === 'uniform', '第三轮 budgetPlan 口径不变（未挂载 → uniform）');
  // 第三轮 API 兼容面：符号检验精确锚点不回归
  const exact = pairedSignTest([1, 1, 1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0, 0, 0]);
  near(exact.pValue, 0.0078125, 1e-12, '第三轮 pairedSignTest 锚点不回归（8胜0负 p = 2·0.5⁸）');
}

// ═══════════════════ ① 长期基准追踪 ═══════════════════

section('① 长期基准追踪：趋势斜率 + 显著性 + 最近 N 次 vs 历史基线（先稳后降检出 / 平稳零误报）');

/** 注入时钟（确定性——无 wall-clock 依赖） */
function manualClock(start = 1_700_000_000_000, step = 60_000) {
  let t = start;
  return () => (t += step);
}

// —— 「先稳后降」流：12 点 0.80±0.02 → 6 点 0.50±0.02（种子化噪声）——
const rngDecline = mulberry32(42);
const declineStream = [];
for (let i = 0; i < 12; i += 1) declineStream.push(0.8 + (rngDecline() - 0.5) * 0.04);
for (let i = 0; i < 6; i += 1) declineStream.push(0.5 + (rngDecline() - 0.5) * 0.04);

{
  const clock = manualClock();
  const tracker = new BenchmarkTrendTracker({ windowSize: 5, alpha: 0.05, now: clock });
  for (const s of declineStream) tracker.record('model-x', s);
  const v = tracker.view('model-x');
  ok(v !== undefined && v.n === 18, `滚动存档 18 点（maxHistory=40 全量在案）`);
  ok(v.slope < -0.01, `Theil–Sen 斜率 = ${v.slope.toFixed(4)} < -0.01（稳健中位斜率——单点噪声不动摇；逐对斜率中位数在高-高/低-低近零对的稀释下仍显著为负）`);
  ok(v.trend.significant && v.trend.direction === 'down', `Mann–Kendall 显著下降（p = ${v.trend.pValue.toFixed(5)} < 0.05，S = ${v.trend.s}）`);
  near(v.recentMean, 0.5, 0.02, `最近 5 次均值 ≈ 0.50（实际窗口均值）`);
  ok(Math.abs(v.baselineMean - 0.8) <= 0.03, `历史基线均值 ≈ 0.80（实际 ${v.baselineMean.toFixed(4)} ± 噪声容差）`);
  ok(v.recentVsBaseline.verdict === 'below' && v.recentVsBaseline.significant, `最近 N 次 vs 历史基线：显著低于（Mann–Whitney p = ${v.recentVsBaseline.pValue.toFixed(5)}）`);
  ok(v.driftDetected, 'driftDetected = true（分数漂移检出——趋势 + 近窗双证据链任一确证）');
  ok(v.insight.includes('model-x') && v.insight.includes('漂移'), `中文读数在案（${v.insight.slice(0, 42)}…）`);
  // 注入时钟口径：时间戳来自时钟而非 wall-clock
  ok(v.lastTimestamp - v.firstTimestamp === 17 * 60_000, '时间戳来自注入时钟（18 点 × 60s 步进，首末差 17 分钟）');
  // view() 纯读取
  const again = tracker.view('model-x');
  ok(JSON.stringify(again) === JSON.stringify(v), 'view() 纯读取（两次读数逐位一致）');

  // —— 旧 vs 新 ①：「缓降 + 噪声」流上两点差分口径频繁误读，新口径一眼看穿 ——
  const rngGradual = mulberry32(101);
  const gradual = [];
  for (let i = 0; i < 16; i += 1) gradual.push(0.8 - i * 0.02 + (rngGradual() - 0.5) * 0.08);
  let oldMisread = 0;
  for (let i = 1; i < gradual.length; i += 1) if (gradual[i] - gradual[i - 1] >= 0) oldMisread += 1;
  const gTracker = new BenchmarkTrendTracker({ windowSize: 5, alpha: 0.05 });
  for (const s of gradual) gTracker.record('m-g', s);
  const gv = gTracker.view('m-g');
  ok(
    oldMisread >= 4 && gv.trend.significant && gv.trend.direction === 'down' && gv.slope < -0.012,
    `旧 vs 新（缓降+噪声 16 点，真实斜率 -0.02/步、噪声 ±0.04）：相邻两点差分口径 ${oldMisread}/15 步误读「无劣化」——新口径 Theil–Sen 斜率 ${gv.slope.toFixed(4)}、Mann–Kendall p = ${gv.trend.pValue.toFixed(4)} 显著下降`,
  );

  // —— 平稳流：特定种子零误报 + 48 种子误报率 ≤ 0.12 ——
  const rngFlat = mulberry32(77);
  const flatStream = [];
  for (let i = 0; i < 20; i += 1) flatStream.push(0.8 + (rngFlat() - 0.5) * 0.06);
  const fTracker = new BenchmarkTrendTracker({ windowSize: 5, alpha: 0.05 });
  for (const s of flatStream) fTracker.record('m-f', s);
  const fv = fTracker.view('m-f');
  ok(!fv.driftDetected, `平稳流零误报（driftDetected = false，斜率 ${fv.slope.toExponential(2)} ≈ 0，Mann–Kendall p = ${fv.trend.pValue.toFixed(3)}）`);
  ok(fv.recentVsBaseline.verdict === 'stable', `近窗 vs 基线：stable（p = ${fv.recentVsBaseline.pValue.toFixed(3)} ≥ α）`);
  let flatOldCried = 0;
  for (let i = 1; i < flatStream.length; i += 1) if (Math.abs(flatStream[i] - flatStream[i - 1]) > 0.01) flatOldCried += 1;
  ok(flatOldCried >= 10, `旧 vs 新（平稳流）：两点差分口径 ${flatOldCried}/19 步喊「变化」——新口径 1 个稳定裁决（零误报）`);
  let falseAlarms = 0;
  const FLAT_SEEDS = 48;
  for (let s = 0; s < FLAT_SEEDS; s += 1) {
    const rng = mulberry32(5100 + s * 13);
    const tr = new BenchmarkTrendTracker({ windowSize: 5, alpha: 0.05 });
    for (let i = 0; i < 20; i += 1) tr.record('m', 0.8 + (rng() - 0.5) * 0.06);
    if (tr.view('m').driftDetected) falseAlarms += 1;
  }
  ok(
    falseAlarms / FLAT_SEEDS <= 0.12,
    `平稳流 48 种子误报率 = ${falseAlarms}/${FLAT_SEEDS} ≤ 0.12（名义 α=0.05：两条单侧 α/2 证据链 + 抽样容差）`,
  );

  // —— maxHistory 滚动截断 ——
  const rollClock = manualClock();
  const rollTracker = new BenchmarkTrendTracker({ windowSize: 4, maxHistory: 20, now: rollClock });
  for (let i = 0; i < 50; i += 1) rollTracker.record('m-roll', 0.5 + i * 0.001);
  const rv = rollTracker.view('m-roll');
  ok(rv.n === 20, `maxHistory=20 滚动截断：50 点存档后 n = 20（最旧 30 点滚动出窗）`);
  const rollPoints = rollTracker.points('m-roll');
  ok(rollPoints.length === 20 && Math.abs(rollPoints[0].score - (0.5 + 30 * 0.001)) <= 1e-12, '存档副本口径：首点 = 第 31 次记录（0.530）——副本只读');

  // —— views() 多序列确定性排序 + 历史不足诚实降级 ——
  const clock2 = manualClock();
  const multi = new BenchmarkTrendTracker({ windowSize: 5, now: clock2 });
  multi.record('b-model', 0.9);
  multi.record('a-model', 0.8);
  const vs = multi.views();
  ok(vs.length === 2 && vs[0].name === 'a-model' && vs[1].name === 'b-model', 'views() 按序列名升序（确定性）');
  ok(vs[0].n === 1 && vs[0].recentVsBaseline.verdict === 'insufficient', '单点序列：近窗 vs 基线诚实降级 insufficient（不假装对照）');

  // —— 引擎集成：挂载 → runAll 逐场景喂分 + 报告附加位 ——
  const dirTrend = tempDir('dsh-r4-trend-');
  const engineTrend = makeEngine(dirTrend);
  engineTrend.attachTrendTracker({ windowSize: 2, alpha: 0.05, now: manualClock() });
  const r1 = await engineTrend.runAll();
  ok(r1.trendTracking !== undefined && r1.trendTracking.series.length === 2, '挂载后 runAll → trendTracking.series 覆盖全部场景');
  ok(
    r1.trendTracking.series.every((s) => s.n === 1 && s.recentVsBaseline.verdict === 'insufficient'),
    '首轮每序列 1 点：历史不足诚实降级（不误报漂移）',
  );
  const r2 = await engineTrend.runAll();
  const alphaSeries = r2.trendTracking.series.find((s) => s.name === 'alpha-strong');
  ok(alphaSeries.n === 2 && !alphaSeries.driftDetected, `第二轮 n=2（滚动存档累积），恒定成功率流不误报`);
  const manual = engineTrend.recordTrendPoint('manual-model', 0.42);
  ok(manual !== undefined && manual.name === 'manual-model', 'recordTrendPoint 手动喂分入口在案（返回该序列视图）');
  ok(engineTrend.trendSeriesViews().length === 3, 'trendSeriesViews() 读数含 2 场景 + 1 手动序列');

  // —— 结构化导出回显 + 漂移行动项（跨轮集成：R4 趋势 → 第三轮导出面）——
  const structuredTrend = engineTrend.exportStructuredReport(r2);
  ok(structuredTrend.trendTracking !== undefined && structuredTrend.trendTracking.series.length === 2, 'exportStructuredReport 回显 trendTracking 快照');
  ok(!structuredTrend.suggestions.some((s) => s.includes('长期追踪')), '无漂移时导出不加长期追踪行动项（恒定流不误报）');
  const driftReport = {
    ...r2,
    trendTracking: {
      timestamp: r2.timestamp,
      series: [
        {
          name: 'leaky-model',
          n: 6,
          firstTimestamp: 1,
          lastTimestamp: 6,
          slope: -0.05,
          relativeSlope: -0.0625,
          trend: { s: -15, z: -2.6, pValue: 0.009, significant: true, direction: 'down' },
          recentWindow: 5,
          recentMean: 0.5,
          baselineN: 1,
          baselineMean: 0.8,
          recentVsBaseline: { delta: -0.3, pValue: 0.01, significant: true, verdict: 'below' },
          driftDetected: true,
          insight: '分数漂移检出：leaky-model …',
        },
      ],
    },
  };
  const driftStructured = engineTrend.exportStructuredReport(driftReport);
  ok(
    driftStructured.suggestions.some((s) => s.includes('长期追踪漂移检出') && s.includes('leaky-model')),
    '漂移序列在案 → 导出建议含「长期追踪漂移检出：leaky-model」行动项（激活与深化）',
  );

  // —— 输入防御 ——
  okThrow(() => new BenchmarkTrendTracker({ alpha: 0 }), 'alpha = 0 → throw');
  okThrow(() => new BenchmarkTrendTracker({ alpha: 1 }), 'alpha = 1 → throw');
}

// ═══════════════════ ② 模型推荐引擎 ═══════════════════

section('② 模型推荐引擎：任务特征 → 最优模型（查表 + 插值 + 诚实回退，命中率 > 随机）');

/** 已知特长分布：code→coder / doc→writer / math→reasoner（分差 ≥ 0.25 清晰可学） */
const SPECIALTY = {
  code: { coder: 0.85, writer: 0.6, reasoner: 0.55, best: 'coder' },
  doc: { coder: 0.58, writer: 0.86, reasoner: 0.52, best: 'writer' },
  math: { coder: 0.55, writer: 0.5, reasoner: 0.9, best: 'reasoner' },
};
const TRAIN_COMPLEXITY = [0.2, 0.5, 0.8];
const MODEL_IDS = ['coder', 'writer', 'reasoner'];

function buildRecommender() {
  const rec = new BenchmarkRecommender({ radius: 0.25, rollingWindow: 10 });
  for (const [type, table] of Object.entries(SPECIALTY)) {
    for (const cx of TRAIN_COMPLEXITY) {
      for (const modelId of MODEL_IDS) {
        rec.record({ features: { type, complexity: cx, budget: 100 }, modelId, score: table[modelId] });
      }
    }
  }
  return rec;
}

{
  const rec = buildRecommender();
  ok(rec.size === 27, `历史表 27 条（3 型 × 3 档 × 3 模型）`);

  // —— specialized：零距离档位直接命中 ——
  const spec = rec.recommend({ type: 'code', complexity: 0.5, budget: 100 });
  ok(spec.mode === 'specialized' && spec.modelId === 'coder', `零距离档位：specialized 推荐 coder（置信 ${spec.confidence.toFixed(3)}）`);
  ok(spec.expectedScore > 0.84 && spec.expectedScore < 0.86, `邻域期望分 ≈ 0.85（实际 ${spec.expectedScore.toFixed(4)}——权重聚合口径）`);
  ok(spec.neighborCount === 9 && spec.nearest.slice(0, 3).every((n) => n.distance === 0), `近邻：同型 3 档全在半径内（9 条），前 3 条零距离（同型同档 coder/writer/reasoner）`);

  // —— interpolated：档位间泛化插值仍荐正确 ——
  const interp = rec.recommend({ type: 'doc', complexity: 0.35, budget: 100 });
  ok(interp.mode === 'interpolated' && interp.modelId === 'writer', `档位间插值（复杂度 0.35 ∈ (0.2, 0.5)）：interpolated 仍荐 writer`);
  ok(interp.nearest.length > 0 && interp.nearest.every((n) => n.distance > 0), `近邻距离全 > 0（最近 ${interp.nearest[0].distance.toFixed(3)} ≤ radius 0.25）`);
  ok(interp.confidence > 0.5, `插值置信 ${interp.confidence.toFixed(3)}（邻域支撑度——比 fallback 高一档）`);

  // —— 未知类型：诚实回退全局最优（不装懂） ——
  const fallback = rec.recommend({ type: 'vision', complexity: 0.5, budget: 100 });
  ok(fallback.mode === 'global-fallback' && fallback.neighborCount === 0, '未知类型 vision：global-fallback（无同型近邻，不硬插值）');
  ok(fallback.confidence <= 0.5, `回退置信 ${fallback.confidence.toFixed(3)} ≤ 0.5（明确告诉调用方「这是猜的」）`);
  const globalAgg = { coder: (0.85 + 0.58 + 0.55) / 3, writer: (0.6 + 0.86 + 0.5) / 3, reasoner: (0.55 + 0.52 + 0.9) / 3 };
  const globalBest = Object.entries(globalAgg).sort((a, b) => b[1] - a[1])[0][0];
  ok(fallback.modelId === globalBest, `回退目标 = 全历史等权聚合最优 ${globalBest}（${fallback.modelId}）`);

  // —— 极端预算：对数距离超半径 → 同样诚实回退 ——
  const farBudget = rec.recommend({ type: 'code', complexity: 0.5, budget: 10_000 });
  ok(farBudget.mode === 'global-fallback', '预算 100×外（对数距离 0.5 > radius）：诚实回退而非外推');

  // —— held-out 命中率 vs 随机基线 ——
  const heldOut = [
    { type: 'code', complexity: 0.3, budget: 100 },
    { type: 'code', complexity: 0.42, budget: 100 },
    { type: 'code', complexity: 0.63, budget: 100 },
    { type: 'code', complexity: 0.71, budget: 100 },
    { type: 'doc', complexity: 0.28, budget: 100 },
    { type: 'doc', complexity: 0.44, budget: 100 },
    { type: 'doc', complexity: 0.66, budget: 100 },
    { type: 'doc', complexity: 0.77, budget: 100 },
    { type: 'math', complexity: 0.25, budget: 100 },
    { type: 'math', complexity: 0.47, budget: 100 },
    { type: 'math', complexity: 0.61, budget: 100 },
    { type: 'math', complexity: 0.79, budget: 100 },
  ];
  let hits = 0;
  for (const f of heldOut) {
    const r = rec.recommend(f);
    const outcome = rec.recordOutcome(f, r.modelId, SPECIALTY[f.type].best);
    if (outcome.hit) hits += 1;
  }
  const rngRandom = mulberry32(99);
  let randomHits = 0;
  for (let i = 0; i < heldOut.length; i += 1) if (MODEL_IDS[Math.floor(rngRandom() * 3)] === SPECIALTY[heldOut[i].type].best) randomHits += 1;
  const stats = rec.hitStats();
  ok(stats.total === 12 && stats.hits === hits, `held-out 12 任务命中 ${hits}/12（档位全部避开训练点——纯插值口径）`);
  ok(stats.hitRate === 1.0 && stats.hitRate > randomHits / heldOut.length, `推荐命中率 ${stats.hitRate.toFixed(2)} > 随机基线 ${randomHits}/12 = ${(randomHits / heldOut.length).toFixed(2)}（种子化随机对照）`);

  // —— rolling 窗口口径：先错后对，滚动命中率反弹快于总口径 ——
  const rec3b = new BenchmarkRecommender({ radius: 0.25, rollingWindow: 4 });
  for (let i = 0; i < 6; i += 1) rec3b.recordOutcome({ type: 'code', complexity: 0.5, budget: 100 }, 'writer', 'coder');
  for (let i = 0; i < 4; i += 1) rec3b.recordOutcome({ type: 'code', complexity: 0.5, budget: 100 }, 'coder', 'coder');
  const st3 = rec3b.hitStats();
  ok(st3.rollingWindow === 4 && st3.rollingHits === 4 && Math.abs(st3.rollingHitRate - 1) <= 1e-12 && st3.hitRate === 0.4, `rolling 窗口 4：滚动命中率 1.0（最近 4 连中）vs 总口径 0.4——新近表现不被远古拖累`);

  // —— 确定性：同输入两次推荐逐位一致 ——
  const ra = buildRecommender().recommend({ type: 'math', complexity: 0.55, budget: 100 });
  const rb = buildRecommender().recommend({ type: 'math', complexity: 0.55, budget: 100 });
  ok(JSON.stringify(ra) === JSON.stringify(rb), '同输入推荐逐位一致（无 RNG，并列按 modelId 升序）');

  // —— 空表诚实缺席 ——
  const empty = new BenchmarkRecommender().recommend({ type: 'code', complexity: 0.5, budget: 100 });
  ok(empty.modelId === '' && empty.mode === 'global-fallback' && empty.ranking.length === 0, '空历史表：modelId 空串 + 无排名（诚实缺席不乱荐）');

  // —— 引擎挂载面 ——
  const engineRec = makeEngine(tempDir('dsh-r4-rec-'));
  ok(engineRec.recommendModel({ type: 'code', complexity: 0.5, budget: 100 }) === undefined, '引擎未挂载 recommendModel → undefined');
  engineRec.attachRecommender({ radius: 0.25 });
  engineRec.recordModelOutcome({ features: { type: 'code', complexity: 0.5, budget: 100 }, modelId: 'm-a', score: 0.9 });
  engineRec.recordModelOutcome({ features: { type: 'code', complexity: 0.5, budget: 100 }, modelId: 'm-b', score: 0.6 });
  const viaEngine = engineRec.recommendModel({ type: 'code', complexity: 0.5, budget: 100 });
  ok(viaEngine !== undefined && viaEngine.modelId === 'm-a' && viaEngine.mode === 'specialized', '引擎挂载面：recordModelOutcome → recommendModel 查表命中 m-a');
  const outcomeEngine = engineRec.recordRecommendationOutcome({ type: 'code', complexity: 0.5, budget: 100 }, 'm-a', 'm-a');
  ok(outcomeEngine !== undefined && outcomeEngine.hit && engineRec.recommendationHitStats().hitRate === 1, '引擎 recordRecommendationOutcome → 命中率统计 1/1');

  // —— 输入防御 ——
  okThrow(() => new BenchmarkRecommender({ radius: 0 }), 'radius = 0 → throw');
}

// ═══════════════════ ③ 基准对比矩阵 ═══════════════════

section('③ 基准对比矩阵：多模型 × 多场景（相对最优百分比 + 显著性标记与逐对检验一致）');

const MATRIX_MODELS = ['coder', 'writer', 'reasoner'];
const MATRIX_SCENARIOS = ['code-gen', 'doc-write', 'math-proof', 'long-ctx'];
/** 构造强度表：前三场景各有霸主（0.9 vs 0.6，种子化 Bernoulli）；long-ctx
 *  确定性配对构造——writer 21/40 vs coder/reasoner 20/40（逐对仅 1 胜差、
 *  39 平 → 均值 writer 高但不显著：旧口径宣布赢家、新口径 ns 的分水岭样本） */
const MATRIX_STRENGTH = {
  'code-gen': { coder: 0.9, writer: 0.62, reasoner: 0.58 },
  'doc-write': { coder: 0.6, writer: 0.88, reasoner: 0.55 },
  'math-proof': { coder: 0.58, writer: 0.52, reasoner: 0.9 },
  'long-ctx': { coder: 0.5, writer: 0.525, reasoner: 0.5 },
};

function buildMatrixObservations(seed = 11, n = 40) {
  const rng = mulberry32(seed);
  const observations = [];
  for (const model of MATRIX_MODELS) {
    for (const scenario of MATRIX_SCENARIOS) {
      let scores;
      if (scenario === 'long-ctx') {
        // 确定性配对：coder/reasoner 偶数下标全胜（20/40）；writer 同流 + 额外
        // 恰胜下标 3（21/40）——逐对 1 胜 0 负 39 平，任何 α 下都不显著
        scores = [];
        for (let i = 0; i < n; i += 1) {
          const base = i % 2 === 0 ? 1 : 0;
          scores.push(model === 'writer' && i === 3 ? 1 : base);
        }
      } else {
        const strength = MATRIX_STRENGTH[scenario][model];
        scores = [];
        for (let i = 0; i < n; i += 1) scores.push(rng() < strength ? 1 : 0);
      }
      observations.push({ model, scenario, scores });
    }
  }
  return observations;
}

{
  const observations = buildMatrixObservations();
  const matrix = buildBenchmarkMatrix({ models: MATRIX_MODELS, scenarios: MATRIX_SCENARIOS, observations });

  // —— 形状与网格 ——
  ok(matrix.models.length === 3 && matrix.scenarios.length === 4 && matrix.grid.length === 3 && matrix.grid.every((r) => r.length === 4), 'grid 形状 3 模型 × 4 场景');
  ok(matrix.cells.length === 12 && matrix.cells.every((c) => c.hasData), '平铺 cells 12 格全量有数据');

  // —— 每格：相对百分比 + heat + 最优标记 ——
  for (const cell of matrix.cells) {
    if (cell.isBest) {
      ok(cell.significance === 'best' && cell.marker === '★' && cell.relativePercent === 100 && cell.heat === 1, `${cell.scenario} 最优格 ${cell.model}：★ 100% heat=1`);
    }
  }
  const coderCodeGen = matrix.grid[0][0];
  const writerCodeGen = matrix.grid[1][0];
  const reasonerCodeGen = matrix.grid[2][0];
  ok(coderCodeGen.isBest && writerCodeGen.significance === 'sig-worse' && reasonerCodeGen.significance === 'sig-worse', `code-gen：coder ★、writer/reasoner ** 显著劣于最优（相对 ${writerCodeGen.relativePercent}% / ${reasonerCodeGen.relativePercent}%）`);
  ok(writerCodeGen.heat <= 1 && writerCodeGen.heat >= 0 && Math.abs(writerCodeGen.heat * 100 - writerCodeGen.relativePercent) <= 0.11, `heat = 相对最优归一热力数据（heat ${writerCodeGen.heat.toFixed(3)} ↔ ${writerCodeGen.relativePercent}%）`);

  // —— 显著性标记与逐对检验一致（同一第三轮 pairedSignTest 裁决）——
  const obsMap = new Map(observations.map((o) => [`${o.model}|${o.scenario}`, o.scores]));
  let consistencyOk = true;
  for (const cell of matrix.cells) {
    if (!cell.hasData || cell.isBest) continue;
    const bestModel = MATRIX_MODELS.find((m) => matrix.grid[MATRIX_MODELS.indexOf(m)][MATRIX_SCENARIOS.indexOf(cell.scenario)].isBest);
    const verdict = pairedSignTest(obsMap.get(`${bestModel}|${cell.scenario}`), obsMap.get(`${cell.model}|${cell.scenario}`), { alpha: 0.05 });
    const expected = verdict.significant && verdict.direction === 'A-better' ? 'sig-worse' : verdict.significant && verdict.direction === 'B-better' ? 'sig-better' : 'ns';
    if (cell.significance !== expected || Math.abs(cell.pValue - Math.round(verdict.pValue * 10000) / 10000) > 1e-9) consistencyOk = false;
  }
  ok(consistencyOk, '全部非最优格显著性标记 + p 值与 pairedSignTest 逐对裁决逐位一致（同函数口径）');

  // —— long-ctx：旧口径宣布赢家，新口径 ns ——
  const longCtx = MATRIX_SCENARIOS.indexOf('long-ctx');
  const lcWriter = matrix.grid[1][longCtx];
  const lcCoder = matrix.grid[0][longCtx];
  const lcReasoner = matrix.grid[2][longCtx];
  const meanWriter = sum(obsMap.get('writer|long-ctx')) / 40;
  const meanCoder = sum(obsMap.get('coder|long-ctx')) / 40;
  ok(lcWriter.isBest, `long-ctx 名义最优 = writer（均值 ${meanWriter.toFixed(3)} vs coder ${meanCoder.toFixed(3)}——均值口径 writer 胜出）`);
  ok(lcCoder.significance === 'ns' && lcReasoner.significance === 'ns', `旧 vs 新（long-ctx）：旧口径宣布「writer 胜出」（均值差 ${(meanWriter - meanCoder).toFixed(3)}）——新口径 coder/reasoner 双双 ns（p = ${lcCoder.pValue} / ${lcReasoner.pValue}，统计上分不出不硬选）`);

  // —— 汇总口径 ——
  const wins = Object.fromEntries(matrix.winsByModel.map((w) => [w.modelId, w.wins]));
  ok(wins.coder === 1 && wins.writer === 2 && wins.reasoner === 1 && sum(Object.values(wins)) === 4, `每模型场景最优数：coder 1 / writer 2 / reasoner 1（Σ = 4 场景）`);
  ok(matrix.overallBest === 'writer', `综合冠军 = writer（win 2/4 最多）`);
  ok(matrix.insight.includes('ns') && matrix.insight.includes('显著劣于'), `insight 汇总读数（${matrix.insight}）`);

  // —— Markdown 导出 ——
  const md = benchmarkMatrixToMarkdown(matrix);
  ok(md.includes('| coder') && md.includes('100.0% ★') && md.includes('ns') && md.includes('**'), 'Markdown 矩阵导出：行/标记齐备');
  ok(md.split('\n').some((l) => l.startsWith('| writer 🏆')), 'Markdown 冠军行标注 🏆');

  // —— 非法输入诚实拒绝 ——
  okThrow(() => buildBenchmarkMatrix({ models: [], scenarios: ['s'], observations: [] }), 'models 空 → throw');
  okThrow(() => buildBenchmarkMatrix({ models: ['a'], scenarios: [], observations: [] }), 'scenarios 空 → throw');
  okThrow(
    () =>
      buildBenchmarkMatrix({
        models: ['a', 'b'],
        scenarios: ['s'],
        observations: [
          { model: 'a', scenario: 's', scores: [1, 0] },
          { model: 'b', scenario: 's', scores: [1, 0, 0] },
        ],
      }),
    '同场景分数流不等长 → throw（配对前提）',
  );
  okThrow(
    () => buildBenchmarkMatrix({ models: ['a'], scenarios: ['s'], observations: [{ model: 'ghost', scenario: 's', scores: [1] }] }),
    '未知模型 → throw',
  );
  okThrow(
    () =>
      buildBenchmarkMatrix({
        models: ['a'],
        scenarios: ['s'],
        observations: [
          { model: 'a', scenario: 's', scores: [1] },
          { model: 'a', scenario: 's', scores: [0] },
        ],
      }),
    '重复 (model, scenario) 观测 → throw',
  );

  // —— 无数据格诚实标注 ——
  const partial = buildBenchmarkMatrix({
    models: ['a', 'b'],
    scenarios: ['s1', 's2'],
    observations: [
      { model: 'a', scenario: 's1', scores: [1, 1, 0] },
      { model: 'b', scenario: 's1', scores: [0, 1, 0] },
      { model: 'a', scenario: 's2', scores: [1, 1, 1] },
    ],
  });
  const bS2 = partial.grid[1][1];
  ok(!bS2.hasData && bS2.marker === '—' && bS2.mean === undefined && bS2.relativePercent === undefined, '无数据格：hasData=false + — 标记（不参与该场景最优判定）');
  ok(partial.grid[0][1].isBest && partial.overallBest === 'a', '单模型场景 s2：a 唯一在场即最优（诚实口径——无对手不算显著）');
}

// ═══════════════════ ④ 实时告警面板 ═══════════════════

section('④ 实时告警面板：统一告警流（分色 / 倒序 / 过滤）纯函数 + loopback + HTML 结构');

/** 构造告警样本：三源 × 三级 + 同刻并列（id 升序裁决） */
const ALARM_SAMPLES = [
  { id: 'a1', source: 'benchmark-regression', severity: 'critical', title: '基准回归确证', detail: 'e=21.3 ≥ 1/α=20（n=42）', timestamp: 1000 },
  { id: 'a2', source: 'safety-governor', severity: 'critical', title: '危险操作拦截', timestamp: 2000 },
  { id: 'a3', source: 'metacognition-kpi', severity: 'warning', title: '成功率连续 5 批低于阈值', timestamp: 1500 },
  { id: 'a4', source: 'benchmark-regression', severity: 'warning', title: '分数漂移检出', timestamp: 3000 },
  { id: 'a5', source: 'safety-governor', severity: 'info', title: '降级运行提示', timestamp: 500 },
  { id: 'a6', source: 'metacognition-kpi', severity: 'info', title: '校准偏差偏高', timestamp: 2500 },
  { id: 'a7', source: 'benchmark-regression', severity: 'info', title: '趋势观察中', timestamp: 2500 },
];

{
  // —— 纯函数：空态 ——
  const empty = alarmFeedPayload(undefined);
  ok(empty.available === false && empty.total === 0 && empty.alarms.length === 0 && empty.emptyState.includes('未注入'), '未注入 → available=false 空态（零漂移）');

  // —— 纯函数：常态（乱序输入 → 时间倒序）——
  const payload = alarmFeedPayload([...ALARM_SAMPLES].reverse());
  ok(payload.available && payload.total === 7 && payload.shown === 7, '全量 7 条（available + total/shown）');
  ok(payload.counts.critical === 2 && payload.counts.warning === 2 && payload.counts.info === 3, '严重度分色计数：critical 2 / warning 2 / info 3');
  ok(payload.alarms[0].id === 'a4' && payload.alarms[1].id === 'a6' && payload.alarms[2].id === 'a7', `时间倒序（最新在前）：a4(3000) → 同刻 2500 按 id 升序 a6, a7`);
  const srcCounts = payload.sources.map((s) => `${s.source}:${s.count}`).join(' ');
  ok(srcCounts === 'benchmark-regression:3 metacognition-kpi:2 safety-governor:2', `来源分布（计数降序 / 同数按名升序）：${srcCounts}`);

  // —— 纯函数：按来源过滤（counts/sources 保持全量口径）——
  const filtered = alarmFeedPayload(ALARM_SAMPLES, { filterSource: 'safety-governor' });
  ok(filtered.total === 7 && filtered.shown === 2 && filtered.alarms.every((a) => a.source === 'safety-governor'), 'filterSource：展示 2/7，全量计数不塌缩');
  ok(filtered.filterSource === 'safety-governor', '回显过滤来源（前端 chip 高亮数据）');

  // —— 纯函数：截断 + 脏输入防御 ——
  const truncated = alarmFeedPayload(ALARM_SAMPLES, { maxItems: 3 });
  ok(truncated.shown === 3 && truncated.alarms.length === 3, 'maxItems 截断（默认 50，此处 3）');
  ok(classifyAlarmSeverity('catastrophic') === 'info' && classifyAlarmSeverity(undefined) === 'info', '脏严重度按 info（classifyAlarmSeverity 防御口径）');
  const dirty = alarmFeedPayload([{ id: 'x', source: 's', severity: 'WEIRD', title: 't', timestamp: 1 }]);
  ok(dirty.available && dirty.counts.info === 1, '载荷层脏严重度同样归一为 info（不抛错）');
  const emptyFiltered = alarmFeedPayload(ALARM_SAMPLES, { filterSource: 'nonexistent' });
  ok(emptyFiltered.shown === 0 && emptyFiltered.emptyState.includes('暂无告警'), '过滤后为空 → 空态文案指引恢复全部');

  // —— loopback 集成：真实 HTTP 端点 ——
  async function startBroadcaster() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const port = 26180 + Math.floor(Math.random() * 2000);
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
    const unmount = attachDashboard(broadcaster, () => [], { getAlarms: () => ALARM_SAMPLES });
    const page = await (await fetch(`${base}/`)).text();
    ok(page.includes('id="alarm-panel"') && page.includes('id="alarm-feed"'), 'GET / 页面含告警面板锚点（alarm-panel / alarm-feed）');
    const feed = await (await fetch(`${base}/api/alarm-feed`)).json();
    ok(feed.available === true && feed.total === 7 && feed.counts.critical === 2, '/api/alarm-feed 注入数据源 → 统一视图全字段');
    ok(feed.alarms[0].id === 'a4' && feed.alarms[0].severity === 'warning', '端点告警流时间倒序（a4 最先）+ 严重度在案');
    const fedFiltered = await (await fetch(`${base}/api/alarm-feed?source=metacognition-kpi`)).json();
    ok(fedFiltered.shown === 2 && fedFiltered.alarms.every((a) => a.source === 'metacognition-kpi'), '?source= 查询参数过滤生效（2 条 KPI 告警）');
    // 撤源（两参重挂——既有调用形态）→ 空态
    const unmount2 = attachDashboard(broadcaster, () => []);
    const fedEmpty = await (await fetch(`${base}/api/alarm-feed`)).json();
    ok(fedEmpty.available === false && fedEmpty.emptyState.includes('未注入'), '撤源 → /api/alarm-feed 空态（零漂移）');
    unmount2();
    const health = await (await fetch(`${base}/`)).json();
    ok(health.service === 'dsh-proactive/progress-ws', '卸载 → 恢复 progress-ws 默认健康检查');
    void unmount;
  } finally {
    broadcaster.stop();
  }

  // —— HTML 离线结构断言 ——
  const htmlPath = new URL('../src/dashboard/index.html', import.meta.url);
  const html = fs.readFileSync(htmlPath, 'utf-8');
  for (const anchor of ['alarm-panel', 'alarm-feed', 'alarm-filters', 'alarm-total-badge', 'st-alarm-critical', 'st-alarm-warning', 'st-alarm-info', 'st-alarm-total', 'layout-bar', 'hidden-panels', 'layout-reset', 'panel-grid']) {
    ok(html.includes(`id="${anchor}"`), `面板锚点 id="${anchor}" 存在`);
  }
  for (const sevClass of ['sev-critical', 'sev-warning', 'sev-info']) {
    ok(html.includes(`.alarm-row.${sevClass}`), `严重度分色样式 .alarm-row.${sevClass} 在案`);
  }
  ok(html.includes(`'/api/alarm-feed'`), '端点 /api/alarm-feed 在客户端拉取清单');
  ok(html.includes(DASHBOARD_LAYOUT_STORAGE_KEY), `localStorage 键与服务端同键（${DASHBOARD_LAYOUT_STORAGE_KEY}）`);
  ok(!html.includes('<link') && !/<script[^>]+src=/.test(html) && !/(src|href)\s*=\s*"https?:/.test(html), '零外链约束保持（无 <link / 外链 script / http(s) 资源）');
  const refIds = new Set();
  for (const m of html.matchAll(/\$\('([^']+)'\)/g)) refIds.add(m[1]);
  const missing = [...refIds].filter((id) => !html.includes(`id="${id}"`));
  ok(refIds.size > 25 && missing.length === 0, `脚本引用 ${refIds.size} 个 id 全部存在于文档（缺失 ${missing.length}）`);
}

// ═══════════════════ ⑤ 布局持久化（加分项） ═══════════════════

section('⑤ 布局持久化：序列化往返恒等 + 坏输入回退默认 + 面板集演化');

{
  // —— 默认布局 ——
  const def = defaultDashboardLayout();
  ok(def.version === 1 && def.hidden.length === 0 && JSON.stringify(def.order) === JSON.stringify([...DEFAULT_DASHBOARD_PANELS]), `默认布局：全显 + 默认序（${DEFAULT_DASHBOARD_PANELS.length} 面板）`);

  // —— 序列化往返恒等 ——
  const custom = { version: 1, hidden: ['gwt-panel'], order: [...DEFAULT_DASHBOARD_PANELS].reverse() };
  const roundTrip = parseDashboardLayout(serializeDashboardLayout(normalizeDashboardLayout(custom)));
  ok(JSON.stringify(roundTrip) === JSON.stringify(normalizeDashboardLayout(custom)), 'parse(serialize(normalize(p))) ≡ normalize(p)（序列化往返恒等）');
  const visible = visibleOrderedPanels(roundTrip);
  ok(visible.length === DEFAULT_DASHBOARD_PANELS.length - 1 && !visible.includes('gwt-panel') && visible[0] === 'alarm-panel', `visibleOrderedPanels：隐藏 gwt-panel + 逆序偏好（首位 alarm-panel——顺序口径生效）`);

  // —— 二次往返稳定（幂等）——
  const twice = parseDashboardLayout(serializeDashboardLayout(roundTrip));
  ok(JSON.stringify(twice) === JSON.stringify(roundTrip), '二次往返稳定（幂等）');

  // —— 坏输入回退默认 ——
  for (const bad of [null, undefined, '', 'not-json{', '{"version":2,"hidden":[],"order":[]}', '{"version":1,"order":"x","hidden":3}', '[]']) {
    const parsed = parseDashboardLayout(bad);
    ok(JSON.stringify(parsed) === JSON.stringify(defaultDashboardLayout()), `坏输入 ${String(bad).slice(0, 32)} → 回退默认布局`);
  }

  // —— 未知面板过滤 + 缺失面板补齐（版本演化口径）——
  const ghost = parseDashboardLayout('{"version":1,"hidden":["ghost-panel","alarm-panel"],"order":["ghost-panel","kernel-map"]}');
  ok(!ghost.order.includes('ghost-panel') && !ghost.hidden.includes('ghost-panel'), '未知面板 id（ghost-panel）从 hidden/order 双侧过滤');
  ok(ghost.hidden.includes('alarm-panel'), '已知面板隐藏偏好保留（alarm-panel 仍隐）');
  ok(ghost.order.length === DEFAULT_DASHBOARD_PANELS.length && ghost.order[0] === 'kernel-map' && ghost.order[1] === 'overview-stats', '缺序面板按默认序补齐（kernel-map 首位保留 + 其余默认序追加）');

  // —— 面板集演化：新增面板自动可见 ——
  const evolved = parseDashboardLayout(serializeDashboardLayout(defaultDashboardLayout()), [...DEFAULT_DASHBOARD_PANELS, 'brand-new']);
  ok(evolved.order[evolved.order.length - 1] === 'brand-new' && !evolved.hidden.includes('brand-new'), '新面板（brand-new）追加在序尾且默认可见（升级不丢偏好也不藏新功能）');

  // —— normalize 防御：null / 缺字段 ——
  const n1 = normalizeDashboardLayout(null);
  ok(JSON.stringify(n1) === JSON.stringify(defaultDashboardLayout()), 'normalize(null) → 默认');
  const n2 = normalizeDashboardLayout({ hidden: 'x', order: 7 });
  ok(JSON.stringify(n2) === JSON.stringify(defaultDashboardLayout()), 'normalize(字段形状错) → 默认（不抛错）');

  // —— 布局偏好序列构造：显隐 + 移动 + 恢复全链（纯函数域内模拟）——
  let prefs = parseDashboardLayout(null);
  prefs = normalizeDashboardLayout({ hidden: [...prefs.hidden, 'plan-feed'], order: prefs.order });
  prefs = normalizeDashboardLayout({ hidden: prefs.hidden, order: ['event-stream', 'kernel-map', ...prefs.order.filter((id) => id !== 'event-stream' && id !== 'kernel-map')] });
  const vis2 = visibleOrderedPanels(prefs);
  ok(vis2[0] === 'event-stream' && vis2[1] === 'kernel-map' && !vis2.includes('plan-feed') && vis2.length === DEFAULT_DASHBOARD_PANELS.length - 1, `偏好序列（隐 plan-feed + 前移两面板）后可见序：${vis2.join(' → ')}（${vis2.length}/7 可见）`);
  const restored = parseDashboardLayout(serializeDashboardLayout(normalizeDashboardLayout({ hidden: [], order: prefs.order })));
  ok(visibleOrderedPanels(restored).length === DEFAULT_DASHBOARD_PANELS.length, '恢复全部显示后 7 面板全可见（顺序偏好保留）');
}

// ═══════════════════ ⑥ 确定性重放 ═══════════════════

section('⑥ 确定性重放：趋势 / 推荐 / 矩阵全量重跑逐位一致');

{
  // 趋势（注入时钟）
  const runTrend = () => {
    const clock = manualClock(1_234_567_890_000, 1_000);
    const tracker = new BenchmarkTrendTracker({ windowSize: 5, alpha: 0.05, now: clock });
    const rng = mulberry32(2024);
    for (let i = 0; i < 16; i += 1) tracker.record('replay', 0.7 + (rng() - 0.5) * 0.05);
    for (let i = 0; i < 5; i += 1) tracker.record('replay', 0.45 + (rng() - 0.5) * 0.05);
    return JSON.stringify(tracker.view('replay'));
  };
  ok(runTrend() === runTrend(), '趋势流重放逐位一致（注入时钟 + 种子化噪声）');

  // 推荐
  const runRec = () => JSON.stringify(buildRecommender().recommend({ type: 'math', complexity: 0.37, budget: 100 }));
  ok(runRec() === runRec(), '推荐重放逐位一致');

  // 矩阵
  const runMatrix = () => JSON.stringify(buildBenchmarkMatrix({ models: MATRIX_MODELS, scenarios: MATRIX_SCENARIOS, observations: buildMatrixObservations(33) }));
  ok(runMatrix() === runMatrix(), '矩阵重放逐位一致（种子化观测流）');

  // 告警载荷
  const runAlarms = () => JSON.stringify(alarmFeedPayload(ALARM_SAMPLES, { filterSource: 'benchmark-regression' }));
  ok(runAlarms() === runAlarms(), '告警载荷重放逐位一致（排序确定性：时间倒序 + 同刻 id 升序）');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 第四轮 R4-A15（长期追踪 + 推荐引擎 + 对比矩阵 + 告警面板 + 布局持久化）升级验证成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
