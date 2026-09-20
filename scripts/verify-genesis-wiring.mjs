/**
 * verify-genesis-wiring.mjs — 21.0→25.0 全链路接线冒烟验证
 *
 * 用真实引擎（LLMClient / ModelScheduler / 内核本体，memory 用最小 stub）
 * 走完「挂载 → 运行 → 输出」全链路，证明五个内核的接线是真实生效的
 * 运行路径（不只是类型正确）：
 *   零漂移：不配置 robustLatency / 不挂载任何内核 → getModelStatuses 无新
 *        键、调度决策走原评分路径（rationale 无 'Gittins'）
 *   21.0：attachIndexScheduler 后零样本臂因学习溢价胜出（对照：未挂载的
 *        调度器选中后验画像更优者）——Gittins 与原路径在同一记忆画像下
 *        做出可区分的决策
 *   22.0：attachBwKRouter + 极低预算率 → cheapest-shed 卸载语义生效，
 *        rationale 携带预算信息
 *   23.0：LLMClient robustLatency + fetchImpl stub（全程离线，零真实网络
 *        请求）→ 30 次成功调用后状态输出 robustAvgLatencyMs / catoni
 *   24.0：PrivacyAccountant.status() 的 exhausted 转变（超预算拒绝发布）
 *   25.0：CapacityPlanner.plan 的 headroom 反解（与内核脚本同口径交叉确认）
 *
 * 运行：npm run build && node scripts/verify-genesis-wiring.mjs
 */

import {
  LLMClient,
  ModelScheduler,
  IndexScheduler,
  BwKRouter,
  PrivacyAccountant,
  CapacityPlanner,
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

/** 确定性 RNG（mulberry32） */
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

/** 两模型 LLMClient（endpoint 指向不存在的 mock 主机，测试不发真实请求） */
function makeLlm(overrides = {}) {
  const llm = new LLMClient(overrides);
  llm.registerModel({
    id: 'model-a',
    endpoint: 'http://mock.local',
    initialCapabilities: { taskScores: { test: 0.5 } },
  });
  llm.registerModel({
    id: 'model-b',
    endpoint: 'http://mock.local',
    maxConcurrency: 5,
    initialCapabilities: { taskScores: { test: 0.1 } },
  });
  return llm;
}

/**
 * 记忆 stub：仅实现 ModelScheduler 消费面（getBayesianEstimate）。
 * - model-a：19 个样本的中庸画像（Beta(11,10)，后验均值 0.524，Wilson 下界 0.31）
 * - model-b：无画像（undefined → 调度器按零样本处理）
 */
function stubMemory() {
  return {
    getBayesianEstimate(modelId) {
      if (modelId === 'model-a') {
        return {
          modelId,
          taskType: 'test',
          alpha: 11,
          beta: 10,
          posteriorMean: 11 / 21,
          wilsonLower: 0.31,
          effectiveSamples: 19,
          rawSuccessRate: 10 / 19,
          drift: 0,
          emaQuality: 0.6,
        };
      }
      return undefined;
    },
  };
}

// ═══════════════════ 零漂移 ═══════════════════

section('零漂移：未启用任何新内核时行为与升级前一致');

{
  const llm = makeLlm();
  const statuses = llm.getModelStatuses();
  ok(
    statuses.length === 2 && statuses.every((s) => !('robustAvgLatencyMs' in s) && !('robustLatencyMethod' in s)),
    `不传 robustLatency 时 getModelStatuses 无 robustAvgLatencyMs / robustLatencyMethod 键（${statuses.map((s) => Object.keys(s).length).join('/')} 个字段，输出形态不变）`,
  );

  const scheduler = new ModelScheduler({ llm, memory: stubMemory() });
  const insight = scheduler.assignModelWithInsight('test');
  ok(
    typeof insight.modelId === 'string' && insight.modelId.length > 0,
    `未挂载内核的 ModelScheduler 正常返回 chosen=${insight.modelId}（原评分路径可用）`,
  );
  ok(
    !insight.rationale.includes('Gittins') && !insight.rationale.includes('预算路由'),
    `rationale 走原语义（无 'Gittins' / '预算路由' 字样）：${insight.rationale.slice(0, 46)}…`,
  );
  const diag = scheduler.getAttachedDiagnostics();
  ok(
    !('indexScheduling' in diag) && !('lastBwK' in diag),
    `getAttachedDiagnostics 为空对象（未挂载内核时 introspect 不新增键）`,
  );
}

// ═══════════════════ 21.0 接线冒烟 ═══════════════════

section('21.0 接线：attachIndexScheduler → 学习溢价驱动选型');

{
  // 对照组：未挂载的调度器 → 原评分路径选中画像更优的 model-a
  // （taskScore 0.5 + Wilson 0.31 × 19 样本 vs 零样本 taskScore 0.1，
  //  UCB 冷启动加成不足以翻盘）
  const control = new ModelScheduler({ llm: makeLlm(), memory: stubMemory() });
  const controlInsight = control.assignModelWithInsight('test');
  ok(
    controlInsight.modelId === 'model-a',
    `对照组（未挂载）：选中后验画像更优的 ${controlInsight.modelId}（原路径语义）`,
  );

  // 实验组：挂载 IndexScheduler（默认 GittinsIndexTable, γ=0.95）后，
  // 零样本臂 model-b 的 Gittins 指数 ν(1,1) 携带学习溢价胜过中庸画像臂
  // 的 ν(11,10)（独立重算：0.7614 vs 0.5755）—— 为学而选。
  const attached = new ModelScheduler({ llm: makeLlm(), memory: stubMemory() });
  attached.attachIndexScheduler(new IndexScheduler());
  const insight = attached.assignModelWithInsight('test');
  ok(
    insight.modelId === 'model-b' && insight.rationale.includes('Gittins'),
    `挂载后：零样本 model-b 因学习溢价胜出（${insight.modelId}；rationale 含 'Gittins'：${insight.rationale.slice(0, 52)}…）`,
  );
  ok(
    insight.exploration === true,
    `探索标记 exploration=${insight.exploration}（学习溢价显著且选中者非后验均值最高——为学而选）`,
  );
  const diag = attached.getAttachedDiagnostics();
  ok(
    'indexScheduling' in diag && diag.indexScheduling.computedStates >= 2,
    `getAttachedDiagnostics().indexScheduling 出现（已计算 ${diag.indexScheduling?.computedStates} 个后验状态，指数表惰性缓存生效）`,
  );
}

// ═══════════════════ 22.0 接线冒烟 ═══════════════════

section('22.0 接线：attachBwKRouter → 预算约束参与在线选型');

{
  // 预算率极低（剩余 5 token / 100 轮）：两臂 tokensMean 600（无调用历史
  // 的兜底口径）都远超可行阈 0.0625 → cheapest-shed 卸载语义
  const scheduler = new ModelScheduler({
    llm: makeLlm(),
    memory: {
      getBayesianEstimate(modelId) {
        if (modelId === 'model-a') {
          return { modelId, taskType: 'test', alpha: 51, beta: 6, posteriorMean: 0.895, wilsonLower: 0.8, effectiveSamples: 55, rawSuccessRate: 0.9, drift: 0, emaQuality: 0.8 };
        }
        return { modelId, taskType: 'test', alpha: 6, beta: 6, posteriorMean: 0.5, wilsonLower: 0.25, effectiveSamples: 10, rawSuccessRate: 0.5, drift: 0, emaQuality: 0.5 };
      },
    },
  });
  scheduler.attachBwKRouter(new BwKRouter(), () => ({ tokensRemaining: 5, costRemaining: 0 }));
  const insight = scheduler.assignModelWithInsight('test');
  const verdict = scheduler.getAttachedDiagnostics().lastBwK;
  ok(
    typeof insight.modelId === 'string' && insight.modelId.length > 0 && insight.rationale.includes('预算'),
    `预算路由生效：chosen=${insight.modelId}，rationale 携带预算信息（${insight.rationale.slice(0, 56)}…）`,
  );
  ok(
    verdict && verdict.basis === 'cheapest-shed' && verdict.urgent === true,
    `裁决 basis=${verdict?.basis}，urgent=${verdict?.urgent}（预算率撑不起任何臂 → 选最廉臂止血，tokens 打平按乐观质量取高者）`,
  );
  ok(insight.exploration === false, `cheapest-shed 非探索（exploration=${insight.exploration}，被迫卸载语义正确）`);
}

// ═══════════════════ 23.0 接线冒烟 ═══════════════════

section('23.0 接线：LLMClient robustLatency + 离线 fetchImpl');

{
  // fetchImpl 注入点（LLMClientConfig.fetchImpl）：全程离线，零真实网络请求
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 12 }, model: 'stub' }),
  });
  const llm = makeLlm({ fetchImpl, robustLatency: { alpha: 0.05 } });
  for (let i = 0; i < 30; i += 1) {
    await llm.chat('model-a', [{ role: 'user', content: 'ping' }]);
    await llm.chat('model-b', [{ role: 'user', content: 'ping' }]);
  }
  const statuses = llm.getModelStatuses();
  ok(
    statuses.every((s) => s.totalCalls === 30 && typeof s.robustAvgLatencyMs === 'number' && ['mean', 'mom', 'catoni'].includes(s.robustLatencyMethod)),
    `30 次成功调用后两模型均输出 robustAvgLatencyMs / robustLatencyMethod（${statuses.map((s) => `${s.id}=${s.robustAvgLatencyMs}ms/${s.robustLatencyMethod}`).join('; ')}）`,
  );
  ok(
    statuses.every((s) => s.robustLatencyMethod === 'catoni'),
    `样本 ≥ 24 后方法切换为 catoni（Catoni 估计接管延迟统计）`,
  );
  llm.dispose();
  const afterDispose = llm.getModelStatuses();
  ok(
    afterDispose.length === 2 && afterDispose.every((s) => !('robustAvgLatencyMs' in s)),
    `dispose 后 robust 流已清空（字段不再出现，模型注册表与累计统计不受影响）`,
  );
}

// ═══════════════════ 24.0 接线冒烟 ═══════════════════

section('24.0 接线：PrivacyAccountant 预算纪律');

{
  // 常规预算：初始未耗尽；发布只花剩余一半（永不超支）
  const acc = new PrivacyAccountant({ epsilon: 0.5 }, mulberry32(5));
  const fresh = acc.status();
  let numeric = 0;
  for (let i = 0; i < 50; i += 1) {
    if (acc.laplace(100, 1, 'probe') === undefined) break;
    numeric += 1;
  }
  const burnt = acc.status();
  ok(
    fresh.exhausted === false && burnt.exhausted === false && burnt.epsilonSpent <= 0.5 + 1e-9 && numeric >= 5,
    `ε=0.5：fresh.exhausted=false → ${numeric} 次发布后 spent=${burnt.epsilonSpent} ≤ ε（折半分账永不超支）`,
  );
  // 转变：极小预算（remaining ≤ 1e-6）→ exhausted=true 且发布被拒绝
  // 注：折半分账的 alloc 下限(1e-4)高于 exhausted 判定阈(1e-6)，
  // 故 exhausted 翻转由预算本身 ≤ 阈值触发，而非发布耗尽触发。
  const tiny = new PrivacyAccountant({ epsilon: 1e-6 }, mulberry32(3));
  ok(
    tiny.status().exhausted === true && tiny.laplace(5, 1, 'x') === undefined,
    `ε=1e-6：status().exhausted === true 且 laplace → undefined（超预算拒绝发布，不静默失败）`,
  );
}

// ═══════════════════ 25.0 接线冒烟 ═══════════════════

section('25.0 接线：CapacityPlanner 反解（与内核脚本同口径交叉确认）');

{
  // 注：Wq(1)=ρ/(μ−λ) 在 IEEE 下是 4000.0000000000005ms，target=4000 因
  // 浮点尘埃判 c=1 不可行 → c=1/headroom=0.25 锚点用 target=5000。
  const plan = new CapacityPlanner({ targetWaitMs: 5000 }).plan({
    predictedArrivalPerSec: 0.8,
    serviceMeanMs: 1000,
    serviceScv: 1,
    currentConcurrency: 4,
  });
  ok(
    plan.feasible && plan.recommendedConcurrency === 1 && plan.headroom === 0.25,
    `λ=0.8/s、μ=1/s、SCV=1、当前并发 4：建议并发 ${plan.recommendedConcurrency}，headroom=${plan.headroom}（≤1.2 不触发扩容洞察）`,
  );
  const hot = new CapacityPlanner({ targetWaitMs: 4000 }).plan({
    predictedArrivalPerSec: 3.9,
    serviceMeanMs: 1000,
    serviceScv: 1,
    currentConcurrency: 4,
  });
  ok(
    hot.recommendedConcurrency === 5 && hot.headroom > 1.2,
    `λ=3.9/s 同池：建议并发 ${hot.recommendedConcurrency}（c=4 时 ρ=0.975 → Wq≈${Math.round(hot.expectedWaitMs)}ms>4000），headroom=${hot.headroom} > 1.2 → 心跳 2.5 段将产出 capacity-warning 洞察`,
  );
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 21.0→25.0 接线冒烟验证成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
process.exitCode = failed === 0 ? 0 : 1;
