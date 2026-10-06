/**
 * verify-mod-world.mjs — 第三轮模块域升级：世界模型 / 宿主融合 / 宿主桥 新旧行为对照验证
 *
 * 五项升级各配「旧行为 vs 新行为」的构造对照（不是「改了」，是「证明更好」）：
 *   ① 观测信念融合（world-model）：可靠源 vs 噪声源写入流——旧世界后写覆盖
 *      10 个键全部被噪声污染；新世界可靠性加权裁决 0 污染，且噪声源可靠性
 *      在线衰减（Beta 后验 0.5 → 0.25，10 次矛盾）、可靠源稳居 0.9。
 *      冷启动无先验：双观察源互证双双收敛 11/12，孤证噪声源被反复推翻
 *      衰减至 1/6。真冲突：双高可靠源同键异值 → 记账不覆盖（旧世界静默
 *      翻转无痕），显式裁决后胜方一致性 +1 / 败方矛盾 +1。未挂载全 undefined。
 *   ② 时间旅行视图（world-model）：写入序列 v1..v5（含推翻改写与遗忘）→
 *      任一保留版本可整帧取回（v2 处 k1 还是旧值 a）、键级 diff 增/删/改
 *      三态逐键对照、快照环深度淘汰（v1 淘汰 → undefined 诚实降级）。
 *      旧世界：0 个可回溯版本。
 *   ③ 宿主能力协商（host-fusion）：版本化能力集（协议版本 + 特性位向量）
 *      → 协商取交集 + 降级链记账。同代宿主全量零降级；旧宿主（v2 缺流式）
 *      → 协议降级 + ProgressStreaming→ProgressPolling 回退 + 无链特性
 *      （StructuredToolSchemas）让渡记账；远古宿主（v1）→ 不兼容拒绝激活。
 *      融合层接线：缺治理门的旧宿主只订阅观测事件；缺省自动探测当代宿主
 *      → 订阅面与升级前逐位一致（零漂移）。
 *   ④ 宿主桥生命周期（dsh-host）：断连重连序列驱动状态机全迁移
 *      disconnected→connecting→connected→backoff→…→degraded→…，
 *      指数退避（注入时钟逐毫秒断言 1000/2000/4000/8000/8000 封顶）；
 *      请求幂等键：断连重连后同键重放不重执行（执行 1 次 vs 旧世界
 *      无键朴素重试 3 次执行）、在途去重共享 Promise、失败也严格幂等、
 *      LRU 淘汰后键恢复新鲜。
 *   ⑤ 世界模型健康度（world-model，加分项）：纯函数滚动口径——80 好 + 20 坏
 *      的校准史：旧口径全史 MAE 1.16（低于阈值 2 → 「看着健康」），
 *      新口径近 30 条命中率 0.333 → needsRelearning=true（近期崩坏被看见）；
 *      按类型分解最差置顶；端到端：真实预测-对账回路喂出报告；
 *      未挂载 undefined。
 *   ⑥ 零漂移总检：新 API 未挂载全 undefined；56.0 等既有挂载面照常；
 *      getSummary/serialize 无形状漂移。
 *
 * 确定性：桥用注入时钟（无真实时间依赖）；退避序列逐毫秒手算对照；
 * 融合/协商全部为构造序列；健康度纯函数给定记录全确定（端到端段的
 * 误差方向（≥3.5 ≫ 容差 1）对小时直方图/趋势修正的边界不敏感）。
 *
 * 运行：npm run build && node --experimental-transform-types scripts/verify-mod-world.mjs
 * （WorldModel/computeWorldHealth 走 dist 包；host-fusion/dsh-host 未从 index
 *  再导出——直连 src TS。dsh-host 既有 KeyHealthManager 含参数属性，需
 *  transform-types 模式加载；dist 段为纯 .mjs 不受影响）
 */

import { WorldModel, computeWorldHealth } from '../dist/index.mjs';
import {
  HostFusionLayer,
  negotiateCapabilities,
  HostFeature,
  HOST_PROTOCOL_VERSION,
  HOST_MIN_PROTOCOL_VERSION,
  HOST_DEGRADATION_CHAINS,
  describeFeatures,
} from '../src/host-fusion.ts';
import { HostBridge, HostBridgeError } from '../src/dsh-host.ts';

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
    ok(true, `${label}（${err instanceof Error ? err.message.slice(0, 50) : String(err)}）`);
    return err;
  }
}

// ═══════════════════ ① 观测信念融合：可靠源胜出 + 真冲突标记 ═══════════════════
section('① 观测信念融合：源可靠性先验/在线校准 + 真冲突检测（vs 后写覆盖）');

{
  // —— 零介入：未挂载全部 undefined ——
  const bare = new WorldModel();
  ok(bare.writeObservation('k', 1, 's') === undefined, '未挂载 → writeObservation undefined（诚实降级，不静默走后写覆盖）');
  ok(bare.observationBeliefs() === undefined && bare.observationConflicts() === undefined && bare.sourceReliabilities() === undefined, '未挂载 → 信念/冲突台账/源画像全 undefined');
  ok(bare.observationStateAt(1) === undefined && bare.diffObservations(1, 2) === undefined && bare.observationVersion() === undefined, '未挂载 → 时间旅行全家 undefined');

  // —— 可靠源 vs 噪声源（先验给起跑线，裁决与衰减是在线学出来的）——
  const wm = new WorldModel();
  wm.attachObservationFusion({ conflictThreshold: 0.5, overwriteMargin: 1.2, sourcePriors: { probe: 0.9, noise: 0.5 } });
  // 先验 κ=10：probe → Beta(9,1)=0.9（strength 0.72）；noise → Beta(5,5)=0.5（strength 0.40）
  const TRUTH = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'];
  const GARBAGE = ['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9'];
  const oldWorld = new Map(); // 旧世界 oracle：后写覆盖
  for (let i = 0; i < 10; i += 1) {
    wm.writeObservation(`metric-${i}`, TRUTH[i], 'probe');
    oldWorld.set(`metric-${i}`, TRUTH[i]);
  }
  for (let i = 0; i < 10; i += 1) {
    const verdict = wm.writeObservation(`metric-${i}`, GARBAGE[i], 'noise');
    ok(verdict !== undefined && verdict.accepted === false, `噪声写入 metric-${i} 被拒（strength 0.40 < 既有 0.72×1.2 且 < 冲突阈值）`);
    oldWorld.set(`metric-${i}`, GARBAGE[i]); // 旧世界：后写无条件覆盖
  }
  const beliefs = wm.observationBeliefs();
  ok(beliefs.length === 10 && beliefs.every((b) => b.value === TRUTH[Number(b.key.split('-')[1])]), '新世界 10/10 键保持可靠源的真相值');
  ok([...oldWorld.values()].every((v) => GARBAGE.includes(v)), '旧世界 oracle：10/10 键被噪声后写污染');
  console.log(`    数字对照：写入流 20 次（10 真相 + 10 噪声）——旧世界污染键 10 个 / 新世界污染键 0 个`);

  const rel = new Map(wm.sourceReliabilities().map((r) => [r.source, r]));
  ok(near(rel.get('probe').reliability, 0.9, 1e-9), `可靠源可靠性 ${rel.get('probe').reliability}（Beta(9,1) 无矛盾维持）`);
  ok(near(rel.get('noise').reliability, 0.25, 1e-6), `噪声源可靠性在线衰减 ${rel.get('noise').reliability}（Beta(5,5) + 10 矛盾 → 5/20 = 0.25，手算对照）`);
  ok(rel.get('noise').contradictions === 10 && rel.get('noise').writes === 10, '噪声源画像：10 写入 10 矛盾（校准素材完整）');
  ok(wm.observationVersion() === 10, `版本号只随接受/冲突推进：${wm.observationVersion()}（10 次噪声被拒不占版本）`);

  // —— 冷启动学习（无先验）：互证收敛，孤证噪声衰减 ——
  const cold = new WorldModel();
  cold.attachObservationFusion({ conflictThreshold: 0.5, overwriteMargin: 1.1 });
  for (let i = 0; i < 10; i += 1) {
    cold.writeObservation(`cal-${i}`, `t${i}`, 'srcA');
    cold.writeObservation(`cal-${i}`, `t${i}`, 'srcB'); // 独立第二观察源同值互证
  }
  for (let i = 0; i < 4; i += 1) {
    cold.writeObservation(`wrong-${i}`, `w${i}`, 'srcC'); // 噪声孤证先落地
    cold.writeObservation(`wrong-${i}`, `t${i}`, 'srcA'); // 可靠源（已校准）推翻
  }
  const coldRel = new Map(cold.sourceReliabilities().map((r) => [r.source, r]));
  console.log(`    冷启动收敛（无先验纯在线）：srcA=${coldRel.get('srcA').reliability} srcB=${coldRel.get('srcB').reliability} srcC=${coldRel.get('srcC').reliability}`);
  ok(near(coldRel.get('srcA').reliability, 11 / 12, 1e-3) && near(coldRel.get('srcB').reliability, 11 / 12, 1e-3), `互证双源收敛 11/12 ≈ ${coldRel.get('srcA').reliability}（Beta(1,1)+10 印证；源画像输出 4 位小数）`);
  ok(near(coldRel.get('srcC').reliability, 1 / 6, 1e-3), `孤证噪声源衰减 1/6 ≈ ${coldRel.get('srcC').reliability}（4 次被推翻——Beta(1,1)+4 矛盾）`);
  const wrongBeliefs = cold.observationBeliefs().filter((b) => b.key.startsWith('wrong-'));
  ok(wrongBeliefs.length === 4 && wrongBeliefs.every((b) => b.value === `t${b.key.split('-')[1]}`), '纠错生效：wrong-* 4 键全部回到可靠源的真相值');

  // —— 真冲突：双高可靠源同键异值 → 记账不覆盖 ——
  const cf = new WorldModel();
  cf.attachObservationFusion({ conflictThreshold: 0.5, overwriteMargin: 1.2, sourcePriors: { alpha: 0.9, beta: 0.9 } });
  cf.writeObservation('cfg', 'v1', 'alpha');
  const clash = cf.writeObservation('cfg', 'v2', 'beta');
  ok(clash.accepted === false && clash.conflict !== undefined, '双高可靠源异值 → 真冲突（双方 strength 0.72 均 ≥ 阈值 0.5）');
  ok(cf.observationBeliefs().find((b) => b.key === 'cfg').value === 'v1', '信念未被静默覆盖（仍是 incumbent v1）——等显式裁决');
  ok(cf.observationBeliefs().find((b) => b.key === 'cfg').conflicted === true, '键被标记 conflicted=true（消费方必见）');
  const ledger = cf.observationConflicts();
  ok(ledger.length === 1 && ledger[0].incumbent.value === 'v1' && ledger[0].challenger.value === 'v2' && ledger[0].resolved !== true, `冲突台账完整（双方值/来源/强度/未决态，version ${clash.version}）`);
  console.log('    旧世界对照：后写覆盖会静默把 cfg 翻成 v2 且无任何痕迹；新世界保留 v1 + 冲突在案');

  const resolved = cf.resolveObservationConflict('cfg', 'v2', 'human-review');
  ok(resolved !== undefined && resolved.value === 'v2' && resolved.source === 'beta', '显式裁决 → 信念变更为 beta 的 v2（裁决者 human-review 留痕）');
  const relAfter = new Map(cf.sourceReliabilities().map((r) => [r.source, r]));
  ok(near(relAfter.get('beta').reliability, 10 / 11, 1e-3) && near(relAfter.get('alpha').reliability, 9 / 11, 1e-3), `裁决即校准：胜方 beta ${relAfter.get('beta').reliability}（10/11）> 败方 alpha ${relAfter.get('alpha').reliability}（9/11）`);
  ok(cf.observationConflicts()[0].resolved === true && cf.observationConflicts()[0].adjudicatedBy === 'human-review', '冲突台账闭环（resolved + 裁决者）');
  ok(cf.observationBeliefs().find((b) => b.key === 'cfg').conflicted === false, '裁决后键脱离待裁决态');
  ok(cf.resolveObservationConflict('cfg', 'v9') === undefined, '无未决冲突再裁决 → undefined（不重复记账）');
}

// ═══════════════════ ② 时间旅行视图：快照环 + 版本查询 + 键级 diff ═══════════════════
section('② 时间旅行：回到 t 版本查询 / 键级 diff（增/删/改）/ 环深淘汰');

{
  const wm = new WorldModel();
  wm.attachObservationFusion({ snapshotDepth: 4, conflictThreshold: 0.5, overwriteMargin: 1.0, sourcePriors: { s1: 0.9, s2: 0.3 } });

  const v1 = wm.writeObservation('k1', 'a', 's2').version; // v1：s2 首建（strength 0.24）
  const v2 = wm.writeObservation('k2', 'b', 's2').version; // v2：新增 k2
  const v3 = wm.writeObservation('k1', 'A2', 's1').version; // v3：s1(0.72) 推翻 s2(0.24×1.0) —— 改
  const v4 = wm.writeObservation('k3', 'c', 's1').version; // v4：新增 k3
  const v5 = wm.forgetObservation('k2', 'expired'); // v5：遗忘 k2 —— 删（直接返回版本号）
  ok(v1 === 1 && v2 === 2 && v3 === 3 && v4 === 4 && v5 === 5, `版本号单调推进 1..5（实际 ${v1},${v2},${v3},${v4},${v5}）`);

  // 回到过去：v2 处 k1 还是旧值 a（旧世界无从取回）
  const at2 = wm.observationStateAt(2);
  const mapAt2 = new Map(at2.beliefs.map((b) => [b.key, b.value]));
  ok(at2.version === 2 && mapAt2.get('k1') === 'a' && mapAt2.get('k2') === 'b', '回到 v2：k1=旧值 a、k2=b（被推翻前的世界整帧取回）');
  const at5 = wm.observationStateAt(5);
  ok(!at5.beliefs.some((b) => b.key === 'k2') && at5.beliefs.find((b) => b.key === 'k1').value === 'A2', '回到 v5：k2 已遗忘、k1=A2（删除也是版本化事件）');

  // 键级 diff 三态
  const d24 = wm.diffObservations(2, 4);
  ok(d24.added.length === 1 && d24.added[0].key === 'k3' && d24.removed.length === 0, `diff(2→4) 增：k3`);
  ok(d24.changed.length === 1 && d24.changed[0].key === 'k1' && d24.changed[0].from === 'a' && d24.changed[0].to === 'A2', 'diff(2→4) 改：k1 a→A2（键级定位）');
  const d45 = wm.diffObservations(4, 5);
  ok(d45.removed.length === 1 && d45.removed[0].key === 'k2' && d45.added.length === 0 && d45.changed.length === 0, 'diff(4→5) 删：k2（遗忘被 diff 捕获）');
  const d25 = wm.diffObservations(2, 5);
  ok(d25.added.length === 1 && d25.removed.length === 1 && d25.changed.length === 1, `diff(2→5) 三态齐备：+k3 / -k2 / ~k1`);

  // 环深淘汰：depth=4 → v1 被淘汰，诚实 undefined
  ok(JSON.stringify(wm.observationVersions()) === JSON.stringify([2, 3, 4, 5]), `快照环保留最近 4 版：[${wm.observationVersions().join(',')}]`);
  ok(wm.observationStateAt(1) === undefined, 'v1 已被环形缓冲淘汰 → undefined（不猜）');
  ok(wm.diffObservations(1, 5) === undefined, '任一端版本被淘汰 → diff undefined（诚实降级）');
  ok(wm.forgetObservation('no-such-key') === undefined && wm.forgetObservation('k2') === undefined, '遗忘不存在的键 → undefined（无版本空转）');
  console.log(`    数字对照：旧世界可回溯版本 0 个 / 新世界 ${wm.observationVersions().length} 个（环深 4 有界）；diff 三态 [增${d25.added.length}/删${d25.removed.length}/改${d25.changed.length}]`);
}

// ═══════════════════ ③ 宿主能力协商：交集 + 降级链 ═══════════════════
section('③ 宿主能力协商：版本化能力集 / 协议 min / 特性交集 / 降级链记账');

{
  const ALL = Object.values(HostFeature).reduce((a, b) => a | b, 0);
  ok(HOST_PROTOCOL_VERSION === 3 && HOST_MIN_PROTOCOL_VERSION === 2, `协议常量：当前线 v${HOST_PROTOCOL_VERSION} / 最低兼容线 v${HOST_MIN_PROTOCOL_VERSION}`);
  ok(describeFeatures(HostFeature.ToolResultEvents | HostFeature.PreExecuteGate).join('+') === 'ToolResultEvents+PreExecuteGate', 'describeFeatures 位向量 → 特性名（可观测）');
  ok(JSON.stringify(HOST_DEGRADATION_CHAINS.ProgressStreaming) === JSON.stringify([HostFeature.ProgressStreaming, HostFeature.ProgressPolling, 0]), '降级链定义：流式 → 轮询 → 0（无替代哨兵）');

  // 我方能力集（与融合层 ourCapabilities() 同构：观测/治理/流式+轮询兜底/schema）
  const ours = {
    protocolVersion: 3,
    features: HostFeature.ToolResultEvents | HostFeature.PreExecuteGate | HostFeature.ProgressStreaming | HostFeature.ProgressPolling | HostFeature.StructuredToolSchemas,
    label: 'plugin',
  };

  // 同代宿主：全量可用，零降级
  const modern = negotiateCapabilities(ours, { protocolVersion: 3, features: ALL, label: 'modern-host' });
  ok(modern.compatible && modern.protocolVersion === 3 && !modern.protocolDowngraded && modern.degradations.length === 0, '同代宿主：兼容 / v3 / 零降级');
  ok(modern.features === ours.features && modern.enabled.length === 5, `特性交集 = 我方声明 5 项（${modern.enabled.join(',')}）`);

  // 旧宿主（v2）：协议降级 + 流式→轮询回退 + 无链特性让渡
  const oldHost = { protocolVersion: 2, features: HostFeature.ToolResultEvents | HostFeature.PreExecuteGate | HostFeature.ProgressPolling, label: 'old-host' };
  const legacy = negotiateCapabilities(ours, oldHost);
  ok(legacy.compatible && legacy.protocolVersion === 2 && legacy.protocolDowngraded, '旧宿主：协议降级 v3→v2（仍 ≥ 最低线 v2，兼容）');
  ok(legacy.features === (HostFeature.ToolResultEvents | HostFeature.PreExecuteGate | HostFeature.ProgressPolling), `特性交集只剩 [${legacy.enabled.join(',')}]（流式/schema 被裁）`);
  const streamDeg = legacy.degradations.find((d) => d.feature === 'ProgressStreaming');
  ok(streamDeg !== undefined && streamDeg.fallbackBit === HostFeature.ProgressPolling && streamDeg.fallbackName === 'ProgressPolling', '降级链生效：ProgressStreaming → ProgressPolling（宿主有轮询位，回退落点在交集内）');
  const schemaDeg = legacy.degradations.find((d) => d.feature === 'StructuredToolSchemas');
  ok(schemaDeg !== undefined && schemaDeg.fallbackBit === 0 && schemaDeg.fallbackName === 'none', '无链特性让渡也记账：StructuredToolSchemas → none（能力让渡，非静默丢弃）');
  ok(legacy.degradations.length === 2 && legacy.degradations.every((d) => d.reason.includes('old-host')), `共 ${legacy.degradations.length} 条降级记录（reason 含宿主标识，可审计）`);
  console.log('    数字对照：旧世界按同代假设硬调 4 项特性 → 旧宿主上 2 项落空（流式断/schema 错）/ 新世界 0 项落空 + 2 条降级账（1 回退 1 让渡）');

  // 更旧宿主（连轮询都没有）：流式整体让渡
  const dusty = negotiateCapabilities(ours, { protocolVersion: 2, features: HostFeature.ToolResultEvents, label: 'dusty-host' });
  const dustyStream = dusty.degradations.find((d) => d.feature === 'ProgressStreaming');
  ok(dustyStream !== undefined && dustyStream.fallbackBit === 0, '旧宿主连轮询位都无 → 流式整体让渡（链上无交集落点 → 0）');

  // 远古宿主（v1）：低于最低兼容线 → 拒绝
  const ancient = negotiateCapabilities(ours, { protocolVersion: 1, features: ALL, label: 'ancient-host' });
  ok(!ancient.compatible && /低于最低兼容线/.test(ancient.incompatibleReason ?? ''), `远古宿主 v1 → 不兼容（${ancient.incompatibleReason}）——不硬凑`);
  ok(ancient.degradations.length === 0, '不兼容时降级账为空（没有协商就没有降级）');

  // —— 融合层接线：协商裁剪订阅面 ——
  const layerKit = () => {
    const registered = [];
    const warnings = [];
    return {
      registered,
      warnings,
      deps: {
        ctx: { get: (k) => (k === 'tools' ? {} : undefined), on: (ev) => registered.push(ev) },
        sentinel: { ingest: () => {} },
        worldModel: { observeArrival: () => {} },
        governor: { checkGate: () => ({ allowed: true, blockedBy: '', reason: '' }) },
        broadcast: () => {},
        logger: { info: () => {}, warn: (...a) => warnings.push(String(a[0])), error: () => {} },
        selfToolNames: new Set(['self-tool']),
      },
    };
  };

  // 缺省自动探测（当代宿主在场）→ 订阅面与升级前逐位一致（零漂移）
  const kit0 = layerKit();
  const layer0 = new HostFusionLayer(undefined, kit0.deps);
  ok(layer0.activate() === true && JSON.stringify(kit0.registered) === JSON.stringify(['tools/result', 'tools/pre-execute']), `缺省自动探测：激活且订阅 [${kit0.registered.join(',')}]（与旧世界行为一致）`);
  ok(layer0.getStats().negotiation?.compatible === true && layer0.getStats().negotiation.degradations === 0, '缺省协商摘要：兼容 + 零降级（getStats 增量字段）');

  // 显式旧宿主能力集（无治理门）→ 治理订阅被裁 + 降级已记账
  const kit1 = layerKit();
  const layer1 = new HostFusionLayer(undefined, kit1.deps);
  const neg1 = layer1.negotiateWithHost({ protocolVersion: 2, features: HostFeature.ToolResultEvents | HostFeature.ProgressPolling, label: 'old-host-no-gate' });
  ok(neg1.compatible && neg1.protocolVersion === 2, `融合层协商旧宿主：v${neg1.protocolVersion} 兼容（我方 want [${neg1.ours.label}] ∩ 宿主 = [${neg1.enabled.join(',')}])`);
  ok(layer1.activate() === true && JSON.stringify(kit1.registered) === JSON.stringify(['tools/result']), `旧宿主只订阅 [${kit1.registered.join(',')}]（治理门被协商裁掉，不再假设宿主支持）`);
  ok(layer1.getNegotiation().degradations.length === 2 && kit1.warnings.length === 2, `降级留痕：getNegotiation ${layer1.getNegotiation().degradations.length} 条（PreExecuteGate→none + ProgressStreaming→Polling）/ logger.warn ${kit1.warnings.length} 条`);

  // 显式远古宿主 → 拒绝激活（旧世界会在不兼容宿主上盲订事件）
  const kit2 = layerKit();
  const layer2 = new HostFusionLayer(undefined, kit2.deps);
  layer2.negotiateWithHost({ protocolVersion: 1, features: ALL, label: 'ancient' });
  ok(layer2.activate() === false && kit2.registered.length === 0, '远古宿主：协商不兼容 → 不激活零订阅');

  // 宿主无 ToolRegistry（自动探测不到）→ 旧世界静默降级语义保留
  const kit3 = layerKit();
  kit3.deps.ctx.get = () => undefined;
  const layer3 = new HostFusionLayer(undefined, kit3.deps);
  ok(layer3.activate() === false && kit3.registered.length === 0, '宿主无 ToolRegistry → 不激活（旧语义保留）');

  // dispose 清协商态
  layer1.dispose();
  ok(layer1.getNegotiation() === undefined && layer1.isActive() === false, 'dispose 清理协商结果（重装重协商）');
}

// ═══════════════════ ④ 宿主桥生命周期：状态机 + 退避 + 幂等 ═══════════════════
section('④ 宿主桥：连接状态机 / 指数退避重连 / 请求幂等键');

{
  // —— 幂等：断连重连序列 ——
  let clock = 0;
  const bridge = new HostBridge({ baseBackoffMs: 1000, backoffFactor: 2, maxBackoffMs: 8000, now: () => clock, cacheCapacity: 4, label: 'verify' });
  let executed = 0;
  const exec = (tag) => async () => {
    executed += 1;
    return tag;
  };

  ok(bridge.connectionState === 'disconnected', '初始态 disconnected');
  const err0 = await assertRejects(() => bridge.request('task-A', exec('A1')), '断开态请求被拒');
  ok(err0 instanceof HostBridgeError && err0.code === 'not-connected', `错误码 not-connected（键未消耗：executed=${executed}）`);
  ok(bridge.bridgeStats().executed === 0 && bridge.bridgeStats().rejectedNotConnected === 1, '断开态 0 执行 1 拒绝');

  ok((await bridge.connect()) === true, 'connect() → true');
  ok(bridge.connectionState === 'connected', '状态机 → connected');
  const t0 = bridge.transitionLog();
  ok(t0.length === 2 && t0[0].from === 'disconnected' && t0[0].to === 'connecting' && t0[1].to === 'connected', '迁移链 disconnected→connecting→connected（审计在案）');

  const r1 = await bridge.request('task-A', exec('A1'));
  ok(r1 === 'A1' && executed === 1, '连接态请求执行一次（executed=1）');

  bridge.disconnect('maintenance');
  ok(bridge.connectionState === 'disconnected', '显式断开 → disconnected');
  await assertRejects(() => bridge.request('task-A', exec('A1')), '断连期间请求被拒（不执行）');
  ok(executed === 1, '断连期间零执行');

  ok((await bridge.connect()) === true, '显式断开重置退避 → 立即重连成功');
  const r2 = await bridge.request('task-A', exec('A1'));
  ok(r2 === 'A1' && executed === 1, `重连后同键重放不重执行（executed 仍 = 1，replayed=${bridge.bridgeStats().replayed}）——幂等核心`);

  // 失败也严格幂等：失败结果被缓存重放
  await assertRejects(() => bridge.request('task-B', async () => {
    executed += 1;
    throw new Error('boom');
  }), '失败请求按 promise 拒绝');
  await assertRejects(() => bridge.request('task-B', exec('NEVER')), '同键重试重放同一失败（不换结果）');
  ok(executed === 2, `失败缓存严格幂等：executed=${executed}（第二次 exec 未跑）`);

  // 在途去重：并发同键共享一个 Promise
  const p1 = bridge.request('task-C', async () => {
    executed += 1;
    return 'C';
  });
  const p2 = bridge.request('task-C', exec('X'));
  const [c1, c2] = await Promise.all([p1, p2]);
  ok(c1 === 'C' && c2 === 'C' && executed === 3, `在途去重：两路并发同键同一执行（executed=${executed}，deduped=${bridge.bridgeStats().dedupedInflight}）`);

  // LRU：容量 4。此刻缓存 LRU 序 [task-A(触碰最早), task-B, task-C] →
  // +k4（满）→ +k5 淘汰最久未用的 task-A → task-A 重新执行（键恢复新鲜，
  // 并把 A 挪到最近端）→ +k6 淘汰 task-C → task-C 重新执行
  await bridge.request('k4', exec('k4')); // executed 4；缓存 [A,B,C,k4]
  await bridge.request('k5', exec('k5')); // executed 5；淘汰 A → [B,C,k4,k5]
  const rA = await bridge.request('task-A', exec('A2')); // A 已淘汰 → 重新执行
  ok(rA === 'A2' && executed === 6, `LRU 淘汰即键过期：task-A 重新执行得 A2 而非重放 A1（executed=${executed}，5→6）`);
  const replayedBefore = bridge.bridgeStats().replayed;
  await bridge.request('k6', exec('k6')); // executed 7；淘汰 C（A 刚被触碰后移）→ [k4,k5,A,k6]
  const rC2 = await bridge.request('task-C', exec('C2')); // C 已淘汰 → 重新执行
  ok(rC2 === 'C2' && executed === 8, `再次验证键恢复新鲜：task-C 重新执行得 C2（executed=${executed}，7→8，replayed 未增仍 ${replayedBefore}）`);
  ok(bridge.bridgeStats().evicted === 4 && bridge.bridgeStats().cacheSize === 4, `LRU 有界：evicted=${bridge.bridgeStats().evicted} / cacheSize=${bridge.bridgeStats().cacheSize}（容量 4，淘汰即过期语义可预期）`);

  // —— 旧世界对照：无幂等键的朴素重试 ——
  let naiveExecuted = 0;
  const flakyTransport = () => {
    naiveExecuted += 1; // 服务端每次都真执行（响应丢失是网络问题——经典重复执行）
    if (naiveExecuted < 3) throw new Error('response lost');
    return 'ok';
  };
  let naiveResult = null;
  for (let attempt = 0; attempt < 5 && naiveResult === null; attempt += 1) {
    try {
      naiveResult = flakyTransport();
    } catch {
      /* 旧世界：无键重试 = 重执行 */
    }
  }
  console.log(`    数字对照：响应丢失 ×2 的重试——旧世界无键朴素重试执行 ${naiveExecuted} 次 / 新世界桥幂等键执行 1 次（重试全走重放）`);
  ok(naiveResult === 'ok' && naiveExecuted === 3, '旧世界朴素重试确实执行 3 次（重复副作用现场）');

  // —— 指数退避：注入时钟逐毫秒断言 ——
  let clock2 = 0;
  const b2 = new HostBridge({ baseBackoffMs: 1000, backoffFactor: 2, maxBackoffMs: 8000, now: () => clock2 });
  ok((await b2.connect()) === true && b2.connectionState === 'connected', '退避桥：连接建立');

  b2.fail('net down');
  ok(b2.connectionState === 'backoff' && b2.backoffRemainingMs() === 1000, `失败 #1 → backoff，退避 1000ms（remaining=${b2.backoffRemainingMs()}）`);
  clock2 = 500;
  ok((await b2.connect()) === false && b2.connectionState === 'backoff', '退避中（剩 500ms）connect 被拒——重连节奏受控');
  clock2 = 1000;
  ok((await b2.connect()) === true && b2.connectionState === 'connected', '退避到期 → 重连成功');

  b2.fail('down');
  ok(b2.backoffRemainingMs() === 1000, `重连后再失败从基数重新起退（${b2.backoffRemainingMs()}）`);
  b2.fail('down');
  ok(b2.backoffRemainingMs() === 2000, `连续失败 #2 → 指数退避 2000ms`);
  b2.fail('down');
  ok(b2.backoffRemainingMs() === 4000, '连续失败 #3 → 4000ms');
  b2.fail('down');
  ok(b2.backoffRemainingMs() === 8000, '连续失败 #4 → 8000ms');
  b2.fail('down');
  ok(b2.backoffRemainingMs() === 8000, '连续失败 #5 → 封顶 8000ms（maxBackoffMs）');

  clock2 += 7999;
  ok((await b2.connect()) === false, '差 1ms 也不放行（确定性边界）');
  clock2 += 1;
  ok((await b2.connect()) === true, '到期即放行');
  ok(b2.bridgeStats().consecutiveFailures === 0, '连接成功清零失败计数');

  // 降级态：连接仍在、能力缩水——请求照常服务
  b2.markDegraded('能力协商降级：流式→轮询');
  ok(b2.connectionState === 'degraded', 'connected → degraded（半故障不掐线）');
  ok((await b2.request('probe', async () => 'alive')) === 'alive', '降级态请求照常执行（继续服务）');
  b2.fail('half-dead');
  ok(b2.connectionState === 'backoff', 'degraded 也可上报失败 → backoff（完整状态机）');
  b2.disconnect('session end');
  ok((await b2.connect()) === true, '显式断开重置退避 → 立即可重连（新会话不背旧退避）');

  const log = b2.transitionLog().map((t) => `${t.from}→${t.to}`);
  ok(log.includes('connected→degraded') && log.includes('degraded→backoff') && log.includes('backoff→connecting') && log.includes('connected→backoff'), `全状态覆盖审计：${log.join(' ')}（最近 100 条有界）`);
  ok(b2.transitionLog().every((t) => typeof t.reason === 'string' && t.reason.length > 0), '每条迁移都带 reason（可归因）');
}

// ═══════════════════ ⑤ 世界模型健康度：滚动命中率 + 重学习提示 ═══════════════════
section('⑤ 世界模型健康度：近期预测 vs 实际滚动命中率（vs 全史 MAE 口径）');

{
  const opts = { window: 30, hitTolerance: 1, minSamples: 8, relearnHitRate: 0.5 };
  const mk = (type, error, ts) => ({ type, predicted: 5, actual: 5 - error, error, timestamp: ts });

  // 空样本边界
  const empty = computeWorldHealth([], opts);
  ok(empty.samples === 0 && empty.needsRelearning === false && empty.confidence === 0, '空校准史：0 样本不告警（不无中生有）');

  // 80 好 + 20 坏：全史 MAE 看着健康，滚动命中率暴露近期崩坏
  const records = [];
  for (let i = 0; i < 80; i += 1) records.push(mk('deploy', 0.2, i));
  for (let i = 0; i < 20; i += 1) records.push(mk('deploy', 5.0, 100 + i));
  const oldMae = records.reduce((s, r) => s + r.error, 0) / records.length;
  const report = computeWorldHealth(records, opts);
  console.log(`    数字对照：80 好记录 + 20 坏记录——旧口径全史 MAE ${oldMae.toFixed(3)}（< 阈值 2 → 「健康」）/ 新口径近 ${report.samples} 条命中率 ${report.hitRate}（< 0.5 → needsRelearning=${report.needsRelearning}）`);
  ok(near(oldMae, 1.16, 1e-9), '旧口径 MAE = 1.16（平均值掩盖近期崩坏）');
  ok(report.samples === 30 && near(report.hitRate, 10 / 30, 1e-3), `滚动窗口只看最近 30 条：命中 10（前 10 好 + 后 20 坏）→ ${report.hitRate}（输出 4 位小数）`);
  ok(report.needsRelearning === true, `近期命中率 ${(10 / 30).toFixed(4)} < 0.5 且样本 30 ≥ 8 → needsRelearning（77.0 因果图 / 83.0 T̂ r̂ 应重估）`);
  ok(near(report.meanError, (10 * 0.2 + 20 * 5) / 30, 1e-6) && near(report.maxError, 5, 1e-9), `窗口内 MAE ${report.meanError.toFixed(4)} / 最大误差 ${report.maxError}`);

  // 窗口拉长 → 早期好数据稀释（窗口选择即口径，滚动才见「近期」）
  const wide = computeWorldHealth(records, { ...opts, window: 100 });
  ok(wide.samples === 100 && near(wide.hitRate, 0.8, 1e-9) && wide.needsRelearning === false, '窗口 100：命中率 0.8 → 不告警（全史口径 vs 滚动口径的差别即卖点）');

  // 按类型分解：最差置顶
  const mixed = [...Array(20)].map((_, i) => mk('stable-op', 0.2, i)).concat([...Array(10)].map((_, i) => mk('new-op', 6, 100 + i)));
  const perType = computeWorldHealth(mixed, opts);
  ok(perType.perType.length === 2 && perType.perType[0].type === 'new-op' && perType.perType[0].hitRate === 0, `按类型分解最差置顶：new-op 命中率 0 排第一（stable-op ${perType.perType[1].hitRate}）`);

  // 端到端：真实预测-对账回路喂出报告（未挂载 undefined → 挂载后出数）
  const wm = new WorldModel();
  ok(wm.worldHealthReport() === undefined, '未挂载健康度 → undefined（零介入）');
  wm.attachWorldHealth({ window: 10, hitTolerance: 1, minSamples: 1, relearnHitRate: 0.5 });
  const now = Date.now();
  for (let i = 0; i < 7; i += 1) wm.observeArrival('sig-x', now - 60_000 + i * 10_000); // 近 1 分钟 7 次到达
  wm.predictArrivals(60_000); // 预测窗口 [now, now+60s]：按 5 分钟率×热度×趋势外推（≤3.5）
  const settled = wm.settleCalibrations(now + 61_000); // 窗口结束后对账
  const report2 = wm.worldHealthReport();
  ok(settled.length === 1 && settled[0].actual === 7, `端到端对账：预测窗口内实际到达 7 次（预测 ${settled[0]?.predicted}——外推法对突发系统性低估，误差 ≥ 3.5 ≫ 容差）`);
  ok(report2.samples === 1 && report2.hitRate === 0 && report2.needsRelearning === true, `报告吃对账数据：命中率 0 → needsRelearning（低置信提示重学习，minSamples=1）`);
  ok(report2.perType[0].type === 'sig-x' && report2.confidence === 0, `置信度 ${report2.confidence}（命中率驱动：0 命中 → 0 置信）`);
}

// ═══════════════════ ⑥ 零漂移总检 ═══════════════════
section('⑥ 零漂移总检：新能力全挂载面化，既有口径逐位不变');

{
  const wm = new WorldModel();
  // 新 API 全部未挂载 → undefined
  ok(wm.observationBeliefs() === undefined && wm.observationVersion() === undefined && wm.worldHealthReport() === undefined, '新读数未挂载 → undefined');
  ok(wm.writeObservation('x', 1, 's') === undefined && wm.forgetObservation('x') === undefined, '新写入未挂载 → undefined（无副作用）');
  // 既有挂载面照常（56.0 BP / 前两轮成果未破坏）
  wm.attachBeliefPropagation();
  const fused = wm.fuseBeliefs({
    variables: [{ id: 'h', domain: 2, prior: [0.5, 0.5] }],
    factors: [{ scope: ['h'], table: [0.9, 0.1] }],
  });
  ok(fused !== undefined && near(fused.marginals.h[0], 0.9, 1e-6), '56.0 fuseBeliefs 挂载面照常（均匀先验 + 单因子 → 边缘 0.9）');
  ok(wm.causalDiscoveryView({ variables: [], samples: [] }) === undefined, '77.0 因果透镜未挂载 → undefined（原有诚实降级不变）');
  // 既有行为无形状漂移
  ok(Array.isArray(wm.predictArrivals()) && wm.predictArrivals().length === 0, '空模型 predictArrivals → []（原语义）');
  const summary = wm.getSummary();
  ok(summary.trackedTypes === 0 && summary.calibrationError === 0 && !('health' in summary), 'getSummary 形状无新增必填字段（零漂移）');
  wm.deserialize(wm.serialize());
  ok(wm.getSummary().trackedTypes === 0, 'serialize/deserialize 回路照常（观测融合态为运行时观测面，不入序列化——见汇报妥协）');
  // 挂载融合后既有路径也不受影响
  const wm2 = new WorldModel();
  wm2.attachObservationFusion({ snapshotDepth: 2 });
  wm2.observeArrival('legacy-signal', 1);
  wm2.writeObservation('m', 1, 's');
  ok(wm2.getSummary().trackedTypes === 1 && wm2.getSummary().totalArrivals === 1, '挂载观测融合后 observeArrival/getSummary 原口径不变（旁路隔离）');
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL 0 —— 世界模型/宿主融合/宿主桥 第三轮五项升级新旧行为对照验证成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
  process.exit(1);
}
