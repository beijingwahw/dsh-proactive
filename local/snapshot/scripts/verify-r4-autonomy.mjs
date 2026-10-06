/**
 * verify-r4-autonomy.mjs — 第四轮世界性升级「自主模块域」离线验证
 * （模块域工程师 R4-A7：goal-engine / curiosity-engine / autonomy-loop）
 *
 * 覆盖四项全新维度升级 + 一项加分升级的构造性证明（全程离线，确定性
 * ——时钟全部注入）：
 *
 *   S1 目标冲突检测（goal-engine）：资源池 + 目标资源声明 → 同资源
 *      超预算的互斥目标对成对检出（哪两个目标争什么资源、缺口多少，
 *      精确值断言）+ 池级总超载口径；无冲突对不误报；停滞/终态目标的
 *      声明休眠；未挂载池 / 未声明 → 恒空（零漂移）
 *   S2 探索-利用预算自动平衡（curiosity-engine）：「探索前热后冷」环境
 *      ——热期（连续填补盲区）EWMA 回报率上行 → 有效比例扩张 → 预算
 *      3→4；冷期（连续无收获）EWMA 下行 → 比例收缩 → 预算 4→1；零
 *      样本有效比例恰等于基础比例（挂载即零漂移）；旧口径固定 3 对照
 *   S3 自主动作安全分级（autonomy-loop + goal-engine）：白名单三级
 *      （observe 只读 / act 低风险写 / mutate 高风险变更）——三级动作
 *      流证明分级门正确；高风险无证书被拒（fail-closed）；有证书时
 *      冷却 + 单拍上限逐拍精确放行；拒绝不撞墙（排除集让位，后续
 *      可选动作照常派发）；声明 riskTier > 映射 > 缺省解析序
 *   S4 长期目标里程碑（goal-engine）：季度目标自动分解为里程碑链
 *      （时间锚点均匀切分 + 进度阈值判据），锚点过期未达标 → 延误
 *      预警（延误时长 + 进度缺口精确值）；预警幂等；延误后追赶自动
 *      转 met；deadline 缺省地平线
 *   S5 自主行为时段治理（autonomy-loop，加分）：低峰期窗口（2:00–5:00）
 *      外重活排队不派发、窗口内优先恢复派发；窗口边界（起含终不含）、
 *      跨午夜窗口（22→6）、默认重活级 = mutate、排队上限丢最旧；
 *      consolidate 相位重活（记忆维护）窗口外顺延窗口内补做
 *   S6 零回归汇总：默认引擎 / 循环行为与报告结构不变（新字段纯增量、
 *      未挂载缺席）；pickNextSubtask 排除参数不传逐位不变；序列化往返
 *      保留全部新字段
 *
 * 运行：npm run build && node scripts/verify-r4-autonomy.mjs
 */

import {
  GoalEngine,
  CuriosityEngine,
  AutonomyLoop,
  StrategyEvolutionEngine,
  MetaCognitionEngine,
  mulberry32,
} from '../dist/index.mjs';

// ─────────────────────────── 验证工具（仓库惯例：ok/near/section） ───────────────────────────

const results = [];
let passed = 0;
let failed = 0;

function ok(cond, label, detail = '') {
  const pass = Boolean(cond);
  if (pass) passed += 1;
  else failed += 1;
  results.push({ pass, label, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail) console.log(`      ${detail}`);
  return pass;
}

function near(a, b, tol = 1e-9, label, detail = '') {
  return ok(Math.abs(a - b) <= tol, label, detail || `|${a} − ${b}| ≤ ${tol}`);
}

function section(title) {
  console.log(`\n━━━ ${title} ━━━`);
}

/** 最小心跳依赖代表团（离线可跑） */
function makeLoop(overrides = {}) {
  return new AutonomyLoop({
    goalEngine: new GoalEngine(),
    metaCognition: new MetaCognitionEngine(),
    evolution: new StrategyEvolutionEngine({ rng: mulberry32(20261002) }),
    collectKpi: () => ({}),
    dispatchSubtask: () => `sig-${Math.random().toString(36).slice(2, 8)}`,
    maintainer: { distillExperience: () => 0, applyForgettingCurve: () => ({ decayed: 0, forgotten: 0 }) },
    lessonProvider: () => [],
    ...overrides,
  });
}

/** 洞察工厂（severity 区分创建顺序；taskType 用于风险级映射） */
const insight = (suggestion, severity = 0.8, taskType) => ({
  source: 'memory',
  category: 'verify-r4',
  severity,
  message: `洞察：${suggestion}`,
  suggestion,
  ...(taskType ? { taskType } : {}),
});

/** 分解器：每目标 n 个子任务，taskType 继承目标（风险级映射的解析源） */
const decomposerN = (n) => async (goal) =>
  Array.from({ length: n }, (_, i) => ({ description: `step-${i + 1}`, taskType: goal.taskType ?? 'self-improvement' }));

/** 固定时钟（小时/分口径——时段治理的确定性测试轴） */
const atTime = (hour, minute = 0) => () => new Date(2026, 9, 2, hour, minute, 0, 0);

const DAY = 24 * 60 * 60_000;

// ══════════════════════════ S1 目标冲突检测 ══════════════════════════

async function s1() {
  section('S1 目标冲突检测：资源冲突图（同资源互斥目标对 + 池级超载）');

  const engine = new GoalEngine({ decomposer: decomposerN(1) });
  // 未挂载资源池 → 冲突检测恒空（零漂移）
  ok(engine.detectResourceConflicts().length === 0, 'S1 未挂载资源池 → 冲突检测恒空（零漂移）');
  engine.attachResourcePool({ 'llm-budget': 10, gpu: 8 });
  // 挂载池但无目标声明资源 → 恒空
  ok(engine.detectResourceConflicts().length === 0, 'S1 挂载池但无资源声明 → 无冲突（声明是数据源）');

  const [ga, gb, gc, gd] = engine.generateGoalsFromInsights([
    insight('冲突场景甲：扩模型池', 0.9),
    insight('冲突场景乙：加推理井', 0.85),
    insight('冲突场景丙：小份额任务', 0.8),
    insight('冲突场景丁：GPU 独占任务', 0.75),
  ]);
  ok(engine.declareGoalResources(ga.id, { 'llm-budget': 6 }) && engine.declareGoalResources(gb.id, { 'llm-budget': 6 }), 'S1 资源声明 API 命中目标');
  engine.declareGoalResources(gc.id, { 'llm-budget': 3 });
  engine.declareGoalResources(gd.id, { gpu: 2 });
  ok(!engine.declareGoalResources('goal-999', { gpu: 1 }), 'S1 未知目标声明返回 false');

  const conflicts = engine.detectResourceConflicts();
  ok(conflicts.length === 1, 'S1 双目标争同一预算 → 恰检出一对冲突（丙 6+3=9 ≤ 10 / 丁独占 gpu 不误报）', `检出 ${conflicts.length} 对`);
  const c = conflicts[0];
  ok(c.goals[0] === ga.id && c.goals[1] === gb.id && c.resource === 'llm-budget', 'S1 冲突报告定位：哪两个目标争什么资源', `goals=[${c.goals}] resource=${c.resource}`);
  near(c.totalDemand, 12, 1e-9, 'S1 合计需求 = 6 + 6 = 12');
  near(c.capacity, 10, 1e-9, 'S1 池容量 = 10');
  near(c.shortfall, 2, 1e-9, 'S1 缺口 = 12 − 10 = 2（精确值）');

  const view = engine.resourceConflictView();
  ok(view.overloads.length === 1 && view.overloads[0].resource === 'llm-budget', 'S1 池级超载口径：llm 合计 15 > 10 检出（gpu 2 ≤ 8 不误报）');
  near(view.overloads[0].totalDemand, 15, 1e-9, 'S1 池级合计需求 = 6 + 6 + 3 = 15');
  near(view.overloads[0].shortfall, 5, 1e-9, 'S1 池级缺口 = 15 − 10 = 5');
  ok(view.overloads[0].goals.length === 3, 'S1 超载报告点名全部声明方（3 目标）');

  // 停滞目标的资源声明休眠（降级 = 暂停竞争）
  const stalledEngine = new GoalEngine({ decomposer: decomposerN(1) });
  const [sa, sb, sc] = stalledEngine.generateGoalsFromInsights([insight('停滞场景甲', 0.9), insight('停滞场景乙', 0.85), insight('停滞场景丙', 0.8)]);
  await stalledEngine.decompose(sa.id);
  await stalledEngine.decompose(sb.id);
  await stalledEngine.decompose(sc.id);
  stalledEngine.attachResourcePool({ 'llm-budget': 10 });
  stalledEngine.declareGoalResources(sa.id, { 'llm-budget': 6 });
  stalledEngine.declareGoalResources(sb.id, { 'llm-budget': 6 });
  stalledEngine.declareGoalResources(sc.id, { 'llm-budget': 3 });
  ok(stalledEngine.detectResourceConflicts().length === 1, 'S1 停滞前置：甲乙冲突存在');
  sb.deadline = 1_000 - 1; // 时限已过 → deadline-exceeded 停滞
  const actions = stalledEngine.sweepStalledGoals(1_000);
  ok(actions.length === 1 && actions[0].action === 'demoted' && stalledEngine.detectResourceConflicts().length === 0, 'S1 停滞目标声明休眠：乙降级后冲突消失（甲 6 + 丙 3 = 9 ≤ 10）');

  // 终态目标的资源声明退出竞争
  const doneEngine = new GoalEngine({ decomposer: decomposerN(1) });
  const [da, db] = doneEngine.generateGoalsFromInsights([insight('终态场景甲', 0.9), insight('终态场景乙', 0.85)]);
  await doneEngine.decompose(da.id);
  await doneEngine.decompose(db.id);
  doneEngine.attachResourcePool({ 'llm-budget': 10 });
  doneEngine.declareGoalResources(da.id, { 'llm-budget': 6 });
  doneEngine.declareGoalResources(db.id, { 'llm-budget': 6 });
  ok(doneEngine.detectResourceConflicts().length === 1, 'S1 终态前置：甲乙冲突存在');
  doneEngine.markDispatched(da.id, da.subtasks[0].id, 'sig-done');
  doneEngine.recordSubtaskOutcome(da.id, da.subtasks[0].id, true, '完成');
  ok(doneEngine.getGoal(da.id).status === 'completed' && doneEngine.detectResourceConflicts().length === 0, 'S1 completed 目标退出竞争：冲突随甲完成消失（乙 6 ≤ 10）');
}

// ══════════════════════════ S2 探索-利用预算自动平衡 ══════════════════════════

async function s2() {
  section('S2 探索-利用预算自动平衡：回报率 EWMA 反馈调节（前热后冷）');

  const provider = {
    getExposure: () => Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`type-${i}`, 5])),
    getExperienceCounts: () => ({}),
    getFailureRates: () => ({}),
  };

  // 旧口径：固定比例 0.3 → 10 槽位恒 3 个探索名额
  const legacy = new CuriosityEngine(provider);
  ok(legacy.proposeExplorations(10, 1).length === 3, 'S2 旧口径：固定预算 = floor(10 × 0.3) = 3（恒定，与回报无关）');
  ok(legacy.adaptiveExplorationView() === undefined, 'S2 未挂载 → 自适应遥测缺席');

  const engine = new CuriosityEngine(provider);
  const beforeAttach = engine.proposeExplorations(10, 1);
  engine.attachAdaptiveExploration(); // 缺省：min 0.15 / max 0.45 / α 0.4
  const v0 = engine.adaptiveExplorationView();
  near(v0.effectiveRatio, 0.3, 1e-9, 'S2 挂载即零漂移：零样本有效比例恰等于基础比例 0.3');
  ok(JSON.stringify(engine.proposeExplorations(10, 1)) === JSON.stringify(beforeAttach), 'S2 挂载瞬间探索建议逐位不变（EWMA 初值 = 中性点）');

  // ── 热期：连续 4 次探索填补盲区 ──
  for (let i = 0; i < 4; i += 1) engine.recordExploration(`type-${i}`, true);
  // EWMA: 0.5 → 0.7 → 0.82 → 0.892 → 0.9352（α = 0.4 精确演算；遥测 4 位舍入）
  near(engine.adaptiveExplorationView().yieldEwma, 0.9352, 1e-9, 'S2 热期 EWMA = 0.9352（4 连收精确演算）');
  near(engine.adaptiveExplorationView().effectiveRatio, 0.4306, 1e-9, 'S2 热期有效比例 = 0.15 + 0.3 × 0.9352 = 0.43056（遥测 4 位舍入 0.4306）');
  const hotBudget = engine.proposeExplorations(10, 1).length;
  ok(hotBudget === 4, 'S2 热期预算扩张：3 → 4（回报高多拨，floor(10 × 0.43056) = 4）', `budget=${hotBudget}`);
  ok(engine.adaptiveExplorationView().trend === 'expand', 'S2 热期走向读数 = expand');

  // ── 冷期：连续 4 次探索无收获 ──
  const ratios = [];
  for (let i = 4; i < 8; i += 1) {
    engine.recordExploration(`type-${i}`, false);
    ratios.push(engine.adaptiveExplorationView().effectiveRatio);
  }
  ok(ratios.every((r, i) => i === 0 || r < ratios[i - 1]), 'S2 冷期有效比例逐步单调收缩（连续无收获收紧）', ratios.map((r) => r.toFixed(4)).join(' → '));
  // EWMA: 0.9352 → 0.56112 → 0.336672 → 0.2020032 → 0.12120192（遥测 4 位舍入 0.1212）
  near(engine.adaptiveExplorationView().yieldEwma, 0.1212, 1e-9, 'S2 冷期 EWMA = 0.12120192（4 连败精确演算，遥测舍入 0.1212）');
  near(engine.adaptiveExplorationView().effectiveRatio, 0.1864, 1e-9, 'S2 冷期有效比例 = 0.15 + 0.3 × 0.12120192 = 0.18636（遥测舍入 0.1864）');
  const coldBudget = engine.proposeExplorations(10, 1).length;
  ok(coldBudget === 1, 'S2 冷期预算收缩：4 → 1（预算回流核心任务）', `budget=${coldBudget}`);
  ok(engine.adaptiveExplorationView().trend === 'tighten', 'S2 冷期走向读数 = tighten');

  // 方向汇总：先扩后收（3 → 4 → 1），旧口径恒 3
  ok(legacy.proposeExplorations(10, 1).length === 3, 'S2 新旧对照：同期旧口径预算仍恒 3（无反馈环）');
  ok(hotBudget > 3 && coldBudget < 3, 'S2 方向正确：热期 4 > 基线 3 > 冷期 1（先扩后收）');
}

// ══════════════════════════ S3 自主动作安全分级 ══════════════════════════

async function s3() {
  section('S3 自主动作安全分级：白名单三级门（observe / act / mutate）');

  const tierMap = { 'db-migrate': 'mutate', 'health-read': 'observe', 'report-write': 'act' };

  // ── 单元级：三级裁决口径 ──
  const unitEngine = new GoalEngine({ decomposer: decomposerN(1) });
  const [mGoal, aGoal, oGoal] = unitEngine.generateGoalsFromInsights([
    insight('分级流：数据库迁移', 0.9, 'db-migrate'),
    insight('分级流：报表写入', 0.8, 'report-write'),
    insight('分级流：健康只读', 0.7, 'health-read'),
  ]);
  for (const g of [mGoal, aGoal, oGoal]) await unitEngine.decompose(g.id);
  const unitLoop = makeLoop({ goalEngine: unitEngine });
  let gateNow = 1_000;
  unitLoop.attachActionGate({ tiers: tierMap, clock: () => gateNow });

  const vMutate = unitLoop.authorizeAction(mGoal, mGoal.subtasks[0]);
  ok(vMutate.tier === 'mutate' && vMutate.allowed === false && vMutate.reasons.includes('mutate-no-credential'), 'S3 高风险（mutate）无证书被拒（fail-closed：未配置证书提供器 = 恒无证书）', JSON.stringify(vMutate.reasons));
  const vAct = unitLoop.authorizeAction(aGoal, aGoal.subtasks[0]);
  ok(vAct.tier === 'act' && vAct.allowed === true, 'S3 低风险写（act）常规放行');
  const vObserve = unitLoop.authorizeAction(oGoal, oGoal.subtasks[0]);
  ok(vObserve.tier === 'observe' && vObserve.allowed === true, 'S3 只读观察（observe）恒放行');

  // 声明 riskTier > 映射 > 缺省 的解析序
  oGoal.subtasks[0].riskTier = 'mutate'; // 只读类型显式声明高风险
  const vDeclared = unitLoop.authorizeAction(oGoal, oGoal.subtasks[0]);
  ok(vDeclared.tier === 'mutate' && vDeclared.allowed === false, 'S3 解析序：子任务显式声明 riskTier 压过 taskType 映射');
  oGoal.subtasks[0].riskTier = undefined;
  const vUnmapped = unitLoop.authorizeAction({ ...oGoal, taskType: 'unknown-type' }, { ...oGoal.subtasks[0], taskType: 'unknown-type' });
  ok(vUnmapped.tier === 'act', 'S3 解析序：未映射未声明 → 缺省级 act');

  // 证书 + 确认 + 双拒绝原因
  let confirmations = 0;
  const credLoop = makeLoop();
  credLoop.attachActionGate({
    tiers: tierMap,
    credential: () => false,
    confirmation: () => {
      confirmations += 1;
      return false;
    },
    clock: () => gateNow,
  });
  const vBoth = credLoop.authorizeAction(mGoal, mGoal.subtasks[0]);
  ok(!vBoth.allowed && vBoth.reasons.includes('mutate-no-credential') && vBoth.reasons.includes('mutate-unconfirmed'), 'S3 高风险拒绝原因可叠加（无证书 + 未确认同时报告）', JSON.stringify(vBoth.reasons));
  ok(confirmations === 1, 'S3 确认回调被征询（高风险需显式确认）');

  // ── 循环级：三级动作流（高风险无证书被拒，其余照常派发，拒绝不撞墙） ──
  const flowEngine = new GoalEngine({ decomposer: decomposerN(1) });
  const [fm, fa, fo] = flowEngine.generateGoalsFromInsights([
    insight('动作流：高风险迁移', 0.9, 'db-migrate'),
    insight('动作流：中风险写报表', 0.8, 'report-write'),
    insight('动作流：低风险只读', 0.7, 'health-read'),
  ]);
  for (const g of [fm, fa, fo]) await flowEngine.decompose(g.id);

  // 旧口径（无门）：三级全部放行——高风险无证书照样派发
  const legacyDispatched = [];
  // 旧口径直接在独立引擎上构造同型三目标
  const legacyEngine = new GoalEngine({ decomposer: decomposerN(1) });
  const [lm, la, lo] = legacyEngine.generateGoalsFromInsights([
    insight('旧口径：高风险迁移', 0.9, 'db-migrate'),
    insight('旧口径：中风险写', 0.8, 'report-write'),
    insight('旧口径：低风险只读', 0.7, 'health-read'),
  ]);
  for (const g of [lm, la, lo]) await legacyEngine.decompose(g.id);
  const legacyLoop2 = makeLoop({
    goalEngine: legacyEngine,
    config: { maxDispatchPerTick: 3 },
    dispatchSubtask: (s) => {
      legacyDispatched.push(s.taskType);
      return `sig-${s.id}`;
    },
  });
  const legacyReport = await legacyLoop2.tick();
  ok(legacyReport.subtasksDispatched === 3 && legacyDispatched.includes('db-migrate'), 'S3 旧口径对照：无门时代高风险 mutate 派发 1/1（无任何拦截）', `dispatched=[${legacyDispatched}]`);

  const gatedDispatched = [];
  const gatedLoop = makeLoop({
    goalEngine: flowEngine,
    config: { maxDispatchPerTick: 3 },
    dispatchSubtask: (s) => {
      gatedDispatched.push(s.taskType);
      return `sig-${s.id}`;
    },
  });
  gatedLoop.attachActionGate({ tiers: tierMap, clock: () => gateNow }); // 无证书
  const gatedReport = await gatedLoop.tick();
  ok(gatedReport.subtasksDispatched === 2 && gatedReport.actionGated === 1, 'S3 三级动作流：mutate 拒 1、act/observe 放 2（单拍内完成分级裁决）', `dispatched=[${gatedDispatched}] gated=${gatedReport.actionGated}`);
  ok(!gatedDispatched.includes('db-migrate') && gatedDispatched.includes('report-write') && gatedDispatched.includes('health-read'), 'S3 分级门正确：高风险被拒后派发机会让位给低风险动作（不撞墙）');
  ok(flowEngine.getGoal(fm.id).subtasks[0].status === 'pending', 'S3 被拒子任务仍 pending（下轮证书就绪可重试，不计失败）');

  // ── 证书 + 冷却 + 单拍上限：逐拍精确放行 ──
  const coolEngine = new GoalEngine({ decomposer: decomposerN(2) });
  const [cm] = coolEngine.generateGoalsFromInsights([insight('冷却场景：双步迁移', 0.9, 'db-migrate')]);
  await coolEngine.decompose(cm.id);
  const coolLoop = makeLoop({ goalEngine: coolEngine, config: { maxDispatchPerTick: 3 } });
  coolLoop.attachActionGate({ tiers: tierMap, credential: () => true, mutateCooldownMs: 1_000, maxMutatePerTick: 1, clock: () => gateNow });

  gateNow = 1_000;
  const coolR1 = await coolLoop.tick();
  ok(coolR1.subtasksDispatched === 1 && coolR1.actionGated === 1, 'S3 单拍上限：同拍第 2 个 mutate 被 mutate-cap-per-tick 拒（缺省每拍至多 1 次）', `dispatched=${coolR1.subtasksDispatched} gated=${coolR1.actionGated}`);
  ok(coolLoop.actionGateView().byReason['mutate-cap-per-tick'] === 1, 'S3 遥测：拒绝原因计数入账');

  gateNow = 1_500; // 距上次 mutate 500ms < 冷却 1000ms
  const coolR2 = await coolLoop.tick();
  ok(coolR2.subtasksDispatched === 0 && coolR2.actionGated === 1 && coolLoop.actionGateView().byReason['mutate-cooldown'] === 2, 'S3 冷却期：500ms < 1000ms → mutate-cooldown 拒（含 t1 同拍零间隔共记 2 次，下轮重试不丢失）');

  gateNow = 2_100; // 距上次 mutate 1100ms ≥ 冷却
  const coolR3 = await coolLoop.tick();
  ok(coolR3.subtasksDispatched === 1 && (coolR3.actionGated ?? 0) === 0, 'S3 冷却到期：1100ms ≥ 1000ms → 放行（冷却精确边界，本轮零拒绝）');
  ok(coolLoop.actionGateView().mutateDispatched === 2 && coolLoop.actionGateView().allowed === 2, 'S3 遥测：mutate 累计派发 2 / 放行 2');
}

// ══════════════════════════ S4 长期目标里程碑 ══════════════════════════

async function s4() {
  section('S4 长期目标里程碑：里程碑链生成 + 延误预警 + 追赶转 met');

  ok(new GoalEngine().planMilestones('goal-404', { count: 3, now: 0 }).length === 0, 'S4 未知目标规划 → 空链');

  const engine = new GoalEngine({ decomposer: decomposerN(3) });
  const t0 = 100 * DAY;
  const [q] = engine.generateGoalsFromInsights([insight('季度长期目标：重构调度核心', 0.9)]);
  await engine.decompose(q.id);

  const chain = engine.planMilestones(q.id, { count: 3, horizonMs: 90 * DAY, now: t0 });
  ok(chain.length === 3, 'S4 季度目标 → 3 里程碑链');
  near(chain[0].dueAt, t0 + 30 * DAY, 1e-9, 'S4 锚点 1 = t0 + 30d（地平线均匀切分）');
  near(chain[1].dueAt, t0 + 60 * DAY, 1e-9, 'S4 锚点 2 = t0 + 60d');
  near(chain[2].dueAt, t0 + 90 * DAY, 1e-9, 'S4 锚点 3 = t0 + 90d');
  near(chain[0].progressAtLeast, Number((1 / 3).toFixed(4)), 1e-12, 'S4 判据 1 = 进度 ≥ 1/3');
  near(chain[1].progressAtLeast, Number((2 / 3).toFixed(4)), 1e-12, 'S4 判据 2 = 进度 ≥ 2/3');
  near(chain[2].progressAtLeast, 1, 1e-12, 'S4 判据 3 = 进度 ≥ 100%');
  ok(chain.every((m) => m.status === 'pending' && m.criterion.includes('%')), 'S4 里程碑初始 pending + 判据文本可审计');

  // deadline 缺省地平线 + 数量钳位（独立引擎——不污染主延误流）
  const aux = new GoalEngine({ decomposer: decomposerN(3) });
  const [q2] = aux.generateGoalsFromInsights([insight('带时限的长期目标', 0.9)]);
  await aux.decompose(q2.id);
  q2.deadline = t0 + 90 * DAY;
  const chain2 = aux.planMilestones(q2.id, { count: 3, now: t0 });
  near(chain2[2].dueAt, t0 + 90 * DAY, 1e-9, 'S4 缺省地平线 = deadline − now（未显式传 horizonMs）');
  ok(aux.planMilestones(q2.id, { count: 99, now: t0 }).length === 12, 'S4 里程碑数钳位上限 12');
  ok(aux.planMilestones(q2.id, { count: 0, now: t0 }).length === 1, 'S4 里程碑数钳位下限 1');

  // t0 + 31d：进度 0 → M1 延误 1 天
  let delays = engine.sweepMilestoneDelays(t0 + 31 * DAY);
  ok(delays.length === 1 && delays[0].index === 0 && delays[0].milestoneId === 'ms-goal-1-0', 'S4 延误检出：M1 锚点过期未达标（M2/M3 未到期不误报）', `delays=${delays.length}`);
  near(delays[0].delayMs, 1 * DAY, 1e-9, 'S4 M1 延误时长 = 31d − 30d = 1 天（精确值）');
  near(delays[0].progressShortfall, Number((1 / 3).toFixed(4)), 1e-12, 'S4 M1 进度缺口 = 1/3 − 0（离达标还差多少）');
  ok(q.milestones[0].status === 'overdue' && q.milestones[0].warnedAt === t0 + 31 * DAY, 'S4 里程碑状态 overdue + 预警时刻留档');

  // 幂等：再次扫描不重复报
  ok(engine.sweepMilestoneDelays(t0 + 32 * DAY).length === 0, 'S4 预警幂等：已预警里程碑不重复报（warnedAt 标记）');

  // 追赶：完成 1/3 子任务 → M1 进度补齐转 met
  engine.markDispatched(q.id, q.subtasks[0].id, 'sig-ms-1');
  engine.recordSubtaskOutcome(q.id, q.subtasks[0].id, true, '第一阶段完成');
  delays = engine.sweepMilestoneDelays(t0 + 32 * DAY);
  ok(q.milestones[0].status === 'met' && q.milestones[0].metAt === t0 + 32 * DAY, 'S4 延误后追赶：进度 1/3 ≥ 判据 → M1 自动转 met（metAt 记账）');
  ok(delays.length === 0, 'S4 追赶拍无新预警（M2 未到期）');

  // t0 + 91d：进度仍 1/3 → M2 延误 31 天 + M3 延误 1 天
  delays = engine.sweepMilestoneDelays(t0 + 91 * DAY);
  ok(delays.length === 2 && delays[0].index === 1 && delays[1].index === 2, 'S4 二次延误：M2 / M3 同时检出（各自锚点计）');
  near(delays[0].delayMs, 31 * DAY, 1e-9, 'S4 M2 延误 = 91d − 60d = 31 天');
  near(delays[1].delayMs, 1 * DAY, 1e-9, 'S4 M3 延误 = 91d − 90d = 1 天');
  near(delays[0].progressShortfall, 0.3334, 1e-12, 'S4 M2 进度缺口 = 0.6667 − 0.3333 = 0.3334（4 位舍入口径）');

  // 零漂移：无里程碑的目标参与扫描 → 恒空
  const plain = new GoalEngine({ decomposer: decomposerN(1) });
  const [pg] = plain.generateGoalsFromInsights([insight('无里程碑目标', 0.9)]);
  await plain.decompose(pg.id);
  ok(plain.sweepMilestoneDelays(t0 + 91 * DAY).length === 0, 'S4 未规划里程碑 → 延误扫描恒空（零漂移）');
}

// ══════════════════════════ S5 自主行为时段治理 ══════════════════════════

async function s5() {
  section('S5 自主行为时段治理：低峰期窗口 + 窗口外排队 + 窗口内恢复');

  // ── 窗口外排队 → 窗口内恢复（含边界） ──
  const engine = new GoalEngine({ decomposer: decomposerN(1) });
  const [heavy] = engine.generateGoalsFromInsights([insight('重建索引：语料库重活', 0.9, 'reindex-corpus')]);
  await engine.decompose(heavy.id);
  const dispatched = [];
  let now = atTime(1); // 01:00 —— 窗口（2:00–5:00）外
  const loop = makeLoop({
    goalEngine: engine,
    config: { maxDispatchPerTick: 2 },
    dispatchSubtask: (s) => {
      dispatched.push(s.taskType);
      return `sig-${s.id}`;
    },
  });
  loop.attachActivityWindow({ window: { startHour: 2, endHour: 5 }, heavyTaskTypes: ['reindex-corpus'], clock: () => now() });

  const rt1 = await loop.tick();
  ok(rt1.subtasksDispatched === 0 && rt1.windowQueued === 1 && dispatched.length === 0, 'S5 窗口外重活：不派发、入队（windowQueued 上报）');
  ok(loop.activityWindowView().queued === 1 && loop.activityWindowView().insideWindow === false, 'S5 遥测：队列 1 项 / 窗口外');
  ok(engine.getGoal(heavy.id).subtasks[0].status === 'pending', 'S5 排队不占派发位：子任务仍 pending');

  now = atTime(2); // 02:00 —— 窗口起点（含）
  const rt2 = await loop.tick();
  ok(rt2.windowDrained === 1 && rt2.subtasksDispatched === 1 && dispatched.length === 1, 'S5 起窗边界（含起点 2:00）：排队重活恢复派发（优先于新派发）');
  ok(loop.activityWindowView().queued === 0 && loop.activityWindowView().drained === 1, 'S5 遥测：队列清空 / 累计恢复 1');

  // 终点边界（不含）：5:00 已出窗
  const [heavy2] = engine.generateGoalsFromInsights([insight('重建索引：向量库重活', 0.85, 'reindex-corpus')]);
  await engine.decompose(heavy2.id);
  now = atTime(5);
  const rt3 = await loop.tick();
  ok(rt3.subtasksDispatched === 0 && rt3.windowQueued === 1, 'S5 终窗边界（不含终点 5:00）：再次出窗 → 重新排队');
  now = atTime(4, 59); // 4:59 仍在窗内
  const rt4 = await loop.tick();
  ok(rt4.windowDrained === 1 && dispatched.length === 2, 'S5 窗内终前一拍（4:59）：恢复派发');

  // ── 跨午夜窗口（22 → 6） ──
  const nightEngine = new GoalEngine({ decomposer: decomposerN(1) });
  const [nightHeavy] = nightEngine.generateGoalsFromInsights([insight('夜间批量：日志归档', 0.9, 'archive-logs')]);
  await nightEngine.decompose(nightHeavy.id);
  const nightLoop = makeLoop({
    goalEngine: nightEngine,
    dispatchSubtask: (s) => `sig-${s.id}`,
  });
  nightLoop.attachActivityWindow({ window: { startHour: 22, endHour: 6 }, heavyTaskTypes: ['archive-logs'], clock: atTime(23) });
  const nightR1 = await nightLoop.tick();
  const nightView = nightLoop.activityWindowView();
  ok(nightView.insideWindow === true && nightR1.subtasksDispatched === 1 && !nightR1.windowQueued, 'S5 跨午夜窗口：23:00 ∈ [22, 6) → 直接派发');
  const [nightHeavy2] = nightEngine.generateGoalsFromInsights([insight('夜间批量：冷备快照', 0.85, 'snapshot-db')]);
  await nightEngine.decompose(nightHeavy2.id);
  nightEngine.getGoal(nightHeavy2.id).subtasks[0].riskTier = 'mutate'; // 声明高风险
  nightLoop.attachActivityWindow({ window: { startHour: 22, endHour: 6 }, heavyTaskTypes: ['archive-logs'], clock: atTime(7) });
  const nightR2 = await nightLoop.tick();
  ok(nightR2.subtasksDispatched === 0 && nightR2.windowQueued === 1, 'S5 跨午夜窗口：7:00 ∉ [22, 6) → mutate 级重活排队（声明 riskTier 压过类型表）');

  // ── 默认重活级 = mutate（未配置 heavyTaskTypes 时） ──
  const tierEngine = new GoalEngine({ decomposer: decomposerN(1) });
  const [tg] = tierEngine.generateGoalsFromInsights([insight('默认重活级验证：配置热切换', 0.9, 'config-write')]);
  await tierEngine.decompose(tg.id);
  tierEngine.getGoal(tg.id).subtasks[0].riskTier = 'mutate';
  const tierLoop = makeLoop({ goalEngine: tierEngine, dispatchSubtask: (s) => `sig-${s.id}` });
  tierLoop.attachActivityWindow({ window: { startHour: 2, endHour: 5 }, clock: atTime(12) });
  const tierR = await tierLoop.tick();
  ok(tierR.subtasksDispatched === 0 && tierR.windowQueued === 1 && tierLoop.activityWindowView().heavyTiers.includes('mutate'), 'S5 缺省重活级 = [mutate]：声明 mutate 的子任务窗口外排队');
  const [lightSibling] = tierEngine.generateGoalsFromInsights([insight('默认重活级验证：伴生轻活', 0.8, 'config-write-light')]);
  await tierEngine.decompose(lightSibling.id);
  const tierR2 = await tierLoop.tick();
  ok(tierR2.subtasksDispatched === 1 && (tierR2.windowQueued ?? 0) === 0, 'S5 窗口外轻活不受限：伴生低风险任务照常派发（已排队项不重复入队）');

  // ── 排队上限（队满丢最旧） ──
  const capEngine = new GoalEngine({ decomposer: decomposerN(1) });
  const capGoals = [];
  for (let i = 0; i < 3; i += 1) {
    const [g] = capEngine.generateGoalsFromInsights([insight(`排队上限：重活 ${i + 1} 号`, 0.9 - i * 0.01, 'bulk-job')]);
    await capEngine.decompose(g.id);
    capGoals.push(g);
  }
  const capLoop = makeLoop({
    goalEngine: capEngine,
    config: { maxDispatchPerTick: 3 },
    dispatchSubtask: (s) => `sig-${s.id}`,
  });
  capLoop.attachActivityWindow({ window: { startHour: 2, endHour: 5 }, heavyTaskTypes: ['bulk-job'], clock: atTime(1), maxQueue: 2 });
  const capR = await capLoop.tick();
  ok(capR.windowQueued === 3 && capLoop.activityWindowView().queued === 2, 'S5 排队上限：3 项重活入队尝试、队列保 2（队满丢最旧，防无界积压）', `queued=${capLoop.activityWindowView().queued}`);

  // ── consolidate 相位重活窗口外顺延 ──
  let maintenanceCalls = 0;
  let maintainClock = atTime(1);
  const maintLoop = makeLoop({
    config: { maintenanceEveryTicks: 1 },
    maintainer: {
      distillExperience: () => {
        maintenanceCalls += 1;
        return 0;
      },
      applyForgettingCurve: () => ({ decayed: 0, forgotten: 0 }),
    },
  });
  maintLoop.attachActivityWindow({ window: { startHour: 2, endHour: 5 }, clock: () => maintainClock() });
  const mR1 = await maintLoop.tick();
  ok(mR1.maintenance === undefined && maintenanceCalls === 0, 'S5 consolidate 重活窗口外顺延：记忆维护不执行');
  maintainClock = atTime(3);
  const mR2 = await maintLoop.tick();
  ok(mR2.maintenance !== undefined && maintenanceCalls === 1, 'S5 窗口内补做：维护恢复执行（周期触发自然补做，不丢拍面）');

  // ── 零漂移：未挂载窗口 → 任意时刻立即派发 ──
  const freeEngine = new GoalEngine({ decomposer: decomposerN(1) });
  const [freeHeavy] = freeEngine.generateGoalsFromInsights([insight('零漂移：高峰期重活', 0.9, 'bulk-job')]);
  await freeEngine.decompose(freeHeavy.id);
  const freeLoop = makeLoop({ goalEngine: freeEngine, dispatchSubtask: (s) => `sig-${s.id}` });
  const freeR = await freeLoop.tick(); // 真实时钟（无论几点）
  ok(freeR.subtasksDispatched === 1 && !('windowQueued' in freeR) && freeLoop.activityWindowView() === undefined, 'S5 零漂移：未挂载窗口 → 重活即时派发、报告无窗口字段');
}

// ══════════════════════════ S6 零回归汇总 ══════════════════════════

async function s6() {
  section('S6 零回归汇总：缺省行为不变 + 新字段纯增量');

  // GoalEngine 缺省：新检测轴全部恒空
  const engine = new GoalEngine({ decomposer: decomposerN(1) });
  const [g1, g2] = engine.generateGoalsFromInsights([insight('回归：高价值目标', 0.9), insight('回归：次价值目标', 0.7)]);
  await engine.decompose(g1.id);
  await engine.decompose(g2.id);
  ok(engine.detectResourceConflicts().length === 0 && engine.sweepMilestoneDelays(Date.now()).length === 0, 'S6 缺省引擎：冲突 / 延误检测恒空（未挂载/未规划零介入）');

  // pickNextSubtask：不传排除参数逐位不变；传排除集让位
  const pick1 = engine.pickNextSubtask();
  const pick2 = engine.pickNextSubtask(undefined);
  ok(pick1.subtask.id === pick2.subtask.id && pick1.goal.id === pick2.goal.id, 'S6 pickNextSubtask() 不传参数逐位不变（高价值目标优先）');
  const pickNext = engine.pickNextSubtask([pick1.subtask.id]);
  ok(pickNext !== null && pickNext.subtask.id !== pick1.subtask.id, 'S6 排除集：被排除者让位给次优先目标');
  ok(engine.pickNextSubtask([pick1.subtask.id, pickNext.subtask.id]) === null, 'S6 全排除 → null（无隐式回退）');

  // 序列化往返保留新字段（resources / milestones / riskTier）
  const persistEngine = new GoalEngine({ decomposer: decomposerN(1) });
  const [pg] = persistEngine.generateGoalsFromInsights([insight('持久化：带新字段目标', 0.9)]);
  await persistEngine.decompose(pg.id);
  persistEngine.attachResourcePool({ 'llm-budget': 10 });
  persistEngine.declareGoalResources(pg.id, { 'llm-budget': 6 });
  persistEngine.planMilestones(pg.id, { count: 3, horizonMs: 90 * DAY, now: 0 });
  persistEngine.getGoal(pg.id).subtasks[0].riskTier = 'mutate';
  const restored = new GoalEngine();
  restored.deserialize(persistEngine.serialize());
  ok(restored.getGoal(pg.id).resources['llm-budget'] === 6, 'S6 序列化往返：resources 保留');
  ok(restored.getGoal(pg.id).milestones.length === 3 && restored.getGoal(pg.id).milestones[2].dueAt === 90 * DAY, 'S6 序列化往返：里程碑链与锚点保留');
  ok(restored.getGoal(pg.id).subtasks[0].riskTier === 'mutate', 'S6 序列化往返：子任务 riskTier 保留');

  // CuriosityEngine 缺省：挂载自适应但零样本 → 建议逐位等于未挂载
  const provider = {
    getExposure: () => ({ 'a-task': 5, 'b-task': 4, 'c-task': 3 }),
    getExperienceCounts: () => ({}),
    getFailureRates: () => ({}),
  };
  const cPlain = new CuriosityEngine(provider);
  const cAdaptive = new CuriosityEngine(provider);
  const plainProposals = JSON.stringify(cPlain.proposeExplorations(5, 1));
  cAdaptive.attachAdaptiveExploration();
  ok(JSON.stringify(cAdaptive.proposeExplorations(5, 1)) === plainProposals, 'S6 好奇心缺省：未挂载 / 挂载零样本的建议逐位一致（零漂移）');

  // AutonomyLoop 缺省：报告字段缺席 + 派发行为与旧版一致
  const loop = makeLoop({ goalEngine: engine, config: { maxDispatchPerTick: 2 }, dispatchSubtask: (s) => `sig-${s.id}` });
  const report = await loop.tick();
  ok(
    !('actionGated' in report) && !('windowQueued' in report) && !('windowDrained' in report) && loop.actionGateView() === undefined,
    'S6 心跳报告兼容：未挂载时 actionGated / windowQueued / windowDrained 缺席（旧消费者零感知）',
  );
  ok(report.subtasksDispatched === 2 && report.goalsCreated === 0 && report.explorationsDispatched === 0, 'S6 派发行为与旧版一致：2 目标 2 派发（既有链路零漂移）');
}

// ══════════════════════════ 主流程 ══════════════════════════

await s1();
await s2();
await s3();
await s4();
await s5();
await s6();

// ─────────────────────────── 新旧数字对照 ───────────────────────────

console.log('\n━━━ 第四轮「自主模块域」新旧口径数字对照 ━━━');
console.log('S1 目标冲突检测   旧（无检测）冲突发现 0 对 / 池级超载 0 项  →  新 1 对（甲乙争 llm-budget，12 vs 10，缺口 2）+ 池级 1 项（15 vs 10，缺口 5）；无冲突对 0 误报');
console.log('S2 探索预算平衡   旧固定 3 名额/拍（与回报无关）           →  新热期 4（EWMA 0.9352，比例 0.43056）→ 冷期 1（EWMA 0.1212，比例 0.1864）；先扩后收方向正确');
console.log('S3 动作安全分级   旧高风险 mutate 放行 1/1（无证书也派发）  →  新无证书拒 1/1（fail-closed）+ 冷却 1000ms 精确边界 + 单拍上限 1；observe/act 放行不变');
console.log('S4 目标里程碑     旧延误检出 0（无里程碑概念）              →  新季度链 3 锚点（30/60/90d）检出延误 3 处（1d/31d/1d，缺口精确）；追赶自动转 met；预警幂等');
console.log('S5 时段治理       旧任意时刻即时派发（含高峰重活）           →  新窗口外排队 1 / 窗口内恢复 1（边界起含终不含）；consolidate 重活窗口外 0 次执行 → 窗口内补做 1 次');

// ══════════════════════════ 结果输出 ══════════════════════════

console.log('\n=== 第四轮「自主模块域」升级验证结果 ===');
for (const r of results) {
  if (!r.pass) console.log(`FAIL  ${r.label}\n      ${r.detail}`);
}
console.log(`\nPASS ${passed} / FAIL ${failed}`);
if (failed > 0) {
  console.log('\n✗ 存在未通过的断言，请检查。');
  process.exit(1);
}
console.log('\n✓ 自主模块域第四轮五项升级全部通过：目标冲突检测（同资源互斥对 + 池级超载双口径，缺口精确、零误报、停滞/终态休眠）× 探索-利用预算自动平衡（回报率 EWMA：热期 3→4 扩张、冷期 4→1 收缩、挂载即零漂移）× 动作安全分级（observe/act/mutate 三级白名单：无证书 fail-closed、冷却/单拍上限精确边界、拒绝不撞墙）× 长期目标里程碑（季度链均匀锚点 + 进度判据、延误检出/幂等/追赶转 met）× 时段治理（低峰窗排队/恢复、跨午夜窗口、consolidate 重活顺延补做）——目标引擎从「单目标视角的资源分配」升级为「多目标资源冲突可见的仲裁层」，好奇心从「固定配额」升级为「有收益率反馈的探索-利用平衡」，心跳从「分级前的无条件派发」升级为「风险分级 + 时段治理的双闸门自主行为治理」。');
process.exit(0);
