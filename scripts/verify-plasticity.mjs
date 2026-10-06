/**
 * verify-plasticity.mjs — 双系统可塑性第一阶段（τ1 学习闭环）离线验证
 *
 * 覆盖 src/plasticity/{loop,probes}.ts 的完整闭环，锚点均有解析解 /
 * 独立口径对照（不是「能跑」，是「算得对」）：
 *
 *   ① 后验收敛（证伪标准①「学习曲线存在」的下界）：真率 0.8/0.3 的两臂
 *      各 200 次结局 → Beta 后验均值分别落进 [0.8±0.08] / [0.3±0.08]，
 *      Wilson 下界序保持 a > b。
 *   ② 校准纠偏：外部预报恒 0.75、真率 0.55 → 门控确证失准并激活，
 *      校准值与经验频率的距离严格小于原始预报（|c−ȳ| < |0.75−ȳ|）。
 *   ③ 路由学习（学习曲线在决策层的体现）：三臂 0.8/0.5/0.2 等 token，
 *      300 轮 BwK 路由 → 后 100 轮最优臂占比 > 0.6，平均后悔低于前 100 轮。
 *   ④ 漂移追踪：臂真率 0.8→0.3（1 天/事件，30 天半衰期）→ 末段后验
 *      更接近 0.3（时间衰减让旧政权退位）。
 *   ⑤ 遗忘屏障—对抗批回滚（证伪标准②）：50 条冻结探针下注入「好臂
 *      全失败」毒批 30 条 → 探针退化 → 批次拒收，回滚后预测器与批前
 *      **逐位相等**（确定性重放的等价证明）；同批不经门控直接喂入则
 *      后验崩塌（对照：屏障挡住的正是真实伤害）。
 *   ⑥ 遗忘屏障—诚实批通过：正常 25 条 → committed（学习不被误伤）。
 *   ⑦ 零漂移挂载：attach 后原结算照常执行、返回值透传、结局入学习流；
 *      detach 后原型方法归位（own/prototype 两路径都验）。
 *   ⑧ 学习链审计 + 账本对账：链完整 = true；快照篡改历史事件 → 验链
 *      false；真实 EnergyLedger 的 task-dividend 铸币数与回路成功事件
 *      数对账一致。
 *   ⑨ 自动遗忘门控（生产形态）：autoGate 每 25 事件自动「冻结历史探针
 *      → 批后评分 → 退化回滚」——毒窗口被回滚且预测器逐位还原，后续
 *      诚实窗口正常提交（学习不被误伤）。
 *   ⑩ 磁盘持久化：persistPath 构造加载 + 变更原子落盘，重启后事件与
 *      预测逐位一致、学习链完整；损坏快照诚实重启（不抛异常、从零开始）。
 *   ⑪ 桥接集成：attachPlasticity 后冻结时钟双桥对照，结算报告 JSON
 *      逐位一致（经济数值零漂移）；首事件预报 = 先验 0.5（结算前采样）；
 *      节点级真值分流学习（m1 后验 > m2 后验）+ override 进入学习流。
 *   ⑫ 学习反哺调度（闭环最后一段）：真实 ModelScheduler 消费学习画像——
 *      冷启动乘数恒 1 选型不变（零漂移）；学习后好臂 ×1.29 / 坏臂 ×0.71
 *      翻转 argmax（m-hi → m-lo）；毒窗口回滚后乘数联动还原；
 *      detach 后逐位回原路径。
 *   ⑬ τ2 结构固化（DGM 三要素：检测-验证-档案）：稳定优势晋升为版本化
 *      规则（保持集验证，train 反转被拒）；240 天（8 半衰期）后 τ1 证据
 *      归零而 τ2 规则仍生效（结构比证据活得久）；世界反转规则退役留痕；
 *      档案链防篡改 + 重启续存 + onEvent 节奏驱动。
 *   ⑭ 上下文条件化：规则带前提（code→a、chat→b 分桶固化，精确上下文
 *      压过全局——更具体的结构支配更泛的结构）；保持集容差带 2σ 噪声
 *      地板（防真结构被采样噪声误杀）；taskContext 进链哈希（篡改检出）。
 *
 * 全部确定性（mulberry32 显式种子）。
 * 运行：node --experimental-transform-types scripts/verify-plasticity.mjs
 */

import { PlasticityLoop, attachPlasticity } from '../src/plasticity/loop.ts';
import { freezeProbes } from '../src/plasticity/probes.ts';
import { Consolidator } from '../src/plasticity/consolidation.ts';
import { EnergyLedger } from '../src/symbiosis/ledger.ts';
import { SymbiosisBridge } from '../src/symbiosis/bridge.ts';
import { ModelScheduler } from '../src/model-scheduler.ts';
import { LLMClient } from '../src/llm-client.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─────────────────────────── 工具 ───────────────────────────

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

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

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

function approxEqual(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

/** 单臂伯努利结局流喂给回路（forecastP = 决策时刻回路自身的后验） */
function feedArm(loop, agentId, success, at, tokens, i) {
  const forecastP = Math.min(1 - 1e-6, Math.max(1e-6, loop.forecast([agentId], at)));
  loop.observeTask({
    taskId: `${agentId}-${i}`,
    success,
    contributors: [{ agentId, tokens }],
    forecastP,
    at,
    source: 'direct',
  });
}

// ─────────────────────────── ① 后验收敛 ───────────────────────────

console.log('① 后验收敛（Beta 后验追踪真率）');
{
  const rng = mulberry32(20260101);
  const loop = new PlasticityLoop();
  const N = 200;
  for (let i = 0; i < N; i += 1) {
    const at = T0 + i * HOUR;
    feedArm(loop, 'a', rng() < 0.8, at, 900, i);
    feedArm(loop, 'b', rng() < 0.3, at, 900, i);
  }
  const end = T0 + N * HOUR;
  const va = loop.stats(end).arms.find((x) => x.agentId === 'a');
  const vb = loop.stats(end).arms.find((x) => x.agentId === 'b');
  check('真率 0.8 臂的后验均值 ∈ [0.72, 0.88]', approxEqual(va.posteriorMean, 0.8, 0.08), `posterior=${va.posteriorMean}`);
  check('真率 0.3 臂的后验均值 ∈ [0.22, 0.38]', approxEqual(vb.posteriorMean, 0.3, 0.08), `posterior=${vb.posteriorMean}`);
  check('Wilson 下界序 a > b', va.wilsonLower > vb.wilsonLower, `${va.wilsonLower} > ${vb.wilsonLower}`);
  check('有效样本量接近观测数', va.effectiveSamples > N * 0.8, `eff=${va.effectiveSamples}`);
}

// ─────────────────────────── ② 校准纠偏 ───────────────────────────

console.log('② 校准纠偏（门控校准器修正系统性高估）');
{
  const rng = mulberry32(20260202);
  const loop = new PlasticityLoop();
  const N = 160;
  let ySum = 0;
  for (let i = 0; i < N; i += 1) {
    const at = T0 + i * HOUR;
    const success = rng() < 0.55;
    ySum += success ? 1 : 0;
    loop.observeTask({
      taskId: `cal-${i}`,
      success,
      contributors: [{ agentId: 'arm', tokens: 700 }],
      forecastP: 0.75, // 外部预报系统性高估（决策引擎置信 vs 现实）
      at,
      source: 'direct',
    });
  }
  const meanY = ySum / N;
  const end = T0 + N * HOUR;
  const st = loop.stats(end);
  const calibrated = loop.calibrated(0.75);
  check('门控确证失准并激活', st.calibrator.active === true, `activatedAt=${st.calibrator.activatedAt}`);
  check(
    '校准值比原始预报更接近经验频率',
    Math.abs(calibrated - meanY) < Math.abs(0.75 - meanY),
    `calibrated=${calibrated.toFixed(3)} raw=0.750 ȳ=${meanY.toFixed(3)}`,
  );
}

// ─────────────────────────── ③ 路由学习 ───────────────────────────

console.log('③ 路由学习（BwK 从经验中把流量交给最优臂）');
{
  const rng = mulberry32(20260303);
  const loop = new PlasticityLoop();
  // 名册顺序刻意让次优臂排首（平局决胜偏向先注册者）：学习前流量滞留 a，
  // 证据积累后应迁移到最优臂 b——「前段探索/次优、后段最优」才有分辨率。
  const TRUE = { a: 0.5, b: 0.8, c: 0.2 };
  const IDS = ['a', 'b', 'c'];
  loop.register(IDS, T0);
  const TOKENS = 900;
  const ROUNDS = 300;
  let tokensRemaining = ROUNDS * TOKENS * 2; // 预算宽裕：隔离「选谁」的学习信号
  const firstChosen = { a: 0, b: 0, c: 0 };
  const lastChosen = { a: 0, b: 0, c: 0 };
  let firstRegret = 0;
  let lastRegret = 0;
  for (let t = 0; t < ROUNDS; t += 1) {
    const at = T0 + t * HOUR;
    const verdict = loop.route({ tokensRemaining, roundsRemaining: ROUNDS - t }, at);
    const chosen = verdict.chosenId || IDS[t % 3];
    const success = rng() < TRUE[chosen];
    feedArm(loop, chosen, success, at, TOKENS, t);
    tokensRemaining -= TOKENS;
    const regret = TRUE.b - TRUE[chosen];
    if (t < 100) {
      firstChosen[chosen] += 1;
      firstRegret += regret;
    } else if (t >= 200) {
      lastChosen[chosen] += 1;
      lastRegret += regret;
    }
  }
  check('后 100 轮最优臂占比 > 0.6', lastChosen.b > 60, `b=${lastChosen.b}/100 (前100: b=${firstChosen.b})`);
  check('平均后悔下降（后 100 < 前 100）', lastRegret / 100 < firstRegret / 100, `后=${(lastRegret / 100).toFixed(3)} 前=${(firstRegret / 100).toFixed(3)}`);
}

// ─────────────────────────── ④ 漂移追踪 ───────────────────────────

console.log('④ 漂移追踪（时间衰减让旧政权退位）');
{
  const rng = mulberry32(20260404);
  const loop = new PlasticityLoop();
  for (let i = 0; i < 150; i += 1) {
    feedArm(loop, 'd', rng() < 0.8, T0 + i * DAY, 900, i); // 旧世界：1 天/事件
  }
  const midAt = T0 + 150 * DAY;
  const mid = loop.stats(midAt).arms[0].posteriorMean;
  for (let i = 0; i < 100; i += 1) {
    feedArm(loop, 'd', rng() < 0.3, midAt + i * DAY, 900, 150 + i); // 新世界
  }
  const endAt = midAt + 100 * DAY;
  const end = loop.stats(endAt).arms[0].posteriorMean;
  check('漂移前追踪 0.8', approxEqual(mid, 0.8, 0.1), `mid=${mid.toFixed(3)}`);
  check(
    '漂移后更接近 0.3 而非 0.8',
    Math.abs(end - 0.3) < Math.abs(end - 0.8) && end < 0.5,
    `end=${end.toFixed(3)}`,
  );
}

// ─────────────────────────── ⑤⑥ 遗忘屏障 ───────────────────────────

/** 构造双臂热身回路（⑤⑥ 共用口径，种子决定结局流） */
function warmLoop(seed) {
  const rng = mulberry32(seed);
  const loop = new PlasticityLoop();
  const history = [];
  for (let i = 0; i < 120; i += 1) {
    const at = T0 + i * HOUR;
    const arm = i % 2 === 0 ? 'good' : 'other';
    const success = rng() < (arm === 'good' ? 0.8 : 0.5);
    feedArm(loop, arm, success, at, 900, i);
    history.push({ contributors: [{ agentId: arm }], success });
  }
  return { loop, history, endAt: T0 + 120 * HOUR };
}

console.log('⑤ 遗忘屏障—对抗批回滚');
{
  const { loop, history, endAt } = warmLoop(20260505);
  const probes = freezeProbes(history, 50, mulberry32(777), endAt);
  check('探针冻结 50 条', probes.size() === 50, `agents=${probes.agentCount()}`);

  const before = loop.predict('good', endAt);
  const eventsBefore = loop.eventLog().length;
  loop.beginBatch(probes, endAt);
  for (let i = 0; i < 30; i += 1) {
    // 毒批：好臂被谎报全失败（标签翻转攻击）
    feedArm(loop, 'good', false, endAt + (i + 1) * HOUR, 900, 1000 + i);
  }
  const decision = loop.endBatch(probes, endAt + 31 * HOUR);
  check('毒批被判退化拒收', decision.committed === false && decision.verdict.degraded, `ΔlogLoss=${decision.verdict.logLossDelta.toFixed(3)}`);
  check('回滚后事件数还原', loop.eventLog().length === eventsBefore, `${loop.eventLog().length} === ${eventsBefore}`);
  check(
    '回滚后预测器与批前逐位相等（确定性重放）',
    loop.predict('good', endAt) === before,
    `${loop.predict('good', endAt)} === ${before}`,
  );

  // 对照：同批不经门控直接喂入 → 后验崩塌（屏障挡住的是真实伤害）
  const { loop: naked } = warmLoop(20260505);
  const nakedBefore = naked.predict('good', endAt);
  for (let i = 0; i < 30; i += 1) {
    feedArm(naked, 'good', false, endAt + (i + 1) * HOUR, 900, 1000 + i);
  }
  const nakedAfter = naked.predict('good', endAt);
  check('无门控对照：同批毒数据令后验崩塌', nakedAfter < nakedBefore - 0.15, `${nakedBefore.toFixed(3)} → ${nakedAfter.toFixed(3)}`);
  check('拒批计数入档', loop.stats(endAt).rejectedBatches === 1);
}

console.log('⑥ 遗忘屏障—诚实批通过');
{
  const rng = mulberry32(20260606);
  const { loop, history, endAt } = warmLoop(20260606);
  const probes = freezeProbes(history, 50, mulberry32(778), endAt);
  loop.beginBatch(probes, endAt);
  for (let i = 0; i < 25; i += 1) {
    const at = endAt + (i + 1) * HOUR;
    const arm = i % 2 === 0 ? 'good' : 'other';
    feedArm(loop, arm, rng() < (arm === 'good' ? 0.8 : 0.5), at, 900, 2000 + i);
  }
  const decision = loop.endBatch(probes, endAt + 26 * HOUR);
  check('诚实批正常提交', decision.committed === true && decision.rejectedEvents === 0, `ΔlogLoss=${decision.verdict.logLossDelta.toFixed(4)}`);
}

// ─────────────────────────── ⑦ 零漂移挂载 ───────────────────────────

console.log('⑦ 零漂移挂载（attach/detach 语义）');
{
  // 对象字面量宿主：settleTaskOutcome 是自身属性 → detach 走赋值还原
  const literalHost = {
    calls: 0,
    settleTaskOutcome(success, contributors) {
      this.calls += 1;
      return { ok: true, success, n: contributors.length };
    },
  };
  const loop1 = new PlasticityLoop();
  const detach1 = attachPlasticity(literalHost, loop1, () => T0);
  const r1 = literalHost.settleTaskOutcome(true, [{ agentId: 'x' }]);
  check('原结算照常执行且返回值透传', literalHost.calls === 1 && r1.ok === true && r1.n === 1);
  check('结局进入学习流', loop1.eventLog().length === 1 && loop1.eventLog()[0].success === true);
  detach1();
  literalHost.settleTaskOutcome(false, [{ agentId: 'x' }]);
  check('detach 后结算不再进入学习流', literalHost.calls === 2 && loop1.eventLog().length === 1);
  check('detach 后原型行为还原（返回值正常）', literalHost.settleTaskOutcome(true, []).ok === true);

  // 类实例宿主：方法在原型上 → detach 走 delete 归位
  class ClassHost {
    constructor() {
      this.calls = 0;
    }
    settleTaskOutcome(success) {
      this.calls += 1;
      return { ok: true, success };
    }
  }
  const classHost = new ClassHost();
  const loop2 = new PlasticityLoop();
  const detach2 = attachPlasticity(classHost, loop2, () => T0);
  classHost.settleTaskOutcome(true, [{ agentId: 'y' }]);
  detach2();
  classHost.settleTaskOutcome(false, [{ agentId: 'y' }]);
  const stillOwn = Object.prototype.hasOwnProperty.call(classHost, 'settleTaskOutcome');
  check('类宿主：detach 后自身属性归位（回到原型方法）', !stillOwn && classHost.calls === 2 && loop2.eventLog().length === 1);
}

// ─────────────────────────── ⑧ 学习链审计 + 账本对账 ───────────────────────────

console.log('⑧ 学习链审计 + 账本对账');
{
  const rng = mulberry32(20260707);
  const loop = new PlasticityLoop();
  const outcomes = [true, false, true];
  outcomes.forEach((success, i) => {
    feedArm(loop, 'a', success, T0 + i * HOUR, 800, i);
  });
  check('学习链完整', loop.verifyLearningChain() === true);

  const snap = loop.snapshotState();
  const tampered = structuredClone(snap);
  tampered.events[1].success = !tampered.events[1].success; // 篡改历史结局
  loop.restoreState(tampered);
  check('篡改历史事件 → 验链失败', loop.verifyLearningChain() === false);
  loop.restoreState(snap);
  check('还原快照 → 验链恢复', loop.verifyLearningChain() === true);

  const ledger = new EnergyLedger();
  ledger.openAccount('a');
  ledger.mint('a', 10, 'task-dividend', 't0');
  ledger.mint('a', 10, 'task-dividend', 't2');
  const rec = loop.reconcile(ledger);
  check('账本 task-dividend 铸币数与回路成功事件数对账一致', rec.match, `ledger=${rec.ledgerSuccessMints} loop=${rec.loopSuccessEvents} (rng=${rng().toFixed(3)})`);
}

// ─────────────────────────── ⑨ 自动遗忘门控 ───────────────────────────

console.log('⑨ 自动遗忘门控（生产形态：逐窗口考卷，无需手动 begin/endBatch）');
{
  const rng = mulberry32(20260808);
  const loop = new PlasticityLoop({
    autoGate: { window: 25, probeSize: 40, minHistory: 40, seed: 20260808 },
  });
  const feed = (i, success) => {
    const at = T0 + i * HOUR;
    feedArm(loop, 'good', success, at, 900, i);
  };
  // 100 条诚实流（窗口 25/50/75/100 各自过门）
  for (let i = 0; i < 100; i += 1) feed(i, rng() < 0.8);
  const atPoison = T0 + 100 * HOUR;
  const before = loop.predict('good', atPoison);
  // 毒窗口 25 条（好臂全失败）：开窗时冻结的是前 100 条历史的探针
  for (let i = 0; i < 25; i += 1) feed(100 + i, false);
  check('毒窗口被自动门控回滚', loop.stats(atPoison + 25 * HOUR).rejectedBatches === 1, `rejections=${loop.stats(atPoison + 25 * HOUR).rejectedBatches}`);
  check('回滚后事件数还原到窗口前', loop.eventLog().length === 100, `events=${loop.eventLog().length}`);
  check('回滚后预测器逐位还原', loop.predict('good', atPoison) === before, `${loop.predict('good', atPoison)} === ${before}`);
  // 后续诚实窗口正常通过（学习继续，不被误伤）
  for (let i = 0; i < 25; i += 1) feed(125 + i, rng() < 0.8);
  check('后续诚实窗口正常提交', loop.eventLog().length === 125 && loop.stats(T0 + 150 * HOUR).rejectedBatches === 1);
}

// ─────────────────────────── ⑩ 磁盘持久化 ───────────────────────────

console.log('⑩ 磁盘持久化（构造加载 + 变更落盘 + 损坏诚实重启）');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plasticity-'));
  const file = path.join(dir, 'state.json');
  try {
    const rng = mulberry32(20260909);
    const loop1 = new PlasticityLoop({ persistPath: file });
    for (let i = 0; i < 20; i += 1) feedArm(loop1, 'a', rng() < 0.7, T0 + i * HOUR, 800, i);
    const endAt = T0 + 20 * HOUR;
    const p1 = loop1.predict('a', endAt);

    const loop2 = new PlasticityLoop({ persistPath: file });
    check('重启后状态恢复（事件与预测逐位一致）', loop2.eventLog().length === 20 && loop2.predict('a', endAt) === p1, `p=${p1.toFixed(6)}`);
    check('重启后学习链完整', loop2.verifyLearningChain() === true);

    fs.writeFileSync(file, '{corrupted', 'utf8');
    const loop3 = new PlasticityLoop({ persistPath: file });
    check('损坏快照诚实重启（不抛异常、从零开始）', loop3.eventLog().length === 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────── ⑪ 桥接集成 + 零漂移 ───────────────────────────

console.log('⑪ 桥接集成（attachPlasticity 后经济数值零漂移 + 学习信号正确）');
{
  const rng = mulberry32(20261010);
  const FROZEN = T0;
  // 双桥对照：冻结时钟下逐位可比（唯一差异 = 是否挂载可塑性）
  const bridgeA = new SymbiosisBridge({ runtime: { clock: () => FROZEN } });
  const bridgeB = new SymbiosisBridge({ runtime: { clock: () => FROZEN } });
  const loop = new PlasticityLoop();
  bridgeA.registerModel('m1');
  bridgeA.registerModel('m2');
  bridgeB.registerModel('m1');
  bridgeB.registerModel('m2');
  bridgeA.attachPlasticity(loop);

  // 首事件预报 = 先验混合（0.5）——「结算前采样」的直接证据
  let firstForecast;
  for (let i = 0; i < 30; i += 1) {
    const m1ok = rng() < 0.75;
    const m2ok = rng() < 0.45;
    const nodeResults = [
      { modelId: 'm1', success: m1ok, quality: 0.8 },
      { modelId: 'm2', success: m2ok, quality: 0.6 },
    ];
    const rA = bridgeA.settleTask({ success: m1ok && m2ok, nodeResults });
    const rB = bridgeB.settleTask({ success: m1ok && m2ok, nodeResults });
    if (i === 0) firstForecast = loop.eventLog()[0].forecastP;
    if (i === 29) {
      check('挂载后经济数值零漂移（结算报告逐位一致）', JSON.stringify(rA) === JSON.stringify(rB), `totalA=${rA.totalDistributed} totalB=${rB.totalDistributed}`);
    }
  }
  check('首事件预报 = 先验 0.5（结算前采样）', Math.abs(firstForecast - 0.5) < 1e-12, `forecast=${firstForecast}`);
  check('学习流记录 30 次结算', loop.eventLog().length === 30);

  const stats = loop.stats(FROZEN);
  const m1 = stats.arms.find((x) => x.agentId === 'model:m1');
  const m2 = stats.arms.find((x) => x.agentId === 'model:m2');
  check('节点级真值分流学习（m1 后验 > m2 后验）', m1.posteriorMean > m2.posteriorMean, `m1=${m1.posteriorMean} m2=${m2.posteriorMean}`);

  // 节点级真值 override：任务失败但 m1 节点成功 → m1 证据记成功
  bridgeA.settleTask({
    success: false,
    nodeResults: [
      { modelId: 'm1', success: true, quality: 0.9 },
      { modelId: 'm2', success: false, quality: 0.5 },
    ],
  });
  const last = loop.eventLog()[loop.eventLog().length - 1];
  check('节点真值 override 进入学习流（任务失败但 m1 记成功）', last.success === false && last.contributors.find((c) => c.agentId === 'model:m1').success === true);
  check('未挂载的桥零介入（B 无学习流泄漏）', bridgeB.plasticityLoop === undefined);

  // Token 消耗真值流通：逐节点 tokensUsed 聚合进学习流 → 臂消耗画像
  bridgeA.settleTask({
    success: true,
    nodeResults: [
      { modelId: 'm1', success: true, quality: 0.9, tokensUsed: 1200 },
      { modelId: 'm2', success: false, quality: 0.4, tokensUsed: 300 },
    ],
  });
  const lastTok = loop.eventLog()[loop.eventLog().length - 1];
  check(
    'Token 消耗聚合进学习流（BwK 路由画像的数据源）',
    lastTok.contributors.find((c) => c.agentId === 'model:m1').tokens === 1200 && lastTok.contributors.find((c) => c.agentId === 'model:m2').tokens === 300,
  );
  const m1Profile = loop.armProfile('model:m1', Date.now());
  check('臂消耗画像用真实 token 均值', m1Profile !== undefined && m1Profile.tokensMean === 1200, `tokensMean=${m1Profile?.tokensMean}`);
}

// ─────────────────────────── ⑫ 学习反哺调度 ───────────────────────────

console.log('⑫ 学习反哺调度（学到的画像改变调度行为——闭环的最后一段）');
{
  // 调度器骨架：真实 ModelScheduler + 真实 LLMClient（离线 mock 端点）+ 记忆 stub
  //（与 verify-mod-scheduler 同口径；评分差刻意窄——乘数才能翻转选型）
  const est = (posteriorMean, wilsonLower, effectiveSamples = 20) => ({
    modelId: '', taskType: '', alpha: posteriorMean * effectiveSamples + 1, beta: (1 - posteriorMean) * effectiveSamples + 1,
    posteriorMean, wilsonLower, effectiveSamples, rawSuccessRate: posteriorMean, drift: 0, emaQuality: 0.6,
  });
  const makeScheduler = () => {
    const llm = new LLMClient();
    llm.registerModel({ id: 'm-hi', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { test: 0.62 } } });
    llm.registerModel({ id: 'm-lo', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { test: 0.55 } } });
    const memory = { getBayesianEstimate: (id) => ({ 'm-hi': est(0.6, 0.55), 'm-lo': est(0.55, 0.5) })[id] };
    return new ModelScheduler({ llm, memory });
  };
  const feedArmAt = (loop, agentId, success, at, i) => {
    loop.observeTask({
      taskId: `${agentId}-${i}`,
      success,
      contributors: [{ agentId, tokens: 900 }],
      forecastP: 0.5,
      at,
      source: 'direct',
    });
  };

  // 冷启动零漂移：挂载但无证据 → 乘数恒 1、选型不变
  const s0 = makeScheduler();
  const coldLoop = new PlasticityLoop();
  s0.attachPlasticityProfile(coldLoop);
  check('冷启动零漂移（无证据 → 乘数恒 1）', s0.plasticityMultiplierOf('m-hi') === 1 && s0.plasticityMultiplierOf('m-lo') === 1);
  check('冷启动选型不变', s0.assignModel('test') === 'm-hi', `chosen=${s0.assignModel('test')}`);

  // 学习翻转选型：m-lo 结算流持续优于 m-hi → 校准后验优势 → 乘数翻转 argmax
  //（时间轴取真实当下附近——调度器内部用 Date.now() 读画像，远离当下的
  // 证据会被 30 天半衰期衰减归零，这是衰减语义正确的副作用）
  const rng = mulberry32(20261111);
  const s1 = makeScheduler();
  const learnedLoop = new PlasticityLoop();
  const T = Date.now();
  for (let i = 0; i < 60; i += 1) {
    const at = T - (60 - i) * HOUR;
    feedArmAt(learnedLoop, 'model:m-lo', rng() < 0.8, at, i);
    feedArmAt(learnedLoop, 'model:m-hi', rng() < 0.25, at, i);
  }
  s1.attachPlasticityProfile(learnedLoop);
  const multLo = s1.plasticityMultiplierOf('m-lo');
  const multHi = s1.plasticityMultiplierOf('m-hi');
  check('乘数有界且方向正确（好臂 > 1 > 坏臂）', multLo > 1 && multHi < 1 && multLo <= 1.5 && multHi >= 0.5, `m-lo=×${multLo.toFixed(3)} m-hi=×${multHi.toFixed(3)}`);
  const flipped = s1.assignModel('test') === 'm-lo';
  check('学到的画像翻转调度选型（m-hi → m-lo）', flipped, `chosen=${s1.assignModel('test')}`);
  check('preferred 短路语义保持', s1.assignModel('test', 'm-hi') === 'm-hi');

  // 遗忘回滚联动：毒窗口被门控回滚后，乘数随之还原（乘数 = 学习状态的纯函数）
  const gatedLoop = new PlasticityLoop({ autoGate: { window: 25, probeSize: 40, minHistory: 40, seed: 20261111 } });
  for (let i = 0; i < 50; i += 1) {
    const at = T - (50 - i) * HOUR;
    feedArmAt(gatedLoop, 'model:m-lo', rng() < 0.8, at, i);
    feedArmAt(gatedLoop, 'model:m-hi', rng() < 0.25, at, 50 + i);
  }
  const s2 = makeScheduler();
  s2.attachPlasticityProfile(gatedLoop);
  const multBefore = s2.plasticityMultiplierOf('m-lo');
  for (let i = 0; i < 25; i += 1) feedArmAt(gatedLoop, 'model:m-lo', false, T + (i + 1) * HOUR, 100 + i); // 毒窗口
  // 乘数经调度器内部的 Date.now() 读取：两次读数间墙钟毫秒差会让惰性
  // 衰减在浮点末位漂移——位级相等在 ⑤⑨（注入时钟）已证明，此处函数
  // 等价（容差 1e-9）才是诚实口径。
  check(
    '毒窗口回滚后乘数还原（回滚联动）',
    Math.abs(s2.plasticityMultiplierOf('m-lo') - multBefore) < 1e-9,
    `×${s2.plasticityMultiplierOf('m-lo').toFixed(6)} ≈ ×${multBefore.toFixed(6)}`,
  );

  // 卸载还原
  s1.detachPlasticityProfile();
  check('detach 后乘数还原（评分链逐位回到原路径）', s1.plasticityMultiplierOf('m-lo') === 1 && s1.assignModel('test') === 'm-hi');
}

// ─────────────────────────── ⑬ τ2 结构固化 ───────────────────────────

console.log('⑬ τ2 结构固化（稳定结构 → 保持集验证 → 版本化规则档案）');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plasticity-t2-'));
  try {
    const rulesFile = path.join(dir, 'rules.json');
    const rng = mulberry32(20261212);
    const T = Date.now();
    const feed2 = (loop, arm, success, at, i) => {
      loop.observeTask({
        taskId: `${arm}-${i}`,
        success,
        contributors: [{ agentId: arm, tokens: 900, success }],
        forecastP: 0.5,
        at,
        source: 'direct',
      });
    };
    const makeLoopWith = (n, rateA, rateB) => {
      const loop = new PlasticityLoop();
      for (let i = 0; i < n; i += 1) {
        const at = T - (n - i) * HOUR;
        feed2(loop, 'model:a', rng() < rateA, at, i);
        feed2(loop, 'model:b', rng() < rateB, at, 10000 + i);
      }
      return loop;
    };

    // ① 稳定优势 → 晋升
    const loop1 = makeLoopWith(150, 0.75, 0.4);
    const cons1 = new Consolidator({ minEvents: 120, persistPath: rulesFile });
    cons1.bindSource(() => loop1.eventLog());
    cons1.consolidate(T);
    const rules1 = cons1.activeRules();
    check('稳定优势固化为偏好规则（晋升 model:a）', rules1.length === 1 && rules1[0].armId === 'model:a', JSON.stringify(rules1.map((r) => r.id)));
    check('晋升留痕且证据可审计', cons1.stats().lastOutcome?.kind === 'promote' && rules1[0].evidence.trainEvents + rules1[0].evidence.testEvents === loop1.eventLog().length);
    check('持久乘数有界且只作用于规则臂', cons1.multiplierOf('a') > 1 && cons1.multiplierOf('a') <= 1.25 && cons1.multiplierOf('b') === 1, `a=×${cons1.multiplierOf('a').toFixed(3)} b=×${cons1.multiplierOf('b')}`);

    // ② 结构比证据活得久（τ2 与 τ1 的本质区别）
    // 240 天 = 8 个半衰期：τ1 证据衰减到噪声（显式 now 读 loop——调度器
    // 内部读真实墙钟，属性属于两个信号源本身）；τ2 规则不衰减
    const later = T + 240 * 86_400_000;
    const est = (posteriorMean, wilsonLower, effectiveSamples = 20) => ({ modelId: '', taskType: '', alpha: 0, beta: 0, posteriorMean, wilsonLower, effectiveSamples, rawSuccessRate: 0, drift: 0, emaQuality: 0.6 });
    const llm = new LLMClient();
    llm.registerModel({ id: 'a', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { test: 0.6 } } });
    llm.registerModel({ id: 'b', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { test: 0.58 } } });
    const sched = new ModelScheduler({ llm, memory: { getBayesianEstimate: (id) => ({ a: est(0.55, 0.5), b: est(0.54, 0.49) })[id] } });
    sched.attachPlasticityProfile(loop1);
    sched.attachDurableRules(cons1);
    const profLater = loop1.armProfile('model:a', later);
    check(
      '240 天（8 半衰期）后 τ1 证据归零、τ2 规则仍生效',
      profLater !== undefined && profLater.effectiveSamples < 8 && cons1.multiplierOf('a') > 1,
      `τ1 有效样本 ${profLater?.effectiveSamples.toFixed(2)}（< 8 → 乘数归 1），τ2 ×${cons1.multiplierOf('a').toFixed(3)} 保持`,
    );
    check('未挂载规则的调度读数恒 1（零漂移）', sched.durableRuleMultiplierOf('b') === 1);

    // ③ 保持集拒绝：train 优势在 test 反转 → 候选被拒（不产生规则）
    {
      const loop2 = new PlasticityLoop();
      for (let i = 0; i < 100; i += 1) {
        const at = T - (150 - i) * HOUR;
        feed2(loop2, 'model:a', rng() < 0.8, at, i); // train：a 强
        feed2(loop2, 'model:b', rng() < 0.35, at, 20000 + i);
      }
      for (let i = 0; i < 50; i += 1) {
        const at = T - (50 - i) * HOUR;
        feed2(loop2, 'model:a', rng() < 0.2, at, 100 + i); // test：反转
        feed2(loop2, 'model:b', rng() < 0.6, at, 20100 + i);
      }
      const cons2 = new Consolidator({ minEvents: 120 });
      cons2.bindSource(() => loop2.eventLog());
      cons2.consolidate(T);
      check('train 优势在保持集反转 → 候选被拒（无规则）', cons2.activeRules().length === 0);
      check('拒绝留痕（档案记 reject）', cons2.archiveLog().some((e) => e.kind === 'reject'));
    }

    // ④ 世界反转 → 在位规则退役（行为恢复 τ1 口径）
    for (let i = 0; i < 100; i += 1) {
      const at = T + (i + 1) * HOUR;
      feed2(loop1, 'model:a', rng() < 0.2, at, 200 + i);
      feed2(loop1, 'model:b', rng() < 0.75, at, 20200 + i);
    }
    cons1.consolidate(T + 100 * HOUR);
    check('世界反转 → 在位规则退役', cons1.activeRules().length === 0 && cons1.multiplierOf('a') === 1, `lastOutcome=${cons1.stats().lastOutcome?.kind}`);
    check('退役留痕（档案记 retire）', cons1.archiveLog().some((e) => e.kind === 'retire'));

    // ⑤ 档案链审计 + 持久化重启
    check('档案链完整', cons1.verifyArchiveChain() === true);
    const snap = cons1.snapshotState();
    const tampered = structuredClone(snap);
    tampered.archive[0].kind = 'retire'; // 篡改历史动作
    cons1.restoreState(tampered);
    check('篡改档案历史 → 验链失败', cons1.verifyArchiveChain() === false);
    cons1.restoreState(snap);
    check('还原快照 → 验链恢复', cons1.verifyArchiveChain() === true);

    // 重启续档：重新晋升一条规则后重建固化器
    for (let i = 0; i < 200; i += 1) {
      const at = T + (200 + i) * HOUR;
      feed2(loop1, 'model:a', rng() < 0.75, at, 400 + i);
      feed2(loop1, 'model:b', rng() < 0.3, at, 20400 + i);
    }
    cons1.consolidate(T + 400 * HOUR);
    const reloaded = new Consolidator({ minEvents: 120, persistPath: rulesFile });
    check('规则档案重启续存', reloaded.activeRules().length === cons1.activeRules().length && reloaded.verifyArchiveChain() === true);

    // ⑥ onEvent 节奏驱动
    const cons3 = new Consolidator({ minEvents: 2, interval: 3 });
    cons3.bindSource(() => loop1.eventLog());
    let fired = 0;
    for (let i = 0; i < 7; i += 1) if (cons3.onEvent()) fired += 1;
    check('onEvent 按 interval 节奏触发固化', fired === 2 && cons3.stats().consolidations === 2, `fired=${fired}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────── ⑭ 上下文条件化 ───────────────────────────

console.log('⑭ 上下文条件化（规则前提：X 类任务偏好模型 A）');
{
  // 数据构造：每 (臂,上下文) 系列用独立种子子流——共享流的跨步抽取
  // 有长程相关（实测 ±2.4σ 摆动），会污染保持集验证的分辨率
  const T = Date.now();
  const mkRate = (seed, p) => {
    const r = mulberry32(seed);
    return () => r() < p;
  };
  const feedCtx = (loop, arm, success, ctx, at, i) => {
    loop.observeTask({
      taskId: `${arm}-${ctx}-${i}`,
      success,
      contributors: [{ agentId: arm, tokens: 900, success }],
      forecastP: 0.5,
      at,
      taskContext: ctx,
      source: 'direct',
    });
  };

  // ① 分流固化：code 上 a 强、chat 上 b 强 → 两条上下文规则（无全局规则）
  const loop = new PlasticityLoop();
  const aCode = mkRate(301, 0.75), bCode = mkRate(302, 0.4), aChat = mkRate(303, 0.35), bChat = mkRate(304, 0.7);
  for (let i = 0; i < 150; i += 1) {
    const at = T - (300 - i) * HOUR;
    feedCtx(loop, 'model:a', aCode(), 'code', at, i);
    feedCtx(loop, 'model:b', bCode(), 'code', at, 1000 + i);
    feedCtx(loop, 'model:a', aChat(), 'chat', at, 2000 + i);
    feedCtx(loop, 'model:b', bChat(), 'chat', at, 3000 + i);
  }
  const cons = new Consolidator({ minEvents: 120 });
  cons.bindSource(() => loop.eventLog());
  cons.consolidate(T);
  const rules = cons.activeRules();
  const codeRule = rules.find((r) => r.taskContext === 'code');
  const chatRule = rules.find((r) => r.taskContext === 'chat');
  check('分桶固化出两条上下文规则（code→a，chat→b）', codeRule?.armId === 'model:a' && chatRule?.armId === 'model:b' && rules.length === 2, JSON.stringify(rules.map((r) => `${r.taskContext}→${r.armId.replace('model:', '')}`)));
  check('上下文规则查找语义（各归各桶）', cons.multiplierOf('a', 'code') > 1 && cons.multiplierOf('a', 'chat') === 1 && cons.multiplierOf('b', 'chat') > 1 && cons.multiplierOf('b', 'code') === 1);
  check('无全局规则时无上下文查询恒中性', cons.multiplierOf('a') === 1 && cons.multiplierOf('b') === 1);

  // ② 精确上下文压过全局（更具体的结构支配更泛的结构）
  const loop2 = new PlasticityLoop();
  const aGlobal = mkRate(311, 0.7), bGlobal = mkRate(312, 0.4), aChat2 = mkRate(313, 0.3), bChat2 = mkRate(314, 0.65);
  for (let i = 0; i < 150; i += 1) {
    const at = T - (300 - i) * HOUR;
    feedCtx(loop2, 'model:a', aGlobal(), undefined, at, i); // 全局桶：a 强
    feedCtx(loop2, 'model:b', bGlobal(), undefined, at, 4000 + i);
    feedCtx(loop2, 'model:a', aChat2(), 'chat', at, 5000 + i); // chat 桶：b 强
    feedCtx(loop2, 'model:b', bChat2(), 'chat', at, 6000 + i);
  }
  const cons2 = new Consolidator({ minEvents: 120 });
  cons2.bindSource(() => loop2.eventLog());
  cons2.consolidate(T);
  check(
    '精确上下文规则压过全局规则',
    cons2.multiplierOf('a', 'chat') === 1 && cons2.multiplierOf('b', 'chat') > 1 && cons2.multiplierOf('a', 'unknown-ctx') > 1,
    `chat: a=×${cons2.multiplierOf('a', 'chat')} b=×${cons2.multiplierOf('b', 'chat').toFixed(3)}；全局兜底: a@unknown=×${cons2.multiplierOf('a', 'unknown-ctx').toFixed(3)}`,
  );

  // ③ 调度消费 taskType（评分链的上下文感知读数）
  const est = (pm, wl) => ({ modelId: '', taskType: '', alpha: 0, beta: 0, posteriorMean: pm, wilsonLower: wl, effectiveSamples: 20, rawSuccessRate: 0, drift: 0, emaQuality: 0.6 });
  const llm = new LLMClient();
  llm.registerModel({ id: 'a', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { code: 0.6, chat: 0.6 } } });
  llm.registerModel({ id: 'b', endpoint: 'http://mock.local', initialCapabilities: { taskScores: { code: 0.58, chat: 0.58 } } });
  const sched = new ModelScheduler({ llm, memory: { getBayesianEstimate: (id) => ({ a: est(0.55, 0.5), b: est(0.54, 0.49) })[id] } });
  sched.attachDurableRules(cons);
  check(
    '调度读数按 taskType 分流',
    sched.durableRuleMultiplierOf('a', 'code') > 1 && sched.durableRuleMultiplierOf('a', 'chat') === 1 && sched.durableRuleMultiplierOf('b', 'code') === 1,
  );

  // ④ 链哈希覆盖 taskContext（篡改上下文标签可检出）
  check('学习链完整（含上下文标签）', loop.verifyLearningChain() === true);
  const snap = loop.snapshotState();
  const tampered = structuredClone(snap);
  tampered.events[0].taskContext = 'tampered';
  loop.restoreState(tampered);
  check('篡改事件上下文标签 → 验链失败', loop.verifyLearningChain() === false);
  loop.restoreState(snap);

  // ⑤ 桥接透传：settleTask 的 taskContext 进入学习流
  const bridge = new SymbiosisBridge({ runtime: { clock: () => T } });
  const bloop = new PlasticityLoop();
  bridge.registerModel('m1');
  bridge.attachPlasticity(bloop);
  bridge.settleTask({ success: true, nodeResults: [{ modelId: 'm1', success: true, quality: 0.9 }] }, { taskContext: 'code' });
  const ev = bloop.eventLog()[bloop.eventLog().length - 1];
  check('settleTask 的 taskContext 透传进学习流', ev.taskContext === 'code');
}

// ─────────────────────────── 汇总 ───────────────────────────

console.log(`\n通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.error(`✗ ${failed} 项锚点失败`);
  process.exit(1);
}
console.log('✓ 双系统可塑性 τ1 学习闭环全部锚点通过');
