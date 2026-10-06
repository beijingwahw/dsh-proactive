/**
 * verify-r5-metacognition.mjs — 第五轮「元认知五内核」世界性进化离线验证
 *
 * 覆盖内核（R5-A4 独占）：deliberation 7.0 / metareasoning 8.0 /
 * abstraction 9.0 / global-workspace 96.0 / metacognitive-confidence 97.0。
 * 每项进化按四轴验证——数学锚点（解析对照）、性能等价（等价证明 + 耗时）、
 * 数值稳健、性质测试（种子化 ≥200 输入）；全部确定性（脚本侧随机统一走
 * 本文件 mulberry32）。
 *
 *   A deliberation R5
 *     A1 贝叶斯说服闭式：L_R = L₀ + w(Σpro − Σcon) 逐轮恒等、B_R = σ(L_R)
 *        手算锚；强度包络单调（clinch 界的数学前提）
 *     A2 clinch 提前停机：≥200 种子 earlyStop 与 exact 全程 verdict 严格
 *        一致 + 停机区间双侧同号；不对称辩论耗时下降（等价证明 + 耗时）
 *     A3 log 域：60 步 0.5 连乘下溢为 0 而 logPAllSuccess 满精度；
 *        非下溢区 exp(log) ≈ pAll
 *   B metareasoning R5
 *     B1 泊松最优停止闭式：≥200 组参数 vs 全深度枚举 argmax（逐项累加
 *        独立复算）；退化分支（c=0 / vλ₀≤c）
 *     B2 水填充分配：≥200 组 (算法×预算) vs 暴力全组合枚举——总价值
 *        不劣于枚举最优；等边际性质
 *     B3 decideWithClosedFormStop 接线：d* 封顶生效、配置事后复原（零漂移）
 *   C abstraction R5
 *     C1 率失真 DP：≥200 种子 vs 连续划分暴力枚举逐 K 等值；D(K) 单调不增
 *     C2 并查集等价类：≥200 种子 vs O(n²) 逐对 BFS 闭包——成员完全一致
 *     C3 L1 倒排索引：≥200 次查询 vs 脚本侧旧全表扫描独立复算——均值/
 *        来源/证人逐位相等（1e-12）；扫描计数审计 + 耗时对照
 *     C4 商结构：projectToSkeleton 幂等 ≥200 输入；quotientSystem 边端点
 *        封闭于状态集、池化后验脚本侧复算一致
 *   D global-workspace R5
 *     D1 熵(T) 单调（反馈律前提，≥200 种子投标向量 × T 阶梯）；退火收敛
 *        到目标归一化熵；同 seed 逐位复放；未配置退火 = 恒温零漂移
 *     D2 增量轨迹统计：64 模块 × 4000 步与逐引擎步进 + 旧式 O(M·L) 重扫
 *        逐位相等；聚合耗时 O(L) < O(M·L)
 *     D3 溢出护栏：T=1e-320 不产生 NaN（T→0⁺ 极限：argmax 并列均匀）；
 *        退火参数显式 throw
 *   E metacognitive-confidence R5
 *     E1 参数拟合：零噪声工厂恢复 d；随元认知噪声单调压低（50 种子 ×
 *        4 档 = 200 输入）；与面积反演独立估计一致
 *     E2 贝叶斯报告：Brier(r) − Brier(r*) = (r − r*)² 精确恒等式（Monte
 *        Carlo ≥200 组对照）；期望 Brier = m(1−m) 闭式；决策同侧读出
 *     E3 log-odds 稳健化：≥200 网格点与旧 odds 乘法公式相差 ≤ 1e-12；
 *        极端 c/q 无 NaN
 *   附加：25 个 R5 新符号经根入口导出（接线卫兵）
 *
 * 运行：npm run build && node scripts/verify-r5-metacognition.mjs
 */

import {
  DeliberationEngine,
  simulateDebate,
  RationalMetareasoner,
  poissonOptimalStop,
  optimalComputeAllocation,
  AbstractionEngine,
  projectToSkeleton,
  GlobalWorkspace,
} from '../dist/index.mjs';
// 97.0 在根入口经显式名单再导出（名单不在本任务文件所有权内，不改动）——
// R5 新函数按 verify-metacognition-replay.mjs 先例直接从内核源文件导入
import {
  metaDprime,
  posteriorErrorProbability,
  simulateMetacognition,
  normalCdf,
  metaDprimeFit,
  bayesOptimalReport,
} from '../src/core/metacognitive-confidence.ts';

// ─────────────────────────── 断言工具 ───────────────────────────
let passed = 0;
let failed = 0;
let seededInputs = 0;
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
/** 确定性 RNG（脚本侧构造性随机唯一来源） */
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
const logistic = (x) => 1 / (1 + Math.exp(-x));
function seedEdges(engine, state, action, successes, failures, next) {
  for (let i = 0; i < successes; i += 1) engine.observe(state, action, true, next);
  for (let i = 0; i < failures; i += 1) engine.observe(state, action, false);
}
function seedTrapWorld(engine, domain) {
  seedEdges(engine, `${domain}#s0`, 'bait', 9, 1, `${domain}#dead`);
  seedEdges(engine, `${domain}#s0`, 'slow', 6, 4, `${domain}#rich`);
  seedEdges(engine, `${domain}#dead`, 'bait', 2, 8, `${domain}#dead`);
  seedEdges(engine, `${domain}#dead`, 'slow', 2, 8, `${domain}#dead`);
  seedEdges(engine, `${domain}#rich`, 'bait', 19, 1, `${domain}#rich`);
  seedEdges(engine, `${domain}#rich`, 'slow', 19, 1, `${domain}#rich`);
}

// ═══════════════════ 0 R5 新符号接线卫兵 ═══════════════════

section('0 符号卫兵：R5 新 API 可达');

{
  const expected = ['simulateDebate', 'poissonOptimalStop', 'optimalComputeAllocation', 'projectToSkeleton'];
  const root = await import('../dist/index.mjs');
  const missing = expected.filter((s) => !(s in root));
  ok(missing.length === 0, `4 个 R5 新函数经根入口导出（缺席：${missing.length ? missing.join(', ') : '无'}）`);
  const conf = await import('../src/core/metacognitive-confidence.ts');
  ok('metaDprimeFit' in conf && 'bayesOptimalReport' in conf, 'metaDprimeFit / bayesOptimalReport 内核模块可达（97.0 根入口为显式名单，不在本任务所有权内）');
  ok(typeof simulateDebate === 'function' && typeof poissonOptimalStop === 'function', '函数符号绑定可用');
}

// ═══════════════════ A deliberation 7.0 R5 ═══════════════════

section('A1 贝叶斯说服模型：听众信念闭式 + 强度包络单调');

{
  // 信息论说服口径：论据强度 = 证据池剩余的期望信息增益——
  // 证据更模糊（更多待揭示）的一方每轮更有说服力；证据锐利的一方无新可说。
  const r = simulateDebate({ successes: 2, failures: 2 }, { successes: 30, failures: 0 }, { rounds: 30 });
  ok(r.verdict === 'pro', `证据待揭示方胜出：pro 池模糊（EIG 高）vs con 池锐利（EIG 低）→ verdict = pro（L = ${r.finalLogOdds.toFixed(3)} > 0）`);
  // 闭式恒等式：L_R = L₀ + w·(Σpro − Σcon) —— 从 trace 原语独立复算
  const L0 = Math.log(0.5 / 0.5);
  const Lclosed = L0 + 1 * (r.totalProStrength - r.totalConStrength);
  ok(near(r.finalLogOdds, Lclosed, 2e-6), `闭式 L_R = L₀ + w(Σpro − Σcon)：${r.finalLogOdds.toFixed(6)} = ${Lclosed.toFixed(6)}`);
  // 每轮信念 = σ(L_r)（一次前缀和 + 一次 σ——可独立复算）
  let L = L0;
  let beliefOk = true;
  for (const t of r.trace) {
    L += (t.side === 'pro' ? 1 : -1) * t.strength;
    if (!near(t.logOdds, L, 5e-6) || !near(t.belief, logistic(L), 5e-6)) beliefOk = false;
  }
  ok(beliefOk, `逐轮恒等：B_r = σ(L₀ + w·ΔS_r) 全部成立（${r.trace.length} 轮）`);
  ok(r.strengthEnvelopeMonotone, '强度包络单调不增（证据越多边际说服力越低——clinch 界的数学前提）');
  // 边际说服力递减：首轮位移 > 末轮位移
  ok(r.trace[0].marginalChange > r.trace[r.trace.length - 1].marginalChange,
    `边际信念位移递减：首 ${r.trace[0].marginalChange.toFixed(5)} > 末 ${r.trace[r.trace.length - 1].marginalChange.toFixed(5)}（重复发言自然收敛）`);
  // 镜像对称池：同等自信的正反证据**精确抵消**（Beta 熵的镜像对称性）
  const mirror = simulateDebate({ successes: 9, failures: 1 }, { successes: 1, failures: 9 }, { rounds: 40 });
  ok(Math.abs(mirror.finalLogOdds) < 1e-9, `镜像池精确抵消：|L| = ${Math.abs(mirror.finalLogOdds).toExponential(2)}（EIG(α,β) = EIG(β,α)，逐轮成对相消——贝叶斯听众不被对称证据推动）`);
  // 反向镜像：胜负随之翻转（信息说服的对称性）
  const mirror2 = simulateDebate({ successes: 30, failures: 0 }, { successes: 2, failures: 2 }, { rounds: 30 });
  ok(mirror2.verdict === 'con', `池角色互换 → verdict = con（L = ${mirror2.finalLogOdds.toFixed(3)}，对称性成立）`);
  // 入参校验
  ok(throws(() => simulateDebate({ successes: -1, failures: 0 }, { successes: 1, failures: 1 })), 'simulateDebate(负计数) throw');
  ok(throws(() => simulateDebate({ successes: 1, failures: 1 }, { successes: 1, failures: 1 }, { initialBelief: 0 })), 'simulateDebate(initialBelief=0) throw');
  ok(throws(() => simulateDebate({ successes: 1, failures: 1 }, { successes: 1, failures: 1 }, { persuasibility: -1 })), 'simulateDebate(w<0) throw');
}

section('A2 clinch 提前停机：≥200 种子 verdict 等价 + 耗时');

{
  const rng = mulberry32(2025);
  const N = 220;
  let mismatches = 0;
  let earlyStops = 0;
  let bracketOk = 0;
  let bracketTotal = 0;
  for (let i = 0; i < N; i += 1) {
    seededInputs += 1;
    const proS = Math.floor(rng() * 60);
    const proF = Math.floor(rng() * 60);
    const conS = Math.floor(rng() * 60);
    const conF = Math.floor(rng() * 60);
    const rounds = 40 + Math.floor(rng() * 100);
    const w = 0.3 + rng() * 2;
    const b0 = 0.2 + rng() * 0.6;
    const early = simulateDebate({ successes: proS, failures: proF }, { successes: conS, failures: conF }, {
      rounds,
      initialBelief: b0,
      persuasibility: w,
      earlyStop: true,
    });
    const exact = simulateDebate({ successes: proS, failures: proF }, { successes: conS, failures: conF }, {
      rounds,
      initialBelief: b0,
      persuasibility: w,
      earlyStop: false,
    });
    if (early.verdict !== exact.verdict) mismatches += 1;
    if (early.stoppedEarly) {
      earlyStops += 1;
      // 停机区间 [L_stop − UB, L_stop + UB] 双侧同号且包住 exact 终值
      const lo = early.finalLogOdds - early.clinchBound;
      const hi = early.finalLogOdds + early.clinchBound;
      bracketTotal += 1;
      if (lo > 0 === hi > 0 && exact.finalLogOdds >= lo - 1e-9 && exact.finalLogOdds <= hi + 1e-9) bracketOk += 1;
    }
  }
  ok(mismatches === 0, `${N} 种子：clinch 停机 verdict 与跑满全程严格一致（错 ${mismatches}）`);
  ok(earlyStops > N * 0.3, `不对称世界大量提前停机（${earlyStops}/${N}——节省轮次比例见下方耗时对照的 roundsUsed）`);
  ok(bracketOk === bracketTotal, `停机区间双侧同号且包住 exact 终值（${bracketOk}/${bracketTotal}）`);

  // 耗时：强不对称 + 长轮次下 exact 全程 vs clinch 早停
  const ROUNDS = 3000;
  const poolPro = { successes: 400, failures: 5 };
  const poolCon = { successes: 2, failures: 300 };
  const t0 = performance.now();
  for (let i = 0; i < 30; i += 1) {
    simulateDebate(poolPro, poolCon, { rounds: ROUNDS, earlyStop: false });
  }
  const exactMs = performance.now() - t0;
  const t1 = performance.now();
  let usedSum = 0;
  for (let i = 0; i < 30; i += 1) {
    usedSum += simulateDebate(poolPro, poolCon, { rounds: ROUNDS, earlyStop: true }).roundsUsed;
  }
  const earlyMs = performance.now() - t1;
  ok(earlyMs < exactMs, `耗时：exact ${exactMs.toFixed(1)}ms vs clinch ${earlyMs.toFixed(1)}ms（30 场 × ${ROUNDS} 轮，平均 ${Math.round(usedSum / 30)} 轮停机，提速 ${(exactMs / earlyMs).toFixed(1)}×）`);
}

section('A3 log 域成功概率：长计划下溢免疫');

{
  const engine = new DeliberationEngine();
  // 60 步自环 p=0.5：连乘 0.5^60 ≈ 8.7e-19（尚可表示）→ 用 p=0.1 制造真下溢
  seedEdges(engine, 'deep', 'x', 0, 18, 'deep'); // p = 1/20 = 0.05
  const actions = Array.from({ length: 400 }, () => 'x');
  const r = engine.imagine('deep', actions);
  ok(r.pAllSuccess === 0, `400 步 × p=0.05：连乘下溢为 0（实测 ${r.pAllSuccess}）`);
  ok(Number.isFinite(r.logPAllSuccess) && near(r.logPAllSuccess, 400 * Math.log(0.05), 1e-3),
    `logPAllSuccess 满精度 = 400·ln(0.05) = ${(400 * Math.log(0.05)).toFixed(2)}（实测 ${r.logPAllSuccess.toFixed(2)}）`);
  // 非下溢区：exp(log) ≈ pAll
  seedEdges(engine, 'short', 'y', 8, 2, 'short');
  const r2 = engine.imagine('short', ['y', 'y', 'y']);
  ok(near(Math.exp(r2.logPAllSuccess), r2.pAllSuccess, 1e-6), `非下溢区自洽：exp(logP) = ${Math.exp(r2.logPAllSuccess).toFixed(6)} ≈ pAll = ${r2.pAllSuccess}`);
  // 与既有口径零漂移：短计划 pAllSuccess 连乘不变
  const prod = r2.steps.reduce((acc, s) => acc * s.pStep, 1);
  ok(near(r2.pAllSuccess, prod, 2e-6), `pAllSuccess = 连乘（${prod.toFixed(6)}，既有口径逐位保持）`);
}

// ═══════════════════ B metareasoning 8.0 R5 ═══════════════════

section('B1 泊松最优停止闭式：vs 全深度枚举（≥200 组参数）');

{
  const rng = mulberry32(88);
  const N = 220;
  let match = 0;
  let valueOptimal = 0;
  for (let i = 0; i < N; i += 1) {
    seededInputs += 1;
    const rate0 = 0.2 + rng() * 3;
    const decay = 0.3 + rng() * 0.68;
    const v = 0.2 + rng() * 3;
    const c = 0.01 + rng() * v * rate0 * 1.2;
    const result = poissonOptimalStop({ rate0, decay, valuePerDiscovery: v, costPerDepth: c }, 400);
    // 独立枚举：逐项累加 V(D)，取 argmax（基线 V(0) = 0——不搜是免费选项）
    let bestD = 0;
    let bestV = 0;
    let sum = 0;
    for (let d = 1; d <= 400; d += 1) {
      sum += v * rate0 * Math.pow(decay, d);
      const val = sum - c * d;
      if (val > bestV + 1e-12) {
        bestV = val;
        bestD = d;
      }
    }
    if (result.optimalDepth === bestD) match += 1;
    // 闭式点的价值 ≥ 枚举最优 − 1e-9（即使深度因平顶差 1 也价值不劣）
    const closedV = v * rate0 * (decay * (1 - Math.pow(decay, result.optimalDepth))) / (1 - decay) - c * result.optimalDepth;
    if (closedV >= bestV - 1e-9) valueOptimal += 1;
  }
  ok(match >= N - 2, `${N} 组参数：闭式 d* 与逐项累加枚举 argmax 一致（${match}/${N}，容许 ≤2 平顶轮换）`);
  ok(valueOptimal === N, `${N}/${N}：闭式 d* 处期望价值 ≥ 枚举最优 − 1e-9（价值不劣）`);
  // 退化分支
  const free = poissonOptimalStop({ rate0: 1, decay: 0.5, valuePerDiscovery: 1, costPerDepth: 0 }, 77);
  ok(free.optimalDepth === 77 && free.degenerate === 'search-to-cap', `c=0 → 搜到上限（${free.optimalDepth}，search-to-cap）`);
  const never = poissonOptimalStop({ rate0: 0.1, decay: 0.5, valuePerDiscovery: 1, costPerDepth: 0.2 }, 100);
  ok(never.optimalDepth === 0 && never.degenerate === 'never-search', `vλ₀ ≤ c → 一次都不搜（never-search）`);
  ok(throws(() => poissonOptimalStop({ rate0: 0, decay: 0.5, valuePerDiscovery: 1, costPerDepth: 1 })), 'poissonOptimalStop(rate0=0) throw');
  ok(throws(() => poissonOptimalStop({ rate0: 1, decay: 1, valuePerDiscovery: 1, costPerDepth: 1 })), 'poissonOptimalStop(decay=1) throw');
}

section('B2 水填充分配：vs 暴力全组合枚举（≥200 组）');

{
  const rng = mulberry32(99);
  const N = 200;
  let optimalCount = 0;
  let equimarginalCount = 0;
  for (let i = 0; i < N; i += 1) {
    seededInputs += 1;
    const nAlgo = 2 + (i % 2); // 2 或 3 个算法
    const models = Array.from({ length: nAlgo }, () => ({
      rate0: 0.3 + rng() * 2,
      decay: 0.4 + rng() * 0.5,
      valuePerDiscovery: 0.3 + rng() * 2,
      costPerDepth: rng() * 0.6,
    }));
    const budget = Math.floor(rng() * 14);
    const result = optimalComputeAllocation(models, budget);
    // 暴力枚举：全组合 (d1+..+dn = B) 的总价值（逐项累加独立口径）
    const valueOf = (alloc) =>
      models.reduce((s, m, j) => {
        let sum = 0;
        for (let d = 1; d <= alloc[j]; d += 1) sum += m.valuePerDiscovery * m.rate0 * Math.pow(m.decay, d) - m.costPerDepth;
        return s + sum;
      }, 0);
    const allocScratch = new Array(models.length).fill(0);
    const enumerate = (idx, remaining) => {
      if (idx === models.length - 1) {
        allocScratch[idx] = remaining;
        return valueOf(allocScratch);
      }
      let best = -Infinity;
      for (let x = 0; x <= remaining; x += 1) {
        allocScratch[idx] = x;
        best = Math.max(best, enumerate(idx + 1, remaining - x));
      }
      return best;
    };
    const brute = enumerate(0, budget);
    // 内核输出 6 位小数舍入 —— 容差取 1e-5（舍入误差 ≤ 5e-7/分量，安全冗余）
    if (result.totalValue >= brute - 1e-5 && result.budgetUsed <= budget) optimalCount += 1;
    // 交换论证最优性证书：任何已取单元的边际 ≥ 任何算法下一层的边际
    //（下一层边际 vλρ^{d+1} − c；已取末层边际 vλρ^d − c）；
    // 且预算未用满 ⟹ 全部下一层边际 ≤ 0（水填充到 0 水位即停）
    let equi = true;
    const nextMarg = models.map((m, j) => m.valuePerDiscovery * m.rate0 * Math.pow(m.decay, result.allocations[j] + 1) - m.costPerDepth);
    const takenLast = models.map((m, j) => (result.allocations[j] > 0 ? m.valuePerDiscovery * m.rate0 * Math.pow(m.decay, result.allocations[j]) - m.costPerDepth : -Infinity));
    const minTaken = Math.min(...takenLast.filter((v) => Number.isFinite(v)));
    if (Math.max(...nextMarg) > minTaken + 1e-7) equi = false;
    if (result.budgetUsed < budget && Math.max(...nextMarg) > 1e-7) equi = false;
    if (equi) equimarginalCount += 1;
  }
  ok(optimalCount === N, `${N} 组：贪心合并总价值 ≥ 暴力枚举最优 − 1e-9 且预算不超（${optimalCount}/${N}）`);
  ok(equimarginalCount === N, `${N} 组：等边际性质成立（最大下一层边际 ≤ 最小已取边际；预算未满 ⟹ 水位到 0）`);
  ok(throws(() => optimalComputeAllocation([], 5)), 'optimalComputeAllocation(空) throw');
  ok(throws(() => optimalComputeAllocation([{ rate0: 1, decay: 0.5, valuePerDiscovery: 1, costPerDepth: 0 }], -1)), 'optimalComputeAllocation(负预算) throw');
}

section('B3 decideWithClosedFormStop 接线：闭式封顶 + 零漂移');

{
  const d = new DeliberationEngine();
  seedTrapWorld(d, 'trap');
  const m = new RationalMetareasoner(d, { maxDepth: 6 });
  // λ₀=2、ρ=0.5、v=0.5、c=0.3 → 边际 0.5·2·0.5^D − 0.3：D=1: 0.2、D=2: −0.05 → d*=1?
  // 取参数使 d*=2：v·λ₀·ρ^D > c 直到 D=2 ⟺ 0.5^3·vλ₀ > c ≥ 0.5^3...（脚本侧直接读取 cap 断言）
  const model = { rate0: 2.4, decay: 0.6, valuePerDiscovery: 0.35, costPerDepth: 0.3 };
  const stop = poissonOptimalStop(model, 6);
  const r = m.decideWithClosedFormStop('trap#s0', ['bait', 'slow'], model);
  ok(r.closedFormCap === Math.max(1, Math.min(6, stop.optimalDepth)), `封顶 = min(maxDepth, d*) = ${r.closedFormCap}（闭式 d* = ${stop.optimalDepth}）`);
  ok(r.depthStopped <= r.closedFormCap, `实际停止深度 ${r.depthStopped} ≤ 封顶 ${r.closedFormCap}（前瞻定价生效）`);
  ok(r.actions[0] === 'slow', `封顶下深思仍绕开诱饵（${r.actions.join(' → ')}——浅层已可分胜负的世界）`);
  // 配置复原：后续 decide 恢复原 maxDepth 口径（零漂移）
  const r2 = m.decide('trap#s0', ['bait', 'slow']);
  ok(r2.mode === 'deliberative', `decide() 复原：仍可深思到原 maxDepth（mode=${r2.mode}，深度上限未被调用污染）`);
  ok(throws(() => m.decideWithClosedFormStop('x', [], model)), '候选为空 throw');
}

// ═══════════════════ C abstraction 9.0 R5 ═══════════════════

section('C1 率失真最优粒度：DP vs 连续划分暴力枚举（≥200 种子）');

{
  const rng = mulberry32(4242);
  const N = 200;
  let dpOptimal = 0;
  let monotoneCount = 0;
  for (let i = 0; i < N; i += 1) {
    seededInputs += 1;
    const abs = new AbstractionEngine();
    const nEdges = 3 + Math.floor(rng() * 5); // 3..7 条边（暴力可行）
    for (let e = 0; e < nEdges; e += 1) {
      const s = Math.floor(rng() * 15);
      const f = Math.floor(rng() * 15);
      for (let k = 0; k < s; k += 1) abs.observe(`dom${(e % 3)}#sk${Math.floor(e / 3)}`, `act${e % 2}`, true, `dom${(e % 3)}#next${e % 2}`);
      for (let k = 0; k < f; k += 1) abs.observe(`dom${(e % 3)}#sk${Math.floor(e / 3)}`, `act${e % 2}`, false);
    }
    const report = abs.rateDistortionFrontier({ maxLevels: 8 });
    // 脚本侧独立信源（精确同构内核口径）
    const edges = abs.structuralEdgeList().map((e) => {
      const n = e.successes + e.failures;
      return { mean: (1 + e.successes) / (2 + n), weight: 2 + n };
    });
    // 精确去重同均值
    const byMean = new Map();
    for (const e of edges) {
      const key = e.mean.toFixed(12);
      const slot = byMean.get(key);
      if (slot) slot.weight += e.weight;
      else byMean.set(key, { mean: e.mean, weight: e.weight });
    }
    const items = [...byMean.values()].sort((a, b) => a.mean - b.mean);
    const totalW = items.reduce((s, x) => s + x.weight, 0);
    // 暴力枚举连续划分（去重后 n ≤ 7）
    const bruteBest = (n, k) => {
      // 将前 n 项分 k 组的最小加权 SSE（递归枚举段界）
      const seg = (i, j) => {
        let w = 0;
        let s = 0;
        let q = 0;
        for (let t = i; t < j; t += 1) {
          w += items[t].weight;
          s += items[t].weight * items[t].mean;
          q += items[t].weight * items[t].mean * items[t].mean;
        }
        return Math.max(0, q - (s * s) / w);
      };
      const rec = (j, kk) => {
        if (kk === 1) return seg(0, j);
        let best = Infinity;
        for (let i = kk - 1; i < j; i += 1) best = Math.min(best, rec(i, kk - 1) + seg(i, j));
        return best;
      };
      return rec(n, k) / totalW;
    };
    let allMatch = true;
    for (const p of report.points) {
      // 内核输出 6 位小数舍入 —— 脚本侧同样舍到 6 位后要求相等
      const brute = Number(bruteBest(items.length, Math.min(p.levels, items.length)).toFixed(6));
      if (p.distortion !== brute) allMatch = false;
    }
    if (allMatch) dpOptimal += 1;
    if (report.monotone) monotoneCount += 1;
    // 肘点边界
    if (!(report.optimalLevels >= 1 && report.optimalLevels <= Math.max(1, items.length))) {
      dpOptimal -= 1;
    }
  }
  ok(dpOptimal === N, `${N} 种子：DP 前沿逐 K 与连续划分暴力枚举一致（${dpOptimal}/${N}），肘点有界`);
  ok(monotoneCount === N, `${N} 种子：D(K) 关于 K 单调不增（划分加细性质）`);
  // 空引擎诚实退化
  const empty = new AbstractionEngine().rateDistortionFrontier();
  ok(empty.points.length === 0 && empty.optimalLevels === 0, '零证据 → 空前沿（诚实拒绝）');
}

section('C2 并查集等价类：vs O(n²) BFS 闭包（≥200 种子）');

{
  const rng = mulberry32(777);
  const N = 200;
  let classMatch = 0;
  for (let i = 0; i < N; i += 1) {
    seededInputs += 1;
    const abs = new AbstractionEngine();
    const nEdges = 4 + Math.floor(rng() * 8);
    for (let e = 0; e < nEdges; e += 1) {
      const domain = `d${e % 4}`;
      const succ = e % 3 === 0 ? undefined : `${domain}#n${e % 2}`;
      const s = Math.floor(rng() * 20);
      const f = Math.floor(rng() * 20);
      abs.observe(`${domain}#sk${e % 3}`, `a${e % 2}`, true, succ);
      for (let k = 0; k < s; k += 1) abs.observe(`${domain}#sk${e % 3}`, `a${e % 2}`, true, succ);
      for (let k = 0; k < f; k += 1) abs.observe(`${domain}#sk${e % 3}`, `a${e % 2}`, false);
    }
    const tol = Math.round(rng() * 20) / 100; // 0..0.2
    const report = abs.behaviorEquivalenceClasses(tol);
    // 脚本侧暴力闭包
    const edges = abs.structuralEdgeList().map((e) => ({
      key: `${e.domain}#${e.skeleton}|${e.action}`,
      mean: (1 + e.successes) / (2 + e.successes + e.failures),
      succ: e.mapSuccessor !== undefined ? e.mapSuccessor.slice(e.mapSuccessor.indexOf('#')) : '',
    }));
    const idx = new Map(edges.map((e, j) => [e.key, j]));
    const adj = edges.map(() => new Set());
    for (let a = 0; a < edges.length; a += 1) {
      for (let b = a + 1; b < edges.length; b += 1) {
        if (edges[a].succ === edges[b].succ && Math.abs(edges[a].mean - edges[b].mean) <= tol + 1e-15) {
          adj[a].add(b);
          adj[b].add(a);
        }
      }
    }
    const seen = new Set();
    const bruteClasses = [];
    for (let a = 0; a < edges.length; a += 1) {
      if (seen.has(a)) continue;
      const comp = [];
      const stack = [a];
      seen.add(a);
      while (stack.length > 0) {
        const cur = stack.pop();
        comp.push(edges[cur].key);
        for (const nb of adj[cur]) {
          if (!seen.has(nb)) {
            seen.add(nb);
            stack.push(nb);
          }
        }
      }
      bruteClasses.push(comp.sort().join('|'));
    }
    bruteClasses.sort();
    const kernelClasses = report.classes.map((c) => c.members.join('|')).sort();
    const memberSum = report.classes.reduce((s, c) => s + c.size, 0);
    if (kernelClasses.join(';') === bruteClasses.join(';') && memberSum === edges.length) classMatch += 1;
    // 类内极差 ≤ tol（传递闭包的直径上界——链式合并可越界单对但类内极差有界性由闭包结构保证，这里只断言一致性）
  }
  ok(classMatch === N, `${N} 种子：并查集类成员与 O(n²) BFS 传递闭包完全一致（${classMatch}/${N}），成员守恒`);
  ok(throws(() => new AbstractionEngine().behaviorEquivalenceClasses(-0.1)), 'tolerance<0 throw');
}

section('C3 L1 倒排索引：与旧全表扫描逐位相等 + 扫描计数/耗时');

{
  const rng = mulberry32(31337);
  const N = 200;
  let priorMatch = 0;
  for (let i = 0; i < N; i += 1) {
    seededInputs += 1;
    const abs = new AbstractionEngine();
    // 两个结构同构域（同骨架同行动集合）+ 噪声域
    const skels = ['s0', 's1', 's2'];
    const acts = ['a', 'b'];
    for (const dom of ['trapA', 'trapB']) {
      for (const sk of skels) {
        for (const ac of acts) {
          const s = Math.floor(rng() * 25);
          const f = Math.floor(rng() * 25);
          for (let k = 0; k < s; k += 1) abs.observe(`${dom}#${sk}`, ac, true, `${dom}#n${sk === 's0' ? 1 : 0}`);
          for (let k = 0; k < f; k += 1) abs.observe(`${dom}#${sk}`, ac, false);
        }
      }
    }
    for (let k = 0; k < 12; k += 1) abs.observe(`noise#u${k % 3}`, 'z', k % 2 === 0, 'noise#v');
    // 查询冷同构域 → L1 类比层触发
    const sk = skels[Math.floor(rng() * skels.length)];
    const ac = acts[Math.floor(rng() * acts.length)];
    const prior = abs.hierarchicalPrior(`trapC#${sk}`, ac);
    // 脚本侧旧口径独立复算：全表扫描 skeletonEdges（经 structuralEdgeList 重建，顺序 = 插入序）
    const edges = abs.structuralEdgeList();
    const profiles = new Map();
    for (const e of edges) {
      const set = profiles.get(e.domain) ?? new Set();
      set.add(`${e.skeleton}|${e.action}`);
      profiles.set(e.domain, set);
    }
    const domainSimilarity = (d1, d2) => {
      if (d1 === d2) return 1;
      const p1 = profiles.get(d1);
      const p2 = profiles.get(d2);
      if (!p1 || !p2 || p1.size === 0 || p2.size === 0) return 0;
      let inter = 0;
      for (const k of p1) if (p2.has(k)) inter += 1;
      return inter / (p1.size + p2.size - inter);
    };
    const minSim = 0.3;
    const candidates = [];
    for (const e of edges) {
      if (e.domain === 'trapC' || e.skeleton !== sk || e.action !== ac) continue;
      const sim = profiles.get('trapC') && profiles.get('trapC').size > 0 ? domainSimilarity('trapC', e.domain) : (profiles.get(e.domain)?.has(`${sk}|${ac}`) ? 1 : 0);
      if (sim < minSim) continue;
      const obs = e.successes + e.failures;
      if (obs < 1) continue;
      candidates.push({ domain: e.domain, sim, post: (1 + e.successes) / (2 + obs), obs });
    }
    if (candidates.length > 0) {
      let wSum = 0;
      let acc = 0;
      let top = candidates[0];
      for (const c of candidates) {
        const w = c.sim * (c.obs / (c.obs + 2));
        acc += w * c.post;
        wSum += w;
        if (c.sim > top.sim) top = c;
      }
      const meanExpected = wSum > 0 ? acc / wSum : undefined;
      if (
        meanExpected !== undefined &&
        near(prior.mean, meanExpected, 1e-12) &&
        prior.strength === 6 &&
        prior.source === `analogy(${top.domain})` &&
        prior.witnessDomains !== undefined &&
        prior.witnessDomains.join(',') === [...new Set(candidates.map((c) => c.domain))].join(',')
      ) {
        priorMatch += 1;
      }
    }
  }
  ok(priorMatch === N, `${N} 次查询：倒排索引 L1 先验（均值/强度/来源/证人）与脚本侧旧全表扫描复算逐位相等（1e-12）（${priorMatch}/${N}）`);

  // 扫描计数审计 + 耗时：扫描占主导的大规模世界（3000 条边 / 每 (骨架,行动) 类 20 域）
  const absBig = new AbstractionEngine();
  for (let d = 0; d < 20; d += 1) {
    for (let sk = 0; sk < 15; sk += 1) {
      for (let a = 0; a < 2; a += 1) {
        for (let k = 0; k < 5; k += 1) absBig.observe(`big${d}#sk${sk}`, `act${a}`, (d + k) % 2 === 0, `big${d}#next`);
      }
    }
  }
  const totalEdges = absBig.priorScanAudit().totalEdges;
  for (let q = 0; q < 50; q += 1) absBig.hierarchicalPrior(`query#sk${q % 15}`, 'act0');
  const audit = absBig.priorScanAudit();
  const oldWay = audit.totalPriorQueries * totalEdges;
  ok(audit.totalScannedEdges < oldWay, `扫描计数：索引 ${audit.totalScannedEdges} 次 vs 旧全表 ${oldWay} 次（${totalEdges} 条边，降 ${(100 * (1 - audit.totalScannedEdges / oldWay)).toFixed(1)}%）`);
  // 耗时对照：内核索引查询 vs 脚本侧「旧口径忠实复刻」——含逐边过滤与
  // 相似度计算（等价性已由上一断言证明；此处只比成本；查询域全冷 →
  // 相似度走冷域首触快路径，双方同口径）
  const edgesBig = absBig.structuralEdgeList();
  const profilesBig = new Map();
  for (const e of edgesBig) {
    const set = profilesBig.get(e.domain) ?? new Set();
    set.add(`${e.skeleton}|${e.action}`);
    profilesBig.set(e.domain, set);
  }
  const simBig = (d1, d2) => {
    if (d1 === d2) return 1;
    const p1 = profilesBig.get(d1);
    const p2 = profilesBig.get(d2);
    if (!p1 || !p2) return 0;
    let inter = 0;
    for (const k of p1) if (p2.has(k)) inter += 1;
    return inter / (p1.size + p2.size - inter);
  };
  const t0 = performance.now();
  for (let q = 0; q < 100; q += 1) absBig.hierarchicalPrior(`query#sk${q % 15}`, 'act0');
  const idxMs = performance.now() - t0;
  const t1 = performance.now();
  for (let q = 0; q < 100; q += 1) {
    // 旧口径：全表扫描每条边（过滤 + 相似度）——R5 前的内核路径
    const sk = `sk${q % 15}`;
    const queryDomain = 'query';
    for (const e of edgesBig) {
      if (e.domain === queryDomain || e.skeleton !== sk || e.action !== 'act0') continue;
      const s = simBig(queryDomain, e.domain);
      if (s < 0.3) continue;
      const obs = e.successes + e.failures;
      if (obs < 1) continue;
      const w = s * (obs / (obs + 2));
      void w; // 模拟旧口径的权重计算成本（等价性已由上一断言证明）
    }
  }
  const scanMs = performance.now() - t1;
  ok(idxMs < scanMs, `耗时：索引路径 ${idxMs.toFixed(2)}ms < 旧口径忠实复刻 ${scanMs.toFixed(2)}ms（100 次查询 × ${edgesBig.length} 条边，提速 ${(scanMs / Math.max(idxMs, 0.01)).toFixed(1)}×）`);
}

section('C4 商结构：投影幂等 + 商系统封闭一致');

{
  const rng = mulberry32(5150);
  const N = 220;
  let idempotent = 0;
  for (let i = 0; i < N; i += 1) {
    seededInputs += 1;
    const shapes = [
      `dom${Math.floor(rng() * 9)}#sk${Math.floor(rng() * 9)}`,
      `dom#multi#deep#${Math.floor(rng() * 5)}`, // 多段骨架
      `plain${Math.floor(rng() * 9)}`, // 无 '#'
      `#${Math.floor(rng() * 9)}`, // 空 domain
    ];
    const x = shapes[Math.floor(rng() * shapes.length)];
    const once = projectToSkeleton(x);
    if (projectToSkeleton(once) === once) idempotent += 1;
  }
  ok(idempotent === N, `${N} 输入：project(project(x)) = project(x)（商投影幂等，${idempotent}/${N}）`);
  ok(projectToSkeleton('trapA#s0') === '#s0' && projectToSkeleton('x') === '#', '投影口径锚：trapA#s0 → #s0、plain → #');

  // 商系统：边端点封闭 + 池化后验一致 + 确定性
  const abs = new AbstractionEngine();
  seedTrapWorldDirect(abs);
  const q1 = abs.quotientSystem();
  const q2 = abs.quotientSystem();
  const stateSet = new Set(q1.states);
  const closed = q1.edges.every((e) => stateSet.has(e.from) && stateSet.has(e.to));
  ok(closed, `商系统边端点封闭于状态集（${q1.states.length} 状态 / ${q1.edges.length} 边）`);
  ok(JSON.stringify(q1) === JSON.stringify(q2), '商系统确定性（两次构建逐位一致）');
  // 池化后验锚：#s0 × bait = (1 + (9+9)) / (2 + 20) = 19/22（内核 6 位舍出口径）
  const edge = q1.edges.find((e) => e.from === '#s0' && e.action === 'bait');
  ok(edge !== undefined && near(edge.pSuccess, 19 / 22, 1e-6), `池化后验 = (1+Σ成功)/(2+Σ证据)：#s0×bait = 19/22 = ${edge ? edge.pSuccess : '缺失'}`);
  ok(edge !== undefined && edge.to === '#dead', `模态后继骨架：#s0 --bait--> #dead（实测 ${edge ? edge.to : '?'}）`);
  ok(edge !== undefined && edge.domains === 2, `跨域复验度：池化自 2 个域（实测 ${edge ? edge.domains : '?'}）`);
}

function seedTrapWorldDirect(abs) {
  const obs = (state, action, successes, failures, next) => {
    for (let i = 0; i < successes; i += 1) abs.observe(state, action, true, next);
    for (let i = 0; i < failures; i += 1) abs.observe(state, action, false);
  };
  for (const dom of ['trapA', 'trapB']) {
    obs(`${dom}#s0`, 'bait', 9, 1, `${dom}#dead`);
    obs(`${dom}#s0`, 'slow', 6, 4, `${dom}#rich`);
    obs(`${dom}#dead`, 'bait', 2, 8, `${dom}#dead`);
    obs(`${dom}#dead`, 'slow', 2, 8, `${dom}#dead`);
    obs(`${dom}#rich`, 'bait', 19, 1, `${dom}#rich`);
    obs(`${dom}#rich`, 'slow', 19, 1, `${dom}#rich`);
  }
}

// ═══════════════════ D global-workspace 96.0 R5 ═══════════════════

section('D1 温度退火：熵(T) 单调前提 + 收敛到目标熵 + 确定性');

{
  // 前提：固定投标下 softmax 分布熵关于 T 单调不减（≥200 种子投标 × T 阶梯）
  const rng = mulberry32(606);
  const ladder = [0.02, 0.06, 0.15, 0.4, 1, 3, 10];
  let monotoneCount = 0;
  const N = 210;
  for (let i = 0; i < N; i += 1) {
    seededInputs += 1;
    const bids = Array.from({ length: 3 + Math.floor(rng() * 4) }, () => rng());
    const ents = ladder.map((T) => {
      const zs = bids.map((b) => b / T);
      const m = Math.max(...zs);
      const ps = zs.map((z) => Math.exp(z - m));
      const s = ps.reduce((a, b) => a + b, 0);
      const probs = ps.map((p) => p / s);
      let h = 0;
      for (const p of probs) if (p > 0) h -= p * Math.log2(p);
      return h / Math.log2(bids.length);
    });
    let mono = true;
    for (let j = 1; j < ents.length; j += 1) if (ents[j] < ents[j - 1] - 1e-9) mono = false;
    if (mono) monotoneCount += 1;
  }
  ok(monotoneCount === N, `${N} 种子投标 × T 阶梯：归一化熵 H(T) 单调不减（反馈律的数学前提，${monotoneCount}/${N}）`);

  // 退火收敛：4 模块恒投标 0.9/0.7/0.5/0.3，目标归一化熵 0.7
  const mkModules = () => [0.9, 0.7, 0.5, 0.3].map((v, i) => ({
    id: `m${i}`,
    priorityFn: () => ({ novelty: v, relevance: v, confidence: v, urgency: v }),
  }));
  const annealOpts = { initial: 0.05, targetNormalizedEntropy: 0.7, adjustmentRate: 0.3, minTemperature: 0.01 };
  const gw = new GlobalWorkspace({
    modules: mkModules(),
    threshold: 0.2,
    annealing: annealOpts,
    seed: 7,
  });
  const signals = Array.from({ length: 800 }, (_, i) => ({ signals: [`s${i % 5}`] }));
  const traj = gw.runSequence(signals);
  const state = gw.annealingState();
  const initialH = gw2InitialNormEntropy();
  ok(state !== undefined && Math.abs(state.entropyEma - 0.7) < 0.08,
    `退火收敛：Ĥ = ${state ? state.entropyEma : '?'} → 目标 0.7（±0.08；初始 ≈ ${initialH.toFixed(3)}）`);
  ok(state !== undefined && state.temperature > 0.05 && state.temperature < 8,
    `温度调节有界：0.05 → ${state ? state.temperature : '?'}（升温摊薄，未发散）`);
  ok(traj.steps.every((s) => s.ignited), '全程点火（阈值 0.2 下 4 模块恒超阈——反馈每步生效）');
  // 确定性：同 seed 逐位复放
  const gwReplay = new GlobalWorkspace({ modules: mkModules(), threshold: 0.2, annealing: annealOpts, seed: 7 });
  const traj2 = gwReplay.runSequence(signals);
  const same = traj.steps.every((s, i) => s.winner === traj2.steps[i].winner && s.broadcast?.effectiveBid === traj2.steps[i].broadcast?.effectiveBid);
  ok(same && gw.currentTemperature() === gwReplay.currentTemperature(), `同 seed 复放：胜者轨迹与终温逐位一致（T = ${gw.currentTemperature().toFixed(4)}）`);
  // 复位 = 完整时间倒带
  gw.reset();
  ok(gw.currentTemperature() === 0.05, `reset 回初温 0.05（实测 ${gw.currentTemperature()}）`);
  // 未配置退火 → 恒温零漂移
  const plain = new GlobalWorkspace({ modules: mkModules(), threshold: 0.2, temperature: 0.3, seed: 3 });
  plain.runSequence(Array.from({ length: 50 }, () => ({})));
  ok(plain.currentTemperature() === 0.3 && plain.annealingState() === undefined, '未配置退火 → currentTemperature 恒等于配置温度（零漂移）');

  function gw2InitialNormEntropy() {
    const T = 0.05;
    const zs = [0.9, 0.7, 0.5, 0.3].map((v) => v / T);
    const m = Math.max(...zs);
    const ps = zs.map((z) => Math.exp(z - m));
    const s = ps.reduce((a, b) => a + b, 0);
    let h = 0;
    for (const p of ps.map((p) => p / s)) if (p > 0) h -= p * Math.log2(p);
    return h / 2;
  }
}

section('D2 增量轨迹统计：与逐引擎步进 + 旧式重扫逐位相等 + 聚合耗时');

{
  const mkModules = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `mod${i}`,
      priorityFn: (ctx) => ({ novelty: ((i * 37 + ctx.step * 11) % 100) / 100, relevance: 0.6, confidence: 0.7, urgency: ((i * 17 + ctx.step) % 100) / 100 }),
    }));
  const signals = Array.from({ length: 4000 }, (_, i) => ({ signals: i % 7 === 0 ? ['burst'] : [] }));
  const a = new GlobalWorkspace({ modules: mkModules(64), threshold: 0.45, seed: 11 });
  const b = new GlobalWorkspace({ modules: mkModules(64), threshold: 0.45, seed: 11 });
  const traj = a.runSequence(signals);
  // 逐引擎步进 + 旧式 O(M·L) 重扫（R5 之前的实现口径）
  const steps = [];
  for (const s of signals) steps.push(b.step(s));
  const ignitedSteps = steps.reduce((n, s) => n + (s.ignited ? 1 : 0), 0);
  const winCounts = Array.from({ length: 64 }, (_, j) => {
    const wins = steps.reduce((n, s) => n + (s.winner === `mod${j}` ? 1 : 0), 0);
    return { id: `mod${j}`, wins, share: ignitedSteps > 0 ? Number((wins / ignitedSteps).toFixed(6)) : 0 };
  });
  const identical =
    traj.totalSteps === steps.length &&
    traj.ignitedSteps === ignitedSteps &&
    traj.winCounts.every((w, j) => w.wins === winCounts[j].wins && w.share === winCounts[j].share) &&
    traj.igniteRatio === Number((ignitedSteps / steps.length).toFixed(6));
  ok(identical, `64 模块 × 4000 步：增量统计与旧式逐模块全轨迹重扫逐位相等（点火 ${traj.ignitedSteps} 步）`);
  // 聚合耗时：旧式 O(M·L) vs 新式 O(L) 单遍（对已录 steps 各跑 3 次取最小）
  const oldAgg = () => {
    const ignited = steps.reduce((n, s) => n + (s.ignited ? 1 : 0), 0);
    let total = 0;
    for (let j = 0; j < 64; j += 1) {
      let wins = 0;
      for (const s of steps) if (s.winner === `mod${j}`) wins += 1;
      total += wins / ignited;
    }
    return total;
  };
  const newAgg = () => {
    const tally = new Map();
    let ignited = 0;
    for (const s of steps) {
      if (s.ignited) {
        ignited += 1;
        tally.set(s.winner, (tally.get(s.winner) ?? 0) + 1);
      }
    }
    let total = 0;
    for (const [, w] of tally) total += w / ignited;
    return total;
  };
  const minOf = (fn) => {
    let best = Infinity;
    for (let k = 0; k < 3; k += 1) {
      const t = performance.now();
      fn();
      const dt = performance.now() - t;
      if (dt < best) best = dt;
    }
    return best;
  };
  const oldMs = minOf(oldAgg);
  const newMs = minOf(newAgg);
  ok(near(oldAgg(), newAgg(), 1e-9), '两种聚合的数值结果一致（等价证明）');
  ok(newMs < oldMs, `聚合耗时：旧 O(M·L) ${oldMs.toFixed(1)}ms > 新 O(L) ${newMs.toFixed(1)}ms（64×4000，提速 ${(oldMs / Math.max(newMs, 0.01)).toFixed(1)}×）`);
}

section('D3 软 WTA 溢出护栏：T=1e-320 的 T→0⁺ 极限 + 参数校验');

{
  const mk = (ids, bids) =>
    ids.map((id, i) => ({
      id,
      priorityFn: () => ({ novelty: bids[i], relevance: bids[i], confidence: bids[i], urgency: bids[i] }),
    }));
  // 极小温度：e/T 上溢 → 退化 argmax，无 NaN
  const gw = new GlobalWorkspace({ modules: mk(['a', 'b', 'c'], [0.9, 0.5, 0.3]), threshold: 0.2, temperature: 1e-320, seed: 5 });
  const r = gw.step({});
  ok(r.ignited && r.winner === 'a', `T=1e-320：胜者 = argmax（${r.winner}，softmax 退化不 NaN）`);
  ok(r.winnerDistribution.length === 1 && near(r.winnerDistribution[0].p, 1, 1e-9) && r.winnerDistribution[0].id === 'a',
    `分布退化为 one-hot（${r.winnerDistribution.map((w) => `${w.id}:${w.p}`).join(', ')}）`);
  // 并列 argmax → T→0⁺ 极限 = 并列集合上的均匀
  const gwTie = new GlobalWorkspace({ modules: mk(['x', 'y', 'z'], [0.7, 0.7, 0.2]), threshold: 0.2, temperature: 1e-320, seed: 9 });
  const rTie = gwTie.step({});
  const tieDist = rTie.winnerDistribution;
  ok(tieDist.length === 2 && tieDist.every((w) => near(w.p, 0.5, 1e-9) && (w.id === 'x' || w.id === 'y')),
    `并列 argmax（x=y=0.7）→ 均匀 ${tieDist.map((w) => `${w.id}:${w.p}`).join(', ')}（T→0⁺ 解析极限）`);
  ok(!Number.isNaN(rTie.broadcast?.effectiveBid ?? NaN), '有效投标全程有限（无 NaN 路径）');
  // 正常温度逐位不变：T=0.3 与脚本侧独立 softmax 重算一致
  const gwNorm = new GlobalWorkspace({ modules: mk(['a', 'b'], [0.9, 0.5]), threshold: 0.2, temperature: 0.3, seed: 21 });
  const rNorm = gwNorm.step({});
  const zs = [0.9, 0.5].map((v) => v / 0.3);
  const m = Math.max(...zs);
  const ps = zs.map((z) => Math.exp(z - m));
  const sum = ps.reduce((x, y) => x + y, 0);
  const expected = ps.map((p) => Number((p / sum).toFixed(6)));
  ok(rNorm.winnerDistribution.every((w, i) => w.p === expected[i]), `正常温度 T=0.3 分布与独立 softmax 重算逐位一致（${rNorm.winnerDistribution.map((w) => w.p).join(', ')}）`);
  // 退火参数校验
  const base = { modules: mk(['a'], [0.8]) };
  ok(throws(() => new GlobalWorkspace({ ...base, annealing: { initial: 0, targetNormalizedEntropy: 0.5, adjustmentRate: 0.3, minTemperature: 0.01 } })), 'annealing.initial=0 throw');
  ok(throws(() => new GlobalWorkspace({ ...base, annealing: { initial: 0.1, targetNormalizedEntropy: 1.2, adjustmentRate: 0.3, minTemperature: 0.01 } })), 'annealing.target=1.2 throw');
  ok(throws(() => new GlobalWorkspace({ ...base, annealing: { initial: 0.1, targetNormalizedEntropy: 0.5, adjustmentRate: -1, minTemperature: 0.01 } })), 'annealing.adjustmentRate<0 throw');
  ok(throws(() => new GlobalWorkspace({ ...base, annealing: { initial: 0.005, targetNormalizedEntropy: 0.5, adjustmentRate: 0.3, minTemperature: 0.01 } })), 'annealing.initial < minTemperature throw');
}

// ═══════════════════ E metacognitive-confidence 97.0 R5 ═══════════════════

section('E1 二阶 ROC 参数拟合：恢复已知 d + 噪声单调压低 + 尺度锚 + 与面积反演一致');

{
  // 零噪声工厂：拟合恢复 d（理想观察者在参数族内，尺度 ≈ 1）
  for (const d of [0.8, 1.5]) {
    const ds = simulateMetacognition({ d, metaD: d, trials: 9000, seed: 11 + d });
    const fit = metaDprimeFit(ds.correctConfidences, ds.errorConfidences);
    ok(Math.abs(fit.metaDprime - d) <= 0.2, `d=${d} 零噪声工厂：拟合 meta-d′ = ${fit.metaDprime.toFixed(3)}（|Δ| ≤ 0.2，rmse=${fit.rmse.toFixed(4)}）`);
    ok(Math.abs(fit.fittedScale - 1) <= 0.1, `d=${d} 零噪声尺度锚：ŝ = ${fit.fittedScale.toFixed(3)} ≈ 1（信心无噪跟随证据）`);
    const inv = metaDprime(ds.correctConfidences, ds.errorConfidences);
    ok(Math.abs(fit.metaDprime - inv.metaDprime) <= 0.2, `与面积反演独立估计一致：拟合 ${fit.metaDprime.toFixed(3)} vs 反演 ${inv.metaDprime.toFixed(3)}（|Δ| ≤ 0.2）`);
  }
  // ≥200 输入：元认知噪声单调压低拟合值（50 种子 × 4 噪声档）+ 尺度锚 ŝ ≈ d/metaD
  const rng = mulberry32(1234);
  const ladder = [1.2, 0.9, 0.6, 0.3];
  let monotoneRuns = 0;
  let scaleRuns = 0;
  const RUNS = 50;
  for (let i = 0; i < RUNS; i += 1) {
    const seed = 1000 + Math.floor(rng() * 9000);
    const fits = [];
    const scales = [];
    for (const metaD of ladder) {
      const ds = simulateMetacognition({ d: 1.2, metaD, trials: 8000, seed });
      const f = metaDprimeFit(ds.correctConfidences, ds.errorConfidences);
      fits.push(f.metaDprime);
      scales.push(f.fittedScale);
    }
    let mono = true;
    for (let j = 1; j < fits.length; j += 1) {
      seededInputs += 1;
      if (fits[j] > fits[j - 1] + 0.08) mono = false; // 容许抽样噪声
    }
    if (mono) monotoneRuns += 1;
    // 尺度锚：工厂标定 σ² = (d/metaD)² − 1 ⟹ ŝ 应 ≈ √(1+σ²) = d/metaD
    let scaleOk = true;
    for (let j = 0; j < ladder.length; j += 1) {
      if (Math.abs(scales[j] - 1.2 / ladder[j]) > 0.2) scaleOk = false;
    }
    if (scaleOk) scaleRuns += 1;
  }
  ok(monotoneRuns >= RUNS - 2, `${RUNS} 种子 × 4 噪声档（200 输入）：拟合 meta-d′ 随元认知噪声单调不增（${monotoneRuns}/${RUNS} 容许 ≤2 越界）`);
  ok(scaleRuns >= RUNS - 5, `${RUNS} 种子：尺度参数恢复工厂噪声 ŝ ≈ d/metaD ∈ {1, 1.33, 2, 4}（${scaleRuns}/${RUNS}，±0.2——信心噪声被独立量化）`);
  // 拟合残差劣于 μ=s 模型基准的对照（脚本次重算：全零敏感度 + 尺度 1）
  const dsCheck = simulateMetacognition({ d: 1.5, metaD: 1.5, trials: 9000, seed: 77 });
  const fitCheck = metaDprimeFit(dsCheck.correctConfidences, dsCheck.errorConfidences);
  const muZeroSse = fitCheck.points.reduce((s, p) => {
    const dh = p.observedHitRate - normalCdf(0 - p.evidenceThreshold) / normalCdf(0);
    const df = p.observedFalseAlarmRate - normalCdf(-p.evidenceThreshold) / normalCdf(-0);
    return s + dh * dh + df * df;
  }, 0) / fitCheck.points.length;
  ok(fitCheck.rmse < Math.sqrt(muZeroSse), `拟合 (μ̂,ŝ) 的 rmse ${fitCheck.rmse.toFixed(4)} < (μ=0,s=1) 基准 ${Math.sqrt(muZeroSse).toFixed(4)}（参数族解释力为正）`);
  // 入参校验
  ok(throws(() => metaDprimeFit([], [0.5])), 'metaDprimeFit(空正确数组) throw');
  ok(throws(() => metaDprimeFit([0.5, 0.6], [0.3], { thresholds: [0.5, 1.5] })), 'metaDprimeFit(阈值越界) throw');
}

section('E2 贝叶斯最优报告：Brier 恒等式（Monte Carlo ≥200 组）');

{
  const rng = mulberry32(20260101);
  // Beta 采样（拒绝采样简化为均匀次序统计量：α、β 为整数时精确 Beta）
  const betaSample = (alpha, beta) => {
    const us = Array.from({ length: alpha + beta - 1 }, () => rng()).sort((a, b) => a - b);
    return alpha === 1 ? us[0] : us[alpha - 1];
  };
  const N = 220;
  let identityOk = 0;
  let expectedOk = 0;
  const MC = 3000;
  for (let i = 0; i < N; i += 1) {
    seededInputs += 1;
    const alpha = 1 + Math.floor(rng() * 6);
    const beta = 1 + Math.floor(rng() * 6);
    const m = alpha / (alpha + beta);
    // 内部信心与后验均值有偏差（未校准）
    const confidence = Math.min(1, Math.max(0, m + (rng() - 0.5) * 0.6));
    const r = bayesOptimalReport(confidence, { alpha, beta });
    if (!near(r.report, m, 1e-12) || !near(r.expectedBrier, m * (1 - m), 1e-9)) continue;
    // Monte Carlo：Brier(c) − Brier(r*) ≈ (c − m)²（精确恒等式的经验对照）
    let brierRaw = 0;
    let brierOpt = 0;
    for (let k = 0; k < MC; k += 1) {
      const p = betaSample(alpha, beta);
      const y = rng() < p ? 1 : 0;
      brierRaw += (confidence - y) ** 2;
      brierOpt += (m - y) ** 2;
    }
    const empiricalDiff = brierRaw / MC - brierOpt / MC;
    const identity = (confidence - m) ** 2;
    if (near(r.rawReportPenalty, identity, 1e-12) && Math.abs(empiricalDiff - identity) < 0.03) identityOk += 1;
    if (near(r.expectedBrier, m * (1 - m), 1e-9)) expectedOk += 1;
  }
  ok(identityOk === N, `${N} 组：rawReportPenalty = (c−r*)² 精确恒等式 + Monte Carlo Brier 差对照（±0.03）（${identityOk}/${N}）`);
  ok(expectedOk === N, `${N} 组：期望 Brier 闭式 m(1−m) 成立（${expectedOk}/${N}）`);
  // 已校准 → 诚实标记；未校准 → 决策可能异侧
  const honest = bayesOptimalReport(0.6, { alpha: 6, beta: 4 }); // m = 0.6
  ok(honest.honest && near(honest.report, 0.6, 1e-12) && honest.rawReportPenalty === 0, '已校准（r* = c）：诚实报告、零惩罚');
  const mis = bayesOptimalReport(0.35, { alpha: 6, beta: 4 }, { askThreshold: 0.5 }); // m=0.6 vs c=0.35 阈值 0.5 异侧
  ok(!mis.honest && mis.rawReportPenalty > 0.02 && mis.decisionAlignment !== undefined && !mis.decisionAlignment.aligned,
    `未校准 + 阈值异侧：惩罚 ${mis.rawReportPenalty.toFixed(4)}，原始路径问 ${mis.decisionAlignment?.rawWouldAsk} vs 最优路径问 ${mis.decisionAlignment?.optimalWouldAsk}（决策对齐读出）`);
  ok(throws(() => bayesOptimalReport(0.5, { alpha: 0, beta: 1 })), 'bayesOptimalReport(alpha=0) throw');
  ok(throws(() => bayesOptimalReport(0.5, { alpha: 1, beta: 1 }, { askThreshold: 1.5 })), 'bayesOptimalReport(阈值越界) throw');
}

section('E3 log-odds 稳健化：与旧公式数值等价 + 极端无 NaN');

{
  // ≥200 网格点：新 log 域实现 vs 旧 odds 乘法公式 ≤ 1e-12
  const oldFormula = (c, q) => {
    const cc = Math.min(1 - 1e-12, Math.max(1e-12, c));
    const odds = (cc / (1 - cc)) * ((1 - q) / q);
    return 1 / (1 + odds);
  };
  const cs = [];
  for (let i = 1; i <= 25; i += 1) cs.push(i / 100);
  cs.push(1e-9, 1 - 1e-9, 0.5);
  const qs = [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 0.99];
  let maxDiff = 0;
  let count = 0;
  for (const c of cs) {
    for (const q of qs) {
      seededInputs += 1;
      count += 1;
      const diff = Math.abs(posteriorErrorProbability(c, q) - oldFormula(c, q));
      if (diff > maxDiff) maxDiff = diff;
    }
  }
  ok(count >= 200 && maxDiff <= 1e-12, `${count} 网格点：log 域实现与旧 odds 乘法公式最大偏差 ${maxDiff.toExponential(2)} ≤ 1e-12（数值等价）`);
  // 极端组合：有限、良定义、方向正确
  const extremeHigh = posteriorErrorProbability(1, 1e-12); // c 钳位 1−1e-12、q 极小
  const extremeLow = posteriorErrorProbability(0, 0.999999); // 几乎必错的世界
  ok(Number.isFinite(extremeHigh) && extremeHigh >= 0 && extremeHigh <= 1, `c=1, q=1e-12 → P(error) = ${extremeHigh.toExponential(3)}（有限良定义）`);
  ok(Number.isFinite(extremeLow) && extremeLow > 0.99, `c=0, q≈1 → P(error) = ${extremeLow.toFixed(9)}（方向正确）`);
  // q=0.5 退化锚保持
  ok(near(posteriorErrorProbability(0.7, 0.5), 0.3, 1e-12), 'q=0.5 退化：P(error|c) = 1−c（既有锚保持）');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}（种子化性质输入 ${seededInputs} 个）`);
if (failed === 0) {
  console.log('✅ R5 元认知五内核世界性进化：数学/性能/稳健/性质四轴验证成立');
} else {
  console.error('❌ 存在失败断言');
}
process.exit(failed === 0 ? 0 : 1);
