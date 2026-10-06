/**
 * verify-crowd-aggregation.mjs — 82.0 众包聚合内核（Dawid–Skene EM）纯数学离线验证
 *
 * 每个锚点都有解析/构造对照（不是「能跑」，是「算得对」）:
 *   ① 混合 crowd（2 好 0.9 对角、1 垃圾均匀〔3 类 ⇒ 对角 1/3，规格
 *      0.25 为均匀口径的近似〕、1 对抗 0.15 循环反指、1 中等 0.6）
 *      × 100 items × 3 类均匀: DS 恢复真值 ≥ 0.97 且高出多数票
 *      ≥ 8 个百分点（垃圾+对抗把多数票拉到 ~0.6 档——构造保证差距）
 *   ② 混淆矩阵恢复: 同 crowd 600 items（每类 ≈ 200，二项 SE ≈ 0.03
 *      ——信噪比文档化）, 全部 5×3×3 单元 |π̂ − π| ≤ 0.1
 *   ③ EM 对数似然逐轮单调不减（Dawid–Skene 的 EM 定理实证，浮点
 *      容差 1e-9；总提升 > 0；iterations = trace − 1）
 *   ④ 垃圾 worker 的 π̂ ≈ 均匀（自动识别无用者）; 信任度排序
 *      好 > 中 > 垃圾 > 对抗; 对抗者被识破为系统性反指
 *   ⑤ 先验 90/7/3 + 误差质量流向多数类的偏置 crowd（300 items）:
 *      多数票少数类召回系统性塌方，DS 校正（召回差距断言 + 先验恢复）
 *   附加: 确定性（同种子同输出）、缺失覆盖率、等权不变性、入参显式抛错
 *
 * 全部断言确定性（内核自带 mulberry32 种子）。
 * 运行: node --experimental-strip-types scripts/verify-crowd-aggregation.mjs
 */

import {
  majorityVote,
  weightedMajority,
  dawidSkene,
  estimateAccuracy,
  reliabilityWeights,
  simulateCrowd,
} from '../src/core/crowd-aggregation.ts';

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
function throws(fn, label) {
  try {
    fn();
    failed += 1;
    console.error(`  ✗ ${label}`);
  } catch {
    passed += 1;
    console.log(`  ✓ ${label}`);
  }
}

/** 锚点①⑤ 共用混淆矩阵谱: 2 好 / 1 垃圾 / 1 对抗 / 1 中等 */
const CROWD = [
  { archetype: 'good', diagonal: 0.9 },
  { archetype: 'good', diagonal: 0.9 },
  { archetype: 'spammer' }, // 均匀: 全 1/3（3 类口径）
  { archetype: 'adversarial', diagonal: 0.15 }, // 循环反指: 真值 j → 集中报 j+1
  { archetype: 'medium', diagonal: 0.6 },
];

// ═══════════════════ 锚点① 真值恢复 ═══════════════════

section('82.0 锚点① 混合 crowd: DS 恢复真值 ≥ 0.97 且高出多数票 ≥ 8pp');

{
  const sim = simulateCrowd({ workers: CROWD, items: 100, classes: 3, seed: 42 });
  const mv = majorityVote(sim.labels);
  const ds = dawidSkene(sim.labels, { iters: 60, tol: 1e-9 });
  const accMV = estimateAccuracy(sim.truth, mv);
  const accDS = estimateAccuracy(sim.truth, ds.estimatedLabels);
  ok(accDS >= 0.97, `DS 恢复准确率 ${accDS} ≥ 0.97（100 items，含 1 垃圾 + 1 对抗）`);
  ok(accDS - accMV >= 0.08, `DS ${accDS} − 多数票 ${accMV} = ${(accDS - accMV).toFixed(3)} ≥ 0.08（垃圾+对抗把多数票拉低，构造保证差距）`);
  ok(accMV < accDS, `对照: 多数票 ${accMV}（一人一票把垃圾/对抗当专家——差距 ${(accDS - accMV).toFixed(3)}）`);
  ok(
    JSON.stringify(weightedMajority(sim.labels, [1, 1, 1, 1, 1])) === JSON.stringify(mv),
    '等权 weightedMajority ≡ majorityVote（同一平票规则，基线自洽）',
  );
  const accW = estimateAccuracy(sim.truth, weightedMajority(sim.labels, ds.workerReliability));
  ok(accW >= accMV + 0.02, `信任投票: DS 票权加权多数票 ${accW} ≥ 等权 ${accMV} + 0.02（学到的混淆矩阵即刻兑换成票权）`);
  ok(
    ds.truthPosterior.every((r) => near(r.reduce((a, b) => a + b, 0), 1, 1e-4)),
    'truthPosterior 行和 = 1（E 步归一化）',
  );
  ok(
    ds.confusionMatrices.every((m) => m.every((r) => near(r.reduce((a, b) => a + b, 0), 1, 1e-4) && r.every((x) => x >= 0))) &&
      near(ds.classPrior.reduce((a, b) => a + b, 0), 1, 1e-4),
    '混淆矩阵行随机、类别先验和 1（M 步是概率单纯形上的闭式极大化）',
  );
}

// ═══════════════════ 锚点② 混淆矩阵恢复 ═══════════════════

section('82.0 锚点② 混淆矩阵恢复: |π̂ − π| ≤ 0.1（600 items，信噪比文档化）');

{
  const sim = simulateCrowd({ workers: CROWD, items: 600, classes: 3, seed: 7 });
  const ds = dawidSkene(sim.labels, { iters: 80, tol: 1e-9 });
  let maxDev = 0;
  let where = '';
  for (let w = 0; w < sim.confusions.length; w += 1) {
    for (let j = 0; j < 3; j += 1) {
      for (let l = 0; l < 3; l += 1) {
        const dev = Math.abs(ds.confusionMatrices[w][j][l] - sim.confusions[w][j][l]);
        if (dev > maxDev) {
          maxDev = dev;
          where = `w${w}[${j}][${l}]: ${sim.confusions[w][j][l]} → ${ds.confusionMatrices[w][j][l]}`;
        }
      }
    }
  }
  ok(maxDev <= 0.1, `全部 ${5 * 3 * 3} 单元 |π̂−π|max = ${maxDev.toFixed(4)} ≤ 0.1（每类 ≈ 200 样本，二项 SE ≈ 0.03；最差单元 ${where}）`);
  ok(
    ds.confusionMatrices.every((m, w) => m.every((r, j) => near(r[j], sim.confusions[w][j][j], 0.08))),
    '对角线（各类准确率）逐 worker 恢复到 0.08 内（好 0.9 / 中 0.6 / 垃圾 1/3 / 对抗 0.15）',
  );

  // ── 锚点③ EM 单调（两份数据集都查）──
  const tr = ds.logLikTrace;
  let minDiff = Infinity;
  for (let t = 1; t < tr.length; t += 1) minDiff = Math.min(minDiff, tr[t] - tr[t - 1]);
  ok(minDiff >= -1e-9, `EM 对数似然逐轮单调不减（最差增量 ${minDiff.toExponential(2)} ≥ −1e-9；${tr.length} 个轨迹点含初始）`);
  ok(tr[tr.length - 1] > tr[0], `总提升 ${(tr[tr.length - 1] - tr[0]).toFixed(2)} > 0（${ds.iterations} 轮收敛）`);
  ok(ds.iterations === tr.length - 1 && ds.iterations >= 1, `iterations = ${ds.iterations} = trace 长度 − 1（初始化 M 步不计）`);

  // ── 锚点④ 垃圾识别（600 items 的低噪声估计）──
  const spamRows = ds.confusionMatrices[2];
  ok(
    spamRows.every((r) => r.every((x) => Math.abs(x - 1 / 3) <= 0.08)),
    `垃圾 worker π̂ ≈ 均匀（每单元 |x−1/3| ≤ 0.08；首行 [${spamRows[0].map((x) => x.toFixed(3)).join(', ')}]）——自动识别无用者`,
  );
  const rel = reliabilityWeights(ds.confusionMatrices, [1 / 3, 1 / 3, 1 / 3]);
  ok(
    rel[0] > rel[4] && rel[1] > rel[4] && rel[4] > rel[2] && rel[2] > rel[3],
    `信任度排序 好(${rel[0]},${rel[1]}) > 中(${rel[4]}) > 垃圾(${rel[2]}) > 对抗(${rel[3]})（对角质量先验加权）`,
  );
  ok(near(rel[2], 1 / 3, 0.05), `垃圾 worker 信任票权 ${rel[2].toFixed(3)} ≈ 1/3（均匀 ⇒ 无信息 ⇒ 数学降权而非规则降权）`);
  ok(
    ds.confusionMatrices[3].every((r, j) => r[(j + 1) % 3] > r[j]),
    `对抗者被识破: 每行的众数单元恰是循环反指位 j→j+1（首行 [${ds.confusionMatrices[3][0].map((x) => x.toFixed(3)).join(', ')}]）`,
  );
  const relFromFit = reliabilityWeights(ds.confusionMatrices, ds.classPrior);
  ok(
    ds.workerReliability.every((x, w) => near(x, relFromFit[w], 2e-6)),
    '结果内嵌 workerReliability 与 reliabilityWeights(π̂, p̂) 一致（同一口径两处计算，2e-6 圆整残差）',
  );
}

// ═══════════════════ 锚点⑤ 先验校正 ═══════════════════

section('82.0 锚点⑤ 先验 90/7/3: 多数票偏向多数类，DS 校正');

{
  // 偏置 crowd: 「多数类专家」在多数类准（0.9）但少数类上一半误差流向类 0
  // （真实口径: 模型在常见类上强、罕见类上弱且错向多数类）；「多数类僵尸」
  // 不看真值主投 0；中等者误差偏向类 0；对抗者循环反指——误差流全部汇入多数类。
  const BIAS_CROWD = [
    { confusion: [[0.9, 0.05, 0.05], [0.45, 0.5, 0.05], [0.45, 0.05, 0.5]] },
    { confusion: [[0.9, 0.05, 0.05], [0.45, 0.5, 0.05], [0.45, 0.05, 0.5]] },
    { confusion: [[0.7, 0.15, 0.15], [0.7, 0.15, 0.15], [0.7, 0.15, 0.15]] }, // 多数类僵尸
    { archetype: 'adversarial', diagonal: 0.15 },
    { confusion: [[0.85, 0.1, 0.05], [0.5, 0.42, 0.08], [0.5, 0.08, 0.42]] },
  ];
  const sim = simulateCrowd({ workers: BIAS_CROWD, items: 300, classes: 3, classPrior: [0.9, 0.07, 0.03], seed: 31 });
  const counts = [0, 0, 0];
  sim.truth.forEach((t) => (counts[t] += 1));
  const recalls = (est) =>
    [0, 1, 2].map((c) => {
      let hit = 0;
      sim.truth.forEach((t, i) => {
        if (t === c && est[i] === c) hit += 1;
      });
      return hit / Math.max(1, counts[c]);
    });
  const mv = majorityVote(sim.labels);
  const ds = dawidSkene(sim.labels, { iters: 80, tol: 1e-9 });
  const [mvR0, mvR1, mvR2] = recalls(mv);
  const [dsR0, dsR1, dsR2] = recalls(ds.estimatedLabels);
  const accMV = estimateAccuracy(sim.truth, mv);
  const accDS = estimateAccuracy(sim.truth, ds.estimatedLabels);
  ok(
    mvR1 <= mvR0 - 0.1,
    `多数票系统性偏向多数类: 类1召回 ${mvR1.toFixed(3)} ≤ 类0召回 ${mvR0.toFixed(3)} − 0.1（类2召回 ${mvR2.toFixed(3)}；类样本 [${counts.join('/')}]，误差流汇入类 0）`,
  );
  ok(
    dsR1 - mvR1 >= 0.2,
    `DS 校正少数类: 类1召回 ${dsR1.toFixed(3)} − 多数票 ${mvR1.toFixed(3)} = ${(dsR1 - mvR1).toFixed(3)} ≥ 0.2（学到的混淆矩阵反解误差流）`,
  );
  ok(dsR2 >= mvR2, `最稀缺类2: DS 召回 ${dsR2.toFixed(3)} ≥ 多数票 ${mvR2.toFixed(3)}（${counts[2]} 个样本的整数格点）`);
  ok(accDS >= accMV + 0.05, `总体: DS ${accDS} ≥ 多数票 ${accMV} + 0.05（校正少数类不以牺牲总体为代价）`);
  const priorDev = Math.max(...ds.classPrior.map((x, j) => Math.abs(x - [0.9, 0.07, 0.03][j])));
  ok(
    priorDev <= 0.05,
    `类别先验恢复: p̂ = [${ds.classPrior.map((x) => x.toFixed(3)).join(', ')}] vs 真值 [0.9, 0.07, 0.03]（|Δ|max = ${priorDev.toFixed(3)} ≤ 0.05）`,
  );
}

// ═══════════════════ 确定性 / 缺失覆盖 / 入参校验 ═══════════════════

section('82.0 确定性、缺失覆盖与入参显式校验');

{
  const sim = simulateCrowd({ workers: CROWD, items: 100, classes: 3, seed: 42 });
  const again = simulateCrowd({ workers: CROWD, items: 100, classes: 3, seed: 42 });
  ok(JSON.stringify(again) === JSON.stringify(sim), '同种子仿真逐位复现（mulberry32 确定性）');
  const dsA = dawidSkene(sim.labels, { iters: 60, tol: 1e-9 });
  const dsB = dawidSkene(sim.labels, { iters: 60, tol: 1e-9 });
  ok(JSON.stringify(dsA) === JSON.stringify(dsB), '同输入 dawidSkene 逐位复现（EM 无随机性）');

  const COV_CROWD = CROWD.map((w) => ({ ...w, coverage: 0.8 }));
  const simCov = simulateCrowd({ workers: COV_CROWD, items: 200, classes: 3, seed: 5 });
  const missing = simCov.labels.labels.flat().filter((v) => v === null).length;
  ok(missing > 0, `覆盖率 0.8 产生 ${missing} 个缺失单元（似然跳过缺失口径生效）`);
  const accCov = estimateAccuracy(simCov.truth, dawidSkene(simCov.labels, { iters: 60, tol: 1e-9 }).estimatedLabels);
  ok(accCov >= 0.95, `缺失 20% 下 DS 准确率 ${accCov} ≥ 0.95（E 步按可用标注重加权）`);

  throws(() => majorityVote({ workers: ['a'], classes: 2, labels: [[3]] }), 'majorityVote: 越界标签抛错');
  throws(() => majorityVote({ workers: ['a', 'b'], classes: 2, labels: [[0, 1]] }), 'majorityVote: 标注行数与 workers 不齐抛错');
  throws(() => majorityVote({ workers: ['a', 'b'], classes: 2, labels: [[0], [1, 0]] }), 'majorityVote: 行长不齐抛错');
  throws(() => majorityVote({ workers: ['a'], classes: 2, labels: [[null]] }), 'majorityVote: 全缺失 item 抛错（拒绝而非静默均匀后验）');
  throws(() => weightedMajority(sim.labels, [1, 1]), 'weightedMajority: 票权长度不匹配抛错');
  throws(() => weightedMajority(sim.labels, [1, 1, -1, 1, 1]), 'weightedMajority: 负票权抛错');
  throws(() => weightedMajority(sim.labels, [0, 0, 0, 0, 0]), 'weightedMajority: 全零票权抛错');
  throws(() => estimateAccuracy([0, 1], [0]), 'estimateAccuracy: 长度不匹配抛错');
  throws(() => estimateAccuracy([0.5, 1], [0, 1]), 'estimateAccuracy: 非整数标签抛错');
  throws(() => dawidSkene(sim.labels, { iters: 0 }), 'dawidSkene: iters=0 抛错');
  throws(() => dawidSkene(sim.labels, { smoothing: -1 }), 'dawidSkene: 负平滑抛错');
  throws(() => reliabilityWeights([[[0.5, 0.5], [0.2, 0.2]]], [0.5, 0.5]), 'reliabilityWeights: 非行随机矩阵抛错');
  throws(() => simulateCrowd({ workers: [], items: 10, seed: 1 }), 'simulateCrowd: 空 workers 抛错');
  throws(() => simulateCrowd({ workers: [{ confusion: [[0.5, 0.5], [0.2, 0.2]] }], items: 10, seed: 1 }), 'simulateCrowd: 显式混淆非行随机抛错');
  throws(() => simulateCrowd({ workers: CROWD, items: 100, classes: 3, classPrior: [0.5, 0.5], seed: 1 }), 'simulateCrowd: classPrior 与 classes 冲突抛错');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✅ PASS ${passed} / FAIL ${failed} —— 82.0 众包聚合内核数学验证成立`);
} else {
  console.error(`❌ PASS ${passed} / FAIL ${failed} —— 82.0 众包聚合内核验证存在失败项`);
}
process.exitCode = failed === 0 ? 0 : 1;
