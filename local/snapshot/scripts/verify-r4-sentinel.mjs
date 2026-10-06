/**
 * verify-r4-sentinel.mjs — 第四轮模块域升级 R4：Sentinel 全新维度新旧行为对照验证
 *
 * 五项升级（4 主 + 1 加分）各配「旧行为 vs 新行为」的构造对照（证明判别正确/更优）：
 *   ⓪ 零漂移总检：全部新配置缺省时新读数缺席、新 Signal 键缺席、交付行为不变
 *   ① 共因爆发检测：两场景判别——「一因多源爆发」（三源同刻齐发，巧合对提升
 *        lift = 观测/独立期望 ≈ 4.0）vs「各自独立爆发」（同速率同量级、相位
 *        种子化随机，lift ≈ 1.0 随机水平）→ 前者聚类 common-cause 事件、
 *        后者判 independent（不误报共因）；独立期望的解析口径 E=2·tol·rate·N
 *        与蒙特卡洛频率互证；旧行为：无判别能力（view undefined）
 *   ② 周期画像：5s 周期流 12 拍 → 自相关峰锁定周期（±3% 内、强度 1.0、
 *        谐波谱可见）；静默 16s（3.2 周期）→ 漏报负偏离检出：2 条 period-miss
 *        注入（每错失一个期望周期一报）+ overdue 读数；早到/晚到偏差注入
 *        （−0.38 / +0.50 周期）记账；旧行为：漏报零可见性（0 信号）
 *   ③ 级联优先级继承：40 优先级 0.9 → 0.54 → 0.324 → … → 0.02 下限的代际衰减链
 *        （孙代 = 祖代 36% ≤ 上限）、放大企图（子代自报 0.99）被封顶回父代值；
 *        旧行为：触发方自报 0.99 恒定——40 代不衰减（放大风暴不可遏制）
 *   ④ 源质量反馈：gold（20 有效/2 噪声 → score 0.875）vs flaky（2/18 → 0.136），
 *        autoDiscount 打折 0.9125 / 0.3955 → 同紧急度信号排序翻转：
 *        有效信号平均排位 4 → 2；因果口径（未来结局不回溯）随附验证
 *   ⑤ 风暴预算共享（加分）：全局风暴（合流强度 200/s ≥ 阈 30）→ 两源令牌桶
 *        20+20 → 10+10/s 联动收紧，风暴期接纳数 33 → 21（对照无预算哨兵）；
 *        滞回解除后速率恢复 20/s、预算激活计数 1
 *
 * 确定性：全部时间走注入 receivedAt / 合成 clock；独立场景相位用种子化
 * mulberry32；无任何 Date.now / Math.random 依赖。全脚本同步执行
 * （无 await——真实定时器无机会插入，批次切分完全确定）。
 *
 * 运行：npm run build && node --experimental-transform-types scripts/verify-r4-sentinel.mjs
 * （dist 口径——与 verify-mod-sentinel.mjs 一致；transform-types 用于
 *   脚本内直接导入的 .ts 内核，这里为统一口径保留）
 */

import { Sentinel } from '../dist/index.mjs';

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

/** 种子化 PRNG（mulberry32——独立爆发场景的相位抖动，确定性） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 基础哨兵配置（R4 新配置全缺省 = 旧行为；大窗 + 大批次 → 仅手动 flush） */
const baseConfig = {
  watchCodeChanges: false,
  watchErrors: false,
  watchPerformance: false,
  aggregationWindow: 60,
  maxBatchSize: 1_000_000,
};

/** 可变合成时钟（确定性实验用） */
function syntheticClock() {
  const state = { now: 1_700_000_000_000 };
  return { state, clock: () => state.now };
}

// ═══════════════════ ⓪ 零漂移总检（缺省 = 旧行为） ═══════════════════

section('⓪ 零漂移总检：全部 R4 配置缺省时，新读数缺席、旧行为逐位保留');

{
  const { state, clock } = syntheticClock();
  const batches = [];
  const sentinel = new Sentinel({ ...baseConfig, clock }, (b) => batches.push(b));

  ok(
    ['commonCauseView', 'periodicityView', 'cascadePriorityView', 'attachSourceQuality', 'reportOutcome', 'sourceQualityView', 'stormBudgetView'].every(
      (m) => typeof sentinel[m] === 'function',
    ),
    'R4 读数/挂载方法面完整（7 个新公开方法）',
  );
  ok(
    sentinel.commonCauseView() === undefined &&
      sentinel.periodicityView() === undefined &&
      sentinel.cascadePriorityView() === undefined &&
      sentinel.sourceQualityView() === undefined &&
      sentinel.stormBudgetView() === undefined,
    '五个新读数全部缺席（未配置/未挂载 → undefined 诚实降级——零漂移）',
  );
  sentinel.reportOutcome('any', 'effective'); // 未挂载：静默忽略不抛错
  ok(sentinel.sourceQualityView() === undefined, '未挂载时 reportOutcome 静默忽略（评分体系完全 opt-in）');

  const a = sentinel.ingest({ type: 'info', description: '甲', payload: {}, source: 'test', urgency: 0.3, receivedAt: state.now });
  const b = sentinel.ingest({ type: 'cascade', description: '级联子', payload: {}, source: 'cascade', receivedAt: state.now + 1, parentId: 'sig-甲' });
  ok(!('inheritedUrgency' in a) && !('qualityWeight' in a) && !('inheritedUrgency' in b) && !('qualityWeight' in b), '新 Signal 键缺席（inheritedUrgency / qualityWeight——缺省不出现）');
  ok(b.urgency === undefined, '未配置级联继承时子信号 urgency 保持调用方原样（undefined——旧口径）');
  sentinel.ingest({ type: 'info', description: '乙', payload: {}, source: 'test', urgency: 0.9, receivedAt: state.now + 2 });
  sentinel.flush();
  ok(
    batches.length === 1 && batches[0].signals.map((s) => s.description).join(',') === '甲,级联子,乙',
    '缺省 flush 保持到达序（交付行为逐位不变）',
  );
}

// ═══════════════════ ① 共因爆发检测 ═══════════════════

section('① 共因爆发检测：一因多源爆发 vs 各自独立爆发的判别（两场景对照）');

{
  const t0 = 1_700_000_000_000;
  const ccConfig = {
    windowMs: 10_000,
    coincidenceMs: 50,
    evaluateEveryMs: 0,
    minBurstRatePerSec: 1,
    burstFactor: 3,
    minLift: 2.5,
    minSources: 2,
  };
  const SRC = ['svc-a', 'svc-b', 'svc-c'];

  /** 场景构造：8s 平静（每源 0.5/s）→ 12s 风暴（每源 30 到达 @400ms 间隔 = 2.5/s） */
  const feedScenario = (sentinel, offsets) => {
    // 平静相：每 2s 一轮，三源错开 500ms
    for (let i = 0; i < 4; i += 1) {
      const t = t0 + i * 2000;
      SRC.forEach((s, k) => sentinel.ingest({ type: 'load', description: `quiet-${s}-${i}`, payload: {}, source: s, receivedAt: t + k * 500 }));
    }
    const quietView = sentinel.commonCauseView();
    // 风暴相：30 轮 @400ms；offsets(k, j) 给出第 k 源第 j 轮的相位偏移
    for (let j = 0; j < 30; j += 1) {
      const t = t0 + 8000 + j * 400;
      SRC.forEach((s, k) => sentinel.ingest({ type: 'load', description: `storm-${s}-${j}`, payload: {}, source: s, receivedAt: t + offsets(k, j) }));
    }
    return quietView;
  };

  // —— 场景 A：一因多源（共同根因扇出：三源同刻齐发）——
  const { state: stA, clock: clkA } = syntheticClock();
  const common = new Sentinel({ ...baseConfig, clock: clkA, commonCause: ccConfig }, () => {});
  const quietViewA = feedScenario(common, () => 0);
  ok(
    quietViewA.groups.length === 0 && quietViewA.commonCauseEvents === 0 && quietViewA.burstSources.every((s) => !s.burst),
    `平静相无误报：无分组、无事件、三源均非风暴（速率 0.5/s < 阈 max(1, 基线×3)）`,
  );
  const viewA = common.commonCauseView();
  const burstsA = viewA.burstSources;
  ok(burstsA.length === 3 && burstsA.every((s) => s.burst), `风暴判别：三源全部进入风暴态（窗内速率 ${(burstsA[0].ratePerSec).toFixed(2)}/s ≈ 2.5/s ≥ 阈 1.35）`);
  const groupA = viewA.groups.find((g) => g.classification === 'common-cause');
  ok(
    groupA !== undefined && groupA.sources.length === 3,
    `共因聚类：三源聚为一组 common-cause（${groupA ? groupA.sources.join('+') : '-'}——巧合对提升连边成团）`,
  );
  const liftsA = groupA.pairLifts.map((p) => p.lift);
  console.log(`    共因场景两两提升实测：${liftsA.map((l) => l.toFixed(2)).join(' / ')}（观测 ${groupA.pairLifts[0].observedPairs} 对 / 独立期望 ${groupA.pairLifts[0].expectedPairs.toFixed(2)} 对）`);
  ok(Math.min(...liftsA) >= 3, `共因组最小提升 ${Math.min(...liftsA).toFixed(2)} ≥ 3（独立期望 6.25 对 vs 观测 25 对——同刻齐发的数学口径）`);
  ok(
    viewA.commonCauseEvents >= 1 && viewA.commonCauseEvents <= 3 && viewA.events.every((e) => e.kind === 'common-cause'),
    `共因事件入史：commonCauseEvents=${viewA.commonCauseEvents}（成团沿：两源先过风暴阈成团 → 第三源下一评估并入——均为 common-cause，首检时刻 ${viewA.events[0].detectedAt - t0}ms）`,
  );
  ok(viewA.independentStormEvents === 0, '共因场景不误判独立风暴（independentStormEvents=0）');

  // —— 场景 B：各自独立爆发（同速率同量级，相位种子化随机）——
  const { state: stB, clock: clkB } = syntheticClock();
  const rand = mulberry32(42);
  const phases = Array.from({ length: 90 }, () => rand() * 400); // 预生成确定性相位池
  const indep = new Sentinel({ ...baseConfig, clock: clkB, commonCause: ccConfig }, () => {});
  feedScenario(indep, (k, j) => phases[j * 3 + k]);
  const viewB = indep.commonCauseView();
  const burstsB = viewB.burstSources;
  ok(burstsB.every((s) => s.burst), `独立场景三源同样各自风暴（速率同 ${(burstsB[0].ratePerSec).toFixed(2)}/s——量级与共因场景一致，判别只能靠同期性）`);
  ok(viewB.groups.every((g) => g.classification === 'independent'), `独立判别：无 common-cause 分组（${viewB.groups.map((g) => g.sources.join('+')).join(', ')} 全判 independent）`);
  const liftsB = viewB.pairLifts.map((p) => p.lift);
  console.log(`    独立场景两两提升实测：${liftsB.map((l) => l.toFixed(2)).join(' / ')}（解析期望 ≈ 1.0：P(|Δφ|≤50ms) ≈ 0.25/轮 ×25 轮 ≈ 6.3 对 ≈ 期望 6.5 对——巧合回到随机水平）`);
  ok(liftsB.length === 3 && Math.max(...liftsB) <= 1.9, `独立组最大提升 ${Math.max(...liftsB).toFixed(2)} ≤ 1.9（≈ 随机水平，远低于连边阈 2.5——不误报共因）`);
  ok(
    viewB.commonCauseEvents === 0 && viewB.independentStormEvents >= 1 && viewB.independentStormEvents <= 3,
    `独立风暴事件入史：commonCause=0 / independent=${viewB.independentStormEvents}（${viewB.events[viewB.events.length - 1].sources.join('+')}——判别正确）`,
  );

  // —— 新旧对照：无 commonCause 配置（旧口径）——
  const { clock: clkC } = syntheticClock();
  const oldSentinel = new Sentinel({ ...baseConfig, clock: clkC }, () => {});
  feedScenario(oldSentinel, () => 0);
  ok(
    oldSentinel.commonCauseView() === undefined,
    '旧行为对照：无共因分析配置 → commonCauseView undefined（多源同时爆发与独立爆发在旧口径下完全同貌，只能各自按 isBurst 处理）',
  );
  common.flush();
  indep.flush();
  oldSentinel.flush();
  void stA;
  void stB;
}

// ═══════════════════ ② 周期画像 ═══════════════════

section('② 周期画像：周期锁定 / 漏报负偏离 / 到达偏差（vs 旧行为零可见性）');

{
  const t0 = 1_700_000_000_000;
  const { state, clock } = syntheticClock();
  const batches = [];
  const sentinel = new Sentinel(
    {
      ...baseConfig,
      clock,
      periodicity: { minPeriodMs: 1000, maxPeriodMs: 60_000, minArrivals: 8, reevaluateEvery: 4, missFactor: 1.5, deviationThreshold: 0.3, emitMissSignals: true },
    },
    (b) => batches.push(b),
  );

  // —— 周期锁定：heartbeat 每 5s 一拍 × 12 拍 ——
  for (let i = 0; i < 12; i += 1) {
    sentinel.ingest({ type: 'heartbeat', description: `hb-${i}`, payload: {}, source: 'heartbeat', receivedAt: t0 + i * 5000 });
  }
  let view = sentinel.periodicityView();
  const hb = view.sources.find((s) => s.source === 'heartbeat');
  ok(hb.status === 'locked', `周期锁定：第 8 拍即评即锁（minArrivals=8）→ status=locked`);
  ok(Math.abs(hb.periodMs - 5000) <= 160, `周期估计 ${hb.periodMs}ms（真值 5000ms，偏差 ${((Math.abs(hb.periodMs - 5000) / 5000) * 100).toFixed(1)}% ≤ 3%+容差——自相关峰 + 基频优选 + 局部细化）`);
  ok(hb.strength >= 0.95, `周期强度 ${hb.strength.toFixed(3)} ≥ 0.95（回报率谱：12 拍等间隔近乎全匹配）`);
  ok(hb.spectrum.length >= 3 && hb.spectrum[0].score >= 0.95, `强度谱可见：top-${hb.spectrum.length} 候选（首点 ${(hb.spectrum[0].periodMs)}ms@${hb.spectrum[0].score.toFixed(2)}——谐波 2P/3P 同高分，基频优选取最小）`);
  ok(near(hb.expectedNextAt, t0 + 55_000 + hb.periodMs), `下一期望到达 expectedNextAt = 上次到达 + 周期（${hb.expectedNextAt - t0}ms——「该来的」有了明确预期）`);
  const hbPeriod = hb.periodMs;

  // —— 漏报负偏离：静默 16s（≈3.2 周期）由其他源的到达触发扫描 ——
  state.now = t0 + 55_000 + 16_000;
  sentinel.ingest({ type: 'tick', description: 'tick-1', payload: {}, source: 'tick', receivedAt: state.now });
  view = sentinel.periodicityView();
  const hb2 = view.sources.find((s) => s.source === 'heartbeat');
  const cyclesSilent = 16_000 / hbPeriod;
  ok(hb2.status === 'overdue' && near(hb2.overdueCycles, cyclesSilent - 1, 1e-9), `漏报检出：status=overdue、逾期 ${(cyclesSilent - 1).toFixed(2)} 周期（静默 ${cyclesSilent.toFixed(2)} 周期 ≥ missFactor 1.5——「该来的没来」负偏离可见）`);
  ok(hb2.misses === 2, `漏报按周期计次注入：misses=${hb2.misses}（每错失一个期望周期一报：1.5P、2.5P 两个槽 ≤ 3.2P，3.5P 未到不报）`);
  sentinel.flush();
  const missSignals = batches[0].signals.filter((s) => s.type === 'period-miss');
  ok(
    missSignals.length === 2 &&
      missSignals.every((s) => s.payload.target === 'heartbeat' && near(s.payload.expectedAt, t0 + 55_000 + hbPeriod)) &&
      near(missSignals[0].payload.cyclesSilent, cyclesSilent, 1e-9),
    `period-miss 信号内容：${missSignals.length} 条、payload.target=heartbeat、expectedAt=${t0 + 55_000 + hbPeriod}、cyclesSilent=${cyclesSilent.toFixed(2)}（定位到期望槽的审计口径）`,
  );
  const missUrg = missSignals[0].urgency;
  ok(near(missUrg, 0.5 + 0.1 * (cyclesSilent - 1), 1e-9), `漏报紧急度随逾期加深：urgency=${missUrg.toFixed(3)}（0.5 + 0.1×超期周期数——确定性函数）`);

  // —— 到达偏差注入（另一哨兵：早到 −0.38 / 晚到 +0.50 周期）——
  const { state: st2, clock: clk2 } = syntheticClock();
  const dev = new Sentinel({ ...baseConfig, clock: clk2, periodicity: { minPeriodMs: 1000, maxPeriodMs: 60_000, minArrivals: 8, reevaluateEvery: 4 } }, () => {});
  const t0d = st2.now;
  for (let i = 0; i < 8; i += 1) {
    dev.ingest({ type: 'job', description: `job-${i}`, payload: {}, source: 'drifty', receivedAt: t0d + i * 5000 });
  }
  const lockedPeriod = dev.periodicityView().sources[0].periodMs;
  // 探针 1：早到（上次到达 35000、期望 35000+P、实际 38000 → dev = (3000−P)/P ≈ −0.38）
  dev.ingest({ type: 'job', description: 'job-early', payload: {}, source: 'drifty', receivedAt: t0d + 38_000 });
  let dv = dev.periodicityView().sources[0].lastDeviationCycles;
  const expectEarly = (3000 - lockedPeriod) / lockedPeriod;
  ok(near(dv, expectEarly, 1e-9) && Math.abs(dv) > 0.3, `早到偏差记账：lastDeviationCycles=${dv.toFixed(3)}（期望 ${(expectEarly).toFixed(3)} = (38000−35000−P)/P——负偏离）`);
  // 探针 2：晚到 +0.50 周期（上次到达 38000，期望 38000+P，实际 38000+round(1.5P)）
  const lateT = 38_000 + Math.round(lockedPeriod * 1.5);
  dev.ingest({ type: 'job', description: 'job-late', payload: {}, source: 'drifty', receivedAt: t0d + lateT });
  const dv2 = dev.periodicityView().sources[0];
  const expectLate = (lateT - 38_000 - lockedPeriod) / lockedPeriod;
  ok(near(dv2.lastDeviationCycles, expectLate, 1e-9) && Math.abs(dv2.lastDeviationCycles - 0.5) < 0.005 && dv2.deviations === 2, `晚到偏差记账：lastDeviationCycles=${dv2.lastDeviationCycles.toFixed(4)}（≈ +0.50 周期，取整级误差）、超阈计数 deviations=${dv2.deviations}（早到+晚到各一）`);

  // —— 新旧对照：无 periodicity 配置（旧口径）——
  const { state: st3, clock: clk3 } = syntheticClock();
  const oldS = new Sentinel({ ...baseConfig, clock: clk3 }, (b) => batches.push(b));
  for (let i = 0; i < 12; i += 1) {
    oldS.ingest({ type: 'heartbeat', description: `hb-${i}`, payload: {}, source: 'heartbeat', receivedAt: t0 + i * 5000 });
  }
  oldS.ingest({ type: 'tick', description: 'tick-1', payload: {}, source: 'tick', receivedAt: t0 + 71_000 });
  oldS.flush();
  const oldMiss = batches[1].signals.filter((s) => s.type === 'period-miss').length;
  ok(oldS.periodicityView() === undefined && oldMiss === 0, `旧行为对照：无周期概念 → 漏报零可见性（16s 静默 = 3.2 周期，旧口径 0 条信号 vs 新口径 2 条 period-miss + overdue 读数）`);
  dev.flush();
}

// ═══════════════════ ③ 级联优先级继承 ═══════════════════

section('③ 级联优先级继承：代际衰减 + 放大封顶（vs 旧行为自报恒定）');

{
  const { state, clock } = syntheticClock();
  const sentinel = new Sentinel({ ...baseConfig, clock, cascadePriority: {} }, () => {});
  const t0 = state.now;
  const signals = [];
  signals.push(sentinel.ingest({ type: 'cascade', description: 'gen-0', payload: {}, source: 'decide', urgency: 0.9, receivedAt: t0, id: 'gen-0' }));
  for (let k = 1; k <= 40; k += 1) {
    signals.push(
      sentinel.ingest({ type: 'cascade', description: `gen-${k}`, payload: {}, source: 'cascade', receivedAt: t0 + k, id: `gen-${k}`, parentId: `gen-${k - 1}` }),
    );
  }
  const u = (k) => signals[k].urgency;
  const expect = (k) => Math.max(0.02, 0.9 * 0.6 ** k);
  ok(near(u(1), 0.54) && near(u(2), 0.324) && near(u(3), 0.1944), `代际衰减链：子 0.54 → 孙 0.324 → 曾孙 0.1944（0.9 × 0.6^k 逐位符合）`);
  ok(near(u(5), expect(5)) && near(u(5), 0.069984), `第 5 代 ${u(5).toFixed(6)}（0.9×0.6⁵ 精确）`);
  ok(near(u(12), 0.02) && near(u(40), 0.02), `下限保护：第 ${12} 代起触及 minUrgency=0.02（0.9×0.6¹²=0.00196 < 0.02——深链不隐形）`);
  ok(signals.slice(1).every((s, i) => i === 0 || signals[i + 1].urgency <= signals[i].urgency + 1e-12), '40 代全程单调不增（无任何一代放大）');
  ok(signals.slice(1).every((s, k) => s.urgency <= expect(k + 1) + 1e-9) && signals.slice(1).every((s) => s.inheritedUrgency === true), '每代 ≤ 祖代 × 0.6^k（孙代 = 祖代 36% ≤ 上限）且携带 inheritedUrgency 标记');
  ok(signals[0].inheritedUrgency === undefined && signals[0].urgency === 0.9, '根信号不受继承规则影响（urgency 原样、无标记）');

  // 放大企图：子代自报 0.99，父代有效 0.54 → 封顶回父代值
  const amp = sentinel.ingest({ type: 'cascade', description: 'amp-1', payload: {}, source: 'cascade', urgency: 0.99, receivedAt: t0 + 100, id: 'amp-1', parentId: 'gen-1' });
  ok(near(amp.urgency, 0.54) && amp.inheritedUrgency === true, `放大封顶：自报 0.99 → 有效 ${amp.urgency}（= 父代 0.54 × maxInherit 1.0——级联触发方无法自行抬升优先级）`);
  const cv = sentinel.cascadePriorityView();
  ok(cv.inherited === 41 && cv.capped === 1 && cv.maxGeneration === 32, `读数：inherited=${cv.inherited}（40 链 + 1 封顶）/ capped=${cv.capped} / maxGeneration=${cv.maxGeneration}（第三轮链深硬顶 32 的自然饱和——第 33~40 代继承仍全部生效）`);

  // 旧行为对照：同链每代自报 0.99（旧口径：优先级完全由触发方决定）
  const { clock: clk2 } = syntheticClock();
  const oldS = new Sentinel({ ...baseConfig, clock: clk2 }, () => {});
  const t02 = 1_700_000_000_000;
  oldS.ingest({ type: 'cascade', description: 'gen-0', payload: {}, source: 'decide', urgency: 0.9, receivedAt: t02, id: 'gen-0' });
  const oldUrg = [];
  for (let k = 1; k <= 40; k += 1) {
    const s = oldS.ingest({ type: 'cascade', description: `gen-${k}`, payload: {}, source: 'cascade', urgency: 0.99, receivedAt: t02 + k, id: `gen-${k}`, parentId: `gen-${k - 1}` });
    oldUrg.push(s.urgency);
  }
  console.log(`    新旧对照（代际 → urgency）：新 ${[1, 2, 3, 5, 12, 40].map((k) => `gen${k}=${u(k).toFixed(3)}`).join(' ')} | 旧 ${[1, 2, 3, 5, 12, 40].map((k) => `gen${k}=${oldUrg[k - 1].toFixed(2)}`).join(' ')}`);
  ok(oldUrg.every((x) => x === 0.99) && oldS.cascadePriorityView() === undefined, `旧行为对照：40 代恒 0.99（放大风暴不可遏制）vs 新口径 gen40 = 0.02（root 的 2.2%）——继承治理是 opt-in 的`);
  sentinel.flush();
  oldS.flush();
}

// ═══════════════════ ④ 源质量反馈 ═══════════════════

section('④ 源质量反馈：高低质量源混合流的排序改善（有效信号提前）');

{
  const t0 = 1_700_001_000_000;
  const { state, clock } = syntheticClock();
  const batches = [];
  const withQ = new Sentinel({ ...baseConfig, clock, urgencyHalfLifeMs: 10_000 }, (b) => batches.push(b));
  withQ.attachSourceQuality({ autoDiscount: true, minWeight: 0.3, smoothing: 1, windowMs: 3_600_000 });

  // 结局回填（信号时刻之前——因果口径）
  for (let i = 0; i < 20; i += 1) withQ.reportOutcome('gold', 'effective', t0 - 60_000 + i * 100);
  for (let i = 0; i < 2; i += 1) withQ.reportOutcome('gold', 'noise', t0 - 58_000 + i * 100);
  for (let i = 0; i < 2; i += 1) withQ.reportOutcome('flaky', 'effective', t0 - 60_000 + i * 100);
  for (let i = 0; i < 18; i += 1) withQ.reportOutcome('flaky', 'noise', t0 - 59_000 + i * 100);

  const qv = withQ.sourceQualityView();
  const gold = qv.find((s) => s.source === 'gold');
  const flaky = qv.find((s) => s.source === 'flaky');
  ok(qv[0].source === 'gold', `评分排序：gold 居首（view 按评分降序）`);
  ok(near(gold.score, 21 / 24) && near(flaky.score, 3 / 22), `评分口径：gold (20+1)/(22+2)=${gold.score.toFixed(4)} / flaky (2+1)/(20+2)=${flaky.score.toFixed(4)}（Laplace 平滑——小样本不极端）`);
  ok(near(gold.weight, 0.9125) && near(flaky.weight, 0.3 + 0.7 * (3 / 22), 1e-12), `打折权重：gold ${gold.weight.toFixed(4)} / flaky ${flaky.weight.toFixed(4)}（minWeight 0.3 + 0.7×score——打折但不抹杀）`);

  // 同紧急度混合流：flaky/gold 交替 6 条（同时刻、同 urgency 0.9）
  const feedMixed = (s) => {
    for (let i = 0; i < 6; i += 1) {
      const src = i % 2 === 0 ? 'flaky' : 'gold';
      s.ingest({ type: 'alert', description: `mixed-${src}-${i}`, payload: {}, source: src, urgency: 0.9, receivedAt: t0 + 1000 });
    }
  };
  feedMixed(withQ);
  state.now = t0 + 1000;
  withQ.flush();
  const newOrder = batches[0].signals.map((s) => s.source);
  const goldRankNew = batches[0].signals.map((s, i) => (s.source === 'gold' ? i + 1 : 0)).filter((x) => x > 0);
  const meanRank = (r) => r.reduce((a, x) => a + x, 0) / r.length;
  ok(newOrder.join(',') === 'gold,gold,gold,flaky,flaky,flaky', `排序翻转：gold×3 全部提前（打折后 0.9×0.9125=${(0.9 * 0.9125).toFixed(4)} vs 0.9×0.3955=${(0.9 * (0.3 + 0.7 * (3 / 22))).toFixed(4)}）`);
  ok(near(meanRank(goldRankNew), 2), `有效信号平均排位 ${(meanRank(goldRankNew)).toFixed(1)}（新）`);
  const goldSig = batches[0].signals.find((s) => s.source === 'gold');
  ok(near(goldSig.qualityWeight, 0.9125) && near(goldSig.decayedUrgency, 0.9 * 0.9125), `审计字段：qualityWeight=${goldSig.qualityWeight}、decayedUrgency=${goldSig.decayedUrgency.toFixed(5)}（同刻同龄 → 排序纯由折扣决定）`);

  // 旧行为对照：不挂载质量追踪（同 half-life、同流）
  const { state: st2, clock: clk2 } = syntheticClock();
  const batches2 = [];
  const control = new Sentinel({ ...baseConfig, clock: clk2, urgencyHalfLifeMs: 10_000 }, (b) => batches2.push(b));
  st2.now = t0 + 1000;
  feedMixed(control);
  control.flush();
  const oldOrder = batches2[0].signals.map((s) => s.source);
  const goldRankOld = batches2[0].signals.map((s, i) => (s.source === 'gold' ? i + 1 : 0)).filter((x) => x > 0);
  ok(oldOrder.join(',') === 'flaky,gold,flaky,gold,flaky,gold' && near(meanRank(goldRankOld), 4), `旧行为对照：同紧急度无折扣 → 到达序，有效信号平均排位 ${(meanRank(goldRankOld)).toFixed(1)}（低质量源占据前排——升级动机）`);

  // 因果口径：结局晚于到达不回溯污染（信号 t0+1_000_000，结局 t0+1_000_001 才回填）
  const flakyLate = withQ.ingest({ type: 'alert', description: 'late-flaky', payload: {}, source: 'flaky', urgency: 0.9, receivedAt: t0 + 1_000_000 });
  withQ.reportOutcome('flaky', 'effective', t0 + 1_000_001);
  ok(near(flakyLate.qualityWeight, flaky.weight), `因果口径：信号之后回填的 effective 结局不影响该信号折扣（qualityWeight=${flakyLate.qualityWeight.toFixed(4)} 仍按旧结局 0.3955 算——未来不回溯）`);
  withQ.flush();
  control.flush();
}

// ═══════════════════ ⑤ 风暴预算共享（加分项） ═══════════════════

section('⑤ 风暴预算共享：全局风暴期各源令牌桶联动收紧（vs 各自为政）');

{
  const t0 = 1_700_002_000_000;
  const bpConfig = { default: { ratePerSec: 20, burst: 5 } };
  const { state, clock } = syntheticClock();
  const shared = new Sentinel({ ...baseConfig, clock, backpressure: bpConfig, stormBudget: { tightenFactor: 0.5, stormFactor: 3, minStormRatePerSec: 20, holdMs: 2000, intensityAlpha: 0.3 } }, () => {});
  const { clock: clk2 } = syntheticClock();
  const control = new Sentinel({ ...baseConfig, clock: clk2, backpressure: bpConfig }, () => {});

  // 平静相：'a' 20 到达 @100ms（合流强度 10/s → 基线 10，阈 max(20, 30) = 30）
  let t = t0;
  for (let i = 0; i < 20; i += 1) {
    t += 100;
    shared.ingest({ type: 'load', description: `quiet-${i}`, payload: {}, source: 'a', receivedAt: t });
    control.ingest({ type: 'load', description: `quiet-${i}`, payload: {}, source: 'a', receivedAt: t });
  }
  ok(shared.stormBudgetView().active === false, `平静相：全局强度 10/s < 阈 30 → 预算未激活（两桶速率 20+20/s 各自为政）`);

  // 风暴相：两源交错 @5ms（合流 200/s）×120 到达
  const countAdmitted = (s) => {
    let admitted = 0;
    let overflowed = 0;
    for (let j = 0; j < 60; j += 1) {
      const base = t + j * 10;
      for (const [src, off] of [['a', 0], ['b', 5]]) {
        const sig = s.ingest({ type: 'storm', description: `storm-${src}-${j}`, payload: {}, source: src, receivedAt: base + off });
        if (sig.overflowed === true) overflowed += 1;
        else admitted += 1;
      }
    }
    return { admitted, overflowed };
  };
  const sharedRes = countAdmitted(shared);
  const controlRes = countAdmitted(control);
  const sbv = shared.stormBudgetView();
  ok(sbv.active === true && sbv.tightenings === 1, `风暴激活：合流强度 ${sbv.intensityPerSec.toFixed(0)}/s ≥ 阈 ${sbv.thresholdPerSec} → 收紧激活 1 次（第 2 个风暴到达即联动）`);
  ok(near(sbv.budgetPerSec, 20, 1e-9) && sbv.sources.every((s) => near(s.originalRatePerSec, 20) && near(s.ratePerSec, 10)), `全局预算收紧：20+20 → ${sbv.sources.map((s) => s.ratePerSec).join('+')}/s（tightenFactor 0.5——含风暴期新建的 'b' 桶）`);
  console.log(`    风暴期接纳对照：共享预算 ${sharedRes.admitted} 条（溢出 ${sharedRes.overflowed}）vs 各自为政 ${controlRes.admitted} 条（溢出 ${controlRes.overflowed}）——风暴期全局入口预算减半，风暴后预算内信号不受挤占`);
  ok(sharedRes.admitted < controlRes.admitted - 5, `联动收紧生效：共享 ${sharedRes.admitted} < 各自为政 ${controlRes.admitted} − 5（同配额同风暴——差别仅来自全局联动）`);
  ok(control.stormBudgetView() === undefined, '旧行为对照：无 stormBudget 配置 → 读数缺席（各源令牌桶互不联动，风暴合流无全局治理）');

  // 滞回解除：静默 3s + 平静 40 到达 @100ms → 强度回落 + holdMs 滞回后恢复
  t += 3000;
  for (let i = 0; i < 40; i += 1) {
    t += 100;
    shared.ingest({ type: 'load', description: `calm-${i}`, payload: {}, source: 'a', receivedAt: t });
  }
  const sbv2 = shared.stormBudgetView();
  ok(sbv2.active === false && sbv2.sources.every((s) => near(s.ratePerSec, 20) && near(s.originalRatePerSec, 20)), `滞回解除：强度回落后距最后过阈证据 ≥ 2000ms → 速率恢复 ${sbv2.sources.map((s) => s.ratePerSec).join('+')}/s（抖动不震荡）`);
  // 恢复后预算内需求畅通：10 到达 @100ms（需求 10/s < 20/s）全接纳
  let allIn = true;
  for (let i = 0; i < 10; i += 1) {
    t += 100;
    const sig = shared.ingest({ type: 'load', description: `post-${i}`, payload: {}, source: 'a', receivedAt: t });
    if (sig.overflowed === true) allIn = false;
  }
  ok(allIn && shared.stormBudgetView().tightenings === 1, `恢复后畅通：预算内 10/s 需求全接纳、全程仅激活 1 次（无反复震荡）`);
  shared.flush();
  control.flush();
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— Sentinel 第四轮五项升级（共因爆发/周期画像/级联继承/源质量/风暴预算）新旧行为对照验证成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
