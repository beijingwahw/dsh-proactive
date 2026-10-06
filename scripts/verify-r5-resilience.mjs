/**
 * verify-r5-resilience.mjs — R5「全部内核世界性进化」三弹性自主内核验证
 * （resilience 4.0→4.1 / interruptible-autonomy 95.0→95.1 / self-boundary 100.0→100.1）
 *
 * 验证口径（不是「能跑」，是「算得对」——每个断言有解析锚点、独立重算
 * 对照或 ≥200 随机输入的性质测试；随机处全部走 mulberry32 种子化，确定性
 * 可复现；耗时对照用 performance.now() 只在脚本侧计时，内核零时钟）:
 *
 *   A resilience 4.1（Weibull/更新过程可用性 + 弹性预算）
 *     A1 Weibull 解析锚点: S(λ)=e^{−1}；k=1 指数退化（S=exp(−t/λ)、均值=λ、
 *        CV=1）；k=2 均值=λ√π/2、方差=λ²(1−π/4)；Γ(0.5)=√π、Γ(5)=24；
 *        k=1 危险率常数、k=3 单调增；log 域生存函数在 S 下溢处保幅值
 *     A2 病态预警 + log 域可用性: 条件数 |ln(t/λ)|·(t/λ)^k > 1e12 预警；
 *        CV 退化预警；ρ=1e-12 时朴素 1−A 相对误差 ~1e-4 vs log 域 ~1e-15；
 *        A+Q=1 守恒；200 随机速率的界限与单调性
 *     A3 系统可用性闭式: 串行=∏、并联=1−∏(1−a)、异质 k-of-n 与脚本侧
 *        2^n 子集枚举精确一致；拓扑自洽（serial=k-of-n(k=n)）；200 随机
 *        组分的界限 + 串行单调降/并联单调升 + k 单调不增
 *     A4 闭式 vs 蒙特卡洛: 8 组件 20 万试验，|MC−闭式| < 3σ + 耗时对照
 *     A5 弹性预算: 冗余/修复增益闭式交叉点 q*=1/2（99 点扫描 + 精确相等）；
 *        杠杆序列引理（200 随机 × 穷举 2^m）；贪心分配 = 组分穷举最优
 *        （50 实例精确一致）；200 随机实例的守恒与杠杆公式
 *   B interruptible-autonomy 95.1（多源中断组合 + 向量化扫描）
 *     B1 optimalQ 与脚本侧独立值迭代一致 + 奖励链解析锚点 V*(0)=γ⁴/(1−γ)
 *     B2 多源组合: union 触发 + max-penalty 碰撞裁决（最优顺序）+
 *        penalty 最坏口径；组合不变性——2³−1=7 个非空子集 × 5 种子，
 *        off-policy 修正全部收敛到同一 Q*（<1e-2），无修正全部偏置（>0.5）
 *     B3 向量化阈值扫描: 交接次数与 simulateHandoff 逐位一致；与脚本侧
 *        共享抽签朴素重放一致（<1e-9）；单调不增；100 种子期望口径
 *        双估计一致（≈解析 111.0）；240 阈值 × 6000 步耗时对照
 *     B4 收敛保证（210 次 = 7 子集 × 30 种子）: 修正全收敛、无修正全偏置；
 *        收敛速率阶梯（修正严格降 / 无修正平台期）
 *   C self-boundary 100.1（多步因果链 + 他者模型 + 增量偶然性）
 *     C1 增量偶然性: 6 个检查点 delayCurve 与 contingencyScore 批量口径
 *        逐位一致；16384 步增量 vs 128 次批量重扫耗时对照
 *     C2 多步归因: 自致链 → transmitted-self（chainDelay=总延迟精确）；
 *        外源链 → mediated-external（不揽功）；直接通道 → direct-self；
 *        30+30+30 种子；数据处理不等式沿链单调（40 种子均值）
 *     C3 他者模型: mirror/counter/independent-agent/environment 四类
 *        120 种子全对（意图方向 ±0.8 级相关）；对称注入鲁棒——角色对调
 *        120/120 零误报（时间方向由时间戳说话）
 *     D 入参校验（显式 throw）
 *
 * 运行：node --experimental-transform-types scripts/verify-r5-resilience.mjs
 */

import { register } from 'node:module';
import {
  makeRewardChain,
  makePiecewiseHandoffWorld,
  interruptedQLearning,
  simulateHandoff,
  optimalQ,
  composeInterruptSchedules,
  handoffThresholdSweep,
} from '../src/core/interruptible-autonomy.ts';
import {
  contingencyScore,
  simulateEnv,
  IncrementalContingency,
  simulateChain,
  multiStepAttribution,
  simulateOtherAgent,
  otherAgentModel,
} from '../src/core/self-boundary.ts';

// resilience.ts 以 tsc 口径 import '../errors.js'（指向 src/errors.ts）——Node
// transform-types 不改写 .js→.ts 后缀，注册一个 node:module 解析钩子（data:
// URL 内联、仅本脚本、零第三方依赖）后动态导入；其余两内核无内部依赖直连
const HOOK_SRC = [
  "export async function resolve(specifier, context, next) {",
  "  if (specifier.endsWith('.js') && typeof context.parentURL === 'string' && context.parentURL.endsWith('.ts')) {",
  "    try { return await next(specifier.replace(/\\.js$/, '.ts'), context); } catch { /* 回退原后缀 */ }",
  "  }",
  "  return next(specifier, context);",
  "}",
].join('\n');
register('data:text/javascript,' + encodeURIComponent(HOOK_SRC));
const {
  weibullLogSurvival,
  weibullSurvival,
  weibullHazard,
  weibullMean,
  weibullVariance,
  weibullCoefficientOfVariation,
  weibullDiagnostics,
  steadyStateAvailability,
  logDomainAvailability,
  systemAvailability,
  redundancyGainLog,
  repairSpeedGainLog,
  resilienceBudget,
} = await import('../src/core/resilience.ts');

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
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, label);
}
/** mulberry32（与内核同一实现；脚本侧随机实例/蒙特卡洛/计时对照用） */
function mulberry32Local(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const now = () => performance.now();

// ═══════════════════ A resilience 4.1 ═══════════════════

section('A1 Weibull 故障过程：解析锚点（闭式对照 1e-12）');

{
  const E = Math.exp(-1);
  ok(near(weibullSurvival(7.5, { scale: 7.5, shape: 1 }), E, 1e-15) && near(weibullSurvival(2.2, { scale: 2.2, shape: 3 }), E, 1e-15),
    `S(λ) = e^{−1} = ${E.toFixed(9)}（k=1 与 k=3 双口径）`);
  // k=1 指数退化: S(t) = exp(−t/λ)、均值 = λ、CV = 1
  const lam = 7.5;
  ok(
    near(weibullSurvival(2 * lam, { scale: lam, shape: 1 }), Math.exp(-2), 1e-15) &&
      near(weibullMean({ scale: lam, shape: 1 }), lam, 1e-12) &&
      near(weibullCoefficientOfVariation({ scale: lam, shape: 1 }), 1, 1e-12),
    `k=1 指数退化: S(2λ) = e^{−2}、均值 = λ = ${weibullMean({ scale: lam, shape: 1 }).toFixed(10)}、CV = 1（指数分布恒定 CV）`,
  );
  // k=2: 均值 = λ·√π/2（Γ(1.5)）、方差 = λ²(1 − π/4)（Γ(3)=2）
  const lam2 = 3;
  const mean2 = weibullMean({ scale: lam2, shape: 2 });
  const var2 = weibullVariance({ scale: lam2, shape: 2 });
  ok(
    near(mean2, lam2 * Math.sqrt(Math.PI) / 2, 1e-12) && near(var2, lam2 * lam2 * (1 - Math.PI / 4), 1e-12),
    `k=2 闭式: 均值 = ${mean2.toFixed(9)} = λ√π/2、方差 = ${var2.toFixed(9)} = λ²(1−π/4)`,
  );
  // 危险率: k=1 常数 1/λ; k=3 单调增（耗损）
  const h1 = [0.5, 1, 2].map((m) => weibullHazard(m * lam, { scale: lam, shape: 1 }));
  const h3 = [0.5, 1, 2].map((m) => weibullHazard(m * 2, { scale: 2, shape: 3 }));
  ok(
    h1.every((h) => near(h, 1 / lam, 1e-14)) && h3[0] < h3[1] && h3[1] < h3[2],
    `危险率: k=1 常数 1/λ = ${(1 / lam).toFixed(6)}（无记忆）; k=3 严格单调增 [${h3.map((h) => h.toFixed(4)).join(' < ')}]（耗损耗效）`,
  );
  // log 域: S 下溢为 0 处 logS 保有幅值（−5^300 有限可复算）
  const logS = weibullLogSurvival(5 * 2, { scale: 2, shape: 300 });
  ok(
    weibullSurvival(5 * 2, { scale: 2, shape: 300 }) === 0 && near(logS, -Math.pow(5, 300), 1e-9 * Math.pow(5, 300)),
    `log 域生存: S(5λ, k=300) 下溢 = 0（诚实），而 ln S = ${logS.toExponential(4)} = −5^300 保有幅值（相对误差 < 1e-9）`,
  );
}

section('A2 形状参数病态预警 + log 域可用性（数值稳健性）');

{
  const bad = weibullDiagnostics(3 * 2, { scale: 2, shape: 40 }); // |ln3|·3^40 ≈ 1.3e19
  ok(
    bad.illConditioned && bad.shapeSensitivity > 1e12 && bad.warnings.length >= 1,
    `病态预警①: t=3λ, k=40 → 条件数 = ${bad.shapeSensitivity.toExponential(3)} > 1e12，触发预警（${bad.warnings.length} 条）`,
  );
  const fine = weibullDiagnostics(1.1 * 2, { scale: 2, shape: 5 }); // |ln1.1|·1.1^5 ≈ 0.154
  ok(
    !fine.illConditioned && !fine.degenerateLifetime && fine.warnings.length === 0,
    `健康参数不误伤: t=1.1λ, k=5 → 条件数 = ${fine.shapeSensitivity.toFixed(4)}，零预警`,
  );
  const deg = weibullDiagnostics(2, { scale: 2, shape: 5000 }); // CV ≈ 1.28/k ≈ 2.6e-4
  ok(
    deg.degenerateLifetime && weibullCoefficientOfVariation({ scale: 2, shape: 5000 }) < 1e-3 && !weibullCoefficientOfVariation({ scale: 2, shape: 2 }) < 1e-3,
    `病态预警②: k=5000 → CV = ${weibullCoefficientOfVariation({ scale: 2, shape: 5000 }).toExponential(2)} < 1e-3（寿命退化为定时器）; k=2 → CV = ${weibullCoefficientOfVariation({ scale: 2, shape: 2 }).toFixed(3)} 健康`,
  );

  // log 域可用性: 九个九系统 ρ = 1e-12
  const rates = { mttf: 1, mttr: 1e-12 };
  const trueQ = 1e-12 / (1 + 1e-12);
  const naiveQ = 1 - steadyStateAvailability(rates);
  const logQ = logDomainAvailability(rates);
  const logDomainQ = Math.exp(logQ.logUnavailability);
  ok(
    Math.abs(naiveQ - trueQ) / trueQ > 1e-6,
    `朴素 1−A 相对误差 = ${(Math.abs(naiveQ - trueQ) / trueQ).toExponential(2)} > 1e-6（A→1 的灾难性抵消：Q̂_naive = ${naiveQ.toPrecision(17)}）`,
  );
  ok(
    Math.abs(logDomainQ - trueQ) / trueQ < 1e-12,
    `log 域 Q = exp(ln ρ − ln1p ρ) 相对误差 = ${(Math.abs(logDomainQ - trueQ) / trueQ).toExponential(2)} < 1e-12（log1p 路径保机器精度）`,
  );
  // A 锚点 + A+Q=1 守恒 + 200 随机速率的界限与单调性
  ok(
    near(steadyStateAvailability({ mttf: 9, mttr: 1 }), 0.9, 1e-15) && near(steadyStateAvailability({ mttf: 1, mttr: 0 }), 1, 1e-15),
    '稳态可用性锚点: MTTF=9/MTTR=1 → A = 0.9（交替更新定理）; MTTR=0 → A = 1',
  );
  let conservOk = true;
  let boundOk = true;
  let monoOk = true;
  const rngA = mulberry32Local(101);
  for (let i = 0; i < 200; i += 1) {
    const mttf = 10 ** (rngA() * 6);
    const mttr = 10 ** (rngA() * 6);
    const A = steadyStateAvailability({ mttf, mttr });
    if (!(A > 0 && A < 1)) boundOk = false;
    const ld = logDomainAvailability({ mttf, mttr });
    if (Math.abs(Math.exp(ld.logAvailability) + Math.exp(ld.logUnavailability) - 1) > 1e-12) conservOk = false;
    if (!(steadyStateAvailability({ mttf: mttf * 1.01, mttr }) > A)) monoOk = false;
    if (!(steadyStateAvailability({ mttf, mttr: mttr * 1.01 }) < A)) monoOk = false;
  }
  ok(boundOk, '200 随机速率: 0 < A < 1（可用性恒有界）');
  ok(conservOk, '200 随机速率: exp(ln A) + exp(ln Q) = 1 守恒（≤ 1e-12）');
  ok(monoOk, '200 随机速率: A 随 MTTF 严格增、随 MTTR 严格减（更新过程单调性）');
}

section('A3 系统可用性闭式：串/并/异质 k-of-n（精确对照）');

{
  ok(near(systemAvailability([0.9, 0.8, 0.7], { kind: 'serial' }), 0.504, 1e-15), '串行 = ∏: 0.9×0.8×0.7 = 0.504');
  ok(near(systemAvailability([0.9, 0.8], { kind: 'parallel' }), 0.98, 1e-15), '并联 = 1−∏(1−a): 1 − 0.1×0.2 = 0.98');
  // 异质 k-of-n vs 脚本侧 2^n 子集枚举（独立口径）
  const avs = [0.9, 0.75, 0.6, 0.5];
  const subsetP = (avs) => {
    const n = avs.length;
    let atLeast2 = 0;
    for (let mask = 0; mask < 1 << n; mask += 1) {
      let p = 1;
      let up = 0;
      for (let i = 0; i < n; i += 1) {
        const bitUp = ((mask >> i) & 1) === 1;
        p *= bitUp ? avs[i] : 1 - avs[i];
        if (bitUp) up += 1;
      }
      if (up >= 2) atLeast2 += p;
    }
    return atLeast2;
  };
  const kOfN = systemAvailability(avs, { kind: 'k-of-n', k: 2 });
  ok(near(kOfN, subsetP(avs), 1e-15), `异质 2-of-4 = ${kOfN.toFixed(12)} = 2^4 子集枚举精确一致（Poisson-binomial DP 无近似）`);
  ok(
    near(systemAvailability(avs, { kind: 'k-of-n', k: 4 }), systemAvailability(avs, { kind: 'serial' }), 1e-15) &&
      near(systemAvailability(avs, { kind: 'k-of-n', k: 1 }), systemAvailability(avs, { kind: 'parallel' }), 1e-15),
    '拓扑自洽: k-of-n(k=n) = serial、k-of-n(k=1) = parallel（同一 DP 的两个端点）',
  );
  // 性质: 200 随机组分——界限 / 串行单调降 / 并联单调升 / k 单调不增
  const rngS = mulberry32Local(202);
  let boundsOk = true;
  let serialMono = true;
  let parallelMono = true;
  let kMono = true;
  for (let i = 0; i < 200; i += 1) {
    const n = 2 + Math.floor(rngS() * 5);
    const comps = Array.from({ length: n }, () => 0.01 + 0.98 * rngS());
    const serial = systemAvailability(comps, { kind: 'serial' });
    const parallel = systemAvailability(comps, { kind: 'parallel' });
    if (!(serial > 0 && serial < 1 && parallel > 0 && parallel < 1)) boundsOk = false;
    if (!(serial <= Math.min(...comps) && parallel >= Math.max(...comps))) boundsOk = false;
    const extra = 0.01 + 0.98 * rngS();
    if (!(systemAvailability([...comps, extra], { kind: 'serial' }) < serial)) serialMono = false;
    if (!(systemAvailability([...comps, extra], { kind: 'parallel' }) > parallel)) parallelMono = false;
    for (let k = 2; k <= n; k += 1) {
      if (!(systemAvailability(comps, { kind: 'k-of-n', k }) <= systemAvailability(comps, { kind: 'k-of-n', k: k - 1 }))) kMono = false;
    }
  }
  ok(boundsOk, '200 随机组分: 0 < A < 1 且 serial ≤ min(aᵢ) ≤ max(aᵢ) ≤ parallel（系统界）');
  ok(serialMono, '200 随机组分: 串行退化单调——加一组件严格降可用性（最弱环节定律）');
  ok(parallelMono && kMono, '200 随机组分: 并联冗余单调升 + k-of-n 对 k 单调不增（冗余只增不减可用性）');
}

section('A4 可用性闭式化 vs 蒙特卡洛（等价 + 耗时对照）');

{
  const comps = [0.99, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65];
  const closed = systemAvailability(comps, { kind: 'serial' });
  const N = 200_000;
  const rngM = mulberry32Local(303);
  const tMc0 = now();
  let up = 0;
  for (let trial = 0; trial < N; trial += 1) {
    let allUp = true;
    for (let i = 0; i < comps.length; i += 1) {
      if (rngM() > comps[i]) {
        allUp = false;
        break;
      }
    }
    if (allUp) up += 1;
  }
  const tMc1 = now();
  const mc = up / N;
  const sigma = Math.sqrt((closed * (1 - closed)) / N);
  // 时间到答案口径: 闭式 1 次调用 = 机器精度; MC 需 N 次试验才到 3σ
  for (let w = 0; w < 2000; w += 1) systemAvailability(comps, { kind: 'serial' }); // JIT 预热
  const tC0 = now();
  let acc = systemAvailability(comps, { kind: 'serial' });
  const tC1 = now();
  ok(
    Math.abs(mc - closed) < 3 * sigma,
    `8 组件串行: 闭式 = ${closed.toFixed(9)}，MC(${(N / 1000).toFixed(0)}k) = ${mc.toFixed(9)}，|Δ| = ${Math.abs(mc - closed).toExponential(2)} < 3σ = ${(3 * sigma).toExponential(2)}`,
  );
  const closedUs = (tC1 - tC0) * 1000;
  const mcMs = tMc1 - tMc0;
  ok(
    acc > 0 && mcMs > closedUs / 1000,
    `时间到答案: 闭式单次 ${closedUs.toFixed(1)} μs（12+ 位精确）vs 蒙特卡洛 ${(mcMs).toFixed(0)} ms / ${(N / 1000).toFixed(0)}k 试验（仅 3σ = ${(3 * sigma).toExponential(2)}）——比值 ≈ ${(mcMs / (closedUs / 1000)).toFixed(0)}×`,
  );
  // k-of-n 的 MC 对照（异质）
  const kClosed = systemAvailability(comps, { kind: 'k-of-n', k: 5 });
  const rngM2 = mulberry32Local(404);
  let hit5 = 0;
  for (let trial = 0; trial < N; trial += 1) {
    let c = 0;
    for (let i = 0; i < comps.length; i += 1) if (rngM2() < comps[i]) c += 1;
    if (c >= 5) hit5 += 1;
  }
  const kMc = hit5 / N;
  const kSigma = Math.sqrt((kClosed * (1 - kClosed)) / N);
  ok(
    Math.abs(kMc - kClosed) < 3 * kSigma,
    `异质 5-of-8: 闭式 = ${kClosed.toFixed(9)}，MC = ${kMc.toFixed(9)}，|Δ| < 3σ = ${(3 * kSigma).toExponential(2)}`,
  );
}

section('A5 弹性预算：冗余 vs 恢复速度的闭式权衡 + 贪心 = 穷举最优');

{
  // ① 交叉点 q* = 1/2: 99 点扫描
  let crossOk = true;
  for (let i = 1; i <= 99; i += 1) {
    const q = i / 100;
    const A = 1 - q;
    const gR = redundancyGainLog(A);
    const gS = repairSpeedGainLog(A);
    if (q < 0.5 && !(gR > gS)) crossOk = false;
    if (q > 0.5 && !(gS > gR)) crossOk = false;
  }
  ok(crossOk, '杠杆交叉点扫描（99 点）: q < 1/2 冗余增益占优、q > 1/2 恢复速度占优');
  ok(
    near(redundancyGainLog(0.5), repairSpeedGainLog(0.5), 1e-15),
    `q = 1/2 处两增益精确相等 = ln(1.5) = ${redundancyGainLog(0.5).toFixed(15)}（闭式交叉点 q* = ${0.5}）`,
  );
  // ② 杠杆序列引理: 200 随机可用性 × m=6，局部择优序列 = 全部 2^m 序列的最优
  const rngL = mulberry32Local(505);
  let lemmaOk = true;
  for (let i = 0; i < 200; i += 1) {
    const A0 = 0.05 + 0.9 * rngL();
    const m = 1 + Math.floor(rngL() * 6);
    let greedyA = A0;
    let gErr = 0;
    for (let s = 0; s < m; s += 1) {
      const q = 1 - greedyA;
      const useRepair = q > 0.5; // 局部择优（并列走冗余）
      greedyA = 1 - (useRepair ? q / 2 : q * q);
    }
    let bestA = -Infinity;
    for (let mask = 0; mask < 1 << m; mask += 1) {
      let a = A0;
      for (let s = 0; s < m; s += 1) {
        const q = 1 - a;
        a = 1 - (((mask >> s) & 1) === 1 ? q / 2 : q * q);
      }
      bestA = Math.max(bestA, a);
    }
    gErr = Math.max(gErr, bestA - greedyA);
    if (bestA - greedyA > 1e-12) lemmaOk = false;
  }
  ok(lemmaOk, '杠杆序列引理（200 随机 × m∈[1,6] × 穷举 2^m）: 局部择优序列 = 最优杠杆序列（最大差 ≤ 1e-12）');
  // ③ 贪心分配 = 组分穷举（50 实例）
  const rngB = mulberry32Local(606);
  let greedyOpt = true;
  let worstGap = 0;
  for (let inst = 0; inst < 50; inst += 1) {
    const n = 2 + Math.floor(rngB() * 2);
    const budget = 3 + Math.floor(rngB() * 3);
    const comps = Array.from({ length: n }, (_, i) => ({ id: `c${i}`, availability: 0.05 + 0.9 * rngB() }));
    const result = resilienceBudget(comps, budget);
    // 脚本侧: 每组件 m 次局部择优动作后的可用性（引理②），穷举一切组分分配
    const bestAfter = (a0, m) => {
      let a = a0;
      for (let s = 0; s < m; s += 1) {
        const q = 1 - a;
        a = 1 - (q > 0.5 ? q / 2 : q * q);
      }
      return a;
    };
    const alloc = new Array(n).fill(0);
    let bestSys = -Infinity;
    const rec = (idx, rem) => {
      if (idx === n - 1) {
        alloc[idx] = rem;
        let prod = 1;
        for (let i = 0; i < n; i += 1) prod *= bestAfter(comps[i].availability, alloc[i]);
        bestSys = Math.max(bestSys, prod);
        return;
      }
      for (let t = 0; t <= rem; t += 1) {
        alloc[idx] = t;
        rec(idx + 1, rem - t);
      }
      alloc[idx] = 0;
    };
    rec(0, budget);
    worstGap = Math.max(worstGap, bestSys - result.finalSystemAvailability);
    if (bestSys - result.finalSystemAvailability > 1e-12) greedyOpt = false;
    if (result.actions.length !== budget) greedyOpt = false;
    if (result.allocations.reduce((s, x) => s + x.count, 0) !== budget) greedyOpt = false;
  }
  ok(greedyOpt, `贪心分配 = 组分穷举最优（50 随机实例，最大差 ${worstGap.toExponential(2)}；动作数与分配数守恒 = budget）`);
  // ④ 200 随机实例: 守恒 + 每步杠杆公式 + 改进方向
  const rngP = mulberry32Local(707);
  let propOk = true;
  for (let i = 0; i < 200; i += 1) {
    const n = 1 + Math.floor(rngP() * 4);
    const budget = Math.floor(rngP() * 6);
    const comps = Array.from({ length: n }, (_, j) => ({ id: `p${j}`, availability: 0.05 + 0.9 * rngP() }));
    const r = resilienceBudget(comps, budget);
    if (!(r.finalSystemAvailability >= r.initialSystemAvailability)) propOk = false;
    if (!near(r.totalGainLog, Math.log(r.finalSystemAvailability / r.initialSystemAvailability), 1e-12)) propOk = false;
    for (const act of r.actions) {
      const q = 1 - act.availabilityBefore;
      const expect = act.lever === 'redundancy' ? 1 - q * q : 1 - q / 2;
      if (!near(act.availabilityAfter, expect, 1e-15)) propOk = false;
    }
  }
  ok(propOk, '200 随机实例: 最终 ≥ 初始系统可用性、总对数增益 = ln(终/始) 守恒、每步变换 = 杠杆闭式（q→q² 或 q→q/2）');
}

// ═══════════════════ B interruptible-autonomy 95.1 ═══════════════════

section('B1 optimalQ：精确目标（独立值迭代 + 解析锚点）');

{
  const world = makeRewardChain(); // L=6, γ=0.95
  const GAMMA = 0.95;
  const L = 6;
  // 脚本侧独立值迭代（不调内核）
  let v = new Array(L).fill(0);
  for (let it = 0; it < 20000; it += 1) {
    const nv = new Array(L).fill(0);
    let delta = 0;
    for (let s = 0; s < L; s += 1) {
      let best = -Infinity;
      for (let a = 0; a < 2; a += 1) {
        const nx = a === 1 ? Math.min(s + 1, L - 1) : Math.max(s - 1, 0);
        best = Math.max(best, (nx === L - 1 ? 1 : 0) + GAMMA * v[nx]);
      }
      nv[s] = best;
      delta = Math.max(delta, Math.abs(nv[s] - v[s]));
    }
    v = nv;
    if (delta < 1e-14) break;
  }
  const qStar = optimalQ(world);
  let maxDiff = 0;
  for (let s = 0; s < L; s += 1) {
    for (let a = 0; a < 2; a += 1) {
      const nx = a === 1 ? Math.min(s + 1, L - 1) : Math.max(s - 1, 0);
      maxDiff = Math.max(maxDiff, Math.abs(qStar[s][a] - ((nx === L - 1 ? 1 : 0) + GAMMA * v[nx])));
    }
  }
  ok(maxDiff < 1e-12, `optimalQ 与脚本侧独立值迭代一致（max|ΔQ| = ${maxDiff.toExponential(2)} < 1e-12）`);
  const vStart = Math.max(...qStar[0]);
  const analytic = Math.pow(GAMMA, L - 2) / (1 - GAMMA);
  ok(
    near(vStart, analytic, 1e-9),
    `解析锚点: max Q*(start) = ${vStart.toFixed(9)} = γ⁴/(1−γ) = ${analytic.toFixed(9)}（奖励链真值）`,
  );
}

section('B2 多源中断组合：最优顺序裁决 + off-policy 修正的组合不变性');

{
  const world = makeRewardChain();
  // 三个源全部只在高奖赏态 5 触发（落点/罚金不同——并发碰撞构造）。
  // 触发集不含中间态: 源若在 3/4 触发会切断通往 5 的全部路径（状态空间
  // 断连——未访问 (s,a) 无数据可学, 任何学习口径都救不了, 见内核头注）;
  // 全部在 5 触发 ⟹ 任何非空子集下全状态可达, 全 (s,a) 有数据——不变性
  // 断言的公平擂台。
  const src = (name, trigger, penalty, dest) => ({
    name,
    penalty,
    fires: (s) => trigger.includes(s),
    destination: () => dest,
  });
  const sA = src('op-a', [5], -2, 0);
  const sB = src('op-b', [5], -3, 1);
  const sC = src('op-c', [5], -5, 2);
  const all = [sA, sB, sC];
  const composed = composeInterruptSchedules(all);
  ok(
    composed.fires(5, 1, 5) && composed.fires(5, 0, 4) && !composed.fires(4, 1, 5) && !composed.fires(2, 1, 3),
    `union 触发: 组合调度在 {5} 触发（任一源触发即触发）、{4}/{2} 不触发`,
  );
  ok(
    composed.destination(5, 1, 5) === 2 && composed.penalty === -5,
    `最优顺序裁决: 状态 5 三源齐发 → |penalty| 最大的 op-c 拥有覆盖权（落点 2）; penalty 字段 = 最严峻源 −5（无修正学习器的最坏口径）`,
  );
  const firstWins = composeInterruptSchedules(all, { collision: 'first' });
  ok(
    firstWins.destination(5, 1, 5) === 0,
    `collision='first': 按注册序裁决（状态 5 → op-a 落点 0）`,
  );
  throws(() => composed.destination(2, 1, 3), 'composed: destination 在未触发步调用显式 throw');

  // 组合不变性: 2^3−1 个非空子集 × 5 种子，修正全收敛 / 无修正全偏置
  const qStar = optimalQ(world);
  const subsets = [];
  for (let mask = 1; mask < 8; mask += 1) subsets.push(all.filter((_, i) => ((mask >> i) & 1) === 1));
  let worstCorrected = 0;
  let minNaiveBias = Infinity;
  let allRuns = 0;
  for (const subset of subsets) {
    const sched = composeInterruptSchedules(subset);
    for (let seed = 1; seed <= 5; seed += 1) {
      const opts = { world, interruptSchedule: sched, episodes: 3000, seed: seed * 11, epsilon: 0.2, alpha: 1, initQ: 20 };
      const corrected = interruptedQLearning({ ...opts, correction: 'off-policy' });
      const naive = interruptedQLearning({ ...opts, correction: 'none' });
      let cErr = 0;
      let nBias = 0;
      for (let s = 0; s < 6; s += 1) {
        for (let a = 0; a < 2; a += 1) {
          cErr = Math.max(cErr, Math.abs(corrected.q[s][a] - qStar[s][a]));
          nBias = Math.max(nBias, Math.abs(naive.q[s][a] - qStar[s][a]));
        }
      }
      worstCorrected = Math.max(worstCorrected, cErr);
      minNaiveBias = Math.min(minNaiveBias, nBias);
      allRuns += 1;
    }
  }
  ok(
    worstCorrected < 1e-2,
    `组合不变性（${allRuns} 次运行 = 7 非空子集 × 5 种子）: off-policy 修正全部收敛到同一未中断 Q*（最差 max|Q̂−Q*| = ${worstCorrected.toExponential(2)} < 1e-2——与哪个源/几个源/何种顺序覆盖无关）`,
  );
  ok(
    minNaiveBias > 0.5,
    `无修正对照: 全部 ${allRuns} 次运行偏置 > 0.5（最小偏置 ${minNaiveBias.toFixed(3)}——任意子集的覆盖都被学进动力学）`,
  );
}

section('B3 向量化阈值扫描：等价（逐位 + 分布）+ 单调 + 耗时对照');

{
  const world = makePiecewiseHandoffWorld();
  const taus = [-1, 0.005, 0.05, 0.5, 1.1, 2, 5, 5.5, 1e9];
  const seeds = [1, 2, 3];
  const sweep = handoffThresholdSweep(world, taus, { seeds, stepsPerSeed: 400 });
  // ① 交接次数与 simulateHandoff 逐位一致（决策只依赖状态 ⟹ 共享轨迹）
  let handoffExact = true;
  for (let i = 0; i < taus.length; i += 1) {
    const ref = simulateHandoff({ world, mode: 'adaptive', seeds, stepsPerSeed: 400, threshold: taus[i] });
    if (sweep.points[i].handoffs !== ref.handoffs) handoffExact = false;
  }
  ok(handoffExact && sweep.steps === 1200, `交接次数逐位一致: 9 档阈值 × 3 种子 × 400 步，sweep.handoffs ≡ simulateHandoff.handoffs（1200 步共享轨迹）`);
  // ② 与脚本侧「共享抽签朴素重放」一致（独立实现: 每步一次抽签、逐阈值逐步结算）
  const naiveReplay = (world, taus, seeds, steps) => {
    const out = taus.map(() => ({ handoffs: 0, errors: 0, totalCost: 0 }));
    for (const sd of seeds) {
      const rng = mulberry32Local(sd);
      let s = world.startState;
      for (let t = 0; t < steps; t += 1) {
        const p = world.pError(s);
        const c = world.costAuto(s);
        const u = rng();
        const x = p * c;
        for (let i = 0; i < taus.length; i += 1) {
          if (x > taus[i]) {
            out[i].handoffs += 1;
            out[i].totalCost += world.costHuman;
          } else if (u < p) {
            out[i].errors += 1;
            out[i].totalCost += c;
          }
        }
        s = world.next(s);
      }
    }
    return out;
  };
  const naive = naiveReplay(world, taus, seeds, 400);
  let naiveExact = true;
  for (let i = 0; i < taus.length; i += 1) {
    if (sweep.points[i].handoffs !== naive[i].handoffs) naiveExact = false;
    if (sweep.points[i].errors !== naive[i].errors) naiveExact = false;
    if (Math.abs(sweep.points[i].totalCost - naive[i].totalCost) > 1e-9) naiveExact = false;
  }
  ok(naiveExact, `共享抽签等价: sweep ≡ 脚本侧朴素逐阈值重放（handoffs/errors 逐位、totalCost < 1e-9——浮点求和顺序差）`);
  // ③ 单调: 阈值升序 → 交接次数单调不增
  const order = taus.map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t);
  let mono = true;
  for (let j = 1; j < order.length; j += 1) {
    if (sweep.points[order[j].i].handoffs > sweep.points[order[j - 1].i].handoffs) mono = false;
  }
  ok(mono && sweep.points[order[0].i].handoffs === 1200 && sweep.points[order[order.length - 1].i].handoffs === 0,
    `交接次数随阈值单调不增（τ→−∞ 全交人 1200、τ→∞ 全自动 0）`);
  // ④ 期望口径: 100 种子 adaptive(τ*) 双估计一致 + 解析期望 111.0
  const seeds100 = Array.from({ length: 100 }, (_, i) => 5000 + i);
  const sweep100 = handoffThresholdSweep(world, [1.1], { seeds: seeds100, stepsPerSeed: 200 });
  const sim100 = simulateHandoff({ world, mode: 'adaptive', seeds: seeds100, stepsPerSeed: 200, threshold: 1.1 });
  const meanSweep = sweep100.points[0].totalCost / 100;
  const meanSim = sim100.totalCost / 100;
  ok(
    Math.abs(meanSweep - meanSim) < 1 && Math.abs(meanSweep - 111.0) < 1,
    `期望口径双估计: sweep 均值 = ${meanSweep.toFixed(3)} vs simulateHandoff 均值 = ${meanSim.toFixed(3)}（|Δ| < 1）, 且 ≈ 解析期望 111.0（100 安全步 × 0.01 + 100 危险步 × 1.1）`,
  );
  // ⑤ 耗时对照: 240 阈值 × 3 种子 × 2000 步
  const grid = Array.from({ length: 240 }, (_, i) => i * 0.025);
  const bigSeeds = [11, 22, 33];
  const t0 = now();
  const bigSweep = handoffThresholdSweep(world, grid, { seeds: bigSeeds, stepsPerSeed: 2000 });
  const tSweep = now() - t0;
  const t1 = now();
  naiveReplay(world, grid, bigSeeds, 2000);
  const tNaive = now() - t1;
  let bigExact = true;
  const naiveBig = naiveReplay(world, grid, bigSeeds, 2000);
  for (let i = 0; i < grid.length; i += 1) {
    if (bigSweep.points[i].handoffs !== naiveBig[i].handoffs || bigSweep.points[i].errors !== naiveBig[i].errors) bigExact = false;
  }
  ok(bigExact, `240 阈值 × 6000 步大网格: 向量化结果与朴素重放逐位一致（handoffs/errors）`);
  ok(
    tSweep < tNaive,
    `耗时对照: 向量化扫描 ${tSweep.toFixed(1)} ms vs 朴素逐阈值重放 ${tNaive.toFixed(1)} ms（加速 ${((tNaive / tSweep)).toFixed(1)}×; 复杂度 O((steps+nτ)·log) vs O(nτ·steps)）`,
  );
}

section('B4 收敛保证：210 次多种子对照 + 收敛速率阶梯');

{
  const world = makeRewardChain();
  const qStar = optimalQ(world);
  const sA = { name: 'a', penalty: -2, fires: (s) => s === 5, destination: () => 0 };
  const sB = { name: 'b', penalty: -3, fires: (s) => s === 5, destination: () => 1 };
  const sC = { name: 'c', penalty: -5, fires: (s) => s === 5, destination: () => 2 };
  const all = [sA, sB, sC];
  const subsets = [];
  for (let mask = 1; mask < 8; mask += 1) subsets.push(all.filter((_, i) => ((mask >> i) & 1) === 1));
  let correctedAll = true;
  let naiveAll = true;
  let worstC = 0;
  let minN = Infinity;
  const runs = 7 * 30;
  for (const subset of subsets) {
    const sched = composeInterruptSchedules(subset);
    for (let k = 0; k < 30; k += 1) {
      const seed = 900 + k;
      const opts = { world, interruptSchedule: sched, episodes: 3000, seed, epsilon: 0.2, alpha: 1, initQ: 20 };
      const corrected = interruptedQLearning({ ...opts, correction: 'off-policy' });
      const naive = interruptedQLearning({ ...opts, correction: 'none' });
      let cErr = 0;
      let nBias = 0;
      for (let s = 0; s < 6; s += 1) {
        for (let a = 0; a < 2; a += 1) {
          cErr = Math.max(cErr, Math.abs(corrected.q[s][a] - qStar[s][a]));
          nBias = Math.max(nBias, Math.abs(naive.q[s][a] - qStar[s][a]));
        }
      }
      if (cErr >= 1e-2) correctedAll = false;
      if (nBias <= 0.5) naiveAll = false;
      worstC = Math.max(worstC, cErr);
      minN = Math.min(minN, nBias);
    }
  }
  ok(
    correctedAll,
    `修正收敛（${runs} 次运行 = 7 子集 × 30 种子 vs 无中断最优）: 全部 max|Q̂−Q*| < 1e-2（最差 ${worstC.toExponential(2)}）`,
  );
  ok(naiveAll, `无修正对照: 全部 ${runs} 次运行偏置 > 0.5（最小 ${minN.toFixed(3)}——中断破坏学习不是个例是全例）`);
  // 速率阶梯（α=1 + 确定性转移 = 精确异步 Bellman 备份）:
  //   修正——覆盖即精确（5 情节内全链 (s,a) 被访问 ⟹ 误差到机器精度）;
  //   无修正——样本越多越精确地收敛到**错误目标**（误差单调升到被打断 MDP 的偏置平台）
  const sched = composeInterruptSchedules(all);
  const errAt = (episodes, correction) => {
    const r = interruptedQLearning({ world, interruptSchedule: sched, episodes, seed: 7, epsilon: 0.2, alpha: 1, initQ: 20, correction });
    let e = 0;
    for (let s = 0; s < 6; s += 1) for (let a = 0; a < 2; a += 1) e = Math.max(e, Math.abs(r.q[s][a] - qStar[s][a]));
    return e;
  };
  const early = errAt(5, 'off-policy');
  ok(
    early < 1e-12,
    `修正的收敛速率: 5 情节即达机器精度（max 误差 = ${early.toExponential(2)}——α=1 精确备份下样本复杂度 = 覆盖复杂度, 无偏差要先移除）`,
  );
  const nEps = [5, 10, 15, 20, 30, 60];
  const nLadder = nEps.map((e) => errAt(e, 'none'));
  let nMono = true;
  for (let i = 1; i < nLadder.length; i += 1) if (!(nLadder[i] > nLadder[i - 1])) nMono = false;
  const plateau = errAt(120, 'none');
  ok(
    nMono && Math.abs(plateau - nLadder[nLadder.length - 1]) < 0.05,
    `无修正的收敛方向: episodes [${nEps.join(',')}] → 误差 [${nLadder.map((e) => e.toFixed(2)).join(' < ')}] 单调升 → 平台 ${plateau.toFixed(2)}（越学越像被打断的 MDP——样本消除的是方差不是偏差）`,
  );
}

// ═══════════════════ C self-boundary 100.1 ═══════════════════

section('C1 增量偶然性：与批量口径逐位一致 + 增量 vs 重扫耗时对照');

{
  // 二值依赖流: y_t = a_{t−2} w.p. 0.75 否则翻转（预二值化输入）
  const rngC = mulberry32Local(808);
  const N = 2048;
  const actions = [];
  const signals = [];
  for (let t = 0; t < N; t += 1) {
    actions.push(rngC() < 0.5 ? 1 : 0);
    signals.push(t >= 2 && rngC() < 0.75 ? actions[t - 2] : 1 - (rngC() < 0.5 ? 1 : 0));
  }
  const inc = new IncrementalContingency(4);
  const checkpoints = [64, 128, 256, 512, 1024, 2048];
  let bitwise = true;
  let detected = false;
  for (let i = 0; i < N; i += 1) {
    inc.push(actions[i], signals[i]);
    if (checkpoints.includes(i + 1)) {
      const curve = inc.delayCurve();
      const batch = contingencyScore(actions.slice(0, i + 1), signals.slice(0, i + 1), { maxDelay: 4, shuffles: 20 });
      if (JSON.stringify(curve) !== JSON.stringify(batch.delayCurve)) bitwise = false;
      if (i + 1 === N && inc.observed().bestDelay === 2 && inc.observed().miBits > 0.3) detected = true;
    }
  }
  ok(bitwise, `逐位一致: 6 个检查点（64..2048）的增量 delayCurve ≡ contingencyScore 批量 delayCurve（同一列联计数 → 同一 MI 算术）`);
  ok(detected, `流式检出: 终点观测曲线 bestDelay = 2（真实延迟）、miBits = ${inc.observed().miBits.toFixed(3)} > 0.3（增量口径不失检测力）`);
  // 耗时对照: N=16384 增量推送 vs 128 次批量重扫（脚本侧观测曲线口径，无打乱基线）
  const rngD = mulberry32Local(909);
  const big = [];
  const bigS = [];
  for (let t = 0; t < 16384; t += 1) {
    big.push(rngD() < 0.5 ? 1 : 0);
    bigS.push(t >= 2 && rngD() < 0.75 ? big[t - 2] : rngD() < 0.5 ? 1 : 0);
  }
  const t0 = now();
  const inc2 = new IncrementalContingency(4);
  for (let t = 0; t < 16384; t += 1) inc2.push(big[t], bigS[t]);
  const tInc = now() - t0;
  const miAt = (a, y) => {
    const n = a.length;
    let n11 = 0;
    let n1x = 0;
    let nx1 = 0;
    for (let t = 0; t < n; t += 1) {
      if (a[t] === 1) {
        n1x += 1;
        if (y[t] === 1) n11 += 1;
      }
      if (y[t] === 1) nx1 += 1;
    }
    const n10 = n1x - n11;
    const n01 = nx1 - n11;
    const n00 = n - n11 - n10 - n01;
    const contrib = (j, ma, mb) => (j <= 0 || ma <= 0 || mb <= 0 ? 0 : (j / n) * Math.log2(j / ma / mb * n));
    return contrib(n11, n1x, nx1) + contrib(n10, n1x, n01 + n00) + contrib(n01, n10 + n00, nx1) + contrib(n00, n10 + n00, n01 + n00);
  };
  const t1 = now();
  for (let cp = 128; cp <= 16384; cp += 128) {
    for (let d = 0; d <= 4; d += 1) {
      const aSeg = [];
      const ySeg = [];
      for (let t = d; t < cp; t += 1) {
        aSeg.push(big[t - d]);
        ySeg.push(bigS[t]);
      }
      miAt(aSeg, ySeg);
    }
  }
  const tBatch = now() - t1;
  ok(
    tInc < tBatch,
    `耗时对照: 16384 步增量推送 ${tInc.toFixed(1)} ms vs 128 次批量重扫 ${tBatch.toFixed(1)} ms（${(tBatch / tInc).toFixed(0)}×——流式监控 O(maxDelay)/步，替代 O(T·maxDelay)/次重扫）`,
  );
}

section('C2 多步因果边界：自致链传递 / 外源链不揽功 / 直接通道 / DPI');

{
  // 自致链: a → x1 → x2 → y（每链延迟 1，总延迟 3）
  let transmitted = 0;
  let delayExact = 0;
  let targetDelayExact = 0;
  for (let seed = 0; seed < 30; seed += 1) {
    const chain = simulateChain({ seed: 20000 + seed, links: 2, delayPerLink: 1, fidelity: 0.9 });
    const res = multiStepAttribution({
      actions: chain.actions,
      mediators: chain.mediators,
      target: chain.target,
      seed: 21000 + seed,
      maxDelay: 6,
    });
    if (res.classification === 'transmitted-self') transmitted += 1;
    if (res.chainDelay === 3) delayExact += 1;
    if (res.targetContingency.bestDelay === 3) targetDelayExact += 1;
  }
  ok(
    transmitted >= 29,
    `自致链传递归因: ${transmitted}/30 种子判 transmitted-self（效应经中介链传导仍归我——链上流动的是我的效应）`,
  );
  ok(
    delayExact >= 29 && targetDelayExact >= 29,
    `传递延迟精确: chainDelay = 3（首链 1 + 次链 2）${delayExact}/30、目标最佳延迟 = 3 ${targetDelayExact}/30（延迟效应链的解析结构被完整还原）`,
  );
  // 外源链: 动作同步跟随 iid 外源 → 依赖被链头中介吸收且链头零延迟共变 → 不揽功
  let mediated = 0;
  let notSelf = 0;
  for (let seed = 0; seed < 30; seed += 1) {
    const chain = simulateChain({ seed: 22000 + seed, links: 2, delayPerLink: 1, fidelity: 0.9, externalDrive: true });
    const res = multiStepAttribution({
      actions: chain.actions,
      mediators: chain.mediators,
      target: chain.target,
      seed: 23000 + seed,
      maxDelay: 6,
    });
    if (res.classification === 'mediated-external') mediated += 1;
    if (!res.selfCaused) notSelf += 1;
  }
  ok(
    notSelf === 30 && mediated >= 27,
    `外源链不揽功: 30/30 不判自致（其中 ${mediated}/30 判 mediated-external——链头中介只在零延迟与动作共变 ⟹ 同步共因指纹; 下游中介的正延迟依赖是外源经链传导的伪影, 归因看链头）`,
  );
  // 直接通道（无中介）: simulateEnv 自致通道 → direct-self
  let direct = 0;
  for (let seed = 0; seed < 30; seed += 1) {
    const env = simulateEnv({ seed: 24000 + seed, delay: 2, agencyProb: 0.8, spuriousCorr: 0, length: 600 });
    const res = multiStepAttribution({ actions: env.actions, target: env.signals[0], seed: 25000 + seed, maxDelay: 5 });
    if (res.classification === 'direct-self') direct += 1;
  }
  ok(direct === 30, `直接通道（无中介）: 30/30 判 direct-self（退化口径——多步归因包含单步归因）`);
  // 数据处理不等式: 沿链 MI 均值单调不增（40 种子）
  const miMeans = [0, 0, 0];
  let worstInversion = 0;
  for (let seed = 0; seed < 40; seed += 1) {
    const chain = simulateChain({ seed: 26000 + seed, links: 2, delayPerLink: 1, fidelity: 0.9 });
    const c1 = contingencyScore(chain.actions, chain.mediators[0], { maxDelay: 6, shuffles: 20, shuffleSeed: 26500 + seed });
    const c2 = contingencyScore(chain.actions, chain.mediators[1], { maxDelay: 6, shuffles: 20, shuffleSeed: 27000 + seed });
    const cy = contingencyScore(chain.actions, chain.target, { maxDelay: 6, shuffles: 20, shuffleSeed: 27500 + seed });
    const m1 = c1.delayCurve[1];
    const m2 = c2.delayCurve[2];
    const m3 = cy.delayCurve[3];
    miMeans[0] += m1;
    miMeans[1] += m2;
    miMeans[2] += m3;
    worstInversion = Math.max(worstInversion, m1 - m2 < 0 ? m2 - m1 : 0, m2 - m3 < 0 ? m3 - m2 : 0);
  }
  const means = miMeans.map((m) => m / 40);
  ok(
    means[0] >= means[1] - 1e-9 && means[1] >= means[2] - 1e-9,
    `数据处理不等式（40 种子均值）: I(a;x1) = ${means[0].toFixed(4)} ≥ I(a;x2) = ${means[1].toFixed(4)} ≥ I(a;y) = ${means[2].toFixed(4)}（逐链噪声只减信息; 单种子最坏倒置 ${worstInversion.toFixed(4)} = 采样涨落）`,
  );
}

section('C3 他者模型：四类他者全对 + 对称注入鲁棒（意图方向）');

{
  const kinds = ['mirror', 'counter', 'independent-agent', 'environment'];
  const stats = {};
  let reversedFalseReactions = 0;
  let reversedTotal = 0;
  for (const kind of kinds) {
    stats[kind] = { hit: 0, delayExact: 0, intentOk: 0, corrSum: 0 };
    for (let seed = 0; seed < 30; seed += 1) {
      const { actions, other } = simulateOtherAgent({ kind, seed: 30000 + seed, delay: 2, responsiveness: 0.8, persistence: 0.7, length: 600 });
      const rep = otherAgentModel(actions, other, { seed: 31000 + seed, maxDelay: 4 });
      if (kind === 'mirror') {
        if (rep.isAgent && rep.reactsToMe && rep.reactionDelay === 2 && rep.intent === 'mirror') stats[kind].hit += 1;
        if (rep.responseCorrelation > 0.5) stats[kind].intentOk += 1;
      } else if (kind === 'counter') {
        if (rep.isAgent && rep.reactsToMe && rep.reactionDelay === 2 && rep.intent === 'counter') stats[kind].hit += 1;
        if (rep.responseCorrelation < -0.5) stats[kind].intentOk += 1;
      } else if (kind === 'independent-agent') {
        if (rep.isAgent && !rep.reactsToMe && rep.intent === 'neutral' && rep.selfStructure > 0.1) stats[kind].hit += 1;
      } else {
        if (!rep.isAgent && !rep.reactsToMe && rep.intent === 'neutral') stats[kind].hit += 1;
      }
      if (rep.reactsToMe && rep.reactionDelay === 2) stats[kind].delayExact += 1;
      stats[kind].corrSum += rep.responseCorrelation;
      // 对称注入鲁棒: 角色对调（把「他者」当我的动作流）——反应依赖是 b_t ← a_{t−d}，
      // 对调后一切非负延迟上的 MI 应归零（时间方向由时间戳说话）
      const reversed = otherAgentModel(other, actions, { seed: 32000 + seed, maxDelay: 4 });
      reversedTotal += 1;
      if (!reversed.reactsToMe) reversedFalseReactions += 1;
    }
  }
  ok(stats['mirror'].hit >= 29, `镜像他者: ${stats['mirror'].hit}/30 检出 reactsToMe + 延迟 2 + 意图 mirror（平均相关 +${(stats['mirror'].corrSum / 30).toFixed(3)}——合作/模仿指纹）`);
  ok(stats['counter'].hit >= 29, `反制他者: ${stats['counter'].hit}/30 检出 + 意图 counter（平均相关 ${(stats['counter'].corrSum / 30).toFixed(3)}——对手意图的最低限度推断: 它在系统性抵消我的动作）`);
  ok(stats['independent-agent'].hit >= 29, `独立主体: ${stats['independent-agent'].hit}/30 不理会我但凭自身结构（AR 可预测性 ${(0.4).toFixed(1)} 级 > 阈）仍被识别为 agent`);
  ok(stats['environment'].hit === 30, `纯环境: ${stats['environment'].hit}/30 零误报（无反应无结构 ⟹ 不是主体）`);
  ok(
    reversedFalseReactions === reversedTotal,
    `对称注入鲁棒: 120 次角色对调全部零误报（${reversedFalseReactions}/${reversedTotal}——依赖是 b_t ← a_{t−2}，对调后非负延迟 MI 归零: 谁因谁果由时间戳说话，不是相关系数说话）`,
  );
  const d1 = simulateOtherAgent({ kind: 'mirror', seed: 42, length: 256 });
  const d2 = simulateOtherAgent({ kind: 'mirror', seed: 42, length: 256 });
  ok(JSON.stringify(d1) === JSON.stringify(d2), '同种子逐位复现（simulateOtherAgent 确定性）');
}

section('D 入参校验（显式 throw）');

{
  // resilience
  throws(() => weibullSurvival(1, { scale: 0, shape: 2 }), 'weibullSurvival: scale = 0 throw');
  throws(() => weibullHazard(1, { scale: 1, shape: -1 }), 'weibullHazard: shape < 0 throw');
  throws(() => weibullDiagnostics(-1, { scale: 1, shape: 2 }), 'weibullDiagnostics: t < 0 throw');
  throws(() => steadyStateAvailability({ mttf: -1, mttr: 1 }), 'steadyStateAvailability: 负 MTTF throw');
  throws(() => systemAvailability([], { kind: 'serial' }), 'systemAvailability: 空组分 throw');
  throws(() => systemAvailability([1.2], { kind: 'serial' }), 'systemAvailability: 可用性 > 1 throw');
  throws(() => systemAvailability([0.5, 0.6], { kind: 'k-of-n', k: 3 }), 'systemAvailability: k > n throw');
  throws(() => resilienceBudget([{ id: 'a', availability: 0.5 }], -1), 'resilienceBudget: 负预算 throw');
  throws(() => resilienceBudget([{ id: 'a', availability: 0.5 }, { id: 'a', availability: 0.6 }], 1), 'resilienceBudget: 重复 id throw');
  throws(() => resilienceBudget([{ id: 'a', availability: 0 }], 1), 'resilienceBudget: availability = 0 throw');
  const zeroBudget = resilienceBudget([{ id: 'a', availability: 0.5 }], 0);
  ok(zeroBudget.actions.length === 0 && near(zeroBudget.finalSystemAvailability, 0.5, 1e-15), '零预算合法: 空动作列表、系统可用性不变');
  // interruptible-autonomy
  throws(() => optimalQ(null), 'optimalQ: 空 world throw');
  throws(() => composeInterruptSchedules([]), 'composeInterruptSchedules: 空源列表 throw');
  throws(() => composeInterruptSchedules([{ name: 'x', penalty: -1, fires: () => true, destination: () => 0 }], { collision: 'bogus' }), 'composeInterruptSchedules: 非法 collision throw');
  throws(() => handoffThresholdSweep(makePiecewiseHandoffWorld(), []), 'handoffThresholdSweep: 空阈值 throw');
  throws(() => handoffThresholdSweep(makePiecewiseHandoffWorld(), [Number.NaN]), 'handoffThresholdSweep: NaN 阈值 throw');
  // self-boundary
  throws(() => new IncrementalContingency(-1), 'IncrementalContingency: maxDelay < 0 throw');
  throws(() => new IncrementalContingency(2).push(0.5, 1), 'IncrementalContingency: 非 0/1 输入 throw');
  throws(() => multiStepAttribution({ actions: [1, 2], target: [1, 2] }), 'multiStepAttribution: 流长 < 32 throw');
  throws(() => multiStepAttribution({ actions: new Array(64).fill(1), mediators: [new Array(63).fill(1)], target: new Array(64).fill(1) }), 'multiStepAttribution: 中介不等长 throw');
  throws(() => simulateChain({ links: 0 }), 'simulateChain: links = 0 throw');
  throws(() => simulateChain({ delayPerLink: 200 }), 'simulateChain: 总延迟 > length/4 throw');
  throws(() => simulateOtherAgent({ kind: 'bogus' }), 'simulateOtherAgent: 非法 kind throw');
  throws(() => otherAgentModel(new Array(8).fill(1), new Array(8).fill(0)), 'otherAgentModel: 流长 < 32 throw');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— R5 三弹性自主内核进化（resilience 4.1 / interruptible-autonomy 95.1 / self-boundary 100.1）成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
