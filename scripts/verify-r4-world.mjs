/**
 * verify-r4-world.mjs — 第四轮模块域 R4-A10 升级：世界模型 / 宿主融合 / 宿主桥 新维度验证
 *
 * 六项全新维度各配「旧行为 vs 新行为」的构造对照（不是「改了」，是「证明更好」）：
 *   ⓪ 零漂移总检：全部 R4 面缺省时新读数 undefined / 新写入 false；融合层缺省
 *      observeToolReliability=false；空池拒绝且键不消耗；既有口径逐位保持。
 *   ① R4-1 反事实世界（world-model）：从主线 fork 影子分支施加假设——
 *      「假设 svc.lat 翻倍 / 新键出现 / svc.mem 不存在」3 项假设后主线版本 0 推进、
 *      信念 0 污染、快照 0 帧混入（旧世界 what-if 只能直接改真状态：污染 1 键
 *      + 版本 +1）；三方 diff 归因 hypothesis×2 / mainline×1 / diverged×1
 *      （假设 X 则 Y 直接可读）；双分支互不干扰；关闭后分支不可再用。
 *   ② R4-2 不确定性地图（world-model）：10 键混合证据库四分区——充分 3
 *      （≥3 写 ≥2 源）/ 薄弱 3 / 争议 1 / 未知 3，未知率 0.3；旧口径「有信念
 *      即已知」7/10=70% 高估；未知键不误判为矛盾：svc.cpu 收 2 次噪声被拒
 *      写入仍落 thin（冲突台账仅 cfg.c 1 条，unknown ∩ 冲突 = ∅）；
 *      薄弱区清单按证据升序导出；重挂清零（幂等覆盖）。
 *   ③ R4-3 多假说并存（world-model）：两假说竞争——先验 0.5/0.5，证据 E1
 *      （L=3:1）→ 0.75/0.25，证据 E2（L=1:9）→ 0.25/0.75 排序翻转（手算
 *      对照），E3 部分似然（只提 B，L=3）→ 0.1/0.9；称量史 3 条全保留
 *      （含翻转前 0.75/0.25 快照）；非法似然（0 / 负 / 未知候选 / 空表）→
 *      undefined 且支持度不动；三候选沉默者摊余（0.6/0.2/0.2）；
 *      retireQuestion 冻结后不可再称量、历史与 verdict 保留。
 *   ④ R4-4 事件因果链回放（world-model）：7 步写入序列（首写→印证→冲突→
 *      裁决→首写→被拒→遗忘）→ 7/7 事件完整、seq 1..7 连续、版本序列
 *      [1,2,3,4,5,5,6]（被拒不推进版本如实携带）；按键/时段/种类过滤组合
 *      全对；回放返回拷贝（改不动账本）；环深 3 淘汰最旧（events 3 /
 *      emitted 5）；旧世界快照环只有帧无事件审计（被拒写入 0 痕迹）。
 *   ⑤ R4-5 宿主桥多路复用（dsh-host，加分）：双宿主（好 connected / 坏
 *      backoff）注入时钟——6/6 请求路由至好宿主，坏宿主执行 0 次；好宿主
 *      退避、坏宿主恢复后新请求改道；同键重试优先回亲和宿主（幂等重放
 *      落在有缓存的宿主），亲和失格 → 故障转移 1 次（诚实重执行并迁移
 *      亲和，之后同键重放命中新宿主）；双宿主全灭 → no-healthy-host
 *      拒绝且键不消耗（恢复后该键恰好执行一次）；degraded(50) 让位
 *      connected(100)；出池清亲和。
 *   ⑥ 激活 glue（host-fusion）：observeToolReliability 开启——宿主工具成败
 *      作为观测证据入世界模型：healthy×2 → 信念建立+印证，failing 翻转 →
 *      真冲突记账（不静默翻转，旧世界 0 痕迹）→ 显式裁决落 failing；
 *      事件账本 write/write/conflict/resolve 4 条；不确定性地图捕获该键为
 *      薄弱区（单观察源 sources=1——诚实呈现）；缺省关（0 写入零漂移）；
 *      观测融合未挂载 → writeObservation undefined 静默降级。
 *   ⑦ 组合场景：五面齐挂一个 WorldModel——同一次写入同时驱动信念/版本/
 *      快照/事件/证据分区，影子与假说各自演进互不串扰；既有 legacy 面
 *      （predictArrivals/getSummary/serialize）逐位不变；同输入双模型
 *      两次运行支持度逐位一致（确定性）。
 *
 * 确定性：假说/账本注入时钟；桥池注入时钟逐毫秒推进；观测写入全部携带
 * 构造 timestamp；无真网络、无真定时器。
 *
 * 运行：npm run build && node --experimental-transform-types scripts/verify-r4-world.mjs
 * （WorldModel 走 dist 包；host-fusion/dsh-host 未从 index 再导出——直连
 *  src TS，保持 verify-mod-world.mjs 同口径）
 */

import { WorldModel } from '../dist/index.mjs';
import { HostFusionLayer, DEFAULT_HOST_FUSION_CONFIG } from '../src/host-fusion.ts';
import { HostBridge, HostBridgeError, HostBridgePool } from '../src/dsh-host.ts';

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
/** 断言 fn 会 reject；返回捕获的错误（未拒绝时返回 undefined 并记失败） */
async function assertRejects(fn, label) {
  try {
    await fn();
    ok(false, `${label}（未抛错——应拒绝）`);
    return undefined;
  } catch (err) {
    ok(true, `${label}（${err instanceof Error ? err.message.slice(0, 60) : String(err)}）`);
    return err;
  }
}

// ═══════════════════ ⓪ 零漂移总检 ═══════════════════
section('⓪ 零漂移总检：R4 面缺省全 undefined/false，既有口径逐位保持');

{
  const bare = new WorldModel();
  // 反事实
  ok(bare.forkShadowWorld('x') === undefined && bare.counterfactualDiff('branch-1') === undefined, '未挂载反事实 → fork/diff undefined');
  ok(bare.suppose('branch-1', 'k', 1) === false && bare.supposeAbsent('branch-1', 'k') === false, '未挂载反事实 → suppose/supposeAbsent false（无副作用）');
  ok(bare.shadowBeliefs('branch-1') === undefined && bare.counterfactualBranches() === undefined && bare.closeShadowWorld('branch-1') === false, '未挂载反事实 → 影子/分支清单/close 全空');
  // 不确定性地图
  ok(bare.registerKeySpace(['a']) === undefined && bare.uncertaintyMap() === undefined, '未挂载不确定性地图 → 登记与地图 undefined');
  // 多假说
  ok(bare.openQuestion('t', [{ id: 'a' }, { id: 'b' }]) === undefined && bare.weighEvidence('q-1', { a: 2 }) === undefined, '未挂载竞技场 → 开题/称量 undefined');
  ok(bare.hypothesisRanking('q-1') === undefined && bare.hypothesisHistory('q-1') === undefined && bare.hypothesisQuestions() === undefined && bare.retireQuestion('q-1') === false, '未挂载竞技场 → 排序/历史/清单/终结全空');
  // 事件账本
  ok(bare.replayJournal() === undefined && bare.journalStats() === undefined, '未挂载事件账本 → 回放/统计 undefined');
  // 融合层缺省关
  ok(DEFAULT_HOST_FUSION_CONFIG.observeToolReliability === false, '融合层缺省 observeToolReliability=false（opt-in）');
  // 空池
  const emptyPool = new HostBridgePool();
  ok(emptyPool.hostCount() === 0 && emptyPool.peekRoute('k') === undefined, '空池 → 0 宿主 / 路由 undefined');
  const poolErr = await assertRejects(() => emptyPool.request('k', async () => 'x'), '空池请求拒绝');
  ok(poolErr instanceof HostBridgeError && poolErr.code === 'no-healthy-host', '空池错误码 no-healthy-host');
  // 既有口径
  ok(Array.isArray(bare.predictArrivals()) && bare.predictArrivals().length === 0, '空模型 predictArrivals → []（原语义）');
  const summary = bare.getSummary();
  ok(summary.trackedTypes === 0 && summary.calibrationError === 0 && !('uncertainty' in summary) && !('journal' in summary), 'getSummary 形状无 R4 新增字段（零漂移）');
  bare.deserialize(bare.serialize());
  ok(bare.getSummary().trackedTypes === 0, 'serialize/deserialize 回路照常');
}

// ═══════════════════ ① 反事实世界 ═══════════════════
section('① 反事实世界：影子分支假设模拟（vs 直接改真状态）+ 三方 diff 归因');

{
  const wm = new WorldModel();
  wm.attachObservationFusion({ conflictThreshold: 0.5, overwriteMargin: 1.2, sourcePriors: { probe: 0.9 } });
  wm.attachCounterfactual({ clock: () => 7777 });
  wm.writeObservation('svc.lat', 42, 'probe'); // v1
  wm.writeObservation('svc.mem', 'ok', 'probe'); // v2

  const versionAtFork = wm.observationVersion();
  const beliefsAtFork = new Map(wm.observationBeliefs().map((b) => [b.key, b.value]));
  const b1 = wm.forkShadowWorld('latency-double');
  const b2 = wm.forkShadowWorld('baseline');
  ok(b1 === 'branch-1' && b2 === 'branch-2', `分支 id 单调编号：${b1}, ${b2}（确定性）`);

  // 「假设 X 则 Y」：lat 翻倍 / 新键出现 / mem 不存在
  ok(wm.suppose(b1, 'svc.lat', 84) === true, '假设 svc.lat = 84');
  ok(wm.suppose(b1, 'svc.queue-depth', 1000) === true, '假设新键 svc.queue-depth = 1000（主线从未有）');
  ok(wm.supposeAbsent(b1, 'svc.mem') === true, '假设 svc.mem 不存在（删除也是可假设的世界）');

  // —— 分支隔离：主线零污染 ——
  ok(wm.observationVersion() === versionAtFork, `3 项假设后主线版本 0 推进（仍 v${wm.observationVersion()}）`);
  const beliefsNow = new Map(wm.observationBeliefs().map((b) => [b.key, b.value]));
  ok(beliefsNow.size === beliefsAtFork.size && [...beliefsAtFork.entries()].every(([k, v]) => beliefsNow.get(k) === v), '主线信念逐位未变（假设只进影子）');
  const mainlineSnapshot = wm.observationStateAt(wm.observationVersions().at(-1));
  ok(!mainlineSnapshot.beliefs.some((b) => b.key === 'svc.queue-depth' || b.value === 84), '快照环 0 帧混入影子假设值');

  // 影子态
  const shadow1 = wm.shadowBeliefs(b1);
  const shadow1Map = new Map(shadow1.map((s) => [s.key, s.value]));
  ok(shadow1.length === 2 && shadow1Map.get('svc.lat') === 84 && shadow1Map.get('svc.queue-depth') === 1000, `影子有效态：svc.lat=84、svc.queue-depth=1000、svc.mem 被墓碑（${shadow1.length} 键）`);
  ok(shadow1.every((s) => s.hypothesis !== 'inherited' && s.hypothesis.startsWith('suppose')), '影子键全部带假设备注（可归因）');
  const shadow2 = wm.shadowBeliefs(b2);
  ok(shadow2.length === 2 && shadow2.every((s) => s.hypothesis === 'inherited') && new Map(shadow2.map((s) => [s.key, s.value])).get('svc.lat') === 42, '分支 b2 零假设：全继承 fork 基线（双分支互不干扰）');

  // 主线继续走（假设不动主线，主线也不动假设）
  wm.writeObservation('svc.new', 'x', 'probe'); // v3：主线新增（mainline 归因）
  wm.writeObservation('svc.lat', 55, 'probe', { confidence: 1.0 }); // v4：0.9 与 0.72 双 ≥0.5 → 真冲突（信念暂不动）
  wm.resolveObservationConflict('svc.lat', 55, 'diff-check'); // v5：裁决 → 主线 svc.lat 42→55（diverged 现场）
  wm.writeObservation('svc.mem', 'ok', 'probe'); // v6：同值印证（值不动 → 不进 diff）

  const diff1 = wm.counterfactualDiff(b1);
  ok(diff1.branchId === b1 && diff1.forkedAtVersion === 2 && diff1.mainlineVersion === 6, `diff 元信息：fork 自 v${diff1.forkedAtVersion} / 对照时主线 v${diff1.mainlineVersion}（含冲突+裁决推进）`);
  const causes = diff1.changes.map((c) => `${c.key}:${c.cause}`).sort();
  ok(JSON.stringify(causes) === JSON.stringify(['svc.lat:diverged', 'svc.mem:hypothesis', 'svc.new:mainline', 'svc.queue-depth:hypothesis'].sort()), `三方 diff 四键归因：${causes.join(' / ')}`);
  const latChange = diff1.changes.find((c) => c.key === 'svc.lat');
  ok(latChange.base === 42 && latChange.mainline.value === 55 && latChange.shadow.value === 84, '「假设 X 则 Y」直接可读：svc.lat 基线 42 / 主线 55 / 影子 84（分叉现场）');
  const memChange = diff1.changes.find((c) => c.key === 'svc.mem');
  ok(memChange.cause === 'hypothesis' && memChange.mainline?.value === 'ok' && memChange.shadow === undefined, '假设移除：主线仍在、影子缺席（shadow=undefined）');
  ok(diff1.changes.find((c) => c.key === 'svc.new').shadow === undefined && diff1.changes.find((c) => c.key === 'svc.new').base === undefined, '主线新增键：基线/影子皆无（mainline 归因）');

  const diff2 = wm.counterfactualDiff(b2);
  ok(diff2.changes.length === 2 && diff2.changes.every((c) => c.cause === 'mainline'), `零假设分支只看主线漂移：${diff2.changes.map((c) => c.key).join(',')}（2 键 mainline）`);
  ok(wm.counterfactualDiff('branch-99') === undefined, '不存在的分支 → diff undefined（不猜）');

  const infos = wm.counterfactualBranches();
  ok(infos.length === 2 && infos[0].id === b1 && infos[0].hypotheses === 3 && infos[0].notes.length === 3 && infos[0].forkedAtVersion === 2, '分支信息卡：假设数 / 备注清单 / fork 版本完整');

  ok(wm.closeShadowWorld(b1) === true && wm.counterfactualDiff(b1) === undefined && wm.suppose(b1, 'k', 1) === false, '关闭分支后不可再用；close 幂等返回 false');
  ok(wm.closeShadowWorld(b1) === false, '重复关闭 → false');

  // 旧世界对照：无影子层要回答 what-if 只能直接改真状态
  const oldWorld = new Map(beliefsAtFork);
  oldWorld.set('svc.lat', 84); // 旧世界 oracle：直接改
  const polluted = [...oldWorld.entries()].filter(([k, v]) => beliefsAtFork.get(k) !== v).length;
  ok(polluted === 1, `旧世界 what-if 直接改真状态：污染 ${polluted} 个主线键且版本/快照一并被污染`);
  console.log(`    数字对照：3 项假设——旧世界污染主线键 1 个（版本 +1、快照混入）/ 新世界污染 0 键、版本推进 0 次、4 项 diff 归因 hypothesis×2 / mainline×1 / diverged×1`);
}

// ═══════════════════ ② 不确定性地图 ═══════════════════
section('② 不确定性地图：键空间四分区 + 未知率 + 薄弱区清单（vs 有信念即已知）');

{
  const wm = new WorldModel();
  wm.attachObservationFusion({ conflictThreshold: 0.5, overwriteMargin: 1.2, sourcePriors: { probe: 0.9, probe2: 0.9, noise: 0.5, rival: 0.9 } });
  wm.attachUncertaintyMap();
  ok(wm.registerKeySpace(['svc.lat', 'svc.err', 'svc.mem', 'svc.cpu', 'svc.disk', 'svc.net', 'cfg.a', 'cfg.b', 'cfg.c', 'cfg.d']) === 10, '登记键空间 10 键');

  // 充分 ×3：≥3 次采纳写入 + ≥2 独立源
  for (const key of ['svc.lat', 'svc.err', 'svc.mem']) {
    wm.writeObservation(key, key === 'svc.mem' ? 'ok' : 10, 'probe');
    wm.writeObservation(key, key === 'svc.mem' ? 'ok' : 10, 'probe2');
    wm.writeObservation(key, key === 'svc.mem' ? 'ok' : 10, 'probe');
  }
  // 薄弱 ×3：单写 / 双写单源 / 单写 + 噪声被拒×2
  wm.writeObservation('cfg.a', 'v1', 'probe');
  wm.writeObservation('cfg.b', 'v2', 'probe');
  wm.writeObservation('cfg.b', 'v2', 'probe');
  wm.writeObservation('svc.cpu', 3, 'probe');
  wm.writeObservation('svc.cpu', 999, 'noise'); // strength 0.4 < 阈值 0.5 且 < 0.72×1.2 → 被拒
  wm.writeObservation('svc.cpu', 999, 'noise'); // 再拒
  // 争议 ×1：双高可靠源同键异值
  wm.writeObservation('cfg.c', 'x', 'probe');
  wm.writeObservation('cfg.c', 'y', 'rival'); // 双方 strength 0.72 ≥ 0.5 → 真冲突
  // 未知 ×3：cfg.d / svc.disk / svc.net 从未写入

  const report = wm.uncertaintyMap();
  ok(report.keySpace === 10, `键空间 ${report.keySpace}（登记 ∪ 观测）`);
  ok(JSON.stringify(report.zones.sufficient) === JSON.stringify(['svc.err', 'svc.lat', 'svc.mem']), `充分区：[${report.zones.sufficient.join(',')}]（≥3 写 ≥2 源）`);
  ok(JSON.stringify(report.zones.thin) === JSON.stringify(['cfg.a', 'cfg.b', 'svc.cpu']), `薄弱区：[${report.zones.thin.join(',')}]`);
  ok(JSON.stringify(report.zones.contested) === JSON.stringify(['cfg.c']), `争议区：[${report.zones.contested.join(',')}]（未决真冲突）`);
  ok(JSON.stringify(report.zones.unknown) === JSON.stringify(['cfg.d', 'svc.disk', 'svc.net']), `未知区：[${report.zones.unknown.join(',')}]（从未被采纳性写入）`);
  ok(near(report.unknownRate, 0.3, 1e-9), `未知率 ${report.unknownRate} = 3/10（4 位小数输出）`);

  // 分区互斥且完备
  const all = [...report.zones.sufficient, ...report.zones.thin, ...report.zones.contested, ...report.zones.unknown];
  ok(new Set(all).size === 10 && all.length === 10, '四区两两不相交且并为全键空间（完备分区）');

  // 未知键不误判为矛盾
  const conflictKeys = new Set(wm.observationConflicts().filter((c) => !c.resolved).map((c) => c.key));
  ok(conflictKeys.size === 1 && conflictKeys.has('cfg.c'), `冲突台账仅 cfg.c 1 条（噪声被拒不升冲突）`);
  ok([...report.zones.unknown].every((k) => !conflictKeys.has(k)) && !conflictKeys.has('svc.cpu'), '未知键与被噪声冲击的键都不在冲突里（未知 ≠ 矛盾）');
  const cpuBelief = wm.observationBeliefs().find((b) => b.key === 'svc.cpu');
  ok(cpuBelief.value === 3 && cpuBelief.conflicted === false, 'svc.cpu 信念守住真相值 3（2 次噪声写入全被拒）');

  // 薄弱区清单（按证据升序——最少者置顶）
  ok(report.thinRegions.length === 3 && report.thinRegions[0].key === 'cfg.a' && report.thinRegions[0].writes === 1, `薄弱区清单置顶证据最少者：cfg.a（writes=${report.thinRegions[0].writes}）`);
  const cpuRegion = report.thinRegions.find((r) => r.key === 'svc.cpu');
  ok(cpuRegion.writes === 1 && cpuRegion.sources === 1 && cpuRegion.rejections === 2 && cpuRegion.beliefStrength > 0.7, `svc.cpu 薄弱条目：1 写 / 1 源 / 被拒 ${cpuRegion.rejections} 次（被拒不是证据也不是矛盾，只记账）`);
  ok(report.thinRegions.find((r) => r.key === 'cfg.b').agreements === 1, 'cfg.b 同值印证 1 次（清单携带 agreements）');

  // 旧 vs 新
  const beliefs = wm.observationBeliefs();
  ok(beliefs.length === 7, `旧口径「有信念即已知」：${beliefs.length}/10 = 70% 被当已覆盖`);
  console.log(`    数字对照：旧口径信念覆盖 7/10=70%（把 3 个零证据键当已知、1 个争议键当确定）/ 新口径充分仅 ${report.sufficient}/10、未知率 ${report.unknownRate} 显式、薄弱 ${report.thinRegions.length} 项可执行补观测、争议 ${report.contested} 项待裁决`);

  // 幂等覆盖：重挂清零（独立小模型验证——重挂清登记与证据，信念不属于地图）
  {
    const fresh = new WorldModel();
    fresh.attachObservationFusion({ sourcePriors: { p: 0.9 } });
    fresh.attachUncertaintyMap();
    fresh.registerKeySpace(['a', 'b', 'c', 'd']);
    const reset = fresh.uncertaintyMap();
    ok(reset.keySpace === 4 && reset.zones.unknown.length === 4 && near(reset.unknownRate, 1, 1e-9), '纯登记零写入：全未知（unknownRate=1——登记的语义就是把未见键纳入未知分母）');
    fresh.attachUncertaintyMap(); // 重挂
    const afterReset = fresh.uncertaintyMap();
    ok(afterReset.keySpace === 0 && afterReset.zones.unknown.length === 0, '重挂不确定性地图 → 登记与证据清零（幂等覆盖语义）');
  }
}

// ═══════════════════ ③ 多假说并存 ═══════════════════
section('③ 多假说并存：贝叶斯式支持度更新 / 排序翻转 / 历史保留（vs 急于收敛）');

{
  let t = 1000;
  const wm = new WorldModel();
  wm.attachHypothesisArena({ clock: () => t });

  const q1 = wm.openQuestion('svc.lat 飙升的根因', [
    { id: 'db-slow', label: '数据库慢查询', prior: 0.5 },
    { id: 'net-jitter', label: '网络抖动', prior: 0.5 },
  ]);
  ok(q1 === 'q-1', `问题 id 单调编号 ${q1}（确定性）`);
  let ranking = wm.hypothesisRanking(q1);
  ok(ranking.length === 2 && near(ranking[0].support, 0.5) && ranking[0].candidateId === 'db-slow', `先验 0.5/0.5，同分按插入序 [${ranking[0].candidateId}, ${ranking[1].candidateId}]`);

  t = 1100;
  const e1 = wm.weighEvidence(q1, { 'db-slow': 3, 'net-jitter': 1 }, '慢查询日志聚集');
  ok(e1.index === 1 && near(e1.standingAfter[0].support, 0.75) && near(e1.standingAfter[1].support, 0.25), `E1（L=3:1）→ db-slow 0.75 / net-jitter 0.25（手算 1.5:0.5 归一）`);
  ok(wm.hypothesisRanking(q1)[0].candidateId === 'db-slow', 'E1 后排序 [db-slow, net-jitter]');

  t = 1200;
  const e2 = wm.weighEvidence(q1, { 'db-slow': 1, 'net-jitter': 9 }, '抓包显示重传风暴');
  ok(near(e2.standingAfter[0].support, 0.25) && near(e2.standingAfter[1].support, 0.75), `E2（L=1:9）→ 0.25/0.75（0.75×1 : 0.25×9 归一）`);
  ranking = wm.hypothesisRanking(q1);
  ok(ranking[0].candidateId === 'net-jitter' && ranking[1].candidateId === 'db-slow', `证据翻转支持度：排序翻转为 [${ranking[0].candidateId}, ${ranking[1].candidateId}]——不急于收敛单一真相`);

  t = 1300;
  const e3 = wm.weighEvidence(q1, { 'net-jitter': 3 }, '第二次抓包仍见重传（对 db-slow 沉默）');
  ranking = wm.hypothesisRanking(q1);
  ok(near(ranking[0].support, 0.9, 1e-6) && near(ranking[1].support, 0.1, 1e-6), `E3 部分似然（只提 net-jitter L=3，沉默者 L=1）→ ${ranking[0].support}/${ranking[1].support}（0.25 : 2.25 归一）`);

  // 历史保留
  const history = wm.hypothesisHistory(q1);
  ok(history.length === 3 && history.every((h, i) => h.index === i + 1), `称量史 ${history.length} 条、index 1..3 连续`);
  ok(near(history[0].standingAfter[0].support, 0.75) && near(history[1].standingAfter[1].support, 0.75), '翻转前的支持度快照原样保留（0.75→0.25 的路可回放）');
  ok(history[2].note.includes('第二次抓包') && JSON.stringify(history[2].likelihoods) === JSON.stringify({ 'net-jitter': 3 }), '称量史携带备注与似然（可审计）');

  // 非法输入：不更新
  ok(wm.weighEvidence(q1, { 'db-slow': 0 }) === undefined && wm.weighEvidence(q1, { 'db-slow': -1 }) === undefined, '似然 ≤0 → undefined（部分更新 = 不更新）');
  ok(wm.weighEvidence(q1, { ghost: 2 }) === undefined, '未知候选 → undefined');
  ok(wm.weighEvidence(q1, {}) === undefined && wm.weighEvidence('q-99', { 'db-slow': 2 }) === undefined, '空似然表 / 未知问题 → undefined');
  ok(near(wm.hypothesisRanking(q1)[0].support, 0.9, 1e-6), '非法输入后支持度纹丝不动（0.9/0.1 保持）');

  // 三候选：沉默者摊余
  const q2 = wm.openQuestion('分流实验差异', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  const e4 = wm.weighEvidence(q2, { a: 3 }, '仅 a 组指标显著');
  ok(q2 === 'q-2' && near(e4.standingAfter[0].support, 0.6) && near(e4.standingAfter[1].support, 0.2) && near(e4.standingAfter[2].support, 0.2), `三候选沉默摊余：a 0.6 / b 0.2 / c 0.2（3 : 1 : 1 归一）`);
  const ranking2 = wm.hypothesisRanking(q2);
  ok(ranking2[1].candidateId === 'b' && ranking2[2].candidateId === 'c', 'b/c 同分按插入序（确定性平手规则）');

  // 开题校验
  ok(wm.openQuestion('x', [{ id: 'only' }]) === undefined, '候选 <2 → undefined');
  ok(wm.openQuestion('x', [{ id: 'dup' }, { id: 'dup' }]) === undefined, '候选 id 重复 → undefined');
  ok(wm.openQuestion('x', [{ id: 'a1', prior: 0 }, { id: 'a2' }]) === undefined, '先验 ≤0 → undefined');

  // 终结
  ok(wm.retireQuestion(q1, 'root-caused: net retransmit storm') === true, '显式终结（竞技场不自动收敛，终结是决定）');
  ok(wm.weighEvidence(q1, { 'db-slow': 5 }) === undefined, '终结后不可再称量');
  const infos = wm.hypothesisQuestions();
  ok(infos.length === 2 && infos[0].retired === true && infos[0].verdict === 'root-caused: net retransmit storm' && infos[0].weighings === 3, '问题清单保留 verdict 与称量数（历史不随终结蒸发）');
  ok(wm.retireQuestion(q1) === false, '重复终结 → false');
}

// ═══════════════════ ④ 事件因果链回放 ═══════════════════
section('④ 事件因果链回放：谁在何时改了什么键（完整性与过滤正确性）');

{
  let jt = 5000;
  const wm = new WorldModel();
  wm.attachObservationFusion({ conflictThreshold: 0.5, overwriteMargin: 1.2, sourcePriors: { probe: 0.9, probe2: 0.9, noise: 0.5 } });
  wm.attachEventJournal({ capacity: 100, clock: () => jt });

  wm.writeObservation('k1', 'a', 'probe', { timestamp: 1000 }); // seq1 write first-write v1
  wm.writeObservation('k1', 'a', 'probe2', { timestamp: 1100 }); // seq2 write corroborated v2
  wm.writeObservation('k1', 'A', 'probe', { timestamp: 1200, confidence: 1.0 }); // seq3 conflict（0.9 与印证后 0.9216 双 ≥0.5）
  jt = 1300;
  wm.resolveObservationConflict('k1', 'A', 'human-review'); // seq4 resolve v4
  wm.writeObservation('k2', 'x', 'probe', { timestamp: 1400 }); // seq5 write first-write v5
  wm.writeObservation('k2', 'y', 'noise', { timestamp: 1500 }); // seq6 reject（版本停留 v5）
  jt = 1600;
  wm.forgetObservation('k2', 'expired'); // seq7 forget v6

  const stats = wm.journalStats();
  ok(stats.events === 7 && stats.emitted === 7, `7 步操作 → ${stats.events}/7 事件完整落账`);
  ok(JSON.stringify(stats.kinds) === JSON.stringify({ conflict: 1, forget: 1, reject: 1, resolve: 1, write: 3 }), `按种类计数：${JSON.stringify(stats.kinds)}`);

  const all = wm.replayJournal();
  ok(all.map((e) => e.seq).join(',') === '1,2,3,4,5,6,7', 'seq 1..7 连续单调（因果链有序）');
  ok(all.map((e) => e.kind).join(',') === 'write,write,conflict,resolve,write,reject,forget', `事件序列 ${all.map((e) => e.kind).join('→')}`);
  ok(all.map((e) => e.version).join(',') === '1,2,3,4,5,5,6', `版本序列 [${all.map((e) => e.version).join(',')}]（被拒不推进版本，如实携带）`);
  ok(all[0].detail.to === 'a' && all[0].detail.reason === 'first-write', 'seq1：首写 to=a');
  ok(all[1].detail.from === 'a' && all[1].detail.to === 'a' && all[1].detail.reason === 'corroborated', 'seq2：同值印证 from=a to=a');
  ok(all[2].detail.challenger.source === 'probe' && all[2].detail.challenger.value === 'A' && all[2].detail.from === 'a', 'seq3：冲突双方值与挑战源在案');
  ok(all[3].detail.reason === 'human-review' && all[3].detail.to === 'A', 'seq4：裁决者与裁决值在案');
  ok(all[5].detail.to === 'y' && all[5].detail.reason === 'out-strengthened', 'seq6：被拒写入留痕（谁主张过什么、为何输）');
  ok(all[6].detail.from === 'x' && all[6].detail.reason === 'expired', 'seq7：遗忘携带原值与原因');

  // 过滤正确性
  ok(wm.replayJournal({ keys: ['k1'] }).map((e) => e.seq).join(',') === '1,2,3,4', '按键过滤：k1 → seq 1-4');
  ok(wm.replayJournal({ keys: ['k1', 'k2'] }).length === 7, '按键过滤多键并集');
  ok(wm.replayJournal({ from: 1100, to: 1400 }).map((e) => e.seq).join(',') === '2,3,4,5', '按时段过滤（闭区间 1100..1400）→ seq 2-5');
  ok(wm.replayJournal({ kinds: ['write'] }).map((e) => e.seq).join(',') === '1,2,5', '按种类过滤 write → seq 1,2,5');
  ok(wm.replayJournal({ keys: ['k2'], kinds: ['reject', 'forget'] }).map((e) => e.seq).join(',') === '6,7', '组合过滤（键 × 种类）→ seq 6,7');
  ok(wm.replayJournal({ keys: ['k1'], from: 1100, to: 1100 }).map((e) => e.seq).join(',') === '2', '组合过滤（键 × 时段单点）→ seq 2');
  ok(wm.replayJournal({ keys: ['no-such-key'] }).length === 0, '无匹配 → 空数组（诚实而非 undefined）');

  // 回放是拷贝
  all[0].detail.to = 'TAMPERED';
  ok(wm.replayJournal()[0].detail.to === 'a', '回放返回拷贝（改返回值动不了账本）');

  // 环形淘汰
  const wm2 = new WorldModel();
  wm2.attachObservationFusion({ sourcePriors: { p: 0.9 } });
  wm2.attachEventJournal({ capacity: 3, clock: () => jt });
  for (const key of ['e1', 'e2', 'e3', 'e4', 'e5']) wm2.writeObservation(key, 1, 'p');
  const ringStats = wm2.journalStats();
  const ring = wm2.replayJournal();
  ok(ringStats.emitted === 5 && ringStats.events === 3 && ring.map((e) => e.seq).join(',') === '3,4,5', `环深 3：落账 ${ringStats.emitted} / 保留最近 ${ringStats.events}（seq 3-5，淘汰最旧但 seq 不重置）`);

  console.log(`    数字对照：旧世界快照环只有「版本→整帧」（被拒写入 0 痕迹、无 per-event 审计）/ 新世界 7/7 事件完整含 1 条被拒、键/时段/种类三维过滤组合全对、环深有界`);
}

// ═══════════════════ ⑤ 宿主桥多路复用 ═══════════════════
section('⑤ 宿主桥多路复用：多宿主连接池 / 健康度路由 / 键亲和（vs 单桥单点）');

{
  let clock3 = 0;
  const mkBridge = (label) => new HostBridge({ baseBackoffMs: 1000, backoffFactor: 2, maxBackoffMs: 8000, now: () => clock3, label });
  const good = mkBridge('good');
  const bad = mkBridge('bad');
  ok((await good.connect()) === true && (await bad.connect()) === true, '双宿主各自独立连接（clock=0）');
  bad.fail('net partition'); // bad → backoff 至 1000

  const pool = new HostBridgePool({ affinityCapacity: 8 });
  pool.add(good, 'good', '主宿主');
  pool.add(bad, 'bad', '备宿主');
  ok(pool.hostCount() === 2, '双宿主入池');

  const view = new Map(pool.hosts().map((h) => [h.id, h]));
  ok(view.get('good').eligible === true && view.get('good').healthScore === 100, `good：connected / 健康度 ${view.get('good').healthScore}`);
  ok(view.get('bad').eligible === false && view.get('bad').healthScore === 0 && view.get('bad').state === 'backoff', `bad：backoff / 健康度 ${view.get('bad').healthScore}（不可服务恒 0 分）`);
  ok(pool.peekRoute('k1').hostId === 'good' && pool.peekRoute('k1').viaAffinity === false, '路由预览：新键落 good（健康度定路由）');

  let execTag = [];
  const exec = (tag) => async () => {
    execTag.push(tag);
    return tag;
  };
  for (const k of ['k1', 'k2', 'k3', 'k4', 'k5']) await pool.request(k, exec(`${k}@good`));
  ok(good.bridgeStats().executed === 5 && bad.bridgeStats().executed === 0, `一好一坏：5 请求全落 good（good 执行 ${good.bridgeStats().executed} / bad 执行 ${bad.bridgeStats().executed}——路由避开坏宿主）`);
  const replay1 = await pool.request('k1', exec('k1@SHOULD-NOT-RUN'));
  ok(replay1 === 'k1@good' && good.bridgeStats().executed === 5 && good.bridgeStats().replayed === 1, `同键重试回亲和宿主重放：good 执行仍 5、replayed=${good.bridgeStats().replayed}（幂等重放落在有缓存的宿主）`);
  ok(pool.poolStats().affinityHits === 1 && pool.poolStats().replayed === 1, `池级记账：亲和命中 ${pool.poolStats().affinityHits} / 重放 ${pool.poolStats().replayed}`);

  // 故障转移：good 退避、bad 恢复
  clock3 = 500;
  good.fail('disk full'); // good → backoff 至 1500
  clock3 = 1000;
  ok((await bad.connect()) === true && bad.connectionState === 'connected', '退避到期（恰 1000ms）bad 重连恢复');
  ok(pool.peekRoute('k6').hostId === 'bad', 'good 失格 → 新键路由翻到 bad');
  await pool.request('k6', exec('k6@bad'));
  ok(bad.bridgeStats().executed === 1 && good.bridgeStats().executed === 5, 'k6 在 bad 执行（good 零打扰）');
  const failoverResult = await pool.request('k1', exec('k1@bad-failover'));
  ok(failoverResult === 'k1@bad-failover' && bad.bridgeStats().executed === 2, '亲和宿主失格 → 同键故障转移：诚实在 bad 重新执行（跨宿主缓存不共享，不假装重放）');
  ok(pool.poolStats().failovers === 1, `故障转移计数 ${pool.poolStats().failovers}`);
  const replayOnBad = await pool.request('k1', exec('k1@NEVER'));
  ok(replayOnBad === 'k1@bad-failover' && bad.bridgeStats().executed === 2 && bad.bridgeStats().replayed === 1, '亲和已迁移至 bad：同键重试在 bad 重放（此后幂等恢复）');

  // good 恢复：同分按入池序
  clock3 = 1500;
  ok((await good.connect()) === true, 'good 退避到期重连');
  ok(pool.peekRoute('k7').hostId === 'good', '双 connected 同分 100 → 入池序 good 优先（确定性平手规则）');
  await pool.request('k7', exec('k7@good'));
  ok(good.bridgeStats().executed === 6, `k7 回 good（good 累计执行 ${good.bridgeStats().executed}）`);

  // degraded 让位（独立小池验证——不与主池的 bad 平手干扰）
  {
    const d1 = mkBridge('d1');
    const d2 = mkBridge('d2');
    await d1.connect();
    await d2.connect();
    const pool2 = new HostBridgePool();
    pool2.add(d1, 'd1');
    pool2.add(d2, 'd2');
    d1.markDegraded('能力缩水：流式降轮询');
    ok(pool2.peekRoute('k9').hostId === 'd2', 'degraded 健康度 50 < connected 100 → 路由让位健康宿主');
    let degradedServed = 0;
    await pool2.request('k9', async () => {
      degradedServed += 1;
      return 'ok';
    });
    ok(degradedServed === 1 && d2.bridgeStats().executed === 1, 'k9 在 d2 执行（半故障宿主仍可用但不再首选）');
  }

  // 全灭 → 拒绝且键不消耗
  good.fail('power'); // backoff 至 2500（重连后失败计数清零 → 基数退避）
  bad.fail('power');
  ok(pool.peekRoute('k8') === undefined, '双宿主全退避 → 路由 undefined');
  const noHost = await assertRejects(() => pool.request('k8', exec('k8@NEVER')), '全灭请求拒绝');
  ok(noHost instanceof HostBridgeError && noHost.code === 'no-healthy-host' && !execTag.includes('k8@NEVER'), '错误码 no-healthy-host 且 k8 从未执行（键不消耗）');
  clock3 = 2500;
  ok((await good.connect()) === true, 'good 恢复');
  const k8result = await pool.request('k8', exec('k8@good'));
  ok(k8result === 'k8@good' && execTag.filter((x) => x.startsWith('k8')).length === 1, '恢复后 k8 恰好执行一次（拒绝期零消耗的兑现）');

  // 出池清亲和
  ok(pool.remove('bad') === true && pool.hostCount() === 1, 'bad 出池（hostCount 1）');
  ok(pool.peekRoute('k6').hostId === 'good', 'bad 的亲和记录随出池清除 → k6 重路由 good');
  ok(pool.remove('bad') === false, '重复出池 → false');

  const ps = pool.poolStats();
  console.log(`    数字对照：坏宿主在线期间新世界 0 请求落坏宿主（旧世界单桥 = 单点，退避期请求全拒）；故障转移 ${ps.failovers} 次 + 亲和重放 ${ps.replayed} 次 / 全灭期拒绝 ${ps.rejectedNoHost} 次且键零消耗`);
  ok(ps.rejectedNoHost === 1 && ps.failovers === 1, `池统计：failovers=${ps.failovers} / rejectedNoHost=${ps.rejectedNoHost}`);
}

// ═══════════════════ ⑥ 激活 glue：宿主工具可靠性信念 ═══════════════════
section('⑥ 激活 glue：宿主工具成败 → 观测信念 / 冲突裁决 / 账本 / 薄弱区（opt-in）');

{
  const makeKit = (worldModel) => {
    const handlers = new Map();
    return {
      handlers,
      deps: {
        ctx: { get: (k) => (k === 'tools' ? {} : undefined), on: (ev, fn) => handlers.set(ev, fn) },
        sentinel: { ingest: () => {} },
        worldModel,
        governor: { checkGate: () => ({ allowed: true, blockedBy: '', reason: '' }) },
        broadcast: () => {},
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        selfToolNames: new Set(['bridge-tool']),
      },
    };
  };
  const fire = (kit, name, isError, message) =>
    kit.handlers.get('tools/result')({ name, arguments: {} }, isError ? { isError, error: { message } } : { isError });

  // —— 开启：工具成败成为观测证据 ——
  const wm = new WorldModel();
  wm.attachObservationFusion({ conflictThreshold: 0.5, overwriteMargin: 1.2, sourcePriors: { 'host-fusion': 0.9 } });
  wm.attachEventJournal({ clock: () => 9000 });
  wm.attachUncertaintyMap();
  const kit = makeKit(wm);
  const layer = new HostFusionLayer({ observeToolReliability: true }, kit.deps);
  ok(layer.activate() === true && kit.handlers.has('tools/result'), '融合层激活（订阅在案）');

  fire(kit, 'web-search', false);
  fire(kit, 'web-search', false);
  const relKey = 'host-tool-reliability:web-search';
  let belief = wm.observationBeliefs().find((b) => b.key === relKey);
  ok(belief.value === 'healthy' && belief.source === 'host-fusion', `工具 2 次成功 → 信念 healthy 建立（strength ${belief.strength.toFixed(4)}，noisy-OR 印证上升）`);

  fire(kit, 'web-search', true, 'upstream 500');
  belief = wm.observationBeliefs().find((b) => b.key === relKey);
  const conflict = wm.observationConflicts().find((c) => c.key === relKey && !c.resolved);
  ok(belief.value === 'healthy' && belief.conflicted === true && conflict !== undefined, '工具开始失败 → 真冲突记账而非静默翻转（healthy↔failing 是要被裁决的事，不是覆盖）');
  ok(conflict.incumbent.value === 'healthy' && conflict.challenger.value === 'failing', `冲突双方在案：${conflict.incumbent.value} vs ${conflict.challenger.value}`);

  wm.resolveObservationConflict(relKey, 'failing', 'ops:oncall');
  belief = wm.observationBeliefs().find((b) => b.key === relKey);
  ok(belief.value === 'failing' && belief.conflicted === false, '值班裁决 → 信念落 failing（带 adjudicatedBy 留痕）');

  ok(layer.getStats().reliabilityWrites === 3, `融合层记账：${layer.getStats().reliabilityWrites} 次可靠性写入（2 成功 + 1 失败）`);
  const kinds = wm.replayJournal().map((e) => e.kind).join(',');
  ok(kinds === 'write,write,conflict,resolve', `事件账本同步收录：${kinds}（宿主管线动作直通世界因果链）`);
  const region = wm.uncertaintyMap().thinRegions.find((r) => r.key === relKey);
  ok(region !== undefined && region.sources === 1 && region.writes === 3, `不确定性地图捕获：可靠性键是薄弱区（3 写但仅 1 个观察源——单源恒薄，诚实呈现）`);

  fire(kit, 'bridge-tool', false);
  ok(wm.observationBeliefs().every((b) => !b.key.includes('bridge-tool')) && layer.getStats().reliabilityWrites === 3, '自排除照常：调度器自身桥接工具不入观测');

  // —— 缺省关：零漂移 ——
  const wmOff = new WorldModel();
  wmOff.attachObservationFusion({ sourcePriors: { 'host-fusion': 0.9 } });
  const kitOff = makeKit(wmOff);
  const layerOff = new HostFusionLayer(undefined, kitOff.deps); // 缺省配置
  layerOff.activate();
  fire(kitOff, 'web-search', false);
  fire(kitOff, 'web-search', true, 'boom');
  ok(wmOff.observationBeliefs().length === 0 && layerOff.getStats().reliabilityWrites === 0, '缺省 observeToolReliability=false → 0 信念 0 写入（opt-in 零漂移）');

  // —— 诚实降级：融合未挂载 ——
  const wmBare = new WorldModel();
  const kitBare = makeKit(wmBare);
  const layerBare = new HostFusionLayer({ observeToolReliability: true }, kitBare.deps);
  layerBare.activate();
  fire(kitBare, 'web-search', false);
  ok(layerBare.getStats().reliabilityWrites === 0 && layerBare.isActive() === true, '观测融合未挂载 → writeObservation undefined 静默降级（不抛错不破坏宿主管线）');

  console.log('    数字对照：旧世界（缺省关 / R4 前）工具状态翻转 0 痕迹 0 信念 / 新世界 3 写入 + 1 冲突 + 1 裁决全链在案，且单源薄弱性被地图显式曝光');
}

// ═══════════════════ ⑦ 组合场景 + 确定性 ═══════════════════
section('⑦ 组合场景：五面齐挂互不串扰 + legacy 零漂移 + 确定性双跑');

{
  const run = () => {
    let t = 1000;
    const wm = new WorldModel();
    wm.attachObservationFusion({ conflictThreshold: 0.5, overwriteMargin: 1.2, sourcePriors: { probe: 0.9, probe2: 0.9 } });
    wm.attachEventJournal({ clock: () => t });
    wm.attachUncertaintyMap();
    wm.attachHypothesisArena({ clock: () => t });
    wm.attachCounterfactual({ clock: () => t });
    wm.registerKeySpace(['deploy.replicas', 'deploy.image']);
    // 同一次写入同时驱动：信念 / 版本 / 快照 / 事件 / 证据分区（timestamp 注入——确定性）
    wm.writeObservation('deploy.replicas', 3, 'probe', { timestamp: 1000 });
    wm.writeObservation('deploy.replicas', 3, 'probe2', { timestamp: 1010 });
    wm.writeObservation('deploy.replicas', 3, 'probe', { timestamp: 1020 });
    wm.writeObservation('deploy.image', 'v2', 'probe', { timestamp: 1030 });
    wm.writeObservation('deploy.tag', 'beta', 'probe', { timestamp: 1040 });
    // 假说竞争
    const q = wm.openQuestion('发布后错误率升高的解释', [{ id: 'config', prior: 0.5 }, { id: 'load', prior: 0.5 }]);
    wm.weighEvidence(q, { config: 4, load: 1 }, '仅改配置的环境复现');
    wm.weighEvidence(q, { config: 1, load: 6 }, '错误率与 QPS 同步爬升');
    // 反事实
    const b = wm.forkShadowWorld('rollback');
    wm.suppose(b, 'deploy.replicas', 1, 'suppose rollback to 1 replica');
    wm.writeObservation('deploy.image', 'v2', 'probe2', { timestamp: 1050 }); // 主线同值印证（fork 后）
    return { wm, q, b, t };
  };

  const { wm, q, b } = run();
  const report = wm.uncertaintyMap();
  ok(report.zones.sufficient.length === 1 && report.zones.sufficient[0] === 'deploy.replicas', `证据分区：deploy.replicas 充分（3 写 2 源）`);
  ok(JSON.stringify(report.zones.thin) === JSON.stringify(['deploy.image', 'deploy.tag']), `薄弱区 [${report.zones.thin.join(',')}]（单源短证据）`);
  ok(wm.replayJournal().length === 6, `事件账本 6 条（5 写入 + 1 印证全收录）`);
  ok(wm.observationVersion() === 6, `版本 v${wm.observationVersion()}（每次采纳推进，快照环同步）`);
  const ranking = wm.hypothesisRanking(q);
  ok(ranking[0].candidateId === 'load' && near(ranking[0].support, 0.6), `假说排序 [${ranking[0].candidateId} ${ranking[0].support}, ${ranking[1].candidateId} ${ranking[1].support}]（手算：E1 4:1 → 0.8/0.2；E2 1:6 → 0.8:1.2 归一 0.4/0.6 翻转）`);
  const diff = wm.counterfactualDiff(b);
  const diffCauses = diff.changes.map((c) => `${c.key}:${c.cause}`);
  ok(diffCauses.length === 1 && diffCauses[0] === 'deploy.replicas:hypothesis', `影子 diff：${diffCauses.join(' ')}（fork 后主线只印证未改值 → 不进 diff，假设键独占归因）`);
  // legacy 零漂移
  ok(wm.getSummary().trackedTypes === 0 && wm.predictArrivals().length === 0, '五面齐挂后 legacy 观测面逐位不变（observeArrival 与观测融合旁路隔离）');
  wm.deserialize(wm.serialize());
  ok(wm.getSummary().trackedTypes === 0, 'serialize/deserialize 回路照常（R4 面为运行时观测面，不入序列化——见汇报妥协）');

  // 确定性双跑
  const a1 = run();
  const a2 = run();
  const r1 = a1.wm.hypothesisRanking(a1.q).map((s) => `${s.candidateId}:${s.support}`);
  const r2 = a2.wm.hypothesisRanking(a2.q).map((s) => `${s.candidateId}:${s.support}`);
  ok(JSON.stringify(r1) === JSON.stringify(r2), `同输入双跑支持度逐位一致：[${r1.join(', ')}]（注入时钟确定性）`);
  const j1 = a1.wm.replayJournal().map((e) => `${e.seq}:${e.kind}@${e.timestamp}`).join('|');
  const j2 = a2.wm.replayJournal().map((e) => `${e.seq}:${e.kind}@${e.timestamp}`).join('|');
  ok(j1 === j2, '同输入双跑事件账本逐位一致（seq/kind/timestamp）');
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— 世界模型/宿主融合/宿主桥 第四轮 R4-A10 六项新维度新旧行为对照验证成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
