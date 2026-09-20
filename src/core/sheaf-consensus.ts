/**
 * sheaf-consensus.ts — 层论共识内核（项目 20.0「分歧的形状可见」质变基座）
 *
 * 升级前的根本局限（平均化共识的结构性盲区）：
 * - 多源信念聚合只有「平均 / 投票 / 市场价」三种武器，三者都把
 *   分歧当成标量噪声抹平：「A 说任务简单、B 说任务难」平均成
 *   「中等难度」——这是**编造的共识**：没有人真的认为它中等，
 *   平均值不在任何信息源的支持集里；
 * - 结构性分歧不可检测：循环异议（A 信 0.9、B 信 0.1、约束要求
 *   A=B）不是噪声，是**无解**——但平均给出 0.5 且皆大欢喜，
 *   系统永远不知道「共识根本不存在」这件事本身；
 * - 聚合结构不可声明：市场价（LMSR）按资产独立聚合，跨资产的
 *   一致性要求（「模型 X 在任务类的成功率信念应与任务类自身的
 *   统计一致」）没有表达语言——聚合器不知道什么应该一致。
 *
 * 本内核引入胞腔层（cellular sheaf）共识（Hansen–Ghrist 2019
 * 《Toward a spectral theory of cellular sheaves》；Hansen–Ghrist 2021
 * 《Opinion dynamics on discourse sheaves》——应用层论进入分布式
 * 共识与观点动力学的前沿框架）：
 *
 * 1. **层 = 局部一致性结构的精确语言**：图上每个顶点挂一个 stalk
 *    （该智能体/数据源的信念向量空间），每条边挂一个 edge stalk
 *    （共享声明空间）与两个限制映射 F_{v≺e}, F_{w≺e}（顶点信念
 *    投影到共享声明的线性映射）——**「谁与谁、在哪些声明上、
 *    应该一致到什么程度」第一次成为一等数学对象**。
 *
 * 2. **全局截面（global section）= 完美共识**：所有边约束同时满足
 *    的信念指派。共识不再是「平均」，而是「方程组的解」。
 *
 * 3. **层拉普拉斯算子（sheaf Laplacian）**：
 *      L_F = δ_F† δ_F，L[v][v] = Σ_{e∋v} FᵀF，L[v][w] = −Fᵀ_{v≺e}F_{w≺e}
 *    分歧能量 E(x) = xᵀL_F x = Σ_e ‖F_{v≺e}x_v − F_{w≺e}x_w‖²
 *    调和指派（ker L_F）= 全局截面；λ_max 给出分歧能量的谱上界。
 *
 * 4. **加权调和共识（观测锚定最小二乘）**：
 *      min_x Σ_e ‖F_v x_v − F_w x_w‖² + Σ_v α_v‖x_v − b_v‖²
 *    正规方程 (L_F + A)x = Ab——高斯消元精确求解。产物：
 *    - **共识指派**：每个顶点的调和信念（最接近观测且最大程度
 *      满足一致结构——不是平均，是最小化「翻供量」的代数调解）；
 *    - **离群者定位**：各锚定顶点为达成共识翻供的距离 ‖x*_v − b_v‖
 *      ——谁最抗拒共识，谁最可能是错的一方；
 *    - **结构性障碍（obstruction）检测**：调和后的分歧能量地板
 *      E* > 0 ⇒ 约束网络与观测**无联合实现**——共识在数学上不
 *      存在，系统第一次能说「别装了，你们根本不一致」。
 *
 * 与 16.0 的关系：Shapley 拆分「合作剩余如何公平分配」（博弈论侧），
 * 本内核回答「多源信念如何结构性融合」（拓扑侧）——分配与融合
 * 构成多智能体问责的两大代数支柱；与 6.0 的关系：自由能度量
 * 「预测与观测的惊异」，本内核度量「信念彼此的惊异」——世界对
 * 系统的惊喜与系统内部的自相惊喜同构；与共生经济的关系：LMSR
 * 市场价聚合单资产标量，本内核聚合**带一致性结构的向量信念**——
 * 市场与层论是聚合的两个正交维度（价格 vs 结构）。
 */

// ─────────────────────────── 层的构造语言 ───────────────────────────

/** 顶点声明：id + 信念空间维度 */
export interface SheafVertexSpec {
  id: string;
  /** 信念向量维度（标量信念 = 1） */
  dim: number;
}

/**
 * 边声明：a↔b 之间的局部一致性约束。
 *
 * 两种写法（二选一）：
 * - 显式矩阵：mapA / mapB（d_e×d 的行主序矩阵，顶点信念 → 共享声明空间）；
 * - 坐标速记：sharedA / sharedB（顶点 a/b 中参与共享的坐标下标表，
 *   长度必须相等——投影矩阵自动生成；全维度同序共享可整体省略）。
 */
export interface SheafEdgeSpec {
  a: string;
  b: string;
  /** a 的限制映射（d_e × dim(a)；与 mapB 的共享维度一致） */
  mapA?: number[][];
  /** b 的限制映射（d_e × dim(b)） */
  mapB?: number[][];
  /** 速记：a 侧参与共享的坐标下标（与 mapA 互斥） */
  sharedA?: number[];
  /** 速记：b 侧参与共享的坐标下标（与 mapB 互斥） */
  sharedB?: number[];
}

/** 观测锚点：某顶点的实测信念 + 置信权重 α（大 = 硬约束） */
export interface SheafAnchorSpec {
  id: string;
  values: number[];
  /** 锚定权重（缺省 1；0 = 该顶点完全由邻接结构外推） */
  weight?: number;
}

// ─────────────────────────── 共识报告 ───────────────────────────

/** 层共识报告 */
export interface SheafConsensusReport {
  /** 调和共识指派（每顶点的信念向量） */
  consensus: Record<string, number[]>;
  /** 分歧能量地板 E*（> 阈值 ⇒ 结构性障碍：完美共识不存在） */
  disagreementEnergy: number;
  /** 归一化分歧（E* / (E* + 锚定拟合能)；0 = 存在完美共识） */
  normalizedDisagreement: number;
  /** 结构性障碍裁决 */
  obstruction: 'none' | 'structural-conflict';
  /** 各锚定顶点为共识翻供的距离（离群者 = 最大翻供者） */
  deviations: Record<string, number>;
  /** 谁最抗拒共识（翻供距离降序） */
  outliers: string[];
  /** 层拉普拉斯谱半径 λ_max（分歧能量的谱上界口径） */
  spectralRadius: number;
  /** 参与顶点数 / 边数 / 总维度 */
  size: { vertices: number; edges: number; dimension: number };
  interpretation: string;
}

// ─────────────────────────── 胞腔层引擎 ───────────────────────────

/**
 * 胞腔层：图上的局部一致性结构 + 调和共识求解器。
 *
 * 用法：
 *   const sheaf = new CellularSheaf();
 *   sheaf.addVertex('market', 1);        // 市场价信念（标量）
 *   sheaf.addVertex('stats', 1);         // 统计估计信念（标量）
 *   sheaf.addEdge('market', 'stats');    // 标量等值约束（缺省单位映射）
 *   const report = sheaf.harmonize([
 *     { id: 'market', values: [0.82], weight: 1 },
 *     { id: 'stats', values: [0.55], weight: 2 },
 *   ]);
 *   // consensus ≈ 加权调解；structuralConflict = false（标量等值总有解）
 *
 * 结构性障碍示例：三方循环硬约束 0.9 / 0.1 / 0.5（α→大）——
 * 调和后能量地板 > 0，obstruction = 'structural-conflict'：
 * 平均会说 0.5，本内核说「无解，先解决矛盾再谈共识」。
 */
export class CellularSheaf {
  private readonly vertexIds: string[] = [];
  private readonly vertexDims = new Map<string, number>();
  private readonly edges: Array<{
    a: string;
    b: string;
    mapA: number[][];
    mapB: number[][];
  }> = [];

  /** 添加顶点（幂等：重复 id 覆盖维度声明，边失效自检） */
  addVertex(id: string, dim: number): this {
    if (!this.vertexDims.has(id)) this.vertexIds.push(id);
    this.vertexDims.set(id, Math.max(1, Math.floor(dim)));
    return this;
  }

  /** 添加一致性约束边（速记自动展开为投影矩阵） */
  addEdge(spec: SheafEdgeSpec): this {
    const dimA = this.vertexDims.get(spec.a);
    const dimB = this.vertexDims.get(spec.b);
    if (!dimA || !dimB) throw new Error(`边的端点未声明: ${spec.a}(${spec.a in this.vertexDims}) ↔ ${spec.b}(${spec.b in this.vertexDims})`);
    let mapA = spec.mapA;
    let mapB = spec.mapB;
    if (!mapA || !mapB) {
      const sharedA = spec.sharedA ?? Array.from({ length: Math.min(dimA, dimB) }, (_, i) => i);
      const sharedB = spec.sharedB ?? Array.from({ length: Math.min(dimA, dimB) }, (_, i) => i);
      if (sharedA.length !== sharedB.length) throw new Error('共享坐标数不一致: sharedA/sharedB 长度必须相等');
      mapA = selectionMatrix(sharedA, dimA);
      mapB = selectionMatrix(sharedB, dimB);
    }
    if (mapA.length !== mapB.length) throw new Error('限制映射的共享维度不一致（mapA/mapB 行数应相等）');
    this.edges.push({ a: spec.a, b: spec.b, mapA, mapB });
    return this;
  }

  /** 顶点数 / 边数 */
  get size(): { vertices: number; edges: number; dimension: number } {
    return {
      vertices: this.vertexIds.length,
      edges: this.edges.length,
      dimension: this.vertexDims.size,
    };
  }

  /** 全局维度布局：顶点 → 起始行号 */
  private layout(): Map<string, number> {
    const offset = new Map<string, number>();
    let acc = 0;
    for (const id of this.vertexIds) {
      offset.set(id, acc);
      acc += this.vertexDims.get(id)!;
    }
    return offset;
  }

  /** 总维度 */
  private totalDim(): number {
    return this.vertexIds.reduce((s, id) => s + this.vertexDims.get(id)!, 0);
  }

  /**
   * 层拉普拉斯 L_F（D×D 块矩阵；D = Σ 各顶点维度）。
   *
   * L[v][v] = Σ_{e∋v} Fᵀ_{v≺e}F_{v≺e}；L[v][w] = −Fᵀ_{v≺e}F_{w≺e}
   * （F 为 d_e×d 的限制映射；FᵀF 与 FᵀG 对共享维度 i 单重求和）
   */
  buildLaplacian(): number[][] {
    const D = this.totalDim();
    const offset = this.layout();
    const L = Array.from({ length: D }, () => new Array<number>(D).fill(0));
    for (const edge of this.edges) {
      const oa = offset.get(edge.a)!;
      const ob = offset.get(edge.b)!;
      const de = edge.mapA.length;
      const da = edge.mapA[0]?.length ?? 0;
      const db = edge.mapB[0]?.length ?? 0;
      for (let i = 0; i < de; i += 1) {
        for (let p = 0; p < da; p += 1) {
          for (let q = 0; q < da; q += 1) L[oa + p]![oa + q]! += edge.mapA[i]![p]! * edge.mapA[i]![q]!;
          for (let q = 0; q < db; q += 1) {
            const cross = -edge.mapA[i]![p]! * edge.mapB[i]![q]!;
            L[oa + p]![ob + q]! += cross;
            L[ob + q]![oa + p]! += cross;
          }
        }
        for (let p = 0; p < db; p += 1) {
          for (let q = 0; q < db; q += 1) L[ob + p]![ob + q]! += edge.mapB[i]![p]! * edge.mapB[i]![q]!;
        }
      }
    }
    return L;
  }

  /**
   * 加权调和共识（双解口径）：
   *
   * - 软调解解 x_soft：min_x E_disagree(x) + Σ αᵢ‖xᵢ − bᵢ‖²
   *   —— 正规方程 (L_F + A)x = Ab，一致性与观测忠诚度的最优折衷；
   * - 完美共识解 x_hard：min Σ αᵢ‖xᵢ − bᵢ‖² s.t. L_F x = 0
   *   —— 刚度惩罚 (A + M·L_F)x = Ab（M 大）实现约束最小二乘：
   *   **完美共识流形上对观测的最佳拟合**；
   * - 障碍裁决：x_hard 的加权锚定失配
   *     misfit = Σ α‖x_hard − b‖² / Σ α
   *   超过容差 ⇒ 任何完美共识都无法解释观测——**结构性障碍**
   *   （平均化会编造共识，本内核宣布无解）；否则共识 = x_hard
   *   （完美一致 + 最忠实观测），障碍时共识 = x_soft（冲突下的
   *   最小翻供调解），两态各得其所。
   *
   * @param anchors 观测锚点（至少 1 个；其余顶点由结构外推——
   *                完全无锚的连通分量无信息，解退化为 0 向量）
   * @param options.misfitTolerance 障碍判定的加权失配容差
   *        （均方差口径；缺省 0.0025 ≈ 5% 标准差）
   */
  harmonize(anchors: readonly SheafAnchorSpec[], options?: { misfitTolerance?: number }): SheafConsensusReport {
    const D = this.totalDim();
    const offset = this.layout();
    const L = this.buildLaplacian();
    // A 与 Ab
    const alpha = new Float64Array(D);
    const observed = new Float64Array(D); // b（未锚定坐标 = 0 且 α=0，不参与）
    const hasAnchor = new Uint8Array(D);
    for (const anchor of anchors) {
      const dim = this.vertexDims.get(anchor.id);
      const start = offset.get(anchor.id);
      if (dim === undefined || start === undefined) continue; // 未声明顶点静默忽略
      const w = Math.max(0, anchor.weight ?? 1);
      for (let i = 0; i < dim && i < anchor.values.length; i += 1) {
        alpha[start + i] = w;
        observed[start + i] = anchor.values[i]!;
        hasAnchor[start + i] = 1;
      }
    }
    let anchorWeightSum = 0;
    for (let i = 0; i < D; i += 1) anchorWeightSum += alpha[i]!;
    const rhs = Array.from({ length: D }, (_, i) => alpha[i]! * observed[i]!);
    // 软调解解：(L + A)x = Ab
    const softMatrix = L.map((row, i) => [...row]);
    for (let i = 0; i < D; i += 1) softMatrix[i]![i]! += alpha[i]!;
    const xSoft = solveLinearSystem(softMatrix, rhs);
    // 完美共识解：(A + M·L)x = Ab（刚度 M 压入全局截面流形）
    const maxAbs = Math.max(1, ...L.flat().map(Math.abs));
    const stiffness = 1e8 * maxAbs;
    const hardMatrix = L.map((row, i) => row.map((v) => v * stiffness));
    for (let i = 0; i < D; i += 1) hardMatrix[i]![i]! += alpha[i]! + 1e-9;
    const xHard = solveLinearSystem(hardMatrix, rhs);
    // 障碍裁决：完美共识流形上的加权失配
    let hardMisfit = 0;
    for (let i = 0; i < D; i += 1) {
      if (hasAnchor[i]) hardMisfit += alpha[i]! * (xHard[i]! - observed[i]!) ** 2;
    }
    const misfit = anchorWeightSum > 0 ? hardMisfit / anchorWeightSum : 0;
    const misfitTolerance = options?.misfitTolerance ?? 0.0025;
    const obstruction: SheafConsensusReport['obstruction'] = misfit > misfitTolerance ? 'structural-conflict' : 'none';
    const solution = obstruction === 'none' ? xHard : xSoft;
    // 能量分解（按最终指派口径）
    let disagreementEnergy = 0;
    for (const edge of this.edges) {
      const oa = offset.get(edge.a)!;
      const ob = offset.get(edge.b)!;
      for (let i = 0; i < edge.mapA.length; i += 1) {
        const pa = edge.mapA[i]!.reduce((s, m, p) => s + m * solution[oa + p]!, 0);
        const pb = edge.mapB[i]!.reduce((s, m, p) => s + m * solution[ob + p]!, 0);
        disagreementEnergy += (pa - pb) ** 2;
      }
    }
    // 共识回填 + 翻供距离
    const consensus: Record<string, number[]> = {};
    const deviations: Record<string, number> = {};
    for (const id of this.vertexIds) {
      const start = offset.get(id)!;
      const dim = this.vertexDims.get(id)!;
      consensus[id] = Array.from({ length: dim }, (_, i) => round(solution[start + i]!));
      const anchor = anchors.find((a) => a.id === id);
      if (anchor) {
        let dev = 0;
        for (let i = 0; i < dim && i < anchor.values.length; i += 1) dev += (solution[start + i]! - anchor.values[i]!) ** 2;
        deviations[id] = round(Math.sqrt(dev));
      }
    }
    const tolerance = Math.sqrt(misfitTolerance);
    const outliers = Object.entries(deviations)
      .filter(([, d]) => d > tolerance)
      .sort((x, y) => y[1] - x[1])
      .map(([id]) => id);
    const normalized = Math.min(1, misfit / Math.max(1e-15, misfitTolerance * 4));
    return {
      consensus,
      disagreementEnergy: round(disagreementEnergy),
      normalizedDisagreement: round(normalized),
      obstruction,
      deviations,
      outliers,
      spectralRadius: round(largestEigenvalue(L)),
      size: { vertices: this.vertexIds.length, edges: this.edges.length, dimension: D },
      interpretation: this.interpret(obstruction, misfit, misfitTolerance, outliers),
    };
  }

  private interpret(
    obstruction: SheafConsensusReport['obstruction'],
    misfit: number,
    tolerance: number,
    outliers: string[],
  ): string {
    if (obstruction === 'structural-conflict') {
      const who = outliers.length > 0 ? `（翻供最大者：${outliers.slice(0, 3).join('、')}）` : '';
      return `结构性分歧：任何完美共识都无法解释观测（加权失配 ${misfit.toFixed(4)} > 容差 ${tolerance}）——平均化会编造不存在的共识，共识 = 最小翻供调解${who}`;
    }
    return `共识达成：完美一致流形上的最优拟合（加权失配 ${misfit.toExponential(2)} ≤ 容差 ${tolerance}）${outliers.length > 0 ? `；翻供最大者：${outliers.slice(0, 3).join('、')}` : ''}`;
  }
}

// ─────────────────────────── 速捷构造器 ───────────────────────────

/**
 * 标量等值层（经典平均共识的层论化）：全部顶点标量信念、边为单位
 * 等值约束——调和共识退化为加权平均，但额外输出翻供距离与
 * （多维时）障碍检测。快路径工具与对照实验用。
 */
export function scalarAgreementSheaf(ids: readonly string[]): CellularSheaf {
  const sheaf = new CellularSheaf();
  for (const id of ids) sheaf.addVertex(id, 1);
  for (let i = 1; i < ids.length; i += 1) sheaf.addEdge({ a: ids[i - 1]!, b: ids[i]! });
  return sheaf;
}

/**
 * 声明重叠层（多源向量信念融合的标准形）：每个源一个顶点，维度 =
 * 其本地声明表长度；边声明两侧共享声明的坐标映射。
 *
 * 例：模型 A 信念表 [c1,c2,c3]，模型 B 信念表 [c1,c2,c4]——
 *   overlapSheaf([dimA=3, dimB=3], edges=[{a,b,sharedA:[0,1],sharedB:[0,1]}])
 * c1/c2 上强制一致，c3/c4 各自独立保留——「在哪一致、在哪各说各话」
 * 逐声明精确声明。
 */
export function overlapSheaf(
  vertices: ReadonlyArray<{ id: string; dim: number }>,
  edges: ReadonlyArray<{ a: string; b: string; sharedA: number[]; sharedB: number[] }>,
): CellularSheaf {
  const sheaf = new CellularSheaf();
  for (const v of vertices) sheaf.addVertex(v.id, v.dim);
  for (const e of edges) sheaf.addEdge(e);
  return sheaf;
}

// ─────────────────────────── 数值内核 ───────────────────────────

/** 坐标选择矩阵（d_e × d：选出指定坐标到共享空间） */
function selectionMatrix(indices: readonly number[], dim: number): number[][] {
  return indices.map((idx) =>
    Array.from({ length: dim }, (_, j) => (j === Math.max(0, Math.min(dim - 1, Math.floor(idx))) ? 1 : 0)),
  );
}

/** 高斯消元（部分主元；奇异系统返回最小范数近似解并告警 NaN 防护） */
function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col += 1) {
    // 部分主元
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(M[pivot]![col]!) < 1e-14) continue; // 奇异列：跳过（该自由变量取 0）
    [M[col], M[pivot]] = [M[pivot]!, M[col]!];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = M[r]![col]! / M[col]![col]!;
      if (factor === 0) continue;
      for (let c = col; c <= n; c += 1) M[r]![c]! -= factor * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const diag = M[i]![i]!;
    x[i] = Math.abs(diag) > 1e-14 ? M[i]![n]! / diag : 0;
    if (!Number.isFinite(x[i])) x[i] = 0;
  }
  return x;
}

/** 幂迭代最大特征值（L_F 对称 PSD ⇒ λ_max = 谱半径） */
function largestEigenvalue(A: readonly (readonly number[])[]): number {
  const n = A.length;
  if (n === 0) return 0;
  let v = new Array<number>(n).fill(1 / Math.sqrt(n));
  let eigenvalue = 0;
  for (let iter = 0; iter < 128; iter += 1) {
    const Av = A.map((row) => row.reduce((s, a, j) => s + a * v[j]!, 0));
    const next = Math.sqrt(Av.reduce((s, x) => s + x * x, 0));
    if (next < 1e-15) return 0;
    eigenvalue = next;
    v = Av.map((x) => x / next);
  }
  return eigenvalue;
}

/** 六位小数圆整（项目统一展示口径） */
function round(x: number): number {
  return Number.isFinite(x) ? Number(x.toFixed(6)) : 0;
}
