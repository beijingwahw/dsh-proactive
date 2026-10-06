/**
 * verify-partial-info-decomposition.mjs — 70.0「部分信息分解」内核纯数学离线验证
 *
 * 直接 import 内核源文件（node --experimental-strip-types 运行，不经 dist 构建）。
 * 每个断言都有解析解、构造轨迹或文献已知值对照（不是「能跑」，是「算得对」）：
 *   ① XOR 门（BROJA 文献）：I=1 bit、R=0、U₁=U₂=0、C=1 —— 协同纯血统
 *   ② COPY 门（X₁=X₂=S 均匀）：R=1、C=0、U=0 —— 冗余纯血统
 *   ③ AND 门（BROJA 文献值）：R≈0.3113、U₁=U₂=0、C=0.5（容差 0.02）；
 *      另用公开 mutualInformation 工具对 AND 的一维可行族做独立网格
 *      重推导，与求解器最优值对照（≤1e-4）
 *   ④ 独占例（S=X₁、X₂ 独立噪声）：U₁=1、其余 0
 *   ⑤ 守恒律 R+U₁+U₂+C = I（≤1e-9）+ BROJA 局部一致性 R+Uᵢ = I(Xᵢ;S)
 *      （≤1e-9）—— 四门 + 噪声 XOR + 随机联合分布
 *   ⑥ 求解器收敛性：目标序列单调不增、边缘约束违反 ≤1e-9、
 *      m ∈ [max(I(X₁;S),I(X₂;S)), I(X₁,X₂;S)]（理论下/上界）、AND 真实
 *      优化了（目标下降 > 0.2 bit）
 *   ⑦ O 信息（Rosas 符号约定）：XOR Ω=−1<0 协同主导、COPY Ω=+1>0
 *      冗余主导、AND Ω≈−0.1887、三源奇偶 Ω=−1、三源全拷贝 Ω=+2
 *   ⑧ 噪声 XOR（ε=0.1 对称翻转）：I=1−H₂(0.1)=0.5310、R=U=0、C=I
 *   ⑨ 工具解析锚：entropy / mutualInformation 手算值
 *   ⑩ 入参校验（显式 throw）×17；同输入同输出（两次运行全报告 JSON 相同）
 *
 * 全部断言确定性（内核无随机源）。运行：
 *   node --experimental-strip-types scripts/verify-partial-info-decomposition.mjs
 */

import {
  entropy,
  mutualInformation,
  pidFromJoint,
  oInformation,
  bivariateGates,
} from '../src/core/partial-info-decomposition.ts';

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
/** 确定性 RNG（mulberry32）——只用于生成随机联合分布的测试输入 */
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
const H2 = (p) => entropy([p, 1 - p]);

const gates = bivariateGates();

// ═══════════════════ ⑨ 熵 / 互信息工具 ═══════════════════

section('⑨ 工具函数：熵 / 互信息的解析锚');

ok(near(entropy([0.5, 0.5]), 1, 1e-12), `entropy([0.5,0.5]) = ${entropy([0.5, 0.5])}（均匀二值 H=1 bit）`);
ok(near(entropy([0.25, 0.25, 0.25, 0.25]), 2, 1e-12), 'entropy 四值均匀 = 2 bit');
ok(near(entropy([1, 0]), 0, 1e-12), 'entropy 点质量 = 0（0·log0 = 0 约定）');
ok(near(entropy([0.75, 0.25]), 0.8112781244591328, 1e-12), `entropy([0.75,0.25]) = H₂(1/4) = ${entropy([0.75, 0.25]).toFixed(10)}`);
ok(near(entropy([50, 50]), 1, 1e-12), '未归一化输入自动归一（[50,50] ≡ [0.5,0.5]）');
ok(near(mutualInformation([[0.25, 0.25], [0.25, 0.25]]), 0, 1e-12), 'mutualInformation 独立 → I = 0');
ok(near(mutualInformation([[0.5, 0], [0, 0.5]]), 1, 1e-12), 'mutualInformation 完全相关 → I = 1 bit');
ok(near(mutualInformation([[0.5, 0], [0.25, 0.25]]), 0.3112781244591328, 1e-12), `AND 门 p(x₁,s) 表 → I(X₁;S) = H₂(1/4)−1/2 = ${mutualInformation([[0.5, 0], [0.25, 0.25]]).toFixed(10)}（手算锚）`);

// ═══════════════════ ①-④ 四门 BROJA 分解 ═══════════════════

section('① XOR：协同纯血统（文献 I=1、R=0、U=0、C=1）');
const pidXor = pidFromJoint(gates.xor.joint);
ok(
  near(pidXor.total, 1, 1e-12) &&
    Math.abs(pidXor.redundant) <= 1e-9 &&
    Math.abs(pidXor.unique1) <= 1e-9 &&
    Math.abs(pidXor.unique2) <= 1e-9 &&
    near(pidXor.synergistic, 1, 1e-9),
  `XOR：I=${pidXor.total}，R=${pidXor.redundant}，U₁=${pidXor.unique1}，U₂=${pidXor.unique2}，C=${pidXor.synergistic}（单路零信息、联合全知）`,
);
ok(near(pidXor.iSource1, 0, 1e-12) && near(pidXor.iSource2, 0, 1e-12), 'XOR：I(X₁;S)=I(X₂;S)=0（单路与目标统计独立）');

section('② COPY：冗余纯血统（文献 R=1、C=0、U=0）');
const pidCopy = pidFromJoint(gates.copy.joint);
ok(
  near(pidCopy.total, 1, 1e-12) &&
    near(pidCopy.redundant, 1, 1e-9) &&
    Math.abs(pidCopy.unique1) <= 1e-9 &&
    Math.abs(pidCopy.unique2) <= 1e-9 &&
    Math.abs(pidCopy.synergistic) <= 1e-9,
  `COPY：I=${pidCopy.total}，R=${pidCopy.redundant}，U₁=${pidCopy.unique1}，U₂=${pidCopy.unique2}，C=${pidCopy.synergistic}（可行集钉死为单点 q=p）`,
);

section('③ AND：BROJA 文献值 R≈0.3113、U=0、C=0.5');
const pidAnd = pidFromJoint(gates.and.joint);
ok(
  near(pidAnd.total, 0.8112781244591328, 1e-12) && Math.abs(pidAnd.redundant - 0.3113) <= 0.02 && Math.abs(pidAnd.synergistic - 0.5) <= 0.02,
  `AND 文献锚（容差 0.02）：I=${pidAnd.total.toFixed(6)}=H₂(1/4)，R=${pidAnd.redundant.toFixed(6)}≈0.3113，C=${pidAnd.synergistic.toFixed(6)}≈0.5`,
);
ok(
  near(pidAnd.redundant, 0.3112781244591328, 2e-6) &&
    Math.abs(pidAnd.unique1) <= 2e-6 &&
    Math.abs(pidAnd.unique2) <= 2e-6 &&
    near(pidAnd.synergistic, 0.5, 2e-6),
  `AND 紧公差 2e-6：R=${pidAnd.redundant.toFixed(9)}，U₁=${pidAnd.unique1.toExponential(2)}，U₂=${pidAnd.unique2.toExponential(2)}，C=${pidAnd.synergistic.toFixed(9)}（求解器真正收敛到文献最优点）`,
);
ok(near(pidAnd.iSource1, 0.3112781244591328, 1e-12) && near(pidAnd.iSource2, 0.3112781244591328, 1e-12), 'AND：I(Xᵢ;S) = H₂(1/4)−1/2 = 0.3113（对称性）');

// 独立重推导：AND 可行集一维参数化 a ∈ [1/3, 2/3]（s=1 列被行/列边缘钉死为点质量）。
// 目标 g(a) = I₁ + I₂ + Σ_s p(s)·MI(q_s(a)) − MI(mix(a))，只用公开 mutualInformation 工具重走。
{
  const i1 = mutualInformation([[0.5, 0], [0.25, 0.25]]);
  let best = Infinity;
  let bestA = 0;
  for (let i = 0; i <= 4000; i += 1) {
    const a = 1 / 3 + (1 / 3) * (i / 4000);
    const q0 = [
      [a, 2 / 3 - a],
      [2 / 3 - a, a - 1 / 3],
    ];
    const mix = [
      [0.75 * q0[0][0], 0.75 * q0[0][1]],
      [0.75 * q0[1][0], 0.75 * q0[1][1] + 0.25],
    ];
    const g = 2 * i1 + 0.75 * mutualInformation(q0) - mutualInformation(mix);
    if (g < best) {
      best = g;
      bestA = a;
    }
  }
  ok(
    Math.abs(best - pidAnd.minimizedJointInfo) <= 1e-4 && Math.abs(best - 0.3112781244591328) <= 1e-3,
    `独立网格重推导：min g(a) = ${best.toFixed(6)}（a*=${bestA.toFixed(4)} 边界点）vs 求解器 m = ${pidAnd.minimizedJointInfo.toFixed(6)}（只用 mutualInformation 工具重走可行族）`,
  );
}

section('④ 独占例 S=X₁、X₂ 独立噪声：U₁=1 其余 0');
const pidSrc = pidFromJoint(gates.sourceX.joint);
ok(
  near(pidSrc.total, 1, 1e-12) &&
    Math.abs(pidSrc.redundant) <= 1e-9 &&
    near(pidSrc.unique1, 1, 1e-9) &&
    Math.abs(pidSrc.unique2) <= 1e-9 &&
    Math.abs(pidSrc.synergistic) <= 1e-9,
  `独占：I=${pidSrc.total}，R=${pidSrc.redundant}，U₁=${pidSrc.unique1}，U₂=${pidSrc.unique2}，C=${pidSrc.synergistic}（信息全在 X₁ 一路）`,
);

// ═══════════════════ ⑧ 噪声 XOR ═══════════════════

section('⑧ 噪声 XOR（ε=0.1 对称翻转）：解析锚 I = 1 − H₂(ε)');
const eps = 0.1;
const noisyXor = [
  [
    [(1 - eps) / 4, eps / 4],
    [eps / 4, (1 - eps) / 4],
  ],
  [
    [eps / 4, (1 - eps) / 4],
    [(1 - eps) / 4, eps / 4],
  ],
];
const pidNoisy = pidFromJoint(noisyXor);
const expectedNoisyI = 1 - H2(0.1);
ok(near(pidNoisy.total, expectedNoisyI, 1e-9), `I = 1 − H₂(0.1) = ${expectedNoisyI.toFixed(10)}（实测 ${pidNoisy.total.toFixed(10)}）`);
ok(
  Math.abs(pidNoisy.redundant) <= 1e-9 && Math.abs(pidNoisy.unique1) <= 1e-9 && Math.abs(pidNoisy.unique2) <= 1e-9,
  `对称噪声下 R=U=0（Xᵢ⊥S 保持，独立耦合即 BROJA 最优——实测 R=${pidNoisy.redundant.toExponential(2)}，U₁=${pidNoisy.unique1.toExponential(2)}，U₂=${pidNoisy.unique2.toExponential(2)}）`,
);
ok(near(pidNoisy.synergistic, expectedNoisyI, 1e-9), `C = I 全额协同（实测 C=${pidNoisy.synergistic.toFixed(10)}）——去噪不改变协同主导`);
ok(oInformation(noisyXor).oInformation < 0, '噪声 XOR 的 Ω < 0（协同主导判读不变）');

// ═══════════════════ ⑤ 守恒律 + 局部一致性 ═══════════════════

section('⑤ 守恒律 R+U₁+U₂+C = I 与 BROJA 局部一致性 R+Uᵢ = I(Xᵢ;S)');

const rng = mulberry32(70);
const cells = [];
let z = 0;
for (let i = 0; i < 8; i += 1) {
  const v = 0.1 + rng();
  cells.push(v);
  z += v;
}
const randJoint = [
  [
    [cells[0] / z, cells[1] / z],
    [cells[2] / z, cells[3] / z],
  ],
  [
    [cells[4] / z, cells[5] / z],
    [cells[6] / z, cells[7] / z],
  ],
];
const pidRandom = pidFromJoint(randJoint);
const collapsedRandom = [
  [cells[0] / z, cells[1] / z],
  [cells[2] / z, cells[3] / z],
  [cells[4] / z, cells[5] / z],
  [cells[6] / z, cells[7] / z],
];
ok(near(pidRandom.total, mutualInformation(collapsedRandom), 1e-12), '随机联合：total = I((X₁,X₂);S)（独立按塌缩表直算对照）');

const battery = [
  ['XOR', pidXor],
  ['COPY', pidCopy],
  ['AND', pidAnd],
  ['独占', pidSrc],
  ['噪声XOR', pidNoisy],
  ['随机联合', pidRandom],
];
for (const [name, r] of battery) {
  ok(
    Math.abs(r.redundant + r.unique1 + r.unique2 + r.synergistic - r.total) <= 1e-9,
    `${name}：R+U₁+U₂+C = I（残差 ${(r.redundant + r.unique1 + r.unique2 + r.synergistic - r.total).toExponential(2)} ≤ 1e-9，分解守恒）`,
  );
  ok(
    near(r.redundant + r.unique1, r.iSource1, 1e-9) && near(r.redundant + r.unique2, r.iSource2, 1e-9),
    `${name}：R+U₁ = I(X₁;S)、R+U₂ = I(X₂;S)（BROJA 局部一致性——Williams–Beer 原版 I_min 不满足）`,
  );
}

// ═══════════════════ ⑥ 求解器收敛性 ═══════════════════

section('⑥ 求解器收敛性：目标单调、边缘可行、理论界');

for (const [name, r] of [['随机联合', pidRandom], ['AND', pidAnd], ['噪声XOR', pidNoisy]]) {
  const t = r.solverTrace;
  let mono = true;
  for (let i = 1; i < t.objectiveTrace.length; i += 1) {
    if (t.objectiveTrace[i] > t.objectiveTrace[i - 1] + 1e-10) mono = false;
  }
  ok(mono, `${name}：目标序列单调不增（${t.objectiveTrace.length} 个记录点，线搜索接受准则保证）`);
  ok(t.maxMarginalViolation <= 1e-9, `${name}：边缘约束违反 ${t.maxMarginalViolation.toExponential(2)} ≤ 1e-9`);
  ok(t.converged, `${name}：converged=${t.converged}（stopReason=${t.stopReason}，${t.iterations} 次迭代）`);
  ok(
    r.minimizedJointInfo >= Math.max(r.iSource1, r.iSource2) - 1e-9 && r.minimizedJointInfo <= r.total + 1e-9,
    `${name}：m=${r.minimizedJointInfo.toFixed(6)} ∈ [max(I₁,I₂), I]（Uᵢ≥0 与 q=p 可行给出的下/上界）`,
  );
  ok(Math.abs(t.objectiveEnd - t.objectiveTrace[t.objectiveTrace.length - 1]) <= 1e-9, `${name}：最终目标与轨迹末值一致（≤1e-9，可行方向步进无投影修复）`);
}
ok(
  pidAnd.solverTrace.objectiveStart - pidAnd.solverTrace.objectiveEnd > 0.2 && pidAnd.solverTrace.objectiveTrace.length >= 3,
  `AND 真实优化了：${pidAnd.solverTrace.objectiveStart.toFixed(6)} → ${pidAnd.solverTrace.objectiveEnd.toFixed(6)}（独立耦合起点 → 边界最优点，${pidAnd.solverTrace.objectiveTrace.length} 个记录点——精确线搜索两步到位）`,
);

// ═══════════════════ ⑦ O 信息 ═══════════════════

section('⑦ O 信息：冗余 / 协同主导的符号判据（Rosas 约定）');

const oXor = oInformation(gates.xor.joint);
ok(near(oXor.oInformation, -1, 1e-9) && oXor.dominance === 'synergy', `XOR Ω=${oXor.oInformation} < 0：协同主导（部分之和 0 − 整体 1）`);
const oCopy = oInformation(gates.copy.joint);
ok(near(oCopy.oInformation, 1, 1e-9) && oCopy.dominance === 'redundancy', `COPY Ω=${oCopy.oInformation} > 0：冗余主导（部分之和 2 − 整体 1）`);
const oSrc = oInformation(gates.sourceX.joint);
ok(Math.abs(oSrc.oInformation) <= 1e-9 && oSrc.dominance === 'balanced', `独占门 Ω=${oSrc.oInformation.toExponential(2)} ≈ 0（部分精确相加）`);
const oAnd = oInformation(gates.and.joint);
const expectedAndOmega = 2 * (0.8112781244591328 - 0.5) - 0.8112781244591328; // 2·I₁ − I，I₁ = H₂(1/4) − 1/2
ok(
  near(oAnd.oInformation, expectedAndOmega, 1e-9) && oAnd.dominance === 'synergy',
  `AND Ω=${oAnd.oInformation.toFixed(6)} = 2·I₁ − I = ${expectedAndOmega.toFixed(10)} < 0（协同主导但温和）`,
);

// 三源推广：奇偶门 Ω = 0 − 1 = −1；全拷贝门 Ω = 3 − 1 = +2
const parity3 = [];
for (let x1 = 0; x1 < 2; x1 += 1) {
  const l1 = [];
  for (let x2 = 0; x2 < 2; x2 += 1) {
    const l2 = [];
    for (let x3 = 0; x3 < 2; x3 += 1) {
      const cell = [0, 0];
      cell[x1 ^ x2 ^ x3] = 1 / 8;
      l2.push(cell);
    }
    l1.push(l2);
  }
  parity3.push(l1);
}
const oParity3 = oInformation(parity3);
ok(
  oParity3.sources === 3 && near(oParity3.oInformation, -1, 1e-9) && oParity3.dominance === 'synergy',
  `三源奇偶门：n=${oParity3.sources}，Ω=${oParity3.oInformation} < 0（n 源推广正确）`,
);
const copy3 = [];
for (let b = 0; b < 2; b += 1) {
  const l1 = [];
  for (let c = 0; c < 2; c += 1) {
    const l2 = [];
    for (let d = 0; d < 2; d += 1) {
      const cell = [0, 0];
      if (b === c && c === d) cell[b] = 0.5;
      l2.push(cell);
    }
    l1.push(l2);
  }
  copy3.push(l1);
}
const oCopy3 = oInformation(copy3);
ok(near(oCopy3.oInformation, 2, 1e-9) && oCopy3.dominance === 'redundancy', `三源全拷贝门：Ω=${oCopy3.oInformation} > 0（= 3·1 − 1）`);

// ═══════════════════ ⑩ 确定性 / 工厂新鲜度 / 入参校验 ═══════════════════

section('⑩ 确定性、工厂新鲜度与入参校验');

const r1 = pidFromJoint(randJoint);
const r2 = pidFromJoint(randJoint);
ok(JSON.stringify(r1) === JSON.stringify(r2), '同输入同输出（两次运行全报告含求解轨迹 JSON 逐位相同——内核无随机源）');

const fresh1 = bivariateGates();
fresh1.and.joint[0][0][0] = 999;
const fresh2 = bivariateGates();
ok(fresh2.and.joint[0][0][0] === 0.25, 'bivariateGates() 每次返回新建联合表（改动不串扰下一次调用）');

ok(throws(() => entropy([])), 'entropy 空数组 throw');
ok(throws(() => entropy([-0.1])), 'entropy 负概率 throw');
ok(throws(() => entropy([0, 0])), 'entropy 零和 throw');
ok(throws(() => entropy([0.5, NaN])), 'entropy NaN throw');
ok(throws(() => mutualInformation([])), 'mutualInformation 空表 throw');
ok(throws(() => mutualInformation([[0.5], [0.5, 0]])), 'mutualInformation 参差行 throw');
ok(throws(() => mutualInformation([[0.5, -0.1]])), 'mutualInformation 负概率 throw');
ok(throws(() => mutualInformation([[0, 0], [0, 0]])), 'mutualInformation 零和 throw');
ok(throws(() => pidFromJoint([])), 'pidFromJoint 空分布 throw');
ok(throws(() => pidFromJoint([[[]]])), 'pidFromJoint 目标维为空 throw');
ok(throws(() => pidFromJoint([[[0.5, 0]], [[0.5]]])), 'pidFromJoint 参差 throw');
ok(throws(() => pidFromJoint([[[0.5, -0.1], [0.3, 0.3]], [[0, 0], [0, 0]]])), 'pidFromJoint 负概率 throw');
ok(throws(() => pidFromJoint([[[0, 0], [0, 0]], [[0, 0], [0, 0]]])), 'pidFromJoint 零和 throw');
ok(throws(() => pidFromJoint([[[0.5, 0.5]], [[0.5, 0.5]]], { maxIterations: 0 })), 'pidFromJoint 非法 maxIterations throw');
ok(throws(() => oInformation([[0.5, 0.5]])), 'oInformation 源数不足（深度 < 3）throw');
ok(throws(() => oInformation([[[0.5, 0.5]], [[0.5]]])), 'oInformation 参差 throw');
ok(throws(() => oInformation([[[0.5, -0.1], [0.3, 0.6]], [[0.1, 0.2], [0.3, 0.4]]])), 'oInformation 负概率 throw');

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
