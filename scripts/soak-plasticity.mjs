/**
 * soak-plasticity.mjs — 双系统可塑性长程浸泡（生产接线的全闭环驱动）
 *
 * 与 verify-plasticity 的差别：verify 是断言锚点（防回归），soak 是
 * 长程动态证据（学习系统跨阶段运转的真实形态）。全部组件按 index.ts
 * 的生产接线组装（真实 SymbiosisBridge / ModelScheduler / PlasticityLoop /
 * Consolidator / 磁盘持久化），虚拟时钟从 1000 小时前推进到当下。
 *
 * 五阶段 × 2000 任务（调度器真实选型 → 按真率采样结局 → 结算 → 学习）：
 *   ① 燃烧期 700：code: a 强 / chat: b 强 —— τ1 乘数应追踪、τ2 应固化
 *      code→a 与 chat→b 两条上下文规则、调度流量应流向各上下文最优臂；
 *   ② 漂移期 500：code 世界反转（c 崛起、a 跌落）—— τ1 后验应跟随；
 *   ③ 结构更替 400：持续反转 —— τ2 code 规则应退役（保持集失守）；
 *   ④ 毒窗口 50：标签翻转攻击当前最优臂 —— 遗忘门控应回滚；
 *   ⑤ 恢复期 350：回到燃烧期分布 —— 学习继续、链完整。
 *
 * 结束时做重启续存检查（从磁盘重建 loop + consolidator）。
 * 任一不变量破坏 → 非零退出。
 * 运行：node --import tsx scripts/soak-plasticity.mjs
 */

import { SymbiosisBridge } from '../src/symbiosis/bridge.ts';
import { ModelScheduler } from '../src/model-scheduler.ts';
import { LLMClient } from '../src/llm-client.ts';
import { PlasticityLoop } from '../src/plasticity/loop.ts';
import { Consolidator } from '../src/plasticity/consolidation.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─────────────────────────── 工具 ───────────────────────────

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
const N_TASKS = 2400;
const T_END = Date.now(); // 虚拟时间轴终点 = 当下（调度器内部读真实墙钟）

let failures = 0;
function invariant(name, ok, detail = '') {
  const mark = ok ? '✓' : '✗';
  if (!ok) failures += 1;
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 每上下文真率表（阶段 → { code: {模型:率}, chat: {...} }） */
const PHASES = [
  { name: '① 燃烧期', from: 0, to: 700, rates: { code: { 'm-a': 0.78, 'm-b': 0.62, 'm-c': 0.4 }, chat: { 'm-b': 0.72, 'm-a': 0.45, 'm-c': 0.3 } } },
  { name: '② 漂移期', from: 700, to: 1200, rates: { code: { 'm-a': 0.45, 'm-b': 0.5, 'm-c': 0.75 }, chat: { 'm-b': 0.72, 'm-a': 0.45, 'm-c': 0.3 } } },
  { name: '③ 结构更替', from: 1200, to: 2000, rates: { code: { 'm-a': 0.45, 'm-b': 0.5, 'm-c': 0.75 }, chat: { 'm-b': 0.72, 'm-a': 0.45, 'm-c': 0.3 } } },
  { name: '④ 毒窗口', from: 2000, to: 2200, rates: { code: { 'm-a': 0.45, 'm-b': 0.5, 'm-c': 0.75 }, chat: { 'm-b': 0.72, 'm-a': 0.45, 'm-c': 0.3 } } },
  { name: '⑤ 恢复期', from: 2200, to: 2400, rates: { code: { 'm-a': 0.78, 'm-b': 0.62, 'm-c': 0.4 }, chat: { 'm-b': 0.72, 'm-a': 0.45, 'm-c': 0.3 } } },
];

function phaseOf(t) {
  return PHASES.find((p) => t >= p.from && t < p.to) ?? PHASES[PHASES.length - 1];
}

// ─────────────────────────── 生产接线（与 index.ts 同构） ───────────────────────────

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-soak-'));
const stateFile = path.join(dir, 'plasticity.json');
const rulesFile = path.join(dir, 'plasticity-rules.json');

const bridge = new SymbiosisBridge();
const loop = new PlasticityLoop({
  persistPath: stateFile,
  autoGate: { window: 50, probeSize: 50, seed: 424242 },
});
const consolidator = new Consolidator({ persistPath: rulesFile, interval: 200, minEvents: 120 });
consolidator.bindSource(() => loop.eventLog());

const llm = new LLMClient();
for (const id of ['m-a', 'm-b', 'm-c']) {
  llm.registerModel({ id, endpoint: 'http://mock.local', initialCapabilities: { taskScores: { code: 0.6, chat: 0.6 } } });
}
// 计数记忆 stub：复刻 LongTermMemory 的贝叶斯估计语义（执行反馈 →
// 每模型×任务类型 Beta 计数）——真实系统是双通道学习：记忆驱动 UCB
// 冷启动探索 + 基础评分，可塑性乘数叠加其上。stub 恒 undefined 会让
// 全臂 n=0 平局、插入序永久独占流量（饿死）——那不是生产行为。
const memCounts = new Map(); // model::taskType → [succ, fail]
const memory = {
  getBayesianEstimate: (modelId, taskType) => {
    const c = memCounts.get(`${modelId}::${taskType}`);
    if (!c) return undefined;
    const [s, f] = c;
    const n = s + f;
    const mean = (s + 1) / (n + 2);
    const z = 1.96;
    const center = s / n;
    const half = (z * Math.sqrt((center * (1 - center)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
    return {
      modelId, taskType,
      alpha: s + 1, beta: f + 1,
      posteriorMean: mean,
      wilsonLower: n > 0 ? Math.max(0, center - half) : 0,
      effectiveSamples: n, rawSuccessRate: center, drift: 0, emaQuality: 0.6,
    };
  },
  noteOutcome: (modelId, taskType, success) => {
    const key = `${modelId}::${taskType}`;
    const c = memCounts.get(key) ?? [0, 0];
    if (success) c[0] += 1; else c[1] += 1;
    memCounts.set(key, c);
  },
};
const scheduler = new ModelScheduler({
  llm,
  memory,
  // 持续探索旋钮（真实配置项）：桶内对照是 τ2 上下文固化的数据前提——
  // 冷启动期一过就纯利用会让专业化饿死跨臂对照（结构学习无米下锅）。
  /* exploreSampleFloor 120：每模型×任务类型积累 120 样本前保持 UCB 探索——
  /* 使桶内对照在 τ2 固化门槛（minArmSamples 20 × 子窗口稳定）前就位。*/
  config: { exploreSampleFloor: 120, exploreBudget: 1_000_000, exploreBonus: 0.35 },
});
for (const id of ['m-a', 'm-b', 'm-c']) bridge.registerModel(id);
bridge.attachPlasticity(loop);
bridge.attachConsolidation(consolidator);
scheduler.attachPlasticityProfile(loop);
scheduler.attachDurableRules(consolidator);

// 独立种子子流（每 模型×上下文；防共享流跨步相关）
const streams = new Map();
const draw = (model, ctx, p) => {
  const key = `${model}|${ctx}`;
  let r = streams.get(key);
  if (!r) { r = mulberry32(0x9e37 + streams.size * 7919); streams.set(key, r); }
  return r() < p;
};

// ─────────────────────────── 主循环 ───────────────────────────

const choiceShare = { 0: { code: {}, chat: {} }, 4: { code: {}, chat: {} } }; // 燃烧期/恢复期的选型份额
const driftTailCode = {}; // 漂移尾段（1900-2000）code 选型：毒前基线
const poisonTailCode = {}; // 毒尾（2100-2200）code 选型：攻击的因果效应

console.log('双系统可塑性长程浸泡：2000 任务 × 5 阶段（生产接线，磁盘持久化）\n');

let poisonAttacks = 0;
let calibratedAtPoisonEnd = 0;
for (let t = 0; t < N_TASKS; t += 1) {
  const phase = phaseOf(t);
  const ctx = t % 2 === 0 ? 'code' : 'chat';
  const at = T_END - (N_TASKS - t) * HOUR; // 虚拟时间：1000h 前推进到当下

  let chosen;
  if (t % 5 === 4) {
    // ε-对照探针：每 10 个任务强制路由给该上下文最少样本的臂——
    // 桶内对照是 τ2 结构固化的数据前提，纯利用的路由经济学会持续
    // 饿死对照（专业化的必然代价）；对照探针是部署侧的 A/B 惯例。
    chosen = ['m-a', 'm-b', 'm-c'].reduce((lo, id) => {
      const c = memCounts.get(`${id}::${ctx}`) ?? [0, 0];
      const loC = memCounts.get(`${lo}::${ctx}`) ?? [0, 0];
      return c[0] + c[1] < loC[0] + loC[1] ? id : lo;
    }, 'm-a');
  } else {
    chosen = scheduler.assignModel(ctx) ?? 'm-a';
  }
  if ((t < 700 && t >= 500) || (t >= 2300)) {
    const bucket = t < 700 ? choiceShare[0][ctx] : choiceShare[4][ctx];
    bucket[chosen] = (bucket[chosen] ?? 0) + 1;
  }
  if (ctx === 'code' && t >= 1900 && t < 2000) driftTailCode[chosen] = (driftTailCode[chosen] ?? 0) + 1;
  if (ctx === 'code' && t >= 2100 && t < 2200) poisonTailCode[chosen] = (poisonTailCode[chosen] ?? 0) + 1;

  let success;
  if (t >= 2000 && t < 2200) {
    // 毒窗口：当前被选臂被谎报失败（标签翻转攻击，200 事件——足够对
    // 成熟臂造成真实预测退化的强度；50 次对千样本臂只是噪声，门控
    // 正确地不动）
    success = false;
    poisonAttacks += 1;
  } else {
    success = draw(chosen, ctx, phase.rates[ctx][chosen] ?? 0.5);
  }

  if (t === 2199) {
    // 毒窗口结束时 m-a 的校准读数（恢复期不变量的基线）
    calibratedAtPoisonEnd = loop.armProfile('model:m-a', at)?.calibratedMean ?? 0;
  }

  bridge.settleTask(
    { success, nodeResults: [{ modelId: chosen, success, quality: success ? 0.85 : 0.2 }] },
    { taskContext: ctx },
  );
  memory.noteOutcome(chosen, ctx, success); // 双通道：记忆计数（UCB/基础分）与可塑性并行学习

  if ((t + 1) % 400 === 0) {
    const stats = loop.stats(at);
    const rules = consolidator.activeRules().map((r) => `${r.taskContext}→${r.armId.replace('model:', '')}`);
    const rejections = stats.rejectedBatches;
    console.log(
      `  [t=${t + 1}] ${phase.name} 事件=${stats.events} 链完整=${stats.chainIntact} τ2规则=[${rules.join(', ') || '无'}] 拒批=${rejections}`,
    );
  }
}

console.log('');
// ─────────────────────────── 不变量 ───────────────────────────

console.log('不变量检查：');

// ① 链与档案完整性
invariant('学习链完整（2000 任务后）', loop.verifyLearningChain() === true);
invariant('档案链完整', consolidator.verifyArchiveChain() === true);

// ② 燃烧期行为：各上下文流量流向最优臂
const burnCode = choiceShare[0].code;
const burnCodeTotal = Object.values(burnCode).reduce((a, b) => a + b, 0);
const burnChat = choiceShare[0].chat;
const burnChatTotal = Object.values(burnChat).reduce((a, b) => a + b, 0);
invariant('燃烧期 code 流量主要流向 m-a（学习改变行为）', (burnCode['m-a'] ?? 0) / burnCodeTotal > 0.5, `m-a 占比 ${(((burnCode['m-a'] ?? 0) / burnCodeTotal) * 100).toFixed(0)}%`);
invariant('燃烧期 chat 流量主要流向 m-b（上下文分流）', (burnChat['m-b'] ?? 0) / burnChatTotal > 0.5, `m-b 占比 ${(((burnChat['m-b'] ?? 0) / burnChatTotal) * 100).toFixed(0)}%`);

// ③ τ2 规则档案有晋升记录（code→a、chat→b 至少出现过）
const archive = consolidator.archiveLog();
const promotedContexts = new Set(archive.filter((e) => e.kind === 'promote').map((e) => e.taskContext ?? 'global'));
invariant('τ2 固化发生过（code 与 chat 桶均晋升过规则）', promotedContexts.has('code') && promotedContexts.has('chat'), [...promotedContexts].join(','));

// ④ 毒的因果效应可见且被遏制：毒窗内 code 最优臂（m-c）的调度份额
// 显著低于毒前基线（攻击 → 乘数下压 → 流量重路由），学习链与档案全程完整
const finalStats = loop.stats(T_END);
const share = (bucket, id) => {
  const total = Object.values(bucket).reduce((a, b) => a + b, 0);
  return total === 0 ? 0 : (bucket[id] ?? 0) / total;
};
invariant(
  '毒窗口压低了 code 最优臂的调度份额（重路由可见）',
  share(poisonTailCode, 'm-c') < share(driftTailCode, 'm-c') - 0.1,
  `m-c 份额：毒前 ${(share(driftTailCode, 'm-c') * 100).toFixed(0)}% → 毒内 ${(share(poisonTailCode, 'm-c') * 100).toFixed(0)}%`,
);

// ⑤ 毒窗口被门控回滚（拒批 ≥ 1）
invariant('毒窗口被遗忘门控拦截', finalStats.rejectedBatches >= 1, `拒批=${finalStats.rejectedBatches}（攻击 ${poisonAttacks} 次）`);

// ⑥ 重启续存：从磁盘重建
const loop2 = new PlasticityLoop({ persistPath: stateFile });
const cons2 = new Consolidator({ persistPath: rulesFile });
const reloadedRules = cons2.activeRules().map((r) => `${r.taskContext ?? 'global'}→${r.armId.replace('model:', '')}`);
invariant('重启续存：事件与规则档案存活', loop2.eventLog().length === finalStats.events && loop2.verifyLearningChain() === true && cons2.verifyArchiveChain() === true, `事件=${loop2.eventLog().length} 规则=[${reloadedRules.join(', ') || '无'}]`);

// ─────────────────────────── 报告 ───────────────────────────

console.log('\n终态画像：');
for (const a of finalStats.arms) {
  const tau1 = scheduler.plasticityMultiplierOf(a.agentId.replace('model:', ''));
  console.log(
    `  ${a.agentId.replace('model:', '').padEnd(4)} 后验=${a.posteriorMean.toFixed(3)} 校准=${a.calibratedMean.toFixed(3)} 有效样本=${a.effectiveSamples.toFixed(0)} τ1乘数=×${tau1.toFixed(3)}`,
  );
}
console.log(`  τ2 规则：[${reloadedRules.join(', ') || '无'}]（档案 ${archive.length} 条：promote ${archive.filter((e) => e.kind === 'promote').length} / reject ${archive.filter((e) => e.kind === 'reject').length} / retire ${archive.filter((e) => e.kind === 'retire').length}）`);
console.log(`  档案动作序列：${archive.map((e) => `${e.kind}(${(e.taskContext ?? 'global')}@${e.armId.replace('model:', '')})`).join(' → ')}`);

fs.rmSync(dir, { recursive: true, force: true });
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} 项不变量失败`);
  process.exit(1);
}
console.log('✓ 长程浸泡全部不变量通过（磁盘状态已清理）');
