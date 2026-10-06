/**
 * verify-mod-decision.mjs — 第三轮模块域 A2：决策引擎（decision-engine.ts）
 * 五项升级的「旧 vs 新」构造对照验证
 *
 *   R3-1 决策滞后状态机：execute↔defer 边界抖动——双阈值 + 最短驻留期，
 *        正弦紧急度流上对照横跳次数（旧 9 次 → 新 ≤5 次，间隙请求全抑制）
 *   R3-2 反事实决策台账：上下文桶 × 假想臂估计，结局回填滚动后悔统计
 *        （Wilson 区间）——臂值差距收敛到构造真值 0.76
 *   R3-3 ask-user 信息价值门：挂载 95.0/97.0 后低置信升级经期望成本裁决
 *        （x = p·c_auto vs τ*）——「高代价低信心才问」三例矩阵
 *   R3-4 上下文分桶校准：规则 C 全局紧急度线升级为分桶统计线——夜间
 *        紧急度虚高 +0.15 的漂移场景，漏 defer 对照（全局 ~16 → 分桶 ≤4）
 *   R3-5 决策审计记录：结构化理由（stage / 分数分解 / 标记 / 上下文桶）导出
 *
 * 全程离线（无 strategist 时走启发式兜底；strategist 为注入的确定性回调）。
 * 末尾 PASS n / FAIL m，失败 exit 1。
 *
 * 运行：npm run build && node scripts/verify-mod-decision.mjs
 */

import { DecisionEngine, mulberry32 } from '../dist/index.mjs';

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
function near(actual, expected, tol, label) {
  const hit = Math.abs(actual - expected) <= tol;
  ok(hit, `${label}（实际 ${actual.toFixed(4)}，期望 ${expected.toFixed(4)} ± ${tol}）`);
}
function section(title) {
  console.log(`\n■ ${title}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────── 构造工具 ───────────────────────────
let sigSeq = 0;
function mkSignal({ type = 'generic', urgency, source = 'fs:/tmp', receivedAt = Date.now(), occurrences = 1 }) {
  sigSeq += 1;
  return {
    id: `sig-${type}-${sigSeq}`,
    type,
    description: `desc-${type}-${sigSeq}`,
    payload: {},
    urgency,
    receivedAt,
    source,
    occurrences,
  };
}

const statsOf = (over = {}) => ({ totalDecisions: 0, successRate: 0.8, avgExecutionTime: 1000, avgTokenCost: 0, ...over });

/** 确定性 strategist：按信号 id 顺序消费 verdict 序列（缺省恒 execute） */
function scriptedStrategist(queue) {
  let cursor = 0;
  return (signals) => {
    const out = new Map();
    for (const s of signals) {
      out.set(s.id, queue[cursor] ?? { urgency: 0.5, decision: 'execute', reason: '脚本裁定' });
      cursor += 1;
    }
    return Promise.resolve(out);
  };
}

/** 单信号决策捷径 */
async function decideOne(engine, sig, history = new Map()) {
  const m = await engine.decide([sig], history);
  return m.get(sig.id);
}

/** 数一段动作序列的横跳次数（相邻不同） */
function countFlips(actions) {
  let flips = 0;
  for (let i = 1; i < actions.length; i += 1) if (actions[i] !== actions[i - 1]) flips += 1;
  return flips;
}

// ═══════════════════ §0 零漂移基线 ═══════════════════

section('§0 零漂移：不挂载任何 R3 组件 → 行为与升级前逐位一致');

{
  const engine = new DecisionEngine();
  ok(engine.hysteresisView() === undefined, '滞后读数缺席（未挂载 → undefined）');
  ok(engine.counterfactualView() === undefined, '反事实台账缺席（未挂载 → undefined）');
  ok(engine.contextCalibrationView() === undefined, '分桶校准读数缺席（未挂载 → undefined）');
  ok(engine.askUserGateStats() === undefined, '信息价值门计数缺席（未挂载 → undefined）');
  ok(engine.getStructuredAudit().length === 0, '结构化审计为空（未挂载 → []）');

  // 规则 C 原口径：低紧急 + 高成本 → defer（魔数线 0.3）
  const history = new Map([['costly', statsOf({ avgTokenCost: 6000 })]]);
  const deferDecision = await decideOne(engine, mkSignal({ type: 'costly', urgency: 0.2 }), history);
  ok(
    deferDecision.action === 'defer' && deferDecision.confidence === 0.7 && deferDecision.deferMs === 300000,
    `规则 C 原口径：urgency 0.2 < 0.3 且 6000 tokens → defer（confidence ${deferDecision.confidence}，deferMs ${deferDecision.deferMs}）`,
  );

  // 低置信升级旧规则：无成本口径 → 一律升级 ask-user
  const legacy = new DecisionEngine({ lowConfidenceThreshold: 0.7, strategist: scriptedStrategist([{ urgency: 0.6, decision: 'execute' }]) });
  const upgraded = await decideOne(legacy, mkSignal({ type: 'fresh' }));
  ok(
    upgraded.action === 'ask-user' && !upgraded.reason.includes('信息价值门'),
    `低置信升级旧规则：confidence 0.65 < 0.7 → ask-user，reason 无门标记（零漂移）`,
  );

  // 启发式兜底原口径
  const bare = new DecisionEngine();
  const fallback = await decideOne(bare, mkSignal({ type: 'nostrat', urgency: 0.4 }));
  ok(fallback.action === 'execute' && fallback.confidence === 0.5 && fallback.source === 'heuristic', '启发式兜底原口径：execute / confidence 0.5');
}

// ═══════════════════ §1 R3-1 决策滞后状态机 ═══════════════════

section('§1 滞后状态机：execute↔defer 边界抖动消除（正弦紧急度流对照）');

{
  // 16 步正弦紧急度（0.329~0.675 波动，跨 0.5 单阈值往返）——上游
  // strategist 在 0.5 单阈值口径下裁定 execute/defer（旧口径的抖动源）
  const urgencies = Array.from({ length: 16 }, (_, i) => 0.5 + 0.18 * Math.sin(2.2 * i));
  const verdicts = urgencies.map((u) => ({ urgency: u, decision: u >= 0.5 ? 'execute' : 'defer', reason: '边界裁定' }));

  // 旧口径：直通 → 横跳
  const oldEngine = new DecisionEngine({ strategist: scriptedStrategist(verdicts) });
  const oldActions = [];
  for (let i = 0; i < urgencies.length; i += 1) {
    const d = await decideOne(oldEngine, mkSignal({ type: 'edge' }));
    oldActions.push(d.action);
  }
  const oldFlips = countFlips(oldActions);

  // 新口径：双阈值（enterHigh 0.66 / exitLow 0.50）+ 零驻留 → 换向须过硬阈
  const newEngine = new DecisionEngine({ strategist: scriptedStrategist(verdicts) });
  newEngine.attachDecisionHysteresis({ enterHigh: 0.66, exitLow: 0.5, minDwellMs: 0 });
  const newActions = [];
  for (let i = 0; i < urgencies.length; i += 1) {
    const d = await decideOne(newEngine, mkSignal({ type: 'edge' }));
    newActions.push(d.action);
  }
  const newFlips = countFlips(newActions);
  const hv = newEngine.hysteresisView();
  const gapRequests = verdicts.filter((v, i) => i > 0 && ((v.decision === 'execute' && v.urgency < 0.66 && v.urgency >= 0.5) || (v.decision === 'defer' && v.urgency >= 0.5 && v.urgency < 0.66))).length;

  console.log(`  旧口径动作序列：${oldActions.map((a) => (a === 'execute' ? 'E' : 'D')).join('')} → 横跳 ${oldFlips} 次`);
  console.log(`  新口径动作序列：${newActions.map((a) => (a === 'execute' ? 'E' : 'D')).join('')} → 换向 ${newFlips} 次，抑制 ${hv ? hv.suppressed : '—'} 次`);
  ok(oldFlips >= 8, `旧口径（单阈值直通）横跳 ${oldFlips} 次 ≥ 8——边界抖动确凿`);
  ok(newFlips < oldFlips && newFlips <= 5, `新口径换向 ${newFlips} 次 < 旧 ${oldFlips} 次（双阈值消抖，横跳减 ${(100 * (1 - newFlips / oldFlips)).toFixed(0)}%）`);
  ok(hv !== undefined && hv.suppressed >= 4, `间隙区换向请求被抑制 ${hv ? hv.suppressed : '—'} 次（其中间隙请求 ${gapRequests} 次全部拦截）`);
  ok(hv !== undefined && hv.flips === newFlips, `读数 flips=${hv ? hv.flips : '—'} 与序列实数一致`);
  ok(newActions[2] === 'defer' && newActions[1] === 'execute', '真正越过硬阈的换向仍然放行（u=0.329 < exitLow 0.5 → 换向 defer）——滞回不是死锁');
}

section('§1b 滞后状态机：最短驻留期（换向后立刻反向 → 保持）');

{
  const engine = new DecisionEngine({ strategist: scriptedStrategist([
    { urgency: 0.9, decision: 'execute' },
    { urgency: 0.1, decision: 'defer' },
    { urgency: 0.1, decision: 'defer' },
  ]) });
  engine.attachDecisionHysteresis({ enterHigh: 0.62, exitLow: 0.45, minDwellMs: 300 });
  const d1 = await decideOne(engine, mkSignal({ type: 'dwell' }));
  const d2 = await decideOne(engine, mkSignal({ type: 'dwell' }));
  ok(d1.action === 'execute' && d2.action === 'execute' && d2.reason.includes('驻留保持'), `换向后 300ms 内的反向请求被驻留期保持（execute 维持，标记〔滞后·驻留保持〕）`);
  await sleep(350);
  const d3 = await decideOne(engine, mkSignal({ type: 'dwell' }));
  ok(d3.action === 'defer' && d3.reason.includes('换向'), `驻留期满 + urgency 0.1 < exitLow → 放行换向 defer（标记〔滞后·换向〕）`);
  const hv = engine.hysteresisView();
  ok(hv !== undefined && hv.suppressed === 1 && hv.flips === 1, `读数：换向 ${hv ? hv.flips : '—'} 次（首决策建态不算换向）/ 抑制 ${hv ? hv.suppressed : '—'} 次`);
}

// ═══════════════════ §2 R3-2 反事实决策台账 ═══════════════════

section('§2 反事实台账：假想臂 × 滚动后悔（Wilson 区间）收敛到构造真值');

{
  // 构造真值：cf-good 桶 execute 臂 = 0.7×1.0 + 0.3×0.8 = 0.94；
  //            cf-bad 桶 execute 臂 = 0.6×0.3 + 0.4×0.0 = 0.18；差距 0.76
  // 引擎固定 execute（strategist 缺省），结局按桶回填——台账无从得知
  // 桶标签，只能从观测收敛
  const engine = new DecisionEngine({ failureEscalationThreshold: 999 }); // 禁规则 B（cf-bad 桶连续失败会触发止损升级，污染构造前提）
  engine.attachCounterfactualLedger();
  const rand = mulberry32(20261003);
  const N = 240;
  let nBad = 0;
  let snapshot60 = null;
  for (let i = 0; i < N; i += 1) {
    const isBad = rand() < 0.5;
    if (isBad) nBad += 1;
    const sig = mkSignal({ type: isBad ? 'cf-bad' : 'cf-good', urgency: 0.5 });
    const d = await decideOne(engine, sig);
    if (d.action !== 'execute') throw new Error('构造前提被破坏：strategist 应恒 execute');
    const outcome = isBad ? (rand() < 0.6 ? 'poor' : 'failed') : (rand() < 0.7 ? 'excellent' : 'good');
    engine.recordOutcome(sig.type, engine.fingerprint(sig), outcome);
    if (i === 59) snapshot60 = engine.counterfactualView();
  }
  const view = engine.counterfactualView();
  const goodBucket = view.buckets.find((b) => b.key === 'cf-good');
  const badBucket = view.buckets.find((b) => b.key === 'cf-bad');
  ok(view !== undefined, '台账读数产出（挂载即生效）');
  ok(goodBucket !== undefined && badBucket !== undefined, `两个上下文桶各自积累臂观测（good ${goodBucket ? goodBucket.arms[0].n : '—'} 条 / bad ${badBucket ? badBucket.arms[0].n : '—'} 条）`);
  const goodArm = goodBucket.arms.find((a) => a.action === 'execute');
  const badArm = badBucket.arms.find((a) => a.action === 'execute');
  ok(goodBucket.arms.every((a) => a.action === 'execute') && badBucket.arms.every((a) => a.action === 'execute'), '未观测臂（defer/dismiss/ask-user）不虚构读数——保持先验，不进 arms');
  near(goodArm.meanValue, 0.94, 0.08, 'good 桶 execute 臂均值 → 真值 0.94');
  near(badArm.meanValue, 0.18, 0.08, 'bad 桶 execute 臂均值 → 真值 0.18');

  const estGap = goodArm.meanValue - badArm.meanValue;
  const s60good = snapshot60.buckets.find((b) => b.key === 'cf-good');
  const s60bad = snapshot60.buckets.find((b) => b.key === 'cf-bad');
  const earlyGap = s60good && s60bad ? s60good.arms[0].meanValue - s60bad.arms[0].meanValue : Number.NaN;
  console.log(`  臂值差距估计：n=60 时 ${earlyGap.toFixed(4)} → n=240 时 ${estGap.toFixed(4)}（构造真值 0.76）`);
  near(estGap, 0.76, 0.12, '台账差距收敛到真值 0.76');
  ok(Math.abs(estGap - 0.76) < Math.abs(earlyGap - 0.76), `样本翻 4 倍后估计误差收窄（|err| ${Math.abs(earlyGap - 0.76).toFixed(4)} → ${Math.abs(estGap - 0.76).toFixed(4)}）`);

  const regret = view.regretByAction.execute;
  const trueRate = nBad / N;
  ok(regret !== undefined && regret.n === N, `execute 后悔样本 ${regret ? regret.n : '—'} 条全量入账（bad 桶后悔 / good 桶不后悔的干净二分）`);
  near(regret.regretRate, trueRate, 1e-9, `后悔率 = bad 桶占比 ${trueRate.toFixed(4)}（只有选错上下文才后悔）`);
  ok(regret.wilsonLow <= trueRate && trueRate <= regret.wilsonHigh, `Wilson 95% 区间 [${regret.wilsonLow.toFixed(4)}, ${regret.wilsonHigh.toFixed(4)}] 覆盖真实后悔率 ${trueRate.toFixed(4)}`);
  ok(regret.wilsonHigh - regret.wilsonLow <= 0.15, `区间宽度 ${(regret.wilsonHigh - regret.wilsonLow).toFixed(4)} ≤ 0.15（n=240 的紧凑度）`);
  // 平均后悔真值 = 两桶按占比加权（good 桶后悔为负——选得比 best-other 估计更好）
  const trueMeanRegret = (nBad / N) * (0.5 - badArm.meanValue) + (1 - nBad / N) * (0.5 - goodArm.meanValue);
  near(regret.meanRegret, trueMeanRegret, 0.005, `平均后悔 → ${(nBad / N).toFixed(2)}×(0.5−bad) + ${(1 - nBad / N).toFixed(2)}×(0.5−good) = ${trueMeanRegret.toFixed(4)}（best-other 先验 0.5 对照两桶真值）`);
}

// ═══════════════════ §3 R3-3 ask-user 信息价值门 ═══════════════════

section('§3 信息价值门：高代价低信心才问（x = p·c_auto vs τ* = c_H + c_delay）');

{
  // 对照：未挂 95.0/97.0 → 旧规则（低置信一律升级）
  const legacy = new DecisionEngine({ lowConfidenceThreshold: 0.7, strategist: scriptedStrategist([{ urgency: 0.5, decision: 'execute' }]) });
  const legacyCheap = await decideOne(legacy, mkSignal({ type: 'gated' }), new Map([['gated', statsOf({ avgTokenCost: 100 })]]));
  ok(legacyCheap.action === 'ask-user', `旧规则对照：低代价低信心也问（confidence 0.65 < 0.7 → ask-user——不看打扰成本）`);

  // 门组：挂 95.0 交接 + 成本模型 { c_H = 6000 }
  const engine = new DecisionEngine({ lowConfidenceThreshold: 0.75, strategist: scriptedStrategist([{ urgency: 0.5, decision: 'execute' }, { urgency: 0.5, decision: 'execute' }, { urgency: 0.5, decision: 'execute' }]) });
  engine.attachHandoffPolicy();
  engine.attachAskUserValueGate({ costHuman: 6000 });

  // A 低信心(0.65) 高代价(20000)：x = 0.35×20000 = 7000 > τ* 6000 → 问
  const caseA = await decideOne(engine, mkSignal({ type: 'gated' }), new Map([['gated', statsOf({ avgTokenCost: 20000 })]]));
  ok(caseA.action === 'ask-user' && caseA.reason.includes('信息价值门'), `低信心 × 高代价 → 问（x=7000 > τ*=6000，reason 携带〔信息价值门〕标记）`);

  // B 低信心(0.65) 低代价(100)：x = 35 < τ* 6000 → 不问
  const caseB = await decideOne(engine, mkSignal({ type: 'gated' }), new Map([['gated', statsOf({ avgTokenCost: 100 })]]));
  ok(caseB.action === 'execute' && caseB.reason.includes('不值得打扰'), `低信心 × 低代价 → 不问（x=35 ≤ τ*=6000——为低风险任务打扰用户反而更贵）`);

  // C 中信心(0.71, history 3 次) 高代价(20000)：x = 0.29×20000 = 5800 < 6000 → 门拦截升级
  const caseC = await decideOne(engine, mkSignal({ type: 'gated' }), new Map([['gated', statsOf({ avgTokenCost: 20000, totalDecisions: 3 })]]));
  ok(caseC.action === 'execute' && caseC.reason.includes('信息价值门'), `中高信心 × 高代价 → 不问（x=5800 ≤ τ*=6000——信心值钱就别花用户的时间；仍低于升级阈 0.75，由门裁决放行）`);

  const gs = engine.askUserGateStats();
  ok(gs !== undefined && gs.total === 3 && gs.escalated === 1 && gs.spared === 2, `门裁决计数：total ${gs ? gs.total : '—'} / 维持升级 ${gs ? gs.escalated : '—'} / 拦截 ${gs ? gs.spared : '—'}（旧规则会多问 2 次）`);

  // 97.0 单独挂载路径：闭式求助阈（confidence < c* 才问）
  const metaEngine = new DecisionEngine({ lowConfidenceThreshold: 0.7, strategist: scriptedStrategist([{ urgency: 0.5, decision: 'execute' }, { urgency: 0.5, decision: 'execute' }]) });
  metaEngine.attachMetacognitiveConfidence();
  metaEngine.attachAskUserValueGate({ costHuman: 200, priorError: 0.5 });
  const metaA = await decideOne(metaEngine, mkSignal({ type: 'gated2' }), new Map([['gated2', statsOf({ avgTokenCost: 20000 })]]));
  const metaC = await decideOne(metaEngine, mkSignal({ type: 'gated2' }), new Map([['gated2', statsOf({ avgTokenCost: 20000, totalDecisions: 10 })]]));
  ok(metaA.action === 'ask-user' && metaA.reason.includes('97.0'), `97.0 路径：低信心高代价 → 问（闭式阈口径，标记〔信息价值门(97.0)〕）`);
  ok(metaC.action === 'execute', `97.0 路径：高信心 → 不问（过度自信与过度自卑都被成本模型拉回）`);
}

// ═══════════════════ §4 R3-4 上下文分桶校准 ═══════════════════

section('§4 分桶校准：夜间紧急度虚高 +0.15 漂移——分桶线 vs 全局线漏 defer 对照');

{
  // 漂移构造：夜间（02:00）低信誉源上报 urgency = 真值 + 0.15（虚高），
  // 白天（14:00）如实上报。真值 < 0.3 的执行会失败（应 defer），≥ 0.3 成功。
  // 规则 C 全局线 0.3 → 夜间 [0.15, 0.3) 的信号被虚高抬过线 → 漏 defer。
  const NIGHT = new Date('2026-10-02T02:00:00').getTime();
  const DAY = new Date('2026-10-02T14:00:00').getTime();
  const history = new Map([['drift', statsOf({ avgTokenCost: 8000 })]]);
  const cfg = { failureEscalationThreshold: 999 }; // 关规则 B（防训练流连续失败污染）

  const globalEngine = new DecisionEngine({ ...cfg, strategist: scriptedStrategist([]) });
  const bucketEngine = new DecisionEngine({ ...cfg, strategist: scriptedStrategist([]) });
  bucketEngine.attachContextCalibrator({ minSamples: 8 });

  // 训练流：100 个夜间信号（两引擎必须看到同一 (uTrue, isNight) 序列——
  // 预生成确定性序列，只有分桶引擎从中学习）
  const trainSeq = [];
  const tRand = mulberry32(20261005);
  for (let i = 0; i < 100; i += 1) trainSeq.push({ isNight: true, uTrue: 0.05 + 0.55 * tRand() });
  for (const { isNight, uTrue } of trainSeq) {
    for (const engine of [globalEngine, bucketEngine]) {
      const uReport = isNight ? Math.min(1, uTrue + 0.15) : uTrue;
      const sig = mkSignal({ type: 'drift', urgency: uReport, source: 'webhook:night', receivedAt: isNight ? NIGHT : DAY });
      const d = await decideOne(engine, sig, history);
      if (d.action === 'execute') engine.recordOutcome(sig.type, engine.fingerprint(sig), uTrue < 0.3 ? 'failed' : 'good');
    }
  }

  const calView = bucketEngine.contextCalibrationView();
  const nightBucket = calView.buckets.find((b) => b.key.startsWith('off/'));
  const dayBucket = calView.buckets.find((b) => b.key.startsWith('work/'));
  ok(calView !== undefined && calView.globalLine === 0.3, `全局缺省线 0.3（对照口径）`);
  ok(nightBucket !== undefined && nightBucket.threshold !== undefined && nightBucket.threshold > 0.38,
    `夜间桶校准线上移 → ${nightBucket && nightBucket.threshold ? nightBucket.threshold.toFixed(3) : '—'}（n=${nightBucket ? nightBucket.n : '—'}，失败样本高分位把虚高压回——从证据里学到「夜里喊狼来了」）`);
  ok(dayBucket === undefined || dayBucket.threshold === undefined, `白天桶无失败证据 → 校准线缺席，回退全局线（只收紧不放松——白天零损失）`);

  // 测试流：60 夜间 + 40 白天（同一序列喂两引擎）
  const testRand = mulberry32(20261006);
  const testSeq = [];
  for (let i = 0; i < 60; i += 1) testSeq.push({ isNight: true, uTrue: 0.05 + 0.55 * testRand() });
  for (let i = 0; i < 40; i += 1) testSeq.push({ isNight: false, uTrue: 0.05 + 0.55 * testRand() });
  const tally = { global: { night: 0, day: 0 }, bucket: { night: 0, day: 0 } };
  for (const { isNight, uTrue } of testSeq) {
    for (const [name, engine] of [['global', globalEngine], ['bucket', bucketEngine]]) {
      const uReport = isNight ? Math.min(1, uTrue + 0.15) : uTrue;
      const sig = mkSignal({ type: 'drift', urgency: uReport, source: 'webhook:night', receivedAt: isNight ? NIGHT : DAY });
      const d = await decideOne(engine, sig, history);
      const miss = d.action === 'execute' && uTrue < 0.3;
      if (miss) tally[name][isNight ? 'night' : 'day'] += 1;
      if (d.action === 'execute') engine.recordOutcome(sig.type, engine.fingerprint(sig), uTrue < 0.3 ? 'failed' : 'good');
    }
  }
  const gTotal = tally.global.night + tally.global.day;
  const bTotal = tally.bucket.night + tally.bucket.day;
  console.log(`  漏 defer 对照（应 defer 却执行）：全局线 夜 ${tally.global.night} + 日 ${tally.global.day} = ${gTotal}；分桶线 夜 ${tally.bucket.night} + 日 ${tally.bucket.day} = ${bTotal}`);
  ok(tally.global.night >= 10, `全局线夜间漏 defer ${tally.global.night} ≥ 10（虚高 +0.15 把 [0.15,0.3) 抬过 0.3 线——全局口径的漂移代价）`);
  ok(tally.bucket.night <= 4 && tally.bucket.night < tally.global.night / 2, `分桶线夜间漏 defer ${tally.bucket.night} ≤ 全局 ${tally.global.night} 的一半（桶内失败证据自动收紧判定线）`);
  ok(tally.bucket.day === tally.global.day, `白天漏 defer 两口径持平（${tally.global.day} = ${tally.bucket.day}——校准只收紧不放松，无漂移上下文零损失）`);
  ok(bTotal < gTotal, `总漏 defer ${bTotal} < ${gTotal}（分桶优于全局阈值）`);
  const applied = bucketEngine.contextCalibrationView().buckets.find((b) => b.key.startsWith('off/'));
  ok(applied !== undefined && applied.applied >= 50, `夜间桶校准线实际接管裁决 ${applied ? applied.applied : '—'} 次（不是摆设读数）`);
}

// ═══════════════════ §5 R3-5 结构化审计 ═══════════════════

section('§5 结构化审计：stage / 分数分解 / 标记 / 上下文桶导出');

{
  const engine = new DecisionEngine({ failureEscalationThreshold: 999, strategist: scriptedStrategist([
    { urgency: 0.55, decision: 'execute' },
    { urgency: 0.48, decision: 'defer' },
  ]) });
  engine.attachRationaleCapture();
  engine.attachDecisionHysteresis({ enterHigh: 0.62, exitLow: 0.45, minDwellMs: 0 });
  engine.attachContextCalibrator();

  // 规则 C defer（夜间 → off 桶）
  const NIGHT = new Date('2026-10-02T02:00:00').getTime();
  const history = new Map([['costly', statsOf({ avgTokenCost: 6000 })]]);
  const sig1 = mkSignal({ type: 'costly', urgency: 0.2, receivedAt: NIGHT });
  await decideOne(engine, sig1, history);
  // strategist execute → 滞后间隙保持（0.48 ∈ [exitLow, enterHigh) 间隙）
  const sig2 = mkSignal({ type: 'osc', urgency: 0.55 });
  await decideOne(engine, sig2);
  const sig3 = mkSignal({ type: 'osc', urgency: 0.48 });
  await decideOne(engine, sig3);
  // 回填一条 outcome
  engine.recordOutcome('osc', engine.fingerprint(sig3), 'good');

  const audit = engine.getStructuredAudit(10);
  ok(audit.length === 3, `结构化审计捕获 ${audit.length} 条（rule-C / strategist / strategist）`);
  const rc = audit[0];
  ok(rc.rationale.stage === 'rule-C' && rc.decision.action === 'defer', `stage 分解：规则 C（成本闸门 defer）识别正确`);
  ok(typeof rc.rationale.contextBucket === 'string' && rc.rationale.contextBucket.startsWith('off/'), `上下文桶随行（${rc.rationale.contextBucket}——时段×源信誉×密度的机器可读口径）`);
  const f = Object.fromEntries(rc.rationale.factors.map((x) => [x.name, x.value]));
  ok(f.urgency === 0.2 && typeof f.confidence === 'number' && f.estimatedCost === 6000, `分数分解数值因子：urgency ${f.urgency} / confidence ${f.confidence} / estimatedCost ${f.estimatedCost}`);
  const osc2 = audit[2];
  ok(osc2.rationale.stage === 'strategist' && osc2.rationale.markers.some((m) => m.includes('滞后')), `内核标记捕获：${JSON.stringify(osc2.rationale.markers)}（自由文本 reason 之外的机器可读痕迹）`);
  ok(osc2.outcome === 'good', `结构化条目 outcome 同步回填（${osc2.outcome}）`);

  const bare = new DecisionEngine();
  ok(bare.getStructuredAudit().length === 0, '未挂载捕获 → 导出恒空（零漂移）');
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— 决策引擎第三轮五项升级（滞后/反事实/信息价值门/分桶校准/结构化审计）验证成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
