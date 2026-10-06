/**
 * verify-r4-reflect.mjs — 第四轮模块域升级 R4-A6（反思轴：optimizer / reflector /
 * reflection-engine）「激活与深化」新旧行为对照验证
 *
 * 五项全新维度各配「旧世界 vs 新世界」的构造对照（不是「改了」，是「证明更好」）：
 *
 *   S1 经验迁移推荐（optimizer）：B 类任务（code-refactor）无直接命中（记忆库
 *      模糊匹配 0.375 < 0.4 门槛 → memoryLayer='none'）——旧世界空手走冷启动
 *      （recommendedModels 空 / 无任何建议）；新世界跨类型借到结构相似的 A 类
 *      （code-review）亲测经验：相似度 0.65（特征 Jaccard 0.5×0.7 + 复杂度贴近
 *      1×0.3）× 来源质量 0.7（4 战全胜 × 置信 0.7）→ 可迁移置信 0.455 ≥ 0.35
 *      命中，并附借用模型组合；异类 C（poetry-recital，特征不相交）相似度
 *      0.18 < 0.4 → rejected(below-similarity) 落账。向量口径（featureVectorOf
 *      注入）：A·B 余弦 0.998 候选 vs B·C 余弦 0.225 拒——同引擎两口径一致。
 *      有直接命中（episodic）时不出迁移（迁移只补冷启动，不越权）。
 *   S2 经验置信度传播（optimizer）：借还流——同一来源经验连续 5 次借出成功
 *      → 有效置信 0.7 → 0.893 单调上调（封顶 0.98 未触）；转 10 次借出失败
 *      → 单调下调直落托底 0.3、权重 1 → 0.349（≥ minWeight 0.2）——传播
 *      收敛方向正确且有界。再检索时该来源 sourceStrength=0.3 < 0.5 →
 *      rejected(weak-source)：失败经验自动让位。借用对 A→B 3 借 3 成 →
 *      learned=true、Wilson 下界 0.439 > 0。
 *   S3 反思深度分级（reflection-engine）：混合代价流——小代价失败（20/30）
 *      走轻反思（z 检验快检，1 代价单位，无归因）；大代价失败（500）走重
 *      反思（全链归因：失败节点 0.924 + 劣化上游 0.049/0.026，责任合计 1）；
 *      小代价但 z=-12 ≤ -2 统计异常 → 同事件升级触发重反思（轻→重升级链，
 *      escalated=true 带归因）。代价对照：全重基线 24 单位 vs 分级实际 18 单位
 *      （省 25%）。旧世界（未分级）每次失败都全链归因或都草率统计——二选一。
 *   S4 失败知识库（reflector）：同模式二次失败——第一次超时沉淀失败模式
 *      （规避动作 = 放大超时参数）；第二次同模式失败合并计数 occurrences=2、
 *      规避动作升级为 avoid-model(model-slow)；检索命中规避建议（matchScore
 *      1.0 = 任务类型 + 节点类型 + 错误线索三匹配）随计划下发；采纳建议后
 *      模拟换模型重跑成功（noteAvoidanceAdopted ×2 全胜 → effectiveness=1）。
 *      旧世界（未挂载）同模式第二次失败时检索面 undefined——只能再踩一遍坑。
 *   S5 计划模板抽象（optimizer，加分）：成功计划（质量 0.92 ≥ 0.8）泛化为
 *      参数化模板（5000/2 → {slot-0}/{slot-1}，node id → 模板内下标）；质量
 *      0.5 的平庸计划不提取；同构计划二次提取合并计数（extractions=2、质量
 *      滚动均值 0.91）；相似任务「翻译 8000 字…校对 3 轮」匹配分 1.0（数字
 *      掩码后同构）→ 实例化回填 8000/3 产出 source='memory' 计划；无关目标
 *      （部署微服务）不匹配。旧世界 recallPlan 对该任务 undefined（冷启动）。
 *   S6 零漂移 + 兼容总检：五面未挂载时全部读数 undefined / 空账；挂载后既有
 *      R3 面（置信路由 / 重试 bandit / 反事实台账）逐位照常（同输入同输出）。
 *
 * 确定性：全脚本注入固定时钟（T0 = 1.75e12），无 Math.random / 真实时间依赖；
 * 相似度 / z 分 / 传播轨迹 / Wilson 下界均在脚本侧独立手算对照。
 *
 * 运行：npm run build && node scripts/verify-r4-reflect.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LongTermMemory, Optimizer, Reflector, ReflectionEngine } from '../dist/index.mjs';

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
function near(a, b, tol = 1e-5) {
  return Math.abs(a - b) <= tol;
}
function section(title) {
  console.log(`\n■ ${title}`);
}

const DAY = 86_400_000;
/** 注入时钟基准（全部时间敏感断言以此为准，与真实墙钟解耦） */
const T0 = 1_750_000_000_000;

/** 测试数据工厂（verify-mod-reflect.mjs 同款口径） */
let signalSeq = 0;
function makeSignal(type, description) {
  return {
    id: `sig-${++signalSeq}`,
    type,
    description,
    payload: {},
    receivedAt: T0,
    source: 'verify-r4-reflect',
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
function makeResult(modelId, success, quality, error) {
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
        error: success ? undefined : error,
        tokensUsed: 100,
      },
    ],
    totalTime: 1000,
    successCount: success ? 1 : 0,
    totalTokens: 100,
    avgQuality: quality,
  };
}

/** 向记忆库播种一类任务的成功经验（精确控制模式形态与置信度） */
function seedSuccess(memory, taskType, nodeType, modelId, seq, { complexity = 0.6, features = [], quality = 0.9 } = {}) {
  memory.recordSuccess({
    taskType,
    complexity,
    features,
    taskSummary: `${taskType}: 样本 ${seq}`,
    plan: {
      objective: `${taskType} 目标 ${seq}`,
      nodes: [{ id: `node-${seq}`, description: `${taskType} 步骤 ${seq}`, type: nodeType, dependsOn: [] }],
      parallelismStrategy: 'layered',
    },
    modelAssignments: { [`node-${seq}`]: modelId },
    totalLatency: 1000,
    qualityScores: { [`node-${seq}`]: quality },
    tokenCost: 100,
  });
}

function tmpMemory(tag) {
  const memPath = path.join(os.tmpdir(), `verify-r4-reflect-${tag}-${Date.now()}.json`);
  fs.rmSync(memPath, { force: true });
  return new LongTermMemory(memPath);
}

// ═══════════════════ S1 经验迁移推荐（optimizer） ═══════════════════
section('S1 经验迁移推荐：无直接命中 → 跨类型借用结构相似异类经验');

{
  const memory = tmpMemory('s1');
  // A 类：code-review（features [code,review]），4 战全胜 → 置信 0.5+0.05×4 = 0.7
  for (let i = 1; i <= 4; i += 1) seedSuccess(memory, 'code-review', 'code', 'model-strong', i, { features: ['code', 'review'], complexity: 0.6 });
  // C 类：poetry-recital（features [poetry]，复杂度 0.2）——结构不相交的异类
  for (let i = 1; i <= 2; i += 1) seedSuccess(memory, 'poetry-recital', 'poetry', 'model-poet', 10 + i, { features: ['poetry'], complexity: 0.2 });
  const patternA = memory.getAllTaskPatterns().find((p) => p.fingerprint.startsWith('code-review'));
  ok(patternA !== undefined && near(patternA.confidence, 0.7, 1e-6) && patternA.successfulPlans.length === 4, `A 类经验就位（4 胜 / 置信 ${patternA?.confidence}）`);

  const B_TYPE = 'code-refactor';
  const B_FEATURES = ['code'];

  // 旧世界对照：未挂载的优化器——B 类检索空手走冷启动
  const optLegacy = new Optimizer({ memory });
  const lookupLegacy = optLegacy.lookupExperience(B_TYPE, 0.6, B_FEATURES);
  ok(lookupLegacy.memoryLayer === 'none', `旧世界：记忆库模糊匹配 0.375 < 0.4 门槛 → memoryLayer=none（实测 ${lookupLegacy.memoryLayer}）`);
  ok(lookupLegacy.transfer === undefined && Object.keys(lookupLegacy.recommendedModels).length === 0, '旧世界：无迁移推荐、无推荐模型——冷启动空手');

  // 新世界：挂载迁移推荐
  const opt = new Optimizer({ memory });
  opt.attachTransferRecommendation();
  ok(opt.recommendTransfer(B_TYPE, 0.6, B_FEATURES) !== undefined, '挂载后 recommendTransfer 可用');
  const lookup = opt.lookupExperience(B_TYPE, 0.6, B_FEATURES);
  ok(lookup.transfer !== undefined && lookup.memoryLayer === 'none', '无直接命中时 lookupExperience 附带迁移推荐（transfer 字段）');

  const transfer = lookup.transfer;
  ok(transfer.best !== undefined && transfer.best.sourceTaskType === 'code-review', `最佳候选 = A 类 code-review（实测 ${transfer.best?.sourceTaskType}）`);
  ok(near(transfer.best.similarity, 0.7 * 0.5 + 0.3 * 1), `结构相似度 = 特征 Jaccard 0.5×0.7 + 复杂度贴近 1×0.3 = 0.65（实测 ${transfer.best.similarity}）`);
  ok(near(transfer.best.sourceStrength, 1 * 0.7), `来源质量 = 成功率 1 × 置信 0.7 = 0.7（实测 ${transfer.best.sourceStrength}）`);
  ok(near(transfer.best.transferConfidence, 0.65 * 0.7), `可迁移置信 = 0.65 × 0.7 = 0.455 ≥ 0.35 门槛（实测 ${transfer.best.transferConfidence}）`);
  ok(transfer.best.borrowedModels['code'] === 'model-strong', `借用模型组合按节点类型下发（code → ${transfer.best.borrowedModels['code']}）`);
  ok(transfer.best.rationale.includes('可迁移置信'), '候选附人类可读理由（置信标注可审计）');

  // 不可迁移对被拒：C 类与 B 特征不相交 → 相似度 0.7×0 + 0.3×0.6 = 0.18 < 0.4
  const rejectedC = transfer.rejected.find((r) => r.sourceTaskType === 'poetry-recital');
  ok(rejectedC !== undefined, `异类 C 进入被拒落账（候选 ${transfer.candidates.length} / 被拒 ${transfer.rejected.length}）`);
  ok(near(rejectedC.similarity, 0.18) && rejectedC.reason === 'below-similarity', `C 类拒因 = below-similarity（相似度 ${rejectedC?.similarity} < 0.4——不可迁移就是不可迁移）`);

  // 有直接命中时不越权：A 类自身检索（episodic 命中）不出迁移
  const lookupA = opt.lookupExperience('code-review', 0.6, ['code', 'review']);
  ok(lookupA.memoryLayer !== 'none' && lookupA.transfer === undefined, '直接命中（episodic）时迁移面缺席——只补冷启动不越权');

  // 向量口径：featureVectorOf 注入 → 余弦相似度
  const optVec = new Optimizer({ memory });
  const VEC = {
    'code-review': [0.9, 0.1],
    'code-refactor': [0.85, 0.15],
    'poetry-recital': [0.05, 0.95],
  };
  optVec.attachTransferRecommendation({ featureVectorOf: (t) => VEC[t] });
  const vecTransfer = optVec.recommendTransfer(B_TYPE, 0.6, B_FEATURES);
  const vecBest = vecTransfer.candidates.find((c) => c.sourceTaskType === 'code-review');
  const vecRejected = vecTransfer.rejected.find((r) => r.sourceTaskType === 'poetry-recital');
  ok(vecBest !== undefined && near(vecBest.similarity, 0.997951, 1e-4), `向量口径：A·B 余弦相似 ≈ 0.998（实测 ${vecBest?.similarity}）`);
  ok(vecRejected !== undefined && near(vecRejected.similarity, 0.225307, 1e-4) && vecRejected.reason === 'below-similarity', `向量口径：B·C 余弦 0.225 < 0.4 同样被拒（实测 ${vecRejected?.similarity}）`);
  memory.dispose();
}

// ═══════════════════ S2 经验置信度传播（optimizer） ═══════════════════
section('S2 经验置信传播：借还流——成功上调 / 失败下调并降权，收敛方向正确');

{
  const memory = tmpMemory('s2');
  for (let i = 1; i <= 4; i += 1) seedSuccess(memory, 'code-review', 'code', 'model-strong', i, { features: ['code', 'review'] });
  const patternA = memory.getAllTaskPatterns().find((p) => p.fingerprint.startsWith('code-review'));

  let clockNow = T0;
  const opt = new Optimizer({ memory });
  ok(opt.propagationView() === undefined, '未挂载零漂移：传播账本视图 undefined');

  // 迁移推荐 + 置信传播双挂载（传播的消费面在迁移推荐——借出结果回灌排序）
  opt.attachTransferRecommendation();
  opt.attachExperiencePropagation({ clock: () => clockNow });
  // 借出前：迁移推荐照常（传播权重缺省 1）
  const before = opt.recommendTransfer('code-refactor', 0.6, ['code']);
  ok(near(before.best.transferConfidence, 0.455), `借出前可迁移置信 0.455（实测 ${before.best.transferConfidence}）`);

  // ── 借还流：5 次借出成功 → 有效置信单调上调 ──
  const rise = [];
  for (let i = 0; i < 5; i += 1) {
    clockNow += 1000;
    const entry = opt.settleBorrowedExperience({
      sourceFingerprint: patternA.fingerprint,
      fromTaskType: 'code-review',
      toTaskType: 'code-refactor',
      success: true,
    });
    rise.push(entry.effectiveConfidence);
  }
  ok(rise.every((v, i) => i === 0 || v > rise[i - 1]), `借出成功 → 置信单调上调：${rise.map((v) => v.toFixed(4)).join(' → ')}`);
  ok(near(rise[4], 0.7 * Math.pow(1.05, 5), 1e-4) && rise[4] <= 0.98, `第 5 次后 ≈ 0.893（封顶 0.98 未触，实测 ${rise[4]}）`);

  // ── 转向：10 次借出失败 → 单调下调托底 + 降权 ──
  const fall = [];
  const weights = [];
  for (let i = 0; i < 10; i += 1) {
    clockNow += 1000;
    const entry = opt.settleBorrowedExperience({
      sourceFingerprint: patternA.fingerprint,
      fromTaskType: 'code-review',
      toTaskType: 'code-refactor',
      success: false,
    });
    fall.push(entry.effectiveConfidence);
    weights.push(entry.weight);
  }
  ok(fall.every((v, i) => i === 0 || v <= fall[i - 1]), `借出失败 → 置信单调下调：${fall[0].toFixed(4)} → ${fall[9].toFixed(4)}（托底 0.3）`);
  ok(Math.min(...fall) >= 0.3 && near(fall[9], 0.3), `下调有界收敛到托底 floor=0.3（实测末值 ${fall[9]}）`);
  ok(weights.every((v, i) => i === 0 || v <= weights[i - 1]) && weights[9] >= 0.2, `失败同步降权：1 → ${weights[9].toFixed(4)}（≥ minWeight 0.2）`);

  // ── 传播回灌推荐：失败经验自动让位 ──
  const after = opt.recommendTransfer('code-refactor', 0.6, ['code']);
  const demoted = after.rejected.find((r) => r.sourceTaskType === 'code-review');
  ok(demoted !== undefined && demoted.reason === 'weak-source', `借出失败后该来源 sourceStrength = 1×0.3 = 0.3 < 0.5 → rejected(weak-source)（实测 reason=${demoted?.reason}）`);

  // ── 借用对统计：Wilson 下界学习分 ──
  const view = opt.propagationView();
  const pair = view.pairs.find((p) => p.from === 'code-review' && p.to === 'code-refactor');
  ok(pair !== undefined && pair.trials === 15 && pair.successes === 5, `借用对 A→B 全量入账（15 借 5 成，实测 ${pair?.trials}/${pair?.successes}）`);
  ok(pair.learned === true && pair.wilsonLower > 0, `借用对已学习：Wilson 下界 ${pair?.wilsonLower?.toFixed(4)}（trials ≥ 3 才采信）`);
  const entryView = view.entries.find((e) => e.fingerprint === patternA.fingerprint);
  ok(entryView !== undefined && near(entryView.baseConfidence, 0.7) && near(entryView.effectiveConfidence, 0.3) && near(entryView.borrowFailures, 10), '传播账本视图：基准 0.7 / 有效 0.3 / 成 5 败 10 全链可审计');

  // 独立来源互不干扰：另一条从未借出的经验不受传播影响
  for (let i = 1; i <= 2; i += 1) seedSuccess(memory, 'data-pipeline', 'etl', 'model-etl', 20 + i, { features: ['code'], complexity: 0.6 });
  const after2 = opt.recommendTransfer('code-refactor', 0.6, ['code']);
  const freshCandidate = after2.candidates.find((c) => c.sourceTaskType === 'data-pipeline');
  ok(freshCandidate !== undefined, `从未借出的来源不受传播牵连（data-pipeline 仍可候选，实测 ${freshCandidate !== undefined}）`);
  memory.dispose();
}

// ═══════════════════ S3 反思深度分级（reflection-engine） ═══════════════════
section('S3 反思深度分级：混合代价流——轻 / 重路由正确 + 轻→重升级链');

{
  const engine = new ReflectionEngine({ qualityThreshold: 0.7 });
  ok(engine.gradedReflect({ taskType: 'mixed-task', quality: 0.2, failureCost: 500 }) === undefined, '未挂载零漂移：gradedReflect undefined');
  ok(engine.depthStats() === undefined, '未挂载零漂移：depthStats undefined');

  engine.attachDepthGrading({ costThreshold: 100, escalationZ: -2, windowSize: 10 });
  // 近窗基线：8 次成功质量 0.8（均值 0.8 / 标准差 0 → 尺度下限 0.05）
  for (let i = 0; i < 8; i += 1) engine.recordExecution('mixed-task', 0.8, true);

  // ① 小代价失败（20）→ 轻反思：z = (0.78-0.8)/0.05 = -0.4 常态内，不升级
  const light = engine.gradedReflect({ taskType: 'mixed-task', quality: 0.78, failureCost: 20 });
  ok(light.depth === 'light' && light.escalated === false, `小代价失败 → 轻反思路由（实测 depth=${light.depth}）`);
  ok(light.attribution === undefined && light.costUnits === 1, '轻反思不逐节点归因（代价 1 单位）');
  ok(near(light.quickCheck.zScore, -0.4) && light.quickCheck.anomaly === false, `快检 z=-0.4 常态内不判异常（实测 ${light.quickCheck.zScore}）`);
  ok(light.quickCheck.windowSamples === 8, `快检基于近窗基线（${light.quickCheck.windowSamples} 样本）`);

  // ② 大代价失败（500）→ 重反思：全链归因（失败节点 + 劣化上游责任分摊）
  const nodes = [
    { id: 'up', type: 'collect', quality: 0.55, success: true, dependsOn: [] },
    { id: 'mid', type: 'summarize', quality: 0.62, success: true, dependsOn: ['up'] },
    { id: 'down', type: 'report', quality: 0.3, success: false, dependsOn: ['mid'] },
  ];
  const heavy = engine.gradedReflect({ taskType: 'mixed-task', quality: 0.3, failureCost: 500, nodes });
  ok(heavy.depth === 'heavy' && heavy.attribution !== undefined, `大代价失败 → 重反思路由（代价 ${heavy.costUnits} 单位）`);
  const chainSum = heavy.attribution.chain.reduce((s, c) => s + c.contribution, 0);
  ok(near(chainSum, 1), `责任分摊合计 1（实测 ${chainSum.toFixed(6)}）`);
  const downNode = heavy.attribution.chain.find((c) => c.nodeId === 'down');
  ok(downNode !== undefined && near(downNode.contribution, 1.4 / 1.515, 1e-4), `失败节点主责 0.924 =（亏空 0.4 + 基础 1）/ 总权 1.515（实测 ${downNode?.contribution}）`);
  const upNode = heavy.attribution.chain.find((c) => c.nodeId === 'up');
  ok(upNode !== undefined && upNode.contribution > 0 && upNode.note.includes('传导'), `劣化上游折半分责（up 亏空 0.15×0.5 → ${upNode?.contribution}，标注传导共犯）`);

  // ③ 小代价但统计异常（z = (0.2-0.8)/0.05 = -12 ≤ -2）→ 轻→重升级链
  const escalated = engine.gradedReflect({ taskType: 'mixed-task', quality: 0.2, failureCost: 30 });
  ok(escalated.depth === 'light' && escalated.escalated === true, `小代价异常失败 → 轻→重升级（z=${escalated.quickCheck.zScore}）`);
  ok(escalated.attribution !== undefined && escalated.costUnits === 9, '升级链：同一事件补做全链归因（代价 1+8=9 单位——宁多花不放过）');
  ok(escalated.quickCheck.verdict.includes('升级'), `升级理由落账：${escalated.quickCheck.verdict.slice(0, 40)}…`);

  // ④ 基线不足诚实降级：新任务类型无历史 → z 置 0 不判异常
  const coldEngine = new ReflectionEngine({ qualityThreshold: 0.7 });
  coldEngine.attachDepthGrading({ costThreshold: 100 });
  const cold = coldEngine.gradedReflect({ taskType: 'fresh-task', quality: 0.1, failureCost: 10 });
  ok(cold.quickCheck.windowSamples === 0 && cold.quickCheck.zScore === 0 && cold.escalated === false, '基线不足（<3 样本）不判异常——诚实降级');

  // ⑤ 代价对照：全重基线 24 vs 分级实际 18（省 25%）
  const stats = engine.depthStats();
  ok(stats.light === 2 && stats.heavy === 2 && stats.escalations === 1, `路由统计：轻 2 / 重 2（含升级 1）/ 升级 1（实测 ${stats.light}/${stats.heavy}/${stats.escalations}）`);
  ok(near(stats.allHeavyCostUnits, 24) && near(stats.totalCostUnits, 18), `代价对照：全重基线 24 单位 vs 分级实际 18 单位（实测 ${stats.totalCostUnits}）`);
  ok(near(stats.savedCostUnits, 6), `分级省下 6 单位（省 25%——小代价失败不烧重炮）`);

  // ⑥ 零漂移：分级只读历史，recordExecution 主链路不受扰动
  ok(engine.getCurrentThreshold() === 0.7 && engine.getTrendSummary().windowSize === 8, '阈值 / 趋势窗口不受分级影响（只读 qualityHistory）');
}

// ═══════════════════ S4 失败知识库（reflector） ═══════════════════
section('S4 失败知识库：同模式二次失败 → 规避建议命中 + 采纳后模拟成功');

{
  const memory = tmpMemory('s4');
  let clockNow = T0;
  const TASK = 'batch-convert';
  const engine = new ReflectionEngine({ qualityThreshold: 0.7 });
  const reflector = new Reflector({ memory, reflection: engine, config: { enableProgress: false, autoDistillThreshold: 0 } });
  ok(reflector.avoidanceAdvice(TASK) === undefined && reflector.failureKnowledgeView() === undefined, '未挂载零漂移：规避建议 / 知识库视图 undefined');
  reflector.noteAvoidanceAdopted('fkb-any', true); // 未挂载空操作（不抛错）
  ok(reflector.failureKnowledgeView() === undefined, '未挂载时采纳回填为空操作');

  reflector.attachFailureKnowledgeBase({ clock: () => clockNow });
  const planOf = () => makePlan(TASK, '批量转换批次');
  const failResult = (error) => makeResult('model-slow', false, 0.3, error);

  // 旧世界对照：未挂载的反思器面对同模式失败没有事前规避面
  const bareReflector = new Reflector({ memory, reflection: engine, config: { enableProgress: false, autoDistillThreshold: 0 } });
  bareReflector.reflectOnOutcome({ signal: makeSignal(TASK, 'S4 旧世界失败'), plan: planOf(), result: failResult('执行超时') });
  ok(bareReflector.avoidanceAdvice === undefined || bareReflector.avoidanceAdvice(TASK) === undefined, '旧世界：同模式失败后无规避建议可检索（只有事后教训）');

  // 第一次同模式失败：沉淀失败模式（规避动作 = 放大超时参数）
  reflector.reflectOnOutcome({ signal: makeSignal(TASK, 'S4 第一次超时失败'), plan: planOf(), result: failResult('执行超时：上游 30s 无响应') });
  let entries = reflector.failureKnowledgeView();
  ok(entries.length === 1 && entries[0].occurrences === 1, `第一次失败沉淀 1 条模式（occurrences=1，实测 ${entries.length}/${entries[0]?.occurrences}）`);
  ok(entries[0].rootCause === 'timeout' && entries[0].errorCategory === 'timeout' && entries[0].failedNodeType === TASK, '失败模式特征：根因 timeout × 错误类目 timeout × 节点类型（特征三元组结构化）');
  ok(entries[0].avoidance.type === 'param-tune' && entries[0].avoidance.params['param'] === 'timeoutMultiplier' && entries[0].avoidance.params['value'] === 2, `首次规避动作温和：放大超时 timeoutMultiplier=2（实测 ${entries[0].avoidance.type} ${entries[0].avoidance.params['param']}=${entries[0].avoidance.params['value']}）`);
  ok(entries[0].triggers.length === 2 && entries[0].triggers[0].dimension === 'task-type', '触发条件与程序记忆同构（task-type + root-cause 合取）');

  // 第二次同模式失败：合并计数 + 规避动作升级为规避涉事模型
  reflector.reflectOnOutcome({ signal: makeSignal(TASK, 'S4 第二次超时失败'), plan: planOf(), result: failResult('timeout: 再次超时') });
  entries = reflector.failureKnowledgeView();
  ok(entries.length === 1 && entries[0].occurrences === 2, `同模式二次失败合并计数（1 条 / occurrences=2，实测 ${entries.length}/${entries[0]?.occurrences}）`);
  ok(entries[0].avoidance.type === 'avoid-model' && entries[0].avoidance.params['model'] === 'model-slow', `重复失败规避升级：直接规避 model-slow（实测 ${entries[0].avoidance.type} → ${entries[0].avoidance.params['model']}）`);
  ok(entries[0].implicatedModels.join(',') === 'model-slow', '涉事模型入账（调度层剔除候选的依据）');

  // 检索命中：规避建议随计划下发（三重上下文匹配 → matchScore 1.0）
  const advices = reflector.avoidanceAdvice(TASK, { failedNodeType: TASK, errorHint: '请求超时' });
  ok(advices.length >= 1 && advices[0].occurrences === 2, `检索命中规避建议（实测 ${advices.length} 条，occurrences=${advices[0]?.occurrences}）`);
  ok(near(advices[0].matchScore, 1.0) && advices[0].avoidance.type === 'avoid-model', `三重匹配（任务类型 + 节点类型 + 错误线索）→ matchScore 1.0（实测 ${advices[0].matchScore}）`);
  ok(advices[0].effectiveness === undefined, '无采纳记录时 effectiveness 缺席（诚实标注）');

  // 线索不匹配时打分下降（仍命中但 matchScore 0.6）
  const vague = reflector.avoidanceAdvice(TASK);
  ok(near(vague[0].matchScore, 0.6), `无线索上下文 → matchScore 0.6 基础分（实测 ${vague[0].matchScore}）`);

  // 模拟采纳：调度层按建议剔除 model-slow 改用 model-fast → 重跑成功
  reflector.noteAvoidanceAdopted(advices[0].entryId, true);
  reflector.noteAvoidanceAdopted(advices[0].entryId, true);
  reflector.reflectOnOutcome({ signal: makeSignal(TASK, 'S4 采纳规避后成功重跑'), plan: planOf(), result: makeResult('model-fast', true, 0.88) });
  const adopted = reflector.avoidanceAdvice(TASK, { failedNodeType: TASK, errorHint: '超时' })[0];
  ok(adopted.effectiveness === 1, `建议采纳后模拟成功 ×2 → effectiveness = 1（实测 ${adopted.effectiveness}——规避有效性有了实测证据）`);
  ok(adopted.rationale.includes('model-slow') && adopted.rationale.includes('2 次'), '建议理由含失败次数与涉事模型（可解释下发）');

  // 跨任务类型隔离：其他任务检索不到本模式
  ok(reflector.avoidanceAdvice('other-task', { failedNodeType: 'other-task', errorHint: '超时' }).length === 0, '失败模式按任务类型隔离（other-task 检索为空）');

  // 成功复盘不沉淀失败模式
  const beforeCount = reflector.failureKnowledgeView().length;
  reflector.reflectOnOutcome({ signal: makeSignal(TASK, 'S4 成功复盘'), plan: planOf(), result: makeResult('model-fast', true, 0.9) });
  ok(reflector.failureKnowledgeView().length === beforeCount, '成功复盘不产生失败模式沉淀');
  memory.dispose();
}

// ═══════════════════ S5 计划模板抽象（optimizer，加分） ═══════════════════
section('S5 计划模板：成功计划泛化提取 + 相似任务槽位实例化复用');

{
  const memory = tmpMemory('s5');
  let clockNow = T0;
  const opt = new Optimizer({ memory });
  ok(opt.planTemplates() === undefined && opt.suggestTemplate('任何目标') === undefined && opt.instantiatePlan('tpl-x', '目标') === undefined, '未挂载零漂移：模板面全部 undefined');

  opt.attachPlanTemplates({ clock: () => clockNow });
  ok(opt.noteSuccessfulPlan({ objective: 'x', nodes: [] }, 0.99) === undefined, '空计划不提取');

  // 任务 1 成功（质量 0.92 ≥ 0.8）：泛化为参数化模板
  const plan1 = {
    objective: '翻译 5000 字的产品文档并校对 2 轮',
    nodes: [
      { id: 'a-1', description: '翻译 5000 字的产品文档', type: 'translate', dependsOn: [] },
      { id: 'b-1', description: '校对 2 轮', type: 'proofread', dependsOn: ['a-1'] },
    ],
  };
  const tpl = opt.noteSuccessfulPlan(plan1, 0.92);
  ok(tpl !== undefined && tpl.slots.length === 2 && tpl.slots[0].example === '5000' && tpl.slots[1].example === '2', `提取 2 槽位（${tpl?.slots.map((s) => `${s.name}=${s.example}`).join(', ')}——具体值→槽位）`);
  ok(tpl.objectiveTemplate === '翻译 {slot-0} 字的产品文档并校对 {slot-1} 轮', `目标模板化：${tpl.objectiveTemplate}`);
  ok(tpl.nodes[1].dependsOnIdx.length === 1 && tpl.nodes[1].dependsOnIdx[0] === 0, '依赖以模板内下标表达（跨计划 node id 无关）');

  // 质量门槛：平庸计划不提取
  ok(opt.noteSuccessfulPlan({ objective: '低质计划 100', nodes: [{ id: 'x', description: '步骤 100', type: 'misc', dependsOn: [] }] }, 0.5) === undefined, '质量 0.5 < 0.8 门槛 → 不提取（只有成功且优的计划值得泛化）');

  // 同构计划二次提取：合并计数 + 质量滚动均值（不同 node id 同结构）
  const plan1b = {
    objective: '翻译 7000 字的产品文档并校对 4 轮',
    nodes: [
      { id: 'zz-9', description: '翻译 7000 字的产品文档', type: 'translate', dependsOn: [] },
      { id: 'zz-8', description: '校对 4 轮', type: 'proofread', dependsOn: ['zz-9'] },
    ],
  };
  const merged = opt.noteSuccessfulPlan(plan1b, 0.9);
  ok(opt.planTemplates().length === 1 && merged.extractions === 2, `同构计划合并（库内仍 1 条 / extractions=2，实测 ${opt.planTemplates().length}/${merged.extractions}）`);
  ok(near(merged.avgQuality, (0.92 + 0.9) / 2), `质量滚动均值 ${(0.92 + 0.9).toFixed(2)}/2 = 0.91（实测 ${merged.avgQuality}）`);

  // 任务 2（相似任务：参数不同）→ 匹配 + 实例化
  const goal2 = '翻译 8000 字的产品文档并校对 3 轮';
  const match = opt.suggestTemplate(goal2);
  ok(match !== undefined && near(match.score, 1), `数字掩码后同构 → 匹配分 1.0（实测 ${match?.score}——参数差异不罚分）`);
  ok(opt.suggestTemplate('部署微服务集群到生产环境') === undefined, '无关目标不匹配（低于 0.6 门槛）');

  const inst = opt.instantiatePlan(match.template.id, goal2);
  ok(inst !== undefined && inst.plan.source === 'memory', '实例化产出 source=memory 计划（模板与经验复用同源）');
  ok(inst.plan.objective === goal2, `槽位自动绑定：目标逐字还原（实测「${inst.plan.objective}」）`);
  ok(inst.boundSlots['slot-0'] === '8000' && inst.boundSlots['slot-1'] === '3', `槽位对位绑定 8000/3（实测 ${JSON.stringify(inst.boundSlots)}）`);
  ok(inst.plan.nodes[0].description === '翻译 8000 字的产品文档' && inst.plan.nodes[1].dependsOn.length === 1, `节点描述回填 + 依赖重映射（${inst.plan.nodes[0].description}）`);
  ok(inst.template.usage === 1, `复用计数入账（usage=1，实测 ${inst.template.usage}）`);

  // 显式槽位覆盖：手工指定优先于自动绑定
  const instOverride = opt.instantiatePlan(match.template.id, goal2, { 'slot-0': '12000' });
  ok(instOverride.plan.objective.includes('12000'), `显式槽位值覆盖自动绑定（${instOverride.plan.objective}）`);

  // 旧世界对照：该任务类型无情景记忆 → recallPlan 冷启动 undefined
  const lookup2 = opt.lookupExperience('doc-translate', 0.5, ['translate']);
  ok(lookup2.memoryLayer === 'none' && opt.recallPlan(lookup2, goal2) === undefined, '旧世界对照：无记忆时 recallPlan undefined（模板是冷启动的新落点）');
  ok(opt.instantiatePlan('tpl-nonexistent', goal2) === undefined, '不存在的模板 id → undefined（诚实降级）');
  memory.dispose();
}

// ═══════════════════ S6 零漂移 + 兼容总检 ═══════════════════
section('S6 零漂移总检：五面缺省零介入 + R3 面挂载兼容');

{
  const memory = tmpMemory('s6');
  // 五面全部未挂载：读数缺席 + 行为不变
  const engine = new ReflectionEngine({ qualityThreshold: 0.7 });
  const reflector = new Reflector({ memory, reflection: engine, config: { autoDistillThreshold: 0 } });
  const opt = new Optimizer({ memory });
  const lookup = opt.lookupExperience('fresh-task', 0.5, ['x']);
  ok(
    lookup.transfer === undefined &&
      opt.recommendTransfer('fresh-task', 0.5, ['x']) === undefined &&
      opt.propagationView() === undefined &&
      opt.planTemplates() === undefined &&
      opt.suggestTemplate('任意目标') === undefined &&
      engine.gradedReflect({ taskType: 't', quality: 0.1, failureCost: 999 }) === undefined &&
      engine.depthStats() === undefined &&
      reflector.avoidanceAdvice('fresh-task') === undefined &&
      reflector.failureKnowledgeView() === undefined,
    '五面未挂载：迁移推荐 / 传播账本 / 模板面 / 分级反思 / 失败知识库全部零介入',
  );
  ok(
    opt.recallRouteStats().total === 0 &&
      lookup.recommendation === undefined &&
      engine.retryBanditDecide() === undefined &&
      reflector.counterfactualRecords().length === 0,
    'R3 面（置信路由 / 推荐分解 / 重试 bandit / 反事实台账）未挂载口径保持',
  );

  // R3 面与 R4 面同挂互不干扰：置信路由逐位保持（S1 口径复算）
  for (let i = 1; i <= 4; i += 1) seedSuccess(memory, 'code-review', 'code', 'model-strong', i, { features: ['code', 'review'] });
  const pattern = memory.getAllTaskPatterns().find((p) => p.fingerprint.startsWith('code-review'));
  let clockNow = T0;
  const optBoth = new Optimizer({ memory });
  optBoth.attachRecallConfidenceRouting({ now: () => clockNow });
  optBoth.attachTransferRecommendation();
  optBoth.attachExperiencePropagation({ clock: () => clockNow });
  optBoth.attachPlanTemplates({ clock: () => clockNow });
  const score = optBoth.recallConfidenceOf(pattern);
  ok(score !== undefined && near(score.weightedBase, 0.5 * 0.7 + 0.3 * 1 + 0.2 * 0.5, 1e-5), `R3 置信路由与 R4 面同挂逐位保持（weightedBase=${score?.weightedBase}）`);
  const lookupBoth = optBoth.lookupExperience('code-refactor', 0.6, ['code']);
  ok(lookupBoth.transfer !== undefined && lookupBoth.transfer.best.sourceTaskType === 'code-review', 'R4 迁移推荐照常（同挂无相互干扰）');

  // 反思引擎 R3 bandit 与 R4 分级同挂：两读数各自可用
  engine.attachRetryBandit({ seed: 7 });
  engine.attachDepthGrading({ costThreshold: 100 });
  ok(engine.retryBanditDecide()?.arm !== undefined && engine.gradedReflect({ taskType: 't', quality: 0.3, failureCost: 200 })?.depth === 'heavy', 'R3 重试 bandit 与 R4 深度分级同挂并存');
  memory.dispose();
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(72)}`);
if (failed === 0) {
  console.log(`PASS ${passed}/${passed + failed} — 第四轮 R4-A6 反思轴（optimizer/reflector/reflection-engine）五维升级全部验证通过`);
  process.exit(0);
} else {
  console.log(`PASS ${passed}/${passed + failed}，FAIL ${failed}`);
  process.exit(1);
}
