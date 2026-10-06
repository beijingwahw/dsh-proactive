/**
 * verify-mod-governance.mjs — 第三轮模块域升级：治理三件套（A13）新旧行为对照验证
 *
 * 覆盖 tenant-manager / crypto-engine / safety-governor 六项升级，每项配
 * 「旧行为 vs 新行为」构造对照（不是「改了」，是「证明更好」）：
 *   ① 极大极小公平配额（44.0 口径自实现水填充）：4 租户需求超总量 →
 *      与手工水填充解逐位对照（[2, 8/3, 8/3, 8/3]）；加权场景第二 oracle
 *      （[2, 2.5, 2.5, 5]，加权水位对齐）；与「按需求比例分」的分配对照
 *      （最穷者份额 2.0 vs 1.0 翻倍）；释放需求即自动重分配；公平支配性
 *      审计（violations=0）；饥饿场景（容量 3、需求 [100,100,1] → 无人饿死）
 *   ② 吵闹邻居抑制：滚动窗口梯度（normal → soft 警告 ×N → hard 拒绝）+
 *      双通道升级（ratio 直跳 / strikes 累积）+ 硬限制滞回解除 + 影响记账
 *      （warnedEvents / suppressedEvents / excessTotal）；未配置恒放行
 *      （enforced=false——旧行为逐位保留）
 *   ③ 信封加密与密钥轮换：次数轮换（3 次后第 4 次密文即 v2）+ 时长轮换
 *      （rotateAfterMs）+ 旧密文宽限期内可解 / 宽限期满退役拒绝 + 跨实例
 *      自描述（wrappedDk 随载荷走）；旧行为对照：无 envelope 时 encryptFile
 *      keyVersion 恒 1（主密钥直加密、无轮换语义）
 *   ④ Shamir 密钥托管（48.0 思想自实现兼容小工具）：5 选 3 全部 C(5,3)=10
 *      组合恢复 + 任意 2 片结构化拒绝 + 份额指纹防篡改 + 跨计划混用拒绝 +
 *      x 重复拒绝 + 与既有 shardKey/combineKeyShares 双向互通 + 端到端
 *      （恢复的主密钥解密原引擎密文）
 *   ⑤ 总督行动阶梯：observe → throttle → breaker → kill 单调逐级（levelIndex
 *      严格 +1 步进序列）+ 分级冷却（冷却内同因上报吸收不推进——不跳级不
 *      抖动）+ 三级咬合（throttle 限流上限 ×0.5 / breaker 开路 / kill 拉闸）
 *      + 结构化行动理由（action.code / cause / cooldownRemainingMs）+ 审计
 *      入账；未挂载零介入（reportThreat 拒绝、govern 无 action 键——旧行为）
 *   ⑥ 常量时间比较：等长比较迭代次数恒等于长度（与内容、失配位置无关）+
 *      长度差折叠 + safeCompareFingerprint 布尔语义兼容（旧断言值不变）
 *   ⑦ 零漂移总检：全部新配置缺省时新读数缺席、既有行为逐位保留
 *
 * 确定性：新逻辑时间全走注入时钟（信封 / 吵闹邻居 / 阶梯）；Shamir 用
 * 种子 LCG 注入 rng；水填充为纯函数——无真实定时器、无系统随机依赖。
 *
 * 运行：npm run build && node scripts/verify-mod-governance.mjs
 */

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
/** 期望抛错（返回错误消息；未抛错返回 null） */
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

/** 种子 LCG（Shamir 确定性随机源，[0,1) 区间） */
function seededRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const tempDirs = [];
function makeTenantManager(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-verify-gov-${tag}-`));
  tempDirs.push(dir);
  return new TenantManager(dir);
}

// ═══════════════════ ⑦ 零漂移总检（缺省 = 旧行为） ═══════════════════

section('⑦ 零漂移总检：全部新配置缺省时，新读数缺席、旧行为逐位保留');

{
  // TenantManager：配额 / 吵闹邻居全部 opt-in
  const tm = makeTenantManager('plain');
  ok(
    ['setResourceCapacity', 'declareQuotaDemand', 'allocateQuotas', 'releaseQuotaDemand', 'getQuotaAllocation', 'getTenantQuota', 'configureNoisyNeighbor', 'recordConsumption', 'enforceQuota', 'consumeQuota', 'noisyNeighborView'].every(
      (m) => typeof tm[m] === 'function',
    ),
    '租户管理器新方法面完整（公平配额 6 + 吵闹邻居 5）',
  );
  ok(tm.noisyNeighborView() === undefined, '吵闹邻居账本缺席（未配置 → 不检测不限流——旧行为）');
  ok(tm.getQuotaAllocation('llm-tokens') === undefined, '配额分配读数缺席（未登记容量 → 无配额语义——旧行为）');
  const v = tm.enforceQuota('t', 'llm-tokens');
  ok(v.allowed === true && v.enforced === false && v.level === 'normal', '未配置抑制：执法裁决恒放行（enforced=false——零介入）');
  ok(tm.recordConsumption('t', 'llm-tokens', 100).recorded === false, '记账为无害空操作（recorded=false，不产生任何状态）');

  // CryptoEngine：envelope 缺席时既有加密路径原样
  const ce = new CryptoEngine({ enabled: false, masterKey: '零漂移主密钥', algorithm: 'aes-256-gcm', sensitiveFields: ['secret'], fullFileEncryption: true });
  ok(
    ['encryptEnvelope', 'decryptEnvelope', 'envelopeStatus'].every((m) => typeof ce[m] === 'function') &&
      typeof CryptoEngine.escrowMasterKey === 'function' &&
      typeof CryptoEngine.recoverMasterKey === 'function' &&
      typeof CryptoEngine.constantTimeCompare === 'function',
    '加密引擎新方法面完整（信封 3 + 托管静态 2 + 常量时间 1）',
  );
  ok(ce.envelopeStatus() === undefined, '信封状态缺席（未配置 envelope——旧行为）');
  ok(throws(() => ce.encryptEnvelope('x')) !== null, '未配置信封：encryptEnvelope 结构化拒绝（而非静默降级）');
  const f1 = ce.encryptFile('旧路径明文');
  const f2 = ce.encryptFile('旧路径明文2');
  ok(f1.keyVersion === 1 && f2.keyVersion === 1, `旧行为对照：无 envelope 时 encryptFile keyVersion 恒 ${f1.keyVersion}（主密钥直加密、无轮换语义——③ 的对照组）`);
  ok(ce.decryptFile(f1) === '旧路径明文', '旧路径加解密往返原样（零漂移）');

  // SafetyGovernor：未挂载阶梯零介入
  const sg = new SafetyGovernor({ maxActionsPerMinute: 1000 });
  ok(
    ['attachEscalationLadder', 'reportThreat', 'ladderView'].every((m) => typeof sg[m] === 'function'),
    '治理器新方法面完整（挂载 / 上报 / 总览）',
  );
  ok(sg.ladderView() === undefined, '阶梯总览缺席（未挂载 → undefined 诚实降级）');
  ok(throws(() => sg.reportThreat('x')) !== null, '未挂载阶梯：reportThreat 结构化拒绝（不产生状态）');
  const verdict = sg.govern('autonomous-execute');
  ok(verdict.allowed === true && verdict.action === undefined && !('action' in verdict), '缺省裁决不携带 action 键（零漂移——⑤ 的对照组）');
  ok(sg.getStatus().escalationLadder === undefined, 'getStatus().escalationLadder === undefined（与 verification 缺席同口径）');
  sg.dispose?.();
  tm.dispose();
}

// ═══════════════════ ① 极大极小公平配额（44.0 水填充） ═══════════════════

section('① 极大极小公平配额：4 租户超卖 = 手工水填充解（44.0 口径自实现）');

{
  const tm = makeTenantManager('quota');
  for (const id of ['t1', 't2', 't3', 't4']) {
    tm.registerTenant({ id, name: id, workDir: path.join(os.tmpdir(), id) });
  }
  ok(throws(() => tm.allocateQuotas('未登记资源')) !== null, '未登记资源分配 → 结构化拒绝（先 setResourceCapacity）');
  ok(throws(() => tm.declareQuotaDemand('t1', '未登记资源', 5)) !== null, '未登记容量申报需求 → 结构化拒绝');
  ok(throws(() => tm.declareQuotaDemand('幽灵租户', 'llm-tokens', 5)) !== null, '不存在的租户申报需求 → 结构化拒绝');

  // —— 场景 A：容量 10，需求 [2,4,6,8]（合计 20 = 2 倍超卖），等权 ——
  tm.setResourceCapacity('llm-tokens', 10);
  tm.declareQuotaDemand('t1', 'llm-tokens', 2);
  tm.declareQuotaDemand('t2', 'llm-tokens', 4);
  tm.declareQuotaDemand('t3', 'llm-tokens', 6);
  tm.declareQuotaDemand('t4', 'llm-tokens', 8);
  const r = tm.allocateQuotas('llm-tokens');

  // 手工水填充：t1 到岸拿满 2；剩余 8 由 t2/t3/t4 等权均摊 8/3
  const manual = [2, 8 / 3, 8 / 3, 8 / 3];
  ok(
    r.entries.every((e, i) => near(e.allocated, manual[i])),
    `手工水填充解逐位对照：${r.entries.map((e) => `${e.tenantId}=${e.allocated.toFixed(4)}`).join(' ')}（t1 到岸拿满 2，其余 8/3 均摊）`,
  );
  ok(near(r.entries.reduce((s, e) => s + e.allocated, 0), 10), '分配总量 = 容量 10（不超发不闲置）');
  ok(near(r.waterLevel, 8 / 3), `注水水位 = ${r.waterLevel.toFixed(4)}（超额需求者的共同水位线）`);
  ok(near(r.deficit, 12), `总赤字 = ${r.deficit}（未满足需求 (4-8/3)+(6-8/3)+(8-8/3)）`);
  ok(r.fair === true && r.fairnessViolations === 0, '公平支配性审计通过（任何未拿满者的增长必挤占相对份额不高于自己的持有者）');
  ok(
    r.entries.every((e, i) => near(e.satisfaction, e.demand > 0 ? e.allocated / e.demand : 1)) && near(r.entries[0].satisfaction, 1),
    `满足率口径：t1=${r.entries[0].satisfaction.toFixed(2)}（到岸者 1）≥ t2..t4=${r.entries[1].satisfaction.toFixed(3)}（水位者相等）`,
  );

  // 与「按需求比例分配」对照（经典替代口径）：pro-rata → [1,2,3,4]，最穷者仅 1
  const proRata = [2, 4, 6, 8].map((d) => (10 * d) / 20);
  const minWater = Math.min(...r.entries.map((e) => e.allocated));
  const minProRata = Math.min(...proRata);
  ok(
    near(minWater, 2) && near(minProRata, 1) && minWater === 2 * minProRata,
    `新旧口径对照：水填充最穷者份额 ${minWater.toFixed(1)} vs 按需比例 ${minProRata.toFixed(1)}（翻倍——词典序最优先抬最穷者）`,
  );
  ok(
    r.entries.every((e, i) => e.allocated <= [2, 4, 6, 8][i] + 1e-9),
    '无过度供给：无人拿到超过申报的需求（对比「等分 10/4=2.5」会超发 t1）',
  );

  // —— 释放重分配：t4 退出 → 容量 10 供给 [2,4,6] ——
  const r2 = tm.releaseQuotaDemand('t4', 'llm-tokens');
  ok(
    r2 !== undefined && r2.entries.every((e, i) => near(e.allocated, [2, 4, 4][i])),
    `释放后自动重分配：${r2.entries.map((e) => `${e.tenantId}=${e.allocated.toFixed(1)}`).join(' ')}（t1=2 到岸、t2=4 到岸、t3=4 剩余容量）`,
  );
  ok(r2.fair === true && near(r2.deficit, 2), '重分配后仍公平（赤字 = t3 未满足的 2）');
  ok(tm.getQuotaAllocation('llm-tokens') === r2, 'getQuotaAllocation 返回最近一次分配（读数口径）');
  ok(tm.getTenantQuota('t3', 'llm-tokens')?.tenantId === 't3' && near(tm.getTenantQuota('t3', 'llm-tokens').allocated, 4), '单租户配额视图（enforceQuota 的执法基准）');

  // —— 场景 B：加权极大极小（容量 12，需求 [2,6,6,20]，权重 [1,1,1,2]）——
  const tm2 = makeTenantManager('quota-w');
  for (const id of ['w1', 'w2', 'w3', 'w4']) tm2.registerTenant({ id, name: id, workDir: path.join(os.tmpdir(), id) });
  tm2.setResourceCapacity('api-calls', 12);
  const wDemands = { w1: [2, 1], w2: [6, 1], w3: [6, 1], w4: [20, 2] };
  for (const [id, [d, w]] of Object.entries(wDemands)) tm2.declareQuotaDemand(id, 'api-calls', d, w);
  const rw = tm2.allocateQuotas('api-calls');
  // 手工：第一阶段全员按权重注水至 w1 到岸（2）耗 10；剩 2 由权重和 4 均摊 0.5/份
  ok(
    rw.entries.every((e, i) => near(e.allocated, [2, 2.5, 2.5, 5][i])),
    `加权水填充第二 oracle：${rw.entries.map((e) => `${e.tenantId}=${e.allocated.toFixed(2)}`).join(' ')}（加权水位 x/w 对齐 2.5）`,
  );
  ok(
    near(rw.entries[1].allocated / 1, rw.entries[3].allocated / 2),
    '加权公平口径：t2 份额/权重 = t4 份额/权重（44.0 加权极大极小定义）',
  );
  ok(rw.fair === true, '加权场景公平支配性审计同样通过');

  // —— 场景 C：饥饿场景（容量 3，需求 [100,100,1]）——
  const tm3 = makeTenantManager('quota-s');
  for (const id of ['s1', 's2', 's3']) tm3.registerTenant({ id, name: id, workDir: path.join(os.tmpdir(), id) });
  tm3.setResourceCapacity('gpu-hours', 3);
  tm3.declareQuotaDemand('s1', 'gpu-hours', 100);
  tm3.declareQuotaDemand('s2', 'gpu-hours', 100);
  tm3.declareQuotaDemand('s3', 'gpu-hours', 1);
  const rs = tm3.allocateQuotas('gpu-hours');
  ok(
    rs.entries.every((e) => near(e.allocated, 1)) && rs.entries[2].satisfaction === 1,
    `饥饿场景：容量 3 vs 需求 [100,100,1] → [1,1,1]（小需求者到岸满足率 1，大户各 1%——没有谁被饿死）`,
  );
  ok(rs.fair === true, '极端超卖下公平支配性仍成立（定理不因场景退化）');

  // —— 场景 D：容量充足（无超卖 → 全员到岸）——
  tm2.setResourceCapacity('宽裕资源', 100);
  tm2.declareQuotaDemand('w1', '宽裕资源', 2);
  tm2.declareQuotaDemand('w2', '宽裕资源', 4);
  const rf = tm2.allocateQuotas('宽裕资源');
  ok(rf.deficit === 0 && rf.entries.every((e) => e.satisfaction === 1), '容量充足：全员到岸、零赤字（水填充退化为按需供给）');
  ok(throws(() => tm.setResourceCapacity('坏资源', -1)) !== null && throws(() => tm.declareQuotaDemand('t1', 'llm-tokens', -5)) !== null, '非法容量/需求结构化拒绝（≥0 有限值）');
  tm.dispose(); tm2.dispose(); tm3.dispose();
}

// ═══════════════════ ② 吵闹邻居抑制（梯度限流 + 影响记账） ═══════════════════

section('② 吵闹邻居抑制：滚动窗口梯度（软警告→硬限制）+ 滞回 + 影响记账');

{
  const tm = makeTenantManager('noisy');
  for (const id of ['loud', 'burst', 'quiet']) tm.registerTenant({ id, name: id, workDir: path.join(os.tmpdir(), id) });
  ok(
    throws(() => tm.configureNoisyNeighbor({ windowMs: 0, softFactor: 1.2, hardFactor: 2, maxSoftStrikes: 3, recoveryFactor: 0.5 })) !== null &&
      throws(() => tm.configureNoisyNeighbor({ windowMs: 1000, softFactor: 2, hardFactor: 2, maxSoftStrikes: 3, recoveryFactor: 0.5 })) !== null &&
      throws(() => tm.configureNoisyNeighbor({ windowMs: 1000, softFactor: 1.2, hardFactor: 2, maxSoftStrikes: 0, recoveryFactor: 0.5 })) !== null &&
      throws(() => tm.configureNoisyNeighbor({ windowMs: 1000, softFactor: 1.2, hardFactor: 2, maxSoftStrikes: 3, recoveryFactor: Number.NaN })) !== null,
    '配置校验完备（windowMs>0 / soft<hard / strikes≥1 / recoveryFactor 有限正——含滞回参数）',
  );

  const { state, clock } = syntheticClock();
  tm.setResourceCapacity('api-calls', 20);
  tm.declareQuotaDemand('loud', 'api-calls', 15);
  tm.declareQuotaDemand('quiet', 'api-calls', 5);
  tm.allocateQuotas('api-calls'); // 需求合计 20 = 容量 → loud=15 / quiet=5 双双到岸
  // burst 用独立资源（避免改变 loud 的水填充解）
  tm.setResourceCapacity('burst-api', 15);
  tm.declareQuotaDemand('burst', 'burst-api', 15);
  tm.allocateQuotas('burst-api'); // burst=15 到岸

  tm.configureNoisyNeighbor({ windowMs: 1000, softFactor: 1.2, hardFactor: 2.0, maxSoftStrikes: 3, recoveryFactor: 0.5, clock });

  // —— 梯度序列（strikes 通道）：normal → soft×2 → hard（3 次软限制升级）——
  const seq = [];
  const step = (tenant, amount, dt) => {
    state.now += dt;
    const v = tm.consumeQuota(tenant, 'api-calls', amount);
    seq.push({ t: state.now, tenant, level: v.level, allowed: v.allowed, by: v.escalatedBy, strikes: v.softStrikes, ratio: v.ratio });
    return v;
  };
  step('loud', 5, 0); // window 5/15=0.33 → normal（入账 5）
  step('loud', 8, 100); // 13/15=0.87 → normal（入账 13）
  step('loud', 6, 100); // 13/15=0.87 → normal（入账 19）
  const soft1 = step('loud', 1, 100); // 19/15=1.27 → soft #1（入账 20）
  const soft2 = step('loud', 1, 100); // 20/15=1.33 → soft #2（入账 21）
  const hardS = step('loud', 1, 100); // 21/15=1.4 → soft #3 达 strikes 上限 → hard（拒绝、不入账）
  const hardHys = step('loud', 1, 100); // 21/15=1.4 > 解除阈 0.6 → hard 滞回（拒绝）
  const grad = seq.filter((s) => s.tenant === 'loud').map((s) => s.level).join('→');
  ok(
    [seq[0], seq[1], seq[2]].every((s) => s.level === 'normal' && s.allowed) &&
    soft1.level === 'soft' && soft1.allowed === true && soft1.softStrikes === 1 &&
    soft2.level === 'soft' && soft2.softStrikes === 2 &&
    hardS.level === 'hard' && hardS.allowed === false && hardS.escalatedBy === 'strikes',
    `梯度序列 ${grad}（ratio 通道：正常×3 → 软警告×2 → 连续 3 次软限制升级硬限制——escalatedBy=strikes）`,
  );
  ok(soft1.warning !== undefined && soft1.warning.includes('软限制警告'), `软限制带警告文案（放行但告警：「${soft1.warning.slice(0, 24)}…」）`);
  ok(hardS.reason !== undefined && hardS.reason.includes('梯度升级'), `硬限制带结构化理由（「${hardS.reason}」）`);
  ok(hardHys.level === 'hard' && hardHys.allowed === false, `滞回：硬限制在途、比值 ${hardHys.ratio.toFixed(2)} > 解除阈 ${1.2 * 0.5} → 继续拒绝（边界不抖动）`);

  // —— 被拒消费不占窗口（硬限制后窗口用量停在 21）——
  ok(near(hardHys.windowUsage, 21), `被拒消费不入账：窗口用量 ${hardHys.windowUsage}（21 后两次拒绝未增加——惩罚不吃掉自己的配额空间）`);

  // —— 窗口滑出 → 滞回解除 → 恢复 normal ——
  state.now += 1200; // 全部事件出窗（windowMs=1000）
  const recovered = tm.consumeQuota('loud', 'api-calls', 3);
  ok(recovered.level === 'normal' && recovered.allowed === true && recovered.windowUsage === 0,
    `窗口滑出后滞回解除：${hardHys.level} → ${recovered.level}（裁决时窗口已清空 → 比值 0 ≤ 解除阈 0.6，放行）`);
  const afterRecover = tm.consumeQuota('loud', 'api-calls', 2);
  ok(near(afterRecover.windowUsage, 3), `恢复后重新入账：下一笔裁决窗口 ${afterRecover.windowUsage}（上笔 3 已入账；本笔 2 裁决后入账——执法与记账恢复常态）`);

  // —— ratio 直跳通道：burst 一次记账到 2.67× → 下一笔直接硬限制 ——
  state.now += 10;
  tm.recordConsumption('burst', 'burst-api', 40); // 记账式登记（不执法）
  state.now += 10;
  const hardR = tm.consumeQuota('burst', 'burst-api', 1);
  ok(hardR.level === 'hard' && hardR.allowed === false && hardR.escalatedBy === 'ratio' && hardR.ratio > 2.6, `ratio 直跳通道：窗口 40/15=${hardR.ratio.toFixed(2)} > hardFactor 2.0 → 直接硬限制（无需软限制累积）`);

  // —— 安静租户不受影响 ——
  state.now += 10;
  const q = tm.consumeQuota('quiet', 'api-calls', 1);
  ok(q.level === 'normal' && q.allowed === true && near(q.quota, 5), `安静租户无感：quiet（配额 5）消费 1 → normal 放行（抑制只打击超标者）`);

  // —— 影响记账 ——
  const ledger = tm.noisyNeighborView();
  const loudE = ledger.find((e) => e.tenantId === 'loud');
  const burstE = ledger.find((e) => e.tenantId === 'burst');
  const quietE = ledger.find((e) => e.tenantId === 'quiet');
  ok(loudE.warnedEvents === 2 && loudE.suppressedEvents === 2, `梯度响应记账：loud 软警告 ${loudE.warnedEvents} 次、硬拒绝 ${loudE.suppressedEvents} 次（超标流被证明经历了完整梯度）`);
  ok(loudE.excessTotal === 21, `超配额总量入账：loud excessTotal=${loudE.excessTotal}（4+5+6+6——四次超标裁决的挤占量累计，影响可归因）`);
  ok(burstE.suppressedEvents >= 1 && burstE.level === 'hard', 'burst 记账在案（硬限制级 + 拒绝计数）');
  ok(quietE.warnedEvents === 0 && quietE.suppressedEvents === 0 && quietE.excessTotal === 0, 'quiet 零打扰（账本干净——抑制的外部性受控）');

  // —— 旧行为对照：未配置抑制的实例恒放行 ——
  const tmOld = makeTenantManager('noisy-old');
  for (const id of ['o1']) tmOld.registerTenant({ id, name: id, workDir: path.join(os.tmpdir(), id) });
  tmOld.setResourceCapacity('api-calls', 10);
  tmOld.declareQuotaDemand('o1', 'api-calls', 1);
  tmOld.allocateQuotas('api-calls');
  let oldAllowed = 0;
  for (let i = 0; i < 50; i += 1) {
    if (tmOld.consumeQuota('o1', 'api-calls', 1).allowed) oldAllowed += 1;
  }
  ok(oldAllowed === 50 && tmOld.noisyNeighborView() === undefined, `旧行为对照：未配置抑制时 50 笔超标消费全部放行（50/${oldAllowed}，enforced=false——限流是显式 opt-in）`);
  tm.dispose(); tmOld.dispose();
}

// ═══════════════════ ③ 信封加密与密钥轮换 ═══════════════════

section('③ 信封加密：主密钥包 DK、按次数/时长轮换、旧密钥宽限期退役');

{
  const cfgBase = { enabled: false, masterKey: '信封主密钥-A', algorithm: 'aes-256-gcm', sensitiveFields: [], fullFileEncryption: false };

  // —— 次数轮换：rotateEveryNOperations=3 ——
  let t = 1_000_000;
  const clock = () => t;
  const ce = new CryptoEngine({ ...cfgBase, envelope: { rotateEveryNOperations: 3, graceMs: 500, clock } });
  const p1 = ce.encryptEnvelope('轮换序列-1');
  const p2 = ce.encryptEnvelope('轮换序列-2');
  const p3 = ce.encryptEnvelope('轮换序列-3');
  ok(p1.keyVersion === 1 && p2.keyVersion === 1 && p3.keyVersion === 1, `前 3 笔全部 v${p1.keyVersion}（rotateEveryNOperations=3 内不轮换）`);
  const p4 = ce.encryptEnvelope('轮换序列-4');
  ok(p4.keyVersion === 2, `第 4 笔即 v${p4.keyVersion}（次数达限 → 加密前先轮换新 DK）`);
  ok(ce.decryptEnvelope(p4) === '轮换序列-4', '新数据用新密钥解密成功');
  ok(ce.decryptEnvelope(p1) === '轮换序列-1' && ce.decryptEnvelope(p2) === '轮换序列-2', `旧密文 v1 宽限期内可解（宽限 500ms、时钟前进 0——滚动迁移窗口）`);
  t += 501;
  const err = throws(() => ce.decryptEnvelope(p1));
  ok(err !== null && String(err.message).includes('宽限期'), `宽限期满退役：v1 密文拒绝解密（「${String(err?.message ?? '').slice(0, 30)}…」）`);
  ok(ce.decryptEnvelope(p4) === '轮换序列-4', '退役 v1 不影响 v2（按版本的退役账本，不是全局熔断）');
  const st = ce.envelopeStatus();
  ok(st.currentKeyVersion === 2 && st.rotations === 1 && st.retired.length === 1 && st.retired[0].graceExpired === true,
    `状态读数：当前 v${st.currentKeyVersion}、轮换 ${st.rotations} 次、退役账本 ${JSON.stringify(st.retired.map((x) => `v${x.keyVersion}@${x.graceUntil}`))}（graceExpired=true）`);

  // —— 时长轮换：rotateAfterMs=1000 ——
  let t2 = 5_000_000;
  const ce2 = new CryptoEngine({ ...cfgBase, envelope: { rotateAfterMs: 1000, graceMs: 10_000, clock: () => t2 } });
  const q1 = ce2.encryptEnvelope('时长轮换-1');
  t2 += 999;
  const q2 = ce2.encryptEnvelope('时长轮换-2');
  t2 += 2;
  const q3 = ce2.encryptEnvelope('时长轮换-3');
  ok(q1.keyVersion === 1 && q2.keyVersion === 1 && q3.keyVersion === 2, `时长轮换：t+999 仍 v1、t+1001 即 v${q3.keyVersion}（rotateAfterMs=1000 到点轮换）`);
  ok(ce2.decryptEnvelope(q1) === '时长轮换-1' && ce2.decryptEnvelope(q3) === '时长轮换-3', '时长轮换序列全部可解（v1 在宽限期内）');

  // —— 信封结构自描述：wrappedDk 随载荷走，跨实例可解 ——
  const ce3 = new CryptoEngine({ ...cfgBase, envelope: { rotateEveryNOperations: 100 } });
  const p = ce3.encryptEnvelope('跨实例自描述');
  const ce4 = new CryptoEngine({ ...cfgBase, envelope: { rotateEveryNOperations: 100 } });
  ok(
    p.__envelope === true && p.wrappedDk !== undefined && p.wrappedDk.ciphertext.length > 0 && !JSON.stringify(p).includes('跨实例自描述'),
    '载荷结构：__envelope 标记 + wrappedDk 随密文携带 + 明文零残留（DK 不落明文）',
  );
  ok(ce4.decryptEnvelope(p) === '跨实例自描述', `跨实例可解：新实例（未共享 DK、仅同主密钥）解包 wrappedDk 后成功（masterKeyVersion=v${p.masterKeyVersion} 自描述）`);

  // —— 跨主密钥版本：rotatedKeys 前置旧钥后，wrappedDk 仍可解 ——
  const ce5 = new CryptoEngine({ ...cfgBase, rotatedKeys: ['旧主密钥'], masterKey: '新主密钥', envelope: {} });
  const p5 = ce5.encryptEnvelope('跨主密钥版本');
  ok(p5.masterKeyVersion === 2 && ce5.decryptEnvelope(p5) === '跨主密钥版本', `DK 由当前主密钥包裹（masterKeyVersion=${p5.masterKeyVersion}，密钥链含历史版本——旧版载荷仍可定位解包钥）`);

  // —— 旧行为对照见 ⑦（keyVersion 恒 1）；篡改检测 ——
  const tampered = { ...p, content: { ...p.content, ciphertext: p.content.ciphertext.slice(0, -4) + (p.content.ciphertext.endsWith('0') ? '1' : '0') } };
  ok(throws(() => ce4.decryptEnvelope(tampered)) !== null, '业务密文篡改 → GCM 认证失败拒绝（信封不解被篡改的载荷）');
}

// ═══════════════════ ④ Shamir 密钥托管（48.0 思想自实现） ═══════════════════

section('④ Shamir 密钥托管：5 选 3 全组合恢复、2 片结构化拒绝、防篡改');

{
  const secret = '托管主密钥材料-2026';
  const custodians = ['机房保险柜', '法务', 'CTO', '外部审计', '异地灾备'];
  const plan = CryptoEngine.escrowMasterKey(secret, { n: 5, k: 3, custodians, rng: seededRng(7) });
  ok(
    plan.n === 5 && plan.k === 3 && plan.shares.length === 5 &&
      plan.shares.every((s) => s.k === 3 && s.n === 5 && /^[0-9a-f]{16}$/.test(s.digest) && s.custodian !== undefined),
    `计划自描述：5 份、阈值 3、每份携带 k/n + 16hex 指纹 + 保管人（${plan.shares.map((s) => s.custodian).join('/')}）`,
  );
  ok(!JSON.stringify(plan).includes(secret), '计划本体零泄露（只有派生密钥指纹，无主密钥原料）');

  // —— 全部 C(5,3)=10 组合恢复 ——
  const combos = [];
  for (let i = 0; i < 5; i += 1) for (let j = i + 1; j < 5; j += 1) for (let k = j + 1; k < 5; k += 1) combos.push([i, j, k]);
  const recovered = combos.map((c) => CryptoEngine.recoverMasterKey(c.map((idx) => plan.shares[idx])));
  ok(
    recovered.every((r) => r.masterKey === secret && r.fingerprint === plan.keyFingerprint),
    `5 选 3 任意组合全部恢复：${combos.length}/${recovered.length} 组成功且指纹与托管计划一致（Lagrange 插值正确性）`,
  );

  // —— 2 片不可恢复（结构化拒绝，而非解出错误值）——
  const two = throws(() => CryptoEngine.recoverMasterKey([plan.shares[0], plan.shares[2]]));
  ok(two !== null && String(two.message).includes('份额不足'), `任意 2 片结构化拒绝（「${two.message}」——t-1 份信息论零泄露）`);
  ok(throws(() => CryptoEngine.recoverMasterKey([plan.shares[0]])) !== null, '单份同样拒绝（≥2 份方可插值的前置校验）');

  // —— 防篡改：份额 y 被换 → 指纹校验失败 ——
  const tamperedShare = { ...plan.shares[1], y: plan.shares[2].y };
  const tamperErr = throws(() => CryptoEngine.recoverMasterKey([plan.shares[0], tamperedShare, plan.shares[3]]));
  ok(tamperErr !== null && String(tamperErr.message).includes('指纹'), `份额防篡改：y 被替换 → 指纹校验拒绝（「${tamperErr.message.slice(0, 20)}…」）`);

  // —— 跨计划混用 / x 重复 ——
  const otherPlan = CryptoEngine.escrowMasterKey('另一把主密钥', { n: 5, k: 4, rng: seededRng(9) });
  const mixErr = throws(() => CryptoEngine.recoverMasterKey([plan.shares[0], plan.shares[1], otherPlan.shares[2]]));
  ok(mixErr !== null && String(mixErr.message).includes('参数不一致'), '跨计划混用拒绝（k/n 元数据不同的份额——插值将得出垃圾值，前置校验拦截）');
  ok(throws(() => CryptoEngine.recoverMasterKey([plan.shares[0], plan.shares[0], plan.shares[1]])) !== null, '同份额重复计入拒绝（x 去重校验）');
  ok(
    throws(() => CryptoEngine.escrowMasterKey('k', { n: 5, k: 1 })) !== null &&
      throws(() => CryptoEngine.escrowMasterKey('n<k', { n: 2, k: 3 })) !== null &&
      throws(() => CryptoEngine.escrowMasterKey('x', { n: 300, k: 3 })) !== null,
    '托管参数校验（2 ≤ k ≤ n ≤ 255，GF(257) 定义域）',
  );

  // —— 与既有 48.0 小工具互通（份额 {x,y} 格式同源；托管份额承载 hex 编码形态）——
  const tool = new CryptoEngine({ enabled: false, masterKey: 'x', algorithm: 'aes-256-gcm', sensitiveFields: [], fullFileEncryption: false });
  const viaOld = tool.combineKeyShares(plan.shares.slice(0, 3).map((s) => ({ x: s.x, y: s.y })));
  ok(
    Buffer.from(viaOld, 'hex').toString('utf-8') === secret,
    '托管份额 → 既有 combineKeyShares 恢复（hex 编码形态，解码即主密钥——升级兼容小工具）',
  );
  const keyHex = CryptoEngine.generateKey();
  const oldShares = tool.shardKey(keyHex, 5, 3);
  ok(tool.combineKeyShares(oldShares) === keyHex, '既有 shardKey → combineKeyShares 原样往返（本轮升级不动 48.0 既有路径——零回归）');

  // —— 端到端：恢复的主密钥驱动新引擎解密原引擎密文 ——
  const master = CryptoEngine.generateKey();
  const enc = new CryptoEngine({ enabled: false, masterKey: master, algorithm: 'aes-256-gcm', sensitiveFields: [], fullFileEncryption: false });
  const file = enc.encryptFile('托管恢复后可解');
  const escrowPlan = CryptoEngine.escrowMasterKey(master, { n: 5, k: 3, rng: seededRng(11) });
  const rmaster = CryptoEngine.recoverMasterKey([escrowPlan.shares[4], escrowPlan.shares[0], escrowPlan.shares[2]]);
  const revived = new CryptoEngine({ enabled: false, masterKey: rmaster.masterKey, algorithm: 'aes-256-gcm', sensitiveFields: [], fullFileEncryption: false });
  ok(revived.decryptFile(file) === '托管恢复后可解', `端到端：3/5 份托管恢复主密钥 → 新引擎解密原引擎密文成功（灾难恢复闭环，指纹 ${rmaster.fingerprint} 比对通过）`);
}

// ═══════════════════ ⑤ 总督行动阶梯（单调 + 冷却 + 咬合） ═══════════════════

section('⑤ 总督行动阶梯：observe→throttle→breaker→kill 单调逐级 + 冷却吸收 + 三级咬合');

{
  // —— 单调阶梯 + 冷却（注入时钟锚定真实 now，保证熔断冷却语义可用）——
  const { state, clock } = syntheticClock(Date.now());
  const sg = new SafetyGovernor({ maxActionsPerMinute: 1000 });
  sg.attachEscalationLadder({ cooldowns: { observe: 100, throttle: 100, breaker: 100 }, clock });
  ok(sg.ladderView() !== undefined && sg.ladderView().causes.length === 0, '挂载后总览就绪（空因起步）');

  const levels = [];
  const report = (dt) => {
    state.now += dt;
    const r = sg.reportThreat('db-connection-storm', { qps: 1200 });
    levels.push({ t: state.now, level: r.level, idx: r.levelIndex, escalated: r.escalated, suppressed: r.suppressedByCooldown });
    return r;
  };
  report(0); // 首报 → observe
  report(10); // 冷却内 → 吸收
  report(50); // 冷却内（t=60 < 100）→ 吸收
  report(80); // t=140 ≥ 100 → throttle
  report(5); report(5); report(5); // t=155 冷却内 ×3 → 吸收
  report(150); // t=305 ≥ 100 → breaker
  report(200); // t=505 → kill
  const seqStr = levels.map((l) => l.level).join('→');
  ok(seqStr === 'observe→observe→observe→throttle→throttle→throttle→throttle→breaker→kill',
    `阶梯轨迹 ${seqStr}（同因 9 次上报：1 观察位 + 冷却吸收 + 逐级推进——绝不跳级）`);
  const idxSeq = levels.map((l) => l.idx);
  ok(
    idxSeq.every((v, i) => i === 0 || v === idxSeq[i - 1] || v === idxSeq[i - 1] + 1),
    `levelIndex 步进序列 [${idxSeq.join(',')}]：每步或持平（冷却吸收）或严格 +1（无 1→3 跳级）`,
  );
  ok(levels.filter((l) => l.suppressed).length === 5, `冷却吸收 5 次（上报计数但不推进——同因重复不抖动的直接证据）`);
  const view = sg.ladderView();
  const cause = view.causes.find((c) => c.cause === 'db-connection-storm');
  ok(cause.strikes === 9 && cause.escalations === 4 && cause.suppressed === 5, `状态账目：9 次上报 = 4 次升级 + 5 次冷却吸收（strikes=${cause.strikes} 分毫不差）`);
  ok(view.killActive === true, 'kill 级激活（总览三旗之一）');
  const killVerdict = sg.govern('autonomous-execute');
  ok(killVerdict.allowed === false && killVerdict.blockedBy === 'kill-switch' && killVerdict.action?.code === 'ladder-kill' && killVerdict.action?.cause === 'db-connection-storm',
    `kill 咬合：govern() 被紧急停止拦截，action={code:${killVerdict.action?.code}, cause:${killVerdict.action?.cause}}（结构化理由）`);
  const auditCodes = new Set(sg.getAudit(200).map((a) => a.verdict?.action?.code).filter(Boolean));
  ok(['ladder-observe', 'ladder-throttle', 'ladder-breaker', 'ladder-kill'].every((c) => auditCodes.has(c)), `四级行动全部入审计（${[...auditCodes].join(' / ')}）`);
  sg.disengageKillSwitch();

  // —— 独立因互不干扰 + 多因最高级咬合 ——
  const sg2 = new SafetyGovernor({ maxActionsPerMinute: 1000 });
  const { state: s2, clock: c2 } = syntheticClock(Date.now());
  sg2.attachEscalationLadder({ cooldowns: { observe: 50, throttle: 50, breaker: 50 }, clock: c2 });
  sg2.reportThreat('因甲');
  s2.now += 60; sg2.reportThreat('因甲'); // 甲 → throttle
  sg2.reportThreat('因乙'); // 乙首报 → observe
  const v2 = sg2.ladderView();
  ok(v2.causes.length === 2 && v2.throttleActive === true && v2.breakerActive === false, '多因独立计梯（甲 throttle、乙 observe；最高级决定全局旗标）');
  const ord = v2.causes.map((c) => c.cause).join(',');
  ok(ord === '因甲,因乙', `总览按严重度降序（${ord}）`);
  sg2.dispose?.();

  // —— throttle 咬合限流：A/B 对照（同配置，未挂载 vs 挂载到 throttle 级）——
  const mkGov = () => new SafetyGovernor({ maxActionsPerMinute: 10, circuitCooldownMs: 60_000 });
  const plain = mkGov(); // 旧行为基准
  let plainAllowed = 0;
  for (let i = 0; i < 12; i += 1) if (plain.govern('autonomous-execute').allowed) plainAllowed += 1;
  const plainBlocked = plain.govern('autonomous-execute');
  ok(plainAllowed === 10 && plainBlocked.allowed === false && plainBlocked.blockedBy === 'rate-limit' && plainBlocked.action === undefined,
    `旧行为基准：上限 10/min → 前 10 笔放行、第 11 笔限流（无 action 结构——⑤ 对照组）`);
  const lad = mkGov();
  const { state: s3, clock: c3 } = syntheticClock(Date.now());
  lad.attachEscalationLadder({ cooldowns: { observe: 100, throttle: 100, breaker: 100 }, throttleFactor: 0.5, clock: c3 });
  lad.reportThreat('爬虫风暴');
  s3.now += 150;
  lad.reportThreat('爬虫风暴'); // → throttle
  let ladAllowed = 0;
  let firstBlocked = null;
  for (let i = 0; i < 12; i += 1) {
    const v = lad.govern('autonomous-execute');
    if (v.allowed) ladAllowed += 1;
    else if (!firstBlocked) firstBlocked = v;
  }
  ok(ladAllowed === 5, `throttle 咬合：同一上限 10 × 0.5 → 仅 ${ladAllowed} 笔放行（限流梯度真实收紧，不是只出告警）`);
  ok(firstBlocked?.blockedBy === 'rate-limit' && firstBlocked?.action?.code === 'ladder-throttle' && String(firstBlocked?.reason).includes('阶梯限流'),
    `阶梯限流裁决携带结构化理由（code=${firstBlocked?.action?.code}，reason「${String(firstBlocked?.reason).slice(0, 30)}…」）`);

  // —— breaker 咬合：升级即开路既有熔断器 ——
  const brk = new SafetyGovernor({ maxActionsPerMinute: 1000, circuitCooldownMs: 60_000 });
  const { state: s4, clock: c4 } = syntheticClock(Date.now());
  brk.attachEscalationLadder({ cooldowns: { observe: 1, throttle: 1, breaker: 1 }, clock: c4 });
  brk.reportThreat('级联故障');
  s4.now += 2; brk.reportThreat('级联故障');
  s4.now += 2; brk.reportThreat('级联故障'); // → breaker
  ok(brk.getCircuitState() === 'open', `breaker 咬合：第三级升级即把既有熔断器打为 open（复用 4.0 状态机，不另起炉灶）`);
  const brkVerdict = brk.govern('autonomous-execute');
  ok(brkVerdict.allowed === false && brkVerdict.blockedBy === 'circuit-breaker' && brkVerdict.action?.code === 'ladder-breaker',
    'breaker 级 govern() 被熔断拦截（action.code=ladder-breaker——冷却期内拒绝）');
  ok(brk.ladderView().breakerActive === true, '总览 breakerActive 旗标一致');
}

// ═══════════════════ ⑥ 常量时间比较 ═══════════════════

section('⑥ 常量时间比较：等长迭代恒定（与内容/失配位置无关）+ 长度折叠');

{
  const L = 32;
  const base = 'a'.repeat(L);
  const equalTrace = {};
  ok(CryptoEngine.constantTimeCompare(base, base, equalTrace) === true && equalTrace.iterations === L, `等长相等：迭代 ${equalTrace.iterations} = 长度 ${L}（单循环 XOR 累积）`);
  const firstMismatch = {};
  const lastMismatch = {};
  const midMismatch = {};
  const bFirst = 'b' + base.slice(1);
  const bLast = base.slice(0, L - 1) + 'b';
  const bMid = base.slice(0, 16) + 'b' + base.slice(17);
  ok(CryptoEngine.constantTimeCompare(base, bFirst, firstMismatch) === false && firstMismatch.iterations === L, `首字节失配：迭代 ${firstMismatch.iterations} = ${L}（无早退）`);
  ok(CryptoEngine.constantTimeCompare(base, bLast, lastMismatch) === false && lastMismatch.iterations === L, `末字节失配：迭代 ${lastMismatch.iterations} = ${L}（失配位置不影响循环次数）`);
  ok(CryptoEngine.constantTimeCompare(base, bMid, midMismatch) === false && midMismatch.iterations === L, `中位失配：迭代 ${midMismatch.iterations} = ${L}（三点采样恒定）`);
  const shortA = {}; const shortB = {};
  const lenA = base.slice(0, 20);
  ok(
    CryptoEngine.constantTimeCompare(lenA, base, shortA) === false && shortA.iterations === 32 &&
      CryptoEngine.constantTimeCompare(base, lenA, shortB) === false && shortB.iterations === 32,
    `不等长折叠：20 vs 32 两个方向迭代均 ${shortA.iterations}（长度差进累积器，不在循环边界泄露长度时序）`,
  );
  const bufTrace = {};
  ok(CryptoEngine.constantTimeCompare(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]), bufTrace) === true && bufTrace.iterations === 3, 'Buffer 入参同路径（密文比较统一口径）');

  // —— safeCompareFingerprint 兼容（旧布尔语义不变，内部走常量时间路径）——
  const fp1 = 'deadbeefdeadbeef';
  const fp2 = 'deadbeefdeadbee0';
  ok(
    CryptoEngine.safeCompareFingerprint(fp1, fp1) === true &&
      CryptoEngine.safeCompareFingerprint(fp1, fp2) === false &&
      CryptoEngine.safeCompareFingerprint(fp1, fp1 + 'f') === false &&
      CryptoEngine.safeCompareFingerprint('', '') === true,
    `safeCompareFingerprint 布尔语义兼容：等/末位异/长度异/空对空 = true/false/false/true（旧断言值不变）`,
  );
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
  console.log(`PASS ${passed} / FAIL 0 —— 治理三件套（tenant-manager / crypto-engine / safety-governor）第三轮六项升级新旧行为对照验证成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
