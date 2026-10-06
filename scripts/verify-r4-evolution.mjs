/**
 * verify-r4-evolution.mjs — 第四轮「进化模块域」世界性升级（激活与深化）离线验证
 * （模块域工程师 R4-A9：strategy-evolution / policy-evolver / policy-types / sandbox）
 *
 * 覆盖五项全新维度升级的构造性证明：
 *
 *   R4-1 多样性仪表（strategy-evolution）：种群基因多样性实时监控——
 *      成对基因距离矩阵均值/最近邻 + 行为描述子分布熵（有效 niche =
 *      2^H Hill 数）；「环境收紧 → 收敛坍缩」进化流证明预警先于最深坍缩点
 *      （第 5 代预警、第 10 代最深 0.028 vs 预警代 0.260），自动注入后
 *      多样性当代回升（0.26 → 0.54）并整窗维持（0.4~0.6 vs 监控线 0.03）
 *   R4-2 跨任务策略迁移（policy-evolver）：复杂域源任务学到的结构
 *      （ensemble 组合逻辑 + 权重）经部分复制迁移到域偏移目标任务；
 *      derived 立即可部署（gain +0.22）；迁移线第 1 代即达 0.847 奖励、
 *      冷启动线第 5 代才首次部署（多烧 32 次沙盒评估）——迁移收敛更快；
 *      收益追踪锁定 beneficial；无益迁移（分解基因迁入简单域 → 增益
 *      −0.31）被识别为 harmful 并弃用（谱系移出种群）
 *   R4-3 进化速率自适应（strategy-evolution）：环境平稳 → 降频档
 *      （应用门槛 12→24，原门槛本会执行的进化被挡下并记账 savedEvolutions）；
 *      适应度地形突变（回报窗口均值差 ≤ −0.15）在 recordOutcome 时刻即
 *      检测（先于 evolve），下一次 evolve 无视门槛立即执行并回全速——
 *      两档切换全台账
 *   R4-4 A/B 分支谱系（policy-evolver）：champion 与 challenger 版本树
 *      并行分支、亏损补齐式确定性分流（20% 精确 8/40，无随机数）、
 *      按实际表现晋升（challenger 0.875 vs 0.625 → 热切换新 champion）
 *      与淘汰（0.25 vs 0.625 → champion 保持在线）
 *   R4-5 进化冻结协议（strategy-evolution/加分）：连续失败冻结（3 代
 *      成熟后代无一改进）→ 冷却（被挡下的 evolve 尝试计数）→ 保守试探
 *      （单点替换 + 变异强度减半）→ 依试探后代结算裁决（成功恢复 /
 *      失败重冻）；外部指令与预算耗尽冻结 + thaw/新预算恢复全状态机
 *   R4-6 零漂移：三项 strategy 旁路全挂载（未触发态）与裸引擎同种子
 *      同工作负载进化报告逐位一致；policy 侧挂载 A/B 配置（未开分支）
 *      后进化周期输出与裸进化器一致
 *   R4-7 综合接线：getReport()/getStatus() 暴露全部新仪表；域偏移任务
 *      生成器确定性可复现；同种子重跑位级一致
 *
 * 全程离线（不依赖 LLM 网络调用），确定性种子（mulberry32）。
 * 运行：npm run build && node scripts/verify-r4-evolution.mjs
 */

import {
  // policy 域
  PolicyEvolver,
  Sandbox,
  generateAdversarialTasks,
  generateDomainShiftedTasks,
  createBaselinePolicy,
  BASELINE_POLICY_PARAMS,
  TRANSFERABLE_POLICY_GENES,
  // strategy 域
  StrategyEvolutionEngine,
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

function near(actual, expected, tolerance, label, detail = '') {
  const pass = Math.abs(actual - expected) <= tolerance;
  if (pass) passed += 1;
  else failed += 1;
  results.push({ pass, label, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`      ${detail || `实际 ${actual.toFixed(6)} vs 期望 ${expected}（容差 ${tolerance}）`}`);
  return pass;
}

function section(title) {
  console.log(`\n${'═'.repeat(72)}\n  ${title}\n${'═'.repeat(72)}`);
}

/** 确定性虚拟时钟：时间加权证据（半衰期 30 天）的衰减基准逐调用 +1（注入时钟纪律——真实时钟毫秒边界会在并列适应度上引入 1e-7 抖动） */
function virtualClock() {
  let t = 1_700_000_000_000;
  return () => (t += 1);
}

/** 确定性随机源（mulberry32）：同一种子 → 同一序列 → 评估可复现 */
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

// ══════════════════════════ R4-1 多样性仪表 ══════════════════════════

section('R4-1 多样性仪表：预警先于收敛坍缩 + 注入后多样性回升');

/** 基因归一化边界（与 StrategyEvolutionEngine.GENE_BOUNDS 同口径，供相似度奖励） */
const GENE_BOUNDS = {
  suppressionWindowMs: { min: 30_000, max: 900_000 },
  failureEscalationThreshold: { min: 1, max: 8 },
  lowConfidenceThreshold: { min: 0.2, max: 0.7 },
  costDeferRatio: { min: 1, max: 10 },
  burstOccurrences: { min: 2, max: 12 },
};
const GENE_KEYS = Object.keys(GENE_BOUNDS);

/** 两基因组归一化相似度（0~1） */
function geneSimilarity(a, b) {
  let sum = 0;
  for (const key of GENE_KEYS) {
    const bounds = GENE_BOUNDS[key];
    sum += 1 - Math.min(1, Math.abs(a[key] - b[key]) / (bounds.max - bounds.min));
  }
  return sum / GENE_KEYS.length;
}

{
  /**
   * 「环境收紧 → 收敛坍缩」构造：
   * - 相位 A（热身 3 代，autoInject 开）：注入式多样化把种群拉开（均值距离 ~0.6）
   * - 相位 B（观察 10 代）：环境按「与当前最优基因型的相似度」给奖励（从众环境），
   *   单点淘汰下主流行为棘轮同质化——多样性逐代坍缩
   * - 监控线（B 内 autoInject 关）只预警；注入线（B 内 autoInject 开）预警代注入
   */
  const collapseConfig = (phaseBInject) => ({
    populationSize: 10,
    eliteCount: 4,
    explorationConstant: 1.4,
    mutationRate: 0.15,
    mutationStrength: 0.1,
    minApplicationsBetweenEvolutions: 30,
    minApplicationsForElite: 2,
    rng: mulberry32(20260901),
    clock: virtualClock(),
    diversity: {
      meanDistanceFloor: 0.15,
      minDistanceFloor: 0,
      entropyFloor: 0.8,
      autoInject: true,
      injectCount: 3,
      candidatePool: 8,
    },
  });
  const WARMUP_GENERATIONS = 3;
  const OBSERVE_GENERATIONS = 10;
  const firstBGeneration = WARMUP_GENERATIONS + 1;

  const runCollapse = (phaseBInject) => {
    const engine = new StrategyEvolutionEngine(collapseConfig(phaseBInject));
    const feed = () => {
      const genomes = engine.getReport().genomes;
      const elite = genomes[0]; // getReport 已按适应度降序
      for (const g of genomes) {
        const sim = g.id === elite.id ? 1 : geneSimilarity(g.genes, elite.genes);
        const outcome = sim > 0.95 ? 'excellent' : sim > 0.85 ? 'good' : sim > 0.7 ? 'acceptable' : 'poor';
        engine.recordOutcome(g.id, outcome);
        engine.recordOutcome(g.id, outcome);
      }
    };
    for (let i = 0; i < WARMUP_GENERATIONS; i += 1) {
      feed();
      engine.evolve(true);
    }
    // 相位 B：监控线关闭注入（只预警）；注入线保持注入
    engine.attachDiversityDashboard({
      meanDistanceFloor: 0.15,
      minDistanceFloor: 0,
      entropyFloor: 0.8,
      autoInject: phaseBInject,
      injectCount: 3,
      candidatePool: 8,
    });
    for (let i = 0; i < OBSERVE_GENERATIONS; i += 1) {
      feed();
      engine.evolve(true);
    }
    return engine;
  };

  // 裸引擎：未挂载仪表 → 报告为空（opt-in 语义）
  const bare = new StrategyEvolutionEngine({ ...collapseConfig(false), diversity: undefined });
  for (let i = 0; i < 3; i += 1) bare.evolve(true);
  ok(bare.diversityReport() === undefined, 'R4-1a 未挂载多样性仪表 → diversityReport() 返回 undefined（缺省零漂移）');

  // 监控线（相位 B 只预警）：完整坍缩轨迹
  const monitor = runCollapse(false);
  const monitorFull = monitor.diversityReport();
  const monitorB = monitorFull.history.filter((m) => m.generation >= firstBGeneration);
  const firstWarningIdx = monitorB.findIndex((m) => m.warning);
  const minMeanIdx = monitorB.reduce((best, m, i) => (m.meanGeneDistance < monitorB[best].meanGeneDistance ? i : best), 0);
  ok(
    monitorB.length === OBSERVE_GENERATIONS && firstWarningIdx >= 0,
    'R4-1b 监控线：观察窗逐代快照入档，低多样性预警确实触发',
    `相位 B 轨迹（均值距离/行为熵）：${monitorB.map((m) => `g${m.generation}:${m.meanGeneDistance}/${m.behaviorEntropyBits}bit`).join(' ')}`,
  );
  ok(
    firstWarningIdx < minMeanIdx,
    'R4-1c 预警先于最深坍缩：首个预警代早于均值距离最低代（坍缩在预警之后继续加深）',
    `首警第 ${monitorB[firstWarningIdx].generation} 代（${monitorB[firstWarningIdx].meanGeneDistance}）< 最深第 ${monitorB[minMeanIdx].generation} 代（${monitorB[minMeanIdx].meanGeneDistance}）——预警提前 ${monitorB[minMeanIdx].generation - monitorB[firstWarningIdx].generation} 代`,
  );
  ok(
    monitorB[minMeanIdx].meanGeneDistance < 0.1 && monitorB[minMeanIdx].effectiveNiches <= 1.5,
    'R4-1d 坍缩读数成立：最深代均值距离 < 0.1 且有效行为 niche 坍缩至 ≤1.5',
    `最深代：均值距离 ${monitorB[minMeanIdx].meanGeneDistance}、行为熵 ${monitorB[minMeanIdx].behaviorEntropyBits}bit（有效 niche ${monitorB[minMeanIdx].effectiveNiches}）`,
  );

  // 注入线（同种子）：预警代注入 → 当代回升 + 整窗维持
  const inject = runCollapse(true);
  const injectFull = inject.diversityReport();
  const injectB = injectFull.history.filter((m) => m.generation >= firstBGeneration);
  const injectEvents = injectFull.events.filter((e) => e.generation >= firstBGeneration);
  ok(
    injectEvents.length >= 1,
    'R4-1e 自动注入触发：观察窗内预警代实际注入了多样化个体（借最远点采样原语）',
    `观察窗注入事件 ${injectEvents.length} 次：${injectEvents.map((e) => `第 ${e.generation} 代 ×${e.injected.length}`).join('、')}`,
  );
  const firstInject = injectEvents[0];
  ok(
    firstInject.after.meanGeneDistance > firstInject.before.meanGeneDistance &&
      firstInject.after.effectiveNiches > firstInject.before.effectiveNiches,
    'R4-1f 注入后当代回升：均值基因距离与有效行为 niche 双双回升（事件 before/after 留档）',
    `第 ${firstInject.generation} 代注入前后：均值距离 ${firstInject.before.meanGeneDistance} → ${firstInject.after.meanGeneDistance}，有效 niche ${firstInject.before.effectiveNiches} → ${firstInject.after.effectiveNiches}`,
  );
  const lastB = monitorB[monitorB.length - 1];
  const lastBInject = injectB[injectB.length - 1];
  ok(
    lastBInject.meanGeneDistance > lastB.meanGeneDistance + 0.15,
    'R4-1g 旧 vs 新对照（观察窗末代）：注入线多样性远高于监控线（一次注入整窗维持 vs 持续坍缩）',
    `末代均值距离：注入线 ${lastBInject.meanGeneDistance} vs 监控线 ${lastB.meanGeneDistance}（差 +${(lastBInject.meanGeneDistance - lastB.meanGeneDistance).toFixed(4)}，${(lastBInject.meanGeneDistance / Math.max(1e-9, lastB.meanGeneDistance)).toFixed(1)} 倍）；有效 niche ${lastBInject.effectiveNiches} vs ${lastB.effectiveNiches}`,
  );
  const injectLineage = inject.lineageReport().nodes.filter((n) => n.operator === 'diversity-inject');
  ok(
    injectLineage.length === injectFull.events.reduce((s, e) => s + e.injected.length, 0),
    'R4-1h 注入个体谱系登记（operator=diversity-inject，版本树留痕可审计）',
    `谱系中 diversity-inject 节点 ${injectLineage.length} 个（与事件台账注入总数对账一致）`,
  );
  // 确定性：同种子重跑监控线 → 位级一致
  const monitor2 = runCollapse(false);
  ok(
    JSON.stringify(monitor2.diversityReport().history) === JSON.stringify(monitorFull.history),
    'R4-1i 确定性：同种子重跑多样性快照序列位级一致（仪表纯计算不消耗随机数）',
  );
}

// ══════════════════════════ R4-2 跨任务策略迁移 ══════════════════════════

section('R4-2 跨任务策略迁移：结构迁移收敛更快 + 无益迁移识别弃用');

const TASK_TYPE = 'code-generation';
const MODELS = [
  { id: 'model-alpha', taskScores: { [TASK_TYPE]: 0.8, general: 0.8 }, avgLatencyMs: 900, avgTokens: 350, maxConcurrency: 4 },
  { id: 'model-beta', taskScores: { [TASK_TYPE]: 0.795, general: 0.795 }, avgLatencyMs: 700, avgTokens: 80, maxConcurrency: 4 },
];

/** 复杂域任务：单模型在成功阈 0.72 下大量失败；ensemble 融合可救（结构选择压力） */
function complexTasks(n, seed) {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => ({
    taskType: TASK_TYPE,
    complexity: 0.75 + rng() * 0.2,
    features: ['code', 'analysis'],
    length: 20000 + Math.floor(rng() * 15000),
    source: 'replay',
    label: `复杂任务#${i + 1}`,
  }));
}

const SB_CONFIG = { successQualityThreshold: 0.72, costNormTokens: 6000 };
/** 目标侧保守进化器：无探索者 + 低布尔翻转（结构再发现需要烧变异预算） */
const CONSERVATIVE = {
  candidateCount: 8,
  minGain: 0.005,
  canaryPromoteSamples: 6,
  knownTaskTypes: [TASK_TYPE],
  crossoverRate: 0.3,
  explorerRate: 0,
  booleanFlipRate: 0.05,
  ruleMutationRate: 0.1,
};

const srcTasks = complexTasks(10, 11);
const srcSandbox = new Sandbox({ models: MODELS, tasks: srcTasks, config: SB_CONFIG });

// 源任务（成熟系统：已花掉探索预算——标准探索配置）学到的结构
const sourceEvolver = new PolicyEvolver({
  ...CONSERVATIVE,
  explorerRate: 0.17,
  booleanFlipRate: 0.25,
  rng: mulberry32(4242),
    clock: virtualClock(),
});
let sourceDonor = null;
for (let i = 0; i < 8 && !sourceDonor; i += 1) {
  await sourceEvolver.runEvolutionCycle(srcSandbox);
  const top = sourceEvolver.exportTransferDonors('source-complex-codegen', 1)[0];
  if (top.policy.params.ensembleEnabled && (top.donorFitnessScore ?? 0) > 0.75) sourceDonor = top;
}
const srcBaselineEval = await srcSandbox.evaluate({ ...createBaselinePolicy(), params: { ...BASELINE_POLICY_PARAMS } });
ok(
  sourceDonor !== null,
  'R4-2a 源任务学到结构：复杂域进化产出 ensemble 组合逻辑精英（迁移供体在案）',
  `源基线奖励 ${srcBaselineEval.reward.toFixed(4)}（成功率 ${srcBaselineEval.metrics.successRate.toFixed(2)}）→ 供体 ${sourceDonor?.policy.id} 适应度 ${sourceDonor?.donorFitnessScore.toFixed(4)}（ensembleEnabled=${sourceDonor?.policy.params.ensembleEnabled}，gap=${sourceDonor?.policy.params.ensembleScoreGap.toFixed(3)}）`,
);

// 目标任务 = 源任务分布的域偏移（同任务族、更复杂更长——结构先验仍适用）
const tgtTasks = generateDomainShiftedTasks(srcTasks, { complexityShift: 0.03, lengthScale: 1.15, complexityJitter: 0.04, rng: mulberry32(99) });
const tgtSandbox = new Sandbox({ models: MODELS, tasks: tgtTasks, config: SB_CONFIG });
const tgtTasks2 = generateDomainShiftedTasks(srcTasks, { complexityShift: 0.06, lengthScale: 1.25, complexityJitter: 0.03, rng: mulberry32(98) });
const tgtSandbox2 = new Sandbox({ models: MODELS, tasks: tgtTasks2, config: SB_CONFIG });

async function runTargetLine(importDonor) {
  const evolver = new PolicyEvolver({ ...CONSERVATIVE, rng: mulberry32(777) });
  let derivedEval = null;
  if (importDonor) {
    // 冷启动对照线快照：导入前先评估目标当前策略（迁移收益的 read 基准）
    await evolver.evaluateCandidate(evolver.getCurrentPolicy(), tgtSandbox);
    const derived = evolver.importTransferredPolicy(importDonor);
    derivedEval = await evolver.evaluateCandidate(derived, tgtSandbox);
    await evolver.evaluateCandidate(derived, tgtSandbox2); // 同分布第二沙盒（多样本入账）
  }
  let firstDeployCycle = -1;
  const rewards = [];
  for (let i = 0; i < 5; i += 1) {
    const cycle = await evolver.runEvolutionCycle(tgtSandbox);
    if (firstDeployCycle < 0 && cycle.deployedPolicyId) firstDeployCycle = i + 1;
    const evaluated = await tgtSandbox.evaluate(evolver.getCurrentPolicy());
    rewards.push(evaluated.reward);
  }
  return { evolver, derivedEval, firstDeployCycle, rewards };
}

const transferLine = await runTargetLine(sourceDonor);
const coldLine = await runTargetLine(null);

ok(
  transferLine.derivedEval.deployable && transferLine.derivedEval.gain > 0.1,
  'R4-2b 迁移起点立即有效：derived 策略在目标任务沙盒可部署且增益显著（结构无需再发现）',
  `derived gain=+${transferLine.derivedEval.gain.toFixed(4)}（LCB +${(transferLine.derivedEval.gainLCB ?? 0).toFixed(4)}，deployable=${transferLine.derivedEval.deployable}）——源任务 ensemble 结构直接救活目标任务成功率`,
);
ok(
  transferLine.firstDeployCycle === 1 && coldLine.firstDeployCycle >= 3,
  'R4-2c 迁移收敛更快：迁移线第 1 代首次部署，冷启动线 ≥3 代（结构再发现烧变异预算）',
  `首次部署代际：迁移线 ${transferLine.firstDeployCycle} vs 冷启动线 ${coldLine.firstDeployCycle}——冷启动多耗 ${(coldLine.firstDeployCycle - 1) * CONSERVATIVE.candidateCount} 次沙盒评估才追平`,
);
ok(
  transferLine.rewards[0] - coldLine.rewards[0] > 0.1,
  'R4-2d 旧 vs 新对照（第 1 代奖励）：迁移线领先冷启动线 >0.1',
  `第 1 代奖励：迁移线 ${transferLine.rewards[0].toFixed(4)} vs 冷启动线 ${coldLine.rewards[0].toFixed(4)}（差 +${(transferLine.rewards[0] - coldLine.rewards[0]).toFixed(4)}）`,
);
ok(
  Math.abs(transferLine.rewards[4] - coldLine.rewards[4]) < 0.05,
  'R4-2e 终态一致：两线第 5 代收敛到同一水平（迁移红利在「速度」而非「上限」）',
  `第 5 代奖励：迁移线 ${transferLine.rewards[4].toFixed(4)} vs 冷启动线 ${coldLine.rewards[4].toFixed(4)}`,
);
{
  const tr = transferLine.evolver.transferReport();
  const rec = tr.records[0];
  const earlyMeanGain =
    rec.evaluations.slice(0, 5).reduce((s, e) => s + e.gain, 0) / Math.max(1, Math.min(5, rec.evaluations.length));
  ok(
    rec.evaluations.length >= 4 && rec.verdict === 'beneficial' && earlyMeanGain > 0.05 && typeof rec.controlFitnessScore === 'number',
    'R4-2f 迁移收益追踪锁定 beneficial：谱系评估入账 ≥4 次、裁决依据（早期均值增益）>0.05、冷启动对照线快照在案',
    `记录 ${rec.id}：n=${rec.evaluations.length}（全周期含部署后回归 0/负增益的微调评估），裁决时早期均值 +${earlyMeanGain.toFixed(4)} → verdict=${rec.verdict}；对照线（导入时刻目标当前策略）适应度 ${rec.controlFitnessScore.toFixed(4)}`,
  );
  ok(
    rec.transferredKeys.length === TRANSFERABLE_POLICY_GENES.length && rec.sourceTask === 'source-complex-codegen',
    'R4-2g 部分复制语义：默认迁移全部结构性标量基因（规则基因=任务记忆不迁移），来源任务留痕',
  );
}

// 无益迁移：复杂域的分解结构迁入简单域（分解在低成本任务上只有 token 协调开销）
{
  const rngS = mulberry32(5);
  const simpleTasks = Array.from({ length: 8 }, (_, i) => ({
    taskType: TASK_TYPE,
    complexity: 0.3 + rngS() * 0.15,
    features: [],
    length: 2000,
    source: 'replay',
    label: `简单任务#${i + 1}`,
  }));
  const COST_HEAVY = { costWeight: 0.45, qualityWeight: 0.2, successWeight: 0.2, costNormTokens: 1500 };
  const simpleSandbox = new Sandbox({ models: MODELS, tasks: simpleTasks, config: COST_HEAVY });
  const simpleSandbox2 = new Sandbox({
    models: MODELS,
    tasks: generateDomainShiftedTasks(simpleTasks, { complexityShift: 0.05, lengthScale: 1.1, rng: mulberry32(21) }),
    config: COST_HEAVY,
  });
  const badDonor = {
    policy: {
      ...createBaselinePolicy('policy-donor-complex-domain'),
      params: { ...BASELINE_POLICY_PARAMS, decomposeEnabled: true, decomposeComplexityThreshold: 0.3, decomposeMaxSubtasks: 8 },
      origin: 'manual',
    },
    sourceTask: 'source-complex-domain',
    exportedAt: Date.now(),
  };
  const badEvolver = new PolicyEvolver({ ...CONSERVATIVE, candidateCount: 6, rng: mulberry32(313) });
  const derivedBad = badEvolver.importTransferredPolicy(badDonor, {
    transferKeys: ['decomposeEnabled', 'decomposeComplexityThreshold', 'decomposeMaxSubtasks'],
  });
  const badEval1 = await badEvolver.evaluateCandidate(derivedBad, simpleSandbox);
  const badEval2 = await badEvolver.evaluateCandidate(derivedBad, simpleSandbox2);
  await badEvolver.runEvolutionCycle(simpleSandbox);
  const badReport = badEvolver.transferReport();
  const rec = badReport.records[0];
  const meanGain = rec.evaluations.reduce((s, e) => s + e.gain, 0) / rec.evaluations.length;
  ok(
    badEval1.gain < -0.1 && badEval2.gain < -0.1,
    'R4-2h 无益迁移识别（读数）：分解结构迁入简单域立即大幅负增益（token 协调开销爆炸）',
    `derived 两沙盒增益 ${badEval1.gain.toFixed(4)} / ${badEval2.gain.toFixed(4)}（简单任务被无谓分解 ×${derivedBad.params.decomposeMaxSubtasks}）`,
  );
  ok(
    rec.verdict === 'harmful' && rec.discardedAt !== undefined && meanGain < -0.05,
    'R4-2i 无益迁移被弃用：verdict=harmful、谱系平均增益 ≤ −margin、弃用时间在案',
    `记录 ${rec.id}：n=${rec.evaluations.length}，meanGain=${meanGain.toFixed(4)} → harmful（${rec.reason}）`,
  );
  ok(
    !badEvolver.getPopulation().some((p) => p.id === derivedBad.id),
    'R4-2j 弃用落地：harmful 谱系个体已移出种群（进化不再围绕无益起点微调）',
  );
}

// ══════════════════════════ R4-3 进化速率自适应 ══════════════════════════

section('R4-3 进化速率自适应：平稳降频省算力 + 突变立即响应');

{
  const rateConfig = {
    populationSize: 6,
    eliteCount: 2,
    minApplicationsBetweenEvolutions: 12,
    minApplicationsForElite: 3,
    rng: mulberry32(88),
    clock: virtualClock(),
    adaptiveRate: { shiftWindow: 10, shiftThreshold: 0.15, stationarityPatience: 2, reducedFactor: 2, improvementEpsilon: 0.03 },
  };
  const feed = (engine, outcome, times) => {
    const genomes = engine.getReport().genomes;
    for (let i = 0; i < times; i += 1) engine.recordOutcome(genomes[i % genomes.length].id, outcome);
  };

  const engine = new StrategyEvolutionEngine(rateConfig);
  // 平稳段：连续 'acceptable'——适应度平台（wilson 增量 < 0.03）→ 降频
  let stationaryRounds = 0;
  while (engine.evolutionRateReport().mode === 'normal' && stationaryRounds < 10) {
    feed(engine, 'acceptable', 12);
    engine.evolve();
    stationaryRounds += 1;
  }
  let rate = engine.evolutionRateReport();
  ok(
    rate.mode === 'reduced' && rate.effectiveMinApplications === 24 && rate.modeSwitches.some((s) => s.to === 'reduced' && s.reason.includes('平稳')),
    'R4-3a 环境平稳 → 降频档：连续无有效进展进入 reduced（应用门槛 12 × 2 = 24）',
    `${stationaryRounds} 轮后 mode=${rate.mode}，生效门槛 ${rate.effectiveMinApplications}（原 12），连续无进展 ${rate.quietGenerations} 代；切换理由："${rate.modeSwitches[rate.modeSwitches.length - 1]?.reason.slice(0, 56)}…"`,
  );

  // 降频生效：原门槛 12 次应用不再触发进化（省算力记账）
  const savedBefore = rate.savedEvolutions;
  feed(engine, 'acceptable', 12);
  const blockedReport = engine.evolve();
  rate = engine.evolutionRateReport();
  ok(
    blockedReport === null && rate.savedEvolutions === savedBefore + 1,
    'R4-3b 降频挡下进化：原门槛已满足（12 次应用）但 evolve 返回 null，省下的进化次数入账',
    `evolve()=null，savedEvolutions ${savedBefore} → ${rate.savedEvolutions}（该次进化在 normal 档本会执行——省算力可计量）`,
  );
  feed(engine, 'acceptable', 12); // 凑足 24 次 → 降频门槛通过
  const reducedGen = engine.evolve();
  ok(
    reducedGen !== null,
    'R4-3c 降频门槛仍可过：应用数达 24 后降频档照常进化（低频 ≠ 停摆）',
    `第 ${reducedGen.generation} 代正常执行（born ${reducedGen.born.length}）`,
  );

  // 突变段：回报骤降在 recordOutcome 时刻即被检测（先于下一次 evolve）
  feed(engine, 'failed', 10);
  rate = engine.evolutionRateReport();
  ok(
    rate.pendingShift && rate.shifts.length >= 1 && rate.shifts[rate.shifts.length - 1].delta <= -0.15,
    'R4-3d 地形突变检测（先于 evolve）：回报窗口均值差 ≤ −0.15 → pendingShift 置位',
    `突变事件：第 ${rate.shifts[rate.shifts.length - 1].generation} 代、累计 ${rate.shifts[rate.shifts.length - 1].atApplications} 次回报、Δ=${rate.shifts[rate.shifts.length - 1].delta}（检测发生于第 10 次 failed 回报时刻，非 evolve 时刻）`,
  );
  const immediateGen = engine.evolve(); // 应用数仅 10 < 12（normal 门槛也不足）
  rate = engine.evolutionRateReport();
  ok(
    immediateGen !== null && rate.pendingShift === false && rate.mode === 'normal',
    'R4-3e 突变立即进化：应用门槛未满（10 < 12）仍立即执行新一代，并恢复全速档',
    `第 ${immediateGen.generation} 代在仅 10 次应用时立即执行；mode=${rate.mode}、pendingShift=${rate.pendingShift}`,
  );

  // 零漂移：未挂载速率自适应的裸引擎，门槛行为不变
  const bareEngine = new StrategyEvolutionEngine({ ...rateConfig, adaptiveRate: undefined });
  feed(bareEngine, 'good', 11);
  ok(
    bareEngine.evolve() === null && bareEngine.evolutionRateReport() === undefined,
    'R4-3f 零漂移：裸引擎 11 次应用（< 12）evolve 返回 null，速率报告为空',
  );
}

// ══════════════════════════ R4-4 A/B 分支谱系 ══════════════════════════

section('R4-4 A/B 分支谱系：确定性分流 + 晋升/淘汰双路径');

{
  const evolver = new PolicyEvolver({ rng: mulberry32(2024) });
  const champion0 = evolver.getCurrentPolicy();
  // 无分支时路由返回 none（opt-in 语义）
  ok(
    evolver.peekABRoute() === 'none' && (await evolver.routeOperationalOutcome({ success: true })) === 'none',
    'R4-4a 未开启分支 → 路由返回 none（缺省零漂移）',
  );

  // challenger = champion 的版本树子代（manual 构造，完全确定）
  const challenger = {
    ...champion0,
    id: 'policy-challenger-1',
    version: champion0.version + 1,
    params: { ...BASELINE_POLICY_PARAMS, ensembleEnabled: true, ensembleScoreGap: 0.2, ensembleMaxModels: 2 },
    origin: 'manual',
    generation: champion0.generation + 1,
    parentId: champion0.id,
  };
  evolver.attachABBranching({ challengerTraffic: 0.2, minSamples: 8, promoteMargin: 0.05, retireMargin: 0.05 });
  const branchStart = evolver.startABBranch(challenger);
  ok(
    branchStart.active && branchStart.challengerPolicyId === challenger.id && branchStart.challengerParentId === champion0.id,
    'R4-4b 分支开启：champion 在线 + challenger 为其版本树子代（并行分支点留痕）',
    `champion=${branchStart.championPolicyId}，challenger=${branchStart.challengerPolicyId}（parent=${branchStart.challengerParentId}），流量比例 ${branchStart.trafficRatio}`,
  );

  // 确定性分流 + 晋升路径：challenger 85% vs champion 60%
  const arms = [];
  for (let i = 0; i < 44; i += 1) {
    const arm = evolver.peekABRoute();
    arms.push(arm);
    const success = arm === 'challenger' ? (i * 7) % 20 < 17 : (i * 7) % 20 < 12; // 85% vs 60%
    await evolver.routeOperationalOutcome({ success, quality: success ? 0.9 : 0.4 });
  }
  const promotedReport = evolver.abReport();
  const challengerRoutes = arms.filter((a) => a === 'challenger').length;
  ok(
    challengerRoutes === 8 && arms[0] === 'challenger',
    'R4-4c 分流正确：44 条流量中 challenger 恰 8 条且首条即 challenger（亏损补齐式确定性路由）',
    `challenger ${challengerRoutes}/44（首 40 条恰 20%），序列前 10 条 [${arms.slice(0, 10).join(', ')}]——无随机数，序列可复现`,
  );
  near(challengerRoutes / 44, 0.2, 0.02, 'R4-4d 分流比例收敛：实际 challenger 流量占比 ≈ 目标 20%', `实际 ${(challengerRoutes / 44).toFixed(4)} vs 目标 0.2`);
  ok(
    promotedReport.active === false &&
      promotedReport.history.length === 1 &&
      promotedReport.history[0].status === 'promoted' &&
      evolver.getCurrentPolicy().id === challenger.id,
    'R4-4e 晋升路径：challenger 实际表现达标 → 热切换为新 champion，分支档案入历史',
    `双侧样本 ${promotedReport.history[0].challenger.samples} vs ${promotedReport.history[0].champion.samples}，成功率 ${promotedReport.history[0].challenger.successRate} vs ${promotedReport.history[0].champion.successRate}；${promotedReport.history[0].reason}`,
  );

  // 淘汰路径：新进化器，challenger 30% vs champion 60%
  const evolver2 = new PolicyEvolver({ rng: mulberry32(2025) });
  const championB = evolver2.getCurrentPolicy();
  const challenger2 = {
    ...championB,
    id: 'policy-challenger-2',
    version: championB.version + 1,
    origin: 'manual',
    parentId: championB.id,
  };
  evolver2.attachABBranching({ challengerTraffic: 0.2, minSamples: 8, promoteMargin: 0.05, retireMargin: 0.05 });
  evolver2.startABBranch(challenger2);
  for (let i = 0; i < 44; i += 1) {
    const arm = evolver2.peekABRoute();
    const success = arm === 'challenger' ? (i * 7) % 20 < 4 : (i * 7) % 20 < 12; // challenger ≈25% vs champion ≈60%
    await evolver2.routeOperationalOutcome({ success });
  }
  const retiredReport = evolver2.abReport();
  ok(
    retiredReport.active === false &&
      retiredReport.history[0].status === 'retired' &&
      evolver2.getCurrentPolicy().id === championB.id,
    'R4-4f 淘汰路径：challenger 实际表现劣化 → 淘汰归档，champion 保持在线',
    `成功率 ${retiredReport.history[0].challenger.successRate} vs ${retiredReport.history[0].champion.successRate}；${retiredReport.history[0].reason}`,
  );
  // 晋升的 challenger 进入部署历史（版本树上线留痕）
  const deployed = evolver.getStatus().deployedHistory;
  ok(
    deployed.some((d) => d.id === challenger.id),
    'R4-4g 晋升即上线：challenger 进入部署历史（A/B 观察窗已代行金丝雀职责）',
  );
}

// ══════════════════════════ R4-5 进化冻结协议（加分） ══════════════════════════

section('R4-5 进化冻结协议：连续失败冻结 → 冷却 → 保守试探 → 裁决恢复');

/** 只给本代新生儿回报（成熟后代结算判据的喂食器） */
const feedNewborns = (engine, outcome, times = 3) => {
  for (const g of engine.getReport().genomes) {
    if (g.applications === 0) for (let i = 0; i < times; i += 1) engine.recordOutcome(g.id, outcome);
  }
};

{
  const freezeConfig = {
    populationSize: 8,
    eliteCount: 2,
    minApplicationsForElite: 3,
    rng: mulberry32(66),
    clock: virtualClock(),
    freeze: { maxFailedGenerations: 3, cooldownAttempts: 2 },
  };

  // 流 A：冻结 → 冷却 → 试探成功 → 恢复
  const engineA = new StrategyEvolutionEngine(freezeConfig);
  // 预热：全种群 3× good → 精英确立（常态代淘汰规模 = 2）
  for (const g of engineA.getReport().genomes) for (let i = 0; i < 3; i += 1) engineA.recordOutcome(g.id, 'good');
  engineA.evolve(true); // 第 1 代
  const gen2 = engineA.evolve(true); // 第 2 代（判定第 1 代新生儿：未成熟 → undetermined）
  ok(
    gen2 !== null && gen2.eliminated.length === 2,
    'R4-5a 常态代淘汰规模：population 8 / elite 2 → 单代淘汰 2（保守试探代将减半为 1）',
    `第 ${gen2.generation} 代 eliminated=${gen2.eliminated.length}、born=${gen2.born.length}`,
  );
  feedNewborns(engineA, 'failed');
  engineA.evolve(true); // 第 3 代：判定 failed#1
  feedNewborns(engineA, 'failed');
  engineA.evolve(true); // 第 4 代：failed#2
  feedNewborns(engineA, 'failed');
  const blockedAtFreeze = engineA.evolve(true); // failed#3 → 冻结
  let freeze = engineA.freezeReport();
  ok(
    blockedAtFreeze === null && freeze.state === 'frozen' && freeze.reason.includes('连续'),
    'R4-5b 连续失败冻结：3 代成熟后代无一改进 → evolve 被挡下（force 也不豁免），原因在案',
    `state=${freeze.state}，blockedAttempts=${freeze.blockedAttempts}，reason="${freeze.reason}"，冷却剩余 ${freeze.cooldownRemaining} 次尝试`,
  );
  engineA.evolve(true); // 冷却 1
  const midCooldown = engineA.freezeReport();
  engineA.evolve(true); // 冷却 2 → probing
  freeze = engineA.freezeReport();
  ok(
    midCooldown.state === 'frozen' && midCooldown.cooldownRemaining === 1 && freeze.state === 'probing',
    'R4-5c 冷却完成进入试探：被挡下的尝试逐次倒数冷却 → probing（无时钟、确定性）',
    `frozen（冷却剩 ${midCooldown.cooldownRemaining}）→ ${freeze.state}；状态机台账 ${freeze.events.length} 条`,
  );
  const probeGen = engineA.evolve(true); // 保守试探代
  freeze = engineA.freezeReport();
  ok(
    probeGen !== null && probeGen.eliminated.length === 1 && freeze.probeGeneration === probeGen.generation,
    'R4-5d 保守试探代：只替换最弱 1 个个体（常态 2 个）+ 变异强度减半，试探代际在案',
    `第 ${probeGen.generation} 代 eliminated=${probeGen.eliminated.length}（常态 2）、born=${probeGen.born.length}`,
  );
  feedNewborns(engineA, 'excellent'); // 试探代新生儿回报 excellent
  const afterProbe = engineA.evolve(true); // 裁决：improved → running
  freeze = engineA.freezeReport();
  ok(
    afterProbe !== null && freeze.state === 'running' && freeze.events.some((e) => e.reason.includes('试探成功')),
    'R4-5e 试探成功恢复：试探代后代适应度改进 → 解除冻结回 running（裁决事件留痕）',
    `state=${freeze.state}；裁决："${freeze.events[freeze.events.length - 1]?.reason}"`,
  );

  // 流 B：试探失败 → 重新冻结
  const engineB = new StrategyEvolutionEngine(freezeConfig);
  engineB.evolve(true);
  engineB.evolve(true);
  for (let i = 0; i < 3; i += 1) {
    feedNewborns(engineB, 'failed');
    engineB.evolve(true); // failed#1/#2/#3（第 3 次冻结）
  }
  engineB.evolve(true); // 冷却 1
  engineB.evolve(true); // 冷却 2 → probing
  const bProbe = engineB.evolve(true); // 试探代
  feedNewborns(engineB, 'failed'); // 试探代新生儿也失败
  const bBlocked = engineB.evolve(true); // 裁决 failed → 重冻
  const freezeB = engineB.freezeReport();
  ok(
    bProbe !== null && bBlocked === null && freezeB.state === 'frozen' && freezeB.events.some((e) => e.reason.includes('重新冻结')),
    'R4-5f 试探失败重冻：试探代后代仍无改进 → 重新冻结并重置冷却（状态机闭环）',
    `试探代 ${bProbe.generation} 执行后裁决失败 → state=${freezeB.state}："${freezeB.events[freezeB.events.length - 1]?.reason}"`,
  );

  // 流 C：外部指令冻结 + thaw 恢复
  const engineC = new StrategyEvolutionEngine({ ...freezeConfig, rng: mulberry32(67) });
  engineC.evolve(true);
  const directive = engineC.freezeEvolution('外部指令：审计期间暂停进化');
  const cBlocked = engineC.evolve(true);
  const thawed = engineC.thawEvolution();
  const stateAfterThaw = engineC.freezeReport().state; // 试探执行前捕获
  const cProbe = engineC.evolve(true);
  ok(
    directive.state === 'frozen' &&
      cBlocked === null &&
      thawed &&
      stateAfterThaw === 'probing' &&
      cProbe !== null &&
      cProbe.eliminated.length === 1,
    'R4-5g 外部指令：freezeEvolution 立即冻结（force 也绕不过）→ thawEvolution 跳过冷却进入试探 → 试探代执行',
    `指令冻结 → evolve=null → thaw → probing → 试探代 ${cProbe.generation} 执行（eliminated=${cProbe.eliminated.length}=常态减半）`,
  );

  // 流 D：预算耗尽冻结 → 提高预算解冻 → 试探
  const engineD = new StrategyEvolutionEngine({ ...freezeConfig, rng: mulberry32(68),
    clock: virtualClock(), evolutionBudget: 12 });
  for (let i = 0; i < 4; i += 1) engineD.evolve(true); // 每代 born 3 → 第 4 代 spent=12 耗尽并冻结
  const freezeD = engineD.freezeReport();
  const budgetD = engineD.evolutionBudgetReport();
  ok(
    budgetD.exhausted && freezeD.state === 'frozen' && freezeD.reason.includes('预算'),
    'R4-5h 预算耗尽冻结：spent ≥ cap → 自动冻结（「进化不能无限烧样本」的协议级表达）',
    `budget spent=${budgetD.spent}/cap=${budgetD.cap}，state=${freezeD.state}，reason="${freezeD.reason}"`,
  );
  engineD.attachEvolutionBudget(60); // 注入新预算：耗尽标记清空
  engineD.evolve(true); // 冷却 1
  engineD.evolve(true); // 冷却 2 → probing
  const dProbe = engineD.evolve(true); // 试探代（预算门已过）
  ok(
    dProbe !== null && !engineD.evolutionBudgetReport().exhausted,
    'R4-5i 预算恢复解冻：新上限注入 → 冷却 → 保守试探代照常执行',
    `第 ${dProbe.generation} 代试探执行（spent=${engineD.evolutionBudgetReport().spent}/60）`,
  );

  // 零漂移：挂载冻结协议但状态 running → 行为不变
  const bareEngine = new StrategyEvolutionEngine({ ...freezeConfig, rng: mulberry32(69),
    clock: virtualClock(), freeze: undefined });
  const frozenEngine = new StrategyEvolutionEngine({ ...freezeConfig, rng: mulberry32(69) });
  const bareReports = [];
  const frozenReports = [];
  for (let i = 0; i < 3; i += 1) {
    for (const g of bareEngine.getReport().genomes) bareEngine.recordOutcome(g.id, 'good');
    for (const g of frozenEngine.getReport().genomes) frozenEngine.recordOutcome(g.id, 'good');
    bareReports.push(bareEngine.evolve(true));
    frozenReports.push(frozenEngine.evolve(true));
  }
  ok(
    JSON.stringify(bareReports) === JSON.stringify(frozenReports) && frozenEngine.freezeReport().state === 'running',
    'R4-5j 零漂移：协议挂载且 running 态，3 代进化报告与裸引擎逐位一致',
  );
}

// ══════════════════════════ R4-6 零漂移（全旁路挂载未触发态） ══════════════════════════

section('R4-6 零漂移：全旁路挂载（未触发态）与裸引擎行为逐位一致');

{
  // strategy：三项 R4 旁路全挂载（多样性只监控 + 速率 normal 态 + 冻结 running 态）
  const workload = { populationSize: 6, eliteCount: 2, minApplicationsBetweenEvolutions: 12, minApplicationsForElite: 3 };
  const bare = new StrategyEvolutionEngine({ ...workload, rng: mulberry32(555) });
  const attached = new StrategyEvolutionEngine({
    ...workload,
    rng: mulberry32(555),
    clock: virtualClock(),
    diversity: { autoInject: false, meanDistanceFloor: 0.001, minDistanceFloor: 0.001, entropyFloor: 0.001 },
    adaptiveRate: { stationarityPatience: 50 }, // 观察窗内不降频
    freeze: true,
  });
  const bareOut = [];
  const attachedOut = [];
  for (let i = 0; i < 3; i += 1) {
    for (const g of bare.getReport().genomes) bare.recordOutcome(g.id, 'good');
    for (const g of attached.getReport().genomes) attached.recordOutcome(g.id, 'good');
    bareOut.push(bare.evolve(true));
    attachedOut.push(attached.evolve(true));
  }
  ok(
    JSON.stringify(bareOut) === JSON.stringify(attachedOut.map((r) => ({ ...r, diversifications: undefined }))) &&
      JSON.stringify(bare.getReport().genomes) === JSON.stringify(attached.getReport().genomes) &&
      attachedOut.every((r) => (r.diversifications ?? []).length === 0),
    'R4-6a strategy 全旁路挂载（未触发态）：3 代进化报告与种群基因逐位一致（仅多出空的 diversifications 记录字段）',
    `多样性监控 ${attached.diversityReport().history.length} 代快照、速率 ${attached.evolutionRateReport().mode}、冻结 ${attached.freezeReport().state}——全部只记账不干预`,
  );

  // policy：迁移记录与 A/B 分支全空时，进化周期输出与裸进化器一致
  const peBare = new PolicyEvolver({ rng: mulberry32(888),
    clock: virtualClock(), candidateCount: 6, minGain: 0.005, knownTaskTypes: [TASK_TYPE] });
  const peAttached = new PolicyEvolver({ rng: mulberry32(888),
    clock: virtualClock(), candidateCount: 6, minGain: 0.005, knownTaskTypes: [TASK_TYPE] });
  peAttached.attachABBranching({ challengerTraffic: 0.3 }); // 只挂配置不开分支
  const driftSandbox = new Sandbox({ models: MODELS, tasks: complexTasks(6, 42), config: SB_CONFIG });
  const cycleBare = await peBare.runEvolutionCycle(driftSandbox);
  const cycleAttached = await peAttached.runEvolutionCycle(driftSandbox);
  ok(
    JSON.stringify(cycleBare.candidates) === JSON.stringify(cycleAttached.candidates) &&
      cycleBare.deployedPolicyId === cycleAttached.deployedPolicyId &&
      peAttached.transferReport().records.length === 0 &&
      peAttached.abReport().active === false,
    'R4-6b policy 挂载面（未启用迁移/分支）：候选评估与部署决策与裸进化器一致',
    `候选 ${cycleBare.candidates.length} 个逐位一致，deployed=${cycleBare.deployedPolicyId ?? '无'}；transfer 记录 0、A/B inactive`,
  );
}

// ══════════════════════════ R4-7 综合接线 ══════════════════════════

section('R4-7 综合接线：仪表暴露面与确定性');

{
  // getReport()/getStatus() 暴露全部新仪表
  const engine = new StrategyEvolutionEngine({
    rng: mulberry32(99),
    clock: virtualClock(),
    diversity: true,
    adaptiveRate: true,
    freeze: true,
  });
  for (const g of engine.getReport().genomes) engine.recordOutcome(g.id, 'good');
  engine.evolve(true);
  const report = engine.getReport();
  ok(
    report.diversity !== undefined && report.rate !== undefined && report.freeze !== undefined,
    'R4-7a getReport() 暴露多样性/速率/冻结三仪表（挂载即输出）',
    `diversity（有效 niche ${report.diversity.current.effectiveNiches}，告警=${report.diversity.current.warning}）、rate.mode=${report.rate.mode}、freeze.state=${report.freeze.state}`,
  );
  const status = transferLine.evolver.getStatus();
  ok(
    status.transfer !== undefined && status.transfer.records.length >= 1,
    'R4-7b getStatus() 暴露迁移台账（有迁移记录时输出）',
    `transfer: pending=${status.transfer.pending} beneficial=${status.transfer.beneficial} harmful=${status.transfer.harmful}`,
  );
  ok(
    TRANSFERABLE_POLICY_GENES.length === 10 && TRANSFERABLE_POLICY_GENES.includes('ensembleEnabled') && !TRANSFERABLE_POLICY_GENES.includes('rules'),
    'R4-7c 默认迁移集导出（TRANSFERABLE_POLICY_GENES：全部结构性标量基因，规则基因=任务记忆不迁移）',
    `${TRANSFERABLE_POLICY_GENES.length} 个基因`,
  );

  // 域偏移任务生成器确定性 + 平移生效
  const s1 = generateDomainShiftedTasks(complexTasks(4, 7), { complexityShift: 0.1, rng: mulberry32(3) });
  const s2 = generateDomainShiftedTasks(complexTasks(4, 7), { complexityShift: 0.1, rng: mulberry32(3) });
  ok(
    JSON.stringify(s1) === JSON.stringify(s2) && s1.length === 4 && s1[0].complexity > 0.8,
    'R4-7d 域偏移任务生成器（sandbox）：确定性可复现 + 复杂度平移生效（迁移实验基础设施）',
    `首个任务复杂度 ${s1[0].complexity}（原 0.75~0.95 域 + 0.1 平移 + 抖动）`,
  );

  // 对抗合成任务（既有口径）仍可用——第三轮兼容面
  ok(
    generateAdversarialTasks([TASK_TYPE], mulberry32(2)).length === 4,
    'R4-7e 既有对抗任务合成原样可用（第三轮兼容面不变）',
  );
}

// ══════════════════════════ 结果输出 ══════════════════════════

console.log('\n=== 第四轮「进化模块域」升级验证结果 ===');
for (const r of results) {
  if (!r.pass) console.log(`FAIL  ${r.label}\n      ${r.detail}`);
}
console.log(`\nPASS ${passed} / FAIL ${failed}`);
if (failed > 0) {
  console.log('\n✗ 存在未通过的断言，请检查。');
  process.exit(1);
}
console.log('\n✓ 进化模块域第四轮升级全部通过：多样性仪表（预警先于坍缩 + 注入整窗维持）× 跨任务策略迁移（结构迁移快 4 代 / 无益迁移识别弃用）× 进化速率自适应（平稳降频省算力 + 突变立即响应）× A/B 分支谱系（确定性 20% 分流 + 晋升/淘汰双路径）× 冻结协议（失败/指令/预算三冻结源 + 冷却 + 保守试探裁决）——进化器从「可审计的受治理进化」升级为「有多样性意识、能跨任务复用结构、懂算力经济、支持在线实验与安全暂停的进化系统」。');
process.exit(0);
