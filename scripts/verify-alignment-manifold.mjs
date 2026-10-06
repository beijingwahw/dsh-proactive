/**
 * verify-alignment-manifold.mjs — 78.0/79.0「多源对齐 + 流形学习」双内核纯数学离线验证
 *
 * 直接 import 两个内核源文件（node --experimental-strip-types 运行，
 * 不经 dist 构建）。每个断言都有解析解或构造轨迹对照（不是「能跑」，
 * 是「算得对」）：
 *
 *   78.0 多源对齐内核（CCA + 岭正则 + Jacobi/白化工具）：
 *     - 工具锚点: [[2,1],[1,2]] 精确谱 (3,1)；随机对称阵 VΛVᵀ 重构
 *       1e-10；白化 WᵀMW = I 精确（含秩亏截断 → rank 1）
 *     - 已知潜变量: X = AZ+ε₁、Y = BZ+ε₂，总体真值闭式
 *       ρᵢ = αᵢβᵢ/√((αᵢ²+σx²)(βᵢ²+σy²)) = 0.917431 / 0.844828——
 *       n=600 恢复误差 ≤ 0.03（信噪比 α²/σ² ≈ 11 / 5.4 口径文档化），
 *       方向 |cos| > 0.98（符号/尺度不变口径）
 *     - 典型变量正交: variates 互相关非对角 = 0.000000（< 0.05）、
 *       对角 = ρᵢ、scores 方差 = 1；符号约定双钉死
 *     - 不变性: X → XM（可逆，条件数 ≤ 4）ρ 谱不变（实测 3.3e-16）
 *     - 岭正则: p = q = 50 > n = 40——无正则 39 个 ρ 全部 = 1.000000
 *       （过拟合完美相关的崩溃，诚实报告）；λ=1 谱有界单调、中位数
 *       0.072、两个真潜因子在谱上显形（ρ₂−ρ₃ > 0.3）
 *
 *   79.0 流形学习内核（扩散映射 + Isomap-lite + 数据工厂）：
 *     - 瑞士卷 800 点（种子化、弧长均匀采样）: 第一非平凡扩散坐标与
 *       真实内在参数 t |corr| = 0.98 > 0.95（与 height 相关仅 0.08）
 *     - 两新月 300 点: 互锁月牙在扩散嵌入下最近质心分类 100%
 *       （原始欧氏空间同分类器仅 ~86%）
 *     - 不相连两簇: λ≈1 重数 = 2、相对谱隙 = 1.0 落在第 2 个特征值后、
 *       分量特征向量符号 100% 分簇
 *     - 保距: 扩散距离 vs 嵌入欧氏距离秩相关——两新月（全谱精确）
 *       0.999、瑞士卷（截断谱）0.995，双份 > 0.9（t=64 大尺度口径）
 *     - Isomap-lite: 测地距 + 古典 MDS 找回卷曲弧长（|corr| = 0.99）；
 *       Floyd–Warshall 含捷径/无穷边的精确对照
 *     - 带宽敏感性（两个失败方向各一例）: σ=1e-3 → 高斯核在采样间距
 *       以下下溢、连通团被撕成 ≥20 块（诚实报告孤立点）；三团完全图
 *       σ=100 → 扩散一步跨簇、三团粘连成一团（λ₂ 从 1.000 跌到 0.2）
 *
 * 全部断言确定性（mulberry32 种子；大图子空间迭代为固定种子初始）。
 * 运行：node --experimental-strip-types scripts/verify-alignment-manifold.mjs
 */

import {
  cca,
  ridgeCCA,
  whiten,
  jacobiEigen,
} from '../src/core/canonical-correlation.ts';
import {
  diffusionMaps,
  diffusionDistance,
  knnGraph,
  pairwiseDistances,
  floydWarshall,
  isomap,
  swissRoll,
  twoMoons,
  nearestCentroidClassify,
} from '../src/core/diffusion-maps.ts';

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

/** 确定性 RNG（mulberry32）+ Box–Muller */
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
function gauss(rng) {
  let u1 = rng();
  while (u1 <= 1e-12) u1 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
}
/** Pearson 相关 */
function corr(u, v) {
  const n = u.length;
  let m1 = 0;
  let m2 = 0;
  for (let i = 0; i < n; i += 1) {
    m1 += u[i];
    m2 += v[i];
  }
  m1 /= n;
  m2 /= n;
  let s = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i += 1) {
    s += (u[i] - m1) * (v[i] - m2);
    s1 += (u[i] - m1) ** 2;
    s2 += (v[i] - m2) ** 2;
  }
  return s / Math.sqrt(s1 * s2);
}
/** Spearman 秩相关（平手取平均秩） */
function rankCorr(a, b) {
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = new Array(arr.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  return corr(rank(a), rank(b));
}
/** |cos| 方向对齐（符号/尺度不变口径） */
function absCos(u, v) {
  let d = 0;
  let n1 = 0;
  let n2 = 0;
  for (let i = 0; i < u.length; i += 1) {
    d += u[i] * v[i];
    n1 += u[i] * u[i];
    n2 += v[i] * v[i];
  }
  return Math.abs(d / Math.sqrt(n1 * n2));
}

// ═══════════════════ 78.0 多源对齐内核 ═══════════════════

section('78.0 工具锚点：Jacobi 旋转与白化');

{
  const e = jacobiEigen([[2, 1], [1, 2]]);
  ok(near(e.values[0], 3, 1e-12) && near(e.values[1], 1, 1e-12), `jacobiEigen([[2,1],[1,2]]) = [${e.values.map((v) => v.toFixed(12)).join(', ')}]（解析谱 3, 1）`);
  ok(absCos(e.vectors[0], [1, 1]) > 1 - 1e-12 && absCos(e.vectors[1], [1, -1]) > 1 - 1e-12, `特征向量 (1,1)/√2、(1,−1)/√2（|cos| > 1−1e-12）`);
  // 随机对称 4×4：A = VΛVᵀ 重构 + V 正交
  const rng = mulberry32(4321);
  const A = Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => (i <= j ? gauss(rng) : 0)));
  for (let i = 0; i < 4; i += 1) for (let j = 0; j < i; j += 1) A[i][j] = A[j][i];
  const ea = jacobiEigen(A);
  let maxRec = 0;
  let maxOrth = 0;
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      let rec = 0;
      for (let k = 0; k < 4; k += 1) rec += ea.vectors[k][i] * ea.values[k] * ea.vectors[k][j];
      maxRec = Math.max(maxRec, Math.abs(rec - A[i][j]));
    }
    for (let j = 0; j < 4; j += 1) {
      let dot = 0;
      for (let k = 0; k < 4; k += 1) dot += ea.vectors[i][k] * ea.vectors[j][k];
      maxOrth = Math.max(maxOrth, Math.abs(dot - (i === j ? 1 : 0)));
    }
  }
  ok(maxRec < 1e-10, `随机对称 4×4 重构 A = VΛVᵀ（最大偏差 ${maxRec.toExponential(2)} < 1e-10）`);
  ok(maxOrth < 1e-10, `V 正交到机器精度（|VᵀV − I| 最大 ${maxOrth.toExponential(2)}）`);
  // 白化
  const wtmw = (wRes, m) => {
    const r = wRes.rank;
    const out = Array.from({ length: r }, () => new Array(r).fill(0));
    for (let a = 0; a < r; a += 1) {
      for (let b = 0; b < r; b += 1) {
        let s = 0;
        for (let i = 0; i < m.length; i += 1) for (let j = 0; j < m.length; j += 1) s += wRes.matrix[i][a] * m[i][j] * wRes.matrix[j][b];
        out[a][b] = s;
      }
    }
    return out;
  };
  const w = whiten([[2, 0], [0, 8]]);
  const wm = wtmw(w, [[2, 0], [0, 8]]);
  ok(
    w.rank === 2 && near(wm[0][0], 1, 1e-12) && near(wm[1][1], 1, 1e-12) && Math.abs(wm[0][1]) < 1e-15,
    `whiten(diag(2,8)): WᵀMW = I（对角 ${wm[0][0].toFixed(12)}, ${wm[1][1].toFixed(12)}；rank ${w.rank}）`,
  );
  const wr = whiten([[4, 2], [2, 1]]); // 秩 1（det = 0）
  const gv = wr.matrix[0][0] * 4 * wr.matrix[0][0] + wr.matrix[0][0] * 2 * wr.matrix[1][0] + wr.matrix[1][0] * 2 * wr.matrix[0][0] + wr.matrix[1][0] * 1 * wr.matrix[1][0];
  ok(wr.rank === 1 && wr.eigenvalues[1] <= 1e-10 && near(gv, 1, 1e-12), `whiten 秩亏截断: [[4,2],[2,1]] 谱 ${wr.eigenvalues.map((v) => v.toFixed(2)).join(',')} → rank ${wr.rank}，WᵀMW = [${gv.toFixed(12)}]（奇异方向不放大）`);
}

section('78.0 已知潜变量恢复：ρ 谱与方向（X = AZ+ε₁、Y = BZ+ε₂）');

{
  const rng = mulberry32(20261001);
  const n = 600;
  const Z = Array.from({ length: n }, () => [gauss(rng), gauss(rng)]);
  const A = [[1.0, 0, 0], [0, 0.7, 0]]; // α = (1, 0.7)，正交载荷
  const B = [[1.0, 0, 0], [0, 0.7, 0]]; // β = (1, 0.7)（同方向投影）
  const sx = 0.3;
  const sy = 0.3;
  const X = [];
  const Y = [];
  for (let i = 0; i < n; i += 1) {
    const xr = [0, 0, 0];
    const yr = [0, 0, 0];
    for (let k = 0; k < 2; k += 1) for (let j = 0; j < 3; j += 1) { xr[j] += Z[i][k] * A[k][j]; yr[j] += Z[i][k] * B[k][j]; }
    for (let j = 0; j < 3; j += 1) { xr[j] += sx * gauss(rng); yr[j] += sy * gauss(rng); }
    X.push(xr);
    Y.push(yr);
  }
  // 总体真值: ρᵢ = αᵢβᵢ / √((αᵢ²+σx²)(βᵢ²+σy²))
  const rho1True = (1.0 * 1.0) / Math.sqrt((1 + 0.09) * (1 + 0.09));
  const rho2True = (0.7 * 0.7) / Math.sqrt((0.49 + 0.09) * (0.49 + 0.09));
  const r = cca(X, Y);
  ok(
    Math.abs(r.canonicalCorrelations[0] - rho1True) <= 0.03 && Math.abs(r.canonicalCorrelations[1] - rho2True) <= 0.03,
    `ρ₁ = ${r.canonicalCorrelations[0].toFixed(6)}（真值 ${rho1True.toFixed(6)}）、ρ₂ = ${r.canonicalCorrelations[1].toFixed(6)}（真值 ${rho2True.toFixed(6)}）——误差 ≤ 0.03（信噪比 α²/σ² = 11.1 / 5.4）`,
  );
  ok(
    r.canonicalCorrelations[0] >= r.canonicalCorrelations[1] && r.canonicalCorrelations[1] >= r.canonicalCorrelations[2],
    `ρ 降序: ${r.canonicalCorrelations.map((v) => v.toFixed(4)).join(' ≥ ')}（第三对为私有噪声方向）`,
  );
  ok(r.canonicalCorrelations[2] < 0.15, `ρ₃ = ${r.canonicalCorrelations[2].toFixed(4)} < 0.15（第三方向无共享信号，纯噪声地板）`);
  ok(
    absCos(r.xVectors[0], [1, 0, 0]) > 0.98 && absCos(r.xVectors[1], [0, 1, 0]) > 0.98,
    `X 侧方向恢复 |cos| = ${absCos(r.xVectors[0], [1, 0, 0]).toFixed(4)}, ${absCos(r.xVectors[1], [0, 1, 0]).toFixed(4)} > 0.98（符号/尺度不变口径）`,
  );
  ok(
    absCos(r.yVectors[0], [1, 0, 0]) > 0.98 && absCos(r.yVectors[1], [0, 1, 0]) > 0.98,
    `Y 侧方向恢复 |cos| = ${absCos(r.yVectors[0], [1, 0, 0]).toFixed(4)}, ${absCos(r.yVectors[1], [0, 1, 0]).toFixed(4)} > 0.98`,
  );
  ok(JSON.stringify(cca(X, Y)) === JSON.stringify(r), '同输入同输出（cca 逐位确定）');
}

section('78.0 典型变量正交性与符号约定');

{
  const rng = mulberry32(20261001);
  const n = 600;
  const Z = Array.from({ length: n }, () => [gauss(rng), gauss(rng)]);
  const X = [];
  const Y = [];
  for (let i = 0; i < n; i += 1) {
    X.push([Z[i][0] + 0.3 * gauss(rng), 0.7 * Z[i][1] + 0.3 * gauss(rng), 0.3 * gauss(rng)]);
    Y.push([0.9 * Z[i][0] + 0.3 * gauss(rng), 0.7 * Z[i][1] + 0.3 * gauss(rng), 0.4 * Z[i][0] + 0.3 * gauss(rng)]);
  }
  const r = cca(X, Y);
  const m = r.canonicalCorrelations.length;
  let maxOffXX = 0;
  let maxOffXY = 0;
  let maxDiagErr = 0;
  let maxVarErr = 0;
  let signOk = true;
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < m; j += 1) {
      const c = corr(r.xScores[i], r.xScores[j]);
      if (i === j) continue;
      maxOffXX = Math.max(maxOffXX, Math.abs(c));
      maxOffXY = Math.max(maxOffXY, Math.abs(corr(r.xScores[i], r.yScores[j])));
    }
    maxDiagErr = Math.max(maxDiagErr, Math.abs(corr(r.xScores[i], r.yScores[i]) - r.canonicalCorrelations[i]));
    const v = r.xScores[i].reduce((s, x) => s + x * x, 0) / (n - 1);
    maxVarErr = Math.max(maxVarErr, Math.abs(v - 1));
    // 符号约定: 最大绝对分量 ≥ 0 且 corr(xs, ys) ≥ 0
    const a = r.xVectors[i];
    let maxAbs = 0;
    for (const av of a) maxAbs = Math.max(maxAbs, Math.abs(av));
    if (maxAbs > 0 && a.some((av) => Math.abs(Math.abs(av) - maxAbs) < 1e-15 && av < -1e-15)) signOk = false;
    let cross = 0;
    for (let t = 0; t < n; t += 1) cross += r.xScores[i][t] * r.yScores[i][t];
    if (cross < -1e-12) signOk = false;
  }
  ok(maxOffXX < 0.05, `X 侧 variates 互相关非对角最大 ${maxOffXX.toFixed(6)} < 0.05（近似对角）`);
  ok(maxOffXY < 0.05, `X×Y 交叉相关非对角最大 ${maxOffXY.toFixed(6)} < 0.05（不同典型变量互不相关）`);
  ok(maxDiagErr < 0.01, `corr(xsᵢ, ysᵢ) = ρᵢ（最大偏差 ${maxDiagErr.toFixed(6)}）`);
  ok(maxVarErr < 0.02, `scores 样本方差 = 1（单位方差口径；最大偏差 ${maxVarErr.toFixed(6)}）`);
  ok(signOk, '符号约定: 每个方向最大绝对分量 ≥ 0 且 corr(xs, ys) ≥ 0（消除 ±号自由度）');
}

section('78.0 不变性与边界对照');

{
  const rng = mulberry32(20261001);
  const n = 300;
  const X = [];
  const Y = [];
  for (let i = 0; i < n; i += 1) {
    const z1 = gauss(rng);
    const z2 = gauss(rng);
    X.push([z1 + 0.25 * gauss(rng), 0.6 * z2 + 0.25 * gauss(rng)]);
    Y.push([0.8 * z1 + 0.3 * gauss(rng), z2 + 0.3 * gauss(rng)]);
  }
  // 可逆线性变换 M（旋转 × 缩放，条件数 4）
  const th = 0.7;
  const M = [[Math.cos(th), -2 * Math.sin(th)], [Math.sin(th), 2 * Math.cos(th)]];
  const XM = X.map((row) => [row[0] * M[0][0] + row[1] * M[0][1], row[0] * M[1][0] + row[1] * M[1][1]]);
  const r1 = cca(X, Y);
  const r2 = cca(XM, Y);
  let maxDiff = 0;
  for (let i = 0; i < r1.canonicalCorrelations.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(r1.canonicalCorrelations[i] - r2.canonicalCorrelations[i]));
  ok(maxDiff < 1e-9, `X → XM 后 ρ 谱不变（最大差异 ${maxDiff.toExponential(2)} < 1e-9；公共信息量与坐标选取无关）`);
  const r3 = cca(Y, X);
  let maxSwap = 0;
  for (let i = 0; i < r1.canonicalCorrelations.length; i += 1) maxSwap = Math.max(maxSwap, Math.abs(r1.canonicalCorrelations[i] - r3.canonicalCorrelations[i]));
  ok(maxSwap < 1e-12, `cca(X,Y) = cca(Y,X)（对称性，最大差异 ${maxSwap.toExponential(2)}）`);
  // 相同数据 → ρ = 1；独立数据 → ρ 地板
  const same = cca(X, X);
  ok(same.canonicalCorrelations.every((v) => v > 1 - 1e-8), `X 对自身: ρ = ${same.canonicalCorrelations.map((v) => v.toFixed(10)).join(', ')}（完美相关 = 1）`);
  const rngI = mulberry32(555);
  const XI = [];
  const YI = [];
  for (let i = 0; i < 400; i += 1) {
    XI.push([gauss(rngI), gauss(rngI), gauss(rngI)]);
    YI.push([gauss(rngI), gauss(rngI), gauss(rngI)]);
  }
  ok(cca(XI, YI).canonicalCorrelations[0] < 0.25, `独立源对照: ρ₁ = ${cca(XI, YI).canonicalCorrelations[0].toFixed(4)} < 0.25（n=400 噪声地板，不制造虚假共享）`);
}

section('78.0 岭正则：p + q > n 的崩溃与救援（诚实报告）');

{
  const rng = mulberry32(777);
  const n = 40;
  const p = 50;
  const q = 50;
  const Z = Array.from({ length: n }, () => [gauss(rng), gauss(rng)]);
  const A = [[], []];
  const B = [[], []];
  for (let j = 0; j < p; j += 1) {
    const th1 = 0.37 * j + 0.2;
    A[0][j] = Math.cos(th1) * 1.4;
    A[1][j] = Math.sin(th1) * 0.9;
    B[0][j] = Math.cos(th1) * 1.2;
    B[1][j] = Math.sin(th1) * 0.8;
  }
  const s = 0.4;
  const X = [];
  const Y = [];
  for (let i = 0; i < n; i += 1) {
    const xr = new Array(p).fill(0);
    const yr = new Array(q).fill(0);
    for (let k = 0; k < 2; k += 1) for (let j = 0; j < p; j += 1) { xr[j] += Z[i][k] * A[k][j]; yr[j] += Z[i][k] * B[k][j]; }
    for (let j = 0; j < p; j += 1) { xr[j] += s * gauss(rng); yr[j] += s * gauss(rng); }
    X.push(xr);
    Y.push(yr);
  }
  const rho1True = (1.4 * 1.2) / Math.sqrt((1.96 + 0.16) * (1.44 + 0.16));
  const plain = cca(X, Y); // l2 = 0
  const mPlain = plain.canonicalCorrelations;
  const medianPlain = mPlain[Math.floor(mPlain.length / 2)];
  ok(
    plain.rankX === 39 && plain.rankY === 39 && mPlain.length === 39,
    `无正则: 样本协方差秩 ${plain.rankX} < p = ${p}（n−1 = 39）——min(rank) = 39 个典型方向`,
  );
  ok(
    mPlain.filter((v) => v > 0.99).length === 39 && medianPlain > 0.999,
    `崩溃口径（诚实报告）: 39 个 ρ 全部 > 0.99（中位数 ${medianPlain.toFixed(6)}）——白化放大噪声方向 → 过拟合完美相关，与真值 ρ₁ = ${rho1True.toFixed(4)} 无关`,
  );
  const ridge = ridgeCCA(X, Y, 1.0);
  const mr = ridge.canonicalCorrelations;
  const medianR = mr[Math.floor(mr.length / 2)];
  const sortedDesc = mr.every((v, i) => i === 0 || mr[i - 1] >= v - 1e-12);
  ok(
    mr.length === 50 && mr.every((v) => Number.isFinite(v) && v >= -1e-12 && v <= 1 + 1e-9) && sortedDesc,
    `ridgeCCA(λ=1): 50 个有限 ρ ∈ [0, 1]（λ>0 白化恒满秩），降序 = ${sortedDesc}`,
  );
  ok(medianR < 0.5, `岭谱中位数 ${medianR.toFixed(4)} < 0.5（对照无正则的 ${medianPlain.toFixed(4)}——噪声方向被压平）`);
  ok(
    mr[0] >= 0.6 && mr[0] <= 0.995 && mr[1] - mr[2] > 0.3,
    `真信号显形: ρ₁ = ${mr[0].toFixed(4)}（真值 ${rho1True.toFixed(4)}）、ρ₂ = ${mr[1].toFixed(4)} ≫ ρ₃ = ${mr[2].toFixed(4)}（两个真潜因子后断崖，其余为受控噪声）`,
  );
}

section('78.0 入参校验');

{
  ok(throws(() => cca([[1, 2], [3, 4]], [[1, 2]])), 'cca: X/Y 行数不一致 throw');
  ok(throws(() => cca([[1, Number.NaN], [3, 4]], [[1, 2], [3, 4]])), 'cca: 非有限数 throw');
  ok(throws(() => cca([[1, 2]], [[3, 4]])), 'cca: n < 2 throw');
  ok(throws(() => cca([[1, 2], [3, 4]], [[1, 2], [3, 4]], { l2: -0.1 })), 'cca: 负 l2 throw');
  ok(throws(() => ridgeCCA([[1, 2], [3, 4]], [[1, 2], [3, 4]], -1)), 'ridgeCCA: 负 lambda throw');
  ok(throws(() => jacobiEigen([[1, 2, 3], [4, 5, 6]])), 'jacobiEigen: 非方阵 throw');
  ok(throws(() => whiten([[1, 2], [3, 4], [5, 6]])), 'whiten: 非方阵 throw');
  ok(throws(() => whiten([[1, 0], [0, 1]], -1)), 'whiten: 非正 rankTol throw');
}

// ═══════════════════ 79.0 流形学习内核 ═══════════════════

section('79.0 数据工厂与 kNN 图');

{
  const roll = swissRoll(800, 7);
  ok(roll.points.length === 800 && roll.points.every((p) => p.length === 3 && p.every(Number.isFinite)), 'swissRoll(800, 7): 800 × 3 全有限');
  ok(
    roll.t.every((t) => t >= 1.5 * Math.PI - 0.01 && t <= 4.5 * Math.PI + 0.01),
    `t ∈ [1.5π, 4.5π]（实测 [${Math.min(...roll.t).toFixed(3)}, ${Math.max(...roll.t).toFixed(3)}]，弧长均匀采样）`,
  );
  ok(JSON.stringify(swissRoll(800, 7)) === JSON.stringify(roll), '同种子逐位复现（swissRoll 工厂确定性）');
  ok(JSON.stringify(swissRoll(800, 8)) !== JSON.stringify(roll), '异种子序列不同');
  // kNN 精确对照: 数线 5 点
  const line = [[0], [1], [2], [3], [4]];
  const g = knnGraph(line, 2);
  const nb2 = g.neighbors[2].map((e) => `${e.index}:${e.distance}`).join(' ');
  ok(
    g.neighbors[2].length === 2 && g.neighbors[2][0].index === 1 && near(g.neighbors[2][0].distance, 1) && g.neighbors[2][1].index === 3 && near(g.neighbors[2][1].distance, 1),
    `knnGraph 数线 5 点 k=2: 点 2 的近邻 = {1:1.0, 3:1.0}（实测 ${nb2}；不含自身、按距离升序）`,
  );
  ok(g.neighbors[0][0].index === 1 && g.neighbors[0][1].index === 2, '端点 0 的近邻 = {1, 2}（边界口径）');
  const pd = pairwiseDistances([[0, 0], [3, 4]]);
  ok(near(pd[0][1], 5, 1e-12) && pd[0][0] === 0, `pairwiseDistances: (0,0)-(3,4) = ${pd[0][1]}（3-4-5 精确）`);
}

section('79.0 瑞士卷：弯曲流形的内在坐标找回（800 点）');

{
  const roll = swissRoll(800, 7);
  const res = diffusionMaps(roll.points, { k: 10, t: 1, dims: 3, eigenCount: 28 });
  const psi1 = res.embedding.map((e) => e[0]);
  const cT = Math.abs(corr(psi1, roll.t));
  const cH = Math.abs(corr(psi1, roll.height));
  ok(
    cT > 0.95,
    `第一非平凡扩散坐标 vs 真实内在参数 t: |corr| = ${cT.toFixed(4)} > 0.95（欧氏空间里卷曲相邻的圈不再欺骗度量）`,
  );
  ok(cH < 0.5, `同一坐标与另一内在参数 height: |corr| = ${cH.toFixed(4)}（弧长方向主导，λ(π/L)² ≪ λ(π/H)²）`);
  ok(
    res.trivialIndices.length === 1 && res.nComponents === 1 && res.eigenvalues.length === 28,
    `平凡分量 1 个（λ₁ = ${res.eigenvalues[0].toFixed(9)}）、连通分量 1、计算谱宽 28（大图子空间迭代路径）`,
  );
  ok(res.embedding.every((row) => row.every(Number.isFinite)), '嵌入全有限');
}

section('79.0 两新月：互锁月牙在扩散坐标下线性可分');

{
  const moons = twoMoons(300, 13);
  const res = diffusionMaps(moons.points, { k: 8, t: 1, dims: 3, eigenCount: 300 });
  // 分层切分（i%3===0 为测试集 → 200 训练 / 100 测试，两月牙各半）
  const trainIdx = [];
  const testIdx = [];
  for (let i = 0; i < 300; i += 1) (i % 3 === 0 ? testIdx : trainIdx).push(i);
  const train = trainIdx.map((i) => res.embedding[i]);
  const trainLab = trainIdx.map((i) => moons.labels[i]);
  const test = testIdx.map((i) => res.embedding[i]);
  const testLab = testIdx.map((i) => moons.labels[i]);
  const clsEmb = nearestCentroidClassify(train, trainLab, test);
  let hitEmb = 0;
  for (let i = 0; i < test.length; i += 1) if (clsEmb.predictions[i] === testLab[i]) hitEmb += 1;
  const clsAmb = nearestCentroidClassify(trainIdx.map((i) => moons.points[i]), trainLab, testIdx.map((i) => moons.points[i]));
  let hitAmb = 0;
  for (let i = 0; i < test.length; i += 1) if (clsAmb.predictions[i] === testLab[i]) hitAmb += 1;
  ok(
    hitEmb === test.length,
    `嵌入空间最近质心分类 ${hitEmb}/${test.length} = 100%（${clsEmb.centroids.map((c) => `标签${c.label}×${c.count}`).join('、')}）`,
  );
  ok(
    hitEmb >= hitAmb,
    `对照原始欧氏空间同分类器: ${hitAmb}/${test.length} = ${(hitAmb / test.length).toFixed(2)}（互锁月牙在原始空间不可线性分开，扩散坐标拉开）`,
  );
  ok(
    res.nComponents === 1 && res.eigenvalues[1] > 0.999,
    `新月图连通但近断开: nComponents = 1、λ₂ = ${res.eigenvalues[1].toFixed(7)} ≈ 1（尖端少数跨边承压——分月结构在 λ₂/ψ₂ 上）`,
  );
  const res2 = diffusionMaps(moons.points, { k: 8, t: 1, dims: 3, eigenCount: 300 });
  ok(JSON.stringify(res.embedding) === JSON.stringify(res2.embedding), '同输入同输出（小图全谱 Jacobi 路径逐位确定）');
}

section('79.0 不相连两簇：谱定簇数、符号定簇属');

{
  const rng = mulberry32(99);
  const pts = [];
  const labels = [];
  for (let i = 0; i < 120; i += 1) {
    const c = i < 60 ? -6 : 6;
    pts.push([c + gauss(rng), gauss(rng)]);
    labels.push(i < 60 ? 0 : 1);
  }
  const res = diffusionMaps(pts, { k: 8, t: 1, dims: 3, eigenCount: 16 });
  ok(
    res.nComponents === 2 && res.eigenvalues[1] > 1 - 1e-6,
    `λ≈1 重数 = 2（nComponents = ${res.nComponents}、λ₂ = ${res.eigenvalues[1].toFixed(9)}）——不相连分量数在谱上`,
  );
  ok(
    res.gapIndex === 2 && res.spectralGap > 0.8,
    `相对谱隙 ${res.spectralGap.toFixed(4)} 落在第 ${res.gapIndex} 个特征值之后（λ₂ − λ₃ 的相对跌落 > 0.8 → 簇数口径 = 2）`,
  );
  const splitter = res.eigenvectors[1];
  let acc = 0;
  for (let i = 0; i < 120; i += 1) if ((splitter[i] >= 0 ? 0 : 1) === labels[i]) acc += 1;
  ok(
    Math.max(acc, 120 - acc) === 120,
    `分量特征向量符号分簇 100%（极性 ${Math.max(acc, 120 - acc)}/120；确定性符号约定下簇属逐点可读）`,
  );
  const trainIdxB = [];
  const testIdxB = [];
  for (let i = 0; i < 120; i += 1) (i % 2 === 0 ? trainIdxB : testIdxB).push(i);
  const cls = nearestCentroidClassify(trainIdxB.map((i) => res.embedding[i]), trainIdxB.map((i) => labels[i]), testIdxB.map((i) => res.embedding[i]));
  let hit = 0;
  for (let i = 0; i < testIdxB.length; i += 1) if (cls.predictions[i] === labels[testIdxB[i]]) hit += 1;
  ok(hit === testIdxB.length, `嵌入坐标最近质心: ${hit}/${testIdxB.length} = 100%（第一嵌入坐标即簇轴）`);
}

section('79.0 扩散距离 ≈ 嵌入距离（保距性质，t=64 大尺度口径）');

{
  const rankCorrFrom = (res, seed, nPairs, dims) => {
    const rng = mulberry32(seed);
    const n = res.embedding.length;
    const dd = [];
    const ee = [];
    for (let s = 0; dd.length < nPairs && s < nPairs * 4; s += 1) {
      const i = Math.floor(rng() * n);
      const j = Math.floor(rng() * n);
      if (i === j) continue;
      dd.push(diffusionDistance(res, i, j));
      let ss = 0;
      for (let d = 0; d < dims; d += 1) ss += (res.embedding[i][d] - res.embedding[j][d]) ** 2;
      ee.push(Math.sqrt(ss));
    }
    return { rho: rankCorr(dd, ee), pairs: dd.length };
  };
  // 两新月: 全谱精确（299 个非平凡分量）vs 10 维嵌入
  const moons = twoMoons(300, 13);
  const rm64 = diffusionMaps(moons.points, { k: 8, t: 64, dims: 10, eigenCount: 300 });
  const mres = rankCorrFrom(rm64, 2024, 150, 10);
  ok(
    mres.rho > 0.9,
    `两新月（全谱精确口径）: ${mres.pairs} 对采样，扩散距离 vs 10 维嵌入欧氏距离秩相关 = ${mres.rho.toFixed(4)} > 0.9（Ψₜ 的坐标差就是截断扩散距离）`,
  );
  // 瑞士卷: 截断谱（40 对）vs 12 维嵌入
  const roll = swissRoll(800, 7);
  const rr64 = diffusionMaps(roll.points, { k: 10, t: 64, dims: 12, eigenCount: 40 });
  const rres = rankCorrFrom(rr64, 555, 120, 12);
  ok(
    rres.rho > 0.9,
    `瑞士卷（截断谱口径）: ${rres.pairs} 对采样，40 对特征谱扩散距离 vs 12 维嵌入秩相关 = ${rres.rho.toFixed(4)} > 0.9（大 t 下距离质量集中于前若干模态，截断保序）`,
  );
}

section('79.0 Isomap-lite 对照：测地距 + 古典 MDS');

{
  const fw = floydWarshall([
    [0, 1, 7, Infinity, Infinity],
    [1, 0, 4, Infinity, Infinity],
    [7, 4, 0, 2, Infinity],
    [Infinity, Infinity, 2, 0, Infinity],
    [Infinity, Infinity, Infinity, Infinity, 0],
  ]);
  ok(
    fw[0][2] === 5 && fw[0][3] === 7 && fw[1][3] === 6 && fw[0][4] === Infinity && fw[4][4] === 0,
    `floydWarshall 精确对照: d(0→2) = ${fw[0][2]}（捷径 1+4 < 直连 7）、d(0→3) = ${fw[0][3]}、d(1→3) = ${fw[1][3]}、孤立点 4 = ∞`,
  );
  const roll = swissRoll(300, 7);
  const iso = isomap(roll.points, { k: 5, dims: 2 });
  const c0 = Math.abs(corr(iso.embedding.map((e) => e[0]), roll.t));
  ok(
    iso.components === 1 && c0 > 0.9,
    `isomap 瑞士卷 300 点: 测地距解开卷曲后第一 MDS 坐标与弧长参数 |corr| = ${c0.toFixed(4)} > 0.9（所用特征值 ${iso.eigenvalues.map((v) => v.toFixed(0)).join(', ')}）`,
  );
  const line = Array.from({ length: 40 }, (_, i) => [i * 1.0]);
  const isoLine = isomap(line, { k: 2, dims: 1 });
  ok(
    Math.abs(corr(isoLine.embedding.map((e) => e[0]), line.map((p) => p[0]))) > 1 - 1e-9,
    'isomap 直线退化: 嵌入坐标 = 原坐标（|corr| = 1，MDS 机器精度锚点）',
  );
}

section('79.0 带宽敏感性：两个失败方向（诚实报告）');

{
  // 方向一: σ 过小 → 高斯核在采样间距以下下溢 → 图碎片化
  const rng = mulberry32(64);
  const blob = Array.from({ length: 60 }, () => [gauss(rng), gauss(rng)]);
  const frag = diffusionMaps(blob, { k: 8, sigma: 0.001, dims: 2, eigenCount: 8 });
  const ctrl = diffusionMaps(blob, { k: 8, dims: 2, eigenCount: 8 });
  ok(
    frag.isolated.length >= 20 && frag.nComponents >= 20 && ctrl.nComponents === 1,
    `σ=10⁻³（≪ 采样间距 ~0.3）: ${frag.isolated.length}/60 点孤立、图撕成 ${frag.nComponents} 块（同数据自适应带宽 = ${ctrl.nComponents} 个连通分量——带宽是分辨率，过小即碎片）`,
  );
  ok(frag.embedding.every((row) => row.every(Number.isFinite)), '碎片化路径仍全有限（诚实退化不崩溃）');
  // 方向二: σ 过大 → 扩散一步跨簇 → 多簇粘连（完全图口径，三团）
  const rng2 = mulberry32(314);
  const centers = [[-6, 0], [0, 6], [6, 0]];
  const pts = [];
  const labels3 = [];
  for (let c = 0; c < 3; c += 1) {
    for (let i = 0; i < 20; i += 1) {
      pts.push([centers[c][0] + gauss(rng2), centers[c][1] + gauss(rng2)]);
      labels3.push(c);
    }
  }
  const adaptive = diffusionMaps(pts, { k: 8, dims: 3, eigenCount: 16 });
  const sep = diffusionMaps(pts, { k: pts.length - 1, sigma: 1, dims: 3, eigenCount: 16 });
  const melt = diffusionMaps(pts, { k: pts.length - 1, sigma: 100, dims: 3, eigenCount: 16 });
  ok(
    adaptive.nComponents === 3,
    `三团自适应带宽（kNN 图）: nComponents = ${adaptive.nComponents}（λ₁₋₃ = ${adaptive.eigenvalues.slice(0, 3).map((v) => v.toFixed(6)).join(', ')}）`,
  );
  ok(
    sep.nComponents === 3,
    `完全图 σ=1（核分离口径）: nComponents = ${sep.nComponents}（簇间距离 8.5σ → 跨簇权重 e⁻³⁶ 下溢为 0，核正确看见三团）`,
  );
  ok(
    melt.nComponents === 1 && melt.eigenvalues[1] < 0.5,
    `完全图 σ=100: nComponents = ${melt.nComponents}、λ₂ = ${melt.eigenvalues[1].toFixed(4)}（从 1.000 跌落）——带宽吞掉簇间距离，扩散一步跨簇、三团粘连成一团`,
  );
}

section('79.0 入参校验');

{
  const pts = [[0, 0], [1, 0], [0, 1]];
  ok(throws(() => knnGraph(pts, 3)), 'knnGraph: k ≥ n throw');
  ok(throws(() => knnGraph(pts, 0)), 'knnGraph: k < 1 throw');
  ok(throws(() => diffusionMaps(pts, { sigma: 0 })), 'diffusionMaps: sigma = 0 throw');
  ok(throws(() => diffusionMaps(pts, { sigma: Number.NaN })), 'diffusionMaps: sigma = NaN throw');
  ok(throws(() => diffusionMaps(pts, { dims: 0 })), 'diffusionMaps: dims < 1 throw');
  ok(throws(() => diffusionMaps(pts, { k: 5 })), 'diffusionMaps: k > n−1 throw');
  ok(throws(() => diffusionMaps(pts, { dims: 2, eigenCount: 2 })), 'diffusionMaps: eigenCount < dims+1 throw');
  ok(throws(() => diffusionMaps(pts, { t: -1 })), 'diffusionMaps: 负 t throw');
  ok(throws(() => floydWarshall([[0, 1], [-1, 0]])), 'floydWarshall: 负边权 throw');
  ok(throws(() => floydWarshall([[0, 1, 2], [1, 0, 2]])), 'floydWarshall: 非方阵 throw');
  ok(throws(() => isomap(pts, { dims: 0 })), 'isomap: dims < 1 throw');
  ok(throws(() => swissRoll(0, 1)), 'swissRoll: n < 1 throw');
  ok(throws(() => twoMoons(1, 1)), 'twoMoons: n < 2 throw');
  ok(throws(() => nearestCentroidClassify(pts, [0, 1], pts)), 'nearestCentroidClassify: labels 长度不匹配 throw');
  const res = diffusionMaps(pts, { k: 1, dims: 1 });
  ok(throws(() => diffusionDistance(res, 0, 3)), 'diffusionDistance: 下标越界 throw');
  ok(throws(() => pairwiseDistances([[0, 0], [0, Number.NaN]])), 'pairwiseDistances: 非有限数 throw');
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
