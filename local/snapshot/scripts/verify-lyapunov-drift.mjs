/**
 * verify-lyapunov-drift.mjs — 54.0 Lyapunov 漂移加罚内核纯数学离线验证
 *
 * 不是「能跑」，是「算得对」——每个数学核心都有解析对照:
 *   玩具实例（贯穿全文）: 2 队列 3 动作
 *     cheap    μ=(0.9, 0)    cost=0    —— 只服务队列 1，队列 2 必然发散
 *     balanced μ=(0.45,0.45) cost=0.5  —— 两队列都略欠（0.45 < λ=0.5），发散
 *     premium  μ=(0.9, 0.9)  cost=1    —— 全兜住，最贵
 *     λ = (0.5, 0.5)。
 *   ① LP 解析对照（手算）: 最优混合 cheap:premium = 4:5 分时（或等价的
 *      balanced:premium = 8:1），LP* = 5/9；对偶乘子 y* = (0, 10/9)（瓶颈在
 *      队列 2，队列 1 富余）。一切**纯动作**策略要么不稳定（cheap/balanced）
 *      要么成本 1（premium）——最优稳定纯策略成本 1，LP 混合把成本砍 44%，
 *      漂移加罚应当**自动发现分时**。
 *   ② V∈{1,2,4,…,128} 扫描: 平均成本单调不增 + 平均队长单调不减
 *      （[O(1/V) 次优, O(V) 队长] 权衡两方向）。
 *   ③ 队列稳定: 漂移加罚平均队长随 T 次线性（T=10⁴/T=10³ 比值 < 3，实测
 *      ≈ 1.07）；恒定 cheap 策略线性增长（比值 ≈ T₂/T₁ = 10，实测 9.90）。
 *   ④ 对偶价格收敛: 末端窗口均值 p̄ ≈ (0.003, 1.114) → y* = (0, 10/9)
 *      （容差 0.03；偏差源 = 冷启动爬坡 + 容量边界锯齿半宽 O(λ)/1）。
 *   ⑤ 逐槽漂移证书: realized Δ(½ΣQ²) ≤ ½Σ(μ²+a²) − ΣQ(μ−a) 路径必然
 *      成立（≥ −1e-9；数学上恒 ≥ 0，1e-12 量级负数是 Q ~ O(V)≈142 处
 *      IEEE 减法消去的尘埃，与 35.0 反馈控制内核证书同容差口径）。
 *
 * 全部断言确定性（mulberry32 种子内建于内核）。随机过程 + 定理读数的
 * 容差均在断言消息中文档化。
 * 运行：node --experimental-strip-types scripts/verify-lyapunov-drift.mjs
 */

import {
  driftPlusPenaltyStep,
  simulatePolicy,
  dualPrices,
  lpBenchmark,
  driftCertificate,
  backpressureInsight,
} from '../src/core/lyapunov-drift.ts';

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
function okThrow(fn, label) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, label);
}

// ─────────────────────────── 玩具实例 ───────────────────────────
const ACTIONS = [
  { id: 'cheap', mu: [0.9, 0], cost: 0 },
  { id: 'balanced', mu: [0.45, 0.45], cost: 0.5 },
  { id: 'premium', mu: [0.9, 0.9], cost: 1 },
];
const LAMBDA = [0.5, 0.5];
const LP_STAR = 5 / 9;
const DUAL_Y1 = 0;
const DUAL_Y2 = 10 / 9;
const BASE = { queues0: [0, 0], actionSet: ACTIONS, arrivalMeans: LAMBDA };

// ═══════════════════ LP 解析对照 ═══════════════════

section('54.0 LP 顶点枚举：手算锚点 5/9 与对偶乘子 (0, 10/9)');

const lp = lpBenchmark({ actionSet: ACTIONS, arrivalMeans: LAMBDA });
ok(lp.feasible && near(lp.optimalCost, LP_STAR, 1e-9), `LP* = ${lp.optimalCost.toFixed(12)} = 手算 5/9（cheap:premium = 4:5 分时）± 1e-9`);
ok(
  near(lp.pi[0], 0, 1e-9) && near(lp.pi[1], 8 / 9, 1e-9) && near(lp.pi[2], 1 / 9, 1e-9) && near(lp.pi.reduce((s, x) => s + x, 0), 1, 1e-9),
  `最优顶点 π = (${lp.pi.map((x) => x.toFixed(6)).join(', ')}) = 手算 balanced:premium = 8:1（同一最优面上的另一顶点 4:5 同价）`,
);
ok(
  lp.serviceRates.every((r, i) => r >= LAMBDA[i] - 1e-9),
  `达成服务率 (${lp.serviceRates.map((x) => x.toFixed(6)).join(', ')}) ≥ λ = (0.5, 0.5)（队列 2 恰紧、队列 1 留 0.4 富余）`,
);
ok(
  near(lp.duals[0], DUAL_Y1, 1e-9) && near(lp.duals[1], DUAL_Y2, 1e-9),
  `对偶乘子 y* = (${lp.duals.map((x) => x.toFixed(9)).join(', ')}) = 手算 (0, 10/9)——有限差分方向导数在分段线性片内精确`,
);
ok(
  near(lp.duals.reduce((s, y, i) => s + y * LAMBDA[i], 0) + lp.simplexDual, LP_STAR, 1e-9),
  `强对偶 y*·λ + ν = ${lp.duals.reduce((s, y, i) => s + y * LAMBDA[i], 0).toFixed(9)} + (${lp.simplexDual.toExponential(2)}) = LP* ± 1e-9`,
);
ok(lp.dualFeasible, '对偶可行性审计: y ≥ 0 且 yᵀμ_j + ν ≤ cost_j ∀j（乘子合法）');
ok(
  lp.verticesChecked === 10 && lp.feasibleVertices === 5,
  `枚举候选顶点 C(n+m, m−1) = C(5,2) = ${lp.verticesChecked} 个（可行组合 ${lp.feasibleVertices} 个，退化顶点被多条约束组合复现——组合口径计数）`,
);

const lpInfeasible = lpBenchmark({ actionSet: ACTIONS, arrivalMeans: [1.2, 0.5] });
ok(
  !lpInfeasible.feasible && lpInfeasible.optimalCost === Number.POSITIVE_INFINITY,
  'λ₁ = 1.2 > max μ₁ = 0.9: λ 在容量域外 → feasible=false + optimalCost=∞（诚实返回不可行）',
);
const lpIdle = lpBenchmark({ actionSet: ACTIONS, arrivalMeans: [0, 0] });
ok(lpIdle.feasible && near(lpIdle.optimalCost, 0, 1e-12), 'λ = 0: LP* = 0（恒选 cheap 即可，零负载零成本）');

// ═══════════════════ 背压贪心一步 ═══════════════════

section('54.0 漂移加罚步进: argmin [V·cost − ΣQ·μ] 的手算锚点');

const step1 = driftPlusPenaltyStep([3, 0], [0.5, 0.5], ACTIONS, { V: 2 });
ok(
  step1.index === 0 && near(step1.score, -2.7, 1e-12),
  `Q=(3,0) 选 cheap: score = 2·0 − 3×0.9 = ${step1.score}（balanced −0.35 / premium −0.7 均更大）`,
);
ok(
  near(step1.nextQueues[0], 2.6, 1e-12) && near(step1.nextQueues[1], 0.5, 1e-12),
  `Q(t+1) = [3−0.9+0.5, 0−0+0.5]⁺ = (${step1.nextQueues.join(', ')})`,
);
ok(
  near(step1.prices[0], 1.5, 1e-12) && near(step1.prices[1], 0, 1e-12),
  `对偶价格 p = Q/V = (${step1.prices.join(', ')})`,
);
ok(
  near(step1.certificateResidual, 0.45, 1e-12) && step1.driftRealized <= step1.driftBound,
  `漂移证书: realized(${step1.driftRealized.toFixed(4)}) ≤ bound(${step1.driftBound.toFixed(4)})，残差 = Σaᵢμᵢ = 0.5×0.9 = ${step1.certificateResidual.toFixed(4)}（无触底钳位时不等式严格）`,
);

const step2 = driftPlusPenaltyStep([0, 3], [0.5, 0.5], ACTIONS, { V: 2 });
ok(
  step2.index === 2 && near(step2.score, -0.7, 1e-12),
  `Q=(0,3) 翻转选 premium: 背压项 3×0.9 压过罚项 2（cheap 得 0 分）——积压本身就是优先级`,
);

const step3 = driftPlusPenaltyStep([0, 0], [0.5, 0.5], ACTIONS, { V: 2 });
ok(
  step3.index === 0,
  'Q=(0,0) 退化为纯成本最小 → 选最廉 cheap（背压项全零时 argmin = argmin cost）',
);
ok(
  near(step3.certificateResidual, 0.53, 1e-12),
  `触底钳位残差 = Σaᵢμᵢ + ½D² = 0.45 + ½(0.4²) = ${step3.certificateResidual}（Q₁ 从 0 被 0.9 服务钳在 0）`,
);

const dup = driftPlusPenaltyStep([1, 1], [0, 0], [ACTIONS[0], { ...ACTIONS[0] }, ACTIONS[2]], { V: 1 });
ok(dup.index === 0, '平局取动作集先出者（重复动作选下标 0——顺序即次级优先级）');

const cert = driftCertificate([3, 0], step1.nextQueues, ACTIONS[0].mu, [0.5, 0.5]);
ok(
  near(cert.residual, 0.45, 1e-12) && near(cert.realized, step1.driftRealized, 1e-12),
  'driftCertificate 独立重算与 step 审计一致（同一恒等式的两个入口）',
);

// ═══════════════════ ① 仿真收敛到 LP 混合 ═══════════════════

section('① 2 队列 3 动作: 时间平均成本 → LP* = 5/9，打赢一切纯策略');

const sim = simulatePolicy(50000, { ...BASE, V: 128 }, 42);
ok(
  Math.abs(sim.avgCost - LP_STAR) <= 0.01,
  `漂移加罚(V=128, T=50000) 平均成本 ${sim.avgCost.toFixed(6)} → LP* 5/9 = ${LP_STAR.toFixed(6)} ± 0.01（实测偏差 ${(sim.avgCost - LP_STAR).toFixed(5)} = O(B/V) 次优 + 冷启动瞬态）`,
);
ok(
  Math.abs(sim.actionShares[0] - 4 / 9) <= 0.01 && Math.abs(sim.actionShares[2] - 5 / 9) <= 0.01 && sim.actionShares[1] <= 0.001,
  `分时占空比 (${sim.actionShares.map((x) => x.toFixed(5)).join(', ')}) ≈ LP 混合 cheap 4/9 / premium 5/9 / balanced 0——自动发现分时共享`,
);
ok(
  near(sim.avgService[0], 0.9, 1e-9) && Math.abs(sim.avgService[1] - LAMBDA[1]) <= 0.01,
  `服务守恒: 平均服务率 (${sim.avgService.map((x) => x.toFixed(4)).join(', ')}) —— 队列 2 恰好被服务 λ₂ = 0.5（0.9 × 5/9 占空比）`,
);

const pureNames = ['cheap', 'balanced', 'premium'];
const pure = [0, 1, 2].map((j) => simulatePolicy(20000, { ...BASE, V: 128, policy: 'fixed', fixedActionIndex: j }, 42));
ok(
  near(pure[0].avgCost, 0, 1e-12) && pure[0].avgQueues[1] > 4000,
  `纯 cheap: 成本 0 但队列 2 平均积压 ${pure[0].avgQueues[1].toFixed(0)}（μ₂=0 < λ₂=0.5 线性发散——不稳定，成本数字无意义）`,
);
ok(
  near(pure[1].avgCost, 0.5, 1e-12) && pure[1].avgQueueTotal > 600,
  `纯 balanced: 成本 0.5 但双队列总积压 ${pure[1].avgQueueTotal.toFixed(0)}（0.45 < 0.5 双双缓慢发散）`,
);
ok(
  near(pure[2].avgCost, 1, 1e-12) && pure[2].avgQueueTotal < 5,
  `纯 premium: 稳定（平均总积压 ${pure[2].avgQueueTotal.toFixed(2)}）但恒定成本 1`,
);
ok(
  pure[2].avgCost > sim.avgCost + 0.4,
  `最优稳定纯策略成本 1 ≫ 漂移加罚 ${sim.avgCost.toFixed(6)}（分时把成本砍 44%）——LP 顶点枚举与仿真双口径互证`,
);

// ═══════════════════ ② V 扫描: [O(1/V), O(V)] 权衡 ═══════════════════

section('② V ∈ {1,2,4,…,128}: 成本单调不增 × 队长单调不减');

const VSWEEP = [1, 2, 4, 8, 16, 32, 64, 128];
const sweep = VSWEEP.map((V) => simulatePolicy(30000, { ...BASE, V }, 42));
const costMonotone = sweep.every((s, i) => i === 0 || s.avgCost <= sweep[i - 1].avgCost + 1e-9);
const queueMonotone = sweep.every((s, i) => i === 0 || s.avgQueueTotal >= sweep[i - 1].avgQueueTotal - 1e-9);
ok(
  costMonotone,
  `平均成本随 V 单调不增: ${sweep.map((s) => s.avgCost.toFixed(6)).join(' > ')}`,
);
ok(
  queueMonotone,
  `平均总队长随 V 单调不减: ${sweep.map((s) => s.avgQueueTotal.toFixed(1)).join(' < ')}`,
);
ok(
  sweep.every((s) => s.avgCost >= LP_STAR - 0.01) && sweep[sweep.length - 1].avgCost <= LP_STAR + 0.01,
  `成本夹逼 [LP* − 0.01, LP* + 0.01] 的下界成立 + V=128 触上界（实测 V=128 偏差 +${(sweep[sweep.length - 1].avgCost - LP_STAR).toFixed(5)}；有限样本冷启动可略低于 LP*，不容许显著更低——那是违背 LP 最优性）`,
);
const tailSlope = sweep.slice(5).every((s) => Math.abs(s.avgQueues[1] / s.V - DUAL_Y2) <= 0.03);
ok(
  tailSlope,
  `O(V) 队长斜率读数: V ≥ 32 时 Q̄₂/V ∈ 10/9 ± 0.03（实测 ${sweep.slice(5).map((s) => (s.avgQueues[1] / s.V).toFixed(4)).join(', ')} → 对偶价格 y₂* = 10/9 的队长镜像）`,
);

// ═══════════════════ ③ 队列稳定: 次线性增长 ═══════════════════

section('③ 平均队长随 T 次线性: T=10⁴/T=10³ 比值对照');

const dppShort = simulatePolicy(1000, { ...BASE, V: 64 }, 42);
const dppLong = simulatePolicy(10000, { ...BASE, V: 64 }, 42);
const ratioDpp = dppLong.avgQueueTotal / dppShort.avgQueueTotal;
ok(
  ratioDpp < 3,
  `漂移加罚(V=64): 比值 ${ratioDpp.toFixed(3)} < 3（次线性，均值稳态 ${dppShort.avgQueueTotal.toFixed(1)} → ${dppLong.avgQueueTotal.toFixed(1)}；锚点阈 < 10，线性增长会得 T₂/T₁ = 10）`,
);
const cheapShort = simulatePolicy(1000, { ...BASE, V: 64, policy: 'fixed', fixedActionIndex: 0 }, 42);
const cheapLong = simulatePolicy(10000, { ...BASE, V: 64, policy: 'fixed', fixedActionIndex: 0 }, 42);
const ratioCheap = cheapLong.avgQueueTotal / cheapShort.avgQueueTotal;
ok(
  ratioCheap > 7,
  `对照恒定 cheap 策略: 比值 ${ratioCheap.toFixed(2)} ≈ 10（线性增长 λT/2——不稳定的队列把「平均队长」变成 T 的线性函数）`,
);
ok(
  dppLong.maxQueueTotal < 10 * 64,
  `漂移加罚峰值总队长 ${dppLong.maxQueueTotal.toFixed(1)} < 10V = 640（O(V) 定理的上界量级；锯齿带宽 O(λ) ≪ V）`,
);

// ═══════════════════ ④ 对偶价格收敛 ═══════════════════

section('④ 对偶价格 p = Q/V → LP 乘子 y* = (0, 10/9)');

const p = dualPrices(sim.queueTail, 128);
ok(
  Math.abs(p[1] - DUAL_Y2) <= 0.03 && Math.abs(p[0] - DUAL_Y1) <= 0.03,
  `末端窗口均值 p̄ = (${p.map((x) => x.toFixed(5)).join(', ')}) → y* = (0, 10/9)（容差 0.03；偏差 = 冷启动爬坡 + 容量边界锯齿半宽 O(λ)/1）`,
);
ok(
  p[1] > p[0],
  `方向断言: p̄₂ > p̄₁（瓶颈队列 2 的乘子为正、富余队列 1 归零——互补松弛的仿真读数）`,
);
ok(
  p.every((x, i) => near(x, sim.dualPrices[i], 1e-12)),
  'dualPrices(queueTail) 与 sim.dualPrices 逐位一致（同一函数两条路径）',
);
ok(
  Math.abs(p[1] - lp.duals[1]) <= 0.03,
  `仿真价格与 lpBenchmark 乘子对账: |p̄₂ − y₂*| = ${Math.abs(p[1] - lp.duals[1]).toFixed(5)} ≤ 0.03——影子价格是队列深度长出来的，不是估出来的`,
);

// ═══════════════════ ⑤ 逐槽漂移证书 + 到达模式 ═══════════════════

section('⑤ 逐槽漂移证书（路径必然不等式）与到达模式');

ok(
  sim.certificateMinResidual >= -1e-9,
  `poisson 全程 ${sim.steps} 槽最小证书残差 ${sim.certificateMinResidual.toExponential(3)} ≥ −1e-9（数学恒 ≥ 0；1e-12 尘埃 = Q≈142 处 IEEE 消去）`,
);
const det = simulatePolicy(5000, { ...BASE, V: 16, arrivalMode: 'deterministic' }, 7);
ok(
  det.certificateMinResidual >= 0.45 - 1e-9,
  `确定性到达: 残差 ≥ Σaᵢμᵢ 下界 0.45（实测最小 ${det.certificateMinResidual.toFixed(3)}——无随机抖动时证书最厚实，触底钳位只增不减）`,
);
ok(
  det.avgQueues[0] === 0,
  '确定性到达下富余队列被精确掏空: Q̄₁ ≡ 0（μ₁ = 0.9 > λ₁ = 0.5 每槽清干——互补松弛 y₁* = 0 的确定性版本）',
);
ok(
  Math.abs(det.avgCost - LP_STAR) <= 0.01,
  `确定性到达平均成本 ${det.avgCost.toFixed(6)} 仍夹逼 LP* ± 0.01（偏差 −0.004 = 冷启动爬坡期 0 成本摊薄）`,
);
const bur = simulatePolicy(5000, { ...BASE, V: 16, arrivalMode: 'bursty' }, 7);
ok(
  bur.certificateMinResidual >= -1e-9 && bur.avgArrival.every((a) => Math.abs(a - 0.5) <= 0.05) && bur.driftConstantB > 20,
  `突发到达(10% 概率 ×10λ): 证书仍成立、均值守恒 (${bur.avgArrival.map((x) => x.toFixed(4)).join(', ')}) ≈ 0.5、经验漂移常数 B = ${bur.driftConstantB.toFixed(1)} > 20（方差 ×90 被背压吸收，队列稳定定理不依赖到达分布形状）`,
);

// ═══════════════════ 入参防御 ═══════════════════

section('入参防御: 显式 throw（非法输入不静默）');

okThrow(() => driftPlusPenaltyStep([1], [1, 1], ACTIONS, { V: 1 }), 'queues/arrivals 长度不一致 → throw');
okThrow(() => driftPlusPenaltyStep([1, 1], [1, 1], ACTIONS, { V: 0 }), 'V = 0 → throw');
okThrow(() => driftPlusPenaltyStep([1, 1], [1, 1], [], { V: 1 }), '空动作集 → throw');
okThrow(() => driftPlusPenaltyStep([-1, 1], [1, 1], ACTIONS, { V: 1 }), '负队列 → throw');
okThrow(() => driftPlusPenaltyStep([1, 1], [1, 1], [{ id: 'x', mu: [0.5], cost: 0 }], { V: 1 }), 'mu 长度 ≠ 队列数 → throw');
okThrow(() => driftPlusPenaltyStep([1, 1], [1, 1], [{ id: 'x', mu: [0.5, 0.5], cost: Number.NaN }], { V: 1 }), 'cost 非有限 → throw');
okThrow(() => driftPlusPenaltyStep([1, 1], [1, 1], ACTIONS, { V: 1, cost: 'free' }), 'cost 覆盖非函数 → throw');
okThrow(() => simulatePolicy(0, { ...BASE, V: 1 }, 1), 'T = 0 → throw');
okThrow(() => simulatePolicy(100, { ...BASE, V: 1, policy: 'fixed' }, 1), 'fixed 策略缺 fixedActionIndex → throw');
okThrow(() => simulatePolicy(100, { ...BASE, V: 1, policy: 'fixed', fixedActionIndex: 3 }, 1), 'fixedActionIndex 越界 → throw');
okThrow(() => simulatePolicy(100, { ...BASE, V: 1, arrivalMode: 'poisson', arrivalMeans: [100, 0.5] }, 1), 'poisson λ > 64 → throw');
okThrow(() => simulatePolicy(100, { ...BASE, V: 1, arrivalMode: 'rain' }, 1), '未知到达模式 → throw');
okThrow(() => simulatePolicy(100, { ...BASE, V: 1, policy: 'oracle' }, 1), '未知策略 → throw');
okThrow(() => simulatePolicy(100, { ...BASE, V: 1 }, 1.5), 'seed 非整数 → throw');
okThrow(
  () =>
    lpBenchmark({
      actionSet: Array.from({ length: 13 }, (_, j) => ({ id: `a${j}`, mu: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].map(() => j % 2), cost: j })),
      arrivalMeans: new Array(12).fill(0.1),
    }),
  'lpBenchmark C(n+m, m−1) = C(25,12) ≈ 520 万 > 20000 → throw（小实例契约护栏）',
);
okThrow(() => dualPrices([], 1), 'dualPrices 空轨迹 → throw');
okThrow(() => dualPrices([[1, 2]], -1), 'dualPrices V = −1 → throw');
okThrow(() => dualPrices([[1, 2], [1]], 1), 'dualPrices 样本长度不齐 → throw');
okThrow(() => backpressureInsight([1, 1], 0), 'backpressureInsight V = 0 → throw');

// ═══════════════════ 接线桥 ═══════════════════

section('接线桥 backpressureInsight: 价格超阈才发声（缺省零介入）');

ok(
  backpressureInsight([1, 1], 128) === undefined,
  '健康队列 p = (0.008, 0.008) < 阈 1.5 → undefined（容量富余时洞察器沉默——零介入）',
);
const insight = backpressureInsight([0, 5], 2, { names: ['strategy-pool', 'tenant-hot'] });
ok(
  insight !== undefined && insight.severity > 0 && insight.severity <= 0.9 && insight.message.includes('tenant-hot') && insight.message.includes('2.50'),
  `瓶颈队列发声: p = (0, 2.50) 超阈 → severity ${insight.severity.toFixed(2)}，消息定位 tenant-hot 与对偶价格（喂 41.0 瓶颈洞察 / 25.0 扩容反解）`,
);

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 54.0 Lyapunov 漂移加罚内核数学验证成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
