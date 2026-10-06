/**
 * verify-mod-sentinel.mjs — 第三轮模块域升级：Sentinel（信号哨兵）新旧行为对照验证
 *
 * 六项升级各配「旧行为 vs 新行为」的构造对照（不是「改了」，是「证明更好」）：
 *   ① 自适应窗口 v2：合成时钟确定性轨迹（固定窗口恒 500ms vs 三态收缩/恢复）
 *      + 真实定时器 A/B（构造风暴 60 信号密集到达：固定 vs 自适应的滞留时延
 *      统计；空闲孤立信号 500ms vs ~63ms 交付时延）+ Hawkes 只读第二证据路径
 *   ② 紧急度衰减：半衰期 10s 构造「陈年 0.95 vs 新鲜 0.60」——衰减后排序翻转、
 *      合并取峰值（旧行为：到达序 + 首见覆盖，两侧对照实测）
 *   ③ 入口背压：令牌桶（10 令牌/s、桶容 3）+ 脚本侧独立桶模拟 oracle 逐位对照；
 *      溢出计数/溢出率/标记可观测；缺省不限流（旧行为）
 *   ④ 来源溯源链：a→b→c 链深 0/1/2、批次 maxProvenanceDepth、自环/互指环
 *      切断计数、41 级深链封顶 32、聚合保留最长链
 *   ⑤ 近重复去重：1−NCD 比较器注入——「重试 3 次 vs 重试 4 次」越过中间无关
 *      信号合并、「磁盘满 vs 模型注册」不合并（缺省精确哈希：4 条全独立）
 *   ⑥ 指纹统计：源×类型×指纹滚动统计（计数/窗口计数/间隔 EMA）、滚动窗滑出、
 *      LRU 淘汰、未挂载 undefined
 *   ⑦ 零漂移总检：全部新配置缺省时状态键缺席、交付行为与旧口径逐位一致
 *
 * 确定性：新逻辑时间全走注入时钟/注入 receivedAt（哨兵内无新随机源）；
 * NCD 为确定性 LZW 压缩距离。真实定时器 A/B 段用宽裕时延边界吸收调度抖动。
 *
 * 运行：npm run build && node --experimental-strip-types scripts/verify-mod-sentinel.mjs
 */

import { Sentinel } from '../dist/index.mjs';
import { ncd } from '../src/core/compression-distance.ts';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 基础哨兵配置（新配置全缺省 = 旧行为；窗口 500ms；不让 max-size 触发） */
const baseConfig = {
  watchCodeChanges: false,
  watchErrors: false,
  watchPerformance: false,
  aggregationWindow: 0.5,
  maxBatchSize: 10_000,
};

/** 可变合成时钟（确定性实验用） */
function syntheticClock() {
  const state = { now: 1_700_000_000_000 };
  return { state, clock: () => state.now };
}

// ═══════════════════ ⑦ 零漂移总检（缺省 = 旧行为） ═══════════════════

section('⑦ 零漂移总检：全部新配置缺省时，新读数缺席、旧行为逐位保留');

{
  const { state, clock } = syntheticClock();
  const batches = [];
  const sentinel = new Sentinel({ ...baseConfig, clock }, (b) => batches.push(b));

  ok(
    ['attachHawkesBurstGuard', 'hawkesView', 'attachNoveltySentinel', 'noveltyView', 'attachStreamingSketch', 'sketchView', 'sketchSelfCheck', 'attachAttentionEconomy', 'attentionMarket', 'attachFingerprintTracker', 'fingerprintStats', 'backpressureView'].every(
      (m) => typeof sentinel[m] === 'function',
    ),
    '挂载/读数方法面完整（既有 9 个 + 本轮新增 3 个）',
  );
  ok(sentinel.backpressureView() === undefined, '背压读数缺席（未配置 → 不限流——旧行为）');
  ok(sentinel.fingerprintStats() === undefined, '指纹统计缺席（未挂载 → undefined 诚实降级）');
  const status = sentinel.getStatus();
  ok(!('loadState' in status) && !('intensityPerSec' in status) && !('backpressure' in status), '三态/强度/背压状态键缺席（缺省零漂移）');
  ok(status.maxProvenanceDepth === 0 && status.provenanceCycles === 0 && status.nearDuplicateMerges === 0, '溯源/近重复计数从零起步');

  // 旧合并口径：urgency 首见保留
  const first = sentinel.ingest({ type: 'error', description: '重复错误', payload: {}, source: 'test', urgency: 0.2, receivedAt: state.now });
  const dup = sentinel.ingest({ type: 'error', description: '重复错误', payload: {}, source: 'test', urgency: 0.9, receivedAt: state.now + 100 });
  ok(dup === first && first.occurrences === 2 && first.urgency === 0.2, `旧合并口径：同键合并计数 ${first.occurrences}、urgency 首见保留 ${first.urgency}（后到 0.9 不覆盖）`);
  ok(!('decayedUrgency' in first), '衰减字段缺席（未配置半衰期）');

  // 旧交付口径：到达序（无排序）
  sentinel.ingest({ type: 'info', description: '甲', payload: {}, source: 'test', urgency: 0.1, receivedAt: state.now + 200 });
  sentinel.ingest({ type: 'info', description: '乙', payload: {}, source: 'test', urgency: 0.9, receivedAt: state.now + 300 });
  sentinel.flush();
  ok(
    batches.length === 1 && batches[0].signals.map((s) => s.description).join(',') === '重复错误,甲,乙',
    '缺省 flush 保持到达序（低紧急度「甲」仍在高紧急度「乙」之前——旧行为基准，② 的对照组）',
  );
  ok(!('maxProvenanceDepth' in batches[0]), '无级联信号时批次不携带 maxProvenanceDepth 键（零漂移）');
  const probe = sentinel.ingest({ type: 'error', description: '富化探针', payload: {}, source: 'test', receivedAt: state.now });
  ok(!('loadState' in probe.enrichment) && !('intensityPerSec' in probe.enrichment), '缺省富化上下文不携带三态/强度键（零漂移）');
  sentinel.flush();
}

// ═══════════════════ ① 自适应窗口 v2：确定性轨迹 ═══════════════════

section('① 自适应窗口 v2：合成时钟下的三态轨迹（固定 vs v1 缺省 vs v2）');

{
  // 场景：12 信号@80ms（正常 ~12.5/s）→ 60 信号@5ms（风暴 200/s）→ 2s 空隙 → 孤立信号 → 8×80ms 恢复
  const feedScenario = (sentinel, clockState, t0) => {
    const loadStates = [];
    let t = t0;
    const push = (gap, tag) => {
      t += gap;
      if (clockState) clockState.now = t;
      const s = sentinel.ingest({ type: 'load', description: `${tag}@${t}`, payload: {}, source: 'test', receivedAt: t });
      loadStates.push({ t, tag, loadState: s.enrichment?.loadState });
    };
    for (let i = 0; i < 12; i += 1) push(80, 'normal');
    const afterNormal = { ...sentinel.getStatus() };
    const stormTrajectory = [];
    for (let i = 0; i < 60; i += 1) {
      push(5, 'storm');
      stormTrajectory.push(sentinel.getStatus().effectiveWindowMs);
    }
    const afterStorm = { ...sentinel.getStatus() };
    t += 2000; // idleGap = max(3×500, 1000) = 1500ms
    if (clockState) clockState.now = t;
    sentinel.ingest({ type: 'load', description: `lone@${t}`, payload: {}, source: 'test', receivedAt: t });
    const afterIdle = { ...sentinel.getStatus() };
    const recovery = [];
    for (let i = 0; i < 8; i += 1) {
      push(80, 'recover');
      recovery.push(sentinel.getStatus().effectiveWindowMs);
    }
    return { afterNormal, stormTrajectory, afterStorm, afterIdle, recovery, loadStates };
  };

  // —— 旧行为基线 A：纯固定窗口（adaptiveWindow: false）——
  const fixed = new Sentinel({ ...baseConfig, adaptiveWindow: false }, () => {});
  const fixedResult = feedScenario(fixed, null, 1_700_000_000_000);
  fixed.flush();
  ok(
    fixedResult.stormTrajectory.every((w) => w === 500) && fixedResult.afterIdle.effectiveWindowMs === 500,
    `固定窗口基线：风暴 60 连发全程窗口恒 ${fixedResult.afterStorm.effectiveWindowMs}ms、空闲孤立信号仍等满 500ms（既慢又僵——升级动机）`,
  );
  ok(!('loadState' in fixedResult.afterIdle), '固定模式不产生三态读数（A/B 基线无新键）');

  // —— 旧行为基线 B：v1 缺省（突发收缩保留——缺省零漂移）——
  const v1 = new Sentinel({ ...baseConfig }, () => {});
  for (let i = 0; i < 6; i += 1) {
    v1.ingest({ type: 'error', description: `v1 突发 ${i}`, payload: {}, source: 'test', receivedAt: 1_700_000_000_000 + i * 10 });
  }
  const v1Window = v1.getStatus().effectiveWindowMs;
  v1.flush();
  ok(v1Window < 500, `v1 缺省行为原样保留：同类型 1 分钟 6 次 → 突发收缩至 ${v1Window}ms（未被 v2 改写——向后兼容）`);

  // —— 新行为：v2 三态强度驱动 ——
  const { state, clock } = syntheticClock();
  const v2 = new Sentinel({ ...baseConfig, clock, adaptiveWindow: {} }, () => {});
  const result = feedScenario(v2, state, state.now);
  v2.flush();
  ok(
    result.afterNormal.loadState === 'normal' && Math.abs(result.afterNormal.intensityPerSec - 12.5) < 0.01,
    `正常相：loadState=normal，强度估计 λ̂=${result.afterNormal.intensityPerSec.toFixed(2)}/s ≈ 12.5（80ms 间隔瞬时速率精确收敛）`,
  );
  ok(result.afterStorm.loadState === 'storm' && result.afterStorm.intensityPerSec > 150, `风暴相：loadState=storm（λ̂=${result.afterStorm.intensityPerSec.toFixed(1)}/s ≥ max(5, 基线 12.5×3)——200/s 五连跳即过阈）`);
  const w5 = result.stormTrajectory[4];
  const w30 = result.stormTrajectory[29];
  ok(w5 <= 200 && w30 <= 90, `风暴窗口收缩轨迹：第 5 个到达后 ${w5}ms → 第 30 个后 ${w30}ms（目标 63ms；固定窗恒 500ms——快速排空口径）`);
  ok(result.stormTrajectory.every((w) => w >= 50 && w <= 500), '窗口全程夹在 [minWindowMs, 配置窗] 内（无越界）');
  ok(
    result.afterIdle.loadState === 'idle' && result.afterIdle.effectiveWindowMs <= 64,
    `空闲相：2s 空隙后孤立信号即时收缩到 ${result.afterIdle.effectiveWindowMs}ms（idle 判定 gap≥1500ms——孤立信号无聚合收益可损失）`,
  );
  ok(
    result.recovery.every((w, i, a) => i === 0 || w >= a[i - 1]) && result.recovery[7] >= 400 && result.recovery[7] <= 500,
    `恢复正常相：窗口单调回升 ${result.recovery.join('→')}ms（EWMA 滞后数拍后回到 ~${result.recovery[7]}ms ≈ 配置 500ms，无过冲——抗振荡滞回）`,
  );
}

// ═══════════════════ ①-b 真实定时器 A/B：风暴与空闲时延统计 ═══════════════════

section('①-b 真实定时器 A/B：构造风暴（60 信号密集到达）与空闲孤立信号的滞留时延');

{
  const fixedBatches = [];
  const adaptBatches = [];
  const fixed = new Sentinel({ ...baseConfig, adaptiveWindow: false }, (b) => fixedBatches.push(b));
  const adapt = new Sentinel({ ...baseConfig, adaptiveWindow: {} }, (b) => adaptBatches.push(b));
  const feedBoth = async (count, gapMs, tag) => {
    for (let i = 0; i < count; i += 1) {
      fixed.ingest({ type: 'load', description: `${tag}-${i}`, payload: {}, source: 'bench', urgency: 0.5 });
      adapt.ingest({ type: 'load', description: `${tag}-${i}`, payload: {}, source: 'bench', urgency: 0.5 });
      if (gapMs > 0) await sleep(gapMs);
    }
  };
  const stat = (batches, tag) => {
    const res = [];
    let batchCount = 0;
    for (const b of batches) {
      const hits = b.signals.filter((s) => s.description.startsWith(`${tag}-`) || s.description === tag);
      if (hits.length > 0) batchCount += 1;
      for (const s of hits) res.push(b.aggregatedAt - s.receivedAt);
    }
    return { n: res.length, mean: res.reduce((a, x) => a + x, 0) / Math.max(1, res.length), max: Math.max(...res), batches: batchCount };
  };

  await feedBoth(24, 80, 'warm'); // 正常相 ~2s：两哨兵同条件建立基线
  await feedBoth(60, 5, 'storm'); // 风暴相：60 信号密集到达
  const stateAfterStorm = adapt.getStatus().loadState;
  await sleep(1200); // 排空
  const fixedStorm = stat(fixedBatches, 'storm');
  const adaptStorm = stat(adaptBatches, 'storm');

  ok(stateAfterStorm === 'storm', `风暴实时读数：getStatus().loadState==='storm'（风暴相末尾即时报）`);
  ok(fixedStorm.n === 60 && adaptStorm.n === 60, `无信号丢失：固定/自适应均交付全部 60 条风暴信号（${fixedStorm.n}/${adaptStorm.n}——哨兵不丢信号，「损失」口径为滞留时延与重复交付）`);
  ok(fixedStorm.mean > 150, `固定窗口风暴滞留：均值 ${fixedStorm.mean.toFixed(0)}ms（~半窗等待，峰值 ${fixedStorm.max.toFixed(0)}ms——基线）`);
  ok(adaptStorm.mean < 160 && adaptStorm.mean < fixedStorm.mean * 0.6, `自适应风暴滞留：均值 ${adaptStorm.mean.toFixed(0)}ms < 固定 ${fixedStorm.mean.toFixed(0)}ms × 0.6（窗口收缩 + 开窗中途重排——风暴快速排空）`);
  ok(adaptStorm.batches >= 3 && adaptStorm.batches >= fixedStorm.batches, `风暴切批：自适应 ${adaptStorm.batches} 批 ≥ 固定 ${fixedStorm.batches} 批（更细粒度更快进入决策链路）`);

  await sleep(2000); // 空闲（idleGap 1500ms）
  ok(adapt.getStatus().loadState === 'idle', '静默 2s → 实时三态读数 idle（无到达也可判——getStatus 口径）');
  fixed.ingest({ type: 'load', description: 'lone', payload: {}, source: 'bench', urgency: 0.5 });
  adapt.ingest({ type: 'load', description: 'lone', payload: {}, source: 'bench', urgency: 0.5 });
  await sleep(700);
  const fixedLone = stat(fixedBatches, 'lone');
  const adaptLone = stat(adaptBatches, 'lone');
  ok(fixedLone.max > 400, `固定窗口空闲滞留：孤立信号等满窗 ${fixedLone.max.toFixed(0)}ms（空闲期滞后——基线）`);
  ok(adaptLone.max < 180 && adaptLone.max < fixedLone.max / 2, `自适应空闲滞留：孤立信号 ${adaptLone.max.toFixed(0)}ms 交付 < 固定 ${fixedLone.max.toFixed(0)}ms / 2（空闲收缩到 ~63ms 窗）`);
}

// ═══════════════════ ①-c Hawkes 只读第二证据 ═══════════════════

section('①-c Hawkes 第二证据：速率口径不可达时，风暴判定来自 55.0 只读轮询');

{
  const { clock } = syntheticClock();
  const states = [];
  const sentinel = new Sentinel(
    { ...baseConfig, clock, adaptiveWindow: { hawkesPollMs: 0, minStormRatePerSec: 1e6 } }, // 速率阈值抬到不可达 → storm 只能来自 Hawkes
    () => {},
  );
  sentinel.attachHawkesBurstGuard({ windowSec: 900, minEvents: 8, burstShare: 0.25 });
  // 创世纪 55.0 验证流：稀疏基线（每 120s）+ 5 个紧密簇（簇内 1s ×8）——自激发到达
  const base = 1_700_000_000;
  const times = [];
  for (let t = 0; t <= 600; t += 120) times.push(t);
  for (let c = 0; c < 5; c += 1) {
    const start = 95 + c * 105;
    for (let i = 0; i < 8; i += 1) times.push(start + i);
  }
  times.sort((a, b) => a - b);
  const stream = times.filter((t, i) => i === 0 || t > times[i - 1]);
  stream.forEach((t, i) => {
    const s = sentinel.ingest({ type: 'hawkes-evidence', description: `event-${i}`, payload: {}, source: 'test', receivedAt: (base + t) * 1000 });
    states.push(s.enrichment?.loadState);
  });
  const view = sentinel.hawkesView();
  sentinel.flush();
  ok(view !== undefined && view.burst === true, `Hawkes 只读读数：激发份额 ${(view ? view.excitationShare * 100 : 0).toFixed(0)}% > 25% → burst=true（自激发风暴的数学口径）`);
  ok(states.includes('storm'), `第二证据生效：簇内到达被判 storm（到达间隔 ~1s → λ̂≈1/s ≪ 1e6 速率阈——该 storm 只可能来自 Hawkes 轮询）`);
}

// ═══════════════════ ② 紧急度衰减曲线 ═══════════════════

section('② 紧急度衰减：半衰期 10s 下的排序翻转与峰值合并（vs 旧行为）');

{
  const { state, clock } = syntheticClock();
  const newBatches = [];
  const decayed = new Sentinel({ ...baseConfig, clock, urgencyHalfLifeMs: 10_000 }, (b) => newBatches.push(b));
  decayed.ingest({ type: 'alert', description: '陈年高紧急度', payload: {}, source: 'test', urgency: 0.95, receivedAt: state.now });
  decayed.ingest({ type: 'alert', description: '陈年中紧急度', payload: {}, source: 'test', urgency: 0.3, receivedAt: state.now + 10_000 });
  decayed.ingest({ type: 'alert', description: '新鲜次紧急度', payload: {}, source: 'test', urgency: 0.6, receivedAt: state.now + 25_000 });
  state.now += 30_000;
  decayed.flush();
  const order = newBatches[0].signals.map((s) => s.description);
  const dOf = (desc) => newBatches[0].signals.find((x) => x.description === desc).decayedUrgency;
  ok(
    order.join(',') === '新鲜次紧急度,陈年高紧急度,陈年中紧急度',
    `衰减排序翻转：${order.join(' → ')}（新鲜 0.6 排到陈年 0.95 之前——年龄进入排序口径；旧行为为到达序，见 ⑦）`,
  );
  ok(
    near(dOf('陈年高紧急度'), 0.95 * 0.5 ** 3) && near(dOf('陈年中紧急度'), 0.3 * 0.5 ** 2) && near(dOf('新鲜次紧急度'), 0.6 * 0.5 ** 0.5),
    `衰减曲线实测：0.95×2⁻³=${(0.95 * 0.125).toFixed(5)} / 0.3×2⁻²=${(0.3 * 0.25).toFixed(5)} / 0.6×2⁻⁰·⁵=${(0.6 * Math.SQRT1_2).toFixed(5)}（半衰期指数口径，逐位符合）`,
  );
  const merged = decayed.ingest({ type: 'alert', description: '峰值探针', payload: {}, source: 'test', urgency: 0.2, receivedAt: state.now + 1000 });
  decayed.ingest({ type: 'alert', description: '峰值探针', payload: {}, source: 'test', urgency: 0.9, receivedAt: state.now + 1100 });
  ok(merged.occurrences === 2 && merged.urgency === 0.9, `新合并口径：0.2 后到 0.9 → 取峰值 ${merged.urgency}（occ=${merged.occurrences}，峰值不丢）`);

  // 旧行为对照（同场景、无半衰期）
  const old = new Sentinel({ ...baseConfig, clock }, () => {});
  const o1 = old.ingest({ type: 'alert', description: '峰值探针', payload: {}, source: 'test', urgency: 0.2, receivedAt: state.now + 1000 });
  const o2 = old.ingest({ type: 'alert', description: '峰值探针', payload: {}, source: 'test', urgency: 0.9, receivedAt: state.now + 1100 });
  ok(o2 === o1 && o1.urgency === 0.2, `旧行为对照：合并后 urgency 首见 ${o1.urgency}（后到的 0.9 峰值被丢弃——升级动机）`);
  decayed.flush();
  old.flush();
}

// ═══════════════════ ③ 入口背压（每源令牌桶） ═══════════════════

section('③ 入口背压：令牌桶逐位对照 oracle、溢出可观测、缺省不限流');

{
  const { state, clock } = syntheticClock();
  const bp = new Sentinel({ ...baseConfig, clock, backpressure: { default: { ratePerSec: 10, burst: 3 } } }, () => {});
  let t = state.now;
  let overflowSeen = 0;
  let admittedSeen = 0;
  for (let i = 0; i < 20; i += 1) {
    t += 10;
    const s = bp.ingest({ type: 'bp', description: `bp-${i}`, payload: {}, source: 'webhook:9', receivedAt: t });
    if (s.overflowed === true) overflowSeen += 1;
    else admittedSeen += 1;
  }
  // 脚本侧独立令牌桶模拟（oracle——同数学口径的独立实现，逐位对照）
  const simBucket = (n, stepMs, ratePerSec, burst) => {
    let tokens = burst;
    let admitted = 0;
    let overflowed = 0;
    for (let i = 0; i < n; i += 1) {
      if (i > 0) tokens = Math.min(burst, tokens + (stepMs / 1000) * ratePerSec);
      if (tokens >= 1) {
        tokens -= 1;
        admitted += 1;
      } else overflowed += 1;
    }
    return { admitted, overflowed };
  };
  const oracle = simBucket(20, 10, 10, 3);
  const view = bp.backpressureView();
  const src = view.bySource.find((x) => x.source === 'webhook:9');
  ok(
    src.admitted === oracle.admitted && src.overflowed === oracle.overflowed,
    `令牌桶逐位对照 oracle：接纳 ${src.admitted} / 溢出 ${src.overflowed}（独立模拟 ${oracle.admitted}/${oracle.overflowed}——10 令牌/s、桶容 3、20 信号@10ms）`,
  );
  ok(admittedSeen === oracle.admitted && overflowSeen === oracle.overflowed, `溢出标记一致：返回信号 overflowed=true 共 ${overflowSeen} 条（非静默——调用方可感知）`);
  ok(bp.getPendingSignals().length === oracle.admitted, `仅接纳信号进入聚合（pending ${bp.getPendingSignals().length} = 接纳数，溢出不被吞入批次也不丢失账目）`);
  ok(near(src.overflowRate, oracle.overflowed / 20, 1e-12) && near(view.overflowRate, oracle.overflowed / 20, 1e-12), `溢出率可观测：逐源/总体 ${(view.overflowRate * 100).toFixed(1)}%（introspect 口径）`);
  ok(view.configured === true && src.ratePerSec === 10 && src.burst === 3 && src.tokens >= 0, `桶参数透明：ratePerSec=${src.ratePerSec} burst=${src.burst} 余令牌 ${src.tokens}`);

  // 静默 5s → 桶回满
  t += 5000;
  let quietAdmitted = 0;
  let quietOverflow = 0;
  for (let i = 0; i < 4; i += 1) {
    const s = bp.ingest({ type: 'bp', description: `quiet-${i}`, payload: {}, source: 'webhook:9', receivedAt: t });
    if (s.overflowed === true) quietOverflow += 1;
    else quietAdmitted += 1;
  }
  ok(quietAdmitted === 3 && quietOverflow === 1, `静默 5s 桶回满：再突 4 条 → 接纳 3 / 溢出 1（同毫秒无补充——桶容量语义正确）`);

  // 逐源覆盖（未列源不限流 = 旧行为保留）
  const partial = new Sentinel({ ...baseConfig, clock, backpressure: { sources: { vip: { ratePerSec: 0.5, burst: 1 } } } }, () => {});
  for (let i = 0; i < 30; i += 1) partial.ingest({ type: 'bp', description: `other-${i}`, payload: {}, source: 'other', receivedAt: t + i });
  ok(partial.getPendingSignals().length === 30 && partial.backpressureView().bySource.length === 0, `未列源不限流（旧行为保留）：other 30 条全接纳、无桶产生`);
  for (let i = 0; i < 5; i += 1) partial.ingest({ type: 'bp', description: `vip-${i}`, payload: {}, source: 'vip', receivedAt: t + 100 + i });
  const vipView = partial.backpressureView().bySource.find((x) => x.source === 'vip');
  ok(vipView.admitted === 1 && vipView.overflowed === 4, `逐源覆盖生效：vip（0.5 令牌/s、桶容 1）5 连发 → 接纳 1 / 溢出 4（不同源独立限幅）`);
  bp.flush();
  partial.flush();

  // 缺省不限流（旧行为）
  const plain = new Sentinel({ ...baseConfig, clock }, () => {});
  for (let i = 0; i < 200; i += 1) plain.ingest({ type: 'bp', description: `plain-${i}`, payload: {}, source: 'flood', receivedAt: t + 200 + i });
  ok(plain.getPendingSignals().length === 200 && plain.backpressureView() === undefined, `缺省行为：200 条洪水全接纳、背压读数缺席（零漂移——限流是显式 opt-in）`);
  plain.flush();
}

// ═══════════════════ ④ 来源溯源链 ═══════════════════

section('④ 来源溯源链：链深解析 / 环切断 / 深链封顶 / 聚合保留最长链');

{
  const { state, clock } = syntheticClock();
  const batches = [];
  const s = new Sentinel({ ...baseConfig, clock }, (b) => batches.push(b));
  const a = s.ingest({ type: 'cascade', description: '根信号', payload: {}, source: 'decide', receivedAt: state.now, id: 'sig-a' });
  const b = s.ingest({ type: 'cascade', description: '一级级联', payload: {}, source: 'cascade', receivedAt: state.now + 1, id: 'sig-b', parentId: 'sig-a' });
  const c = s.ingest({ type: 'cascade', description: '二级级联', payload: {}, source: 'cascade', receivedAt: state.now + 2, id: 'sig-c', parentId: 'sig-b' });
  ok(a.provenanceDepth === 0 && b.provenanceDepth === 1 && c.provenanceDepth === 2, `链深解析：根 0 → 一级 1 → 二级 2（decide → cascade → cascade 的级联链）`);
  s.flush();
  ok(batches[0].maxProvenanceDepth === 2, `批次携带最长链深 maxProvenanceDepth=${batches[0].maxProvenanceDepth}（聚合交付可观测——级联深度进决策上下文）`);

  const k1 = s.ingest({ type: 'merge', description: '合并链探针', payload: {}, source: 't', receivedAt: state.now + 10, id: 'sig-k1', parentId: 'sig-a' });
  const k2 = s.ingest({ type: 'merge', description: '合并链探针', payload: {}, source: 't', receivedAt: state.now + 11, id: 'sig-k2', parentId: 'sig-c' });
  ok(k2 === k1 && k1.occurrences === 2 && k1.provenanceDepth === 3, `聚合保留最长链：同键合并（链深 1 与链深 3）→ 保留 ${k1.provenanceDepth}（最深证据不丢）`);
  s.flush();

  const self = s.ingest({ type: 'cascade', description: '自环', payload: {}, source: 't', receivedAt: state.now + 20, id: 'sig-self', parentId: 'sig-self' });
  ok(self.parentId === undefined && self.provenanceDepth === 0, '自环切断：parentId=自身 → 链切断按根处理（无限级联被阻断）');
  s.ingest({ type: 'cascade', description: '环 y', payload: {}, source: 't', receivedAt: state.now + 21, id: 'sig-y', parentId: 'sig-x' });
  const x = s.ingest({ type: 'cascade', description: '环 x', payload: {}, source: 't', receivedAt: state.now + 22, id: 'sig-x', parentId: 'sig-y' });
  ok(x.parentId === undefined && x.provenanceDepth === 0, '互指环切断：x→y→x → 注册表上溯回到自身即断链');
  const st1 = s.getStatus();
  ok(st1.provenanceCycles === 2, `环检测计数 ${st1.provenanceCycles}（自环 1 + 互指环 1——可观测口径）`);

  for (let i = 0; i <= 40; i += 1) {
    s.ingest({
      type: 'cascade',
      description: `深链 ${i}`,
      payload: {},
      source: 't',
      receivedAt: state.now + 30 + i,
      id: `sig-deep-${i}`,
      parentId: i === 0 ? 'sig-c' : `sig-deep-${i - 1}`,
    });
  }
  const st2 = s.getStatus();
  ok(
    st2.maxProvenanceDepth === 32 && st2.provenanceTruncations === 11,
    `深链封顶：41 级链（自深 2 起算）→ maxProvenanceDepth=${st2.maxProvenanceDepth}（硬顶 32）、截断 ${st2.provenanceTruncations} 次（链深 33..43 各截一次——无限级联被硬顶）`,
  );
  s.flush();
}

// ═══════════════════ ⑤ 近重复去重升级 ═══════════════════

section('⑤ 近重复去重：1−NCD 比较器注入（缺省精确哈希行为不变）');

{
  const near1a = '数据库连接超时: users 表查询失败，已重试 3 次仍无法建立连接';
  const near1b = '数据库连接超时: users 表查询失败，已重试 4 次仍无法建立连接';
  const far1 = '磁盘使用率达到 92%: /data 分区即将写满';
  const far2 = '新模型 model-x 注册成功，初始能力画像已建立';
  const sim = (a, b) => 1 - ncd(a.description, b.description);
  console.log(`    NCD 相似度实测：近重复对 ${sim({ description: near1a }, { description: near1b }).toFixed(3)} / 无关对 ${sim({ description: near1a }, { description: far1 }).toFixed(3)}（合并阈 0.30——分离度充足）`);

  // 旧行为（缺省）：精确哈希
  const old = new Sentinel({ ...baseConfig }, () => {});
  for (const [i, d] of [near1a, far1, near1b, far2].entries()) {
    old.ingest({ type: 'error-detected', description: d, payload: {}, source: 'webhook:1', urgency: 0.5, receivedAt: 1_700_000_000_000 + i * 1000 });
  }
  ok(old.getPendingSignals().length === 4 && old.getStatus().nearDuplicateMerges === 0, `旧行为：4 条互异描述 → 4 条独立信号（精确哈希——「重试3次/重试4次」各自成条，同一故障被决策两次）`);
  old.flush();

  // 新行为：比较器注入
  const nd = new Sentinel({ ...baseConfig, nearDuplicate: { similarity: sim, threshold: 0.3 } }, () => {});
  const m1 = nd.ingest({ type: 'error-detected', description: near1a, payload: {}, source: 'webhook:1', urgency: 0.5, receivedAt: 1_700_000_000_000 });
  nd.ingest({ type: 'error-detected', description: far1, payload: {}, source: 'webhook:1', urgency: 0.5, receivedAt: 1_700_000_001_000 });
  const m2 = nd.ingest({ type: 'error-detected', description: near1b, payload: {}, source: 'webhook:1', urgency: 0.7, receivedAt: 1_700_000_002_000 });
  nd.ingest({ type: 'error-detected', description: far2, payload: {}, source: 'webhook:1', urgency: 0.5, receivedAt: 1_700_000_003_000 });
  const pending = nd.getPendingSignals();
  ok(pending.length === 3 && m2 === m1 && m1.occurrences === 2, `近重复合并：${pending.length} 条（near1b 越过中间的 far1 回溯命中 near1a，occ=${m1.occurrences}——缺省下是 4 条）`);
  ok(nd.getStatus().nearDuplicateMerges === 1, 'nearDuplicateMerges 计数可观测 = 1');
  ok(!pending.some((p) => p.description === near1b) && m1.payload.mergedCount === 2, '合并保留首见描述，载荷携带 mergedCount=2（审计口径）');

  // 与 ② 组合：近重复合并 + 峰值紧急度
  const nd2 = new Sentinel({ ...baseConfig, urgencyHalfLifeMs: 10_000, nearDuplicate: { similarity: sim, threshold: 0.3 } }, () => {});
  const p1 = nd2.ingest({ type: 'error-detected', description: near1a, payload: {}, source: 'webhook:1', urgency: 0.2, receivedAt: 1_700_000_000_000 });
  nd2.ingest({ type: 'error-detected', description: near1b, payload: {}, source: 'webhook:1', urgency: 0.9, receivedAt: 1_700_000_000_500 });
  ok(p1.urgency === 0.9, `组合特性：近重复合并取峰值紧急度 ${p1.urgency}（0.2 ↑ 0.9，与 ② 峰值口径一致）`);
  nd.flush();
  nd2.flush();
}

// ═══════════════════ ⑥ 信号指纹统计 ═══════════════════

section('⑥ 指纹统计：源×类型×指纹滚动统计（供 76.0 新奇检测消费）');

{
  const { state, clock } = syntheticClock();
  const s = new Sentinel({ ...baseConfig, clock }, () => {});
  ok(s.fingerprintStats() === undefined, '未挂载 → 指纹统计 undefined（诚实降级）');
  s.attachFingerprintTracker({ windowMs: 60_000, maxKeys: 4, perKeyWindow: 64 });
  let t = state.now;
  for (let i = 0; i < 5; i += 1) {
    t += 10_000;
    s.ingest({ type: 'polling-change', description: '轮询目标内容变化: https://x', payload: {}, source: 'poll:x', receivedAt: t });
  }
  let stats = s.fingerprintStats();
  const hot = stats.find((e) => e.source === 'poll:x');
  ok(stats.length === 1 && hot.count === 5 && hot.windowCount === 5, `热指纹：count=${hot.count} / 窗口内 ${hot.windowCount}（源×类型×指纹三维键——同内容 5 次到达归一键）`);
  ok(near(hot.meanIntervalMs, 10_000) && hot.firstSeenAt < hot.lastSeenAt, `间隔 EMA=${hot.meanIntervalMs}ms（10s 等间隔精确收敛；firstSeen<lastSeen 生命周期在案）`);
  t += 200_000; // 超出 windowMs=60s
  s.ingest({ type: 'polling-change', description: '轮询目标内容变化: https://x', payload: {}, source: 'poll:x', receivedAt: t });
  stats = s.fingerprintStats();
  const hot2 = stats.find((e) => e.source === 'poll:x');
  ok(hot2.windowCount === 1 && hot2.count === 6, `滚动窗滑出：200s 静默后旧时间戳全部出窗（windowCount 5→1、count 累计 6——两层口径分明）`);
  ok(hot2.meanIntervalMs > 10_000, `间隔 EMA 融入突变：${hot2.meanIntervalMs.toFixed(0)}ms（到达模式突变可侦——76.0「没见过」的先验证据源）`);
  for (const d of ['B 目标', 'C 目标', 'D 目标', 'E 目标']) {
    t += 1_000;
    s.ingest({ type: 'polling-change', description: `轮询目标内容变化: ${d}`, payload: {}, source: 'poll:other', receivedAt: t });
  }
  stats = s.fingerprintStats();
  ok(stats.length === 4 && !stats.some((e) => e.source === 'poll:x'), `LRU 淘汰：第 5 键插入 → 最久未更新键被淘汰，余 ${stats.length} 键（maxKeys 容量硬顶——内存有界）`);
  ok(new Set(stats.map((e) => e.fingerprint)).size === 4 && stats.every((e) => /^[0-9a-f]{8}$/.test(e.fingerprint)), '存活 4 键指纹互异且为 FNV-1a 32 位十六进制（内容判别力）');
  s.flush();
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— Sentinel 第三轮六项升级新旧行为对照验证成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
