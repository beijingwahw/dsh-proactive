/**
 * verify-genesis-bank.mjs — 创世纪「认知中央银行」证伪锚点（G1 分账 + G2 央行两定律）
 *
 * 不是「能跑」，是「定律成立」：
 *
 *   ① 分型器：五类失败模式从错误文本正确分拣（auth/timeout/network/
 *      integrity/quality 判定次序锚定）。
 *   ② 分账纯度（G1 核心证伪标准）：100 条 auth 风暴 + 50 条 network
 *      风暴后，能力后验**逐位不变**（先验 0.5）、可用性科目计数正确、
 *      校准器零入账（删失观测）；随后 20 条真实质量失败立即拉低后验
 *      ——能力科目只听能力的话。
 *   ③ 混合结算分账：同一任务里 A 质量失败 / B auth 失败——A 的后验
 *      下降、B 的不动、B 计 1 次可用性事件。
 *   ④ 准备金律（G2 定律一）：保持集优势低于准备金率的候选被拒发行
 *      （档案记 reject「准备金不足」）；达标的正常晋升。
 *   ⑤ 资本充足律（G2 定律二）：小证据基础上限发结构 → 越界部分被
 *      强制退役（档案记 retire「资本充足率」），Σ影响力回到界内；
 *      宪法审计 constitutionAudit() 全绿。
 *   ⑥ 链哈希覆盖 failureMode：篡改分型字段 → 验链失败。
 *   ⑦ 桥接透传：settleTask 的 node.error（HTTP 401 文本）→ 学习流
 *      贡献者带 failureMode:'auth' 且能力后验零污染。
 *
 * 全部确定性（独立种子子流）。运行：node --import tsx scripts/verify-genesis-bank.mjs
 */

import { PlasticityLoop, classifyFailure } from '../src/plasticity/loop.ts';
import { Consolidator } from '../src/plasticity/consolidation.ts';
import { SymbiosisBridge } from '../src/symbiosis/bridge.ts';
import { ProbeOperations } from '../src/plasticity/probes-ops.ts';
import { auditConstitution } from '../src/plasticity/constitution.ts';
import { EnergyLedger } from '../src/symbiosis/ledger.ts';

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
const T = Date.now();
let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 喂一条带分型的结算 */
function feed(loop, arm, success, mode, at, i, ctx = 'code') {
  loop.observeTask({
    taskId: `${arm}-${i}`,
    success,
    contributors: [{ agentId: arm, success, failureMode: success ? undefined : mode }],
    forecastP: 0.5,
    at,
    taskContext: ctx,
    source: 'direct',
  });
}

// ─────────────────────────── ① 分型器 ───────────────────────────

console.log('① 失败分型器（五科目判定次序）');
{
  const cases = [
    ['模型 x 返回 HTTP 401: {"error":{"message":"You didn\'t provide an API key"}}', 'auth'],
    ['Header中未收到Authorization参数，无法进行身份验证。', 'auth'],
    ['模型 x 返回 HTTP 401: 身份验证失败。', 'auth'],
    ['请求超时（timeout after 60000ms）', 'timeout'],
    ['fetch failed: ETIMEDOUT', 'timeout'],
    ['模型 glm-5.3 返回 HTTP 429: {"error":{"code":"1302","message":"您的账户已达到速率限制"}}', 'timeout'],
    ['fetch failed: ECONNRESET', 'network'],
    ['模型 sensechat-5 返回 HTTP 404: {"message":"no Route to Host"}', 'network'],
    ['模型 x 返回 HTTP 502: Bad Gateway', 'network'],
    ['Cannot set properties of undefined (setting \'success\')', 'integrity'],
    ['TypeError: x is not a function', 'integrity'],
    ['质量 0.32 低于阈值 0.60', 'quality'],
    [undefined, 'quality'],
    ['', 'quality'],
  ];
  let all = true;
  const bad = [];
  for (const [err, want] of cases) {
    const got = classifyFailure(err);
    if (got !== want) {
      all = false;
      bad.push(`「${(err ?? '').slice(0, 24)}」→ ${got}≠${want}`);
    }
  }
  check('五类分型全部正确（' + cases.length + ' 用例）', all, bad.join('; ') || '含 404/502 端点故障归 network');
}

// ─────────────────────────── ② 分账纯度 ───────────────────────────

console.log('② 分账纯度（G1 核心证伪标准）');
{
  const loop = new PlasticityLoop();
  loop.register(['model:x'], T);
  const before = loop.armProfile('model:x', T);
  for (let i = 0; i < 100; i += 1) feed(loop, 'model:x', false, 'auth', T - (150 - i) * HOUR, i);
  for (let i = 0; i < 50; i += 1) feed(loop, 'model:x', false, 'network', T - (50 - i) * HOUR, 100 + i);
  const after = loop.armProfile('model:x', T);
  check('150 条基础设施风暴后能力后验逐位不变', after.posteriorMean === before.posteriorMean, `${before.posteriorMean} === ${after.posteriorMean}`);
  check('可用性科目计数正确', after.availabilityIncidents === 150, `incidents=${after.availabilityIncidents}`);
  check('删失观测：校准器零入账', loop.stats(T).calibrator.steps === 0, `steps=${loop.stats(T).calibrator.steps}`);
  // 随后 20 条真实质量失败 → 后验立即下降（能力科目只听能力的话）
  for (let i = 0; i < 20; i += 1) feed(loop, 'model:x', false, 'quality', T + (i + 1) * HOUR, 200 + i);
  const afterQuality = loop.armProfile('model:x', T + 21 * HOUR);
  check('20 条真实质量失败立即拉低后验', afterQuality.posteriorMean < 0.4, `后验 ${afterQuality.posteriorMean.toFixed(3)} < 0.4`);
}

// ─────────────────────────── ③ 混合结算分账 ───────────────────────────

console.log('③ 混合结算分账（同任务分科目）');
{
  const loop = new PlasticityLoop();
  loop.register(['model:a', 'model:b'], T);
  const beforeA = loop.armProfile('model:a', T).posteriorMean;
  const beforeB = loop.armProfile('model:b', T).posteriorMean;
  for (let i = 0; i < 30; i += 1) {
    loop.observeTask({
      taskId: `mix-${i}`,
      success: false,
      contributors: [
        { agentId: 'model:a', success: false, failureMode: 'quality' },
        { agentId: 'model:b', success: false, failureMode: 'auth' },
      ],
      forecastP: 0.5,
      at: T - (30 - i) * HOUR,
      taskContext: 'code',
      source: 'direct',
    });
  }
  const a = loop.armProfile('model:a', T);
  const b = loop.armProfile('model:b', T);
  check('质量失败的 A 后验下降', a.posteriorMean < beforeA - 0.1, `${beforeA} → ${a.posteriorMean.toFixed(3)}`);
  check('auth 失败的 B 后验不动 + 可用性计数 30', b.posteriorMean === beforeB && b.availabilityIncidents === 30, `后验 ${b.posteriorMean} 不变，incidents=${b.availabilityIncidents}`);
}

// ─────────────────────────── ④ 准备金律 ───────────────────────────

console.log('④ 准备金律（结构发行的准备金底线）');
{
  const mkRate = (seed, p) => { const r = mulberry32(seed); return () => r() < p; };
  // 弱结构流（确定性）：train 优势 0.2（过 margin/稳定/噪声关），
  // 保持集优势仅 0.04（< 准备金率 0.1）→ 必须走到准备金关并被拒
  const weak = new PlasticityLoop();
  for (let i = 0; i < 150; i += 1) {
    const at = T - (300 - i) * HOUR;
    const inTrain = i < 100;
    const ka = inTrain ? i % 10 : (i * 7) % 25; // train 0.7 / test 0.56
    const kb = inTrain ? i % 2 : (i * 7) % 25; // train 0.5 / test 0.48
    feed(weak, 'model:a', !(ka < (inTrain ? 3 : 11)), 'quality', at, i);
    feed(weak, 'model:b', !(kb < (inTrain ? 1 : 12)), 'quality', at, 1000 + i);
  }
  const weakCons = new Consolidator({ minEvents: 120, reserveRatio: 0.1 });
  weakCons.bindSource(() => weak.eventLog());
  weakCons.consolidate(T);
  const weakReject = weakCons.archiveLog().find((e) => e.kind === 'reject' && (e.reason ?? '').includes('准备金'));
  check('弱结构被准备金律拒发行', weakCons.activeRules().length === 0 && weakReject !== undefined, weakReject?.reason ?? '（未产生拒绝记录）');

  // 强结构流：a 显著优于 b（保持集优势 ≥ 0.2 > 准备金率）→ 正常发行
  const strong = new PlasticityLoop();
  const sa = mkRate(511, 0.75), sb = mkRate(512, 0.4);
  for (let i = 0; i < 150; i += 1) {
    const at = T - (300 - i) * HOUR;
    feed(strong, 'model:a', sa(), 'quality', at, i);
    feed(strong, 'model:b', sb(), 'quality', at, 2000 + i);
  }
  const strongCons = new Consolidator({ minEvents: 120, reserveRatio: 0.1 });
  strongCons.bindSource(() => strong.eventLog());
  strongCons.consolidate(T);
  check('强结构正常发行', strongCons.activeRules().length === 1 && strongCons.activeRules()[0].armId === 'model:a');
}

// ─────────────────────────── ⑤ 资本充足律 ───────────────────────────

console.log('⑤ 资本充足律（结构不许超发）');
{
  // 双上下文各自固化出规则 → Σ影响力 0.5，但 κ×E = 0.01×320 = 3.2…
  // 用更紧的 κ 制造越界：κ = 0.0005 → 容量 0.16 < 0.5 → 必须收缩
  const loop = new PlasticityLoop();
  const mk = (seed, p) => { const r = mulberry32(seed); return () => r() < p; };
  const aCode = mk(601, 0.78), bCode = mk(602, 0.4), bChat = mk(603, 0.72), aChat = mk(604, 0.35);
  for (let i = 0; i < 150; i += 1) {
    const at = T - (300 - i) * HOUR;
    feed(loop, 'model:a', aCode(), 'quality', at, i, 'code');
    feed(loop, 'model:b', bCode(), 'quality', at, 3000 + i, 'code');
    feed(loop, 'model:b', bChat(), 'quality', at, 4000 + i, 'chat');
    feed(loop, 'model:a', aChat(), 'quality', at, 5000 + i, 'chat');
  }
  const cons = new Consolidator({ minEvents: 120, reserveRatio: 0.1, capitalKappa: 0.0005 });
  cons.bindSource(() => loop.eventLog());
  cons.consolidate(T);
  const bank = cons.bankView();
  check('双规则曾发行（收缩前有结构可收缩）', cons.archiveLog().filter((e) => e.kind === 'promote').length === 2, `promotes=${cons.archiveLog().filter((e) => e.kind === 'promote').length}`);
  check('资本充足率强制收缩发生', bank.forcedContractions >= 1, `强制退役 ${bank.forcedContractions} 条`);
  check('Σ影响力回到界内', bank.totalInfluence <= bank.capacity + 1e-9, `Σ${bank.totalInfluence} ≤ κ×E ${bank.capacity}`);
  const audit = cons.constitutionAudit();
  check('宪法审计全绿', audit.holds === true, audit.violations.join('; ') || '准备金 ✓ 资本充足 ✓');

  // 宽松 κ 对照：同数据下 κ=0.01 → 容量 6.4 → 双规则存活
  const cons2 = new Consolidator({ minEvents: 120, reserveRatio: 0.1, capitalKappa: 0.01 });
  cons2.bindSource(() => loop.eventLog());
  cons2.consolidate(T);
  check('宽松 κ 下双规则存活（定律只在越界时干预）', cons2.activeRules().length === 2 && cons2.bankView().forcedContractions === 0);
}

// ─────────────────────────── ⑥ 链哈希覆盖分型 ───────────────────────────

console.log('⑥ 链哈希覆盖 failureMode（篡改检出）');
{
  const loop = new PlasticityLoop();
  for (let i = 0; i < 5; i += 1) feed(loop, 'model:a', false, 'auth', T - (5 - i) * HOUR, i);
  check('链完整', loop.verifyLearningChain() === true);
  const snap = loop.snapshotState();
  const tampered = structuredClone(snap);
  tampered.events[0].contributors[0].failureMode = 'quality'; // 篡改分型
  loop.restoreState(tampered);
  check('篡改分型字段 → 验链失败', loop.verifyLearningChain() === false);
}

// ─────────────────────────── ⑦ 桥接透传 ───────────────────────────

console.log('⑦ 桥接透传（error 文本 → 分型 → 学习流）');
{
  const bridge = new SymbiosisBridge({ runtime: { clock: () => T } });
  const loop = new PlasticityLoop();
  bridge.registerModel('m1');
  bridge.registerModel('m2');
  bridge.attachPlasticity(loop);
  const before = loop.armProfile('model:m1', T).posteriorMean;
  bridge.settleTask(
    {
      success: false,
      nodeResults: [
        { modelId: 'm1', success: false, quality: 0.1, error: '模型 m1 返回 HTTP 401: {"error":{"message":"身份验证失败。"}}' },
        { modelId: 'm2', success: false, quality: 0.2, error: '质量 0.20 低于阈值' },
      ],
    },
    { taskContext: 'code' },
  );
  const ev = loop.eventLog()[loop.eventLog().length - 1];
  check(
    'node.error 分型透传（m1:auth / m2:quality）',
    ev.contributors.find((c) => c.agentId === 'model:m1').failureMode === 'auth' && ev.contributors.find((c) => c.agentId === 'model:m2').failureMode === 'quality',
  );
  const m1 = loop.armProfile('model:m1', T);
  const m2 = loop.armProfile('model:m2', T);
  check('m1 能力后验零污染（只计可用性）', m1.posteriorMean === before && m1.availabilityIncidents === 1, `后验 ${m1.posteriorMean} 不变`);
  check('m2 质量失败正常入账', m2.posteriorMean < 0.5, `后验 ${m2.posteriorMean.toFixed(3)}`);
}

// ─────────────────────────── ⑧ G3 探针操作 ───────────────────────────

console.log('⑧ G3 探针操作（流动性检测 + 预算纪律）');
{
  const loop = new PlasticityLoop();
  // 构造流动性枯竭市场：glm-4.5 活跃（30 观测）、glm-5.3 饿死（2 观测）
  for (let i = 0; i < 30; i += 1) feed(loop, 'model:glm-4.5', true, undefined, T - (32 - i) * HOUR, i);
  for (let i = 0; i < 2; i += 1) feed(loop, 'model:glm-5.3', true, undefined, T - (2 - i) * HOUR, 100 + i);
  const ops = new ProbeOperations({ minPerWindow: 5, activeThreshold: 20, windowEvents: 50 });
  const orders = ops.due(loop.eventLog(), T);
  check('饿死臂被检出并签发指令', orders.some((o) => o.modelId === 'glm-5.3' && o.kind === 'starved'), JSON.stringify(orders.map((o) => `${o.modelId}:${o.kind}`)));
  check('指令附市场活跃桶为注入目标', orders.every((o) => o.taskContext === 'code'), `ctx=${orders[0]?.taskContext}`);

  // 预算纪律：maxPerHour 3 → 第 4 条被拒
  const budget = new ProbeOperations({ maxPerHour: 3 });
  let admitted = 0;
  for (let i = 0; i < 5; i += 1) {
    if (!budget.admit(T)) break;
    budget.record(T);
    admitted += 1;
  }
  check('预算封顶（maxPerHour 3 → 第 4 条拒）', admitted === 3, `admitted=${admitted}`);
  check('滚动窗释放（1 小时后预算恢复）', budget.admit(T + 3_600_001) === true);

  // 央行铁律：不给无偿付能力的银行注入流动性（最近一次观测为 infra
  // 失败的臂跳过——实测：401 军团烧光探针预算，真饿死臂排不上队）
  const insolventLoop = new PlasticityLoop();
  for (let i = 0; i < 30; i += 1) feed(insolventLoop, 'model:glm-4.5', true, undefined, T - (32 - i) * HOUR, i);
  feed(insolventLoop, 'model:dead-bank', false, 'auth', T, 0); // 破产：最近一次是 auth 失败
  const insolventOrders = new ProbeOperations({ minPerWindow: 5, activeThreshold: 20 }).due(insolventLoop.eventLog(), T);
  check('无偿付能力的臂不被注入（跳过 dead-bank）', !insolventOrders.some((o) => o.modelId === 'dead-bank'), JSON.stringify(insolventOrders.map((o) => o.modelId)));

  // 死市场不做市：无臂达活跃阈值 → 零指令
  const dead = new PlasticityLoop();
  for (let i = 0; i < 3; i += 1) feed(dead, 'model:a', true, undefined, T - (3 - i) * HOUR, i);
  check('市场不活跃时不签发（不做市）', new ProbeOperations({ activeThreshold: 20 }).due(dead.eventLog(), T).length === 0);

  // 陈旧检测：活跃臂 3 小时无观测 → stale 指令
  const staleLoop = new PlasticityLoop();
  for (let i = 0; i < 25; i += 1) feed(staleLoop, 'model:a', true, undefined, T - 4 * HOUR - (25 - i) * HOUR, i);
  const staleOrders = new ProbeOperations({ activeThreshold: 20 }).due(staleLoop.eventLog(), T);
  check('陈旧臂被检出（证据年龄 > 2h）', staleOrders.some((o) => o.modelId === 'a' && o.kind === 'stale'), staleOrders[0]?.reason ?? '');
}

// ─────────────────────────── ⑨ G5 跨账本宪法 ───────────────────────────

console.log('⑨ G5 跨账本宪法审计（三链 + 恒等式）');
{
  const loop = new PlasticityLoop();
  const mk = (seed, p) => { const r = mulberry32(seed); return () => r() < p; };
  const aCode = mk(701, 0.78), bCode = mk(702, 0.4);
  for (let i = 0; i < 150; i += 1) {
    const at = T - (300 - i) * HOUR;
    feed(loop, 'model:a', aCode(), 'quality', at, i);
    feed(loop, 'model:b', bCode(), 'quality', at, 9000 + i);
  }
  const cons = new Consolidator({ minEvents: 120, reserveRatio: 0.1, capitalKappa: 0.01 });
  cons.bindSource(() => loop.eventLog());
  cons.consolidate(T);
  const ledger = new EnergyLedger();
  ledger.openAccount('treasury-x');
  const report = auditConstitution(loop, cons, ledger);
  check('宪法全绿（链 + 溯源 + 两定律 + 守恒）', report.holds === true, `${report.checks.length} 项检查全过`);
  check('结构负债可溯源条目在列', report.checks.some((c) => c.name.startsWith('结构负债可溯源')), report.checks.filter((c) => c.name.startsWith('结构负债')).map((c) => c.detail).join(' | ') || '（无活跃规则——溯源项跳过）');

  // 虚账检测：规则宣称的证据数超过学习链在场事件 → 跨账本恒等式violation
  const forged = cons.snapshotState();
  if (forged.rules.length > 0) {
    const inflated = structuredClone(forged);
    inflated.rules[0].evidence.trainEvents = 99999; // 虚增证据宣称
    cons.restoreState(inflated);
    const bad = auditConstitution(loop, cons);
    check('虚增证据宣称 → 宪法审计亮红', bad.holds === false && bad.checks.some((c) => c.name.startsWith('结构负债') && !c.holds));
    cons.restoreState(forged);
    check('还原后宪法恢复全绿', auditConstitution(loop, cons).holds === true);
  } else {
    check('（无规则时溯源项天然通过）', auditConstitution(loop, cons).holds === true);
  }

  // 学习链篡改 → 第一条亮红
  const snap = loop.snapshotState();
  const tampered = structuredClone(snap);
  tampered.events[0].success = !tampered.events[0].success;
  loop.restoreState(tampered);
  const chainReport = auditConstitution(loop, cons);
  check('学习链篡改 → 宪法第一条亮红', chainReport.checks.find((c) => c.name === '学习链完整')?.holds === false);
}

// ─────────────────────────── 汇总 ───────────────────────────

console.log(`\n通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.error(`✗ ${failed} 项定律失效`);
  process.exit(1);
}
console.log('✓ 创世纪认知中央银行：分账协议与央行两定律全部锚点成立');
