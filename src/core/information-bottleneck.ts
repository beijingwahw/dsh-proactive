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
    const i = xi.get([...new Set(s.features)].sort().join('|'));
    if (i === undefined) continue;
    pxy[i][s.success ? 1 : 0] += 1;
  }
  return { ...informationBottleneck(pxy, options), sampleCount: samples.length };
}
