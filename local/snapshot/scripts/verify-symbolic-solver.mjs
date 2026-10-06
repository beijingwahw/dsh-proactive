/**
 * verify-symbolic-solver.mjs — 85.0「符号求解内核」纯数学离线验证
 *
 * 每个断言都有解析解或独立暴力对照（不是「能跑」，是「算得对」）：
 *   ① 手工公式：SAT/UNSAT 各若干逐一对照（单元链、纯文字、空子句、
 *        自由变元）——DPLL / 暴力枚举 / #SAT 三方一致 + 计数器手工核对
 *   ② 鸽笼原理：PHP(3,2)（3 球 2 洞）经典 UNSAT——DPLL 判 UNSAT 与
 *        2ⁿ 暴力枚举一致，回跳与学子句真实介入（账单 > 0）；PHP(4,3) 加倍
 *   ③ 相变区随机 3-SAT：n=14、m/n≈4.26、50 种子——DPLL 与暴力枚举
 *        100% 一致，SAT 实例模型代入通过，同种子逐位复现
 *   ④ 种植解随机 SAT：种植解与 DPLL 模型均代入满足全部子句
 *   ⑤ #SAT 精确计数：n≤16 随机公式 = 独立 2ⁿ 枚举（1e-12 逐位一致），
 *        组件相乘（2×3=6）与自由变元乘数（3×2³=24）手工锚点
 *   ⑥ 单位传播不动点：传播到无单元子句，传播数与手工推演逐项一致，
 *        冲突子句原样携带
 *   附加：DIMACS lite 解析还原 + 全入口入参校验显式 throw
 *
 * 全部断言确定性（随机处用内核 mulberry32(seed) 工厂）。
 * 运行：node --experimental-strip-types scripts/verify-symbolic-solver.mjs
 */

import {
  parseDimacsLite,
  unitPropagate,
  dpllSolve,
  countModels,
  bruteForceSat,
  randomKSat,
  plantedSat,
  checkModel,
} from '../src/core/symbolic-solver.ts';

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
function near(a, b, tol = 1e-12) {
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

/** 独立暴力 #SAT：2ⁿ 全枚举（与内核 countModels 无共享代码的对照实现） */
function bruteCount(cnf) {
  const n = cnf.numVars;
  let count = 0;
  for (let mask = 0; mask < 2 ** n; mask += 1) {
    let sat = true;
    for (const clause of cnf.clauses) {
      let clauseOk = false;
      for (const lit of clause) {
        const bit = (mask >> (Math.abs(lit) - 1)) & 1;
        if (lit > 0 ? bit === 1 : bit === 0) {
          clauseOk = true;
          break;
        }
      }
      if (!clauseOk) {
        sat = false;
        break;
      }
    }
    if (sat) count += 1;
  }
  return count;
}

/** 独立模型代入检查（逐文字求值，不调用内核） */
function modelSatisfies(cnf, model) {
  for (const clause of cnf.clauses) {
    let sat = false;
    for (const lit of clause) {
      const val = model.get(Math.abs(lit));
      if (val === undefined) return false;
      if (lit > 0 ? val === true : val === false) {
        sat = true;
        break;
      }
    }
    if (!sat) return false;
  }
  return true;
}

/** SolveResult 的可 JSON 比较快照（Map → 排序数组） */
function snapResult(r) {
  return {
    ...r,
    model: r.model === null ? null : [...r.model.entries()].sort((a, b) => a[0] - b[0]),
  };
}

// ═══════════════════ ① 手工公式 ═══════════════════

section('① 手工公式：SAT/UNSAT 逐一三方对照（DPLL / 暴力 / #SAT）');

{
  const handCases = [
    { name: '单元冲突 (x1)∧(¬x1)', cnf: { numVars: 1, clauses: [[1], [-1]] }, sat: false, count: 0 },
    { name: '二元全组合排除（四子句锁死）', cnf: { numVars: 2, clauses: [[1, 2], [-1, 2], [1, -2], [-1, -2]] }, sat: false, count: 0 },
    { name: '空子句立即冲突', cnf: { numVars: 2, clauses: [[], [1, 2]] }, sat: false, count: 0 },
    { name: '唯一模型 (T,T)', cnf: { numVars: 2, clauses: [[1, 2], [-1, 2], [1, -2]] }, sat: true, count: 1 },
    { name: '单元链 x1→x2→x3', cnf: { numVars: 3, clauses: [[1], [-1, 2], [-2, 3]] }, sat: true, count: 1 },
    { name: '纯文字（x1 只负出现）', cnf: { numVars: 2, clauses: [[-1, 2], [-1, -2]] }, sat: true, count: 2 },
    { name: '半自由 (x1∨x2)∧(¬x1∨x2)', cnf: { numVars: 2, clauses: [[1, 2], [-1, 2]] }, sat: true, count: 2 },
    { name: '零子句恒真（3 变元全自由）', cnf: { numVars: 3, clauses: [] }, sat: true, count: 8 },
  ];
  for (const c of handCases) {
    const r = dpllSolve(c.cnf);
    ok(r.sat === c.sat, `${c.name}: DPLL sat=${r.sat}（期望 ${c.sat}）`);
    const b = bruteForceSat(c.cnf);
    ok(b.sat === c.sat, `${c.name}: 暴力枚举一致 sat=${b.sat}`);
    const cnt = countModels(c.cnf);
    const bc = bruteCount(c.cnf);
    ok(cnt === bc && cnt === c.count, `${c.name}: #SAT=${cnt} = 独立枚举 ${bc} = 手算 ${c.count}`);
    if (c.sat) {
      ok(r.model !== null && modelSatisfies(c.cnf, r.model) && checkModel(c.cnf, r.model), `${c.name}: 返回模型代入满足全部子句（双实现验证）`);
    }
  }

  // 计数器手工核对：单元链全程零决策、三步传播
  const chain = dpllSolve({ numVars: 3, clauses: [[1], [-1, 2], [-2, 3]] });
  ok(chain.decisions === 0 && chain.propagations === 3, `单元链账单 decisions=0 / propagations=3（实测 ${chain.decisions}/${chain.propagations}——纯传播可解）`);
  ok(chain.model.get(1) === true && chain.model.get(2) === true && chain.model.get(3) === true, '单元链模型 x1=x2=x3=T（手算一致）');

  // 纯文字案例账单
  const pure = dpllSolve({ numVars: 2, clauses: [[-1, 2], [-1, -2]] });
  ok(pure.pureLiterals === 1 && pure.decisions === 0 && pure.propagations === 0 && pure.model.get(1) === false, `纯文字账单 pureLiterals=1、x1 定为 false、零决策零传播（实测 ${pure.pureLiterals}/${pure.decisions}/${pure.propagations}/${pure.model.get(1)}）`);

  // 单元冲突在层 0 即裁决
  const uc = dpllSolve({ numVars: 1, clauses: [[1], [-1]] });
  ok(uc.conflicts === 1 && uc.propagations === 1 && uc.decisions === 0, `层 0 预处理即裁决：propagations=1 后冲突（实测 conflicts=${uc.conflicts}/${uc.propagations}/${uc.decisions}）`);
}

// ═══════════════════ ② 鸽笼原理 ═══════════════════

section('② 鸽笼 3 球 2 洞（PHP(3,2)）：经典 UNSAT');

{
  // 变元 p_ij = 球 i 放洞 j：p11=1 p12=2 p21=3 p22=4 p31=5 p32=6
  const php32 = {
    numVars: 6,
    clauses: [
      [1, 2], [3, 4], [5, 6], // 每球必入某洞
      [-1, -3], [-1, -5], [-3, -5], // 洞 1 每对球互斥
      [-2, -4], [-2, -6], [-4, -6], // 洞 2 每对球互斥
    ],
  };
  const r32 = dpllSolve(php32);
  ok(r32.sat === false, 'PHP(3,2): DPLL 判 UNSAT（完备性——穷尽分支后可靠）');
  ok(bruteForceSat(php32).sat === false && bruteCount(php32) === 0, 'PHP(3,2): 独立 2⁶ 枚举 64 个指派全灭（双实现一致）');
  ok(countModels(php32) === 0, 'PHP(3,2): #SAT = 0');
  ok(r32.decisions > 0 && r32.conflicts > 0 && r32.learned > 0, `搜索账单真实介入：decisions=${r32.decisions} / conflicts=${r32.conflicts} / learned=${r32.learned} 全部 > 0（冲突回跳 + 学子句非摆设）`);

  // PHP(4,3)：12 变元 22 子句，规模加倍
  const php43 = (() => {
    const clauses = [];
    for (let i = 0; i < 4; i += 1) clauses.push([3 * i + 1, 3 * i + 2, 3 * i + 3]);
    for (let h = 0; h < 3; h += 1) {
      for (let a = 0; a < 4; a += 1) {
        for (let b = a + 1; b < 4; b += 1) clauses.push([-(3 * a + h + 1), -(3 * b + h + 1)]);
      }
    }
    return { numVars: 12, clauses };
  })();
  ok(dpllSolve(php43).sat === false && bruteForceSat(php43).sat === false, 'PHP(4,3): 12 变元 22 子句，DPLL 与暴力枚举同判 UNSAT（鸽笼族规模加倍仍可靠）');
  ok(countModels(php43) === 0 && bruteCount(php43) === 0, 'PHP(4,3): #SAT = 0 = 独立枚举');
}

// ═══════════════════ ③ 相变区随机 3-SAT ═══════════════════

section('③ 相变区（n=14, m/n≈4.26）随机 3-SAT：DPLL vs 暴力 100% 一致');

{
  const n = 14;
  const m = Math.round(n * 4.26);
  const seeds = 50;
  let agree = 0;
  let satN = 0;
  let modelFail = 0;
  for (let seed = 1; seed <= seeds; seed += 1) {
    const cnf = randomKSat(n, m, 3, seed);
    const r = dpllSolve(cnf);
    const b = bruteForceSat(cnf);
    if (r.sat === b.sat) agree += 1;
    if (r.sat) {
      satN += 1;
      if (!modelSatisfies(cnf, r.model) || !checkModel(cnf, r.model)) modelFail += 1;
    }
  }
  ok(agree === seeds, `50 种子 × (n=${n}, m=${m})：DPLL 与 2¹⁴ 暴力枚举 ${agree}/${seeds} 100% 一致（相变区最难实例上完备性无漏判）`);
  ok(modelFail === 0, `SAT 实例（${satN} 个）模型全部代入通过（${modelFail} 失败——健全性无假阳性）`);
  ok(satN > 0 && satN < seeds, `阈值附近 SAT/UNSAT 真实混合：SAT ${satN} / UNSAT ${seeds - satN}（不是退化的全一边）`);

  // 确定性：同种子逐位复现
  const a1 = randomKSat(n, m, 3, 7);
  const a2 = randomKSat(n, m, 3, 7);
  ok(JSON.stringify(a1) === JSON.stringify(a2), 'randomKSat 同种子两次调用逐位一致（mulberry32）');
  const r1 = dpllSolve(a1);
  const r2 = dpllSolve(a2);
  ok(JSON.stringify(snapResult(r1)) === JSON.stringify(snapResult(r2)), 'dpllSolve 无种子两次调用（含全部计数器）逐位一致');
  const s1 = dpllSolve(a1, { seed: 99 });
  const s2 = dpllSolve(a1, { seed: 99 });
  ok(JSON.stringify(snapResult(s1)) === JSON.stringify(snapResult(s2)) && s1.sat === r1.sat, 'dpllSolve 带种子确定性 + 裁决与无种子一致（抖动只改路径不改结论）');
}

// ═══════════════════ ④ 种植解随机 SAT ═══════════════════

section('④ 种植解随机 SAT：模型代入验证');

{
  const n = 10;
  const m = 45;
  let plantedOk = true;
  let solveOk = true;
  for (let seed = 1; seed <= 12; seed += 1) {
    const { cnf, planted } = plantedSat(n, m, 3, seed);
    if (!modelSatisfies(cnf, planted)) plantedOk = false;
    const r = dpllSolve(cnf);
    if (!r.sat) solveOk = false;
    else if (!modelSatisfies(cnf, r.model) || !checkModel(cnf, r.model)) solveOk = false;
  }
  ok(plantedOk, `种植解工厂 ×12 种子（n=${n}, m=${m}）：种植解本身代入满足全部子句（工厂构造正确）`);
  ok(solveOk, 'DPLL 全判 SAT 且返回模型代入通过（m/n=4.5 超阈值仍可靠——种植保证可行，求解器必须找到）');
}

// ═══════════════════ ⑤ #SAT 精确计数 ═══════════════════

section('⑤ #SAT：n≤16 随机公式精确计数 = 独立 2ⁿ 枚举');

{
  // 手工锚点：组件相乘（{1,2} 组件 2 模型 × {3,4} 组件 3 模型）
  const comp = { numVars: 4, clauses: [[1, 2], [-1, 2], [3, 4]] };
  const cComp = countModels(comp);
  const bComp = bruteCount(comp);
  ok(cComp === 6 && bComp === 6, `组件分解：{1,2} 2 模型 × {3,4} 3 模型 = 6（实测 ${cComp} = 独立枚举 ${bComp}——不相连变元相乘）`);

  // 手工锚点：自由变元乘数
  const free = { numVars: 5, clauses: [[1, 2]] };
  const cFree = countModels(free);
  ok(cFree === 24 && bruteCount(free) === 24, `自由变元：(x1∨x2) 上 3 模型 × 2³ 自由 = 24（实测 ${cFree}）`);

  const sizes = [8, 10, 12, 14, 16];
  const total = 30;
  let agreeN = 0;
  let maxCount = 0;
  let detOk = true;
  for (let i = 0; i < total; i += 1) {
    const nn = sizes[i % sizes.length];
    const mm = Math.round(nn * 4.26);
    const cnf = randomKSat(nn, mm, 3, 200 + i);
    const c = countModels(cnf);
    const b = bruteCount(cnf);
    if (c === b && near(c, b, 1e-12)) agreeN += 1;
    if (c > maxCount) maxCount = c;
    if (countModels(cnf) !== c) detOk = false;
  }
  ok(agreeN === total, `30 个随机公式（n∈{8,10,12,14,16}, m/n≈4.26）：精确计数与独立 2ⁿ 枚举逐位一致（1e-12 内 ${agreeN}/${total}）`);
  ok(maxCount > 0, `SAT 实例最大模型数 ${maxCount}（计数非退化）`);
  ok(detOk, 'countModels 重复调用结果一致（确定性）');
}

// ═══════════════════ ⑥ 单位传播不动点 ═══════════════════

section('⑥ 单位传播：不动点性质与手工推演');

{
  // 无冲突链：x1 → x2 → x3（手算 3 步）
  const chain = unitPropagate(new Map(), [[1], [-1, 2], [-2, 3]]);
  ok(chain.conflict === false && chain.propagations === 3, `单元链 x1→x2→x3：propagations=3（实测 ${chain.propagations}——手算一致）`);
  ok(JSON.stringify(chain.propagated) === JSON.stringify([1, 2, 3]), `传播顺序 = [1, 2, 3]（按子句序，确定性）`);
  const fixed = chain.assignment;
  const fixOk = [[1], [-1, 2], [-2, 3]].every((cl) => {
    let un = 0;
    let sat = false;
    for (const l of cl) {
      const val = fixed.get(Math.abs(l));
      if (val === undefined) un += 1;
      else if (val === (l > 0)) {
        sat = true;
        break;
      }
    }
    return sat || un >= 2; // 不动点：无残留单元（也无冲突）子句
  });
  ok(fixOk && chain.propagated.length === 3, '不动点性质：结果指派下无任何单元/冲突子句残留（传播到无可传播）');

  // 冲突链：手算 4 步传播后在 (¬4) 撞出空子句
  const confl = unitPropagate(new Map(), [[1], [-1, 2], [3], [-3, -2, 4], [-4]]);
  ok(
    confl.conflict === true && confl.propagations === 4 && JSON.stringify(confl.propagated) === JSON.stringify([1, 2, 3, 4]),
    `冲突链：先 4 步传播（1,2,3,4 全真）再在 (¬4) 冲突（实测 ${confl.propagations} 步 / conflict=${confl.conflict}）`,
  );
  ok(JSON.stringify(confl.conflictClause) === JSON.stringify([-4]), '冲突子句 [-4] 原样携带（冲突证明可查）');

  // 部分指派被尊重
  const part = unitPropagate(new Map([[1, false]]), [[-1, 2]]);
  ok(part.conflict === false && part.propagations === 0, '输入部分指派被尊重：x1=F 使 (¬1∨2) 已满足 → 零传播');
  const partConfl = unitPropagate(new Map([[1, true], [2, true]]), [[-1, -2, 3], [-3]]);
  ok(partConfl.conflict === true && partConfl.propagations === 1, '部分指派 + 1 步传播后冲突（3 被迫为真 → 与 (¬3) 矛盾）');
}

// ═══════════════════ DIMACS lite 解析 ═══════════════════

section('DIMACS lite 解析：还原与护栏');

{
  const dimacs = [
    'c 鸽笼原理 PHP(3,2): 3 球 2 洞 —— 经典不可满足',
    'p cnf 6 9',
    '1 2 0',
    '3 4 0',
    '5 6 0',
    '-1 -3 0',
    '-1 -5 0',
    '-3 -5 0',
    '-2 -4 0',
    '-2 -6 0',
    '-4 -6 0',
    '',
  ].join('\n');
  const parsed = parseDimacsLite(dimacs);
  ok(parsed.numVars === 6 && parsed.clauses.length === 9, `p 行解析：numVars=${parsed.numVars} / ${parsed.clauses.length} 子句`);
  ok(
    JSON.stringify(parsed.clauses) === JSON.stringify([[1, 2], [3, 4], [5, 6], [-1, -3], [-1, -5], [-3, -5], [-2, -4], [-2, -6], [-4, -6]]),
    '子句内容逐位还原（注释/空行跳过、0 终止符切分）',
  );
  ok(dpllSolve(parsed).sat === false, '解析产物直接求解：UNSAT（与手工构造的 PHP(3,2) 一致）');
  const noHeader = parseDimacsLite('1 2 0\n-1 0\n');
  ok(noHeader.numVars === 2 && JSON.stringify(noHeader.clauses) === JSON.stringify([[1, 2], [-1]]), '无 p 行 lite 模式：numVars = 最大 |文字|');
  const crossLine = parseDimacsLite('1 2\n-1 0\n3 0');
  ok(
    crossLine.numVars === 3 && JSON.stringify(crossLine.clauses) === JSON.stringify([[1, 2, -1], [3]]),
    '子句跨行拼接（0 终止符语义）+ EOF 未闭合末子句容忍收尾',
  );
  ok(throws(() => parseDimacsLite('p cnf 1 1\n1 2 0\n')), '越界文字（声明 1 变元出现文字 2）→ throw');
  ok(throws(() => parseDimacsLite('1 x 0\n')), '非整数 token → throw');
  ok(throws(() => parseDimacsLite('p dnf 3 2\n')), 'p 行格式错（dnf）→ throw');
}

// ═══════════════════ 入参校验 ═══════════════════

section('入参校验：全部入口显式 throw');

{
  ok(throws(() => dpllSolve({ numVars: 1, clauses: [[0]] })), '文字 0 非法 → throw');
  ok(throws(() => dpllSolve({ numVars: 1, clauses: [[2]] })), '文字越界（2 > numVars=1）→ throw');
  ok(throws(() => dpllSolve({ numVars: -1, clauses: [] })), 'numVars 负数 → throw');
  ok(throws(() => dpllSolve({ numVars: 1, clauses: 'x' })), 'clauses 非数组 → throw');
  ok(throws(() => dpllSolve({ numVars: 2, clauses: [[1], [1.5]] })), '非整数字字 → throw');
  ok(throws(() => randomKSat(3, 10, 4, 1)), 'randomKSat k > n → throw');
  ok(throws(() => plantedSat(0, 5, 2, 1)), 'plantedSat n=0 → throw');
  ok(throws(() => countModels({ numVars: 51, clauses: [] })), 'countModels n=51 超精确计数护栏 → throw');
  ok(throws(() => bruteForceSat({ numVars: 25, clauses: [] })), 'bruteForceSat n=25 超护栏 → throw');
  ok(throws(() => unitPropagate(null, [[1]])), 'unitPropagate partial 非 Map → throw');
  ok(throws(() => unitPropagate(new Map([[0, true]]), [[1]])), '部分指派变元 0 → throw');
  ok(throws(() => dpllSolve({ numVars: 1, clauses: [[1]] }, { seed: Number.NaN })), 'seed=NaN → throw');
  ok(throws(() => checkModel({ numVars: 1, clauses: [[1]] }, new Map())), '模型缺少变元 → throw');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) {
  console.log(`PASS ${passed} / FAIL ${failed} —— 85.0 符号求解内核全部锚点成立`);
} else {
  console.error(`PASS ${passed} / FAIL ${failed}`);
}
process.exitCode = failed === 0 ? 0 : 1;
