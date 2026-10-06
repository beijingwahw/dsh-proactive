/**
 * genesis-status.mjs — 认知中央银行仪表盘（一行命令的完整体检）
 *
 * 读取两份落盘状态（.scheduler/plasticity.json + plasticity-rules.json），
 * 输出：τ1 双臂画像 / 上下文桶 / τ2 规则与档案 / 央行仪表盘 / 宪法审计。
 * 纯只读——审计者不碰账本。
 * 运行：node --import tsx scripts/genesis-status.mjs [状态目录（缺省 .scheduler）]
 */

import { PlasticityLoop, classifyFailure } from '../src/plasticity/loop.ts';
import { Consolidator } from '../src/plasticity/consolidation.ts';
import { auditConstitution } from '../src/plasticity/constitution.ts';
import path from 'node:path';

const dir = process.argv[2] ?? '.scheduler';
const loop = new PlasticityLoop({ persistPath: path.join(dir, 'plasticity.json') });
const cons = new Consolidator({ persistPath: path.join(dir, 'plasticity-rules.json') });
cons.bindSource(() => loop.eventLog());
cons.consolidate(Date.now()); // 幂等空转：仅刷新 evidenceBase 供资本充足率读数

const st = loop.stats(Date.now());
console.log('═══ 认知中央银行仪表盘 ═══');
console.log(`学习链：${st.chainIntact ? '✓ 完整' : '✗ 破损'} | 事件 ${st.events} | 遗忘门控拒批 ${st.rejectedBatches}`);

console.log('\n── τ1 通货（能力科目）──');
for (const a of st.arms) {
  if (a.effectiveSamples < 0.5 && a.posteriorMean === 0.5) continue; // 无观测臂
  console.log(`  ${a.agentId.replace('model:', '').padEnd(14)} 后验 ${a.posteriorMean.toFixed(3)} | 校准 ${a.calibratedMean.toFixed(3)} | 样本 ${a.effectiveSamples.toFixed(0).padStart(3)} | token均 ${a.tokensMean.toFixed(0)}`);
}

const buckets = new Map();
for (const e of loop.eventLog()) buckets.set(e.taskContext ?? '全局', (buckets.get(e.taskContext ?? '全局') ?? 0) + 1);
console.log(`\n── 上下文桶（固化门槛 ${120}/桶）──`);
for (const [ctx, n] of [...buckets].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`  ${ctx.padEnd(20)} ${String(n).padStart(4)}${n >= 120 ? ' ✓ 达标' : `（差 ${120 - n}）`}`);
}

const rules = cons.activeRules();
const bank = cons.bankView();
console.log(`\n── τ2 结构（央行）──`);
if (rules.length === 0) {
  console.log('  流通规则：无（档案业务尚未发生）');
} else {
  for (const r of rules) {
    console.log(`  ${r.id} | 准备金(holdout) ${r.holdoutMargin.toFixed(3)} | train 边距 ${r.margin.toFixed(3)} | 出生 ${new Date(r.bornAt).toLocaleString()}`);
  }
}
console.log(`  资本充足：Σ影响力 ${bank.totalInfluence} / κ×证据 ${bank.capacity || '—'}（利用率 ${(bank.utilization * 100).toFixed(0)}%）| 强制收缩 ${bank.forcedContractions} 次`);
const archive = cons.archiveLog();
if (archive.length > 0) {
  console.log(`  档案动作序列：${archive.map((e) => `${e.kind}(${(e.taskContext ?? 'global')}@${e.armId.replace('model:', '')})`).join(' → ')}`);
}

const report = auditConstitution(loop, cons);
console.log(`\n── 宪法审计：${report.holds ? '✓ 全绿' : '✗ 违宪'}（${report.checks.length} 项）──`);
for (const c of report.checks) console.log(`  ${c.holds ? '✓' : '✗'} ${c.name} — ${c.detail}`);

// 分型器自证（导入即用，防呆）
void classifyFailure;
