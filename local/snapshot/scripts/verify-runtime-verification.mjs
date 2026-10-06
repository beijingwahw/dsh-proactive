/**
 * verify-runtime-verification.mjs — 15.0「运行时验证」质变闭环离线验证
 *
 * 升级前后的分水岭：
 *   治理器的全部约束都是标量门控——限流是计数、熔断是计数、预算是
 *   求和。它们只能回答「此刻过不过」，表达不了「熔断打开后 10 分钟
 *   内必须恢复」「失败风暴 1 分钟内不得超过 5 次」这类事件之间的
 *   时序关系；拦截了什么只有孤立日志，没有「违反了哪条规约、
 *   见证事件序列是什么」的证明结构。
 *   运行时验证：安全性质写成声明式规约（模式 × 参数 × 严重级），
 *   编译为 O(1) 确定性监视器；违规报告携带可机器重放的见证轨迹；
 *   分级升级通道让形式裁决获得治理的牙齿（critical → Kill Switch）。
 *
 * 闭环断言：
 *   A absence：禁令即违规 + 规约原文随报告携带
 *   B response-deadline：按时响应零违规；到期未响应 → 沉默违规
 *   C bounded-recurrence：滑动窗口计数违规 + 旧事件出窗豁免
 *   D precedence：先来后到（未初始化就使用 → 违规）
 *   E 证明携带裁决：witness 是可机器重放的事件序列
 *   F 确定性重放：同一事件流 → 严格相同的违规集
 *   G 终态与重武装：违规只报一次；reset 后重新武装；注册幂等
 *   H 治理器集成（分水岭）：失败风暴 → critical → Kill Switch；
 *     warn 违规计入失败压力；审计携带 [formal] 标记
 *   I 缺省零漂移：不挂载 → 无形式验证面板
 *
 * 运行：npm run build && node scripts/verify-runtime-verification.mjs
 */

import { RuntimeVerifier, defaultSafetySpecs, SafetyGovernor } from '../dist/index.mjs';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════ A absence ═══════════════════

section('A absence：p 永不发生——禁令即违规');

{
  const spec = { id: 'no-panic', pattern: 'absence', trigger: 'panic', severity: 'critical', description: '内核禁止 panic' };
  const v = new RuntimeVerifier([spec]);
  ok(v.observe({ type: 'normal-op', at: 0 }).length === 0, '普通事件零违规');
  const vios = v.observe({ type: 'panic', at: 100, detail: { source: 'kernel' } });
  ok(vios.length === 1, '禁令事件发生 → 立即违规');
  const r = vios[0];
  ok(r.specId === 'no-panic' && r.pattern === 'absence' && r.severity === 'critical', '报告引用规约（id/模式/严重级）');
  ok(r.at === 100 && r.witness.length === 1 && r.witness[0].type === 'panic', '违规时刻与见证 = 违规事件本身');
  ok(r.spec.trigger === 'panic' && r.spec.description === '内核禁止 panic', '规约原文随报告携带（审计可引用）');
}

// ═══════════════════ B response-deadline ═══════════════════

section('B response-deadline：p → q within T——不响应也是违规');

{
  // 按时响应
  const v1 = new RuntimeVerifier([
    { id: 'recover', pattern: 'response-deadline', trigger: 'start', responder: 'finish', withinMs: 1000, severity: 'warn' },
  ]);
  v1.observe({ type: 'start', at: 0 });
  ok(v1.status().pendingObligations === 1, 'trigger 产生一项在途义务（运维可观测）');
  const vios = v1.observe({ type: 'finish', at: 500 });
  ok(vios.length === 0 && v1.status().pendingObligations === 0, '按时响应 → 义务清偿零违规');

  // 沉默违规：期限到期仍未响应
  const v2 = new RuntimeVerifier([
    { id: 'recover', pattern: 'response-deadline', trigger: 'start', responder: 'finish', withinMs: 1000, severity: 'warn' },
  ]);
  v2.observe({ type: 'start', at: 0 });
  const late = v2.observe({ type: 'unrelated', at: 2000 });
  ok(late.length === 1 && late[0].specId === 'recover', '到期未响应 → 沉默违规（无 responder 事件也算违规）');
  ok(late[0].message.includes('未出现') && late[0].at === 2000, '违规说明指向缺失的响应义务');
  ok(late[0].witness.length === 1 && late[0].witness[0].type === 'start', '见证轨迹携带未清偿的 trigger 事件');
}

// ═══════════════════ C bounded-recurrence ═══════════════════

section('C bounded-recurrence：滑动窗口 W 内 p 至多 k 次');

{
  const spec = { id: 'storm', pattern: 'bounded-recurrence', trigger: 'action-failed', maxCount: 2, windowMs: 1000, severity: 'critical' };

  const v = new RuntimeVerifier([spec]);
  ok(v.observe({ type: 'action-failed', at: 0 }).length === 0, '第 1 次失败（≤ 上限 2）');
  ok(v.observe({ type: 'action-failed', at: 500 }).length === 0, '第 2 次失败（= 上限 2，未超）');
  const vios = v.observe({ type: 'action-failed', at: 900 });
  ok(vios.length === 1 && vios[0].specId === 'storm' && vios[0].severity === 'critical', '窗口内第 3 次 → 风暴确证');
  ok(vios[0].witness.length === 3, '见证轨迹 = 窗口内全部 3 个事件（可重放风暴全貌）');

  // 旧事件滑出窗口后不再计数
  const v2 = new RuntimeVerifier([spec]);
  v2.observe({ type: 'action-failed', at: 0 });
  v2.observe({ type: 'action-failed', at: 500 });
  ok(v2.observe({ type: 'action-failed', at: 2000 }).length === 0, '旧事件出窗豁免（0/500ms 滑出，仅剩 1 次在窗）');
}

// ═══════════════════ D precedence ═══════════════════

section('D precedence：q 出现前必须发生过 p（先来后到）');

{
  const spec = { id: 'init-before-use', pattern: 'precedence', trigger: 'init', responder: 'use', severity: 'critical' };
  const v = new RuntimeVerifier([spec]);
  const vios = v.observe({ type: 'use', at: 10 });
  ok(vios.length === 1 && vios[0].specId === 'init-before-use', '未初始化就使用 → 违规');

  const v2 = new RuntimeVerifier([spec]);
  v2.observe({ type: 'init', at: 0 });
  ok(v2.observe({ type: 'use', at: 10 }).length === 0, '先 init 后 use → 合规');
  ok(v2.observe({ type: 'use', at: 20 }).length === 0, 'init 一次，后续 use 全部合规（记忆保持）');
}

// ═══════════════════ E 证明携带裁决 ═══════════════════

section('E 证明携带裁决：见证轨迹是带时间戳的可重放事件序列');

{
  const v = new RuntimeVerifier([
    { id: 'storm', pattern: 'bounded-recurrence', trigger: 'action-failed', maxCount: 1, windowMs: 10_000, severity: 'critical' },
  ]);
  v.observe({ type: 'boot', at: 0 });
  v.observe({ type: 'action-failed', at: 100, detail: { task: 't1' } });
  const vios = v.observe({ type: 'action-failed', at: 300, detail: { task: 't2' } });
  ok(vios.length === 1, '两连败确证风暴');
  const w = vios[0].witness;
  ok(
    w.length === 2 &&
      w[0].type === 'action-failed' && w[0].at === 100 && w[0].detail.task === 't1' &&
      w[1].type === 'action-failed' && w[1].at === 300 && w[1].detail.task === 't2',
    '见证保留完整上下文（类型/时间戳/detail——重放可复原现场）',
  );
  // 见证可独立重放：喂给全新监视器得到相同裁决
  const replay = new RuntimeVerifier([
    { id: 'storm', pattern: 'bounded-recurrence', trigger: 'action-failed', maxCount: 1, windowMs: 10_000, severity: 'critical' },
  ]);
  const replayed = w.flatMap((e) => replay.observe(e));
  ok(replayed.length === 1 && replayed[0].specId === 'storm', '见证轨迹独立重放 → 相同裁决（证明的机器可验证性）');
}

// ═══════════════════ F 确定性重放 ═══════════════════

section('F 确定性重放：同一事件流 → 严格相同的违规集');

{
  const specs = [
    { id: 'no-panic', pattern: 'absence', trigger: 'panic', severity: 'critical' },
    { id: 'recover', pattern: 'response-deadline', trigger: 'breaker-opened', responder: 'breaker-closed', withinMs: 100, severity: 'warn' },
    { id: 'storm', pattern: 'bounded-recurrence', trigger: 'action-failed', maxCount: 2, windowMs: 100, severity: 'critical' },
  ];
  const events = [
    { type: 'boot', at: 0 },
    { type: 'action-failed', at: 10 },
    { type: 'action-failed', at: 20 },
    { type: 'action-failed', at: 30 },
    { type: 'breaker-opened', at: 40 },
    { type: 'breaker-closed', at: 60 },
    { type: 'panic', at: 80 },
    { type: 'action-failed', at: 90 },
  ];
  const run = () => {
    const v = new RuntimeVerifier(specs.map((s) => ({ ...s })));
    for (const e of events) v.observe({ ...e });
    return v.violationHistory.map((r) =>
      JSON.stringify({ specId: r.specId, at: r.at, message: r.message, witness: r.witness.map((w) => [w.type, w.at]) }),
    );
  };
  const a = run();
  const b = run();
  ok(a.length === 2, `事件流产生 2 条违规（storm 于 t=30 + no-panic 于 t=80；recover 被按时清偿）`);
  ok(JSON.stringify(a) === JSON.stringify(b), '两次独立运行违规集逐字节相同（确定性 = 可审计）');
}

// ═══════════════════ G 终态与重武装 ═══════════════════

section('G 终态与重武装：违规只报一次；reset 重新武装；注册幂等');

{
  const v = new RuntimeVerifier([{ id: 'no-panic', pattern: 'absence', trigger: 'panic', severity: 'critical' }]);
  v.observe({ type: 'panic', at: 0 });
  ok(v.observe({ type: 'panic', at: 1 }).length === 0, '终态监视器静默吞事件（违规只报一次）');
  let st = v.status();
  ok(st.violatedMonitors === 1 && st.activeMonitors === 0 && st.totalViolations === 1, '状态面板：1 终态 / 0 在监 / 1 违规');

  ok(v.resetMonitor('no-panic') === true && v.resetMonitor('no-panic') === true, '重武装幂等（规约存在即成功，重复 reset 无副作用）');
  ok(v.observe({ type: 'panic', at: 2 }).length === 1 && v.status().totalViolations === 2, '重新武装后再次监视并确证');

  const extra = { id: 'extra', pattern: 'absence', trigger: 'oops', severity: 'info' };
  v.register(extra);
  v.register({ ...extra });
  ok(v.status().specs === 2, '重复注册幂等（by id）');
  ok(v.unregister('extra') === true && v.unregister('extra') === false, '注销规约（幂等返回）');
  ok(v.unregister('nonexistent') === false, '注销不存在规约返回 false');
  ok(v.status().specs === 1, '规约生命周期闭环');
}

// ═══════════════════ H 治理器集成（分水岭） ═══════════════════

section('H 治理器集成：失败风暴 → critical → Kill Switch；warn → 失败压力');

{
  // 缺省规约与熔断阈值同源参数化
  const specs = defaultSafetySpecs(3);
  ok(specs.find((s) => s.id === 'failure-storm').maxCount === 3, '失败风暴规约与熔断阈值同源参数化（threshold=3 → maxCount=3）');
  ok(specs.length === 3, '缺省规约集：风暴 / 熔断卡死 / Kill Switch 无人认领');

  // 分水岭 1：失败风暴（critical）→ Kill Switch
  const gov = new SafetyGovernor({ circuitFailureThreshold: 5 });
  const verifier = gov.attachRuntimeVerifier();
  for (let i = 0; i < 5; i += 1) gov.recordOutcome(false, 100, 0.001);
  let st = gov.getStatus();
  ok(st.killSwitch === false && st.circuitState === 'open', '5 连败打开熔断（风暴未确证：5 ≤ maxCount 5）');
  gov.recordOutcome(false, 100, 0.001); // 第 6 败：60s 窗口内 6 > 5
  st = gov.getStatus();
  ok(st.killSwitch === true, '第 6 败确证失败风暴（critical）→ Kill Switch 自动 engage（形式裁决获得治理的牙齿）');
  ok(st.verification.bySeverity.critical === 1 && st.verification.formalViolations.critical === 1, '形式违规计数入面板（critical × 1）');
  const storm = verifier.violationHistory.find((r) => r.specId === 'failure-storm');
  ok(storm !== undefined && storm.witness.length === 6, '风暴违规携带 6 事件见证轨迹（证明携带）');
  const gate = gov.checkGate();
  ok(gate.allowed === false && gate.blockedBy === 'kill-switch', 'Kill Switch 拦截后续全部动作');
  ok(st.verification.interpretation.includes('critical'), `状态解读：${st.verification.interpretation}`);

  // 分水岭 2：warn 违规（沉默违规）计入失败压力 + 审计携带 [formal]
  const gov2 = new SafetyGovernor({ circuitFailureThreshold: 3 });
  gov2.attachRuntimeVerifier([
    { id: 'quick-recover', pattern: 'response-deadline', trigger: 'breaker-opened', responder: 'breaker-closed', withinMs: 60, severity: 'warn' },
  ]);
  for (let i = 0; i < 3; i += 1) gov2.recordOutcome(false);
  ok(gov2.getStatus().circuitState === 'open', '3 连败打开熔断（breaker-opened 进入监视器）');
  await sleep(90); // 超过 60ms 偿还期限
  gov2.recordOutcome(false); // 任意后续事件触发期限检查
  const st2 = gov2.getStatus();
  ok(st2.verification.bySeverity.warn === 1, '熔断打开 60ms 未闭合 → warn 沉默违规确证（卡死的熔断 = 假安全）');
  ok(st2.consecutiveFailures === 5, `warn 违规计入失败压力（4 实败 + 1 形式违规 = 5，实测 ${st2.consecutiveFailures}）`);
  ok(
    gov2.getAudit().some((e) => e.verdict.reason.includes('[formal]')),
    '形式违规写入审计日志（[formal] 标记 + 规约引用）',
  );
}

// ═══════════════════ I 缺省零漂移 ═══════════════════

section('I 缺省零漂移：不挂载 → 治理行为与升级前完全一致');

{
  const gov = new SafetyGovernor();
  for (let i = 0; i < 4; i += 1) gov.recordOutcome(false);
  const st = gov.getStatus();
  ok(st.verification === undefined, '未挂载时状态无形式验证面板（零漂移）');
  ok(gov.getVerificationStatus() === undefined, 'getVerificationStatus 返回 undefined');
  ok(st.killSwitch === false && st.consecutiveFailures === 4, '既有熔断语义不受影响（纯标量门控路径原样保留）');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✓ 全部 ${passed} 项断言通过 —— 15.0 运行时验证质变闭环成立`);
  process.exit(0);
} else {
  console.error(`✗ ${failed} 项失败（${passed} 项通过）`);
  process.exit(1);
}
