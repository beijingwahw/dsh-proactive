/**
 * verify-r4-meta.mjs — 第四轮模块域 R4-A8：元认知层四文件全新维度验证
 *
 *   src/meta-cognition.ts / src/meta/meta-controller.ts / src/meta/meta-types.ts / src/meta/self-model.ts
 *
 * 五项全新维度各配「旧世界 vs 新世界」的构造对照（不是「改了」，是「证明更好」）：
 *   ⓪ 零漂移总检：全部 R4 面缺省时新读数 undefined / 新字段缺席 / 调整审计无
 *      amplitude / 无 load-gate 条目；旧路径 adjust→observe→commit 数值逐位不变。
 *   ① R4-1 多时间尺度监控：同一 KPI 短(4)/中(12)/长(36) 三窗并行——
 *      「单次毛刺」流（36 批稳态 0.95 → 1 批 0.55 → 恢复）：短窗 z=5.26 越
 *      限但中窗 z=1.75 / 长窗 z=0.58 健康 → 降级为「波动」（不打扰调参）；
 *      「真退化」流（持续 15 批 0.55）：短→中→长逐窗失守，判级沿
 *      fluctuation → drift → degradation 演进，长窗锚点冻结在 0.95 不被
 *      正在发生的退化拉走。旧口径（单一 z-score 异常）两条流同样报 1 次
 *      异常——无尺度区分；新口径给出三种不同裁决。
 *   ② R4-5 KPI 相关性图（加分项）：successRate 与 avgQuality 构造联动
 *      （r=1.000），cacheHitRate 独立（r=0.231），avgLatency 常序列
 *      （r=0 诚实无相关）——相关矩阵精确检出；退化触发调参时动作自动
 *      附注 affectedKpis（调 successRate 牵动 avgQuality，反向亦然）；
 *      未挂载相关图的对照引擎动作无影响面注记（旧口径）。
 *   ③ R4-2 自我效能预测：三类任务（真实成功率 0.9/0.55/0.2）各 30 试
 *      ——Beta 后验预测分化 0.9063 / 0.5625 / 0.2813（极差 0.625），
 *      与事后实测误差 ≤ 0.03；未见过任务诚实返回先验 0.5 + 宽区间；
 *      校准追踪：预测恒 0.9 而实际五五开 → biasEma 收敛 +0.3986 /
 *      Brier 0.4016 / over-predicting；改诚实预测后 40 对样本 biasEma
 *      收敛到 −0.0399、Brier 0.2502（= 理论最优 0.25）、calibrated。
 *   ④ R4-3 认知负荷门：并发调整流（观察窗 1 + 负荷上限 0.8 + 在调计
 *      数窗 3）——调整→判定→拦截→老化放行→再调整（周期性拦截/恢复）；
 *      登记两个在观实验（负荷 3 > 0.8）期间：观察窗判定照常推进（负荷
 *      门只拦新调整，不作废已投入的观察）；实验结束后恢复调整；跟踪
 *      KPI 数（9×0.1=0.9）单独构成拦截，清零恢复。未启用时无 load-gate
 *      条目（零漂移）。
 *   ⑤ R4-4 调整幅度元学习：「大调整连续翻车」流（稳态带偏离 1.5 → 步长
 *      倍率 3 的激进调整，判定全部回滚）——幅度先验因子 1 → 0.5556 →
 *      0.4167 逐次收缩（|Δ| 0.30 → 0.1667 → 0.125），幅度类 aggressive
 *      3 试 0 成；对照（未启用元学习）：全幅 0.30 翻车一次后 0.8 被标
 *      记 known-bad，同类候选永远跳过——卡死在 no-op（旧世界大调整
 *      永远不敢变小）。「小调整成功」流（稳态带回带调整，10 连 commit）
 *      ——standard 幅度类成功率 100%，因子 1 → 1.1111 → … → 1.5（封顶）
 *      逐次放宽，|Δ| 从 0.1 增长到 0.15。
 *   ⑥ 确定性重放：负荷门流与幅度收紧流重跑逐位一致（注入时钟 + 种子化
 *      噪声，无 wall-clock 依赖）。
 *
 * 全程离线确定性（mulberry32 / 注入时钟；临时持久化文件用后即删）。
 * 末尾 PASS n / FAIL m，失败 exit 1。
 *
 * 运行：npm run build && node scripts/verify-r4-meta.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfModel, MetaCognitiveController, MetaCognitionEngine } from '../dist/index.mjs';

// ─────────────────────────── 断言工具（verify-mod-meta.mjs 风格） ───────────────────────────
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
function near(actual, expected, tol = 1e-4, label) {
  const hit = Math.abs(actual - expected) <= tol;
  ok(hit, `${label}（实际 ${typeof actual === 'number' ? actual.toFixed(4) : actual}，期望 ${typeof expected === 'number' ? expected.toFixed(4) : expected} ± ${tol}）`);
}
function section(title) {
  console.log(`\n■ ${title}`);
}

/** 确定性随机源（mulberry32） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;
const CYCLES = 400;

/** 决策反馈构造 */
const fb = (id, taskType, outcome, at) => ({
  id,
  timestamp: at,
  signalType: taskType,
  signalDescription: `${taskType} 任务`,
  decision: 'auto',
  outcome,
  outcomeReason: 'verify',
});

/** 可变状态源（SelfModel 采集器桥接） */
const makeState = (overrides = {}) => ({
  feedback: [],
  memoryCounts: { patterns: 12, semantic: 5, procedural: 12, strategies: 8, profiles: 2, feedback: 40 },
  globalStats: {
    totalExecutions: 40,
    totalSuccesses: 30,
    totalFailures: 10,
    totalTokensUsed: 120_000,
    totalCostEstimate: 0.5,
    averageQualityScore: 0.78,
    averageExecutionTime: 1500,
  },
  distillation: { pendingSinceLastDistillation: 0 },
  evolverStatus: {
    currentPolicy: { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', createdAt: T0 },
    deployedHistory: [
      { id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 },
      { id: 'p-v2', version: 2, generation: 1, origin: 'mutation', gain: 0.012, deployedAt: T0 + 2 * HOUR },
    ],
    population: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    sigmaScale: 0.8,
    canary: undefined,
    totalCandidatesEvaluated: 24,
    totalCycles: 8,
    lastCycle: undefined,
  },
  ...overrides,
});

const collectorsOf = (state) => ({
  getEvolverStatus: () => state.evolverStatus,
  getMemoryStats: () => state.memoryCounts,
  getGlobalStats: () => state.globalStats,
  getDistillationProgress: () => state.distillation,
  getRecentFeedback: (limit) => state.feedback.slice(-limit),
});

/** 模拟旋钮（控制论对照台；读写语义与真实旋钮同构） */
const simKnob = (store, { id, judgeMetric = 'discoveryRate', higherIsBetter = true, min = 0.2, max = 1.0, step = 0.1 }) => ({
  id,
  label: id,
  category: 'evolver',
  min,
  max,
  step,
  integer: false,
  read: () => store.value,
  write: (v) => {
    store.value = v;
  },
  judgeMetric,
  higherIsBetter,
});

/** discoveryRate 量化注入（deployedCount/totalCycles = value，与真实链路同构） */
const setMetric = (state, value) => {
  const dep = Math.max(1, Math.round(value * CYCLES));
  state.evolverStatus = {
    ...state.evolverStatus,
    totalCycles: CYCLES,
    deployedHistory: [
      { id: 'policy-baseline', version: 1, generation: 0, origin: 'baseline', deployedAt: T0 },
      ...Array.from({ length: dep }, (_, i) => ({
        id: `p-${i}`,
        version: i + 2,
        generation: 1,
        origin: 'mutation',
        gain: 0.01,
        deployedAt: T0 + (i + 1) * 60_000,
      })),
    ],
  };
};

/** 盲点反馈（refactor 3/4 非成功 → mutationRate↑ 推荐，priority 0.8） */
const blindSpotFeedback = () => [
  fb('c1', 'refactor', 'failed', T0 + HOUR),
  fb('c2', 'refactor', 'failed', T0 + 1.1 * HOUR),
  fb('c3', 'refactor', 'poor', T0 + 1.2 * HOUR),
  fb('c4', 'refactor', 'good', T0 + 1.3 * HOUR),
];

/** KPI 快照构造（meta-cognition 引擎输入） */
const snap = (i, { successRate, avgQuality, avgLatency = 100, cacheHitRate }) => ({
  timestamp: T0 + i,
  successRate,
  avgQuality,
  avgLatency,
  cacheHitRate,
  modelSuccessRates: {},
  activeExecutions: 0,
});

// ═══════════════════ §0 零漂移总检 ═══════════════════

section('§0 零漂移：不挂载任何 R4 面 → 新读数缺席、新字段缺省、旧路径数值逐位不变');

{
  // 0a meta-cognition：未挂载多尺度/相关图 → 读数与健康报告字段缺席
  const eng = new MetaCognitionEngine({ clock: () => T0 });
  eng.observe(snap(1, { successRate: 0.9, avgQuality: 0.8, cacheHitRate: 0.3 }));
  const report = eng.getHealthReport();
  ok(eng.multiScaleView('successRate') === undefined, '0a 多尺度读数缺席（未挂载 → undefined）');
  ok(eng.kpiCorrelationView() === undefined, '0a 相关图读数缺席（未挂载 → undefined）');
  ok(eng.linkedKpis('successRate').length === 0, '0a 联动 KPI 集合为空（未挂载 → []）');
  ok(!('multiScale' in report) || report.multiScale === undefined, '0a 健康报告无 multiScale 字段');
  ok(!('kpiCorrelations' in report) || report.kpiCorrelations === undefined, '0a 健康报告无 kpiCorrelations 字段');

  // 0b meta-controller：未配置认知负荷/幅度元学习 → 面板与审计缺席
  const state = makeState({ feedback: blindSpotFeedback() });
  const store = { value: 0.5 };
  const controller = new MetaCognitiveController({
    selfModel: new SelfModel({ collectors: collectorsOf(state), config: { clock: () => T0 } }),
    knobs: [simKnob(store, { id: 'evolver.mutationRate' })],
    config: { clock: () => T0, observationReports: 2, degradationTolerance: 0.02 },
  });
  ok(controller.cognitiveLoadView() === undefined, '0b 认知负荷读数缺席（未配置 → undefined）');
  ok(controller.getState().cognitiveLoad === undefined, '0b 状态面板无 cognitiveLoad');
  ok(controller.getState().amplitudeLearning === undefined, '0b 状态面板无 amplitudeLearning');
  ok(controller.beginMetaExperiment('x') === true && controller.endMetaExperiment('x') === true, '0b 实验登记 API 可用但不影响负荷（未配置 → 恒不拦截）');
  setMetric(state, 0.5);
  const r1 = await controller.evaluateAndAdjust();
  ok(r1.status === 'adjusted' && r1.applied[0].to === 0.6 && r1.applied[0].amplitude === undefined, '0b 旧路径数值逐位不变：mutationRate 0.5→0.6 全幅单步，applied 无 amplitude 注记');
  await controller.evaluateAndAdjust();
  setMetric(state, 0.52);
  const r3 = await controller.evaluateAndAdjust();
  ok(r3.status === 'committed', '0b 旧路径 adjust→observe→commit 状态机不变（+0.02 改善保留）');
  ok(
    controller.getAuditTrail().every((e) => e.type !== 'load-gate' && e.amplitude === undefined),
    '0b 审计日志无 load-gate 条目、无 amplitude 字段（R4 未启用零写入）',
  );

  // 0c self-model：未记录效能样本 → 读数与报告字段缺席
  const model = new SelfModel({ collectors: collectorsOf(makeState()), config: { clock: () => T0 } });
  const rep = await model.generateMentalReport();
  ok(model.selfEfficacyView() === undefined, '0c 自我效能读数缺席（无样本 → undefined）');
  ok(rep.selfEfficacy === undefined, '0c 心智报告无 selfEfficacy 字段（旧报告口径不变）');
}

// ═══════════════════ §1 R4-1 多时间尺度监控 ═══════════════════

section('§1 R4-1 多时间尺度监控：单次毛刺=波动 vs 真退化=退化（短/中/长三窗并行）');

const healthy = (i) => 0.95 + (i % 2 === 0 ? 0.001 : -0.001);
const MS_OPTIONS = { kpis: ['successRate'], shortWindow: 4, mediumWindow: 12, longWindow: 36, shortZ: 3, mediumZ: 3, longZ: 3, relFloor: 0.02 };
const msEngine = (opts = {}) =>
  new MetaCognitionEngine({ clock: () => T0, successRateTarget: 0.2, qualityTarget: 0.1, degradeStreakThreshold: 50, tuningCooldownMs: 1e12, windowSize: 20, ...opts });
const msInsightsOf = (arr) => arr.filter((x) => x.category.startsWith('kpi-multiscale'));

// 场景 A：单次毛刺（36 批稳态 → 1 批 0.55 → 恢复）
const glitchView = { kind: null };
let glitchInsights;
{
  const eng = msEngine();
  eng.attachMultiScaleMonitor(MS_OPTIONS);
  glitchInsights = [];
  for (let i = 1; i <= 36; i += 1) glitchInsights.push(...msInsightsOf(eng.observe(snap(i, { successRate: healthy(i), avgQuality: 0.8, cacheHitRate: 0.3 }))));
  const atGlitch = eng.observe(snap(37, { successRate: 0.55, avgQuality: 0.8, cacheHitRate: 0.3 }));
  glitchInsights.push(...msInsightsOf(atGlitch));
  glitchView.kind = eng.multiScaleView('successRate')?.kind;
  const v = eng.multiScaleView('successRate');
  console.log(`    毛刺批读数：短 z=${v?.shortZ}（均值 ${v?.shortMean}）/ 中 z=${v?.mediumZ}（均值 ${v?.mediumMean}）/ 长 z=${v?.longZ}（均值 ${v?.longMean}），锚点 ${v?.anchorMedian}，σ底 ${v?.sigmaFloor}`);
  near(v?.shortZ ?? NaN, 5.26, 0.02, 'A1 毛刺批短窗 z≈5.26（4 批窗被单批 0.55 拉到均值 0.85，越限 3）');
  near(v?.mediumZ ?? NaN, 1.75, 0.02, 'A1 毛刺批中窗 z≈1.75（12 批窗仅稀释到 0.9167，未越限）');
  near(v?.longZ ?? NaN, 0.58, 0.02, 'A1 毛刺批长窗 z≈0.58（36 批稳态锚点几乎不动——毛刺稀释 1/36）');
  ok(v?.kind === 'fluctuation' && JSON.stringify(v?.scales) === JSON.stringify(['short']), 'A2 尺度合成判级=fluctuation（仅短窗报警）——单次毛刺降级为「波动」而非「退化」');
  let recovered;
  for (let i = 38; i <= 48; i += 1) recovered = eng.observe(snap(i, { successRate: healthy(i), avgQuality: 0.8, cacheHitRate: 0.3 }));
  void recovered;
  ok(eng.multiScaleView('successRate')?.kind === 'healthy', 'A3 恢复批后判级回 healthy（毛刺滑出短窗，无持续证据）');
  ok(
    glitchInsights.length === 1 && glitchInsights[0].category === 'kpi-multiscale-fluctuation' && glitchInsights[0].severity < 0.5,
    `A4 全程恰 1 条洞察（翻转沿语义）：kpi-multiscale-fluctuation，severity ${glitchInsights[0]?.severity} < 0.5（低打扰——波动不触发调参/自愈）`,
  );
  ok(!glitchInsights.some((x) => x.category === 'kpi-multiscale-degradation'), 'A5 毛刺流从不升级为 degradation');
  const anomaliesA = eng.getAnomalies().length;
  ok(anomaliesA === 1, `A6 旧口径对照：单一 z-score 异常检测同样报 ${anomaliesA} 次异常——旧世界毛刺与退化同权，新世界尺度可分`);
}

// 场景 B：真退化（36 批稳态 → 持续 15 批 0.55）
{
  const eng = msEngine();
  eng.attachMultiScaleMonitor(MS_OPTIONS);
  const insights = [];
  for (let i = 1; i <= 36; i += 1) insights.push(...msInsightsOf(eng.observe(snap(i, { successRate: healthy(i), avgQuality: 0.8, cacheHitRate: 0.3 }))));
  for (let i = 37; i <= 51; i += 1) insights.push(...msInsightsOf(eng.observe(snap(i, { successRate: 0.55, avgQuality: 0.8, cacheHitRate: 0.3 }))));
  const kinds = insights.map((x) => x.category.replace('kpi-multiscale-', ''));
  console.log(`    真退化判级演进：${kinds.join(' → ')}`);
  ok(
    JSON.stringify(kinds) === JSON.stringify(['fluctuation', 'drift', 'degradation']),
    `B1 判级三段演进：fluctuation（首批像毛刺，诚实不装懂）→ drift（中窗持续走弱、长窗稳态未破）→ degradation（长窗锚点失守=真退化）`,
  );
  const v = eng.multiScaleView('successRate');
  ok(v?.kind === 'degradation' && JSON.stringify(v?.scales) === JSON.stringify(['short', 'medium', 'long']), 'B2 终态判级 degradation，三尺度同向越限（报警携带尺度标签 short+medium+long）');
  near(v?.anchorMedian ?? NaN, 0.95, 1e-9, 'B3 长窗锚点冻结在 0.95（异常期不重锚——稳态基线不被正在发生的退化拉走）');
  near(v?.longZ ?? NaN, 8.77, 0.05, 'B4 终态长窗 z≈8.77（21 批 0.95 + 15 批 0.55 → 长均值 0.783，持续偏离锚点）');
  ok(eng.getAnomalies().length === 4, 'B5 旧口径对照：z-score 在退化期连报 4 次同权「异常」（无判级/无尺度/窗口被 0.55 污染后即失明）——新口径给出 fluctuation→drift→degradation 三级可行动裁决且长窗持续可见');
  const degradationInsight = insights.find((x) => x.category === 'kpi-multiscale-degradation');
  ok(degradationInsight !== undefined && degradationInsight.severity >= 0.8 && /短\/中\/长三尺度/.test(degradationInsight.message), 'B6 degradation 洞察 severity ≥ 0.8 且消息携带三尺度说明');
  const hr = eng.getHealthReport().multiScale;
  ok(hr !== undefined && hr.streams.length === 1 && hr.interpretation.includes('真退化'), 'B7 健康报告携带多尺度读数与「真退化」解读');
}

// 零漂移回归：挂载其他层不影响多尺度缺席（未挂载多尺度时健康报告无 multiScale）
{
  const eng = msEngine();
  eng.attachKpiCorrelation({ window: 24, minSamples: 12, threshold: 0.7 });
  eng.observe(snap(1, { successRate: 0.9, avgQuality: 0.8, cacheHitRate: 0.3 }));
  ok(eng.multiScaleView('successRate') === undefined && eng.getHealthReport().multiScale === undefined, 'B8 只挂相关图不挂多尺度 → multiScale 仍缺席（各 R4 面独立 opt-in）');
}

// ═══════════════════ §2 R4-5 KPI 相关性图（加分项） ═══════════════════

section('§2 R4-5 KPI 相关性图：联动检出 + 调整影响面自动附注（归因防混淆）');

const wOf = (i) => ((i * 5) % 13) / 13;
const corrFeed = (eng, i, degraded) =>
  eng.observe(
    snap(i, degraded
      ? { successRate: 0.5, avgQuality: 0.5, avgLatency: 100, cacheHitRate: 0.3 + 0.4 * (((i * 7) % 11) / 11) }
      : { successRate: 0.85 + 0.1 * wOf(i), avgQuality: 0.72 + 0.2 * wOf(i), avgLatency: 100, cacheHitRate: 0.3 + 0.4 * (((i * 7) % 11) / 11) }),
  );

{
  const eng = new MetaCognitionEngine({ clock: () => T0, tuningCooldownMs: 0, windowSize: 20, degradeStreakThreshold: 3 });
  eng.attachKpiCorrelation({ window: 24, minSamples: 12, threshold: 0.7 });
  for (let i = 0; i < 24; i += 1) corrFeed(eng, i, false);
  const pre = eng.kpiCorrelationView();
  const pair = (a, b) => pre.pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
  console.log(`    相关矩阵：sr↔aq r=${pair('successRate', 'avgQuality')?.r}，sr↔cache r=${pair('successRate', 'cacheHitRate')?.r}，sr↔latency r=${pair('successRate', 'avgLatency')?.r}`);
  near(pair('successRate', 'avgQuality')?.r ?? NaN, 1.0, 0.001, 'C1 联动对检出：successRate↔avgQuality r≈1.000（同一驱动 w 的线性函数）');
  ok(Math.abs(pair('successRate', 'cacheHitRate')?.r ?? 1) < 0.7 && pair('successRate', 'cacheHitRate')?.linked === false, 'C2 独立 KPI 不误联：successRate↔cacheHitRate |r|<0.7（异周期模序列）');
  ok(pair('successRate', 'avgLatency')?.r === 0 && pair('successRate', 'avgLatency')?.linked === false, 'C3 常序列诚实返回 r=0（σ=0 不装懂，不产出 ∞ 相关）');
  ok(eng.linkedKpis('successRate').length === 1 && eng.linkedKpis('successRate')[0].kpi === 'avgQuality', 'C4 linkedKpis(successRate) = [avgQuality]——调成功率的影响面含 avgQuality');

  // 退化触发调参 → 动作自动附注 affectedKpis
  for (let i = 24; i < 27; i += 1) corrFeed(eng, i, true);
  const hist = eng.getTuningHistory();
  console.log(`    调参动作影响面：${hist.map((h) => `${h.parameter}→[${(h.affectedKpis ?? []).join(',') || '无'}]`).join('，')}`);
  const qt = hist.find((h) => h.parameter === 'qualityThreshold');
  const mr = hist.find((h) => h.parameter === 'maxRetries');
  ok(qt !== undefined && JSON.stringify(qt.affectedKpis) === JSON.stringify(['avgQuality']), 'C5 调 qualityThreshold（救 successRate）自动附注 affectedKpis=[avgQuality]——联动 KPI 一并列入影响面');
  ok(mr !== undefined && JSON.stringify(mr.affectedKpis) === JSON.stringify(['successRate']), 'C6 反向亦然：调 maxRetries（救 avgQuality）附注 [successRate]');
  const post = eng.kpiCorrelationView();
  ok(post.pairs.find((p) => p.a === 'successRate' && p.b === 'avgQuality')?.linked === true, 'C7 退化批（两点同落 0.5,0.5）后联动对仍成立（滚动窗相关稳定）');
  ok(eng.getHealthReport().kpiCorrelations?.interpretation.includes('successRate↔avgQuality'), 'C8 健康报告携带相关图联动对解读');

  // 对照：未挂载相关图的引擎（旧口径）——动作无影响面注记
  const ctl = new MetaCognitionEngine({ clock: () => T0, tuningCooldownMs: 0, windowSize: 20, degradeStreakThreshold: 3 });
  for (let i = 0; i < 24; i += 1) corrFeed(ctl, i, false);
  for (let i = 24; i < 27; i += 1) corrFeed(ctl, i, true);
  const ctlHist = ctl.getTuningHistory();
  ok(ctlHist.length === hist.length && ctlHist.every((h) => h.affectedKpis === undefined), `C9 旧口径对照：同流未挂载引擎产生同数动作（${ctlHist.length} 个）但全部无 affectedKpis——「调 A 牵动 B」在旧世界是暗耦合`);
}

// ═══════════════════ §3 R4-2 自我效能预测 ═══════════════════

section('§3 R4-2 自我效能预测：三类任务 Beta 后验分化 + 预测-实际校准误差收敛');

{
  const tmp = path.join(os.tmpdir(), `r4-meta-efficacy-${process.pid}.json`);
  const model = new SelfModel({ collectors: collectorsOf(makeState()), config: { clock: () => T0, efficacyEmaAlpha: 0.15, efficacyWarmup: 8, efficacyTolerance: 0.08, persistPath: tmp } });
  const rand = mulberry32(42);

  // 预测先于结果：未见过任务诚实返回先验
  const first = model.predictSuccess('code-gen');
  near(first.predicted, 0.5, 1e-9, 'D1 零历史诚实先验：predicted=0.5（Beta(1,1) 均值，不装懂）');
  ok(first.ci90.upper - first.ci90.lower > 0.7, 'D2 零历史宽区间（90% CI 宽度 > 0.7——不确定性如实呈现）');

  // 三类任务各 30 试（缺省 predicted = 当前后验——先预测后看结果）
  const rates = { 'code-gen': 0.9, 'doc-sum': 0.55, 'ops-alert': 0.2 };
  for (let i = 0; i < 30; i += 1) for (const t of Object.keys(rates)) model.recordSelfEfficacy({ taskType: t, success: rand() < rates[t] });
  const code = model.predictSuccess('code-gen');
  const doc = model.predictSuccess('doc-sum');
  const ops = model.predictSuccess('ops-alert');
  console.log(`    后验分化：code-gen ${code.predicted}（实测 ${(28 / 30).toFixed(4)}）/ doc-sum ${doc.predicted}（实测 ${(17 / 30).toFixed(4)}）/ ops-alert ${ops.predicted}（实测 ${(8 / 30).toFixed(4)}）`);
  near(code.predicted, 0.9063, 0.001, 'D3 code-gen 预测 0.9063（28/30 成功 → Beta(29,3) 后验均值）');
  near(doc.predicted, 0.5625, 0.001, 'D3 doc-sum 预测 0.5625（17/30）');
  near(ops.predicted, 0.2813, 0.001, 'D3 ops-alert 预测 0.2813（8/30）');
  ok(code.predicted - ops.predicted >= 0.4, `D4 预测分化：擅长与短板极差 ${(code.predicted - ops.predicted).toFixed(4)} ≥ 0.4（旧 SelfCalibrationSummary 只有全局一口径，看不见任务类型差异）`);
  ok(Math.abs(code.predicted - 28 / 30) <= 0.03 && Math.abs(doc.predicted - 17 / 30) <= 0.03 && Math.abs(ops.predicted - 8 / 30) <= 0.03, 'D5 预测 vs 事后实测误差 ≤ 0.03（后验收缩到真值附近）');
  ok(code.ci90.upper - code.ci90.lower < 0.3 && code.ci90.upper - code.ci90.lower < first.ci90.upper - first.ci90.lower, 'D6 区间随经验收窄（code-gen 90% CI 宽度 < 0.3 且远小于零历史宽度）');

  // 校准追踪：阶段一预测过高 → 阶段二诚实预测收敛
  let summary;
  for (let i = 0; i < 12; i += 1) summary = model.recordSelfEfficacy({ taskType: 'cal', predicted: 0.9, success: i % 2 === 0 });
  console.log(`    阶段一（预测恒 0.9 / 实际五五开）：biasEma ${summary.calibrationBiasEma}，Brier ${summary.brierEma}，state ${summary.state}`);
  near(summary.calibrationBiasEma, 0.3986, 0.005, 'D7 预测过高暴露：biasEma ≈ +0.399（预测比实际高四成）');
  near(summary.brierEma, 0.4016, 0.005, 'D7 预测质量差：Brier EMA ≈ 0.402（瞎猜恒 0.5 也才 0.25）');
  ok(summary.state === 'over-predicting', 'D7 校准状态 over-predicting（把「预计能成」当「真能成」）');
  const brierBefore = summary.brierEma;
  for (let i = 0; i < 40; i += 1) summary = model.recordSelfEfficacy({ taskType: 'cal2', predicted: 0.5, success: i % 2 === 1 });
  console.log(`    阶段二（诚实预测 0.5）：biasEma ${summary.calibrationBiasEma}，Brier ${summary.brierEma}，state ${summary.state}`);
  ok(Math.abs(summary.calibrationBiasEma) <= 0.05, `D8 校准误差收敛：|biasEma| ${Math.abs(summary.calibrationBiasEma).toFixed(4)} ≤ 0.05（从 +0.399 收敛）`);
  near(summary.brierEma, 0.2502, 0.005, 'D8 Brier 收敛到 0.25（预测 0.5 + 实际五五开的理论最优）');
  ok(summary.brierEma < brierBefore - 0.1, `D8 Brier 改善 ${brierBefore.toFixed(3)} → ${summary.brierEma.toFixed(3)}（降 > 0.1）`);
  ok(summary.state === 'calibrated', 'D8 校准状态回到 calibrated');

  // 心智报告集成 + 快照/恢复 + 持久化
  const rep = await model.generateMentalReport();
  ok(rep.selfEfficacy !== undefined && rep.selfEfficacy.types.length >= 5 && rep.selfEfficacy.samples >= 100, `D9 心智报告携带 selfEfficacy（${rep.selfEfficacy.types.length} 类型 / ${rep.selfEfficacy.samples} 对样本）`);
  ok(model.formatReport(rep).includes('[自我效能预测]'), 'D9 可读报告渲染自我效能量表');
  const snapShot = model.snapshotSelf();
  model.recordSelfEfficacy({ taskType: 'post-snap', success: true });
  model.restoreSelf(snapShot);
  ok(model.predictSuccess('post-snap').trials === 0, 'D10 快照/恢复还原效能记忆（快照后的记录被回滚）');
  const model2 = new SelfModel({ collectors: collectorsOf(makeState()), config: { clock: () => T0, persistPath: tmp } });
  ok(model2.predictSuccess('code-gen').predicted === code.predicted && model2.selfEfficacyView()?.samples === summary.samples, 'D11 效能记忆跨重启持久化连续（新实例读同一持久化文件）');
  fs.rmSync(tmp, { force: true });
}

// ═══════════════════ §4 R4-3 认知负荷门 ═══════════════════

section('§4 R4-3 认知负荷门：并发调整流拦截与恢复（防同时调太多不可归因）');

async function runLoadGateFlow() {
  const state = makeState({ feedback: blindSpotFeedback() });
  const store = { value: 0.5 };
  const controller = new MetaCognitiveController({
    selfModel: new SelfModel({ collectors: collectorsOf(state), config: { clock: () => T0 } }),
    knobs: [simKnob(store, { id: 'evolver.mutationRate', max: 5.0 })],
    config: {
      clock: () => T0,
      observationReports: 1,
      degradationTolerance: 0.02,
      breakerThreshold: 50,
      globalBreakerThreshold: 50,
      cognitiveLoad: { maxLoad: 0.8, flightWindowReports: 3, adjustmentWeight: 1, experimentWeight: 1, kpiWeight: 0.1 },
    },
  });
  const trace = [];
  for (let r = 1; r <= 17; r += 1) {
    const pending = controller.getState().pending;
    setMetric(state, pending ? 0.52 : 0.5); // 判定轮 +0.02 改善 → commit
    const res = await controller.evaluateAndAdjust();
    const view = controller.cognitiveLoadView();
    trace.push({ r, status: res.status, load: view?.load, adj: view?.activeAdjustments, exp: view?.activeExperiments, kpi: view?.trackedKpis, gate: view?.gateSkips ?? 0 });
    if (r === 7) {
      controller.beginMetaExperiment('exp-1');
      controller.beginMetaExperiment('exp-2');
    }
    if (r === 10) {
      controller.endMetaExperiment('exp-1');
      controller.endMetaExperiment('exp-2');
    }
    if (r === 14) controller.setTrackedKpiCount(9);
    if (r === 16) controller.setTrackedKpiCount(0);
  }
  return { trace, controller };
}
const loadRun = await runLoadGateFlow();
{
  const t = loadRun.trace;
  console.log(`    负荷轨迹：${t.map((x) => `r${x.r}:${x.status[0]}${x.status === 'no-op' ? '(门)' : ''}[L${x.load}]`).join(' ')}`);
  const st = (r) => t[r - 1].status;
  ok(st(1) === 'adjusted' && st(4) === 'adjusted' && st(7) === 'adjusted', 'E1 并发调整流起跑：r1/r4/r7 连续单旋钮调整（负荷门未启用时本可背靠背）');
  ok(st(3) === 'no-op' && t[2].load === 1 && t[2].adj === 1, 'E2 拦截：r3 在调旋钮 1×1 = 负荷 1 > 上限 0.8 → 新调整被拦（最近 3 份报告内的 adjust 都占归因带宽）');
  ok(st(4) === 'adjusted', 'E3 恢复：r4 首批调整老化出窗（age 3 ≥ flightWindow 3）→ 负荷回落 0 → 放行新调整');
  ok(st(6) === 'no-op' && st(7) === 'adjusted', 'E4 周期性拦截/恢复：r6 再拦、r7 再放——调整流被压成「调→判→歇」的可归因节奏');
  ok(st(8) === 'committed' && t[7].load === 3, 'E5 判定不被拦：r8 登记两个在观实验后负荷 3 > 0.8，但观察窗判定照常 commit——负荷门只拦新调整，不作废已投入的观察');
  ok(st(9) === 'no-op' && st(10) === 'no-op' && t[9].exp === 2 && t[9].adj === 0, 'E6 实验占满带宽：r10 纯实验负荷 2×1 = 2 > 0.8 → 拦截（其他子系统的实验也是归因混淆源）');
  ok(st(11) === 'adjusted', 'E7 实验结束恢复：endMetaExperiment 释放带宽 → r11 重新放行');
  ok(st(15) === 'committed' && st(16) === 'no-op' && Math.abs((t[15].load ?? 0) - 1.9) < 0.01 && t[15].kpi === 9, 'E8 KPI 观测面计入负荷：跟踪 9 KPI×0.1 + 在调 1 = 1.9 > 0.8 → r16 拦截（看得越多，单次归因越难）');
  ok(st(17) === 'adjusted', 'E9 清零恢复：setTrackedKpiCount(0) 后 r17 放行');
  const view = loadRun.controller.cognitiveLoadView();
  ok(view !== undefined && view.gateSkips === 6, `E10 负荷门累计拦截 ${view?.gateSkips} 次（r3/r6/r9/r10/r13/r16），全部审计留痕`);
  ok(
    loadRun.controller.getAuditTrail().filter((e) => e.type === 'load-gate').every((e) => e.reason.includes('认知负荷') && e.reason.includes('归因')),
    'E10 load-gate 审计条目说明归因动机（可追溯）',
  );
  const panel = loadRun.controller.getState().cognitiveLoad;
  ok(panel !== undefined && typeof panel.threshold === 'number' && panel.paused === (panel.load > panel.threshold), 'E11 状态面板 cognitiveLoad 携带负荷/上限/拦截计数');
}

// ═══════════════════ §5 R4-4 调整幅度元学习 ═══════════════════

section('§5 R4-4 调整幅度元学习：大调整连续翻车→幅度先验收紧；小调整成功→放宽');

async function ampTightenFlow(withAmp) {
  const state = makeState({ feedback: blindSpotFeedback() });
  const store = { value: 0.5 };
  const controller = new MetaCognitiveController({
    selfModel: new SelfModel({ collectors: collectorsOf(state), config: { clock: () => T0 } }),
    knobs: [simKnob(store, { id: 'evolver.mutationRate' })],
    config: {
      clock: () => T0,
      observationReports: 2,
      degradationTolerance: 0.02,
      homeostasisBands: { discoveryRate: { min: 0.4, max: 0.6 } },
      maxStepMultiplier: 3,
      breakerThreshold: 50,
      globalBreakerThreshold: 50,
      ...(withAmp ? { amplitudeMetaLearn: { target: 0.6, minFactor: 0.25, maxFactor: 1.5, priorWeight: 1 } } : {}),
    },
  });
  const statuses = [];
  for (let r = 1; r <= 9; r += 1) {
    const pending = controller.getState().pending;
    setMetric(state, pending && pending.reportsSeen === 1 ? 0.05 : 0.1); // 判定轮 −0.05 → 回滚（大调整翻车）
    const res = await controller.evaluateAndAdjust();
    statuses.push(res.status);
  }
  const adjusts = controller.getAuditTrail().filter((e) => e.type === 'adjust');
  return { statuses, adjusts, panel: controller.getState().amplitudeLearning, knob: store.value };
}
{
  const amp = await ampTightenFlow(true);
  const old = await ampTightenFlow(false);
  console.log(`    元学习幅度序列：${amp.adjusts.map((e) => `|Δ|${(e.to - e.from).toFixed(4)}×f${e.amplitude?.factor}`).join(' → ')}`);
  console.log(`    旧口径幅度序列：${old.adjusts.map((e) => `|Δ|${(e.to - e.from).toFixed(4)}`).join(' → ')}（此后 ${old.statuses.slice(-6).join('/')}）`);
  near(amp.adjusts[0].to - amp.adjusts[0].from, 0.3, 0.001, 'F1 首次激进调整全幅 |Δ|=0.30（稳态带偏离 1.5 → 步长倍率 3，幅度类 aggressive 零试验 → 因子 1）');
  near(amp.adjusts[1].amplitude?.factor ?? NaN, 0.5556, 0.001, 'F2 一次翻车后因子收缩：aggressive 1 试 0 成 → Beta(1,1) 平滑 p=1/3 → 因子 = 0.3333/0.6 = 0.5556');
  near(amp.adjusts[1].to - amp.adjusts[1].from, 0.1667, 0.001, 'F2 幅度随之收缩 |Δ| 0.30 → 0.1667');
  near(amp.adjusts[2].amplitude?.factor ?? NaN, 0.4167, 0.001, 'F3 连续翻车继续收紧：2 试 0 成 → p=0.25 → 因子 0.4167，|Δ| → 0.125');
  ok(amp.adjusts.every((e) => e.amplitude?.band === 'aggressive' && e.amplitude !== undefined), 'F3 全部归入 aggressive 幅度类（|Δ|/step > 1）且审计携带 amplitude 注记');
  const agg = amp.panel?.bands.find((b) => b.band === 'aggressive');
  ok(agg?.trials === 3 && agg?.commits === 0 && Math.abs((agg?.factor ?? 0) - 0.3333) < 0.001, 'F4 面板：aggressive 3 试 0 成，面板因子 0.3333（下一回合同类调整只剩 1/3 力度）');
  // 旧口径对照：无元学习 → 全幅翻车一次后卡死
  ok(old.adjusts.length === 1 && Math.abs(old.adjusts[0].to - old.adjusts[0].from - 0.3) < 0.001 && old.adjusts[0].amplitude === undefined, 'F5 旧口径对照：同样全幅 0.30 翻车，但无幅度字段');
  ok(old.statuses[1] === 'observing' && old.statuses[2] === 'rolled-back' && old.statuses.slice(3).every((s) => s === 'no-op'), `F5 旧口径卡死：翻车值 0.8 被 2.0 known-bad 拉黑，全幅候选永远撞同一值 → 首循环后 6 轮全部 no-op（${old.statuses.join('/')}）`);
  ok(amp.statuses.filter((s) => s === 'adjusted').length === 3 && amp.statuses.filter((s) => s === 'no-op').length === 0, 'F6 新口径逃脱死锁：收缩后的取值（0.6667/0.625）不再是 known-bad——幅度先验让同类调整改力度而非放弃');
  ok(old.panel === undefined, 'F6 旧口径无 amplitudeLearning 面板（零漂移）');
}

// 放宽流：稳态带回带调整（幅度类 standard）10 连 commit
{
  const state = makeState({ feedback: [fb('g1', 'code-generation', 'good', T0 + HOUR), fb('g2', 'code-generation', 'excellent', T0 + 1.2 * HOUR)] });
  const store = { value: 0.5 };
  const controller = new MetaCognitiveController({
    selfModel: new SelfModel({ collectors: collectorsOf(state), config: { clock: () => T0 } }),
    knobs: [simKnob(store, { id: 'sim.gain' })],
    config: {
      clock: () => T0,
      observationReports: 2,
      degradationTolerance: 0.02,
      maxStepMultiplier: 1,
      breakerThreshold: 50,
      globalBreakerThreshold: 50,
      homeostasisBands: { discoveryRate: { min: 0.45, max: 0.55 } },
      stabilityLoop: { deadbandDeviation: 0.1, rampStart: 1, rampIncrement: 0, cooldownReports: 0, knobAffect: { 'sim.gain': 'positive' } },
      amplitudeMetaLearn: { target: 0.6, minFactor: 0.25, maxFactor: 1.5, priorWeight: 1 },
    },
  });
  let phase = 0;
  const applied = [];
  for (let r = 1; r <= 30; r += 1) {
    const pending = controller.getState().pending;
    if (pending) {
      setMetric(state, pending.to > pending.from ? 0.42 : 0.58); // 判定轮向带内回落 → commit
    } else {
      phase += 1;
      setMetric(state, phase % 2 === 1 ? 0.4 : 0.6); // 调整轮交替带下/带上（方向交替，包络不束缚）
    }
    const res = await controller.evaluateAndAdjust();
    if (res.applied.length > 0) applied.push(res.applied[0]);
  }
  const factors = applied.map((a) => a.amplitude?.factor ?? 0);
  const deltas = applied.map((a) => Math.abs(a.to - a.from));
  console.log(`    放宽流因子序列：${factors.map((f) => f.toFixed(4)).join(' → ')}；|Δ| ${deltas[0].toFixed(4)} → ${deltas[deltas.length - 1].toFixed(4)}`);
  ok(applied.length === 10 && applied.every((a) => a.amplitude?.band === 'standard'), `G1 ${applied.length} 次调整全部 standard 幅度类（1×step 提案）`);
  ok(factors.every((f, i) => i === 0 || f >= factors[i - 1]), 'G2 因子单调不减：1 → 1.1111 → 1.25 → …（每次 commit 抬高同类成功率后验）');
  near(factors[1] ?? NaN, 1.1111, 0.001, 'G2 首次成功后放宽：standard 1 试 1 成 → p=2/3 → 因子 0.667/0.6 = 1.1111');
  near(factors[factors.length - 1] ?? NaN, 1.5, 0.001, 'G2 因子封顶 1.5（10/10 成功率 → p=11/12=0.917 → 1.527 钳到上限）');
  ok(deltas[deltas.length - 1] > deltas[0] + 0.04, `G3 幅度实质放宽：|Δ| ${deltas[0].toFixed(4)} → ${deltas[deltas.length - 1].toFixed(4)}（+${(deltas[deltas.length - 1] - deltas[0]).toFixed(4)}）——小调整被证实可靠后，同类调整敢迈更大步`);
  const std = controller.getState().amplitudeLearning?.bands.find((b) => b.band === 'standard');
  ok(std?.trials === 10 && std?.commits === 10 && std?.factor === 1.5, 'G4 面板：standard 10/10 成功，因子 1.5 封顶');
}

// ═══════════════════ §6 确定性重放 ═══════════════════

section('§6 确定性重放：关键流重跑逐位一致（注入时钟 + 种子化，无 wall-clock 依赖）');

{
  const again = await runLoadGateFlow();
  const a = JSON.stringify(loadRun.trace);
  const b = JSON.stringify(again.trace);
  ok(a === b, 'H1 认知负荷门流重跑 17 轮轨迹逐位一致（状态/负荷/计数）');
  const againAmp = await ampTightenFlow(true);
  ok(
    JSON.stringify(againAmp.adjusts.map((e) => [e.from, e.to, e.amplitude])) === JSON.stringify(loadRun ? (await ampTightenFlow(true)).adjusts.map((e) => [e.from, e.to, e.amplitude]) : []),
    'H2 幅度元学习流重跑审计逐位一致（因子/幅度类序列）',
  );
  const eng1 = msEngine();
  eng1.attachMultiScaleMonitor(MS_OPTIONS);
  const eng2 = msEngine();
  eng2.attachMultiScaleMonitor(MS_OPTIONS);
  const s1 = [];
  const s2 = [];
  for (let i = 1; i <= 45; i += 1) {
    const v = i <= 36 ? healthy(i) : 0.55;
    s1.push(...msInsightsOf(eng1.observe(snap(i, { successRate: v, avgQuality: 0.8, cacheHitRate: 0.3 }))));
    s2.push(...msInsightsOf(eng2.observe(snap(i, { successRate: v, avgQuality: 0.8, cacheHitRate: 0.3 }))));
  }
  ok(
    JSON.stringify(s1) === JSON.stringify(s2) && s1.length === 3 && eng1.multiScaleView('successRate')?.kind === 'degradation',
    'H3 多尺度退化流重跑洞察序列逐位一致（fluctuation→drift→degradation，终态判级一致）',
  );
}

// ═══════════════════ 汇总 ═══════════════════
console.log('──────────────────────────────────────────────────────────');
if (failed === 0) {
  console.log(`✅ PASS ${passed} / FAIL ${failed} —— R4-A8 元认知层第四轮全新维度全部通过：多时间尺度监控（毛刺=波动 vs 真退化=退化的尺度区分）× KPI 相关性图（联动检出 + 调整影响面附注）× 自我效能预测（三类任务 Beta 后验分化 + 校准误差收敛）× 认知负荷门（并发调整拦截/恢复、判定不作废）× 调整幅度元学习（大调整翻车收紧、小调整成功放宽），全部 opt-in 且缺省零漂移。`);
} else {
  console.error(`❌ PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
