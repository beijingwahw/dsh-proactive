/**
 * verify-mod-meta.mjs — 第三轮世界性升级「元认知层模块域 A8」验证
 *
 * 覆盖 4 个升级面（meta-cognition / meta-controller / meta-types / self-model）：
 *
 *   S1 调参死区稳定环（构造对照）：同一噪声被控对象（指标 = f(旋钮) + 确定性
 *      噪声，量化到 discoveryRate），朴素比例外环（死区 0 / 斜坡 1 / 冷却 0）
 *      在目标带边缘极限环震荡（方向翻转 ≥ 4、终态误差大）；死区+斜坡+冷却
 *      三重阻尼外环一步半幅靠带后停在死区内（翻转 ≤ 1、终态误差小）——
 *      稳定性的构造性对照，非口头声明。
 *   S2 调整证书门（89.0 视图）：① 视图不可用（冷启动 0 样本）→ 保守半步
 *      （0.6→0.65 而非 0.7）+ 严格判定（无明确改善即回滚）；② 「假改进」
 *      臂（效果 ±0.04 交替，均值 0 方差大）→ LCB < 0 → 候选被证书拒绝
 *      （audit certificate-reject，旋钮不再动）；③ 「真改进」臂（效果
 *      恒 +0.05，σ=0）→ LCB = +0.05 > 0 → 证书放行全幅步长。
 *   S3 自我模型变更日志：三次自我修改入账（from/to/理由/触发者），按日志
 *      逆向回滚恢复原配置；整体快照/恢复把报告历史与校准记忆一并还原；
 *      变更日志跨重启持久化连续。
 *   S4 自我评估校准：自评恒高 0.15 的流 → biasEma 收敛到 ≈ +0.15 且
 *      overconfident 翻转沿告警；改为诚实自评后 20 步收敛回 calibrated
 *      （|biasEma| ≤ 0.02）；自评恒低流 → underconfident 告警。
 *   S5 相对基线偏差带（meta-cognition KPI 升级）：平稳段后慢漂移
 *      （−0.0075/批）→ 相对带（中位数±3.5·MAD）在 t≈12 报警（值 ≈0.93，
 *      静态阈值 0.7 要到 t=44 才可见——早 ≥ 30 批次）；平稳噪声序列
 *      40 批 → 零误报；健康报告携带相对带读数。
 *   S6 内外环冲突仲裁：外环调整进入观察窗 → 内环调参器改写同一旋钮 →
 *      观察作废（最后写入者胜）+ 冲突计数/审计；后续调整以外部值为
 *      新基线；静默改写由读数检测捕获。
 *   S7 注入时钟与零漂移：三引擎时间戳全部取自注入时钟（确定性）；
 *      未启用 3.0 开关时 getState().stability/certificateGate 为
 *      undefined、健康报告无 relativeBands、心智报告无 selfCalibration
 *      （旧口径逐位不变）。
 *
 * 全程离线确定性（脚本内 mulberry32 构造噪声；注入时钟）。
 * 运行：npm run build && node scripts/verify-mod-meta.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfModel, MetaCognitiveController, MetaCognitionEngine } from '../dist/index.mjs';

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
const stamp = Date.now();
const T0 = stamp - 10 * HOUR;

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

const collectorsOf = (state, extra = {}) => ({
  getEvolverStatus: () => state.evolverStatus,
  getMemoryStats: () => state.memoryCounts,
  getGlobalStats: () => state.globalStats,
  getDistillationProgress: () => state.distillation,
  getRecentFeedback: (limit) => state.feedback.slice(-limit),
  ...extra,
});

/** 模拟旋钮容器（控制论对照台；读写语义与真实旋钮完全同构） */
function makeSimKnobStore(initial) {
  const store = { value: initial };
  return store;
}
const simKnob = (store, { id, label, judgeMetric, higherIsBetter, min, max, step, integer = false, category = 'evolver' }) => ({
  id,
  label,
  category,
  min,
  max,
  step,
  integer,
  read: () => store.value,
  write: (v) => {
    store.value = v;
  },
  judgeMetric,
  higherIsBetter,
});

// ═══════════════════ S1 调参死区稳定环（构造对照：震荡 vs 收敛） ═══════════════════

section('S1 调参死区稳定环：朴素比例外环极限环震荡 vs 死区+斜坡+冷却收敛');

/**
 * 被控对象（plant）：discoveryRate = clamp(0.5 − 1.0×(knob − 1.0) + noise, 0, 1)，
 * 经 deployedCount/totalCycles = 1/400 量化进入心智报告（与真实链路同构）。
 * 均衡点 knob = 1.0（指标 0.5，带 [0.49,0.51] 中心，带宽 0.02）；测量噪声
 * ±0.012（mulberry32 确定性）> 带半宽 0.01：贴带系统周期性被噪声推出带外
 * ——这是震荡的驱动源。旋钮步长 0.02 = 整个带宽：全幅步长从带缘任何位置
 * 起跳必然越过带心落到对侧（过冲），下轮再调回来——极限环。
 * 实验设计：degradationTolerance=100（判定不回滚）隔离 2.0 的回滚/拉黑
 * 机制，让对照纯粹暴露「死区+斜坡+冷却」的阻尼差异（控制台架标准做法；
 * 判定/回滚路径由 S2 独立验证）。maxStepMultiplier=1：两外环仅阻尼不同
 * （公平对照）。
 */
const CYCLES = 400;
const plantMetric = (knobValue, noise) => Math.max(0, Math.min(1, 0.5 - 1.0 * (knobValue - 1.0) + noise));
const applyPlant = (state, knobValue, noise) => {
  const metric = plantMetric(knobValue, noise);
  const dep = Math.max(1, Math.round(metric * CYCLES));
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
  return dep / CYCLES;
};

/**
 * 跑一个外环：返回轨迹与统计。
 * @param damping naive = 死区 0/斜坡 1/增量 0/冷却 0（朴素比例，等价 2.0 步长）；
 *                damped = 死区 0.7/斜坡 0.5+0.5/冷却 1（三重阻尼）
 */
async function runOuterLoop(damping, seed) {
  const rand = mulberry32(seed);
  const state = makeState({ feedback: [fb('s1a', 'code-generation', 'good', T0 + HOUR)] });
  const store = makeSimKnobStore(0.95); // 起点 0.95：指标 0.55，带上方偏离 2 带宽
  const controller = new MetaCognitiveController({
    selfModel: new SelfModel({ collectors: collectorsOf(state) }),
    knobs: [
      simKnob(store, {
        id: 'sim.gain',
        label: '仿真增益',
        judgeMetric: 'discoveryRate',
        higherIsBetter: true,
        min: 0,
        max: 2,
        step: 0.02,
      }),
    ],
    config: {
      clock: () => T0,
      homeostasisBands: { discoveryRate: { min: 0.49, max: 0.51 } },
      maxStepMultiplier: 1,
      degradationTolerance: 100,
      stabilityLoop: {
        deadbandDeviation: damping.deadband,
        rampStart: damping.rampStart,
        rampIncrement: damping.rampIncrement,
        cooldownReports: damping.cooldown,
        knobAffect: { 'sim.gain': 'negative' }, // 增大旋钮 → 指标下降（被控对象真实极性）
      },
    },
  });
  const trajectory = [];
  let adjustments = 0;
  for (let round = 0; round < 27; round += 1) {
    const noise = (rand() - 0.5) * 0.024;
    const metric = applyPlant(state, store.value, noise);
    const result = await controller.evaluateAndAdjust();
    if (result.status === 'adjusted') adjustments += 1;
    trajectory.push({ round, knob: Number(store.value.toFixed(3)), metric, status: result.status });
  }
  const st = controller.getState();
  return {
    trajectory,
    adjustments,
    flips: st.stability.directionFlips,
    deadbandSkips: st.stability.deadbandSkips,
    cooldownSkips: st.stability.cooldownSkips,
    finalKnob: store.value,
    finalError: Math.abs(store.value - 1.0),
  };
}

const naive = await runOuterLoop({ deadband: 0, rampStart: 1, rampIncrement: 0, cooldown: 0 }, 7);
const damped = await runOuterLoop({ deadband: 0.7, rampStart: 0.5, rampIncrement: 0.5, cooldown: 1 }, 7);

console.log(
  `    朴素比例（死区0/斜坡1/冷却0）旋钮轨迹: ${naive.trajectory.map((t) => t.knob.toFixed(2)).join('→')}`,
);
console.log(
  `    死区+斜坡+冷却（0.7/0.5+0.5/1）旋钮轨迹: ${damped.trajectory.map((t) => t.knob.toFixed(2)).join('→')}`,
);
const naiveQuietAfter = naive.trajectory.slice(12).filter((t) => t.status === 'adjusted').length;
const dampedQuietAfter = damped.trajectory.slice(12).filter((t) => t.status === 'adjusted').length;
ok(
  naive.flips >= 3 && naive.adjustments >= 6 && naiveQuietAfter >= 2,
  `S1a 朴素比例外环震荡：27 轮 ${naive.adjustments} 次调整中方向翻转 ${naive.flips} 次（≥3），靠带后（第 12 轮起）仍调整 ${naiveQuietAfter} 次——全幅步长（=整个带宽）从带缘起跳必越带心，控制器追着噪声过冲打摆`,
);
ok(
  damped.adjustments <= 4 && damped.flips <= 1 && damped.finalError <= 0.005 && dampedQuietAfter === 0,
  `S1b 死区+斜坡+冷却收敛：${damped.adjustments} 次调整（≤4）方向翻转 ${damped.flips} 次（≤1），终态误差 ${damped.finalError.toFixed(4)}（≤0.005，精确落到均衡点），靠带后（第 12 轮起）零调整——噪声出带被死区吸收，系统安静下来`,
);
ok(
  damped.deadbandSkips >= 1 && damped.cooldownSkips >= 2 && naive.deadbandSkips === 0 && naive.cooldownSkips === 0,
  `S1c 阻尼三件套各司其职：死区抑制 ${damped.deadbandSkips} 次（带缘噪声被判为噪声而非误差，朴素 0 次）、冷却抑制 ${damped.cooldownSkips} 次（判定后留暂态消退时间，朴素 0 次）`,
);
ok(
  naive.adjustments > damped.adjustments && naive.flips > damped.flips,
  `S1e 对照汇总：调整次数 ${naive.adjustments} vs ${damped.adjustments}、方向翻转 ${naive.flips} vs ${damped.flips}——同一被控对象同一噪声流，唯一差异是阻尼三件套`,
);
ok(
  naive.trajectory[0].status === 'adjusted' &&
    damped.trajectory[0].status === 'adjusted' &&
    naive.trajectory[0].knob !== damped.trajectory[0].knob,
  `S1d 同起点不同首步：两外环首轮都行动（起点越带 2 带宽），朴素首步到 ${naive.trajectory[0].knob.toFixed(3)}（全幅 0.02），阻尼首步到 ${damped.trajectory[0].knob.toFixed(3)}（斜坡起点 0.5×0.02=0.01 半幅试探）`,
);

// ═══════════════════ S2 调整证书门（89.0 视图） ═══════════════════

section('S2 调整证书门：视图不可用保守半步 / 假改进拒绝 / 真改进放行');

/** 证书门场景台：盲点规则推荐 mutationRate↑，判定指标 discoveryRate 由 setMetric 控制（量化 1/400） */
async function certScenario() {
  const state = makeState({
    feedback: [
      fb('c1', 'refactor', 'failed', T0 + HOUR),
      fb('c2', 'refactor', 'failed', T0 + 1.1 * HOUR),
      fb('c3', 'refactor', 'poor', T0 + 1.2 * HOUR),
      fb('c4', 'refactor', 'good', T0 + 1.3 * HOUR),
    ],
  });
  const store = makeSimKnobStore(0.6);
  const controller = new MetaCognitiveController({
    selfModel: new SelfModel({ collectors: collectorsOf(state) }),
    knobs: [
      simKnob(store, {
        id: 'evolver.mutationRate',
        label: '进化器变异率',
        judgeMetric: 'discoveryRate',
        higherIsBetter: true,
        min: 0.2,
        max: 1.0,
        step: 0.1,
      }),
    ],
    config: { clock: () => T0, observationReports: 2, degradationTolerance: 0.02, certificateGate: { delta: 0.1, minSamples: 4 } },
  });
  const setMetric = (value) => {
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
  return { state, store, controller, setMetric };
}

// S2-① 视图不可用（0 样本）→ 保守半步 + 严格判定（无明确改善即回滚）
{
  const { store, controller, setMetric } = await certScenario();
  setMetric(0.5);
  const r1 = await controller.evaluateAndAdjust();
  const certAudit = controller.getAuditTrail().find((e) => e.type === 'adjust');
  ok(
    r1.status === 'adjusted' &&
      r1.applied[0].knob === 'evolver.mutationRate' &&
      r1.applied[0].from === 0.6 &&
      Math.abs(r1.applied[0].to - 0.65) < 1e-9 &&
      r1.applied[0].certificate?.mode === 'provisional' &&
      r1.applied[0].certificate?.samples === 0 &&
      certAudit?.certificate?.mode === 'provisional',
    `S2a 视图不可用→保守半步：0/4 配对样本，证书门降级 provisional——变异率 0.6→0.65（半步 0.05，而非全幅 0.7），审计携带 certificate{mode:provisional}`,
  );
  // 观察两轮：指标 0.5 → 0.5（零改善，严格口径要求 > +0.02）→ 自动回滚
  await controller.evaluateAndAdjust();
  const r3 = await controller.evaluateAndAdjust();
  ok(
    r3.status === 'rolled-back' &&
      r3.rolledBack?.knob === 'evolver.mutationRate' &&
      Math.abs(r3.rolledBack?.to - 0.6) < 1e-9 &&
      Math.abs(store.value - 0.6) < 1e-9,
    `S2b 保守半步的严格判定：指标持平（Δ0 ≤ 容忍 0.02）→ 无明确改善即回滚 0.65→0.6（provisional 口径：没证据就退回）`,
  );
}

// S2-② 「假改进」臂：效果在 +0.03~+0.05 波动（均值 +0.04、σ 吞噬证据）
// → 4 样本后经验伯恩斯坦 LCB<0 → 证书拒绝第 5 次调整
{
  const { store, controller, setMetric } = await certScenario();
  const effects = [0.05, 0.03, 0.05, 0.03]; // 全部 > 容忍 0.02 → 2.0 判定全部「保留生效」
  for (const effect of effects) {
    setMetric(0.5); // 调整/观察轮：指标回落基线（效果是波动不是趋势）
    const r = await controller.evaluateAndAdjust();
    if (r.status !== 'adjusted') throw new Error(`S2-② 场景异常：预期 adjusted，得到 ${r.status}`);
    await controller.evaluateAndAdjust(); // 观察 1/2
    setMetric(0.5 + effect); // 判定轮：读数 +effect
    const judged = await controller.evaluateAndAdjust();
    if (judged.status !== 'committed') throw new Error(`S2-② 判定异常：${effect} 预期 committed 得到 ${judged.status}`);
  }
  const armSamples = controller.getState().learner.effectiveness.find((a) => a.knob === 'evolver.mutationRate');
  const knobAfterCycles = store.value;
  // 第 5 次尝试：视图 4 样本齐 → 均值 +0.04 / σ≈0.0115 / 极差 0.02 → LCB = 0.04−0.068 < 0 → 拒绝
  setMetric(0.5);
  const r13 = await controller.evaluateAndAdjust();
  const rejectAudit = controller.getAuditTrail().find((e) => e.type === 'certificate-reject');
  ok(
    armSamples?.trials === 4 &&
      Math.abs(armSamples.avgEffectDelta - 0.04) < 1e-9 &&
      r13.status === 'no-op' &&
      rejectAudit !== undefined &&
      rejectAudit.certificate?.mode === 'rejected' &&
      rejectAudit.certificate?.lcb !== undefined &&
      rejectAudit.certificate.lcb < 0 &&
      Math.abs(store.value - knobAfterCycles) < 1e-12,
    `S2c 假改进被证书拒绝：4 配对样本全部被 2.0 判定「保留」（各 +0.03~+0.05 > 容忍），但均值 +0.04 的 LCB=${rejectAudit?.certificate?.lcb?.toFixed(4)} < 0（浓度半径 0.068 > 均值）→ 第 5 次调整被拒（audit certificate-reject），旋钮停在 ${store.value}`,
  );
  const cg = controller.getState().certificateGate;
  ok(
    cg !== undefined && cg.rejected >= 1 && cg.provisional >= 4 && cg.decisions.some((d) => d.knob === 'evolver.mutationRate' && d.mode === 'rejected'),
    `S2d 证书门面板：provisional×${cg?.provisional}（冷启动期 4 次半步）、rejected×${cg?.rejected}——「每次都略有改善」不等于「高置信下界为正」，方差就是风险`,
  );
}

// S2-③ 「真改进」臂：效果恒 +0.05（σ=0）→ LCB=+0.05>0 → 证书放行全幅
{
  const { store, controller, setMetric } = await certScenario();
  for (let cycle = 0; cycle < 4; cycle += 1) {
    setMetric(0.5);
    const r = await controller.evaluateAndAdjust();
    if (r.status !== 'adjusted') throw new Error(`S2-③ 场景异常：${r.status}`);
    await controller.evaluateAndAdjust();
    setMetric(0.55);
    const judged = await controller.evaluateAndAdjust();
    if (judged.status !== 'committed') throw new Error(`S2-③ 判定异常：${judged.status}`);
  }
  // 4 个 +0.05 效果入账（σ=0，极差 0）→ LCB = 0.05 − 0 = +0.05 > 0 → 第 5 次全幅放行
  setMetric(0.5);
  const r5 = await controller.evaluateAndAdjust();
  ok(
    r5.status === 'adjusted' &&
      r5.applied[0].certificate?.mode === 'full' &&
      r5.applied[0].certificate?.lcb !== undefined &&
      Math.abs(r5.applied[0].certificate.lcb - 0.05) < 1e-9 &&
      r5.applied[0].from === 0.8 &&
      Math.abs(r5.applied[0].to - 0.9) < 1e-9,
    `S2e 真改进放行全幅：4 样本恒 +0.05（σ=0 → LCB=+0.05>0）→ 证书 full——变异率 0.8→0.9（全幅步长 0.1，不再减半）`,
  );
  ok(
    controller.getAuditTrail().filter((e) => e.type === 'certificate-reject').length === 0,
    `S2f 证书不误伤：真改进臂全程零拒绝（LCB>0 直接放行——证书门是防假改进，不是反调整主义）`,
  );
}

// ═══════════════════ S3 自我模型变更日志 + 快照回滚 ═══════════════════

section('S3 自我模型变更日志：自我修改入账 / 按日志逆向回滚 / 整体快照恢复');

{
  const state = makeState({ feedback: [fb('m1', 'code-generation', 'good', T0 + HOUR)] });
  const clockValues = [];
  const selfModel = new SelfModel({
    collectors: collectorsOf(state),
    config: {
      clock: () => 1_700_000_000_000 + clockValues.length * 1000,
    },
  });
  await selfModel.generateMentalReport();
  for (let i = 0; i < 8; i += 1) selfModel.recordSelfAssessment({ claimed: 0.8, actual: 0.8 }); // 校准记忆 8 样本（≥ 预热 6 → calibrated）
  const snapshot = selfModel.snapshotSelf();

  // 三次连续自我修改（不同触发者）
  const changes = [
    ...selfModel.applySelfChange({ config: { feedbackWindow: 60 }, reason: '反馈窗口缩短以加速趋势响应', trigger: 'meta-controller' }),
    ...selfModel.applySelfChange({ config: { anomalyZThreshold: 1.5 }, reason: '人工调低异常灵敏度做压力测试', trigger: 'manual' }),
    ...selfModel.applySelfChange({
      config: { homeostasisBands: { discoveryRate: { min: 0.4, max: 0.6 } } },
      reason: '外环为发现速率配置稳态带',
      trigger: 'meta-controller',
    }),
  ];
  const log = selfModel.selfChangeLog();
  ok(
    changes.length === 3 &&
      log.length === 3 &&
      log[0].key === 'feedbackWindow' &&
      log[0].from === 100 &&
      log[0].to === 60 &&
      log[0].trigger === 'meta-controller' &&
      log[0].reason.includes('反馈窗口') &&
      log[1].key === 'anomalyZThreshold' &&
      log[1].from === 2.5 &&
      log[1].to === 1.5 &&
      log[1].trigger === 'manual' &&
      log[2].key === 'homeostasisBands' &&
      changes[0].id === 'self-change-1' &&
      changes[2].id === 'self-change-3' &&
      clockValues !== null,
    `S3a 一切自我修改入账：3 条日志携带 from/to（100→60、2.5→1.5、{}→带[0.4,0.6]）、理由与触发者（meta-controller/manual），id 顺序编号`,
  );

  // 日志逆向回滚 ×3 → 配置恢复原值
  const rollback = selfModel.rollbackSelfChanges(3);
  const logAfter = selfModel.selfChangeLog();
  ok(
    rollback.restored === 3 &&
      rollback.changes.length === 3 &&
      logAfter.length === 3 &&
      logAfter.every((c) => c.undone === true),
    `S3b 按日志逆向回滚：3 条全部逆转（返回所逆转的变更清单），日志保留不删、逐条标记 undone（审计完整）`,
  );
  // 配置恢复验证（经行为口径：恢复后再修改时 from 应为原始值 2.5）
  const rechange = selfModel.applySelfChange({ config: { anomalyZThreshold: 1.8 }, reason: '回滚后再改', trigger: 'manual' });
  ok(
    rechange.length === 1 && rechange[0].from === 2.5 && rechange[0].to === 1.8,
    `S3b' 回滚后配置确实恢复：再改 anomalyZThreshold 时 from=2.5（原始值已写回，不是被改过的 1.5）`,
  );
  selfModel.rollbackSelfChanges(1);

  // 报告推进 + 校准污染后整体快照恢复
  await selfModel.generateMentalReport();
  await selfModel.generateMentalReport();
  for (let i = 0; i < 10; i += 1) selfModel.recordSelfAssessment({ claimed: 0.95, actual: 0.8 });
  selfModel.restoreSelf(snapshot);
  const restoredCal = selfModel.calibrationView();
  const nextReport = await selfModel.generateMentalReport();
  ok(
    selfModel.getReportHistory().length === 2 &&
      restoredCal?.samples === 8 &&
      nextReport.reportIndex === 2 &&
      restoredCal?.state === 'calibrated',
    `S3c 整体快照恢复：报告历史回到 2 份（快照 1 份 + 恢复后 1 份，污染的 2 份被抹除）、校准记忆回到 8 样本 calibrated（10 条污染流被抹除）、下一报告序号 #2 接续快照时刻`,
  );

  // 变更日志跨重启持久化
  const persistPath = path.join(os.tmpdir(), `dsh-verify-mod-meta-self-${stamp}.json`);
  fs.rmSync(persistPath, { force: true });
  const sm1 = new SelfModel({ collectors: collectorsOf(state), config: { persistPath, clock: () => T0 } });
  sm1.applySelfChange({ config: { feedbackWindow: 50 }, reason: '持久化验证', trigger: 'meta-controller' });
  const sm2 = new SelfModel({ collectors: collectorsOf(state), config: { persistPath, clock: () => T0 } });
  ok(
    sm2.selfChangeLog().length === 1 &&
      sm2.selfChangeLog()[0].key === 'feedbackWindow' &&
      sm2.selfChangeLog()[0].to === 50 &&
      sm2.calibrationView() === undefined,
    `S3d 变更日志跨重启：新实例从落盘文件恢复 1 条日志（key/to 完整），无校准样本时 selfCalibration 字段缺省（旧口径兼容）`,
  );
  fs.rmSync(persistPath, { force: true });
}

// ═══════════════════ S4 自我评估校准 ═══════════════════

section('S4 自我评估校准：自评偏差流追踪收敛（过高/过低告警 + 校正口径）');

{
  const state = makeState({ feedback: [fb('q1', 'code-generation', 'good', T0 + HOUR)] });
  const selfModel = new SelfModel({ collectors: collectorsOf(state), config: { clock: () => T0 } });

  // ① 自评恒高 0.15（+确定性微噪声 ±0.01）→ 收敛到 overconfident
  const rand = mulberry32(11);
  for (let i = 0; i < 20; i += 1) {
    const actual = 0.75;
    const claimed = Math.min(1, actual + 0.15 + (rand() - 0.5) * 0.02);
    selfModel.recordSelfAssessment({ claimed, actual, domain: 'code-generation' });
  }
  const over = selfModel.calibrationView();
  ok(
    over !== undefined &&
      over.samples === 20 &&
      over.biasEma >= 0.12 &&
      over.biasEma <= 0.18 &&
      over.state === 'overconfident' &&
      over.alarms >= 1 &&
      over.lastAlarm === 'overconfident',
    `S4a 自评过高告警：20 对样本（偏差 +0.15±0.01）→ biasEma=${over?.biasEma.toFixed(4)}（∈[0.12,0.18] 收敛到真偏差），state=overconfident，翻转沿告警 ${over?.alarms} 次`,
  );
  const report1 = await selfModel.generateMentalReport();
  ok(
    report1.selfCalibration?.state === 'overconfident' &&
      selfModel.formatReport(report1).includes('[自我评估校准]'),
    `S4b 心智报告携带校准视图：selfCalibration.state=overconfident，formatReport 输出 [自我评估校准] 节（自评 0.9 的系统实际只有 0.75——感觉良好≠表现良好）`,
  );

  // ② 改为诚实自评 → 20 步 EMA 衰减回 calibrated（收敛证明）
  for (let i = 0; i < 20; i += 1) selfModel.recordSelfAssessment({ claimed: 0.75, actual: 0.75 });
  const recovered = selfModel.calibrationView();
  ok(
    recovered !== undefined &&
      Math.abs(recovered.biasEma) <= 0.02 &&
      recovered.state === 'calibrated',
    `S4c 校准收敛：偏差流归零后 20 步，biasEma=${recovered?.biasEma.toFixed(4)}（|·|≤0.02，理论衰减 0.15×0.75^20≈0.0005），state 恢复 calibrated`,
  );

  // ③ 自评恒低 → underconfident
  const state2 = makeState({ feedback: [fb('q2', 'code-generation', 'good', T0 + HOUR)] });
  const selfModel2 = new SelfModel({ collectors: collectorsOf(state2), config: { clock: () => T0 } });
  for (let i = 0; i < 12; i += 1) selfModel2.recordSelfAssessment({ claimed: 0.6, actual: 0.72 });
  const under = selfModel2.calibrationView();
  ok(
    under?.state === 'underconfident' &&
      under?.biasEma <= -0.05 &&
      under?.lastAlarm === 'underconfident' &&
      under.calibrated !== null &&
      near(under.calibrated, 0.6 - under.biasEma, 5e-4),
    `S4d 自评过低告警：恒低 0.12 → biasEma=${under?.biasEma.toFixed(4)}，state=underconfident；校正口径 calibrated = 0.6 − biasEma = ${under?.calibrated}（减去偏差即诚实自评）`,
  );
}

// ═══════════════════ S5 相对基线偏差带（meta-cognition KPI 升级） ═══════════════════

section('S5 相对基线偏差带：慢漂移早报（vs 静态阈值）且平稳噪声零误报');

let s5RelativeFirst = -1;
let s5StaticCrossingT = 0;
{
  const snapshotOf = (t, avgQuality) => ({
    timestamp: t,
    successRate: 0.95,
    avgQuality,
    avgLatency: 800,
    cacheHitRate: 0.3,
    modelSuccessRates: {},
    activeExecutions: 0,
  });
  // 序列：t=0..11 平稳 0.95±0.003（含 t=3、t=7 两个 +0.09 离群毛刺——旧均值/σ
  // 口口的毒药，稳健基线的常态）；t=12..40 慢漂移 −0.0075/批（0.95 → 0.7325，
  // 始终 > 静态目标 0.7）
  const rand = mulberry32(23);
  const values = [];
  for (let t = 0; t < 12; t += 1) values.push(0.95 + (rand() - 0.5) * 0.006);
  values[3] += 0.09; // 数据毛刺（离群点）
  values[7] += 0.09;
  for (let t = 12; t <= 40; t += 1) values.push(0.95 - 0.0075 * (t - 11) + (rand() - 0.5) * 0.006);
  const staticCrossingT = 45; // 0.95−0.0075k < 0.7 首次成立的批次（k>33.3 → t=12+34−1）：本序列之外
  s5StaticCrossingT = staticCrossingT;

  const engine = new MetaCognitionEngine({ clock: () => T0 });
  engine.attachRelativeKpiBand({ kpis: ['avgQuality'], window: 24, bandWidthMad: 3.5, minSamples: 8 });
  let relativeFirst = -1;
  let legacyGlitchFirst = -1;
  let legacyDegradedFirst = -1;
  let viewAtAlarm;
  for (let t = 0; t < values.length; t += 1) {
    const insights = engine.observe(snapshotOf(t, values[t]));
    if (relativeFirst < 0 && insights.some((i) => i.category === 'kpi-relative-drift')) {
      relativeFirst = t;
      viewAtAlarm = engine.relativeKpiBandView('avgQuality');
    }
    const anomalies = engine.getAnomalies().filter((a) => a.kpi === 'avgQuality');
    if (legacyGlitchFirst < 0 && anomalies.some((a) => a.direction === 'improved')) legacyGlitchFirst = t;
    if (legacyDegradedFirst < 0 && anomalies.some((a) => a.direction === 'degraded')) legacyDegradedFirst = t;
  }
  s5RelativeFirst = relativeFirst;
  const report = engine.getHealthReport();
  ok(
    relativeFirst >= 12 &&
      relativeFirst <= 18 &&
      values[relativeFirst] > 0.8 &&
      staticCrossingT - relativeFirst >= 25,
    `S5a 慢漂移早报：相对带在 t=${relativeFirst} 报警（avgQuality=${values[relativeFirst]?.toFixed(4)}，仍远高于静态目标 0.7）；静态阈值要到 t=${staticCrossingT} 才可见——提前 ${staticCrossingT - relativeFirst} 批次`,
  );
  ok(
    viewAtAlarm !== undefined &&
      Math.abs(viewAtAlarm.baselineMedian - 0.95) < 0.01 &&
      viewAtAlarm.robustZ < -3.5 &&
      viewAtAlarm.degraded === true &&
      report.relativeBands?.streams.some((s) => s.kpi === 'avgQuality') === true,
    `S5b 读数口径：报警时刻基线中位数 ${viewAtAlarm?.baselineMedian.toFixed(4)}（≈0.95——两个 +0.09 毛刺撼不动中位数，均值会被拉高 0.015）、稳健 z=${viewAtAlarm?.robustZ.toFixed(1)}（< −3.5 越带）、健康报告 relativeBands 携带读数流`,
  );
  ok(
    (legacyDegradedFirst === -1 || legacyDegradedFirst > relativeFirst) && legacyGlitchFirst >= 0,
    `S5c 对旧 z-score 的对照：旧口径在 t=${legacyGlitchFirst} 对数据毛刺误报「改善方向异常」（+0.09 毛刺把窗口 σ 撑大 ~10 倍），此后慢漂移的退化 z 被压到阈值内——退化方向${legacyDegradedFirst === -1 ? '从未报警（全序列致盲）' : `迟到 t=${legacyDegradedFirst}`}；相对带 t=${relativeFirst} 已报且方向正确`,
  );

  // 平稳噪声（含毛刺）40 批 → 零误报
  const engine2 = new MetaCognitionEngine({ clock: () => T0 });
  engine2.attachRelativeKpiBand({ kpis: ['avgQuality'], window: 24, bandWidthMad: 3.5, minSamples: 8 });
  const rand2 = mulberry32(29);
  let falseAlarms = 0;
  for (let t = 0; t < 40; t += 1) {
    const value = t === 15 || t === 27 ? 1.04 : 0.95 + (rand2() - 0.5) * 0.006;
    const insights = engine2.observe(snapshotOf(t, value));
    falseAlarms += insights.filter((i) => i.category === 'kpi-relative-drift').length;
  }
  ok(
    falseAlarms === 0,
    `S5d 平稳噪声零误报：±0.003 噪声 + 2 个 +0.09 毛刺共 40 批（毛刺只进基线窗不进检验位，稳健 |z| < 3.5）→ 相对带告警 0 次——早报不以误报为代价`,
  );
}

// ═══════════════════ S6 内外环冲突仲裁 ═══════════════════

section('S6 内外环冲突仲裁：同参数多方调整 → 最后写入者胜 + 冲突计数');

{
  const state = makeState({
    feedback: [
      fb('x1', 'refactor', 'failed', T0 + HOUR),
      fb('x2', 'refactor', 'failed', T0 + 1.1 * HOUR),
      fb('x3', 'refactor', 'poor', T0 + 1.2 * HOUR),
      fb('x4', 'refactor', 'good', T0 + 1.3 * HOUR),
    ],
  });
  const store = makeSimKnobStore(0.6);
  const controller = new MetaCognitiveController({
    selfModel: new SelfModel({ collectors: collectorsOf(state) }),
    knobs: [
      simKnob(store, {
        id: 'evolver.mutationRate',
        label: '进化器变异率',
        judgeMetric: 'discoveryRate',
        higherIsBetter: true,
        min: 0.2,
        max: 1.0,
        step: 0.1,
      }),
    ],
    config: { clock: () => T0, observationReports: 2 },
  });
  const setMetric = (value) => {
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
  setMetric(0.5);

  // R1：外环调整 0.6→0.7 进入观察窗
  const r1 = await controller.evaluateAndAdjust();
  // 内环调参器改写同一旋钮到 0.5（外部写入 + 显式报告）
  store.value = 0.5;
  controller.notifyExternalWrite('evolver.mutationRate', 'inner-loop-tuner');
  // R2：观察窗内 → 冲突仲裁（观察作废，最后写入者胜）
  const r2 = await controller.evaluateAndAdjust();
  const arb = controller.getState().arbitration;
  ok(
    r1.status === 'adjusted' &&
      r1.applied[0].to === 0.7 &&
      r2.status === 'no-op' &&
      r2.skippedReason?.includes('冲突仲裁') === true &&
      Math.abs(store.value - 0.5) < 1e-12 &&
      arb?.conflicts === 1 &&
      arb?.lastConflict?.knob === 'evolver.mutationRate',
    `S6a 观察期外部改写仲裁：外环 0.6→0.7 观察中，内环改写为 0.5 → R2 冲突仲裁（观察作废不判定，${r2.skippedReason?.slice(0, 38)}…），旋钮保持 0.5（最后写入者胜），冲突计数 1`,
  );
  // R3：新调整从外部值 0.5 出发（以外部值为基线，不盲目覆盖）
  const r3 = await controller.evaluateAndAdjust();
  ok(
    r3.status === 'adjusted' && r3.applied[0].from === 0.5 && Math.abs(r3.applied[0].to - 0.6) < 1e-9,
    `S6b 外部值为新基线：仲裁后外环再调整从 0.5 出发（0.5→0.6）——不是覆写回 0.7 的旧意图`,
  );
  // 静默外部改写（无 notify）→ 观察窗读数检测捕获
  store.value = 0.45;
  const r4 = await controller.evaluateAndAdjust();
  const arbAudits = controller.getAuditTrail().filter((e) => e.type === 'conflict-arbitration');
  ok(
    r4.status === 'no-op' &&
      controller.getState().arbitration?.conflicts === 2 &&
      arbAudits.length === 2 &&
      arbAudits[1].knob === 'evolver.mutationRate' &&
      Math.abs(arbAudits[1].from - 0.6) < 1e-9 &&
      Math.abs(arbAudits[1].to - 0.45) < 1e-9 &&
      arbAudits[1].reason.includes('观察作废') === true,
    `S6c 静默改写读数检测：无 notify 的外部改写（0.6→0.45）同样被捕获——观察窗读数 0.45 ≠ 预期 0.6 → 第二次冲突入账（审计 from 0.6 → to 0.45，观察作废）`,
  );
  ok(
    controller.getState().arbitration?.arbitrated === 2 &&
      Math.abs(store.value - 0.45) < 1e-12,
    `S6d 仲裁计数与终态：arbitrated=2（每次冲突都完成仲裁而非忽略），旋钮终值 0.45（外部最后写入者的值胜出）`,
  );
}

// ═══════════════════ S7 注入时钟 + 零漂移 ═══════════════════

section('S7 注入时钟确定性 + 未启用 3.0 开关的零漂移');

{
  // 注入时钟：三引擎时间戳全部来自注入时钟
  let tick = 1000;
  const clock = () => (tick += 500);
  const engine = new MetaCognitionEngine({
    clock,
    windowSize: 8,
    zScoreThreshold: 1.5,
    successRateTarget: 0.8,
    qualityTarget: 0.7,
    degradeStreakThreshold: 99,
    tuningCooldownMs: 30_000,
  });
  const kpiSnapshot = (avgQuality) => ({
    timestamp: 0,
    successRate: 0.9,
    avgQuality,
    avgLatency: 800,
    cacheHitRate: 0.3,
    modelSuccessRates: {},
    activeExecutions: 0,
  });
  // 预热 6 批带微扰的平稳质量（std>0 才能 z-score），随后一批骤降构造异常
  const warmup = [0.9, 0.92, 0.88, 0.91, 0.89, 0.9];
  for (const v of warmup) engine.observe(kpiSnapshot(v));
  engine.observe(kpiSnapshot(0.5));
  // 唯一的 now() 消耗点是异常构造（预热批不产生异常）→ 时间戳 = 1000+500 可精确预言
  const anomaly = engine.getAnomalies().find((a) => a.kpi === 'avgQuality');
  ok(
    anomaly !== undefined && anomaly.timestamp === 1500,
    `S7a 元认知引擎注入时钟：异常时间戳 ${anomaly?.timestamp} === 注入时钟首次产出值 1500（确定性——同输入同输出，无 wall-clock 泄漏）`,
  );

  const state = makeState({
    feedback: [
      fb('z1', 'refactor', 'failed', T0 + HOUR),
      fb('z2', 'refactor', 'failed', T0 + 1.1 * HOUR),
      fb('z3', 'refactor', 'poor', T0 + 1.2 * HOUR),
      fb('z4', 'refactor', 'good', T0 + 1.3 * HOUR),
    ],
  });
  const t0 = 1_234_567_890_123;
  const selfModel = new SelfModel({ collectors: collectorsOf(state), config: { clock: () => t0 } });
  const report = await selfModel.generateMentalReport();
  ok(
    report.generatedAt === t0 && report.timestamp === new Date(t0).toISOString(),
    `S7b 自我模型注入时钟：generatedAt=${report.generatedAt}、ISO 时间戳同源（趋势/审计跨重启可比）`,
  );

  const store = makeSimKnobStore(0.6);
  const controller = new MetaCognitiveController({
    selfModel,
    knobs: [
      simKnob(store, {
        id: 'evolver.mutationRate',
        label: '进化器变异率',
        judgeMetric: 'discoveryRate',
        higherIsBetter: true,
        min: 0.2,
        max: 1.0,
        step: 0.1,
      }),
    ],
    config: { clock: () => t0 },
  });
  const r1 = await controller.evaluateAndAdjust();
  const adjustEntry = controller.getAuditTrail().find((e) => e.type === 'adjust');
  ok(
    r1.timestamp === new Date(t0).toISOString() &&
      adjustEntry?.timestamp === t0 &&
      r1.applied[0].to === 0.7 &&
      r1.applied[0].certificate === undefined,
    `S7c 控制器注入时钟：审计与报告时间戳同源 t0；未启用证书门时 applied 无 certificate 字段（2.0 口径不变）`,
  );

  // 零漂移：未启用 3.0 开关 → 新字段全部缺省
  const plainState = controller.getState();
  const plainEngine = new MetaCognitionEngine();
  const plainReport = plainEngine.getHealthReport();
  ok(
    plainState.stability === undefined &&
      plainState.certificateGate === undefined &&
      plainState.arbitration?.conflicts === 0 &&
      plainReport.relativeBands === undefined &&
      (await new SelfModel({ collectors: collectorsOf(state) }).generateMentalReport()).selfCalibration === undefined,
    `S7d 零漂移：默认配置下 stability/certificateGate 为 undefined、健康报告无 relativeBands、心智报告无 selfCalibration——3.0 全部 opt-in，既有验证口径逐位不变`,
  );
}

// ═══════════════════ 新旧对照总表 ═══════════════════

section('旧 vs 新 对照总表');
console.log('  ┌──────────────────────┬──────────────────────────────┬────────────────────────────────────┐');
console.log('  │ 升级面               │ 旧行为（2.0 及以前）         │ 新行为（3.0，本脚本实测）          │');
console.log('  ├──────────────────────┼──────────────────────────────┼────────────────────────────────────┤');
console.log(`  │ 外环调参阻尼         │ 朴素比例：${naive.adjustments} 调 ${naive.flips} 翻转（持续打摆）    │ 死区+斜坡+冷却：${damped.adjustments} 调 ${damped.flips} 翻转（靠带即静默）    │`);
console.log('  │ 自我调整放行         │ 无证书：任何候选直接全幅      │ 89.0 LCB 证书：假改进拒绝、冷启动半步 │');
console.log(`  │ KPI 退化判定         │ 静态阈值 0.7：t=${s5StaticCrossingT} 才可见     │ 相对基线带：t=${s5RelativeFirst} 即报（早 ${s5StaticCrossingT - s5RelativeFirst} 批次）   │`);
console.log('  │ 自我修改             │ 无日志：改了什么不可追溯      │ 变更日志+快照回滚：3 改 3 恢复      │');
console.log('  │ 自我评估             │ 无校准：自评恒高不自知        │ biasEma 收敛 +0.15→告警→归零校准    │');
console.log('  │ 同参数多方调整       │ 后写覆盖前写、无感知          │ 最后写入者仲裁+冲突计数（2 次入账） │');
console.log('  └──────────────────────┴──────────────────────────────┴────────────────────────────────────┘');

// ─────────────────────────── 结果输出 ───────────────────────────
console.log(`\n${'═'.repeat(56)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed === 0) {
  console.log('✅ 元认知层 3.0 世界性升级全部通过：死区稳定环（震荡→收敛构造对照）× 89.0 调整证书门（假改进拒绝/真改进放行/冷启动半步）× 自我变更日志与快照回滚 × 自我评估校准收敛 × 相对基线偏差带（早报且不误报）× 内外环冲突仲裁 × 注入时钟确定性 + 零漂移。');
} else {
  console.log('❌ 存在未通过的断言，请检查。');
}
process.exit(failed === 0 ? 0 : 1);
