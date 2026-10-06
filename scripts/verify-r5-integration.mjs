/**
 * verify-r5-integration.mjs — R5-A19「第五轮集成回归」联合冒烟（纯数据，零 I/O 零网络）
 *
 * 定位：18 个 verify-r5-*.mjs 内核级验证之上的**集成层**收口验证，三件事：
 *
 * ① 进化内核链（8 组跨组一条龙，全部经 dist/index.mjs 根入口取符号——
 *    导出面收口后新 API 必须从根入口可达才有资格进链）：
 *      76.0 novelty-detection（R5 新 LOF）过滤离群点
 *   →  69.0 mapper-graph（R5 分位数覆盖）对过滤后点集建经验地形骨架
 *   →  53.0 whittle-index（R5 策略迭代加速内层）按簇大小解退化臂闭式指数
 *   →  21.0 index-scheduling（R5 成本口径 Gittins）indexWithCost 边界态闭式
 *   →  63.0 nucleolus（R5 对称类 + 加速核仁）对称博弈精确等价
 *   →  99.0 attention-economy（R5 衰减经济）年龄单调不增 + 出局年龄簿记
 *   →  64.0 correlated-equilibrium（R5 learnCEFast）无悔动态逐位等价
 *   →  77.0 causal-discovery（R5 gesLite）线性 SEM 等价类恢复
 *
 * ② 性能等价抽查（3 条 R5 加速路径的大实例等价 + 方向性耗时，best-of-3）：
 *      learnCEFast vs learnCE / nucleolusFast vs nucleolus / allocateAttentionFast vs allocateAttention
 *
 * ③ 新导出面完整断言：R5-A19 收口的全部 80 个新符号（21 个内核文件）
 *    逐一从 dist/index.mjs 运行时可达（typeof 校验按值种类分桶）。
 *
 * 全部断言确定性（mulberry32 种子固定；耗时断言只取方向性且大实例化以抗负载抖动）。
 * 运行：node --experimental-transform-types scripts/verify-r5-integration.mjs
 *       （本脚本只 import dist/index.mjs，也可用纯 node 运行——transform-types
 *        口径与全套件一致，回归跑批统一用它）
 */

import { performance } from 'node:perf_hooks';
import * as root from '../dist/index.mjs';

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
/** best-of-3 耗时（ms）——抗负载抖动 */
function timeOf(fn) {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < 3; r += 1) {
    const t0 = performance.now();
    fn();
    const t1 = performance.now();
    best = Math.min(best, t1 - t0);
  }
  return best;
}

// 根入口符号解构（全部来自 dist/index.mjs —— ① 的「可达」前提本身就是断言）
const {
  mulberry32,
  localOutlierFactor,
  lofAUC,
  buildMapper,
  quantileCover,
  solveWhittleIndex,
  GittinsIndexTable,
  makeGame,
  makeGameFromPairs,
  nucleolus,
  nucleolusFast,
  symmetryClasses,
  geometricSource,
  allocateAttention,
  allocateAttentionFast,
  allocateAttentionDecayed,
  decayedSource,
  decayExitAge,
  normalGame,
  learnCE,
  learnCEFast,
  equilibriumGaps,
  randomDag,
  sampleLinearSem,
  gesLite,
  pcAlgorithm,
  structuralHammingDistance,
} = root;

// ═══════════════════ ① 进化内核链：8 组跨组一条龙 ═══════════════════

section('①-1 76.0 R5 LOF 新奇打分：双簇 + 外点数据过滤');

/** 合成两簇 + 均匀外点（seed 固定 → 全链确定性输入） */
function makeScene(seed) {
  const rng = mulberry32(seed);
  const gauss = () => {
    // Box-Muller（与内核无关的脚本内工具，仅数据生成）
    const u = Math.max(rng(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  const clusterA = Array.from({ length: 90 }, () => [gauss() * 0.4, gauss() * 0.4 + 3]);
  const clusterB = Array.from({ length: 90 }, () => [gauss() * 0.4 + 5, gauss() * 0.4]);
  // 外点带状远离两簇中心（(0,3) 与 (5,0)）——新奇检测的可识别信号
  const outliers = Array.from({ length: 12 }, (_, i) => [
    -4 - rng() * 2 + (i % 3) * 0.1,
    6 + rng() * 2,
  ]);
  return { clusterA, clusterB, outliers };
}

const scene = makeScene(20261002);
const reference = [...scene.clusterA, ...scene.clusterB];
const K = 8;
const inlierScores = scene.clusterA.slice(0, 40).map((p) => localOutlierFactor(reference, p, { k: K }).lof);
const outlierScores = scene.outliers.map((p) => localOutlierFactor(reference, p, { k: K }).lof);
const inlierMax = Math.max(...inlierScores);
const outlierMin = Math.min(...outlierScores);
ok(
  outlierMin > inlierMax,
  `LOF 完全分离：内点最大 ${inlierMax.toFixed(3)} ≪ 外点最小 ${outlierMin.toFixed(3)}（40 内点 vs 12 外点，k=8）`,
);
const auc = lofAUC(reference, scene.clusterA.slice(0, 40), scene.outliers, { k: K });
ok(near(auc.auc, 1, 1e-12), `lofAUC = ${auc.auc}（成对比较满秩——新评分口径可作排序信号入链）`);

section('①-2 69.0 R5 分位数覆盖 → Mapper 骨架（上一步过滤后的点集）');

const cleaned = reference.filter((p) => localOutlierFactor(reference, p, { k: K }).lof < 3);
const filterValues = cleaned.map((p) => p[1]);
const qcover = quantileCover(filterValues, 6, 0.3);
ok(qcover.length === 6, `quantileCover 6 档 × 30% 重叠：${qcover.length} 档（秩窗口覆盖）`);
let coverOK = qcover.every((c) => c.minValue <= c.maxValue && c.members.length >= 1);
for (let i = 0; i < qcover.length - 1; i += 1) {
  // 相邻核心秩窗口无隙拼满 [0,n)
  if (qcover[i].endRank !== qcover[i + 1].startRank) coverOK = false;
}
ok(
  coverOK && qcover[0].startRank === 0 && qcover[5].endRank === filterValues.length,
  `核心秩窗口无隙拼满 [0, n)：${qcover.map((c) => `[${c.startRank},${c.endRank})`).join(' ')}（n = ${filterValues.length}）`,
);
const mapperBalanced = buildMapper({
  points: cleaned,
  filter: (p) => p[1],
  intervals: 6,
  overlap: 0.3,
  clusterEps: 0.8,
  cover: 'balanced',
});
const mapperUniform = buildMapper({
  points: cleaned,
  filter: (p) => p[1],
  intervals: 6,
  overlap: 0.3,
  clusterEps: 0.8,
  cover: 'uniform',
});
const coveredIdx = new Set(mapperBalanced.nodes.flatMap((n) => n.members));
let noLoss = true;
for (let i = 0; i < cleaned.length; i += 1) if (!coveredIdx.has(i)) noLoss = false;
ok(
  mapperBalanced.nodes.length >= 2 && noLoss,
  `平衡覆盖 Mapper：${mapperBalanced.nodes.length} 节点、每点至少落一个纤维（${coveredIdx.size}/${cleaned.length} 点被覆盖——点不丢，重叠区点合法出现在多节点）`,
);
ok(
  mapperUniform.nodes.length >= 2,
  `等宽覆盖（向后兼容缺省路径）同数据 ${mapperUniform.nodes.length} 节点（两口径并存互不干扰）`,
);

section('①-3 53.0 Whittle 指数（R5 策略迭代加速内层）：退化臂闭式 + 随机臂收敛');

// 用上一步 Mapper 主节点的大小做“簇优先级”的退化臂（坏态收益与动作无关 ⟹ 可索引 + 闭式）
const sizes = mapperBalanced.nodes.map((n) => n.members.length).filter((s) => s >= 10);
const degenerateArm = (R, g) => ({
  pa: [
    [0, 1],
    [0, 1],
  ],
  pp: [
    [1, 0],
    [1, 0],
  ],
  activeReward: R,
  discount: g,
});
const wChain = sizes.slice(0, 4).map((s) => solveWhittleIndex(degenerateArm(s / 40, 0.9)).index);
ok(
  wChain.every((idx) => near(idx[0], 0.9 * idx[1], 2e-6)),
  `退化闭式 W = [γR, R]（γ=0.9）逐簇成立：${wChain.map((w) => `[${w[0].toFixed(3)},${w[1].toFixed(3)}]`).join(' ')}`,
);
const rng3 = mulberry32(530002);
let convCount = 0;
for (let i = 0; i < 30; i += 1) {
  const pa = [
    [rng3() * 0.8, 1],
    [rng3() * 0.5, 0.5],
  ].map((row, ri) => (ri === 0 ? [row[0], 1 - row[0]] : [row[0] * 0.5, 1 - row[0] * 0.5]));
  const arm = {
    pa,
    pp: [
      [0.9, 0.1],
      [0.2, 0.8],
    ],
    activeReward: 1 + rng3() * 3,
    discount: 0.85 + rng3() * 0.1,
  };
  if (solveWhittleIndex(arm).converged) convCount += 1;
}
ok(convCount === 30, `随机两态臂二分全部收敛 ${convCount}/30（R5 PI 内层——逐臂毫秒级）`);

section('①-4 21.0 Gittins 成本口径（R5 indexWithCost）：边界态闭式');

const gittins = new GittinsIndexTable({ discount: 0.95, maxCount: 200 });
const boundary = gittins.indexWithCost(150, 50, 0.1);
ok(
  near(boundary, 0.65, 1e-6),
  `ν^c(150,50,0.1) = ${boundary} = p̂ − c = 0.65（计算成本口径的已知臂闭式）`,
);
// 与上一步簇大小联动：各簇 (成功, 失败) 计数（按大小升序）→ 成本指数单调不降
const sortedSizes = [...new Set(sizes)].sort((a, b) => a - b);
const idxs = sortedSizes.map((s) => gittins.indexWithCost(s * 2, 20, 0.05));
ok(
  idxs.length >= 2 &&
    idxs.every((v) => Number.isFinite(v)) &&
    idxs.every((v, i) => i === 0 || v >= idxs[i - 1] - 1e-12),
  `簇大小升序 → 成本指数单调不降：sizes [${sortedSizes.join(',')}] → ν^c [${idxs.map((v) => v.toFixed(4)).join(', ')}]（大簇先看——调度语义正确）`,
);

section('①-5 63.0 加速核仁 + 对称类（R5）：对称博弈精确等价');

// 两簇大小构成 4 人对称-ish 博弈：玩家 0/1 属簇 A、2/3 属簇 B —— 同簇玩家对称
const s0 = sizes[0] ?? 30;
const s1 = sizes[1] ?? 30;
const game = makeGameFromPairs(4, [
  { mask: 0b0001, value: s0 },
  { mask: 0b0010, value: s0 },
  { mask: 0b0100, value: s1 },
  { mask: 0b1000, value: s1 },
  { mask: 0b0011, value: 2 * s0 },
  { mask: 0b1100, value: 2 * s1 },
  { mask: 0b0101, value: s0 + s1 },
  { mask: 0b1001, value: s0 + s1 },
  { mask: 0b0110, value: s0 + s1 },
  { mask: 0b1010, value: s0 + s1 },
  { mask: 0b0111, value: 2 * s0 + s1 },
  { mask: 0b1011, value: 2 * s0 + s1 },
  { mask: 0b1101, value: s0 + 2 * s1 },
  { mask: 0b1110, value: s0 + 2 * s1 },
  { mask: 0b1111, value: 2 * s0 + 2 * s1 },
]);
const classes = symmetryClasses(game);
const classPairs = new Set([`${classes[0]}-${classes[1]}`, `${classes[2]}-${classes[3]}`]);
ok(
  classes[0] === classes[1] && classes[2] === classes[3] && classes[0] !== classes[2],
  `symmetryClasses：同簇玩家同类（${classes.join(',')}）——两簇恰好两类`,
);
const exact = nucleolus(game);
const fast = nucleolusFast(game);
const sameX = exact.x.every((f, i) => f.eq(fast.x[i]));
ok(
  sameX && near(Number(exact.leastCoreEpsilon.sub(fast.leastCoreEpsilon)) ?? 0, 0, 0) === true,
  `nucleolusFast ≡ nucleolus（x 逐分量精确相等，ε = ${exact.leastCoreEpsilon.toString()}）`,
);
ok(
  fast.x[0].eq(fast.x[1]) && fast.x[2].eq(fast.x[3]),
  `对称玩家核仁分配相等（x₀ = x₁ = ${fast.x[0].toString()}，x₂ = x₃ = ${fast.x[2].toString()}）——公平性沿链传导`,
);

section('①-6 99.0 注意力衰减经济（R5）：年龄单调 + 出局簿记');

const sources = sizes.slice(0, 4).map((s, i) => geometricSource(`cluster-${i}`, s, 0.85));
const alloc0 = allocateAttentionDecayed(sources, 6, [0, 5, 10, 40], 8);
const alloc1 = allocateAttentionDecayed(sources, 6, [0, 6, 11, 41], 8);
ok(
  alloc0.slots.every((c, i) => c >= alloc1.slots[i]),
  `年龄 +1 后各源槽位单调不增：[${alloc0.slots.join(',')}] → [${alloc1.slots.join(',')}]`,
);
const exitAges = alloc0.exitAges.map((a) => (Number.isFinite(a) ? a : Infinity));
ok(
  exitAges.every((a) => a >= 0),
  `出局年龄余量非负：[${exitAges.map((a) => (Number.isFinite(a) ? a.toFixed(1) : '∞')).join(', ')}] 窗（新鲜度仪表）`,
);
const price = alloc0.marginalPrice > 0 ? alloc0.marginalPrice : 0.5;
const wrapped = decayedSource(sources[0], 16, 8);
ok(
  near(wrapped.marginalValue(0), sources[0].marginalValue(0) * 0.25, 1e-12) &&
    Number.isFinite(decayExitAge(sources[0].marginalValue(0), price, 8)),
  `decayedSource 半衰期 8、年龄 16 ⟹ 边际 ×0.25；decayExitAge 有限（价格 ${price.toFixed(3)}）`,
);

section('①-7 64.0 learnCEFast（R5）：无悔动态与经典逐位等价');

// 两簇“竞争注意力”的 2×2 行动博弈：占优均衡在簇 0（大簇）
const battle = normalGame([2, 2], [[s0 * 0.01, 0, 0, s1 * 0.01], [0, s1 * 0.005, s0 * 0.005, 0]]);
const a7 = learnCE(battle, 4000, 7);
const b7 = learnCEFast(battle, 4000, 7);
ok(JSON.stringify(a7) === JSON.stringify(b7), 'learnCEFast(4000 步) 输出与 learnCE JSON 逐位相同（同 RNG 序）');
const gaps7 = equilibriumGaps(a7.jointFreq, battle);
ok(
  gaps7.cceGap >= 0 && gaps7.ceGap >= gaps7.cceGap - 1e-12,
  `均衡间隙分层：cceGap = ${gaps7.cceGap.toFixed(5)} ≤ ceGap = ${gaps7.ceGap.toFixed(5)}（Nash ⊆ CE ⊆ CCE 单调）`,
);

section('①-8 77.0 gesLite（R5）：线性 SEM 等价类恢复（与 PC 互证）');

const trueDag = randomDag(4, 0.4, 77001);
const data8 = sampleLinearSem(trueDag, 800, { noiseStd: 1.0 }, 77002);
const ges = gesLite(data8);
const pc = pcAlgorithm(data8, { alpha: 0.01 });
const shd = structuralHammingDistance(ges.cpdag, pc.cpdag);
ok(
  Number.isFinite(ges.score) && ges.dag.length === 4,
  `gesLite：BIC = ${ges.score.toFixed(1)}，d=4 DAG 非空（${ges.nEvals} 次局部评分）`,
);
ok(shd === 0, `gesLite 与 PC 等价类一致（SHD = ${shd}——两条独立路径（评分 vs 约束）收敛同一 CPDAG）`);

// ═══════════════════ ② 性能等价抽查：3 条 R5 加速路径 ═══════════════════

section('②-1 learnCEFast 大实例：逐位等价 + 方向性耗时');

{
  const rng = mulberry32(64);
  const actions = [4, 3, 3, 2, 2];
  const J = actions.reduce((x, y) => x * y, 1);
  const utils = Array.from({ length: 5 }, () => Array.from({ length: J }, () => rng() * 2 - 1));
  const big = normalGame(actions, utils);
  const ref = learnCE(big, 20000, 991);
  const fastRun = learnCEFast(big, 20000, 991);
  ok(JSON.stringify(ref) === JSON.stringify(fastRun), '5 方 × 144 联合行动 × 20000 步：输出 JSON 逐位相同');
  const tClassical = timeOf(() => learnCE(big, 20000, 991));
  const tFast = timeOf(() => learnCEFast(big, 20000, 991));
  ok(
    tFast <= tClassical,
    `耗时（best-of-3）：learnCE ${tClassical.toFixed(1)}ms → learnCEFast ${tFast.toFixed(1)}ms（×${(tClassical / tFast).toFixed(2)}）`,
  );
}

section('②-2 nucleolusFast 大实例（n=7 对称博弈）：精确等价 + LP 数下降 + 方向性耗时');

{
  // 7 人「四族对称」博弈（{0,1}{2,3}{4,5}{6}）：联盟值只依赖各族计数
  // ⟹ 族内玩家可交换 → 对称类塌缩是快径的主战场（值函数确定、无随机）
  const players = 7;
  const famOf = (i) => Math.floor(i / 2); // 0,0,1,1,2,2,3
  const famWeight = (k, c) => (k + 1) * Math.pow(c, 1.5); // 凹次可加
  const entries = [];
  for (let mask = 1; mask < 1 << players; mask += 1) {
    const famCount = new Map();
    for (let b = 0; b < players; b += 1) {
      if (mask & (1 << b)) famCount.set(famOf(b), (famCount.get(famOf(b)) ?? 0) + 1);
    }
    let v = 0;
    for (const [k, c] of famCount) v += famWeight(k, c);
    entries.push({ mask, value: Math.round(v * 16) / 16 });
  }
  const game7 = makeGameFromPairs(players, entries);
  const exact7 = nucleolus(game7);
  const fast7 = nucleolusFast(game7);
  const same =
    exact7.x.every((f, i) => f.eq(fast7.x[i])) && exact7.leastCoreEpsilon.eq(fast7.leastCoreEpsilon);
  ok(same, `n=7（127 联盟）：x 与 ε 精确相等（shortcut = ${fast7.shortcut}，classCount = ${fast7.classCount}）`);
  const roundsEquiv =
    fast7.rounds.length === exact7.rounds.length &&
    fast7.rounds.every(
      (r, i) =>
        r.epsilon.eq(exact7.rounds[i].epsilon) &&
        r.settled.length === exact7.rounds[i].settled.length &&
        r.settled.every((m, j) => m === exact7.rounds[i].settled[j]),
    );
  ok(
    roundsEquiv,
    `逐级轨迹全同：${fast7.rounds.length} 级 ε 与定居联盟序列精确一致（类塌缩不改数学对象）`,
  );
  const tExact = timeOf(() => nucleolus(game7));
  const tFast = timeOf(() => nucleolusFast(game7));
  ok(
    tFast <= tExact,
    `耗时（best-of-3）：nucleolus ${tExact.toFixed(1)}ms → nucleolusFast ${tFast.toFixed(1)}ms（×${(tExact / tFast).toFixed(2)}）`,
  );
}

section('②-3 allocateAttentionFast 大实例：逐位等价 + 方向性耗时');

{
  const big = Array.from({ length: 300 }, (_, i) => geometricSource(`b${i}`, 1 + (i % 50), 0.85));
  const a = allocateAttention(big, 60);
  const b = allocateAttentionFast(big, 60);
  const same = JSON.stringify([a.slots, a.payments, a.utilities, a.totalValue, a.revenue, a.marginalPrice, a.idleSlots, a.awards]) ===
    JSON.stringify([b.slots, b.payments, b.utilities, b.totalValue, b.revenue, b.marginalPrice, b.idleSlots, b.awards]);
  ok(same, 'n=300 源 / k=60 槽：支付快径与经典口径（含 awards 逐槽轨迹）逐位相同');
  const tClassical = timeOf(() => allocateAttention(big, 60));
  const tFast = timeOf(() => allocateAttentionFast(big, 60));
  ok(
    tFast <= tClassical,
    `耗时（best-of-3）：经典 ${tClassical.toFixed(1)}ms → 快径 ${tFast.toFixed(1)}ms（×${(tClassical / tFast).toFixed(2)}）`,
  );
}

// ═══════════════════ ③ 新导出面完整断言（R5-A19 收口的 80 符号） ═══════════════════

section('③ R5 新导出面：80 个新符号全部从 dist/index.mjs 可达');

/** 值种类分桶：f = function、c = class、o = object/const */
const R5_EXPORTS = [
  // 3.0 evidence（5）
  ['wilsonUpperBound', 'f'], ['logBeta', 'f'], ['BAYES_FACTOR_THRESHOLDS', 'o'],
  ['bayesFactor', 'f'], ['synthesizeEvidence', 'f'],
  // 58.0 langevin-sampling（3）
  ['leapfrogProposal', 'f'], ['ouRefreshScale', 'f'], ['underdampedMala', 'f'],
  // 61.0 stable-matching（5）
  ['capacityDeferredAcceptance', 'f'], ['deferredAcceptanceQueued', 'f'],
  ['isStableManyToOne', 'f'], ['randomHospitalResidentsProblem', 'f'], ['ruralHospitalCheck', 'f'],
  // 62.0 mechanism-design（1）
  ['combinatorialVcg', 'f'],
  // 63.0 nucleolus（2）
  ['nucleolusFast', 'f'], ['symmetryClasses', 'f'],
  // 64.0 correlated-equilibrium（3）
  ['isCoarseCorrelatedEquilibrium', 'f'], ['equilibriumGaps', 'f'], ['learnCEFast', 'f'],
  // 68.0 compression-distance（4）
  ['lz77Compress', 'f'], ['ncdLz77', 'f'], ['ncdCacheStats', 'f'], ['resetNcdCache', 'f'],
  // 76.0 novelty-detection（3）
  ['localOutlierFactor', 'f'], ['lofAUC', 'f'], ['halfspaceDepth1D', 'f'],
  // 77.0 causal-discovery（1）
  ['gesLite', 'f'],
  // 79.0 diffusion-maps（2）
  ['landmarkDiffusion', 'f'], ['diffusionScaleSweep', 'f'],
  // 83.0 world-model-learning（2）
  ['prioritizedSweeping', 'f'], ['randomTabularMDP', 'f'],
  // 86.0 options-framework（5）
  ['bottleneckStates', 'f'], ['articulationPoints', 'f'], ['stateBetweenness', 'f'],
  ['optionsFromBottlenecks', 'f'], ['optionTables', 'f'],
  // 87.0 safety-barrier（1）
  ['cbfFilterConjunction', 'f'],
  // 89.0 safe-policy-improvement（3）
  ['bonferroniDelta', 'f'], ['MULTI_CORRECTION', 'o'], ['safePolicyImproveMulti', 'f'],
  // 90.0 preference-learning（5）
  ['plackettLuceProbability', 'f'], ['plackettLuceChoiceProbability', 'f'],
  ['plackettLuceLogProb', 'f'], ['plackettLuceMLE', 'f'], ['simulateRankings', 'f'],
  // 92.0 self-play（2）
  ['bestResponseWeakness', 'f'], ['evolutionaryStabilityRank', 'f'],
  // 94.0 simulation-calibration（2）
  ['truncateWeights', 'f'], ['weightedBootstrap', 'f'],
  // 97.0 metacognitive-confidence（2）
  ['metaDprimeFit', 'f'], ['bayesOptimalReport', 'f'],
  // 99.0 attention-economy（4）
  ['decayedSource', 'f'], ['decayExitAge', 'f'], ['allocateAttentionDecayed', 'f'], ['allocateAttentionFast', 'f'],
  // 100.0 self-boundary（5）
  ['IncrementalContingency', 'c'], ['multiStepAttribution', 'f'], ['otherAgentModel', 'f'],
  ['simulateOtherAgent', 'f'], ['simulateChain', 'f'],
  // 81.0 argumentation（7）
  ['valueFramework', 'f'], ['inducedFramework', 'f'], ['allAudiences', 'f'],
  ['attackSucceeds', 'f'], ['valueAcceptance', 'f'], ['randomValueFramework', 'f'], ['VAF_MAX_VALUES', 'o'],
  // 4.0 resilience（13）
  ['weibullLogSurvival', 'f'], ['weibullSurvival', 'f'], ['weibullHazard', 'f'],
  ['weibullMean', 'f'], ['weibullVariance', 'f'], ['weibullCoefficientOfVariation', 'f'],
  ['weibullDiagnostics', 'f'], ['steadyStateAvailability', 'f'], ['logDomainAvailability', 'f'],
  ['systemAvailability', 'f'], ['redundancyGainLog', 'f'], ['repairSpeedGainLog', 'f'],
  ['resilienceBudget', 'f'],
];

{
  const kindOf = (v) => (typeof v === 'function' && /^class\s/.test(Function.prototype.toString.call(v)) ? 'c' : typeof v === 'function' ? 'f' : 'o');
  const missing = [];
  const wrongKind = [];
  for (const [name, kind] of R5_EXPORTS) {
    if (!(name in root) || root[name] === undefined) missing.push(name);
    else if (kindOf(root[name]) !== kind) wrongKind.push(`${name}(期望 ${kind} 实为 ${kindOf(root[name])})`);
  }
  ok(R5_EXPORTS.length === 80, `清单基数 = ${R5_EXPORTS.length}（与 R5-A19 导出收口计数一致）`);
  ok(missing.length === 0, `80 符号全部运行时可达（缺席：${missing.length ? missing.join(', ') : '无'}）`);
  ok(wrongKind.length === 0, `值种类正确（f=函数 c=类 o=对象；异常：${wrongKind.length ? wrongKind.join(', ') : '无'}）`);
}

// ═══════════════════ 汇总 ═══════════════════

console.log(`\n══ verify-r5-integration ══`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) {
  console.error('集成冒烟存在失败项');
  process.exit(1);
}
console.log('第五轮集成冒烟全绿：进化内核链 8 组 + 加速等价 3 路 + 导出面 80 符号');
process.exit(0);
