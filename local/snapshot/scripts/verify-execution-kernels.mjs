/**
 * verify-execution-kernels.mjs — 86.0/87.0「自主执行双件套」两内核纯数学离线验证
 *
 * 每个内核的数学核心都有解析解对照（不是「能跑」，是「算得对」）:
 *   86.0 分层技能内核（选项框架 + SMDP）:
 *     构造  11×11 四房间 2×2 门环（Sutton–Precup–Singh 经典）: 104 可走格 /
 *           4 门环形拓扑 / BFS 距离手工锚点（(10,9)→1、(10,0)→12、(0,0)→20 = 全图最长）
 *     锚点② 确定性环境精确断言: 确定性宏模型 + 值迭代解出 Q*；α=1 的 SMDP
 *           Q-learning（= 异步值迭代）收敛到同一张表（逐元素差 + Bellman
 *           残差 ≤ 1e-9）; intra-option Q-learning 从**原步经验**收敛到同一
 *           Q*（每步更新所有一致选项——双口径互证同一不动点）
 *     锚点③ 技能组合: 贪婪执行宏 Q 从全部 103 个非目标态到达目标
 *           （成功率 ≥ 98%，实测 100%，平均步数 ≈ BFS 最优 + 小损耗）
 *     锚点④ 折价陷阱: 一维走廊解析例——k=3 的宏 Q* = γ³ 而 γ¹ 误用收敛到 γ
 *           （偏差 γ−γ³ = 0.092625 精确对照，optionBellmanResidual 对陷阱 Q
 *           的最大残差恰等于该偏差; k=1 处两口径重合——陷阱只在宏步长>1 显形）;
 *           四房间上 γ¹ 陷阱收敛后真模型残差 > 0.05（诚实量化）
 *     锚点① 样本效率（corridorGridworld 四房间走廊: 4 房间排成线、27 步最优
 *           路径、目标 = 末门后一步的里程碑链）: 200 种子公平对照（同种子/同
 *           ε/同 α/同无上限回合/种子化随机破平）下，分层 SMDP「解题所需累计
 *           环境步数」显著少于平坦 Q-learning（加速比 ≥ 1.5 断言，实测 ~180×:
 *           ~0.3k vs ~58k 步）; 诚实对照: 平坦侧 200/200 种子同样解题且收敛后
 *           两者都近最优——省的是学费不是终点; 边界条件文档化（2×2 小世界上
 *           原步扩散足够强，两者相近——技能收益依赖任务-技能对齐）
 * 87.0 安全屏障内核（离散时间 CBF 安全滤波）:
 *     构造  双积分器刹车屏障 h = (p_obs−p) − v²/(2b): u=−b 时 h 一步不变
 *           （代数恒等式，1e-12 内验证）→ aMin ≤ −b 时 h≥0 处永不 infeasible
 *     锚点② 最小修改性: 可行域内部 → u === u_desired（零修改精确等值）;
 *           边界处 → cbfFilter = 20001 点一维网格枚举的最近可行点（网格间距
 *           内一致 + 可行性 + 距离不劣于网格最优）
 *     锚点③ 无可行死角: 无刹车执行器（aMin=0）高速态 → infeasible + 最小
 *           违反量 = (1−η)h₀ − h(f(x,0)) = 0.805 精确断言（诚实拒绝而非截断）
 *     锚点① 闭环安全: 贪婪危险策略（满加速）+ 12 种子扰动，CBF 全程 0 违反
 *           0 infeasible; 朴素截断对照越界（违反例 ≥ 1，实测 12/12）;
 *           安全策略下滤波零修改（不保守——屏障是过滤器不是节流阀）
 *     锚点④ η 单调: η ∈ {0.05,0.2,0.4,0.6} 扫描 min-h 非降（η 小=保守方向
 *           正确）且全程安全（归纳证书 h_k ≥ (1−η)^k h₀ > 0 生效）;
 *           2D 动作网格 QP-lite 与脚本侧同分辨率暴力枚举逐位一致（含平局规则）
 *
 * 全部断言确定性（随机处用 mulberry32 种子 + 内核自带随机源）。
 * 运行：node --experimental-strip-types scripts/verify-execution-kernels.mjs
 */

import {
  fourRoomsGridworld,
  corridorGridworld,
  hallwayOptions,
  primitiveOptions,
  smdpQLearning,
  flatQLearning,
  intraOptionQLearning,
  solveSmdpExact,
  optionBellmanResidual,
  smokeTestPolicy,
} from '../src/core/options-framework.ts';
import {
  cbfFilter,
  brakeDoubleIntegrator,
  simulateClosedLoop,
  violationReport,
  BARRIER_VIOLATION_TOL,
} from '../src/core/safety-barrier.ts';

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
function mean(xs) {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** 确定性 RNG（mulberry32，脚本侧扰动策略用; 内核侧自带同款） */
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

const GAMMA = 0.95;
const world = fourRoomsGridworld();
const options = [...hallwayOptions(world), ...primitiveOptions(world)];
const rowIndex = new Map(world.states.map((s, i) => [s, i]));

// ═══════════════════ 86.0 分层技能内核 ═══════════════════

section('86.0 四房间构造: 104 格 / 4 门环 / BFS 距离手工锚点');

{
  ok(world.states.length === 104, `可走格 ${world.states.length} = 121 − 17 墙（十字墙 9+9−1）`);
  ok(world.doors.length === 4, `门格 ${world.doors.length} 个: ${world.doors.map((d) => `(${d % 11},${(d - (d % 11)) / 11})`).join(' ')}`);
  ok(world.optimalStepsToGoal(9 * 11 + 10) === 1, `optimalStepsToGoal((10,9)) = ${world.optimalStepsToGoal(9 * 11 + 10)}（目标邻格 1 步）`);
  ok(world.optimalStepsToGoal(0 * 11 + 10) === 12, `optimalStepsToGoal((10,0)) = ${world.optimalStepsToGoal(0 * 11 + 10)}（右上角穿门 (9,5) 下行 = 12，手算锚点）`);
  const d00 = world.optimalStepsToGoal(0);
  ok(d00 === 20, `optimalStepsToGoal((0,0)) = ${d00}（左上角到右下角必穿两门 = 20，两条环路径等长）`);
  const maxD = Math.max(...world.states.map((s) => world.optimalStepsToGoal(s)));
  ok(maxD === 20, `全图最长最优步数 = ${maxD}（(0,0) 是最难起点）`);
  ok(world.roomOf(0) === 0 && world.roomOf(10) === 1 && world.roomOf(110) === 2 && world.roomOf(120) === 3, 'roomOf 四象限 0/1/2/3 正确');
  ok(options.length === 8, `选项数 ${options.length} = 4 走廊技能 + 4 原步（SMDP 经典混用——保证目标格可达）`);
}

section('86.0 锚点② SMDP Bellman 残差 → 0（确定性环境精确断言）');

{
  // 独立对照: 确定性宏模型 + 值迭代 = Q*（收缩映射几何收敛）
  const exact = solveSmdpExact({ world, options, gamma: GAMMA, tol: 1e-13 });
  ok(exact.converged && exact.residual <= 1e-12, `值迭代精确解: ${exact.iterations} 轮收敛，自身残差 ${exact.residual.toExponential(2)} ≤ 1e-12`);

  // SMDP Q-learning（α=1 ⟹ 每次更新都是精确 Bellman 备份 = 异步值迭代）
  const smdp = smdpQLearning({ world, options, episodes: 60000, seed: 7, gamma: GAMMA });
  const resSmdp = optionBellmanResidual({ world, options, Q: smdp.Q, gamma: GAMMA });
  ok(resSmdp.maxResidual <= 1e-9, `SMDP Q-learning（60000 回合）收敛残差 ${resSmdp.maxResidual.toExponential(2)} ≤ 1e-9（γ^k 宏口径 Bellman 方程在收敛处精确成立）`);
  let maxDiff = 0;
  for (let r = 0; r < exact.Q.length; r += 1) {
    for (let c = 0; c < exact.Q[r].length; c += 1) maxDiff = Math.max(maxDiff, Math.abs(smdp.Q[r][c] - exact.Q[r][c]));
  }
  ok(maxDiff <= 1e-9, `Q-learning 与值迭代两条路到达同一张表: 逐元素最大差 ${maxDiff.toExponential(2)} ≤ 1e-9`);

  // intra-option Q-learning: 原步经验（每步更新所有一致选项）→ 同一 Q*
  const intra = intraOptionQLearning({ world, options, episodes: 40000, seed: 11, gamma: GAMMA });
  const resIntra = optionBellmanResidual({ world, options, Q: intra.Q, gamma: GAMMA });
  ok(resIntra.maxResidual <= 1e-9, `intra-option Q-learning（40000 回合，原步经验学技能）残差 ${resIntra.maxResidual.toExponential(2)} ≤ 1e-9（与宏模型同一不动点）`);
  let maxDiffIntra = 0;
  for (let r = 0; r < exact.Q.length; r += 1) {
    for (let c = 0; c < exact.Q[r].length; c += 1) maxDiffIntra = Math.max(maxDiffIntra, Math.abs(intra.Q[r][c] - exact.Q[r][c]));
  }
  ok(maxDiffIntra <= 1e-9, `intra-option 表与值迭代精确解逐元素最大差 ${maxDiffIntra.toExponential(2)} ≤ 1e-9`);
}

section('86.0 锚点③ 技能组合: 贪婪执行宏 Q 到达目标');

{
  const trained = smdpQLearning({ world, options, episodes: 60000, seed: 7, gamma: GAMMA });
  const starts = world.states.filter((s) => s !== world.goal);
  const smoke = smokeTestPolicy({ world, options, Q: trained.Q, starts });
  const meanOptimal = mean(starts.map((s) => world.optimalStepsToGoal(s)));
  ok(smoke.successRate >= 0.98, `全部 ${starts.length} 个非目标起态贪婪执行宏 Q: 成功率 ${(smoke.successRate * 100).toFixed(1)}% ≥ 98%（失败 ${smoke.failures.length} 个）`);
  ok(smoke.meanSteps <= meanOptimal + 2, `平均步数 ${smoke.meanSteps.toFixed(2)} ≤ BFS 最优均值 ${meanOptimal.toFixed(2)} + 2（技能组合几乎不付组合损耗）`);
  const far = smoke.steps[starts.indexOf(0)];
  ok(far <= 20 + 6, `最难起点 (0,0) 贪婪执行 ${far} 步（最优 20，宏边界容差 +6）`);
}

section('86.0 锚点④ 折价正确性: γ^k 用实际宏步长（陷阱例量化）');

{
  // ── 一维走廊解析例: 5 格 [0..4]，目标 4，技能 ω = 走到格 3 停 ──
  // 从 0: k=3（0→1→2→3），途中零回报 ⟹ Q*(0,ω) = γ³·maxQ(3) = γ³·1 = γ³
  // γ¹ 误用: Q_trap(0,ω) = γ·1 = γ —— 偏差 = γ − γ³（纯折价指数误差，精确可算）
  const corridor = {
    width: 5,
    height: 1,
    states: [0, 1, 2, 3, 4],
    goal: 4,
    doors: [],
    step(s, action) {
      if (action === 1 && s < 4) {
        return { sNext: s + 1, reward: s + 1 === 4 ? 1 : 0, done: s + 1 === 4 };
      }
      if (action === 3 && s > 0) return { sNext: s - 1, reward: 0, done: false };
      return { sNext: s, reward: 0, done: false };
    },
    neighbors(s) {
      const out = [];
      if (s > 0) out.push(s - 1);
      if (s < 4) out.push(s + 1);
      return out;
    },
    roomOf() {
      return 0;
    },
    distance(s, target) {
      return Math.abs(s - target);
    },
    optimalStepsToGoal(s) {
      return 4 - s;
    },
  };
  const toMid = {
    id: 'walk-to-3',
    kind: 'hallway',
    description: '走廊技能: 走到格 3 停（k = 3−s）',
    initiation: (s) => s < 3,
    policy: () => 1,
    beta: (s) => (s === 3 ? 1 : 0),
  };
  const corridorOptions = [...primitiveOptions(corridor), toMid];
  const dur = smdpQLearning({ world: corridor, options: corridorOptions, episodes: 3000, seed: 3, gamma: GAMMA });
  const unit = smdpQLearning({ world: corridor, options: corridorOptions, episodes: 3000, seed: 3, gamma: GAMMA, discountExponentMode: 'unit' });
  const qDur = dur.Q[0][corridorOptions.length - 1];
  const qUnit = unit.Q[0][corridorOptions.length - 1];
  ok(near(qDur, GAMMA ** 3, 1e-9), `正确口径: Q(0, ω_{k=3}) = γ³ = ${qDur.toFixed(9)}（折价指数 = 实测宏步长）`);
  ok(near(qUnit, GAMMA, 1e-9), `γ¹ 陷阱: 同一状态收敛到 γ = ${qUnit.toFixed(9)}（把宏当原子步 → 错误算子的不动点）`);
  ok(near(qUnit - qDur, GAMMA - GAMMA ** 3, 1e-12), `偏差 = γ − γ³ = ${(GAMMA - GAMMA ** 3).toFixed(6)}（精确对照）`);
  const qDur1 = dur.Q[2][corridorOptions.length - 1];
  const qUnit1 = unit.Q[2][corridorOptions.length - 1];
  ok(near(qDur1, qUnit1, 1e-9), `k=1 处（从格 2 启动，1→3 一步即停）两口径重合: ${qDur1.toFixed(9)} = ${qUnit1.toFixed(9)}（陷阱只在宏步长 > 1 处显形）`);
  const resDur = optionBellmanResidual({ world: corridor, options: corridorOptions, Q: dur.Q, gamma: GAMMA });
  const resUnit = optionBellmanResidual({ world: corridor, options: corridorOptions, Q: unit.Q, gamma: GAMMA });
  ok(resDur.maxResidual <= 1e-9, `正确 Q 的 Bellman 残差 ${resDur.maxResidual.toExponential(2)} ≤ 1e-9`);
  ok(near(resUnit.maxResidual, GAMMA - GAMMA ** 3, 1e-9), `陷阱 Q 的最大残差 ${resUnit.maxResidual.toFixed(6)} = γ − γ³（残差函数本身就是陷阱探测器）`);

  // ── 四房间上同款陷阱: γ¹ 陷阱收敛后，真模型（γ^k）残差显著 > 0 ──
  const trapFR = smdpQLearning({ world, options, episodes: 60000, seed: 7, gamma: GAMMA, discountExponentMode: 'unit' });
  const resTrap = optionBellmanResidual({ world, options, Q: trapFR.Q, gamma: GAMMA });
  ok(resTrap.maxResidual > 0.05, `四房间 γ¹ 陷阱: 收敛后真模型残差 ${resTrap.maxResidual.toFixed(4)} > 0.05（最坏处 ${resTrap.worst ? `状态 ${resTrap.worst.s} / ${resTrap.worst.optionId}` : '—'}——宏步长可达 ~14 步，|γ¹−γ^k|·V 量级）`);
}

section('86.0 锚点① 200 种子样本效率: 分层 SMDP vs 平坦 Q-learning（四房间走廊）');

{
  // 实验场: corridorGridworld——4 房间 × 8 宽 × 5 高的走廊（27 长最优路径），目标 =
  // 最后一扇门后一步（里程碑链任务的规范形态: 技能终点即子目标——门高速路对齐，
  // 与锚点④的走廊构造同构）。协议要点（全部公平 + 零可调参数）:
  //   固定起点 (0,2) / 零初始化 / 种子化随机破平（消除确定性破平的策略锁定）
  //   / ε=0.1 / α=1 / 回合无上限（防呆 100000，实测最长 ~15000，从不触发）
  // 判据: 「解题所需环境步数」= 到达首个「连续 25 回合平均步数 ≤ 3×最优」片段
  // 之前的累计环境步数（步数口径——无上限下成功率判据退化，因每回合必然到达）。
  // 结构机理: 准一维走廊上原步随机游走的命中时间 ~O(长度²) ≈ 4700 步且价值链
  // 必须逐格传播 27 深; 「走到门口」技能把走廊压缩为 3 个宏决策（γ^k 信用一步
  // 跨过整段房间）——时间抽象的样本效率优势在长走廊上结构性显现。
  // 边界条件（诚实文档化）: 2×2 四房间（最优路径 20，角落在门漏斗旁）上原步
  // 扩散足够强，同协议下两者相近（~1.2×）——技能的收益依赖任务与技能对齐，
  // 长计划 + 里程碑结构正是任务执行器 DAG 节点的形态。
  const corridorWorld = corridorGridworld({ goalX: 27 });
  const corridorSkills = [...hallwayOptions(corridorWorld, { restrictToAdjacentRooms: true }), ...primitiveOptions(corridorWorld)];
  const START = 2 * corridorWorld.width; // (0,2)
  const OPTIMAL = corridorWorld.optimalStepsToGoal(START);
  const CAP = 100000; // 防呆上限（从不触发——无上限协议）
  const EPISODES = 400;
  const WINDOW = 25;
  const solveCost = (r) => {
    for (let e = 0; e + WINDOW <= r.stepsPerEpisode.length; e += 1) {
      if (mean(r.stepsPerEpisode.slice(e, e + WINDOW)) <= 3 * OPTIMAL) {
        let c = 0;
        for (let i = 0; i < e; i += 1) c += r.stepsPerEpisode[i];
        return c;
      }
    }
    return r.stepsPerEpisode.reduce((a, b) => a + b, 0);
  };
  const SEEDS = 200;
  const hierCosts = [];
  const flatCosts = [];
  const hierTails = [];
  const flatTails = [];
  const t0 = Date.now();
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    // 公平对照: 同种子、同 ε=0.1、同 α=1、同无上限回合、同世界、同起点
    const h = smdpQLearning({ world: corridorWorld, options: corridorSkills, episodes: EPISODES, seed, gamma: GAMMA, epsilon: 0.1, tieBreak: 'random', startCell: START, maxStepsPerEpisode: CAP });
    const f = flatQLearning({ world: corridorWorld, episodes: EPISODES, seed, gamma: GAMMA, epsilon: 0.1, tieBreak: 'random', startCell: START, maxStepsPerEpisode: CAP });
    hierCosts.push(solveCost(h));
    flatCosts.push(solveCost(f));
    hierTails.push(mean(h.stepsPerEpisode.slice(-25)));
    flatTails.push(mean(f.stepsPerEpisode.slice(-25)));
  }
  const hierAvg = mean(hierCosts);
  const flatAvg = mean(flatCosts);
  const speedup = flatAvg / hierAvg;
  const flatSolved = flatCosts.filter((c) => c < EPISODES * CAP * 0.5).length;
  const hierSolved = hierCosts.filter((c) => c < EPISODES * CAP * 0.5).length;
  ok(speedup >= 1.5, `200 种子解题所需累计环境步数: SMDP ${hierAvg.toFixed(0)} vs 平坦 ${flatAvg.toFixed(0)}，加速比 ${speedup.toFixed(1)} ≥ 1.5（3 个宏决策 vs 27 深原步价值链）`);
  ok(hierSolved === SEEDS, `SMDP ${hierSolved}/${SEEDS} 种子在预算内达到解题判据`);
  ok(flatSolved >= SEEDS * 0.9, `平坦 Q-learning ${flatSolved}/${SEEDS} ≥ 90% 同样解题（诚实对照: 两边都到达终点——省的是学费，不是终点）`);
  const hierTail = mean(hierTails);
  const flatTail = mean(flatTails);
  ok(hierTail <= 35 && flatTail <= 45, `收敛后（末 25 回合均值）: SMDP ${hierTail.toFixed(1)} / 平坦 ${flatTail.toFixed(1)}（最优 ${OPTIMAL}，两者都近最优）`);
  ok(hierTail <= flatTail + 1, `收敛后 SMDP (${hierTail.toFixed(1)}) 不劣于平坦 (${flatTail.toFixed(1)})`);
  console.log(`  … ${SEEDS} 种子 × 2 learner × ${EPISODES} 回合耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ═══════════════════ 87.0 安全屏障内核 ═══════════════════

section('87.0 刹车屏障构造: 代数恒等式 h(f(x,−b)) = h(x)');

{
  const brake = brakeDoubleIntegrator(); // p_obs=10, dt=0.1, aMin=−5, aMax=2, b=5, η=0.6
  const h0 = brake.h([0, 2]);
  ok(near(h0, 10 - 0 - (2 * 2) / 10, 1e-12), `h([0,2]) = ${h0}（剩余距离 10 − 刹车距离 0.4）`);
  const x1 = brake.spec.dynamics([0, 2], [-5]);
  const drift = Math.abs(brake.h(x1) - h0);
  ok(drift <= 1e-12, `u = −b 一步: h 不变（|Δh| = ${drift.toExponential(2)} ≤ 1e-12，两项相消的代数恒等式）⟹ aMin ≤ −b 时 h≥0 处屏障条件恒可行`);
}

section('87.0 锚点② 最小修改性: cbfFilter = 安全集中距 u_des 最近者');

{
  const brake = brakeDoubleIntegrator(); // η=0.6
  // ── 可行域内部: 期望动作本身安全 → 零修改（精确等值） ──
  const inside = cbfFilter([0, 3], 2, brake.spec);
  ok(inside.method === 'zero-modification' && inside.u[0] === 2 && !inside.infeasible, `安全动作直接放行: u = [${inside.u}] === u_des = [2]（零修改，margin = ${inside.margin.toFixed(3)} > 0）`);

  // ── 边界处: 20001 点网格枚举精确对照（独立重算 h/dynamics） ──
  const b = 5;
  const dt = 0.1;
  const pObs = 10;
  const hOf = (x) => pObs - x[0] - (x[1] > 0 ? (x[1] * x[1]) / (2 * b) : 0);
  const fOf = (x, u) => [x[0] + x[1] * dt + 0.5 * u * dt * dt, x[1] + u * dt];
  const strict = { ...brake.spec, eta: 0.05 };
  const N = 20001;
  const spacing = (2 - -5) / (N - 1);
  let allWithin = true;
  let allFeasible = true;
  const cases = [];
  for (const v of [5.5, 6.5, 7.5]) {
    for (const ud of [2, 1.4]) {
      const x = [0, v];
      const hNow = hOf(x);
      const thr = (1 - 0.05) * hNow;
      const r = cbfFilter(x, ud, strict);
      // 网格枚举: 最近可行点
      let gridBest = null;
      for (let i = 0; i < N; i += 1) {
        const u = -5 + (i * 7) / (N - 1);
        if (hOf(fOf(x, [u][0])) >= thr) {
          if (gridBest === null || Math.abs(u - ud) < Math.abs(gridBest - ud)) gridBest = u;
        }
      }
      const feasible = r.hNext >= thr - 1e-9 && !r.infeasible;
      const withinGrid = gridBest !== null && Math.abs(r.u[0] - gridBest) <= spacing * 1.01 + 1e-9;
      const notWorse = gridBest !== null && Math.abs(r.u[0] - ud) <= Math.abs(gridBest - ud) + spacing + 1e-9;
      allFeasible = allFeasible && feasible;
      allWithin = allWithin && withinGrid && notWorse;
      cases.push(`v=${v},u_des=${ud}: 滤波 ${r.u[0].toFixed(4)} vs 网格 ${gridBest === null ? '∅' : gridBest.toFixed(4)}（间距 ${spacing.toExponential(1)}）`);
    }
  }
  ok(allFeasible, `边界处 6 个 (速度,期望) 组合全部可行: margin ≥ −1e-9（η=0.05 严格屏障）`);
  ok(allWithin, `滤波输出 = 网格枚举最近可行点（间距内一致且距离不劣于网格最优）——[${cases[0]}; ${cases[3]}]`);
}

section('87.0 锚点③ 无可行死角: infeasible + 最小违反量（诚实拒绝）');

{
  // 无刹车执行器（aMin = 0）: 证书假设 b=5，但执行器只能不加速/加速
  // v=9: h₀ = 10 − 81/10 = 1.9; 即便 u=0（最优努力）h' = 10 − 0.9 − 8.1 = 1.0
  // 阈值 (1−η)h₀ = 0.95×1.9 = 1.805 ⟹ 最小违反量 = 1.805 − 1.0 = 0.805（精确）
  const noBrake = brakeDoubleIntegrator({ aMin: 0, eta: 0.05 });
  const r = cbfFilter([0, 9], 2, noBrake.spec);
  ok(r.infeasible === true, `死角: [p=0, v=9] 无刹车道 → infeasible = true（拒绝而非静默截断）`);
  ok(near(r.u[0], 0, 1e-9), `最优努力 u = [${r.u[0].toFixed(6)}]（uMin = 0——最大化 h(x') 的动作）`);
  ok(near(r.minViolation, 0.805, 1e-9), `最小违反量 = (1−η)h₀ − max_u h' = 1.805 − 1.0 = ${r.minViolation.toFixed(9)}（精确断言——上报量而非粉饰量）`);
  ok(near(r.margin, -0.805, 1e-9), `margin = ${r.margin.toFixed(6)}（负值即差多少才够）`);
  const report = violationReport(simulateClosedLoop([0, 9], () => 2, noBrake.spec, 5, 1));
  ok(report.infeasibleCount === 5 && !report.safe, `闭环 5 步全部 infeasible（每步都被诚实标记，可升级给安全总督）`);
}

section('87.0 锚点① 闭环安全: CBF 0 违反 vs 朴素截断越界');

{
  const brake = brakeDoubleIntegrator(); // η=0.6, aMin=−5 = −b ⟹ h≥0 恒可行
  // ── 安全策略: 持续温和刹车 → 屏障应零修改（不保守） ──
  const safePolicy = () => -1;
  const cbfSafe = simulateClosedLoop([0, 2], safePolicy, brake.spec, 60, 1);
  const zeroMod = cbfSafe.trajectory.every((st) => st.method === 'zero-modification');
  const repSafe = violationReport(cbfSafe);
  ok(repSafe.safe && zeroMod, `安全动作全程零修改放行（60 步 method 全为 zero-modification）——屏障是过滤器不是节流阀`);
  ok(cbfSafe.finalX[1] < 0.05 && brake.h(cbfSafe.finalX) > 9, `安全策略下远离障碍: 终态 v=${cbfSafe.finalX[1].toFixed(2)}（减速至反向漂移），h=${brake.h(cbfSafe.finalX).toFixed(2)} > 9（障碍在对侧）`);

  // ── 危险策略: 持续满加速（贪婪油门）── 朴素截断对照越界
  const dangerPolicy = () => 2;
  const naive = simulateClosedLoop([0, 2], dangerPolicy, brake.spec, 300, 1, { filter: 'clamp-only' });
  const repNaive = violationReport(naive);
  ok(repNaive.violations >= 1 && repNaive.hMin < 0, `朴素截断（只钳边界不过屏障）: ${repNaive.violations} 步越界，穿透深度 h_min = ${repNaive.hMin.toFixed(1)} < 0（首违反步 #${naive.violationSteps[0]}——危险的是动作方向，不是模长）`);
  ok(naive.finalX[0] > brake.obstaclePosition, `朴素截断最终撞穿障碍: p = ${naive.finalX[0].toFixed(2)} > ${brake.obstaclePosition}`);

  // ── 同款危险策略 + 12 种子扰动: CBF 全程 0 违反 0 infeasible ──
  let allSafe = true;
  let hMinAll = Infinity;
  const noisyPolicy = (x, t, rng) => 2 * (0.8 + 0.4 * rng());
  for (let seed = 1; seed <= 12; seed += 1) {
    const run = simulateClosedLoop([0, 2], noisyPolicy, brake.spec, 300, seed);
    const rep = violationReport(run);
    if (!(rep.safe && run.infeasibleCount === 0)) allSafe = false;
    hMinAll = Math.min(hMinAll, run.hMin);
  }
  ok(allSafe, `贪婪危险策略 + 12 种子扰动全过屏障: 12/12 全程 0 违反、0 infeasible（h_k ≥ (1−η)^k h₀ > 0 归纳证书生效）`);
  ok(hMinAll >= -BARRIER_VIOLATION_TOL, `12 条轨迹全程最小 h = ${hMinAll.toExponential(2)} ≥ −1e-9（裕度被烧到指数级小但永不触零——η 的几何下界）`);
}

section('87.0 锚点④ η 单调 + 2D 网格 QP-lite 与暴力枚举一致');

{
  // ── η 扫描: η 小 = 每步须保留更多裕度 = 保守 → min-h 更大（方向断言） ──
  const etas = [0.05, 0.2, 0.4, 0.6];
  const minHs = [];
  let allSafe = true;
  for (const eta of etas) {
    const spec = { ...brakeDoubleIntegrator().spec, eta };
    const run = simulateClosedLoop([0, 2], () => 2, spec, 250, 1);
    const rep = violationReport(run);
    if (!rep.safe) allSafe = false;
    minHs.push(run.hMin);
  }
  let monotone = true;
  for (let i = 1; i < minHs.length; i += 1) if (minHs[i] > minHs[i - 1] + 1e-12) monotone = false;
  ok(allSafe, `4 个 η 下贪婪危险策略全部安全（0 违反）: min-h = ${minHs.map((h) => h.toExponential(1)).join(' > ')}`);
  ok(monotone, `min-h 随 η 单调: η=0.05 → ${minHs[0].toExponential(2)} ≥ η=0.6 → ${minHs[3].toExponential(2)}（η→小 = 保守 = 裕度大，方向正确）`);
  ok(minHs[0] > minHs[3], `端点严格: minH(η=0.05) = ${minHs[0].toExponential(2)} > minH(η=0.6) = ${minHs[3].toExponential(2)}（η=0.6 允许指数衰减逼近零——最宽松但永不触零）`);

  // ── 2D 动作网格 QP-lite: 双轴双积分器，h = min(h₁,h₂)——与脚本侧同分辨率暴力枚举逐位对照 ──
  const dt2 = 0.1;
  const b2 = 5;
  const h2d = (x) => {
    const h1 = 10 - x[0] - (x[1] > 0 ? (x[1] * x[1]) / (2 * b2) : 0);
    const h2 = 10 - x[2] - (x[3] > 0 ? (x[3] * x[3]) / (2 * b2) : 0);
    return Math.min(h1, h2);
  };
  const f2d = (x, u) => [
    x[0] + x[1] * dt2 + 0.5 * u[0] * dt2 * dt2,
    x[1] + u[0] * dt2,
    x[2] + x[3] * dt2 + 0.5 * u[1] * dt2 * dt2,
    x[3] + u[1] * dt2,
  ];
  const spec2d = { h: h2d, dynamics: f2d, eta: 0.05, uMin: [-5, -5], uMax: [2, 2], gridResolution: 101 };
  const x0 = [0, 4, 0, 5.5];
  const ud = [2, 2];
  const r2 = cbfFilter(x0, ud, spec2d);
  // 暴力枚举（同公式同行序同平局规则: 距离严格更小才替换 → 先遇者胜）
  const thr = (1 - 0.05) * h2d(x0);
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < 101; i += 1) {
    for (let j = 0; j < 101; j += 1) {
      const u = [-5 + (i * 7) / 100, -5 + (j * 7) / 100];
      if (h2d(f2d(x0, u)) >= thr) {
        const dist = (u[0] - 2) ** 2 + (u[1] - 2) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          best = u;
        }
      }
    }
  }
  ok(r2.method === 'grid-qp-lite' && !r2.infeasible && r2.resolutionUsed === 101, `2D 网格 QP-lite: method=${r2.method}，分辨率 ${r2.resolutionUsed}²（10201 ≤ 20001 封顶）`);
  ok(best !== null && near(r2.u[0], best[0], 1e-15) && near(r2.u[1], best[1], 1e-15), `滤波 [${r2.u.map((v) => v.toFixed(4)).join(', ')}] = 暴力枚举最近可行点 [${best ? best.map((v) => v.toFixed(4)).join(', ') : '∅'}]（逐位一致——只压紧轴 2，轴 1 保持满加速）`);
  ok(r2.u[0] >= 1.9 && r2.u[1] < -1, `最小修改的结构正确: 需要刹的是危险轴（u₂ = ${r2.u[1].toFixed(3)}），安全轴不动（u₁ = ${r2.u[0].toFixed(3)}）`);
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✅ PASS ${passed} / FAIL 0 —— 86.0 分层技能内核 + 87.0 安全屏障内核数学验证成立`);
} else {
  console.error(`❌ PASS ${passed} / FAIL ${failed}`);
}
process.exitCode = failed === 0 ? 0 : 1;
