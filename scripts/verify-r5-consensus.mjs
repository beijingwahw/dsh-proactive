/**
 * verify-r5-consensus.mjs — R5-A14「共识验证六内核第五轮世界性进化」纯数学验证
 *
 * 六内核（46.0 法定人数 / 47.0 CRDT / 48.0 秘密共享 / 15.0 运行时验证 /
 * 20.0 层论共识 / 56.0 置信传播）的进化四轴验证——不是「能跑」，是
 * 「算得对 + 算得快 + 数值稳 + 性质成立」。直接 import 内核源文件
 * （node --experimental-transform-types，不经 dist）。
 *
 *   46.0 quorum-systems:
 *     ① R+W>n 读写一致性：分析器闭式（overlap = R+W−n、容错、负载）
 *        + 120 组种子化随机读写序列——R+W>n 时零陈旧读、R+W≤n 时
 *        陈旧读真实出现（下界两侧都实证）
 *     ② 栅格法定人数（Cheung 构造）：k² 个 quorum 位掩码穷举两两交
 *        ≥ 2（k=3..6）、负载闭式 (2k−1)/k² vs 逐节点计数、
 *        负载 < 多数派负载（√n 倍改进）
 *   47.0 crdt:
 *     ③ 2P-Set（remove-win）：remove 后 add 不复活（与 OR-Set add-win
 *        对偶）+ 240 组随机操作流任意置换 → 两副本逐位收敛 + 三律
 *        （交换/结合/幂等）显式检查
 *     ④ delta-CRDT：增量传播 ≡ 全量传播（终态逐位相等，等价证明）
 *        + 通信量对照（增量条目 ≪ 全量条目）+ 耗时对照
 *     ⑤ 收敛性质加强：260 组种子化置换重跑 47.0 经典审计恒 0 偏差
 *   48.0 secret-sharing:
 *     ⑥ Feldman VSS：安全素数确定性 Miller–Rabin 判别（p/q 皆素、
 *        合数全拒）+ 诚实份额 100% 通过承诺验证 + 篡改份额 100% 被拒
 *        （240 份种子化份额）+ t 份重建恢复秘密
 *     ⑦ Lagrange 任意点插值：240 组种子化随机多项式，内核插值 vs
 *        脚本侧独立 Horner 直算（与内核零共享代码）逐位一致
 *   15.0 runtime-verification:
 *     ⑧ LTLf 过去算子 Y/S：手工语义锚点（Y 首位假、S 的「自 ψ 后
 *        一直 φ」）+ 未来/过去混合公式；未来算子入 DFA 显式拒绝
 *     ⑨ past-DFA：穷举全部 ≤5 长度迹（4 事件类型，1364 条）+
 *        240 条种子化随机长迹——DFA ≡ ltlfEvaluate(len−1) 逐位一致；
 *        Moore 最小化真实合并状态（raw > min 案例）
 *     ⑩ 耗时对照：单次末位求值（表驱动 vs AST）+ 在线监视（每前缀
 *        裁决：O(n) vs O(n²)）——数量级差
 *   20.0 sheaf-consensus:
 *     ⑪ H⁰ 维数：连通标量等值层 = 1、莫比乌斯扭曲层 = 0（结构自带
 *        矛盾的计算机读数）、重叠层 = 3；对照脚本侧独立行列式/秩计算
 *     ⑫ 全局截面存在性：相容锚点 → 截面精确复现观测（边约束残差
 *        ~1e-16）；矛盾锚点 → exists=false；无锚莫比乌斯 → 无非零截面
 *     ⑬ 带权限制映射（软限制）：噪声源降权 0.1 → 真值顶点共识从
 *        0.559 拉回 0.505（鲁棒化）；权重 1 与升级前逐位一致
 *   56.0 belief-propagation:
 *     ⑭ Bethe 自由能：200 棵种子随机树 F_Bethe = −ln Z（≤1e-6，树上
 *        精确）；含圈 Ising 环 ln Z_Bethe 与精确值的偏差报告（校准读数）
 *     ⑮ max-sum 对数域解码：80 棵种子树与 max-product 同指派同
 *        logJoint（≤1e-9）+ e^±600 极端势表链上 = 穷举 MAP + 耗时对照
 *     ⑯ GDL 前缀积：320 组种子化（度 1..8 × 域 2..4）与逐目标连乘
 *        相对差 ≤ 1e-15 + 度 300 耗时对照（≥3×）
 *     ⑰ 树上 BP = 精确边缘加强：220 棵种子树 vs 独立暴力枚举 ≤ 1e-9
 *
 * 全部断言确定性（mulberry32 种子固定，同输入同输出）。
 * 运行：node --experimental-transform-types scripts/verify-r5-consensus.mjs
 */

import {
  majorityQuorumAudit,
  readWriteQuorumAudit,
  gridQuorumAudit,
  rwConsistencyTrial,
} from '../src/core/quorum-systems.ts';
import {
  GCounter,
  ORSet,
  TwoPhaseSet,
  crdtConvergenceAudit,
} from '../src/core/crdt.ts';
import {
  shamirSplit,
  shamirCombine,
  verifiableShamirSplit,
  verifyFeldmanShare,
  modLagrangeEvaluate,
  isPrimeBig,
  modPowBig,
  FELDMAN_P,
  FELDMAN_Q,
  FELDMAN_G,
} from '../src/core/secret-sharing.ts';
import {
  ltlfEvaluate,
  compilePastDFA,
  runPastDFA,
  masksFromEvents,
} from '../src/core/runtime-verification.ts';
import {
  CellularSheaf,
  scalarAgreementSheaf,
} from '../src/core/sheaf-consensus.ts';
import {
  FactorGraph,
  gdlVarToFactorMessages,
} from '../src/core/belief-propagation.ts';
import { performance } from 'node:perf_hooks';

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

/** 确定性 RNG（mulberry32） */
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

/** 位计数 */
function popcount(x) {
  let c = 0;
  while (x) {
    x &= x - 1;
    c += 1;
  }
  return c;
}

// ═══════════════════ ① 46.0 R+W>n 读写一致性 ═══════════════════

section('46.0 ① R/W 法定人数：R+W>n 读写一致性定理');

{
  const a = readWriteQuorumAudit(5, 3, 3);
  ok(a.consistent && a.overlap === 1, 'R=3, W=3, n=5：R+W=6>5 一致成立，overlap = R+W−n = 1');
  ok(a.readAvailability === 2 && a.writeAvailability === 2 && Math.abs(a.readLoad - 0.6) < 1e-12,
    '读/写可用容错 n−R = 2 / n−W = 2，读负载 R/n = 0.6');
  const b = readWriteQuorumAudit(5, 2, 2);
  ok(!b.consistent && b.verdict.includes('≤'), 'R=2, W=2, n=5：R+W=4≤5 允许陈旧读（口径诚实标注）');
  // Dynamo 两极端
  const w1 = readWriteQuorumAudit(7, 7, 1);
  const maj = readWriteQuorumAudit(7, 4, 4);
  ok(w1.consistent && maj.consistent, 'R=n/W=1（写一次读全部）与 R=W=⌊n/2⌋+1（多数派）同为一致极端');
  ok(throws(() => readWriteQuorumAudit(5, 0, 3)) && throws(() => readWriteQuorumAudit(5, 3, 6)),
    '非法 R/W（0 或 > n）显式拒绝');
  ok(readWriteQuorumAudit(7, 4, 4).overlap === majorityQuorumAudit(7).minIntersection,
    'R=W=q 口径退化为多数派：overlap = 最小交集闭式 2q−n（与 46.0 原审计桥接）');

  // 性质测试：120 组种子化随机读写序列
  const rng = mulberry32(20261001);
  let staleWhenConsistent = 0;
  let consistentTrials = 0;
  let staleWhenWeak = 0;
  let weakTrials = 0;
  for (let t = 0; t < 120; t += 1) {
    const n = 3 + Math.floor(rng() * 6);
    const r = 1 + Math.floor(rng() * n);
    const w = 1 + Math.floor(rng() * n);
    const audit = readWriteQuorumAudit(n, r, w);
    const trial = rwConsistencyTrial(n, r, w, rng);
    if (audit.consistent) {
      consistentTrials += 1;
      if (trial.staleRead) staleWhenConsistent += 1;
    } else {
      weakTrials += 1;
      if (trial.staleRead) staleWhenWeak += 1;
    }
  }
  ok(consistentTrials > 20 && staleWhenConsistent === 0,
    `120 组随机读写序列：R+W>n 的 ${consistentTrials} 次试验零陈旧读（交集定理实证）`);
  ok(weakTrials > 20 && staleWhenWeak > 0,
    `R+W≤n 的 ${weakTrials} 次试验中陈旧读出现 ${staleWhenWeak} 次（下界另一侧同样真实——不存在巧合安全）`);
}

// ═══════════════════ ② 46.0 栅格法定人数 ═══════════════════

section('46.0 ② 栅格法定人数（grid quorum，Cheung 构造）');

{
  let pairwiseOk = true;
  let countOk = true;
  for (const k of [3, 4, 5, 6]) {
    const rep = gridQuorumAudit(k * k);
    if (rep.quorums.length !== k * k) countOk = false;
    // 穷举两两交集 ≥ 2（k² 个 quorum 的全部对）
    for (let i = 0; i < rep.quorums.length; i += 1) {
      for (let j = i + 1; j < rep.quorums.length; j += 1) {
        if (popcount(rep.quorums[i] & rep.quorums[j]) < 2) pairwiseOk = false;
      }
    }
  }
  ok(pairwiseOk && countOk, 'k=3..6 全部 k² 个 quorum（行∪列）两两交集 ≥ 2（穷举证明的构造性质）');
  const g16 = gridQuorumAudit(16);
  ok(g16.quorumSize === 7 && g16.minIntersection === 2, 'n=16：quorum = 2k−1 = 7 节点，不同行列对交于恰 2 节点');
  // 负载闭式 vs 逐节点计数
  const k = 5;
  const rep = gridQuorumAudit(k * k);
  const membership = new Array(k * k).fill(0);
  for (const q of rep.quorums) {
    for (let node = 0; node < k * k; node += 1) {
      if (q & (1 << node)) membership[node] += 1;
    }
  }
  const maxMembership = Math.max(...membership);
  ok(maxMembership === 2 * k - 1 && Math.abs(rep.load - (2 * k - 1) / (k * k)) < 1e-15,
    `负载闭式 (2k−1)/k²：k=5 时每节点恰在 ${maxMembership}/25 个 quorum（均匀策略负载 ${(rep.load * 100).toFixed(1)}%）`);
  const majorityLoad = (Math.floor(k * k / 2) + 1) / (k * k);
  ok(rep.load < majorityLoad * 0.75,
    `负载对比 k=5：栅格 ${(rep.load * 100).toFixed(1)}% vs 多数派 ${(majorityLoad * 100).toFixed(1)}%（比值 ${rep.loadVsMajority.toFixed(3)}）`);
  const big = gridQuorumAudit(100);
  const bigMajority = (Math.floor(100 / 2) + 1) / 100;
  ok(big.load < bigMajority / 2,
    `n=100（k=10）：栅格负载 ${(big.load * 100).toFixed(1)}% < 多数派 ${(bigMajority * 100).toFixed(1)}% 的一半（比值 ${big.loadVsMajority.toFixed(3)}——2/√n vs 1/2 的渐近读放大优势）`);
  ok(throws(() => gridQuorumAudit(10)), '非完全平方数 n 显式拒绝');
}

// ═══════════════════ ③ 47.0 2P-Set（remove-win） ═══════════════════

section('47.0 ③ 2P-Set：remove-win 语义 + 置换收敛 + 三律');

{
  // remove-win 对偶语义
  const s = new TwoPhaseSet();
  s.add('x');
  s.remove('x');
  s.add('x');
  ok(!s.has('x') && s.elements().length === 0, 'remove-win：tombstone 一旦落下，迟到的 add 不复活（与 OR-Set add-win 对偶）');
  const or = new ORSet();
  or.add('x', 't1');
  or.remove('x');
  or.add('x', 't2');
  ok(or.has('x'), 'OR-Set 对照：并发 add 胜 remove（两种语义选择并存，口径清晰）');

  // 240 组随机操作流任意置换 → 收敛
  const rng = mulberry32(20261002);
  let worstDiff = 0;
  for (let t = 0; t < 240; t += 1) {
    const ops = [];
    const nOps = 8 + Math.floor(rng() * 12);
    for (let i = 0; i < nOps; i += 1) {
      const r = rng();
      if (r < 0.55) ops.push({ node: rng() < 0.5 ? 'a' : 'b', kind: 'add', e: `e${Math.floor(rng() * 4)}` });
      else ops.push({ node: rng() < 0.5 ? 'a' : 'b', kind: 'remove', e: `e${Math.floor(rng() * 4)}` });
    }
    const apply = (perm) => {
      const A = new TwoPhaseSet();
      const B = new TwoPhaseSet();
      for (const idx of perm) {
        const op = ops[idx];
        (op.node === 'a' ? A : B)[op.kind](op.e);
      }
      A.merge(B);
      B.merge(A);
      return [A, B];
    };
    const perm = ops.map((_, i) => i);
    for (let i = perm.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const [A1, B1] = apply(perm);
    const diff = new Set([...A1.elements(), ...B1.elements()]).size -
      A1.elements().filter((e) => B1.elements().includes(e)).length;
    worstDiff = Math.max(worstDiff, Math.abs(A1.elements().length - B1.elements().length) + 2 * Math.max(0, diff));
  }
  ok(worstDiff === 0, `240 组随机操作流 × 任意置换 + 双向合并：2P-Set 状态逐位收敛（最大对称差 ${worstDiff}）`);

  // 三律显式检查：交换 / 结合 / 幂等
  const X = new TwoPhaseSet();
  X.add('a'); X.add('b'); X.remove('c');
  const Y = new TwoPhaseSet();
  Y.add('c'); Y.remove('a');
  const Z = new TwoPhaseSet();
  Z.add('d');
  const XY = X.clone(); XY.merge(Y);
  const YX = Y.clone(); YX.merge(X);
  ok(JSON.stringify([...XY.elements()].sort()) === JSON.stringify([...YX.elements()].sort()), '交换律：X∪Y = Y∪X（2P-Set 合并 = 双集并集）');
  const L = X.clone(); L.merge(Y); L.merge(Z);
  const R = Y.clone(); R.merge(Z);
  const R2 = X.clone(); R2.merge(R);
  ok(JSON.stringify([...L.elements()].sort()) === JSON.stringify([...R2.elements()].sort()), '结合律：(X∪Y)∪Z = X∪(Y∪Z)');
  const idem = X.clone();
  const before = JSON.stringify(idem.state());
  idem.merge(X);
  ok(JSON.stringify(idem.state()) === before, '幂等律：X∪X = X（重复合并零漂移）');
}

// ═══════════════════ ④ 47.0 delta-CRDT ═══════════════════

section('47.0 ④ delta-CRDT：增量传播 ≡ 全量传播（等价证明 + 对照）');

{
  const rng = mulberry32(20261003);
  // 等价证明：三副本场景，A 用 delta 传播、B 用全量传播 → 终态逐位相等
  let equivalents = 0;
  const trials = 200;
  let deltaEntries = 0;
  let fullEntries = 0;
  for (let t = 0; t < trials; t += 1) {
    const nodes = ['n1', 'n2', 'n3'];
    const deltaReplica = new GCounter(); // 收端（走 delta）
    const fullReplica = new GCounter(); // 收端（走全量）
    const source = new GCounter(); // 发端
    const steps = 4 + Math.floor(rng() * 8);
    for (let sIdx = 0; sIdx < steps; sIdx += 1) {
      const node = nodes[Math.floor(rng() * nodes.length)];
      const by = 1 + Math.floor(rng() * 5);
      source.increment(node, by);
      // 增量传播：只发自上次收割的增量
      const delta = source.drainDelta();
      deltaReplica.mergeDelta(delta);
      deltaEntries += Object.keys(delta).length;
      // 全量传播：发整个状态
      fullReplica.merge(source);
      fullEntries += Object.keys(source.state()).length;
    }
    const d = deltaReplica.state();
    const f = fullReplica.state();
    let same = Object.keys(d).length === Object.keys(f).length;
    for (const key of Object.keys(d)) {
      if (d[key] !== f[key]) same = false;
    }
    if (same && deltaReplica.value() === fullReplica.value()) equivalents += 1;
  }
  ok(equivalents === trials, `${trials} 组种子化增量流：delta 传播与全量传播终态逐位相等（合并闭包 = join-semilattice 的等价证明）`);
  ok(deltaEntries < fullEntries / 2,
    `通信量对照：增量共 ${deltaEntries} 条目 vs 全量共 ${fullEntries} 条目（${(100 * deltaEntries / fullEntries).toFixed(0)}%——只发活跃分量）`);

  // 耗时对照：60 节点 × 600 次增量，两种传播制度的合并耗时
  const buildState = (nodes, per) => {
    const c = new GCounter();
    for (let i = 0; i < per; i += 1) {
      c.increment(nodes[i % nodes.length], 1 + (i % 3));
    }
    return c;
  };
  const nodes = Array.from({ length: 60 }, (_, i) => `node-${i}`);
  const src = buildState(nodes, 600);
  // 全量制度：每步 merge 全量（重放 600 次增量、每次全量合并）
  let t0 = performance.now();
  const fullSink = new GCounter();
  for (let r = 0; r < 600; r += 1) fullSink.merge(src);
  const fullMs = performance.now() - t0;
  // 增量制度：单节点推进 → 只合并 1 条目增量
  t0 = performance.now();
  const deltaSink = new GCounter();
  const single = new GCounter();
  for (let r = 0; r < 600; r += 1) {
    single.increment('node-0', 1);
    deltaSink.mergeDelta(single.drainDelta());
  }
  const deltaMs = performance.now() - t0;
  const ratio = fullMs / Math.max(1e-9, deltaMs);
  ok(ratio > 1, `耗时对照：全量合并 ${fullMs.toFixed(1)}ms vs 增量合并 ${deltaMs.toFixed(1)}ms（×${ratio.toFixed(0)}——条目数 O(60) → O(1)）`);
}

// ═══════════════════ ⑤ 47.0 收敛性质加强 ═══════════════════

section('47.0 ⑤ 收敛性质加强：260 组种子化置换（G-Counter + OR-Set）');

{
  const rng = mulberry32(20261004);
  let worstCounter = 0;
  let worstSet = 0;
  for (let t = 0; t < 260; t += 1) {
    const ops = [];
    for (let i = 0; i < 24; i += 1) {
      const r = rng();
      if (r < 0.5) ops.push({ node: r < 0.25 ? 'a' : 'b', kind: 'inc', by: 1 + Math.floor(rng() * 3) });
      else if (r < 0.8) ops.push({ node: r < 0.65 ? 'a' : 'b', kind: 'add', element: `e${Math.floor(rng() * 6)}` });
      else ops.push({ node: r < 0.9 ? 'a' : 'b', kind: 'remove', element: `e${Math.floor(rng() * 6)}` });
    }
    const perm = ops.map((_, i) => i);
    for (let i = perm.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    const audit = crdtConvergenceAudit(ops, perm);
    worstCounter = Math.max(worstCounter, audit.counterDelta);
    worstSet = Math.max(worstSet, audit.setSymmetricDiff);
  }
  ok(worstCounter === 0 && worstSet === 0,
    `260 组种子化随机操作流 × 任意置换：G-Counter 最大偏差 ${worstCounter}、OR-Set 最大对称差 ${worstSet}（强最终一致性的有限样本加强验证）`);
}

// ═══════════════════ ⑥ 48.0 Feldman VSS ═══════════════════

section('48.0 ⑥ Feldman 可验证秘密共享：承诺验证 + 篡改拒绝');

{
  // 确定性 Miller–Rabin：素性判别（证明口径，非概率）
  ok(isPrimeBig(FELDMAN_P) && isPrimeBig(FELDMAN_Q) && 2n * FELDMAN_Q + 1n === FELDMAN_P,
    'Feldman 域参数：p = 2q+1 为安全素数（确定性 MR 判别，两素数皆真）');
  const carmichael = [561n, 1105n, 1729n, 2465n, 2821n, 6601n];
  ok(carmichael.every((c) => !isPrimeBig(c)), `Carmichael 数全部判为合数（${carmichael.length} 个经典伪素陷阱零失手）`);
  ok(isPrimeBig(2n ** 61n - 1n) && isPrimeBig(97n) && !isPrimeBig(1n) && !isPrimeBig(2n ** 61n + 1n) && isPrimeBig(2n),
    '杂例判别：梅森素数 2^61−1 真、97 真、1 假、2^61+1 假、2 真');
  // g = 4 生成 QR 子群：阶恰为 q（g^q = 1 且 g ≠ 1）
  ok(modPowBig(FELDMAN_G, FELDMAN_Q, FELDMAN_P) === 1n && modPowBig(FELDMAN_G, 2n, FELDMAN_P) !== 1n,
    'g = 4 的阶恰为素数 q（素数阶子群——离散对数安全归约的前提）');

  // 拆分 → 验证 → 篡改 → 重建（240 份种子化）
  const rng = mulberry32(20261005);
  let honestShares = 0;
  let honestTotal = 0;
  let tamperRejected = 0;
  let tamperTrials = 0;
  let reconOk = 0;
  const splits = 24;
  for (let t = 0; t < splits; t += 1) {
    const secretValue = BigInt(1 + Math.floor(rng() * 1e15)) * 1000003n + BigInt(Math.floor(rng() * 1000));
    const n = 4 + Math.floor(rng() * 3);
    const thr = 2 + Math.floor(rng() * (n - 1));
    const vs = verifiableShamirSplit(secretValue % FELDMAN_Q, n, thr);
    let allVerify = true;
    for (const share of vs.shares) {
      honestTotal += 1;
      if (!verifyFeldmanShare(share.x, share.y, vs.commitments)) allVerify = false;
    }
    if (allVerify) honestShares += vs.shares.length;
    // 篡改：每份份额 +1 应被承诺验证拒绝
    for (const share of vs.shares) {
      tamperTrials += 1;
      if (!verifyFeldmanShare(share.x, (share.y + 1n) % FELDMAN_Q, vs.commitments)) tamperRejected += 1;
    }
    // 任意 thr 份重建 = 秘密（模 q Lagrange）
    const subset = vs.shares.slice(0, thr);
    const rec = modLagrangeEvaluate(subset, 0n, FELDMAN_Q);
    if (rec === secretValue % FELDMAN_Q) reconOk += 1;
  }
  ok(honestShares === honestTotal,
    `${splits} 次拆分 × 全部份额（${honestTotal} 份）：诚实时 g^{f(x)} = Π C_j^{x^j} 验证 100% 通过`);
  ok(tamperRejected === tamperTrials,
    `份额篡改（y+1）${tamperTrials}/${tamperTrials} 全部被承诺验证当场拒绝——分发者无法对持有者撒谎`);
  ok(reconOk === splits, `${splits} 次拆分的任意阈值子集 Lagrange 重建精确恢复秘密（${reconOk}/${splits}）`);
  ok(throws(() => verifiableShamirSplit(FELDMAN_Q, 5, 3)) && verifyFeldmanShare(0, 1n, [4n, 4n]) === false,
    '非法入参：秘密 ≥ q 显式 throw；x = 0 的伪份额验证返回 false');
}

// ═══════════════════ ⑦ 48.0 Lagrange 任意点插值 ═══════════════════

section('48.0 ⑦ Lagrange 任意点插值：内核插值 vs 独立 Horner 直算');

{
  const P = FELDMAN_Q;
  const rng = mulberry32(20261006);
  // 脚本侧独立大整数 Horner 求值（与内核零共享代码）
  const horner = (coeffs, x) => {
    let acc = 0n;
    for (let k = coeffs.length - 1; k >= 0; k -= 1) acc = (acc * x + coeffs[k]) % P;
    return acc;
  };
  const randBig = (r) => {
    let v = 0n;
    for (let w = 0; w < 8; w += 1) v = (v << 8n) | BigInt(Math.floor(r() * 256));
    return v % P;
  };
  let agree = 0;
  const trials = 240;
  for (let t = 0; t < trials; t += 1) {
    const deg = 1 + Math.floor(rng() * 4);
    const coeffs = Array.from({ length: deg + 1 }, () => randBig(rng));
    const nPts = deg + 1 + Math.floor(rng() * 2);
    const xs = [];
    while (xs.length < nPts) {
      const x = 1n + BigInt(1 + Math.floor(rng() * 200));
      if (!xs.includes(x)) xs.push(x);
    }
    const pts = xs.map((x) => ({ x, y: horner(coeffs, x) }));
    const xq = randBig(rng) % 500n;
    const interp = modLagrangeEvaluate(pts, xq, P);
    if (interp === horner(coeffs, xq)) agree += 1;
  }
  ok(agree === trials, `${trials} 组种子化随机多项式（1..5 次）：插值 f(xq) = Horner 直算逐位一致（${agree}/${trials}，素域 GF(q)）`);
  // 与既有 shamirSplit/shamirCombine 桥接：单块秘密仍精确重建
  const secret = 'r5-consensus-key-2049';
  let roundTrip = true;
  for (let t = 0; t < 20; t += 1) {
    const shares = shamirSplit(secret, 6, 3);
    const pick = [0, 2, 4].map((i) => shares[(i + t) % 6]);
    if (shamirCombine(pick) !== secret) roundTrip = false;
  }
  ok(roundTrip, '20 次随机 3/6 份额子集 shamirSplit→shamirCombine 精确往返（升级零回归）');
}

// ═══════════════════ ⑧ 15.0 LTLf 过去算子 ═══════════════════

section('15.0 ⑧ LTLf 全时序逻辑：Y/S 过去算子语义锚点');

{
  const A = (p) => ({ kind: 'atom', prop: p });
  const Y = (a) => ({ kind: 'yesterday', arg: a });
  const S = (l, r) => ({ kind: 'since', left: l, right: r });
  const G = (a) => ({ kind: 'globally', arg: a });
  const F = (a) => ({ kind: 'eventually', arg: a });
  const U = (l, r) => ({ kind: 'until', left: l, right: r });
  const X = (a) => ({ kind: 'next', arg: a });
  const NOT = (a) => ({ kind: 'not', arg: a });
  const AND = (...a) => ({ kind: 'and', args: a });
  const OR = (...a) => ({ kind: 'or', args: a });

  ok(ltlfEvaluate(Y(A('a')), ['a']) === false && ltlfEvaluate(Y(A('a')), ['a', 'b'], 1) === true,
    'Y 语义：首位无昨天（false）；[a,b] 位 1 的 Y(a) = a@0 = true');
  ok(ltlfEvaluate(Y(A('a')), ['x', 'a', 'y'], 2) === true && ltlfEvaluate(Y(A('a')), ['a', 'x', 'y'], 2) === false,
    '监视口径惯用形（at=len−1）：[x,a,y] 的 Y(a)=true（上一拍是 a）、[a,x,y] 的 Y(a)=false');
  ok(ltlfEvaluate(S(A('b'), A('a')), ['a', 'b', 'b']) === true,
    'S 语义：a S b on [a,b,b] —— a 成立后 b 一直成立（自从 a 起连续）');
  ok(ltlfEvaluate(S(A('b'), A('a')), ['a', 'c', 'b'], 2) === false,
    'S 断裂：[a,c,b] 末位处 c 打断连续性（a 之后 b 未一直成立）');
  ok(ltlfEvaluate(S(A('b'), A('a')), ['c', 'b', 'b']) === false,
    'S 无起点：从无 a 发生则 since 为假');
  ok(ltlfEvaluate(G(OR(NOT(A('req')), X(A('ack')))), ['req', 'ack', 'idle']) === true &&
     ltlfEvaluate(G(OR(NOT(A('req')), X(A('ack')))), ['req', 'idle', 'ack']) === false,
    '未来算子回归：G(req → X ack) 的满足/违反两例（响应性质）');
  ok(ltlfEvaluate(AND(G(OR(NOT(Y(A('fail'))), A('healthy'))), F(A('done'))), ['fail', 'healthy', 'done']) === true,
    '过去/未来混合：G(Y(fail) → healthy) ∧ F(done)——「上次失败以来一直健康且终会完成」');

  // DFA 边界：未来算子显式拒绝
  ok(throws(() => compilePastDFA(G(A('a')))) && throws(() => compilePastDFA(F(A('a')))) &&
     throws(() => compilePastDFA(U(A('a'), A('b')))) && throws(() => compilePastDFA(X(A('a')))),
    '过去片段 DFA 编译对 X/F/G/U 显式 throw（诚实边界，全时序走 ltlfEvaluate）');
  ok(throws(() => ltlfEvaluate(A('a'), ['x'], -1)) && ltlfEvaluate(A('a'), ['x'], 5) === false,
    'at 越界防御：负数 throw、超长返回 false');
}

// ═══════════════════ ⑨ 15.0 past-DFA ≡ AST ═══════════════════

section('15.0 ⑨ past-DFA：穷举 + 240 条随机迹 vs AST 逐位一致');

{
  const A = (p) => ({ kind: 'atom', prop: p });
  const Y = (a) => ({ kind: 'yesterday', arg: a });
  const S = (l, r) => ({ kind: 'since', left: l, right: r });
  const NOT = (a) => ({ kind: 'not', arg: a });
  const AND = (...a) => ({ kind: 'and', args: a });
  const OR = (...a) => ({ kind: 'or', args: a });

  const formulas = [
    { name: 'Y(a)', f: Y(A('a')) },
    { name: 'a S b', f: S(A('a'), A('b')) },
    { name: 'Y(a) ∧ (a S b)', f: AND(Y(A('a')), S(A('a'), A('b'))) },
    { name: 'YY(a) ∨ (¬b S a)', f: OR(Y(Y(A('a'))), S(NOT(A('b')), A('a'))) },
    { name: '监视哨兵 ¬(true S b) = b 从未发生', f: NOT(S(OR(A('a'), NOT(A('a'))), A('b'))) },
  ];
  // 穷举：4 事件类型 × 全部长度 ≤ 5 的迹
  const letters = ['a', 'b', 'c', 'd'];
  let exhaustiveTotal = 0;
  let exhaustiveMis = 0;
  let minRaw = 0;
  let minMin = 0;
  for (const { f } of formulas) {
    const dfa = compilePastDFA(f);
    minRaw += dfa.rawStates;
    minMin += dfa.states;
    for (let len = 1; len <= 5; len += 1) {
      const count = 4 ** len;
      for (let code = 0; code < count; code += 1) {
        let c = code;
        const trace = [];
        for (let k = 0; k < len; k += 1) {
          trace.push(letters[c % 4]);
          c = Math.floor(c / 4);
        }
        exhaustiveTotal += 1;
        if (ltlfEvaluate(f, trace, trace.length - 1) !== runPastDFA(dfa, masksFromEvents(dfa, trace))) exhaustiveMis += 1;
      }
    }
    // 空迹一致性（初始状态 = 空历史赋值）
    if (ltlfEvaluate(f, []) !== runPastDFA(dfa, [])) exhaustiveMis += 1;
  }
  ok(exhaustiveMis === 0 && exhaustiveTotal >= 1364,
    `穷举全部 ≤5 长度迹（${exhaustiveTotal} 条 × 5 公式）：DFA ≡ ltlfEvaluate(len−1) 零失手`);
  const sentinel = compilePastDFA(formulas[4].f);
  ok(sentinel.rawStates > sentinel.states,
    `Moore 最小化真实合并：监视哨兵公式 raw ${sentinel.rawStates} → min ${sentinel.states}（+ 其余公式合计 raw ${minRaw} → min ${minMin}）`);

  // 随机长迹 240 条
  const rng = mulberry32(20261007);
  let randomMis = 0;
  for (let t = 0; t < 240; t += 1) {
    const fi = Math.floor(rng() * formulas.length);
    const dfa = compilePastDFA(formulas[fi].f);
    const len = 1 + Math.floor(rng() * 40);
    const trace = Array.from({ length: len }, () => letters[Math.floor(rng() * 4)]);
    if (ltlfEvaluate(formulas[fi].f, trace, trace.length - 1) !== runPastDFA(dfa, masksFromEvents(dfa, trace))) {
      randomMis += 1;
    }
  }
  ok(randomMis === 0, `240 条种子化随机长迹（≤40 事件）：DFA 与 AST 裁决逐位一致`);
}

// ═══════════════════ ⑩ 15.0 耗时对照 ═══════════════════

section('15.0 ⑩ 耗时对照：表驱动 DFA vs AST 递归（编译一次、O(1)/步）');

{
  const A = (p) => ({ kind: 'atom', prop: p });
  const S = (l, r) => ({ kind: 'since', left: l, right: r });
  const NOT = (a) => ({ kind: 'not', arg: a });
  const OR = (...a) => ({ kind: 'or', args: a });
  // 「b 从未发生」——末位真值依赖整条历史（无早退捷径的诚实负载）
  const neverB = NOT(S(OR(A('a'), NOT(A('a'))), A('b')));
  const dfa = compilePastDFA(neverB);
  const letters = ['a', 'c', 'd', 'a'];
  const N = 100_000;
  const longTrace = Array.from({ length: N }, (_, i) => letters[i % 4]);
  const masks = masksFromEvents(dfa, longTrace);

  let t0 = performance.now();
  const astVerdict = ltlfEvaluate(neverB, longTrace, N - 1);
  const astMs = performance.now() - t0;
  t0 = performance.now();
  const dfaVerdict = runPastDFA(dfa, masks);
  const dfaMs = performance.now() - t0;
  ok(astVerdict === dfaVerdict && dfaMs < astMs,
    `单次末位求值：AST ${astMs.toFixed(1)}ms vs DFA ${dfaMs.toFixed(1)}ms（×${(astMs / Math.max(1e-9, dfaMs)).toFixed(0)} 加速，10 万事件）`);

  // 在线监视工作负载：每个前缀都要裁决（SafetyMonitor 的真实口径）
  const n2 = 4000;
  const trace2 = longTrace.slice(0, n2);
  t0 = performance.now();
  const astAll = [];
  for (let k = 1; k <= n2; k += 1) astAll.push(ltlfEvaluate(neverB, trace2.slice(0, k), k - 1));
  const astAllMs = performance.now() - t0;
  t0 = performance.now();
  const dfaAll = [];
  let s = dfa.start;
  for (let k = 0; k < n2; k += 1) {
    s = dfa.trans[s][masks[k]];
    dfaAll.push(dfa.accepting.has(s));
  }
  const dfaAllMs = performance.now() - t0;
  const agree = astAll.every((v, i) => v === dfaAll[i]);
  ok(agree && dfaAllMs * 50 < astAllMs,
    `在线监视（${n2} 前缀裁决）：AST 重求值 ${astAllMs.toFixed(0)}ms vs DFA 单扫 ${dfaAllMs.toFixed(2)}ms（×${(astAllMs / Math.max(1e-9, dfaAllMs)).toFixed(0)}，O(n²)→O(n)，全前缀裁决一致）`);
}

// ═══════════════════ ⑪ 20.0 H⁰ 维数 ═══════════════════

section('20.0 ⑪ H⁰ = dim ker δ_F：全局截面空间的维数读数');

{
  // 脚本侧独立秩计算（与内核零共享：实对称高斯消元 + 相对阈值）
  const independentNullity = (M) => {
    const n = M.length;
    const G = M.map((r) => [...r]);
    let maxAbs = 0;
    for (const row of G) for (const v of row) maxAbs = Math.max(maxAbs, Math.abs(v));
    const tol = 1e-10 * Math.max(1, maxAbs);
    let rank = 0;
    let row = 0;
    for (let col = 0; col < n && row < n; col += 1) {
      let piv = row;
      for (let r = row + 1; r < n; r += 1) if (Math.abs(G[r][col]) > Math.abs(G[piv][col])) piv = r;
      if (Math.abs(G[piv][col]) <= tol) continue;
      [G[row], G[piv]] = [G[piv], G[row]];
      for (let r = row + 1; r < n; r += 1) {
        const fac = G[r][col] / G[row][col];
        if (fac === 0) continue;
        for (let c = col; c < n; c += 1) G[r][c] -= fac * G[row][c];
      }
      row += 1;
      rank += 1;
    }
    return n - rank;
  };

  const path5 = scalarAgreementSheaf(['v0', 'v1', 'v2', 'v3', 'v4']);
  ok(path5.sectionSpaceDimension() === 1, '连通标量等值层（5 顶点路径）：H⁰ = 1（常数指派——平均共识解空间的维数）');
  const moebius = new CellularSheaf();
  moebius.addVertex('A', 1).addVertex('B', 1).addVertex('C', 1);
  moebius.addEdge({ a: 'A', b: 'B' });
  moebius.addEdge({ a: 'B', b: 'C' });
  moebius.addEdge({ a: 'C', b: 'A', mapA: [[1]], mapB: [[-1]] });
  ok(moebius.sectionSpaceDimension() === 0,
    '莫比乌斯扭曲层（环上绕行一次乘 −1）：H⁰ = 0——无需任何观测，结构自带矛盾（第一次可计算地「看见」）');
  const untwisted = new CellularSheaf();
  untwisted.addVertex('A', 1).addVertex('B', 1).addVertex('C', 1);
  untwisted.addEdge({ a: 'A', b: 'B' }).addEdge({ a: 'B', b: 'C' }).addEdge({ a: 'C', b: 'A' });
  ok(untwisted.sectionSpaceDimension() === 1, '同环无扭曲对照：H⁰ = 1（扭曲是 H⁰ 的全部差异）');
  const ov = new CellularSheaf();
  ov.addVertex('X', 2).addVertex('Y', 2);
  ov.addEdge({ a: 'X', b: 'Y', sharedA: [0], sharedB: [1] });
  ok(ov.sectionSpaceDimension() === 3, '重叠层（4 维信念、1 条共享约束）：H⁰ = 3 = 4 − rank(δ)（自由度精确计数）');
  // 与独立实现对照
  const rng = mulberry32(20261008);
  let agree = 0;
  const trials = 120;
  for (let t = 0; t < trials; t += 1) {
    const sh = new CellularSheaf();
    const nv = 2 + Math.floor(rng() * 4);
    for (let i = 0; i < nv; i += 1) sh.addVertex(`v${i}`, 1 + Math.floor(rng() * 2));
    const ne = 1 + Math.floor(rng() * (nv + 1));
    for (let e = 0; e < ne; e += 1) {
      const i = Math.floor(rng() * nv);
      let j = Math.floor(rng() * nv);
      if (j === i) j = (j + 1) % nv;
      // 随机 ±1 标量限制映射（可构造扭曲）
      sh.addEdge({
        a: `v${i}`, b: `v${j}`,
        mapA: [[rng() < 0.8 ? 1 : 2]],
        mapB: [[rng() < 0.5 ? 1 : -1]],
      });
    }
    if (sh.sectionSpaceDimension() === independentNullity(sh.buildLaplacian())) agree += 1;
  }
  ok(agree === trials, `${trials} 个种子化随机层：内核 H⁰ 与脚本侧独立秩消元零空间维数逐个一致`);
}

// ═══════════════════ ⑫ 20.0 全局截面存在性 ═══════════════════

section('20.0 ⑫ 全局截面存在性判定 + 显式构造');

{
  const path3 = scalarAgreementSheaf(['A', 'B', 'C']);
  const r1 = path3.globalSection([{ id: 'A', values: [0.7] }]);
  ok(r1.exists && Math.abs(r1.section.B[0] - 0.7) < 1e-9 && Math.abs(r1.section.C[0] - 0.7) < 1e-9,
    `相容锚点（A=0.7）：截面存在且外推 B=C=0.7（残差 ${r1.maxConstraintResidual.toExponential(2)} ≈ 0——精确复现约束）`);
  const moebius = new CellularSheaf();
  moebius.addVertex('A', 1).addVertex('B', 1).addVertex('C', 1);
  moebius.addEdge({ a: 'A', b: 'B' });
  moebius.addEdge({ a: 'B', b: 'C' });
  moebius.addEdge({ a: 'C', b: 'A', mapA: [[1]], mapB: [[-1]] });
  const r2 = moebius.globalSection();
  const r3 = moebius.globalSection([{ id: 'A', values: [1] }]);
  ok(!r2.exists && !r3.exists,
    '莫比乌斯层：无锚无非零截面（H⁰=0）；任意非零锚点也不相容（结构矛盾先于观测）');
  const tri = new CellularSheaf();
  tri.addVertex('A', 1).addVertex('B', 1).addVertex('C', 1);
  tri.addEdge({ a: 'A', b: 'B' }).addEdge({ a: 'B', b: 'C' }).addEdge({ a: 'C', b: 'A' });
  const r4 = tri.globalSection([
    { id: 'A', values: [0.9] }, { id: 'B', values: [0.1] }, { id: 'C', values: [0.5] },
  ]);
  const r5 = tri.globalSection([
    { id: 'A', values: [0.9] }, { id: 'B', values: [0.9] }, { id: 'C', values: [0.9] },
  ]);
  ok(!r4.exists && r5.exists && Math.abs(r5.section.A[0] - 0.9) < 1e-9,
    '三方环：矛盾观测（0.9/0.1/0.5）无截面、一致观测（全 0.9）截面精确——harmonize 障碍裁决的代数原形');
  // 向量维 + 部分锚定
  const ov = new CellularSheaf();
  ov.addVertex('X', 2).addVertex('Y', 2);
  ov.addEdge({ a: 'X', b: 'Y', sharedA: [0], sharedB: [1] });
  const r6 = ov.globalSection([{ id: 'X', values: [0.3, 0.9] }]);
  ok(r6.exists && Math.abs(r6.section.Y[1] - 0.3) < 1e-9 && r6.section.Y[0] === 0,
    '向量信念部分锚定：共享坐标被约束外推（Y[1]=X[0]=0.3），独占坐标取 0（最小范数特解）');
  // 种子化随机相容/矛盾锚点性质测试
  const rng = mulberry32(20261009);
  let consistentDetected = 0;
  let conflictDetected = 0;
  const trials = 120;
  for (let t = 0; t < trials; t += 1) {
    const nv = 3 + Math.floor(rng() * 3);
    const sh = scalarAgreementSheaf(Array.from({ length: nv }, (_, i) => `v${i}`));
    if (rng() < 0.5) {
      // 相容：全部锚同一真值
      const truth = rng();
      const anchors = Array.from({ length: nv }, (_, i) => ({ id: `v${i}`, values: [truth] }));
      if (sh.globalSection(anchors).exists) consistentDetected += 1;
    } else {
      // 矛盾：至少两个不同锚值
      const anchors = Array.from({ length: nv }, (_, i) => ({ id: `v${i}`, values: [rng()] }));
      if (!sh.globalSection(anchors).exists) conflictDetected += 1;
    }
  }
  ok(consistentDetected + conflictDetected === trials,
    `${trials} 个种子化锚点场景：相容 ${consistentDetected} 案全部判存在、矛盾 ${conflictDetected} 案全部判不存在（零误判）`);
}

// ═══════════════════ ⑬ 20.0 带权限制映射 ═══════════════════

section('20.0 ⑬ 带权限制映射：噪声源降权的软限制（鲁棒化）');

{
  const rng = mulberry32(20261010);
  const truth = 0.5;
  const anchors = [
    { id: 'truth', values: [truth + 0.004 * rng()] },
    { id: 's1', values: [truth + 0.004 * rng()] },
    { id: 's2', values: [truth + 0.004 * rng()] },
    { id: 'outlier', values: [1.5 + 0.004 * rng()] },
  ];
  const unweighted = scalarAgreementSheaf(['truth', 's1', 's2', 'outlier']);
  unweighted.addEdge({ a: 's2', b: 'outlier' });
  const hard = unweighted.harmonize(anchors);
  const weighted = new CellularSheaf();
  for (const id of ['truth', 's1', 's2', 'outlier']) weighted.addVertex(id, 1);
  weighted.addEdge({ a: 'truth', b: 's1' });
  weighted.addEdge({ a: 'truth', b: 's2' });
  weighted.addEdge({ a: 'truth', b: 'outlier', weight: 0.1 }); // 噪声声明源降权
  const soft = weighted.harmonize(anchors);
  const errHard = Math.abs(hard.consensus.truth[0] - truth);
  const errSoft = Math.abs(soft.consensus.truth[0] - truth);
  ok(errSoft < errHard && errSoft < 0.01 && errHard > 0.03,
    `噪声源降权：真值顶点误差 ${errHard.toFixed(3)} → ${errSoft.toFixed(3)}（降权 0.1 把共识拉回真值——软限制的鲁棒化收益）`);
  ok(Math.abs(soft.consensus.outlier[0] - 1.5) < 0.02,
    `降权不等于删除：离群源仍保留自身信念（outlier ≈ ${soft.consensus.outlier[0].toFixed(3)}，锚定权重仍在）`);
  // 权重 1 与升级前逐位一致（零回归口径）
  const same = scalarAgreementSheaf(['market', 'stats']);
  const rFar = same.harmonize([{ id: 'market', values: [0.82], weight: 1 }, { id: 'stats', values: [0.55], weight: 2 }]);
  const explicit = new CellularSheaf();
  explicit.addVertex('market', 1).addVertex('stats', 1);
  explicit.addEdge({ a: 'market', b: 'stats', weight: 1 });
  const rFar2 = explicit.harmonize([{ id: 'market', values: [0.82], weight: 1 }, { id: 'stats', values: [0.55], weight: 2 }]);
  ok(Math.abs(rFar.consensus.market[0] - 0.712) < 0.005 && Math.abs(rFar.consensus.market[0] - rFar2.consensus.market[0]) < 1e-9,
    `权重缺省 = 权重 1：解析锚点 0.712 复现、显式 weight:1 与省略逐位一致（升级零回归）`);
  // 权重 0 = 事实删除
  const zero = new CellularSheaf();
  zero.addVertex('a', 1).addVertex('b', 1);
  zero.addEdge({ a: 'a', b: 'b', weight: 0 });
  const rZero = zero.harmonize([{ id: 'a', values: [0.9], weight: 1 }, { id: 'b', values: [0.1], weight: 1 }]);
  ok(Math.abs(rZero.consensus.a[0] - 0.9) < 1e-9 && Math.abs(rZero.consensus.b[0] - 0.1) < 1e-9,
    '权重 0 = 事实删除约束：两顶点各自忠于观测（无约束的最小翻供）');
}

// ═══════════════════ ⑭ 56.0 Bethe 自由能 ═══════════════════

section('56.0 ⑭ Bethe 自由能：树上 = −ln Z 精确（置信度校准）');

{
  const rng = mulberry32(20261011);
  const rp = () => 0.05 + rng() * 1.95;
  let exact = 0;
  const trials = 200;
  let worst = 0;
  for (let t = 0; t < trials; t += 1) {
    const nv = 2 + Math.floor(rng() * 4);
    const g = new FactorGraph();
    const doms = [];
    for (let i = 0; i < nv; i += 1) {
      const d = rng() < 0.7 ? 2 : 3;
      doms.push(d);
      g.addVariable(`v${i}`, d, rng() < 0.6 ? Array.from({ length: d }, rp) : undefined);
    }
    for (let i = 1; i < nv; i += 1) {
      const parent = Math.floor(rng() * i);
      if (rng() < 0.85) g.addFactor([`v${parent}`, `v${i}`], Array.from({ length: doms[parent] * doms[i] }, rp));
    }
    const report = g.runBeliefPropagation({ maxIter: 200, tol: 1e-12 });
    if (!report.isTree) continue; // 只统计树（森林亦精确，但对照口径取树）
    const bethe = g.betheFreeEnergy();
    const dev = Math.abs(bethe.logZBethe - g.bruteForceLogZ());
    worst = Math.max(worst, dev);
    if (dev <= 1e-6) exact += 1;
  }
  ok(exact === trials,
    `200 棵种子随机树（二/三值域、随机先验、80% 成对因子密度）：F_Bethe = −ln Z 全部 ≤ 1e-6（最差 ${worst.toExponential(2)}——YFW 变分恒等式的逐位实证）`);

  // 含圈：ln Z_Bethe 的偏差 = loopy 校准读数
  const n = 8;
  const gl = new FactorGraph();
  for (let i = 0; i < n; i += 1) {
    const h = 0.12 * (i % 2 === 0 ? 1 : -1);
    gl.addVariable(`s${i}`, 2, [Math.exp(-h), Math.exp(h)]);
  }
  for (let i = 0; i < n; i += 1) {
    gl.addFactor([`s${i}`, `s${(i + 1) % n}`], [Math.exp(0.4), Math.exp(-0.4), Math.exp(-0.4), Math.exp(0.4)]);
  }
  gl.runBeliefPropagation({ maxIter: 2000, tol: 1e-12, damping: 0.5 });
  const bethe = gl.betheFreeEnergy();
  const exactZ = gl.bruteForceLogZ();
  const gap = Math.abs(bethe.logZBethe - exactZ);
  ok(!bethe.isTree && gap < 0.01,
    `含圈 Ising 单环：ln Z_Bethe = ${bethe.logZBethe.toFixed(6)} vs 精确 ${exactZ.toFixed(6)}（偏差 ${gap.toExponential(2)} = loopy 近似的校准读数——Bethe 驻点不是精确值，但偏差本身可量化）`);
  ok(throws(() => new FactorGraph().betheFreeEnergy()),
    '未运行先取 Bethe 自由能显式拒绝');
}

// ═══════════════════ ⑮ 56.0 max-sum 对数域解码 ═══════════════════

section('56.0 ⑮ max-sum 对数域解码：= max-product = 穷举 MAP + 极端势表');

{
  const rng = mulberry32(20261012);
  const rp = () => 0.05 + rng() * 1.95;
  let sameAssign = 0;
  let sameJoint = 0;
  const trials = 80;
  for (let t = 0; t < trials; t += 1) {
    const nv = 3 + Math.floor(rng() * 4);
    const g = new FactorGraph();
    const doms = [];
    for (let i = 0; i < nv; i += 1) {
      const d = rng() < 0.5 ? 2 : 3;
      doms.push(d);
      g.addVariable(`v${i}`, d, rng() < 0.6 ? Array.from({ length: d }, rp) : undefined);
    }
    for (let i = 1; i < nv; i += 1) {
      const parent = Math.floor(rng() * i);
      g.addFactor([`v${parent}`, `v${i}`], Array.from({ length: doms[parent] * doms[i] }, rp));
    }
    const mp = g.maxProductDecode({ maxIter: 300, tol: 1e-12 });
    const ms = g.maxSumDecode({ maxIter: 300, tol: 1e-12 });
    const brute = g.bruteForceMAP();
    const keys = Object.keys(ms.assignment);
    if (keys.every((k) => ms.assignment[k] === brute.assignment[k] && mp.assignment[k] === brute.assignment[k])) sameAssign += 1;
    if (Math.abs(ms.logJoint - brute.logJoint) < 1e-9 && Math.abs(mp.logJoint - ms.logJoint) < 1e-9) sameJoint += 1;
  }
  ok(sameAssign === trials && sameJoint === trials,
    `80 棵种子随机树：max-sum 与 max-product 与穷举 MAP 三方同指派（${sameAssign}/${trials}）、同 logJoint ≤ 1e-9（${sameJoint}/${trials}）`);

  // 极端势表（e^±600）：朴素概率口径早已溢出，对数域精确
  const ex = new FactorGraph();
  const rng2 = mulberry32(5);
  for (let i = 0; i < 4; i += 1) ex.addVariable(`h${i}`, 2);
  for (let i = 1; i < 4; i += 1) {
    ex.addFactor([`h${i - 1}`, `h${i}`], Array.from({ length: 4 }, () => Math.exp(rng2() * 1200 - 600)));
  }
  const msEx = ex.maxSumDecode({ maxIter: 200, tol: 1e-12 });
  const brEx = ex.bruteForceMAP();
  const sameEx = Object.keys(msEx.assignment).every((k) => msEx.assignment[k] === brEx.assignment[k]);
  ok(sameEx && msEx.logJoint === brEx.logJoint,
    `e^±600 量级势表链：max-sum 指派 = 穷举 MAP、logJoint 逐位相等（概率域乘积 10^±260 早已溢出，对数域全程无 exp 往返）`);

  // 耗时对照：三元链 260 节点
  const chain = new FactorGraph();
  const N = 260;
  for (let i = 0; i < N; i += 1) chain.addVariable(`c${i}`, 3);
  for (let i = 1; i < N; i += 1) chain.addFactor([`c${i - 1}`, `c${i}`], Array.from({ length: 9 }, rp));
  let t0 = performance.now();
  const mp = chain.maxProductDecode({ maxIter: 600, tol: 1e-12 });
  const mpMs = performance.now() - t0;
  t0 = performance.now();
  const ms = chain.maxSumDecode({ maxIter: 600, tol: 1e-12 });
  const msMs = performance.now() - t0;
  const sameChain = Object.keys(mp.assignment).every((k) => mp.assignment[k] === ms.assignment[k]);
  ok(sameChain && msMs < mpMs,
    `耗时对照（260 节点三元链）：max-product ${mpMs.toFixed(0)}ms vs max-sum ${msMs.toFixed(0)}ms（×${(mpMs / Math.max(1e-9, msMs)).toFixed(2)}——每表项省一次 Math.exp），指派与 logJoint 相同`);
}

// ═══════════════════ ⑯ 56.0 GDL 前缀积 ═══════════════════

section('56.0 ⑯ GDL 前缀积：等价证明 + 高度数耗时对照');

{
  const rng = mulberry32(20261013);
  let worstRel = 0;
  for (let t = 0; t < 320; t += 1) {
    const d = 2 + Math.floor(rng() * 3);
    const deg = 1 + Math.floor(rng() * 8);
    const prior = Array.from({ length: d }, () => 0.05 + rng());
    const inc = Array.from({ length: deg }, () => Float64Array.from(Array.from({ length: d }, () => 0.05 + rng())));
    const outs = gdlVarToFactorMessages(prior, inc);
    for (let i = 0; i < deg; i += 1) {
      // 朴素基线：逐目标连乘（升级前算法）
      const naive = Float64Array.from(prior);
      for (let j = 0; j < deg; j += 1) {
        if (j === i) continue;
        for (let s = 0; s < d; s += 1) naive[s] *= inc[j][s];
      }
      for (let s = 0; s < d; s += 1) worstRel = Math.max(worstRel, Math.abs(naive[s] - outs[i][s]) / naive[s]);
    }
  }
  ok(worstRel <= 1e-15, `320 组种子化（域 2..4 × 度 1..8）：GDL 出消息 = 逐目标连乘（相对差 ${worstRel.toExponential(2)} ≤ 1e-15，浮点舍入阶等价证明）`);

  // 高度数耗时：度 300、域 4
  const d = 4;
  const deg = 300;
  const prior = Array.from({ length: d }, () => 0.5);
  const inc = Array.from({ length: deg }, () => Float64Array.from([0.3, 0.7, 0.5, 0.9]));
  const naiveOnce = () => {
    for (let i = 0; i < deg; i += 1) {
      const out = Float64Array.from(prior);
      for (let j = 0; j < deg; j += 1) {
        if (j === i) continue;
        for (let s = 0; s < d; s += 1) out[s] *= inc[j][s];
      }
    }
  };
  let t0 = performance.now();
  for (let r = 0; r < 50; r += 1) naiveOnce();
  const naiveMs = performance.now() - t0;
  t0 = performance.now();
  for (let r = 0; r < 50; r += 1) gdlVarToFactorMessages(prior, inc);
  const gdlMs = performance.now() - t0;
  ok(gdlMs * 3 < naiveMs,
    `度 300 × 域 4 × 50 轮：逐目标连乘 ${naiveMs.toFixed(1)}ms vs GDL 前缀积 ${gdlMs.toFixed(1)}ms（×${(naiveMs / Math.max(1e-9, gdlMs)).toFixed(1)}——O(d²·m) → O(3d·m)）`);
}

// ═══════════════════ ⑰ 56.0 树上 BP = 精确边缘（加强） ═══════════════════

section('56.0 ⑰ 树上 sum-product = 精确边缘化（220 棵种子树加强）');

{
  // 脚本侧独立暴力枚举（与内核零共享；log 域）
  const bruteMarginals = (vars, factors) => {
    const n = vars.length;
    const strides = new Array(n).fill(1);
    for (let i = n - 2; i >= 0; i -= 1) strides[i] = strides[i + 1] * vars[i + 1].domain;
    const posOf = new Map(vars.map((v, i) => [v.id, i]));
    const fmeta = factors.map((f) => {
      const idxOf = f.scope.map((id) => posOf.get(id));
      const jointStride = f.scope.map((id) => strides[posOf.get(id)]);
      const tableStride = new Array(f.scope.length).fill(1);
      for (let p = f.scope.length - 2; p >= 0; p -= 1) tableStride[p] = tableStride[p + 1] * vars[idxOf[p + 1]].domain;
      return { idxOf, jointStride, tableStride, logTable: f.table.map((x) => (x > 0 ? Math.log(x) : -Infinity)) };
    });
    const logPrior = vars.map((v) => {
      const p = v.prior ?? Array(v.domain).fill(1);
      const sum = p.reduce((a, b) => a + b, 0);
      return p.map((x) => (x > 0 ? Math.log(x / sum) : -Infinity));
    });
    let total = 1;
    for (const v of vars) total *= v.domain;
    const lj = new Float64Array(total);
    for (let a = 0; a < total; a += 1) {
      let s = 0;
      for (let i = 0; i < n; i += 1) s += logPrior[i][Math.floor(a / strides[i]) % vars[i].domain];
      for (const f of fmeta) {
        let ti = 0;
        for (let p = 0; p < f.idxOf.length; p += 1) {
          ti += (Math.floor(a / f.jointStride[p]) % vars[f.idxOf[p]].domain) * f.tableStride[p];
        }
        s += f.logTable[ti];
      }
      lj[a] = s;
    }
    const mx = Math.max(...lj);
    let zs = 0;
    for (let a = 0; a < total; a += 1) zs += Math.exp(lj[a] - mx);
    const logZ = mx + Math.log(zs);
    const acc = vars.map(() => null);
    for (let i = 0; i < n; i += 1) acc[i] = new Float64Array(vars[i].domain);
    for (let a = 0; a < total; a += 1) {
      const w = Math.exp(lj[a] - logZ);
      for (let i = 0; i < n; i += 1) acc[i][Math.floor(a / strides[i]) % vars[i].domain] += w;
    }
    const out = {};
    for (let i = 0; i < n; i += 1) out[vars[i].id] = Array.from(acc[i]);
    return out;
  };

  const rng = mulberry32(20261014);
  const rp = () => 0.05 + rng() * 1.95;
  let exact = 0;
  let trees = 0;
  let worst = 0;
  const trials = 220;
  for (let t = 0; t < trials; t += 1) {
    const nv = 3 + Math.floor(rng() * 4);
    const vars = [];
    for (let i = 0; i < nv; i += 1) {
      const domain = rng() < 0.5 ? 2 : 3;
      vars.push({ id: `x${i}`, domain, prior: rng() < 0.6 ? Array.from({ length: domain }, rp) : undefined });
    }
    const factors = [];
    for (let i = 1; i < nv; i += 1) {
      const parent = Math.floor(rng() * i);
      const size = vars[parent].domain * vars[i].domain;
      factors.push({ scope: [vars[parent].id, vars[i].id], table: Array.from({ length: size }, rp) });
    }
    const g = new FactorGraph();
    for (const v of vars) g.addVariable(v.id, v.domain, v.prior);
    for (const f of factors) g.addFactor(f.scope, f.table);
    const report = g.runBeliefPropagation({ maxIter: 300, tol: 1e-12 });
    if (!report.isTree || !report.converged) continue;
    trees += 1;
    const truth = bruteMarginals(vars, factors);
    const m = g.marginals();
    let dev = 0;
    for (const id of Object.keys(truth)) {
      for (let s = 0; s < truth[id].length; s += 1) dev = Math.max(dev, Math.abs(m[id][s] - truth[id][s]));
    }
    worst = Math.max(worst, dev);
    if (dev <= 1e-9) exact += 1;
  }
  ok(trees === trials && exact === trials,
    `220 棵种子随机树（GDL 前缀积路径）：BP 边缘 vs 独立暴力联合枚举全部 ≤ 1e-9（最差 ${worst.toExponential(2)}——升级消息路径的等价性实证）`);
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed === 0) {
  console.log('✅ R5-A14 共识验证六内核第五轮进化全部数学锚点成立：');
  console.log('   46.0 R+W>n 读写一致性 + 栅格法定人数（Cheung 构造）');
  console.log('   47.0 2P-Set remove-win + delta-CRDT 增量传播（等价证明）');
  console.log('   48.0 Feldman VSS 点值承诺 + 确定性 Miller–Rabin + 任意点插值');
  console.log('   15.0 LTLf Y/S 过去算子 + past-DFA Moore 最小化（O(n²)→O(n) 监视）');
  console.log('   20.0 H⁰ 维数 + 全局截面存在性 + 带权软限制');
  console.log('   56.0 Bethe 自由能（树上=−ln Z）+ max-sum 对数域 + GDL 前缀积');
  process.exit(0);
} else {
  process.exit(1);
}
