/**
 * verify-mod-reflect.mjs — 第三轮世界性升级「反思轴模块域 A6（重派）」验证
 *
 * 覆盖 optimizer.ts / reflector.ts / reflection-engine.ts 的 6 个升级面：
 *
 *   S1 经验检索置信路由（optimizer）：recallPlan 从「模式置信度单一字段」
 *      升级为字段加权综合分（置信度 0.5 + 历史成功率 0.3 + 样本支撑度 0.2）
 *      × 时效新鲜度（30 天半衰期）。构造同一份「置信度 0.95 的半匹配
 *      经验」三副本：新鲜全胜 → 命中路由（返回 source='memory' 计划）；
 *      陈旧 60 天（freshness=0.25）→ 回退 DAG（undefined + below-confidence
 *      落账）；成功率 25%（1 胜 3 负）→ 同样回退（高置信 ≠ 好经验）。
 *      新旧对照：未挂载的优化器对同一陈旧经验仍返回计划（旧口径逐位不变）。
 *   S2 推荐理由分解（optimizer）：三模型历史（model-q 质量高慢贵 /
 *      model-s 快 / model-c 省）→ lookupExperience 输出 recommendation：
 *      三维记分卡数值与画像统计一致（质量维 = 质量水平×成功概率）、
 *      备选按综合分降序、各维最优者与构造一致、rationale 含三维说明。
 *   S3 重试策略 bandit 化（reflection-engine）：『重试同模型（成本 100）
 *      vs 换模型（成本 30）』ε 递减 bandit 对照固定规则跑同一 60 轮失败
 *      流（40 轮中段质量 0.5 + 20 轮低段 0.3）：固定规则在中段反复
 *      retry-same 烧钱（总成本 4600），bandit 从失败成本账里学出换臂
 *      （总成本显著更低）；ε 序列单调不增且收敛到下限 ≥ εmin。
 *   S4 反事实结果记录（reflector）：沉淀时记录实际臂 + 结果 + 备选臂
 *      估计（贝叶斯后验，证据门槛 minSamples）；台账可转 OPE 数据集
 *      （Episode[] + 行为策略 μ + 全局臂索引）——88.0 消费口径。
 *   S5 洞察去重与衰减（reflector）：同一 (taskType, model) 的重复洞察
 *      合并为一条（hits 累加，条目数 = 去重后键数）；注入时钟推进 90 天
 *      → freshness 0.125 → 有效分跌破阈值沦为遗忘候选。
 *   S6 沉淀价值评分（reflector，加分项）：高频命中的沉淀条目 value 高
 *      （retain）；从未命中且闲置 90 天的条目 value=0（forget-candidate）
 *      —— 历史命中频率先验对接 60.0 遗忘语义。
 *   S7 挂载面兼容与零漂移：前任留下的 attach* 面（pidDiagnostics /
 *      astarPlanner / sparseAttribution / crowdAggregation /
 *      preferenceLearning / argumentation）挂载后行为正常；六项新升级
 *      未挂载时全部 undefined / 空账（缺省零漂移）。
 *
 * 全程离线确定性（注入时钟 + 固定种子 mulberry32 由内核自持）。
 * 运行：npm run build && node scripts/verify-mod-reflect.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LongTermMemory,
  MemoryGraph,
  Optimizer,
  Reflector,
  ReflectionEngine,
} from '../dist/index.mjs';

// ─────────────────────────── 断言工具（verify-genesis-kernels.mjs 风格） ───────────────────────────
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

const DAY = 86_400_000;
/** 注入时钟基准（全部时间敏感断言以此为准，与真实墙钟解耦） */
const T0 = 1_750_000_000_000;

/** 测试数据工厂：信号 / 计划 / 执行结果（verify-knowledge-distillation 同款口径） */
let signalSeq = 0;
function makeSignal(type, description) {
  return {
    id: `sig-${++signalSeq}`,
    type,
    description,
    payload: {},
    receivedAt: T0,
    source: 'verify-mod-reflect',
    occurrences: 1,
  };
}
function makePlan(type, objective) {
  return {
    objective,
    nodes: [{ id: 'node-1', description: objective, type, dependsOn: [] }],
    parallelismStrategy: 'layered',
    source: 'fallback',
  };
}
function makeResult(modelId, success, quality) {
  return {
    planId: 'plan-1',
    success,
    nodeResults: [
      {
        nodeId: 'node-1',
        modelId,
        success,
        quality,
        latency: 1000,
        attempts: 1,
        error: success ? undefined : '质量不达标',
        tokensUsed: 100,
      },
    ],
    totalTime: 1000,
    successCount: success ? 1 : 0,
    totalTokens: 100,
    avgQuality: quality,
  };
}

/** 手工构造情景模式（绕开记忆库写入路径，精确控制置信路由的输入形态） */
function mkPattern(overrides = {}) {
  const base = {
    fingerprint: 'verify-r3a6::0.5::code',
    taskSummary: 'A6 半匹配经验样本',
    frequency: 10,
    firstSeenAt: T0,
    lastSeenAt: T0,
    successfulPlans: [
      {
        timestamp: T0,
        plan: {
          objective: '目标',
          nodes: [{ id: 'n1', description: '步骤', type: 'code', dependsOn: [] }],
          parallelismStrategy: 'layered',
        },
        modelAssignments: { n1: 'model-a' },
        totalLatency: 1000,
        qualityScores: { n1: 0.9 },
        tokenCost: 100,
      },
    ],
    failureRecords: [],
    confidence: 0.95,
    avgExecutionTime: 1000,
    avgQualityScore: 0.9,
  };
  return { ...base, ...overrides };
}
const mkFailureRecord = (ts) => ({ timestamp: ts, reason: 'r', failedNodeId: 'n1', failedModelId: 'model-a', errorMessage: 'e' });
/** 手工构造经验检索结果（recallPlan 只读 lookup.pattern，直接可控） */
function mkLookup(pattern) {
  return {
    pattern,
    recommendedModels: {},
    historicalSuccessRate: pattern ? pattern.successfulPlans.length / Math.max(1, pattern.successfulPlans.length + pattern.failureRecords.length) : 0,
    avgExecutionTime: 1000,
    memoryLayer: 'episodic',
    rationale: 'verify',
    avoidModels: [],
    policyVersion: 'verify@v1',
  };
}

// ══════════════════════════ S1 经验检索置信路由（optimizer） ══════════════════════════
section('S1 经验检索置信路由：字段加权 + 时效衰减，命中 / 回退两路由');

{
  const memPath = path.join(os.tmpdir(), `dsh-verify-mod-reflect-s1-${Date.now()}.json`);
  fs.rmSync(memPath, { force: true });
  const memory = new LongTermMemory(memPath);

  let clockNow = T0;
  const optRouted = new Optimizer({ memory });
  optRouted.attachRecallConfidenceRouting({ now: () => clockNow });
  const optLegacy = new Optimizer({ memory }); // 未挂载：旧口径对照

  // ① 新鲜全胜：confidence 0.95 / 3 胜 0 负 / frequency 10 → weightedBase 0.975，freshness 1 → 命中
  const fresh = mkPattern({
    frequency: 10,
    successfulPlans: [mkPattern().successfulPlans[0], mkPattern().successfulPlans[0], mkPattern().successfulPlans[0]],
    lastSeenAt: clockNow,
  });
  const scoreFresh = optRouted.recallConfidenceOf(fresh);
  ok(scoreFresh !== undefined, '置信评分读数可用（挂载后）');
  ok(near(scoreFresh.weightedBase, 0.5 * 0.95 + 0.3 * 1 + 0.2 * 1, 1e-5), `字段加权原始分 = 0.975（实测 ${scoreFresh.weightedBase}）`);
  ok(near(scoreFresh.freshness, 1, 1e-6) && near(scoreFresh.composite, 0.975, 1e-5), `新鲜度 1 × 加权分 → 综合分 0.975（实测 ${scoreFresh.composite}）`);
  const planHit = optRouted.recallPlan(mkLookup(fresh), '命中路由目标');
  ok(planHit !== undefined && planHit.source === 'memory', '命中路由：新鲜全胜经验直接复用历史计划（source=memory）');

  // ② 陈旧半匹配：同经验 60 天未见 → freshness 0.25 → 综合分 0.244 < 0.9 → 回退 DAG 并落账
  const stale = mkPattern({ lastSeenAt: clockNow - 60 * DAY });
  const scoreStale = optRouted.recallConfidenceOf(stale);
  ok(near(scoreStale.freshness, 0.25, 1e-6), `60 天陈旧经验半衰期衰减 → freshness 0.25（实测 ${scoreStale.freshness}）`);
  ok(near(scoreStale.composite, 0.975 * 0.25, 1e-5) && scoreStale.route === 'fallback', `综合分跌破阈值 → 回退路由（实测 ${scoreStale.composite}）`);
  const planStale = optRouted.recallPlan(mkLookup(stale), '回退路由目标');
  ok(planStale === undefined, '回退路由：陈旧经验返回 undefined（编排层走 DAG 生成）');
  const routesAfterStale = optRouted.recentRecallRoutes(2);
  ok(routesAfterStale[0]?.reason === 'below-confidence' && routesAfterStale[0]?.route === 'fallback', '回退决策落账（reason=below-confidence 可审计）');

  // ③ 成功率半匹配：置信度 0.95 但 1 胜 3 负（率 0.25、frequency 4）→ 加权分 0.65 → 回退
  const halfRate = mkPattern({
    frequency: 4,
    lastSeenAt: clockNow,
    successfulPlans: [mkPattern().successfulPlans[0]],
    failureRecords: [mkFailureRecord(T0), mkFailureRecord(T0), mkFailureRecord(T0)],
  });
  const scoreHalf = optRouted.recallConfidenceOf(halfRate);
  ok(near(scoreHalf.weightedBase, 0.5 * 0.95 + 0.3 * 0.25 + 0.2 * 0.5, 1e-5), `低成功率折价：加权分 0.65（实测 ${scoreHalf.weightedBase}）`);
  ok(scoreHalf.route === 'fallback', '高置信 ≠ 好经验：成功率平庸同样回退');

  // ④ 无模式 / 无成功记录的结构化 reason
  optRouted.recallPlan(mkLookup(undefined), '无模式');
  ok(optRouted.recentRecallRoutes(1)[0]?.reason === 'no-pattern', '无模式回退落账（reason=no-pattern）');

  // ⑤ 路由统计
  const stats = optRouted.recallRouteStats();
  ok(stats.total === 3 && stats.hits === 1 && stats.fallbacks === 2, `路由账本统计：3 决策 = 1 命中 + 2 回退（实测 ${stats.total}/${stats.hits}/${stats.fallbacks}）`);

  // ⑥ 新旧对照（零漂移）：未挂载的优化器对同一陈旧经验仍按旧口径返回计划
  const planLegacy = optLegacy.recallPlan(mkLookup(stale), '旧口径');
  ok(planLegacy !== undefined && planLegacy.source === 'memory', '旧口径对照：未挂载时单一置信度比较照常命中（零漂移）');
  ok(optLegacy.recentRecallRoutes().length === 0 && optLegacy.recallConfidenceOf(fresh) === undefined, '未挂载零落账 / 零读数');
  memory.dispose();
}

// ══════════════════════════ S2 推荐理由分解（optimizer） ══════════════════════════
section('S2 推荐理由分解：三模型历史 → 质量 / 成本 / 速度三维记分卡');

{
  const memPath = path.join(os.tmpdir(), `dsh-verify-mod-reflect-s2-${Date.now()}.json`);
  fs.rmSync(memPath, { force: true });
  const memory = new LongTermMemory(memPath);
  const TASK = 'code-generation';
  const seed = (modelId, latency, quality, tokens, seq) => {
    memory.recordSuccess({
      taskType: TASK,
      complexity: 0.5,
      features: ['code'],
      taskSummary: `${TASK}: 样本 ${seq}`,
      plan: {
        objective: `目标 ${seq}`,
        nodes: [{ id: `node-${seq}`, description: `步骤 ${seq}`, type: TASK, dependsOn: [] }],
        parallelismStrategy: 'layered',
      },
      modelAssignments: { [`node-${seq}`]: modelId },
      totalLatency: latency,
      qualityScores: { [`node-${seq}`]: quality },
      tokenCost: tokens,
    });
  };
  // 三模型各 3 次成功：model-q 质量高但慢且贵 / model-s 快 / model-c 省
  for (let i = 1; i <= 3; i += 1) seed('model-q', 9000, 0.95, 900, i);
  for (let i = 4; i <= 6; i += 1) seed('model-s', 500, 0.7, 200, i);
  for (let i = 7; i <= 9; i += 1) seed('model-c', 3000, 0.8, 50, i);

  const opt = new Optimizer({ memory });
  opt.attachRecommendationDecomposition({ refLatencyMs: 5000, weights: { quality: 0.5, cost: 0.25, speed: 0.25 } });
  const lookup = opt.lookupExperience(TASK, 0.5, ['code']);
  ok(lookup.recommendation !== undefined, '挂载后 lookupExperience 附带推荐理由分解');
  const rec = lookup.recommendation;
  const byModel = Object.fromEntries([rec.primary, ...rec.alternatives].filter(Boolean).map((s) => [s.modelId, s]));
  ok(Object.keys(byModel).length === 3, `三模型全部入分解（实测 ${Object.keys(byModel).length}）`);

  // 质量维 = 质量水平（EMA=常量）× 成功概率（3 胜后验 ≈ 0.8）
  ok(near(byModel['model-q'].quality, 0.95 * 0.8, 1e-3), `质量维：model-q = 0.95×0.8 = ${byModel['model-q'].quality}`);
  // 成本维：costEfficiency 从 0 起步的 EMA，3 次同质调用后 = x·(1−0.5³) = 0.875x
  ok(near(byModel['model-c'].cost, (0.8 / 1.05) * 0.875, 1e-3) && byModel['model-c'].cost > byModel['model-s'].cost && byModel['model-s'].cost > byModel['model-q'].cost, `成本维排序：c(${byModel['model-c'].cost}) > s > q（质量/千 token）`);
  // 速度维：1/(1+latency/5000)
  ok(near(byModel['model-s'].speed, 1 / 1.1, 1e-3) && byModel['model-s'].speed > byModel['model-c'].speed && byModel['model-c'].speed > byModel['model-q'].speed, `速度维排序：s(${byModel['model-s'].speed}) > c > q（时延倒数）`);
  // 备选按综合分降序
  const comps = rec.alternatives.map((a) => 0.5 * a.quality + 0.25 * a.cost + 0.25 * a.speed);
  ok(comps.every((c, i) => i === 0 || comps[i - 1] >= c), `备选按三维综合分降序（${comps.map((c) => c.toFixed(3)).join(' ≥ ')}）`);
  ok(rec.rationale.includes('质量') && rec.rationale.includes('成本') && rec.rationale.includes('速度'), `三维理由文本可读：${rec.rationale.slice(0, 80)}…`);

  // 零漂移对照：未挂载的优化器无 recommendation 字段
  const optBare = new Optimizer({ memory });
  ok(optBare.lookupExperience(TASK, 0.5, ['code']).recommendation === undefined, '未挂载零漂移：recommendation 字段省略');
  memory.dispose();
}

// ══════════════════════════ S3 重试策略 bandit 化（reflection-engine） ══════════════════════════
section('S3 重试 bandit：ε 递减 + 失败成本入账，总成本 < 固定规则');

{
  const engine = new ReflectionEngine({ qualityThreshold: 0.7 });
  // 零漂移对照：未挂载时无 bandit 决策（编排层回退固定规则）
  ok(engine.retryBanditDecide() === undefined && engine.retryBanditStatus() === undefined, '未挂载零漂移：bandit 决策 / 状态均 undefined');

  engine.attachRetryBandit({ seed: 7, epsilon0: 0.3, epsilonMin: 0.02, decay: 0.97 });

  // 世界设定：该任务类型的模型根本不行——retry-same 每次烧 100 成本，
  // retry-switch 换臂后每次 30。固定规则只在质量 < 60% 阈值时才换模型。
  const COST_SAME = 100;
  const COST_SWITCH = 30;
  const costOf = (arm) => (arm === 'retry-same' ? COST_SAME : COST_SWITCH);

  // 60 轮失败流：40 轮中段质量 0.5（0.42 ≤ q < 0.7 → 固定规则 retry-same）
  //             20 轮低段质量 0.30（< 0.42 → 固定规则 retry-switch）
  const rounds = [];
  for (let i = 0; i < 60; i += 1) rounds.push(i % 3 === 2 ? 0.3 : 0.5);

  // ① 固定规则结算（公开口径：reflect() → verdict.retryAdvice）
  let fixedCost = 0;
  let fixedSameCount = 0;
  for (const q of rounds) {
    const verdict = await engine.reflect({
      node: { id: 'n1', description: 'd', type: 'bandit-task' },
      output: 'o',
      baseQuality: q,
      signal: makeSignal('bandit-task', 'bandit 对照'),
    });
    const arm = verdict.retryAdvice === 'retry-switch' ? 'retry-switch' : 'retry-same';
    if (arm === 'retry-same') fixedSameCount += 1;
    fixedCost += costOf(arm);
  }
  ok(fixedSameCount === 40, `固定规则：中段 40 轮全部 retry-same（实测 ${fixedSameCount}）`);
  ok(fixedCost === 40 * COST_SAME + 20 * COST_SWITCH, `固定规则总成本 = ${fixedCost}（40×100 + 20×30）`);

  // ② bandit 结算（ε 递减 + 成本入账）
  const engine2 = new ReflectionEngine({ qualityThreshold: 0.7 });
  engine2.attachRetryBandit({ seed: 7, epsilon0: 0.3, epsilonMin: 0.02, decay: 0.97 });
  const first = engine2.retryBanditDecide();
  ok(first.arm === 'retry-switch' && first.explored === false, `冷启动初始化拉 = retry-switch（补另一臂信息，实测 ${first.arm}）`);
  let banditCost = 0;
  const epsilons = [];
  let lateSamePulls = 0;
  for (const q of rounds) {
    const d = engine2.retryBanditDecide();
    epsilons.push(d.epsilon);
    // 质量档信息仍入决策上下文（bandit 与固定规则看同一流；本世界两档成本结构一致）
    void q;
    banditCost += costOf(d.arm);
    engine2.retryBanditSettle(d.arm, costOf(d.arm));
    if (d.arm === 'retry-same' && epsilons.length > 30) lateSamePulls += 1;
  }
  const status = engine2.retryBanditStatus();
  ok(epsilons.every((e, i) => i === 0 || epsilons[i - 1] >= e), `ε 单调不增：${epsilons[0].toFixed(4)} → ${epsilons[epsilons.length - 1].toFixed(4)}`);
  ok(epsilons[epsilons.length - 1] >= 0.02, `ε 收敛到下限（≥ εmin=0.02，实测 ${epsilons[epsilons.length - 1]}）`);
  ok(status.greedyArm === 'retry-switch', `bandit 学出贪心最优臂 = retry-switch（平均成本 ${status.avgCost['retry-switch']} < ${status.avgCost['retry-same']}）`);
  ok(status.totalPulls === 60 && near(status.totalCost, banditCost, 1e-6), `失败成本全量入账：60 拉 / 总成本 ${status.totalCost}`);
  ok(lateSamePulls <= 6, `后期（>30 轮）retry-same 残留 ≤ 6 次（实测 ${lateSamePulls}——ε 探索残余）`);
  ok(banditCost < fixedCost, `总成本对照：bandit ${banditCost} < 固定规则 ${fixedCost}（省 ${(((fixedCost - banditCost) / fixedCost) * 100).toFixed(1)}%）`);
}

// ══════════════════════════ S4 反事实结果记录（reflector） ══════════════════════════
section('S4 反事实台账：实际臂 + 结果 + 备选臂估计 → OPE 数据集');

{
  const memPath = path.join(os.tmpdir(), `dsh-verify-mod-reflect-s4-${Date.now()}.json`);
  fs.rmSync(memPath, { force: true });
  const memory = new LongTermMemory(memPath);
  const TASK = 'translate';
  // model-a（实际使用）与 model-b（备选）各积累 4 次成功画像（≥ minSamples=3）
  const seed = (modelId, seq) =>
    memory.recordSuccess({
      taskType: TASK,
      complexity: 0.4,
      features: [],
      taskSummary: `${TASK}: ${seq}`,
      plan: { objective: 'o', nodes: [{ id: `n-${seq}`, description: 'd', type: TASK, dependsOn: [] }], parallelismStrategy: 'layered' },
      modelAssignments: { [`n-${seq}`]: modelId },
      totalLatency: 1000,
      qualityScores: { [`n-${seq}`]: 0.85 },
      tokenCost: 100,
    });
  for (let i = 1; i <= 4; i += 1) seed('model-a', `a${i}`);
  for (let i = 1; i <= 4; i += 1) seed('model-b', `b${i}`);

  let clockNow = T0;
  const engine = new ReflectionEngine({ qualityThreshold: 0.7 });
  const reflector = new Reflector({ memory, reflection: engine, config: { enableProgress: false, autoDistillThreshold: 0 } });
  ok(reflector.counterfactualRecords().length === 0 && reflector.counterfactualOpeDataset() === undefined, '未挂载零漂移：台账为空 / OPE 数据集 undefined');

  reflector.attachCounterfactualLedger({ clock: () => clockNow });
  const signal = makeSignal(TASK, 'S4 反事实沉淀');
  reflector.reflectOnOutcome({ signal, plan: makePlan(TASK, 'S4 目标'), result: makeResult('model-a', true, 0.9) });

  const records = reflector.counterfactualRecords();
  ok(records.length === 1, `沉淀落一条台账（实测 ${records.length}）`);
  const r = records[0];
  ok(r.chosenModel === 'model-a' && r.outcome === 1, '实际臂 model-a + 成功结果（回报口径 1）');
  const chosenArm = r.arms.find((a) => a.chosen);
  const altArm = r.arms.find((a) => a.modelId === 'model-b');
  ok(chosenArm !== undefined && chosenArm.samples >= 4 && chosenArm.estimatedProb > 0.8, `实际臂带后验估计（samples=${chosenArm?.samples}，p=${chosenArm?.estimatedProb?.toFixed(3)}）`);
  ok(altArm !== undefined && altArm.samples >= 3 && altArm.wilsonLower > 0, `备选臂 model-b 估计入账（samples=${altArm?.samples}，wilsonLower=${altArm?.wilsonLower?.toFixed(3)}）`);
  ok(near(r.chosenPropensity, 0.5, 1e-6), `缺省行为概率 = 1/K = 0.5（实测 ${r.chosenPropensity}）`);

  // 失败结果同样落账（outcome=0）
  reflector.reflectOnOutcome({ signal, plan: makePlan(TASK, 'S4 目标 2'), result: makeResult('model-a', false, 0.4) });
  ok(reflector.counterfactualRecords()[0].outcome === 0, '失败沉淀同样入账（outcome=0）');

  // OPE 数据集（88.0 消费口径）
  const dataset = reflector.counterfactualOpeDataset();
  ok(dataset !== undefined && dataset.episodes.length === 2, `台账转 OPE Episode×2（实测 ${dataset?.episodes.length}）`);
  const idxA = dataset.armIndexByModel['model-a'];
  const idxB = dataset.armIndexByModel['model-b'];
  ok(idxA !== idxB && idxA >= 0 && idxB >= 0, '全局臂索引：model-a / model-b 编号互异且稳定');
  ok(dataset.episodes.every((e) => e.states.length === e.actions.length + 1 && e.rewards.every((v) => v === 0 || v === 1)), 'Episode 形态合法（单步轨迹 + 0/1 回报）');
  ok(dataset.behavior.numActions >= 2 && near(dataset.behavior.prob(0, idxA), 1, 1e-6), `行为策略 μ = 经验选择频率（全选 model-a → μ(a)=1，实测 ${dataset.behavior.prob(0, idxA)}）`);
  memory.dispose();
}

// ══════════════════════════ S5 洞察去重与衰减（reflector） ══════════════════════════
section('S5 洞察去重与半衰期衰减：同类合并计数 + 旧洞察遗忘候选');

{
  const memPath = path.join(os.tmpdir(), `dsh-verify-mod-reflect-s5-${Date.now()}.json`);
  fs.rmSync(memPath, { force: true });
  const memory = new LongTermMemory(memPath);
  const TASK = 'summarize';
  let clockNow = T0;
  const engine = new ReflectionEngine({ qualityThreshold: 0.7 });
  const reflector = new Reflector({ memory, reflection: engine, config: { enableProgress: false, autoDistillThreshold: 0 } });
  ok(reflector.insightLedgerView() === undefined, '未挂载零漂移：洞察账本视图 undefined');

  reflector.attachInsightLedger({ halfLifeDays: 30, forgetThreshold: 0.1, clock: () => clockNow });
  const signal = makeSignal(TASK, 'S5 洞察流');
  const insights = (success) => [
    { nodeId: 'node-1', taskType: TASK, modelId: 'model-x', predictedConfidence: 0.8, exploration: false, success },
    { nodeId: 'node-1', taskType: TASK, modelId: 'model-x', predictedConfidence: 0.8, exploration: false, success },
    { nodeId: 'node-2', taskType: TASK, modelId: 'model-y', predictedConfidence: 0.6, exploration: true, success },
  ];

  // 6 次沉淀 × 每次 3 条洞察，但只有 2 个去重键 → 合并计数
  for (let i = 0; i < 6; i += 1) {
    reflector.reflectOnOutcome({
      signal,
      plan: makePlan(TASK, `S5 目标 ${i}`),
      result: makeResult('model-x', true, 0.9),
      decisionInsights: insights(i % 2 === 0),
    });
  }
  let view = reflector.insightLedgerView();
  ok(view.entries.length + view.forgetCandidates.length === 2, `重复洞察流去重：18 条记录 → 2 个合并条目（实测 ${view.entries.length + view.forgetCandidates.length}）`);
  const entryX = [...view.entries, ...view.forgetCandidates].find((e) => e.subject === 'model-x');
  ok(entryX.hits === 12, `同类合并计数累加：model-x hits=12（实测 ${entryX.hits}）`);
  ok(near(entryX.rawScore, 0.5, 1e-6) && near(entryX.freshness, 1, 1e-6), `新鲜时有效分 = rawScore=${entryX.rawScore} × freshness=${entryX.freshness}`);

  // 推进 90 天（3 个半衰期）→ freshness = 0.125 → 有效分 0.0625 < 0.1 → 遗忘候选
  clockNow = T0 + 90 * DAY;
  view = reflector.insightLedgerView();
  const staleX = [...view.entries, ...view.forgetCandidates].find((e) => e.subject === 'model-x');
  ok(near(staleX.freshness, 0.125, 1e-6), `90 天半衰期衰减：freshness 0.125（实测 ${staleX.freshness}）`);
  ok(view.forgetCandidates.some((e) => e.subject === 'model-x') && staleX.effectiveScore < 0.1, `旧洞察有效分 ${staleX.effectiveScore} 跌破阈值 → 遗忘候选（底账保留，只是不再推荐）`);
  memory.dispose();
}

// ══════════════════════════ S6 沉淀价值评分（reflector，加分项） ══════════════════════════
section('S6 沉淀价值评分：历史命中频率先验 → 遗忘候选标注');

{
  const memPath = path.join(os.tmpdir(), `dsh-verify-mod-reflect-s6-${Date.now()}.json`);
  fs.rmSync(memPath, { force: true });
  const memory = new LongTermMemory(memPath);
  const TASK = 'audit';
  const TASK_IDLE = 'report';
  // 两条语义记忆：hot（会被命中）与 idle（从未命中、闲置 90 天；
  // 注意条件域须不同——同条件异结论会触发记忆库冲突消解被丢弃）
  const now = Date.now();
  const mkSem = (id, taskType, distilledAt) => ({
    id,
    domain: 'model-affinity',
    statement: `${id} 规律`,
    taskTypes: [taskType],
    conditions: [{ dimension: 'task-type', operator: 'eq', value: taskType }],
    conclusion: { type: 'model-preference', value: `model-${id.slice(-4)}`, rationale: 'verify' },
    confidence: 0.9,
    supportCount: 5,
    sourceFingerprints: [],
    distilledAt,
    appliedTotal: 0,
    appliedSuccesses: 0,
  });
  memory.upsertSemanticMemory(mkSem('sem-hot', TASK, now));
  memory.upsertSemanticMemory(mkSem('sem-idle', TASK_IDLE, now - 90 * DAY));

  let clockNow = now;
  const engine = new ReflectionEngine({ qualityThreshold: 0.7 });
  const reflector = new Reflector({ memory, reflection: engine, config: { enableProgress: false, autoDistillThreshold: 0 } });
  ok(reflector.sedimentationValueView() === undefined, '未挂载零漂移：沉淀价值视图 undefined');

  reflector.attachSedimentationScoring({ halfLifeDays: 30, forgetThreshold: 0.15, hitSaturation: 10, clock: () => clockNow });
  const signal = makeSignal(TASK, 'S6 命中流');
  for (let i = 0; i < 3; i += 1) {
    reflector.reflectOnOutcome({
      signal,
      plan: makePlan(TASK, `S6 目标 ${i}`),
      result: makeResult('model-x', true, 0.9),
      appliedMemoryIds: { semantic: ['sem-hot'] },
    });
  }
  const values = reflector.sedimentationValueView();
  ok(Array.isArray(values) && values.some((v) => v.id === 'sem-hot') && values.some((v) => v.id === 'sem-idle'), `两条沉淀条目均入评分（含蒸馏策略共 ${values?.length} 条）`);
  const hot = values.find((v) => v.id === 'sem-hot');
  const idle = values.find((v) => v.id === 'sem-idle');
  // 命中 3 次复盘 → 记忆库应用反馈（appliedTotal）与本地命中先验各计 3 → 总命中 6
  ok(hot.hits === 6 && hot.successRate === 1, `命中频率先验累计：sem-hot 总命中 6（应用反馈 3 + 本地先验 3）全成功（实测 ${hot.hits}/${hot.successRate}）`);
  ok(hot.recommendation === 'retain' && hot.value > 0.15, `高频命中条目 retain（value=${hot.value.toFixed(3)} > 0.15）`);
  ok(idle.hits === 0 && idle.daysIdle >= 90 && idle.value === 0, `闲置条目 value=0（hits=${idle.hits}，daysIdle=${idle.daysIdle.toFixed(0)}）`);
  ok(idle.recommendation === 'forget-candidate', '从未命中且长期闲置 → forget-candidate（对接 60.0 遗忘语义的先验输入）');
  ok(values[0].value >= values[1].value, '视图按价值降序（先看最有价值的沉淀）');
  memory.dispose();
}

// ══════════════════════════ S7 挂载面兼容（补完不推倒） ══════════════════════════
section('S7 前任挂载面兼容 + 六项新升级的缺省零漂移');

{
  const memPath = path.join(os.tmpdir(), `dsh-verify-mod-reflect-s7-${Date.now()}.json`);
  fs.rmSync(memPath, { force: true });
  const memory = new LongTermMemory(memPath);
  const graph = new MemoryGraph(path.join(os.tmpdir(), `dsh-verify-mod-reflect-s7-graph-${Date.now()}.json`));

  // optimizer 挂载面：A*（71.0）+ 稀疏归因（72.0）
  const opt = new Optimizer({ memory, graph });
  ok(opt.optimalSubplan(['a', 'b', 'c'], [{ from: 'a', to: 'b', cost: 1 }, { from: 'b', to: 'c', cost: 2 }], 'a', 'c') === undefined, '未挂载：optimalSubplan undefined');
  opt.attachAstarPlanner();
  const sub = opt.optimalSubplan(['a', 'b', 'c'], [{ from: 'a', to: 'b', cost: 1 }, { from: 'b', to: 'c', cost: 2 }], 'a', 'c');
  ok(sub !== undefined && sub.path.join('→') === 'a→b→c' && sub.cost === 3, '挂载后：A* 最优子计划照常（71.0 兼容）');
  ok(opt.attributeFactors([[1, 0], [1, 0], [1, 0], [0, 1]], [1, 1, 1, 0]) === undefined, '未挂载：attributeFactors undefined');
  opt.attachSparseAttribution();
  const attr = opt.attributeFactors(
    [
      [1, 0], [1, 0], [1, 0], [0, 1],
    ].map((row) => row.map((v) => v - 0.5)),
    [0.5, 0.5, 0.5, -0.5],
    { folds: 2 },
  );
  ok(attr !== undefined && Array.isArray(attr.activeSet) && typeof attr.kktViolation === 'number', '挂载后：稀疏归因照常（72.0 兼容，KKT 证书随结果落账）');

  // reflector 挂载面：PID（70.0）+ 众包（82.0）+ 偏好（90.0）
  const engine = new ReflectionEngine({ qualityThreshold: 0.7 });
  const reflector = new Reflector({ memory, reflection: engine, config: { enableProgress: false, autoDistillThreshold: 0 } });
  ok(reflector.combinationPid([[[0.5, 0], [0, 0]], [[0, 0], [0, 0.5]]]) === undefined, '未挂载：combinationPid undefined');
  reflector.attachPidDiagnostics();
  const pid = reflector.combinationPid([[[0.5, 0], [0, 0]], [[0, 0], [0, 0.5]]]);
  ok(pid !== undefined && typeof pid.pid.synergistic === 'number', '挂载后：PID 分解照常（70.0 兼容）');
  ok(reflector.crowdVerdictOf({ workers: ['w1', 'w2'], classes: 2, labels: [[0, 1], [1, 1]] }) === undefined, '未挂载：crowdVerdictOf undefined');
  reflector.attachCrowdAggregation();
  const verdict = reflector.crowdVerdictOf({ workers: ['w1', 'w2'], classes: 2, labels: [[0, 1], [1, 1]] });
  ok(verdict !== undefined && verdict.weightedLabels.length === 2, '挂载后：众包聚合照常（82.0 兼容）');
  ok(reflector.preferenceView() === undefined, '未挂载：preferenceView undefined');
  reflector.attachPreferenceLearning(); // minPairs 缺省 8（内核下限钳 4）
  const prefPairs = [
    ['model-x', 'model-y'], ['model-x', 'model-z'], ['model-y', 'model-z'], ['model-x', 'model-w'],
    ['model-w', 'model-z'], ['model-x', 'model-v'], ['model-v', 'model-y'], ['model-w', 'model-y'],
  ];
  for (const [w, l] of prefPairs) reflector.notePreferencePair(w, l);
  const pref = reflector.preferenceView();
  ok(pref !== undefined && pref.pairs === 8, '挂载后：偏好账本照常（90.0 兼容，8 对足量出视图）');

  // reflection-engine 挂载面：论证（81.0）
  ok(engine.argumentationVerdict(['a', 'b'], [[0, 1]]) === undefined, '未挂载：argumentationVerdict undefined');
  engine.attachArgumentation();
  const adj = engine.argumentationVerdict(['a', 'b'], [[0, 1]]);
  ok(adj !== undefined && Array.isArray(adj.groundedIds), '挂载后：论证裁决照常（81.0 兼容）');

  // 六项新升级的缺省零漂移总检
  const engineFresh = new ReflectionEngine({ qualityThreshold: 0.7 });
  const reflectorFresh = new Reflector({ memory, reflection: engineFresh, config: { autoDistillThreshold: 0 } });
  const optFresh = new Optimizer({ memory });
  ok(
    optFresh.recallRouteStats().total === 0 &&
      optFresh.lookupExperience('none-task', 0.5).recommendation === undefined &&
      engineFresh.retryBanditDecide() === undefined &&
      reflectorFresh.counterfactualRecords().length === 0 &&
      reflectorFresh.insightLedgerView() === undefined &&
      reflectorFresh.sedimentationValueView() === undefined,
    '六项新升级未挂载时全部零介入（路由零落账 / 推荐无分解 / bandit 无决策 / 台账空 / 账本空 / 价值视图空）',
  );
  memory.dispose();
  graph.dispose?.();
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(72)}`);
if (failed === 0) {
  console.log(`PASS ${passed}/${passed + failed} — 反思轴模块域 A6（重派）全部验证通过`);
  process.exit(0);
} else {
  console.log(`PASS ${passed}/${passed + failed}，FAIL ${failed}`);
  process.exit(1);
}
