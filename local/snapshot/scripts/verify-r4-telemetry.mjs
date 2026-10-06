/**
 * verify-r4-telemetry.mjs — 第四轮模块域 R4-A18「遥测审计总线」二期深化验证
 * （src/telemetry/ 四文件：event-bus.ts / metrics.ts / audit-log.ts / trace.ts）
 *
 * 五项升级各配「旧行为 vs 新行为」的构造对照与逐位数字锚点：
 *
 *   S1 滑动窗口聚合（metrics.ts SlidingWindowAggregator）：桶 100ms × 窗
 *      300ms 的事件流（50/150/250 三桶）——窗口内 sum=60/avg=20/rate=0.01
 *      逐位；时钟推进 420（b0 出窗）→ sum 50、过期桶 1；推进 700 → sum 0
 *      （旧口径全量累计 sum 恒增不回落 60→60→60 vs 新口径滑窗 60→50→0，
 *      过期数据不残留）；陈旧样本（at=50 早于窗起点 400）丢弃计数；
 *      windowMs 非 bucketMs 整数倍 / 非法入参显式拒绝；同序列重放逐位一致。
 *   S2 确定性按率采样器（event-bus.ts DeterministicRateSampler）：rate=0.1
 *      ×1000 → kept 恰 100（整数 Bresenham ⌊n·rate⌋ 精确可证）、估计器
 *      100/0.1=1000 逐位还原；rate=0.3 ×57 → kept=17、|17/0.3−57|=0.333
 *      < 1/rate=3.333（误差有界）；rate 非法值拒绝。
 *   S3 采样策略（event-bus.ts SamplingController）：分层流 205 高频
 *      （头部 5 全留 + 尾部 200 按 0.1 → 20）+ 7 错误（必达全留 7——若按
 *      尾率只有 ⌊7×0.1⌋=0）+ 3 规则全留 + 2 缺省 → kept 37/dropped 180；
 *      分层估计 Ñ=7+205+3+2=217 还原真实 217（误差 < 界 10）；自定义
 *      errorMatcher（payload.fail）生效；非法规则/率拒绝。
 *   S4 总线采样集成 + 双门限缓冲保留（event-bus.ts）：采样总线 100 高频
 *      +1 错误 → 缓冲 11 条（旧口径 101 条，缓冲占用 −89%）；丢弃信封
 *      sampled:false 不占 seq → detectBufferGaps 仍为空（无幻影缺口）；
 *      订阅者只收 11 条；估计器 100+1=101 还原；时长保留 maxAge=100：
 *      0/120/260 三发 → 旧条目过期裁剪计数 1→2、buffer 长度有界 1；
 *      容量+时长双门限并存各自计数；缺省总线 stats 三新计数恒 0、信封
 *      无 sampled 键（零漂移）。
 *   S5 Prometheus 文本导出（metrics.ts prometheusExposition/toPrometheus）：
 *      counter/gauge/histogram 三类指标集导出与手工模板逐行逐位全等
 *      （# HELP/# TYPE、'.'→'_' 名映射、标签 {k="v"}、histogram 的
 *      _bucket{le=…}/_sum/_count、le 末位、序列键升序）；标签值转义
 *      （\、"、换行）；空注册表导出空串；两次导出逐位一致。
 *   S6 审计账保留策略（audit-log.ts）：容量门限 5 × 12 条追加流 → size
 *      恒 5（旧口径 size=12 无界）、裁剪 7 条/7 次操作可观测；链头锚
 *      anchorHash=第 7 条 hash、剩余链 verify() 仍 valid（裁剪与链完整性
 *      共存）；导出附 anchorHash、parseExport 往返 verifyChain(entries,
 *      anchor) 闭合；篡改保留条目仍被定位（mismatch:'hash'）；时长门限
 *      50ms（ts<now−50 裁）与双门限并用各账逐位；缺省账导出无 anchorHash
 *      键（零漂移）。
 *   S7 跟踪跨度尾部采样（trace.ts）：错误 span 全留（error 标签）、慢
 *      span（70ms ≥ 50ms）全留、正常 4 条按 0.5 → 留 2 丢 2（Bresenham
 *      均衡：丢/留/丢/留）；估计器 Ñ=1+1+2/0.5=6 还原真实 6（界 2）；
 *      被丢 span 从树移除、其错误子 span 上提挂根（保 begin 序）；LIFO
 *      栈守卫不受采样影响；重复关闭被丢 id 报未知；缺省 tracer 无采样
 *      面（零漂移）。
 *   S8 源码级 + 缺省零漂移总检：四文件无 Date.now(/Math.random(/node:
 *      import/require；新导出面在册；缺省路径旧断言复验（容量环形守恒、
 *      counts 口径、audit verify 创世锚）逐位保持。
 *
 * 确定性：全程注入时钟、无随机源；tsc --ignoreConfig --strict 实编译四文件
 * （编译失败即 FAIL）后从产物导入运行。
 * 运行：node scripts/verify-r4-telemetry.mjs（自包含，不依赖 dist 接线状态）
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ─────────────────────────── 断言工具（仓库惯例：ok/near/section） ───────────────────────────
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
function throws(fn, label, match) {
  try {
    fn();
    failed += 1;
    console.error(`  ✗ ${label}（未抛错）`);
    return;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (match === undefined || match.test(text)) {
      passed += 1;
      console.log(`  ✓ ${label}（抛：${text.slice(0, 60)}）`);
    } else {
      failed += 1;
      console.error(`  ✗ ${label}（抛错文案不匹配 /${match.source}/：${text.slice(0, 80)}）`);
    }
  }
}
function section(title) {
  console.log(`\n■ ${title}`);
}
const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC_DIR = path.join(REPO, 'src', 'telemetry');
const BUILD_DIR = path.join(REPO, '.tmp-verify-r4-telemetry');
const FILES = ['event-bus.ts', 'metrics.ts', 'audit-log.ts', 'trace.ts'];

// ═══════════════════ S0 实编译产物（strict；失败即 FAIL） ═══════════════════

const tscBin = path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
const build = spawnSync(
  process.execPath,
  [
    tscBin, '--ignoreConfig', '--strict', '--target', 'ES2022',
    '--module', 'nodenext', '--moduleResolution', 'nodenext',
    '--outDir', BUILD_DIR, ...FILES.map((f) => path.join(SRC_DIR, f)),
  ],
  { encoding: 'utf8' },
);

try {
  if (build.status !== 0) {
    console.error(`✗ tsc --ignoreConfig --strict 编译 src/telemetry 四文件失败（exit=${build.status}）：\n${build.stdout}\n${build.stderr}`);
    process.exit(1);
  }
  console.log(`■ S0 编译：tsc --ignoreConfig --strict → 四文件 0 错误（产物 ${BUILD_DIR}）`);

  const eb = await import(pathToFileURL(path.join(BUILD_DIR, 'event-bus.js')).href);
  const mt = await import(pathToFileURL(path.join(BUILD_DIR, 'metrics.js')).href);
  const al = await import(pathToFileURL(path.join(BUILD_DIR, 'audit-log.js')).href);
  const tr = await import(pathToFileURL(path.join(BUILD_DIR, 'trace.js')).href);
  const { TelemetryBus, createManualClock, DeterministicRateSampler, SamplingController } = eb;
  const { MetricsRegistry, SlidingWindowAggregator, prometheusExposition } = mt;
  const { AuditLog, AUDIT_GENESIS_HASH } = al;
  const { Tracer } = tr;

  // ═══════════════════ S1 滑动窗口聚合（metrics.ts） ═══════════════════

  section('S1-1 窗口内聚合：桶滚动 + sum/avg/rate 逐位');

  {
    const clock = createManualClock(0);
    const win = new SlidingWindowAggregator({ windowMs: 300, bucketMs: 100, clock });
    win.observe(10, 50);  // 桶 [0,100)
    win.observe(20, 150); // 桶 [100,200)
    win.observe(30, 250); // 桶 [200,300)
    clock.set(280);       // 窗口 [-20,280)：三桶全在窗
    const s = win.stats();
    ok(s.count === 3 && s.sum === 60 && s.avg === 20 && s.min === 10 && s.max === 30,
      `窗口内 count/sum/avg/min/max = 3/60/20/10/30（实测 ${s.count}/${s.sum}/${s.avg}/${s.min}/${s.max}）`);
    ok(near(s.ratePerMs, 0.01) && near(s.sumPerMs, 0.2),
      `ratePerMs=count/windowMs=3/300=0.01、sumPerMs=60/300=0.2（实测 ${s.ratePerMs}/${s.sumPerMs}）`);
    ok(s.bucketCount === 3 && s.buckets.length === 3 && s.buckets[0].startMs === 0 && s.buckets[2].startMs === 200,
      `逐桶读数按 startMs 升序 [0,100,200]（实测 [${s.buckets.map((b) => b.startMs).join(',')}]）`);
    ok(s.buckets[0].count === 1 && s.buckets[0].sum === 10 && s.buckets[0].firstMs === 50 && s.buckets[0].lastMs === 50,
      '首桶读数 {count:1,sum:10,first/last:50} 逐位');
    ok(s.oldestSampleMs === 50 && s.newestSampleMs === 250 && s.expiredBuckets === 0 && s.staleDiscarded === 0,
      '最老/最新样本时刻 50/250；过期与陈旧计数为 0');
  }

  section('S1-2 窗口滑动：过期桶移除、数据不残留（旧 vs 新对照）');

  {
    const clock = createManualClock(0);
    const win = new SlidingWindowAggregator({ windowMs: 300, bucketMs: 100, clock });
    win.observe(10, 50);
    win.observe(20, 150);
    win.observe(30, 250);
    clock.set(280);
    const sum280 = win.stats().sum; // 60
    clock.set(420); // 窗口 [120,420)：桶0 [0,100) 整体出窗（0+100 ≤ 120）
    const s420 = win.stats();
    ok(sum280 === 60 && s420.sum === 50 && s420.count === 2 && s420.expiredBuckets === 1,
      `滑动一步：sum 60→50（桶0 过期移除 1 个，count 3→2）——旧口径全量累计 sum 恒为 60 不回落 vs 新口径 ${sum280}→${s420.sum}`);
    ok(s420.avg === 25 && s420.buckets[0].startMs === 100, '窗口内均值随窗重算 25，剩余桶从 [100,200) 起');
    clock.set(700); // 窗口 [400,700)：桶1、桶2 均整体出窗
    const s700 = win.stats();
    ok(s700.count === 0 && s700.sum === 0 && s700.avg === 0 && s700.buckets.length === 0 && s700.expiredBuckets === 3,
      `滑出全窗：count/sum/avg 全 0（累计过期桶 3）——过期数据不残留（旧口径 sum 仍 60）`);
    ok(s700.oldestSampleMs === undefined && s700.newestSampleMs === undefined, '空窗口无最老/最新样本时刻（undefined）');
    // 陈旧样本：at=50 早于窗起点 400 → 丢弃并计数
    win.observe(99, 50);
    const sStale = win.stats();
    ok(sStale.count === 0 && sStale.staleDiscarded === 1 && sStale.observedTotal === 4,
      '陈旧样本（at=50 < now−windowMs=400）不入桶：staleDiscarded=1 / observedTotal=4');
    // 新样本落新桶
    win.observe(5, 650);
    const sNew = win.stats();
    ok(sNew.count === 1 && sNew.sum === 5 && sNew.buckets[0].startMs === 600, '新样本落桶 [600,700)：count=1/sum=5/startMs=600');
    // 确定性重放：同序列重建逐位一致
    const clock2 = createManualClock(0);
    const win2 = new SlidingWindowAggregator({ windowMs: 300, bucketMs: 100, clock: clock2 });
    win2.observe(10, 50);
    win2.observe(20, 150);
    win2.observe(30, 250);
    clock2.set(700);
    ok(JSON.stringify(win2.stats()) === JSON.stringify(s700),
      '同一时钟与 observe 序列重放：stats JSON 逐位全等（确定性）');
  }

  section('S1-3 gauge 读数流 + 入参校验');

  {
    const clock = createManualClock(1000);
    const gaugeWin = new SlidingWindowAggregator({ windowMs: 1000, bucketMs: 500, clock });
    gaugeWin.observe(4, 1200); // gauge 读数流：窗口内均值口径
    gaugeWin.observe(6, 1300);
    const gs = gaugeWin.stats();
    ok(gs.count === 2 && gs.sum === 10 && gs.avg === 5, `gauge 读数窗口聚合：sum=10/avg=5（实测 ${gs.sum}/${gs.avg}）`);
    throws(() => new SlidingWindowAggregator({ windowMs: 300, bucketMs: 100, clock }).observe(Number.NaN),
      'observe 非有限值拒绝', /有限/);
    throws(() => new SlidingWindowAggregator({ windowMs: 300, bucketMs: 100, clock }).observe(1, Number.POSITIVE_INFINITY),
      'observe 非有限 at 拒绝', /有限/);
    throws(() => new SlidingWindowAggregator({ windowMs: 250, bucketMs: 100 }), 'windowMs 非 bucketMs 整数倍拒绝', /整数倍/);
    throws(() => new SlidingWindowAggregator({ windowMs: 0, bucketMs: 100 }), 'windowMs=0 拒绝', /windowMs/);
    throws(() => new SlidingWindowAggregator({ windowMs: 100, bucketMs: 0 }), 'bucketMs=0 拒绝', /bucketMs/);
    throws(() => new SlidingWindowAggregator({ windowMs: 100.5, bucketMs: 100 }), 'windowMs 非整数拒绝', /windowMs/);
  }

  // ═══════════════════ S2 确定性按率采样器（event-bus.ts） ═══════════════════

  section('S2 确定性按率采样器：Bresenham 精确计数 + 估计器还原');

  {
    const sampler = new DeterministicRateSampler(0.1);
    for (let i = 0; i < 1000; i += 1) sampler.decide();
    const st = sampler.stats();
    ok(near(st.rate, 0.1) && st.seen === 1000 && st.kept === 100,
      `rate=0.1 ×1000 → kept 恰 ⌊1000×0.1⌋=100（整数 Bresenham 精确，实测 kept=${st.kept}/seen=${st.seen}）`);
    ok(sampler.estimateTotal() === 1000, `估计器 100/0.1 = 1000 逐位还原（实测 ${sampler.estimateTotal()}）`);
    const s03 = new DeterministicRateSampler(0.3);
    for (let i = 0; i < 57; i += 1) s03.decide();
    const est03 = s03.estimateTotal();
    ok(s03.stats().kept === 17 && Math.abs(est03 - 57) < 1 / 0.3,
      `rate=0.3 ×57 → kept=17、|17/0.3−57|=${Math.abs(est03 - 57).toFixed(4)} < 1/rate=${(1 / 0.3).toFixed(4)}（误差有界）`);
    const s05 = new DeterministicRateSampler(0.5);
    let kept5 = 0;
    for (let i = 0; i < 10; i += 1) if (s05.decide()) kept5 += 1;
    ok(kept5 === 5, `rate=0.5 前 10 次 → 交替保留恰 5 条（均衡分布，实测 ${kept5}）`);
    throws(() => new DeterministicRateSampler(0), 'rate=0 拒绝', /rate/);
    throws(() => new DeterministicRateSampler(1.5), 'rate>1 拒绝', /rate/);
    throws(() => new DeterministicRateSampler(Number.NaN), 'rate=NaN 拒绝', /rate/);
  }

  // ═══════════════════ S3 采样策略：头部全留 + 尾部按率 + 错误必达（event-bus.ts） ═══════════════════

  section('S3-1 分层决策：头部/尾部/错误必达（高频+错误混合流）');

  {
    const ctrl = new SamplingController({
      rules: [
        { pattern: 'hf.tick', headKeep: 5, rate: 0.1 },
        { pattern: 'hf.*', rate: 0.1 },
        { pattern: 'job.*', rate: 1 },
      ],
    });
    for (let i = 0; i < 205; i += 1) ctrl.decide({ type: 'hf.tick', source: 'bench', payload: i, isFinal: false });
    for (let i = 0; i < 7; i += 1) ctrl.decide({ type: 'hf.error', source: 'bench', payload: { code: 'E1' }, isFinal: false });
    for (let i = 0; i < 3; i += 1) ctrl.decide({ type: 'job.step', source: 'exec', payload: i, isFinal: false });
    for (let i = 0; i < 2; i += 1) ctrl.decide({ type: 'other.normal', source: 'misc', payload: i, isFinal: false });
    const types = ctrl.typeStats();
    const tick = types.find((t) => t.type === 'hf.tick');
    ok(tick.matchedPattern === 'hf.tick' && tick.headKept === 5 && tick.tailSeen === 200 && tick.tailKept === 20 && tick.kept === 25,
      `高频流：头部 5 全留 + 尾部 200 按 0.1 → 留 20，合计 25（实测 head=${tick.headKept}/tailKept=${tick.tailKept}/kept=${tick.kept}）`);
    ok(near(tick.estimatedTotal, 205, 1e-9),
      `分层估计 Ñ=5+20/0.1=205 还原真实 205（实测 ${tick.estimatedTotal}，误差 < 界 1/0.1=10）`);
    const err = types.find((t) => t.type === 'hf.error');
    ok(err.seen === 7 && err.errorKept === 7 && err.kept === 7 && err.rate === 0.1,
      `错误必达：hf.error 7 条全留（errorKept=7）——若按尾率只留 ⌊7×0.1⌋=0 条（旧口径无错误优先 → 0 vs 新口径 7）`);
    ok(types[0].type === 'hf.error' && types.map((t) => t.type).join(',') === 'hf.error,hf.tick,job.step,other.normal',
      '分类型计数按类型名升序（确定性）');
    const other = types.find((t) => t.type === 'other.normal');
    ok(other.matchedPattern === '(default)' && other.kept === 2, '未命中规则的类型走缺省率 1（全留），matchedPattern=(default)');
    const sum = ctrl.summary();
    ok(sum.seen === 217 && sum.kept === 37 && sum.dropped === 180 && near(sum.estimatedTotal, 217, 1e-9) && sum.trueSeen === 217,
      `总览：217 决策 / 37 保留 / 180 丢弃；估计总数 217 还原真实 217（实测 Ñ=${sum.estimatedTotal}）`);
    ok(Math.abs(sum.estimatedTotal - sum.trueSeen) <= sum.estimateErrorBound && near(sum.estimateErrorBound, 10, 1e-9),
      `估计误差有界：|Ñ−真实| ≤ 界 = Σ1/rate = 10（实测界 ${sum.estimateErrorBound}）`);
  }

  section('S3-2 自定义 errorMatcher + 入参校验');

  {
    const ctrl = new SamplingController({
      rules: [{ pattern: 'job.*', rate: 0.5 }],
      errorMatcher: (c) => c.payload !== null && typeof c.payload === 'object' && c.payload.fail === true,
    });
    ctrl.decide({ type: 'job.step', source: 'x', payload: { fail: false }, isFinal: false });
    ctrl.decide({ type: 'job.step', source: 'x', payload: { fail: false }, isFinal: false });
    ctrl.decide({ type: 'job.step', source: 'x', payload: { fail: true }, isFinal: false });
    const st = ctrl.typeStats()[0];
    ok(st.seen === 3 && st.kept === 2 && st.errorKept === 1 && st.tailSeen === 2 && st.tailKept === 1,
      `自定义 errorMatcher（payload.fail）：错误 1 条必留 + 正常 2 条按 0.5 留 1（实测 kept=${st.kept}）`);
    ok(near(st.estimatedTotal, 3, 1e-9), `估计 Ñ=1+1/0.5=3 还原真实 3（实测 ${st.estimatedTotal}）`);
    throws(() => new SamplingController({ rules: [{ pattern: 'bad*.x' }] }), '规则段内半通配拒绝', /独占一段/);
    throws(() => new SamplingController({ rules: [{ pattern: 'a.b', rate: 0 }] }), '规则 rate=0 拒绝', /rate/);
    throws(() => new SamplingController({ rules: [{ pattern: 'a.b', headKeep: -1 }] }), '规则 headKeep=-1 拒绝', /headKeep/);
    throws(() => new SamplingController({ defaultRate: 2 }), 'defaultRate=2 拒绝', /defaultRate/);
  }

  // ═══════════════════ S4 总线采样集成 + 双门限缓冲保留（event-bus.ts） ═══════════════════

  section('S4-1 总线采样集成：丢弃不占 seq、订阅只收保留、估计器还原');

  {
    const bus = new TelemetryBus({
      sampling: { rules: [{ pattern: 'hf.*', rate: 0.1 }], defaultRate: 1 },
    });
    const sub = bus.subscribe('hf.*', { maxQueue: 200 });
    let firstEnv;
    for (let i = 0; i < 100; i += 1) {
      const env = bus.publish('hf.tick', 'bench', i);
      if (i === 0) firstEnv = env;
    }
    const errEnv = bus.publish('hf.error', 'bench', { code: 'E2' });
    const stats = bus.stats();
    ok(stats.publishedTotal === 101 && stats.samplingKept === 11 && stats.samplingDropped === 90,
      `采样计数：101 发布 → 保留 11（100×0.1=10 高频 + 1 错误）/ 丢弃 90（旧口径 101 条全入缓冲 vs 新 11 条，−89%）`);
    ok(stats.lastSeq === 11 && bus.buffer().length === 11, '只有保留事件占 seq（lastSeq=11）与缓冲（长度 11）');
    ok(firstEnv.sampled === false && firstEnv.seq === 0, '首个丢弃信封 sampled:false 且不占 seq（seq=当时 lastSeq=0）');
    ok(errEnv.sampled === true && errEnv.seq === 11, '错误信封必达：sampled:true、占 seq=11');
    ok(bus.detectBufferGaps().length === 0, '丢弃不产生幻影缺口：保留 seq 1..11 连续，detectBufferGaps 为空');
    const taken = sub.take();
    ok(taken.length === 11 && taken[10].type === 'hf.error', `订阅者只收 11 条保留事件（实测 ${taken.length}，尾条=hf.error）`);
    const sum = bus.samplingSummary();
    ok(near(sum.estimatedTotal, 101, 1e-9) && sum.trueSeen === 101,
      `总线估计器：Ñ=10/0.1+1=101 还原真实 101（实测 ${sum.estimatedTotal}）`);
    ok(bus.samplingTypeStats().length === 2, 'samplingTypeStats 分两类计数（hf.tick / hf.error）');
  }

  section('S4-2 缓冲双门限保留：时长裁剪 + 容量弃旧并存（可观测）');

  {
    const clock = createManualClock(0);
    const bus = new TelemetryBus({ clock, bufferCapacity: 100, bufferMaxAgeMs: 100 });
    bus.publish('ev.tick', 's', 1);      // ts=0
    clock.set(120);
    bus.publish('ev.tick', 's', 2);      // 裁 ts<20 → ts0 过期 1
    clock.set(260);
    bus.publish('ev.tick', 's', 3);      // 裁 ts<160 → ts120 过期 1
    let stats = bus.stats();
    ok(stats.bufferExpiredCount === 2 && stats.bufferDropCount === 0 && bus.buffer().length === 1 && bus.buffer()[0].ts === 260,
      `时长门限：ts0/ts120 相继过期（bufferExpiredCount=2），缓冲只剩最新 1 条（旧口径 3 条全滞留）`);
    clock.set(400);
    const pruned = bus.pruneBuffer();
    stats = bus.stats();
    ok(pruned === 1 && stats.bufferExpiredCount === 3 && bus.buffer().length === 0,
      `显式 pruneBuffer()：时钟 400 → ts260 过期（本次 1 条，累计 3），缓冲清空`);
    // 容量 + 时长双门限并存：各自独立计数
    const clock2 = createManualClock(0);
    const bus2 = new TelemetryBus({ clock: clock2, bufferCapacity: 2, bufferMaxAgeMs: 100 });
    bus2.publish('a.t', 's', 1); // ts=0
    clock2.set(50);
    bus2.publish('a.t', 's', 2); // ts=50
    clock2.set(60);
    bus2.publish('a.t', 's', 3); // ts=60 → 容量满弃 ts0（drop=1）
    clock2.set(200);
    bus2.publish('a.t', 's', 4); // ts=200 → 时长裁 ts<100：ts50、ts60（expired=2）
    const s2 = bus2.stats();
    ok(s2.bufferDropCount === 1 && s2.bufferExpiredCount === 2 && bus2.buffer().length === 1 && bus2.buffer()[0].ts === 200,
      `双门限并存：容量弃旧 1 + 时长裁剪 2 各自计数，最终缓冲 1 条（ts=200）`);
    // 缺省零漂移：未启用新选项的总线三新计数恒 0、信封无 sampled 键
    const plain = new TelemetryBus();
    const env = plain.publish('p.q', 's', 1);
    const ps = plain.stats();
    ok(ps.bufferExpiredCount === 0 && ps.samplingKept === 0 && ps.samplingDropped === 0 && !('sampled' in env),
      '缺省总线零漂移：bufferExpiredCount/samplingKept/samplingDropped 恒 0，信封无 sampled 键');
    throws(() => new TelemetryBus({ bufferMaxAgeMs: 0 }), 'bufferMaxAgeMs=0 拒绝', /bufferMaxAgeMs/);
    throws(() => new TelemetryBus({ bufferMaxAgeMs: -5 }), 'bufferMaxAgeMs=-5 拒绝', /bufferMaxAgeMs/);
    throws(() => new TelemetryBus({ sampling: { rules: [{ pattern: 'x*', rate: 0.5 }] } }), '总线采样规则半通配段拒绝', /独占一段/);
  }

  // ═══════════════════ S5 Prometheus 文本导出（metrics.ts） ═══════════════════

  section('S5 Prometheus 文本导出：与手工模板逐行对照');

  {
    const reg = new MetricsRegistry();
    const c = reg.counter('dsh.requests', { help: 'Total requests' });
    c.inc();
    c.inc({ route: '/a' });
    c.add(5, { route: '/a' });
    const g = reg.gauge('dsh.gauge');
    g.set(10);
    g.inc(-2);
    const h = reg.histogram('dsh.latency', { buckets: [10, 100], help: 'Request latency' });
    for (const v of [5, 5, 5, 50]) h.observe(v);
    const template = [
      '# HELP dsh_gauge dsh.gauge (gauge)',
      '# TYPE dsh_gauge gauge',
      'dsh_gauge 8',
      '# HELP dsh_latency Request latency',
      '# TYPE dsh_latency histogram',
      'dsh_latency_bucket{le="10"} 3',
      'dsh_latency_bucket{le="100"} 4',
      'dsh_latency_bucket{le="+Inf"} 4',
      'dsh_latency_sum 65',
      'dsh_latency_count 4',
      '# HELP dsh_requests Total requests',
      '# TYPE dsh_requests counter',
      'dsh_requests 1',
      'dsh_requests{route="/a"} 6',
      '',
    ].join('\n');
    const text = reg.toPrometheus();
    ok(text === template, `三类指标导出与手工模板逐位全等（14 行；实测首行 '${text.split('\n')[0]}'）`);
    ok(reg.toPrometheus() === prometheusExposition(reg.snapshot()) && reg.toPrometheus() === reg.toPrometheus(),
      'toPrometheus === prometheusExposition(snapshot)；两次导出逐位一致（确定性）');
    ok(text.includes('# TYPE dsh_latency histogram') && text.includes('# TYPE dsh_requests counter') && text.includes('# TYPE dsh_gauge gauge'),
      '# TYPE 行三类拼写齐备（counter/gauge/histogram）');
    ok(text.indexOf('dsh_gauge') < text.indexOf('dsh_latency') && text.indexOf('dsh_latency') < text.indexOf('dsh_requests'),
      '导出顺序 = 指标名升序（dsh_gauge < dsh_latency < dsh_requests；名映射 . → _）');
    // 标签转义：反斜杠、双引号、换行
    const reg2 = new MetricsRegistry();
    reg2.counter('esc.test').inc({ q: 'a"b\\c\nd' });
    const esc = reg2.toPrometheus();
    ok(esc.includes('esc_test{q="a\\"b\\\\c\\nd"} 1'),
      `标签值转义 \\ → \\\\ 、" → \\" 、换行 → \\n（实测行 '${esc.split('\n')[2]}'）`);
    // 直方图带标签序列：le 在标签末位
    const reg3 = new MetricsRegistry();
    const h2 = reg3.histogram('lat.by.route', { buckets: [10, 100] });
    h2.observe(5, { route: '/b' });
    h2.observe(50, { route: '/b' });
    const lines3 = reg3.toPrometheus().split('\n');
    ok(lines3[2] === 'lat_by_route_bucket{route="/b",le="10"} 1'
      && lines3[3] === 'lat_by_route_bucket{route="/b",le="100"} 2'
      && lines3[4] === 'lat_by_route_bucket{route="/b",le="+Inf"} 2'
      && lines3[5] === 'lat_by_route_sum{route="/b"} 55'
      && lines3[6] === 'lat_by_route_count{route="/b"} 2',
      'histogram 带标签序列：le 追加在标签末位，_bucket/_sum/_count 逐行对照');
    // 小数拼写 + 空注册表
    const reg4 = new MetricsRegistry();
    reg4.gauge('frac.value').set(0.25);
    ok(reg4.toPrometheus().includes('frac_value 0.25'), '小数值按 String() 拼写（0.25）');
    ok(new MetricsRegistry().toPrometheus() === '' && prometheusExposition({ metrics: [], stats: { metricCount: 0, seriesTotal: 0, cardinalityRejections: 0 } }) === '',
      '空注册表导出空字符串');
    throws(() => prometheusExposition(null), 'prometheusExposition(null) 拒绝', /MetricsSnapshot/);
  }

  // ═══════════════════ S6 审计账保留策略（audit-log.ts） ═══════════════════

  section('S6-1 容量门限：有界保留 + 裁剪可观测（旧 vs 新对照）');

  {
    const clock = createManualClock(0);
    const log = new AuditLog({ clock, retention: { maxEntries: 5 } });
    for (let i = 0; i < 12; i += 1) {
      log.append({ actor: `a${i}`, action: 'tick', target: `t${i}` });
      clock.advance(10);
    }
    const rs = log.retentionStats();
    ok(log.size() === 5 && rs.retainedEntries === 5 && rs.oldestRetainedTs === 70,
      `容量门限 5 × 12 条追加 → size 恒 5（保留 ts 70..110；旧口径 size=12 无界增长 vs 新口径有界 5）`);
    ok(rs.trimmedEntries === 7 && rs.trimOperations === 7,
      `裁剪计数可观测：trimmedEntries=7 / trimOperations=7（实测 ${rs.trimmedEntries}/${rs.trimOperations}）`);
    const entries = log.entries();
    ok(rs.anchorHash !== AUDIT_GENESIS_HASH && entries[0].prevHash === rs.anchorHash,
      '链头锚定：anchorHash=最后被裁条目 hash，剩余首条 prevHash=锚（≠创世常量）');
    const v = log.verify();
    ok(v.valid === true && v.checkedCount === 5, `裁剪后整链校验仍 valid（连续 5 条通过）——裁剪与链完整性共存`);
  }

  section('S6-2 锚定导出往返 + 篡改仍可定位');

  {
    const clock = createManualClock(0);
    const log = new AuditLog({ clock, retention: { maxEntries: 3 } });
    for (let i = 0; i < 8; i += 1) {
      log.append({ actor: `a${i}`, action: 'tick', target: `t${i}` });
      clock.advance(5);
    }
    const json = log.exportJSON();
    ok(json.includes('"anchorHash"') && json.indexOf('"anchorHash"') < json.indexOf('"headHash"'),
      '裁剪账导出附 anchorHash 根字段（位于 headHash 前，version 后——确定性字段序）');
    const parsed = AuditLog.parseExport(json);
    ok(parsed.entries.length === 3 && parsed.anchorHash === log.retentionStats().anchorHash,
      'parseExport 往返：条目 3 条还原、anchorHash 与账本一致');
    const rv = AuditLog.verifyChain(parsed.entries, parsed.anchorHash);
    ok(rv.valid === true && rv.checkedCount === 3, '往返条目以锚为起点 verifyChain 闭合（导出→解析→重算全链 valid）');
    const tampered = parsed.entries.map((e, i) => (i === 1 ? { ...e, actor: 'hacker' } : e));
    const rt = AuditLog.verifyChain(tampered, parsed.anchorHash);
    ok(rt.valid === false && rt.breakIndex === 1 && rt.mismatch === 'hash',
      `锚定校验仍防篡改：改保留条目 → breakIndex=1 / mismatch='hash'（实测 ${JSON.stringify(rt)}）`);
    ok(AuditLog.verifyChain(parsed.entries).valid === false,
      '不传锚则锚定账不通过（锚口径显式——创世锚只适用于未裁剪账）');
  }

  section('S6-3 时长门限 + 双门限并用 + 缺省零漂移');

  {
    const clock = createManualClock(0);
    const ageLog = new AuditLog({ clock, retention: { maxAgeMs: 50 } });
    for (let i = 0; i < 12; i += 1) {
      ageLog.append({ actor: `a${i}`, action: 'tick', target: `t${i}` });
      clock.advance(10);
    } // 末条 ts=110 → 裁 ts<60：ts 0..50 共 6 条
    const ars = ageLog.retentionStats();
    ok(ageLog.size() === 6 && ars.trimmedEntries === 6 && ars.oldestRetainedTs === 60 && ageLog.verify().valid === true,
      `时长门限 50ms：12 条流裁 6 条（ts<60），保留 60..110 且整链锚定校验 valid`);
    const clock2 = createManualClock(0);
    const dualLog = new AuditLog({ clock: clock2, retention: { maxEntries: 4, maxAgeMs: 100 } });
    for (let i = 0; i < 12; i += 1) {
      dualLog.append({ actor: `a${i}`, action: 'tick', target: `t${i}` });
      clock2.advance(10);
    }
    const drs = dualLog.retentionStats();
    ok(dualLog.size() === 4 && drs.trimmedEntries === 8 && drs.oldestRetainedTs === 80 && dualLog.verify().valid === true,
      `双门限并用：容量 4 主导裁 8 条（保留 ts 80..110），裁后链校验 valid（实测 size=${dualLog.size()}/trim=${drs.trimmedEntries}）`);
    const plain = new AuditLog();
    plain.append({ actor: 'a', action: 'x', target: 't' });
    ok(plain.exportJSON().includes('"anchorHash"') === false
      && plain.retentionStats().anchorHash === AUDIT_GENESIS_HASH && plain.retentionStats().trimmedEntries === 0,
      '缺省账零漂移：导出无 anchorHash 键、锚=创世、零裁剪');
    throws(() => new AuditLog({ retention: { maxEntries: 0 } }), 'retention.maxEntries=0 拒绝', /maxEntries/);
    throws(() => new AuditLog({ retention: { maxAgeMs: 0 } }), 'retention.maxAgeMs=0 拒绝', /maxAgeMs/);
    // 裁剪后继续追加：新条 prevHash 接保留链头（链继续延伸）
    const clock3 = createManualClock(0);
    const grow = new AuditLog({ clock: clock3, retention: { maxEntries: 2 } });
    for (let i = 0; i < 5; i += 1) grow.append({ actor: `g${i}`, action: 'tick', target: `t${i}` });
    const before = grow.headHash();
    clock3.advance(1);
    const next = grow.append({ actor: 'g9', action: 'tick', target: 't9' });
    ok(next.prevHash === before && grow.verify().valid === true,
      '裁剪后继续追加：新条 prevHash=追加前链头 hash，链无断点（anchor 不变）');
  }

  // ═══════════════════ S7 跟踪跨度尾部采样（trace.ts） ═══════════════════

  section('S7-1 尾部采样：错误全留 / 慢全留 / 正常按率 + 估计器还原');

  {
    const clock = createManualClock(0);
    const tracer = new Tracer({ clock, sampling: { slowMs: 50, rate: 0.5 } });
    const s1 = tracer.begin('op.db');       // t=0
    clock.set(10);
    const errSnap = tracer.end(s1, { error: 'conn refused' }); // 10ms，错误 → 全留
    const s2 = tracer.begin('op.compute');  // t=10
    clock.set(80);
    const slowSnap = tracer.end(s2);        // 70ms ≥ 50 → 全留
    const normalKept = [];
    for (let i = 0; i < 4; i += 1) {
      const id = tracer.begin('op.normal');
      clock.advance(5);
      normalKept.push(tracer.end(id));      // 各 5ms，正常 → 按 0.5
    }
    const ss = tracer.samplingStats();
    ok(errSnap.sampled === true && slowSnap.sampled === true,
      '错误 span（error 标签）与慢 span（70ms ≥ 50ms）全保留（sampled:true）');
    ok(normalKept.map((s) => s.sampled).join(',') === 'false,true,false,true',
      `正常 4 条按 0.5 → Bresenham 均衡 丢/留/丢/留（实测 ${normalKept.map((s) => s.sampled).join(',')}）`);
    ok(ss.decided === 6 && ss.kept === 4 && ss.dropped === 2 && ss.keptErrors === 1 && ss.keptSlow === 1
      && ss.sampledKept === 2 && ss.sampledDropped === 2,
      `分层统计：决策 6 = 错误 1 + 慢 1 + 采样留 2 + 采样丢 2（实测 decided=${ss.decided}/kept=${ss.kept}/dropped=${ss.dropped}）`);
    ok(near(ss.estimatedTotal, 6, 1e-9) && near(ss.estimateErrorBound, 2, 1e-9),
      `估计器 Ñ=1+1+2/0.5=6 还原真实 6（界 1/rate=2，实测 Ñ=${ss.estimatedTotal}）`);
    ok(tracer.tree().length === 4 && tracer.counts().total === 6 && tracer.counts().closed === 4,
      `树只含保留 4 根（被丢 2 个已移除）；counts：total=6 / closed=4（保留口径）`);
  }

  section('S7-2 被丢 span 的子树上提 + LIFO 不受采样影响 + 零漂移');

  {
    const clock = createManualClock(0);
    const tracer = new Tracer({ clock, sampling: { rate: 0.5 } });
    const outer = tracer.begin('outer.normal');
    const inner = tracer.begin('inner.err');
    clock.advance(5);
    const innerSnap = tracer.end(inner, { error: 'x' }); // 错误子 span → 留
    clock.advance(5);
    const outerSnap = tracer.end(outer);                 // 首个正常决策 → 丢
    const tree = tracer.tree();
    ok(outerSnap.sampled === false && innerSnap.sampled === true,
      '外层正常 span 被采样丢弃（sampled:false）、内层错误 span 保留');
    ok(tree.length === 1 && tree[0].spanId === inner && tree[0].labels.error === 'x',
      '被丢 span 的错误子 span 上提到根（树中 outer 消失、inner 在根层保序）');
    ok(tracer.counts().closed === 1 && tracer.counts().total === 2, 'counts：total=2 / closed=1（丢弃不计入 closed）');
    const c = tracer.begin('c');
    throws(() => tracer.end(outer), '重复关闭被丢 id → 未知（已从索引移除；栈非空走未知分支）', /未知/);
    tracer.end(c);
    const clock2 = createManualClock(0);
    const tracer2 = new Tracer({ clock: clock2, sampling: { rate: 1 } });
    const a = tracer2.begin('a');
    const b = tracer2.begin('b');
    throws(() => tracer2.end(a), '采样开启下 LIFO 守卫照常（闭非栈顶拒绝）', /不匹配/);
    tracer2.end(b);
    tracer2.end(a);
    ok(tracer2.counts().closed === 2, '守卫拒绝后状态不变，合法关闭计数正常（决策在合法关闭之后）');
    // status='error' 的缺省错误判定
    const clock3 = createManualClock(0);
    const tracer3 = new Tracer({ clock: clock3, sampling: { rate: 0.5 } });
    const se = tracer3.begin('op.status');
    clock3.advance(5);
    const seSnap = tracer3.end(se, { status: 'error' });
    ok(seSnap.sampled === true && tracer3.samplingStats().keptErrors === 1,
      "缺省错误判定含 status='error'（全留层计数 keptErrors=1）");
    // 零漂移：未配置采样的 tracer
    const plain = new Tracer();
    const pid = plain.begin('plain.op');
    const plainSnap = plain.end(pid);
    ok(plain.samplingStats() === undefined && !('sampled' in plainSnap)
      && plain.counts().total === 1 && plain.counts().closed === 1,
      '缺省 tracer 零漂移：samplingStats=undefined、快照无 sampled 键、counts 口径不变');
    throws(() => new Tracer({ sampling: { rate: 0 } }), 'sampling.rate=0 拒绝', /rate/);
    throws(() => new Tracer({ sampling: { slowMs: -1 } }), 'sampling.slowMs=-1 拒绝', /slowMs/);
  }

  // ═══════════════════ S8 源码级 + 缺省零漂移总检 ═══════════════════

  section('S8 源码级断言 + 缺省路径旧行为复验');

  {
    const sources = FILES.map((f) => ({ name: f, text: fs.readFileSync(path.join(SRC_DIR, f), 'utf8') }));
    const dateNow = sources.filter((s) => /\bDate\.now\s*\(/.test(s.text));
    ok(dateNow.length === 0, `四文件无 Date.now( 调用（命中：${dateNow.map((s) => s.name).join(',') || '无'}）`);
    const mathRandom = sources.filter((s) => /\bMath\.random\s*\(/.test(s.text));
    ok(mathRandom.length === 0, `四文件无 Math.random( 调用（命中：${mathRandom.map((s) => s.name).join(',') || '无'}）`);
    const nodeImports = sources.filter((s) => /from\s+'node:/.test(s.text) || /require\s*\(/.test(s.text));
    ok(nodeImports.length === 0, `零运行时依赖：无 node: import / require（命中：${nodeImports.map((s) => s.name).join(',') || '无'}）`);
    const all = sources.map((s) => s.text).join('\n');
    const mustExport = ['DeterministicRateSampler', 'SamplingController', 'SamplingRule', 'TypeSamplingStats', 'SamplingSummary',
      'SlidingWindowAggregator', 'SlidingWindowStats', 'prometheusExposition', 'MetricHelpOptions',
      'AuditRetentionOptions', 'AuditRetentionStats', 'parseExport', 'SpanSamplingOptions', 'SpanSamplingStats'];
    const missing = mustExport.filter((n) => !new RegExp(`\\b${n}\\b`).test(all));
    ok(missing.length === 0, `R4 新导出面抽查 ${mustExport.length - missing.length}/${mustExport.length} 个关键名字在册（缺失：${missing.join(',') || '无'}）`);
    // 缺省路径旧行为复验（三口径逐位）
    const bus = new TelemetryBus({ bufferCapacity: 3 });
    for (let i = 0; i < 5; i += 1) bus.publish('old.tick', 's', i);
    ok(bus.buffer().map((e) => e.seq).join(',') === '3,4,5' && bus.stats().bufferDropCount === 2,
      '缺省容量环形守恒复验：容量 3 发 5 条保 [3,4,5]、drop=2（旧行为逐位保持）');
    const plainLog = new AuditLog({ clock: createManualClock(7) });
    plainLog.append({ actor: 'a', action: 'b', target: 'c' });
    ok(plainLog.entries()[0].prevHash === AUDIT_GENESIS_HASH && plainLog.verify().valid === true,
      '缺省审计账复验：首条 prevHash=创世、verify valid（创世锚口径保持）');
    const reg = new MetricsRegistry();
    reg.counter('old.plain').inc();
    const snapJson = reg.toJSON();
    ok(snapJson === '{"metrics":[{"name":"old.plain","kind":"counter","series":[{"labels":{},"value":1}],"cardinalityRejections":0}],"stats":{"metricCount":1,"seriesTotal":1,"cardinalityRejections":0}}',
      '缺省指标快照 JSON 逐位不变（无 help 键——零漂移）');
  }

  // ═══════════════════ 汇总 ═══════════════════
  console.log('\n' + '═'.repeat(60));
  if (failed === 0) {
    console.log(`PASS ${passed} / FAIL 0 —— 遥测审计总线（R4-A18）四文件二期深化验证成立`);
    console.log('  │ 文件               │ R4 二期核心验证锚点                                   │');
    console.log('  │--------------------│--------------------------------------------------------│');
    console.log('  │ metrics.ts         │ 滑窗 60→50→0 过期不残留/按率采样精确计数/Prom 逐行   │');
    console.log('  │ event-bus.ts       │ 错误必达 7/7(旧 0)/估计 217/217/丢弃不占 seq/双门限计数  │');
    console.log('  │ audit-log.ts       │ 容量 5×12 → trim 7 可观测/锚定校验 valid/往返闭合       │');
    console.log('  │ trace.ts           │ 错误+慢全留、正常 0.5 留 2 丢 2/子树上提/Ñ=6 还原       │');
    console.log('  │ 零漂移             │ 缺省 stats/信封/快照/导出逐位不变；strict 实编译 0 错    │');
  } else {
    console.error(`PASS ${passed} / FAIL ${failed}`);
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}
