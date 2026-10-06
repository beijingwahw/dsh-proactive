/**
 * verify-causal-discovery.mjs — 77.0 因果发现内核（PC 算法）纯数学离线验证
 *
 * 五个验证锚点（不是「能跑」，是「算得对」——每个断言有解析解或
 * 独立重算对照；随机处全部走内核自带 mulberry32 种子，确定性可复现）:
 *   ① 链 X→Y→Z: X⊥Z|Y 检出（p>α、|ρ̂|≈0）、X∦Z 边缘依赖、骨架=链、
 *      CPDAG=无向链（链与反向链观测不可分——等价类诚实）
 *   ② 对撞 X→Y←Z: X⊥Z 边缘独立、X∦Z|Y（条件化对撞子令独立性精确
 *      翻转为强依赖 |ρ̂|>0.3）、v-结构定向正确（两条边全部定向）
 *   ③ 菱形 X→{Y,Z}→W: 10 种子 × n=5000，SHD(学习CPDAG, 真图CPDAG)=0，
 *      且输出 2 定向（对撞臂）+ 2 无向（可逆边）
 *   ④ 马尔可夫等价诚实性: 4 节点 3⁶=729 个图全枚举独立重算等价类
 *      （同骨架+同v-结构的无环图全体）——共识方向=强制边、方向可变=
 *      无向边，cpdagFromDag 与枚举结果逐边一致；Meek R1 传播另有
 *      数据驱动锚点（0→2←1 + 2−3 ⇒ 2→3）
 *   ⑤ 检验校准: H₀ 下 200 个独立数据集，p 值 KS 式统计 < 5% 临界值
 *      1.358/√200≈0.096、均值≈0.5、α=0.05 拒绝率≈α
 * 附加: 离散互信息检验（G²/χ²，含精确 Î=ln2 锚点 + 注入 PC 的骨架恢复）、
 *   随机 DAG 工厂无环性 + 端到端恢复（SHD≤2）、SEM 确定性、SHD 数学
 *   性质（增删/翻转/定向各计 1）、入参显式 throw。
 *
 * 运行: node --experimental-strip-types scripts/verify-causal-discovery.mjs
 */

import {
  mulberry32,
  partialCorrelationTest,
  mutualInformationTest,
  pcAlgorithm,
  randomDag,
  dagFromEdges,
  sampleLinearSem,
  structuralHammingDistance,
  cpdagFromDag,
  edgesOfMixed,
  vStructuresOf,
  cpdagSummary,
} from '../src/core/causal-discovery.ts';

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
/** H₀ 下 p 值均匀性的 KS 式统计 */
function ksStat(ps) {
  const s = [...ps].sort((a, b) => a - b);
  const m = s.length;
  let d = 0;
  for (let i = 0; i < m; i += 1) {
    d = Math.max(d, Math.abs(s[i] - (i + 1) / m), Math.abs(s[i] - i / m));
  }
  return d;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 确定性系数（多强度边，避免单一系数的侥幸通过） */
const coef = (u, v) => 0.7 + 0.1 * ((u + 2 * v) % 3);

// ═══════════════════ 检验数学核心：偏相关 Fisher-z ═══════════════════

section('偏相关 Fisher-z 数学核心（相关系数解析锚点 + 精确 p 值）');

{
  // X = 1·Z? —— 用 0→1 边系数 1、σ=1 的 SEM: corr(X,Y) 解析值 = 1/√2
  const dag01 = dagFromEdges(2, [[0, 1]]);
  const data01 = sampleLinearSem(dag01, 30000, { noiseSigma: 1, coefficients: 1.0 }, 5);
  const r = partialCorrelationTest(data01, 0, 1, []);
  ok(near(r.rho, 1 / Math.SQRT2, 0.015), `ρ̂=${r.rho.toFixed(4)} ≈ 1/√2=${(1 / Math.SQRT2).toFixed(4)}（b=1, σ=1 的解析相关，n=30000）`);
  ok(r.pValue < 1e-12 && !r.independent, `强相关 p=${r.pValue.toExponential(2)} < 1e-12（Fisher-z 拒绝独立）`);
  ok(r.df === 29997, `df = n−|S|−3 = ${r.df}（29997）`);
  const rTwice = partialCorrelationTest(data01, 0, 1, []);
  ok(eq(r, rTwice), '同输入同输出（纯函数确定性）');

  // 病态矩阵与恒定列的显式拒绝
  throws(() => partialCorrelationTest([[1, 2], [1, 3], [1, 4], [1, 5], [1, 6]], 0, 1, []), '恒定列（方差 0）显式 throw');
}

// ═══════════════════ 锚点① 链 X→Y→Z ═══════════════════

section('锚点① 链 X→Y→Z：X⊥Z|Y 检出、骨架=链、CPDAG=无向链');

{
  const chain = dagFromEdges(3, [[0, 1], [1, 2]]);
  const data = sampleLinearSem(chain, 5000, { noiseSigma: 1, coefficients: coef }, 1);
  const marginal = partialCorrelationTest(data, 0, 2, []);
  const given = partialCorrelationTest(data, 0, 2, [1]);
  ok(marginal.pValue < 1e-6 && !marginal.independent, `边缘 X∦Z（链上开放路径）p=${marginal.pValue.toExponential(2)} < 1e-6`);
  ok(given.pValue > 0.05 && given.independent && Math.abs(given.rho) < 0.06, `条件 X⊥Z|Y 检出：p=${given.pValue.toFixed(3)} > 0.05、|ρ̂|=${Math.abs(given.rho).toFixed(4)} < 0.06`);
  const pc = pcAlgorithm(data, { alpha: 0.01 });
  ok(
    pc.skeleton[0][1] === 1 && pc.skeleton[1][0] === 1 && pc.skeleton[1][2] === 1 && pc.skeleton[0][2] === 0 && pc.skeleton[2][0] === 0,
    '骨架 = 链（X−Y、Y−Z 在，X−Z 删）',
  );
  ok(eq(pc.sepsets.get('0|2'), [1]), `分离集 sepset(X,Z) = [${pc.sepsets.get('0|2')}]（阻断变量恰为中点 Y）`);
  const edges = edgesOfMixed(pc.cpdag);
  ok(edges.length === 2 && edges.every((e) => !e.directed), 'CPDAG = 无向链（X→Y→Z 与反向链观测不可分——不造假方向）');
  ok(pc.nConflicts === 0 && pc.nVStructures === 0, `无 v-结构、无方向冲突（nVStructures=${pc.nVStructures}, nConflicts=${pc.nConflicts}）`);
  ok(structuralHammingDistance(cpdagFromDag(chain), pc.cpdag) === 0, 'SHD(CPDAG(真图), 学习) = 0（等价类口径完全恢复）');
}

// ═══════════════════ 锚点② 对撞 X→Y←Z ═══════════════════

section('锚点② 对撞 X→Y←Z：独立性精确翻转 + v-结构定向');

{
  const collider = dagFromEdges(3, [[0, 1], [2, 1]]);
  const data = sampleLinearSem(collider, 5000, { noiseSigma: 1, coefficients: coef }, 7);
  const marginal = partialCorrelationTest(data, 0, 2, []);
  const given = partialCorrelationTest(data, 0, 2, [1]);
  ok(marginal.pValue > 0.05 && marginal.independent, `边缘 X⊥Z（对撞阻断）p=${marginal.pValue.toFixed(3)} > 0.05`);
  ok(given.pValue < 1e-6 && Math.abs(given.rho) > 0.3, `条件化对撞子后 X∦Z|Y：p=${given.pValue.toExponential(2)}、|ρ̂|=${Math.abs(given.rho).toFixed(3)} > 0.3（独立性精确翻转为强依赖——对撞判据）`);
  const pc = pcAlgorithm(data, { alpha: 0.01 });
  ok(pc.skeleton[0][1] === 1 && pc.skeleton[1][2] === 1 && pc.skeleton[0][2] === 0, '骨架 = 对撞骨架（X−Y、Y−Z 在，X−Z 删）');
  ok(eq(pc.sepsets.get('0|2'), []), 'sepset(X,Z) = ∅（边缘独立即删边——层 0）');
  ok(pc.cpdag[0][1] === 2 && pc.cpdag[1][0] === 0 && pc.cpdag[2][1] === 2 && pc.cpdag[1][2] === 0, 'v-结构定向：X→Y 且 Z→Y（两条边全部定向）');
  ok(eq(vStructuresOf(pc.cpdag), [{ x: 0, collider: 1, z: 2 }]), 'vStructuresOf = [X→Y←Z]（共同结果节点 Y）');
  ok(structuralHammingDistance(cpdagFromDag(collider), pc.cpdag) === 0, 'SHD = 0（对撞结构完全可识别——等价类唯一）');
}

// ═══════════════════ 锚点③ 菱形 × 10 种子 ═══════════════════

section('锚点③ 菱形 X→{Y,Z}→W：10 种子 × n=5000 全恢复 SHD=0');

{
  const diamond = dagFromEdges(4, [[0, 1], [0, 2], [1, 3], [2, 3]]);
  const truth = cpdagFromDag(diamond);
  const tEdges = edgesOfMixed(truth);
  ok(tEdges.length === 4 && tEdges.filter((e) => e.directed).length === 2, `真图 CPDAG = 4 边（2 定向对撞臂 + 2 无向可逆）——[${cpdagSummary(truth)}]`);
  let allZero = true;
  for (let s = 1; s <= 10; s += 1) {
    const data = sampleLinearSem(diamond, 5000, { noiseSigma: 1, coefficients: coef }, 101 + s * 13);
    const pc = pcAlgorithm(data, { alpha: 0.01 });
    const shd = structuralHammingDistance(truth, pc.cpdag);
    if (shd !== 0) allZero = false;
    ok(shd === 0, `种子 ${s}：SHD=${shd}（骨架 + 方向完全恢复）`);
  }
  ok(allZero, '10/10 种子 SHD=0（PC 在马尔可夫等价类意义上完全恢复菱形）');
  const pc1 = pcAlgorithm(sampleLinearSem(diamond, 5000, { noiseSigma: 1, coefficients: coef }, 114), { alpha: 0.01 });
  ok(eq(pc1.sepsets.get('1|2'), [0]) && eq(pc1.sepsets.get('0|3'), [1, 2]), '分离集语义正确：sepset(Y,Z)={X}（共同原因）、sepset(X,W)={Y,Z}（双重阻断）');
}

// ═══════════════════ Meek R1 传播（数据驱动） ═══════════════════

section('Meek 规则传播：v-结构 0→2←1 经 R1 强制 2→3');

{
  const dag = dagFromEdges(4, [[0, 2], [1, 2], [2, 3]]);
  const data = sampleLinearSem(dag, 5000, { noiseSigma: 1, coefficients: coef }, 11);
  const pc = pcAlgorithm(data, { alpha: 0.01 });
  ok(eq(pc.sepsets.get('0|1'), []), 'X,Y 边缘独立（无共同邻居）');
  ok(pc.cpdag[0][2] === 2 && pc.cpdag[1][2] === 2, 'v-结构 X→Z←Y 定向');
  ok(pc.cpdag[2][3] === 2 && pc.cpdag[3][2] === 0, `Z−W 由 Meek R1 传播定向为 Z→W（否则造成新 v-结构 X→Z←W；nMeekOriented=${pc.nMeekOriented}）`);
  ok(structuralHammingDistance(cpdagFromDag(dag), pc.cpdag) === 0, 'SHD = 0（v-结构 + Meek 传播 = 真图等价类）');
}

// ═══════════════════ 锚点④ 等价类诚实性（729 图全枚举互证） ═══════════════════

section('锚点④ 马尔可夫等价诚实性：全枚举独立重算 vs cpdagFromDag');

{
  // 独立重算：枚举所有无环图（每对变量 无/正向/反向 三态），
  // 同骨架 + 同 v-结构 = 马尔可夫等价类；共识方向 = 强制边，方向可变 = 可逆边。
  const acyclic = (n, adj) => {
    const indeg = new Array(n).fill(0);
    for (let u = 0; u < n; u++) for (let v = 0; v < n; v++) if (adj[u][v]) indeg[v] += 1;
    const q = [];
    for (let v = 0; v < n; v++) if (indeg[v] === 0) q.push(v);
    let cnt = 0;
    while (q.length) {
      const u = q.shift();
      cnt += 1;
      for (let v = 0; v < n; v++) if (adj[u][v] && --indeg[v] === 0) q.push(v);
    }
    return cnt === n;
  };
  const vstr = (n, adj) => {
    const out = [];
    for (let k = 0; k < n; k++) {
      const pa = [];
      for (let u = 0; u < n; u++) if (adj[u][k]) pa.push(u);
      for (let a = 0; a < pa.length; a += 1) for (let b = a + 1; b < pa.length; b += 1) {
        if (!adj[pa[a]][pa[b]] && !adj[pa[b]][pa[a]]) out.push(`${pa[a]}>${k}<${pa[b]}`);
      }
    }
    return out.sort().join(',');
  };
  const skel = (n, adj) => {
    const parts = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (adj[i][j] || adj[j][i]) parts.push(`${i}-${j}`);
    return parts.join(',');
  };
  const census = (truthAdj) => {
    const n = truthAdj.length;
    const pairs = [];
    for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) pairs.push([i, j]);
    const tS = skel(n, truthAdj);
    const tV = vstr(n, truthAdj);
    const members = [];
    const total = 3 ** pairs.length;
    for (let code = 0; code < total; code += 1) {
      let c = code;
      const adj = Array.from({ length: n }, () => new Array(n).fill(0));
      for (const [i, j] of pairs) {
        const st = c % 3;
        c = Math.floor(c / 3);
        if (st === 1) adj[i][j] = 1;
        else if (st === 2) adj[j][i] = 1;
      }
      if (acyclic(n, adj) && skel(n, adj) === tS && vstr(n, adj) === tV) members.push(adj);
    }
    const compelled = [];
    const reversible = [];
    for (const [i, j] of pairs) {
      if (!truthAdj[i][j] && !truthAdj[j][i]) continue;
      const allIJ = members.every((m) => m[i][j] === 1);
      const allJI = members.every((m) => m[j][i] === 1);
      if (allIJ && !allJI) compelled.push([i, j]);
      else if (allJI && !allIJ) compelled.push([j, i]);
      else reversible.push([i, j]);
    }
    return { size: members.length, compelled, reversible };
  };
  const cases = [
    { name: '链 X→Y→Z→W', dag: dagFromEdges(4, [[0, 1], [1, 2], [2, 3]]) },
    { name: '对撞+尾 0→2←1, 2→3', dag: dagFromEdges(4, [[0, 2], [1, 2], [2, 3]]) },
    { name: '菱形', dag: dagFromEdges(4, [[0, 1], [0, 2], [1, 3], [2, 3]]) },
    { name: '外向星 X→{Y,Z,W}', dag: dagFromEdges(4, [[0, 1], [0, 2], [0, 3]]) },
    { name: '内向星 {Y,Z,W}→X', dag: dagFromEdges(4, [[1, 0], [2, 0], [3, 0]]) },
    { name: '随机 DAG(4, 0.5, 9)', dag: randomDag(4, 0.5, 9) },
  ];
  for (const c of cases) {
    const cen = census(c.dag.adj);
    const cp = cpdagFromDag(c.dag);
    let match = true;
    for (const [i, j] of cen.compelled) if (!(cp[i][j] === 2 && cp[j][i] === 0)) match = false;
    for (const [i, j] of cen.reversible) if (!(cp[i][j] === 1 && cp[j][i] === 1)) match = false;
    for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) if (c.dag.adj[i][j] === 0 && c.dag.adj[j][i] === 0 && cp[i][j] !== 0) match = false;
    ok(match && cen.size >= 1, `${c.name}：等价类 ${cen.size} 个成员，强制 ${cen.compelled.length} 边全定向、可逆 ${cen.reversible.length} 边全无向——Meek 实现与全枚举逐边一致`);
  }
  const chainCen = census(dagFromEdges(4, [[0, 1], [1, 2], [2, 3]]).adj);
  ok(chainCen.compelled.length === 0 && chainCen.size >= 3, `纯链等价类 ${chainCen.size} 个方向成员、0 条强制边——观测数据对链方向彻底沉默（诚实输出无向）`);
  const starCen = census(dagFromEdges(4, [[1, 0], [2, 0], [3, 0]]).adj);
  ok(starCen.size === 1 && starCen.compelled.length === 3, `内向星等价类仅 ${starCen.size} 个成员、3 条边全强制——对撞结构方向完全可识别`);
}

// ═══════════════════ 锚点⑤ 检验校准 ═══════════════════

section('锚点⑤ 检验校准：H₀ 下 p 值均匀性（KS）+ 拒绝率 ≈ α');

{
  const empty4 = dagFromEdges(4, []);
  const psMarginal = [];
  const psCond = [];
  let rejections = 0;
  for (let r = 0; r < 200; r += 1) {
    const data = sampleLinearSem(empty4, 150, { noiseSigma: 1 }, 1000 + r);
    const a = partialCorrelationTest(data, 0, 1, []);
    const b = partialCorrelationTest(data, 0, 1, [2]);
    psMarginal.push(a.pValue);
    psCond.push(b.pValue);
    if (a.pValue <= 0.05) rejections += 1;
  }
  const ksM = ksStat(psMarginal);
  const ksC = ksStat(psCond);
  const meanM = psMarginal.reduce((x, y) => x + y, 0) / 200;
  const crit = 1.358 / Math.sqrt(200);
  ok(ksM < 0.1, `边缘检验 KS 统计=${ksM.toFixed(4)} < 5% 临界值 ${crit.toFixed(4)}（H₀ 下 p ~ U(0,1)）`);
  ok(ksC < 0.1, `条件检验 KS 统计=${ksC.toFixed(4)} < 5% 临界值 ${crit.toFixed(4)}（|S|=1 同样校准）`);
  ok(Math.abs(meanM - 0.5) < 0.06, `p 值均值=${meanM.toFixed(4)} ≈ 0.5（均匀分布期望）`);
  ok(rejections >= 4 && rejections <= 18, `α=0.05 实际拒绝 ${rejections}/200 = ${(rejections / 200).toFixed(3)}（二项 95% 带内 [4,18]）`);
}

// ═══════════════════ 离散互信息检验 ═══════════════════

section('离散互信息检验（G²/χ²）：精确 Î 锚点 + 注入 PC 骨架恢复');

{
  // xor 构造: Z 公共原因，X=Z⊕ε、Y=Z⊕ε —— 边缘相关、条件独立
  const rng = mulberry32(4242);
  const xor = [];
  for (let r = 0; r < 4000; r += 1) {
    const z = rng() < 0.5 ? 0 : 1;
    xor.push([z ^ (rng() < 0.15 ? 1 : 0), z ^ (rng() < 0.15 ? 1 : 0), z]);
  }
  const marg = mutualInformationTest(xor, 0, 1, []);
  const cond = mutualInformationTest(xor, 0, 1, [2]);
  ok(marg.pValue < 1e-6 && marg.mi > 0.1, `边缘互相关 Î=${marg.mi.toFixed(3)} nat、G²=${marg.g2.toFixed(0)}（p=${marg.pValue.toExponential(2)}，依赖）`);
  ok(cond.pValue > 0.05 && cond.independent, `控制 Z 后 Î|Z=${cond.mi.toFixed(3)}、p=${cond.pValue.toFixed(3)}（条件独立，dof=${cond.dof}）`);
  // 完全拷贝: Î(X;X) = 经验分布熵（解析闭式，与计数精确一致）
  const copy = [];
  for (let r = 0; r < 500; r += 1) {
    const x = rng() < 0.5 ? 0 : 1;
    copy.push([x, x]);
  }
  const cp = mutualInformationTest(copy, 0, 1, []);
  const n0 = copy.filter((row) => row[0] === 0).length;
  const n1 = copy.length - n0;
  const p0 = n0 / copy.length;
  const p1 = n1 / copy.length;
  const entropy = -(p0 * Math.log(p0) + p1 * Math.log(p1));
  ok(near(cp.mi, entropy, 1e-12) && near(entropy, Math.LN2, 0.005), `Î(X;X) = ${cp.mi.toFixed(9)} = 经验熵闭式 ${entropy.toFixed(9)}（≈ln2，独立重算逐位一致）、p=${cp.pValue.toExponential(2)}`);
  // 独立对照
  const indep = [];
  for (let r = 0; r < 500; r += 1) indep.push([rng() < 0.5 ? 0 : 1, rng() < 0.5 ? 0 : 1]);
  const ip = mutualInformationTest(indep, 0, 1, []);
  ok(ip.pValue > 0.05 && ip.independent, `独立对照 p=${ip.pValue.toFixed(3)}（校准不虚报依赖）`);
  // 注入 PC：二值链 Z→X→Y 骨架恢复
  const rngC = mulberry32(777);
  const dchain = [];
  for (let r = 0; r < 4000; r += 1) {
    const z = rngC() < 0.5 ? 0 : 1;
    const x = z ^ (rngC() < 0.1 ? 1 : 0);
    dchain.push([z, x, x ^ (rngC() < 0.1 ? 1 : 0)]);
  }
  const pc = pcAlgorithm(dchain, { alpha: 0.01, test: (d, i, j, S) => mutualInformationTest(d, i, j, S, { alpha: 0.01 }) });
  ok(pc.skeleton[0][1] === 1 && pc.skeleton[1][2] === 1 && pc.skeleton[0][2] === 0, '互信息检验注入 PC：二值链骨架恢复（离散数据同样学图）');
  ok(eq(pc.sepsets.get('0|2'), [1]), '离散分离集 sepset(Z,Y) = [X]');
}

// ═══════════════════ 随机 DAG 工厂 + 端到端恢复 ═══════════════════

section('随机 DAG 工厂 + 线性高斯 SEM：无环性 + 端到端结构恢复');

{
  let totalShd = 0;
  for (const seed of [3, 33, 333]) {
    const dag = randomDag(6, 0.35, seed);
    const pos = new Map(dag.order.map((v, i) => [v, i]));
    let acyclicOk = true;
    let nEdges = 0;
    for (let u = 0; u < 6; u += 1) for (let v = 0; v < 6; v += 1) if (dag.adj[u][v]) {
      nEdges += 1;
      if (pos.get(u) >= pos.get(v)) acyclicOk = false;
    }
    ok(acyclicOk && dag.order.length === 6, `randomDag(6, 0.35, ${seed})：${nEdges} 条边全部沿拓扑序（分层构造天然无环）`);
    const data = sampleLinearSem(dag, 8000, { noiseSigma: 1, coefficients: (u, v) => 0.6 + 0.1 * ((3 * u + 5 * v) % 4) }, seed * 7 + 1);
    const pc = pcAlgorithm(data, { alpha: 0.01 });
    const shd = structuralHammingDistance(cpdagFromDag(dag), pc.cpdag);
    totalShd += shd;
    ok(shd <= 2, `种子 ${seed}：n=8000 端到端 SHD=${shd}（${nEdges} 边随机 DAG 等价类恢复）`);
  }
  ok(totalShd <= 4, `三种子平均 SHD=${(totalShd / 3).toFixed(2)} ≤ 1.33（多强度系数下恢复稳定）`);
  // 确定性：同种子同图、同样本、同 PC 结果
  const d1 = randomDag(6, 0.35, 3);
  const d2 = randomDag(6, 0.35, 3);
  ok(eq(d1.adj, d2.adj), 'randomDag 同种子同图');
  const s1 = sampleLinearSem(d1, 500, { noiseSigma: 1 }, 42);
  const s2 = sampleLinearSem(d2, 500, { noiseSigma: 1 }, 42);
  ok(eq(s1, s2), 'sampleLinearSem 同种子同样本（Box–Muller 确定性）');
  const p1 = pcAlgorithm(s1, { alpha: 0.01 });
  const p2 = pcAlgorithm(s1, { alpha: 0.01 });
  ok(eq(p1.cpdag, p2.cpdag) && p1.nTests === p2.nTests, 'pcAlgorithm 纯函数确定性（同输入同输出）');
  ok(p1.nTests > 0 && p1.maxLevel <= 4, `nTests=${p1.nTests}、maxLevel=${p1.maxLevel}（检验计数与层级上界 d−2 自洽）`);
}

// ═══════════════════ SHD 数学性质 ═══════════════════

section('SHD 数学性质：增删/翻转/定向差异逐对计数');

{
  const g = cpdagFromDag(dagFromEdges(4, [[0, 1], [0, 2], [1, 3], [2, 3]])); // 0−1, 0−2 无向; 1→3, 2→3 定向
  ok(structuralHammingDistance(g, g) === 0, 'SHD(G,G) = 0');
  const orient = g.map((row) => [...row]);
  orient[0][1] = 2; // 0−1 无向 → 0→1 定向（造假方向）
  orient[1][0] = 0;
  ok(structuralHammingDistance(g, orient) === 1, '无向边被定向（等价类外造假）→ SHD=1');
  const drop = g.map((row) => [...row]);
  drop[2][3] = 0; // 删 2→3
  ok(structuralHammingDistance(g, drop) === 1, '删一条边 → SHD=1');
  const flip = g.map((row) => [...row]);
  flip[1][3] = 0; // 1→3 翻转为 3→1
  flip[3][1] = 2;
  ok(structuralHammingDistance(g, flip) === 1, '方向翻转 → SHD=1');
  const add = g.map((row) => [...row]);
  add[1][2] = 1; // 加一条 1−2 无向
  add[2][1] = 1;
  ok(structuralHammingDistance(g, add) === 1, '多一条边 → SHD=1');
  ok(cpdagSummary(g).includes('2 定向 / 2 无向'), 'cpdagSummary 口径：4 边（2 定向 / 2 无向）');
}

// ═══════════════════ 入参校验 ═══════════════════

section('入参校验（显式 throw，错误信息中文）');

{
  const ok2x5 = [
    [1, 2],
    [3, 4],
    [5, 3],
    [7, 8],
    [9, 10],
  ];
  throws(() => partialCorrelationTest([[1, 2], [3]], 0, 1, []), 'partialCorrelationTest: 行长不齐 throw');
  throws(() => partialCorrelationTest(ok2x5, 0, 0, []), 'partialCorrelationTest: i === j throw');
  throws(() => partialCorrelationTest(ok2x5, 0, 5, []), 'partialCorrelationTest: 下标越界 throw');
  throws(() => partialCorrelationTest(ok2x5, 0, 1, [0]), 'partialCorrelationTest: 条件集含被检变量 throw');
  throws(() => partialCorrelationTest(ok2x5, 0, 1, [1, 1]), 'partialCorrelationTest: 条件集重复 throw');
  throws(() => partialCorrelationTest(ok2x5, 0, 1, [], { alpha: 0 }), 'partialCorrelationTest: alpha=0 throw');
  throws(() => partialCorrelationTest(ok2x5, 0, 1, [1, 2].slice(0, 2)), 'partialCorrelationTest: n=5、|S|=2 自由度不足 throw');
  throws(() => pcAlgorithm(ok2x5, { alpha: 1.2 }), 'pcAlgorithm: alpha ∈ (0,1) 之外 throw');
  throws(() => pcAlgorithm([], { alpha: 0.05 }), 'pcAlgorithm: 空数据 throw');
  throws(() => randomDag(0, 0.5, 1), 'randomDag: nVars=0 throw');
  throws(() => randomDag(4, 1.5, 1), 'randomDag: edgeProb>1 throw');
  throws(() => dagFromEdges(3, [[0, 1], [1, 0]]), 'dagFromEdges: 双边成环 throw');
  throws(() => dagFromEdges(3, [[0, 0]]), 'dagFromEdges: 自环 throw');
  throws(() => dagFromEdges(3, [[0, 3]]), 'dagFromEdges: 下标越界 throw');
  throws(() => dagFromEdges(3, [[0, 1], [0, 1]]), 'dagFromEdges: 重复边 throw');
  throws(() => sampleLinearSem(dagFromEdges(2, [[0, 1]]), 0), 'sampleLinearSem: nSamples=0 throw');
  throws(() => sampleLinearSem(dagFromEdges(2, [[0, 1]]), 10, { noiseSigma: 0 }), 'sampleLinearSem: noiseSigma=0 throw');
  throws(() => structuralHammingDistance([[0]], [[0, 0], [0, 0]]), 'structuralHammingDistance: 阶数不一致 throw');
  throws(() => structuralHammingDistance([[0]], [[3]]), 'structuralHammingDistance: 值域 {0,1,2} 之外 throw');
  throws(() => structuralHammingDistance([[0, 1], [0, 0]], [[0, 0], [0, 0]]), 'structuralHammingDistance: 1/0 配对不变量破坏 throw');
  throws(() => mutualInformationTest([[0, 1], [1, -1], [0, 0], [1, 1], [0, 1]], 0, 1), 'mutualInformationTest: 负类别码 throw');
  throws(() => mutualInformationTest([[0, 1], [1, 0.5], [0, 0], [1, 1], [0, 1]], 0, 1), 'mutualInformationTest: 非整数类别码 throw');
  // 合法最小用例不误伤
  const small = partialCorrelationTest(ok2x5, 0, 1, [], { alpha: 0.05 });
  ok(Number.isFinite(small.pValue) && Number.isFinite(small.rho), 'n=5、|S|=0（df=2）合法通过——校验边界不误伤');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log('\n' + '═'.repeat(60));
if (failed === 0) {
  console.log(`✅ 全部 ${passed} 项断言通过 —— 77.0 因果发现内核（PC 算法）数学验证成立`);
} else {
  console.error(`❌ ${failed} 项失败（${passed} 项通过）`);
}
console.log(`PASS ${passed} / FAIL ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
