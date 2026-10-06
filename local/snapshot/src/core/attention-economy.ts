/**
 * attention-economy.ts — 99.0 注意力经济内核 —— 注意力槽位的二价拍卖分配
 *
 * 动机: Sentinel→优化器的信息流是洪水：几十路模型遥测、日志异常、记忆回
 * 写、共生市场行情同时竞价「下一眼看什么」。串行认知系统一次只能深看 k
 * 路——注意力是稀缺预算，但现状的取舍是启发式（最近告警优先 / 谁喊得响
 * 谁赢），既说不出「为什么看它」（无机会成本口径），也挡不住估值虚报
 * （下游模块学会把日志级别调高来抢焦点）。经济学里这个问题有精确解：
 * 把 k 个注意力槽当 k 件拍品，让信息源自报估值，用 VCG/二价口径定价——
 * 赢家支付的是「你占用的注意力本可给别人创造的价值」（机会成本），说
 * 真话由此成为占优策略（DSIC）。62.0 机制设计管共生市场的费率（外部
 * 多智能体），本内核管自家认知总线的带宽（内部信息源）；76+ 的 GWT
 * 内核管单步广播焦点（谁此刻进焦点），本内核管持续注意力预算（一段
 * 时间窗内 k 个槽怎么分）——一个「看什么」的市场。
 *
 * 数学:
 * 1. 估值模型: 源 i 对第 t+1 个槽的边际估值 mᵢ(t)（EVSI 式期望信息价值，
 *    可注入的估值函数），价值曲线 cᵢ(t) = Σ_{s<t} mᵢ(s)。要求 mᵢ 非增
 *    （凹价值曲线: 同一源被看第 3 眼的边际信息收益 ≤ 第 2 眼——压缩/
 *    novelty 检测 91.0 一线的「重复观察收益递减」）。
 * 2. 分配 = 可分离凹目标的 matroid 贪心: 最大化 Σᵢ cᵢ(tᵢ) s.t. Σtᵢ ≤ k。
 *    把全部边际对 (i,t) 排成下降序取前 k 个: 因每源边际非增，取中的 (i,t)
 *    自动满足前缀封闭性 → 恰是 polymatroid/可分离凹整数规划的贪心，
 *    = 穷举最优（Edmonds 型结果; 水填充/water-filling 的离散版）。
 *    KKT 风格均衡: 最优分配下存在统一边际价格 p（第 k+1 高边际 = 落选者
 *    最高边际估值），使 mᵢ(tᵢ*) ≥ p ≥ mᵢ(tᵢ*+1) ∀i——边际相等直觉。
 * 3. 定价 = VCG（Clarke pivot）: payᵢ = W*₋ᵢ − W₋ᵢ(a*) = （i 缺席时他人
 *    最优总福利）−（胜出分配下他人实际总福利）= i 挤占的他人机会成本。
 *    单元需求（每源至多 1 槽, partition matroid）时精确退化为经典二价:
 *    每个赢家支付同一个 p = 第 k+1 高边际（落选者最高边际估值）。
 *    多单元需求下 VCG 支付 ≠ tᵢ×p（统一价拍卖的瞒报压价/demand reduction
 *    正来自此——Ausubel–Cramton），故本内核以逐源 Clarke pivot 计价。
 *    性质: DSIC（谎报不提高真实所得）、IR（效用 ≥ 0）、福利最优、
 *    收入 ≥ 0 但非预算平衡（62.0 同款不可能性三角）。
 * 4. 预算守恒: Σ slotsᵢ + idleSlots = k 恒成立——注意力预算逐槽可审计。
 *
 * 验证锚点（scripts/verify-attention-self.mjs）:
 * ① 随机实例（n=8 源、k=3、50 种子）: 贪心总价值 = 穷举组合最优
 *    （C(10,3)=120 个组合逐个对照, 逐实例一致; 内核 greedyVsOptimal 复核）；
 * ② 二价支付 = 边际机会成本: 手工例精确对照——单元需求 {10,7,4}, k=2 →
 *    两赢家各付 p=4; 多单元 A:{10,6,3} B:{8,5}, k=3 → slots={2,1},
 *    pay_A=5（B 的落选边际）, pay_B=3（A 的落选边际）≠ tᵢ×p；
 * ③ 谎报无益: 单元需求 500 次随机谎报（放大/缩小/清零）真实所得无一
 *    正收益（DSIC 抽样检验, maxGain ≤ 1e-9）, 多单元 200 次加测；
 * ④ 凹性违规输入被 concavityCheck 诚实拒绝（违例明细）,
 *    allocateAttention 对违规曲线显式 throw；
 * ⑤ 边际均衡（水填充）: mᵢ(tᵢ*) ≥ p ≥ mᵢ(tᵢ*+1) ∀i 逐源成立
 *    （KKT 风格断言）+ 预算守恒 Σslots + idle = k + IR + 收入 ≥ 0。
 *
 * ── R5-A13 世界性进化（第五轮）──
 *
 * 6. **时间衰减注意力（旧信号价值衰减）**: Sentinel 信号的价值随「自上
 *    次深看以来经过的窗口数」指数衰减——新鲜度乘数 2^(−age/halfLife)。
 *    正值缩放保持凹性（m̃(t) = m(t)·c, c > 0 ⟹ 仍非增）与 VCG 的
 *    DSIC（衰减是公共知识、非源自控），贪心 = 最优与机会成本定价全套
 *    成立；分配后年龄簿记（被看 → 0，未看 → +1）；decayExitAge 给出
 *    「再老多少窗就出局」的解析答案：age* = h·log₂(m(0)/p)（边际影子
 *    价格下的出局年龄）。源 i 的分配随自身年龄单调不增（其全部边际同
 *    乘 c ≤ 1，在全局 top-k 中的占比只减不增——可证）。
 *
 * 7. **O(k·#winners) 支付快径（allocateAttentionFast）**: Clarke pivot
 *    原实现逐赢家重扫边际池（O(#winners·nk)）。恒等式：W*₋ᵢ = 池序
 *    前缀中非 i 的前 k 个正边际之和——单趟池扫描同时填所有赢家的累加器
 *    （每对 (j,m) 给所有配额未满的 i≠j 记一笔），加数顺序与逐赢家扫描
 *    完全一致 ⟹ 支付**逐位一致**，复杂度 O(nk log nk + k·#winners)。
 *
 * 零漂移: allocateAttention 等既有入口逐位不动；本节为纯新增函数。
 *
 * 零漂移: 纯分析内核（引擎只读方法），未挂载零介入。
 */

// ─────────────────────────── 常量与类型 ───────────────────────────

/** 浮点容差（并列边际的确定性破岔与守恒断言口径） */
const EPS = 1e-9;

/** 注意力源: 自报边际估值曲线（第 t+1 槽的期望信息价值, t = 已分配槽数） */
export interface AttentionSource {
  readonly id: string;
  /**
   * 第 slots+1 个槽位的边际估值（EVSI 式, 可注入）。
   * 必须对 t 非增（凹价值曲线）——concavityCheck / allocateAttention 校验。
   * 负值允许（语义: 看它的边际成本), 但永不被分配（贪心只取正边际）。
   */
  readonly marginalValue: (slots: number) => number;
}

/** 贪心分配的逐槽轨迹（前 k 大边际的胜出序列, 审计口径） */
export interface SlotAward {
  readonly sourceIndex: number;
  readonly sourceId: string;
  /** 该源的第几个槽（1 起） */
  readonly slotNumber: number;
  readonly marginal: number;
}

/** allocateAttention 结果 */
export interface AttentionAllocation {
  /** slots[i] = 分配给源 i 的槽位数 */
  readonly slots: number[];
  /** 贪心胜出序列（按边际降序; 确定性并列破岔: 值降 → 源下标升 → 槽号升） */
  readonly awards: readonly SlotAward[];
  /** VCG（Clarke pivot）支付: i 挤占的他人机会成本 */
  readonly payments: number[];
  /** 诚实报告下效用 = 报告总价值 − 支付（IR 的可观测面, ≥ 0） */
  readonly utilities: number[];
  /** 报告口径总价值 Σᵢ cᵢ(slotsᵢ)（= 穷举最优, 锚点 ①） */
  readonly totalValue: number;
  /** 拍卖收入 Σ payments（≥ 0; 非预算平衡是 DSIC 的数学代价） */
  readonly revenue: number;
  /** 统一边际价格: 第 k+1 高边际（落选最高边际）; 边际池耗尽时为 0 */
  readonly marginalPrice: number;
  /** 空置槽位（剩余边际全 ≤ 0 时注意力不硬塞——诚实闲置） */
  readonly idleSlots: number;
}

/** greedyVsOptimal 小实例对照结果 */
export interface GreedyVsOptimal {
  readonly greedyValue: number;
  readonly optimalValue: number;
  /** 穷举最优分配（slots 向量） */
  readonly optimalSlots: readonly number[];
  /** greedyValue − optimalValue（≤ 0; 凹+可分离下恒 = 0） */
  readonly gap: number;
  /** gap ≤ 容差（贪心 = 最优的定理在此实例上的兑现） */
  readonly match: boolean;
  /** 穷举的组合数（实例规模的可观测面） */
  readonly enumerated: number;
}

/** 谎报检验的单次试验 */
export interface MisreportTrial {
  readonly sourceIndex: number;
  /** 谎报因子（真实边际曲线整体 × factor; 0 = 假装离场, >1 = 夸大） */
  readonly factor: number;
  /** 谎报后的真实所得 − 诚实所得（DSIC 下应 ≤ 0） */
  readonly gain: number;
}

/** misreportGain 汇总 */
export interface MisreportSummary {
  readonly trials: number;
  readonly violations: number;
  readonly maxGain: number;
  readonly meanGain: number;
  readonly detail: readonly MisreportTrial[];
}

/** 凹性违例明细 */
export interface ConcavityViolation {
  readonly sourceIndex: number;
  readonly sourceId: string;
  /** 违例槽位: m(t) > m(t−1) 发生处 */
  readonly atSlot: number;
  readonly prev: number;
  readonly curr: number;
}

/** concavityCheck 结果 */
export interface ConcavityReport {
  /** 全部源在 [0, maxSlots] 上边际非增 ⟹ 贪心最优性定理适用 */
  readonly concave: boolean;
  readonly violations: readonly ConcavityViolation[];
}

// ─────────────────────────── 确定性随机源 ───────────────────────────

/** 确定性 PRNG（mulberry32; 验证脚本与内核共用同一实现保证可复现） */
export function mulberry32(seed: number): () => number {
  if (!Number.isFinite(seed)) throw new Error('mulberry32: seed 必须为有限数');
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────── 估值曲线工厂 ───────────────────────────

/** 单元需求源: 首槽估值 v, 之后边际 0（partition matroid 语义） */
export function unitDemandSource(id: string, v: number): AttentionSource {
  if (!Number.isFinite(v)) throw new Error('unitDemandSource: v 必须为有限数');
  return { id, marginalValue: (t) => (t === 0 ? v : 0) };
}

/** 几何衰减源: m(t) = v0·ratio^t（严格凹, EVSI 式重复观察收益递减） */
export function geometricSource(id: string, v0: number, ratio: number): AttentionSource {
  if (!Number.isFinite(v0)) throw new Error('geometricSource: v0 必须为有限数');
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error('geometricSource: ratio 必须 ∈ [0,1]（非增边际）');
  }
  return { id, marginalValue: (t) => v0 * ratio ** t };
}

/** 线性饱和源: m(t) = max(0, v0 − slope·t)（容量有限: 看 capacity 眼后无新信息） */
export function saturatingSource(id: string, v0: number, slope: number): AttentionSource {
  if (!Number.isFinite(v0)) throw new Error('saturatingSource: v0 必须为有限数');
  if (!Number.isFinite(slope) || slope < 0) throw new Error('saturatingSource: slope 必须 ≥ 0');
  return { id, marginalValue: (t) => Math.max(0, v0 - slope * t) };
}

// ─────────────────────────── 校验工具 ───────────────────────────

/** 校验源数组基本合法性（非空 / id 唯一 / 有限） */
function validateSources(sources: readonly AttentionSource[]): void {
  if (sources.length < 1) throw new Error('allocateAttention: 至少 1 个注意力源');
  const seen = new Set<string>();
  for (let i = 0; i < sources.length; i += 1) {
    const s = sources[i];
    if (typeof s.id !== 'string' || s.id.length < 1) throw new Error(`源[${i}]: id 必须为非空字符串`);
    if (seen.has(s.id)) throw new Error(`allocateAttention: 源 id 重复（${s.id}）`);
    seen.add(s.id);
    if (typeof s.marginalValue !== 'function') throw new Error(`源 ${s.id}: marginalValue 必须为函数`);
  }
}

/** 取源 i 在 [0, maxSlots) 上的边际曲线（非有限值 throw） */
function marginalCurve(source: AttentionSource, maxSlots: number, label: string): number[] {
  const curve: number[] = [];
  for (let t = 0; t < maxSlots; t += 1) {
    const v = source.marginalValue(t);
    if (!Number.isFinite(v)) {
      throw new Error(`${label}: 源 ${source.id} 的 marginalValue(${t}) = ${v} 非有限数`);
    }
    curve.push(v);
  }
  return curve;
}

/** 检查边际曲线非增; 返回违例列表 */
function curveViolations(source: AttentionSource, index: number, curve: readonly number[]): ConcavityViolation[] {
  const out: ConcavityViolation[] = [];
  for (let t = 1; t < curve.length; t += 1) {
    if (curve[t] > curve[t - 1] + EPS) {
      out.push({ sourceIndex: index, sourceId: source.id, atSlot: t, prev: curve[t - 1], curr: curve[t] });
    }
  }
  return out;
}

/**
 * 凹性检查: 各源边际曲线在 [0, maxSlots] 上是否非增。
 * 凹性是贪心=最优（matroid/polymatroid 定理）与 VCG 定价语义的前提——
 * 违规输入在此被诚实拒绝（明细逐条返回）。
 */
export function concavityCheck(
  sources: readonly AttentionSource[],
  maxSlots: number,
): ConcavityReport {
  validateSources(sources);
  if (!Number.isInteger(maxSlots) || maxSlots < 1) throw new Error('concavityCheck: maxSlots 必须为 ≥1 的整数');
  const violations: ConcavityViolation[] = [];
  for (let i = 0; i < sources.length; i += 1) {
    const curve = marginalCurve(sources[i], maxSlots + 1, 'concavityCheck');
    violations.push(...curveViolations(sources[i], i, curve));
  }
  return { concave: violations.length === 0, violations };
}

// ─────────────────────────── 核心: 贪心 = 最优分配 ───────────────────────────

/**
 * 注意力槽位拍卖（可分离凹价值 + k 槽约束 + VCG 定价）。
 *
 * 1. 边际池: 全部 (源 i, 第 t+1 槽) 对, t < k（单源不可能拿超 k 槽）;
 * 2. 贪心: 取正边际中前 k 大（确定性并列破岔: 值降 → 源下标升 → 槽号升）;
 * 3. marginalPrice = 落选最高边际（池耗尽 → 0: 无竞争注意力免费）;
 * 4. payments = Clarke pivot（i 缺席重跑贪心 − 他人实际福利）。
 * 源曲线在 [0, k) 上必须非增（凹性）——违规显式 throw（锚点 ④）。
 */
export function allocateAttention(sources: readonly AttentionSource[], k: number): AttentionAllocation {
  validateSources(sources);
  if (!Number.isInteger(k) || k < 0) throw new Error('allocateAttention: k 必须为 ≥0 的整数');
  const n = sources.length;

  const curves: number[][] = [];
  const violations: ConcavityViolation[] = [];
  for (let i = 0; i < n; i += 1) {
    const curve = marginalCurve(sources[i], k, 'allocateAttention');
    curves.push(curve);
    violations.push(...curveViolations(sources[i], i, curve));
  }
  if (violations.length > 0) {
    const v = violations[0];
    throw new Error(
      `allocateAttention: 源 ${v.sourceId} 边际曲线在槽 ${v.atSlot} 上升（${v.prev} → ${v.curr}）——凹性违规, 贪心最优性与二价定价不适用（先 concavityCheck）`,
    );
  }

  // 边际池 + 确定性排序
  interface Pair {
    i: number;
    t: number;
    m: number;
  }
  const pool: Pair[] = [];
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < k; t += 1) pool.push({ i, t, m: curves[i][t] });
  }
  pool.sort((a, b) => (b.m - a.m) || (a.i - b.i) || (a.t - b.t));

  const accepted: Pair[] = [];
  for (const p of pool) {
    if (accepted.length >= k) break;
    if (p.m <= 0) break; // 剩余边际全 ≤ 0: 诚实闲置
    accepted.push(p);
  }
  const idleSlots = k - accepted.length;

  const slots = new Array<number>(n).fill(0);
  const awards: SlotAward[] = [];
  for (const p of accepted) {
    slots[p.i] += 1;
    awards.push({ sourceIndex: p.i, sourceId: sources[p.i].id, slotNumber: p.t + 1, marginal: p.m });
  }
  const totalValue = accepted.reduce((s, p) => s + p.m, 0);
  // 第 k+1 高边际 = 第一个落选边际; 池耗尽（无人竞争）→ 0
  const marginalPrice = accepted.length < pool.length ? Math.max(0, pool[accepted.length].m) : 0;

  // 报告口径的源总价值（ Clarke pivot 与效用计算用）
  const reportedValue = (idx: number, t: number): number => {
    let s = 0;
    for (let u = 0; u < t; u += 1) s += curves[idx][u];
    return s;
  };
  // 贪心价值（排除 skipIdx 源; 容量 kk）——W*₋ᵢ 的计算器
  const greedyValueExcluding = (skipIdx: number, kk: number): number => {
    const rest: Pair[] = pool.filter((p) => p.i !== skipIdx);
    let value = 0;
    let count = 0;
    for (const p of rest) {
      if (count >= kk) break;
      if (p.m <= 0) break;
      value += p.m;
      count += 1;
    }
    return value;
  };

  const payments = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    if (slots[i] === 0) continue;
    const welfareWithoutI = greedyValueExcluding(i, k);
    let othersActual = 0;
    for (let j = 0; j < n; j += 1) if (j !== i) othersActual += reportedValue(j, slots[j]);
    payments[i] = welfareWithoutI - othersActual; // Clarke pivot = 挤占的他人机会成本
  }
  const revenue = payments.reduce((s, p) => s + p, 0);
  const utilities: number[] = payments.map((p, i) => reportedValue(i, slots[i]) - p);

  return { slots, awards, payments, utilities, totalValue, revenue, marginalPrice, idleSlots };
}

/**
 * 贪心 vs 穷举最优对照（小实例）: 枚举全部组合 t₁+…+tₙ = k（非负整数向量）。
 * 凹 + 可分离 ⟹ gap = 0（matroid 贪心定理逐实例兑现）。组合数超上限诚实 throw。
 */
export function greedyVsOptimal(sources: readonly AttentionSource[], k: number): GreedyVsOptimal {
  validateSources(sources);
  if (!Number.isInteger(k) || k < 0) throw new Error('greedyVsOptimal: k 必须为 ≥0 的整数');
  const maxEnumerate = 100_000;
  const n = sources.length;
  // 组合数 C(n+k-1, k)（stars and bars）
  let combos = 1;
  for (let j = 0; j < k; j += 1) {
    combos = (combos * (n + j)) / (j + 1);
    if (combos > maxEnumerate) {
      throw new Error(`greedyVsOptimal: 实例过大（组合数 > ${maxEnumerate}）——穷举对照只对小实例承诺`);
    }
  }
  const curves: number[][] = sources.map((s) => marginalCurve(s, k, 'greedyVsOptimal'));
  for (let i = 0; i < n; i += 1) {
    const bad = curveViolations(sources[i], i, curves[i]);
    if (bad.length > 0) throw new Error('greedyVsOptimal: 输入含凹性违规曲线（先 concavityCheck）');
  }
  const valueOf = (alloc: readonly number[]): number => {
    let s = 0;
    for (let i = 0; i < n; i += 1) {
      for (let t = 0; t < alloc[i]; t += 1) s += curves[i][t];
    }
    return s;
  };

  const alloc = new Array<number>(n).fill(0);
  let bestValue = -Infinity;
  let bestAlloc: number[] = [...alloc];
  let enumerated = 0;
  const recurse = (idx: number, remaining: number): void => {
    if (idx === n - 1) {
      alloc[idx] = remaining;
      enumerated += 1;
      const v = valueOf(alloc);
      if (v > bestValue) {
        bestValue = v;
        bestAlloc = [...alloc];
      }
      return;
    }
    for (let t = 0; t <= remaining; t += 1) {
      alloc[idx] = t;
      recurse(idx + 1, remaining - t);
    }
    alloc[idx] = 0;
  };
  if (n === 1) {
    enumerated = 1;
    bestValue = valueOf([k]);
    bestAlloc = [k];
  } else {
    recurse(0, k);
  }

  const greedy = allocateAttention(sources, k);
  const gap = greedy.totalValue - bestValue;
  return {
    greedyValue: greedy.totalValue,
    optimalValue: bestValue,
    optimalSlots: bestAlloc,
    gap,
    match: gap >= -1e-9 && gap <= 1e-9,
    enumerated,
  };
}

/**
 * 策略性谎报检验: 源 report.sourceIndex 把真实边际曲线整体乘 factor 重新参拍
 * （factor > 1 夸大 / < 1 缩水 / 0 假装离场），支付按谎报局计算，
 * 所得按**真实**估值结算——DSIC 下 gain = u(谎报) − u(诚实) ≤ 0 恒成立。
 *
 * lie.factor 是候选因子池（逐个 × 每 sourceIndex 轮转）; trials 之外再加
 * 种子随机因子。返回逐试验明细（gain > 1e-9 即违例计数）。
 */
export function misreportGain(
  sources: readonly AttentionSource[],
  k: number,
  lie: { factors: readonly number[] },
  seeds = 100,
): MisreportSummary {
  validateSources(sources);
  if (!Number.isInteger(k) || k < 0) throw new Error('misreportGain: k 必须为 ≥0 的整数');
  if (!Number.isInteger(seeds) || seeds < 1) throw new Error('misreportGain: seeds 必须为 ≥1 的整数');
  if (lie.factors.length < 1) throw new Error('misreportGain: factors 至少 1 个');
  for (const f of lie.factors) {
    if (!Number.isFinite(f) || f < 0) throw new Error('misreportGain: factor 必须 ≥ 0');
  }
  const n = sources.length;

  const trueCurve = (idx: number, t: number): number => sources[idx].marginalValue(t);
  const honest = allocateAttention(sources, k);
  const trueValueOf = (idx: number, t: number): number => {
    let s = 0;
    for (let u = 0; u < t; u += 1) s += trueCurve(idx, u);
    return s;
  };

  const detail: MisreportTrial[] = [];
  const rng = mulberry32(40624); // 固定内部种子（同输入同输出）; seeds 参数控制试验数
  const factorPool = [...lie.factors];
  // 追加种子化随机因子（0 到 8 的连续谱, 覆盖极端夸大）; 补齐数先定值——
  // 循环条件里读增长中的数组长度会把试验数砍半（条件随 push 失效）
  const extras = Math.max(0, seeds - lie.factors.length);
  for (let s = 0; s < extras; s += 1) factorPool.push(Number((rng() * 8).toFixed(4)));

  for (let trial = 0; trial < factorPool.length; trial += 1) {
    const factor = factorPool[trial];
    const idx = trial % n;
    const lied: AttentionSource[] = sources.map((s, i) =>
      i === idx ? { id: s.id, marginalValue: (t: number) => s.marginalValue(t) * factor } : s,
    );
    const reRun = allocateAttention(lied, k);
    // 谎报者的真实所得: 真实估值(分到的槽) − 谎报局下按 VCG 的支付
    const utilityLie = trueValueOf(idx, reRun.slots[idx]) - reRun.payments[idx];
    const utilityHonest = trueValueOf(idx, honest.slots[idx]) - honest.payments[idx];
    detail.push({ sourceIndex: idx, factor, gain: utilityLie - utilityHonest });
  }

  const violations = detail.filter((d) => d.gain > 1e-9).length;
  const maxGain = detail.reduce((m, d) => Math.max(m, d.gain), -Infinity);
  const meanGain = detail.reduce((s, d) => s + d.gain, 0) / detail.length;
  return { trials: detail.length, violations, maxGain, meanGain, detail };
}

// ─────────────────────────── R5-A13：支付快径 + 时间衰减 ───────────────────────────

/**
 * O(k·#winners) 支付快径（R5-A13）：与 allocateAttention **逐位一致**的
 * 分配与支付——恒等式 W*₋ᵢ =（池序前缀中非 i 的前 k 个正边际之和），
 * 单趟池扫描为所有赢家同时累计（每对 (j, m) 给所有配额未满的 i ≠ j
 * 记一笔），加数顺序与逐赢家重扫完全相同。大 n（源数百上千）时把
 * 支付计算从 O(#winners·nk) 降到 O(nk + k·#winners)。
 */
export function allocateAttentionFast(sources: readonly AttentionSource[], k: number): AttentionAllocation {
  validateSources(sources);
  if (!Number.isInteger(k) || k < 0) throw new Error('allocateAttentionFast: k 必须为 ≥0 的整数');
  const n = sources.length;

  const curves: number[][] = [];
  const violations: ConcavityViolation[] = [];
  for (let i = 0; i < n; i += 1) {
    const curve = marginalCurve(sources[i], k, 'allocateAttentionFast');
    curves.push(curve);
    violations.push(...curveViolations(sources[i], i, curve));
  }
  if (violations.length > 0) {
    const v = violations[0];
    throw new Error(
      `allocateAttentionFast: 源 ${v.sourceId} 边际曲线在槽 ${v.atSlot} 上升（${v.prev} → ${v.curr}）——凹性违规（先 concavityCheck）`,
    );
  }

  interface Pair {
    i: number;
    t: number;
    m: number;
  }
  const pool: Pair[] = [];
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < k; t += 1) pool.push({ i, t, m: curves[i][t] });
  }
  pool.sort((a, b) => (b.m - a.m) || (a.i - b.i) || (a.t - b.t));

  const accepted: Pair[] = [];
  for (const p of pool) {
    if (accepted.length >= k) break;
    if (p.m <= 0) break;
    accepted.push(p);
  }
  const idleSlots = k - accepted.length;

  const slots = new Array<number>(n).fill(0);
  const awards: SlotAward[] = [];
  for (const p of accepted) {
    slots[p.i] += 1;
    awards.push({ sourceIndex: p.i, sourceId: sources[p.i].id, slotNumber: p.t + 1, marginal: p.m });
  }
  const totalValue = accepted.reduce((s, p) => s + p.m, 0);
  const marginalPrice = accepted.length < pool.length ? Math.max(0, pool[accepted.length].m) : 0;

  const reportedValue = (idx: number, t: number): number => {
    let s = 0;
    for (let u = 0; u < t; u += 1) s += curves[idx][u];
    return s;
  };

  // 快径支付：每赢家配额 q_i = k（= 池∖i 的前 k 对），单趟扫描同时填账。
  // 对 (j, m)：给所有配额未满的赢家 i ≠ j 记 m —— 加数顺序与逐赢家
  // 扫描 pool.filter(i≠skip) 完全一致 ⟹ 与 allocateAttention 逐位相同。
  const winners: number[] = [];
  for (let i = 0; i < n; i += 1) if (slots[i] > 0) winners.push(i);
  const acc = new Array<number>(n).fill(0);
  const quota = new Array<number>(n).fill(0);
  for (const i of winners) quota[i] = k;
  let exhausted = winners.length === 0;
  for (const p of pool) {
    if (exhausted) break;
    if (p.m <= 0) break; // 与逐赢家扫描同款截断（负边际不入账）
    let anyOpen = false;
    for (const i of winners) {
      if (i === p.i || quota[i] <= 0) continue;
      acc[i] += p.m;
      quota[i] -= 1;
      if (quota[i] > 0) anyOpen = true;
    }
    for (const i of winners) if (quota[i] > 0) anyOpen = true;
    exhausted = !anyOpen;
  }
  const payments = new Array<number>(n).fill(0);
  for (const i of winners) {
    let othersActual = 0;
    for (let j = 0; j < n; j += 1) if (j !== i) othersActual += reportedValue(j, slots[j]);
    payments[i] = acc[i] - othersActual; // Clarke pivot = W*₋ᵢ − 他人实际福利
  }
  const revenue = payments.reduce((s, p) => s + p, 0);
  const utilities: number[] = payments.map((p, i) => reportedValue(i, slots[i]) - p);

  return { slots, awards, payments, utilities, totalValue, revenue, marginalPrice, idleSlots };
}

/** 时间衰减分配结果：在标准报告之上附衰减诊断 */
export interface DecayedAttentionAllocation extends AttentionAllocation {
  /** 逐源新鲜度乘数 2^(−age/halfLife)（公共知识的衰减口径） */
  readonly decay: readonly number[];
  /** 分配后的下一窗年龄（被深看 → 0，未被看 → age+1） */
  readonly nextAges: readonly number[];
  /**
   * 逐源「出局年龄余量」（窗）：当前（已衰减）首槽边际降至影子价格
   * marginalPrice 还能再老多少窗——h·log₂(m̃_i(0)/p)；价格 ≤ 0
   * （注意力无竞争）或已无正边际时为 Infinity。
   */
  readonly exitAges: readonly number[];
}

/**
 * 时间衰减包装器：m̃(t) = m(t)·2^(−age/halfLife)。
 * 正值缩放保持边际非增（凹性）与 VCG 的 DSIC（衰减非源自控）。
 * age 必须 ≥ 0 有限；halfLife 必须 > 0 有限；极老信号的乘数下溢到 0
 * ——诚实出局（0 边际永不入账），无 NaN。
 */
export function decayedSource(source: AttentionSource, age: number, halfLife: number): AttentionSource {
  if (!Number.isFinite(age) || age < 0) throw new Error(`decayedSource: age 必须 ≥ 0 有限（收到 ${age}）`);
  if (!Number.isFinite(halfLife) || halfLife <= 0) throw new Error(`decayedSource: halfLife 必须 > 0 有限（收到 ${halfLife}）`);
  const multiplier = Math.pow(2, -age / halfLife);
  return { id: source.id, marginalValue: (t: number) => source.marginalValue(t) * multiplier };
}

/**
 * 解析出局年龄：首槽估值 v 经指数衰减降到影子价格 price 所需的
 * 窗口数 age* = halfLife·log₂(v/price)。「这条信号还能放多旧」的
 * 闭式答案——注意力预算的保鲜期仪表。
 */
export function decayExitAge(firstSlotValue: number, price: number, halfLife: number): number {
  if (!Number.isFinite(firstSlotValue) || firstSlotValue <= 0) {
    throw new Error(`decayExitAge: 首槽估值必须 > 0（收到 ${firstSlotValue}）`);
  }
  if (!Number.isFinite(price) || price < 0) throw new Error(`decayExitAge: 影子价格必须 ≥ 0（收到 ${price}）`);
  if (!Number.isFinite(halfLife) || halfLife <= 0) throw new Error(`decayExitAge: halfLife 必须 > 0（收到 ${halfLife}）`);
  if (price === 0) return Number.POSITIVE_INFINITY;
  if (firstSlotValue <= price) return 0;
  return halfLife * Math.log2(firstSlotValue / price);
}

/**
 * 时间衰减注意力分配（R5-A13）：逐源按年龄指数衰减后参拍，VCG 口径
 * 不变。性质：凹性保持（正缩放）、DSIC 保持（衰减为公共知识）、
 * 源 i 的分得槽位随自身年龄单调不增（其全部边际同乘 c ≤ 1，在全局
 * top-k 中的对数只减不增）。附衰减乘数、下一窗年龄簿记与出局余量。
 */
export function allocateAttentionDecayed(
  sources: readonly AttentionSource[],
  k: number,
  ages: ReadonlyArray<number>,
  halfLife: number,
): DecayedAttentionAllocation {
  validateSources(sources);
  if (!Number.isInteger(k) || k < 0) throw new Error('allocateAttentionDecayed: k 必须为 ≥0 的整数');
  if (ages.length !== sources.length) {
    throw new Error(`allocateAttentionDecayed: ages 长度 ${ages.length} 必须等于源数 ${sources.length}`);
  }
  if (!Number.isFinite(halfLife) || halfLife <= 0) {
    throw new Error(`allocateAttentionDecayed: halfLife 必须 > 0 有限（收到 ${halfLife}）`);
  }
  for (let i = 0; i < ages.length; i += 1) {
    if (!Number.isFinite(ages[i]) || ages[i] < 0) {
      throw new Error(`allocateAttentionDecayed: ages[${i}] 必须 ≥ 0 有限（收到 ${ages[i]}）`);
    }
  }
  const decay = ages.map((age) => Math.pow(2, -age / halfLife));
  const decayed = sources.map((s, i) => decayedSource(s, ages[i], halfLife));
  const base = allocateAttention(decayed, k);
  const nextAges = ages.map((age, i) => (base.slots[i] > 0 ? 0 : age + 1));
  const exitAges = decay.map((c, i) => {
    const first = sources[i].marginalValue(0) * c; // 已衰减的首槽边际
    if (!(first > 0)) return Number.POSITIVE_INFINITY; // 本已无正边际：无出局概念
    return decayExitAge(first, base.marginalPrice, halfLife);
  });
  return { ...base, decay, nextAges, exitAges };
}

/* ── 接线建议 ──
 * 1. 建议挂载引擎: src/sentinel.ts 信号分级 → src/optimizer.ts / 决策引擎的
 *    信息流入口——信号洪水下「该看什么」的市场:
 *    a) 信息源注册: 模型遥测 / 日志异常 / 记忆回写 / 共生市场行情各自实现
 *       AttentionSource（marginalValue = EVSI 式期望信息价值, 由各源自报;
 *       凹性由 concavityCheck 每轮巡检, 违规源临时摘牌）;
 *    b) 每 attention 窗口（如一轮决策周期）k 个深看槽位跑 allocateAttention:
 *       赢家进深处理队列, payments 记入「注意力账本」——某源长期高占用
 *       即优化器对其估值函数校准的反馈信号;
 *    c) 与全局工作空间（GWT 内核 96.0, 广播焦点）互补分工: 96 管「此刻谁
 *       进焦点」的单步竞争, 99 管「一段窗口内持续注意力预算」的拍卖分配;
 *       99 的赢家队列可作为 96 的候选输入, 两级串联而非互替;
 *    d) marginalPrice 即注意力的影子价格: 高价窗口 = 信息饥渴（洪水中的
 *       稀缺信号), 可作为元认知层的「认知负荷」指标上报 self-model。
 * 2. 缺省关闭旗标名: SentinelConfig 新增
 *    `attentionEconomy?: { enabled?: boolean; slots?: number }`（缺省 false,
 *    与 mechanismDesign / futarchy 旗标同款——影子计算, 不改变主链路）。
 * 3. 挂载后改变的决策点:
 *    - sentinel 的信号优先级排序 → 拍卖出清（优先级从拍脑袋到机会成本口径）;
 *    - 各下游模块的「抢占式打断」需先出价（谎报在 VCG 下无利可图）;
 *    - 未启用时信息流行为与本内核加入前逐位一致（零漂移）。
 */
