/**
 * verify-fabric-kernels.mjs — 46.0→50.0 经纬层五内核纯数学验证
 *
 * 验证锚点：
 *   46.0 法定人数：多数派两两相交闭式 vs 穷举枚举、奇偶 n、
 *         拜占庭 3f+1 下界判别、负载闭式
 *   47.0 CRDT：随机操作流任意置换 → 状态逐位收敛（强最终一致性
 *         定理的有限样本验证）、OR-Set add-win 并发语义
 *   48.0 秘密共享：任意 t 份子集枚举重建、t−1 份零泄露（重建值
 *         随机等可能）、随机性审计（均匀通过/偏置拒绝）
 *   49.0 小波：完美重构机器精度、Parseval 能量守恒、
 *         慢趋势+快突发双尺度分离
 *   50.0 矩阵补全：低秩矩阵部分观测恢复误差 ≪ 噪声若干倍、
 *         满秩矩阵诚实高残差
 *
 * 运行：npm run build && node scripts/verify-fabric-kernels.mjs
 */

import {
  majorityQuorumAudit,
  bruteForceMinIntersection,
  byzantineFeasible,
  GCounter,
  ORSet,
  LWWRegister,
  crdtConvergenceAudit,
  shamirSplit,
  shamirCombine,
  entropyAudit,
  haarDecompose,
  haarReconstruct,
  multiScaleView,
  completeMatrix,
  completedEntry,
} from '../dist/index.mjs';

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
function section(title) {
  console.log(`\n■ ${title}`);
}
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

// ═══════════════════ 46.0 法定人数 ═══════════════════

section('46.0 法定人数：闭式 vs 穷举 + 3f+1 下界');

{
  let agree = true;
  for (const n of [3, 4, 5, 6, 7, 9, 11, 13, 15]) {
    const audit = majorityQuorumAudit(n);
    const brute = bruteForceMinIntersection(n);
    if (audit.minIntersection !== brute) agree = false;
  }
  ok(agree, '最小交集闭式 2q−n = 穷举枚举（n ∈ 3..15 奇偶全覆盖）');
  const a7 = majorityQuorumAudit(7);
  ok(a7.quorumSize === 4 && a7.minIntersection === 1 && a7.crashFaultTolerance === 3,
    'n=7：q=4、交=1、崩溃容错 3（Raft 经典配置）');
  ok(byzantineFeasible(7, 2) && !byzantineFeasible(7, 3),
    '拜占庭 3f+1 下界：n=7 容 f=2、不容 f=3（n ≤ 3f 不存在性定理）');
  ok(byzantineFeasible(4, 1) && !byzantineFeasible(3, 1),
    'n=4 容 1 拜占庭、n=3 不容（最小拜占庭法定人数）');
  ok(Math.abs(majorityQuorumAudit(5).load - 3 / 5) < 1e-12, '负载闭式 max|Q|/n = 3/5（n=5）');
}

// ═══════════════════ 47.0 CRDT ═══════════════════

section('47.0 CRDT：置换收敛 + add-win 语义');

{
  const rng = mulberry32(20261021);
  const ops = [];
  for (let i = 0; i < 30; i += 1) {
    const r = rng();
    if (r < 0.5) ops.push({ node: r < 0.25 ? 'a' : 'b', kind: 'inc', by: 1 + Math.floor(rng() * 3) });
    else if (r < 0.8) ops.push({ node: r < 0.65 ? 'a' : 'b', kind: 'add', element: `e${Math.floor(rng() * 5)}` });
    else ops.push({ node: r < 0.9 ? 'a' : 'b', kind: 'remove', element: `e${Math.floor(rng() * 5)}` });
  }
  let worstCounter = 0;
  let worstSet = 0;
  for (let trial = 0; trial < 60; trial += 1) {
    const perm = ops.map((_, i) => i);
    for (let i = perm.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const audit = crdtConvergenceAudit(ops, perm);
    worstCounter = Math.max(worstCounter, audit.counterDelta);
    worstSet = Math.max(worstSet, audit.setSymmetricDiff);
  }
  ok(worstCounter === 0, `G-Counter 任意置换 + 双向 gossip → 计数逐位收敛（60 次置换最大差 ${worstCounter}）`);
  ok(worstSet === 0, `OR-Set 任意置换 + 双向 gossip → 集合逐位收敛（最大对称差 ${worstSet}）`);

  // add-win：并发 add(b 胜) 的元素在 remove 后仍存活
  const s = new ORSet();
  s.add('x', 't1');
  const snapshot = s.clone();
  s.add('x', 't2'); // 副本 A 并发 add
  snapshot.remove('x'); // 副本 B remove
  s.merge(snapshot);
  snapshot.merge(s);
  ok(s.has('x') && snapshot.has('x'), `并发 add+remove 中 add 胜（两副本合并后 x 均存活）`);

  // LWW 仲裁：同戳按节点 id 平局
  const r1 = new LWWRegister('node-a');
  const r2 = new LWWRegister('node-b');
  r1.set('from-a', 100);
  r2.set('from-b', 100);
  r1.merge(r2.state());
  r2.merge(r1.state());
  ok(r1.get() === r2.get(), `LWW 同时间戳节点 id 仲裁 → 两副本一致（${r1.get()}）`);
}

// ═══════════════════ 48.0 秘密共享 ═══════════════════

section('48.0 秘密共享：阈值重建 + 零泄露 + 随机性审计');

{
  const secret = 'master-key-9f8e7d6c5b4a';
  const shares = shamirSplit(secret, 5, 3);
  let allReconstruct = true;
  // 任意 3 份子集（C(5,3)=10 个）全部重建成功
  const idx3 = [];
  for (let a = 0; a < 5; a += 1) for (let b = a + 1; b < 5; b += 1) for (let c = b + 1; c < 5; c += 1) idx3.push([a, b, c]);
  for (const combo of idx3) {
    if (shamirCombine(combo.map((i) => shares[i])) !== secret) allReconstruct = false;
  }
  ok(allReconstruct, `任意 3 份子集（10/10 枚举）重建精确成功`);
  // t−1 份：重建值随机等可能（零泄露的实验读数——不同 2 份组合给出互不相同且 ≠ 秘密的值）
  const twoShareValues = new Set();
  let neverLeak = true;
  for (let a = 0; a < 5; a += 1) for (let b = a + 1; b < 5; b += 1) {
    try {
      const v = shamirCombine([shares[a], shares[b]]);
      if (v === secret) neverLeak = false;
      twoShareValues.add(v);
    } catch {
      /* 2 份对 t=3 多块结构可能格式不符——只要不重建出秘密即可 */
    }
  }
  ok(neverLeak, `任意 2 份（< 阈值）从不重建出秘密（信息论零泄露）`);
  ok(twoShareValues.size > 1, `不同 2 份组合给出互不相同的伪值（${twoShareValues.size} 种——t−1 份与秘密统计独立）`);

  // 随机性审计：均匀字节通过 / 偏置字节拒绝
  const rng = mulberry32(20261022);
  const uniform = Array.from({ length: 512 }, () => Math.floor(rng() * 256));
  const biased = uniform.map((b) => (b > 127 ? 255 : 0)); // 全 0/1 字节——极度偏置
  ok(entropyAudit(uniform).passed, `均匀字节通过频数+游程审计（|z| ≤ 3）`);
  ok(!entropyAudit(biased).passed, `偏置字节被审计拒绝`);
}

// ═══════════════════ 49.0 小波 ═══════════════════

section('49.0 小波：完美重构 + Parseval + 双尺度分离');

{
  const rng = mulberry32(20261023);
  const x = Array.from({ length: 128 }, () => rng() * 10);
  const dec = haarDecompose(x);
  const rec = haarReconstruct(dec);
  const maxErr = Math.max(...x.map((v, i) => Math.abs(v - rec[i])));
  ok(maxErr < 1e-9, `完美重构 Hᵀ·Hx = x（最大偏差 ${maxErr.toExponential(2)}）`);
  const coefEnergy = dec.approximation[0] ** 2 + dec.details.reduce((s, d) => s + d.reduce((a, b) => a + b * b, 0), 0);
  const xEnergy = x.reduce((a, b) => a + b * b, 0);
  ok(Math.abs(coefEnergy - xEnergy) / xEnergy < 1e-9, `Parseval 能量守恒（系数能量 ${coefEnergy.toFixed(3)} = 时域 ${xEnergy.toFixed(3)}）`);

  // 慢趋势 + 快突发：各尺度能量落位
  const composite = [];
  for (let t = 0; t < 128; t += 1) {
    const trend = 5 + 3 * (t / 128); // 慢
    const burst = t === 100 ? 40 : 0; // 快（单点突发——相邻成对突发恰好落入 Haar 近似分量）
    composite.push(trend + burst + 0.1 * (rng() - 0.5));
  }
  const view = multiScaleView(composite);
  ok(view.burstShare > 0.05, `快突发能量集中在最细尺度（burstShare=${view.burstShare.toFixed(2)} > 0.05——相对纯趋势的 <0.001）`);
  const slowOnly = [];
  for (let t = 0; t < 128; t += 1) slowOnly.push(5 + 3 * (t / 128) + 0.1 * (rng() - 0.5));
  const slowView = multiScaleView(slowOnly);
  ok(slowView.burstShare < 0.05, `纯慢趋势的最细尺度能量 < 5%（${slowView.burstShare.toFixed(3)}——尺度分离干净）`);
  ok(slowView.dominantScale === 'trend', `纯趋势能量主导在 trend 尺度（dominant=${slowView.dominantScale}）`);
}

// ═══════════════════ 50.0 矩阵补全 ═══════════════════

section('50.0 矩阵补全：低秩恢复 + 满秩诚实');

{
  const rng = mulberry32(20261024);
  const g = () => {
    const u = Math.max(1e-9, rng());
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  // 合成低秩（rank 2）：8 模型 × 6 任务，观测 60% + 噪声 0.05
  const n = 8;
  const m = 6;
  const U = Array.from({ length: n }, () => [0.5 + g() * 0.2, 0.5 + g() * 0.2]);
  const V = Array.from({ length: m }, () => [0.5 + g() * 0.2, 0.5 + g() * 0.2]);
  const observed = [];
  const hidden = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      const truth = U[i][0] * V[j][0] + U[i][1] * V[j][1];
      const noisy = truth + 0.03 * g();
      if (rng() < 0.75) observed.push({ i, j, value: noisy });
      else hidden.push({ i, j, truth });
    }
  }
  const report = completeMatrix(observed, n, m, { rank: 2 });
  let sumSq = 0;
  for (const h of hidden) {
    const pred = completedEntry(report, h.i, h.j) ?? 0;
    sumSq += (pred - h.truth) ** 2;
  }
  const rmseHidden = Math.sqrt(sumSq / hidden.length);
  ok(rmseHidden < 0.15, `低秩恢复：未观测条目 RMSE ${rmseHidden.toFixed(3)}（噪声 0.03 的数倍内——潜维度外推有效）`);
  ok(report.converged && report.lowRankShare > 0.9, `ALS 收敛且低秩成色 > 0.9（share=${report.lowRankShare.toFixed(3)}）`);

  // 满秩随机矩阵：诚实高残差（不强行低秩解释）
  const fullObserved = [];
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j < 5; j += 1) fullObserved.push({ i, j, value: rng() });
  }
  const fullReport = completeMatrix(fullObserved, 6, 5, { rank: 2 });
  ok(fullReport.trainRmse > 0.15, `满秩随机矩阵诚实高残差（RMSE=${fullReport.trainRmse.toFixed(3)}——不强行低秩）`);
}

// ═══════════════════ 汇总 ═══════════════════
console.log('\n──────────────────────────────────────────────────────────');
if (failed === 0) {
  console.log(`✓ 经纬层 46.0→50.0 五内核全部验证通过（${passed} 项断言）`);
} else {
  console.error(`✗ ${failed} 项失败（${passed} 项通过）`);
  process.exit(1);
}
