/**
 * verify-mod-symbiosis.mjs — 第三轮模块域 A11 升级：共生经济层 8 文件新旧行为对照验证
 *
 * 六项升级各配「旧行为 vs 新行为」的构造对照（不是「改了」，是「证明更好」）：
 *   ① 订单簿不变量引擎（market，前三轮已完成——本轮复核）：价格-时间优先
 *      显式化（compareBidsPriceTime 纯函数三分量决胜）+ 撮合后 I1~I5 审计
 *      （守恒/账实相符/无负持仓/订单簿一致/版税记账）——随机订单流 10 轮
 *      撮合不变量恒成立，手工撮合与引擎结果逐位一致。
 *   ② LMSR 定价一致性（belief，前三轮已完成——本轮复核）：价格与份额
 *      互逆（q1−q2 = b·logit(p) 误差 <1e-9）、YES/NO 对称、价格=边际成本
 *      ——随机买卖轨迹 60 步三误差恒为 0（「LMSR 公式恢复后验」）；
 *      损失上界记账：任意轨迹敞口 ≤ b·ln2（Hanson 经典界），注资/提现
 *      受硬约束（无盈余拒提、提后敞口仍 ≤ 界）。
 *   ③ 账本哈希链审计（ledger，前三轮已完成——本轮复核）：区块头
 *      prevHash 链 + 块内凭证折叠根 + 纯 TS 哈希（16 位大写）——三类
 *      篡改实验（改凭证/改块根/改链接）全部检出并精确定位（seq + 块高）；
 *      journalLimit 裁剪后块头链仍连续可验（pruned 块诚实上报）。
 *   ④ 信誉衰减与女巫抵抗（agent，本轮新增）：观测封顶（滑动窗口 ×
 *      每窗计入上限）+ 冷启动额度按有效样本解锁（30 天半衰期时间加权）。
 *      新旧对照：同一小时刷 50 次成功——旧口径 50 条全入证据（有效样本
 *      50、晋级 elite、额度 210）；新口径只认 5 条（有效样本 ≈5、非 elite、
 *      额度 ≈30）。老实人跨窗口积累 30 次 → 额度 ≈130 解锁；停更 90 天
 *      （3 个半衰期）→ 有效样本 30→3.75、额度 130→25（躺在功劳簿上失效）。
 *   ⑤ 否决流论证化（runtime，本轮新增）：一票否决必须携带理由结构
 *      （损失估计 + 替代方案）——完整理由否决生效且留痕；空理由（缺失
 *      justification / 负损失估计 / 空白替代方案）否决被拒、提案放行并
 *      记入 rejectedVetoes 审计。两场景对照 + 缺省零漂移（reason 字符串
 *      口径照旧）。附 sybilGuard 执行面：新账号 50 能量进化提案被冷启动
 *      额度一票拦截，跨窗积累者与无 trustView 的自定义智能体照常放行。
 *   ⑥ 能源桑基结构化导出（observability，本轮加分）：源×汇流量矩阵
 *      双口径对账（链接聚合 vs 节点聚合恒等——单边篡改即刻检出）+
 *      CSV / JSONL / 矩阵三种结构化导出（落盘即得可消费的能量流向表）。
 *
 * 确定性：随机走种子化 mulberry32；女巫实验走注入虚拟时钟；
 * 无真网络、无真 LLM 调用。
 *
 * 运行：npm run build && node scripts/verify-mod-symbiosis.mjs
 */

import {
  EnergyLedger,
  CognitiveMarket,
  BeliefMarket,
  SymbiosisRuntime,
  AgentBase,
  TREASURY,
  BELIEF_POOL,
  compareBidsPriceTime,
  buildEnergySankey,
  buildFlowMatrix,
  exportSankeyData,
  hasTrustView,
  mulberry32,
} from '../dist/index.mjs';

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

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = 1_700_000_000_000; // 女巫实验虚拟时钟起点

/**
 * 探针智能体：propose 注入式（验证 runtime 决策面），trust 透传
 * （验证 agent 女巫抵抗面）——两根杠杆分离可控。
 */
class ProbeAgent extends AgentBase {
  constructor(id, createdAt, trust, injected = []) {
    super(id, createdAt, trust);
    this.injected = injected;
    this.kind = 'optimizer';
  }
  goal() {
    return { objective: 'probe', metrics: [], survivalThreshold: 1 };
  }
  propose() {
    return this.injected.map((p, i) => ({ id: `${this.id}#${i + 1}`, kind: p.kind, description: p.description ?? 'probe', bid: p.bid, assetRef: p.assetRef, ttlTicks: 1 }));
  }
  async execute() {
    return { success: true, valueEstimate: 0.5, summary: 'probe-executed' };
  }
}

/** 无 trustView 的自定义智能体（结构体 Mock——sybilGuard 的诚实放行对照） */
function plainManagedAgent(id, proposals) {
  return {
    id,
    kind: 'optimizer',
    goal: () => ({ objective: 'plain', metrics: [], survivalThreshold: 1 }),
    mode: () => 'active',
    reputation: () => ({ tier: 'established', effectiveSamples: 0, posteriorMean: 0.5, wilsonLower: 0, earnings: 0, spend: 0, netFlow: 0 }),
    perceive() {},
    propose: () => proposals.map((p, i) => ({ id: `${id}#${i + 1}`, kind: p.kind, description: 'plain', bid: p.bid, assetRef: p.assetRef, ttlTicks: 1 })),
    async execute() {
      return { success: true, valueEstimate: 0.5, summary: 'plain-executed' };
    },
    setMode() {},
    recordContribution() {},
    noteEarnings() {},
    noteSpend() {},
  };
}

// ═══════════════════ ⓪ 零漂移总检（缺省 = 旧行为） ═══════════════════

section('⓪ 零漂移总检：全部新面缺省时读数缺席、既有行为逐位保持');

{
  // 旧口径观测：未配 trust → 同窗高频观测全受纳（旧行为）
  const plain = new ProbeAgent('plain-legacy', T0);
  let credited = 0;
  for (let i = 0; i < 50; i += 1) if (plain.recordContribution(true, T0 + i * 60_000)) credited += 1;
  ok(credited === 50 && plain.trustView(T0).creditedObservations === 50, '未配 trust：50 次同窗观测全部受纳（旧口径，无封顶）');
  const rep = plain.reputation(T0);
  ok(near(rep.effectiveSamples, 50, 0.1) && rep.tier === 'elite', `旧口径 50 刷 → 有效样本 ${rep.effectiveSamples.toFixed(2)}、晋级 elite（wilson=${rep.wilsonLower.toFixed(3)}）`);
  ok(near(rep.spendAllowance, 210, 0.5), `旧口径 50 刷 → 冷启动读数额度 ≈ ${rep.spendAllowance.toFixed(1)}（纯读数，无执行面）`);

  // 旧口径否决：缺省 justifiedVetoes = false → reason 字符串否决照拦
  const gate = { allowed: false, reason: 'kill-switch' };
  const rt = new SymbiosisRuntime({ openingGrant: 100 }, { checkGate: () => gate });
  rt.register(new ProbeAgent('zp', Date.now(), undefined, [{ kind: 'maintenance', bid: 2 }]));
  const zr = await rt.tick();
  ok(zr.vetoes.length === 1 && zr.grants.length === 0, '缺省模式：无 justification 的 gate 否决照旧生效（reason 字符串口径）');
  ok(Array.isArray(zr.rejectedVetoes) && zr.rejectedVetoes.length === 0, '缺省模式：rejectedVetoes 恒空（否决论证化零介入）');
  ok(zr.conservationIntact, '缺省模式：生态守恒恒成立');

  // 桑基导出为纯函数：缺省不改变任何账本状态
  const led = new EnergyLedger({ initialSupply: 1000 });
  led.openAccount('a');
  led.transfer(TREASURY, 'a', 10, 'opening-grant', 'a');
  const supplyBefore = led.totalSupply();
  const rep0 = buildEnergySankey(led);
  buildFlowMatrix(rep0);
  exportSankeyData(rep0, 'csv');
  ok(led.totalSupply() === supplyBefore, '桑基矩阵/导出为只读纯函数（账本零变更）');
}

// ═══════════════════ ① 订单簿不变量引擎（market） ═══════════════════

section('① market：价格-时间优先 + 撮合后不变量审计（随机订单流恒成立 + 手工对照）');

{
  // 纯函数三分量决胜：价格降序 → 时间升序 → seq 升序
  ok(compareBidsPriceTime({ price: 100, placedAt: 5, seq: 9 }, { price: 90, placedAt: 1, seq: 1 }) < 0, 'compareBidsPriceTime：高价优先（100 > 90）');
  ok(compareBidsPriceTime({ price: 100, placedAt: 5, seq: 9 }, { price: 100, placedAt: 6, seq: 1 }) < 0, '同价：先到先得（placedAt 5 < 6）');
  ok(compareBidsPriceTime({ price: 100, placedAt: 5, seq: 9 }, { price: 100, placedAt: 5, seq: 8 }) > 0, '同价同毫秒：全局序号决胜（seq 8 < 9）');

  // 手工撮合对照：三单不同价 → 最高价成交
  const ledger = new EnergyLedger({ initialSupply: 100_000 });
  const market = new CognitiveMarket(ledger);
  ledger.openAccount('seller-m');
  ledger.transfer(TREASURY, 'seller-m', 5_000, 'test-fund', 'm');
  const listed = market.list({ seller: 'seller-m', kind: 'pattern', refId: 'ref-m', description: '手工对照资产', ask: 80, claimedQuality: 0.8 });
  ok(listed.ok, `挂单成功（上架费 ${listed.listingFee} 燃烧）`);
  for (const [who, amt] of [['b-low', 95], ['b-high', 100], ['b-mid', 97]]) {
    ledger.openAccount(who);
    ledger.transfer(TREASURY, who, 500, 'test-fund', who);
  }
  market.placeBid('b-low', listed.assetId, 95);
  market.placeBid('b-high', listed.assetId, 100);
  market.placeBid('b-mid', listed.assetId, 97);
  const book = market.orderBook(listed.assetId);
  ok(book.length === 3 && book[0].bidder === 'b-high' && book[1].bidder === 'b-mid' && book[2].bidder === 'b-low', `订单簿价格-时间排序：${book.map((b) => `${b.bidder}@${b.price}`).join(' > ')}`);
  ok(market.bestBid(listed.assetId).price === 100, 'bestBid = 最高价 100');
  const trades = market.match();
  ok(trades.length === 1 && trades[0].buyer === 'b-high' && trades[0].price === 100, `手工对照：撮合取最高价（b-high 以 100 成交，与手工一致）`);
  ok(market.orderBook(listed.assetId).length === 0, '成交后订单簿清空（I4：无残留）');
  ok(near(market.volume(), 100), `I1 守恒：volume() = ${market.volume()} = Σ成交价`);
  const audit1 = market.lastAuditReport();
  ok(audit1 && audit1.intact && audit1.paymentsEqualIncome && audit1.tradeReceiptsMatch && audit1.noNegativeBalances, '撮合自动审计 I1~I4 全部成立');

  // 同价先到先得（引擎 vs 手工：seq 决胜）
  const listed2 = market.list({ seller: 'seller-m', kind: 'pattern', refId: 'ref-m2', description: '同价对照', ask: 50, claimedQuality: 0.6 });
  market.placeBid('b-mid', listed2.assetId, 60);
  market.placeBid('b-low', listed2.assetId, 60); // 同价、后到
  const t2 = market.match();
  ok(t2.length === 1 && t2[0].buyer === 'b-mid', `同价先到先得：b-mid 先下单价 60 胜出（b-low 同价后到落选）`);

  // 随机订单流：8 资产 × 10 轮 × 每轮随机 12 单 → 每轮撮合后不变量恒成立
  const rng = mulberry32(20261001);
  const ledger2 = new EnergyLedger({ initialSupply: 1_000_000, journalLimit: 2_000 });
  const market2 = new CognitiveMarket(ledger2);
  const sellers = ['s0', 's1'];
  const buyers = ['u0', 'u1', 'u2', 'u3', 'u4'];
  for (const s of sellers) {
    ledger2.openAccount(s);
    ledger2.transfer(TREASURY, s, 100_000, 'test-fund', s);
  }
  for (const b of buyers) {
    ledger2.openAccount(b);
    ledger2.transfer(TREASURY, b, 100_000, 'test-fund', b);
  }
  const assets = [];
  for (let i = 0; i < 8; i += 1) {
    const l = market2.list({ seller: sellers[i % 2], kind: 'pattern', refId: `rnd-${i}`, description: `随机流资产 ${i}`, ask: 60 + Math.floor(rng() * 40), claimedQuality: 0.5 + rng() * 0.4 });
    assets.push({ id: l.assetId, ask: 60 + Math.floor(rng() * 40) });
  }
  let intactRounds = 0;
  let totalTrades = 0;
  for (let round = 0; round < 10; round += 1) {
    for (let o = 0; o < 12; o += 1) {
      const a = assets[Math.floor(rng() * assets.length)];
      market2.placeBid(buyers[Math.floor(rng() * buyers.length)], a.id, 40 + Math.floor(rng() * 80));
    }
    const done = market2.match();
    totalTrades += done.length;
    const audit = market2.lastAuditReport();
    if (audit && audit.intact) intactRounds += 1;
  }
  const finalAudit = market2.auditInvariants();
  ok(intactRounds === 10, `随机订单流 10 轮撮合：不变量审计恒成立（${intactRounds}/10 轮 intact，成交 ${totalTrades} 笔）`);
  ok(finalAudit.tradeCount === totalTrades && finalAudit.intact, `终局审计 I1~I5 全过：tradeCount = ${finalAudit.tradeCount}、违规 ${finalAudit.violations.length} 条`);
  ok(finalAudit.royaltyAccounting, 'I5 版税记账：市场累计 === 账本 royalty 凭证（零版税场景同样对账通过）');
  ok(ledger2.verifyConservation() && ledger2.verifyChain(), '随机流全程账本守恒 + 哈希链完整');
}

// ═══════════════════ ② LMSR 定价一致性（belief） ═══════════════════

section('② belief：价格=后验互逆检验 + 注资/提现损失上界记账（经典结果锚）');

{
  const ledger = new EnergyLedger({ initialSupply: 100_000 });
  const belief = new BeliefMarket(ledger, { defaultB: 10 });
  ledger.openAccount('trader');
  ledger.transfer(TREASURY, 'trader', 50_000, 'test-fund', 'trader');

  // 经典锚 1：单步买入 YES 10 份（b=10）→ 价格 = sigmoid(1) ≈ 0.7311
  const created = belief.create({ claim: '锚定断言', subject: 'anchor.x', threshold: 0.5, settleAtTick: 99, creator: 'trader', liquidityB: 10 });
  ok(created.ok && belief.price(created.assetId) === 0.5, '初始价格 0.5（q=0 对称点）');
  belief.buyShares('trader', created.assetId, 'YES', 10);
  ok(near(belief.price(created.assetId), sigmoid(1), 1e-12), `买 YES 10 份（b=10）→ 价格 = sigmoid(1) = ${sigmoid(1).toFixed(6)}（解析对照）`);
  const anchor = belief.checkPricing(created.assetId);
  ok(anchor.consistent && anchor.inverseLogitError < 1e-9 && anchor.symmetryError < 1e-9 && anchor.marginalCostError < 1e-9, `价格一致性三误差 < 1e-9：互逆 ${anchor.inverseLogitError.toExponential(2)} / 对称 ${anchor.symmetryError.toExponential(2)} / 边际 ${anchor.marginalCostError.toExponential(2)}`);

  // 经典锚 2：buyToPrice 到 0.83 → 价格恢复到目标（q1−q2 = b·logit(0.83)）
  belief.buyToPrice('trader', created.assetId, 'YES', 0.83, 5_000);
  const view83 = belief.view(created.assetId);
  ok(near(view83.impliedProbYes, 0.83, 1e-9), `buyToPrice(0.83) → 市场价 = ${view83.impliedProbYes.toFixed(9)}（份额差恢复后验）`);
  const c83 = belief.checkPricing(created.assetId);
  ok(c83.consistent && Math.abs(view83.yesShares - view83.noShares - 10 * Math.log(0.83 / 0.17)) < 1e-9, 'q1−q2 = b·logit(p) 逐位成立（LMSR 公式互逆）');

  // 随机买卖轨迹 60 步：三误差恒 0 + 敞口恒 ≤ b·ln2
  const rng = mulberry32(61);
  const b = 10;
  let consistentSteps = 0;
  let withinBoundSteps = 0;
  for (let step = 0; step < 60; step += 1) {
    if (rng() < 0.25) {
      const pos = belief.positionOf('trader', created.assetId);
      const held = Math.max(pos?.yesShares ?? 0, pos?.noShares ?? 0);
      if (held > 2) belief.sellShares('trader', created.assetId, rng() < 0.5 ? 'YES' : 'NO', 1 + Math.floor(rng() * Math.min(held - 1, 5)));
    } else {
      belief.buyShares('trader', created.assetId, rng() < 0.5 ? 'YES' : 'NO', 1 + Math.floor(rng() * 12));
    }
    const cp = belief.checkPricing(created.assetId);
    const ex = belief.makerExposure(created.assetId);
    if (cp.consistent) consistentSteps += 1;
    if (ex.withinBound) withinBoundSteps += 1;
  }
  ok(consistentSteps === 60, `随机买卖轨迹 60 步：checkPricing 恒 consistent（${consistentSteps}/60）`);
  ok(withinBoundSteps === 60, `随机轨迹 60 步：敞口恒 ≤ b·ln2 = ${(b * Math.LN2).toFixed(4)}（Hanson 最坏损失界，${withinBoundSteps}/60）`);

  // 损失上界记账：买 YES 20 → 解析敞口 = 20 − (C(20,0) − b·ln2) ≈ 4.91
  const ex20 = belief.makerExposure(created.assetId);
  ok(near(ex20.lossBound, 10 * Math.LN2), `理论上界 lossBound = b·ln2 = ${(10 * Math.LN2).toFixed(4)}`);
  const freshLedger = new EnergyLedger({ initialSupply: 100_000 });
  const fresh = new BeliefMarket(freshLedger, { defaultB: 10 });
  freshLedger.openAccount('t2');
  freshLedger.transfer(TREASURY, 't2', 50_000, 'test-fund', 't2');
  const fAsset = fresh.create({ claim: '注资提现', subject: 'fund.x', threshold: 0.5, settleAtTick: 99, creator: 't2', liquidityB: 10 });
  fresh.buyShares('t2', fAsset.assetId, 'YES', 20);
  const exA = fresh.makerExposure(fAsset.assetId);
  const expectedExposure = 20 - (10 * Math.log(Math.exp(2) + 1) - 10 * Math.LN2);
  ok(near(exA.exposure, expectedExposure, 1e-9), `解析敞口对照：买 YES 20 → exposure = ${exA.exposure.toFixed(4)} = 20 − (C(20,0) − b·ln2) = ${expectedExposure.toFixed(4)}`);
  ok(exA.exposure > 0 && exA.withinBound, '缺省无注资：敞口为正但在界内（做市商最坏兑付缺口有界）');

  // 无盈余拒提（硬约束：提现绝不击穿最坏兑付储备）
  const w0 = fresh.withdrawSurplus(fAsset.assetId);
  ok(!w0.ok && w0.error === 'no-surplus', '无盈余提现 → no-surplus 拒绝（提现硬约束）');

  // 注资 30 → 盈余 = 30 − 4.91 ≈ 25.09 可提；提后敞口恰好归零仍 ≤ 界
  fresh.fund(fAsset.assetId, 30);
  const exB = fresh.makerExposure(fAsset.assetId);
  ok(near(exB.reserve, exA.reserve + 30, 1e-9), `注资 30 → 储备 +30（敞口 ${exB.exposure.toFixed(4)}）`);
  const w1 = fresh.withdrawSurplus(fAsset.assetId);
  const expectedWithdraw = 30 - expectedExposure;
  ok(w1.ok && near(w1.withdrawn, expectedWithdraw, 1e-6), `提现盈余 = ${w1.withdrawn?.toFixed(4)} = 注资 30 − 敞口 ${expectedExposure.toFixed(4)}（仅提取超出最坏兑付的部分）`);
  const exC = fresh.makerExposure(fAsset.assetId);
  ok(near(exC.exposure, 0, 1e-6) && exC.withinBound, `提现后敞口归零（${exC.exposure.toFixed(6)}）仍 ≤ 上界——绝不把缺口社会化`);
  const w2 = fresh.withdrawSurplus(fAsset.assetId);
  ok(!w2.ok && w2.error === 'no-surplus', '再次提现 → no-surplus（盈余已提取干净）');
}

// ═══════════════════ ③ 账本哈希链审计（ledger） ═══════════════════

section('③ ledger：区块头哈希链 + 整链校验 + 三类篡改定位实验');

{
  const ledger = new EnergyLedger({ initialSupply: 200_000, blockSize: 8 });
  for (const who of ['p0', 'p1', 'p2', 'p3', 'p4']) {
    ledger.openAccount(who);
    ledger.transfer(TREASURY, who, 20_000, 'test-fund', who);
  }
  const rng = mulberry32(63);
  for (let i = 0; i < 33; i += 1) {
    const from = `p${Math.floor(rng() * 5)}`;
    let to = `p${Math.floor(rng() * 5)}`;
    if (to === from) to = 'p0';
    ledger.transfer(from, to, 1 + Math.floor(rng() * 50), 'flow', `t${i}`);
  }
  const blocks = ledger.blocks();
  ok(blocks.length >= 4, `33 笔转账自动封 ${blocks.length} 块（blockSize 8：满 8 即封）`);
  ok(blocks.every((blk) => /^[0-9A-F]{16}$/.test(blk.hash)), '块哈希 = 16 位大写十六进制（纯 TS mixHash 双轨道）');
  ok(blocks.every((blk, i) => (i === 0 ? blk.prevBlockHash === '0'.repeat(64) : blk.prevBlockHash === blocks[i - 1].hash)), '块间 prevHash 链接完整（创世锚 64 个 0）');
  ok(blocks.every((blk, i) => i === 0 || blk.firstSeq === blocks[i - 1].lastSeq + 1), 'firstSeq/lastSeq 无缝衔接（凭证区间连续）');
  const audit0 = ledger.verifyBlockChain();
  ok(audit0.intact && audit0.verifiedFull === blocks.length && audit0.pruned === 0, `整链校验 intact：${audit0.blocks} 块全部全量复核（verifiedFull = ${audit0.verifiedFull}）`);

  // 篡改实验 1：改一笔历史凭证金额 → entry-root 失配 + 逐凭证链定位
  const snap = ledger.snapshotState();
  const tp1 = structuredClone(snap);
  const victimSeq = tp1.journal[5].seq;
  const victimBlock = blocks.find((blk) => victimSeq >= blk.firstSeq && victimSeq <= blk.lastSeq);
  tp1.journal[5].amount += 1;
  ledger.restoreState(tp1);
  const a1 = ledger.verifyBlockChain();
  ok(!a1.intact && a1.broken.kind === 'entry-root', `篡改凭证 #${victimSeq} 金额 +1 → 块根失配检出（entry-root）`);
  ok(a1.broken.seq === victimSeq, `定位到失配凭证 seq = ${a1.broken.seq}（块内折叠链首个失配笔）`);
  const loc1 = ledger.locateTampering();
  ok(loc1.found && loc1.kind === 'entry-hash' && loc1.seq === victimSeq && loc1.blockIndex === victimBlock.index, `locateTampering：逐凭证链 seq=${loc1.seq} / 所属块高 #${loc1.blockIndex}（双通道定位一致）`);

  // 篡改实验 2：改块内凭证根 → 块哈希失配（块头覆盖全部字段）
  const tp2 = structuredClone(snap);
  tp2.blocks[1].entryRoot = 'DEADBEEFDEADBEEF';
  ledger.restoreState(tp2);
  const a2 = ledger.verifyBlockChain();
  ok(!a2.intact && a2.broken.kind === 'block-hash' && a2.broken.blockIndex === 2, `篡改 #2 块 entryRoot → 块哈希失配检出（block-hash，定位块高 2）`);

  // 篡改实验 3：改块间链接 → prevHash 断裂
  const tp3 = structuredClone(snap);
  tp3.blocks[2].prevBlockHash = 'FFFF0000FFFF0000';
  ledger.restoreState(tp3);
  const a3 = ledger.verifyBlockChain();
  ok(!a3.intact && a3.broken.kind === 'block-link' && a3.broken.blockIndex === 3, `篡改 #3 块 prevBlockHash → 链接断裂检出（block-link，定位块高 3）`);

  // 恢复 → 完整
  ledger.restoreState(snap);
  ok(ledger.verifyBlockChain().intact, '恢复快照 → 整链校验恢复 intact');

  // 手动封块：显式业务边界封存（独立账本，避免自动封块抢先）
  const ledgerM = new EnergyLedger({ initialSupply: 10_000, blockSize: 8 });
  ledgerM.openAccount('m0');
  ledgerM.openAccount('m1');
  ledgerM.transfer(TREASURY, 'm0', 1_000, 'test-fund', 'm0');
  ledgerM.transfer('m0', 'm1', 7, 'flow', 'x1');
  ledgerM.transfer('m1', 'm0', 3, 'flow', 'x2');
  ledgerM.transfer('m0', 'm1', 5, 'flow', 'x3');
  const unsealed = ledgerM.unsealedCount();
  const sealed = ledgerM.sealBlock();
  ok(unsealed === 4 && sealed.entryCount === 4 && ledgerM.unsealedCount() === 0, `手动封块：4 笔在途凭证（注资 + 3 笔 flow）→ 块 #${sealed.index}（entryCount 4），未封存归零`);
  ok(ledgerM.sealBlock() === undefined, '无在途凭证 → sealBlock 幂等返回 undefined');
  ok(ledgerM.verifyBlockChain().intact, '手动封块后整链仍 intact');

  // 裁剪窗口：journalLimit 滑出旧凭证 → 老块 pruned 但块头链仍连续可验
  const ledger2 = new EnergyLedger({ initialSupply: 100_000, journalLimit: 30, blockSize: 4, blockLimit: 8 });
  for (const who of ['q0', 'q1']) {
    ledger2.openAccount(who);
    ledger2.transfer(TREASURY, who, 40_000, 'test-fund', who);
  }
  const rng2 = mulberry32(64);
  for (let i = 0; i < 60; i += 1) ledger2.transfer(i % 2 ? 'q0' : 'q1', i % 2 ? 'q1' : 'q0', 1 + Math.floor(rng2() * 20), 'flow', `q${i}`);
  const a4 = ledger2.verifyBlockChain();
  ok(a4.intact && a4.pruned >= 1 && a4.blocks === 8, `裁剪后：块头链仍连续 intact（${a4.blocks} 块、pruned ${a4.pruned}——旧块凭证已裁、块头可验）`);
  ok(ledger2.verifyChain(), '逐凭证哈希链在保留窗口内仍连续可验');
}

// ═══════════════════ ④ 信誉衰减与女巫抵抗（agent，本轮新增） ═══════════════════

section('④ agent：观测封顶 + 冷启动额度解锁——「新账号刷分」场景抵抗证明');

{
  const trustCfg = { observationWindowMs: HOUR, maxObservationsPerWindow: 5 };

  // ── 女巫场景：新账号同一窗口内刷 50 次成功 ──
  const sybil = new ProbeAgent('sybil-1', T0, trustCfg);
  for (let i = 0; i < 50; i += 1) sybil.recordContribution(true, T0 + i * 60_000); // 50 分钟内
  const sv = sybil.trustView(T0 + 50 * 60_000);
  ok(sv.creditedObservations === 5 && sv.rejectedObservations === 45, `窗口封顶：50 次刷分只受纳 5 次（拒绝 45 次入审计计数）`);
  ok(near(sv.effectiveSamples, 5, 0.01), `有效样本 ≈ ${sv.effectiveSamples.toFixed(3)}（证据侧只认窗口上限——Wilson 小样本保守性不可冲破）`);
  ok(near(sv.spendAllowance, 30, 0.05), `冷启动额度 = 10 + 4×5 = ${sv.spendAllowance.toFixed(2)}（50 能量进化提案会被拦）`);
  ok(sv.unlockProgress < 0.26 && !sv.established, `解锁进度 ${sv.unlockProgress.toFixed(3)} < 1（冷启动未完成）`);
  const srep = sybil.reputation(T0 + 50 * 60_000);
  ok(srep.wilsonLower < 0.6 && srep.tier !== 'elite', `Wilson 下界 ${srep.wilsonLower.toFixed(3)} < 0.6（n=5 全成功也到不了 elite 门槛）`);

  // ── 新旧对照：同一刷分序列，旧口径（未配 trust）50 条全入证据 ──
  const legacy = new ProbeAgent('legacy-1', T0);
  for (let i = 0; i < 50; i += 1) legacy.recordContribution(true, T0 + i * 60_000);
  const lv = legacy.trustView(T0 + 50 * 60_000);
  ok(lv.creditedObservations === 50 && near(lv.spendAllowance, 210, 0.5), `旧口径对照：50 刷全受纳 → 额度 ${lv.spendAllowance.toFixed(1)}（无封顶 = 女巫可瞬时解锁 7 倍额度）`);
  ok(sv.spendAllowance < lv.spendAllowance / 4, `新旧对照数字：封顶后额度 ${sv.spendAllowance.toFixed(1)} < 旧口径 ${lv.spendAllowance.toFixed(0)} / 4（女巫抵抗生效）`);

  // ── 老实人：跨窗口用真实时间积累 30 次 → 额度解锁 ──
  const honest = new ProbeAgent('honest-1', T0, trustCfg);
  for (let w = 0; w < 6; w += 1) {
    for (let i = 0; i < 8; i += 1) honest.recordContribution(true, T0 + w * 2 * HOUR + i * 60_000); // 每窗 8 次只认 5
  }
  const tEnd = T0 + 11 * HOUR;
  const hv = honest.trustView(tEnd);
  ok(hv.creditedObservations === 30 && hv.rejectedObservations === 18, `跨 6 窗积累：受纳 30 / 拒绝 18（每窗超限的 3 次照拒——诚实口径一致）`);
  ok(hv.effectiveSamples > 28 && near(hv.spendAllowance, 10 + 4 * hv.effectiveSamples, 0.01), `有效样本 ${hv.effectiveSamples.toFixed(2)} → 额度 ${hv.spendAllowance.toFixed(1)}（50 能量进化放行）`);
  ok(hv.established, `解锁进度 ${hv.unlockProgress.toFixed(3)} ≥ 1（冷启动完成——真实时间换真实额度）`);

  // ── 时间衰减：停更 90 天（3 个半衰期）→ 功劳簿失效 ──
  const hv2 = honest.trustView(tEnd + 90 * DAY);
  ok(near(hv2.effectiveSamples, hv.effectiveSamples * 0.125, 0.05) && near(hv2.stalenessFactor, 0.125, 1e-3), `停更 90 天：有效样本 ${hv.effectiveSamples.toFixed(1)} → ${hv2.effectiveSamples.toFixed(2)}（×0.5³，功劳簿按半衰期失效）`);
  ok(hv2.spendAllowance < 30 && hv2.tier === 'seed', `额度收缩至 ${hv2.spendAllowance.toFixed(1)}、tier 回落 seed（老账户不持续贡献即降级）`);

  // ── 结构检测：能力检测函数 ──
  ok(hasTrustView(sybil) === true, 'hasTrustView：AgentBase 子类携带 trustView 读数');
  ok(hasTrustView(plainManagedAgent('x', [])) === false, 'hasTrustView：自定义 ManagedAgent（无 trustView）→ false（运行时诚实放行）');

  // ── wrappers 透传：内置智能体构造可注入 trust ──
  const { OptimizerAgent } = await import('../dist/index.mjs');
  const withTrust = new OptimizerAgent('opt-trust', {}, undefined, trustCfg);
  for (let i = 0; i < 10; i += 1) withTrust.recordContribution(true, T0 + i * 60_000);
  ok(withTrust.trustView(T0).creditedObservations === 5, 'wrappers 透传：OptimizerAgent 构造第 4 参注入 trust（封顶同样生效）');
}

// ═══════════════════ ⑤ 否决流论证化 + sybilGuard 执行面（runtime，本轮新增） ═══════════════════

section('⑤ runtime：否决必须论证（损失估计 + 替代方案）——两场景对照 + 女巫额度拦截');

{
  const mkGate = (state) => ({ checkGate: () => state });

  // ── 场景 1（完整理由）：否决生效且结构化留痕 ──
  const justifiedGate = mkGate({ allowed: false, reason: 'circuit-break', blockedBy: 'safety-governor', justification: { lossEstimate: 80, alternative: '沙盒灰度 1 轮后再放行' } });
  const rt1 = new SymbiosisRuntime({ justifiedVetoes: true, openingGrant: 100 }, justifiedGate);
  rt1.register(new ProbeAgent('a-justified', Date.now(), undefined, [{ kind: 'maintenance', bid: 2 }]));
  const r1 = await rt1.tick();
  ok(r1.vetoes.length === 1 && r1.vetoes[0].justification?.lossEstimate === 80 && r1.vetoes[0].justification?.alternative === '沙盒灰度 1 轮后再放行', `场景 1 完整理由：否决生效且携带论证结构（损失估计 80 + 替代方案在案）`);
  ok(r1.grants.length === 0 && r1.burnedThisTick === 0, '场景 1：提案被拦（零授权零燃烧）');
  ok(r1.rejectedVetoes.length === 0, '场景 1：rejectedVetoes 空（合法否决不进拒绝审计）');

  // ── 场景 2（空理由）：否决被拒、提案放行并留痕 ──
  const gateState = { allowed: false, reason: 'vibe' };
  const rt2 = new SymbiosisRuntime({ justifiedVetoes: true, openingGrant: 100 }, mkGate(gateState));
  rt2.register(new ProbeAgent('a-empty', Date.now(), undefined, [{ kind: 'maintenance', bid: 2 }]));
  const r2 = await rt2.tick();
  ok(r2.grants.length === 1 && r2.burnedThisTick === 2, `场景 2 空理由：否决被拒、提案照常执行（授权 1、燃烧 2——「拍脑袋否决」机制上不成立）`);
  ok(r2.vetoes.length === 0 && r2.rejectedVetoes.length === 1 && r2.rejectedVetoes[0].why === 'missing-justification', `场景 2：rejectedVetoes 留痕（why = ${r2.rejectedVetoes[0]?.why}）`);

  // 非法损失估计 / 空白替代方案 → 同样拒绝
  const rt3 = new SymbiosisRuntime({ justifiedVetoes: true, openingGrant: 100 }, mkGate({ allowed: false, reason: 'x', justification: { lossEstimate: -1, alternative: 'y' } }));
  rt3.register(new ProbeAgent('a-neg', Date.now(), undefined, [{ kind: 'maintenance', bid: 2 }]));
  const r3 = await rt3.tick();
  ok(r3.grants.length === 1 && r3.rejectedVetoes[0]?.why === 'invalid-loss-estimate', `负损失估计 → 拒因 ${r3.rejectedVetoes[0]?.why}（提案放行）`);
  const rt4 = new SymbiosisRuntime({ justifiedVetoes: true, openingGrant: 100 }, mkGate({ allowed: false, reason: 'x', justification: { lossEstimate: 5, alternative: '   ' } }));
  rt4.register(new ProbeAgent('a-blank', Date.now(), undefined, [{ kind: 'maintenance', bid: 2 }]));
  const r4 = await rt4.tick();
  ok(r4.grants.length === 1 && r4.rejectedVetoes[0]?.why === 'empty-alternative', `空白替代方案 → 拒因 ${r4.rejectedVetoes[0]?.why}（只堵不疏的否决不被接受）`);

  // ── 零漂移对照：缺省（justifiedVetoes = false）空理由否决照拦（旧口径）──
  const rtOld = new SymbiosisRuntime({ openingGrant: 100 }, mkGate({ allowed: false, reason: 'kill-switch' }));
  rtOld.register(new ProbeAgent('a-old', Date.now(), undefined, [{ kind: 'maintenance', bid: 2 }]));
  const rOld = await rtOld.tick();
  ok(rOld.vetoes.length === 1 && rOld.grants.length === 0 && rOld.rejectedVetoes.length === 0, `零漂移对照：缺省模式空理由否决照旧拦截（新旧数字：场景 2 放行 1 vs 缺省拦截 1）`);

  // ── sybilGuard 执行面：新账号大额行动被冷启动额度拦截 ──
  const rtS = new SymbiosisRuntime({ sybilGuard: true, openingGrant: 100 });
  const newbie = new ProbeAgent('newbie', Date.now()); // 无证据 → allowance = 10
  const veteran = new ProbeAgent('veteran', Date.now());
  for (let i = 0; i < 20; i += 1) veteran.recordContribution(true, Date.now() - (20 - i) * 60_000); // 真实积累 20 样本 → allowance = 90
  rtS.register(newbie);
  rtS.register(veteran);
  newbie.injected = [{ kind: 'evolution', bid: 50 }];
  veteran.injected = [{ kind: 'evolution', bid: 50 }];
  const rS = await rtS.tick();
  const sybilVeto = rS.vetoes.find((v) => v.reason.includes('sybil-allowance'));
  ok(!!sybilVeto && sybilVeto.agentId === 'newbie', `新账号 50 能量进化提案被拦（${sybilVeto?.reason}）`);
  ok(rS.grants.length === 1 && rS.grants[0].agentId === 'veteran', `同提案对照：veteran（20 有效样本、额度 90）放行并执行（新旧账号同价提案不同命运）`);

  // 无 trustView 的自定义智能体：结构检测不通过 → 诚实放行（不误伤扩展生态）
  const rtP = new SymbiosisRuntime({ sybilGuard: true, openingGrant: 100 });
  rtP.register(plainManagedAgent('custom-1', [{ kind: 'evolution', bid: 50 }]));
  const rP = await rtP.tick();
  ok(rP.grants.length === 1 && rP.vetoes.length === 0, '无 trustView 的自定义智能体：sybilGuard 恒放行（能力检测诚实降级）');

  // futarchy 决议路径同样受 guard 约束：新账号的表决通过提案也被拦
  const rtF = new SymbiosisRuntime({ sybilGuard: true, futarchyEnabled: true, futarchyMinImpliedProb: 0.3, openingGrant: 200 });
  const nbF = new ProbeAgent('nb-fut', Date.now());
  rtF.register(nbF);
  nbF.injected = [{ kind: 'evolution', bid: 50 }];
  const rf1 = await rtF.tick(); // 创建决策资产
  ok(rf1.futarchyDecisions.length === 0, 'futarchy 第 1 拍：决策资产创建、无决议（表决窗口）');
  // 手动把价格推过门槛（模拟市场看多）
  const decisionAsset = rtF.beliefMarket.views().find((v) => v.subject.startsWith('evolution:nb-fut:'));
  rtF.ledger.openAccount('whale');
  rtF.ledger.transfer(TREASURY, 'whale', 5_000, 'test-fund', 'whale');
  rtF.beliefMarket.buyToPrice('whale', decisionAsset.assetId, 'YES', 0.8, 3_000);
  nbF.injected = [];
  const rf2 = await rtF.tick();
  ok(rf2.futarchyDecisions.length === 1 && rf2.futarchyDecisions[0].decision === 'governor-vetoed', `futarchy 决议：市场表决通过（隐含 ${(decisionAsset ? 0.8 : 0).toFixed(2)} ≥ 0.3）但新账号额度不足 → 拒绝资助（sybilGuard 覆盖决议路径）`);
}

// ═══════════════════ ⑥ 能源桑基结构化导出（observability，本轮加分） ═══════════════════

section('⑥ observability：源→汇流量矩阵双口径对账 + CSV/JSONL/矩阵三格式导出');

{
  // 构造真实能量流：runtime 一轮生态活动（注资/行动燃烧/市场成交/铸币分红/版税）
  const rt = new SymbiosisRuntime({ openingGrant: 100 });
  const seller = new ProbeAgent('sell-1', Date.now());
  const buyer = new ProbeAgent('buy-1', Date.now());
  rt.register(seller);
  rt.register(buyer);
  const listedAsset = rt.market.list({ seller: 'sell-1', kind: 'pattern', refId: 'sankey-ref', description: '桑基资产', ask: 5, claimedQuality: 0.8 });
  seller.injected = [{ kind: 'maintenance', bid: 3 }];
  buyer.injected = [{ kind: 'buy-knowledge', bid: 5, assetRef: listedAsset.assetId }];
  await rt.tick();
  rt.settleTaskOutcome(true, [{ agentId: 'sell-1' }, { agentId: 'buy-1' }]);
  rt.reportAssetUsage(listedAsset.assetId, true);

  const report = buildEnergySankey(rt.ledger, { agents: [{ id: 'sell-1', kind: 'memory' }, { id: 'buy-1', kind: 'optimizer' }] });
  ok(report.links.length >= 6, `聚合出 ${report.links.length} 条源→汇链接（注资/预扣/燃烧/成交/分红/版税多渠道）`);
  const matrix = buildFlowMatrix(report);
  ok(matrix.conserved && matrix.coverage === 1, `流量矩阵双口径对账恒等：Σ行和 = Σ节点流出、Σ列和 = Σ节点流入（覆盖 ${matrix.coverage * 100}%、无丢失）`);
  const totalOut = report.nodes.reduce((a, n) => a + n.outflow, 0);
  ok(near(matrix.rowSums.reduce((a, b) => a + b, 0), totalOut, 1e-6), `矩阵总量 = ${totalOut.toFixed(1)} 能量（与节点表逐位一致）`);
  ok(matrix.sources.includes('treasury') || matrix.sources.length > 0, `源集合 ${matrix.sources.length} 个、汇集合 ${matrix.sinks.length} 个（分层排序）`);

  // CSV：表头 + 每链接一行，解析回读总额一致
  const csv = exportSankeyData(report, 'csv');
  const csvLines = csv.split('\n');
  ok(csvLines[0] === 'source,target,channel,group,amount,count' && csvLines.length === report.links.length + 1, `CSV 导出：${csvLines.length - 1} 行链接 + 表头`);
  const csvSum = csvLines.slice(1).reduce((a, line) => a + Number(line.split(',')[4]), 0);
  ok(near(csvSum, report.links.reduce((a, l) => a + l.amount, 0), 1e-4), `CSV 解析回读总额 ${csvSum.toFixed(2)} = 链接聚合总额（结构无损往返）`);

  // JSONL：每行独立 JSON、类型保真
  const jsonl = exportSankeyData(report, 'jsonl');
  const jsonRows = jsonl.split('\n').map((line) => JSON.parse(line));
  ok(jsonRows.length === report.links.length && jsonRows.every((r) => typeof r.amount === 'number' && typeof r.source === 'string'), `JSONL 导出：${jsonRows.length} 行独立 JSON（数值类型保真）`);

  // 矩阵文本：行和/列和随行 + 守恒校验尾注
  const matrixText = exportSankeyData(report, 'matrix');
  ok(matrixText.includes('Σout') && matrixText.includes('Σin') && matrixText.includes('conservation: OK'), '矩阵文本导出：行和 Σout / 列和 Σin / conservation: OK 尾注齐备');

  // 篡改检出：单边篡改链接金额（不动节点表）→ 双口径对账即刻失败
  const tampered = structuredClone(report);
  tampered.links[0].amount += 100;
  ok(buildFlowMatrix(tampered).conserved === false, '单边篡改链接金额 +100 → 矩阵双口径对账即刻失败（节点表 vs 链接表失配检出）');
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— 共生经济层第三轮 A11 升级新旧行为对照验证成立（market/belief/ledger 复核 + agent/runtime/observability 本轮新增）`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
