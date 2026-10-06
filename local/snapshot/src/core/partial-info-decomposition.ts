/**
 * partial-info-decomposition.ts — 70.0 部分信息分解内核：把「1+1>2」第一次写成可计算的数
 *
 * 动机: 16.0 Shapley 归因只会平分功劳——联盟价值是黑盒，它分不清
 * 「两路证据各自有用（贡献可加）」与「两路证据单独都没用、合起来才有
 * 用（协同）」。多模型调度里最贵的判断恰恰是后者：模型 A 与 B 单测
 * 平庸、联测封神的组合，加法归因（Shapley 也好、命中率也好）永远
 * 看不见，于是要么错杀、要么靠运气撞见。互信息同样只见总量：
 * I(X₁,X₂;S) 回答「一共多少信息」，不回答「信息从哪条路来、怎么
 * 叠加」。部分信息分解（PID）把总量拆成四种血统——「哪些模型组合
 * 值得保留」第一次有了信息论定价。
 *
 * 数学（Williams–Beer 2010 PID 框架 + BROJA 口径；二输入 X₁,X₂、目标 S）:
 *   I(X₁,X₂;S) = R + U₁ + U₂ + C
 *     R 冗余：两路都携带的相同信息；U₁/U₂ 独占：只有一路携带；
 *     C 协同：只在联合中存在、任一单路都看不到的信息。
 * BROJA（Bertschinger–Rauh–Olbrich–Jost–Ay 2014, Entropy）把求解化成
 * 一个凸规划——在保持各源条件边缘 p(xᵢ|s) 不变的一切 q(x₁,x₂|s) 中
 * 找联合互信息最小者：
 *   m = min_q I_q(X₁,X₂;S)
 *       s.t. Σ_{x₂} q(x₁,x₂|s) = p(x₁|s)，Σ_{x₁} q(x₁,x₂|s) = p(x₂|s)
 * 可行集上 I_q(Xᵢ;S) = I(Xᵢ;S) 被边缘钉死，链式法则
 * I_q(X₁;S|X₂) = I_q(X₁,X₂;S) − I(X₂;S) ⇒ 一次优化同时导出全部原子：
 *   R = I(X₁;S) + I(X₂;S) − m   （等价于 max_q 协同信息 CoI_q）
 *   U₁ = m − I(X₂;S)，U₂ = m − I(X₁;S)，C = I(X₁,X₂;S) − m
 *   守恒 R+U₁+U₂+C = I 精确成立；局部一致性 R + Uᵢ = I(Xᵢ;S)
 *   （BROJA 特有性质——Williams–Beer 原版 I_min 不满足）。
 * 求解器（内点可行方向 + 精确线搜索）：初始点取独立耦合
 * q = p(x₁|s)p(x₂|s)（天然可行、支撑内部严格为正——内点起点）；每轮把
 * 负梯度正交投影到「行和 = 列和 = 0」的切空间（双向 ANOVA 交互子
 * 空间，闭式解），得到可行下降方向 D——沿 q+tD 步进行/列边缘精确
 * 保持（无需投影重归一化），对凸一维目标 φ(t) = F(q+tD) 做黄金分割
 * 精确线搜索。目标序列单调不降（验证锚点）；MI 对条件分布凸、可行
 * 集是线性多面体 ⇒ 凸问题全局收敛；全程无随机，同输入同输出。
 * （不用「Sinkhorn 重投影 + 指数步」的原因：近似独立耦合处 IPF 收敛
 * 速率趋于抛物线 1/k，投影残差会漏进接受点，把目标压到真最优之下。）
 * 附 O 信息（Rosas et al. 2019 符号约定，n 源推广）：
 *   Ω = Σᵢ I(Xᵢ;S) − I(X₁,…,X_n;S)
 *   Ω > 0 冗余主导（整体小于部分之和——证据可相互替代）；
 *   Ω < 0 协同主导（1+1>2——必须联合使用才有价值）。
 *
 * 验证锚点（二值逻辑门，BROJA 文献已知值；scripts/verify-partial-info-decomposition.mjs）：
 * ① XOR：I=1 bit、R=0、U₁=U₂=0、C=1（协同纯血统——单路零信息）；
 * ② COPY（X₁=X₂=S 均匀二值）：R=1、C=0、U=0（冗余纯血统）；
 * ③ AND：文献值 R≈0.3113、U₁=U₂=0、C=0.5（容差 0.02；另用本内核公开
 *    mutualInformation 工具对 AND 的一维可行族做独立网格重推导对照）；
 * ④ 独占例（S=X₁、X₂ 独立噪声）：U₁=1 其余 0；
 * ⑤ 分解守恒 R+U₁+U₂+C=I 精确（≤1e-9）+ 局部一致性 R+Uᵢ=I(Xᵢ;S)；
 * ⑥ 求解器收敛性：目标单调不增、边缘约束违反 ≤1e-9、
 *    m ∈ [max(I(X₁;S),I(X₂;S)), I(X₁,X₂;S)]（理论下/上界）；
 * ⑦ O 信息符号：XOR Ω=−1<0 协同主导、COPY Ω=+1>0 冗余主导。
 *
 * 与 16.0/37.0 的关系：Shapley 是加法归因（功劳平分），本内核捕捉
 * 非加法协同（单独都没用、合起来才有用的组合）——是其信息论姊妹篇；
 * 37.0 信息瓶颈回答「表征该压缩成什么」，本内核回答「多路信息如何
 * 叠加」——同属信息论家族，共用互信息工具与迭代优化的房屋风格。
 *
 * R5 进化（第五轮·信息几何世界性进化）：
 * ① **BROJA 一阶 KKT 残差证书**（数值稳健性/最优性验证）：凸目标在
 *   可行支撑内部的平稳条件 = 梯度在每片 s 的「行+列可加」分解
 *   （G_s(a,b) = r_a + c_b；等价于一切交互差 G_ab − G_ab′ − G_a′b +
 *   G_a′b′ = 0）。trace.maxKktResidual 报告 max|G − r − c + grand|：
 *   ≤ tol 且迭代点内部 ⟹ 凸问题**全局最优被证书钉死**（XOR/COPY/
 *   独占/噪声 XOR 等内点最优实例即此情形）；残差大 ⟹ 最优点在支撑
 *   边界（约束起作用——AND 门 a* 落在可行线段端点即此情形），如实
 *   报告而非伪装收敛。
 * ② **线搜索早停**（性能）：黄金分割区间收缩至机器精度相对宽度
 *   （(hi−lo) ≤ 1e-15·max(1,hi)）即停——80 轮全额收缩到 ~8e-17 超出
 *   double 分辨率，尾段迭代是纯开销；trace.lineSearchEvaluations 计
 *   数审计节省量，PidOptions.lineSearchEarlyExit: false 可关回旧口径
 *   （等价性可逐位对照）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 类型 ───────────────────────────

/** PID 求解选项 */
export interface PidOptions {
  /** 外层迭代上限（缺省 2000） */
  maxIterations?: number;
  /** 目标收敛容差：单步下降 ≤ tol·max(1,|F|) 即收敛（缺省 1e-13） */
  tol?: number;
  /** 线搜索黄金分割迭代数（缺省 80 → 区间收缩 ~1e-16） */
  lineSearchIterations?: number;
  /** R5：线搜索机器精度早停（缺省 true；false = 旧的全额 80 轮口径） */
  lineSearchEarlyExit?: boolean;
}

/** BROJA 凸规划求解轨迹（验证锚点：目标单调性 / 边缘可行性） */
export interface PidSolverTrace {
  iterations: number;
  converged: boolean;
  stopReason: 'stationary' | 'no-descent' | 'max-iterations';
  /** 初始独立耦合处的目标值（m 的上界之一） */
  objectiveStart: number;
  /** 收敛处的目标值 = m = min_q I_q(X₁,X₂;S) */
  objectiveEnd: number;
  /** 被接受的目标序列（含初值——单调不增，验证锚点） */
  objectiveTrace: number[];
  /** 返回 q 的最大边缘约束违反（行/列与 p(xᵢ|s) 之差） */
  maxMarginalViolation: number;
  /**
   * R5 一阶 KKT 残差：max|G − r − c + grand|，G = log₂(q/m)。
   * ≈ 0 且迭代点在支撑内部 ⟹ 凸问题全局最优证书；大值 ⟹ 最优点
   * 在支撑边界（约束起作用）——最优性状态的诚实读数，非误差掩盖。
   */
  maxKktResidual: number;
  /** R5：线搜索目标求值次数（早停节省量的审计口径） */
  lineSearchEvaluations: number;
}

/** 部分信息分解报告（信息量单位一律 bit / log₂） */
export interface PidReport {
  /** I(X₁,X₂;S) —— 被分解的总量 */
  total: number;
  /** I(X₁;S) */
  iSource1: number;
  /** I(X₂;S) */
  iSource2: number;
  /** 冗余 R：两路都携带 */
  redundant: number;
  /** 独占 U₁：只在 X₁ 一路 */
  unique1: number;
  /** 独占 U₂：只在 X₂ 一路 */
  unique2: number;
  /** 协同 C：只在联合中存在（1+1>2 的部分） */
  synergistic: number;
  /** m = min_q I_q(X₁,X₂;S)（BROJA 凸规划最优值——四个原子全部由它导出） */
  minimizedJointInfo: number;
  /** R+U₁+U₂+C − I（构造上恒 ≈ 0，只剩浮点尘埃） */
  conservationResidual: number;
  solverTrace: PidSolverTrace;
  interpretation: string;
}

/** O 信息报告（n 源 + 目标 S） */
export interface OInfoReport {
  /** 源变量个数 n */
  sources: number;
  /** Ω = Σ I(Xᵢ;S) − I(X₁,…,X_n;S)（bit；> 0 冗余主导、< 0 协同主导） */
  oInformation: number;
  /** I(X₁,…,X_n;S) */
  totalInformation: number;
  /** 各源的 I(Xᵢ;S) */
  sourceInformations: number[];
  dominance: 'redundancy' | 'synergy' | 'balanced';
  interpretation: string;
}

/** 二值逻辑门算例（文献已知 BROJA 分解——验证对照锚） */
export interface BivariateGateSpec {
  id: GateId;
  description: string;
  /** p(x₁,x₂,s)：joint[x₁][x₂][s]（已归一；每次调用新建，调用方可自由改动） */
  joint: number[][][];
  /** BROJA 文献已知分解（bit） */
  expected: { total: number; redundant: number; unique1: number; unique2: number; synergistic: number };
  citation: string;
}

export type GateId = 'xor' | 'and' | 'copy' | 'sourceX';

/** 任意深度嵌套分布表（前 n 个轴是源、最后一个轴是目标 S） */
export type NestedProbTable = ReadonlyArray<number> | ReadonlyArray<NestedProbTable>;

// ─────────────────────────── 熵 / 互信息工具 ───────────────────────────

/**
 * Shannon 熵 H(p)（bit）。约定 0·log0 = 0；输入自动归一化。
 * 显式 throw：空数组 / 非有限数 / 负概率 / 零和。
 */
export function entropy(p: ReadonlyArray<number>): number {
  const raw: unknown = p;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('entropy: 空分布');
  let total = 0;
  for (const v of p) {
    if (!Number.isFinite(v) || v < 0) throw new Error('entropy: 概率必须为非负有限数');
    total += v;
  }
  if (!(total > 0)) throw new Error('entropy: 分布总和必须为正');
  let h = 0;
  for (const v of p) {
    const q = v / total;
    if (q > 0) h += q * Math.log2(q);
  }
  return -h;
}

/**
 * 互信息 I(X;Y)（bit），输入联合分布表 pXY（行 x 列 y，自动归一化）。
 * 显式 throw：空表 / 参差行 / 非有限数 / 负概率 / 零和。
 */
export function mutualInformation(pXY: ReadonlyArray<ReadonlyArray<number>>): number {
  const rawJoint: unknown = pXY;
  if (!Array.isArray(rawJoint) || rawJoint.length === 0) throw new Error('mutualInformation: 空分布');
  const firstRow = pXY[0];
  if (!Array.isArray(firstRow) || firstRow.length === 0) throw new Error('mutualInformation: 空分布');
  const ny = firstRow.length;
  let total = 0;
  for (const row of pXY) {
    if (!Array.isArray(row) || row.length !== ny) throw new Error('mutualInformation: 分布表必须为矩形');
    for (const v of row) {
      if (!Number.isFinite(v) || v < 0) throw new Error('mutualInformation: 概率必须为非负有限数');
      total += v;
    }
  }
  if (!(total > 0)) throw new Error('mutualInformation: 分布总和必须为正');
  const nx = pXY.length;
  const px = pXY.map((row) => row.reduce((s, v) => s + v, 0) / total);
  const py = Array.from({ length: ny }, (_, j) => pXY.reduce((s, row) => s + row[j], 0) / total);
  let ixy = 0;
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) {
      const pij = pXY[i][j] / total;
      if (pij > 0) ixy += pij * Math.log2(pij / (px[i] * py[j]));
    }
  }
  return ixy;
}

// ─────────────────────────── BROJA 求解器 ───────────────────────────

/** q 的混合边缘 m(a,b) = Σ_s p(s)·q_s(a,b) */
function mixtureOf(q: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>, active: ReadonlyArray<number>, ps: ReadonlyArray<number>): number[][] {
  const nA = q[0].length;
  const nB = q[0][0].length;
  const m = Array.from({ length: nA }, () => new Array<number>(nB).fill(0));
  for (const s of active) {
    for (let a = 0; a < nA; a += 1) {
      for (let b = 0; b < nB; b += 1) m[a][b] += ps[s] * q[s][a][b];
    }
  }
  return m;
}

/** BROJA 目标 F(q) = I_q(X₁,X₂;S) = Σ_s p(s)·KL(q_s ‖ m)（bit） */
function brojaObjective(q: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>, active: ReadonlyArray<number>, ps: ReadonlyArray<number>): number {
  const nA = q[0].length;
  const nB = q[0][0].length;
  const m = mixtureOf(q, active, ps);
  let f = 0;
  for (const s of active) {
    for (let a = 0; a < nA; a += 1) {
      for (let b = 0; b < nB; b += 1) {
        const v = q[s][a][b];
        if (v > 0) f += ps[s] * v * Math.log2(v / m[a][b]);
      }
    }
  }
  return f;
}

/** 返回 q 的第 s 列相对行/列目标的最大违反 */
function marginalViolationOf(
  q: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>,
  s: number,
  rows: ReadonlyArray<ReadonlyArray<number>>,
  cols: ReadonlyArray<ReadonlyArray<number>>,
): number {
  const nA = rows[s].length;
  const nB = cols[s].length;
  let v = 0;
  for (let a = 0; a < nA; a += 1) {
    let sum = 0;
    for (let b = 0; b < nB; b += 1) sum += q[s][a][b];
    v = Math.max(v, Math.abs(sum - rows[s][a]));
  }
  for (let b = 0; b < nB; b += 1) {
    let sum = 0;
    for (let a = 0; a < nA; a += 1) sum += q[s][a][b];
    v = Math.max(v, Math.abs(sum - cols[s][b]));
  }
  return v;
}

interface BrojaOptions {
  maxIterations: number;
  tol: number;
  lineSearchIterations: number;
  lineSearchEarlyExit: boolean;
}

/**
 * 解 BROJA 凸规划 m = min_q I_q(X₁,X₂;S)（边缘约束 q(xᵢ|s) = p(xᵢ|s)）。
 *
 * 内点可行方向法：每轮取负梯度在「行和 = 列和 = 0」切空间（双向
 * ANOVA 交互子空间，对可行支撑闭式正交投影）上的方向 D——沿 q+tD
 * 步进，行/列边缘精确保持（D 的行/列和恒为 0，可行性无需投影修复）；
 * φ(t) = F(q+tD) 是凸一维函数，黄金分割精确线搜索取最优步长。
 * ⟨G, D⟩ = −‖P(G)‖² < 0 保证 D 是下降方向 ⇒ 接受的目标序列单调不增
 * （验证锚点）。初始点 = 独立耦合 p(x₁|s)p(x₂|s)：天然可行、支撑内部
 * 严格为正（内点），且恰是 XOR/独占等门的最优点（零迭代收敛）。
 */
function solveBrojaMinJoint(
  ps: ReadonlyArray<number>,
  rows: ReadonlyArray<ReadonlyArray<number>>,
  cols: ReadonlyArray<ReadonlyArray<number>>,
  options: BrojaOptions,
): PidSolverTrace {
  const ns = ps.length;
  const active: number[] = [];
  for (let s = 0; s < ns; s += 1) if (ps[s] > 0) active.push(s);

  // 各 s 的可行支撑（边缘目标为正的行/列）；支撑外条目恒为 0
  const rowIdx: number[][] = [];
  const colIdx: number[][] = [];
  for (let s = 0; s < ns; s += 1) {
    rowIdx.push(rows[s].map((v, a) => (v > 0 ? a : -1)).filter((a) => a >= 0));
    colIdx.push(cols[s].map((v, b) => (v > 0 ? b : -1)).filter((b) => b >= 0));
  }

  // 内点初始化：独立耦合（行/列边缘自动匹配）
  let q: number[][][] = [];
  for (let s = 0; s < ns; s += 1) {
    q.push(rows[s].map((r) => cols[s].map((c) => r * c)));
  }

  const objective = (tables: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>): number => brojaObjective(tables, active, ps);
  let fCur = objective(q);
  const objectiveTrace: number[] = [fCur];
  let iterations = 0;
  let lineSearchEvaluations = 0;
  let stopReason: PidSolverTrace['stopReason'] = 'max-iterations';
  let converged = false;
  const golden = (Math.sqrt(5) - 1) / 2;

  while (iterations < options.maxIterations) {
    iterations += 1;
    // 梯度 ∂F/∂q_s(a,b) = p(s)·log₂(q_s(a,b)/m(a,b))；
    // 负梯度的切空间正交投影（ANOVA 交互子空间）→ 可行下降方向 D
    const m = mixtureOf(q, active, ps);
    const D: number[][][] = Array.from({ length: ns }, (_, s) => rows[s].map(() => cols[s].map(() => 0)));
    let dInf = 0;
    for (const s of active) {
      const ri = rowIdx[s];
      const ci = colIdx[s];
      if (ri.length < 2 || ci.length < 2) continue; // 切空间平凡（可行点唯一）
      const rowMean = new Array<number>(rows[s].length).fill(0);
      const colMean = new Array<number>(cols[s].length).fill(0);
      let grand = 0;
      for (const a of ri) {
        for (const b of ci) {
          const h = -ps[s] * Math.log2(q[s][a][b] / m[a][b]);
          rowMean[a] += h;
          colMean[b] += h;
          grand += h;
        }
      }
      for (const a of ri) rowMean[a] /= ci.length;
      for (const b of ci) colMean[b] /= ri.length;
      grand /= ri.length * ci.length;
      for (const a of ri) {
        for (const b of ci) {
          const h = -ps[s] * Math.log2(q[s][a][b] / m[a][b]);
          const d = h - rowMean[a] - colMean[b] + grand;
          D[s][a][b] = d;
          if (Math.abs(d) > dInf) dInf = Math.abs(d);
        }
      }
    }
    if (dInf <= 1e-13) {
      stopReason = 'stationary';
      converged = true;
      break;
    }
    // 步长上界：不越出可行支撑（留 1e-9 相对余量保持内点）
    let tHard = Infinity;
    for (const s of active) {
      for (const a of rowIdx[s]) {
        for (const b of colIdx[s]) {
          const d = D[s][a][b];
          if (d < 0) tHard = Math.min(tHard, -q[s][a][b] / d);
        }
      }
    }
    if (!(tHard > 0)) {
      stopReason = 'no-descent';
      converged = true;
      break;
    }
    const tCap = tHard * (1 - 1e-9);
    // 黄金分割精确线搜索（φ 凸 ⇒ 区间收缩到最优点）；
    // R5 早停：相对宽度达机器精度即停（尾段收缩超出 double 分辨率）
    const phi = (t: number): number => {
      lineSearchEvaluations += 1;
      return objective(q.map((slice, s) => slice.map((row, a) => row.map((v, b) => v + t * D[s][a][b]))));
    };
    let lo = 0;
    let hi = tCap;
    let x1 = hi - golden * (hi - lo);
    let x2 = lo + golden * (hi - lo);
    let f1 = phi(x1);
    let f2 = phi(x2);
    for (let k = 0; k < options.lineSearchIterations; k += 1) {
      if (options.lineSearchEarlyExit && hi - lo <= 1e-15 * Math.max(1, hi)) break;
      if (f1 < f2) {
        hi = x2;
        x2 = x1;
        f2 = f1;
        x1 = hi - golden * (hi - lo);
        f1 = phi(x1);
      } else {
        lo = x1;
        x1 = x2;
        f1 = f2;
        x2 = lo + golden * (hi - lo);
        f2 = phi(x2);
      }
    }
    const tStar = (lo + hi) / 2;
    const fNew = phi(tStar);
    if (fNew < fCur - 1e-15) {
      const decrease = fCur - fNew;
      q = q.map((slice, s) => slice.map((row, a) => row.map((v, b) => v + tStar * D[s][a][b])));
      fCur = fNew;
      objectiveTrace.push(fNew);
      if (decrease <= options.tol * Math.max(1, Math.abs(fCur))) {
        stopReason = 'stationary';
        converged = true;
        break;
      }
    } else {
      stopReason = 'no-descent';
      converged = true;
      break;
    }
  }

  // 如实度量返回 q 的边缘违反（方向步进保持可行性——应只剩浮点尘埃）
  let maxViolation = 0;
  for (const s of active) {
    maxViolation = Math.max(maxViolation, marginalViolationOf(q, s, rows, cols));
  }
  // R5 一阶 KKT 残差：G = log₂(q/m) 在每片 s 内的「行+列可加」失配。
  // 内点 + 残差≈0 ⟹ 平稳 ⟹ 凸问题全局最优证书；残差大 ⟹ 边界最优。
  const mFinal = mixtureOf(q, active, ps);
  let maxKkt = 0;
  for (const s of active) {
    const ri = rowIdx[s];
    const ci = colIdx[s];
    if (ri.length < 2 || ci.length < 2) continue;
    const rowMean = new Array<number>(rows[s].length).fill(0);
    const colMean = new Array<number>(cols[s].length).fill(0);
    let grand = 0;
    for (const a of ri) {
      for (const b of ci) {
        const g = Math.log2(q[s][a][b] / mFinal[a][b]);
        rowMean[a] += g;
        colMean[b] += g;
        grand += g;
      }
    }
    for (const a of ri) rowMean[a] /= ci.length;
    for (const b of ci) colMean[b] /= ri.length;
    grand /= ri.length * ci.length;
    for (const a of ri) {
      for (const b of ci) {
        const dev = Math.log2(q[s][a][b] / mFinal[a][b]) - rowMean[a]! - colMean[b]! + grand;
        if (Math.abs(dev) > maxKkt) maxKkt = Math.abs(dev);
      }
    }
  }
  const objectiveEnd = objective(q);
  return {
    iterations,
    converged,
    stopReason,
    objectiveStart: objectiveTrace[0],
    objectiveEnd,
    objectiveTrace,
    maxMarginalViolation: maxViolation,
    maxKktResidual: maxKkt,
    lineSearchEvaluations,
  };
}

// ─────────────────────────── 主入口 ───────────────────────────

/**
 * 部分信息分解（BROJA 口径）：p(x₁,x₂,s) → {R, U₁, U₂, C}。
 *
 * 输入 joint[x₁][x₂][s]（自动归一化）。一次凸规划（min_q I_q(X₁,X₂;S)，
 * 边缘约束 p(xᵢ|s)）导出全部原子；守恒与局部一致性由构造精确成立。
 * 显式 throw：空/参差/负概率/零和分布、非法选项值。
 */
export function pidFromJoint(joint: ReadonlyArray<ReadonlyArray<ReadonlyArray<number>>>, options?: PidOptions): PidReport {
  const maxIterations = options?.maxIterations ?? 2000;
  const tol = options?.tol ?? 1e-13;
  const lineSearchIterations = options?.lineSearchIterations ?? 80;
  const lineSearchEarlyExit = options?.lineSearchEarlyExit ?? true;
  const positive = (name: string, v: number): void => {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`pidFromJoint: ${name} 必须为正有限数`);
  };
  positive('maxIterations', maxIterations);
  positive('tol', tol);
  positive('lineSearchIterations', lineSearchIterations);

  const rawJoint: unknown = joint;
  if (!Array.isArray(rawJoint) || rawJoint.length === 0) throw new Error('pidFromJoint: 空分布');
  const n1 = joint.length;
  const firstPlane = joint[0];
  if (!Array.isArray(firstPlane) || firstPlane.length === 0) throw new Error('pidFromJoint: 空分布');
  const n2 = firstPlane.length;
  const firstCell = firstPlane[0];
  if (!Array.isArray(firstCell) || firstCell.length === 0) throw new Error('pidFromJoint: 空分布');
  const ns = firstCell.length;

  let total = 0;
  for (let a = 0; a < n1; a += 1) {
    const plane = joint[a];
    if (!Array.isArray(plane) || plane.length !== n2) throw new Error('pidFromJoint: 分布表必须为矩形');
    for (let b = 0; b < n2; b += 1) {
      const cell = plane[b];
      if (!Array.isArray(cell) || cell.length !== ns) throw new Error('pidFromJoint: 分布表必须为矩形');
      for (let s = 0; s < ns; s += 1) {
        const v = cell[s];
        if (!Number.isFinite(v) || v < 0) throw new Error('pidFromJoint: 概率必须为非负有限数');
        total += v;
      }
    }
  }
  if (!(total > 0)) throw new Error('pidFromJoint: 分布总和必须为正');
  const p: number[][][] = [];
  for (let a = 0; a < n1; a += 1) {
    const plane: number[][] = [];
    for (let b = 0; b < n2; b += 1) {
      plane.push(joint[a][b].map((v) => v / total));
    }
    p.push(plane);
  }

  // 边缘与互信息
  const ps = new Array<number>(ns).fill(0);
  const p1s: number[][] = Array.from({ length: n1 }, () => new Array<number>(ns).fill(0));
  const p2s: number[][] = Array.from({ length: n2 }, () => new Array<number>(ns).fill(0));
  const collapsed: number[][] = Array.from({ length: n1 * n2 }, () => new Array<number>(ns).fill(0));
  for (let a = 0; a < n1; a += 1) {
    for (let b = 0; b < n2; b += 1) {
      for (let s = 0; s < ns; s += 1) {
        const v = p[a][b][s];
        ps[s] += v;
        p1s[a][s] += v;
        p2s[b][s] += v;
        collapsed[a * n2 + b][s] += v;
      }
    }
  }
  const i1 = mutualInformation(p1s);
  const i2 = mutualInformation(p2s);
  const itotal = mutualInformation(collapsed);

  // 各 s 的行/列边缘目标 p(xᵢ|s)（p(s)=0 的列无关紧要，填均匀）
  const rows: number[][] = [];
  const cols: number[][] = [];
  for (let s = 0; s < ns; s += 1) {
    if (ps[s] > 0) {
      rows.push(p1s.map((col) => col[s] / ps[s]));
      cols.push(p2s.map((col) => col[s] / ps[s]));
    } else {
      rows.push(new Array<number>(n1).fill(1 / n1));
      cols.push(new Array<number>(n2).fill(1 / n2));
    }
  }

  const trace = solveBrojaMinJoint(ps, rows, cols, { maxIterations, tol, lineSearchIterations, lineSearchEarlyExit });
  const m = trace.objectiveEnd;
  const redundant = i1 + i2 - m;
  const unique1 = m - i2;
  const unique2 = m - i1;
  const synergistic = itotal - m;
  const conservationResidual = redundant + unique1 + unique2 + synergistic - itotal;
  return {
    total: itotal,
    iSource1: i1,
    iSource2: i2,
    redundant,
    unique1,
    unique2,
    synergistic,
    minimizedJointInfo: m,
    conservationResidual,
    solverTrace: trace,
    interpretation: interpretPid(redundant, unique1, unique2, synergistic, itotal),
  };
}

function interpretPid(redundant: number, unique1: number, unique2: number, synergistic: number, total: number): string {
  if (total <= 1e-12) return 'I(X₁,X₂;S)=0：目标与两源独立，无信息可分解';
  const parts = [
    { label: '冗余 R', value: redundant, note: '两路携带相同信息（可相互替代——降频/择一候选）' },
    { label: '独占 U₁', value: unique1, note: '信息集中在 X₁ 一路（X₂ 对目标近乎无贡献）' },
    { label: '独占 U₂', value: unique2, note: '信息集中在 X₂ 一路（X₁ 对目标近乎无贡献）' },
    { label: '协同 C', value: synergistic, note: '单独都没用、合起来才有——1+1>2，组合值得保留联测' },
  ];
  parts.sort((x, y) => y.value - x.value);
  const top = parts[0];
  if (top === undefined) return '';
  return `I=${total.toFixed(4)} bit，${top.label}=${top.value.toFixed(4)} 主导：${top.note}`;
}

// ─────────────────────────── O 信息 ───────────────────────────

/** 递归解析任意深度嵌套表：校验矩形/非负/有限，输出维度与展平值 */
function probeNested(x: NestedProbTable, dims: number[], out: number[]): void {
  const raw: unknown = x;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('oInformation: 空分布');
  const first = x[0];
  if (typeof first === 'number') {
    const row = x as ReadonlyArray<number>;
    dims.push(row.length);
    for (const v of row) {
      if (!Number.isFinite(v) || v < 0) throw new Error('oInformation: 概率必须为非负有限数');
      out.push(v);
    }
    return;
  }
  const children = x as ReadonlyArray<NestedProbTable>;
  dims.push(children.length);
  // 先探第一个子树取其维度（并入父维度），再逐一校验其余子树矩形一致
  const firstChild = children[0];
  if (!Array.isArray(firstChild)) throw new Error('oInformation: 分布表必须为矩形嵌套数值表');
  const firstDims: number[] = [];
  probeNested(firstChild, firstDims, out);
  dims.push(...firstDims);
  for (let i = 1; i < children.length; i += 1) {
    const child = children[i];
    if (!Array.isArray(child)) throw new Error('oInformation: 分布表必须为矩形嵌套数值表');
    const childDims: number[] = [];
    probeNested(child, childDims, out);
    if (childDims.length !== firstDims.length || childDims.some((d, k) => d !== firstDims[k])) {
      throw new Error('oInformation: 分布表必须为矩形（各维度长度一致）');
    }
  }
}

/**
 * O 信息（Rosas et al. 2019 符号约定，n 源推广）：
 *   Ω = Σᵢ I(Xᵢ;S) − I(X₁,…,X_n;S)
 * Ω > 0 冗余主导（整体小于部分之和）；Ω < 0 协同主导（1+1>2）。
 * 输入为前 n 个源轴 + 最后一个目标轴的嵌套表（n ≥ 2，自动归一化）。
 */
export function oInformation(joint: NestedProbTable): OInfoReport {
  const dims: number[] = [];
  const values: number[] = [];
  probeNested(joint, dims, values);
  if (dims.length < 3) throw new Error('oInformation: 至少需要两个源变量 + 一个目标变量（嵌套深度 ≥ 3）');
  let total = 0;
  for (const v of values) total += v;
  if (!(total > 0)) throw new Error('oInformation: 分布总和必须为正');
  const axes = dims.length;
  const ns = dims[axes - 1];
  const nSources = axes - 1;
  const cells = values.length;
  const p = values.map((v) => v / total);

  const ps = new Array<number>(ns).fill(0);
  const perSource: number[][][] = Array.from({ length: nSources }, (_, i) =>
    Array.from({ length: dims[i] }, () => new Array<number>(ns).fill(0)),
  );
  const nTuple = Math.round(cells / ns);
  const collapsed: number[][] = Array.from({ length: nTuple }, () => new Array<number>(ns).fill(0));
  for (let idx = 0; idx < cells; idx += 1) {
    const v = p[idx];
    const s = idx % ns;
    ps[s] += v;
    let tuple = Math.floor(idx / ns);
    collapsed[tuple][s] += v;
    for (let i = nSources - 1; i >= 0; i -= 1) {
      const di = dims[i];
      const xi = tuple % di;
      perSource[i][xi][s] += v;
      tuple = Math.floor(tuple / di);
    }
  }
  const sourceInformations = perSource.map((t) => mutualInformation(t));
  const totalInformation = mutualInformation(collapsed);
  const omega = sourceInformations.reduce((acc, v) => acc + v, 0) - totalInformation;
  const dominance: OInfoReport['dominance'] = omega > 1e-9 ? 'redundancy' : omega < -1e-9 ? 'synergy' : 'balanced';
  const interpretation =
    omega > 1e-9
      ? `Ω=+${omega.toFixed(4)} bit > 0：冗余主导——整体小于部分之和，证据可相互替代`
      : omega < -1e-9
        ? `Ω=${omega.toFixed(4)} bit < 0：协同主导——1+1>2，必须联合使用才有价值`
        : 'Ω≈0：部分精确相加（无高阶交互）';
  return {
    sources: nSources,
    oInformation: omega,
    totalInformation,
    sourceInformations,
    dominance,
    interpretation,
  };
}

// ─────────────────────────── 二值逻辑门工厂 ───────────────────────────

/**
 * 二值逻辑门算例工厂（X₁,X₂ ∈ {0,1}，联合表 p(x₁,x₂,s) 已归一）。
 * expected 为 BROJA 文献已知分解——verify 脚本的对照锚；每次调用新建
 * 联合表，调用方改动不会串扰。
 */
export function bivariateGates(): Record<GateId, BivariateGateSpec> {
  return {
    xor: {
      id: 'xor',
      description: '异或门：X₁,X₂ 独立均匀，S = X₁⊕X₂——单路零信息、联合全知（协同纯血统）',
      joint: [
        [
          [0.25, 0],
          [0, 0.25],
        ],
        [
          [0, 0.25],
          [0.25, 0],
        ],
      ],
      expected: { total: 1, redundant: 0, unique1: 0, unique2: 0, synergistic: 1 },
      citation: 'BROJA 解析精确（Bertschinger–Rauh–Olbrich–Jost–Ay 2014, Entropy；框架 Williams & Beer 2010）',
    },
    and: {
      id: 'and',
      description: '与门：X₁,X₂ 独立均匀，S = X₁∧X₂——I=H₂(1/4)≈0.8113，少量冗余 + 半比特协同',
      joint: [
        [
          [0.25, 0],
          [0.25, 0],
        ],
        [
          [0.25, 0],
          [0, 0.25],
        ],
      ],
      expected: { total: 0.8112781244591328, redundant: 0.3112781244591328, unique1: 0, unique2: 0, synergistic: 0.5 },
      citation: 'BROJA 文献已知值：R≈0.3113、C=0.5（Bertschinger et al. 2014 二值 AND 门）',
    },
    copy: {
      id: 'copy',
      description: '拷贝门：X₁=X₂ 均匀二值，S 同时拷贝两路——两路信息完全相同（冗余纯血统）',
      joint: [
        [
          [0.5, 0],
          [0, 0],
        ],
        [
          [0, 0],
          [0, 0.5],
        ],
      ],
      expected: { total: 1, redundant: 1, unique1: 0, unique2: 0, synergistic: 0 },
      citation: '解析精确：边缘约束把可行集钉死为单点 q = p',
    },
    sourceX: {
      id: 'sourceX',
      description: '独占门：S = X₁，X₂ 独立噪声——全部信息只在 X₁ 一路（独占纯血统）',
      joint: [
        [
          [0.25, 0],
          [0.25, 0],
        ],
        [
          [0, 0.25],
          [0, 0.25],
        ],
      ],
      expected: { total: 1, redundant: 0, unique1: 1, unique2: 0, synergistic: 0 },
      citation: '解析精确：I(X₁;S)=1、I(X₂;S)=0、可行集单点',
    },
  };
}

/* ── 接线建议 ──
 *
 * 1. 反思器·多模型组合诊断（建议挂载点）：
 *    - 每次多模型联测产出 (模型A观点, 模型B观点, 最终决策成败) 三元组，
 *      滚动计数累积经验分布 → p(x₁,x₂,s) → pidFromJoint；
 *    - 协同 C 显著 > 0 的组合 = 单独平庸、联合有效的「暗协同」——反思器
 *      应保留并优先编排（16.0 Shapley 只会平分功劳，看不见这类组合）；
 *      冗余 R 主导的组合说明两路证据可相互替代，可择一降频省预算；
 *      独占 U 主导时把预算倾斜给携带信息的那一路。
 *
 * 2. 共生协同侦测：证据源/模型两两滑窗做 PID，C 的时间序列作为
 *    「共生强度」KPI 喂给编排亲和（正协同对亲和、纯冗余对互斥）；
 *    O 信息 Ω 作为组合健康度的单一只读仪表（冗余/协同主导的一眼判读）。
 *
 * 3. 缺省关闭旗标：pidDiagnosticsEnabled（缺省 false——不采集、不分解、
 *    不触碰任何现有决策路径，兑现零介入承诺）。
 *
 * 4. 挂载后改变的决策点：模型保留/降频名单（从加法命中率改为 PID 四
 *    分解口径）、编排亲和权重（协同对加权）、反思器报告新增
 *    「冗余/独占/协同」三栏与 Ω 仪表。决策权仍在反思器——本内核只读
 *    提供定价，不发起任何动作。
 * ────────────────────────────────────────────────────────────── */
