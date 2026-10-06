/**
 * verify-mod-evolution.mjs — 第三轮世界性升级「进化模块域」离线验证
 * （模块域工程师 A9：strategy-evolution / policy-evolver / policy-types / sandbox）
 *
 * 覆盖五项升级的构造性证明：
 *
 *   S1 对抗课程（sandbox）：难度自适应状态机（连续成功加难 / 连续失败减难）；
 *      边界案例挖掘（历史失败模式附近采样密度加大，新旧密度对照）；
 *      学习曲线（自适应课程 vs 固定难度——前沿增益与技能成长对照）
 *   S2 证书门进化环（policy-evolver）：候选上线四门流水线
 *      沙盒跑分 → 88.0 OPE 反事实估值 → 89.0 LCB 证书 → 金丝雀观察窗；
 *      「表面分高但离线估值差」被 OPE 门拦截；真改进四门全过放行晋升；
 *      观察窗漂移 → 自动回滚 + 证书吊销（同 id 不再复证）；
 *      证书台账与吊销名单跨重启持久化（重启后同 id 复证仍被拒）
 *   S3 进化谱系（strategy-evolution）：三代进化的版本树（父代/算子/适应度/
 *      存活/上线）+ 谱系回溯查询（lineageOf 祖先链 / descendantsOf 子树）
 *   S4 变异算子组合治理（strategy-evolution）：某算子持续劣化 → 信用 EWMA
 *      下降 → softmax 权重下降 → 选择转移；治理生效后种群适应度恢复
 *   S5 进化预算与停滞检测（strategy-evolution）：逐代消耗记账 + 耗尽拒开；
 *      适应度 N 代无进展 → 重启多样化注入 → 突破局部平台（旧 vs 新对照）
 *   S6 零漂移兼容：默认引擎（不挂治理/停滞）进化行为与报告结构不变；
 *      固定难度 generateAdversarialTasks 原样保留
 *   S7 attach* 挂载面：治理/停滞/预算在构造后挂载即生效（与 config
 *      路径等效），softmax 权重归一、台账收支对账一致
 *
 * 全程离线（不依赖 LLM 网络调用），确定性种子（mulberry32）。
 * 运行：npm run build && node scripts/verify-mod-evolution.mjs
 */

import {
  // policy 域
  PolicyEvolver,
  Sandbox,
  generateAdversarialTasks,
  AdversarialCurriculum,
  createBaselinePolicy,
  BASELINE_POLICY_PARAMS,
  policyParamsWithinBounds,
  // strategy 域
  StrategyEvolutionEngine,
} from '../dist/index.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// ══════════════════════════ 公共素材 ══════════════════════════

const TASK_TYPE = 'code-generation';
const HARD_TYPE = 'hard-analysis';

// 沙盒模型快照（与 verify-policy-evolution 同构：近分双模型，beta 极便宜）
const SANDBOX_MODELS = [
  { id: 'model-alpha', taskScores: { [TASK_TYPE]: 0.8, [HARD_TYPE]: 0.64, general: 0.8 }, avgLatencyMs: 900, avgTokens: 350, maxConcurrency: 4 },
  { id: 'model-beta', taskScores: { [TASK_TYPE]: 0.795, [HARD_TYPE]: 0.6, general: 0.795 }, avgLatencyMs: 700, avgTokens: 80, maxConcurrency: 4 },
];

// 历史回放任务（直接构造，免记忆库依赖）+ 固定对抗模板
const REPLAY_TASKS = Array.from({ length: 12 }, (_, i) => ({
  taskType: i % 3 === 0 ? HARD_TYPE : TASK_TYPE,
  complexity: 0.6 + (i % 4) * 0.1,
  features: i % 2 === 0 ? ['code'] : ['analysis'],
  length: 8_000 + i * 1_500,
  source: 'replay',
  label: `回放任务 ${i}`,
}));

const buildSandbox = (seed = 20261001, config = {}) =>
  new Sandbox({
    models: SANDBOX_MODELS,
    tasks: [...REPLAY_TASKS, ...generateAdversarialTasks([TASK_TYPE, HARD_TYPE], mulberry32(seed))],
    config,
  });

const baseline = createBaselinePolicy('policy-verify-mod-baseline', 1);

// 策略基因边界（strategy-evolution 归一化口径的脚本侧镜像）
const GENE_BOUNDS_JS = {
  suppressionWindowMs: { min: 30_000, max: 15 * 60_000, integer: true },
  failureEscalationThreshold: { min: 1, max: 8, integer: true },
  lowConfidenceThreshold: { min: 0.2, max: 0.7, integer: false },
  costDeferRatio: { min: 1, max: 10, integer: false },
  burstOccurrences: { min: 2, max: 12, integer: true },
};
const GENE_KEYS = Object.keys(GENE_BOUNDS_JS);
const normGenes = (genes) =>
  GENE_KEYS.map((k) => {
    const b = GENE_BOUNDS_JS[k];
    return Math.max(0, Math.min(1, (genes[k] - b.min) / (b.max - b.min)));
  });

// ══════════════════════════ S1 对抗课程（sandbox 升级） ══════════════════════════

section('S1 对抗任务生成升级：难度自适应（59.0 课程思想）+ 边界案例挖掘');

// S1.1 固定难度口径原样保留（零回归）
const legacyTasks = generateAdversarialTasks([TASK_TYPE, HARD_TYPE], mulberry32(3));
ok(
  legacyTasks.length === 4 &&
    ['极端复杂任务', '冷启动任务', '特征密集任务', '极简任务'].every((l) => legacyTasks.some((t) => t.label === l)) &&
    legacyTasks.every((t) => t.source === 'adversarial' && t.curriculum === undefined),
  'S1.1 固定难度 generateAdversarialTasks 原样保留（4 模板 / 无课程元数据——零漂移兼容）',
  `${legacyTasks.length} 条固定对抗任务（${legacyTasks.map((t) => t.label).join('、')}），均不携带 curriculum 元数据`,
);

// S1.2 掌握门限状态机：连续成功加难 / 连续失败减难
const smCur = new AdversarialCurriculum({ rng: mulberry32(7), knownTaskTypes: [TASK_TYPE] });
const d0 = smCur.getDifficulty();
smCur.recordOutcome(true);
const dMid = smCur.getDifficulty();
smCur.recordOutcome(true); // 两连胜 → 加难
const d1 = smCur.getDifficulty();
smCur.recordOutcome(false);
smCur.recordOutcome(false); // 两连败 → 减难
const d2 = smCur.getDifficulty();
const smReport = smCur.report();
ok(
  dMid === d0 && d1 === d0 + 0.12 && d2 === d1 - 0.12 && smReport.hardened === 1 && smReport.softened === 1,
  'S1.2 难度自适应状态机：连续 2 次成功加难（+0.12）、连续 2 次失败减难（−0.12）',
  `难度 ${d0.toFixed(2)} →（单次成功不动作 ${dMid.toFixed(2)}）→（两连胜加难）${d1.toFixed(2)} →（两连败减难）${d2.toFixed(2)}；hardened=${smReport.hardened}，softened=${smReport.softened}`,
);

// S1.3 难度驱动的任务生成：难度档映射到模板复杂度
const easyCur = new AdversarialCurriculum({ rng: mulberry32(9), knownTaskTypes: [TASK_TYPE], initialDifficulty: 0.05 });
const hardCur = new AdversarialCurriculum({ rng: mulberry32(9), knownTaskTypes: [TASK_TYPE], initialDifficulty: 0.98 });
const easyTasks = easyCur.generate(4);
const hardTasks = hardCur.generate(4);
ok(
  hardTasks.every((t, i) => t.complexity > easyTasks[i].complexity) &&
    easyTasks.every((t) => t.curriculum?.difficulty === 0.05) &&
    hardTasks.every((t) => t.curriculum?.difficulty === 0.98),
  'S1.3 任务复杂度由难度档驱动（同种子下高难度档四模板复杂度全面更高）',
  `低档 d=0.05 → [${easyTasks.map((t) => t.complexity).join(', ')}]；高档 d=0.98 → [${hardTasks.map((t) => t.complexity).join(', ')}]`,
);

// S1.4 边界案例挖掘：失败模式附近采样密度加大（新旧对照）
const FAILURE_MODES = [
  { taskType: TASK_TYPE, complexity: 0.8, features: ['code'], failures: 5 },
  { taskType: 'documentation', complexity: 0.3, features: ['doc'], failures: 1 },
];
const mineCur = new AdversarialCurriculum({
  rng: mulberry32(42),
  knownTaskTypes: [TASK_TYPE],
  failureModes: FAILURE_MODES,
  boundaryMiningRate: 0.6,
  boundaryJitter: 0.05,
});
const minedTasks = mineCur.generate(400);
const mined = minedTasks.filter((t) => t.curriculum?.boundaryMined);
const nearMode = (t, mode) => t.taskType === mode.taskType && Math.abs(t.complexity - mode.complexity) <= 0.051;
const nearHot = mined.filter((t) => nearMode(t, FAILURE_MODES[0])).length; // 失败 5 次（权重 5/6）
const nearCold = mined.filter((t) => nearMode(t, FAILURE_MODES[1])).length; // 失败 1 次（权重 1/6）
const legacyDensity =
  generateAdversarialTasks([TASK_TYPE], mulberry32(42)).concat(
    generateAdversarialTasks([TASK_TYPE], mulberry32(43)),
    generateAdversarialTasks([TASK_TYPE], mulberry32(44)),
    generateAdversarialTasks([TASK_TYPE], mulberry32(45)),
  ).filter((t) => t.taskType === TASK_TYPE && Math.abs(t.complexity - 0.8) <= 0.051).length / 16;
const newDensity = nearHot / 400;
ok(
  mined.length > 400 * 0.5 &&
    mined.length < 400 * 0.7 &&
    mined.every((t) => nearMode(t, FAILURE_MODES[0]) || nearMode(t, FAILURE_MODES[1])) &&
    nearHot > nearCold * 2 &&
    newDensity > legacyDensity * 1.5,
  'S1.4 边界案例挖掘：历史失败模式附近采样密度显著加大（失败次数加权）',
  `400 任务中边界挖掘 ${mined.length} 条（占比 ${(mined.length / 4).toFixed(1)}%，目标 60%），全部落在失败模式 ±0.05 内；热点模式（5 次失败）${nearHot} 条 vs 冷点（1 次失败）${nearCold} 条（权重 5:1）；0.8±0.05 密度：新 ${(newDensity * 100).toFixed(1)}% vs 旧固定模板 ${(legacyDensity * 100).toFixed(1)}%（${(newDensity / legacyDensity).toFixed(1)}×）`,
);

// S1.5 学习曲线：自适应课程 vs 固定难度（59.0 增益窗口定律驱动的学习者）
const runLearner = (mode, batches = 40, batchSize = 6) => {
  const rng = mulberry32(mode === 'adaptive' ? 2026 : mode === 'fixed-hard' ? 2027 : 2028);
  const fixedDifficulty = mode === 'fixed-hard' ? 0.98 : 0.02;
  const cur = new AdversarialCurriculum({ rng, knownTaskTypes: [TASK_TYPE], initialDifficulty: 0.5 });
  let skill = 0.2;
  let tasksUsed = 0;
  let tasksToSkill10 = -1;
  const skillTrail = [skill];
  for (let b = 0; b < batches; b += 1) {
    const tasks = mode === 'adaptive' ? cur.generate(batchSize) : Array.from({ length: batchSize }, () => ({ complexity: fixedDifficulty }));
    const outcomes = [];
    for (const task of tasks) {
      const p = sigmoid(6 * (skill - task.complexity));
      // 59.0 增益定律：学习只发生在能力边缘 g = 4p(1−p)
      skill += 0.012 * 4 * p * (1 - p);
      outcomes.push(rng() < p);
      tasksUsed += 1;
      if (tasksToSkill10 < 0 && skill >= 1.0) tasksToSkill10 = tasksUsed;
    }
    if (mode === 'adaptive') cur.recordOutcomes(outcomes);
    skillTrail.push(Number(skill.toFixed(4)));
  }
  return { skill, skillTrail, frontierGain: cur.report().frontierGain, report: cur.report(), tasksToSkill10, tasksUsed };
};
const adaptive = runLearner('adaptive');
const fixedHard = runLearner('fixed-hard');
const fixedLow = runLearner('fixed-low');
ok(
  adaptive.skill > fixedLow.skill + 0.25 &&
    fixedLow.skill > fixedHard.skill + 0.2 &&
    adaptive.tasksToSkill10 > 0 &&
    (fixedHard.tasksToSkill10 < 0 || adaptive.tasksToSkill10 < fixedHard.tasksToSkill10) &&
    adaptive.report.difficultyTrail[adaptive.report.difficultyTrail.length - 1] >= 0.9 &&
    adaptive.report.hardened >= 5,
  'S1.5 学习曲线：自适应课程技能成长全面胜过固定难度（太难/太易两端皆劣）',
  `40 批 × 6 任务后技能：自适应 ${adaptive.skill.toFixed(2)}（难度 ${adaptive.report.difficultyTrail[0].toFixed(2)} → ${adaptive.report.difficultyTrail.at(-1).toFixed(2)}，加难 ${adaptive.report.hardened} 次）> 固定易 ${fixedLow.skill.toFixed(2)} > 固定难 ${fixedHard.skill.toFixed(2)}；技能达 1.0 所需任务数：自适应 ${adaptive.tasksToSkill10} vs 固定难 ${fixedHard.tasksToSkill10 < 0 ? '未达到' : fixedHard.tasksToSkill10}`,
);

// ══════════════════════════ S2 证书门进化环（policy-evolver 升级） ══════════════════════════

section('S2 证书门进化环：沙盒 → 88.0 OPE → 89.0 LCB 证书 → 金丝雀 → 回滚/吊销');

// 生产轨迹世界（88.0 反事实估值的素材）：3 动作，行为策略 μ = 均匀
// 动作 0 = 激进成本（生产历史中从未兑现收益），1 = 集成融合（真实高回报），2 = 常规单模（中回报）
const ACTION_BASE = [-0.5, 1.0, 0.4];
const EPISODES = Array.from({ length: 400 }, (_, i) => {
  const s = i % 7;
  const a = i % 3;
  return { states: [s, s + 1], actions: [a], rewards: [ACTION_BASE[a] + 0.01 * s] };
});
const EPS_MIX = 0.15;
const mixed = (anchor) => Array.from({ length: 3 }, (_, a) => (a === anchor ? 1 : 0) * (1 - EPS_MIX) + EPS_MIX / 3);
const encodePolicy = (params) => {
  const anchor = params.costWeight >= 0.5 ? 0 : params.ensembleEnabled ? 1 : 2;
  const probs = mixed(anchor);
  return { numActions: 3, prob: (_s, a) => probs[a] };
};
const BEHAVIOR_PI = { numActions: 3, prob: () => 1 / 3 };
const GATE = { episodes: EPISODES, encode: encodePolicy, behavior: BEHAVIOR_PI, baseline: encodePolicy(BASELINE_POLICY_PARAMS) };

// 「表面分高」候选：集成开关开启（沙盒因 top-2 集成融合真实增益而高分），
// 但 costWeight=0.8 → 编码到动作 0（激进成本）——生产轨迹反事实估值差
const surfacePolicy = {
  ...baseline,
  id: 'policy-surface-high',
  params: { ...BASELINE_POLICY_PARAMS, ensembleEnabled: true, ensembleScoreGap: 0.05, ensembleMaxModels: 2, costWeight: 0.8 },
};
// 真改进候选：集成开启 + costWeight 0.2（编码到动作 1——生产轨迹高回报）
const truePolicy = {
  ...baseline,
  id: 'policy-true-improve',
  params: { ...BASELINE_POLICY_PARAMS, ensembleEnabled: true, ensembleScoreGap: 0.05, ensembleMaxModels: 2 },
};
// 漂移候选：同样四门全过，但上线后生产表现漂移劣化（触发回滚 + 吊销）
const driftPolicy = {
  ...baseline,
  id: 'policy-post-deploy-drift',
  params: { ...BASELINE_POLICY_PARAMS, ensembleEnabled: true, ensembleScoreGap: 0.05, ensembleMaxModels: 2, costWeight: 0.3 },
};

const gateSandbox = buildSandbox(2026);

// S2.1 表面分高但离线估值差 → OPE 门拦截
const certEvolver = new PolicyEvolver({ rng: mulberry32(88), minGain: 0.0005 }, baseline);
const surfaceDecision = await certEvolver.certifyPolicy(surfacePolicy, gateSandbox, GATE);
ok(
  surfaceDecision.verdict === 'blocked-ope' &&
    (surfaceDecision.sandboxGainLCB ?? -1) > 0 &&
    (surfaceDecision.opeLower ?? 0) <= 0 &&
    certEvolver.getCurrentPolicy().id === baseline.id,
  'S2.1 表面分高但离线估值差：沙盒 gainLCB 为正仍被 88.0 OPE 门拦截（不上线）',
  `沙盒 gain=+${surfaceDecision.sandboxGain.toFixed(4)}（LCB +${(surfaceDecision.sandboxGainLCB ?? 0).toFixed(4)}），但生产轨迹反事实 DR=${surfaceDecision.opeDrEstimate?.toFixed(4)}（EB 下界 ${surfaceDecision.opeLower?.toFixed(4)} ≤ 0）→ ${surfaceDecision.verdict}；当前策略保持 ${certEvolver.getCurrentPolicy().id}`,
);

// S2.2 真改进：四门全过 → 部署金丝雀 → 晋升正式
const trueDecision = await certEvolver.certifyPolicy(truePolicy, gateSandbox, GATE);
for (let i = 0; i < 15; i += 1) certEvolver.reportOperationalOutcome({ success: true, quality: 0.9 });
const afterPromote = certEvolver.getStatus();
ok(
  trueDecision.verdict === 'deployed' &&
    (trueDecision.opeLower ?? 0) > 0 &&
    (trueDecision.certificateLCB ?? 0) > 0 &&
    (trueDecision.certificateSamples ?? 0) >= 30 &&
    afterPromote.currentPolicy.id === truePolicy.id &&
    afterPromote.canary?.status === 'promoted',
  'S2.2 真改进全流程放行：沙盒 + OPE（DR 下界为正）+ 89.0 证书（Δ̂ LCB > 0）+ 金丝雀晋升',
  `四门读数：沙盒 LCB +${(trueDecision.sandboxGainLCB ?? 0).toFixed(4)}；OPE DR ${trueDecision.opeDrEstimate?.toFixed(4)}（下界 ${trueDecision.opeLower?.toFixed(4)}）；证书 Δ̂ +${trueDecision.certificateDelta?.toFixed(4)}（LCB +${trueDecision.certificateLCB?.toFixed(4)}，n=${trueDecision.certificateSamples}）→ 部署后 15 个良性样本晋升正式（${afterPromote.canary?.reason?.slice(0, 42)}…）`,
);

// S2.3 观察窗漂移 → 自动回滚 + 证书吊销 → 同 id 复证被拒
// （独立进化器：漂移候选须相对基准有沙盒收益才能走完四门上线）
const driftEvolver = new PolicyEvolver({ rng: mulberry32(89), minGain: 0.0005 }, baseline);
const driftDecision = await driftEvolver.certifyPolicy(driftPolicy, gateSandbox, GATE);
for (let i = 0; i < 5; i += 1) driftEvolver.reportOperationalOutcome({ success: false, quality: 0.05 });
const afterRollback = driftEvolver.getStatus();
const reCertify = await driftEvolver.certifyPolicy(driftPolicy, gateSandbox, GATE);
ok(
  driftDecision.verdict === 'deployed' &&
    afterRollback.canary?.status === 'rolled-back' &&
    afterRollback.currentPolicy.id === baseline.id &&
    driftEvolver.getRevokedCertificates().includes(driftPolicy.id) &&
    reCertify.verdict === 'revoked',
  'S2.3 观察窗漂移：自动回滚前一策略 + 证书吊销（同 id 不再凭同一批证据复证）',
  `${driftPolicy.id} 四门全过上线（证书 Δ̂ +${driftDecision.certificateDelta?.toFixed(3)}）→ 5 个失败样本触发 Wilson 劣化确认 → 回滚至 ${afterRollback.currentPolicy.id}，证书吊销名单 [${driftEvolver.getRevokedCertificates().join(', ')}]；复证裁决=${reCertify.verdict}（${reCertify.reason.slice(0, 38)}…）`,
);

// S2.4 证书门进化周期端到端（变异 → 沙盒 → 离线双门 → 部署）
const ringDeployments = [];
const ringEvolver = new PolicyEvolver(
  {
    candidateCount: 6,
    minGain: 0.0005,
    mutationRate: 0.7,
    booleanFlipRate: 0.35,
    rng: mulberry32(1234567),
    onDeploy: (p) => ringDeployments.push(p.id),
  },
  baseline,
);
let ringReport = null;
let ringCycles = 0;
for (let i = 0; i < 8 && !ringReport; i += 1) {
  const cycle = await ringEvolver.runCertificateGatedCycle(buildSandbox(31 + i), GATE);
  ringCycles += 1;
  if (cycle.gate.decision) ringReport = cycle;
}
const ledger = ringEvolver.getCertificateLedger();
const deployedDecisions = ledger.filter((d) => d.verdict === 'deployed');
ok(
  ringReport !== null &&
    ringReport.gate.evaluated === 6 &&
    deployedDecisions.length >= 1 &&
    deployedDecisions.every((d) => (d.opeLower ?? 0) > 0 && (d.certificateLCB ?? 0) > 0) &&
    ringDeployments.length >= 1 &&
    ringEvolver.getStatus().certificate.decisions === ledger.length,
  'S2.4 证书门进化周期端到端：生成候选 → 沙盒排序 → 离线双门 → 胜出部署（每个上线决策都有 OPE+证书读数）',
  `${ringCycles} 轮周期后首个部署：${ringReport.gate.decision.policyId}（沙盒 LCB +${(ringReport.gate.decision.sandboxGainLCB ?? 0).toFixed(4)}，OPE DR ${ringReport.gate.decision.opeDrEstimate?.toFixed(4)}，证书 LCB +${(ringReport.gate.decision.certificateLCB ?? 0).toFixed(4)}）；台账 ${ledger.length} 条决策（拦截 ${ledger.filter((d) => d.verdict.startsWith('blocked')).length}，部署 ${deployedDecisions.length}）`,
);

// S2.5 证书台账与吊销名单跨重启持久化（重启后同 id 复证仍被拒，且不烧沙盒算力）
const certPersistPath = path.join(os.tmpdir(), `dsh-verify-mod-cert-${process.pid}.json`);
fs.rmSync(certPersistPath, { force: true });
const persistDriftPolicy = {
  ...baseline,
  id: 'policy-drift-persist',
  params: { ...BASELINE_POLICY_PARAMS, ensembleEnabled: true, ensembleScoreGap: 0.05, ensembleMaxModels: 2, costWeight: 0.3 },
};
const persistEvolver = new PolicyEvolver({ rng: mulberry32(90), minGain: 0.0005, persistPath: certPersistPath }, baseline);
const persistDecision = await persistEvolver.certifyPolicy(persistDriftPolicy, gateSandbox, GATE);
for (let i = 0; i < 5; i += 1) persistEvolver.reportOperationalOutcome({ success: false, quality: 0.05 });
const restoredEvolver = new PolicyEvolver({ rng: mulberry32(91), minGain: 0.0005, persistPath: certPersistPath }, baseline);
const restoredCert = restoredEvolver.getStatus().certificate;
const restoredEvaluated = restoredEvolver.getStatus().totalCandidatesEvaluated;
const restoredReCertify = await restoredEvolver.certifyPolicy(persistDriftPolicy, gateSandbox, GATE);
ok(
  persistDecision.verdict === 'deployed' &&
    restoredEvolver.getCurrentPolicy().id === baseline.id &&
    restoredCert.revoked.includes(persistDriftPolicy.id) &&
    restoredCert.decisions === 2 &&
    restoredReCertify.verdict === 'revoked' &&
    restoredEvolver.getStatus().totalCandidatesEvaluated === restoredEvaluated,
  'S2.5 证书台账与吊销名单跨重启持久化：重启后吊销仍生效（同 id 复证直接拒绝，不再烧沙盒算力）',
  `原进化器 ${persistDecision.verdict} → 漂移回滚吊销并落盘；重启恢复后台账 ${restoredCert.decisions} 条决策（部署 1 + 吊销 1）、吊销名单 [${restoredCert.revoked.join(', ')}]，复证裁决=${restoredReCertify.verdict}（吊销检查先于沙盒评估，totalCandidatesEvaluated 保持 ${restoredEvolver.getStatus().totalCandidatesEvaluated}）`,
);
fs.rmSync(certPersistPath, { force: true });

// ══════════════════════════ S3 进化谱系追踪（strategy-evolution 升级） ══════════════════════════

section('S3 进化谱系追踪：三代进化的版本树 + 谱系回溯查询');

const lineageEngine = new StrategyEvolutionEngine({ rng: mulberry32(11) });
const newestGenome = () =>
  [...lineageEngine.getReport().genomes].sort((a, b) => b.generation - a.generation || b.id.localeCompare(a.id))[0];
for (let gen = 0; gen < 3; gen += 1) {
  const target = newestGenome();
  for (let i = 0; i < 8; i += 1) lineageEngine.recordOutcome(target.id, 'excellent');
  const others = lineageEngine.getReport().genomes.filter((g) => g.id !== target.id);
  for (const other of others) lineageEngine.recordOutcome(other.id, 'poor');
  lineageEngine.evolve(true);
}
const tree = lineageEngine.lineageReport();
const newestNode = tree.nodes.filter((n) => n.alive).sort((a, b) => b.generation - a.generation)[0];
const chain = lineageEngine.lineageOf(newestNode.id);
const seedDescendants = tree.roots.reduce((sum, root) => sum + lineageEngine.descendantsOf(root).length, 0);
const generationsNonDecreasing = chain.every((n, i) => i === 0 || n.generation >= chain[i - 1].generation);
const coversThreeGenerations = [1, 2, 3].every((g) => chain.some((n) => n.generation === g));
const linkedChain = chain.every((n, i) => i === 0 || chain[i - 1].id === n.parentId);
const eliminatedByEvolution = tree.nodes.filter((n) => !n.alive && n.eliminatedAtGeneration !== undefined);
const deployedMark = lineageEngine.markDeployed();
ok(
  lineageEngine.getEvolutionHistory().length === 3 &&
    tree.size >= 11 + 3 &&
    chain.length >= 4 &&
    generationsNonDecreasing &&
    coversThreeGenerations &&
    chain.at(-1).generation === 3 &&
    linkedChain &&
    newestNode.operator !== 'seed' &&
    seedDescendants >= 3 &&
    tree.nodes.some((n) => n.generation === 3 && n.parentId !== undefined) &&
    eliminatedByEvolution.length >= 1 &&
    deployedMark?.deployedAt !== undefined &&
    lineageEngine.lineageReport().deployed === 1,
  'S3 三代进化谱系树正确：出生登记（父代/算子）→ 链路衔接 → 淘汰留痕 → 上线标记',
  `3 代后版本树 ${tree.size} 节点（根 ${tree.roots.length}，存活 ${tree.alive}，进化淘汰 ${eliminatedByEvolution.length}，深度 ${tree.depth}）；最深个体 ${newestNode.id}（算子 ${newestNode.operator}，第 3 代）祖先链 ${chain.map((n) => `${n.id}(g${n.generation})`).join(' → ')}——链覆盖 g0→g1→g2→g3 且逐级父子衔接；根的后代共 ${seedDescendants} 个；markDeployed → ${deployedMark?.id} 上线于 ${Boolean(deployedMark?.deployedAt)}`,
);

const rootSample = tree.roots[0];
const desc = lineageEngine.descendantsOf(rootSample);
ok(
  desc.every((n) => lineageEngine.lineageOf(n.id).some((a) => a.id === rootSample)) &&
    lineageEngine.descendantsOf('genome-nonexistent').length === 0 &&
    lineageEngine.lineageOf(newestNode.id)[0].parentId === undefined,
  'S3 谱系回溯查询：descendantsOf 子树全部回溯到根；不存在 id / 根节点边界行为正确',
  `${rootSample} 的子树 ${desc.length} 节点全部经 lineageOf 回溯命中根；不存在 id 返回空链；最深链首节点为根（无父代）`,
);

// ══════════════════════════ S4 变异算子组合治理（strategy-evolution 升级） ══════════════════════════

section('S4 变异算子组合治理：成功率加权 + softmax 温度选择');

// 算子劣化景观：基因贴近中心（normalized ≈ 0.45）好；≥2 个基因进入极端区（<0.12 或 >0.88）重罚
const landscapeOperators = (genes) => {
  const n = normGenes(genes);
  const extremes = n.filter((v) => v < 0.12 || v > 0.88).length;
  if (extremes >= 2) return 0.05;
  const centered = n.reduce((s, v) => s + Math.abs(v - 0.45), 0) / n.length;
  return 0.92 - 0.55 * centered;
};
const outcomeFor = (reward) => (reward >= 0.85 ? 'excellent' : reward >= 0.75 ? 'good' : reward >= 0.5 ? 'acceptable' : reward >= 0.25 ? 'poor' : 'failed');
/** 连续值喂食：在相邻两档 outcome 间按比例分配 n 次反馈，meanReward ≈ value（粒度 ~0.02，避免桶量化并列） */
const OUTCOME_LEVELS = [[1, 'excellent'], [0.8, 'good'], [0.6, 'acceptable'], [0.3, 'poor'], [0, 'failed']];
const feedValue = (engine, id, value, n = 10) => {
  const v = Math.max(0, Math.min(1, value));
  let hi = OUTCOME_LEVELS[0];
  let lo = OUTCOME_LEVELS[OUTCOME_LEVELS.length - 1];
  for (let i = 0; i < OUTCOME_LEVELS.length - 1; i += 1) {
    if (v <= OUTCOME_LEVELS[i][0] && v >= OUTCOME_LEVELS[i + 1][0]) {
      hi = OUTCOME_LEVELS[i];
      lo = OUTCOME_LEVELS[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0];
  const kHi = span > 0 ? Math.round(((v - lo[0]) / span) * n) : n;
  for (let i = 0; i < kHi; i += 1) engine.recordOutcome(id, hi[1]);
  for (let i = kHi; i < n; i += 1) engine.recordOutcome(id, lo[1]);
};

const govEngine = new StrategyEvolutionEngine({
  rng: mulberry32(31),
  operatorGovernance: { temperature: 0.15, learningRate: 0.3 },
  populationSize: 10,
  eliteCount: 1,
  minApplicationsBetweenEvolutions: 10,
});
// 「旧口径」对照：温度极大 → softmax 退化为均匀随机选算子（无信用学习的组合）
const uniformEngine = new StrategyEvolutionEngine({
  rng: mulberry32(31),
  operatorGovernance: { temperature: 100, learningRate: 0.3 },
  populationSize: 10,
  eliteCount: 1,
  minApplicationsBetweenEvolutions: 10,
});
const driveGoverned = (engine) => {
  let wastedFeedback = 0; // 喂给劣化后代（景观值 < 0.5）的真实决策反馈数——被浪费的进化预算
  const trail = [];
  for (let gen = 0; gen < 16; gen += 1) {
    for (const g of engine.getReport().genomes) {
      const v = landscapeOperators(g.genes);
      if (v < 0.5) wastedFeedback += 10;
      feedValue(engine, g.id, v, 10);
    }
    engine.evolve(true);
    trail.push(engine.operatorStats().reduce((acc, s) => ({ ...acc, [s.name]: s.selections }), {}));
  }
  return { trail, wastedFeedback };
};
const govRun = driveGoverned(govEngine);
const uniformRun = driveGoverned(uniformEngine);
const selectionsTrail = govRun.trail;
const finalStats = govEngine.operatorStats();
const statOf = (name) => finalStats.find((s) => s.name === name);
const uniformStats = uniformEngine.operatorStats();
const uniformStatOf = (name) => uniformStats.find((s) => s.name === name);
const totalSel = finalStats.reduce((s, x) => s + x.selections, 0);
const midStats = selectionsTrail[7];
const midTotal = Object.values(midStats).reduce((s, v) => s + v, 0);
const midBoundaryShare = (midStats['boundary'] ?? 0) / midTotal;
const endBoundaryShare = (statOf('boundary').selections - (midStats['boundary'] ?? 0)) / (totalSel - midTotal);
ok(
  finalStats.length === 4 &&
    Math.abs(finalStats.reduce((s, x) => s + x.probability, 0) - 1) < 5e-3 &&
    statOf('boundary').ewma < 0.25 &&
    statOf('gaussian').ewma > statOf('boundary').ewma + 0.2 &&
    statOf('boundary').probability < 0.15 &&
    statOf('gaussian').probability > statOf('boundary').probability * 3 &&
    endBoundaryShare < midBoundaryShare,
  'S4 某算子持续劣化：信用 EWMA 下降 → softmax 权重下降 → 选择转移到有效算子',
  `boundary EWMA 0.5 → ${statOf('boundary').ewma.toFixed(3)}（vs gaussian ${statOf('gaussian').ewma.toFixed(3)}）；softmax 权重 boundary ${statOf('boundary').probability.toFixed(3)} vs gaussian ${statOf('gaussian').probability.toFixed(3)}；boundary 选择占比（前半 ${(midBoundaryShare * 100).toFixed(1)}% → 后半 ${(endBoundaryShare * 100).toFixed(1)}%）——治理把试验预算转移到近期有效的算子`,
);
ok(
  govRun.wastedFeedback < uniformRun.wastedFeedback * 0.5 &&
    statOf('boundary').selections < uniformStatOf('boundary').selections &&
    uniformStatOf('boundary').probability > 0.15,
  'S4 信用治理对照（新 vs 旧）：劣化算子后代的反馈预算浪费减半以上（均匀乱选持续烧样本）',
  `同景观 16 代：治理引擎浪费在劣化后代上的真实反馈 ${govRun.wastedFeedback} 条 vs 均匀选算子（τ=100，boundary 权重保持 ${uniformStatOf('boundary').probability.toFixed(2)}）${uniformRun.wastedFeedback} 条；boundary 累计被选 ${statOf('boundary').selections} 次（治理）vs ${uniformStatOf('boundary').selections} 次（均匀）——信用机制把试验预算持续转移到有效算子`,
);

// ══════════════════════════ S5 进化预算与停滞检测（strategy-evolution 升级） ══════════════════════════

section('S5 进化预算记账 + 停滞检测重启多样化');

// S5.1 预算：逐代消耗记账 + 耗尽拒开新代
const budgetEngine = new StrategyEvolutionEngine({
  rng: mulberry32(5),
  evolutionBudget: 40,
  minApplicationsBetweenEvolutions: 10,
});
let completed = 0;
let refused = 0;
for (let round = 0; round < 12; round += 1) {
  for (const g of budgetEngine.getReport().genomes) budgetEngine.recordOutcome(g.id, 'good');
  const r = budgetEngine.evolve();
  if (r) completed += 1;
  else refused += 1;
}
const budget = budgetEngine.evolutionBudgetReport();
const ledgerSum = budget.ledger.filter((e) => !e.refused).reduce((s, e) => s + e.cost, 0);
ok(
  completed >= 2 &&
    refused >= 1 &&
    budget.exhausted &&
    budget.spent === ledgerSum &&
    budget.spent <= 40 &&
    budget.ledger.at(-1).refused &&
    budget.ledger.filter((e) => !e.refused).every((e) => e.cost >= 10),
  'S5.1 进化预算记账：每代消耗 = 决策反馈数 + 变异后代数，累计达上限后拒开新代',
  `预算 40：完成 ${completed} 代（消耗 ${budget.ledger.filter((e) => !e.refused).map((e) => e.cost).join('+')} = ${budget.spent}），第 ${completed + 1} 代起拒开（refused ${refused} 次）；台账逐代收支对账一致，末条为拒绝记录`,
);

// S5.2 停滞重启：平台景观下 旧（无重启）vs 新（重启注入）对照
const BASELINE_N = normGenes({ suppressionWindowMs: 300_000, failureEscalationThreshold: 3, lowConfidenceThreshold: 0.4, costDeferRatio: 3, burstOccurrences: 5 });
const landscapePlateau = (genes) => {
  const n = normGenes(genes);
  const corner = n.filter((v) => v > 0.8).length;
  if (corner >= 3) return 0.95; // 远处全局优（基线邻域的高斯微调够不着，重启注入的极值候选够得着）
  const dist = Math.sqrt(n.reduce((s, v, i) => s + (v - BASELINE_N[i]) ** 2, 0));
  return dist < 0.35 ? 0.6 : 0.35; // 局部平台（基线邻域）与谷底
};
const drivePlateau = (stagnation, seed) => {
  const engine = new StrategyEvolutionEngine({
    rng: mulberry32(seed),
    ...(stagnation ? { stagnation } : {}),
    minApplicationsBetweenEvolutions: 10,
  });
  let best = 0;
  for (let gen = 0; gen < 18; gen += 1) {
    for (const g of engine.getReport().genomes) {
      const outcome = outcomeFor(landscapePlateau(g.genes));
      for (let i = 0; i < 4; i += 1) engine.recordOutcome(g.id, outcome);
    }
    const report = engine.evolve(true);
    if (report) best = Math.max(best, report.bestMeanReward);
  }
  return { engine, best };
};
const restarted = drivePlateau({ patience: 3, minImprovement: 0.02, injectCount: 2, minGenerations: 2, candidatePool: 24 }, 77);
const legacy = drivePlateau(null, 77);
const restartEvents = restarted.engine.stagnationRestartEvents();
const injectedNodes = restartEvents.flatMap((e) => e.injected).map((id) => restarted.engine.lineageOf(id)[0]);
ok(
  restartEvents.length >= 1 &&
    restartEvents[0].injected.length >= 1 &&
    restartEvents[0].minSquaredDistance > 0.1 &&
    injectedNodes.every((n) => n.operator === 'restart-diversify' && n.parentId === undefined) &&
    restarted.best > legacy.best + 0.15 &&
    legacy.best <= 0.75,
  'S5.2 停滞重启突破局部平台：N 代无进展 → 注入行为距离大的新根个体 → 找到远处全局优（旧引擎困在平台）',
  `同一平台景观 18 代：新（重启）最优 meanReward ${restarted.best.toFixed(2)} vs 旧（无重启）${legacy.best.toFixed(2)}；重启 ${restartEvents.length} 次（注入 ${restartEvents.reduce((s, e) => s + e.injected.length, 0)} 个新根个体，最小归一化距离² ${restartEvents[0].minSquaredDistance.toFixed(2)}，算子 restart-diversify、谱系无父代）——91.0 新奇思想：行为距离优先于适应度`,
);

// ══════════════════════════ S6 零漂移兼容 ══════════════════════════

section('S6 零漂移兼容：默认路径行为与报告结构不变');

const compatEngine = new StrategyEvolutionEngine({ rng: mulberry32(99) });
for (let round = 0; round < 4; round += 1) {
  for (let i = 0; i < 14; i += 1) compatEngine.recordOutcome(compatEngine.selectGenome().id, i % 3 === 0 ? 'excellent' : 'good');
  compatEngine.evolve(true);
}
const compatReport = compatEngine.getReport();
const firstHistory = compatEngine.getReport().genomes[0];
ok(
  compatReport.populationMeanReward > 0.5 &&
    compatReport.recentEvolutions.length >= 1 &&
    compatReport.operators === undefined &&
    compatReport.budget === undefined &&
    compatReport.restarts === undefined &&
    typeof compatReport.lineage?.size === 'number' &&
    compatEngine.getEvolutionHistory().every((r) => (r.restarts ?? []).length === 0) &&
    firstHistory.genes.suppressionWindowMs >= 30_000 &&
    policyParamsWithinBounds(BASELINE_POLICY_PARAMS),
  'S6 默认引擎零漂移：治理/停滞/预算未挂载时不介入（报告字段为空、进化正常爬升）',
  `默认配置 4 代后种群平均收益 ${compatReport.populationMeanReward.toFixed(3)}（进化正常）；operators/budget/restarts 均 undefined（旁路未激活）；谱系纯记账（${compatReport.lineage?.size} 节点）不影响进化路径`,
);

// ══════════════════════════ S7 attach* 挂载面：构造后挂载与 config 等效 ══════════════════════════

section('S7 attach* 挂载面：治理/停滞/预算构造后挂载即生效（与 config 路径等效）');

const attachEngine = new StrategyEvolutionEngine({ rng: mulberry32(21) });
const bareStats = attachEngine.operatorStats(); // 未挂载：旁路关闭（零漂移）
attachEngine.attachOperatorGovernance({ temperature: 0.2, learningRate: 0.3 });
attachEngine.attachStagnationRestart({ patience: 2, injectCount: 1 });
attachEngine.attachEvolutionBudget(150);
// 4 代正常喂养（适应度爬升）+ 4 代断粮进化（适应度平台 → 停滞重启应触发）
for (let round = 0; round < 4; round += 1) {
  for (const g of attachEngine.getReport().genomes) for (let i = 0; i < 4; i += 1) attachEngine.recordOutcome(g.id, 'good');
  attachEngine.evolve(true);
}
for (let round = 0; round < 4; round += 1) attachEngine.evolve(true);
const attachReport = attachEngine.getReport();
const attachOps = attachReport.operators ?? [];
const attachBudget = attachReport.budget;
const attachRestarts = attachReport.restarts ?? [];
const budgetLedgerSum = (attachBudget?.ledger ?? []).filter((e) => !e.refused).reduce((s, e) => s + e.cost, 0);
ok(
  bareStats.length === 0 &&
    attachOps.length === 4 &&
    attachRestarts.length >= 1 &&
    attachBudget?.cap === 150 &&
    attachBudget?.spent === budgetLedgerSum &&
    !attachBudget?.exhausted,
  'S7 attach* 后挂载面：治理/停滞/预算构造后挂载即生效（与 config 路径等效）',
  `挂载前 operatorStats()=${bareStats.length} 项（旁路关闭）；attachOperatorGovernance/attachStagnationRestart/attachEvolutionBudget(150) 后 8 代：算子 ${attachOps.length} 个、停滞重启 ${attachRestarts.length} 次（断粮代适应度平台触发 patience=2）、预算记账 ${attachBudget?.spent}/${attachBudget?.cap}（台账收支对账一致，未耗尽）`,
);
near(
  attachOps.reduce((s, o) => s + o.probability, 0),
  1,
  5e-3,
  'S7 softmax 选择权重归一（attachOperatorGovernance 各算子独立统计）',
  `四算子权重 [${attachOps.map((o) => `${o.name}:${o.probability}`).join(', ')}]（Σ=1，温度 0.2）`,
);

// ══════════════════════════ 结果输出 ══════════════════════════

console.log('\n=== 第三轮「进化模块域」升级验证结果 ===');
for (const r of results) {
  if (!r.pass) console.log(`FAIL  ${r.label}\n      ${r.detail}`);
}
console.log(`\nPASS ${passed} / FAIL ${failed}`);
if (failed > 0) {
  console.log('\n✗ 存在未通过的断言，请检查。');
  process.exit(1);
}
console.log('\n✓ 进化模块域五项升级全部通过：对抗课程（难度自适应 + 边界案例挖掘）× 证书门进化环（OPE→LCB 证书→金丝雀→吊销）× 进化谱系树（回溯查询）× 变异算子组合治理（softmax 权重转移）× 预算/停滞重启（平台突破）——进化器从「黑箱爬山」升级为「可审计、有证书、有预算意识的受治理进化」。');
process.exit(0);
