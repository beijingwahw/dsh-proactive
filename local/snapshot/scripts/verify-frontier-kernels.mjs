/**
 * verify-frontier-kernels.mjs — 17.0→20.0「几何与拓扑层」四内核离线验证
 *
 * 每个内核的数学核心都有解析解对照（不是「能跑」，是「算得对」）：
 *   17.0 最优传输：W₁ 点测度 = 0.3（精确）；均值不变形状巨变 W₁ > 0
 *        （z-score 水位检测盲区可见）；Sinkhorn 边际精确恢复；
 *        漂移监视器平稳期零误报、双峰注入后 shape 漂移
 *   18.0 信息几何：坐标缩放 100×/0.01× 后 Mahalanobis 步长 6 位
 *        小数不变（仿射不变性——本内核的数学心脏）；KL 信任域封顶
 *   19.0 最优停止：均匀分布先知价值 = 2/3、向后归纳 V₁=0.5/V₂=0.625
 *        （理论值精确对上）；Samuel-Cahn ≥ ½ 先知保证；行动裁决
 *   20.0 层论共识：相容观测 → 完美共识 = 加权平均；循环硬约束 +
 *        矛盾观测 → 结构性障碍（平均化会假装矛盾不存在）；解析
 *        解 0.712/0.604 对照；声明重叠融合（共享坐标调和、独占不动）
 */
import {
  wasserstein1D,
  wassersteinBarycenter1D,
  sinkhorn,
  TransportDriftMonitor,
  FisherGeometryEngine,
  prophetValue,
  backwardInduction,
  samuelCahnRule,
  OpportunityStopper,
  CellularSheaf,
  scalarAgreementSheaf,
} from '../dist/index.mjs';

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name} — ${detail}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name} — ${detail}`);
  }
}

console.log('17.0 最优传输内核');
{
  const w = wasserstein1D([0.6, 0.6, 0.6, 0.6], [0.9, 0.9, 0.9, 0.9]);
  check('W1 点测度', Math.abs(w - 0.3) < 0.01, `W1=${w}（期望 0.3）`);
  const uni = Array.from({ length: 40 }, () => 0.5);
  const bimodal = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.2 : 0.8));
  const wShape = wasserstein1D(uni, bimodal);
  check('W1 形状盲区', wShape > 0.1, `均值均为 0.5，W1=${wShape.toFixed(3)}（z-score 均值检测不可见）`);
  const bc = wassersteinBarycenter1D([[0.3, 0.3, 0.3, 0.3], [0.7, 0.7, 0.7, 0.7]]);
  const bcMean = bc.reduce((s, x) => s + x, 0) / bc.length;
  check('重心均值', Math.abs(bcMean - 0.5) < 0.01, `barycenter 均值=${bcMean.toFixed(3)}`);
  const cost = [[0.5, 1], [1, 0.5]];
  const r = sinkhorn(cost, [1, 1], [1, 1], { epsilon: 0.1, maxIterations: 500, tolerance: 1e-6 });
  const rowSums = r.plan.map((row) => row.reduce((s, x) => s + x, 0));
  const colSums = [0, 1].map((j) => r.plan.reduce((s, row) => s + row[j], 0));
  check(
    'Sinkhorn 边际',
    r.converged && rowSums.every((s) => Math.abs(s - 0.5) < 1e-4) && colSums.every((s) => Math.abs(s - 0.5) < 1e-4),
    `行边际=${rowSums.map((s) => s.toFixed(4))}, 列边际=${colSums.map((s) => s.toFixed(4))}, 迭代 ${r.iterations}`,
  );
  const monitor = new TransportDriftMonitor({ windowSize: 30, referenceSize: 120, minSamples: 15 });
  let rngState = 42;
  const rng = () => ((rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 100; i += 1) monitor.observe(0.5 + 0.1 * (rng() - 0.5));
  const before = monitor.drift();
  for (let i = 0; i < 30; i += 1) monitor.observe(i % 2 === 0 ? 0.15 : 0.85);
  const after = monitor.drift();
  check('漂移监视器', !before.drifting && after.drifting && after.kind !== 'level', `漂移前 kind=${before.kind} → 漂移后 kind=${after.kind}, W1=${after.w1} > 阈 ${after.threshold}`);
}

console.log('18.0 信息几何内核');
{
  const points = [[0.2, 0.8], [0.25, 0.75], [0.3, 0.7], [0.22, 0.78], [0.28, 0.72]];
  const geo = new FisherGeometryEngine({ klBudget: 1.5, rng: () => 0.42 });
  geo.estimate(points);
  const scaled = points.map(([x, y]) => [x * 100, y * 0.01]);
  const geoScaled = new FisherGeometryEngine({ klBudget: 1.5, rng: () => 0.42 });
  geoScaled.estimate(scaled);
  const m1 = geo.naturalMutate([0.25, 0.75], 1);
  const m2 = geoScaled.naturalMutate([25, 0.0075], 1);
  check('坐标不变性', Math.abs(m1.mahalanobis - m2.mahalanobis) < 1e-6, `Mahalanobis ${m1.mahalanobis.toFixed(6)} vs ${m2.mahalanobis.toFixed(6)}（坐标缩放 100×/0.01× 后不变）`);
  check('KL 信任域', m1.klStep <= 1.5 ** 2 / 2 + 1e-9, `klStep=${m1.klStep} ≤ δ²/2=${(1.5 ** 2 / 2).toFixed(3)}`);
  const rep = geo.report();
  check('几何诊断', rep.dimension === 2 && rep.effectiveDimension <= 2, `有效维 ${rep.effectiveDimension}（强反相关 → ≈1 维流形）`);
}

console.log('19.0 最优停止内核');
{
  const uniform = Array.from({ length: 400 }, (_, i) => (i + 0.5) / 400);
  const pv = prophetValue(uniform, 2);
  const { values } = backwardInduction(uniform, 2);
  const sc = samuelCahnRule(uniform, 2);
  check('先知价值', Math.abs(pv - 2 / 3) < 0.01, `E[max₂]=${pv.toFixed(4)}（理论 0.6667）`);
  check('向后归纳', Math.abs(values[1] - 0.5) < 0.01 && Math.abs(values[0] - 0.625) < 0.01, `V₁=${values[1].toFixed(3)}, V₂=${values[0].toFixed(3)}（理论 0.5, 0.625）`);
  check('Samuel-Cahn ½ 保证', sc.ruleValue >= 0.5 * sc.prophet - 0.005, `规则值 ${sc.ruleValue.toFixed(3)} ≥ ½×先知 ${(0.5 * sc.prophet).toFixed(3)}（阈值 τ=${sc.threshold}）`);
  const stopper = new OpportunityStopper({ minSamples: 10 });
  for (let i = 0; i < 20; i += 1) stopper.note('deploy', 0.3 + (0.15 * (i % 3)) / 2);
  const high = stopper.assess('deploy', 0.92, 3);
  const low = stopper.assess('deploy', 0.1, 3);
  check('行动裁决', high.act && !low.act, `0.92 ≥ 阈 ${high.threshold} → act；0.10 < 阈 → wait（成色 ${(high.competitiveRatio * 100).toFixed(0)}%）`);
}

console.log('20.0 层论共识内核');
{
  const two = scalarAgreementSheaf(['market', 'stats']);
  const rNear = two.harmonize([{ id: 'market', values: [0.62], weight: 1 }, { id: 'stats', values: [0.58], weight: 2 }]);
  const expectedMean = (1 * 0.62 + 2 * 0.58) / 3;
  check(
    '加权调解（相容）',
    rNear.obstruction === 'none' &&
      Math.abs(rNear.consensus.market[0] - expectedMean) < 1e-3 &&
      Math.abs(rNear.consensus.stats[0] - rNear.consensus.market[0]) < 1e-4,
    `consensus=${rNear.consensus.market[0].toFixed(4)}（加权平均 ${expectedMean.toFixed(4)}，完美一致）, 障碍=${rNear.obstruction}`,
  );
  const rFar = two.harmonize([{ id: 'market', values: [0.82], weight: 1 }, { id: 'stats', values: [0.55], weight: 2 }]);
  check(
    '结构性调解（相斥）',
    rFar.obstruction === 'structural-conflict' &&
      Math.abs(rFar.consensus.market[0] - 0.712) < 0.005 &&
      Math.abs(rFar.consensus.stats[0] - 0.604) < 0.005,
    `障碍=${rFar.obstruction}，调解值 ${rFar.consensus.market[0].toFixed(3)}/${rFar.consensus.stats[0].toFixed(3)}（解析解 0.712/0.604；0.82 与 0.55 无法被任何完美共识同时解释——平均 0.64 会假装矛盾不存在）`,
  );
  const tri = new CellularSheaf();
  tri.addVertex('A', 1).addVertex('B', 1).addVertex('C', 1);
  tri.addEdge({ a: 'A', b: 'B' }).addEdge({ a: 'B', b: 'C' }).addEdge({ a: 'C', b: 'A' });
  const r3 = tri.harmonize([
    { id: 'A', values: [0.9], weight: 50 },
    { id: 'B', values: [0.1], weight: 50 },
    { id: 'C', values: [0.5], weight: 50 },
  ]);
  check('结构性障碍', r3.obstruction === 'structural-conflict' && r3.disagreementEnergy > 0.01, `能量地板=${r3.disagreementEnergy}（平均会说 0.5 皆大欢喜——本内核说无解）`);
  const r4 = tri.harmonize([
    { id: 'A', values: [0.6], weight: 5 },
    { id: 'B', values: [0.62], weight: 5 },
    { id: 'C', values: [0.61], weight: 5 },
  ]);
  check('可调和', r4.obstruction === 'none', `分歧能量=${r4.disagreementEnergy.toExponential(2)}（相容观测 → 完美共识）`);
  const ov = new CellularSheaf();
  ov.addVertex('modelA', 3).addVertex('modelB', 3);
  ov.addEdge({ a: 'modelA', b: 'modelB', sharedA: [0, 1], sharedB: [0, 1] });
  const r5 = ov.harmonize([
    { id: 'modelA', values: [0.8, 0.4, 0.9], weight: 1 },
    { id: 'modelB', values: [0.6, 0.6, 0.3], weight: 1 },
  ]);
  const c1 = (r5.consensus.modelA[0] + r5.consensus.modelB[0]) / 2;
  check('声明重叠融合', Math.abs(c1 - 0.7) < 1e-6 && Math.abs(r5.consensus.modelA[2] - 0.9) < 1e-9, `共享 c1 → ${c1.toFixed(3)}（0.8/0.6 调和为 0.7）；独占 c3 → ${r5.consensus.modelA[2]} 不动`);
}

console.log(failures === 0 ? '\n全部数学验证通过 ✓' : `\n${failures} 项验证失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
