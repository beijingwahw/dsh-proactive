/**
 * verify-r4-symbiosis.mjs — 第四轮模块域 A11 升级：共生经济层 8 文件「激活与深化」验证
 *
 * 五项全新维度各配「旧 vs 新」数字对照与构造证明：
 *   ① 流动性度量（market）：最优买卖价差（绝对 + bps）/ 买侧深度 /
 *      给定规模吃单滑点估计——薄簿 vs 厚簿两构造证明指标分化；
 *      滑点随规模单调非降（价格降序 VWAP 的数学性质）。
 *   ② 通胀治理（ledger/runtime）：流通量目标带货币政策——超发流证明
 *      铸币税率自动上调（分红 40→20）+ 央行收缩销毁驱动流通量回归带内
 *      （10000→带内，tax 回落 0.5→0）；通缩流证明反向加成（40→60）；
 *      未配置 = 旧行为逐位复现（零漂移）。
 *   ③ 贡献者画像（agent）：生产率/质量/影响半径三维滚动窗口 + 趋势 +
 *      突变检测——双贡献者流证明画像分化（质量 0.75 vs 0.25），注入
 *      突然变差检出（quality 骤降 Δ≥0.5），稳定者零误报。
 *   ④ 条件结算合约（bridge/market）：交付托管制三路结算（全质/半质/
 *      违约）证明按约分配逐位成立；违约以 'contract-breach' 凭证入账；
 *      托管守恒审计（入 = 出 + 在途）从账本独立重算对账。
 *   ⑤ 市场操纵检测（market，加分）：对敲（卖家自买自有资产）与短周期
 *      循环成交（同组合窗口内反复成交）启发式检出；正常分散交易零误报。
 *   ⑥ 激活与深化：内置智能体画像透传（wrappers）、合约/货币渠道进入
 *      Sankey 全景（observability）、条件结算宿主 API 影子口径（bridge）。
 *
 * 确定性：全部注入时钟（T0 虚拟时钟）；无真网络、无真 LLM 调用。
 *
 * 运行：npm run build && node scripts/verify-r4-symbiosis.mjs
 */

import {
  EnergyLedger,
  CognitiveMarket,
  MonetaryGovernor,
  SymbiosisRuntime,
  SymbiosisBridge,
  AgentBase,
  OptimizerAgent,
  EvolverAgent,
  buildEnergySankey,
  renderSankeyHtml,
  TREASURY,
  ESCROW,
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

const T0 = 1_700_000_000_000; // 注入虚拟时钟起点
const MIN = 60_000;

/** 探针智能体：构造 runtime 生态用（settleTaskOutcome 贡献者） */
class ProbeAgent extends AgentBase {
  constructor(id, createdAt = T0) {
    super(id, createdAt);
    this.kind = 'optimizer';
  }
  goal() {
    return { objective: 'probe', metrics: [], survivalThreshold: 1 };
  }
  async execute() {
    return { success: true, valueEstimate: 0.5, summary: 'probe' };
  }
}

/** 画像探针：透传 profile 配置（③⑥ 共用） */
class ProfileAgent extends AgentBase {
  constructor(id, profile, createdAt = T0) {
    super(id, createdAt, {}, profile);
    this.kind = 'reflector';
  }
  goal() {
    return { objective: 'profile-probe', metrics: [], survivalThreshold: 1 };
  }
}

// ═══════════════════ ① market：流动性度量 ═══════════════════

section('① 流动性度量：薄/厚两簿指标分化 + 滑点单调');

{
  const ledger = new EnergyLedger({ initialSupply: 100_000 });
  const market = new CognitiveMarket(ledger, { listingFeeRate: 0 }); // 免挂单费，聚焦簿结构
  const seller = 'seller-1';
  ledger.openAccount(seller);
  ledger.transfer(TREASURY, seller, 5000, 'fund', 'setup');
  const thin = market.list({ seller, kind: 'pattern', refId: 'thin', description: '薄簿资产', ask: 120, claimedQuality: 0.8 });
  const thick = market.list({ seller, kind: 'pattern', refId: 'thick', description: '厚簿资产', ask: 120, claimedQuality: 0.8 });

  // 薄簿：3 档陡峭阶梯；厚簿：8 档密集阶梯（同一 ask 对照）
  const thinBids = [100, 60, 30];
  const thickBids = [118, 116, 114, 112, 110, 108, 106, 104];
  for (let i = 0; i < thickBids.length; i += 1) {
    const acct = `buyer-${i}`;
    ledger.openAccount(acct);
    ledger.transfer(TREASURY, acct, 5000, 'fund', 'setup');
    if (i < thinBids.length) market.placeBid(acct, thin.assetId, thinBids[i], T0 + i);
    market.placeBid(acct, thick.assetId, thickBids[i], T0 + 100 + i);
  }

  const thinL = market.liquidity(thin.assetId);
  const thickL = market.liquidity(thick.assetId);
  ok(thinL && thickL, '两簿流动性读数可观测（liquidity() 只读快照）');
  ok(near(thinL.spread, 120 - 100) && near(thickL.spread, 120 - 118), `价差分化：薄簿 spread ${thinL.spread} vs 厚簿 ${thickL.spread}（同 ask=120）`);
  ok(thinL.spreadBps > thickL.spreadBps * 5, `bps 口径分化更显著：薄 ${thinL.spreadBps.toFixed(0)}bps vs 厚 ${thickL.spreadBps.toFixed(0)}bps`);
  ok(thinL.bidDepth < thickL.bidDepth && thinL.bidCount === 3 && thickL.bidCount === 8, `深度分化：薄 ${thinL.bidDepth}（${thinL.bidCount} 档）vs 厚 ${thickL.bidDepth}（${thickL.bidCount} 档）`);

  // 滑点单调：k=1..n 单调非降（价格降序 VWAP 的数学性质）
  let thinMono = true;
  let thickMono = true;
  for (let k = 1; k <= thinBids.length; k += 1) {
    const s = market.slippage(thin.assetId, k);
    if (s === undefined || (k > 1 && s + 1e-12 < market.slippage(thin.assetId, k - 1))) thinMono = false;
  }
  for (let k = 1; k <= thickBids.length; k += 1) {
    const s = market.slippage(thick.assetId, k);
    if (s === undefined || (k > 1 && s + 1e-12 < market.slippage(thick.assetId, k - 1))) thickMono = false;
  }
  ok(thinMono && thickMono, '吃单滑点随规模单调非降（薄/厚两簿全部 k 档）');
  const sThin2 = market.slippage(thin.assetId, 2);
  const sThick2 = market.slippage(thick.assetId, 2);
  ok(sThin2 > sThick2, `同规模滑点分化：吃 2 档 薄 ${(sThin2 * 100).toFixed(1)}% vs 厚 ${(sThick2 * 100).toFixed(1)}%`);
  ok(near(market.slippage(thin.assetId, 1), 0), '吃 1 档滑点 = 0（最优价成交，无折让）');
  ok(market.slippage(thin.assetId, 4) === undefined && market.slippage(thick.assetId, 9) === undefined, '超过在簿深度 → undefined（流动性不足诚实上报，不外推）');
  ok(market.liquidity('asset-999') === undefined && market.slippage('asset-999', 1) === undefined, '未知资产 → undefined');
}

// ═══════════════════ ② ledger/runtime：通胀治理 ═══════════════════

section('② 通胀治理：流通量目标带（铸币税 × 收缩销毁 × 趋势）');

{
  // ── 纯数学面：MonetaryGovernor 三区评估 ──
  const gov = new MonetaryGovernor({ targetCirculating: 8000, bandTolerance: 0.05 });
  const band = gov.band();
  ok(near(band.low, 7600) && near(band.high, 8400), `目标带 [${band.low}, ${band.high}]（8000 ± 5%）`);
  const above = gov.assess(10_000);
  ok(above.zone === 'above' && near(above.mintTaxRate, 0.5) && near(above.dividendScale, 0.5), `超发评估：tax=${above.mintTaxRate}（20% 带外偏离 → 封顶 0.5）、分红缩放 ${above.dividendScale}`);
  ok(above.contraction === 1000, `收缩建议 = ${above.contraction}（2000 中枢偏离 × 敏感度 0.5——锚定中枢而非带沿，保证净回落进带）`);
  const within = gov.assess(8000);
  ok(within.zone === 'within' && within.mintTaxRate === 0 && within.contraction === 0, '带内评估：基础税率 0、不收缩');
  const below = gov.assess(6000);
  ok(below.zone === 'below' && below.mintTaxRate === 0 && near(below.dividendScale, 1.5), `通缩评估：税率归零、分红加成 ${below.dividendScale}（封顶 1.5）`);

  // 趋势可观测：采样史前/后半对比
  for (const c of [10_000, 9700, 9400, 9100, 8800, 8600]) gov.record(c, T0);
  const trend = gov.trend();
  ok(trend.samples === 6 && trend.slope === 'contracting', `流通量趋势：${trend.samples} 采样、前半 ${trend.firstHalfMean.toFixed(0)} → 后半 ${trend.secondHalfMean.toFixed(0)}（contracting）`);

  // ── 执行面：超发流（税率自动上调 → 收缩销毁 → 流通量回归带内）──
  const rt = new SymbiosisRuntime({
    initialSupply: 10_000,
    openingGrant: 0,
    monetaryPolicy: { targetCirculating: 8000, bandTolerance: 0.05 },
  });
  const worker = new ProbeAgent('worker-1');
  rt.register(worker);
  ok(rt.ledger.circulatingSupply() === 10_000, `初始流通量 10000（带 [7600, 8400] 之上 = 超发态）`);

  const reports = [];
  let iterations = 0;
  let circulating = rt.ledger.circulatingSupply();
  while (circulating > 8400 && iterations < 60) {
    const report = rt.settleTaskOutcome(true, [{ agentId: 'worker-1' }]);
    reports.push(report);
    circulating = rt.ledger.circulatingSupply();
    iterations += 1;
  }
  ok(iterations < 60 && circulating <= 8400, `超发流收敛：${iterations} 次结算后流通量 ${circulating.toFixed(1)} 回归带内（10000 → ≤8400）`);
  ok(reports[0].monetary.zone === 'above' && near(reports[0].monetary.mintTaxRate, 0.5), `首结算即触发：zone=above、tax=${reports[0].monetary.mintTaxRate}（带外偏离自动上调）`);
  ok(reports[0].totalDistributed === 20 && reports[0].monetary.taxWithheld === 20, `新旧对照·分红：旧 40 全额铸币 → 新 ${reports[0].totalDistributed}（税率 0.5 扣留 ${reports[0].monetary.taxWithheld}）`);
  const contractionEntries = rt.ledger.audit(rt.ledger.stats().transfers).filter((t) => t.reason === 'monetary-contraction');
  const contracted = contractionEntries.reduce((a, t) => a + t.amount, 0);
  ok(contractionEntries.length === iterations && contracted > 0 && rt.ledger.burned() >= contracted, `收缩销毁入账：${contractionEntries.length} 笔 'monetary-contraction'、Σ${contracted} 能量 treasury→burn（央行去杠杆的实际回归力量）`);
  // 回归带内后的下一次结算：政策自愈（税率回落、停止收缩、带内持稳）
  const cured = rt.settleTaskOutcome(true, [{ agentId: 'worker-1' }]);
  const curedCirculating = rt.ledger.circulatingSupply();
  ok(cured.monetary.zone === 'within' && cured.monetary.mintTaxRate === 0 && cured.monetary.contraction === 0, `政策自愈：带内结算 zone=within、tax 回落 ${cured.monetary.mintTaxRate}、零收缩`);
  ok(curedCirculating <= 8400, `带内一次结算后流通量 ${curedCirculating.toFixed(1)} 持稳带内（全额分红不再触收缩）`);
  const rtTrend = rt.monetaryTrend();
  ok(rtTrend.insideBand === true && rtTrend.slope === 'contracting', `运行时趋势可观测：monetaryTrend() insideBand=true、slope=contracting（${rtTrend.samples} 采样）`);

  // ── 反向流：通缩加成 ──
  const rtDeflation = new SymbiosisRuntime({
    initialSupply: 6000,
    openingGrant: 0,
    monetaryPolicy: { targetCirculating: 8000, bandTolerance: 0.05 },
  });
  const worker2 = new ProbeAgent('worker-2');
  rtDeflation.register(worker2);
  const boost = rtDeflation.settleTaskOutcome(true, [{ agentId: 'worker-2' }]);
  ok(boost.monetary.zone === 'below' && boost.totalDistributed === 60, `通缩反向：zone=below、分红 ${boost.totalDistributed}（旧 40 → 加成 ×1.5）`);
  ok(boost.monetary.mintTaxRate === 0 && boost.monetary.taxWithheld === 0, '通缩态零铸币税（只放水不抽税）');

  // ── 零漂移：未配置 = 旧行为逐位复现 ──
  const rtOld = new SymbiosisRuntime({ initialSupply: 10_000, openingGrant: 0 });
  const worker3 = new ProbeAgent('worker-3');
  rtOld.register(worker3);
  const oldReport = rtOld.settleTaskOutcome(true, [{ agentId: 'worker-3' }]);
  ok(oldReport.totalDistributed === 40 && oldReport.monetary === undefined, `旧口径复现：无政策时分红 ${oldReport.totalDistributed} 全额、报告无 monetary 字段`);
  const oldJournal = rtOld.ledger.audit(rtOld.ledger.stats().transfers);
  ok(oldJournal.every((t) => t.reason !== 'monetary-contraction'), '无政策时零收缩凭证（缺省零漂移）');
}

// ═══════════════════ ③ agent：贡献者三维画像 + 突变检测 ═══════════════════

section('③ 贡献者画像：三维分化 + 趋势 + 突变检测');

{
  const BUCKET = 1000; // 1s 一桶（注入时钟驱动）
  const profileCfg = { bucketMs: BUCKET, buckets: 8, shiftQualityDrop: 0.25, shiftMinSamples: 4 };
  const good = new ProfileAgent('contrib-good', profileCfg);
  const bad = new ProfileAgent('contrib-bad', profileCfg);
  const plain = new ProfileAgent('contrib-plain'); // 未配置画像（零漂移对照）

  // 7 个桶的稳态流：good 75% 成功率、触达 12 个对象；bad 25% 成功率、2 个对象
  for (let b = 0; b < 7; b += 1) {
    for (let i = 0; i < 4; i += 1) {
      const t = T0 + b * BUCKET + i * 100;
      good.recordContribution(i < 3, t, { refId: `task-g${b}-${i}` });
      bad.recordContribution(i < 1, t, { refId: `task-b${i}` });
      plain.recordContribution(i < 3, t);
    }
  }
  const pg = good.profile(T0 + 8 * BUCKET);
  const pb = bad.profile(T0 + 8 * BUCKET);
  ok(pg && pb && plain.profile(T0 + 8 * BUCKET) === undefined, '画像可观测：配置者有读数、未配置者 undefined（opt-in 零漂移）');
  ok(near(pg.quality, 0.75) && near(pb.quality, 0.25), `质量维分化：good ${pg.quality.toFixed(2)} vs bad ${pb.quality.toFixed(2)}（同 24 样本滚动窗口）`);
  ok(near(pg.productivity, pb.productivity) && near(pg.productivity, 24 / 8), `生产率维一致（对照控制变量）：${pg.productivity.toFixed(2)}/桶（滚动窗口滑动使首桶滑出——窗口口径自洽）`);
  ok(pg.impactRadius === 24 && pb.impactRadius === 4, `影响半径维分化：good 触达 ${pg.impactRadius} 对象 vs bad ${pb.impactRadius}（distinct refId 口径）`);
  ok(pg.composite > pb.composite * 2, `综合分分化：good ${pg.composite.toFixed(3)} vs bad ${pb.composite.toFixed(3)}（质量 × ln(1+生产率)）`);
  ok(pg.shift.detected === false && pb.shift.detected === false, '稳态流零突变误报（两贡献者均未检出）');

  // 信誉零漂移：同观测下配置画像与否，reputation 逐位一致
  const rep = good.reputation(T0 + 8 * BUCKET);
  const repPlain = plain.reputation(T0 + 8 * BUCKET);
  ok(near(rep.wilsonLower, repPlain.wilsonLower) && rep.effectiveSamples === repPlain.effectiveSamples, `画像喂料不影响信誉内核：wilsonLower ${rep.wilsonLower.toFixed(4)} 与未配置者逐位一致`);

  // ── 突变注入：good 在最新桶突然全败 ──
  for (let i = 0; i < 4; i += 1) {
    good.recordContribution(false, T0 + 7 * BUCKET + i * 100, { refId: `task-g7-${i}` });
  }
  const pgShift = good.profile(T0 + 8 * BUCKET);
  ok(pgShift.shift.detected === true && pgShift.shift.metric === 'quality' && pgShift.shift.magnitude >= 0.5, `突变检出：质量骤降 ${pgShift.shift.magnitude.toFixed(2)}（基线 0.75 → 最新桶 0.00，Δ ≥ 0.25 阈值）`);
  ok(pgShift.quality < pg.quality && pgShift.composite < pg.composite, `画像随流恶化：quality ${pg.quality.toFixed(2)} → ${pgShift.quality.toFixed(2)}、composite ${pg.composite.toFixed(3)} → ${pgShift.composite.toFixed(3)}`);
  ok(pgShift.trend.direction === 'falling', `趋势读数 falling（前半 ${pgShift.trend.firstHalf.toFixed(1)} → 后半 ${pgShift.trend.secondHalf.toFixed(1)}）`);
  const pbStable = bad.profile(T0 + 8 * BUCKET);
  ok(pbStable.shift.detected === false, '稳定差生无突变误报（一直平庸 ≠ 突然变差）');

  // 生产率坍缩检出：good 停更一个桶（画像窗口滑动后产出断崖）
  const pgCollapse = good.profile(T0 + 12 * BUCKET); // 窗口滑到 5..12 桶，good 在 8..12 无观测
  ok(pgCollapse.productivity < pg.productivity, `停更滑窗：生产率 ${pg.productivity.toFixed(2)} → ${pgCollapse.productivity.toFixed(2)}（画像随窗口滑动自然衰减）`);
}

// ═══════════════════ ④ bridge/market：条件结算合约 ═══════════════════

section('④ 条件结算合约：全质/半质/违约三路 + 托管守恒');

{
  const ledger = new EnergyLedger({ initialSupply: 100_000 });
  const market = new CognitiveMarket(ledger, { listingFeeRate: 0 });
  const seller = 'seller-x';
  const buyer = 'buyer-x';
  for (const id of [seller, buyer]) {
    ledger.openAccount(id);
    ledger.transfer(TREASURY, id, 5000, 'fund', 'setup');
  }
  const mk = (ref) => market.list({ seller, kind: 'pattern', refId: ref, description: `合约资产 ${ref}`, ask: 100, claimedQuality: 0.8 });
  const a1 = mk('c-full');
  const a2 = mk('c-partial');
  const a3 = mk('c-breach');
  const a4 = mk('c-open');

  // 自买防线：卖家开自己资产的合约 → 拒绝
  const selfDeal = market.openDeliveryContract(seller, a1.assetId, {}, T0);
  ok(selfDeal.ok === false && selfDeal.error === 'self-dealing', '对敲防线：卖家对自己资产开合约被拒（self-dealing）');

  // 三路合约（货款 100 + 保证金 10 双托管）；基线余额在开约前捕获
  const sellerBefore = ledger.balance(seller);
  const buyerBefore = ledger.balance(buyer);
  const c1 = market.openDeliveryContract(buyer, a1.assetId, {}, T0);
  const c2 = market.openDeliveryContract(buyer, a2.assetId, {}, T0);
  const c3 = market.openDeliveryContract(buyer, a3.assetId, {}, T0);
  ok(c1.ok && c2.ok && c3.ok, '三合约开立：货款 100 + 保证金 10 双托管（先付钱/先交付的信任死结由托管解开）');
  const escrowAfterOpen = ledger.balance(ESCROW);
  ok(escrowAfterOpen === 330, `开立后托管池 ${escrowAfterOpen} = 3 × (100 货款 + 10 保证金)`);

  const rFull = market.settleDelivery(c1.contractId, 0.95, T0 + 10);
  ok(rFull.mode === 'full' && rFull.toSeller === 100 && rFull.refundBuyer === 0 && rFull.depositReturned === 10, `全质结算（q=0.95 ≥ 0.9）：卖方得货款 100 + 保证金退 10`);
  const rPart = market.settleDelivery(c2.contractId, 0.5, T0 + 20);
  ok(rPart.mode === 'partial' && rPart.toSeller === 50 && rPart.refundBuyer === 50 && rPart.depositReturned === 10, `半质结算（q=0.5）：按质量比例 卖方 50 / 买方退 50`);
  const rBreach = market.settleDelivery(c3.contractId, undefined, T0 + 30);
  ok(rBreach.mode === 'breach' && rBreach.refundBuyer === 100 && rBreach.penaltyToBuyer === 10, `违约结算（未交付）：货款全退 100 + 保证金罚没 10 给买方`);

  // 按约分配的守恒验证：买方净支出 = 卖方净收入（全责 100 + 半责 50 − 违约赔付 10）
  const buyerNet = buyerBefore - ledger.balance(buyer);
  const sellerNet = ledger.balance(seller) - sellerBefore;
  ok(buyerNet === 140 && sellerNet === 140, `净额按约分配：买方净付 ${buyerNet}（100 全质 + 50 半质 − 10 违约赔付）= 卖方净收 ${sellerNet}（违约者倒赔保证金，零能量泄漏）`);

  // 违约入账：'contract-breach' 凭证与台账一一对应
  const breachEntries = ledger.audit(ledger.stats().transfers).filter((t) => t.reason === 'contract-breach');
  const breaches = market.contractBreaches();
  ok(breachEntries.length === 1 && breachEntries[0].amount === 10 && breaches.length === 1 && breaches[0].id === c3.contractId, `违约留痕：账本 1 笔 'contract-breach'（10 能量 escrow→buyer）= 台账 1 条违约合约（一一对应）`);

  // 托管守恒：含 1 笔在途合约（c4）
  const c4 = market.openDeliveryContract(buyer, a4.assetId, {}, T0 + 40);
  const audit = market.auditContracts();
  ok(c4.ok && audit.contracts === 4 && audit.open === 1 && audit.breached === 1, `台账：4 合约（1 在途 / 2 已结 / 1 违约）`);
  ok(audit.escrowedIn === 440 && audit.releasedOut === 330 && audit.openEscrowed === 110, `托管守恒数字：入 440 − 出 330 = 在途 110（账本独立重算）`);
  ok(audit.conserved && audit.breachesRecorded && audit.violations.length === 0, '托管守恒审计 conserved=true + 违约凭证一一对应（零违规）');
  const invariants = market.auditInvariants();
  ok(invariants.intact, `合约通道不污染 I1~I5 主链路不变量（intact=true）`);

  // 二次结算拒绝（幂等防线）
  ok(market.settleDelivery(c1.contractId, 1.0, T0 + 50) === undefined, '已结算合约不可重复结算（状态机闭合）');

  // ── bridge 宿主面：影子口径 + 批量三路 + 守恒透传 ──
  const bridge = new SymbiosisBridge({ runtime: { initialSupply: 50_000 } });
  ok(bridge.openDelivery('nobody', 'asset-1') === undefined && bridge.settleDeliveries([]) === undefined, '未挂载（缺省）条件结算 API 全部 undefined（影子口径零漂移）');
  bridge.attachConditionalSettlement();
  bridge.registerModel('m1');
  const sellerAgent = new ProbeAgent('contract-seller');
  bridge.runtime.register(sellerAgent);
  const buyerId = 'model:m1';
  bridge.runtime.ledger.transfer(TREASURY, buyerId, 2000, 'fund', 'setup');
  bridge.runtime.ledger.transfer(TREASURY, 'contract-seller', 2000, 'fund', 'setup');
  const assets = ['b-full', 'b-partial', 'b-breach'].map((ref) =>
    bridge.runtime.market.list({ seller: 'contract-seller', kind: 'pattern', refId: ref, description: `桥接合约 ${ref}`, ask: 60, claimedQuality: 0.8 }),
  );
  const bridgeContracts = assets.map((a) => bridge.openDelivery(buyerId, a.assetId, { depositRate: 0.2 }));
  ok(bridgeContracts.every((c) => c.ok), `桥接开约 ×3（depositRate 0.2 → 保证金 ${12}）`);
  const summary = bridge.settleDeliveries([
    { contractId: bridgeContracts[0].contractId, quality: 0.95 },
    { contractId: bridgeContracts[1].contractId, quality: 0.4 },
    { contractId: bridgeContracts[2].contractId, quality: undefined },
  ]);
  ok(summary.settled === 3 && summary.full === 1 && summary.partial === 1 && summary.breach === 1, `批量三路汇总：${summary.full} 全质 / ${summary.partial} 半质 / ${summary.breach} 违约`);
  ok(summary.totalToSeller === 60 + 24 && summary.totalRefunded === 36 + 60 && summary.totalPenalties === 12, `汇总金额：卖方 ${summary.totalToSeller}、退款 ${summary.totalRefunded}、罚没 ${summary.totalPenalties}（60 货款按约分配）`);
  const bridgeAudit = bridge.deliveryAudit();
  ok(bridgeAudit.conserved && bridgeAudit.breachesRecorded && bridge.deliveryBreaches().length === 1, '桥接托管守恒审计通过 + 违约清单可观测');
}

// ═══════════════════ ⑤ market：市场操纵检测（加分） ═══════════════════

section('⑤ 市场操纵检测：对敲/短周期检出 + 正常流零误报');

{
  // ── 对敲检出：卖家自买自有资产 ──
  const ledger = new EnergyLedger({ initialSupply: 100_000 });
  const market = new CognitiveMarket(ledger, { listingFeeRate: 0 });
  ledger.openAccount('wash-seller');
  ledger.transfer(TREASURY, 'wash-seller', 5000, 'fund', 'setup');
  const listed = market.list({ seller: 'wash-seller', kind: 'pattern', refId: 'wash', description: '对敲资产', ask: 50, claimedQuality: 0.5 });
  const selfBid = market.placeBid('wash-seller', listed.assetId, 60, T0);
  ok(selfBid.ok, '卖家在自己资产上挂买单（对敲挂单成立——检测与执法分离，先允许后检出）');
  const scan1 = market.scanManipulation({ now: T0 + 1000, windowMs: MIN });
  ok(scan1.clean === false && scan1.findings.length === 1 && scan1.findings[0].kind === 'self-dealing' && scan1.findings[0].count === 1, `对敲检出：self-dealing ×1（卖家 wash-seller 自买 ${listed.assetId}）`);

  // ── 短周期循环成交检出：同组合窗口内反复成交 ──
  const cycleLedger = new EnergyLedger({ initialSupply: 100_000 });
  const cycleMarket = new CognitiveMarket(cycleLedger, { listingFeeRate: 0 });
  for (const id of ['cy-seller', 'cy-buyer']) {
    cycleLedger.openAccount(id);
    cycleLedger.transfer(TREASURY, id, 5000, 'fund', 'setup');
  }
  const cyAsset = cycleMarket.list({ seller: 'cy-seller', kind: 'pattern', refId: 'cycle', description: '循环成交资产', ask: 10, claimedQuality: 0.5 });
  for (let i = 0; i < 3; i += 1) {
    cycleMarket.placeBid('cy-buyer', cyAsset.assetId, 12, T0 + i * 2000);
    cycleMarket.match(T0 + i * 2000 + 1000); // 同买/卖/资产组合反复成交
  }
  const scan2 = cycleMarket.scanManipulation({ now: T0 + 10_000, windowMs: MIN, cycleThreshold: 3 });
  const burst = scan2.findings.find((f) => f.kind === 'burst-cycling');
  ok(scan2.clean === false && burst && burst.count === 3, `短周期检出：cy-buyer ⇄ cy-seller 窗口内成交 ×3 ≥ 阈值 3（虚假成交额密度特征）`);

  // ── 正常流零误报：不同主体、稀疏节奏 ──
  const normalLedger = new EnergyLedger({ initialSupply: 100_000 });
  const normalMarket = new CognitiveMarket(normalLedger, { listingFeeRate: 0 });
  for (let i = 1; i <= 3; i += 1) {
    const s = `n-seller-${i}`;
    const b = `n-buyer-${i}`;
    normalLedger.openAccount(s);
    normalLedger.openAccount(b);
    normalLedger.transfer(TREASURY, s, 2000, 'fund', 'setup');
    normalLedger.transfer(TREASURY, b, 2000, 'fund', 'setup');
    const asset = normalMarket.list({ seller: s, kind: 'pattern', refId: `norm-${i}`, description: `正常资产 ${i}`, ask: 20, claimedQuality: 0.7 });
    normalMarket.placeBid(b, asset.assetId, 22, T0 + i * 5000);
    normalMarket.match(T0 + i * 5000 + 1000);
  }
  const scan3 = normalMarket.scanManipulation({ now: T0 + 30_000, windowMs: MIN });
  ok(scan3.clean === true && scan3.findings.length === 0, `正常分散交易零误报：3 组不同主体各成交 1 次 → findings 空（干净市场）`);
}

// ═══════════════════ ⑥ 激活与深化：wrappers 画像透传 + Sankey 渠道扩容 ═══════════════════

section('⑥ 激活与深化：画像透传（wrappers）+ 合约/货币渠道进 Sankey');

{
  // ── wrappers：内置智能体画像 opt-in 透传 ──
  const optimizer = new OptimizerAgent('opt-1', {}, undefined, undefined, { bucketMs: 1000, buckets: 4 });
  const evolver = new EvolverAgent('evo-1', undefined, {}, undefined, { bucketMs: 1000, buckets: 4 });
  const optimizerPlain = new OptimizerAgent('opt-2');
  ok(optimizer.profile(T0) !== undefined && evolver.profile(T0) !== undefined && optimizerPlain.profile(T0) === undefined, '内置智能体画像透传激活：配置即有读数、缺省 undefined（零漂移）');
  for (let i = 0; i < 5; i += 1) {
    optimizer.recordContribution(i < 4, T0 + i * 100, { refId: `host-task-${i}` });
    evolver.recordContribution(true, T0 + i * 100, { refId: `evolution-${i % 2}` });
  }
  const po = optimizer.profile(T0 + 2000);
  const pe = evolver.profile(T0 + 2000);
  ok(po.samples === 5 && near(po.quality, 0.8) && po.impactRadius === 5, `Optimizer 画像：5 样本、质量 ${po.quality.toFixed(2)}、半径 ${po.impactRadius}（宿主任务触达）`);
  ok(pe.impactRadius === 2, `Evolver 画像：影响半径 ${pe.impactRadius}（同一进化对象反复触达 → distinct 口径去重）`);

  // ── observability：合约/货币渠道进入 Sankey 全景 ──
  const rt = new SymbiosisRuntime({
    initialSupply: 10_000,
    openingGrant: 200,
    monetaryPolicy: { targetCirculating: 8000, bandTolerance: 0.05 },
  });
  const seller = new ProbeAgent('sankey-seller');
  const buyer = new ProbeAgent('sankey-buyer');
  rt.register(seller);
  rt.register(buyer);
  rt.settleTaskOutcome(true, [{ agentId: 'sankey-seller' }, { agentId: 'sankey-buyer' }]); // 触发收缩销毁 + 被税分红
  const asset = rt.market.list({ seller: 'sankey-seller', kind: 'pattern', refId: 'sankey-contract', description: '合约资产', ask: 50, claimedQuality: 0.8 });
  const contract = rt.market.openDeliveryContract('sankey-buyer', asset.assetId, { depositRate: 0.2 }, T0);
  rt.market.settleDelivery(contract.contractId, undefined, T0 + 1000); // 违约路径

  const report = buildEnergySankey(rt.ledger, { agents: [{ id: 'sankey-seller', kind: 'memory' }, { id: 'sankey-buyer', kind: 'optimizer' }] });
  const contractLinks = report.links.filter((l) => l.channel.startsWith('contract-'));
  const contractChannels = new Set(contractLinks.map((l) => l.channel));
  ok(contractChannels.has('contract-escrow') && contractChannels.has('contract-stake') && contractChannels.has('contract-refund') && contractChannels.has('contract-breach'), `合约四渠道入图：${[...contractChannels].join(' / ')}`);
  ok(contractLinks.every((l) => l.group === 'contract'), '合约渠道全部归入 contract 组（新着色分组）');
  const contractionLink = report.links.find((l) => l.channel === 'monetary-contraction');
  ok(contractionLink && contractionLink.group === 'mint' && contractionLink.source === TREASURY, `通胀收缩销毁入图：treasury → burn ${contractionLink.amount} 能量（归入铸币组）`);
  const html = renderSankeyHtml(report);
  ok(html.includes('条件结算合约') && html.includes('违约罚没'), 'HTML 全景：合约组图例 + 违约罚没渠道标签可渲染（离线自包含）');
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— 共生经济层第四轮 A11 升级验证成立（流动性度量 / 通胀治理 / 贡献者画像 / 条件结算合约 / 操纵检测 / 激活深化）`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
