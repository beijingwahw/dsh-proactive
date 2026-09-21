/**
 * 33.0 随机矩阵内核 —— Marchenko–Pastur 噪声边界 + 特征值清洗 + 系统性风险
 *
 * 动机: 多模型系统的「相关性」是排险与分流的依据——两个模型同挂才需要
 * 热备，彼此独立的模型才构成真正的冗余。但**样本相关矩阵的大多数特征
 * 结构是纯噪声**：p 个模型 × n 个观测的 iid 噪声，其相关谱不是集中于 1，
 * 而是铺满一整条带——
 *
 *   Marchenko–Pastur (1967): p×n iid（方差 σ²/n 口径）样本协方差的谱
 *   渐近支撑于 [σ²(1−√γ)², σ²(1+√γ)²]，γ = p/n。
 *   → **λ > λ+ 的特征值在纯噪声下几乎不可能出现**（大偏差指数衰减）：
 *   噪声带以上 = 信号（真实的相关结构），以下 = 不可区分于噪声。
 *
 *   RMT 清洗（Laloux et al. 1999 / Plerou et al. 2002, 「noise dressing」）:
 *   谱分解 → λ < λ+ 的特征值替换为其均值（保迹）→ 重组 → 对角归一。
 *   被清洗的矩阵把「伪相关」抹掉、把真结构保留——相关性从统计幻觉
 *   升级为可证伪的结构断言。
 *
 *   系统性风险判据（本内核的调度语义）: 模型失败序列的相关矩阵经清洗后，
 *   若头号特征值仍显著超出 MP 边界（解释份额 λ₁/Σλ 超阈值），说明存在
 *   **共同因子**（同厂商 / 同上游 / 同配额池）——一个因子倒下会同时击穿
 *   一串「看起来分散」的模型。伪相关则会被清洗到边界内——不误报。
 *
 *   特征分解: 循环 Jacobi 旋转（对称矩阵，二次收敛，纯 TS 零依赖），
 *   A = QΛQᵀ 正交到机器精度——谱的每个数字都是可复算的。
 *
 * 零漂移: 未挂载时一切路径与升级前逐位一致。
 */

/** 对称矩阵特征分解结果（特征值降序；列 vectors[k] 为对应单位特征向量） */
export interface EigenResult {
  values: number[];
  vectors: number[][];
}

/**
 * 循环 Jacobi 对称特征分解。
 *
 * 每轮扫描所有非对角 (p,q)，用 Givens 旋转把 A[p][q] 消零；非对角能量
 * 单调下降且二次收敛（经典结果，~6-10 轮到机器精度）。
 */
export function jacobiEigensym(input: ReadonlyArray<ReadonlyArray<number>>, maxSweeps = 30, tol = 1e-12): EigenResult {
  const n = input.length;
  if (n === 0) return { values: [], vectors: [] };
  for (const row of input) if (row.length !== n) throw new Error('jacobiEigensym: 需要方阵');
  const a = input.map((row) => [...row]);
  // Q 累积旋转：vectors[k][i] = 第 k 个基向量的第 i 分量（行存储，转置口径）
  const q: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));

  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let offDiag = 0;
    for (let p = 0; p < n; p += 1) for (let qq = p + 1; qq < n; qq += 1) offDiag += a[p][qq] * a[p][qq];
    if (offDiag <= tol * tol) break;
    for (let p = 0; p < n - 1; p += 1) {
      for (let qq = p + 1; qq < n; qq += 1) {
        if (Math.abs(a[p][qq]) < 1e-300) continue;
        // 经典 Jacobi 角度（数值稳定形式）
        const theta = (a[qq][qq] - a[p][p]) / (2 * a[p][qq]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cos = 1 / Math.sqrt(t * t + 1);
        const sin = t * cos;
        for (let k = 0; k < n; k += 1) {
          const akp = a[k][p];
          const akq = a[k][qq];
          a[k][p] = cos * akp - sin * akq;
          a[k][qq] = sin * akp + cos * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = a[p][k];
          const aqk = a[qq][k];
          a[p][k] = cos * apk - sin * aqk;
          a[qq][k] = sin * apk + cos * aqk;
        }
        for (let k = 0; k < n; k += 1) {
          const qkp = q[k][p];
          const qkq = q[k][qq];
          q[k][p] = cos * qkp - sin * qkq;
          q[k][qq] = sin * qkp + cos * qkq;
        }
      }
    }
  }

  const values = Array.from({ length: n }, (_, i) => a[i][i]);
  const order = values.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v);
  // Q 的**列**是特征向量（A = QΛQᵀ）；q 为行存储 → 取列切片
  return {
    values: order.map((o) => o.v),
    vectors: order.map((o) => q.map((row) => row[o.i])),
  };
}

/** Marchenko–Pastur 谱边界：γ = p/n ∈ (0,1] 口径（γ > 1 时取 1/γ 的对偶带；σ² 缺省 1） */
export function mpEdges(gamma: number, sigma2 = 1): { lambdaMinus: number; lambdaPlus: number } {
  const g = Math.min(1, Math.max(1e-9, gamma));
  const root = Math.sqrt(g);
  return { lambdaMinus: sigma2 * (1 - root) ** 2, lambdaPlus: sigma2 * (1 + root) ** 2 };
}

/** 相关系数矩阵（Pearson；零方差序列 → 与一切不相关，行/列置 0、对角 1） */
export function correlationFromSeries(series: ReadonlyArray<ReadonlyArray<number>>): number[][] {
  const p = series.length;
  const n = p > 0 ? series[0].length : 0;
  const means = series.map((s) => (n > 0 ? s.reduce((a, b) => a + b, 0) / n : 0));
  const vars = series.map((s, i) => {
    let acc = 0;
    for (const x of s) acc += (x - means[i]) * (x - means[i]);
    return acc / Math.max(1, n);
  });
  const corr: number[][] = Array.from({ length: p }, () => Array.from({ length: p }, () => 0));
  for (let i = 0; i < p; i += 1) {
    corr[i][i] = 1;
    for (let j = i + 1; j < p; j += 1) {
      let cov = 0;
      for (let t = 0; t < n; t += 1) cov += (series[i][t] - means[i]) * (series[j][t] - means[j]);
      cov /= Math.max(1, n);
      const denom = Math.sqrt(vars[i] * vars[j]);
      const r = denom > 1e-12 ? cov / denom : 0;
      corr[i][j] = r;
      corr[j][i] = r;
    }
  }
  return corr;
}

/** 谱清洗报告 */
export interface CleansingReport {
  /** 降序特征值（清洗前的样本谱） */
  eigenvalues: number[];
  /** MP 噪声上边界 λ+（γ = p/n） */
  noiseEdge: number;
  /** 落入噪声带的特征值个数（含 γ>1 口径下的零谱） */
  noiseCount: number;
  /** 头号特征值的解释份额 λ₁ / Σλ（相关矩阵 Σλ = p） */
  topShare: number;
  /** λ₁ 是否超出 edgeFactor × λ+（信号判定） */
  signal: boolean;
  /** 清洗后的相关矩阵（对角 ≈ 1） */
  cleaned: number[][];
}

/**
 * RMT 特征值清洗（Laloux–Cizeau–Bouchaud / Plerou et al.）。
 *
 * 步骤: 谱分解 → λ < λ+ 的特征值替换为其均值（保迹）→ 重组 → 对角
 * 归一化到 1。输入应已是（准）相关矩阵；ratio = p/n（模型数 / 观测数）。
 */
export function cleanseCorrelation(matrix: ReadonlyArray<ReadonlyArray<number>>, ratio: number, edgeFactor = 1.0): CleansingReport {
  const p = matrix.length;
  const eigen = jacobiEigensym(matrix);
  const values = eigen.values;
  const trace = values.reduce((s, x) => s + x, 0) || p;
  const { lambdaPlus } = mpEdges(ratio);
  const edge = edgeFactor * lambdaPlus;
  const noiseIdx = new Set<number>();
  let noiseSum = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] < edge) {
      noiseIdx.add(i);
      noiseSum += values[i];
    }
  }
  const noiseCount = noiseIdx.size;
  const replacement = noiseCount > 0 ? noiseSum / noiseCount : 0;
  const cleansed = values.map((v, i) => (noiseIdx.has(i) ? replacement : v));
  // 重组 Q·diag(cleansed)·Qᵀ
  const cleaned: number[][] = Array.from({ length: p }, () => Array.from({ length: p }, () => 0));
  for (let k = 0; k < p; k += 1) {
    const vk = eigen.vectors[k];
    for (let i = 0; i < p; i += 1) {
      for (let j = i; j < p; j += 1) {
        const contribution = cleansed[k] * vk[i] * vk[j];
        cleaned[i][j] += contribution;
        if (j !== i) cleaned[j][i] += contribution;
      }
    }
  }
  // 对角归一（相关矩阵口径）
  for (let i = 0; i < p; i += 1) {
    const d = Math.sqrt(Math.max(1e-12, cleaned[i][i]));
    for (let j = 0; j < p; j += 1) {
      cleaned[i][j] /= d;
      cleaned[j][i] /= d;
    }
  }
  const topShare = values[0] !== undefined ? values[0] / trace : 0;
  return {
    eigenvalues: values,
    noiseEdge: edge,
    noiseCount,
    topShare,
    signal: values[0] !== undefined && values[0] > edge,
    cleaned,
  };
}

/** 系统性风险评估快照 */
export interface SystemicRiskAssessment {
  /** 参与评估的模型数（≥ minModels 才有意义） */
  models: number;
  /** 头号特征值（清洗前样本谱） */
  topEigenvalue: number;
  /** MP 噪声上界 */
  noiseEdge: number;
  /** 头号特征值解释份额 */
  topShare: number;
  /** 与头号特征向量对齐最深的模型（共同因子暴露最深者，按 |载荷| 降序） */
  topLoading: Array<{ index: number; loading: number }>;
  /** 是否判定系统性相关（信号在噪声带之上） */
  systemic: boolean;
  /** 窗口内观测数 */
  observations: number;
}

export interface SystemicRiskConfig {
  /** 滚动窗口长度（观测数；缺省 32） */
  window?: number;
  /** 参与评估的最少模型数（缺省 4） */
  minModels?: number;
  /** 信号判定倍数：λ₁ > factor × λ+（缺省 1.1） */
  edgeFactor?: number;
  /** 系统性洞察的解释份额门槛（缺省 0.35） */
  systemicShare?: number;
}

/**
 * 系统性风险监视器（33.0 接线桥）。
 *
 * 每个观测周期 observe() 一份「各模型本期失败计数」快照；窗口攒满后
 * 每次 assess() 对失败序列做相关矩阵 → RMT 清洗 → 共同因子判定。
 * 纯噪声的伪相关被 MP 边界吸收（不误报）；真因子结构触发 systemic，
 * 头号特征向量给出「谁在同一艘船上」的排序。
 */
export class SystemicRiskMonitor {
  private readonly window: number;
  private readonly minModels: number;
  private readonly edgeFactor: number;
  private readonly systemicShare: number;
  private readonly ids: string[] = [];
  private series: number[][] = [];
  private filled = false;

  constructor(config?: SystemicRiskConfig) {
    this.window = Math.max(8, Math.floor(config?.window ?? 32));
    this.minModels = Math.max(3, Math.floor(config?.minModels ?? 4));
    this.edgeFactor = config?.edgeFactor ?? 1.1;
    this.systemicShare = config?.systemicShare ?? 0.35;
  }

  /** 一期观测：counts 里只登记有活动（Δcalls > 0）的模型，缺席记 null */
  observe(counts: Record<string, number | null>): void {
    for (const id of Object.keys(counts)) {
      if (!this.ids.includes(id)) this.ids.push(id);
    }
    const row = this.ids.map((id) => {
      const v = counts[id];
      return v === undefined || v === null ? Number.NaN : v;
    });
    this.series.push(row);
    if (this.series.length > this.window) this.series.splice(0, this.series.length - this.window);
    this.filled = this.series.length >= this.window;
  }

  /** 当前窗口是否已攒满（未满时 assess 返回 undefined——先验无知） */
  get ready(): boolean {
    return this.filled;
  }

  /** 观测数（窗口内） */
  get observations(): number {
    return this.series.length;
  }

  /**
   * 评估系统性风险（窗口未满 / 活跃模型不足 → undefined）。
   *
   * 缺席（NaN）以该模型窗口均值插补（等价于「本期无信息」的中性口径），
   * 保证相关矩阵总是良定义。
   */
  assess(): SystemicRiskAssessment | undefined {
    if (!this.filled) return undefined;
    const p = this.ids.length;
    // 活跃模型：窗口内非缺席比例 ≥ 2/3 才进入评估（缺席过多 → 相关不可估）
    const active: number[] = [];
    for (let i = 0; i < p; i += 1) {
      let present = 0;
      for (const row of this.series) if (Number.isFinite(row[i])) present += 1;
      if (present >= (2 / 3) * this.series.length) active.push(i);
    }
    if (active.length < this.minModels) return undefined;
    const series = active.map((i) => {
      let sum = 0;
      let cnt = 0;
      for (const row of this.series) {
        if (Number.isFinite(row[i])) {
          sum += row[i];
          cnt += 1;
        }
      }
      const mean = cnt > 0 ? sum / cnt : 0;
      return this.series.map((row) => (Number.isFinite(row[i]) ? row[i] : mean));
    });
    const corr = correlationFromSeries(series);
    const report = cleanseCorrelation(corr, active.length / this.series.length, this.edgeFactor);
    const topVec = jacobiEigensym(corr).vectors[0] ?? [];
    const loading = active
      .map((idxAbs, k) => ({ index: idxAbs, loading: topVec[k] ?? 0 }))
      .sort((x, y) => Math.abs(y.loading) - Math.abs(x.loading))
      .slice(0, 5);
    return {
      models: active.length,
      topEigenvalue: report.eigenvalues[0] ?? 0,
      noiseEdge: report.noiseEdge,
      topShare: report.topShare,
      topLoading: loading,
      systemic: report.signal && report.topShare >= this.systemicShare,
      observations: this.series.length,
    };
  }

  /** 模型 id（下标口径） */
  get modelIds(): string[] {
    return [...this.ids];
  }
}
