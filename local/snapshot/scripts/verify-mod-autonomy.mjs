/**
 * verify-mod-autonomy.mjs — 第三轮世界性升级「自主模块域」离线验证
 * （模块域工程师 A7：goal-engine / curiosity-engine / autonomy-loop）
 *
 * 覆盖六项升级的构造性证明（全程离线，确定性——时钟全部注入）：
 *
 *   S1 目标 DAG（goal-engine）：依赖声明 / 拒环 / 就绪门（前驱未完成不
 *      派发——高价值依赖目标让位给低价值就绪根目标的 razor 级对照）；
 *      无依赖字段 → 就绪恒真（缺省零漂移）
 *   S2 目标预算与陈旧检测（goal-engine）：时间/尝试双轴预算超支、长期
 *      无进展、时限已过、依赖失效 → 自动降级（优先序 × 停滞因子 0.25，
 *      精确值断言）；前提失效的停滞目标自动并入健康同型目标（merged
 *      终态，未决子任务与在途信号绑定不陪葬）；有进展摘帽复权；幂等
 *   S3 目标价值排序（goal-engine）：优先序 = 价值 × 成功率先验
 *      （Beta(1,1) 共轭后验）——零证据先验恒 0.5 → 排序退化为原价值序
 *      （零漂移）；证据积累后双目标竞争翻转（新旧对照：旧口径被高价值
 *      低成功率目标吸死，新口径让位给可推进目标）；连成康复后再夺回
 *   S4 定向好奇（curiosity-engine）：69.0 Mapper 拓扑盲区定向（稀疏 0.4 /
 *      前沿 0.3 / 孤岛 0.3 三轴，孤岛按知识岛规模计）——已知盲区世界
 *      覆盖率对照：定向 3/3 vs 随机基线 0/3（经典口径根本看不见这类
 *      盲区）；未挂载零漂移
 *   S5 心跳相位机（autonomy-loop）：五相位轮转（观察→提案→执行→固化→
 *      休整）配比可配、相位遥测、注入时钟——相位推进序列逐拍确定（双循
 *      环逐位一致）；洞察跨相位缓冲；相位预算超支让位（债记涨、槽位让、
 *      超支者份额下降——新旧对照）；未挂载每拍全流程（零漂移）
 *   S6 心跳节奏自适应（autonomy-loop）：间隔按（待处理目标 × 事件密度）
 *      负载几何插值——忙场景压到下限 / 闲场景顶到上限（方向断言 + 钳位
 *      精确值）；0.5 中性点 = 基线；密度扫描单调不增；未挂载固定间隔
 *   S7 零回归汇总：默认引擎行为与报告结构不变；序列化往返保留新字段
 *
 * 运行：npm run build && node scripts/verify-mod-autonomy.mjs
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

/** 注入时钟工厂：每次调用步进 clock.step 毫秒（相位时长 = step——确定性） */
function steppingClock(initialStep) {
  let t = 0;
  const clock = () => {
    t += clock.step;
    return t;
  };
  clock.step = initialStep;
  return clock;
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

/** 注入分解器：每目标 n 个子任务 */
const decomposerN = (n) => async () => Array.from({ length: n }, (_, i) => ({ description: `step-${i + 1}`, taskType: 'self-improvement' }));

const insight = (suggestion, severity = 0.8, taskType) => ({
  source: 'memory',
  category: 'verify',
  severity,
  message: `洞察：${suggestion}`,
  suggestion,
  taskType,
});

// ══════════════════════════ S1 目标 DAG ══════════════════════════

section('S1 目标 DAG：依赖声明 / 拒环 / 就绪门（缺省零漂移）');

{
  const engine = new GoalEngine({ decomposer: decomposerN(2) });
  // razor 构造：依赖目标价值最高（0.95）但前驱未完成——就绪门必须压过价值排序；
  // 就绪集合内根目标（0.7）> 旁观目标（0.5），派发首位应属根目标。
  // 注意 generateGoalsFromInsights 按严重度降序创建，输入按严重度排布使解构对位
  const [dependent, root, bystander] = engine.generateGoalsFromInsights([
    insight('DAG 依赖目标：高价值但建立在前驱之上', 0.95),
    insight('DAG 根目标：中价值但必须先行', 0.7),
    insight('DAG 独立目标：低价值且无依赖', 0.5),
  ]);
  for (const g of [root, dependent, bystander]) await engine.decompose(g.id);

  ok(dependent.valueScore > root.valueScore, 'S1 前提铺陈：依赖目标价值分确实高于根目标（后续让位是就绪门的功劳，不是价值排序）');

  ok(engine.addDependency(dependent.id, root.id) === true, 'S1 依赖声明成功（dependent 依赖 root）');
  ok(engine.addDependency(dependent.id, root.id) === false, 'S1 重复边拒绝');
  ok(engine.addDependency(root.id, root.id) === false, 'S1 自依赖拒绝');
  ok(engine.addDependency(dependent.id, 'goal-999') === false, 'S1 未知目标拒绝');
  ok(engine.addDependency(root.id, dependent.id) === false, 'S1 成环拒绝（root→dependent 会闭合 dependent→root 环）');

  const view = engine.dependencyView();
  ok(view.acyclic === true, 'S1 依赖视图无环（DFS 三色标记）');
  ok(
    view.goals.find((n) => n.id === dependent.id)?.ready === false &&
      view.goals.find((n) => n.id === root.id)?.ready === true &&
      view.goals.find((n) => n.id === bystander.id)?.ready === true,
    'S1 就绪门读数：前驱未完成 → 依赖目标不就绪；无依赖目标恒就绪',
  );

  // 就绪门 vs 价值排序：根目标两个子任务全部派完前，派发位永远不是高价值依赖目标
  const pick1 = engine.pickNextSubtask();
  engine.markDispatched(pick1.goal.id, pick1.subtask.id, 'sig-s1-1');
  engine.recordSubtaskOutcome(pick1.goal.id, pick1.subtask.id, true, 'done');
  const pick2 = engine.pickNextSubtask();
  engine.markDispatched(pick2.goal.id, pick2.subtask.id, 'sig-s1-2');
  engine.recordSubtaskOutcome(pick2.goal.id, pick2.subtask.id, true, 'done');
  ok(
    pick1.goal.id === root.id && pick2.goal.id === root.id,
    'S1 DAG 派发门生效：高价值依赖目标被就绪门拦下，根目标先行（价值排序在就绪集合内才生效）',
    `派发序列 ${pick1.goal.id} → ${pick2.goal.id}（均为根目标）`,
  );
  ok(root.status === 'completed', 'S1 根目标两子任务完成 → completed');

  const unlocked = engine.pickNextSubtask();
  ok(
    unlocked?.goal.id === dependent.id,
    'S1 前驱 completed → 依赖目标解禁，高价值目标夺回派发首位',
  );

  // 零漂移：未声明依赖的引擎就绪恒真（就绪门不介入——行为 = 原版）
  const plain = new GoalEngine({ decomposer: decomposerN(1) });
  const [plainHigh, plainLow] = plain.generateGoalsFromInsights([insight('普通目标 A', 0.9), insight('普通目标 B', 0.5)]);
  await plain.decompose(plainHigh.id);
  await plain.decompose(plainLow.id);
  ok(
    plain.dependencyView().goals.every((n) => n.ready === true) && plain.pickNextSubtask()?.goal.id === plainHigh.id,
    'S1 零漂移：未声明依赖 → 全部就绪、按价值派发（行为与原版一致）',
  );
}

// ══════════════════════════ S2 目标预算与陈旧检测 ══════════════════════════

section('S2 目标预算与陈旧检测：停滞流（降级 / 合并 / 复权 / 幂等）');

{
  // ── 停滞流主线：g0 放弃 → g1（依赖 g0 + 长期无进展）降级并入健康同型 g2 ──
  const engine = new GoalEngine({ staleNoProgressMs: 1000, decomposer: decomposerN(2) });
  const mk = (sug, taskType) => insight(sug, 0.8, taskType);
  const [g0, g1, g2] = engine.generateGoalsFromInsights([
    mk('停滞流-前提目标', 'gen-code'),
    mk('停滞流-依赖目标', 'gen-code'),
    mk('停滞流-健康同型', 'gen-code'),
  ]);
  for (const g of [g0, g1, g2]) await engine.decompose(g.id);
  engine.addDependency(g1.id, g0.id);

  // g0 两个子任务全部重试耗尽 → abandoned
  for (const s of [...g0.subtasks]) {
    engine.markDispatched(g0.id, s.id, 'sig-g0');
    engine.recordSubtaskOutcome(g0.id, s.id, false, '失败 1');
    engine.markDispatched(g0.id, s.id, 'sig-g0');
    engine.recordSubtaskOutcome(g0.id, s.id, false, '失败 2');
  }
  ok(g0.status === 'abandoned', 'S2 前提目标重试耗尽 → abandoned');

  // g1 无进展超窗（水位回拨 2s > 1s 窗口）；带一个在途子任务（验证信号绑定随合并迁移）
  g1.lastProgressAt -= 2000;
  engine.markDispatched(g1.id, g1.subtasks[0].id, 'sig-merge-inflight');

  const actions = engine.sweepStalledGoals();
  const g1Merged = actions.find((a) => a.goalId === g1.id);
  ok(
    (g1Merged?.reasons ?? []).includes('dependency-invalid') && (g1Merged?.reasons ?? []).includes('no-progress'),
    'S2 停滞成因叠加：依赖失效 + 长期无进展同轮命中（合并动作携带全部成因——审计不丢线索）',
    `reasons = ${g1Merged?.reasons?.join(' + ')}`,
  );
  ok(
    g1Merged !== undefined && g1Merged.action === 'merged' && g1Merged.mergedInto === g2.id,
    'S2 自动合并：前提失效的停滞目标并入健康同型目标（同 taskType 优先；一轮一目标一条处置）',
    `${g1.id} → ${g1Merged?.mergedInto}`,
  );
  ok(g1.status === 'merged' && g1.mergedInto === g2.id, 'S2 源目标终态 merged（mergedInto 可追溯）');
  ok(
    g2.subtasks.length === 4 && g2.subtasks.some((s) => s.signalId === 'sig-merge-inflight'),
    'S2 未决子任务连信号绑定一起迁移（不陪葬）',
    `g2 子任务 ${g2.subtasks.length} 个（含在途信号）`,
  );
  ok(engine.findBySignal('sig-merge-inflight')?.goal.id === g2.id, 'S2 合并后在途信号回写定位到吸收目标（findBySignal 不中断）');
  ok(engine.sweepStalledGoals().every((a) => a.goalId !== g1.id), 'S2 幂等：已处置目标不重复报告');

  // ── 预算：时间轴 ──
  const [budgetGoal] = engine.generateGoalsFromInsights([mk('预算目标-时间轴', 'gen-bench')]);
  await engine.decompose(budgetGoal.id);
  engine.setGoalBudget(budgetGoal.id, { timeMs: 100, maxAttempts: 2 });
  budgetGoal.startedAt = Date.now() - 5000; // 超支 50 倍
  const timeStall = engine.sweepStalledGoals().find((a) => a.goalId === budgetGoal.id);
  ok((timeStall?.reasons ?? []).includes('budget-time'), 'S2 时间预算超支 → budget-time 停滞');
  const demotedPrior = engine.goalSuccessPrior(budgetGoal.id);
  near(demotedPrior, 0.5, 1e-12, 'S2 降级目标先验口径：零证据 → 0.5（降级因子独立于先验）');
  near(
    engine.priorityScore(budgetGoal.id),
    budgetGoal.valueScore * 0.5 * 0.25,
    1e-12,
    'S2 降级精确值：优先序 = 价值 × 先验 0.5 × 停滞因子 0.25',
  );

  // ── 预算：尝试轴 ──
  const [attemptGoal] = engine.generateGoalsFromInsights([mk('预算目标-尝试轴', 'gen-bench')]);
  await engine.decompose(attemptGoal.id);
  engine.setGoalBudget(attemptGoal.id, { maxAttempts: 2 });
  for (let i = 0; i < 3; i += 1) {
    engine.markDispatched(attemptGoal.id, attemptGoal.subtasks[0].id, `sig-att-${i}`);
    engine.recordSubtaskOutcome(attemptGoal.id, attemptGoal.subtasks[0].id, false, '失败');
  }
  const attemptStall = engine.sweepStalledGoals().find((a) => a.goalId === attemptGoal.id);
  ok(
    (attemptStall?.reasons ?? []).includes('budget-attempts'),
    'S2 尝试预算超限 → budget-attempts 停滞',
    `累计派发 3 次 > 预算 2 次`,
  );

  // ── 时限轴 ──
  const [deadlineGoal] = engine.generateGoalsFromInsights([mk('时限目标', 'gen-todo')]);
  await engine.decompose(deadlineGoal.id);
  deadlineGoal.deadline = Date.now() - 1;
  const deadlineStall = engine.sweepStalledGoals().find((a) => a.goalId === deadlineGoal.id);
  ok(
    (deadlineStall?.reasons ?? []).includes('deadline-exceeded'),
    'S2 时限已过且未完成 → deadline-exceeded 停滞（无 dependency-invalid → 不触发合并）',
  );

  // ── 复权：停滞目标产生进展 → 摘帽恢复满优先序 ──
  const beforeRehab = engine.priorityScore(deadlineGoal.id);
  engine.markDispatched(deadlineGoal.id, deadlineGoal.subtasks[0].id, 'sig-rehab');
  engine.recordSubtaskOutcome(deadlineGoal.id, deadlineGoal.subtasks[0].id, true, '成功');
  ok(
    deadlineGoal.stalled === false,
    'S2 复权：停滞目标一次成功进展 → 摘帽（降级是暂停信任，不是销户）',
  );
  near(
    engine.priorityScore(deadlineGoal.id),
    deadlineGoal.valueScore * (2 / 3),
    1e-12,
    'S2 复权精确值：1 成 0 败 → 先验 (1+1)/(1+0+2) = 2/3，停滞因子摘除',
  );
  ok(
    engine.priorityScore(deadlineGoal.id) > beforeRehab,
    'S2 复权方向：摘帽后优先序回升',
    `复权前 ${beforeRehab.toFixed(4)} → 复权后 ${engine.priorityScore(deadlineGoal.id).toFixed(4)}`,
  );

  // ── 陈旧窗口关闭轴（≤0 不判 no-progress——宿主可显式停用）──
  const off = new GoalEngine({ staleNoProgressMs: 0, decomposer: decomposerN(1) });
  const [offGoal] = off.generateGoalsFromInsights([insight('窗口关闭目标')]);
  await off.decompose(offGoal.id);
  offGoal.lastProgressAt -= 10 * 60_000;
  ok(off.sweepStalledGoals().length === 0, 'S2 staleNoProgressMs ≤ 0 → 关闭无进展轴（宿主显式停用，诚实降级）');
}

// ══════════════════════════ S3 目标价值排序 ══════════════════════════

section('S3 目标价值排序：价值 × 成功率先验（双目标竞争，新旧对照）');

{
  const engine = new GoalEngine({ maxActiveGoals: 5, decomposer: decomposerN(7) });
  const [highValue, lowValue] = engine.generateGoalsFromInsights([
    insight('高价值目标：冲击最大短板', 0.95),
    insight('低价值目标：小步快跑', 0.45),
  ]);
  await engine.decompose(highValue.id);
  await engine.decompose(lowValue.id);
  ok(highValue.valueScore > lowValue.valueScore, 'S3 前提铺陈：高价值目标价值分 > 低价值目标');

  // ── 零证据：先验恒 0.5 → 排序退化为原价值序（零漂移）──
  const oldOrder = [highValue, lowValue].sort((a, b) => b.valueScore - a.valueScore).map((g) => g.id);
  const newOrderZeroEvidence = [highValue, lowValue].sort((a, b) => engine.priorityScore(b.id) - engine.priorityScore(a.id)).map((g) => g.id);
  ok(
    oldOrder.join() === newOrderZeroEvidence.join() && engine.pickNextSubtask()?.goal.id === oldOrder[0],
    'S3 零漂移：零证据（Beta(1,1) 先验恒 0.5）时优先序排序 = 原价值排序（单调复合不改序）',
    `旧口径 ${oldOrder.join(' > ')} = 新口径 ${newOrderZeroEvidence.join(' > ')}`,
  );
  near(engine.goalSuccessPrior(highValue.id), 0.5, 1e-12, 'S3 零证据先验 = (0+1)/(0+0+2) = 0.5（Beta 共轭口径）');

  // ── 竞争演进：高价值目标 1 成 9 败 → 让位 ──
  engine.markDispatched(highValue.id, highValue.subtasks[0].id, 'sig-hv-win0');
  engine.recordSubtaskOutcome(highValue.id, highValue.subtasks[0].id, true, '成功');
  for (let i = 1; i <= 3; i += 1) {
    for (let r = 0; r < 3; r += 1) {
      engine.markDispatched(highValue.id, highValue.subtasks[i].id, `sig-hv-${i}-${r}`);
      engine.recordSubtaskOutcome(highValue.id, highValue.subtasks[i].id, false, '失败');
    }
  }
  near(engine.goalSuccessPrior(highValue.id), 1 / 6, 1e-12, 'S3 成功率先验：1 成 9 败 → (1+1)/(10+2) = 0.1667');

  const pickAfterFailures = engine.pickNextSubtask()?.goal.id;
  const oldStylePick = [highValue, lowValue].sort((a, b) => b.valueScore - a.valueScore)[0].id;
  ok(
    pickAfterFailures === lowValue.id && oldStylePick === highValue.id,
    'S3 双目标竞争翻转（新旧对照）：旧价值口径继续押注高价值低成功率目标，新优先序让位给可推进目标',
    `旧口径选 ${oldStylePick}；新口径选 ${pickAfterFailures}（优先序 ${engine.priorityScore(lowValue.id).toFixed(4)} > ${engine.priorityScore(highValue.id).toFixed(4)}）`,
  );

  // ── 康复翻转：低价值目标吃 2 败、高价值目标连成 2 个 → 先验反超夺回第一 ──
  for (let r = 0; r < 2; r += 1) {
    engine.markDispatched(lowValue.id, lowValue.subtasks[0].id, `sig-lv-${r}`);
    engine.recordSubtaskOutcome(lowValue.id, lowValue.subtasks[0].id, false, '失败');
  }
  for (let i = 4; i <= 5; i += 1) {
    engine.markDispatched(highValue.id, highValue.subtasks[i].id, `sig-hv-win-${i}`);
    engine.recordSubtaskOutcome(highValue.id, highValue.subtasks[i].id, true, '成功');
  }
  const priorHigh = engine.goalSuccessPrior(highValue.id); // 3 成 9 败 → 4/14
  const priorLow = engine.goalSuccessPrior(lowValue.id); // 0 成 2 败 → 1/4
  near(priorHigh, 4 / 14, 1e-12, 'S3 高价值先验：3 成 9 败 → (3+1)/(12+2) = 0.2857');
  near(priorLow, 1 / 4, 1e-12, 'S3 低价值先验：0 成 2 败 → (0+1)/(2+2) = 0.25');
  ok(
    engine.pickNextSubtask()?.goal.id === highValue.id,
    'S3 康复夺回：高价值目标连成后先验反超 → 夺回派发首位（排序随证据双向演化，不是一次性惩罚）',
    `高价值 ${priorHigh.toFixed(3)} × 价值 ${(highValue.valueScore).toFixed(4)} = ${(engine.priorityScore(highValue.id)).toFixed(4)} > 低价值 ${priorLow.toFixed(3)} × ${lowValue.valueScore.toFixed(4)} = ${engine.priorityScore(lowValue.id).toFixed(4)}`,
  );
}

// ══════════════════════════ S4 定向好奇 ══════════════════════════

section('S4 定向好奇：69.0 Mapper 拓扑盲区定向 > 随机（覆盖率数字）');

{
  // ── 已知盲区世界：10 类型 ──
  // 经验大陆（7 类型连通，t0/t1 精通、t2–t5 高失败、t9 从未探索）；
  // 拓扑盲区：t6/t7 双型孤岛、t8 单型孤岛——各有 3 成经验，经典口径完全看不见
  const provider = {
    getExposure: () => Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i}`, 10 - i])),
    getExperienceCounts: () => ({ t0: 5, t1: 5, t2: 0, t3: 0, t4: 0, t5: 0, t6: 3, t7: 3, t8: 3, t9: 0 }),
    getFailureRates: () => ({ t2: 0.9, t3: 0.9, t4: 0.9, t5: 0.9 }),
  };
  // Mapper 骨架：大陆两节点经共享成员 t3 连通（7 类型大岛）；两个孤岛分量
  const mapperView = () => ({
    nodes: [
      { members: ['t0', 't1', 't2', 't3'] },
      { members: ['t3', 't4', 't5', 't9'] },
      { members: ['t6', 't7'] },
      { members: ['t8'] },
    ],
    edges: [[0, 1]],
  });
  const BLIND = ['t6', 't7', 't8'];

  const baseline = new CuriosityEngine(provider);
  const directed = new CuriosityEngine(provider);
  directed.attachMapperBlindSpot(mapperView, { weight: 0.5 });

  // ── 零漂移：未挂载引擎的经典口径逐位不变 ──
  const baselineGaps = baseline.scanKnowledgeGaps();
  ok(
    baseline.mapperBlindSpotView() === undefined &&
      baselineGaps.every((g) => g.reason !== 'topological') &&
      baselineGaps.map((g) => g.taskType).join() === ['t2', 't3', 't4', 't5', 't9'].join(),
    'S4 零漂移：未挂载 → 盲区列表与经典口径逐位一致（无 topological 成因）',
    `经典盲区 = ${baselineGaps.map((g) => `${g.taskType}:${g.noveltyScore}`).join(', ')}`,
  );

  // ── 定向读数：孤岛类型入池；t8 三轴全满 ──
  const view = directed.mapperBlindSpotView();
  const topoEntries = directed.scanKnowledgeGaps().filter((g) => g.reason === 'topological');
  ok(
    view !== undefined &&
      topoEntries.map((g) => g.taskType).sort().join() === ['t0', 't1', 't6', 't7', 't8'].sort().join(),
    'S4 拓扑成因补全：视图内有经验但非经典盲区的类型全部入池（含经典口径看不见的孤岛 t6/t7/t8）',
    `topological = ${topoEntries.map((g) => `${g.taskType}:${g.noveltyScore}`).join(', ')}`,
  );
  const t8axes = view.scores.find((s) => s.taskType === 't8');
  ok(
    t8axes !== undefined && near(t8axes.topoScore, 1, 1e-9, 'S4 单型孤岛 t8 综合分 = 1') &&
      t8axes.sparsity >= 0.999 && t8axes.isolation >= 0.999,
    'S4 三轴口径：单型孤岛稀疏/孤岛轴全满（拓扑盲区的数学定义可审计）',
    `t8 { 稀疏 ${t8axes?.sparsity}, 前沿 ${t8axes?.frontier}, 孤岛 ${t8axes?.isolation} }`,
  );
  const t6axes = view.scores.find((s) => s.taskType === 't6');
  const mainlandAxes = view.scores.find((s) => s.taskType === 't2');
  ok(
    t6axes !== undefined &&
      mainlandAxes !== undefined &&
      t6axes.topoScore > mainlandAxes.topoScore &&
      t6axes.isolation > mainlandAxes.isolation,
    'S4 孤岛轴区分度：双型孤岛（知识岛 2 型）> 大陆成员（知识岛 7 型）——孤岛按知识岛规模计',
    `t6 综合 ${t6axes?.topoScore}（孤岛轴 ${t6axes?.isolation}）> t2 综合 ${mainlandAxes?.topoScore}（孤岛轴 ${mainlandAxes?.isolation}）`,
  );

  // ── 覆盖率对照：同样预算 5 轮 × 1 槽 ──
  const runCoverage = (engine) => {
    const explored = [];
    for (let round = 0; round < 5; round += 1) {
      const proposals = engine.proposeExplorations(4, 1); // 预算 floor(4×0.3)=1 槽/轮
      for (const p of proposals) {
        explored.push(p.taskType);
        engine.recordExploration(p.taskType, true, `round-${round}`);
      }
    }
    return { explored, blindCovered: BLIND.filter((t) => explored.includes(t)).length };
  };
  const base = runCoverage(baseline);
  const dir = runCoverage(directed);
  ok(
    base.blindCovered === 0,
    'S4 随机基线：5 轮探索对真盲区（孤岛 t6/t7/t8）覆盖率 0/3——经典口径根本看不见',
    `基线序列 ${base.explored.join(' → ')}，盲区命中 ${base.blindCovered}/3`,
  );
  ok(
    dir.blindCovered === 3,
    'S4 定向好奇：盲区覆盖率 3/3（100%）——拓扑盲区优先吃满预算',
    `定向序列 ${dir.explored.join(' → ')}，盲区命中 ${dir.blindCovered}/3`,
  );
  ok(
    dir.explored.slice(0, 3).sort().join() === BLIND.join(),
    'S4 定向次序：前三槽全部落在盲区（t8 单型孤岛 > t6/t7 双型孤岛——按拓扑分降序）',
  );

  // ── 融合权重精确口径：大陆中心经典盲区的新颖度被拓扑分拉低 ──
  // 定向引擎已探过 t2 一次（稀缺衰减 n=1）——经典侧对照用同探索历史的镜像引擎
  const topoT2 = view.scores.find((s) => s.taskType === 't2')?.topoScore ?? 0;
  const mirror = new CuriosityEngine(provider);
  mirror.recordExploration('t2', true, 'round-3');
  const mirrorT2 = mirror.scanKnowledgeGaps().find((g) => g.taskType === 't2');
  const directedT2 = directed.scanKnowledgeGaps().find((g) => g.taskType === 't2');
  ok(
    mirrorT2 !== undefined &&
      directedT2 !== undefined &&
      directedT2.noveltyScore === Number((mirrorT2.noveltyScore * 0.5 + topoT2 * 0.5).toFixed(3)) &&
      directedT2.noveltyScore < mirrorT2.noveltyScore,
    'S4 融合精确值：大陆中心 t2 新颖度 = 0.5×经典（同探索历史镜像）+ 0.5×拓扑分（拓扑降权让位孤岛）',
    `t2 经典口径 ${mirrorT2?.noveltyScore} → 定向口径 ${directedT2?.noveltyScore}（拓扑分 ${topoT2}）`,
  );
}

// ══════════════════════════ S5 心跳相位机 ══════════════════════════

section('S5 心跳相位机：五相位确定性轮转 + 遥测 + 预算让位（缺省零漂移）');

{
  // ── 确定性：默认配比 1:1:2:1:1 → [O,P,E,E,C,R] 循环，双循环逐位一致 ──
  const loopA = makeLoop();
  const loopB = makeLoop();
  loopA.attachPhaseMachine({ clock: steppingClock(5) });
  loopB.attachPhaseMachine({ clock: steppingClock(5) });
  const seqA = [];
  const seqB = [];
  for (let i = 0; i < 13; i += 1) {
    seqA.push((await loopA.tick()).phase);
    seqB.push((await loopB.tick()).phase);
  }
  const expected = ['observe', 'propose', 'execute', 'execute', 'consolidate', 'rest'];
  ok(
    seqA.join() === Array.from({ length: 13 }, (_, i) => expected[i % 6]).join(),
    'S5 相位推进确定性：默认配比 1:1:2:1:1 → O,P,E,E,C,R 精确循环（执行加倍）',
    `13 拍序列 ${seqA.join(',')}`,
  );
  ok(
    seqA.join() === seqB.join() && JSON.stringify(loopA.phaseView().counts) === JSON.stringify(loopB.phaseView().counts),
    'S5 相位推进可复现：同配置 + 同注入时钟 → 双循环相位序列与遥测逐位一致',
  );
  const pv = loopA.phaseView();
  ok(
    pv.counts.execute === 4 && pv.counts.observe === 3 && pv.counts.rest === 2 && pv.cursor === 13 && pv.cycleIndex === 2,
    'S5 相位遥测：拍数 / 游标 / 周期序号可审计',
    `counts=${JSON.stringify(pv.counts)} cursor=${pv.cursor} cycle=${pv.cycleIndex}`,
  );

  // ── 配比可配：自定义 ratios + rest 退出轮转 ──
  const custom = makeLoop();
  custom.attachPhaseMachine({ ratios: { observe: 2, propose: 1, execute: 1, consolidate: 1, rest: 0 }, clock: steppingClock(5) });
  const customSeq = [];
  for (let i = 0; i < 5; i += 1) customSeq.push((await custom.tick()).phase);
  ok(
    customSeq.join() === 'observe,observe,propose,execute,consolidate',
    'S5 配比可配：{observe:2, rest:0} → [O,O,P,E,C] 且休整相位退出轮转',
  );

  // ── 相位门 + 洞察缓冲：观察拍收集 → 提案拍生成（跨拍不丢洞察）──
  const lessons = [
    { id: 'lesson-1', timestamp: Date.now(), taskType: 'gen-code', rootCause: 'model-capability', lesson: '模型能力不足', suggestion: '升级模型路由策略', signalDescription: 'sig' },
  ];
  let lessonServed = false;
  const phased = makeLoop({
    lessonProvider: () => (lessonServed ? [] : ((lessonServed = true), lessons)),
  });
  phased.attachPhaseMachine({ clock: steppingClock(5) });
  const observeReport = await phased.tick(); // 第 1 拍 = observe
  const proposeReport = await phased.tick(); // 第 2 拍 = propose
  ok(
    observeReport.phase === 'observe' && observeReport.insightsCollected === 1 && observeReport.goalsCreated === 0,
    'S5 相位门：观察拍只收集洞察（不生成目标）',
    `observe 拍：洞察 ${observeReport.insightsCollected} / 目标 ${observeReport.goalsCreated}`,
  );
  ok(
    proposeReport.phase === 'propose' && proposeReport.goalsCreated === 1,
    'S5 洞察缓冲：提案拍消费观察拍缓冲的洞察（相位切分零洞察损失）',
    `propose 拍：目标 ${proposeReport.goalsCreated}（来自上一拍的 1 条洞察）`,
  );

  // ── 零漂移：未挂载相位机 → 每拍全流程（同拍洞察→目标），report.phase 缺席 ──
  let plainServed = false;
  const plainLoop = makeLoop({
    lessonProvider: () => (plainServed ? [] : ((plainServed = true), lessons)),
  });
  const plainReport = await plainLoop.tick();
  ok(
    plainReport.goalsCreated === 1 &&
      plainReport.insightsCollected === 1 &&
      !('phase' in plainReport) &&
      plainLoop.phaseView() === undefined,
    'S5 零漂移：未挂载相位机 → 同拍完成洞察收集与目标生成（全流程），报告无 phase 字段',
    `单拍：洞察 ${plainReport.insightsCollected} → 目标 ${plainReport.goalsCreated}（与原版行为一致）`,
  );

  // ── 相位预算让位：execute 每拍 300ms 超预算 3 倍 → 记债让位，份额下降 ──
  const debtClock = steppingClock(300);
  const budgeted = makeLoop();
  budgeted.attachPhaseMachine({ clock: debtClock, budgetsMs: { execute: 100 } });
  const unbudgeted = makeLoop();
  unbudgeted.attachPhaseMachine({ clock: steppingClock(0) });
  const budgetedSeq = [];
  for (let i = 0; i < 12; i += 1) budgetedSeq.push((await budgeted.tick()).phase);
  for (let i = 0; i < 12; i += 1) await unbudgeted.tick();
  const bView = budgeted.phaseView();
  const uView = unbudgeted.phaseView();
  ok(
    bView.overruns.execute === bView.counts.execute &&
      bView.yielded.execute > 0 &&
      bView.counts.execute < uView.counts.execute,
    'S5 相位预算让位（新旧对照）：超预算相位记债让位——同 12 拍 execute 执行 ' +
      `${bView.counts.execute} < 无预算基线 ${uView.counts.execute}（让出 ${bView.yielded.execute} 槽给后续相位）`,
    `budgeted 序列 ${budgetedSeq.join(',')}；overruns=${bView.overruns.execute} yields=${bView.yielded.execute} debt=${bView.debt.execute.toFixed(1)}`,
  );
  ok(
    bView.durationsMs.execute >= 300 * bView.counts.execute && uView.durationsMs.execute === 0,
    'S5 相位时长计量：注入时钟口径下 execute 累计耗时按实际执行拍数记账',
    `budgeted execute 耗时 ${bView.durationsMs.execute}ms / ${bView.counts.execute} 拍（无预算对照 0ms——步进 0 时钟）`,
  );
}

// ══════════════════════════ S6 心跳节奏自适应 ══════════════════════════

section('S6 心跳节奏自适应：待处理目标 × 事件密度（方向断言 + 钳位）');

{
  const BASE = 30_000;
  const MIN = 5_000;
  const MAX = 120_000;

  /** 构造带目标负载的循环并挂自适应（density 为外部事件密度提供器口径） */
  const makeAdaptive = async (density, goals, subtasksPerGoal) => {
    const goalEngine = new GoalEngine({ maxActiveGoals: 8, decomposer: decomposerN(subtasksPerGoal) });
    for (let i = 0; i < goals; i += 1) {
      const [g] = goalEngine.generateGoalsFromInsights([insight(`负载目标 ${i}`, 0.9, `load-${i}`)]);
      await goalEngine.decompose(g.id);
    }
    const loop = makeLoop({ goalEngine });
    loop.attachAdaptiveHeartbeat({ minMs: MIN, maxMs: MAX, eventDensity: () => density });
    return { loop, goalEngine };
  };
  /** 清空 pending：全部子任务派发并成功 */
  const drainAll = (goalEngine) => {
    for (const g of goalEngine.getAllGoals()) {
      for (const s of [...g.subtasks]) {
        goalEngine.markDispatched(g.id, s.id, 'sig');
        goalEngine.recordSubtaskOutcome(g.id, s.id, true, 'done');
      }
    }
  };

  // ── 闲场景：0 待处理 + 0 密度 → 顶到上限（方向：闲 → 放慢）──
  const idle = await makeAdaptive(0, 1, 3);
  drainAll(idle.goalEngine);
  await idle.loop.tick();
  const idleView = idle.loop.adaptiveHeartbeatView();
  ok(
    idleView !== undefined &&
      near(idleView.intervalMs, MAX, 1, 'S6 闲场景钳位：load=0 → 间隔 = maxMs 精确值') &&
      idleView.intervalMs > BASE &&
      idleView.clampedHigh === true,
    'S6 闲场景方向断言：无待处理目标 + 零事件密度 → 心跳放慢到上限（再闲不睡死）',
    `load=${idleView?.load} → interval=${idleView?.intervalMs}ms > 基线 ${BASE}`,
  );

  // ── 中性点：load=0.5 → 基线间隔（几何插值连续性）──
  // 构造：6 pending，单拍派 2 → 拍后 4 pending（4/8 = 0.5 轴）；密度 10/20 = 0.5 轴
  const neutral = await makeAdaptive(10, 2, 3);
  await neutral.loop.tick(); // 派发 2 个子任务（maxDispatchPerTick=2）→ 4 pending
  const neutralView = neutral.loop.adaptiveHeartbeatView();
  ok(
    neutralView !== undefined &&
      near(neutralView.load, 0.5, 1e-9, 'S6 中性点负载：pending 4/8 × 0.5 + density 10/20 × 0.5 = 0.5') &&
      near(neutralView.intervalMs, BASE, 1, 'S6 中性点间隔：load=0.5 → 间隔 = 基线 heartbeatMs（几何插值连续）'),
    'S6 中性点：负载对半 → 心跳恰为基线间隔（忙/闲两侧围绕基线对称展开）',
    `load=${neutralView?.load}（pending=${neutralView?.pendingGoals}）→ interval=${neutralView?.intervalMs}ms = 基线 ${BASE}`,
  );

  // ── 忙场景：满载待处理 + 满载密度 → 压到下限（方向：忙 → 加快）──
  // 16 pending，单拍派 2 → 拍后 14 ≥ 8 满载；密度 100 ≥ 20 满载 → load=1
  const busy = await makeAdaptive(100, 4, 4);
  await busy.loop.tick();
  const busyView = busy.loop.adaptiveHeartbeatView();
  ok(
    busyView !== undefined &&
      near(busyView.intervalMs, MIN, 1, 'S6 忙场景钳位：load=1 → 间隔 = minMs 精确值') &&
      busyView.intervalMs < BASE &&
      busyView.clampedLow === true,
    'S6 忙场景方向断言：满载待处理目标 + 满载事件密度 → 心跳压到下限（再忙不压垮）',
    `load=${busyView?.load}（pending=${busyView?.pendingGoals} ≥ 8 满载）→ interval=${busyView?.intervalMs}ms < 基线 ${BASE}`,
  );

  // ── 单调性 + 钳位扫描：密度 0→100，间隔单调不增且恒在 [MIN, MAX] ──
  const scan = [];
  for (const d of [0, 10, 15, 20, 50, 100]) {
    const l = await makeAdaptive(d, 1, 3);
    drainAll(l.goalEngine);
    await l.loop.tick(); // pending 0 → load = 0.5×0 + 0.5×min(1, d/20)
    scan.push(l.loop.adaptiveHeartbeatView().intervalMs);
  }
  const monotone = scan.every((v, i) => i === 0 || v <= scan[i - 1] + 1e-9);
  const inRange = scan.every((v) => v >= MIN - 1 && v <= MAX + 1);
  ok(
    monotone && inRange,
    'S6 单调性与钳位：密度 0→100 扫描，间隔单调不增且恒在 [minMs, maxMs] 内',
    `间隔序列 ${scan.join(' → ')}ms`,
  );

  // ── 零漂移：未挂载 → 固定配置间隔 ──
  ok(
    makeLoop().adaptiveHeartbeatView() === undefined && makeLoop().currentHeartbeatMs() === BASE,
    'S6 零漂移：未挂载自适应 → 间隔恒为配置 heartbeatMs（30s）',
  );
}

// ══════════════════════════ S7 零回归汇总 ══════════════════════════

section('S7 零回归：默认引擎行为与结构兼容（序列化往返 / 报告形状）');

{
  // 序列化往返保留第三轮新字段
  const engine = new GoalEngine({ decomposer: decomposerN(2) });
  const [ga, gb] = engine.generateGoalsFromInsights([insight('往返目标 A', 0.9), insight('往返目标 B', 0.6)]);
  await engine.decompose(ga.id);
  await engine.decompose(gb.id);
  engine.addDependency(gb.id, ga.id);
  engine.markDispatched(ga.id, ga.subtasks[0].id, 'sig-rt');
  engine.recordSubtaskOutcome(ga.id, ga.subtasks[0].id, true, 'ok');
  engine.recordSubtaskOutcome(ga.id, ga.subtasks[1].id, false, 'fail');
  const snapshot = engine.serialize();
  const restored = new GoalEngine({ decomposer: decomposerN(2) });
  restored.deserialize(snapshot);
  const ra = restored.getGoal(ga.id);
  const rb = restored.getGoal(gb.id);
  ok(
    JSON.stringify(restored.serialize()) === JSON.stringify(snapshot) &&
      rb?.dependsOn?.join() === ga.id &&
      ra?.outcomes?.successes === 1 &&
      ra?.outcomes?.failures === 1 &&
      ra?.startedAt !== undefined,
    'S7 序列化往返：dependsOn / outcomes / startedAt 等新字段跨会话保留（目标追求可延续）',
  );

  // 摘要结构：既有键原样 + 新键纯增量
  const summary = restored.getSummary();
  ok(
    typeof summary.total === 'number' &&
      typeof summary.byStatus === 'object' &&
      Array.isArray(summary.activeGoals) &&
      summary.activeGoals.every((g) => 'valueScore' in g && 'progress' in g && 'priorityScore' in g && 'successPrior' in g && 'stalled' in g),
    'S7 摘要兼容：既有字段（total/byStatus/activeGoals[].valueScore/progress）原样，新字段（priorityScore/successPrior/stalled）纯增量',
  );

  // 默认循环报告形状：无相位机/自适应 → 新字段缺席（旧消费者零感知）
  const loop = makeLoop();
  const report = await loop.tick();
  ok(
    !('phase' in report) && !('stalledHandled' in report) && loop.getStatus().effectiveHeartbeatMs === 30_000,
    'S7 心跳报告兼容：未挂载时 phase / stalledHandled 缺席，effectiveHeartbeatMs = 配置值（旧消费者零感知）',
  );

  // 心跳提议阶段陈旧处置（挂载相位机才启用）—— propose 拍报 stalledHandled
  const staleEngine = new GoalEngine({ decomposer: decomposerN(1) });
  const [staleGoal] = staleEngine.generateGoalsFromInsights([insight('心跳内停滞目标', 0.9)]);
  await staleEngine.decompose(staleGoal.id);
  staleGoal.deadline = Date.now() - 1; // 时限已过 → deadline-exceeded 停滞
  const staleLoop = makeLoop({ goalEngine: staleEngine });
  staleLoop.attachPhaseMachine({ clock: steppingClock(5), ratios: { observe: 1, propose: 1, execute: 0, consolidate: 0, rest: 0 } });
  await staleLoop.tick(); // observe 拍
  const proposeRt = await staleLoop.tick(); // propose 拍 → sweep
  ok(
    proposeRt.stalledHandled === 1 && staleEngine.getGoal(staleGoal.id)?.stalled === true,
    'S7 心跳集成：挂载相位机后 propose 拍自动处置停滞目标（stalledHandled 上报，未挂载不介入）',
  );
}

// ══════════════════════════ 结果输出 ══════════════════════════

console.log('\n=== 第三轮「自主模块域」升级验证结果 ===');
for (const r of results) {
  if (!r.pass) console.log(`FAIL  ${r.label}\n      ${r.detail}`);
}
console.log(`\nPASS ${passed} / FAIL ${failed}`);
if (failed > 0) {
  console.log('\n✗ 存在未通过的断言，请检查。');
  process.exit(1);
}
console.log('\n✓ 自主模块域六项升级全部通过：目标 DAG（依赖/拒环/就绪门压过价值排序）× 预算与陈旧检测（时间/尝试双轴 + 降级/合并/复权/幂等，停滞流全程构造性证明）× 价值排序（价值×成功率先验：零证据零漂移、竞争翻转、康复夺回）× 定向好奇（拓扑盲区覆盖率 3/3 vs 随机 0/3）× 心跳相位机（确定性轮转 + 配比 + 遥测 + 预算让位）× 节奏自适应（忙闲方向断言 + 精确钳位 + 单调扫描）——目标引擎从「价值爬山」升级为「有预算、有依赖、可降级合并的 DAG 资源分配」，好奇心从「随机乱试」升级为「拓扑盲区定向」，心跳从「固定节拍全流程」升级为「分相位可配比、随负载自适应的显式状态机」。');
process.exit(0);
