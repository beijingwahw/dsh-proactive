/**
 * verify-r4-governance.mjs — 第四轮模块域 R4-A13 升级：治理三件套新维度验证
 *
 * 覆盖 tenant-manager / crypto-engine / safety-governor 五项全新维度，每项配
 * 「旧行为 vs 新行为」构造对照（不是「改了」，是「证明更好」）：
 *   ⓪ 零漂移总检：全部 R4 配置缺省时新读数 undefined / 空操作 / 结构化拒绝，
 *      既有行为（reportThreat 首报 observe、encryptFile keyVersion 恒 1）原样
 *   ① R4-1 配额预测性调整：增长流（1,2,3,4,5/桶）在 EWMA=4.0625、斜率=+1、
 *      外推 2 桶 = 6.0625 ≥ 预警线 0.8×6 → 预警时刻严格先于首个实际越限桶
 *      （提前 1000ms）；旧口径（反应式滚动窗口执法）越限前 0 次预警；
 *      平稳流（恒 3/桶）8 桶全程零误报；下行流不误报且 timeToBreach=null；
 *      扩容建议 ⌈6.0625/0.7⌉=9、增量 3
 *   ② R4-2 密钥分级：三级密钥差异化轮换（low 500ms 到点轮换 v2、
 *      high 50000ms 仍 v1）+ 算法强度分化（low CBC 无 tag / high GCM 有 tag）
 *      + 错级检测（low 密钥加密 high 数据 → 告警记账 + policyViolation 位；
 *      reject 模式结构化拒绝；正确分级零告警）+ 轮换后旧版本账本仍可解
 *   ③ R4-3 安全事件取证：连锁事件流（信号→行动→效果→行动→效果，含
 *      一因两果的树状因果边）按事件 ID 聚合重建——回放序严格递增、
 *      因果引用全部可解析、时间单调不减、三相位覆盖；两起事故交错记录
 *      互不串线；关闭后归档不可再记；未知引用/未知事故/重复开启结构化拒绝
 *   ④ R4-4 审计合规导出：多租户场景（3 租户 + 水填充公平配额 + 吵闹邻居
 *      账本 + 阶梯/拦截审计 + 取证事故）报告完整（字段序构造固定、数组
 *      稳定排序、SHA-256 全文摘要可独立复核）；同状态两次导出逐位一致
 *   ⑤ R4-5 威胁评分：低危流（分 0.08 < 0.45）仍走经典渐进（首报 observe、
 *      冷却内吸收、+1 步进——第三轮行为逐位保持）；中危流（0.70 ≥ 0.65）
 *      首报直达 breaker；高危流（1.00 ≥ 0.85）首报直达 kill（旧行为对照：
 *      无评分器时到 kill 需 4 次升级 ≥ 3 个冷却期，跳档 1 次上报直达）；
 *      在途因高分跳档绕过冷却；kill 咬合 kill-switch、breaker 咬合熔断
 *
 * 确定性：全部时间走注入合成时钟；分级轮换/信封轮换无真随机之外的
 * 依赖（AES IV 随机不影响断言）；预测为纯函数（EWMA + 最小二乘）。
 *
 * 运行：npm run build && node scripts/verify-r4-governance.mjs
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TenantManager, CryptoEngine, SafetyGovernor } from '../dist/index.mjs';

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
function near(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}
function section(title) {
  console.log(`\n■ ${title}`);
}
/** 期望抛错（返回错误；未抛错返回 null） */
function throws(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

/** 可变合成时钟 */
function syntheticClock(base = 1_700_000_000_000) {
  const state = { now: base };
  return { state, clock: () => state.now };
}

const tempDirs = [];
function makeTenantManager(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-verify-r4-gov-${tag}-`));
  tempDirs.push(dir);
  return new TenantManager(dir);
}

// ═══════════════════ ⓪ 零漂移总检（缺省 = 旧行为） ═══════════════════

section('⓪ 零漂移总检：全部 R4 配置缺省时，新读数缺席、旧行为逐位保留');

{
  // TenantManager：预测与合规导出全部 opt-in
  const tm = makeTenantManager('plain');
  ok(
    ['configureQuotaForecast', 'observeUsage', 'forecastQuota', 'forecastAll', 'exportComplianceReport', 'serializeComplianceReport'].every(
      (m) => typeof tm[m] === 'function',
    ),
    '租户管理器新方法面完整（预测 4 + 合规导出 2）',
  );
  ok(tm.observeUsage('t', 'llm-tokens', 100).recorded === false, '未配置预测：观测为无害空操作（recorded=false，零状态）');
  ok(tm.forecastQuota('t', 'llm-tokens') === undefined && tm.forecastAll() === undefined, '预测读数缺席（未配置 → undefined 诚实降级）');

  // CryptoEngine：tiered 缺席时既有加密路径原样
  const ce = new CryptoEngine({ enabled: false, masterKey: 'R4-零漂移主密钥', algorithm: 'aes-256-gcm', sensitiveFields: [], fullFileEncryption: false });
  ok(
    ['encryptTiered', 'decryptTiered', 'tieredStatus', 'tieredAlerts'].every((m) => typeof ce[m] === 'function'),
    '加密引擎新方法面完整（分级加密 2 + 分级读数 2）',
  );
  ok(ce.tieredStatus() === undefined && ce.tieredAlerts() === undefined, '分级读数缺席（未配置 tiered —— 旧行为）');
  ok(throws(() => ce.encryptTiered('x', 'low')) !== null, '未配置分级：encryptTiered 结构化拒绝（而非静默降级）');
  const f1 = ce.encryptFile('旧路径明文');
  ok(f1.keyVersion === 1, `旧行为对照：无 tiered 时 encryptFile keyVersion 恒 ${f1.keyVersion}（单钥直加密——② 的对照组）`);
  ok(ce.decryptFile(f1) === '旧路径明文', '旧路径加解密往返原样（零漂移）');

  // SafetyGovernor：取证 / 威胁评分未挂载零介入
  const sg = new SafetyGovernor({ maxActionsPerMinute: 1000 });
  ok(
    ['attachForensics', 'openIncident', 'recordSignal', 'recordAction', 'recordEffect', 'closeIncident', 'reconstructIncident', 'forensicsView', 'attachThreatScorer', 'reportThreatSignal', 'threatScore', 'securitySummary'].every(
      (m) => typeof sg[m] === 'function',
    ),
    '治理器新方法面完整（取证 7 + 评分 3 + 摘要 1）',
  );
  ok(sg.reconstructIncident('任何事故') === undefined && sg.forensicsView() === undefined, '取证读数缺席（未挂载 → undefined）');
  ok(throws(() => sg.openIncident('INC-1')) !== null && throws(() => sg.reportThreatSignal('failure')) !== null, '未挂载取证/评分：记录与上报结构化拒绝（不产生状态）');
  ok(sg.threatScore() === undefined, '威胁分缺席（未挂载评分器 → undefined）');
  const { state: s0, clock: c0 } = syntheticClock();
  sg.attachEscalationLadder({ cooldowns: { observe: 100, throttle: 100, breaker: 100 }, clock: c0 });
  const first = sg.reportThreat('零漂移-因');
  ok(
    first.level === 'observe' && first.levelIndex === 1 && first.fastTracked === undefined && first.threatScore === undefined,
    '未挂载评分器：reportThreat 首报 observe、无跳档字段（第三轮行为逐位保持——⑤ 的对照组）',
  );
  s0.now += 10;
  const absorb = sg.reportThreat('零漂移-因');
  ok(absorb.suppressedByCooldown === true && absorb.level === 'observe', '冷却内同因上报仍被吸收（经典渐进零漂移）');
  const summary = sg.securitySummary();
  ok(
    summary.killSwitchEngaged === false && summary.ladder.causes.length === 1 && summary.incidents.byBlocker.length === 0 && summary.incidents.forensics.length === 0,
    'securitySummary 只读快照可用（未挂载取证 → forensics 空数组；无拦截 → byBlocker 空）',
  );

  // 合规导出：无任何治理器数据源时 security=null，报告仍确定性
  const r1 = tm.exportComplianceReport({ asOf: 1_234_567 });
  const r2 = tm.exportComplianceReport({ asOf: 1_234_567 });
  ok(r1.security === null && JSON.stringify(r1) === JSON.stringify(r2), '空状态合规报告两次导出逐位一致（security=null 诚实降级）');
  tm.dispose();
}

// ═══════════════════ ① 配额预测性调整（EWMA + 斜率外推） ═══════════════════

section('① 配额预测性调整：增长流预警先于越限 1000ms、平稳流零误报');

{
  const tm = makeTenantManager('forecast');
  for (const id of ['growth', 'steady', 'down']) {
    tm.registerTenant({ id, name: id, workDir: path.join(os.tmpdir(), id) });
  }
  ok(
    throws(() => tm.configureQuotaForecast({ alpha: 0, intervalMs: 1000, slopeWindow: 5, horizonMs: 2000, warnFactor: 0.8 })) !== null &&
      throws(() => tm.configureQuotaForecast({ alpha: 0.5, intervalMs: 1000, slopeWindow: 1, horizonMs: 2000, warnFactor: 0.8 })) !== null,
    '预测配置校验完备（α∈(0,1]、slopeWindow≥2）',
  );

  const { state, clock } = syntheticClock(1_000_000); // 桶索引从 1000 起
  tm.configureQuotaForecast({ alpha: 0.5, intervalMs: 1000, slopeWindow: 5, horizonMs: 2000, warnFactor: 0.8, headroom: 0.7, clock });
  ok(tm.observeUsage('ghost', 'llm-tokens', 5).recorded === true && tm.forecastQuota('no-such', 'llm-tokens') === undefined, '观测不要求租户存在；无观测的预测读数 undefined');

  // growth：配额 6（容量 6 / 需求 6 单租户到岸）
  tm.setResourceCapacity('llm-tokens', 6);
  tm.declareQuotaDemand('growth', 'llm-tokens', 6);
  tm.allocateQuotas('llm-tokens');

  // —— 增长流 1,2,3,4,5：第 5 桶后外推越线（当前未超）——
  const growth = [1, 2, 3, 4, 5];
  let fc5;
  for (let i = 0; i < growth.length; i += 1) {
    state.now = 1_000_000 + i * 1000;
    tm.observeUsage('growth', 'llm-tokens', growth[i]);
    fc5 = tm.forecastQuota('growth', 'llm-tokens');
  }
  // EWMA(α=0.5) over [1,2,3,4,5] = 4.0625；最小二乘斜率 = +1；外推 2 桶 = 6.0625
  ok(near(fc5.level, 4.0625), `EWMA 水平 = ${fc5.level.toFixed(4)}（α=0.5 对 [1,2,3,4,5] 的折叠）`);
  ok(near(fc5.slope, 1), `最小二乘斜率 = ${fc5.slope.toFixed(4)}（每桶 +1 的增长流）`);
  ok(near(fc5.projectedUsage, 6.0625) && near(fc5.projectedRatio, 6.0625 / 6), `外推 2 桶 = ${fc5.projectedUsage.toFixed(4)}（4.0625 + 1×2）、比值 ${(fc5.projectedRatio / 1).toFixed(3)} ≥ 预警线 0.8`);
  ok(fc5.willExceed === true && fc5.alreadyOver === false, `预警触发：当前水平 4.0625 < 配额 6 未超、外推将超（先于真正超限的提前量）`);
  ok(near(fc5.timeToBreachMs, 1937.5) && fc5.breachAt === 1_004_000 + 1937.5, `预计越限时刻：${fc5.timeToBreachMs}ms 后（(6−4.0625)/1×1000）`);
  ok(fc5.recommendedCapacity === 9 && fc5.recommendedAddition === 3, `扩容建议：⌈6.0625/0.7⌉ = ${fc5.recommendedCapacity}、增量 ${fc5.recommendedAddition}（headroom 目标容量口径）`);

  // —— 继续流到第 6 桶用量 8 > 配额 6：实际越限发生 ——
  state.now = 1_000_000 + 5 * 1000;
  tm.observeUsage('growth', 'llm-tokens', 8);
  const fc6 = tm.forecastQuota('growth', 'llm-tokens');
  ok(fc6.alreadyOver === true && near(fc6.level, 6.0625), `第 6 桶（用量 8 > 6）后 EWMA = ${fc6.level.toFixed(4)} ≥ 配额 → alreadyOver 翻转`);
  ok(
    fc5.willExceed === true && fc5.alreadyOver === false && fc6.alreadyOver === true,
    '时序证明：第 5 桶（t+4000）预警 willExceed=true 且尚未越限，首个实际越限桶在 t+5000（晚 1000ms）——预测先于执法',
  );

  // —— 旧行为对照：反应式滚动窗口执法（同流同配额）越限前 0 次预警 ——
  const tmOld = makeTenantManager('reactive');
  const { state: ro, clock: roClock } = syntheticClock(1_000_000);
  tmOld.registerTenant({ id: 'growth', name: 'growth', workDir: path.join(os.tmpdir(), 'growth-r') });
  tmOld.setResourceCapacity('llm-tokens', 6);
  tmOld.declareQuotaDemand('growth', 'llm-tokens', 6);
  tmOld.allocateQuotas('llm-tokens');
  tmOld.configureNoisyNeighbor({ windowMs: 1000, softFactor: 1.2, hardFactor: 2, maxSoftStrikes: 3, recoveryFactor: 0.5, clock: roClock });
  let oldSignals = 0;
  for (let i = 0; i < 5; i += 1) {
    ro.now = 1_000_000 + i * 1000; // 每桶一个窗口（与预测流同时刻）
    const v = tmOld.consumeQuota('growth', 'llm-tokens', growth[i]);
    if (v.level !== 'normal') oldSignals += 1;
  }
  ro.now = 1_000_000 + 5 * 1000;
  const breachEnroll = tmOld.consumeQuota('growth', 'llm-tokens', 8); // 第 6 桶：用量 8 > 6 首次实际越限（入账）
  const breachVerdict = tmOld.consumeQuota('growth', 'llm-tokens', 1); // 同桶下一笔：回看窗口才看见 8
  ok(
    oldSignals === 0 && breachEnroll.level === 'normal' && breachVerdict.level !== 'normal' && breachVerdict.ratio > 1.2,
    `旧行为对照：反应式执法前 5 桶 0 次信号；第 6 桶越限入账当拍仍 normal（执法只看历史窗口）、同桶下一拍才报 ratio ${breachVerdict.ratio.toFixed(2)} > 1.2——首个信号不早于越限；预测通道提前整整 1 桶预警`,
  );

  // —— 平稳流：恒 3/桶 × 8 桶零误报 ——
  tm.setResourceCapacity('steady-api', 6);
  tm.declareQuotaDemand('steady', 'steady-api', 6);
  tm.allocateQuotas('steady-api');
  let steadyWarnings = 0;
  let steadyForecasts = 0;
  for (let i = 0; i < 8; i += 1) {
    state.now = 2_000_000 + i * 1000;
    tm.observeUsage('steady', 'steady-api', 3);
    const f = tm.forecastQuota('steady', 'steady-api');
    steadyForecasts += 1;
    if (f.willExceed) steadyWarnings += 1;
  }
  const fSteady = tm.forecastQuota('steady', 'steady-api');
  ok(
    steadyWarnings === 0 && steadyForecasts === 8 && near(fSteady.slope, 0) && near(fSteady.projectedUsage, 3),
    `平稳流零误报：8 桶恒 3（EWMA ${fSteady.level.toFixed(1)}、斜率 ${fSteady.slope.toFixed(1)}、外推 ${fSteady.projectedUsage.toFixed(1)} / 配额 6 = 比值 0.5 < 0.8）`,
  );
  ok(fSteady.timeToBreachMs === null && fSteady.recommendedCapacity === null && fSteady.recommendedAddition === 0, '平稳流无越限时刻、无扩容建议（不制造容量焦虑）');

  // —— 下行流（6,5,4,3,2）：负斜率不误报、外推按 0 截断 ——
  tm.setResourceCapacity('down-api', 6);
  tm.declareQuotaDemand('down', 'down-api', 6);
  tm.allocateQuotas('down-api');
  for (let i = 0; i < 5; i += 1) {
    state.now = 3_000_000 + i * 1000;
    tm.observeUsage('down', 'down-api', [6, 5, 4, 3, 2][i]);
  }
  const fDown = tm.forecastQuota('down', 'down-api');
  ok(fDown.slope < 0 && fDown.willExceed === false && fDown.timeToBreachMs === null, `下行流（斜率 ${fDown.slope.toFixed(1)}）不误报、无越限预测（退潮不喊涨潮）`);

  // —— forecastAll 稳定排序（ghost 为无配额租户：只有水平/斜率读数，无预警语义）——
  const all = tm.forecastAll();
  ok(
    all.length === 4 && all.map((f) => f.tenantId + '/' + f.resource).join(',') === 'down/down-api,ghost/llm-tokens,growth/llm-tokens,steady/steady-api',
    'forecastAll 全量读数按（租户 × 资源）字典序稳定排序（含无配额的 ghost 观测序列）',
  );
  tm.dispose();
  tmOld.dispose();
}

// ═══════════════════ ② 密钥分级（差异化轮换 + 算法强度 + 错级检测） ═══════════════════

section('② 密钥分级：低/中/高三级差异化轮换与算法强度、错级告警');

{
  const cfgBase = { enabled: false, masterKey: '分级主密钥-R4', algorithm: 'aes-256-gcm', sensitiveFields: [], fullFileEncryption: false };
  let t = 1_000_000;
  const clock = () => t;
  const tiers = {
    low: { rotateAfterMs: 500, algorithm: 'aes-256-cbc' },
    medium: { rotateAfterMs: 5_000 },
    high: { rotateAfterMs: 50_000 },
  };

  // 配置校验：medium/high 强制 GCM
  ok(
    throws(() => new CryptoEngine({ ...cfgBase, tiered: { tiers: { ...tiers, medium: { rotateAfterMs: 5000, algorithm: 'aes-256-cbc' } } } })) !== null,
    '配置校验：medium 级配 CBC → 结构化拒绝（认证加密不向敏感级妥协）',
  );

  const ce = new CryptoEngine({ ...cfgBase, tiered: { tiers, clock } });

  // —— 正确分级：三级各自加密自己的密级 → 零告警 ——
  const lowPay = ce.encryptTiered('公开运行日志', 'low', 'low');
  const medPay = ce.encryptTiered('内部配置与路由表', 'medium', 'medium');
  const highPay = ce.encryptTiered('客户主密钥材料', 'high', 'high');
  ok(ce.tieredAlerts().length === 0, '正确分级零告警（low→low / medium→medium / high→high）');
  ok(
    lowPay.algorithm === 'aes-256-cbc' && lowPay.tag === undefined && highPay.algorithm === 'aes-256-gcm' && highPay.tag !== undefined,
    `算法强度分化：low 走 CBC（无认证标签）、high 走 GCM（带 tag ${String(highPay.tag).slice(0, 8)}…）`,
  );
  ok(
    ce.decryptTiered(lowPay) === '公开运行日志' && ce.decryptTiered(medPay) === '内部配置与路由表' && ce.decryptTiered(highPay) === '客户主密钥材料',
    '三级加解密往返成功（级域分隔派生、各归各级）',
  );
  ok(lowPay.keyVersion === 1 && medPay.keyVersion === 1 && highPay.keyVersion === 1, '三级版本链各自独立从 v1 起步');

  // —— 错级流：low 密钥加密 high 数据 → 告警记账 + 违规位 ——
  const misuse = ce.encryptTiered('客户主密钥材料-误用', 'low', 'high');
  const alerts = ce.tieredAlerts();
  ok(
    misuse.policyViolation === true && alerts.length === 1 && alerts[0].tier === 'low' && alerts[0].classification === 'high' && alerts[0].message.includes('错级'),
    `错级检测：low 密钥加密 high 数据 → 告警 ${alerts.length} 条（${alerts[0]?.tier}→${alerts[0]?.classification}）+ 载荷携带 policyViolation 位`,
  );
  ok(ce.decryptTiered(misuse) === '客户主密钥材料-误用', '告警模式放行密文（下游可按 policyViolation 位拦截迁移）');

  // —— 错级加密 medium 数据用 low 密钥：同样检出（分界非只对 high）——
  ce.encryptTiered('内部配置-误用', 'low', 'medium');
  ok(ce.tieredAlerts().length === 2 && ce.tieredAlerts()[1].classification === 'medium', '错级检测分级分界：low→medium 同样告警（第 2 条入账）');

  // —— reject 模式：结构化拒绝、不产密文不记账 ——
  const ceReject = new CryptoEngine({ ...cfgBase, masterKey: '拒绝模式主密钥', tiered: { tiers, onViolation: 'reject', clock } });
  const rejErr = throws(() => ceReject.encryptTiered('高级数据-拒绝流', 'low', 'high'));
  ok(rejErr !== null && String(rejErr.message).includes('错级'), `reject 模式：错级加密结构化拒绝（「${String(rejErr?.message ?? '').slice(0, 26)}…」）`);
  ok(ceReject.tieredAlerts().length === 0, 'reject 模式零告警账（拒绝即终点，不重复记账）');
  ok(ceReject.encryptTiered('高级数据-正确流', 'high', 'high').policyViolation === undefined, 'reject 模式下正确分级照常产出（无违规位）');

  // —— 分级轮换：low 500ms 到点轮换、high 50000ms 仍 v1 ——
  const lowV1 = ce.encryptTiered('低级数据-v1-窗口', 'low');
  t += 600; // 越过 low 的 500ms、远未到 medium/high
  const lowV2 = ce.encryptTiered('低级数据-v2-窗口', 'low');
  const medStill = ce.encryptTiered('中级数据-窗口', 'medium');
  const highStill = ce.encryptTiered('高级数据-窗口', 'high');
  ok(lowV2.keyVersion === 2 && medStill.keyVersion === 1 && highStill.keyVersion === 1, `差异化轮换：t+600 时 low 已轮换 v${lowV2.keyVersion}，medium/high 仍 v1（周期独立计时）`);
  ok(ce.decryptTiered(lowV1) === '低级数据-v1-窗口', '轮换后旧版本账本仍可解（全版本 history 口径，非退役即焚）');
  const st = ce.tieredStatus();
  ok(
    st.length === 3 && st.map((x) => x.tier).join(',') === 'low,medium,high' &&
      st[0].rotations === 1 && st[1].rotations === 0 && st[2].rotations === 0 &&
      st[0].rotateDueAt - st[0].activeSince === 500 && st[2].rotateDueAt - st[2].activeSince === 50000,
    `状态读数：rotations [${st.map((x) => x.rotations).join(',')}]（low 1 / medium 0 / high 0）、轮换周期 [500, 5000, 50000] 分级差异化`,
  );

  // —— 未声明密级：视为与 tier 同级（兼容渐进接入）——
  const undeclared = ce.encryptTiered('未声明密级数据', 'medium');
  ok(undeclared.classification === 'medium' && ce.tieredAlerts().length === 2, '未声明密级缺省视为与所用级同级（零告警增量）');
}

// ═══════════════════ ③ 安全事件取证（因果链时间线重建） ═══════════════════

section('③ 安全事件取证：连锁事件流按 ID 聚合的因果链完整重建');

{
  const { state, clock } = syntheticClock(2_000_000_000_000);
  const sg = new SafetyGovernor({ maxActionsPerMinute: 1000 });
  sg.attachForensics({ clock });

  ok(throws(() => sg.openIncident('')) !== null, '空事故 ID 结构化拒绝');

  // —— 两起事故交错记录（证明按 ID 聚合互不串线）——
  sg.openIncident('INC-2026-1101');
  state.now += 10;
  sg.openIncident('INC-2026-1102');

  // 事故 A：信号 → 行动(throttle) → 效果 → 行动(breaker) → 效果
  state.now += 10;
  const sig = sg.recordSignal('INC-2026-1101', 'error-rate-spike', { errorRate: 0.42, window: '5m' });
  // 事故 B 插入一条（交错）
  state.now += 5;
  sg.recordSignal('INC-2026-1102', 'latency-p99-degrade', { p99: 3200 });
  state.now += 10;
  const act1 = sg.recordAction('INC-2026-1101', 'ladder-throttle', { factor: 0.5 });
  state.now += 10;
  const eff1 = sg.recordEffect('INC-2026-1101', 'error-rate-halved', { errorRate: 0.21 });
  state.now += 10;
  const eff2 = sg.recordEffect('INC-2026-1101', 'downstream-recovered', { services: 3 }, act1.id); // 显式因果：一因两果
  state.now += 10;
  sg.recordAction('INC-2026-1101', 'ladder-breaker');
  state.now += 10;
  sg.recordEffect('INC-2026-1101', 'traffic-drained');
  // 事故 B 继续（树状：信号 → 行动 → 效果）
  state.now += 10;
  sg.recordAction('INC-2026-1102', 'scale-up-replicas', { from: 4, to: 8 });
  state.now += 10;
  sg.recordEffect('INC-2026-1102', 'p99-back-to-normal', { p99: 180 });

  ok(sig.id === 1 && sig.cause === undefined && act1.id === 2 && act1.cause === 1, `因果链接默认：信号(id=${sig.id}, 无前驱) → 行动(id=${act1.id}, cause=${act1.cause})`);
  ok(eff1.id === 3 && eff1.cause === 2 && eff2.id === 4 && eff2.cause === act1.id, `显式因果：同一行动 ${act1.id} 派生两条效果（${eff1.id} 与 ${eff2.id} 同因——树状链）`);

  const tl = sg.reconstructIncident('INC-2026-1101');
  ok(
    tl.events.length === 6 && tl.events.map((e) => e.id).join(',') === '1,2,3,4,5,6',
    `事故 A 重建：恰含本事故 6 条事件（B 的 3 条不串线），回放序 [${tl.events.map((e) => e.id).join(',')}] 严格递增`,
  );
  ok(
    JSON.stringify(tl.causalChain) === JSON.stringify([{ from: null, to: 1 }, { from: 1, to: 2 }, { from: 2, to: 3 }, { from: 2, to: 4 }, { from: 4, to: 5 }, { from: 5, to: 6 }]),
    `因果链逐边对照：null→1 / 1→2 / 2→3 / 2→4（一因两果）/ 4→5 / 5→6`,
  );
  ok(tl.consistent === true && tl.causalComplete === true && tl.phaseComplete === true, '三重核验全过：consistent（id 递增 ∧ 因果可解析 ∧ 时间单调）+ causalComplete + 三相位覆盖');
  ok(
    tl.counts.signal === 1 && tl.counts.action === 2 && tl.counts.effect === 3 && tl.counts.total === 6,
    `相位计数：signal=${tl.counts.signal} / action=${tl.counts.action} / effect=${tl.counts.effect}（信号→行动→效果的因果链回放完整）`,
  );

  const tl2 = sg.reconstructIncident('INC-2026-1102');
  ok(
    tl2.events.length === 3 && tl2.counts.signal === 1 && tl2.counts.action === 1 && tl2.counts.effect === 1 && tl2.consistent,
    '事故 B 独立重建完整（信号 1 / 行动 1 / 效果 1——交错记录零污染）',
  );

  // —— 关闭与归档 ——
  state.now += 10;
  sg.closeIncident('INC-2026-1101', 'mitigated');
  const closed = sg.reconstructIncident('INC-2026-1101');
  ok(closed.closedAt === state.now && closed.outcome === 'mitigated' && closed.durationMs === state.now - 2_000_000_000_000, `关闭归档：closedAt/outcome 入档、历时 ${closed.durationMs}ms（含交错期）`);
  ok(
    throws(() => sg.recordSignal('INC-2026-1101', '归档后事件')) !== null && throws(() => sg.closeIncident('INC-2026-1101')) !== null,
    '归档不可再记 / 重复关闭结构化拒绝',
  );

  // —— 防御性校验 ——
  ok(
    throws(() => sg.recordAction('INC-2026-1102', '引用不存在', undefined, 99)) !== null &&
      throws(() => sg.recordAction('INC-幽灵', 'x')) !== null &&
      throws(() => sg.openIncident('INC-2026-1102')) !== null,
    '未知因果前驱 / 未知事故 / 重复开启全部结构化拒绝',
  );

  const view = sg.forensicsView();
  ok(
    view.length === 2 && view[0].incidentId === 'INC-2026-1101' && view[0].events === 6 && view[0].causalComplete === true && view[1].events === 3,
    '台账总览按开启时刻排序（含事件数与链完整性旗标）',
  );
  sg.dispose?.();
}

// ═══════════════════ ④ 审计合规导出（确定性 + 逐位一致） ═══════════════════

section('④ 审计合规导出：多租户场景完整报告、两次导出逐位一致');

{
  const tm = makeTenantManager('compliance');
  for (const id of ['beta', 'alpha', 'gamma']) tm.registerTenant({ id, name: `租户-${id}`, workDir: path.join(os.tmpdir(), id), tags: ['prod'] });

  // 公平配额：容量 10、需求 [2,4,6] → 水填充 [2,4,4]
  tm.setResourceCapacity('llm-tokens', 10);
  tm.declareQuotaDemand('alpha', 'llm-tokens', 2);
  tm.declareQuotaDemand('beta', 'llm-tokens', 4);
  tm.declareQuotaDemand('gamma', 'llm-tokens', 6);
  const alloc = tm.allocateQuotas('llm-tokens');
  ok(alloc.fair && alloc.fairnessViolations === 0, `公平性核验原料：水填充 [${alloc.entries.map((e) => e.allocated).join(',')}]、公平支配性违例 ${alloc.fairnessViolations}`);

  // 吵闹邻居账本：beta 超标产生软/硬记录
  const { state: nc, clock: nClock } = syntheticClock(5_000_000);
  tm.configureNoisyNeighbor({ windowMs: 10_000, softFactor: 1.2, hardFactor: 2, maxSoftStrikes: 2, recoveryFactor: 0.5, clock: nClock });
  tm.consumeQuota('beta', 'llm-tokens', 5);
  tm.consumeQuota('beta', 'llm-tokens', 2); // 7/4=1.75 → soft
  tm.consumeQuota('beta', 'llm-tokens', 2); // soft #2 → hard
  nc.now += 1;

  // 预测：gamma（配额 4）增长流 [0.6,1.2,1.8,2.4,3.0] 产生预警行
  const { state: pc, clock: pClock } = syntheticClock(6_000_000);
  // 注意：configureQuotaForecast 覆盖全局预测配置（与 noisy 时钟独立）
  tm.configureQuotaForecast({ alpha: 0.5, intervalMs: 1000, slopeWindow: 5, horizonMs: 2000, warnFactor: 0.8, headroom: 0.7, clock: pClock });
  for (let i = 0; i < 5; i += 1) {
    pc.now = 6_000_000 + i * 1000;
    tm.observeUsage('gamma', 'llm-tokens', [0.6, 1.2, 1.8, 2.4, 3.0][i]);
  }

  // 治理器：阶梯四级推进（observe→throttle→breaker→kill，全部入审计带 blockedBy）+ 取证事故
  const { state: gc, clock: gClock } = syntheticClock(7_000_000);
  const sg = new SafetyGovernor({ maxActionsPerMinute: 1000, persistPath: undefined });
  sg.attachEscalationLadder({ cooldowns: { observe: 100, throttle: 100, breaker: 100 }, clock: gClock });
  sg.attachForensics({ clock: gClock });
  sg.reportThreat('api-key-leak-suspected'); // observe（allowed，审计 allowed=1）
  gc.now += 150;
  sg.reportThreat('api-key-leak-suspected'); // → throttle（rate-limit）
  gc.now += 150;
  sg.reportThreat('api-key-leak-suspected'); // → breaker（熔断开路）
  gc.now += 150;
  sg.reportThreat('api-key-leak-suspected'); // → kill（kill-switch 拉闸）
  sg.openIncident('INC-2026-2001');
  gc.now += 10;
  sg.recordSignal('INC-2026-2001', 'leak-signal');
  gc.now += 10;
  sg.recordAction('INC-2026-2001', 'rotate-keys');
  gc.now += 10;
  sg.recordEffect('INC-2026-2001', 'keys-rotated');

  // —— 导出两次（同 asOf）：逐位一致 ——
  const r1 = tm.exportComplianceReport({ governor: sg, asOf: 9_000_000 });
  const r2 = tm.exportComplianceReport({ governor: sg, asOf: 9_000_000 });
  const s1 = tm.serializeComplianceReport(r1);
  const s2 = tm.serializeComplianceReport(r2);
  ok(s1 === s2, `两次导出逐位一致（${s1.length} 字符 JSON 完全相等——确定性字段序 + 稳定排序）`);
  ok(r1.digest === r2.digest && /^[0-9a-f]{64}$/.test(r1.digest), `SHA-256 摘要稳定（${r1.digest.slice(0, 16)}…）`);
  const body = { ...r1 };
  delete body.digest;
  ok(crypto.createHash('sha256').update(JSON.stringify(body), 'utf-8').digest('hex') === r1.digest, '摘要可独立复核（正文 SHA-256 与报告内 digest 相等）');

  // —— 字段序与内容完整性 ——
  ok(
    JSON.stringify(Object.keys(r1)) === JSON.stringify(['reportType', 'schemaVersion', 'generatedAt', 'scope', 'tenants', 'fairness', 'forecast', 'security', 'digest']),
    `顶层字段序构造固定：[${Object.keys(r1).join(',')}]`,
  );
  ok(r1.reportType === 'dsh-compliance' && r1.generatedAt === 9_000_000 && r1.scope.tenants === 3 && r1.scope.resources === 1, `报告元信息：类型/版本/时刻/范围（${r1.scope.tenants} 租户 × ${r1.scope.resources} 资源）`);
  ok(
    r1.tenants.map((t) => t.tenantId).join(',') === 'alpha,beta,gamma',
    `租户按 ID 字典序（alpha/beta/gamma——与注册序 beta,alpha,gamma 无关）`,
  );
  const betaRep = r1.tenants.find((t) => t.tenantId === 'beta');
  ok(
    betaRep.quotas.length === 1 && betaRep.quotas[0].resource === 'llm-tokens' && betaRep.quotas[0].allocated === 4 &&
      betaRep.noisyNeighbor !== null && betaRep.noisyNeighbor.warnedEvents === 1 && betaRep.noisyNeighbor.suppressedEvents === 1,
    `租户使用段：beta 配额 4/需求 4（满足率 ${betaRep.quotas[0].satisfaction}）+ 吵闹邻居记账（软 ${betaRep.noisyNeighbor.warnedEvents} / 硬 ${betaRep.noisyNeighbor.suppressedEvents}）`,
  );
  const alphaRep = r1.tenants.find((t) => t.tenantId === 'alpha');
  ok(alphaRep.noisyNeighbor === null, '无超标租户 noisyNeighbor=null（诚实降级）');
  ok(
    r1.fairness.length === 1 && r1.fairness[0].resource === 'llm-tokens' && r1.fairness[0].fair === true && r1.fairness[0].fairnessViolations === 0 &&
      r1.fairness[0].allocatedTotal === 10 && r1.fairness[0].deficit === 2,
    `公平性核验段：分配总量 ${r1.fairness[0].allocatedTotal}/容量 10、赤字 ${r1.fairness[0].deficit}、公平违例 0（44.0 审计口径入报告）`,
  );
  ok(
    r1.forecast.length === 1 && r1.forecast[0].tenantId === 'gamma' && r1.forecast[0].willExceed === true && r1.forecast[0].recommendedCapacity === 6,
    `预测段：gamma 增长流预警入报告（外推 ${r1.forecast[0].projectedUsage.toFixed(4)}/配额 4 将超、扩容建议 ${r1.forecast[0].recommendedCapacity}）`,
  );
  const sec = r1.security;
  ok(
    sec.killSwitchEngaged === true && sec.circuitState === 'open' && sec.ladder.causes.length === 1 && sec.ladder.killActive === true && sec.ladder.breakerActive === true,
    `安全段：kill-switch 拉闸 + 熔断 open + 阶梯 kill 级快照（因 ${sec.ladder.causes[0].cause}）`,
  );
  ok(
    sec.incidents.byBlocker.length === 3 &&
      sec.incidents.byBlocker.map((b) => `${b.blocker}×${b.count}`).join(' ') === 'circuit-breaker×1 kill-switch×1 rate-limit×1',
    `拦截分桶（字典序稳定）：${sec.incidents.byBlocker.map((b) => `${b.blocker}×${b.count}`).join(' ')}（阶梯四级行动入账）`,
  );
  ok(
    sec.incidents.forensics.length === 1 && sec.incidents.forensics[0].incidentId === 'INC-2026-2001' && sec.incidents.forensics[0].events === 3 && sec.incidents.forensics[0].causalComplete === true,
    `取证事故入摘要：INC-2026-2001（3 事件、因果链完整）`,
  );
  ok(sec.incidents.allowed + sec.incidents.blocked === sec.incidents.auditEntries && sec.incidents.ladderActions >= 3, `审计账目平衡：allowed ${sec.incidents.allowed} + blocked ${sec.incidents.blocked} = ${sec.incidents.auditEntries} 条（含阶梯行动 ${sec.incidents.ladderActions} 次入账）`);

  // —— 无治理器：security=null 但其余段落完整 ——
  const r3 = tm.exportComplianceReport({ asOf: 9_000_000 });
  ok(r3.security === null && r3.tenants.length === 3 && r3.fairness.length === 1, '不传治理器 → security=null（其余段落不受影响）');
  tm.dispose();
  sg.dispose?.();
}

// ═══════════════════ ⑤ 威胁评分（多信号加权 + 阶梯跳档） ═══════════════════

section('⑤ 威胁评分：低危渐进逐位保持、中危直达 breaker、高危直达 kill');

{
  // —— 低危流：分 0.08 < 0.45 → 经典渐进（第三轮行为对照）——
  const low = new SafetyGovernor({ maxActionsPerMinute: 1000 });
  const { state: lc, clock: lClock } = syntheticClock(3_000_000_000_000);
  low.attachEscalationLadder({ cooldowns: { observe: 100, throttle: 100, breaker: 100 }, clock: lClock });
  low.attachThreatScorer({ caps: { failure: 10, anomaly: 10, unauthorized: 5 }, thresholds: { throttle: 0.45, breaker: 0.65, kill: 0.85 }, windowMs: 60_000, clock: lClock });
  low.reportThreatSignal('failure', 3_000_000_000_000);
  low.reportThreatSignal('failure', 3_000_000_000_000 + 1);
  const lowRead = low.threatScore();
  ok(
    near(lowRead.score, 0.08) && lowRead.band === 'low' && lowRead.fastTrackLevel === null &&
      lowRead.components[0].kind === 'failure' && lowRead.components[0].count === 2 && near(lowRead.components[0].subscore, 0.2),
    `低危读数：2/10 失败 × 权重 0.4 = 分 ${lowRead.score.toFixed(2)}（band=low、分量序 failure/anomaly/unauthorized 固定）`,
  );
  const l1 = low.reportThreat('渐进-因');
  lc.now += 10;
  const l2 = low.reportThreat('渐进-因');
  lc.now += 150;
  const l3 = low.reportThreat('渐进-因');
  ok(
    l1.level === 'observe' && l1.fastTracked === undefined && l2.suppressedByCooldown === true && l3.level === 'throttle' && l3.levelIndex === 2 && l3.fastTracked === undefined,
    `低危仍走经典渐进：首报 observe → 冷却内吸收 → 冷却期满 +1 至 throttle（无跳档字段——第三轮行为逐位保持）`,
  );

  // —— 中危流：分 0.70 ≥ 0.65 → 首报直达 breaker ——
  const mid = new SafetyGovernor({ maxActionsPerMinute: 1000 });
  const { state: mc, clock: mClock } = syntheticClock(3_100_000_000_000);
  mid.attachEscalationLadder({ cooldowns: { observe: 100, throttle: 100, breaker: 100 }, clock: mClock });
  mid.attachThreatScorer({ clock: mClock });
  for (let i = 0; i < 10; i += 1) mid.reportThreatSignal('failure'); // 分量 1.0 × 0.4
  for (let i = 0; i < 5; i += 1) mid.reportThreatSignal('unauthorized'); // 分量 1.0 × 0.3
  const midRead = mid.threatScore();
  ok(near(midRead.score, 0.7) && midRead.band === 'high' && midRead.fastTrackLevel === 'breaker', `中危读数：失败 10/10 + 越权 5/5 → 分 ${midRead.score.toFixed(2)}（band=high、目标档 breaker）`);
  const m1 = mid.reportThreat('凭据爆破');
  ok(
    m1.level === 'breaker' && m1.levelIndex === 3 && m1.fastTracked === true && near(m1.threatScore, 0.7) && mid.getCircuitState() === 'open',
    `中危跳档：首报即 breaker（levelIndex 3、fastTracked、熔断同步开路）——旧行为需 3 次升级 2 个冷却期`,
  );

  // —— 高危流：分 1.00 ≥ 0.85 → 首报直达 kill ——
  const high = new SafetyGovernor({ maxActionsPerMinute: 1000 });
  const { state: hc, clock: hClock } = syntheticClock(3_200_000_000_000);
  high.attachEscalationLadder({ cooldowns: { observe: 10_000, throttle: 10_000, breaker: 10_000 }, clock: hClock });
  high.attachThreatScorer({ thresholds: { throttle: 0.45, breaker: 0.65, kill: 0.85 }, clock: hClock });
  for (let i = 0; i < 10; i += 1) high.reportThreatSignal('failure');
  for (let i = 0; i < 10; i += 1) high.reportThreatSignal('anomaly');
  for (let i = 0; i < 5; i += 1) high.reportThreatSignal('unauthorized');
  const highRead = high.threatScore();
  ok(near(highRead.score, 1) && highRead.band === 'critical' && highRead.fastTrackLevel === 'kill', `高危读数：三信号全封顶 → 分 ${highRead.score.toFixed(2)}（band=critical）`);
  const h1 = high.reportThreat('数据外泄进行中');
  ok(
    h1.level === 'kill' && h1.levelIndex === 4 && h1.fastTracked === true && high.isKillSwitchEngaged() === true,
    `高危跳档：1 次上报直达 kill（observe→throttle→breaker→kill 四级一次跨过、kill-switch 拉闸）`,
  );
  const kv = high.govern('autonomous-execute');
  ok(kv.allowed === false && kv.blockedBy === 'kill-switch' && kv.action?.code === 'ladder-kill' && String(kv.action?.cause) === '数据外泄进行中', 'kill 咬合：govern() 被紧急停止拦截且裁决携带结构化行动理由');
  const auditReason = high.getAudit(100).find((a) => a.verdict?.action?.code === 'ladder-kill')?.verdict?.reason;
  ok(String(auditReason).includes('威胁分') && String(auditReason).includes('直达'), `审计入账携带跳档依据（「${auditReason}」）`);

  // —— 旧行为对照：无评分器时同因到 kill 需 4 次升级 ——
  const classic = new SafetyGovernor({ maxActionsPerMinute: 1000 });
  const { state: cc, clock: cClock } = syntheticClock(3_300_000_000_000);
  classic.attachEscalationLadder({ cooldowns: { observe: 100, throttle: 100, breaker: 100 }, clock: cClock });
  let classicReports = 0;
  let level = 'observe';
  while (level !== 'kill') {
    const r = classic.reportThreat('同因-经典');
    classicReports += 1;
    level = r.level;
    cc.now += 150; // 每次越过冷却
  }
  ok(classicReports === 4, `旧行为对照：无评分器到 kill 需 ${classicReports} 次上报（4 次升级）；威胁分通道 1 次直达——高危响应时延从 3 个冷却期压到 0`);

  // —— 在途因高分跳档：冷却内也直达（高危不等待）——
  const mid2 = new SafetyGovernor({ maxActionsPerMinute: 1000 });
  const { state: m2, clock: m2Clock } = syntheticClock(3_400_000_000_000);
  mid2.attachEscalationLadder({ cooldowns: { observe: 60_000, throttle: 60_000, breaker: 60_000 }, clock: m2Clock });
  mid2.attachThreatScorer({ clock: m2Clock });
  mid2.reportThreat('爬虫风暴'); // observe（低分起步）
  for (let i = 0; i < 5; i += 1) mid2.reportThreatSignal('failure'); // 0.5 × 0.4
  for (let i = 0; i < 10; i += 1) mid2.reportThreatSignal('anomaly'); // 1.0 × 0.3
  for (let i = 0; i < 5; i += 1) mid2.reportThreatSignal('unauthorized'); // 1.0 × 0.3 → 合计 0.80
  m2.now += 10; // 仍在 observe 冷却内
  const jump = mid2.reportThreat('爬虫风暴');
  ok(
    jump.level === 'breaker' && jump.fastTracked === true && jump.escalated === true,
    `在途因跳档：observe 冷却内（10ms < 60s）遇分 0.80 → 直达 breaker（越过 throttle、绕过冷却吸收）`,
  );
  ok(mid2.ladderView().causes[0].level === 'breaker' && mid2.ladderView().causes[0].suppressed === 0, '跳档不经过吸收路径（suppressed=0——冷却只拦渐进不拦直达）');

  // —— 窗口滑出：信号衰减后不再直达（评分是即时口径）——
  m2.now += 61_000;
  const decayed = mid2.threatScore();
  ok(decayed.score === 0 && decayed.band === 'low' && decayed.fastTrackLevel === null && decayed.signalsInWindow === 0, `窗口滑出：61s 后窗口内信号 ${decayed.signalsInWindow} 条、分归 0（威胁不永久定格）`);
  ok(
    throws(() => mid2.reportThreatSignal('unknown-kind')) !== null && throws(() => { const g = new SafetyGovernor(); g.attachThreatScorer({ thresholds: { throttle: 0.9, breaker: 0.65, kill: 0.85 } }); }) !== null,
    '评分配置与信号种类校验（阈值须 0<throttle<breaker<kill≤1、种类三选一）',
  );
  low.dispose?.();
  mid.dispose?.();
  high.disengageKillSwitch();
  high.dispose?.();
  classic.dispose?.();
  mid2.dispose?.();
}

// ═══════════════════ 汇总 ═══════════════════
for (const dir of tempDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— 治理三件套（tenant-manager / crypto-engine / safety-governor）第四轮五项新维度升级验证成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
