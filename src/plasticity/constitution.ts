/**
 * constitution.ts — 创世纪 G5 · 三账本宪法审计（统一入口）
 *
 * 三条哈希链（能量账本 / 学习链 / 规则档案）之上的跨账本恒等式：
 *
 *   宪法第一条（链完整）：学习链与档案链各自防篡改；
 *   宪法第二条（结构负债 ↔ 证据资产）：每条活跃规则的出生证据窗口
 *   必须能追溯到学习链中真实存在的事件——规则宣称 trainEvents+
 *   testEvents 条证据，其上下文桶的在场事件数不得少于宣称值
 *   （档案可被审计窗口裁剪，裁剪需如实标注 pruned，不许虚账）；
 *   宪法第三条（央行两定律）：准备金律 + 资本充足律（G2）；
 *   宪法第四条（能量守恒，若提供账本）：Σ(余额) = 初始供给 + 铸币。
 *
 * 任何一条不成立 → holds = false，violations 给出定位。
 * 纯函数：不改任何账本状态——审计者不碰账本（权力分立）。
 */

import type { PlasticityLoop } from './loop.js';
import type { Consolidator } from './consolidation.js';
import type { EnergyLedger } from '../symbiosis/ledger.js';

export interface ConstitutionCheck {
  name: string;
  holds: boolean;
  detail: string;
}

export interface ConstitutionReport {
  holds: boolean;
  checks: ConstitutionCheck[];
}

/** 三账本宪法审计（纯函数；ledger 可选——能量账本由运行时独占持有） */
export function auditConstitution(loop: PlasticityLoop, consolidator: Consolidator, ledger?: EnergyLedger): ConstitutionReport {
  const checks: ConstitutionCheck[] = [];

  // 第一条：链完整（学习链 + 档案链）
  const learningChain = loop.verifyLearningChain();
  const archiveChain = consolidator.verifyArchiveChain();
  checks.push({ name: '学习链完整', holds: learningChain, detail: learningChain ? '重算全链哈希通过' : '学习链存在篡改' });
  checks.push({ name: '档案链完整', holds: archiveChain, detail: archiveChain ? '重算全链哈希通过' : '规则档案存在篡改' });

  // 第二条：结构负债 ↔ 证据资产（跨账本恒等式）
  const events = loop.eventLog();
  const bucketCount = new Map<string, number>();
  for (const e of events) {
    const key = e.taskContext ?? '';
    bucketCount.set(key, (bucketCount.get(key) ?? 0) + 1);
  }
  for (const rule of consolidator.activeRules()) {
    const claimed = rule.evidence.trainEvents + rule.evidence.testEvents;
    const present = bucketCount.get(rule.taskContext ?? '') ?? 0;
    // 审计窗口裁剪豁免必须由客观状态背书：事件数打满 eventLimit 才可能
    // 发生过裁剪；未打满时的任何短缺都是虚账（G5 取证纪律）
    const pruned = present < claimed && learningChain && loop.prunedWindow();
    checks.push({
      name: `结构负债可溯源（${rule.id}）`,
      holds: present >= claimed || pruned,
      detail: pruned ? `窗口已裁剪（在场 ${present} < 宣称 ${claimed}，链完整=可信）` : `在场 ${present} ≥ 宣称 ${claimed}`,
    });
  }

  // 第三条：央行两定律（G2 的法定审计）
  const bank = consolidator.constitutionAudit();
  checks.push({ name: '准备金律', holds: bank.reserveHolds, detail: bank.violations.filter((v) => v.includes('准备金')).join('; ') || `全部活跃规则 ≥ 准备金率` });
  checks.push({ name: '资本充足律', holds: bank.capitalHolds, detail: bank.violations.filter((v) => v.includes('资本充足率')).join('; ') || `Σ影响力 ≤ κ×证据基础` });

  // 第四条：能量守恒（若提供账本）
  if (ledger) {
    const conservation = ledger.verifyConservation();
    const ledgerChain = ledger.stats().chainIntact;
    checks.push({ name: '能量守恒律', holds: conservation && ledgerChain, detail: conservation ? `Σ(余额) = 供给 + 铸币；链完整 ${ledgerChain}` : '守恒律或账本链失配' });
  }

  return { holds: checks.every((c) => c.holds), checks };
}
