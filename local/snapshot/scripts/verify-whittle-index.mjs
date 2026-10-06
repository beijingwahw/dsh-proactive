/**
 * verify-whittle-index.mjs — 53.0 Whittle 指数内核纯数学离线验证
 *
 * 内核的数学核心全部有闭式解或独立重算对照（不是「能跑」，是「算得对」）：
 *   ① 退化闭式: 「主动必自愈回 good、被动必落 bad 且吸收」的臂在 λ∈[γR,R]
 *        区间最优策略 = {good 主动, bad 被动}，V(good)=R/(1−γ)、V(bad)=λ/(1−γ)，
 *        无差条件解出 W(good)=R、W(bad)=γR（γ=0.9,R=1 → [0.9, 1.0]；
 *        γ=0.8,R=2.5 → [2.0, 2.5]）；被动集序列 ∅→{bad}→{bad,good}。
 *        动作同动力学臂（P^a=P^p）: D_s=c_s−λ ⟹ W=[0, R^a−R^p]。
 *   ② 种子化随机网格 240 组: 可索引性 240/240（内核文件头定理的预言——坏态收益
 *        与动作无关的两态臂恒可索引，非造假 100%）；脚本侧独立值迭代对 2400 个
 *        (臂,λ,态) 检查点复核价值（≤1e-8）与被动判据逐位一致；4 策略精确线性
 *        代数解（无值迭代）复核指数无差性 |D(W(s))| ≤ 1e-4；
 *        checkPassiveSetMonotonicity 对合成非单调序列正确报警。
 *   ③ n≤4 联合 MDP 全动作精确值迭代（2ⁿ 状态 × C(n,k) 动作）对照：
 *        退化闭式族（确定性转移, W=[γR,R]）n=2/3/4 × k=1/2 × 12 种子 × 全部
 *        2ⁿ 起点态: Whittle 恰为最优（差距 = 0 ≤ 规格 1e-3——确定性转移下
 *        联合 MDP 的最优解就是闭式指数 top-k）; 随机占优族（服务加速自愈,
 *        主动占优）n=3/4: 与真最优相对差距 ≤ 5% 且 ≥ 全枚举 C(n,k) 静态策略
 *        最优（Weber–Weiss: 指数策略最优性是 n→∞ 渐近性质, 小 n 缺口如实
 *        报告——差距源自跨臂互补性, 单臂指数原理上不可见）; k=n 退化: 差距 0。
 *   ④ λ 二分收敛（区间宽 ≤ 1e-6）+ 无差异: λ=W(s) 时 |Q^a−Q^p| ≤ 1e-4；
 *        λ=W(s)∓2e-4 时主动/被动严格分侧。
 *   ⑤ 演化速度单调: 主动自愈 q↑ ⟹ W(bad) 严格↑（−0.497→0.792）；
 *        被动自愈 p↑ ⟹ W(bad) 严格↓；被动恶化 d↑ ⟹ W(good) 严格↑
 *        （演化越快的臂优先级越高，直觉可计算化）。
 *   ⑥ whittleScheduler: 已知指数的退化臂 top-k 选择 / id 平手序 / k=0·k=n 边界；
 *        入参校验显式 throw（非随机转移行、discount 越界、state 非法、k 非法等）。
 *
 * 全部断言确定性（随机处用 mulberry32 种子）。
 * 运行：node --experimental-strip-types scripts/verify-whittle-index.mjs
 */

import {
  solveWhittleIndex,
  solveSubsidy,
  indexabilityCheck,
  checkPassiveSetMonotonicity,
  whittleScheduler,
} from '../src/core/whittle-index.ts';

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
function throws(fn, label) {
  try {
    fn();
  } catch {
    ok(true, label);
    return;
  }
  ok(false, `${label}（未抛出）`);
}
function section(title) {
  console.log(`\n■ ${title}`);
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

// ─────────────── 脚本侧独立实现（与内核不同源，供交叉复核） ───────────────

/** 独立补贴值迭代（矩阵-向量风格; 内核为标量展开风格） */
function scriptVI(pa, pp, ra, rp, gamma, lambda) {
  let V = [0, 0];
  for (let t = 0; t < 500000; t += 1) {
    const NV = [0, 1].map((s) => {
      const qa = ra[s] + gamma * (pa[s][0] * V[0] + pa[s][1] * V[1]);
      const qp = rp[s] + lambda + gamma * (pp[s][0] * V[0] + pp[s][1] * V[1]);
      return Math.max(qa, qp);
    });
    const d = Math.max(Math.abs(NV[0] - V[0]), Math.abs(NV[1] - V[1]));
    V = NV;
    if (d <= 1e-12 * (1 + Math.max(Math.abs(V[0]), Math.abs(V[1]), 1))) break;
  }
  return V;
}

/**
 * 独立「精确」解: 两态只有 4 个确定性平稳策略, 逐个解 2×2 线性方程组 (I−γP^π)V=r^π_λ,
 * V_λ = 四者逐点最大, 返回该 V 下的 D_s(λ)=Q^a−Q^p（全程无值迭代——二分结果的
 * 第三条独立验证路径）。
 */
function exactD(arm, lambda, s) {
  const g = arm.discount;
  const ra = [0, arm.activeReward];
  const rp = [0, arm.passiveReward ?? 0];
  let best = null;
  for (let pm = 0; pm < 4; pm += 1) {
    const actGood = (pm >> 1) & 1;
    const actBad = pm & 1;
    const Ppi = [actBad ? arm.pa[0] : arm.pp[0], actGood ? arm.pa[1] : arm.pp[1]];
    const r0 = (actBad ? ra[0] : rp[0]) + (actBad ? 0 : lambda);
    const r1 = (actGood ? ra[1] : rp[1]) + (actGood ? 0 : lambda);
    const a11 = 1 - g * Ppi[0][0];
    const a12 = -g * Ppi[0][1];
    const a21 = -g * Ppi[1][0];
    const a22 = 1 - g * Ppi[1][1];
    const det = a11 * a22 - a12 * a21;
    const v0 = (r0 * a22 - a12 * r1) / det;
    const v1 = (a11 * r1 - a21 * r0) / det;
    if (best === null || v0 + v1 > best[0] + best[1]) best = [v0, v1];
  }
  const [v0, v1] = best;
  const qa = ra[s] + g * (arm.pa[s][0] * v0 + arm.pa[s][1] * v1);
  const qp = rp[s] + lambda + g * (arm.pp[s][0] * v0 + arm.pp[s][1] * v1);
  return qa - qp;
}

/** 联合 MDP 折扣值迭代: actsOf(s) 返回状态 s 的候选动作（最优=全部 C(n,k)，策略评估=单动作） */
function jointVI(arms, gamma, actsOf) {
  const n = arms.length;
  const N = 1 << n;
  const stepValue = (activeMask, s, V) => {
    let r = 0;
    for (let i = 0; i < n; i += 1) {
      if (!((s >> i) & 1)) continue;
      r += (activeMask >> i) & 1 ? arms[i].activeReward : (arms[i].passiveReward ?? 0);
    }
    let acc = 0;
    const dfs = (i, bits, p) => {
      if (i === n) {
        acc += p * V[bits];
        return;
      }
      const cur = (s >> i) & 1;
      const Mx = (activeMask >> i) & 1 ? arms[i].pa : arms[i].pp;
      dfs(i + 1, bits, p * Mx[cur][0]);
      dfs(i + 1, bits | (1 << i), p * Mx[cur][1]);
    };
    dfs(0, 0, 1);
    return r + gamma * acc;
  };
  let V = new Array(N).fill(0);
  for (let t = 0; t < 500000; t += 1) {
    const NV = new Array(N);
    let diff = 0;
    for (let s = 0; s < N; s += 1) {
      let best = -Infinity;
      for (const a of actsOf(s)) {
        const v = stepValue(a, s, V);
        if (v > best) best = v;
      }
      NV[s] = best;
      diff = Math.max(diff, Math.abs(best - V[s]));
    }
    V = NV;
    if (diff <= 1e-12 * (1 + Math.max(...V))) break;
  }
  return V;
}

function popcount(x) {
  let c = 0;
  while (x) {
    c += x & 1;
    x >>= 1;
  }
  return c;
}
function masksOf(n, k) {
  const out = [];
  for (let msk = 0; msk < 1 << n; msk += 1) if (popcount(msk) === k) out.push(msk);
  return out;
}

/** 主动占优族（应用口径: 服务加速自愈/保卫 good，被动恶化），共享 γ */
function niceArm(rand, gamma) {
  const ppGood = rand();
  const ppBad = rand();
  const paGood = Math.min(1, ppGood + rand() * (1 - ppGood));
  const paBad = Math.min(1, ppBad + rand() * (1 - ppBad));
  return {
    pa: [[1 - paBad, paBad], [1 - paGood, paGood]],
    pp: [[1 - ppBad, ppBad], [1 - ppGood, ppGood]],
    activeReward: 0.5 + rand() * 0.5,
    passiveReward: rand() * 0.5,
    discount: gamma,
  };
}

// ═══════════════════ ① 退化闭式锚点 ═══════════════════

section('① 退化闭式: 被动=坏态吸收、主动自愈回 good ⟹ W=[γR, R]');

{
  // 推导（文档化）: pa 两行均 →good（主动自愈且保持），pp 两行均 →bad（被动恶化且吸收）。
  // λ∈[γR,R] 区间最优策略 = {good 主动, bad 被动}:
  //   V(good)=R/(1−γ)（主动永续收益流）; V(bad)=λ/(1−γ)（被动永续补贴流）。
  //   good 无差: R/(1−γ) = λ+γV(bad) = λ/(1−γ) ⟹ λ=R;
  //   bad  无差: γV(good)=γR/(1−γ) = λ+γV(bad) = λ/(1−γ) ⟹ λ=γR。
  // 被动集随 λ: ∅（λ<γR）→ {bad}（γR≤λ<R）→ {bad,good}（λ≥R），单调 ⟹ 可索引。
  const deg = (R, g) => ({
    pa: [[0, 1], [0, 1]],
    pp: [[1, 0], [1, 0]],
    activeReward: R,
    discount: g,
  });
  const a1 = solveWhittleIndex(deg(1, 0.9));
  ok(
    near(a1.index[0], 0.9, 2e-6) && near(a1.index[1], 1.0, 2e-6),
    `W=[${a1.index[0].toFixed(6)}, ${a1.index[1].toFixed(6)}] = [γR, R]（γ=0.9, R=1 ⟹ [0.9, 1.0]）`,
  );
  const a2 = solveWhittleIndex(deg(2.5, 0.8));
  ok(
    near(a2.index[0], 2.0, 2e-6) && near(a2.index[1], 2.5, 2e-6),
    `W=[${a2.index[0].toFixed(6)}, ${a2.index[1].toFixed(6)}] = [γR, R]（γ=0.8, R=2.5 ⟹ [2.0, 2.5]）`,
  );
  const ic = indexabilityCheck(deg(1, 0.9));
  const shapes = [...new Set(ic.passiveSetSequence.map((p) => p.passive.join('')))];
  ok(
    ic.indexable && ic.violations === 0 && shapes.join('|') === 'falsefalse|truefalse|truetrue',
    `被动集序列 ∅→{bad}→{bad,good} 单调（shapes=${shapes.join('|')}, violations=${ic.violations}）`,
  );

  // 动作同动力学（P^a=P^p）: 转移差为零，D_s=c_s−λ 与动力学无关
  //   ⟹ W(good)=R^a−R^p、W(bad)=0；R^p=R^a 时全零（永不值得激活）。
  const same = {
    pa: [[0.2, 0.8], [0.7, 0.3]],
    pp: [[0.2, 0.8], [0.7, 0.3]],
    activeReward: 1,
    passiveReward: 0.25,
    discount: 0.9,
  };
  const w3 = solveWhittleIndex(same);
  ok(
    near(w3.index[0], 0, 2e-6) && near(w3.index[1], 0.75, 2e-6),
    `同动力学臂 W=[${w3.index[0].toExponential(1)}, ${w3.index[1].toFixed(6)}] = [0, R^a−R^p=0.75]（与共享动力学无关）`,
  );
  const same2 = { ...same, passiveReward: 1 };
  const w4 = solveWhittleIndex(same2);
  ok(
    Math.abs(w4.index[0]) <= 2e-6 && Math.abs(w4.index[1]) <= 2e-6,
    `同动力学且 R^p=R^a ⟹ W=[${w4.index[0].toExponential(1)}, ${w4.index[1].toExponential(1)}] ≡ 0（补贴 0 即无差）`,
  );
}

// ═══════════════════ ② 种子化随机网格 ═══════════════════

section('② 随机网格 240 组: 恒可索引性(定理预言) + 独立实现交叉复核');

{
  const rand = mulberry32(4253);
  const arms = [];
  for (let i = 0; i < 240; i += 1) {
    const row = () => {
      const x = rand();
      return [1 - x, x];
    };
    arms.push({
      pa: [row(), row()],
      pp: [row(), row()],
      activeReward: 0.1 + rand(),
      passiveReward: rand() * 0.6,
      discount: 0.8 + rand() * 17e-2,
    });
  }
  let indexable = 0;
  let converged = 0;
  for (const arm of arms) {
    if (indexabilityCheck(arm).indexable) indexable += 1;
    if (solveWhittleIndex(arm).converged) converged += 1;
  }
  ok(
    indexable === 240,
    `可索引性 ${indexable}/240 = 100%（文件头定理: 坏态收益与动作无关的两态臂恒可索引——非造假）`,
  );
  ok(converged === 240, `二分全部收敛（${converged}/240, 区间端点语义成立且宽度 ≤ 1e-6）`);

  // 独立值迭代交叉: 5 个 λ 检查点 × 240 臂 × 2 态 = 2400 检查点
  let maxVDiff = 0;
  let flagMismatch = 0;
  for (const arm of arms) {
    const w = solveWhittleIndex(arm);
    for (const lambda of [w.index[0] - 0.05, w.index[0] + 0.05, 0, w.index[1] - 0.05, w.index[1] + 0.05]) {
      const ks = solveSubsidy(arm, lambda);
      const V = scriptVI(arm.pa, arm.pp, [0, arm.activeReward], [0, arm.passiveReward ?? 0], arm.discount, lambda);
      maxVDiff = Math.max(maxVDiff, Math.abs(ks.value[0] - V[0]), Math.abs(ks.value[1] - V[1]));
      const g = arm.discount;
      for (const s of [0, 1]) {
        const qa = (s === 1 ? arm.activeReward : 0) + g * (arm.pa[s][0] * V[0] + arm.pa[s][1] * V[1]);
        const qp = (s === 1 ? arm.passiveReward ?? 0 : 0) + lambda + g * (arm.pp[s][0] * V[0] + arm.pp[s][1] * V[1]);
        if ((qp > qa) !== ks.passiveOptimal[s]) flagMismatch += 1;
      }
    }
  }
  ok(
    maxVDiff <= 1e-8 && flagMismatch === 0,
    `独立值迭代交叉: 2400 检查点 max|ΔV|=${maxVDiff.toExponential(2)} ≤ 1e-8, 被动判据不一致 ${flagMismatch} 处`,
  );

  // 精确线性代数（4 策略枚举, 无值迭代）复核指数无差性
  let maxD = 0;
  for (let i = 0; i < arms.length; i += 2) {
    const arm = arms[i];
    const w = solveWhittleIndex(arm);
    for (const s of [0, 1]) maxD = Math.max(maxD, Math.abs(exactD(arm, w.index[s], s)));
  }
  ok(
    maxD <= 1e-4,
    `4 策略精确解复核: λ=W(s) 处 |Q^a−Q^p| 最大 ${maxD.toExponential(2)} ≤ 1e-4（二分宽 1e-6 的合法余量）`,
  );

  // 检查器对合成序列的判据（不可索引通路不可达 ≠ 检查器空转）
  ok(
    checkPassiveSetMonotonicity([
      { lambda: 0, passive: [false, false] },
      { lambda: 1, passive: [true, false] },
      { lambda: 2, passive: [true, true] },
    ]),
    'checkPassiveSetMonotonicity: 单调增长序列 → true',
  );
  ok(
    !checkPassiveSetMonotonicity([
      { lambda: 0, passive: [false, false] },
      { lambda: 1, passive: [true, false] },
      { lambda: 2, passive: [false, true] },
    ]),
    'checkPassiveSetMonotonicity: bad 态随 λ 翻回主动（非单调）→ false（诚实报警）',
  );
  ok(
    checkPassiveSetMonotonicity([
      { lambda: 0, passive: [true, false] },
      { lambda: 1, passive: [true, false] },
      { lambda: 2, passive: [true, true] },
    ]),
    'checkPassiveSetMonotonicity: 恒被动起步后仅增长 → true',
  );

  // 诚实统计: 本 API 不隐含 W(good) ≥ W(bad)（修理紧迫的坏态臂可以更优先）
  let goodLtBad = 0;
  for (const arm of arms) {
    const w = solveWhittleIndex(arm);
    if (w.index[1] < w.index[0] - 1e-9) goodLtBad += 1;
  }
  ok(
    goodLtBad > 0,
    `W(good) < W(bad) 的臂 ${goodLtBad}/240 个（内核未隐含好态优先假设，逐态指数独立成立）`,
  );
}

// ═══════════════════ ③ 联合 MDP 最优性对照 ═══════════════════

section('③ n≤4 联合 MDP 精确值迭代: Whittle 策略 vs 真最优 / 最优静态');

{
  const evaluate = (arms, k, gamma) => {
    const n = arms.length;
    const W = arms.map((a) => solveWhittleIndex(a).index);
    const whittleMask = (bits) => {
      const idx = Array.from({ length: n }, (_, i) => i);
      idx.sort((x, y) => W[y][(bits >> y) & 1] - W[x][(bits >> x) & 1] || x - y);
      let msk = 0;
      for (let i = 0; i < k; i += 1) msk |= 1 << idx[i];
      return msk;
    };
    const all = masksOf(n, k);
    const vOpt = jointVI(arms, gamma, () => all);
    const vW = jointVI(arms, gamma, (s) => [whittleMask(s)]);
    return { vOpt, vW, W, whittleMask, all };
  };

  // (a) 退化闭式族（pa 行→good, pp 行→bad 的确定性转移）: 联合 MDP 退化为
  //     确定性控制问题（被服务臂下步必 good、落选臂下步必 bad），其最优解
  //     = 闭式指数 [γR, R] 的 top-k —— 全 2ⁿ 起点逐点验证 Whittle 恰最优。
  {
    let maxGap = 0;
    let closedFormOk = true;
    let cases = 0;
    for (const [n, k] of [[2, 1], [3, 1], [3, 2], [4, 1], [4, 2]]) {
      for (let si = 0; si < 12; si += 1) {
        const rand = mulberry32(9700 + n * 31 + k * 13 + si);
        const gamma = 0.8 + rand() * 0.17;
        const arms = Array.from({ length: n }, () => ({
          pa: [[0, 1], [0, 1]],
          pp: [[1, 0], [1, 0]],
          activeReward: 0.2 + rand() * 0.8,
          discount: gamma,
        }));
        const { vOpt, vW, W } = evaluate(arms, k, gamma);
        for (const a of arms) {
          const w = solveWhittleIndex(a).index;
          if (!near(w[0], a.discount * a.activeReward, 2e-6) || !near(w[1], a.activeReward, 2e-6)) closedFormOk = false;
        }
        for (let start = 0; start < 1 << n; start += 1) {
          maxGap = Math.max(maxGap, vOpt[start] - vW[start]);
          cases += 1;
        }
      }
    }
    ok(
      closedFormOk,
      '退化族逐实例指数复核: W = [γR_i, R_i] 与 ① 闭式一致（多种子多种 γ）',
    );
    ok(
      maxGap <= 1e-3,
      `退化闭式族 n≤4 × k∈{1,2} × 12 种子 × 全部 ${cases} 个起点: max(V*−V_W)=${maxGap.toExponential(2)} ≤ 1e-3（Whittle 恰最优, 规格锚点）`,
    );
  }

  // (b) 随机占优族（服务加速自愈/保卫 good、被动恶化）: 小 n 缺口如实报告——
  //     相对差距 ≤ 5%, 且不低于「预算约束静态策略空间」全枚举 C(n,k) 的最优。
  for (const [n, k, seeds] of [[3, 1, 8], [4, 1, 8], [4, 2, 8]]) {
    let maxStaticGap = 0;
    let maxRel = 0;
    for (let si = 0; si < seeds; si += 1) {
      const rand = mulberry32(8100 + n * 37 + k * 11 + si);
      const gamma = 0.85 + rand() * 0.12;
      const arms = Array.from({ length: n }, () => niceArm(rand, gamma));
      let start = 0;
      for (let i = 0; i < n; i += 1) if (i % 2 === 1) start |= 1 << i;
      const { vOpt, vW, all } = evaluate(arms, k, gamma);
      for (const msk of all) {
        const vS = jointVI(arms, gamma, () => [msk])[start];
        maxStaticGap = Math.max(maxStaticGap, vS - vW[start]);
      }
      maxRel = Math.max(maxRel, (vOpt[start] - vW[start]) / Math.max(1e-9, Math.abs(vOpt[start])));
    }
    ok(
      maxStaticGap <= 1e-6,
      `n=${n},k=${k}（${seeds} 种子）: Whittle ≥ 全枚举 C(n,k) 静态策略最优 − 1e-6（自适应回报）`,
    );
    ok(
      maxRel <= 0.05,
      `n=${n},k=${k}: 与全动作联合 DP 真最优相对差距 max ${(maxRel * 100).toFixed(3)}% ≤ 5%（Weber–Weiss 渐近最优性的小 n 缺口, 如实报告）`,
    );
  }

  // (c) k=n 退化: 只有一个动作, Whittle 秩序无关 ⟹ 差距恰 0
  {
    const rand = mulberry32(8999);
    const gamma = 0.9;
    const arms = Array.from({ length: 3 }, () => niceArm(rand, gamma));
    const { vOpt, vW } = evaluate(arms, 3, gamma);
    ok(
      Math.abs(vOpt[5] - vW[5]) <= 1e-9,
      `k=n=3: V_W=${vW[5].toFixed(6)} = V*=${vOpt[5].toFixed(6)}（唯一动作, 差距恰 0）`,
    );
  }

  // (d) 接线一致性: 内核调度器在具体联合态上的选择 = 脚本侧 top-k
  {
    const rand = mulberry32(8777);
    const gamma = 0.88;
    const arms = Array.from({ length: 4 }, () => niceArm(rand, gamma));
    const start = 0b0101; // 臂 0/2 good, 臂 1/3 bad
    const { whittleMask } = evaluate(arms, 2, gamma);
    const sched = whittleScheduler(
      arms.map((a, i) => ({ ...a, id: `a${i}`, state: (start >> i) & 1 })),
      2,
    );
    const scriptTop = new Set();
    for (let i = 0; i < 4; i += 1) if ((whittleMask(start) >> i) & 1) scriptTop.add(`a${i}`);
    const kernelTop = new Set(sched.selectedIds);
    ok(
      scriptTop.size === kernelTop.size && [...scriptTop].every((x) => kernelTop.has(x)) && sched.allConverged,
      `调度器选择与脚本侧 top-k 一致（选中 [${[...kernelTop].sort().join(', ')}], allConverged=${sched.allConverged}）`,
    );
  }
}

// ═══════════════════ ④ 二分收敛与无差异 ═══════════════════

section('④ λ 二分收敛 + 无差异验证（补贴=指数时主动/被动价值差 ≈ 0）');

{
  const rand = mulberry32(4253);
  let widthOk = true;
  let maxIndiff = 0;
  let sideOk = true;
  let convOk = true;
  for (let i = 0; i < 40; i += 1) {
    const row = () => {
      const x = rand();
      return [1 - x, x];
    };
    const arm = {
      pa: [row(), row()],
      pp: [row(), row()],
      activeReward: 0.1 + rand(),
      passiveReward: rand() * 0.6,
      discount: 0.8 + rand() * 17e-2,
    };
    const r = solveWhittleIndex(arm);
    if (!r.converged) convOk = false;
    for (const s of [0, 1]) {
      if (r.brackets[s][1] - r.brackets[s][0] > 1e-6 + 1e-9) widthOk = false;
      const at = solveSubsidy(arm, r.index[s]);
      maxIndiff = Math.max(maxIndiff, Math.abs(at.qActive[s] - at.qPassive[s]));
      const below = solveSubsidy(arm, r.index[s] - 2e-4);
      const above = solveSubsidy(arm, r.index[s] + 2e-4);
      if (!(below.qActive[s] >= below.qPassive[s] - 1e-12)) sideOk = false;
      if (!(above.qPassive[s] >= above.qActive[s] - 1e-12)) sideOk = false;
    }
  }
  ok(convOk, '40 组随机臂二分全部 converged（区间端点: 下方主动/上方被动语义成立）');
  ok(widthOk, '最终二分区间宽全部 ≤ 1e-6（收敛容差口径）');
  ok(
    maxIndiff <= 1e-4,
    `无差异验证: λ=W(s) 处 max|Q^a−Q^p|=${maxIndiff.toExponential(2)} ≤ 1e-4（二分宽 1e-6 × |D′|≲O(1/(1−γ))）`,
  );
  ok(
    sideOk,
    '严格分侧: λ=W(s)−2e-4 处主动最优、λ=W(s)+2e-4 处被动最优（40 臂 × 2 态全通过）',
  );
}

// ═══════════════════ ⑤ 演化速度单调性 ═══════════════════

section('⑤ 指数随自愈/恶化速度单调（演化越快优先级越高）');

{
  // (a) 主动自愈 q = pa[bad][good] ↑ ⟹ W(bad) 严格 ↑
  const famA = (q) => ({
    pa: [[1 - q, q], [0.05, 0.95]],
    pp: [[0.92, 0.08], [0.97, 0.03]],
    activeReward: 1,
    discount: 0.9,
  });
  let monoA = true;
  const valsA = [];
  for (let q = 0; q <= 1.001; q += 0.1) {
    const w = solveWhittleIndex(famA(q)).index[0];
    if (valsA.length > 0 && w < valsA[valsA.length - 1] - 1e-9) monoA = false;
    valsA.push(w);
  }
  ok(
    monoA && valsA[0] < valsA[3] && valsA[3] < valsA[valsA.length - 1],
    `W(bad) 随主动自愈 q 严格 ↑: q=0→${valsA[0].toFixed(4)}, 0.3→${valsA[3].toFixed(4)}, 1→${valsA[valsA.length - 1].toFixed(4)}`,
  );

  // (b) 被动自愈 p = pp[bad][good] ↑ ⟹ W(bad) 严格 ↓（自愈免费化 → 无需激活）
  const famB = (p) => ({
    pa: [[0.3, 0.7], [0.05, 0.95]],
    pp: [[1 - p, p], [0.97, 0.03]],
    activeReward: 1,
    discount: 0.9,
  });
  let monoB = true;
  const valsB = [];
  for (let p = 0; p <= 0.301; p += 0.05) {
    const w = solveWhittleIndex(famB(p)).index[0];
    if (valsB.length > 0 && w > valsB[valsB.length - 1] + 1e-9) monoB = false;
    valsB.push(w);
  }
  ok(
    monoB && valsB[0] > valsB[3] && valsB[3] > valsB[valsB.length - 1],
    `W(bad) 随被动自愈 p 严格 ↓: p=0→${valsB[0].toFixed(4)}, 0.15→${valsB[3].toFixed(4)}, 0.3→${valsB[valsB.length - 1].toFixed(4)}`,
  );

  // (c) 被动恶化 d = pp[good][bad] ↑ ⟹ W(good) 严格 ↑（good 更需主动保卫）
  const famC = (d) => ({
    pa: [[0.3, 0.7], [0.1, 0.9]],
    pp: [[0.92, 0.08], [d, 1 - d]],
    activeReward: 1,
    passiveReward: 0.3,
    discount: 0.9,
  });
  let monoC = true;
  const valsC = [];
  for (let d = 0; d <= 0.801; d += 0.1) {
    const w = solveWhittleIndex(famC(d)).index[1];
    if (valsC.length > 0 && w < valsC[valsC.length - 1] - 1e-9) monoC = false;
    valsC.push(w);
  }
  ok(
    monoC && valsC[0] < valsC[4] && valsC[4] < valsC[valsC.length - 1],
    `W(good) 随被动恶化 d 严格 ↑: d=0→${valsC[0].toFixed(4)}, 0.4→${valsC[4].toFixed(4)}, 0.8→${valsC[valsC.length - 1].toFixed(4)}`,
  );
}

// ═══════════════════ ⑥ 调度器与入参校验 ═══════════════════

section('⑥ whittleScheduler: top-k 选择 / 平手序 / 边界 / 入参校验');

{
  // 已知指数的退化臂: W(bad)=γR_i, W(good)=R_i —— 手工可验的排序
  const deg = (R, id, state) => ({
    pa: [[0, 1], [0, 1]],
    pp: [[1, 0], [1, 0]],
    activeReward: R,
    discount: 0.9,
    id,
    state,
  });
  const r = whittleScheduler([deg(0.5, 't0', 0), deg(1.5, 't1', 1), deg(2.0, 't2', 0), deg(2.5, 't3', 1)], 2);
  ok(
    r.selectedIds.join(',') === 't3,t2',
    `k=2 选中 [${r.selectedIds.join(', ')}]（指数 t3=2.5 > t2=γ·2=1.8 > t1=1.5 > t0=γ·0.5=0.45）`,
  );
  ok(
    r.ranked.every((e, i) => e.rank === i + 1) &&
      r.ranked[0].index >= r.ranked[1].index &&
      r.ranked[1].index >= r.ranked[2].index &&
      r.ranked[2].index >= r.ranked[3].index &&
      r.nonIndexableIds.length === 0 &&
      r.allConverged,
    `rank 连续降序（${r.ranked.map((e) => `${e.id}#${e.index.toFixed(3)}`).join(', ')}）, nonIndexable 空, allConverged`,
  );
  // 平手: 同参数臂按 id 升序
  const r2 = whittleScheduler([deg(1, 'b', 1), deg(1, 'a', 1)], 1);
  ok(
    r2.selectedIds[0] === 'a' && r2.ranked.map((e) => e.id).join(',') === 'a,b',
    `指数平手按 id 升序破平（ranked=${r2.ranked.map((e) => e.id).join(',')}, 选中 a）`,
  );
  // 边界
  ok(whittleScheduler([deg(1, 'x', 0)], 0).selectedIds.length === 0, 'k=0 → 空选择（ranked 仍完整）');
  ok(whittleScheduler([deg(1, 'x', 0), deg(2, 'y', 1)], 2).selectedIds.length === 2, 'k=n → 全选');
  ok(whittleScheduler([], 0).ranked.length === 0, '空臂数组 + k=0 → 空结果');

  // 入参校验显式 throw
  const good = deg(1, 'g', 1);
  throws(() => whittleScheduler([good], -1), 'k=−1 拒绝');
  throws(() => whittleScheduler([good], 2), 'k>n 拒绝');
  throws(() => whittleScheduler([good], 1.5), 'k 非整数拒绝');
  throws(
    () => whittleScheduler([{ ...good, pa: [[0.3, 0.5], [0, 1]] }], 1),
    'pa 行和 0.8 ≠ 1 拒绝',
  );
  throws(
    () => whittleScheduler([{ ...good, pp: [[-0.2, 1.2], [1, 0]] }], 1),
    'pp 出现负概率/超 1 概率拒绝',
  );
  throws(() => whittleScheduler([{ ...good, discount: 1 }], 1), 'discount=1 拒绝（开区间）');
  throws(() => whittleScheduler([{ ...good, discount: 0 }], 1), 'discount=0 拒绝');
  throws(() => whittleScheduler([{ ...good, activeReward: Number.NaN }], 1), 'activeReward=NaN 拒绝');
  throws(() => whittleScheduler([{ ...good, id: '' }], 1), '空 id 拒绝');
  throws(() => whittleScheduler([{ ...good, state: 2 }], 1), 'state=2 拒绝（只允许 0|1）');
  throws(() => whittleScheduler([{ ...good, pa: [[1]] }], 1), 'pa 非法形状拒绝');
  throws(() => solveWhittleIndex({ ...good, discount: 1.2 }).index, 'solveWhittleIndex: discount=1.2 拒绝');
  throws(() => solveSubsidy(good, Number.NaN).value, 'solveSubsidy: lambda=NaN 拒绝');
  throws(() => indexabilityCheck({ ...good, pp: [[0.5, 0.4], [1, 0]] }).indexable, 'indexabilityCheck: pp 行和 0.9 拒绝');
  throws(
    () => checkPassiveSetMonotonicity([{ lambda: 0, passive: [true, 0] }]),
    'checkPassiveSetMonotonicity: passive 非布尔拒绝',
  );
  throws(() => whittleScheduler(null, 0), 'arms 非 数组 拒绝');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 53.0 Whittle 指数内核数学验证成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
