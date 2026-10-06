/**
 * self-play.ts — 92.0 自我对弈内核 —— 虚拟博弈、可剥削度与联赛对抗（Brown 1951 / Robinson 1951 / PSRO-Lite）
 *
 * 升级前的根本局限（策略进化缺「对抗性」这一维）：
 * - 14.0 QD 管多样性、66.0 SA 管全局性，但进化环的适应度始终来自
 *   「与环境 / 历史数据斗」——环境是死的：策略族一旦拟合了历史分布，
 *   适应度即饱和，进化失去梯度（全族过拟合昨天的世界）；
 * - 活的对手在哪儿？在镜子里。自我对弈（self-play）让策略与自己斗
 *   ——与自己的历史平均斗（虚拟博弈）、与专门针对自己的对手斗（联赛
 *   exploiter）：任何可剥削的规律都会被下一轮最优响应利用。策略的
 *   弱点不再是「历史数据没覆盖的角落」，而是可计算的量：exploitability；
 * - Brown 虚拟博弈（fictitious play, 1951）：每方对对手的历史平均策略
 *   打精确最优响应（纯 argmax）。Robinson 定理（1951）：零和矩阵博弈
 *   中双方平均策略对的价值收敛到博弈值——两个只做贪心 BR 的「笨」
 *   玩家，时间平均却收敛到均衡：对抗产生最优性，不需要任何人理解
 *   博弈的全局结构；
 * - 联赛制（PSRO-lite）：main agent 对「历史元策略池的均匀混合」做 BR
 *   （像 FP 一样累积平均），exploiter 专门对 main 的当前平均做 BR
 *   （对抗压力定向打击弱点）。零和博弈中带 exploiter 的联赛严格退化
 *   为 FP（均匀先验变体）——Robinson 定理保证 main 的可剥削度随轮数
 *   下降；拆掉 exploiter（对手池冻结在均匀种子）则 main 的 BR 立刻
 *   退化为常数纯策略、可剥削度平坦——对抗压力是弱点磨平的唯一驱动力。
 *
 * 数学：
 * 1. 精确最优响应：bestResponse(M, σ) = argmax_i Σ_j M[i][j]·σ[j]
 *    （纯 argmax；平局取首下标，带 seed 的接口用 mulberry32(seed)
 *    在平局集上均匀打破——同种子同轨迹）。
 * 2. 可剥削度（对称和口径）：对策略对 (σ₁,σ₂)，
 *      exploitability = [max_a u₁(e_a, σ₂) − u₁(σ₁, σ₂)]
 *                     + [max_b u₂(σ₁, e_b) − u₂(σ₁, σ₂)]
 *    ——双方各自「改为对对方的最优纯响应」的净收益之和。恒 ≥ 0
 *    （max 的线性泛函 ≥ 混合点自身），= 0 ⟺ Nash 均衡；零和博弈中
 *    代数上恒等于对偶间隙 max_a u₁(e_a,σ₂) − min_b u₁(σ₁,e_b)
 *    （ minimax 上界 − 下界）。这是策略弱点的可计算货币：
 *    一个策略好不好 = 它有多难被针对。
 * 3. 虚拟博弈：σ̄_i^{(t)} = 前 t 轮纯策略的均匀平均（t=0 取均匀先验），
 *    每轮双方同时打 br_i(σ̄_{−i})。Robinson 定理：零和时
 *    u₁(σ̄₁^{(t)}, σ̄₂^{(t)}) → v*（博弈值）且对偶间隙 → 0
 *    （收敛速率无一般多项式保证，Kuhn 扑克上经验为慢速单调趋势）。
 * 4. Kuhn 单卡扑克的扩展式矩阵化：3 张牌 {J,Q,K} 各 1 ante，6 信息集/
 *    方（每方 2^6 = 64 纯策略），6 种发牌等概率枚举博弈树 → 64×64
 *    零和矩阵。文献博弈值 −1/18（Kuhn 1950）。本内核用行为策略均衡
 *    族独立复核（参数 α ∈ (0, 1/3]：P1 低牌 J 诈唬 α、高牌 K 下注
 *    3α、中牌 Q 过牌遇注跟注 1/3+α、J 遇注弃牌；P2 低牌 J 诈唬 1/3、
 *    高牌 K 恒下注、中牌 Q 遇注跟注 1/3、J 遇注弃牌）：矩阵化价值
 *    精确 = −1/18 且 exploitability ~ 1e-17——树编码与文献值互为
 *    对方的审计。
 * 5. 联赛：main 的训练对手 = 对手池（均匀种子 + 历史 exploiter 纯策略）
 *    的均匀混合；exploiter = br₂(σ̄_main)。trace 记录
 *      e_r = exploitability(σ̄_main^{(r)}, 对手池混合^{(r)})
 *    （对称和口径，与 FP 的 trace 同口径——两个时间平均到均衡的
 *    距离）；无 exploiter 时对手分布冻结 → main 的 BR 恒指向同一
 *    纯策略 → e_r 平坦（对照组：RPS 平坦在 1.0、Kuhn 平坦在 5/6）。
 *
 * 验证锚点（scripts/verify-self-play.mjs）：
 *   ① RPS：FP 10⁴ 轮平均策略 → 均匀（最大分量偏差 < 0.02，实测
 *      0.005/0.008）、价值 → 0（带 seed 打破对称动力学，|v_final|
 *      < 0.01，实测 1.2e-5；不带 seed 时双方动力学对称 + 收益矩阵
 *      反对称 → 价值恒 0，Robinson 的退化捷径）；
 *   ② Kuhn 单卡扑克：行为策略均衡族（α=1/3 与 α=1/6 双点）矩阵化
 *      价值 = −1/18 精确（1e-9）、exploitability ~ 1e-17；FP 10⁴ 轮
 *      价值收敛到文献值（容差 0.02 文档化——FP 慢收敛经验速率，
 *      实测误差 ~1e-4）；
 *   ③ exploitability 随 FP 迭代下降：最小二乘回归斜率 < 0（RPS 与
 *      Kuhn 双验证；FP 逐步下降不保证，总体趋势由 Robinson 保证）；
 *   ④ 联赛：exploiter 在场时 main 的可剥削度随轮数下降（斜率 < 0、
 *      RPS 千轮后 < 0.05 实测 0.011、Kuhn 两千轮实测 0.004）；拆掉
 *      exploiter（对手池冻结在均匀种子）后 main 退化为常数纯策略、
 *      e 平坦——RPS 平坦在 1.0、Kuhn 平坦在 5/6（下降率为零，严格
 *      更慢：对抗压力是弱点磨平的唯一驱动力，对照）；
 *   ⑤ BR 精确性（手算锚）：[[3,0],[1,2]] × (1/2,1/2) → 行期望
 *      (1.5,1.5) 平局取首下标 0；× (0.2,0.8) → (0.6,1.8) → 1；
 *      RPS 的 BR 到 (0.5,0.3,0.2) = Paper；混合博弈值 1.5 的 Nash 对
 *      (1/4,3/4)/(1/2,1/2) exploitability = 0、(1/2,1/2)/(1/2,1/2)
 *      的 = 0.5（列玩家改打纯列 2 净赚 0.5——手算解析；零和下对称
 *      和口径 = 对偶间隙 max−min = 1.5−1.0 双口径互验）。
 *
 * 应用：策略进化对抗训练——进化环从「与环境 / 历史数据斗」升级为
 * 「与自己斗」：候选策略上线前先过 exploitability 审计（弱点 = 可被
 * 自身最优响应利用的量），联赛 exploiter 定向生成对抗压力，FP / 联赛
 * 平均作为「鲁棒化算子」；与 14.0 QD（多样性）、66.0 SA（全局性）
 * 组成三维进化（多样性 / 全局性 / 对抗性）。
 *
 * ── 第五轮世界性进化（R5-A15，四轴）──
 * 1. [数学] 对手建模——最优响应者的弱点画像（bestResponseWeakness）：
 *    BR 不是终点，BR 自己有多脆是下一层信息。给定对手混合 σ₂，输出
 *    BR 的期望收益、对每个对手纯策略的收支表 M[br][j]、暴露度
 *    exposure = u(br) − min_j M[br][j]（对手定向反制可削减的收益上限）、
 *    对手的最优反制纯策略与反制松弛量。零和恒等式：
 *    exposure ≡ counterRegret（两条独立公式在同一数上闭合——解析锚）。
 * 2. [数学] 演化稳定性的马尔可夫排序（evolutionaryStabilityRank）：
 *    单种群 logit 选择动力学——状态 = 当前纯策略 i，每一步均匀提名
 *    j ≠ i，以 σ_β(Δ) 概率切换，Δ = M[j][i] − M[i][i]（入侵者 j 对
 *    在位者 i 的适应度差）。链遍历严格正（σ ∈ (0,1)），平稳分布存在
 *    且唯一（m ≤ 64 用直接线性解求出，大 m 走幂迭代）——平稳质量即
 *    「演化稳定性排名」。解析锚：RPS 的转移矩阵是循环矩阵 ⟹ 平稳
 *    分布精确均匀；严格被支配策略 β→∞ 时排名 → 0；2×2 协调博弈的
 *    平稳比闭式 = σ(−βΔ₂)/(σ(−βΔ₁)+σ(−βΔ₂))。
 * 3. [数值] 平稳分布求解的主路径 = 直接线性解（m ≤ 64，部分主元
 *    Gauss 消元）——幂迭代的两类陷阱被绕开：慢混合链步差残差被谱隙
 *    倒数放大、近吸收链（β 大）第一步即「步差 < 容差」假收敛；softmax
 *    温度护栏 β·Δ 钳制 ±60 再过 exp（免疫 exp(709) 上溢）。
 * 4. [性质] exploitability 对称性：交换双方视角（payoffRow↔payoffCol
 *    转置、策略对调）后 total 逐位相等（代数恒等，200 种子化随机
 *    零和/一般和博弈机器验证）。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入
 */

// ─────────────────────────── 确定性随机源 ───────────────────────────

/** mulberry32：32 位种子 → [0,1) 均匀流（同种子同序列——验证可复现） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────── 双人矩阵博弈 ───────────────────────────

/**
 * 双人矩阵博弈：行玩家（玩家 1）m 个纯策略、列玩家（玩家 2）n 个，
 * payoffRow[i][j] / payoffCol[i][j] 为联合纯策略 (i,j) 下双方的收益。
 * 零和（zeroSum = true）时 payoffCol ≡ −payoffRow（玩家 1 视角的
 * 矩阵博弈 A，minimax 值 v* 满足 max_σ min_τ σᵀAτ = v*）。
 */
export interface MatrixGame {
  readonly name: string;
  readonly rows: number;
  readonly cols: number;
  readonly payoffRow: ReadonlyArray<ReadonlyArray<number>>;
  readonly payoffCol: ReadonlyArray<ReadonlyArray<number>>;
  readonly zeroSum: boolean;
  /** 文献已知博弈值（玩家 1 视角；零和口径）；null = 未登记 */
  readonly knownValue: number | null;
}

/** matrixGame 工厂入参（payoffCol 缺省且 zeroSum 时自动取 −payoffRow） */
export interface MatrixGameSpec {
  readonly name: string;
  readonly payoffRow: ReadonlyArray<ReadonlyArray<number>>;
  readonly payoffCol?: ReadonlyArray<ReadonlyArray<number>>;
  readonly zeroSum?: boolean;
  readonly knownValue?: number;
}

function requireFiniteMatrix(
  matrix: ReadonlyArray<ReadonlyArray<number>>,
  label: string,
): { rows: number; cols: number } {
  if (matrix.length === 0) throw new Error(`${label}: 矩阵不能为空`);
  const cols = matrix[0].length;
  if (cols === 0) throw new Error(`${label}: 矩阵列数必须为正`);
  for (let i = 0; i < matrix.length; i += 1) {
    const row = matrix[i];
    if (row.length !== cols) {
      throw new Error(`${label}: 第 ${i} 行长度 ${row.length} ≠ 首行 ${cols}（矩阵必须矩形）`);
    }
    for (let j = 0; j < cols; j += 1) {
      const v = row[j];
      if (!Number.isFinite(v)) throw new Error(`${label}: [${i}][${j}] 含非有限值 ${String(v)}`);
    }
  }
  return { rows: matrix.length, cols };
}

export function matrixGame(spec: MatrixGameSpec): MatrixGame {
  if (typeof spec.name !== 'string' || spec.name.length === 0) {
    throw new Error(`matrixGame: name 必须是非空字符串（收到 ${String(spec.name)}）`);
  }
  const a = requireFiniteMatrix(spec.payoffRow, `matrixGame(${spec.name}).payoffRow`);
  const zeroSum = spec.zeroSum ?? false;
  let payoffCol: ReadonlyArray<ReadonlyArray<number>>;
  if (spec.payoffCol === undefined) {
    if (!zeroSum) throw new Error(`matrixGame(${spec.name}): 非零和博弈必须显式给出 payoffCol`);
    payoffCol = spec.payoffRow.map((row) => row.map((v) => -v));
  } else {
    const b = requireFiniteMatrix(spec.payoffCol, `matrixGame(${spec.name}).payoffCol`);
    if (b.rows !== a.rows || b.cols !== a.cols) {
      throw new Error(
        `matrixGame(${spec.name}): 双方收益矩阵形状必须一致（payoffRow ${a.rows}×${a.cols} vs payoffCol ${b.rows}×${b.cols}）`,
      );
    }
    if (zeroSum) {
      for (let i = 0; i < a.rows; i += 1) {
        for (let j = 0; j < a.cols; j += 1) {
          if (Math.abs(spec.payoffCol[i][j] + spec.payoffRow[i][j]) > 1e-12) {
            throw new Error(
              `matrixGame(${spec.name}): 声明零和但 payoffCol[${i}][${j}] = ${String(spec.payoffCol[i][j])} ≠ −payoffRow[${i}][${j}]`,
            );
          }
        }
      }
    }
    payoffCol = spec.payoffCol;
  }
  return {
    name: spec.name,
    rows: a.rows,
    cols: a.cols,
    payoffRow: spec.payoffRow.map((row) => [...row]),
    payoffCol: payoffCol.map((row) => [...row]),
    zeroSum,
    knownValue: spec.knownValue === undefined ? null : spec.knownValue,
  };
}

/** 公共入口的博弈形状轻校验（防手工构造的畸形对象） */
function requireGame(game: MatrixGame): void {
  const a = requireFiniteMatrix(game.payoffRow, `game(${game.name}).payoffRow`);
  const b = requireFiniteMatrix(game.payoffCol, `game(${game.name}).payoffCol`);
  if (b.rows !== a.rows || b.cols !== a.cols) {
    throw new Error(`game(${game.name}): 双方收益矩阵形状不一致（${a.rows}×${a.cols} vs ${b.rows}×${b.cols}）`);
  }
  if (game.rows !== a.rows || game.cols !== a.cols) {
    throw new Error(`game(${game.name}): 声明形状 ${game.rows}×${game.cols} 与矩阵实际 ${a.rows}×${a.cols} 不符`);
  }
}

/** 矩阵转置（列玩家视角的行矩阵：T[j][i] = M[i][j]） */
export function transposeMatrix(matrix: ReadonlyArray<ReadonlyArray<number>>): number[][] {
  const { rows, cols } = requireFiniteMatrix(matrix, 'transposeMatrix');
  const out: number[][] = Array.from({ length: cols }, () => new Array<number>(rows).fill(0));
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < cols; j += 1) out[j][i] = matrix[i][j];
  }
  return out;
}

// ─────────────────────────── 标准博弈工厂 ───────────────────────────

/**
 * 石头剪刀布（RPS）：3×3 反对称矩阵，Nash = 均匀，博弈值 0。
 * 行/列顺序 [Rock, Paper, Scissors]；A[i][j] = +1 若 i 胜 j。
 */
export function rockPaperScissors(): MatrixGame {
  return matrixGame({
    name: 'rockPaperScissors',
    payoffRow: [
      [0, -1, 1],
      [1, 0, -1],
      [-1, 1, 0],
    ],
    zeroSum: true,
    knownValue: 0,
  });
}

/**
 * Kuhn 单卡扑克单局树：给定发牌与双方纯策略，返回玩家 1 的筹码收益。
 * 规则：3 张牌（0=J < 1=Q < 2=K），各下 1 ante；玩家 1 先行动。
 * 纯策略位编码（c = 0,1,2 对应持牌 J,Q,K）：
 *   玩家 1：bit c     —— 先手动作（0 = 过牌 check，1 = 下注 bet）；
 *           bit 3+c   —— 过牌后面对下注（0 = 弃牌 fold，1 = 跟注 call）；
 *   玩家 2：bit c     —— 面对过牌时（0 = 过牌，1 = 下注）；
 *           bit 3+c   —— 面对下注时（0 = 弃牌，1 = 跟注）。
 * 收益（玩家 1 视角）：对方弃牌 ±1；摊牌各再投 1，胜 +2 / 负 −2。
 */
export function kuhnDealPayoff(card1: number, card2: number, strategy1: number, strategy2: number): number {
  if (!Number.isInteger(card1) || card1 < 0 || card1 > 2) {
    throw new Error(`kuhnDealPayoff: 玩家 1 牌张必须是 0/1/2（收到 ${String(card1)}）`);
  }
  if (!Number.isInteger(card2) || card2 < 0 || card2 > 2) {
    throw new Error(`kuhnDealPayoff: 玩家 2 牌张必须是 0/1/2（收到 ${String(card2)}）`);
  }
  if (card1 === card2) throw new Error(`kuhnDealPayoff: 单副牌不允许同牌（${card1} vs ${card2}）`);
  if (!Number.isInteger(strategy1) || strategy1 < 0 || strategy1 >= 64) {
    throw new Error(`kuhnDealPayoff: 玩家 1 纯策略必须是 [0,63] 的整数（收到 ${String(strategy1)}）`);
  }
  if (!Number.isInteger(strategy2) || strategy2 < 0 || strategy2 >= 64) {
    throw new Error(`kuhnDealPayoff: 玩家 2 纯策略必须是 [0,63] 的整数（收到 ${String(strategy2)}）`);
  }
  const bet1 = (strategy1 >> card1) & 1;
  if (bet1 === 1) {
    const call2 = (strategy2 >> (3 + card2)) & 1;
    if (call2 === 0) return 1; // 玩家 2 弃牌，玩家 1 赢下底池
    return card1 > card2 ? 2 : -2; // 摊牌（各再投 1）
  }
  const bet2 = (strategy2 >> card2) & 1;
  if (bet2 === 0) return card1 > card2 ? 1 : -1; // 双方过牌直接摊牌
  const call1 = (strategy1 >> (3 + card1)) & 1;
  if (call1 === 0) return -1; // 玩家 1 弃牌
  return card1 > card2 ? 2 : -2;
}

/**
 * Kuhn 单卡扑克（Kuhn 1950）扩展式 → 矩阵式：64×64 零和矩阵，
 * 条目 = 6 种等概率发牌的期望收益（玩家 1 视角）。
 * 文献博弈值 −1/18 ≈ −0.0556（先手每手期望输 1/18 个 ante）。
 */
export function kuhnPokerMini(): MatrixGame {
  const size = 64;
  const payoffRow: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  for (let s1 = 0; s1 < size; s1 += 1) {
    for (let s2 = 0; s2 < size; s2 += 1) {
      let sum = 0;
      for (let c1 = 0; c1 < 3; c1 += 1) {
        for (let c2 = 0; c2 < 3; c2 += 1) {
          if (c1 === c2) continue;
          sum += kuhnDealPayoff(c1, c2, s1, s2);
        }
      }
      payoffRow[s1][s2] = sum / 6;
    }
  }
  return matrixGame({ name: 'kuhnPokerMini', payoffRow, zeroSum: true, knownValue: -1 / 18 });
}

// ─────────────────────────── 期望价值与最优响应 ───────────────────────────

/** 混合策略合同校验：长度对、有限、非负（容 −1e-9 尘埃）、总质量 ≈ 1 → 归一化副本 */
function requireMixed(strategy: ReadonlyArray<number>, length: number, label: string): number[] {
  if (strategy.length !== length) {
    throw new Error(`${label}: 混合策略长度必须为 ${length}（收到 ${strategy.length}）`);
  }
  const out: number[] = new Array<number>(length).fill(0);
  let total = 0;
  for (let i = 0; i < length; i += 1) {
    const v = strategy[i];
    if (!Number.isFinite(v)) throw new Error(`${label}: 第 ${i} 个分量非有限（${String(v)}）`);
    if (v < -1e-9) throw new Error(`${label}: 第 ${i} 个分量为负（${v}）——混合策略不发负概率`);
    out[i] = v > 0 ? v : 0;
    total += out[i];
  }
  if (Math.abs(total - 1) > 1e-6) {
    throw new Error(`${label}: 混合策略总质量必须为 1（收到 ${total}）——请先归一化`);
  }
  for (let i = 0; i < length; i += 1) out[i] /= total;
  return out;
}

/**
 * 行期望向量：vals[i] = Σ_j M[i][j]·σ₂[j]——行玩家每个纯策略
 * 对固定混合对手 σ₂ 的期望收益（最优响应的原料，精确线性计算）。
 */
export function expectedRowValues(
  payoffMatrix: ReadonlyArray<ReadonlyArray<number>>,
  oppStrategy: ReadonlyArray<number>,
): number[] {
  const { rows, cols } = requireFiniteMatrix(payoffMatrix, 'expectedRowValues');
  const opp = requireMixed(oppStrategy, cols, 'expectedRowValues.oppStrategy');
  const out: number[] = new Array<number>(rows).fill(0);
  for (let i = 0; i < rows; i += 1) {
    let acc = 0;
    const row = payoffMatrix[i];
    for (let j = 0; j < cols; j += 1) acc += row[j] * opp[j];
    out[i] = acc;
  }
  return out;
}

/** 双混合期望：σ₁ᵀMσ₂（矩阵 M 的双线性型，精确求和） */
export function expectedValue(
  payoffMatrix: ReadonlyArray<ReadonlyArray<number>>,
  rowStrategy: ReadonlyArray<number>,
  colStrategy: ReadonlyArray<number>,
): number {
  const { rows, cols } = requireFiniteMatrix(payoffMatrix, 'expectedValue');
  const s1 = requireMixed(rowStrategy, rows, 'expectedValue.rowStrategy');
  const s2 = requireMixed(colStrategy, cols, 'expectedValue.colStrategy');
  let acc = 0;
  for (let i = 0; i < rows; i += 1) {
    const row = payoffMatrix[i];
    let inner = 0;
    for (let j = 0; j < cols; j += 1) inner += row[j] * s2[j];
    acc += s1[i] * inner;
  }
  return acc;
}

/** 双方期望收益：{ p1 = σ₁ᵀAσ₂, p2 = σ₁ᵀBσ₂ }（零和时 p2 = −p1） */
export function valueOf(
  game: MatrixGame,
  rowStrategy: ReadonlyArray<number>,
  colStrategy: ReadonlyArray<number>,
): { readonly p1: number; readonly p2: number } {
  requireGame(game);
  return {
    p1: expectedValue(game.payoffRow, rowStrategy, colStrategy),
    p2: expectedValue(game.payoffCol, rowStrategy, colStrategy),
  };
}

/**
 * argmax（平局取首下标；提供 rng 时在平局集上均匀采样打破——
 * 仅在平局存在时消耗一个随机数，保证同种子同轨迹）。
 */
function argmaxWithTieBreak(values: ReadonlyArray<number>, rng: (() => number) | null): number {
  if (values.length === 0) throw new Error('argmaxWithTieBreak: 值向量不能为空');
  let best = values[0];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] > best) best = values[i];
  }
  const ties: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] === best) ties.push(i);
  }
  if (rng === null) return ties[0];
  const r = rng();
  const pick = Math.min(ties.length - 1, Math.max(0, Math.floor(r * ties.length)));
  return ties[pick];
}

/**
 * 精确最优响应（纯 argmax）：对固定混合对手 σ₂，行玩家收益最大化的
 * 纯策略下标 = argmax_i Σ_j M[i][j]·σ₂[j]。线性目标的最优解必在
 * 顶点上——混合 BR 无需考虑；平局取首下标（完全确定性）。
 */
export function bestResponse(
  payoffMatrix: ReadonlyArray<ReadonlyArray<number>>,
  oppStrategy: ReadonlyArray<number>,
): number {
  return argmaxWithTieBreak(expectedRowValues(payoffMatrix, oppStrategy), null);
}

/** 列玩家（玩家 2）对 σ₁ 的精确最优响应（收益口径 payoffCol，纯 argmax） */
export function bestResponseColumn(game: MatrixGame, rowStrategy: ReadonlyArray<number>): number {
  requireGame(game);
  return argmaxWithTieBreak(expectedRowValues(transposeMatrix(game.payoffCol), rowStrategy), null);
}

// ─────────────────────────── 可剥削度 ───────────────────────────

/** 可剥削度报告：对称和口径下双方改打最优纯响应的净收益 */
export interface ExploitabilityReport {
  /** p1Gain + p2Gain（恒 ≥ 0；= 0 ⟺ Nash）——策略弱点的标量度量 */
  readonly total: number;
  /** max_a u₁(e_a, σ₂) − u₁(σ₁,σ₂)：玩家 1 偏离到最优纯响应的净赚 */
  readonly p1Gain: number;
  /** max_b u₂(σ₁, e_b) − u₂(σ₁,σ₂)：玩家 2 偏离到最优纯响应的净赚 */
  readonly p2Gain: number;
  readonly p1BestResponse: number;
  readonly p2BestResponse: number;
  readonly value1: number;
  readonly value2: number;
  /** total ≤ tolerance（默认 1e-9）时判 Nash */
  readonly isNash: boolean;
}

/**
 * 可剥削度（对称和口径）：
 *   exploitability(σ₁,σ₂) = [max_a u₁(e_a,σ₂) − u₁(σ₁,σ₂)]
 *                         + [max_b u₂(σ₁,e_b) − u₂(σ₁,σ₂)]
 * 零和博弈中代数恒等于对偶间隙 max_a u₁(e_a,σ₂) − min_b u₁(σ₁,e_b)
 * （第二项展开：−min_b u₁(σ₁,e_b) + u₁(σ₁,σ₂)，与第一项的
 * −u₁(σ₁,σ₂) 相消）。一个策略好不好 = 它有多难被自己针对。
 */
export function exploitability(
  game: MatrixGame,
  rowStrategy: ReadonlyArray<number>,
  colStrategy: ReadonlyArray<number>,
  tolerance = 1e-9,
): ExploitabilityReport {
  requireGame(game);
  const s1 = requireMixed(rowStrategy, game.rows, 'exploitability.rowStrategy');
  const s2 = requireMixed(colStrategy, game.cols, 'exploitability.colStrategy');
  const rowVals = expectedRowValues(game.payoffRow, s2);
  const colVals = expectedRowValues(transposeMatrix(game.payoffCol), s1);
  const br1 = argmaxWithTieBreak(rowVals, null);
  const br2 = argmaxWithTieBreak(colVals, null);
  const values = valueOf(game, s1, s2);
  const p1Gain = rowVals[br1] - values.p1;
  const p2Gain = colVals[br2] - values.p2;
  const total = p1Gain + p2Gain;
  return {
    total,
    p1Gain,
    p2Gain,
    p1BestResponse: br1,
    p2BestResponse: br2,
    value1: values.p1,
    value2: values.p2,
    isNash: total <= tolerance,
  };
}

// ─────────────────────────── 虚拟博弈（Fictitious Play） ───────────────────────────

export interface FictitiousPlayOptions {
  /** 迭代轮数（正整数） */
  readonly iters: number;
  /** 可选：BR 平局集均匀打破的种子（mulberry32）；缺省平局取首下标 */
  readonly seed?: number;
}

export interface FictitiousPlayResult {
  /** 双方平均策略（t = iters 轮纯策略的均匀平均；Robinson 收敛载体） */
  readonly avgStrategies: readonly [ReadonlyArray<number>, ReadonlyArray<number>];
  /** valueTrace[t] = u₁(σ̄₁^{(t)}, σ̄₂^{(t)})，长 iters+1，[0] = 均匀起点 */
  readonly valueTrace: ReadonlyArray<number>;
  /** exploitabilityTrace[t] = e(σ̄₁^{(t)}, σ̄₂^{(t)})，与 valueTrace 同长 */
  readonly exploitabilityTrace: ReadonlyArray<number>;
  /** 每轮双方实际所打的纯 BR 序列（可审计：FP 的全部随机性都在这里） */
  readonly purePlays: readonly [ReadonlyArray<number>, ReadonlyArray<number>];
  readonly finalValue: number;
  readonly finalExploitability: number;
}

/**
 * 虚拟博弈（Brown 1951）：每轮双方同时对**对手的历史平均策略**打精确
 * 纯 BR，平均策略 = 纯策略的均匀累计（t=0 均匀先验）。零和博弈中
 * Robinson 定理保证 valueTrace → v*、exploitabilityTrace → 0。
 * 确定性：不传 seed 时平局恒取首下标；传 seed 平局由 mulberry32 打破
 * （同种子同轨迹）。
 */
export function fictitiousPlay(game: MatrixGame, options: FictitiousPlayOptions): FictitiousPlayResult {
  requireGame(game);
  const { iters, seed } = options;
  if (!Number.isInteger(iters) || iters < 1) {
    throw new Error(`fictitiousPlay: iters 必须是正整数（收到 ${String(iters)}）`);
  }
  if (seed !== undefined && (!Number.isFinite(seed) || !Number.isInteger(seed))) {
    throw new Error(`fictitiousPlay: seed 必须是有限整数（收到 ${String(seed)}）`);
  }
  const rng = seed === undefined ? null : mulberry32(seed);
  const payoffColT = transposeMatrix(game.payoffCol);
  const counts1: number[] = new Array<number>(game.rows).fill(0);
  const counts2: number[] = new Array<number>(game.cols).fill(0);
  const plays1: number[] = [];
  const plays2: number[] = [];
  const valueTrace: number[] = [];
  const exploitabilityTrace: number[] = [];
  const averageOf = (counts: ReadonlyArray<number>, total: number): number[] => {
    if (total === 0) return new Array<number>(counts.length).fill(1 / counts.length);
    return counts.map((c) => c / total);
  };

  for (let t = 0; t <= iters; t += 1) {
    const avg1 = averageOf(counts1, t);
    const avg2 = averageOf(counts2, t);
    const rowVals = expectedRowValues(game.payoffRow, avg2); // u₁(e_a, σ̄₂)
    const colVals = expectedRowValues(payoffColT, avg1); // u₂(σ̄₁, e_b)
    const br1 = argmaxWithTieBreak(rowVals, rng);
    const br2 = argmaxWithTieBreak(colVals, rng);
    const values = valueOf(game, avg1, avg2);
    valueTrace.push(values.p1);
    exploitabilityTrace.push(rowVals[br1] - values.p1 + (colVals[br2] - values.p2));
    if (t < iters) {
      counts1[br1] += 1;
      counts2[br2] += 1;
      plays1.push(br1);
      plays2.push(br2);
    }
  }

  return {
    avgStrategies: [averageOf(counts1, iters), averageOf(counts2, iters)],
    valueTrace,
    exploitabilityTrace,
    purePlays: [plays1, plays2],
    finalValue: valueTrace[iters],
    finalExploitability: exploitabilityTrace[iters],
  };
}

// ─────────────────────────── 联赛（PSRO-lite） ───────────────────────────

export interface LeagueOptions {
  /** 联赛轮数（正整数） */
  readonly rounds: number;
  /** BR 平局打破种子（mulberry32；缺省平局取首下标） */
  readonly seed?: number;
  /** 是否启用 exploiter（缺省 true）：每轮对 main 当前平均打精确 BR 并入对手池 */
  readonly exploiter?: boolean;
}

/** 对手池条目：seed = 均匀种子（pureIndex = −1）；exploiter = 某轮加入的纯策略 */
export interface LeagueRosterEntry {
  /** 加入轮次（seed 为 0） */
  readonly round: number;
  readonly role: 'seed' | 'exploiter';
  /** 该条目的纯策略下标；seed 条目为 −1（均匀分布，非纯策略） */
  readonly pureIndex: number;
}

export interface LeagueResult {
  /** main 的平均策略（各轮纯 BR 的均匀平均——对抗压力下的鲁棒化载体） */
  readonly mainStrategy: ReadonlyArray<number>;
  /** main 每轮所打的纯策略序列 */
  readonly mainPureSequence: ReadonlyArray<number>;
  /** trace[r−1] = 第 r 轮后 (main 平均, 对手池混合) 的对称和可剥削度 */
  readonly exploitabilityTrace: ReadonlyArray<number>;
  /** 对手池（均匀种子 + 历史 exploiter），按加入顺序 */
  readonly leagueRoster: ReadonlyArray<LeagueRosterEntry>;
  /** 末轮 main 的训练对手分布（对手池的均匀混合） */
  readonly finalOpponentMixture: ReadonlyArray<number>;
  readonly finalExploitability: number;
}

/**
 * 联赛训练（PSRO-lite）：
 * - main：每轮对「对手池均匀混合」打精确纯 BR，累计成平均策略
 *   σ̄_main（对手池 = 均匀种子 + 历史 exploiter）；
 * - exploiter（exploiter=true，缺省）：每轮对 main 的**当前平均**打
 *   精确纯 BR，作为对抗压力加入对手池——专门利用 main 的可剥削规律；
 * - trace：第 r 轮后 (σ̄_main, 对手池均匀混合) 的对称和可剥削度
 *   （与 FP 的 exploitabilityTrace 同口径——两个时间平均的距离）。
 * 零和博弈中带 exploiter 的联赛严格等于 FP 的均匀先验变体
 * （main 平均 ↔ FP 平均策略，对手池混合 ↔ FP 对手平均）——Robinson
 * 定理保证 trace → 0；exploiter=false 时对手池冻结在均匀种子，main
 * 的 BR 恒指向同一纯策略，trace 平坦——对抗压力是弱点磨平的唯一
 * 驱动力（对照组）。
 */
export function leaguePlay(game: MatrixGame, options: LeagueOptions): LeagueResult {
  requireGame(game);
  const { rounds, seed } = options;
  const exploiterEnabled = options.exploiter ?? true;
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`leaguePlay: rounds 必须是正整数（收到 ${String(rounds)}）`);
  }
  if (seed !== undefined && (!Number.isFinite(seed) || !Number.isInteger(seed))) {
    throw new Error(`leaguePlay: seed 必须是有限整数（收到 ${String(seed)}）`);
  }
  const rng = seed === undefined ? null : mulberry32(seed);
  const payoffColT = transposeMatrix(game.payoffCol);
  const countsMain: number[] = new Array<number>(game.rows).fill(0);
  const mainPureSequence: number[] = [];
  const exploitabilityTrace: number[] = [];
  const roster: LeagueRosterEntry[] = [{ round: 0, role: 'seed', pureIndex: -1 }];
  // 对手池的向量和（均匀权重混合）：均值 = 和 / 池规模
  const poolSum: number[] = new Array<number>(game.cols).fill(1 / game.cols);
  let poolCount = 1;

  for (let round = 1; round <= rounds; round += 1) {
    const target: number[] = poolSum.map((v) => v / poolCount);
    const rowVals = expectedRowValues(game.payoffRow, target);
    const mainPlay = argmaxWithTieBreak(rowVals, rng);
    countsMain[mainPlay] += 1;
    mainPureSequence.push(mainPlay);
    const avgMain = countsMain.map((c) => c / round);

    // 对手侧：对 main 当前平均的精确 BR（exploiter 本体）
    const colVals = expectedRowValues(payoffColT, avgMain);
    const exploiterPure = argmaxWithTieBreak(colVals, rng);
    if (exploiterEnabled) {
      poolSum[exploiterPure] += 1;
      poolCount += 1;
      roster.push({ round, role: 'exploiter', pureIndex: exploiterPure });
    }

    // 轨迹：main 平均与对手池混合（均含本轮）的对称和可剥削度
    const poolMixture = poolSum.map((v) => v / poolCount);
    exploitabilityTrace.push(exploitability(game, avgMain, poolMixture).total);
  }

  return {
    mainStrategy: countsMain.map((c) => c / rounds),
    mainPureSequence,
    exploitabilityTrace,
    leagueRoster: roster,
    finalOpponentMixture: poolSum.map((v) => v / poolCount),
    finalExploitability: exploitabilityTrace[rounds - 1],
  };
}

// ─────────────────── 对手建模：最优响应者的弱点画像（第五轮进化） ───────────────────

/** bestResponseWeakness 读出：BR 的收支表 + 被反制的暴露面 */
export interface BestResponseWeaknessReport {
  /** 行玩家对 σ₂ 的精确最优纯响应（bestResponse 口径，平局首下标） */
  readonly bestResponse: number;
  /** u₁(e_br, σ₂)：采用 BR 的期望收益 */
  readonly valueAgainst: number;
  /** 每个对手纯策略 j 下 BR 的收益 M[br][j]（对手承诺 j 时的收支表） */
  readonly rowPayoffs: number[];
  /** 对手承诺最不利纯策略时 BR 的收益 min_j M[br][j] */
  readonly worstCasePayoff: number;
  /** exposure = valueAgainst − worstCasePayoff：对手定向反制可削减的收益上限 */
  readonly exposure: number;
  /** 对手的最优反制纯策略 argmax_j payoffCol[br][j]（平局首下标） */
  readonly opponentCounter: number;
  /** 反制时对手收益 u₂(e_br, e_counter) */
  readonly counterPayoff: number;
  /** 对手维持 σ₂ 时的收益 u₂(e_br, σ₂) 与反制收益之差（对手不反制的松弛量） */
  readonly counterRegret: number;
}

/**
 * 最优响应者的弱点画像（对手建模）：
 *
 * bestResponse 回答「对 σ₂ 打什么最好」；本函数回答下一层问题——
 * 「打这个最好的策略，对手反过来能把我打到多惨」：
 * - rowPayoffs：对手每个纯承诺下 BR 的收支表（画像的主体）；
 * - exposure = u(br) − min_j M[br][j]：对手定向反制的最大杀伤；
 * - opponentCounter / counterPayoff / counterRegret：反制是谁、值多少、
 *   对手当前离反制还差多少动力（联盟 exploiter 的候选压力档）。
 * 零和恒等式：exposure ≡ counterRegret（u₂ = −u₁ 时两条独立公式
 * 闭合同一数值——解析锚点）；一般和博弈两者分离（对手有自己的
 * 目标结构，反制未必顺我方的损益轴）。
 */
export function bestResponseWeakness(
  game: MatrixGame,
  opponentStrategy: ReadonlyArray<number>,
): BestResponseWeaknessReport {
  requireGame(game);
  const s2 = requireMixed(opponentStrategy, game.cols, 'bestResponseWeakness.opponentStrategy');
  const rowVals = expectedRowValues(game.payoffRow, s2);
  let br = 0;
  for (let i = 1; i < rowVals.length; i += 1) {
    if (rowVals[i]! > rowVals[br]!) br = i;
  }
  const rowPayoffs: number[] = [];
  for (let j = 0; j < game.cols; j += 1) rowPayoffs.push(game.payoffRow[br]![j]!);
  let worst = rowPayoffs[0]!;
  for (let j = 1; j < rowPayoffs.length; j += 1) {
    if (rowPayoffs[j]! < worst) worst = rowPayoffs[j]!;
  }
  let counter = 0;
  for (let j = 1; j < game.cols; j += 1) {
    if (game.payoffCol[br]![j]! > game.payoffCol[br]![counter]!) counter = j;
  }
  const counterPayoff = game.payoffCol[br]![counter]!;
  let opponentCurrent = 0;
  for (let j = 0; j < game.cols; j += 1) opponentCurrent += s2[j]! * game.payoffCol[br]![j]!;
  return {
    bestResponse: br,
    valueAgainst: rowVals[br]!,
    rowPayoffs,
    worstCasePayoff: worst,
    exposure: rowVals[br]! - worst,
    opponentCounter: counter,
    counterPayoff,
    counterRegret: counterPayoff - opponentCurrent,
  };
}

// ─────────────────── 演化稳定性：logit 选择动力学马尔可夫排序（第五轮进化） ───────────────────

/** evolutionaryStabilityRank 选项 */
export interface EvolutionaryStabilityRankOptions {
  /** 选择强度 β > 0（越大越接近纯选择；缺省 1）。Δ·β 钳制 ±60 后过 exp（数值护栏） */
  readonly intensity?: number;
  /** 平稳分布幂迭代容差（L1，缺省 1e-12） */
  readonly tolerance?: number;
  /** 最大迭代数（缺省 10000） */
  readonly maxIterations?: number;
}

/** 演化稳定性排序读出 */
export interface EvolutionaryStabilityRankResult {
  /** 平稳分布（各纯策略的排名质量；和 = 1） */
  readonly ranks: number[];
  readonly intensity: number;
  readonly iterations: number;
  readonly converged: boolean;
  /**
   * 平稳分布求解方法（第五轮进化的数值稳健性读出）:
   * 'power' = 幂迭代（每步 L1 残差 < tolerance）；'direct' = 直接线性求解
   * （部分主元 Gauss 消元，m ≤ 64 时幂迭代未达容差即切换——慢混合链的
   * 幂迭代残差被谱隙倒数放大，直接解一步到位）
   */
  readonly method: 'power' | 'direct';
  /** 转移矩阵（审计：P[i][j] = 一步从 i 到 j 的概率） */
  readonly transitionMatrix: number[][];
}

/** 数值稳定的 logistic（z 钳制 ±60——exp 溢出护栏） */
function stableSigmoid(z: number): number {
  const clamped = Math.min(60, Math.max(-60, z));
  if (clamped >= 0) {
    const e = Math.exp(-clamped);
    return 1 / (1 + e);
  }
  const e = Math.exp(clamped);
  return e / (1 + e);
}

/**
 * 演化稳定性的马尔可夫排序（单种群 logit 选择动力学，α-rank 的
 * 单种群/秩-1 特例）：
 *
 * 状态 = 在位纯策略 i；每步以 1/(m−1) 提名入侵者 j ≠ i，入侵成功
 * 概率 σ_β(Δ_ij)，Δ_ij = M[j][i] − M[i][i]（j 对在位者 i 的适应度
 * 减 i 自身对 i 的适应度——两人对称元博弈的单突变口径）。
 * P(i→i) = 1 − Σ_{j≠i} σ_β(Δ_ij)/(m−1) > 0 严格（遍历性来源）。
 *
 * 平稳分布 = 各策略作为在位者的长程时间占比 = 演化稳定性排名。
 * 解析锚：RPS 转移矩阵为循环矩阵 ⟹ 平稳分布精确均匀（1/m）；
 * 严格被支配策略 β→∞ 时排名 → 0；2×2 时平稳比有闭式（σ(−βΔ₂₁)/
 * (σ(−βΔ₁₂)+σ(−βΔ₂₁))）。m = 1 退化为 [1]。
 */
export function evolutionaryStabilityRank(
  payoffMatrix: ReadonlyArray<ReadonlyArray<number>>,
  options: EvolutionaryStabilityRankOptions = {},
): EvolutionaryStabilityRankResult {
  const { rows, cols } = requireFiniteMatrix(payoffMatrix, 'evolutionaryStabilityRank');
  if (rows !== cols) {
    throw new Error(`evolutionaryStabilityRank: 须为 m×m 方阵（收到 ${rows}×${cols}——策略须与自身对弈）`);
  }
  const m = rows;
  const beta = options.intensity ?? 1;
  if (typeof beta !== 'number' || !Number.isFinite(beta) || beta <= 0) {
    throw new Error(`evolutionaryStabilityRank: intensity 须为正有限数（收到 ${String(beta)}）`);
  }
  const tolerance = options.tolerance ?? 1e-12;
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) {
    throw new Error(`evolutionaryStabilityRank: tolerance 须为正有限数（收到 ${String(tolerance)}）`);
  }
  const maxIterations = Math.floor(options.maxIterations ?? 10000);
  if (!(maxIterations >= 1)) {
    throw new Error(`evolutionaryStabilityRank: maxIterations 须 ≥ 1（收到 ${String(options.maxIterations)}）`);
  }
  if (m === 1) {
    return { ranks: [1], intensity: beta, iterations: 0, converged: true, method: 'direct', transitionMatrix: [[1]] };
  }
  // 转移矩阵：P[i][j] = σ_β(Δ_ij)/(m−1)（j ≠ i），P[i][i] = 1 − 出逃率
  const P: number[][] = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  for (let i = 0; i < m; i += 1) {
    let escape = 0;
    for (let j = 0; j < m; j += 1) {
      if (j === i) continue;
      const delta = payoffMatrix[j]![i]! - payoffMatrix[i]![i]!;
      const p = stableSigmoid(beta * delta) / (m - 1);
      P[i]![j] = p;
      escape += p;
    }
    P[i]![i] = 1 - escape;
  }
  // 主路径（m ≤ 64）: 直接线性求解（部分主元 Gauss 消元）——πᵀP = π ∧ Σπ = 1，
  // 方程组 [Pᵀ − I；全 1 行] π = [0…0, 1]。幂迭代的两类数值陷阱在这里
  // 被绕开：慢混合链的步差残差被谱隙倒数放大（步差 1e-12 ⟹ 距平稳
  // ~1e-12/谱隙）；近吸收链（强选择 β 大）甚至第一步就「步差 < 容差」
  // 假收敛——直接解免遭两类放大，精度 ~机器 ε。
  let pi = new Array<number>(m).fill(1 / m);
  if (m <= 64) {
    const A: number[][] = [];
    for (let i = 0; i < m; i += 1) {
      const row = new Array<number>(m + 1).fill(0);
      for (let j = 0; j < m; j += 1) row[j] = P[j]![i]! - (i === j ? 1 : 0);
      A.push(row);
    }
    const norm = new Array<number>(m + 1).fill(0);
    for (let j = 0; j < m; j += 1) norm[j] = 1;
    norm[m] = 1;
    A[m - 1] = norm; // 平稳方程行秩 m−1：最后一行换归一化（不可约链的标准消冗）
    for (let col = 0; col < m; col += 1) {
      let pivot = col;
      for (let r = col + 1; r < m; r += 1) {
        if (Math.abs(A[r]![col]!) > Math.abs(A[pivot]![col]!)) pivot = r;
      }
      if (Math.abs(A[pivot]![col]!) < 1e-300) continue; // 列退化（结构零列）——跳过
      const tmp = A[col];
      A[col] = A[pivot];
      A[pivot] = tmp;
      for (let r = 0; r < m; r += 1) {
        if (r === col) continue;
        const factor = A[r]![col]! / A[col]![col]!;
        if (factor === 0) continue;
        for (let c = col; c <= m; c += 1) A[r]![c] = (A[r]![c] ?? 0) - factor * A[col]![c]!;
      }
    }
    const solution = new Array<number>(m).fill(0);
    let solvable = true;
    for (let r = 0; r < m; r += 1) {
      const denom = A[r]![r]!;
      if (Math.abs(denom) < 1e-300) solvable = false;
      solution[r] = Math.abs(denom) < 1e-300 ? 0 : A[r]![m]! / denom;
    }
    if (solvable && solution.every((v) => Number.isFinite(v))) {
      pi = solution;
      pi = pi.map((v) => Math.max(0, v));
      const total = pi.reduce((s, v) => s + v, 0);
      if (total > 0) pi = pi.map((v) => v / total);
      return { ranks: pi, intensity: beta, iterations: 0, converged: true, method: 'direct', transitionMatrix: P };
    }
    // 直接解退化（病态系统）→ 落入幂迭代（诚实降级，method 如实报告）
  }
  // 幂迭代（m > 64 或直接解退化）: 行向量 × 矩阵；L1 步差判据
  let iterations = 0;
  let converged = false;
  for (let it = 1; it <= maxIterations; it += 1) {
    const next = new Array<number>(m).fill(0);
    for (let i = 0; i < m; i += 1) {
      const w = pi[i]!;
      if (w === 0) continue;
      const row = P[i]!;
      for (let j = 0; j < m; j += 1) next[j] = next[j]! + w * row[j]!;
    }
    let l1 = 0;
    for (let j = 0; j < m; j += 1) l1 += Math.abs(next[j]! - pi[j]!);
    pi = next;
    iterations = it;
    if (l1 < tolerance) {
      converged = true;
      break;
    }
  }
  // 归一化清理浮点残差（分布和恒 1）
  const total = pi.reduce((s, v) => s + v, 0);
  pi = pi.map((v) => v / total);
  return { ranks: pi, intensity: beta, iterations, converged, method: 'power', transitionMatrix: P };
}

/* ── 接线建议（含第五轮进化）────────────────────────────────────
 * 1. 建议挂载引擎: 策略进化环（policy evolution）/ 14.0 QD 归档的
 *    适应度审计——本内核是它们的「对抗性」维度（与 66.0 SA 的全局性
 *    组成三角：多样性 / 全局性 / 对抗性）：
 *    a) 候选策略上线前先过 exploitability 审计：把「候选 vs 其余种群」
 *       建成矩阵博弈（收益 = 历史交互的期望得分表），exploitability
 *       即该策略的弱点货币——QD 归档准入从「适应度高」升级为
 *       「适应度高 ∧ 难以被针对」，防止进化出欺负历史数据的偏科生；
 *    b) 联赛 exploiter 定向生成压力：leaguePlay 的对手池就是「压力
 *       档案」——每条 exploiter 条目都是一次被利用过的弱点（可审计的
 *       失败模式清单），main 平均策略作为鲁棒化产物回写种群；
 *    c) fictitiousPlay 作为无监督均衡求解器：多模型对弈 / 资源竞争
 *       的正则型近似（效用 = 历史得分经验表），FP 平均给出可自执行
 *       的混合方案（与 64.0 CE 互补：CE 靠信号协调，FP 靠独立平均）。
 * 2. 缺省关闭旗标名: 进化桥配置新增
 *    `selfPlay?: { enabled?: boolean; leagueRounds?: number }`
 *    （缺省 false，影子计算——与 62.0/63.0/64.0 旗标同款）。
 * 3. 挂载后改变的决策点：
 *    - 策略候选排序：适应度 → 适应度 − λ·exploitability
 *      （λ 为对抗压力权重，缺省 0.1 起步）；
 *    - 进化环每代末尾跑 leaguePlay 一轮，exploitabilityTrace 进
 *      进化账本——「这代比上代更难被针对了吗」第一次有数值答案；
 *    - 对手池（leagueRoster）作为失败模式档案持久化，跨代累积
 *      （exploiter 复活检测：同一 pureIndex 反复出现 = 同一弱点
 *      未修复，应阻断该策略晋升）；
 *    - 未启用时行为与本内核加入前逐位一致（零漂移）。
 * 4. 成本注记: FP/联赛每轮 O(m·n)（m×n 收益矩阵）；64×64 的 Kuhn
 *    扑克 10⁴ 轮 ≈ 2×10⁸ 次乘加，毫秒级每千轮——对手池规模不设上限
 *    但池混合是均匀权重，超过数千条后新 exploiter 影响力 < 1/池规模，
 *    建议定期剪枝（保留 e_r 下降贡献最大的条目）。
 */
