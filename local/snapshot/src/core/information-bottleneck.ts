/**
 * 37.0 信息瓶颈内核 —— Blahut-Arimoto：理解即压缩的算法化
 *
 * 动机: 知识蒸馏的门槛是水位魔数（样本计数 ≥ N 才蒸馏）。但「值得
 * 蒸馏」的本质是信息论问题——Tishby 信息瓶颈（1999）把「压缩 X 的
 * 表征 T 同时保留与目标 Y 相关的信息」写成变分问题：
 *
 *   min_{q(t|x)}  I(X;T) − β·I(T;Y)
 *
 *   I(T;Y) ≤ I(X;Y)（数据处理不等式——任何压缩都不可能增加信息）；
 *   β → 0: T 塌缩为常数（什么都不值得记）；β → ∞: T = X（全保留）。
 *   最优解由自洽方程刻画（Blahut-Arimoto 迭代收敛）：
 *
 *     q(y|t) ∝ Σ_x p(x) q(t|x) p(y|x)
 *     q(t|x) ∝ q(t)·exp(−β·D_KL[p(y|x) ‖ q(y|t)])
 *
 *   蒸馏语义: X = 候选记忆的特征位型，Y = 任务成败结果。IB 最优压缩
 *   保留的是「对预测成败有信息量的结构」——**保留率 retention =
 *   I(T;Y)/I(X;Y) 是「这批样本携带多少值得蒸馏的信息」的定价**：
 *   retention 低于阈值 → 样本与既有知识同构，水位再高也不该重复蒸馏；
 *   retention 高 → 少量样本也值得立即固化。
 *
 *   MDL（11.0 理论家）说「理解即压缩」；IB 给出**压缩-相关**帕累托
 *   前沿上的可计算最优点——蒸馏从经验水位升维为信息论定价。
 *
 * R5 进化（第五轮·信息几何世界性进化）：
 * 1. **IB 曲线扫描 + 凹性检验**（ibCurve）：β 扫描给出 (I(X;T), I(T;Y))
 *   前沿轨迹；可达域 {(iXT, iTY)} 凸（时间共享混合），其上边界在
 *   (iXT, iTY) 平面**凹**——斜率 1/β 随 iXT 非增；同时验证 β↑ 时
 *   I(X;T)、I(T;Y) 单调不降与全点数据处理不等式 I(T;Y) ≤ I(X;Y)。
 * 2. **确定性 IB（deterministic IB，Strouse–Schwab 2017）**
 *   （deterministicIB）：q(t|x) 限制为硬指派（X 行的划分），
 *   F = I(X;T) − β·I(T;Y) = H(T) − β·I(T;Y)（确定性映射下
 *   I(X;T) = H(T)）。求解：贪心凝聚——每步合并使 F 下降最多的簇对
 *   （ΔF = ΔH(T) − β·ΔI(T;Y) 有闭式二元增量），平局按 (i,j) 字典序，
 *   无改进即停。软 IB 是 dIB 的松弛 ⟹ F_dIB ≥ F_soft（验证锚）；
 *   惰性增量缓存（只重算被合并簇相关的对）把每步从 O(k²) 重算
 *   降为按需补算——性能进化，等价于全量重算（相同贪心轨迹）。
 *
 * 零漂移: 未挂载时蒸馏门槛与升级前逐位一致。
 */

/** 经验联合分布（X 离散特征 × Y 离散结果） */
export interface JointDistribution {
  /** p(x,y)（行 x 列 y；自动归一化） */
  pxy: number[][];
  /** 行标签（特征位型，聚类输出用；可选） */
  xLabels?: string[];
  /** 列标签（结果档位，如 ['fail', 'pass']；可选） */
  yLabels?: string[];
}

export interface BottleneckReport {
  /** 压缩道数 |T|（实际存活的道） */
  clusters: number;
  /** I(X;Y)（nat）——源数据关于结果的信息上限 */
  iXY: number;
  /** I(T;Y)（nat）——压缩表征保留的信息 */
  iTY: number;
  /** 保留率 I(T;Y)/I(X;Y) ∈ [0,1]（数据处理不等式保证 ≤ 1） */
  retention: number;
  /** I(X;T)（nat）——压缩的复杂度代价 */
  iXT: number;
  /** 拉格朗日量 L = I(X;T) − β·I(T;Y)（迭代单调不增——验证锚点） */
  lagrangian: number;
  /** 每个特征位型 → 压缩道（argmax_t q(t|x)） */
  assignment: number[];
  /** 每道的后验 q(y|t) */
  clusterPosteriors: number[][];
  iterations: number;
  converged: boolean;
}

function klDivergence(p: ReadonlyArray<number>, q: ReadonlyArray<number>): number {
  let acc = 0;
  for (let i = 0; i < p.length; i += 1) {
    const pi = p[i];
    if (pi <= 0) continue;
    const qi = q[i] > 0 ? q[i] : 1e-300;
    acc += pi * Math.log(pi / qi);
  }
  return acc;
}

function mutualInfo(joint: ReadonlyArray<ReadonlyArray<number>>): { ixy: number; px: number[]; py: number[]; pyx: number[][] } {
  let total = 0;
  for (const row of joint) for (const v of row) total += v;
  if (!(total > 0)) return { ixy: 0, px: [], py: [], pyx: [] };
  const nx = joint.length;
  const ny = joint[0].length;
  const px = joint.map((row) => row.reduce((s, v) => s + v, 0) / total);
  const py = Array.from({ length: ny }, (_, j) => joint.reduce((s, row) => s + (row[j] ?? 0), 0) / total);
  let ixy = 0;
  const pyx: number[][] = [];
  for (let i = 0; i < nx; i += 1) {
    const cond: number[] = [];
    for (let j = 0; j < ny; j += 1) {
      const pij = (joint[i][j] ?? 0) / total;
      cond.push(px[i] > 0 ? pij / px[i] : 1 / ny);
      if (pij > 0) ixy += pij * Math.log(pij / (px[i] * py[j]));
    }
    pyx.push(cond);
  }
  return { ixy, px, py, pyx };
}

export interface BottleneckOptions {
  /** 压缩-相关权衡 β（缺省 5；小 = 激进压缩，大 = 忠实保留） */
  beta?: number;
  /** 压缩道数上限 |T|（缺省 = min(|X|, 6)） */
  clusterCap?: number;
  maxIterations?: number;
  tol?: number;
  seed?: number;
}

/**
 * 信息瓶颈（Blahut–Arimoto / Tishby 1999）。
 *
 * 迭代自洽方程至收敛；拉格朗日量单调不增（验证锚点）。|X|=1 或
 * I(X;Y)=0 时诚实返回 retention=0（无信息可保留——不值得蒸馏）。
 */
export function informationBottleneck(joint: ReadonlyArray<ReadonlyArray<number>>, options?: BottleneckOptions): BottleneckReport {
  const beta = options?.beta ?? 5;
  const maxIterations = options?.maxIterations ?? 200;
  const tol = options?.tol ?? 1e-9;
  const { ixy, px, py, pyx } = mutualInfo(joint);
  const nx = joint.length;
  const ny = nx > 0 ? joint[0].length : 0;
  if (nx === 0 || ny === 0) throw new Error('informationBottleneck: 空分布');
  if (ixy <= 1e-12 || nx === 1) {
    // 无信息可压缩：T = 常数是 IB 最优（β 有限时）
    return {
      clusters: 1,
      iXY: ixy,
      iTY: 0,
      retention: 0,
      iXT: 0,
      lagrangian: 0,
      assignment: Array.from({ length: nx }, () => 0),
      clusterPosteriors: [py.slice()],
      iterations: 0,
      converged: true,
    };
  }
  const k = Math.max(1, Math.min(options?.clusterCap ?? Math.min(nx, 6), nx));
  // mulberry32 确定性初始化（小幅扰动打破对称，保证可复现）；
  // BA 坐标下降在非凸目标上有硬指派冻结的局部最优——三次确定性
  // 重启取拉格朗日量最优（重启种子固定，结果可复现）
  const mkRng = (seed: number) => {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const runOnce = (seed: number) => {
    const rnd = mkRng(seed);
    let qtx: number[][] = Array.from({ length: nx }, () => Array.from({ length: k }, () => 0.8 / k + 0.2 * rnd()));
    const currentLagrangian = (): { ixt: number; ity: number; lag: number; qt: number[]; qyt: number[][] } => {
      const qt = Array.from({ length: k }, () => 0);
      for (let i = 0; i < nx; i += 1) {
        let rowSum = 0;
        for (let t = 0; t < k; t += 1) rowSum += qtx[i][t];
        for (let t = 0; t < k; t += 1) qt[t] += (px[i] * qtx[i][t]) / (rowSum || 1);
      }
      const qyt: number[][] = Array.from({ length: k }, () => Array.from({ length: ny }, () => 0));
      for (let i = 0; i < nx; i += 1) {
        let rowSum = 0;
        for (let t = 0; t < k; t += 1) rowSum += qtx[i][t];
        for (let t = 0; t < k; t += 1) {
          const w = (px[i] * qtx[i][t]) / (rowSum || 1);
          for (let j = 0; j < ny; j += 1) qyt[t][j] += w * pyx[i][j];
        }
      }
      for (let t = 0; t < k; t += 1) {
        const rowSum = qyt[t].reduce((a, b) => a + b, 0);
        if (rowSum > 0) for (let j = 0; j < ny; j += 1) qyt[t][j] /= rowSum;
        else for (let j = 0; j < ny; j += 1) qyt[t][j] = 1 / ny;
      }
      let ixt = 0;
      for (let i = 0; i < nx; i += 1) {
        let rowSum = 0;
        for (let t = 0; t < k; t += 1) rowSum += qtx[i][t];
        for (let t = 0; t < k; t += 1) {
          const q = qtx[i][t] / (rowSum || 1);
          if (q > 0) ixt += px[i] * q * Math.log(q / (qt[t] || 1e-300));
        }
      }
      let ity = 0;
      for (let t = 0; t < k; t += 1) {
        if (qt[t] <= 0) continue;
        ity += qt[t] * klDivergence(qyt[t], py);
      }
      return { ixt, ity, lag: ixt - beta * ity, qt, qyt };
    };

    let prev = currentLagrangian();
    let converged = false;
    let iterations = 0;
    for (iterations = 1; iterations <= maxIterations; iterations += 1) {
      // q(t|x) ∝ q(t)·exp(−β·D_KL[p(y|x) ‖ q(y|t)])
      const next: number[][] = [];
      for (let i = 0; i < nx; i += 1) {
        const row: number[] = [];
        for (let t = 0; t < k; t += 1) {
          const d = klDivergence(pyx[i], prev.qyt[t]);
          row.push(Math.max(1e-300, (prev.qt[t] || 1e-300) * Math.exp(-beta * d)));
        }
        next.push(row);
      }
      qtx = next;
      const cur = currentLagrangian();
      if (Math.abs(cur.lag - prev.lag) <= tol * Math.max(1, Math.abs(prev.lag))) {
        prev = cur;
        converged = true;
        break;
      }
      // 单调不增（数值容差内）；违反即停（防御口径）
      if (cur.lag > prev.lag + 1e-6) {
        prev = cur;
        break;
      }
      prev = cur;
    }
    return { prev, qtx, iterations, converged };
  };

  const baseSeed = options?.seed ?? 20261002;
  let best = runOnce(baseSeed);
  for (const offset of [7919, 104729]) {
    const attempt = runOnce((baseSeed + offset) >>> 0);
    if (attempt.prev.lag < best.prev.lag - 1e-12) best = attempt;
  }
  const { prev, qtx, iterations, converged } = best;

  const assignment = qtx.map((row) => {
    let bestIdx = 0;
    for (let t = 1; t < k; t += 1) if (row[t] > row[bestIdx]) bestIdx = t;
    return bestIdx;
  });
  const alive = new Set(assignment);
  const clusterPosteriors = prev.qyt.filter((_, t) => alive.has(t));
  return {
    clusters: alive.size,
    iXY: ixy,
    iTY: prev.ity,
    retention: ixy > 0 ? Math.min(1, prev.ity / ixy) : 0,
    iXT: prev.ixt,
    lagrangian: prev.lag,
    assignment,
    clusterPosteriors,
    iterations,
    converged,
  };
}

/**
 * 蒸馏信息定价（37.0 接线口径）。
 *
 * 样本形如 { features: 位型标签数组（如 ['code', 'slow']）, success }。
 * 特征位型做 X、成败做 Y 聚合经验分布 → IB 压缩 → retention 为
 * 「这批样本携带的值得蒸馏的信息比例」。
 */
export function distillRetention(
  samples: ReadonlyArray<{ features: ReadonlyArray<string>; success: boolean }>,
  options?: BottleneckOptions,
): BottleneckReport & { sampleCount: number } {
  const featureSets = samples.map((s) => [...new Set(s.features.filter((f) => f.length > 0))].sort().join('|'));
  const vocab = [...new Set(featureSets)];
  const xi = new Map(vocab.map((v, i) => [v, i]));
  const pxy: number[][] = Array.from({ length: vocab.length }, () => [0, 0]);
  for (const s of samples) {
    const i = xi.get([...new Set(s.features.filter((f) => f.length > 0))].sort().join('|'));
    if (i === undefined) continue;
    pxy[i][s.success ? 1 : 0] += 1;
  }
  return { ...informationBottleneck(pxy, options), sampleCount: samples.length };
}

// ─────────────────────────── R5：IB 曲线 + 确定性 IB ───────────────────────────

/** IB 曲线单点（β 扫描） */
export interface IbCurvePoint {
  /** 压缩-相关权衡 β */
  beta: number;
  /** I(X;T)（nat）——压缩复杂度 */
  iXT: number;
  /** I(T;Y)（nat）——保留信息 */
  iTY: number;
  /** I(T;Y)/I(X;Y) */
  retention: number;
  /** L = I(X;T) − β·I(T;Y) */
  lagrangian: number;
  /** 存活压缩道数 */
  clusters: number;
  converged: boolean;
}

/** IB 曲线报告（含凹性 / 单调性 / DPI 诊断——曲线形状本身成为验证锚） */
export interface IbCurveReport {
  /** I(X;Y)（nat） */
  iXY: number;
  /** 曲线点（按 iXT 升序） */
  points: IbCurvePoint[];
  /** 全部点 I(T;Y) ≤ I(X;Y)（数据处理不等式） */
  dpiHolds: boolean;
  /** I(X;T) 随 β 单调不降（β↑ 压缩代价放宽） */
  iXTMonotone: boolean;
  /** I(T;Y) 随 β 单调不降 */
  iTYMonotone: boolean;
  /** 曲线凹性：按 iXT 升序斜率非增（可达域凸的边界表述；斜率 = 1/β 理论序） */
  concave: boolean;
  /** 最大斜率增量（≤ 0 即严格凹；> 0 为违反量——诚实报告） */
  maxSlopeIncrease: number;
}

/** 曲线扫描默认 β 网格（对数等距，10 档） */
const DEFAULT_IB_CURVE_BETAS: readonly number[] = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64];

/**
 * IB 曲线扫描（R5）：β 网格上逐点求解软 IB，诊断曲线形状。
 *
 * 理论锚（全部转成可计算检验）：可达域凸 ⟹ 上边界 (iXT, iTY) 凹
 * （斜率非增）；斜率理论值 = 1/β；β↑ 时 iXT、iTY 单调不降；
 * 每点 DPI I(T;Y) ≤ I(X;Y)。容差 1e-3（聚类离散化的量化尘埃内）。
 */
export function ibCurve(
  joint: ReadonlyArray<ReadonlyArray<number>>,
  options?: { betas?: readonly number[] } & Omit<BottleneckOptions, 'beta'>,
): IbCurveReport {
  const { betas: customBetas, ...rest } = options ?? {};
  const betas = [...(customBetas ?? DEFAULT_IB_CURVE_BETAS)]
    .filter((b) => Number.isFinite(b) && b > 0)
    .sort((x, y) => x - y);
  if (betas.length === 0) throw new Error('ibCurve: betas 必须是非空正数序列');
  const reports = betas.map((beta) => informationBottleneck(joint, { ...rest, beta }));
  const points: IbCurvePoint[] = reports.map((r, i) => ({
    beta: betas[i]!,
    iXT: r.iXT,
    iTY: r.iTY,
    retention: r.retention,
    lagrangian: r.lagrangian,
    clusters: r.clusters,
    converged: r.converged,
  }));
  const iXY = reports[0]!.iXY;
  const tol = 1e-3;
  const dpiHolds = points.every((p) => p.iTY <= iXY + 1e-6 && p.retention <= 1 + 1e-9);
  const monotoneBy = (key: 'iXT' | 'iTY'): boolean => {
    const sortedByBeta = [...points].sort((x, y) => x.beta - y.beta);
    for (let i = 1; i < sortedByBeta.length; i += 1) {
      if (sortedByBeta[i]![key] < sortedByBeta[i - 1]![key]! - tol) return false;
    }
    return true;
  };
  // 凹性：按 iXT 升序取相邻（iXT 递增）点对斜率，斜率非增
  const ordered = [...points].sort((x, y) => x.iXT - y.iXT || x.beta - y.beta);
  const slopes: number[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const dx = ordered[i]!.iXT - ordered[i - 1]!.iXT;
    if (dx > 1e-9) slopes.push((ordered[i]!.iTY - ordered[i - 1]!.iTY) / dx);
  }
  let maxSlopeIncrease = 0;
  for (let i = 1; i < slopes.length; i += 1) {
    maxSlopeIncrease = Math.max(maxSlopeIncrease, slopes[i]! - slopes[i - 1]!);
  }
  return {
    iXY,
    points: ordered,
    dpiHolds,
    iXTMonotone: monotoneBy('iXT'),
    iTYMonotone: monotoneBy('iTY'),
    concave: maxSlopeIncrease <= tol,
    maxSlopeIncrease,
  };
}

/** 确定性 IB（dIB）报告（单位一律 nat） */
export interface DeterministicIbReport {
  /** 存活压缩道数（划分块数） */
  clusters: number;
  /** I(X;Y)（nat） */
  iXY: number;
  /** I(T;Y)（nat） */
  iTY: number;
  /** I(X;T) = H(T)（nat，硬指派口径） */
  iXT: number;
  /** 保留率 I(T;Y)/I(X;Y) */
  retention: number;
  /** F = H(T) − β·I(T;Y) */
  lagrangian: number;
  /** 每个特征位型 → 簇编号 */
  assignment: number[];
  /** 每簇的后验 q(y|t)（按最终簇首成员顺序） */
  clusterPosteriors: number[][];
  /** 合并审计（按发生顺序；ΔF < 0 才合并） */
  merges: Array<{ into: number; merged: number; deltaLagrangian: number }>;
  /** 惰性增量缓存下的 ΔF 计算次数（性能审计：全量重算口径为 Σ 步 × 存活对数） */
  evaluations: number;
  /** 无改进合并可做（贪心收敛） */
  converged: boolean;
}

/** 确定性 IB 选项 */
export interface DeterministicIbOptions {
  /** 压缩-相关权衡 β（缺省 5） */
  beta?: number;
}

/**
 * 确定性信息瓶颈（R5；Strouse & Schwab 2017 The Deterministic Information
 * Bottleneck）：q(t|x) 限硬指派（X 行划分），F = H(T) − β·I(T;Y)。
 *
 * 贪心凝聚：每步找使 F 下降最多的簇对合并；二元合并增量闭式
 *   ΔH = h(p_i+p_j) − h(p_i) − h(p_j)，h(p) = −p·ln p
 *   ΔI = term(m_i+m_j) − term(m_i) − term(m_j)，term(m) = Σ_y m_y·ln(m_y/((Σ_y m_y)·p_y))
 * 惰性增量缓存：合并只作废触及 (i,·)/(j,·) 的对，其余 ΔF 复用——
 * 与全量重算产生**相同贪心轨迹**（等价），计算量按需补算。
 * 平局按 (into, merged) 字典序——确定性；无 β 依赖的随机性。
 * 软 IB 是本问题的松弛：F_dIB ≥ F_soft（同 β，验证锚）。
 * β → ∞：无合并可改进（T = X，retention → 1）；β → 0：塌缩单簇
 * （retention → 0）。|X| ≤ 1 或 I(X;Y) = 0 时诚实返回单簇。
 */
export function deterministicIB(joint: ReadonlyArray<ReadonlyArray<number>>, options?: DeterministicIbOptions): DeterministicIbReport {
  const beta = options?.beta ?? 5;
  if (!Number.isFinite(beta) || beta < 0) throw new Error('deterministicIB: beta 必须为非负有限数');
  const nx = joint.length;
  const ny = nx > 0 ? joint[0].length : 0;
  if (nx === 0 || ny === 0) throw new Error('deterministicIB: 空分布');
  // 归一化
  let total = 0;
  for (const row of joint) {
    if (row.length !== ny) throw new Error('deterministicIB: 分布表必须为矩形');
    for (const v of row) {
      if (!Number.isFinite(v) || v < 0) throw new Error('deterministicIB: 概率必须为非负有限数');
      total += v;
    }
  }
  if (!(total > 0)) throw new Error('deterministicIB: 分布总和必须为正');
  const pxy: number[][] = joint.map((row) => row.map((v) => v / total));
  const px = pxy.map((row) => row.reduce((s, v) => s + v, 0));
  const py = Array.from({ length: ny }, (_, j) => pxy.reduce((s, row) => s + row[j]!, 0));
  const ixy = mutualInfo(pxy).ixy;
  const activeRows: number[] = [];
  for (let i = 0; i < nx; i += 1) if (px[i]! > 0) activeRows.push(i);
  if (ixy <= 1e-12 || activeRows.length <= 1) {
    // 单簇：T = 常数（β 有限、无信息或无可分行时的 dIB 最优）
    return {
      clusters: 1,
      iXY: ixy,
      iTY: 0,
      iXT: 0,
      retention: 0,
      lagrangian: 0,
      assignment: Array.from({ length: nx }, () => 0),
      clusterPosteriors: [py.slice()],
      merges: [],
      evaluations: 0,
      converged: true,
    };
  }
  // 初始：每个正质量行一簇；簇存联合质量 m_t(y) = Σ_{x∈t} p(x,y)
  const clusterMass: number[][] = activeRows.map((i) => pxy[i]!.slice());
  const alive = new Set<number>(clusterMass.map((_, k) => k));
  const memberFirst = activeRows.slice(); // 簇 k 的首成员行
  const hTerm = (p: number): number => (p > 0 ? -p * Math.log(p) : 0);
  const iTerm = (m: ReadonlyArray<number>): number => {
    let s = 0;
    let pt = 0;
    for (let y = 0; y < ny; y += 1) pt += m[y]!;
    for (let y = 0; y < ny; y += 1) {
      if (m[y]! > 0 && pt > 0 && py[y]! > 0) s += m[y]! * Math.log(m[y]! / (pt * py[y]!));
    }
    return s;
  };
  const pOf = (k: number): number => clusterMass[k]!.reduce((s, v) => s + v, 0);
  let deltaCache = new Map<string, number>();
  let evaluations = 0;
  const pairDelta = (i: number, j: number): number => {
    const key = `${i}:${j}`;
    const cached = deltaCache.get(key);
    if (cached !== undefined) return cached;
    evaluations += 1;
    const pi = pOf(i);
    const pj = pOf(j);
    const merged = clusterMass[i]!.map((v, y) => v + clusterMass[j]![y]!);
    const dH = hTerm(pi + pj) - hTerm(pi) - hTerm(pj);
    const dI = iTerm(merged) - iTerm(clusterMass[i]!) - iTerm(clusterMass[j]!);
    const dF = dH - beta * dI;
    deltaCache.set(key, dF);
    return dF;
  };
  const merges: Array<{ into: number; merged: number; deltaLagrangian: number }> = [];
  while (alive.size > 1) {
    const list = [...alive].sort((x, y) => x - y);
    let best = Infinity;
    let bestI = -1;
    let bestJ = -1;
    for (let a = 0; a < list.length; a += 1) {
      for (let b = a + 1; b < list.length; b += 1) {
        const d = pairDelta(list[a]!, list[b]!);
        // 平局按 (i,j) 字典序（先到先得——list 已升序）
        if (d < best - 1e-15) {
          best = d;
          bestI = list[a]!;
          bestJ = list[b]!;
        }
      }
    }
    if (bestI < 0 || best >= -1e-12) break; // 贪心停：无改进合并可用
    // 合并 j → i
    clusterMass[bestI] = clusterMass[bestI]!.map((v, y) => v + clusterMass[bestJ]![y]!);
    alive.delete(bestJ);
    merges.push({ into: memberFirst[bestI]!, merged: memberFirst[bestJ]!, deltaLagrangian: Number(best.toFixed(12)) });
    // 惰性作废：触及 i 或 j 的对
    deltaCache = new Map(
      [...deltaCache].filter(([k]) => {
        const [x, y] = k.split(':').map(Number);
        return x !== bestI && x !== bestJ && y !== bestI && y !== bestJ;
      }),
    );
  }
  // 汇总
  const finalClusters = [...alive].sort((x, y) => x - y);
  const clusterPosteriors = finalClusters.map((k) => {
    const pt = pOf(k);
    return clusterMass[k]!.map((v) => (pt > 0 ? v / pt : 1 / ny));
  });
  const clusterIndexByFirst = new Map<number, number>(finalClusters.map((k, c) => [memberFirst[k]!, c]));
  const assignment = Array.from({ length: nx }, (_, i) => {
    const c = clusterIndexByFirst.get(i);
    if (c !== undefined) return c;
    // px = 0 的行：不影响目标，指派到首簇（或 0）
    return clusterIndexByFirst.get(activeRows[0]!) ?? 0;
  });
  const pts = finalClusters.map((k) => pOf(k));
  const ixt = pts.reduce((s, p) => s + hTerm(p), 0);
  const ity = finalClusters.reduce((s, k) => s + iTerm(clusterMass[k]!), 0);
  return {
    clusters: finalClusters.length,
    iXY: ixy,
    iTY: ity,
    iXT: ixt,
    retention: ixy > 0 ? Math.min(1, ity / ixy) : 0,
    lagrangian: ixt - beta * ity,
    assignment,
    clusterPosteriors,
    merges,
    evaluations,
    converged: true,
  };
}
