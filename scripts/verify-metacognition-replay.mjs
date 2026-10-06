/**
 * verify-metacognition-replay.mjs — 内省双件套「97.0 元认知信心 + 98.0 经验重放」纯数学离线验证
 *
 * 每个内核的数学核心都有解析解对照（不是「能跑」，是「算得对」）：
 *   97.0 元认知信心（二阶信号检测论）:
 *     ① 一阶 d′ 恢复: 已知 d=1.5 / 0.6 的种子化工厂，typeOneDprime 从
 *        命中/虚报计数恢复 d̂′ = d ± 0.1（对数线性稳定化），命中率对照
 *        解析值 Φ(d/2)；全中/全虚报的退化计数仍有限（无 ±∞ 路径）
 *     ② meta-d′ 四象限分离: 高元认知象限（metaD = d，零元认知噪声）
 *        meta-d′̂ ≈ d（型-2 ROC 面积反演的自洽基准）；判别好但自知差的
 *        象限（metaD 压低）meta-d′̂ 显著低于 d——「知道自己不知道」被量化
 *     ③ 最优 ask 阈值: 闭式 c* 与 [0,1] 全阈值枚举的期望成本最优一致
 *        （解析驻点 P(error|c*) = costAsk/costError 精确到 1e-9；
 *        costError=10/costAsk=3/priorError=0.3 时 c* = 0.5 恰为解析特例）
 *     ④ P(error|c) 随信心分桶单调下降（violations = 0），高元认知数据的
 *        信心-对错 Spearman 显著强于低元认知数据
 *     ⑤ 退化为 75.0 接口: (信心, 对错) 对做分桶经验重映射（mini 校准器，
 *        前半映射/后半验收的 split-half 口径）后 held-out ECE 下降 ≥ 50%
 *        ——ECE 在本脚本独立实现（75.0 的 CalibrationPair 口径），不 import 75.0
 *   98.0 经验重放（PER + 睡眠固化）:
 *     ① rank-based 优先采样: α=1 时 |TD|-频率 Spearman > 0.95，
 *        top-20% |TD| 采样份额随 α ∈ {0, 0.5, 1} 严格递增（0.23 < 0.42 < 0.74，
 *        理论值 1/5 < 0.447 < 0.707）；α=0 概率逐条精确 1/N、IS 原始权重恒 1
 *     ② IS 权重（β=1）无偏性: 三臂 bandit（μ = 0.9/0.5/0.1，|TD| 偏向
 *        高回报）逐臂加权估值收敛到真值 ± 0.03，无修正对照系统性偏高
 *        （平均偏置 > 3× 修正口径）
 *     ③ 睡眠固化: 缓冲区长度 1000 → 1000（零新数据）、samplesUsed =
 *        rounds×batch、策略价值 0.2 → 0.8（未消化经验被离线消化，+0.6）
 *     ④ 灾难遗忘对照（招牌）: 任务 A→B 流式（好臂相反的矛盾结构），
 *        无重放 A 性能跌 88.9%（V → B 真值，greedy 臂翻错）；分层重放
 *        （每条 B 新样本配 2 条 A 层重放）A 保持 100%（V 收敛到
 *        (2μ_A+μ_B)/3 凸组合，greedy 臂不翻）——三种子全部 protected
 *     ⑤ 环形容量守恒（2500 条洪峰后 size === capacity）与分层公平
 *        （600 条 A 之后 1200 条 B 涌入，A 层仍存活 300 条——单一全局环
 *        已清零的对照口径；三任务洪峰下配额 200×3 精确守恒）
 *
 * 全部断言确定性（两个内核各自文件内 mulberry32 + Box–Muller，同 seed 同输出；
 * 脚本侧构造性随机也走本脚本 mulberry32）。运行:
 *   node --experimental-strip-types scripts/verify-metacognition-replay.mjs
 */

import {
  typeOneDprime,
  metaDprime,
  confidenceAccuracyCurve,
  optimalAskThreshold,
  shouldAsk,
  posteriorErrorProbability,
  simulateMetacognition,
  normalCdf,
} from '../src/core/metacognitive-confidence.ts';
import {
  PrioritizedReplay,
  makeBanditTask,
  continualTaskStream,
  sleepConsolidation,
  SgdBanditLearner,
  WeightedBanditLearner,
  rehearsalVsNone,
} from '../src/core/experience-replay.ts';

// ─────────────────────────── 断言工具（verify-genesis-kernels.mjs 风格） ───────────────────────────
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

/** 确定性 RNG（mulberry32，脚本侧构造性随机唯一来源） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Spearman 秩相关（平局平均秩；下标追踪，无 indexOf 歧义） */
function spearman(xs, ys) {
  const n = xs.length;
  const rankOf = (values) => {
    const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
    const ranks = new Array(n);
    let p = 0;
    while (p < n) {
      let q = p;
      while (q + 1 < n && order[q + 1].v === order[p].v) q += 1;
      const avg = (p + q) / 2 + 1;
      for (let k = p; k <= q; k += 1) ranks[order[k].i] = avg;
      p = q + 1;
    }
    return ranks;
  };
  const rx = rankOf(xs);
  const ry = rankOf(ys);
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i += 1) {
    mx += rx[i];
    my += ry[i];
  }
  mx /= n;
  my /= n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

/** ECE（75.0 calibrationError 同口径的独立实现: 等宽分桶 |平均置信 − 实测|） */
function ece(pairs, bins = 10) {
  const n = Array.from({ length: bins }, () => 0);
  const sp = Array.from({ length: bins }, () => 0);
  const sy = Array.from({ length: bins }, () => 0);
  for (const p of pairs) {
    const i = Math.min(bins - 1, Math.floor(p.p * bins));
    n[i] += 1;
    sp[i] += p.p;
    sy[i] += p.y;
  }
  let e = 0;
  for (let b = 0; b < bins; b += 1) {
    if (n[b] > 0) e += (n[b] / pairs.length) * Math.abs(sp[b] / n[b] - sy[b] / n[b]);
  }
  return e;
}

// ═══════════════════ 97.0 元认知信心内核 ═══════════════════

section('97.0 一阶 d′: 已知敏感度工厂的恢复（锚点①）');

{
  const ds = simulateMetacognition({ d: 1.5, metaD: 1.5, trials: 20000, seed: 11 });
  const t1 = typeOneDprime(ds.counts.hits, ds.counts.falseAlarms, ds.counts.nSignal, ds.counts.nNoise);
  ok(
    Math.abs(t1.dprime - 1.5) <= 0.1,
    `d=1.5 工厂: d̂′=${t1.dprime.toFixed(4)}（|Δ|=${Math.abs(t1.dprime - 1.5).toFixed(4)} ≤ 0.1，命中 ${ds.counts.hits}/${ds.counts.nSignal}、虚报 ${ds.counts.falseAlarms}/${ds.counts.nNoise}）`,
  );
  ok(
    near(t1.hitRate, normalCdf(0.75), 0.01),
    `命中率 ${t1.hitRate.toFixed(4)} ≈ Φ(d/2)=Φ(0.75)=${normalCdf(0.75).toFixed(4)}（解析对照）`,
  );
  ok(
    Math.abs(t1.criterion) <= 0.05,
    `判定偏置 c=${t1.criterion.toFixed(4)} ≈ 0（阈值取 0 的无偏观察者）`,
  );
  const dsWeak = simulateMetacognition({ d: 0.6, metaD: 0.6, trials: 20000, seed: 12 });
  const t1w = typeOneDprime(dsWeak.counts.hits, dsWeak.counts.falseAlarms, dsWeak.counts.nSignal, dsWeak.counts.nNoise);
  ok(
    Math.abs(t1w.dprime - 0.6) <= 0.1,
    `d=0.6 工厂: d̂′=${t1w.dprime.toFixed(4)}（|Δ|=${Math.abs(t1w.dprime - 0.6).toFixed(4)} ≤ 0.1）`,
  );
  // 对数线性稳定化: 退化计数（全中 + 零虚报）不产生 ±∞
  const degenerate = typeOneDprime(100, 0, 100, 100);
  ok(
    Number.isFinite(degenerate.dprime) && degenerate.dprime > 2,
    `全中/零虚报退化计数: d̂′=${degenerate.dprime.toFixed(3)} 有限且 > 2（对数线性稳定化 (h+0.5)/(n+1)，无 ±∞ 路径）`,
  );
  // 确定性: 同 seed 同输出
  const dsAgain = simulateMetacognition({ d: 1.5, metaD: 1.5, trials: 20000, seed: 11 });
  ok(
    dsAgain.correctConfidences.length === ds.correctConfidences.length &&
      dsAgain.correctConfidences.every((v, i) => v === ds.correctConfidences[i]),
    `同 seed 重放逐位一致（${ds.correctConfidences.length} 条正确试验信心全等）`,
  );
}

section('97.0 meta-d′: 一阶×二阶四象限分离（锚点②）');

{
  const quadrants = [
    { d: 1.5, metaD: 1.5, kind: '一阶强/二阶强' },
    { d: 1.5, metaD: 0.5, kind: '一阶强/二阶弱' },
    { d: 0.6, metaD: 0.6, kind: '一阶弱/二阶强' },
    { d: 0.6, metaD: 0.2, kind: '一阶弱/二阶弱' },
  ];
  const est = new Map();
  for (const q of quadrants) {
    const s = simulateMetacognition({ d: q.d, metaD: q.metaD, trials: 8000, seed: 23 });
    const r = metaDprime(s.correctConfidences, s.errorConfidences);
    est.set(q.kind, r);
    ok(
      r.auc > 0.5 && r.auc < 1,
      `${q.kind}（d=${q.d}, metaD=${q.metaD}）: meta-d′̂=${r.metaDprime.toFixed(3)}，型-2 ROC 面积=${r.auc.toFixed(4)} ∈ (0.5, 1)`,
    );
  }
  const strong = est.get('一阶强/二阶强');
  const strongLowMeta = est.get('一阶强/二阶弱');
  const weak = est.get('一阶弱/二阶强');
  const weakLowMeta = est.get('一阶弱/二阶弱');
  ok(
    Math.abs(strong.metaDprime - 1.5) <= 0.15,
    `高元认知象限（判别好且自知好）: meta-d′̂=${strong.metaDprime.toFixed(3)} ≈ d=1.5（面积反演的自洽基准，|Δ| ≤ 0.15）`,
  );
  ok(
    Math.abs(weak.metaDprime - 0.6) <= 0.15,
    `低敏感度×高元认知象限: meta-d′̂=${weak.metaDprime.toFixed(3)} ≈ d=0.6（|Δ| ≤ 0.15）`,
  );
  ok(
    strongLowMeta.metaDprime <= 0.55 * 1.5 && strongLowMeta.metaDprime <= 1.5 - 0.6,
    `判别好但自知差被正确量化: meta-d′̂=${strongLowMeta.metaDprime.toFixed(3)} ≤ 0.55·d=0.825 且 ≤ d−0.6=0.9（显著低于 d）`,
  );
  ok(
    weakLowMeta.metaDprime <= 0.55 * 0.6,
    `一阶弱×二阶弱: meta-d′̂=${weakLowMeta.metaDprime.toFixed(3)} ≤ 0.55·d=0.33`,
  );
  ok(
    strong.metaDprime - strongLowMeta.metaDprime >= 0.5 && weak.metaDprime - weakLowMeta.metaDprime >= 0.25,
    `四象限分离: 同 d 下高/低元认知差 ${ (strong.metaDprime - strongLowMeta.metaDprime).toFixed(3) }（d=1.5）与 ${(weak.metaDprime - weakLowMeta.metaDprime).toFixed(3)}（d=0.6）`,
  );
  ok(
    strong.metaDprime / 1.5 >= 0.85 && weak.metaDprime / 0.6 >= 0.85,
    `M-ratio = meta-d′/d′: 高元认知象限 ${(strong.metaDprime / 1.5).toFixed(3)} / ${(weak.metaDprime / 0.6).toFixed(3)} ≥ 0.85（信心无噪跟随证据时 ≈ 1）`,
  );
  ok(
    strongLowMeta.metaDprime / 1.5 <= 0.35 && weakLowMeta.metaDprime / 0.6 <= 0.35,
    `M-ratio 低元认知象限 ${(strongLowMeta.metaDprime / 1.5).toFixed(3)} / ${(weakLowMeta.metaDprime / 0.6).toFixed(3)} ≤ 0.35（元认知效率被压低）`,
  );
}

section('97.0 信心-准确率曲线: P(error|c) 单调下降（锚点④）');

{
  const high = simulateMetacognition({ d: 1.2, metaD: 1.2, trials: 12000, seed: 5 });
  const curveHigh = confidenceAccuracyCurve(high.pairs, 8);
  ok(
    curveHigh.monotoneNondecreasing && curveHigh.violations === 0,
    `高元认知数据 8 桶准确率全单调不减（violations=${curveHigh.violations}）: ${curveHigh.buckets.map((b) => (b.n === 0 ? '—' : b.accuracy.toFixed(3))).join(' → ')}（P(error|c) 随信心单调下降）`,
  );
  ok(
    curveHigh.spearman > 0.2,
    `信心-对错 Spearman=${curveHigh.spearman.toFixed(4)} > 0.2（校准方向显著为正）`,
  );
  ok(
    near(curveHigh.overallAccuracy, normalCdf(0.6), 0.02),
    `总体准确率 ${curveHigh.overallAccuracy.toFixed(4)} ≈ Φ(d/2)=Φ(0.6)=${normalCdf(0.6).toFixed(4)}（解析对照）`,
  );
  const low = simulateMetacognition({ d: 1.2, metaD: 0.4, trials: 12000, seed: 5 });
  const curveLow = confidenceAccuracyCurve(low.pairs, 8);
  ok(
    curveHigh.spearman - curveLow.spearman > 0.1 && curveLow.spearman < 0.15,
    `元认知噪声压低曲线: 高元认知 Spearman=${curveHigh.spearman.toFixed(3)} ≫ 低元认知 ${curveLow.spearman.toFixed(3)}（差 > 0.1，violations=${curveLow.violations}）`,
  );
}

section('97.0 最优求助阈值: 闭式 vs 全阈值枚举（锚点③）');

{
  // 解析特例: costError=10, costAsk=3, priorError=0.3 ⟹ k=0.3 = q ⟹ c* = σ(0) = 0.5
  const model = { costError: 10, costAsk: 3, priorError: 0.3 };
  const policy = optimalAskThreshold(model);
  ok(
    near(policy.threshold, 0.5, 1e-12),
    `闭式阈值 c*=${policy.threshold} 恰为解析特例 σ(logit(0.7)−logit(0.7))=0.5（k=q=0.3）`,
  );
  ok(
    near(posteriorErrorProbability(policy.threshold, model.priorError), model.costAsk / model.costError, 1e-9),
    `解析驻点: P(error|c*)=${posteriorErrorProbability(policy.threshold, model.priorError).toFixed(9)} = costAsk/costError=0.3（±1e-9 精确）`,
  );

  // 全阈值枚举: c ~ U(0,1)，问付 costAsk（错误被解决），不问付 costError×1[error]
  const expectedCost = () => {
    const G = 10001;
    const h = 1 / (G - 1);
    const p = Array.from({ length: G }, (_, j) => posteriorErrorProbability(j * h, model.priorError));
    // at(x) = 问费 x·costAsk + 错误期望 costError × 后缀梯形积分 ∫_x^1 P(error|c) dc
    return { at: (x) => x * model.costAsk + suffixIntegral(p, h, x) * model.costError };
  };
  function suffixIntegral(p, h, x) {
    const j = Math.min(p.length - 2, Math.max(0, Math.round(x / h)));
    let s = 0;
    for (let k = j; k < p.length - 1; k += 1) s += ((p[k] + p[k + 1]) / 2) * h;
    return s;
  }
  const cost = expectedCost();
  let bestT = 0;
  let bestCost = Infinity;
  for (let j = 0; j <= 10000; j += 1) {
    const t = j / 10000;
    const c = cost.at(t);
    if (c < bestCost) {
      bestCost = c;
      bestT = t;
    }
  }
  ok(
    Math.abs(bestT - policy.threshold) <= 1.5e-4,
    `全阈值枚举 argmin t̂=${bestT.toFixed(4)} 与闭式 c*=0.5 贴合到网格分辨率（|Δ| ≤ 1.5e-4）`,
  );
  ok(
    cost.at(policy.threshold) <= bestCost + 1e-12,
    `闭式阈值的期望成本 ${cost.at(policy.threshold).toFixed(6)} ≤ 枚举最优 ${bestCost.toFixed(6)} + 1e-12（不多付一分）`,
  );

  // 第二组参数 + shouldAsk 方向
  const model2 = { costError: 4, costAsk: 1, priorError: 0.2 };
  const policy2 = optimalAskThreshold(model2);
  ok(
    near(posteriorErrorProbability(policy2.threshold, model2.priorError), 0.25, 1e-9) && shouldAsk(0.35, model2).ask && !shouldAsk(0.6, model2).ask,
    `model2（k=0.25, q=0.2）: c*=${policy2.threshold.toFixed(4)} 处 P(error|c*)=0.25 精确；shouldAsk(0.35)=${shouldAsk(0.35, model2).ask} / shouldAsk(0.6)=${shouldAsk(0.6, model2).ask}（低信心问、高信心不问）`,
  );
  // 先验方向: 错误越罕见越不值得问（阈值越低 → 问得更少）
  const cLow = optimalAskThreshold({ costError: 10, costAsk: 3, priorError: 0.1 }).threshold;
  const cMid = optimalAskThreshold({ costError: 10, costAsk: 3, priorError: 0.3 }).threshold;
  const cHigh = optimalAskThreshold({ costError: 10, costAsk: 3, priorError: 0.5 }).threshold;
  ok(
    cLow < cMid && cMid < cHigh,
    `先验错误率单调推高阈值: q=0.1→c*=${cLow.toFixed(3)} < q=0.3→${cMid.toFixed(3)} < q=0.5→${cHigh.toFixed(3)}（错误越罕见越不问）`,
  );
  // 边界: 白嫖必问 / 问比错还贵必不问
  const free = optimalAskThreshold({ costError: 5, costAsk: 0, priorError: 0.3 });
  const dear = optimalAskThreshold({ costError: 5, costAsk: 5, priorError: 0.3 });
  ok(
    free.alwaysAsk && free.threshold === 1 && dear.neverAsk && dear.threshold === 0,
    `边界: costAsk=0 → 恒问（c*=1）；costAsk=costError → 恒不问（c*=0）`,
  );
  ok(
    shouldAsk(0.2, model).ask && shouldAsk(0.2, model).expectedSaving > 0 && !shouldAsk(0.8, model).ask,
    `shouldAsk(0.2)={ask=${shouldAsk(0.2, model).ask}, 节余=${shouldAsk(0.2, model).expectedSaving.toFixed(2)}} / shouldAsk(0.8).ask=${shouldAsk(0.8, model).ask}`,
  );
}

section('97.0 校准联动: 信心序列过校准器后 ECE 下降（锚点⑤，75.0 接口退化）');

{
  const ds = simulateMetacognition({ d: 1.2, metaD: 1.2, trials: 12000, seed: 5 });
  // 过度自信失真: conf → √conf（推向 1）——「报 0.9 的人只对了 0.8」
  const raw = ds.pairs.map((p) => ({ p: Math.min(0.999, Math.sqrt(p.confidence)), y: p.correct ? 1 : 0 }));
  const eceRaw = ece(raw);
  // mini 校准器（75.0 Platt/isotonic 的退化接口）: 前半数据分桶经验映射，后半验收
  const bins = 10;
  const half = Math.floor(raw.length / 2);
  const cnt = Array.from({ length: bins }, () => 0);
  const acc = Array.from({ length: bins }, () => 0);
  for (const r of raw.slice(0, half)) {
    const i = Math.min(bins - 1, Math.floor(r.p * bins));
    cnt[i] += 1;
    acc[i] += r.y;
  }
  const heldOut = raw.slice(half);
  const remapped = heldOut.map((r) => {
    const i = Math.min(bins - 1, Math.floor(r.p * bins));
    return { p: cnt[i] > 0 ? acc[i] / cnt[i] : r.p, y: r.y };
  });
  const eceHeld = ece(heldOut);
  const eceMapped = ece(remapped);
  ok(
    eceMapped < eceHeld && 1 - eceMapped / eceHeld >= 0.5,
    `split-half 校准: held-out ECE ${eceHeld.toFixed(4)} → ${eceMapped.toFixed(4)}（降 ${(100 * (1 - eceMapped / eceHeld)).toFixed(1)}% ≥ 50%；(信心, 对错) 对即 75.0 CalibrationPair 口径，ECE 本脚本独立实现）`,
  );
}

section('97.0 入参校验: 显式 throw（无静默 NaN 路径）');

{
  ok(throws(() => typeOneDprime(-1, 5, 100, 100)), 'typeOneDprime(hits=-1) throw（负命中数）');
  ok(throws(() => typeOneDprime(5, 2, 0, 100)), 'typeOneDprime(nSignal=0) throw（空信号类）');
  ok(throws(() => typeOneDprime(101, 2, 100, 100)), 'typeOneDprime(hits=101>100) throw（越界计数）');
  ok(throws(() => metaDprime([], [0.5])), 'metaDprime(空正确数组) throw');
  ok(throws(() => metaDprime([0.5, 0.7], [])), 'metaDprime(零错误试验) throw（分离度不可估计，诚实拒绝）');
  ok(throws(() => metaDprime([0.5, Number.NaN], [0.3])), 'metaDprime(NaN 信心) throw');
  ok(throws(() => optimalAskThreshold({ costError: 0, costAsk: 1, priorError: 0.3 })), 'optimalAskThreshold(costError=0) throw');
  ok(throws(() => optimalAskThreshold({ costError: 1, costAsk: -1, priorError: 0.3 })), 'optimalAskThreshold(costAsk=-1) throw');
  ok(throws(() => optimalAskThreshold({ costError: 1, costAsk: 0.1, priorError: 1 })), 'optimalAskThreshold(priorError=1) throw（开区间）');
  ok(throws(() => shouldAsk(1.4, { costError: 1, costAsk: 0.2, priorError: 0.3 })), 'shouldAsk(conf=1.4) throw');
  ok(throws(() => posteriorErrorProbability(0.5, 0)), 'posteriorErrorProbability(prior=0) throw');
  ok(throws(() => simulateMetacognition({ d: 0, metaD: 0, trials: 100, seed: 1 })), 'simulateMetacognition(d=0) throw');
  ok(throws(() => simulateMetacognition({ d: 1, metaD: 1.5, trials: 100, seed: 1 })), 'simulateMetacognition(metaD>d) throw（元认知效率 ≤ 1）');
  ok(throws(() => simulateMetacognition({ d: 1, metaD: 0.5, trials: 0, seed: 1 })), 'simulateMetacognition(trials=0) throw');
  ok(throws(() => confidenceAccuracyCurve([])), 'confidenceAccuracyCurve(空) throw');
  ok(throws(() => confidenceAccuracyCurve([{ confidence: 0.5, correct: 'yes' }])) , 'confidenceAccuracyCurve(correct 非 boolean) throw');
}

// ═══════════════════ 98.0 经验重放内核 ═══════════════════

section('98.0 优先级采样: 秩相关与 α 单调集中（锚点①）');

{
  const N = 240;
  const tds = Array.from({ length: N }, (_, i) => (i + 1) * 0.01);
  const shares = [];
  const DRAWS = 96000;
  for (const alpha of [0, 0.5, 1]) {
    const buf = new PrioritizedReplay({ capacity: 400, alpha, seed: 31 });
    for (let i = 0; i < N; i += 1) buf.push({ task: 'T', arm: 0, reward: 0, tdError: tds[i] });
    const draw = buf.sample(DRAWS);
    const freq = Array.from({ length: N }, () => 0);
    for (const idx of draw.indices) freq[idx] += 1;
    const sortedFreq = [...freq].sort((a, b) => b - a);
    const top20 = sortedFreq.slice(0, Math.floor(N * 0.2)).reduce((s, x) => s + x, 0) / DRAWS;
    shares.push({ alpha, top20, spear: spearman(tds, freq) });
    if (alpha === 1) {
      ok(
        spearman(tds, freq) > 0.95,
        `α=1: |TD|-采样频率 Spearman=${spearman(tds, freq).toFixed(4)} > 0.95（高 |TD| 转移显著高频）`,
      );
    }
    if (alpha === 0) {
      ok(
        Math.abs(spearman(tds, freq)) < 0.2,
        `α=0: Spearman=${spearman(tds, freq).toFixed(4)}（|·| < 0.2，均匀采样与 |TD| 无关）`,
      );
    }
  }
  ok(
    shares[0].top20 < shares[1].top20 && shares[1].top20 < shares[2].top20,
    `top-20% |TD| 采样份额随 α 严格递增: ${shares.map((s) => `α=${s.alpha}→${s.top20.toFixed(3)}`).join(' < ')}（理论 0.200 < 0.447 < 0.707，rank⁻^α 口径）`,
  );
  ok(
    shares[0].top20 <= 0.27 && shares[2].top20 >= 0.65,
    `集中度带对照: α=0 份额 ${shares[0].top20.toFixed(3)} ≤ 0.27（近均匀）、α=1 ${shares[2].top20.toFixed(3)} ≥ 0.65（强集中）`,
  );
  // α=0 的分布精确均匀 + IS 原始权重恒 1（确定性读出，非采样断言）
  const buf0 = new PrioritizedReplay({ capacity: 400, alpha: 0, beta: 1, seed: 3 });
  for (let i = 0; i < 50; i += 1) buf0.push({ task: 'T', arm: 0, reward: 0, tdError: i });
  const probe = buf0.sample(50);
  ok(
    probe.probabilities.every((p) => near(p, 1 / 50, 1e-12)),
    `α=0 采样概率逐条精确 = 1/N = ${1 / 50}（±1e-12，rank^0 ≡ 1 的恒等口径）`,
  );
  const isw0 = buf0.iswWeights([0, 17, 49], 1);
  ok(
    isw0.rawWeights.every((w) => near(w, 1, 1e-12)) && isw0.weights.every((w) => near(w, 1, 1e-12)),
    `α=0 时 IS 原始权重 (1/(N·P))^β = 1 恒等（β=1 修正量恒零——均匀采样无需修正）`,
  );
  // 确定性: 同 seed 同采样序列
  const b1 = new PrioritizedReplay({ capacity: 100, alpha: 0.6, seed: 42 });
  const b2 = new PrioritizedReplay({ capacity: 100, alpha: 0.6, seed: 42 });
  for (let i = 0; i < 100; i += 1) {
    b1.push({ task: 'T', arm: i % 3, reward: (i % 7) / 7, tdError: (i % 13) / 13 });
    b2.push({ task: 'T', arm: i % 3, reward: (i % 7) / 7, tdError: (i % 13) / 13 });
  }
  const seq1 = b1.sample(50).indices;
  const seq2 = b2.sample(50).indices;
  ok(
    seq1.every((v, i) => v === seq2[i]),
    `同 seed 缓冲区采样序列逐位一致（50 次抽取全等）`,
  );
}

section('98.0 IS 权重无偏性: 优先采样下 bandit 真值恢复（锚点②）');

{
  const means = [0.9, 0.5, 0.1];
  const rng = mulberry32(77);
  const buf = new PrioritizedReplay({ capacity: 5000, alpha: 1, seed: 13 });
  // 行为流: 逐臂 900 条 Bernoulli；初始估值 V̂=0 ⟹ |TD| = |r| = r——
  // rank-based 优先采样系统性偏向 r=1 的转移（这正是「优先」的扭曲）
  for (let a = 0; a < 3; a += 1) {
    for (let i = 0; i < 900; i += 1) {
      const r = rng() < means[a] ? 1 : 0;
      buf.push({ task: 'B', arm: a, reward: r, tdError: r });
    }
  }
  const M = 30000;
  const draw = buf.sample(M);
  const isw = buf.iswWeights(draw.indices, 1); // β=1 全修正（估计阶段优先级冻结）
  const isLearner = new WeightedBanditLearner(3); // IS 加权估值器
  const naiveLearner = new WeightedBanditLearner(3); // 无修正对照
  for (let k = 0; k < M; k += 1) {
    const t = draw.transitions[k];
    isLearner.update({ arm: t.arm, reward: t.reward, weight: isw.weights[k] });
    naiveLearner.update({ arm: t.arm, reward: t.reward, weight: 1 });
  }
  const estIS = [0, 1, 2].map((a) => isLearner.valueOf(a));
  const estNaive = [0, 1, 2].map((a) => naiveLearner.valueOf(a));
  ok(
    estIS.every((v, a) => Math.abs(v - means[a]) <= 0.03),
    `IS 修正（β=1）逐臂估值收敛真值: ${estIS.map((v, a) => `臂${a}: ${v.toFixed(3)}（μ=${means[a]}）`).join('、')}（|Δ| ≤ 0.03）`,
  );
  ok(
    estNaive.every((v, a) => v > means[a]),
    `无修正对照全部系统性偏高: ${estNaive.map((v, a) => `臂${a}: +${(v - means[a]).toFixed(3)}`).join('、')}（|TD| 偏向高回报 → 采样分布扭曲）`,
  );
  const biasIS = estIS.reduce((s, v, a) => s + Math.abs(v - means[a]), 0) / 3;
  const biasNaive = estNaive.reduce((s, v, a) => s + Math.abs(v - means[a]), 0) / 3;
  ok(
    biasNaive > 3 * biasIS,
    `平均偏置: 无修正 ${biasNaive.toFixed(4)} > 3× IS 修正 ${biasIS.toFixed(4)}（w=(1/(N·P))ᵝ 把优先采样的期望拉回无偏）`,
  );
}

section('98.0 睡眠固化: 只重放不采新的可测进步（锚点③）');

{
  // 构造含未消化经验的缓冲区: 数据说臂 1 好（μ=0.8）、学习器还以为臂 0 好
  const truth = [0.2, 0.8];
  const rng = mulberry32(55);
  const buf = new PrioritizedReplay({ capacity: 2000, alpha: 0.6, seed: 17 });
  for (let i = 0; i < 400; i += 1) {
    const r = rng() < 0.2 ? 1 : 0;
    buf.push({ task: 'day', arm: 0, reward: r, tdError: Math.abs(r - 0.55) }); // 与 V̂₀=0.55 的矛盾
  }
  for (let i = 0; i < 600; i += 1) {
    const r = rng() < 0.8 ? 1 : 0;
    buf.push({ task: 'day', arm: 1, reward: r, tdError: Math.abs(r - 0.35) }); // |TD| 大 → 高优先重放
  }
  const learner = new SgdBanditLearner(2, { lr: 0.1, initialValues: [0.55, 0.35] });
  ok(learner.greedyArm() === 0, `固化前 greedy 臂 = ${learner.greedyArm()}（V̂=[0.55, 0.35] 误信臂 0，策略真值 ${truth[0]}）`);
  const res = sleepConsolidation({ buffer: buf, learner, truth, rounds: 12, batchSize: 64 });
  ok(
    res.improvement >= 0.5,
    `策略价值 ${res.policyValueBefore.toFixed(1)} → ${res.policyValueAfter.toFixed(1)}（提升 +${res.improvement.toFixed(2)} ≥ 0.5——未消化经验被离线消化）`,
  );
  ok(
    res.bufferSizeAfter === res.bufferSizeBefore && res.bufferSizeBefore === 1000 && res.freshTransitions === 0,
    `零新数据: 缓冲区 ${res.bufferSizeBefore} → ${res.bufferSizeAfter} 条不变（freshTransitions=0）`,
  );
  ok(
    res.samplesUsed === 12 * 64,
    `samplesUsed = rounds×batch = ${res.samplesUsed}（消耗的全是重放）`,
  );
  ok(
    learner.valueOf(1) > 0.7 && learner.valueOf(0) < 0.45,
    `固化后估值 V̂=[${learner.valueOf(0).toFixed(3)}, ${learner.valueOf(1).toFixed(3)}]——臂 1 翻正、greedy=${learner.greedyArm()}（|TD| 大的臂 1 经验被优先消化）`,
  );
}

section('98.0 灾难遗忘对照: 分层重放护住任务 A（锚点④，招牌）');

{
  const taskA = makeBanditTask({ name: 'A', means: [0.9, 0.1], rewardModel: 'gaussian', noise: 0.1 });
  const taskB = makeBanditTask({ name: 'B', means: [0.1, 0.9], rewardModel: 'gaussian', noise: 0.1 });
  for (const seed of [9, 21, 404]) {
    const rep = rehearsalVsNone({ taskA, taskB, seed });
    const w = rep.withoutReplay;
    const r = rep.withReplay;
    if (seed === 9) {
      ok(
        w.dropFraction > 0.5,
        `无重放: A 性能 ${w.aPerformanceBefore.toFixed(2)} → ${w.aPerformanceAfter.toFixed(2)}（跌 ${(w.dropFraction * 100).toFixed(1)}% > 50%；V̂=[${w.valueEstimates.map((v) => v.toFixed(2)).join(', ')}] 被 B 洪峰覆写成 B 真值，greedy 臂 ${w.greedyArmBefore}→${w.greedyArmAfter} 翻错）`,
      );
      ok(
        r.retention >= 0.8,
        `分层重放: A 性能保持 ${(r.retention * 100).toFixed(0)}% ≥ 80%（V̂=[${r.valueEstimates.map((v) => v.toFixed(2)).join(', ')}] 收敛到 (2μ_A+μ_B)/3 ≈ [0.63, 0.37] 凸组合，greedy 臂保持 ${r.greedyArmAfter}）`,
      );
    }
    ok(
      rep.protectedByRehearsal,
      `seed=${seed}: protected（无重放跌 ${(w.dropFraction * 100).toFixed(1)}% > 50% 且重放保持 ${(r.retention * 100).toFixed(0)}% ≥ 80%）`,
    );
  }
  // 工厂与流: phaseA/phaseB 尺寸与任务标签
  const stream = continualTaskStream({ taskA, taskB, seed: 9 });
  ok(
    stream.phaseA.length === 300 &&
      stream.phaseB.length === 300 &&
      stream.phaseA.every((t) => t.task === 'A') &&
      stream.phaseB.every((t) => t.task === 'B'),
    `continualTaskStream: A/B 各 300 条、task 层标签齐备（分层重放的层来源）`,
  );
}

section('98.0 环形容量守恒与分层公平（锚点⑤）');

{
  // 容量守恒: 单层环 2500 条洪峰后 size === capacity
  const solo = new PrioritizedReplay({ capacity: 800, seed: 1 });
  for (let i = 0; i < 2500; i += 1) solo.push({ task: 'X', arm: 0, reward: 1 });
  ok(
    solo.size() === 800 && solo.contents().length === 800,
    `单层环容量守恒: 2500 条洪峰后 size = ${solo.size()} === capacity 800（FIFO 覆盖最旧）`,
  );
  // 分层公平: 600 条 A 之后 1200 条 B 涌入——A 层存活 300（全局环口径已清零）
  const buf = new PrioritizedReplay({ capacity: 600, seed: 2 });
  for (let i = 0; i < 600; i += 1) buf.push({ task: 'A', arm: 0, reward: 1 });
  for (let i = 0; i < 1200; i += 1) buf.push({ task: 'B', arm: 1, reward: 0 });
  ok(
    buf.size() === 600 && buf.sizeOf('A') === 300 && buf.sizeOf('B') === 300,
    `分层公平: A=600 条 + B=1200 条洪峰后 A 存活 ${buf.sizeOf('A')}、B ${buf.sizeOf('B')}（各占配额 300；单一全局环在 600 条 B 后 A 已清零——分层防覆盖饥饿）`,
  );
  // 三任务配额重平衡: 每层收缩到 capacity/3，且后续 C 洪峰不侵蚀 A/B
  const buf3 = new PrioritizedReplay({ capacity: 600, seed: 4 });
  for (let i = 0; i < 300; i += 1) buf3.push({ task: 'A', arm: 0, reward: 1 });
  for (let i = 0; i < 300; i += 1) buf3.push({ task: 'B', arm: 0, reward: 1 });
  for (let i = 0; i < 300; i += 1) buf3.push({ task: 'C', arm: 0, reward: 1 });
  const afterThree = [buf3.sizeOf('A'), buf3.sizeOf('B'), buf3.sizeOf('C')];
  for (let i = 0; i < 900; i += 1) buf3.push({ task: 'C', arm: 0, reward: 1 });
  ok(
    afterThree.every((s) => s === 200) && buf3.size() <= 600,
    `三任务配额重平衡: 各层 [${afterThree.join(', ')}] === 200×3（新层出现时旧层从最旧端收缩，总量 ≤ 600 守恒）`,
  );
  ok(
    buf3.sizeOf('A') === 200 && buf3.sizeOf('B') === 200,
    `C 再洪峰 900 条后 A=${buf3.sizeOf('A')}、B=${buf3.sizeOf('B')} 原封不动（层内覆盖只牺牲本层最旧样本）`,
  );
}

section('98.0 入参校验: 显式 throw（无静默 NaN 路径）');

{
  ok(throws(() => new PrioritizedReplay({ capacity: 0 })), 'PrioritizedReplay(capacity=0) throw');
  ok(throws(() => new PrioritizedReplay({ capacity: 100, alpha: 1.5 })), 'PrioritizedReplay(alpha=1.5) throw');
  ok(throws(() => new PrioritizedReplay({ capacity: 100, beta: -0.1 })), 'PrioritizedReplay(beta=-0.1) throw');
  const buf = new PrioritizedReplay({ capacity: 50, seed: 1 });
  ok(throws(() => buf.push({ task: '', arm: 0, reward: 1 })), 'push(task="") throw（空层标签）');
  ok(throws(() => buf.push({ task: 'T', arm: -1, reward: 1 })), 'push(arm=-1) throw');
  ok(throws(() => buf.push({ task: 'T', arm: 0, reward: Number.NaN })), 'push(reward=NaN) throw');
  ok(throws(() => buf.push({ task: 'T', arm: 0, reward: 1, tdError: -2 })), 'push(tdError=-2) throw（负优先级）');
  ok(throws(() => buf.sample(10)), 'sample(空缓冲区) throw');
  for (let i = 0; i < 10; i += 1) buf.push({ task: 'T', arm: 0, reward: 1 });
  ok(throws(() => buf.sample(0)), 'sample(batchSize=0) throw');
  ok(throws(() => buf.updatePriorities([0], [1, 2])), 'updatePriorities(长度不匹配) throw');
  ok(throws(() => buf.updatePriorities([99], [1])), 'updatePriorities(越界下标) throw');
  ok(throws(() => buf.iswWeights([0], 2)), 'iswWeights(beta=2) throw');
  ok(throws(() => buf.sampleFromTask('unknown', 1)), 'sampleFromTask(未知层) throw');
  const tiny = new PrioritizedReplay({ capacity: 2, seed: 1 });
  tiny.push({ task: 'a', arm: 0, reward: 1 });
  tiny.push({ task: 'b', arm: 0, reward: 1 });
  ok(throws(() => tiny.push({ task: 'c', arm: 0, reward: 1 })), 'push(第 3 层 > 容量 2) throw（分层配给失效的诚实边界）');
  ok(throws(() => new SgdBanditLearner(2, { lr: 0 })), 'SgdBanditLearner(lr=0) throw');
  ok(throws(() => new SgdBanditLearner(2, { lr: 0.1 }).update({ arm: 5, reward: 1, weight: 1 })), 'update(arm 越界) throw');
  const task = makeBanditTask({ name: 'T', means: [0.5, 0.5] });
  ok(throws(() => makeBanditTask({ name: 'T', means: [1.4] })), 'makeBanditTask(bernoulli μ=1.4) throw');
  ok(throws(() => makeBanditTask({ name: '', means: [0.5] })), 'makeBanditTask(空名) throw');
  const task2 = makeBanditTask({ name: 'U', means: [0.5] });
  ok(throws(() => continualTaskStream({ taskA: task, taskB: task2 })), 'continualTaskStream(臂数不等) throw（须共享动作空间）');
  ok(throws(() => continualTaskStream({ taskA: task, taskB: task, phaseASize: 0 })), 'continualTaskStream(phaseASize=0) throw');
  ok(
    throws(() => sleepConsolidation({ buffer: new PrioritizedReplay({ capacity: 10, seed: 1 }), learner: new SgdBanditLearner(2), truth: [0.5, 0.5], rounds: 1 })),
    'sleepConsolidation(空缓冲区) throw（无经验可固化）',
  );
  ok(throws(() => rehearsalVsNone({ taskA: task, taskB: task2 })), 'rehearsalVsNone(臂数不等) throw');
  ok(throws(() => rehearsalVsNone({ taskA: task, taskB: task, replayPerFresh: -1 })), 'rehearsalVsNone(replayPerFresh=-1) throw');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed === 0) {
  console.log('✅ 97.0 元认知信心 + 98.0 经验重放: 二阶信号检测论与优先重放/睡眠固化数学验证成立');
} else {
  console.error('❌ 存在失败断言');
}
process.exitCode = failed === 0 ? 0 : 1;
