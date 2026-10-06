/**
 * verify-global-workspace.mjs — 96.0 全局工作空间内核 纯数学离线验证
 *
 * 七个验证锚点（不是「能跑」，是「算得对」——每个断言有解析解或
 * 脚本侧独立重算对照；随机只经内核 mulberry32(seed)，确定性可复现）:
 *   ① 硬 WTA（T=0）: 5 模块已知优先级函数 × 30 步序列，胜者逐位等于
 *      脚本侧独立 argmax 重算；缺省权重手算锚 0.25/0.30/0.20/0.25
 *   ② 点火阈值 θ: 投标全 ≤ θ 零广播（ignited 全 false / 总线空 / 零通知 /
 *      igniteRatio=0）；最高投标恰等于 θ 不点火（严格「超过」）；越过 θ
 *      当步立即点火；点火后回落总线驻留旧内容（无意识处理 = 现状驻留）
 *   ③ 广播级联: B 只在广播含 'anomaly' 时投标高、C 只认 'escalated'——
 *      burst → A 广播 → B 次轮起爆 → C 第三轮接力 → 第四轮熄灭
 *      （传播链 3 环 + 熄灭 + 无 burst 对照组零点火）
 *   ④ 不应期: 恒强 0.95 vs 恒中 0.6，ω=2、δ=0.5 → 胜者严格 A,B 交替
 *      （有效投标手算锚 0.2375/0.475）；ω=0 对照组 12 连胜（无不应期即
 *      垄断）；恢复曲线 0.25 → 0.5 → 1
 *   ⑤ 软 WTA: 4 模块 0.9/0.7/0.5/0.3，N=2000 步——熵 H(T) 随
 *      0→0.05→0.3→1→∞ 严格递增；T=0 熵 = 0；T→∞ 归一化熵 ≥ 0.995 且
 *      频次 ∈ 均匀 ±6%；T=0.3 分布与脚本侧独立 softmax 重算一致
 *   ⑥ 确定性: 同 seed 同输入 → 60 步轨迹与订阅者回调内部状态逐位一致；
 *      异 seed（T>0）轨迹分离；igniteRatio/winCounts/bidSummary 与脚本侧
 *      独立重算一致
 *   ⑦ 入参校验: 空/重复模块、θ/T/ω/δ 越界、NaN 投标、坏 signals、权重和
 *      ≠ 1、熵计数非正——全部显式 throw；分量越界饱和裁剪不 throw
 *
 * 运行: node --experimental-strip-types scripts/verify-global-workspace.mjs
 */

import {
  GlobalWorkspace,
  defaultPriority,
  makeLinearPriority,
  DEFAULT_PRIORITY_WEIGHTS,
  shannonEntropyBits,
} from '../src/core/global-workspace.ts';

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
function near(a, b, tol = 1e-6) {
  return Math.abs(a - b) <= tol;
}
function section(title) {
  console.log(`\n■ ${title}`);
}
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const frac = (x) => x - Math.floor(x);
const flat = (v) => ({ novelty: v, relevance: v, confidence: v, urgency: v });

// ═══════════════════ ① 硬 WTA（T=0） ═══════════════════

section('① 硬 WTA（T=0）：胜者逐位等于脚本侧独立 argmax 重算');

{
  // 缺省优先级权重手算锚（文档化常数的独立对照）
  ok(near(defaultPriority({ novelty: 1, relevance: 0, confidence: 0, urgency: 0 }), 0.25, 1e-12), 'defaultPriority: novelty 单位权重 = 0.25');
  ok(near(defaultPriority({ novelty: 0, relevance: 1, confidence: 0, urgency: 0 }), 0.3, 1e-12), 'defaultPriority: relevance 单位权重 = 0.30');
  ok(near(defaultPriority({ novelty: 0, relevance: 0, confidence: 1, urgency: 0 }), 0.2, 1e-12), 'defaultPriority: confidence 单位权重 = 0.20');
  ok(near(defaultPriority({ novelty: 0, relevance: 0, confidence: 0, urgency: 1 }), 0.25, 1e-12), 'defaultPriority: urgency 单位权重 = 0.25');
  const wSum = DEFAULT_PRIORITY_WEIGHTS.novelty + DEFAULT_PRIORITY_WEIGHTS.relevance + DEFAULT_PRIORITY_WEIGHTS.confidence + DEFAULT_PRIORITY_WEIGHTS.urgency;
  ok(near(wSum, 1, 1e-12), `DEFAULT_PRIORITY_WEIGHTS 四项和 = 1（${wSum}）——优先级输出 ∈ [0,1]`);

  // 5 模块已知优先级函数（确定性伪随机四元组，步序驱动）
  const comps = (i, step) => ({
    novelty: frac(0.13 * (i + 1) * (step + 3)),
    relevance: frac(0.29 * (2 * i + 1) * (step + 1)),
    confidence: 0.4 + 0.5 * frac(0.71 * (i + 2) * (step + 2)),
    urgency: frac(0.37 * (i + 1) * (step + 5)),
  });
  const modules = [0, 1, 2, 3, 4].map((i) => ({ id: `m${i}`, priorityFn: (ctx) => comps(i, ctx.step) }));
  const ws = new GlobalWorkspace({ modules, threshold: 0, temperature: 0, refractory: 0, seed: 1 });
  const results = [];
  for (let k = 0; k < 30; k += 1) {
    results.push(ws.step({ signals: [`s${k % 5}`], goal: k % 2 === 0 ? 'explore' : 'exploit' }));
  }

  let allArgmax = true;
  let allPriority = true;
  let allIgnited = true;
  let mismatch = '';
  for (let k = 0; k < 30; k += 1) {
    // 脚本侧独立重算：四元组 → 线性合成 → argmax（不经过内核任何代码）
    const bids = [0, 1, 2, 3, 4].map((i) => {
      const c = comps(i, k);
      return 0.25 * c.novelty + 0.3 * c.relevance + 0.2 * c.confidence + 0.25 * c.urgency;
    });
    const argmax = bids.indexOf(Math.max(...bids));
    if (results[k].winner !== `m${argmax}`) {
      allArgmax = false;
      mismatch = `step${k}: 内核 ${results[k].winner} vs 独立重算 m${argmax}`;
    }
    results[k].bids.forEach((b, i) => {
      if (Math.abs(b.priority - bids[i]) > 1e-6) allPriority = false;
    });
    if (!results[k].ignited) allIgnited = false;
  }
  ok(allArgmax && mismatch === '', `30 步胜者逐位 = 脚本侧独立 argmax（${mismatch || '全部一致'}）`);
  ok(allPriority, '30 步 × 5 模块投标值与脚本侧线性合成一致（容差 1e-6）');
  ok(allIgnited, 'θ=0 且投标恒正 → 每步点火（全候选参与）');
  ok(new Set(results.map((r) => r.winner)).size >= 3, `胜者随上下文轮换（30 步覆盖 ≥3 个模块，实际 ${new Set(results.map((r) => r.winner)).size} 个）`);
  ok(
    results[0].winnerDistribution.length === 1 && results[0].winnerDistribution[0].id === results[0].winner && results[0].winnerDistribution[0].p === 1,
    '硬 WTA 的 winnerDistribution = 胜者单点 p=1',
  );
  ok(
    results[0].notified.length === 4 && !results[0].notified.includes(results[0].winner) && results[0].notified.join(',') === ['m0', 'm1', 'm2', 'm3', 'm4'].filter((id) => id !== results[0].winner).join(','),
    'notified = 除胜者外全部模块（4/5，按模块注册序）',
  );
}

// ═══════════════════ ② 点火阈值 ═══════════════════

section('② 点火阈值 θ：低于不广播、恰等于不点火、越过立即广播、回落驻留');

{
  // 注入恒等优先级（relevance 直通——数值干净，等值边缘可精确构造）
  const identity = makeLinearPriority({ novelty: 0, relevance: 1, confidence: 0, urgency: 0 });
  const mk = () => [
    { id: 'low', priorityFn: () => ({ novelty: 0, relevance: 0.55, confidence: 0, urgency: 0 }) },
    { id: 'edge', priorityFn: () => ({ novelty: 0, relevance: 0.6, confidence: 0, urgency: 0 }) },
    {
      id: 'situ',
      priorityFn: (ctx) => ({ novelty: 0, relevance: ctx.signals.includes('alarm') ? 0.75 : 0.45, confidence: 0, urgency: 0 }),
    },
  ];
  const ws = new GlobalWorkspace({ modules: mk(), threshold: 0.6, temperature: 0, refractory: 0, priorityFn: identity, seed: 3 });

  const quiet1 = ws.step({});
  const quiet2 = ws.step({ signals: ['routine'] });
  ok(quiet1.ignited === false && quiet2.ignited === false, '投标 {0.55, 0.6, 0.45} 全 ≤ θ=0.6：零广播（ignited=false，无意识处理）');
  ok(quiet1.broadcast === undefined && quiet1.winner === undefined && quiet1.notified.length === 0 && quiet1.winnerDistribution.length === 0,
    '总线空：winner / broadcast / notified / winnerDistribution 全空');
  ok(quiet2.bids[1].priority === 0.6 && quiet2.bids[1].eligible === false, '最高投标恰等于 θ=0.6 仍不点火（「超过」取严格不等号）');
  ok(ws.igniteRatio() === 0 && ws.totalSteps() === 2, 'igniteRatio = 0、totalSteps = 2（脚本侧独立重算）');

  const fire = ws.step({ signals: ['alarm'] });
  ok(fire.ignited === true && fire.winner === 'situ', 'alarm 信号当步投标 0.75 > θ=0.6 → 立即点火且胜者为 situ（越过即广播）');
  ok(near(fire.broadcast.effectiveBid, 0.75, 1e-9) && fire.broadcast.sourceId === 'situ' && fire.broadcast.tags.join(',') === 'situ',
    '广播内容：有效投标 0.75 + 缺省标签 [sourceId]（未提供 describe）');
  ok(fire.notified.join(',') === 'low,edge' && fire.bids.every((b) => b.refractoryFactor === 1), '通知除胜者外全部订阅者；ω=0 无不应期折扣');
  ok(fire.bids.filter((b) => b.eligible).length === 1, '点火候选只有 situ（0.55/0.6/0.45 均不超阈）');

  const after = ws.step({});
  ok(after.ignited === false && after.broadcast.sourceId === 'situ' && after.broadcast.step === 2 && after.notified.length === 0,
    '回落后不点火：总线驻留上一广播（step=2 的 situ 内容，维持现状），不再通知');
  ok(near(ws.igniteRatio(), 0.25, 1e-9), `igniteRatio = 1/4 = ${ws.igniteRatio()}（脚本侧独立重算）`);
}

// ═══════════════════ ③ 广播级联 ═══════════════════

section('③ 广播级联：广播内容作为上下文改变次轮 relevance（A→B→C 传播链）');

{
  const low = () => ({ novelty: 0.1, relevance: 0.1, confidence: 0.1, urgency: 0.1 });
  const mkChain = () => [
    {
      id: 'A',
      describe: () => ['anomaly', 'sentinel'],
      priorityFn: (ctx) => (ctx.signals.includes('burst') ? { novelty: 0.9, relevance: 0.8, confidence: 0.9, urgency: 0.7 } : low()),
    },
    {
      id: 'B',
      describe: () => ['escalated', 'reflection'],
      priorityFn: (ctx, bc) => (bc.active && bc.tags.includes('anomaly') ? { novelty: 0.5, relevance: 0.9, confidence: 0.6, urgency: 0.5 } : low()),
    },
    {
      id: 'C',
      describe: () => ['contained', 'symbiosis'],
      priorityFn: (ctx, bc) => (bc.active && bc.tags.includes('escalated') ? { novelty: 0.4, relevance: 0.85, confidence: 0.5, urgency: 0.8 } : low()),
    },
  ];
  const ws = new GlobalWorkspace({ modules: mkChain(), threshold: 0.45, temperature: 0, refractory: 0, seed: 5 });

  const r0 = ws.step({});
  const r1 = ws.step({});
  ok(!r0.ignited && !r1.ignited, '静默两步：全体 0.1 < θ=0.45 零点火（总线空）');

  const r2 = ws.step({ signals: ['burst'] });
  ok(r2.ignited && r2.winner === 'A' && r2.broadcast.tags.includes('anomaly'), 'burst 步：A 以 0.82 点火广播 [anomaly, sentinel]（级联第 1 环）');
  ok(near(r2.broadcast.effectiveBid, 0.82, 1e-6) && near(r2.bids.find((b) => b.id === 'B').priority, 0.1, 1e-9),
    '广播前 B 的投标仍低（0.1）——A 的内容尚未成为上下文');

  const r3 = ws.step({});
  const bBid = r3.bids.find((b) => b.id === 'B').priority;
  ok(r3.ignited && r3.winner === 'B' && near(bBid, 0.64, 1e-6),
    `次轮 B 以广播为上下文重算 relevance → 0.64 起爆胜出（实测 ${bBid}；级联第 2 环）`);
  ok(r3.broadcast.tags.includes('escalated') && r3.bids.find((b) => b.id === 'C').priority === 0.1,
    'B 广播 [escalated, reflection]；同拍 C 仍低（tags 不含 escalated）');

  const r4 = ws.step({});
  ok(r4.ignited && r4.winner === 'C' && near(r4.bids.find((b) => b.id === 'C').priority, 0.655, 1e-6),
    '第三轮 C 接力（0.655 > θ=0.45；级联第 3 环）');

  const r5 = ws.step({});
  ok(!r5.ignited && r5.broadcast.sourceId === 'C', '第四轮无人再超阈 → 级联熄灭：总线驻留 C 的广播（无意识处理）');

  // 对照组：无首环点火则永不幸级联
  const ctrl = new GlobalWorkspace({ modules: mkChain(), threshold: 0.45, temperature: 0, refractory: 0, seed: 5 });
  const ctrlSeq = [{}, {}, {}, {}, {}, {}].map((s) => ctrl.step(s));
  ok(ctrlSeq.every((r) => !r.ignited) && ctrl.igniteRatio() === 0, '对照组（无 burst 信号）：6 步零点火——级联必须有首环点火');
}

// ═══════════════════ ④ 不应期 ═══════════════════

section('④ 不应期：恒强模块的垄断被 ω 步冷却打断（胜者轮换）');

{
  const mk = () => [
    { id: 'strong', priorityFn: () => flat(0.95) },
    { id: 'middler', priorityFn: () => flat(0.6) },
  ];
  const ws = new GlobalWorkspace({ modules: mk(), threshold: 0.1, temperature: 0, refractory: 2, refractoryFactor: 0.5, seed: 7 });
  const seq = Array.from({ length: 12 }, () => ws.step({}));
  const winners = seq.map((r) => r.winner);
  const expect = ['strong', 'middler', 'strong', 'middler', 'strong', 'middler', 'strong', 'middler', 'strong', 'middler', 'strong', 'middler'];
  ok(JSON.stringify(winners) === JSON.stringify(expect), `ω=2 冷却 → 胜者严格 A,B 交替（${winners.join(',')}）`);
  ok(seq.every((r, i) => i === 0 || r.winner !== seq[i - 1].winner), '无任何模块连续两步胜出（垄断被打断——胜者轮换断言）');

  const s1 = seq[1].bids.find((b) => b.id === 'strong');
  const s2 = seq[2].bids.find((b) => b.id === 'strong');
  ok(near(s1.refractoryFactor, 0.25, 1e-12) && near(s1.effectiveBid, 0.2375, 1e-9),
    '手算锚：距胜 1 步折扣 δ^(ω+1−1)=0.5²=0.25 → 有效投标 0.95×0.25=0.2375');
  ok(near(s2.refractoryFactor, 0.5, 1e-12) && near(s2.effectiveBid, 0.475, 1e-9),
    '距胜 2 步折扣 δ^1=0.5 → 0.475（ω 步末恢复到 δ）');

  // 对照：ω=0 无不应期 → 恒强垄断
  const ws0 = new GlobalWorkspace({ modules: mk(), threshold: 0.1, temperature: 0, refractory: 0, seed: 7 });
  const seq0 = Array.from({ length: 12 }, () => ws0.step({}));
  ok(seq0.every((r) => r.winner === 'strong') && seq0.every((r) => r.bids.every((b) => b.refractoryFactor === 1)),
    '对照 ω=0：恒强模块 12 连胜且折扣恒 1（无不应期即垄断——ω 的存在性证明）');

  // 恢复曲线：一次性 flash 胜者后静默，折扣 0.25 → 0.5 → 1
  const rec = new GlobalWorkspace({
    modules: [
      { id: 'flash', priorityFn: (ctx) => (ctx.step === 0 ? flat(0.9) : flat(0.1)) },
      { id: 'floor', priorityFn: () => flat(0.2) },
    ],
    threshold: 0.1,
    temperature: 0,
    refractory: 2,
    refractoryFactor: 0.5,
    seed: 11,
  });
  const recSeq = [{}, {}, {}, {}].map((s) => rec.step(s));
  const flashFactors = recSeq.map((r) => r.bids.find((b) => b.id === 'flash').refractoryFactor);
  ok(recSeq[0].winner === 'flash' && near(flashFactors[1], 0.25, 1e-12) && near(flashFactors[2], 0.5, 1e-12) && flashFactors[3] === 1,
    `不应期恢复曲线 δ^(ω+1−s)：s=1,2,3 → ${flashFactors.join(' → ')}（ω 步后完全恢复 ×1）`);
}

// ═══════════════════ ⑤ 软 WTA ═══════════════════

section('⑤ 软 WTA：温度单调摊薄注意力，T→∞ → 均匀（熵极限锚）');

{
  const mk = () => [0.9, 0.7, 0.5, 0.3].map((v, i) => ({ id: `m${i}`, priorityFn: () => flat(v) }));
  const N = 2000;
  const runT = (T) => {
    const ws = new GlobalWorkspace({ modules: mk(), threshold: 0.05, temperature: T, refractory: 0, seed: 20260101 });
    const traj = ws.runSequence(Array.from({ length: N }, () => ({})));
    const counts = traj.winCounts.map((w) => w.wins);
    return { traj, counts, normH: traj.maxEntropyBits > 0 ? traj.entropyBits / traj.maxEntropyBits : 0 };
  };

  const hard = runT(0);
  ok(hard.traj.entropyBits === 0 && hard.counts[0] === N,
    `T=0：最高投标模块全胜（[${hard.counts.join(', ')}]）→ 熵 = 0（串行注意力焦点）`);

  const t005 = runT(0.05);
  const t03 = runT(0.3);
  const t1 = runT(1);
  const tinf = runT(1e9);
  ok(t005.normH > 0 && t005.normH < 0.15, `T=0.05 低温软分配仍聚焦：归一化熵 ${t005.normH.toFixed(4)} ∈ (0, 0.15)`);
  ok(t03.normH > t005.normH + 0.3, `熵随温度单调上升：H(0.05)=${t005.normH.toFixed(4)} < H(0.3)=${t03.normH.toFixed(4)}（差 > 0.3）`);
  ok(t1.normH > t03.normH, `H(0.3)=${t03.normH.toFixed(4)} < H(1)=${t1.normH.toFixed(4)}`);
  ok(tinf.normH >= 0.995, `T=1e9 → 归一化熵 ${tinf.normH.toFixed(6)} ≥ 0.995（T→∞ 均匀极限锚）`);
  ok(tinf.counts.every((c) => Math.abs(c - N / 4) <= 0.06 * N),
    `T=1e9 各模块频次 ∈ 均匀 ±6%：[${tinf.counts.join(', ')}] vs 均匀 ${N / 4}`);
  ok(hard.traj.entropyBits < t005.traj.entropyBits && t005.traj.entropyBits < t03.traj.entropyBits && t03.traj.entropyBits < t1.traj.entropyBits && t1.traj.entropyBits < tinf.traj.entropyBits,
    `熵全链严格递增：0 < ${t005.traj.entropyBits} < ${t03.traj.entropyBits} < ${t1.traj.entropyBits} < ${tinf.traj.entropyBits}（bit）`);

  // T=0.3 的 softmax 分布 vs 脚本侧独立重算（解析锚）
  const ws03 = new GlobalWorkspace({ modules: mk(), threshold: 0.05, temperature: 0.3, refractory: 0, seed: 77 });
  const step03 = ws03.step({});
  const z = [0.9, 0.7, 0.5, 0.3].map((e) => Math.exp(e / 0.3));
  const zSum = z.reduce((a, b) => a + b, 0);
  const probs = z.map((v) => v / zSum);
  ok(step03.winnerDistribution.every((d, i) => near(d.p, probs[i], 1e-6)),
    `T=0.3 winnerDistribution 与独立 softmax 重算一致（[${step03.winnerDistribution.map((d) => d.p).join(', ')}]）`);
  ok(near(step03.winnerDistribution.reduce((s, d) => s + d.p, 0), 1, 1e-5), '分布归一（Σp = 1）');

  // T→∞ 的分布逐点 ≈ 均匀
  const wsInf = new GlobalWorkspace({ modules: mk(), threshold: 0.05, temperature: 1e9, refractory: 0, seed: 78 });
  const stepInf = wsInf.step({});
  ok(stepInf.winnerDistribution.every((d) => near(d.p, 0.25, 1e-6)), 'T=1e9 分布逐点 = 0.25（均匀）');
  ok(near(shannonEntropyBits([250, 250, 250, 250]), 2, 1e-9), `熵工具锚：shannonEntropyBits(均匀×4) = 2 bit（实测 ${shannonEntropyBits([250, 250, 250, 250])}）`);

  // 同 seed 同 T 重放 → 胜者序列逐位一致（采样确定性）
  const replayA = runT(1);
  const replayB = runT(1);
  ok(
    JSON.stringify(replayA.traj.steps.map((s) => s.winner)) === JSON.stringify(replayB.traj.steps.map((s) => s.winner)),
    '同 seed 同 T 重放 N=2000 步胜者序列逐位一致（softmax 采样确定性）',
  );
}

// ═══════════════════ ⑥ 确定性与统计 ═══════════════════

section('⑥ 确定性：同 seed 逐位一致、异 seed 分离、统计与独立重算一致');

{
  // 模块工厂：带订阅者内部状态（received 计数 + 最后标签）——确定性副作用
  const makeFleet = () => {
    const counters = new Map();
    const modules = ['sentinel', 'decide', 'reflect', 'evolve', 'symbio'].map((name, i) => {
      counters.set(name, { received: 0, lastTags: '' });
      return {
        id: name,
        priorityFn: (ctx, bc) => ({
          novelty: frac(0.31 * (i + 1) * (ctx.step + 2)) * (bc.active ? 1 : 0.8),
          relevance: bc.active && bc.tags.length > 0 ? 0.5 + 0.4 * frac(0.57 * (i + 1) * (ctx.step + 1)) : 0.2,
          confidence: 0.3 + 0.6 * frac(0.43 * (i + 2) * (ctx.step + 3)),
          urgency: (i + 1) / 6,
        }),
        onBroadcast: (content) => {
          const c = counters.get(name);
          c.received += 1;
          c.lastTags = content.tags.join('|');
        },
      };
    });
    return { modules, counters };
  };
  const mkSignals = () => {
    const r = mulberry32(99);
    return Array.from({ length: 60 }, (_, k) => ({
      signals: [`tick-${k}`, r() < 0.3 ? 'spike' : 'calm'],
      goal: k % 3 === 0 ? 'hardening' : undefined,
    }));
  };
  const signals = mkSignals();
  const run = (seed) => {
    const fleet = makeFleet();
    const ws = new GlobalWorkspace({ modules: fleet.modules, threshold: 0.35, temperature: 0.25, refractory: 1, seed });
    const traj = ws.runSequence(signals);
    const digest = traj.steps
      .map((s) => `${s.step}:${s.winner ?? '-'}:${s.ignited ? 1 : 0}:${s.bids.map((b) => b.effectiveBid.toFixed(6)).join(',')}`)
      .join(';');
    const counterState = [...fleet.counters.entries()].map(([k, v]) => `${k}:${v.received}:${v.lastTags}`).join(';');
    return { digest, counterState, traj, ws };
  };

  const a1 = run(7);
  const a2 = run(7);
  const bSeed = run(8);

  ok(a1.digest === a2.digest, '同 seed(7) 同输入：60 步轨迹（胜者/点火/逐步有效投标）逐位一致');
  ok(a1.counterState === a2.counterState && [...makeFleet().counters.keys()].length === 5,
    '订阅者回调内部状态（收到次数 + 最后标签）两次运行逐位一致（广播回调纯确定性）');
  const totalReceived = a1.counterState.split(';').reduce((s, part) => s + Number(part.split(':')[1]), 0);
  ok(totalReceived > 0, `订阅者确实收到广播（合计 ${totalReceived} 次 > 0）`);
  ok(a1.digest !== bSeed.digest, '异 seed(8)（T=0.25 > 0）轨迹分离（采样对种子敏感）');

  const ignitedManual = a1.traj.steps.filter((s) => s.ignited).length;
  ok(ignitedManual > 0 && near(a1.traj.igniteRatio, ignitedManual / 60, 1e-9),
    `igniteRatio 与手动重算一致（${ignitedManual}/60 = ${a1.traj.igniteRatio}）`);
  const winsManual = new Map();
  a1.traj.steps.forEach((s) => {
    if (s.winner) winsManual.set(s.winner, (winsManual.get(s.winner) ?? 0) + 1);
  });
  ok(a1.traj.winCounts.every((w) => (winsManual.get(w.id) ?? 0) === w.wins) && a1.traj.winCounts.length === 5,
    'winCounts 与手动重算一致（5 模块全覆盖）');

  const summary = a1.ws.bidSummary();
  const meanOk = summary.every((e) => {
    const bids = a1.traj.steps.map((s) => s.bids.find((b) => b.id === e.id).priority);
    const mean = bids.reduce((s, v) => s + v, 0) / bids.length;
    return e.samples === 60 && near(e.meanPriority, mean, 1e-5) && e.wins === (winsManual.get(e.id) ?? 0);
  });
  ok(meanOk, 'bidSummary：samples=60、meanPriority 与轨迹独立重算一致、wins 一致');

  // reset 后同 seed 复放逐位一致
  a1.ws.reset();
  const replay = a1.ws.runSequence(signals);
  const replayDigest = replay.steps
    .map((s) => `${s.step}:${s.winner ?? '-'}:${s.ignited ? 1 : 0}:${s.bids.map((b) => b.effectiveBid.toFixed(6)).join(',')}`)
    .join(';');
  ok(replayDigest === a1.digest, 'reset() 回种后复放：轨迹逐位一致（RNG 重播种契约）');
}

// ═══════════════════ ⑦ 入参校验 ═══════════════════

section('⑦ 入参校验：显式 throw 与饱和裁剪');

{
  const valid = () => [{ id: 'a', priorityFn: () => flat(0.5) }];
  ok(throws(() => new GlobalWorkspace({ modules: [] })), '空模块数组 throw');
  ok(throws(() => new GlobalWorkspace({ modules: [...valid(), ...valid()] })), '重复模块 id throw（两个 a）');
  ok(throws(() => new GlobalWorkspace({ modules: [{ id: '', priorityFn: () => flat(0.5) }] })), '空 id throw');
  ok(throws(() => new GlobalWorkspace({ modules: [{ id: 'a' }] })), '缺 priorityFn throw');
  ok(throws(() => new GlobalWorkspace({ modules: valid(), threshold: 1.2 })), 'θ > 1 throw');
  ok(throws(() => new GlobalWorkspace({ modules: valid(), threshold: -0.01 })), 'θ < 0 throw');
  ok(throws(() => new GlobalWorkspace({ modules: valid(), threshold: Number.NaN })), 'θ = NaN throw');
  ok(throws(() => new GlobalWorkspace({ modules: valid(), temperature: -0.5 })), 'T < 0 throw');
  ok(throws(() => new GlobalWorkspace({ modules: valid(), temperature: Number.POSITIVE_INFINITY })), 'T = ∞ throw');
  ok(throws(() => new GlobalWorkspace({ modules: valid(), refractory: 1.5 })), 'ω 非整数 throw');
  ok(throws(() => new GlobalWorkspace({ modules: valid(), refractory: -1 })), 'ω < 0 throw');
  ok(throws(() => new GlobalWorkspace({ modules: valid(), refractoryFactor: 0 })), 'δ = 0 throw（开区间 (0,1)）');
  ok(throws(() => new GlobalWorkspace({ modules: valid(), refractoryFactor: 1 })), 'δ = 1 throw（开区间 (0,1)）');
  const wsNaN = new GlobalWorkspace({
    modules: [{ id: 'a', priorityFn: () => ({ novelty: Number.NaN, relevance: 0, confidence: 0, urgency: 0 }) }],
  });
  ok(throws(() => wsNaN.step({})), 'priorityFn 返回 NaN 分量 throw（step 时逐分量校验）');
  const wsPNan = new GlobalWorkspace({ modules: valid(), priorityFn: () => Number.NaN });
  ok(throws(() => wsPNan.step({})), '注入的优先级函数返回 NaN throw（step 时校验）');
  ok(throws(() => new GlobalWorkspace({ modules: valid(), priorityFn: 'x' })), 'priorityFn 非函数 throw');
  ok(throws(() => new GlobalWorkspace({ modules: [{ id: 'a', priorityFn: () => flat(0.5), describe: 'x' }] })), 'describe 非函数 throw');
  ok(throws(() => new GlobalWorkspace({ modules: [{ id: 'a', priorityFn: () => flat(0.5), onBroadcast: 3 }] })), 'onBroadcast 非函数 throw');

  const wsSteps = new GlobalWorkspace({ modules: valid(), seed: 1 });
  ok(throws(() => wsSteps.step({ signals: [42] })), 'signals 含非字符串 throw');
  ok(throws(() => wsSteps.step(null)), 'signal = null throw');
  ok(throws(() => wsSteps.step({ goal: 7 })), 'goal 非字符串 throw');
  ok(throws(() => wsSteps.runSequence('nope')), 'runSequence 非数组 throw');

  ok(throws(() => makeLinearPriority({ novelty: 0.5, relevance: 0.2, confidence: 0.2, urgency: 0.2 })), '权重和 ≠ 1 throw（1.1）');
  ok(throws(() => makeLinearPriority({ novelty: -0.25, relevance: 0.45, confidence: 0.55, urgency: 0.25 })), '负权重 throw');
  ok(throws(() => shannonEntropyBits([1, -1])), '熵计数负值 throw');
  ok(throws(() => shannonEntropyBits([0, 0])), '熵计数全零 throw');

  // 越界饱和裁剪（不 throw，夹回 [0,1]）
  const wsSat = new GlobalWorkspace({
    modules: [{ id: 'sat', priorityFn: () => ({ novelty: 1.7, relevance: -0.3, confidence: 0.5, urgency: 0.5 }) }],
    threshold: 0.5,
    seed: 1,
  });
  const satStep = wsSat.step({});
  ok(
    satStep.bids[0].components.novelty === 1 && satStep.bids[0].components.relevance === 0,
    '分量越界饱和裁剪（1.7 → 1，−0.3 → 0）而非 throw',
  );
  ok(near(satStep.bids[0].priority, 0.475, 1e-9), `裁剪后优先级 = 0.25×1 + 0.20×0.5 + 0.25×0.5 = 0.475（实测 ${satStep.bids[0].priority}）`);
  ok(satStep.ignited === false && satStep.bids[0].eligible === false, '0.475 ≤ θ=0.5 → 不点火（饱和语义不抬高投标）');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 96.0 全局工作空间内核数学验证成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
