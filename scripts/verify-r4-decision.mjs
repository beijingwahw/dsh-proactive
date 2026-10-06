/**
 * verify-r4-decision.mjs — 第四轮模块域 A2：决策引擎（decision-engine.ts）
 * 五项全新维度升级的「旧 vs 新」构造对照验证
 *
 *   R4-1 批量联合决策：同批 10 条同类型信号合并执行 1 次 vs 逐条 10 次
 *        （strategist 调用 10 → 1，成本 20000 → 8300，省 58.5%）；互斥
 *        信号（冲突对）四级确定性仲裁（urgency > occurrences > receivedAt
 *        > id），败者 dismiss 胜者执行
 *   R4-2 决策疲劳计量：滑动窗口决策预算，高频低价值流（30 条 u=0.3）
 *        付费决策 30 → 预算 10（低价值 20 条自动推迟）；高价值 u=0.95
 *        带保护线 100% 放行；batch 模式积压 → drain 一次批排还原
 *   R4-3 失败模式聚类：三构造失败模式（20/15/10 条失败）+ 低于下限的
 *        小簇 + 噪声簇——Top-3 精确恢复构造分组（失败率 1.0，成本均值
 *        逐模式吻合），小簇被 minClusterFails 正确排除
 *   R4-4 决策路径解释器：决策序列的解释树逐字段一致（rule-C hit 因子
 *        / cache hit / strategist 突发提权 / 低置信门 / 滞后间隙保持），
 *        final 快照与返回 Decision 逐位相等，递归渲染可读
 *   R4-5 决策撤销协议：execute 开窗（成本估计 = cost×ratio），级联封锁
 *        / 窗口过期 / 重复撤销三态拒撤；合并成员不开窗（以代表为准）
 *
 * 全程离线、确定性（注入时钟 / 脚本化 strategist，无随机无 sleep）。
 * 末尾 PASS n / FAIL m，失败 exit 1。
 *
 * 运行：npm run build && node scripts/verify-r4-decision.mjs
 */

import { DecisionEngine } from '../dist/index.mjs';

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

// ─────────────────────────── 构造工具 ───────────────────────────
let sigSeq = 0;
function mkSignal({ type = 'generic', urgency, source = 'fs:/tmp', receivedAt, occurrences = 1, payload = {}, description } = {}) {
  sigSeq += 1;
  return {
    id: `sig-${type}-${sigSeq}`,
    type,
    description: description ?? `desc-${type}-${sigSeq}`,
    payload,
    urgency,
    receivedAt: receivedAt ?? Date.now(),
    source,
    occurrences,
  };
}

const statsOf = (over = {}) => ({ totalDecisions: 0, successRate: 0.8, avgExecutionTime: 1000, avgTokenCost: 0, ...over });

/** 计数 strategist：恒 execute 裁定 + 回调实调计数（成本对照口径） */
function countingStrategist(state) {
  return (signals) => {
    state.calls += 1;
    const out = new Map();
    for (const s of signals) out.set(s.id, { urgency: s.urgency ?? 0.5, decision: 'execute', reason: '计数裁定' });
    return Promise.resolve(out);
  };
}

/** 脚本化 strategist：按顺序消费 verdict 队列（缺省恒 execute） */
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

// ═══════════════════ §0 零漂移基线 ═══════════════════

section('§0 零漂移：不挂载任何 R4 组件 → 新读数缺席、新入口拒绝、旧行为逐位不变');

{
  const engine = new DecisionEngine();
  ok(engine.fatigueView() === undefined, '疲劳读数缺席（未挂载 → undefined）');
  ok(engine.failureModeView() === undefined, '失败模式读数缺席（未挂载 → undefined）');
  ok(engine.explain('any-id') === undefined, '解释树缺席（未挂载 → undefined）');
  ok(engine.getRecentExplanations().length === 0, '最近解释列表为空（未挂载 → []）');
  ok(engine.undoWindowView().length === 0, '撤销窗口为空（未挂载 → []）');
  const undo = engine.undoDecision('nope');
  ok(undo.undone === false && undo.reason === 'not-found', '撤销协议未挂载 → not-found 拒撤');
  let threw = false;
  try {
    await engine.decideJointly([], new Map());
  } catch {
    threw = true;
  }
  ok(threw, 'decideJointly 未挂载 → 显式抛错（opt-in 语义，不是静默退化）');

  // 旧口径逐位不变：规则 C defer 原字段
  const history = new Map([['costly', statsOf({ avgTokenCost: 6000 })]]);
  const d = await decideOne(engine, mkSignal({ type: 'costly', urgency: 0.2 }), history);
  ok(d.action === 'defer' && d.confidence === 0.7 && d.deferMs === 300000 && d.source === 'rule', `规则 C 原口径逐位不变（defer / 0.7 / 300000ms / rule）`);
  const stats = engine.getStats();
  ok(stats.total === 1 && stats.ruleHits === 1, `统计口径不变（total ${stats.total} / ruleHits ${stats.ruleHits}——无疲劳计数混入）`);
}

// ═══════════════════ §1 R4-1 批量联合决策 ═══════════════════

section('§1 批量联合决策：10 条同类型合并执行 1 次 vs 逐条 10 次（成本/调用对照）');

{
  const history = new Map([['batch', statsOf({ avgTokenCost: 2000 })]]);
  const signals = Array.from({ length: 10 }, (_, i) => mkSignal({ type: 'batch', urgency: 0.4 + i * 0.03 }));

  // 旧口径：逐条 decide——每条各自走 strategist
  const oldState = { calls: 0 };
  const oldEngine = new DecisionEngine({ strategist: countingStrategist(oldState) });
  const oldDecisions = [];
  for (const sig of signals) oldDecisions.push(await decideOne(oldEngine, sig, history));
  const oldCost = oldDecisions.reduce((s, d) => s + (d.estimatedCost ?? 0), 0);
  ok(oldState.calls === 10, `旧口径：10 条信号 → strategist 回调 ${oldState.calls} 次（逐条全量调用）`);
  ok(oldCost === 20000, `旧口径总成本 ${oldCost}（10 × 2000）`);

  // 新口径：联合决策——同组 10 条合并为一次代表性执行
  const newState = { calls: 0 };
  const jointEngine = new DecisionEngine({ strategist: countingStrategist(newState) });
  jointEngine.attachBatchJointDecider({ mergeCostRatio: 0.35, now: () => 1_000_000 });
  const joint = await jointEngine.decideJointly(signals, history);

  ok(newState.calls === 1, `新口径：合并执行 → strategist 回调 ${newState.calls} 次（10 → 1，调用省 90%）`);
  ok(joint.strategistInvocations === 1, `报告口径 strategistInvocations = ${joint.strategistInvocations}（与回调实调一致）`);
  const group = joint.groups[0];
  ok(joint.groups.length === 1 && group.merged === true, `单一合并组（key=${group.key}，10 条 → merged）`);
  ok(group.signalIds.length === 10 && group.representativeId === signals[9].id, `代表 = 紧急度最高者（${group.representativeId}——urgency 四级决胜第一级）`);
  ok(group.action === 'execute', `组终局动作 execute（代表走完整四级流水线）`);
  near(group.jointCost, 2000 * (1 + 9 * 0.35), 1e-9, `联合成本 = c×(1+(n−1)×0.35) = 8300（边际 0.35 的合并模型）`);
  near(group.savedCost, 2000 * 9 * 0.65, 1e-9, `节省成本 = c×(n−1)×(1−ratio) = 11700`);
  near(joint.totalSavedCost, 11700, 1e-9, `总节省 11700（20000 → 8300，省 ${(100 * (1 - 8300 / 20000)).toFixed(1)}%）`);
  ok(joint.decisions.size === 10, `10 条信号全部有决策（成员共享代表终局）`);
  const actions = [...joint.decisions.values()].map((d) => d.action);
  ok(actions.every((a) => a === 'execute'), `全体成员终局一致（execute × 10——合并执行的语义就是同进同出）`);
  const members = [...joint.decisions.values()].filter((d) => d.reason.includes('批次·合并执行'));
  ok(members.length === 9, `9 个成员决策带〔批次·合并执行×10〕标记（代表自身的 reason 不受污染）`);
  ok(members.every((d) => d.estimatedCost === 8300), `成员 estimatedCost = 联合成本 8300（分摊口径而非 20000 重复计费）`);
  const repDecision = joint.decisions.get(group.representativeId);
  ok(repDecision.estimatedCost === 2000 && !repDecision.reason.includes('批次'), `代表决策保持流水线原貌（estimatedCost 2000，无合并标记——审计链不回写）`);
  ok(members.every((d) => d.urgency === repDecision.urgency && d.confidence === repDecision.confidence && d.action === repDecision.action), '成员与代表 (action, urgency, confidence) 逐位一致——合并不是各判各的');
}

section('§1b 批量联合决策：冲突对（互斥信号）确定性联合裁决');

{
  const history = new Map([['deploy', statsOf({ avgTokenCost: 1500 })]]);
  const engine = new DecisionEngine({ strategist: countingStrategist({ calls: 0 }) });
  engine.attachBatchJointDecider({
    conflictKey: (s) => (s.payload.env ? `env:${s.payload.env}` : undefined),
    now: () => 2_000_000,
  });
  const prodA = mkSignal({ type: 'deploy', urgency: 0.9, payload: { env: 'prod' } });
  const prodB = mkSignal({ type: 'deploy', urgency: 0.6, payload: { env: 'prod' } });
  const staging = mkSignal({ type: 'deploy', urgency: 0.5, payload: { env: 'staging' } });
  const joint = await engine.decideJointly([prodA, prodB, staging], history);

  ok(joint.decisions.size === 3, '三条信号全部有裁决（互斥不等于丢弃）');
  const winner = joint.decisions.get(prodA.id);
  const loser = joint.decisions.get(prodB.id);
  const other = joint.decisions.get(staging.id);
  ok(winner.action === 'execute', `互斥胜者（urgency 0.9 > 0.6）execute`);
  ok(loser.action === 'dismiss' && loser.reason.includes('批次·冲突抑制'), `互斥败者 dismiss〔批次·冲突抑制〕——同互斥键只放行一个`);
  ok(loser.reason.includes('urgency 0.90 > 0.60'), `败者 reason 携带仲裁依据（urgency 决胜——第一级）`);
  ok(other.action === 'execute' && other.reason.includes('批次·合并执行'), `非互斥同组信号（env:staging）与胜者合并执行〔批次·合并执行×2〕`);
  const conflict = joint.groups[0].conflicts[0];
  ok(conflict !== undefined && conflict.key === 'env:prod' && conflict.winnerId === prodA.id && conflict.loserIds.length === 1 && conflict.loserIds[0] === prodB.id, `冲突记录结构完整（key env:prod / winner / loser 各就位）`);

  // 四级决胜链第二级：urgency 平手 → occurrences 决胜
  const tieEngine = new DecisionEngine({ strategist: countingStrategist({ calls: 0 }) });
  tieEngine.attachBatchJointDecider({ conflictKey: (s) => (s.payload.env ? `env:${s.payload.env}` : undefined), now: () => 3_000_000 });
  const t1 = mkSignal({ type: 'tie', urgency: 0.7, occurrences: 2, payload: { env: 'prod' } });
  const t2 = mkSignal({ type: 'tie', urgency: 0.7, occurrences: 5, payload: { env: 'prod' } });
  const tieJoint = await tieEngine.decideJointly([t1, t2], new Map());
  ok(tieJoint.decisions.get(t2.id).action !== 'dismiss' && tieJoint.decisions.get(t1.id).action === 'dismiss', `urgency 平手 → occurrences 决胜（5 > 2 胜出——第二级兜底）`);
  ok(tieJoint.decisions.get(t1.id).reason.includes('occurrences 5 > 2'), `败者 reason 记录第二级依据（occurrences）`);

  // 决胜链第三级：全部平手 → 先到者（receivedAt 小者）胜
  const rt = 5_000_000;
  const e1 = mkSignal({ type: 'race', urgency: 0.7, occurrences: 3, receivedAt: rt + 1000, payload: { env: 'prod' } });
  const e2 = mkSignal({ type: 'race', urgency: 0.7, occurrences: 3, receivedAt: rt, payload: { env: 'prod' } });
  const raceJoint = await tieEngine.decideJointly([e1, e2], new Map());
  ok(raceJoint.decisions.get(e2.id).action !== 'dismiss' && raceJoint.decisions.get(e1.id).action === 'dismiss', `urgency/occurrences 全平 → 先到者胜（receivedAt 决胜——第三级，全平不可能再下沉到 id 级）`);
}

// ═══════════════════ §2 R4-2 决策疲劳计量 ═══════════════════

section('§2 决策疲劳：高频低价值流的预算保护（30 条 u=0.3 → 付费 30 → 10）');

{
  // 旧口径：无疲劳防护——30 条低价值信号全部付费决策
  const oldEngine = new DecisionEngine({ strategist: countingStrategist({ calls: 0 }) });
  let oldExecuted = 0;
  for (let i = 0; i < 30; i += 1) {
    const d = await decideOne(oldEngine, mkSignal({ type: 'flood', urgency: 0.3 }));
    if (d.action === 'execute') oldExecuted += 1;
  }
  ok(oldExecuted === 30, `旧口径：30 条低价值信号全部执行（${oldExecuted}/30——高频流无节流）`);

  // 新口径：10 秒窗口预算 10——低价值 (u<0.5) 超限自动推迟
  let clock = 10_000_000;
  const engine = new DecisionEngine({ strategist: countingStrategist({ calls: 0 }) });
  engine.attachFatigueGuard({
    windowMs: 10_000,
    budgetPerWindow: 10,
    lowValueUrgencyBelow: 0.5,
    highValueUrgency: 0.8,
    deferMs: 5_000,
    now: () => {
      clock += 100;
      return clock;
    },
  });
  let executed = 0;
  let deferredByFatigue = 0;
  for (let i = 0; i < 30; i += 1) {
    const d = await decideOne(engine, mkSignal({ type: 'flood', urgency: 0.3 }));
    if (d.action === 'execute') executed += 1;
    if (d.action === 'defer' && d.reason.includes('疲劳防护')) deferredByFatigue += 1;
  }
  console.log(`  付费决策对照：旧 ${oldExecuted} → 新 ${executed}（低价值推迟 ${deferredByFatigue} 条，省 ${(100 * (1 - executed / oldExecuted)).toFixed(0)}%）`);
  ok(executed === 10, `预算内放行恰好 10 条（预算 10/10s——第 11 条起低价值被节流）`);
  ok(deferredByFatigue === 20, `超预算的 20 条低价值信号全部推迟（〔疲劳防护〕标记 + deferMs 5000）`);

  // 高价值信号：预算耗尽后仍 100% 放行（保护线）
  const highValue = await decideOne(engine, mkSignal({ type: 'critical', urgency: 0.95 }));
  ok(highValue.action === 'execute' && !highValue.reason.includes('疲劳防护'), `高价值信号（u=0.95 ≥ 0.8）预算耗尽仍执行——保护线不是摆设`);

  const view = engine.fatigueView();
  ok(view !== undefined && view.state === 'fatigued' && view.used === 11, `读数：state=${view ? view.state : '—'}，used=${view ? view.used : '—'}（10 低价值 + 1 高价值放行，推迟不占预算）`);
  ok(view.deferred === 20 && view.protectedPassed === 1, `读数：deferred ${view.deferred} / protectedPassed ${view.protectedPassed}（节流与保护各自计数）`);
  near(view.ratePerWindow, 1.1, 1e-9, '窗口速率 1.1 = used/budget（超 1.0 即疲劳态）');

  // 中间带（0.5 ≤ u < 0.8）：预算耗尽也放行（只节流低价值）
  const mid = await decideOne(engine, mkSignal({ type: 'midband', urgency: 0.6 }));
  ok(mid.action === 'execute', `中间带信号（u=0.6）预算耗尽仍放行——疲劳不是一刀切`);

  // 窗口滑动恢复：时钟越过窗口后预算回满
  clock += 11_000;
  const recovered = engine.fatigueView();
  ok(recovered.state === 'ok' && recovered.used === 0, `时钟越过窗口 → 预算回满（state ${recovered.state} / used ${recovered.used}——滑动窗口语义）`);
}

section('§2b 疲劳 batch 模式：积压 → drain 一次批排还原（合并回收）');

{
  let clock = 20_000_000;
  const state = { calls: 0 };
  const engine = new DecisionEngine({ strategist: countingStrategist(state) });
  engine.attachFatigueGuard({
    windowMs: 5_000,
    budgetPerWindow: 8,
    lowValueUrgencyBelow: 0.5,
    mode: 'batch',
    now: () => {
      clock += 50;
      return clock;
    },
  });
  const backlogIds = [];
  let executed = 0;
  for (let i = 0; i < 12; i += 1) {
    const sig = mkSignal({ type: 'burst-flood', urgency: 0.3 });
    const d = await decideOne(engine, sig);
    if (d.action === 'execute') executed += 1;
    if (d.reason.includes('积压')) backlogIds.push(sig.id);
  }
  ok(executed === 8 && backlogIds.length === 4, `预算 8：${executed} 条放行 + ${backlogIds.length} 条入积压（〔疲劳防护·积压〕而非丢弃）`);
  const midView = engine.fatigueView();
  ok(midView.backlog === 4 && midView.deferred === 4, `读数：backlog ${midView.backlog}（batch 模式的待回收队列）`);

  clock += 6_000; // 越过窗口 → 预算回满
  const callsBefore = state.calls;
  const drained = await engine.drainFatigueBacklog(new Map());
  ok(drained.size === 4 && [...drained.values()].every((d) => d.action === 'execute'), `drain 还原 ${drained.size} 条积压信号（预算恢复后全部重新决策执行）`);
  ok(state.calls - callsBefore === 1, `批排回收只花 ${state.calls - callsBefore} 次 strategist 调用（4 条一批——疲劳后的合并回收）`);
  const afterView = engine.fatigueView();
  ok(afterView.backlog === 0 && afterView.drained === 4, `读数：backlog ${afterView.backlog} 清零 / drained ${afterView.drained}（回收账目清楚）`);
}

// ═══════════════════ §3 R4-3 失败模式聚类 ═══════════════════

section('§3 失败模式聚类：三构造失败模式 Top-3 精确恢复（20/15/10，率 1.0）');

{
  const engine = new DecisionEngine({ failureEscalationThreshold: 999, strategist: countingStrategist({ calls: 0 }) });
  engine.attachFailureModeClusterer({ minClusterFails: 3 });

  const NIGHT = new Date('2026-10-02T02:00:00').getTime();
  const DAY = new Date('2026-10-02T14:00:00').getTime();
  const costly = new Map([
    ['costly-defer', statsOf({ avgTokenCost: 6000 })],
    ['strat-exec', statsOf({ avgTokenCost: 2000 })],
    ['heavy-exec', statsOf({ avgTokenCost: 15000 })],
  ]);

  // 模式 P1：夜间 × 低信誉源(fs) × u∈[0.2,0.4) × rule-C defer × 成本 1k-10k → 全失败 ×20
  // 模式 P2：白天 × manual 高信誉 × u≥0.8 × strategist execute × 成本 1k-10k → 全失败 ×15
  // 模式 P3：白天 × 低信誉源(fs) × u∈[0.4,0.6) × execute × 成本 ≥10k → 全失败 ×10
  // 小簇 S：u<0.2 的夜间 defer 失败 ×2（< minClusterFails=3 → 不入 Top）
  // 噪声 N：无成本 execute × good ×25（失败 0 → 不入 Top）
  const run = async (type, expect, history, count, outcome, mk) => {
    for (let i = 0; i < count; i += 1) {
      const sig = mk(i);
      const d = await decideOne(engine, sig, history);
      if (d.action !== expect) throw new Error(`构造前提被破坏：${type} 期望 ${expect} 实得 ${d.action}`);
      engine.recordOutcome(sig.type, engine.fingerprint(sig), outcome);
    }
  };

  await run('costly-defer', 'defer', costly, 20, 'failed', (i) => mkSignal({ type: 'costly-defer', urgency: 0.25, source: 'fs:/night', receivedAt: NIGHT, description: `p1-${i}` }));
  await run('strat-exec', 'execute', costly, 15, 'failed', (i) => mkSignal({ type: 'strat-exec', urgency: 0.85, source: 'manual', receivedAt: DAY, description: `p2-${i}` }));
  await run('heavy-exec', 'execute', costly, 10, 'failed', (i) => mkSignal({ type: 'heavy-exec', urgency: 0.5, source: 'fs:/a', receivedAt: DAY, description: `p3-${i}` }));
  await run('minor-fail', 'defer', new Map([['minor-fail', statsOf({ avgTokenCost: 6000 })]]), 2, 'failed', (i) => mkSignal({ type: 'minor-fail', urgency: 0.15, source: 'fs:/minor', receivedAt: NIGHT, description: `s-${i}` }));
  await run('noise', 'execute', new Map(), 25, 'good', (i) => mkSignal({ type: 'noise', urgency: 0.35, source: 'fs:/b', receivedAt: DAY, description: `n-${i}` }));

  const view = engine.failureModeView();
  ok(view !== undefined, '聚类读数产出（挂载即生效）');
  ok(view.totalTracked === 72 && view.totalFails === 47, `账目：追踪 ${view.totalTracked} 样本 / 失败 ${view.totalFails}（20+15+10+2）`);
  ok(view.clusters.length === 3, `Top 输出恰 3 簇（小簇 2 失败 < minClusterFails 3 被排除；噪声簇 0 失败出局——实际 ${view.clusters.length}）`);

  const [c1, c2, c3] = view.clusters;
  ok(c1.key === 'off·trust-lo·u0.2-0.4·defer·cost1k-10k' && c1.fails === 20, `Top1 = 夜间低信誉 defer 簇（${c1.key}，失败 ${c1.fails} 条）`);
  ok(c2.key === 'work·trust-hi·u>=0.8·execute·cost1k-10k' && c2.fails === 15, `Top2 = 白天高信誉 execute 簇（${c2.key}，失败 ${c2.fails} 条）`);
  ok(c3.key === 'work·trust-lo·u0.4-0.6·execute·cost>=10k' && c3.fails === 10, `Top3 = 白天低信誉高成本簇（${c3.key}，失败 ${c3.fails} 条）`);
  near(c1.failureRate, 1, 1e-9, 'Top1 失败率 1.0（纯失败模式——聚类恢复构造分组）');
  near(c2.failureRate, 1, 1e-9, 'Top2 失败率 1.0');
  near(c3.failureRate, 1, 1e-9, 'Top3 失败率 1.0');
  ok(c1.wilsonHigh >= c1.failureRate && c2.wilsonHigh >= c2.failureRate, 'Wilson 上界覆盖失败率（排序次键的不确定性口径）');
  near(c1.meanFailedCost, 6000, 1e-9, 'Top1 失败平均成本 6000（rule-C defer 的 estimatedCost）');
  near(c2.meanFailedCost, 2000, 1e-9, 'Top2 失败平均成本 2000（strategist 注入）');
  near(c3.meanFailedCost, 15000, 1e-9, 'Top3 失败平均成本 15000（历史成本携带）');
  ok(typeof c1.sampleReason === 'string' && c1.sampleReason.length > 0, '簇内保留典型失败样本 reason（可追溯到具体决策形态）');
  ok(view.clusters.every((c, i, arr) => i === 0 || arr[i - 1].fails >= c.fails), '确定性排序：失败数降序（平局 → 失败率 → 簇键字典序）');
}

// ═══════════════════ §4 R4-4 决策路径解释器 ═══════════════════

section('§4 决策路径解释器：解释树与决策过程逐字段一致');

{
  const NIGHT = new Date('2026-10-02T02:00:00').getTime();
  const history = new Map([['costly', statsOf({ avgTokenCost: 6000 })]]);
  const engine = new DecisionEngine({ strategist: scriptedStrategist([]) });
  engine.attachPathExplainer();

  // (a) rule-C defer：解释树 = 规则 A/B miss → 规则 C hit（因子现场值）→ cache skipped
  const sigA = mkSignal({ type: 'costly', urgency: 0.2, receivedAt: NIGHT });
  const decisionA = await decideOne(engine, sigA, history);
  const explA = engine.explain(sigA.id);
  ok(explA !== undefined, 'rule-C 路径解释树产出');
  const stagesA = explA.pipeline.map((n) => `${n.node}:${n.status}`);
  ok(
    stagesA.join(' | ') === 'rule-A:miss | rule-B:miss | rule-C:hit | cache:skipped',
    `流水线级序与状态：${stagesA.join(' | ')}（终止级之后补 skipped）`,
  );
  const rcNode = explA.pipeline.find((n) => n.node === 'rule-C');
  const rcFactors = Object.fromEntries(rcNode.factors.map((f) => [f.name, f.value]));
  ok(rcFactors.urgency === 0.2 && rcFactors.estimatedCost === 6000 && rcFactors.lowUrgencyLine === 0.3, `rule-C 因子 = 决策现场值（urgency ${rcFactors.urgency} / cost ${rcFactors.estimatedCost} / 线 ${rcFactors.lowUrgencyLine}）`);
  ok(explA.final.action === decisionA.action && explA.final.confidence === decisionA.confidence && explA.final.urgency === decisionA.urgency && explA.final.deferMs === decisionA.deferMs && explA.final.estimatedCost === decisionA.estimatedCost && explA.final.source === decisionA.source, 'final 快照与返回 Decision 逐字段相等（action/confidence/urgency/deferMs/estimatedCost/source）');
  ok(explA.fingerprint === engine.fingerprint(sigA), '解释树携带信号指纹（与 recordOutcome 配对协议同键）');
  ok(explA.rendered.includes('rule-C') && explA.rendered.includes('[hit]') && explA.rendered.includes('cache') && explA.rendered.includes('[skipped]'), '递归渲染可读（级名 + 状态 + 缩进树）');
  console.log('  渲染样例（rule-C defer）：');
  for (const line of explA.rendered.split('\n')) console.log(`    ${line}`);

  // (b) 缓存命中：同指纹重放 → cache [hit] 节点（hits / adjustedConfidence 因子）
  const sigB1 = mkSignal({ type: 'cacheme', urgency: 0.5 });
  const firstB = await decideOne(engine, sigB1);
  const sigB2 = { ...sigB1, id: `${sigB1.id}-replay`, receivedAt: sigB1.receivedAt + 1000 };
  const decisionB = await decideOne(engine, sigB2);
  const explB = engine.explain(sigB2.id);
  ok(firstB.source === 'strategist' && decisionB.source === 'cache', `首判 strategist → 同指纹重放 cache（decision.source=${decisionB.source}）`);
  const cacheNode = explB.pipeline.find((n) => n.node === 'cache');
  ok(cacheNode.status === 'hit', `解释树 cache [hit]（与决策来源一致）`);
  const cacheFactors = Object.fromEntries(cacheNode.factors.map((f) => [f.name, f.value]));
  ok(cacheFactors.hits === 1 && cacheFactors.adjustedConfidence === decisionB.confidence, `cache 因子与决策一致（hits ${cacheFactors.hits} / adjustedConfidence ${cacheFactors.adjustedConfidence.toFixed(3)} = decision.confidence）`);
  ok(explB.final.action === decisionB.action && explB.final.confidence === decisionB.confidence, '缓存路径 final 快照同样逐位一致');

  // (c) strategist 突发提权：verdictUrgency 0.5 → urgency 0.7（occurrences 6 ≥ 5）
  const sigC = mkSignal({ type: 'burst', urgency: 0.5, occurrences: 6 });
  const decisionC = await decideOne(engine, sigC);
  const explC = engine.explain(sigC.id);
  const stratNode = explC.pipeline.find((n) => n.node === 'strategist');
  ok(stratNode !== undefined && stratNode.status === 'applied', 'strategist 级留痕（applied）');
  const stratFactors = Object.fromEntries(stratNode.factors.map((f) => [f.name, f.value]));
  ok(stratFactors.verdictUrgency === 0.5 && stratFactors.urgency === 0.7 && decisionC.urgency === 0.7, `突发提权因子与决策一致（verdict 0.5 → 提权后 0.7 = decision.urgency）`);
  ok(stratNode.detail.includes('突发提权'), '提权依据写入结论文本（+0.2 来自 occurrences ≥ burstOccurrences）');
  ok(!stratNode.children.some((c) => c.node === 'low-confidence-gate'), '置信度未触阈 → 无低置信门子节点（子内核只在真正评估时出现）');

  // (d) 低置信门（旧规则路径）：confidence 0.65 < 0.7 → ask-user，子节点留痕
  const gatedEngine = new DecisionEngine({ lowConfidenceThreshold: 0.7, strategist: scriptedStrategist([{ urgency: 0.6, decision: 'execute' }]) });
  gatedEngine.attachPathExplainer();
  const sigD = mkSignal({ type: 'gated' });
  const decisionD = await decideOne(gatedEngine, sigD);
  const explD = gatedEngine.explain(sigD.id);
  const stratNodeD = explD.pipeline.find((n) => n.node === 'strategist');
  const gateNodeD = stratNodeD.children.find((c) => c.node === 'low-confidence-gate');
  ok(decisionD.action === 'ask-user' && gateNodeD !== undefined && gateNodeD.status === 'applied', `低置信门子节点 [applied]（decision.action=${decisionD.action} 一致）`);
  const gateFactors = Object.fromEntries(gateNodeD.factors.map((f) => [f.name, f.value]));
  ok(gateFactors.confidence === 0.65 && gateFactors.lowConfidenceThreshold === 0.7, `门因子：confidence 0.65 < 阈值 0.7（触发升级的数值现场）`);
  ok(gateNodeD.detail.includes('旧规则'), '旧规则升级路径在解释树中可辨（未挂 95.0/97.0 成本口径）');

  // (e) 滞后间隙保持：verdict defer 但落在 [exitLow, enterHigh) 间隙 → 保持 execute + 标记
  const hystEngine = new DecisionEngine({ strategist: scriptedStrategist([
    { urgency: 0.9, decision: 'execute' },
    { urgency: 0.5, decision: 'defer' },
  ]) });
  hystEngine.attachPathExplainer();
  hystEngine.attachDecisionHysteresis({ enterHigh: 0.65, exitLow: 0.45, minDwellMs: 0 });
  const sigE1 = mkSignal({ type: 'osc', urgency: 0.9 });
  const dE1 = await decideOne(hystEngine, sigE1);
  const sigE2 = mkSignal({ type: 'osc', urgency: 0.5 });
  const dE2 = await decideOne(hystEngine, sigE2);
  const explE1 = hystEngine.explain(sigE1.id);
  const explE2 = hystEngine.explain(sigE2.id);
  ok(dE1.action === 'execute' && explE1.pipeline.some((n) => n.node === 'hysteresis' && n.status === 'pass-through'), '首决策：hysteresis [pass-through]（建态 execute，不算换向）');
  const hystNode2 = explE2.pipeline.find((n) => n.node === 'hysteresis');
  ok(hystNode2.status === 'applied' && hystNode2.detail.includes('间隙'), `第二次决策：hysteresis [applied] 间隙保持（verdict defer u=0.5 ∈ [0.45, 0.65) 间隙）`);
  ok(dE2.action === 'execute' && explE2.final.action === 'execute', `滞后改写后的终局 execute 与解释树 final 一致（快照拍在改写之后）`);
  ok(explE2.markers.includes('滞后·间隙保持'), `内核标记捕获：${JSON.stringify(explE2.markers)}（reason 〔〕标记的机器可读镜像）`);
  ok(hystEngine.explain('nonexistent') === undefined, '无记录 signalId → undefined（诚实缺席）');
  ok(hystEngine.getRecentExplanations(10).length === 2, '最近解释列表按决策序产出');
}

section('§4b 解释器 × 联合决策：合并成员的解释树（共享代表 + 顺序级 skipped）');

{
  const jointEngine = new DecisionEngine({ strategist: countingStrategist({ calls: 0 }) });
  jointEngine.attachBatchJointDecider({ now: () => 30_000_000 });
  jointEngine.attachPathExplainer();
  const signals = Array.from({ length: 3 }, (_, i) => mkSignal({ type: 'joint-expl', urgency: 0.6 + i * 0.05 }));
  const joint = await jointEngine.decideJointly(signals, new Map([['joint-expl', statsOf({ avgTokenCost: 1000 })]]));
  const repId = joint.groups[0].representativeId;
  const memberId = signals.find((s) => s.id !== repId && joint.decisions.get(s.id).reason.includes('批次·合并执行')).id;
  const memberExpl = jointEngine.explain(memberId);
  ok(memberExpl !== undefined && memberExpl.pipeline[0].node === 'joint-batch', '合并成员解释树产出（首节点 = joint-batch 联合层）');
  ok(memberExpl.pipeline[0].detail.includes('共享代表'), `联合层结论：${memberExpl.pipeline[0].detail.slice(0, 46)}…`);
  ok(memberExpl.pipeline.filter((n) => n.status === 'skipped').length === 5, '成员未单独过流水线：五个顺序级全部 skipped 留痕（诚实记录「共享代表」）');
  ok(memberExpl.final.action === joint.decisions.get(memberExpl.signalId).action, '成员解释 final 与其决策一致');
  ok(jointEngine.explain(repId).pipeline.some((n) => n.node === 'strategist'), '代表的解释树仍是完整四级流水线（strategist 级在案）');
}

// ═══════════════════ §5 R4-5 决策撤销协议 ═══════════════════

section('§5 决策撤销协议：execute 开窗 / 成本估计 / 级联封锁 / 窗口过期');

{
  let clock = 40_000_000;
  const engine = new DecisionEngine({ strategist: countingStrategist({ calls: 0 }) });
  engine.attachUndoProtocol({ windowMs: 1000, undoCostRatio: 0.2, defaultCost: 1000, now: () => clock });

  // execute（estimatedCost 6000）→ 开窗；撤销成本 = 6000×0.2 = 1200
  const sig1 = mkSignal({ type: 'undoable', urgency: 0.85 });
  const d1 = await decideOne(engine, sig1, new Map([['undoable', statsOf({ avgTokenCost: 6000 })]]));
  ok(d1.action === 'execute', '构造前提：execute 决策');
  const windows = engine.undoWindowView();
  ok(windows.length === 1 && windows[0].signalId === sig1.id, `execute 落定自动开撤销窗（${windows.length} 扇，signalId 对齐）`);
  near(windows[0].costEstimate, 1200, 1e-9, `撤销成本估计 = 6000×0.2 = 1200（estimatedCost × undoCostRatio）`);
  const undo1 = engine.undoDecision(sig1.id);
  ok(undo1.undone === true && undo1.costEstimate === 1200 && undo1.windowRemainingMs > 0, `窗口内撤销成功（成本估计 1200，剩余 ${undo1.windowRemainingMs}ms）`);
  const undoAgain = engine.undoDecision(sig1.id);
  ok(undoAgain.undone === false && undoAgain.reason === 'not-found', `重复撤销 → not-found（撤销即销账，幂等拒绝）`);

  // 级联封锁
  const sig2 = mkSignal({ type: 'undoable', urgency: 0.85 });
  await decideOne(engine, sig2, new Map([['undoable', statsOf({ avgTokenCost: 6000 })]]));
  ok(engine.markCascade(engine.fingerprint(sig2)) === true, 'markCascade 支持指纹寻址（与 recordOutcome 同键）');
  const undo2 = engine.undoDecision(sig2.id);
  ok(undo2.undone === false && undo2.reason === 'cascaded', '已级联 → 拒撤（级联扩散后撤销代价不可控）');

  // 窗口过期
  const sig3 = mkSignal({ type: 'undoable', urgency: 0.85 });
  await decideOne(engine, sig3, new Map([['undoable', statsOf({ avgTokenCost: 6000 })]]));
  const beforeExpiry = engine.undoWindowView().length;
  clock += 1500; // 越过 1000ms 窗口
  const undo3 = engine.undoDecision(sig3.id);
  ok(undo3.undone === false && undo3.reason === 'window-expired', `窗口过期 → 拒撤（注入时钟推进 1500ms > 1000ms）`);

  // defer 决策不开窗（计数对照）
  const deferSig = mkSignal({ type: 'costly-def', urgency: 0.2 });
  await decideOne(engine, deferSig, new Map([['costly-def', statsOf({ avgTokenCost: 6000 })]]));
  ok(engine.undoWindowView().length === beforeExpiry, `defer 决策不开撤销窗（窗数 ${beforeExpiry} → ${engine.undoWindowView().length} 不变——只对 execute 负责）`);
  ok(engine.undoDecision(deferSig.id).reason === 'not-found', 'defer 撤销 → not-found');

  // 合并成员不开窗（以代表为准）
  const jointEngine = new DecisionEngine({ strategist: countingStrategist({ calls: 0 }) });
  jointEngine.attachBatchJointDecider({ now: () => clock });
  jointEngine.attachUndoProtocol({ windowMs: 1000, undoCostRatio: 0.2, now: () => clock });
  const merged = Array.from({ length: 3 }, (_, i) => mkSignal({ type: 'joint-undo', urgency: 0.7 + i * 0.05 }));
  const joint = await jointEngine.decideJointly(merged, new Map([['joint-undo', statsOf({ avgTokenCost: 1000 })]]));
  const openWindows = jointEngine.undoWindowView();
  ok(openWindows.length === 1 && openWindows[0].signalId === joint.groups[0].representativeId, `合并执行 3 条只开 1 扇窗（代表为准——成员 skipUndo，撤销语义不重复）`);
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— 决策引擎第四轮五项升级（批量联合/疲劳计量/失败聚类/路径解释器/撤销协议）验证成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
