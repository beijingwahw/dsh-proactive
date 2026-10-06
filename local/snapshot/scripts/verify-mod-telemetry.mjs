/**
 * verify-mod-telemetry.mjs — 第三轮模块域升级「遥测审计总线 A18」验证
 * （src/telemetry/ 四文件：event-bus.ts / metrics.ts / audit-log.ts / trace.ts）
 *
 * 五项升级的构造性证明：
 *
 *   S1 结构化事件总线（event-bus.ts）：类型化信封六字段逐位（type/source/ts/
 *      seq/payload/isFinal）；seq 总线级单调（1..n）+ 环形缓冲守恒（容量满弃
 *      最旧+计数，buffer 内容与 dropCount 联合对账）；通配订阅 `sig.*` 段级
 *      精确匹配（不跨段、段数不等不命中）+ 纯函数 eventPatternMatches；
 *      seq 缺口检测（环形丢弃区间逐位还原）；慢订阅者背压三态（未满入队 /
 *      满且中间丢新 + 计数 / 满且终态逐出最旧中间必达 + 计数，全终态满载
 *      逐出最旧终态显式计数）；注入时钟（缺省手动时钟 0 起，坏时钟显式
 *      throw）；入参校验（容量/队列/类型名/通配段/take 边界）
 *   S2 指标注册表（metrics.ts）：counter 单调（负增量/非有限拒绝）、gauge
 *      双向、histogram 桶边界严格递增校验；分位数 p50/p95/p99 手工对照
 *      （桶内线性插值，20/3、82、96.4 逐位）+ 累积分布（le 升序 + '+Inf'
 *      末端、超界观测只入 +Inf）；标签基数护栏（reject 拒样本+计数 /
 *      throw 抛错+计数，已有序列不受影响）；快照确定性（两次 toJSON 逐位
 *      全等；指标名/序列键/标签对象键三级升序）；reset 清空；同名不同
 *      类型 / 桶配置不一致 / 非法指标名均显式 throw
 *   S3 追加式审计账（audit-log.ts）：哈希链（自实现 FNV-1a+djb2-xor 双引擎
 *      非加密哈希，确定性）+ 整链校验；篡改定位三态（改内容→mismatch:'hash'、
 *      改 prevHash/删中间→mismatch:'prevHash'，breakIndex/checkedCount 逐位）；
 *      导出往返（fromJSON(exportJSON()) 深度还原 + 再校验 valid）+ 确定性
 *      字段序（actor<action<target<ts<prevHash<hash 文本位置）+ version 结构
 *      校验；before/after 深拷贝（改原对象不影响账本）
 *   S4 嵌套栈跟踪器（trace.ts）：begin/end 严格 LIFO 守卫（闭非栈顶拒绝且
 *      状态逐位不变、未知/已关/空栈显式 throw）；时长精确（注入线性时钟下
 *      duration=推进量，父时长含子）；树形导出（根/子按 begin 序、标签键
 *      升序、未关 span open:true）；extraLabels 关闭时并入覆盖
 *   S5 源码级断言：四文件无 Date.now( / Math.random( 调用、无 node: 内置
 *      import、无 require——纯内存实现；本脚本以 tsc --ignoreConfig --strict
 *      实编译四文件（编译失败即 FAIL）后从产物导入运行
 *
 * 确定性：全程无随机源、无真实定时器（时钟注入）；tsc 编译为固定输入。
 * 运行：node scripts/verify-mod-telemetry.mjs（自包含：自行编译临时产物，
 * 不依赖 dist/index.mjs 的接线状态）
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
const BUILD_DIR = path.join(REPO, '.tmp-verify-telemetry');
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
  console.log(`■ S0 编译：tsc --ignoreConfig --strict → ${FILES.join('/')} 四文件 0 错误（产物 ${BUILD_DIR}）`);

  const eb = await import(pathToFileURL(path.join(BUILD_DIR, 'event-bus.js')).href);
  const mt = await import(pathToFileURL(path.join(BUILD_DIR, 'metrics.js')).href);
  const al = await import(pathToFileURL(path.join(BUILD_DIR, 'audit-log.js')).href);
  const tr = await import(pathToFileURL(path.join(BUILD_DIR, 'trace.js')).href);
  const { TelemetryBus, createManualClock, eventPatternMatches } = eb;
  const { AuditLog, auditHash, AUDIT_GENESIS_HASH } = al;
  const { MetricsRegistry } = mt;
  const { Tracer } = tr;

  // ═══════════════════ S1 结构化事件总线（锚点①） ═══════════════════

  section('S1-1 类型化信封：六字段逐位 + seq 单调 + 注入时钟');

  {
    const clock = createManualClock(1000);
    const bus = new TelemetryBus({ clock });
    const e1 = bus.publish('sig.spawn', 'sentinel', { goal: 'g-1' });
    ok(
      e1.type === 'sig.spawn' && e1.source === 'sentinel' && e1.ts === 1000 && e1.seq === 1
        && e1.payload.goal === 'g-1' && e1.isFinal === false,
      '信封六字段逐位（type/source/ts/seq/payload/isFinal 默认 false）',
    );
    clock.advance(7);
    const e2 = bus.publish('sig.close', 'goal-engine', null, { isFinal: true });
    ok(e2.ts === 1007 && e2.seq === 2 && e2.isFinal === true, 'ts 跟随注入时钟推进（+7）、seq=2、isFinal 显式标记');
    clock.advance(0);
    const e3 = bus.publish('plan.commit', 'planner', 0);
    ok(e3.ts === e2.ts, '同刻两发 ts 逐位相同（时钟不自动前进）');
    let monotone = true;
    for (let i = 0; i < 5; i += 1) bus.publish('noise.tick', 'bench', i);
    const seqs = bus.buffer().map((e) => e.seq);
    for (let i = 1; i < seqs.length; i += 1) if (seqs[i] <= seqs[i - 1]) monotone = false;
    ok(monotone && seqs[0] === 1 && seqs[seqs.length - 1] === 8, `seq 总线级严格单调 1..8（实测 ${seqs[0]}..${seqs[seqs.length - 1]}）`);
    const stats = bus.stats();
    ok(stats.publishedTotal === 8 && stats.lastSeq === 8 && stats.bufferDropCount === 0 && stats.subscriptions === 0,
      'stats 四元组（publishedTotal=8 / lastSeq=8 / bufferDropCount=0 / subscriptions=0）');
  }

  section('S1-2 通配订阅：段级精确匹配 + 纯函数');

  {
    ok(eventPatternMatches('sig.*', 'sig.spawn') === true, 'eventPatternMatches：sig.* 命中 sig.spawn');
    ok(eventPatternMatches('sig.*', 'sig.spawn.retry') === false, 'eventPatternMatches：sig.* 不命中两段深的 sig.spawn.retry（* 恰一段）');
    ok(eventPatternMatches('sig.*', 'plan.commit') === false, 'eventPatternMatches：sig.* 不命中 plan.commit（首段不匹配）');
    ok(eventPatternMatches('*', 'anything') === true, 'eventPatternMatches：单段 * 命中任意单段');
    ok(eventPatternMatches('*.*', 'a.b') === true && eventPatternMatches('*.*', 'a') === false, 'eventPatternMatches：*.* 段数守恒（不跨段吞噬）');

    const bus = new TelemetryBus();
    const sub = bus.subscribe('sig.*', { maxQueue: 16 });
    bus.publish('sig.spawn', 'sentinel', 1);
    bus.publish('sig.spawn.retry', 'sentinel', 2);
    bus.publish('plan.commit', 'planner', 3);
    bus.publish('sig.close', 'goal-engine', 4, { isFinal: true });
    const taken = sub.take();
    ok(taken.length === 2 && taken[0].type === 'sig.spawn' && taken[1].type === 'sig.close' && taken[1].isFinal === true,
      `订阅只收 sig.* 命中的 2 条（实测 ${taken.length}：${taken.map((e) => e.type).join(',')}），retry 与 plan 被排除`);
    const s = sub.stats();
    ok(s.received === 2 && s.queued === 0 && s.droppedIntermediate === 0 && s.evictedForFinal === 0 && s.droppedFinal === 0,
      '订阅统计：received=2 / queued=0（take 后清空）/ 三个丢弃计数=0');
  }

  section('S1-3 环形缓冲守恒 + seq 缺口检测');

  {
    const bus = new TelemetryBus({ bufferCapacity: 3 });
    for (let i = 0; i < 5; i += 1) bus.publish('noise.tick', 'bench', i);
    const buf = bus.buffer();
    ok(buf.length === 3 && buf.map((e) => e.seq).join(',') === '3,4,5',
      `容量 3 发 5 条 → 缓冲保最新 [3,4,5]（实测 [${buf.map((e) => e.seq).join(',')}]）`);
    ok(bus.stats().bufferDropCount === 2 && bus.stats().publishedTotal === 5,
      '满弃最旧计数对账：bufferDropCount=2 且 publishedTotal=5（守恒 5=3在缓冲+2被弃）');
    ok(bus.buffer().length === 3, 'buffer() 为只读快照（连续两次调用不消耗）');
    const gaps = bus.detectBufferGaps();
    ok(gaps.length === 1 && gaps[0].fromSeq === 1 && gaps[0].toSeq === 2 && gaps[0].count === 2,
      `缺口检测还原被弃区间 {1..2,count:2}（实测 ${JSON.stringify(gaps)}）`);
    const fresh = new TelemetryBus();
    fresh.publish('a.b', 'x', 1);
    ok(fresh.detectBufferGaps().length === 0, '无丢弃时缺口检测返回空（seq 1..last 连续）');
  }

  section('S1-4 慢订阅者背压：丢中间、终态必达、全终态满载兜底');

  {
    const bus = new TelemetryBus();
    const sub = bus.subscribe('job.*', { maxQueue: 3 });
    for (let i = 0; i < 5; i += 1) bus.publish('job.step', 'exec', i);
    let s = sub.stats();
    ok(s.queued === 3 && s.droppedIntermediate === 2 && sub.size() === 3,
      `队列满 3：中间事件丢新（queued=3 / droppedIntermediate=2）`);
    ok(sub.take().map((e) => e.seq).join(',') === '1,2,3', '被保三条为最旧的 1,2,3（FIFO 保序）');
    bus.publish('job.step', 'exec', 9);
    bus.publish('job.step', 'exec', 9);
    bus.publish('job.step', 'exec', 9);
    bus.publish('job.done', 'exec', 'ok', { isFinal: true });
    s = sub.stats();
    ok(s.evictedForFinal === 1 && s.queued === 3, '终态必达：为 isFinal 逐出最旧中间（evictedForFinal=1，队列仍有界 3）');
    const tail = sub.take();
    ok(tail.length === 3 && tail[2].type === 'job.done' && tail[2].isFinal === true && tail[0].seq === 7,
      `终态事件排在队尾且未丢（队列 seq ${tail.map((e) => e.seq).join(',')}，尾条=job.done）`);
    // 全终态满载兜底：清队后灌 3 条终态 + 1 条终态
    sub.take();
    for (let i = 0; i < 3; i += 1) bus.publish('job.done', 'exec', i, { isFinal: true });
    bus.publish('job.done', 'exec', 'last', { isFinal: true });
    s = sub.stats();
    ok(s.droppedFinal === 1 && s.queued === 3, '全终态满载再收终态：逐出最旧终态并显式计数 droppedFinal=1（有界内存兜底，非静默）');
  }

  section('S1-5 多订阅者独立 + 退订 + 入参校验');

  {
    const bus = new TelemetryBus();
    const a = bus.subscribe('sig.*', { maxQueue: 4 });
    const b = bus.subscribe('sig.spawn', { maxQueue: 1 });
    bus.publish('sig.spawn', 's', 1);
    bus.publish('sig.close', 's', 2);
    ok(a.size() === 2 && b.size() === 1, '两个订阅者按各自模式与容量独立收件（a=2 / b=1）');
    ok(bus.unsubscribe(a.id) === true && bus.unsubscribe(a.id) === false && bus.stats().subscriptions === 1,
      '退订幂等语义：首次 true、再退 false，subscriptions 递减');
    bus.publish('sig.spawn', 's', 3);
    ok(a.size() === 2 && b.stats().droppedIntermediate === 1, '退订后不再投递（a 队列停留在 2 不增长）；b 队列满丢中间计数累进');
    throws(() => new TelemetryBus({ bufferCapacity: 0 }), 'bufferCapacity=0 拒绝（≥1 整数）', /bufferCapacity/);
    throws(() => new TelemetryBus({ defaultMaxQueue: -1 }), 'defaultMaxQueue=-1 拒绝', /defaultMaxQueue/);
    throws(() => bus.publish('', 'src', 1), 'publish 空类型名拒绝', /非空字符串/);
    throws(() => bus.publish('sig..spawn', 'src', 1), 'publish 空段类型名拒绝', /空段/);
    throws(() => bus.publish('sig.ok', 'src..x', 1), "publish 含空段 source（'src..x'）拒绝", /source/);
    throws(() => bus.subscribe('s*g.x'), 'subscribe 段内半通配 s*g 拒绝（* 只能独占一段）', /独占一段/);
    throws(() => bus.subscribe('sig.*', { maxQueue: 0 }), 'subscribe maxQueue=0 拒绝', /maxQueue/);
    throws(() => bus.subscribe('sig.*').take(-1), 'take(-1) 拒绝', /maxCount/);
    const sub0 = bus.subscribe('sig.*');
    ok(sub0.take(0).length === 0, 'take(0) 合法返回空数组（不清队）');
    const badClockBus = new TelemetryBus({ clock: { now: () => Number.POSITIVE_INFINITY } });
    throws(() => badClockBus.publish('a.b', 'c', 1), '时钟返回 Infinity 时 publish 显式拒绝', /非有限/);
  }

  // ═══════════════════ S2 指标注册表（锚点②） ═══════════════════

  section('S2-1 counter / gauge：记账语义 + 单调性守卫');

  {
    const reg = new MetricsRegistry();
    const c = reg.counter('dsh.requests');
    c.inc();
    c.inc({ route: '/a' });
    c.add(5, { route: '/a' });
    c.add(0);
    const snap = reg.snapshot();
    const unlabeled = snap.metrics[0].series.find((x) => Object.keys(x.labels).length === 0);
    const labeled = snap.metrics[0].series.find((x) => x.labels.route === '/a');
    ok(unlabeled.value === 1 && labeled.value === 6, `counter 无标签 inc()+add(0)=1+0=1、{route:/a}=1+5=6（实测 ${unlabeled.value}/${labeled.value}）`);
    ok(snap.metrics[0].kind === 'counter' && snap.metrics[0].name === 'dsh.requests' && snap.stats.seriesTotal === 2,
      '快照元数据（name/kind/seriesTotal）');
    throws(() => c.add(-1), 'counter 负增量拒绝（只增不减）', /只增不减/);
    throws(() => c.add(Number.NaN), 'counter 非有限增量拒绝', /有限/);
    const g = reg.gauge('dsh.depth');
    g.set(10);
    g.inc(-3);
    g.inc();
    const gv = reg.snapshot().metrics.find((m) => m.name === 'dsh.depth').series[0].value;
    ok(gv === 8, `gauge set(10)→inc(-3)→inc() = 8（实测 ${gv}）`);
    throws(() => g.set(Number.POSITIVE_INFINITY), 'gauge 非有限值拒绝', /有限/);
    const c2 = reg.counter('dsh.requests');
    c2.inc();
    ok(reg.snapshot().metrics.find((m) => m.name === 'dsh.requests').series.find((x) => Object.keys(x.labels).length === 0).value === 2,
      '重注册句柄共享同一底层序列（无标签序列 1→2）');
    throws(() => reg.gauge('dsh.requests'), '同名不同类型重注册拒绝', /已注册为 counter/);
    throws(() => reg.counter('1bad'), '非法指标名（数字开头）拒绝', /指标名/);
  }

  section('S2-2 histogram：分位数手工对照 + 累积分布');

  {
    const reg = new MetricsRegistry();
    const h = reg.histogram('dsh.latency', { buckets: [10, 100] });
    // 手工对照数据：观测 [5,5,5,50]，桶 [10,100] → 桶0=3 个，桶1=1 个
    // p50: rank=0.5×4=2 → 桶0 内插值 0+(10-0)×(2-0)/3 = 20/3 ≈ 6.6666667
    // p95: rank=3.8 → 累积过桶0(3)，桶1 内插值 10+(100-10)×(3.8-3)/1 = 82
    // p99: rank=3.96 → 桶1 内插值 10+90×(3.96-3) = 96.4
    for (const v of [5, 5, 5, 50]) h.observe(v);
    const st = h.stats();
    ok(st.count === 4 && st.sum === 65 && st.min === 5 && st.max === 50,
      `count/sum/min/max 手工对照 4/65/5/50（实测 ${st.count}/${st.sum}/${st.min}/${st.max}）`);
    ok(near(st.p50, 20 / 3, 1e-9), `p50 手工对照 20/3（实测 ${st.p50}）`);
    ok(near(st.p95, 82, 1e-9), `p95 手工对照 82（实测 ${st.p95}）`);
    ok(near(st.p99, 96.4, 1e-9), `p99 手工对照 96.4（实测 ${st.p99}）`);
    const dist = h.distribution();
    ok(dist.length === 3 && dist[0].le === 10 && dist[0].count === 3 && dist[1].le === 100 && dist[1].count === 4
      && dist[2].le === '+Inf' && dist[2].count === 4,
      `累积分布逐点 [{le:10,c:3},{le:100,c:4},{le:'+Inf',c:4}]（实测 ${JSON.stringify(dist)}）`);
    // 超界观测：只入 +Inf，分位数返回最后有限边界
    const h2 = reg.histogram('dsh.big', { buckets: [10] });
    h2.observe(100);
    const st2 = h2.stats();
    ok(st2.count === 1 && st2.max === 100 && near(st2.p50, 10, 1e-12) && h2.distribution()[0].count === 0 && h2.distribution()[1].count === 1,
      '超界观测：不入有限桶、计入 +Inf、分位数回落最后有限边界 10');
    ok(reg.histogram('dsh.latency', { buckets: [10, 100] }).stats().count === 4,
      'histogram 同名重注册桶一致幂等且共享序列（count=4 延续）');
    ok(reg.histogram('dsh.latency').stats().count === 4 && reg.histogram('dsh.latency').distribution().length === 3,
      'histogram 幂等重获取：省略 config 沿用已注册桶（不误抛缺 buckets、序列延续）');
    throws(() => reg.histogram('dsh.brandnew'), '首次注册省略 config.buckets 拒绝', /首次注册必须提供/);
    throws(() => reg.histogram('dsh.latency', { buckets: [10, 200] }), '重复注册桶配置不一致拒绝', /桶配置不一致/);
    throws(() => reg.histogram('dsh.bad', { buckets: [] }), '空桶数组拒绝', /≥1/);
    throws(() => reg.histogram('dsh.bad', { buckets: [10, 10] }), '非严格递增桶拒绝', /严格递增/);
    throws(() => reg.histogram('dsh.bad', { buckets: [10, Number.NaN] }), '非有限桶边界拒绝', /有限/);
    throws(() => h.observe(Number.NaN), 'observe 非有限值拒绝', /有限/);
    const zero = reg.histogram('dsh.empty', { buckets: [1, 2] }).stats();
    ok(zero.count === 0 && zero.p50 === 0 && zero.p99 === 0, '空序列统计返回全 0（确定性口径）');
    const absent = reg.histogram('dsh.latency').stats({ no: 'such' });
    ok(absent.count === 0 && reg.histogram('dsh.latency').distribution({ no: 'such' }).length === 0,
      '不存在的标签组合：stats 全 0 / distribution 空（不抛错、不占基数）');
  }

  section('S2-3 标签基数护栏：reject 拒样本 + 计数 / throw 抛错 + 计数');

  {
    const reg = new MetricsRegistry({ maxLabelCardinality: 2 });
    const c = reg.counter('dsh.calls');
    c.inc({ tenant: 't1' });
    c.inc({ tenant: 't2' });
    c.inc({ tenant: 't3' }); // 超限：拒绝（不记样本）
    c.inc({ tenant: 't3' }); // 再次超限：再拒
    c.inc({ tenant: 't1' }); // 已有序列不受影响
    const snap = reg.snapshot();
    const m = snap.metrics.find((x) => x.name === 'dsh.calls');
    const t1 = m.series.find((x) => x.labels.tenant === 't1');
    const t3 = m.series.find((x) => x.labels.tenant === 't3');
    ok(m.series.length === 2 && t3 === undefined, `护栏生效：第 3 个组合未建序列（series=${m.series.length}，t3=${String(t3)}）`);
    ok(t1.value === 2, '已有序列继续正常记账（t1: 1→2）');
    ok(m.cardinalityRejections === 2 && snap.stats.cardinalityRejections === 2 && reg.registryStats().cardinalityRejections === 2,
      `拒绝计数三口径一致（条目级/快照汇总/registryStats 均=2）`);
    const reg2 = new MetricsRegistry({ maxLabelCardinality: 1, onCardinalityExceeded: 'throw' });
    const g = reg2.gauge('dsh.g');
    g.set(1, { k: 'a' });
    throws(() => g.set(9, { k: 'b' }), 'throw 策略：超限显式抛错', /基数超限/);
    ok(reg2.registryStats().cardinalityRejections === 1, 'throw 策略同样累计 cardinalityRejections=1');
    ok(reg2.snapshot().metrics[0].series.length === 1 && reg2.snapshot().metrics[0].series[0].value === 1,
      '抛错样本不入账（原序列值仍 1）');
    throws(() => new MetricsRegistry({ maxLabelCardinality: 0 }), 'maxLabelCardinality=0 拒绝', /maxLabelCardinality/);
    throws(() => new MetricsRegistry({ onCardinalityExceeded: 'ignore' }), '非法策略名拒绝', /reject/);
  }

  section('S2-4 标签校验 + 快照确定性 + reset');

  {
    const reg = new MetricsRegistry();
    const c = reg.counter('zeta.calls');
    const a = reg.counter('alpha.calls');
    c.inc({ b: '2', a: '1' });
    a.inc({ z: '9' });
    throws(() => c.inc({ v: 3 }), '标签值非 string 拒绝', /必须为 string/);
    throws(() => c.inc({ '': 'x' }), '空标签键拒绝', /空字符串/);
    throws(() => c.inc(['x']), 'labels 传数组拒绝', /键值对象/);
    const json1 = reg.toJSON();
    const json2 = reg.toJSON();
    ok(json1 === json2, '同一操作序列两次 toJSON 逐位全等（===，确定性导出）');
    ok(json1.indexOf('"alpha.calls"') < json1.indexOf('"zeta.calls"'), '快照指标名升序（alpha < zeta）');
    const seriesKeys = JSON.parse(json1).metrics.find((m) => m.name === 'zeta.calls').series[0].labels;
    ok(JSON.stringify(Object.keys(seriesKeys)) === '["a","b"]', `标签对象键升序（实测 ${JSON.stringify(Object.keys(seriesKeys))}）`);
    const multi = reg.counter('dsh.multi');
    multi.inc({ b: '2' });
    multi.inc({ a: '1' });
    const msnap = reg.snapshot().metrics.find((m) => m.name === 'dsh.multi').series;
    ok(msnap[0].labels.a === '1' && msnap[1].labels.b === '2', '序列按规范化标签键升序（a=… 排在 b=… 前）');
    reg.reset();
    ok(reg.snapshot().metrics.length === 0 && reg.registryStats().metricCount === 0 && reg.registryStats().cardinalityRejections === 0,
      'reset 清空全部指标与护栏计数');
  }

  // ═══════════════════ S3 追加式审计账（锚点③） ═══════════════════

  section('S3-1 哈希链：链式结构 + 确定性哈希');

  {
    const clock = createManualClock(500);
    const log = new AuditLog({ clock });
    ok(log.size() === 0 && log.headHash() === AUDIT_GENESIS_HASH, `空账 headHash=创世常量 ${AUDIT_GENESIS_HASH}`);
    const e1 = log.append({ actor: 'admin', action: 'create', target: 'goal/g-1', after: { title: 'T', weight: 1 } });
    ok(e1.prevHash === AUDIT_GENESIS_HASH && e1.ts === 500 && /^[0-9a-f]{16}$/.test(e1.hash),
      `首条 prevHash=创世 / ts=时钟 500 / hash 为 16 位小写十六进制（实测 ${e1.hash}）`);
    clock.advance(10);
    const e2 = log.append({ actor: 'sys', action: 'patch', target: 'goal/g-1', before: { weight: 1 }, after: { weight: 2 }, reason: '重平衡' });
    ok(e2.prevHash === e1.hash && e2.ts === 510, '第二条 prevHash=首条 hash（前向链接）且 ts 跟随时钟');
    ok(log.headHash() === e2.hash && log.size() === 2, 'headHash 随链头演进（=最后一条 hash）');
    ok(auditHash({ actor: 'a', action: 'b', target: 'c', ts: 1, prevHash: 'x' })
      === auditHash({ actor: 'a', action: 'b', target: 'c', ts: 1, prevHash: 'x' }), 'auditHash 同输入两次逐位一致（确定性）');
    ok(auditHash({ actor: 'a', action: 'b', target: 'c', ts: 1, prevHash: 'x' })
      !== auditHash({ actor: 'a', action: 'b', target: 'c', ts: 2, prevHash: 'x' }), 'auditHash 输入敏感（ts 变化 → hash 变化）');
    const v = log.verify();
    ok(v.valid === true && v.checkedCount === 2, '本账整链校验 valid（连续 2 条通过）');
  }

  section('S3-2 篡改检测 + 断点定位（三态）');

  {
    const log = new AuditLog();
    log.append({ actor: 'a1', action: 'create', target: 't1' });
    log.append({ actor: 'a2', action: 'patch', target: 't2', before: { x: 1 }, after: { x: 2 } });
    log.append({ actor: 'a3', action: 'close', target: 't3', reason: 'done' });
    const entries = log.entries();
    // 篡改 A：改第 2 条内容（不改 hash）→ 自身哈希对不上重算值
    const tamperedContent = entries.map((e, i) => (i === 1 ? { ...e, actor: 'hacker' } : e));
    const rA = AuditLog.verifyChain(tamperedContent);
    ok(rA.valid === false && rA.breakIndex === 1 && rA.mismatch === 'hash' && rA.checkedCount === 1,
      `改内容 → breakIndex=1 / mismatch='hash' / checkedCount=1（实测 ${JSON.stringify(rA)}）`);
    // 篡改 B：改第 2 条 prevHash → 前向链接断裂
    const tamperedLink = entries.map((e, i) => (i === 1 ? { ...e, prevHash: 'deadbeefdeadbeef' } : e));
    const rB = AuditLog.verifyChain(tamperedLink);
    ok(rB.valid === false && rB.breakIndex === 1 && rB.mismatch === 'prevHash',
      `改 prevHash → breakIndex=1 / mismatch='prevHash'（实测 ${JSON.stringify(rB)}）`);
    // 篡改 C：删除第 2 条 → 第 3 条 prevHash 断裂
    const removed = [entries[0], entries[2]];
    const rC = AuditLog.verifyChain(removed);
    ok(rC.valid === false && rC.breakIndex === 1 && rC.mismatch === 'prevHash' && rC.checkedCount === 1,
      `删中间条目 → 断点同样定位 index=1 / 'prevHash'（实测 ${JSON.stringify(rC)}）`);
    // 篡改 D：改首条 → 断点在 0
    const rD = AuditLog.verifyChain([{ ...entries[0], action: 'evil' }, entries[1], entries[2]]);
    ok(rD.valid === false && rD.breakIndex === 0 && rD.mismatch === 'hash', '改首条 → breakIndex=0（定位从链头起）');
    ok(AuditLog.verifyChain([]).valid === true && AuditLog.verifyChain(entries).valid === true,
      '空链 valid；原账未受篡改副本影响（纯函数校验不改原账）');
  }

  section('S3-3 导出确定性 + 往返 + 深拷贝');

  {
    const log = new AuditLog({ clock: createManualClock(42) });
    const beforeObj = { weight: 1, nested: { b: 2, a: 1 } };
    log.append({ actor: 'admin', action: 'create', target: 'goal/g-1', after: { title: 'T' } });
    log.append({ actor: 'sys', action: 'patch', target: 'goal/g-1', before: beforeObj, after: { weight: 2 } });
    const j1 = log.exportJSON();
    const j2 = log.exportJSON();
    ok(j1 === j2, '两次 exportJSON 逐位全等（确定性字段序 + 键序规范化）');
    ok(j1.indexOf('"actor"') < j1.indexOf('"action"') && j1.indexOf('"action"') < j1.indexOf('"target"')
      && j1.indexOf('"target"') < j1.indexOf('"ts"') && j1.indexOf('"ts"') < j1.indexOf('"prevHash"')
      && j1.indexOf('"prevHash"') < j1.indexOf('"hash"'), '字段序固定 actor<action<target<ts<prevHash<hash（文本位置断言）');
    ok(j1.indexOf('"nested":{"a":1,"b":2}') !== -1, '嵌套对象入账时深拷贝并键序规范化（nested 键升序 a<b，导出确定）');
    // 深拷贝：追加后改原对象不影响账本
    beforeObj.weight = 999;
    beforeObj.nested.a = 999;
    ok(log.exportJSON() === j1, '追加后改原 before 对象：账本导出逐位不变（追加时深拷贝）');
    // 往返
    const round = AuditLog.fromJSON(log.exportJSON());
    ok(round.length === 2 && round[1].before.nested.a === 1 && round[1].before.weight === 1,
      'fromJSON 往返：条目数与深层数值还原（含键序规范化克隆）');
    const rv = AuditLog.verifyChain(round);
    ok(rv.valid === true && rv.checkedCount === 2, '往返条目再过整链校验 valid（导出→解析→重算哈希全链闭合）');
    const parsedRoot = JSON.parse(log.exportJSON());
    ok(parsedRoot.version === 1 && parsedRoot.headHash === log.headHash(), '导出根结构 {version:1, headHash=链头, entries}');
    throws(() => AuditLog.fromJSON('{bad json'), 'fromJSON 非法 JSON 拒绝', /合法 JSON/);
    throws(() => AuditLog.fromJSON('{"noEntries":1}'), 'fromJSON 缺 entries 拒绝', /entries/);
    throws(() => AuditLog.fromJSON(JSON.stringify({ version: 2, entries: [] })), 'fromJSON 不支持的 version=2 拒绝（结构校验）', /version/);
    throws(() => AuditLog.fromJSON(JSON.stringify({ version: 1, entries: [{ actor: '', action: 'x', target: 'y', ts: 1, prevHash: 'p', hash: 'h' }] })),
      'fromJSON 条目 actor 空串拒绝', /非空字符串/);
  }

  section('S3-4 追加入参校验');

  {
    const log = new AuditLog();
    throws(() => log.append(null), 'append(null) 拒绝', /对象/);
    throws(() => log.append({ actor: '', action: 'a', target: 't' }), 'append 空 actor 拒绝', /actor/);
    throws(() => log.append({ actor: 'a', action: '', target: 't' }), 'append 空 action 拒绝', /action/);
    throws(() => log.append({ actor: 'a', action: 'a', target: '' }), 'append 空 target 拒绝', /target/);
    throws(() => log.append({ actor: 'a', action: 'a', target: 't', reason: 5 }), 'append reason 非 string 拒绝', /reason/);
    throws(() => log.append({ actor: 'a', action: 'a', target: 't', before: { v: Number.NaN } }), 'append before 含非有限数拒绝', /非有限数/);
    throws(() => log.append({ actor: 'a', action: 'a', target: 't', after: { fn: () => 1 } }), 'append after 含函数拒绝（不可序列化）', /不可序列化类型/);
    ok(log.size() === 0, '全部非法追加均未入账（size 仍 0，状态不变）');
    const badClockLog = new AuditLog({ clock: { now: () => Number.NaN } });
    throws(() => badClockLog.append({ actor: 'a', action: 'a', target: 't' }), '时钟返回 NaN 时 append 拒绝', /非有限/);
  }

  // ═══════════════════ S4 嵌套栈跟踪器（锚点④） ═══════════════════

  section('S4-1 span 开闭 + LIFO 栈守卫（拒绝且状态不变）');

  {
    const clock = createManualClock(10);
    const tracer = new Tracer({ clock });
    const root = tracer.begin('plan.execute', { plan: 'p-1' });
    const child = tracer.begin('node.run', { node: 'n1' });
    const leaf = tracer.begin('llm.call', { model: 'm1' });
    ok(root === 's1' && child === 's2' && leaf === 's3', `spanId 确定性单调（s1/s2/s3，实测 ${root}/${child}/${leaf}）`);
    ok(tracer.depth() === 3 && tracer.currentSpanId() === 's3', 'depth=3 / currentSpanId=栈顶 s3');
    const treeBefore = JSON.stringify(tracer.tree());
    throws(() => tracer.end(root), '闭非栈顶（关 s1，栈顶 s3）拒绝（LIFO 守卫）', /不匹配/);
    ok(JSON.stringify(tracer.tree()) === treeBefore && tracer.depth() === 3, '拒绝关闭后状态逐位不变（tree JSON 全等、depth 不变）');
    throws(() => tracer.end('s99'), '未知 spanId 拒绝', /未知/);
    const closed = tracer.end(leaf);
    throws(() => tracer.end(leaf), '重复关闭拒绝', /已关闭/);
    tracer.end(child);
    tracer.end(root);
    throws(() => tracer.end(root), '空栈再关拒绝', /无打开的 span/);
    ok(closed.name === 'llm.call' && closed.open === false, 'end 返回关闭快照（open=false）');
    ok(tracer.counts().total === 3 && tracer.counts().closed === 3 && tracer.counts().open === 0, 'counts：total=3 / closed=3 / open=0');
    throws(() => tracer.begin(''), 'begin 空名拒绝', /非空字符串/);
    throws(() => tracer.begin('x', { v: 1 }), 'begin 标签值非 string 拒绝', /必须为 string/);
    throws(() => tracer.begin('x', { '': 'a' }), 'begin 空标签键拒绝', /空字符串/);
    throws(() => new Tracer().begin('y', ['arr']), 'begin labels 传数组拒绝', /键值对象/);
  }

  section('S4-2 时长精确 + 树形结构 + extraLabels 覆盖');

  {
    const clock = createManualClock(0);
    const tracer = new Tracer({ clock });
    const s1 = tracer.begin('root'); // t=0
    clock.advance(5);
    const s2 = tracer.begin('child'); // t=5
    clock.advance(5);
    const s3 = tracer.begin('leaf'); // t=10
    clock.advance(5);
    tracer.end(s3, { status: 'ok', attempt: '2' }); // t=15 → leaf=5
    clock.advance(10);
    tracer.end(s2); // t=25 → child=20
    clock.advance(5);
    tracer.end(s1); // t=30 → root=30
    const tree = tracer.tree();
    const tRoot = tree[0];
    const tChild = tRoot.children[0];
    const tLeaf = tChild.children[0];
    ok(tree.length === 1 && tRoot.spanId === 's1' && tChild.spanId === 's2' && tLeaf.spanId === 's3',
      '树形结构：根 s1 → 子 s2 → 孙 s3（父子=开启时刻栈层级）');
    ok(tLeaf.duration === 5 && tLeaf.startTime === 10 && tLeaf.endTime === 15,
      `叶子时长精确=推进量 5（10→15，实测 ${tLeaf.duration}）`);
    ok(tChild.duration === 20 && tRoot.duration === 30,
      `父时长包含子（child=20 / root=30，实测 ${tChild.duration}/${tRoot.duration}）`);
    ok(tLeaf.labels.status === 'ok' && tLeaf.labels.attempt === '2', 'extraLabels 关闭时并入');
    ok(JSON.stringify(Object.keys(tLeaf.labels)) === '["attempt","status"]',
      `标签对象键升序导出（实测 ${JSON.stringify(Object.keys(tLeaf.labels))}）`);
    ok(tRoot.open === false && tRoot.endTime === 30, '已关 span 含 endTime / open=false');
    // 未关 span：open=true、无 duration
    const t2 = new Tracer({ clock: createManualClock(100) });
    const open1 = t2.begin('outer.open');
    const open2 = t2.begin('inner.open', { phase: 'wip' });
    const openTree = t2.tree();
    ok(openTree[0].open === true && openTree[0].duration === undefined && openTree[0].children[0].spanId === open2
      && openTree[0].children[0].labels.phase === 'wip' && t2.currentSpanId() === open2,
      '未关分支照常导出（open=true / 无 duration / 标签在位 / 栈顶=最深未关）');
    ok(t2.counts().open === 2 && t2.counts().closed === 0, 'counts：open=2 / closed=0（生长中的树）');
  }

  // ═══════════════════ S5 源码级断言（锚点⑤） ═══════════════════

  section('S5 源码级：无禁用 API + 纯内存 + 导出面');

  {
    const sources = FILES.map((f) => ({ name: f, text: fs.readFileSync(path.join(SRC_DIR, f), 'utf8') }));
    const dateNow = sources.filter((s) => /\bDate\.now\s*\(/.test(s.text));
    ok(dateNow.length === 0, `四文件无 Date.now( 调用（命中：${dateNow.map((s) => s.name).join(',') || '无'}）`);
    const mathRandom = sources.filter((s) => /\bMath\.random\s*\(/.test(s.text));
    ok(mathRandom.length === 0, `四文件无 Math.random( 调用（命中：${mathRandom.map((s) => s.name).join(',') || '无'}）`);
    const nodeImports = sources.filter((s) => /from\s+'node:/.test(s.text) || /require\s*\(/.test(s.text));
    ok(nodeImports.length === 0, `零运行时依赖：无 node: 内置 import / require（命中：${nodeImports.map((s) => s.name).join(',') || '无'}）`);
    const all = sources.map((s) => s.text).join('\n');
    const mustExport = ['TelemetryClock', 'createManualClock', 'TelemetryEventEnvelope', 'eventPatternMatches', 'TelemetryBus',
      'MetricsRegistry', 'HistogramStats', 'DistributionPoint', 'AuditLog', 'auditHash', 'AUDIT_GENESIS_HASH', 'Tracer'];
    const missing = mustExport.filter((n) => !new RegExp(`\\b${n}\\b`).test(all));
    ok(missing.length === 0, `导出面抽查 ${mustExport.length - missing.length}/${mustExport.length} 个关键名字在册（缺失：${missing.join(',') || '无'}）`);
  }

  // ═══════════════════ 汇总 ═══════════════════
  console.log('\n' + '═'.repeat(60));
  if (failed === 0) {
    console.log(`PASS ${passed} / FAIL 0 —— 遥测审计总线（A18）四文件世界性升级验证成立`);
    console.log('  │ 文件               │ 核心验证锚点                                          │');
    console.log('  │--------------------│-------------------------------------------------------│');
    console.log('  │ event-bus.ts       │ 信封六字段/seq 单调/通配段级/环形守恒/缺口还原/背压三态  │');
    console.log('  │ metrics.ts         │ 分位数手工对照(20/3,82,96.4)/累积分布/基数护栏/快照逐位 │');
    console.log('  │ audit-log.ts       │ 哈希链/篡改三态定位/导出往返闭合/深拷贝/version 校验    │');
    console.log('  │ trace.ts           │ LIFO 守卫状态不变/时长=推进量/嵌套树/标签键升序         │');
    console.log('  │ 源码级             │ 无 Date.now(/Math.random(/node: import；strict 实编译   │');
  } else {
    console.error(`PASS ${passed} / FAIL ${failed}`);
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}
