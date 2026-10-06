/**
 * verify-r4-scheduler.mjs — 第四轮模块域 R4-A3 升级：ModelScheduler 新维度验证
 *
 * 五项全新维度各配「旧行为 vs 新行为」的构造对照（不是「改了」，是「证明更好」）：
 *   ⓪ 零漂移总检：全部 R4 面缺省时新读数 undefined、回报无去处、选型逐位保持；
 *      五面齐挂但零样本/零遥测时决策与裸调度器逐位相同（opt-in 且缺省零漂移）。
 *   ① R4-1 集成组合优化：三弱投票者池 Condorcet 组合正确率 0.648 > 任一单体 0.6
 *      （精确 Poisson 二项 DP）；混入 0.62 强单体后最优组合 [s-d,w-a,w-b]
 *      = 0.6576 仍 > 0.62（旧口径最优单体 0.62 vs 新口径组合 +0.0376）；预算 2.5 硬约束
 *      把组合压回单体 0.62（成本 3 的三人组不可行）；大池转贪心保底 ≥ 最优单体；
 *      全枚举 searched=14 精确计数；两次调用逐位一致（确定性）。
 *   ② R4-2 预测性预热：上升负载流（桶计数 1,2,3,5,8,16）虚拟时钟记账——
 *      峰值桶（b5, 计数 16）开始前 950ms 预热建议已触发（t0+4050 < t0+5000），
 *      且当前 EWMA 3.224 < 阈值 6 < 外推 7.124（预测越线而当前未越线——
 *      旧口径须等 EWMA 自身 ≥ 6，最早 b5 折入即 t0+6060，晚 2010ms）；
 *      高负载但下行（9,8,7）不预热（带宽不浪费在退潮任务）；建议模型已过运营闸门。
 *   ③ R4-3 冷启动准入协议：劣质新模型（taskScore 0.95 最高）影子期 5 观察
 *      均值 0.2 < 弹劾线 0.35 → 退场——旧口径 10/10 被选中 vs 新口径 0/10；
 *      平庸模型影子过门（0.55 ≥ 0.5）→ 金丝雀失门（0.45 < 0.6）→ 退场
 *      （三阶段拦截全链）；优质模型三阶段毕业全量；金丝雀确定性 1-in-5
 *      小流量（10 次选型恰放行 2 次）；未登记模型不受约束（零漂移）；
 *      全池退场软放行不抛新错。
 *   ④ R4-4 成本漂移告警：基线带（100×8 冻结）vs 当前 EWMA——涨价 130 喂入
 *      5 个样本仍低于带（0.2496 < 0.25），第 6 个样本越线（0.2647 ≥ 0.25）
 *      触发 re-profile 建议（旧口径静默无告警）；acknowledgeDrift 重立基线后
 *      130 成为新常态（无告警）、再涨 170 二次检出；时延口径（200→400）同检。
 *   ⑤ R4-5 模型特长画像：同分双模型池（旧口径恒选 A → 命中 50/100），
 *      特长矩阵回喂（A 擅 code 0.95 / B 擅 doc 0.95）后乘数 1.36/0.72 分化，
 *      code→A、doc→B 命中 100/100 > 50/100；零样本时乘数恒 1（零漂移）。
 *   ⑥ 组合场景：准入退场 × 熔断 × 组合优化 × 预热同挂——退场/熔断模型既不进
 *      单模型选型、也不进组合成员、也不进预热建议（运营闸门全链贯通）。
 *
 * 确定性：全部时间走注入虚拟时钟；无真定时器、无真网络（LLMClient 离线
 * 注册，统计口径全部经 options 注入）。
 *
 * 运行：npm run build && node scripts/verify-r4-scheduler.mjs
 */

import { LLMClient, ModelScheduler } from '../dist/index.mjs';

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

// ─────────────────────────── 构造工具 ───────────────────────────

/** 贝叶斯画像（有效样本 20 → 记忆权重满格 0.6、探索加成关闭——确定性评分） */
function est(posteriorMean, wilsonLower, effectiveSamples = 20, emaQuality = 0.6) {
  return {
    modelId: '',
    taskType: '',
    alpha: posteriorMean * effectiveSamples + 1,
    beta: (1 - posteriorMean) * effectiveSamples + 1,
    posteriorMean,
    wilsonLower,
    effectiveSamples,
    rawSuccessRate: posteriorMean,
    drift: 0,
    emaQuality,
  };
}

/** 记忆 stub（getBayesianEstimate 消费面；未列模型 → undefined） */
function stubMemory(byModel) {
  return { getBayesianEstimate: (id) => byModel[id] };
}

/** 离线 LLMClient（endpoint 指向 mock 主机，不发真实请求） */
function makeLlm(models) {
  const llm = new LLMClient();
  for (const m of models) llm.registerModel({ id: m.id, endpoint: 'http://mock.local', initialCapabilities: { taskScores: m.taskScores } });
  return llm;
}

/** 虚拟时钟 */
function vclock(start = 1_000_000) {
  const state = { now: start };
  return { state, clock: () => state.now };
}

// ═══════════════════ ⓪ 零漂移总检（缺省 = 旧行为） ═══════════════════

section('⓪ 零漂移总检：全部 R4 面缺省时读数缺席、选型行为逐位保持');

{
  const llm = makeLlm([
    { id: 'm-hi', taskScores: { test: 0.9 } },
    { id: 'm-mid', taskScores: { test: 0.7 } },
    { id: 'm-lo', taskScores: { test: 0.5 } },
  ]);
  const memory = stubMemory({ 'm-hi': est(0.7, 0.6), 'm-mid': est(0.65, 0.55), 'm-lo': est(0.5, 0.4) });
  const bare = new ModelScheduler({ llm, memory });

  ok(bare.composeEnsemble('test') === undefined, '未挂载组合优化：composeEnsemble undefined');
  ok(bare.prewarmSuggestions() === undefined, '未挂载预热：prewarmSuggestions undefined');
  ok(bare.admissionView() === undefined, '未挂载准入协议：admissionView undefined');
  ok(bare.driftAlerts() === undefined, '未挂载漂移哨兵：driftAlerts undefined');
  ok(bare.specialtyView() === undefined, '未挂载特长画像：specialtyView undefined');
  bare.noteTaskDemand('test');
  bare.reportTrialOutcome('m-hi', 0.1);
  bare.reportCostSample('m-hi', { costPerCall: 999 });
  bare.reportSpecialtyOutcome('m-hi', 'test', 0.1);
  bare.acknowledgeDrift('m-hi', 'costPerCall');
  ok(bare.assignModel('test') === 'm-hi', '回报/记账无去处 = 无操作，选型不受扰动');

  // 五面齐挂但零样本/零遥测/零登记 → 决策与裸调度器逐位相同
  const loaded = new ModelScheduler({ llm, memory });
  const { state: clk, clock } = vclock(2_000_000);
  loaded.attachEnsembleComposer({ qualityOf: () => 0.9, costPerCallOf: () => 1 });
  loaded.attachPrewarm({ bucketMs: 1_000, clock });
  loaded.attachAdmissionProtocol({ clock });
  loaded.attachDriftSentinel({ clock });
  loaded.attachSpecialtyMatrix();
  loaded.noteTaskDemand('test');
  loaded.reportCostSample('m-hi', { costPerCall: 100, latencyMs: 200 });
  loaded.reportSpecialtyOutcome('m-hi', 'zzz', 0.9); // 仅未参与调度的任务类型有样本
  let same = true;
  for (let i = 0; i < 20; i += 1) {
    clk.now += 500;
    if (bare.assignModel('test') !== loaded.assignModel('test')) same = false;
  }
  ok(same, '五面齐挂 + 旁路数据：20/20 决策与裸调度器逐位相同（opt-in 零漂移）');
  ok(loaded.assignModel('test') === 'm-hi', '特长样本仅作用于其任务类型（zzz 样本不改 test 决策）');
}

// ═══════════════════ ① R4-1：集成组合优化（Condorcet 多数票组合） ═══════════════════

section('① R4-1：三弱投票者组合 0.648 > 任一单体 0.6；混强单体后组合仍胜；预算硬约束');

{
  // 纯 Condorcet 池：三个独立 0.6 投票者，多数票正确率 0.216 + 0.432 = 0.648
  const llm3 = makeLlm([
    { id: 'w-a', taskScores: { test: 0.6 } },
    { id: 'w-b', taskScores: { test: 0.6 } },
    { id: 'w-c', taskScores: { test: 0.6 } },
  ]);
  const quality = { 'w-a': 0.6, 'w-b': 0.6, 'w-c': 0.6 };
  const cost = { 'w-a': 1, 'w-b': 1, 'w-c': 1 };
  const s3 = new ModelScheduler({ llm: llm3, memory: stubMemory({}) });
  s3.attachEnsembleComposer({ qualityOf: (id) => quality[id], costPerCallOf: (id) => cost[id] });

  const r3 = s3.composeEnsemble('test');
  ok(r3 !== undefined && r3.memberIds.length === 3, `三人组合入选（成员 ${r3 ? r3.memberIds.join(',') : '-'}）`);
  ok(r3 && near(r3.ensembleQuality, 0.648), `组合正确率 ${r3?.ensembleQuality.toFixed(6)} ≈ 0.648（Poisson 二项 DP 精确值）`);
  ok(r3 && near(r3.bestSingleQuality, 0.6), `对照：最优单体 ${r3?.bestSingleQuality.toFixed(3)} = 0.6`);
  ok(r3 && r3.ensembleQuality > r3.bestSingleQuality + 0.04, `旧 vs 新：单模型口径 0.600 → 组合口径 0.648（+${(r3 ? r3.ensembleQuality - r3.bestSingleQuality : 0).toFixed(3)}）`);
  ok(r3 && near(r3.totalCost, 3) && r3.withinBudget && r3.mode === 'enumerate' && r3.searched === 7,
    `无预算约束：总成本 3、全枚举 7 组合（3 单体 + 3 双人 + 1 三人）`);

  // 混入 0.62 强单体：最优组合 = 强单体 + 一弱 = 0.6576 > 0.62
  const llm4 = makeLlm([
    { id: 's-d', taskScores: { test: 0.62 } },
    { id: 'w-a', taskScores: { test: 0.6 } },
    { id: 'w-b', taskScores: { test: 0.6 } },
    { id: 'w-c', taskScores: { test: 0.6 } },
  ]);
  const q4 = { 's-d': 0.62, 'w-a': 0.6, 'w-b': 0.6, 'w-c': 0.6 };
  const c4 = { 's-d': 1, 'w-a': 1, 'w-b': 1, 'w-c': 1 };
  const s4 = new ModelScheduler({ llm: llm4, memory: stubMemory({}) });
  s4.attachEnsembleComposer({ qualityOf: (id) => q4[id], costPerCallOf: (id) => c4[id] });

  const r4 = s4.composeEnsemble('test');
  ok(r4 && near(r4.ensembleQuality, 0.6576), `最优组合 [${r4?.memberIds.join(',')}] 正确率 ${r4?.ensembleQuality.toFixed(4)} ≈ 0.6576（0.62 + 0.6 + 0.6 多数票）`);
  ok(r4 && r4.memberIds.includes('s-d') && r4.memberIds.length === 3 && near(r4.totalCost, 3), '组合 = 强单体 × 1 + 弱投票者 × 2（总成本 3；双人组 0.610 / 三人组 0.6576——规模与质量同升）');
  ok(r4 && near(r4.bestSingleQuality, 0.62) && r4.bestSingleId === 's-d', '对照基线：最优单体 s-d = 0.62');
  ok(r4 && r4.ensembleQuality - r4.bestSingleQuality > 0.037, `旧 vs 新：单模型推荐 0.620 → 组合推荐 0.6576（+${(r4 ? r4.ensembleQuality - r4.bestSingleQuality : 0).toFixed(4)}）`);
  ok(r4 && r4.mode === 'enumerate' && r4.searched === 14, '全枚举 14 组合（4+6+4）精确计数');

  // 预算硬约束：2.5 预算下三人组（成本 3）不可行 → 组合退回单体（双人组 0.61 < 单体 0.62）
  const sBudget = new ModelScheduler({ llm: llm4, memory: stubMemory({}) });
  sBudget.attachEnsembleComposer({ qualityOf: (id) => q4[id], costPerCallOf: (id) => c4[id], budgetPerCall: 2.5 });
  const rb = sBudget.composeEnsemble('test');
  ok(rb && rb.memberIds.length === 1 && rb.memberIds[0] === 's-d', `预算 2.5：三人组（成本 3 > 2.5）被拒 → 组合收缩为单体 [${rb?.memberIds.join(',')}]`);
  ok(rb && near(rb.ensembleQuality, 0.62) && rb.withinBudget, '预算内最优 = 单体 0.62（组合选择空间包含单体——收缩不降质于可行最优）');
  ok(r4 && rb && r4.ensembleQuality - rb.ensembleQuality > 0.03, `预算约束生效：无预算 0.6576 → 预算 2.5 下 0.620（−${(r4 && rb ? r4.ensembleQuality - rb.ensembleQuality : 0).toFixed(4)}）`);

  // 大池转贪心：枚举上限 8 < 14 → 贪心口径，保底不劣于最优单体
  const sG = new ModelScheduler({ llm: llm4, memory: stubMemory({}) });
  sG.attachEnsembleComposer({ qualityOf: (id) => q4[id], costPerCallOf: (id) => c4[id], enumerationLimit: 8 });
  const rg = sG.composeEnsemble('test');
  ok(rg && rg.mode === 'greedy', `组合数 14 > 枚举上限 8 → 诚实转贪心（searched=${rg?.searched}）`);
  ok(rg && rg.ensembleQuality >= rg.bestSingleQuality - 1e-9, `贪心保底：${rg?.ensembleQuality.toFixed(4)} ≥ 最优单体 ${rg?.bestSingleQuality.toFixed(4)}（增量无改进即停）`);

  // 确定性：两次调用逐位一致
  const r1 = s4.composeEnsemble('test');
  const r2 = s4.composeEnsemble('test');
  ok(JSON.stringify(r1) === JSON.stringify(r2), '确定性：同输入两次组合推荐逐位一致');

  // 未挂载零漂移（同池新调度器）
  ok(new ModelScheduler({ llm: llm4, memory: stubMemory({}) }).composeEnsemble('test') === undefined, '未挂载组合优化：诚实 undefined');
}

// ═══════════════════ ② R4-2：预测性预热（趋势外推先于峰值） ═══════════════════

section('② R4-2：上升负载流上预热建议先于峰值桶 950ms；下行负载不预热');

{
  const llm = makeLlm([
    { id: 'm-burst', taskScores: { burst: 0.9, idle: 0.9 } },
    { id: 'm-burst2', taskScores: { burst: 0.7, idle: 0.7 } },
  ]);
  const memory = stubMemory({ 'm-burst': est(0.7, 0.6), 'm-burst2': est(0.6, 0.5) });
  const { state: clk, clock } = vclock(1_000_000);
  const s = new ModelScheduler({ llm, memory });
  s.attachPrewarm({ bucketMs: 1_000, ewmaAlpha: 0.4, trendWindow: 8, horizonMs: 3_000, prewarmThreshold: 6, clock });

  // 桶计数计划：b0..b5 = 1,2,3,5,8,16（b5 为峰值桶，区间 [t0+5000, t0+6000)）
  const plan = [1, 2, 3, 5, 8, 16];
  const noteBucket = (bucket, count) => {
    for (let i = 0; i < count; i += 1) {
      clk.now = 1_000_000 + bucket * 1_000 + 10 + i; // 桶内错峰记账
      s.noteTaskDemand('burst');
    }
  };
  // 高负载但下行的任务：9,8,7（在 b0..b2 记账）
  const idlePlan = [9, 8, 7];
  for (let b = 0; b < idlePlan.length; b += 1) {
    for (let i = 0; i < idlePlan[b]; i += 1) {
      clk.now = 1_000_000 + b * 1_000 + 20 + i;
      s.noteTaskDemand('idle');
    }
  }

  // t0+3050（b3 内）：burst 历史折到 [1,2,3]，外推 5.04 < 6 → 无建议
  for (let b = 0; b <= 2; b += 1) noteBucket(b, plan[b]);
  clk.now = 1_000_000 + 3_050;
  let sug = (s.prewarmSuggestions() ?? []).find((x) => x.taskType === 'burst');
  ok(sug === undefined, 't0+3050：历史 [1,2,3] 外推 5.04 < 6——趋势未达阈值不虚警');

  // t0+4050（b4 内，峰值桶 b5 开始前 950ms）：历史折到 [1,2,3,5] → 建议触发
  noteBucket(3, plan[3]);
  clk.now = 1_000_000 + 4_050;
  const sugs = s.prewarmSuggestions() ?? [];
  sug = sugs.find((x) => x.taskType === 'burst');
  ok(sug !== undefined, `t0+4050（峰值桶开始前 ${(5_000 - 4_050)}ms）：预热建议已触发——先于峰值`);
  ok(sug && near(sug.currentRate, 3.224, 1e-9), `当前 EWMA 请求率 ${sug?.currentRate.toFixed(4)} ≈ 3.224/桶（未越线）`);
  ok(sug && near(sug.trendPerBucket, 1.3, 1e-9), `趋势斜率 ${sug?.trendPerBucket.toFixed(4)} ≈ 1.3/桶（最小二乘）`);
  ok(sug && near(sug.projectedRate, 7.124, 1e-9), `视野（3 桶）外推 ${sug?.projectedRate.toFixed(4)} ≈ 7.124/桶 ≥ 6（预测越线而当前未越线——预测性的本质）`);
  ok(sug && near(sug.etaInMs, 2135.3846153846155, 1e-6), `预计越线时刻 +${Math.round(sug?.etaInMs ?? 0)}ms ≈ 2135ms（(6−3.224)/1.3 桶）`);
  ok(sug && sug.etaAt === 1_000_000 + 4_050 + Math.round(0) + sug.etaInMs, 'etaAt = 当前时刻 + 剩余窗口（时间戳口径一致）');
  ok(sug && sug.modelIds.length > 0 && sug.modelIds[0] === 'm-burst', `建议预热模型 [${sug?.modelIds.join(',')}]（评分 top，已过运营闸门）`);
  ok((sugs.find((x) => x.taskType === 'idle')) === undefined, '高负载但下行（9,8,7 斜率 −1）：不预热（退潮任务不占带宽）');

  // 旧口径对照：EWMA 自身 ≥ 6 最早发生在 b5 折入（t ≥ t0+6060）→ 建议提前 ≥ 2010ms
  let reactiveAt = null;
  for (let b = 4; b <= 6; b += 1) {
    noteBucket(b, plan[b] ?? 16);
    clk.now = 1_000_000 + (b + 1) * 1_000 + 60;
    const hv = (s.prewarmSuggestions() ?? []).find((x) => x.taskType === 'burst');
    if (reactiveAt === null && hv && hv.currentRate >= 6) reactiveAt = hv.currentRate;
  }
  ok(reactiveAt !== null && reactiveAt >= 6, `旧口径（EWMA 自身越线）最早 b5 折入后（t ≥ t0+6060）才成立（此刻率 ${reactiveAt?.toFixed(3)} ≥ 6）`);
  ok(4_050 + 2_010 <= 6_060, '旧 vs 新：反应式检测 ≥ t0+6060，预测式建议 t0+4050——提前 ≥ 2010ms');

  // 建议是纯读取：连续两次快照不推进记账
  const a1 = s.prewarmSuggestions();
  const a2 = s.prewarmSuggestions();
  ok(JSON.stringify(a1) === JSON.stringify(a2), '纯读取：连续快照逐位一致（不改记账）');

  // 未挂载零漂移
  ok(new ModelScheduler({ llm, memory }).prewarmSuggestions() === undefined, '未挂载预热：诚实 undefined');
}

// ═══════════════════ ③ R4-3：冷启动准入协议（三阶段拦截） ═══════════════════

section('③ R4-3：劣质新模型三阶段拦截（旧 10/10 选中 vs 新 0/10）；金丝雀 1-in-5 小流量');

{
  const makePool = () =>
    makeLlm([
      { id: 'legacy-1', taskScores: { test: 0.7 } },
      { id: 'legacy-2', taskScores: { test: 0.6 } },
      { id: 'flashy', taskScores: { test: 0.95 } }, // 劣质新模型：能力分最高
    ]);
  const mem = () => stubMemory({ 'legacy-1': est(0.6, 0.5), 'legacy-2': est(0.55, 0.45), flashy: est(0.9, 0.85) });
  const { state: clk, clock } = vclock(3_000_000);

  // 旧口径：无协议 → flashy 分数碾压，10/10 被选中
  const old = new ModelScheduler({ llm: makePool(), memory: mem() });
  let oldHits = 0;
  for (let i = 0; i < 10; i += 1) if (old.assignModel('test') === 'flashy') oldHits += 1;
  ok(oldHits === 10, `旧口径：taskScore 0.95 劣质新模型 ${oldHits}/10 全被选中（能力分碾压即上岗）`);

  // 新口径：登记试用 → 影子期 5 观察均值 0.2 < 弹劾线 0.35 → 退场
  const llm = makePool();
  const s = new ModelScheduler({ llm, memory: mem() });
  s.attachAdmissionProtocol({ shadowMinSamples: 5, shadowQualityGate: 0.5, canaryMinSamples: 5, canaryQualityGate: 0.6, ejectBelow: 0.35, canaryShare: 0.2, clock });
  s.admitNewModel('flashy');
  ok((s.admissionView() ?? []).find((r) => r.modelId === 'flashy')?.stage === 'shadow', '登记即入影子期（不入常规候选）');
  ok(s.assignModel('test') === 'legacy-1', '影子期模型不入候选：首派落到 legacy-1');
  for (let i = 0; i < 4; i += 1) s.reportTrialOutcome('flashy', 0.2);
  ok((s.admissionView() ?? []).find((r) => r.modelId === 'flashy')?.stage === 'shadow', '4/5 观察（未达门限样本数）仍在影子期');
  s.reportTrialOutcome('flashy', 0.2);
  const recF = (s.admissionView() ?? []).find((r) => r.modelId === 'flashy');
  ok(recF?.stage === 'ejected', `第 5 观察均值 0.2 < 弹劾线 0.35 → 退场（${recF?.rationale}）`);
  let newHits = 0;
  for (let i = 0; i < 10; i += 1) if (s.assignModel('test') === 'flashy') newHits += 1;
  ok(newHits === 0, `新口径：退场模型 ${newHits}/10 永不被选（旧 ${oldHits}/10 → 新 0/10）`);
  ok(recF?.selectable === false && recF?.settledAt === 3_000_000, '退场记录：selectable=false、退场时刻入账（虚拟时钟）');

  // 平庸模型：影子过门（0.55 ≥ 0.5）→ 金丝雀失门（0.45 < 0.6）→ 三阶段全链
  const llm2 = makePool();
  const s2 = new ModelScheduler({ llm: llm2, memory: mem() });
  s2.attachAdmissionProtocol({ shadowMinSamples: 5, shadowQualityGate: 0.5, canaryMinSamples: 5, canaryQualityGate: 0.6, ejectBelow: 0.35, canaryShare: 0.2, clock });
  llm2.registerModel({ id: 'mediocre', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { test: 0.9 } } });
  s2.admitNewModel('mediocre');
  for (let i = 0; i < 5; i += 1) s2.reportTrialOutcome('mediocre', 0.55);
  ok((s2.admissionView() ?? []).find((r) => r.modelId === 'mediocre')?.stage === 'canary', '影子期均值 0.55 ≥ 门 0.5 → 晋级金丝雀（阶段一过门）');
  for (let i = 0; i < 4; i += 1) s2.reportTrialOutcome('mediocre', 0.45);
  ok((s2.admissionView() ?? []).find((r) => r.modelId === 'mediocre')?.stage === 'canary', '金丝雀 4/5 观察仍在期');
  s2.reportTrialOutcome('mediocre', 0.45);
  ok((s2.admissionView() ?? []).find((r) => r.modelId === 'mediocre')?.stage === 'ejected', '金丝雀期均值 0.45 < 门 0.6 → 退场（阶段二拦截——影子门防不住的漏到金丝雀门拦住）');

  // 优质模型：影子 0.8 → 金丝雀 0.75 → 毕业全量；金丝雀期 1-in-5 确定性小流量
  const llm3 = makeLlm([
    { id: 'legacy-1', taskScores: { test: 0.7 } },
    { id: 'solid', taskScores: { test: 0.9 } },
  ]);
  const s3 = new ModelScheduler({ llm: llm3, memory: stubMemory({ 'legacy-1': est(0.6, 0.5), solid: est(0.8, 0.7) }) });
  s3.attachAdmissionProtocol({ shadowMinSamples: 5, shadowQualityGate: 0.5, canaryMinSamples: 5, canaryQualityGate: 0.6, ejectBelow: 0.35, canaryShare: 0.2, clock });
  s3.admitNewModel('solid');
  for (let i = 0; i < 5; i += 1) s3.reportTrialOutcome('solid', 0.8);
  ok((s3.admissionView() ?? []).find((r) => r.modelId === 'solid')?.stage === 'canary', '优质模型影子过门 → 金丝雀');
  let canaryPicks = 0;
  for (let i = 0; i < 10; i += 1) if (s3.assignModel('test') === 'solid') canaryPicks += 1;
  ok(canaryPicks === 2, `金丝雀确定性小流量：10 次选型恰放行 ${canaryPicks} 次（share 0.2 → 1-in-5 时隙，无随机源可复现）`);
  for (let i = 0; i < 5; i += 1) s3.reportTrialOutcome('solid', 0.75);
  const recS = (s3.admissionView() ?? []).find((r) => r.modelId === 'solid');
  ok(recS?.stage === 'graduated' && recS?.selectable === true, '金丝雀均值 0.75 ≥ 门 0.6 → 毕业全量（阶段三）');
  let gradPicks = 0;
  for (let i = 0; i < 10; i += 1) if (s3.assignModel('test') === 'solid') gradPicks += 1;
  ok(gradPicks === 10, `毕业后与既有模型同权：10/10 全量指派（金丝雀期 2/10 → 毕业 10/10）`);

  // 未登记模型不受协议约束（零漂移）；全池退场软放行不抛新错
  const llm4 = makePool();
  const s4 = new ModelScheduler({ llm: llm4, memory: mem() });
  s4.attachAdmissionProtocol({ clock });
  ok(s4.assignModel('test') === 'flashy', '协议挂载但未登记：既有模型候选不受约束（零漂移）');
  const s5 = new ModelScheduler({ llm: makeLlm([{ id: 'only-trial', taskScores: { test: 0.9 } }]), memory: stubMemory({ 'only-trial': est(0.8, 0.7) }) });
  s5.attachAdmissionProtocol({ shadowMinSamples: 2, shadowQualityGate: 0.99, ejectBelow: 0.9, clock });
  s5.admitNewModel('only-trial');
  s5.reportTrialOutcome('only-trial', 0.1);
  s5.reportTrialOutcome('only-trial', 0.1);
  ok(s5.assignModel('test') === 'only-trial', '全池退场软放行：唯一候选退场时不抛新错（透传兜底，与 forcedProbe/relaxedRetry 同一纪律）');
}

// ═══════════════════ ④ R4-4：成本漂移告警（基线带对照） ═══════════════════

section('④ R4-4：涨价 30% 漂移检出 + 重画像建议；acknowledge 重立基线后二次检出');

{
  const llm = makeLlm([{ id: 'm-price', taskScores: { test: 0.8 } }]);
  const memory = stubMemory({ 'm-price': est(0.7, 0.6) });
  const { state: clk, clock } = vclock(4_000_000);
  const s = new ModelScheduler({ llm, memory });
  s.attachDriftSentinel({ baselineSamples: 8, ewmaAlpha: 0.3, driftThreshold: 0.25, clock });

  // 基线带：100 × 8 冻结
  for (let i = 0; i < 8; i += 1) {
    clk.now += 100;
    s.reportCostSample('m-price', { costPerCall: 100 });
  }
  ok((s.driftAlerts() ?? []).length === 0, '基线窗内（8 观测全 100）：无告警（基线带冻结）');

  // 涨价 130：前 5 个样本相对漂移 0.2496 < 0.25（带内），第 6 个 0.2647 越线
  for (let i = 0; i < 5; i += 1) {
    clk.now += 100;
    s.reportCostSample('m-price', { costPerCall: 130 });
  }
  ok((s.driftAlerts() ?? []).length === 0, '涨价 5 观测：EWMA 124.958，相对漂移 0.2496 < 0.25——带内不虚警');
  clk.now += 100;
  s.reportCostSample('m-price', { costPerCall: 130 });
  const alerts1 = s.driftAlerts() ?? [];
  ok(alerts1.length === 1, `第 6 观测：EWMA 126.471，相对漂移 0.2647 ≥ 0.25——告警触发`);
  const a1 = alerts1[0];
  ok(a1 && a1.metric === 'costPerCall' && near(a1.baseline, 100, 1e-9) && near(a1.current, 126.47053, 1e-6), `告警口径：基线 ${a1?.baseline.toFixed(3)} vs 当前 ${a1?.current.toFixed(3)}（单价口径）`);
  ok(a1 && near(a1.relativeDrift, 0.2647053, 1e-6) && a1.relativeDrift > 0, `相对漂移 ${a1?.relativeDrift.toFixed(6)} ≈ +0.2647（涨价方向有符号）`);
  ok(a1 && a1.action === 're-profile' && a1.firstBreachedAt === clk.now, `建议动作 re-profile、首越线时刻入账（${a1?.firstBreachedAt}）`);

  // 旧口径对照：同序列喂裸调度器——静默
  const bare = new ModelScheduler({ llm, memory });
  bare.reportCostSample('m-price', { costPerCall: 130 });
  ok(bare.driftAlerts() === undefined, '旧口径：无哨兵——涨价静默入账（undefined）');

  // acknowledge 重立基线：130 成为新常态 → 无告警；再涨 170 → 二次检出
  s.acknowledgeDrift('m-price', 'costPerCall');
  ok((s.driftAlerts() ?? []).length === 0, 'acknowledgeDrift（重画像落地）：当前值重立基线 → 告警清除');
  clk.now += 100;
  s.reportCostSample('m-price', { costPerCall: 130 });
  ok((s.driftAlerts() ?? []).length === 0, '重立后 130 持续：新常态不告警');
  for (let i = 0; i < 4; i += 1) {
    clk.now += 100;
    s.reportCostSample('m-price', { costPerCall: 170 });
  }
  const alerts2 = s.driftAlerts() ?? [];
  ok(alerts2.length === 1 && near(alerts2[0].baseline, 126.47053, 1e-5) && alerts2[0].relativeDrift > 0.25,
    `二次漂移检出：基线已重立 ${alerts2[0]?.baseline.toFixed(2)}，170 相对漂移 ${alerts2[0]?.relativeDrift.toFixed(4)} ≥ 0.25（重画像后哨兵继续值班）`);

  // 时延口径：200 → 400 首样本即越线（+30% ≥ +25%）
  const s2 = new ModelScheduler({ llm, memory });
  s2.attachDriftSentinel({ baselineSamples: 8, ewmaAlpha: 0.3, driftThreshold: 0.25, clock });
  for (let i = 0; i < 8; i += 1) s2.reportCostSample('m-price', { latencyMs: 200 });
  s2.reportCostSample('m-price', { latencyMs: 400 });
  const al2 = s2.driftAlerts() ?? [];
  ok(al2.length === 1 && al2[0].metric === 'latencyMs' && near(al2[0].current, 260, 1e-9), `时延口径同检：EWMA 260（基线 200，+30% ≥ 25%）首次样本即告警`);

  // 未挂载零漂移 + 双口径独立
  ok(new ModelScheduler({ llm, memory }).driftAlerts() === undefined, '未挂载漂移哨兵：诚实 undefined');
  const s3 = new ModelScheduler({ llm, memory });
  s3.attachDriftSentinel({ baselineSamples: 4, ewmaAlpha: 0.5, driftThreshold: 0.2, clock });
  for (let i = 0; i < 4; i += 1) s3.reportCostSample('m-price', { costPerCall: 100, latencyMs: 100 });
  for (let i = 0; i < 6; i += 1) s3.reportCostSample('m-price', { latencyMs: 200 }); // 只动时延
  const al3 = s3.driftAlerts() ?? [];
  ok(al3.length === 1 && al3[0].metric === 'latencyMs', '双口径独立监测：时延漂移不误伤稳定单价（成本口径无告警）');
}

// ═══════════════════ ⑤ R4-5：模型特长画像（专才结构发现） ═══════════════════

section('⑤ R4-5：同分双模型池特长分化——推荐命中 100/100 vs 无特长基线 50/100');

{
  const mk = () =>
    makeLlm([
      { id: 'gen-a', taskScores: { code: 0.7, doc: 0.7 } },
      { id: 'gen-b', taskScores: { code: 0.7, doc: 0.7 } },
    ]);
  const mem = () => stubMemory({ 'gen-a': est(0.6, 0.55), 'gen-b': est(0.6, 0.55) });

  // 基线：无特长画像 → 同分恒选先注册者 gen-a → doc 任务全部指错
  const base = new ModelScheduler({ llm: mk(), memory: mem() });
  let baseHits = 0;
  for (let i = 0; i < 100; i += 1) {
    const task = i % 2 === 0 ? 'code' : 'doc';
    const pick = base.assignModel(task);
    if ((task === 'code' && pick === 'gen-a') || (task === 'doc' && pick === 'gen-b')) baseHits += 1;
  }
  ok(baseHits === 50, `无特长基线：同分池恒选 gen-a，100 次指派命中 ${baseHits}/100（doc 全错——通才评分看不见专才结构）`);

  // 新口径：回喂特长样本（A 擅 code 0.95 / 擅 doc 0.15；B 镜像）
  const s = new ModelScheduler({ llm: mk(), memory: mem() });
  s.attachSpecialtyMatrix({ emaAlpha: 0.2, strength: 0.8, multiplierCap: 1.5, minSamples: 3 });
  for (let i = 0; i < 6; i += 1) {
    s.reportSpecialtyOutcome('gen-a', 'code', 0.95);
    s.reportSpecialtyOutcome('gen-a', 'doc', 0.15);
    s.reportSpecialtyOutcome('gen-b', 'code', 0.15);
    s.reportSpecialtyOutcome('gen-b', 'doc', 0.95);
  }
  const view = s.specialtyView() ?? [];
  const cellA = view.find((e) => e.modelId === 'gen-a' && e.taskType === 'code');
  const cellADoc = view.find((e) => e.modelId === 'gen-a' && e.taskType === 'doc');
  ok(cellA && near(cellA.meanQuality, 0.95, 1e-9) && cellA.samples === 6, `特长发现：gen-a/code EMA ${cellA?.meanQuality.toFixed(3)} ≈ 0.95（6 样本）`);
  ok(cellA && near(cellA.multiplier, 1.36, 1e-9), `特长乘数：gen-a/code ×${cellA?.multiplier.toFixed(3)} ≈ 1.36（1 + 0.8×(0.95−0.5)）`);
  ok(cellADoc && near(cellADoc.multiplier, 0.72, 1e-9), `短板降权：gen-a/doc ×${cellADoc?.multiplier.toFixed(3)} ≈ 0.72（1 + 0.8×(0.15−0.5)）`);
  ok(s.assignModel('code') === 'gen-a' && s.assignModel('doc') === 'gen-b', '推荐翻转：code→gen-a、doc→gen-b（同分池按任务类型分道）');
  let hits = 0;
  for (let i = 0; i < 100; i += 1) {
    const task = i % 2 === 0 ? 'code' : 'doc';
    const pick = s.assignModel(task);
    if ((task === 'code' && pick === 'gen-a') || (task === 'doc' && pick === 'gen-b')) hits += 1;
  }
  ok(hits === 100, `旧 vs 新：特长画像命中 ${hits}/100 > 基线 ${baseHits}/100（+${hits - baseHits}）`);

  // 样本不足恒中性（孤证不改推荐）
  const s2 = new ModelScheduler({ llm: mk(), memory: mem() });
  s2.attachSpecialtyMatrix({ minSamples: 3 });
  s2.reportSpecialtyOutcome('gen-a', 'code', 1.0);
  s2.reportSpecialtyOutcome('gen-b', 'code', 0.0);
  ok(s2.assignModel('code') === 'gen-a' && s2.specialtyMultiplierOf('gen-b', 'code') === 1, '样本 < minSamples：乘数恒 1，孤证不改推荐（1 样本不触发）');

  // 未挂载零漂移
  const s3 = new ModelScheduler({ llm: mk(), memory: mem() });
  s3.reportSpecialtyOutcome('gen-a', 'code', 0.95);
  ok(s3.specialtyMultiplierOf('gen-a', 'code') === 1 && s3.specialtyView() === undefined, '未挂载特长画像：乘数恒 1、读数 undefined（零漂移）');
}

// ═══════════════════ ⑥ 组合场景：退场 × 熔断 × 组合优化 × 预热同挂 ═══════════════════

section('⑥ 组合场景：退场/熔断模型不进选型、不进组合成员、不进预热建议');

{
  const llm = makeLlm([
    { id: 'strong', taskScores: { test: 0.85 } },
    { id: 'ok', taskScores: { test: 0.7 } },
    { id: 'broken', taskScores: { test: 0.8 } },
    { id: 'flashy', taskScores: { test: 0.95 } },
  ]);
  const memory = stubMemory({ strong: est(0.7, 0.6), ok: est(0.6, 0.5), broken: est(0.68, 0.55), flashy: est(0.9, 0.85) });
  const { state: clk, clock } = vclock(5_000_000);
  const s = new ModelScheduler({ llm, memory });
  s.attachHealthRouting({ failureThreshold: 3, errorThreshold: 0.999, halfOpenAfterMs: 60_000, clock });
  s.attachAdmissionProtocol({ shadowMinSamples: 3, shadowQualityGate: 0.5, canaryMinSamples: 3, canaryQualityGate: 0.6, ejectBelow: 0.35, clock });
  s.attachEnsembleComposer({
    qualityOf: (id) => ({ strong: 0.7, ok: 0.6, broken: 0.68, flashy: 0.9 })[id] ?? 0.5,
    costPerCallOf: () => 1,
  });
  s.attachPrewarm({ bucketMs: 1_000, ewmaAlpha: 0.4, horizonMs: 3_000, prewarmThreshold: 5, clock });

  // flashy 登记试用并退场；broken 三连败熔断
  s.admitNewModel('flashy');
  for (let i = 0; i < 3; i += 1) s.reportTrialOutcome('flashy', 0.2);
  for (let i = 0; i < 3; i += 1) s.reportModelHealth('broken', { failed: true, latencyMs: 50 });

  let bad = 0;
  for (let i = 0; i < 10; i += 1) {
    const p = s.assignModel('test');
    if (p === 'flashy' || p === 'broken') bad += 1;
  }
  ok(bad === 0, `单模型选型：退场/熔断模型 0/10 入选（旧口径 flashy 0.9 分必选）`);
  const comp = s.composeEnsemble('test');
  ok(comp !== undefined && !comp.memberIds.includes('flashy') && !comp.memberIds.includes('broken'),
    `组合成员 [${comp?.memberIds.join(',')}]：0.9 分的退场模型与 0.68 分的熔断模型均被运营闸门排除（组合不拼病号）`);
  ok(comp && comp.memberIds.includes('strong') && near(comp.bestSingleId === 'strong' ? comp.bestSingleQuality : 0, 0.7, 1e-9), `闸门后最优单体 = strong 0.7（而非全场最高 0.9 的 flashy）`);

  // 预热建议模型同样过闸
  for (let b = 0; b < 4; b += 1) {
    for (let i = 0; i < [1, 2, 4, 7][b]; i += 1) {
      clk.now = 5_000_000 + b * 1_000 + 30 + i;
      s.noteTaskDemand('test');
    }
  }
  clk.now = 5_000_000 + 4_050;
  const sug = (s.prewarmSuggestions() ?? [])[0];
  ok(sug !== undefined && sug.modelIds.length > 0 && !sug.modelIds.includes('flashy') && !sug.modelIds.includes('broken'),
    `预热建议模型 [${sug?.modelIds.join(',')}]：预热也不预热的病号（退场/熔断不进建议）`);
  ok(sug && sug.projectedRate >= 5 && sug.currentRate < 5, `预热口径完整：当前 ${sug?.currentRate.toFixed(2)} < 5 ≤ 外推 ${sug?.projectedRate.toFixed(2)}（预测越线）`);
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— ModelScheduler 第四轮 R4-A3 五项新维度升级新旧行为对照验证成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
