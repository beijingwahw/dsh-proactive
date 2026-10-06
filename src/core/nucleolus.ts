/**
 * nucleolus.ts — 63.0 核仁内核 —— 抱怨字典序最小化的稳定分配（Schmeidler 1969）
 *
 * 升级前的根本局限（共生经济分红只有「平均公平」一条口径）：
 * - Shapley 16.0 是**平均**公平：边际贡献的期望分账，虚拟玩家零所得、
 *   对称玩家等所得——但它对「最坏联盟的异议」没有任何承诺：某个小
 *   联盟完全可能觉得「把我们甩了我们自己干更划算」（过剩 > 0），
 *   Shapley 分账对这种异议不设防；
 * - 「大家都别抱怨」需要的是另一条口径：让**抱怨最大的联盟先被安抚**，
 *   安抚完最大的再安抚次大的，直到无联盟可安抚——这正是核仁
 *   （nucleolus）的字典序定义；核（core）非空时核仁必在核内，核空时
 *   核仁仍存在且唯一（它退居最小核），是合作博弈里**永不失效**的
 *   稳定分配——比核更稳健（核可为空）、比 Shapley 更抗异议；
 * - 逐级 LP 在浮点下做字典序比较会被舍入尘埃污染（两个本应相等的
 *   过剩差出 1e-16，字典序就断在错误的位置）——本内核全部用
 *   文件内自实现的精确有理数算术（Fraction，BigInt 分子分母 + gcd
 *   约分）+ 手写两阶段精确单纯形，**零浮点误差**，同输入同输出。
 *
 * 数学：
 * 1. 合作博弈 (N, v)：N = {0..n−1}，特征函数 v: 2^N → Q（v(∅) = 0），
 *    联盟用位掩码表示。分配 x 的**过剩**（excess，抱怨度）：
 *      e(S, x) = v(S) − Σ_{i∈S} x_i
 *    e > 0：联盟 S 单干比接受 x 更好——S 是一个活着的异议。
 * 2. 核仁（Schmeidler 1969）：在转归（imputation：Σx_i = v(N) 且
 *    x_i ≥ v({i})）中，把 2^n−2 个过剩降序排列成向量 θ(x)，
 *    取 θ(x) 字典序最小者。核仁**存在且唯一**（Schmeidler 定理），
 *    且总落在最小核里；核非空时核仁 ∈ 核（一切过剩 ≤ 0，无异议）。
 *    （转归集为空的一般博弈退化为预核仁 pre-nucleolus——效率约束下
 *    同一字典序程序，本内核实现的正是它；转归集非空时两者重合。）
 * 3. 逐级 LP（Kohlberg / Kopelowitz / Maschler–Peleg 程序）：
 *    第 1 级 = 最小核：min ε s.t. Σ_{i∈S} x_i + ε ≥ v(S)（∀S ⊆ N，
 *    S ≠ ∅, N），Σ x_i = v(N)——最优值 ε₁ = 可实现的最小最大过剩；
 *    ε₁ ≤ 0 ⟺ 核非空。把「在**每个**最优点上都紧」（e(S,x) = ε₁ 恒
 *    成立）的联盟集 E₁ 固定为等式，对剩余联盟解第 2 级 LP 得 ε₂ < ε₁，
 *    如此迭代——每级至少定居一个联盟，有限级终止；终止点即核仁。
 *    「在每个最优点上都紧」用探针 LP 判定：在最优面 {e(T,x) ≤ ε_k,
 *    已定居等式} 上 max Σ_{i∈S} x_i 是否恰为 v(S) − ε_k（不能再松 ⟺
 *    处处紧）。
 * 4. 单纯形采用标准形两阶段法（Phase-1 人工变量判可行性，Phase-2
 *    原目标）+ Bland 最小下标规则（防退化循环，精确算术下有限终止），
 *    变量自由时拆 x = x⁺ − x⁻。全部枢轴运算在 Fraction 上进行。
 *
 * 验证锚点（scripts/verify-game-kernels.mjs）：
 *   ① 手套博弈（2 左 1 右）：核仁 = (0, 0, 1) 精确一致（文献已知解：
 *      稀缺的右手套持有者拿走全部剩余）；
 *   ② 三人简单多数博弈（权重 51/50/50、配额 100——每两人获胜）：
 *      核仁 = (1/3, 1/3, 1/3) 对称解，且逐级 ε₁ = 1/3（三对联盟定居）、
 *      ε₂ = −1/3（三单例定居）逐轮精确；
 *   ③ 大联盟效率：Σ Nu_i = v(N) 精确（Fraction 相等，非容差）；
 *   ④ 核非空（手套博弈）⟹ 核仁 ∈ 核：一切联盟过剩 ≤ 0 精确成立；
 *   ⑤ 核空实例（三人多数博弈）：最小核 ε₁ = 1/3 > 0 诚实报告
 *      （coreNonempty = false，不假装稳定）；
 *   ⑥ 与 Shapley 对照：手套博弈核仁 (0,0,1) ≠ Shapley (1/6, 1/6, 2/3)
 *      ——分配不同但都精确满足效率（Shapley 管平均公平，核仁管最坏
 *      联盟异议，双口径互补）；对称多数博弈两解概念重合于 (1/3,1/3,1/3)。
 *   另有 Fraction / solveLP 单元锚点（精确有理数四则与规范化、LP 最优 /
 *      不可行 / 无界三分、分数顶点最优值）。
 *
 * ── R5-A13 世界性进化（第五轮）：可解性加速（nucleolusFast）──
 *
 * A. **加性博弈短路（零 LP）**: v 可加（v(S) = Σ_{i∈S} v({i})）⟹ 取
 *    x_i = v({i})：互补联盟对满足 e(S)+e(N∖S) = v(S)+v(N∖S)−v(N) = 0
 *    （可加性），故任一效率分配的 θ 首分量 ≥ 0；而 x=v(·) 处**全部**
 *    过剩恰为 0 → θ = (0,…,0) 字典序最小——核仁一步读出，定居集 =
 *    全部真联盟（第 1 级全紧），逐级记录与逐级 LP 完全一致但零次求解。
 *
 * B. **对称玩家塌缩（LP 变量与约束双双收缩）**: i∼j ⟺ ∀S⊆N∖{i,j}:
 *    v(S∪{i}) = v(S∪{j})（精确 Fraction 相等；传递性成立，换位 (ij) 保 v）。
 *    核仁在保持 v 的置换群下不变（Schmeidler 唯一性 ⟹ 同类玩家同所得），
 *    群轨道 = 「类计数向量」——把约束按计数签名去重、变量塌缩为每类
 *    一个代表 a_c（效率行 = 类大小），逐级程序在塌缩 LP 上跑出**完全
 *    相同**的 ε 序列与定居集（最优面在群作用下不变，探针极大值可在
 *    对称子空间取到），x_i = a_{c(i)} 展开。全对称 n 玩家博弈的约束数
 *    2ⁿ−2 → n−1（例如 n=8：254 → 7）。
 *
 * C. **批量探针（已满足约束的一揽子定居）**: 第 k 级候选集 G 中每条
 *    e(S,x) ≤ ε_k（面约束），若单次 LP 最大化 Σ_{S∈G} e(S) 恰达
 *    |G|·ε_k，则**每条** S 在整个最优面上紧（各项均被 ε_k 封顶，和达
 *    上界 ⟹ 逐项达上界）——一揽子定居，|G| 次探针 → 1 次。对称博弈的
 *    成批候选（如三人多数的第 1 级三对联盟）正中此靶。批量失败则逐条
 *    回退，结果与逐条口径逐位一致。
 *
 * 三条加速均不改变 NucleolusResult 的任何数学字段（x / rounds /
 * complaints 精确相等），只减少 lpSolves 与 pivots——nucleolus() 本体
 * 逐位不动（零漂移），加速入口为新增 nucleolusFast()。
 *
 * 应用：共生经济分红——能量账本（src/symbiosis/ledger.ts）与知识售后
 * 分成（src/symbiosis/market.ts 的 royaltyRate）的「抱怨字典序最小化」
 * 口径：Shapley 16.0 管平均公平，核仁管最坏联盟异议——双口径并陈给
 * 决策引擎，分红方案第一次同时携带「平均公平」与「无可异议」两种保证。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入
 */

// ─────────────────────────── 精确有理数 ───────────────────────────

/**
 * 精确有理数：分子/分母恒为互素整数，分母恒正。
 * 全部运算返回新对象（不可变），加减乘除经 gcd 约分，无浮点误差。
 */
export class Fraction {
  static readonly ZERO: Fraction = new Fraction(0n, 1n);
  static readonly ONE: Fraction = new Fraction(1n, 1n);

  readonly num: bigint;
  readonly den: bigint;

  constructor(num: bigint, den: bigint = 1n) {
    if (den === 0n) throw new Error('Fraction: 分母不能为零');
    let n = num;
    let d = den;
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = bigGcd(n, d);
    if (g > 1n) {
      n /= g;
      d /= g;
    }
    this.num = n;
    this.den = d;
  }

  /** 精确转换：bigint 直取；Fraction 原样；double 按 IEEE-754 二进有理数
   *  精确有理化（0.5 → 1/2 精确；0.1 → 其二进制真值，不冒充 1/10）。 */
  static of(value: number | bigint | Fraction): Fraction {
    if (value instanceof Fraction) return value;
    if (typeof value === 'bigint') return new Fraction(value);
    return fractionFromDouble(value);
  }

  add(other: Fraction): Fraction {
    return new Fraction(this.num * other.den + other.num * this.den, this.den * other.den);
  }
  sub(other: Fraction): Fraction {
    return new Fraction(this.num * other.den - other.num * this.den, this.den * other.den);
  }
  mul(other: Fraction): Fraction {
    return new Fraction(this.num * other.num, this.den * other.den);
  }
  div(other: Fraction): Fraction {
    if (other.num === 0n) throw new Error('Fraction: 除以零');
    return new Fraction(this.num * other.den, this.den * other.num);
  }
  neg(): Fraction {
    return new Fraction(-this.num, this.den);
  }
  abs(): Fraction {
    return this.num < 0n ? this.neg() : this;
  }
  cmp(other: Fraction): number {
    const l = this.num * other.den;
    const r = other.num * this.den;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  eq(other: Fraction): boolean {
    return this.num === other.num && this.den === other.den;
  }
  isZero(): boolean {
    return this.num === 0n;
  }
  isNegative(): boolean {
    return this.num < 0n;
  }
  isPositive(): boolean {
    return this.num > 0n;
  }
  isInteger(): boolean {
    return this.den === 1n;
  }
  toNumber(): number {
    return Number(this.num) / Number(this.den);
  }
  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }
}

/** 便捷构造：frac(1, 3) → 1/3；数值入参必须是整数（非整数请用 Fraction.of） */
export function frac(numerator: bigint | number, denominator: bigint | number = 1): Fraction {
  return new Fraction(toBigIntStrict(numerator), toBigIntStrict(denominator));
}

function toBigIntStrict(x: bigint | number): bigint {
  if (typeof x === 'bigint') return x;
  if (!Number.isInteger(x)) {
    throw new Error(`frac: 数值入参必须是整数（收到 ${x}）；非整数 double 请用 Fraction.of 做精确二进制有理化`);
  }
  return BigInt(x);
}

function bigAbs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function bigGcd(a: bigint, b: bigint): bigint {
  let x = bigAbs(a);
  let y = bigAbs(b);
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** double → 精确有理数：按 IEEE-754 位级分解（每个有限 double 都是 p·2^e） */
function fractionFromDouble(x: number): Fraction {
  if (!Number.isFinite(x)) throw new Error(`Fraction.of: 入参必须是有限数（收到 ${x}）`);
  if (x === 0) return Fraction.ZERO;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const sign = (bits >> 63n) === 1n ? -1n : 1n;
  const rawExponent = (bits >> 52n) & 0x7ffn;
  const mantissa = bits & 0xfffffffffffffn;
  if (rawExponent === 0n) {
    // 次正规数：±mantissa·2^(−1074)
    return new Fraction(sign * mantissa, 1n << 1074n);
  }
  const exponent = rawExponent - 1023n - 52n;
  const significand = mantissa | (1n << 52n);
  if (exponent >= 0n) return new Fraction(sign * significand * (1n << exponent), 1n);
  return new Fraction(sign * significand, 1n << -exponent);
}

// ─────────────────────────── 精确单纯形 ───────────────────────────

export type ConstraintSense = '=' | '>=' | '<=';

/** 线性规划（最小化）：min c·x s.t. A x {=,≥,≤} b，x ∈ R^n（自由变量） */
export interface LPProblem {
  readonly objective: ReadonlyArray<Fraction>;
  readonly matrix: ReadonlyArray<ReadonlyArray<Fraction>>;
  readonly rhs: ReadonlyArray<Fraction>;
  readonly senses: ReadonlyArray<ConstraintSense>;
}

export interface LPSolution {
  readonly status: 'optimal' | 'infeasible' | 'unbounded';
  /** 最优目标值（非 optimal 时为 0） */
  readonly objective: Fraction;
  /** 最优解（非 optimal 时为空数组） */
  readonly x: ReadonlyArray<Fraction>;
  readonly pivots: number;
  readonly phaseOnePivots: number;
}

/**
 * 精确两阶段单纯形表（Fraction 枢轴，Bland 最小下标规则防循环）。
 * 表布局：列 = [变量（含拆分与松弛）…, 人工变量…, RHS]。
 */
class SimplexTableau {
  readonly width: number;
  rows: Fraction[][];
  basis: number[];
  objRow: Fraction[];
  pivots = 0;

  constructor(rows: Fraction[][], basis: number[], objRow: Fraction[]) {
    this.rows = rows;
    this.basis = basis;
    this.objRow = objRow;
    this.width = rows.length > 0 ? rows[0].length : objRow.length;
  }

  pivot(rowIdx: number, colIdx: number): void {
    const pivotRow = this.rows[rowIdx];
    const head = pivotRow[colIdx];
    for (let j = 0; j < this.width; j += 1) pivotRow[j] = pivotRow[j].div(head);
    for (let r = 0; r < this.rows.length; r += 1) {
      if (r === rowIdx) continue;
      const factor = this.rows[r][colIdx];
      if (factor.isZero()) continue;
      const row = this.rows[r];
      for (let j = 0; j < this.width; j += 1) row[j] = row[j].sub(factor.mul(pivotRow[j]));
    }
    const objFactor = this.objRow[colIdx];
    if (!objFactor.isZero()) {
      for (let j = 0; j < this.width; j += 1) this.objRow[j] = this.objRow[j].sub(objFactor.mul(pivotRow[j]));
    }
    this.basis[rowIdx] = colIdx;
    this.pivots += 1;
  }

  removeRow(rowIdx: number): void {
    this.rows.splice(rowIdx, 1);
    this.basis.splice(rowIdx, 1);
  }

  /** Bland 规则迭代至最优；进入列 = 检验数为负的最小下标，离开行 = 最小
   *  比率（平局取基变量下标最小者）——精确算术下保证有限终止。 */
  run(allowed: ReadonlyArray<boolean>): 'optimal' | 'unbounded' {
    for (;;) {
      let enter = -1;
      for (let j = 0; j < this.width - 1; j += 1) {
        if (!allowed[j]) continue;
        if (this.objRow[j].isNegative()) {
          enter = j;
          break;
        }
      }
      if (enter < 0) return 'optimal';
      let leave = -1;
      let bestRatio: Fraction | null = null;
      for (let r = 0; r < this.rows.length; r += 1) {
        const element = this.rows[r][enter];
        if (!element.isPositive()) continue;
        const ratio = this.rows[r][this.width - 1].div(element);
        if (
          bestRatio === null ||
          ratio.cmp(bestRatio) < 0 ||
          (ratio.cmp(bestRatio) === 0 && this.basis[r] < this.basis[leave])
        ) {
          bestRatio = ratio;
          leave = r;
        }
      }
      if (leave < 0) return 'unbounded';
      this.pivot(leave, enter);
    }
  }

  columnValue(col: number): Fraction {
    for (let r = 0; r < this.rows.length; r += 1) {
      if (this.basis[r] === col) return this.rows[r][this.width - 1];
    }
    return Fraction.ZERO;
  }
}

/**
 * 精确 LP 求解器：min c·x s.t. 约束组（x 自由）。
 * 自由变量拆 x⁺ − x⁻；不等式加松弛；Phase-1 人工变量判可行性并驱逐
 * 冗余行；Phase-2 原目标。全部 Fraction 运算——解是精确有理数。
 */
export function solveLP(problem: LPProblem): LPSolution {
  const nVars = problem.objective.length;
  const nRows = problem.matrix.length;
  if (nVars < 1) throw new Error('solveLP: 至少需要一个决策变量');
  if (problem.rhs.length !== nRows || problem.senses.length !== nRows) {
    throw new Error(`solveLP: rhs(${problem.rhs.length})/senses(${problem.senses.length}) 长度必须等于约束行数 ${nRows}`);
  }
  for (let r = 0; r < nRows; r += 1) {
    if (problem.matrix[r].length !== nVars) {
      throw new Error(`solveLP: 第 ${r} 行系数长度 ${problem.matrix[r].length} ≠ 变量数 ${nVars}`);
    }
    const sense = problem.senses[r];
    if (sense !== '=' && sense !== '>=' && sense !== '<=') {
      throw new Error(`solveLP: 未知约束方向 "${String(sense)}"`);
    }
  }

  const slackCount = problem.senses.filter((s) => s !== '=').length;
  const splitCount = 2 * nVars;
  const artificialStart = splitCount + slackCount;
  const totalVars = artificialStart + nRows;
  const width = totalVars + 1;

  const rows: Fraction[][] = [];
  const basis: number[] = [];
  let slackCursor = 0;
  for (let r = 0; r < nRows; r += 1) {
    const row: Fraction[] = Array.from({ length: width }, () => Fraction.ZERO);
    for (let j = 0; j < nVars; j += 1) {
      row[j] = problem.matrix[r][j];
      row[nVars + j] = problem.matrix[r][j].neg();
    }
    if (problem.senses[r] === '<=') {
      row[splitCount + slackCursor] = Fraction.ONE;
      slackCursor += 1;
    } else if (problem.senses[r] === '>=') {
      row[splitCount + slackCursor] = Fraction.ONE.neg();
      slackCursor += 1;
    }
    let rhs = problem.rhs[r];
    if (rhs.isNegative()) {
      for (let j = 0; j < width; j += 1) row[j] = row[j].neg();
      rhs = rhs.neg();
    }
    row[width - 1] = rhs;
    row[artificialStart + r] = Fraction.ONE;
    rows.push(row);
    basis.push(artificialStart + r);
  }

  // Phase 1：min Σ 人工变量（初始基全为人工变量 → 目标行 = c − Σ 行）
  const objOne: Fraction[] = Array.from({ length: width }, () => Fraction.ZERO);
  for (let j = artificialStart; j < totalVars; j += 1) objOne[j] = Fraction.ONE;
  for (const row of rows) {
    for (let j = 0; j < width; j += 1) objOne[j] = objOne[j].sub(row[j]);
  }
  const tableau = new SimplexTableau(rows, basis, objOne);
  const allowedAll = Array.from({ length: totalVars }, () => true);
  if (tableau.run(allowedAll) !== 'optimal') {
    throw new Error('solveLP: Phase-1 出现无界（内部错误——Phase-1 目标恒 ≥ 0）');
  }
  const phaseOnePivots = tableau.pivots;

  let infeasibility = Fraction.ZERO;
  for (let r = 0; r < tableau.rows.length; r += 1) {
    if (tableau.basis[r] >= artificialStart) infeasibility = infeasibility.add(tableau.rows[r][width - 1]);
  }
  if (infeasibility.isPositive()) {
    return { status: 'infeasible', objective: Fraction.ZERO, x: [], pivots: tableau.pivots, phaseOnePivots };
  }

  // 驱逐人工变量：基中人工变量行枢轴换出；整行系数全零 → 冗余行删除
  for (let r = tableau.rows.length - 1; r >= 0; r -= 1) {
    if (tableau.basis[r] < artificialStart) continue;
    let pivotCol = -1;
    for (let j = 0; j < artificialStart; j += 1) {
      if (!tableau.rows[r][j].isZero()) {
        pivotCol = j;
        break;
      }
    }
    if (pivotCol >= 0) tableau.pivot(r, pivotCol);
    else tableau.removeRow(r);
  }

  // Phase 2：min c·x（先快照各基列成本再消元）
  const objTwo: Fraction[] = Array.from({ length: width }, () => Fraction.ZERO);
  for (let j = 0; j < nVars; j += 1) {
    objTwo[j] = problem.objective[j];
    objTwo[nVars + j] = problem.objective[j].neg();
  }
  const basisCosts = tableau.basis.map((col) => objTwo[col]);
  for (let r = 0; r < tableau.rows.length; r += 1) {
    const cost = basisCosts[r];
    if (cost.isZero()) continue;
    for (let j = 0; j < width; j += 1) objTwo[j] = objTwo[j].sub(cost.mul(tableau.rows[r][j]));
  }
  tableau.objRow = objTwo;
  const allowedReal: boolean[] = [];
  for (let j = 0; j < totalVars; j += 1) allowedReal.push(j < artificialStart);
  if (tableau.run(allowedReal) === 'unbounded') {
    return { status: 'unbounded', objective: Fraction.ZERO, x: [], pivots: tableau.pivots, phaseOnePivots };
  }

  const x: Fraction[] = [];
  for (let j = 0; j < nVars; j += 1) x.push(tableau.columnValue(j).sub(tableau.columnValue(nVars + j)));
  let objective = Fraction.ZERO;
  for (let j = 0; j < nVars; j += 1) objective = objective.add(problem.objective[j].mul(x[j]));
  return { status: 'optimal', objective, x, pivots: tableau.pivots, phaseOnePivots };
}

// ─────────────────────────── 合作博弈表示 ───────────────────────────

/** 联盟价值：整数、BigInt 或 Fraction（double 经 Fraction.of 精确二进制有理化） */
export type CoalitionValue = number | bigint | Fraction;

/** 精确算术下允许的玩家数上限（2^n−2 条联盟约束逐级进 LP；n = 8 已是重负载） */
export const MAX_EXACT_PLAYERS = 8;

/** 合作博弈 (N, v)：values[位掩码] = v(S)，values[0] = v(∅) = 0 */
export interface CooperativeGame {
  readonly n: number;
  readonly values: ReadonlyArray<Fraction>;
}

/** 由完整 2^n 联盟值表构造（下标 = 玩家位掩码，玩家 i 对应比特 i） */
export function makeGame(n: number, values: ReadonlyArray<CoalitionValue>): CooperativeGame {
  if (!Number.isInteger(n) || n < 1 || n > MAX_EXACT_PLAYERS) {
    throw new Error(`makeGame: 玩家数必须是 [1, ${MAX_EXACT_PLAYERS}] 的整数（收到 ${n}——精确核仁的联盟约束数为 2^n−2）`);
  }
  const size = 1 << n;
  if (values.length !== size) {
    throw new Error(`makeGame: 联盟值表长度必须恰为 2^n = ${size}（收到 ${values.length}）`);
  }
  const converted = values.map((v) => Fraction.of(v));
  if (!converted[0].isZero()) {
    throw new Error(`makeGame: v(∅) 必须为 0（收到 ${converted[0].toString()}——空联盟不创造价值是特征函数的公理）`);
  }
  return { n, values: converted };
}

/** 由「掩码 → 值」稀疏对构造（缺省联盟价值 0；自动满足 v(∅) = 0） */
export function makeGameFromPairs(
  n: number,
  entries: ReadonlyArray<{ readonly mask: number; readonly value: CoalitionValue }>,
): CooperativeGame {
  const size = n > 0 && Number.isInteger(n) && n <= MAX_EXACT_PLAYERS ? 1 << n : -1;
  if (size < 0) {
    throw new Error(`makeGameFromPairs: 玩家数必须是 [1, ${MAX_EXACT_PLAYERS}] 的整数（收到 ${n}）`);
  }
  const zeros: CoalitionValue[] = Array.from({ length: size }, () => 0);
  for (const entry of entries) {
    if (!Number.isInteger(entry.mask) || entry.mask < 1 || entry.mask >= size) {
      throw new Error(`makeGameFromPairs: 掩码必须是 [1, ${size - 1}] 的整数（收到 ${entry.mask}）`);
    }
    zeros[entry.mask] = entry.value;
  }
  return makeGame(n, zeros);
}

/** 玩家集合 → 位掩码 */
export function coalitionMask(playerIndices: ReadonlyArray<number>): number {
  let mask = 0;
  for (const i of playerIndices) {
    if (!Number.isInteger(i) || i < 0 || i > 30) {
      throw new Error(`coalitionMask: 玩家下标必须是 [0, 30] 的整数（收到 ${i}）`);
    }
    mask |= 1 << i;
  }
  return mask;
}

/** 位掩码 → 玩家下标列表（升序） */
export function coalitionMembers(mask: number): number[] {
  if (!Number.isInteger(mask) || mask < 0) throw new Error(`coalitionMembers: 掩码必须是非负整数（收到 ${mask}）`);
  const members: number[] = [];
  let rest = mask;
  let i = 0;
  while (rest) {
    if (rest & 1) members.push(i);
    rest >>>= 1;
    i += 1;
  }
  return members;
}

function popcount(x: number): number {
  let count = 0;
  let v = x;
  while (v) {
    v &= v - 1;
    count += 1;
  }
  return count;
}

function factorialsUpTo(n: number): bigint[] {
  const f: bigint[] = [1n];
  for (let i = 1; i <= n; i += 1) f.push(f[i - 1] * BigInt(i));
  return f;
}

// ─────────────────────────── 过剩 / 转归 / 核 ───────────────────────────

function requireAlloc(game: CooperativeGame, x: ReadonlyArray<Fraction>): void {
  if (x.length !== game.n) {
    throw new Error(`分配向量长度必须等于玩家数 ${game.n}（收到 ${x.length}）`);
  }
}

/** 联盟过剩（抱怨度）e(S, x) = v(S) − Σ_{i∈S} x_i */
export function excess(game: CooperativeGame, mask: number, x: ReadonlyArray<Fraction>): Fraction {
  const size = 1 << game.n;
  if (!Number.isInteger(mask) || mask < 0 || mask >= size) {
    throw new Error(`excess: 掩码必须是 [0, ${size - 1}] 的整数（收到 ${mask}）`);
  }
  requireAlloc(game, x);
  let sum = Fraction.ZERO;
  for (const i of coalitionMembers(mask)) sum = sum.add(x[i]);
  return game.values[mask].sub(sum);
}

export interface CoalitionExcess {
  readonly mask: number;
  readonly size: number;
  readonly excess: Fraction;
}

/** 全联盟过剩向量（降序；平局取小掩码在前——确定性） */
export function excessVector(game: CooperativeGame, x: ReadonlyArray<Fraction>): CoalitionExcess[] {
  requireAlloc(game, x);
  const full = (1 << game.n) - 1;
  const list: CoalitionExcess[] = [];
  for (let mask = 1; mask < full; mask += 1) {
    list.push({ mask, size: popcount(mask), excess: excess(game, mask, x) });
  }
  list.sort((a, b) => (a.excess.cmp(b.excess) !== 0 ? b.excess.cmp(a.excess) : a.mask - b.mask));
  return list;
}

/** 转归判定：效率 Σx_i = v(N) 且个体理性 x_i ≥ v({i})（全部精确比较） */
export function isImputation(game: CooperativeGame, x: ReadonlyArray<Fraction>): boolean {
  requireAlloc(game, x);
  let sum = Fraction.ZERO;
  for (const xi of x) sum = sum.add(xi);
  if (!sum.eq(game.values[(1 << game.n) - 1])) return false;
  for (let i = 0; i < game.n; i += 1) {
    if (x[i].cmp(game.values[1 << i]) < 0) return false;
  }
  return true;
}

/** 核成员判定：效率成立且一切非空真联盟过剩 ≤ 0（无可异议） */
export function inCore(game: CooperativeGame, x: ReadonlyArray<Fraction>): boolean {
  requireAlloc(game, x);
  let sum = Fraction.ZERO;
  for (const xi of x) sum = sum.add(xi);
  if (!sum.eq(game.values[(1 << game.n) - 1])) return false;
  const full = (1 << game.n) - 1;
  for (let mask = 1; mask < full; mask += 1) {
    if (excess(game, mask, x).isPositive()) return false;
  }
  return true;
}

// ─────────────────────────── 最小核 / 逐级 LP ───────────────────────────

function properMasks(n: number): number[] {
  const full = (1 << n) - 1;
  const masks: number[] = [];
  for (let mask = 1; mask < full; mask += 1) masks.push(mask);
  return masks;
}

/** 第 k 级 LP：min ε s.t. 效率 + 已定居等式（e(S,x) = ε_j）+ 剩余联盟 Σ+ε ≥ v(S) */
function buildStageLP(
  game: CooperativeGame,
  fixed: ReadonlyMap<number, Fraction>,
  remaining: readonly number[],
): LPProblem {
  const n = game.n;
  const cols = n + 1; // [x_0..x_{n-1}, ε]
  const matrix: Fraction[][] = [];
  const rhs: Fraction[] = [];
  const senses: ConstraintSense[] = [];

  const eff = Array.from({ length: cols }, () => Fraction.ONE);
  eff[n] = Fraction.ZERO;
  matrix.push(eff);
  rhs.push(game.values[(1 << n) - 1]);
  senses.push('=');

  for (const [mask, eps] of fixed) {
    const row = Array.from({ length: cols }, () => Fraction.ZERO);
    for (const i of coalitionMembers(mask)) row[i] = Fraction.ONE;
    matrix.push(row);
    rhs.push(game.values[mask].sub(eps));
    senses.push('=');
  }

  for (const mask of remaining) {
    const row = Array.from({ length: cols }, () => Fraction.ZERO);
    for (const i of coalitionMembers(mask)) row[i] = Fraction.ONE;
    row[n] = Fraction.ONE;
    matrix.push(row);
    rhs.push(game.values[mask]);
    senses.push('>=');
  }

  const objective = Array.from({ length: cols }, () => Fraction.ZERO);
  objective[n] = Fraction.ONE;
  return { objective, matrix, rhs, senses };
}

/** 探针 LP：最优面 {效率 + 已定居等式 + 剩余 e(T,x) ≤ ε_k} 上 max Σ_{i∈S} x_i
 *  （以最小化负和实现；返回值取负即为最大值）。 */
function buildProbeLP(
  game: CooperativeGame,
  fixed: ReadonlyMap<number, Fraction>,
  remaining: readonly number[],
  epsilon: Fraction,
  probeMask: number,
): LPProblem {
  const n = game.n;
  const matrix: Fraction[][] = [];
  const rhs: Fraction[] = [];
  const senses: ConstraintSense[] = [];

  const eff = Array.from({ length: n }, () => Fraction.ONE);
  matrix.push(eff);
  rhs.push(game.values[(1 << n) - 1]);
  senses.push('=');

  for (const [mask, eps] of fixed) {
    const row = Array.from({ length: n }, () => Fraction.ZERO);
    for (const i of coalitionMembers(mask)) row[i] = Fraction.ONE;
    matrix.push(row);
    rhs.push(game.values[mask].sub(eps));
    senses.push('=');
  }

  for (const mask of remaining) {
    const row = Array.from({ length: n }, () => Fraction.ZERO);
    for (const i of coalitionMembers(mask)) row[i] = Fraction.ONE;
    matrix.push(row);
    rhs.push(game.values[mask].sub(epsilon));
    senses.push('>=');
  }

  const objective = Array.from({ length: n }, () => Fraction.ZERO);
  for (const i of coalitionMembers(probeMask)) objective[i] = Fraction.ONE.neg();
  return { objective, matrix, rhs, senses };
}

/** 最小核：min ε s.t. Σ_{i∈S} x_i + ε ≥ v(S)（∀ 非空真联盟），Σ x_i = v(N) */
export interface LeastCoreResult {
  readonly x: ReadonlyArray<Fraction>;
  readonly epsilon: Fraction;
  readonly pivots: number;
}

export function leastCore(game: CooperativeGame): LeastCoreResult {
  if (game.n === 1) {
    // 单人博弈无联盟可抱怨：唯一效率分配即 v(N)，ε 无约束 → 约定为 0
    return { x: [game.values[1]], epsilon: Fraction.ZERO, pivots: 0 };
  }
  const solution = solveLP(buildStageLP(game, new Map(), properMasks(game.n)));
  if (solution.status !== 'optimal') {
    throw new Error(`leastCore: 最小核 LP 竟然 ${solution.status}（内部错误——互补联盟对保证该 LP 恒可行有界）`);
  }
  return { x: solution.x.slice(0, game.n), epsilon: solution.objective, pivots: solution.pivots };
}

/** 核可检测报告：ε* ≤ 0 ⟺ 核非空（此时见证点 x 就在核内） */
export interface CoreStatus {
  readonly nonempty: boolean;
  readonly leastCoreEpsilon: Fraction;
  readonly witness: ReadonlyArray<Fraction> | null;
}

export function core(game: CooperativeGame): CoreStatus {
  const lc = leastCore(game);
  return {
    nonempty: !lc.epsilon.isPositive(),
    leastCoreEpsilon: lc.epsilon,
    witness: lc.epsilon.isPositive() ? null : lc.x,
  };
}

// ─────────────────────────── 核仁 ───────────────────────────

export interface NucleolusRound {
  /** 级号（1 起） */
  readonly round: number;
  /** 本级最小化的最大过剩 ε_k（逐级严格递减） */
  readonly epsilon: Fraction;
  /** 本级定居（在每个最优点上都紧 → 固定为等式）的联盟掩码（升序） */
  readonly settled: readonly number[];
}

export interface NucleolusResult {
  /** 核仁分配（精确有理数向量；Schmeidler 定理保证唯一） */
  readonly x: ReadonlyArray<Fraction>;
  /** 逐级记录（ε₁ = 最小核值；每级至少定居一个联盟） */
  readonly rounds: readonly NucleolusRound[];
  readonly leastCoreEpsilon: Fraction;
  /** 核仁处最大联盟过剩（= ε₁；≤ 0 ⟺ 核仁在核内） */
  readonly maxExcess: Fraction;
  readonly coreNonempty: boolean;
  readonly inCore: boolean;
  readonly isImputation: boolean;
  /** 精确 Shapley 对照（16.0 的分数版——双口径并陈） */
  readonly shapley: ReadonlyArray<Fraction>;
  /** 全联盟过剩（降序）——「谁还在抱怨、抱怨多大」的完整名单 */
  readonly complaints: readonly CoalitionExcess[];
  readonly lpSolves: number;
  readonly pivots: number;
  /** 逐级程序是否把全部联盟安居（理论上恒真；false = 防御性诚实退出） */
  readonly converged: boolean;
}

/**
 * 核仁（Schmeidler 1969）：过剩向量的字典序最小者。
 *
 * 逐级 LP 程序（Kopelowitz / Maschler–Peleg）：
 *   第 k 级解 min ε_k（固定前级等式），候选 = 在该级最优点 x* 处过剩恰为
 *   ε_k 的联盟；对每个候选跑探针 LP 判定其是否「在整个最优面上都紧」——
 *   是则定居为等式；至少一个联盟每级定居，有限级后一切联盟安居，
 *   剩余等式组把 x 钉到唯一一点：核仁。
 */
export function nucleolus(game: CooperativeGame): NucleolusResult {
  const n = game.n;
  if (n === 1) {
    const only = game.values[1];
    return {
      x: [only],
      rounds: [],
      leastCoreEpsilon: Fraction.ZERO,
      maxExcess: Fraction.ZERO,
      coreNonempty: true,
      inCore: true,
      isImputation: true,
      shapley: [only],
      complaints: [],
      lpSolves: 0,
      pivots: 0,
      converged: true,
    };
  }

  const allMasks = properMasks(n);
  let remaining = [...allMasks];
  const fixed = new Map<number, Fraction>();
  const rounds: NucleolusRound[] = [];
  let x: Fraction[] = [];
  let leastCoreEpsilon = Fraction.ZERO;
  let lpSolves = 0;
  let pivots = 0;
  let converged = false;

  while (remaining.length > 0) {
    if (rounds.length > allMasks.length) break; // 防御：每级至少定居一个联盟，级数 ≤ 联盟数

    const stage = solveLP(buildStageLP(game, fixed, remaining));
    lpSolves += 1;
    if (stage.status !== 'optimal') {
      throw new Error(`nucleolus: 第 ${rounds.length + 1} 级 LP 竟然 ${stage.status}（内部错误——互补联盟对保证有界）`);
    }
    pivots += stage.pivots;
    const epsilon = stage.objective;
    x = stage.x.slice(0, n);
    if (rounds.length === 0) leastCoreEpsilon = epsilon;

    // 候选：在 x* 处过剩恰为 ε 的剩余联盟
    const candidates = remaining.filter((mask) => excess(game, mask, x).cmp(epsilon) === 0);
    const settled: number[] = [];
    for (const mask of candidates) {
      // 探针：最优面上 max Σ_{i∈S} x_i 恰为 v(S) − ε ⟺ 该联盟处处紧（定居）
      const probe = solveLP(buildProbeLP(game, fixed, remaining, epsilon, mask));
      lpSolves += 1;
      if (probe.status !== 'optimal') continue; // 无界 ⟺ 还能更松 → 不定居
      pivots += probe.pivots;
      if (probe.objective.neg().cmp(game.values[mask].sub(epsilon)) === 0) settled.push(mask);
    }

    rounds.push({ round: rounds.length + 1, epsilon, settled });
    for (const mask of settled) fixed.set(mask, epsilon);
    remaining = remaining.filter((mask) => !fixed.has(mask));
    if (settled.length === 0) break; // 理论上不可能（至少 ε 的达成联盟处处紧）；防御性诚实退出
    if (remaining.length === 0) converged = true;
  }

  const shapley = shapleyExact(game);
  return {
    x,
    rounds,
    leastCoreEpsilon,
    maxExcess: leastCoreEpsilon,
    coreNonempty: !leastCoreEpsilon.isPositive(),
    inCore: inCore(game, x),
    isImputation: isImputation(game, x),
    shapley,
    complaints: excessVector(game, x),
    lpSolves,
    pivots,
    converged,
  };
}

/**
 * 精确 Shapley 值（对照口径；16.0 shapley.ts 的全枚举分支之分数版）：
 * φ_i = Σ_{S ⊆ N∖{i}} |S|!(n−|S|−1)!/n! · [v(S∪{i}) − v(S)]
 * 权重与边际全部在 Fraction 上运算——效率 Σφ_i = v(N) 精确成立。
 */
export function shapleyExact(game: CooperativeGame): ReadonlyArray<Fraction> {
  const n = game.n;
  const size = 1 << n;
  const fact = factorialsUpTo(n);
  const phi: Fraction[] = Array.from({ length: n }, () => Fraction.ZERO);
  for (let i = 0; i < n; i += 1) {
    const bit = 1 << i;
    let acc = Fraction.ZERO;
    for (let mask = 0; mask < size; mask += 1) {
      if (mask & bit) continue;
      const s = popcount(mask);
      const weight = new Fraction(fact[s] * fact[n - s - 1], fact[n]);
      acc = acc.add(weight.mul(game.values[mask | bit].sub(game.values[mask])));
    }
    phi[i] = acc;
  }
  return phi;
}

/* ════════════════════ R5-A13：可解性加速（nucleolusFast）════════════════════
 *
 * 三条定理级加速（加性短路 / 对称塌缩 / 批量探针），入口 nucleolusFast()：
 * 输出的全部数学字段与 nucleolus() 精确一致（Fraction 相等），仅
 * lpSolves / pivots 下降。nucleolus() 本体逐位不动。
 */

/** 塌缩约束：Σ_c counts_c · a_c + ε ≥ value（计数签名 = 类计数向量） */
interface StageConstraint {
  readonly coeffs: ReadonlyArray<Fraction>;
  readonly value: Fraction;
}

/** 逐级程序作用的抽象约束系统（塌缩前/后共用同一引擎） */
interface StageSystem {
  /** 决策变量数（塌缩后 = 对称类数） */
  readonly nVars: number;
  /** 效率行系数（塌缩后 = 类大小） */
  readonly efficiency: ReadonlyArray<Fraction>;
  readonly grandValue: Fraction;
  /** 约束列表（确定性顺序：首现序） */
  readonly constraints: readonly StageConstraint[];
  /** 每条约束回填为联盟掩码列表（塌缩系统 = 同签名的全部掩码） */
  readonly expand: readonly number[][];
}

/** 逐级 LP（与 buildStageLP 同构：效率等式 + 已定居等式 + 剩余 ≥ 行） */
function stagedLP(
  sys: StageSystem,
  fixed: ReadonlyMap<number, Fraction>,
  remaining: readonly number[],
): LPProblem {
  const cols = sys.nVars + 1; // [x_0.., ε]
  const matrix: Fraction[][] = [];
  const rhs: Fraction[] = [];
  const senses: ConstraintSense[] = [];
  const eff = Array.from({ length: cols }, (_, c) => (c < sys.nVars ? sys.efficiency[c] : Fraction.ZERO));
  matrix.push(eff);
  rhs.push(sys.grandValue);
  senses.push('=');
  for (const [idx, eps] of fixed) {
    const row = Array.from({ length: cols }, () => Fraction.ZERO);
    for (let c = 0; c < sys.nVars; c += 1) row[c] = sys.constraints[idx].coeffs[c];
    matrix.push(row);
    rhs.push(sys.constraints[idx].value.sub(eps));
    senses.push('=');
  }
  for (const idx of remaining) {
    const row = Array.from({ length: cols }, () => Fraction.ZERO);
    for (let c = 0; c < sys.nVars; c += 1) row[c] = sys.constraints[idx].coeffs[c];
    row[sys.nVars] = Fraction.ONE;
    matrix.push(row);
    rhs.push(sys.constraints[idx].value);
    senses.push('>=');
  }
  const objective = Array.from({ length: cols }, () => Fraction.ZERO);
  objective[sys.nVars] = Fraction.ONE;
  return { objective, matrix, rhs, senses };
}

/** 探针 LP：最优面上 max Σ_{S∈G} e(S,x)（最小化负和实现；可批量） */
function stagedProbeLP(
  sys: StageSystem,
  fixed: ReadonlyMap<number, Fraction>,
  remaining: readonly number[],
  epsilon: Fraction,
  group: readonly number[],
): LPProblem {
  const matrix: Fraction[][] = [];
  const rhs: Fraction[] = [];
  const senses: ConstraintSense[] = [];
  const eff = Array.from({ length: sys.nVars }, (_, c) => sys.efficiency[c]);
  matrix.push(eff);
  rhs.push(sys.grandValue);
  senses.push('=');
  for (const [idx, eps] of fixed) {
    const row = Array.from({ length: sys.nVars }, () => Fraction.ZERO);
    for (let c = 0; c < sys.nVars; c += 1) row[c] = sys.constraints[idx].coeffs[c];
    matrix.push(row);
    rhs.push(sys.constraints[idx].value.sub(eps));
    senses.push('=');
  }
  for (const idx of remaining) {
    const row = Array.from({ length: sys.nVars }, () => Fraction.ZERO);
    for (let c = 0; c < sys.nVars; c += 1) row[c] = sys.constraints[idx].coeffs[c];
    matrix.push(row);
    rhs.push(sys.constraints[idx].value.sub(epsilon));
    senses.push('>=');
  }
  const objective = Array.from({ length: sys.nVars }, () => Fraction.ZERO);
  for (const idx of group) {
    for (let c = 0; c < sys.nVars; c += 1) {
      if (!sys.constraints[idx].coeffs[c].isZero()) {
        objective[c] = objective[c].sub(sys.constraints[idx].coeffs[c]);
      }
    }
  }
  return { objective, matrix, rhs, senses };
}

interface StagedOutcome {
  readonly x: ReadonlyArray<Fraction>;
  readonly rounds: readonly { epsilon: Fraction; settled: readonly number[] }[];
  readonly leastCoreEpsilon: Fraction;
  readonly lpSolves: number;
  readonly pivots: number;
  readonly converged: boolean;
}

/**
 * 通用逐级程序（Kopelowitz / Maschler–Peleg，与 nucleolus() 算法同构），
 * 差异仅在探针：候选 ≥ minBatch 时先跑一次批量探针（一揽子定居判定），
 * 失败再逐条回退——定居集与逐条口径恒同（批量成功 ⟹ 每条处处紧）。
 */
function runStagedNucleolus(sys: StageSystem, minBatch: number): StagedOutcome {
  let remaining = sys.constraints.map((_, idx) => idx);
  const fixed = new Map<number, Fraction>();
  const rounds: { epsilon: Fraction; settled: readonly number[] }[] = [];
  let x: Fraction[] = [];
  let leastCoreEpsilon = Fraction.ZERO;
  let lpSolves = 0;
  let pivots = 0;
  let converged = false;

  while (remaining.length > 0) {
    if (rounds.length > sys.constraints.length) break; // 防御：每级至少定居一条
    const stage = solveLP(stagedLP(sys, fixed, remaining));
    lpSolves += 1;
    if (stage.status !== 'optimal') {
      throw new Error(`runStagedNucleolus: 第 ${rounds.length + 1} 级 LP 竟然 ${stage.status}（内部错误——互补约束对保证有界）`);
    }
    pivots += stage.pivots;
    const epsilon = stage.objective;
    x = stage.x.slice(0, sys.nVars) as Fraction[];
    if (rounds.length === 0) leastCoreEpsilon = epsilon;

    // 候选：在 x* 处过剩恰为 ε 的剩余约束（e_c(x*) = value_c − coeffs·x*）
    const excessAt = (idx: number): Fraction => {
      let s = Fraction.ZERO;
      for (let c = 0; c < sys.nVars; c += 1) {
        if (!sys.constraints[idx].coeffs[c].isZero()) {
          s = s.add(sys.constraints[idx].coeffs[c].mul(x[c]));
        }
      }
      return sys.constraints[idx].value.sub(s);
    };
    const candidates = remaining.filter((idx) => excessAt(idx).cmp(epsilon) === 0);

    const settled: number[] = [];
    const probeOne = (group: readonly number[]): boolean => {
      const probe = solveLP(stagedProbeLP(sys, fixed, remaining, epsilon, group));
      lpSolves += 1;
      if (probe.status !== 'optimal') return false; // 无界 ⟺ 还能更松 → 不定居
      pivots += probe.pivots;
      // 判据：max Σ_{S∈G} T_S = Σ_{S∈G}(v(S) − ε)（各项均被 v(S)−ε 封底，
      // 和达下界 ⟹ 每项在**整个**最优面上取到下界 ⟹ 每条处处紧）
      let bound = Fraction.ZERO;
      for (const idx of group) bound = bound.add(sys.constraints[idx].value);
      bound = bound.sub(epsilon.mul(new Fraction(BigInt(group.length))));
      return probe.objective.neg().cmp(bound) === 0;
    };
    let batched = false;
    if (candidates.length >= minBatch && candidates.length >= 3) {
      batched = probeOne(candidates);
      if (batched) settled.push(...candidates);
    }
    if (!batched) {
      for (const idx of candidates) {
        if (probeOne([idx])) settled.push(idx);
      }
    }

    rounds.push({ epsilon, settled });
    for (const idx of settled) fixed.set(idx, epsilon);
    remaining = remaining.filter((idx) => !fixed.has(idx));
    if (settled.length === 0) break; // 理论上不可能；防御性诚实退出
    if (remaining.length === 0) converged = true;
  }
  return { x, rounds, leastCoreEpsilon, lpSolves, pivots, converged };
}

/** 加性博弈判定：v(S) = Σ_{i∈S} v({i}) 对全部 S 精确成立 */
function isAdditiveGame(game: CooperativeGame): boolean {
  const size = 1 << game.n;
  for (let mask = 1; mask < size; mask += 1) {
    let sum = Fraction.ZERO;
    for (let i = 0; i < game.n; i += 1) if (mask & (1 << i)) sum = sum.add(game.values[1 << i]);
    if (!sum.eq(game.values[mask])) return false;
  }
  return true;
}

/**
 * 对称类检测：i ∼ j ⟺ ∀S ⊆ N∖{i,j}: v(S∪{i}) = v(S∪{j})（精确比较）。
 * 返回每玩家的类代表下标（同代表 = 同类）；传递性成立（见文件头注）。
 */
export function symmetryClasses(game: CooperativeGame): ReadonlyArray<number> {
  const n = game.n;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const others = fullMask(n) & ~(1 << i) & ~(1 << j);
      let symmetric = true;
      for (let s = others; ; s = (s - 1) & others) {
        if (!game.values[s | (1 << i)].eq(game.values[s | (1 << j)])) {
          symmetric = false;
          break;
        }
        if (s === 0) break;
      }
      if (symmetric) union(i, j);
    }
  }
  return parent.map((_, i) => find(i));
}

function fullMask(n: number): number {
  return (1 << n) - 1;
}

/** nucleolusFast 的加速路径标记 */
export type NucleolusShortcut = 'additive' | 'symmetry' | 'none';

/** 加速结果：数学字段与 NucleolusResult 全同，附加速口径 */
export interface NucleolusFastResult extends NucleolusResult {
  /** 命中的加速路径（additive = 零 LP 短路；symmetry = 类塌缩；none = 仅批量探针） */
  readonly shortcut: NucleolusShortcut;
  /** 对称类数（= 玩家数 ⟹ 无对称可塌缩） */
  readonly classCount: number;
}

/**
 * 加速核仁（R5-A13）：与 nucleolus() 数学等价（x / rounds / complaints
 * 精确一致），按序尝试三条定理级加速——
 * 1. 加性博弈：x_i = v({i})，θ = (0,…,0)，零次 LP；
 * 2. 对称塌缩：同类玩家共享一个 LP 变量，约束按计数签名去重；
 * 3. 批量探针：第 k 级候选 ≥ minBatch（缺省 3）条时先一揽子判定
 *    （成功省 |G|−1 次 LP；失败仅多 1 次探针、随后逐条回退——
 *    最坏开销 +1 次换对称类博弈的成批节省，阈值 3 让小候选组零风险）。
 */
export function nucleolusFast(game: CooperativeGame, options?: { minBatch?: number }): NucleolusFastResult {
  const minBatch = options?.minBatch ?? 3;
  const n = game.n;
  const all = properMasks(n);

  if (n === 1) {
    const only = game.values[1];
    return {
      x: [only],
      rounds: [],
      leastCoreEpsilon: Fraction.ZERO,
      maxExcess: Fraction.ZERO,
      coreNonempty: true,
      inCore: true,
      isImputation: true,
      shapley: [only],
      complaints: [],
      lpSolves: 0,
      pivots: 0,
      converged: true,
      shortcut: 'none',
      classCount: 1,
    };
  }

  // ── 加性短路：θ = (0,…,0)，第 1 级全部真联盟定居 ──
  if (isAdditiveGame(game)) {
    const x = Array.from({ length: n }, (_, i) => game.values[1 << i]);
    return {
      x,
      rounds: [{ round: 1, epsilon: Fraction.ZERO, settled: [...all] }],
      leastCoreEpsilon: Fraction.ZERO,
      maxExcess: Fraction.ZERO,
      coreNonempty: true,
      inCore: inCore(game, x),
      isImputation: isImputation(game, x),
      shapley: shapleyExact(game),
      complaints: excessVector(game, x),
      lpSolves: 0,
      pivots: 0,
      converged: true,
      shortcut: 'additive',
      classCount: n,
    };
  }

  // ── 对称塌缩：类代表 = min 下标；约束按计数签名去重 ──
  const classOf = symmetryClasses(game);
  const representatives = [...new Set(classOf)].sort((a, b) => a - b);
  const classIndex = new Map(representatives.map((r, c) => [r, c]));
  const constraints: StageConstraint[] = [];
  const expand: number[][] = [];
  const signatureIndex = new Map<string, number>();
  let collapseConsistent = true;
  for (const mask of all) {
    const counts = new Array<Fraction>(representatives.length).fill(Fraction.ZERO);
    for (let c = 0; c < representatives.length; c += 1) {
      let k = 0;
      for (let i = 0; i < n; i += 1) if (classOf[i] === representatives[c] && mask & (1 << i)) k += 1;
      counts[c] = new Fraction(BigInt(k));
    }
    const key = counts.map((f) => f.toString()).join('|');
    const existing = signatureIndex.get(key);
    if (existing === undefined) {
      signatureIndex.set(key, constraints.length);
      constraints.push({ coeffs: counts, value: game.values[mask] });
      expand.push([mask]);
    } else {
      // 同签名联盟价值必须相等（对称性的不变量）；不等 = 检测口径被破坏，诚实回退
      if (!constraints[existing].value.eq(game.values[mask])) collapseConsistent = false;
      expand[existing].push(mask);
    }
  }
  for (const list of expand) list.sort((a, b) => a - b);

  const useSymmetry = collapseConsistent && representatives.length < n;
  const sys: StageSystem = useSymmetry
    ? {
        nVars: representatives.length,
        efficiency: representatives.map((r) => {
          let size = 0;
          for (let i = 0; i < n; i += 1) if (classOf[i] === r) size += 1;
          return new Fraction(BigInt(size));
        }),
        grandValue: game.values[fullMask(n)],
        constraints,
        expand,
      }
    : standardSystem(game);

  const outcome = runStagedNucleolus(sys, minBatch);

  const x = Array.from({ length: n }, (_, i) =>
    useSymmetry ? outcome.x[classIndex.get(classOf[i])!] : outcome.x[i],
  );
  // 展开回玩家坐标系：x_i = a_{class(i)}；定居约束展开回掩码（升序）
  const rounds = outcome.rounds.map((r, k) => ({
    round: k + 1,
    epsilon: r.epsilon,
    settled: r.settled.flatMap((idx) => sys.expand[idx]) as number[],
  }));
  for (const r of rounds) r.settled.sort((a, b) => a - b);

  return {
    x,
    rounds,
    leastCoreEpsilon: outcome.leastCoreEpsilon,
    maxExcess: outcome.leastCoreEpsilon,
    coreNonempty: !outcome.leastCoreEpsilon.isPositive(),
    inCore: inCore(game, x),
    isImputation: isImputation(game, x),
    shapley: shapleyExact(game),
    complaints: excessVector(game, x),
    lpSolves: outcome.lpSolves,
    pivots: outcome.pivots,
    converged: outcome.converged,
    shortcut: useSymmetry ? 'symmetry' : 'none',
    classCount: representatives.length,
  };
}

/** 标准约束系统（塌缩不可用时的直跑口径——与 nucleolus() 的 LP 同构） */
function standardSystem(game: CooperativeGame): StageSystem {
  const n = game.n;
  const masks = properMasks(n);
  const constraints: StageConstraint[] = masks.map((mask) => ({
    coeffs: Array.from({ length: n }, (_, i) => (mask & (1 << i) ? Fraction.ONE : Fraction.ZERO) as Fraction),
    value: game.values[mask],
  }));
  return {
    nVars: n,
    efficiency: Array.from({ length: n }, () => Fraction.ONE),
    grandValue: game.values[fullMask(n)],
    constraints,
    expand: masks.map((mask) => [mask]),
  };
}

/* ── 接线建议 ──
 * 1. 建议挂载引擎: src/symbiosis/ledger.ts 能量账本 + src/symbiosis/market.ts
 *    售后分成（royalty）——本内核是「分红稳定化」的理论核：
 *    a) 知识资产的多贡献者版税分配：现在 royaltyRate 是单一比例；建议
 *       双口径并陈——Shapley 16.0 给「平均公平」基准，本内核 nucleolus()
 *       给「最坏联盟无异议」基准；决策引擎把两个分配向量同时上报，
 *       两者接近 → 分配稳健可执行；两者分裂 → 暴露结构性异议联盟，
 *       应先谈再分（不是静默选一边）；
 *    b) 能量盈余分配：v(S) = 联盟 S 独立可创造能量的经验估计（可由
 *       历史成交/出力数据回归），核仁分配保证任何子联盟「单干不划算」
 *       ——抑制共生体分裂的数学底线；
 *    c) core() 先行体检：核空（ε₁ > 0）时诚实降级为「最小抱怨口径」
 *       （leastCore 的 x 与 ε₁ 一起上报），不假装稳定存在。
 * 2. 缺省关闭旗标名: SymbiosisBridgeConfig 新增
 *    `nucleolus?: { enabled?: boolean }`（缺省 false，影子计算，
 *    与 mechanismDesign 旗标同款——不改变主链路）。
 * 3. 挂载后改变的决策点：
 *    - market.ts 的版税分账表 → Shapley（平均公平）与核仁（无异议）
 *      双列并报，采纳哪列由治理策略显式决定并留痕；
 *    - 账本分红事件携带 maxExcess 与 complaints 摘要（最大抱怨联盟的
 *      身份与抱怨额度）——审计第一次看得见「谁可能不服」；
 *    - 未启用时行为与本内核加入前逐位一致（零漂移）。
 * 4. 成本注记: 精确核仁是逐级 LP（≤ 2^n−2 级、每级含探针 LP），n ≤ 8
 *    是务实上限（n = 8 → 254 条联盟约束）；更大的分账场景退回
 *    Shapley 16.0 的采样口径 + 本内核的 inCore 抽查。
 */
